import type { Kysely } from 'kysely';
import type { DB } from '../database/db';

/** საწყობის წესები (0038) — system_modules.stock; ნაგულისხმევი = 0030–0036-ის ქცევა */
export interface StockRules {
  issue_mode: 'two_step' | 'one_step'; witness_classes: string[]; empty_return_classes: string[]; dose_required: boolean; count_lock: boolean; count_blind_default: boolean;
  pharmacist_scope: 'pharmacy' | 'any'; lost_requires_approval: boolean; alert_expiry: boolean; alert_minmax: boolean; alert_lab: boolean;
}
export const STOCK_RULES_DEFAULT: StockRules = {
  issue_mode: 'two_step', witness_classes: ['narcotic', 'psychotropic'], empty_return_classes: ['narcotic'], dose_required: true, count_lock: true, count_blind_default: true,
  pharmacist_scope: 'pharmacy', lost_requires_approval: true, alert_expiry: true, alert_minmax: true, alert_lab: true,
};
export const CONTROLLED_CLASSES = ['narcotic', 'psychotropic', 'precursor', 'potent'];
export async function stockRules(db: Kysely<DB>): Promise<StockRules> {
  const m = await db.selectFrom('system_modules').select('settings').where('code', '=', 'stock').executeTakeFirst();
  return { ...STOCK_RULES_DEFAULT, ...((m?.settings ?? {}) as Partial<StockRules>) };
}
