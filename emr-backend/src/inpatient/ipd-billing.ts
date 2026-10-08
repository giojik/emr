import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, HttpCode, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res,
  StreamableFile } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import { IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min } from 'class-validator';
import type { Request, Response } from 'express';
import { sql, type Transaction } from 'kysely';
import { join } from 'node:path';
import PDFDocument from 'pdfkit';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser } from '../auth/roles';
import { mapPgError } from '../common/pg-errors';
import { loadEnv } from '../config/env';
import { InjectDb, type Database } from '../database/database.module';
import type { DB } from '../database/db';
import { InpatientModule, InpatientService, type InpatientSettings } from './inpatient';
import { CATEGORY_KA, loadBilling, MODE_KA, PAYER_KIND_KA } from './ipd-billing-calc';

type Trx = Transaction<DB>;
type Ex = Database | Trx;
const TZ = loadEnv().CLINIC_TZ;
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const money = ({ value }: { value: unknown }) => (typeof value === 'string' && value.trim() !== '' ? Number(value) : value === '' ? null : value);
const EXCL = ['bed', 'ventilation', 'surgery', 'anesthesia', 'service', 'consult', 'lab', 'radiology', 'endoscopy', 'medication', 'supply', 'implant', 'package', 'other'] as const;
const METHOD_KA: Record<string, string> = { cash: 'ნაღდი', card_terminal: 'ბარათი', bank_transfer: 'გადარიცხვა', deposit: 'ავანსიდან' };
const BILLING = ['admin', 'billing'] as const;
const FRONT = ['admin', 'billing', 'receptionist'] as const;
const READ = ['admin', 'billing', 'receptionist', 'manager', 'doctor', 'nurse', 'viewer'] as const;

// ================================================================= DTO
export class PackageSetDto { @IsOptional() @IsUUID() package_id?: string | null }
export class StayPayerDto {
  @IsOptional() @IsUUID() payer_id?: string;
  @IsOptional() @IsInt() @Min(1) @Max(9) seq?: number;
  @IsOptional() @IsIn(['percent', 'fixed', 'drg']) mode?: 'percent' | 'fixed' | 'drg';
  @IsOptional() @Transform(money) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) coverage_pct?: number;
  @IsOptional() @Transform(money) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(99_999_999) limit_amount?: number | null;
  @IsOptional() @Transform(money) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(99_999_999) deductible?: number;
  @IsOptional() @Transform(money) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(99_999_999) fixed_amount?: number | null;
  @IsOptional() @IsString() @Matches(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,19}$/) drg_code?: string | null;
  @IsOptional() @IsBoolean() writeoff_excess?: boolean;
  @IsOptional() @IsArray() @IsIn(EXCL, { each: true }) excluded_categories?: string[];
  @IsOptional() @IsString() @MaxLength(60) policy_no?: string | null;
  @IsOptional() @IsString() @MaxLength(60) guarantee_no?: string | null;
  @IsOptional() @IsDateString({ strict: true }) guarantee_date?: string | null;
  @IsOptional() @IsDateString({ strict: true }) valid_until?: string | null;
  @IsOptional() @IsUUID() file_id?: string | null;
  @IsOptional() @Transform(money) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(99_999_999) override_amount?: number | null;
  @IsOptional() @IsString() @MaxLength(500) override_reason?: string | null;
}
export class ReasonDto { @IsString() @Length(5, 500) reason: string }
export class ServiceAddDto {
  @IsUUID() tariff_id: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(999) quantity: number;
  @IsOptional() @IsDateString({ strict: true }) service_date?: string;
  @IsOptional() @IsString() @MaxLength(200) note?: string;
}
export class DepositDto {
  @IsIn(['deposit', 'refund']) kind: 'deposit' | 'refund';
  @Transform(money) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(9_999_999) amount: number;
  @IsIn(['cash', 'card_terminal', 'bank_transfer']) method: 'cash' | 'card_terminal' | 'bank_transfer';
  @IsOptional() @IsString() @MaxLength(100) terminal_ref?: string;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

// ================================================================= სერვისი
/**
 * სტაციონარის ბილინგი (0046).
 *   საწოლდღე: შუაღამის აღრიცხვა (SQL ipd_sync_bed_days) — worker (ყოველ 10 წთ-ში აქტიურებზე), გახსნისას, გაწერისას, ფინალიზაციისას.
 *   პაკეტი: ხაზები „პაკეტშია“ (ჯამში არ ითვლება, ჩანს კალკულაციაში); პაკეტის ხაზი — ფასით; დღეები included_days-მდე.
 *   გადამხდელები: საგარანტიო წერილი / პროგრამა / DRG; გაანგარიშება — ipd-billing-calc.ts (split).
 *   ავანსი: ცალკე (stay_deposits, ქვითრის ნომრით); ფინალიზაციისას პაციენტის წილს ფარავს (payments.method = deposit); ნაშთი — დაბრუნება.
 *   ფინალიზაცია: მხოლოდ გაწერის შემდეგ; ხაზები იბლოკება (DB trigger); გახსნა — მიზეზით.
 *   უფლებები: ბილინგი / admin — ყველაფერი; მიმღები — პაკეტი, გადამხდელი (ხელით შესწორების გარეშე), ავანსი;
 *     ექიმი / ექთანი — მომსახურების დამატება (staff_add_services), თანხები — billing_amounts_visible (all / heads / billing_only).
 */
@Injectable()
export class IpdBillingService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService, private readonly ipd: InpatientService) {}

  private async stay(encounterId: string, ex: Ex = this.db) {
    const st = await ex.selectFrom('inpatient_stays as st').innerJoin('patients as p', 'p.id', 'st.patient_id').innerJoin('encounters as e', 'e.id', 'st.encounter_id')
      .select(['st.encounter_id', 'st.adm_no', 'st.status', 'st.admitted_at', 'st.ended_at', 'st.patient_id', 'p.first_name', 'p.last_name', 'p.personal_number', 'p.birth_date',
        'e.attending_doctor_id',
        sql<string>`(SELECT a.department_id FROM bed_assignments a WHERE a.encounter_id = st.encounter_id AND a.end_kind IS DISTINCT FROM 'cancel'
          ORDER BY a.ended_at IS NULL DESC, a.started_at DESC, a.id DESC LIMIT 1)`.as('department_id')])
      .where('st.encounter_id', '=', encounterId).executeTakeFirst();
    if (!st) throw new NotFoundException('ჰოსპიტალიზაცია ვერ მოიძებნა');
    return st;
  }
  private async invoiceLocked(trx: Trx, encounterId: string) {
    const inv = await trx.selectFrom('invoices').selectAll().where('encounter_id', '=', encounterId).forUpdate().executeTakeFirst();
    if (!inv) throw new NotFoundException('ინვოისი ვერ მოიძებნა');
    return inv;
  }
  private notFinal(inv: { finalized_at: Date | null }) {
    if (inv.finalized_at) throw new ConflictException({ code: 'FINALIZED', message: 'ინვოისი ფინალიზებულია — ცვლილებისთვის საჭიროა გახსნა (ბილინგი)' });
  }
  /** საწოლდღეების სინქრონიზაცია (იდემპოტენტური) */
  async syncBedDays(ex: Ex, encounterId: string, s?: InpatientSettings) {
    const st = s ?? await this.ipd.settings();
    await sql`SELECT ipd_sync_bed_days(${encounterId}::uuid, ${TZ}, ${st.leave_counts_bed_day !== false})`.execute(ex);
  }

  private async rights(u: AuthUser, departmentId: string, s: InpatientSettings) {
    const billing = has(u, 'admin', 'billing');
    const front = billing || has(u, 'receptionist');
    const staff = await this.ipd.isStaff(u, departmentId);
    const vis = s.billing_amounts_visible ?? 'heads';
    const amounts = front || has(u, 'manager') || (has(u, 'doctor', 'nurse') && (vis === 'all' || (vis === 'heads' && await this.ipd.isHead(u, departmentId))));
    return { billing, front, staff, amounts, services: billing || (staff && has(u, 'doctor', 'nurse') && s.staff_add_services !== false) };
  }

  // ---------------------------------------------------------------- სრული ხედი
  async view(encounterId: string, u: AuthUser) {
    const s = await this.ipd.settings();
    const st = await this.stay(encounterId);
    const inv0 = await this.db.selectFrom('invoices').select(['id', 'finalized_at']).where('encounter_id', '=', encounterId).executeTakeFirst();
    if (!inv0) throw new NotFoundException('ინვოისი ვერ მოიძებნა');
    if (!inv0.finalized_at && st.status !== 'cancelled') await this.db.transaction().execute((trx) => this.syncBedDays(trx, encounterId, s));
    const b = (await loadBilling(this.db, encounterId))!;
    const r = await this.rights(u, st.department_id, s);
    const pkg = await this.db.selectFrom('stay_billing as sb').leftJoin('billing_packages as p', 'p.id', 'sb.package_id').leftJoin('users as su', 'su.id', 'sb.package_set_by')
      .select(['p.id', 'p.code', 'p.name', 'p.price', 'p.includes_bed', 'p.included_days', 'sb.package_set_at', sql<string | null>`su.first_name || ' ' || su.last_name`.as('set_by_name')])
      .where('sb.encounter_id', '=', encounterId).executeTakeFirst();
    const days = await this.db.selectFrom('stay_bed_days as d').innerJoin('departments as dep', 'dep.id', 'd.department_id').innerJoin('bed_types as bt', 'bt.code', 'd.bed_type_code')
      .leftJoin('beds as bd', 'bd.id', 'd.bed_id').leftJoin('service_tariffs as t', 't.id', 'd.tariff_id')
      .select([sql<string>`to_char(d.day, 'YYYY-MM-DD')`.as('day'), 'dep.name as department_name', 'bd.code as bed_code', 'bt.name as bed_type_name', 'd.bed_type_code', 'd.on_leave', 'd.minimum',
        'd.package_included', 't.title as tariff_title', 't.base_price as price'])
      .where('d.encounter_id', '=', encounterId).orderBy('d.day').execute();
    const lines = await this.db.selectFrom('invoice_line_items as l').leftJoin('users as a', 'a.id', 'l.added_by')
      .select(['l.id', 'l.category', 'l.description', 'l.quantity', 'l.unit_price', 'l.original_price', 'l.line_total', 'l.package_included', 'l.discount_reason', 'l.created_at',
        sql<string | null>`to_char(l.service_date, 'YYYY-MM-DD')`.as('service_date'), 'l.added_by', sql<string | null>`a.first_name || ' ' || a.last_name`.as('added_by_name')])
      .where('l.invoice_id', '=', b.invoice.id).orderBy(sql`array_position(ARRAY['package','bed','ventilation','surgery','anesthesia','consult','service','lab','radiology','endoscopy','medication','supply','implant','other']::varchar[], l.category)`)
      .orderBy('l.created_at').execute();
    const payers = await this.db.selectFrom('stay_payers as sp').innerJoin('payers as p', 'p.id', 'sp.payer_id').leftJoin('drg_groups as g', 'g.code', 'sp.drg_code')
      .leftJoin('users as c', 'c.id', 'sp.created_by')
      .selectAll('sp').select(['p.code as payer_code', 'p.name as payer_name', 'p.kind', 'g.title as drg_title', sql<string>`c.first_name || ' ' || c.last_name`.as('created_by_name'),
        sql<string | null>`to_char(sp.guarantee_date, 'YYYY-MM-DD')`.as('guarantee_day'), sql<string | null>`to_char(sp.valid_until, 'YYYY-MM-DD')`.as('valid_day')])
      .where('sp.encounter_id', '=', encounterId).orderBy(sql`sp.status = 'active'`, 'desc').orderBy('sp.seq').execute();
    const deposits = await this.db.selectFrom('stay_deposits as d').innerJoin('users as c', 'c.id', 'd.created_by')
      .select(['d.id', 'd.kind', 'd.amount', 'd.method', 'd.terminal_ref', 'd.receipt_no', 'd.note', 'd.created_at', 'd.voided_at', 'd.void_reason', sql<string>`c.first_name || ' ' || c.last_name`.as('created_by_name')])
      .where('d.encounter_id', '=', encounterId).orderBy('d.created_at').execute();
    const payments = await this.db.selectFrom('payments as p').leftJoin('users as c', 'c.id', 'p.received_by')
      .select(['p.id', 'p.amount', 'p.method', 'p.terminal_ref', 'p.paid_at', sql<string | null>`c.first_name || ' ' || c.last_name`.as('received_by_name')])
      .where('p.invoice_id', '=', b.invoice.id).orderBy('p.paid_at').execute();
    const fin = b.invoice.finalized_by ? await this.db.selectFrom('users').select(sql<string>`first_name || ' ' || last_name`.as('n')).where('id', '=', b.invoice.finalized_by).executeTakeFirst() : null;
    const cats = new Map<string, { amount: number; included: number }>();
    for (const l of lines) {
      const c = cats.get(l.category) ?? { amount: 0, included: 0 };
      if (l.package_included) c.included = r2(c.included + Number(l.line_total)); else c.amount = r2(c.amount + Number(l.line_total));
      cats.set(l.category, c);
    }
    const calcBy = new Map(b.calc.payers.map((p) => [p.id, p]));
    const hide = !r.amounts;
    const strip = <T extends Record<string, unknown>>(o: T, keys: string[]) => (hide ? Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k))) : o);
    const missingTariff = days.filter((d) => !d.tariff_title).length;
    // 0047: ხელოვნური ვენტილაციის დღეები
    const vent = await this.db.selectFrom('stay_vent_days as d').leftJoin('service_tariffs as t', 't.id', 'd.tariff_id')
      .select([sql<string>`to_char(d.day, 'YYYY-MM-DD')`.as('day'), 'd.minimum', 'd.package_included', 't.title as tariff_title', 't.base_price as price'])
      .where('d.encounter_id', '=', encounterId).orderBy('d.day').execute();
    const icuMod = await this.db.selectFrom('system_modules').select(['enabled', 'settings']).where('code', '=', 'icu').executeTakeFirst();
    const ventBilling = !!icuMod?.enabled && (icuMod.settings as Record<string, unknown>)?.vent_billing !== false;
    return {
      stay: { encounter_id: st.encounter_id, patient_id: st.patient_id, adm_no: st.adm_no, status: st.status, admitted_at: st.admitted_at, ended_at: st.ended_at, first_name: st.first_name, last_name: st.last_name,
        personal_number: st.personal_number },
      invoice_number: b.invoice.invoice_number, finalized: b.finalized, finalized_at: b.invoice.finalized_at, finalized_by_name: fin?.n ?? null, reopen_count: b.invoice.reopen_count,
      package: pkg?.id ? strip(pkg as Record<string, unknown>, ['price']) : null,
      bed_days: days.map((d) => strip(d as Record<string, unknown>, ['price'])), bed_days_count: days.length, missing_tariff_days: missingTariff,
      vent_days: vent.map((d) => strip(d as Record<string, unknown>, ['price'])), vent_billing: ventBilling,
      missing_vent_tariff: ventBilling ? vent.filter((d) => !d.tariff_title && !d.package_included).length : 0,
      lines: lines.map((l) => ({ ...strip(l as Record<string, unknown>, ['unit_price', 'original_price', 'line_total', 'discount_reason']), category_ka: CATEGORY_KA[l.category] ?? l.category,
        manual: l.category === 'service' && !!l.added_by })),
      by_category: hide ? [] : [...cats.entries()].map(([c, v]) => ({ category: c, label: CATEGORY_KA[c] ?? c, amount: v.amount.toFixed(2), included: v.included.toFixed(2) })),
      payers: payers.map((p) => ({ ...(hide ? { id: p.id, payer_name: p.payer_name, payer_code: p.payer_code, kind: p.kind, status: p.status, seq: p.seq, mode: p.mode, guarantee_no: p.guarantee_no, policy_no: p.policy_no, drg_code: p.drg_code, drg_title: p.drg_title } : p),
        kind_ka: PAYER_KIND_KA[p.kind], mode_ka: MODE_KA[p.mode], calc: hide || p.status !== 'active' ? null : calcBy.get(p.id) ?? null })),
      deposits: hide ? [] : deposits, payments: hide ? [] : payments,
      money: hide ? null : Object.fromEntries(Object.entries(b.money).map(([k, v]) => [k, v.toFixed(2)])),
      amounts_visible: r.amounts,
      can: {
        services: r.services && !b.finalized && st.status !== 'cancelled', package: r.front && !b.finalized && st.status !== 'cancelled', payers: r.front && !b.finalized && st.status !== 'cancelled',
        override: r.billing && !b.finalized, deposits: r.front && st.status !== 'cancelled', void_deposit: r.billing && !b.finalized,
        finalize: r.billing && !b.finalized && st.status === 'discharged', reopen: r.billing && b.finalized,
      },
    };
  }

  // ---------------------------------------------------------------- პაკეტი
  async setPackage(encounterId: string, dto: PackageSetDto, u: AuthUser, ctx: AuditContext) {
    if (!has(u, ...FRONT)) throw new ForbiddenException('პაკეტს ირჩევს მიმღები ან ბილინგი');
    const s = await this.ipd.settings();
    try {
      return await this.db.transaction().execute(async (trx) => {
        const st = await this.stay(encounterId, trx);
        if (st.status === 'cancelled') throw new ConflictException('ჰოსპიტალიზაცია გაუქმებულია');
        this.notFinal(await this.invoiceLocked(trx, encounterId));
        const old = await trx.selectFrom('stay_billing').select('package_id').where('encounter_id', '=', encounterId).executeTakeFirst();
        let pkg: { id: string; code: string; name: string; price: string; department_id: string | null } | undefined;
        if (dto.package_id) {
          const p = await trx.selectFrom('billing_packages').select(['id', 'code', 'name', 'price', 'department_id', 'is_active']).where('id', '=', dto.package_id).executeTakeFirst();
          if (!p?.is_active) throw new BadRequestException('პაკეტი ვერ მოიძებნა ან გათიშულია');
          pkg = p;
          if (p.department_id && p.department_id !== st.department_id) throw new BadRequestException('პაკეტი სხვა განყოფილებისთვისაა');
        }
        await trx.insertInto('stay_billing').values({ encounter_id: encounterId, package_id: pkg?.id ?? null, package_set_by: u.id, package_set_at: sql`now()` })
          .onConflict((oc) => oc.column('encounter_id').doUpdateSet({ package_id: pkg?.id ?? null, package_set_by: u.id, package_set_at: sql`now()` })).execute();
        await sql`SELECT ipd_apply_package(${encounterId}::uuid)`.execute(trx);
        await this.syncBedDays(trx, encounterId, s);
        await this.ipd.event(trx, { encounter_id: encounterId, kind: 'billing_package', data: { package: pkg ? `${pkg.name} (${pkg.code})` : null, price: pkg?.price ?? null } }, u);
        await this.audit.log(ctx, { action: 'IPD_SET_PACKAGE', entityName: 'stay_billing', entityId: encounterId, oldData: { package_id: old?.package_id ?? null }, newData: { package_id: pkg?.id ?? null } }, trx);
        return { package_id: pkg?.id ?? null };
      });
    } catch (e) { mapPgError(e); }
  }

  // ---------------------------------------------------------------- გადამხდელები
  async addPayer(encounterId: string, dto: StayPayerDto, u: AuthUser, ctx: AuditContext) {
    if (!has(u, ...FRONT)) throw new ForbiddenException('გადამხდელს ამატებს მიმღები ან ბილინგი');
    if (!dto.payer_id) throw new BadRequestException('აირჩიეთ გადამხდელი');
    if (dto.override_amount != null && !has(u, ...BILLING)) throw new ForbiddenException('თანხის ხელით შესწორება — მხოლოდ ბილინგი');
    try {
      return await this.db.transaction().execute(async (trx) => {
        const st = await this.stay(encounterId, trx);
        if (st.status === 'cancelled') throw new ConflictException('ჰოსპიტალიზაცია გაუქმებულია');
        this.notFinal(await this.invoiceLocked(trx, encounterId));
        const p = await trx.selectFrom('payers').selectAll().where('id', '=', dto.payer_id!).executeTakeFirst();
        if (!p?.is_active) throw new BadRequestException('გადამხდელი ვერ მოიძებნა ან გათიშულია');
        const seq = dto.seq ?? ((await trx.selectFrom('stay_payers').select(sql<number>`coalesce(max(seq), 0)::int`.as('m')).where('encounter_id', '=', encounterId).where('status', '=', 'active').executeTakeFirstOrThrow()).m + 1);
        const vals = await this.payerTerms(trx, { ...dto }, {
          mode: p.default_mode, coverage_pct: Number(p.default_coverage_pct), limit_amount: p.default_limit === null ? null : Number(p.default_limit), deductible: Number(p.default_deductible),
          writeoff_excess: p.writeoff_excess, excluded_categories: p.excluded_categories ?? [], drg_base_rate: p.drg_base_rate === null ? null : Number(p.drg_base_rate),
        }, st.patient_id);
        const row = await trx.insertInto('stay_payers').values({ encounter_id: encounterId, payer_id: p.id, seq, created_by: u.id, ...vals } as never).returningAll().executeTakeFirstOrThrow();
        await this.ipd.event(trx, { encounter_id: encounterId, kind: 'payer_added', data: { payer: p.name, mode: vals.mode, coverage_pct: vals.coverage_pct, guarantee_no: vals.guarantee_no ?? null, drg: vals.drg_code ?? null } }, u);
        await this.audit.log(ctx, { action: 'IPD_ADD_PAYER', entityName: 'stay_payers', entityId: row.id, newData: row }, trx);
        return row;
      });
    } catch (e) { mapPgError(e, { ux_stay_payers_seq: 'ამ რიგითობით გადამხდელი უკვე არის', ux_stay_payers_payer: 'ეს გადამხდელი უკვე დამატებულია', chk_sp_override: 'შესწორებას სჭირდება მიზეზი' }); }
  }

  /** პირობები: DTO → (ნაგულისხმევი გადამხდელიდან / არსებული ჩანაწერიდან); DRG — წონა ცნობარიდან, განაკვეთი გადამხდელიდან (დაფიქსირება) */
  private async payerTerms(trx: Trx, dto: StayPayerDto, base: { mode: string; coverage_pct: number; limit_amount: number | null; deductible: number; writeoff_excess: boolean;
    excluded_categories: string[]; drg_base_rate: number | null; fixed_amount?: number | null; drg_code?: string | null; drg_weight?: number | null }, patientId: string) {
    const mode = dto.mode ?? base.mode;
    const m = (v: number | null | undefined) => (v === null || v === undefined ? null : v.toFixed(2));
    const out: Record<string, unknown> = {
      mode, coverage_pct: (dto.coverage_pct ?? base.coverage_pct).toFixed(2), limit_amount: m(dto.limit_amount !== undefined ? dto.limit_amount : base.limit_amount),
      deductible: (dto.deductible ?? base.deductible).toFixed(2), writeoff_excess: dto.writeoff_excess ?? base.writeoff_excess,
      excluded_categories: dto.excluded_categories ?? base.excluded_categories,
      fixed_amount: mode === 'fixed' ? m(dto.fixed_amount !== undefined ? dto.fixed_amount : base.fixed_amount ?? null) : null,
      drg_code: null, drg_weight: null, drg_base_rate: null,
    };
    if (mode === 'fixed' && out.fixed_amount === null) throw new BadRequestException('ფიქსირებული რეჟიმი: მიუთითეთ თანხა');
    if (mode === 'drg') {
      const code = (dto.drg_code ?? base.drg_code ?? '').toUpperCase();
      if (!code) throw new BadRequestException('DRG რეჟიმი: აირჩიეთ DRG ჯგუფი');
      const g = await trx.selectFrom('drg_groups').select(['code', 'relative_weight', 'is_active']).where('code', '=', code).executeTakeFirst();
      if (!g?.is_active) throw new BadRequestException(`DRG ${code} ცნობარში ვერ მოიძებნა ან გათიშულია`);
      if (!base.drg_base_rate) throw new BadRequestException('გადამხდელს DRG-ის საბაზისო განაკვეთი არ აქვს (ადმინისტრირება → ბილინგი → გადამხდელები)');
      const same = base.drg_code === code && base.drg_weight;
      Object.assign(out, { drg_code: code, drg_weight: same ? String(base.drg_weight) : g.relative_weight, drg_base_rate: base.drg_base_rate.toFixed(2) });
    }
    for (const k of ['policy_no', 'guarantee_no'] as const) if (dto[k] !== undefined) out[k] = dto[k]?.trim() || null;
    for (const k of ['guarantee_date', 'valid_until'] as const) if (dto[k] !== undefined) out[k] = dto[k] || null;
    if (dto.file_id !== undefined) {
      if (dto.file_id) {
        const f = await trx.selectFrom('patient_files').select(['patient_id', 'is_active']).where('id', '=', dto.file_id).executeTakeFirst();
        if (!f?.is_active || f.patient_id !== patientId) throw new BadRequestException('ფაილი ამ პაციენტს არ ეკუთვნის');
      }
      out.file_id = dto.file_id || null;
    }
    if (dto.override_amount !== undefined) {
      out.override_amount = m(dto.override_amount);
      out.override_reason = dto.override_amount === null ? null : dto.override_reason?.trim() || null;
    }
    return out as { mode: string; coverage_pct: string; guarantee_no?: string | null; drg_code?: string | null } & Record<string, unknown>;
  }

  async updatePayer(id: string, dto: StayPayerDto, u: AuthUser, ctx: AuditContext) {
    if (!has(u, ...FRONT)) throw new ForbiddenException('გადამხდელს ცვლის მიმღები ან ბილინგი');
    if (dto.override_amount !== undefined && !has(u, ...BILLING)) throw new ForbiddenException('თანხის ხელით შესწორება — მხოლოდ ბილინგი');
    try {
      return await this.db.transaction().execute(async (trx) => {
        const old = await trx.selectFrom('stay_payers as sp').innerJoin('payers as p', 'p.id', 'sp.payer_id').selectAll('sp').select(['p.drg_base_rate as payer_rate', 'p.name as payer_name'])
          .where('sp.id', '=', id).forUpdate(['sp']).executeTakeFirst();
        if (!old) throw new NotFoundException('ჩანაწერი ვერ მოიძებნა');
        if (old.status !== 'active') throw new ConflictException('გადამხდელი გაუქმებულია');
        const st = await this.stay(old.encounter_id, trx);
        this.notFinal(await this.invoiceLocked(trx, old.encounter_id));
        const n = (v: unknown) => (v === null ? null : Number(v));
        const vals = await this.payerTerms(trx, dto, { mode: old.mode, coverage_pct: Number(old.coverage_pct), limit_amount: n(old.limit_amount), deductible: Number(old.deductible),
          writeoff_excess: old.writeoff_excess, excluded_categories: old.excluded_categories, drg_base_rate: old.mode === 'drg' && (!dto.drg_code || dto.drg_code.toUpperCase() === old.drg_code) ? n(old.drg_base_rate) : n(old.payer_rate),
          fixed_amount: n(old.fixed_amount), drg_code: old.drg_code, drg_weight: n(old.drg_weight) }, st.patient_id);
        if (dto.seq !== undefined) vals.seq = dto.seq;
        const row = await trx.updateTable('stay_payers').set(vals as never).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
        await this.audit.log(ctx, { action: dto.override_amount !== undefined ? 'IPD_PAYER_OVERRIDE' : 'IPD_UPDATE_PAYER', entityName: 'stay_payers', entityId: id, oldData: old, newData: row }, trx);
        return row;
      });
    } catch (e) { mapPgError(e, { ux_stay_payers_seq: 'ამ რიგითობით გადამხდელი უკვე არის', chk_sp_override: 'შესწორებას სჭირდება მიზეზი (მინ. 3 სიმბოლო)' }); }
  }

  async cancelPayer(id: string, dto: ReasonDto, u: AuthUser, ctx: AuditContext) {
    if (!has(u, ...FRONT)) throw new ForbiddenException('გადამხდელს აუქმებს მიმღები ან ბილინგი');
    return this.db.transaction().execute(async (trx) => {
      const old = await trx.selectFrom('stay_payers as sp').innerJoin('payers as p', 'p.id', 'sp.payer_id').selectAll('sp').select('p.name').where('sp.id', '=', id).forUpdate(['sp']).executeTakeFirst();
      if (!old) throw new NotFoundException('ჩანაწერი ვერ მოიძებნა');
      if (old.status !== 'active') throw new ConflictException('უკვე გაუქმებულია');
      this.notFinal(await this.invoiceLocked(trx, old.encounter_id));
      await trx.updateTable('stay_payers').set({ status: 'cancelled', cancel_reason: dto.reason.trim() }).where('id', '=', id).execute();
      await this.ipd.event(trx, { encounter_id: old.encounter_id, kind: 'payer_cancelled', data: { payer: old.name, reason: dto.reason.trim() } }, u);
      await this.audit.log(ctx, { action: 'IPD_CANCEL_PAYER', entityName: 'stay_payers', entityId: id, oldData: old, newData: { reason: dto.reason } }, trx);
      return { ok: true };
    });
  }

  // ---------------------------------------------------------------- მომსახურება (ხელით)
  async addService(encounterId: string, dto: ServiceAddDto, u: AuthUser, ctx: AuditContext) {
    const s = await this.ipd.settings();
    try {
      return await this.db.transaction().execute(async (trx) => {
        const st = await this.stay(encounterId, trx);
        if (!(await this.rights(u, st.department_id, s)).services) throw new ForbiddenException('მომსახურებას ამატებს ბილინგი ან განყოფილების ექიმი / ექთანი');
        if (st.status === 'cancelled') throw new ConflictException('ჰოსპიტალიზაცია გაუქმებულია');
        const inv = await this.invoiceLocked(trx, encounterId);
        this.notFinal(inv);
        const t = await trx.selectFrom('service_tariffs').selectAll().where('id', '=', dto.tariff_id).executeTakeFirst();
        if (!t?.is_active) throw new BadRequestException('ტარიფი ვერ მოიძებნა ან გათიშულია');
        const today = (await sql<{ d: string }>`SELECT to_char(now() AT TIME ZONE ${TZ}, 'YYYY-MM-DD') AS d`.execute(trx)).rows[0].d;
        const adm = (await sql<{ d: string }>`SELECT to_char(${st.admitted_at}::timestamptz AT TIME ZONE ${TZ}, 'YYYY-MM-DD') AS d`.execute(trx)).rows[0].d;
        const day = dto.service_date ?? today;
        if (day > today || day < adm) throw new BadRequestException('თარიღი ჰოსპიტალიზაციის პერიოდს გარეთაა');
        const line = await trx.insertInto('invoice_line_items').values({ invoice_id: inv.id, tariff_id: t.id, description: t.title + (dto.note?.trim() ? ` — ${dto.note.trim()}` : ''),
          quantity: dto.quantity, unit_price: t.base_price, original_price: t.base_price, category: 'service', service_date: day, added_by: u.id }).returningAll().executeTakeFirstOrThrow();
        await this.audit.log(ctx, { action: 'IPD_ADD_SERVICE', entityName: 'invoice_line_items', entityId: line.id, newData: line }, trx);
        return line;
      });
    } catch (e) { mapPgError(e); }
  }

  async removeService(encounterId: string, lineId: string, dto: ReasonDto, u: AuthUser, ctx: AuditContext) {
    const s = await this.ipd.settings();
    try {
      return await this.db.transaction().execute(async (trx) => {
        const st = await this.stay(encounterId, trx);
        const r = await this.rights(u, st.department_id, s);
        const inv = await this.invoiceLocked(trx, encounterId);
        this.notFinal(inv);
        const line = await trx.selectFrom('invoice_line_items').selectAll().where('id', '=', lineId).where('invoice_id', '=', inv.id).executeTakeFirst();
        if (!line || line.category !== 'service' || !line.added_by) throw new NotFoundException('ხელით დამატებული მომსახურება ვერ მოიძებნა');
        if (!r.billing && line.added_by !== u.id) throw new ForbiddenException('წაშლა — ავტორი ან ბილინგი');
        await trx.deleteFrom('invoice_line_items').where('id', '=', lineId).execute();
        await this.audit.log(ctx, { action: 'IPD_REMOVE_SERVICE', entityName: 'invoice_line_items', entityId: lineId, oldData: line, newData: { reason: dto.reason.trim() } }, trx);
        return { ok: true };
      });
    } catch (e) { mapPgError(e, { chk_invoice_overpaid: 'გადახდილი თანხა აღემატება ახალ ჯამს' }); }
  }

  // ---------------------------------------------------------------- ავანსი / დაბრუნება
  async deposit(encounterId: string, dto: DepositDto, u: AuthUser, ctx: AuditContext) {
    if (!has(u, ...FRONT)) throw new ForbiddenException('ავანსს იღებს სალარო (მიმღები / ბილინგი)');
    if (dto.method === 'card_terminal' && !dto.terminal_ref?.trim()) throw new BadRequestException('ბარათით გადახდას სჭირდება ტერმინალის ტრანზაქციის ნომერი');
    return this.db.transaction().execute(async (trx) => {
      const st = await this.stay(encounterId, trx);
      if (st.status === 'cancelled') throw new ConflictException('ჰოსპიტალიზაცია გაუქმებულია');
      await this.invoiceLocked(trx, encounterId);
      if (dto.kind === 'refund') {
        const b = (await loadBilling(trx, encounterId))!;
        const max = b.finalized ? b.money.deposit_unapplied : b.money.deposit_net;
        if (dto.amount > max + 0.001) throw new ConflictException(`დასაბრუნებელი თანხა აღემატება გამოუყენებელ ავანსს (${max.toFixed(2)} ₾)`);
      }
      const no = (await sql<{ n: string }>`SELECT 'DP-' || to_char(now() AT TIME ZONE ${TZ}, 'YY') || '-' || lpad(nextval('deposit_receipt_seq')::text, 6, '0') AS n`.execute(trx)).rows[0].n;
      const d = await trx.insertInto('stay_deposits').values({ encounter_id: encounterId, kind: dto.kind, amount: dto.amount.toFixed(2), method: dto.method,
        terminal_ref: dto.method === 'card_terminal' ? dto.terminal_ref!.trim() : null, receipt_no: no, note: dto.note?.trim() || null, created_by: u.id }).returningAll().executeTakeFirstOrThrow();
      await this.ipd.event(trx, { encounter_id: encounterId, kind: dto.kind === 'deposit' ? 'deposit' : 'deposit_refund', data: { amount: d.amount, method: d.method, receipt_no: no } }, u);
      await this.audit.log(ctx, { action: dto.kind === 'deposit' ? 'IPD_DEPOSIT' : 'IPD_DEPOSIT_REFUND', entityName: 'stay_deposits', entityId: d.id, newData: d }, trx);
      return d;
    });
  }

  async voidDeposit(id: string, dto: ReasonDto, u: AuthUser, ctx: AuditContext) {
    if (!has(u, ...BILLING)) throw new ForbiddenException('ავანსის გაუქმება — მხოლოდ ბილინგი');
    return this.db.transaction().execute(async (trx) => {
      const d = await trx.selectFrom('stay_deposits').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!d) throw new NotFoundException('ჩანაწერი ვერ მოიძებნა');
      if (d.voided_at) throw new ConflictException('უკვე გაუქმებულია');
      this.notFinal(await this.invoiceLocked(trx, d.encounter_id));
      if (d.kind === 'deposit') {
        const b = (await loadBilling(trx, d.encounter_id))!;
        if (b.money.deposit_net - Number(d.amount) < -0.001) throw new ConflictException('ავანსის ნაწილი უკვე დაბრუნებულია — ჯერ გააუქმეთ დაბრუნება');
      }
      await trx.updateTable('stay_deposits').set({ voided_at: sql`now()`, voided_by: u.id, void_reason: dto.reason.trim() }).where('id', '=', id).execute();
      await this.ipd.event(trx, { encounter_id: d.encounter_id, kind: 'deposit_voided', data: { receipt_no: d.receipt_no, amount: d.amount, reason: dto.reason.trim() } }, u);
      await this.audit.log(ctx, { action: 'IPD_DEPOSIT_VOID', entityName: 'stay_deposits', entityId: id, oldData: d, newData: { reason: dto.reason } }, trx);
      return { ok: true };
    });
  }

  // ---------------------------------------------------------------- ფინალიზაცია / გახსნა
  async finalize(encounterId: string, u: AuthUser, ctx: AuditContext) {
    if (!has(u, ...BILLING)) throw new ForbiddenException('ფინალიზაცია — მხოლოდ ბილინგი');
    const s = await this.ipd.settings();
    try {
      return await this.db.transaction().execute(async (trx) => {
        const st = await this.stay(encounterId, trx);
        if (st.status !== 'discharged') throw new ConflictException('ფინანსური დახურვა — გაწერის შემდეგ');
        const inv = await this.invoiceLocked(trx, encounterId);
        this.notFinal(inv);
        await this.syncBedDays(trx, encounterId, s);
        const miss = await trx.selectFrom('stay_bed_days').select(sql<number>`count(*)::int`.as('n')).where('encounter_id', '=', encounterId).where('tariff_id', 'is', null)
          .where('package_included', '=', false).executeTakeFirstOrThrow();
        if (miss.n) throw new ConflictException({ code: 'BED_TARIFF_MISSING', message: `საწოლდღე (${miss.n}) ტარიფის გარეშეა — ადმინისტრირება → სტაციონარის ბილინგი → საწოლდღის ტარიფები` });
        // 0047: ვენტილაციის დღე ტარიფის გარეშე (თუ ვენტილაციის ბილინგი ჩართულია)
        const icu = await trx.selectFrom('system_modules').select(['enabled', 'settings']).where('code', '=', 'icu').executeTakeFirst();
        if (icu?.enabled && (icu.settings as Record<string, unknown>)?.vent_billing !== false) {
          const vm = await trx.selectFrom('stay_vent_days').select(sql<number>`count(*)::int`.as('n')).where('encounter_id', '=', encounterId).where('tariff_id', 'is', null)
            .where('package_included', '=', false).executeTakeFirstOrThrow();
          if (vm.n) throw new ConflictException({ code: 'VENT_TARIFF_MISSING', message: `ხელოვნური ვენტილაციის დღე (${vm.n}) ტარიფის გარეშეა — მოდულები → რეანიმაცია → ვენტილაციის დღის ტარიფი` });
        }
        // 0050: ოპერაცია / ანესთეზია ტარიფის გარეშე (or_sync_case_billing — syncBedDays-ში)
        const om = await trx.selectFrom('or_case_billing as b').innerJoin('or_cases as c', 'c.id', 'b.case_id').select(['c.case_no', 'b.missing'])
          .where('b.encounter_id', '=', encounterId).where(sql<boolean>`cardinality(b.missing) > 0`).execute();
        if (om.length) {
          throw new ConflictException({ code: 'OR_TARIFF_MISSING', message: `ოპერაცია ტარიფის გარეშე — ${om.map((x) => `${x.case_no}: ${x.missing.join('; ')}`).join(' | ')} (საოპერაციო → კატალოგი / ანესთეზიის ტარიფები)`,
            missing: om });
        }
        const b = (await loadBilling(trx, encounterId))!;
        for (const p of b.calc.payers) await trx.updateTable('stay_payers').set({ covered_amount: p.amount.toFixed(2) }).where('id', '=', p.id).execute();
        await trx.updateTable('invoices').set({ insurance_share: b.calc.insurance.toFixed(2), state_share: b.calc.state.toFixed(2), writeoff_amount: b.calc.writeoff.toFixed(2) })
          .where('id', '=', inv.id).execute();
        const after = await trx.selectFrom('invoices').select('patient_share').where('id', '=', inv.id).executeTakeFirstOrThrow();
        const apply = r2(Math.min(b.money.deposit_net - b.money.deposit_applied, Number(after.patient_share) - b.money.paid));
        if (apply > 0) await trx.insertInto('payments').values({ invoice_id: inv.id, amount: apply.toFixed(2), method: 'deposit', received_by: u.id }).execute();
        await trx.updateTable('invoices').set({ finalized_at: sql`now()`, finalized_by: u.id }).where('id', '=', inv.id).execute();
        const fin = (await loadBilling(trx, encounterId))!;
        await this.ipd.event(trx, { encounter_id: encounterId, kind: 'billing_finalized', data: { total: fin.money.total, patient: fin.money.patient, insurance: fin.money.insurance,
          state: fin.money.state, writeoff: fin.money.writeoff, deposit_applied: apply, due: fin.money.due, refund_due: fin.money.refund_due } }, u);
        await this.audit.log(ctx, { action: 'IPD_BILLING_FINALIZE', entityName: 'invoices', entityId: inv.id, newData: { ...fin.money, payers: fin.calc.payers } }, trx);
        return { finalized: true, money: fin.money };
      });
    } catch (e) { mapPgError(e, { chk_invoice_overpaid: 'გადახდილი თანხა აღემატება პაციენტის წილს — საჭიროა დაბრუნება' }); }
  }

  async reopen(encounterId: string, dto: ReasonDto, u: AuthUser, ctx: AuditContext) {
    if (!has(u, ...BILLING)) throw new ForbiddenException('გახსნა — მხოლოდ ბილინგი');
    return this.db.transaction().execute(async (trx) => {
      const inv = await this.invoiceLocked(trx, encounterId);
      if (!inv.finalized_at) throw new ConflictException('ინვოისი ფინალიზებული არ არის');
      const refunds = await trx.selectFrom('stay_deposits').select(sql<number>`count(*)::int`.as('n')).where('encounter_id', '=', encounterId).where('kind', '=', 'refund')
        .where('voided_at', 'is', null).where('created_at', '>', inv.finalized_at).executeTakeFirstOrThrow();
      await trx.updateTable('invoices').set({ finalized_at: null, finalized_by: null, reopen_count: sql`reopen_count + 1` }).where('id', '=', inv.id).execute();
      await trx.deleteFrom('payments').where('invoice_id', '=', inv.id).where('method', '=', 'deposit').execute();
      await trx.updateTable('invoices').set({ insurance_share: '0', state_share: '0', writeoff_amount: '0' }).where('id', '=', inv.id).execute();
      await trx.updateTable('stay_payers').set({ covered_amount: null }).where('encounter_id', '=', encounterId).execute();
      await this.ipd.event(trx, { encounter_id: encounterId, kind: 'billing_reopened', data: { reason: dto.reason.trim(), refunds_after_final: refunds.n } }, u);
      await this.audit.log(ctx, { action: 'IPD_BILLING_REOPEN', entityName: 'invoices', entityId: inv.id, oldData: { finalized_at: inv.finalized_at, patient_share: inv.patient_share }, newData: { reason: dto.reason } }, trx);
      return { finalized: false };
    });
  }

  // ---------------------------------------------------------------- სამუშაო სია / რეპორტი / რეესტრი
  async worklist(status: string) {
    const q = this.db.selectFrom('inpatient_stays as st').innerJoin('patients as p', 'p.id', 'st.patient_id').innerJoin('invoices as i', 'i.encounter_id', 'st.encounter_id')
      .leftJoin('stay_billing as sb', 'sb.encounter_id', 'st.encounter_id').leftJoin('billing_packages as pk', 'pk.id', 'sb.package_id')
      .select(['st.encounter_id', 'st.adm_no', 'st.status', 'st.admitted_at', 'st.ended_at', 'p.first_name', 'p.last_name', 'p.personal_number', 'i.invoice_number', 'i.finalized_at', 'pk.name as package_name',
        sql<string | null>`(SELECT d.name FROM bed_assignments a JOIN departments d ON d.id = a.department_id WHERE a.encounter_id = st.encounter_id AND a.end_kind IS DISTINCT FROM 'cancel'
          ORDER BY a.ended_at IS NULL DESC, a.started_at DESC, a.id DESC LIMIT 1)`.as('department_name'),
        sql<string[]>`ARRAY(SELECT py.name FROM stay_payers sp JOIN payers py ON py.id = sp.payer_id WHERE sp.encounter_id = st.encounter_id AND sp.status = 'active' ORDER BY sp.seq)`.as('payer_names')])
      .where('st.status', '<>', 'cancelled')
      .where((eb) => status === 'active' ? eb('st.status', '=', 'active')
        : status === 'unfinalized' ? eb.and([eb('st.status', '=', 'discharged'), eb('i.finalized_at', 'is', null)])
        : status === 'due' ? eb.and([eb('i.finalized_at', 'is not', null), eb('i.paid_status', '<>', 'paid')])
        : eb.and([eb('i.finalized_at', 'is not', null), eb('i.finalized_at', '>', sql<Date>`now() - interval '30 days'`)]))
      .orderBy('st.admitted_at', 'desc').limit(300);
    const rows = await q.execute();
    const s = await this.ipd.settings();
    const out = [];
    for (const r of rows) {
      if (r.status === 'active' && !r.finalized_at) await this.syncBedDays(this.db, r.encounter_id, s);
      const b = await loadBilling(this.db, r.encounter_id);
      out.push({ ...r, money: b ? Object.fromEntries(Object.entries(b.money).map(([k, v]) => [k, v.toFixed(2)])) : null });
    }
    return out;
  }

  async report(from: string, to: string) {
    const rows = await sql<{ department: string; payer_id: string | null; payer: string | null; kind: string | null; stays: number; total: string; covered: string; patient: string; writeoff: string; bed_days: number }>`
      WITH fin AS (
        SELECT i.id, i.encounter_id, i.total_amount, i.patient_share, i.writeoff_amount,
               (SELECT d.name FROM bed_assignments a JOIN departments d ON d.id = a.department_id WHERE a.encounter_id = i.encounter_id AND a.end_kind IS DISTINCT FROM 'cancel'
                 ORDER BY a.ended_at IS NULL DESC, a.started_at DESC, a.id DESC LIMIT 1) AS department
          FROM invoices i JOIN inpatient_stays st ON st.encounter_id = i.encounter_id
         WHERE i.finalized_at >= ${from}::date AND i.finalized_at < ${to}::date + 1)
      SELECT f.department, NULL::uuid AS payer_id, NULL::text AS payer, NULL::text AS kind, count(*)::int AS stays, sum(f.total_amount)::text AS total,
             coalesce(sum((SELECT sum(sp.covered_amount) FROM stay_payers sp WHERE sp.encounter_id = f.encounter_id AND sp.status = 'active')), 0)::text AS covered,
             sum(f.patient_share)::text AS patient, sum(f.writeoff_amount)::text AS writeoff,
             coalesce(sum((SELECT count(*) FROM stay_bed_days d WHERE d.encounter_id = f.encounter_id)), 0)::int AS bed_days
        FROM fin f GROUP BY f.department
      UNION ALL
      SELECT NULL, py.id, py.name, py.kind, count(DISTINCT f.id)::int, NULL, sum(sp.covered_amount)::text, NULL, NULL, NULL
        FROM fin f JOIN stay_payers sp ON sp.encounter_id = f.encounter_id AND sp.status = 'active' JOIN payers py ON py.id = sp.payer_id
       GROUP BY py.id, py.name, py.kind
       ORDER BY 1 NULLS LAST, 3`.execute(this.db);
    const dept = rows.rows.filter((r) => r.department !== null);
    const sum = (k: 'total' | 'covered' | 'patient' | 'writeoff') => r2(dept.reduce((s, r) => s + Number(r[k] ?? 0), 0)).toFixed(2);
    return { from, to, departments: dept, payers: rows.rows.filter((r) => r.payer !== null).map((r) => ({ ...r, kind_ka: PAYER_KIND_KA[r.kind!] })),
      totals: { stays: dept.reduce((s, r) => s + r.stays, 0), bed_days: dept.reduce((s, r) => s + r.bed_days, 0), total: sum('total'), covered: sum('covered'), patient: sum('patient'), writeoff: sum('writeoff') } };
  }

  /** გადამხდელის რეესტრი (CSV, Excel-ისთვის: UTF-8 BOM, „;“) — ფინალიზებული შემთხვევები პერიოდში */
  async register(payerId: string, from: string, to: string, ctx: AuditContext) {
    const p = await this.db.selectFrom('payers').select(['code', 'name']).where('id', '=', payerId).executeTakeFirst();
    if (!p) throw new NotFoundException('გადამხდელი ვერ მოიძებნა');
    const rows = await sql<Record<string, string | number | null>>`
      SELECT st.adm_no, i.invoice_number, pt.last_name || ' ' || pt.first_name AS patient, pt.personal_number,
             to_char(st.admitted_at AT TIME ZONE ${TZ}, 'DD.MM.YYYY') AS admitted, to_char(st.ended_at AT TIME ZONE ${TZ}, 'DD.MM.YYYY') AS discharged,
             (SELECT string_agg(DISTINCT d.icd10_code, ', ') FROM encounter_diagnoses d WHERE d.encounter_id = st.encounter_id AND d.diagnosis_type = 'primary') AS icd10,
             sp.policy_no, sp.guarantee_no, to_char(sp.guarantee_date, 'DD.MM.YYYY') AS guarantee_date, sp.drg_code, sp.drg_weight::text, sp.drg_base_rate::text,
             (SELECT count(*) FROM stay_bed_days b WHERE b.encounter_id = st.encounter_id)::int AS bed_days,
             i.total_amount::text AS total, sp.covered_amount::text AS covered, i.patient_share::text AS patient
        FROM stay_payers sp JOIN inpatient_stays st ON st.encounter_id = sp.encounter_id JOIN invoices i ON i.encounter_id = st.encounter_id JOIN patients pt ON pt.id = st.patient_id
       WHERE sp.payer_id = ${payerId} AND sp.status = 'active' AND i.finalized_at >= ${from}::date AND i.finalized_at < ${to}::date + 1
       ORDER BY i.finalized_at`.execute(this.db);
    const head = ['ჰოსპ. №', 'ინვოისი', 'პაციენტი', 'პირადი №', 'მოთავსება', 'გაწერა', 'ICD-10', 'პოლისი', 'საგარანტიო №', 'საგარანტიოს თარიღი', 'DRG', 'წონა', 'განაკვეთი', 'საწოლდღე', 'ჯამი', 'გადამხდელი', 'პაციენტი (თანაგადახდა)'];
    const keys = ['adm_no', 'invoice_number', 'patient', 'personal_number', 'admitted', 'discharged', 'icd10', 'policy_no', 'guarantee_no', 'guarantee_date', 'drg_code', 'drg_weight', 'drg_base_rate', 'bed_days', 'total', 'covered', 'patient_share'];
    const esc = (v: unknown) => { const t = v === null || v === undefined ? '' : String(v); return /[;"\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    const body = rows.rows.map((r) => keys.map((k) => esc(k === 'patient_share' ? r.patient : r[k])).join(';'));
    const tot = rows.rows.reduce((s, r) => s + Number(r.covered ?? 0), 0);
    const csv = '﻿' + [`${p.name} (${p.code});${from} — ${to}`, head.join(';'), ...body, `ჯამი;;;;;;;;;;;;;;;${tot.toFixed(2)};`].join('\r\n');
    await this.audit.log(ctx, { action: 'PAYER_REGISTER_EXPORT', entityName: 'payers', entityId: payerId, newData: { from, to, rows: rows.rows.length } });
    return { csv, name: `register-${p.code}-${from}-${to}.csv` };
  }

  // ---------------------------------------------------------------- PDF: კალკულაცია, ქვითარი
  private pdfDoc(title: string) {
    const FONT = join(__dirname, '..', '..', 'assets', 'fonts');
    const doc = new PDFDocument({ size: 'A4', margins: { top: 40, bottom: 50, left: 45, right: 45 }, bufferPages: true, info: { Title: title } });
    doc.registerFont('R', join(FONT, 'EmrSans-Regular.ttf')); doc.registerFont('B', join(FONT, 'EmrSans-Bold.ttf'));
    const chunks: Buffer[] = []; doc.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<Buffer>((r) => doc.on('end', () => r(Buffer.concat(chunks))));
    return { doc, done, W: doc.page.width - 90 };
  }
  private dt(d: string | Date, time = true) {
    return new Intl.DateTimeFormat('ka-GE', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', ...(time && { hour: '2-digit', minute: '2-digit', hour12: false }) }).format(new Date(d));
  }

  async calculationPdf(encounterId: string, u: AuthUser, ctx: AuditContext) {
    const v = await this.view(encounterId, u);
    if (!v.amounts_visible || !v.money) throw new ForbiddenException('თანხების ნახვის უფლება არ გაქვთ');
    const clinic = await this.db.selectFrom('clinic_settings').select(['name', 'address']).where('id', '=', 1).executeTakeFirst();
    const { doc, done, W } = this.pdfDoc(`კალკულაცია — ${v.stay.adm_no}`);
    const m = v.money as Record<string, string>;
    doc.font('B').fontSize(11).text(clinic?.name ?? '', { width: W }).font('R').fontSize(8.5).fillColor('#444')
      .text(clinic?.address ?? '', { width: W }).fillColor('black').moveDown(0.6);
    doc.font('B').fontSize(14).text('სტაციონარული მკურნალობის კალკულაცია', { width: W, align: 'center' });
    doc.font('R').fontSize(9.5).text(`${v.finalized ? 'საბოლოო' : 'შუალედური (ფინალიზებული არ არის)'} · ინვოისი ${v.invoice_number} · ${this.dt(new Date())}`, { width: W, align: 'center' }).moveDown(0.6);
    doc.font('R').fontSize(10).text(`პაციენტი: ${v.stay.last_name} ${v.stay.first_name}${v.stay.personal_number ? ` (პ/ნ ${v.stay.personal_number})` : ''}`, { width: W })
      .text(`ჰოსპიტალიზაცია: ${v.stay.adm_no} · ${this.dt(v.stay.admitted_at)} — ${v.stay.ended_at ? this.dt(v.stay.ended_at) : 'მიმდინარე'} · საწოლდღე: ${v.bed_days_count}`, { width: W });
    if (v.package) doc.text(`პაკეტი: ${String(v.package.name)} (${String(v.package.code)}) — ${Number(v.package.price).toFixed(2)} ₾`, { width: W });
    doc.moveDown(0.5);
    const col = [W - 230, 45, 65, 70, 50];   // დასახელება, რაოდ., ფასი, ჯამი, შენიშვნა
    const row = (cells: string[], bold = false, shade = false) => {
      const y = doc.y; const h = Math.max(...cells.map((c, i) => doc.font(bold ? 'B' : 'R').fontSize(8.5).heightOfString(c, { width: col[i] - 6 }))) + 5;
      if (y + h > doc.page.height - 60) doc.addPage();
      const yy = doc.y;
      if (shade) doc.rect(45, yy, W, h).fill('#f0f0f0').fillColor('black');
      let x = 45;
      cells.forEach((c, i) => { doc.font(bold ? 'B' : 'R').fontSize(8.5).text(c, x + 3, yy + 2.5, { width: col[i] - 6, align: i === 0 || i === 4 ? 'left' : 'right' }); x += col[i]; });
      doc.y = yy + h; doc.x = 45;
    };
    row(['დასახელება', 'რაოდ.', 'ფასი', 'ჯამი', ''], true, true);
    let cur = '';
    for (const l of v.lines as Record<string, unknown>[]) {
      if (l.category !== cur) { cur = String(l.category); row([String(l.category_ka), '', '', '', ''], true); }
      row([`${String(l.description)}${l.service_date ? ` · ${String(l.service_date).split('-').reverse().join('/')}` : ''}`, String(l.quantity), Number(l.unit_price).toFixed(2), Number(l.line_total).toFixed(2),
        l.package_included ? 'პაკეტში' : '']);
    }
    doc.moveDown(0.6);
    const kv = (k: string, val: string, bold = false) => { const y = doc.y; doc.font(bold ? 'B' : 'R').fontSize(10).text(k, 45, y, { width: W - 120 }); doc.text(val, 45 + W - 120, y, { width: 120, align: 'right' }); doc.x = 45; };
    kv('ჯამი (პაკეტში შემავალის გარეშე)', `${m.total} ₾`, true);
    for (const p of v.payers as Record<string, unknown>[]) {
      if (p.status !== 'active') continue;
      const c = p.calc as { amount: number; tariff: number | null; writeoff: number } | null;
      const terms = p.mode === 'drg' ? `DRG ${String(p.drg_code)} (${String(p.drg_weight)} × ${String(p.drg_base_rate)})` : p.mode === 'fixed' ? `ფიქს. ${String(p.fixed_amount)}` : `${Number(p.coverage_pct)}%`;
      kv(`${String(p.payer_name)} — ${terms}${p.guarantee_no ? `, საგარანტიო № ${String(p.guarantee_no)}` : ''}`, `${(v.finalized ? Number(p.covered_amount ?? 0) : c?.amount ?? 0).toFixed(2)} ₾`);
    }
    if (Number(m.writeoff) > 0) kv('ჩამოწერა (ტარიფს ზემოთ)', `${m.writeoff} ₾`);
    kv('პაციენტის წილი', `${m.patient} ₾`, true);
    if (Number(m.deposit_net) > 0) kv('ავანსი (დაბრუნების გამოკლებით)', `${m.deposit_net} ₾`);
    if (Number(m.paid) > 0) kv('გადახდილი', `${m.paid} ₾`);
    if (Number(m.surplus) > 0) kv('ავანსის ნაშთი (შეფასებით)', `${m.surplus} ₾`, true);
    else kv(Number(m.refund_due) > 0 ? 'დასაბრუნებელი პაციენტისთვის' : 'გადასახდელი', `${Number(m.refund_due) > 0 ? m.refund_due : m.due} ₾`, true);
    doc.moveDown(2).font('R').fontSize(9).text('ბილინგი: ____________________          პაციენტი / წარმომადგენელი: ____________________', { width: W });
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) { doc.switchToPage(i); doc.font('R').fontSize(8).fillColor('#666').text(`${v.stay.adm_no} · ${v.invoice_number} · გვ. ${i + 1}/${range.count}`, 45, doc.page.height - 35, { width: W, align: 'center', lineBreak: false }); }
    doc.end();
    await this.audit.log(ctx, { action: 'IPD_CALCULATION_PDF', entityName: 'invoices', entityId: v.invoice_number });
    return { pdf: await done, name: `calculation-${v.stay.adm_no}.pdf` };
  }

  async receiptPdf(id: string, ctx: AuditContext) {
    const d = await this.db.selectFrom('stay_deposits as d').innerJoin('inpatient_stays as st', 'st.encounter_id', 'd.encounter_id').innerJoin('patients as p', 'p.id', 'st.patient_id')
      .innerJoin('users as u', 'u.id', 'd.created_by')
      .select(['d.kind', 'd.amount', 'd.method', 'd.terminal_ref', 'd.receipt_no', 'd.note', 'd.created_at', 'd.voided_at', 'st.adm_no', 'p.first_name', 'p.last_name', 'p.personal_number',
        sql<string>`u.first_name || ' ' || u.last_name`.as('cashier')]).where('d.id', '=', id).executeTakeFirst();
    if (!d) throw new NotFoundException('ქვითარი ვერ მოიძებნა');
    const clinic = await this.db.selectFrom('clinic_settings').select(['name', 'address']).where('id', '=', 1).executeTakeFirst();
    const { doc, done, W } = this.pdfDoc(`ქვითარი ${d.receipt_no}`);
    doc.font('B').fontSize(11).text(clinic?.name ?? '', { width: W }).font('R').fontSize(8.5).text(clinic?.address ?? '', { width: W }).moveDown(0.8);
    doc.font('B').fontSize(14).text(`${d.kind === 'deposit' ? 'ავანსის მიღების' : 'თანხის დაბრუნების'} ქვითარი № ${d.receipt_no}`, { width: W, align: 'center' }).moveDown(0.8);
    if (d.voided_at) doc.font('B').fontSize(12).fillColor('#b00').text('გაუქმებულია', { width: W, align: 'center' }).fillColor('black').moveDown(0.5);
    const kv = (k: string, val: string) => { const y = doc.y; doc.font('R').fontSize(10.5).text(k, 45, y, { width: 170 }); doc.font('B').text(val, 215, y, { width: W - 170 }); doc.x = 45; doc.moveDown(0.3); };
    kv('თარიღი', this.dt(d.created_at));
    kv('პაციენტი', `${d.last_name} ${d.first_name}${d.personal_number ? ` (პ/ნ ${d.personal_number})` : ''}`);
    kv('ჰოსპიტალიზაცია', d.adm_no);
    kv('თანხა', `${Number(d.amount).toFixed(2)} ₾`);
    kv('გადახდის მეთოდი', `${METHOD_KA[d.method] ?? d.method}${d.terminal_ref ? ` (${d.terminal_ref})` : ''}`);
    if (d.note) kv('შენიშვნა', d.note);
    kv('მოლარე', d.cashier);
    doc.moveDown(2).font('R').fontSize(9.5).text('მოლარე: ____________________          პაციენტი / წარმომადგენელი: ____________________', { width: W });
    doc.end();
    await this.audit.log(ctx, { action: 'IPD_RECEIPT_PDF', entityName: 'stay_deposits', entityId: id });
    return { pdf: await done, name: `receipt-${d.receipt_no}.pdf` };
  }
}

// ================================================================= controller
@Controller('inpatient')
export class IpdBillingController {
  constructor(private readonly s: IpdBillingService) {}
  @Get('stays/:eid/billing') @Roles(...READ) view(@Param('eid', ParseUUIDPipe) eid: string, @CurrentUser() u: AuthUser) { return this.s.view(eid, u); }
  @Post('stays/:eid/billing/package') @HttpCode(200) @Roles(...FRONT)
  pkg(@Param('eid', ParseUUIDPipe) eid: string, @Body() d: PackageSetDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.setPackage(eid, d, u, auditCtx(r)); }
  @Post('stays/:eid/payers') @Roles(...FRONT)
  addPayer(@Param('eid', ParseUUIDPipe) eid: string, @Body() d: StayPayerDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.addPayer(eid, d, u, auditCtx(r)); }
  @Patch('stay-payers/:id') @Roles(...FRONT)
  updPayer(@Param('id', ParseUUIDPipe) id: string, @Body() d: StayPayerDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.updatePayer(id, d, u, auditCtx(r)); }
  @Post('stay-payers/:id/cancel') @HttpCode(200) @Roles(...FRONT)
  cancelPayer(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.cancelPayer(id, d, u, auditCtx(r)); }
  @Post('stays/:eid/services') @Roles('admin', 'billing', 'doctor', 'nurse')
  addService(@Param('eid', ParseUUIDPipe) eid: string, @Body() d: ServiceAddDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.addService(eid, d, u, auditCtx(r)); }
  @Delete('stays/:eid/services/:lid') @Roles('admin', 'billing', 'doctor', 'nurse')
  rmService(@Param('eid', ParseUUIDPipe) eid: string, @Param('lid', ParseUUIDPipe) lid: string, @Body() d: ReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.removeService(eid, lid, d, u, auditCtx(r)); }
  @Post('stays/:eid/deposits') @Roles(...FRONT)
  deposit(@Param('eid', ParseUUIDPipe) eid: string, @Body() d: DepositDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.deposit(eid, d, u, auditCtx(r)); }
  @Post('deposits/:id/void') @HttpCode(200) @Roles(...BILLING)
  voidDeposit(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.voidDeposit(id, d, u, auditCtx(r)); }
  @Get('deposits/:id/receipt') @Roles(...FRONT)
  async receipt(@Param('id', ParseUUIDPipe) id: string, @Req() r: Request, @Res({ passthrough: true }) res: Response) {
    const out = await this.s.receiptPdf(id, auditCtx(r));
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${out.name}"` });
    return new StreamableFile(out.pdf);
  }
  @Post('stays/:eid/billing/finalize') @HttpCode(200) @Roles(...BILLING)
  finalize(@Param('eid', ParseUUIDPipe) eid: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.finalize(eid, u, auditCtx(r)); }
  @Post('stays/:eid/billing/reopen') @HttpCode(200) @Roles(...BILLING)
  reopen(@Param('eid', ParseUUIDPipe) eid: string, @Body() d: ReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.reopen(eid, d, u, auditCtx(r)); }
  @Get('stays/:eid/billing/pdf') @Roles(...READ)
  async pdf(@Param('eid', ParseUUIDPipe) eid: string, @CurrentUser() u: AuthUser, @Req() r: Request, @Res({ passthrough: true }) res: Response) {
    const out = await this.s.calculationPdf(eid, u, auditCtx(r));
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${out.name}"` });
    return new StreamableFile(out.pdf);
  }
  @Get('billing/worklist') @Roles('admin', 'billing', 'receptionist', 'manager')
  worklist(@Query('status') status = 'active') { return this.s.worklist(['active', 'unfinalized', 'due', 'finalized'].includes(status) ? status : 'active'); }
  @Get('billing/report') @Roles('admin', 'billing', 'manager')
  report(@Query('from') from: string, @Query('to') to: string) {
    const ok = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d ?? '');
    if (!ok(from) || !ok(to) || from > to) throw new BadRequestException('პერიოდი: from / to (YYYY-MM-DD)');
    return this.s.report(from, to);
  }
  @Get('billing/register/:payerId') @Roles('admin', 'billing')
  async register(@Param('payerId', ParseUUIDPipe) id: string, @Query('from') from: string, @Query('to') to: string, @Req() r: Request, @Res({ passthrough: true }) res: Response) {
    const ok = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d ?? '');
    if (!ok(from) || !ok(to) || from > to) throw new BadRequestException('პერიოდი: from / to (YYYY-MM-DD)');
    const out = await this.s.register(id, from, to, auditCtx(r));
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${out.name}"` });
    return out.csv;
  }
}

@Module({ imports: [InpatientModule], providers: [IpdBillingService], controllers: [IpdBillingController], exports: [IpdBillingService] })
export class IpdBillingModule {}
