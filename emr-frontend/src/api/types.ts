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
  id: string; status: EncounterStatus; type: string; start_time: string; end_time: string | null; chief_complaint: string | null;
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
  id: string; status: EncounterStatus; start_time: string; end_time: string | null; attending_doctor_id: string | null;
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
  consultation_tariff_id: string | null; consultation_tariff_title: string | null; consultation_price: string | null;
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
