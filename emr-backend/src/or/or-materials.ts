import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min, ValidateIf, ValidateNested } from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser } from '../auth/roles';
import { mapPgError } from '../common/pg-errors';
import { InjectDb, type Database } from '../database/database.module';
import { ModulesService } from '../modules/modules';
import { parseBarcode } from '../stock/gs1';
import { StockOpsService } from '../stock/stock-ops';
import { OR_READ } from './or-admin';
import { OrService } from './or';
import { assembleCard, cardItems, COUNT_KINDS, countState, lotsAt, orEvent, stockAt, TZ, type Ex } from './or-shared';

const num = ({ value }: { value: unknown }) => (value === '' || value === null || value === undefined ? undefined : Number(value));
const q3 = (n: number) => Math.round(n * 1000) / 1000;

export class ItemDto {
  @IsUUID() item_id: string;
  @Transform(num) @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) @Max(10000) qty: number;
  @IsOptional() @IsUUID() lot_id?: string;
  @IsOptional() @IsString() @MaxLength(300) implant_site?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}
export class ItemPatchDto {
  @IsOptional() @Transform(num) @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) @Max(10000) qty?: number;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() lot_id?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(300) implant_site?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(500) note?: string | null;
}
export class ScanDto { @IsString() @Length(1, 200) code: string; @IsOptional() @IsString() @MaxLength(300) implant_site?: string }
export class CountLineDto {
  @IsIn(Object.keys(COUNT_KINDS)) kind: string;
  @IsOptional() @IsString() @MaxLength(100) label?: string;
  @IsInt() @Min(0) @Max(9999) expected: number;
  @IsInt() @Min(0) @Max(9999) counted: number;
}
export class CountDto {
  @IsIn(['initial', 'pre_closure', 'final']) phase: 'initial' | 'pre_closure' | 'final';
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(12) @ValidateNested({ each: true }) @Type(() => CountLineDto) lines: CountLineDto[];
  @IsOptional() @IsString() @MaxLength(1000) explanation?: string;
  @IsOptional() @IsBoolean() xray?: boolean;
  @IsOptional() @IsUUID() second_by?: string;
}
export class PackDto { @IsString() @Length(2, 60) code: string }
export class PackRemoveDto { @IsString() @Length(3, 500) reason: string }
export class CardItemDto { @IsUUID() item_id: string; @Transform(num) @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) @Max(10000) qty: number; @IsOptional() @IsString() @MaxLength(300) note?: string }
export class CardDto {
  @IsUUID() procedure_id: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() surgeon_id?: string | null;
  @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => CardItemDto) items: CardItemDto[];
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(2000) notes?: string | null;
  @IsOptional() @IsBoolean() is_active?: boolean;
}

/**
 * მასალები / იმპლანტები / დათვლა / CSSD (0049, #7, #8):
 *  • preference card (preference_cards: off / procedure / procedure_surgeon) → დასრულებისას (ან ხელით) ავტომატური შეკრება + დამატებული (სკანირება / ძებნა)
 *    → საოპერაციო ექთანი ადასტურებს → ჩამოწერა ბლოკის ლოკაციიდან (FEFO; ლოტი სკანირებით) + ინვოისი (კატეგორიის წესით);
 *  • იმპლანტი — ლოტი + სერია სავალდებულო → პაციენტის იმპლანტების რეესტრი;
 *  • დათვლა — დაწყებისას / დახურვამდე / ბოლოს (count_mode — ნიშნულებთან, or-shared.countGate);
 *  • CSSD — შეფუთვის სკანირება; არასტერილური / ვადაგასული → ბლოკი (არაარჩევადი, DB trigger); დასრულებისას → used.
 */
@Injectable()
export class OrMaterialsService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService, private readonly or: OrService, private readonly stock: StockOpsService,
              private readonly modules: ModulesService) {}

  private async load(id: string, u: AuthUser, ex: Ex = this.db, lock = false) {
    const s = await this.or.settings();
    const c = await this.or.loadCase(id, ex, lock);
    const p = await this.or.perms(u, c, s, ex);
    return { s, c, p };
  }
  private async ops(id: string, u: AuthUser, ex: Ex = this.db, statuses = ['scheduled', 'in_progress', 'completed']) {
    const x = await this.load(id, u, ex, true);
    if (!x.p.nursing_ops) throw new ForbiddenException('მასალები / დათვლა / CSSD — საოპერაციო ექთანი (ან გუნდის ექთანი)');
    if (!statuses.includes(x.c.status)) throw new ConflictException(`ოპერაციის სტატუსი — ${x.c.status}: მოქმედება შეუძლებელია`);
    return x;
  }
  private async location(blockId: string | null, ex: Ex = this.db) {
    if (!blockId) return null;
    const r = await ex.selectFrom('departments as d').leftJoin('stock_locations as l', 'l.id', 'd.or_stock_location_id').select(['l.id', 'l.name', 'l.is_active']).where('d.id', '=', blockId).executeTakeFirst();
    return r?.id ? { id: r.id, name: r.name!, is_active: !!r.is_active } : null;
  }
  private async needLocation(blockId: string | null, ex: Ex = this.db) {
    const l = await this.location(blockId, ex);
    if (!l) throw new ConflictException({ code: 'NO_BLOCK_LOCATION', message: 'ბლოკს საწყობის ლოკაცია არ აქვს (ადმინისტრირება → საოპერაციო → ბლოკი)' });
    return l;
  }
  private async item(itemId: string, ex: Ex = this.db) {
    const it = await ex.selectFrom('stock_items as i').innerJoin('stock_categories as k', 'k.id', 'i.category_id').select(['i.id', 'i.name', 'i.is_active', 'i.serial_tracked', 'i.manufacturer', 'k.kind'])
      .where('i.id', '=', itemId).executeTakeFirst();
    if (!it?.is_active) throw new BadRequestException('საქონელი ვერ მოიძებნა ან გათიშულია');
    if (['household', 'office', 'reagent', 'qc_material'].includes(it.kind)) throw new BadRequestException(`„${it.name}“ — პაციენტზე ხარჯის კატეგორია არ არის`);
    return it;
  }
  private async lotCheck(lotId: string, itemId: string, locationId: string, ex: Ex = this.db) {
    const l = (await lotsAt(ex, locationId, itemId)).find((x) => x.lot_id === lotId);
    if (!l) throw new BadRequestException('ლოტი ბლოკის საწყობში ვერ მოიძებნა (ნაშთი / ვადა / სტატუსი)');
    return l;
  }

  async view(id: string, u: AuthUser) {
    const { s, c, p } = await this.load(id, u);
    const loc = await this.location(c.block_id);
    const [items, counts, packs, implants, card] = await Promise.all([
      this.db.selectFrom('or_case_items as ci').innerJoin('stock_items as i', 'i.id', 'ci.item_id').innerJoin('stock_units as un', 'un.code', 'i.base_unit')
        .leftJoin('stock_lots as lt', 'lt.id', 'ci.lot_id').leftJoin('users as a', 'a.id', 'ci.added_by').leftJoin('stock_docs as d', 'd.id', 'ci.stock_doc_id')
        .select(['ci.id', 'ci.item_id', 'i.name', 'i.code', 'un.name as unit_name', 'i.serial_tracked', 'ci.qty', 'ci.lot_id', 'lt.lot_no', 'lt.serial_no', 'lt.expires_on', 'ci.source', 'ci.is_implant',
          'ci.implant_site', 'ci.note', 'ci.added_at', 'ci.posted_at', 'ci.stock_doc_id', 'd.doc_no', sql<string | null>`a.last_name || ' ' || a.first_name`.as('added_by_name')])
        .where('ci.case_id', '=', id).orderBy('ci.posted_at', 'desc').orderBy('ci.added_at').execute(),
      this.db.selectFrom('or_counts as k').innerJoin('users as x', 'x.id', 'k.done_by').leftJoin('users as y', 'y.id', 'k.second_by')
        .select(['k.id', 'k.phase', 'k.lines', 'k.correct', 'k.explanation', 'k.xray', 'k.done_at', sql<string>`x.last_name || ' ' || x.first_name`.as('by_name'),
          sql<string | null>`y.last_name || ' ' || y.first_name`.as('second_name')])
        .where('k.case_id', '=', id).orderBy('k.done_at').execute(),
      this.db.selectFrom('or_case_packs as cp').innerJoin('cssd_packs as p', 'p.id', 'cp.pack_id').innerJoin('cssd_sets as st', 'st.id', 'p.set_id')
        .innerJoin('cssd_templates as t', 't.id', 'st.template_id').leftJoin('users as a', 'a.id', 'cp.added_by')
        .select(['cp.id', 'cp.pack_id', 'p.pack_no', 'p.status', 'p.expires_on', 't.name as template_name', 'st.barcode', 'cp.added_at', 'cp.removed_at', 'cp.remove_reason', 'cp.used_at',
          sql<string | null>`a.last_name || ' ' || a.first_name`.as('added_by_name')])
        .where('cp.case_id', '=', id).orderBy('cp.added_at').execute(),
      this.db.selectFrom('patient_implants').selectAll().where('case_id', '=', id).orderBy('implanted_at').execute(),
      cardItems(this.db, c, s.preference_cards),
    ]);
    const phases = Object.fromEntries(await Promise.all((['initial', 'pre_closure', 'final'] as const).map(async (ph) => [ph, await countState(this.db, id, ph)])));
    return { case_id: id, case_no: c.case_no, status: c.status, location: loc, items, counts, count_state: phases, packs, implants,
      card: { mode: s.preference_cards, items: card, assembled: items.some((i) => i.source === 'card') }, count_mode: s.count_mode, count_kinds: COUNT_KINDS,
      cssd: (await this.modules.get('cssd')).enabled,
      can: { edit: p.nursing_ops && ['scheduled', 'in_progress', 'completed'].includes(c.status), post: p.nursing_ops && ['in_progress', 'completed'].includes(c.status),
        count: p.nursing_ops && c.status === 'in_progress' } };
  }

  async stock_(id: string, q: string | undefined) {
    const c = await this.or.loadCase(id);
    const loc = await this.location(c.block_id);
    if (!loc) return [];
    return stockAt(this.db, loc.id, q, ['medical_supply', 'implant', 'medication', 'other']);
  }
  async lots(id: string, itemId: string) {
    const c = await this.or.loadCase(id);
    const loc = await this.location(c.block_id);
    return loc ? lotsAt(this.db, loc.id, itemId) : [];
  }

  async assemble(id: string, u: AuthUser, ctx: AuditContext) {
    const n = await this.db.transaction().execute(async (trx) => {
      const { s, c } = await this.ops(id, u, trx);
      if (s.preference_cards === 'off') throw new ConflictException('preference card გამორთულია (პარამეტრი)');
      const k = await assembleCard(trx, c, s.preference_cards, u.id);
      if (!k) throw new ConflictException((await cardItems(trx, c, s.preference_cards)).length ? 'ბარათი უკვე შეკრებილია' : 'ამ ოპერაციისთვის preference card არ არის');
      await this.audit.log(ctx, { action: 'OR_ITEMS_ASSEMBLE', entityName: 'or_case_items', entityId: c.id, newData: { items: k } }, trx);
      return k;
    });
    return { ...(await this.view(id, u)), assembled: n };
  }

  async add(id: string, dto: ItemDto, u: AuthUser, ctx: AuditContext, source: 'manual' | 'scan' = 'manual') {
    await this.db.transaction().execute(async (trx) => {
      const { c } = await this.ops(id, u, trx);
      const loc = await this.needLocation(c.block_id, trx);
      const it = await this.item(dto.item_id, trx);
      if (dto.lot_id) await this.lotCheck(dto.lot_id, it.id, loc.id, trx);
      if (it.serial_tracked && dto.qty !== 1) throw new BadRequestException(`„${it.name}“ — სერიული: 1 ერთეული თითო ხაზზე`);
      if (dto.lot_id && it.serial_tracked) {
        const dup = await trx.selectFrom('or_case_items').select('id').where('case_id', '=', c.id).where('lot_id', '=', dto.lot_id).executeTakeFirst();
        if (dup) throw new ConflictException('ეს სერიული ნომერი უკვე დამატებულია');
      }
      const same = !it.serial_tracked ? await trx.selectFrom('or_case_items').select(['id', 'qty']).where('case_id', '=', c.id).where('item_id', '=', it.id).where('posted_at', 'is', null)
        .where((eb) => (dto.lot_id ? eb('lot_id', '=', dto.lot_id) : eb('lot_id', 'is', null))).executeTakeFirst() : undefined;
      if (same && source === 'scan') await trx.updateTable('or_case_items').set({ qty: String(q3(Number(same.qty) + dto.qty)) }).where('id', '=', same.id).execute();
      else {
        await trx.insertInto('or_case_items').values({ case_id: c.id, item_id: it.id, qty: String(dto.qty), lot_id: dto.lot_id ?? null, source, is_implant: it.kind === 'implant',
          implant_site: dto.implant_site?.trim() || null, note: dto.note?.trim() || null, added_by: u.id }).execute();
      }
      await this.audit.log(ctx, { action: 'OR_ITEM_ADD', entityName: 'or_case_items', entityId: c.id, newData: { ...dto, source } }, trx);
    });
    return this.view(id, u);
  }

  /** სკანირება: GS1 / EAN → საქონელი; ლოტი / სერიული — კოდიდან, ბლოკის საწყობში */
  async scan(id: string, dto: ScanDto, u: AuthUser, ctx: AuditContext) {
    const c = await this.or.loadCase(id);
    const loc = await this.needLocation(c.block_id);
    const p = parseBarcode(dto.code);
    let itemId = (await this.db.selectFrom('stock_item_barcodes').select('item_id').where('barcode', '=', p.normalized).where('is_active', '=', true).executeTakeFirst())?.item_id;
    let lotId: string | undefined;
    if (!itemId) {
      // იმპლანტის სერიული / ლოტის ნომერი პირდაპირ (ეტიკეტიდან) — ბლოკის საწყობში
      const t = dto.code.trim().toUpperCase();
      const hits = await this.db.selectFrom('stock_balances as b').innerJoin('stock_lots as lt', 'lt.id', 'b.lot_id').select(['lt.id', 'lt.item_id'])
        .where('b.location_id', '=', loc.id).where('b.qty', '>', '0').where((eb) => eb.or([eb(sql`upper(lt.serial_no)`, '=', t), eb(sql`upper(lt.lot_no)`, '=', t)])).limit(2).execute();
      if (hits.length === 1) { itemId = hits[0].item_id; lotId = hits[0].id; }
      else if (hits.length > 1) throw new ConflictException('ნომერი რამდენიმე ლოტს ემთხვევა — აირჩიეთ ხელით');
    }
    if (!itemId) throw new NotFoundException({ code: 'SCAN_UNKNOWN', message: 'კოდი კატალოგში / ბლოკის საწყობში ვერ მოიძებნა' });
    const it = await this.item(itemId);
    if (!lotId && (p.lot || p.serial)) {
      const lots = await lotsAt(this.db, loc.id, it.id);
      const m = lots.filter((l) => (!p.serial || (l.serial_no ?? '').toUpperCase() === p.serial.toUpperCase()) && (!p.lot || (l.lot_no ?? '').toUpperCase() === p.lot.toUpperCase()));
      if (!m.length) throw new ConflictException({ code: 'SCAN_LOT_NOT_HERE', message: `„${it.name}“ — ${p.serial ? `სერიული ${p.serial}` : `ლოტი ${p.lot}`} ბლოკის საწყობში არ არის` });
      lotId = m[0].lot_id;
    }
    if (it.serial_tracked && !lotId) throw new BadRequestException({ code: 'SCAN_SERIAL_REQUIRED', message: `„${it.name}“ — სერიული: დაასკანერეთ კოდი სერიული ნომრით` });
    const pack = (await this.db.selectFrom('stock_item_barcodes as b').leftJoin('stock_item_packs as k', 'k.id', 'b.pack_id').select('k.qty_base').where('b.barcode', '=', p.normalized).executeTakeFirst())?.qty_base;
    return this.add(id, { item_id: it.id, qty: it.serial_tracked ? 1 : Number(pack ?? 1), lot_id: lotId, implant_site: dto.implant_site }, u, ctx, 'scan');
  }

  async patch(rowId: string, dto: ItemPatchDto, u: AuthUser, ctx: AuditContext) {
    const r = await this.db.selectFrom('or_case_items').select(['case_id']).where('id', '=', rowId).executeTakeFirst();
    if (!r) throw new NotFoundException('ხაზი ვერ მოიძებნა');
    await this.db.transaction().execute(async (trx) => {
      const { c } = await this.ops(r.case_id, u, trx);
      const row = await trx.selectFrom('or_case_items').selectAll().where('id', '=', rowId).forUpdate().executeTakeFirstOrThrow();
      if (row.posted_at) throw new ConflictException('ჩამოწერილი მასალა არ იცვლება');
      const it = await this.item(row.item_id, trx);
      if (dto.lot_id) await this.lotCheck(dto.lot_id, it.id, (await this.needLocation(c.block_id, trx)).id, trx);
      if (it.serial_tracked && dto.qty !== undefined && dto.qty !== 1) throw new BadRequestException('სერიული — 1 ერთეული');
      await trx.updateTable('or_case_items').set({ ...(dto.qty !== undefined && { qty: String(dto.qty) }), ...(dto.lot_id !== undefined && { lot_id: dto.lot_id }),
        ...(dto.implant_site !== undefined && { implant_site: dto.implant_site?.trim() || null }), ...(dto.note !== undefined && { note: dto.note?.trim() || null }) }).where('id', '=', rowId).execute();
      await this.audit.log(ctx, { action: 'OR_ITEM_UPDATE', entityName: 'or_case_items', entityId: rowId, oldData: row, newData: dto }, trx);
    });
    return this.view(r.case_id, u);
  }

  async remove(rowId: string, u: AuthUser, ctx: AuditContext) {
    const r = await this.db.selectFrom('or_case_items').select(['case_id', 'posted_at']).where('id', '=', rowId).executeTakeFirst();
    if (!r) throw new NotFoundException('ხაზი ვერ მოიძებნა');
    if (r.posted_at) throw new ConflictException('ჩამოწერილი მასალა არ იშლება (შესწორება — საწყობის დოკუმენტით)');
    await this.db.transaction().execute(async (trx) => {
      await this.ops(r.case_id, u, trx);
      await trx.deleteFrom('or_case_items').where('id', '=', rowId).where('posted_at', 'is', null).execute();
      await this.audit.log(ctx, { action: 'OR_ITEM_REMOVE', entityName: 'or_case_items', entityId: rowId }, trx);
    });
    return this.view(r.case_id, u);
  }

  /** ექთანი ადასტურებს → ჩამოწერა ბლოკის ლოკაციიდან (FEFO / მითითებული ლოტი) + ინვოისი; იმპლანტი → რეესტრი */
  async post(id: string, u: AuthUser, ctx: AuditContext) {
    const { c } = await this.ops(id, u, this.db, ['in_progress', 'completed']);
    if (!c.encounter_id) throw new ConflictException('ჰოსპიტალიზაცია არ არის');
    const loc = await this.needLocation(c.block_id);
    const rows = await this.db.selectFrom('or_case_items as ci').innerJoin('stock_items as i', 'i.id', 'ci.item_id').leftJoin('stock_lots as lt', 'lt.id', 'ci.lot_id')
      .select(['ci.id', 'ci.item_id', 'ci.qty', 'ci.lot_id', 'ci.is_implant', 'ci.implant_site', 'i.name', 'i.manufacturer', 'i.serial_tracked', 'lt.lot_no', 'lt.serial_no'])
      .where('ci.case_id', '=', c.id).where('ci.posted_at', 'is', null).orderBy('ci.added_at').execute();
    if (!rows.length) throw new BadRequestException('ჩამოსაწერი მასალა არ არის');
    const bad = rows.filter((r) => r.is_implant && (!r.lot_id || !r.lot_no || !r.serial_no)).map((r) => r.name);
    if (bad.length) throw new BadRequestException({ code: 'IMPLANT_LOT_SERIAL', message: `იმპლანტი — ლოტი და სერიული ნომერი სავალდებულოა: ${bad.join(', ')}`, items: bad });
    const serNoLot = rows.filter((r) => r.serial_tracked && !r.lot_id).map((r) => r.name);
    if (serNoLot.length) throw new BadRequestException(`სერიული საქონელი — მიუთითეთ სერიული ნომერი: ${serNoLot.join(', ')}`);
    const times = new Map((await this.db.selectFrom('or_case_times').select(['kind', 'at']).where('case_id', '=', c.id).where('superseded_by', 'is', null).execute()).map((t) => [t.kind, new Date(t.at)]));
    const implantedAt = times.get('closure') ?? times.get('incision') ?? new Date();
    const ids = rows.map((r) => r.id).sort();
    const res = await this.stock.createConsumption({ location_id: loc.id, patient_id: c.patient_id, encounter_id: c.encounter_id, notes: `ოპერაცია ${c.case_no} — მასალები`,
      lines: rows.map((r) => ({ item_id: r.item_id, qty_base: Number(r.qty), lot_id: r.lot_id })) }, u, ctx, async (trx, docId) => {
      const locked = (await trx.selectFrom('or_case_items').select('id').where('case_id', '=', c.id).where('posted_at', 'is', null).forUpdate().execute()).map((x) => x.id).sort();
      if (locked.join() !== ids.join()) throw new ConflictException('მასალების სია შეიცვალა — განაახლეთ და გაიმეორეთ');
      await trx.updateTable('or_case_items').set({ posted_at: sql`now()`, posted_by: u.id, stock_doc_id: docId }).where('id', 'in', ids).execute();
      const lines = await trx.selectFrom('stock_doc_lines').select(['id', 'lot_id', 'item_id', 'lot_no', 'serial_no', 'expires_on']).where('doc_id', '=', docId).execute();
      let imp = 0;
      for (const r of rows.filter((x) => x.is_implant)) {
        const l = lines.find((x) => x.lot_id === r.lot_id && x.item_id === r.item_id);
        await trx.insertInto('patient_implants').values({ patient_id: c.patient_id, case_id: c.id, encounter_id: c.encounter_id, item_id: r.item_id, name: r.name, manufacturer: r.manufacturer,
          lot_no: r.lot_no!, serial_no: r.serial_no!, expires_on: l?.expires_on ?? null, site: r.implant_site, implanted_at: implantedAt, stock_doc_line_id: l?.id ?? null, recorded_by: u.id }).execute();
        imp++;
      }
      await orEvent(trx, c, 'items_posted', { lines: rows.length, implants: imp }, u.id, imp ? 'or_implant' : undefined);
    }, { authorized: true });
    return { ...(await this.view(id, u)), warnings: res.warnings, doc_no: res.doc_no };
  }

  // ================================================================= დათვლა
  async count(id: string, dto: CountDto, u: AuthUser, ctx: AuditContext) {
    const kinds = dto.lines.map((l) => `${l.kind}:${l.label ?? ''}`);
    if (new Set(kinds).size !== kinds.length) throw new BadRequestException('პოზიცია მეორდება');
    const correct = dto.lines.every((l) => l.expected === l.counted);
    if (!correct && (dto.explanation?.trim().length ?? 0) < 3) throw new BadRequestException({ code: 'COUNT_EXPLANATION', message: 'შეუსაბამობა — საჭიროა ახსნა (და ხელახლა დათვლა ან რენტგენი)' });
    await this.db.transaction().execute(async (trx) => {
      const { c } = await this.ops(id, u, trx, ['in_progress']);
      if (dto.second_by) {
        if (dto.second_by === u.id) throw new BadRequestException('მეორე დამთვლელი სხვა პირი უნდა იყოს');
        const x = await trx.selectFrom('users as x').select(['x.is_active', sql<string[]>`coalesce((SELECT k.capabilities FROM user_capabilities k WHERE k.user_id = x.id), '{}')`.as('caps')])
          .where('x.id', '=', dto.second_by).executeTakeFirst();
        if (!x?.is_active || !x.caps.some((k) => ['or_nurse', 'nurse', 'doctor', 'anesthesiologist'].includes(k))) throw new BadRequestException('მეორე დამთვლელი — ექთანი / ექიმი');
      }
      if (dto.phase !== 'initial' && !(await countState(trx, c.id, 'initial')).done) throw new ConflictException({ code: 'COUNT_ORDER', message: 'ჯერ — დათვლა დაწყებისას' });
      const lines = dto.lines.map((l) => ({ kind: l.kind, label: l.label?.trim() || COUNT_KINDS[l.kind], expected: l.expected, counted: l.counted }));
      const r = await trx.insertInto('or_counts').values({ case_id: c.id, phase: dto.phase, lines: JSON.stringify(lines), correct, explanation: dto.explanation?.trim() || null, xray: !!dto.xray,
        second_by: dto.second_by ?? null, done_by: u.id }).returning('id').executeTakeFirstOrThrow();
      await orEvent(trx, c, 'count', { phase: dto.phase, correct, xray: !!dto.xray }, u.id);
      await this.audit.log(ctx, { action: 'OR_COUNT', entityName: 'or_counts', entityId: r.id, newData: dto }, trx);
    });
    return this.view(id, u);
  }

  // ================================================================= CSSD
  /** შეფუთვის სკანირება (pack_no ან ნაკრების შტრიხკოდი): სტერილური / გაცემული — ემატება; სხვა → ბლოკი */
  async addPack(id: string, dto: PackDto, u: AuthUser, ctx: AuditContext) {
    if (!(await this.modules.get('cssd')).enabled) throw new ConflictException('მოდული CSSD გამორთულია');
    const code = dto.code.trim().toUpperCase();
    try {
      await this.db.transaction().execute(async (trx) => {
        const { c } = await this.ops(id, u, trx, ['scheduled', 'in_progress']);
        let pk = await trx.selectFrom('cssd_packs').selectAll().where(sql`upper(pack_no)`, '=', code).forUpdate().executeTakeFirst();
        if (!pk) {
          const set = await trx.selectFrom('cssd_sets').select('id').where(sql`upper(barcode)`, '=', code).executeTakeFirst();
          if (set) pk = await trx.selectFrom('cssd_packs').selectAll().where('set_id', '=', set.id).where('status', 'in', ['packed', 'sterile', 'quarantine', 'issued']).forUpdate().executeTakeFirst();
        }
        if (!pk) throw new NotFoundException({ code: 'PACK_UNKNOWN', message: 'შეფუთვა ვერ მოიძებნა (ნომერი / ნაკრების კოდი)' });
        const today = (await sql<{ d: string }>`SELECT (now() AT TIME ZONE ${TZ})::date::text AS d`.execute(trx)).rows[0].d;
        const ST: Record<string, string> = { packed: 'შეფუთულია, სტერილიზაცია არ ჩატარებულა', quarantine: 'ქარანტინშია (BI-ს პასუხი)', failed: 'სტერილიზაცია ჩავარდა', used: 'უკვე გამოყენებულია',
          expired: 'ვადაგასულია', recalled: 'გაწვეულია', reprocess: 'ხელახალ დამუშავებაზეა' };
        if (!['sterile', 'issued'].includes(pk.status)) throw new ConflictException({ code: 'PACK_NOT_STERILE', message: `CSSD: ${pk.pack_no} — ${ST[pk.status] ?? pk.status}. გამოყენება აკრძალულია` });
        if (pk.expires_on && pk.expires_on < today) throw new ConflictException({ code: 'PACK_NOT_STERILE', message: `CSSD: ${pk.pack_no} — სტერილობის ვადა გასულია. გამოყენება აკრძალულია` });
        await trx.insertInto('or_case_packs').values({ case_id: c.id, pack_id: pk.id, added_by: u.id }).execute();
        if (pk.status === 'sterile' && c.block_id) {
          // შენახვიდან პირდაპირ ბლოკში — გაცემა ბლოკზე
          await trx.updateTable('cssd_packs').set({ status: 'issued', issued_department_id: c.block_id, issued_at: sql`now()`, issued_by: u.id }).where('id', '=', pk.id).execute();
          await trx.updateTable('cssd_sets').set({ status: 'in_use', holder_department_id: c.block_id }).where('id', '=', pk.set_id).execute();
          await trx.insertInto('cssd_events').values({ set_id: pk.set_id, pack_id: pk.id, kind: 'issued', data: JSON.stringify({ department_id: c.block_id, or_case_id: c.id }), user_id: u.id }).execute();
        }
        await orEvent(trx, c, 'pack_added', { pack_no: pk.pack_no }, u.id);
        await this.audit.log(ctx, { action: 'OR_PACK_ADD', entityName: 'or_case_packs', entityId: pk.id, newData: { case_id: c.id, pack_no: pk.pack_no } }, trx);
      });
    } catch (e) { mapPgError(e, { ux_or_case_pack: 'შეფუთვა უკვე მიბმულია ოპერაციაზე', or_pack_not_sterile: 'CSSD: შეფუთვა არ არის სტერილური — გამოყენება აკრძალულია' }); }
    return this.view(id, u);
  }

  async removePack(cpId: string, reason: string, u: AuthUser, ctx: AuditContext) {
    const r = await this.db.selectFrom('or_case_packs as cp').innerJoin('cssd_packs as p', 'p.id', 'cp.pack_id').select(['cp.case_id', 'cp.removed_at', 'cp.used_at', 'p.pack_no'])
      .where('cp.id', '=', cpId).executeTakeFirst();
    if (!r || r.removed_at) throw new NotFoundException('ჩანაწერი ვერ მოიძებნა');
    if (r.used_at) throw new ConflictException('გამოყენებული შეფუთვა არ იხსნება');
    await this.db.transaction().execute(async (trx) => {
      const { c } = await this.ops(r.case_id, u, trx, ['scheduled', 'in_progress']);
      await trx.updateTable('or_case_packs').set({ removed_at: sql`now()`, removed_by: u.id, remove_reason: reason }).where('id', '=', cpId).execute();
      await orEvent(trx, c, 'pack_removed', { pack_no: r.pack_no, reason }, u.id);
      await this.audit.log(ctx, { action: 'OR_PACK_REMOVE', entityName: 'or_case_packs', entityId: cpId, newData: { reason } }, trx);
    });
    return this.view(r.case_id, u);
  }

  // ================================================================= preference cards
  async cards(procedureId?: string, surgeonId?: string) {
    const cards = await this.db.selectFrom('or_preference_cards as k').innerJoin('or_procedures as p', 'p.id', 'k.procedure_id').leftJoin('users as s', 's.id', 'k.surgeon_id')
      .leftJoin('users as ub', 'ub.id', 'k.updated_by')
      .select(['k.id', 'k.procedure_id', 'p.code as procedure_code', 'p.name as procedure_name', 'k.surgeon_id', sql<string | null>`s.last_name || ' ' || s.first_name`.as('surgeon_name'),
        'k.notes', 'k.is_active', 'k.updated_at', sql<string | null>`ub.last_name || ' ' || ub.first_name`.as('updated_by_name')])
      .$if(!!procedureId, (q) => q.where('k.procedure_id', '=', procedureId!)).$if(!!surgeonId, (q) => q.where('k.surgeon_id', '=', surgeonId!))
      .orderBy('p.name').orderBy(sql`k.surgeon_id NULLS FIRST`).limit(500).execute();
    const items = cards.length ? await this.db.selectFrom('or_preference_card_items as ci').innerJoin('stock_items as i', 'i.id', 'ci.item_id').innerJoin('stock_units as un', 'un.code', 'i.base_unit')
      .innerJoin('stock_categories as k', 'k.id', 'i.category_id')
      .select(['ci.card_id', 'ci.item_id', 'ci.qty', 'ci.note', 'i.name', 'un.name as unit_name', 'k.kind']).where('ci.card_id', 'in', cards.map((k) => k.id)).orderBy('ci.sort_order').execute() : [];
    return cards.map((k) => ({ ...k, items: items.filter((i) => i.card_id === k.id) }));
  }

  /** ბარათის შენახვა: ზოგადი (პროცედურაზე) — admin / ბლოკის მთავარი ექთანი; ქირურგის — თავად ქირურგი / admin / მთავარი ექთანი */
  async saveCard(dto: CardDto, u: AuthUser, ctx: AuditContext) {
    const me = await this.db.selectFrom('users').select(['is_section_head']).where('id', '=', u.id).executeTakeFirstOrThrow();
    const headNurse = has(u, 'or_nurse') && !!me.is_section_head;
    const surgeon = dto.surgeon_id ?? null;
    if (!(has(u, 'admin') || headNurse || (surgeon && surgeon === u.id && has(u, 'doctor')))) {
      throw new ForbiddenException(surgeon ? 'ქირურგის ბარათი — თავად ქირურგი, ბლოკის მთავარი ექთანი ან admin' : 'პროცედურის ბარათი — ბლოკის მთავარი ექთანი ან admin');
    }
    const ids = dto.items.map((i) => i.item_id);
    if (new Set(ids).size !== ids.length) throw new BadRequestException('პოზიცია მეორდება');
    for (const i of ids) await this.item(i);
    if (!(await this.db.selectFrom('or_procedures').select('id').where('id', '=', dto.procedure_id).executeTakeFirst())) throw new BadRequestException('პროცედურა ვერ მოიძებნა');
    if (surgeon && !(await this.db.selectFrom('user_capabilities').select('user_id').where('user_id', '=', surgeon).where(sql<boolean>`'doctor' = ANY(capabilities)`).executeTakeFirst())) {
      throw new BadRequestException('ქირურგი ვერ მოიძებნა');
    }
    const id = await this.db.transaction().execute(async (trx) => {
      const old = await trx.selectFrom('or_preference_cards').select('id').where('procedure_id', '=', dto.procedure_id)
        .where((eb) => (surgeon ? eb('surgeon_id', '=', surgeon) : eb('surgeon_id', 'is', null))).forUpdate().executeTakeFirst();
      const cid = old ? old.id : (await trx.insertInto('or_preference_cards').values({ procedure_id: dto.procedure_id, surgeon_id: surgeon, notes: dto.notes?.trim() || null, updated_by: u.id })
        .returning('id').executeTakeFirstOrThrow()).id;
      if (old) await trx.updateTable('or_preference_cards').set({ notes: dto.notes?.trim() || null, ...(dto.is_active !== undefined && { is_active: dto.is_active }), updated_by: u.id })
        .where('id', '=', cid).execute();
      await trx.deleteFrom('or_preference_card_items').where('card_id', '=', cid).execute();
      if (dto.items.length) await trx.insertInto('or_preference_card_items').values(dto.items.map((i, n) => ({ card_id: cid, item_id: i.item_id, qty: String(i.qty), note: i.note?.trim() || null, sort_order: n })))
        .execute();
      await this.audit.log(ctx, { action: old ? 'OR_CARD_UPDATE' : 'OR_CARD_CREATE', entityName: 'or_preference_cards', entityId: cid, newData: dto }, trx);
      return cid;
    });
    return (await this.cards()).find((k) => k.id === id);
  }

  /** ბარათისთვის საქონლის ძებნა (კატალოგი, ნაშთის გარეშე) */
  catalog(q: string) {
    const t = `%${q.trim().replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`;
    return this.db.selectFrom('stock_items as i').innerJoin('stock_categories as k', 'k.id', 'i.category_id').innerJoin('stock_units as un', 'un.code', 'i.base_unit')
      .select(['i.id', 'i.code', 'i.name', 'un.name as unit_name', 'k.kind']).where('i.is_active', '=', true).where('k.kind', 'in', ['medical_supply', 'implant', 'medication', 'other'])
      .where((eb) => eb.or([eb('i.name', 'ilike', t), eb('i.code', 'ilike', t)])).orderBy('i.name').limit(30).execute();
  }

  /** პაციენტის იმპლანტების რეესტრი */
  implants(patientId: string) {
    return this.db.selectFrom('patient_implants as pi').leftJoin('or_cases as c', 'c.id', 'pi.case_id').leftJoin('users as x', 'x.id', 'pi.recorded_by')
      .select(['pi.id', 'pi.name', 'pi.manufacturer', 'pi.lot_no', 'pi.serial_no', 'pi.expires_on', 'pi.site', 'pi.implanted_at', 'pi.removed_at', 'pi.removed_reason', 'pi.case_id', 'c.case_no',
        sql<string>`x.last_name || ' ' || x.first_name`.as('recorded_by_name')])
      .where('pi.patient_id', '=', patientId).orderBy('pi.implanted_at', 'desc').execute();
  }
}

@Controller('or')
export class OrMaterialsController {
  constructor(private readonly s: OrMaterialsService) {}
  @Get('cases/:id/materials') @Roles(...OR_READ) view(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser) { return this.s.view(id, u); }
  @Get('cases/:id/materials/stock') @Roles('admin', 'or_nurse', 'nurse') stock(@Param('id', ParseUUIDPipe) id: string, @Query('q') q?: string) { return this.s.stock_(id, q); }
  @Get('cases/:id/materials/lots') @Roles('admin', 'or_nurse', 'nurse', 'anesthesiologist')
  lots(@Param('id', ParseUUIDPipe) id: string, @Query('item_id', ParseUUIDPipe) item: string) { return this.s.lots(id, item); }
  @Post('cases/:id/items/assemble') @HttpCode(200) @Roles('admin', 'or_nurse', 'nurse')
  assemble(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.assemble(id, u, auditCtx(r)); }
  @Post('cases/:id/items') @Roles('admin', 'or_nurse', 'nurse')
  add(@Param('id', ParseUUIDPipe) id: string, @Body() d: ItemDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.add(id, d, u, auditCtx(r)); }
  @Post('cases/:id/items/scan') @HttpCode(200) @Roles('admin', 'or_nurse', 'nurse')
  scan(@Param('id', ParseUUIDPipe) id: string, @Body() d: ScanDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.scan(id, d, u, auditCtx(r)); }
  @Patch('items/:rid') @Roles('admin', 'or_nurse', 'nurse')
  patch(@Param('rid', ParseUUIDPipe) rid: string, @Body() d: ItemPatchDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.patch(rid, d, u, auditCtx(r)); }
  @Post('items/:rid/remove') @HttpCode(200) @Roles('admin', 'or_nurse', 'nurse')
  remove(@Param('rid', ParseUUIDPipe) rid: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.remove(rid, u, auditCtx(r)); }
  @Post('cases/:id/items/post') @HttpCode(200) @Roles('admin', 'or_nurse', 'nurse')
  post(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.post(id, u, auditCtx(r)); }
  @Post('cases/:id/counts') @Roles('admin', 'or_nurse', 'nurse')
  count(@Param('id', ParseUUIDPipe) id: string, @Body() d: CountDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.count(id, d, u, auditCtx(r)); }
  @Post('cases/:id/packs') @Roles('admin', 'or_nurse', 'nurse')
  pack(@Param('id', ParseUUIDPipe) id: string, @Body() d: PackDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.addPack(id, d, u, auditCtx(r)); }
  @Post('packs/:cpid/remove') @HttpCode(200) @Roles('admin', 'or_nurse', 'nurse')
  rmPack(@Param('cpid', ParseUUIDPipe) cpid: string, @Body() d: PackRemoveDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.removePack(cpid, d.reason, u, auditCtx(r)); }
  @Get('preference-cards') @Roles(...OR_READ) cards(@Query('procedure_id') pid?: string, @Query('surgeon_id') sid?: string) {
    const uuid = /^[0-9a-f-]{36}$/i;
    if ((pid && !uuid.test(pid)) || (sid && !uuid.test(sid))) throw new BadRequestException('არასწორი id');
    return this.s.cards(pid, sid);
  }
  @Put('preference-cards') @Roles('admin', 'or_nurse', 'doctor') saveCard(@Body() d: CardDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.saveCard(d, u, auditCtx(r)); }
  @Get('catalog-items') @Roles('admin', 'or_nurse', 'doctor') catalog(@Query('q') q?: string) { return q && q.trim().length >= 2 ? this.s.catalog(q) : []; }
  @Get('implants') @Roles(...OR_READ, 'receptionist', 'billing') implants(@Query('patient_id', ParseUUIDPipe) pid: string) { return this.s.implants(pid); }
}
