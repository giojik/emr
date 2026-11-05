import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { InjectDb, type Database } from '../database/database.module';
import { NotificationsService } from '../notifications/notifications';
import { modActive } from '../modules/modules-ref';
import { erClinicalSettings, type ErClinicalSettings, type ReminderKind } from './er-access';
import { erFeeSync, erInvoiceClose } from './er-billing';

/**
 * 0091 — ER-ის ჯობები (emr-worker, 5 წთ, gate('er'); ხელით — POST /er/jobs/run, admin).
 *  • PRN-ის ვადა → expired (გლობალურად; ადრე — მხოლოდ წაკითხვისას);
 *  • invoice_close = doc_close — დოკუმენტაციის ფანჯრის ბოლოს ინვოისი იხურება (ტარიფის სინქრონიზაციით);
 *  • შეხსენებები (reminders.<სახე>; ზარი, ჩანაწერი + ეტაპი ერთხელ — er_reminders_sent):
 *      verbal — ვადამდე 30 წთ (soon) / ვადის გასვლა (overdue) → დამნიშნავი; stat — stat_due_min-ის გასვლა → ექთნები (wl_to.er_stat);
 *      consult — consult_due_min-ის გასვლა (ER-ის შემთხვევაზე) → სამიზნე ექიმი / განყოფილების ექიმები;
 *      admit_wait — მოთხოვნა უპასუხოდ > admit_wait_min → განყოფილების ხელმძღვანელი + er_manage (ესკალაცია);
 *      retriage — განმეორებითი ტრიაჟის ვადა (ექიმამდე) → ტრიაჟის ექთნები; doc_close — ფანჯრის დახურვამდე doc_close_warn_h → მკურნალი ექიმი.
 *    remind_repeat_min > 0 — ვადაგადაცილებულზე გამეორება ყოველ N წთ-ში (ეტაპი r1, r2 …); 0 — ერთხელ.
 *    ზარის ჩახშობა — worklist-ის bell_suppress (BELL_SOURCE: er_remind_* → er_*); ვადაგადაცილება — სასწრაფოა (არ იხშობა).
 */
type Rec = { kind: ReminderKind; ref: string; due: Date; users: string[]; title: string; body: string; link: string; entity: string; soonMin?: number };

@Injectable()
export class ErJobsService {
  private readonly log = new Logger('ErJobs');
  constructor(@InjectDb() private readonly db: Database, private readonly bell: NotificationsService) {}

  async tick() {
    if (!(await modActive(this.db, 'er'))) return { enabled: false };
    const s = await erClinicalSettings();
    const prn = await this.expirePrn().catch((e) => { this.log.error(`PRN: ${(e as Error).message}`); return 0; });
    const closed = s.invoice_close === 'doc_close' ? await this.docClose().catch((e) => { this.log.error(`ინვოისი: ${(e as Error).message}`); return 0; }) : 0;
    const reminders = await this.reminders(s).catch((e) => { this.log.error(`შეხსენებები: ${(e as Error).message}`); return {} as Record<string, number>; });
    return { enabled: true, prn_expired: prn, invoices_closed: closed, reminders };
  }

  private async expirePrn() {
    const r = await this.db.updateTable('er_orders').set({ status: 'expired', stopped_at: sql`expires_at` })
      .where('status', '=', 'active').where('order_type', '=', 'prn').where('expires_at', '<', sql<Date>`now()`).returning('id').execute();
    return r.length;
  }

  private async docClose() {
    const rows = await sql<{ encounter_id: string }>`SELECT v.encounter_id FROM er_visits v JOIN invoices i ON i.encounter_id = v.encounter_id
       WHERE v.status = 'departed' AND v.doc_closes_at <= now() AND i.finalized_at IS NULL AND i.merged_into_invoice_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM fin_claim_items ci WHERE ci.invoice_id = i.id) LIMIT 200`.execute(this.db);
    let n = 0;
    for (const r of rows.rows) {
      try {
        await this.db.transaction().execute(async (trx) => { await erFeeSync(trx, r.encounter_id, null); if (await erInvoiceClose(trx, r.encounter_id, null)) n++; });
      } catch (e) { this.log.warn(`ინვოისის დახურვა (${r.encounter_id}): ${(e as Error).message}`); }
    }
    return n;
  }

  /** ER-ის განყოფილების ექთნები (nurse — ამ განყოფილების; er_triage — ამ განყოფილების ან განყოფილების გარეშე) */
  private async nurses(dep: string, withNurse = true) {
    return (await sql<{ id: string }>`SELECT DISTINCT u.id FROM users u JOIN user_capabilities c ON c.user_id = u.id WHERE u.is_active
      AND (('er_triage' = ANY (c.capabilities) AND (u.department_id = ${dep} OR u.department_id IS NULL)) OR (${withNurse} AND 'nurse' = ANY (c.capabilities) AND u.department_id = ${dep}))`
      .execute(this.db)).rows.map((r) => r.id);
  }
  private async deptDoctors(dep: string) {
    return (await sql<{ id: string }>`SELECT DISTINCT u.id FROM users u JOIN user_capabilities c ON c.user_id = u.id WHERE u.is_active AND u.department_id = ${dep}
      AND c.capabilities && ARRAY['doctor', 'er_doctor']::varchar[]`.execute(this.db)).rows.map((r) => r.id);
  }
  private async heads(dep: string) {
    return (await sql<{ id: string }>`SELECT DISTINCT u.id FROM users u LEFT JOIN user_capabilities c ON c.user_id = u.id WHERE u.is_active
      AND ((u.department_id = ${dep} AND (u.is_section_head OR 'manager' = ANY (coalesce(c.capabilities, '{}')))) OR 'er_manage' = ANY (coalesce(c.capabilities, '{}')))`
      .execute(this.db)).rows.map((r) => r.id);
  }

  private async collect(s: ErClinicalSettings): Promise<Rec[]> {
    const out: Rec[] = [];
    const on = (k: ReminderKind) => s.reminders[k] !== false;
    const P = sql<string>`p.last_name || ' ' || p.first_name`;
    if (on('verbal')) {
      const r = await sql<{ id: string; eid: string; no: string; pn: string; due: Date; by: string; label: string }>`SELECT o.id, v.encounter_id AS eid, v.visit_no AS no, ${P} AS pn,
          o.verbal_due_at AS due, o.ordered_by AS by, coalesce(o.drug_text, o.text, g.inn, 'დანიშნულება') AS label
        FROM er_orders o JOIN er_visits v ON v.encounter_id = o.encounter_id JOIN patients p ON p.id = v.patient_id LEFT JOIN med_generics g ON g.id = o.generic_id
       WHERE o.is_verbal AND o.verbal_confirmed_at IS NULL AND o.status = 'active' AND v.ended_at IS NULL AND o.verbal_due_at IS NOT NULL
         AND o.verbal_due_at <= now() + interval '30 minutes'`.execute(this.db);
      for (const x of r.rows) out.push({ kind: 'verbal', ref: x.id, due: x.due, users: [x.by], title: `ზეპირი დანიშნულება — დაადასტურეთ (${x.no})`, body: `${x.pn}: ${x.label}`,
        link: `/er?visit=${x.eid}&tab=orders`, entity: x.id, soonMin: 30 });
    }
    if (on('stat')) {
      const r = await sql<{ id: string; eid: string; no: string; pn: string; created: Date; dep: string; doc: string | null; label: string }>`SELECT o.id, v.encounter_id AS eid, v.visit_no AS no,
          ${P} AS pn, o.created_at AS created, v.department_id AS dep, v.doctor_id AS doc, coalesce(o.drug_text, o.text, g.inn, 'დანიშნულება') AS label
        FROM er_orders o JOIN er_visits v ON v.encounter_id = o.encounter_id JOIN patients p ON p.id = v.patient_id LEFT JOIN med_generics g ON g.id = o.generic_id
       WHERE o.status = 'active' AND o.order_type = 'stat' AND v.ended_at IS NULL AND o.created_at + make_interval(mins => ${s.stat_due_min}) <= now()
         AND NOT EXISTS (SELECT 1 FROM er_administrations a WHERE a.order_id = o.id AND a.voided_at IS NULL)`.execute(this.db);
      for (const x of r.rows) {
        const users = await this.nurses(x.dep);
        if (s.wl_to.er_stat === 'nurses_doctor' && x.doc) users.push(x.doc);
        out.push({ kind: 'stat', ref: x.id, due: new Date(new Date(x.created).getTime() + s.stat_due_min * 60_000), users, title: `STAT ვადაგადაცილებულია (${x.no})`,
          body: `${x.pn}: ${x.label}`, link: `/er?visit=${x.eid}&tab=orders`, entity: x.id });
      }
    }
    if (on('consult')) {
      const r = await sql<{ id: string; eid: string; no: string; pn: string; due: Date; doc: string | null; dep: string | null; q: string }>`SELECT k.id, v.encounter_id AS eid, v.visit_no AS no,
          ${P} AS pn, k.due_at AS due, k.target_doctor_id AS doc, k.target_department_id AS dep, k.question AS q
        FROM consultations k JOIN er_visits v ON v.encounter_id = k.encounter_id JOIN patients p ON p.id = v.patient_id
       WHERE k.status = 'requested' AND v.ended_at IS NULL AND k.due_at <= now()`.execute(this.db);
      for (const x of r.rows) {
        const users = x.doc ? [x.doc] : x.dep ? await this.deptDoctors(x.dep) : [];
        out.push({ kind: 'consult', ref: x.id, due: x.due, users, title: `კონსულტაცია ER-ში — ვადა გავიდა (${x.no})`, body: `${x.pn}: ${x.q.slice(0, 140)}`, link: '/consults', entity: x.id });
      }
    }
    if (on('admit_wait')) {
      const r = await sql<{ id: string; eid: string; no: string; pn: string; at: Date; dep: string; dn: string }>`SELECT q.id, v.encounter_id AS eid, v.visit_no AS no, ${P} AS pn,
          q.requested_at AS at, q.department_id AS dep, d.name AS dn
        FROM er_admit_requests q JOIN er_visits v ON v.encounter_id = q.encounter_id JOIN patients p ON p.id = v.patient_id JOIN departments d ON d.id = q.department_id
       WHERE q.status = 'requested' AND q.requested_at + make_interval(mins => ${s.admit_wait_min}) <= now()`.execute(this.db);
      for (const x of r.rows) out.push({ kind: 'admit_wait', ref: x.id, due: new Date(new Date(x.at).getTime() + s.admit_wait_min * 60_000), users: await this.heads(x.dep),
        title: `ER → ${x.dn}: მოთხოვნა უპასუხოა > ${s.admit_wait_min} წთ (${x.no})`, body: x.pn, link: `/inpatient?tab=er&department_id=${x.dep}`, entity: x.id });
    }
    if (on('retriage') && (s as { retriage_alert?: boolean }).retriage_alert !== false) {
      const r = await sql<{ eid: string; no: string; pn: string; due: Date; dep: string; lvl: string }>`SELECT v.encounter_id AS eid, v.visit_no AS no, ${P} AS pn,
          v.last_triage_at + make_interval(mins => l.retriage_min) AS due, v.department_id AS dep, l.name AS lvl
        FROM er_visits v JOIN patients p ON p.id = v.patient_id JOIN er_triage_levels l ON l.scale_code = v.triage_scale AND l.level = v.triage_level
       WHERE v.ended_at IS NULL AND v.doctor_at IS NULL AND l.retriage_min IS NOT NULL AND v.last_triage_at + make_interval(mins => l.retriage_min) <= now()`.execute(this.db);
      for (const x of r.rows) out.push({ kind: 'retriage', ref: x.eid, due: x.due, users: await this.nurses(x.dep, s.wl_to.er_retriage === 'triage_nurses'),
        title: `განმეორებითი ტრიაჟი (${x.no})`, body: `${x.pn} · ${x.lvl}`, link: `/er?visit=${x.eid}`, entity: x.eid });
    }
    if (on('doc_close') && s.doc_close_warn_h > 0) {
      const r = await sql<{ eid: string; no: string; pn: string; due: Date; doc: string | null }>`SELECT v.encounter_id AS eid, v.visit_no AS no, ${P} AS pn, v.doc_closes_at AS due, v.doctor_id AS doc
        FROM er_visits v JOIN patients p ON p.id = v.patient_id
       WHERE v.status = 'departed' AND v.disposition <> 'lwbs' AND v.doc_closes_at > now() AND v.doc_closes_at <= now() + make_interval(hours => ${s.doc_close_warn_h})
         AND (NOT EXISTS (SELECT 1 FROM doctor_notes n WHERE n.encounter_id = v.encounter_id AND n.kind = 'er_initial' AND n.status = 'signed' AND n.superseded_at IS NULL)
           OR NOT EXISTS (SELECT 1 FROM encounter_diagnoses x WHERE x.encounter_id = v.encounter_id AND x.diagnosis_type = 'primary')
           OR EXISTS (SELECT 1 FROM doctor_notes n WHERE n.encounter_id = v.encounter_id AND n.status = 'draft' AND n.kind LIKE 'er_%'))`.execute(this.db);
      for (const x of r.rows) if (x.doc) out.push({ kind: 'doc_close', ref: x.eid, due: x.due, users: [x.doc], title: `ER-ის დოკუმენტაციის ფანჯარა იხურება (${x.no})`,
        body: `${x.pn}: ხელმოუწერელი ჩანაწერი / ICD-10`, link: `/er?visit=${x.eid}&tab=notes`, entity: x.eid, soonMin: s.doc_close_warn_h * 60 });
    }
    return out;
  }

  private async reminders(s: ErClinicalSettings) {
    const now = Date.now();
    const counts: Record<string, number> = {};
    for (const r of await this.collect(s)) {
      const late = now - new Date(r.due).getTime();
      const stage = late < 0 ? 'soon' : s.remind_repeat_min > 0 && late >= s.remind_repeat_min * 60_000 ? `r${Math.floor(late / (s.remind_repeat_min * 60_000))}` : 'overdue';
      if (r.kind === 'doc_close' && stage !== 'soon') continue;   // ფანჯარა დაიხურა — შეხსენება აღარ
      const users = [...new Set(r.users.filter(Boolean))];
      const ins = await this.db.insertInto('er_reminders_sent').values({ kind: r.kind, ref_id: r.ref, stage, recipients: users.length })
        .onConflict((oc) => oc.columns(['kind', 'ref_id', 'stage']).doNothing()).returning('id').executeTakeFirst();
      if (!ins) continue;
      const kind = r.kind === 'admit_wait' ? 'er_remind_admit' : r.kind === 'doc_close' ? 'er_remind_doc' : `er_remind_${r.kind}`;
      for (const id of users) await this.bell.notify(id, { kind, title: r.title, body: r.body, link: r.link, entityId: r.entity, urgent: stage !== 'soon' }).catch(() => undefined);
      counts[r.kind] = (counts[r.kind] ?? 0) + 1;
    }
    await sql`DELETE FROM er_reminders_sent WHERE sent_at < now() - interval '30 days'`.execute(this.db);
    return counts;
  }
}
