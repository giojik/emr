// API-ს პასუხების ტიპები (backend-ის Kysely select-ების შესაბამისი). NUMERIC → string, DATE → 'YYYY-MM-DD'.
export type Gender = 'male' | 'female' | 'other';
export type Severity = 'mild' | 'moderate' | 'severe';

export interface Department { id: string; name: string; code: string; type: string; is_active: boolean; active_users?: string }
export interface Doctor {
  id: string; first_name: string; last_name: string; specialty: string | null;
  department_id: string | null; department_name: string | null; consultation_price: string | null;
}
export interface PatientListItem {
  id: string; personal_number: string | null; passport_number: string | null; first_name: string; last_name: string;
  birth_date: string; gender: Gender; phone_number: string;
}
export interface Allergy {
  id: string; substance: string; reaction_type: string | null; severity: Severity; allergy_type: 'allergy' | 'intolerance';
  is_active?: boolean; created_at?: string;
}
export interface Patient extends PatientListItem {
  citizenship: string; blood_group: string | null; address: string | null;
  address_unit_code: string | null; address_district_code: string | null; address_village: string | null; address_line: string | null; address_country: string | null;
  emergency_contact_name: string | null; emergency_contact_phone: string | null; is_deceased: boolean;
  allergies: Allergy[]; chronic_conditions: { id: string; icd10_code: string | null; condition_name: string }[];
}
export type AppointmentStatus = 'scheduled' | 'confirmed' | 'checked_in' | 'completed' | 'cancelled' | 'no_show';
export interface Appointment {
  id: string; status: AppointmentStatus; scheduled_start: string; scheduled_end: string; reason: string | null;
  encounter_id: string | null; department_id: string; patient_id: string; patient_first_name: string; patient_last_name: string;
  personal_number: string | null; phone_number: string; doctor_id: string; doctor_name: string;
}
export type EncounterStatus = 'planned' | 'active' | 'discharged' | 'cancelled';
export interface EncounterListItem {
  id: string; status: EncounterStatus; visit_kind?: 'consultation' | 'lab'; external_referral?: string | null; type: string; start_time: string; end_time: string | null; chief_complaint: string | null;
  department_id: string; patient_id: string; patient_first_name: string; patient_last_name: string; personal_number: string | null;
  attending_doctor_id: string | null; doctor_name: string | null; invoice_id: string | null; invoice_number: string | null;
  total_amount: string | null; patient_share: string | null; paid_status: string | null; paid_amount: string; primary_diagnosis: string | null;
}
export interface Vitals {
  id: string; systolic_bp: number | null; diastolic_bp: number | null; heart_rate: number | null; respiratory_rate: number | null;
  temperature: string | null; spo2: number | null; weight_kg: string | null; height_cm: string | null; bmi: string | null; recorded_at: string;
}
export interface Diagnosis { id: string; icd10_code: string; icd10_title: string; diagnosis_type: 'primary' | 'secondary' | 'complication' | 'admission'; comment: string | null }
export interface Prescription {
  id: string; medication_name: string; dosage: string; route: string; frequency: string; duration_days: number | null; instructions: string | null;
  allergy_alert_level: AlertLevel; allergy_override_reason: string | null;
}
export interface Referral {
  id: string; type: 'lab' | 'imaging' | 'hospitalization' | 'specialist_consult'; status: 'requested' | 'in_progress' | 'completed' | 'cancelled';
  reason: string; result_text: string | null; created_at: string; completed_at: string | null;
}
export interface InvoiceLine { id: string; tariff_id: string | null; description: string; quantity: number; unit_price: string; original_price: string | null; discount_reason: string | null; line_total: string; referral_id: string | null }
export interface Payment { id: string; amount: string; method: string; terminal_ref: string | null; paid_at: string }
export interface Invoice {
  id: string; invoice_number: string; total_amount: string; patient_share: string; insurance_share: string; state_share: string;
  paid_status: 'unpaid' | 'partially_paid' | 'paid'; lines: InvoiceLine[]; payments: Payment[]; paid_amount?: string; balance_due?: string;
}
export interface EncounterDetail {
  id: string; status: EncounterStatus; visit_kind?: 'consultation' | 'lab'; external_referral?: string | null; start_time: string; end_time: string | null; attending_doctor_id: string | null;
  chief_complaint: string | null; history_of_present_illness: string | null; objective_status: string | null;
  patient: Pick<Patient, 'id' | 'first_name' | 'last_name' | 'personal_number' | 'birth_date' | 'gender' | 'phone_number' | 'blood_group' | 'allergies' | 'chronic_conditions'>;
  doctor: { id: string; first_name: string; last_name: string; specialty: string | null } | null;
  vitals: Vitals[]; diagnoses: Diagnosis[]; prescriptions: Prescription[]; referrals: Referral[];
  invoice: Invoice | null; payment_override: { reason: string } | null;
}
export interface IcdCode { code: string; title: string; category: string; chapter_id: number | null; is_asterisk: boolean; is_dagger: boolean; needs_review: boolean }
export type AlertLevel = 'none' | 'info' | 'warning' | 'warning_reason' | 'block';
export interface AllergyCheck {
  level: AlertLevel; requires_ack: boolean; requires_reason: boolean; requires_severe_confirmation: boolean; unreviewed_groups: boolean;
  matches: { allergy_id: string; substance: string; severity: Severity; allergy_type: string; match: 'direct' | 'cross'; group: string | null; level: AlertLevel }[];
}
export interface Form100Draft {
  encounter_status: EncounterStatus; recipient: string; workplace: string | null; conclusion: 'healthy' | 'practically_healthy' | null;
  diagnosis: { primary: { code: string; title: string }[]; secondary: { code: string; title: string }[]; complications: { code: string; title: string }[] };
  past_diseases: string | null; anamnesis: string | null; investigations: string | null; course: string | null; treatment: string | null; recommendations: string | null;
}

// ---------------------------------------------------------------- ადმინისტრირება
export interface AdminUser {
  id: string; email: string; first_name: string; last_name: string; personal_number: string; phone: string | null; role: string;
  department_id: string | null; department_name: string | null; specialty: string | null; license_number: string | null;
  auth_provider: 'local' | 'ldap'; ldap_username: string | null; is_active: boolean; must_change_password: boolean;
  failed_login_count: number; locked_until: string | null; is_locked: boolean; last_login_at: string | null;
  consultation_tariff_id: string | null; consultation_tariff_title: string | null; consultation_price: string | null; is_section_head: boolean;
  roles: { code: string; name: string; is_active: boolean }[]; capabilities: string[] | null;
}
export interface Tariff { id: string; code: string; title: string; base_price: string; is_active: boolean }
export interface ReferralTypeTariff { type: string; tariff_id: string; code: string; title: string; base_price: string }
export interface ClinicSettings { name: string; address: string; phone: string | null; email: string | null; director_name: string; director_title: string; consent_methods?: ('paper' | 'electronic')[] }
export interface AllergenGroup {
  code: string; name: string; needs_review: boolean; reviewed_by: string | null; reviewed_at: string | null;
  terms: { term: string }[]; cross_reactive: { code: string }[];
}
export interface OverrideRow {
  id: string; created_at: string; medication_name: string; dosage: string; allergy_alert_level: AlertLevel; allergy_override_reason: string | null;
  allergy_matches: AllergyCheck['matches'] | null; encounter_id: string; patient_first_name: string; patient_last_name: string;
  personal_number: string | null; doctor_name: string | null;
}
export interface AuditRow {
  id: string; created_at: string; action: string; entity_name: string; entity_id: string; ip_address: string | null;
  user_id: string | null; user_name: string | null; old_data: unknown; new_data: unknown;
}

// ---------------------------------------------------------------- მისამართი, დოკუმენტები, თანხმობები
export interface AddressUnit { code: string; name: string; type: 'city' | 'municipality' | 'district'; parent_code: string | null; region: string }
export interface AddressFieldsValue { address_unit_code: string; address_district_code: string; address_village: string; address_line: string; address_country: string }
export type DocType = 'id_card' | 'passport' | 'birth_certificate' | 'residence_permit' | 'consent_scan' | 'consent_signed' | 'other';
export interface PatientFile {
  id: string; doc_type: DocType; mime_type: string; size_bytes: number; original_name: string | null; note: string | null;
  is_active: boolean; created_at: string; uploaded_by_first: string | null; uploaded_by_last: string | null;
}
export type ConsentStatus = 'granted' | 'refused' | 'revoked' | 'missing';
export interface ConsentRecord {
  id: string; type_code: string; encounter_id: string | null; decision: 'granted' | 'refused'; method: 'paper' | 'electronic';
  signer_type: 'patient' | 'representative'; representative_name: string | null; representative_relation: string | null;
  file_id: string; signed_at: string; revoked_at: string | null; revoke_reason: string | null; version: number; text_approved: boolean; recorded_by_name: string | null;
}
export interface PatientConsent {
  code: string; name: string; scope: 'patient' | 'encounter'; version: number; text_approved: boolean; status: ConsentStatus;
  outdated: boolean; latest: ConsentRecord | null; history: ConsentRecord[];
}
export interface ConsentType {
  code: string; name: string; scope: 'patient' | 'encounter'; is_active: boolean; sort_order: number;
  version_id: string; version: number; body_text: string; text_approved: boolean; version_created_at: string;
}

export interface WorklistItem {
  id: string; type: Referral['type']; status: Referral['status']; reason: string; result_text: string | null; created_at: string; completed_at: string | null;
  encounter_id: string; patient_id: string; patient_first_name: string; patient_last_name: string; personal_number: string | null;
  birth_date: string; gender: Gender; requested_by_name: string | null;
}

// ---------------------------------------------------------------- დიაგნოსტიკა
export type DxSection = 'lab' | 'radiology' | 'endoscopy';
export type DxStatus = 'scheduled' | 'arrived' | 'performed' | 'ordered' | 'collected' | 'in_progress' | 'resulted' | 'validated' | 'cancelled';
export interface DxService {
  id: string; section: DxSection; code: string; name: string; group_name: string; performed_by: 'internal' | 'external'; external_lab: string | null;
  specimen_type: string | null; container: string | null; modality: string | null; body_part: string | null; contrast: string | null;
  is_active: boolean; needs_review: boolean; sort_order: number; base_price: string; tariff_id: string; duration_minutes: number | null; prep_instructions: string | null;
}
export type LabFlag = 'N' | 'L' | 'H' | 'LL' | 'HH' | 'A';
export interface LabResultRow { analyte_id: string; code: string; name: string; value_num: string | null; value_text: string | null; unit: string; ref_low: string | null; ref_high: string | null; ref_text: string | null; flag: LabFlag | null }
export interface DxItem {
  id: string; encounter_id: string; patient_id: string; service_id: string; section: DxSection; status: DxStatus; priority: 'routine' | 'urgent';
  clinical_note: string | null; accession_number: string | null; report_text: string | null; allergy_override_reason: string | null;
  ordered_at: string; resulted_at: string | null; validated_at: string | null; cancel_reason: string | null;
  service_code: string; service_name: string; group_name: string; performed_by: 'internal' | 'external'; external_lab: string | null; modality: string | null; contrast: string | null;
  barcode: string | null; specimen_status: string | null; collected_at: string | null; received_at: string | null;
  first_name: string; last_name: string; personal_number: string | null; birth_date: string; gender: Gender;
  ordered_by_name: string | null; validated_by_name: string | null; results: LabResultRow[];
  device_id: string | null; device_name: string | null; scheduled_start: string | null; scheduled_end: string | null; arrived_at: string | null; performed_at: string | null;
  contrast_agent: string | null; contrast_volume_ml: string | null; dose_text: string | null; tech_note: string | null; collection_issue: string | null; prep_instructions: string | null;
  report_status: 'draft' | 'signed' | null; report_version: number | null; is_critical: boolean | null; amend_reason: string | null; report_updated_at: string | null;
  visit_kind: 'consultation' | 'lab' | null; external_referral: string | null;
  path_request_id: string | null; path_request_no: string | null; path_status: 'draft' | 'sent' | 'resulted' | null; path_result_text: string | null; path_reviewed_at: string | null; path_has_file: boolean;
}
export interface DxDevice {
  id: string; section: 'radiology' | 'endoscopy'; name: string; modalities: string[]; room: string | null; ae_title: string | null;
  slot_minutes: number; work_start: string; work_end: string; is_active: boolean; sort_order: number;
}
export interface RadBoard { date: string; tz: string; devices: DxDevice[]; booked: DxItem[]; unscheduled: DxItem[] }
export interface ReportSections { technique: string | null; findings: string | null; impression: string | null; recommendation: string | null }
export interface DxReport extends ReportSections {
  order_item_id: string; is_critical: boolean; critical_notified_to: string | null; critical_notified_at: string | null; version: number; status: 'draft' | 'signed';
  template_id: string | null; author_name: string | null; signed_by_name: string | null; signed_at: string | null;
  amend_reason: string | null; amended_by_name: string | null; amended_at: string | null; updated_at: string;
}
export interface DxReportVersion extends ReportSections { id: string; version: number; is_critical: boolean; critical_notified_to: string | null; amend_reason: string | null; signed_by_name: string; signed_at: string }
export interface ReportDetail extends DxItem {
  safety: { mr_screening?: boolean; pregnancy?: string; renal?: string; notes?: string } | null; technician_name: string | null;
  report: DxReport | null; versions: DxReportVersion[]; endo: EndoProcedure | null; images: DxImage[]; pathology: PathRequest | null;
  priors: { id: string; service_name: string; modality: string | null; accession_number: string | null; performed_at: string | null; validated_at: string; impression: string | null; findings: string | null; report_text: string | null }[];
}
export interface ReportTemplate extends ReportSections {
  id: string; section: 'radiology' | 'endoscopy'; kind: 'template' | 'phrase'; name: string; modality: string | null; service_id: string | null; service_name: string | null;
  owner_id: string | null; owner_name: string | null; target: 'technique' | 'findings' | 'impression' | 'recommendation' | null; body: string | null; is_active: boolean; sort_order: number;
}
export interface LabAnalyteForm {
  id: string; code: string; name: string; unit: string; result_type: 'numeric' | 'text' | 'select'; decimals: number | null; options: string[] | null;
  critical_low: string | null; critical_high: string | null; range: { low: string | null; high: string | null; normal_text: string | null } | null;
}
export interface LabItemDetail extends DxItem { analytes: LabAnalyteForm[] }
export interface PendingCollection {
  encounter_id: string; patient_id: string; first_name: string; last_name: string; personal_number: string | null; birth_date: string;
  visit_kind: 'consultation' | 'lab'; encounter_status: string; paid_status: 'unpaid' | 'partially_paid' | 'paid' | null;
  tests: number; names: string[]; urgent: boolean; ordered_at: string; collection_issue: string | null;
}
export interface CollectionDetail {
  encounter_id: string; encounter_status: string; visit_kind: 'consultation' | 'lab'; external_referral: string | null; doctor_name: string | null;
  first_name: string; last_name: string; birth_date: string; gender: Gender; personal_number: string | null; passport_number: string | null;
  paid_status: 'unpaid' | 'partially_paid' | 'paid' | null;
  items: { id: string; priority: 'routine' | 'urgent'; clinical_note: string | null; collection_issue: string | null; name: string; code: string; specimen_type: string | null; container: string | null; performed_by: string; external_lab: string | null }[];
  tubes: { specimen_type: string; container: string | null; external: boolean; tests: string[] }[];
}
export interface CollectedSpecimen { id: string; barcode: string; specimen_type: string; container: string | null; tests: string[]; external: boolean }

export interface DxImage { id: string; source: 'upload' | 'capture'; caption: string | null; in_report: boolean; sort_order: number; mime_type: string; created_at: string }
export interface EndoIntervention { type: string; site?: string; details?: string }
export interface EndoProcedure {
  order_item_id: string; consent_confirmed: boolean; fasting_hours: string | null; anticoagulants: 'none' | 'stopped' | 'continued' | null; anticoag_note: string | null;
  allergies_reviewed: boolean; asa_class: number | null; bowel_prep: 'excellent' | 'good' | 'fair' | 'poor' | 'na' | null; checklist_note: string | null;
  sedation_type: 'none' | 'topical' | 'moderate' | 'deep' | 'general' | null; sedation_by: string | null;
  sedation_drugs: { drug: string; dose: number; unit: string; time?: string }[]; monitoring: { time: string; hr?: number; spo2?: number; sys?: number; dia?: number }[];
  scope_id: string | null; scope_used_at: string | null; started_at: string | null; ended_at: string | null; extent_reached: string | null; withdrawal_minutes: string | null; bbps_score: number | null;
  interventions: EndoIntervention[]; complications: 'none' | 'minor' | 'major'; complication_note: string | null; recovery_score: number | null; discharged_at: string | null;
  scope_name?: string | null; scope_serial?: string | null; nurse_name?: string | null; updated_at: string;
}
export interface EndoScope {
  id: string; name: string; scope_type: string; serial_number: string; is_active: boolean; note: string | null;
  last_used_at: string | null; last_reproc_at: string | null; last_reproc_result: 'passed' | 'failed' | null; state: 'ready' | 'dirty' | 'failed';
}
export interface PathSpecimen { id?: string; jar_no: number; site: string; pieces: number; description: string | null; fixative?: string }
export interface PathRequest {
  id: string; order_item_id: string; request_no: string; external_lab: string | null; clinical_info: string | null; status: 'draft' | 'sent' | 'resulted' | 'cancelled';
  sent_at: string | null; result_text: string | null; result_file_path: string | null; result_received_at: string | null; reviewed_at: string | null; specimens: PathSpecimen[];
  first_name?: string; last_name?: string; birth_date?: string; gender?: Gender; personal_number?: string | null; service_name?: string; performed_at?: string | null;
  sent_by_name?: string | null; reviewed_by_name?: string | null; ordered_by_name?: string | null; days_waiting?: number | null; encounter_id?: string; external_referral?: string | null;
}
export interface PathListRow {
  id: string; order_item_id: string; request_no: string; status: string; external_lab: string | null; sent_at: string | null; result_received_at: string | null; reviewed_at: string | null; created_at: string;
  first_name: string; last_name: string; personal_number: string | null; birth_date: string; gender: Gender; service_name: string; performed_at: string | null; jars: number; days_waiting: number | null;
}
