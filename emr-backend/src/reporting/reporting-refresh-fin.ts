import { sql, type RawBuilder, type Transaction } from 'kysely';
import type { Database } from '../database/database.module';
import type { DB } from '../database/db';
import { revenueCte } from '../finance/finance-reports';
import type { FinRules } from '../finance/finance-rules';
import { n, r2 } from './reporting-common';

/**
 * 0063: ფინანსური ფაქტები — RptRefreshService.finance()-იდან (იგივე ტრანზაქცია / lock / დახურული თვეები).
 *  • rpt_fact_payer — შემოსავალი გადამხდელით (revenueCte, იგივე revenue_basis / revenue_dept_basis);
 *  • rpt_fact_doctor_rev — შემოსავალი ექიმზე (შემსრულებელი / დამნიშნავი), ხაზის კავშირებით;
 *  • rpt_balance_snapshot — დებიტორები (გადამხდელი, პაციენტი) და კრედიტორები (მომწოდებელი) — დღევანდელ დღეზე.
 */
type Trx = Transaction<DB>;

async function replace(trx: Trx, table: 'rpt_fact_payer' | 'rpt_fact_doctor_rev', from: string, to: string, closed: string[], rows: Record<string, unknown>[]) {
  await sql`DELETE FROM ${sql.table(table)} WHERE day BETWEEN ${from}::date AND ${to}::date AND NOT (to_char(day, 'YYYY-MM') = ANY(${closed}::text[]))`.execute(trx);
  for (let i = 0; i < rows.length; i += 1000) await trx.insertInto(table).values(rows.slice(i, i + 1000) as never).execute();
  return rows.length;
}

export async function finExtraFacts(rdb: Database, trx: Trx, from: string, to: string, rules: FinRules, closed: string[]) {
  const dk: RawBuilder<unknown> = rules.revenue_dept_basis === 'ordering' ? sql`rv.ord` : sql`rv.perf`;
  // ხაზი → ექიმი: შემსრულებელი / დამნიშნავი
  const rows = (await sql<{ day: string; dept: string | null; payer_id: string | null; kind: string; category: string; perf: string | null; ref: string | null; amount: string }>`
    WITH ${revenueCte(rules.revenue_basis, from, to)},
    lx AS (
      SELECT l.id AS line_id,
             CASE WHEN l.or_case_id IS NOT NULL THEN oc.surgeon_id
                  WHEN l.consultation_id IS NOT NULL THEN coalesce(c.answered_by, c.target_doctor_id)
                  WHEN l.dx_order_item_id IS NOT NULL THEN CASE WHEN di.section = 'lab' THEN NULL ELSE di.validated_by END
                  ELSE e.attending_doctor_id END AS perf,
             CASE WHEN l.or_case_id IS NOT NULL THEN oc.surgeon_id
                  WHEN l.consultation_id IS NOT NULL THEN c.requested_by
                  WHEN l.dx_order_item_id IS NOT NULL THEN di.ordered_by
                  ELSE e.attending_doctor_id END AS ref
        FROM invoice_line_items l JOIN invoices i ON i.id = l.invoice_id JOIN encounters e ON e.id = i.encounter_id
        LEFT JOIN or_cases oc ON oc.id = l.or_case_id LEFT JOIN consultations c ON c.id = l.consultation_id LEFT JOIN dx_order_items di ON di.id = l.dx_order_item_id
       WHERE l.id IN (SELECT DISTINCT line_id FROM rv))
    SELECT to_char(rv.rdate, 'YYYY-MM-DD') AS day, ${dk} AS dept, rv.payer_id, rv.kind, rv.category, lx.perf, lx.ref, sum(rv.amount)::text AS amount
      FROM rv LEFT JOIN lx ON lx.line_id = rv.line_id GROUP BY 1, 2, 3, 4, 5, 6, 7`.execute(rdb)).rows;
  const isClosed = (day: string) => closed.includes(day.slice(0, 7));
  const payer = new Map<string, Record<string, unknown>>();
  const doc = new Map<string, Record<string, unknown>>();
  const add = (m: Map<string, Record<string, unknown>>, k: string, base: Record<string, unknown>, v: number) => {
    const r = m.get(k); if (r) r.amount = n(r.amount) + v; else m.set(k, { ...base, amount: v });
  };
  for (const x of rows) {
    if (isClosed(x.day)) continue;
    const v = n(x.amount);
    add(payer, `${x.day}|${x.dept}|${x.payer_id}|${x.kind}`, { day: x.day, department_id: x.dept, payer_id: x.payer_id, kind: x.kind }, v);
    for (const [basis, d] of [['performer', x.perf], ['referrer', x.ref]] as const)
      add(doc, `${x.day}|${x.dept}|${d}|${basis}|${x.category}|${x.kind}`, { day: x.day, department_id: x.dept, doctor_id: d, basis, category: x.category, kind: x.kind }, v);
  }
  const fin = (m: Map<string, Record<string, unknown>>) => [...m.values()].map((r) => ({ ...r, amount: r2(n(r.amount)) })).filter((r) => r.amount !== 0);
  return { payer: await replace(trx, 'rpt_fact_payer', from, to, closed, fin(payer)), doctor_rev: await replace(trx, 'rpt_fact_doctor_rev', from, to, closed, fin(doc)) };
}

/** ვადაგადაცილების ჯგუფი (როგორც /finance/receivables და /payables/aging): due — ვადა (NULL → 90+) */
const bucket = (asOf: string, due: string | null) => {
  if (!due) return 'd90';
  const late = Math.round((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / 86_400_000);
  return late <= 0 ? 'not_due' : late <= 30 ? 'd1_30' : late <= 60 ? 'd31_60' : late <= 90 ? 'd61_90' : 'd90';
};
type Bal = { day: string; kind: string; party_id: string | null; party_name: string; party_kind: string | null; unclaimed: number; draft: number; not_due: number; d1_30: number;
  d31_60: number; d61_90: number; d90: number; total: number; items: number };

/** დებიტორები / კრედიტორები დღევანდელ დღეზე (წინა სურათი ამ დღისთვის იცვლება) */
export async function balanceSnapshot(rdb: Database, trx: Trx, day: string) {
  const out = new Map<string, Bal>();
  const row = (kind: string, id: string | null, name: string, pk: string | null) => {
    const k = `${kind}|${id}`;
    let r = out.get(k);
    if (!r) { r = { day, kind, party_id: id, party_name: name, party_kind: pk, unclaimed: 0, draft: 0, not_due: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90: 0, total: 0, items: 0 }; out.set(k, r); }
    return r;
  };
  // გადამხდელი: ქლეიმი (მონახაზი / გაგზავნილის ნაშთი) + შეუტანელი (finance-claims.candidates-ის წესით, ყველა გადამხდელზე)
  const payers = new Map((await rdb.selectFrom('payers').select(['id', 'name', 'kind']).execute()).map((p) => [p.id, p]));
  const claims = (await sql<{ payer_id: string; status: string; due_date: string | null; out: string }>`
    SELECT c.payer_id, c.status, to_char(c.due_date, 'YYYY-MM-DD') AS due_date, (ci.claimed - ci.paid - ci.resolved_amount)::text AS out
      FROM fin_claim_items ci JOIN fin_claims c ON c.id = ci.claim_id WHERE c.status IN ('draft', 'sent', 'partial')`.execute(rdb)).rows;
  for (const x of claims) {
    const p = payers.get(x.payer_id); const v = n(x.out);
    if (!p || v <= 0) continue;
    const r = row('ar_payer', p.id, p.name, p.kind);
    if (x.status === 'draft') r.draft += v; else { const b = bucket(day, x.due_date) as 'not_due'; r[b] += v; }
    r.items++;
  }
  const unclaimed = (await sql<{ payer_id: string; amount: string; n: number }>`
    SELECT payer_id, sum(amount)::text AS amount, count(*)::int AS n FROM (
      SELECT sp.payer_id, i.id, sum(sp.covered_amount) AS amount
        FROM stay_payers sp JOIN inpatient_stays st ON st.encounter_id = sp.encounter_id JOIN invoices i ON i.encounter_id = st.encounter_id
       WHERE sp.status = 'active' AND sp.covered_amount > 0 AND st.status <> 'cancelled' AND i.finalized_at IS NOT NULL AND fin_local_date(i.finalized_at) <= ${day}::date
         AND NOT EXISTS (SELECT 1 FROM fin_claim_items ci WHERE ci.invoice_id = i.id AND ci.payer_id = sp.payer_id)
       GROUP BY sp.payer_id, i.id
      UNION ALL
      SELECT x.payer_id, i.id, x.amount
        FROM invoices i JOIN encounters e ON e.id = i.encounter_id
        CROSS JOIN LATERAL (VALUES (i.insurance_payer_id, i.insurance_share), (i.state_payer_id, i.state_share)) AS x(payer_id, amount)
       WHERE x.payer_id IS NOT NULL AND x.amount > 0 AND e.status::text <> 'cancelled' AND NOT EXISTS (SELECT 1 FROM inpatient_stays s WHERE s.encounter_id = i.encounter_id)
         AND fin_local_date(i.created_at) <= ${day}::date
         AND NOT EXISTS (SELECT 1 FROM fin_claim_items ci WHERE ci.invoice_id = i.id AND ci.payer_id = x.payer_id)) u
     GROUP BY payer_id`.execute(rdb)).rows;
  for (const x of unclaimed) {
    const p = payers.get(x.payer_id); if (!p) continue;
    const r = row('ar_payer', p.id, p.name, p.kind); r.unclaimed += n(x.amount); r.items += x.n;
  }
  // პაციენტის ვალი: პაციენტის წილი − გადახდა; ვადა — ანგარიშის თარიღი (სტაც. — ფინალიზაცია)
  const pat = (await sql<{ d: string; bal: string }>`
    SELECT to_char(CASE WHEN st.encounter_id IS NOT NULL THEN fin_local_date(i.finalized_at) ELSE fin_local_date(i.created_at) END, 'YYYY-MM-DD') AS d,
           (i.patient_share - coalesce((SELECT sum(p.amount) FROM payments p WHERE p.invoice_id = i.id), 0))::text AS bal
      FROM invoices i JOIN encounters e ON e.id = i.encounter_id LEFT JOIN inpatient_stays st ON st.encounter_id = i.encounter_id
     WHERE e.status::text <> 'cancelled' AND (st.encounter_id IS NULL OR (st.status <> 'cancelled' AND i.finalized_at IS NOT NULL))
       AND i.patient_share > coalesce((SELECT sum(p.amount) FROM payments p WHERE p.invoice_id = i.id), 0)`.execute(rdb)).rows;
  for (const x of pat) {
    if (x.d > day) continue;
    const r = row('ar_patient', null, 'პაციენტები', null); const b = bucket(day, x.d) as 'not_due';
    r[b] += n(x.bal); r.items++;
  }
  // მომწოდებელი: გატარებული ინვოისის ნაშთი (₾, ინვოისის კურსით)
  const ap = (await sql<{ supplier_id: string; name: string; due: string; bal: string }>`
    SELECT i.supplier_id, s.name, to_char(i.due_date, 'YYYY-MM-DD') AS due,
           ((i.total - coalesce((SELECT sum(p.amount) FROM ap_payments p WHERE p.invoice_id = i.id AND NOT p.is_void AND p.pay_date <= ${day}::date), 0)) * i.fx_rate)::text AS bal
      FROM ap_invoices i JOIN stock_suppliers s ON s.id = i.supplier_id WHERE i.status = 'posted' AND i.invoice_date <= ${day}::date`.execute(rdb)).rows;
  for (const x of ap) {
    const v = r2(n(x.bal)); if (v <= 0) continue;
    const r = row('ap', x.supplier_id, x.name, null); const b = bucket(day, x.due) as 'not_due';
    r[b] += v; r.items++;
  }
  const rows = [...out.values()].map((r) => {
    for (const k of ['unclaimed', 'draft', 'not_due', 'd1_30', 'd31_60', 'd61_90', 'd90'] as const) r[k] = r2(r[k]);
    r.total = r2(r.unclaimed + r.draft + r.not_due + r.d1_30 + r.d31_60 + r.d61_90 + r.d90);
    return r;
  }).filter((r) => r.total > 0);
  await sql`DELETE FROM rpt_balance_snapshot WHERE day = ${day}::date`.execute(trx);
  if (rows.length) await trx.insertInto('rpt_balance_snapshot').values(rows as never).execute();
  return rows.length;
}
