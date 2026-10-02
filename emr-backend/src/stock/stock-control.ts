import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import { IsIn, IsNumber, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min } from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser, type Role } from '../auth/roles';
import { loadEnv } from '../config/env';
import { InjectDb, type Database } from '../database/database.module';
import { StockAlertsService } from './stock-alerts';
import { STOCK_READ } from './stock-catalog';
import { StockTransfersService } from './stock-transfers';

const TZ = loadEnv().CLINIC_TZ;
/** ლოტის ქარანტინი / გაწვევა */
export const LOT_STATUS_EDIT: Role[] = ['admin', 'stock_manager', 'pharmacist'];
/** რეპორტები */
export const STOCK_REPORTS: Role[] = ['admin', 'stock_manager', 'storekeeper', 'pharmacist', 'manager', 'viewer', 'accountant'];
const r2 = (n: number) => Math.round(n * 100) / 100;
const STATUS_KA: Record<string, string> = { active: 'აქტიური', quarantine: 'ქარანტინი', recalled: 'გაწვეული' };

@Injectable()
export class StockControlService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService, private readonly t: StockTransfersService, private readonly alerts: StockAlertsService) {}

  // ================================================================= ლოტები: ძებნა, მიკვლევა, სტატუსი
  lots(q: { search?: string; status?: string }) {
    let x = this.db.selectFrom('stock_lots as lt').innerJoin('stock_items as i', 'i.id', 'lt.item_id').leftJoin('med_generics as g', 'g.id', 'i.generic_id')
      .select(['lt.id', 'lt.lot_no', 'lt.serial_no', 'lt.expires_on', 'lt.status', 'lt.status_reason', 'lt.created_at', 'i.id as item_id', 'i.name as item_name', 'i.code as item_code', 'g.inn',
        sql<string>`coalesce((SELECT sum(b.qty) FROM stock_balances b WHERE b.lot_id = lt.id), 0)`.as('qty'),
        sql<number>`(SELECT count(DISTINCT m.patient_id)::int FROM stock_moves m WHERE m.lot_id = lt.id AND m.move_type = 'consumption' AND m.patient_id IS NOT NULL)`.as('patients')])
      .orderBy('lt.created_at', 'desc').limit(200);
    const s = q.search?.trim();
    if (s) x = x.where((eb) => eb.or([eb(sql`upper(coalesce(lt.lot_no, ''))`, 'like', `%${s.toUpperCase()}%`), eb(sql`upper(coalesce(lt.serial_no, ''))`, 'like', `%${s.toUpperCase()}%`),
      eb(sql`lower(i.name)`, 'like', `%${s.toLowerCase()}%`), eb(sql`lower(coalesce(g.inn, ''))`, 'like', `%${s.toLowerCase()}%`)]));
    if (q.status === 'blocked') x = x.where('lt.status', '<>', 'active');
    else if (!s) x = x.where('lt.status', '<>', 'active');           // ძებნის გარეშე — მხოლოდ დაბლოკილები
    return x.execute();
  }

  async trace(id: string) {
    const lot = await this.db.selectFrom('stock_lots as lt').innerJoin('stock_items as i', 'i.id', 'lt.item_id').innerJoin('stock_units as un', 'un.code', 'i.base_unit')
      .leftJoin('stock_suppliers as s', 's.id', 'lt.first_supplier_id').leftJoin('med_generics as g', 'g.id', 'i.generic_id')
      .selectAll('lt').select(['i.name as item_name', 'i.code as item_code', 'un.name as base_unit_name', 's.name as supplier_name', 'g.inn', 'g.controlled_class'])
      .where('lt.id', '=', id).executeTakeFirst();
    if (!lot) throw new NotFoundException('ლოტი ვერ მოიძებნა');
    const [locations, patients, events, docs] = await Promise.all([
      this.db.selectFrom('stock_balances as b').innerJoin('stock_locations as l', 'l.id', 'b.location_id').select(['l.id', 'l.name', 'l.kind', 'b.qty']).where('b.lot_id', '=', id).where('b.qty', '>', '0').orderBy('l.name').execute(),
      // პაციენტები: ხარჯი (შემობრუნების ჩათვლით — ნეტო)
      this.db.selectFrom('stock_moves as m').innerJoin('patients as p', 'p.id', 'm.patient_id').leftJoin('stock_locations as l', 'l.id', 'm.location_id')
        .select(['p.id as patient_id', sql<string>`p.first_name || ' ' || p.last_name`.as('patient_name'), 'p.personal_number', 'p.phone_number',
          sql<string>`-sum(m.qty)`.as('qty'), sql<string>`max(m.created_at)`.as('last_at'), sql<string>`string_agg(DISTINCT l.name, ', ')`.as('locations')])
        .where('m.lot_id', '=', id).where('m.move_type', '=', 'consumption').groupBy(['p.id', 'p.first_name', 'p.last_name', 'p.personal_number', 'p.phone_number'])
        .having(sql`sum(m.qty)`, '<', 0).execute(),
      this.db.selectFrom('stock_lot_events as e').innerJoin('users as u', 'u.id', 'e.created_by').select(['e.id', 'e.from_status', 'e.to_status', 'e.reason', 'e.reference', 'e.created_at',
        sql<string>`u.first_name || ' ' || u.last_name`.as('user_name')]).where('e.lot_id', '=', id).orderBy('e.created_at', 'desc').execute(),
      this.db.selectFrom('stock_moves as m').innerJoin('stock_docs as d', 'd.id', 'm.doc_id').innerJoin('stock_locations as l', 'l.id', 'm.location_id')
        .select(['m.id', 'm.created_at', 'm.move_type', 'm.qty', 'd.doc_no', 'd.doc_type', 'l.name as location_name']).where('m.lot_id', '=', id).orderBy('m.id', 'desc').limit(300).execute(),
    ]);
    return { lot, locations, patients, events, moves: docs };
  }

  async setStatus(id: string, dto: { status: 'active' | 'quarantine' | 'recalled'; reason: string; reference?: string | null }, u: AuthUser, ctx: AuditContext) {
    let notify: { ids: string[]; title: string; body: string; urgent: boolean } | null = null;
    await this.db.transaction().execute(async (trx) => {
      const lot = await trx.selectFrom('stock_lots as lt').innerJoin('stock_items as i', 'i.id', 'lt.item_id').leftJoin('stock_categories as c', 'c.id', 'i.category_id')
        .select(['lt.id', 'lt.status', 'lt.lot_no', 'lt.serial_no', 'i.name', 'c.kind']).where('lt.id', '=', id).forUpdate('lt').executeTakeFirst();
      if (!lot) throw new NotFoundException('ლოტი ვერ მოიძებნა');
      if (lot.status === dto.status) throw new ConflictException(`ლოტი უკვე „${STATUS_KA[dto.status]}“ სტატუსშია`);
      if (has(u, 'pharmacist') && !has(u, 'admin', 'stock_manager') && !['medication', 'medical_supply', 'implant'].includes(lot.kind ?? '')) throw new ForbiddenException('ფარმაცევტი — მხოლოდ მედიკამენტი / სამედიცინო მასალა / იმპლანტი');
      await trx.updateTable('stock_lots').set({ status: dto.status, status_reason: dto.status === 'active' ? null : dto.reason.trim() }).where('id', '=', id).execute();
      await trx.insertInto('stock_lot_events').values({ lot_id: id, from_status: lot.status, to_status: dto.status, reason: dto.reason.trim(), reference: dto.reference?.trim() || null, created_by: u.id }).execute();
      await this.audit.log(ctx, { action: 'SET_STOCK_LOT_STATUS', entityName: 'stock_lots', entityId: id, oldData: { status: lot.status }, newData: dto }, trx);
      if (dto.status !== 'active') {
        const locs = await trx.selectFrom('stock_balances as b').innerJoin('stock_locations as l', 'l.id', 'b.location_id').select(['l.kind', 'l.department_id', 'l.name'])
          .where('b.lot_id', '=', id).where('b.qty', '>', '0').where('l.kind', '<>', 'transit').execute();
        const ids: string[] = [];
        for (const l of locs) ids.push(...(await this.alerts.recipients(l)));
        notify = { ids, urgent: dto.status === 'recalled', title: `${dto.status === 'recalled' ? 'გაწვევა' : 'ქარანტინი'}: ${lot.name} — ლოტი ${lot.lot_no ?? ''}${lot.serial_no ? ` SN ${lot.serial_no}` : ''}`,
          body: `${dto.reason.trim()}${locs.length ? ` · ნაშთი: ${locs.map((x) => x.name).join(', ')}` : ''} — გაცემა / ხარჯი დაბლოკილია` };
      }
    });
    if (notify) {
      const n = notify as { ids: string[]; title: string; body: string; urgent: boolean };
      await this.t.notifyMany(n.ids, { kind: 'stock_recall', title: n.title, body: n.body, urgent: n.urgent, link: `/stock/lots?lot=${id}`, entityId: id }, u.id);
    }
    return this.trace(id);
  }

  // ================================================================= მინ/მაქს
  private async canMinmax(u: AuthUser, locationId: string) {
    if (has(u, 'admin', 'stock_manager')) return;
    const l = await this.t.loc(locationId);
    const me = await this.t.me(u);
    if (l.department_id && me.department_id === l.department_id && (me.is_section_head || has(u, 'manager'))) return;
    throw new ForbiddenException('მინ/მაქს — საწყობის მენეჯერი ან განყოფილების ხელმძღვანელი');
  }
  minmax(locationId: string) { return this.alerts.belowMin(locationId, true); }

  async setMinmax(dto: { location_id: string; item_id: string; min_qty: number; max_qty: number }, u: AuthUser, ctx: AuditContext) {
    await this.canMinmax(u, dto.location_id);
    if (dto.max_qty < dto.min_qty) throw new BadRequestException('მაქსიმუმი მინიმუმზე ნაკლები ვერ იქნება');
    const l = await this.t.loc(dto.location_id);
    if (l.kind === 'transit') throw new BadRequestException('„გზაში“ — არა');
    const it = await this.db.selectFrom('stock_items').select(['id', 'is_active']).where('id', '=', dto.item_id).executeTakeFirst();
    if (!it?.is_active) throw new BadRequestException('საქონელი ვერ მოიძებნა ან გათიშულია');
    await this.db.insertInto('stock_minmax').values({ location_id: dto.location_id, item_id: dto.item_id, min_qty: String(dto.min_qty), max_qty: String(dto.max_qty), updated_by: u.id })
      .onConflict((oc) => oc.columns(['location_id', 'item_id']).doUpdateSet({ min_qty: String(dto.min_qty), max_qty: String(dto.max_qty), updated_by: u.id, updated_at: sql`now()` })).execute();
    await this.audit.log(ctx, { action: 'SET_STOCK_MINMAX', entityName: 'stock_minmax', entityId: dto.location_id, newData: dto });
    return this.minmax(dto.location_id);
  }

  async delMinmax(locationId: string, itemId: string, u: AuthUser, ctx: AuditContext) {
    await this.canMinmax(u, locationId);
    const r = await this.db.deleteFrom('stock_minmax').where('location_id', '=', locationId).where('item_id', '=', itemId).executeTakeFirst();
    if (!Number(r.numDeletedRows)) throw new NotFoundException('ჩანაწერი ვერ მოიძებნა');
    await this.audit.log(ctx, { action: 'DELETE_STOCK_MINMAX', entityName: 'stock_minmax', entityId: locationId, oldData: { item_id: itemId } });
    return this.minmax(locationId);
  }

  /** მინიმუმზე ქვემოთ → მოთხოვნის მონახაზი მაქსიმუმამდე (წყარო — ლოკაციის ნაგულისხმევი ან მითითებული) */
  async requestFromMinmax(dto: { location_id: string; from_location_id?: string | null }, u: AuthUser, ctx: AuditContext) {
    const l = await this.t.loc(dto.location_id);
    await this.t.requireOperate(u, l, 'მოთხოვნა');
    const from = dto.from_location_id ?? (await this.db.selectFrom('stock_locations').select('default_source_id').where('id', '=', l.id).executeTakeFirst())?.default_source_id;
    if (!from) throw new BadRequestException('მიუთითეთ, საიდან მოვითხოვოთ (ან ლოკაციას დაუყენეთ ნაგულისხმევი მომწოდებელი ლოკაცია)');
    const below = await this.alerts.belowMin(l.id);
    if (!below.length) throw new ConflictException('მინიმუმზე ქვემოთ არაფერია');
    const r = await this.t.createRequest({ from_location_id: from, to_location_id: l.id, notes: 'მინ/მაქს — ავტომატური მონახაზი',
      lines: below.map((b) => ({ item_id: b.item_id, qty: b.suggested })) }, u, ctx);
    return r;
  }

  // ================================================================= რეპორტები
  private period(from: string, to: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) throw new BadRequestException('პერიოდი: from ≤ to (YYYY-MM-DD)');
    return { a: sql<Date>`(${from}::date)::timestamp AT TIME ZONE ${TZ}`, b: sql<Date>`(${to}::date + 1)::timestamp AT TIME ZONE ${TZ}` };
  }
  private async method() { return (await this.db.selectFrom('stock_settings').select('costing_method').where('id', '=', 1).executeTakeFirstOrThrow()).costing_method; }

  /** ნაშთის ღირებულება ახლა: ლოკაცია × კატეგორია */
  async valueReport() {
    const m = await this.method();
    const cost = m === 'fifo' ? sql`lt.unit_cost` : sql`coalesce(ic.avg_cost, lt.unit_cost)`;
    const rows = await this.db.selectFrom('stock_balances as b').innerJoin('stock_lots as lt', 'lt.id', 'b.lot_id').innerJoin('stock_items as i', 'i.id', 'b.item_id')
      .innerJoin('stock_categories as c', 'c.id', 'i.category_id').innerJoin('stock_locations as l', 'l.id', 'b.location_id').leftJoin('stock_item_costs as ic', 'ic.item_id', 'b.item_id')
      .select(['l.name as location_name', 'c.name as category_name', sql<number>`count(DISTINCT b.item_id)::int`.as('items'), sql<number>`count(*)::int`.as('lots'),
        sql<string>`round(sum(b.qty * ${cost}), 2)`.as('value')])
      .where('b.qty', '>', '0').groupBy(['l.name', 'c.name']).orderBy('l.name').orderBy('c.name').execute();
    return { costing_method: m, total: r2(rows.reduce((a, x) => a + Number(x.value), 0)), rows };
  }

  /** მოძრაობის უწყისი: საწყისი, მიღება, გადაადგილება (ნეტო), ხარჯი, ჩამოწერა, კორექტირება, საბოლოო — რაოდენობა და ღირებულება */
  async turnover(q: { from: string; to: string; location_id?: string; category_id?: string }) {
    const { a, b } = this.period(q.from, q.to);
    const m = await this.method();
    const cost = m === 'fifo' ? sql`m.cost_lot` : sql`coalesce(m.cost_avg, m.cost_lot)`;
    let x = this.db.selectFrom('stock_moves as m').innerJoin('stock_items as i', 'i.id', 'm.item_id').innerJoin('stock_units as un', 'un.code', 'i.base_unit')
      .innerJoin('stock_locations as l', 'l.id', 'm.location_id')
      .select(['i.id as item_id', 'i.name as item_name', 'i.code as item_code', 'un.name as unit',
        sql<string>`sum(m.qty) FILTER (WHERE m.created_at < ${a})`.as('open_qty'), sql<string>`sum(m.qty * ${cost}) FILTER (WHERE m.created_at < ${a})`.as('open_value'),
        ...(['receipt', 'consumption', 'writeoff', 'adjustment'] as const).flatMap((t) => [
          sql<string>`sum(m.qty) FILTER (WHERE m.created_at >= ${a} AND m.created_at < ${b} AND m.move_type = ${t})`.as(`${t}_qty`),
          sql<string>`sum(m.qty * ${cost}) FILTER (WHERE m.created_at >= ${a} AND m.created_at < ${b} AND m.move_type = ${t})`.as(`${t}_value`)]),
        sql<string>`sum(m.qty) FILTER (WHERE m.created_at >= ${a} AND m.created_at < ${b} AND m.move_type IN ('transfer', 'issue', 'return'))`.as('transfer_qty'),
        sql<string>`sum(m.qty * ${cost}) FILTER (WHERE m.created_at >= ${a} AND m.created_at < ${b} AND m.move_type IN ('transfer', 'issue', 'return'))`.as('transfer_value'),
        sql<string>`sum(m.qty) FILTER (WHERE m.created_at < ${b})`.as('close_qty'), sql<string>`sum(m.qty * ${cost}) FILTER (WHERE m.created_at < ${b})`.as('close_value')])
      .where('m.created_at', '<', b).groupBy(['i.id', 'i.name', 'i.code', 'un.name']).orderBy('i.name');
    if (q.location_id) x = x.where('m.location_id', '=', q.location_id);
    if (q.category_id) x = x.where('i.category_id', '=', q.category_id);
    const n = (v: string | null) => Number(v ?? 0);
    const rows = (await x.execute()).map((r) => {
      const o: Record<string, unknown> = { item_id: r.item_id, item_name: r.item_name, item_code: r.item_code, unit: r.unit };
      for (const k of ['open', 'receipt', 'transfer', 'consumption', 'writeoff', 'adjustment', 'close']) {
        o[`${k}_qty`] = Math.round(n((r as Record<string, string | null>)[`${k}_qty`]) * 1000) / 1000;
        o[`${k}_value`] = r2(n((r as Record<string, string | null>)[`${k}_value`]));
      }
      return o as { item_id: string; item_name: string; item_code: string; unit: string } & Record<string, number>;
    }).filter((r) => r.open_qty || r.close_qty || r.receipt_qty || r.transfer_qty || r.consumption_qty || r.writeoff_qty || r.adjustment_qty);
    const tot = (k: string) => r2(rows.reduce((s, r) => s + (r[k] as number), 0));
    return { costing_method: m, rows, totals: Object.fromEntries(['open', 'receipt', 'transfer', 'consumption', 'writeoff', 'adjustment', 'close'].map((k) => [`${k}_value`, tot(`${k}_value`)])) };
  }

  /** ხარჯი: ლოკაციით / საქონლით (ნეტო, შემობრუნების ჩათვლით) + ინვოისში ჩაწერილი; ჩამოწერა მიზეზებით */
  async consumptionReport(q: { from: string; to: string; group: 'location' | 'item' }) {
    const { a, b } = this.period(q.from, q.to);
    const m = await this.method();
    const cost = m === 'fifo' ? sql`m.cost_lot` : sql`coalesce(m.cost_avg, m.cost_lot)`;
    const key = q.group === 'item' ? sql<string>`i.name` : sql<string>`l.name`;
    const cons = await this.db.selectFrom('stock_moves as m').innerJoin('stock_items as i', 'i.id', 'm.item_id').innerJoin('stock_locations as l', 'l.id', 'm.location_id')
      .leftJoin('stock_doc_lines as x', 'x.id', 'm.line_id')
      .select([key.as('name'), sql<number>`count(DISTINCT m.patient_id)::int`.as('patients'), sql<string>`round(-sum(m.qty * ${cost}), 2)`.as('cost'),
        sql<string>`coalesce(round(-sum(m.qty * x.sale_price) FILTER (WHERE m.qty < 0 AND EXISTS (SELECT 1 FROM invoice_line_items il WHERE il.stock_doc_line_id = m.line_id)), 2), 0)`.as('billed')])
      .where('m.move_type', '=', 'consumption').where('m.created_at', '>=', a).where('m.created_at', '<', b).groupBy(key).orderBy(sql`3`, 'desc').execute();
    const wo = await this.db.selectFrom('stock_moves as m').innerJoin('stock_docs as d', 'd.id', 'm.doc_id').innerJoin('stock_locations as l', 'l.id', 'm.location_id')
      .leftJoin('stock_docs as o', 'o.id', 'd.reversal_of')
      .select(['l.name as location_name', sql<string>`coalesce(d.writeoff_reason, o.writeoff_reason)`.as('reason'), sql<string>`round(-sum(m.qty * ${cost}), 2)`.as('value')])
      .where('m.move_type', '=', 'writeoff').where('m.created_at', '>=', a).where('m.created_at', '<', b)
      .groupBy(['l.name', sql`coalesce(d.writeoff_reason, o.writeoff_reason)`]).orderBy('l.name').execute();
    return { costing_method: m, consumption: cons.filter((r) => Number(r.cost) !== 0), writeoffs: wo.filter((r) => Number(r.value) !== 0) };
  }
}

// ======================================================================= DTO
class LotStatusDto { @IsIn(['active', 'quarantine', 'recalled']) status: 'active' | 'quarantine' | 'recalled'; @IsString() @Length(3, 1000) reason: string; @IsOptional() @IsString() @MaxLength(100) reference?: string | null }
class MinmaxDto { @IsUUID() location_id: string; @IsUUID() item_id: string; @IsNumber() @Min(0) @Max(10_000_000) min_qty: number; @IsNumber() @Min(0.001) @Max(10_000_000) max_qty: number }
class MinmaxReqDto { @IsUUID() location_id: string; @IsOptional() @IsUUID() from_location_id?: string | null }
const uuidOk = (v?: string) => !v || /^[0-9a-f-]{36}$/i.test(v);

@Controller('stock')
export class StockControlController {
  constructor(private readonly s: StockControlService, private readonly alerts: StockAlertsService) {}
  @Get('lots') @Roles(...STOCK_READ) lots(@Query('search') search?: string, @Query('status') status?: string) { return this.s.lots({ search, status }); }
  @Get('lots/:id/trace') @Roles(...STOCK_READ) trace(@Param('id', ParseUUIDPipe) id: string) { return this.s.trace(id); }
  @Post('lots/:id/status') @HttpCode(200) @Roles(...LOT_STATUS_EDIT) status(@Param('id', ParseUUIDPipe) id: string, @Body() d: LotStatusDto, @CurrentUser() u: AuthUser, @Req() r: Request) {
    return this.s.setStatus(id, d, u, auditCtx(r));
  }
  @Get('minmax') @Roles(...STOCK_READ) minmax(@Query('location_id') loc?: string) {
    if (!loc || !uuidOk(loc)) throw new BadRequestException('location_id სავალდებულოა');
    return this.s.minmax(loc);
  }
  @Put('minmax') @Roles(...STOCK_READ) setMinmax(@Body() d: MinmaxDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.setMinmax(d, u, auditCtx(r)); }
  @Delete('minmax/:loc/:item') @Roles(...STOCK_READ) delMinmax(@Param('loc', ParseUUIDPipe) loc: string, @Param('item', ParseUUIDPipe) item: string, @CurrentUser() u: AuthUser, @Req() r: Request) {
    return this.s.delMinmax(loc, item, u, auditCtx(r));
  }
  @Post('minmax/request') @Roles(...STOCK_READ) minmaxRequest(@Body() d: MinmaxReqDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.requestFromMinmax(d, u, auditCtx(r)); }
  @Get('reports/value') @Roles(...STOCK_REPORTS) value() { return this.s.valueReport(); }
  @Get('reports/turnover') @Roles(...STOCK_REPORTS) turnover(@Query() q: { from: string; to: string; location_id?: string; category_id?: string }) {
    if (!uuidOk(q.location_id) || !uuidOk(q.category_id)) throw new BadRequestException('არასწორი id');
    return this.s.turnover(q);
  }
  @Get('reports/consumption') @Roles(...STOCK_REPORTS) consumption(@Query() q: { from: string; to: string; group?: string }) {
    return this.s.consumptionReport({ from: q.from, to: q.to, group: q.group === 'item' ? 'item' : 'location' });
  }
  /** ვადების / მინიმუმის შემოწმება ახლავე (admin; worker ამას დღეში ერთხელ აკეთებს) */
  @Post('alerts/run') @HttpCode(200) @Roles('admin') run() { return this.alerts.tick(true); }
}
