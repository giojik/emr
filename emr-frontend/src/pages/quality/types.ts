import type { Role } from '../../api/client';

/** ხარისხი და ინციდენტები (0064) */
export const QM_FULL: Role[] = ['quality'];
export const QM_READ: Role[] = ['quality', 'quality_dept'];

export type IdentityMode = 'open' | 'confidential' | 'anonymous';
export type Harm = 'none' | 'mild' | 'moderate' | 'severe' | 'death';
export type EventType = 'harm' | 'no_harm' | 'near_miss' | 'hazard';
export type Affected = 'patient' | 'staff' | 'visitor' | 'none';
export type SourceType = 'encounter' | 'stay' | 'med_order' | 'mar_entry' | 'or_case' | 'dx_order_item' | 'lab_specimen' | 'asset' | 'dx_device';
export type Status = 'submitted' | 'rejected' | 'investigation' | 'analysis' | 'capa' | 'closed';
export type RiskLevel = 'low' | 'medium' | 'high' | 'extreme';

export const IDENTITY_KA: Record<IdentityMode, [string, string]> = {
  open: ['ღია', 'ჩემი სახელი ჩანს ხარისხის მენეჯერთან და განყოფილების განმხილველთან'],
  confidential: ['კონფიდენციალური', 'ჩემი სახელი ჩანს მხოლოდ ხარისხის მენეჯერთან'],
  anonymous: ['ანონიმური', 'სახელი არსად ინახება; სტატუსს ნახავთ ერთჯერადი კოდით'],
};
export const EVENT_KA: Record<EventType, [string, string]> = {
  harm: ['ინციდენტი ზიანით', 'პაციენტს / თანამშრომელს მიადგა ზიანი'],
  no_harm: ['ინციდენტი ზიანის გარეშე', 'მოხდა, მაგრამ ზიანი არ მიუყენებია'],
  near_miss: ['near-miss', 'თავიდან იქნა აცილებული — პაციენტამდე არ მივიდა'],
  hazard: ['სახიფათო მდგომარეობა', 'რისკი, რომელიც ჯერ არ მომხდარა'],
};
export const AFFECTED_KA: Record<Affected, string> = { patient: 'პაციენტი', staff: 'თანამშრომელი', visitor: 'ვიზიტორი', none: 'არავის' };
export const HARM_KA: Record<Harm, string> = { none: 'არ არის', mild: 'მსუბუქი', moderate: 'საშუალო', severe: 'მძიმე', death: 'სიკვდილი' };
export const HARM_CHIP: Record<Harm, string> = { none: '', mild: 'info', moderate: 'warn', severe: 'danger', death: 'danger' };
export const STATUS_UI: Record<Status, [string, string]> = {
  submitted: ['warn', 'ტრიაჟს ელოდება'], rejected: ['', 'უარყოფილი'], investigation: ['info', 'განიხილება'],
  analysis: ['info', 'ანალიზი'], capa: ['info', 'მაკორექტირებელი ქმედებები'], closed: ['ok', 'დახურული'],
};
export const RISK_UI: Record<RiskLevel, [string, string]> = { low: ['ok', 'დაბალი'], medium: ['info', 'საშუალო'], high: ['warn', 'მაღალი'], extreme: ['danger', 'ექსტრემალური'] };
export const REJECT_KA: Record<string, string> = { duplicate: 'დუბლიკატი', not_incident: 'არ არის ინციდენტი', insufficient: 'არასაკმარისი ინფორმაცია', other: 'სხვა' };
export const PERSON_ROLE_KA: Record<string, string> = { involved: 'მონაწილე', witness: 'მოწმე', affected: 'დაზარალებული' };
export const MERP_KA: Record<string, string> = {
  A: 'A — შეცდომის პოტენციალი', B: 'B — შეცდომა, პაციენტამდე არ მივიდა', C: 'C — მივიდა, ზიანი არ მიუყენებია', D: 'D — მივიდა, საჭირო გახდა მონიტორინგი',
  E: 'E — დროებითი ზიანი, ჩარევა', F: 'F — დროებითი ზიანი, ჰოსპიტალიზაცია / გახანგრძლივება', G: 'G — მუდმივი ზიანი', H: 'H — სიცოცხლის გადასარჩენი ჩარევა', I: 'I — სიკვდილი',
};
export const LIKELIHOOD_KA = ['', 'იშვიათი', 'ნაკლებად სავარაუდო', 'შესაძლო', 'სავარაუდო', 'თითქმის გარდაუვალი'];
export const CONSEQUENCE_KA = ['', 'უმნიშვნელო', 'მცირე', 'ზომიერი', 'მნიშვნელოვანი', 'კატასტროფული'];
export const EVENT_LOG_KA: Record<string, string> = {
  submitted: 'შეტყობინება', edited: 'ავტორმა შეცვალა', author_note: 'ავტორის დამატებითი ინფორმაცია', accepted: 'ტრიაჟი: მიღებულია', rejected: 'ტრიაჟი: უარყოფილია',
  reopened: 'ხელახლა გაიხსნა', reclassified: 'კლასიფიკაცია შეიცვალა', comment: 'კომენტარი', files: 'ფაილი დაემატა',
};

export interface QmMeta {
  identity_modes: IdentityMode[]; identity_default: IdentityMode; ncc_merp: boolean; anonymous_tracking: boolean; event_prompts: boolean;
  risk: { low_max: number; medium_max: number; high_max: number };
  can_lookup: boolean; my_department_id: string | null; access: 'full' | 'dept' | null; reports: boolean;
}
export interface Classifier {
  id: string; kind: 'category' | 'factor'; parent_id: string | null; code: string; name: string; description: string | null;
  is_medication: boolean; is_sentinel: boolean; is_active: boolean; sort_order: number; used: number;
}
export interface Source { type: SourceType; id: string; label: string; at: string | null; patient_id: string | null }
export interface Prompt extends Source { reason: 'missed' | 'override' | 'count'; category_id: string | null }
export interface Person { id?: string; role: 'involved' | 'witness' | 'affected'; user_id: string | null; name_text: string | null; note: string | null; user_name?: string | null; department_name?: string | null }

export interface IncidentRow {
  id: string; inc_no: string; status: Status; status_label: string; event_type: EventType; affected: Affected; occurred_at: string; reported_at: string;
  department_id: string; department_name: string; category_id: string; category_name: string; category_parent_name: string | null;
  harm_reported: Harm; harm: Harm | null; risk_score: number | null; risk_level: RiskLevel | null; is_sentinel: boolean; urgent: boolean; identity_mode: IdentityMode;
  triage_due_at: string; source_label: string | null; patient_text: string | null; patient_id: string | null; patient_name: string | null; reporter_name: string | null;
  summary: string; overdue: boolean; files: number;
}
export interface IncidentEvent { id: string; at: string; kind: string; text: string | null; data: Record<string, unknown> | null; internal: boolean; user_id: string | null; user_name: string | null }
export interface IncidentFile { id: string; mime_type: string; size_bytes: number; original_name: string | null; created_at: string; uploaded_by: string | null }
export interface Incident extends Omit<IncidentRow, 'summary' | 'files' | 'patient_name'> {
  access: 'full' | 'dept' | 'own'; event_label: string; medication: boolean;
  location_text: string | null; merp_category: string | null; description: string; immediate_actions: string | null;
  patient_first_name: string | null; patient_last_name: string | null; patient_personal_number: string | null; patient_birth_date: string | null;
  encounter_id: string | null; source_type: SourceType | null; source_id: string | null; reporter_id: string | null;
  category_parent_id: string | null; triaged_at: string | null; triaged_by_name: string | null; triage_note: string | null; reject_reason: string | null;
  duplicate_of: string | null; duplicate_inc_no: string | null; likelihood: number | null; consequence: number | null;
  files: IncidentFile[]; events: IncidentEvent[]; people: Person[] | null;
}
export interface QmSummary { submitted: number; overdue: number; open: number; urgent_open: number; sentinel_open: number; month: number; near_miss_month: number; scope: 'all' | 'dept' }
export interface MyReport { id: string; inc_no: string; status: Status; status_label: string; event_type: EventType; occurred_at: string; reported_at: string; identity_mode: IdentityMode;
  reject_reason: string | null; reject_label: string | null; category_name: string; department_name: string }

/** რისკის დონე ქულით (კლინიკის ზღვრები) */
export const riskOf = (score: number, r: QmMeta['risk']): RiskLevel => (score <= r.low_max ? 'low' : score <= r.medium_max ? 'medium' : score <= r.high_max ? 'high' : 'extreme');
export const catLabel = (r: { category_name: string; category_parent_name: string | null }) => (r.category_parent_name ? `${r.category_parent_name} → ${r.category_name}` : r.category_name);
