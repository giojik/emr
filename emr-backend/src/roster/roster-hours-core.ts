import { sql } from 'kysely';
import { addDays, isoDow, localDay, localMs, monthDays, staffName, type Ex, type RosterSettings } from './roster-common';

/**
 * საათების / ტაბელის საერთო გამოთვლა (0079-დან გამოყოფილი, 0080): ტაბელი (TimesheetService), ანგარიშები / KPI (roster-reports-core, rpt_fact_roster).
 * ფაქტი, ღამე / დღესასწაული / შაბ.–კვ. (საათობრივი გადაფარვა, პროპორციულად), ნორმა / ზეგანაკვეთი (ძირითადი განყოფილება, ყველა განრიგით).
 */
export const r2 = (x: number) => Math.round(x * 100) / 100;
export const half = (x: number) => Math.round(x * 2) / 2;
export const fmtH = (h: number) => String(r2(h));
export const ATT_KA: Record<string, string> = { plan: 'გეგმით', worked: 'ფაქტი შესწორდა', no_show: 'არ გამოცხადდა' };
/** ტაბელის კოდი „არ გამოცხადდა“ */
export const NO_SHOW = 'გ';

export type SInfo = { id: string; name: string; personal_number: string | null; user_id: string | null; department_id: string; department_name: string; position_name: string | null;
  category: string | null; fte: number; hired_on: string | null; left_on: string | null; is_active: boolean };
export type TE = { id: string; roster_id: string; staff_id: string; day: string; starts: number; ends: number; hours: number; kind: string; code: string; att: string;
  a_start: number | null; a_end: number | null; a_hours: number | null };
export type TA = { id: string; no: string; staff_id: string; type_id: string; code: string; short: string; name: string; paid: boolean; counts_as_work: boolean;
  from: string; to: string; counted: string[]; document_no: string | null };
export interface G { month: string; days: string[]; hol: Map<string, string>; staff: Map<string, SInfo>; entries: TE[]; abs: TA[]; s: RosterSettings }
export interface AbsSum { type_id: string; code: string; short: string; name: string; paid: boolean; counts_as_work: boolean; days: number; workdays: number }
export interface Row {
  staff_id: string; name: string; personal_number: string | null; position_name: string | null; category: string | null; department_id: string; department_name: string; fte: number;
  home: boolean; shifts: number; plan_hours: number; worked_hours: number; night_hours: number; holiday_hours: number; weekend_hours: number; no_show: number;
  total_hours: number | null; credit_hours: number | null; norm_hours: number | null; overtime_hours: number | null;
  ot_pay_hours: number | null; ot_comp_hours: number | null; comp_days: number | null;
  person: { night?: number; holiday?: number; weekend?: number; no_show?: number; workdays?: number };
  absence: AbsSum[]; days: Record<string, string>;
}

/** თანამშრომლები, გამოქვეყნებული / დახურული განრიგების ჩანაწერები (თვე, ყველა განყოფილება), დადასტურებული არყოფნები, დღესასწაულები */
export async function gatherHours(ex: Ex, s: RosterSettings, month: string, staffIds: string[]): Promise<G> {
  const days = monthDays(month); const d0 = days[0], d1 = days[days.length - 1];
  const ids = staffIds.length ? staffIds : ['00000000-0000-0000-0000-000000000000'];
  const [staff, entries, abs, hol] = await Promise.all([
    ex.selectFrom('staff_members as s').innerJoin('departments as d', 'd.id', 's.department_id').leftJoin('staff_positions as p', 'p.id', 's.position_id')
      .select(['s.id', staffName('s').as('name'), 's.personal_number', 's.user_id', 's.department_id', 'd.name as department_name', 'p.name as position_name', 'p.category', 's.fte',
        sql<string | null>`to_char(s.hired_on, 'YYYY-MM-DD')`.as('hired_on'), sql<string | null>`to_char(s.left_on, 'YYYY-MM-DD')`.as('left_on'), 's.is_active'])
      .where('s.id', 'in', ids).execute(),
    ex.selectFrom('roster_entries as e').innerJoin('rosters as r', 'r.id', 'e.roster_id').innerJoin('shift_templates as t', 't.id', 'e.shift_template_id')
      .select(['e.id', 'e.roster_id', 'e.staff_id', sql<string>`to_char(e.day, 'YYYY-MM-DD')`.as('day'), 'e.starts_at', 'e.ends_at', 'e.hours', 't.kind', 't.code',
        'e.att_status', 'e.actual_start', 'e.actual_end', 'e.actual_hours'])
      .where('e.staff_id', 'in', ids).where('e.status', '=', 'active').where('r.status', 'in', ['published', 'closed']).where('e.day', '>=', d0).where('e.day', '<=', d1)
      .orderBy('e.starts_at').execute(),
    ex.selectFrom('absence_requests as a').innerJoin('absence_types as t', 't.id', 'a.absence_type_id')
      .select(['a.id', sql<string>`a.no::text`.as('no'), 'a.staff_id', 'a.absence_type_id as type_id', 't.code', 't.short', 't.name', 't.paid', 't.counts_as_work',
        sql<string>`to_char(a.date_from, 'YYYY-MM-DD')`.as('from'), sql<string>`to_char(a.date_to, 'YYYY-MM-DD')`.as('to'),
        sql<string[]>`array(SELECT to_char(x, 'YYYY-MM-DD') FROM unnest(a.counted_days) x ORDER BY 1)`.as('counted'), 'a.document_no'])
      .where('a.staff_id', 'in', ids).where('a.status', '=', 'approved').where('a.date_from', '<=', d1).where('a.date_to', '>=', d0).orderBy('a.date_from').execute(),
    ex.selectFrom('public_holidays').select([sql<string>`to_char(day, 'YYYY-MM-DD')`.as('day'), 'name']).where('day', '>=', addDays(d0, -1)).where('day', '<=', addDays(d1, 2)).execute(),
  ]);
  const t = (v: Date | string | null) => (v === null ? null : new Date(v).getTime());
  return {
    month, days, s, hol: new Map(hol.map((h) => [h.day, h.name])),
    staff: new Map(staff.map((x) => [x.id, { ...x, fte: Number(x.fte) }])),
    entries: entries.map((e) => ({ id: e.id, roster_id: e.roster_id, staff_id: e.staff_id, day: e.day, starts: t(e.starts_at)!, ends: t(e.ends_at)!, hours: Number(e.hours), kind: e.kind, code: e.code,
      att: e.att_status, a_start: t(e.actual_start), a_end: t(e.actual_end), a_hours: e.actual_hours === null ? null : Number(e.actual_hours) })),
    abs,
  };
}

/** ფაქტის საათები: არ გამოცხადდა — 0; შესწორებული — actual_hours; სხვა — გეგმა */
export function factOf(e: Pick<TE, 'att' | 'hours' | 'a_hours'>) { return e.att === 'no_show' ? 0 : e.att === 'worked' ? e.a_hours ?? 0 : e.hours; }

/** ინტერვალის გადაფარვა ღამის ფანჯრებთან (night_from–night_to, ადგილობრივი დრო), სთ */
export function nightOverlap(s: number, e: number, from: string, to: string) {
  let h = 0;
  for (let d = addDays(localDay(s), -1); d <= localDay(e); d = addDays(d, 1)) {
    const ws = localMs(d, from); const we = localMs(from < to ? d : addDays(d, 1), to);
    h += Math.max(0, Math.min(e, we) - Math.max(s, ws));
  }
  return h / 36e5;
}
/** ინტერვალის გადაფარვა კალენდარულ დღეებთან, რომლებიც პირობას აკმაყოფილებს (დღესასწაული / შაბ.–კვ.), სთ */
export function dayOverlap(s: number, e: number, pred: (d: string) => boolean) {
  let h = 0;
  for (let d = localDay(s); d <= localDay(e); d = addDays(d, 1)) {
    if (!pred(d)) continue;
    h += Math.max(0, Math.min(e, localMs(addDays(d, 1), '00:00')) - Math.max(s, localMs(d, '00:00')));
  }
  return h / 36e5;
}
/** ერთი ჩანაწერი: ფაქტი, ღამე, დღესასწაული, შაბ.–კვ. (ფაქტის ინტერვალით, თუ შესწორდა; ჩასათვლელ საათებთან პროპორციულად) */
export function entryCalc(g: G, e: TE) {
  const fact = factOf(e);
  const [s, en] = e.a_start !== null && e.a_end !== null ? [e.a_start, e.a_end] : [e.starts, e.ends];
  const dur = (en - s) / 36e5;
  const k = dur > 0 ? Math.min(1, fact / dur) : 0;
  return {
    fact,
    night: nightOverlap(s, en, g.s.night_from ?? '22:00', g.s.night_to ?? '06:00') * k,
    holiday: dayOverlap(s, en, (d) => g.hol.has(d)) * k,
    weekend: dayOverlap(s, en, (d) => isoDow(d) >= 6) * k,
  };
}
/** სამუშაო დღე (ნორმისთვის): ორშ.–პარ., დღესასწაულის გარეშე, შრომითი ურთიერთობის პერიოდში */
export function workday(g: G, st: SInfo, d: string) {
  return isoDow(d) <= 5 && !g.hol.has(d) && (!st.hired_on || d >= st.hired_on) && (!st.left_on || d <= st.left_on);
}

/**
 * ტაბელის სტრიქონი. rosterId — ამ განრიგის საათები (უჯრები / ფაქტი / ღამე …); null — ყველა განრიგი.
 * home — ნორმა / ზეგანაკვეთი (ადამიანზე ერთხელ: ყველა განრიგის ფაქტი + „ნამუშევრად ჩათვლილი“ არყოფნა − ნორმა).
 */
export function hoursRow(g: G, staffId: string, rosterId: string | null, home: boolean): Row | null {
  const st = g.staff.get(staffId);
  if (!st) return null;
  const mine = g.entries.filter((e) => e.staff_id === staffId);
  const own = rosterId ? mine.filter((e) => e.roster_id === rosterId) : mine;
  const days: Record<string, string> = {}; const dayH = new Map<string, number>(); const dayNs = new Set<string>();
  let plan = 0, worked = 0, night = 0, holiday = 0, weekend = 0, noShow = 0;
  for (const e of own) {
    const c = entryCalc(g, e);
    plan += e.hours; worked += c.fact; night += c.night; holiday += c.holiday; weekend += c.weekend;
    if (e.att === 'no_show') { noShow++; dayNs.add(e.day); } else dayH.set(e.day, (dayH.get(e.day) ?? 0) + c.fact);
  }
  for (const d of g.days) { if (dayH.has(d)) days[d] = fmtH(dayH.get(d)!); else if (dayNs.has(d)) days[d] = NO_SHOW; }
  // არყოფნა: უჯრის კოდი (უპირატესია), დღეები ტიპით (ერთეულით — ჩათვლილი დღეები), სამუშაო დღეები (ნორმისთვის)
  const absMap = new Map<string, AbsSum>(); let absWd = 0, creditWd = 0;
  for (const a of g.abs.filter((x) => x.staff_id === staffId)) {
    const sum = absMap.get(a.type_id) ?? absMap.set(a.type_id, { type_id: a.type_id, code: a.code, short: a.short, name: a.name, paid: a.paid, counts_as_work: a.counts_as_work, days: 0, workdays: 0 }).get(a.type_id)!;
    const counted = new Set(a.counted);
    for (const d of g.days) {
      if (d < a.from || d > a.to) continue;
      days[d] = a.short;
      if (counted.has(d)) sum.days++;
      if (workday(g, st, d)) { sum.workdays++; if (a.counts_as_work) creditWd++; else absWd++; }
    }
  }
  const daily = ((g.s.week_norm_hours ?? 40) / 5) * st.fte;
  const r: Row = {
    staff_id: st.id, name: st.name, personal_number: st.personal_number, position_name: st.position_name, category: st.category, department_id: st.department_id,
    department_name: st.department_name, fte: st.fte, home, shifts: own.length - noShow, plan_hours: r2(plan), worked_hours: r2(worked), night_hours: r2(night), holiday_hours: r2(holiday),
    weekend_hours: r2(weekend), no_show: noShow, total_hours: null, credit_hours: null, norm_hours: null, overtime_hours: null, ot_pay_hours: null, ot_comp_hours: null, comp_days: null,
    person: {}, absence: [...absMap.values()], days,
  };
  if (home) {
    let total = 0, pn = 0, ph = 0, pw = 0, pns = 0;
    for (const e of mine) { const c = entryCalc(g, e); total += c.fact; pn += c.night; ph += c.holiday; pw += c.weekend; if (e.att === 'no_show') pns++; }
    const empWd = g.days.filter((d) => workday(g, st, d)).length;
    const norm = Math.max(0, (empWd - absWd) * daily); const credit = creditWd * daily;
    const ot = g.s.overtime_basis === 'off' ? 0 : Math.max(0, total + credit - norm);
    Object.assign(r, { total_hours: r2(total), credit_hours: r2(credit), norm_hours: r2(norm), overtime_hours: r2(ot), person: { night: r2(pn), holiday: r2(ph), weekend: r2(pw), no_show: pns, workdays: empWd } });
  }
  return r;
}

/** ზეგანაკვეთი → ანაზღ. / COMP (comp საათები) */
export function splitOt(s: RosterSettings, x: Row, comp: number) {
  const ot = x.overtime_hours ?? 0; const c = Math.min(ot, Math.max(0, comp));
  const daily = ((s.week_norm_hours ?? 40) / 5) * x.fte;
  x.ot_comp_hours = r2(c); x.ot_pay_hours = r2(ot - c); x.comp_days = c > 0 && daily > 0 ? half(c / daily) : 0;
}
