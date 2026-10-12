import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

/** მოდულები და პარამეტრები (0037) — კლინიკის ადმინისტრატორი რთავს / თიშავს */
export interface SystemModule { code: string; name: string; description: string | null; enabled: boolean; can_disable: boolean; settings: Record<string, unknown>; sort_order: number; updated_at: string }
export const useModules = () => useQuery({ queryKey: ['modules'], queryFn: () => api<SystemModule[]>('/modules'), staleTime: 5 * 60_000 });
export const useModuleEnabled = (code: string) => { const q = useModules(); return q.data?.find((m) => m.code === code)?.enabled ?? false; };

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
