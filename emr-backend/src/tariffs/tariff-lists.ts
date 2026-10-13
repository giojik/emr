import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch,
  Post, Query, Req, Res } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsIn, IsNumber, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min,
  ValidateNested } from 'class-validator';
import type { Request, Response } from 'express';
import { sql, type RawBuilder, type Transaction } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser } from '../auth/roles';
import { withPgErrors } from '../common/pg-errors';
import { InjectDb, type Database } from '../database/database.module';
import type { DB } from '../database/db';
import { NotificationsService } from '../notifications/notifications';
import { clauseMatches, type RuleClause } from './payer-engine';
import { KIND_KA, SCOPE_KA, TARIFF_APPROVE, TARIFF_EDIT, TARIFF_READ, tariffRules } from './tariff-rules';

type Trx = Transaction<DB>;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const num = ({ value }: { value: unknown }) => (typeof value === 'string' && value.trim() !== '' ? Number(value) : value === '' ? null : value);
const KINDS = ['tariff', 'stock_item', 'stock_category'] as const;
const CATS = ['bed', 'ventilation', 'surgery', 'anesthesia', 'service', 'consult', 'lab', 'radiology', 'endoscopy', 'medication', 'supply', 'implant', 'package', 'other'] as const;

// ================================================================= DTO
export class ListCreateDto {
  @Matches(/^[A-Z0-9][A-Z0-9_.-]{1,29}$/, { message: 'კოდი: დიდი ლათინური ასოები, ციფრები, _ . -' }) code: string;
  @IsString() @Length(2, 200) name: string;
  @IsIn(['department', 'payer']) scope: 'department' | 'payer';
  @IsOptional() @IsUUID() department_id?: string;
  @IsOptional() @IsUUID() payer_id?: string;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}
export class ListUpdateDto {
  @IsOptional() @IsString() @Length(2, 200) name?: string;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string | null;
}
export class ChangeItemDto {
  @IsUUID() list_id: string;
  @IsIn(KINDS) kind: (typeof KINDS)[number];
  @IsUUID() ref: string;
  @IsIn(['set', 'end']) action: 'set' | 'end';
  @IsOptional() @Transform(num) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(99_999_999) price?: number | null;
  @IsOptional() @Transform(num) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(1000) markup_pct?: number | null;
  @IsDateString({ strict: true }) valid_from: string;
}
export class ChangeCreateDto {
  @IsString() @Length(3, 200) title: string;
  @IsString() @Length(3, 1000) reason: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(5000) @ValidateNested({ each: true }) @Type(() => ChangeItemDto) items: ChangeItemDto[];
}
export class CsvImportDto {
  @IsUUID() list_id: string;
  @IsDateString({ strict: true }) valid_from: string;
  @IsString() @Length(3, 200) title: string;
  @IsString() @Length(3, 1000) reason: string;
  @IsString() @Length(3, 2_000_000) csv: string;
}
export class DecisionDto { @IsOptional() @IsString() @MaxLength(1000) note?: string }
export class RejectDto { @IsString() @Length(3, 1000) note: string }

export class ClauseDto {
  @Type(() => Number) @Min(1) @Max(99) seq: number;
  @IsOptional() @IsString() @MaxLength(200) label?: string | null;
  @IsOptional() @IsArray() @IsIn(CATS, { each: true }) categories?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsString({ each: true }) codes?: string[];
  @IsOptional() @Transform(num) @Min(0) @Max(130) age_min?: number | null;
  @IsOptional() @Transform(num) @Min(0) @Max(130) age_max?: number | null;
  @IsOptional() @IsIn(['male', 'female', null]) sex?: 'male' | 'female' | null;
  @IsOptional() @IsArray() @ArrayMaxSize(200) @Matches(/^[A-Za-z][0-9A-Za-z.]{0,6}$/, { each: true }) dx_prefixes?: string[];
  @IsIn(['exclude', 'cover']) effect: 'exclude' | 'cover';
  @IsOptional() @Transform(num) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) coverage_pct?: number | null;
  @IsOptional() @Transform(num) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(99_999_999) line_limit?: number | null;
}
export class RuleVersionDto {
  @IsDateString({ strict: true }) valid_from: string;
  @IsOptional() @IsIn(['all', 'opd', 'ipd']) applies_to?: 'all' | 'opd' | 'ipd';
  @IsIn(['percent', 'fixed', 'drg']) mode: 'percent' | 'fixed' | 'drg';
  @Transform(num) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) coverage_pct: number;
  @IsOptional() @Transform(num) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(99_999_999) limit_amount?: number | null;
  @IsOptional() @Transform(num) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(99_999_999) deductible?: number;
  @IsOptional() @Transform(num) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(99_999_999) fixed_amount?: number | null;
  @IsOptional() @Transform(num) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(99_999_999) drg_base_rate?: number | null;
  @IsOptional() @IsBoolean() writeoff_excess?: boolean;
  @IsOptional() @Transform(num) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(99_999_999) copay_amount?: number;
  @IsOptional() @IsArray() @IsIn(CATS, { each: true }) excluded_categories?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsString({ each: true }) excluded_codes?: string[];
  @IsOptional() @IsString() @MaxLength(1000) notes?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(99) @ValidateNested({ each: true }) @Type(() => ClauseDto) clauses?: ClauseDto[];
  @IsString() @Length(3, 1000) reason: string;
}

// ================================================================= სერვისი
/**
 * სატარიფო ფენა (0054): ნუსხები, ჩანაწერები, ცვლილების მოთხოვნა / დამტკიცება, CSV, ფასის შემოწმება; გადამხდელის წესების ვერსიები (0054a).
 * ცვლილება — ერთადერთი გზა ფასის / წესის შესაცვლელად: tariff_change_approval = off → მაშინვე; required → მეორე პირი.
 */
@Injectable()
export class TariffListsService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService, private readonly notifications: NotificationsService) {}

  private async today(ex: Database | Trx = this.db) {
    return (await sql<{ d: string }>`SELECT to_char(fin_local_date(now()), 'YYYY-MM-DD') AS d`.execute(ex)).rows[0].d;
  }

  // ---------------------------------------------------------------- ნუსხები
  lists() {
    return sql<Record<string, unknown>>`
      SELECT l.id, l.code, l.name, l.scope, l.department_id, d.name AS department_name, l.payer_id, p.name AS payer_name, p.kind AS payer_kind, l.is_active, l.notes, l.created_at,
             (SELECT count(*)::int FROM tariff_list_items x WHERE x.list_id = l.id AND NOT x.superseded
                 AND (x.valid_from IS NULL OR x.valid_from <= fin_local_date(now())) AND (x.valid_to IS NULL OR x.valid_to >= fin_local_date(now()))) AS items_now,
             (SELECT count(*)::int FROM tariff_list_items x WHERE x.list_id = l.id AND NOT x.superseded AND x.valid_from > fin_local_date(now())) AS items_future
        FROM tariff_lists l LEFT JOIN departments d ON d.id = l.department_id LEFT JOIN payers p ON p.id = l.payer_id
       ORDER BY CASE l.scope WHEN 'base' THEN 1 WHEN 'department' THEN 2 ELSE 3 END, l.name`.execute(this.db).then((r) => r.rows);
  }

  async createList(dto: ListCreateDto, u: AuthUser, ctx: AuditContext) {
    if (dto.scope === 'department' && (!dto.department_id || dto.payer_id)) throw new BadRequestException('განყოფილების ნუსხა: მიუთითეთ განყოფილება');
    if (dto.scope === 'payer' && (!dto.payer_id || dto.department_id)) throw new BadRequestException('გადამხდელის ნუსხა: მიუთითეთ გადამხდელი');
    return withPgErrors(() => this.db.transaction().execute(async (trx) => {
      const l = await trx.insertInto('tariff_lists').values({ code: dto.code, name: dto.name.trim(), scope: dto.scope, department_id: dto.department_id ?? null, payer_id: dto.payer_id ?? null,
        notes: dto.notes?.trim() || null, created_by: u.id }).returningAll().executeTakeFirstOrThrow();
      await this.audit.log(ctx, { action: 'TARIFF_LIST_CREATE', entityName: 'tariff_lists', entityId: l.id, newData: l }, trx);
      return l;
    }), { tariff_lists_code_key: `კოდი ${dto.code} უკვე არსებობს`, ux_tariff_lists_dept: 'ამ განყოფილებას ნუსხა უკვე აქვს', ux_tariff_lists_payer: 'ამ გადამხდელს ნუსხა უკვე აქვს',
      tariff_lists_department_id_fkey: 'განყოფილება ვერ მოიძებნა', tariff_lists_payer_id_fkey: 'გადამხდელი ვერ მოიძებნა' });
  }

  async updateList(id: string, dto: ListUpdateDto, ctx: AuditContext) {
    return withPgErrors(() => this.db.transaction().execute(async (trx) => {
      const old = await trx.selectFrom('tariff_lists').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!old) throw new NotFoundException('ნუსხა ვერ მოიძებნა');
      if (old.scope === 'base' && dto.is_active === false) throw new BadRequestException('საბაზო ნუსხა არ ითიშება');
      const l = await trx.updateTable('tariff_lists').set({ ...(dto.name !== undefined && { name: dto.name.trim() }), ...(dto.is_active !== undefined && { is_active: dto.is_active }),
        ...(dto.notes !== undefined && { notes: dto.notes?.trim() || null }) }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await this.audit.log(ctx, { action: 'TARIFF_LIST_UPDATE', entityName: 'tariff_lists', entityId: id, oldData: old, newData: l }, trx);
      return l;
    }));
  }

  /**
   * ნუსხის ჩანაწერები თარიღზე. საბაზო — ყველა ერთეული (ტარიფი / საქონელი ფასით / კატეგორია ფასნამატით);
   * სხვა — მხოლოდ ნუსხაში არსებული + შედარებისთვის საბაზო ფასი; next — უახლოესი სამომავლო ცვლილება.
   */
  async items(listId: string, q: { date?: string; search?: string; kind?: string; all?: string }) {
    const l = await this.db.selectFrom('tariff_lists').selectAll().where('id', '=', listId).executeTakeFirst();
    if (!l) throw new NotFoundException('ნუსხა ვერ მოიძებნა');
    const date = q.date && DATE_RE.test(q.date) ? q.date : await this.today();
    const s = q.search?.trim() ? `%${q.search.trim()}%` : null;
    const kind = q.kind && (KINDS as readonly string[]).includes(q.kind) ? q.kind : null;
    const base = (await this.db.selectFrom('tariff_lists').select('id').where('scope', '=', 'base').executeTakeFirstOrThrow()).id;
    const rows = await sql<Record<string, unknown>>`
      WITH ent AS (
        SELECT 'tariff'::text AS kind, t.id AS ref, t.code, t.title AS name, t.is_active, NULL::text AS group_name FROM service_tariffs t
        UNION ALL SELECT 'stock_item', i.id, i.code, i.name, i.is_active, c.name FROM stock_items i JOIN stock_categories c ON c.id = i.category_id
        UNION ALL SELECT 'stock_category', c.id, c.code, c.name, c.is_active, NULL FROM stock_categories c)
      SELECT e.kind, e.ref, e.code, e.name, e.is_active, e.group_name,
             x.id AS item_id, x.price, x.markup_pct, to_char(x.valid_from, 'YYYY-MM-DD') AS valid_from, to_char(x.valid_to, 'YYYY-MM-DD') AS valid_to,
             b.price AS base_price, b.markup_pct AS base_markup,
             (SELECT json_build_object('valid_from', to_char(n.valid_from, 'YYYY-MM-DD'), 'price', n.price, 'markup_pct', n.markup_pct, 'end', FALSE)
                FROM tariff_list_items n WHERE n.list_id = ${listId} AND n.ref = e.ref AND NOT n.superseded AND n.valid_from > ${date}::date ORDER BY n.valid_from LIMIT 1) AS next,
             (SELECT count(*)::int FROM tariff_change_items ci JOIN tariff_changes c ON c.id = ci.change_id WHERE c.status = 'pending' AND ci.list_id = ${listId} AND ci.ref = e.ref) AS pending
        FROM ent e
        LEFT JOIN LATERAL tariff_find(${listId}, e.ref, ${date}::date) x ON TRUE
        LEFT JOIN LATERAL tariff_find(${base}, e.ref, ${date}::date) b ON TRUE
       WHERE (${kind}::text IS NULL OR e.kind = ${kind})
         AND (${s}::text IS NULL OR e.code ILIKE ${s} OR e.name ILIKE ${s})
         AND (${l.scope === 'base' || q.all === 'true'} OR x.id IS NOT NULL
              OR EXISTS (SELECT 1 FROM tariff_list_items n WHERE n.list_id = ${listId} AND n.ref = e.ref AND NOT n.superseded AND n.valid_from > ${date}::date))
         AND (x.id IS NOT NULL OR e.kind = 'tariff' OR ${l.scope !== 'base' && q.all === 'true'} OR EXISTS (SELECT 1 FROM tariff_list_items n WHERE n.list_id = ${listId} AND n.ref = e.ref))
       ORDER BY CASE e.kind WHEN 'tariff' THEN 1 WHEN 'stock_category' THEN 2 ELSE 3 END, e.code
       LIMIT 2000`.execute(this.db);
    return { list: l, date, items: rows.rows };
  }

  /** ერთეულის ისტორია ნუსხაში (შეცვლილი ჩანაწერებიც) */
  history(listId: string, ref: string) {
    return this.db.selectFrom('tariff_list_items as x').leftJoin('tariff_changes as c', 'c.id', 'x.change_id').leftJoin('users as u', 'u.id', 'x.created_by')
      .select(['x.id', 'x.price', 'x.markup_pct', sql<string | null>`to_char(x.valid_from, 'YYYY-MM-DD')`.as('valid_from'), sql<string | null>`to_char(x.valid_to, 'YYYY-MM-DD')`.as('valid_to'),
        'x.superseded', 'x.created_at', 'c.change_no', 'c.reason', sql<string | null>`u.first_name || ' ' || u.last_name`.as('by_name'),
        sql<number>`(SELECT count(*)::int FROM invoice_line_items l WHERE l.price_item_id = x.id)`.as('lines')])
      .where('x.list_id', '=', listId).where('x.ref', '=', ref).orderBy(sql`x.valid_from DESC NULLS LAST`).orderBy('x.created_at', 'desc').execute();
  }

  async csv(listId: string, date?: string) {
    const r = await this.items(listId, { date, all: 'false' });
    const esc = (v: unknown) => { const t = v === null || v === undefined ? '' : String(v); return /[;"\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    const out = ['kind;code;name;price;markup_pct;valid_from;valid_to'];
    for (const i of r.items) if (i.item_id) out.push([i.kind, i.code, i.name, i.price, i.markup_pct, i.valid_from, i.valid_to].map(esc).join(';'));
    return { name: `${r.list.code}_${r.date}.csv`, body: '﻿' + out.join('\n') + '\n' };
  }

  // ---------------------------------------------------------------- ცვლილება
  private async nextNo(trx: Trx) {
    const year = Number((await this.today(trx)).slice(0, 4));
    const { last_value } = await trx.insertInto('document_counters').values({ document_type: 'tar_TC', year, last_value: 1 })
      .onConflict((oc) => oc.columns(['document_type', 'year']).doUpdateSet({ last_value: sql`document_counters.last_value + 1` })).returning('last_value').executeTakeFirstOrThrow();
    return `TC${String(year).slice(2)}-${String(last_value).padStart(6, '0')}`;
  }

  /** ჩანაწერების შემოწმება + მიმდინარე მნიშვნელობის დამატება (prev_*) */
  private async validateItems(trx: Trx, items: ChangeItemDto[], today: string) {
    const lists = await trx.selectFrom('tariff_lists').select(['id', 'scope', 'is_active', 'name']).where('id', 'in', [...new Set(items.map((i) => i.list_id))]).execute();
    const seen = new Set<string>();
    const out: (ChangeItemDto & { prev_price: string | null; prev_markup: string | null })[] = [];
    for (const it of items) {
      const l = lists.find((x) => x.id === it.list_id);
      if (!l) throw new BadRequestException('ნუსხა ვერ მოიძებნა');
      if (it.valid_from < today) throw new BadRequestException(`მოქმედების თარიღი (${it.valid_from}) წარსულშია — ფასი იცვლება დღეიდან ან მომავლიდან; არსებული ხაზები — გადაფასებით`);
      const key = `${it.list_id}|${it.ref}|${it.valid_from}`;
      if (seen.has(key)) throw new BadRequestException('ერთი ერთეული ერთ ცვლილებაში ორჯერ (იგივე თარიღით)');
      seen.add(key);
      if (it.action === 'set') {
        if (it.kind === 'stock_category' ? it.markup_pct == null : it.price == null) throw new BadRequestException(it.kind === 'stock_category' ? 'კატეგორია: მიუთითეთ ფასნამატი %' : 'მიუთითეთ ფასი');
      } else if (l.scope === 'base' && it.kind === 'tariff') {
        throw new BadRequestException('საბაზო ნუსხიდან მომსახურების ფასი არ იშლება — გამოიყენეთ ტარიფის გათიშვა');
      }
      const tbl = it.kind === 'tariff' ? 'service_tariffs' : it.kind === 'stock_item' ? 'stock_items' : 'stock_categories';
      const ex = await trx.selectFrom(tbl).select('id').where('id', '=', it.ref).executeTakeFirst();
      if (!ex) throw new BadRequestException(`${KIND_KA[it.kind]} ვერ მოიძებნა`);
      const cur = (await sql<{ price: string | null; markup_pct: string | null }>`SELECT price, markup_pct FROM tariff_find(${it.list_id}, ${it.ref}, ${it.valid_from}::date)`.execute(trx)).rows[0];
      out.push({ ...it, prev_price: cur?.price ?? null, prev_markup: cur?.markup_pct ?? null });
    }
    return out;
  }

  async createChange(dto: ChangeCreateDto, u: AuthUser, ctx: AuditContext, source: 'manual' | 'csv' = 'manual') {
    return withPgErrors(() => this.db.transaction().execute(async (trx) => {
      const today = await this.today(trx);
      const rules = await tariffRules(trx);
      const items = await this.validateItems(trx, dto.items, today);
      const changeNo = await this.nextNo(trx);
      const c = await trx.insertInto('tariff_changes').values({ change_no: changeNo, kind: 'prices', status: 'pending', title: dto.title.trim(), reason: dto.reason.trim(), source,
        created_by: u.id, approval: rules.tariff_change_approval }).returningAll().executeTakeFirstOrThrow();
      for (let i = 0; i < items.length; i += 500) {
        await trx.insertInto('tariff_change_items').values(items.slice(i, i + 500).map((it) => ({ change_id: c.id, list_id: it.list_id, kind: it.kind, ref: it.ref, action: it.action,
          price: it.action === 'set' && it.kind !== 'stock_category' ? it.price!.toFixed(2) : null, markup_pct: it.action === 'set' && it.kind === 'stock_category' ? it.markup_pct!.toFixed(2) : null,
          valid_from: it.valid_from, prev_price: it.prev_price, prev_markup: it.prev_markup }))).execute();
      }
      await this.audit.log(ctx, { action: 'TARIFF_CHANGE_CREATE', entityName: 'tariff_changes', entityId: c.id, newData: { ...c, items: items.length, source } }, trx);
      if (rules.tariff_change_approval === 'off') return this.apply(trx, c.id, u, ctx, 'auto');
      await this.notifyApprovers(trx, c.id, `ფასის ცვლილება ${changeNo} — დასამტკიცებელი`, dto.title, u.id);
      return { ...c, items: items.length };
    }));
  }

  private async notifyApprovers(trx: Trx, id: string, title: string, body: string, except: string) {
    const ids = (await trx.selectFrom('users as u').innerJoin('user_capabilities as c', 'c.user_id', 'u.id').select('u.id').where('u.is_active', '=', true)
      .where(sql<boolean>`c.capabilities && ARRAY['admin', 'tariffs_approve']::varchar[]`).execute()).map((x) => x.id);
    for (const uid of new Set(ids)) if (uid !== except) await this.notifications.notify(uid, { kind: 'tariff_change', title, body, link: '/admin/tariffs?tab=changes', entityId: id });
  }

  /** გატარება: ფასი — tariff_set_item; წესი — ვერსიის გააქტიურება (+ payers.default_* სარკე) */
  private async apply(trx: Trx, id: string, u: AuthUser, ctx: AuditContext, note: string | null) {
    const c = await trx.selectFrom('tariff_changes').selectAll().where('id', '=', id).forUpdate().executeTakeFirstOrThrow();
    if (c.status !== 'pending') throw new ConflictException('ცვლილება უკვე გადაწყვეტილია');
    const today = await this.today(trx);
    if (c.kind === 'prices') {
      const items = await trx.selectFrom('tariff_change_items').selectAll().where('change_id', '=', id).orderBy('valid_from').execute();
      for (const it of items) {
        if (String(it.valid_from) < today) {
          throw new ConflictException(`ჩანაწერის მოქმედების თარიღი (${String(it.valid_from)}) უკვე გავიდა — უარყავით და შექმენით ახალი ცვლილება`);
        }
        await sql`SELECT tariff_set_item(${it.list_id}, ${it.kind}, ${it.ref}, ${it.action === 'set' ? it.price : null}::numeric,
          ${it.action === 'set' ? it.markup_pct : null}::numeric, ${it.valid_from}::date, ${id}, ${c.created_by})`.execute(trx);
      }
    } else {
      const vs = await trx.selectFrom('payer_rule_versions').selectAll().where('change_id', '=', id).execute();
      for (const v of vs) {
        if (v.valid_from && String(v.valid_from) < today) throw new ConflictException(`ვერსიის მოქმედების თარიღი (${String(v.valid_from)}) უკვე გავიდა — უარყავით და შექმენით ახალი`);
        await trx.updateTable('payer_rule_versions').set({ status: 'rejected', notes: sql`coalesce(notes || ' · ', '') || ${'ჩანაცვლდა ' + c.change_no}` })
          .where('payer_id', '=', v.payer_id).where('status', '=', 'active').where('valid_from', '=', v.valid_from).execute();
        await trx.updateTable('payer_rule_versions').set({ status: 'active' }).where('id', '=', v.id).execute();
        await syncPayerDefaults(trx, v.payer_id);
      }
    }
    const done = await trx.updateTable('tariff_changes').set({ status: 'applied', decided_by: u.id, decided_at: sql`now()`, applied_at: sql`now()`, decision_note: note })
      .where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    await this.audit.log(ctx, { action: 'TARIFF_CHANGE_APPLY', entityName: 'tariff_changes', entityId: id, newData: { change_no: c.change_no, by: u.id, note } }, trx);
    if (note !== 'auto' && c.created_by && c.created_by !== u.id) {
      await this.notifications.notify(c.created_by, { kind: 'tariff_change_done', title: `ცვლილება ${c.change_no} დამტკიცდა`, body: c.title, link: '/admin/tariffs?tab=changes', entityId: id });
    }
    return done;
  }

  approve(id: string, dto: DecisionDto, u: AuthUser, ctx: AuditContext) {
    return withPgErrors(() => this.db.transaction().execute(async (trx) => {
      const c = await trx.selectFrom('tariff_changes').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!c) throw new NotFoundException('ცვლილება ვერ მოიძებნა');
      if (c.status !== 'pending') throw new ConflictException('ცვლილება უკვე გადაწყვეტილია');
      if (c.created_by === u.id) throw new ForbiddenException('საკუთარ ცვლილებას ვერ დაამტკიცებთ — საჭიროა მეორე პირი');
      return this.apply(trx, id, u, ctx, dto.note?.trim() || null);
    }));
  }

  reject(id: string, dto: RejectDto, u: AuthUser, ctx: AuditContext, cancel = false) {
    return this.db.transaction().execute(async (trx) => {
      const c = await trx.selectFrom('tariff_changes').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!c) throw new NotFoundException('ცვლილება ვერ მოიძებნა');
      if (c.status !== 'pending') throw new ConflictException('ცვლილება უკვე გადაწყვეტილია');
      if (cancel && c.created_by !== u.id && !has(u, 'admin')) throw new ForbiddenException('გაუქმება — ავტორი ან admin');
      if (!cancel && c.created_by === u.id) throw new ForbiddenException('საკუთარ ცვლილებას უარყოფთ „გაუქმებით“');
      const r = await trx.updateTable('tariff_changes').set({ status: cancel ? 'cancelled' : 'rejected', decided_by: u.id, decided_at: sql`now()`, decision_note: dto.note.trim() })
        .where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      if (c.kind === 'rules') await trx.updateTable('payer_rule_versions').set({ status: 'rejected' }).where('change_id', '=', id).execute();
      await this.audit.log(ctx, { action: cancel ? 'TARIFF_CHANGE_CANCEL' : 'TARIFF_CHANGE_REJECT', entityName: 'tariff_changes', entityId: id, newData: { note: dto.note.trim() } }, trx);
      if (!cancel && c.created_by) await this.notifications.notify(c.created_by, { kind: 'tariff_change_done', title: `ცვლილება ${c.change_no} უარყოფილია`, body: dto.note.trim(), link: '/admin/tariffs?tab=changes', entityId: id });
      return r;
    });
  }

  changes(q: { status?: string; mine?: string }, u: AuthUser) {
    let qq = this.db.selectFrom('tariff_changes as c').leftJoin('users as a', 'a.id', 'c.created_by').leftJoin('users as d', 'd.id', 'c.decided_by')
      .select(['c.id', 'c.change_no', 'c.kind', 'c.status', 'c.title', 'c.reason', 'c.source', 'c.approval', 'c.created_at', 'c.decided_at', 'c.decision_note', 'c.created_by',
        sql<string | null>`a.first_name || ' ' || a.last_name`.as('created_by_name'), sql<string | null>`d.first_name || ' ' || d.last_name`.as('decided_by_name'),
        sql<number>`(SELECT count(*)::int FROM tariff_change_items i WHERE i.change_id = c.id)`.as('items'),
        sql<string | null>`(SELECT string_agg(DISTINCT p.name, ', ') FROM payer_rule_versions v JOIN payers p ON p.id = v.payer_id WHERE v.change_id = c.id)`.as('payers')])
      .orderBy('c.created_at', 'desc').limit(300);
    if (q.status && ['pending', 'applied', 'rejected', 'cancelled'].includes(q.status)) qq = qq.where('c.status', '=', q.status);
    if (q.mine === 'true') qq = qq.where('c.created_by', '=', u.id);
    return qq.execute();
  }

  async change(id: string) {
    const c = await this.db.selectFrom('tariff_changes as c').leftJoin('users as a', 'a.id', 'c.created_by').leftJoin('users as d', 'd.id', 'c.decided_by').selectAll('c')
      .select([sql<string | null>`a.first_name || ' ' || a.last_name`.as('created_by_name'), sql<string | null>`d.first_name || ' ' || d.last_name`.as('decided_by_name')])
      .where('c.id', '=', id).executeTakeFirst();
    if (!c) throw new NotFoundException('ცვლილება ვერ მოიძებნა');
    const items = (await sql<Record<string, unknown>>`
      SELECT i.id, i.list_id, l.name AS list_name, l.scope, i.kind, i.ref, i.action, i.price, i.markup_pct, to_char(i.valid_from, 'YYYY-MM-DD') AS valid_from, i.prev_price, i.prev_markup,
             coalesce(t.code, si.code, sc.code) AS code, coalesce(t.title, si.name, sc.name) AS name
        FROM tariff_change_items i JOIN tariff_lists l ON l.id = i.list_id
        LEFT JOIN service_tariffs t ON i.kind = 'tariff' AND t.id = i.ref
        LEFT JOIN stock_items si ON i.kind = 'stock_item' AND si.id = i.ref
        LEFT JOIN stock_categories sc ON i.kind = 'stock_category' AND sc.id = i.ref
       WHERE i.change_id = ${id} ORDER BY l.name, code`.execute(this.db)).rows;
    const versions = c.kind === 'rules' ? await this.versionRows(sql`v.change_id = ${id}`) : [];
    return { ...c, items, versions };
  }

  /** CSV: „kind;code;price“ ან „code;price“ (kind ნაგულისხმევად tariff); კატეგორია — markup_pct; ცარიელი ფასი — „დასრულება“ (არა საბაზოში) */
  async importCsv(dto: CsvImportDto, u: AuthUser, ctx: AuditContext) {
    const lines = dto.csv.replace(/^﻿/, '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    const sep = lines[0]?.includes(';') ? ';' : ',';
    const split = (s: string) => s.split(sep).map((x) => x.trim().replace(/^"(.*)"$/, '$1'));
    let head = split(lines[0] ?? '').map((x) => x.toLowerCase());
    const hasHead = head.includes('code');
    if (!hasHead) head = head.length >= 3 ? ['kind', 'code', 'price'] : ['code', 'price'];
    const ci = head.indexOf('code'); const ki = head.indexOf('kind'); const pi = head.indexOf('price'); const mi = head.indexOf('markup_pct');
    if (ci < 0 || (pi < 0 && mi < 0)) throw new BadRequestException('CSV: საჭიროა სვეტები code და price (ან markup_pct)');
    const errors: string[] = []; const items: ChangeItemDto[] = [];
    const rows = lines.slice(hasHead ? 1 : 0);
    if (rows.length > 5000) throw new BadRequestException('CSV: მაქსიმუმ 5000 ხაზი');
    const codes = { tariff: new Map<string, string>(), stock_item: new Map<string, string>(), stock_category: new Map<string, string>() };
    for (const t of await this.db.selectFrom('service_tariffs').select(['id', 'code']).execute()) codes.tariff.set(t.code.toUpperCase(), t.id);
    for (const t of await this.db.selectFrom('stock_items').select(['id', 'code']).execute()) codes.stock_item.set(t.code.toUpperCase(), t.id);
    for (const t of await this.db.selectFrom('stock_categories').select(['id', 'code']).execute()) codes.stock_category.set(t.code.toUpperCase(), t.id);
    rows.forEach((r, i) => {
      const c = split(r);
      const kind = (ki >= 0 ? c[ki] : 'tariff') || 'tariff';
      if (!(KINDS as readonly string[]).includes(kind)) { errors.push(`ხაზი ${i + 1}: უცნობი kind „${kind}“`); return; }
      const code = (c[ci] ?? '').toUpperCase();
      const ref = codes[kind as keyof typeof codes].get(code);
      if (!ref) { errors.push(`ხაზი ${i + 1}: კოდი „${code}“ ვერ მოიძებნა (${KIND_KA[kind]})`); return; }
      const raw = (kind === 'stock_category' ? (mi >= 0 ? c[mi] : c[pi]) : c[pi] ?? '').replace(',', '.');
      if (raw === '') { items.push({ list_id: dto.list_id, kind: kind as ChangeItemDto['kind'], ref, action: 'end', valid_from: dto.valid_from }); return; }
      const v = Number(raw);
      if (!Number.isFinite(v) || v < 0 || Math.round(v * 100) / 100 !== v) { errors.push(`ხაზი ${i + 1}: არასწორი მნიშვნელობა „${raw}“`); return; }
      items.push({ list_id: dto.list_id, kind: kind as ChangeItemDto['kind'], ref, action: 'set', valid_from: dto.valid_from,
        ...(kind === 'stock_category' ? { markup_pct: v } : { price: v }) });
    });
    if (errors.length) throw new BadRequestException({ message: `CSV: ${errors.length} შეცდომა`, errors: errors.slice(0, 50) });
    if (!items.length) throw new BadRequestException('CSV: ჩანაწერი არ არის');
    return this.createChange({ title: dto.title, reason: dto.reason, items }, u, ctx, 'csv');
  }

  // ---------------------------------------------------------------- ფასის შემოწმება (სიმულატორი)
  async quote(q: { tariff_id?: string; stock_item_id?: string; date?: string; department_id?: string; payer_id?: string; age?: string; sex?: string; dx?: string; unit_cost?: string }) {
    const date = q.date && DATE_RE.test(q.date) ? q.date : await this.today();
    const ref = q.tariff_id ?? q.stock_item_id;
    if (!ref) throw new BadRequestException('მიუთითეთ ტარიფი ან საქონელი');
    const ent = q.tariff_id
      ? await this.db.selectFrom('service_tariffs').select(['id', 'code', 'title as name']).where('id', '=', q.tariff_id).executeTakeFirst()
      : await this.db.selectFrom('stock_items as i').innerJoin('stock_categories as c', 'c.id', 'i.category_id').select(['i.id', 'i.code', 'i.name', 'i.category_id', 'c.name as category_name', 'c.kind as category_kind'])
        .where('i.id', '=', q.stock_item_id!).executeTakeFirst();
    if (!ent) throw new NotFoundException('ერთეული ვერ მოიძებნა');
    const lists = await this.db.selectFrom('tariff_lists').select(['id', 'scope', 'name', 'is_active', 'department_id', 'payer_id'])
      .where((eb) => eb.or([eb('scope', '=', 'base'), ...(q.department_id ? [eb.and([eb('scope', '=', 'department'), eb('department_id', '=', q.department_id)])] : []),
        ...(q.payer_id ? [eb.and([eb('scope', '=', 'payer'), eb('payer_id', '=', q.payer_id)])] : [])])).execute();
    const order = { payer: 1, department: 2, base: 3 } as Record<string, number>;
    lists.sort((a, b) => order[a.scope] - order[b.scope]);
    const cat = 'category_id' in ent ? ent.category_id as string : null;
    const cost = q.unit_cost ? Number(q.unit_cost) : null;
    const chain: Record<string, unknown>[] = [];
    let chosen: Record<string, unknown> | null = null;
    for (const l of lists) {
      const x = (await sql<{ id: string | null; price: string | null; markup_pct: string | null; valid_from: string | null }>`SELECT id, price, markup_pct, to_char(valid_from, 'YYYY-MM-DD') AS valid_from FROM tariff_find(${l.id}, ${ref}, ${date}::date)`.execute(this.db)).rows[0];
      let row: Record<string, unknown> = { list_id: l.id, list_name: l.name, scope: l.scope, scope_ka: SCOPE_KA[l.scope], active: l.is_active, item_id: x?.id ?? null, price: x?.price ?? null, valid_from: x?.valid_from ?? null, via: x?.id ? 'item' : null };
      if (!x?.id && cat) {
        const m = (await sql<{ id: string | null; markup_pct: string | null; valid_from: string | null }>`SELECT id, markup_pct, to_char(valid_from, 'YYYY-MM-DD') AS valid_from FROM tariff_find(${l.id}, ${cat}, ${date}::date)`.execute(this.db)).rows[0];
        if (m?.id) row = { ...row, item_id: m.id, markup_pct: m.markup_pct, valid_from: m.valid_from, via: 'category', price: cost !== null ? (Math.round(cost * (1 + Number(m.markup_pct) / 100) * 100) / 100).toFixed(2) : null };
      }
      chain.push(row);
      if (!chosen && row.item_id && l.is_active) chosen = row;
    }
    // გადამხდელის დაფარვა (ვერსია თარიღზე, პუნქტი)
    let coverage: Record<string, unknown> | null = null;
    if (q.payer_id) {
      const v = (await sql<Record<string, unknown> & { id: string | null }>`SELECT (x).* FROM (SELECT payer_rule_version_at(${q.payer_id}::uuid, ${date}::date, NULL) AS x) s`.execute(this.db)).rows[0];
      if (v?.id) {
        const cls = await this.db.selectFrom('payer_rule_clauses').selectAll().where('version_id', '=', v.id).orderBy('seq').execute();
        const category = q.tariff_id ? 'service' : ({ medication: 'medication', medical_supply: 'supply', implant: 'implant' } as Record<string, string>)[String((ent as { category_kind?: string }).category_kind)] ?? 'other';
        const line = { id: 'x', category, line_total: 0, package_included: false, code: ent.code };
        const ctx = { age: q.age ? Number(q.age) : null, sex: q.sex === 'male' || q.sex === 'female' ? q.sex : null, dx: (q.dx ?? '').split(/[ ,;]+/).filter(Boolean) };
        const rc: RuleClause[] = cls.map((c) => ({ seq: c.seq, label: c.label, categories: c.categories ?? [], codes: c.codes ?? [], age_min: c.age_min, age_max: c.age_max, sex: c.sex,
          dx_prefixes: c.dx_prefixes ?? [], effect: c.effect as 'exclude' | 'cover', coverage_pct: c.coverage_pct === null ? null : Number(c.coverage_pct), line_limit: c.line_limit === null ? null : Number(c.line_limit) }));
        const hit = rc.find((c) => clauseMatches(c, line, ctx));
        const excl = (v.excluded_categories as string[] ?? []).includes(category) || (v.excluded_codes as string[] ?? []).includes(ent.code);
        coverage = { version_id: v.id, version_no: v.version_no, mode: v.mode, coverage_pct: v.coverage_pct, deductible: v.deductible, limit_amount: v.limit_amount, copay_amount: v.copay_amount,
          clause: hit ? { seq: hit.seq, label: hit.label, effect: hit.effect, coverage_pct: hit.coverage_pct, line_limit: hit.line_limit } : null,
          covered: hit ? hit.effect === 'cover' : !excl, pct: hit?.effect === 'cover' ? hit.coverage_pct ?? Number(v.coverage_pct) : hit ? 0 : excl ? 0 : Number(v.coverage_pct) };
      }
    }
    return { entity: ent, date, chain, chosen, coverage };
  }

  // ---------------------------------------------------------------- გადამხდელის წესები (0054a)
  private async versionRows(where: RawBuilder<unknown>) {
    const vs = (await sql<Record<string, unknown> & { id: string }>`
      SELECT v.*, to_char(v.valid_from, 'YYYY-MM-DD') AS valid_from, p.name AS payer_name, c.change_no, c.status AS change_status, u.first_name || ' ' || u.last_name AS created_by_name,
             (SELECT count(*)::int FROM stay_payers sp WHERE sp.rule_version_id = v.id) AS stays
        FROM payer_rule_versions v JOIN payers p ON p.id = v.payer_id LEFT JOIN tariff_changes c ON c.id = v.change_id LEFT JOIN users u ON u.id = v.created_by
       WHERE ${where} ORDER BY v.version_no DESC`.execute(this.db)).rows;
    const cls = vs.length ? await this.db.selectFrom('payer_rule_clauses').selectAll().where('version_id', 'in', vs.map((v) => v.id)).orderBy('seq').execute() : [];
    return vs.map((v) => ({ ...v, clauses: cls.filter((c) => c.version_id === v.id) }));
  }

  async payerRules(payerId: string) {
    const p = await this.db.selectFrom('payers').selectAll().where('id', '=', payerId).executeTakeFirst();
    if (!p) throw new NotFoundException('გადამხდელი ვერ მოიძებნა');
    const today = await this.today();
    const cur = (await sql<{ id: string | null }>`SELECT (payer_rule_version_at(${payerId}::uuid, ${today}::date, NULL)).id AS id`.execute(this.db)).rows[0]?.id ?? null;
    const list = await this.db.selectFrom('tariff_lists').select(['id', 'code', 'name', 'is_active']).where('payer_id', '=', payerId).executeTakeFirst();
    return { payer: p, current_version_id: cur, price_list: list ?? null, versions: await this.versionRows(sql`v.payer_id = ${payerId}`) };
  }

  async createVersion(payerId: string, dto: RuleVersionDto, u: AuthUser, ctx: AuditContext) {
    const seqs = (dto.clauses ?? []).map((c) => c.seq);
    if (new Set(seqs).size !== seqs.length) throw new BadRequestException('პუნქტის რიგითობა (seq) მეორდება');
    for (const c of dto.clauses ?? []) {
      if (c.age_min != null && c.age_max != null && c.age_max < c.age_min) throw new BadRequestException(`პუნქტი ${c.seq}: ასაკი „მდე“ < „დან“`);
      if (c.effect === 'cover' && c.coverage_pct == null && c.line_limit == null) throw new BadRequestException(`პუნქტი ${c.seq}: „დაფარვა“ — მიუთითეთ % ან ხაზის ლიმიტი`);
    }
    if (dto.mode === 'drg' && !dto.drg_base_rate) throw new BadRequestException('DRG: მიუთითეთ საბაზისო განაკვეთი');
    if (dto.mode === 'fixed' && dto.fixed_amount == null && dto.applies_to === 'opd') throw new BadRequestException('ამბ. ფიქსირებული: მიუთითეთ თანხა');
    return withPgErrors(() => this.db.transaction().execute(async (trx) => {
      const p = await trx.selectFrom('payers').select(['id', 'name']).where('id', '=', payerId).forUpdate().executeTakeFirst();
      if (!p) throw new NotFoundException('გადამხდელი ვერ მოიძებნა');
      const today = await this.today(trx);
      if (dto.valid_from < today) throw new BadRequestException('ვერსიის მოქმედების თარიღი — დღეიდან ან მომავლიდან');
      const rules = await tariffRules(trx);
      const codes = [...new Set([...(dto.excluded_codes ?? []), ...(dto.clauses ?? []).flatMap((c) => c.codes ?? [])].map((x) => x.trim().toUpperCase()).filter(Boolean))];
      if (codes.length) {
        const known = new Set((await trx.selectFrom('service_tariffs').select('code').where('code', 'in', codes).execute()).map((x) => x.code));
        const bad = codes.filter((c) => !known.has(c));
        if (bad.length) throw new BadRequestException(`უცნობი ტარიფის კოდი: ${bad.slice(0, 10).join(', ')}`);
      }
      const no = (await trx.selectFrom('payer_rule_versions').select(sql<number>`coalesce(max(version_no), 0)::int + 1`.as('n')).where('payer_id', '=', payerId).executeTakeFirstOrThrow()).n;
      const c = await trx.insertInto('tariff_changes').values({ change_no: await this.nextNo(trx), kind: 'rules', status: 'pending', title: `${p.name} — წესები, ვერსია ${no}`,
        reason: dto.reason.trim(), created_by: u.id, approval: rules.tariff_change_approval }).returningAll().executeTakeFirstOrThrow();
      const v = await trx.insertInto('payer_rule_versions').values({ payer_id: payerId, version_no: no, status: 'pending', valid_from: dto.valid_from, applies_to: dto.applies_to ?? 'all',
        mode: dto.mode, coverage_pct: dto.coverage_pct.toFixed(2), limit_amount: dto.limit_amount == null ? null : dto.limit_amount.toFixed(2), deductible: (dto.deductible ?? 0).toFixed(2),
        fixed_amount: dto.fixed_amount == null ? null : dto.fixed_amount.toFixed(2), drg_base_rate: dto.drg_base_rate == null ? null : dto.drg_base_rate.toFixed(2),
        writeoff_excess: dto.writeoff_excess ?? false, copay_amount: (dto.copay_amount ?? 0).toFixed(2), excluded_categories: dto.excluded_categories ?? [],
        excluded_codes: (dto.excluded_codes ?? []).map((x) => x.trim().toUpperCase()).filter(Boolean), notes: dto.notes?.trim() || null, change_id: c.id, created_by: u.id })
        .returningAll().executeTakeFirstOrThrow();
      for (const cl of dto.clauses ?? []) {
        await trx.insertInto('payer_rule_clauses').values({ version_id: v.id, seq: cl.seq, label: cl.label?.trim() || null, categories: cl.categories ?? [],
          codes: (cl.codes ?? []).map((x) => x.trim().toUpperCase()).filter(Boolean), age_min: cl.age_min ?? null, age_max: cl.age_max ?? null, sex: cl.sex ?? null,
          dx_prefixes: (cl.dx_prefixes ?? []).map((x) => x.trim().toUpperCase()), effect: cl.effect, coverage_pct: cl.coverage_pct == null ? null : cl.coverage_pct.toFixed(2),
          line_limit: cl.line_limit == null ? null : cl.line_limit.toFixed(2) }).execute();
      }
      await this.audit.log(ctx, { action: 'PAYER_RULES_VERSION', entityName: 'payer_rule_versions', entityId: v.id, newData: { ...dto, version_no: no, change_no: c.change_no } }, trx);
      if (rules.tariff_change_approval === 'off') { await this.apply(trx, c.id, u, ctx, 'auto'); return { ...v, status: 'active', change_no: c.change_no }; }
      await this.notifyApprovers(trx, c.id, `გადამხდელის წესები ${c.change_no} — დასამტკიცებელი`, c.title, u.id);
      return { ...v, change_no: c.change_no };
    }), { chk_prv_drg: 'DRG: საჭიროა საბაზისო განაკვეთი', chk_prc_age: 'ასაკი „მდე“ < „დან“' });
  }

  /** worker: სამომავლო ცვლილებები ამოქმედდა → ძველი სვეტები (service_tariffs.base_price …, payers.default_*) */
  async tick() {
    await this.db.transaction().execute(async (trx) => {
      await sql`SELECT tariff_sync_base(NULL)`.execute(trx);
      for (const p of await trx.selectFrom('payers').select('id').execute()) await syncPayerDefaults(trx, p.id);
    });
  }
}

/** payers.default_* = დღეს მოქმედი ვერსია (ძველი API / ეკრანები); ტრიგერი აქ არ ქმნის ახალ ვერსიას */
export async function syncPayerDefaults(trx: Trx, payerId: string) {
  await sql`SELECT set_config('emr.tariff_apply', 'on', true)`.execute(trx);
  await sql`UPDATE payers p SET default_mode = v.mode, default_coverage_pct = v.coverage_pct, default_limit = v.limit_amount, default_deductible = v.deductible,
      drg_base_rate = coalesce(v.drg_base_rate, p.drg_base_rate), writeoff_excess = v.writeoff_excess, excluded_categories = v.excluded_categories
    FROM (SELECT (payer_rule_version_at(${payerId}::uuid, fin_local_date(now()), NULL)).*) v
   WHERE p.id = ${payerId} AND v.id IS NOT NULL
     AND (p.default_mode, p.default_coverage_pct, p.default_limit, p.default_deductible, p.writeoff_excess, p.excluded_categories, p.drg_base_rate)
         IS DISTINCT FROM (v.mode, v.coverage_pct, v.limit_amount, v.deductible, v.writeoff_excess, v.excluded_categories, coalesce(v.drg_base_rate, p.drg_base_rate))`.execute(trx);
  await sql`SELECT set_config('emr.tariff_apply', '', true)`.execute(trx);
}

// ================================================================= კონტროლერი
@Controller()
export class TariffListsController {
  constructor(private readonly s: TariffListsService) {}

  @Get('tariff-lists') @Roles(...TARIFF_READ) lists() { return this.s.lists(); }
  @Post('tariff-lists') @Roles(...TARIFF_EDIT) create(@Body() d: ListCreateDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.createList(d, u, auditCtx(r)); }
  @Patch('tariff-lists/:id') @Roles(...TARIFF_EDIT) update(@Param('id', ParseUUIDPipe) id: string, @Body() d: ListUpdateDto, @Req() r: Request) { return this.s.updateList(id, d, auditCtx(r)); }
  @Get('tariff-lists/:id/items') @Roles(...TARIFF_READ)
  items(@Param('id', ParseUUIDPipe) id: string, @Query() q: { date?: string; search?: string; kind?: string; all?: string }) { return this.s.items(id, q); }
  @Get('tariff-lists/:id/history/:ref') @Roles(...TARIFF_READ)
  history(@Param('id', ParseUUIDPipe) id: string, @Param('ref', ParseUUIDPipe) ref: string) { return this.s.history(id, ref); }
  @Get('tariff-lists/:id/csv') @Roles(...TARIFF_READ)
  async csv(@Param('id', ParseUUIDPipe) id: string, @Query('date') date: string | undefined, @Res({ passthrough: true }) res: Response) {
    const c = await this.s.csv(id, date);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${c.name}"`);
    return c.body;
  }

  @Get('tariff-changes') @Roles(...TARIFF_READ) changes(@Query() q: { status?: string; mine?: string }, @CurrentUser() u: AuthUser) { return this.s.changes(q, u); }
  @Get('tariff-changes/:id') @Roles(...TARIFF_READ) change(@Param('id', ParseUUIDPipe) id: string) { return this.s.change(id); }
  @Post('tariff-changes') @Roles(...TARIFF_EDIT) createChange(@Body() d: ChangeCreateDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.createChange(d, u, auditCtx(r)); }
  @Post('tariff-changes/import') @Roles(...TARIFF_EDIT) importCsv(@Body() d: CsvImportDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.importCsv(d, u, auditCtx(r)); }
  @Post('tariff-changes/:id/approve') @HttpCode(200) @Roles(...TARIFF_APPROVE)
  approve(@Param('id', ParseUUIDPipe) id: string, @Body() d: DecisionDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.approve(id, d, u, auditCtx(r)); }
  @Post('tariff-changes/:id/reject') @HttpCode(200) @Roles(...TARIFF_APPROVE)
  reject(@Param('id', ParseUUIDPipe) id: string, @Body() d: RejectDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.reject(id, d, u, auditCtx(r)); }
  @Post('tariff-changes/:id/cancel') @HttpCode(200) @Roles(...TARIFF_EDIT)
  cancel(@Param('id', ParseUUIDPipe) id: string, @Body() d: RejectDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.reject(id, d, u, auditCtx(r), true); }

  @Get('tariff-quote') @Roles(...TARIFF_READ, 'receptionist')
  quote(@Query() q: { tariff_id?: string; stock_item_id?: string; date?: string; department_id?: string; payer_id?: string; age?: string; sex?: string; dx?: string; unit_cost?: string }) {
    return this.s.quote(q);
  }

  @Get('payer-rules/:payerId') @Roles(...TARIFF_READ) payerRules(@Param('payerId', ParseUUIDPipe) id: string) { return this.s.payerRules(id); }
  @Post('payer-rules/:payerId/versions') @Roles(...TARIFF_EDIT)
  createVersion(@Param('payerId', ParseUUIDPipe) id: string, @Body() d: RuleVersionDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.createVersion(id, d, u, auditCtx(r)); }
}
