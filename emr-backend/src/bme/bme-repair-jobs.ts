import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { InjectDb, type Database } from '../database/database.module';
import { NotificationsService } from '../notifications/notifications';
import { TZ, pmSettings } from './bme-pm-common';
import { CONTRACT_KA, devEvent, repEvent, usersWithCaps, type ContractKind } from './bme-repair-common';

interface Scope { at?: string; repair_ids?: string[]; contract_ids?: string[]; device_ids?: string[] }

/**
 * worker (ყოველ 15 წთ), 0075:
 *  • SLA: რეაგირება / აღდგენა — 80% (პარამეტრი) → გაფრთხილება (შემსრულებელი + ინჟინრები), ვადა გავიდა → დარღვევა (სასწრაფო, ერთხელ);
 *  • ავტომატური დახურვა: შესრულებული ორდერი, განყოფილებამ rep_close_auto_days დღეში არ დაადასტურა (შემოწმება / hold — არა);
 *  • ვადის შეხსენებები: კონტრაქტი (ct_remind_days, მაგ. 90 / 30 + ვადა გავიდა) → ინჟინრები + შესყიდვები; ქარხნული გარანტია (wr_remind_days) → ინჟინრები.
 * scope (ხელით გაშვება, admin / e2e): at — „ახლა“-ს ჩანაცვლება, ids — მხოლოდ ეს ჩანაწერები (სხვას არ ეხება).
 */
@Injectable()
export class BmeRepairJobsService {
  private readonly log = new Logger('BmeRepair');
  constructor(@InjectDb() private readonly db: Database, private readonly notifications: NotificationsService) {}

  async tick(scope: Scope = {}) {
    const out = { sla_warn: 0, sla_breach: 0, auto_closed: 0, contract_reminders: 0, warranty_reminders: 0 };
    const s = await pmSettings(this.db);
    if (!s) return out;
    const now = scope.at ? sql<Date>`${scope.at}::timestamptz` : sql<Date>`now()`;
    const day = scope.at ? sql<string>`(${scope.at}::timestamptz AT TIME ZONE ${TZ})::date` : sql<string>`(now() AT TIME ZONE ${TZ})::date`;
    const rIds = scope.repair_ids?.length ? sql`AND r.id = ANY (${sql.val(scope.repair_ids)}::uuid[])` : sql``;
    const engineers = await usersWithCaps(this.db, ['med_engineer']);
    // ხელით გაშვება ids-ით: მხოლოდ მითითებული კატეგორიები (სხვა ჩანაწერებს არ ეხება)
    const scoped = !!(scope.repair_ids?.length || scope.contract_ids?.length || scope.device_ids?.length);
    const doRep = !scoped || !!scope.repair_ids?.length; const doCt = !scoped || !!scope.contract_ids?.length; const doWr = !scoped || !!scope.device_ids?.length;
    const pct = s.rep_sla_warn_pct ?? 80;

    // ---- SLA: გაფრთხილება / დარღვევა (ღია ორდერები; რეაგირება — სანამ არ მომხდარა, აღდგენა — სანამ არ შესრულდა)
    const rows = !doRep ? { rows: [] as never[] } : await sql<{ id: string; repair_no: string; inv_no: string; name: string; priority: number; assignee_id: string | null; warned: boolean; breached: boolean; what: string }>`
      SELECT r.id, r.repair_no, b.inv_no, b.name, coalesce(r.priority, r.suggested_priority) AS priority, r.assignee_id,
             r.sla_warned_at IS NOT NULL AS warned, r.sla_breach_notified_at IS NOT NULL AS breached,
             CASE WHEN resp_open AND ${now} > r.sla_response_due THEN 'response_breach'
                  WHEN rest_open AND ${now} > r.sla_restore_due THEN 'restore_breach'
                  WHEN resp_open AND ${now} > r.sla_response_due - make_interval(secs => r.sla_response_hours * 3600 * (100 - ${pct}) / 100.0) THEN 'response_warn'
                  WHEN rest_open AND ${now} > r.sla_restore_due - make_interval(secs => r.sla_restore_hours * 3600 * (100 - ${pct}) / 100.0) THEN 'restore_warn' END AS what
        FROM bme_repairs r JOIN bme_devices b ON b.id = r.device_id,
             LATERAL (SELECT r.sla_response_due IS NOT NULL AND (CASE WHEN r.performer_kind = 'external' THEN r.vendor_arrived_at ELSE r.started_at END) IS NULL AS resp_open,
                             r.sla_restore_due IS NOT NULL AND r.done_at IS NULL AS rest_open) x
       WHERE r.status IN ('triaged', 'in_progress', 'waiting_parts', 'waiting_vendor') ${rIds}`.execute(this.db);
    for (const r of rows.rows) {
      if (!r.what) continue;
      const breach = r.what.endsWith('breach');
      if (breach ? r.breached : (r.warned || r.breached)) continue;
      const res = await this.db.updateTable('bme_repairs').set(breach ? { sla_breach_notified_at: now, sla_warned_at: sql`coalesce(sla_warned_at, ${now})` } : { sla_warned_at: now })
        .where('id', '=', r.id).where(breach ? 'sla_breach_notified_at' : 'sla_warned_at', 'is', null).executeTakeFirst();
      if (!Number(res.numUpdatedRows)) continue;
      const what = r.what.startsWith('response') ? 'რეაგირება' : 'აღდგენა';
      await repEvent(this.db, r.id, breach ? 'sla_breach' : 'sla_warn', { what: r.what }, null);
      const title = `${breach ? 'SLA დარღვეულია' : 'SLA — ვადა ახლოვდება'}: ${r.repair_no} · ${r.inv_no} ${r.name} (P${r.priority}, ${what})`;
      const ids = new Set([...engineers, ...(r.assignee_id ? [r.assignee_id] : [])]);
      for (const id of ids) await this.notifications.notify(id, { kind: breach ? 'bme_sla_breach' : 'bme_sla_warn', title, link: `/bme?tab=repairs&repair=${r.id}`, entityId: r.id, urgent: breach });
      if (breach) out.sla_breach++; else out.sla_warn++;
    }

    // ---- ავტომატური დახურვა (confirm რეჟიმი)
    if (doRep && s.rep_close_mode === 'confirm' && (s.rep_close_auto_days ?? 0) > 0) {
      const due = await sql<{ id: string; repair_no: string; device_id: string }>`
        SELECT r.id, r.repair_no, r.device_id FROM bme_repairs r LEFT JOIN bme_works w ON w.id = r.post_check_work_id
         WHERE r.status = 'done' AND NOT r.hold AND r.done_at < ${now} - make_interval(days => ${s.rep_close_auto_days})
           AND (NOT r.post_check_required OR (w.status = 'done' AND w.result IN ('pass', 'conditional'))) ${rIds}`.execute(this.db);
      for (const r of due.rows) {
        const ok = await this.db.transaction().execute(async (trx) => {
          const u = await trx.updateTable('bme_repairs').set({ status: 'closed', closed_at: now, close_kind: 'auto', close_note: `ავტომატურად — ${s.rep_close_auto_days} დღე დადასტურების გარეშე`, updated_at: sql`now()` })
            .where('id', '=', r.id).where('status', '=', 'done').executeTakeFirst();
          if (!Number(u.numUpdatedRows)) return false;
          await repEvent(trx, r.id, 'closed', { kind: 'auto', days: s.rep_close_auto_days }, null);
          await devEvent(trx, r.device_id, 'repair_closed', { repair_id: r.id, repair_no: r.repair_no, kind: 'auto' }, null);
          return true;
        });
        if (ok) out.auto_closed++;
      }
    }

    // ---- ვადის შეხსენებები: კონტრაქტი / ქარხნული გარანტია (ეტაპი: უმცირესი დღე ≥ დარჩენილს; ვადა გავიდა — 0)
    const stage = (days: number[]) => {
      const st = [...new Set((days ?? []).filter((x) => Number.isInteger(x) && x > 0))].sort((a, b) => b - a);
      return st.length ? sql<number>`CASE WHEN x.end_date < ${day} THEN 0 ELSE (SELECT min(v) FROM unnest(${sql.val(st)}::int[]) v WHERE (x.end_date - ${day}) <= v) END` : sql<number>`CASE WHEN x.end_date < ${day} THEN 0 END`;
    };
    const cIds = scope.contract_ids?.length ? sql`AND c.id = ANY (${sql.val(scope.contract_ids)}::uuid[])` : sql``;
    const ct = !doCt ? { rows: [] as never[] } : await sql<{ id: string; contract_no: string; title: string; kind: string; supplier: string; end_txt: string; days: number; stage: number }>`
      WITH x AS (
        SELECT c.id, c.contract_no, c.title, c.kind, s.name AS supplier, c.end_date, to_char(c.end_date, 'YYYY-MM-DD') AS end_txt, (c.end_date - ${day})::int AS days
          FROM bme_contracts c JOIN stock_suppliers s ON s.id = c.supplier_id
         WHERE c.status = 'active' AND c.end_date >= ${day} - 1 ${cIds}
      ), y AS (SELECT x.*, ${stage(s.ct_remind_days ?? [90, 30])} AS stage FROM x),
      ins AS (INSERT INTO bme_expiry_reminders (ref_kind, ref_id, end_date, stage) SELECT 'contract', id, end_date, stage FROM y WHERE stage IS NOT NULL
              ON CONFLICT DO NOTHING RETURNING ref_id, stage)
      SELECT y.id, y.contract_no, y.title, y.kind, y.supplier, y.end_txt, y.days, y.stage FROM y JOIN ins ON ins.ref_id = y.id AND ins.stage = y.stage`.execute(this.db);
    if (ct.rows.length) {
      const ids = new Set([...engineers, ...(await usersWithCaps(this.db, ['procurement']))]);
      for (const c of ct.rows) {
        const title = `კონტრაქტი ${c.contract_no} (${c.supplier}): ${c.days < 0 ? 'ვადა გავიდა' : `ვადა ${c.days} დღეში`} — ${c.end_txt}`;
        for (const id of ids) await this.notifications.notify(id, { kind: 'bme_contract_due', title, body: `${c.title} · ${CONTRACT_KA[c.kind as ContractKind] ?? c.kind}`, link: `/bme?tab=contracts&contract=${c.id}`, entityId: c.id, urgent: c.days <= 0 });
      }
      out.contract_reminders = ct.rows.length;
    }
    const dIds = scope.device_ids?.length ? sql`AND b.id = ANY (${sql.val(scope.device_ids)}::uuid[])` : sql``;
    const wr = !doWr ? { rows: [] as never[] } : await sql<{ id: string; inv_no: string; name: string; end_txt: string; days: number }>`
      WITH x AS (
        SELECT b.id, b.inv_no, b.name, b.warranty_until AS end_date, to_char(b.warranty_until, 'YYYY-MM-DD') AS end_txt, (b.warranty_until - ${day})::int AS days
          FROM bme_devices b WHERE b.status <> 'retired' AND b.warranty_until IS NOT NULL AND b.warranty_until >= ${day} - 1 ${dIds}
      ), y AS (SELECT x.*, ${stage(s.wr_remind_days ?? [60, 30])} AS stage FROM x),
      ins AS (INSERT INTO bme_expiry_reminders (ref_kind, ref_id, end_date, stage) SELECT 'warranty', id, end_date, stage FROM y WHERE stage IS NOT NULL
              ON CONFLICT DO NOTHING RETURNING ref_id, stage)
      SELECT y.id, y.inv_no, y.name, y.end_txt, y.days FROM y JOIN ins ON ins.ref_id = y.id AND ins.stage = y.stage ORDER BY y.days`.execute(this.db);
    if (wr.rows.length) {
      const list = wr.rows;
      const title = `ქარხნული გარანტია: ${list.length === 1 ? `${list[0].inv_no} ${list[0].name} — ${list[0].days < 0 ? 'ვადა გავიდა' : `${list[0].days} დღეში`}` : `${list.length} აპარატს ვადა უახლოვდება`}`;
      const body = list.slice(0, 8).map((d) => `${d.inv_no} ${d.name} — ${d.end_txt}`).join('\n') + (list.length > 8 ? `\n… და კიდევ ${list.length - 8}` : '');
      for (const id of engineers) await this.notifications.notify(id, { kind: 'bme_warranty_due', title, body, link: '/bme?tab=registry', entityId: id, item: list.map((d) => d.inv_no).join(', ') });
      out.warranty_reminders = list.length;
    }
    if (out.sla_breach || out.auto_closed) this.log.log(`ბიომედ შეკეთება: SLA დარღვევა ${out.sla_breach}, ავტ. დახურვა ${out.auto_closed}`);
    return out;
  }
}
