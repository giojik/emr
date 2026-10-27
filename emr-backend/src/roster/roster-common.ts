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

/** სხვა მოდულებისთვის (0079: კონსულტაცია, ბიომედი, საოპერაციო): ვინ არის მორიგე / ცვლაში. გამორთული მოდული — ცარიელი */
@Injectable()
export class RosterLookup {
  constructor(@InjectDb() private readonly db: Database) {}
  async enabled(ex: Ex = this.db) {
    const m = await ex.selectFrom('system_modules').select(['enabled']).where('code', '=', 'roster').executeTakeFirst();
    return !!m?.enabled;
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
}

@Global()
@Module({ providers: [RosterLookup], exports: [RosterLookup] })
export class RosterCoreModule {}
