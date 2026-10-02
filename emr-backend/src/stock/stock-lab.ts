import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { type AuthUser, type Role } from '../auth/roles';
import { loadEnv } from '../config/env';
import { InjectDb, type Database } from '../database/database.module';
import { StockTransfersService } from './stock-transfers';

const TZ = loadEnv().CLINIC_TZ;
const LAB: Role[] = ['admin', 'lab_doctor', 'lab_manager', 'diagnostic', 'stock_manager', 'storekeeper'];
const LAB_REPORT: Role[] = ['admin', 'lab_doctor', 'lab_manager', 'stock_manager', 'manager', 'viewer', 'accountant'];
const r2 = (n: number) => Math.round(n * 100) / 100;
const q3 = (n: number) => Math.round(n * 1000) / 1000;

/** ლაბორატორია ↔ საწყობი: ნაკრების გახსნა (7A), on-board ვადა, ტესტის თვითღირებულება, QC ლოტები */
@Injectable()
export class StockLabService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService, private readonly t: StockTransfersService) {}

  private async labLocation(u: AuthUser, id: string) {
    const l = await this.t.loc(id);
    if (l.kind !== 'lab') throw new BadRequestException('ლოკაცია ლაბორატორიის ქვესაწყობი არ არის');
    await this.t.requireOperate(u, l, 'ლაბორატორია');
    return l;
  }

  /** ლაბორატორიის ნაშთი (გასახსნელი): ლოტი, ვადა, ნაგულისხმევი ანალიზატორი / on-board / ტესტები */
  async stock(u: AuthUser, locationId: string) {
    await this.labLocation(u, locationId);
    const today = await this.t.today();
    return this.db.selectFrom('stock_balances as b').innerJoin('stock_lots as lt', 'lt.id', 'b.lot_id').innerJoin('stock_items as i', 'i.id', 'b.item_id')
      .innerJoin('stock_units as un', 'un.code', 'i.base_unit').innerJoin('stock_categories as c', 'c.id', 'i.category_id')
      .leftJoin('lab_methods as m', 'm.id', 'i.lab_method_id').leftJoin('lab_analytes as a', 'a.id', 'i.lab_analyte_id')
      .select(['b.lot_id', 'b.item_id', 'b.qty', 'lt.lot_no', 'lt.expires_on', 'lt.status', 'i.name as item_name', 'i.code as item_code', 'un.name as base_unit_name', 'c.kind as category_kind',
        'i.lab_tests_per_unit', 'i.lab_onboard_days', 'i.lab_method_id', 'i.lab_analyte_id', 'm.name as method_name', 'a.name as analyte_name',
        sql<boolean>`lt.status = 'active' AND (lt.expires_on IS NULL OR lt.expires_on >= ${today}::date)`.as('usable')])
      .where('b.location_id', '=', locationId).where('b.qty', '>', '0').orderBy('i.name').orderBy(sql`lt.expires_on NULLS LAST`).execute();
  }

  /** გახსნა: ჩამოწერა (lab_use, დამტკიცების გარეშე) + ნაკრების ჩანაწერი */
  async open(dto: { location_id: string; lot_id: string; qty_base?: number; method_id?: string | null; analyte_id?: string | null; onboard_days?: number | null; notes?: string | null }, u: AuthUser, ctx: AuditContext) {
    const l = await this.labLocation(u, dto.location_id);
    const qty = q3(dto.qty_base ?? 1);
    let kitId = '';
    try {
      await this.db.transaction().execute(async (trx) => {
        const today = await this.t.today(trx);
        const lot = await trx.selectFrom('stock_lots as lt').innerJoin('stock_items as i', 'i.id', 'lt.item_id')
          .leftJoin('stock_balances as b', (j) => j.onRef('b.lot_id', '=', 'lt.id').on('b.location_id', '=', l.id))
          .select(['lt.id', 'lt.item_id', 'lt.lot_no', 'lt.serial_no', 'lt.expires_on', 'lt.produced_on', 'lt.status', 'lt.unit_cost', 'i.name', 'i.lab_tests_per_unit', 'i.lab_onboard_days',
            'i.lab_method_id', 'i.lab_analyte_id', sql<string>`coalesce(b.qty, 0)`.as('qty')]).where('lt.id', '=', dto.lot_id).executeTakeFirst();
        if (!lot) throw new BadRequestException('ლოტი ვერ მოიძებნა');
        const tag = `„${lot.name}“${lot.lot_no ? ` (ლოტი ${lot.lot_no})` : ''}`;
        if (lot.status !== 'active') throw new BadRequestException(`${tag} დაბლოკილია`);
        if (lot.expires_on && lot.expires_on < today) throw new BadRequestException(`${tag} ვადაგასულია — გახსნა აკრძალულია`);
        if (qty > Number(lot.qty)) throw new BadRequestException(`${tag}: ნაშთი ${Number(lot.qty)}`);
        const method = dto.method_id ?? lot.lab_method_id; const analyte = dto.analyte_id ?? lot.lab_analyte_id;
        if (method) { const m = await trx.selectFrom('lab_methods').select('is_active').where('id', '=', method).executeTakeFirst(); if (!m?.is_active) throw new BadRequestException('ანალიზატორი ვერ მოიძებნა ან გათიშულია'); }
        const days = dto.onboard_days ?? lot.lab_onboard_days;
        const onboard = days ? (await sql<{ d: string }>`SELECT to_char(least(${today}::date + ${days}::int, coalesce(${lot.expires_on}::date, 'infinity'::date)), 'YYYY-MM-DD') AS d`.execute(trx)).rows[0].d : lot.expires_on;
        const d = await trx.insertInto('stock_docs').values({ doc_type: 'writeoff', doc_date: today, location_id: l.id, writeoff_reason: 'lab_use', notes: `ლაბორატორია: გახსნა${dto.notes ? ` — ${dto.notes.trim()}` : ''}`, created_by: u.id })
          .returning('id').executeTakeFirstOrThrow();
        const line = await trx.insertInto('stock_doc_lines').values({ doc_id: d.id, line_no: 1, item_id: lot.item_id, qty: String(qty), qty_base: String(qty), lot_no: lot.lot_no, serial_no: lot.serial_no,
          expires_on: lot.expires_on, produced_on: lot.produced_on, unit_cost: lot.unit_cost, lot_id: lot.id, line_net: String(r2(qty * Number(lot.unit_cost))) }).returning('id').executeTakeFirstOrThrow();
        await trx.insertInto('stock_moves').values({ doc_id: d.id, line_id: line.id, move_type: 'writeoff', location_id: l.id, lot_id: lot.id, item_id: lot.item_id, qty: String(-qty), cost_lot: lot.unit_cost, created_by: u.id }).execute();
        const no = await this.t.nextNo(trx, 'WO', today);
        await trx.updateTable('stock_docs').set({ status: 'posted', doc_no: no, posted_by: u.id, posted_at: sql`now()`, total_net: String(r2(qty * Number(lot.unit_cost))) }).where('id', '=', d.id).execute();
        const k = await trx.insertInto('stock_lab_kits').values({ location_id: l.id, item_id: lot.item_id, lot_id: lot.id, doc_id: d.id, qty_base: String(qty), method_id: method, analyte_id: analyte,
          tests_planned: lot.lab_tests_per_unit ? Math.round(lot.lab_tests_per_unit * qty) : null, opened_by: u.id, onboard_expires_on: onboard, notes: dto.notes?.trim() || null })
          .returning('id').executeTakeFirstOrThrow();
        kitId = k.id;
        await this.audit.log(ctx, { action: 'OPEN_LAB_KIT', entityName: 'stock_lab_kits', entityId: k.id, newData: { ...dto, doc_no: no, onboard_expires_on: onboard } }, trx);
      });
    } catch (e) {
      const err = e as { constraint?: string; message?: string };
      if (err.constraint === 'stock_location_counting') throw new ConflictException(err.message);
      if (err.constraint === 'stock_balances_non_negative') throw new ConflictException('ნაშთი არასაკმარისია');
      throw e;
    }
    return this.kit(kitId);
  }

  private kitsQuery() {
    return this.db.selectFrom('stock_lab_kits as k').innerJoin('stock_items as i', 'i.id', 'k.item_id').innerJoin('stock_lots as lt', 'lt.id', 'k.lot_id')
      .innerJoin('stock_locations as l', 'l.id', 'k.location_id').innerJoin('stock_docs as d', 'd.id', 'k.doc_id').innerJoin('users as u', 'u.id', 'k.opened_by')
      .leftJoin('users as cu', 'cu.id', 'k.closed_by').leftJoin('lab_methods as m', 'm.id', 'k.method_id').leftJoin('lab_analytes as a', 'a.id', 'k.analyte_id')
      .selectAll('k').select(['i.name as item_name', 'i.code as item_code', 'lt.lot_no', 'lt.expires_on', 'l.name as location_name', 'd.doc_no', 'd.total_net as cost', 'm.name as method_name', 'a.name as analyte_name',
        sql<string>`u.first_name || ' ' || u.last_name`.as('opened_by_name'), sql<string | null>`cu.first_name || ' ' || cu.last_name`.as('closed_by_name'),
        sql<number | null>`CASE WHEN k.onboard_expires_on IS NULL THEN NULL ELSE k.onboard_expires_on - (now() AT TIME ZONE ${TZ})::date END`.as('days_left'),
        // რეალურად შესრულებული: პაციენტის შედეგები + QC ამ ანალიზატორზე (და ანალიტზე, თუ მითითებულია) გახსნიდან დახურვამდე
        sql<number>`CASE WHEN k.method_id IS NULL THEN NULL ELSE (
          (SELECT count(*) FROM lab_results r JOIN dx_order_items oi ON oi.id = r.order_item_id WHERE oi.lab_method_id = k.method_id AND (k.analyte_id IS NULL OR r.analyte_id = k.analyte_id)
             AND r.entered_at >= k.opened_at AND r.entered_at < coalesce(k.closed_at, now()))
          + (SELECT count(*) FROM lab_qc_results q JOIN lab_qc_targets t ON t.id = q.target_id WHERE t.method_id = k.method_id AND (k.analyte_id IS NULL OR t.analyte_id = k.analyte_id)
             AND q.measured_at >= k.opened_at AND q.measured_at < coalesce(k.closed_at, now()))) END`.as('tests_done')]);
  }
  async kit(id: string) {
    const k = await this.kitsQuery().where('k.id', '=', id).executeTakeFirst();
    if (!k) throw new NotFoundException('ნაკრები ვერ მოიძებნა');
    return k;
  }
  kits(q: { location_id?: string; status?: string }) {
    let x = this.kitsQuery().orderBy('k.status').orderBy(sql`k.onboard_expires_on NULLS LAST`).orderBy('k.opened_at', 'desc').limit(500);
    if (q.location_id) x = x.where('k.location_id', '=', q.location_id);
    if (q.status) x = x.where('k.status', 'in', q.status.split(','));
    return x.execute();
  }

  async close(id: string, dto: { discarded?: boolean; reason?: string | null }, u: AuthUser, ctx: AuditContext) {
    const k = await this.db.selectFrom('stock_lab_kits').select(['id', 'status', 'location_id', 'onboard_expires_on']).where('id', '=', id).executeTakeFirst();
    if (!k) throw new NotFoundException('ნაკრები ვერ მოიძებნა');
    await this.labLocation(u, k.location_id);
    if (k.status !== 'in_use') throw new ConflictException('ნაკრები უკვე დახურულია');
    if (dto.discarded && (!dto.reason || dto.reason.trim().length < 3)) throw new BadRequestException('გადაყრის მიზეზი სავალდებულოა');
    await this.db.updateTable('stock_lab_kits').set({ status: dto.discarded ? 'discarded' : 'finished', closed_at: sql`now()`, closed_by: u.id, close_reason: dto.reason?.trim() || null })
      .where('id', '=', id).where('status', '=', 'in_use').execute();
    await this.audit.log(ctx, { action: dto.discarded ? 'DISCARD_LAB_KIT' : 'FINISH_LAB_KIT', entityName: 'stock_lab_kits', entityId: id, newData: dto });
    return this.kit(id);
  }

  /** ტესტის თვითღირებულება პერიოდში: გახსნილი ნაკრებების ღირებულება / შესრულებული ტესტები (ანალიზატორით, ანალიტით) */
  async cost(q: { from: string; to: string }) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(q.from) || !/^\d{4}-\d{2}-\d{2}$/.test(q.to) || q.from > q.to) throw new BadRequestException('პერიოდი: from ≤ to');
    const a = sql<Date>`(${q.from}::date)::timestamp AT TIME ZONE ${TZ}`; const b = sql<Date>`(${q.to}::date + 1)::timestamp AT TIME ZONE ${TZ}`;
    const kits = await this.db.selectFrom('stock_lab_kits as k').innerJoin('stock_docs as d', 'd.id', 'k.doc_id').leftJoin('lab_methods as m', 'm.id', 'k.method_id').leftJoin('lab_analytes as a', 'a.id', 'k.analyte_id')
      .select(['k.method_id', 'k.analyte_id', 'm.name as method_name', 'a.name as analyte_name', sql<number>`count(*)::int`.as('kits'), sql<string>`sum(d.total_net)`.as('cost'),
        sql<string | null>`sum(k.tests_planned)`.as('planned')])
      .where('k.opened_at', '>=', a).where('k.opened_at', '<', b).where('d.reversed_by', 'is', null)
      .groupBy(['k.method_id', 'k.analyte_id', 'm.name', 'a.name']).orderBy('m.name').execute();
    const out = [];
    for (const r of kits) {
      let patient = 0; let qc = 0;
      if (r.method_id) {
        const p = await this.db.selectFrom('lab_results as lr').innerJoin('dx_order_items as oi', 'oi.id', 'lr.order_item_id').select(sql<number>`count(*)::int`.as('n'))
          .where('oi.lab_method_id', '=', r.method_id).where('lr.entered_at', '>=', a).where('lr.entered_at', '<', b)
          .$if(!!r.analyte_id, (x) => x.where('lr.analyte_id', '=', r.analyte_id!)).executeTakeFirstOrThrow();
        const c = await this.db.selectFrom('lab_qc_results as qr').innerJoin('lab_qc_targets as t', 't.id', 'qr.target_id').select(sql<number>`count(*)::int`.as('n'))
          .where('t.method_id', '=', r.method_id).where('qr.measured_at', '>=', a).where('qr.measured_at', '<', b)
          .$if(!!r.analyte_id, (x) => x.where('t.analyte_id', '=', r.analyte_id!)).executeTakeFirstOrThrow();
        patient = p.n; qc = c.n;
      }
      const total = patient + qc; const cost = Number(r.cost);
      out.push({ ...r, cost: r2(cost), planned: r.planned === null ? null : Number(r.planned), patient_tests: patient, qc_tests: qc,
        cost_per_test: total ? r2(cost / total) : null, cost_per_patient_test: patient ? r2(cost / patient) : null,
        efficiency: r.planned && Number(r.planned) > 0 ? Math.round((total / Number(r.planned)) * 1000) / 10 : null });
    }
    return { from: q.from, to: q.to, rows: out, total_cost: r2(out.reduce((s, x) => s + x.cost, 0)) };
  }

  /** QC მასალისთვის — საწყობის ლოტები (QC კატეგორია) */
  qcLots() {
    return this.db.selectFrom('stock_lots as lt').innerJoin('stock_items as i', 'i.id', 'lt.item_id').innerJoin('stock_categories as c', 'c.id', 'i.category_id')
      .select(['lt.id', 'lt.lot_no', 'lt.expires_on', 'lt.status', 'i.name as item_name', 'i.manufacturer', sql<string>`coalesce((SELECT sum(b.qty) FROM stock_balances b WHERE b.lot_id = lt.id), 0)`.as('qty'),
        sql<number>`(SELECT count(*)::int FROM lab_qc_materials m WHERE m.stock_lot_id = lt.id AND m.is_active)`.as('materials')])
      .where('c.kind', '=', 'qc_material').where('lt.lot_no', 'is not', null).where('i.is_active', '=', true)
      .orderBy('i.name').orderBy(sql`lt.expires_on NULLS LAST`).limit(500).execute();
  }
}

// ======================================================================= DTO
class OpenDto {
  @IsUUID() location_id: string; @IsUUID() lot_id: string; @IsOptional() @IsNumber() @Min(0.001) @Max(10_000) qty_base?: number;
  @IsOptional() @IsUUID() method_id?: string | null; @IsOptional() @IsUUID() analyte_id?: string | null; @IsOptional() @IsInt() @Min(1) @Max(730) onboard_days?: number | null;
  @IsOptional() @IsString() @MaxLength(500) notes?: string | null;
}
class CloseDto { @IsOptional() @IsBoolean() discarded?: boolean; @IsOptional() @IsString() @MaxLength(500) reason?: string | null }
const uuidOk = (v?: string) => !v || /^[0-9a-f-]{36}$/i.test(v);

@Controller('stock/lab')
export class StockLabController {
  constructor(private readonly s: StockLabService) {}
  @Get('stock') @Roles(...LAB) stock(@CurrentUser() u: AuthUser, @Query('location_id') loc: string) { if (!loc || !uuidOk(loc)) throw new BadRequestException('location_id სავალდებულოა'); return this.s.stock(u, loc); }
  @Post('kits') @Roles(...LAB) open(@Body() d: OpenDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.open(d, u, auditCtx(r)); }
  @Get('kits') @Roles(...LAB, ...LAB_REPORT) kits(@Query('location_id') location_id?: string, @Query('status') status?: string) {
    if (!uuidOk(location_id)) throw new BadRequestException('არასწორი id');
    if (status && status.split(',').some((x) => !['in_use', 'finished', 'discarded'].includes(x))) throw new BadRequestException('უცნობი სტატუსი');
    return this.s.kits({ location_id, status });
  }
  @Get('kits/:id') @Roles(...LAB, ...LAB_REPORT) kit(@Param('id', ParseUUIDPipe) id: string) { return this.s.kit(id); }
  @Post('kits/:id/close') @HttpCode(200) @Roles(...LAB) close(@Param('id', ParseUUIDPipe) id: string, @Body() d: CloseDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.close(id, d, u, auditCtx(r)); }
  @Get('cost') @Roles(...LAB_REPORT) cost(@Query() q: { from: string; to: string }) { return this.s.cost(q); }
  @Get('qc-lots') @Roles(...LAB) qcLots() { return this.s.qcLots(); }
}
