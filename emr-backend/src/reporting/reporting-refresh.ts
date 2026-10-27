import { Injectable, Logger } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { InjectDb, type Database } from '../database/database.module';
import type { DB } from '../database/db';
import { finRules } from '../finance/finance-rules';
import { revenueCte } from '../finance/finance-reports';
import { balanceSnapshot, finExtraFacts } from './reporting-refresh-fin';
import { opsFacts } from './reporting-refresh-ops';
import { qualityFacts } from './reporting-refresh-quality';
import { ipcFacts } from '../ipc/ipc-facts';
import { bmeFacts } from '../bme/bme-reports-core';
import { addDays, daysBetween, InjectReadDb, isReplica, n, r2, rptModule, type RptSettings, TZ } from './reporting-common';

/**
 * აგრეგაცია (0060): წყარო (READ_DB) → დღიური ფაქტები (rpt_fact_*) და მარაგის სურათი (rpt_stock_snapshot) მთავარ ბაზაში.
 *  • თითო ფაქტი — ერთი ან რამდენიმე დაჯგუფებული SELECT მთელ პერიოდზე; შედეგი იწერება ერთი ტრანზაქციით
 *    (DELETE პერიოდი → INSERT), pg_try_advisory_xact_lock-ით — ერთდროულად ერთი გადათვლა.
 *  • დახურული ფინანსური თვე (freeze_closed_periods) — rpt_fact_finance არ იცვლება.
 *  • მარაგის სურათი — მხოლოდ მაშინ, როცა პერიოდი დღევანდელ დღეს მოიცავს.
 *  • 0063: rpt_fact_payer / rpt_fact_doctor_rev (finance-სთან ერთად, დახურული თვე — გაყინული), დებიტორები / კრედიტორები (rpt_balance_snapshot — დღევანდელ დღეზე).
 *  • 0066: rpt_fact_quality (მთელი ისტორია) და rpt_quality_snapshot — reporting-refresh-quality.
 *  • 0072: rpt_fact_ipc; 0076: rpt_fact_bme (ბიომედ-აპარატურა, ფანჯარა).
 */
type Trx = Transaction<DB>;
const LOCK_KEY = 60_060;
/** TAT ჰისტოგრამის საზღვრები (წუთი): bucket 0 = [0, 15), …, bucket 11 = [10080, ∞) */
export const TAT_EDGES = [15, 30, 60, 120, 240, 480, 720, 1440, 2880, 4320, 10080];
const MAX_DAYS = 400;

export interface RefreshResult { run_id: number; status: 'ok' | 'error' | 'skipped'; facts?: Record<string, number>; error?: string }

@Injectable()
export class RptRefreshService {
  private readonly log = new Logger('Reporting');
  constructor(@InjectDb() private readonly db: Database, @InjectReadDb() private readonly rdb: Database) {}

  private tsBounds(from: string, to: string) {
    return { a: sql`(${from}::date)::timestamp AT TIME ZONE ${TZ}`, b: sql`(${to}::date + 1)::timestamp AT TIME ZONE ${TZ}` };
  }
  async today() { return (await sql<{ d: string }>`SELECT to_char((now() AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS d`.execute(this.db)).rows[0].d; }

  /** მიმდინარე გადათვლა (ჩაკიდებული — 2 საათზე ძველი — არ ითვლება) */
  async running() {
    return this.db.selectFrom('rpt_refresh_runs').select(['id', 'kind', 'date_from', 'date_to', 'started_at']).where('status', '=', 'running')
      .where('started_at', '>', sql<Date>`now() - interval '2 hours'`).orderBy('id', 'desc').executeTakeFirst();
  }

  /** ჟურნალში ჩანაწერი (status = running) — გადათვლა იწყება execute()-ით */
  async createRun(kind: 'today' | 'nightly' | 'manual', from: string, to: string, by: string | null) {
    if (from > to) throw new Error('from > to');
    if (daysBetween(from, to) > MAX_DAYS) throw new Error(`პერიოდი — მაქსიმუმ ${MAX_DAYS} დღე`);
    const r = await this.db.insertInto('rpt_refresh_runs').values({ kind, date_from: from, date_to: to, requested_by: by, source: isReplica() ? 'replica' : 'primary' })
      .returning('id').executeTakeFirstOrThrow();
    return Number(r.id);
  }

  async execute(runId: number): Promise<RefreshResult> {
    const run = await this.db.selectFrom('rpt_refresh_runs').selectAll().where('id', '=', String(runId)).executeTakeFirstOrThrow();
    const from = String(run.date_from).slice(0, 10); const to = String(run.date_to).slice(0, 10);
    const t0 = Date.now();
    const finish = async (status: 'ok' | 'error' | 'skipped', facts: Record<string, number> | null, error: string | null) => {
      await this.db.updateTable('rpt_refresh_runs').set({ status, facts: facts ? JSON.stringify(facts) : null, error, finished_at: sql`now()`, duration_ms: Date.now() - t0 })
        .where('id', '=', String(runId)).execute();
    };
    try {
      const { settings } = await rptModule(this.db);
      const facts = await this.db.transaction().execute(async (trx) => {
        const got = (await sql<{ ok: boolean }>`SELECT pg_try_advisory_xact_lock(${LOCK_KEY}) AS ok`.execute(trx)).rows[0].ok;
        if (!got) return null;
        return this.compute(trx, from, to, settings);
      });
      if (!facts) { await finish('skipped', null, 'სხვა გადათვლა მიმდინარეობს'); return { run_id: runId, status: 'skipped', error: 'სხვა გადათვლა მიმდინარეობს' }; }
      await finish('ok', facts, null);
      return { run_id: runId, status: 'ok', facts };
    } catch (e) {
      const msg = (e as Error).message.slice(0, 2000);
      this.log.error(`გადათვლა #${runId} (${from} — ${to}): ${msg}`);
      await finish('error', null, msg).catch(() => undefined);
      return { run_id: runId, status: 'error', error: msg };
    }
  }

  async refresh(kind: 'today' | 'nightly' | 'manual', from: string, to: string, by: string | null) {
    return this.execute(await this.createRun(kind, from, to, by));
  }

  /**
   * worker (ყოველ წუთს): ღამის გადათვლა — nightly_hour-დან, დღეში ერთხელ (გამოტოვებული — იმავე დღეს მოგვიანებით);
   * დღევანდელი (გუშინ + დღეს) — refresh_today_min-ის შემდეგ ბოლო წარმატებულიდან.
   */
  private busy = false;
  async tick() {
    if (this.busy) return null;   // ერთ პროცესში — ერთი tick ერთდროულად (DB lock — პროცესებს შორის)
    this.busy = true;
    try { return await this.tickInner(); } finally { this.busy = false; }
  }
  private async tickInner() {
    const m = await rptModule(this.db);
    if (!m.enabled) return null;
    const s = m.settings;
    const now = (await sql<{ d: string; h: number }>`SELECT to_char((now() AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS d, extract(hour FROM now() AT TIME ZONE ${TZ})::int AS h`.execute(this.db)).rows[0];
    if (await this.running()) return null;
    if (now.h >= s.nightly_hour) {
      const done = await this.db.selectFrom('rpt_refresh_runs').select('id').where('kind', '=', 'nightly').where('status', 'in', ['ok', 'running'])
        .where(sql<boolean>`(started_at AT TIME ZONE ${TZ})::date = ${now.d}::date`).executeTakeFirst();
      if (!done) return this.refresh('nightly', addDays(now.d, -s.recompute_days), now.d, null);
    }
    const last = await this.db.selectFrom('rpt_refresh_runs').select('finished_at').where('status', '=', 'ok').where('date_to', '>=', sql<string>`${now.d}::date`)
      .orderBy('finished_at', 'desc').executeTakeFirst();
    const age = last?.finished_at ? (Date.now() - new Date(last.finished_at).getTime()) / 60_000 : Infinity;
    if (age >= s.refresh_today_min) return this.refresh('today', addDays(now.d, -1), now.d, null);
    return null;
  }

  // ======================================================================================== გამოთვლა
  private async compute(trx: Trx, from: string, to: string, s: RptSettings) {
    const today = await this.today();
    const out: Record<string, number> = {};
    out.flow = await this.flow(trx, from, to);
    out.beds = await this.beds(trx, from, to);
    const or = await this.or(trx, from, to);
    out.or = or.cases; out.or_room = or.rooms;
    out.dx = await this.dx(trx, from, to, s);
    out.stock = await this.stock(trx, from, to);
    const fin = await this.finance(trx, from, to, s);
    out.finance = fin.rows; out.frozen_days = fin.frozen;
    if (fin.extra) Object.assign(out, fin.extra);                 // 0063: გადამხდელი, ექიმის შემოსავალი
    const ops = await opsFacts(this.rdb, trx, from, to, s);   // 0062
    Object.assign(out, ops);
    if (to >= today) out.stock_snapshot = await this.snapshot(trx, today, s);
    if (to >= today && (await finRules(this.rdb)).enabled) out.balance_snapshot = await balanceSnapshot(this.rdb, trx, today);   // 0063
    Object.assign(out, await qualityFacts(this.rdb, trx));   // 0066: მთელი ისტორია (მცირე მოცულობა), ყოველ გადათვლაზე
    Object.assign(out, await ipcFacts(this.rdb, trx, from, to));   // 0072: ინფექციის კონტროლი (ფანჯარა)
    Object.assign(out, await bmeFacts(this.rdb, trx, from, to));   // 0076: ბიომედ-აპარატურა (ფანჯარა)
    return out;
  }

  /** ჩაწერა ნაწილ-ნაწილ (1000 ხაზი) */
  private async put<T extends keyof DB>(trx: Trx, table: T, rows: Record<string, unknown>[]) {
    for (let i = 0; i < rows.length; i += 1000) await trx.insertInto(table).values(rows.slice(i, i + 1000) as never).execute();
    return rows.length;
  }
  private async replace<T extends 'rpt_fact_flow' | 'rpt_fact_beds' | 'rpt_fact_or' | 'rpt_fact_or_room' | 'rpt_fact_dx' | 'rpt_fact_stock'>(trx: Trx, table: T, from: string, to: string, rows: Record<string, unknown>[]) {
    await sql`DELETE FROM ${sql.table(table)} WHERE day BETWEEN ${from}::date AND ${to}::date`.execute(trx);
    return this.put(trx, table, rows);
  }

  // ---------------------------------------------------------------------------------- ნაკადი
  private async flow(trx: Trx, from: string, to: string) {
    const { a, b } = this.tsBounds(from, to);
    const rows = (await sql<{ day: string; department_id: string | null; enc_type: string; visit_kind: string; encounters: number; cancelled: number; completed: number; new_patients: number; patients: number }>`
      SELECT to_char((e.start_time AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS day, e.department_id, e.type::text AS enc_type, e.visit_kind,
             count(*) FILTER (WHERE e.status::text IN ('active', 'discharged'))::int AS encounters,
             count(*) FILTER (WHERE e.status::text = 'cancelled')::int AS cancelled,
             count(*) FILTER (WHERE e.status::text = 'discharged')::int AS completed,
             count(*) FILTER (WHERE e.status::text IN ('active', 'discharged') AND NOT EXISTS (
                 SELECT 1 FROM encounters p WHERE p.patient_id = e.patient_id AND p.status::text IN ('active', 'discharged')
                    AND (p.start_time < e.start_time OR (p.start_time = e.start_time AND p.id < e.id))))::int AS new_patients,
             count(DISTINCT e.patient_id) FILTER (WHERE e.status::text IN ('active', 'discharged'))::int AS patients
        FROM encounters e
       WHERE e.start_time >= ${a} AND e.start_time < ${b}
       GROUP BY 1, 2, 3, 4`.execute(this.rdb)).rows;
    return this.replace(trx, 'rpt_fact_flow', from, to, rows);
  }

  // ---------------------------------------------------------------------------------- საწოლები
  private async beds(trx: Trx, from: string, to: string) {
    const days = sql`SELECT g.d::date AS day, (g.d::date)::timestamp AT TIME ZONE ${TZ} AS ds, least((g.d::date + 1)::timestamp AT TIME ZONE ${TZ}, now()) AS de,
                            (g.d::date + 1)::timestamp AT TIME ZONE ${TZ} AS mid
                       FROM generate_series(${from}::date, ${to}::date, interval '1 day') g(d)`;
    const hrs = (s: ReturnType<typeof sql>, e: ReturnType<typeof sql>) => sql`greatest(0, extract(epoch FROM (least(${e}, dd.de) - greatest(${s}, dd.ds))) / 3600.0)`;
    // ხელმისაწვდომი საწოლ-საათები: bed_status_log-ის ინტერვალები (აქტიური, არა blocked), overflow-ის გარეშე
    const avail = (await sql<{ day: string; department_id: string; h: string }>`
      WITH dd AS (${days}),
           seg AS (SELECT l.bed_id, l.status, l.is_active, l.at AS s, coalesce(lead(l.at) OVER (PARTITION BY l.bed_id ORDER BY l.at, l.id), 'infinity'::timestamptz) AS e
                     FROM bed_status_log l)
      SELECT to_char(dd.day, 'YYYY-MM-DD') AS day, w.department_id, sum(${hrs(sql`seg.s`, sql`seg.e`)})::text AS h
        FROM seg JOIN beds b ON b.id = seg.bed_id AND NOT b.is_overflow JOIN wards w ON w.id = b.ward_id
        JOIN dd ON seg.s < dd.de AND seg.e > dd.ds
       WHERE seg.is_active AND seg.status <> 'blocked'
       GROUP BY 1, 2`.execute(this.rdb)).rows;
    // დაკავებული საწოლ-საათები და შუაღამის დაკავება
    const occ = (await sql<{ day: string; department_id: string; h: string; census: number }>`
      WITH dd AS (${days}),
           x AS (SELECT ba.department_id, ba.encounter_id, coalesce(ba.bed_at, ba.started_at) AS s, coalesce(ba.ended_at, 'infinity'::timestamptz) AS e
                   FROM bed_assignments ba JOIN inpatient_stays st ON st.encounter_id = ba.encounter_id
                  WHERE ba.bed_id IS NOT NULL AND st.status <> 'cancelled' AND ba.end_kind IS DISTINCT FROM 'cancel')
      SELECT to_char(dd.day, 'YYYY-MM-DD') AS day, x.department_id, sum(${hrs(sql`x.s`, sql`x.e`)})::text AS h,
             count(DISTINCT x.encounter_id) FILTER (WHERE dd.mid <= now() AND x.s < dd.mid AND x.e >= dd.mid)::int AS census
        FROM x JOIN dd ON x.s < dd.de AND x.e > dd.ds
       GROUP BY 1, 2`.execute(this.rdb)).rows;
    const { a, b } = this.tsBounds(from, to);
    // მიღება (პირველი განთავსების განყოფილება) + განმეორებითი 30 დღეში
    const adm = (await sql<{ day: string; department_id: string; n: number; re: number }>`
      SELECT to_char((st.admitted_at AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS day,
             coalesce((SELECT ba.department_id FROM bed_assignments ba WHERE ba.encounter_id = st.encounter_id ORDER BY ba.started_at, ba.id LIMIT 1), e.department_id) AS department_id,
             count(*)::int AS n,
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM inpatient_stays p WHERE p.patient_id = st.patient_id AND p.encounter_id <> st.encounter_id AND p.status = 'discharged'
                                                AND p.ended_at <= st.admitted_at AND p.ended_at > st.admitted_at - interval '30 days'))::int AS re
        FROM inpatient_stays st JOIN encounters e ON e.id = st.encounter_id
       WHERE st.status <> 'cancelled' AND st.admitted_at >= ${a} AND st.admitted_at < ${b}
       GROUP BY 1, 2`.execute(this.rdb)).rows;
    // გაწერა (ბოლო განთავსების განყოფილება), გარდაცვალება, ხანგრძლივობა
    const dis = (await sql<{ day: string; department_id: string; n: number; deaths: number; los: number }>`
      SELECT to_char((st.ended_at AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS day,
             coalesce((SELECT ba.department_id FROM bed_assignments ba WHERE ba.encounter_id = st.encounter_id ORDER BY ba.started_at DESC, ba.id DESC LIMIT 1), e.department_id) AS department_id,
             count(*)::int AS n, count(*) FILTER (WHERE st.death_at IS NOT NULL)::int AS deaths,
             coalesce(sum(greatest(1, (st.ended_at AT TIME ZONE ${TZ})::date - (st.admitted_at AT TIME ZONE ${TZ})::date)), 0)::int AS los
        FROM inpatient_stays st JOIN encounters e ON e.id = st.encounter_id
       WHERE st.status = 'discharged' AND st.ended_at >= ${a} AND st.ended_at < ${b}
       GROUP BY 1, 2`.execute(this.rdb)).rows;
    // გადაყვანა განყოფილებებს შორის
    const tr = (await sql<{ day: string; department_id: string; tin: number; tout: number }>`
      WITH x AS (SELECT ba.department_id, ba.started_at, ba.ended_at, ba.end_kind,
                        lag(ba.department_id) OVER w AS prev_dept, lag(ba.end_kind) OVER w AS prev_kind, lead(ba.department_id) OVER w AS next_dept
                   FROM bed_assignments ba JOIN inpatient_stays st ON st.encounter_id = ba.encounter_id
                  WHERE st.status <> 'cancelled' AND ba.end_kind IS DISTINCT FROM 'cancel'
                 WINDOW w AS (PARTITION BY ba.encounter_id ORDER BY ba.started_at, ba.id)),
           ev AS (SELECT (started_at AT TIME ZONE ${TZ})::date AS d, department_id, 1 AS tin, 0 AS tout FROM x
                   WHERE prev_kind = 'transfer' AND prev_dept <> department_id AND started_at >= ${a} AND started_at < ${b}
                  UNION ALL
                  SELECT (ended_at AT TIME ZONE ${TZ})::date, department_id, 0, 1 FROM x
                   WHERE end_kind = 'transfer' AND next_dept IS NOT NULL AND next_dept <> department_id AND ended_at >= ${a} AND ended_at < ${b})
      SELECT to_char(d, 'YYYY-MM-DD') AS day, department_id, sum(tin)::int AS tin, sum(tout)::int AS tout FROM ev GROUP BY 1, 2`.execute(this.rdb)).rows;

    const map = new Map<string, Record<string, unknown>>();
    const row = (day: string, dep: string) => {
      const k = `${day}|${dep}`;
      let r = map.get(k);
      if (!r) { r = { day, department_id: dep, available_hours: 0, occupied_hours: 0, midnight_census: 0, admissions: 0, discharges: 0, deaths: 0, los_days_sum: 0, transfers_in: 0, transfers_out: 0, readmissions_30: 0 }; map.set(k, r); }
      return r;
    };
    const r4 = (v: number) => Math.round(v * 10_000) / 10_000;
    for (const x of avail) row(x.day, x.department_id).available_hours = r4(n(x.h));
    for (const x of occ) { const r = row(x.day, x.department_id); r.occupied_hours = r4(n(x.h)); r.midnight_census = x.census; }
    for (const x of adm) { const r = row(x.day, x.department_id); r.admissions = x.n; r.readmissions_30 = x.re; }
    for (const x of dis) { const r = row(x.day, x.department_id); r.discharges = x.n; r.deaths = x.deaths; r.los_days_sum = x.los; }
    for (const x of tr) { const r = row(x.day, x.department_id); r.transfers_in = x.tin; r.transfers_out = x.tout; }
    return this.replace(trx, 'rpt_fact_beds', from, to, [...map.values()]);
  }

  // ---------------------------------------------------------------------------------- საოპერაციო
  private async or(trx: Trx, from: string, to: string) {
    const { a, b } = this.tsBounds(from, to);
    const orSet = await this.rdb.selectFrom('system_modules').select('settings').where('code', '=', 'or').executeTakeFirst();
    const tol = Number((orSet?.settings as { first_case_tolerance_min?: number } | undefined)?.first_case_tolerance_min ?? 15);
    const cases = (await sql<{ day: string; department_id: string; done: number; emergency: number; surgery_cases: number; surgery_min: number }>`
      WITH t AS (SELECT case_id, kind, at FROM or_case_times WHERE superseded_by IS NULL),
           c AS (SELECT oc.id, oc.department_id, oc.urgency, ti.at AS in_room,
                        (SELECT at FROM t WHERE t.case_id = oc.id AND t.kind = 'incision') AS inc, (SELECT at FROM t WHERE t.case_id = oc.id AND t.kind = 'closure') AS clo
                   FROM or_cases oc JOIN t ti ON ti.case_id = oc.id AND ti.kind = 'in_room'
                  WHERE oc.status = 'completed' AND ti.at >= ${a} AND ti.at < ${b})
      SELECT to_char((in_room AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS day, department_id, count(*)::int AS done,
             count(*) FILTER (WHERE urgency = 'emergency')::int AS emergency,
             count(*) FILTER (WHERE inc IS NOT NULL AND clo IS NOT NULL AND clo >= inc)::int AS surgery_cases,
             coalesce(round(sum(extract(epoch FROM clo - inc) / 60) FILTER (WHERE inc IS NOT NULL AND clo IS NOT NULL AND clo >= inc)), 0)::int AS surgery_min
        FROM c GROUP BY 1, 2`.execute(this.rdb)).rows;
    const canc = (await sql<{ day: string; department_id: string; n: number; same_day: number }>`
      SELECT to_char((c.cancelled_at AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS day, c.department_id, count(*)::int AS n,
             count(*) FILTER (WHERE c.scheduled_start IS NOT NULL AND (c.scheduled_start AT TIME ZONE ${TZ})::date = (c.cancelled_at AT TIME ZONE ${TZ})::date)::int AS same_day
        FROM or_cases c WHERE c.status = 'cancelled' AND c.cancelled_at >= ${a} AND c.cancelled_at < ${b} GROUP BY 1, 2`.execute(this.rdb)).rows;
    const sched = (await sql<{ day: string; department_id: string; n: number }>`
      SELECT to_char((c.scheduled_start AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS day, c.department_id, count(*)::int AS n
        FROM or_cases c WHERE c.scheduled_start >= ${a} AND c.scheduled_start < ${b} AND c.status IN ('scheduled', 'in_progress', 'completed', 'cancelled')
       GROUP BY 1, 2`.execute(this.rdb)).rows;
    // ოთახის დღის პირველი გეგმიური ოპერაცია (როგორც or/stats)
    const first = (await sql<{ day: string; department_id: string; n: number; on_time: number }>`
      WITH t AS (SELECT case_id, kind, at FROM or_case_times WHERE superseded_by IS NULL),
           y AS (SELECT oc.room_id, oc.department_id, oc.scheduled_start, (ti.at AT TIME ZONE ${TZ})::date AS d, extract(epoch FROM ti.at - oc.scheduled_start) / 60 AS delay
                   FROM or_cases oc JOIN t ti ON ti.case_id = oc.id AND ti.kind = 'in_room'
                  WHERE oc.status IN ('in_progress', 'completed') AND oc.urgency <> 'emergency' AND oc.scheduled_start IS NOT NULL AND oc.room_id IS NOT NULL
                    AND ti.at >= ${a} AND ti.at < ${b}),
           c AS (SELECT DISTINCT ON (room_id, d) department_id, d, delay FROM y ORDER BY room_id, d, scheduled_start)
      SELECT to_char(d, 'YYYY-MM-DD') AS day, department_id, count(*)::int AS n, count(*) FILTER (WHERE delay <= ${tol})::int AS on_time FROM c GROUP BY 1, 2`.execute(this.rdb)).rows;
    const map = new Map<string, Record<string, unknown>>();
    const row = (day: string, dep: string) => {
      const k = `${day}|${dep}`;
      let r = map.get(k);
      if (!r) { r = { day, department_id: dep, scheduled: 0, done: 0, emergency: 0, cancelled: 0, cancelled_same_day: 0, surgery_cases: 0, surgery_min: 0, first_cases: 0, first_on_time: 0 }; map.set(k, r); }
      return r;
    };
    for (const x of cases) Object.assign(row(x.day, x.department_id), { done: x.done, emergency: x.emergency, surgery_cases: x.surgery_cases, surgery_min: x.surgery_min });
    for (const x of canc) Object.assign(row(x.day, x.department_id), { cancelled: x.n, cancelled_same_day: x.same_day });
    for (const x of first) Object.assign(row(x.day, x.department_id), { first_cases: x.n, first_on_time: x.on_time });
    for (const x of sched) row(x.day, x.department_id).scheduled = x.n;
    const nCases = await this.replace(trx, 'rpt_fact_or', from, to, [...map.values()]);

    // ოთახები: სამუშაო წუთები (სამუშაო დღეებში) + ოთახში ყოფნა სამუშაო საათებში (დასრულებული)
    const rooms = (await sql<{ day: string; room_id: string; department_id: string; avail_min: number; used_min: number; cases: number }>`
      WITH t AS (SELECT case_id, kind, at FROM or_case_times WHERE superseded_by IS NULL),
           dd AS (SELECT g.d::date AS d FROM generate_series(${from}::date, ${to}::date, interval '1 day') g(d)),
           u AS (SELECT c.room_id, (ti.at AT TIME ZONE ${TZ})::date AS d, count(*)::int AS cases,
                        sum(greatest(0, extract(epoch FROM (least(tout.at, ((ti.at AT TIME ZONE ${TZ})::date + r.work_end) AT TIME ZONE ${TZ})
                                                             - greatest(ti.at, ((ti.at AT TIME ZONE ${TZ})::date + r.work_start) AT TIME ZONE ${TZ}))) / 60)) AS used
                   FROM or_cases c JOIN or_rooms r ON r.id = c.room_id JOIN t ti ON ti.case_id = c.id AND ti.kind = 'in_room' JOIN t tout ON tout.case_id = c.id AND tout.kind = 'out_of_room'
                  WHERE c.status = 'completed' AND ti.at >= ${a} AND ti.at < ${b} GROUP BY 1, 2)
      -- ოთახი ითვლება, თუ აქტიურია ან ოდესმე ჰქონია ოპერაცია (როგორც or/stats)
      SELECT to_char(dd.d, 'YYYY-MM-DD') AS day, r.id AS room_id, r.department_id,
             (CASE WHEN extract(isodow FROM dd.d)::int = ANY(r.work_days) THEN extract(epoch FROM (r.work_end - r.work_start)) / 60 ELSE 0 END)::int AS avail_min,
             coalesce(round(u.used), 0)::int AS used_min, coalesce(u.cases, 0)::int AS cases
        FROM or_rooms r CROSS JOIN dd LEFT JOIN u ON u.room_id = r.id AND u.d = dd.d
       WHERE (r.is_active OR EXISTS (SELECT 1 FROM or_cases c WHERE c.room_id = r.id)) AND (extract(isodow FROM dd.d)::int = ANY(r.work_days) OR u.cases > 0)`.execute(this.rdb)).rows;
    const nRooms = await this.replace(trx, 'rpt_fact_or_room', from, to, rooms);
    return { cases: nCases, rooms: nRooms };
  }

  // ---------------------------------------------------------------------------------- კვლევები / ლაბორატორია
  private async dx(trx: Trx, from: string, to: string, s: RptSettings) {
    const { a, b } = this.tsBounds(from, to);
    const ord = (await sql<{ day: string; department_id: string | null; section: string; ordered: number; cancelled: number; external: number; ext_cost: string }>`
      SELECT to_char((i.ordered_at AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS day, e.department_id, i.section,
             count(*) FILTER (WHERE i.status <> 'cancelled')::int AS ordered, count(*) FILTER (WHERE i.status = 'cancelled')::int AS cancelled,
             count(*) FILTER (WHERE i.status <> 'cancelled' AND i.ext_lab_id IS NOT NULL)::int AS external,
             coalesce(sum(i.ext_cost) FILTER (WHERE i.status <> 'cancelled'), 0)::text AS ext_cost
        FROM dx_order_items i JOIN encounters e ON e.id = i.encounter_id
       WHERE i.ordered_at >= ${a} AND i.ordered_at < ${b}
       GROUP BY 1, 2, 3`.execute(this.rdb)).rows;
    const start = s.lab_tat_start === 'collected' ? sql`CASE WHEN i.section = 'lab' THEN coalesce(sp.collected_at, i.ordered_at) ELSE i.ordered_at END` : sql`i.ordered_at`;
    const tat = (await sql<{ day: string; department_id: string | null; section: string; bucket: number; n: number; sum_min: string }>`
      WITH x AS (SELECT to_char((i.validated_at AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS day, e.department_id, i.section,
                        greatest(0, extract(epoch FROM i.validated_at - ${start}) / 60) AS m
                   FROM dx_order_items i JOIN encounters e ON e.id = i.encounter_id LEFT JOIN lab_specimens sp ON sp.id = i.specimen_id
                  WHERE i.status <> 'cancelled' AND i.validated_at >= ${a} AND i.validated_at < ${b})
      SELECT day, department_id, section, width_bucket(m, ${sql.lit(`{${TAT_EDGES.join(',')}}`)}::numeric[])::int AS bucket, count(*)::int AS n, round(sum(m), 1)::text AS sum_min
        FROM x GROUP BY 1, 2, 3, 4`.execute(this.rdb)).rows;
    const map = new Map<string, { day: string; department_id: string | null; section: string; ordered: number; cancelled: number; external: number; ext_cost: number;
      resulted: number; tat_sum_min: number; tat_hist: number[] }>();
    const row = (day: string, dep: string | null, section: string) => {
      const k = `${day}|${dep}|${section}`;
      let r = map.get(k);
      if (!r) { r = { day, department_id: dep, section, ordered: 0, cancelled: 0, external: 0, ext_cost: 0, resulted: 0, tat_sum_min: 0, tat_hist: Array(12).fill(0) }; map.set(k, r); }
      return r;
    };
    for (const x of ord) Object.assign(row(x.day, x.department_id, x.section), { ordered: x.ordered, cancelled: x.cancelled, external: x.external, ext_cost: r2(n(x.ext_cost)) });
    for (const x of tat) {
      const r = row(x.day, x.department_id, x.section);
      r.resulted += x.n; r.tat_sum_min = Math.round((r.tat_sum_min + n(x.sum_min)) * 10) / 10; r.tat_hist[Math.min(11, Math.max(0, x.bucket))] += x.n;
    }
    return this.replace(trx, 'rpt_fact_dx', from, to, [...map.values()].map((r) => ({ ...r, tat_hist: sql`${sql.lit(`{${r.tat_hist.join(',')}}`)}::int[]` })));
  }

  // ---------------------------------------------------------------------------------- მარაგი (დღიური)
  private async costExpr() {
    const m = (await this.rdb.selectFrom('stock_settings').select('costing_method').where('id', '=', 1).executeTakeFirst())?.costing_method ?? 'fifo';
    return m === 'fifo' ? sql`m.cost_lot` : sql`coalesce(m.cost_avg, m.cost_lot)`;
  }
  private async stock(trx: Trx, from: string, to: string) {
    const { a, b } = this.tsBounds(from, to);
    const cost = await this.costExpr();
    const rows = (await sql<{ day: string; location_id: string; department_id: string | null; consumption: string; loss: string; receipts: string }>`
      SELECT to_char((m.created_at AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS day, m.location_id, l.department_id,
             coalesce(-sum(m.qty * ${cost}) FILTER (WHERE m.move_type = 'consumption'), 0)::text AS consumption,
             coalesce(-sum(m.qty * ${cost}) FILTER (WHERE m.move_type IN ('writeoff', 'adjustment')), 0)::text AS loss,
             coalesce(sum(m.qty * ${cost}) FILTER (WHERE m.move_type = 'receipt'), 0)::text AS receipts
        FROM stock_moves m JOIN stock_locations l ON l.id = m.location_id
       WHERE m.created_at >= ${a} AND m.created_at < ${b} AND l.kind <> 'transit'
       GROUP BY 1, 2, 3`.execute(this.rdb)).rows;
    return this.replace(trx, 'rpt_fact_stock', from, to, rows.map((x) => ({ ...x, consumption: r2(n(x.consumption)), loss: r2(n(x.loss)), receipts: r2(n(x.receipts)) }))
      .filter((x) => x.consumption || x.loss || x.receipts));
  }

  // ---------------------------------------------------------------------------------- მარაგის სურათი
  private async snapshot(trx: Trx, today: string, s: RptSettings) {
    const w = s.stock_days_window;
    const rows = (await sql<{ location_id: string; item_id: string; department_id: string | null; qty: string; value: string; used: string; exp90: string; expired: string; last_move_at: Date | null }>`
      WITH bal AS (SELECT b.location_id, b.item_id, sum(b.qty) AS qty, sum(b.qty * lt.unit_cost) AS value,
                          sum(b.qty * lt.unit_cost) FILTER (WHERE lt.expires_on > ${today}::date AND lt.expires_on <= ${today}::date + 90) AS exp90,
                          sum(b.qty * lt.unit_cost) FILTER (WHERE lt.expires_on <= ${today}::date) AS expired
                     FROM stock_balances b JOIN stock_lots lt ON lt.id = b.lot_id WHERE b.qty <> 0 GROUP BY 1, 2),
           mv AS (SELECT m.location_id, m.item_id, max(m.created_at) AS last_move_at,
                         coalesce(-sum(m.qty) FILTER (WHERE m.qty < 0 AND m.move_type IN ('consumption', 'transfer', 'issue')
                                                     AND m.created_at >= ((${today}::date - ${w}::int + 1)::timestamp AT TIME ZONE ${TZ})), 0) AS used
                    FROM stock_moves m GROUP BY 1, 2)
      SELECT coalesce(bal.location_id, mv.location_id) AS location_id, coalesce(bal.item_id, mv.item_id) AS item_id, l.department_id,
             coalesce(bal.qty, 0)::text AS qty, round(coalesce(bal.value, 0), 2)::text AS value, coalesce(mv.used, 0)::text AS used,
             round(coalesce(bal.exp90, 0), 2)::text AS exp90, round(coalesce(bal.expired, 0), 2)::text AS expired, mv.last_move_at
        FROM bal FULL JOIN mv ON mv.location_id = bal.location_id AND mv.item_id = bal.item_id
        JOIN stock_locations l ON l.id = coalesce(bal.location_id, mv.location_id)
       WHERE l.kind <> 'transit' AND l.is_active AND (bal.qty IS NOT NULL OR mv.used > 0)`.execute(this.rdb)).rows;
    await sql`DELETE FROM rpt_stock_snapshot`.execute(trx);
    return this.put(trx, 'rpt_stock_snapshot', rows.map((x) => {
      const used = n(x.used); const avg = used / w; const qty = n(x.qty);
      return { location_id: x.location_id, item_id: x.item_id, department_id: x.department_id, qty, value: r2(n(x.value)), used_qty_window: used,
        avg_daily_use: Math.round(avg * 10_000) / 10_000, days_of_supply: avg > 0 ? Math.round((Math.max(0, qty) / avg) * 10) / 10 : null,
        expiring_value_90: r2(n(x.exp90)), expired_value: r2(n(x.expired)), last_move_at: x.last_move_at };
    }));
  }

  // ---------------------------------------------------------------------------------- ფინანსები
  private async finance(trx: Trx, from: string, to: string, s: RptSettings) {
    const rules = await finRules(this.rdb);
    if (!rules.enabled) return { rows: 0, frozen: 0, extra: null };
    const closed = s.freeze_closed_periods
      ? (await this.rdb.selectFrom('fin_periods').select('month').where('status', '=', 'closed').execute()).map((r) => String(r.month).slice(0, 7))
      : [];
    const isFrozen = (day: string) => closed.includes(day.slice(0, 7));
    const dk = rules.revenue_dept_basis === 'ordering' ? sql`rv.ord` : sql`rv.perf`;
    const rev = (await sql<{ day: string; dept: string | null; kind: string; amount: string }>`
      WITH ${revenueCte(rules.revenue_basis, from, to)}
      SELECT to_char(rv.rdate, 'YYYY-MM-DD') AS day, ${dk} AS dept, rv.kind, sum(rv.amount)::text AS amount FROM rv GROUP BY 1, 2, 3`.execute(this.rdb)).rows;
    const { a, b } = this.tsBounds(from, to);
    const cost = await this.costExpr();
    // მარაგის ხარჯი განყოფილებაზე — იგივე წესით, რაც 0053-ში (dept_consumption_basis)
    const stockCost = rules.dept_consumption_basis === 'issue'
      ? sql`CASE WHEN l.department_id IS NOT NULL AND m.move_type IN ('transfer', 'issue', 'return', 'receipt') THEN m.qty * ${cost}
                 WHEN l.department_id IS NULL AND m.move_type IN ('consumption', 'writeoff', 'adjustment') THEN -m.qty * ${cost} END`
      : sql`CASE WHEN m.move_type IN ('consumption', 'writeoff', 'adjustment') THEN -m.qty * ${cost} END`;
    const st = (await sql<{ day: string; dept: string | null; v: string }>`
      SELECT to_char((m.created_at AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS day, l.department_id AS dept, coalesce(sum(${stockCost}), 0)::text AS v
        FROM stock_moves m JOIN stock_locations l ON l.id = m.location_id
       WHERE m.created_at >= ${a} AND m.created_at < ${b} AND l.kind <> 'transit' GROUP BY 1, 2`.execute(this.rdb)).rows;
    const ex = (await sql<{ day: string; dept: string | null; v: string }>`
      SELECT to_char(x.expense_date, 'YYYY-MM-DD') AS day, x.department_id AS dept, sum(x.amount)::text AS v
        FROM expenses x WHERE NOT x.is_void AND x.expense_date BETWEEN ${from}::date AND ${to}::date GROUP BY 1, 2`.execute(this.rdb)).rows;
    const pay = (await sql<{ day: string; dept: string | null; v: string }>`
      SELECT to_char((p.paid_at AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS day, e.department_id AS dept, sum(p.amount)::text AS v
        FROM payments p JOIN invoices i ON i.id = p.invoice_id JOIN encounters e ON e.id = i.encounter_id
       WHERE p.paid_at >= ${a} AND p.paid_at < ${b} GROUP BY 1, 2`.execute(this.rdb)).rows;
    const map = new Map<string, Record<string, number | string | null>>();
    const row = (day: string, dep: string | null) => {
      const k = `${day}|${dep}`;
      let r = map.get(k);
      if (!r) { r = { day, department_id: dep, rev_patient: 0, rev_insurance: 0, rev_state: 0, rev_other: 0, rev_undetermined: 0, rev_writeoff: 0, rev_denied: 0, stock_cost: 0, expenses: 0, payments: 0 }; map.set(k, r); }
      return r;
    };
    const col: Record<string, string> = { patient: 'rev_patient', insurance: 'rev_insurance', state: 'rev_state', other: 'rev_other', undetermined: 'rev_undetermined', writeoff: 'rev_writeoff', denied: 'rev_denied' };
    for (const x of rev) { const c = col[x.kind]; if (!c) continue; const r = row(x.day, x.dept); r[c] = r2(n(r[c]) + n(x.amount)); }
    for (const x of st) row(x.day, x.dept).stock_cost = r2(n(x.v));
    for (const x of ex) row(x.day, x.dept).expenses = r2(n(x.v));
    for (const x of pay) row(x.day, x.dept).payments = r2(n(x.v));
    const rows = [...map.values()].filter((r) => !isFrozen(String(r.day)) && Object.entries(r).some(([k, v]) => k !== 'day' && k !== 'department_id' && v !== 0));
    // დახურული თვის დღეები — არ იშლება და არ იწერება
    const frozenDays = closed.length ? (await sql<{ n: number }>`SELECT count(*)::int AS n FROM generate_series(${from}::date, ${to}::date, interval '1 day') g(d)
      WHERE to_char(g.d, 'YYYY-MM') = ANY(${closed}::text[])`.execute(trx)).rows[0].n : 0;
    await sql`DELETE FROM rpt_fact_finance WHERE day BETWEEN ${from}::date AND ${to}::date AND NOT (to_char(day, 'YYYY-MM') = ANY(${closed}::text[]))`.execute(trx);
    return { rows: await this.put(trx, 'rpt_fact_finance', rows), frozen: frozenDays, extra: await finExtraFacts(this.rdb, trx, from, to, rules, closed) };
  }
}
