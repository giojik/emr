import { Injectable } from '@nestjs/common';
import { sql, type RawBuilder } from 'kysely';
import { has, type AuthUser } from '../auth/roles';
import { InjectDb, type Database } from '../database/database.module';
import { abxPolicy } from '../ipc/ipc-common';
import { OrService } from '../or/or';
import { OR_SETTINGS_0049, OR_SETTINGS_0050 } from '../or/or-shared';
import { TZ, WL_DEFAULTS, type ObsKey, type Priority } from './worklist-common';
import type { AdminCtx, Row, SourceGroup } from './worklist-sources-admin';

/**
 * სამუშაო სიები (D5), 0083 — კლინიკური წყაროები (ექიმი / ექთანი). ვირტუალური, როგორც 0081 / 0082: ჩანაწერი ყოველ ჯერზე წყაროს ცხრილიდან ითვლება,
 * საქმის დასრულებისას თავისით ქრება. admin პასუხისმგებლობას არ ქმნის (0081).
 *
 * მფლობელები:
 *  • ექიმის საქმე — მკურნალი ექიმი (attending). არ არის / არააქტიურია → განყოფილების ხელმძღვანელი ექიმი (is_section_head / manager);
 *    ხელმძღვანელიც არ არის → განყოფილების ექიმები. „განყოფილება“ — ჰოსპიტალიზაციის მიმდინარე (ბოლო) საწოლის განყოფილება.
 *  • ექთნის შესასრულებელი საქმე (MAR, შკალები, ვიტალები, გადაბარება, ICU) — განყოფილების ექთნები (nurse_scope):
 *    department — users.department_id (მოდულის isStaff-ის წესი); on_shift — ახლა ამ განყოფილებაში ცვლაში (D4); ცვლაში ექთანი არავინაა / roster გამორთულია → department.
 *    B1 (dept_side) აქ არ ვრცელდება.
 *  • განყოფილების გადაწყვეტილება (გადმოყვანა, საოპერაციო მზადყოფნა) — B1 (dept_side).
 *  • C1 — MAR / შკალები — ერთი ჩანაწერი პაციენტზე.
 */

const LIMIT = 200;
const NIL = '00000000-0000-0000-0000-000000000000';
const uuids = (xs: Iterable<string>) => { const a = [...xs]; return a.length ? a : [NIL]; };
const plus = (d: Date | string | null | undefined, min: number) => (d ? new Date(new Date(d).getTime() + min * 60_000) : null);
const fmtDay = (d: string) => d.split('-').reverse().join('.');

/** ჰოსპიტალიზაციის მიმდინარე (ბოლო, გაუქმებულის გარეშე) საწოლის განყოფილება — orders.ts-ის წესი */
const DEP = sql<string>`coalesce((SELECT a.department_id FROM bed_assignments a WHERE a.encounter_id = st.encounter_id AND a.end_kind IS DISTINCT FROM 'cancel'
  ORDER BY (a.ended_at IS NULL) DESC, a.started_at DESC, a.id DESC LIMIT 1), e.department_id)`;
/** ჰოსპიტალიზაციები (ქვე-მოთხოვნა) — s.*: encounter_id, patient_id, adm_no, status, admitted_at, ended_at, closed_at, discharge_type, att, att_active, pname, adult, dep, dep_name, care_level */
const stays = (where: RawBuilder<unknown>) => sql`(SELECT st.encounter_id, st.patient_id, st.adm_no, st.status, st.admitted_at, st.ended_at, st.closed_at, st.discharge_type,
    e.attending_doctor_id AS att, coalesce(au.is_active, FALSE) AS att_active, p.last_name || ' ' || p.first_name AS pname,
    (p.birth_date <= (now() AT TIME ZONE ${TZ})::date - interval '16 years') AS adult, x.dep, d.name AS dep_name, d.care_level, d.icu_features
  FROM inpatient_stays st JOIN encounters e ON e.id = st.encounter_id JOIN patients p ON p.id = st.patient_id LEFT JOIN users au ON au.id = e.attending_doctor_id
  CROSS JOIN LATERAL (SELECT ${DEP} AS dep) x JOIN departments d ON d.id = x.dep
 WHERE ${where})`;
const ON_LEAVE = sql<boolean>`EXISTS (SELECT 1 FROM inpatient_leaves l WHERE l.encounter_id = s.encounter_id AND l.returned_at IS NULL)`;
const who = (s: { pname: string; adm_no: string }) => `${s.pname} (${s.adm_no})`;
const stayLink = (enc: string, hash = '') => `/inpatient/stay/${enc}${hash}`;

type IpdS = {
  admission_note_hours?: number; progress_note_daily?: boolean; progress_reminder_time?: string; docs_pending_alert_hours?: number; epicrisis_cosign?: boolean;
  verbal_confirm_hours?: number; transfer_wait_hours?: number; mar_window_min?: number; med_verifier?: 'pharmacist' | 'head_nurse' | 'both';
  news2_enabled?: boolean; news2_alert?: number; news2_urgent?: number; line_alert_hours?: Record<string, number>;
};
type IcuS = { monitor_gap_hours?: number; bundle_reminder_time?: string; sofa_reminder_time?: string; news2_alerts?: boolean; intensive_features?: string[] };
const ICU_ALL = ['sheet', 'ventilation', 'infusions', 'sofa', 'apache', 'abg', 'bundles', 'icu_note', 'board'];
const icuFeat = (s: IcuS, level: string, own: string[] | null) => (level === 'ward' ? [] : own ?? (level === 'icu' ? ICU_ALL : s.intensive_features ?? []));
const LINE_KA: Record<string, string> = { pvc: 'პერიფერიული კათეტერი', cvc: 'ცენტრალური კათეტერი', picc: 'PICC', arterial: 'არტერიული ხაზი', urinary: 'შარდის კათეტერი',
  ng_tube: 'ნაზოგასტრული ზონდი', drain: 'დრენაჟი', trach: 'ტრაქეოსტომა', dialysis: 'დიალიზის კათეტერი', other: 'სხვა' };
const URG: Record<string, Priority> = { emergency: 'urgent', urgent: 'high', routine: 'normal', elective: 'normal' };

/** ერთი მოთხოვნის კლინიკური კონტექსტი (memo — AdminCtx-ის თავზე) */
class ClinCtx {
  private memo = new Map<string, Promise<unknown>>();
  constructor(readonly db: Database, readonly u: AuthUser, readonly x: AdminCtx) {}
  private m<T>(k: string, f: () => Promise<T>): Promise<T> {
    if (!this.memo.has(k)) this.memo.set(k, f());
    return this.memo.get(k) as Promise<T>;
  }
  ipd() { return this.x.modSettings('inpatient') as Promise<IpdS>; }
  icu() { return this.x.modSettings('icu') as Promise<IcuS>; }
  /** მიმდინარე დღე / დრო კლინიკის დროით */
  now() {
    return this.m('now', async () => (await sql<{ d: string; t: string }>`SELECT to_char(now() AT TIME ZONE ${TZ}, 'YYYY-MM-DD') AS d, to_char(now() AT TIME ZONE ${TZ}, 'HH24:MI') AS t`.execute(this.db)).rows[0]);
  }
  /** ამ დღის HH:MI კლინიკის დროით */
  async at(hhmm: string) {
    const d = (await this.now()).d;
    return (await sql<{ x: Date }>`SELECT (${d}::date + ${hhmm}::time) AT TIME ZONE ${TZ} AS x`.execute(this.db)).rows[0].x;
  }
  isDoctor() { return has(this.u, 'doctor'); }
  isNurse() { return has(this.u, 'nurse'); }
  /** ხელმძღვანელი ექიმი (ჩემი განყოფილება) — epicrisis / isHead-ის წესი: doctor + (is_section_head / manager) */
  async headDoctor() { return this.isDoctor() && (await this.x.isHead()); }
  /** განყოფილებები, სადაც აქტიური ხელმძღვანელი ექიმი არის */
  headDoctorDepts() {
    return this.m('hdd', async () => new Set((await sql<{ id: string }>`SELECT DISTINCT u.department_id AS id FROM users u JOIN user_capabilities c ON c.user_id = u.id
      WHERE u.is_active AND u.department_id IS NOT NULL AND 'doctor' = ANY (c.capabilities) AND (u.is_section_head OR 'manager' = ANY (c.capabilities))`.execute(this.db)).rows.map((r) => r.id)));
  }
  /** ექიმის საქმის მფლობელი: SQL პირობა s.att / s.att_active / s.dep-ზე */
  async doctorOwner(): Promise<RawBuilder<boolean>> {
    const me = await this.x.me();
    const fb = this.isDoctor() && !!me.department_id;
    const head = await this.headDoctor();
    const hdd = [...(await this.headDoctorDepts())];
    return sql<boolean>`((s.att = ${this.u.id} AND s.att_active) OR (${fb} AND (s.att IS NULL OR NOT s.att_active) AND s.dep = ${me.department_id ?? NIL}::uuid
      AND (${head} OR NOT s.dep = ANY (${uuids(hdd)}::uuid[]))))`;
  }
  /** ექთნის შესასრულებელი საქმის განყოფილებები (nurse_scope) */
  nurseDepts() {
    return this.m('nurse', async () => {
      if (!this.isNurse()) return [] as string[];
      const me = await this.x.me();
      const own = me.department_id ? [me.department_id] : [];
      if (this.x.s.nurse_scope !== 'on_shift') return own;
      const roster = await this.db.selectFrom('system_modules').select('enabled').where('code', '=', 'roster').executeTakeFirst();
      if (!roster?.enabled) return own;
      const SHIFT = sql`FROM roster_entries e JOIN rosters r ON r.id = e.roster_id JOIN staff_members sm ON sm.id = e.staff_id
        WHERE e.status = 'active' AND r.status IN ('published', 'closed') AND e.starts_at <= now() AND e.ends_at > now()`;
      const mine = (await sql<{ id: string }>`SELECT DISTINCT r.department_id AS id ${SHIFT} AND sm.user_id = ${this.u.id}`.execute(this.db)).rows.map((r) => r.id);
      // ჩემს განყოფილებაში ცვლაში ექთანი არავინაა → department (fallback)
      const staffed = own.length ? (await sql<{ n: number }>`SELECT count(*)::int AS n ${SHIFT} AND r.department_id = ${own[0]}
        AND EXISTS (SELECT 1 FROM user_capabilities c JOIN users uu ON uu.id = c.user_id WHERE c.user_id = sm.user_id AND uu.is_active AND 'nurse' = ANY (c.capabilities))`.execute(this.db)).rows[0].n > 0 : true;
      return [...new Set([...mine, ...(staffed ? [] : own)])];
    });
  }
  /** B1 — განყოფილების გადაწყვეტილება: users.department_id-ის განყოფილება (isStaff-ის წესი), dept_side-ით */
  async sideDept(caps: Parameters<typeof has>[1][]): Promise<string | null> {
    if (!has(this.u, ...caps)) return null;
    const me = await this.x.me();
    if (!me.department_id) return null;
    if (this.x.s.dept_side === 'all') return me.department_id;
    const [head, heads] = await Promise.all([this.x.isHead(), this.x.heads()]);
    return head || !heads.has(me.department_id) ? me.department_id : null;
  }
}

@Injectable()
export class WorklistClinicalSources {
  constructor(@InjectDb() private readonly db: Database, private readonly or: OrService) {}

  groups(): SourceGroup[] {
    const c = (f: (cx: ClinCtx, codes: Set<string>) => Promise<Row[]>) => (u: AuthUser, codes: Set<string>, x: AdminCtx) => f(new ClinCtx(this.db, u, x), codes);
    return [
      { module: 'inpatient', codes: ['doc_admission', 'doc_progress', 'doc_draft', 'doc_discharge', 'doc_cosign', 'doc_consent'], fetch: c((x, k) => this.docs(x, k)) },
      { module: 'core', codes: ['amb_open'], fetch: c((x) => this.ambOpen(x)) },
      { module: 'inpatient', codes: ['med_verify', 'med_rejected', 'med_approve', 'med_verbal', 'med_abx_end'], fetch: c((x, k) => this.meds(x, k)) },
      { module: 'inpatient', codes: ['mar_due', 'mar_missed'], fetch: c((x, k) => this.mar(x, k)) },
      { module: 'inpatient', codes: ['consult_todo', 'transfer_in'], fetch: c((x, k) => this.consults(x, k)) },
      { module: 'inpatient', codes: ['nur_scale', 'nur_line', 'nur_handover', 'nur_obs', 'news2_review'], fetch: c((x, k) => this.nursing(x, k)) },
      { module: 'icu', codes: ['icu_sheet', 'icu_bundle', 'icu_sofa'], fetch: c((x, k) => this.icu(x, k)) },
      { module: 'or', codes: ['or_request', 'or_preop', 'or_ready', 'or_docs', 'or_pacu'], fetch: c((x, k) => this.orSources(x, k)) },
    ];
  }

  // ================================================================== დოკუმენტაცია (ექიმი)
  private async docs(x: ClinCtx, c: Set<string>): Promise<Row[]> {
    if (!x.isDoctor()) return [];
    const out: Row[] = [];
    const s = await x.ipd();
    const owner = await x.doctorOwner();
    if (c.has('doc_admission')) {
      const h = s.admission_note_hours ?? 24;
      const r = await sql<{ encounter_id: string; adm_no: string; pname: string; dep_name: string; admitted_at: Date }>`
        SELECT s.encounter_id, s.adm_no, s.pname, s.dep_name, s.admitted_at FROM ${stays(sql`st.status = 'active'`)} s
         WHERE ${owner} AND NOT EXISTS (SELECT 1 FROM doctor_notes n WHERE n.encounter_id = s.encounter_id AND n.kind = 'admission' AND n.status = 'signed')
         ORDER BY s.admitted_at LIMIT ${LIMIT}`.execute(this.db);
      for (const a of r.rows) out.push({ id: a.encounter_id, source: 'doc_admission', title: `მიმღები გასინჯვა — ${who(a)}`, detail: 'ხელმოწერილი მიმღები გასინჯვა არ არის',
        patient: a.pname, department: a.dep_name, due_at: plus(a.admitted_at, h * 60), priority: 'normal', link: stayLink(a.encounter_id, '#notes'), created_at: a.admitted_at });
    }
    if (c.has('doc_progress') && s.progress_note_daily !== false) {
      const due = await x.at(typeof s.progress_reminder_time === 'string' ? s.progress_reminder_time : '12:00');
      const r = await sql<{ encounter_id: string; adm_no: string; pname: string; dep_name: string; d: string }>`
        SELECT s.encounter_id, s.adm_no, s.pname, s.dep_name, to_char((now() AT TIME ZONE ${TZ})::date - 1, 'YYYY-MM-DD') AS d FROM ${stays(sql`st.status = 'active'
          AND (st.admitted_at AT TIME ZONE ${TZ})::date < (now() AT TIME ZONE ${TZ})::date - 1`)} s
         WHERE ${owner} AND NOT EXISTS (SELECT 1 FROM doctor_notes n WHERE n.encounter_id = s.encounter_id AND n.kind IN ('progress', 'icu_daily') AND n.status = 'signed'
           AND n.note_date = (now() AT TIME ZONE ${TZ})::date - 1)
         ORDER BY s.pname LIMIT ${LIMIT}`.execute(this.db);
      for (const a of r.rows) out.push({ id: `${a.encounter_id}:${a.d}`, source: 'doc_progress', title: `დღიური აკლია (${fmtDay(a.d)}) — ${who(a)}`, detail: null,
        patient: a.pname, department: a.dep_name, due_at: due, priority: 'normal', link: stayLink(a.encounter_id, '#notes'), created_at: null });
    }
    if (c.has('doc_draft')) {
      const h = x.x.s.draft_hours ?? WL_DEFAULTS.draft_hours;
      const KIND: Record<string, string> = { admission: 'მიმღები გასინჯვა', progress: 'დღიური', rounds: 'შემოვლა', consult: 'კონსულტაცია', icu_daily: 'ICU დღიური' };
      const r = await sql<{ id: string; kind: string; note_date: string; created_at: Date; encounter_id: string; adm_no: string; pname: string; dep_name: string; amend: boolean }>`
        SELECT n.id, n.kind, to_char(n.note_date, 'YYYY-MM-DD') AS note_date, n.created_at, s.encounter_id, s.adm_no, s.pname, s.dep_name, n.amends_id IS NOT NULL AS amend
          FROM doctor_notes n JOIN ${stays(sql`st.status <> 'cancelled' AND st.encounter_id IN (SELECT dn.encounter_id FROM doctor_notes dn WHERE dn.status = 'draft' AND dn.author_id = ${x.u.id})`)} s ON s.encounter_id = n.encounter_id
         WHERE n.status = 'draft' AND n.author_id = ${x.u.id} AND n.created_at < now() - make_interval(hours => ${h})
         ORDER BY n.created_at LIMIT ${LIMIT}`.execute(this.db);
      for (const n of r.rows) out.push({ id: n.id, source: 'doc_draft', title: `${n.amend ? 'შესწორება' : KIND[n.kind] ?? n.kind} (${fmtDay(n.note_date)}) — ხელმოუწერელი`,
        detail: who(n), patient: n.pname, department: n.dep_name, due_at: null, priority: 'normal', link: stayLink(n.encounter_id, '#notes'), created_at: n.created_at });
    }
    if (c.has('doc_discharge')) {
      const h = s.docs_pending_alert_hours ?? 24;
      const EPI: Record<string, string> = { draft: 'ეპიკრიზი — პროექტი', awaiting_cosign: 'ეპიკრიზი თანახელმოწერას ელოდება', signed: 'ეპიკრიზი ხელმოწერილია — შემთხვევა დასახურია' };
      const DT: Record<string, string> = { home: 'ბინაზე', other_clinic: 'სხვა კლინიკაში', against_advice: 'თვითნებური', death: 'გარდაცვალება' };
      const r = await sql<{ encounter_id: string; adm_no: string; pname: string; dep_name: string; ended_at: Date; discharge_type: string; epi: string | null }>`
        SELECT s.encounter_id, s.adm_no, s.pname, s.dep_name, s.ended_at, s.discharge_type, (SELECT ep.status FROM epicrises ep WHERE ep.encounter_id = s.encounter_id) AS epi
          FROM ${stays(sql`st.status = 'discharged' AND st.closed_at IS NULL`)} s WHERE ${owner} ORDER BY s.ended_at LIMIT ${LIMIT}`.execute(this.db);
      for (const a of r.rows) out.push({ id: a.encounter_id, source: 'doc_discharge', title: `გაწერილი — დოკუმენტაცია დაუხურავია: ${who(a)}`,
        detail: `${DT[a.discharge_type] ?? a.discharge_type} · ${a.epi ? EPI[a.epi] ?? a.epi : 'ეპიკრიზი არ არის'}`, patient: a.pname, department: a.dep_name,
        due_at: plus(a.ended_at, h * 60), priority: ['against_advice', 'death'].includes(a.discharge_type) ? 'high' : 'normal', link: stayLink(a.encounter_id, '#epicrisis'), created_at: a.ended_at });
    }
    if (c.has('doc_cosign') && (await x.headDoctor())) {
      const me = await x.x.me();
      const r = await sql<{ encounter_id: string; adm_no: string; pname: string; dep_name: string; signed_at: Date; signer: string }>`
        SELECT s.encounter_id, s.adm_no, s.pname, s.dep_name, ep.signed_at, su.last_name || ' ' || su.first_name AS signer
          FROM epicrises ep JOIN ${stays(sql`st.encounter_id IN (SELECT e2.encounter_id FROM epicrises e2 WHERE e2.status = 'awaiting_cosign')`)} s ON s.encounter_id = ep.encounter_id JOIN users su ON su.id = ep.signed_by
         WHERE ep.status = 'awaiting_cosign' AND ep.signed_by <> ${x.u.id} AND s.dep = ${me.department_id ?? NIL}::uuid ORDER BY ep.signed_at LIMIT ${LIMIT}`.execute(this.db);
      for (const a of r.rows) out.push({ id: a.encounter_id, source: 'doc_cosign', title: `ეპიკრიზი — თანახელმოწერა: ${who(a)}`, detail: `ხელი მოაწერა: ${a.signer}`,
        patient: a.pname, department: a.dep_name, due_at: x.x.sla('doc_cosign', a.signed_at), priority: 'normal', link: stayLink(a.encounter_id, '#epicrisis'), created_at: a.signed_at });
    }
    if (c.has('doc_consent')) {
      const r = await sql<{ encounter_id: string; adm_no: string; pname: string; dep_name: string; admitted_at: Date; missing: string[] }>`
        SELECT * FROM (SELECT s.encounter_id, s.adm_no, s.pname, s.dep_name, s.admitted_at,
               ARRAY(SELECT t.name FROM document_templates t WHERE t.required_on_admission AND t.is_active AND NOT EXISTS (
                 SELECT 1 FROM patient_consents pc WHERE pc.type_code = t.code AND pc.patient_id = s.patient_id AND (t.scope = 'patient' OR pc.encounter_id = s.encounter_id)
                   AND pc.decision = 'granted' AND pc.revoked_at IS NULL) ORDER BY t.sort_order) AS missing
          FROM ${stays(sql`st.status = 'active'`)} s WHERE ${owner}) q WHERE cardinality(q.missing) > 0 ORDER BY q.admitted_at LIMIT ${LIMIT}`.execute(this.db);
      for (const a of r.rows) out.push({ id: a.encounter_id, source: 'doc_consent', title: `თანხმობა აკლია — ${who(a)}`, detail: a.missing.join('; '),
        patient: a.pname, department: a.dep_name, due_at: plus(a.admitted_at, 24 * 60), priority: 'high', link: stayLink(a.encounter_id), created_at: a.admitted_at });
    }
    return out;
  }

  // ================================================================== ამბულატორია: დაუხურავი ვიზიტი
  private async ambOpen(x: ClinCtx): Promise<Row[]> {
    if (!x.isDoctor()) return [];
    const days = x.x.s.amb_open_days ?? WL_DEFAULTS.amb_open_days;
    const r = await sql<{ id: string; start_time: Date; pname: string; dep: string | null; due: Date }>`
      SELECT e.id, e.start_time, p.last_name || ' ' || p.first_name AS pname, d.name AS dep,
             (((e.start_time AT TIME ZONE ${TZ})::date + 1)::timestamp AT TIME ZONE ${TZ}) - interval '1 second' AS due
        FROM encounters e JOIN patients p ON p.id = e.patient_id LEFT JOIN departments d ON d.id = e.department_id
       WHERE e.status = 'active' AND e.type = 'outpatient' AND e.attending_doctor_id = ${x.u.id}
         AND (e.start_time AT TIME ZONE ${TZ})::date < (now() AT TIME ZONE ${TZ})::date
         AND (e.start_time AT TIME ZONE ${TZ})::date >= (now() AT TIME ZONE ${TZ})::date - ${days}::int
       ORDER BY e.start_time LIMIT ${LIMIT}`.execute(this.db);
    return r.rows.map((e) => ({ id: e.id, source: 'amb_open', title: `ამბულატორიული ვიზიტი დაუხურავია — ${e.pname}`, detail: `ვიზიტი: ${new Date(e.start_time).toLocaleDateString('ka-GE', { timeZone: TZ })}`,
      patient: e.pname, department: e.dep, due_at: e.due, due_date_only: true, priority: 'normal' as Priority, link: `/encounters/${e.id}`, created_at: e.start_time }));
  }

  // ================================================================== დანიშნულებები
  private async meds(x: ClinCtx, c: Set<string>): Promise<Row[]> {
    const out: Row[] = [];
    const s = await x.ipd();
    type O = { id: string; encounter_id: string; adm_no: string; pname: string; dep_name: string; dep: string; name: string; created_at: Date; ordered_by: string; risky: boolean;
      verify_note: string | null; end_at: Date | null; verifier: string | null };
    const orders = (where: RawBuilder<unknown>, extra: RawBuilder<unknown> = sql`TRUE`) => sql<O>`
      SELECT o.id, s.encounter_id, s.adm_no, s.pname, s.dep_name, s.dep, coalesce(g.inn, o.drug_text, o.text) AS name, o.created_at, o.ordered_by, o.verify_note, o.end_at,
             (g.id IS NULL OR g.high_alert OR g.controlled_class IS NOT NULL OR o.approval_status <> 'not_required') AS risky,
             vu.last_name || ' ' || vu.first_name AS verifier
        FROM med_orders o JOIN ${stays(sql`st.status = 'active'`)} s ON s.encounter_id = o.encounter_id LEFT JOIN med_generics g ON g.id = o.generic_id
        LEFT JOIN users vu ON vu.id = o.verified_by
       WHERE o.status IN ('active', 'on_hold') AND ${where} AND ${extra} ORDER BY o.created_at LIMIT ${LIMIT}`.execute(this.db);
    const push = (o: O, source: string, title: string, detail: string | null, due: Date | null, priority: Priority) =>
      out.push({ id: o.id, source, title: `${title}: ${o.name}`, detail: detail ? `${who(o)} · ${detail}` : who(o), patient: o.pname, department: o.dep_name, due_at: due, priority,
        link: stayLink(o.encounter_id, '?tab=orders#orders'), created_at: o.created_at });
    if (c.has('med_verify')) {
      // verifierRole (admin-ის გარეშე): pharmacist (mode ≠ head_nurse) — ყველა; head_nurse (mode ≠ pharmacist) — nurse + is_section_head, თავისი განყოფილება
      const mode = s.med_verifier ?? 'both';
      const me = await x.x.me();
      const pharm = has(x.u, 'pharmacist') && mode !== 'head_nurse';
      const headNurse = !pharm && has(x.u, 'nurse') && mode !== 'pharmacist' && !!me.is_section_head && !!me.department_id;
      if (pharm || headNurse) for (const o of (await orders(sql`o.verify_status = 'pending'`, pharm ? sql`TRUE` : sql`s.dep = ${me.department_id}::uuid`)).rows)
        push(o, 'med_verify', 'ვერიფიკაცია', null, x.x.sla('med_verify', o.created_at), o.risky ? 'high' : 'normal');
    }
    if (c.has('med_rejected')) for (const o of (await orders(sql`o.verify_status = 'rejected' AND o.ordered_by = ${x.u.id}`)).rows)
      push(o, 'med_rejected', 'ვერიფიკაციაზე უარი', `${o.verifier ?? ''}: ${o.verify_note ?? ''}`, null, 'high');
    if (c.has('med_approve')) {
      // canApprove (admin-ის გარეშე): abx_approver — department (ფარმაცევტი + განყოფილების ხელმძღვანელი ექიმი) / ipc (infection) / both (ყველა)
      const pol = await abxPolicy(this.db);
      const me = await x.x.me();
      const all = (pol.approver !== 'department' && has(x.u, 'infection')) || (pol.approver !== 'ipc' && has(x.u, 'pharmacist'));
      const head = pol.approver !== 'ipc' && x.isDoctor() && !!me.is_section_head && !!me.department_id;
      if (all || head) for (const o of (await orders(sql`o.approval_status = 'pending'`, all ? sql`TRUE` : sql`s.dep = ${me.department_id}::uuid`)).rows)
        push(o, 'med_approve', 'ანტიბიოტიკის დამტკიცება', null, x.x.sla('med_approve', o.created_at), 'high');
    }
    if (c.has('med_verbal')) {
      const h = s.verbal_confirm_hours ?? 24;
      for (const o of (await orders(sql`o.is_verbal AND o.verbal_confirmed_at IS NULL AND o.ordered_by = ${x.u.id}`)).rows)
        push(o, 'med_verbal', 'ზეპირი დანიშნულება — დაადასტურეთ', null, plus(o.created_at, h * 60), 'high');
    }
    if (c.has('med_abx_end') && x.isDoctor()) {
      const owner = await x.doctorOwner();
      for (const o of (await orders(sql`g.atc_code LIKE 'J01%' AND o.end_at IS NOT NULL AND o.end_at > now() AND o.end_at < now() + interval '24 hours'`,
        sql`(o.ordered_by = ${x.u.id} OR ${owner})`)).rows)
        push(o, 'med_abx_end', 'ანტიბიოტიკი სრულდება — გააგრძელეთ / დაასრულეთ', null, o.end_at, 'normal');
    }
    return out;
  }

  // ================================================================== MAR (C1 — პაციენტზე)
  private async mar(x: ClinCtx, c: Set<string>): Promise<Row[]> {
    const deps = await x.nurseDepts();
    if (!deps.length) return [];
    const s = await x.ipd();
    const win = s.mar_window_min ?? 60;
    const ahead = x.x.s.mar_due_ahead_min ?? WL_DEFAULTS.mar_due_ahead_min;
    const out: Row[] = [];
    const q = (cond: RawBuilder<unknown>) => sql<{ encounter_id: string; adm_no: string; pname: string; dep_name: string; n: number; first: Date; names: string[] }>`
      SELECT s.encounter_id, s.adm_no, s.pname, s.dep_name, count(*)::int AS n, min(m.scheduled_at) AS first,
             (array_agg(DISTINCT coalesce(g.inn, o.drug_text, o.text)))[1:4] AS names
        FROM mar_entries m JOIN med_orders o ON o.id = m.order_id LEFT JOIN med_generics g ON g.id = o.generic_id
        JOIN ${stays(sql`st.status = 'active'`)} s ON s.encounter_id = m.encounter_id
       WHERE m.voided_at IS NULL AND m.scheduled_at IS NOT NULL AND s.dep = ANY (${uuids(deps)}::uuid[]) AND NOT ${ON_LEAVE} AND ${cond}
       GROUP BY s.encounter_id, s.adm_no, s.pname, s.dep_name ORDER BY min(m.scheduled_at) LIMIT ${LIMIT}`.execute(this.db);
    if (c.has('mar_due')) for (const r of (await q(sql`m.status = 'due' AND m.scheduled_at >= now() - make_interval(mins => ${win})
        AND m.scheduled_at <= now() + make_interval(mins => ${ahead})`)).rows)
      out.push({ id: r.encounter_id, source: 'mar_due', title: `MAR: ${r.n} დოზა — ${who(r)}`, detail: r.names.join(', '), patient: r.pname, department: r.dep_name,
        due_at: plus(r.first, win), priority: 'normal', link: stayLink(r.encounter_id, '#mar'), created_at: r.first });
    if (c.has('mar_missed')) for (const r of (await q(sql`m.scheduled_at > now() - interval '24 hours'
        AND (m.status = 'missed' OR (m.status = 'due' AND m.scheduled_at < now() - make_interval(mins => ${win})))`)).rows)
      out.push({ id: r.encounter_id, source: 'mar_missed', title: `MAR: ვადაგადაცილებული / გამოტოვებული ${r.n} — ${who(r)}`, detail: r.names.join(', '), patient: r.pname,
        department: r.dep_name, due_at: plus(r.first, win), priority: 'urgent', link: stayLink(r.encounter_id, '#mar'), created_at: r.first });
    return out;
  }

  // ================================================================== კონსულტაცია / გადაყვანა
  private async consults(x: ClinCtx, c: Set<string>): Promise<Row[]> {
    const out: Row[] = [];
    const me = await x.x.me();
    if (c.has('consult_todo') && x.isDoctor()) {
      // სამიზნე ექიმი; განყოფილებაზე — მისი ექიმები (users.department_id); სასწრაფო + roster.link_consult = duty — მხოლოდ ცვლაში მყოფი ექიმები (თუ ვინმეა)
      const ro = await this.db.selectFrom('system_modules').select(['enabled', 'settings']).where('code', '=', 'roster').executeTakeFirst();
      const duty = !!ro?.enabled && (ro.settings as Record<string, unknown>)?.link_consult === 'duty';
      const ONSHIFT = (dep: RawBuilder<unknown>, user: RawBuilder<unknown>) => sql`EXISTS (SELECT 1 FROM roster_entries re JOIN rosters r ON r.id = re.roster_id
        JOIN staff_members sm ON sm.id = re.staff_id LEFT JOIN staff_positions sp ON sp.id = sm.position_id
        WHERE re.status = 'active' AND r.status IN ('published', 'closed') AND re.starts_at <= now() AND re.ends_at > now() AND r.department_id = ${dep}
          AND sp.category = 'doctor' AND sm.user_id IS NOT NULL AND ${user})`;
      const r = await sql<{ id: string; urgency: string; question: string; due_at: Date; created_at: Date; encounter_id: string; adm_no: string; pname: string; from_dep: string; by: string }>`
        SELECT k.id, k.urgency, k.question, k.due_at, k.created_at, s.encounter_id, s.adm_no, s.pname, s.dep_name AS from_dep, ru.last_name || ' ' || ru.first_name AS by
          FROM consultations k JOIN ${stays(sql`st.status = 'active'`)} s ON s.encounter_id = k.encounter_id JOIN users ru ON ru.id = k.requested_by
         WHERE k.status = 'requested' AND (k.target_doctor_id = ${x.u.id}
            OR (k.target_doctor_id IS NULL AND k.target_department_id = ${me.department_id ?? NIL}::uuid AND k.requested_by <> ${x.u.id}
                AND (NOT ${duty} OR k.urgency = 'routine' OR ${ONSHIFT(sql`k.target_department_id`, sql`sm.user_id = ${x.u.id}`)}
                     OR NOT ${ONSHIFT(sql`k.target_department_id`, sql`sm.user_id <> k.requested_by`)})))
         ORDER BY k.due_at LIMIT ${LIMIT}`.execute(this.db);
      for (const k of r.rows) out.push({ id: k.id, source: 'consult_todo', title: `კონსულტაცია — ${who(k)}`, detail: `${k.from_dep} · ${k.by}: ${k.question.slice(0, 140)}`,
        patient: k.pname, department: k.from_dep, due_at: k.due_at, priority: URG[k.urgency] ?? 'normal', link: '/inpatient?tab=consults', created_at: k.created_at });
    }
    if (c.has('transfer_in')) {
      const dep = await x.sideDept(['nurse', 'doctor', 'manager']);
      if (dep) {
        const h = (await x.ipd()).transfer_wait_hours ?? 2;
        const r = await sql<{ id: string; reason: string; requested_at: Date; encounter_id: string; adm_no: string; pname: string; from_dep: string; to_dep: string }>`
          SELECT t.id, t.reason, t.requested_at, s.encounter_id, s.adm_no, s.pname, fd.name AS from_dep, td.name AS to_dep
            FROM inpatient_transfers t JOIN ${stays(sql`st.status = 'active'`)} s ON s.encounter_id = t.encounter_id
            JOIN departments fd ON fd.id = t.from_department_id JOIN departments td ON td.id = t.to_department_id
           WHERE t.status = 'requested' AND t.to_department_id = ${dep}::uuid ORDER BY t.requested_at LIMIT ${LIMIT}`.execute(this.db);
        for (const t of r.rows) out.push({ id: t.id, source: 'transfer_in', title: `გადმოყვანა: ${t.from_dep} → ${t.to_dep} — ${who(t)}`, detail: t.reason, patient: t.pname,
          department: t.to_dep, due_at: plus(t.requested_at, h * 60), priority: 'high', link: stayLink(t.encounter_id), created_at: t.requested_at });
      }
    }
    return out;
  }

  // ================================================================== საექთნო / NEWS2
  private async nursing(x: ClinCtx, c: Set<string>): Promise<Row[]> {
    const out: Row[] = [];
    const s = await x.ipd();
    const deps = await x.nurseDepts();
    const inDeps = sql`s.dep = ANY (${uuids(deps)}::uuid[])`;
    if (c.has('nur_scale') && deps.length) {
      // სავალდებულო შკალა: ბოლო + reassess_hours (პირველი — შემოსვლიდან 24 სთ); ჩანს ვადამდე 2 სთ-ით ადრე
      const r = await sql<{ encounter_id: string; adm_no: string; pname: string; dep_name: string; first: Date; names: string[]; overdue: number }>`
        SELECT s.encounter_id, s.adm_no, s.pname, s.dep_name, min(y.due_at) AS first, array_agg(d.name ORDER BY y.due_at) AS names, count(*) FILTER (WHERE y.due_at < now())::int AS overdue
          FROM ${stays(sql`st.status = 'active'`)} s CROSS JOIN scale_defs d
          CROSS JOIN LATERAL (SELECT coalesce((SELECT max(sa.assessed_at) + make_interval(hours => d.reassess_hours) FROM scale_assessments sa
              WHERE sa.encounter_id = s.encounter_id AND sa.scale_code = d.code AND sa.voided_at IS NULL), s.admitted_at + interval '24 hours') AS due_at) y
         WHERE d.required AND d.is_active AND d.reassess_hours IS NOT NULL AND y.due_at < now() + interval '2 hours' AND ${inDeps} AND NOT ${ON_LEAVE}
         GROUP BY s.encounter_id, s.adm_no, s.pname, s.dep_name ORDER BY min(y.due_at) LIMIT ${LIMIT}`.execute(this.db);
      for (const a of r.rows) out.push({ id: a.encounter_id, source: 'nur_scale', title: `შეფასება: ${a.names.join(', ')} — ${who(a)}`,
        detail: a.overdue ? `ვადაგადაცილებული: ${a.overdue}` : 'ვადა 2 სთ-ში', patient: a.pname, department: a.dep_name, due_at: a.first, priority: 'normal',
        link: stayLink(a.encounter_id, '#nursing'), created_at: null });
    }
    if (c.has('nur_line') && (deps.length || x.isDoctor())) {
      const cfg = Object.fromEntries(Object.entries(s.line_alert_hours ?? {}).filter(([, h]) => Number(h) > 0));
      if (Object.keys(cfg).length) {
        const rv = x.x.s.line_review_hours ?? WL_DEFAULTS.line_review_hours;
        const owner = x.isDoctor() ? await x.doctorOwner() : sql<boolean>`FALSE`;
        const r = await sql<{ id: string; kind: string; site: string | null; inserted_at: Date; reviewed_at: Date | null; due: Date; encounter_id: string; adm_no: string; pname: string; dep_name: string; days: number }>`
          SELECT l.id, l.kind, l.site, l.inserted_at, l.reviewed_at, s.encounter_id, s.adm_no, s.pname, s.dep_name,
                 floor(extract(epoch FROM now() - l.inserted_at) / 86400)::int AS days,
                 greatest(l.inserted_at + make_interval(hours => cfg.h::int), coalesce(l.reviewed_at + make_interval(hours => ${rv}), '-infinity')) AS due
            FROM lines_drains l JOIN ${stays(sql`st.status = 'active'`)} s ON s.encounter_id = l.encounter_id
            JOIN (SELECT k, h FROM jsonb_each_text(${JSON.stringify(cfg)}::jsonb) AS t(k, h)) cfg ON cfg.k = l.kind
           WHERE l.removed_at IS NULL AND l.voided_at IS NULL AND l.inserted_at < now() - make_interval(hours => cfg.h::int)
             AND (l.reviewed_at IS NULL OR l.reviewed_at < now() - make_interval(hours => ${rv})) AND (${inDeps} OR ${owner})
           ORDER BY l.inserted_at LIMIT ${LIMIT}`.execute(this.db);
        for (const l of r.rows) out.push({ id: l.id, source: 'nur_line', title: `${LINE_KA[l.kind] ?? l.kind} ${l.days} დღე — საჭიროების შეფასება: ${who(l)}`,
          detail: [l.site, l.reviewed_at ? `ბოლო შეფასება: ${new Date(l.reviewed_at).toLocaleString('ka-GE', { timeZone: TZ })}` : null].filter(Boolean).join(' · ') || null,
          patient: l.pname, department: l.dep_name, due_at: l.due, priority: ['cvc', 'picc', 'urinary', 'dialysis'].includes(l.kind) ? 'high' : 'normal',
          link: stayLink(l.encounter_id, '#nursing'), created_at: l.inserted_at });
      }
    }
    if (c.has('nur_handover') && deps.length) {
      const r = await sql<{ id: string; shift_start: Date; created_at: Date; encounter_id: string; adm_no: string; pname: string; dep_name: string; author: string }>`
        SELECT n.id, n.shift_start, n.created_at, s.encounter_id, s.adm_no, s.pname, s.dep_name, au.last_name || ' ' || au.first_name AS author
          FROM nursing_notes n JOIN ${stays(sql`st.status = 'active'`)} s ON s.encounter_id = n.encounter_id JOIN users au ON au.id = n.author_id
         WHERE n.kind = 'handover' AND n.ack_at IS NULL AND n.voided_at IS NULL AND n.author_id <> ${x.u.id} AND n.shift_start > now() - interval '24 hours' AND ${inDeps}
         ORDER BY n.shift_start LIMIT ${LIMIT}`.execute(this.db);
      for (const n of r.rows) out.push({ id: n.id, source: 'nur_handover', title: `ცვლის გადაბარება — მიიღეთ: ${who(n)}`, detail: `აბარებს: ${n.author}`,
        patient: n.pname, department: n.dep_name, due_at: n.shift_start, priority: 'normal', link: stayLink(n.encounter_id, '#nursing'), created_at: n.created_at });
    }
    // NEWS2: რეანიმაცია / ინტენსიური — ჩახშობილია, თუ icu ჩართულია და icu.news2_alerts ≠ true (ზარის წესი)
    if ((c.has('nur_obs') || c.has('news2_review')) && s.news2_enabled !== false) {
      const icuMod = await this.db.selectFrom('system_modules').select(['enabled', 'settings']).where('code', '=', 'icu').executeTakeFirst();
      const muteIcu = !!icuMod?.enabled && (icuMod.settings as Record<string, unknown>)?.news2_alerts !== true;
      const ward = muteIcu ? sql`s.care_level = 'ward'` : sql`TRUE`;
      const LAST = sql`(SELECT v.id, v.news2, v.news2_level, v.recorded_at FROM encounter_vitals v WHERE v.encounter_id = s.encounter_id AND v.voided_at IS NULL AND v.news2 IS NOT NULL
        ORDER BY v.recorded_at DESC LIMIT 1)`;
      if (c.has('nur_obs') && deps.length) {
        const o = { ...WL_DEFAULTS.obs_minutes, ...(x.x.s.obs_minutes ?? {}) };
        const r = await sql<{ encounter_id: string; adm_no: string; pname: string; dep_name: string; admitted_at: Date; score: number | null; level: string | null; recorded_at: Date | null }>`
          SELECT s.encounter_id, s.adm_no, s.pname, s.dep_name, s.admitted_at, v.news2 AS score, v.news2_level AS level, v.recorded_at
            FROM ${stays(sql`st.status = 'active'`)} s LEFT JOIN LATERAL ${LAST} v ON TRUE
           WHERE s.adult AND ${inDeps} AND ${ward} AND NOT ${ON_LEAVE} LIMIT 1000`.execute(this.db);
        const now = Date.now();
        for (const a of r.rows) {
          const key: ObsKey = a.score == null ? 'zero' : a.level === 'high' ? 'high' : a.level === 'medium' ? 'medium' : a.level === 'low_red' ? 'low_red' : a.score === 0 ? 'zero' : 'low';
          const due = a.recorded_at ? plus(a.recorded_at, o[key])! : plus(a.admitted_at, 60)!;
          if (due.getTime() > now) continue;
          out.push({ id: a.encounter_id, source: 'nur_obs', title: `ვიტალური ნიშნები — ${who(a)}`,
            detail: a.recorded_at ? `ბოლო NEWS2 ${a.score} · ყოველ ${o[key] >= 60 ? `${o[key] / 60} სთ` : `${o[key]} წთ`}` : 'NEWS2 ჯერ არ გაზომილა',
            patient: a.pname, department: a.dep_name, due_at: due, priority: key === 'high' ? 'urgent' : key === 'medium' || key === 'low_red' ? 'high' : 'normal',
            link: stayLink(a.encounter_id, '#nursing'), created_at: a.recorded_at });
          if (out.filter((i) => i.source === 'nur_obs').length >= LIMIT) break;
        }
      }
      if (c.has('news2_review') && x.isDoctor()) {
        const alert = s.news2_alert ?? 5; const urgent = s.news2_urgent ?? 7;
        const rm = { ...WL_DEFAULTS.news2_review_min, ...(x.x.s.news2_review_min ?? {}) };
        const owner = await x.doctorOwner();
        const head = await x.headDoctor();
        const me = await x.x.me();
        // შეფასებულია: ამ გაზომვაზე / მის შემდეგ, ან ბოლო 4 სთ-ში იმავე ან უფრო მაღალ დონეზე (ზარის 4-საათიანი წესი)
        const r = await sql<{ encounter_id: string; adm_no: string; pname: string; dep_name: string; vid: string; score: number; level: string; recorded_at: Date }>`
          SELECT s.encounter_id, s.adm_no, s.pname, s.dep_name, v.id AS vid, v.news2 AS score, v.news2_level AS level, v.recorded_at
            FROM ${stays(sql`st.status = 'active'`)} s JOIN LATERAL ${LAST} v ON TRUE
           WHERE ${ward} AND (v.news2 >= ${alert} OR v.news2_level IN ('low_red', 'medium', 'high'))
             AND (${owner} OR (v.news2 >= ${urgent} AND ${head} AND s.dep = ${me.department_id ?? NIL}::uuid))
             AND NOT EXISTS (SELECT 1 FROM news2_reviews nr WHERE nr.encounter_id = s.encounter_id AND (nr.vitals_id = v.id OR nr.reviewed_at >= v.recorded_at
               OR (nr.reviewed_at > v.recorded_at - interval '4 hours' AND (CASE nr.level WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low_red' THEN 1 ELSE 0 END)
                   >= (CASE v.news2_level WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low_red' THEN 1 ELSE 0 END))))
           ORDER BY v.news2 DESC, v.recorded_at LIMIT ${LIMIT}`.execute(this.db);
        for (const a of r.rows) {
          const u = a.score >= urgent;
          out.push({ id: a.vid, source: 'news2_review', title: `NEWS2 ${a.score} — ექიმის შეფასება: ${who(a)}`,
            detail: `${({ low: 'დაბალი', low_red: 'ერთ პარამეტრზე 3', medium: 'საშუალო', high: 'მაღალი' } as Record<string, string>)[a.level] ?? a.level} რისკი`,
            patient: a.pname, department: a.dep_name, due_at: plus(a.recorded_at, u ? rm.urgent : rm.alert), priority: u ? 'urgent' : 'high',
            link: stayLink(a.encounter_id, '#nursing'), created_at: a.recorded_at });
        }
      }
    }
    return out;
  }

  // ================================================================== ICU
  private async icu(x: ClinCtx, c: Set<string>): Promise<Row[]> {
    const nurse = await x.nurseDepts();
    const doctor = x.isDoctor();
    if (!nurse.length && !doctor) return [];
    const s = await x.icu();
    const owner = doctor ? await x.doctorOwner() : sql<boolean>`FALSE`;
    const me = await x.x.me();
    const r = await sql<{ encounter_id: string; adm_no: string; pname: string; dep_name: string; dep: string; care_level: string; icu_features: string[] | null; started_at: Date;
      last_sheet: Date | null; vent: boolean; cl: boolean; bundles: string[]; sofa: boolean; mine_doc: boolean }>`
      SELECT s.encounter_id, s.adm_no, s.pname, s.dep_name, s.dep, s.care_level, s.icu_features, ep.started_at,
             (SELECT max(v.recorded_at) FROM encounter_vitals v WHERE v.encounter_id = s.encounter_id AND v.icu_sheet AND v.voided_at IS NULL) AS last_sheet,
             EXISTS (SELECT 1 FROM icu_ventilation iv WHERE iv.encounter_id = s.encounter_id AND iv.kind = 'invasive' AND iv.ended_at IS NULL AND iv.voided_at IS NULL) AS vent,
             EXISTS (SELECT 1 FROM lines_drains ld WHERE ld.encounter_id = s.encounter_id AND ld.kind IN ('cvc', 'picc') AND ld.removed_at IS NULL AND ld.voided_at IS NULL) AS cl,
             ARRAY(SELECT b.bundle FROM icu_bundle_checks b WHERE b.encounter_id = s.encounter_id AND b.voided_at IS NULL AND b.check_date = (now() AT TIME ZONE ${TZ})::date) AS bundles,
             EXISTS (SELECT 1 FROM icu_scores sc WHERE sc.encounter_id = s.encounter_id AND sc.kind = 'sofa' AND sc.voided_at IS NULL AND sc.score_date = (now() AT TIME ZONE ${TZ})::date) AS sofa,
             (${owner} OR (${doctor} AND s.dep = ${me.department_id ?? NIL}::uuid)) AS mine_doc
        FROM icu_episodes ep JOIN ${stays(sql`st.status = 'active'`)} s ON s.encounter_id = ep.encounter_id
       WHERE ep.ended_at IS NULL AND (s.dep = ANY (${uuids(nurse)}::uuid[]) OR (${doctor} AND (${owner} OR s.dep = ${me.department_id ?? NIL}::uuid)))
       ORDER BY ep.started_at LIMIT ${LIMIT}`.execute(this.db);
    const out: Row[] = [];
    const nurseSet = new Set(nurse);
    const [bundleAt, sofaAt] = await Promise.all([x.at(s.bundle_reminder_time ?? '11:00'), x.at(s.sofa_reminder_time ?? '12:00')]);
    const gap = s.monitor_gap_hours ?? 2;
    for (const e of r.rows) {
      const f = icuFeat(s, e.care_level, e.icu_features);
      const n = nurseSet.has(e.dep);
      if (c.has('icu_sheet') && n && f.includes('sheet')) {
        const due = plus(e.last_sheet ?? e.started_at, gap * 60)!;
        if (due.getTime() < Date.now()) out.push({ id: e.encounter_id, source: 'icu_sheet', title: `მონიტორინგის ფურცელი — ${who(e)}`,
          detail: e.last_sheet ? `ბოლო ჩანაწერი: ${new Date(e.last_sheet).toLocaleTimeString('ka-GE', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })}` : 'ჯერ არ შევსებულა',
          patient: e.pname, department: e.dep_name, due_at: due, priority: 'urgent', link: stayLink(e.encounter_id, '#icu'), created_at: e.last_sheet });
      }
      if (c.has('icu_bundle') && n && f.includes('bundles')) {
        const due = [e.vent && !e.bundles.includes('vap') ? 'VAP' : null, e.cl && !e.bundles.includes('clabsi') ? 'CLABSI' : null].filter(Boolean);
        if (due.length) out.push({ id: e.encounter_id, source: 'icu_bundle', title: `bundle: ${due.join(', ')} — ${who(e)}`, detail: 'დღის შემოწმება',
          patient: e.pname, department: e.dep_name, due_at: bundleAt, priority: 'normal', link: stayLink(e.encounter_id, '#icu'), created_at: null });
      }
      if (c.has('icu_sofa') && e.mine_doc && f.includes('sofa') && !e.sofa && Date.now() - new Date(e.started_at).getTime() > 12 * 3_600_000)
        out.push({ id: e.encounter_id, source: 'icu_sofa', title: `SOFA — ${who(e)}`, detail: 'დღეს არ დადასტურებულა', patient: e.pname, department: e.dep_name,
          due_at: sofaAt, priority: 'normal', link: stayLink(e.encounter_id, '#icu'), created_at: null });
    }
    return out;
  }

  // ================================================================== საოპერაციო / PACU
  private async orSources(x: ClinCtx, c: Set<string>): Promise<Row[]> {
    const out: Row[] = [];
    const s = { or_scheduling: 'coordinator', ...OR_SETTINGS_0049, ...OR_SETTINGS_0050, ...(await x.x.modSettings('or')) } as typeof OR_SETTINGS_0050 & { or_scheduling: string };
    const me = await x.x.me();
    const doctor = x.isDoctor();
    const anesth = has(x.u, 'anesthesiologist');
    const ahead = x.x.s.or_ahead_hours ?? WL_DEFAULTS.or_ahead_hours;
    type C = { id: string; case_no: string; status: string; urgency: string; surgeon_id: string; department_id: string; dep: string; pname: string; surgeon: string; preferred_date: string | null;
      scheduled_start: Date | null; requested_at: Date; anesthesia_type: string; encounter_id: string | null; pref_end: Date | null };
    const cases = (where: RawBuilder<unknown>) => sql<C>`
      SELECT c.id, c.case_no, c.status, c.urgency, c.surgeon_id, c.department_id, d.name AS dep, p.last_name || ' ' || p.first_name AS pname,
             su.last_name || ' ' || su.first_name AS surgeon, to_char(c.preferred_date, 'YYYY-MM-DD') AS preferred_date, c.scheduled_start, c.requested_at, c.anesthesia_type, c.encounter_id,
             ((c.preferred_date + 1)::timestamp AT TIME ZONE ${TZ}) - interval '1 second' AS pref_end
        FROM or_cases c JOIN departments d ON d.id = c.department_id JOIN patients p ON p.id = c.patient_id JOIN users su ON su.id = c.surgeon_id
       WHERE ${where} ORDER BY coalesce(c.scheduled_start, c.requested_at) LIMIT ${LIMIT}`.execute(this.db);
    const title = (k: C, t: string) => `${t}: ${k.case_no} — ${k.pname}`;
    const at = (d: Date | null) => (d ? new Date(d).toLocaleString('ka-GE', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
    // ანესთეზიოლოგის მფლობელობა (A1): გუნდის ანესთეზიოლოგი → (არ არის) ხელმძღვანელი ანესთეზიოლოგი → (არ არის) ყველა ანესთეზიოლოგი
    const anesthHeadExists = anesth ? (await sql<{ n: number }>`SELECT count(*)::int AS n FROM users u JOIN user_capabilities uc ON uc.user_id = u.id
      WHERE u.is_active AND u.is_section_head AND 'anesthesiologist' = ANY (uc.capabilities)`.execute(this.db)).rows[0].n > 0 : false;
    const anesthOwner = sql<boolean>`(${anesth} AND (EXISTS (SELECT 1 FROM or_case_team t WHERE t.case_id = c.id AND t.role_code = 'anesthesiologist' AND t.user_id = ${x.u.id}
        AND t.removed_at IS NULL AND t.out_at IS NULL)
      OR (NOT EXISTS (SELECT 1 FROM or_case_team t WHERE t.case_id = c.id AND t.role_code = 'anesthesiologist' AND t.removed_at IS NULL AND t.out_at IS NULL)
        AND (${!!me.is_section_head} OR NOT ${anesthHeadExists}))))`;

    if (c.has('or_request')) {
      // or_scheduling: coordinator — or_schedule; surgeon_self — ქირურგი + განყოფილების ხელმძღვანელი; both — ყველა. გადაუდებელი — ქირურგიც. კოორდინატორი არავინაა → ქირურგი + ხელმძღვანელი (A1)
      const coordExists = await x.x.capExists('or_schedule');
      const coord = has(x.u, 'or_schedule') && s.or_scheduling !== 'surgeon_self';
      const headDep = doctor && me.is_section_head ? me.department_id : null;
      const self = s.or_scheduling !== 'coordinator' || !coordExists;
      const r = await cases(sql`(c.status = 'requested' AND (${coord} OR ((${self} OR c.urgency = 'emergency') AND (c.surgeon_id = ${x.u.id} OR c.department_id = ${headDep ?? NIL}::uuid))))
        OR (c.status = 'tentative' AND (${has(x.u, 'or_schedule')} OR (NOT ${coordExists} AND (c.surgeon_id = ${x.u.id} OR c.department_id = ${headDep ?? NIL}::uuid))))`);
      for (const k of r.rows) {
        const due = k.status === 'tentative' ? k.scheduled_start : k.pref_end;
        out.push({ id: k.id, source: 'or_request', title: title(k, k.status === 'tentative' ? 'დასადასტურებელი' : 'დასაგეგმი'),
          detail: `${k.dep} · ${k.surgeon}${k.status === 'tentative' ? ` · ${at(k.scheduled_start)}` : ''}`, patient: k.pname, department: k.dep, due_at: due,
          priority: URG[k.urgency] ?? 'normal', link: `/or/case/${k.id}`, created_at: k.requested_at });
      }
    }
    const soon = sql`c.status IN ('tentative', 'scheduled') AND c.scheduled_start IS NOT NULL AND c.scheduled_start < now() + make_interval(hours => ${ahead})
      AND c.scheduled_start > now() - interval '12 hours'`;
    if (c.has('or_preop') && anesth) {
      const r = await cases(sql`${soon} AND c.anesthesia_type NOT IN ('local', 'none')
        AND NOT EXISTS (SELECT 1 FROM or_preop_assessments pa WHERE pa.case_id = c.id AND pa.status = 'signed' AND pa.voided_at IS NULL) AND ${anesthOwner}`);
      for (const k of r.rows) out.push({ id: k.id, source: 'or_preop', title: title(k, 'წინასაოპერაციო შეფასება'), detail: `${k.dep} · ${at(k.scheduled_start)}`,
        patient: k.pname, department: k.dep, due_at: k.scheduled_start, priority: 'high', link: `/or/case/${k.id}?tab=preop`, created_at: null });
    }
    if (c.has('or_ready')) {
      const dep = await x.sideDept(['nurse', 'doctor', 'manager']);
      if (dep) {
        const r = await cases(sql`${soon} AND c.department_id = ${dep}::uuid`);
        for (const k of r.rows) {
          const rd = await this.or.readiness(await this.or.loadCase(k.id));
          if (rd.ready) continue;
          const close = !!k.scheduled_start && new Date(k.scheduled_start).getTime() - Date.now() < 2 * 3_600_000;
          out.push({ id: k.id, source: 'or_ready', title: title(k, 'მზადყოფნა არასრულია'), detail: `${at(k.scheduled_start)} · ${rd.missing.slice(0, 4).join('; ')}`,
            patient: k.pname, department: k.dep, due_at: k.scheduled_start, priority: close ? 'high' : 'normal', link: `/or/case/${k.id}?tab=preop`, created_at: null });
        }
      }
    }
    if (c.has('or_docs') && (doctor || anesth)) {
      const END = sql`(SELECT max(t.at) FROM or_case_times t WHERE t.case_id = c.id AND t.kind = 'out_of_room' AND t.superseded_by IS NULL)`;
      const r = await sql<{ id: string; case_no: string; pname: string; dep: string; ended: Date | null; note: boolean; anes: boolean }>`
        SELECT c.id, c.case_no, p.last_name || ' ' || p.first_name AS pname, d.name AS dep, ${END} AS ended,
               (${doctor} AND (c.surgeon_id = ${x.u.id} OR (${!!me.is_section_head} AND c.department_id = ${me.department_id ?? NIL}::uuid AND NOT EXISTS (
                 SELECT 1 FROM users su WHERE su.id = c.surgeon_id AND su.is_active)))
                 AND NOT EXISTS (SELECT 1 FROM or_op_notes n WHERE n.case_id = c.id AND n.status = 'signed' AND n.superseded_at IS NULL)) AS note,
               (c.anesthesia_type NOT IN ('local', 'none') AND ${anesthOwner} AND NOT EXISTS (SELECT 1 FROM or_anesthesia_records ar WHERE ar.case_id = c.id AND ar.status = 'signed')) AS anes
          FROM or_cases c JOIN departments d ON d.id = c.department_id JOIN patients p ON p.id = c.patient_id
         WHERE c.status = 'completed' AND c.updated_at > now() - interval '30 days' ORDER BY c.updated_at LIMIT ${LIMIT * 2}`.execute(this.db);
      for (const k of r.rows) {
        if (!k.note && !k.anes) continue;
        const what = [k.note ? 'ოპერაციის ოქმი' : null, k.anes ? 'ანესთეზიის რუკა' : null].filter(Boolean).join(' + ');
        out.push({ id: k.id, source: 'or_docs', title: `${what} — ხელმოსაწერი: ${k.case_no} — ${k.pname}`, detail: k.dep, patient: k.pname, department: k.dep,
          due_at: x.x.sla('or_docs', k.ended), priority: 'normal', link: `/or/case/${k.id}?tab=${k.note ? 'note' : 'anesthesia'}`, created_at: k.ended });
      }
    }
    if (c.has('or_pacu') && has(x.u, 'or_nurse', 'nurse', 'anesthesiologist')) {
      const longH = x.x.s.pacu_long_hours ?? WL_DEFAULTS.pacu_long_hours;
      const min = (s as { pacu_aldrete_min?: number }).pacu_aldrete_min ?? 9;
      // PACU-ს ექთანი (nurse_id); არ არის — საოპერაციო ექთნები (or_nurse); მზად / დიდხანს — + გუნდის ანესთეზიოლოგი
      const r = await sql<{ case_id: string; case_no: string; pname: string; dep: string; created_at: Date; aldrete: number | null; nurse_id: string | null; anes_me: boolean }>`
        SELECT pc.case_id, c.case_no, p.last_name || ' ' || p.first_name AS pname, d.name AS dep, pc.created_at, pc.nurse_id,
               (SELECT sc.total FROM or_pacu_scores sc WHERE sc.case_id = pc.case_id AND sc.voided_at IS NULL ORDER BY sc.recorded_at DESC LIMIT 1) AS aldrete,
               ${anesthOwner} AS anes_me
          FROM or_pacu pc JOIN or_cases c ON c.id = pc.case_id JOIN departments d ON d.id = c.department_id JOIN patients p ON p.id = pc.patient_id
         WHERE pc.discharged_at IS NULL ORDER BY pc.created_at LIMIT ${LIMIT}`.execute(this.db);
      for (const k of r.rows) {
        const ready = k.aldrete != null && k.aldrete >= min;
        const long = Date.now() - new Date(k.created_at).getTime() > longH * 3_600_000;
        const nurseOwn = k.nurse_id ? k.nurse_id === x.u.id : has(x.u, 'or_nurse');
        if (!nurseOwn && !(k.anes_me && (ready || long))) continue;
        out.push({ id: k.case_id, source: 'or_pacu', title: `PACU${ready ? ' — გასაწერად მზადაა' : long ? ` — ${longH} სთ-ზე მეტი` : ''}: ${k.case_no} — ${k.pname}`,
          detail: `${k.dep}${k.aldrete != null ? ` · Aldrete ${k.aldrete}` : ''}`, patient: k.pname, department: k.dep, due_at: plus(k.created_at, longH * 60),
          priority: ready || long ? 'high' : 'normal', link: `/or/case/${k.case_id}?tab=pacu`, created_at: k.created_at });
      }
    }
    return out;
  }
}
