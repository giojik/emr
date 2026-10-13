import type { Role } from '../../../api/client';

/** სატარიფო ფენა (0054) — სერვერის TARIFF_READ / TARIFF_EDIT / TARIFF_APPROVE / REPRICE-ის შესაბამისი */
export const TARIFF_READ: Role[] = ['admin', 'billing', 'tariffs', 'tariffs_approve', 'accountant', 'viewer'];
export const TARIFF_EDIT: Role[] = ['admin', 'tariffs', 'billing'];
export const TARIFF_APPROVE: Role[] = ['admin', 'tariffs_approve'];
export const REPRICE: Role[] = ['admin', 'billing'];

export const SCOPE_KA: Record<string, string> = { base: 'საბაზო', department: 'განყოფილება', payer: 'გადამხდელი' };
export const KIND_KA: Record<string, string> = { tariff: 'მომსახურება', stock_item: 'საქონელი', stock_category: 'კატეგორია (ფასნამატი %)' };
export const STATUS_UI: Record<string, [string, string]> = {
  pending: ['warn', 'დასამტკიცებელი'], applied: ['ok', 'გატარებული'], rejected: ['danger', 'უარყოფილი'], cancelled: ['', 'გაუქმებული'], active: ['ok', 'მოქმედი'],
};
export const MODE_KA: Record<string, string> = { percent: 'პროცენტი', fixed: 'ფიქსირებული', drg: 'DRG' };
export const APPLIES_KA: Record<string, string> = { all: 'ამბ. + სტაც.', opd: 'ამბულატორია', ipd: 'სტაციონარი' };
export const LINE_CATS = ['bed', 'ventilation', 'surgery', 'anesthesia', 'service', 'consult', 'lab', 'radiology', 'endoscopy', 'medication', 'supply', 'implant', 'package', 'other'] as const;

export interface TariffList {
  id: string; code: string; name: string; scope: 'base' | 'department' | 'payer'; department_id: string | null; department_name: string | null;
  payer_id: string | null; payer_name: string | null; payer_kind: string | null; is_active: boolean; notes: string | null; items_now: number; items_future: number;
}
export interface ListItem {
  kind: 'tariff' | 'stock_item' | 'stock_category'; ref: string; code: string; name: string; is_active: boolean; group_name: string | null;
  item_id: string | null; price: string | null; markup_pct: string | null; valid_from: string | null; valid_to: string | null;
  base_price: string | null; base_markup: string | null; next: { valid_from: string; price: string | null; markup_pct: string | null } | null; pending: number;
}
export interface HistoryRow {
  id: string; price: string | null; markup_pct: string | null; valid_from: string | null; valid_to: string | null; superseded: boolean; created_at: string;
  change_no: string | null; reason: string | null; by_name: string | null; lines: number;
}
export interface Change {
  id: string; change_no: string; kind: 'prices' | 'rules'; status: string; title: string; reason: string; source: string; approval: string; created_at: string;
  decided_at: string | null; decision_note: string | null; created_by: string | null; created_by_name: string | null; decided_by_name: string | null; items: number; payers: string | null;
}
export interface ChangeItemRow {
  id: string; list_name: string; scope: string; kind: string; action: 'set' | 'end'; price: string | null; markup_pct: string | null; valid_from: string;
  prev_price: string | null; prev_markup: string | null; code: string; name: string;
}
export interface Clause {
  id?: string; seq: number; label: string | null; categories: string[]; codes: string[]; age_min: number | null; age_max: number | null; sex: 'male' | 'female' | null;
  dx_prefixes: string[]; effect: 'exclude' | 'cover'; coverage_pct: string | number | null; line_limit: string | number | null;
}
export interface RuleVersion {
  id: string; payer_id: string; version_no: number; status: string; valid_from: string | null; applies_to: string; mode: string; coverage_pct: string;
  limit_amount: string | null; deductible: string; fixed_amount: string | null; drg_base_rate: string | null; writeoff_excess: boolean; copay_amount: string;
  excluded_categories: string[]; excluded_codes: string[]; notes: string | null; change_no: string | null; created_by_name: string | null; stays: number; clauses: Clause[];
}
export interface PayerRules { payer: { id: string; name: string; kind: string; code: string }; current_version_id: string | null; price_list: { id: string; name: string } | null; versions: RuleVersion[] }

export const n2 = (v: string | number | null | undefined) => (v === null || v === undefined || v === '' ? '—' : Number(v).toFixed(2));
export const pctTxt = (v: string | number | null | undefined) => (v === null || v === undefined ? '—' : `${Number(v)}%`);
export const dg = (d: string | null | undefined) => (d ? d.split('-').reverse().join('/') : '—');
