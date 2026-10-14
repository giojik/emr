import { sql, type Transaction } from 'kysely';
import type { Database } from '../database/database.module';
import type { DB } from '../database/db';
import { n, type RptSettings, TZ } from './reporting-common';

/**
 * 0062: ოპერაციული ფაქტები — საათობრივი ნაკადი, კვლევები განზომილებებით, ექიმის ჭრილი.
 * იძახებს RptRefreshService.compute (იგივე ტრანზაქცია / lock): წყარო — READ_DB, ჩაწერა — trx.
 */
type Trx = Transaction<DB>;
export const TAT_EDGES_SQL = '{15,30,60,120,240,480,720,1440,2880,4320,10080}';

const bounds = (from: string, to: string) => ({ a: sql`(${from}::date)::timestamp AT TIME ZONE ${TZ}`, b: sql`(${to}::date + 1)::timestamp AT TIME ZONE ${TZ}` });
async function replace(trx: Trx, table: 'rpt_fact_hourly' | 'rpt_fact_dx_dim' | 'rpt_fact_doctor', from: string, to: string, rows: Record<string, unknown>[]) {
  await sql`DELETE FROM ${sql.table(table)} WHERE day BETWEEN ${from}::date AND ${to}::date`.execute(trx);
  for (let i = 0; i < rows.length; i += 1000) await trx.insertInto(table).values(rows.slice(i, i + 1000) as never).execute();
  return rows.length;
}
const hist = (h: number[]) => sql`${sql.lit(`{${h.join(',')}}`)}::int[]`;

export async function opsFacts(rdb: Database, trx: Trx, from: string, to: string, s: RptSettings) {
  return { hourly: await hourly(rdb, trx, from, to), dx_dim: await dxDim(rdb, trx, from, to, s), doctor: await doctor(rdb, trx, from, to, s) };
}

// ------------------------------------------------------------------------------------ საათობრივი ნაკადი
async function hourly(rdb: Database, trx: Trx, from: string, to: string) {
  const { a, b } = bounds(from, to);
  const loc = (col: ReturnType<typeof sql>) => sql`(${col} AT TIME ZONE ${TZ})`;
  const rows = (await sql<{ day: string; hour: number; department_id: string | null; layer: string; sub: string; n: number }>`
    SELECT to_char(${loc(sql`e.start_time`)}::date, 'YYYY-MM-DD') AS day, extract(hour FROM ${loc(sql`e.start_time`)})::int AS hour, e.department_id, 'visit' AS layer,
           CASE WHEN e.type::text = 'emergency' THEN 'emergency' WHEN e.type::text = 'inpatient' THEN 'inpatient' WHEN e.visit_kind = 'lab' THEN 'lab' ELSE 'outpatient' END AS sub,
           count(*)::int AS n
      FROM encounters e WHERE e.start_time >= ${a} AND e.start_time < ${b} AND e.status::text IN ('active', 'discharged') GROUP BY 1, 2, 3, 4, 5
    UNION ALL
    SELECT to_char(${loc(sql`st.admitted_at`)}::date, 'YYYY-MM-DD'), extract(hour FROM ${loc(sql`st.admitted_at`)})::int,
           coalesce((SELECT ba.department_id FROM bed_assignments ba WHERE ba.encounter_id = st.encounter_id ORDER BY ba.started_at, ba.id LIMIT 1), e.department_id), 'admission', '', count(*)::int
      FROM inpatient_stays st JOIN encounters e ON e.id = st.encounter_id
     WHERE st.status <> 'cancelled' AND st.admitted_at >= ${a} AND st.admitted_at < ${b} GROUP BY 1, 2, 3
    UNION ALL
    SELECT to_char(${loc(sql`sp.collected_at`)}::date, 'YYYY-MM-DD'), extract(hour FROM ${loc(sql`sp.collected_at`)})::int, e.department_id, 'lab_collect', '', count(*)::int
      FROM lab_specimens sp JOIN encounters e ON e.id = sp.encounter_id
     WHERE sp.collected_at >= ${a} AND sp.collected_at < ${b} AND sp.status <> 'rejected' GROUP BY 1, 2, 3`.execute(rdb)).rows;
  return replace(trx, 'rpt_fact_hourly', from, to, rows);
}

// ------------------------------------------------------------------------------------ კვლევები განზომილებებით
async function dxDim(rdb: Database, trx: Trx, from: string, to: string, s: RptSettings) {
  const { a, b } = bounds(from, to);
  // ლაბ.: პირველი შედეგის ანალიზატორი (აპარატის გარეშე — 'manual'); შედეგი ჯერ არ არის — ''; სხვა: აპარატი
  const dev = sql`CASE WHEN i.section = 'lab' THEN coalesce((SELECT coalesce(r.instrument_id::text, 'manual') FROM lab_results r WHERE r.order_item_id = i.id ORDER BY r.entered_at, r.id LIMIT 1), '')
                       ELSE coalesce(i.device_id::text, '') END`;
  const ord = (await sql<{ day: string; department_id: string | null; section: string; device_key: string; group_name: string; modality: string; ordered: number; cancelled: number; external: number }>`
    SELECT to_char((i.ordered_at AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS day, e.department_id, i.section, ${dev} AS device_key,
           coalesce(s.group_name, '') AS group_name, coalesce(s.modality, '') AS modality,
           count(*) FILTER (WHERE i.status <> 'cancelled')::int AS ordered, count(*) FILTER (WHERE i.status = 'cancelled')::int AS cancelled,
           count(*) FILTER (WHERE i.status <> 'cancelled' AND i.ext_lab_id IS NOT NULL)::int AS external
      FROM dx_order_items i JOIN encounters e ON e.id = i.encounter_id JOIN dx_services s ON s.id = i.service_id
     WHERE i.ordered_at >= ${a} AND i.ordered_at < ${b} GROUP BY 1, 2, 3, 4, 5, 6`.execute(rdb)).rows;
  const start = s.lab_tat_start === 'collected' ? sql`CASE WHEN i.section = 'lab' THEN coalesce(sp.collected_at, i.ordered_at) ELSE i.ordered_at END` : sql`i.ordered_at`;
  const res = (await sql<{ day: string; department_id: string | null; section: string; device_key: string; group_name: string; modality: string; bucket: number; n: number; sum_min: string }>`
    WITH x AS (SELECT to_char((i.validated_at AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS day, e.department_id, i.section, ${dev} AS device_key,
                      coalesce(s.group_name, '') AS group_name, coalesce(s.modality, '') AS modality, greatest(0, extract(epoch FROM i.validated_at - ${start}) / 60) AS m
                 FROM dx_order_items i JOIN encounters e ON e.id = i.encounter_id JOIN dx_services s ON s.id = i.service_id LEFT JOIN lab_specimens sp ON sp.id = i.specimen_id
                WHERE i.status <> 'cancelled' AND i.validated_at >= ${a} AND i.validated_at < ${b})
    SELECT day, department_id, section, device_key, group_name, modality, width_bucket(m, ${sql.lit(TAT_EDGES_SQL)}::numeric[])::int AS bucket, count(*)::int AS n, round(sum(m), 1)::text AS sum_min
      FROM x GROUP BY 1, 2, 3, 4, 5, 6, 7`.execute(rdb)).rows;
  type R = { day: string; department_id: string | null; section: string; device_key: string; group_name: string; modality: string; ordered: number; cancelled: number; external: number;
    resulted: number; tat_sum_min: number; tat_hist: number[] };
  const map = new Map<string, R>();
  const row = (x: { day: string; department_id: string | null; section: string; device_key: string; group_name: string; modality: string }) => {
    const k = [x.day, x.department_id, x.section, x.device_key, x.group_name, x.modality].join('|');
    let r = map.get(k);
    if (!r) { r = { day: x.day, department_id: x.department_id, section: x.section, device_key: x.device_key, group_name: x.group_name, modality: x.modality,
      ordered: 0, cancelled: 0, external: 0, resulted: 0, tat_sum_min: 0, tat_hist: Array(12).fill(0) }; map.set(k, r); }
    return r;
  };
  for (const x of ord) Object.assign(row(x), { ordered: x.ordered, cancelled: x.cancelled, external: x.external });
  for (const x of res) { const r = row(x); r.resulted += x.n; r.tat_sum_min = Math.round((r.tat_sum_min + n(x.sum_min)) * 10) / 10; r.tat_hist[Math.min(11, Math.max(0, x.bucket))] += x.n; }
  return replace(trx, 'rpt_fact_dx_dim', from, to, [...map.values()].map((r) => ({ ...r, tat_hist: hist(r.tat_hist) })));
}

// ------------------------------------------------------------------------------------ ექიმის ჭრილი
async function doctor(rdb: Database, trx: Trx, from: string, to: string, s: RptSettings) {
  const { a, b } = bounds(from, to);
  const orSet = await rdb.selectFrom('system_modules').select('settings').where('code', '=', 'or').executeTakeFirst();
  const tol = Number((orSet?.settings as { first_case_tolerance_min?: number } | undefined)?.first_case_tolerance_min ?? 15);
  type K = { day: string; department_id: string | null; doctor_id: string; role: 'surgeon' | 'attending' | 'validator' };
  const map = new Map<string, Record<string, unknown> & K & { dx_tat_hist: number[] }>();
  const key = (x: { day: string; department_id: string | null; doctor_id: string }, role: K['role']): K => ({ day: x.day, department_id: x.department_id, doctor_id: x.doctor_id, role });
  const row = (x: K) => {
    const k = `${x.day}|${x.department_id}|${x.doctor_id}|${x.role}`;
    let r = map.get(k);
    if (!r) { r = { ...x, or_scheduled: 0, or_done: 0, or_cancelled: 0, or_surgery_cases: 0, or_surgery_min: 0, or_first_cases: 0, or_first_on_time: 0,
      admissions: 0, discharges: 0, deaths: 0, los_days_sum: 0, readmissions_30: 0, dx_resulted: 0, dx_tat_sum_min: 0, dx_tat_hist: Array(12).fill(0) }; map.set(k, r); }
    return r;
  };
  const day = (col: ReturnType<typeof sql>) => sql<string>`to_char((${col} AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD')`;
  // ქირურგი
  const [sch, done, canc, first] = await Promise.all([
    sql<{ day: string; department_id: string; doctor_id: string; n: number }>`
      SELECT ${day(sql`c.scheduled_start`)} AS day, c.department_id, c.surgeon_id AS doctor_id, count(*)::int AS n FROM or_cases c
       WHERE c.scheduled_start >= ${a} AND c.scheduled_start < ${b} AND c.status IN ('scheduled', 'in_progress', 'completed', 'cancelled') GROUP BY 1, 2, 3`.execute(rdb),
    sql<{ day: string; department_id: string; doctor_id: string; n: number; sc: number; sm: number }>`
      WITH t AS (SELECT case_id, kind, at FROM or_case_times WHERE superseded_by IS NULL),
           c AS (SELECT oc.department_id, oc.surgeon_id, ti.at AS in_room,
                        (SELECT at FROM t WHERE t.case_id = oc.id AND t.kind = 'incision') AS inc, (SELECT at FROM t WHERE t.case_id = oc.id AND t.kind = 'closure') AS clo
                   FROM or_cases oc JOIN t ti ON ti.case_id = oc.id AND ti.kind = 'in_room' WHERE oc.status = 'completed' AND ti.at >= ${a} AND ti.at < ${b})
      SELECT ${day(sql`in_room`)} AS day, department_id, surgeon_id AS doctor_id, count(*)::int AS n,
             count(*) FILTER (WHERE inc IS NOT NULL AND clo >= inc)::int AS sc,
             coalesce(round(sum(extract(epoch FROM clo - inc) / 60) FILTER (WHERE inc IS NOT NULL AND clo >= inc)), 0)::int AS sm
        FROM c GROUP BY 1, 2, 3`.execute(rdb),
    sql<{ day: string; department_id: string; doctor_id: string; n: number }>`
      SELECT ${day(sql`c.cancelled_at`)} AS day, c.department_id, c.surgeon_id AS doctor_id, count(*)::int AS n FROM or_cases c
       WHERE c.status = 'cancelled' AND c.cancelled_at >= ${a} AND c.cancelled_at < ${b} GROUP BY 1, 2, 3`.execute(rdb),
    sql<{ day: string; department_id: string; doctor_id: string; n: number; on_time: number }>`
      WITH t AS (SELECT case_id, kind, at FROM or_case_times WHERE superseded_by IS NULL),
           y AS (SELECT oc.room_id, oc.department_id, oc.surgeon_id, oc.scheduled_start, (ti.at AT TIME ZONE ${TZ})::date AS d, extract(epoch FROM ti.at - oc.scheduled_start) / 60 AS delay
                   FROM or_cases oc JOIN t ti ON ti.case_id = oc.id AND ti.kind = 'in_room'
                  WHERE oc.status IN ('in_progress', 'completed') AND oc.urgency <> 'emergency' AND oc.scheduled_start IS NOT NULL AND oc.room_id IS NOT NULL AND ti.at >= ${a} AND ti.at < ${b}),
           c AS (SELECT DISTINCT ON (room_id, d) department_id, surgeon_id, d, delay FROM y ORDER BY room_id, d, scheduled_start)
      SELECT to_char(d, 'YYYY-MM-DD') AS day, department_id, surgeon_id AS doctor_id, count(*)::int AS n, count(*) FILTER (WHERE delay <= ${tol})::int AS on_time FROM c GROUP BY 1, 2, 3`.execute(rdb),
  ]);
  for (const x of sch.rows) row(key(x, 'surgeon')).or_scheduled = x.n;
  for (const x of done.rows) Object.assign(row(key(x, 'surgeon')), { or_done: x.n, or_surgery_cases: x.sc, or_surgery_min: x.sm });
  for (const x of canc.rows) row(key(x, 'surgeon')).or_cancelled = x.n;
  for (const x of first.rows) Object.assign(row(key(x, 'surgeon')), { or_first_cases: x.n, or_first_on_time: x.on_time });
  // მკურნალი ექიმი (შემთხვევის ახლანდელი მკურნალი)
  const [adm, dis] = await Promise.all([
    sql<{ day: string; department_id: string; doctor_id: string; n: number; re: number }>`
      SELECT ${day(sql`st.admitted_at`)} AS day,
             coalesce((SELECT ba.department_id FROM bed_assignments ba WHERE ba.encounter_id = st.encounter_id ORDER BY ba.started_at, ba.id LIMIT 1), e.department_id) AS department_id,
             e.attending_doctor_id AS doctor_id, count(*)::int AS n,
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM inpatient_stays p WHERE p.patient_id = st.patient_id AND p.encounter_id <> st.encounter_id AND p.status = 'discharged'
                                                AND p.ended_at <= st.admitted_at AND p.ended_at > st.admitted_at - interval '30 days'))::int AS re
        FROM inpatient_stays st JOIN encounters e ON e.id = st.encounter_id
       WHERE st.status <> 'cancelled' AND st.admitted_at >= ${a} AND st.admitted_at < ${b} AND e.attending_doctor_id IS NOT NULL GROUP BY 1, 2, 3`.execute(rdb),
    sql<{ day: string; department_id: string; doctor_id: string; n: number; deaths: number; los: number }>`
      SELECT ${day(sql`st.ended_at`)} AS day,
             coalesce((SELECT ba.department_id FROM bed_assignments ba WHERE ba.encounter_id = st.encounter_id ORDER BY ba.started_at DESC, ba.id DESC LIMIT 1), e.department_id) AS department_id,
             e.attending_doctor_id AS doctor_id, count(*)::int AS n, count(*) FILTER (WHERE st.death_at IS NOT NULL)::int AS deaths,
             coalesce(sum(greatest(1, (st.ended_at AT TIME ZONE ${TZ})::date - (st.admitted_at AT TIME ZONE ${TZ})::date)), 0)::int AS los
        FROM inpatient_stays st JOIN encounters e ON e.id = st.encounter_id
       WHERE st.status = 'discharged' AND st.ended_at >= ${a} AND st.ended_at < ${b} AND e.attending_doctor_id IS NOT NULL GROUP BY 1, 2, 3`.execute(rdb),
  ]);
  for (const x of adm.rows) Object.assign(row(key(x, 'attending')), { admissions: x.n, readmissions_30: x.re });
  for (const x of dis.rows) Object.assign(row(key(x, 'attending')), { discharges: x.n, deaths: x.deaths, los_days_sum: x.los });
  // ვალიდატორი / რადიოლოგი
  const start = s.lab_tat_start === 'collected' ? sql`CASE WHEN i.section = 'lab' THEN coalesce(sp.collected_at, i.ordered_at) ELSE i.ordered_at END` : sql`i.ordered_at`;
  const val = (await sql<{ day: string; department_id: string | null; doctor_id: string; bucket: number; n: number; sum_min: string }>`
    WITH x AS (SELECT to_char((i.validated_at AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS day, e.department_id, i.validated_by AS doctor_id,
                      greatest(0, extract(epoch FROM i.validated_at - ${start}) / 60) AS m
                 FROM dx_order_items i JOIN encounters e ON e.id = i.encounter_id LEFT JOIN lab_specimens sp ON sp.id = i.specimen_id
                WHERE i.status <> 'cancelled' AND i.validated_at >= ${a} AND i.validated_at < ${b} AND i.validated_by IS NOT NULL)
    SELECT day, department_id, doctor_id, width_bucket(m, ${sql.lit(TAT_EDGES_SQL)}::numeric[])::int AS bucket, count(*)::int AS n, round(sum(m), 1)::text AS sum_min
      FROM x GROUP BY 1, 2, 3, 4`.execute(rdb)).rows;
  for (const x of val) {
    const r = row({ day: x.day, department_id: x.department_id, doctor_id: x.doctor_id, role: 'validator' });
    r.dx_resulted = n(r.dx_resulted) + x.n; r.dx_tat_sum_min = Math.round((n(r.dx_tat_sum_min) + n(x.sum_min)) * 10) / 10; r.dx_tat_hist[Math.min(11, Math.max(0, x.bucket))] += x.n;
  }
  return replace(trx, 'rpt_fact_doctor', from, to, [...map.values()].map((r) => ({ ...r, dx_tat_hist: hist(r.dx_tat_hist) })));
}
