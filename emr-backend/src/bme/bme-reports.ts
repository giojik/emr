import { BadRequestException, Controller, ForbiddenException, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Query, Req, Res, StreamableFile } from '@nestjs/common';
import type { Request, Response } from 'express';
import { sql } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser, type Role } from '../auth/roles';
import { writeXlsxBook, type Cell, type SheetSpec } from '../claims-export/xlsx';
import { InjectDb, type Database } from '../database/database.module';
import { CRIT_KA, CRITICALITY, GROUPS, STATUS_KA, viewScope, type BmeStatus, type Criticality } from './bme-common';
import { TZ } from './bme-pm-common';
import {
  ACC_KEYS, aggregate, bmeKpis, bmeRptRules, costRows, costTotal, hoursRows, loadRaw, makeWin, zeroAcc,
  type Acc, type Filt, type PmRow, type Raw, type RepRow, type RptRules, type Win,
} from './bme-reports-core';
import { CONDITION_KA, CONTRACT_KA, OUTCOME_KA, REJECT_KA, REP_STATUS_KA, type ContractKind, type RepStatus } from './bme-repair-common';

/**
 * ბიომედ-აპარატურა, ეტაპი 4 (0076) — ანგარიშები / KPI:
 *  შეჯამება + 13-თვიანი ტრენდი, ხელმისაწვდომობა, MTBF / MTTR, SLA (პრიორიტეტი, შიდა / გარე, სამიზნის წყარო, მომწოდებელი), კონტრაქტების შესრულება
 *  (uptime %, PM ვიზიტები), ხარჯი / TCO / COSR, PM ვადაში, მიზეზები (Pareto, მომხმარებლის შეცდომა, NFF); Excel ექსპორტი; აპარატის KPI (12 თვე).
 * ხედვა: ინჟინერი / ნახვა / მენეჯერი / ბუღალტერია — მთელი კლინიკა; bme_dept — თავისი განყოფილებები (ხარჯის გარეშე). ხარჯი — ინჟინერი, მენეჯერი, ბუღალტერია, admin.
 */
export const BME_RPT: Role[] = ['admin', 'med_engineer', 'bme_view', 'manager', 'viewer', 'accountant', 'bme_dept'];
const BME_RPT_ALL: Role[] = ['admin', 'med_engineer', 'bme_view', 'manager', 'viewer', 'accountant'];
export const BME_RPT_COST: Role[] = ['admin', 'med_engineer', 'manager', 'accountant'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f-]{36}$/i;
const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const pct = (a: number, b: number) => (b > 0 ? r1((a / b) * 100) : null);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const daysIncl = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000) + 1;
const GRP_KA: Record<string, string> = { imaging: 'გამოსახულება', life_support: 'სიცოცხლის შემანარჩუნებელი', monitoring: 'მონიტორინგი', therapy: 'თერაპია', surgical: 'ქირურგია',
  lab: 'ლაბორატორია', sterilization: 'სტერილიზაცია', endoscopy: 'ენდოსკოპია', measuring: 'საზომი', other: 'სხვა' };
const PERF_KA: Record<string, string> = { internal: 'შიდა', ext_param: 'გარე — სამიზნე პარამეტრით', ext_contract: 'გარე — კონტრაქტით' };

interface Q {
  from?: string; to?: string; department_id?: string; type_id?: string; grp?: string; criticality?: string; supplier_id?: string; performer?: string;
  device_ids?: string; at?: string; trend?: string;
}
interface Dev { id: string; inv_no: string; name: string; type_id: string; type_name: string; grp: string; criticality: string; status: string; department_id: string | null;
  department_name: string | null; purchase_value: number | null; install_date: string | null; manufacturer: string | null; model: string | null }

@Injectable()
export class BmeReportService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService) {}

  private async rules() {
    const s = await bmeRptRules(this.db);
    if (!s) throw new ForbiddenException({ code: 'MODULE_DISABLED', message: 'მოდული „ბიომედ-აპარატურა“ გამორთულია (ადმინისტრირება → მოდულები)' });
    return s;
  }

  /** ხედვის არე: null — მთელი კლინიკა; სხვა — განყოფილებები */
  private async scope(u: AuthUser) {
    if (!has(u, ...BME_RPT)) throw new ForbiddenException('ანგარიშებზე წვდომა არ გაქვთ');
    const depts = has(u, ...BME_RPT_ALL) ? null : (await viewScope(this.db, u) as { depts: string[] }).depts;
    return { depts, cost: has(u, ...BME_RPT_COST) };
  }

  private async params(u: AuthUser, q: Q) {
    const s = await this.rules();
    const sc = await this.scope(u);
    if (!q.from || !q.to || !DATE.test(q.from) || !DATE.test(q.to) || q.from > q.to) throw new BadRequestException({ code: 'RANGE', message: 'from / to (YYYY-MM-DD)' });
    if (daysIncl(q.from, q.to) > 731) throw new BadRequestException({ code: 'RANGE', message: 'პერიოდი — მაქსიმუმ 2 წელი' });
    for (const k of ['department_id', 'type_id', 'supplier_id'] as const) if (q[k] && !UUID.test(q[k]!)) throw new BadRequestException(k);
    if (q.grp && !(GROUPS as readonly string[]).includes(q.grp)) throw new BadRequestException('grp');
    if (q.criticality && !(CRITICALITY as readonly string[]).includes(q.criticality)) throw new BadRequestException('criticality');
    if (q.performer && !['internal', 'external'].includes(q.performer)) throw new BadRequestException('performer: internal / external');
    const devIds = q.device_ids ? q.device_ids.split(',').map((x) => x.trim()).filter(Boolean) : null;
    if (devIds && (devIds.length > 500 || devIds.some((x) => !UUID.test(x)))) throw new BadRequestException('device_ids');
    // at — „ახლა“-ს ჩანაცვლება (მხოლოდ admin; ტესტი / რეტროსპექტივა)
    let at: string | null = null;
    if (q.at) {
      if (!has(u, 'admin')) throw new ForbiddenException('at — მხოლოდ ადმინისტრატორი');
      if (Number.isNaN(Date.parse(q.at))) throw new BadRequestException('at');
      at = new Date(q.at).toISOString();
    }
    if (q.department_id && sc.depts && !sc.depts.includes(q.department_id)) throw new ForbiddenException({ code: 'OUT_OF_SCOPE', message: 'განყოფილება თქვენს ხედვის არეში არ არის' });
    const depts = q.department_id ? [q.department_id] : sc.depts;
    const f: Filt = { depts, device_ids: devIds, type_id: q.type_id || null, grp: q.grp || null, criticality: q.criticality || null, supplier_id: q.supplier_id || null,
      performer: (q.performer as 'internal' | 'external') || null };
    const w = await makeWin(this.db, q.from, q.to, at);
    return { s, f, w, cost: sc.cost, scopeDepts: sc.depts };
  }

  private async devices(f: Filt): Promise<Map<string, Dev>> {
    let x = this.db.selectFrom('bme_devices as b').innerJoin('bme_device_types as t', 't.id', 'b.type_id').leftJoin('departments as d', 'd.id', 'b.department_id')
      .select(['b.id', 'b.inv_no', 'b.name', 'b.type_id', 't.name as type_name', 't.grp', 'b.criticality', 'b.status', 'b.department_id', 'd.name as department_name',
        sql<number | null>`b.purchase_value::float8`.as('purchase_value'), sql<string | null>`to_char(b.install_date, 'YYYY-MM-DD')`.as('install_date'), 'b.manufacturer', 'b.model']);
    if (f.device_ids) x = x.where('b.id', 'in', f.device_ids.length ? f.device_ids : ['00000000-0000-0000-0000-000000000000']);
    if (f.type_id) x = x.where('b.type_id', '=', f.type_id);
    if (f.grp) x = x.where('t.grp', '=', f.grp);
    if (f.criticality) x = x.where('b.criticality', '=', f.criticality);
    return new Map((await x.execute()).map((d) => [d.id, d as Dev]));
  }
  private async deptNames() {
    return new Map((await this.db.selectFrom('departments').select(['id', 'name']).execute()).map((d) => [d.id, d.name]));
  }

  async meta(u: AuthUser) {
    const s = await this.rules();
    const sc = await this.scope(u);
    const [types, suppliers, depts] = await Promise.all([
      this.db.selectFrom('bme_device_types').select(['id', 'code', 'name', 'grp']).where('is_active', '=', true).orderBy('sort_order').execute(),
      this.db.selectFrom('stock_suppliers as s').select(['s.id', 's.name'])
        .where((eb) => eb.or([eb.exists(eb.selectFrom('bme_devices as b').select('b.id').whereRef('b.supplier_id', '=', 's.id')),
          eb.exists(eb.selectFrom('bme_contracts as c').select('c.id').whereRef('c.supplier_id', '=', 's.id')),
          eb.exists(eb.selectFrom('bme_repairs as r').select('r.id').whereRef('r.supplier_id', '=', 's.id'))])).orderBy('s.name').execute(),
      this.db.selectFrom('departments').select(['id', 'name']).where('is_active', '=', true)
        .$if(!!sc.depts, (q) => q.where('id', 'in', sc.depts!.length ? sc.depts! : ['00000000-0000-0000-0000-000000000000'])).orderBy('name').execute(),
    ]);
    const today = (await sql<{ d: string }>`SELECT to_char((now() AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS d`.execute(this.db)).rows[0].d;
    return { today, can_cost: sc.cost, all_departments: !sc.depts, departments: depts, types, suppliers, groups: GROUPS.map((g) => ({ code: g, name: GRP_KA[g] })),
      criticality: CRITICALITY.map((c) => ({ code: c, name: CRIT_KA[c] })), settings: s };
  }

  // ============================================================================================ შეჯამება
  async summary(u: AuthUser, q: Q, withDetail = false) {
    const { s, f, w, cost } = await this.params(u, q);
    const [raw, devs, names] = await Promise.all([loadRaw(this.db, w, f, 'device', s), this.devices(f), this.deptNames()]);
    const days = Math.max(0, daysIncl(w.from, w.dTo));
    const total = aggregate(raw, f, () => 'all', null).get('all') ?? zeroAcc();
    const kpi = bmeKpis(total, s);
    const hide = (x: Record<string, unknown>) => { if (!cost) for (const k of Object.keys(x)) if (k.startsWith('cost') || k === 'bme_service_cost') delete x[k]; return x; };

    // ჭრილები
    const devOf = (id: string | null) => (id ? devs.get(id) : undefined);
    const devCount = (fn: (d: Dev | undefined, dept: string | null) => string | null) => {
      const m = new Map<string, Set<string>>();
      for (const h of raw.hours) { const k = fn(devOf(h.device_id), h.department_id); if (k === null || !h.device_id) continue; (m.get(k) ?? m.set(k, new Set()).get(k)!).add(h.device_id); }
      return m;
    };
    const group = (fn: (d: Dev | undefined, dept: string | null) => string | null) => {
      const agg = aggregate(raw, f, (x) => fn(devOf(x.device_id), x.dept), null);
      const cnt = devCount(fn);
      return [...agg.entries()].map(([k, a]) => ({ key: k, devices: cnt.get(k)?.size ?? 0, ...round(a), ...bmeKpis(a, s) }));
    };
    const byDept = group((_d, dept) => dept ?? '').map((x) => ({ ...x, department_id: x.key || null, name: x.key ? names.get(x.key) ?? '—' : 'განყოფილების გარეშე' }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ka'));
    const byType = group((d) => d?.type_id ?? null).map((x) => { const t = [...devs.values()].find((d) => d.type_id === x.key); return { ...x, type_id: x.key, name: t?.type_name ?? '—', grp: t?.grp ?? null }; })
      .sort((a, b) => a.name.localeCompare(b.name, 'ka'));
    const byCrit = group((d) => d?.criticality ?? null).map((x) => ({ ...x, criticality: x.key, name: CRIT_KA[x.key as Criticality] ?? x.key }))
      .sort((a, b) => CRITICALITY.indexOf(a.key as Criticality) - CRITICALITY.indexOf(b.key as Criticality));
    const byDevice = group((d) => d?.id ?? null).map((x) => { const d = devs.get(x.key)!; return { ...x, device_id: x.key, inv_no: d?.inv_no, name: d?.name, type_name: d?.type_name,
      criticality: d?.criticality, status: d?.status, department_name: d?.department_name, purchase_value: d?.purchase_value ?? null }; });

    const availability = {
      by_dept: byDept.map(pickAvail), by_type: byType.map(pickAvail), by_criticality: byCrit.map(pickAvail),
      worst: byDevice.filter((x) => x.avail_h > 0 && x.bme_availability_pct !== null).sort((a, b) => a.bme_availability_pct! - b.bme_availability_pct! || b.down_h - a.down_h).slice(0, 10).map(pickAvail),
    };
    const reliability = {
      by_type: byType.map(pickRel), by_dept: byDept.map(pickRel),
      devices: byDevice.filter((x) => x.failures > 0).sort((a, b) => b.failures - a.failures || (a.bme_mtbf_d ?? 0) - (b.bme_mtbf_d ?? 0)).slice(0, 20).map(pickRel),
    };
    const sla = this.slaSection(raw, f);
    const pm = this.pmSection(raw.pm, devs, names);
    const causes = this.causeSection(raw, f, devs);
    const contracts = await this.contractSection(w, f, s, cost);
    const costs = cost ? await this.costSection(w, f, s, byDept, byType, byDevice, devs, days) : null;
    const trend = q.trend === '0' ? null : await this.trend(w, f, s, cost);
    const scopeLabel = q.department_id ? names.get(q.department_id) ?? '—' : f.depts ? 'თქვენი განყოფილებები' : 'მთელი კლინიკა';
    const out = {
      from: w.from, to: w.to, to_effective: w.dTo, at_day: w.atDay, days, scope_label: scopeLabel, can_cost: cost,
      settings: { rpt_restricted_weight: s.rpt_restricted_weight, rpt_mtbf_exclude_user_error: s.rpt_mtbf_exclude_user_error, rpt_contract_alloc: s.rpt_contract_alloc,
        rpt_cosr_warn_pct: s.rpt_cosr_warn_pct, rpt_pm_grace_days: s.rpt_pm_grace_days },
      devices: devCount(() => 'all').get('all')?.size ?? 0,
      kpi: hide({ ...kpi }), totals: hide(round(total)), trend, availability, reliability, sla, contracts, costs, pm, causes,
      ...(withDetail && { detail: { devices: byDevice.map((x) => hide({ ...x })), repairs: raw.repairs, pm: raw.pm, periods: await this.periods(w, f, names) } }),
    };
    return out;
  }

  /** SLA: პრიორიტეტი, შემსრულებელი / სამიზნის წყარო, მომწოდებელი; ლოდინი */
  private slaSection(raw: Raw, f: Filt) {
    const coh = raw.repairs.filter((r) => r.in_rep && (!f.depts || (!!r.dept_rep && f.depts.includes(r.dept_rep))) && !['rejected', 'duplicate'].includes(r.status) && r.priority);
    const bucket = () => ({ n: 0, resp_n: 0, resp_met: 0, resp_breached: 0, rest_n: 0, rest_met: 0, rest_breached: 0, in_progress: 0, resp_h: 0, resp_cnt: 0, wait_h: 0, breached_wait: 0 });
    type B = ReturnType<typeof bucket>;
    const add = (b: B, r: RepRow) => {
      b.n++;
      if (r.resp_state === 'met') { b.resp_n++; b.resp_met++; } else if (r.resp_state === 'breached') { b.resp_n++; b.resp_breached++; }
      if (r.rest_state === 'met') { b.rest_n++; b.rest_met++; } else if (r.rest_state === 'breached') { b.rest_n++; b.rest_breached++; }
      if (r.rest_state === 'ok' || r.rest_state === 'warn') b.in_progress++;
      if (r.resp_h !== null && r.resp_h !== undefined) { b.resp_h += Number(r.resp_h); b.resp_cnt++; }
      b.wait_h += Number(r.wait_h || 0);
      if (r.rest_state === 'breached' && Number(r.wait_h) > 0) b.breached_wait++;
    };
    const fin = (b: B) => ({ n: b.n, resp_n: b.resp_n, resp_met: b.resp_met, resp_breached: b.resp_breached, resp_pct: pct(b.resp_met, b.resp_n),
      rest_n: b.rest_n, rest_met: b.rest_met, rest_breached: b.rest_breached, rest_pct: pct(b.rest_met, b.rest_n), in_progress: b.in_progress,
      resp_avg_h: b.resp_cnt ? r1(b.resp_h / b.resp_cnt) : null, wait_h: r1(b.wait_h), breached_with_wait: b.breached_wait });
    const by = (fn: (r: RepRow) => string) => { const m = new Map<string, B>(); for (const r of coh) { const k = fn(r); add(m.get(k) ?? m.set(k, bucket()).get(k)!, r); } return m; };
    const mode = (r: RepRow) => (r.performer_kind !== 'external' ? 'internal' : r.contract_id ? 'ext_contract' : 'ext_param');
    const all = bucket(); for (const r of coh) add(all, r);
    return {
      total: fin(all),
      by_priority: [1, 2, 3, 4].map((p) => ({ priority: p, ...fin(by((r) => String(r.priority)).get(String(p)) ?? bucket()) })),
      by_mode: ['internal', 'ext_param', 'ext_contract'].map((k) => ({ mode: k, name: PERF_KA[k], ...fin(by(mode).get(k) ?? bucket()) })),
      by_supplier: [...by((r) => (r.performer_kind === 'external' ? r.supplier_id ?? `~${r.supplier_name ?? ''}` : '')).entries()].filter(([k]) => k)
        .map(([k, b]) => ({ supplier_id: k.startsWith('~') ? null : k, name: coh.find((r) => (r.supplier_id ?? `~${r.supplier_name ?? ''}`) === k)?.supplier_name ?? 'გარე (მომწოდებლის გარეშე)', ...fin(b) }))
        .sort((a, b) => b.n - a.n),
    };
  }

  /** PM ვადაში: სახე, კრიტიკულობა, განყოფილება, შემსრულებელი; ვადაგადაცილებული სია */
  private pmSection(rows: PmRow[], devs: Map<string, Dev>, names: Map<string, string>) {
    const b = () => ({ due: 0, ontime: 0, late: 0, open: 0, fail: 0 });
    const by = (fn: (p: PmRow) => string) => {
      const m = new Map<string, ReturnType<typeof b>>();
      for (const p of rows) { const k = fn(p); const x = m.get(k) ?? m.set(k, b()).get(k)!; x.due++; if (p.ontime) x.ontime++; else if (p.status === 'done') x.late++; else x.open++; if (p.result === 'fail') x.fail++; }
      return [...m.entries()].map(([k, x]) => ({ key: k, ...x, ontime_pct: pct(x.ontime, x.due) }));
    };
    const all = by(() => 'all')[0] ?? { key: 'all', ...b(), ontime_pct: null };
    return {
      total: all,
      by_kind: by((p) => p.kind_code).map((x) => ({ ...x, name: rows.find((p) => p.kind_code === x.key)?.kind_name ?? x.key })),
      by_criticality: by((p) => devs.get(p.device_id)?.criticality ?? 'medium').map((x) => ({ ...x, name: CRIT_KA[x.key as Criticality] ?? x.key }))
        .sort((a, b2) => CRITICALITY.indexOf(a.key as Criticality) - CRITICALITY.indexOf(b2.key as Criticality)),
      by_dept: by((p) => p.dept ?? '').map((x) => ({ ...x, name: x.key ? names.get(x.key) ?? '—' : 'განყოფილების გარეშე' })).sort((a, b2) => a.name.localeCompare(b2.name, 'ka')),
      by_performer: by((p) => p.performer_kind ?? 'none').map((x) => ({ ...x, name: x.key === 'internal' ? 'შიდა' : x.key === 'external' ? 'გარე' : 'სამუშაო არ შექმნილა' })),
      overdue: rows.filter((p) => p.status !== 'done').sort((a, b2) => (b2.overdue_days ?? 0) - (a.overdue_days ?? 0)).slice(0, 200).map((p) => {
        const d = devs.get(p.device_id);
        return { work_id: p.id, work_no: p.work_no, device_id: p.device_id, inv_no: d?.inv_no, name: d?.name, criticality: d?.criticality, kind: p.kind_name, due: p.due,
          overdue_days: p.overdue_days, status: p.status, department: p.dept ? names.get(p.dept) ?? '—' : null };
      }),
    };
  }

  /** მიზეზები: Pareto (მიზეზი / ქმედება), მომხმარებლის შეცდომა ტიპებით, NFF, მიზეზის გარეშე */
  private causeSection(raw: Raw, f: Filt, devs: Map<string, Dev>) {
    const coh = raw.repairs.filter((r) => r.in_rep && r.status !== 'duplicate' && (!f.depts || (!!r.dept_rep && f.depts.includes(r.dept_rep))));
    // მიზეზი / ქმედება — შესრულებული (no_fault-ზე მიზეზი არ მოითხოვება — NFF ცალკეა)
    const done = coh.filter((r) => ['done', 'closed'].includes(r.status) && r.outcome !== 'no_fault');
    const pareto = (list: RepRow[], fn: (r: RepRow) => [string, string]) => {
      const m = new Map<string, { code: string; name: string; n: number }>();
      for (const r of list) { const [c, nm] = fn(r); const x = m.get(c) ?? m.set(c, { code: c, name: nm, n: 0 }).get(c)!; x.n++; }
      const tot = list.length; let cum = 0;
      return [...m.values()].sort((a, b) => b.n - a.n).map((x) => { cum += x.n; return { ...x, pct: pct(x.n, tot), cum_pct: pct(cum, tot) }; });
    };
    const ueOf = (r: RepRow) => r.cause_code === 'USER_ERROR' || r.reject_reason === 'user_error';
    const types = new Map<string, { type_name: string; requests: number; user_error: number }>();
    for (const r of coh) {
      const d = devs.get(r.device_id); const k = d?.type_id ?? '';
      const x = types.get(k) ?? types.set(k, { type_name: d?.type_name ?? '—', requests: 0, user_error: 0 }).get(k)!;
      x.requests++; if (ueOf(r)) x.user_error++;
    }
    return {
      requests: coh.length, user_error: coh.filter(ueOf).length, user_error_pct: pct(coh.filter(ueOf).length, coh.length),
      nff: coh.filter((r) => r.outcome === 'no_fault' || r.reject_reason === 'no_fault').length,
      nff_pct: pct(coh.filter((r) => r.outcome === 'no_fault' || r.reject_reason === 'no_fault').length, coh.length),
      rejected: pareto(coh.filter((r) => r.status === 'rejected'), (r) => [r.reject_reason ?? 'other', REJECT_KA[r.reject_reason as keyof typeof REJECT_KA] ?? r.reject_reason ?? '—']),
      causes: pareto(done, (r) => (r.cause_code ? [r.cause_code, r.cause_name!] : ['—', 'მითითებული არ არის'])),
      actions: pareto(done, (r) => (r.action_code ? [r.action_code, r.action_name!] : ['—', 'მითითებული არ არის'])),
      unclassified: done.filter((r) => !r.cause_code).length,
      by_condition: pareto(coh, (r) => [r.condition, CONDITION_KA[r.condition as keyof typeof CONDITION_KA] ?? r.condition]),
      user_error_by_type: [...types.values()].filter((x) => x.requests).map((x) => ({ ...x, pct: pct(x.user_error, x.requests) })).sort((a, b) => b.user_error - a.user_error || b.requests - a.requests),
    };
  }

  /** კონტრაქტები: uptime % (აპარატების ხელმისაწვდომობა კონტრაქტის ∩ პერიოდის ფანჯარაში), PM ვიზიტები ფაქტი / გეგმა, ორდერები, ხარჯი */
  private async contractSection(w: Win, f: Filt, s: RptRules, cost: boolean) {
    if (w.from > w.dTo) return [];
    let x = this.db.selectFrom('bme_contracts as c').innerJoin('stock_suppliers as sp', 'sp.id', 'c.supplier_id')
      .select(['c.id', 'c.contract_no', 'c.title', 'c.kind', 'c.status', 'c.supplier_id', 'sp.name as supplier_name', 'c.uptime_pct', 'c.pm_visits_per_year', 'c.cost_period',
        sql<number | null>`c.cost::float8`.as('cost'), sql<string>`to_char(c.start_date, 'YYYY-MM-DD')`.as('start_date'), sql<string>`to_char(c.end_date, 'YYYY-MM-DD')`.as('end_date'),
        sql<string>`to_char(least(c.end_date, CASE WHEN c.status = 'cancelled' THEN (c.updated_at AT TIME ZONE ${TZ})::date END), 'YYYY-MM-DD')`.as('end_eff'),
        sql<string[]>`coalesce((SELECT array_agg(cd.device_id::text) FROM bme_contract_devices cd WHERE cd.contract_id = c.id), '{}')`.as('device_ids')])
      .where('c.start_date', '<=', w.dTo).where(sql<boolean>`least(c.end_date, CASE WHEN c.status = 'cancelled' THEN (c.updated_at AT TIME ZONE ${TZ})::date END) >= ${w.from}::date`);
    if (f.supplier_id) x = x.where('c.supplier_id', '=', f.supplier_id);
    const list = await x.orderBy('c.end_date').execute();
    const allowed = await this.devices(f);
    const deptOk = (id: string) => { const d = allowed.get(id); return !!d && (!f.depts || (!!d.department_id && f.depts.includes(d.department_id))); };
    const out = [];
    for (const c of list) {
      const dev = c.device_ids.filter(deptOk);
      if (!dev.length && (f.device_ids || f.depts || f.type_id || f.grp || f.criticality)) continue;
      const from = c.start_date > w.from ? c.start_date : w.from; const to = c.end_eff < w.dTo ? c.end_eff : w.dTo;
      const ow: Win = { ...w, from, to: to, dTo: to };
      const hrs = dev.length ? await hoursRows(this.db, ow, { device_ids: dev }, 'device') : [];
      const a = zeroAcc(); for (const h of hrs) for (const k of ['avail_h', 'down_h', 'restricted_h'] as const) a[k] += h[k];
      const avail = bmeKpis(a, s).bme_availability_pct;
      const visits = dev.length ? (await sql<{ n: number }>`
        SELECT count(DISTINCT w.performed_on)::int AS n FROM bme_works w
         WHERE w.device_id = ANY(${sql.val(dev)}::uuid[]) AND w.status = 'done' AND w.performer_kind = 'external' AND w.supplier_id = ${c.supplier_id}
           AND w.performed_on BETWEEN ${from}::date AND ${to}::date`.execute(this.db)).rows[0].n : 0;
      const reps = dev.length ? (await sql<{ n: number; met: number; rn: number }>`
        SELECT count(*)::int AS n, count(*) FILTER (WHERE r.done_at IS NOT NULL AND r.done_at <= r.sla_restore_due)::int AS met,
               count(*) FILTER (WHERE r.sla_restore_due IS NOT NULL AND (r.done_at IS NOT NULL OR ${w.at ? sql`${w.at}::timestamptz` : sql`now()`} > r.sla_restore_due))::int AS rn
          FROM bme_repairs r WHERE r.contract_id = ${c.id} AND r.status NOT IN ('rejected', 'duplicate')
           AND r.reported_at >= (${from}::date)::timestamp AT TIME ZONE ${TZ} AND r.reported_at < (${to}::date + 1)::timestamp AT TIME ZONE ${TZ}`.execute(this.db)).rows[0] : { n: 0, met: 0, rn: 0 };
      const odays = daysIncl(from, to);
      const daily = c.cost && c.cost_period ? (c.cost_period === 'once' ? c.cost / daysIncl(c.start_date, c.end_date) : c.cost_period === 'month' ? (c.cost * 12) / 365
        : c.cost_period === 'quarter' ? (c.cost * 4) / 365 : c.cost / 365) : 0;
      out.push({ id: c.id, contract_no: c.contract_no, title: c.title, kind: c.kind, kind_name: CONTRACT_KA[c.kind as ContractKind] ?? c.kind, status: c.status,
        supplier_id: c.supplier_id, supplier_name: c.supplier_name, start_date: c.start_date, end_date: c.end_date, window_from: from, window_to: to, devices: dev.length,
        uptime_target: c.uptime_pct === null ? null : Number(c.uptime_pct), availability_pct: avail, down_h: r1(a.down_h),
        uptime_met: c.uptime_pct === null || avail === null ? null : avail >= Number(c.uptime_pct),
        pm_visits_plan: c.pm_visits_per_year === null ? null : r1((c.pm_visits_per_year * odays) / 365), pm_visits_done: visits,
        repairs: reps.n, restore_met: reps.met, restore_pct: pct(reps.met, reps.rn), ...(cost && { cost_window: r2(daily * odays) }) });
    }
    return out;
  }

  /** ხარჯი: კომპონენტები, ჭრილები, აპარატი (TCO — მთელი ისტორია, COSR — პერიოდის ხარჯი წლიურად / შეძენის ღირებულება) */
  private async costSection(w: Win, f: Filt, s: RptRules, byDept: Row[], byType: Row[], byDevice: Row[], devs: Map<string, Dev>, days: number) {
    const ids = [...new Set(byDevice.map((x) => x.key))];
    const life = new Map<string, number>();
    if (ids.length) {
      const lw = await makeWin(this.db, '2000-01-01', w.atDay, w.at);
      for (const c of await costRows(this.db, lw, { device_ids: ids }, 'device', s)) life.set(c.device_id!, (life.get(c.device_id!) ?? 0) + c.cost_parts + c.cost_labor + c.cost_external + c.cost_pm + c.cost_contract);
    }
    const pick = (x: Row) => ({ cost_parts: r2(x.cost_parts), cost_labor: r2(x.cost_labor), cost_external: r2(x.cost_external), cost_pm: r2(x.cost_pm), cost_contract: r2(x.cost_contract),
      cost_total: r2(costTotal(x as unknown as Acc)) });
    const devRows = byDevice.map((x) => {
      const d = devs.get(x.key); const pv = d?.purchase_value ?? null; const per = costTotal(x as unknown as Acc); const lt = life.get(x.key) ?? 0;
      const cosr = pv && pv > 0 && days > 0 ? r1(((per * 365) / days / pv) * 100) : null;
      return { device_id: x.key, inv_no: d?.inv_no, name: d?.name, type_name: d?.type_name, department_name: d?.department_name, status: d?.status, install_date: d?.install_date ?? null,
        purchase_value: pv, ...pick(x), service_lifetime: r2(lt), tco: r2((pv ?? 0) + lt), cosr_pct: cosr, cosr_flag: cosr !== null && cosr > Number(s.rpt_cosr_warn_pct) };
    }).sort((a, b) => b.cost_total - a.cost_total);
    const tot = zeroAcc(); for (const x of byDevice) for (const k of ['cost_parts', 'cost_labor', 'cost_external', 'cost_pm', 'cost_contract'] as const) tot[k] += x[k];
    const pvSum = devRows.reduce((a, b) => a + (b.purchase_value ?? 0), 0);
    return {
      total: pick(tot as unknown as Row), purchase_value: r2(pvSum), cosr_pct: pvSum > 0 && days > 0 ? r1(((costTotal(tot) * 365) / days / pvSum) * 100) : null, cosr_warn_pct: s.rpt_cosr_warn_pct,
      by_dept: byDept.map((x) => ({ department_id: (x as unknown as { department_id: string | null }).department_id, name: (x as unknown as { name: string }).name, devices: x.devices, ...pick(x) }))
        .filter((x) => x.cost_total > 0),
      by_type: byType.map((x) => ({ type_id: x.key, name: (x as unknown as { name: string }).name, devices: x.devices, ...pick(x) })).filter((x) => x.cost_total > 0),
      devices: devRows.filter((x) => x.cost_total > 0 || x.purchase_value).slice(0, 300),
      replace_candidates: devRows.filter((x) => x.cosr_flag).slice(0, 50),
    };
  }

  /** 13-თვიანი ტრენდი (to-ს თვის ჩათვლით) */
  private async trend(w: Win, f: Filt, s: RptRules, cost: boolean) {
    const end = w.to; const d = new Date(`${end.slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 12);
    const tw = await makeWin(this.db, d.toISOString().slice(0, 10), end, w.at);
    const raw = await loadRaw(this.db, tw, f, 'month', s);
    const agg = aggregate(raw, f, (x) => x.k, 'month');
    const months: string[] = []; const c = new Date(d); while (c.toISOString().slice(0, 7) <= end.slice(0, 7)) { months.push(c.toISOString().slice(0, 7)); c.setUTCMonth(c.getUTCMonth() + 1); }
    return months.map((ym) => { const a = agg.get(ym) ?? zeroAcc(); const k: Record<string, unknown> = { ...bmeKpis(a, s), failures: a.failures, requests: a.requests, down_h: r1(a.down_h) };
      if (!cost) delete k.bme_service_cost; return { ym, ...k }; });
  }

  /** მოცდენის პერიოდები (ექსპორტი): down / restricted, ფანჯარაში */
  private async periods(w: Win, f: Filt, names: Map<string, string>) {
    if (w.from > w.dTo) return [];
    const B = sql`least((${w.to}::date + 1)::timestamp AT TIME ZONE ${TZ}, ${w.at ? sql`${w.at}::timestamptz` : sql`now()`})`;
    let x = this.db.selectFrom('bme_status_periods as p').innerJoin('bme_devices as b', 'b.id', 'p.device_id').innerJoin('bme_device_types as t', 't.id', 'b.type_id')
      .leftJoin('bme_repairs as r', 'r.id', 'p.repair_id')
      .select(['p.device_id', 'b.inv_no', 'b.name', 't.name as type_name', 'b.department_id', 'p.status', 'p.reason', 'r.repair_no', 'p.started_at', 'p.ended_at',
        sql<number>`(extract(epoch FROM (least(coalesce(p.ended_at, ${B}), ${B}) - greatest(p.started_at, (${w.from}::date)::timestamp AT TIME ZONE ${TZ}))) / 3600.0)::float8`.as('hours')])
      .where('p.status', 'in', ['down', 'restricted']).where(sql<boolean>`p.started_at < ${B}`)
      .where(sql<boolean>`coalesce(p.ended_at, 'infinity'::timestamptz) > (${w.from}::date)::timestamp AT TIME ZONE ${TZ}`);
    if (f.device_ids) x = x.where('b.id', 'in', f.device_ids.length ? f.device_ids : ['00000000-0000-0000-0000-000000000000']);
    if (f.type_id) x = x.where('b.type_id', '=', f.type_id);
    if (f.grp) x = x.where('t.grp', '=', f.grp);
    if (f.criticality) x = x.where('b.criticality', '=', f.criticality);
    if (f.depts) x = x.where('b.department_id', 'in', f.depts.length ? f.depts : ['00000000-0000-0000-0000-000000000000']);
    return (await x.orderBy('p.started_at').limit(20000).execute()).map((p) => ({ ...p, department_name: p.department_id ? names.get(p.department_id) ?? '—' : null, hours: r2(p.hours) }));
  }

  // ============================================================================================ აპარატის KPI (პასპორტი, 12 თვე)
  async device(id: string, u: AuthUser) {
    const s = await this.rules();
    const sc = await this.scope(u);
    const d = await this.db.selectFrom('bme_devices').select(['id', 'department_id', sql<number | null>`purchase_value::float8`.as('pv'), sql<string | null>`to_char(install_date, 'YYYY-MM-DD')`.as('install_date')])
      .where('id', '=', id).executeTakeFirst();
    if (!d) throw new NotFoundException('აპარატი ვერ მოიძებნა');
    if (sc.depts && (!d.department_id || !sc.depts.includes(d.department_id))) throw new ForbiddenException('აპარატი თქვენს ხედვის არეში არ არის');
    const t = (await sql<{ d: string }>`SELECT to_char((now() AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS d`.execute(this.db)).rows[0].d;
    const w = await makeWin(this.db, addDays(t, -364), t, null);
    const f: Filt = { device_ids: [id] };
    const raw = await loadRaw(this.db, w, f, 'device', s);
    const a = aggregate(raw, f, () => 'all', null).get('all') ?? zeroAcc();
    const k: Record<string, unknown> = { ...bmeKpis(a, s) };
    const res: Record<string, unknown> = { from: w.from, to: w.to, kpi: k, failures: a.failures, repairs_done: a.repairs_done, down_h: r1(a.down_h), avail_h: r1(a.avail_h),
      pm_due: a.pm_due, pm_ontime: a.pm_ontime, can_cost: sc.cost };
    if (sc.cost) {
      const lw = await makeWin(this.db, '2000-01-01', t, null);
      const life = (await costRows(this.db, lw, f, 'device', s)).reduce((x, c) => x + c.cost_parts + c.cost_labor + c.cost_external + c.cost_pm + c.cost_contract, 0);
      const per = costTotal(a);
      Object.assign(res, { cost: { parts: r2(a.cost_parts), labor: r2(a.cost_labor), external: r2(a.cost_external), pm: r2(a.cost_pm), contract: r2(a.cost_contract), total: r2(per),
        purchase_value: d.pv, service_lifetime: r2(life), tco: r2((d.pv ?? 0) + life), cosr_pct: d.pv && d.pv > 0 ? r1((per / d.pv) * 100) : null,
        cosr_warn_pct: s.rpt_cosr_warn_pct } });
    } else delete k.bme_service_cost;
    return res;
  }

  // ============================================================================================ Excel
  async export(u: AuthUser, q: Q, req: Request) {
    const d = await this.summary(u, { ...q, trend: '1' }, true);
    const clinic = (await this.db.selectFrom('clinic_settings').select('name').where('id', '=', 1).executeTakeFirst())?.name ?? '';
    await this.audit.log(auditCtx(req), { action: 'BME_REPORT_EXPORT', entityName: 'bme_reports', entityId: 'summary', newData: { from: d.from, to: d.to, scope: d.scope_label, filters: q } });
    return { name: `bme_report_${d.from}_${d.to}.xlsx`, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: writeXlsxBook(this.sheets(d, clinic)) };
  }

  private sheets(d: Awaited<ReturnType<BmeReportService['summary']>>, clinic: string): SheetSpec[] {
    const num = (v: unknown, fmt = '0.##'): Cell => (v === null || v === undefined || Number.isNaN(Number(v)) ? null : { v: Number(v), fmt });
    const int = (v: unknown) => num(v, '0');
    const money = (v: unknown) => num(v, '#,##0.00');
    const ts = (v: unknown) => (v ? new Date(v as string).toLocaleString('sv-SE', { timeZone: TZ }).slice(0, 16) : null);
    const head = [[clinic], [`ბიომედ-აპარატურა — ანგარიში · ${d.from} — ${d.to_effective} · ${d.scope_label}`], []];
    const K = d.kpi as Record<string, number | null>;
    const KPI_NAMES: [string, string][] = [['bme_availability_pct', 'ხელმისაწვდომობა, %'], ['bme_avail_ls_pct', 'ხელმისაწვდომობა — სიცოცხ. შემანარჩუნებელი, %'],
      ['unplanned_availability_pct', 'არადაგეგმილი ხელმისაწვდომობა, %'], ['bme_mttr_h', 'MTTR, სთ'], ['down_per_repair_h', 'მოცდენა ერთ ორდერზე, სთ'], ['bme_mtbf_d', 'MTBF, დღე'],
      ['bme_sla_response_pct', 'SLA — რეაგირება, %'], ['bme_sla_restore_pct', 'SLA — აღდგენა, %'], ['bme_pm_ontime_pct', 'PM ვადაში, %'], ['pm_fail_pct', 'PM „ვერ გაიარა“, %'],
      ['bme_user_error_pct', 'მომხმარებლის შეცდომა, %'], ['nff_pct', 'დაზიანება არ დადასტურდა (NFF), %'], ['reopen_pct', 'ხელახლა გახსნა, %'], ['bme_service_cost', 'სერვისის ხარჯი, ₾']];
    const T = d.totals as Record<string, number>;
    const sheets: SheetSpec[] = [
      { name: 'შეჯამება', rows: [...head, ['მაჩვენებელი', 'მნიშვნელობა'], ...KPI_NAMES.filter(([k]) => k in K).map(([k, n]) => [n, num(K[k])]),
        ...(K.bme_mtbf_d === null && K.mtbf_gt_d !== null ? [['MTBF (მწყობრიდან გამოსვლა არ ყოფილა), დღე >', num(K.mtbf_gt_d)]] : []), [],
        ['აპარატები', int(d.devices)], ['ექსპლუატაციის საათები', num(T.avail_h)], ['მოცდენა (down), სთ', num(T.down_h)], ['არადაგეგმილი მოცდენა, სთ', num(T.down_unpl_h)],
        ['შეზღუდული, სთ', num(T.restricted_h)], ['მოთხოვნები', int(T.requests)], ['მწყობრიდან გამოსვლა', int(T.failures)], ['შესრულებული ორდერები', int(T.repairs_done)],
        ['PM ვადიანი / ვადაში', `${T.pm_due} / ${T.pm_ontime}`], [],
        ['პარამეტრები', `შეზღუდულის წონა ${d.settings.rpt_restricted_weight}; MTBF — მომხმ. შეცდომა ${d.settings.rpt_mtbf_exclude_user_error ? 'გამორიცხულია' : 'ითვლება'}; PM grace ${d.settings.rpt_pm_grace_days} დღე`]],
        boldRows: [1, 3], widths: [48, 22] },
    ];
    if (d.trend) sheets.push({ name: 'ტრენდი', rows: [...head, ['თვე', 'ხელმისაწვდ. %', 'სიცოცხ. %', 'MTTR სთ', 'MTBF დღე', 'SLA რეაგ. %', 'SLA აღდგ. %', 'PM ვადაში %', 'მომხმ. შეცდ. %',
      'მოთხოვნა', 'მწყობრ. გამოსვლა', 'მოცდენა სთ', ...(d.can_cost ? ['ხარჯი ₾'] : [])],
      ...d.trend.map((m) => { const x = m as Record<string, unknown>; return [m.ym, num(x.bme_availability_pct), num(x.bme_avail_ls_pct), num(x.bme_mttr_h), num(x.bme_mtbf_d), num(x.bme_sla_response_pct),
        num(x.bme_sla_restore_pct), num(x.bme_pm_ontime_pct), num(x.bme_user_error_pct), int(x.requests), int(x.failures), num(x.down_h), ...(d.can_cost ? [money(x.bme_service_cost)] : [])]; })],
      boldRows: [1, 3], widths: [10, 13, 11, 10, 10, 12, 12, 12, 13, 10, 13, 12, 12] });
    const avHead = ['ჭრილი', 'აპარატები', 'ექსპლ. სთ', 'down სთ', 'არადაგეგმ. სთ', 'შეზღუდ. სთ', 'ხელმისაწვდ. %', 'არადაგეგმ. %'];
    const avRow = (n: string, x: AvailRow) => [n, int(x.devices), num(x.avail_h), num(x.down_h), num(x.down_unpl_h), num(x.restricted_h), num(x.bme_availability_pct), num(x.unplanned_availability_pct)];
    sheets.push({ name: 'ხელმისაწვდომობა', rows: [...head, ['განყოფილებები'], avHead, ...d.availability.by_dept.map((x) => avRow(x.name, x)), [],
      ['ტიპები'], avHead, ...d.availability.by_type.map((x) => avRow(x.name, x)), [], ['კრიტიკულობა'], avHead, ...d.availability.by_criticality.map((x) => avRow(x.name, x))],
      boldRows: [1, 3, 4], widths: [40, 11, 12, 11, 13, 12, 14, 13] });
    const relHead = ['ჭრილი', 'აპარატები', 'მწყობრ. გამოსვლა', 'მ.შ. მომხმ. შეცდ.', 'შესრულდა', 'MTBF დღე', 'MTTR სთ', 'მოცდენა / ორდერი სთ', 'ხელახლა გახსნა %'];
    const relRow = (n: string, x: RelRow) => [n, int(x.devices), int(x.failures), int(x.failures_ue), int(x.repairs_done), num(x.bme_mtbf_d ?? (x.mtbf_gt_d !== null ? x.mtbf_gt_d : null)),
      num(x.bme_mttr_h), num(x.down_per_repair_h), num(x.reopen_pct)];
    sheets.push({ name: 'MTBF-MTTR', rows: [...head, ['ტიპები'], relHead, ...d.reliability.by_type.map((x) => relRow(x.name, x)), [], ['განყოფილებები'], relHead,
      ...d.reliability.by_dept.map((x) => relRow(x.name, x)), [], ['აპარატები (ყველაზე ხშირი)'], relHead, ...d.reliability.devices.map((x) => relRow(`${x.inv_no} ${x.name}`, x))],
      boldRows: [1, 3, 4], widths: [44, 11, 15, 15, 11, 11, 10, 18, 15] });
    const slaHead = ['ჭრილი', 'ორდერი', 'რეაგ. ვადაში', 'რეაგ. დარღვ.', 'რეაგ. %', 'აღდგ. ვადაში', 'აღდგ. დარღვ.', 'აღდგ. %', 'მიმდინარე', 'რეაგ. საშ. სთ', 'ლოდინი სთ', 'დარღვ. ლოდინით'];
    const slaRow = (n: string, x: SlaRow) => [n, int(x.n), int(x.resp_met), int(x.resp_breached), num(x.resp_pct), int(x.rest_met), int(x.rest_breached), num(x.rest_pct), int(x.in_progress),
      num(x.resp_avg_h), num(x.wait_h), int(x.breached_with_wait)];
    sheets.push({ name: 'SLA', rows: [...head, slaHead, slaRow('სულ', d.sla.total), [], ['პრიორიტეტი'], slaHead, ...d.sla.by_priority.map((x) => slaRow(`P${x.priority}`, x)), [],
      ['შემსრულებელი / სამიზნე'], slaHead, ...d.sla.by_mode.map((x) => slaRow(x.name, x)), [], ['მომწოდებელი'], slaHead, ...d.sla.by_supplier.map((x) => slaRow(x.name, x))],
      boldRows: [1, 3], widths: [34, 9, 12, 12, 9, 12, 12, 9, 11, 12, 11, 14] });
    sheets.push({ name: 'კონტრაქტები', rows: [...head, ['№', 'დასახელება', 'მომწოდებელი', 'სახე', 'სტატუსი', 'ფანჯარა', 'აპარატები', 'uptime სამიზნე %', 'ხელმისაწვდ. %', 'შესრულდა',
      'PM ვიზიტი გეგმა', 'PM ვიზიტი ფაქტი', 'ორდერები', 'აღდგენა ვადაში %', ...(d.can_cost ? ['ხარჯი ფანჯარაში ₾'] : [])],
      ...d.contracts.map((c) => [c.contract_no, c.title, c.supplier_name, c.kind_name, c.status === 'active' ? 'მოქმედი' : 'გაუქმებული', `${c.window_from} — ${c.window_to}`, int(c.devices),
        num(c.uptime_target), num(c.availability_pct), c.uptime_met === null ? '—' : c.uptime_met ? 'დიახ' : 'არა', num(c.pm_visits_plan), int(c.pm_visits_done), int(c.repairs), num(c.restore_pct),
        ...(d.can_cost ? [money((c as { cost_window?: number }).cost_window)] : [])])],
      boldRows: [1, 3], widths: [14, 30, 26, 20, 12, 24, 10, 14, 13, 10, 13, 13, 10, 14, 16] });
    if (d.costs) {
      const C = d.costs;
      const cHead = ['ჭრილი', 'აპარატები', 'ნაწილები', 'შრომა', 'გარე', 'PM / კალიბრ.', 'კონტრაქტი', 'სულ'];
      const cRow = (n: string, x: { devices?: number; cost_parts: number; cost_labor: number; cost_external: number; cost_pm: number; cost_contract: number; cost_total: number }) =>
        [n, int(x.devices), money(x.cost_parts), money(x.cost_labor), money(x.cost_external), money(x.cost_pm), money(x.cost_contract), money(x.cost_total)];
      sheets.push({ name: 'ხარჯი', rows: [...head, cHead, cRow('სულ', C.total), ['შეძენის ღირებულება (ჯამი)', null, money(C.purchase_value)], ['COSR, % (წლიური)', null, num(C.cosr_pct)], [],
        ['განყოფილებები'], cHead, ...C.by_dept.map((x) => cRow(x.name, x)), [], ['ტიპები'], cHead, ...C.by_type.map((x) => cRow(x.name, x))],
        boldRows: [1, 3], widths: [36, 10, 13, 12, 12, 13, 13, 14] });
      sheets.push({ name: 'TCO', rows: [...head, ['ინვ. №', 'აპარატი', 'ტიპი', 'განყოფილება', 'ექსპლ. შეყვანა', 'შეძენა ₾', 'ნაწილები', 'შრომა', 'გარე', 'PM', 'კონტრაქტი', 'პერიოდის ხარჯი',
        'სერვისი (სულ)', 'TCO', 'COSR %', 'COSR > ზღვარი'],
        ...C.devices.map((x) => [x.inv_no, x.name, x.type_name, x.department_name, x.install_date, money(x.purchase_value), money(x.cost_parts), money(x.cost_labor), money(x.cost_external),
          money(x.cost_pm), money(x.cost_contract), money(x.cost_total), money(x.service_lifetime), money(x.tco), num(x.cosr_pct), x.cosr_flag ? 'დიახ' : ''])],
        boldRows: [1, 3], widths: [12, 30, 26, 22, 12, 12, 11, 10, 10, 10, 11, 13, 13, 13, 9, 12] });
    }
    const P = d.pm;
    const pHead = ['ჭრილი', 'ვადიანი', 'ვადაში', 'დაგვიანებით', 'შეუსრულებელი', '„ვერ გაიარა“', 'ვადაში %'];
    const pRow = (n: string, x: { due: number; ontime: number; late: number; open: number; fail: number; ontime_pct: number | null }) => [n, int(x.due), int(x.ontime), int(x.late), int(x.open), int(x.fail), num(x.ontime_pct)];
    sheets.push({ name: 'PM', rows: [...head, pHead, pRow('სულ', P.total), [], ['სამუშაოს სახე'], pHead, ...P.by_kind.map((x) => pRow(x.name, x)), [], ['კრიტიკულობა'], pHead,
      ...P.by_criticality.map((x) => pRow(x.name, x)), [], ['განყოფილებები'], pHead, ...P.by_dept.map((x) => pRow(x.name, x)), [], ['შემსრულებელი'], pHead, ...P.by_performer.map((x) => pRow(x.name, x)), [],
      ['ვადაგადაცილებული'], ['ინვ. №', 'აპარატი', 'სახე', 'ვადა', 'დღე', 'სამუშაო', 'განყოფილება'],
      ...P.overdue.map((x) => [x.inv_no, x.name, x.kind, x.due, int(x.overdue_days), x.work_no ?? 'არ შექმნილა', x.department])],
      boldRows: [1, 3], widths: [30, 30, 16, 12, 12, 13, 22] });
    const Z = d.causes;
    const parHead = ['კოდი', 'დასახელება', 'რაოდენობა', '%', 'კუმულ. %'];
    const par = (xs: { code: string; name: string; n: number; pct: number | null; cum_pct: number | null }[]) => xs.map((x) => [x.code, x.name, int(x.n), num(x.pct), num(x.cum_pct)]);
    sheets.push({ name: 'მიზეზები', rows: [...head, ['მოთხოვნები', int(Z.requests)], ['მომხმარებლის შეცდომა', int(Z.user_error), num(Z.user_error_pct)], ['NFF', int(Z.nff), num(Z.nff_pct)],
      ['შესრულებული, მიზეზის გარეშე', int(Z.unclassified)], [], ['მიზეზი (შესრულებული)'], parHead, ...par(Z.causes), [], ['ქმედება'], parHead, ...par(Z.actions), [],
      ['უარყოფის მიზეზი'], parHead, ...par(Z.rejected), [], ['მდგომარეობა (მოთხოვნისას)'], parHead, ...par(Z.by_condition), [],
      ['მომხმარებლის შეცდომა ტიპებით'], ['ტიპი', 'მოთხოვნა', 'მომხმ. შეცდ.', '%'], ...Z.user_error_by_type.map((x) => [x.type_name, int(x.requests), int(x.user_error), num(x.pct)])],
      boldRows: [1], widths: [30, 40, 12, 10, 10] });
    const det = d.detail!;
    sheets.push({ name: 'ორდერები', rows: [...head, ['№', 'ინვ. №', 'აპარატი', 'სტატუსი', 'P', 'მდგომარეობა', 'შემსრულებელი', 'მომწოდებელი', 'კონტრაქტი', 'მოთხოვნა', 'შესრულება',
      'აღდგენა სთ', 'მოცდენა სთ', 'ლოდინი სთ', 'რეაგ. SLA', 'აღდგ. SLA', 'შედეგი', 'მიზეზი', 'ქმედება', 'უარყოფა', 'ხელახლა', ...(d.can_cost ? ['ნაწილები', 'შრომა', 'გარე'] : [])],
      ...det.repairs.map((r) => { const dv = det.devices.find((x) => x.device_id === r.device_id) as { inv_no?: string; name?: string } | undefined;
        return [r.repair_no, dv?.inv_no, dv?.name, REP_STATUS_KA[r.status as RepStatus] ?? r.status, r.priority ? `P${r.priority}` : '', CONDITION_KA[r.condition as keyof typeof CONDITION_KA] ?? r.condition,
          r.performer_kind === 'external' ? 'გარე' : 'შიდა', r.supplier_name, r.contract_no, ts(r.reported_at), ts(r.done_at), num(r.restore_h), num(r.rep_down_h), num(r.wait_h),
          slaKa(r.resp_state), slaKa(r.rest_state), r.outcome ? OUTCOME_KA[r.outcome as keyof typeof OUTCOME_KA] : '', r.cause_name, r.action_name,
          r.reject_reason ? REJECT_KA[r.reject_reason as keyof typeof REJECT_KA] : '', int(r.reopen_count), ...(d.can_cost ? [money(r.parts), money(r.labor_cost), money(r.external_cost)] : [])]; })],
      boldRows: [1, 3], widths: [13, 12, 28, 22, 5, 18, 10, 22, 14, 16, 16, 10, 10, 10, 11, 11, 18, 24, 22, 18, 8, 10, 10, 10] });
    sheets.push({ name: 'PM ვადები', rows: [...head, ['ინვ. №', 'აპარატი', 'სახე', 'სამუშაო', 'ვადა', 'შესრულება', 'სტატუსი', 'შედეგი', 'ვადაში', 'შემსრულებელი'],
      ...det.pm.map((p) => { const dv = det.devices.find((x) => x.device_id === p.device_id) as { inv_no?: string; name?: string } | undefined;
        return [dv?.inv_no, dv?.name, p.kind_name, p.work_no ?? 'არ შექმნილა', p.due, p.performed, p.status === 'done' ? 'შესრულდა' : p.status === 'missing' ? 'სამუშაოს გარეშე' : 'ღია',
          p.result === 'pass' ? 'გავლილი' : p.result === 'conditional' ? 'პირობითად' : p.result === 'fail' ? 'ვერ გაიარა' : '', p.ontime ? 'დიახ' : 'არა',
          p.performer_kind === 'external' ? 'გარე' : p.performer_kind === 'internal' ? 'შიდა' : '']; })],
      boldRows: [1, 3], widths: [12, 30, 16, 14, 12, 12, 16, 12, 8, 12] });
    sheets.push({ name: 'მოცდენის პერიოდები', rows: [...head, ['ინვ. №', 'აპარატი', 'ტიპი', 'განყოფილება (ამჟამ.)', 'სტატუსი', 'მიზეზი', 'ორდერი', 'დასაწყისი', 'დასასრული', 'საათი (ფანჯარაში)'],
      ...det.periods.map((p) => [p.inv_no, p.name, p.type_name, p.department_name, STATUS_KA[p.status as BmeStatus] ?? p.status, p.reason, p.repair_no, ts(p.started_at), ts(p.ended_at) ?? 'მიმდინარე', num(p.hours)])],
      boldRows: [1, 3], widths: [12, 30, 26, 22, 20, 40, 13, 16, 16, 14] });
    sheets.push({ name: 'აპარატები', rows: [...head, ['ინვ. №', 'აპარატი', 'ტიპი', 'კრიტიკულობა', 'სტატუსი', 'განყოფილება', 'ექსპლ. სთ', 'down სთ', 'ხელმისაწვდ. %', 'მწყობრ. გამოსვლა', 'MTBF დღე', 'MTTR სთ',
      'PM ვადიანი', 'PM ვადაში', ...(d.can_cost ? ['ხარჯი ₾'] : [])],
      ...det.devices.map((x) => { const y = x as Record<string, unknown>; return [y.inv_no, y.name, y.type_name, CRIT_KA[y.criticality as Criticality] ?? y.criticality, STATUS_KA[y.status as BmeStatus] ?? y.status,
        y.department_name, num(y.avail_h), num(y.down_h), num(y.bme_availability_pct), int(y.failures), num(y.bme_mtbf_d), num(y.bme_mttr_h), int(y.pm_due), int(y.pm_ontime),
        ...(d.can_cost ? [money(y.bme_service_cost)] : [])] as Cell[]; })],
      boldRows: [1, 3], widths: [12, 30, 26, 18, 20, 22, 11, 10, 13, 15, 10, 10, 11, 10, 12] });
    return sheets;
  }
}

type Row = { key: string; devices: number } & Acc & ReturnType<typeof bmeKpis>;
type AvailRow = { devices: number; avail_h: number; down_h: number; down_unpl_h: number; restricted_h: number; bme_availability_pct: number | null; unplanned_availability_pct: number | null };
type RelRow = { devices: number; failures: number; failures_ue: number; repairs_done: number; bme_mtbf_d: number | null; mtbf_gt_d: number | null; bme_mttr_h: number | null;
  down_per_repair_h: number | null; reopen_pct: number | null };
type SlaRow = { n: number; resp_met: number; resp_breached: number; resp_pct: number | null; rest_met: number; rest_breached: number; rest_pct: number | null; in_progress: number;
  resp_avg_h: number | null; wait_h: number; breached_with_wait: number };
const slaKa = (s: string | null) => (s === 'met' ? 'ვადაში' : s === 'breached' ? 'დარღვეული' : s === 'warn' || s === 'ok' ? 'მიმდინარე' : '');
function round(a: Acc) {
  const o: Record<string, number> = {};
  for (const k of ACC_KEYS) o[k] = k.endsWith('_h') ? r2(a[k]) : k.startsWith('cost') ? r2(a[k]) : a[k];
  return o as Acc;
}
const ID_KEYS = ['key', 'department_id', 'type_id', 'device_id', 'criticality', 'name', 'inv_no', 'type_name', 'status', 'department_name', 'grp'];
function pickAvail<T extends Row>(x: T) {
  const o: Record<string, unknown> = {};
  for (const k of [...ID_KEYS, 'devices', 'avail_h', 'down_h', 'down_unpl_h', 'restricted_h', 'bme_availability_pct', 'bme_avail_ls_pct', 'unplanned_availability_pct']) if (k in x) o[k] = (x as Record<string, unknown>)[k];
  return o as T;
}
function pickRel<T extends Row>(x: T) {
  const o: Record<string, unknown> = {};
  for (const k of [...ID_KEYS, 'devices', 'failures', 'failures_ue', 'reopened', 'repairs_done', 'bme_mtbf_d', 'mtbf_gt_d', 'bme_mttr_h', 'down_per_repair_h', 'reopen_pct', 'avail_h', 'down_h'])
    if (k in x) o[k] = (x as Record<string, unknown>)[k];
  return o as T;
}

@Controller('bme')
export class BmeReportController {
  constructor(private readonly s: BmeReportService) {}
  @Get('reports/meta') @Roles(...BME_RPT) meta(@CurrentUser() u: AuthUser) { return this.s.meta(u); }
  @Get('reports/summary') @Roles(...BME_RPT) summary(@CurrentUser() u: AuthUser, @Query() q: Q) { return this.s.summary(u, q); }
  @Get('reports/export') @Roles(...BME_RPT)
  async export(@CurrentUser() u: AuthUser, @Query() q: Q, @Req() r: Request, @Res({ passthrough: true }) res: Response) {
    const out = await this.s.export(u, q, r);
    res.set({ 'Content-Type': out.type, 'Content-Disposition': `attachment; filename="${encodeURIComponent(out.name)}"` });
    return new StreamableFile(out.body);
  }
  @Get('devices/:id/kpi') @Roles(...BME_RPT) device(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser) { return this.s.device(id, u); }
}
