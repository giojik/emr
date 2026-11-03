import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../database/db';
import { ageAt, type CalcLine, type CalcPayer, type PatientCtx, type RuleClause, split, type SplitResult } from './payer-engine';
import { tariffRules } from './tariff-rules';

/**
 * წესების ძრავის მონაცემები (0054a): პაციენტის კონტექსტი, ვერსიის პუნქტები, ხაზის კოდები;
 * ამბულატორიის წილი წესებით (opd_payer_mode = rules) და ხაზობრივი წილის ჩაწერა (invoice_line_shares).
 */
type Ex = Kysely<DB> | Transaction<DB>;
const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const r2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;

/** პაციენტი: ასაკი თარიღზე, სქესი, ვიზიტის / ჰოსპიტალიზაციის დიაგნოზები (ICD-10) */
export async function patientCtx(ex: Ex, encounterId: string, on: string | Date): Promise<PatientCtx> {
  const p = await ex.selectFrom('encounters as e').innerJoin('patients as p', 'p.id', 'e.patient_id')
    .select(['p.birth_date', sql<string>`p.gender::text`.as('gender')]).where('e.id', '=', encounterId).executeTakeFirst();
  const dx = await ex.selectFrom('encounter_diagnoses').select('icd10_code').where('encounter_id', '=', encounterId).execute();
  return { age: ageAt(p?.birth_date ?? null, on), sex: p?.gender === 'male' || p?.gender === 'female' ? p.gender : null, dx: dx.map((d) => d.icd10_code) };
}

/** ვერსიების პუნქტები / გამორიცხული კოდები / თანაგადახდა */
export async function versionRules(ex: Ex, ids: (string | null | undefined)[]) {
  const vs = [...new Set(ids.filter((x): x is string => !!x))];
  const out = new Map<string, { clauses: RuleClause[]; excluded_codes: string[]; copay_amount: number }>();
  if (!vs.length) return out;
  const vers = await ex.selectFrom('payer_rule_versions').select(['id', 'excluded_codes', 'copay_amount']).where('id', 'in', vs).execute();
  const cls = await ex.selectFrom('payer_rule_clauses').selectAll().where('version_id', 'in', vs).orderBy('seq').execute();
  for (const v of vers) {
    out.set(v.id, {
      excluded_codes: v.excluded_codes ?? [], copay_amount: Number(v.copay_amount ?? 0),
      clauses: cls.filter((c) => c.version_id === v.id).map((c) => ({
        seq: c.seq, label: c.label, categories: c.categories ?? [], codes: c.codes ?? [], age_min: n(c.age_min), age_max: n(c.age_max), sex: c.sex,
        dx_prefixes: c.dx_prefixes ?? [], effect: c.effect as 'exclude' | 'cover', coverage_pct: n(c.coverage_pct), line_limit: n(c.line_limit),
      })),
    });
  }
  return out;
}

/** ინვოისის ხაზები ძრავისთვის (ტარიფის კოდით) */
export async function calcLines(ex: Ex, invoiceId: string): Promise<CalcLine[]> {
  const ls = await ex.selectFrom('invoice_line_items as l').leftJoin('service_tariffs as t', 't.id', 'l.tariff_id')
    .select(['l.id', 'l.category', 'l.line_total', 'l.package_included', 't.code']).where('l.invoice_id', '=', invoiceId).orderBy('l.created_at').orderBy('l.id').execute();
  return ls.map((l) => ({ id: l.id, category: l.category, line_total: Number(l.line_total), package_included: l.package_included, code: l.code }));
}

/**
 * ამბულატორია: გადამხდელები ინვოისიდან — სახელმწიფო (ჯერ), მერე დაზღვევა / სხვა; პირობები — ვერსია ვიზიტის დღეს (applies_to: all / opd).
 * DRG რეჟიმი ამბულატორიაში არ გამოიყენება (წილი 0); fixed — ვერსიის fixed_amount.
 */
export async function computeOpd(ex: Ex, invoiceId: string): Promise<{ result: SplitResult; versions: Record<string, string | null> } | null> {
  const inv = await ex.selectFrom('invoices as i').innerJoin('encounters as e', 'e.id', 'i.encounter_id')
    .select(['i.id', 'i.encounter_id', 'i.insurance_payer_id', 'i.state_payer_id', sql<string>`to_char(fin_local_date(coalesce(e.start_time, e.created_at)), 'YYYY-MM-DD')`.as('day')])
    .where('i.id', '=', invoiceId).executeTakeFirst();
  if (!inv) return null;
  const slots = [inv.state_payer_id, inv.insurance_payer_id].filter((x): x is string => !!x);
  const payers: CalcPayer[] = [];
  const versions: Record<string, string | null> = {};
  for (const pid of slots) {
    const v = (await sql<{ id: string | null; mode: string; coverage_pct: string; limit_amount: string | null; deductible: string; fixed_amount: string | null;
      writeoff_excess: boolean; excluded_categories: string[] | null }>`SELECT (x).id, (x).mode, (x).coverage_pct, (x).limit_amount, (x).deductible, (x).fixed_amount,
      (x).writeoff_excess, (x).excluded_categories FROM (SELECT payer_rule_version_at(${pid}::uuid, ${inv.day}::date, 'opd') AS x) q`.execute(ex)).rows[0];
    const kind = (await ex.selectFrom('payers').select('kind').where('id', '=', pid).executeTakeFirst())?.kind ?? 'insurance';
    versions[pid] = v?.id ?? null;
    if (!v?.id || v.mode === 'drg') continue;
    payers.push({ id: `${pid}:${v.id}`, payer_id: pid, kind, mode: v.mode, coverage_pct: Number(v.coverage_pct), limit_amount: n(v.limit_amount), deductible: Number(v.deductible),
      fixed_amount: n(v.fixed_amount), drg_weight: null, drg_base_rate: null, writeoff_excess: v.writeoff_excess, excluded_categories: v.excluded_categories ?? [], override_amount: null });
  }
  const rules = await versionRules(ex, Object.values(versions));
  for (const p of payers) { const r = rules.get(p.id.split(':')[1]); if (r) Object.assign(p, r); }
  const ctx = await patientCtx(ex, inv.encounter_id, inv.day);
  return { result: split(await calcLines(ex, invoiceId), payers, ctx), versions };
}

/** ხაზობრივი წილის ჩაწერა (ჩანაცვლება) */
export async function writeLineShares(trx: Transaction<DB>, invoiceId: string, res: SplitResult) {
  await trx.deleteFrom('invoice_line_shares').where('invoice_id', '=', invoiceId).execute();
  const rows: { line_id: string; invoice_id: string; kind: string; payer_id: string | null; amount: string }[] = [];
  for (const l of res.lines ?? []) {
    for (const p of l.payers) if (p.amount) rows.push({ line_id: l.line_id, invoice_id: invoiceId, kind: p.kind === 'state' ? 'state' : p.kind === 'other' ? 'other' : 'insurance', payer_id: p.payer_id, amount: String(p.amount) });
    if (l.writeoff) rows.push({ line_id: l.line_id, invoice_id: invoiceId, kind: 'writeoff', payer_id: null, amount: String(l.writeoff) });
    if (l.patient) rows.push({ line_id: l.line_id, invoice_id: invoiceId, kind: 'patient', payer_id: null, amount: String(l.patient) });
  }
  // ერთ ხაზზე ერთი გადამხდელი ორჯერ ვერ იქნება (ამბ.: სახელმწიფო ≠ დაზღვევა) — აგრეგაცია უსაფრთხოებისთვის
  const agg = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const k = `${r.line_id}|${r.kind}|${r.payer_id ?? ''}`; const cur = agg.get(k);
    agg.set(k, cur ? { ...cur, amount: String(Number(cur.amount) + Number(r.amount)) } : r);
  }
  const vals = [...agg.values()];
  for (let i = 0; i < vals.length; i += 500) await trx.insertInto('invoice_line_shares').values(vals.slice(i, i + 500)).execute();
}

/**
 * ამბ. წილის გადათვლა წესებით (opd_payer_mode = rules): ხელით შესწორებული (payer_shares_manual) / ფინალიზებული / სტაციონარი — არა.
 * force — „წესებით აღდგენა“ (ხელით შესწორების მოხსნა). აბრუნებს ახალ წილებს ან null-ს.
 */
export async function applyOpdRules(trx: Transaction<DB>, invoiceId: string, opts: { force?: boolean; onlyStale?: boolean } = {}) {
  const rules = await tariffRules(trx);
  if (rules.opd_payer_mode !== 'rules') return null;
  const inv = await trx.selectFrom('invoices').select(['id', 'encounter_id', 'payer_shares_manual', 'payer_shares_stale', 'finalized_at', 'insurance_payer_id', 'state_payer_id',
    'insurance_share', 'state_share', sql<boolean>`EXISTS (SELECT 1 FROM inpatient_stays s WHERE s.encounter_id = invoices.encounter_id)`.as('ipd')])
    .where('id', '=', invoiceId).forUpdate().executeTakeFirst();
  if (!inv || inv.ipd || inv.finalized_at) return null;
  if (inv.payer_shares_manual && !opts.force) return null;
  if (opts.onlyStale && !inv.payer_shares_stale) return null;
  if (await trx.selectFrom('fin_claim_items').select('id').where('invoice_id', '=', invoiceId).executeTakeFirst()) return null;   // ქლეიმში — უცვლელი
  const c = await computeOpd(trx, invoiceId);
  if (!c) return null;
  const res = c.result;
  const ins = r2(res.payers.filter((p) => p.kind !== 'state').reduce((s, p) => s + p.amount, 0));
  const st = r2(res.payers.filter((p) => p.kind === 'state').reduce((s, p) => s + p.amount, 0));
  await trx.updateTable('invoices').set({ insurance_share: ins.toFixed(2), state_share: st.toFixed(2), payer_shares_stale: false, payer_shares_at: sql`now()`,
    ...(opts.force && { payer_shares_manual: false, payer_shares_reason: null }) }).where('id', '=', invoiceId).execute();
  await writeLineShares(trx, invoiceId, res);
  return { insurance_share: ins, state_share: st, calc: res, versions: c.versions };
}
