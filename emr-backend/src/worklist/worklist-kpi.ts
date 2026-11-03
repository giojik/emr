import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';
import { sql, type RawBuilder } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, Role } from '../auth/roles';
import { writeXlsxBook, type Cell, type SheetSpec } from '../common/xlsx';
import { InjectDb, type Database } from '../database/database.module';
import { SOURCES, TZ, WL_DEFAULTS, enabledModules, isAll, manageDepts, wlSettings, type Priority, type WlItem } from './worklist-common';
import { WorklistSources } from './worklist-sources';

/**
 * 0084 — სამუშაო სიების KPI.
 *  • აღრიცხვა (worker, kpi_interval_min): აქტიური მომხმარებლების „ჩემი დავალებების“ სისტემური ჩანაწერები (იგივე წესით, რაც თავად უჩანთ) —
 *    უნიკალური key → wl_item_log (გამოჩენა / ბოლოს ნახვა / დახურვა). დახურვა = ჩანაწერი აღარ ჩანს (სიზუსტე — ინტერვალი);
 *    წყარო / მოდული გამორთულია → close_kind = disabled (რეაგირებაში არ ითვლება); შეცდომით დაბრუნებული წყარო — ამ გაშვებაზე არ იხურება.
 *  • ხელით დავალებები — ზუსტად wl_tasks / wl_task_events-იდან; კრიტიკული პასუხი — dx_result_acks.
 *  • ანგარიში: ღია ახლა, ვადაგადაცილება (წყარო / განყოფილება, ტრენდი), რეაგირების დრო (მედიანა / p90), ხელით დავალებები, კრიტიკული; Excel.
 *    ხედვა: worklist_all / admin — მთელი კლინიკა; worklist_manage — თავისი განყოფილებები (users.department_id ∪ რეპორტინგის არე).
 *    სახელობითი ჭრილი (შემსრულებლით) — მხოლოდ ხელით დავალებებზე და მხოლოდ worklist_all / admin-ს.
 */
const PRI: Record<Priority, number> = { urgent: 3, high: 2, normal: 1 };
const DAY = /^\d{4}-\d{2}-\d{2}$/;
type Q = { from?: string; to?: string; department_id?: string; include_test?: string };

@Injectable()
export class WorklistKpiService {
  private readonly log = new Logger('WorklistKpi');
  private running = false;
  constructor(@InjectDb() private readonly db: Database, private readonly sources: WorklistSources, private readonly audit: AuditService) {}

  // ====================================================================== აღრიცხვა
  /** force — ინტერვალის შემოწმების გარეშე (admin / e2e) */
  async track(force = false): Promise<{ run_id: number; users: number; items: number; opened: number; closed: number; failed: string[] } | null> {
    const m = await wlSettings(this.db);
    if (!m.enabled || (!m.s.kpi_tracker && !force) || this.running) return null;
    const interval = m.s.kpi_interval_min ?? WL_DEFAULTS.kpi_interval_min;
    if (!force) {
      const last = await this.db.selectFrom('wl_kpi_runs').select('started_at').orderBy('id', 'desc').limit(1).executeTakeFirst();
      if (last && Date.now() - new Date(last.started_at).getTime() < (interval - 1) * 60_000) return null;
    }
    this.running = true;
    let run: { id: string | number } | null = null;
    try {
      run = await this.db.insertInto('wl_kpi_runs').values({ started_at: sql`now()` }).returning('id').executeTakeFirstOrThrow();
      const mods = await enabledModules(this.db);
      const users = (await sql<{ id: string; role: string | null; caps: string[] | null; name: string }>`
        SELECT u.id, u.role::text AS role, c.capabilities AS caps, u.last_name || ' ' || u.first_name AS name
          FROM users u JOIN user_capabilities c ON c.user_id = u.id WHERE u.is_active AND cardinality(c.capabilities) > 0`.execute(this.db)).rows;
      const merged = new Map<string, { source: string; dept: string | null; priority: Priority; created_at: string | null; due_at: string | null; overdue: boolean; owners: number }>();
      const failed = new Set<string>();
      const enabled = { modules: mods, sources: m.s.sources ?? {}, settings: m.s };
      // 4 პარალელურად
      for (let i = 0; i < users.length; i += 4) {
        await Promise.all(users.slice(i, i + 4).map(async (x) => {
          const u: AuthUser = { id: x.id, role: x.role ?? '', caps: (x.caps ?? []) as Role[], name: x.name, mustChangePassword: false };
          const items: WlItem[] = await this.sources.items(u, enabled, undefined, failed);
          for (const it of items) {
            const o = merged.get(it.key);
            if (!o) merged.set(it.key, { source: it.source, dept: it.department, priority: it.priority, created_at: it.created_at, due_at: it.due_at, overdue: it.overdue, owners: 1 });
            else { o.owners++; if (PRI[it.priority] > PRI[o.priority]) o.priority = it.priority; o.overdue ||= it.overdue; o.dept ??= it.department; }
          }
        }));
      }
      // განყოფილების სახელი → id (ჩანაწერს სახელი აქვს; ერთნაირ სახელზე — პირველი აქტიური)
      const deps = await this.db.selectFrom('departments').select(['id', 'name', 'is_active']).orderBy('is_active', 'desc').orderBy('created_at').execute();
      const depId = new Map<string, string>();
      for (const d of deps) if (!depId.has(d.name)) depId.set(d.name, d.id);
      const keys = [...merged.keys()];
      const rows = keys.map((k) => ({ k, ...merged.get(k)! }));
      let opened = 0;
      for (let i = 0; i < rows.length; i += 1000) {
        const b = rows.slice(i, i + 1000);
        const r = await sql<{ inserted: boolean }>`
          INSERT INTO wl_item_log (key, source, department_id, priority, created_at, due_at, first_seen, last_seen, overdue_seen, owners)
          SELECT x.key, x.source, x.dep, x.priority, x.created_at, x.due_at, now(), now(), x.overdue, x.owners
            FROM unnest(${b.map((x) => x.k)}::text[], ${b.map((x) => x.source)}::text[], ${b.map((x) => (x.dept ? depId.get(x.dept) ?? null : null))}::uuid[],
                        ${b.map((x) => x.priority)}::text[], ${b.map((x) => x.created_at)}::timestamptz[], ${b.map((x) => x.due_at)}::timestamptz[],
                        ${b.map((x) => x.overdue)}::boolean[], ${b.map((x) => Math.min(x.owners, 32000))}::int[])
                 AS x(key, source, dep, priority, created_at, due_at, overdue, owners)
          ON CONFLICT (key) WHERE closed_at IS NULL DO UPDATE SET last_seen = now(), due_at = excluded.due_at, priority = excluded.priority,
             overdue_seen = wl_item_log.overdue_seen OR excluded.overdue_seen, owners = greatest(wl_item_log.owners, excluded.owners),
             department_id = coalesce(excluded.department_id, wl_item_log.department_id)
          RETURNING (xmax = 0) AS inserted`.execute(this.db);
        opened += r.rows.filter((x) => x.inserted).length;
      }
      // დახურვა: აღარ ჩანს. გამორთული წყარო / მოდული → disabled; შეცდომით დაბრუნებული — არ იხურება
      const off = Object.entries(SOURCES).filter(([c, x]) => !mods.has(x.module) || (m.s.sources ?? {})[c] === false).map(([c]) => c);
      const closed = await sql<{ n: number }>`WITH c AS (
          UPDATE wl_item_log SET closed_at = now(), close_kind = CASE WHEN source = ANY (${off.length ? off : ['-']}::text[]) THEN 'disabled' ELSE 'done' END
           WHERE closed_at IS NULL AND NOT (key = ANY (${keys.length ? keys : ['-']}::text[])) AND NOT (source = ANY (${[...failed].length ? [...failed] : ['-']}::text[]))
          RETURNING 1) SELECT count(*)::int AS n FROM c`.execute(this.db);
      // ღია ახლა + დღიური პიკი
      await this.db.transaction().execute(async (trx) => {
        await sql`DELETE FROM wl_kpi_open`.execute(trx);
        await sql`INSERT INTO wl_kpi_open (source, department_id, open, overdue, urgent)
          SELECT source, department_id, count(*)::int, count(*) FILTER (WHERE due_at < now())::int, count(*) FILTER (WHERE priority = 'urgent')::int
            FROM wl_item_log WHERE closed_at IS NULL GROUP BY 1, 2`.execute(trx);
        await sql`INSERT INTO wl_snapshot_daily (day, source, department_id, open_peak, overdue_peak)
          SELECT (now() AT TIME ZONE ${TZ})::date, source, department_id, open, overdue FROM wl_kpi_open
          ON CONFLICT (day, source, coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid))
          DO UPDATE SET open_peak = greatest(wl_snapshot_daily.open_peak, excluded.open_peak), overdue_peak = greatest(wl_snapshot_daily.overdue_peak, excluded.overdue_peak)`.execute(trx);
      });
      // შენახვა: დახურული — 400 დღე; გაშვებები — 60 დღე
      await sql`DELETE FROM wl_item_log WHERE closed_at < now() - interval '400 days'`.execute(this.db);
      await sql`DELETE FROM wl_kpi_runs WHERE started_at < now() - interval '60 days'`.execute(this.db);
      const res = { run_id: Number(run.id), users: users.length, items: keys.length, opened, closed: closed.rows[0].n, failed: [...failed] };
      await this.db.updateTable('wl_kpi_runs').set({ finished_at: sql`now()`, users: res.users, items: res.items, opened, closed: res.closed, failed: res.failed }).where('id', '=', String(run.id)).execute();
      return res;
    } catch (e) {
      if (run) await this.db.updateTable('wl_kpi_runs').set({ finished_at: sql`now()`, error: (e as Error).message.slice(0, 1000) }).where('id', '=', String(run.id)).execute();
      this.log.error(`KPI აღრიცხვა: ${(e as Error).message}`);
      throw e;
    } finally { this.running = false; }
  }

  // ====================================================================== ანგარიში
  private async scope(u: AuthUser, q: Q) {
    const all = isAll(u);
    const manage = all ? null : await manageDepts(this.db, u);
    if (!all && !manage?.length) throw new ForbiddenException('ანგარიში — worklist_manage (თავისი განყოფილებები) / worklist_all');
    if (q.department_id && !/^[0-9a-f-]{36}$/i.test(q.department_id)) throw new BadRequestException('department_id');
    if (q.department_id && manage && !manage.includes(q.department_id)) throw new ForbiddenException('განყოფილება თქვენს არეში არ არის');
    const depts = q.department_id ? [q.department_id] : manage;
    const test = q.include_test === '1';
    /** განყოფილების ფილტრი (alias.department_id); სატესტო („ტესტ-E2E…“) — გამორიცხული, თუ include_test არ არის */
    const f = (col: string): RawBuilder<boolean> => {
      const c = sql.ref(col);
      const dep = depts ? sql<boolean>`${c} = ANY (${depts}::uuid[])` : sql<boolean>`TRUE`;
      const t = test ? sql<boolean>`TRUE` : sql<boolean>`(${c} IS NULL OR NOT EXISTS (SELECT 1 FROM departments td WHERE td.id = ${c} AND td.name LIKE 'ტესტ-E2E%'))`;
      return sql<boolean>`(${dep} AND ${t})`;
    };
    return { all, depts, f, named: all };
  }
  private period(q: Q) {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const to = q.to && DAY.test(q.to) ? q.to : today;
    const from = q.from && DAY.test(q.from) ? q.from : new Date(Date.parse(`${to}T12:00:00Z`) - 29 * 864e5).toISOString().slice(0, 10);
    if (from > to) throw new BadRequestException('from > to');
    if ((Date.parse(to) - Date.parse(from)) / 864e5 > 400) throw new BadRequestException('პერიოდი — მაქს. 400 დღე');
    return { from, to, a: sql`(${from}::date::timestamp AT TIME ZONE ${TZ})`, b: sql`((${to}::date + 1)::timestamp AT TIME ZONE ${TZ})` };
  }

  async summary(u: AuthUser, q: Q) {
    const sc = await this.scope(u, q);
    const p = this.period(q);
    const m = await wlSettings(this.db);
    const name = (c: string) => (c === 'task' ? 'ხელით შექმნილი დავალებები' : SOURCES[c]?.name ?? c);
    const group = (c: string) => SOURCES[c]?.group ?? '—';
    const lastRun = await this.db.selectFrom('wl_kpi_runs').selectAll().orderBy('id', 'desc').limit(1).executeTakeFirst();
    const RESP = sql`extract(epoch FROM (l.closed_at - coalesce(l.created_at, l.first_seen))) / 3600`;
    const CLOSED = sql<boolean>`l.closed_at >= ${p.a} AND l.closed_at < ${p.b} AND l.close_kind = 'done' AND ${sc.f('l.department_id')}`;
    const [openNow, openDept, bySource, byDept, trend, trendClosed, tasks, people, sched, crit] = await Promise.all([
      sql<{ source: string; open: number; overdue: number; urgent: number }>`
        SELECT source, sum(open)::int AS open, sum(overdue)::int AS overdue, sum(urgent)::int AS urgent FROM wl_kpi_open o WHERE ${sc.f('o.department_id')}
         GROUP BY 1 ORDER BY 3 DESC, 2 DESC`.execute(this.db),
      sql<{ department_id: string | null; name: string | null; open: number; overdue: number }>`
        SELECT o.department_id, d.name, sum(o.open)::int AS open, sum(o.overdue)::int AS overdue FROM wl_kpi_open o LEFT JOIN departments d ON d.id = o.department_id
         WHERE ${sc.f('o.department_id')} GROUP BY 1, 2 ORDER BY 4 DESC, 3 DESC`.execute(this.db),
      sql<{ source: string; closed: number; due: number; late: number; median_h: number | null; p90_h: number | null; overdue_seen: number }>`
        SELECT l.source, count(*)::int AS closed, count(*) FILTER (WHERE l.due_at IS NOT NULL)::int AS due, count(*) FILTER (WHERE l.closed_at > l.due_at)::int AS late,
               round((percentile_cont(0.5) WITHIN GROUP (ORDER BY ${RESP}))::numeric, 1)::float AS median_h,
               round((percentile_cont(0.9) WITHIN GROUP (ORDER BY ${RESP}))::numeric, 1)::float AS p90_h, count(*) FILTER (WHERE l.overdue_seen)::int AS overdue_seen
          FROM wl_item_log l WHERE ${CLOSED} GROUP BY 1 ORDER BY 4 DESC, 2 DESC`.execute(this.db),
      sql<{ department_id: string | null; name: string | null; closed: number; due: number; late: number; median_h: number | null }>`
        SELECT l.department_id, d.name, count(*)::int AS closed, count(*) FILTER (WHERE l.due_at IS NOT NULL)::int AS due, count(*) FILTER (WHERE l.closed_at > l.due_at)::int AS late,
               round((percentile_cont(0.5) WITHIN GROUP (ORDER BY ${RESP}))::numeric, 1)::float AS median_h
          FROM wl_item_log l LEFT JOIN departments d ON d.id = l.department_id WHERE ${CLOSED} GROUP BY 1, 2 ORDER BY 5 DESC, 3 DESC`.execute(this.db),
      sql<{ day: string; open_peak: number; overdue_peak: number }>`
        SELECT to_char(day, 'YYYY-MM-DD') AS day, sum(open_peak)::int AS open_peak, sum(overdue_peak)::int AS overdue_peak FROM wl_snapshot_daily s
         WHERE s.day BETWEEN ${p.from}::date AND ${p.to}::date AND ${sc.f('s.department_id')} GROUP BY 1 ORDER BY 1`.execute(this.db),
      sql<{ day: string; closed: number; late: number }>`
        SELECT to_char((l.closed_at AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS day, count(*)::int AS closed, count(*) FILTER (WHERE l.closed_at > l.due_at)::int AS late
          FROM wl_item_log l WHERE ${CLOSED} GROUP BY 1 ORDER BY 1`.execute(this.db),
      sql<{ department_id: string | null; name: string | null; created: number; done: number; done_due: number; on_time: number; cancelled: number; overdue_open: number; escalated: number;
        median_h: number | null; from_schedule: number }>`
        SELECT t.department_id, d.name,
               count(*) FILTER (WHERE t.created_at >= ${p.a} AND t.created_at < ${p.b})::int AS created,
               count(*) FILTER (WHERE t.status = 'done' AND t.done_at >= ${p.a} AND t.done_at < ${p.b})::int AS done,
               count(*) FILTER (WHERE t.status = 'done' AND t.done_at >= ${p.a} AND t.done_at < ${p.b} AND t.due_at IS NOT NULL)::int AS done_due,
               count(*) FILTER (WHERE t.status = 'done' AND t.done_at >= ${p.a} AND t.done_at < ${p.b} AND t.due_at IS NOT NULL AND t.done_at <= t.due_at)::int AS on_time,
               count(*) FILTER (WHERE t.status = 'cancelled' AND t.cancelled_at >= ${p.a} AND t.cancelled_at < ${p.b})::int AS cancelled,
               count(*) FILTER (WHERE t.status IN ('open', 'in_progress') AND t.due_at < now())::int AS overdue_open,
               count(*) FILTER (WHERE t.escalated_at >= ${p.a} AND t.escalated_at < ${p.b})::int AS escalated,
               round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (t.done_at - t.created_at)) / 3600)
                 FILTER (WHERE t.status = 'done' AND t.done_at >= ${p.a} AND t.done_at < ${p.b}))::numeric, 1)::float AS median_h,
               count(*) FILTER (WHERE t.schedule_id IS NOT NULL AND t.created_at >= ${p.a} AND t.created_at < ${p.b})::int AS from_schedule
          FROM wl_tasks t LEFT JOIN departments d ON d.id = t.department_id
         WHERE ${sc.f('t.department_id')} AND (t.created_at >= ${p.a} OR t.done_at >= ${p.a} OR t.cancelled_at >= ${p.a} OR t.status IN ('open', 'in_progress'))
         GROUP BY 1, 2 ORDER BY 3 DESC`.execute(this.db),
      sc.named ? sql<{ user_id: string; name: string; done: number; done_due: number; on_time: number; median_h: number | null }>`
        SELECT t.done_by AS user_id, u.last_name || ' ' || u.first_name AS name, count(*)::int AS done, count(*) FILTER (WHERE t.due_at IS NOT NULL)::int AS done_due,
               count(*) FILTER (WHERE t.due_at IS NOT NULL AND t.done_at <= t.due_at)::int AS on_time,
               round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (t.done_at - t.created_at)) / 3600))::numeric, 1)::float AS median_h
          FROM wl_tasks t JOIN users u ON u.id = t.done_by
         WHERE t.status = 'done' AND t.done_at >= ${p.a} AND t.done_at < ${p.b} AND ${sc.f('t.department_id')} AND (${q.include_test === '1'} OR u.email NOT LIKE '%@test.local')
         GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 200`.execute(this.db) : Promise.resolve({ rows: [] }),
      sql<{ active: number; skipped: number }>`
        SELECT (SELECT count(*)::int FROM wl_task_schedules s WHERE s.is_active AND ${sc.f('s.department_id')}) AS active,
               (SELECT count(*)::int FROM wl_schedule_runs r JOIN wl_task_schedules s ON s.id = r.schedule_id WHERE r.result = 'skipped'
                  AND r.created_at >= ${p.a} AND r.created_at < ${p.b} AND ${sc.f('s.department_id')}) AS skipped`.execute(this.db),
      this.critical(sc.f, p, m.s.critical_ack_min ?? WL_DEFAULTS.critical_ack_min),
    ]);
    const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
    // ტრენდი: დღეები პერიოდში
    const days: string[] = [];
    for (let d = p.from; d <= p.to; d = new Date(Date.parse(`${d}T12:00:00Z`) + 864e5).toISOString().slice(0, 10)) days.push(d);
    const tc = new Map(trendClosed.rows.map((r) => [r.day, r])); const ts = new Map(trend.rows.map((r) => [r.day, r]));
    const tot = bySource.rows.reduce((a, r) => ({ closed: a.closed + r.closed, due: a.due + r.due, late: a.late + r.late }), { closed: 0, due: 0, late: 0 });
    const tk = tasks.rows.reduce((a, r) => ({ done_due: a.done_due + r.done_due, on_time: a.on_time + r.on_time, created: a.created + r.created, done: a.done + r.done }), { done_due: 0, on_time: 0, created: 0, done: 0 });
    const median = (await sql<{ h: number | null }>`SELECT round((percentile_cont(0.5) WITHIN GROUP (ORDER BY ${RESP}))::numeric, 1)::float AS h FROM wl_item_log l WHERE ${CLOSED}`.execute(this.db)).rows[0]?.h ?? null;
    return {
      from: p.from, to: p.to, scope: { all: sc.all, departments: sc.depts, named: sc.named },
      tracker: { enabled: m.s.kpi_tracker !== false, interval_min: m.s.kpi_interval_min ?? WL_DEFAULTS.kpi_interval_min,
        last_run: lastRun ? { started_at: lastRun.started_at, finished_at: lastRun.finished_at, users: lastRun.users, items: lastRun.items, failed: lastRun.failed, error: lastRun.error } : null },
      kpi: { closed: tot.closed, late_pct: pct(tot.late, tot.due), response_median_h: median, tasks_on_time_pct: pct(tk.on_time, tk.done_due), tasks_created: tk.created, tasks_done: tk.done,
        crit_ack_median_min: crit.median_min, open_now: openNow.rows.reduce((a, r) => a + r.open, 0), overdue_now: openNow.rows.reduce((a, r) => a + r.overdue, 0) },
      open_now: openNow.rows.map((r) => ({ ...r, name: name(r.source), group: group(r.source) })),
      open_by_department: openDept.rows,
      by_source: bySource.rows.map((r) => ({ ...r, name: name(r.source), group: group(r.source), late_pct: pct(r.late, r.due) })),
      by_department: byDept.rows.map((r) => ({ ...r, late_pct: pct(r.late, r.due) })),
      trend: days.map((d) => ({ day: d, closed: tc.get(d)?.closed ?? 0, late: tc.get(d)?.late ?? 0, open_peak: ts.get(d)?.open_peak ?? null, overdue_peak: ts.get(d)?.overdue_peak ?? null })),
      tasks: { by_department: tasks.rows.map((r) => ({ ...r, on_time_pct: pct(r.on_time, r.done_due) })), by_assignee: people.rows.map((r) => ({ ...r, on_time_pct: pct(r.on_time, r.done_due) })),
        schedules: sched.rows[0] },
      critical: crit,
    };
  }

  /** კრიტიკული პასუხები (ვალიდაცია პერიოდში): დადასტურების დრო, დაუდასტურებელი */
  private async critical(f: (c: string) => RawBuilder<boolean>, p: { a: unknown; b: unknown }, mins: number) {
    const r = (await sql<{ n: number; acked: number; median_min: number | null; p90_min: number | null; late: number; open: number }>`
      WITH c AS (
        SELECT i.id, i.validated_at, (SELECT min(a.acked_at) FROM dx_result_acks a WHERE a.order_item_id = i.id AND a.kind = 'critical' AND a.acked_at >= i.validated_at) AS acked_at
          FROM dx_order_items i JOIN encounters e ON e.id = i.encounter_id
         WHERE i.status = 'validated' AND i.validated_at >= ${p.a} AND i.validated_at < ${p.b} AND e.visit_kind <> 'lab' AND ${f('e.department_id')}
           AND ((i.section = 'lab' AND EXISTS (SELECT 1 FROM lab_results r WHERE r.order_item_id = i.id AND r.flag IN ('HH', 'LL')))
             OR (i.section <> 'lab' AND EXISTS (SELECT 1 FROM dx_reports rr WHERE rr.order_item_id = i.id AND rr.is_critical AND rr.status = 'signed'))))
      SELECT count(*)::int AS n, count(acked_at)::int AS acked,
             round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (acked_at - validated_at)) / 60) FILTER (WHERE acked_at IS NOT NULL))::numeric, 0)::float AS median_min,
             round((percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM (acked_at - validated_at)) / 60) FILTER (WHERE acked_at IS NOT NULL))::numeric, 0)::float AS p90_min,
             count(*) FILTER (WHERE acked_at > validated_at + make_interval(mins => ${mins}::int) OR (acked_at IS NULL AND now() > validated_at + make_interval(mins => ${mins}::int)))::int AS late,
             count(*) FILTER (WHERE acked_at IS NULL)::int AS open
        FROM c`.execute(this.db)).rows[0];
    return { ...r, ack_min: mins };
  }

  async export(u: AuthUser, q: Q, req: Request) {
    const d = await this.summary(u, q);
    const clinic = (await this.db.selectFrom('clinic_settings').select('name').where('id', '=', 1).executeTakeFirst())?.name ?? '';
    await this.audit.log(auditCtx(req), { action: 'WL_REPORT_EXPORT', entityName: 'wl_reports', entityId: 'summary', newData: { from: d.from, to: d.to, department_id: q.department_id ?? null } });
    const n = (v: unknown, fmt = '0.#'): Cell => (v === null || v === undefined ? null : { v: Number(v), fmt });
    const head: Cell[][] = [[clinic], [`სამუშაო სიები — ანგარიში · ${d.from} — ${d.to}`], []];
    const sheets: SheetSpec[] = [
      { name: 'KPI', rows: [...head, ['ღია ახლა', n(d.kpi.open_now, '0')], ['მათ შორის ვადაგადაცილებული', n(d.kpi.overdue_now, '0')], ['დაიხურა (სისტემური)', n(d.kpi.closed, '0')],
        ['ვადის შემდეგ დაიხურა, %', n(d.kpi.late_pct)], ['რეაგირების დრო (მედიანა), სთ', n(d.kpi.response_median_h)], ['ხელით დავალება — შექმნილი', n(d.kpi.tasks_created, '0')],
        ['ხელით დავალება — შესრულებული', n(d.kpi.tasks_done, '0')], ['ხელით დავალება ვადაში, %', n(d.kpi.tasks_on_time_pct)],
        ['კრიტიკული პასუხი — დადასტურება (მედიანა), წთ', n(d.kpi.crit_ack_median_min, '0')]], widths: [48, 14] },
      { name: 'ღია ახლა', header: ['ჯგუფი', 'წყარო', 'ღია', 'ვადაგადაცილებული', 'სასწრაფო'], rows: d.open_now.map((r) => [r.group, r.name, n(r.open, '0'), n(r.overdue, '0'), n(r.urgent, '0')]), widths: [26, 54, 8, 16, 10] },
      { name: 'წყაროთი', header: ['ჯგუფი', 'წყარო', 'დაიხურა', 'ვადით', 'ვადის შემდეგ', '%', 'მედიანა, სთ', 'p90, სთ'],
        rows: d.by_source.map((r) => [r.group, r.name, n(r.closed, '0'), n(r.due, '0'), n(r.late, '0'), n(r.late_pct), n(r.median_h), n(r.p90_h)]), widths: [26, 54, 10, 8, 12, 8, 12, 10] },
      { name: 'განყოფილებით', header: ['განყოფილება', 'დაიხურა', 'ვადით', 'ვადის შემდეგ', '%', 'მედიანა, სთ'],
        rows: d.by_department.map((r) => [r.name ?? '— (განყოფილების გარეშე)', n(r.closed, '0'), n(r.due, '0'), n(r.late, '0'), n(r.late_pct), n(r.median_h)]), widths: [36, 10, 8, 12, 8, 12] },
      { name: 'ტრენდი', header: ['დღე', 'დაიხურა', 'ვადის შემდეგ', 'ღია (პიკი)', 'ვადაგადაცილებული (პიკი)'],
        rows: d.trend.map((r) => [r.day, n(r.closed, '0'), n(r.late, '0'), n(r.open_peak, '0'), n(r.overdue_peak, '0')]), widths: [12, 10, 12, 12, 20] },
      { name: 'ხელით დავალებები', header: ['განყოფილება', 'შექმნილი', 'მ.შ. გრაფიკით', 'შესრულებული', 'ვადით', 'ვადაში', '%', 'გაუქმებული', 'ვადაგადაცილ. ღია', 'ესკალაცია', 'მედიანა, სთ'],
        rows: d.tasks.by_department.map((r) => [r.name ?? '—', n(r.created, '0'), n(r.from_schedule, '0'), n(r.done, '0'), n(r.done_due, '0'), n(r.on_time, '0'), n(r.on_time_pct),
          n(r.cancelled, '0'), n(r.overdue_open, '0'), n(r.escalated, '0'), n(r.median_h)]), widths: [32, 10, 12, 12, 8, 8, 8, 12, 14, 10, 12] },
    ];
    if (d.scope.named) sheets.push({ name: 'შემსრულებლით', header: ['თანამშრომელი', 'შესრულებული', 'ვადით', 'ვადაში', '%', 'მედიანა, სთ'],
      rows: d.tasks.by_assignee.map((r) => [r.name, n(r.done, '0'), n(r.done_due, '0'), n(r.on_time, '0'), n(r.on_time_pct), n(r.median_h)]), widths: [32, 12, 8, 8, 8, 12] });
    sheets.push({ name: 'კრიტიკული', rows: [...head, ['კრიტიკული პასუხი (ვალიდაცია პერიოდში)', n(d.critical.n, '0')], ['დადასტურებული', n(d.critical.acked, '0')],
      ['დაუდასტურებელი', n(d.critical.open, '0')], [`ზღვარზე (${d.critical.ack_min} წთ) გვიან / დაუდასტურებელი`, n(d.critical.late, '0')],
      ['მედიანა, წთ', n(d.critical.median_min, '0')], ['p90, წთ', n(d.critical.p90_min, '0')]], widths: [48, 14] });
    return { name: `worklist_report_${d.from}_${d.to}.xlsx`, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: writeXlsxBook(sheets) };
  }
}

