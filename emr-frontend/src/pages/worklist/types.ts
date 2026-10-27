import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useModules } from '../../lib/modules';

/** სამუშაო სიები (0081) — ტიპები / ცნობარები */
export type Priority = 'normal' | 'high' | 'urgent';
export type TargetKind = 'user' | 'role' | 'department' | 'role_department' | 'duty';
export const PRIORITY_KA: Record<Priority, string> = { normal: 'ჩვეულებრივი', high: 'მაღალი', urgent: 'სასწრაფო' };
export const PRIORITY_CHIP: Record<Priority, string> = { normal: '', high: 'warn', urgent: 'danger' };
export const STATUS_KA: Record<string, string> = { open: 'ღია', in_progress: 'შესრულებაში', done: 'შესრულებული', cancelled: 'გაუქმებული' };
export const STATUS_CHIP: Record<string, string> = { open: 'info', in_progress: 'warn', done: 'ok', cancelled: '' };
export const TARGET_KA: Record<TargetKind, string> = { user: 'პირი', role: 'როლი', department: 'განყოფილება (რიგი)', role_department: 'როლი + განყოფილება', duty: 'მორიგე (ახლა)' };
export const EVENT_KA: Record<string, string> = {
  created: 'შეიქმნა', edited: 'შეიცვალა', reassigned: 'გადანაწილდა', claimed: 'აიღო', released: 'დააბრუნა', started: 'დაიწყო', done: 'შესრულდა', cancelled: 'გაუქმდა',
  reopened: 'ხელახლა გაიხსნა', comment: 'კომენტარი', reminded: 'შეხსენება (ვადა დადგა)', escalated: 'ესკალაცია ხელმძღვანელზე',
};

export interface Category { id: string; code: string; name: string; description: string | null; default_target_kind: TargetKind | null; default_role_id: string | null; default_department_id: string | null;
  default_role_name: string | null; default_department_name: string | null; sla_hours: number | null; allow_patient: boolean; is_active: boolean; sort_order: number }
export interface Refs {
  settings: { assign_scope: string; done_comment: 'off' | 'urgent' | 'all'; reopen_days: number; patient_tasks: boolean; refresh_seconds: number; badge: string; escalate_hours: number; due_default_hours: number[] };
  can: { team: boolean; all: boolean; categories: boolean; patients: boolean; run_jobs: boolean };
  team_departments: string[]; my_departments: string[];
  categories: Category[]; roles: { id: string; code: string; name: string }[]; departments: { id: string; name: string; type: string }[];
  duty_roles: { id: string; name: string; department_name: string | null }[];
  sources: { code: string; group: string; name: string; module: string; who: string; enabled: boolean; module_enabled: boolean }[];
}
export interface Item {
  key: string; kind: 'system' | 'task'; source: string; group: string; title: string; detail: string | null; patient: string | null; department: string | null;
  due_at: string | null; due_date_only: boolean; overdue: boolean; priority: Priority; link: string; created_at: string | null;
  task?: { id: string; task_no: string; status: string; target_kind: TargetKind; target_label: string; claimed_by_name: string | null; group: boolean; created_by_name: string | null };
}
export interface Mine { generated_at: string; refresh_seconds: number; totals: { total: number; overdue: number; urgent: number }; sources: { source: string; group: string; name: string; count: number; overdue: number }[]; items: Item[] }
export interface Can { claim: boolean; release: boolean; start: boolean; done: boolean; cancel: boolean; edit: boolean; reassign: boolean; reopen: boolean; comment: boolean }
export interface Task {
  id: string; task_no: string; title: string; description: string | null; category_id: string | null; category_name: string | null; priority: Priority; priority_name: string;
  due_at: string | null; target_kind: TargetKind; target_label: string; group: boolean; assignee_id: string | null; assignee_name: string | null;
  target_role_id: string | null; target_department_id: string | null; target_duty_role_id: string | null; department_id: string | null; department_name: string | null;
  claimed_by: string | null; claimed_by_name: string | null; claimed_at: string | null; patient_id: string | null; patient_name: string | null; patient_personal_number: string | null; encounter_id: string | null;
  status: string; status_name: string; created_by: string; created_by_name: string | null; created_at: string; started_at: string | null; done_at: string | null; done_note: string | null;
  cancelled_at: string | null; cancel_reason: string | null; escalated_at: string | null; overdue: boolean; can: Can;
  events?: { id: string; kind: string; note: string | null; data: Record<string, unknown> | null; created_at: string; user_name: string | null }[];
}
export interface Target { target_kind: TargetKind; assignee_id?: string | null; target_role_id?: string | null; target_department_id?: string | null; target_duty_role_id?: string | null }

export const useWorklistEnabled = () => { const m = useModules(); return { loading: m.isLoading, enabled: !!m.data?.find((x) => x.code === 'worklist')?.enabled }; };
export const useWlRefs = (enabled = true) => useQuery({ queryKey: ['wl-refs'], queryFn: () => api<Refs>('/worklist/refs'), enabled, staleTime: 60_000 });
