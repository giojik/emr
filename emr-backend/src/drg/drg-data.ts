import { createHash } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Role } from '../auth/roles';
import { loadEnv } from '../config/env';
import type { DB } from '../database/db';
import { type Cond, type GroupInputs, type ListKind, norm, stableJson, type VersionData, versionSettings, type VersionSettings } from './drg-engine';
import type { Component } from './drg-pricing';

type Ex = Kysely<DB> | Transaction<DB>;
const TZ = loadEnv().CLINIC_TZ;

/** DRG მოდულის პარამეტრები (0055) — system_modules.drg */
export interface DrgRules {
  /** ვერსიის არჩევის თარიღი: discharge — გაწერის დღე (გაწერამდე — დღეს); admission — მიღების დღე */
  version_date_basis: 'discharge' | 'admission';
  /** ფინალიზაცია: DRG გადამხდელზე (მოქმედი ვერსიით) ჯგუფი დადასტურებული უნდა იყოს */
  confirm_required: boolean;
  /** ფინალიზაციისას: დადასტურების შემდეგ შეიცვალა მონაცემები (დიაგნოზი, ოპერაცია, დღეები …) — block / warn / off */
  recheck_on_finalize: 'block' | 'warn' | 'off';
  /** გადამხდელის ფორმაში DRG კოდის ხელით არჩევა: allowed; grouper_only — მხოლოდ დაჯგუფებით (დადასტურება / შეცვლა მიზეზით) */
  manual_payer_drg: 'allowed' | 'grouper_only';
  /** ვერსიის გააქტიურება: off — drg_admin; required — მეორე პირი (არა ბოლო რედაქტორი) */
  version_approval: 'off' | 'required';
}
export const DRG_RULES_DEFAULT: DrgRules = { version_date_basis: 'discharge', confirm_required: true, recheck_on_finalize: 'block', manual_payer_drg: 'allowed', version_approval: 'off' };
export async function drgRules(db: Ex): Promise<DrgRules & { enabled: boolean }> {
  const m = await db.selectFrom('system_modules').select(['enabled', 'settings']).where('code', '=', 'drg').executeTakeFirst();
  return { ...DRG_RULES_DEFAULT, ...((m?.settings ?? {}) as Partial<DrgRules>), enabled: m?.enabled ?? false };
}

/** კონფიგურაციის ნახვა */
export const DRG_READ: Role[] = ['admin', 'billing', 'drg', 'drg_admin', 'tariffs', 'accountant', 'viewer'];
/** კონფიგურაცია: სქემები, ვერსიები, შემადგენლობა, იმპორტი */
export const DRG_ADMIN: Role[] = ['admin', 'drg_admin'];
/** შემთხვევაზე: დადასტურება / შეცვლა / გაუქმება */
export const DRG_CONFIRM: Role[] = ['admin', 'billing', 'drg'];
/** შემთხვევის DRG-ის ნახვა */
export const DRG_STAY_READ: Role[] = ['admin', 'billing', 'drg', 'drg_admin', 'receptionist', 'manager', 'doctor', 'viewer', 'accountant'];

// ---------------------------------------------------------------- ვერსია
export interface VersionMeta { id: string; scheme_id: string; scheme_code: string; scheme_name: string; version_no: number; label: string; valid_from: string; status: string }
export async function versionMeta(ex: Ex, id: string): Promise<VersionMeta | undefined> {
  return ex.selectFrom('drg_versions as v').innerJoin('drg_schemes as s', 's.id', 'v.scheme_id')
    .select(['v.id', 'v.scheme_id', 's.code as scheme_code', 's.name as scheme_name', 'v.version_no', 'v.label', sql<string>`to_char(v.valid_from, 'YYYY-MM-DD')`.as('valid_from'), 'v.status'])
    .where('v.id', '=', id).executeTakeFirst();
}
export async function loadVersion(ex: Ex, id: string): Promise<VersionData> {
  const [v, groups, lists, items, cc, rules, comps] = await Promise.all([
    ex.selectFrom('drg_versions').select('settings').where('id', '=', id).executeTakeFirstOrThrow(),
    ex.selectFrom('drg_version_groups').select(['code', 'title', 'weight', 'kind', 'mdc', 'alos']).where('version_id', '=', id).execute(),
    ex.selectFrom('drg_code_lists').select(['code', 'kind']).where('version_id', '=', id).execute(),
    ex.selectFrom('drg_code_list_items').select(['list_code', 'pattern']).where('version_id', '=', id).execute(),
    ex.selectFrom('drg_cc').select(['pattern', 'level', 'excl_pdx']).where('version_id', '=', id).execute(),
    ex.selectFrom('drg_rules').select(['id', 'seq', 'drg_code', 'label', 'conditions', 'is_active']).where('version_id', '=', id).orderBy('seq').orderBy('id').execute(),
    ex.selectFrom('drg_price_components').select(['id', 'seq', 'kind', 'label', 'conditions', 'params', 'exclusive_group', 'is_active']).where('version_id', '=', id).orderBy('seq').orderBy('id').execute(),
  ]);
  const lm = new Map<string, { kind: ListKind; patterns: string[] }>(lists.map((l) => [l.code, { kind: l.kind as ListKind, patterns: [] }]));
  for (const i of items) lm.get(i.list_code)?.patterns.push(i.pattern);
  return {
    settings: versionSettings(v.settings),
    groups: new Map(groups.map((g) => [g.code, g])),
    lists: lm,
    cc: cc.map((c) => ({ pattern: c.pattern, level: c.level as 'cc' | 'mcc', excl_pdx: c.excl_pdx ?? [] })),
    rules: rules.map((r) => ({ ...r, conditions: r.conditions as unknown as Cond[] })),
    components: comps.map((c) => ({ ...c, kind: c.kind as Component['kind'], conditions: c.conditions as unknown as Cond[], params: (c.params ?? {}) as Record<string, unknown> })),
  };
}
export async function listKinds(ex: Ex, versionId: string) {
  return new Map((await ex.selectFrom('drg_code_lists').select(['code', 'kind']).where('version_id', '=', versionId).execute()).map((l) => [l.code, l.kind as ListKind]));
}
export const defaultSchemeId = async (ex: Ex) => (await ex.selectFrom('drg_schemes').select('id').where('is_default', '=', true).executeTakeFirst())?.id ?? null;

// ---------------------------------------------------------------- შემთხვევა
export interface StayInfo {
  encounter_id: string; adm_no: string; status: string; admitted_at: Date; ended_at: Date | null; discharge_type: string | null; source: string;
  birth_date: string; gender: string; admit_date: string; end_date: string | null; today: string;
}
export async function stayInfo(ex: Ex, eid: string): Promise<StayInfo | undefined> {
  return ex.selectFrom('inpatient_stays as st').innerJoin('patients as p', 'p.id', 'st.patient_id')
    .select(['st.encounter_id', 'st.adm_no', 'st.status', 'st.admitted_at', 'st.ended_at', 'st.discharge_type', 'st.source', sql<string>`to_char(p.birth_date, 'YYYY-MM-DD')`.as('birth_date'),
      sql<string>`p.gender::text`.as('gender'), sql<string>`to_char((st.admitted_at AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD')`.as('admit_date'),
      sql<string | null>`to_char((st.ended_at AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD')`.as('end_date'), sql<string>`to_char((now() AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD')`.as('today')])
    .where('st.encounter_id', '=', eid).executeTakeFirst() as Promise<StayInfo | undefined>;
}
/** ვერსიის საბაზისო თარიღი (მოდულის პარამეტრით) */
export const versionDate = (st: StayInfo, r: Pick<DrgRules, 'version_date_basis'>) =>
  (r.version_date_basis === 'admission' ? st.admit_date : st.status === 'discharged' && st.end_date ? st.end_date : st.today);

export async function versionAt(ex: Ex, schemeId: string, date: string): Promise<string | null> {
  return (await sql<{ id: string | null }>`SELECT drg_version_at(${schemeId}::uuid, ${date}::date) AS id`.execute(ex)).rows[0]?.id ?? null;
}

export interface InputDetails {
  dx: { code: string; title: string; type: string; role: 'pdx' | 'sdx' | 'other' }[];
  procs: { case_no: string; code: string; ncsp: string | null; name: string; primary: boolean; from: 'op_note' | 'plan' }[];
  services: { code: string; title: string }[];
  los_bed_days: number; los_calendar: number; age_basis_date: string;
}
const yearsBetween = (from: string, to: string) => {
  const [y1, m1, d1] = from.split('-').map(Number); const [y2, m2, d2] = to.split('-').map(Number);
  return y2 - y1 - (m2 < m1 || (m2 === m1 && d2 < d1) ? 1 : 0);
};
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** შემთხვევის მონაცემები დასაჯგუფებლად (ვერსიის პარამეტრებით) */
export async function gatherInputs(ex: Ex, st: StayInfo, s: VersionSettings): Promise<{ inputs: GroupInputs; details: InputDetails }> {
  const eid = st.encounter_id;
  const [dxRows, opRows, planRows, svcRows, bed, icu, vent, dept] = await Promise.all([
    ex.selectFrom('encounter_diagnoses').select(['icd10_code', 'icd10_title', 'diagnosis_type']).where('encounter_id', '=', eid).orderBy('created_at').orderBy('id').execute(),
    // ოპერაციები: დასრულებული შემთხვევის ხელმოწერილი ოქმის (მიმდინარე ვერსია) პროცედურები
    sql<{ case_id: string; case_no: string; p: { code?: string; ncsp_code?: string | null; name?: string; is_primary?: boolean } }>`
      SELECT c.id AS case_id, c.case_no, x.p FROM or_cases c
        JOIN or_op_notes n ON n.case_id = c.id AND n.status = 'signed' AND n.superseded_at IS NULL
        CROSS JOIN LATERAL jsonb_array_elements(n.procedures) x(p)
       WHERE c.encounter_id = ${eid}::uuid AND c.status = 'completed' ORDER BY c.case_no`.execute(ex),
    // ოქმის გარეშე — დაგეგმილი პროცედურები
    sql<{ case_id: string; case_no: string; code: string; ncsp_code: string | null; name: string; is_primary: boolean }>`
      SELECT c.id AS case_id, c.case_no, p.code, p.ncsp_code, p.name, cp.is_primary FROM or_cases c
        JOIN or_case_procedures cp ON cp.case_id = c.id JOIN or_procedures p ON p.id = cp.procedure_id
       WHERE c.encounter_id = ${eid}::uuid AND c.status = 'completed' ORDER BY c.case_no, cp.sort_order`.execute(ex),
    sql<{ code: string; title: string }>`SELECT DISTINCT t.code, t.title FROM invoice_line_items l JOIN invoices i ON i.id = l.invoice_id JOIN service_tariffs t ON t.id = l.tariff_id
       WHERE i.encounter_id = ${eid}::uuid ORDER BY t.code`.execute(ex),
    ex.selectFrom('stay_bed_days').select(sql<number>`count(*)::int`.as('n')).where('encounter_id', '=', eid).executeTakeFirstOrThrow(),
    sql<{ h: string | null }>`SELECT sum(extract(epoch FROM (coalesce(e.ended_at, ${st.ended_at}::timestamptz, now()) - e.started_at)) / 3600) AS h
       FROM icu_episodes e WHERE e.encounter_id = ${eid}::uuid AND e.exit_kind IS DISTINCT FROM 'cancel'`.execute(ex),
    sql<{ h: string | null }>`SELECT sum(extract(epoch FROM (coalesce(v.ended_at, ${st.ended_at}::timestamptz, now()) - v.started_at)) / 3600) AS h
       FROM icu_ventilation v WHERE v.encounter_id = ${eid}::uuid AND v.voided_at IS NULL AND v.kind = ANY(${s.vent_kinds.length ? s.vent_kinds : ['__none__']}::text[])`.execute(ex),
    // 0056: განყოფილება — ბოლო (გაწერის) მოთავსება
    sql<{ code: string }>`SELECT d.code FROM bed_assignments a JOIN departments d ON d.id = a.department_id WHERE a.encounter_id = ${eid}::uuid AND a.end_kind IS DISTINCT FROM 'cancel'
       ORDER BY a.ended_at IS NULL DESC, a.started_at DESC, a.id DESC LIMIT 1`.execute(ex),
  ]);

  // დიაგნოზები
  const primary = dxRows.filter((d) => d.diagnosis_type === 'primary');
  let pdxRow = primary[0];
  if (!pdxRow && s.pdx_source === 'primary_or_admission') pdxRow = dxRows.filter((d) => d.diagnosis_type === 'admission').at(-1) as typeof pdxRow;
  const pdx = pdxRow ? norm(pdxRow.icd10_code) : null;
  const sdxSet = new Set<string>();
  const dx: InputDetails['dx'] = dxRows.map((d) => {
    const n = norm(d.icd10_code);
    const role = d === pdxRow ? 'pdx' : (s.cc_sources as string[]).includes(d.diagnosis_type) && n !== pdx ? 'sdx' : 'other';
    if (role === 'sdx') sdxSet.add(n);
    return { code: d.icd10_code, title: d.icd10_title, type: d.diagnosis_type, role };
  });

  // პროცედურები: ოქმიდან; ოქმის გარეშე შემთხვევა — გეგმიდან
  const withNote = new Set(opRows.rows.map((r) => r.case_id));
  const procs: InputDetails['procs'] = [
    ...opRows.rows.map((r) => ({ case_no: r.case_no, code: String(r.p.code ?? ''), ncsp: r.p.ncsp_code ?? null, name: String(r.p.name ?? ''), primary: !!r.p.is_primary, from: 'op_note' as const })),
    ...planRows.rows.filter((r) => !withNote.has(r.case_id)).map((r) => ({ case_no: r.case_no, code: r.code, ncsp: r.ncsp_code, name: r.name, primary: r.is_primary, from: 'plan' as const })),
  ];
  const codes = new Set<string>();
  for (const p of procs) {
    if (s.proc_sources.includes('or_ncsp') && p.ncsp) codes.add(norm(p.ncsp));
    if (s.proc_sources.includes('or_code') && p.code) codes.add(norm(p.code));
  }
  if (s.proc_sources.includes('service_code')) for (const r of svcRows.rows) codes.add(norm(r.code));

  const endDate = st.status === 'discharged' && st.end_date ? st.end_date : st.today;
  const ageDate = s.age_basis === 'discharge' ? endDate : st.admit_date;
  const losCal = Math.max(1, daysBetween(st.admit_date, endDate));
  const sex = st.gender === 'male' ? 'M' : st.gender === 'female' ? 'F' : null;
  const r1 = (x: string | null | undefined) => Math.round(Number(x ?? 0) * 10) / 10;
  const inputs: GroupInputs = {
    pdx, sdx: [...sdxSet].sort(), procs: [...codes].sort(), services: [...new Set(svcRows.rows.map((r) => norm(r.code)))].sort(),
    surgery: new Set(procs.map((p) => p.case_no)).size > 0,
    age: yearsBetween(st.birth_date, ageDate), age_days: daysBetween(st.birth_date, ageDate), sex,
    los: s.los_basis === 'calendar_days' ? losCal : Math.max(bed.n, 1),
    icu_hours: r1(icu.rows[0]?.h), vent_hours: r1(vent.rows[0]?.h),
    discharge: st.discharge_type, source: st.source, dept: dept.rows[0]?.code ? norm(dept.rows[0].code) : null,
  };
  return { inputs, details: { dx, procs, services: svcRows.rows, los_bed_days: bed.n, los_calendar: losCal, age_basis_date: ageDate } };
}
/** შემავალი მონაცემების ჰეში — ICU / ვენტილაციის საათები მთელ საათამდე (მიმდინარე ეპიზოდი ყოველ წამს რომ არ „იცვლებოდეს“) */
export const inputsHash = (x: GroupInputs) => createHash('sha256').update(stableJson({ ...x, icu_hours: Math.floor(x.icu_hours), vent_hours: Math.floor(x.vent_hours) })).digest('hex');
