import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';

/**
 * მოდულები და პარამეტრები (0037; 0085 — ლიცენზია + დამოკიდებულებები).
 * `enabled` frontend-ში = მოდული გამოსაყენებელია (active ან read_only — ლიცენზიის ვადის შემდეგ ნახვა); ადმინის ჩამრთველი — `admin_enabled`.
 */
export type ModuleState = 'active' | 'read_only' | 'disabled' | 'not_licensed' | 'missing_prereq';
export type ModuleGroup = 'core' | 'clinical' | 'diagnostics' | 'logistics' | 'finance' | 'management';
export interface SystemModule {
  code: string; name: string; description: string | null; enabled: boolean; admin_enabled: boolean; can_disable: boolean; is_core: boolean; settings: Record<string, unknown>;
  sort_order: number; updated_at: string; group: ModuleGroup | null; core: boolean; hard: string[]; soft: string[]; settings_of: string | null; dependents: string[];
  state: ModuleState; active: boolean; licensed: boolean; missing: string[];
}
type RawModule = Omit<SystemModule, 'admin_enabled'>;
export const fetchModules = () => api<RawModule[]>('/modules').then((rows) => rows.map((r) => ({ ...r, admin_enabled: r.enabled, enabled: r.state === 'active' || r.state === 'read_only' })));
/** 0086: მხოლოდ შესულ მომხმარებელზე (შესვლის / პაროლის შეცვლის გვერდზე მოთხოვნა არ იგზავნება) */
export const useModules = () => {
  const { user } = useAuth();
  return useQuery({ queryKey: ['modules'], queryFn: fetchModules, staleTime: 5 * 60_000, enabled: !!user && !user.mustChangePassword });
};
export const useModuleEnabled = (code: string) => { const q = useModules(); return q.data?.find((m) => m.code === code)?.enabled ?? false; };
/** ახალი ჩანაწერის შექმნა დაშვებულია (ლიცენზიის ვადის შემდეგ — მხოლოდ ნახვა) */
export const useModuleWritable = (code: string) => { const q = useModules(); return q.data?.find((m) => m.code === code)?.active ?? false; };
export const STATE_KA: Record<ModuleState, string> = {
  active: 'აქტიურია', read_only: 'მხოლოდ წაკითხვა (ლიცენზიის ვადა)', disabled: 'გამორთულია', not_licensed: 'ლიცენზიაში არ შედის', missing_prereq: 'წინაპირობა აკლია',
};
export const GROUP_KA: Record<ModuleGroup, string> = { core: 'ბირთვი', clinical: 'კლინიკა', diagnostics: 'დიაგნოსტიკა', logistics: 'ლოჯისტიკა', finance: 'ფინანსები', management: 'მართვა' };

/** ლიცენზიის სტატუსი (0085) — ბანერი / ადმინის გვერდი */
export interface LicenseStatus {
  mode: 'dev' | 'licensed' | 'none'; phase: 'valid' | 'warning' | 'grace' | 'expired' | null; banner: 'none' | 'admins' | 'all';
  expires: string | null; days_left: number | null; grace_until: string | null;
  install_id?: string; clinic?: string | null; kid?: string | null; modules?: string[] | 'all'; unknown_modules?: string[]; issued?: string | null; expires_at?: string | null;
  max_users?: number | null; users_active?: number; users_warn?: boolean; uploaded_at?: string | null; test_key?: boolean; now?: string;
}
export const useLicenseStatus = (on = true) => useQuery({ queryKey: ['license-status'], queryFn: () => api<LicenseStatus>('/license/status'), staleTime: 10 * 60_000, enabled: on });

/** საწყობის წესები (0038) — ნაგულისხმევი = 0030–0036-ის ქცევა */
export interface StockRules {
  issue_mode: 'two_step' | 'one_step'; witness_classes: string[]; empty_return_classes: string[]; dose_required: boolean; count_lock: boolean; count_blind_default: boolean;
  pharmacist_scope: 'pharmacy' | 'any'; lost_requires_approval: boolean; alert_expiry: boolean; alert_minmax: boolean; alert_lab: boolean;
}
export const STOCK_RULES_DEFAULT: StockRules = {
  issue_mode: 'two_step', witness_classes: ['narcotic', 'psychotropic'], empty_return_classes: ['narcotic'], dose_required: true, count_lock: true, count_blind_default: true,
  pharmacist_scope: 'pharmacy', lost_requires_approval: true, alert_expiry: true, alert_minmax: true, alert_lab: true,
};
/** შესყიდვების პარამეტრები (0051) */
export interface ProcRules {
  po_mode: 'off' | 'optional' | 'required'; pr_approval_levels: 1 | 2; pr_finance_threshold: number; controlled_pharmacist: boolean;
  price_tolerance_pct: number; qty_over_delivery: 'warn' | 'block'; po_overdue_alert: boolean;
  invoice_match: 'off' | 'rc' | 'three_way'; match_tolerance: number; expense_recognition: 'on_invoice' | 'on_payment'; ap_due_alert: boolean; ap_due_days: number;
}
export const PROC_RULES_DEFAULT: ProcRules = { po_mode: 'optional', pr_approval_levels: 2, pr_finance_threshold: 1000, controlled_pharmacist: true, price_tolerance_pct: 5, qty_over_delivery: 'warn', po_overdue_alert: true,
  invoice_match: 'rc', match_tolerance: 1, expense_recognition: 'on_invoice', ap_due_alert: true, ap_due_days: 3 };
/** null — მოდული გამორთულია (PO-ს რეჟიმი ფაქტობრივად off) */
export const useProcRules = (): ProcRules | null => {
  const q = useModules(); const m = q.data?.find((x) => x.code === 'procurement');
  return m?.enabled ? { ...PROC_RULES_DEFAULT, ...(m.settings as Partial<ProcRules>) } : null;
};
export const useStockRules = (): StockRules => {
  const q = useModules();
  return { ...STOCK_RULES_DEFAULT, ...((q.data?.find((m) => m.code === 'stock')?.settings ?? {}) as Partial<StockRules>) };
};
