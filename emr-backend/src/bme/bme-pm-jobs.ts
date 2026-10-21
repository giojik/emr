import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { InjectDb, type Database } from '../database/database.module';
import { NotificationsService } from '../notifications/notifications';
import { NotifyService } from '../notify/notify.service';
import { STATUS_KA } from './bme-common';
import { AUTO_REASON, TZ, pmSettings, today } from './bme-pm-common';

interface Due { plan_id: string; due_txt: string; days_left: number; device_id: string; inv_no: string; device_name: string; department_id: string | null; kind_short: string; assignee_id: string | null }

/**
 * worker (ყოველ 30 წთ; დღეში ერთხელ — კლინიკის დროით pm_remind_hour-ის შემდეგ), 0074:
 *  • შეხსენებები: ვადამდე pm_remind_days (მაგ. 30 / 7) და ვადაგადაცილება — თითო გეგმა / ვადა / ეტაპი ერთხელ (bme_reminders);
 *      მიმღები: სამედიცინო ინჟინრები (ყველა), ღია სამუშაოს შემსრულებელი, განყოფილების bme_dept; ეკრანი (დღიური შეჯამება) + ელფოსტა / SMS (პარამეტრი).
 *  • ვადაგადაცილება (pm_overdue_action = restrict): „მუშა“ აპარატი → „შეზღუდულად მუშა“ (სისტემა, მიზეზით); სამუშაოს შესრულებისას — აღდგება.
 */
@Injectable()
export class BmePmJobsService {
  private readonly log = new Logger('BmePm');
  constructor(@InjectDb() private readonly db: Database, private readonly notifications: NotificationsService, private readonly notify: NotifyService) {}

  /** force — საათის შემოწმების გარეშე (ხელით გაშვება); deviceIds — მხოლოდ ეს აპარატები (ტესტი: სხვა აპარატების შეხსენებებს არ „ხარჯავს“) */
  async tick(force = false, deviceIds?: string[]) {
    const only = deviceIds?.length ? sql`AND b.id = ANY (${sql.val(deviceIds)}::uuid[])` : sql``;
    const s = await pmSettings(this.db);
    if (!s) return { reminders: 0, notified: 0, restricted: 0 };
    const h = (await sql<{ h: number }>`SELECT extract(hour FROM now() AT TIME ZONE ${TZ})::int AS h`.execute(this.db)).rows[0].h;
    if (!force && h < (s.pm_remind_hour ?? 9)) return { reminders: 0, notified: 0, restricted: 0 };
    const stages = [...new Set((s.pm_remind_days ?? [30, 7]).filter((x) => Number.isInteger(x) && x > 0))].sort((a, b) => b - a);

    // ეტაპი: ვადაგადაცილება → 0; ვადამდე ≤ d დღე → უმცირესი d, რომელიც ≥ დარჩენილს (30 → 7 → …)
    const stageSql = stages.length
      ? sql<number>`CASE WHEN p.next_due < ${today()} THEN 0 ELSE (SELECT min(x) FROM unnest(${sql.val(stages)}::int[]) x WHERE (p.next_due - ${today()}) <= x) END`
      : sql<number>`CASE WHEN p.next_due < ${today()} THEN 0 END`;
    const fresh = await sql<Due & { stage: number }>`
      WITH c AS (
        SELECT p.id AS plan_id, p.next_due AS due_date, to_char(p.next_due, 'YYYY-MM-DD') AS due_txt, (p.next_due - ${today()})::int AS days_left, ${stageSql} AS stage,
               b.id AS device_id, b.inv_no, b.name AS device_name, b.department_id, k.short_name AS kind_short, w.assignee_id
          FROM bme_plans p JOIN bme_devices b ON b.id = p.device_id JOIN bme_work_kinds k ON k.id = p.kind_id
          LEFT JOIN bme_works w ON w.plan_id = p.id AND w.status IN ('planned', 'in_progress')
         WHERE p.is_active AND b.status <> 'retired' AND p.next_due IS NOT NULL ${only}
      ), ins AS (
        INSERT INTO bme_reminders (plan_id, due_date, stage)
        SELECT plan_id, due_date, stage FROM c WHERE stage IS NOT NULL
        ON CONFLICT DO NOTHING RETURNING plan_id, due_date, stage
      )
      SELECT c.* FROM c JOIN ins ON ins.plan_id = c.plan_id AND ins.due_date = c.due_date AND ins.stage = c.stage
       ORDER BY c.days_left`.execute(this.db);
    const rows = fresh.rows;

    let notified = 0;
    if (rows.length) {
      const engineers = (await sql<{ id: string }>`SELECT u.id FROM users u JOIN user_capabilities c ON c.user_id = u.id WHERE u.is_active AND c.capabilities && ARRAY['med_engineer']::varchar[]`.execute(this.db)).rows.map((r) => r.id);
      const deps = [...new Set(rows.map((r) => r.department_id).filter((x): x is string => !!x))];
      const deptUsers = deps.length ? (await sql<{ id: string; dep: string }>`
        SELECT DISTINCT u.id, d.dep FROM users u JOIN user_capabilities c ON c.user_id = u.id
          JOIN LATERAL (SELECT u.department_id AS dep UNION SELECT s.department_id FROM rpt_user_scopes s WHERE s.user_id = u.id) d ON d.dep = ANY (${sql.val(deps)}::uuid[])
         WHERE u.is_active AND c.capabilities && ARRAY['bme_dept']::varchar[]`.execute(this.db)).rows : [];
      const per = new Map<string, (Due & { stage: number })[]>();
      const add = (uid: string, r: Due & { stage: number }) => { const a = per.get(uid) ?? []; if (!a.includes(r)) a.push(r); per.set(uid, a); };
      for (const r of rows) {
        for (const e of engineers) add(e, r);
        if (r.assignee_id) add(r.assignee_id, r);
        for (const du of deptUsers) if (du.dep === r.department_id) add(du.id, r);
      }
      const contacts = per.size ? await this.db.selectFrom('users').select(['id', 'email', 'phone']).where('id', 'in', [...per.keys()]).execute() : [];
      const line = (r: Due & { stage: number }) => `${r.inv_no} ${r.device_name} — ${r.kind_short}: ${r.days_left < 0 ? `ვადაგადაცილებული ${-r.days_left} დღით` : `ვადა ${r.days_left} დღეში`} (${r.due_txt})`;
      for (const [uid, list] of per) {
        const over = list.filter((r) => r.stage === 0).length; const soon = list.length - over;
        const title = `გეგმიური სამუშაოები: ${[over ? `ვადაგადაცილებული ${over}` : '', soon ? `ვადა უახლოვდება ${soon}` : ''].filter(Boolean).join(', ')}`;
        await this.notifications.notify(uid, { kind: 'bme_pm_due', title, body: list.slice(0, 5).map(line).join('\n') + (list.length > 5 ? `\n… და კიდევ ${list.length - 5}` : ''),
          link: `/bme?tab=works&view=${over ? 'overdue' : 'month'}`, entityId: uid, item: list.map((r) => r.inv_no).join(', '), urgent: over > 0 });
        notified++;
        const c = contacts.find((x) => x.id === uid);
        if (s.pm_remind_email && c?.email) {
          const r = await this.notify.email([c.email], `EMR · ${title}`, `${title}\n\n${list.map(line).join('\n')}\n\nბიომედ-აპარატურა → სამუშაოები`);
          if (r.errors.length) this.log.warn(r.errors.join('; '));
        }
        if (s.pm_remind_sms && c?.phone) {
          const r = await this.notify.sms([c.phone], `EMR ბიომედ: ${[over ? `ვადაგადაცილებული ${over}` : '', soon ? `ახლოვდება ${soon}` : ''].filter(Boolean).join(', ')} გეგმიური სამუშაო`);
          if (r.errors.length) this.log.warn(r.errors.join('; '));
        }
      }
    }

    // ვადაგადაცილება → „შეზღუდულად მუშა“ (პარამეტრი)
    let restricted = 0;
    if (s.pm_overdue_action === 'restrict') {
      const devs = await sql<{ id: string; inv_no: string; name: string; department_id: string | null; responsible_user_id: string | null; kinds: string }>`
        SELECT b.id, b.inv_no, b.name, b.department_id, b.responsible_user_id, string_agg(DISTINCT k.short_name, ', ') AS kinds
          FROM bme_devices b JOIN bme_plans p ON p.device_id = b.id AND p.is_active AND p.next_due < ${today()} JOIN bme_work_kinds k ON k.id = p.kind_id
         WHERE b.status = 'operational' ${only} GROUP BY b.id`.execute(this.db);
      for (const d of devs.rows) {
        const reason = `${AUTO_REASON}: ${d.kinds}`;
        const ok = await this.db.transaction().execute(async (trx) => {
          const cur = await trx.selectFrom('bme_devices').select('status').where('id', '=', d.id).forUpdate().executeTakeFirst();
          if (cur?.status !== 'operational') return false;
          await trx.updateTable('bme_status_periods').set({ ended_at: sql`now()` }).where('device_id', '=', d.id).where('ended_at', 'is', null).execute();
          await trx.insertInto('bme_status_periods').values({ device_id: d.id, status: 'restricted', reason }).execute();
          await trx.updateTable('bme_devices').set({ status: 'restricted', status_reason: reason, status_since: sql`now()`, updated_at: sql`now()` }).where('id', '=', d.id).execute();
          await trx.insertInto('bme_events').values({ device_id: d.id, kind: 'status', data: JSON.stringify({ from: 'operational', to: 'restricted', reason, auto_pm: true }), user_id: null }).execute();
          return true;
        });
        if (!ok) continue;
        restricted++;
        const ids = new Set<string>([...(d.responsible_user_id ? [d.responsible_user_id] : [])]);
        if (d.department_id) for (const r of (await sql<{ id: string }>`SELECT u.id FROM users u JOIN user_capabilities c ON c.user_id = u.id WHERE u.is_active AND c.capabilities && ARRAY['bme_dept']::varchar[]
          AND (u.department_id = ${d.department_id} OR EXISTS (SELECT 1 FROM rpt_user_scopes s WHERE s.user_id = u.id AND s.department_id = ${d.department_id}))`.execute(this.db)).rows) ids.add(r.id);
        for (const r of (await sql<{ id: string }>`SELECT u.id FROM users u JOIN user_capabilities c ON c.user_id = u.id WHERE u.is_active AND c.capabilities && ARRAY['med_engineer']::varchar[]`.execute(this.db)).rows) ids.add(r.id);
        for (const id of ids) await this.notifications.notify(id, { kind: 'bme_status', title: `${d.inv_no} ${d.name}: ${STATUS_KA.restricted}`, body: reason, link: `/bme?device=${d.id}`, entityId: d.id, urgent: true });
      }
    }
    return { reminders: rows.length, notified, restricted };
  }
}
