import type { Role } from '../../api/client';

/** ფინანსები (0053) — სერვერის FIN_READ / FIN_FULL / FIN_EDIT / CLAIM_RESOLVE-ის შესაბამისი */
export const FIN_READ: Role[] = ['admin', 'accountant', 'viewer', 'manager'];
export const FIN_FULL: Role[] = ['admin', 'accountant', 'viewer'];
export const FIN_EDIT: Role[] = ['admin', 'accountant'];
export const CLAIM_RESOLVE: Role[] = ['admin', 'accountant', 'billing'];

export const KINDS = ['patient', 'insurance', 'state', 'other', 'writeoff', 'denied', 'undetermined'] as const;
export type Kind = (typeof KINDS)[number];
export const KIND_KA: Record<Kind, string> = {
  patient: 'პაციენტი', insurance: 'დაზღვევა', state: 'სახელმწიფო', other: 'სხვა გადამხდელი', writeoff: 'ჩამოწერა (DRG / ფიქს.)', denied: 'უარი — ჩამოწერილი',
  undetermined: 'განუსაზღვრელი',
};
export const KIND_HINT: Partial<Record<Kind, string>> = { undetermined: 'სტაციონარი, ჯერ არ არის ფინანსურად დახურული — გადამხდელის წილი ჯერ უცნობია' };
export const CAT_KA: Record<string, string> = {
  bed: 'საწოლდღე', ventilation: 'ხელოვნური ვენტილაცია', surgery: 'ოპერაცია', anesthesia: 'ანესთეზია', service: 'მომსახურება', consult: 'კონსულტაცია', lab: 'ლაბორატორია',
  radiology: 'რადიოლოგია', endoscopy: 'ენდოსკოპია', medication: 'მედიკამენტი', supply: 'სამედიცინო მასალა', implant: 'იმპლანტი', package: 'პაკეტი', other: 'სხვა',
};
export const BASIS_KA = { service_date: 'მომსახურების თარიღით', finalized: 'ინვოისის / ფინალიზაციის თარიღით' } as const;
export const DEPT_BASIS_KA = { performing: 'შემსრულებელი განყოფილება', ordering: 'დამნიშნავი განყოფილება' } as const;
export const STOCK_BASIS_KA = { consumption: 'ფაქტობრივი მოხმარება', issue: 'გაცემა განყოფილებაზე' } as const;
export const ALLOC_KA = { none: 'არ ნაწილდება', revenue: 'შემოსავლის წილით', bed_days: 'საწოლდღეებით', manual: 'ხელით მითითებული %' } as const;

export const fmt = (v: number | string | null | undefined) => (v === null || v === undefined || v === '' ? '—'
  : (Math.abs(Number(v)) < 0.005 ? 0 : Number(v)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
export const monthStart = (iso: string) => iso.slice(0, 8) + '01';

export interface FinSummary {
  period_lock: 'on' | 'off'; last_closed: string | null; scope_department: string | null; full: boolean;
  claims: { drafts: number; open: number; overdue: number; outstanding: string } | null;
  rules: { revenue_basis: keyof typeof BASIS_KA; revenue_dept_basis: keyof typeof DEPT_BASIS_KA; dept_consumption_basis: keyof typeof STOCK_BASIS_KA; overhead_allocation: keyof typeof ALLOC_KA };
}
export type KindMap = Record<Kind, number>;
export interface Revenue {
  from: string; to: string; basis: keyof typeof BASIS_KA; dept_basis: keyof typeof DEPT_BASIS_KA; scope_department: string | null;
  totals: KindMap & { total: number; net: number; invoices: number };
  by_kind: { kind: Kind; kind_ka: string; amount: number }[];
  by_payer: { payer_id: string | null; payer_name: string; code: string | null; kind: Kind; kind_ka: string; amount: number; invoices: number }[];
  by_department: (KindMap & { department_id: string | null; department_name: string; total: number; net: number })[];
  by_category: { category: string; amount: number }[];
  by_month: (KindMap & { month: string; total: number })[];
}
export interface StockValue {
  as_of: string; costing_method: 'fifo' | 'average'; scope_department: string | null; total: number;
  by_location: { location_id: string; location_name: string; kind: string; department_id: string | null; department_name: string | null; value: number }[];
  by_category: { category: string; value: number }[];
  by_department: { department_id: string | null; department_name: string; value: number }[];
}
export interface ConsRow { department_id: string | null; department_name: string; department_type: string | null; cost: number; consumption: number; loss: number; issued: number;
  billed_cost: number; unbilled_cost: number; billed_revenue: number; patients: number; on_hand: number }
export interface Consumption {
  from: string; to: string; basis: keyof typeof STOCK_BASIS_KA; costing_method: string; scope_department: string | null;
  totals: Omit<ConsRow, 'department_id' | 'department_name' | 'department_type' | 'patients'>;
  by_department: ConsRow[]; by_category: { category: string; cost: number }[]; top_items: { item_id: string; item_name: string; cost: number }[]; by_month: { month: string; cost: number }[];
}
export interface ResultRow { department_id: string; department_name: string; department_type: string; revenue: number; writeoff: number; revenue_net: number; expenses: number;
  stock_cost: number; overhead: number; result: number; margin_pct: number | null; bed_days: number }
export interface DeptResult {
  from: string; to: string; dept_basis: keyof typeof DEPT_BASIS_KA; allocation: keyof typeof ALLOC_KA; revenue_basis: string; stock_basis: string; scope_department: string | null;
  rows: ResultRow[];
  pool: { expenses: number; stock: number; total: number; admin_departments: { department_id: string | null; department_name: string; expenses: number; stock_cost: number }[] } | null;
  unallocated: number | null; revenue_without_department?: number;
  totals: { revenue: number; writeoff: number; revenue_net: number; expenses: number; stock_cost: number; overhead: number; result: number } | null;
}

export type ClaimStatus = 'draft' | 'sent' | 'partial' | 'settled' | 'cancelled';
export const CLAIM_STATUS: Record<ClaimStatus, [string, string]> = {
  draft: ['warn', 'მონახაზი'], sent: ['info', 'გაგზავნილი'], partial: ['warn', 'ნაწილობრივ'], settled: ['ok', 'დაფარული'], cancelled: ['', 'გაუქმებული'],
};
export interface ClaimRow {
  id: string; claim_no: string | null; status: ClaimStatus; payer_id: string; payer_name: string; payer_kind: string; period_from: string; period_to: string;
  total_claimed: string; total_paid: string; total_resolved: string; outstanding: string; items: number; sent_at: string | null; due_date: string | null; days_overdue: number | null; created_at: string;
}
export interface ClaimItem {
  id: string; kind: 'ipd' | 'opd'; invoice_id: string; share_slot: 'insurance' | 'state'; claimed: string; paid: string; resolution: 'patient' | 'writeoff' | null; resolved_amount: string;
  resolution_reason: string | null; resolved_at: string | null; resolved_by_name: string | null; outstanding: string; invoice_number: string; adm_no: string | null; encounter_id: string;
  personal_number: string | null; patient: string; policy_no: string | null; guarantee_no: string | null; case_date: string;
  /** 0057: შემოწმება (მონახაზი / გაგზავნილი) */
  scrub?: { errors: number; warnings: number; overridden: number; issues: { code: string; severity: 'error' | 'warn'; message: string; detail: string | null }[] } | null;
  /** 0058: გადამხდელის პასუხი */
  resp_status: 'accepted' | 'partial' | 'rejected' | 'pending' | null; resp_amount: string | null; resp_reason: string | null; resp_reason_title: string | null;
  resp_default_action: 'patient' | 'writeoff' | null; resp_note: string | null; resp_ref: string | null; resp_at: string | null; resp_import_id: string | null;
}
export interface ClaimPayment { id: string; paid_on: string; amount: string; ref_no: string | null; note: string | null; is_void: boolean; void_reason: string | null; created_at: string; created_by_name: string; voided_by_name: string | null; items: number }
export interface Claim extends Omit<ClaimRow, 'items' | 'days_overdue'> {
  payer_code: string; payment_terms_days: number; notes: string | null; created_by_name: string; sent_by_name: string | null; cancel_reason: string | null; cancelled_by_name: string | null;
  payer_kind_ka: string; items: ClaimItem[]; payments: ClaimPayment[];
  scrub?: { errors: number; warnings: number } | null;
  /** 0057: შექმნა / განახლება — შეცდომის გამო გამოტოვებული შემთხვევები */
  scrub_skipped?: { invoice_number: string; patient: string; errors: string }[];
  /** 0058: პასუხის შეჯამება */
  responses: { accepted: number; partial: number; rejected: number; pending: number; none: number; approved: number; denied: number };
}
export interface Candidate { kind: 'ipd' | 'opd'; invoice_id: string; payer_id: string; claimed: string; case_date: string; invoice_number: string; adm_no: string | null; patient: string; personal_number: string | null }
export interface RecvRow { payer_id: string; payer_name: string; kind: string; kind_ka: string; unclaimed: number; draft: number; not_due: number; d1_30: number; d31_60: number; d61_90: number; d90: number; outstanding: number; total: number }
export interface Receivables { as_of: string; rows: RecvRow[]; totals: Omit<RecvRow, 'payer_id' | 'payer_name' | 'kind' | 'kind_ka'> }

export interface Period {
  month: string; status: 'open' | 'closed'; closable: boolean; closed_at: string | null; closed_by_name: string | null; note: string | null; reopened_at: string | null; reopened_by_name: string | null;
  reopen_reason: string | null; locked: boolean;
  snapshot: { revenue?: { total: number; net: number }; expenses?: number; stock_cost?: number; stock_value_end?: number; patient_payments?: number; warnings?: { code: string; n: number }[] } | null;
}
export interface Periods { period_lock: 'on' | 'off'; today: string; periods: Period[]; log: { id: string; month: string; action: 'close' | 'reopen'; reason: string | null; created_at: string; user_name: string }[] }
export interface Checklist { month: string; from: string; to: string; warnings: number; items: { code: string; label: string; n: number; amount: number | null }[] }
export interface Payer { id: string; code: string; name: string; kind: 'insurance' | 'state' | 'other'; is_active: boolean; payment_terms_days?: number }

export function Kpi({ label, value, tone, hint }: { label: string; value: string; tone?: 'danger' | 'warn' | 'ok'; hint?: string }) {
  return (
    <div className="card card-pad" style={{ minWidth: 160, flex: '1 1 160px' }} title={hint}>
      <div className="small muted">{label}</div>
      <div className="mono" style={{ fontSize: 20, fontWeight: 600, color: tone === 'danger' ? 'var(--danger-ink)' : tone === 'warn' ? 'var(--warn-ink)' : tone === 'ok' ? 'var(--ok-ink)' : undefined }}>{value}</div>
    </div>
  );
}

/** ჰორიზონტალური ზოლი (წილი მაქსიმუმთან) */
export function Bar({ value, max, tone }: { value: number; max: number; tone?: string }) {
  const w = max > 0 ? Math.max(0, Math.min(100, (Math.abs(value) / max) * 100)) : 0;
  return <div style={{ height: 8, background: 'var(--line-soft)', borderRadius: 4, minWidth: 80 }}><div style={{ width: `${w}%`, height: '100%', borderRadius: 4, background: tone ?? 'var(--accent)' }} /></div>;
}
