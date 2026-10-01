import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, Res, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import type { Request, Response } from 'express';
import { sql, type Transaction } from 'kysely';
import { memoryStorage } from 'multer';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser, type Role } from '../auth/roles';
import { mapPgError } from '../common/pg-errors';
import { InjectDb, type Database } from '../database/database.module';
import type { DB } from '../database/db';
import { normalizeBarcode, parseBarcode } from './gs1';
import { readCsv, readXlsx, writeXlsx } from './xlsx';

/** კატალოგის ნახვა — ყველა, ვინც საწყობთან / მოთხოვნებთან / ხარჯთან მუშაობს */
export const STOCK_READ: Role[] = ['admin', 'storekeeper', 'stock_manager', 'pharmacist', 'nurse', 'doctor', 'lab_doctor', 'lab_manager', 'diagnostic', 'manager', 'viewer', 'accountant'];
/** საქონლის დამატება / რედაქტირება */
export const CATALOG_EDIT: Role[] = ['admin', 'stock_manager', 'pharmacist'];
/** სტრუქტურა: ლოკაციები, კატეგორიები, ერთეულები, პარამეტრები */
export const STOCK_ADMIN: Role[] = ['admin', 'stock_manager'];

export const CATEGORY_KINDS = ['medication', 'medical_supply', 'implant', 'reagent', 'qc_material', 'household', 'office', 'other'] as const;
export const LOCATION_KINDS = ['central', 'pharmacy', 'household', 'department', 'operating', 'cssd', 'lab', 'icu', 'other'] as const;
export const STORAGE = ['room', 'cool', 'fridge', 'frozen'] as const;

/** ცარიელი სტრიქონი → null, trim; undefined ველები ამოიშლება */
export function clean<T extends object>(dto: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined).map(([k, v]) => [k, typeof v === 'string' ? v.trim() || null : v]));
}
const PG_MSG = {
  ux_stock_item_barcodes_active: 'ეს შტრიხკოდი უკვე მიბმულია სხვა საქონელზე',
  ux_stock_item_packs_name: 'ასეთი შეფუთვა უკვე არსებობს',
  ux_stock_item_packs_qty: 'ამ რაოდენობის შეფუთვა უკვე არსებობს',
  stock_items_code_key: 'ეს კოდი სხვა საქონელს აქვს',
  stock_items_generic_required: 'მედიკამენტს ჯენერიკი (INN + ფორმა + დოზა) სავალდებულოა',
  stock_items_check: 'სერიული აღრიცხვა / ვადა მოითხოვს ლოტის აღრიცხვას',
  stock_items_check1: 'ვადის აღრიცხვა მოითხოვს ლოტის აღრიცხვას',
  ux_stock_suppliers_tax: 'ამ საიდენტიფიკაციო კოდით მომწოდებელი უკვე არსებობს',
  stock_locations_code_key: 'ლოკაციის ეს კოდი დაკავებულია',
  stock_categories_code_key: 'კატეგორიის ეს კოდი დაკავებულია',
  stock_units_pkey: 'ერთეულის ეს კოდი დაკავებულია',
};
const IMPORT_COLS: [string, string, string][] = [
  ['category', 'კატეგორია', 'კოდი ან დასახელება: MED, MEDSUP, IMPLANT, REAGENT, QC, HOUSE, OFFICE'],
  ['name', 'დასახელება', 'სავაჭრო დასახელება — სავალდებულო'],
  ['code', 'კოდი', 'შიდა კოდი (ცარიელი — ავტომატურად)'],
  ['inn', 'INN', 'მედიკამენტზე სავალდებულო: საერთაშორისო დასახელება ქართულად'],
  ['inn_latin', 'INN (ლათ.)', 'მაგ. Ceftriaxone'],
  ['atc', 'ATC', 'მაგ. J01DD04'],
  ['form', 'ფორმა', 'კოდი ან დასახელება: TAB, CAP, INJ_SOL, INJ_PWD, INF_SOL…'],
  ['strength', 'დოზა', 'მაგ. 1 გ, 500 მგ/5 მლ'],
  ['unit', 'საბაზო ერთეული', 'კოდი ან დასახელება: tablet, vial, ampoule, piece, ml…'],
  ['pack', 'შეფუთვა', 'მაგ. კოლოფი (ცარიელი — მხოლოდ საბაზო ერთეული)'],
  ['pack_qty', 'რაოდენობა შეფუთვაში', 'საბაზო ერთეულებში, > 1'],
  ['barcode', 'შტრიხკოდი', 'EAN / GTIN (შეფუთვის, თუ შეფუთვა მითითებულია)'],
  ['manufacturer', 'მწარმოებელი', ''],
  ['country', 'ქვეყანა', ''],
  ['storage', 'შენახვა', 'ოთახის / გრილი / მაცივარი / საყინულე'],
  ['controlled', 'კონტროლის კლასი', 'ნარკოტიკული / ფსიქოტროპული / პრეკურსორი / ძლიერმოქმედი (მხოლოდ ფარმაცევტი)'],
];
const STORAGE_KA: Record<string, string> = { room: 'ოთახის', cool: 'გრილი', fridge: 'მაცივარი', frozen: 'საყინულე' };
const CONTROLLED_KA: Record<string, string> = { narcotic: 'ნარკოტიკული', psychotropic: 'ფსიქოტროპული', precursor: 'პრეკურსორი', potent: 'ძლიერმოქმედი' };
class DryRun extends Error {}

interface PackIn { id?: string; name: string; qty_base: number; is_receipt_default?: boolean }
interface BarcodeIn { barcode: string; pack_index?: number; kind?: 'gtin' | 'internal' }

@Injectable()
export class StockCatalogService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService) {}

  // ---------------------------------------------------------------- ცნობარები + პარამეტრები
  async refs() {
    const [units, forms, routes, categories, settings, allergen_groups] = await Promise.all([
      this.db.selectFrom('stock_units').selectAll().orderBy('sort_order').orderBy('name').execute(),
      this.db.selectFrom('med_dosage_forms').selectAll().orderBy('sort_order').execute(),
      this.db.selectFrom('med_routes').selectAll().orderBy('sort_order').execute(),
      this.db.selectFrom('stock_categories').selectAll().orderBy('is_active', 'desc').orderBy('sort_order').orderBy('name').execute(),
      this.settings(),
      this.db.selectFrom('allergen_groups').select(['code', 'name']).orderBy('name').execute(),
    ]);
    return { units, forms, routes, categories, settings, allergen_groups };
  }
  settings() { return this.db.selectFrom('stock_settings').selectAll().where('id', '=', 1).executeTakeFirstOrThrow(); }
  async putSettings(dto: { costing_method?: 'fifo' | 'average'; short_expiry_months?: number; reason: string }, u: AuthUser, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const old = await trx.selectFrom('stock_settings').selectAll().where('id', '=', 1).forUpdate().executeTakeFirstOrThrow();
      const set = { ...(dto.costing_method && { costing_method: dto.costing_method }), ...(dto.short_expiry_months !== undefined && { short_expiry_months: dto.short_expiry_months }) };
      const r = await trx.updateTable('stock_settings').set({ ...set, updated_by: u.id, updated_at: sql`now()` }).where('id', '=', 1).returningAll().executeTakeFirstOrThrow();
      await this.audit.log(ctx, { action: 'UPDATE_STOCK_SETTINGS', entityName: 'stock_settings', entityId: '1', oldData: old, newData: { ...set, reason: dto.reason.trim() } }, trx);
      return r;
    });
  }

  async saveUnit(code: string | null, dto: { code?: string; name?: string; is_active?: boolean; sort_order?: number }, ctx: AuditContext) {
    try {
      const r = code ? await this.db.updateTable('stock_units').set(clean({ name: dto.name, is_active: dto.is_active, sort_order: dto.sort_order })).where('code', '=', code).returningAll().executeTakeFirst()
        : await this.db.insertInto('stock_units').values({ code: dto.code!, name: dto.name!.trim(), sort_order: dto.sort_order ?? 500 }).returningAll().executeTakeFirst();
      if (!r) throw new NotFoundException('ერთეული ვერ მოიძებნა');
      await this.audit.log(ctx, { action: code ? 'UPDATE_STOCK_UNIT' : 'CREATE_STOCK_UNIT', entityName: 'stock_units', entityId: r.code, newData: dto });
      return r;
    } catch (e) { mapPgError(e, PG_MSG); }
  }

  async saveCategory(id: string | null, dto: CategoryDto, ctx: AuditContext) {
    if (dto.parent_id && dto.parent_id === id) throw new BadRequestException('კატეგორია საკუთარი თავის ქვეკატეგორია ვერ იქნება');
    const vals = clean(dto);
    try {
      const r = id ? await this.db.updateTable('stock_categories').set(vals).where('id', '=', id).returningAll().executeTakeFirst()
        : await this.db.insertInto('stock_categories').values({ sort_order: 500, ...(vals as { code: string; name: string; kind: string }) }).returningAll().executeTakeFirst();
      if (!r) throw new NotFoundException('კატეგორია ვერ მოიძებნა');
      await this.audit.log(ctx, { action: id ? 'UPDATE_STOCK_CATEGORY' : 'CREATE_STOCK_CATEGORY', entityName: 'stock_categories', entityId: r.id, newData: vals });
      return r;
    } catch (e) { mapPgError(e, PG_MSG); }
  }

  // ---------------------------------------------------------------- საქონელი
  private itemsBase(db: Database | Transaction<DB> = this.db) {
    return db.selectFrom('stock_items as i').innerJoin('stock_categories as c', 'c.id', 'i.category_id')
      .leftJoin('med_generics as g', 'g.id', 'i.generic_id').leftJoin('med_dosage_forms as f', 'f.code', 'g.form_code').innerJoin('stock_units as un', 'un.code', 'i.base_unit')
      .selectAll('i')
      .select(['c.name as category_name', 'c.kind as category_kind', 'un.name as base_unit_name', 'g.inn', 'g.strength', 'g.atc_code', 'g.controlled_class', 'g.high_alert', 'g.patient_only', 'f.name as form_name',
        sql<number | null>`coalesce(i.expiry_warn_days, c.expiry_warn_days)`.as('effective_warn_days'),
        sql<string>`coalesce(i.billing_mode, c.billing_mode)`.as('effective_billing_mode'),
        sql<{ id: string; name: string; qty_base: string; is_receipt_default: boolean }[]>`coalesce((SELECT json_agg(json_build_object('id', p.id, 'name', p.name, 'qty_base', p.qty_base, 'is_receipt_default', p.is_receipt_default) ORDER BY p.qty_base) FROM stock_item_packs p WHERE p.item_id = i.id AND p.is_active), '[]')`.as('packs'),
        sql<{ id: string; barcode: string; pack_id: string | null; kind: string }[]>`coalesce((SELECT json_agg(json_build_object('id', b.id, 'barcode', b.barcode, 'pack_id', b.pack_id, 'kind', b.kind) ORDER BY b.created_at) FROM stock_item_barcodes b WHERE b.item_id = i.id AND b.is_active), '[]')`.as('barcodes')]);
  }
  items(q: { search?: string; category_id?: string; generic_id?: string; kind?: string; all?: boolean; limit?: number }) {
    let x = this.itemsBase();
    if (!q.all) x = x.where('i.is_active', '=', true);
    if (q.category_id) x = x.where((eb) => eb.or([eb('i.category_id', '=', q.category_id!), eb('c.parent_id', '=', q.category_id!)]));
    if (q.kind) x = x.where('c.kind', '=', q.kind);
    if (q.generic_id) x = x.where('i.generic_id', '=', q.generic_id);
    const s = q.search?.trim();
    if (s) {
      const bc = normalizeBarcode(s); const like = `%${s.toLowerCase()}%`;
      x = x.where((eb) => eb.or([eb(sql`lower(i.name)`, 'like', like), eb(sql`lower(i.code)`, 'like', like), eb(sql`lower(g.inn)`, 'like', like), eb(sql`lower(coalesce(g.inn_latin, ''))`, 'like', like),
        eb(sql`upper(coalesce(g.atc_code, ''))`, 'like', `${s.toUpperCase()}%`), eb(sql`lower(coalesce(i.manufacturer, ''))`, 'like', like),
        eb.exists(eb.selectFrom('stock_item_barcodes as b').select('b.id').whereRef('b.item_id', '=', 'i.id').where('b.barcode', '=', bc))]));
    }
    return x.orderBy('i.is_active', 'desc').orderBy('i.name').limit(Math.min(q.limit ?? 200, 1000)).execute();
  }
  async item(id: string) {
    const r = await this.itemsBase().where('i.id', '=', id).executeTakeFirst();
    if (!r) throw new NotFoundException('საქონელი ვერ მოიძებნა');
    return r;
  }

  private async editGuard(u: AuthUser, categoryId: string, trx: Transaction<DB>) {
    const c = await trx.selectFrom('stock_categories').select(['kind', 'is_active', 'requires_lot', 'requires_expiry', 'serial_tracked']).where('id', '=', categoryId).executeTakeFirst();
    if (!c) throw new BadRequestException('კატეგორია ვერ მოიძებნა');
    // მედიკამენტს მართავს ფარმაცევტი / მენეჯერი; ფარმაცევტი — მხოლოდ მედიკამენტს და სამედიცინო მასალას
    if (!has(u, 'admin', 'stock_manager') && !['medication', 'medical_supply', 'implant'].includes(c.kind)) throw new ForbiddenException('ფარმაცევტი ამ კატეგორიის საქონელს ვერ არედაქტირებს');
    return c;
  }
  private validPacks(packs: PackIn[]) {
    if (packs.filter((p) => p.is_receipt_default).length > 1) throw new BadRequestException('მიღების ნაგულისხმევი შეიძლება იყოს მხოლოდ ერთი შეფუთვა');
    const q = new Set<number>(); const n = new Set<string>();
    for (const p of packs) {
      if (q.has(p.qty_base) || n.has(p.name.trim().toLowerCase())) throw new BadRequestException(`შეფუთვა „${p.name}“ / ${p.qty_base} მეორდება`);
      q.add(p.qty_base); n.add(p.name.trim().toLowerCase());
    }
  }
  private async addBarcodes(trx: Transaction<DB>, itemId: string, list: BarcodeIn[], packIds: string[]) {
    for (const b of list) {
      const code = normalizeBarcode(b.barcode);
      if (!/^[A-Z0-9._/-]{4,60}$/.test(code)) throw new BadRequestException(`შტრიხკოდი „${b.barcode}“: მხოლოდ ლათინური ასოები, ციფრები, . _ / -`);
      const dup = await trx.selectFrom('stock_item_barcodes as b').innerJoin('stock_items as i', 'i.id', 'b.item_id').select(['i.name', 'i.id']).where('b.barcode', '=', code).where('b.is_active', '=', true).executeTakeFirst();
      if (dup) throw new ConflictException(dup.id === itemId ? `შტრიხკოდი ${code} უკვე მიბმულია` : `შტრიხკოდი ${code} უკვე მიბმულია: „${dup.name}“`);
      const packId = b.pack_index !== undefined ? packIds[b.pack_index] : null;
      if (b.pack_index !== undefined && !packId) throw new BadRequestException('შტრიხკოდის შეფუთვა ვერ მოიძებნა');
      await trx.insertInto('stock_item_barcodes').values({ item_id: itemId, pack_id: packId, barcode: code, kind: b.kind ?? (/^\d{14}$/.test(code) ? 'gtin' : 'internal') }).execute();
    }
  }

  async createItem(dto: ItemDto, u: AuthUser, ctx: AuditContext) {
    try {
      const id = await this.db.transaction().execute(async (trx) => {
        const c = await this.editGuard(u, dto.category_id!, trx);
        const { packs = [], barcodes = [], ...rest } = dto;
        this.validPacks(packs);
        const vals = clean(rest);
        if (vals.code == null) delete vals.code;
        const it = await trx.insertInto('stock_items').values({
          ...(vals as { name: string; category_id: string; base_unit: string }),
          requires_lot: dto.requires_lot ?? c.requires_lot, requires_expiry: dto.requires_expiry ?? (dto.requires_lot === false ? false : c.requires_expiry),
          serial_tracked: dto.serial_tracked ?? (dto.requires_lot === false ? false : c.serial_tracked), created_by: u.id,
        }).returning('id').executeTakeFirstOrThrow();
        const packIds: string[] = [];
        for (const p of packs) packIds.push((await trx.insertInto('stock_item_packs').values({ item_id: it.id, name: p.name.trim(), qty_base: p.qty_base, is_receipt_default: !!p.is_receipt_default }).returning('id').executeTakeFirstOrThrow()).id);
        await this.addBarcodes(trx, it.id, barcodes, packIds);
        await this.audit.log(ctx, { action: 'CREATE_STOCK_ITEM', entityName: 'stock_items', entityId: it.id, newData: dto }, trx);
        return it.id;
      });
      return this.item(id);
    } catch (e) { mapPgError(e, PG_MSG); }
  }

  async updateItem(id: string, dto: ItemDto, u: AuthUser, ctx: AuditContext) {
    try {
      await this.db.transaction().execute(async (trx) => {
        const old = await trx.selectFrom('stock_items').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
        if (!old) throw new NotFoundException('საქონელი ვერ მოიძებნა');
        await this.editGuard(u, old.category_id, trx);
        if (dto.category_id && dto.category_id !== old.category_id) await this.editGuard(u, dto.category_id, trx);
        const { packs: _p, barcodes: _b, ...rest } = dto;
        const vals = clean(rest);
        if (vals.code === null) delete vals.code;
        if (dto.requires_lot === false) { vals.requires_expiry = false; vals.serial_tracked = false; }
        // საბაზო ერთეულის შეცვლა — მოძრაობების შემდეგ აიკრძალება (0031)
        if (Object.keys(vals).length) await trx.updateTable('stock_items').set(vals).where('id', '=', id).execute();
        await this.audit.log(ctx, { action: 'UPDATE_STOCK_ITEM', entityName: 'stock_items', entityId: id, oldData: old, newData: vals }, trx);
      });
      return this.item(id);
    } catch (e) { mapPgError(e, PG_MSG); }
  }

  /** შეფუთვების სრული სია: არსებული (id) — განახლდება, ახალი — დაემატება, სიაში არმყოფი — ითიშება (მისი შტრიხკოდებიც) */
  async setPacks(id: string, packs: PackIn[], u: AuthUser, ctx: AuditContext) {
    this.validPacks(packs);
    try {
      await this.db.transaction().execute(async (trx) => {
        const it = await trx.selectFrom('stock_items').select(['id', 'category_id']).where('id', '=', id).forUpdate().executeTakeFirst();
        if (!it) throw new NotFoundException('საქონელი ვერ მოიძებნა');
        await this.editGuard(u, it.category_id, trx);
        const keep = packs.filter((p) => p.id).map((p) => p.id!);
        const own = await trx.selectFrom('stock_item_packs').select('id').where('item_id', '=', id).execute();
        if (keep.some((k) => !own.some((o) => o.id === k))) throw new BadRequestException('შეფუთვა ამ საქონელს არ ეკუთვნის');
        await trx.updateTable('stock_item_packs').set({ is_active: false, is_receipt_default: false }).where('item_id', '=', id).execute();
        for (const p of packs) {
          const v = { name: p.name.trim(), qty_base: p.qty_base, is_receipt_default: !!p.is_receipt_default, is_active: true };
          if (p.id) await trx.updateTable('stock_item_packs').set(v).where('id', '=', p.id).execute();
          else await trx.insertInto('stock_item_packs').values({ item_id: id, ...v }).execute();
        }
        let q = trx.updateTable('stock_item_barcodes').set({ is_active: false }).where('item_id', '=', id).where('pack_id', 'is not', null);
        if (keep.length) q = q.where('pack_id', 'not in', keep);
        await q.execute();
        await this.audit.log(ctx, { action: 'SET_STOCK_ITEM_PACKS', entityName: 'stock_items', entityId: id, newData: packs }, trx);
      });
      return this.item(id);
    } catch (e) { mapPgError(e, PG_MSG); }
  }

  async addBarcode(id: string, dto: { barcode: string; pack_id?: string | null; kind?: 'gtin' | 'internal' }, u: AuthUser, ctx: AuditContext) {
    try {
      await this.db.transaction().execute(async (trx) => {
        const it = await trx.selectFrom('stock_items').select(['id', 'category_id']).where('id', '=', id).executeTakeFirst();
        if (!it) throw new NotFoundException('საქონელი ვერ მოიძებნა');
        await this.editGuard(u, it.category_id, trx);
        let packIds: string[] = [];
        if (dto.pack_id) {
          const p = await trx.selectFrom('stock_item_packs').select('id').where('id', '=', dto.pack_id).where('item_id', '=', id).where('is_active', '=', true).executeTakeFirst();
          if (!p) throw new BadRequestException('შეფუთვა ამ საქონელს არ ეკუთვნის');
          packIds = [p.id];
        }
        await this.addBarcodes(trx, id, [{ barcode: dto.barcode, kind: dto.kind, pack_index: dto.pack_id ? 0 : undefined }], packIds);
        await this.audit.log(ctx, { action: 'ADD_STOCK_BARCODE', entityName: 'stock_items', entityId: id, newData: dto }, trx);
      });
      return this.item(id);
    } catch (e) { mapPgError(e, PG_MSG); }
  }
  async removeBarcode(id: string, bid: string, u: AuthUser, ctx: AuditContext) {
    const it = await this.db.selectFrom('stock_items').select(['id', 'category_id']).where('id', '=', id).executeTakeFirst();
    if (!it) throw new NotFoundException('საქონელი ვერ მოიძებნა');
    await this.db.transaction().execute(async (trx) => {
      await this.editGuard(u, it.category_id, trx);
      const r = await trx.updateTable('stock_item_barcodes').set({ is_active: false }).where('id', '=', bid).where('item_id', '=', id).where('is_active', '=', true).returning('barcode').executeTakeFirst();
      if (!r) throw new NotFoundException('შტრიხკოდი ვერ მოიძებნა');
      await this.audit.log(ctx, { action: 'REMOVE_STOCK_BARCODE', entityName: 'stock_items', entityId: id, oldData: r }, trx);
    });
    return this.item(id);
  }

  /** სკანირება: GS1 / EAN → საქონელი + შეფუთვა + ლოტი/ვადა/სერიული */
  async scan(raw: string) {
    const p = parseBarcode(raw);
    const hit = await this.db.selectFrom('stock_item_barcodes as b').leftJoin('stock_item_packs as p', 'p.id', 'b.pack_id')
      .select(['b.item_id', 'b.pack_id', 'p.name as pack_name', 'p.qty_base']).where('b.barcode', '=', p.normalized).where('b.is_active', '=', true).executeTakeFirst();
    const item = hit ? await this.item(hit.item_id) : null;
    const warnings = [...p.warnings];
    if (!item) warnings.push('შტრიხკოდი კატალოგში არ არის — მიაბით საქონელს');
    else {
      if (!item.is_active) warnings.push('საქონელი გათიშულია');
      if (item.requires_lot && !p.lot) warnings.push('ლოტი კოდში არ არის — შეიყვანეთ ხელით');
      if (item.requires_expiry && !p.expiry) warnings.push('ვადა კოდში არ არის — შეიყვანეთ ხელით');
      if (item.serial_tracked && !p.serial) warnings.push('სერიული ნომერი კოდში არ არის — შეიყვანეთ ხელით');
    }
    return { parsed: { ...p, warnings: undefined }, item, pack: hit?.pack_id ? { id: hit.pack_id, name: hit.pack_name, qty_base: hit.qty_base } : null, warnings };
  }

  // ---------------------------------------------------------------- მომწოდებლები
  suppliers(all: boolean, search?: string) {
    let q = this.db.selectFrom('stock_suppliers').selectAll().orderBy('is_active', 'desc').orderBy('name');
    if (!all) q = q.where('is_active', '=', true);
    if (search?.trim()) q = q.where((eb) => eb.or([eb(sql`lower(name)`, 'like', `%${search.trim().toLowerCase()}%`), eb('tax_id', 'like', `${search.trim()}%`)]));
    return q.execute();
  }
  async saveSupplier(id: string | null, dto: SupplierDto, ctx: AuditContext) {
    const vals = clean(dto);
    try {
      const r = id ? await this.db.updateTable('stock_suppliers').set(vals).where('id', '=', id).returningAll().executeTakeFirst()
        : await this.db.insertInto('stock_suppliers').values(vals as { name: string }).returningAll().executeTakeFirst();
      if (!r) throw new NotFoundException('მომწოდებელი ვერ მოიძებნა');
      await this.audit.log(ctx, { action: id ? 'UPDATE_STOCK_SUPPLIER' : 'CREATE_STOCK_SUPPLIER', entityName: 'stock_suppliers', entityId: r.id, newData: vals });
      return r;
    } catch (e) { mapPgError(e, PG_MSG); }
  }

  // ---------------------------------------------------------------- ლოკაციები
  locations(all: boolean) {
    let q = this.db.selectFrom('stock_locations as l').leftJoin('departments as d', 'd.id', 'l.department_id')
      .selectAll('l').select(['d.name as department_name', 'd.code as department_code']).orderBy('l.is_active', 'desc').orderBy('l.sort_order').orderBy('l.name');
    if (!all) q = q.where('l.is_active', '=', true);
    return q.execute();
  }
  async saveLocation(id: string | null, dto: LocationDto, ctx: AuditContext) {
    const vals = clean(dto);
    try {
      const r = await this.db.transaction().execute(async (trx) => {
        const old = id ? await trx.selectFrom('stock_locations').selectAll().where('id', '=', id).forUpdate().executeTakeFirst() : undefined;
        if (id && !old) throw new NotFoundException('ლოკაცია ვერ მოიძებნა');
        if (old?.kind === 'transit') throw new BadRequestException('„გზაში“ სისტემური ლოკაციაა — არ იცვლება');
        const kind = (vals.kind as string | undefined) ?? old?.kind; const dep = 'department_id' in vals ? vals.department_id : old?.department_id;
        if (kind === 'department' && !dep) throw new BadRequestException('განყოფილების ქვესაწყობს განყოფილება სჭირდება');
        const row = id ? await trx.updateTable('stock_locations').set(vals).where('id', '=', id).returningAll().executeTakeFirstOrThrow()
          : await trx.insertInto('stock_locations').values(vals as { code: string; name: string; kind: string }).returningAll().executeTakeFirstOrThrow();
        await this.audit.log(ctx, { action: id ? 'UPDATE_STOCK_LOCATION' : 'CREATE_STOCK_LOCATION', entityName: 'stock_locations', entityId: row.id, oldData: old, newData: vals }, trx);
        return row;
      });
      return r;
    } catch (e) { mapPgError(e, PG_MSG); }
  }

  // ---------------------------------------------------------------- იმპორტი (Excel / CSV)
  template() {
    const rows = [IMPORT_COLS.map((c) => c[1]), IMPORT_COLS.map((c) => c[2]),
      ['MED', 'Rocephin', '', 'ცეფტრიაქსონი', 'Ceftriaxone', 'J01DD04', 'INJ_PWD', '1 გ', 'vial', 'კოლოფი', '1', '', 'Roche', 'შვეიცარია', 'ოთახის', ''],
      ['MEDSUP', 'ხელთათმანი ნიტრილის M', '', '', '', '', '', '', 'pair', 'კოლოფი', '50', '', '', '', 'ოთახის', '']];
    return writeXlsx('საქონელი', rows, [14, 30, 12, 20, 18, 10, 12, 14, 14, 14, 12, 18, 18, 14, 12, 22]);
  }

  /** commit=false — მხოლოდ შემოწმება (ცვლილება არ ინახება) */
  async import(buf: Buffer, fileName: string, commit: boolean, u: AuthUser, ctx: AuditContext) {
    let rows: string[][];
    try { rows = /\.csv$|\.txt$/i.test(fileName) ? readCsv(buf.toString('utf8')) : readXlsx(buf); }
    catch (e) { throw new BadRequestException(`ფაილი ვერ წავიკითხე: ${(e as Error).message}. გამოიყენეთ .xlsx ან CSV (UTF-8)`); }
    const head = (rows.shift() ?? []).map((h) => h.trim().toLowerCase());
    const col: Record<string, number> = {};
    IMPORT_COLS.forEach(([k, ka]) => { const i = head.findIndex((h) => h === ka.toLowerCase() || h === k); if (i >= 0) col[k] = i; });
    if (col.name === undefined || col.category === undefined || col.unit === undefined) throw new BadRequestException('სავალდებულო სვეტები: „კატეგორია“, „დასახელება“, „საბაზო ერთეული“ (გადმოწერეთ შაბლონი)');
    if (rows.length > 5000) throw new BadRequestException('ერთ ფაილში მაქსიმუმ 5000 სტრიქონი');
    const canClinical = has(u, 'admin', 'pharmacist');
    const [cats, forms, units] = await Promise.all([this.db.selectFrom('stock_categories').select(['id', 'code', 'name', 'kind', 'requires_lot', 'requires_expiry', 'serial_tracked']).where('is_active', '=', true).execute(),
      this.db.selectFrom('med_dosage_forms').select(['code', 'name']).where('is_active', '=', true).execute(), this.db.selectFrom('stock_units').select(['code', 'name']).where('is_active', '=', true).execute()]);
    const pick = <T extends { code: string; name: string }>(list: T[], v: string) => list.find((x) => x.code.toLowerCase() === v.toLowerCase() || x.name.toLowerCase() === v.toLowerCase());
    const rev = (m: Record<string, string>, v: string) => Object.keys(m).find((k) => k === v.toLowerCase() || m[k] === v.toLowerCase());
    const report: { row: number; status: 'create' | 'skip' | 'error'; name: string; message?: string; generic?: 'new' | 'existing' }[] = [];
    let created = 0; let genericsCreated = 0;

    const run = async (trx: Transaction<DB>) => {
      const seenBarcodes = new Set<string>();
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i]; const v = (k: string) => (col[k] !== undefined ? (r[col[k]] ?? '').trim() : '');
        if (!r.some((x) => x?.trim())) continue;
        if (i === 0 && v('name').startsWith('სავაჭრო დასახელება')) continue;      // შაბლონის მინიშნებების სტრიქონი
        const rowNo = i + 2; const name = v('name');
        const err = (m: string) => report.push({ row: rowNo, status: 'error', name, message: m });
        if (name.length < 2) { err('დასახელება ცარიელია'); continue; }
        const cat = pick(cats, v('category')); if (!cat) { err(`უცნობი კატეგორია „${v('category')}“`); continue; }
        if (!canClinical && !has(u, 'stock_manager') && !['medication', 'medical_supply', 'implant'].includes(cat.kind)) { err('ამ კატეგორიის იმპორტის უფლება არ გაქვთ'); continue; }
        const unit = pick(units, v('unit')); if (!unit) { err(`უცნობი ერთეული „${v('unit')}“`); continue; }
        const storage = v('storage') ? rev(STORAGE_KA, v('storage')) : 'room'; if (!storage) { err(`შენახვა: „${v('storage')}“ — ოთახის / გრილი / მაცივარი / საყინულე`); continue; }
        const controlled = v('controlled') ? rev(CONTROLLED_KA, v('controlled')) : null;
        if (v('controlled') && !controlled) { err(`უცნობი კონტროლის კლასი „${v('controlled')}“`); continue; }
        if (controlled && !canClinical) { err('კონტროლის კლასს უთითებს მხოლოდ ფარმაცევტი'); continue; }
        const packQty = v('pack') ? Number(v('pack_qty').replace(',', '.')) : null;
        if (v('pack') && !(packQty !== null && packQty > 1)) { err('„რაოდენობა შეფუთვაში“ უნდა იყოს > 1'); continue; }
        const bc = v('barcode') ? normalizeBarcode(v('barcode')) : null;
        if (bc && !/^[A-Z0-9._/-]{4,60}$/.test(bc)) { err(`შტრიხკოდი „${v('barcode')}“ არასწორია`); continue; }
        if (bc && (seenBarcodes.has(bc) || await trx.selectFrom('stock_item_barcodes').select('id').where('barcode', '=', bc).where('is_active', '=', true).executeTakeFirst())) {
          report.push({ row: rowNo, status: 'skip', name, message: `შტრიხკოდი ${bc} უკვე არსებობს` }); continue;
        }
        const code = v('code') || null;
        if (code && !/^[A-Za-z0-9_.-]{2,30}$/.test(code)) { err(`კოდი „${code}“ — ლათინური ასოები, ციფრები, _ . -`); continue; }
        const dupName = await trx.selectFrom('stock_items').select('id').where('is_active', '=', true).where(sql`lower(name)`, '=', name.toLowerCase())
          .where(sql`lower(coalesce(manufacturer, ''))`, '=', v('manufacturer').toLowerCase()).executeTakeFirst();
        const dupCode = code ? await trx.selectFrom('stock_items').select('id').where('code', '=', code).executeTakeFirst() : undefined;
        if (dupName || dupCode) { report.push({ row: rowNo, status: 'skip', name, message: dupCode ? `კოდი ${code} უკვე არსებობს` : 'იგივე დასახელება და მწარმოებელი უკვე არსებობს' }); continue; }
        // ჯენერიკი
        let genericId: string | null = null; let gstat: 'new' | 'existing' | undefined;
        if (cat.kind === 'medication' || v('inn')) {
          const form = pick(forms, v('form'));
          if (!v('inn') || !form) { err(cat.kind === 'medication' ? 'მედიკამენტს სჭირდება INN და ფორმა' : `უცნობი ფორმა „${v('form')}“`); continue; }
          const atc = v('atc').toUpperCase() || null;
          if (atc && !/^[A-Z]([0-9]{2}([A-Z]([A-Z]([0-9]{2})?)?)?)?$/.test(atc)) { err(`ATC „${atc}“ არასწორია`); continue; }
          const g = await trx.selectFrom('med_generics').select(['id', 'controlled_class']).where('is_active', '=', true).where(sql`lower(btrim(inn))`, '=', v('inn').toLowerCase())
            .where('form_code', '=', form.code).where(sql`lower(coalesce(btrim(strength), ''))`, '=', v('strength').toLowerCase()).executeTakeFirst();
          if (g) { genericId = g.id; gstat = 'existing'; if (controlled && g.controlled_class !== controlled && canClinical) await trx.updateTable('med_generics').set({ controlled_class: controlled }).where('id', '=', g.id).execute(); }
          else {
            genericId = (await trx.insertInto('med_generics').values({ inn: v('inn'), inn_latin: v('inn_latin') || null, atc_code: atc, form_code: form.code, strength: v('strength') || null,
              controlled_class: controlled, created_by: u.id }).returning('id').executeTakeFirstOrThrow()).id;
            gstat = 'new'; genericsCreated++;
          }
        }
        const it = await trx.insertInto('stock_items').values({ ...(code && { code }), name, category_id: cat.id, generic_id: genericId, base_unit: unit.code, manufacturer: v('manufacturer') || null, country: v('country') || null,
          storage, requires_lot: cat.requires_lot, requires_expiry: cat.requires_expiry, serial_tracked: cat.serial_tracked, created_by: u.id }).returning('id').executeTakeFirstOrThrow();
        let packId: string | null = null;
        if (v('pack') && packQty) packId = (await trx.insertInto('stock_item_packs').values({ item_id: it.id, name: v('pack'), qty_base: packQty, is_receipt_default: true }).returning('id').executeTakeFirstOrThrow()).id;
        if (bc) { await trx.insertInto('stock_item_barcodes').values({ item_id: it.id, pack_id: packId, barcode: bc, kind: /^\d{14}$/.test(bc) ? 'gtin' : 'internal' }).execute(); seenBarcodes.add(bc); }
        report.push({ row: rowNo, status: 'create', name, generic: gstat }); created++;
      }
      if (commit) await this.audit.log(ctx, { action: 'IMPORT_STOCK_ITEMS', entityName: 'stock_items', entityId: '-', newData: { file: fileName, rows: rows.length, created, generics_created: genericsCreated } }, trx);
      if (!commit) throw new DryRun();
    };
    try { await this.db.transaction().execute(run); } catch (e) { if (!(e instanceof DryRun)) mapPgError(e, PG_MSG); }
    return { commit, rows: report.length, created, generics_created: genericsCreated, skipped: report.filter((r) => r.status === 'skip').length, errors: report.filter((r) => r.status === 'error').length, report };
  }
}

// ======================================================================= DTO
class PackDto { @IsOptional() @IsUUID() id?: string; @IsString() @Length(1, 60) name: string; @IsNumber() @Min(1.001) @Max(1_000_000) qty_base: number; @IsOptional() @IsBoolean() is_receipt_default?: boolean }
class BarcodeNewDto { @IsString() @Length(4, 80) barcode: string; @IsOptional() @IsInt() @Min(0) pack_index?: number; @IsOptional() @IsIn(['gtin', 'internal']) kind?: 'gtin' | 'internal' }
class ItemDto {
  @IsOptional() @Matches(/^[A-Za-z0-9_.-]{2,30}$/, { message: 'კოდი: ლათინური ასოები, ციფრები, _ . -' }) code?: string;
  @IsOptional() @IsString() @Length(2, 300) name?: string;
  @IsOptional() @IsUUID() category_id?: string;
  @IsOptional() @IsUUID() generic_id?: string | null;
  @IsOptional() @IsString() @MaxLength(200) manufacturer?: string | null;
  @IsOptional() @IsString() @MaxLength(100) country?: string | null;
  @IsOptional() @IsString() @Length(1, 20) base_unit?: string;
  @IsOptional() @IsBoolean() requires_lot?: boolean;
  @IsOptional() @IsBoolean() requires_expiry?: boolean;
  @IsOptional() @IsBoolean() serial_tracked?: boolean;
  @IsOptional() @IsIn(STORAGE) storage?: string;
  @IsOptional() @IsInt() @Min(0) @Max(730) expiry_warn_days?: number | null;
  @IsOptional() @IsNumber() @Min(0) sale_price?: number | null;
  @IsOptional() @IsIn(['none', 'invoice']) billing_mode?: 'none' | 'invoice' | null;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string | null;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(5) @ValidateNested({ each: true }) @Type(() => PackDto) packs?: PackDto[];
  @IsOptional() @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => BarcodeNewDto) barcodes?: BarcodeNewDto[];
}
class PacksDto { @IsArray() @ArrayMaxSize(5) @ValidateNested({ each: true }) @Type(() => PackDto) packs: PackDto[] }
class BarcodeDto { @IsString() @Length(4, 80) barcode: string; @IsOptional() @IsUUID() pack_id?: string | null; @IsOptional() @IsIn(['gtin', 'internal']) kind?: 'gtin' | 'internal' }
class ScanDto { @IsString() @Length(1, 300) code: string }
class SupplierDto {
  @IsOptional() @IsString() @Length(2, 300) name?: string; @IsOptional() @Matches(/^[0-9]{9,11}$/, { message: 'საიდენტიფიკაციო კოდი: 9 ან 11 ციფრი' }) tax_id?: string | null;
  @IsOptional() @IsBoolean() vat_payer?: boolean; @IsOptional() @IsString() @MaxLength(500) address?: string | null; @IsOptional() @IsString() @MaxLength(100) phone?: string | null;
  @IsOptional() @IsEmail() email?: string | null; @IsOptional() @IsString() @MaxLength(200) contact_person?: string | null; @IsOptional() @IsString() @MaxLength(2000) notes?: string | null;
  @IsOptional() @IsBoolean() is_active?: boolean;
}
class LocationDto {
  @IsOptional() @Matches(/^[A-Z][A-Z0-9_]{1,29}$/, { message: 'კოდი: დიდი ლათინური ასოები, ციფრები, _ (მაგ. D_SURG)' }) code?: string;
  @IsOptional() @IsString() @Length(2, 200) name?: string; @IsOptional() @IsIn(LOCATION_KINDS) kind?: string; @IsOptional() @IsUUID() department_id?: string | null;
  @IsOptional() @IsBoolean() requires_approval?: boolean; @IsOptional() @IsBoolean() is_active?: boolean; @IsOptional() @IsInt() sort_order?: number;
}
export class CategoryDto {
  @IsOptional() @Matches(/^[A-Z][A-Z0-9_]{1,29}$/, { message: 'კოდი: დიდი ლათინური ასოები, ციფრები, _' }) code?: string;
  @IsOptional() @IsString() @Length(2, 200) name?: string; @IsOptional() @IsIn(CATEGORY_KINDS) kind?: string; @IsOptional() @IsUUID() parent_id?: string | null;
  @IsOptional() @IsBoolean() requires_lot?: boolean; @IsOptional() @IsBoolean() requires_expiry?: boolean; @IsOptional() @IsBoolean() serial_tracked?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(730) expiry_warn_days?: number | null; @IsOptional() @IsIn(['none', 'invoice']) billing_mode?: 'none' | 'invoice';
  @IsOptional() @IsNumber() @Min(0) @Max(1000) markup_pct?: number | null; @IsOptional() @IsBoolean() is_active?: boolean; @IsOptional() @IsInt() sort_order?: number;
}
class UnitDto { @IsOptional() @Matches(/^[a-z][a-z0-9_]{0,19}$/, { message: 'კოდი: პატარა ლათინური ასოები' }) code?: string; @IsOptional() @IsString() @Length(1, 60) name?: string; @IsOptional() @IsBoolean() is_active?: boolean; @IsOptional() @IsInt() sort_order?: number }
class SettingsDto { @IsOptional() @IsIn(['fifo', 'average']) costing_method?: 'fifo' | 'average'; @IsOptional() @IsInt() @Min(0) @Max(60) short_expiry_months?: number; @IsString() @Length(3, 500) reason: string }
const bool = (v?: string) => v === 'true' || v === '1';

@Controller('stock')
export class StockCatalogController {
  constructor(private readonly s: StockCatalogService) {}
  @Get('refs') @Roles(...STOCK_READ) refs() { return this.s.refs(); }
  @Put('settings') @Roles(...STOCK_ADMIN) settings(@Body() d: SettingsDto, @CurrentUser() u: AuthUser, @Req() r: Request) {
    if (d.costing_method === undefined && d.short_expiry_months === undefined) throw new BadRequestException('შესაცვლელი პარამეტრი არ არის');
    return this.s.putSettings(d, u, auditCtx(r));
  }
  @Post('units') @Roles(...STOCK_ADMIN) createUnit(@Body() d: UnitDto, @Req() r: Request) { if (!d.code || !d.name) throw new BadRequestException('კოდი და დასახელება სავალდებულოა'); return this.s.saveUnit(null, d, auditCtx(r)); }
  @Patch('units/:code') @Roles(...STOCK_ADMIN) updateUnit(@Param('code') code: string, @Body() d: UnitDto, @Req() r: Request) { return this.s.saveUnit(code, { ...d, code: undefined }, auditCtx(r)); }
  @Post('categories') @Roles(...STOCK_ADMIN) createCategory(@Body() d: CategoryDto, @Req() r: Request) { if (!d.code || !d.name || !d.kind) throw new BadRequestException('კოდი, დასახელება და ტიპი სავალდებულოა'); return this.s.saveCategory(null, d, auditCtx(r)); }
  @Patch('categories/:id') @Roles(...STOCK_ADMIN) updateCategory(@Param('id', ParseUUIDPipe) id: string, @Body() d: CategoryDto, @Req() r: Request) { return this.s.saveCategory(id, { ...d, code: undefined }, auditCtx(r)); }

  @Get('items') @Roles(...STOCK_READ) items(@Query('search') search?: string, @Query('category_id') category_id?: string, @Query('generic_id') generic_id?: string, @Query('kind') kind?: string, @Query('all') all?: string, @Query('limit') limit?: string) {
    const uuid = /^[0-9a-f-]{36}$/i;
    if ((category_id && !uuid.test(category_id)) || (generic_id && !uuid.test(generic_id))) throw new BadRequestException('არასწორი id');
    return this.s.items({ search, category_id, generic_id, kind, all: bool(all), limit: limit ? Number(limit) || 200 : undefined });
  }
  @Get('items/:id') @Roles(...STOCK_READ) item(@Param('id', ParseUUIDPipe) id: string) { return this.s.item(id); }
  @Post('items') @Roles(...CATALOG_EDIT) createItem(@Body() d: ItemDto, @CurrentUser() u: AuthUser, @Req() r: Request) {
    if (!d.name || !d.category_id || !d.base_unit) throw new BadRequestException('დასახელება, კატეგორია და საბაზო ერთეული სავალდებულოა');
    return this.s.createItem(d, u, auditCtx(r));
  }
  @Patch('items/:id') @Roles(...CATALOG_EDIT) updateItem(@Param('id', ParseUUIDPipe) id: string, @Body() d: ItemDto, @CurrentUser() u: AuthUser, @Req() r: Request) {
    if (d.packs || d.barcodes) throw new BadRequestException('შეფუთვები — PUT …/packs, შტრიხკოდები — POST …/barcodes');
    return this.s.updateItem(id, d, u, auditCtx(r));
  }
  @Put('items/:id/packs') @Roles(...CATALOG_EDIT) packs(@Param('id', ParseUUIDPipe) id: string, @Body() d: PacksDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.setPacks(id, d.packs, u, auditCtx(r)); }
  @Post('items/:id/barcodes') @Roles(...CATALOG_EDIT) addBarcode(@Param('id', ParseUUIDPipe) id: string, @Body() d: BarcodeDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.addBarcode(id, d, u, auditCtx(r)); }
  @Delete('items/:id/barcodes/:bid') @Roles(...CATALOG_EDIT) removeBarcode(@Param('id', ParseUUIDPipe) id: string, @Param('bid', ParseUUIDPipe) bid: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.removeBarcode(id, bid, u, auditCtx(r)); }
  @Post('scan') @HttpCode(200) @Roles(...STOCK_READ) scan(@Body() d: ScanDto) { return this.s.scan(d.code); }

  @Get('suppliers') @Roles(...STOCK_READ) suppliers(@Query('all') all?: string, @Query('search') search?: string) { return this.s.suppliers(bool(all), search); }
  @Post('suppliers') @Roles('admin', 'stock_manager', 'storekeeper') createSupplier(@Body() d: SupplierDto, @Req() r: Request) { if (!d.name) throw new BadRequestException('დასახელება სავალდებულოა'); return this.s.saveSupplier(null, d, auditCtx(r)); }
  @Patch('suppliers/:id') @Roles('admin', 'stock_manager', 'storekeeper') updateSupplier(@Param('id', ParseUUIDPipe) id: string, @Body() d: SupplierDto, @Req() r: Request) { return this.s.saveSupplier(id, d, auditCtx(r)); }

  @Get('locations') @Roles(...STOCK_READ) locations(@Query('all') all?: string) { return this.s.locations(bool(all)); }
  @Post('locations') @Roles(...STOCK_ADMIN) createLocation(@Body() d: LocationDto, @Req() r: Request) { if (!d.code || !d.name || !d.kind) throw new BadRequestException('კოდი, დასახელება და ტიპი სავალდებულოა'); return this.s.saveLocation(null, d, auditCtx(r)); }
  @Patch('locations/:id') @Roles(...STOCK_ADMIN) updateLocation(@Param('id', ParseUUIDPipe) id: string, @Body() d: LocationDto, @Req() r: Request) { return this.s.saveLocation(id, { ...d, code: undefined }, auditCtx(r)); }

  @Get('import/template') @Roles(...CATALOG_EDIT) template(@Res({ passthrough: true }) res: Response) {
    res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="stock-import-template.xlsx"`, 'Cache-Control': 'no-store' });
    return new StreamableFile(this.s.template());
  }
  @Post('import') @HttpCode(200) @Roles(...CATALOG_EDIT)
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } }))
  import(@UploadedFile() file: Express.Multer.File | undefined, @Query('commit') commit: string | undefined, @CurrentUser() u: AuthUser, @Req() r: Request) {
    if (!file) throw new BadRequestException('ფაილი არ არის (ველი „file“)');
    return this.s.import(file.buffer, file.originalname, bool(commit), u, auditCtx(r));
  }
}
