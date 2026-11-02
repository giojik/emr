import { sql, type Transaction } from 'kysely';
import type { Database } from '../database/database.module';
import type { DB } from '../database/db';
import { TZ } from './worklist-common';

/**
 * 0084 — მენეჯერული დაფა: rpt_fact_worklist (დღე × განყოფილება) + KPI ჯგუფი worklist (ფორმულა — აქ, იგივე, რაც სამუშაო სიების ანგარიშში).
 *  • სისტემური ჩანაწერი (wl_item_log, close_kind = done) — დახურვის დღით; რეაგირება = დახურვა − შექმნა (წყაროს დრო; არ არის — პირველი გამოჩენა).
 *  • ხელით დავალება (wl_tasks, ვადით) — შესრულების დღით; კრიტიკული პასუხი — პირველი critical დადასტურების დღით (dx_result_acks).
 */
export const WL_TAT_EDGES = [15, 30, 60, 120, 240, 480, 720, 1440, 2880, 4320, 10080];   // = reporting-refresh.TAT_EDGES (წუთი)
export const WL_KPI_CODES = ['wl_late_pct', 'wl_response_median_h', 'wl_tasks_ontime_pct', 'wl_crit_ack_median_min'];
const EDGES = sql.lit(`{${WL_TAT_EDGES.join(',')}}`);

export async function worklistFacts(rdb: Database, trx: Transaction<DB>, from: string, to: string): Promise<Record<string, number>> {
  const a = sql`(${from}::date::timestamp AT TIME ZONE ${TZ})`; const b = sql`((${to}::date + 1)::timestamp AT TIME ZONE ${TZ})`;
  type R = { day: string; dep: string | null; kind: string; bucket: number; n: number; due: number; late: number };
  const rows = (await sql<R>`
    SELECT to_char((l.closed_at AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS day, l.department_id AS dep, 'item' AS kind,
           width_bucket(extract(epoch FROM (l.closed_at - coalesce(l.created_at, l.first_seen))) / 60, ${EDGES}::numeric[])::int AS bucket,
           count(*)::int AS n, count(*) FILTER (WHERE l.due_at IS NOT NULL)::int AS due, count(*) FILTER (WHERE l.closed_at > l.due_at)::int AS late
      FROM wl_item_log l WHERE l.close_kind = 'done' AND l.closed_at >= ${a} AND l.closed_at < ${b} GROUP BY 1, 2, 4
    UNION ALL
    SELECT to_char((t.done_at AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD'), t.department_id, 'task', 0, count(*)::int, count(*)::int, count(*) FILTER (WHERE t.done_at > t.due_at)::int
      FROM wl_tasks t WHERE t.status = 'done' AND t.due_at IS NOT NULL AND t.done_at >= ${a} AND t.done_at < ${b} GROUP BY 1, 2
    UNION ALL
    SELECT to_char((c.acked_at AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD'), c.dep, 'crit', width_bucket(extract(epoch FROM (c.acked_at - c.validated_at)) / 60, ${EDGES}::numeric[])::int,
           count(*)::int, 0, 0
      FROM (SELECT i.validated_at, e.department_id AS dep,
                   (SELECT min(k.acked_at) FROM dx_result_acks k WHERE k.order_item_id = i.id AND k.kind = 'critical' AND k.acked_at >= i.validated_at) AS acked_at
              FROM dx_order_items i JOIN encounters e ON e.id = i.encounter_id
             WHERE i.status = 'validated' AND EXISTS (SELECT 1 FROM dx_result_acks k WHERE k.order_item_id = i.id AND k.kind = 'critical' AND k.acked_at >= ${a} AND k.acked_at < ${b})) c
     WHERE c.acked_at >= ${a} AND c.acked_at < ${b} GROUP BY 1, 2, 4`.execute(rdb)).rows;
  const map = new Map<string, { day: string; department_id: string | null; closed: number; closed_due: number; closed_late: number; resp_n: number; resp_hist: number[];
    tasks_done: number; tasks_on_time: number; crit_n: number; crit_hist: number[] }>();
  for (const r of rows) {
    const k = `${r.day}|${r.dep ?? ''}`;
    const x = map.get(k) ?? { day: r.day, department_id: r.dep, closed: 0, closed_due: 0, closed_late: 0, resp_n: 0, resp_hist: Array(12).fill(0), tasks_done: 0, tasks_on_time: 0, crit_n: 0, crit_hist: Array(12).fill(0) };
    const bi = Math.min(11, Math.max(0, r.bucket));
    if (r.kind === 'item') { x.closed += r.n; x.closed_due += r.due; x.closed_late += r.late; x.resp_n += r.n; x.resp_hist[bi] += r.n; }
    else if (r.kind === 'task') { x.tasks_done += r.n; x.tasks_on_time += r.n - r.late; }
    else { x.crit_n += r.n; x.crit_hist[bi] += r.n; }
    map.set(k, x);
  }
  await sql`DELETE FROM rpt_fact_worklist WHERE day BETWEEN ${from}::date AND ${to}::date`.execute(trx);
  const vals = [...map.values()];
  for (let i = 0; i < vals.length; i += 1000) await trx.insertInto('rpt_fact_worklist').values(vals.slice(i, i + 1000)).execute();
  return { worklist: vals.length };
}

/** პროცენტილი ჰისტოგრამიდან (წუთი) — reporting-kpi.histPercentile-ის იგივე წესი */
function pctl(hist: number[], p: number): number | null {
  const total = hist.reduce((x, y) => x + y, 0);
  if (!total) return null;
  const target = total * p; const lo = [0, ...WL_TAT_EDGES];
  let acc = 0;
  for (let i = 0; i < hist.length; i++) {
    if (acc + hist[i] >= target && hist[i] > 0) {
      if (i === hist.length - 1) return lo[i];
      return Math.round((lo[i] + ((target - acc) / hist[i]) * (WL_TAT_EDGES[i] - lo[i])) * 10) / 10;
    }
    acc += hist[i];
  }
  return lo[lo.length - 1];
}

/** KPI ჯამებიდან: t.wl_* (reporting-kpi.totals) */
export function worklistKpi(code: string, t: Record<string, number>): number | null {
  const hist = (p: string) => Array.from({ length: 12 }, (_, i) => t[`${p}${i + 1}`] ?? 0);
  switch (code) {
    case 'wl_late_pct': return (t.wl_closed_due ?? 0) > 0 ? Math.round(((t.wl_closed_late ?? 0) / t.wl_closed_due) * 1000) / 10 : null;
    case 'wl_response_median_h': { const m = pctl(hist('wl_rh'), 0.5); return m === null ? null : Math.round((m / 60) * 10) / 10; }
    case 'wl_tasks_ontime_pct': return (t.wl_tasks_done ?? 0) > 0 ? Math.round(((t.wl_tasks_on_time ?? 0) / t.wl_tasks_done) * 1000) / 10 : null;
    case 'wl_crit_ack_median_min': { const m = pctl(hist('wl_ch'), 0.5); return m === null ? null : Math.round(m); }
    default: return null;
  }
}
