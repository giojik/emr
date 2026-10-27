import { ForbiddenException, Global, Injectable, Module } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { has, type AuthUser, type Role } from '../auth/roles';
import { InjectDb, type Database } from '../database/database.module';
import type { DB } from '../database/db';

export type Trx = Transaction<DB>;
export type Ex = Database | Trx;
export const tz = 'Asia/Tbilisi';

/** ცვლები / მორიგეობა (0077) — მოდულის პარამეტრები */
export type RuleMode = 'block' | 'warn' | 'off';
export interface RosterSettings {
  rest_min_hours: number; rest_mode: RuleMode; max_continuous_hours: number; continuous_mode: RuleMode;
  max_week_hours: number; week_mode: RuleMode; max_consecutive_nights: number; nights_mode: RuleMode;
  norm_mode: 'warn' | 'off'; cross_department: 'allow' | 'warn' | 'block';
  publish_notify: boolean; change_notify: boolean; duty_phone: 'all' | 'staff' | 'off'; copy_mode: 'weekday' | 'date';
  // 0078: არყოფნა, გაცვლა, დასაფარი, სურვილები
  absence_unit_mode: 'weekdays' | 'roster'; accrual: 'annual' | 'monthly'; balance_overdraw: 'block' | 'warn';
  swap_approval: 'head' | 'none'; swap_min_notice_hours: number; open_shift_volunteer: boolean; open_shift_notify: boolean;
  prefs_mode: 'warn' | 'off'; prefs_deadline_day: number; unavailable_max_per_month: number;
  // 0079: საათები / ტაბელი, დახურვა, კავშირები
  week_norm_hours: number; overtime_basis: 'month' | 'off'; overtime_default: 'pay' | 'comp'; comp_absence_type: string; night_from: string; night_to: string;
  close_requires_submit: boolean; link_consult: 'off' | 'hint' | 'duty'; link_bme: 'off' | 'hint' | 'duty'; link_or: 'off' | 'absence' | 'absence_shift';
  nurse_ratio: { ward: number; intensive: number; icu: number };
}

export const CATEGORIES = ['doctor', 'nurse', 'junior', 'tech', 'admin', 'other'] as const;
export type Category = (typeof CATEGORIES)[number];
export const CATEGORY_KA: Record<Category, string> = { doctor: 'ექიმი', nurse: 'ექთანი', junior: 'უმცროსი პერსონალი', tech: 'ტექნიკური', admin: 'ადმინისტრაციული', other: 'სხვა' };
export const SHIFT_KINDS = ['day', 'evening', 'night', '24h', 'oncall_site', 'oncall_home', 'other'] as const;
export type ShiftKind = (typeof SHIFT_KINDS)[number];
export const EMPLOYMENT = ['staff', 'part_time', 'contract', 'intern', 'resident'] as const;
/** დასვენების დღე როტაციის ციკლში */
export const REST = '00000000-0000-0000-0000-000000000000';

/** მთელი კლინიკის განრიგის მართვა (+ ცნობარები) */
export const ROSTER_ALL: Role[] = ['admin', 'roster_all', 'hr'];
/** ცნობარები: ცვლის შაბლონები, მორიგის როლები, როტაცია */
export const ROSTER_SETUP: Role[] = ['admin', 'roster_all'];
/** პოზიციები, დღესასწაულები */
export const ROSTER_HR: Role[] = ['admin', 'roster_all', 'hr'];
/** მთელი კლინიკის ნახვა (გამოქვეყნებული) */
export const ROSTER_VIEW_ALL: Role[] = ['admin', 'roster_all', 'hr', 'roster_view', 'manager', 'viewer'];
export const ROSTER_DEPT: Role[] = ['roster'];
/** თანამშრომლების რეესტრი */
export const STAFF_ALL: Role[] = ['admin', 'roster_all', 'hr'];

export const staffName = (alias: string) => sql<string>`${sql.ref(`${alias}.last_name`)} || ' ' || ${sql.ref(`${alias}.first_name`)}`;

/** ხედვის / რედაქტირების არე: all — მთელი კლინიკა; depts — განყოფილებები (roster: rpt_user_scopes ∪ users.department_id) */
export interface Scope { editAll: boolean; viewAll: boolean; edit: string[] }
export async function rosterScope(db: Ex, u: AuthUser): Promise<Scope> {
  const editAll = has(u, ...ROSTER_ALL);
  const viewAll = has(u, ...ROSTER_VIEW_ALL);
  if (editAll || !has(u, ...ROSTER_DEPT)) return { editAll, viewAll, edit: [] };
  const r = await sql<{ id: string }>`SELECT department_id AS id FROM rpt_user_scopes WHERE user_id = ${u.id}
    UNION SELECT department_id FROM users WHERE id = ${u.id} AND department_id IS NOT NULL`.execute(db);
  return { editAll, viewAll, edit: r.rows.map((x) => x.id) };
}
/**
 * 0078 — არყოფნის დადასტურების არე. all: admin / hr / roster_all (მთელი კლინიკა); hr: HR-ის ნაბიჯი (admin / hr);
 * depts: ხელმძღვანელის ნაბიჯი თავის განყოფილებ(ებ)ში — roster ან absence_approve (rpt_user_scopes ∪ users.department_id).
 */
export const ABSENCE_ALL: Role[] = ['admin', 'hr', 'roster_all'];
export const ABSENCE_HR: Role[] = ['admin', 'hr'];
export interface AbsScope { all: boolean; hr: boolean; depts: string[] }
export async function absenceScope(db: Ex, u: AuthUser): Promise<AbsScope> {
  const all = has(u, ...ABSENCE_ALL); const hr = has(u, ...ABSENCE_HR);
  if (!has(u, 'roster', 'absence_approve')) return { all, hr, depts: [] };
  const r = await sql<{ id: string }>`SELECT department_id AS id FROM rpt_user_scopes WHERE user_id = ${u.id}
    UNION SELECT department_id FROM users WHERE id = ${u.id} AND department_id IS NOT NULL`.execute(db);
  return { all, hr, depts: r.rows.map((x) => x.id) };
}
export const canHead = (s: AbsScope, dept: string) => s.all || s.depts.includes(dept);
/** განყოფილების ხელმძღვანელის ნაბიჯის შემსრულებლები (roster / absence_approve, განყოფილების არით) — შეტყობინებისთვის და „ერთადერთი ხელმძღვანელის“ შესამოწმებლად */
export async function headApprovers(db: Ex, dept: string): Promise<string[]> {
  const r = await sql<{ id: string }>`SELECT u.id FROM users u JOIN user_capabilities c ON c.user_id = u.id
    WHERE u.is_active AND c.capabilities && ARRAY['roster', 'absence_approve']::VARCHAR(30)[]
      AND (u.department_id = ${dept} OR EXISTS (SELECT 1 FROM rpt_user_scopes s WHERE s.user_id = u.id AND s.department_id = ${dept}))`.execute(db);
  return r.rows.map((x) => x.id);
}
/** მომხმარებლები უფლებით (მთელი კლინიკა) — HR ნაბიჯის შეტყობინებისთვის */
export async function usersWithCaps(db: Ex, caps: Role[]): Promise<string[]> {
  const r = await sql<{ id: string }>`SELECT u.id FROM users u JOIN user_capabilities c ON c.user_id = u.id
    WHERE u.is_active AND c.capabilities && ${sql.val(caps)}::VARCHAR(30)[]`.execute(db);
  return r.rows.map((x) => x.id);
}
/** განყოფილების განრიგის შემდგენები (roster არე) + მთელი კლინიკის (roster_all) — დასაფარი / გაცვლა */
export async function rosterEditors(db: Ex, dept: string): Promise<string[]> {
  const r = await sql<{ id: string }>`SELECT u.id FROM users u JOIN user_capabilities c ON c.user_id = u.id
    WHERE u.is_active AND (c.capabilities && ARRAY['roster_all']::VARCHAR(30)[] OR (c.capabilities && ARRAY['roster']::VARCHAR(30)[]
      AND (u.department_id = ${dept} OR EXISTS (SELECT 1 FROM rpt_user_scopes s WHERE s.user_id = u.id AND s.department_id = ${dept}))))`.execute(db);
  return r.rows.map((x) => x.id);
}

export const canEdit = (s: Scope, dept: string) => s.editAll || s.edit.includes(dept);
export const canView = (s: Scope, dept: string) => s.viewAll || canEdit(s, dept);
export function needEdit(s: Scope, dept: string) { if (!canEdit(s, dept)) throw new ForbiddenException('ამ განყოფილების განრიგის მართვის უფლება არ გაქვთ'); }

// ---------------------------------------------------------------- დრო (კლინიკის სასაათო სარტყელი)
const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
function offsetMin(d: Date) {
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(d.getTime() / 1000) * 1000) / 60000;
}
/** ადგილობრივი თარიღი + დრო → UTC ms */
export function localMs(day: string, hhmm: string) {
  const guess = Date.parse(`${day}T${hhmm.slice(0, 5)}:00Z`);
  return guess - offsetMin(new Date(guess)) * 60000;
}
/** UTC ms → ადგილობრივი თარიღი (YYYY-MM-DD) */
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz });
export const localDay = (t: number | Date) => dayFmt.format(typeof t === 'number' ? new Date(t) : t);
export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
export const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
/** ISO კვირის დღე 1 (ორშ.) … 7 (კვ.) */
export const isoDow = (day: string) => { const d = new Date(`${day}T00:00:00Z`).getUTCDay(); return d === 0 ? 7 : d; };
export const weekStart = (day: string) => addDays(day, 1 - isoDow(day));
export const monthDays = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => `${month.slice(0, 7)}-${String(i + 1).padStart(2, '0')}`);
};

/** ცვლის დრო შაბლონიდან (ან ხელით მითითებული დროით): დასასრული ≤ დასაწყისი → მეორე დღეს; ტოლი → 24 სთ */
export function shiftTimes(day: string, start: string, end: string, breakMin: number, counted: number | null) {
  const s = localMs(day, start);
  const sameOrBefore = end.slice(0, 5) <= start.slice(0, 5);
  const e = localMs(sameOrBefore ? addDays(day, 1) : day, end);
  const dur = (e - s) / 36e5;
  const hours = counted !== null ? Math.min(counted, dur) : Math.max(0, dur - breakMin / 60);
  return { starts: s, ends: e, hours: Math.round(hours * 100) / 100 };
}

// ---------------------------------------------------------------- წესები
export type RuleCode = 'rest' | 'continuous' | 'week' | 'nights';
export interface RuleEntry { id: string; staff_id: string; day: string; starts: number; ends: number; hours: number; kind: string }
export interface Violation { rule: RuleCode; mode: RuleMode; staff_id: string; entry_ids: string[]; day: string; message: string }
const r1 = (x: number) => Math.round(x * 10) / 10;

/**
 * სამუშაო დროის წესები (G): დასვენება ცვლებს შორის, ზედიზედ საათები, საათები კვირაში (ISO კვირა), ზედიზედ ღამეები.
 * „მორიგეობა სახლიდან“ სამუშაო დროდ არ ითვლება (წესებში არ მონაწილეობს). გადაფარვა — DB-ის EXCLUDE.
 */
export function evaluate(entries: RuleEntry[], s: RosterSettings): Violation[] {
  const out: Violation[] = [];
  const by = new Map<string, RuleEntry[]>();
  for (const e of entries) if (e.kind !== 'oncall_home') (by.get(e.staff_id) ?? by.set(e.staff_id, []).get(e.staff_id)!).push(e);
  for (const [staff, list] of by) {
    list.sort((a, b) => a.starts - b.starts);
    // დასვენება / ზედიზედ
    let chain: RuleEntry[] = [];
    const flush = () => {
      if (chain.length && s.continuous_mode !== 'off') {
        const h = (chain[chain.length - 1].ends - chain[0].starts) / 36e5;
        if (h > s.max_continuous_hours + 1e-9) out.push({ rule: 'continuous', mode: s.continuous_mode, staff_id: staff, entry_ids: chain.map((x) => x.id), day: chain[0].day,
          message: `ზედიზედ ${r1(h)} სთ (ზღვარი ${s.max_continuous_hours})` });
      }
      chain = [];
    };
    for (let i = 0; i < list.length; i++) {
      const e = list[i]; const prev = chain[chain.length - 1];
      if (prev && e.starts - prev.ends <= 0) { chain.push(e); continue; }
      if (prev && s.rest_mode !== 'off') {
        const gap = (e.starts - prev.ends) / 36e5;
        if (gap < s.rest_min_hours - 1e-9) out.push({ rule: 'rest', mode: s.rest_mode, staff_id: staff, entry_ids: [prev.id, e.id], day: e.day,
          message: `დასვენება ცვლებს შორის ${r1(gap)} სთ (მინ. ${s.rest_min_hours})` });
      }
      flush(); chain = [e];
    }
    flush();
    // კვირა
    if (s.week_mode !== 'off') {
      const weeks = new Map<string, RuleEntry[]>();
      for (const e of list) { const w = weekStart(e.day); (weeks.get(w) ?? weeks.set(w, []).get(w)!).push(e); }
      for (const [w, xs] of weeks) {
        const h = xs.reduce((a, x) => a + x.hours, 0);
        if (h > s.max_week_hours + 1e-9) out.push({ rule: 'week', mode: s.week_mode, staff_id: staff, entry_ids: xs.map((x) => x.id), day: w,
          message: `კვირაში ${r1(h)} სთ (ზღვარი ${s.max_week_hours}; კვირა ${w.slice(8)}.${w.slice(5, 7)}-დან)` });
      }
    }
    // ზედიზედ ღამეები (ღამის ცვლა ზედიზედ კალენდარულ დღეებში)
    if (s.nights_mode !== 'off') {
      const nights = list.filter((x) => x.kind === 'night').sort((a, b) => a.day.localeCompare(b.day));
      let run: RuleEntry[] = [];
      const done = () => { if (run.length > s.max_consecutive_nights) out.push({ rule: 'nights', mode: s.nights_mode, staff_id: staff, entry_ids: run.map((x) => x.id), day: run[0].day,
        message: `ზედიზედ ${run.length} ღამე (ზღვარი ${s.max_consecutive_nights})` }); run = []; };
      for (const n of nights) { if (run.length && addDays(run[run.length - 1].day, 1) !== n.day) done(); if (!run.length || run[run.length - 1].day !== n.day) run.push(n); }
      done();
    }
  }
  return out;
}

/** ექთანი / პაციენტი — ზღვარი განყოფილების დონით (ინფორმაციული; ავტომატური გადაწყვეტილება არ არის) */
export const ratioLimit = (s: Pick<RosterSettings, 'nurse_ratio'>, careLevel: string | null | undefined) =>
  (s.nurse_ratio ?? { ward: 8, intensive: 4, icu: 2 })[(careLevel ?? 'ward') as 'ward' | 'intensive' | 'icu'] ?? 8;
export interface NowPerson { user_id: string | null; staff_id: string; name: string; phone: string | null; position_name: string | null; category: string | null; department_id: string;
  department_name: string; code: string; kind: string; starts_at: Date | string; ends_at: Date | string; duty_name: string | null; duty_level: number | null }

/**
 * სხვა მოდულებისთვის (0079): ვინ არის მორიგე / ცვლაში, არყოფნა, ექთნების რაოდენობა ახლა. ყველგან — მხოლოდ გამოქვეყნებული / დახურული განრიგი.
 * გამორთული მოდული — ცარიელი შედეგი (settings → null).
 */
@Injectable()
export class RosterLookup {
  constructor(@InjectDb() private readonly db: Database) {}
  async enabled(ex: Ex = this.db) {
    const m = await ex.selectFrom('system_modules').select(['enabled']).where('code', '=', 'roster').executeTakeFirst();
    return !!m?.enabled;
  }
  /** მოდულის პარამეტრები (გამორთული — null) */
  async settings(ex: Ex = this.db): Promise<RosterSettings | null> {
    const m = await ex.selectFrom('system_modules').select(['enabled', 'settings']).where('code', '=', 'roster').executeTakeFirst();
    return m?.enabled ? (m.settings as unknown as RosterSettings) : null;
  }
  /** გამოქვეყნებული განრიგის მორიგეები მოცემულ მომენტში */
  async onDuty(at: Date, f: { departmentId?: string; dutyRoleId?: string } = {}, ex: Ex = this.db) {
    if (!(await this.enabled(ex))) return [];
    let q = ex.selectFrom('roster_entries as e').innerJoin('rosters as r', 'r.id', 'e.roster_id').innerJoin('duty_roles as dr', 'dr.id', 'e.duty_role_id')
      .innerJoin('staff_members as s', 's.id', 'e.staff_id').innerJoin('departments as d', 'd.id', 'r.department_id')
      .leftJoin('staff_positions as p', 'p.id', 's.position_id').leftJoin('users as u', 'u.id', 's.user_id')
      .select(['e.id', 'e.staff_id', 's.user_id', staffName('s').as('staff_name'), 'p.name as position_name', 'e.duty_role_id', 'dr.code as duty_code', 'dr.name as duty_name', 'e.duty_level',
        'dr.phone as duty_phone', sql<string | null>`coalesce(s.phone, u.phone)`.as('phone'), 'r.department_id', 'd.name as department_name', 'e.starts_at', 'e.ends_at'])
      .where('e.status', '=', 'active').where('r.status', 'in', ['published', 'closed'])
      .where('e.starts_at', '<=', at).where('e.ends_at', '>', at)
      .orderBy('dr.sort_order').orderBy('dr.name').orderBy('e.duty_level').orderBy('s.last_name');
    if (f.departmentId) q = q.where('r.department_id', '=', f.departmentId);
    if (f.dutyRoleId) q = q.where('e.duty_role_id', '=', f.dutyRoleId);
    return q.execute();
  }
  /**
   * ახლა ცვლაში (მორიგე — პირველი): განყოფილება (განრიგის), კატეგორია (პოზიციით), უფლება (ანგარიშის) — მაგ. კონსულტაცია: განყოფილება + ექიმი;
   * ბიომედი: med_engineer. „მორიგეობა სახლიდან“ შედის (გამოძახებადია).
   */
  async now(f: { departmentId?: string; category?: string; capability?: string }, at = new Date(), ex: Ex = this.db): Promise<NowPerson[]> {
    if (!(await this.enabled(ex))) return [];
    let q = ex.selectFrom('roster_entries as e').innerJoin('rosters as r', 'r.id', 'e.roster_id').innerJoin('staff_members as s', 's.id', 'e.staff_id')
      .innerJoin('departments as d', 'd.id', 'r.department_id').innerJoin('shift_templates as t', 't.id', 'e.shift_template_id')
      .leftJoin('staff_positions as p', 'p.id', 's.position_id').leftJoin('users as u', 'u.id', 's.user_id').leftJoin('duty_roles as dr', 'dr.id', 'e.duty_role_id')
      .select(['s.user_id', 'e.staff_id', staffName('s').as('name'), sql<string | null>`coalesce(dr.phone, s.phone, u.phone)`.as('phone'), 'p.name as position_name', 'p.category',
        'r.department_id', 'd.name as department_name', 't.code', 't.kind', 'e.starts_at', 'e.ends_at', 'dr.name as duty_name', 'e.duty_level'])
      .where('e.status', '=', 'active').where('r.status', 'in', ['published', 'closed']).where('e.starts_at', '<=', at).where('e.ends_at', '>', at)
      .orderBy(sql`e.duty_role_id IS NULL`).orderBy('e.duty_level').orderBy('s.last_name');
    if (f.departmentId) q = q.where('r.department_id', '=', f.departmentId);
    if (f.category) q = q.where('p.category', '=', f.category);
    if (f.capability) q = q.where('s.user_id', 'is not', null).where((eb) => eb.exists(eb.selectFrom('user_capabilities as c').select('c.user_id').whereRef('c.user_id', '=', 's.user_id')
      .where(sql<boolean>`c.capabilities && ARRAY[${f.capability}]::VARCHAR(30)[]`)));
    const rows = await q.execute();
    const seen = new Set<string>();
    return rows.filter((x) => (seen.has(x.staff_id) ? false : (seen.add(x.staff_id), true)));
  }
  /** დადასტურებული არყოფნა (ანგარიშიანი თანამშრომლები) დღეებში [from, to] — ტიპის გარეშე (კონფიდენციალურობა, 0078 D4) */
  async absentUsers(userIds: string[], from: string, to: string, ex: Ex = this.db) {
    const out = new Map<string, { no: string; from: string; to: string }>();
    if (!userIds.length || !(await this.enabled(ex))) return out;
    const rows = await ex.selectFrom('absence_requests as a').innerJoin('staff_members as s', 's.id', 'a.staff_id')
      .select(['s.user_id', sql<string>`a.no::text`.as('no'), sql<string>`to_char(a.date_from, 'YYYY-MM-DD')`.as('from'), sql<string>`to_char(a.date_to, 'YYYY-MM-DD')`.as('to')])
      .where('s.user_id', 'in', userIds).where('a.status', '=', 'approved').where('a.date_from', '<=', to).where('a.date_to', '>=', from).execute();
    for (const r of rows) if (r.user_id) out.set(r.user_id, { no: r.no, from: r.from, to: r.to });
    return out;
  }
  /**
   * ცვლის დაფარვა ინტერვალში: rostered — ვისი ძირითადი განყოფილების თვის განრიგი გამოქვეყნებულია (მაშინ ცვლის არქონას აზრი აქვს);
   * covered — ვისაც [from, to)-ს გადამფარავი აქტიური ცვლა აქვს (ნებისმიერ გამოქვეყნებულ განრიგში).
   */
  async shiftCoverage(userIds: string[], from: Date, to: Date, ex: Ex = this.db) {
    const res = { rostered: new Set<string>(), covered: new Set<string>() };
    if (!userIds.length || !(await this.enabled(ex))) return res;
    const month = `${localDay(from).slice(0, 7)}-01`;
    const [ros, cov] = await Promise.all([
      ex.selectFrom('staff_members as s').innerJoin('rosters as r', 'r.department_id', 's.department_id').select('s.user_id')
        .where('s.user_id', 'in', userIds).where('r.month', '=', month).where('r.status', 'in', ['published', 'closed']).execute(),
      ex.selectFrom('roster_entries as e').innerJoin('rosters as r', 'r.id', 'e.roster_id').innerJoin('staff_members as s', 's.id', 'e.staff_id').select('s.user_id')
        .where('s.user_id', 'in', userIds).where('e.status', '=', 'active').where('r.status', 'in', ['published', 'closed']).where('e.starts_at', '<', to).where('e.ends_at', '>', from).execute(),
    ]);
    for (const r of ros) if (r.user_id) res.rostered.add(r.user_id);
    for (const r of cov) if (r.user_id) res.covered.add(r.user_id);
    return res;
  }
  /** ექთნები ახლა ცვლაში (კატეგორია „ექთანი“, „მორიგეობა სახლიდან“ გარდა) — განყოფილება → რაოდენობა */
  async nursesNow(departmentIds: string[], at = new Date(), ex: Ex = this.db) {
    const out = new Map<string, number>();
    if (!departmentIds.length || !(await this.enabled(ex))) return out;
    const rows = await ex.selectFrom('roster_entries as e').innerJoin('rosters as r', 'r.id', 'e.roster_id').innerJoin('staff_members as s', 's.id', 'e.staff_id')
      .innerJoin('staff_positions as p', 'p.id', 's.position_id').innerJoin('shift_templates as t', 't.id', 'e.shift_template_id')
      .select(['r.department_id', sql<number>`count(DISTINCT e.staff_id)::int`.as('n')])
      .where('r.department_id', 'in', departmentIds).where('e.status', '=', 'active').where('r.status', 'in', ['published', 'closed'])
      .where('e.starts_at', '<=', at).where('e.ends_at', '>', at).where('p.category', '=', 'nurse').where('t.kind', '<>', 'oncall_home')
      .groupBy('r.department_id').execute();
    for (const r of rows) out.set(r.department_id, r.n);
    return out;
  }
  /** სტაციონარის / ICU დატვირთვა ახლა: პაციენტი (აქტიური მიმაგრება) / ექთანი ცვლაში; ზღვარი — nurse_ratio (care_level) */
  async load(at = new Date(), ex: Ex = this.db) {
    const s = await this.settings(ex);
    if (!s) return null;
    const deps = await ex.selectFrom('departments as d').select(['d.id', 'd.name', 'd.care_level',
      sql<number>`(SELECT count(*)::int FROM bed_assignments a WHERE a.department_id = d.id AND a.ended_at IS NULL)`.as('patients')])
      .where('d.type', '=', 'inpatient').where('d.is_active', '=', true).orderBy('d.name').execute();
    const nurses = await this.nursesNow(deps.map((d) => d.id), at, ex);
    return deps.map((d) => {
      const n = nurses.get(d.id) ?? 0; const limit = ratioLimit(s, d.care_level);
      const ratio = n ? Math.round((d.patients / n) * 10) / 10 : null;
      return { department_id: d.id, department_name: d.name, care_level: d.care_level, patients: d.patients, nurses: n, ratio, limit,
        level: d.patients === 0 ? 'ok' : !n ? 'none' : ratio! > limit ? 'over' : 'ok' };
    });
  }
}

@Global()
@Module({ providers: [RosterLookup], exports: [RosterLookup] })
export class RosterCoreModule {}
