import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../database/db';
import type { ModulesService } from './modules';

/**
 * ModulesService-ის მიმართვა DI-ს გარეშე ფუნქციებისთვის (worklist-common და სხვ.) — ModulesService თავად აყენებს.
 * არ არის (CLI / სკრიპტი) — გამომძახებელი ბაზის enabled-ს იყენებს.
 */
export const modulesRef: { svc?: ModulesService } = {};

type Ex = Kysely<DB> | Transaction<DB>;

/**
 * 0086 (A): აქტიურობის ერთი წყარო. მოდულის ჩართულობა `system_modules.enabled`-დან პირდაპირ აღარ იკითხება (lint: scripts/check-module-reads.sh) —
 * მხოლოდ ამ ფუნქციებით (ლიცენზია ∧ ადმინის ჩამრთველი ∧ მკაცრი წინაპირობები ∧ ვადა; ქეში 30 წმ + NOTIFY emr_modules).
 *
 *  • modActive — მოდული სრულად მუშაობს: რბილი კავშირის **მოქმედება** (ახალი ჩანაწერი, ნაბიჯი, შეტყობინება, ჯობი);
 *  • modUsable — active ∨ read_only (ლიცენზიის ვადა): **ჩვენება / წაკითხვა** (ძველი მონაცემი, ანგარიში, ETL, საკუთარი GET).
 *
 * ModulesService-ის გარეშე (CLI) — ბაზის enabled (fallback; ლიცენზიას / წინაპირობას ვერ ხედავს).
 */
export async function modActive(ex: Ex, code: string): Promise<boolean> {
  const svc = modulesRef.svc;
  if (svc) return svc.isActive(code).catch(() => false);
  return dbEnabled(ex, code);
}
export async function modUsable(ex: Ex, code: string): Promise<boolean> {
  const svc = modulesRef.svc;
  if (svc) return svc.isUsable(code).catch(() => false);
  return dbEnabled(ex, code);
}
/** რამდენიმე კოდი ერთად (ერთი snapshot) — { code: active } */
export async function modActiveMap(ex: Ex, codes: string[]): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  for (const c of codes) out[c] = await modActive(ex, c);
  return out;
}
/** აქტიური ოპციური + ბირთვის კოდები (ერთი snapshot); სერვისის გარეშე — ბაზის enabled */
export async function activeCodes(ex: Ex): Promise<string[]> {
  const svc = modulesRef.svc;
  if (svc) return [...(await svc.snapshot()).states.values()].filter((x) => x.active).map((x) => x.code);
  return (await ex.selectFrom('system_modules').select('code').where('enabled', '=', true).execute()).map((x) => x.code);
}
async function dbEnabled(ex: Ex, code: string) {
  return !!(await ex.selectFrom('system_modules').select('enabled').where('code', '=', code).executeTakeFirst())?.enabled;
}
