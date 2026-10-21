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
  antibiotic_start: 'ანტიბიოტიკის დაწყება', cluster: 'კლასტერი' };
export const SIGNAL_ST: Record<string, [string, string]> = { open: ['danger', 'ღია'], watch: ['warn', 'დაკვირვება'], dismissed: ['', 'უარყოფილი'], case: ['info', 'შემთხვევა'] };
export const HAI_ST: Record<string, [string, string]> = { suspected: ['warn', 'ეჭვი'], review: ['info', 'განხილვაში'], confirmed: ['danger', 'დადასტურებული'], rejected: ['', 'უარყოფილი'] };
export const ATTR_KA: Record<string, string> = { current: 'განყოფილება ინფექციის დღეს', transfer: 'წინა განყოფილება (გადაყვანიდან < N დღე)', readmission: 'წინა ჰოსპიტალიზაცია (ხელახალი)', manual: 'ხელით' };
export const SSI_KA: Record<string, string> = { superficial: 'ზედაპირული', deep: 'ღრმა', organ: 'ორგანო / სივრცე' };
export const BSI_SRC_KA: Record<string, string> = { catheter: 'კათეტერი (CRI)', secondary: 'მეორადი (სხვა ადგილიდან)', unknown: 'უცნობი' };
export const OUTCOME_KA: Record<string, string> = { ongoing: 'მიმდინარე', recovered: 'გამოჯანმრთელდა', transferred: 'გადაიყვანეს', died: 'გარდაიცვალა' };
export const CONTRIB_KA: Record<string, string> = { yes: 'კი', no: 'არა', unknown: 'უცნობია' };
export const DEVICE_KA: Record<string, string> = { central_line: 'ცენტრალური ხაზი', urinary: 'შარდის კათეტერი', ventilator: 'ინვაზიური ვენტილაცია' };
/** სიგნალიდან შემთხვევის ტიპის შეთავაზება */
export const typeForSignal = (kind: string, specimen?: string | null) => kind === 'blood_culture' ? 'bsi'
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
}
export interface HaiRow {
  id: string; case_no: string; patient_id: string; hai_type: string; short_name: string; device_name: string | null; ssi_depth: string | null; status: string; status_ka: string;
  onset_date: string; onset_day: number | null; department_id: string | null; department: string | null; attribution: string; readmission: boolean; device_assoc: boolean;
  device_days: number | null; first_name: string; last_name: string; personal_number: string | null; adm_no: string | null; organisms: string[];
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
