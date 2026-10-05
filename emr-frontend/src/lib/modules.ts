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
export const useStockRules = (): StockRules => {
  const q = useModules();
  return { ...STOCK_RULES_DEFAULT, ...((q.data?.find((m) => m.code === 'stock')?.settings ?? {}) as Partial<StockRules>) };
};
