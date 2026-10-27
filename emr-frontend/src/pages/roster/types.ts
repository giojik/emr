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
  duty_phone: 'all' | 'staff' | 'off'; copy_mode: 'weekday' | 'date' }
export interface Refs { settings: Settings; positions: Position[]; templates: Template[]; duty_roles: DutyRole[]; patterns: Pattern[]; departments: Dept[]; rest: string;
  can: { setup: boolean; hr: boolean; staff_all: boolean; edit_all: boolean; view_all: boolean; edit_depts: string[] } }
export const useRefs = () => useQuery({ queryKey: ['roster-refs'], queryFn: () => api<Refs>('/roster/refs') });

export interface Staff { id: string; user_id: string | null; first_name: string; last_name: string; name: string; personal_number: string | null; phone: string | null; position_id: string | null;
  position_name: string | null; category: Category | null; department_id: string; department_name: string; fte: string; employment: string; hired_on: string | null; left_on: string | null;
  is_active: boolean; notes: string | null; user_email: string | null; user_active: boolean | null; extra_department_ids: string[] }
export interface Entry { id: string; staff_id: string; day: string; shift_template_id: string; code: string; kind: Kind; color: string; starts_at: string; ends_at: string; hours: string;
  duty_role_id: string | null; duty_level: number | null; note: string | null; category: Category | null; start_local: string; end_local: string }
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
}
export const STATUS_KA: Record<string, [string, string]> = { none: ['', 'არ არის'], draft: ['warn', 'მონახაზი'], published: ['ok', 'გამოქვეყნებული'], closed: ['info', 'დახურული'] };
export const timeRange = (t: { start_time: string; end_time: string }) => `${t.start_time.slice(0, 5)}–${t.end_time.slice(0, 5)}`;
