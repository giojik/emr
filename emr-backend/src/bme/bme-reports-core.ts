import { sql, type RawBuilder, type Transaction } from 'kysely';
import type { Database } from '../database/database.module';
import type { DB } from '../database/db';
import type { BmeSettings, Ex } from './bme-common';
import { TZ } from './bme-pm-common';
import { slaState } from './bme-repair-common';

/**
 * ბიომედ-აპარატურა, ეტაპი 4 (0076) — ანგარიშების / KPI-ის საერთო გამოთვლა (ანგარიშის გვერდი, პასპორტი, რეპორტინგის გადათვლა — rpt_fact_bme).
 *
 *  • ფანჯარა: [from 00:00, min(to + 1 დღე, at)) კლინიკის დროით; at — „ახლა“ (ღია პერიოდები / ორდერები აქამდე იჭრება; ტესტში — ჩანაცვლებადი).
 *  • განყოფილება — იმ მომენტში მოქმედი (bme_moves: done, decided_at); პერიოდი იჭრება გადაადგილებაზე.
 *  • საათები (bme_status_periods): ექსპლუატაცია = operational / restricted / down (standby / retired / install_date-მდე — არა); down — მოცდენა;
 *      down + repair_id — არადაგეგმილი.
 *  • ორდერები: კოჰორტა reported_at-ით (მოთხოვნა, მწყობრიდან გამოსვლა, მიზეზები, SLA) და შესრულება done_at-ით (MTTR, ხარჯი).
 *  • PM: ვადა პერიოდში (სამუშაო due_date / აქტიური გეგმა სამუშაოს გარეშე), ვადა at-მდე გასული ან შესრულებული.
 *  • ხარჯი: ნაწილები (საწყობის ჩამოწერა bme_use, შემობრუნების გარეშე) + შრომა + გარე (ორდერი, done_at) + PM (performed_on) + კონტრაქტი (დღიური წილი).
 */
export type Mode = 'fact' | 'month' | 'device';
export interface Win { from: string; to: string; at: string | null; atDay: string; dTo: string }
export interface Filt {
  depts?: string[] | null; device_ids?: string[] | null; type_id?: string | null; grp?: string | null; criticality?: string | null;
  supplier_id?: string | null; performer?: 'internal' | 'external' | null;
}

export const ACC_KEYS = ['avail_h', 'down_h', 'down_unpl_h', 'restricted_h', 'ls_avail_h', 'ls_down_h', 'ls_restricted_h', 'failures', 'failures_ue', 'reopened', 'requests',
  'user_error', 'nff', 'sla_resp_n', 'sla_resp_met', 'sla_rest_n', 'sla_rest_met', 'repairs_done', 'restore_h', 'rep_down_h', 'pm_due', 'pm_ontime', 'pm_fail',
  'cost_parts', 'cost_labor', 'cost_external', 'cost_pm', 'cost_contract'] as const;
export type AccKey = (typeof ACC_KEYS)[number];
export type Acc = Record<AccKey, number>;
export const zeroAcc = (): Acc => Object.fromEntries(ACC_KEYS.map((k) => [k, 0])) as Acc;
export const addAcc = (a: Acc, b: Partial<Acc>) => { for (const k of ACC_KEYS) a[k] += Number(b[k] ?? 0) || 0; return a; };
export const HOUR_KEYS: AccKey[] = ['avail_h', 'down_h', 'down_unpl_h', 'restricted_h', 'ls_avail_h', 'ls_down_h', 'ls_restricted_h'];
export const COST_KEYS: AccKey[] = ['cost_parts', 'cost_labor', 'cost_external', 'cost_pm', 'cost_contract'];
export const costTotal = (a: Acc) => a.cost_parts + a.cost_labor + a.cost_external + a.cost_pm + a.cost_contract;

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const pct = (a: number, b: number) => (b > 0 ? r1((a / b) * 100) : null);
const availPct = (avail: number, down: number, restricted: number, w: number) => (avail > 0 ? Math.round((1 - (down + w * restricted) / avail) * 10000) / 100 : null);

export type RptRules = Pick<BmeSettings, 'rpt_restricted_weight' | 'rpt_mtbf_exclude_user_error' | 'rpt_contract_alloc' | 'rpt_cosr_warn_pct' | 'rpt_pm_grace_days'
  | 'dashboard_visibility' | 'monthly_section'>;
export const RPT_DEFAULTS: RptRules = { rpt_restricted_weight: 0, rpt_mtbf_exclude_user_error: false, rpt_contract_alloc: 'equal', rpt_cosr_warn_pct: 10, rpt_pm_grace_days: 0,
  dashboard_visibility: 'report_users', monthly_section: true };

/** მოდული ჩართულია → ანგარიშების პარამეტრები; გამორთული → null */
export async function bmeRptRules(db: Ex): Promise<RptRules | null> {
  const m = await db.selectFrom('system_modules').select(['enabled', 'settings']).where('code', '=', 'bme').executeTakeFirst();
  if (!m?.enabled) return null;
  return { ...RPT_DEFAULTS, ...((m.settings ?? {}) as Partial<RptRules>) };
}

/** KPI-ები და დამატებითი მაჩვენებლები ჯამებიდან (ანგარიში, პასპორტი, მენეჯერული დაფა — ერთი წესი) */
export function bmeKpis(a: Acc, s: Pick<RptRules, 'rpt_restricted_weight' | 'rpt_mtbf_exclude_user_error'>) {
  const w = Number(s.rpt_restricted_weight) || 0;
  const fails = a.failures - (s.rpt_mtbf_exclude_user_error ? a.failures_ue : 0);
  const up = a.avail_h - a.down_h;
  return {
    bme_availability_pct: availPct(a.avail_h, a.down_h, a.restricted_h, w),
    bme_avail_ls_pct: availPct(a.ls_avail_h, a.ls_down_h, a.ls_restricted_h, w),
    bme_mttr_h: a.repairs_done > 0 ? r1(a.restore_h / a.repairs_done) : null,
    bme_mtbf_d: fails > 0 ? r1(up / 24 / fails) : null,
    bme_sla_response_pct: pct(a.sla_resp_met, a.sla_resp_n),
    bme_sla_restore_pct: pct(a.sla_rest_met, a.sla_rest_n),
    bme_pm_ontime_pct: pct(a.pm_ontime, a.pm_due),
    bme_user_error_pct: pct(a.user_error, a.requests),
    bme_service_cost: r2(costTotal(a)),
    // დამატებითი (ანგარიში)
    unplanned_availability_pct: availPct(a.avail_h, a.down_unpl_h, 0, 0),
    mtbf_gt_d: fails === 0 && up > 0 ? r1(up / 24) : null,            // 0 მწყობრიდან გამოსვლა → „> X დღე“ (სამუშაო დრო)
    down_per_repair_h: a.repairs_done > 0 ? r1(a.rep_down_h / a.repairs_done) : null,
    reopen_pct: pct(a.reopened, a.failures),
    nff_pct: pct(a.nff, a.requests),
    pm_fail_pct: pct(a.pm_fail, a.pm_due),
    failures_eff: fails,
  };
}
export type BmeKpis = ReturnType<typeof bmeKpis>;
export const KPI_CODES = ['bme_availability_pct', 'bme_avail_ls_pct', 'bme_mttr_h', 'bme_mtbf_d', 'bme_sla_response_pct', 'bme_sla_restore_pct', 'bme_pm_ontime_pct',
  'bme_user_error_pct', 'bme_service_cost'] as const;

// ============================================================================================= SQL ნაწილები
/** ფანჯარა: atDay / dTo — კლინიკის დღე */
export async function makeWin(db: Ex, from: string, to: string, at: string | null): Promise<Win> {
  const r = (await sql<{ d: string }>`SELECT to_char((${at ? sql`${at}::timestamptz` : sql`now()`} AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS d`.execute(db)).rows[0];
  return { from, to, at, atDay: r.d, dTo: to < r.d ? to : r.d };
}
const atTs = (w: Win) => (w.at ? sql`${w.at}::timestamptz` : sql`now()`);
const tsA = (w: Win) => sql`(${w.from}::date)::timestamp AT TIME ZONE ${TZ}`;
const tsB = (w: Win) => sql`least((${w.to}::date + 1)::timestamp AT TIME ZONE ${TZ}, ${atTs(w)})`;
const ids = (x: string[]) => sql`${sql.val(x)}::uuid[]`;

/** dev (ფილტრი), mv / loc (განყოფილების სეგმენტები გადაადგილებით) */
function base(f: Filt) {
  const where: RawBuilder<unknown>[] = [sql`TRUE`];
  if (f.device_ids) where.push(sql`b.id = ANY(${ids(f.device_ids)})`);
  if (f.type_id) where.push(sql`b.type_id = ${f.type_id}::uuid`);
  if (f.grp) where.push(sql`t.grp = ${f.grp}`);
  if (f.criticality) where.push(sql`b.criticality = ${f.criticality}`);
  if (f.supplier_id) where.push(sql`(b.supplier_id = ${f.supplier_id}::uuid OR EXISTS (SELECT 1 FROM bme_contract_devices cd JOIN bme_contracts c ON c.id = cd.contract_id
                                          WHERE cd.device_id = b.id AND c.supplier_id = ${f.supplier_id}::uuid))`);
  return sql`dev AS (SELECT b.id, b.criticality, b.install_date FROM bme_devices b JOIN bme_device_types t ON t.id = b.type_id WHERE ${sql.join(where, sql` AND `)}),
    mv AS (SELECT m.device_id, m.decided_at AS at, m.from_department_id, m.to_department_id,
                  row_number() OVER (PARTITION BY m.device_id ORDER BY m.decided_at, m.id) AS rn,
                  lead(m.decided_at) OVER (PARTITION BY m.device_id ORDER BY m.decided_at, m.id) AS nxt
             FROM bme_moves m WHERE m.status = 'done' AND m.decided_at IS NOT NULL AND m.device_id IN (SELECT id FROM dev)),
    loc AS (SELECT d.id AS device_id, coalesce(f.from_department_id, b.department_id) AS dept, '-infinity'::timestamptz AS s, coalesce(f.at, 'infinity'::timestamptz) AS e
              FROM dev d JOIN bme_devices b ON b.id = d.id LEFT JOIN mv f ON f.device_id = d.id AND f.rn = 1
            UNION ALL
            SELECT device_id, to_department_id, at, coalesce(nxt, 'infinity'::timestamptz) FROM mv)`;
}
const deptAt = (dev: RawBuilder<unknown>, ts: RawBuilder<unknown>) =>
  sql<string | null>`(SELECT l.dept FROM loc l WHERE l.device_id = ${dev} AND l.s <= ${ts} AND l.e > ${ts} LIMIT 1)`;
const deptF = (f: Filt, col: RawBuilder<unknown>) => (f.depts ? sql`AND ${col} = ANY(${ids(f.depts)})` : sql``);
function keys(mode: Mode, day: RawBuilder<unknown>, dev: RawBuilder<unknown>) {
  if (mode === 'fact') return sql`to_char(${day}, 'YYYY-MM-DD') AS k, NULL::uuid AS device_id`;
  if (mode === 'month') return sql`to_char(${day}, 'YYYY-MM') AS k, NULL::uuid AS device_id`;
  return sql`NULL::text AS k, ${dev} AS device_id`;
}
export interface Row { k: string | null; device_id: string | null; department_id: string | null }
export type HRow = Row & Pick<Acc, 'avail_h' | 'down_h' | 'down_unpl_h' | 'restricted_h' | 'ls_avail_h' | 'ls_down_h' | 'ls_restricted_h'>;
export type CRow = Row & Pick<Acc, 'cost_parts' | 'cost_labor' | 'cost_external' | 'cost_pm' | 'cost_contract'>;

/** საათები: სტატუსის პერიოდი ∩ განყოფილების სეგმენტი ∩ დღე */
export async function hoursRows(db: Ex, w: Win, f: Filt, mode: Mode): Promise<HRow[]> {
  if (w.from > w.dTo) return [];
  const A = tsA(w); const B = tsB(w);
  return (await sql<HRow>`
    WITH ${base(f)},
    seg AS (SELECT p.device_id, p.status, p.repair_id,
                   greatest(p.started_at, ${A}, coalesce((d.install_date::timestamp AT TIME ZONE ${TZ}), '-infinity'::timestamptz)) AS s,
                   least(coalesce(p.ended_at, ${B}), ${B}) AS e
              FROM bme_status_periods p JOIN dev d ON d.id = p.device_id
             WHERE p.status IN ('operational', 'restricted', 'down') AND p.started_at < ${B} AND coalesce(p.ended_at, 'infinity'::timestamptz) > ${A}),
    x AS (SELECT seg.device_id, seg.status, seg.repair_id, l.dept, greatest(seg.s, l.s) AS s, least(seg.e, l.e) AS e
            FROM seg JOIN loc l ON l.device_id = seg.device_id AND l.s < seg.e AND l.e > seg.s WHERE seg.s < seg.e),
    dd AS (SELECT g.d::date AS day, (g.d::date)::timestamp AT TIME ZONE ${TZ} AS ds, (g.d::date + 1)::timestamp AT TIME ZONE ${TZ} AS de
             FROM generate_series(${w.from}::date, ${w.dTo}::date, interval '1 day') g(d)),
    h AS (SELECT x.device_id, x.status, x.repair_id, x.dept, dd.day, extract(epoch FROM (least(x.e, dd.de) - greatest(x.s, dd.ds))) / 3600.0 AS h
            FROM x JOIN dd ON x.s < dd.de AND x.e > dd.ds WHERE x.s < x.e)
    SELECT ${keys(mode, sql`h.day`, sql`h.device_id`)}, h.dept AS department_id,
           sum(h.h)::float8 AS avail_h,
           coalesce(sum(h.h) FILTER (WHERE h.status = 'down'), 0)::float8 AS down_h,
           coalesce(sum(h.h) FILTER (WHERE h.status = 'down' AND h.repair_id IS NOT NULL), 0)::float8 AS down_unpl_h,
           coalesce(sum(h.h) FILTER (WHERE h.status = 'restricted'), 0)::float8 AS restricted_h,
           coalesce(sum(h.h) FILTER (WHERE d.criticality = 'life_support'), 0)::float8 AS ls_avail_h,
           coalesce(sum(h.h) FILTER (WHERE d.criticality = 'life_support' AND h.status = 'down'), 0)::float8 AS ls_down_h,
           coalesce(sum(h.h) FILTER (WHERE d.criticality = 'life_support' AND h.status = 'restricted'), 0)::float8 AS ls_restricted_h
      FROM h JOIN dev d ON d.id = h.device_id
     WHERE TRUE ${deptF(f, sql`h.dept`)}
     GROUP BY 1, 2, 3`.execute(db)).rows;
}

/** ხარჯი: ორდერი (done_at) + PM (performed_on) + კონტრაქტი (დღიური წილი) */
export async function costRows(db: Ex, w: Win, f: Filt, mode: Mode, s: Pick<RptRules, 'rpt_contract_alloc'>): Promise<CRow[]> {
  if (w.from > w.dTo) return [];
  const A = tsA(w); const B = tsB(w);
  const perf = f.performer ? sql`AND r.performer_kind = ${f.performer}` : sql``;
  const perfW = f.performer ? sql`AND w.performer_kind = ${f.performer}` : sql``;
  const noon = (d: RawBuilder<unknown>) => sql`((${d})::timestamp AT TIME ZONE ${TZ}) + interval '12 hours'`;
  return (await sql<CRow>`
    WITH ${base(f)},
    rc AS (SELECT r.device_id, r.done_at AS ts, r.labor_cost::float8 AS labor, r.external_cost::float8 AS ext,
                  coalesce((SELECT sum(sd.total_net) FROM stock_docs sd WHERE sd.bme_repair_id = r.id AND sd.doc_type = 'writeoff' AND sd.status = 'posted'
                             AND sd.reversed_by IS NULL), 0)::float8 AS parts
             FROM bme_repairs r JOIN dev d ON d.id = r.device_id
            WHERE r.status IN ('done', 'closed') AND r.done_at >= ${A} AND r.done_at < ${B} ${perf}),
    pc AS (SELECT w.device_id, ${noon(sql`w.performed_on`)} AS ts, (w.labor_cost + w.external_cost)::float8 AS pm
             FROM bme_works w JOIN dev d ON d.id = w.device_id
            WHERE w.status = 'done' AND w.performed_on BETWEEN ${w.from}::date AND ${w.dTo}::date AND (w.labor_cost > 0 OR w.external_cost > 0) ${perfW}),
    cc AS (SELECT c.id, c.start_date, least(c.end_date, CASE WHEN c.status = 'cancelled' THEN (c.updated_at AT TIME ZONE ${TZ})::date END) AS end_d,
                  (CASE c.cost_period WHEN 'once' THEN c.cost / (c.end_date - c.start_date + 1) WHEN 'month' THEN c.cost * 12 / 365.0
                                      WHEN 'quarter' THEN c.cost * 4 / 365.0 ELSE c.cost / 365.0 END)::float8 AS daily
             FROM bme_contracts c WHERE c.cost > 0 AND ${f.performer === 'internal' ? sql`FALSE` : sql`TRUE`}),
    cdv AS (SELECT cc.id, cc.start_date, cc.end_d, cc.daily, cd.device_id,
                   CASE WHEN ${s.rpt_contract_alloc === 'value'} AND sum(coalesce(b.purchase_value, 0)) OVER wn > 0
                        THEN coalesce(b.purchase_value, 0)::float8 / sum(coalesce(b.purchase_value, 0)) OVER wn ELSE 1.0 / count(*) OVER wn END AS share
              FROM cc JOIN bme_contract_devices cd ON cd.contract_id = cc.id JOIN bme_devices b ON b.id = cd.device_id
            WINDOW wn AS (PARTITION BY cc.id)),
    ct AS (SELECT cdv.device_id, ${noon(sql`g.d::date`)} AS ts, cdv.daily * cdv.share AS cost
             FROM cdv JOIN dev d ON d.id = cdv.device_id
             CROSS JOIN LATERAL generate_series(greatest(cdv.start_date, ${w.from}::date), least(cdv.end_d, ${w.dTo}::date), interval '1 day') g(d)),
    ev AS (SELECT device_id, ts, parts, labor, ext, 0::float8 AS pm, 0::float8 AS ctr FROM rc
           UNION ALL SELECT device_id, ts, 0, 0, 0, pm, 0 FROM pc
           UNION ALL SELECT device_id, ts, 0, 0, 0, 0, cost FROM ct),
    e2 AS (SELECT ev.*, (ev.ts AT TIME ZONE ${TZ})::date AS day, l.dept FROM ev LEFT JOIN loc l ON l.device_id = ev.device_id AND l.s <= ev.ts AND l.e > ev.ts)
    SELECT ${keys(mode, sql`e2.day`, sql`e2.device_id`)}, e2.dept AS department_id,
           sum(parts)::float8 AS cost_parts, sum(labor)::float8 AS cost_labor, sum(ext)::float8 AS cost_external, sum(pm)::float8 AS cost_pm, sum(ctr)::float8 AS cost_contract
      FROM e2 WHERE TRUE ${deptF(f, sql`e2.dept`)}
     GROUP BY 1, 2, 3`.execute(db)).rows;
}

export interface RepRow {
  id: string; repair_no: string; device_id: string; status: string; priority: number | null; suggested_priority: number; condition: string; urgency: string; source: string;
  performer_kind: string; supplier_id: string | null; supplier_name: string | null; contract_id: string | null; contract_no: string | null; coverage: string | null;
  outcome: string | null; cause_code: string | null; cause_name: string | null; action_code: string | null; action_name: string | null; reject_reason: string | null; reopen_count: number;
  reported_at: string; done_at: string | null; rep_day: string; done_day: string | null; in_rep: boolean; in_done: boolean; dept_rep: string | null; dept_done: string | null;
  sla_response_hours: number | null; sla_restore_hours: number | null; resp_state: string | null; rest_state: string | null;
  resp_h: number | null; restore_h: number | null; rep_down_h: number; wait_h: number; labor_cost: number; external_cost: number; parts: number;
}
/** ორდერები: მოთხოვნა ან შესრულება ფანჯარაში (ანგარიშის / ფაქტის საფუძველი) */
export async function repairList(db: Ex, w: Win, f: Filt): Promise<RepRow[]> {
  if (w.from > w.dTo) return [];
  const A = tsA(w); const B = tsB(w); const N = atTs(w);
  const perf = f.performer ? sql`AND r.performer_kind = ${f.performer}` : sql``;
  const rows = (await sql<RepRow>`
    WITH ${base(f)},
    r AS (SELECT r.* FROM bme_repairs r JOIN dev d ON d.id = r.device_id
           WHERE ((r.reported_at >= ${A} AND r.reported_at < ${B}) OR (r.done_at >= ${A} AND r.done_at < ${B})) ${perf})
    SELECT r.id, r.repair_no, r.device_id, r.status, r.priority, r.suggested_priority, r.condition, r.urgency, r.source, r.performer_kind,
           r.supplier_id, s.name AS supplier_name, r.contract_id, c.contract_no, r.coverage, r.outcome,
           cc.code AS cause_code, cc.name AS cause_name, ac.code AS action_code, ac.name AS action_name, r.reject_reason, r.reopen_count,
           r.reported_at, r.done_at, to_char((r.reported_at AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS rep_day, to_char((r.done_at AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS done_day,
           (r.reported_at >= ${A} AND r.reported_at < ${B}) AS in_rep, coalesce(r.done_at >= ${A} AND r.done_at < ${B}, FALSE) AS in_done,
           ${deptAt(sql`r.device_id`, sql`r.reported_at`)} AS dept_rep, CASE WHEN r.done_at IS NOT NULL THEN ${deptAt(sql`r.device_id`, sql`r.done_at`)} END AS dept_done,
           r.sla_response_hours, r.sla_restore_hours, ${slaState('response', 80, N)} AS resp_state, ${slaState('restore', 80, N)} AS rest_state,
           (extract(epoch FROM (CASE WHEN r.performer_kind = 'external' THEN r.vendor_arrived_at - r.vendor_called_at ELSE r.started_at - r.reported_at END)) / 3600.0)::float8 AS resp_h,
           (extract(epoch FROM (r.done_at - r.reported_at)) / 3600.0)::float8 AS restore_h,
           coalesce((SELECT sum(extract(epoch FROM (least(coalesce(p.ended_at, ${N}), ${N}) - p.started_at))) / 3600.0 FROM bme_status_periods p
                      WHERE p.repair_id = r.id AND p.status = 'down' AND p.started_at < ${N}), 0)::float8 AS rep_down_h,
           coalesce((SELECT sum(extract(epoch FROM (least(coalesce((SELECT min(e2.created_at) FROM bme_repair_events e2 WHERE e2.repair_id = r.id AND e2.id > e.id
                                                                    AND e2.kind IN ('resumed', 'waiting', 'done', 'rejected', 'duplicate')), ${N}), ${N}) - e.created_at))) / 3600.0
                       FROM bme_repair_events e WHERE e.repair_id = r.id AND e.kind = 'waiting' AND e.created_at < ${N}), 0)::float8 AS wait_h,
           r.labor_cost::float8 AS labor_cost, r.external_cost::float8 AS external_cost,
           coalesce((SELECT sum(sd.total_net) FROM stock_docs sd WHERE sd.bme_repair_id = r.id AND sd.doc_type = 'writeoff' AND sd.status = 'posted' AND sd.reversed_by IS NULL), 0)::float8 AS parts
      FROM r LEFT JOIN stock_suppliers s ON s.id = r.supplier_id LEFT JOIN bme_contracts c ON c.id = r.contract_id
      LEFT JOIN bme_repair_codes cc ON cc.id = r.cause_id LEFT JOIN bme_repair_codes ac ON ac.id = r.action_id
     ORDER BY r.reported_at`.execute(db)).rows;
  return rows.map((r) => ({ ...r, reported_at: new Date(r.reported_at).toISOString(), done_at: r.done_at ? new Date(r.done_at).toISOString() : null }));
}

export interface PmRow {
  id: string | null; work_no: string | null; device_id: string; kind_id: string; kind_code: string; kind_name: string; due: string; performed: string | null;
  status: string; result: string | null; performer_kind: string | null; dept: string | null; ontime: boolean; overdue_days: number | null;
}
/** PM ვადები: სამუშაო (due_date) + აქტიური გეგმა სამუშაოს გარეშე (next_due) */
export async function pmList(db: Ex, w: Win, f: Filt, s: Pick<RptRules, 'rpt_pm_grace_days'>): Promise<PmRow[]> {
  if (w.from > w.dTo) return [];
  const perfW = f.performer ? sql`AND w.performer_kind = ${f.performer}` : sql``;
  const grace = Number(s.rpt_pm_grace_days) || 0;
  return (await sql<PmRow>`
    WITH ${base(f)},
    it AS (SELECT w.id::text AS id, w.work_no, w.device_id, w.kind_id, w.due_date, w.performed_on, w.status, w.result, w.performer_kind
             FROM bme_works w JOIN dev d ON d.id = w.device_id
            WHERE w.status <> 'cancelled' AND w.due_date BETWEEN ${w.from}::date AND ${w.dTo}::date AND (w.due_date < ${w.atDay}::date OR w.status = 'done') ${perfW}
           UNION ALL
           SELECT NULL, NULL, p.device_id, p.kind_id, p.next_due, NULL, 'missing', NULL, NULL
             FROM bme_plans p JOIN dev d ON d.id = p.device_id JOIN bme_devices b ON b.id = p.device_id
            WHERE ${f.performer ? sql`FALSE` : sql`TRUE`} AND p.is_active AND b.status <> 'retired'
              AND p.next_due BETWEEN ${w.from}::date AND ${w.dTo}::date AND p.next_due < ${w.atDay}::date
              AND NOT EXISTS (SELECT 1 FROM bme_works x WHERE x.plan_id = p.id AND x.status <> 'cancelled' AND x.due_date = p.next_due)),
    i2 AS (SELECT it.*, l.dept FROM it LEFT JOIN loc l ON l.device_id = it.device_id
             AND l.s <= ((it.due_date)::timestamp AT TIME ZONE ${TZ}) + interval '12 hours' AND l.e > ((it.due_date)::timestamp AT TIME ZONE ${TZ}) + interval '12 hours')
    SELECT i2.id, i2.work_no, i2.device_id, i2.kind_id, k.code AS kind_code, k.short_name AS kind_name, to_char(i2.due_date, 'YYYY-MM-DD') AS due,
           to_char(i2.performed_on, 'YYYY-MM-DD') AS performed, i2.status, i2.result, i2.performer_kind, i2.dept,
           (i2.status = 'done' AND i2.performed_on <= i2.due_date + ${grace}::int) AS ontime,
           CASE WHEN i2.status <> 'done' THEN (${w.atDay}::date - i2.due_date)::int END AS overdue_days
      FROM i2 JOIN bme_work_kinds k ON k.id = i2.kind_id
     WHERE TRUE ${deptF(f, sql`i2.dept`)}
     ORDER BY i2.due_date`.execute(db)).rows;
}

// ============================================================================================= აგრეგაცია
export interface Raw { hours: HRow[]; costs: CRow[]; repairs: RepRow[]; pm: PmRow[] }
type KeyFn = (x: { k: string | null; device_id: string | null; dept: string | null }) => string | null;
const inDepts = (f: Filt, d: string | null) => !f.depts || (!!d && f.depts.includes(d));

/** ორდერის წვლილი (კოჰორტა / შესრულება) */
export function repCohort(r: RepRow): Partial<Acc> {
  const valid = r.status !== 'duplicate';
  const failure = !['rejected', 'duplicate'].includes(r.status) && r.outcome !== 'no_fault';
  return {
    requests: valid ? 1 : 0,
    failures: failure ? 1 : 0, failures_ue: failure && r.cause_code === 'USER_ERROR' ? 1 : 0, reopened: failure && r.reopen_count > 0 ? 1 : 0,
    user_error: valid && (r.cause_code === 'USER_ERROR' || r.reject_reason === 'user_error') ? 1 : 0,
    nff: valid && (r.outcome === 'no_fault' || r.reject_reason === 'no_fault') ? 1 : 0,
    sla_resp_n: r.resp_state === 'met' || r.resp_state === 'breached' ? 1 : 0, sla_resp_met: r.resp_state === 'met' ? 1 : 0,
    sla_rest_n: r.rest_state === 'met' || r.rest_state === 'breached' ? 1 : 0, sla_rest_met: r.rest_state === 'met' ? 1 : 0,
  };
}
export function repDone(r: RepRow): Partial<Acc> {
  const ok = ['done', 'closed'].includes(r.status) && r.outcome !== 'no_fault';
  return { repairs_done: ok ? 1 : 0, restore_h: ok ? Number(r.restore_h ?? 0) : 0, rep_down_h: ok ? Number(r.rep_down_h ?? 0) : 0 };
}

/**
 * ჯამები key-ით: საათები / ხარჯი — SQL-ის რეჟიმის (mode) გასაღებით; ორდერები / PM — იგივე წესით (evMode: day → დღე, month → თვე, null — გასაღების გარეშე).
 * ხარჯი ორდერიდან უკვე costRows-შია (ორჯერ არ ითვლება).
 */
export function aggregate(raw: Raw, f: Filt, key: KeyFn, evMode: 'day' | 'month' | null): Map<string, Acc> {
  const m = new Map<string, Acc>();
  const put = (k: string | null, v: Partial<Acc>) => { if (k === null) return; let a = m.get(k); if (!a) { a = zeroAcc(); m.set(k, a); } addAcc(a, v); };
  const ek = (d: string | null) => (evMode === 'day' ? d : evMode === 'month' ? d?.slice(0, 7) ?? null : null);
  for (const h of raw.hours) put(key({ k: h.k, device_id: h.device_id, dept: h.department_id }), h);
  for (const c of raw.costs) put(key({ k: c.k, device_id: c.device_id, dept: c.department_id }), c);
  for (const r of raw.repairs) {
    if (r.in_rep && inDepts(f, r.dept_rep)) put(key({ k: ek(r.rep_day), device_id: r.device_id, dept: r.dept_rep }), repCohort(r));
    if (r.in_done && inDepts(f, r.dept_done)) put(key({ k: ek(r.done_day), device_id: r.device_id, dept: r.dept_done }), repDone(r));
  }
  for (const p of raw.pm) put(key({ k: ek(p.due), device_id: p.device_id, dept: p.dept }), { pm_due: 1, pm_ontime: p.ontime ? 1 : 0, pm_fail: p.result === 'fail' ? 1 : 0 });
  return m;
}

export async function loadRaw(db: Ex, w: Win, f: Filt, mode: Mode, s: RptRules): Promise<Raw> {
  const [hours, costs, repairs, pm] = await Promise.all([hoursRows(db, w, f, mode), costRows(db, w, f, mode, s), repairList(db, w, f), pmList(db, w, f, s)]);
  return { hours, costs, repairs, pm };
}

// ============================================================================================= რეპორტინგის გადათვლა / „ყურადღება“
/** rpt_fact_bme (დღე × განყოფილება) — ფანჯრის DELETE → INSERT; მოდული გამორთულია → {} */
export async function bmeFacts(rdb: Database, trx: Transaction<DB>, from: string, to: string): Promise<Record<string, number>> {
  const s = await bmeRptRules(rdb);
  if (!s) return {};
  const w = await makeWin(rdb, from, to, null);
  const raw = await loadRaw(rdb, w, {}, 'fact', s);
  const agg = aggregate(raw, {}, (x) => `${x.k}|${x.dept ?? ''}`, 'day');
  await sql`DELETE FROM rpt_fact_bme WHERE day BETWEEN ${from}::date AND ${to}::date`.execute(trx);
  const vals = [...agg.entries()].filter(([k]) => !k.startsWith('null|')).map(([k, a]) => {
    const [day, dep] = k.split('|');
    const row: Record<string, unknown> = { day, department_id: dep || null };
    for (const c of ACC_KEYS) row[c] = HOUR_KEYS.includes(c) || c === 'restore_h' || c === 'rep_down_h' ? String(Math.round(a[c] * 1e6) / 1e6)
      : COST_KEYS.includes(c) ? String(r2(a[c])) : Math.round(a[c]);
    return row;
  });
  for (let i = 0; i < vals.length; i += 1000) await trx.insertInto('rpt_fact_bme').values(vals.slice(i, i + 1000) as never).execute();
  return { bme: vals.length };
}

/** მენეჯერული დაფის „ყურადღება“ — მხოლოდ რაოდენობები; depts = null — მთელი კლინიკა (აპარატის ამჟამინდელი განყოფილება) */
export async function bmeAttentionCounts(db: Database, depts: string[] | null) {
  const s = await bmeRptRules(db);
  if (!s) return null;
  const pct = ((await db.selectFrom('system_modules').select('settings').where('code', '=', 'bme').executeTakeFirst())?.settings as { rep_sla_warn_pct?: number } | null)?.rep_sla_warn_pct ?? 80;
  const f = depts ? sql`b.department_id = ANY(${ids(depts)})` : sql`TRUE`;
  const r = (await sql<{ ls_down: number; sla_breached: number; pm_overdue: number; ct_expired: number }>`
    SELECT (SELECT count(*)::int FROM bme_devices b WHERE b.status = 'down' AND b.criticality = 'life_support' AND ${f}) AS ls_down,
           (SELECT count(*)::int FROM bme_repairs r JOIN bme_devices b ON b.id = r.device_id
             WHERE r.status IN ('requested', 'triaged', 'in_progress', 'waiting_parts', 'waiting_vendor') AND ${f}
               AND (${slaState('response', pct)} = 'breached' OR ${slaState('restore', pct)} = 'breached')) AS sla_breached,
           (SELECT count(DISTINCT b.id)::int FROM bme_plans p JOIN bme_devices b ON b.id = p.device_id
             WHERE p.is_active AND b.status <> 'retired' AND b.criticality IN ('life_support', 'high') AND p.next_due < (now() AT TIME ZONE ${TZ})::date AND ${f}) AS pm_overdue,
           (SELECT count(DISTINCT c.id)::int FROM bme_contracts c JOIN bme_contract_devices cd ON cd.contract_id = c.id JOIN bme_devices b ON b.id = cd.device_id
             WHERE c.status = 'active' AND c.end_date < (now() AT TIME ZONE ${TZ})::date AND b.status <> 'retired' AND ${f}) AS ct_expired`.execute(db)).rows[0];
  return r;
}
