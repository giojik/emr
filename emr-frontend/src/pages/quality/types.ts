import type { Role } from '../../api/client';

/** ხარისხი და ინციდენტები (0064) */
export const QM_FULL: Role[] = ['quality'];
export const QM_READ: Role[] = ['quality', 'quality_dept'];
/** 0066: ანგარიშები — quality / quality_dept / quality_view */
export const QM_REPORTS: Role[] = ['quality', 'quality_dept', 'quality_view'];
export const SERVICE_KA: Record<string, string> = {
  inpatient: 'სტაციონარი', outpatient: 'ამბულატორია', emergency: 'გადაუდებელი', or: 'საოპერაციო', diagnostic: 'დიაგნოსტიკა', lab: 'ლაბორატორია', non_clinical: 'არაკლინიკური',
};

export type IdentityMode = 'open' | 'confidential' | 'anonymous';
export type Harm = 'none' | 'mild' | 'moderate' | 'severe' | 'death';
export type EventType = 'harm' | 'no_harm' | 'near_miss' | 'hazard';
export type Affected = 'patient' | 'staff' | 'visitor' | 'none';
export type SourceType = 'encounter' | 'stay' | 'med_order' | 'mar_entry' | 'or_case' | 'dx_order_item' | 'lab_specimen' | 'asset' | 'dx_device' | 'hai_case' | 'bme_device';
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
  // 0065
  investigator: 'გამომძიებელი დაინიშნა', level: 'ანალიზის დონე შეიცვალა', team: 'RCA გუნდი შეიცვალა', analysis_submitted: 'ანალიზი გაიგზავნა დასამტკიცებლად',
  analysis_approved: 'ანალიზი დამტკიცდა', analysis_returned: 'ანალიზი დაბრუნდა შესასწორებლად', disclosure: 'ინფორმირება აღირიცხა', closed: 'დაიხურა', capa: 'ქმედება (CAPA) დაემატა',
};
export const LEVEL_KA: Record<string, string> = { review: 'მოკლე მიმოხილვა', rca: 'RCA' };
export const ANALYSIS_ST: Record<string, [string, string]> = { draft: ['', 'მონახაზი'], submitted: ['warn', 'დამტკიცებას ელოდება'], approved: ['ok', 'დამტკიცებული'], returned: ['danger', 'დაბრუნებული'] };
export const CAPA_ST: Record<string, [string, string]> = { open: ['info', 'ღია'], in_progress: ['warn', 'შესრულებაში'], done: ['ok', 'შესრულებული'], cancelled: ['', 'გაუქმებული'] };
export const CAPA_KIND_KA: Record<string, string> = { corrective: 'მაკორექტირებელი', preventive: 'პრევენციული' };
export const METHOD_KA: Record<string, string> = { in_person: 'პირისპირ', phone: 'ტელეფონით', letter: 'წერილით', other: 'სხვა' };
export const CAPA_EVENT_KA: Record<string, string> = {
  created: 'შეიქმნა', updated: 'შეიცვალა', started: 'დაიწყო', done: 'შესრულდა', cancelled: 'გაუქმდა', due_requested: 'ვადის შეცვლის მოთხოვნა',
  due_approved: 'ვადის შეცვლა დამტკიცდა', due_rejected: 'ვადის შეცვლა უარყოფილია', effectiveness: 'ეფექტიანობა შეფასდა', files: 'ფაილი დაემატა',
};

export interface QmMeta {
  identity_modes: IdentityMode[]; identity_default: IdentityMode; ncc_merp: boolean; anonymous_tracking: boolean; event_prompts: boolean;
  risk: { low_max: number; medium_max: number; high_max: number };
  can_lookup: boolean; my_department_id: string | null; access: 'full' | 'dept' | null; reports: boolean;
  investigator_at_triage: boolean; analysis_approval: boolean; capa_effectiveness: boolean; closure_feedback: boolean; report_mask_patient: boolean;
  disclosure_required_harm: Harm | 'off';
}
export interface Analysis {
  incident_id: string; level: 'review' | 'rca'; level_label: string; status: 'draft' | 'submitted' | 'approved' | 'returned';
  what_happened: string | null; root_cause: string | null; action_taken: string | null; whys: string[]; root_causes: string | null; conclusion: string | null;
  submitted_at: string | null; submitted_by_name: string | null; approved_at: string | null; approved_by_name: string | null; return_reason: string | null; updated_at: string;
  timeline: { id: string; at: string | null; text: string; sort_order: number }[];
  factors: { factor_id: string; comment: string | null; name: string; group_name: string | null }[];
  team: { user_id: string; role_text: string | null; name: string; department_name: string | null }[];
}
export interface CapaRow {
  id: string; capa_no: string; title: string; kind: 'corrective' | 'preventive'; status: 'open' | 'in_progress' | 'done' | 'cancelled'; status_label: string; due_date: string;
  done_at: string | null; effectiveness_due: string | null; effectiveness_result: 'effective' | 'ineffective' | null; owner_name: string; overdue: boolean;
  incidents?: number | string; owner_id?: string; department_name?: string | null; effectiveness_pending?: boolean; due_request_pending?: boolean;
}
export interface Capa extends CapaRow {
  description: string | null; department_id: string | null; department_name: string | null; created_by_name: string; created_at: string; started_at: string | null;
  done_by_name: string | null; done_note: string | null; cancel_reason: string | null; effectiveness_note: string | null; effectiveness_at: string | null; effectiveness_by_name: string | null;
  follow_up_of: string | null; follow_up_of_no: string | null; owner_id: string; access: 'full' | 'inv' | 'owner';
}
export interface CapaDetail extends Omit<Capa, 'incidents'> {
  incidents: { id: string; inc_no: string; status: Status; category_name: string; department_name: string; occurred_at: string; root_cause: string | null }[];
  files: { id: string; mime_type: string; size_bytes: number; original_name: string | null; created_at: string }[];
  events: { id: string; at: string; kind: string; text: string | null; data: Record<string, unknown> | null; user_name: string | null }[];
  requests: { id: string; old_due: string; new_due: string; reason: string; requested_by_name: string; requested_at: string; status: 'pending' | 'approved' | 'rejected'; decided_by_name: string | null; decision_note: string | null }[];
  can: { edit: boolean; start: boolean; complete: boolean; cancel: boolean; request_due: boolean; decide_due: boolean; effectiveness: boolean; upload: boolean };
}
export interface MyWork {
  incidents: { id: string; inc_no: string; status: Status; analysis_level: 'review' | 'rca' | null; level_label: string | null; analysis_due_at: string | null; category_name: string;
    department_name: string; analysis_status: string | null; is_investigator: boolean; overdue: boolean }[];
  capas: { id: string; capa_no: string; title: string; kind: string; status: string; due_date: string; department_name: string | null; overdue: boolean; due_request_pending: boolean }[];
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
  summary: string; overdue: boolean; files: number; service_type: string;
}
export interface IncidentEvent { id: string; at: string; kind: string; text: string | null; data: Record<string, unknown> | null; internal: boolean; user_id: string | null; user_name: string | null }
export interface IncidentFile { id: string; mime_type: string; size_bytes: number; original_name: string | null; created_at: string; uploaded_by: string | null }
export interface Incident extends Omit<IncidentRow, 'summary' | 'files' | 'patient_name'> {
  access: 'full' | 'inv' | 'dept' | 'own'; event_label: string; medication: boolean;
  // 0065
  investigator_id: string | null; investigator_name: string | null; analysis_level: 'review' | 'rca' | null; analysis_due_at: string | null; analysis_overdue: boolean;
  disclosure_status: 'done' | 'not_disclosed' | null; disclosed_at: string | null; disclosure_by_name: string | null; disclosure_method: string | null; disclosure_to: string | null; disclosure_note: string | null;
  closed_at: string | null; closed_by_name: string | null; closure_summary: string | null; feedback_text: string | null;
  analysis: Analysis | null; capas: CapaRow[] | null;
  can: { edit_analysis: boolean; edit_team?: boolean; submit: boolean; disclose: boolean; add_capa?: boolean };
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

const HARM_ORDER: Harm[] = ['none', 'mild', 'moderate', 'severe', 'death'];
/** ინფორმირება სავალდებულოა? (პაციენტი + ზიანი ≥ ზღვარი) */
export const disclosureRequired = (d: { affected: Affected; harm: Harm | null; harm_reported: Harm }, m: Pick<QmMeta, 'disclosure_required_harm'>) =>
  d.affected === 'patient' && m.disclosure_required_harm !== 'off' && HARM_ORDER.indexOf(d.harm ?? d.harm_reported) >= HARM_ORDER.indexOf(m.disclosure_required_harm);

// ---------------------------------------------------------------- 0066: ანგარიშები
/** null — „< N“ (quality_view, view_min_cell) */
export type Cnt = number | null;
export interface QrMeta {
  access: 'full' | 'dept' | 'view'; scope_all: boolean; min_cell: number; date_basis: 'occurred' | 'reported'; today: string; data_as_of: string | null; reporting_enabled: boolean;
  departments: { id: string; name: string; is_active: boolean }[]; service_types: { code: string; name: string }[]; event_types: { code: string; name: string }[];
  harms: { code: string; name: string }[]; categories: { id: string; parent_id: string | null; name: string; is_active: boolean }[]; dims: { code: string; name: string }[];
  can_registry: boolean; can_drill: boolean;
}
export interface QrTotals { n: Cnt; harm: Cnt; no_harm: Cnt; near_miss: Cnt; hazard: Cnt; sentinel: Cnt; anonymous: Cnt; severe: Cnt; near_miss_ratio: number | null;
  anonymous_pct: number | null; report_rate: number | null; triage_on_time_pct: number | null }
export interface QrSummary { from: string; to: string; compare: { from: string; to: string }; scope_all: boolean; min_cell: number; data_as_of: string | null; totals: QrTotals; prev: QrTotals;
  bed_days: number; pending_triage: { n: number; overdue: number } | null;
  trend: { months: string[]; series: Record<EventType, Cnt[]>; total: Cnt[]; prev_year: Cnt[] } }
export interface QrPivot { rows_dim: string; cols_dim: string; from: string; to: string; min_cell: number; can_drill: boolean;
  rows: { key: string; label: string; total: Cnt; pct: number | null }[]; cols: { key: string; label: string; total: Cnt }[]; cells: Cnt[][]; total: Cnt }
export interface QrIndicator { code: string; kpi_code: string; name: string; description: string | null; denominator: string; denominator_ka: string; per: number; numerator: Cnt;
  denominator_value: number; value: number | null; target: number | null; warn: number | null; status: 'green' | 'yellow' | 'red' | null;
  by_department: { department_id: string; department_name: string; numerator: Cnt; denominator_value: number; value: number | null; status: string | null }[]; trend: (number | null)[] }
export interface QrIndicators { from: string; to: string; months: string[]; occupancy_basis: string; min_cell: number; rows: QrIndicator[] }
export interface QrTimeliness { from: string; to: string; min_cell: number; n: number;
  triage: { triaged: number; median_h: number | null; p90_h: number | null; avg_h: number | null; on_time_pct: number | null; sentinel: { triaged: number; median_h: number | null; on_time_pct: number | null } };
  closure: { closed: number; open: number; closed_pct: number | null; median_d: number | null; p90_d: number | null; avg_d: number | null };
  analysis: { review: { n: number; submitted: number; approved: number; on_time_pct: number | null };
    rca: { n: number; submitted: number; approved: number; completion_pct: number | null; on_time_pct: number | null; median_d: number | null }; overdue_now: number };
  by_department: { department_id: string; department_name: string; n: Cnt; triage_median_h: number | null; triage_on_time_pct: number | null; closed_pct: number | null; close_median_d: number | null;
    analysis_on_time_pct: number | null; rca_completion_pct: number | null }[] }
export interface QrCapa { from: string; to: string; min_cell: number;
  snapshot: { open: Cnt; in_progress: Cnt; overdue: Cnt; age: { d1_30: Cnt; d31_60: Cnt; d60: Cnt }; due_requests: Cnt; effectiveness_due: Cnt };
  period: { created: Cnt; corrective: Cnt; preventive: Cnt; done: Cnt; done_on_time: Cnt; on_time_pct: number | null; cancelled: Cnt; checked: Cnt; effective: Cnt; effective_pct: number | null };
  by_department: { department_id: string | null; department_name: string; open: Cnt; overdue: Cnt; done: Cnt; on_time_pct: number | null; effective_pct: number | null }[] }
export interface QrFactors { from: string; to: string; min_cell: number; analyses: Cnt;
  groups: { id: string; name: string; n: Cnt; pct: number | null; factors: { id: string; name: string; n: Cnt; pct: number | null }[] }[] }
export interface QmIndicatorDef { id: string; code: string; kpi_code: string; name: string; description: string | null; category_ids: string[]; categories: { id: string; name: string }[];
  event_types: EventType[]; min_harm: Harm | null; patient_only: boolean; service_types: string[]; denominator: 'bed_days' | 'admissions' | 'visits'; denominator_ka: string; per: number;
  is_active: boolean; sort_order: number; formula: string }
