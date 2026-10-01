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
export interface StockSettings { costing_method: 'fifo' | 'average'; short_expiry_months: number; updated_at: string }
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
export type LocationKind = 'central' | 'pharmacy' | 'household' | 'department' | 'operating' | 'cssd' | 'lab' | 'icu' | 'other';
export interface StockLocation {
  id: string; code: string; name: string; kind: LocationKind; department_id: string | null; department_name: string | null;
  requires_approval: boolean; is_active: boolean; sort_order: number;
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
  cssd: 'სტერილიზაცია (CSSD)', lab: 'ლაბორატორია', icu: 'რეანიმაცია / ინტენსიური', other: 'სხვა',
};
export const DOSE_UNITS = ['mg', 'mcg', 'g', 'IU', 'ml', 'mmol', 'mEq'] as const;
export const COSTING_KA: Record<StockSettings['costing_method'], string> = { fifo: 'ლოტის ფასი (FIFO)', average: 'საშუალო შეწონილი' };

export const useStockRefs = () => useQuery({ queryKey: ['stock-refs'], queryFn: () => api<StockRefs>('/stock/refs'), staleTime: 60_000 });
export const genericLabel = (g: Pick<MedGeneric, 'inn' | 'strength' | 'form_name'>) => `${g.inn}${g.strength ? ` ${g.strength}` : ''} — ${g.form_name}`;
export const qtyFmt = (v: number | string) => { const n = Number(v); return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3))); };
/** ცარიელი სტრიქონი → null (PATCH-ისთვის) */
export const nul = (s: string) => (s.trim() ? s.trim() : null);
