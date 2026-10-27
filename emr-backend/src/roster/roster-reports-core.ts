import { sql, type Transaction } from 'kysely';
import type { Database } from '../database/database.module';
import type { DB } from '../database/db';
import { RosterLookup, addDays, evaluate, localDay, localMs, monthDays, ratioLimit, staffName, today, tz, type Ex, type RosterSettings, type RuleEntry } from './roster-common';
import { factOf, gatherHours, hoursRow, splitOt, type AbsSum, type G } from './roster-hours-core';

/**
 * ცვლები / მორიგეობა, ეტაპი 4 (0080) — ანგარიშების / KPI-ის საერთო გამოთვლა (ანგარიშის გვერდი, რეპორტინგის გადათვლა — rpt_fact_roster / _month, „ყურადღება“).
 *
 *  • თვიური (ადამიანი × თვე): ტაბელში მოხვედრილი თანამშრომელი — ძირითადი განყოფილების თვის განრიგი გამოქვეყნებული / დახურულია, ან თვეში აქვს ჩანაწერი
 *      (გამოქვეყნებულ / დახურულ განრიგში). დახურული ძირითადი განრიგი → snapshot (roster_timesheets, home); სხვა → ცოცხალი (hoursRow), „წინასწარი“.
 *  • დღიური (დღე × განრიგის განყოფილება, დღემდე): ცვლები / „არ გამოცხადდა“, ნორმის / მორიგის ხარვეზები (გეგმით / ფაქტით), წესები (ფაქტით),
 *      დასაფარი (დაწყების დღით, დაწყება გასულია), გაცვლები (შექმნის დღით), დატვირთვა (საათობრივი, სტაციონარი, თვის განრიგით).
 */
export interface RptRules {
  rpt_norm_low_pct: number; rpt_chronic_ot_months: number; rpt_open_urgent_hours: number; rpt_close_late_days: number; rpt_min_group: number;
  rpt_bradford: boolean; rpt_sick_types: string[]; dashboard_visibility: 'report_users' | 'roster_only'; monthly_section: boolean;
}
export const RPT_DEFAULTS: RptRules = { rpt_norm_low_pct: 90, rpt_chronic_ot_months: 3, rpt_open_urgent_hours: 24, rpt_close_late_days: 5, rpt_min_group: 3,
  rpt_bradford: false, rpt_sick_types: ['SICK'], dashboard_visibility: 'report_users', monthly_section: true };
export type Rules = RosterSettings & RptRules;

/** მოდული ჩართულია → პარამეტრები (ანგარიშების ნაგულისხმევებით); გამორთული → null */
export async function rosterRptRules(db: Ex): Promise<Rules | null> {
  const m = await db.selectFrom('system_modules').select(['enabled', 'settings']).where('code', '=', 'roster').executeTakeFirst();
  if (!m?.enabled) return null;
  return { ...RPT_DEFAULTS, ...((m.settings ?? {}) as Partial<Rules>) } as Rules;
}

export interface Filt { depts?: string[] | null; category?: string | null; position_id?: string | null; employment?: string | null }

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const pct = (a: number, b: number) => (b > 0 ? r1((a / b) * 100) : null);
const NIL = '00000000-0000-0000-0000-000000000000';
const ids = (xs: string[]) => (xs.length ? xs : [NIL]);
export const monthEnd = (m: string) => monthDays(m).at(-1)!;
/** YYYY-MM-01 … YYYY-MM-01 (ჩათვლით) */
export function monthList(from: string, to: string) {
  const out: string[] = [];
  let [y, m] = from.slice(0, 7).split('-').map(Number);
  const end = to.slice(0, 7);
  for (;;) { const k = `${y}-${String(m).padStart(2, '0')}`; if (k > end) break; out.push(`${k}-01`); m++; if (m > 12) { m = 1; y++; } }
  return out;
}

// ============================================================================================ ჯამები
export const MONTH_KEYS = ['staff', 'closed_staff', 'norm_h', 'fact_h', 'credit_h', 'ot_h', 'ot_pay_h', 'ot_comp_h', 'ot_staff', 'under_staff', 'emp_wd', 'abs_wd', 'sick_wd',
  'night_h', 'holiday_h', 'weekend_h'] as const;
export const DAY_KEYS = ['shifts', 'no_show', 'norm_gaps_plan', 'norm_gaps_fact', 'duty_gaps_plan', 'duty_gaps_fact', 'viol_rest', 'viol_continuous', 'viol_week', 'viol_nights',
  'open_n', 'open_ontime', 'open_late', 'open_unfilled', 'open_volunteer', 'open_fill_h', 'open_lead_h', 'swaps', 'swaps_approved', 'swaps_refused', 'swaps_lapsed', 'swaps_decided_h',
  'pt_h', 'nurse_h', 'census_h', 'over_h', 'nonurse_h'] as const;
export const ACC_KEYS = [...MONTH_KEYS, ...DAY_KEYS] as const;
export type AccKey = (typeof ACC_KEYS)[number];
export type Acc = Record<AccKey, number>;
export const zeroAcc = (): Acc => Object.fromEntries(ACC_KEYS.map((k) => [k, 0])) as Acc;
export const addAcc = (a: Acc, b: Partial<Record<string, number | string | null>>) => { for (const k of ACC_KEYS) a[k] += Number(b[k] ?? 0) || 0; return a; };
const FLOAT_KEYS = new Set<string>(['norm_h', 'fact_h', 'credit_h', 'ot_h', 'ot_pay_h', 'ot_comp_h', 'night_h', 'holiday_h', 'weekend_h', 'open_fill_h', 'open_lead_h', 'swaps_decided_h', 'pt_h', 'nurse_h']);

/** KPI-ები ჯამებიდან (ანგარიში, მენეჯერული დაფა — ერთი წესი) */
export function rosterKpis(a: Acc) {
  const filled = a.open_ontime + a.open_late;
  return {
    roster_overtime_h: a.staff > 0 ? r1(a.ot_h) : null,
    roster_overtime_pct: pct(a.ot_h, a.norm_h),
    roster_norm_fulfil_pct: pct(a.fact_h + a.credit_h, a.norm_h),
    roster_no_show_pct: pct(a.no_show, a.shifts),
    roster_absence_pct: pct(a.abs_wd, a.emp_wd),
    roster_sick_pct: pct(a.sick_wd, a.emp_wd),
    roster_open_filled_pct: pct(a.open_ontime, a.open_n),
    roster_open_fill_h: filled > 0 ? r1(a.open_fill_h / filled) : null,
    roster_norm_gaps: a.norm_gaps_fact,
    roster_duty_gaps: a.duty_gaps_fact,
    roster_nurse_ratio: a.nurse_h > 0 && a.census_h > 0 ? r1(a.pt_h / a.nurse_h) : null,
    roster_load_over_pct: pct(a.over_h, a.census_h),
  };
}
export const KPI_CODES = Object.keys(rosterKpis(zeroAcc()));

// ============================================================================================ თვიური (ადამიანი × თვე)
export interface PM {
  month: string; staff_id: string; name: string; personal_number: string | null; department_id: string; department_name: string; position_id: string | null; position_name: string | null;
  category: string | null; employment: string; fte: number; closed: boolean; home_roster: string | null;
  norm: number; fact: number; credit: number; ot: number; ot_pay: number; ot_comp: number; comp_days: number; night: number; holiday: number; weekend: number; no_show: number;
  emp_wd: number; abs_wd: number; sick_wd: number; fulfil: number | null; absence: AbsSum[];
}

/** თვის თანამშრომლები (ტაბელში მოხვედრილი) ფილტრით */
async function monthStaff(ex: Ex, month: string, f: Filt) {
  const d1 = monthEnd(month);
  const rows = await sql<{ id: string }>`
    SELECT s.id FROM staff_members s LEFT JOIN staff_positions p ON p.id = s.position_id
     WHERE (s.hired_on IS NULL OR s.hired_on <= ${d1}::date) AND (s.left_on IS NULL OR s.left_on >= ${month}::date)
       AND ${f.depts ? sql`s.department_id = ANY(${ids(f.depts)}::uuid[])` : sql`TRUE`}
       AND ${f.category ? sql`p.category = ${f.category}` : sql`TRUE`}
       AND ${f.position_id ? sql`s.position_id = ${f.position_id}::uuid` : sql`TRUE`}
       AND ${f.employment ? sql`s.employment = ${f.employment}` : sql`TRUE`}
       AND ((  (s.is_active OR s.left_on IS NOT NULL)
               AND EXISTS (SELECT 1 FROM rosters r WHERE r.department_id = s.department_id AND r.month = ${month}::date AND r.status IN ('published', 'closed')))
            OR EXISTS (SELECT 1 FROM roster_entries e JOIN rosters r ON r.id = e.roster_id
                        WHERE e.staff_id = s.id AND e.status = 'active' AND r.status IN ('published', 'closed') AND e.day BETWEEN ${month}::date AND ${d1}::date))`.execute(ex);
  return rows.rows.map((x) => x.id);
}

export async function personMonths(ex: Ex, s: Rules, month: string, f: Filt, closedOnly = false): Promise<PM[]> {
  const staffIds = await monthStaff(ex, month, f);
  if (!staffIds.length) return [];
  const [info, snap] = await Promise.all([
    ex.selectFrom('staff_members as s').innerJoin('departments as d', 'd.id', 's.department_id').leftJoin('staff_positions as p', 'p.id', 's.position_id')
      .select(['s.id', staffName('s').as('name'), 's.personal_number', 's.department_id', 'd.name as department_name', 's.position_id', 'p.name as position_name', 'p.category',
        's.employment', 's.fte',
        sql<string | null>`(SELECT r.status FROM rosters r WHERE r.department_id = s.department_id AND r.month = ${month}::date AND r.status IN ('published', 'closed'))`.as('home_roster')])
      .where('s.id', 'in', staffIds).execute(),
    ex.selectFrom('roster_timesheets as t').innerJoin('rosters as r', 'r.id', 't.roster_id').innerJoin('staff_members as s', 's.id', 't.staff_id')
      .select(['t.staff_id', 't.fte', 't.total_hours', 't.credit_hours', 't.norm_hours', 't.overtime_hours', 't.ot_pay_hours', 't.ot_comp_hours', 't.comp_days', 't.absence', 't.person'])
      .where('t.staff_id', 'in', staffIds).where('t.home', '=', true).where('r.status', '=', 'closed').where('r.month', '=', month)
      .whereRef('r.department_id', '=', 's.department_id').execute(),
  ]);
  const snapMap = new Map(snap.map((x) => [x.staff_id, x]));
  const live = staffIds.filter((id) => !snapMap.has(id));
  const rows = new Map<string, Omit<PM, keyof (typeof info)[number] | 'month' | 'closed' | 'home_roster' | 'fulfil' | 'staff_id'>>();
  const n = (v: string | number | null | undefined) => Number(v ?? 0) || 0;
  const sick = new Set(s.rpt_sick_types ?? ['SICK']);
  const absWd = (a: AbsSum[]) => a.filter((x) => !x.counts_as_work).reduce((t, x) => t + x.workdays, 0);
  const sickWd = (a: AbsSum[]) => a.filter((x) => sick.has(x.code)).reduce((t, x) => t + x.workdays, 0);
  for (const x of snap) {
    const p = (x.person ?? {}) as { night?: number; holiday?: number; weekend?: number; no_show?: number; workdays?: number };
    const absence = (x.absence ?? []) as unknown as AbsSum[];
    rows.set(x.staff_id, { norm: n(x.norm_hours), fact: n(x.total_hours), credit: n(x.credit_hours), ot: n(x.overtime_hours), ot_pay: n(x.ot_pay_hours), ot_comp: n(x.ot_comp_hours),
      comp_days: n(x.comp_days), night: n(p.night), holiday: n(p.holiday), weekend: n(p.weekend), no_show: n(p.no_show), emp_wd: n(p.workdays), abs_wd: absWd(absence),
      sick_wd: sickWd(absence), absence });
  }
  if (live.length && !closedOnly) {
    const g = await gatherHours(ex, s, month, live);
    const eBy = new Map<string, G['entries']>(); const aBy = new Map<string, G['abs']>();
    for (const e of g.entries) (eBy.get(e.staff_id) ?? eBy.set(e.staff_id, []).get(e.staff_id)!).push(e);
    for (const a of g.abs) (aBy.get(a.staff_id) ?? aBy.set(a.staff_id, []).get(a.staff_id)!).push(a);
    for (const id of live) {
      const r = hoursRow({ ...g, entries: eBy.get(id) ?? [], abs: aBy.get(id) ?? [] }, id, null, true);
      if (!r) continue;
      splitOt(s, r, s.overtime_default === 'comp' ? r.overtime_hours ?? 0 : 0);
      rows.set(id, { norm: n(r.norm_hours), fact: n(r.total_hours), credit: n(r.credit_hours), ot: n(r.overtime_hours), ot_pay: n(r.ot_pay_hours), ot_comp: n(r.ot_comp_hours),
        comp_days: n(r.comp_days), night: n(r.person.night), holiday: n(r.person.holiday), weekend: n(r.person.weekend), no_show: n(r.person.no_show), emp_wd: n(r.person.workdays),
        abs_wd: absWd(r.absence), sick_wd: sickWd(r.absence), absence: r.absence });
    }
  }
  const out: PM[] = [];
  for (const i of info) {
    const v = rows.get(i.id);
    if (!v) continue;
    out.push({ ...i, ...v, month, staff_id: i.id, fte: Number(i.fte), closed: snapMap.has(i.id), home_roster: i.home_roster,
      fulfil: v.norm > 0 ? r1(((v.fact + v.credit) / v.norm) * 100) : null });
  }
  return out;
}

/** ადამიანი × თვე → თვიური ჯამი (Acc-ის თვიური ველები) */
export function monthAcc(list: PM[], s: Rules, a: Acc = zeroAcc()) {
  for (const p of list) {
    a.staff++; if (p.closed) a.closed_staff++;
    a.norm_h += p.norm; a.fact_h += p.fact; a.credit_h += p.credit; a.ot_h += p.ot; a.ot_pay_h += p.ot_pay; a.ot_comp_h += p.ot_comp;
    if (p.ot > 0) a.ot_staff++;
    if (p.fulfil !== null && p.fulfil < (s.rpt_norm_low_pct ?? 90)) a.under_staff++;
    a.emp_wd += p.emp_wd; a.abs_wd += p.abs_wd; a.sick_wd += p.sick_wd; a.night_h += p.night; a.holiday_h += p.holiday; a.weekend_h += p.weekend;
  }
  return a;
}

// ============================================================================================ დღიური
export interface DayOpts { depts: string[] | null; category?: string | null; detail?: boolean; at?: number }
export interface DayRaw {
  acc: Map<string, Acc>;    // `${day}|${dept}`
  open: OpenRow[]; swaps: SwapRow[]; violations: ViolRow[]; normGaps: GapRow[]; dutyGaps: GapRow[];
  load: LoadDept[]; hourly: { pt: number; nurse: number }[]; dayNight: Record<'day' | 'night' | 'weekend' | 'weekday', { pt: number; nurse: number; census: number; over: number }>;
  noShow: { staff_id: string; n: number; shifts: number }[];
}
export interface OpenRow { id: string; day: string; department_id: string; source: string; category: string | null; kind: string; code: string; status: string; outcome: 'ontime' | 'late' | 'unfilled' | 'pending';
  volunteer: boolean; fill_h: number | null; lead_h: number; starts_at: string }
export interface SwapRow { id: string; no: string; day: string; department_id: string; kind: string; status: string; from_staff_id: string; category: string | null; peer_h: number | null; head_h: number | null; decided_h: number | null }
export interface ViolRow { rule: string; staff_id: string; department_id: string; day: string; message: string }
export interface GapRow { day: string; department_id: string; key: string; label: string; category: string | null; need: number; plan: number; fact: number }
export interface LoadDept { department_id: string; care_level: string; limit: number; pt_h: number; nurse_h: number; census_h: number; over_h: number; nonurse_h: number; peak: number | null }

type ER = { id: string; roster_id: string; dept: string; staff_id: string; category: string | null; day: string; starts: number; ends: number; hours: number; kind: string; tpl: string;
  att: string; a_start: number | null; a_end: number | null; a_hours: number | null; duty_role_id: string | null; duty_level: number | null };

export async function loadDaily(ex: Ex, s: Rules, from: string, to: string, o: DayOpts): Promise<DayRaw> {
  const nowMs = o.at ?? Date.now();
  const tday = localDay(nowMs);
  const toPast = to < tday ? to : tday;      // ცვლები / ხარვეზები / წესები — დღემდე (ჩათვლით)
  const acc = new Map<string, Acc>();
  const A = (day: string, dept: string) => acc.get(`${day}|${dept}`) ?? acc.set(`${day}|${dept}`, zeroAcc()).get(`${day}|${dept}`)!;
  const inDept = (d: string) => !o.depts || o.depts.includes(d);
  const catOk = (c: string | null) => !o.category || c === o.category;
  const out: DayRaw = { acc, open: [], swaps: [], violations: [], normGaps: [], dutyGaps: [], load: [], hourly: Array.from({ length: 24 }, () => ({ pt: 0, nurse: 0 })),
    dayNight: { day: z4(), night: z4(), weekend: z4(), weekday: z4() }, noShow: [] };
  const t = (v: Date | string | null) => (v === null ? null : new Date(v).getTime());

  // განრიგები (თვე × განყოფილება), რომლებიც ითვლება
  const months = monthList(from, to);
  const rosters = await ex.selectFrom('rosters').select(['id', 'department_id', sql<string>`to_char(month, 'YYYY-MM-DD')`.as('month')])
    .where('status', 'in', ['published', 'closed']).where('month', '>=', months[0]).where('month', '<=', months.at(-1)!).execute();
  const hasRoster = new Set(rosters.map((r) => `${r.department_id}|${r.month}`));
  const monthOf = (d: string) => `${d.slice(0, 7)}-01`;

  // ---------------------------------------------------------------- ჩანაწერები (წესებისთვის — 9 დღით ადრე)
  const er = await ex.selectFrom('roster_entries as e').innerJoin('rosters as r', 'r.id', 'e.roster_id').innerJoin('shift_templates as tp', 'tp.id', 'e.shift_template_id')
    .innerJoin('staff_members as s', 's.id', 'e.staff_id').leftJoin('staff_positions as p', 'p.id', 's.position_id')
    .select(['e.id', 'e.roster_id', 'r.department_id as dept', 'e.staff_id', 'p.category', sql<string>`to_char(e.day, 'YYYY-MM-DD')`.as('day'), 'e.starts_at', 'e.ends_at', 'e.hours',
      'tp.kind', 'e.shift_template_id as tpl', 'e.att_status', 'e.actual_start', 'e.actual_end', 'e.actual_hours', 'e.duty_role_id', 'e.duty_level'])
    .where('e.status', '=', 'active').where('r.status', 'in', ['published', 'closed']).where('e.day', '>=', addDays(from, -9)).where('e.day', '<=', to).execute();
  const E: ER[] = er.map((e) => ({ id: e.id, roster_id: e.roster_id, dept: e.dept, staff_id: e.staff_id, category: e.category, day: e.day, starts: t(e.starts_at)!, ends: t(e.ends_at)!,
    hours: Number(e.hours), kind: e.kind, tpl: e.tpl, att: e.att_status, a_start: t(e.actual_start), a_end: t(e.actual_end), a_hours: e.actual_hours === null ? null : Number(e.actual_hours),
    duty_role_id: e.duty_role_id, duty_level: e.duty_level }));
  const inRange = (e: ER) => e.day >= from && e.day <= toPast;

  // ცვლები / „არ გამოცხადდა“
  const ns = new Map<string, { n: number; shifts: number }>();
  for (const e of E) {
    if (!inRange(e) || !inDept(e.dept) || !catOk(e.category)) continue;
    const a = A(e.day, e.dept); a.shifts++;
    if (e.att === 'no_show') a.no_show++;
    const x = ns.get(e.staff_id) ?? ns.set(e.staff_id, { n: 0, shifts: 0 }).get(e.staff_id)!; x.shifts++; if (e.att === 'no_show') x.n++;
  }
  if (o.detail) out.noShow = [...ns.entries()].filter(([, v]) => v.n > 0).map(([staff_id, v]) => ({ staff_id, ...v }));

  // ---------------------------------------------------------------- ნორმის / მორიგის ხარვეზები
  const days: string[] = []; for (let d = from; d <= toPast; d = addDays(d, 1)) days.push(d);
  const [norms, duties, hol] = await Promise.all([
    ex.selectFrom('staffing_norms as n').innerJoin('shift_templates as tp', 'tp.id', 'n.shift_template_id')
      .select(['n.id', 'n.department_id', 'n.shift_template_id', 'tp.code', 'n.category', 'n.min_count', 'n.weekdays', 'n.holidays']).where('n.is_active', '=', true).execute(),
    ex.selectFrom('duty_roles').select(['id', 'name', 'department_id', 'required_count']).where('is_active', '=', true).where('department_id', 'is not', null).where('required_count', '>', 0).execute(),
    ex.selectFrom('public_holidays').select(sql<string>`to_char(day, 'YYYY-MM-DD')`.as('day')).where('day', '>=', from).where('day', '<=', to).execute(),
  ]);
  const holSet = new Set(hol.map((h) => h.day));
  const byDay = new Map<string, ER[]>();
  for (const e of E) if (inRange(e)) (byDay.get(`${e.dept}|${e.day}`) ?? byDay.set(`${e.dept}|${e.day}`, []).get(`${e.dept}|${e.day}`)!).push(e);
  if (s.norm_mode !== 'off') {
    for (const nm of norms) {
      if (!inDept(nm.department_id) || !catOk(nm.category)) continue;
      for (const d of days) {
        if (!hasRoster.has(`${nm.department_id}|${monthOf(d)}`)) continue;
        if (nm.weekdays.length && !nm.weekdays.includes(isoDow(d))) continue;
        if (!nm.holidays && holSet.has(d)) continue;
        const xs = (byDay.get(`${nm.department_id}|${d}`) ?? []).filter((e) => e.tpl === nm.shift_template_id && e.category === nm.category);
        const plan = xs.length; const fact = xs.filter((e) => e.att !== 'no_show').length;
        const gp = Math.max(0, nm.min_count - plan), gf = Math.max(0, nm.min_count - fact);
        if (!gp && !gf) continue;
        const a = A(d, nm.department_id); a.norm_gaps_plan += gp; a.norm_gaps_fact += gf;
        if (o.detail) out.normGaps.push({ day: d, department_id: nm.department_id, key: nm.id, label: nm.code, category: nm.category, need: nm.min_count, plan, fact });
      }
    }
  }
  for (const dr of duties) {
    if (!inDept(dr.department_id!)) continue;
    for (const d of days) {
      if (!hasRoster.has(`${dr.department_id}|${monthOf(d)}`)) continue;
      const xs = (byDay.get(`${dr.department_id}|${d}`) ?? []).filter((e) => e.duty_role_id === dr.id && e.duty_level === 1);
      const plan = xs.length; const fact = xs.filter((e) => e.att !== 'no_show').length;
      const gp = Math.max(0, dr.required_count - plan), gf = Math.max(0, dr.required_count - fact);
      if (!gp && !gf) continue;
      const a = A(d, dr.department_id!); a.duty_gaps_plan += gp; a.duty_gaps_fact += gf;
      if (o.detail) out.dutyGaps.push({ day: d, department_id: dr.department_id!, key: dr.id, label: dr.name, category: null, need: dr.required_count, plan, fact });
    }
  }

  // ---------------------------------------------------------------- წესები (ფაქტით: „არ გამოცხადდა“ — არა, შესწორებული დრო / საათები)
  const byId = new Map(E.map((e) => [e.id, e]));
  const fe: RuleEntry[] = E.filter((e) => e.att !== 'no_show').map((e) => ({ id: e.id, staff_id: e.staff_id, day: e.day, starts: e.a_start ?? e.starts, ends: e.a_end ?? e.ends,
    hours: factOf({ att: e.att, hours: e.hours, a_hours: e.a_hours }), kind: e.kind }));
  for (const v of evaluate(fe, s)) {
    const first = v.entry_ids.map((x) => byId.get(x)!).filter(Boolean).sort((a, b) => a.starts - b.starts)[0];
    if (!first || first.day < from || first.day > toPast || !inDept(first.dept) || !catOk(first.category)) continue;
    const k = `viol_${v.rule}` as AccKey; A(first.day, first.dept)[k]++;
    if (o.detail) out.violations.push({ rule: v.rule, staff_id: v.staff_id, department_id: first.dept, day: first.day, message: v.message });
  }

  // ---------------------------------------------------------------- დასაფარი (დაწყების დღით; დაწყება გასულია)
  const os = await ex.selectFrom('roster_open_shifts as o').innerJoin('rosters as r', 'r.id', 'o.roster_id').innerJoin('shift_templates as tp', 'tp.id', 'o.shift_template_id')
    .select(['o.id', sql<string>`to_char(o.day, 'YYYY-MM-DD')`.as('day'), 'r.department_id', 'o.source', 'o.category', 'tp.kind', 'tp.code', 'o.status', 'o.starts_at', 'o.created_at', 'o.closed_at',
      sql<boolean>`EXISTS (SELECT 1 FROM roster_open_shift_offers f WHERE f.open_shift_id = o.id AND f.status = 'accepted')`.as('volunteer')])
    .where('o.day', '>=', from).where('o.day', '<=', to).execute();
  for (const x of os) {
    if (!inDept(x.department_id) || !catOk(x.category)) continue;
    const st = t(x.starts_at)!, cr = t(x.created_at)!, cl = t(x.closed_at);
    const started = st <= nowMs;
    // დაუფარავი: გაუქმებული (დაწყებამდეც — „საჭირო აღარ არის“, კონსერვატიულად) ან დაწყებისას ღია; ღია და ჯერ დაუწყებელი — არ ითვლება (pending)
    const outcome: OpenRow['outcome'] = x.status === 'filled' ? (cl! <= st ? 'ontime' : 'late') : x.status === 'cancelled' || started ? 'unfilled' : 'pending';
    const fill_h = x.status === 'filled' && cl !== null ? Math.max(0, (cl - cr) / 36e5) : null;
    const lead_h = Math.max(0, (st - cr) / 36e5);
    if (outcome !== 'pending') {
      const a = A(x.day, x.department_id); a.open_n++; a.open_lead_h += lead_h;
      if (outcome === 'ontime') a.open_ontime++; else if (outcome === 'late') a.open_late++; else a.open_unfilled++;
      if (fill_h !== null) a.open_fill_h += fill_h;
      if (x.status === 'filled' && x.volunteer) a.open_volunteer++;
    }
    if (o.detail) out.open.push({ id: x.id, day: x.day, department_id: x.department_id, source: x.source, category: x.category, kind: x.kind, code: x.code, status: x.status, outcome,
      volunteer: x.volunteer, fill_h: fill_h === null ? null : r2(fill_h), lead_h: r2(lead_h), starts_at: new Date(x.starts_at).toISOString() });
  }

  // ---------------------------------------------------------------- გაცვლები (შექმნის დღით)
  const sw = await sql<{ id: string; no: string; day: string; department_id: string; kind: string; status: string; from_staff_id: string; category: string | null;
    created_at: Date; peer_at: Date | null; head_at: Date | null; updated_at: Date }>`
    SELECT w.id, w.no::text AS no, to_char((w.created_at AT TIME ZONE ${tz})::date, 'YYYY-MM-DD') AS day, r.department_id, w.kind, w.status, w.from_staff_id, p.category,
           w.created_at, w.peer_at, w.head_at, w.updated_at
      FROM roster_swaps w JOIN roster_entries e ON e.id = w.from_entry_id JOIN rosters r ON r.id = e.roster_id
      JOIN staff_members s ON s.id = w.from_staff_id LEFT JOIN staff_positions p ON p.id = s.position_id
     WHERE w.created_at >= (${from}::date)::timestamp AT TIME ZONE ${tz} AND w.created_at < (${to}::date + 1)::timestamp AT TIME ZONE ${tz}`.execute(ex);
  for (const x of sw.rows) {
    if (!inDept(x.department_id) || !catOk(x.category)) continue;
    const cr = t(x.created_at)!, pa = t(x.peer_at), ha = t(x.head_at);
    const decided = x.status === 'approved' ? (ha ?? pa) : x.status === 'rejected' ? ha : x.status === 'declined' ? pa : null;
    const a = A(x.day, x.department_id); a.swaps++;
    if (x.status === 'approved') a.swaps_approved++; else if (x.status === 'rejected' || x.status === 'declined') a.swaps_refused++;
    else if (x.status === 'expired' || x.status === 'cancelled') a.swaps_lapsed++;
    if (decided !== null && ['approved', 'rejected', 'declined'].includes(x.status)) a.swaps_decided_h += Math.max(0, (decided - cr) / 36e5);
    if (o.detail) out.swaps.push({ id: x.id, no: x.no, day: x.day, department_id: x.department_id, kind: x.kind, status: x.status, from_staff_id: x.from_staff_id, category: x.category,
      peer_h: pa !== null ? r2((pa - cr) / 36e5) : null, head_h: ha !== null ? r2((ha - (pa ?? cr)) / 36e5) : null, decided_h: decided !== null ? r2((decided - cr) / 36e5) : null });
  }

  // ---------------------------------------------------------------- დატვირთვა (სტაციონარი, საათობრივად; თვის განრიგის მქონე განყოფილება)
  await loadHours(ex, s, from, to, nowMs, o, hasRoster, E, A, out);
  return out;
}
function z4() { return { pt: 0, nurse: 0, census: 0, over: 0 }; }
const isoDow = (day: string) => { const d = new Date(`${day}T00:00:00Z`).getUTCDay(); return d === 0 ? 7 : d; };

async function loadHours(ex: Ex, s: Rules, from: string, to: string, nowMs: number, o: DayOpts, hasRoster: Set<string>, E: ER[], A: (d: string, dep: string) => Acc, out: DayRaw) {
  const deps = (await ex.selectFrom('departments').select(['id', 'care_level']).where('type', '=', 'inpatient').execute()).filter((d) => !o.depts || o.depts.includes(d.id));
  if (!deps.length) return;
  const t0 = localMs(from, '00:00');
  const t1 = Math.min(localMs(addDays(to, 1), '00:00'), Math.floor(nowMs / 36e5) * 36e5);   // მხოლოდ დასრულებული საათები
  if (t1 <= t0) return;
  const H = Math.ceil((t1 - t0) / 36e5);
  const depIds = deps.map((d) => d.id);
  const pt = new Map(depIds.map((d) => [d, new Float64Array(H)]));
  const nu = new Map(depIds.map((d) => [d, new Float64Array(H)]));
  const spread = (arr: Float64Array, s0: number, s1: number) => {
    const a = Math.max(s0, t0), b = Math.min(s1, t1);
    if (b <= a) return;
    for (let h = Math.floor((a - t0) / 36e5); h < H; h++) {
      const hs = t0 + h * 36e5, he = hs + 36e5;
      if (hs >= b) break;
      arr[h] += (Math.min(b, he) - Math.max(a, hs)) / 36e5;
    }
  };
  const bas = await ex.selectFrom('bed_assignments').select(['department_id', 'started_at', 'ended_at'])
    .where('department_id', 'in', depIds).where('started_at', '<', new Date(t1))
    .where((eb) => eb.or([eb('ended_at', 'is', null), eb('ended_at', '>', new Date(t0))])).execute();
  for (const b of bas) spread(pt.get(b.department_id)!, new Date(b.started_at).getTime(), b.ended_at ? new Date(b.ended_at).getTime() : t1);
  for (const e of E) {
    if (e.category !== 'nurse' || e.kind === 'oncall_home' || e.att === 'no_show' || !nu.has(e.dept)) continue;
    spread(nu.get(e.dept)!, e.a_start ?? e.starts, e.a_end ?? e.ends);
  }
  const mid = new Map<string, number>();
  const nf = (s.night_from ?? '22:00').slice(0, 5), nt = (s.night_to ?? '06:00').slice(0, 5);
  for (const d of deps) {
    const P = pt.get(d.id)!, N = nu.get(d.id)!;
    const limit = ratioLimit(s, d.care_level);
    const L: LoadDept = { department_id: d.id, care_level: d.care_level, limit, pt_h: 0, nurse_h: 0, census_h: 0, over_h: 0, nonurse_h: 0, peak: null };
    for (let h = 0; h < H; h++) {
      const ms = t0 + h * 36e5 + 1;
      const day = localDay(ms);
      if (!hasRoster.has(`${d.id}|${day.slice(0, 7)}-01`)) continue;
      const p = P[h], n = N[h];
      const a = A(day, d.id);
      a.pt_h += p; a.nurse_h += n; L.pt_h += p; L.nurse_h += n;
      const hod = Math.floor((ms - (mid.get(day) ?? mid.set(day, localMs(day, '00:00')).get(day)!)) / 36e5);
      out.hourly[hod].pt += p; out.hourly[hod].nurse += n;
      const hh = `${String(hod).padStart(2, '0')}:00`;
      const isNight = nf < nt ? hh >= nf && hh < nt : hh >= nf || hh < nt;
      const wk = isoDow(day) >= 6 ? 'weekend' : 'weekday';
      for (const g of [isNight ? 'night' : 'day', wk] as const) { out.dayNight[g].pt += p; out.dayNight[g].nurse += n; }
      if (p > 1e-9) {
        a.census_h++; L.census_h++;
        const over = n < 1e-9 || p / n > limit;
        if (n < 1e-9) { a.nonurse_h++; L.nonurse_h++; }
        if (over) { a.over_h++; L.over_h++; }
        for (const g of [isNight ? 'night' : 'day', wk] as const) { out.dayNight[g].census++; if (over) out.dayNight[g].over++; }
        if (n > 1e-9) L.peak = Math.max(L.peak ?? 0, r1(p / n));
      }
    }
    if (L.pt_h > 0 || L.nurse_h > 0) out.load.push({ ...L, pt_h: r2(L.pt_h), nurse_h: r2(L.nurse_h) });
  }
}

// ============================================================================================ რეპორტინგის ფაქტები
/** rpt_fact_roster (ფანჯარა) + rpt_fact_roster_month (ფანჯრის თვეები) — DELETE → INSERT */
export async function rosterFacts(rdb: Database, trx: Transaction<DB>, from: string, to: string): Promise<Record<string, number>> {
  const s = await rosterRptRules(rdb);
  if (!s) return {};
  const raw = await loadDaily(rdb, s, from, to, { depts: null });
  await sql`DELETE FROM rpt_fact_roster WHERE day BETWEEN ${from}::date AND ${to}::date`.execute(trx);
  const vals = [...raw.acc.entries()].map(([k, a]) => {
    const [day, dep] = k.split('|');
    const row: Record<string, unknown> = { day, department_id: dep };
    for (const c of DAY_KEYS) row[c] = FLOAT_KEYS.has(c) ? String(Math.round(a[c] * 1e4) / 1e4) : Math.round(a[c]);
    return row;
  }).filter((r) => DAY_KEYS.some((c) => Number(r[c]) !== 0));
  for (let i = 0; i < vals.length; i += 1000) await trx.insertInto('rpt_fact_roster').values(vals.slice(i, i + 1000) as never).execute();
  // თვიური — ფანჯრის ყველა თვე (მთლიანად)
  let mrows = 0;
  for (const m of monthList(from, to)) {
    const list = await personMonths(rdb, s, m, { depts: null });
    const by = new Map<string, PM[]>();
    for (const p of list) (by.get(p.department_id) ?? by.set(p.department_id, []).get(p.department_id)!).push(p);
    await sql`DELETE FROM rpt_fact_roster_month WHERE month = ${m}::date`.execute(trx);
    const rows = [...by.entries()].map(([dep, xs]) => {
      const a = monthAcc(xs, s);
      const row: Record<string, unknown> = { month: m, department_id: dep };
      for (const c of MONTH_KEYS) row[c] = FLOAT_KEYS.has(c) ? String(r2(a[c])) : Math.round(a[c]);
      return row;
    });
    if (rows.length) await trx.insertInto('rpt_fact_roster_month').values(rows as never).execute();
    mrows += rows.length;
  }
  return { roster: vals.length, roster_month: mrows };
}

// ============================================================================================ „ყურადღება“
export async function rosterAttentionCounts(db: Database, depts: string[] | null) {
  const s = await rosterRptRules(db);
  if (!s) return null;
  const d0 = today(); const d1 = addDays(d0, 1);
  const f = (col: string) => (depts ? sql`${sql.ref(col)} = ANY(${ids(depts)}::uuid[])` : sql`TRUE`);
  const urgent = Number(s.rpt_open_urgent_hours ?? 24);
  const late = Number(s.rpt_close_late_days ?? 5);
  const curMonth = `${d0.slice(0, 7)}-01`;
  const r = (await sql<{ duty_gap: number; open_urgent: number; close_late: number; absence_soon: number }>`
    SELECT
      (SELECT count(*)::int FROM duty_roles dr CROSS JOIN (VALUES (${d0}::date), (${d1}::date)) dd(day)
         JOIN rosters r ON r.department_id = dr.department_id AND r.month = date_trunc('month', dd.day)::date AND r.status IN ('published', 'closed')
        WHERE dr.is_active AND dr.required_count > 0 AND ${f('dr.department_id')}
          AND (SELECT count(*) FROM roster_entries e WHERE e.roster_id = r.id AND e.status = 'active' AND e.day = dd.day AND e.duty_role_id = dr.id AND e.duty_level = 1
                AND e.att_status <> 'no_show') < dr.required_count) AS duty_gap,
      (SELECT count(*)::int FROM roster_open_shifts o JOIN rosters r ON r.id = o.roster_id
        WHERE o.status = 'open' AND o.starts_at > now() AND o.starts_at <= now() + make_interval(hours => ${urgent}::int) AND ${f('r.department_id')}) AS open_urgent,
      (SELECT count(*)::int FROM rosters r WHERE r.status = 'published' AND (r.month + interval '1 month')::date + ${late}::int <= ${d0}::date AND ${f('r.department_id')}) AS close_late,
      (SELECT count(*)::int FROM absence_requests a JOIN staff_members s ON s.id = a.staff_id
        WHERE a.status IN ('head', 'hr') AND a.date_from <= ${addDays(d0, 3)}::date AND a.date_to >= ${d0}::date AND ${f('s.department_id')}) AS absence_soon`.execute(db)).rows[0];
  // ქრონიკული ზეგანაკვეთი: ბოლო 6 დახურული თვიდან ≥ N-ში (ძირითადი განყოფილების snapshot)
  const ch = await chronicOvertime(db, s, depts, curMonth);
  // დატვირთვა ახლა — მხოლოდ განყოფილებები მიმდინარე თვის განრიგით
  const load = (await new RosterLookup(db).load()) ?? [];
  const withRoster = new Set((await db.selectFrom('rosters').select('department_id').where('month', '=', curMonth).where('status', 'in', ['published', 'closed']).execute()).map((x) => x.department_id));
  const L = load.filter((x) => withRoster.has(x.department_id) && (!depts || depts.includes(x.department_id)));
  return { ...r, chronic_ot: ch.length, load_none: L.filter((x) => x.level === 'none').length, load_over: L.filter((x) => x.level === 'over').length };
}

/** ქრონიკული ზეგანაკვეთი: [cur − 6 თვე, cur) დახურული ძირითადი ტაბელებიდან, ზეგანაკვეთი > 0 ≥ rpt_chronic_ot_months თვეში */
export async function chronicOvertime(db: Ex, s: Rules, depts: string[] | null, curMonth: string) {
  const n = Math.max(1, Number(s.rpt_chronic_ot_months ?? 3));
  const fromM = monthList(addDays(curMonth, -183), curMonth)[0];
  const rows = await sql<{ staff_id: string; name: string; department_id: string; department_name: string; months: number; ot: string }>`
    SELECT t.staff_id, s.last_name || ' ' || s.first_name AS name, r.department_id, d.name AS department_name, count(DISTINCT r.month)::int AS months, sum(t.overtime_hours)::text AS ot
      FROM roster_timesheets t JOIN rosters r ON r.id = t.roster_id JOIN staff_members s ON s.id = t.staff_id JOIN departments d ON d.id = r.department_id
     WHERE t.home AND r.status = 'closed' AND t.overtime_hours > 0 AND r.month >= ${fromM}::date AND r.month < ${curMonth}::date
       AND ${depts ? sql`r.department_id = ANY(${ids(depts)}::uuid[])` : sql`TRUE`}
     GROUP BY 1, 2, 3, 4 HAVING count(DISTINCT r.month) >= ${n} ORDER BY sum(t.overtime_hours) DESC`.execute(db);
  return rows.rows.map((x) => ({ ...x, ot: r1(Number(x.ot)) }));
}
