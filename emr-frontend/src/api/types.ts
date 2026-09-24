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
