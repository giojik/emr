import type { Kysely } from 'kysely';
import type { Role } from '../auth/roles';
import type { DB } from '../database/db';

/** ფინანსების პარამეტრები (0053) — system_modules.finance */
export interface FinRules {
  enabled: boolean;
  /** მარაგის ხარჯი განყოფილებაზე: ფაქტობრივი მოხმარება ქვესაწყობიდან / გაცემა განყოფილების ლოკაციაზე */
  dept_consumption_basis: 'consumption' | 'issue';
  /** შემოსავლის თარიღი: მომსახურების დღე / ინვოისის (ამბ.) ან ფინალიზაციის (სტაც.) თარიღი */
  revenue_basis: 'service_date' | 'finalized';
  /** რეპორტის ნაგულისხმევი: შემსრულებელი / დამნიშნავი განყოფილება */
  revenue_dept_basis: 'performing' | 'ordering';
  /** ლაბ. / რადიოლოგია / ენდოსკოპია → შემსრულებელი განყოფილება (null — დამნიშნავი) */
  dx_performing_dept: Record<'lab' | 'radiology' | 'endoscopy', string | null>;
  /** ამბულატორია: დაზღვევის / სახელმწიფოს წილი გადამხდელის მითითების გარეშე — 400 */
  opd_payer_required: boolean;
  claim_overdue_alert: boolean;
  overhead_allocation: 'none' | 'revenue' | 'bed_days' | 'manual';
  /** manual: განყოფილება → % (ჯამი 100) */
  overhead_manual: Record<string, number>;
  period_lock: 'on' | 'off';
  /** განყოფილების ხელმძღვანელი (მენეჯერი) ხედავს თავისი განყოფილების ფინანსებს */
  dept_finance_visible: 'heads' | 'off';
}
export const FIN_RULES_DEFAULT: Omit<FinRules, 'enabled'> = {
  dept_consumption_basis: 'consumption', revenue_basis: 'service_date', revenue_dept_basis: 'performing',
  dx_performing_dept: { lab: null, radiology: null, endoscopy: null }, opd_payer_required: false, claim_overdue_alert: true,
  overhead_allocation: 'none', overhead_manual: {}, period_lock: 'off', dept_finance_visible: 'heads',
};
export async function finRules(db: Kysely<DB>): Promise<FinRules> {
  const m = await db.selectFrom('system_modules').select(['enabled', 'settings']).where('code', '=', 'finance').executeTakeFirst();
  return { ...FIN_RULES_DEFAULT, ...((m?.settings ?? {}) as Partial<FinRules>), enabled: !!m?.enabled };
}

/** ფინანსების რეპორტები (შემოსავალი, მარაგი, განყოფილების შედეგი); manager — თავისი განყოფილება (dept_finance_visible = heads) */
export const FIN_READ: Role[] = ['admin', 'accountant', 'viewer', 'manager'];
/** მთელი კლინიკის ფინანსური მონაცემები (დებიტორები, პერიოდები, მარაგის ღირებულება ლოკაციებით) */
export const FIN_FULL: Role[] = ['admin', 'accountant', 'viewer'];
/** ქლეიმები, პერიოდის დახურვა / გახსნა */
export const FIN_EDIT: Role[] = ['admin', 'accountant'];
/** ქლეიმის უარის / დანაკლისის გადაწყვეტა (პაციენტზე / ჩამოწერა) */
export const CLAIM_RESOLVE: Role[] = ['admin', 'accountant', 'billing'];
/** ამბულატორიის ინვოისის გადამხდელი / წილი */
export const OPD_PAYER_EDIT: Role[] = ['admin', 'billing', 'receptionist'];

export const PAYER_KIND_KA: Record<string, string> = {
  patient: 'პაციენტი', insurance: 'დაზღვევა', state: 'სახელმწიფო', other: 'სხვა გადამხდელი', writeoff: 'ჩამოწერა (DRG / ფიქს.)',
  denied: 'უარი — ჩამოწერილი', undetermined: 'განუსაზღვრელი (არ არის ფინალიზებული)',
};
