import { sql, type Kysely, type Transaction } from 'kysely';
import { loadEnv } from '../config/env';
import type { DB } from '../database/db';
import { evaluateStay, schemeOf } from '../drg/drg-calc';
import { drgRules, gatherInputs, stayInfo } from '../drg/drg-data';
import { type Cond, evalCond, matchPattern, norm, normPattern, VERSION_SETTINGS_DEFAULT } from '../drg/drg-engine';
import { loadBilling } from '../inpatient/ipd-billing-calc';

/**
 * Claim scrubber (0057): შემთხვევის (ინვოისის) შემოწმება გადამხდელთან გაგზავნამდე.
 *   მზა წესები — ლოგიკა აქ (კოდით), პარამეტრები / სიმძიმე / გავრცელება — scrub_rules-ში;
 *   საკუთარი წესები — პირობები (DRG-ის კონსტრუქტორი): ყველა სრულდება → პრობლემა.
 *   გადამხდელზე მიბმული წესები (საგარანტიო, თანხა, DRG, დუბლიკატი) — თითო გადამხდელზე; დანარჩენი — ერთხელ (თუ ერთი გადამხდელი მაინც შედის გავრცელებაში).
 *   გამონაკლისი (scrub_overrides) — წესი × ინვოისი [× გადამხდელი]: შეცდომა აღარ ბლოკავს.
 */
type Ex = Kysely<DB> | Transaction<DB>;
const TZ = loadEnv().CLINIC_TZ;

export type Mode = 'off' | 'warn' | 'block';
export interface ScrubRules { finalize_check: Mode; claim_check: Mode }
export const SCRUB_RULES_DEFAULT: ScrubRules = { finalize_check: 'block', claim_check: 'block' };
export async function scrubSettings(ex: Ex): Promise<ScrubRules & { enabled: boolean }> {
  const m = await ex.selectFrom('system_modules').select(['enabled', 'settings']).where('code', '=', 'scrubber').executeTakeFirst();
  return { ...SCRUB_RULES_DEFAULT, ...((m?.settings ?? {}) as Partial<ScrubRules>), enabled: m?.enabled ?? false };
}

/** მზა წესები: რომელი გადამხდელზეა მიბმული და რა პარამეტრები აქვს (ადმინისტრირების ეკრანისთვის) */
export const PAYER_RULES = new Set(['DRG_NOT_CONFIRMED', 'DRG_MISMATCH', 'DRG_FALLBACK', 'GUARANTEE_MISSING', 'GUARANTEE_FILE', 'GUARANTEE_EXPIRED', 'PAYER_ZERO', 'PAYER_OVERRIDE', 'DUPLICATE_STAY']);
export const BUILTIN_PARAMS: Record<string, { key: string; label: string; type: 'int' | 'patterns' }[]> = {
  LOS_LONG: [{ key: 'days', label: 'დღეები (მეტი)', type: 'int' }],
  DX_SEX: [{ key: 'female_only', label: 'მხოლოდ ქალის დიაგნოზები (კოდი / დიაპაზონი)', type: 'patterns' }, { key: 'male_only', label: 'მხოლოდ კაცის დიაგნოზები', type: 'patterns' }],
};
export const GROUP_KA: Record<string, string> = { patient: 'პაციენტი', diagnosis: 'დიაგნოზი', drg: 'DRG', dates: 'თარიღები', guarantee: 'საგარანტიო', amount: 'თანხა',
  procedure: 'პროცედურა', document: 'დოკუმენტი', duplicate: 'დუბლიკატი', custom: 'საკუთარი' };
/** საკუთარ წესში აკრძალული ველები (ვერსიის გარეშე არ ითვლება) */
export const CUSTOM_FORBIDDEN = new Set(['cc']);

export interface RuleRow {
  code: string; builtin: boolean; grp: string; title: string; message: string | null; severity: string; is_active: boolean; applies_kind: string;
  payer_kinds: string[]; payer_ids: string[]; params: unknown; conditions: unknown; allow_override: boolean;
}
export interface Issue {
  code: string; group: string; title: string; message: string; severity: 'error' | 'warn'; payer_id: string | null; payer_name: string | null; detail: string | null;
  allow_override: boolean; overridden: { id: string; reason: string; by: string; at: Date } | null;
}
export interface ScrubResult { invoice_id: string; kind: 'ipd' | 'opd'; checked: boolean; issues: Issue[]; errors: number; warnings: number; overridden: number }

interface Payer { payer_id: string; name: string; kind: string; stay_payer_id: string | null; mode: string | null; amount: number; guarantee_no: string | null; file_id: string | null;
  valid_until: string | null; override_amount: string | null; drg_code: string | null }

/**
 * ინვოისის შემოწმება. payerId — მხოლოდ ერთი გადამხდელის ჭრილში (ქლეიმი); გადამხდელის გარეშე შემთხვევა — არ მოწმდება.
 * rules — წინასწარ ჩატვირთული (სიის შემოწმებისას).
 */
export async function scrubInvoice(ex: Ex, invoiceId: string, opts: { payerId?: string; rules?: RuleRow[] } = {}): Promise<ScrubResult> {
  const inv = await ex.selectFrom('invoices as i').innerJoin('encounters as e', 'e.id', 'i.encounter_id').innerJoin('patients as p', 'p.id', 'e.patient_id')
    .leftJoin('inpatient_stays as st', 'st.encounter_id', 'i.encounter_id')
    .select(['i.id', 'i.encounter_id', 'i.finalized_at', 'i.insurance_payer_id', 'i.state_payer_id', 'i.insurance_share', 'i.state_share', 'p.id as patient_id', 'p.personal_number',
      'p.citizenship', sql<string>`p.gender::text`.as('gender'), 'st.encounter_id as stay_id'])
    .where('i.id', '=', invoiceId).executeTakeFirst();
  const out: ScrubResult = { invoice_id: invoiceId, kind: 'opd', checked: false, issues: [], errors: 0, warnings: 0, overridden: 0 };
  if (!inv) return out;
  const ipd = !!inv.stay_id; out.kind = ipd ? 'ipd' : 'opd';
  const eid = inv.encounter_id;

  // გადამხდელები
  let payers: Payer[] = [];
  if (ipd) {
    const rows = await ex.selectFrom('stay_payers as sp').innerJoin('payers as p', 'p.id', 'sp.payer_id')
      .select(['sp.id', 'sp.payer_id', 'p.name', 'p.kind', 'sp.mode', 'sp.guarantee_no', 'sp.file_id', sql<string | null>`to_char(sp.valid_until, 'YYYY-MM-DD')`.as('valid_until'),
        'sp.override_amount', 'sp.drg_code', 'sp.covered_amount'])
      .where('sp.encounter_id', '=', eid).where('sp.status', '=', 'active').orderBy('sp.seq').execute();
    let calc = new Map<string, number>();
    if (!inv.finalized_at && rows.length) calc = new Map((await loadBilling(ex, eid))?.calc.payers.map((x) => [x.id, x.amount]) ?? []);
    payers = rows.map((r) => ({ payer_id: r.payer_id, name: r.name, kind: r.kind, stay_payer_id: r.id, mode: r.mode, guarantee_no: r.guarantee_no, file_id: r.file_id, valid_until: r.valid_until,
      override_amount: r.override_amount, drg_code: r.drg_code, amount: inv.finalized_at ? Number(r.covered_amount ?? 0) : calc.get(r.id) ?? 0 }));
  } else {
    const ids = [inv.insurance_payer_id, inv.state_payer_id].filter((x): x is string => !!x);
    const ps = ids.length ? await ex.selectFrom('payers').select(['id', 'name', 'kind']).where('id', 'in', ids).execute() : [];
    for (const [id, amt] of [[inv.insurance_payer_id, inv.insurance_share], [inv.state_payer_id, inv.state_share]] as const) {
      const p = ps.find((x) => x.id === id);
      if (p) payers.push({ payer_id: p.id, name: p.name, kind: p.kind, stay_payer_id: null, mode: null, amount: Number(amt ?? 0), guarantee_no: null, file_id: null, valid_until: null, override_amount: null, drg_code: null });
    }
  }
  if (opts.payerId) payers = payers.filter((p) => p.payer_id === opts.payerId);
  if (!payers.length) return out;
  out.checked = true;

  const rules = (opts.rules ?? await loadRules(ex)).filter((r) => r.is_active && (r.applies_kind === 'all' || r.applies_kind === out.kind));
  const inScope = (r: RuleRow, p: Payer) => (!r.payer_kinds.length || r.payer_kinds.includes(p.kind)) && (!r.payer_ids.length || r.payer_ids.includes(p.payer_id));
  const add = (r: RuleRow, p: Payer | null, detail: string | null) => out.issues.push({ code: r.code, group: r.grp, title: r.title, message: r.message?.trim() || r.title,
    severity: r.severity as 'error' | 'warn', payer_id: p?.payer_id ?? null, payer_name: p?.name ?? null, detail, allow_override: r.allow_override, overridden: null });

  // საერთო მონაცემები (ზარმაცად)
  const dx = await ex.selectFrom('encounter_diagnoses').select(['icd10_code', 'diagnosis_type']).where('encounter_id', '=', eid).execute();
  const st = ipd ? await stayInfo(ex, eid) : undefined;
  const endDate = st ? (st.status === 'discharged' && st.end_date ? st.end_date : st.today) : null;
  const P = (r: RuleRow) => (r.params ?? {}) as Record<string, unknown>;

  for (const r of rules) {
    const scoped = payers.filter((p) => inScope(r, p));
    if (!scoped.length) continue;
    if (!r.builtin) {
      if (!ipd || !st) continue;
      const { inputs } = await gatherInputs(ex, st, VERSION_SETTINGS_DEFAULT);
      const conds = (r.conditions ?? []) as Cond[];
      if (conds.length && conds.every((c) => evalCond(c, inputs, new Map(), 'none').ok)) add(r, null, null);
      continue;
    }
    switch (r.code) {
      case 'PATIENT_PN':
        if ((inv.citizenship ?? 'GEO') === 'GEO' && !/^\d{11}$/.test(inv.personal_number ?? '')) add(r, null, inv.personal_number ? `„${inv.personal_number}“` : 'არ არის');
        break;
      case 'PDX_MISSING':
        if (!dx.some((d) => d.diagnosis_type === 'primary')) add(r, null, null);
        break;
      case 'ICD_INVALID': {
        const codes = [...new Set(dx.map((d) => d.icd10_code))];
        if (!codes.length) break;
        const ok = new Set((await ex.selectFrom('icd10_codes').select('code').where('code', 'in', codes).where('is_active', '=', true).execute()).map((x) => x.code));
        const bad = codes.filter((c) => !ok.has(c));
        if (bad.length) add(r, null, bad.join(', '));
        break;
      }
      case 'ICD_NONSPECIFIC': {
        const codes = [...new Set(dx.map((d) => d.icd10_code))].filter((c) => !c.includes('.'));
        if (!codes.length) break;
        const has = (await sql<{ c: string }>`SELECT DISTINCT left(code, 3) AS c FROM icd10_codes WHERE is_active AND code LIKE '%.%' AND left(code, 3) = ANY(${codes}::text[])`.execute(ex)).rows.map((x) => x.c);
        const bad = codes.filter((c) => has.includes(c));
        if (bad.length) add(r, null, bad.join(', '));
        break;
      }
      case 'DX_SEX': {
        const g = inv.gender === 'female' ? 'F' : inv.gender === 'male' ? 'M' : null;
        if (!g) break;
        const pats = ((P(r)[g === 'F' ? 'male_only' : 'female_only'] ?? []) as string[]).map(normPattern);
        const bad = [...new Set(dx.map((d) => d.icd10_code))].filter((c) => pats.some((p) => matchPattern(p, c)));
        if (bad.length) add(r, null, `${bad.join(', ')} — პაციენტი ${g === 'F' ? 'ქალია' : 'კაცია'}`);
        break;
      }
      case 'DRG_NOT_CONFIRMED': case 'DRG_MISMATCH': case 'DRG_FALLBACK': {
        if (!ipd || !st) break;
        const dr = await drgRules(ex);
        if (!dr.enabled) break;
        for (const p of scoped.filter((x) => x.mode === 'drg')) {
          const sid = await schemeOf(ex, p.payer_id);
          if (!sid) continue;
          const ev = await evaluateStay(ex, eid, sid, { rules: dr, st });
          if (!ev.version) continue;
          if (r.code === 'DRG_NOT_CONFIRMED' && (!ev.current || ev.stale)) add(r, p, ev.current ? ev.stale_reason : 'დადასტურება არ არის');
          if (r.code === 'DRG_MISMATCH' && ev.current && p.drg_code !== ev.current.final_code) add(r, p, `${p.drg_code ?? '—'} ≠ ${ev.current.final_code}`);
          if (r.code === 'DRG_FALLBACK' && ev.current) {
            const fb = (await ex.selectFrom('drg_versions').select(sql<string | null>`settings->>'fallback_code'`.as('f')).where('id', '=', ev.current.version_id).executeTakeFirst())?.f;
            if (fb && fb === ev.current.final_code) add(r, p, fb);
          }
        }
        break;
      }
      case 'LINE_OUTSIDE_STAY': {
        if (!st) break;
        const lines = await ex.selectFrom('invoice_line_items').select(['description', sql<string>`to_char(service_date, 'YYYY-MM-DD')`.as('d')])
          .where('invoice_id', '=', invoiceId).where((eb) => eb.or([eb('service_date', '<', sql<string>`${st.admit_date}::date`), eb('service_date', '>', sql<string>`${endDate}::date`)])).limit(5).execute();
        if (lines.length) add(r, null, lines.map((l) => `${l.d} ${l.description}`).join('; '));
        break;
      }
      case 'LOS_LONG': {
        if (!st) break;
        const n = (await ex.selectFrom('stay_bed_days').select(sql<number>`count(*)::int`.as('n')).where('encounter_id', '=', eid).executeTakeFirstOrThrow()).n;
        const lim = Number(P(r).days ?? 30);
        if (n > lim) add(r, null, `${n} დღე (> ${lim})`);
        break;
      }
      case 'GUARANTEE_MISSING': for (const p of scoped) if (!p.guarantee_no?.trim()) add(r, p, null); break;
      case 'GUARANTEE_FILE': for (const p of scoped) if (!p.file_id) add(r, p, null); break;
      case 'GUARANTEE_EXPIRED':
        if (!st) break;
        for (const p of scoped) if (p.valid_until && (p.valid_until < st.admit_date || (endDate && p.valid_until < endDate))) add(r, p, `ვადა ${p.valid_until}`);
        break;
      case 'PAYER_ZERO': for (const p of scoped) if (!(p.amount > 0)) add(r, p, null); break;
      case 'PAYER_OVERRIDE': for (const p of scoped) if (p.override_amount !== null) add(r, p, `${Number(p.override_amount).toFixed(2)}`); break;
      case 'OR_NOTE_UNSIGNED': {
        if (!ipd) break;
        const c = (await sql<{ case_no: string }>`SELECT c.case_no FROM or_cases c WHERE c.encounter_id = ${eid}::uuid AND c.status = 'completed'
          AND NOT EXISTS (SELECT 1 FROM or_op_notes n WHERE n.case_id = c.id AND n.status = 'signed' AND n.superseded_at IS NULL)`.execute(ex)).rows;
        if (c.length) add(r, null, c.map((x) => x.case_no).join(', '));
        break;
      }
      case 'OR_NCSP_MISSING': {
        if (!ipd) break;
        const c = (await sql<{ x: string }>`
          SELECT c.case_no || ': ' || coalesce(pr.p->>'name', '?') AS x FROM or_cases c
            JOIN or_op_notes n ON n.case_id = c.id AND n.status = 'signed' AND n.superseded_at IS NULL CROSS JOIN LATERAL jsonb_array_elements(n.procedures) pr(p)
           WHERE c.encounter_id = ${eid}::uuid AND c.status = 'completed' AND coalesce(pr.p->>'ncsp_code', '') = ''
          UNION ALL
          SELECT c.case_no || ': ' || p.name FROM or_cases c JOIN or_case_procedures cp ON cp.case_id = c.id JOIN or_procedures p ON p.id = cp.procedure_id
           WHERE c.encounter_id = ${eid}::uuid AND c.status = 'completed' AND p.ncsp_code IS NULL
             AND NOT EXISTS (SELECT 1 FROM or_op_notes n WHERE n.case_id = c.id AND n.status = 'signed' AND n.superseded_at IS NULL)`.execute(ex)).rows;
        if (c.length) add(r, null, c.slice(0, 5).map((x) => x.x).join('; '));
        break;
      }
      case 'EPICRISIS_UNSIGNED': {
        if (!ipd) break;
        const e = await ex.selectFrom('epicrises').select('status').where('encounter_id', '=', eid).executeTakeFirst();
        if (e?.status !== 'signed') add(r, null, e ? `სტატუსი: ${e.status}` : 'არ არის');
        break;
      }
      case 'DUPLICATE_STAY': {
        if (!st) break;
        for (const p of scoped) {
          const d = (await sql<{ adm_no: string }>`SELECT s.adm_no FROM inpatient_stays s JOIN stay_payers sp ON sp.encounter_id = s.encounter_id AND sp.status = 'active' AND sp.payer_id = ${p.payer_id}::uuid
             WHERE s.patient_id = ${inv.patient_id}::uuid AND s.encounter_id <> ${eid}::uuid AND s.status <> 'cancelled'
               AND (s.admitted_at AT TIME ZONE ${TZ})::date <= ${endDate}::date AND coalesce((s.ended_at AT TIME ZONE ${TZ})::date, (now() AT TIME ZONE ${TZ})::date) >= ${st.admit_date}::date
             LIMIT 3`.execute(ex)).rows;
          if (d.length) add(r, p, d.map((x) => x.adm_no).join(', '));
        }
        break;
      }
    }
  }

  // გამონაკლისები
  const ov = await ex.selectFrom('scrub_overrides as o').innerJoin('users as u', 'u.id', 'o.created_by')
    .select(['o.id', 'o.rule_code', 'o.payer_id', 'o.reason', 'o.created_at', sql<string>`u.first_name || ' ' || u.last_name`.as('by')])
    .where('o.invoice_id', '=', invoiceId).where('o.revoked_at', 'is', null).execute();
  for (const i of out.issues) {
    const o = ov.find((x) => x.rule_code === i.code && (x.payer_id === null || x.payer_id === i.payer_id));
    if (o && i.allow_override) i.overridden = { id: o.id, reason: o.reason, by: o.by, at: o.created_at };
  }
  out.errors = out.issues.filter((i) => i.severity === 'error' && !i.overridden).length;
  out.warnings = out.issues.filter((i) => i.severity === 'warn' && !i.overridden).length;
  out.overridden = out.issues.filter((i) => i.overridden).length;
  const sev = (i: Issue) => (i.overridden ? 2 : i.severity === 'error' ? 0 : 1);
  out.issues.sort((a, b) => sev(a) - sev(b));
  return out;
}

export async function loadRules(ex: Ex): Promise<RuleRow[]> {
  return ex.selectFrom('scrub_rules').select(['code', 'builtin', 'grp', 'title', 'message', 'severity', 'is_active', 'applies_kind', 'payer_kinds', 'payer_ids', 'params', 'conditions', 'allow_override'])
    .orderBy('sort_order').orderBy('code').execute() as Promise<RuleRow[]>;
}

export const scrubSummary = (r: ScrubResult) => `${r.errors} შეცდომა, ${r.warnings} გაფრთხილება`;
export const errorText = (r: ScrubResult) => r.issues.filter((i) => i.severity === 'error' && !i.overridden).map((i) => `${i.message}${i.detail ? ` (${i.detail})` : ''}`).join('; ');
export { norm };
