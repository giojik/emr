import { BadRequestException, Body, Controller, Delete, Get, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import type { Request } from 'express';
import { sql, type Transaction } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { Roles } from '../auth/decorators';
import { withPgErrors } from '../common/pg-errors';
import { InjectDb, type Database } from '../database/database.module';
import type { DB } from '../database/db';

/**
 * ბილინგის ცნობარები (0046, ადმინისტრირება → „სტაციონარის ბილინგი“):
 *   საწოლდღის ტარიფები (საწოლის ტიპი [+ განყოფილება] → ტარიფი), პაკეტები (ფასი, დღეები, შემადგენლობა),
 *   გადამხდელები (სადაზღვევო კომპანიები / სახელმწიფო პროგრამები — ნაგულისხმევი წესები), DRG ჯგუფები (წონები; CSV იმპორტი).
 * წერა — admin / billing; კითხვა — + მიმღები (ჰოსპიტალიზაციაზე გადამხდელის / პაკეტის არჩევისთვის).
 */
const W = ['admin', 'billing'] as const;
const R = ['admin', 'billing', 'receptionist', 'manager', 'doctor', 'nurse'] as const;
const money = ({ value }: { value: unknown }) => (typeof value === 'string' && value.trim() !== '' ? Number(value) : value === '' ? null : value);
export const PKG_CATEGORIES = ['service', 'consult', 'lab', 'radiology', 'endoscopy', 'medication', 'supply', 'implant'] as const;
const EXCL_CATEGORIES = ['bed', 'service', 'consult', 'lab', 'radiology', 'endoscopy', 'medication', 'supply', 'implant', 'package', 'other'] as const;
const nz = (s?: string | null) => (s?.trim() ? s.trim() : null);

// ---------------------------------------------------------------- DTO
export class BedTariffDto {
  @Matches(/^[a-z][a-z0-9_]{1,29}$/) bed_type_code: string;
  @IsOptional() @IsUUID() department_id?: string | null;
  @IsUUID() tariff_id: string;
}
class PackageItemDto {
  @IsIn(['category', 'tariff']) kind: 'category' | 'tariff';
  @IsOptional() @IsIn(PKG_CATEGORIES) category?: string;
  @IsOptional() @IsUUID() tariff_id?: string;
}
export class PackageDto {
  @IsOptional() @Matches(/^[A-Z0-9][A-Z0-9_.-]{1,29}$/, { message: 'კოდი: დიდი ლათინური ასოები, ციფრები, _ . -' }) code?: string;
  @IsOptional() @IsString() @Length(2, 200) name?: string;
  @IsOptional() @Transform(money) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(9_999_999) price?: number;
  @IsOptional() @IsBoolean() includes_bed?: boolean;
  @IsOptional() @Transform(money) @IsInt() @Min(1) @Max(365) included_days?: number | null;
  @IsOptional() @IsUUID() extra_day_tariff_id?: string | null;
  @IsOptional() @IsUUID() department_id?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string | null;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => PackageItemDto) items?: PackageItemDto[];
}
export class PayerDto {
  @IsOptional() @Matches(/^[A-Z0-9][A-Z0-9_.-]{1,29}$/, { message: 'კოდი: დიდი ლათინური ასოები, ციფრები, _ . -' }) code?: string;
  @IsOptional() @IsString() @Length(2, 200) name?: string;
  @IsOptional() @IsIn(['insurance', 'state', 'other']) kind?: 'insurance' | 'state' | 'other';
  @IsOptional() @IsString() @MaxLength(20) tax_id?: string | null;
  @IsOptional() @IsString() @MaxLength(60) contract_no?: string | null;
  @IsOptional() @IsString() @MaxLength(40) phone?: string | null;
  @IsOptional() @Transform(({ value }) => (value === '' ? null : value)) @IsEmail() email?: string | null;
  @IsOptional() @IsString() @MaxLength(300) address?: string | null;
  @IsOptional() @IsIn(['percent', 'fixed', 'drg']) default_mode?: 'percent' | 'fixed' | 'drg';
  @IsOptional() @Transform(money) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) default_coverage_pct?: number;
  @IsOptional() @Transform(money) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(99_999_999) default_limit?: number | null;
  @IsOptional() @Transform(money) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(99_999_999) default_deductible?: number;
  @IsOptional() @Transform(money) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(9_999_999) drg_base_rate?: number | null;
  @IsOptional() @IsBoolean() writeoff_excess?: boolean;
  @IsOptional() @IsArray() @IsIn(EXCL_CATEGORIES, { each: true }) excluded_categories?: string[];
  @IsOptional() @IsString() @MaxLength(2000) notes?: string | null;
  @IsOptional() @IsBoolean() is_active?: boolean;
}
export class DrgDto {
  @IsOptional() @Matches(/^[A-Z0-9][A-Z0-9_.-]{0,19}$/, { message: 'DRG კოდი: დიდი ლათინური ასოები, ციფრები' }) code?: string;
  @IsOptional() @IsString() @Length(2, 300) title?: string;
  @IsOptional() @Transform(money) @IsNumber({ maxDecimalPlaces: 4 }) @Min(0.0001) @Max(9999) relative_weight?: number;
  @IsOptional() @Transform(money) @IsNumber({ maxDecimalPlaces: 1 }) @Min(0.1) @Max(999) alos?: number | null;
  @IsOptional() @IsString() @MaxLength(10) mdc?: string | null;
  @IsOptional() @IsBoolean() is_active?: boolean;
}
export class DrgImportDto {
  @IsString() @Length(5, 900_000) csv: string;
  @IsOptional() @IsBoolean() deactivate_missing?: boolean;
  @IsOptional() @IsBoolean() dry_run?: boolean;
}

// ---------------------------------------------------------------- სერვისი
@Injectable()
export class BillingConfigService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService) {}

  // --- საწოლდღე
  bedTariffs() {
    return this.db.selectFrom('bed_day_tariffs as b').innerJoin('bed_types as t', 't.code', 'b.bed_type_code').innerJoin('service_tariffs as s', 's.id', 'b.tariff_id')
      .leftJoin('departments as d', 'd.id', 'b.department_id')
      .select(['b.id', 'b.bed_type_code', 't.name as bed_type_name', 'b.department_id', 'd.name as department_name', 'b.tariff_id', 's.code as tariff_code', 's.title as tariff_title', 's.base_price', 's.is_active as tariff_active'])
      .orderBy('t.sort_order').orderBy(sql`b.department_id IS NOT NULL`).orderBy('d.name').execute();
  }
  setBedTariff(dto: BedTariffDto, ctx: AuditContext) {
    return withPgErrors(() => this.db.transaction().execute(async (trx) => {
      const dep = dto.department_id ?? null;
      const old = await trx.selectFrom('bed_day_tariffs').selectAll().where('bed_type_code', '=', dto.bed_type_code)
        .where((eb) => (dep ? eb('department_id', '=', dep) : eb('department_id', 'is', null))).executeTakeFirst();
      const row = old
        ? await trx.updateTable('bed_day_tariffs').set({ tariff_id: dto.tariff_id }).where('id', '=', old.id).returningAll().executeTakeFirstOrThrow()
        : await trx.insertInto('bed_day_tariffs').values({ bed_type_code: dto.bed_type_code, department_id: dep, tariff_id: dto.tariff_id }).returningAll().executeTakeFirstOrThrow();
      await this.audit.log(ctx, { action: 'SET_BED_DAY_TARIFF', entityName: 'bed_day_tariffs', entityId: row.id, oldData: old ?? null, newData: row }, trx);
      return row;
    }), { bed_day_tariffs_bed_type_code_fkey: 'საწოლის ტიპი არ არსებობს', bed_day_tariffs_tariff_id_fkey: 'ტარიფი არ არსებობს', bed_day_tariffs_department_id_fkey: 'განყოფილება არ არსებობს' });
  }
  async deleteBedTariff(id: string, ctx: AuditContext) {
    const old = await this.db.deleteFrom('bed_day_tariffs').where('id', '=', id).returningAll().executeTakeFirst();
    if (!old) throw new NotFoundException('ჩანაწერი ვერ მოიძებნა');
    await this.audit.log(ctx, { action: 'DELETE_BED_DAY_TARIFF', entityName: 'bed_day_tariffs', entityId: id, oldData: old });
    return { ok: true };
  }

  // --- პაკეტები
  async packages(includeInactive: boolean) {
    let q = this.db.selectFrom('billing_packages as p').leftJoin('service_tariffs as x', 'x.id', 'p.extra_day_tariff_id').leftJoin('departments as d', 'd.id', 'p.department_id')
      .selectAll('p').select(['x.title as extra_day_tariff_title', 'x.base_price as extra_day_price', 'd.name as department_name',
        sql<{ kind: string; category: string | null; tariff_id: string | null; tariff_code: string | null; tariff_title: string | null }[]>`coalesce((SELECT json_agg(json_build_object(
          'kind', i.kind, 'category', i.category, 'tariff_id', i.tariff_id, 'tariff_code', t.code, 'tariff_title', t.title) ORDER BY i.kind, i.category, t.code)
          FROM billing_package_items i LEFT JOIN service_tariffs t ON t.id = i.tariff_id WHERE i.package_id = p.id), '[]')`.as('items'),
        sql<number>`(SELECT count(*)::int FROM stay_billing sb WHERE sb.package_id = p.id)`.as('used')])
      .orderBy('p.code');
    if (!includeInactive) q = q.where('p.is_active', '=', true);
    return q.execute();
  }
  private checkItems(items?: PackageItemDto[]) {
    for (const i of items ?? []) {
      if (i.kind === 'category' && !i.category) throw new BadRequestException('პაკეტის შემადგენლობა: მიუთითეთ კატეგორია');
      if (i.kind === 'tariff' && !i.tariff_id) throw new BadRequestException('პაკეტის შემადგენლობა: მიუთითეთ ტარიფი');
    }
  }
  createPackage(dto: PackageDto, ctx: AuditContext) {
    if (!dto.code || !dto.name || dto.price === undefined) throw new BadRequestException('კოდი, დასახელება და ფასი სავალდებულოა');
    if (dto.includes_bed === false && dto.included_days) throw new BadRequestException('დღეების რაოდენობა — მხოლოდ თუ საწოლდღე შედის პაკეტში');
    this.checkItems(dto.items);
    return withPgErrors(() => this.db.transaction().execute(async (trx) => {
      const includesBed = dto.includes_bed ?? true;
      const p = await trx.insertInto('billing_packages').values({ code: dto.code!, name: dto.name!.trim(), price: dto.price!.toFixed(2), includes_bed: includesBed,
        included_days: includesBed ? dto.included_days ?? null : null, extra_day_tariff_id: dto.extra_day_tariff_id ?? null, department_id: dto.department_id ?? null,
        notes: nz(dto.notes) }).returningAll().executeTakeFirstOrThrow();
      await this.saveItems(trx, p.id, dto.items ?? []);
      await this.audit.log(ctx, { action: 'CREATE_BILLING_PACKAGE', entityName: 'billing_packages', entityId: p.id, newData: { ...p, items: dto.items ?? [] } }, trx);
      return p;
    }), { billing_packages_code_key: `პაკეტის კოდი ${dto.code} უკვე არსებობს`, billing_packages_check: 'დღეების რაოდენობა — მხოლოდ თუ საწოლდღე შედის' });
  }
  private async saveItems(trx: Transaction<DB>, id: string, items: PackageItemDto[]) {
    await trx.deleteFrom('billing_package_items').where('package_id', '=', id).execute();
    const seen = new Set<string>();
    for (const i of items) {
      const key = `${i.kind}:${i.category ?? i.tariff_id}`;
      if (seen.has(key)) continue; seen.add(key);
      await trx.insertInto('billing_package_items').values({ package_id: id, kind: i.kind, category: i.kind === 'category' ? i.category! : null, tariff_id: i.kind === 'tariff' ? i.tariff_id! : null }).execute();
    }
  }
  updatePackage(id: string, dto: PackageDto, ctx: AuditContext) {
    this.checkItems(dto.items);
    return withPgErrors(() => this.db.transaction().execute(async (trx) => {
      const old = await trx.selectFrom('billing_packages').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!old) throw new NotFoundException('პაკეტი ვერ მოიძებნა');
      const includesBed = dto.includes_bed ?? old.includes_bed;
      if (!includesBed && dto.included_days) throw new BadRequestException('დღეების რაოდენობა — მხოლოდ თუ საწოლდღე შედის პაკეტში');
      const p = await trx.updateTable('billing_packages').set({
        ...(dto.name !== undefined && { name: dto.name.trim() }), ...(dto.price !== undefined && { price: dto.price.toFixed(2) }),
        includes_bed: includesBed, included_days: includesBed ? (dto.included_days !== undefined ? dto.included_days : old.included_days) : null,
        ...(dto.extra_day_tariff_id !== undefined && { extra_day_tariff_id: dto.extra_day_tariff_id }), ...(dto.department_id !== undefined && { department_id: dto.department_id }),
        ...(dto.notes !== undefined && { notes: nz(dto.notes) }), ...(dto.is_active !== undefined && { is_active: dto.is_active }),
      }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      if (dto.items) await this.saveItems(trx, id, dto.items);
      await this.audit.log(ctx, { action: 'UPDATE_BILLING_PACKAGE', entityName: 'billing_packages', entityId: id, oldData: old, newData: { ...p, ...(dto.items && { items: dto.items }) } }, trx);
      return p;
    }));
  }

  // --- გადამხდელები
  payers(includeInactive: boolean) {
    let q = this.db.selectFrom('payers as p').selectAll('p')
      .select(sql<number>`(SELECT count(*)::int FROM stay_payers sp WHERE sp.payer_id = p.id AND sp.status = 'active')`.as('used')).orderBy('p.kind').orderBy('p.name');
    if (!includeInactive) q = q.where('p.is_active', '=', true);
    return q.execute();
  }
  private payerVals(dto: PayerDto) {
    const m = (v: number | null | undefined) => (v === undefined ? undefined : v === null ? null : v.toFixed(2));
    return Object.fromEntries(Object.entries({
      name: dto.name?.trim(), kind: dto.kind, tax_id: dto.tax_id === undefined ? undefined : nz(dto.tax_id), contract_no: dto.contract_no === undefined ? undefined : nz(dto.contract_no),
      phone: dto.phone === undefined ? undefined : nz(dto.phone), email: dto.email === undefined ? undefined : nz(dto.email), address: dto.address === undefined ? undefined : nz(dto.address),
      default_mode: dto.default_mode, default_coverage_pct: m(dto.default_coverage_pct), default_limit: m(dto.default_limit), default_deductible: m(dto.default_deductible),
      drg_base_rate: m(dto.drg_base_rate), writeoff_excess: dto.writeoff_excess, excluded_categories: dto.excluded_categories, notes: dto.notes === undefined ? undefined : nz(dto.notes),
      is_active: dto.is_active,
    }).filter(([, v]) => v !== undefined));
  }
  createPayer(dto: PayerDto, ctx: AuditContext) {
    if (!dto.code || !dto.name || !dto.kind) throw new BadRequestException('კოდი, დასახელება და ტიპი სავალდებულოა');
    return withPgErrors(() => this.db.transaction().execute(async (trx) => {
      const p = await trx.insertInto('payers').values({ code: dto.code!, ...this.payerVals(dto) } as never).returningAll().executeTakeFirstOrThrow();
      await this.audit.log(ctx, { action: 'CREATE_PAYER', entityName: 'payers', entityId: p.id, newData: p }, trx);
      return p;
    }), { payers_code_key: `გადამხდელის კოდი ${dto.code} უკვე არსებობს`, payers_check: 'DRG რეჟიმს სჭირდება საბაზისო განაკვეთი' });
  }
  updatePayer(id: string, dto: PayerDto, ctx: AuditContext) {
    return withPgErrors(() => this.db.transaction().execute(async (trx) => {
      const old = await trx.selectFrom('payers').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!old) throw new NotFoundException('გადამხდელი ვერ მოიძებნა');
      const p = await trx.updateTable('payers').set(this.payerVals(dto) as never).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await this.audit.log(ctx, { action: 'UPDATE_PAYER', entityName: 'payers', entityId: id, oldData: old, newData: p }, trx);
      return p;
    }), { payers_check: 'DRG რეჟიმს სჭირდება საბაზისო განაკვეთი' });
  }

  // --- DRG
  async drg(search?: string, includeInactive = false, limit = 200) {
    let q = this.db.selectFrom('drg_groups').selectAll().orderBy('code').limit(Math.min(limit, 2000));
    if (!includeInactive) q = q.where('is_active', '=', true);
    const s = search?.trim();
    if (s) q = q.where((eb) => eb.or([eb('code', 'ilike', `${s}%`), eb('title', 'ilike', `%${s}%`)]));
    const rows = await q.execute();
    const stats = await this.db.selectFrom('drg_groups').select([sql<number>`count(*)::int`.as('total'), sql<number>`count(*) FILTER (WHERE is_active)::int`.as('active')]).executeTakeFirstOrThrow();
    return { rows, ...stats };
  }
  createDrg(dto: DrgDto, ctx: AuditContext) {
    if (!dto.code || !dto.title || dto.relative_weight === undefined) throw new BadRequestException('კოდი, დასახელება და ფარდობითი წონა სავალდებულოა');
    return withPgErrors(() => this.db.transaction().execute(async (trx) => {
      const r = await trx.insertInto('drg_groups').values({ code: dto.code!, title: dto.title!.trim(), relative_weight: String(dto.relative_weight), alos: dto.alos == null ? null : String(dto.alos),
        mdc: nz(dto.mdc) }).returningAll().executeTakeFirstOrThrow();
      await this.audit.log(ctx, { action: 'CREATE_DRG', entityName: 'drg_groups', entityId: r.code, newData: r }, trx);
      return r;
    }), { drg_groups_pkey: `DRG ${dto.code} უკვე არსებობს` });
  }
  updateDrg(code: string, dto: DrgDto, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const old = await trx.selectFrom('drg_groups').selectAll().where('code', '=', code).forUpdate().executeTakeFirst();
      if (!old) throw new NotFoundException('DRG ვერ მოიძებნა');
      const r = await trx.updateTable('drg_groups').set({
        ...(dto.title !== undefined && { title: dto.title.trim() }), ...(dto.relative_weight !== undefined && { relative_weight: String(dto.relative_weight) }),
        ...(dto.alos !== undefined && { alos: dto.alos === null ? null : String(dto.alos) }), ...(dto.mdc !== undefined && { mdc: nz(dto.mdc) }),
        ...(dto.is_active !== undefined && { is_active: dto.is_active }),
      }).where('code', '=', code).returningAll().executeTakeFirstOrThrow();
      await this.audit.log(ctx, { action: 'UPDATE_DRG', entityName: 'drg_groups', entityId: code, oldData: old, newData: r }, trx);
      return r;
    });
  }

  /**
   * CSV იმპორტი: სვეტები code;title;weight[;alos[;mdc]] — გამყოფი ; ან , ან TAB; პირველი სტრიქონი სათაური შეიძლება იყოს.
   * არსებული კოდი → განახლდება (წონა / დასახელება), ახალი → დაემატება; deactivate_missing → ფაილში არმყოფი გაითიშება.
   * უკვე მინიჭებულ ჰოსპიტალიზაციებზე წონა / განაკვეთი შენახულია მინიჭების მომენტისთვის და არ იცვლება.
   */
  async importDrg(dto: DrgImportDto, ctx: AuditContext) {
    const text = dto.csv.replace(/^﻿/, '');
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const sep = [';', '\t', ','].find((s) => lines[0]?.includes(s)) ?? ';';
    const unq = (s: string) => s.trim().replace(/^"(.*)"$/, '$1').replace(/""/g, '"').trim();
    const parse = (l: string) => {   // ბრჭყალებში გამყოფის მხარდაჭერა
      const out: string[] = []; let cur = ''; let q = false;
      for (const ch of l) {
        if (ch === '"') { q = !q; cur += ch; } else if (ch === sep && !q) { out.push(unq(cur)); cur = ''; } else cur += ch;
      }
      out.push(unq(cur)); return out;
    };
    const rows: { code: string; title: string; weight: number; alos: number | null; mdc: string | null }[] = [];
    const errors: string[] = [];
    lines.forEach((l, i) => {
      const c = parse(l);
      const w = Number((c[2] ?? '').replace(',', '.'));
      if (i === 0 && !Number.isFinite(w)) return;   // სათაური
      const code = (c[0] ?? '').toUpperCase();
      if (!/^[A-Z0-9][A-Z0-9_.-]{0,19}$/.test(code)) { errors.push(`სტრ. ${i + 1}: კოდი „${c[0] ?? ''}“ არასწორია`); return; }
      if (!c[1] || c[1].length < 2) { errors.push(`სტრ. ${i + 1}: დასახელება აკლია`); return; }
      if (!Number.isFinite(w) || w <= 0) { errors.push(`სტრ. ${i + 1}: წონა „${c[2] ?? ''}“ არასწორია`); return; }
      const alos = c[3] ? Number(c[3].replace(',', '.')) : null;
      rows.push({ code, title: c[1].slice(0, 300), weight: Math.round(w * 10000) / 10000, alos: alos && Number.isFinite(alos) && alos > 0 ? Math.round(alos * 10) / 10 : null, mdc: c[4]?.slice(0, 10) || null });
    });
    const dup = rows.map((r) => r.code).filter((c, i, a) => a.indexOf(c) !== i);
    if (dup.length) errors.push(`გამეორებული კოდები: ${[...new Set(dup)].slice(0, 10).join(', ')}`);
    if (!rows.length && !errors.length) errors.push('ფაილში ჩანაწერი ვერ მოიძებნა');
    const existing = new Map((await this.db.selectFrom('drg_groups').select(['code', 'relative_weight', 'title', 'is_active']).execute()).map((r) => [r.code, r]));
    const added = rows.filter((r) => !existing.has(r.code)).length;
    const changed = rows.filter((r) => { const e = existing.get(r.code); return e && (Number(e.relative_weight) !== r.weight || e.title !== r.title || !e.is_active); }).length;
    const codes = new Set(rows.map((r) => r.code));
    const missing = [...existing.values()].filter((e) => e.is_active && !codes.has(e.code)).length;
    const summary = { rows: rows.length, added, changed, deactivated: dto.deactivate_missing ? missing : 0, missing, errors: errors.slice(0, 50) };
    if (errors.length || dto.dry_run) return { ...summary, applied: false };
    await this.db.transaction().execute(async (trx) => {
      for (const r of rows) {
        await trx.insertInto('drg_groups').values({ code: r.code, title: r.title, relative_weight: String(r.weight), alos: r.alos === null ? null : String(r.alos), mdc: r.mdc, is_active: true })
          .onConflict((oc) => oc.column('code').doUpdateSet({ title: r.title, relative_weight: String(r.weight), alos: r.alos === null ? null : String(r.alos), mdc: r.mdc, is_active: true })).execute();
      }
      if (dto.deactivate_missing && codes.size) await trx.updateTable('drg_groups').set({ is_active: false }).where('code', 'not in', [...codes]).where('is_active', '=', true).execute();
      await this.audit.log(ctx, { action: 'IMPORT_DRG', entityName: 'drg_groups', entityId: 'import', newData: summary }, trx);
    });
    return { ...summary, applied: true };
  }
}

@Controller('billing')
export class BillingConfigController {
  constructor(private readonly s: BillingConfigService) {}

  @Get('bed-tariffs') @Roles(...R) bedTariffs() { return this.s.bedTariffs(); }
  @Put('bed-tariffs') @Roles(...W) setBedTariff(@Body() d: BedTariffDto, @Req() r: Request) { return this.s.setBedTariff(d, auditCtx(r)); }
  @Delete('bed-tariffs/:id') @Roles(...W) delBedTariff(@Param('id', ParseUUIDPipe) id: string, @Req() r: Request) { return this.s.deleteBedTariff(id, auditCtx(r)); }

  @Get('packages') @Roles(...R) packages(@Query('include_inactive') inc?: string) { return this.s.packages(inc === 'true'); }
  @Post('packages') @Roles(...W) createPackage(@Body() d: PackageDto, @Req() r: Request) { return this.s.createPackage(d, auditCtx(r)); }
  @Patch('packages/:id') @Roles(...W) updatePackage(@Param('id', ParseUUIDPipe) id: string, @Body() d: PackageDto, @Req() r: Request) { return this.s.updatePackage(id, d, auditCtx(r)); }

  @Get('payers') @Roles(...R) payers(@Query('include_inactive') inc?: string) { return this.s.payers(inc === 'true'); }
  @Post('payers') @Roles(...W) createPayer(@Body() d: PayerDto, @Req() r: Request) { return this.s.createPayer(d, auditCtx(r)); }
  @Patch('payers/:id') @Roles(...W) updatePayer(@Param('id', ParseUUIDPipe) id: string, @Body() d: PayerDto, @Req() r: Request) { return this.s.updatePayer(id, d, auditCtx(r)); }

  @Get('drg') @Roles(...R) drg(@Query('search') q?: string, @Query('include_inactive') inc?: string, @Query('limit') limit?: string) { return this.s.drg(q, inc === 'true', Number(limit) || 200); }
  @Post('drg') @Roles(...W) createDrg(@Body() d: DrgDto, @Req() r: Request) { return this.s.createDrg(d, auditCtx(r)); }
  @Post('drg/import') @Roles(...W) importDrg(@Body() d: DrgImportDto, @Req() r: Request) { return this.s.importDrg(d, auditCtx(r)); }
  @Patch('drg/:code') @Roles(...W) updateDrg(@Param('code') code: string, @Body() d: DrgDto, @Req() r: Request) { return this.s.updateDrg(code.toUpperCase(), d, auditCtx(r)); }
}

@Module({ controllers: [BillingConfigController], providers: [BillingConfigService] })
export class BillingConfigModule {}
