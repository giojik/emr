import { Injectable } from '@nestjs/common';
import { sql, type RawBuilder } from 'kysely';
import { has, type AuthUser } from '../auth/roles';
import { InjectDb, type Database } from '../database/database.module';
import { WL_DEFAULTS } from './worklist-common';
import type { AdminCtx, Row, SourceGroup } from './worklist-sources-admin';
import { ClinCtx, NIL, plus, uuids } from './worklist-sources-clinical';
import { modUsable } from '../modules/modules-ref';

/**
 * სამუშაო სიები (D5), 0084 — დიაგნოსტიკის წყაროები (ვირტუალური, როგორც 0081–0083): ჩანაწერი ყოველ ჯერზე წყაროს ცხრილიდან ითვლება,
 * საქმის დასრულებისას თავისით ქრება. admin პასუხისმგებლობას არ ქმნის. მოდული — core (ლაბ. / რადიოლოგია / ენდოსკოპია ბირთვია).
 *
 * მფლობელები (A1 — ბუნებრივი მფლობელი, მოდულის წვდომის წესით):
 *  • აღება: სტაციონარი — განყოფილების ექთნები (nurse_scope); ამბულატორია / ლაბ. ვიზიტი — ფლებოტომისტი (არ ჰყავთ — diagnostic).
 *  • ლაბ. მიღება / შედეგი / გარე ლაბ. / მიუბმელი — diagnostic (lab_doctor); ვალიდაცია / კრიტიკულის შეტყობინება / QC — lab_doctor (QC — + lab_manager).
 *  • პასუხის გაცნობა — სტაციონარი: მკურნალი (არ არის — ხელმძღვანელი → განყოფილების ექიმები); ამბულატორია: დამნიშნავი (არ არის — მკურნალი).
 *    კრიტიკული — დამნიშნავი + მკურნალი; critical_ack_min-ის შემდეგ + განყოფილების ხელმძღვანელი (არ არის — ცვლაში მყოფი ექიმები → განყოფილების ექიმები).
 *  • რადიოლოგია / ენდოსკოპია: დაგეგმვა — rad_scheduler; შესრულება — რადიოგრაფერი / ენდოსკოპიის ექთანი; დასკვნა — რადიოლოგი / ენდოსკოპისტი (მონახაზი — ავტორი).
 *  • „ვერ შესრულდა“ / შეუსრულებელი ამბულატორიული კვლევა — დამნიშნავი ექიმი. მიმართვა — hospitalization: რეგისტრატორი; სხვა: diagnostic.
 *  • dx_list_mode = attention — აღება / შედეგი / დაგეგმვა / შესრულება / დასკვნა: მხოლოდ სასწრაფო ან ვადაგადაცილებული (სრული რიგი — თავის ეკრანზე).
 */

const LIMIT = 200;
const PN = sql<string>`p.last_name || ' ' || p.first_name`;
/** შეკვეთის განყოფილება: სტაციონარში — მიმდინარე საწოლის განყოფილება, სხვაგან — ვიზიტის */
const XDEP = sql`CROSS JOIN LATERAL (SELECT coalesce((SELECT a.department_id FROM bed_assignments a WHERE a.encounter_id = e.id AND a.end_kind IS DISTINCT FROM 'cancel'
    ORDER BY (a.ended_at IS NULL) DESC, a.started_at DESC, a.id DESC LIMIT 1), e.department_id) AS dep) x LEFT JOIN departments d ON d.id = x.dep`;
const ITEMS = sql`dx_order_items i JOIN dx_services sv ON sv.id = i.service_id JOIN patients p ON p.id = i.patient_id JOIN encounters e ON e.id = i.encounter_id ${XDEP}`;
const IPD = sql<boolean>`EXISTS (SELECT 1 FROM inpatient_stays st WHERE st.encounter_id = e.id AND st.status = 'active')`;
const CRIT_LAB = sql<boolean>`EXISTS (SELECT 1 FROM lab_results r WHERE r.order_item_id = i.id AND r.flag IN ('HH', 'LL'))`;
const CRIT_IMG = sql<boolean>`EXISTS (SELECT 1 FROM dx_reports rr WHERE rr.order_item_id = i.id AND rr.is_critical AND rr.status = 'signed')`;
const CRIT = sql<boolean>`((i.section = 'lab' AND ${CRIT_LAB}) OR (i.section <> 'lab' AND ${CRIT_IMG}))`;
const SECTION_KA: Record<string, string> = { lab: 'ლაბ.', radiology: 'რადიოლოგია', endoscopy: 'ენდოსკოპია' };
const REF_KA: Record<string, string> = { lab: 'ლაბორატორია', imaging: 'გამოსახულება', hospitalization: 'ჰოსპიტალიზაცია', specialist_consult: 'სპეციალისტის კონსულტაცია' };
const encLink = (enc: string, ipd: boolean) => (ipd ? `/inpatient/stay/${enc}` : `/encounters/${enc}`);
const ackLink = (enc: string) => `/tasks?ack=${enc}`;
const hrs = (d: Date | string | null | undefined, h: number) => plus(d, h * 60);
const names = (xs: string[], n = 4) => (xs.length > n ? `${xs.slice(0, n).join(', ')} +${xs.length - n}` : xs.join(', '));

@Injectable()
export class WorklistDxSources {
  constructor(@InjectDb() private readonly db: Database) {}

  groups(): SourceGroup[] {
    const c = (f: (cx: ClinCtx, codes: Set<string>) => Promise<Row[]>) => (u: AuthUser, codes: Set<string>, x: AdminCtx) => f(new ClinCtx(this.db, u, x), codes);
    return [
      { module: 'core', codes: ['lab_collect', 'lab_recollect'], fetch: c((x, k) => this.collect(x, k)) },
      { module: 'core', codes: ['lab_receive', 'lab_result', 'lab_validate', 'lab_crit_call', 'lab_qc', 'lab_unmatched', 'lab_ext_send', 'lab_ext_due'], fetch: c((x, k) => this.lab(x, k)) },
      { module: 'core', codes: ['res_critical', 'res_ack'], fetch: c((x, k) => this.results(x, k)) },
      { module: 'core', codes: ['rad_schedule', 'rad_perform', 'rad_report', 'endo_report', 'endo_path'], fetch: c((x, k) => this.imaging(x, k)) },
      { module: 'core', codes: ['dx_issue', 'amb_dx_pending', 'ref_todo'], fetch: c((x, k) => this.doctorSide(x, k)) },
    ];
  }

  private s(x: ClinCtx) { return { ...WL_DEFAULTS, ...x.x.s }; }
  private attention(x: ClinCtx) { return this.s(x).dx_list_mode !== 'all'; }
  /** 0084a: ნაკადის წყაროების ასაკის ზღვარი (დანიშვნის / აღების დრო) */
  private fresh(x: ClinCtx, col: RawBuilder<unknown>) {
    return sql<boolean>`${col} > now() - make_interval(days => ${this.s(x).dx_max_age_days ?? WL_DEFAULTS.dx_max_age_days}::int)`;
  }

  // ================================================================== ნიმუშის აღება (C1 — ვიზიტზე)
  private async collect(x: ClinCtx, c: Set<string>): Promise<Row[]> {
    const s = this.s(x);
    const nurseDeps = await x.nurseDepts();
    const amb = has(x.u, 'phlebotomist') || (has(x.u, 'diagnostic') && !(await x.x.capExists('phlebotomist')));
    if (!nurseDeps.length && !amb) return [];
    const { routine, urgent } = { ...WL_DEFAULTS.lab_collect_min, ...s.lab_collect_min };
    const att = this.attention(x);
    const r = await sql<{ encounter_id: string; pname: string; dep_name: string | null; ipd: boolean; n: number; urgent: boolean; first: Date; names: string[]; issue: string | null; issue_at: Date | null }>`
      SELECT i.encounter_id, ${PN} AS pname, d.name AS dep_name, ${IPD} AS ipd, count(*)::int AS n, bool_or(i.priority = 'urgent') AS urgent, min(i.ordered_at) AS first,
             array_agg(sv.name ORDER BY sv.sort_order) AS names, max(i.collection_issue) AS issue, max(i.collection_issue_at) AS issue_at
        FROM ${ITEMS} LEFT JOIN invoices inv ON inv.encounter_id = e.id
       WHERE i.section = 'lab' AND i.status = 'ordered' AND ${this.fresh(x, sql.ref('i.ordered_at'))}
         AND ((${IPD} AND x.dep = ANY (${uuids(nurseDeps)}::uuid[]))
           OR (${amb} AND NOT ${IPD} AND e.type <> 'inpatient' AND e.status = 'active' AND inv.paid_status IS DISTINCT FROM 'unpaid'
               AND i.ordered_at > now() - make_interval(days => ${s.lab_collect_days ?? WL_DEFAULTS.lab_collect_days}::int)))
       GROUP BY i.encounter_id, p.last_name, p.first_name, d.name, e.id
       ORDER BY bool_or(i.priority = 'urgent') DESC, min(i.ordered_at) LIMIT ${LIMIT}`.execute(this.db);
    const out: Row[] = [];
    for (const a of r.rows) {
      const due = plus(a.first, a.urgent ? urgent : routine);
      if (a.issue) {
        if (c.has('lab_recollect')) out.push({ id: a.encounter_id, source: 'lab_recollect', title: `ნიმუში ვერ აიღეს — ${a.pname}`, detail: `${a.issue} · ${names(a.names)}`,
          patient: a.pname, department: a.dep_name, due_at: due, priority: a.urgent ? 'urgent' : 'high', link: '/collection', created_at: a.issue_at ?? a.first });
        continue;
      }
      if (!c.has('lab_collect')) continue;
      if (att && !a.urgent && !(due && due.getTime() < Date.now())) continue;
      out.push({ id: a.encounter_id, source: 'lab_collect', title: `ნიმუშის აღება: ${a.n} ანალიზი — ${a.pname}`, detail: names(a.names), patient: a.pname, department: a.dep_name,
        due_at: due, priority: a.urgent ? 'urgent' : 'normal', link: '/collection', created_at: a.first });
    }
    return out;
  }

  // ================================================================== ლაბორატორია
  private async lab(x: ClinCtx, c: Set<string>): Promise<Row[]> {
    const s = this.s(x);
    const out: Row[] = [];
    const staff = has(x.u, 'diagnostic', 'lab_doctor');
    const doer = has(x.u, 'diagnostic') || (has(x.u, 'lab_doctor') && !(await x.x.capExists('diagnostic')));
    const labDoc = has(x.u, 'lab_doctor');
    const att = this.attention(x);
    if (c.has('lab_receive') && staff) {
      const m = s.lab_transit_min ?? WL_DEFAULTS.lab_transit_min;
      const r = await sql<{ id: string; barcode: string; collected_at: Date; pname: string; dep_name: string | null; urgent: boolean; names: string[] }>`
        SELECT sp.id, sp.barcode, sp.collected_at, ${PN} AS pname, d.name AS dep_name, bool_or(i.priority = 'urgent') AS urgent, array_agg(sv.name) AS names
          FROM lab_specimens sp JOIN ${ITEMS} ON i.specimen_id = sp.id
         WHERE sp.status = 'collected' AND sp.collected_at < now() - make_interval(mins => ${m}::int) AND i.status = 'collected' AND sv.performed_by = 'internal'
           AND ${this.fresh(x, sql.ref('sp.collected_at'))}
         GROUP BY sp.id, p.last_name, p.first_name, d.name ORDER BY sp.collected_at LIMIT ${LIMIT}`.execute(this.db);
      for (const a of r.rows) out.push({ id: a.id, source: 'lab_receive', title: `სინჯარა ${a.barcode} ლაბ.-ში არ მიუღიათ — ${a.pname}`, detail: names(a.names), patient: a.pname,
        department: a.dep_name, due_at: plus(a.collected_at, m), priority: a.urgent ? 'urgent' : 'high', link: '/diagnostics/lab', created_at: a.collected_at });
    }
    if (c.has('lab_result') && doer) {
      const t = { ...WL_DEFAULTS.lab_tat_hours, ...s.lab_tat_hours };
      const r = await sql<{ id: string; name: string; pname: string; dep_name: string | null; urgent: boolean; micro: boolean; received_at: Date; barcode: string | null }>`
        SELECT i.id, sv.name, ${PN} AS pname, d.name AS dep_name, i.priority = 'urgent' AS urgent, sv.is_micro AS micro, coalesce(sp.received_at, i.ordered_at) AS received_at, sp.barcode
          FROM ${ITEMS} LEFT JOIN lab_specimens sp ON sp.id = i.specimen_id
         WHERE i.section = 'lab' AND i.status = 'in_progress' AND sv.performed_by = 'internal' AND ${this.fresh(x, sql.ref('i.ordered_at'))}
           AND (NOT ${att} OR i.priority = 'urgent' OR coalesce(sp.received_at, i.ordered_at) + make_interval(hours => CASE WHEN sv.is_micro THEN ${t.micro}::int ELSE ${t.routine}::int END) < now())
         ORDER BY i.priority = 'urgent' DESC, coalesce(sp.received_at, i.ordered_at) LIMIT ${LIMIT}`.execute(this.db);
      for (const a of r.rows) out.push({ id: a.id, source: 'lab_result', title: `შედეგი: ${a.name} — ${a.pname}`, detail: a.barcode ? `სინჯარა ${a.barcode}` : null, patient: a.pname,
        department: a.dep_name, due_at: hrs(a.received_at, a.micro ? t.micro : a.urgent ? t.urgent : t.routine), priority: a.urgent ? 'urgent' : 'normal',
        link: '/diagnostics/lab', created_at: a.received_at });
    }
    if (c.has('lab_validate') && labDoc) {
      const r = await sql<{ id: string; name: string; pname: string; dep_name: string | null; urgent: boolean; crit: boolean; resulted_at: Date | null; ordered_at: Date }>`
        SELECT i.id, sv.name, ${PN} AS pname, d.name AS dep_name, i.priority = 'urgent' AS urgent, ${CRIT_LAB} AS crit, i.resulted_at, i.ordered_at
          FROM ${ITEMS} WHERE i.section = 'lab' AND i.status = 'resulted' AND ${this.fresh(x, sql.ref('i.ordered_at'))} ORDER BY ${CRIT_LAB} DESC, i.priority = 'urgent' DESC, i.resulted_at LIMIT ${LIMIT}`.execute(this.db);
      for (const a of r.rows) out.push({ id: a.id, source: 'lab_validate', title: `${a.crit ? '⚠ კრიტიკული — ' : ''}ვალიდაცია: ${a.name} — ${a.pname}`, detail: null, patient: a.pname,
        department: a.dep_name, due_at: x.x.sla('lab_validate', a.resulted_at ?? a.ordered_at), priority: a.crit || a.urgent ? 'urgent' : 'normal',
        link: '/diagnostics/lab?tab=resulted', created_at: a.resulted_at ?? a.ordered_at });
    }
    if (c.has('lab_crit_call') && labDoc && s.lab_crit_call !== 'off') {
      const r = await sql<{ id: string; name: string; pname: string; dep_name: string | null; validated_at: Date; vals: string[] }>`
        SELECT i.id, sv.name, ${PN} AS pname, d.name AS dep_name, i.validated_at,
               ARRAY(SELECT a.name || ' ' || coalesce(r.value_num::text, r.value_text, '') || ' ' || r.flag FROM lab_results r JOIN lab_analytes a ON a.id = r.analyte_id
                      WHERE r.order_item_id = i.id AND r.flag IN ('HH', 'LL') ORDER BY a.sort_order) AS vals
          FROM ${ITEMS}
         WHERE i.section = 'lab' AND i.status = 'validated' AND i.crit_notified_at IS NULL AND i.validated_at > now() - interval '7 days' AND ${CRIT_LAB}
           AND (i.validated_by = ${x.u.id} OR NOT EXISTS (SELECT 1 FROM users vu JOIN user_capabilities vc ON vc.user_id = vu.id
                 WHERE vu.id = i.validated_by AND vu.is_active AND 'lab_doctor' = ANY (vc.capabilities)))
         ORDER BY i.validated_at LIMIT ${LIMIT}`.execute(this.db);
      for (const a of r.rows) out.push({ id: a.id, source: 'lab_crit_call', title: `⚠ კრიტიკული — ჩაწერეთ, ვის ეცნობა: ${a.name} — ${a.pname}`, detail: a.vals.join('; '),
        patient: a.pname, department: a.dep_name, due_at: plus(a.validated_at, 15), priority: 'urgent', link: `/diagnostics/lab?tab=validated&item=${a.id}`, created_at: a.validated_at });
    }
    if (c.has('lab_qc') && has(x.u, 'lab_doctor', 'lab_manager')) {
      const r = await sql<{ id: string; method: string; analyte: string; rules: string[]; action: string; opened_at: Date }>`
        SELECT v.id::text AS id, m.name AS method, a.name AS analyte, v.rules, v.action, v.opened_at FROM lab_qc_violations v JOIN lab_methods m ON m.id = v.method_id
          JOIN lab_analytes a ON a.id = v.analyte_id WHERE v.status = 'open' ORDER BY v.opened_at LIMIT ${LIMIT}`.execute(this.db);
      for (const a of r.rows) out.push({ id: a.id, source: 'lab_qc', title: `QC დარღვევა: ${a.method} / ${a.analyte}`, detail: `${a.rules.join(', ')} · ${a.action === 'block' ? 'ვალიდაცია დაბლოკილია' : 'გაფრთხილება'}`,
        patient: null, department: null, due_at: null, priority: a.action === 'block' ? 'high' : 'normal', link: '/diagnostics/lab?tab=qc', created_at: a.opened_at });
    }
    if (c.has('lab_unmatched') && staff) {
      const r = (await sql<{ inst: number; mail: number; inst_first: Date | null; mail_first: Date | null }>`
        SELECT (SELECT count(*)::int FROM lab_instrument_results WHERE status = 'unmatched') AS inst, (SELECT min(created_at) FROM lab_instrument_results WHERE status = 'unmatched') AS inst_first,
               (SELECT count(*)::int FROM lab_ext_mail_files WHERE status = 'unmatched') AS mail,
               (SELECT min(m.received_at) FROM lab_ext_mail_files f JOIN lab_ext_mail m ON m.id = f.mail_id WHERE f.status = 'unmatched') AS mail_first`.execute(this.db)).rows[0];
      if (r.inst) out.push({ id: 'instrument', source: 'lab_unmatched', title: `ანალიზატორი: მიუბმელი პასუხი — ${r.inst}`, detail: 'ლაბორატორია → ანალიზატორები (დასამუშავებელი)',
        patient: null, department: null, due_at: null, priority: 'high', link: '/diagnostics/lab?inbox=1', created_at: r.inst_first });
      if (r.mail) out.push({ id: 'mail', source: 'lab_unmatched', title: `გარე ლაბ. ელფოსტა: მიუბმელი ფაილი — ${r.mail}`, detail: 'ლაბორატორია → გარე ლაბორატორია',
        patient: null, department: null, due_at: null, priority: 'high', link: '/diagnostics/lab?tab=ext', created_at: r.mail_first });
    }
    if (c.has('lab_ext_send') && has(x.u, 'diagnostic')) {
      const r = await sql<{ lab: string; n: number; first: Date; urgent: boolean }>`
        SELECT coalesce(l.name, sv.external_lab, '—') AS lab, count(*)::int AS n, min(sp.collected_at) AS first, bool_or(i.priority = 'urgent') AS urgent
          FROM dx_order_items i JOIN dx_services sv ON sv.id = i.service_id JOIN lab_specimens sp ON sp.id = i.specimen_id LEFT JOIN lab_external_labs l ON l.id = sv.external_lab_id
         WHERE i.section = 'lab' AND sv.performed_by = 'external' AND i.ext_shipment_id IS NULL AND i.status IN ('collected', 'in_progress') AND sp.status IN ('collected', 'received')
         GROUP BY 1 ORDER BY 3 LIMIT ${LIMIT}`.execute(this.db);
      for (const a of r.rows) out.push({ id: a.lab, source: 'lab_ext_send', title: `გარე ლაბ. „${a.lab}“ — გასაგზავნი: ${a.n}`, detail: 'გადაცემის აქტი არ არის', patient: null, department: null,
        due_at: hrs(a.first, 24), priority: a.urgent ? 'high' : 'normal', link: '/diagnostics/lab?tab=ext', created_at: a.first });
    }
    if (c.has('lab_ext_due') && has(x.u, 'diagnostic')) {
      const r = await sql<{ id: string; name: string; pname: string; dep_name: string | null; lab: string | null; ext_due_at: Date; urgent: boolean }>`
        SELECT i.id, sv.name, ${PN} AS pname, d.name AS dep_name, l.name AS lab, i.ext_due_at, i.priority = 'urgent' AS urgent
          FROM ${ITEMS} LEFT JOIN lab_external_labs l ON l.id = i.ext_lab_id
         WHERE i.section = 'lab' AND i.ext_shipment_id IS NOT NULL AND i.ext_result_at IS NULL AND i.status NOT IN ('cancelled', 'validated') AND i.ext_due_at < now()
         ORDER BY i.ext_due_at LIMIT ${LIMIT}`.execute(this.db);
      for (const a of r.rows) out.push({ id: a.id, source: 'lab_ext_due', title: `გარე ლაბ. პასუხი აგვიანებს: ${a.name} — ${a.pname}`, detail: a.lab, patient: a.pname, department: a.dep_name,
        due_at: a.ext_due_at, priority: a.urgent ? 'urgent' : 'high', link: '/diagnostics/lab?tab=ext', created_at: null });
    }
    return out;
  }

  // ================================================================== პასუხის გაცნობა / კრიტიკული (ექიმი)
  /** ექიმის როლი შეკვეთასთან: SQL — i, e, x.dep */
  private async escalation(x: ClinCtx) {
    const me = await x.x.me();
    const head = await x.headDoctor();
    const hdd = [...(await x.headDoctorDepts())];
    const ro = { enabled: await modUsable(this.db, 'roster') };   // 0086: მორიგეობა — ჩვენება (read_only-ზეც)
    const ONSHIFT = (user: RawBuilder<unknown>) => sql<boolean>`EXISTS (SELECT 1 FROM roster_entries re JOIN rosters r ON r.id = re.roster_id
      JOIN staff_members sm ON sm.id = re.staff_id LEFT JOIN staff_positions sp ON sp.id = sm.position_id
      WHERE re.status = 'active' AND r.status IN ('published', 'closed') AND re.starts_at <= now() AND re.ends_at > now() AND r.department_id = x.dep
        AND sp.category = 'doctor' AND sm.user_id IS NOT NULL AND ${user})`;
    const roster = !!ro?.enabled;
    // ხელმძღვანელი → (ხელმძღვანელის გარეშე) ცვლაში მყოფი ექიმი → (ცვლაში არავინ) განყოფილების ექიმები
    return sql<boolean>`(x.dep = ${me.department_id ?? NIL}::uuid AND (${head} OR (NOT x.dep = ANY (${uuids(hdd)}::uuid[])
      AND (NOT ${roster} OR ${ONSHIFT(sql`sm.user_id = ${x.u.id}`)} OR NOT ${ONSHIFT(sql`TRUE`)}))))`;
  }

  private async results(x: ClinCtx, c: Set<string>): Promise<Row[]> {
    if (!x.isDoctor()) return [];
    const s = this.s(x);
    const out: Row[] = [];
    const days = s.ack_days ?? WL_DEFAULTS.ack_days;
    const me = x.u.id;
    const NOT_LAB_VISIT = sql`e.visit_kind <> 'lab' AND e.status <> 'cancelled'`;
    if (c.has('res_critical')) {
      const mins = s.critical_ack_min ?? WL_DEFAULTS.critical_ack_min;
      const esc = await this.escalation(x);
      const r = await sql<{ id: string; encounter_id: string; name: string; section: string; pname: string; dep_name: string | null; validated_at: Date; vals: string[]; ipd: boolean }>`
        SELECT i.id, i.encounter_id, sv.name, i.section, ${PN} AS pname, d.name AS dep_name, i.validated_at, ${IPD} AS ipd,
               CASE WHEN i.section = 'lab' THEN ARRAY(SELECT a.name || ' ' || coalesce(r.value_num::text, r.value_text, '') || ' ' || r.flag FROM lab_results r JOIN lab_analytes a ON a.id = r.analyte_id
                      WHERE r.order_item_id = i.id AND r.flag IN ('HH', 'LL') ORDER BY a.sort_order)
                    ELSE ARRAY(SELECT left(rr.impression, 160) FROM dx_reports rr WHERE rr.order_item_id = i.id) END AS vals
          FROM ${ITEMS} LEFT JOIN users au ON au.id = e.attending_doctor_id
         WHERE i.status = 'validated' AND i.validated_at > now() - make_interval(days => ${days}::int) AND ${NOT_LAB_VISIT} AND ${CRIT}
           AND NOT EXISTS (SELECT 1 FROM dx_result_acks k WHERE k.order_item_id = i.id AND k.kind = 'critical' AND k.acked_at >= i.validated_at)
           AND (i.ordered_by = ${me} OR (e.attending_doctor_id = ${me} AND coalesce(au.is_active, FALSE))
                OR (i.validated_at < now() - make_interval(mins => ${mins}::int) AND ${esc}))
         ORDER BY i.validated_at LIMIT ${LIMIT}`.execute(this.db);
      for (const a of r.rows) out.push({ id: a.id, source: 'res_critical', title: `⚠ კრიტიკული ${SECTION_KA[a.section] ?? ''}: ${a.name} — ${a.pname}`, detail: a.vals.join('; ') || null,
        patient: a.pname, department: a.dep_name, due_at: plus(a.validated_at, mins), priority: 'urgent', link: ackLink(a.encounter_id), created_at: a.validated_at });
    }
    if (c.has('res_ack') && s.ack_scope !== 'critical') {
      const owner = await x.doctorOwner();   // სტაციონარი: s.att / s.att_active / s.dep
      const scope = s.ack_scope === 'all' ? sql`TRUE`
        : sql`(i.section <> 'lab' OR sv.performed_by = 'external' OR sv.is_micro OR EXISTS (SELECT 1 FROM lab_results r WHERE r.order_item_id = i.id AND r.flag IN ('L', 'H', 'A', 'LL', 'HH')))`;
      const r = await sql<{ encounter_id: string; pname: string; dep_name: string | null; ipd: boolean; n: number; first: Date; names: string[]; abn: boolean }>`
        SELECT s.encounter_id, s.pname, s.dep_name, s.ipd, count(*)::int AS n, min(s.validated_at) AS first, array_agg(s.name ORDER BY s.validated_at) AS names, bool_or(s.abn) AS abn
          FROM (SELECT i.encounter_id, i.validated_at, sv.name, ${PN} AS pname, d.name AS dep_name, x.dep, e.type = 'inpatient' AS ipd, i.ordered_by,
                       e.attending_doctor_id AS att, coalesce(au.is_active, FALSE) AS att_active, coalesce(ou.is_active AND 'doctor' = ANY (oc.capabilities), FALSE) AS ord_doc,
                       (i.section = 'lab' AND EXISTS (SELECT 1 FROM lab_results r WHERE r.order_item_id = i.id AND r.flag IN ('L', 'H', 'A'))) AS abn
                  FROM ${ITEMS} LEFT JOIN users au ON au.id = e.attending_doctor_id LEFT JOIN users ou ON ou.id = i.ordered_by LEFT JOIN user_capabilities oc ON oc.user_id = i.ordered_by
                 WHERE i.status = 'validated' AND i.validated_at > now() - make_interval(days => ${days}::int) AND ${NOT_LAB_VISIT} AND ${scope}
                   AND NOT ${CRIT}
                   AND NOT EXISTS (SELECT 1 FROM dx_result_acks k WHERE k.order_item_id = i.id AND k.acked_at >= i.validated_at)) s
         WHERE (s.ipd AND ${owner}) OR (NOT s.ipd AND (s.ordered_by = ${me} OR (NOT s.ord_doc AND s.att = ${me} AND s.att_active)))
         GROUP BY s.encounter_id, s.pname, s.dep_name, s.ipd ORDER BY min(s.validated_at) LIMIT ${LIMIT}`.execute(this.db);
      for (const a of r.rows) out.push({ id: a.encounter_id, source: 'res_ack', title: `პასუხი გასაცნობია: ${a.n} — ${a.pname}`, detail: names(a.names), patient: a.pname, department: a.dep_name,
        due_at: hrs(a.first, s.ack_hours ?? WL_DEFAULTS.ack_hours), priority: a.abn ? 'high' : 'normal', link: ackLink(a.encounter_id), created_at: a.first });
    }
    return out;
  }

  // ================================================================== რადიოლოგია / ენდოსკოპია
  private async imaging(x: ClinCtx, c: Set<string>): Promise<Row[]> {
    const s = this.s(x);
    const out: Row[] = [];
    const att = this.attention(x);
    const me = x.u.id;
    const tat = { ...WL_DEFAULTS.rad_tat_hours, ...s.rad_tat_hours };
    if (c.has('rad_schedule')) {
      const mode = s.rad_scheduler ?? 'radiographer';
      const tech = mode !== 'receptionist';
      const secs = [...(tech && has(x.u, 'radiographer') ? ['radiology'] : []), ...(tech && has(x.u, 'endoscopy_nurse') ? ['endoscopy'] : [])];
      const reg = mode !== 'radiographer' && has(x.u, 'receptionist');
      const regDepts = reg ? await x.x.regDepts() : null;
      if (secs.length || reg) {
        const regCond = !reg ? sql`FALSE` : regDepts === null ? sql`TRUE` : sql`e.department_id = ANY (${uuids(regDepts)}::uuid[])`;
        const r = await sql<{ id: string; section: string; name: string; pname: string; dep_name: string | null; ordered_at: Date; urgent: boolean; ipd: boolean }>`
          SELECT i.id, i.section, sv.name, ${PN} AS pname, d.name AS dep_name, i.ordered_at, i.priority = 'urgent' AS urgent, ${IPD} AS ipd
            FROM ${ITEMS}
           WHERE i.section IN ('radiology', 'endoscopy') AND i.status = 'ordered' AND i.scheduled_start IS NULL AND i.collection_issue IS NULL AND e.status IN ('planned', 'active')
             AND ${this.fresh(x, sql.ref('i.ordered_at'))}
             AND (i.section = ANY (${secs.length ? secs : ['-']}::text[]) OR ${regCond})
             AND (NOT ${att} OR i.priority = 'urgent' OR ${IPD} OR i.ordered_at < now() - interval '24 hours')
           ORDER BY i.priority = 'urgent' DESC, i.ordered_at LIMIT ${LIMIT}`.execute(this.db);
        for (const a of r.rows) out.push({ id: a.id, source: 'rad_schedule', title: `დასაგეგმი ${SECTION_KA[a.section]}: ${a.name} — ${a.pname}`, detail: a.ipd ? 'სტაციონარი' : null, patient: a.pname,
          department: a.dep_name, due_at: hrs(a.ordered_at, 24), priority: a.urgent || a.ipd ? 'high' : 'normal', link: `/diagnostics/${a.section}?view=schedule`, created_at: a.ordered_at });
      }
    }
    if (c.has('rad_perform')) {
      const secs = [...(has(x.u, 'radiographer') ? ['radiology'] : []), ...(has(x.u, 'endoscopy_nurse') ? ['endoscopy'] : [])];
      if (secs.length) {
        const r = await sql<{ id: string; section: string; name: string; pname: string; dep_name: string | null; status: string; due: Date; urgent: boolean; start: Date | null }>`
          SELECT i.id, i.section, sv.name, ${PN} AS pname, d.name AS dep_name, i.status, i.priority = 'urgent' AS urgent, i.scheduled_start AS start,
                 CASE i.status WHEN 'scheduled' THEN i.scheduled_start WHEN 'arrived' THEN i.arrived_at + interval '30 minutes' ELSE i.ordered_at + interval '60 minutes' END AS due
            FROM ${ITEMS}
           WHERE i.section = ANY (${secs}::text[]) AND i.collection_issue IS NULL AND e.status IN ('planned', 'active')
             AND ${this.fresh(x, sql.ref('i.ordered_at'))}
             AND ((i.status = 'scheduled' AND i.scheduled_start < now()) OR (i.status = 'arrived' AND (NOT ${att} OR i.arrived_at < now() - interval '30 minutes'))
                  OR (i.status = 'ordered' AND i.priority = 'urgent' AND ${IPD}))
           ORDER BY due LIMIT ${LIMIT}`.execute(this.db);
        const ST: Record<string, string> = { scheduled: 'დაგეგმილის დრო გავიდა', arrived: 'პაციენტი მოსულია', ordered: 'სასწრაფო — სტაციონარი' };
        for (const a of r.rows) out.push({ id: a.id, source: 'rad_perform', title: `შესასრულებელი ${SECTION_KA[a.section]}: ${a.name} — ${a.pname}`, detail: ST[a.status] ?? null, patient: a.pname,
          department: a.dep_name, due_at: a.due, priority: a.urgent ? 'urgent' : 'normal', link: `/diagnostics/${a.section}?view=queue`, created_at: a.start });
      }
    }
    const report = async (section: 'radiology' | 'endoscopy', code: 'rad_report' | 'endo_report', cap: 'radiologist' | 'endoscopist') => {
      if (!c.has(code) || !has(x.u, cap)) return;
      // ენდოსკოპია: შემსრულებელი (technician_id), თუ ის აქტიური ენდოსკოპისტია; სხვაგვარად — ყველა ენდოსკოპისტი
      const performer = section === 'endoscopy' ? sql`AND (i.technician_id = ${me} OR NOT EXISTS (SELECT 1 FROM users tu JOIN user_capabilities tc ON tc.user_id = tu.id
          WHERE tu.id = i.technician_id AND tu.is_active AND 'endoscopist' = ANY (tc.capabilities)))` : sql``;
      const r = await sql<{ id: string; name: string; pname: string; dep_name: string | null; performed_at: Date | null; urgent: boolean; draft: boolean; crit: boolean }>`
        SELECT i.id, sv.name, ${PN} AS pname, d.name AS dep_name, i.performed_at, i.priority = 'urgent' AS urgent, rp.status = 'draft' AS draft, coalesce(rp.is_critical, FALSE) AS crit
          FROM ${ITEMS} LEFT JOIN dx_reports rp ON rp.order_item_id = i.id LEFT JOIN users ra ON ra.id = rp.author_id
         WHERE i.section = ${section} AND i.status IN ('performed', 'in_progress') ${performer}
           AND (rp.author_id IS NULL OR rp.author_id = ${me} OR NOT coalesce(ra.is_active, FALSE))
           AND (NOT ${att} OR i.priority = 'urgent' OR coalesce(rp.is_critical, FALSE)
                OR coalesce(i.performed_at, i.ordered_at) + make_interval(hours => CASE WHEN i.priority = 'urgent' THEN ${tat.urgent}::int ELSE ${tat.routine}::int END) < now())
         ORDER BY i.priority = 'urgent' DESC, i.performed_at LIMIT ${LIMIT}`.execute(this.db);
      for (const a of r.rows) out.push({ id: a.id, source: code, title: `დასკვნა: ${a.name} — ${a.pname}`, detail: a.draft ? 'მონახაზი — ხელმოუწერელი' : null, patient: a.pname,
        department: a.dep_name, due_at: hrs(a.performed_at, a.urgent ? tat.urgent : tat.routine), priority: a.urgent || a.crit ? 'urgent' : 'normal',
        link: `/diagnostics/${section}?view=reports`, created_at: a.performed_at });
    };
    await report('radiology', 'rad_report', 'radiologist');
    await report('endoscopy', 'endo_report', 'endoscopist');
    if (c.has('endo_path') && has(x.u, 'endoscopist', 'endoscopy_nurse')) {
      const days = s.path_due_days ?? WL_DEFAULTS.path_due_days;
      const doc = has(x.u, 'endoscopist');
      const r = await sql<{ id: string; request_no: string; status: string; lab: string | null; pname: string; dep_name: string | null; created_at: Date; sent_at: Date | null; result_at: Date | null; mine: boolean }>`
        SELECT pr.id, pr.request_no, pr.status, pr.external_lab AS lab, ${PN} AS pname, d.name AS dep_name, pr.created_at, pr.sent_at, pr.result_received_at AS result_at,
               (i.technician_id = ${me} OR NOT EXISTS (SELECT 1 FROM users tu JOIN user_capabilities tc ON tc.user_id = tu.id
                 WHERE tu.id = i.technician_id AND tu.is_active AND 'endoscopist' = ANY (tc.capabilities))) AS mine
          FROM path_requests pr JOIN ${ITEMS} ON i.id = pr.order_item_id
         WHERE pr.status = 'draft' OR (pr.status = 'sent' AND pr.sent_at < now() - make_interval(days => ${days}::int)) OR (pr.status = 'resulted' AND pr.reviewed_at IS NULL)
         ORDER BY pr.created_at LIMIT ${LIMIT}`.execute(this.db);
      for (const a of r.rows) {
        const base = { id: a.id, source: 'endo_path', patient: a.pname, department: a.dep_name, link: '/diagnostics/endoscopy?view=pathology' };
        if (a.status === 'draft') out.push({ ...base, title: `ბიოფსია ${a.request_no} — გასაგზავნი: ${a.pname}`, detail: null, due_at: hrs(a.created_at, 24), priority: 'normal', created_at: a.created_at });
        else if (a.status === 'sent') out.push({ ...base, title: `ბიოფსიის პასუხი აგვიანებს: ${a.request_no} — ${a.pname}`, detail: a.lab, due_at: plus(a.sent_at, days * 1440), priority: 'high', created_at: a.sent_at });
        else if (doc && a.mine) out.push({ ...base, title: `ბიოფსიის პასუხი — გასაცნობი: ${a.request_no} — ${a.pname}`, detail: a.lab, due_at: hrs(a.result_at, 24), priority: 'high', created_at: a.result_at });
      }
    }
    return out;
  }

  // ================================================================== დამნიშნავი ექიმი / მიმართვები
  private async doctorSide(x: ClinCtx, c: Set<string>): Promise<Row[]> {
    const s = this.s(x);
    const out: Row[] = [];
    const me = x.u.id;
    if (c.has('dx_issue') && x.isDoctor()) {
      const r = await sql<{ encounter_id: string; section: string; pname: string; dep_name: string | null; ipd: boolean; n: number; issue: string; at: Date; names: string[] }>`
        SELECT i.encounter_id, i.section, ${PN} AS pname, d.name AS dep_name, ${IPD} AS ipd, count(*)::int AS n, max(i.collection_issue) AS issue, max(i.collection_issue_at) AS at,
               array_agg(sv.name) AS names
          FROM ${ITEMS} LEFT JOIN users ou ON ou.id = i.ordered_by LEFT JOIN user_capabilities oc ON oc.user_id = i.ordered_by LEFT JOIN users au ON au.id = e.attending_doctor_id
         WHERE i.status IN ('ordered', 'scheduled', 'arrived') AND i.collection_issue IS NOT NULL AND e.status IN ('planned', 'active')
           AND (i.ordered_by = ${me} OR (NOT coalesce(ou.is_active AND 'doctor' = ANY (oc.capabilities), FALSE) AND e.attending_doctor_id = ${me} AND coalesce(au.is_active, FALSE)))
         GROUP BY i.encounter_id, i.section, p.last_name, p.first_name, d.name, e.id ORDER BY max(i.collection_issue_at) LIMIT ${LIMIT}`.execute(this.db);
      for (const a of r.rows) out.push({ id: `${a.encounter_id}:${a.section}`, source: 'dx_issue', title: `${SECTION_KA[a.section]} ვერ შესრულდა — ${a.pname}`, detail: `${a.issue} · ${names(a.names)}`,
        patient: a.pname, department: a.dep_name, due_at: hrs(a.at, 24), priority: 'high', link: encLink(a.encounter_id, a.ipd), created_at: a.at });
    }
    if (c.has('amb_dx_pending') && x.isDoctor()) {
      const days = s.amb_dx_days ?? WL_DEFAULTS.amb_dx_days;
      const r = await sql<{ encounter_id: string; pname: string; dep_name: string | null; n: number; first: Date; names: string[]; urgent: boolean }>`
        SELECT i.encounter_id, ${PN} AS pname, d.name AS dep_name, count(*)::int AS n, min(i.ordered_at) AS first, array_agg(sv.name ORDER BY i.ordered_at) AS names, bool_or(i.priority = 'urgent') AS urgent
          FROM ${ITEMS}
         WHERE i.status IN ('ordered', 'scheduled') AND i.ordered_by = ${me} AND e.type = 'outpatient' AND e.visit_kind = 'consultation' AND e.status <> 'cancelled'
           AND i.ordered_at < now() - make_interval(days => ${days}::int) AND i.ordered_at > now() - interval '90 days'
         GROUP BY i.encounter_id, p.last_name, p.first_name, d.name ORDER BY min(i.ordered_at) LIMIT ${LIMIT}`.execute(this.db);
      for (const a of r.rows) out.push({ id: a.encounter_id, source: 'amb_dx_pending', title: `დანიშნული კვლევა არ ჩატარებულა: ${a.n} — ${a.pname}`, detail: names(a.names), patient: a.pname,
        department: a.dep_name, due_at: plus(a.first, days * 1440), priority: a.urgent ? 'high' : 'normal', link: `/encounters/${a.encounter_id}`, created_at: a.first });
    }
    if (c.has('ref_todo') && has(x.u, 'receptionist', 'diagnostic')) {
      const due = s.ref_due_days ?? WL_DEFAULTS.ref_due_days;
      const reg = has(x.u, 'receptionist') ? await x.x.regDepts() : undefined;
      const regCond = reg === undefined ? sql`FALSE` : reg === null ? sql`TRUE`
        : sql`(r.target_department_id = ANY (${uuids(reg)}::uuid[]) OR e.department_id = ANY (${uuids(reg)}::uuid[]))`;
      const me2 = await x.x.me();
      const diag = has(x.u, 'diagnostic');
      // diagnostic: სამიზნე განყოფილების diagnostic-ები; სამიზნე არ არის / იქ diagnostic არავინაა — ყველა
      const diagCond = !diag ? sql`FALSE` : sql`(r.target_department_id IS NULL OR r.target_department_id = ${me2.department_id ?? NIL}::uuid
        OR NOT EXISTS (SELECT 1 FROM users du JOIN user_capabilities dc ON dc.user_id = du.id WHERE du.is_active AND du.department_id = r.target_department_id AND 'diagnostic' = ANY (dc.capabilities)))`;
      const r = await sql<{ id: string; type: string; status: string; reason: string; created_at: Date; pname: string; target: string | null; by: string }>`
        SELECT r.id, r.type::text AS type, r.status::text AS status, r.reason, r.created_at, ${PN} AS pname, td.name AS target, ru.last_name || ' ' || ru.first_name AS by
          FROM referrals r JOIN encounters e ON e.id = r.encounter_id JOIN patients p ON p.id = e.patient_id LEFT JOIN departments td ON td.id = r.target_department_id
          JOIN users ru ON ru.id = r.requested_by
         WHERE r.status IN ('requested', 'in_progress') AND e.status <> 'cancelled'
           AND ((r.type = 'hospitalization' AND ${regCond}) OR (r.type <> 'hospitalization' AND ${diagCond}))
         ORDER BY r.created_at LIMIT ${LIMIT}`.execute(this.db);
      for (const a of r.rows) out.push({ id: a.id, source: 'ref_todo', title: `მიმართვა — ${REF_KA[a.type] ?? a.type}: ${a.pname}`, detail: `${a.target ? `${a.target} · ` : ''}${a.by}: ${a.reason.slice(0, 140)}`,
        patient: a.pname, department: a.target, due_at: plus(a.created_at, due * 1440), priority: 'normal',
        link: a.type === 'hospitalization' ? '/inpatient' : '/diagnostics/referrals', created_at: a.created_at });
    }
    return out;
  }
}
