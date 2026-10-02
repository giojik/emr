/** საწყობი / აფთიაქი (0030): ნომენკლატურა — ტიპები და ცნობარები */
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';

export interface StockUnit { code: string; name: string; is_active: boolean; sort_order: number }
export interface DosageForm { code: string; name: string; is_active: boolean; sort_order: number }
export interface MedRoute { code: string; name: string; is_active: boolean; sort_order: number }
export type CategoryKind = 'medication' | 'medical_supply' | 'implant' | 'reagent' | 'qc_material' | 'household' | 'office' | 'other';
export interface StockCategory {
  id: string; code: string; name: string; kind: CategoryKind; parent_id: string | null;
  requires_lot: boolean; requires_expiry: boolean; serial_tracked: boolean; expiry_warn_days: number | null;
  billing_mode: 'none' | 'invoice'; markup_pct: string | null; is_active: boolean; sort_order: number;
}
export interface StockSettings { costing_method: 'fifo' | 'average'; short_expiry_months: number; writeoff_approval_threshold: string; alert_hour: number; updated_at: string }
export interface StockRefs { units: StockUnit[]; forms: DosageForm[]; routes: MedRoute[]; categories: StockCategory[]; settings: StockSettings; allergen_groups: { code: string; name: string }[] }

export interface StockPack { id: string; name: string; qty_base: number | string; is_receipt_default: boolean }
export interface StockBarcode { id: string; barcode: string; pack_id: string | null; kind: 'gtin' | 'internal' }
export interface StockItem {
  id: string; code: string; name: string; category_id: string; generic_id: string | null; manufacturer: string | null; country: string | null;
  base_unit: string; requires_lot: boolean; requires_expiry: boolean; serial_tracked: boolean; storage: StorageKind;
  expiry_warn_days: number | null; sale_price: string | null; billing_mode: 'none' | 'invoice' | null; notes: string | null; is_active: boolean;
  category_name: string; category_kind: CategoryKind; base_unit_name: string; inn: string | null; strength: string | null; atc_code: string | null;
  controlled_class: Controlled | null; high_alert: boolean | null; patient_only: boolean | null; form_name: string | null;
  effective_warn_days: number | null; effective_billing_mode: 'none' | 'invoice'; packs: StockPack[]; barcodes: StockBarcode[];
}
export type StorageKind = 'room' | 'cool' | 'fridge' | 'frozen';
export type Controlled = 'narcotic' | 'psychotropic' | 'precursor' | 'potent';
export interface MedGeneric {
  id: string; inn: string; inn_latin: string | null; atc_code: string | null; form_code: string; form_name: string; strength: string | null;
  dose_unit: string | null; dose_per_unit: string | null; routes: string[]; controlled_class: Controlled | null;
  high_alert: boolean; reserve_antibiotic: boolean; patient_only: boolean;
  max_single_dose: string | null; max_daily_dose: string | null; ped_max_single_per_kg: string | null; ped_max_daily_per_kg: string | null; min_age_days: number | null;
  notes: string | null; is_active: boolean; allergen_groups: string[]; items: number;
}
export interface MedInteraction {
  id: string; a_generic_id: string | null; a_atc: string | null; b_generic_id: string | null; b_atc: string | null;
  severity: Severity; effect: string; recommendation: string | null; source: 'local' | 'external'; source_ref: string | null; is_active: boolean;
  a_label: string; b_label: string;
}
export type Severity = 'contraindicated' | 'major' | 'moderate' | 'minor';
export interface Supplier {
  id: string; name: string; tax_id: string | null; vat_payer: boolean; address: string | null; phone: string | null; email: string | null;
  contact_person: string | null; notes: string | null; is_active: boolean;
}
export type LocationKind = 'central' | 'pharmacy' | 'household' | 'department' | 'operating' | 'cssd' | 'lab' | 'icu' | 'other' | 'transit';
export interface StockLocation {
  id: string; code: string; name: string; kind: LocationKind; department_id: string | null; department_name: string | null;
  requires_approval: boolean; is_active: boolean; sort_order: number; default_source_id?: string | null;
}

export const KIND_KA: Record<CategoryKind, string> = {
  medication: 'მედიკამენტი', medical_supply: 'სამედიცინო მასალა', implant: 'იმპლანტი', reagent: 'რეაგენტი', qc_material: 'QC მასალა',
  household: 'სამეურნეო', office: 'საოფისე', other: 'სხვა',
};
export const STORAGE_KA: Record<StorageKind, string> = { room: 'ოთახის ტემპ.', cool: 'გრილი (8–15°)', fridge: 'მაცივარი (2–8°)', frozen: 'საყინულე' };
export const CONTROLLED_KA: Record<Controlled, string> = { narcotic: 'ნარკოტიკული', psychotropic: 'ფსიქოტროპული', precursor: 'პრეკურსორი', potent: 'ძლიერმოქმედი' };
export const SEVERITY_KA: Record<Severity | 'duplicate', [string, string]> = {
  contraindicated: ['danger', 'უკუნაჩვენები'], major: ['danger', 'მძიმე'], moderate: ['warn', 'საშუალო'], minor: ['info', 'მსუბუქი'], duplicate: ['warn', 'დუბლირება'],
};
export const LOCATION_KA: Record<LocationKind, string> = {
  central: 'ცენტრალური საწყობი', pharmacy: 'აფთიაქი', household: 'სამეურნეო', department: 'განყოფილება', operating: 'საოპერაციო',
  cssd: 'სტერილიზაცია (CSSD)', lab: 'ლაბორატორია', icu: 'რეანიმაცია / ინტენსიური', other: 'სხვა', transit: 'გზაში (სისტემური)',
};
export const DOSE_UNITS = ['mg', 'mcg', 'g', 'IU', 'ml', 'mmol', 'mEq'] as const;
export const COSTING_KA: Record<StockSettings['costing_method'], string> = { fifo: 'ლოტის ფასი (FIFO)', average: 'საშუალო შეწონილი' };

export const useStockRefs = () => useQuery({ queryKey: ['stock-refs'], queryFn: () => api<StockRefs>('/stock/refs'), staleTime: 60_000 });
export const genericLabel = (g: Pick<MedGeneric, 'inn' | 'strength' | 'form_name'>) => `${g.inn}${g.strength ? ` ${g.strength}` : ''} — ${g.form_name}`;
export const qtyFmt = (v: number | string) => { const n = Number(v); return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3))); };
/** ცარიელი სტრიქონი → null (PATCH-ისთვის) */
export const nul = (s: string) => (s.trim() ? s.trim() : null);

// ---------------------------------------------------------------- 0031: დოკუმენტები, ნაშთები
export type DocStatus = 'draft' | 'posted' | 'cancelled';
export interface StockDocRow {
  id: string; doc_type: string; doc_no: string | null; status: DocStatus; doc_date: string; invoice_no: string | null; waybill_no: string | null;
  total_net: string; total_vat: string; posted_at: string | null; reversal_of: string | null; reversed_by: string | null; reversed_by_no: string | null; created_at: string;
  location_name: string | null; supplier_name: string | null; created_by_name: string; lines: number;
}
export interface StockDocLine {
  id: string; line_no: number; item_id: string; pack_id: string | null; pack_qty_base: string; qty: string; qty_base: string; lot_no: string | null; serial_no: string | null;
  expires_on: string | null; produced_on: string | null; price: string | null; vat_rate: string; unit_cost: string | null; line_net: string | null; line_vat: string | null;
  lot_id: string | null; short_expiry_reason: string | null; notes: string | null; override_reason?: string | null; patient_name?: string | null;
  item_name: string; item_code: string; requires_lot: boolean; requires_expiry: boolean; serial_tracked: boolean; base_unit_name: string; pack_name: string | null; controlled_class: Controlled | null;
}
export interface DocIssue { line_no: number; level: 'error' | 'warn'; code: string; message: string }
export interface StockDoc extends Omit<StockDocRow, 'lines' | 'reversed_by_no'> {
  location_id: string | null; supplier_id: string | null; invoice_date: string | null; prices_include_vat: boolean; notes: string | null; reason: string | null;
  location_kind: LocationKind | null; supplier_tax_id: string | null; supplier_vat_payer: boolean | null; posted_by_name: string | null;
  reversal_of_no: string | null; reversed_by_no: string | null; lines: StockDocLine[]; issues: DocIssue[];
}
export interface BalanceRow {
  location_id: string; lot_id: string; item_id: string; qty: string; location_name: string; item_name: string; item_code: string; base_unit_name: string; category_name: string;
  lot_no: string | null; serial_no: string | null; expires_on: string | null; lot_status: 'active' | 'quarantine' | 'recalled'; cost_lot: string; cost_avg: string | null;
  inn: string | null; strength: string | null; controlled_class: Controlled | null; days_left: number | null; warn_days: number | null;
  packs: { name: string; qty_base: string }[]; unit_cost: number; value: number;
}
export interface Balances { costing_method: 'fifo' | 'average'; today: string; total_value: number; rows: BalanceRow[] }
export interface MoveRow {
  id: string; created_at: string; move_type: string; qty: string; cost_lot: string; cost_avg: string | null; doc_id: string; doc_no: string | null; doc_type: string; doc_date: string;
  location_name: string; lot_no: string | null; serial_no: string | null; expires_on: string | null; user_name: string;
}
export const DOC_STATUS: Record<DocStatus, [string, string]> = { draft: ['warn', 'მონახაზი'], posted: ['ok', 'გატარებული'], cancelled: ['', 'გაუქმებული'] };
export const DOC_TYPE_KA: Record<string, string> = { receipt: 'მიღება', reversal: 'შემობრუნება', transfer: 'გადაცემა', issue: 'გაცემა', return: 'დაბრუნება', writeoff: 'ჩამოწერა', adjustment: 'კორექტირება', consumption: 'ხარჯი' };
export const RECEIPT_EDIT_ROLES = ['admin', 'storekeeper', 'stock_manager', 'pharmacist'] as const;
export const REVERSE_ROLES = ['admin', 'stock_manager'] as const;
/** რაოდენობა შეფუთვებით: 50 → „5 კოლოფი“ (ნაშთით) */
export const packBreakdown = (qty: number, packs: { name: string; qty_base: string | number }[]) => {
  const big = packs.map((p) => ({ ...p, q: Number(p.qty_base) })).filter((p) => p.q > 1 && qty >= p.q).sort((a, b) => b.q - a.q)[0];
  if (!big) return '';
  const n = Math.floor(qty / big.q); const rest = Math.round((qty - n * big.q) * 1000) / 1000;
  return `${n} ${big.name}${rest ? ` + ${rest}` : ''}`;
};
export const money2 = (v: number | string | null | undefined) => (v === null || v === undefined ? '—' : `${Number(v).toFixed(2)} ₾`);

// ---------------------------------------------------------------- 0032: მოთხოვნები, გაცემა, გადაცემა
export type ReqStatus = 'draft' | 'submitted' | 'approved' | 'partial' | 'issued' | 'closed' | 'rejected' | 'cancelled';
export const REQ_STATUS: Record<ReqStatus, [string, string]> = {
  draft: ['', 'მონახაზი'], submitted: ['warn', 'დასამტკიცებელი'], approved: ['info', 'დამტკიცებული — გასაცემი'], partial: ['info', 'ნაწილობრივ გაცემული'],
  issued: ['ok', 'გაცემული'], closed: ['', 'დახურული'], rejected: ['danger', 'უარყოფილი'], cancelled: ['', 'გაუქმებული'],
};
export interface ReqRow {
  id: string; req_no: string | null; status: ReqStatus; urgent: boolean; requires_approval: boolean; created_at: string; submitted_at: string | null; approved_at: string | null;
  notes: string | null; from_location_id: string; to_location_id: string; from_name: string; to_name: string; created_by_name: string; lines: number; in_transit: number;
}
export interface ReqLine {
  id: string; line_no: number; item_id: string; pack_id: string | null; qty: string; qty_base: string; qty_approved: string | null; qty_issued: string; patient_id: string | null; notes: string | null;
  item_name: string; item_code: string; base_unit_name: string; pack_name: string | null; pack_qty_base: string | null; controlled_class: Controlled | null; patient_only: boolean | null;
  patient_name: string | null; patient_pn: string | null; available: string; on_hand_to: string;
}
export interface ReqDoc { id: string; doc_no: string; doc_type: string; posted_at: string; receive_status: 'received' | 'returned' | null; received_at: string | null; receive_note: string | null; received_by_name: string | null }
export interface StockRequest extends Omit<ReqRow, 'lines' | 'in_transit'> {
  from_kind: LocationKind; to_department_id: string | null; approved_by_name: string | null; rejected_by_name: string | null; reason: string | null; created_by: string;
  lines: ReqLine[]; docs: ReqDoc[];
}
export interface LotAvail { lot_id: string; lot_no: string | null; serial_no: string | null; expires_on: string | null; available?: string; qty?: string }
export interface PickLine { request_line_id: string; item_id: string; item_name: string; base_unit_name: string; remaining: number; shortage: number; lots: LotAvail[]; alloc: (LotAvail & { qty: number })[] }
export interface TransitRow {
  id: string; doc_no: string; doc_type: 'transfer' | 'return'; posted_at: string; notes: string | null; from_name: string; to_name: string; req_no: string | null; sent_by_name: string; lines: number; can_receive: boolean;
}
export const STOCK_ROLES = ['admin', 'storekeeper', 'stock_manager'] as const;
export const ISSUER_ROLES = ['admin', 'storekeeper', 'stock_manager', 'pharmacist'] as const;

// ---------------------------------------------------------------- 0033: ჩამოწერა, ხარჯი, ინვენტარიზაცია
export const WO_REASON_KA: Record<string, string> = { expired: 'ვადაგასული', damaged: 'დაზიანებული', lost: 'დაკარგული', department_use: 'განყოფილების ხარჯი', recall: 'გაწვევა (recall)', other: 'სხვა' };
export interface OpsRow {
  id: string; doc_no: string | null; status: DocStatus; doc_date: string; writeoff_reason: string | null; approval_status: 'pending' | 'approved' | 'rejected' | null; total_net: string;
  notes: string | null; created_at: string; reversed_by: string | null; reversed_by_no: string | null; location_name: string; created_by_name: string; patient_name: string | null; lines: number;
}
export interface OpsDoc extends Omit<OpsRow, 'lines'> {
  location_id: string; approved_at: string | null; approved_by_name: string | null; reason: string | null; patient_id: string | null; encounter_id: string | null; patient_pn: string | null;
  posted_at: string | null; created_by: string;
  lines: { id: string; line_no: number; item_id: string; qty_base: string; lot_no: string | null; serial_no: string | null; expires_on: string | null; unit_cost: string | null; line_net: string | null;
    sale_price: string | null; notes: string | null; item_name: string; item_code: string; base_unit_name: string; invoiced: boolean }[];
  warnings?: string[];
}
export type CountStatus = 'open' | 'counted' | 'approved' | 'cancelled';
export const COUNT_STATUS: Record<CountStatus, [string, string]> = { open: ['warn', 'მიმდინარე — ლოკაცია დაბლოკილია'], counted: ['info', 'დათვლილი — დასამტკიცებელი'], approved: ['ok', 'დამტკიცებული'], cancelled: ['', 'გაუქმებული'] };
export interface CountRow {
  id: string; count_no: string; status: CountStatus; blind: boolean; started_at: string; submitted_at: string | null; approved_at: string | null; location_name: string; category_name: string | null;
  adjustment_no: string | null; started_by_name: string; lines: number; counted: number;
}
export interface CountLine {
  id: string; item_id: string; lot_id: string | null; lot_no: string | null; serial_no: string | null; expires_on: string | null; expected_qty: string | null; counted_qty: string | null;
  counted_at: string | null; is_extra: boolean; note: string | null; item_name: string; item_code: string; base_unit_name: string; counted_by_name: string | null; diff: number | null; diff_value: number | null;
}
export interface StockCount extends Omit<CountRow, 'lines' | 'counted'> {
  location_id: string; category_id: string | null; notes: string | null; reason: string | null; approved_by_name: string | null; can_approve: boolean;
  lines: CountLine[]; totals: { shortage: number; surplus: number; lines_diff: number } | null;
}

// ---------------------------------------------------------------- 0034: ლოტები / გაწვევა, მინ/მაქს, რეპორტები
export type LotStatus = 'active' | 'quarantine' | 'recalled';
export const LOT_STATUS_KA: Record<LotStatus, [string, string]> = { active: ['ok', 'აქტიური'], quarantine: ['warn', 'ქარანტინი'], recalled: ['danger', 'გაწვეული'] };
export interface LotRow { id: string; lot_no: string | null; serial_no: string | null; expires_on: string | null; status: LotStatus; status_reason: string | null; item_id: string; item_name: string; item_code: string; inn: string | null; qty: string; patients: number }
export interface LotTrace {
  lot: { id: string; lot_no: string | null; serial_no: string | null; expires_on: string | null; status: LotStatus; status_reason: string | null; unit_cost: string; received_qty: string; created_at: string;
    item_name: string; item_code: string; base_unit_name: string; supplier_name: string | null; inn: string | null; controlled_class: Controlled | null };
  locations: { id: string; name: string; kind: LocationKind; qty: string }[];
  patients: { patient_id: string; patient_name: string; personal_number: string | null; phone_number: string | null; qty: string; last_at: string; locations: string }[];
  events: { id: string; from_status: LotStatus; to_status: LotStatus; reason: string; reference: string | null; created_at: string; user_name: string }[];
  moves: { id: string; created_at: string; move_type: string; qty: string; doc_no: string | null; doc_type: string; location_name: string }[];
}
export interface MinmaxRow {
  location_id: string; item_id: string; min_qty: string; max_qty: string; item_name: string; item_code: string; item_active: boolean; base_unit_name: string; location_name: string;
  default_source_id: string | null; on_hand: string; in_transit: string; requested: string; below: boolean; suggested: number;
}
/** CSV ჩამოტვირთვა (Excel-ისთვის — UTF-8 BOM, „;“) */
export const downloadCsv = (name: string, head: string[], rows: (string | number | null | undefined)[][]) => {
  const esc = (v: string | number | null | undefined) => { const s = v === null || v === undefined ? '' : String(v); return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const blob = new Blob(['\ufeff' + [head, ...rows].map((r) => r.map(esc).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
};
