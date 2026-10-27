import { sql, type Transaction } from 'kysely';
import { loadEnv } from '../config/env';
import { has, type AuthUser, type Role } from '../auth/roles';
import type { Database } from '../database/database.module';
import type { DB } from '../database/db';

export type Trx = Transaction<DB>;
export type Ex = Database | Trx;
export const TZ = loadEnv().CLINIC_TZ;

/**
 * სამუშაო სიები (D5, 0081) — საერთო: პარამეტრები, წყაროების კატალოგი, ერთიანი ჩანაწერი, არეები.
 */
export interface WlSettings {
  /** ვის შეუძლია სხვისთვის მინიჭება: any — ნებისმიერს; department — თავის განყოფილებ(ებ)ში + სხვა განყოფილების რიგში; managers — სხვისთვის მხოლოდ ხელმძღვანელს */
  assign_scope: 'any' | 'department' | 'managers';
  /** შესრულების კომენტარი სავალდებულოა: off / urgent (მხოლოდ სასწრაფოზე) / all */
  done_comment: 'off' | 'urgent' | 'all';
  reopen_days: number;
  remind_at_due: boolean;
  /** ვადის გასვლიდან N საათში — ესკალაცია ხელმძღვანელზე; 0 — გამორთული */
  escalate_hours: number;
  /** ვადა პრიორიტეტით (ჩვეულებრივი / მაღალი / სასწრაფო), საათი; 0 — ვადის გარეშე. კატეგორიის SLA — უპირატესი */
  due_default_hours: [number, number, number];
  notify_assign: boolean;
  notify_done: boolean;
  patient_tasks: boolean;
  /** წყარო → false (გამორთული); არ არის — ჩართული */
  sources: Record<string, boolean>;
  /** მთვლელი: all — ყველა / overdue — მხოლოდ ვადაგადაცილებული / off */
  badge: 'all' | 'overdue' | 'off';
  refresh_seconds: number;
  /** „ჩემი დავალებები“ — საწყისი გვერდი ყველასთვის */
  home_tasks: boolean;
}
export const WL_DEFAULTS: WlSettings = {
  assign_scope: 'any', done_comment: 'urgent', reopen_days: 7, remind_at_due: true, escalate_hours: 0, due_default_hours: [0, 24, 4],
  notify_assign: true, notify_done: true, patient_tasks: true, sources: {}, badge: 'all', refresh_seconds: 60, home_tasks: false,
};

/** სისტემური წყაროების კატალოგი (კოდი → ჯგუფი / დასახელება / მოდული). 0082–0084 — დაემატება */
export const SOURCES: Record<string, { group: string; name: string; module: string; who: string }> = {
  qm_triage: { group: 'ხარისხი', name: 'ინციდენტის ტრიაჟი', module: 'quality', who: 'ხარისხის მენეჯერი (quality)' },
  qm_analysis: { group: 'ხარისხი', name: 'ინციდენტის ანალიზი (გამომძიებელი / გუნდი)', module: 'quality', who: 'გამომძიებელი, RCA გუნდის წევრი' },
  qm_review: { group: 'ხარისხი', name: 'წარდგენილი ანალიზის დამტკიცება', module: 'quality', who: 'ხარისხის მენეჯერი' },
  qm_capa: { group: 'ხარისხი', name: 'მაკორექტირებელი ქმედება (CAPA)', module: 'quality', who: 'CAPA-ს პასუხისმგებელი' },
  qm_capa_due: { group: 'ხარისხი', name: 'CAPA — ვადის ცვლილების მოთხოვნა', module: 'quality', who: 'ხარისხის მენეჯერი' },
  qm_effect: { group: 'ხარისხი', name: 'CAPA — ეფექტიანობის შემოწმება', module: 'quality', who: 'ხარისხის მენეჯერი' },
  ipc_signal: { group: 'ინფექციის კონტროლი', name: 'IPC სიგნალი', module: 'ipc', who: 'infection (ყველა) / infection_dept (განყოფილება)' },
  ipc_hai: { group: 'ინფექციის კონტროლი', name: 'HAI შემთხვევა — განსახილველი', module: 'ipc', who: 'infection / infection_dept' },
  ipc_flag: { group: 'ინფექციის კონტროლი', name: 'MDRO ფლაგი — დასადასტურებელი', module: 'ipc', who: 'infection' },
  ipc_ssi: { group: 'ინფექციის კონტროლი', name: 'SSI — პაციენტთან კონტაქტი', module: 'ipc', who: 'infection / infection_dept' },
  ipc_abx: { group: 'ინფექციის კონტროლი', name: 'ანტიბიოტიკის გადახედვა (time-out)', module: 'ipc', who: 'დამნიშნავი / მკურნალი ექიმი' },
  bme_triage: { group: 'ბიომედ-აპარატურა', name: 'შეკეთების მოთხოვნა — ტრიაჟი', module: 'bme', who: 'სამედიცინო ინჟინერი' },
  bme_repair: { group: 'ბიომედ-აპარატურა', name: 'შეკეთების ორდერი (ჩემზე)', module: 'bme', who: 'შემსრულებელი' },
  bme_confirm: { group: 'ბიომედ-აპარატურა', name: 'შეკეთება — დასადასტურებელი', module: 'bme', who: 'განმცხადებელი, განყოფილება (bme_dept)' },
  bme_work: { group: 'ბიომედ-აპარატურა', name: 'PM / კალიბრაცია (ჩემზე)', module: 'bme', who: 'შემსრულებელი' },
  bme_work_free: { group: 'ბიომედ-აპარატურა', name: 'PM / კალიბრაცია — შემსრულებლის გარეშე', module: 'bme', who: 'სამედიცინო ინჟინერი' },
  roster_absence: { group: 'ცვლები და მორიგეობა', name: 'არყოფნის მოთხოვნა — გადაწყვეტილება', module: 'roster', who: 'ხელმძღვანელი / HR' },
  roster_swap: { group: 'ცვლები და მორიგეობა', name: 'გაცვლა — შემდგენის დადასტურება', module: 'roster', who: 'განრიგის შემდგენი' },
  roster_offer: { group: 'ცვლები და მორიგეობა', name: 'დასაფარი ცვლა — მოხალისის მინიჭება', module: 'roster', who: 'განრიგის შემდგენი' },
  roster_peer: { group: 'ცვლები და მორიგეობა', name: 'გაცვლის თხოვნა კოლეგისგან', module: 'roster', who: 'კოლეგა' },
  roster_timesheet: { group: 'ცვლები და მორიგეობა', name: 'თვის ტაბელის დახურვა', module: 'roster', who: 'HR' },
};
export const SOURCE_CODES = Object.keys(SOURCES);

export type Priority = 'normal' | 'high' | 'urgent';
export const PRIORITY_KA: Record<Priority, string> = { normal: 'ჩვეულებრივი', high: 'მაღალი', urgent: 'სასწრაფო' };
export const PRI_RANK: Record<Priority, number> = { urgent: 0, high: 1, normal: 2 };
export const STATUS_KA: Record<string, string> = { open: 'ღია', in_progress: 'შესრულებაში', done: 'შესრულებული', cancelled: 'გაუქმებული' };
export const TARGET_KA: Record<string, string> = { user: 'პირი', role: 'როლი', department: 'განყოფილება', role_department: 'როლი + განყოფილება', duty: 'მორიგე' };
export const ACTIVE = ['open', 'in_progress'] as const;

/** ერთიანი ჩანაწერი „ჩემს დავალებებში“ (სისტემური / ხელით) */
export interface WlItem {
  key: string;
  kind: 'system' | 'task';
  source: string;
  group: string;
  title: string;
  detail: string | null;
  patient: string | null;
  department: string | null;
  due_at: string | null;
  /** due_at — დღის ბოლო (ვადა თარიღია, საათის გარეშე) */
  due_date_only: boolean;
  overdue: boolean;
  priority: Priority;
  link: string;
  created_at: string | null;
  /** ხელით: დავალების დამატებითი ველები */
  task?: { id: string; task_no: string; status: string; target_kind: string; target_label: string; claimed_by_name: string | null; group: boolean; created_by_name: string | null };
}

export const userName = (alias: string) => sql<string | null>`${sql.ref(`${alias}.last_name`)} || ' ' || ${sql.ref(`${alias}.first_name`)}`;
export const iso = (d: Date | string | null | undefined) => (d == null ? null : d instanceof Date ? d.toISOString() : new Date(d).toISOString());
/** YYYY-MM-DD → ამ დღის 00:00 კლინიკის დროით */
export function zonedMidnight(day: string, tz = TZ): Date {
  const probe = new Date(`${day}T12:00:00Z`);
  const off = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(probe).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(off);
  const mins = m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0;
  return new Date(Date.parse(`${day}T00:00:00Z`) - mins * 60_000);
}
/** თარიღის ვადა → დღის ბოლო კლინიკის დროით (ISO) */
export const dayEnd = (col: string) => sql<Date | null>`((${sql.ref(col)}::date + 1)::timestamp AT TIME ZONE ${TZ}) - interval '1 second'`;

/** ხელმძღვანელის უფლებები */
export const WL_ALL: Role[] = ['admin', 'worklist_all'];
export const WL_MANAGE: Role[] = ['worklist_manage'];
export const isAll = (u: AuthUser) => has(u, ...WL_ALL);

/** worklist_manage-ის არე: users.department_id ∪ rpt_user_scopes (როგორც სხვა მოდულებში) */
export async function manageDepts(ex: Ex, u: AuthUser): Promise<string[]> {
  if (!has(u, ...WL_MANAGE)) return [];
  const r = await sql<{ id: string }>`SELECT department_id AS id FROM rpt_user_scopes WHERE user_id = ${u.id}
    UNION SELECT department_id FROM users WHERE id = ${u.id} AND department_id IS NOT NULL`.execute(ex);
  return r.rows.map((x) => x.id);
}
/**
 * განყოფილების რიგის წევრობა (ვინ არის „განყოფილება X“-ის წევრი): users.department_id ∪ D4 თანამშრომლის ძირითადი / დამატებითი განყოფილებები.
 * რეპორტინგის ხედვის არე (rpt_user_scopes) აქ არ ითვლება — ის ხედვაა და არა წევრობა.
 */
export async function memberDepts(ex: Ex, userId: string): Promise<string[]> {
  const r = await sql<{ id: string }>`
    SELECT department_id AS id FROM users WHERE id = ${userId} AND department_id IS NOT NULL
    UNION SELECT s.department_id FROM staff_members s WHERE s.user_id = ${userId} AND s.is_active AND s.department_id IS NOT NULL
    UNION SELECT x.department_id FROM staff_member_departments x JOIN staff_members s ON s.id = x.staff_id WHERE s.user_id = ${userId} AND s.is_active`.execute(ex);
  return r.rows.map((x) => x.id);
}
export async function myRoleIds(ex: Ex, userId: string): Promise<string[]> {
  const r = await sql<{ id: string }>`SELECT ur.role_id AS id FROM user_roles ur JOIN roles r ON r.id = ur.role_id AND r.is_active WHERE ur.user_id = ${userId}`.execute(ex);
  return r.rows.map((x) => x.id);
}
/** ამ მომენტში მორიგე ვარ თუ არა (გამოქვეყნებული განრიგი) — SQL-ის პირობა t.target_duty_role_id-ზე */
export const onDutyCond = (userId: string, at: Date | null = null) => sql<boolean>`EXISTS (
  SELECT 1 FROM roster_entries e JOIN rosters r ON r.id = e.roster_id JOIN staff_members s ON s.id = e.staff_id
   WHERE s.user_id = ${userId} AND e.duty_role_id = t.target_duty_role_id AND e.status = 'active' AND r.status IN ('published', 'closed')
     AND e.starts_at <= coalesce(${at}::timestamptz, now()) AND e.ends_at > coalesce(${at}::timestamptz, now())
     AND EXISTS (SELECT 1 FROM system_modules m WHERE m.code = 'roster' AND m.enabled))`;

export async function wlSettings(ex: Ex): Promise<{ enabled: boolean; s: WlSettings }> {
  const m = await ex.selectFrom('system_modules').select(['enabled', 'settings']).where('code', '=', 'worklist').executeTakeFirst();
  return { enabled: !!m?.enabled, s: { ...WL_DEFAULTS, ...((m?.settings ?? {}) as Partial<WlSettings>) } };
}
export async function enabledModules(ex: Ex): Promise<Set<string>> {
  const r = await ex.selectFrom('system_modules').select('code').where('enabled', '=', true).execute();
  return new Set(r.map((x) => x.code));
}
