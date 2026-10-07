import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';

/** სტაციონარი (0040) — საერთო ტიპები და ცნობარები */
export interface InpatientSettings {
  bed_assign_mode: 'two_step' | 'direct'; cleaning_required: boolean; sex_rule: 'block' | 'warn' | 'off'; overflow_beds: boolean;
  planned_queue: boolean; planned_sms: boolean; cancel_hours: number;
  wristband: boolean; wristband_print: 'zpl' | 'pdf'; wristband_width_mm: number; wristband_length_mm: number; wristband_offset_mm: number;
  transfer_wait_hours: number; epicrisis_cosign: boolean; discharge_cancel_hours: number; leave_counts_bed_day: boolean; leave_max_hours: number; docs_pending_alert_hours: number;
  med_verification: 'all' | 'high_risk' | 'off'; dose_rule: 'warn' | 'block'; interaction_rule: 'warn' | 'block'; antibiotic_default_days: number; verbal_orders: boolean; verbal_confirm_hours: number; weight_max_age_days: number;
  mar_window_min: number; mar_missed_hours: number; mar_horizon_hours: number; mar_stock_deduct: boolean; mar_allow_no_stock: boolean; mar_double_check: boolean; mar_barcode: 'off' | 'optional' | 'required';
}
export interface BedType { code: string; name: string; is_active: boolean; sort_order: number }
export interface Bed { id: string; ward_id: string; code: string; type_code: string; type_name: string; is_overflow: boolean; status: BedStatus; status_reason: string | null; status_at: string; is_active: boolean; sort_order: number }
export interface Ward { id: string; department_id: string; code: string; name: string | null; floor: string | null; sex: 'male' | 'female' | 'mixed'; isolation_capable: boolean; is_active: boolean; sort_order: number; beds: Bed[] }
export interface Structure { settings: InpatientSettings; types: BedType[]; departments: { id: string; name: string; code: string; wards: Ward[] }[] }
export type BedStatus = 'free' | 'reserved' | 'occupied' | 'cleaning' | 'blocked';
export interface Occupant {
  bed_id: string | null; encounter_id: string; started_at: string; adm_no: string; severity: string | null; isolation: string | null; admitted_at: string; patient_id: string;
  first_name: string; last_name: string; birth_date: string; gender: string; attending_doctor_id: string | null; doctor_name: string | null; day: number; diagnosis: string | null; allergies: number; consent: boolean;
  consents_missing: string[]; transfer_to: string | null; on_leave_until: string | null;
}
export interface IncomingTransfer { id: string; encounter_id: string; reason: string; requested_at: string; adm_no: string; severity: string | null; isolation: string | null; first_name: string; last_name: string; gender: string; from_department: string }
export interface BoardBed extends Bed { occupant: Occupant | null; reservation: { id: string; plan_no: string; planned_date: string; patient_name: string } | null }
export interface Board { department: { id: string; name: string }; settings: InpatientSettings; can_assign: boolean; can_manage: boolean; wards: (Omit<Ward, 'beds'> & { beds: BoardBed[] })[]; awaiting: Occupant[]; incoming_transfers: IncomingTransfer[] }
export interface CensusRow { id: string; name: string; beds: number; overflow: number; free: number; occupied: number; occupied_overflow: number; reserved: number; cleaning: number; blocked: number; awaiting: number; planned_today: number }
export interface StayListItem {
  encounter_id: string; adm_no: string; status: string; source: string; severity: string | null; isolation: string | null; admitted_at: string; ended_at: string | null; patient_id: string;
  first_name: string; last_name: string; personal_number: string | null; birth_date: string; gender: string; department_id: string; department_name: string; bed_code: string | null; doctor_name: string | null;
}
export interface Planned {
  id: string; plan_no: string; patient_id: string; department_id: string; doctor_id: string | null; planned_date: string; icd10_code: string | null; icd10_title: string | null; reason: string; notes: string | null;
  bed_id: string | null; status: string; encounter_id: string | null; sms_sent_at: string | null; cancel_reason: string | null; created_at: string;
  first_name: string; last_name: string; personal_number: string | null; birth_date: string; gender: string; phone_number: string; department_name: string; bed_code: string | null; adm_no: string | null;
  doctor_name: string | null; created_by_name: string; overdue: boolean;
}
export interface Printer { id: string; name: string; kind: 'wristband' | 'label'; host: string; port: number; dpi: number; department_id: string | null; department_name: string | null; is_active: boolean }

export const BED_ST: Record<BedStatus, [string, string]> = { free: ['ok', 'თავისუფალი'], reserved: ['info', 'დაჯავშნილი'], occupied: ['', 'დაკავებული'], cleaning: ['warn', 'დასალაგებელი'], blocked: ['danger', 'დაბლოკილი'] };
export const SEVERITY_KA: Record<string, [string, string]> = { stable: ['ok', 'სტაბილური'], moderate: ['info', 'საშუალო'], severe: ['warn', 'მძიმე'], critical: ['danger', 'კრიტიკული'] };
export const ISOLATION_KA: Record<string, string> = { contact: 'კონტაქტური', droplet: 'წვეთოვანი', airborne: 'საჰაერო', protective: 'დამცავი' };
export const SOURCE_KA: Record<string, string> = { emergency: 'სასწრაფო', outpatient: 'ამბულატორია', planned: 'გეგმიური', transfer_in: 'სხვა კლინიკიდან', direct: 'პირდაპირ' };
export const SEX_KA: Record<string, string> = { male: 'მამაკაცის', female: 'ქალის', mixed: 'შერეული' };
export const STAY_ST: Record<string, [string, string]> = { active: ['ok', 'სტაციონარში'], discharged: ['', 'გაწერილი'], cancelled: ['', 'გაუქმებული'] };
export const DISCHARGE_KA: Record<string, string> = { home: 'ბინაზე', other_clinic: 'სხვა კლინიკაში', against_advice: 'თვითნებურად', death: 'გარდაცვალება' };
export const TRANSPORT_KA: Record<string, string> = { own: 'საკუთარი', ambulance: 'სასწრაფო', clinic_transport: 'კლინიკის ტრანსპორტი', other: 'სხვა' };
/** ბარათის მცირე ჩიპები: გადაყვანა, დროებითი გასვლა, თანხმობა */
export const occupantChips = (o: Occupant) => <>
  {o.transfer_to && <span className="chip info" title="გადაყვანის მოთხოვნა — მიმღების დადასტურებას ელოდება">→ {o.transfer_to}</span>}
  {o.on_leave_until && <span className="chip warn" title="დროებით გასულია">გასულია {o.on_leave_until}-მდე</span>}
  {!o.consent && <span className="chip" title={`აკლია: ${(o.consents_missing ?? []).join(', ')}`}>თანხმობა —</span>}
</>;

export const useStructure = (all = false) => useQuery({ queryKey: ['ipd-structure', all], queryFn: () => api<Structure>('/inpatient/structure', { query: { all } }) });
export const useCensus = () => useQuery({ queryKey: ['ipd-census'], queryFn: () => api<{ settings: InpatientSettings; departments: CensusRow[]; my_department_id: string | null }>('/inpatient/census'), refetchInterval: 60_000 });

/** 409 CONFIRM_REQUIRED (სქესი / იზოლაცია) — მომხმარებელი ადასტურებს და მოთხოვნა მეორდება confirm:true-ით */
export async function withConfirm<T>(fn: (confirm: boolean) => Promise<T>): Promise<T | null> {
  try { return await fn(false); } catch (e) {
    if (e instanceof ApiError && e.code === 'CONFIRM_REQUIRED') {
      const w = (e.body?.warnings as string[] | undefined) ?? [e.message];
      if (!window.confirm(`გაფრთხილება:\n\n${w.join('\n')}\n\nგააგრძელებთ?`)) return null;
      return fn(true);
    }
    throw e;
  }
}
export const chipOf = (m: Record<string, [string, string]>, k: string | null | undefined) => (k ? <span className={`chip ${m[k]?.[0] ?? ''}`}>{m[k]?.[1] ?? k}</span> : null);
