import type { Kysely } from 'kysely';
import type { Role } from '../auth/roles';
import type { DB } from '../database/db';

/** სატარიფო ფენის პარამეტრები (0054) — system_modules.tariffs (მოდული არ ითიშება) */
export interface TariffRules {
  /** ფასის / წესის ცვლილება: off — მაშინვე; required — მეორე პირის დამტკიცებით (tariffs_approve / admin, არა ავტორი) */
  tariff_change_approval: 'off' | 'required';
  /** ამბულატორიის გადამხდელის წილი: manual — ხელით (სალარო); rules — გადამხდელის წესებით (იგივე ძრავა, რაც სტაციონარში) */
  opd_payer_mode: 'manual' | 'rules';
  /** ხაზის ფასი: primary — ძირითადი გადამხდელის ხელშეკრულების ფასი (თუ აქვს); off — მხოლოდ განყოფილება / საბაზო */
  payer_price_mode: 'primary' | 'off';
  /** გადამხდელის ცვლილებისას ხაზების გადაფასება: auto_unpaid — ავტომატურად, თუ გადახდა არ არის; manual — ღილაკით */
  reprice_on_payer_change: 'auto_unpaid' | 'manual';
}
export const TARIFF_RULES_DEFAULT: TariffRules = {
  tariff_change_approval: 'off', opd_payer_mode: 'manual', payer_price_mode: 'primary', reprice_on_payer_change: 'auto_unpaid',
};
export async function tariffRules(db: Kysely<DB>): Promise<TariffRules> {
  const m = await db.selectFrom('system_modules').select('settings').where('code', '=', 'tariffs').executeTakeFirst();
  return { ...TARIFF_RULES_DEFAULT, ...((m?.settings ?? {}) as Partial<TariffRules>) };
}

/** ნუსხების / წესების ნახვა */
export const TARIFF_READ: Role[] = ['admin', 'billing', 'tariffs', 'tariffs_approve', 'accountant', 'viewer'];
/** ცვლილების მოთხოვნა (ფასი / წესი), ნუსხის შექმნა; ბილინგი — როგორც 0054-მდე (ტარიფები) */
export const TARIFF_EDIT: Role[] = ['admin', 'tariffs', 'billing'];
/** დამტკიცება (tariff_change_approval = required) — არა ავტორი */
export const TARIFF_APPROVE: Role[] = ['admin', 'tariffs_approve'];
/** ხაზის გადაფასება / ამბ. წილის გადათვლა */
export const REPRICE: Role[] = ['admin', 'billing'];

export const SCOPE_KA: Record<string, string> = { base: 'საბაზო', department: 'განყოფილება', payer: 'გადამხდელი' };
export const KIND_KA: Record<string, string> = { tariff: 'მომსახურება', stock_item: 'საქონელი', stock_category: 'საქონლის კატეგორია (ფასნამატი)' };
