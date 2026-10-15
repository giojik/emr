import { BadRequestException, Controller, Get, Injectable, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { sql, type RawBuilder } from 'kysely';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/roles';
import { DATE_RE, type Ex, FinCommon, n, r2, type Scope, toCsv, TZ } from './finance-common';
import { FIN_READ, type FinRules, PAYER_KIND_KA } from './finance-rules';

type Basis = FinRules['revenue_basis'];
type DeptBasis = FinRules['revenue_dept_basis'];
type StockBasis = FinRules['dept_consumption_basis'];
export const KINDS = ['patient', 'insurance', 'state', 'other', 'writeoff', 'denied', 'undetermined'] as const;
type Kind = (typeof KINDS)[number];
const COMMON = 'საერთო (განყოფილების გარეშე)';

/**
 * შემოსავლის ხაზები (CTE „rv“): ინვოისის ხაზი × გადამხდელის წილი — ხაზობრივი (0054a: invoice_line_shares), თუ არა — pro rata ინვოისიდან.
 *   საწოლდღე / ვენტილაციის დღე — დღეებად (stay_bed_days / stay_vent_days): თარიღი და განყოფილება — თავისი დღის;
 *   სხვა ხაზი — service_date, ordering / performing (0053); პაკეტში შემავალი ხაზი არ ითვლება.
 *   წილები: პაციენტი, ჩამოწერა (DRG / ფიქს.), გადამხდელები (სტაც. — stay_payers.covered_amount; ამბ. — invoices.*_payer_id);
 *   ქლეიმის უარი, ჩამოწერილი → გადამხდელს აკლდება, „denied“-ს ემატება; დაუფინალებელი სტაციონარი — „undetermined“.
 *   revenue_basis = finalized: ამბ. — ინვოისის თარიღი, სტაც. — ფინალიზაციის თარიღი (დაუფინალებელი არ ითვლება).
 */
export function revenueCte(basis: Basis, from: string, to: string): RawBuilder<unknown> {
  return sql`
    inv AS (
      SELECT i.id, i.encounter_id, i.patient_share, i.insurance_share, i.state_share, i.writeoff_amount, i.finalized_at, i.created_at,
             i.insurance_payer_id, i.state_payer_id, (st.encounter_id IS NOT NULL) AS ipd
        FROM invoices i JOIN encounters e ON e.id = i.encounter_id LEFT JOIN inpatient_stays st ON st.encounter_id = i.encounter_id
       WHERE e.status::text <> 'cancelled' AND st.status IS DISTINCT FROM 'cancelled'),
    ln AS (
      SELECT l.id AS line_id, inv.id AS invoice_id, 'bed'::text AS category, d.day AS sdate, d.department_id AS ord, d.department_id AS perf,
             coalesce(d.unit_price, l.unit_price)::numeric AS amount, l.line_total::numeric AS line_total
        FROM invoice_line_items l JOIN inv ON inv.id = l.invoice_id
        JOIN stay_bed_days d ON d.encounter_id = inv.encounter_id AND d.tariff_id = l.tariff_id AND d.package_included = l.package_included
             AND d.price_item_id IS NOT DISTINCT FROM l.price_item_id AND (d.unit_price IS NULL OR d.unit_price = l.unit_price)
       WHERE l.category = 'bed' AND NOT l.package_included
      UNION ALL
      SELECT l.id, inv.id, 'ventilation', v.day, fin_enc_department(inv.encounter_id, v.day), fin_enc_department(inv.encounter_id, v.day),
             coalesce(v.unit_price, l.unit_price)::numeric, l.line_total::numeric
        FROM invoice_line_items l JOIN inv ON inv.id = l.invoice_id
        JOIN stay_vent_days v ON v.encounter_id = inv.encounter_id AND v.tariff_id = l.tariff_id AND v.package_included = l.package_included
             AND v.price_item_id IS NOT DISTINCT FROM l.price_item_id AND (v.unit_price IS NULL OR v.unit_price = l.unit_price)
       WHERE l.category = 'ventilation' AND NOT l.package_included
      UNION ALL
      SELECT l.id, inv.id, l.category::text, l.service_date, l.ordering_department_id, l.performing_department_id, l.line_total::numeric, l.line_total::numeric
        FROM invoice_line_items l JOIN inv ON inv.id = l.invoice_id
       WHERE l.category NOT IN ('bed', 'ventilation') AND NOT l.package_included),
    dl AS (
      SELECT ln.*, CASE WHEN ${basis} = 'finalized' THEN (CASE WHEN inv.ipd THEN fin_local_date(inv.finalized_at) ELSE fin_local_date(inv.created_at) END)
                        ELSE ln.sdate END AS rdate
        FROM ln JOIN inv ON inv.id = ln.invoice_id
       WHERE ${basis} <> 'finalized' OR NOT inv.ipd OR inv.finalized_at IS NOT NULL),
    sp AS (
      SELECT inv.id AS invoice_id, 'patient'::text AS kind, NULL::uuid AS payer_id, inv.patient_share::numeric AS amount FROM inv WHERE NOT inv.ipd OR inv.finalized_at IS NOT NULL
      UNION ALL
      SELECT inv.id, 'writeoff', NULL, inv.writeoff_amount FROM inv WHERE inv.writeoff_amount > 0 AND (NOT inv.ipd OR inv.finalized_at IS NOT NULL)
      UNION ALL
      SELECT inv.id, py.kind::text, py.id, s.covered_amount FROM inv JOIN stay_payers s ON s.encounter_id = inv.encounter_id AND s.status = 'active'
        JOIN payers py ON py.id = s.payer_id WHERE inv.ipd AND inv.finalized_at IS NOT NULL AND s.covered_amount > 0
      UNION ALL
      SELECT inv.id, CASE WHEN py.kind = 'other' THEN 'other' ELSE 'insurance' END, inv.insurance_payer_id, inv.insurance_share
        FROM inv LEFT JOIN payers py ON py.id = inv.insurance_payer_id WHERE NOT inv.ipd AND inv.insurance_share > 0
      UNION ALL
      SELECT inv.id, 'state', inv.state_payer_id, inv.state_share FROM inv WHERE NOT inv.ipd AND inv.state_share > 0
      UNION ALL
      SELECT inv.id, 'undetermined', NULL, 1 FROM inv WHERE inv.ipd AND inv.finalized_at IS NULL
      UNION ALL
      SELECT ci.invoice_id, py.kind::text, ci.payer_id, -ci.resolved_amount FROM fin_claim_items ci JOIN payers py ON py.id = ci.payer_id
        JOIN inv ON inv.id = ci.invoice_id WHERE ci.resolution = 'writeoff'
      UNION ALL
      SELECT ci.invoice_id, 'denied', ci.payer_id, ci.resolved_amount FROM fin_claim_items ci JOIN inv ON inv.id = ci.invoice_id WHERE ci.resolution = 'writeoff'),
    sw AS (SELECT sp.*, sp.amount / nullif(sum(sp.amount) OVER (PARTITION BY sp.invoice_id), 0) AS w FROM sp),
    -- 0054a: ზუსტი ხაზობრივი წილი (invoice_line_shares — სტაც. ფინალიზაცია / ამბ. წესებით); ქლეიმის უარი (ჩამოწერილი) — გადამხდელის ხაზებზე პროპორციულად
    ls AS (
      SELECT s.invoice_id, s.line_id, s.kind::text AS kind, s.payer_id, s.amount, l.line_total
        FROM invoice_line_shares s JOIN invoice_line_items l ON l.id = s.line_id JOIN inv ON inv.id = s.invoice_id
       WHERE NOT inv.ipd OR inv.finalized_at IS NOT NULL),
    adj AS (
      SELECT ci.invoice_id, ci.payer_id, sum(ci.resolved_amount) AS r FROM fin_claim_items ci JOIN inv ON inv.id = ci.invoice_id
       WHERE ci.resolution = 'writeoff' GROUP BY ci.invoice_id, ci.payer_id),
    lsx AS (
      SELECT ls.line_id, ls.kind, ls.payer_id, ls.amount / nullif(ls.line_total, 0) AS w FROM ls
      UNION ALL
      SELECT x.line_id, k.kind, x.payer_id, k.sgn * x.part / nullif(x.line_total, 0)
        FROM (SELECT ls.line_id, ls.kind, ls.payer_id, ls.line_total, a.r * ls.amount / nullif(sum(ls.amount) OVER (PARTITION BY ls.invoice_id, ls.payer_id), 0) AS part
                FROM ls JOIN adj a ON a.invoice_id = ls.invoice_id AND a.payer_id = ls.payer_id) x
        CROSS JOIN LATERAL (VALUES (x.kind, -1), ('denied', 1)) k(kind, sgn)),
    -- 0063: rv.line_id — ექიმზე მიწერისთვის (rpt_fact_doctor_rev)
    rv AS (
      SELECT dl.invoice_id, dl.line_id, dl.rdate, dl.category, dl.ord, dl.perf, x.kind, x.payer_id, dl.amount * x.w AS amount
        FROM dl JOIN lsx x ON x.line_id = dl.line_id
       WHERE dl.rdate BETWEEN ${from}::date AND ${to}::date AND x.w IS NOT NULL AND x.w <> 0
      UNION ALL
      SELECT dl.invoice_id, dl.line_id, dl.rdate, dl.category, dl.ord, dl.perf, sw.kind, sw.payer_id, dl.amount * sw.w AS amount
        FROM dl JOIN sw ON sw.invoice_id = dl.invoice_id
       WHERE dl.rdate BETWEEN ${from}::date AND ${to}::date AND sw.w IS NOT NULL AND sw.w <> 0
         AND NOT EXISTS (SELECT 1 FROM ls WHERE ls.line_id = dl.line_id))`;
}
const deptKey = (b: DeptBasis) => (b === 'ordering' ? sql`rv.ord` : sql`rv.perf`);

/** მარაგის მოძრაობის ღირებულება: fifo → ლოტის ფასი, average → შეწონილი საშუალო (როგორც 0038-ის რეპორტებში) */
const moveCost = (m: 'fifo' | 'average') => (m === 'fifo' ? sql`m.cost_lot` : sql`coalesce(m.cost_avg, m.cost_lot)`);
/** მოძრაობა → ხარჯი არჩეული საფუძვლით (dept — ლოკაციის განყოფილება) */
const stockCost = (b: StockBasis) => (b === 'issue'
  ? sql`CASE WHEN mv.dept IS NOT NULL AND mv.move_type IN ('transfer', 'issue', 'return', 'receipt') THEN mv.val
             WHEN mv.dept IS NULL AND mv.move_type IN ('consumption', 'writeoff', 'adjustment') THEN -mv.val END`
  : sql`CASE WHEN mv.move_type IN ('consumption', 'writeoff', 'adjustment') THEN -mv.val END`);

@Injectable()
export class FinReportsService {
  constructor(readonly c: FinCommon) {}
  private get db() { return this.c.db; }
  private tsBounds(from: string, to: string) {
    return { a: sql`(${from}::date)::timestamp AT TIME ZONE ${TZ}`, b: sql`(${to}::date + 1)::timestamp AT TIME ZONE ${TZ}` };
  }

  // ================================================================= შემოსავალი
  async revenue(u: AuthUser, q: { from?: string; to?: string; basis?: string; dept_basis?: string }) {
    const rules = await this.c.rules();
    const scope = await this.c.scope(u, rules);
    const { from, to } = this.c.period(q.from, q.to);
    return this.revenueData(rules, scope, from, to, (q.basis as Basis) ?? rules.revenue_basis, (q.dept_basis as DeptBasis) ?? rules.revenue_dept_basis);
  }

  async revenueData(rules: FinRules, scope: Scope, from: string, to: string, basis: Basis, deptBasis: DeptBasis, ex: Ex = this.db) {
    if (!['service_date', 'finalized'].includes(basis) || !['performing', 'ordering'].includes(deptBasis)) throw new BadRequestException('basis / dept_basis');
    const dk = deptKey(deptBasis);
    const rows = (await sql<{ g: number; kind: string | null; payer_id: string | null; dept: string | null; category: string | null; month: string | null; amount: string; invoices: number }>`
      WITH ${revenueCte(basis, from, to)}
      SELECT GROUPING(rv.kind, rv.payer_id, ${dk}, rv.category, to_char(rv.rdate, 'YYYY-MM'))::int AS g, rv.kind, rv.payer_id, ${dk} AS dept, rv.category,
             to_char(rv.rdate, 'YYYY-MM') AS month, sum(rv.amount)::text AS amount, count(DISTINCT rv.invoice_id)::int AS invoices
        FROM rv
       WHERE ${scope.dept}::uuid IS NULL OR ${dk} = ${scope.dept}::uuid
       GROUP BY GROUPING SETS ((rv.kind), (rv.kind, rv.payer_id), (rv.kind, ${dk}), (rv.category), (rv.kind, to_char(rv.rdate, 'YYYY-MM')), ())`.execute(ex)).rows;
    // GROUPING bitmask (kind, payer, dept, category, month): 1 = აგრეგირებული
    const G = { kind: 0b01111, payer: 0b00111, dept: 0b01011, category: 0b11101, month: 0b01110, all: 0b11111 };
    const sel = (g: number) => rows.filter((r) => r.g === g);
    const totals = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<Kind, number>;
    for (const r of sel(G.kind)) totals[r.kind as Kind] = r2(n(r.amount));
    const all = sel(G.all)[0];
    const total = r2(n(all?.amount));
    const net = r2(total - totals.writeoff - totals.denied);
    const ids = [...new Set(rows.map((r) => r.dept).filter((x): x is string => !!x))];
    const pids = [...new Set(rows.map((r) => r.payer_id).filter((x): x is string => !!x))];
    const deps = ids.length ? await ex.selectFrom('departments').select(['id', 'name', 'type']).where('id', 'in', ids).execute() : [];
    const pays = pids.length ? await ex.selectFrom('payers').select(['id', 'name', 'code', 'kind']).where('id', 'in', pids).execute() : [];
    const byDept = new Map<string, Record<string, number | string | null>>();
    for (const r of sel(G.dept)) {
      const key = r.dept ?? '-';
      const d = deps.find((x) => x.id === r.dept);
      const o = byDept.get(key) ?? { department_id: r.dept, department_name: d?.name ?? COMMON, ...Object.fromEntries(KINDS.map((k) => [k, 0])), total: 0, net: 0 };
      o[r.kind as Kind] = r2(n(o[r.kind as Kind]) + n(r.amount)); o.total = r2(n(o.total) + n(r.amount));
      if (r.kind !== 'writeoff' && r.kind !== 'denied') o.net = r2(n(o.net) + n(r.amount));
      byDept.set(key, o);
    }
    const byMonth = new Map<string, Record<string, number | string>>();
    for (const r of sel(G.month)) {
      const o = byMonth.get(r.month!) ?? { month: r.month!, ...Object.fromEntries(KINDS.map((k) => [k, 0])), total: 0 };
      o[r.kind as Kind] = r2(n(r.amount)); o.total = r2(n(o.total) + n(r.amount));
      byMonth.set(r.month!, o);
    }
    return {
      from, to, basis, dept_basis: deptBasis, scope_department: scope.dept_name,
      totals: { ...totals, total, net, invoices: all?.invoices ?? 0 },
      by_kind: KINDS.map((k) => ({ kind: k, kind_ka: PAYER_KIND_KA[k], amount: totals[k] })).filter((x) => x.amount !== 0),
      by_payer: sel(G.payer).filter((r) => ['insurance', 'state', 'other'].includes(r.kind!)).map((r) => {
        const p = pays.find((x) => x.id === r.payer_id);
        return { payer_id: r.payer_id, payer_name: p?.name ?? 'გადამხდელი მიუთითებელი', code: p?.code ?? null, kind: r.kind, kind_ka: PAYER_KIND_KA[r.kind!], amount: r2(n(r.amount)), invoices: r.invoices };
      }).sort((a, b) => b.amount - a.amount),
      by_department: [...byDept.values()].sort((a, b) => n(b.total) - n(a.total)),
      by_category: sel(G.category).map((r) => ({ category: r.category, amount: r2(n(r.amount)) })).sort((a, b) => b.amount - a.amount),
      by_month: [...byMonth.values()].sort((a, b) => String(a.month).localeCompare(String(b.month))),
    };
  }

  // ================================================================= მარაგი: ღირებულება თარიღით
  async stockValue(u: AuthUser, asOf?: string) {
    const rules = await this.c.rules();
    const scope = await this.c.scope(u, rules);
    const d = asOf ?? await this.c.today();
    if (!DATE_RE.test(d)) throw new BadRequestException('as_of: YYYY-MM-DD');
    return this.stockValueData(scope, d);
  }
  async stockValueData(scope: Scope, asOf: string, ex: Ex = this.db) {
    const m = await this.c.costingMethod(ex);
    const { b } = this.tsBounds(asOf, asOf);
    const rows = (await sql<{ g: number; location_id: string | null; location_name: string | null; kind: string | null; dept: string | null; category: string | null; value: string; items: number }>`
      SELECT GROUPING(l.id, l.name, l.kind, l.department_id, c.name)::int AS g, l.id AS location_id, l.name AS location_name, l.kind, l.department_id AS dept, c.name AS category,
             round(sum(m.qty * ${moveCost(m)}), 2)::text AS value, count(DISTINCT m.item_id) FILTER (WHERE m.qty <> 0)::int AS items
        FROM stock_moves m JOIN stock_locations l ON l.id = m.location_id JOIN stock_items i ON i.id = m.item_id JOIN stock_categories c ON c.id = i.category_id
       WHERE m.created_at < ${b} AND (${scope.dept}::uuid IS NULL OR l.department_id = ${scope.dept}::uuid)
       GROUP BY GROUPING SETS ((l.id, l.name, l.kind, l.department_id), (c.name), (l.department_id), ())`.execute(ex)).rows;
    const ids = [...new Set(rows.map((r) => r.dept).filter((x): x is string => !!x))];
    const deps = ids.length ? await ex.selectFrom('departments').select(['id', 'name']).where('id', 'in', ids).execute() : [];
    const dn = (id: string | null) => deps.find((x) => x.id === id)?.name ?? COMMON;
    const all = rows.find((r) => r.g === 0b11111);
    return {
      as_of: asOf, costing_method: m, scope_department: scope.dept_name, total: r2(n(all?.value)),
      by_location: rows.filter((r) => r.g === 0b00001 && n(r.value) !== 0).map((r) => ({ location_id: r.location_id, location_name: r.location_name, kind: r.kind,
        department_id: r.dept, department_name: r.dept ? dn(r.dept) : null, value: r2(n(r.value)) })).sort((a, b) => b.value - a.value),
      by_category: rows.filter((r) => r.g === 0b11110 && n(r.value) !== 0).map((r) => ({ category: r.category, value: r2(n(r.value)) })).sort((a, b) => b.value - a.value),
      by_department: rows.filter((r) => r.g === 0b11101 && n(r.value) !== 0).map((r) => ({ department_id: r.dept, department_name: dn(r.dept), value: r2(n(r.value)) }))
        .sort((a, b) => b.value - a.value),
    };
  }

  // ================================================================= მარაგი: მოხმარება განყოფილებებზე
  async consumption(u: AuthUser, q: { from?: string; to?: string; basis?: string }) {
    const rules = await this.c.rules();
    const scope = await this.c.scope(u, rules);
    const { from, to } = this.c.period(q.from, q.to);
    const basis = (q.basis as StockBasis) ?? rules.dept_consumption_basis;
    if (!['consumption', 'issue'].includes(basis)) throw new BadRequestException('basis: consumption / issue');
    return this.consumptionData(scope, from, to, basis);
  }
  async consumptionData(scope: Scope, from: string, to: string, basis: StockBasis, ex: Ex = this.db) {
    const m = await this.c.costingMethod(ex);
    const { a, b } = this.tsBounds(from, to);
    const cte = sql`mv AS (
      SELECT m.move_type, m.item_id, m.patient_id, m.line_id, m.qty, l.department_id AS dept, i.name AS item_name, c.name AS category,
             to_char(m.created_at AT TIME ZONE ${TZ}, 'YYYY-MM') AS month, m.qty * ${moveCost(m)} AS val,
             EXISTS (SELECT 1 FROM invoice_line_items il WHERE il.stock_doc_line_id = m.line_id) AS billed, x.sale_price
        FROM stock_moves m JOIN stock_locations l ON l.id = m.location_id JOIN stock_items i ON i.id = m.item_id JOIN stock_categories c ON c.id = i.category_id
        LEFT JOIN stock_doc_lines x ON x.id = m.line_id
       WHERE m.created_at >= ${a} AND m.created_at < ${b} AND l.kind <> 'transit' AND (${scope.dept}::uuid IS NULL OR l.department_id = ${scope.dept}::uuid))`;
    const cost = stockCost(basis);
    const depRows = (await sql<{ dept: string | null; consumption: string; loss: string; issued: string; cost: string; billed_cost: string; billed_revenue: string; patients: number }>`
      WITH ${cte}
      SELECT mv.dept, coalesce(-sum(mv.val) FILTER (WHERE mv.move_type = 'consumption'), 0)::text AS consumption,
             coalesce(-sum(mv.val) FILTER (WHERE mv.move_type IN ('writeoff', 'adjustment')), 0)::text AS loss,
             coalesce(sum(mv.val) FILTER (WHERE mv.dept IS NOT NULL AND mv.move_type IN ('transfer', 'issue', 'return', 'receipt')), 0)::text AS issued,
             coalesce(sum(${cost}), 0)::text AS cost,
             coalesce(-sum(mv.val) FILTER (WHERE mv.move_type = 'consumption' AND mv.billed), 0)::text AS billed_cost,
             coalesce(-sum(mv.qty * mv.sale_price) FILTER (WHERE mv.move_type = 'consumption' AND mv.billed), 0)::text AS billed_revenue,
             count(DISTINCT mv.patient_id)::int AS patients
        FROM mv GROUP BY mv.dept`.execute(ex)).rows;
    const grp = (await sql<{ g: number; category: string | null; item_id: string | null; item_name: string | null; month: string | null; cost: string }>`
      WITH ${cte}
      SELECT GROUPING(mv.category, mv.item_id, mv.item_name, mv.month)::int AS g, mv.category, mv.item_id, mv.item_name, mv.month, coalesce(sum(${cost}), 0)::text AS cost
        FROM mv GROUP BY GROUPING SETS ((mv.category), (mv.item_id, mv.item_name), (mv.month))`.execute(ex)).rows;
    // ქვესაწყობის ნაშთი პერიოდის ბოლოს (გაცემული, ჯერ დაუხარჯავი)
    const onHand = (await sql<{ dept: string; value: string }>`
      SELECT l.department_id AS dept, round(sum(m.qty * ${moveCost(m)}), 2)::text AS value FROM stock_moves m JOIN stock_locations l ON l.id = m.location_id
       WHERE m.created_at < ${b} AND l.department_id IS NOT NULL AND (${scope.dept}::uuid IS NULL OR l.department_id = ${scope.dept}::uuid) GROUP BY l.department_id`.execute(ex)).rows;
    const keys = [...new Set<string | null>([...depRows.map((r) => r.dept), ...onHand.map((r) => r.dept)])];
    const ids = keys.filter((x): x is string => !!x);
    const deps = ids.length ? await ex.selectFrom('departments').select(['id', 'name', 'type']).where('id', 'in', ids).execute() : [];
    const rowsOut = keys.map((id) => {
      const r = depRows.find((x) => x.dept === id);
      const d = deps.find((x) => x.id === id);
      const consumption = r2(n(r?.consumption)); const billedCost = r2(n(r?.billed_cost));
      return { department_id: id, department_name: d?.name ?? COMMON, department_type: d?.type ?? null, cost: r2(n(r?.cost)), consumption, loss: r2(n(r?.loss)), issued: r2(n(r?.issued)),
        billed_cost: billedCost, unbilled_cost: r2(consumption - billedCost), billed_revenue: r2(n(r?.billed_revenue)), patients: r?.patients ?? 0,
        on_hand: r2(n(onHand.find((x) => x.dept === id)?.value)) };
    }).filter((r) => r.cost || r.consumption || r.loss || r.issued || r.on_hand).sort((x, y) => y.cost - x.cost);
    const sum = (k: 'cost' | 'consumption' | 'loss' | 'issued' | 'billed_cost' | 'unbilled_cost' | 'billed_revenue' | 'on_hand') => r2(rowsOut.reduce((s, r) => s + r[k], 0));
    return {
      from, to, basis, costing_method: m, scope_department: scope.dept_name,
      totals: { cost: sum('cost'), consumption: sum('consumption'), loss: sum('loss'), issued: sum('issued'), billed_cost: sum('billed_cost'), unbilled_cost: sum('unbilled_cost'),
        billed_revenue: sum('billed_revenue'), on_hand: sum('on_hand') },
      by_department: rowsOut,
      by_category: grp.filter((r) => r.g === 0b0111 && n(r.cost) !== 0).map((r) => ({ category: r.category, cost: r2(n(r.cost)) })).sort((x, y) => y.cost - x.cost),
      top_items: grp.filter((r) => r.g === 0b1001 && n(r.cost) !== 0).map((r) => ({ item_id: r.item_id, item_name: r.item_name, cost: r2(n(r.cost)) }))
        .sort((x, y) => y.cost - x.cost).slice(0, 20),
      by_month: grp.filter((r) => r.g === 0b1110 && n(r.cost) !== 0).map((r) => ({ month: r.month, cost: r2(n(r.cost)) })).sort((x, y) => String(x.month).localeCompare(String(y.month))),
    };
  }

  // ================================================================= განყოფილების შედეგი (+ საერთო ხარჯის განაწილება)
  async deptResult(u: AuthUser, q: { from?: string; to?: string; dept_basis?: string; allocation?: string }) {
    const rules = await this.c.rules();
    const scope = await this.c.scope(u, rules);
    const { from, to } = this.c.period(q.from, q.to);
    const alloc = (q.allocation as FinRules['overhead_allocation']) ?? rules.overhead_allocation;
    if (!['none', 'revenue', 'bed_days', 'manual'].includes(alloc)) throw new BadRequestException('allocation: none / revenue / bed_days / manual');
    const out = await this.deptResultData(rules, from, to, (q.dept_basis as DeptBasis) ?? rules.revenue_dept_basis, alloc);
    if (!scope.dept) return out;
    // მენეჯერი: მხოლოდ თავისი განყოფილება (განაწილება მთელი კლინიკით ითვლება)
    return { ...out, scope_department: scope.dept_name, rows: out.rows.filter((r) => r.department_id === scope.dept), pool: null, unallocated: null, totals: null };
  }

  async deptResultData(rules: FinRules, from: string, to: string, deptBasis: DeptBasis, alloc: FinRules['overhead_allocation'], ex: Ex = this.db) {
    const all: Scope = { dept: null, dept_name: null };
    const rev = await this.revenueData(rules, all, from, to, rules.revenue_basis, deptBasis, ex);
    const stock = await this.consumptionData(all, from, to, rules.dept_consumption_basis, ex);
    const exp = await ex.selectFrom('expenses as x').select(['x.department_id', sql<string>`sum(x.amount)`.as('amount')])
      .where('x.is_void', '=', false).where('x.expense_date', '>=', from).where('x.expense_date', '<=', to).groupBy('x.department_id').execute();
    const beds = await ex.selectFrom('stay_bed_days as d').innerJoin('inpatient_stays as st', 'st.encounter_id', 'd.encounter_id')
      .select(['d.department_id', sql<number>`count(*)::int`.as('days')]).where('st.status', '<>', 'cancelled').where('d.day', '>=', from).where('d.day', '<=', to)
      .groupBy('d.department_id').execute();
    const deps = await ex.selectFrom('departments').select(['id', 'name', 'type', 'is_active']).execute();
    const isAdmin = (id: string | null) => !id || deps.find((d) => d.id === id)?.type === 'administrative';
    type Row = { department_id: string; department_name: string; department_type: string; revenue: number; writeoff: number; revenue_net: number; expenses: number;
      stock_cost: number; overhead: number; result: number; margin_pct: number | null; bed_days: number; key: number };
    const rows = new Map<string, Row>();
    const row = (id: string) => {
      let r = rows.get(id);
      if (!r) { const d = deps.find((x) => x.id === id)!; r = { department_id: id, department_name: d.name, department_type: d.type, revenue: 0, writeoff: 0, revenue_net: 0, expenses: 0, stock_cost: 0, overhead: 0, result: 0, margin_pct: null, bed_days: 0, key: 0 }; rows.set(id, r); }
      return r;
    };
    for (const d of deps) if (d.is_active && d.type !== 'administrative') row(d.id);
    const pool = { expenses: 0, stock: 0, admin_departments: [] as { department_id: string | null; department_name: string; expenses: number; stock_cost: number }[] };
    const adminRow = (id: string | null) => {
      let a = pool.admin_departments.find((x) => x.department_id === id);
      if (!a) { a = { department_id: id, department_name: id ? deps.find((d) => d.id === id)?.name ?? COMMON : COMMON, expenses: 0, stock_cost: 0 }; pool.admin_departments.push(a); }
      return a;
    };
    for (const r of rev.by_department) {
      const id = r.department_id as string | null;
      if (!id) continue;                                  // განყოფილების გარეშე შემოსავალი — მხოლოდ ჯამში
      const x = row(id);
      x.revenue = r2(x.revenue + n(r.total)); x.writeoff = r2(x.writeoff + n(r.writeoff) + n(r.denied)); x.revenue_net = r2(x.revenue_net + n(r.net));
    }
    for (const e of exp) {
      if (isAdmin(e.department_id)) { const a = adminRow(e.department_id); a.expenses = r2(a.expenses + n(e.amount)); pool.expenses = r2(pool.expenses + n(e.amount)); }
      else { const x = row(e.department_id!); x.expenses = r2(x.expenses + n(e.amount)); }
    }
    for (const s of stock.by_department) {
      if (isAdmin(s.department_id)) { const a = adminRow(s.department_id); a.stock_cost = r2(a.stock_cost + s.cost); pool.stock = r2(pool.stock + s.cost); }
      else { const x = row(s.department_id!); x.stock_cost = r2(x.stock_cost + s.cost); }
    }
    for (const b of beds) if (!isAdmin(b.department_id)) row(b.department_id).bed_days = b.days;
    const receivers = [...rows.values()].filter((r) => !isAdmin(r.department_id));
    for (const r of receivers) {
      r.key = alloc === 'revenue' ? Math.max(0, r.revenue_net) : alloc === 'bed_days' ? r.bed_days : alloc === 'manual' ? n(rules.overhead_manual?.[r.department_id]) : 0;
    }
    const poolTotal = r2(pool.expenses + pool.stock);
    const keySum = receivers.reduce((s, r) => s + r.key, 0);
    let allocated = 0;
    if (alloc !== 'none' && keySum > 0 && poolTotal !== 0) {
      const withKey = receivers.filter((r) => r.key > 0);
      withKey.forEach((r, i) => {
        r.overhead = i === withKey.length - 1 ? r2(poolTotal - allocated) : r2(poolTotal * r.key / keySum);   // ნაშთი — ბოლოს
        allocated = r2(allocated + r.overhead);
      });
    }
    for (const r of rows.values()) {
      r.result = r2(r.revenue_net - r.expenses - r.stock_cost - r.overhead);
      r.margin_pct = r.revenue_net > 0 ? Math.round((r.result / r.revenue_net) * 1000) / 10 : null;
    }
    const list = [...rows.values()].filter((r) => r.revenue || r.expenses || r.stock_cost || r.overhead || r.bed_days)
      .sort((a, b) => b.revenue_net - a.revenue_net || a.department_name.localeCompare(b.department_name));
    const unallocated = r2(poolTotal - allocated);
    const noDeptRevenue = r2(n(rev.by_department.find((r) => !r.department_id)?.net));
    const sum = (k: 'revenue' | 'writeoff' | 'revenue_net' | 'expenses' | 'stock_cost' | 'overhead' | 'result') => r2(list.reduce((s, r) => s + r[k], 0));
    return {
      from, to, dept_basis: deptBasis, allocation: alloc, revenue_basis: rules.revenue_basis, stock_basis: rules.dept_consumption_basis, scope_department: null as string | null,
      rows: list.map(({ key: _k, ...r }) => r),
      pool: { ...pool, total: poolTotal, admin_departments: pool.admin_departments.filter((a) => a.expenses || a.stock_cost) },
      unallocated, revenue_without_department: noDeptRevenue,
      totals: { revenue: sum('revenue'), writeoff: sum('writeoff'), revenue_net: r2(sum('revenue_net') + noDeptRevenue), expenses: r2(sum('expenses') + pool.expenses),
        stock_cost: r2(sum('stock_cost') + pool.stock), overhead: sum('overhead'), result: r2(sum('result') - unallocated + noDeptRevenue) } as Record<string, number> | null,
    };
  }

  async csv(u: AuthUser, report: string, q: Record<string, string | undefined>) {
    if (report === 'revenue') {
      const d = await this.revenue(u, q);
      return { name: `revenue-${d.from}-${d.to}.csv`, csv: toCsv(['განყოფილება', ...KINDS.map((k) => PAYER_KIND_KA[k]), 'სულ', 'წმინდა'],
        d.by_department.map((r) => [r.department_name as string, ...KINDS.map((k) => n(r[k]).toFixed(2)), n(r.total).toFixed(2), n(r.net).toFixed(2)]),
        `შემოსავალი ${d.from} — ${d.to} (${d.basis}, ${d.dept_basis === 'ordering' ? 'დამნიშნავი' : 'შემსრულებელი'} განყოფილება)`) };
    }
    if (report === 'consumption') {
      const d = await this.consumption(u, q);
      return { name: `stock-consumption-${d.from}-${d.to}.csv`, csv: toCsv(['განყოფილება', 'ხარჯი (საფუძვლით)', 'მოხმარება', 'დანაკარგი', 'გაცემა (ნეტო)', 'პაციენტზე ჩაწერილი', 'დაუწერელი', 'ქვესაწყობის ნაშთი'],
        d.by_department.map((r) => [r.department_name, r.cost, r.consumption, r.loss, r.issued, r.billed_cost, r.unbilled_cost, r.on_hand].map((v) => (typeof v === 'number' ? v.toFixed(2) : v))),
        `მარაგის ხარჯი განყოფილებებზე ${d.from} — ${d.to} (${d.basis})`) };
    }
    if (report === 'dept-result') {
      const d = await this.deptResult(u, q);
      return { name: `dept-result-${d.from}-${d.to}.csv`, csv: toCsv(['განყოფილება', 'შემოსავალი', 'ჩამოწერა / უარი', 'წმინდა შემოსავალი', 'პირდაპირი ხარჯი', 'მარაგი', 'საერთოს წილი', 'შედეგი', 'მარჟა %'],
        d.rows.map((r) => [r.department_name, r.revenue, r.writeoff, r.revenue_net, r.expenses, r.stock_cost, r.overhead, r.result].map((v) => (typeof v === 'number' ? v.toFixed(2) : v)).concat([r.margin_pct === null ? '' : String(r.margin_pct)])),
        `განყოფილების შედეგი ${d.from} — ${d.to} (განაწილება: ${d.allocation})`) };
    }
    throw new BadRequestException('უცნობი რეპორტი');
  }
}

const q2 = (q: Record<string, string | undefined>) => q;

@Controller('finance')
export class FinReportsController {
  constructor(private readonly s: FinReportsService) {}
  @Get('revenue') @Roles(...FIN_READ) revenue(@Query() q: Record<string, string | undefined>, @CurrentUser() u: AuthUser) { return this.s.revenue(u, q2(q)); }
  @Get('stock/value') @Roles(...FIN_READ) stockValue(@Query('as_of') asOf: string | undefined, @CurrentUser() u: AuthUser) { return this.s.stockValue(u, asOf); }
  @Get('stock/consumption') @Roles(...FIN_READ) consumption(@Query() q: Record<string, string | undefined>, @CurrentUser() u: AuthUser) { return this.s.consumption(u, q2(q)); }
  @Get('dept-result') @Roles(...FIN_READ) deptResult(@Query() q: Record<string, string | undefined>, @CurrentUser() u: AuthUser) { return this.s.deptResult(u, q2(q)); }
  @Get('csv/:report') @Roles(...FIN_READ)
  async csv(@Param('report') report: string, @Query() q: Record<string, string | undefined>, @CurrentUser() u: AuthUser, @Res({ passthrough: true }) res: Response) {
    const out = await this.s.csv(u, report, q);
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${out.name}"` });
    return out.csv;
  }
}
