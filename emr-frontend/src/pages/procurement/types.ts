import type { Role } from '../../api/client';

/** შესყიდვები (0051) — სერვერის PROC_READ / PR_EDIT / PO_EDIT-ის შესაბამისი */
export const PROC_READ: Role[] = ['admin', 'procurement', 'procurement_approve', 'stock_manager', 'storekeeper', 'pharmacist', 'accountant', 'manager', 'viewer'];
export const PR_EDIT: Role[] = ['admin', 'procurement', 'stock_manager', 'storekeeper', 'pharmacist'];
export const PO_EDIT: Role[] = ['admin', 'procurement', 'stock_manager'];
export const RECEIPT_EDIT: Role[] = ['admin', 'storekeeper', 'stock_manager', 'pharmacist'];

export type PrStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'closed' | 'cancelled';
export const PR_STATUS: Record<PrStatus, [string, string]> = {
  draft: ['warn', 'მონახაზი'], submitted: ['info', 'დასამტკიცებელი'], approved: ['ok', 'დამტკიცებული'], rejected: ['danger', 'უარყოფილი'], closed: ['', 'დახურული'], cancelled: ['', 'გაუქმებული'],
};
export const PR_SOURCE: Record<string, string> = { manual: 'ხელით', minmax: 'მინ/მაქს', request: 'განყოფილების მოთხოვნა' };
export type Step = 'l1' | 'finance' | 'pharmacist';
export const STEP_KA: Record<Step, string> = { l1: 'საწყობის მენეჯერი', finance: 'ფინანსური', pharmacist: 'ფარმაცევტი' };

export interface PrRow {
  id: string; pr_no: string | null; status: PrStatus; source: string; urgent: boolean; needed_by: string | null; est_total: string; created_at: string; submitted_at: string | null;
  created_by: string; created_by_name: string; location_id: string; location_name: string; lines: number; lines_ordered: number;
  needs_finance: boolean; needs_pharmacist: boolean; l1_at: string | null; finance_at: string | null; pharm_at: string | null;
}
export interface PrLine {
  id: string; line_no: number; item_id: string | null; free_name: string | null; item_name: string | null; item_code: string | null; base_unit_name: string | null;
  pack_id: string | null; pack_name: string | null; pack_qty_base: string; qty: string; qty_base: string; est_price: string | null; supplier_id: string | null; supplier_name: string | null;
  request_line_id: string | null; notes: string | null; controlled_class: string | null; qty_ordered: string;
}
export interface Pr extends Omit<PrRow, 'lines' | 'lines_ordered'> {
  location_kind: string; request_id: string | null; req_no: string | null; notes: string | null; reason: string | null;
  l1_by_name: string | null; finance_by_name: string | null; pharm_by_name: string | null; rejected_by_name: string | null; rejected_at: string | null; l1_by: string | null;
  lines: PrLine[]; orders: { id: string; po_no: string | null; status: PoStatus; order_date: string; supplier_name: string; total_gel: string }[]; pending: Step[];
}

export type PoStatus = 'draft' | 'pending' | 'sent' | 'partial' | 'received' | 'closed' | 'cancelled';
export const PO_STATUS: Record<PoStatus, [string, string]> = {
  draft: ['warn', 'მონახაზი'], pending: ['info', 'დასამტკიცებელი'], sent: ['accent', 'გაგზავნილი'], partial: ['warn', 'ნაწილობრივ მიღებული'], received: ['ok', 'მიღებული'],
  closed: ['', 'დახურული'], cancelled: ['', 'გაუქმებული'],
};
export type Currency = 'GEL' | 'USD' | 'EUR';
export const CUR_SIGN: Record<Currency, string> = { GEL: '₾', USD: '$', EUR: '€' };
export interface PoRow {
  id: string; po_no: string | null; status: PoStatus; order_date: string; expected_date: string | null; currency: Currency; total_net: string; total_vat: string; total_gel: string;
  supplier_id: string; location_id: string; supplier_name: string; location_name: string; created_by_name: string; overdue: boolean; lines: number; received_ratio: string; needs_approval: boolean;
}
export interface PoLine {
  id: string; line_no: number; item_id: string; item_name: string; item_code: string; base_unit_name: string; pack_id: string | null; pack_name: string | null; pack_qty_base: string;
  qty: string; qty_base: string; price: string; vat_rate: string; unit_cost_gel: string; line_net: string; line_vat: string; qty_received: string; requisition_line_id: string | null;
  pr_no: string | null; requisition_id: string | null; notes: string | null;
}
export interface Po extends Omit<PoRow, 'lines' | 'received_ratio'> {
  fx_rate: string; prices_include_vat: boolean; contract_no: string | null; notes: string | null; reason: string | null; created_by: string;
  supplier_tax_id: string | null; supplier_vat_payer: boolean; supplier_address: string | null; supplier_phone: string | null; supplier_email: string | null; supplier_contact: string | null;
  approved_by_name: string | null; approved_at: string | null; sent_by_name: string | null; sent_at: string | null; closed_by_name: string | null; closed_at: string | null;
  lines: PoLine[]; receipts: { id: string; doc_no: string | null; status: string; doc_date: string; total_net: string; total_vat: string; invoice_no: string | null; waybill_no: string | null; reversed_by_no: string | null }[];
}
export interface PriceRow {
  id: string; supplier_id: string; supplier_name: string; item_id: string; item_name: string; item_code: string; base_unit_name: string; pack_id: string | null; pack_name: string | null;
  pack_qty_base: string; price: string; vat_rate: string; min_qty: string | null; valid_from: string; valid_to: string | null; contract_no: string | null; notes: string | null; is_active: boolean; current: boolean;
}
export interface Hints {
  prices: { id: string; supplier_id: string; supplier_name: string; pack_id: string | null; pack_name: string | null; pack_qty_base: string; price: string; vat_rate: string; base_price: string; valid_to: string | null }[];
  last: { doc_no: string; doc_date: string; supplier_id: string | null; supplier_name: string | null; unit_cost: string; qty_base: string }[];
}
export interface ProcSummary { pr_to_approve: number; po_to_approve: number; po_overdue: number; pr_to_order: number }
export const num = (s: string) => Number(s.replace(',', '.'));
export const fmt = (v: number | string | null | undefined, d = 2) => (v === null || v === undefined || v === '' ? '—' : Number(v).toFixed(d));

// ======================================================================= 0052: მომწოდებლის ინვოისი / გადახდა
export const AP_EDIT: Role[] = ['admin', 'accountant'];
export const AP_READ: Role[] = ['admin', 'accountant', 'viewer', 'manager', 'procurement', 'procurement_approve', 'stock_manager'];
export type ApStatus = 'draft' | 'posted' | 'void';
export type MatchStatus = 'none' | 'ok' | 'mismatch' | 'accepted';
export const MATCH_KA: Record<MatchStatus, [string, string]> = { none: ['', 'შეჯერების გარეშე'], ok: ['ok', 'შეჯერებულია'], mismatch: ['danger', 'სხვაობა'], accepted: ['warn', 'სხვაობა დადასტურდა'] };
export const PAY_METHOD_KA: Record<string, string> = { bank_transfer: 'გადარიცხვა', cash: 'ნაღდი', card: 'ბარათი' };
export interface ApRow {
  id: string; ap_no: string | null; status: ApStatus; invoice_no: string; invoice_date: string; due_date: string; currency: Currency; fx_rate: string; total: string; total_gel: string;
  expense_total: string; stock_gel: string; match_status: MatchStatus; match_diff: string | null; supplier_id: string; supplier_name: string; paid: string; balance: string;
  receipts: number; days_overdue: number | null;
}
export interface ApInvoice extends Omit<ApRow, 'receipts'> {
  total_vat: string; notes: string | null; match_note: string | null; due_notified: string | null; void_reason: string | null; created_by: string;
  supplier_tax_id: string | null; supplier_iban: string | null; supplier_bank: string | null; payment_terms_days: number | null;
  created_by_name: string; posted_by_name: string | null; posted_at: string | null; accepted_by_name: string | null; voided_by_name: string | null; overdue: boolean;
  lines: { id: string; line_no: number; description: string; category: string; department_id: string | null; department_name: string | null; amount: string; vat_rate: string }[];
  receipts: { doc_id: string; amount_gel: string; doc_no: string; doc_date: string; invoice_no: string | null; waybill_no: string | null; total_net: string; total_vat: string; po_no: string | null; location_name: string | null; reversed_by_no: string | null }[];
  payments: { id: string; kind: 'payment' | 'credit_note'; pay_date: string; amount: string; fx_rate: string; amount_gel: string; method: string | null; reference: string | null; note: string | null; is_void: boolean; void_reason: string | null; created_by_name: string; reversal_doc_no: string | null }[];
  expenses: { id: string; expense_date: string; category: string; amount: string; source: string; is_void: boolean; department_name: string | null }[];
}
export interface UninvoicedRc { id: string; doc_no: string; doc_date: string; invoice_no: string | null; invoice_date: string | null; waybill_no: string | null; total_net: string; total_vat: string; po_no: string | null; location_name: string | null }
export interface ApSummary { drafts: number; mismatch: number; overdue: number; due_soon: number; open_gel: string }
export interface AgingRow { supplier_id: string; supplier_name: string; not_due: number; d1_30: number; d31_60: number; d61_90: number; d90: number; total: number; invoices: number }
export interface ApPaymentRow { id: string; kind: 'payment' | 'credit_note'; pay_date: string; amount: string; amount_gel: string; method: string | null; reference: string | null; is_void: boolean; void_reason: string | null;
  invoice_id: string; ap_no: string; invoice_no: string; currency: Currency; supplier_name: string; supplier_iban: string | null; created_by_name: string }
