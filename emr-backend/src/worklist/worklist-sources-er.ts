import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { has, type AuthUser } from '../auth/roles';
import { InjectDb, type Database } from '../database/database.module';
import { erClinicalSettings, type ErClinicalSettings } from '../er/er-access';
import type { AdminCtx, Row, SourceGroup } from './worklist-sources-admin';

/**
 * 0091 — ER-ის სისტემური წყაროები (მოდული er; worklist → er რბილი კავშირი: er გამორთულზე წყაროები ქრება).
 * მიმღებები — ER-ის პარამეტრი wl_to (თითო წყაროზე არჩევადი):
 *  • er_verbal — დაუდასტურებელი ზეპირი: ordering — დამნიშნავი ექიმი; ordering_team — + ნებისმიერი ER-ის ექიმი (doctor_write = team);
 *  • er_stat — შეუსრულებელი STAT (ვადა stat_due_min): nurses — ER-ის განყოფილების ექთნები / er_triage; nurses_doctor — + მკურნალი ექიმი;
 *  • er_admit_req — ღია ჰოსპიტალიზაციის მოთხოვნა (ვადა admit_wait_min): doctors — განყოფილების ექიმები + სასურველი მკურნალი; head — ხელმძღვანელი + სასურველი მკურნალი;
 *  • er_retriage — განმეორებითი ტრიაჟის ვადა (ექიმამდე, retriage_min; 15 წთ-ით ადრე ჩნდება): triage — er_triage; triage_nurses — + ER-ის განყოფილების ექთნები;
 *  • er_doc_open — გასული შემთხვევა, ღია ფანჯარა: ხელმოუწერელი ჩანაწერი / ICD-10 აკლია (ვადა doc_closes_at): attending — მკურნალი; attending_author — + მონახაზის ავტორი;
 *  • er_unpaid — გასული ER, გადაუხდელი ნაშთით (debt_days-ის ფარგლებში; გაერთიანებული — არა): billing / billing_reception.
 */
const LIMIT = 200;
const NIL = '00000000-0000-0000-0000-000000000000';
const name = sql<string>`p.last_name || ' ' || p.first_name`;
const tab = (id: string, t: string) => `/er?visit=${id}&tab=${t}`;

@Injectable()
export class WorklistErSources {
  constructor(@InjectDb() private readonly db: Database) {}

  groups(): SourceGroup[] {
    return [{ module: 'er', codes: ['er_verbal', 'er_stat', 'er_admit_req', 'er_retriage', 'er_doc_open', 'er_unpaid'], fetch: (u, c, x) => this.fetch(u, c, x) }];
  }

  private async fetch(u: AuthUser, c: Set<string>, x: AdminCtx): Promise<Row[]> {
    const s = await erClinicalSettings();
    const me = await x.me();
    const out: Row[] = [];
    const isNurse = has(u, 'er_triage', 'nurse');
    /** ER-ის განყოფილებები, რომლის ექთანიც ვარ (er_triage განყოფილების გარეშე — ყველა) */
    const nurseDept = sql<boolean>`(${has(u, 'er_triage')} AND (${me.department_id ?? NIL}::uuid = v.department_id OR ${!me.department_id}))
      OR (${has(u, 'nurse')} AND ${me.department_id ?? NIL}::uuid = v.department_id)`;
    if (c.has('er_verbal') && has(u, 'er_doctor')) await this.verbal(u, s, out);
    if (c.has('er_stat') && (isNurse || has(u, 'er_doctor'))) await this.stat(u, s, nurseDept, out);
    if (c.has('er_admit_req') && has(u, 'doctor', 'manager')) await this.admit(u, s, me, x, out);
    const retriageWho = has(u, 'er_triage') || (s.wl_to.er_retriage === 'triage_nurses' && has(u, 'nurse'));
    if (c.has('er_retriage') && retriageWho && (s as { retriage_alert?: boolean }).retriage_alert !== false) await this.retriage(u, s, nurseDept, out);
    if (c.has('er_doc_open') && has(u, 'er_doctor')) await this.docOpen(u, s, out);
    if (c.has('er_unpaid') && (has(u, 'billing') || (s.wl_to.er_unpaid === 'billing_reception' && has(u, 'receptionist')))) await this.unpaid(x, out);
    return out;
  }

  private async verbal(u: AuthUser, s: ErClinicalSettings, out: Row[]) {
    const team = s.wl_to.er_verbal === 'ordering_team' && s.doctor_write === 'team';
    const r = await sql<{ id: string; encounter_id: string; visit_no: string; pname: string; dep: string; label: string; due: Date | null; created_at: Date; by: string }>`
      SELECT o.id, v.encounter_id, v.visit_no, ${name} AS pname, d.name AS dep, coalesce(o.drug_text, o.text, g.inn, 'დანიშნულება') AS label, o.verbal_due_at AS due, o.created_at,
             eu.last_name || ' ' || eu.first_name AS by
        FROM er_orders o JOIN er_visits v ON v.encounter_id = o.encounter_id JOIN patients p ON p.id = v.patient_id JOIN departments d ON d.id = v.department_id
        LEFT JOIN med_generics g ON g.id = o.generic_id JOIN users eu ON eu.id = o.entered_by
       WHERE o.is_verbal AND o.verbal_confirmed_at IS NULL AND o.status = 'active' AND v.ended_at IS NULL
         AND (o.ordered_by = ${u.id} OR ${team})
       ORDER BY o.verbal_due_at NULLS LAST LIMIT ${LIMIT}`.execute(this.db);
    for (const k of r.rows) out.push({ id: k.id, source: 'er_verbal', title: `ზეპირი დანიშნულება — დადასტურება (${k.visit_no})`, detail: `${k.label} · შეიყვანა ${k.by}`,
      patient: k.pname, department: k.dep, due_at: k.due, priority: 'urgent', link: tab(k.encounter_id, 'orders'), created_at: k.created_at });
  }

  private async stat(u: AuthUser, s: ErClinicalSettings, nurseDept: ReturnType<typeof sql<boolean>>, out: Row[]) {
    const doctor = s.wl_to.er_stat === 'nurses_doctor' && has(u, 'er_doctor');
    const r = await sql<{ id: string; encounter_id: string; visit_no: string; pname: string; dep: string; label: string; created_at: Date }>`
      SELECT o.id, v.encounter_id, v.visit_no, ${name} AS pname, d.name AS dep, coalesce(o.drug_text, o.text, g.inn, 'დანიშნულება') AS label, o.created_at
        FROM er_orders o JOIN er_visits v ON v.encounter_id = o.encounter_id JOIN patients p ON p.id = v.patient_id JOIN departments d ON d.id = v.department_id
        LEFT JOIN med_generics g ON g.id = o.generic_id
       WHERE o.status = 'active' AND o.order_type = 'stat' AND v.ended_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM er_administrations a WHERE a.order_id = o.id AND a.voided_at IS NULL)
         AND (${nurseDept} OR (${doctor} AND v.doctor_id = ${u.id}))
       ORDER BY o.created_at LIMIT ${LIMIT}`.execute(this.db);
    for (const k of r.rows) out.push({ id: k.id, source: 'er_stat', title: `STAT — შესასრულებელი (${k.visit_no})`, detail: k.label, patient: k.pname, department: k.dep,
      due_at: new Date(new Date(k.created_at).getTime() + s.stat_due_min * 60_000), priority: 'urgent', link: tab(k.encounter_id, 'orders'), created_at: k.created_at });
  }

  private async admit(u: AuthUser, s: ErClinicalSettings, me: { department_id: string | null; is_section_head: boolean | null }, x: AdminCtx, out: Row[]) {
    const head = await x.isHead();
    const deptOk = s.wl_to.er_admit_req === 'head' ? head : has(u, 'doctor') || head;
    const r = await sql<{ id: string; encounter_id: string; visit_no: string; pname: string; dep: string; er_dep: string; icd: string; requested_at: Date; by: string; dep_id: string }>`
      SELECT q.id, v.encounter_id, v.visit_no, ${name} AS pname, d.name AS dep, ed.name AS er_dep, q.icd10_code || ' ' || q.icd10_title AS icd, q.requested_at,
             ru.last_name || ' ' || ru.first_name AS by, q.department_id AS dep_id
        FROM er_admit_requests q JOIN er_visits v ON v.encounter_id = q.encounter_id JOIN patients p ON p.id = v.patient_id
        JOIN departments d ON d.id = q.department_id JOIN departments ed ON ed.id = v.department_id JOIN users ru ON ru.id = q.requested_by
       WHERE q.status = 'requested' AND (q.attending_doctor_id = ${u.id} OR (${deptOk} AND q.department_id = ${me.department_id ?? NIL}::uuid))
       ORDER BY q.requested_at LIMIT ${LIMIT}`.execute(this.db);
    for (const k of r.rows) out.push({ id: k.id, source: 'er_admit_req', title: `ER → ${k.dep}: ჰოსპიტალიზაციის მოთხოვნა (${k.visit_no})`, detail: `${k.icd} · ${k.by}`,
      patient: k.pname, department: k.dep, due_at: new Date(new Date(k.requested_at).getTime() + s.admit_wait_min * 60_000), priority: 'urgent',
      link: `/inpatient?tab=er&department_id=${k.dep_id}`, created_at: k.requested_at });
  }

  private async retriage(u: AuthUser, s: ErClinicalSettings, nurseDept: ReturnType<typeof sql<boolean>>, out: Row[]) {
    void u;
    const r = await sql<{ encounter_id: string; visit_no: string; pname: string; dep: string; due: Date; lvl: string; last: Date }>`
      SELECT v.encounter_id, v.visit_no, ${name} AS pname, d.name AS dep, v.last_triage_at + make_interval(mins => l.retriage_min) AS due, l.name AS lvl, v.last_triage_at AS last
        FROM er_visits v JOIN patients p ON p.id = v.patient_id JOIN departments d ON d.id = v.department_id
        JOIN er_triage_levels l ON l.scale_code = v.triage_scale AND l.level = v.triage_level
       WHERE v.ended_at IS NULL AND v.doctor_at IS NULL AND v.last_triage_at IS NOT NULL AND l.retriage_min IS NOT NULL
         AND v.last_triage_at + make_interval(mins => l.retriage_min) <= now() + interval '15 minutes' AND (${nurseDept})
       ORDER BY 5 LIMIT ${LIMIT}`.execute(this.db);
    for (const k of r.rows) out.push({ id: k.encounter_id, source: 'er_retriage', title: `განმეორებითი ტრიაჟი (${k.visit_no})`, detail: `${k.lvl} · ექიმს ჯერ არ უნახავს`,
      patient: k.pname, department: k.dep, due_at: k.due, priority: 'high', link: `/er?visit=${k.encounter_id}`, created_at: k.last });
    void s;
  }

  private async docOpen(u: AuthUser, s: ErClinicalSettings, out: Row[]) {
    const author = s.wl_to.er_doc_open === 'attending_author';
    const r = await sql<{ encounter_id: string; visit_no: string; pname: string; dep: string; due: Date; ended: Date; initial: boolean; dx: boolean; drafts: number }>`
      SELECT v.encounter_id, v.visit_no, ${name} AS pname, d.name AS dep, v.doc_closes_at AS due, v.ended_at AS ended,
             EXISTS (SELECT 1 FROM doctor_notes n WHERE n.encounter_id = v.encounter_id AND n.kind = 'er_initial' AND n.status = 'signed' AND n.superseded_at IS NULL) AS initial,
             EXISTS (SELECT 1 FROM encounter_diagnoses x WHERE x.encounter_id = v.encounter_id AND x.diagnosis_type = 'primary') AS dx,
             (SELECT count(*)::int FROM doctor_notes n WHERE n.encounter_id = v.encounter_id AND n.status = 'draft' AND n.kind LIKE 'er_%') AS drafts
        FROM er_visits v JOIN patients p ON p.id = v.patient_id JOIN departments d ON d.id = v.department_id
       WHERE v.status = 'departed' AND v.doc_closes_at > now() AND v.disposition <> 'lwbs'
         AND (v.doctor_id = ${u.id} OR (${author} AND EXISTS (SELECT 1 FROM doctor_notes n WHERE n.encounter_id = v.encounter_id AND n.status = 'draft' AND n.author_id = ${u.id})))
       ORDER BY v.doc_closes_at LIMIT ${LIMIT}`.execute(this.db);
    for (const k of r.rows) {
      const miss = [!k.initial && 'პირველადი გასინჯვა ხელმოუწერელია', !k.dx && 'ძირითადი ICD-10 არ არის', k.drafts > 0 && `მონახაზი — ${k.drafts}`].filter(Boolean);
      if (!miss.length) continue;
      out.push({ id: k.encounter_id, source: 'er_doc_open', title: `ER-ის დოკუმენტაცია — ფანჯარა იხურება (${k.visit_no})`, detail: miss.join(' · '),
        patient: k.pname, department: k.dep, due_at: k.due, priority: 'high', link: tab(k.encounter_id, 'notes'), created_at: k.ended });
    }
  }

  private async unpaid(x: AdminCtx, out: Row[]) {
    const days = x.s.debt_days ?? 30;
    const r = await sql<{ encounter_id: string; visit_no: string; pname: string; dep: string; due: string; number: string; ended: Date }>`
      SELECT v.encounter_id, v.visit_no, ${name} AS pname, d.name AS dep, (i.patient_share - coalesce((SELECT sum(amount) FROM payments pm WHERE pm.invoice_id = i.id), 0))::text AS due,
             i.invoice_number AS number, v.ended_at AS ended
        FROM er_visits v JOIN invoices i ON i.encounter_id = v.encounter_id JOIN patients p ON p.id = v.patient_id JOIN departments d ON d.id = v.department_id
       WHERE v.status = 'departed' AND i.merged_into_invoice_id IS NULL AND v.ended_at > now() - make_interval(days => ${days})
         AND i.patient_share > coalesce((SELECT sum(amount) FROM payments pm WHERE pm.invoice_id = i.id), 0)
       ORDER BY v.ended_at LIMIT ${LIMIT}`.execute(this.db);
    for (const k of r.rows) out.push({ id: k.encounter_id, source: 'er_unpaid', title: `ER — გადაუხდელი (${k.visit_no})`, detail: `${k.number} · ${Number(k.due).toFixed(2)} ₾`,
      patient: k.pname, department: k.dep, due_at: null, priority: 'normal', link: `/cashier/${k.encounter_id}`, created_at: k.ended });
  }
}
