import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../database/db';
import { split } from '../tariffs/payer-engine';
import { calcLines, patientCtx, versionRules } from '../tariffs/payer-shares';

/**
 * სტაციონარის ბილინგის გაანგარიშება (0046) — სუფთა ფუნქციები, გამოიყენება API-ში, გაწერის შემოწმებაში და worker-ში.
 *
 * გადამხდელები (seq-ის მიხედვით, თანმიმდევრობით), თითოეულს — მისი „დასაფარი“ ხაზები (გამორიცხული კატეგორიების გარდა), დარჩენილი ნაშთიდან:
 *   percent — (დასაფარი − ფრანშიზა) × % , ლიმიტამდე;
 *   fixed / drg — ტარიფი (fixed_amount ან წონა × საბაზისო განაკვეთი) × %, დასაფარამდე;
 *                 writeoff_excess: (დასაფარი − ტარიფი) ჩამოიწერება (პაციენტს არ ეკისრება); პაციენტს რჩება მხოლოდ თანაგადახდა (ტარიფი − გადამხდელის წილი);
 *   override_amount — ბილინგის ხელით (მიზეზით), დასაფარამდე.
 * პაციენტის წილი = ჯამი − გადამხდელები − ჩამოწერა.
 */
type Ex = Kysely<DB> | Transaction<DB>;
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export const LINE_CATEGORIES = ['bed', 'ventilation', 'surgery', 'anesthesia', 'service', 'consult', 'lab', 'radiology', 'endoscopy', 'medication', 'supply', 'implant', 'package', 'other'] as const;
export const CATEGORY_KA: Record<string, string> = {
  bed: 'საწოლდღე', ventilation: 'ხელოვნური ვენტილაცია', surgery: 'ოპერაცია', anesthesia: 'ანესთეზია', service: 'მომსახურება', consult: 'კონსულტაცია', lab: 'ლაბორატორია', radiology: 'რადიოლოგია', endoscopy: 'ენდოსკოპია',
  medication: 'მედიკამენტები', supply: 'სამედიცინო მასალა', implant: 'იმპლანტები', package: 'პაკეტი', other: 'სხვა',
};
export const PAYER_KIND_KA: Record<string, string> = { insurance: 'დაზღვევა', state: 'სახელმწიფო პროგრამა', other: 'სხვა' };
export const MODE_KA: Record<string, string> = { percent: 'პროცენტი', fixed: 'ფიქსირებული თანხა', drg: 'DRG' };

// 0054: ძრავა — საერთო ფენაში (tariffs/payer-engine.ts); აქ — ხელახალი ექსპორტი (თავსებადობა)
export { split } from '../tariffs/payer-engine';
export type { CalcLine, CalcPayer, PayerResult, SplitResult } from '../tariffs/payer-engine';

/** ჰოსპიტალიზაციის ფინანსური მდგომარეობა: ხაზები, გადამხდელები (აქტიური), გაანგარიშება, ავანსი, გადახდები */
export async function loadBilling(ex: Ex, encounterId: string) {
  const inv = await ex.selectFrom('invoices').selectAll().where('encounter_id', '=', encounterId).executeTakeFirst();
  if (!inv) return null;
  const lines = await calcLines(ex, inv.id);
  const payers = await ex.selectFrom('stay_payers as sp').innerJoin('payers as p', 'p.id', 'sp.payer_id')
    .select(['sp.id', 'sp.payer_id', 'p.kind', 'sp.mode', 'sp.coverage_pct', 'sp.limit_amount', 'sp.deductible', 'sp.fixed_amount', 'sp.drg_weight', 'sp.drg_base_rate',
      'sp.writeoff_excess', 'sp.excluded_categories', 'sp.override_amount', 'sp.rule_version_id'])
    .where('sp.encounter_id', '=', encounterId).where('sp.status', '=', 'active').orderBy('sp.seq').execute();
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  // 0054a: ვერსიის პუნქტები / გამორიცხული კოდები / თანაგადახდა; პაციენტის კონტექსტი — მიღების დღეს
  const vr = await versionRules(ex, payers.map((p) => p.rule_version_id));
  const adm = (await sql<{ d: string }>`SELECT to_char(fin_local_date(admitted_at), 'YYYY-MM-DD') AS d FROM inpatient_stays WHERE encounter_id = ${encounterId}`.execute(ex)).rows[0]?.d
    ?? new Date().toISOString().slice(0, 10);
  const ctx = vr.size && [...vr.values()].some((r) => r.clauses.length) ? await patientCtx(ex, encounterId, adm) : undefined;
  const res = split(lines,
    payers.map((p) => ({ id: p.id, payer_id: p.payer_id, kind: p.kind, mode: p.mode, coverage_pct: Number(p.coverage_pct), limit_amount: n(p.limit_amount), deductible: Number(p.deductible),
      fixed_amount: n(p.fixed_amount), drg_weight: n(p.drg_weight), drg_base_rate: n(p.drg_base_rate), writeoff_excess: p.writeoff_excess, excluded_categories: p.excluded_categories ?? [],
      override_amount: n(p.override_amount), ...(p.rule_version_id ? vr.get(p.rule_version_id) : {}) })), ctx);
  const dep = (await sql<{ deposits: string; refunds: string }>`SELECT coalesce(sum(amount) FILTER (WHERE kind = 'deposit'), 0) AS deposits,
      coalesce(sum(amount) FILTER (WHERE kind = 'refund'), 0) AS refunds FROM stay_deposits WHERE encounter_id = ${encounterId} AND voided_at IS NULL`.execute(ex)).rows[0];
  const pay = (await sql<{ applied: string; paid: string }>`SELECT coalesce(sum(amount) FILTER (WHERE method = 'deposit'), 0) AS applied,
      coalesce(sum(amount) FILTER (WHERE method <> 'deposit'), 0) AS paid FROM payments WHERE invoice_id = ${inv.id}`.execute(ex)).rows[0];
  const deposits = Number(dep.deposits); const refunds = Number(dep.refunds); const applied = Number(pay.applied); const paid = Number(pay.paid);
  const depositNet = r2(deposits - refunds);
  const finalized = !!inv.finalized_at;
  // ფინალიზებულზე — დაფიქსირებული წილები; სხვა შემთხვევაში — მიმდინარე გაანგარიშება
  const patient = finalized ? Number(inv.patient_share) : res.patient;
  const covered = r2(paid + (finalized ? applied : Math.min(depositNet, patient)));
  return {
    invoice: inv, calc: res, finalized,
    money: {
      total: finalized ? Number(inv.total_amount) : res.total, insurance: finalized ? Number(inv.insurance_share) : res.insurance, state: finalized ? Number(inv.state_share) : res.state,
      writeoff: finalized ? Number(inv.writeoff_amount) : res.writeoff, patient, deposits, refunds, deposit_net: depositNet, deposit_applied: applied,
      deposit_unapplied: r2(depositNet - applied), paid, due: r2(Math.max(patient - covered, 0)),
      refund_due: finalized ? r2(Math.max(depositNet - applied, 0)) : 0,
      surplus: finalized ? 0 : r2(Math.max(depositNet + paid - patient, 0)),   // ფინალიზაციამდე: ავანსის ნაშთი (შეფასებით)
    },
  };
}
