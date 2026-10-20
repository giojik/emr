import { BadRequestException, Controller, ForbiddenException, Get, Injectable, Query, Req, Res, StreamableFile } from '@nestjs/common';
import type { Request, Response } from 'express';
import { sql } from 'kysely';
import { join } from 'node:path';
import PDFDocument from 'pdfkit';
import { auditCtx } from '../audit/audit-context';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser } from '../auth/roles';
import { writeXlsxBook, type Cell, type SheetSpec } from '../claims-export/xlsx';
import type { Database } from '../database/database.module';
import { toCsv } from '../finance/finance-common';
import { DATE_RE, daysBetween, InjectReadDb, RPT_ALL, rptModule, TZ, UUID_RE } from '../reporting/reporting-common';
import { EVENT_KA, EVENT_TYPES, HARM_KA, HARMS, QmCommon, STATUS_KA } from './quality-common';
import { bedDays, categoryExpander, DENOM_KA, HARM_ORDER, type Indicator, indicatorMatch, loadIndicators, rate, SERVICE_KA, SERVICE_TYPES } from './quality-metrics';

/**
 * ხარისხის ანგარიშები (0066): შეჯამება + 13 თვე, განაწილება (pivot), ინდიკატორები, ვადები / შესრულება, CAPA, ხელშემწყობი ფაქტორები; ექსპორტი xlsx / PDF / CSV;
 * დეპერსონალიზებული რეესტრი (სახელმწიფოსთვის — ზოგადი ფორმატი).
 *  • რაოდენობები / ტრენდი / ინდიკატორები — rpt_fact_quality-იდან (იგივე, რაც დაფის KPI); ვადები / CAPA / ფაქტორები — qm_*-იდან (READ_DB).
 *  • ხედვა: quality — მთელი კლინიკა; quality_dept — თავისი განყოფილებები; quality_view — რეპორტინგის ხედვის არე (reports_all / viewer / admin — კლინიკა),
 *    მხოლოდ აგრეგატები, view_min_cell-ზე ნაკლები (> 0) რაოდენობა — „< N“ (null). პაციენტი, ავტორი, აღწერა — არსად.
 *  • პირის მიხედვით ჭრილი / რეიტინგი არ არის (just culture).
 */
type Q = Record<string, string | undefined>;
type Access = 'full' | 'dept' | 'view';
export interface QScope { access: Access; all: boolean; depts: string[]; minCell: number }
interface F { from: string; to: string; service: string[]; category: string | null; events: string[]; harms: string[]; sentinel: boolean }
const FONT_DIR = join(__dirname, '..', '..', 'assets', 'fonts');
const DIMS = ['category', 'subcategory', 'harm', 'department', 'service_type', 'event_type', 'month'] as const;
type Dim = (typeof DIMS)[number];
const DIM_KA: Record<string, string> = { category: 'კატეგორია', subcategory: 'ქვეკატეგორია', harm: 'ზიანი', department: 'განყოფილება', service_type: 'მომსახურების ტიპი',
  event_type: 'ტიპი', month: 'თვე', none: '' };
const STATUS_RPT: Record<string, string> = { green: 'შესრულებულია', yellow: 'გაფრთხილება', red: 'არ სრულდება' };
const MAX_DAYS = 3 * 366;
const num = (v: unknown) => Number(v ?? 0) || 0;
const r4 = (x: number) => Math.round(x * 1_000_000) / 1_000_000;   // საწოლ-დღე (მცირე მნიშვნელზეც ზუსტი)
const r1 = (x: number | null) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

@Injectable()
export class QmReportsService {
  constructor(private readonly c: QmCommon, @InjectReadDb() private readonly rdb: Database, private readonly audit: AuditService) {}
  private get db() { return this.c.db; }

  // ------------------------------------------------------------------------------------ ხედვა / ფილტრები
  async scope(u: AuthUser): Promise<QScope> {
    const r = await this.c.rules();
    if (has(u, 'quality')) return { access: 'full', all: true, depts: [], minCell: 0 };
    const noScope = () => new ForbiddenException({ code: 'NO_SCOPE', message: 'განყოფილება არ გაქვთ მინიჭებული (მომხმარებლის განყოფილება ან რეპორტინგის ხედვის არე)' });
    if (has(u, 'quality_dept')) {
      const depts = await this.c.userDepts(u.id);
      if (!depts.length) throw noScope();
      return { access: 'dept', all: false, depts, minCell: 0 };
    }
    if (has(u, 'quality_view')) {
      const minCell = Number(r.view_min_cell ?? 0) || 0;
      if (has(u, ...RPT_ALL)) return { access: 'view', all: true, depts: [], minCell };
      const depts = await this.c.userDepts(u.id);
      if (!depts.length) throw noScope();
      return { access: 'view', all: false, depts, minCell };
    }
    throw new ForbiddenException('ხარისხის ანგარიშებზე წვდომა არ გაქვთ');
  }
  narrow(s: QScope, dept?: string): QScope {
    if (!dept) return s;
    if (!UUID_RE.test(dept)) throw new BadRequestException('department_id');
    if (!s.all && !s.depts.includes(dept)) throw new ForbiddenException({ code: 'OUT_OF_SCOPE', message: 'ეს განყოფილება თქვენი ხედვის არის გარეთაა' });
    return { ...s, all: false, depts: [dept] };
  }
  filters(q: Q): F {
    const from = q.from ?? ''; const to = q.to ?? '';
    if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) throw new BadRequestException('პერიოდი: from ≤ to (YYYY-MM-DD)');
    if (daysBetween(from, to) > MAX_DAYS) throw new BadRequestException('პერიოდი — მაქსიმუმ 3 წელი');
    const list = (v: string | undefined, allowed: readonly string[], name: string) => {
      const xs = (v ?? '').split(',').map((x) => x.trim()).filter(Boolean);
      if (xs.some((x) => !allowed.includes(x))) throw new BadRequestException(`${name}: ${allowed.join(' / ')}`);
      return xs;
    };
    if (q.category_id && !UUID_RE.test(q.category_id)) throw new BadRequestException('category_id');
    return { from, to, service: list(q.service_type, SERVICE_TYPES, 'service_type'), category: q.category_id || null, events: list(q.event_type, EVENT_TYPES, 'event_type'),
      harms: list(q.harm, HARMS, 'harm'), sentinel: q.sentinel === '1' || q.sentinel === 'true' };
  }
  private sup(s: QScope) { return (x: number) => (s.minCell > 0 && x > 0 && x < s.minCell ? null : x); }

  /** ფაქტის WHERE (alias f): პერიოდი + ხედვა + ფილტრები */
  private async factWhere(s: QScope, f: F, period = true) {
    const cats = f.category ? [...(await categoryExpander(this.db))([f.category])] : null;
    return sql.join([
      period ? sql`f.day BETWEEN ${f.from}::date AND ${f.to}::date` : sql`TRUE`,
      s.all ? sql`TRUE` : sql`f.department_id = ANY(${s.depts}::uuid[])`,
      f.service.length ? sql`f.service_type = ANY(${f.service}::varchar[])` : sql`TRUE`,
      cats ? sql`f.category_id = ANY(${cats}::uuid[])` : sql`TRUE`,
      f.events.length ? sql`f.event_type = ANY(${f.events}::varchar[])` : sql`TRUE`,
      f.harms.length ? sql`f.harm = ANY(${f.harms}::varchar[])` : sql`TRUE`,
      f.sentinel ? sql`f.is_sentinel` : sql`TRUE`,
    ], sql` AND `);
  }
  /** ინციდენტის WHERE (alias i) — იგივე ფილტრები ცოცხალ ცხრილზე (ვადები, ფაქტორები) */
  private async incWhere(s: QScope, f: F) {
    const basis = (await this.c.rules()).report_date_basis === 'reported' ? sql`i.reported_at` : sql`i.occurred_at`;
    const cats = f.category ? [...(await categoryExpander(this.db))([f.category])] : null;
    return sql.join([
      sql`i.status IN ('investigation', 'analysis', 'capa', 'closed')`,
      sql`(${basis} AT TIME ZONE ${TZ})::date BETWEEN ${f.from}::date AND ${f.to}::date`,
      s.all ? sql`TRUE` : sql`i.department_id = ANY(${s.depts}::uuid[])`,
      f.service.length ? sql`i.service_type = ANY(${f.service}::varchar[])` : sql`TRUE`,
      cats ? sql`i.category_id = ANY(${cats}::uuid[])` : sql`TRUE`,
      f.events.length ? sql`i.event_type = ANY(${f.events}::varchar[])` : sql`TRUE`,
      f.harms.length ? sql`i.harm = ANY(${f.harms}::varchar[])` : sql`TRUE`,
      f.sentinel ? sql`i.is_sentinel` : sql`TRUE`,
    ], sql` AND `);
  }
  private months(to: string, count = 13) {
    const [y, m] = to.split('-').map(Number);
    return Array.from({ length: count }, (_, i) => {
      const d = new Date(Date.UTC(y, m - count + i, 1)); const from = d.toISOString().slice(0, 10);
      const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
      return { label: from.slice(0, 7), from, to: end > to ? to : end };
    });
  }
  private async deptNames(ids?: string[]) {
    let q = this.db.selectFrom('departments').select(['id', 'name', 'is_active']).orderBy('name');
    if (ids) { if (!ids.length) return []; q = q.where('id', 'in', ids); }
    return q.execute();
  }
  private async dataAsOf() {
    return (await this.rdb.selectFrom('rpt_refresh_runs').select('finished_at').where('status', '=', 'ok').orderBy('finished_at', 'desc').executeTakeFirst())?.finished_at ?? null;
  }
  private async occupancyBasis() { return (await rptModule(this.db)).settings.occupancy_basis; }

  // ------------------------------------------------------------------------------------ მეტა
  async meta(u: AuthUser) {
    const r = await this.c.rules();
    const s = await this.scope(u);
    const cats = await this.db.selectFrom('qm_classifiers').select(['id', 'parent_id', 'name', 'is_active']).where('kind', '=', 'category').orderBy('sort_order').orderBy('name').execute();
    const today = (await sql<{ d: string }>`SELECT to_char((now() AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS d`.execute(this.db)).rows[0].d;
    return { access: s.access, scope_all: s.all, min_cell: s.minCell, date_basis: r.report_date_basis ?? 'occurred', today, data_as_of: await this.dataAsOf(),
      reporting_enabled: (await rptModule(this.db)).enabled,
      departments: s.all ? await this.deptNames() : await this.deptNames(s.depts),
      service_types: SERVICE_TYPES.map((x) => ({ code: x, name: SERVICE_KA[x] })), event_types: EVENT_TYPES.map((x) => ({ code: x, name: EVENT_KA[x] })),
      harms: HARMS.map((x) => ({ code: x, name: HARM_KA[x] })), categories: cats, dims: DIMS.map((x) => ({ code: x, name: DIM_KA[x] })),
      can_registry: s.access === 'full', can_drill: s.access !== 'view' };
  }

  // ------------------------------------------------------------------------------------ შეჯამება + 13 თვე
  private async counts(s: QScope, f: F) {
    const w = await this.factWhere(s, f);
    const r = (await sql<Record<string, number>>`
      SELECT coalesce(sum(f.n), 0)::int AS n, coalesce(sum(f.n) FILTER (WHERE f.event_type = 'harm'), 0)::int AS harm,
             coalesce(sum(f.n) FILTER (WHERE f.event_type = 'no_harm'), 0)::int AS no_harm, coalesce(sum(f.n) FILTER (WHERE f.event_type = 'near_miss'), 0)::int AS near_miss,
             coalesce(sum(f.n) FILTER (WHERE f.event_type = 'hazard'), 0)::int AS hazard, coalesce(sum(f.n) FILTER (WHERE f.is_sentinel), 0)::int AS sentinel,
             coalesce(sum(f.anonymous), 0)::int AS anonymous, coalesce(sum(f.n) FILTER (WHERE f.service_type = 'inpatient'), 0)::int AS inpatient,
             coalesce(sum(f.n) FILTER (WHERE f.harm IN ('severe', 'death')), 0)::int AS severe,
             coalesce(sum(f.triaged), 0)::int AS triaged, coalesce(sum(f.triage_on_time), 0)::int AS on_time
        FROM rpt_fact_quality f WHERE ${w}`.execute(this.rdb)).rows[0];
    return r;
  }
  private shapeCounts(s: QScope, c: Record<string, number>, bd: number) {
    const sp = this.sup(s);
    const nm = (c.harm ?? 0) + (c.no_harm ?? 0);
    const hidden = (x: number) => sp(x) === null;
    return { n: sp(c.n), harm: sp(c.harm), no_harm: sp(c.no_harm), near_miss: sp(c.near_miss), hazard: sp(c.hazard), sentinel: sp(c.sentinel), anonymous: sp(c.anonymous),
      severe: sp(c.severe),
      near_miss_ratio: hidden(c.near_miss) || hidden(nm) ? null : (nm > 0 ? Math.round((c.near_miss / nm) * 100) / 100 : null),
      anonymous_pct: hidden(c.anonymous) ? null : pct(c.anonymous, c.n),
      report_rate: hidden(c.inpatient) ? null : rate(c.inpatient, bd, 1000),
      triage_on_time_pct: pct(c.on_time, c.triaged) };
  }
  async summary(u: AuthUser, q: Q, scope?: QScope) {
    const s0 = scope ?? await this.scope(u);
    const s = this.narrow(s0, q.department_id);
    const f = this.filters(q);
    const basis = await this.occupancyBasis();
    const len = daysBetween(f.from, f.to);
    const pf = { ...f, from: addDays(f.from, -len), to: addDays(f.from, -1) };
    const deps = s.all ? null : s.depts;
    const [cur, prev, bdCur, bdPrev] = await Promise.all([this.counts(s, f), this.counts(s, pf), bedDaysOf(this.rdb, deps, f.from, f.to, basis), bedDaysOf(this.rdb, deps, pf.from, pf.to, basis)]);
    // ტრენდი 13 თვე (ტიპებით) + შარშან
    const months = this.months(f.to);
    const w = await this.factWhere(s, { ...f, from: months[0].from, to: f.to });
    const tr = (await sql<{ m: string; event_type: string; n: number }>`
      SELECT to_char(f.day, 'YYYY-MM') AS m, f.event_type, sum(f.n)::int AS n FROM rpt_fact_quality f WHERE ${w} GROUP BY 1, 2`.execute(this.rdb)).rows;
    const py = await this.factWhere(s, { ...f, from: addYears(months[0].from, -1), to: addYears(f.to, -1) });
    const prevYear = (await sql<{ m: string; n: number }>`
      SELECT to_char(f.day + interval '1 year', 'YYYY-MM') AS m, sum(f.n)::int AS n FROM rpt_fact_quality f WHERE ${py} GROUP BY 1`.execute(this.rdb)).rows;
    const sp = this.sup(s);
    const series = Object.fromEntries(EVENT_TYPES.map((e) => [e, months.map((m) => sp(tr.filter((x) => x.m === m.label && x.event_type === e).reduce((a, x) => a + x.n, 0)))]));
    const pending = s.access === 'full'
      ? (await sql<{ n: number; overdue: number }>`SELECT count(*)::int AS n, count(*) FILTER (WHERE i.triage_due_at < now())::int AS overdue FROM qm_incidents i
           WHERE i.status = 'submitted' AND ${s.all ? sql`TRUE` : sql`i.department_id = ANY(${s.depts}::uuid[])`}`.execute(this.db)).rows[0] : null;
    return { from: f.from, to: f.to, compare: { from: pf.from, to: pf.to }, scope_all: s.all, min_cell: s.minCell, data_as_of: await this.dataAsOf(),
      totals: this.shapeCounts(s, cur, bdCur), prev: this.shapeCounts(s, prev, bdPrev), bed_days: r4(bdCur), pending_triage: pending,
      trend: { months: months.map((m) => m.label), series, total: months.map((m) => sp(tr.filter((x) => x.m === m.label).reduce((a, x) => a + x.n, 0))),
        prev_year: months.map((m) => sp(prevYear.find((x) => x.m === m.label)?.n ?? 0)) } };
  }

  // ------------------------------------------------------------------------------------ განაწილება (pivot)
  private dimExpr(d: Dim) {
    switch (d) {
      case 'category': return { key: sql`coalesce(c.parent_id, c.id)::text`, label: sql`coalesce(cp.name, c.name)` };
      case 'subcategory': return { key: sql`c.id::text`, label: sql`CASE WHEN cp.name IS NULL THEN c.name ELSE cp.name || ' → ' || c.name END` };
      case 'harm': return { key: sql`f.harm`, label: sql`f.harm` };
      case 'department': return { key: sql`f.department_id::text`, label: sql`d.name` };
      case 'service_type': return { key: sql`f.service_type`, label: sql`f.service_type` };
      case 'event_type': return { key: sql`f.event_type`, label: sql`f.event_type` };
      case 'month': return { key: sql`to_char(f.day, 'YYYY-MM')`, label: sql`to_char(f.day, 'YYYY-MM')` };
    }
  }
  private dimLabel(d: string, key: string, label: string) {
    if (d === 'harm') return HARM_KA[key as keyof typeof HARM_KA] ?? key;
    if (d === 'service_type') return SERVICE_KA[key] ?? key;
    if (d === 'event_type') return EVENT_KA[key] ?? key;
    return label;
  }
  private dimOrder(d: string): (a: { key: string; total: number }, b: { key: string; total: number }) => number {
    const fixed = d === 'harm' ? HARM_ORDER : d === 'service_type' ? [...SERVICE_TYPES] : d === 'event_type' ? [...EVENT_TYPES] : null;
    if (fixed) return (a, b) => fixed.indexOf(a.key) - fixed.indexOf(b.key);
    if (d === 'month') return (a, b) => a.key.localeCompare(b.key);
    return (a, b) => b.total - a.total;
  }
  async distribution(u: AuthUser, q: Q, scope?: QScope) {
    const s = this.narrow(scope ?? await this.scope(u), q.department_id);
    const f = this.filters(q);
    const rd = (q.rows ?? 'category') as Dim; const cd = (q.cols ?? 'harm') as Dim | 'none';
    if (!DIMS.includes(rd) || (cd !== 'none' && !DIMS.includes(cd))) throw new BadRequestException(`rows / cols: ${DIMS.join(' / ')}${' / none'}`);
    if (rd === cd) throw new BadRequestException('rows და cols სხვადასხვა უნდა იყოს');
    const R = this.dimExpr(rd); const C = cd === 'none' ? { key: sql`'all'`, label: sql`'სულ'` } : this.dimExpr(cd);
    const w = await this.factWhere(s, f);
    const raw = (await sql<{ rk: string; rl: string; ck: string; cl: string; n: number }>`
      SELECT ${R.key} AS rk, ${R.label} AS rl, ${C.key} AS ck, ${C.label} AS cl, sum(f.n)::int AS n
        FROM rpt_fact_quality f JOIN qm_classifiers c ON c.id = f.category_id LEFT JOIN qm_classifiers cp ON cp.id = c.parent_id JOIN departments d ON d.id = f.department_id
       WHERE ${w} GROUP BY 1, 2, 3, 4`.execute(this.rdb)).rows;
    const agg = (k: 'rk' | 'ck', l: 'rl' | 'cl', dim: string) => {
      const m = new Map<string, { key: string; label: string; total: number }>();
      for (const x of raw) { const e = m.get(x[k]) ?? { key: x[k], label: this.dimLabel(dim, x[k], x[l]), total: 0 }; e.total += x.n; m.set(x[k], e); }
      return [...m.values()].sort(this.dimOrder(dim));
    };
    const rows = agg('rk', 'rl', rd); const cols = cd === 'none' ? [{ key: 'all', label: 'სულ', total: rows.reduce((a, r) => a + r.total, 0) }] : agg('ck', 'cl', cd);
    const sp = this.sup(s);
    const cell = new Map(raw.map((x) => [`${x.rk}|${x.ck}`, x.n]));
    const total = rows.reduce((a, r) => a + r.total, 0);
    return { rows_dim: rd, cols_dim: cd, from: f.from, to: f.to, min_cell: s.minCell, can_drill: s.access !== 'view',
      rows: rows.map((r) => ({ key: r.key, label: r.label, total: sp(r.total), pct: total ? Math.round((r.total / total) * 1000) / 10 : null })),
      cols: cols.map((c) => ({ key: c.key, label: c.label, total: sp(c.total) })),
      cells: rows.map((r) => cols.map((c) => sp(cell.get(`${r.key}|${c.key}`) ?? 0))), total: sp(total) };
  }

  // ------------------------------------------------------------------------------------ ინდიკატორები
  async indicators(u: AuthUser, q: Q, scope?: QScope) {
    const s = this.narrow(scope ?? await this.scope(u), q.department_id);
    const f = this.filters(q);
    const [list, expand, basis] = await Promise.all([loadIndicators(this.db), categoryExpander(this.db), this.occupancyBasis()]);
    const months = this.months(f.to);
    const from = months[0].from < f.from ? months[0].from : f.from;
    const dw = s.all ? sql`TRUE` : sql`f.department_id = ANY(${s.depts}::uuid[])`;
    // მრიცხველი: ინდიკატორის ფილტრით (ანგარიშის კატეგორია / ტიპი / ზიანი / მომსახურება — არ ვრცელდება, ინდიკატორს თავისი განმარტება აქვს)
    const facts = (await sql<{ day: string; department_id: string; category_id: string; event_type: string; harm: string; service_type: string; affected: string; n: number }>`
      SELECT to_char(f.day, 'YYYY-MM-DD') AS day, f.department_id, f.category_id, f.event_type, f.harm, f.service_type, f.affected, sum(f.n)::int AS n
        FROM rpt_fact_quality f WHERE f.day BETWEEN ${from}::date AND ${f.to}::date AND ${dw} GROUP BY 1, 2, 3, 4, 5, 6, 7`.execute(this.rdb)).rows;
    const beds = (await sql<{ day: string; department_id: string; oh: string; mc: string; adm: string }>`
      SELECT to_char(f.day, 'YYYY-MM-DD') AS day, f.department_id, sum(f.occupied_hours)::text AS oh, sum(f.midnight_census)::text AS mc, sum(f.admissions)::text AS adm
        FROM rpt_fact_beds f WHERE f.day BETWEEN ${from}::date AND ${f.to}::date AND ${dw} GROUP BY 1, 2`.execute(this.rdb)).rows;
    const flow = (await sql<{ day: string; department_id: string | null; v: number }>`
      SELECT to_char(f.day, 'YYYY-MM-DD') AS day, f.department_id, sum(f.encounters)::int AS v
        FROM rpt_fact_flow f WHERE f.day BETWEEN ${from}::date AND ${f.to}::date AND ${dw} GROUP BY 1, 2`.execute(this.rdb)).rows;
    const den = (i: Indicator, a: string, b: string, dep?: string) => {
      const inR = (x: { day: string; department_id: string | null }) => x.day >= a && x.day <= b && (!dep || x.department_id === dep);
      if (i.denominator === 'visits') return flow.filter(inR).reduce((t, x) => t + x.v, 0);
      const bs = beds.filter(inR);
      if (i.denominator === 'admissions') return bs.reduce((t, x) => t + num(x.adm), 0);
      return bedDays(basis, bs.reduce((t, x) => t + num(x.oh), 0), bs.reduce((t, x) => t + num(x.mc), 0));
    };
    const numer = (i: Indicator, cats: Set<string>, a: string, b: string, dep?: string) =>
      facts.filter((x) => x.day >= a && x.day <= b && (!dep || x.department_id === dep) && indicatorMatch(i, cats, x)).reduce((t, x) => t + x.n, 0);
    const targets = await this.db.selectFrom('rpt_kpi_targets').select(['kpi_code', 'department_id', 'target', 'warn']).where('kpi_code', 'like', 'qm_ind_%').execute();
    const tgt = (code: string, dep: string | null) => {
      const t = targets.find((x) => x.kpi_code === `qm_ind_${code}` && x.department_id === dep) ?? (dep ? targets.find((x) => x.kpi_code === `qm_ind_${code}` && x.department_id === null) : undefined);
      return t ? { target: num(t.target), warn: t.warn === null ? null : num(t.warn) } : null;
    };
    const status = (v: number | null, t: { target: number; warn: number | null } | null) => (v === null || !t ? null : v <= t.target ? 'green' : t.warn !== null && v <= t.warn ? 'yellow' : 'red');
    const sp = this.sup(s);
    const deps = s.all ? await this.deptNames() : await this.deptNames(s.depts);
    const one = s.all ? null : s.depts.length === 1 ? s.depts[0] : null;
    const rows = list.map((i) => {
      const cats = expand(i.category_ids);
      const nn = numer(i, cats, f.from, f.to); const dd = den(i, f.from, f.to);
      const val = sp(nn) === null ? null : rate(nn, dd, i.per);
      const t = tgt(i.code, one);
      return { code: i.code, kpi_code: `qm_ind_${i.code}`, name: i.name, description: i.description, denominator: i.denominator, denominator_ka: DENOM_KA[i.denominator], per: i.per,
        numerator: sp(nn), denominator_value: r4(dd), value: val, target: t?.target ?? null, warn: t?.warn ?? null, status: status(val, t),
        by_department: deps.map((d) => {
          const a = numer(i, cats, f.from, f.to, d.id); const b = den(i, f.from, f.to, d.id);
          const v = sp(a) === null ? null : rate(a, b, i.per);
          return { department_id: d.id, department_name: d.name, numerator: sp(a), denominator_value: r4(b), value: v, status: status(v, tgt(i.code, d.id)) };
        }).filter((x) => (x.numerator ?? 1) > 0 || x.denominator_value > 0),
        trend: months.map((m) => { const a = numer(i, cats, m.from, m.to); return sp(a) === null ? null : rate(a, den(i, m.from, m.to), i.per); }) };
    });
    return { from: f.from, to: f.to, months: months.map((m) => m.label), occupancy_basis: basis, min_cell: s.minCell, rows };
  }

  // ------------------------------------------------------------------------------------ ვადები / შესრულება (ცოცხალი)
  async timeliness(u: AuthUser, q: Q, scope?: QScope) {
    const s = this.narrow(scope ?? await this.scope(u), q.department_id);
    const f = this.filters(q);
    const w = await this.incWhere(s, f);
    const H = sql`extract(epoch FROM i.triaged_at - i.reported_at) / 3600.0`;
    const D = sql`extract(epoch FROM i.closed_at - i.reported_at) / 86400.0`;
    const base = (grouped: boolean) => sql`
      SELECT ${grouped ? sql`i.department_id,` : sql``} count(*)::int AS n,
             count(*) FILTER (WHERE i.triaged_at IS NOT NULL)::int AS triaged,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY ${H}) FILTER (WHERE i.triaged_at IS NOT NULL) AS triage_median_h,
             percentile_cont(0.9) WITHIN GROUP (ORDER BY ${H}) FILTER (WHERE i.triaged_at IS NOT NULL) AS triage_p90_h,
             avg(${H}) FILTER (WHERE i.triaged_at IS NOT NULL) AS triage_avg_h,
             count(*) FILTER (WHERE i.triaged_at <= i.triage_due_at)::int AS triage_on_time,
             count(*) FILTER (WHERE i.is_sentinel AND i.triaged_at IS NOT NULL)::int AS s_triaged,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY ${H}) FILTER (WHERE i.is_sentinel AND i.triaged_at IS NOT NULL) AS s_median_h,
             count(*) FILTER (WHERE i.is_sentinel AND i.triaged_at <= i.triage_due_at)::int AS s_on_time,
             count(*) FILTER (WHERE i.status = 'closed')::int AS closed,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY ${D}) FILTER (WHERE i.status = 'closed') AS close_median_d,
             percentile_cont(0.9) WITHIN GROUP (ORDER BY ${D}) FILTER (WHERE i.status = 'closed') AS close_p90_d,
             avg(${D}) FILTER (WHERE i.status = 'closed') AS close_avg_d,
             count(*) FILTER (WHERE i.analysis_level = 'review')::int AS review_n,
             count(*) FILTER (WHERE i.analysis_level = 'rca')::int AS rca_n,
             count(*) FILTER (WHERE i.analysis_level = 'review' AND a.status IN ('submitted', 'approved'))::int AS review_sub,
             count(*) FILTER (WHERE i.analysis_level = 'rca' AND a.status IN ('submitted', 'approved'))::int AS rca_sub,
             count(*) FILTER (WHERE i.analysis_level = 'review' AND a.status IN ('submitted', 'approved') AND a.submitted_at <= i.analysis_due_at)::int AS review_on_time,
             count(*) FILTER (WHERE i.analysis_level = 'rca' AND a.status IN ('submitted', 'approved') AND a.submitted_at <= i.analysis_due_at)::int AS rca_on_time,
             count(*) FILTER (WHERE i.analysis_level = 'rca' AND a.status = 'approved')::int AS rca_approved,
             count(*) FILTER (WHERE i.analysis_level = 'review' AND a.status = 'approved')::int AS review_approved,
             count(*) FILTER (WHERE i.status IN ('investigation', 'analysis') AND i.analysis_due_at < now())::int AS analysis_overdue,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM a.approved_at - i.triaged_at) / 86400.0) FILTER (WHERE i.analysis_level = 'rca' AND a.status = 'approved') AS rca_median_d
        FROM qm_incidents i LEFT JOIN qm_analyses a ON a.incident_id = i.id`;
    const tot = (await sql<Record<string, number | string | null>>`${base(false)} WHERE ${w}`.execute(this.rdb)).rows[0];
    const byDep = (await sql<Record<string, number | string | null> & { department_id: string; department_name: string }>`
      SELECT x.*, d.name AS department_name FROM (${base(true)} WHERE ${w} GROUP BY i.department_id) x JOIN departments d ON d.id = x.department_id ORDER BY d.name`
      .execute(this.rdb)).rows;
    const shape = (t: Record<string, number | string | null>) => {
      const N = (k: string) => num(t[k]);
      return {
        n: N('n'),
        triage: { triaged: N('triaged'), median_h: r1(t.triage_median_h === null ? null : num(t.triage_median_h)), p90_h: r1(t.triage_p90_h === null ? null : num(t.triage_p90_h)),
          avg_h: r1(t.triage_avg_h === null ? null : num(t.triage_avg_h)), on_time_pct: pct(N('triage_on_time'), N('triaged')),
          sentinel: { triaged: N('s_triaged'), median_h: r1(t.s_median_h === null ? null : num(t.s_median_h)), on_time_pct: pct(N('s_on_time'), N('s_triaged')) } },
        closure: { closed: N('closed'), open: N('n') - N('closed'), closed_pct: pct(N('closed'), N('n')), median_d: r1(t.close_median_d === null ? null : num(t.close_median_d)),
          p90_d: r1(t.close_p90_d === null ? null : num(t.close_p90_d)), avg_d: r1(t.close_avg_d === null ? null : num(t.close_avg_d)) },
        analysis: {
          review: { n: N('review_n'), submitted: N('review_sub'), approved: N('review_approved'), on_time_pct: pct(N('review_on_time'), N('review_sub')) },
          rca: { n: N('rca_n'), submitted: N('rca_sub'), approved: N('rca_approved'), completion_pct: pct(N('rca_approved'), N('rca_n')), on_time_pct: pct(N('rca_on_time'), N('rca_sub')),
            median_d: r1(t.rca_median_d === null ? null : num(t.rca_median_d)) },
          overdue_now: N('analysis_overdue') },
      };
    };
    const sp = this.sup(s);
    return { from: f.from, to: f.to, min_cell: s.minCell, ...shape(tot),
      by_department: byDep.map((r) => { const x = shape(r); return { department_id: r.department_id, department_name: r.department_name, n: sp(x.n),
        triage_median_h: x.triage.median_h, triage_on_time_pct: x.triage.on_time_pct, closed_pct: x.closure.closed_pct, close_median_d: x.closure.median_d,
        analysis_on_time_pct: pct(num(r.review_on_time) + num(r.rca_on_time), num(r.review_sub) + num(r.rca_sub)), rca_completion_pct: x.analysis.rca.completion_pct }; }) };
  }

  // ------------------------------------------------------------------------------------ CAPA
  async capa(u: AuthUser, q: Q, scope?: QScope) {
    const s = this.narrow(scope ?? await this.scope(u), q.department_id);
    const f = this.filters(q);
    const a = sql`(${f.from}::date)::timestamp AT TIME ZONE ${TZ}`; const b = sql`(${f.to}::date + 1)::timestamp AT TIME ZONE ${TZ}`;
    const today = sql`(now() AT TIME ZONE ${TZ})::date`;
    const rows = (await sql<Record<string, number> & { department_id: string | null; department_name: string | null }>`
      WITH c AS (SELECT c.*, coalesce(c.department_id, (SELECT i.department_id FROM qm_capa_incidents ci JOIN qm_incidents i ON i.id = ci.incident_id
                                                          WHERE ci.capa_id = c.id ORDER BY ci.linked_at LIMIT 1)) AS dep FROM qm_capas c)
      SELECT c.dep AS department_id, d.name AS department_name,
             count(*) FILTER (WHERE c.status = 'open')::int AS open, count(*) FILTER (WHERE c.status = 'in_progress')::int AS in_progress,
             count(*) FILTER (WHERE c.status IN ('open', 'in_progress') AND c.due_date < ${today})::int AS overdue,
             count(*) FILTER (WHERE c.status IN ('open', 'in_progress') AND c.due_date < ${today} AND ${today} - c.due_date <= 30)::int AS age_1_30,
             count(*) FILTER (WHERE c.status IN ('open', 'in_progress') AND ${today} - c.due_date BETWEEN 31 AND 60)::int AS age_31_60,
             count(*) FILTER (WHERE c.status IN ('open', 'in_progress') AND ${today} - c.due_date > 60)::int AS age_60,
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM qm_capa_due_requests r WHERE r.capa_id = c.id AND r.status = 'pending'))::int AS due_requests,
             count(*) FILTER (WHERE c.status = 'done' AND c.effectiveness_result IS NULL AND c.effectiveness_due IS NOT NULL AND c.effectiveness_due <= ${today})::int AS effectiveness_due,
             count(*) FILTER (WHERE c.created_at >= ${a} AND c.created_at < ${b})::int AS created,
             count(*) FILTER (WHERE c.status = 'done' AND c.done_at >= ${a} AND c.done_at < ${b})::int AS done,
             count(*) FILTER (WHERE c.status = 'done' AND c.done_at >= ${a} AND c.done_at < ${b} AND (c.done_at AT TIME ZONE ${TZ})::date <= c.due_date)::int AS done_on_time,
             count(*) FILTER (WHERE c.status = 'cancelled' AND c.cancelled_at >= ${a} AND c.cancelled_at < ${b})::int AS cancelled,
             count(*) FILTER (WHERE c.effectiveness_at >= ${a} AND c.effectiveness_at < ${b})::int AS checked,
             count(*) FILTER (WHERE c.effectiveness_at >= ${a} AND c.effectiveness_at < ${b} AND c.effectiveness_result = 'effective')::int AS effective,
             count(*) FILTER (WHERE c.kind = 'corrective' AND c.created_at >= ${a} AND c.created_at < ${b})::int AS corrective,
             count(*) FILTER (WHERE c.kind = 'preventive' AND c.created_at >= ${a} AND c.created_at < ${b})::int AS preventive
        FROM c LEFT JOIN departments d ON d.id = c.dep
       WHERE ${s.all ? sql`TRUE` : sql`c.dep = ANY(${s.depts}::uuid[])`}
       GROUP BY 1, 2 ORDER BY 2 NULLS LAST`.execute(this.rdb)).rows;
    const keys = ['open', 'in_progress', 'overdue', 'age_1_30', 'age_31_60', 'age_60', 'due_requests', 'effectiveness_due', 'created', 'done', 'done_on_time', 'cancelled', 'checked',
      'effective', 'corrective', 'preventive'];
    const t = Object.fromEntries(keys.map((k) => [k, rows.reduce((x, r) => x + num(r[k]), 0)]));
    const sp = this.sup(s);
    return { from: f.from, to: f.to, min_cell: s.minCell,
      snapshot: { open: sp(t.open), in_progress: sp(t.in_progress), overdue: sp(t.overdue), age: { d1_30: sp(t.age_1_30), d31_60: sp(t.age_31_60), d60: sp(t.age_60) },
        due_requests: sp(t.due_requests), effectiveness_due: sp(t.effectiveness_due) },
      period: { created: sp(t.created), corrective: sp(t.corrective), preventive: sp(t.preventive), done: sp(t.done), done_on_time: sp(t.done_on_time), on_time_pct: pct(t.done_on_time, t.done),
        cancelled: sp(t.cancelled), checked: sp(t.checked), effective: sp(t.effective), effective_pct: pct(t.effective, t.checked) },
      by_department: rows.map((r) => ({ department_id: r.department_id, department_name: r.department_name ?? 'განყოფილების გარეშე', open: sp(num(r.open) + num(r.in_progress)),
        overdue: sp(num(r.overdue)), done: sp(num(r.done)), on_time_pct: pct(num(r.done_on_time), num(r.done)), effective_pct: pct(num(r.effective), num(r.checked)) })) };
  }

  // ------------------------------------------------------------------------------------ ხელშემწყობი ფაქტორები
  async factors(u: AuthUser, q: Q, scope?: QScope) {
    const s = this.narrow(scope ?? await this.scope(u), q.department_id);
    const f = this.filters(q);
    const w = await this.incWhere(s, f);
    const total = (await sql<{ n: number }>`SELECT count(*)::int AS n FROM qm_incidents i JOIN qm_analyses a ON a.incident_id = i.id AND a.status = 'approved' WHERE ${w}`
      .execute(this.rdb)).rows[0].n;
    const rows = (await sql<{ id: string; parent_id: string | null; name: string; sort_order: number; n: number }>`
      SELECT c.id, c.parent_id, c.name, c.sort_order, count(DISTINCT i.id)::int AS n
        FROM qm_classifiers c
        LEFT JOIN qm_analysis_factors af ON af.factor_id = c.id
        LEFT JOIN qm_analyses a ON a.incident_id = af.incident_id AND a.status = 'approved'
        LEFT JOIN qm_incidents i ON i.id = a.incident_id AND ${w}
       WHERE c.kind = 'factor' GROUP BY 1, 2, 3, 4 ORDER BY c.sort_order, c.name`.execute(this.rdb)).rows;
    // ჯგუფი: ინციდენტი, სადაც ჯგუფის ან მისი რომელიმე ფაქტორი მონიშნულია (უნიკალური)
    const grp = (await sql<{ gid: string; n: number }>`
      SELECT coalesce(c.parent_id, c.id) AS gid, count(DISTINCT i.id)::int AS n
        FROM qm_analysis_factors af JOIN qm_classifiers c ON c.id = af.factor_id
        JOIN qm_analyses a ON a.incident_id = af.incident_id AND a.status = 'approved' JOIN qm_incidents i ON i.id = a.incident_id
       WHERE ${w} GROUP BY 1`.execute(this.rdb)).rows;
    const sp = this.sup(s);
    const groups = rows.filter((r) => !r.parent_id).map((g) => {
      const gn = grp.find((x) => x.gid === g.id)?.n ?? 0;
      return { id: g.id, name: g.name, n: sp(gn), pct: sp(gn) === null ? null : pct(gn, total),
        factors: rows.filter((x) => x.parent_id === g.id).map((x) => ({ id: x.id, name: x.name, n: sp(x.n), pct: sp(x.n) === null ? null : pct(x.n, total) })).sort((a, b) => (b.n ?? 0) - (a.n ?? 0)) };
    }).sort((a, b) => (b.n ?? 0) - (a.n ?? 0));
    return { from: f.from, to: f.to, min_cell: s.minCell, analyses: sp(total), groups };
  }

  // ------------------------------------------------------------------------------------ ექსპორტი
  async gather(u: AuthUser, q: Q, scope?: QScope) {
    const s = scope ?? await this.scope(u);
    const qq = { ...q };
    const [summary, byCat, byDep, bySvc, indicators, timeliness, capa, factors] = await Promise.all([
      this.summary(u, qq, s), this.distribution(u, { ...qq, rows: 'category', cols: 'harm' }, s), this.distribution(u, { ...qq, rows: 'department', cols: 'event_type' }, s),
      this.distribution(u, { ...qq, rows: 'service_type', cols: 'event_type' }, s), this.indicators(u, qq, s), this.timeliness(u, qq, s), this.capa(u, qq, s), this.factors(u, qq, s)]);
    const deptName = q.department_id ? (await this.db.selectFrom('departments').select('name').where('id', '=', q.department_id).executeTakeFirst())?.name ?? '—'
      : s.all ? 'მთელი კლინიკა' : (await this.deptNames(s.depts)).map((d) => d.name).join(', ');
    const clinic = (await this.db.selectFrom('clinic_settings').select('name').where('id', '=', 1).executeTakeFirst())?.name ?? '';
    return { q, scope: s, scope_label: deptName, clinic, generated_at: new Date(), summary, byCat, byDep, bySvc, indicators, timeliness, capa, factors };
  }

  xlsxSheets(d: Awaited<ReturnType<QmReportsService['gather']>>, withHead = true): SheetSpec[] {
    const sm = d.summary; const T = sm.totals; const P = sm.prev; const mc = d.scope.minCell;
    const c = (v: number | null | undefined): Cell => (v === null || v === undefined ? (mc ? `< ${mc}` : null) : typeof v === 'number' ? { v, fmt: Number.isInteger(v) ? '#,##0' : '#,##0.0#' } : v);
    const pre: Cell[][] = withHead ? [[`ხარისხი და ინციდენტები — ანგარიში ${sm.from} — ${sm.to}`], [`${d.clinic} · ${d.scope_label}`],
      ['აგრეგირებული მონაცემები — პაციენტის, ავტორისა და აღწერის გარეშე; მხოლოდ მიღებული ინციდენტები (უარყოფილი / დუბლიკატი არ ითვლება)'], []] : [];
    const head = (h: string[]) => h;
    const pv = (x: typeof d.byCat, title: string): SheetSpec => ({ name: title, rows: [head([DIM_KA[x.rows_dim], ...x.cols.map((k) => k.label), 'სულ', '%']),
      ...x.rows.map((r, i) => [r.label, ...x.cells[i].map(c), c(r.total), r.pct]), ['სულ', ...x.cols.map((k) => c(k.total)), c(x.total), x.total === null ? null : 100]],
      boldRows: [0, x.rows.length + 1], widths: [36, ...x.cols.map(() => 14), 10, 8] });
    const sheets: SheetSpec[] = [];
    const sumRows: [string, number | null, number | null][] = [['ინციდენტები (მიღებული)', T.n, P.n], ['ზიანით', T.harm, P.harm], ['ზიანის გარეშე', T.no_harm, P.no_harm],
      ['near-miss', T.near_miss, P.near_miss], ['სახიფათო მდგომარეობა', T.hazard, P.hazard], ['სენტინელური', T.sentinel, P.sentinel], ['მძიმე / სიკვდილი', T.severe, P.severe],
      ['ანონიმური', T.anonymous, P.anonymous], ['ანონიმური %', T.anonymous_pct, P.anonymous_pct], ['near-miss თანაფარდობა', T.near_miss_ratio, P.near_miss_ratio],
      ['შეტყობინება 1000 საწოლ-დღეზე (სტაციონარი)', T.report_rate, P.report_rate], ['ტრიაჟი ვადაში %', T.triage_on_time_pct, P.triage_on_time_pct]];
    sheets.push({ name: 'შეჯამება', rows: [...pre, ['მაჩვენებელი', `${sm.from} — ${sm.to}`, `წინა (${sm.compare.from} — ${sm.compare.to})`], ...sumRows.map((r) => [r[0], c(r[1]), c(r[2])]),
      ...(sm.pending_triage ? [[], ['ტრიაჟს ელოდება (ახლა)', sm.pending_triage.n], ['აქედან ვადაგადაცილებული', sm.pending_triage.overdue]] as Cell[][] : [])],
      boldRows: [0, pre.length], widths: [46, 22, 30] });
    sheets.push({ name: 'ტრენდი 13 თვე', rows: [['ტიპი', ...sm.trend.months], ...EVENT_TYPES.map((e) => [EVENT_KA[e], ...sm.trend.series[e].map(c)]),
      ['სულ', ...sm.trend.total.map(c)], ['შარშან (სულ)', ...sm.trend.prev_year.map(c)]], boldRows: [0], widths: [30, ...sm.trend.months.map(() => 10)] });
    sheets.push(pv(d.byCat, 'კატეგორია × ზიანი')); sheets.push(pv(d.byDep, 'განყოფილება × ტიპი')); sheets.push(pv(d.bySvc, 'მომსახურება × ტიპი'));
    const I = d.indicators;
    sheets.push({ name: 'ინდიკატორები', rows: [['ინდიკატორი', 'განყოფილება', 'მრიცხველი', 'მნიშვნელი', 'ერთეული', 'მნიშვნელობა', 'სამიზნე', 'სტატუსი'],
      ...I.rows.flatMap((r) => [[r.name, 'სულ', c(r.numerator), c(r.denominator_value), `${r.per} ${r.denominator_ka}ზე`, c(r.value), c(r.target), r.status ? STATUS_RPT[r.status] : ''] as Cell[],
        ...r.by_department.map((x) => ['', x.department_name, c(x.numerator), c(x.denominator_value), '', c(x.value), '', x.status ? STATUS_RPT[x.status] : ''] as Cell[])]),
      [], ['ინდიკატორი — 13 თვე', ...I.months], ...I.rows.map((r) => [r.name, ...r.trend.map(c)])], boldRows: [0], widths: [40, 30, 12, 12, 22, 12, 10, 14] });
    const L = d.timeliness;
    sheets.push({ name: 'ვადები', rows: [['მაჩვენებელი', 'მნიშვნელობა'], ['ინციდენტები (კოჰორტა)', c(L.n)], ['ტრიაჟი — მედიანა (სთ)', c(L.triage.median_h)], ['ტრიაჟი — P90 (სთ)', c(L.triage.p90_h)],
      ['ტრიაჟი — საშუალო (სთ)', c(L.triage.avg_h)], ['ტრიაჟი ვადაში %', c(L.triage.on_time_pct)], ['სენტინელური — ტრიაჟის მედიანა (სთ)', c(L.triage.sentinel.median_h)],
      ['სენტინელური — ტრიაჟი ვადაში %', c(L.triage.sentinel.on_time_pct)], ['დახურული', c(L.closure.closed)], ['დახურული %', c(L.closure.closed_pct)],
      ['დახურვამდე — მედიანა (დღე)', c(L.closure.median_d)], ['დახურვამდე — P90 (დღე)', c(L.closure.p90_d)], ['მიმოხილვა — ვადაში %', c(L.analysis.review.on_time_pct)],
      ['RCA — საჭირო', c(L.analysis.rca.n)], ['RCA — დამტკიცებული', c(L.analysis.rca.approved)], ['RCA — შესრულება %', c(L.analysis.rca.completion_pct)],
      ['RCA — ვადაში %', c(L.analysis.rca.on_time_pct)], ['RCA — ტრიაჟიდან დამტკიცებამდე, მედიანა (დღე)', c(L.analysis.rca.median_d)], ['ანალიზი ვადაგადაცილებული (ახლა)', c(L.analysis.overdue_now)], [],
      ['განყოფილება', 'ინციდენტები', 'ტრიაჟი მედიანა სთ', 'ტრიაჟი ვადაში %', 'დახურული %', 'დახურვამდე მედიანა დღე', 'ანალიზი ვადაში %', 'RCA შესრულება %'],
      ...L.by_department.map((r) => [r.department_name, c(r.n), c(r.triage_median_h), c(r.triage_on_time_pct), c(r.closed_pct), c(r.close_median_d), c(r.analysis_on_time_pct), c(r.rca_completion_pct)])],
      boldRows: [0, 21], widths: [44, 14, 16, 16, 14, 20, 16, 16] });
    const C = d.capa;
    sheets.push({ name: 'CAPA', rows: [['მაჩვენებელი', 'მნიშვნელობა'], ['ღია (ახლა)', c(C.snapshot.open)], ['შესრულებაში (ახლა)', c(C.snapshot.in_progress)], ['ვადაგადაცილებული (ახლა)', c(C.snapshot.overdue)],
      ['— 1–30 დღე', c(C.snapshot.age.d1_30)], ['— 31–60 დღე', c(C.snapshot.age.d31_60)], ['— 60+ დღე', c(C.snapshot.age.d60)], ['ვადის მოთხოვნა (მოლოდინში)', c(C.snapshot.due_requests)],
      ['ეფექტიანობის შემოწმება — დრო დადგა', c(C.snapshot.effectiveness_due)], ['შექმნილი (პერიოდი)', c(C.period.created)], ['— მაკორექტირებელი', c(C.period.corrective)],
      ['— პრევენციული', c(C.period.preventive)], ['შესრულებული (პერიოდი)', c(C.period.done)], ['ვადაში %', c(C.period.on_time_pct)], ['გაუქმებული', c(C.period.cancelled)],
      ['ეფექტიანობა შემოწმდა', c(C.period.checked)], ['ეფექტიანი %', c(C.period.effective_pct)], [],
      ['განყოფილება', 'ღია', 'ვადაგადაცილებული', 'შესრულებული', 'ვადაში %', 'ეფექტიანი %'],
      ...C.by_department.map((r) => [r.department_name, c(r.open), c(r.overdue), c(r.done), c(r.on_time_pct), c(r.effective_pct)])], boldRows: [0, 18], widths: [40, 12, 18, 14, 12, 12] });
    const X = d.factors;
    sheets.push({ name: 'ფაქტორები', rows: [[`დამტკიცებული ანალიზები: ${X.analyses ?? (mc ? `< ${mc}` : 0)}`], ['ჯგუფი / ფაქტორი', 'ინციდენტები', '%'],
      ...X.groups.flatMap((g) => [[g.name, c(g.n), c(g.pct)] as Cell[], ...g.factors.map((x) => [`   ${x.name}`, c(x.n), c(x.pct)] as Cell[])])], boldRows: [0, 1], widths: [44, 14, 10] });
    return sheets;
  }

  async pdf(d: Awaited<ReturnType<QmReportsService['gather']>>): Promise<Buffer> {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 36, bottom: 40, left: 40, right: 40 }, bufferPages: true, info: { Title: 'ხარისხი და ინციდენტები', Author: d.clinic } });
    doc.registerFont('R', join(FONT_DIR, 'EmrSans-Regular.ttf')); doc.registerFont('B', join(FONT_DIR, 'EmrSans-Bold.ttf'));
    const chunks: Buffer[] = []; doc.on('data', (x: Buffer) => chunks.push(x));
    const done = new Promise<Buffer>((res) => doc.on('end', () => res(Buffer.concat(chunks))));
    const L = doc.page.margins.left; const W = doc.page.width - L - doc.page.margins.right; const mc = d.scope.minCell;
    const bottom = () => doc.page.height - doc.page.margins.bottom;
    const fv = (v: number | null | undefined, sfx = '') => (v === null || v === undefined ? (mc ? `< ${mc}` : '—') : `${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}${sfx}`);
    const sm = d.summary; const T = sm.totals;
    doc.font('B').fontSize(9).fillColor('#555').text(d.clinic, L, doc.y, { width: W });
    doc.font('B').fontSize(15).fillColor('black').text('ხარისხი და ინციდენტები — ანგარიში', L, doc.y + 2, { width: W });
    doc.font('R').fontSize(9).fillColor('#444').text(`${d.scope_label} · ${sm.from} — ${sm.to} · შექმნილია ${d.generated_at.toLocaleString('ka-GE', { timeZone: 'Asia/Tbilisi' })}`, { width: W });
    doc.fillColor('black').moveDown(0.6);
    const section = (t: string) => { if (doc.y + 60 > bottom()) doc.addPage(); else doc.moveDown(0.5); doc.font('B').fontSize(10.5).fillColor('black').text(t, L, doc.y, { width: W }); doc.moveDown(0.2); };
    const table = (cols: { h: string; w: number; r?: boolean }[], rows: string[][]) => {
      const xs: number[] = []; let acc = L; for (const c of cols) { xs.push(acc); acc += c.w * W; }
      const head = () => { const y = doc.y; doc.font('B').fontSize(7.5).fillColor('#555');
        cols.forEach((c, i) => doc.text(c.h, xs[i] + 2, y, { width: c.w * W - 4, align: c.r ? 'right' : 'left', lineBreak: false, ellipsis: true }));
        doc.moveTo(L, y + 10).lineTo(L + W, y + 10).strokeColor('#bbb').lineWidth(0.5).stroke(); doc.y = y + 12; };
      head();
      for (const r of rows) {
        if (doc.y + 26 > bottom()) { doc.addPage(); head(); }
        const y = doc.y; doc.font('R').fontSize(8).fillColor('black');
        r.forEach((v, i) => doc.text(v.replace(/→/g, '->'), xs[i] + 2, y, { width: cols[i].w * W - 4, align: cols[i].r ? 'right' : 'left', lineBreak: false, ellipsis: true }));   // EmrSans-ში „→“ არ არის
        doc.y = y + 12;
      }
      doc.x = L;
    };
    section('შეჯამება');
    table([{ h: 'მაჩვენებელი', w: 0.5 }, { h: 'პერიოდი', w: 0.25, r: true }, { h: 'წინა პერიოდი', w: 0.25, r: true }], [
      ['ინციდენტები (მიღებული)', fv(T.n), fv(sm.prev.n)], ['ზიანით', fv(T.harm), fv(sm.prev.harm)], ['ზიანის გარეშე', fv(T.no_harm), fv(sm.prev.no_harm)],
      ['near-miss', fv(T.near_miss), fv(sm.prev.near_miss)], ['სახიფათო მდგომარეობა', fv(T.hazard), fv(sm.prev.hazard)], ['სენტინელური', fv(T.sentinel), fv(sm.prev.sentinel)],
      ['near-miss თანაფარდობა', fv(T.near_miss_ratio), fv(sm.prev.near_miss_ratio)], ['შეტყობინება 1000 საწოლ-დღეზე', fv(T.report_rate), fv(sm.prev.report_rate)],
      ['ტრიაჟი ვადაში', fv(T.triage_on_time_pct, '%'), fv(sm.prev.triage_on_time_pct, '%')]]);
    section('ინდიკატორები');
    table([{ h: 'ინდიკატორი', w: 0.46 }, { h: 'მრიცხველი', w: 0.12, r: true }, { h: 'მნიშვნელი', w: 0.14, r: true }, { h: 'მნიშვნელობა', w: 0.14, r: true }, { h: 'სამიზნე', w: 0.14, r: true }],
      d.indicators.rows.map((r) => [r.name, fv(r.numerator), fv(r.denominator_value), fv(r.value), fv(r.target)]));
    section('კატეგორიები');
    table([{ h: 'კატეგორია', w: 0.5 }, { h: 'ინციდენტები', w: 0.25, r: true }, { h: '%', w: 0.25, r: true }],
      d.byCat.rows.slice(0, 13).map((r) => [r.label, fv(r.total), fv(r.pct, '%')]));
    const Lt = d.timeliness; const C = d.capa;
    section('ვადები და შესრულება');
    doc.font('R').fontSize(8.5).fillColor('black').text([
      `ტრიაჟი: მედიანა ${fv(Lt.triage.median_h, ' სთ')}, P90 ${fv(Lt.triage.p90_h, ' სთ')}, ვადაში ${fv(Lt.triage.on_time_pct, '%')}`,
      `დახურვა: ${fv(Lt.closure.closed)} (${fv(Lt.closure.closed_pct, '%')}), მედიანა ${fv(Lt.closure.median_d, ' დღე')}`,
      `RCA: საჭირო ${fv(Lt.analysis.rca.n)}, შესრულება ${fv(Lt.analysis.rca.completion_pct, '%')}, ვადაში ${fv(Lt.analysis.rca.on_time_pct, '%')} · მიმოხილვა ვადაში ${fv(Lt.analysis.review.on_time_pct, '%')}`,
      `CAPA (ახლა): ღია ${fv(C.snapshot.open)}, შესრულებაში ${fv(C.snapshot.in_progress)}, ვადაგადაცილებული ${fv(C.snapshot.overdue)} · პერიოდში შესრულდა ${fv(C.period.done)}, ვადაში ${fv(C.period.on_time_pct, '%')}, ეფექტიანი ${fv(C.period.effective_pct, '%')}`,
    ].join('\n'), L, doc.y, { width: W });
    const top = d.factors.groups.flatMap((g) => g.factors.map((x) => ({ ...x, g: g.name }))).filter((x) => (x.n ?? 0) > 0).sort((a, b) => (b.n ?? 0) - (a.n ?? 0)).slice(0, 6);
    if (top.length) {
      section('ხელშემწყობი ფაქტორები (ხშირი)');
      table([{ h: 'ფაქტორი', w: 0.6 }, { h: 'ინციდენტები', w: 0.2, r: true }, { h: '%', w: 0.2, r: true }], top.map((x) => [`${x.g} / ${x.name}`, fv(x.n), fv(x.pct, '%')]));
    }
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i); doc.page.margins.bottom = 0;
      const y = doc.page.height - 28;
      doc.font('R').fontSize(7).fillColor('#888').text('ხარისხის გაუმჯობესების დოკუმენტი · აგრეგირებული მონაცემები, პაციენტის / ავტორის მონაცემების გარეშე', L, y, { width: W - 60, lineBreak: false });
      doc.text(`${i - range.start + 1} / ${range.count}`, L + W - 50, y, { width: 50, align: 'right', lineBreak: false });
    }
    doc.end();
    return done;
  }

  async export(u: AuthUser, q: Q, req: Request) {
    const format = q.format ?? 'xlsx';
    if (!['xlsx', 'pdf', 'csv'].includes(format)) throw new BadRequestException('format: xlsx / pdf / csv');
    const s = await this.scope(u);
    const base = `qm_report_${q.from}_${q.to}`;
    let out: { name: string; type: string; body: Buffer };
    if (format === 'csv') {
      const ds = q.dataset ?? 'distribution';
      let head: string[] = []; let rows: (string | number | null)[][] = []; let title = '';
      const mc = s.minCell; const v = (x: number | null) => (x === null ? (mc ? `< ${mc}` : null) : x);
      if (ds === 'distribution') {
        const d = await this.distribution(u, q, s);
        title = `${DIM_KA[d.rows_dim]} × ${DIM_KA[d.cols_dim] || 'სულ'} ${d.from} — ${d.to}`; head = [DIM_KA[d.rows_dim], ...d.cols.map((c) => c.label), 'სულ'];
        rows = d.rows.map((r, i) => [r.label, ...d.cells[i].map(v), v(r.total)]);
      } else if (ds === 'indicators') {
        const d = await this.indicators(u, q, s);
        title = `ინდიკატორები ${d.from} — ${d.to}`; head = ['ინდიკატორი', 'განყოფილება', 'მრიცხველი', 'მნიშვნელი', 'მნიშვნელობა', 'სამიზნე'];
        rows = d.rows.flatMap((r) => [[r.name, 'სულ', v(r.numerator), r.denominator_value, r.value, r.target], ...r.by_department.map((x) => [r.name, x.department_name, v(x.numerator), x.denominator_value, x.value, null])]);
      } else if (ds === 'factors') {
        const d = await this.factors(u, q, s);
        title = `ხელშემწყობი ფაქტორები ${d.from} — ${d.to}`; head = ['ჯგუფი', 'ფაქტორი', 'ინციდენტები', '%'];
        rows = d.groups.flatMap((g) => [[g.name, '', v(g.n), g.pct], ...g.factors.map((x) => [g.name, x.name, v(x.n), x.pct])]);
      } else throw new BadRequestException('dataset: distribution / indicators / factors');
      out = { name: `${base}_${ds}.csv`, type: 'text/csv; charset=utf-8', body: Buffer.from(toCsv(head, rows, title), 'utf8') };
    } else {
      const d = await this.gather(u, q, s);
      out = format === 'xlsx' ? { name: `${base}.xlsx`, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: writeXlsxBook(this.xlsxSheets(d)) }
        : { name: `${base}.pdf`, type: 'application/pdf', body: await this.pdf(d) };
    }
    await this.audit.log(auditCtx(req), { action: 'QM_REPORT_EXPORT', entityName: 'qm_reports', entityId: format === 'csv' ? (q.dataset ?? 'distribution') : 'report',
      newData: { format, from: q.from, to: q.to, department_id: q.department_id ?? null, access: s.access, min_cell: s.minCell } });
    return out;
  }

  // ------------------------------------------------------------------------------------ რეესტრი (დეპერსონალიზებული) — სახელმწიფოსთვის / გარე ანგარიშისთვის
  async registry(u: AuthUser, q: Q, req: Request) {
    const s = await this.scope(u);
    if (s.access !== 'full') throw new ForbiddenException('რეესტრის ექსპორტი — მხოლოდ ხარისხის მენეჯერი');
    const format = q.format ?? 'xlsx';
    if (!['xlsx', 'csv'].includes(format)) throw new BadRequestException('format: xlsx / csv');
    const sc = this.narrow(s, q.department_id);
    const f = this.filters(q);
    const w = await this.incWhere(sc, f);
    const rows = (await sql<Record<string, string | number | boolean | null>>`
      SELECT i.inc_no, to_char(i.occurred_at AT TIME ZONE ${TZ}, 'YYYY-MM-DD HH24:MI') AS occurred, to_char(i.reported_at AT TIME ZONE ${TZ}, 'YYYY-MM-DD HH24:MI') AS reported,
             d.name AS department, i.service_type, coalesce(cp.name, c.name) AS category, CASE WHEN cp.name IS NULL THEN NULL ELSE c.name END AS subcategory,
             i.event_type, i.affected, i.harm, i.risk_score, i.risk_level, i.is_sentinel, i.merp_category, i.status, i.analysis_level,
             (SELECT count(*)::int FROM qm_capa_incidents ci WHERE ci.incident_id = i.id) AS capas,
             to_char(i.triaged_at AT TIME ZONE ${TZ}, 'YYYY-MM-DD HH24:MI') AS triaged, to_char(i.closed_at AT TIME ZONE ${TZ}, 'YYYY-MM-DD HH24:MI') AS closed,
             i.disclosure_status
        FROM qm_incidents i JOIN departments d ON d.id = i.department_id JOIN qm_classifiers c ON c.id = i.category_id LEFT JOIN qm_classifiers cp ON cp.id = c.parent_id
       WHERE ${w} ORDER BY i.occurred_at LIMIT 20000`.execute(this.rdb)).rows;
    const AFF: Record<string, string> = { patient: 'პაციენტი', staff: 'თანამშრომელი', visitor: 'ვიზიტორი', none: 'არავის' };
    const RISK: Record<string, string> = { low: 'დაბალი', medium: 'საშუალო', high: 'მაღალი', extreme: 'ექსტრემალური' };
    const LVL: Record<string, string> = { review: 'მიმოხილვა', rca: 'RCA' };
    const DISC: Record<string, string> = { done: 'ეცნობა', not_disclosed: 'არ ეცნობა' };
    const head = ['ნომერი', 'მოვლენის დრო', 'შეტყობინების დრო', 'განყოფილება', 'მომსახურების ტიპი', 'კატეგორია', 'ქვეკატეგორია', 'ტიპი', 'ვის შეეხო', 'ზიანი', 'რისკი (ქულა)',
      'რისკის დონე', 'სენტინელური', 'NCC MERP', 'სტატუსი', 'ანალიზის დონე', 'CAPA', 'ტრიაჟი', 'დახურვა', 'ინფორმირება'];
    const data = rows.map((r) => [r.inc_no, r.occurred, r.reported, r.department, SERVICE_KA[String(r.service_type)] ?? r.service_type, r.category, r.subcategory,
      EVENT_KA[String(r.event_type)], AFF[String(r.affected)], HARM_KA[String(r.harm) as keyof typeof HARM_KA], r.risk_score, r.risk_level ? RISK[String(r.risk_level)] : null,
      r.is_sentinel ? 'კი' : 'არა', r.merp_category, STATUS_KA[String(r.status)], r.analysis_level ? LVL[String(r.analysis_level)] : null, r.capas, r.triaged, r.closed,
      r.disclosure_status ? DISC[String(r.disclosure_status)] : null] as (string | number | null)[]);
    await this.audit.log(auditCtx(req), { action: 'QM_REGISTRY_EXPORT', entityName: 'qm_incidents', entityId: 'registry',
      newData: { format, from: f.from, to: f.to, department_id: q.department_id ?? null, rows: data.length } });
    const title = `ინციდენტების რეესტრი (დეპერსონალიზებული) ${f.from} — ${f.to}`;
    if (format === 'csv') return { name: `qm_registry_${f.from}_${f.to}.csv`, type: 'text/csv; charset=utf-8', body: Buffer.from(toCsv(head, data, title), 'utf8') };
    return { name: `qm_registry_${f.from}_${f.to}.xlsx`, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      body: writeXlsxBook([{ name: 'რეესტრი', rows: [[title], ['პაციენტის, ავტორის, აღწერის და მონაწილეების გარეშე'], [], head, ...data.map((r) => r.map((x) => (typeof x === 'number' ? { v: x, fmt: '0' } : x)))],
        boldRows: [0, 3], widths: head.map((h) => Math.max(12, h.length + 2)) }]) };
  }

  /** თვიური მენეჯერული ანგარიში (0063) — სექცია „ხარისხი“: მიმღების ხედვის არით (რეპორტინგის), აგრეგატები */
  async monthlySection(u: AuthUser, from: string, to: string, all: boolean, depts: string[], department_id?: string) {
    const r = await this.c.rules();
    if (r.monthly_section === false) return null;
    const minCell = has(u, 'quality', 'quality_dept') ? 0 : Number(r.view_min_cell ?? 0) || 0;
    const s: QScope = { access: 'view', all, depts, minCell };
    return this.gather(u, { from, to, department_id }, s);
  }
}

const addDays = (iso: string, d: number) => { const x = new Date(`${iso}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0, 10); };
const addYears = (iso: string, y: number) => {
  const [yy, mm, dd] = iso.split('-').map(Number); const x = new Date(Date.UTC(yy + y, mm - 1, dd)); if (x.getUTCMonth() !== mm - 1) x.setUTCDate(0); return x.toISOString().slice(0, 10);
};
async function bedDaysOf(rdb: Database, depts: string[] | null, from: string, to: string, basis: string) {
  const r = (await sql<{ oh: string; mc: string }>`
    SELECT coalesce(sum(occupied_hours), 0)::text AS oh, coalesce(sum(midnight_census), 0)::text AS mc FROM rpt_fact_beds f
     WHERE f.day BETWEEN ${from}::date AND ${to}::date AND ${depts ? sql`f.department_id = ANY(${depts}::uuid[])` : sql`TRUE`}`.execute(rdb)).rows[0];
  return bedDays(basis, num(r.oh), num(r.mc));
}

@Controller('quality/reports')
export class QmReportsController {
  constructor(private readonly s: QmReportsService) {}
  @Get('meta') @Roles('quality', 'quality_dept', 'quality_view') meta(@CurrentUser() u: AuthUser) { return this.s.meta(u); }
  @Get('summary') @Roles('quality', 'quality_dept', 'quality_view') summary(@Query() q: Q, @CurrentUser() u: AuthUser) { return this.s.summary(u, q); }
  @Get('distribution') @Roles('quality', 'quality_dept', 'quality_view') distribution(@Query() q: Q, @CurrentUser() u: AuthUser) { return this.s.distribution(u, q); }
  @Get('indicators') @Roles('quality', 'quality_dept', 'quality_view') indicators(@Query() q: Q, @CurrentUser() u: AuthUser) { return this.s.indicators(u, q); }
  @Get('timeliness') @Roles('quality', 'quality_dept', 'quality_view') timeliness(@Query() q: Q, @CurrentUser() u: AuthUser) { return this.s.timeliness(u, q); }
  @Get('capa') @Roles('quality', 'quality_dept', 'quality_view') capa(@Query() q: Q, @CurrentUser() u: AuthUser) { return this.s.capa(u, q); }
  @Get('factors') @Roles('quality', 'quality_dept', 'quality_view') factors(@Query() q: Q, @CurrentUser() u: AuthUser) { return this.s.factors(u, q); }
  @Get('export') @Roles('quality', 'quality_dept', 'quality_view')
  async export(@Query() q: Q, @CurrentUser() u: AuthUser, @Req() r: Request, @Res({ passthrough: true }) res: Response) {
    const out = await this.s.export(u, q, r);
    res.set({ 'Content-Type': out.type, 'Content-Disposition': `attachment; filename="${encodeURIComponent(out.name)}"` });
    return new StreamableFile(out.body);
  }
  @Get('registry') @Roles('quality')
  async registry(@Query() q: Q, @CurrentUser() u: AuthUser, @Req() r: Request, @Res({ passthrough: true }) res: Response) {
    const out = await this.s.registry(u, q, r);
    res.set({ 'Content-Type': out.type, 'Content-Disposition': `attachment; filename="${encodeURIComponent(out.name)}"` });
    return new StreamableFile(out.body);
  }
}

