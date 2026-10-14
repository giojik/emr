import { sql } from 'kysely';
import { loadEnv } from '../config/env';
import type { Ex } from '../finance/finance-common';

const TZ = loadEnv().CLINIC_TZ;

/**
 * 0058: ექსპორტის ველების კატალოგი — შაბლონის სვეტი = ველი (ან მუდმივი) + ფორმატი.
 * ტიპი: text | date (YYYY-MM-DD → შაბლონის ფორმატით) | number (ფულადი / წონა) | int.
 */
export type FieldType = 'text' | 'date' | 'number' | 'int';
export interface FieldDef { key: string; label: string; group: string; type: FieldType; sum?: boolean; ipd_only?: boolean }
export const EXPORT_FIELDS: FieldDef[] = [
  // ქლეიმი
  { key: 'claim_no', label: 'ქლეიმის №', group: 'ქლეიმი', type: 'text' },
  { key: 'claim_period_from', label: 'პერიოდი — დან', group: 'ქლეიმი', type: 'date' },
  { key: 'claim_period_to', label: 'პერიოდი — მდე', group: 'ქლეიმი', type: 'date' },
  { key: 'claim_sent_date', label: 'გაგზავნის თარიღი', group: 'ქლეიმი', type: 'date' },
  { key: 'payer_code', label: 'გადამხდელის კოდი', group: 'ქლეიმი', type: 'text' },
  { key: 'payer_name', label: 'გადამხდელი', group: 'ქლეიმი', type: 'text' },
  // შემთხვევა
  { key: 'seq', label: 'რიგითი №', group: 'შემთხვევა', type: 'int' },
  { key: 'kind', label: 'ტიპი (ipd / opd)', group: 'შემთხვევა', type: 'text' },
  { key: 'kind_ka', label: 'ტიპი (სტაციონარი / ამბულატორია)', group: 'შემთხვევა', type: 'text' },
  { key: 'invoice_number', label: 'ინვოისის №', group: 'შემთხვევა', type: 'text' },
  { key: 'case_date', label: 'შემთხვევის თარიღი (ფინალიზაცია / ვიზიტი)', group: 'შემთხვევა', type: 'date' },
  { key: 'claimed', label: 'მოთხოვნილი თანხა', group: 'შემთხვევა', type: 'number', sum: true },
  { key: 'invoice_total', label: 'ინვოისის ჯამი', group: 'შემთხვევა', type: 'number', sum: true },
  { key: 'patient_share', label: 'პაციენტის წილი', group: 'შემთხვევა', type: 'number', sum: true },
  { key: 'policy_no', label: 'პოლისის №', group: 'შემთხვევა', type: 'text' },
  { key: 'guarantee_no', label: 'საგარანტიოს №', group: 'შემთხვევა', type: 'text' },
  { key: 'guarantee_date', label: 'საგარანტიოს თარიღი', group: 'შემთხვევა', type: 'date' },
  // პაციენტი
  { key: 'personal_number', label: 'პირადი №', group: 'პაციენტი', type: 'text' },
  { key: 'last_name', label: 'გვარი', group: 'პაციენტი', type: 'text' },
  { key: 'first_name', label: 'სახელი', group: 'პაციენტი', type: 'text' },
  { key: 'full_name', label: 'გვარი სახელი', group: 'პაციენტი', type: 'text' },
  { key: 'birth_date', label: 'დაბადების თარიღი', group: 'პაციენტი', type: 'date' },
  { key: 'sex', label: 'სქესი (M / F)', group: 'პაციენტი', type: 'text' },
  { key: 'age', label: 'ასაკი (შემთხვევის დღეს)', group: 'პაციენტი', type: 'int' },
  // ჰოსპიტალიზაცია / ვიზიტი
  { key: 'adm_no', label: 'ისტორიის №', group: 'ჰოსპიტალიზაცია', type: 'text', ipd_only: true },
  { key: 'admit_date', label: 'შემოსვლის თარიღი', group: 'ჰოსპიტალიზაცია', type: 'date' },
  { key: 'admit_time', label: 'შემოსვლის დრო (HH:MM)', group: 'ჰოსპიტალიზაცია', type: 'text' },
  { key: 'discharge_date', label: 'გაწერის თარიღი', group: 'ჰოსპიტალიზაცია', type: 'date', ipd_only: true },
  { key: 'discharge_time', label: 'გაწერის დრო (HH:MM)', group: 'ჰოსპიტალიზაცია', type: 'text', ipd_only: true },
  { key: 'los', label: 'ხანგრძლივობა (კალ. დღე)', group: 'ჰოსპიტალიზაცია', type: 'int', ipd_only: true },
  { key: 'bed_days', label: 'საწოლდღეები', group: 'ჰოსპიტალიზაცია', type: 'int', ipd_only: true },
  { key: 'admission_source', label: 'შემოსვლის წყარო', group: 'ჰოსპიტალიზაცია', type: 'text', ipd_only: true },
  { key: 'discharge_type', label: 'გაწერის ტიპი', group: 'ჰოსპიტალიზაცია', type: 'text', ipd_only: true },
  { key: 'department_code', label: 'განყოფილების კოდი', group: 'ჰოსპიტალიზაცია', type: 'text' },
  { key: 'department_name', label: 'განყოფილება', group: 'ჰოსპიტალიზაცია', type: 'text' },
  { key: 'doctor_name', label: 'მკურნალი ექიმი', group: 'ჰოსპიტალიზაცია', type: 'text' },
  // კლინიკური
  { key: 'pdx_code', label: 'ძირითადი დიაგნოზი (ICD-10)', group: 'კლინიკური', type: 'text' },
  { key: 'pdx_title', label: 'ძირითადი დიაგნოზი — დასახელება', group: 'კლინიკური', type: 'text' },
  { key: 'sdx_codes', label: 'თანმხლები დიაგნოზები (სია)', group: 'კლინიკური', type: 'text' },
  { key: 'dx_all_codes', label: 'ყველა დიაგნოზი (სია)', group: 'კლინიკური', type: 'text' },
  { key: 'proc_codes', label: 'ოპერაციები — NCSP (სია)', group: 'კლინიკური', type: 'text', ipd_only: true },
  { key: 'proc_primary', label: 'ძირითადი ოპერაცია — NCSP', group: 'კლინიკური', type: 'text', ipd_only: true },
  { key: 'proc_names', label: 'ოპერაციები — დასახელება (სია)', group: 'კლინიკური', type: 'text', ipd_only: true },
  // DRG
  { key: 'drg_code', label: 'DRG კოდი', group: 'DRG', type: 'text', ipd_only: true },
  { key: 'drg_title', label: 'DRG დასახელება', group: 'DRG', type: 'text', ipd_only: true },
  { key: 'drg_weight', label: 'DRG წონა', group: 'DRG', type: 'number', ipd_only: true },
  { key: 'drg_base_rate', label: 'საბაზისო განაკვეთი', group: 'DRG', type: 'number', ipd_only: true },
  { key: 'drg_amount', label: 'DRG თანხა', group: 'DRG', type: 'number', sum: true, ipd_only: true },
  { key: 'drg_version', label: 'DRG ვერსია', group: 'DRG', type: 'text', ipd_only: true },
  { key: 'drg_mdc', label: 'MDC', group: 'DRG', type: 'text', ipd_only: true },
];
export const FIELD_MAP = new Map(EXPORT_FIELDS.map((f) => [f.key, f]));

export type RowData = Record<string, string | number | null>;

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const yearsBetween = (from: string, to: string) => {
  const [y1, m1, d1] = from.split('-').map(Number); const [y2, m2, d2] = to.split('-').map(Number);
  return y2 - y1 - (m2 < m1 || (m2 === m1 && d2 < d1) ? 1 : 0);
};

/** ქლეიმის შემთხვევების მონაცემები (ველის გასაღები → მნიშვნელობა) — რიგით: თარიღი, ინვოისი */
export async function claimRows(ex: Ex, claimId: string): Promise<{ id: string; invoice_id: string; kind: 'ipd' | 'opd'; data: RowData }[]> {
  const base = (await sql<{
    id: string; kind: 'ipd' | 'opd'; claimed: string; invoice_id: string; encounter_id: string; invoice_number: string; case_date: string;
    claim_no: string | null; period_from: string; period_to: string; sent_date: string | null; payer_id: string; payer_code: string; payer_name: string;
    invoice_total: string; patient_share: string; personal_number: string | null; last_name: string; first_name: string; birth_date: string | null; gender: string | null;
    adm_no: string | null; admit_date: string | null; admit_time: string | null; discharge_date: string | null; discharge_time: string | null; source: string | null; discharge_type: string | null;
    dept_code: string | null; dept_name: string | null; doctor_name: string | null; visit_date: string; visit_time: string;
  }>`
    SELECT ci.id, ci.kind, ci.claimed::text, ci.invoice_id, i.encounter_id, i.invoice_number,
           to_char(CASE WHEN ci.kind = 'ipd' THEN fin_local_date(i.finalized_at) ELSE fin_local_date(i.created_at) END, 'YYYY-MM-DD') AS case_date,
           c.claim_no, to_char(c.period_from, 'YYYY-MM-DD') AS period_from, to_char(c.period_to, 'YYYY-MM-DD') AS period_to,
           to_char((c.sent_at AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS sent_date, py.id AS payer_id, py.code AS payer_code, py.name AS payer_name,
           i.total_amount::text AS invoice_total, i.patient_share::text AS patient_share,
           p.personal_number, p.last_name, p.first_name, to_char(p.birth_date, 'YYYY-MM-DD') AS birth_date, p.gender::text AS gender,
           st.adm_no, to_char((st.admitted_at AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS admit_date, to_char(st.admitted_at AT TIME ZONE ${TZ}, 'HH24:MI') AS admit_time,
           to_char((st.ended_at AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS discharge_date, to_char(st.ended_at AT TIME ZONE ${TZ}, 'HH24:MI') AS discharge_time,
           st.source, st.discharge_type,
           coalesce(bd.code, d.code) AS dept_code, coalesce(bd.name, d.name) AS dept_name,
           CASE WHEN u.id IS NOT NULL THEN u.last_name || ' ' || u.first_name END AS doctor_name,
           to_char((e.start_time AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS visit_date, to_char(e.start_time AT TIME ZONE ${TZ}, 'HH24:MI') AS visit_time
      FROM fin_claim_items ci JOIN fin_claims c ON c.id = ci.claim_id JOIN payers py ON py.id = ci.payer_id
      JOIN invoices i ON i.id = ci.invoice_id JOIN encounters e ON e.id = i.encounter_id JOIN patients p ON p.id = e.patient_id
      LEFT JOIN inpatient_stays st ON st.encounter_id = e.id
      LEFT JOIN departments d ON d.id = e.department_id
      LEFT JOIN users u ON u.id = e.attending_doctor_id
      LEFT JOIN LATERAL (SELECT dd.code, dd.name FROM bed_assignments a JOIN departments dd ON dd.id = a.department_id
                          WHERE a.encounter_id = e.id AND a.end_kind IS DISTINCT FROM 'cancel'
                          ORDER BY a.ended_at IS NULL DESC, a.started_at DESC, a.id DESC LIMIT 1) bd ON TRUE
     WHERE ci.claim_id = ${claimId}::uuid
     ORDER BY 7, i.invoice_number`.execute(ex)).rows;
  if (!base.length) return [];
  const encs = [...new Set(base.map((b) => b.encounter_id))];
  const [dx, procs, sps, beds] = await Promise.all([
    sql<{ encounter_id: string; icd10_code: string; icd10_title: string; diagnosis_type: string }>`
      SELECT encounter_id, icd10_code, icd10_title, diagnosis_type FROM encounter_diagnoses WHERE encounter_id = ANY(${encs}::uuid[]) ORDER BY created_at, id`.execute(ex),
    // ოპერაციები: ხელმოწერილი ოქმი; ოქმის გარეშე — გეგმა (როგორც DRG-ში)
    sql<{ encounter_id: string; case_no: string; ncsp: string | null; code: string | null; name: string | null; is_primary: boolean | null }>`
      SELECT c.encounter_id, c.case_no, x.p->>'ncsp_code' AS ncsp, x.p->>'code' AS code, x.p->>'name' AS name, (x.p->>'is_primary')::boolean AS is_primary
        FROM or_cases c JOIN or_op_notes n ON n.case_id = c.id AND n.status = 'signed' AND n.superseded_at IS NULL
        CROSS JOIN LATERAL jsonb_array_elements(n.procedures) x(p)
       WHERE c.encounter_id = ANY(${encs}::uuid[]) AND c.status = 'completed'
      UNION ALL
      SELECT c.encounter_id, c.case_no, pr.ncsp_code, pr.code, pr.name, cp.is_primary
        FROM or_cases c JOIN or_case_procedures cp ON cp.case_id = c.id JOIN or_procedures pr ON pr.id = cp.procedure_id
       WHERE c.encounter_id = ANY(${encs}::uuid[]) AND c.status = 'completed'
         AND NOT EXISTS (SELECT 1 FROM or_op_notes n WHERE n.case_id = c.id AND n.status = 'signed' AND n.superseded_at IS NULL)
       ORDER BY 2`.execute(ex),
    sql<{ encounter_id: string; payer_id: string; policy_no: string | null; guarantee_no: string | null; guarantee_date: string | null; drg_code: string | null;
          drg_weight: string | null; drg_base_rate: string | null; drg_amount: string | null; drg_title: string | null; drg_mdc: string | null; drg_version: string | null }>`
      SELECT sp.encounter_id, sp.payer_id, sp.policy_no, sp.guarantee_no, to_char(sp.guarantee_date, 'YYYY-MM-DD') AS guarantee_date, sp.drg_code,
             sp.drg_weight::text, sp.drg_base_rate::text, sp.drg_amount::text, coalesce(g.title, og.title) AS drg_title, coalesce(g.mdc, og.mdc) AS drg_mdc,
             CASE WHEN v.id IS NOT NULL THEN s.code || ' v' || v.version_no || coalesce(' — ' || v.label, '') END AS drg_version
        FROM stay_payers sp
        LEFT JOIN drg_version_groups g ON g.version_id = sp.drg_version_id AND g.code = sp.drg_code
        LEFT JOIN drg_groups og ON og.code = sp.drg_code
        LEFT JOIN drg_versions v ON v.id = sp.drg_version_id LEFT JOIN drg_schemes s ON s.id = v.scheme_id
       WHERE sp.encounter_id = ANY(${encs}::uuid[]) AND sp.status = 'active' ORDER BY sp.seq`.execute(ex),
    sql<{ encounter_id: string; n: number }>`SELECT encounter_id, count(*)::int AS n FROM stay_bed_days WHERE encounter_id = ANY(${encs}::uuid[]) GROUP BY encounter_id`.execute(ex),
  ]);
  const by = <T extends { encounter_id: string }>(rows: T[]) => { const m = new Map<string, T[]>(); for (const r of rows) { const a = m.get(r.encounter_id) ?? []; a.push(r); m.set(r.encounter_id, a); } return m; };
  const dxBy = by(dx.rows); const prBy = by(procs.rows); const spBy = by(sps.rows); const bedBy = new Map(beds.rows.map((b) => [b.encounter_id, b.n]));

  return base.map((b, i) => {
    const ipd = b.kind === 'ipd';
    const dxs = dxBy.get(b.encounter_id) ?? [];
    const pdx = dxs.find((d) => d.diagnosis_type === 'primary') ?? (ipd ? dxs.filter((d) => d.diagnosis_type === 'admission').at(-1) : undefined);
    const sdx = dxs.filter((d) => d !== pdx && d.diagnosis_type === 'secondary');
    const pr = ipd ? prBy.get(b.encounter_id) ?? [] : [];
    const sp = (spBy.get(b.encounter_id) ?? []).filter((s) => s.payer_id === b.payer_id);
    const pick = <K extends keyof (typeof sp)[number]>(k: K) => sp.map((s) => s[k]).find((v) => v !== null && v !== undefined && v !== '') ?? null;
    const start = ipd ? b.admit_date : b.visit_date;
    const end = ipd ? b.discharge_date : b.visit_date;
    const num = (x: string | null) => (x === null || x === undefined ? null : Number(x));
    const uniq = (a: (string | null | undefined)[]) => [...new Set(a.filter((x): x is string => !!x))];
    const data: RowData = {
      claim_no: b.claim_no, claim_period_from: b.period_from, claim_period_to: b.period_to, claim_sent_date: b.sent_date, payer_code: b.payer_code, payer_name: b.payer_name,
      seq: i + 1, kind: b.kind, kind_ka: ipd ? 'სტაციონარი' : 'ამბულატორია', invoice_number: b.invoice_number, case_date: b.case_date, claimed: Number(b.claimed),
      invoice_total: Number(b.invoice_total), patient_share: Number(b.patient_share),
      policy_no: pick('policy_no'), guarantee_no: pick('guarantee_no'), guarantee_date: pick('guarantee_date'),
      personal_number: b.personal_number, last_name: b.last_name, first_name: b.first_name, full_name: `${b.last_name} ${b.first_name}`, birth_date: b.birth_date,
      sex: b.gender === 'male' ? 'M' : b.gender === 'female' ? 'F' : null,
      age: b.birth_date && start ? yearsBetween(b.birth_date, start) : null,
      adm_no: b.adm_no, admit_date: start, admit_time: ipd ? b.admit_time : b.visit_time, discharge_date: ipd ? b.discharge_date : null, discharge_time: ipd ? b.discharge_time : null,
      los: ipd && start ? Math.max(1, daysBetween(start, end ?? start)) : null, bed_days: ipd ? bedBy.get(b.encounter_id) ?? 0 : null,
      admission_source: ipd ? b.source : null, discharge_type: ipd ? b.discharge_type : null,
      department_code: b.dept_code, department_name: b.dept_name, doctor_name: b.doctor_name,
      pdx_code: pdx?.icd10_code ?? null, pdx_title: pdx?.icd10_title ?? null,
      sdx_codes: uniq(sdx.map((d) => d.icd10_code)).join('\u0001') || null, dx_all_codes: uniq(dxs.map((d) => d.icd10_code)).join('\u0001') || null,
      proc_codes: uniq(pr.map((p) => p.ncsp ?? p.code)).join('\u0001') || null,
      proc_primary: (pr.find((p) => p.is_primary) ?? pr[0])?.ncsp ?? (pr.find((p) => p.is_primary) ?? pr[0])?.code ?? null,
      proc_names: uniq(pr.map((p) => p.name)).join('\u0001') || null,
      drg_code: pick('drg_code'), drg_title: pick('drg_title'), drg_weight: num(pick('drg_weight')), drg_base_rate: num(pick('drg_base_rate')),
      drg_amount: num(pick('drg_amount')), drg_version: pick('drg_version'), drg_mdc: pick('drg_mdc'),
    };
    return { id: b.id, invoice_id: b.invoice_id, kind: b.kind, data };
  });
}
/** სიის გამყოფი შიგნით — \u0001 (შაბლონის list_sep-ით იცვლება) */
export const LIST_SEP = '\u0001';
