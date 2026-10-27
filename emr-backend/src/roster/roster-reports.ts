import { BadRequestException, Controller, ForbiddenException, Get, Injectable, Query, Req, Res, StreamableFile } from '@nestjs/common';
import type { Request, Response } from 'express';
import { auditCtx } from '../audit/audit-context';
import { AuditService } from '../audit/audit.service';
import { CurrentUser } from '../auth/decorators';
import { has, type AuthUser } from '../auth/roles';
import { writeXlsxBook, type Cell, type SheetSpec } from '../claims-export/xlsx';
import { InjectDb, type Database } from '../database/database.module';
import { CATEGORIES, CATEGORY_KA, EMPLOYMENT, absenceScope, addDays, rosterScope, today, type Category } from './roster-common';
import {
  ACC_KEYS, KPI_CODES, addAcc, chronicOvertime, loadDaily, monthAcc, monthEnd, monthList, personMonths, rosterKpis, rosterRptRules, zeroAcc,
  type Acc, type DayRaw, type Filt, type PM, type Rules,
} from './roster-reports-core';

/**
 * ცვლები / მორიგეობა, ეტაპი 4 (0080) — ანგარიშები / KPI:
 *  შეჯამება + 13-თვიანი ტრენდი, ზეგანაკვეთი (თვე / განყოფილება / კატეგორია, ტოპ, ქრონიკული), ნორმის შესრულება (ჯგუფები, „ნაკლები“, ძირ. განრიგის გარეშე),
 *  გაცდენა / „არ გამოცხადდა“ / არყოფნა ტიპებით / ბიულეტენი (Bradford — პარამეტრით), დასაფარი ცვლები, გაცვლები, ნორმის / მორიგის ხარვეზები, წესები, დატვირთვა.
 * ხედვა (A2): admin / hr / roster_all — მთელი კლინიკა, სახელობით; accountant — მთელი კლინიკა, თვიური მხოლოდ დახურულიდან; manager / viewer / roster_view —
 *  მთელი კლინიკა, მხოლოდ აგრეგატები; roster / absence_approve — თავისი განყოფილებ(ებ)ი, სახელობით. ტიპები (A3) — სახელობითი ხედვით; სხვაგან — კლასები.
 */
const YM = /^\d{4}-\d{2}$/;
const UUID = /^[0-9a-f-]{36}$/i;
const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const pct = (a: number, b: number) => (b > 0 ? r1((a / b) * 100) : null);
const RULE_KA: Record<string, string> = { rest: 'დასვენება ცვლებს შორის', continuous: 'უწყვეტი მუშაობა', week: 'კვირის საათები', nights: 'ზედიზედ ღამეები' };
const SOURCE_KA: Record<string, string> = { absence: 'არყოფნა', cancel: 'გაუქმება', manual: 'ხელით' };
const KIND_KA: Record<string, string> = { day: 'დღე', evening: 'საღამო', night: 'ღამე', '24h': 'სადღეღამისო', oncall_site: 'მორიგეობა ადგილზე', oncall_home: 'მორიგეობა სახლიდან', other: 'სხვა' };
const SWAP_KA: Record<string, string> = { peer: 'კოლეგასთან', head: 'ხელმძღვანელთან', approved: 'დადასტურდა', rejected: 'ხელმძღვანელის უარი', declined: 'კოლეგის უარი', cancelled: 'გაუქმდა', expired: 'ვადა გავიდა' };
const OUTCOME_KA: Record<string, string> = { ontime: 'დაიფარა დაწყებამდე', late: 'დაიფარა გვიან', unfilled: 'დაუფარავი', pending: 'ღიაა (ჯერ არ დაწყებულა)' };
const EMP_KA: Record<string, string> = { staff: 'შტატი', part_time: 'ნახევარი განაკვეთი', contract: 'ხელშეკრულება', intern: 'სტაჟიორი', resident: 'რეზიდენტი' };
const CARE_KA: Record<string, string> = { ward: 'პალატა', intensive: 'ინტენსიური', icu: 'რეანიმაცია' };

interface Q { from?: string; to?: string; department_id?: string; category?: string; position_id?: string; employment?: string; trend?: string; at?: string }
export interface RAccess { depts: string[] | null; named: boolean; types: boolean; closedOnly: boolean; label: string }

@Injectable()
export class RosterReportService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService) {}

  private async rules(): Promise<Rules> {
    const s = await rosterRptRules(this.db);
    if (!s) throw new ForbiddenException({ code: 'MODULE_DISABLED', message: 'მოდული „ცვლები და მორიგეობა“ გამორთულია (ადმინისტრირება → მოდულები)' });
    return s;
  }

  /** ხედვის არე (A2) */
  async access(u: AuthUser): Promise<RAccess> {
    if (has(u, 'admin', 'hr', 'roster_all')) return { depts: null, named: true, types: true, closedOnly: false, label: 'მთელი კლინიკა' };
    if (has(u, 'accountant')) return { depts: null, named: true, types: true, closedOnly: true, label: 'მთელი კლინიკა (დახურული თვეები)' };
    if (has(u, 'manager', 'viewer', 'roster_view')) return { depts: null, named: false, types: false, closedOnly: false, label: 'მთელი კლინიკა (აგრეგატები)' };
    if (has(u, 'roster', 'absence_approve')) {
      const [sc, as] = await Promise.all([rosterScope(this.db, u), absenceScope(this.db, u)]);
      const depts = [...new Set([...sc.edit, ...as.depts])];
      if (!depts.length) throw new ForbiddenException({ code: 'NO_SCOPE', message: 'განყოფილება არ გაქვთ მინიჭებული (ადმინისტრირება → რეპორტინგი → ხედვის არე)' });
      return { depts, named: true, types: true, closedOnly: false, label: 'თქვენი განყოფილებ(ებ)ი' };
    }
    throw new ForbiddenException('ცვლების ანგარიშებზე წვდომა არ გაქვთ');
  }

  private async params(u: AuthUser, q: Q) {
    const s = await this.rules();
    const ac = await this.access(u);
    if (!q.from || !q.to || !YM.test(q.from) || !YM.test(q.to) || q.from > q.to) throw new BadRequestException({ code: 'RANGE', message: 'from / to (YYYY-MM)' });
    const months = monthList(`${q.from}-01`, `${q.to}-01`);
    if (months.length > 24) throw new BadRequestException({ code: 'RANGE', message: 'პერიოდი — მაქსიმუმ 24 თვე' });
    for (const k of ['department_id', 'position_id'] as const) if (q[k] && !UUID.test(q[k]!)) throw new BadRequestException(k);
    if (q.category && !(CATEGORIES as readonly string[]).includes(q.category)) throw new BadRequestException('category');
    if (q.employment && !(EMPLOYMENT as readonly string[]).includes(q.employment)) throw new BadRequestException('employment');
    if (q.department_id && ac.depts && !ac.depts.includes(q.department_id)) throw new ForbiddenException({ code: 'OUT_OF_SCOPE', message: 'განყოფილება თქვენს ხედვის არეში არ არის' });
    // at — „ახლა“-ს ჩანაცვლება (მხოლოდ admin; ტესტი / რეტროსპექტივა): დასაფარის შედეგი, დატვირთვის საათები, „დღემდე“
    let at: number | undefined;
    if (q.at) {
      if (!has(u, 'admin')) throw new ForbiddenException('at — მხოლოდ ადმინისტრატორი');
      if (Number.isNaN(Date.parse(q.at))) throw new BadRequestException('at');
      at = Date.parse(q.at);
    }
    const f: Filt = { depts: q.department_id ? [q.department_id] : ac.depts, category: q.category || null, position_id: q.position_id || null, employment: q.employment || null };
    return { s, ac, f, months, at };
  }

  async meta(u: AuthUser) {
    const s = await this.rules();
    const ac = await this.access(u);
    const [depts, positions] = await Promise.all([
      this.db.selectFrom('departments').select(['id', 'name']).where('is_active', '=', true)
        .$if(!!ac.depts, (x) => x.where('id', 'in', ac.depts!.length ? ac.depts! : ['00000000-0000-0000-0000-000000000000'])).orderBy('name').execute(),
      this.db.selectFrom('staff_positions').select(['id', 'name', 'category']).where('is_active', '=', true).orderBy('sort_order').orderBy('name').execute(),
    ]);
    return { today: today(), access: ac, departments: depts, positions, categories: CATEGORIES.map((c) => ({ code: c, name: CATEGORY_KA[c] })),
      employment: EMPLOYMENT.map((c) => ({ code: c, name: EMP_KA[c] })),
      settings: { rpt_norm_low_pct: s.rpt_norm_low_pct, rpt_chronic_ot_months: s.rpt_chronic_ot_months, rpt_min_group: s.rpt_min_group, rpt_bradford: s.rpt_bradford,
        rpt_sick_types: s.rpt_sick_types, week_norm_hours: s.week_norm_hours, nurse_ratio: s.nurse_ratio } };
  }

  // ============================================================================================ შეჯამება
  async summary(u: AuthUser, q: Q) {
    const { s, ac, f, months, at } = await this.params(u, q);
    const from = months[0], to = monthEnd(months.at(-1)!);
    const trendMonths = q.trend === '0' ? [] : monthList(addDays(months.at(-1)!, -370), months.at(-1)!).slice(-13);
    const allMonths = [...new Set([...trendMonths, ...months])].sort();
    // თვიური — ადამიანი × თვე
    const pmBy = new Map<string, PM[]>();
    for (const m of allMonths) pmBy.set(m, await personMonths(this.db, s, m, f, ac.closedOnly));
    const pm = months.flatMap((m) => pmBy.get(m)!);
    // დღიური — ერთი გამოთვლა მთელ (ტრენდის) დიაპაზონზე, დეტალებით
    const raw = await loadDaily(this.db, s, allMonths[0], to, { depts: f.depts ?? null, category: f.category, detail: true, at });
    const inP = (d: string) => d >= from && d <= to;
    const names = new Map((await this.db.selectFrom('departments').select(['id', 'name']).execute()).map((d) => [d.id, d.name]));

    // ჯამები
    const total = monthAcc(pm, s);
    for (const [k, a] of raw.acc) if (inP(k.slice(0, 10))) addAcc(total, a);
    const kpi = rosterKpis(total);

    // ტრენდი
    const trend = trendMonths.map((m) => {
      const a = monthAcc(pmBy.get(m)!, s);
      const e = monthEnd(m);
      for (const [k, x] of raw.acc) { const d = k.slice(0, 10); if (d >= m && d <= e) addAcc(a, x); }
      return { month: m.slice(0, 7), preliminary: pmBy.get(m)!.some((p) => !p.closed), ...rounded(a), ...rosterKpis(a) };
    });

    // განყოფილებები (თვიური — ძირითადი; დღიური — განრიგის)
    const deptAcc = new Map<string, Acc>();
    const DA = (d: string) => deptAcc.get(d) ?? deptAcc.set(d, zeroAcc()).get(d)!;
    for (const p of pm) monthAcc([p], s, DA(p.department_id));
    for (const [k, a] of raw.acc) if (inP(k.slice(0, 10))) addAcc(DA(k.slice(11)), a);
    const minG = Number(s.rpt_min_group ?? 3);
    const byDept = [...deptAcc.entries()].map(([id, a]) => {
      const staffN = new Set(pm.filter((p) => p.department_id === id).map((p) => p.staff_id)).size;
      const k = rosterKpis(a);
      // A3: აგრეგატულ ხედვაში მცირე განყოფილებაში ბიულეტენი ცალკე არ ჩანს
      if (!ac.types && staffN < minG) k.roster_sick_pct = null;
      return { department_id: id, name: names.get(id) ?? '—', people: staffN, ...rounded(a), ...k, sick_masked: !ac.types && staffN < minG };
    }).sort((a, b) => a.name.localeCompare(b.name, 'ka'));

    // კატეგორიები (თვიური)
    const catAcc = new Map<string, Acc>();
    for (const p of pm) monthAcc([p], s, catAcc.get(p.category ?? '') ?? catAcc.set(p.category ?? '', zeroAcc()).get(p.category ?? '')!);
    const byCat = [...catAcc.entries()].map(([c, a]) => ({ category: c || null, name: c ? CATEGORY_KA[c as Category] : 'პოზიციის გარეშე', ...rounded(a), ...rosterKpis(a) }));

    // ---- ზეგანაკვეთი
    const byMonth = months.map((m) => { const a = monthAcc(pmBy.get(m)!, s); return { month: m.slice(0, 7), preliminary: pmBy.get(m)!.some((p) => !p.closed), ...rounded(a), ...rosterKpis(a) }; });
    const per = new Map<string, { staff_id: string; name: string; department_name: string; position_name: string | null; category: string | null; months: number; ot_months: number;
      norm: number; fact: number; credit: number; ot: number; ot_pay: number; ot_comp: number; under_months: number; no_show: number; abs_wd: number; sick_wd: number; emp_wd: number;
      no_home: number; preliminary: boolean }>();
    for (const p of pm) {
      const x = per.get(p.staff_id) ?? per.set(p.staff_id, { staff_id: p.staff_id, name: p.name, department_name: p.department_name, position_name: p.position_name, category: p.category,
        months: 0, ot_months: 0, norm: 0, fact: 0, credit: 0, ot: 0, ot_pay: 0, ot_comp: 0, under_months: 0, no_show: 0, abs_wd: 0, sick_wd: 0, emp_wd: 0, no_home: 0, preliminary: false }).get(p.staff_id)!;
      x.months++; if (p.ot > 0) x.ot_months++; x.norm += p.norm; x.fact += p.fact; x.credit += p.credit; x.ot += p.ot; x.ot_pay += p.ot_pay; x.ot_comp += p.ot_comp;
      if (p.fulfil !== null && p.fulfil < s.rpt_norm_low_pct) x.under_months++;
      x.no_show += p.no_show; x.abs_wd += p.abs_wd; x.sick_wd += p.sick_wd; x.emp_wd += p.emp_wd; if (!p.home_roster) x.no_home++; if (!p.closed) x.preliminary = true;
    }
    const people = [...per.values()].map((x) => ({ ...x, norm: r2(x.norm), fact: r2(x.fact), credit: r2(x.credit), ot: r2(x.ot), ot_pay: r2(x.ot_pay), ot_comp: r2(x.ot_comp),
      fulfil_pct: pct(x.fact + x.credit, x.norm) }));
    const curMonth = `${today().slice(0, 7)}-01`;
    const chronic = await chronicOvertime(this.db, s, f.depts ?? null, curMonth);
    const overtime = {
      by_month: byMonth,
      top: ac.named ? people.filter((x) => x.ot > 0).sort((a, b) => b.ot - a.ot).slice(0, 20) : [],
      chronic: ac.named ? chronic : [], chronic_count: chronic.length,
    };

    // ---- ნორმა
    const low = Number(s.rpt_norm_low_pct ?? 90);
    const buckets = { under: 0, normal: 0, over: 0, no_norm: 0 };
    for (const p of pm) { if (p.fulfil === null) buckets.no_norm++; else if (p.fulfil < low) buckets.under++; else if (p.fulfil <= 100) buckets.normal++; else buckets.over++; }
    const norm = {
      low_pct: low, buckets,
      under: ac.named ? pm.filter((p) => p.fulfil !== null && p.fulfil < low).sort((a, b) => (a.fulfil ?? 0) - (b.fulfil ?? 0)).slice(0, 50)
        .map((p) => ({ month: p.month.slice(0, 7), staff_id: p.staff_id, name: p.name, department_name: p.department_name, position_name: p.position_name, norm: r2(p.norm), fact: r2(p.fact),
          credit: r2(p.credit), fulfil_pct: p.fulfil, abs_wd: p.abs_wd, closed: p.closed })) : [],
      no_home: ac.named ? people.filter((x) => x.no_home > 0).map((x) => ({ staff_id: x.staff_id, name: x.name, department_name: x.department_name, months: x.no_home, fact: x.fact, ot: x.ot }))
        : [],
      no_home_count: people.filter((x) => x.no_home > 0).length,
    };

    // ---- გაცდენა / არყოფნა
    const typeAgg = new Map<string, { code: string; name: string; short: string; paid: boolean; counts_as_work: boolean; days: number; workdays: number; people: Set<string> }>();
    const sick = new Set(s.rpt_sick_types ?? ['SICK']);
    for (const p of pm) for (const a of p.absence) {
      const key = ac.types ? a.code : a.counts_as_work ? 'WORK' : sick.has(a.code) ? 'SICK' : a.paid ? 'PAID' : 'UNPAID';
      const nm = ac.types ? a.name : { WORK: 'ნამუშევრად ითვლება', SICK: 'ბიულეტენი', PAID: 'ანაზღაურებადი', UNPAID: 'ანაზღაურების გარეშე' }[key]!;
      const x = typeAgg.get(key) ?? typeAgg.set(key, { code: key, name: nm, short: ac.types ? a.short : '', paid: a.paid, counts_as_work: a.counts_as_work, days: 0, workdays: 0, people: new Set() }).get(key)!;
      x.days += a.days; x.workdays += a.workdays; x.people.add(p.staff_id);
    }
    // A3: აგრეგატულ ხედვაში ბიულეტენი ცალკე არ ჩანს, თუ ადამიანი < rpt_min_group — ერთიანდება „ანაზღაურებადში“
    if (!ac.types) {
      const sk = typeAgg.get('SICK');
      if (sk && sk.people.size < minG) {
        const pd = typeAgg.get('PAID') ?? typeAgg.set('PAID', { code: 'PAID', name: 'ანაზღაურებადი', short: '', paid: true, counts_as_work: false, days: 0, workdays: 0, people: new Set() }).get('PAID')!;
        pd.days += sk.days; pd.workdays += sk.workdays; for (const x of sk.people) pd.people.add(x);
        typeAgg.delete('SICK');
      }
    }
    const empWd = total.emp_wd;
    const byType = [...typeAgg.values()].map((x) => ({ code: x.code, name: x.name, short: x.short, paid: x.paid, counts_as_work: x.counts_as_work, days: r1(x.days), workdays: x.workdays,
      people: x.people.size, pct: x.counts_as_work ? null : pct(x.workdays, empWd) })).sort((a, b) => b.workdays - a.workdays);
    const staffNames = await this.staffNames([...new Set([...raw.noShow.map((x) => x.staff_id), ...raw.violations.map((x) => x.staff_id), ...raw.swaps.map((x) => x.from_staff_id)])]);
    // no_show — დეტალი მთელ დიაპაზონზე; პერიოდში ხელახლა ვითვლით
    const nsPer = new Map<string, number>();
    for (const p of pm) if (p.no_show > 0) nsPer.set(p.staff_id, (nsPer.get(p.staff_id) ?? 0) + p.no_show);
    let bradford: { staff_id: string; name: string; department_name: string; spells: number; days: number; score: number }[] = [];
    if (s.rpt_bradford && ac.named) {
      const sp = await this.db.selectFrom('absence_requests as a').innerJoin('absence_types as t', 't.id', 'a.absence_type_id')
        .select(['a.staff_id']).select((eb) => eb.fn.countAll<number>().as('n'))
        .where('a.status', '=', 'approved').where('t.code', 'in', [...sick]).where('a.date_from', '<=', to).where('a.date_to', '>=', from)
        .where('a.staff_id', 'in', pm.length ? [...new Set(pm.map((p) => p.staff_id))] : ['00000000-0000-0000-0000-000000000000']).groupBy('a.staff_id').execute();
      bradford = sp.map((x) => { const P = per.get(x.staff_id); const S = Number(x.n), D = P?.sick_wd ?? 0;
        return { staff_id: x.staff_id, name: P?.name ?? staffNames.get(x.staff_id) ?? '—', department_name: P?.department_name ?? '', spells: S, days: D, score: S * S * D }; })
        .sort((a, b) => b.score - a.score).slice(0, 30);
    }
    const absence = {
      by_type: byType, types_visible: ac.types,
      no_show_people: ac.named ? [...nsPer.entries()].map(([id, n]) => ({ staff_id: id, name: per.get(id)?.name ?? staffNames.get(id) ?? '—', department_name: per.get(id)?.department_name ?? '', no_show: n }))
        .sort((a, b) => b.no_show - a.no_show).slice(0, 30) : [],
      bradford, bradford_enabled: !!s.rpt_bradford,
    };

    // ---- დასაფარი
    const open = raw.open.filter((x) => inP(x.day));
    const grp = <K extends string>(xs: typeof open, key: (x: (typeof open)[number]) => K, label: (k: K) => string) => {
      const m = new Map<K, { n: number; ontime: number; late: number; unfilled: number; pending: number; fill: number; volunteer: number; lead: number }>();
      for (const x of xs) {
        const g = m.get(key(x)) ?? m.set(key(x), { n: 0, ontime: 0, late: 0, unfilled: 0, pending: 0, fill: 0, volunteer: 0, lead: 0 }).get(key(x))!;
        g[x.outcome]++; if (x.outcome !== 'pending') { g.n++; g.lead += x.lead_h; } if (x.fill_h !== null) g.fill += x.fill_h; if (x.volunteer && x.status === 'filled') g.volunteer++;
      }
      return [...m.entries()].map(([k, g]) => ({ key: k, name: label(k), n: g.n, ontime: g.ontime, late: g.late, unfilled: g.unfilled, pending: g.pending, volunteer: g.volunteer,
        filled_pct: pct(g.ontime, g.n), fill_h_avg: g.ontime + g.late ? r1(g.fill / (g.ontime + g.late)) : null, lead_h_avg: g.n ? r1(g.lead / g.n) : null })).sort((a, b) => b.n + b.pending - a.n - a.pending);
    };
    const openSec = {
      totals: grp(open, () => 'all', () => 'სულ')[0] ?? null,
      by_source: grp(open, (x) => x.source, (k) => SOURCE_KA[k] ?? k),
      by_department: grp(open, (x) => x.department_id, (k) => names.get(k) ?? '—'),
      by_category: grp(open, (x) => x.category ?? '', (k) => (k ? CATEGORY_KA[k as Category] : 'ნებისმიერი')),
      by_kind: grp(open, (x) => x.kind, (k) => KIND_KA[k] ?? k),
      list: open.slice(0, 500).map((x) => ({ ...x, department_name: names.get(x.department_id) ?? '—', outcome_name: OUTCOME_KA[x.outcome], source_name: SOURCE_KA[x.source] ?? x.source })),
    };

    // ---- გაცვლები
    const sws = raw.swaps.filter((x) => inP(x.day));
    const avg = (xs: (number | null)[]) => { const v = xs.filter((x): x is number => x !== null); return v.length ? r1(v.reduce((a, b) => a + b, 0) / v.length) : null; };
    const cnt = <T,>(xs: T[], key: (x: T) => string) => { const m = new Map<string, number>(); for (const x of xs) m.set(key(x), (m.get(key(x)) ?? 0) + 1); return m; };
    const swapSec = {
      totals: { n: sws.length, approved: total.swaps_approved, refused: total.swaps_refused, lapsed: total.swaps_lapsed,
        pending: sws.filter((x) => x.status === 'peer' || x.status === 'head').length, per100: total.shifts ? r1((sws.length / total.shifts) * 100) : null,
        approved_pct: pct(total.swaps_approved, total.swaps_approved + total.swaps_refused), peer_h_avg: avg(sws.map((x) => x.peer_h)),
        head_h_avg: avg(sws.filter((x) => x.status === 'approved' || x.status === 'rejected').map((x) => x.head_h)), decided_h_avg: avg(sws.map((x) => x.decided_h)) },
      by_kind: [...cnt(sws, (x) => x.kind)].map(([k, n]) => ({ key: k, name: k === 'swap' ? 'გაცვლა' : 'გადაცემა', n })),
      by_status: [...cnt(sws, (x) => x.status)].map(([k, n]) => ({ key: k, name: SWAP_KA[k] ?? k, n })).sort((a, b) => b.n - a.n),
      by_department: [...cnt(sws, (x) => x.department_id)].map(([k, n]) => {
        const a = deptAcc.get(k); return { department_id: k, name: names.get(k) ?? '—', n, approved: sws.filter((x) => x.department_id === k && x.status === 'approved').length,
          per100: a?.shifts ? r1((n / a.shifts) * 100) : null }; }).sort((a, b) => b.n - a.n),
      top: ac.named ? [...cnt(sws, (x) => x.from_staff_id)].map(([k, n]) => ({ staff_id: k, name: staffNames.get(k) ?? '—', n })).sort((a, b) => b.n - a.n).slice(0, 15) : [],
    };

    // ---- ხარვეზები
    const gapAgg = (xs: DayRaw['normGaps']) => {
      const m = new Map<string, { department_id: string; key: string; label: string; category: string | null; need: number; days_plan: number; days_fact: number; plan: number; fact: number }>();
      for (const g of xs.filter((x) => inP(x.day))) {
        const k = `${g.department_id}|${g.key}`;
        const x = m.get(k) ?? m.set(k, { department_id: g.department_id, key: g.key, label: g.label, category: g.category, need: g.need, days_plan: 0, days_fact: 0, plan: 0, fact: 0 }).get(k)!;
        const gp = Math.max(0, g.need - g.plan), gf = Math.max(0, g.need - g.fact);
        x.plan += gp; x.fact += gf; if (gp) x.days_plan++; if (gf) x.days_fact++;
      }
      return [...m.values()].map((x) => ({ ...x, department_name: names.get(x.department_id) ?? '—', category_name: x.category ? CATEGORY_KA[x.category as Category] : null }))
        .sort((a, b) => b.fact - a.fact);
    };
    const gaps = {
      by_norm: gapAgg(raw.normGaps), by_duty: gapAgg(raw.dutyGaps),
      days: [...raw.normGaps, ...raw.dutyGaps].filter((x) => inP(x.day)).sort((a, b) => (b.need - b.fact) - (a.need - a.fact) || a.day.localeCompare(b.day)).slice(0, 200)
        .map((x) => ({ ...x, kind: raw.dutyGaps.includes(x) ? 'duty' : 'norm', department_name: names.get(x.department_id) ?? '—' })),
    };

    // ---- წესები
    const viol = raw.violations.filter((x) => inP(x.day));
    const rules = {
      by_rule: ['rest', 'continuous', 'week', 'nights'].map((k) => ({ key: k, name: RULE_KA[k], n: viol.filter((x) => x.rule === k).length, mode: (s as unknown as Record<string, string>)[`${k}_mode`] })),
      people: ac.named ? [...cnt(viol, (x) => x.staff_id)].map(([k, n]) => ({ staff_id: k, name: staffNames.get(k) ?? '—', n,
        rules: [...new Set(viol.filter((x) => x.staff_id === k).map((x) => RULE_KA[x.rule]))].join(', ') })).sort((a, b) => b.n - a.n).slice(0, 30) : [],
      list: ac.named ? viol.slice(0, 300).map((x) => ({ ...x, name: staffNames.get(x.staff_id) ?? '—', department_name: names.get(x.department_id) ?? '—', rule_name: RULE_KA[x.rule] })) : [],
    };

    // ---- დატვირთვა (პერიოდი; raw.load — მთელი დიაპაზონი → ხელახლა პერიოდში)
    const loadDept = new Map<string, Acc>();
    for (const [k, a] of raw.acc) if (inP(k.slice(0, 10)) && (a.pt_h > 0 || a.nurse_h > 0)) addAcc(loadDept.get(k.slice(11)) ?? loadDept.set(k.slice(11), zeroAcc()).get(k.slice(11))!, a);
    const meta = new Map(raw.load.map((x) => [x.department_id, x]));
    const load = {
      ratio_limits: s.nurse_ratio,
      by_department: [...loadDept.entries()].map(([id, a]) => ({ department_id: id, name: names.get(id) ?? '—', care_level: meta.get(id)?.care_level ?? 'ward',
        care_name: CARE_KA[meta.get(id)?.care_level ?? 'ward'], limit: meta.get(id)?.limit ?? null, pt_h: r1(a.pt_h), nurse_h: r1(a.nurse_h),
        ratio: a.nurse_h > 0 ? r1(a.pt_h / a.nurse_h) : null, census_h: a.census_h, over_h: a.over_h, over_pct: pct(a.over_h, a.census_h), nonurse_h: a.nonurse_h,
        avg_patients: a.census_h ? r1(a.pt_h / Math.max(1, a.census_h)) : null })).sort((a, b) => a.name.localeCompare(b.name, 'ka')),
      // ტრენდის დიაპაზონზე (ინფორმაციული პროფილი)
      by_hour: raw.hourly.map((h, i) => ({ hour: i, ratio: h.nurse > 0 ? r1(h.pt / h.nurse) : null, pt_h: r1(h.pt), nurse_h: r1(h.nurse) })),
      day_night: Object.entries(raw.dayNight).map(([k, v]) => ({ key: k, name: { day: 'დღე', night: 'ღამე', weekend: 'შაბ.–კვ.', weekday: 'სამუშაო დღე' }[k], ratio: v.nurse > 0 ? r1(v.pt / v.nurse) : null,
        over_pct: pct(v.over, v.census), census_h: v.census })),
      profile_from: allMonths[0].slice(0, 7),
    };

    return {
      from: from.slice(0, 7), to: to.slice(0, 7), months: months.map((m) => m.slice(0, 7)), scope_label: ac.label, access: ac,
      preliminary: months.filter((m) => pmBy.get(m)!.some((p) => !p.closed)).map((m) => m.slice(0, 7)),
      today: today(), totals: rounded(total), kpi, trend, by_department: byDept, by_category: byCat,
      overtime, norm, absence, open: openSec, swaps: swapSec, gaps, rules, load,
      settings: { rpt_norm_low_pct: low, rpt_chronic_ot_months: s.rpt_chronic_ot_months, rpt_min_group: minG, week_norm_hours: s.week_norm_hours },
      people: ac.named ? people.sort((a, b) => a.name.localeCompare(b.name, 'ka')) : [],
      person_months: ac.named ? pm.map((p) => ({ month: p.month.slice(0, 7), staff_id: p.staff_id, name: p.name, personal_number: p.personal_number, department_name: p.department_name,
        position_name: p.position_name, category: p.category, employment: p.employment, fte: p.fte, closed: p.closed, no_home: !p.home_roster, norm: r2(p.norm), fact: r2(p.fact),
        credit: r2(p.credit), ot: r2(p.ot), ot_pay: r2(p.ot_pay), ot_comp: r2(p.ot_comp), fulfil_pct: p.fulfil, night: r2(p.night), holiday: r2(p.holiday), weekend: r2(p.weekend),
        no_show: p.no_show, emp_wd: p.emp_wd, abs_wd: p.abs_wd, sick_wd: ac.types ? p.sick_wd : null })) : [],
    };
  }

  private async staffNames(idList: string[]) {
    if (!idList.length) return new Map<string, string>();
    const rows = await this.db.selectFrom('staff_members').select(['id', 'last_name', 'first_name']).where('id', 'in', idList).execute();
    return new Map(rows.map((x) => [x.id, `${x.last_name} ${x.first_name}`]));
  }

  // ============================================================================================ Excel
  async export(u: AuthUser, q: Q, req: Request) {
    const d = await this.summary(u, { ...q, trend: '1' });
    const clinic = (await this.db.selectFrom('clinic_settings').select('name').where('id', '=', 1).executeTakeFirst())?.name ?? '';
    await this.audit.log(auditCtx(req), { action: 'ROSTER_REPORT_EXPORT', entityName: 'roster_reports', entityId: 'summary', newData: { from: d.from, to: d.to, scope: d.scope_label, filters: q } });
    return { name: `roster_report_${d.from}_${d.to}.xlsx`, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: writeXlsxBook(this.sheets(d, clinic)) };
  }

  private sheets(d: Awaited<ReturnType<RosterReportService['summary']>>, clinic: string): SheetSpec[] {
    const num = (v: unknown, fmt = '0.##'): Cell => (v === null || v === undefined || Number.isNaN(Number(v)) ? null : { v: Number(v), fmt });
    const int = (v: unknown) => num(v, '0');
    const head = [[clinic], [`ცვლები / მორიგეობა — ანგარიში · ${d.from} — ${d.to} · ${d.scope_label}${d.preliminary.length ? ` · წინასწარი: ${d.preliminary.join(', ')}` : ''}`], []];
    const K = d.kpi as Record<string, number | null>;
    const KPI_KA: Record<string, string> = {
      roster_overtime_h: 'ზეგანაკვეთი, სთ', roster_overtime_pct: 'ზეგანაკვეთი ნორმასთან, %', roster_norm_fulfil_pct: 'ნორმის შესრულება, %', roster_no_show_pct: '„არ გამოცხადდა“, %',
      roster_absence_pct: 'არყოფნა, %', roster_sick_pct: 'ბიულეტენი, %', roster_open_filled_pct: 'დასაფარი დაფარულია დაწყებამდე, %', roster_open_fill_h: 'დაფარვამდე, სთ',
      roster_norm_gaps: 'ნორმის ხარვეზი (ფაქტით)', roster_duty_gaps: 'მორიგის ხარვეზი (ფაქტით)', roster_nurse_ratio: 'პაციენტი / ექთანი', roster_load_over_pct: 'დატვირთვა ზღვარზე მეტი, %' };
    const sheets: SheetSpec[] = [];
    const T = d.totals as Record<string, number>;
    sheets.push({ name: 'შეჯამება', rows: [...head, ['მაჩვენებელი', 'მნიშვნელობა'], ...KPI_CODES.map((k) => [KPI_KA[k], num(K[k])]), [],
      ['თანამშრომელი-თვე', int(T.staff)], ['მათგან დახურული', int(T.closed_staff)], ['ნორმა, სთ', num(T.norm_h)], ['ფაქტი, სთ', num(T.fact_h)], ['ჩათვლილი, სთ', num(T.credit_h)],
      ['ზეგანაკვეთი — ანაზღ., სთ', num(T.ot_pay_h)], ['ზეგანაკვეთი — COMP, სთ', num(T.ot_comp_h)], ['ღამე, სთ', num(T.night_h)], ['დღესასწაული, სთ', num(T.holiday_h)], ['შაბ.–კვ., სთ', num(T.weekend_h)],
      ['გეგმიური ცვლები', int(T.shifts)], ['„არ გამოცხადდა“', int(T.no_show)], ['წესის დარღვევა', int(T.viol_rest + T.viol_continuous + T.viol_week + T.viol_nights)],
      ['დასაფარი (დაწყება გასულია)', int(T.open_n)], ['გაცვლა / გადაცემა', int(T.swaps)]], widths: [40, 16], boldRows: [3] });
    const kcols = KPI_CODES;
    sheets.push({ name: 'ტრენდი', header: ['თვე', 'წინასწ.', ...kcols.map((k) => KPI_KA[k])], rows: d.trend.map((t) => [t.month, t.preliminary ? 'კი' : '', ...kcols.map((k) => num((t as Record<string, unknown>)[k]))]), widths: [10, 8, ...kcols.map(() => 14)] });
    sheets.push({ name: 'განყოფილებები', header: ['განყოფილება', 'ადამიანი', 'ნორმა', 'ფაქტი', 'ზეგანაკვ.', 'ზეგ. %', 'შესრულება %', 'ცვლები', '„გ“ %', 'არყოფნა %', 'ბიულეტ. %',
      'ნორმის ხარვ.', 'მორიგის ხარვ.', 'დასაფარი', 'დაფარ. დაწყებამდე %', 'გაცვლები', 'პაციენტი / ექთანი', 'ზღვარზე მეტი %'],
      rows: d.by_department.map((x) => [x.name, int(x.people), num(x.norm_h), num(x.fact_h), num(x.ot_h), num(x.roster_overtime_pct), num(x.roster_norm_fulfil_pct), int(x.shifts), num(x.roster_no_show_pct),
        num(x.roster_absence_pct), num(x.roster_sick_pct), int(x.norm_gaps_fact), int(x.duty_gaps_fact), int(x.open_n), num(x.roster_open_filled_pct), int(x.swaps), num(x.roster_nurse_ratio),
        num(x.roster_load_over_pct)]), widths: [28] });
    sheets.push({ name: 'ზეგანაკვეთი', header: ['თვე', 'წინასწ.', 'ადამიანი', 'ნორმა', 'ფაქტი', 'ჩათვლ.', 'ზეგანაკვეთი', 'ანაზღ.', 'COMP', 'ზეგ. მქონე', 'ზეგ. %'],
      rows: [...d.overtime.by_month.map((x) => [x.month, x.preliminary ? 'კი' : '', int(x.staff), num(x.norm_h), num(x.fact_h), num(x.credit_h), num(x.ot_h), num(x.ot_pay_h), num(x.ot_comp_h),
        int(x.ot_staff), num(x.roster_overtime_pct)]),
      ...(d.access.named ? [[], ['ტოპ ზეგანაკვეთი'], ['თანამშრომელი', 'განყოფილება', 'პოზიცია', 'თვეები', 'ზეგ. თვეები', 'ნორმა', 'ფაქტი', 'ზეგანაკვეთი', 'ანაზღ.', 'COMP'],
        ...d.overtime.top.map((x) => [x.name, x.department_name, x.position_name, int(x.months), int(x.ot_months), num(x.norm), num(x.fact), num(x.ot), num(x.ot_pay), num(x.ot_comp)]),
        [], [`ქრონიკული (ბოლო 6 დახურული თვიდან ≥ ${d.settings.rpt_chronic_ot_months})`], ['თანამშრომელი', 'განყოფილება', 'თვეები', 'ზეგანაკვეთი'],
        ...d.overtime.chronic.map((x) => [x.name, x.department_name, int(x.months), num(x.ot)])] : [])], widths: [26, 22, 18] });
    sheets.push({ name: 'ნორმა', rows: [['ჯგუფი', 'ადამიანი-თვე'], [`< ${d.norm.low_pct}%`, int(d.norm.buckets.under)], [`${d.norm.low_pct}–100%`, int(d.norm.buckets.normal)], ['> 100%', int(d.norm.buckets.over)],
      ['ნორმა 0', int(d.norm.buckets.no_norm)], [],
      ...(d.access.named ? [['ნორმაზე ნაკლები'], ['თვე', 'თანამშრომელი', 'განყოფილება', 'პოზიცია', 'ნორმა', 'ფაქტი', 'ჩათვლ.', 'შესრულება %', 'არყ. სამ. დღე', 'დახურული'],
        ...d.norm.under.map((x) => [x.month, x.name, x.department_name, x.position_name, num(x.norm), num(x.fact), num(x.credit), num(x.fulfil_pct), int(x.abs_wd), x.closed ? 'კი' : '']), [],
        ['ძირ. განყოფილების განრიგის გარეშე'], ['თანამშრომელი', 'განყოფილება', 'თვეები', 'ფაქტი', 'ზეგანაკვეთი'],
        ...d.norm.no_home.map((x) => [x.name, x.department_name, int(x.months), num(x.fact), num(x.ot)])] : [['ძირ. განყოფილების განრიგის გარეშე', int(d.norm.no_home_count)]])], widths: [20, 26, 22] });
    sheets.push({ name: 'არყოფნა', rows: [[d.absence.types_visible ? 'ტიპი' : 'კლასი', 'დღე (ერთეულით)', 'სამუშაო დღე', 'ადამიანი', '% სამუშაო დღეებიდან'],
      ...d.absence.by_type.map((x) => [x.name, num(x.days), int(x.workdays), int(x.people), num(x.pct)]),
      ...(d.access.named ? [[], ['„არ გამოცხადდა“'], ['თანამშრომელი', 'განყოფილება', 'რაოდენობა'], ...d.absence.no_show_people.map((x) => [x.name, x.department_name, int(x.no_show)])] : []),
      ...(d.absence.bradford.length ? [[], ['Bradford factor (S² × D)'], ['თანამშრომელი', 'განყოფილება', 'ეპიზოდი (S)', 'სამ. დღე (D)', 'ქულა'],
        ...d.absence.bradford.map((x) => [x.name, x.department_name, int(x.spells), int(x.days), int(x.score)])] : [])], widths: [34, 16, 14] });
    const oh = ['ჭრილი', 'დასაფარი', 'დაწყებამდე', 'გვიან', 'დაუფარავი', 'ღია (მომავალი)', 'მოხალისე', 'დაფარულია დაწყებამდე %', 'დაფარვამდე, სთ', 'წინასწარობა, სთ'];
    const orow = (x: (typeof d.open.by_source)[number]) => [x.name, int(x.n), int(x.ontime), int(x.late), int(x.unfilled), int(x.pending), int(x.volunteer), num(x.filled_pct), num(x.fill_h_avg), num(x.lead_h_avg)];
    sheets.push({ name: 'დასაფარი', rows: [oh, ...(d.open.totals ? [orow(d.open.totals)] : []), [], ['წყარო'], ...d.open.by_source.map(orow), [], ['განყოფილება'], ...d.open.by_department.map(orow),
      [], ['კატეგორია'], ...d.open.by_category.map(orow), [], ['ცვლის სახე'], ...d.open.by_kind.map(orow)], widths: [28] });
    sheets.push({ name: 'დასაფარი (სია)', header: ['დღე', 'განყოფილება', 'ცვლა', 'წყარო', 'კატეგორია', 'შედეგი', 'მოხალისე', 'დაფარვამდე, სთ', 'წინასწარობა, სთ'],
      rows: d.open.list.map((x) => [x.day, x.department_name, x.code, x.source_name, x.category ? CATEGORY_KA[x.category as Category] : '', x.outcome_name, x.volunteer ? 'კი' : '', num(x.fill_h), num(x.lead_h)]), widths: [11, 24] });
    const st = d.swaps.totals;
    sheets.push({ name: 'გაცვლები', rows: [['სულ', int(st.n)], ['დადასტურდა', int(st.approved)], ['უარი', int(st.refused)], ['ვადა გავიდა / გაუქმდა', int(st.lapsed)], ['მიმდინარე', int(st.pending)],
      ['100 ცვლაზე', num(st.per100)], ['დადასტურების %', num(st.approved_pct)], ['კოლეგის პასუხი, სთ', num(st.peer_h_avg)], ['ხელმძღვანელის გადაწყვეტა, სთ', num(st.head_h_avg)], [],
      ['სტატუსი', 'რაოდენობა'], ...d.swaps.by_status.map((x) => [x.name, int(x.n)]), [], ['განყოფილება', 'რაოდენობა', 'დადასტურდა', '100 ცვლაზე'],
      ...d.swaps.by_department.map((x) => [x.name, int(x.n), int(x.approved), num(x.per100)]),
      ...(d.access.named ? [[], ['ინიციატორი', 'რაოდენობა'], ...d.swaps.top.map((x) => [x.name, int(x.n)])] : [])], widths: [30, 14] });
    sheets.push({ name: 'ხარვეზები', rows: [['შევსების ნორმა'], ['განყოფილება', 'ცვლა', 'კატეგორია', 'საჭირო', 'დღე (გეგმით)', 'დაკლ. (გეგმით)', 'დღე (ფაქტით)', 'დაკლ. (ფაქტით)'],
      ...d.gaps.by_norm.map((x) => [x.department_name, x.label, x.category_name, int(x.need), int(x.days_plan), int(x.plan), int(x.days_fact), int(x.fact)]), [],
      ['მორიგეობა (I დონე)'], ['განყოფილება', 'როლი', '', 'საჭირო', 'დღე (გეგმით)', 'დაკლ. (გეგმით)', 'დღე (ფაქტით)', 'დაკლ. (ფაქტით)'],
      ...d.gaps.by_duty.map((x) => [x.department_name, x.label, '', int(x.need), int(x.days_plan), int(x.plan), int(x.days_fact), int(x.fact)])], widths: [26, 24, 16] });
    sheets.push({ name: 'წესები', rows: [['წესი', 'დარღვევა', 'რეჟიმი'], ...d.rules.by_rule.map((x) => [x.name, int(x.n), x.mode]),
      ...(d.access.named ? [[], ['დღე', 'თანამშრომელი', 'განყოფილება', 'წესი', 'აღწერა'], ...d.rules.list.map((x) => [x.day, x.name, x.department_name, x.rule_name, x.message])] : [])], widths: [26, 26, 22, 22, 50] });
    sheets.push({ name: 'დატვირთვა', rows: [['განყოფილება', 'დონე', 'ზღვარი', 'პაციენტ-სთ', 'ექთან-სთ', 'პაციენტი / ექთანი', 'სთ პაციენტით', 'ზღვარზე მეტი, სთ', 'ზღვარზე მეტი %', 'ექთნის გარეშე, სთ'],
      ...d.load.by_department.map((x) => [x.name, x.care_name, num(x.limit), num(x.pt_h), num(x.nurse_h), num(x.ratio), int(x.census_h), int(x.over_h), num(x.over_pct), int(x.nonurse_h)]), [],
      [`საათობრივი პროფილი (${d.load.profile_from}-დან)`], ['საათი', 'პაციენტი / ექთანი'], ...d.load.by_hour.map((x) => [`${String(x.hour).padStart(2, '0')}:00`, num(x.ratio)]), [],
      ['ჭრილი', 'პაციენტი / ექთანი', 'ზღვარზე მეტი %'], ...d.load.day_night.map((x) => [x.name, num(x.ratio), num(x.over_pct)])], widths: [26, 14] });
    if (d.access.named) sheets.push({ name: 'ადამიანი × თვე', header: ['თვე', 'თანამშრომელი', 'პირადი №', 'განყოფილება', 'პოზიცია', 'კატეგორია', 'FTE', 'სტატუსი', 'ნორმა', 'ფაქტი', 'ჩათვლ.',
      'ზეგანაკვეთი', 'ანაზღ.', 'COMP', 'შესრულება %', 'ღამე', 'დღესასწ.', 'შაბ.–კვ.', '„გ“', 'სამ. დღე', 'არყ. სამ. დღე', 'ბიულ. სამ. დღე'],
      rows: d.person_months.map((x) => [x.month, x.name, x.personal_number, x.department_name, x.position_name, x.category ? CATEGORY_KA[x.category as Category] : '', num(x.fte),
        x.closed ? 'დახურული' : x.no_home ? 'წინასწ. · ძირ. განრიგის გარეშე' : 'წინასწარი', num(x.norm), num(x.fact), num(x.credit), num(x.ot), num(x.ot_pay), num(x.ot_comp), num(x.fulfil_pct),
        num(x.night), num(x.holiday), num(x.weekend), int(x.no_show), int(x.emp_wd), int(x.abs_wd), num(x.sick_wd)]), widths: [9, 26, 13, 22, 20] });
    return sheets;
  }
}

function rounded(a: Acc) {
  const o: Record<string, number> = {};
  for (const k of ACC_KEYS) o[k] = r2(a[k]);
  return o as Acc;
}

@Controller('roster')
export class RosterReportController {
  constructor(private readonly s: RosterReportService) {}
  @Get('reports/meta') meta(@CurrentUser() u: AuthUser) { return this.s.meta(u); }
  @Get('reports/summary') summary(@CurrentUser() u: AuthUser, @Query() q: Q) { return this.s.summary(u, q); }
  @Get('reports/export')
  async export(@CurrentUser() u: AuthUser, @Query() q: Q, @Req() r: Request, @Res({ passthrough: true }) res: Response) {
    const out = await this.s.export(u, q, r);
    res.set({ 'Content-Type': out.type, 'Content-Disposition': `attachment; filename="${encodeURIComponent(out.name)}"` });
    return new StreamableFile(out.body);
  }
}
