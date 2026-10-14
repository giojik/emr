import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req,
  Res, StreamableFile } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsInt, IsNumber, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import type { Request, Response } from 'express';
import { sql } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser } from '../auth/roles';
import { writeXlsx, type Cell } from '../claims-export/xlsx';
import { toCsv } from '../finance/finance-common';
import { DATE_RE, daysBetween, n, RPT_CONFIG, RPT_READ, RptCommon, type RptScope, TZ, UUID_RE } from './reporting-common';
import { type KpiRow, RptKpiService } from './reporting-kpi';
import { RptRefreshService } from './reporting-refresh';

/**
 * მენეჯერული რეპორტინგი (0060): KPI მიმოხილვა, მწკრივი, განყოფილებებით, მარაგის დღეები, ჩაღრმავება, ექსპორტი;
 * ადმინისტრირება: KPI ცნობარი / სამიზნეები, ხედვის არე, გადათვლა და ჟურნალი.
 */
const MAX_PERIOD_DAYS = 3 * 366;
const DRILL_LIMIT = 2000;
const UNIT_KA: Record<string, string> = { count: '', pct: '%', days: 'დღე', hours: 'სთ', min: 'წთ', gel: '₾', ratio: '' };
const STATUS_KA: Record<string, string> = { green: 'სამიზნე შესრულებულია', yellow: 'გაფრთხილება', red: 'სამიზნე არ სრულდება' };

type Q = Record<string, string | undefined>;

@Injectable()
export class ReportingService {
  constructor(private readonly c: RptCommon, private readonly k: RptKpiService, private readonly r: RptRefreshService, private readonly audit: AuditService) {}

  private period(from?: string, to?: string) {
    if (!from || !to || !DATE_RE.test(from) || !DATE_RE.test(to) || from > to) throw new BadRequestException('პერიოდი: from ≤ to (YYYY-MM-DD)');
    if (daysBetween(from, to) > MAX_PERIOD_DAYS) throw new BadRequestException('პერიოდი — მაქსიმუმ 3 წელი');
    return { from, to };
  }
  private async lastRun() {
    return this.c.rdb.selectFrom('rpt_refresh_runs').select(['id', 'kind', 'date_from', 'date_to', 'finished_at', 'source']).where('status', '=', 'ok')
      .orderBy('finished_at', 'desc').executeTakeFirst();
  }
  private async deptNames(ids?: string[]) {
    let q = this.c.db.selectFrom('departments').select(['id', 'name', 'type', 'is_active']);
    if (ids) { if (!ids.length) return []; q = q.where('id', 'in', ids); }
    return q.orderBy('name').execute();
  }

  // ------------------------------------------------------------------------------------------ მეტა
  async meta(u: AuthUser) {
    const s = await this.c.settings();
    const scope = await this.c.scope(u);
    const kpis = await this.k.kpis(scope);
    const last = await this.lastRun();
    return {
      settings: { occupancy_basis: s.occupancy_basis, stock_days_window: s.stock_days_window, stock_days_alert: s.stock_days_alert, compare_default: s.compare_default,
        refresh_today_min: s.refresh_today_min, lab_tat_start: s.lab_tat_start,
        tv_refresh_min: s.tv_refresh_min, lab_overdue_min: s.lab_overdue_min, dx_overdue_hours: s.dx_overdue_hours, dead_stock_days: s.dead_stock_days,
        doctor_breakdown: s.doctor_breakdown, min_cases: s.min_cases },
      today: await this.c.today(),
      scope: { all: scope.all, finance: scope.finance, phi: scope.phi, departments: scope.all ? await this.deptNames() : await this.deptNames(scope.depts) },
      data_as_of: last?.finished_at ?? null,
      kpis: kpis.map((x) => ({ ...x, unit_ka: UNIT_KA[x.unit] })),
      can_configure: has(u, ...RPT_CONFIG), can_refresh: has(u, 'admin'),
    };
  }

  // ------------------------------------------------------------------------------------------ მიმოხილვა
  async overview(u: AuthUser, q: Q) {
    const s = await this.c.settings();
    const { from, to } = this.period(q.from, q.to);
    const scope = this.c.narrow(await this.c.scope(u), q.department_id);
    const mode = (q.compare ?? s.compare_default) as 'prev' | 'yoy' | 'none';
    if (!['prev', 'yoy', 'none'].includes(mode)) throw new BadRequestException('compare: prev / yoy / none');
    const cmp = this.k.comparePeriod(from, to, mode);
    const kpis = (await this.k.kpis(scope)).filter((x) => !q.category || x.category === q.category);
    const [t, tc, snap, targets, last] = await Promise.all([
      this.k.totals(scope, from, to), cmp ? this.k.totals(scope, cmp.from, cmp.to) : null, this.k.snapshotTotals(scope, s),
      this.k.targets(scope.all ? null : scope.depts.length === 1 ? scope.depts[0] : null), this.lastRun()]);
    return {
      from, to, compare: cmp ? { mode, ...cmp } : null, department_id: q.department_id ?? null, scope_all: scope.all, data_as_of: last?.finished_at ?? null,
      kpis: kpis.map((x) => {
        const value = this.k.value(x.code, t, snap, s);
        const prev = cmp && tc && !x.snapshot ? this.k.value(x.code, tc, null, s) : null;
        const target = targets.get(x.code);
        const status = this.k.status(value, x.direction, target);
        return { code: x.code, category: x.category, name: x.name, unit: x.unit, unit_ka: UNIT_KA[x.unit], direction: x.direction, snapshot: x.snapshot, drill: x.drill,
          definition: x.definition, formula: x.formula, source: x.source, value, compare_value: prev,
          change_pct: value !== null && prev !== null && prev !== 0 ? Math.round(((value - prev) / Math.abs(prev)) * 1000) / 10 : null,
          target: target?.target ?? null, warn: target?.warn ?? null, target_level: target?.level ?? null, status, status_ka: status ? STATUS_KA[status] : null };
      }),
    };
  }

  private async kpi(scope: RptScope, code?: string): Promise<KpiRow> {
    if (!code) throw new BadRequestException('kpi სავალდებულოა');
    const k = (await this.k.kpis(scope, false)).find((x) => x.code === code);
    if (!k) throw new NotFoundException('KPI ვერ მოიძებნა ან თქვენთვის არ ჩანს');
    return k;
  }

  // ------------------------------------------------------------------------------------------ მწკრივი
  async series(u: AuthUser, q: Q) {
    const s = await this.c.settings();
    const { from, to } = this.period(q.from, q.to);
    const scope = this.c.narrow(await this.c.scope(u), q.department_id);
    const k = await this.kpi(scope, q.kpi);
    if (k.snapshot) throw new BadRequestException('მომენტალურ მაჩვენებელს დროის მწკრივი არ აქვს');
    const iv = this.k.intervals(from, to, (q.grain ?? 'day') as 'day' | 'week' | 'month');
    const points = [];
    for (const i of iv) points.push({ period: i.label, from: i.from, to: i.to, value: this.k.value(k.code, await this.k.totals(scope, i.from, i.to), null, s) });
    return { kpi: k.code, name: k.name, unit: k.unit, unit_ka: UNIT_KA[k.unit], grain: q.grain ?? 'day', from, to, points };
  }

  // ------------------------------------------------------------------------------------------ განყოფილებებით
  async byDepartment(u: AuthUser, q: Q) {
    const s = await this.c.settings();
    const { from, to } = this.period(q.from, q.to);
    const scope = await this.c.scope(u);
    const k = await this.kpi(scope, q.kpi);
    const deps = scope.all ? await this.deptNames() : await this.deptNames(scope.depts);
    const targets = new Map<string, Awaited<ReturnType<RptKpiService['targets']>>>();
    const rows = [];
    for (const d of deps) {
      const sc: RptScope = { ...scope, all: false, depts: [d.id] };
      const value = this.k.value(k.code, await this.k.totals(sc, from, to), k.snapshot ? await this.k.snapshotTotals(sc, s) : null, s);
      if (value === null || (value === 0 && !d.is_active)) continue;
      if (!targets.has(d.id)) targets.set(d.id, await this.k.targets(d.id));
      const status = this.k.status(value, k.direction, targets.get(d.id)!.get(k.code));
      rows.push({ department_id: d.id, department_name: d.name, department_type: d.type, value, status });
    }
    const total = this.k.value(k.code, await this.k.totals(scope, from, to), k.snapshot ? await this.k.snapshotTotals(scope, s) : null, s);
    rows.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    return { kpi: k.code, name: k.name, unit: k.unit, unit_ka: UNIT_KA[k.unit], from, to, total, scope_all: scope.all, rows };
  }

  // ------------------------------------------------------------------------------------------ მარაგის დღეები
  async stockDays(u: AuthUser, q: Q) {
    const s = await this.c.settings();
    const scope = this.c.narrow(await this.c.scope(u), q.department_id);
    if (q.location_id && !UUID_RE.test(q.location_id)) throw new BadRequestException('location_id');
    const only = q.only_low === 'true' || q.only_low === '1';
    const rows = (await sql<{ location_id: string; location_name: string; department_name: string | null; item_id: string; item_code: string; item_name: string; unit: string;
      qty: string; value: string; avg_daily_use: string; days_of_supply: string | null; expiring_value_90: string; expired_value: string; last_move_at: Date | null; computed_at: Date }>`
      SELECT f.location_id, l.name AS location_name, d.name AS department_name, f.item_id, i.code AS item_code, i.name AS item_name, i.base_unit AS unit,
             f.qty::text, f.value::text, f.avg_daily_use::text, f.days_of_supply::text, f.expiring_value_90::text, f.expired_value::text, f.last_move_at, f.computed_at
        FROM rpt_stock_snapshot f JOIN stock_locations l ON l.id = f.location_id JOIN stock_items i ON i.id = f.item_id LEFT JOIN departments d ON d.id = f.department_id
       WHERE ${scope.all ? sql`TRUE` : sql`f.department_id = ANY(${scope.depts}::uuid[])`}
         AND (${q.location_id ?? null}::uuid IS NULL OR f.location_id = ${q.location_id ?? null}::uuid)
         AND (${only} = FALSE OR (f.days_of_supply IS NOT NULL AND f.days_of_supply < ${s.stock_days_alert}))
       ORDER BY f.days_of_supply NULLS LAST, i.name
       LIMIT 5000`.execute(this.c.rdb)).rows;
    return {
      window_days: s.stock_days_window, alert_days: s.stock_days_alert, computed_at: rows[0]?.computed_at ?? null,
      rows: rows.map((r) => ({ ...r, qty: n(r.qty), value: n(r.value), avg_daily_use: n(r.avg_daily_use), days_of_supply: r.days_of_supply === null ? null : n(r.days_of_supply),
        expiring_value_90: n(r.expiring_value_90), expired_value: n(r.expired_value), low: r.days_of_supply !== null && n(r.days_of_supply) < s.stock_days_alert })),
    };
  }

  // ------------------------------------------------------------------------------------------ ჩაღრმავება
  async drilldown(u: AuthUser, q: Q, req: Request, audit = true) {
    await this.c.settings();
    const { from, to } = this.period(q.from, q.to);
    const scope = this.c.narrow(await this.c.scope(u), q.department_id);
    const k = await this.kpi(scope, q.kpi);
    if (!k.drill) throw new BadRequestException('ამ მაჩვენებელს ჩაღრმავება არ აქვს');
    if (k.drill === 'stock_low') {
      const sd = await this.stockDays(u, { ...q, only_low: 'true' });
      return { kpi: k.code, kind: k.drill, phi: false, columns: ['ლოკაცია', 'კოდი', 'დასახელება', 'ნაშთი', 'ერთეული', 'დღიური ხარჯი', 'დღე'],
        rows: sd.rows.map((r) => [r.location_name, r.item_code, r.item_name, r.qty, r.unit, r.avg_daily_use, r.days_of_supply]), truncated: false };
    }
    const a = sql`(${from}::date)::timestamp AT TIME ZONE ${TZ}`; const b = sql`(${to}::date + 1)::timestamp AT TIME ZONE ${TZ}`;
    const dep = (col: string) => (scope.all ? sql`TRUE` : sql`${sql.ref(col)} = ANY(${scope.depts}::uuid[])`);
    const pat = sql`p.last_name || ' ' || p.first_name AS patient, p.personal_number, left(p.first_name, 1) || '. ' || left(p.last_name, 1) || '.' AS initials`;
    type Row = { at: Date; ref: string | null; department: string | null; doctor: string | null; detail: string | null; status: string | null; patient: string; personal_number: string | null; initials: string };
    let rows: Row[] = [];
    if (k.drill === 'encounters') {
      const f = k.code === 'enc_outpatient' ? sql`e.type::text = 'outpatient' AND e.visit_kind = 'consultation'` : k.code === 'enc_lab_only' ? sql`e.visit_kind = 'lab'`
        : k.code === 'enc_emergency' ? sql`e.type::text = 'emergency'` : sql`TRUE`;
      rows = (await sql<Row>`
        SELECT e.start_time AS at, NULL AS ref, d.name AS department, u.last_name || ' ' || u.first_name AS doctor, e.type::text || ' / ' || e.visit_kind AS detail, e.status::text AS status, ${pat}
          FROM encounters e JOIN patients p ON p.id = e.patient_id LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN users u ON u.id = e.attending_doctor_id
         WHERE e.start_time >= ${a} AND e.start_time < ${b} AND e.status::text IN ('active', 'discharged') AND ${f} AND ${dep('e.department_id')}
         ORDER BY e.start_time LIMIT ${DRILL_LIMIT + 1}`.execute(this.c.rdb)).rows;
    } else if (k.drill === 'admissions' || k.drill === 'discharges' || k.drill === 'deaths') {
      const adm = k.drill === 'admissions';
      const dsub = adm ? sql`(SELECT ba.department_id FROM bed_assignments ba WHERE ba.encounter_id = st.encounter_id ORDER BY ba.started_at, ba.id LIMIT 1)`
        : sql`(SELECT ba.department_id FROM bed_assignments ba WHERE ba.encounter_id = st.encounter_id ORDER BY ba.started_at DESC, ba.id DESC LIMIT 1)`;
      const at = adm ? sql`st.admitted_at` : sql`st.ended_at`;
      rows = (await sql<Row>`
        WITH x AS (SELECT st.*, coalesce(${dsub}, e.department_id) AS dep, e.attending_doctor_id FROM inpatient_stays st JOIN encounters e ON e.id = st.encounter_id
                    WHERE ${adm ? sql`st.status <> 'cancelled'` : sql`st.status = 'discharged'`} AND ${at} >= ${a} AND ${at} < ${b}
                      ${k.drill === 'deaths' ? sql`AND st.death_at IS NOT NULL` : sql``})
        SELECT ${adm ? sql`x.admitted_at` : sql`x.ended_at`} AS at, x.adm_no AS ref, d.name AS department, u.last_name || ' ' || u.first_name AS doctor,
               ${adm ? sql`x.source` : sql`coalesce(x.discharge_type, '') || ' · ' || greatest(1, (x.ended_at AT TIME ZONE ${TZ})::date - (x.admitted_at AT TIME ZONE ${TZ})::date) || ' დღე'`} AS detail,
               x.status, ${pat}
          FROM x JOIN patients p ON p.id = x.patient_id LEFT JOIN departments d ON d.id = x.dep LEFT JOIN users u ON u.id = x.attending_doctor_id
         WHERE ${dep('x.dep')} ORDER BY 1 LIMIT ${DRILL_LIMIT + 1}`.execute(this.c.rdb)).rows;
    } else if (k.drill === 'or_cases') {
      rows = (await sql<Row>`
        SELECT t.at, c.case_no AS ref, d.name AS department, u.last_name || ' ' || u.first_name AS doctor, coalesce(c.icd10_code, '') || ' · ' || c.urgency AS detail, c.status, ${pat}
          FROM or_cases c JOIN or_case_times t ON t.case_id = c.id AND t.kind = 'in_room' AND t.superseded_by IS NULL JOIN patients p ON p.id = c.patient_id
          LEFT JOIN departments d ON d.id = c.department_id LEFT JOIN users u ON u.id = c.surgeon_id
         WHERE c.status = 'completed' AND t.at >= ${a} AND t.at < ${b} AND ${dep('c.department_id')} ORDER BY t.at LIMIT ${DRILL_LIMIT + 1}`.execute(this.c.rdb)).rows;
    } else {
      const lab = k.drill === 'lab_orders';
      rows = (await sql<Row>`
        SELECT i.ordered_at AS at, i.accession_number AS ref, d.name AS department, u.last_name || ' ' || u.first_name AS doctor, i.section || ' · ' || s.name AS detail, i.status, ${pat}
          FROM dx_order_items i JOIN encounters e ON e.id = i.encounter_id JOIN patients p ON p.id = i.patient_id JOIN dx_services s ON s.id = i.service_id
          LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN users u ON u.id = i.ordered_by
         WHERE i.status <> 'cancelled' AND i.ordered_at >= ${a} AND i.ordered_at < ${b} AND ${lab ? sql`i.section = 'lab'` : sql`i.section <> 'lab'`} AND ${dep('e.department_id')}
         ORDER BY i.ordered_at LIMIT ${DRILL_LIMIT + 1}`.execute(this.c.rdb)).rows;
    }
    const truncated = rows.length > DRILL_LIMIT; rows = rows.slice(0, DRILL_LIMIT);
    if (audit) await this.audit.log(auditCtx(req), { action: 'REPORT_DRILLDOWN', entityName: 'rpt_kpis', entityId: k.code,
      newData: { from, to, department_id: q.department_id ?? null, rows: rows.length, phi: scope.phi } });
    const columns = ['დრო', '№', 'განყოფილება', 'ექიმი', 'დეტალი', 'სტატუსი', 'პაციენტი', ...(scope.phi ? ['პირადი №'] : [])];
    const fmt = (d: Date) => new Date(d).toLocaleString('sv-SE', { timeZone: TZ }).slice(0, 16);
    return { kpi: k.code, kind: k.drill, phi: scope.phi, columns, truncated,
      rows: rows.map((r) => [fmt(r.at), r.ref, r.department, r.doctor, r.detail, r.status, scope.phi ? r.patient : r.initials, ...(scope.phi ? [r.personal_number] : [])]) };
  }

  // ------------------------------------------------------------------------------------------ ექსპორტი
  async export(u: AuthUser, q: Q, req: Request) {
    const format = q.format ?? 'xlsx';
    if (!['xlsx', 'csv'].includes(format)) throw new BadRequestException('format: xlsx / csv');
    const ds = q.dataset ?? '';
    let title = ''; let header: string[] = []; let rows: Cell[][] = []; let phi = false;
    const num = (v: number | null) => (v === null ? null : v);
    if (ds === 'overview') {
      const o = await this.overview(u, q);
      title = `KPI მიმოხილვა ${o.from} — ${o.to}`;
      header = ['კოდი', 'ჯგუფი', 'მაჩვენებელი', 'ერთეული', 'მნიშვნელობა', ...(o.compare ? [`შედარება (${o.compare.from} — ${o.compare.to})`, 'ცვლილება %'] : []), 'სამიზნე', 'სტატუსი', 'ფორმულა', 'წყარო'];
      rows = o.kpis.map((x) => [x.code, x.category, x.name, x.unit_ka, num(x.value), ...(o.compare ? [num(x.compare_value), num(x.change_pct)] : []), num(x.target), x.status_ka, x.formula, x.source]);
    } else if (ds === 'series') {
      const o = await this.series(u, q);
      title = `${o.name} (${o.grain}) ${o.from} — ${o.to}`; header = ['პერიოდი', 'დან', 'მდე', `${o.name}${o.unit_ka ? `, ${o.unit_ka}` : ''}`];
      rows = o.points.map((p) => [p.period, p.from, p.to, num(p.value)]);
    } else if (ds === 'by_department') {
      const o = await this.byDepartment(u, q);
      title = `${o.name} განყოფილებებით ${o.from} — ${o.to}`; header = ['განყოფილება', `${o.name}${o.unit_ka ? `, ${o.unit_ka}` : ''}`, 'სტატუსი'];
      rows = [...o.rows.map((r) => [r.department_name, num(r.value), r.status ? STATUS_KA[r.status] : null] as Cell[]), ['სულ', num(o.total), null]];
    } else if (ds === 'stock_days') {
      const o = await this.stockDays(u, q);
      title = `მარაგის დღეები (ხარჯი — ბოლო ${o.window_days} დღე)`;
      header = ['ლოკაცია', 'განყოფილება', 'კოდი', 'დასახელება', 'ერთეული', 'ნაშთი', 'ღირებულება', 'საშ. დღიური ხარჯი', 'დღე', '90 დღეში ვადა (₾)', 'ვადაგასული (₾)'];
      rows = o.rows.map((r) => [r.location_name, r.department_name, r.item_code, r.item_name, r.unit, r.qty, r.value, r.avg_daily_use, r.days_of_supply, r.expiring_value_90, r.expired_value]);
    } else if (ds === 'drilldown') {
      const o = await this.drilldown(u, q, req, false);
      title = `ჩაღრმავება: ${o.kpi} ${q.from} — ${q.to}`; header = o.columns; rows = o.rows as Cell[][]; phi = o.phi;
    } else throw new BadRequestException('dataset: overview / series / by_department / stock_days / drilldown');
    await this.audit.log(auditCtx(req), { action: 'REPORT_EXPORT', entityName: 'rpt_reports', entityId: ds,
      newData: { format, kpi: q.kpi ?? null, from: q.from ?? null, to: q.to ?? null, department_id: q.department_id ?? null, rows: rows.length, phi } });
    const base = `rpt_${ds}${q.kpi ? `_${q.kpi}` : ''}${q.from ? `_${q.from}_${q.to}` : ''}`;
    if (format === 'csv') return { name: `${base}.csv`, type: 'text/csv; charset=utf-8', body: Buffer.from(toCsv(header, rows.map((r) => r.map((c) => (typeof c === 'object' && c !== null ? c.v : c))), title), 'utf8') };
    const widths = header.map((h, i) => Math.min(60, Math.max(10, h.length + 2, ...rows.slice(0, 200).map((r) => String((r[i] as string | number | null) ?? '').length + 2))));
    return { name: `${base}.xlsx`, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      body: writeXlsx({ name: ds.slice(0, 31), header, rows: rows.map((r) => r.map((c) => (typeof c === 'number' ? { v: c, fmt: Number.isInteger(c) ? '0' : '0.00' } : c))), widths }) };
  }
}

// ============================================================================================== ადმინისტრირება
class KpiPatchDto {
  @IsOptional() @IsString() @Length(2, 200) name?: string;
  @IsOptional() @IsString() @Length(5, 2000) definition?: string;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(9999) sort_order?: number;
  @IsString() @Length(3, 500) reason: string;
}
class TargetDto {
  @IsOptional() @IsUUID() department_id?: string | null;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(-1e9) @Max(1e12) target: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(-1e9) @Max(1e12) warn?: number | null;
  @IsOptional() @IsString() @MaxLength(300) note?: string | null;
}
class TargetsDto {
  @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => TargetDto) targets: TargetDto[];
  @IsString() @Length(3, 500) reason: string;
}
class ScopeDto {
  @IsArray() @ArrayMaxSize(100) @IsUUID('all', { each: true }) department_ids: string[];
  @IsString() @Length(3, 500) reason: string;
}
class RefreshDto {
  @Matches(DATE_RE) from: string;
  @Matches(DATE_RE) to: string;
}

@Injectable()
export class ReportingAdminService {
  constructor(private readonly c: RptCommon, private readonly r: RptRefreshService, private readonly audit: AuditService) {}

  async kpiList() {
    const [kpis, targets, deps] = await Promise.all([
      this.c.db.selectFrom('rpt_kpis').selectAll().orderBy('sort_order').orderBy('code').execute(),
      this.c.db.selectFrom('rpt_kpi_targets').selectAll().execute(),
      this.c.db.selectFrom('departments').select(['id', 'name']).execute()]);
    return kpis.map((k) => ({ ...k, unit_ka: UNIT_KA[k.unit],
      targets: targets.filter((t) => t.kpi_code === k.code).map((t) => ({ department_id: t.department_id, department_name: deps.find((d) => d.id === t.department_id)?.name ?? null,
        target: n(t.target), warn: t.warn === null ? null : n(t.warn), note: t.note })).sort((a, b) => (a.department_id ? 1 : 0) - (b.department_id ? 1 : 0)) }));
  }

  async kpiPatch(code: string, d: KpiPatchDto, u: AuthUser, req: Request) {
    const old = await this.c.db.selectFrom('rpt_kpis').selectAll().where('code', '=', code).executeTakeFirst();
    if (!old) throw new NotFoundException('KPI ვერ მოიძებნა');
    const set = { ...(d.name !== undefined && { name: d.name.trim() }), ...(d.definition !== undefined && { definition: d.definition.trim() }),
      ...(d.is_active !== undefined && { is_active: d.is_active }), ...(d.sort_order !== undefined && { sort_order: d.sort_order }) };
    if (!Object.keys(set).length) throw new BadRequestException('ცვლილება არ არის');
    await this.c.db.transaction().execute(async (trx) => {
      await trx.updateTable('rpt_kpis').set({ ...set, updated_by: u.id }).where('code', '=', code).execute();
      await this.audit.log(auditCtx(req), { action: 'RPT_KPI_UPDATE', entityName: 'rpt_kpis', entityId: code,
        oldData: Object.fromEntries(Object.keys(set).map((k) => [k, old[k as keyof typeof old]])), newData: { ...set, reason: d.reason } }, trx);
    });
    return (await this.kpiList()).find((k) => k.code === code);
  }

  /** სამიზნეები მთლიანად იცვლება (კლინიკა + განყოფილებები) */
  async kpiTargets(code: string, d: TargetsDto, u: AuthUser, req: Request) {
    const k = await this.c.db.selectFrom('rpt_kpis').select(['code', 'direction']).where('code', '=', code).executeTakeFirst();
    if (!k) throw new NotFoundException('KPI ვერ მოიძებნა');
    if (k.direction === 'none' && d.targets.length) throw new BadRequestException('მაჩვენებელს მიმართულება არ აქვს (direction = none) — სამიზნე ვერ მიეთითება');
    const keys = d.targets.map((t) => t.department_id ?? '-');
    if (new Set(keys).size !== keys.length) throw new BadRequestException('ერთ განყოფილებაზე (ან კლინიკაზე) — ერთი სამიზნე');
    for (const t of d.targets) {
      if (t.warn === undefined || t.warn === null) continue;
      if (k.direction === 'up' ? t.warn > t.target : t.warn < t.target)
        throw new BadRequestException(`გაფრთხილების ზღვარი სამიზნის ${k.direction === 'up' ? 'ქვემოთ' : 'ზემოთ'} უნდა იყოს (მიმართულება: ${k.direction === 'up' ? '↑' : '↓'})`);
    }
    const ids = d.targets.map((t) => t.department_id).filter((x): x is string => !!x);
    if (ids.length) {
      const found = await this.c.db.selectFrom('departments').select('id').where('id', 'in', ids).execute();
      if (found.length !== new Set(ids).size) throw new BadRequestException('განყოფილება ვერ მოიძებნა');
    }
    const old = await this.c.db.selectFrom('rpt_kpi_targets').select(['department_id', 'target', 'warn']).where('kpi_code', '=', code).execute();
    await this.c.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('rpt_kpi_targets').where('kpi_code', '=', code).execute();
      if (d.targets.length) await trx.insertInto('rpt_kpi_targets').values(d.targets.map((t) => ({ kpi_code: code, department_id: t.department_id ?? null, target: t.target,
        warn: t.warn ?? null, note: t.note ?? null, updated_by: u.id }))).execute();
      await this.audit.log(auditCtx(req), { action: 'RPT_KPI_TARGETS', entityName: 'rpt_kpis', entityId: code, oldData: old, newData: { targets: d.targets, reason: d.reason } }, trx);
    });
    return (await this.kpiList()).find((x) => x.code === code);
  }

  /** ხედვის არე: მომხმარებლები, ვისაც დაფა ეხება (reports / manager — განყოფილებით; reports_all / viewer / admin — კლინიკა) */
  async scopes() {
    const users = (await sql<{ id: string; name: string; email: string; department_id: string | null; department_name: string | null; caps: string[] }>`
      SELECT u.id, u.last_name || ' ' || u.first_name AS name, u.email, u.department_id, d.name AS department_name, coalesce(c.capabilities, '{}') AS caps
        FROM users u JOIN user_capabilities c ON c.user_id = u.id LEFT JOIN departments d ON d.id = u.department_id
       WHERE u.is_active AND c.capabilities && ARRAY['reports', 'reports_all', 'manager', 'viewer', 'admin']::varchar[]
       ORDER BY u.last_name, u.first_name`.execute(this.c.db)).rows;
    const sc = await this.c.db.selectFrom('rpt_user_scopes as s').innerJoin('departments as d', 'd.id', 's.department_id').select(['s.user_id', 's.department_id', 'd.name']).execute();
    return users.map((u) => {
      const all = u.caps.some((x) => ['reports_all', 'viewer', 'admin'].includes(x));
      const extra = sc.filter((s) => s.user_id === u.id).map((s) => ({ id: s.department_id, name: s.name }));
      return { id: u.id, name: u.name, email: u.email, all, phi: u.caps.some((x) => ['reports_phi', 'admin', 'doctor', 'nurse'].includes(x)),
        primary_department: u.department_id ? { id: u.department_id, name: u.department_name } : null, departments: extra,
        effective: all ? null : [...new Map([...(u.department_id ? [{ id: u.department_id, name: u.department_name! }] : []), ...extra].map((x) => [x.id, x])).values()] };
    });
  }

  async putScope(userId: string, d: ScopeDto, u: AuthUser, req: Request) {
    const usr = await this.c.db.selectFrom('users').select(['id']).where('id', '=', userId).executeTakeFirst();
    if (!usr) throw new NotFoundException('მომხმარებელი ვერ მოიძებნა');
    const ids = [...new Set(d.department_ids)];
    if (ids.length) {
      const found = await this.c.db.selectFrom('departments').select('id').where('id', 'in', ids).execute();
      if (found.length !== ids.length) throw new BadRequestException('განყოფილება ვერ მოიძებნა');
    }
    const old = (await this.c.db.selectFrom('rpt_user_scopes').select('department_id').where('user_id', '=', userId).execute()).map((x) => x.department_id);
    await this.c.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('rpt_user_scopes').where('user_id', '=', userId).execute();
      if (ids.length) await trx.insertInto('rpt_user_scopes').values(ids.map((x) => ({ user_id: userId, department_id: x, created_by: u.id }))).execute();
      await this.audit.log(auditCtx(req), { action: 'RPT_SCOPE_UPDATE', entityName: 'users', entityId: userId, oldData: { department_ids: old }, newData: { department_ids: ids, reason: d.reason } }, trx);
    });
    return (await this.scopes()).find((x) => x.id === userId) ?? { id: userId, departments: ids };
  }

  async runs(limit?: string) {
    const l = Math.min(200, Math.max(1, Number(limit) || 30));
    const rows = await this.c.db.selectFrom('rpt_refresh_runs as r').leftJoin('users as u', 'u.id', 'r.requested_by')
      .select(['r.id', 'r.kind', 'r.date_from', 'r.date_to', 'r.status', 'r.facts', 'r.error', 'r.source', 'r.started_at', 'r.finished_at', 'r.duration_ms',
        sql<string | null>`u.last_name || ' ' || u.first_name`.as('requested_by')]).orderBy('r.id', 'desc').limit(l).execute();
    return { running: await this.r.running() ?? null, rows };
  }

  /** ხელით გადათვლა: ფონურად (202); მიმდინარე გადათვლისას — 409 */
  async refresh(d: RefreshDto, u: AuthUser, req: Request) {
    await this.c.settings();
    if (d.from > d.to) throw new BadRequestException('from ≤ to');
    const today = await this.c.today();
    if (d.to > today) throw new BadRequestException('მომავალი თარიღი გადათვლაში არ შედის');
    if (daysBetween(d.from, d.to) > 400) throw new BadRequestException('პერიოდი — მაქსიმუმ 400 დღე (გრძელი ისტორია — რამდენიმე გადათვლით)');
    const cur = await this.r.running();
    if (cur) throw new ConflictException({ code: 'REFRESH_RUNNING', message: `გადათვლა უკვე მიმდინარეობს (#${cur.id})`, run_id: Number(cur.id) });
    const id = await this.r.createRun('manual', d.from, d.to, u.id);
    await this.audit.log(auditCtx(req), { action: 'REPORT_REFRESH', entityName: 'rpt_refresh_runs', entityId: String(id), newData: d });
    void this.r.execute(id);
    return { run_id: id, status: 'running' };
  }

  async run(id: number) {
    const r = await this.c.db.selectFrom('rpt_refresh_runs').selectAll().where('id', '=', String(id)).executeTakeFirst();
    if (!r) throw new NotFoundException('ჩანაწერი ვერ მოიძებნა');
    return r;
  }
}

// ============================================================================================== კონტროლერი
@Controller('reporting')
export class ReportingController {
  constructor(private readonly s: ReportingService, private readonly a: ReportingAdminService) {}

  @Get('meta') @Roles(...RPT_READ) meta(@CurrentUser() u: AuthUser) { return this.s.meta(u); }
  @Get('overview') @Roles(...RPT_READ) overview(@Query() q: Q, @CurrentUser() u: AuthUser) { return this.s.overview(u, q); }
  @Get('series') @Roles(...RPT_READ) series(@Query() q: Q, @CurrentUser() u: AuthUser) { return this.s.series(u, q); }
  @Get('by-department') @Roles(...RPT_READ) byDepartment(@Query() q: Q, @CurrentUser() u: AuthUser) { return this.s.byDepartment(u, q); }
  @Get('stock-days') @Roles(...RPT_READ) stockDays(@Query() q: Q, @CurrentUser() u: AuthUser) { return this.s.stockDays(u, q); }
  @Get('drilldown') @Roles(...RPT_READ) drilldown(@Query() q: Q, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.drilldown(u, q, r); }
  @Get('export') @Roles(...RPT_READ)
  async export(@Query() q: Q, @CurrentUser() u: AuthUser, @Req() r: Request, @Res({ passthrough: true }) res: Response) {
    const out = await this.s.export(u, q, r);
    res.set({ 'Content-Type': out.type, 'Content-Disposition': `attachment; filename="${encodeURIComponent(out.name)}"` });
    return new StreamableFile(out.body);
  }

  // ადმინისტრირება
  @Get('kpis') @Roles(...RPT_CONFIG) kpis() { return this.a.kpiList(); }
  @Patch('kpis/:code') @Roles(...RPT_CONFIG) kpiPatch(@Param('code') code: string, @Body() d: KpiPatchDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.a.kpiPatch(code, d, u, r); }
  @Put('kpis/:code/targets') @Roles(...RPT_CONFIG) kpiTargets(@Param('code') code: string, @Body() d: TargetsDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.a.kpiTargets(code, d, u, r); }
  @Get('scopes') @Roles('admin') scopes() { return this.a.scopes(); }
  @Put('scopes/:userId') @Roles('admin') putScope(@Param('userId', ParseUUIDPipe) id: string, @Body() d: ScopeDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.a.putScope(id, d, u, r); }
  @Get('runs') @Roles('admin', 'reports_all') runs(@Query('limit') limit?: string) { return this.a.runs(limit); }
  @Get('runs/:id') @Roles('admin', 'reports_all') run(@Param('id') id: string) { if (!/^\d+$/.test(id)) throw new ForbiddenException(); return this.a.run(Number(id)); }
  @Post('refresh') @HttpCode(202) @Roles('admin') refresh(@Body() d: RefreshDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.a.refresh(d, u, r); }
}

