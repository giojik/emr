import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';

export type Category = 'doctor' | 'nurse' | 'junior' | 'tech' | 'admin' | 'other';
export type Kind = 'day' | 'evening' | 'night' | '24h' | 'oncall_site' | 'oncall_home' | 'other';
export type Mode = 'block' | 'warn' | 'off';
export const CAT_KA: Record<Category, string> = { doctor: 'ექიმი', nurse: 'ექთანი', junior: 'უმცროსი პერსონალი', tech: 'ტექნიკური', admin: 'ადმინისტრაციული', other: 'სხვა' };
export const KIND_KA: Record<Kind, string> = { day: 'დღის', evening: 'საღამოს', night: 'ღამის', '24h': 'სადღეღამისო', oncall_site: 'მორიგეობა ადგილზე', oncall_home: 'მორიგეობა სახლიდან', other: 'სხვა' };
export const EMP_KA: Record<string, string> = { staff: 'შტატიანი', part_time: 'ნახევარ განაკვეთზე', contract: 'ხელშეკრულებით', intern: 'სტაჟიორი', resident: 'რეზიდენტი' };
export const DOW_KA = ['', 'ორ', 'სა', 'ოთ', 'ხუ', 'პა', 'შა', 'კვ'];
export const MONTH_KA = ['იანვარი', 'თებერვალი', 'მარტი', 'აპრილი', 'მაისი', 'ივნისი', 'ივლისი', 'აგვისტო', 'სექტემბერი', 'ოქტომბერი', 'ნოემბერი', 'დეკემბერი'];
export const monthLabel = (m: string) => `${MONTH_KA[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
export const ddmm = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;

export interface Position { id: string; code: string; name: string; category: Category; is_active: boolean; sort_order: number; staff: number }
export interface Template { id: string; code: string; name: string; kind: Kind; start_time: string; end_time: string; break_min: number; counted_hours: string | null; color: string;
  department_ids: string[]; categories: Category[]; is_active: boolean; sort_order: number; hours: number }
export interface DutyRole { id: string; code: string; name: string; department_id: string | null; department_name: string | null; categories: Category[]; required_count: number; has_backup: boolean;
  phone: string | null; is_active: boolean; sort_order: number }
export interface Pattern { id: string; code: string; name: string; cycle: string[]; is_active: boolean }
export interface Dept { id: string; name: string; code: string; type: string; can_edit: boolean; can_view: boolean }
export interface Settings { rest_min_hours: number; rest_mode: Mode; max_continuous_hours: number; continuous_mode: Mode; max_week_hours: number; week_mode: Mode;
  max_consecutive_nights: number; nights_mode: Mode; norm_mode: 'warn' | 'off'; cross_department: 'allow' | 'warn' | 'block'; publish_notify: boolean; change_notify: boolean;
  duty_phone: 'all' | 'staff' | 'off'; copy_mode: 'weekday' | 'date';
  absence_unit_mode: 'weekdays' | 'roster'; accrual: 'annual' | 'monthly'; balance_overdraw: 'block' | 'warn'; swap_approval: 'head' | 'none'; swap_min_notice_hours: number;
  open_shift_volunteer: boolean; open_shift_notify: boolean; prefs_mode: 'warn' | 'off'; prefs_deadline_day: number; unavailable_max_per_month: number;
  // 0079
  week_norm_hours: number; overtime_basis: 'month' | 'off'; overtime_default: 'pay' | 'comp'; comp_absence_type: string; night_from: string; night_to: string; close_requires_submit: boolean;
  link_consult: 'off' | 'hint' | 'duty'; link_bme: 'off' | 'hint' | 'duty'; link_or: 'off' | 'absence' | 'absence_shift'; nurse_ratio: { ward: number; intensive: number; icu: number } }
/** 0078: არყოფნის ტიპი */
export interface AbsenceType { id: string; code: string; name: string; short: string; color: string; paid: boolean; counts_as_work: boolean; unit: 'workday' | 'calendar'; has_balance: boolean;
  default_days: string | null; route: 'head_hr' | 'head' | 'hr' | 'none'; requires_document: boolean; self_request: boolean; is_active: boolean; sort_order: number }
export const ROUTE_KA: Record<string, string> = { head_hr: 'ხელმძღვანელი → HR', head: 'ხელმძღვანელი', hr: 'HR', none: 'მხოლოდ რეგისტრაცია' };
export const ABS_STATUS: Record<string, [string, string]> = { head: ['warn', 'ხელმძღვანელთან'], hr: ['warn', 'HR-თან'], approved: ['ok', 'დადასტურებული'], rejected: ['danger', 'უარყოფილი'], cancelled: ['', 'გაუქმებული'] };
export const SWAP_STATUS: Record<string, [string, string]> = { peer: ['warn', 'კოლეგასთან'], head: ['warn', 'ხელმძღვანელთან'], approved: ['ok', 'შესრულებული'], rejected: ['danger', 'უარყოფილი'],
  declined: ['danger', 'კოლეგამ უარი თქვა'], cancelled: ['', 'გაუქმებული'], expired: ['', 'ვადაგასული'] };
export interface AbsenceRow { id: string; no: string; staff_id: string; staff_name: string; staff_user_id: string | null; department_id: string; department_name: string; position_name: string | null;
  absence_type_id: string; type_code: string; type_name: string; short: string; color: string; has_balance: boolean; requires_document: boolean; date_from: string; date_to: string; days: string;
  balance_year: number; status: string; route: string; note: string | null; document_no: string | null; has_file: boolean; on_behalf: boolean; head_skipped: boolean; cancel_requested_at: string | null;
  cancel_request_note: string | null; reject_reason: string | null; cancel_reason: string | null; overdraw_reason: string | null; created_at: string; decided_at: string | null; created_by_name: string | null;
  can_act: boolean; can_cancel_decide: boolean }
export interface SwapRow { id: string; no: string; kind: 'swap' | 'give'; status: string; status_name: string; note: string | null; warnings: string[]; expires_at: string; created_at: string;
  peer_note: string | null; head_note: string | null; reason: string | null; from_staff_id: string; to_staff_id: string; a_staff_name: string; b_staff_name: string;
  a_day: string; a_starts_at: string; a_ends_at: string; a_code: string; a_department: string; b_day: string | null; b_starts_at: string | null; b_ends_at: string | null; b_code: string | null; b_department: string | null;
  direction?: 'in' | 'out' }
export interface OpenShift { id: string; roster_id?: string; department_id?: string; department_name?: string; day: string; shift_template_id: string; code: string; shift_name?: string; color: string;
  starts_at: string; ends_at: string; hours: string; duty_role_id: string | null; duty_name: string | null; duty_level: number | null; category: Category | null; source: 'absence' | 'cancel' | 'manual';
  note: string | null; offers?: { staff_id: string; name: string; status?: string; note?: string | null }[]; my_offer?: string | null; busy?: boolean; absent?: boolean }
export const SRC_KA: Record<string, string> = { absence: 'არყოფნა', cancel: 'გაუქმება', manual: 'ხელით' };
export interface Refs { settings: Settings; positions: Position[]; templates: Template[]; duty_roles: DutyRole[]; patterns: Pattern[]; departments: Dept[]; rest: string;
  absence_types: AbsenceType[]; me: { id: string; name: string; department_id: string; category: Category | null } | null;
  can: { setup: boolean; hr: boolean; staff_all: boolean; edit_all: boolean; view_all: boolean; edit_depts: string[]; absence_all: boolean; absence_hr: boolean; absence_depts: string[];
    timesheet: boolean; timesheet_all: boolean; timesheet_close: boolean } }
export const useRefs = () => useQuery({ queryKey: ['roster-refs'], queryFn: () => api<Refs>('/roster/refs') });

export interface Staff { id: string; user_id: string | null; first_name: string; last_name: string; name: string; personal_number: string | null; phone: string | null; position_id: string | null;
  position_name: string | null; category: Category | null; department_id: string; department_name: string; fte: string; employment: string; hired_on: string | null; left_on: string | null;
  is_active: boolean; notes: string | null; user_email: string | null; user_active: boolean | null; extra_department_ids: string[] }
export interface Entry { id: string; staff_id: string; day: string; shift_template_id: string; code: string; kind: Kind; color: string; starts_at: string; ends_at: string; hours: string;
  duty_role_id: string | null; duty_level: number | null; note: string | null; category: Category | null; start_local: string; end_local: string;
  /** 0079: ფაქტი */
  att_status: 'plan' | 'worked' | 'no_show'; actual_hours: string | null; actual_note: string | null; actual_start_local: string | null; actual_end_local: string | null }
export interface Violation { rule: 'rest' | 'continuous' | 'week' | 'nights'; mode: Mode; staff_id: string; entry_ids: string[]; day: string; message: string }
export interface RosterRow { id: string | null; department_id: string; department_name: string; status: 'none' | 'draft' | 'published' | 'closed'; version: number | null; published_at: string | null;
  entries: number; staff: number; members: number; can_edit: boolean }
export interface RosterDetail {
  id: string; department_id: string; department_name: string; month: string; status: 'draft' | 'published' | 'closed'; version: number; note: string | null; published_at: string | null;
  published_by_name: string | null; can_edit: boolean;
  days: { day: string; dow: number; holiday: string | null }[];
  staff: { id: string; name: string; user_id: string | null; department_id: string; position_name: string | null; category: Category | null; fte: string; is_active: boolean; home: boolean }[];
  entries: Entry[]; violations: Violation[]; gaps: { day: string; norm_id: string; code: string; category: Category; have: number; need: number }[];
  duty_gaps: { day: string; duty_role_id: string; name: string; have: number; need: number }[];
  totals: Record<string, { hours: number; shifts: number; nights: number; weekend: number; holiday: number; duty: number }>;
  holidays: { day: string; name: string }[]; blocking: number; warnings: number;
  // 0078
  absences: { id: string | null; no: string | null; staff_id: string; date_from: string; date_to: string; status: string; absence_type_id: string | null; short: string; color: string; name: string }[];
  absence_detail: boolean;
  prefs: { staff_id: string; day: string; kind: 'unavailable' | 'prefer'; part: 'all' | 'day' | 'night'; shift_template_id: string | null; code: string | null; note: string | null }[];
  open_shifts: OpenShift[];
}
export const STATUS_KA: Record<string, [string, string]> = { none: ['', 'არ არის'], draft: ['warn', 'მონახაზი'], published: ['ok', 'გამოქვეყნებული'], closed: ['info', 'დახურული'] };
export const timeRange = (t: { start_time: string; end_time: string }) => `${t.start_time.slice(0, 5)}–${t.end_time.slice(0, 5)}`;

// ---------------------------------------------------------------- 0079: საათები / ტაბელი
export const ATT_KA: Record<string, string> = { plan: 'გეგმით', worked: 'შესწორებული ფაქტი', no_show: 'არ გამოცხადდა' };
export interface AbsSum { type_id: string; code: string; short: string; name: string; paid: boolean; counts_as_work: boolean; days: number; workdays: number }
export interface TsRow {
  staff_id: string; name: string; personal_number: string | null; position_name: string | null; category: Category | null; department_id: string; department_name: string; fte: number;
  home: boolean; shifts: number; plan_hours: number; worked_hours: number; night_hours: number; holiday_hours: number; weekend_hours: number; no_show: number;
  total_hours: number | null; credit_hours: number | null; norm_hours: number | null; overtime_hours: number | null; ot_pay_hours: number | null; ot_comp_hours: number | null; comp_days: number | null;
  person: { night?: number; holiday?: number; weekend?: number; no_show?: number; workdays?: number }; absence: AbsSum[]; days: Record<string, string>;
}
export interface Timesheet {
  roster: { id: string; department_id: string; department_name: string; month: string; status: 'published' | 'closed'; timesheet_submitted_at: string | null; submitted_by_name: string | null;
    closed_at: string | null; closed_by_name: string | null; close_note: string | null };
  source: 'live' | 'snapshot'; preliminary: boolean; ended: boolean; stale: { no: string; staff_name: string; status: string; date_from: string; date_to: string }[];
  settings: { week_norm_hours: number; overtime_basis: string; overtime_default: 'pay' | 'comp'; night_from: string; night_to: string; close_requires_submit: boolean; comp_absence_type: string };
  workdays: number; days: { day: string; dow: number; holiday: string | null }[]; rows: TsRow[];
  totals: Record<string, number>; checks: { pending: { no: string; staff_name: string; status: string }[]; open_shifts: number; no_show: number };
  can: { actual: boolean; submit: boolean; close: boolean; reopen: boolean; export: boolean; pii: boolean };
}
export interface TsOverview { month: string; ended: boolean; rows: { id: string; department_id: string; department_name: string; status: 'published' | 'closed'; timesheet_submitted_at: string | null;
  closed_at: string | null; staff: number; actuals: number; overtime: number | null; stale: number }[]; can: { export_all: boolean; close: boolean } }
export const fmtH = (h: number | null | undefined) => (h === null || h === undefined ? '—' : String(Math.round(h * 100) / 100));
