import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../database/db';

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

export const LINE_CATEGORIES = ['bed', 'ventilation', 'service', 'consult', 'lab', 'radiology', 'endoscopy', 'medication', 'supply', 'implant', 'package', 'other'] as const;
export const CATEGORY_KA: Record<string, string> = {
  bed: 'საწოლდღე', ventilation: 'ხელოვნური ვენტილაცია', service: 'მომსახურება', consult: 'კონსულტაცია', lab: 'ლაბორატორია', radiology: 'რადიოლოგია', endoscopy: 'ენდოსკოპია',
  medication: 'მედიკამენტები', supply: 'სამედიცინო მასალა', implant: 'იმპლანტები', package: 'პაკეტი', other: 'სხვა',
};
export const PAYER_KIND_KA: Record<string, string> = { insurance: 'დაზღვევა', state: 'სახელმწიფო პროგრამა', other: 'სხვა' };
export const MODE_KA: Record<string, string> = { percent: 'პროცენტი', fixed: 'ფიქსირებული თანხა', drg: 'DRG' };

export interface CalcLine { id: string; category: string; line_total: number; package_included: boolean }
export interface CalcPayer {
  id: string; payer_id: string; kind: string; mode: string; coverage_pct: number; limit_amount: number | null; deductible: number; fixed_amount: number | null;
  drg_weight: number | null; drg_base_rate: number | null; writeoff_excess: boolean; excluded_categories: string[]; override_amount: number | null;
}
export interface PayerResult { id: string; payer_id: string; kind: string; tariff: number | null; eligible: number; amount: number; writeoff: number }
export interface SplitResult { total: number; payers: PayerResult[]; writeoff: number; insurance: number; state: number; patient: number }

export function split(lines: CalcLine[], payers: CalcPayer[]): SplitResult {
  const rem = new Map<string, number>();
  const cat = new Map<string, string>();
  for (const l of lines) if (!l.package_included) { rem.set(l.id, l.line_total); cat.set(l.id, l.category); }
  const total = r2([...rem.values()].reduce((s, v) => s + v, 0));
  const take = (ids: string[], amount: number) => {   // proportional reduction of remaining amounts
    const base = ids.reduce((s, id) => s + rem.get(id)!, 0);
    if (base <= 0 || amount <= 0) return;
    let left = amount;
    ids.forEach((id, i) => {
      const v = rem.get(id)!;
      const part = i === ids.length - 1 ? Math.min(v, left) : Math.min(v, r2((v / base) * amount));
      rem.set(id, r2(v - part)); left = r2(left - part);
    });
  };
  const out: PayerResult[] = [];
  let writeoff = 0;
  for (const p of payers) {
    const ids = [...rem.keys()].filter((id) => !p.excluded_categories.includes(cat.get(id)!) && rem.get(id)! > 0);
    const eligible = r2(ids.reduce((s, id) => s + rem.get(id)!, 0));
    let amount = 0; let wo = 0; let tariff: number | null = null;
    if (p.mode === 'fixed' || p.mode === 'drg') {
      tariff = r2(p.mode === 'drg' ? (p.drg_weight ?? 0) * (p.drg_base_rate ?? 0) : (p.fixed_amount ?? 0));
      amount = Math.min(r2(tariff * p.coverage_pct / 100), eligible);
      if (p.writeoff_excess && eligible > tariff) wo = r2(eligible - tariff);
    } else {
      amount = r2(Math.max(eligible - p.deductible, 0) * p.coverage_pct / 100);
      if (p.limit_amount !== null) amount = Math.min(amount, p.limit_amount);
    }
    if (p.override_amount !== null) amount = Math.min(p.override_amount, eligible);
    amount = r2(amount);
    wo = r2(Math.min(wo, eligible - amount));
    take(ids, r2(amount + wo));
    writeoff = r2(writeoff + wo);
    out.push({ id: p.id, payer_id: p.payer_id, kind: p.kind, tariff, eligible, amount, writeoff: wo });
  }
  const insurance = r2(out.filter((x) => x.kind !== 'state').reduce((s, x) => s + x.amount, 0));
  const state = r2(out.filter((x) => x.kind === 'state').reduce((s, x) => s + x.amount, 0));
  return { total, payers: out, writeoff, insurance, state, patient: r2(Math.max(total - insurance - state - writeoff, 0)) };
}

/** ჰოსპიტალიზაციის ფინანსური მდგომარეობა: ხაზები, გადამხდელები (აქტიური), გაანგარიშება, ავანსი, გადახდები */
export async function loadBilling(ex: Ex, encounterId: string) {
  const inv = await ex.selectFrom('invoices').selectAll().where('encounter_id', '=', encounterId).executeTakeFirst();
  if (!inv) return null;
  const lines = await ex.selectFrom('invoice_line_items').select(['id', 'category', 'line_total', 'package_included']).where('invoice_id', '=', inv.id).execute();
  const payers = await ex.selectFrom('stay_payers as sp').innerJoin('payers as p', 'p.id', 'sp.payer_id')
    .select(['sp.id', 'sp.payer_id', 'p.kind', 'sp.mode', 'sp.coverage_pct', 'sp.limit_amount', 'sp.deductible', 'sp.fixed_amount', 'sp.drg_weight', 'sp.drg_base_rate',
      'sp.writeoff_excess', 'sp.excluded_categories', 'sp.override_amount'])
    .where('sp.encounter_id', '=', encounterId).where('sp.status', '=', 'active').orderBy('sp.seq').execute();
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const res = split(lines.map((l) => ({ id: l.id, category: l.category, line_total: Number(l.line_total), package_included: l.package_included })),
    payers.map((p) => ({ id: p.id, payer_id: p.payer_id, kind: p.kind, mode: p.mode, coverage_pct: Number(p.coverage_pct), limit_amount: n(p.limit_amount), deductible: Number(p.deductible),
      fixed_amount: n(p.fixed_amount), drg_weight: n(p.drg_weight), drg_base_rate: n(p.drg_base_rate), writeoff_excess: p.writeoff_excess, excluded_categories: p.excluded_categories ?? [],
      override_amount: n(p.override_amount) })));
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
