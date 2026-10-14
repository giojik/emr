import { BadRequestException, Body, Controller, Get, Injectable, NotFoundException, Param, Put, Query, Req } from '@nestjs/common';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsString, Length, Matches } from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/roles';
import { n, r2, RPT_CONFIG, RPT_READ, RptCommon, type RptScope, TZ, UUID_RE } from './reporting-common';
import { RptKpiService, type Totals } from './reporting-kpi';
import { ReportingService } from './reporting';

/**
 * თემატური დაფები (0061): ხელმძღვანელობა / განყოფილება.
 *  • headline — დაფის ძირითადი KPI-ები (rpt_dashboard_kpis) + 13-თვიანი sparkline (aggregation-იდან);
 *  • trend — KPI 13 (≤ 24) თვე + შარშანდელი იმავე თვე;
 *  • live — „ახლა“: მსუბუქი დათვლები ოპერაციულ ბაზაზე, 60 წმ ქეში ხედვის არის მიხედვით;
 *  • attention — წითელი KPI-ები, დაბალი / ვადაგასასვლელი / მოძრაობის გარეშე მარაგი, ვადაგადაცილებული კვლევები.
 */
type Q = Record<string, string | undefined>;
const DASHBOARDS = ['executive', 'department'] as const;
type Dash = (typeof DASHBOARDS)[number];
const LIVE_TTL_MS = 60_000;

class DashboardDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(8) @Matches(/^[a-z][a-z0-9_]{1,39}$/, { each: true }) kpi_codes: string[];
  @IsString() @Length(3, 500) reason: string;
}

export interface LiveDept {
  department_id: string; department_name: string;
  beds: number; occupied: number; free: number; reserved: number; cleaning: number; blocked: number; overflow_occupied: number; no_bed: number;
  admissions_today: number; discharges_today: number; encounters_today: number;
  or_planned: number; or_in_progress: number; or_completed: number; or_cancelled: number;
  lab_overdue: number; ext_overdue: number; dx_overdue: number;
}
const LIVE_KEYS: (keyof LiveDept)[] = ['beds', 'occupied', 'free', 'reserved', 'cleaning', 'blocked', 'overflow_occupied', 'no_bed', 'admissions_today', 'discharges_today',
  'encounters_today', 'or_planned', 'or_in_progress', 'or_completed', 'or_cancelled', 'lab_overdue', 'ext_overdue', 'dx_overdue'];

@Injectable()
export class ReportingDashService {
  private readonly cache = new Map<string, { at: number; data: unknown }>();
  constructor(private readonly c: RptCommon, private readonly k: RptKpiService, private readonly r: ReportingService, private readonly audit: AuditService) {}

  private dash(key: string): Dash {
    if (!(DASHBOARDS as readonly string[]).includes(key)) throw new NotFoundException('დაფა: executive / department');
    return key as Dash;
  }

  // ------------------------------------------------------------------------------------ კონფიგურაცია
  async dashboards() {
    const rows = await this.c.db.selectFrom('rpt_dashboard_kpis as d').innerJoin('rpt_kpis as k', 'k.code', 'd.kpi_code')
      .select(['d.dashboard', 'd.kpi_code', 'd.sort_order', 'k.name', 'k.finance', 'k.is_active']).orderBy('d.dashboard').orderBy('d.sort_order').execute();
    return Object.fromEntries(DASHBOARDS.map((d) => [d, rows.filter((r) => r.dashboard === d).map((r) => ({ code: r.kpi_code, name: r.name, finance: r.finance, is_active: r.is_active }))]));
  }

  async putDashboard(key: string, d: DashboardDto, u: AuthUser, req: Request) {
    const dash = this.dash(key);
    if (new Set(d.kpi_codes).size !== d.kpi_codes.length) throw new BadRequestException('KPI ერთხელ უნდა შედიოდეს');
    const found = await this.c.db.selectFrom('rpt_kpis').select('code').where('code', 'in', d.kpi_codes).execute();
    const missing = d.kpi_codes.filter((x) => !found.some((f) => f.code === x));
    if (missing.length) throw new BadRequestException(`უცნობი KPI: ${missing.join(', ')}`);
    const old = (await this.c.db.selectFrom('rpt_dashboard_kpis').select('kpi_code').where('dashboard', '=', dash).orderBy('sort_order').execute()).map((x) => x.kpi_code);
    await this.c.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('rpt_dashboard_kpis').where('dashboard', '=', dash).execute();
      await trx.insertInto('rpt_dashboard_kpis').values(d.kpi_codes.map((code, i) => ({ dashboard: dash, kpi_code: code, sort_order: i + 1, updated_by: u.id }))).execute();
      await this.audit.log(auditCtx(req), { action: 'RPT_DASHBOARD_UPDATE', entityName: 'rpt_dashboard_kpis', entityId: dash, oldData: { kpi_codes: old }, newData: { kpi_codes: d.kpi_codes, reason: d.reason } }, trx);
    });
    return (await this.dashboards())[dash];
  }

  // ------------------------------------------------------------------------------------ თვეები
  /** ბოლო N თვე (მიმდინარე — დღემდე), ძველიდან ახლისკენ */
  private months(today: string, count: number) {
    const out: { label: string; from: string; to: string }[] = [];
    const [y, m] = today.split('-').map(Number);
    for (let i = count - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(y, m - 1 - i, 1));
      const from = d.toISOString().slice(0, 10);
      const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
      out.push({ label: from.slice(0, 7), from, to: end > today ? today : end });
    }
    return out;
  }
  /** ადრეული თარიღი, რომლიდანაც აგრეგაცია არსებობს (წარმატებული გადათვლებით); მანამდე — მონაცემი არ არის (null, არა 0) */
  private async dataFrom() {
    const r = await this.c.rdb.selectFrom('rpt_refresh_runs').select(sql<string | null>`to_char(min(date_from), 'YYYY-MM-DD')`.as('d')).where('status', '=', 'ok').executeTakeFirst();
    return r?.d ?? null;
  }
  private async monthTotals(scope: RptScope, list: { from: string; to: string }[]) {
    const res: Totals[] = [];
    for (const x of list) res.push(await this.k.totals(scope, x.from, x.to));
    return res;
  }

  // ------------------------------------------------------------------------------------ ძირითადი KPI-ები
  async headline(u: AuthUser, q: Q) {
    const s = await this.c.settings();
    const dash = this.dash(q.dashboard ?? '');
    const scope = this.c.narrow(await this.c.scope(u), q.department_id);
    const codes = (await this.c.db.selectFrom('rpt_dashboard_kpis').select('kpi_code').where('dashboard', '=', dash).orderBy('sort_order').execute()).map((x) => x.kpi_code);
    const ov = await this.r.overview(u, q);
    const kpis = codes.map((c) => ov.kpis.find((x) => x.code === c)).filter((x): x is NonNullable<typeof x> => !!x);   // დამალული / ფინანსური (უფლების გარეშე) — გამოტოვდება
    const today = await this.c.today();
    const months = this.months(today, 13);
    const [tot, df] = await Promise.all([this.monthTotals(scope, months), this.dataFrom()]);
    const has = months.map((m) => !!df && m.to >= df);
    return { ...ov, dashboard: dash, months: months.map((m) => m.label), data_from: df,
      kpis: kpis.map((x) => ({ ...x, spark: x.snapshot ? null : tot.map((t, i) => (has[i] ? this.k.value(x.code, t, null, s) : null)) })) };
  }

  // ------------------------------------------------------------------------------------ ტრენდი
  async trend(u: AuthUser, q: Q) {
    const s = await this.c.settings();
    const scope = this.c.narrow(await this.c.scope(u), q.department_id);
    const count = Math.min(24, Math.max(2, Number(q.months) || 13));
    const k = (await this.k.kpis(scope, false)).find((x) => x.code === q.kpi);
    if (!k) throw new NotFoundException('KPI ვერ მოიძებნა ან თქვენთვის არ ჩანს');
    if (k.snapshot) throw new BadRequestException('მომენტალურ მაჩვენებელს ტრენდი არ აქვს');
    const today = await this.c.today();
    const months = this.months(today, count);
    const prevYear = months.map((m) => ({ from: `${Number(m.from.slice(0, 4)) - 1}${m.from.slice(4)}`, to: (() => {
      const [yy, mm, dd] = m.to.split('-').map(Number); const x = new Date(Date.UTC(yy - 1, mm - 1, dd)); if (x.getUTCMonth() !== mm - 1) x.setUTCDate(0); return x.toISOString().slice(0, 10); })() }));
    const [cur, prev, df] = await Promise.all([this.monthTotals(scope, months), this.monthTotals(scope, prevYear), this.dataFrom()]);
    const ok = (to: string) => !!df && to >= df;
    return { kpi: k.code, name: k.name, unit: k.unit, direction: k.direction, months: count, data_from: df,
      points: months.map((m, i) => ({ month: m.label, from: m.from, to: m.to, partial: m.to === today,
        value: ok(m.to) ? this.k.value(k.code, cur[i], null, s) : null, prev_year: ok(prevYear[i].to) ? this.k.value(k.code, prev[i], null, s) : null })) };
  }

  // ------------------------------------------------------------------------------------ ახლა
  async live(u: AuthUser, q: Q) {
    const s = await this.c.settings();
    const scope = this.c.narrow(await this.c.scope(u), q.department_id);
    const key = scope.all ? 'all' : [...scope.depts].sort().join(',');
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < LIVE_TTL_MS) return { ...(hit.data as object), cached: true };
    const data = await this.liveCompute(scope, s.lab_overdue_min, s.dx_overdue_hours);
    this.cache.set(key, { at: Date.now(), data });
    if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value!);
    return { ...data, cached: false };
  }

  private async liveCompute(scope: RptScope, labMin: number, dxHours: number) {
    const db = this.c.db;   // ცოცხალი — მთავარი ბაზა (რეპლიკა შეიძლება ჩამორჩეს)
    const f = (col: string) => (scope.all ? sql`TRUE` : sql`${sql.ref(col)} = ANY(${scope.depts}::uuid[])`);
    const t0 = sql`((now() AT TIME ZONE ${TZ})::date)::timestamp AT TIME ZONE ${TZ}`;
    const t1 = sql`((now() AT TIME ZONE ${TZ})::date + 1)::timestamp AT TIME ZONE ${TZ}`;
    const rows = new Map<string, LiveDept>();
    const row = (id: string, name: string) => {
      let r = rows.get(id);
      if (!r) { r = { department_id: id, department_name: name, ...Object.fromEntries(LIVE_KEYS.map((k) => [k, 0])) } as LiveDept; rows.set(id, r); }
      return r;
    };
    const [beds, noBed, adm, dis, enc, or, lab, dx] = await Promise.all([
      sql<{ id: string; name: string; beds: number; occupied: number; free: number; reserved: number; cleaning: number; blocked: number; overflow_occupied: number }>`
        SELECT w.department_id AS id, d.name,
               count(*) FILTER (WHERE b.is_active AND NOT b.is_overflow)::int AS beds,
               count(*) FILTER (WHERE b.status = 'occupied' AND NOT b.is_overflow)::int AS occupied,
               count(*) FILTER (WHERE b.status = 'free' AND b.is_active AND NOT b.is_overflow)::int AS free,
               count(*) FILTER (WHERE b.status = 'reserved' AND NOT b.is_overflow)::int AS reserved,
               count(*) FILTER (WHERE b.status = 'cleaning' AND NOT b.is_overflow)::int AS cleaning,
               count(*) FILTER (WHERE b.status = 'blocked' AND NOT b.is_overflow)::int AS blocked,
               count(*) FILTER (WHERE b.status = 'occupied' AND b.is_overflow)::int AS overflow_occupied
          FROM beds b JOIN wards w ON w.id = b.ward_id JOIN departments d ON d.id = w.department_id
         WHERE w.is_active AND d.is_active AND ${f('w.department_id')} GROUP BY 1, 2`.execute(db),
      sql<{ id: string; name: string; n: number }>`
        SELECT ba.department_id AS id, d.name, count(*)::int AS n
          FROM bed_assignments ba JOIN inpatient_stays st ON st.encounter_id = ba.encounter_id JOIN departments d ON d.id = ba.department_id
         WHERE ba.ended_at IS NULL AND ba.bed_id IS NULL AND st.status = 'active' AND ${f('ba.department_id')} GROUP BY 1, 2`.execute(db),
      sql<{ id: string; name: string; n: number }>`
        WITH x AS (SELECT coalesce((SELECT ba.department_id FROM bed_assignments ba WHERE ba.encounter_id = st.encounter_id ORDER BY ba.started_at, ba.id LIMIT 1), e.department_id) AS id
                     FROM inpatient_stays st JOIN encounters e ON e.id = st.encounter_id
                    WHERE st.status <> 'cancelled' AND st.admitted_at >= ${t0} AND st.admitted_at < ${t1})
        SELECT x.id, d.name, count(*)::int AS n FROM x JOIN departments d ON d.id = x.id WHERE ${f('x.id')} GROUP BY 1, 2`.execute(db),
      sql<{ id: string; name: string; n: number }>`
        WITH x AS (SELECT coalesce((SELECT ba.department_id FROM bed_assignments ba WHERE ba.encounter_id = st.encounter_id ORDER BY ba.started_at DESC, ba.id DESC LIMIT 1), e.department_id) AS id
                     FROM inpatient_stays st JOIN encounters e ON e.id = st.encounter_id
                    WHERE st.status = 'discharged' AND st.ended_at >= ${t0} AND st.ended_at < ${t1})
        SELECT x.id, d.name, count(*)::int AS n FROM x JOIN departments d ON d.id = x.id WHERE ${f('x.id')} GROUP BY 1, 2`.execute(db),
      sql<{ id: string; name: string; n: number }>`
        SELECT e.department_id AS id, d.name, count(*)::int AS n FROM encounters e JOIN departments d ON d.id = e.department_id
         WHERE e.start_time >= ${t0} AND e.start_time < ${t1} AND e.status::text IN ('active', 'discharged') AND ${f('e.department_id')} GROUP BY 1, 2`.execute(db),
      sql<{ id: string; name: string; planned: number; in_progress: number; completed: number; cancelled: number }>`
        SELECT c.department_id AS id, d.name,
               count(*) FILTER (WHERE c.status IN ('tentative', 'scheduled'))::int AS planned, count(*) FILTER (WHERE c.status = 'in_progress')::int AS in_progress,
               count(*) FILTER (WHERE c.status = 'completed')::int AS completed, count(*) FILTER (WHERE c.status = 'cancelled')::int AS cancelled
          FROM or_cases c JOIN departments d ON d.id = c.department_id
         WHERE c.scheduled_start >= ${t0} AND c.scheduled_start < ${t1} AND ${f('c.department_id')} GROUP BY 1, 2`.execute(db),
      sql<{ id: string; name: string; lab: number; ext: number }>`
        SELECT e.department_id AS id, d.name,
               count(*) FILTER (WHERE i.ext_lab_id IS NULL AND sp.collected_at < now() - make_interval(mins => ${labMin}))::int AS lab,
               count(*) FILTER (WHERE i.ext_lab_id IS NOT NULL AND i.ext_due_at < now())::int AS ext
          FROM dx_order_items i JOIN encounters e ON e.id = i.encounter_id JOIN departments d ON d.id = e.department_id LEFT JOIN lab_specimens sp ON sp.id = i.specimen_id
         WHERE i.section = 'lab' AND i.status NOT IN ('validated', 'cancelled') AND ${f('e.department_id')} GROUP BY 1, 2`.execute(db),
      sql<{ id: string; name: string; n: number }>`
        SELECT e.department_id AS id, d.name, count(*)::int AS n
          FROM dx_order_items i JOIN encounters e ON e.id = i.encounter_id JOIN departments d ON d.id = e.department_id
         WHERE i.section <> 'lab' AND i.status NOT IN ('validated', 'cancelled') AND coalesce(i.performed_at, i.arrived_at) < now() - make_interval(hours => ${dxHours})
           AND ${f('e.department_id')} GROUP BY 1, 2`.execute(db),
    ]);
    for (const x of beds.rows) Object.assign(row(x.id, x.name), { beds: x.beds, occupied: x.occupied, free: x.free, reserved: x.reserved, cleaning: x.cleaning, blocked: x.blocked, overflow_occupied: x.overflow_occupied });
    for (const x of noBed.rows) row(x.id, x.name).no_bed = x.n;
    for (const x of adm.rows) row(x.id, x.name).admissions_today = x.n;
    for (const x of dis.rows) row(x.id, x.name).discharges_today = x.n;
    for (const x of enc.rows) row(x.id, x.name).encounters_today = x.n;
    for (const x of or.rows) Object.assign(row(x.id, x.name), { or_planned: x.planned, or_in_progress: x.in_progress, or_completed: x.completed, or_cancelled: x.cancelled });
    for (const x of lab.rows) Object.assign(row(x.id, x.name), { lab_overdue: x.lab, ext_overdue: x.ext });
    for (const x of dx.rows) row(x.id, x.name).dx_overdue = x.n;
    const list = [...rows.values()].sort((a, b) => a.department_name.localeCompare(b.department_name));
    const totals = Object.fromEntries(LIVE_KEYS.map((k) => [k, list.reduce((a, r) => a + (r[k] as number), 0)])) as Record<string, number>;
    totals.occupancy_now_pct = totals.beds > 0 ? Math.round(((totals.occupied) / totals.beds) * 1000) / 10 : NaN;
    const now = (await sql<{ t: Date }>`SELECT now() AS t`.execute(db)).rows[0].t;
    return { generated_at: now, thresholds: { lab_overdue_min: labMin, dx_overdue_hours: dxHours },
      totals: { ...totals, occupancy_now_pct: Number.isNaN(totals.occupancy_now_pct) ? null : totals.occupancy_now_pct }, departments: list };
  }

  // ------------------------------------------------------------------------------------ ყურადღება
  async attention(u: AuthUser, q: Q) {
    const s = await this.c.settings();
    const scope = this.c.narrow(await this.c.scope(u), q.department_id);
    const today = await this.c.today();
    const from = q.from ?? `${today.slice(0, 8)}01`; const to = q.to ?? today;
    const ov = await this.r.overview(u, { from, to, department_id: q.department_id, compare: 'none' });
    const items: { kind: string; severity: 'red' | 'yellow'; title: string; detail: string; value: number | null; code?: string; unit?: string }[] = [];
    for (const k of ov.kpis.filter((x) => x.status === 'red' || x.status === 'yellow'))
      items.push({ kind: 'kpi', severity: k.status as 'red' | 'yellow', code: k.code, unit: k.unit, title: k.name, value: k.value,
        detail: `სამიზნე ${k.target}${k.warn !== null ? ` (გაფრთხილება ${k.warn})` : ''} · ${from} — ${to}` });
    const sf = scope.all ? sql`TRUE` : sql`f.department_id = ANY(${scope.depts}::uuid[])`;
    const st = (await sql<{ low: number; exp_n: number; exp_v: string; expired_v: string; dead_n: number; dead_v: string; computed_at: Date | null }>`
      SELECT count(*) FILTER (WHERE f.days_of_supply IS NOT NULL AND f.days_of_supply < ${s.stock_days_alert})::int AS low,
             count(*) FILTER (WHERE f.expiring_value_90 > 0)::int AS exp_n, coalesce(sum(f.expiring_value_90), 0)::text AS exp_v,
             coalesce(sum(f.expired_value), 0)::text AS expired_v,
             count(*) FILTER (WHERE f.qty > 0 AND (f.last_move_at IS NULL OR f.last_move_at < now() - make_interval(days => ${s.dead_stock_days})))::int AS dead_n,
             coalesce(sum(f.value) FILTER (WHERE f.qty > 0 AND (f.last_move_at IS NULL OR f.last_move_at < now() - make_interval(days => ${s.dead_stock_days}))), 0)::text AS dead_v,
             max(f.computed_at) AS computed_at
        FROM rpt_stock_snapshot f WHERE ${sf}`.execute(this.c.rdb)).rows[0];
    if (st.low) items.push({ kind: 'stock_low', severity: 'red', title: 'დაბალი მარაგი', value: st.low, detail: `პოზიცია × ლოკაცია, მარაგი < ${s.stock_days_alert} დღე` });
    if (n(st.expired_v) > 0) items.push({ kind: 'stock_expired', severity: 'red', title: 'ვადაგასული მარაგი', value: r2(n(st.expired_v)), detail: 'ნაშთის ღირებულება (₾) — ჩამოსაწერი' });
    if (st.exp_n) items.push({ kind: 'stock_expiring', severity: 'yellow', title: 'ვადაგასასვლელი 90 დღეში', value: r2(n(st.exp_v)), detail: `${st.exp_n} პოზიცია (₾)` });
    if (st.dead_n) items.push({ kind: 'stock_dead', severity: 'yellow', title: 'მარაგი მოძრაობის გარეშე', value: r2(n(st.dead_v)), detail: `${st.dead_n} პოზიცია, ${s.dead_stock_days} დღეზე მეტი (₾)` });
    const live = await this.live(u, q) as { totals: Record<string, number | null> };
    const L = live.totals;
    if (L.lab_overdue) items.push({ kind: 'lab_overdue', severity: 'red', title: 'ლაბ. პასუხი აგვიანებს', value: L.lab_overdue, detail: `აღებიდან ${s.lab_overdue_min} წუთზე მეტი, ვალიდაციის გარეშე` });
    if (L.ext_overdue) items.push({ kind: 'ext_overdue', severity: 'yellow', title: 'გარე ლაბორატორია აგვიანებს', value: L.ext_overdue, detail: 'მოსალოდნელი ვადა გავიდა' });
    if (L.dx_overdue) items.push({ kind: 'dx_overdue', severity: 'red', title: 'კვლევის დასკვნა აგვიანებს', value: L.dx_overdue, detail: `ჩატარებიდან ${s.dx_overdue_hours} საათზე მეტი, ხელმოწერის გარეშე` });
    if (L.no_bed) items.push({ kind: 'no_bed', severity: 'yellow', title: 'პაციენტი საწოლის გარეშე', value: L.no_bed, detail: 'აქტიური ჰოსპიტალიზაცია, საწოლი არ არის მინიჭებული' });
    items.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'red' ? -1 : 1));
    return { from, to, stock_computed_at: st.computed_at, items };
  }
}

@Controller('reporting')
export class ReportingDashController {
  constructor(private readonly s: ReportingDashService) {}
  @Get('dashboards') @Roles(...RPT_READ) dashboards() { return this.s.dashboards(); }
  @Put('dashboards/:key') @Roles(...RPT_CONFIG) put(@Param('key') key: string, @Body() d: DashboardDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.putDashboard(key, d, u, r); }
  @Get('headline') @Roles(...RPT_READ) headline(@Query() q: Q, @CurrentUser() u: AuthUser) { return this.s.headline(u, q); }
  @Get('trend') @Roles(...RPT_READ) trend(@Query() q: Q, @CurrentUser() u: AuthUser) { return this.s.trend(u, q); }
  @Get('live') @Roles(...RPT_READ) live(@Query() q: Q, @CurrentUser() u: AuthUser) { if (q.department_id && !UUID_RE.test(q.department_id)) throw new BadRequestException('department_id'); return this.s.live(u, q); }
  @Get('attention') @Roles(...RPT_READ) attention(@Query() q: Q, @CurrentUser() u: AuthUser) { return this.s.attention(u, q); }
}
