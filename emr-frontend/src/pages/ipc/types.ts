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
