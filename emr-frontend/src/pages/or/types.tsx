import { useQuery } from '@tanstack/react-query';
import { api, type Role } from '../../api/client';
import { hhmm, tsDate } from '../../lib/format';
import { useModules } from '../../lib/modules';

/** საოპერაციო ბლოკი — დაგეგმვა (0048) */
export const OR_READ: Role[] = ['admin', 'doctor', 'nurse', 'or_schedule', 'anesthesiologist', 'or_nurse', 'manager', 'viewer'];

export interface OrSettings {
  or_scheduling: 'coordinator' | 'surgeon_self' | 'both'; anesthesia_team_by: 'anesthesia_head' | 'surgeon'; preop_readiness: 'warn' | 'block';
  turnover_min: number; default_duration_min: number; self_booking_days: number; notify_requests: boolean;
}
export const OR_DEFAULT: OrSettings = { or_scheduling: 'coordinator', anesthesia_team_by: 'anesthesia_head', preop_readiness: 'warn', turnover_min: 30, default_duration_min: 60,
  self_booking_days: 30, notify_requests: true };
export const useOrModule = () => {
  const q = useModules();
  const m = q.data?.find((x) => x.code === 'or');
  return { enabled: !!m?.enabled, settings: { ...OR_DEFAULT, ...((m?.settings ?? {}) as Partial<OrSettings>) }, loading: q.isLoading };
};

export const ANESTHESIA_KA: Record<string, string> = { general: 'ზოგადი', spinal: 'სპინალური', epidural: 'ეპიდურული', combined: 'კომბინირებული (სპინ.-ეპიდ.)',
  regional: 'რეგიონული (ბლოკადა)', sedation: 'სედაცია', local: 'ადგილობრივი', none: 'ანესთეზიის გარეშე' };
export const URGENCY: Record<string, [string, string]> = { elective: ['', 'გეგმიური'], urgent: ['warn', 'სასწრაფო'], emergency: ['danger', 'გადაუდებელი'] };
export const CASE_ST: Record<string, [string, string]> = { requested: ['info', 'მოთხოვნა'], tentative: ['warn', 'დასადასტურებელი'], scheduled: ['info', 'დაგეგმილი'],
  in_progress: ['accent', 'მიმდინარე'], completed: ['ok', 'დასრულებული'], cancelled: ['', 'გაუქმებული'] };
export const SIDE_KA: Record<string, string> = { left: 'მარცხენა', right: 'მარჯვენა', bilateral: 'ორმხრივი', na: '—' };
export const TIME_KINDS = ['in_room', 'anesthesia_start', 'incision', 'closure', 'anesthesia_end', 'out_of_room', 'pacu_in', 'pacu_out'] as const;
export type TimeKind = (typeof TIME_KINDS)[number];
export const TIME_KA: Record<TimeKind, string> = { in_room: 'საოპერაციოში შემოვიდა', anesthesia_start: 'ანესთეზიის დაწყება', incision: 'განაკვეთი', closure: 'ნაკერი',
  anesthesia_end: 'ანესთეზიის დასრულება', out_of_room: 'საოპერაციოდან გავიდა', pacu_in: 'PACU — შემოსვლა', pacu_out: 'PACU — გასვლა' };
export const PHASE_KA: Record<string, string> = { in_room: 'ოთახშია', anesthesia_start: 'ანესთეზია', incision: 'ოპერაცია', closure: 'ნაკერი', anesthesia_end: 'გამოღვიძება',
  out_of_room: 'გავიდა', pacu_in: 'PACU', pacu_out: 'PACU-დან გავიდა' };
export const DEST_KA: Record<string, string> = { ward: 'განყოფილება', icu: 'რეანიმაცია (ICU)', pacu: 'PACU', other: 'სხვა' };
export const WHO_KA: Record<string, [string, string]> = { sign_in: ['Sign in', 'ანესთეზიის დაწყებამდე'], time_out: ['Time out', 'განაკვეთამდე'], sign_out: ['Sign out', 'პაციენტის ოთახიდან გასვლამდე'] };
export const RISK_KA: Record<string, string> = { difficult_airway: 'რთული სასუნთქი გზები', aspiration: 'ასპირაციის რისკი', cardiac: 'კარდიული', pulmonary: 'ფილტვის', renal: 'თირკმლის',
  hepatic: 'ღვიძლის', diabetes: 'დიაბეტი', obesity: 'სიმსუქნე', bleeding: 'სისხლდენის რისკი', ponv: 'PONV', malignant_hyperthermia: 'ავთვისებიანი ჰიპერთერმია', allergy: 'ალერგია', other: 'სხვა' };
export const GRP_KA: Record<string, string> = { surgical: 'ქირურგიული', anesthesia: 'ანესთეზია', nursing: 'საექთნო' };
export const APPLIES_KA: Record<string, string> = { always: 'ყოველთვის', anesthesia: 'ანესთეზიისას', laterality: 'მხარის მითითებისას', blood: 'სისხლის საჭიროებისას', implant: 'იმპლანტი / აპარატურა' };
export const SOURCE_KA: Record<string, string> = { manual: 'ხელით', consent_surgery: 'ოპერაციის თანხმობა (ავტომატური)', consent_anesthesia: 'ანესთეზიის თანხმობა (ავტომატური)', assessment: 'გასინჯვა (ავტომატური)' };
export const EVENT_KA: Record<string, string> = { requested: 'მოთხოვნა', updated: 'შეიცვალა', tentative: 'წინასწარი ჯავშანი', scheduled: 'დაიგეგმა', confirmed: 'დადასტურდა', rescheduled: 'გადატანა',
  unscheduled: 'გადაიდო', cancelled: 'გაუქმდა', surgeon_changed: 'ოპერატორი შეიცვალა', team_added: 'გუნდი: დაემატა', team_removed: 'გუნდი: მოიხსნა', team_out: 'გუნდი: გავიდა',
  preop_signed: 'გასინჯვა ხელმოწერილია', preop_voided: 'გასინჯვა გაუქმდა', readiness: 'მზადყოფნა', readiness_override: 'მზადყოფნა — დასაბუთებით', who: 'WHO', who_voided: 'WHO — გაუქმდა',
  time: 'ნიშნული', time_corrected: 'ნიშნული შესწორდა', encounter_linked: 'ჰოსპიტალიზაცია მიება' };

export interface Room { id: string; department_id: string; block_name: string; code: string; name: string; work_start: string; work_end: string; work_days: number[]; specialties: string[];
  emergency_only: boolean; notes: string | null; is_active: boolean; sort_order: number }
export interface Ref { code: string; name: string; is_active: boolean; sort_order: number }
export interface TeamRole extends Ref { grp: 'surgical' | 'anesthesia' | 'nursing'; capability: string; multiple: boolean; is_system: boolean }
export interface ReadinessItem { id: string; label: string; source: string; applies: string; is_active: boolean; sort_order: number }
export interface WhoItem { id: string; phase: 'sign_in' | 'time_out' | 'sign_out'; label: string; is_active: boolean; sort_order: number }
export interface Setup {
  blocks: { id: string; name: string; code: string; is_active: boolean; stock_location_id: string | null; stock_location_name: string | null }[];
  rooms: Room[]; specialties: Ref[]; team_roles: TeamRole[]; cancel_reasons: Ref[]; readiness_items: ReadinessItem[]; who_items: WhoItem[];
  locations: { id: string; code: string; name: string; kind: string; department_id: string | null }[];
}
export const useOrSetup = (all = false) => useQuery({ queryKey: ['or-setup', all], queryFn: () => api<Setup>('/or/setup', { query: { all } }), staleTime: 60_000 });

export interface Procedure { id: string; code: string; ncsp_code: string | null; name: string; specialty_code: string | null; specialty_name: string | null; default_duration_min: number;
  laterality: boolean; tariff_id: string | null; tariff_code: string | null; tariff_title: string | null; tariff_price: string | null; is_active: boolean }

export interface CaseRow {
  id: string; case_no: string; status: string; urgency: string; patient_id: string; encounter_id: string | null; planned_id: string | null; department_id: string; surgeon_id: string;
  room_id: string | null; block_id: string | null; scheduled_start: string | null; scheduled_end: string | null; duration_min: number; anesthesia_type: string;
  preferred_date: string | null; preferred_time: string | null; requested_at: string; needs_blood: boolean; needs_implant: boolean; needs_icu: boolean; icd10_code: string | null;
  icd10_title: string | null; postpone_count: number; first_name: string; last_name: string; gender: string; age: number; department_name: string; room_code: string | null;
  room_name: string | null; surgeon_name: string; procedures: string | null; anesthesiologist_name: string | null; phase: string | null; actual_start: string | null; actual_end: string | null;
  who_done: string[]; readiness?: { ready: boolean; missing: number } | null; my_roles?: string[];
}
export interface TeamMember { id: string; role_code: string; role_name: string; grp: string; user_id: string; name: string; added_at: string; in_at: string | null; out_at: string | null;
  replaced_by: string | null; removed_at: string | null; remove_reason: string | null; added_by_name: string | null }
export interface CaseTime { id: string; kind: TimeKind; at: string; destination: string | null; created_at: string; correction_reason: string | null; superseded_by: string | null; by_name: string }
export interface WhoCheck { id: string; phase: string; answers: { item_id: string; label: string; answer: string }[]; note: string | null; done_at: string; voided_at: string | null;
  void_reason: string | null; by_name: string }
export interface Preop {
  id: string; status: 'draft' | 'signed'; asa_class: number | null; asa_emergency: boolean; mallampati: number | null; weight_kg: string | null; height_cm: string | null;
  fasting_solids_at: string | null; fasting_liquids_at: string | null; allergies: { substance: string; severity: string }[]; airway_notes: string | null; comorbidities: string | null;
  risks: string[]; risk_notes: string | null; planned_anesthesia: string | null; plan_notes: string | null; created_by_name: string; signed_by_name: string | null; signed_at: string | null;
  created_at: string; voided_at: string | null; void_reason: string | null;
}
export interface Readiness { items: { id: string; label: string; source: string; applies: string; answer: 'yes' | 'no' | 'na' | 'pending'; auto: boolean; note: string | null;
  checked_by_name: string | null; checked_at: string | null }[]; ready: boolean; missing: string[] }
export interface CaseDetail extends Omit<CaseRow, 'procedures' | 'readiness'> {
  requested_by: string; requested_by_name: string; preferred_anesthesiologist_id: string | null; preferred_anesthesiologist_name: string | null; needs_equipment: string | null;
  blood_note: string | null; notes: string | null; scheduled_by_name: string | null; scheduled_at: string | null; schedule_warnings: string[] | null; readiness_override: string | null;
  cancel_reason_code: string | null; cancel_reason_name: string | null; cancel_note: string | null; cancelled_at: string | null; locked_at: string | null;
  personal_number: string; birth_date: string; block_name: string | null; adm_no: string | null; stay_status: string | null; plan_no: string | null; planned_date: string | null;
  procedures: { id: string; procedure_id: string; side: string; is_primary: boolean; note: string | null; code: string; name: string; ncsp_code: string | null; specialty_code: string | null;
    laterality: boolean; default_duration_min: number }[];
  team: TeamMember[]; times: CaseTime[]; who: WhoCheck[]; who_items: { id: string; phase: string; label: string }[]; preop: Preop[];
  events: { id: string; kind: string; data: Record<string, unknown>; at: string; user_name: string | null }[];
  readiness: Readiness; allergies: { substance: string; severity: string; allergy_type: string }[]; warnings: string[]; settings: OrSettings;
  can: { edit: boolean; schedule: boolean; confirm: boolean; cancel: boolean; surgeon: boolean; team_surgical: boolean; team_anesthesia: boolean; preop: boolean; readiness: boolean; periop: boolean };
}
export interface Board { date: string; days: number; rooms: (Room & { block_name: string })[]; cases: CaseRow[]; queue: CaseRow[]; now: string }

export const chip = (m: Record<string, [string, string]>, k: string | null | undefined) => (k ? <span className={`chip ${m[k]?.[0] ?? ''}`}>{m[k]?.[1] ?? k}</span> : null);
export const dt = (iso: string | null | undefined) => (iso ? `${tsDate(iso)} ${hhmm(iso)}` : '—');
export const hm = (t: string) => t.slice(0, 5);
export const caseLink = (id: string) => `/or/case/${id}`;
