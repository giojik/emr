import type { Kysely } from 'kysely';
import type { Role } from '../auth/roles';
import type { DB } from '../database/db';

/** შესყიდვების პარამეტრები (0051) — system_modules.procurement; გამორთულ მოდულზე po_mode = off (მიღება — 0031-ის ქცევა) */
export interface ProcRules {
  enabled: boolean;
  po_mode: 'off' | 'optional' | 'required';
  pr_approval_levels: 1 | 2;
  pr_finance_threshold: number;
  controlled_pharmacist: boolean;
  price_tolerance_pct: number;
  qty_over_delivery: 'warn' | 'block';
  po_overdue_alert: boolean;
}
export const PROC_RULES_DEFAULT: Omit<ProcRules, 'enabled'> = {
  po_mode: 'optional', pr_approval_levels: 2, pr_finance_threshold: 1000, controlled_pharmacist: true, price_tolerance_pct: 5, qty_over_delivery: 'warn', po_overdue_alert: true,
};
export async function procRules(db: Kysely<DB>): Promise<ProcRules> {
  const m = await db.selectFrom('system_modules').select(['enabled', 'settings']).where('code', '=', 'procurement').executeTakeFirst();
  const r = { ...PROC_RULES_DEFAULT, ...((m?.settings ?? {}) as Partial<ProcRules>), enabled: !!m?.enabled };
  if (!r.enabled) r.po_mode = 'off';
  return r;
}

/** ნახვა: შესყიდვების გვერდი */
export const PROC_READ: Role[] = ['admin', 'procurement', 'procurement_approve', 'stock_manager', 'storekeeper', 'pharmacist', 'accountant', 'manager', 'viewer'];
/** შესყიდვის მოთხოვნის (PR) შექმნა */
export const PR_EDIT: Role[] = ['admin', 'procurement', 'stock_manager', 'storekeeper', 'pharmacist'];
/** შეკვეთა მომწოდებელთან (PO), PR → PO, ფასთა ნუსხა */
export const PO_EDIT: Role[] = ['admin', 'procurement', 'stock_manager'];
/** PR-ის დამტკიცების ნებისმიერი დონე */
export const PR_APPROVE: Role[] = ['admin', 'stock_manager', 'procurement_approve', 'pharmacist'];
/** კონტროლირებადი კლასები, რომლებზეც ფარმაცევტის დადასტურებაა საჭირო */
export const PROC_CONTROLLED = ['narcotic', 'psychotropic'];
