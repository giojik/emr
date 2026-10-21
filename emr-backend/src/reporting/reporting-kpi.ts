import { BadRequestException, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { addDays, daysBetween, n, r1, r2, RptCommon, type RptScope, type RptSettings } from './reporting-common';
import { TAT_EDGES } from './reporting-refresh';
import { bedDays, categoryExpander, type Indicator, indicatorMatch, loadIndicators, rate } from '../quality/quality-metrics';

/**
 * KPI-ების გამოთვლა მხოლოდ rpt_* ცხრილებიდან (READ_DB). თითო KPI-ის ფორმულა — აქ (ტექსტი — rpt_kpis.formula).
 * ხედვის არე: all — ყველა ხაზი (განყოფილების გარეშეც); სხვა — department_id ∈ depts.
 */
export type Totals = Record<string, number>;
export interface KpiRow { code: string; category: string; name: string; unit: string; direction: string; definition: string; formula: string; source: string;
  finance: boolean; snapshot: boolean; drill: string | null; sort_order: number }

/** პროცენტილი წუთების ჰისტოგრამიდან (წრფივი ინტერპოლაცია ინტერვალში; ბოლო — 10080+) */
export function histPercentile(hist: number[], p: number): number | null {
  const total = hist.reduce((a, b) => a + b, 0);
  if (!total) return null;
  const target = total * p;
  const lo = [0, ...TAT_EDGES];
  let acc = 0;
  for (let i = 0; i < hist.length; i++) {
    if (acc + hist[i] >= target && hist[i] > 0) {
      if (i === hist.length - 1) return lo[i];
      const frac = (target - acc) / hist[i];
      return r1(lo[i] + frac * (TAT_EDGES[i] - lo[i]));
    }
    acc += hist[i];
  }
  return lo[lo.length - 1];
}
const pct = (a: number, b: number) => (b > 0 ? r1((a / b) * 100) : null);
const div = (a: number, b: number, d = 1) => (b > 0 ? Math.round((a / b) * 10 ** d) / 10 ** d : null);
export type Snap = { stock_low: number; stock_exp90: number; qm_capa_overdue?: number };

@Injectable()
export class RptKpiService {
  constructor(private readonly c: RptCommon) {}
  private get rdb() { return this.c.rdb; }

  /** 0066: ინდიკატორები (qm_indicators) + კატეგორიების ხე — ყოველ totals-ზე (2 პატარა ცხრილი; ცნობარის ცვლილება მაშინვე აისახება) */
  private ind: { list: Indicator[]; cats: Map<string, Set<string>> } | null = null;
  private async indicators() {
    const [list, expand] = await Promise.all([loadIndicators(this.c.db, false), categoryExpander(this.c.db)]);
    this.ind = { list, cats: new Map(list.map((i) => [i.code, expand(i.category_ids)])) };
    return this.ind;
  }

  /** განყოფილების ფილტრი (alias-ის department_id) */
  private where(scope: RptScope, alias: string) {
    return scope.all ? sql`TRUE` : sql`${sql.ref(`${alias}.department_id`)} = ANY(${scope.depts}::uuid[])`;
  }

  /** პერიოდის ჯამები ყველა ფაქტიდან — ერთი გასაღებით (flow_*, beds_*, …) */
  async totals(scope: RptScope, from: string, to: string): Promise<Totals> {
    const t: Record<string, number> = {};
    const [flow, beds, or, room, dx, stock, fin, hist, qm, qmHist, ind, ipc, ipcd] = await Promise.all([
      sql<{ enc_type: string; visit_kind: string; encounters: number; cancelled: number; new_patients: number }>`
        SELECT f.enc_type, f.visit_kind, sum(f.encounters)::int AS encounters, sum(f.cancelled)::int AS cancelled, sum(f.new_patients)::int AS new_patients
          FROM rpt_fact_flow f WHERE f.day BETWEEN ${from}::date AND ${to}::date AND ${this.where(scope, 'f')} GROUP BY 1, 2`.execute(this.rdb),
      sql<Record<string, string>>`
        SELECT coalesce(sum(available_hours), 0)::text AS available_hours, coalesce(sum(occupied_hours), 0)::text AS occupied_hours,
               coalesce(sum(midnight_census), 0)::text AS midnight_census, coalesce(sum(admissions), 0)::text AS admissions, coalesce(sum(discharges), 0)::text AS discharges,
               coalesce(sum(deaths), 0)::text AS deaths, coalesce(sum(los_days_sum), 0)::text AS los_days_sum, coalesce(sum(readmissions_30), 0)::text AS readmissions_30,
               coalesce(sum(transfers_in), 0)::text AS transfers_in, coalesce(sum(transfers_out), 0)::text AS transfers_out
          FROM rpt_fact_beds f WHERE f.day BETWEEN ${from}::date AND ${to}::date AND ${this.where(scope, 'f')}`.execute(this.rdb),
      sql<Record<string, string>>`
        SELECT coalesce(sum(scheduled), 0)::text AS scheduled, coalesce(sum(done), 0)::text AS done, coalesce(sum(emergency), 0)::text AS emergency, coalesce(sum(cancelled), 0)::text AS cancelled,
               coalesce(sum(surgery_cases), 0)::text AS surgery_cases, coalesce(sum(surgery_min), 0)::text AS surgery_min,
               coalesce(sum(first_cases), 0)::text AS first_cases, coalesce(sum(first_on_time), 0)::text AS first_on_time
          FROM rpt_fact_or f WHERE f.day BETWEEN ${from}::date AND ${to}::date AND ${this.where(scope, 'f')}`.execute(this.rdb),
      sql<Record<string, string>>`
        SELECT coalesce(sum(avail_min), 0)::text AS avail_min, coalesce(sum(used_min), 0)::text AS used_min
          FROM rpt_fact_or_room f WHERE f.day BETWEEN ${from}::date AND ${to}::date AND ${this.where(scope, 'f')}`.execute(this.rdb),
      sql<{ lab: boolean; ordered: number; cancelled: number; external: number; ext_cost: string; resulted: number }>`
        SELECT (f.section = 'lab') AS lab, sum(f.ordered)::int AS ordered, sum(f.cancelled)::int AS cancelled, sum(f.external)::int AS external,
               sum(f.ext_cost)::text AS ext_cost, sum(f.resulted)::int AS resulted
          FROM rpt_fact_dx f WHERE f.day BETWEEN ${from}::date AND ${to}::date AND ${this.where(scope, 'f')} GROUP BY 1`.execute(this.rdb),
      sql<Record<string, string>>`
        SELECT coalesce(sum(consumption), 0)::text AS consumption, coalesce(sum(loss), 0)::text AS loss
          FROM rpt_fact_stock f WHERE f.day BETWEEN ${from}::date AND ${to}::date AND ${this.where(scope, 'f')}`.execute(this.rdb),
      sql<Record<string, string>>`
        SELECT coalesce(sum(rev_patient), 0)::text AS rev_patient, coalesce(sum(rev_insurance), 0)::text AS rev_insurance, coalesce(sum(rev_state), 0)::text AS rev_state,
               coalesce(sum(rev_other), 0)::text AS rev_other, coalesce(sum(rev_undetermined), 0)::text AS rev_undetermined, coalesce(sum(rev_writeoff), 0)::text AS rev_writeoff,
               coalesce(sum(rev_denied), 0)::text AS rev_denied, coalesce(sum(stock_cost), 0)::text AS stock_cost, coalesce(sum(expenses), 0)::text AS expenses,
               coalesce(sum(payments), 0)::text AS payments
          FROM rpt_fact_finance f WHERE f.day BETWEEN ${from}::date AND ${to}::date AND ${this.where(scope, 'f')}`.execute(this.rdb),
      sql<{ lab: boolean; k: number; c: number }>`
        SELECT (f.section = 'lab') AS lab, k, coalesce(sum(f.tat_hist[k]), 0)::int AS c
          FROM rpt_fact_dx f CROSS JOIN generate_series(1, 12) k
         WHERE f.day BETWEEN ${from}::date AND ${to}::date AND ${this.where(scope, 'f')} GROUP BY 1, 2`.execute(this.rdb),
      // 0066: ხარისხი
      sql<{ category_id: string; event_type: string; harm: string; service_type: string; affected: string; is_sentinel: boolean; n: number; anonymous: number; triaged: number; on_time: number }>`
        SELECT f.category_id, f.event_type, f.harm, f.service_type, f.affected, f.is_sentinel, sum(f.n)::int AS n, sum(f.anonymous)::int AS anonymous,
               sum(f.triaged)::int AS triaged, sum(f.triage_on_time)::int AS on_time
          FROM rpt_fact_quality f WHERE f.day BETWEEN ${from}::date AND ${to}::date AND ${this.where(scope, 'f')} GROUP BY 1, 2, 3, 4, 5, 6`.execute(this.rdb),
      sql<{ k: number; c: number }>`
        SELECT k, coalesce(sum(f.triage_hist[k]), 0)::int AS c FROM rpt_fact_quality f CROSS JOIN generate_series(1, 12) k
         WHERE f.day BETWEEN ${from}::date AND ${to}::date AND ${this.where(scope, 'f')} GROUP BY 1`.execute(this.rdb),
      this.indicators(),
      // 0072: ინფექციის კონტროლი
      sql<Record<string, string>>`
        SELECT coalesce(sum(hai), 0)::text AS hai, coalesce(sum(clabsi), 0)::text AS clabsi, coalesce(sum(cauti), 0)::text AS cauti, coalesce(sum(vap), 0)::text AS vap,
               coalesce(sum(ssi_ops), 0)::text AS ssi_ops, coalesce(sum(ssi), 0)::text AS ssi, coalesce(sum(mdro_hosp), 0)::text AS mdro_hosp, coalesce(sum(mdro_all), 0)::text AS mdro_all,
               coalesce(sum(ddd), 0)::text AS ddd, coalesce(sum(ddd_access), 0)::text AS ddd_access, coalesce(sum(dot), 0)::text AS dot,
               coalesce(sum(hh_opps), 0)::text AS hh_opps, coalesce(sum(hh_done), 0)::text AS hh_done, coalesce(sum(handrub_l), 0)::text AS handrub_l
          FROM rpt_fact_ipc f WHERE f.day BETWEEN ${from}::date AND ${to}::date AND ${this.where(scope, 'f')}`.execute(this.rdb),
      sql<Record<string, string>>`
        SELECT coalesce(sum(patient_days), 0)::text AS pd, coalesce(sum(central_line_days), 0)::text AS cl, coalesce(sum(urinary_days), 0)::text AS uc,
               coalesce(sum(vent_days), 0)::text AS vent
          FROM rpt_fact_ipc_daily f WHERE f.day BETWEEN ${from}::date AND ${to}::date AND ${this.where(scope, 'f')}`.execute(this.rdb),
    ]);
    t.days = daysBetween(from, to);
    for (const k of ['enc_all', 'enc_out', 'enc_lab', 'enc_emg', 'enc_cancelled', 'new_patients']) t[k] = 0;
    for (const r of flow.rows) {
      t.enc_all += r.encounters; t.enc_cancelled += r.cancelled; t.new_patients += r.new_patients;
      if (r.enc_type === 'outpatient' && r.visit_kind === 'consultation') t.enc_out += r.encounters;
      if (r.visit_kind === 'lab') t.enc_lab += r.encounters;
      if (r.enc_type === 'emergency') t.enc_emg += r.encounters;
    }
    for (const [k, v] of Object.entries(beds.rows[0] ?? {})) t[`beds_${k}`] = n(v);
    for (const [k, v] of Object.entries(or.rows[0] ?? {})) t[`or_${k}`] = n(v);
    for (const [k, v] of Object.entries(room.rows[0] ?? {})) t[`or_${k}`] = n(v);
    for (const p of ['lab', 'dx']) for (const k of ['ordered', 'cancelled', 'external', 'ext_cost', 'resulted']) t[`${p}_${k}`] = 0;
    const hists: Record<string, number[]> = { lab: Array(12).fill(0), dx: Array(12).fill(0) };
    for (const r of dx.rows) {
      const p = r.lab ? 'lab' : 'dx';
      t[`${p}_ordered`] = r.ordered; t[`${p}_cancelled`] = r.cancelled; t[`${p}_external`] = r.external; t[`${p}_ext_cost`] = r2(n(r.ext_cost)); t[`${p}_resulted`] = r.resulted;
    }
    for (const h of hist.rows) hists[h.lab ? 'lab' : 'dx'][h.k - 1] = h.c;
    t.lab_tat_p50 = histPercentile(hists.lab, 0.5) ?? NaN; t.lab_tat_p90 = histPercentile(hists.lab, 0.9) ?? NaN; t.dx_tat_p50 = histPercentile(hists.dx, 0.5) ?? NaN;
    for (const [k, v] of Object.entries(stock.rows[0] ?? {})) t[`stock_${k}`] = n(v);
    for (const [k, v] of Object.entries(fin.rows[0] ?? {})) t[`fin_${k}`] = n(v);
    // 0066: ხარისხი — ჯამები და ინდიკატორების მრიცხველები (qmi_<code>)
    for (const k of ['qm_n', 'qm_harm', 'qm_no_harm', 'qm_near_miss', 'qm_hazard', 'qm_sentinel', 'qm_anonymous', 'qm_inpatient', 'qm_triaged', 'qm_on_time']) t[k] = 0;
    for (const i of ind.list) t[`qmi_${i.code}`] = 0;
    for (const r of qm.rows) {
      t.qm_n += r.n; t[`qm_${r.event_type}`] += r.n; t.qm_anonymous += r.anonymous; t.qm_triaged += r.triaged; t.qm_on_time += r.on_time;
      if (r.is_sentinel) t.qm_sentinel += r.n;
      if (r.service_type === 'inpatient') t.qm_inpatient += r.n;
      for (const i of ind.list) if (indicatorMatch(i, ind.cats.get(i.code)!, r)) t[`qmi_${i.code}`] += r.n;
    }
    const qh = Array(12).fill(0); for (const h of qmHist.rows) qh[h.k - 1] = h.c;
    t.qm_triage_p50 = histPercentile(qh, 0.5) ?? NaN;
    for (const [k, v] of Object.entries(ipc.rows[0] ?? {})) t[`ipc_${k}`] = n(v);
    for (const [k, v] of Object.entries(ipcd.rows[0] ?? {})) t[`ipcd_${k}`] = n(v);
    return t;
  }

  /** 0066: ინდიკატორის მნიშვნელობა ჯამებიდან (null — მნიშვნელი 0 ან ინდიკატორი არ არსებობს) */
  indicatorValue(code: string, t: Totals, s: RptSettings): number | null {
    const i = this.ind?.list.find((x) => x.code === code);
    if (!i) return null;
    const den = i.denominator === 'bed_days' ? bedDays(s.occupancy_basis, t.beds_occupied_hours ?? 0, t.beds_midnight_census ?? 0)
      : i.denominator === 'admissions' ? (t.beds_admissions ?? 0) : (t.enc_all ?? 0);
    return rate(t[`qmi_${code}`] ?? 0, den, i.per);
  }

  /** მომენტალური (snapshot) ჯამები */
  async snapshotTotals(scope: RptScope, s: RptSettings): Promise<Snap> {
    const [r, q] = await Promise.all([sql<{ low: number; exp90: string }>`
      SELECT count(*) FILTER (WHERE f.days_of_supply IS NOT NULL AND f.days_of_supply < ${s.stock_days_alert})::int AS low,
             coalesce(sum(f.expiring_value_90), 0)::text AS exp90
        FROM rpt_stock_snapshot f WHERE ${this.where(scope, 'f')}`.execute(this.rdb),
      sql<{ overdue: number }>`SELECT coalesce(sum(f.overdue_capa), 0)::int AS overdue FROM rpt_quality_snapshot f WHERE ${this.where(scope, 'f')}`.execute(this.rdb)]);
    return { stock_low: r.rows[0].low, stock_exp90: r2(n(r.rows[0].exp90)), qm_capa_overdue: q.rows[0].overdue };
  }

  /** KPI-ის მნიშვნელობა ჯამებიდან; null — მნიშვნელი 0 / მონაცემი არ არის */
  value(code: string, t: Totals, snap: Snap | null, s: RptSettings): number | null {
    const nan = (x: number) => (Number.isNaN(x) ? null : x);
    const revNet = (t.fin_rev_patient ?? 0) + (t.fin_rev_insurance ?? 0) + (t.fin_rev_state ?? 0) + (t.fin_rev_other ?? 0) + (t.fin_rev_undetermined ?? 0);
    const costs = (t.fin_expenses ?? 0) + (t.fin_stock_cost ?? 0);
    const avgBeds = (t.beds_available_hours ?? 0) / 24 / (t.days || 1);
    switch (code) {
      case 'enc_total': return t.enc_all;
      case 'enc_outpatient': return t.enc_out;
      case 'enc_lab_only': return t.enc_lab;
      case 'enc_emergency': return t.enc_emg;
      case 'new_patients': return t.new_patients;
      case 'enc_cancel_pct': return pct(t.enc_cancelled, t.enc_all + t.enc_cancelled);
      case 'occupancy_pct': return s.occupancy_basis === 'midnight'
        ? (avgBeds > 0 ? r1((t.beds_midnight_census / (t.days || 1) / avgBeds) * 100) : null)
        : pct(t.beds_occupied_hours, t.beds_available_hours);
      case 'census_avg': return div(t.beds_midnight_census, t.days || 1);
      case 'admissions': return t.beds_admissions;
      case 'discharges': return t.beds_discharges;
      case 'alos': return div(t.beds_los_days_sum, t.beds_discharges);
      case 'bed_turnover': return avgBeds > 0 ? Math.round((t.beds_discharges / avgBeds) * 100) / 100 : null;
      case 'turnover_interval': return t.beds_discharges > 0 ? r1(Math.max(0, t.beds_available_hours - t.beds_occupied_hours) / 24 / t.beds_discharges) : null;
      case 'mortality_pct': return pct(t.beds_deaths, t.beds_discharges);
      case 'readmit30_pct': return pct(t.beds_readmissions_30, t.beds_admissions);
      case 'or_cases': return t.or_done;
      case 'or_emergency_pct': return pct(t.or_emergency, t.or_done);
      case 'or_utilization_pct': return pct(t.or_used_min, t.or_avail_min);
      case 'or_first_on_time_pct': return pct(t.or_first_on_time, t.or_first_cases);
      case 'or_cancel_pct': return pct(t.or_cancelled, t.or_scheduled);
      case 'or_surgery_min_avg': return div(t.or_surgery_min, t.or_surgery_cases);
      case 'dx_orders': return t.dx_ordered;
      case 'dx_tat_median_h': return t.dx_tat_p50 === undefined || Number.isNaN(t.dx_tat_p50) ? null : r1(t.dx_tat_p50 / 60);
      case 'dx_cancel_pct': return pct(t.dx_cancelled, t.dx_ordered + t.dx_cancelled);
      case 'lab_orders': return t.lab_ordered;
      case 'lab_tat_median_min': return nan(t.lab_tat_p50);
      case 'lab_tat_p90_min': return nan(t.lab_tat_p90);
      case 'lab_external_pct': return pct(t.lab_external, t.lab_ordered);
      case 'lab_ext_cost': return r2(t.lab_ext_cost);
      case 'stock_consumption': return r2(t.stock_consumption);
      case 'stock_loss': return r2(t.stock_loss);
      case 'stock_low_items': return snap?.stock_low ?? null;
      case 'stock_expiring_90': return snap?.stock_exp90 ?? null;
      case 'rev_net': return r2(revNet);
      case 'rev_state_pct': return pct(t.fin_rev_state, revNet);
      case 'rev_insurance_pct': return pct(t.fin_rev_insurance, revNet);
      case 'payments': return r2(t.fin_payments);
      case 'costs_total': return r2(costs);
      case 'result': return r2(revNet - costs);
      case 'margin_pct': return revNet > 0 ? r1(((revNet - costs) / revNet) * 100) : null;
      case 'denied_amount': return r2(t.fin_rev_denied);
      // 0066: ხარისხი
      case 'qm_reported': return t.qm_n ?? 0;
      case 'qm_harm': return t.qm_harm ?? 0;
      case 'qm_sentinel': return t.qm_sentinel ?? 0;
      case 'qm_near_miss_ratio': return div(t.qm_near_miss ?? 0, (t.qm_harm ?? 0) + (t.qm_no_harm ?? 0), 2);
      case 'qm_report_rate': return rate(t.qm_inpatient ?? 0, bedDays(s.occupancy_basis, t.beds_occupied_hours ?? 0, t.beds_midnight_census ?? 0), 1000);
      case 'qm_triage_median_h': return t.qm_triage_p50 === undefined || Number.isNaN(t.qm_triage_p50) ? null : r1(t.qm_triage_p50 / 60);
      case 'qm_triage_on_time': return pct(t.qm_on_time ?? 0, t.qm_triaged ?? 0);
      case 'qm_capa_overdue': return snap?.qm_capa_overdue ?? null;
      // 0072: ინფექციის კონტროლი
      case 'ipc_hai_rate': return rate(t.ipc_hai ?? 0, t.ipcd_pd ?? 0, 1000);
      case 'ipc_clabsi_rate': return rate(t.ipc_clabsi ?? 0, t.ipcd_cl ?? 0, 1000);
      case 'ipc_cauti_rate': return rate(t.ipc_cauti ?? 0, t.ipcd_uc ?? 0, 1000);
      case 'ipc_vap_rate': return rate(t.ipc_vap ?? 0, t.ipcd_vent ?? 0, 1000);
      case 'ipc_ssi_pct': return pct(t.ipc_ssi ?? 0, t.ipc_ssi_ops ?? 0);
      case 'ipc_mdro_rate': return rate(t.ipc_mdro_hosp ?? 0, t.ipcd_pd ?? 0, 1000);
      case 'ipc_ddd_100': return rate(t.ipc_ddd ?? 0, t.ipcd_pd ?? 0, 100);
      case 'ipc_access_pct': return pct(t.ipc_ddd_access ?? 0, t.ipc_ddd ?? 0);
      case 'ipc_hh_pct': return pct(t.ipc_hh_done ?? 0, t.ipc_hh_opps ?? 0);
      case 'ipc_handrub_l': return rate(t.ipc_handrub_l ?? 0, t.ipcd_pd ?? 0, 1000);
      default: return code.startsWith('qm_ind_') ? this.indicatorValue(code.slice(7), t, s) : null;
    }
  }

  /** შედარების პერიოდი */
  comparePeriod(from: string, to: string, mode: 'prev' | 'yoy' | 'none') {
    if (mode === 'none') return null;
    if (mode === 'prev') { const len = daysBetween(from, to); return { from: addDays(from, -len), to: addDays(from, -1) }; }
    const y = (d: string) => { const [yy, mm, dd] = d.split('-').map(Number); const x = new Date(Date.UTC(yy - 1, mm - 1, dd)); if (x.getUTCMonth() !== mm - 1) x.setUTCDate(0); return x.toISOString().slice(0, 10); };
    return { from: y(from), to: y(to) };
  }

  /** სტატუსი სამიზნესთან: green / yellow / red; null — სამიზნე არ არის ან მიმართულება none */
  status(value: number | null, direction: string, target: { target: number; warn: number | null } | undefined) {
    if (value === null || !target || direction === 'none') return null;
    const better = (a: number, b: number) => (direction === 'up' ? a >= b : a <= b);
    if (better(value, target.target)) return 'green';
    if (target.warn !== null && better(value, target.warn)) return 'yellow';
    return 'red';
  }

  /** სამიზნეები: განყოფილების (თუ ერთ განყოფილებას ვუყურებთ) → კლინიკის */
  async targets(dept: string | null) {
    const rows = await this.rdb.selectFrom('rpt_kpi_targets').select(['kpi_code', 'department_id', 'target', 'warn']).execute();
    const out = new Map<string, { target: number; warn: number | null; level: 'department' | 'clinic' }>();
    for (const r of rows.filter((x) => x.department_id === null)) out.set(r.kpi_code, { target: n(r.target), warn: r.warn === null ? null : n(r.warn), level: 'clinic' });
    if (dept) for (const r of rows.filter((x) => x.department_id === dept)) out.set(r.kpi_code, { target: n(r.target), warn: r.warn === null ? null : n(r.warn), level: 'department' });
    return out;
  }

  async kpis(scope: RptScope, onlyActive = true): Promise<KpiRow[]> {
    let q = this.c.db.selectFrom('rpt_kpis').select(['code', 'category', 'name', 'unit', 'direction', 'definition', 'formula', 'source', 'finance', 'snapshot', 'drill', 'sort_order']);
    if (onlyActive) q = q.where('is_active', '=', true);
    const rows = await q.orderBy('sort_order').orderBy('code').execute();
    return rows.filter((k) => (scope.finance || !k.finance) && (k.category !== 'quality' || !!scope.quality) && (k.category !== 'ipc' || !!scope.ipc));
  }

  /** დროის მწკრივი: grain = day / week / month (KPI ითვლება თითო ინტერვალზე) */
  intervals(from: string, to: string, grain: 'day' | 'week' | 'month') {
    if (!['day', 'week', 'month'].includes(grain)) throw new BadRequestException('grain: day / week / month');
    const out: { label: string; from: string; to: string }[] = [];
    let cur = from;
    while (cur <= to) {
      let end: string;
      if (grain === 'day') end = cur;
      else if (grain === 'week') { const dow = (new Date(`${cur}T00:00:00Z`).getUTCDay() + 6) % 7; end = addDays(cur, 6 - dow); }
      else { const d = new Date(`${cur}T00:00:00Z`); end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10); }
      if (end > to) end = to;
      out.push({ label: grain === 'month' ? cur.slice(0, 7) : cur, from: cur, to: end });
      cur = addDays(end, 1);
    }
    if (out.length > 400) throw new BadRequestException('ძალიან ბევრი ინტერვალი — აირჩიეთ კვირა / თვე');
    return out;
  }
}
