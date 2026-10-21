import { useQuery } from '@tanstack/react-query';
import { api, type Role } from '../../api/client';

/** ინფექციის კონტროლი (0067) */
export const IPC_FULL: Role[] = ['infection'];
export const IPC_ANY: Role[] = ['infection', 'infection_dept'];

export const ISO_TYPES = ['contact', 'contact_plus', 'droplet', 'airborne', 'protective'] as const;
export const ISO_KA: Record<string, string> = { contact: 'კონტაქტური', contact_plus: 'გაძლიერებული კონტაქტური', droplet: 'წვეთოვანი', airborne: 'საჰაერო', protective: 'დამცავი' };
export const REASON_KA: Record<string, string> = { mdro: 'MDRO (ფლაგი)', suspected: 'ინფექციაზე ეჭვი', confirmed: 'დადასტურებული ინფექცია', screening: 'სკრინინგის პასუხის მოლოდინი',
  immunosuppressed: 'იმუნოსუპრესია', other: 'სხვა' };
export const ONSET_KA: Record<string, string> = { community: 'საზოგადოებრივი / შემოტანილი', hospital: 'ჰოსპიტალური', unknown: 'უცნობი' };
export const SOURCE_KA: Record<string, string> = { micro: 'მიკრობიოლოგია (ავტომატურად)', manual: 'ხელით', external: 'გარე ლაბორატორია' };
export const FLAG_ST: Record<string, [string, string]> = { suggested: ['warn', 'დასადასტურებელი'], active: ['danger', 'აქტიური'], cleared: ['ok', 'მოხსნილი'], dismissed: ['', 'გაუქმებული'] };
export const MARKER_KA: Record<string, string> = { esbl: 'ESBL', carbapenemase: 'კარბაპენემაზა', ampc: 'AmpC', mlsb: 'MLSb (ინდუცირებადი)', pbp2a: 'PBP2a / mecA', van: 'vanA / vanB' };

export interface IsoType { code: string; name: string; short_name: string; color: string; ppe: string; door_text: string; priority: number; sort_order: number }
export interface MdroType { code: string; name: string; isolation_type: string; urgent: boolean; expiry_days: number | null; is_active: boolean; sort_order: number; active_flags: number }
export interface MdroRule { id: string; mdro_code: string; organism_codes: string[]; group_codes: string[]; abx_codes: string[]; marker: string | null; note: string | null; is_active: boolean }
export interface IpcCatalog {
  isolation_types: IsoType[]; mdro_types: MdroType[]; rules: MdroRule[]; markers: string[];
  organisms: { code: string; name: string; group_code: string }[]; groups: string[]; antibiotics: { code: string; name: string; class: string | null }[];
}
export const useIpcCatalog = (enabled = true) => useQuery({ queryKey: ['ipc-catalog'], queryFn: () => api<IpcCatalog>('/ipc/catalog'), staleTime: 5 * 60_000, enabled });

export interface IsolationRow { id: string; type: string; name: string; short_name: string; color: string; reason: string; reason_text: string | null; flag_id: string | null; mdro_code?: string | null;
  started_at: string; ended_at?: string | null; end_reason?: string | null; auto_ended?: boolean; started_by_name?: string | null; ended_by_name?: string | null; days?: number }
export interface StayIsolations { encounter_id: string; status: string; active: IsolationRow[]; history: IsolationRow[]; can: { edit: boolean; end_mdro: boolean }; door_sign: boolean; module: boolean; warnings?: string[] }
export interface PatientFlag { id: string; mdro_code: string; name: string; isolation_type: string; urgent: boolean; status: string; onset: string | null; source: string; detected_at: string; specimen_at: string | null; reviewed_at: string | null }
export interface PatientIpcStatus {
  enabled: boolean; flags: PatientFlag[]; stay: { encounter_id: string; adm_no: string } | null; isolations: IsolationRow[];
  suggestions: { flag_id: string; mdro_code: string; isolation_type: string }[];
}
export const usePatientIpc = (patientId: string | undefined | null) => useQuery({
  queryKey: ['ipc-status', patientId], queryFn: () => api<PatientIpcStatus>(`/ipc/patients/${patientId}/status`), enabled: !!patientId, retry: false, staleTime: 30_000,
});

export interface FlagRow {
  id: string; patient_id: string; mdro_code: string; mdro_name: string; isolation_type: string; status: string; source: string; onset: string | null; detected_at: string;
  specimen_at: string | null; reviewed_at: string | null; cleared_at: string | null; clear_reason: string | null; expires_at: string | null;
  first_name: string; last_name: string; personal_number: string | null; birth_date: string; stay_id: string | null; adm_no: string | null; department_id: string | null;
  department: string | null; bed_code: string | null; detections: number; isolated: boolean;
}
export interface IpcPatientRow {
  encounter_id: string; adm_no: string; admitted_at: string; patient_id: string; first_name: string; last_name: string; birth_date: string; gender: string; personal_number: string | null;
  department_id: string; department: string; bed_code: string | null; ward_code: string | null; isolation_capable: boolean | null; day: number;
  isolations: { id: string; type: string; reason: string; started_at: string; flag_id: string | null }[];
  flags: { id: string; mdro_code: string; status: string; isolation_type: string; onset: string | null; reviewed: boolean }[];
  ward_others: number; missing_isolation: string[]; shared_ward: boolean;
}
export interface FlagDetail extends Omit<FlagRow, 'stay_id' | 'adm_no' | 'department_id' | 'department' | 'bed_code' | 'detections' | 'isolated'> {
  urgent: boolean; gender: string; organism: string | null; note: string | null; created_by_name: string | null; reviewed_by_name: string | null; cleared_by_name: string | null;
  clear_negatives: number | null; onset_ka: string | null; clear_negatives_required: number;
  stay: { encounter_id: string; adm_no: string; department: string | null; bed_code: string | null } | null;
  detections: { id: number; order_item_id: string; specimen_at: string | null; detected_at: string; service: string; specimen_type: string | null; organism: string | null; rule: string | null }[];
  isolations: { id: string; type: string; reason: string; started_at: string; ended_at: string | null; end_reason: string | null; adm_no: string; encounter_id: string }[];
  history: { id: string; mdro_code: string; mdro_name: string; status: string; detected_at: string; cleared_at: string | null }[];
  can: { manage: boolean };
  isolations_ended?: number;
}
export const mdroShort = (code: string) => code.toUpperCase();

// ================================================================ 0068: სიგნალები, HAI, device-days
export const SIGNAL_KA: Record<string, string> = { blood_culture: 'ჰემოკულტურა', hospital_culture: 'ჰოსპიტალური კულტურა', fever_device: 'ცხელება (მოწყობილობა / ოპერაცია)',
  antibiotic_start: 'ანტიბიოტიკის დაწყება', cluster: 'კლასტერი', ssi_postop: 'SSI ეჭვი (ოპერაციის შემდეგ)' };
export const SIGNAL_ST: Record<string, [string, string]> = { open: ['danger', 'ღია'], watch: ['warn', 'დაკვირვება'], dismissed: ['', 'უარყოფილი'], case: ['info', 'შემთხვევა'] };
export const HAI_ST: Record<string, [string, string]> = { suspected: ['warn', 'ეჭვი'], review: ['info', 'განხილვაში'], confirmed: ['danger', 'დადასტურებული'], rejected: ['', 'უარყოფილი'] };
export const ATTR_KA: Record<string, string> = { current: 'განყოფილება ინფექციის დღეს', transfer: 'წინა განყოფილება (გადაყვანიდან < N დღე)', readmission: 'წინა ჰოსპიტალიზაცია (ხელახალი)', manual: 'ხელით',
  operation: 'ოპერაციის განყოფილება (SSI)' };
export const SSI_KA: Record<string, string> = { superficial: 'ზედაპირული', deep: 'ღრმა', organ: 'ორგანო / სივრცე' };
export const BSI_SRC_KA: Record<string, string> = { catheter: 'კათეტერი (CRI)', secondary: 'მეორადი (სხვა ადგილიდან)', unknown: 'უცნობი' };
export const OUTCOME_KA: Record<string, string> = { ongoing: 'მიმდინარე', recovered: 'გამოჯანმრთელდა', transferred: 'გადაიყვანეს', died: 'გარდაიცვალა' };
export const CONTRIB_KA: Record<string, string> = { yes: 'კი', no: 'არა', unknown: 'უცნობია' };
export const DEVICE_KA: Record<string, string> = { central_line: 'ცენტრალური ხაზი', urinary: 'შარდის კათეტერი', ventilator: 'ინვაზიური ვენტილაცია' };
/** სიგნალიდან შემთხვევის ტიპის შეთავაზება */
export const typeForSignal = (kind: string, specimen?: string | null) => kind === 'ssi_postop' ? 'ssi' : kind === 'blood_culture' ? 'bsi'
  : kind === 'hospital_culture' ? (specimen === 'urine' ? 'uti' : specimen && ['sputum', 'bal'].includes(specimen) ? 'pn' : specimen === 'wound' ? 'ssi' : specimen === 'stool' ? 'cdi' : 'other') : 'other';

export interface SignalRow {
  id: string; kind: string; kind_ka: string; patient_id: string | null; encounter_id: string | null; department_id: string | null; department: string | null; summary: string;
  data: Record<string, unknown>; event_at: string; detected_at: string; status: string; watch_until: string | null; dismiss_reason: string | null; case_id: string | null; case_no: string | null;
  first_name: string | null; last_name: string | null; personal_number: string | null; adm_no: string | null; handled_by_name: string | null;
}
export interface HaiType { code: string; name: string; short_name: string; device_kind: string | null; device_name: string | null; is_active: boolean; sort_order: number }
export interface HaiCatalog { types: HaiType[]; sets: { id: string; code: string; version: string; name: string; note: string | null; is_active: boolean; active_for_clinic: boolean }[];
  items: { id: string; set_id: string; hai_type: string; grp: string | null; text: string; required: boolean; sort_order: number; is_active: boolean }[] }
export const useHaiCatalog = (enabled = true) => useQuery({ queryKey: ['ipc-hai-catalog'], queryFn: () => api<HaiCatalog>('/ipc/hai-catalog'), staleTime: 5 * 60_000, enabled });
export interface HaiContext {
  encounter_id: string | null; adm_no: string | null; admitted_at: string | null; onset_day: number | null; department_id: string | null; department: string | null;
  attribution: string; readmission: boolean; previous_adm_no: string | null; device_kind: string | null; device_name: string | null; device_days: number | null; device_assoc: boolean;
  device_detail: string | null; warnings: { code: string; message: string }[];
  or_case_id: string | null; or_case_no: string | null; op_date: string | null; pod: number | null; followup_until: string | null; post_discharge: boolean;
}
export interface HaiRow {
  id: string; case_no: string; patient_id: string; hai_type: string; short_name: string; device_name: string | null; ssi_depth: string | null; status: string; status_ka: string;
  onset_date: string; onset_day: number | null; department_id: string | null; department: string | null; attribution: string; readmission: boolean; device_assoc: boolean;
  device_days: number | null; first_name: string; last_name: string; personal_number: string | null; adm_no: string | null; organisms: string[];
  or_case_id: string | null; or_case_no: string | null; post_discharge: boolean;
}
export interface HaiDetail extends Omit<HaiRow, 'organisms'> {
  type_name: string; encounter_id: string | null; ssi_depth: string | null; device_kind: string | null; device_override: boolean; device_note: string | null; attribution_note: string | null;
  criteria_set_id: string | null; criteria_met: string[]; organism_ids: string[]; order_item_ids: string[]; bsi_source: string | null; description: string | null; outcome: string | null;
  hai_contributed: string | null; birth_date: string; gender: string; admitted_at: string | null; stay_status: string | null; criteria_set: string | null; criteria_version: string | null;
  created_by_name: string | null; confirmed_by_name: string | null; confirmed_at: string | null; rejected_reason: string | null; created_at: string;
  criteria: { id: string; grp: string | null; text: string; required: boolean }[]; organisms: { id: string; name: string; code: string }[];
  signals: { id: string; kind: string; summary: string; event_at: string }[];
  events: { id: number; at: string; kind: string; text: string | null; data: Record<string, unknown> | null; user_name: string | null }[];
  cultures: { id: string; service: string; specimen_type: string | null; collected_at: string; organisms: { id: string; name: string }[] }[];
  incidents: { inc_no: string; status: string; reported_at: string }[];
  context: HaiContext | null; can: { edit: boolean; decide: boolean; quality: boolean };
}
export interface RateRow { department_id: string; department: string; patient_days: number; cl: number; uc: number; vent: number; hai: number; clabsi: number; cauti: number; vap: number;
  dur_cl: number | null; dur_uc: number | null; dur_vent: number | null; clabsi_rate: number | null; cauti_rate: number | null; vap_rate: number | null; hai_rate: number | null }
export interface Rates { from: string; to: string; basis: string; central_line_kinds: string[]; computed_at: string | null; rows: RateRow[]; total: Omit<RateRow, 'department_id' | 'department'> }

// ================================================================ 0069: SSI
export const WOUND_KA: Record<number, string> = { 1: 'I — სუფთა', 2: 'II — პირობით სუფთა', 3: 'III — დაბინძურებული', 4: 'IV — ჩირქოვანი' };
export const PROPH_KA: Record<string, [string, string]> = { timely: ['ok', 'დროულად'], early: ['warn', 'ადრე'], late: ['danger', 'განაკვეთის შემდეგ'], none: ['danger', 'არ ჩატარებულა'],
  unknown: ['', 'უცნობი'] };
export const SSI_OP_ST: Record<string, [string, string]> = { active: ['info', 'დაკვირვებაში'], completed: ['ok', 'დასრულებული'], ssi: ['danger', 'SSI'], excluded: ['', 'გამორიცხული'] };
export const FU_ST: Record<string, [string, string]> = { pending: ['warn', 'მოსალოდნელი'], done: ['ok', 'შესრულებული'], unreachable: ['', 'ვერ დავუკავშირდით'], cancelled: ['', 'გაუქმებული'] };
export const FU_Q: [string, string][] = [['redness', 'სიწითლე / შეშუპება ჭრილობის ირგვლივ'], ['discharge', 'გამონადენი ჭრილობიდან'], ['dehiscence', 'ჭრილობა გაიხსნა'],
  ['fever', 'ცხელება (≥ 38 °C)'], ['antibiotics', 'ჭრილობის გამო ანტიბიოტიკი'], ['doctor_visit', 'ჭრილობის გამო ექიმთან ვიზიტი'], ['reoperation', 'განმეორებითი ოპერაცია']];
export interface SsiOp {
  case_id: string; case_no: string; patient_id: string; first_name: string; last_name: string; personal_number: string | null; phone_number: string | null; encounter_id: string | null;
  department_id: string; department: string; category: string; category_name: string; category_manual: boolean; op_at: string; op_date: string; duration_min: number | null;
  t_point_min: number | null; asa: number | null; emergency: boolean; wound_class: number | null; wound_class_ipc: number | null; wound_class_note: string | null; implant: boolean;
  risk_index: number | null; prophylaxis: string; prophylaxis_at: string | null; prophylaxis_drug: string | null; followup_days: number; followup_until: string; discharged_at: string | null;
  status: string; excluded_reason: string | null; ssi_case_id: string | null; ssi_case_no: string | null; ssi_depth: string | null; followup_id: string | null; followup_status: string | null;
  followup_due: string | null; procedures: string | null; open_cases: number;
}
export interface SsiOpDetail extends SsiOp {
  hai_cases: { id: string; case_no: string; status: string; onset_date: string; ssi_depth: string | null; post_discharge: boolean }[];
  followup: null | { id: string; status: string; due_date: string; attempts: number; outcome: string | null; answers: Record<string, boolean | null>; note: string | null;
    contacted_by_name: string | null; contacted_at: string | null; cancel_reason: string | null; sms_sent_at: string | null; hai_case_id: string | null };
  can: { edit: boolean };
}
export interface SsiFollowup {
  id: string; case_id: string; case_no: string; due_date: string; status: string; attempts: number; last_attempt_at: string | null; outcome: string | null; answers: Record<string, boolean | null>;
  note: string | null; contacted_at: string | null; cancel_reason: string | null; sms_sent_at: string | null; hai_case_id: string | null; hai_case_no: string | null; patient_id: string;
  first_name: string; last_name: string; personal_number: string | null; phone_number: string | null; category: string; category_name: string; op_date: string; followup_days: number;
  discharged_at: string | null; department: string; contacted_by_name: string | null;
}
export interface SsiCategory { code: string; name: string; followup_days: number; implant_followup_days: number | null; t_point_min: number | null; ncsp_prefixes: string[]; is_active: boolean; sort_order: number }
export interface SsiCatalog { categories: SsiCategory[]; procedures: { id: string; code: string; ncsp_code: string | null; name: string; ssi_category: string | null; specialty: string | null; suggested: string | null }[] }
export const useSsiCatalog = (enabled = true) => useQuery({ queryKey: ['ipc-ssi-catalog'], queryFn: () => api<SsiCatalog>('/ipc/ssi/catalog'), staleTime: 5 * 60_000, enabled });
export interface SsiRateRow { category?: string; name?: string; ops: number; active: number; ssi: number; superficial: number; deep: number; organ: number; post_discharge: number;
  r0: number; r1: number; r2: number; r3: number; rn: number; s0: number; s1: number; s2: number; s3: number; sn: number; ph_known: number; ph_timely: number; fu_due: number; fu_done: number;
  rate: number | null; ph_timely_pct: number | null; post_discharge_pct: number | null }
export interface SsiRates { from: string; to: string; rows: SsiRateRow[]; total: SsiRateRow }
export interface PatientOp { id: string; case_no: string; department: string; category: string | null; followup_until: string | null; ssi_status: string | null; op_at: string | null; procedures: string | null }
