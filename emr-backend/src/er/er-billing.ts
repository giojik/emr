import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, HttpCode, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Post, Put,
  Query, Req } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min } from 'class-validator';
import type { Request } from 'express';
import { sql, type Kysely, type Transaction } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser, type Role } from '../auth/roles';
import { applyOpdRules } from '../billing/payer-shares';
import { tariffRules } from '../billing/tariff-rules';
import { mapPgError } from '../common/pg-errors';
import { loadEnv } from '../config/env';
import { InjectDb, type Database } from '../database/database.module';
import type { DB } from '../database/db';
import { ClinicalHistory, RequireModule } from '../modules/module-guard';
import { modulesRef } from '../modules/modules-ref';
import { erClinicalSettings, type ErClinicalSettings } from './er-access';
import { ErJobsService } from './er-jobs';

/**
 * გადაუდებელი დახმარება (ER), 0091 — ბილინგი.
 *  • ER-ის ინვოისი იქმნება რეგისტრაციისას (0087) — ამბულატორიის ტიპის (გადამხდელი insurance_payer_id / state_payer_id, opd_payer_mode).
 *  • ტარიფი (fee_mode = visit / level / time; er_fee_rules): fee_at = departure — გამოსავლისას; doctor — ექიმის აყვანისას (time — მაინც გამოსავლისას).
 *    სინქრონიზაცია იდემპოტენტურია (erFeeSync): სასურველი ხაზები ↔ არსებული (er_fee_rule_id); ფინალიზებულ / ქლეიმში შემავალ ინვოისზე — არ იცვლება.
 *    fee_exempt — გამოსავლის სახეები ტარიფის გარეშე; admit_fee = exempt — ჰოსპიტალიზაციისას ტარიფი არ ერიცხება.
 *  • დახურვა (invoice_close): departure — გამოსავლისას (გადამხდელის წილი წესებით + finalized_at); doc_close — დოკუმენტაციის ფანჯრის ბოლოს (ჯობი);
 *    manual — ბილინგი / სალარო. გამოსავლის გაუქმება → ინვოისი იხსნება (ქლეიმში შემავალი — არა).
 *  • ჰოსპიტალიზაცია (admit_invoice = merge / ask): ER-ის ხაზები → სტაციონარის ინვოისი (moved_from_invoice_id), ER-ის ინვოისი — merged_into_invoice_id,
 *    ცარიელი და დახურული. ER-ის ინვოისზე გადახდა / ქლეიმი → გაერთიანება არ ხდება (ცალკე რჩება, info). სტაციონარში გაუქმება → ხაზები ბრუნდება.
 */
type Trx = Transaction<DB>;
type Ex = Kysely<DB> | Trx;
const TZ = loadEnv().CLINIC_TZ;
export const ER_BILLING_READ: Role[] = ['admin', 'billing', 'receptionist', 'accountant', 'er_triage', 'er_doctor', 'er_manage', 'manager', 'viewer'];
export const ER_BILLING_EDIT: Role[] = ['admin', 'billing'];
export const ER_FEE_RULES_EDIT: Role[] = ['admin', 'billing', 'tariffs', 'er_manage'];
const KINDS = ['visit', 'level', 'time_band', 'time_hour'] as const;
const fmtMin = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} სთ${m % 60 ? ` ${m % 60} წთ` : ''}` : `${m} წთ`);

interface FeeVisit {
  encounter_id: string; department_id: string; status: string; disposition: string | null; arrived_at: Date | string; ended_at: Date | string | null;
  doctor_at: Date | string | null; triage_scale: string | null; triage_level: number | null;
}
export interface FeeLine { rule_id: string; tariff_id: string; quantity: number; description: string; code: string; base_price: string }
interface RuleRow { id: string; kind: string; department_id: string | null; scale_code: string | null; level: number | null; from_min: number | null; to_min: number | null;
  tariff_id: string; code: string; title: string; base_price: string }

async function erVisit(ex: Ex, encounterId: string): Promise<FeeVisit | undefined> {
  return ex.selectFrom('er_visits').select(['encounter_id', 'department_id', 'status', 'disposition', 'arrived_at', 'ended_at', 'doctor_at', 'triage_scale', 'triage_level'])
    .where('encounter_id', '=', encounterId).executeTakeFirst();
}
async function rules(ex: Ex, departmentId: string): Promise<RuleRow[]> {
  const all = await ex.selectFrom('er_fee_rules as r').innerJoin('service_tariffs as t', 't.id', 'r.tariff_id')
    .select(['r.id', 'r.kind', 'r.department_id', 'r.scale_code', 'r.level', 'r.from_min', 'r.to_min', 'r.tariff_id', 't.code', 't.title', 't.base_price'])
    .where('r.is_active', '=', true).where('t.is_active', '=', true)
    .where((eb) => eb.or([eb('r.department_id', 'is', null), eb('r.department_id', '=', departmentId)])).execute();
  // განყოფილების საკუთარი წესები (სახის მიხედვით) ფარავს საერთოს
  const out: RuleRow[] = [];
  for (const k of KINDS) {
    const own = all.filter((r) => r.kind === k && r.department_id === departmentId);
    out.push(...(own.length ? own : all.filter((r) => r.kind === k && !r.department_id)));
  }
  return out;
}

/**
 * სასურველი ტარიფის ხაზები შემთხვევის ამჟამინდელი მდგომარეობით.
 * asDeparted — „წინასწარი ნახვა“: მიმდინარე შემთხვევა ისე, თითქოს ახლა გავიდა (kind — გამოსავლის სახე).
 */
export async function erFeeDesired(ex: Ex, encounterId: string, s: ErClinicalSettings, asDeparted?: { kind: string; at?: Date }): Promise<{ lines: FeeLine[]; note: string | null }> {
  const v = await erVisit(ex, encounterId);
  if (!v || v.status === 'cancelled' || s.fee_mode === 'none') return { lines: [], note: s.fee_mode === 'none' ? 'ტარიფი გამორთულია (fee_mode = none)' : null };
  const departed = !!asDeparted || v.status === 'departed';
  const kind = asDeparted?.kind ?? v.disposition;
  if (departed) {
    if (kind && s.fee_exempt.includes(kind)) return { lines: [], note: 'გამოსავლის ამ სახეზე ტარიფი არ ერიცხება (fee_exempt)' };
    if (kind === 'admitted' && s.admit_fee === 'exempt') return { lines: [], note: 'ჰოსპიტალიზაციისას ტარიფი არ ერიცხება (admit_fee = exempt)' };
  } else if (!(s.fee_at === 'doctor' && v.doctor_at && s.fee_mode !== 'time')) {
    return { lines: [], note: s.fee_mode === 'time' ? 'ტარიფი — გამოსავლისას (ხანგრძლივობით)' : s.fee_at === 'doctor' ? 'ტარიფი — ექიმის აყვანისას' : 'ტარიფი — გამოსავლისას' };
  }
  const rs = await rules(ex, v.department_id);
  const line = (r: RuleRow, qty: number, suffix: string): FeeLine => ({ rule_id: r.id, tariff_id: r.tariff_id, quantity: qty, description: `${r.title}${suffix}`, code: r.code, base_price: r.base_price });
  if (s.fee_mode === 'visit') {
    const r = rs.find((x) => x.kind === 'visit');
    return r ? { lines: [line(r, 1, '')], note: null } : { lines: [], note: 'ვიზიტის ტარიფის წესი არ არის (ადმინისტრირება → ER → ტარიფის წესები)' };
  }
  if (s.fee_mode === 'level') {
    let scale = v.triage_scale; let level = v.triage_level;
    if (s.fee_level_basis === 'highest') {
      const h = await ex.selectFrom('er_triage').select(['scale_code', 'level']).where('encounter_id', '=', encounterId).orderBy('level').orderBy('recorded_at', 'desc').executeTakeFirst();
      if (h) { scale = h.scale_code; level = h.level; }
    }
    if (!scale || level == null) return { lines: [], note: 'ტრიაჟი არ არის — დონის ტარიფი ვერ განისაზღვრა' };
    const r = rs.find((x) => x.kind === 'level' && x.scale_code === scale && x.level === level);
    return r ? { lines: [line(r, 1, ` (ტრიაჟი ${scale}-${level})`)], note: null } : { lines: [], note: `ტრიაჟის დონის (${scale}-${level}) ტარიფის წესი არ არის` };
  }
  // time: ზოლი + (არასავალდებულო) ყოველი დაწყებული საათი ბოლო ზოლის შემდეგ
  const end = asDeparted?.at ?? (v.ended_at ? new Date(v.ended_at) : new Date());
  const los = Math.max(0, Math.floor((end.getTime() - new Date(v.arrived_at).getTime()) / 60_000));
  const out: FeeLine[] = [];
  const band = rs.filter((x) => x.kind === 'time_band').find((x) => los >= x.from_min! && (x.to_min == null || los < x.to_min));
  if (band) out.push(line(band, 1, ` (ER-ში ${fmtMin(los)})`));
  const hour = rs.find((x) => x.kind === 'time_hour');
  if (hour && los > hour.from_min!) { const q = Math.ceil((los - hour.from_min!) / 60); out.push(line(hour, q, ` (${fmtMin(hour.from_min!)}-ის შემდეგ, ${q} სთ)`)); }
  return { lines: out, note: out.length ? null : `ხანგრძლივობის (${fmtMin(los)}) ტარიფის წესი არ არის` };
}

export async function erInvoice(ex: Ex, encounterId: string) {
  return ex.selectFrom('invoices').select(['id', 'invoice_number', 'finalized_at', 'merged_into_invoice_id', 'total_amount', 'patient_share', 'insurance_share', 'state_share',
    'insurance_payer_id', 'state_payer_id', 'paid_status',
    sql<string>`(SELECT coalesce(sum(amount), 0) FROM payments p WHERE p.invoice_id = invoices.id)::text`.as('paid'),
    sql<boolean>`EXISTS (SELECT 1 FROM fin_claim_items ci JOIN fin_claims c ON c.id = ci.claim_id WHERE ci.invoice_id = invoices.id AND c.status <> 'cancelled')`.as('in_claim')])
    .where('encounter_id', '=', encounterId).executeTakeFirst();
}

/** ტარიფის ხაზების სინქრონიზაცია ER-ის ინვოისში (იდემპოტენტური). ბრუნდება: დამატებული / წაშლილი / გამოტოვების მიზეზი */
export async function erFeeSync(trx: Trx, encounterId: string, userId: string | null, s?: ErClinicalSettings) {
  const cfg = s ?? (await erClinicalSettings());
  const inv = await erInvoice(trx, encounterId);
  if (!inv) return { added: 0, removed: 0, skipped: 'no_invoice' as const };
  if (inv.finalized_at || inv.in_claim || inv.merged_into_invoice_id) return { added: 0, removed: 0, skipped: (inv.in_claim ? 'in_claim' : 'closed') as 'in_claim' | 'closed' };
  const v = (await erVisit(trx, encounterId))!;
  const want = (await erFeeDesired(trx, encounterId, cfg)).lines;
  const have = await trx.selectFrom('invoice_line_items').select(['id', 'er_fee_rule_id', 'quantity']).where('invoice_id', '=', inv.id).where('er_fee_rule_id', 'is not', null).execute();
  const pending = [...want]; let removed = 0; let added = 0; let keptPaid = 0;
  for (const h of have) {
    const i = pending.findIndex((x) => x.rule_id === h.er_fee_rule_id && x.quantity === h.quantity);
    if (i >= 0) { pending.splice(i, 1); continue; }
    if (Number(inv.paid) > 0) { keptPaid++; continue; }   // გადახდილ ინვოისზე ხაზი არ იშლება (ჯამი გადახდილზე ნაკლები ვერ გახდება)
    await trx.deleteFrom('invoice_line_items').where('id', '=', h.id).execute(); removed++;
  }
  const at = v.ended_at ?? v.doctor_at ?? new Date();
  for (const w of pending) {
    await trx.insertInto('invoice_line_items').values({ invoice_id: inv.id, tariff_id: w.tariff_id, er_fee_rule_id: w.rule_id, description: w.description, quantity: w.quantity,
      unit_price: w.base_price, original_price: w.base_price, category: 'service', added_by: userId, ordering_department_id: v.department_id, performing_department_id: v.department_id,
      service_date: sql<string>`(${new Date(at).toISOString()}::timestamptz AT TIME ZONE ${TZ})::date` }).execute();
    added++;
  }
  return { added, removed, skipped: null, kept_paid: keptPaid };
}

/** დახურვა: გადამხდელის წილი (opd_payer_mode = rules) + finalized_at */
export async function erInvoiceClose(trx: Trx, encounterId: string, userId: string | null) {
  const inv = await trx.selectFrom('invoices').select(['id', 'finalized_at']).where('encounter_id', '=', encounterId).forUpdate().executeTakeFirst();
  if (!inv || inv.finalized_at) return false;
  await applyOpdRules(trx, inv.id, { onlyStale: false });
  await trx.updateTable('invoices').set({ finalized_at: sql`now()`, finalized_by: userId }).where('id', '=', inv.id).execute();
  return true;
}
/** გახსნა (გამოსავლის გაუქმება / ხელით): ქლეიმში შემავალი — არა (false) */
export async function erInvoiceOpen(trx: Trx, encounterId: string) {
  const inv = await erInvoice(trx, encounterId);
  if (!inv?.finalized_at || inv.merged_into_invoice_id) return !inv?.finalized_at;
  if (inv.in_claim) return false;
  await trx.updateTable('invoices').set({ finalized_at: null, finalized_by: null, reopen_count: sql`reopen_count + 1` }).where('id', '=', inv.id).execute();
  return true;
}

/** ჰოსპიტალიზაცია: ER-ის ინვოისის გაერთიანება სტაციონარისაში */
export async function erInvoiceMerge(trx: Trx, erEncounterId: string, ipdEncounterId: string) {
  const er = await erInvoice(trx, erEncounterId);
  if (!er) return { merged: false, reason: 'no_invoice' as const, lines: 0 };
  if (Number(er.paid) > 0) return { merged: false, reason: 'paid' as const, lines: 0 };
  if (er.in_claim) return { merged: false, reason: 'in_claim' as const, lines: 0 };
  const ipd = await trx.selectFrom('invoices').select(['id', 'finalized_at']).where('encounter_id', '=', ipdEncounterId).forUpdate().executeTakeFirst();
  if (!ipd || ipd.finalized_at) return { merged: false, reason: 'no_invoice' as const, lines: 0 };
  if (er.finalized_at) await trx.updateTable('invoices').set({ finalized_at: null, finalized_by: null }).where('id', '=', er.id).execute();
  const moved = await trx.updateTable('invoice_line_items').set({ invoice_id: ipd.id, moved_from_invoice_id: er.id }).where('invoice_id', '=', er.id).returning('id').execute();
  if (moved.length) {
    await trx.deleteFrom('invoice_line_shares').where('line_id', 'in', moved.map((m) => m.id)).execute();
    // პაკეტი (თუ უკვე არჩეულია) — როგორც ახალ ხაზზე
    await sql`UPDATE invoice_line_items l SET package_included = billing_package_covers(sb.package_id, l.category, l.tariff_id)
      FROM stay_billing sb WHERE sb.encounter_id = ${ipdEncounterId} AND sb.package_id IS NOT NULL AND l.invoice_id = ${ipd.id}
        AND l.moved_from_invoice_id = ${er.id} AND l.category NOT IN ('bed', 'package')`.execute(trx);
  }
  await trx.updateTable('invoices').set({ insurance_share: '0', state_share: '0', merged_into_invoice_id: ipd.id }).where('id', '=', er.id).execute();
  await sql`SELECT recalc_invoice(${er.id}::uuid), recalc_invoice(${ipd.id}::uuid)`.execute(trx);
  await trx.updateTable('invoices').set({ finalized_at: sql`now()` }).where('id', '=', er.id).execute();
  return { merged: true, reason: null, lines: moved.length };
}
/** სტაციონარში ჰოსპიტალიზაციის გაუქმება: გადატანილი ხაზები ER-ის ინვოისში ბრუნდება */
export async function erInvoiceUnmerge(trx: Trx, ipdEncounterId: string) {
  const ipd = await trx.selectFrom('invoices').select('id').where('encounter_id', '=', ipdEncounterId).executeTakeFirst();
  if (!ipd) return 0;
  const er = await trx.selectFrom('invoices').select(['id']).where('merged_into_invoice_id', '=', ipd.id).forUpdate().executeTakeFirst();
  if (!er) return 0;
  await trx.updateTable('invoices').set({ finalized_at: null, finalized_by: null, merged_into_invoice_id: null }).where('id', '=', er.id).execute();
  const back = await trx.updateTable('invoice_line_items').set({ invoice_id: er.id, moved_from_invoice_id: null, package_included: false })
    .where('invoice_id', '=', ipd.id).where('moved_from_invoice_id', '=', er.id).returning('id').execute();
  await sql`SELECT recalc_invoice(${er.id}::uuid), recalc_invoice(${ipd.id}::uuid)`.execute(trx);
  await trx.updateTable('invoices').set({ payer_shares_stale: true }).where('id', '=', er.id).execute();
  return back.length;
}

/** გამოსავლის შემდეგ (იმავე ტრანზაქციაში): ტარიფი → გაერთიანება / დახურვა */
export async function erBillingAfterDisposition(trx: Trx, encounterId: string, kind: string, s: ErClinicalSettings, userId: string, admit?: { ipdEncounterId: string; merge: boolean }) {
  const fee = await erFeeSync(trx, encounterId, userId, s);
  if (kind === 'admitted' && admit?.merge) {
    const m = await erInvoiceMerge(trx, encounterId, admit.ipdEncounterId);
    if (m.merged) return { fee, merge: m, closed: true };
    if (s.invoice_close === 'departure') await erInvoiceClose(trx, encounterId, userId);
    return { fee, merge: m, closed: s.invoice_close === 'departure' };
  }
  const closed = s.invoice_close === 'departure' ? await erInvoiceClose(trx, encounterId, userId) : false;
  return { fee, merge: null, closed };
}
/** გამოსავლის გაუქმება: ინვოისის გახსნა + ტარიფის ხელახალი სინქრონიზაცია (გამოსავლის ტარიფი იშლება) */
export async function erBillingOnReopen(trx: Trx, encounterId: string, userId: string) {
  const opened = await erInvoiceOpen(trx, encounterId);
  // გადახდილ ინვოისზე ტარიფის ხაზი რჩება (წაშლა გადახდილზე ნაკლებ ჯამს მისცემდა); ხელახალი გამოსავლისას — სინქრონიზაცია
  const paid = Number((await erInvoice(trx, encounterId))?.paid ?? 0) > 0;
  const fee = opened && !paid ? await erFeeSync(trx, encounterId, userId) : { added: 0, removed: 0, skipped: (opened ? 'paid' : 'in_claim') as 'paid' | 'in_claim' };
  return { opened, fee };
}
export function resolveMerge(s: ErClinicalSettings, ...choices: (boolean | null | undefined)[]) {
  if (s.admit_invoice === 'merge') return true;
  if (s.admit_invoice === 'separate') return false;
  for (const c of choices) if (typeof c === 'boolean') return c;
  return true;
}

/** გამოსავლის შემოწმებისთვის: ნაშთი / გაერთიანების შესაძლებლობა */
export async function erBillingFacts(ex: Ex, encounterId: string) {
  const inv = await erInvoice(ex, encounterId);
  if (!inv) return null;
  const due = Math.max(0, Number(inv.patient_share) - Number(inv.paid));
  return { invoice_id: inv.id, number: inv.invoice_number, total: Number(inv.total_amount), paid: Number(inv.paid), due, in_claim: inv.in_claim, finalized: !!inv.finalized_at };
}

// ======================================================================= DTO
export class FeeRuleDto {
  @IsIn(KINDS) kind: (typeof KINDS)[number];
  @IsUUID() tariff_id: string;
  @IsOptional() @IsUUID() department_id?: string | null;
  @IsOptional() @IsString() @Length(1, 20) scale_code?: string | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(9) level?: number | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(20160) from_min?: number | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(20160) to_min?: number | null;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsString() @MaxLength(500) note?: string | null;
}
class ReasonDto { @IsString() @Length(3, 1000) reason: string }

// ======================================================================= სერვისი
@Injectable()
export class ErBillingService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService) {}

  private async assertEr() { if (modulesRef.svc) await modulesRef.svc.assertActive('er'); }

  /** ბარათის ჩანართი „ანგარიში“ */
  async view(id: string, u: AuthUser) {
    const v = await this.db.selectFrom('er_visits').select(['encounter_id', 'status', 'disposition', 'visit_no']).where('encounter_id', '=', id).executeTakeFirst();
    if (!v) throw new NotFoundException('ER-ის შემთხვევა ვერ მოიძებნა');
    const s = await erClinicalSettings();
    const inv = await erInvoice(this.db, id);
    if (!inv) throw new NotFoundException('ინვოისი ვერ მოიძებნა');
    const lines = await this.db.selectFrom('invoice_line_items as l').leftJoin('invoices as mi', 'mi.id', 'l.invoice_id')
      .select(['l.id', 'l.description', 'l.category', 'l.quantity', 'l.unit_price', 'l.line_total', 'l.package_included', 'l.er_fee_rule_id', 'l.dx_order_item_id', 'l.stock_doc_line_id',
        'l.consultation_id', sql<string>`to_char(l.service_date, 'YYYY-MM-DD')`.as('service_date'), sql<boolean>`l.invoice_id <> ${inv.id}`.as('moved')])
      .where((eb) => eb.or([eb('l.invoice_id', '=', inv.id), eb('l.moved_from_invoice_id', '=', inv.id)])).orderBy('l.created_at').execute();
    const payments = await this.db.selectFrom('payments').select(['id', 'amount', 'method', 'paid_at']).where('invoice_id', '=', inv.id).orderBy('paid_at').execute();
    const payers = await this.db.selectFrom('payers').select(['id', 'name', 'kind']).where('id', 'in', [inv.insurance_payer_id, inv.state_payer_id].filter((x): x is string => !!x).concat(['00000000-0000-0000-0000-000000000000'])).execute();
    const merged = inv.merged_into_invoice_id ? await this.db.selectFrom('invoices as i').innerJoin('inpatient_stays as st', 'st.encounter_id', 'i.encounter_id')
      .select(['i.invoice_number', 'i.encounter_id', 'st.adm_no']).where('i.id', '=', inv.merged_into_invoice_id).executeTakeFirst() : null;
    const preview = ['waiting', 'triaged', 'in_treatment'].includes(v.status) ? await erFeeDesired(this.db, id, s, { kind: 'home' }) : await erFeeDesired(this.db, id, s);
    const erActive = modulesRef.svc ? await modulesRef.svc.isActive('er').catch(() => false) : true;
    const tr = await tariffRules(this.db);
    const due = Math.max(0, Number(inv.patient_share) - Number(inv.paid));
    return {
      invoice: { id: inv.id, number: inv.invoice_number, finalized_at: inv.finalized_at, total: inv.total_amount, patient_share: inv.patient_share, insurance_share: inv.insurance_share,
        state_share: inv.state_share, paid: inv.paid, due: due.toFixed(2), paid_status: inv.paid_status, in_claim: inv.in_claim,
        insurance_payer: payers.find((p) => p.id === inv.insurance_payer_id) ?? null, state_payer: payers.find((p) => p.id === inv.state_payer_id) ?? null,
        merged_into: merged ? { invoice_number: merged.invoice_number, encounter_id: merged.encounter_id, adm_no: merged.adm_no } : null },
      lines, payments,
      fee: { mode: s.fee_mode, at: s.fee_at, lines: preview.lines.map((l) => ({ description: l.description, quantity: l.quantity, code: l.code })), note: preview.note,
        estimate: ['waiting', 'triaged', 'in_treatment'].includes(v.status) },
      settings: { fee_mode: s.fee_mode, fee_at: s.fee_at, invoice_close: s.invoice_close, admit_invoice: s.admit_invoice, unpaid_check: s.unpaid_check, opd_payer_mode: tr.opd_payer_mode },
      can: {
        close: erActive && has(u, ...ER_BILLING_EDIT) && !inv.finalized_at && v.status === 'departed',
        open: erActive && has(u, ...ER_BILLING_EDIT) && !!inv.finalized_at && !inv.merged_into_invoice_id && !inv.in_claim,
        pay: has(u, 'admin', 'billing', 'receptionist') && due > 0 && !inv.merged_into_invoice_id,
        payers: has(u, 'admin', 'billing', 'receptionist') && !inv.in_claim && !inv.merged_into_invoice_id,
      },
    };
  }

  async close(id: string, u: AuthUser, ctx: AuditContext) {
    await this.assertEr();
    try {
      return await this.db.transaction().execute(async (trx) => {
        const v = await trx.selectFrom('er_visits').select(['status']).where('encounter_id', '=', id).forUpdate().executeTakeFirst();
        if (!v) throw new NotFoundException('ER-ის შემთხვევა ვერ მოიძებნა');
        if (v.status !== 'departed') throw new ConflictException({ code: 'ER_VISIT_OPEN', message: 'ინვოისი იხურება გამოსავლის შემდეგ' });
        await erFeeSync(trx, id, u.id);
        if (!(await erInvoiceClose(trx, id, u.id))) throw new ConflictException('ინვოისი უკვე დახურულია');
        await this.audit.log(ctx, { action: 'ER_INVOICE_CLOSE', entityName: 'invoices', entityId: id, newData: { manual: true } }, trx);
        return { encounter_id: id, closed: true };
      });
    } catch (e) { mapPgError(e, { fin_period_locked: 'პერიოდი დახურულია' }); }
  }
  async open(id: string, dto: ReasonDto, u: AuthUser, ctx: AuditContext) {
    await this.assertEr();
    try {
      return await this.db.transaction().execute(async (trx) => {
        const inv = await erInvoice(trx, id);
        if (!inv?.finalized_at) throw new ConflictException('ინვოისი დახურული არ არის');
        if (inv.merged_into_invoice_id) throw new ConflictException({ code: 'ER_INVOICE_MERGED', message: 'ინვოისი გაერთიანებულია სტაციონარისაში' });
        if (!(await erInvoiceOpen(trx, id))) throw new ConflictException({ code: 'INVOICE_IN_CLAIM', message: 'ინვოისი შედის გადამხდელის ქლეიმში' });
        await this.audit.log(ctx, { action: 'ER_INVOICE_OPEN', entityName: 'invoices', entityId: inv.id, newData: { reason: dto.reason.trim() } }, trx);
        return { encounter_id: id, closed: false };
      });
    } catch (e) { mapPgError(e, { invoice_in_claim: 'ინვოისი შედის ქლეიმში' }); }
  }

  // ---------------------------------------------------------------- ტარიფის წესები
  async preview(visit: string, kind?: string) {
    const v = await this.db.selectFrom('er_visits').select('status').where('encounter_id', '=', visit).executeTakeFirst();
    if (!v) throw new NotFoundException('ER-ის შემთხვევა ვერ მოიძებნა');
    return erFeeDesired(this.db, visit, await erClinicalSettings(), v.status === 'departed' ? undefined : { kind: kind || 'home' });
  }
  async listRules() {
    const s = await erClinicalSettings();
    const rows = await this.db.selectFrom('er_fee_rules as r').innerJoin('service_tariffs as t', 't.id', 'r.tariff_id').leftJoin('departments as d', 'd.id', 'r.department_id')
      .selectAll('r').select(['t.code as tariff_code', 't.title as tariff_title', 't.base_price', 'd.name as department_name'])
      .orderBy('r.is_active', 'desc').orderBy('r.kind').orderBy('r.scale_code').orderBy('r.level').orderBy('r.from_min').execute();
    const tariffs = await this.db.selectFrom('service_tariffs').select(['id', 'code', 'title', 'base_price']).where('is_active', '=', true).orderBy('code').execute();
    return { fee_mode: s.fee_mode, rules: rows, tariffs };
  }
  private async validRule(dto: FeeRuleDto) {
    const t = await this.db.selectFrom('service_tariffs').select(['id', 'is_active']).where('id', '=', dto.tariff_id).executeTakeFirst();
    if (!t?.is_active) throw new BadRequestException('ტარიფი ვერ მოიძებნა ან გათიშულია');
    if (dto.department_id && !(await this.db.selectFrom('departments').select('id').where('id', '=', dto.department_id).executeTakeFirst())) {
      throw new BadRequestException('განყოფილება ვერ მოიძებნა');
    }
    const row = {
      kind: dto.kind, tariff_id: dto.tariff_id, department_id: dto.department_id ?? null, note: dto.note?.trim() || null,
      scale_code: dto.kind === 'level' ? dto.scale_code ?? null : null, level: dto.kind === 'level' ? dto.level ?? null : null,
      from_min: dto.kind.startsWith('time') ? dto.from_min ?? null : null, to_min: dto.kind === 'time_band' ? dto.to_min ?? null : null,
    };
    if (dto.kind === 'level' && (!row.scale_code || !row.level)) throw new BadRequestException('დონის წესს სჭირდება სკალა და დონე');
    if (dto.kind.startsWith('time') && row.from_min == null) throw new BadRequestException('ხანგრძლივობის წესს სჭირდება „წთ-დან“');
    if (row.to_min != null && row.to_min <= row.from_min!) throw new BadRequestException('„წთ-მდე“ უნდა აღემატებოდეს „წთ-დან“-ს');
    return row;
  }
  async createRule(dto: FeeRuleDto, u: AuthUser, ctx: AuditContext) {
    const row = await this.validRule(dto);
    try {
      const r = await this.db.insertInto('er_fee_rules').values({ ...row, is_active: dto.is_active ?? true, created_by: u.id }).returningAll().executeTakeFirstOrThrow();
      await this.audit.log(ctx, { action: 'ER_FEE_RULE_CREATE', entityName: 'er_fee_rules', entityId: r.id, newData: r });
      return r;
    } catch (e) { mapPgError(e, { ux_er_fee_rules: 'ასეთი აქტიური წესი უკვე არსებობს', er_fee_rules_scale_code_level_fkey: 'ტრიაჟის სკალა / დონე ვერ მოიძებნა' }); }
  }
  async updateRule(id: string, dto: FeeRuleDto, u: AuthUser, ctx: AuditContext) {
    const old = await this.db.selectFrom('er_fee_rules').selectAll().where('id', '=', id).executeTakeFirst();
    if (!old) throw new NotFoundException('წესი ვერ მოიძებნა');
    const row = await this.validRule(dto);
    try {
      const r = await this.db.updateTable('er_fee_rules').set({ ...row, is_active: dto.is_active ?? old.is_active }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await this.audit.log(ctx, { action: 'ER_FEE_RULE_UPDATE', entityName: 'er_fee_rules', entityId: id, oldData: old, newData: r });
      void u;
      return r;
    } catch (e) { mapPgError(e, { ux_er_fee_rules: 'ასეთი აქტიური წესი უკვე არსებობს', er_fee_rules_scale_code_level_fkey: 'ტრიაჟის სკალა / დონე ვერ მოიძებნა' }); }
  }
  /** წაშლა — თუ ხაზებში არ გამოყენებულა; სხვაგვარად — გათიშვა */
  async deleteRule(id: string, ctx: AuditContext) {
    const old = await this.db.selectFrom('er_fee_rules').selectAll().where('id', '=', id).executeTakeFirst();
    if (!old) throw new NotFoundException('წესი ვერ მოიძებნა');
    const used = await this.db.selectFrom('invoice_line_items').select('id').where('er_fee_rule_id', '=', id).limit(1).executeTakeFirst();
    if (used) await this.db.updateTable('er_fee_rules').set({ is_active: false }).where('id', '=', id).execute();
    else await this.db.deleteFrom('er_fee_rules').where('id', '=', id).execute();
    await this.audit.log(ctx, { action: used ? 'ER_FEE_RULE_DISABLE' : 'ER_FEE_RULE_DELETE', entityName: 'er_fee_rules', entityId: id, oldData: old });
    return { id, deleted: !used, disabled: !!used };
  }
}

// ======================================================================= კონტროლერი
@Controller('er')
@RequireModule('er')
export class ErBillingController {
  constructor(private readonly s: ErBillingService, private readonly jobs: ErJobsService) {}
  /** 0091: ER-ის ჯობი ხელით (e2e / ადმინი) */
  @Post('jobs/run') @HttpCode(200) @Roles('admin')
  runJobs() { return this.jobs.tick(); }
  @Get('visits/:id/billing') @ClinicalHistory() @Roles(...ER_BILLING_READ)
  view(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser) { return this.s.view(id, u); }
  @Post('visits/:id/billing/close') @HttpCode(200) @Roles(...ER_BILLING_EDIT)
  close(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.close(id, u, auditCtx(req)); }
  @Post('visits/:id/billing/open') @HttpCode(200) @Roles(...ER_BILLING_EDIT)
  open(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.open(id, dto, u, auditCtx(req)); }
  @Get('fee-rules') @Roles('admin', 'billing', 'tariffs', 'er_manage', 'accountant', 'viewer')
  rules() { return this.s.listRules(); }
  @Post('fee-rules') @Roles(...ER_FEE_RULES_EDIT)
  createRule(@Body() dto: FeeRuleDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.createRule(dto, u, auditCtx(req)); }
  @Put('fee-rules/:rid') @Roles(...ER_FEE_RULES_EDIT)
  updateRule(@Param('rid', ParseUUIDPipe) rid: string, @Body() dto: FeeRuleDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.updateRule(rid, dto, u, auditCtx(req)); }
  @Delete('fee-rules/:rid') @Roles(...ER_FEE_RULES_EDIT)
  deleteRule(@Param('rid', ParseUUIDPipe) rid: string, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.deleteRule(rid, auditCtx(req)); }
  @Get('fee-rules/preview') @Roles(...ER_BILLING_READ)
  preview(@Query('visit', ParseUUIDPipe) visit: string, @Query('kind') kind?: string) { return this.s.preview(visit, kind); }
}

@Module({ providers: [ErBillingService, ErJobsService], controllers: [ErBillingController], exports: [ErBillingService, ErJobsService] })
export class ErBillingModule {}
void ForbiddenException;
