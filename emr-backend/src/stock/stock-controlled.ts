import { BadRequestException, Body, Controller, ForbiddenException, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsNumber, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser, type Role } from '../auth/roles';
import { loadEnv } from '../config/env';
import { InjectDb, type Database } from '../database/database.module';
import { STOCK_READ } from './stock-catalog';
import { StockTransfersService } from './stock-transfers';

const TZ = loadEnv().CLINIC_TZ;
/** მოწმე / ცვლის ჩაბარება: სამედიცინო ან საწყობის თანამშრომელი */
const WITNESS_CAPS = ['nurse', 'doctor', 'pharmacist', 'admin', 'stock_manager', 'storekeeper', 'endoscopy_nurse', 'lab_doctor'];
/** მოწმე სავალდებულოა: ხარჯი პაციენტზე, ჩამოწერა */
export const WITNESS_CLASSES = ['narcotic', 'psychotropic'];
/** ცარიელი ამპულის დაბრუნება */
export const EMPTY_RETURN_CLASSES = ['narcotic'];
/** ცარიელების მიღება აფთიაქში */
const EMPTIES_CONFIRM: Role[] = ['admin', 'pharmacist', 'storekeeper', 'stock_manager'];
const CONTROLLED_VIEW: Role[] = ['admin', 'stock_manager', 'storekeeper', 'pharmacist', 'manager', 'viewer'];
export interface WitnessIn { username: string; password: string }
const q3 = (n: number) => Math.round(n * 1000) / 1000;

/** მოწმის დადასტურება (მეორე პირი, საკუთარი პაროლით) */
@Injectable()
export class StockWitnessService {
  constructor(@InjectDb() private readonly db: Database, private readonly auth: AuthService) {}
  async verify(w: WitnessIn | undefined | null, u: AuthUser, ctx: AuditContext, purpose: string) {
    if (!w?.username || !w.password) throw new BadRequestException('კონტროლირებადი საშუალება — საჭიროა მოწმე (მეორე თანამშრომელი: მომხმარებელი და პაროლი)');
    const r = await this.auth.verifyWitness(w.username, w.password, ctx, purpose).catch(() => { throw new BadRequestException('მოწმის მომხმარებელი ან პაროლი არასწორია'); });
    if (r.id === u.id) throw new BadRequestException('მოწმე სხვა პირი უნდა იყოს');
    const caps = await this.db.selectFrom('user_capabilities').select('capabilities').where('user_id', '=', r.id).executeTakeFirst();
    if (!caps?.capabilities?.some((c) => WITNESS_CAPS.includes(c))) throw new ForbiddenException('მოწმე — სამედიცინო ან საწყობის თანამშრომელი');
    return r;
  }
}

@Injectable()
export class StockControlledService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService, private readonly t: StockTransfersService, private readonly w: StockWitnessService) {}

  private async canView(u: AuthUser, locationId: string) {
    if (has(u, ...CONTROLLED_VIEW)) return;
    const l = await this.t.loc(locationId);
    if (!(await this.t.canOperate(u, l))) throw new ForbiddenException('ჟურნალი — მხოლოდ საკუთარი ლოკაცია');
  }

  /** ნაშთი ლოკაციებზე + დაუბრუნებელი ცარიელები */
  async summary(u: AuthUser) {
    const rows = await this.db.selectFrom('stock_balances as b').innerJoin('stock_items as i', 'i.id', 'b.item_id').innerJoin('med_generics as g', 'g.id', 'i.generic_id')
      .innerJoin('stock_locations as l', 'l.id', 'b.location_id').innerJoin('stock_units as un', 'un.code', 'i.base_unit')
      .select(['l.id as location_id', 'l.name as location_name', 'l.kind', 'l.department_id', 'i.id as item_id', 'i.name as item_name', 'i.code as item_code', 'g.controlled_class', 'un.name as base_unit_name',
        sql<string>`sum(b.qty)`.as('qty'), sql<string | null>`(SELECT max(s.created_at) FROM stock_shift_counts s WHERE s.location_id = l.id)`.as('last_shift')])
      .where('g.controlled_class', 'in', WITNESS_CLASSES).where('b.qty', '>', '0')
      .groupBy(['l.id', 'l.name', 'l.kind', 'l.department_id', 'i.id', 'i.name', 'i.code', 'g.controlled_class', 'un.name']).orderBy('l.name').orderBy('i.name').execute();
    const empties = await this.pendingEmpties();
    let out = rows;
    if (!has(u, ...CONTROLLED_VIEW)) { const me = await this.t.me(u); out = rows.filter((r) => r.department_id && r.department_id === me.department_id); }
    return { rows: out, empties_pending: empties.length };
  }

  /** ჟურნალი: ლოკაცია × საქონელი, თარიღით; საწყისი ნაშთი, შემოსავალი / გასავალი, მიმდინარე ნაშთი */
  async register(u: AuthUser, q: { location_id: string; item_id?: string; from: string; to: string }) {
    await this.canView(u, q.location_id);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(q.from) || !/^\d{4}-\d{2}-\d{2}$/.test(q.to) || q.from > q.to) throw new BadRequestException('პერიოდი: from ≤ to');
    const a = sql<Date>`(${q.from}::date)::timestamp AT TIME ZONE ${TZ}`; const b = sql<Date>`(${q.to}::date + 1)::timestamp AT TIME ZONE ${TZ}`;
    let items = this.db.selectFrom('stock_items as i').innerJoin('med_generics as g', 'g.id', 'i.generic_id').innerJoin('stock_units as un', 'un.code', 'i.base_unit')
      .select(['i.id', 'i.name', 'i.code', 'g.inn', 'g.strength', 'g.controlled_class', 'un.name as base_unit_name',
        sql<string>`coalesce((SELECT sum(m.qty) FROM stock_moves m WHERE m.item_id = i.id AND m.location_id = ${q.location_id} AND m.created_at < ${a}), 0)`.as('opening')])
      .where('g.controlled_class', 'in', WITNESS_CLASSES)
      .where(sql<boolean>`EXISTS (SELECT 1 FROM stock_moves m WHERE m.item_id = i.id AND m.location_id = ${q.location_id} AND m.created_at < ${b})`).orderBy('i.name');
    if (q.item_id) items = items.where('i.id', '=', q.item_id);
    const its = await items.execute();
    const out = [];
    for (const it of its) {
      const moves = await this.db.selectFrom('stock_moves as m').innerJoin('stock_docs as d', 'd.id', 'm.doc_id').innerJoin('users as u', 'u.id', 'm.created_by')
        .innerJoin('stock_lots as lt', 'lt.id', 'm.lot_id').leftJoin('stock_doc_lines as x', 'x.id', 'm.line_id')
        .leftJoin('users as w', 'w.id', 'd.witness_id').leftJoin('patients as p', 'p.id', 'm.patient_id').leftJoin('stock_suppliers as s', 's.id', 'd.supplier_id')
        .leftJoin('stock_locations as fl', 'fl.id', 'd.from_location_id').leftJoin('stock_locations as tl', 'tl.id', 'd.to_location_id')
        .leftJoin('stock_docs as o', 'o.id', 'd.reversal_of')
        .select(['m.id', 'm.created_at', 'm.move_type', 'm.qty', 'd.doc_no', 'd.doc_type', 'd.writeoff_reason', 'd.reason', 'o.doc_no as reversal_of_no', 'lt.lot_no', 'lt.serial_no', 'x.dose_given', 'x.dose_wasted', 'x.dose_unit',
          sql<string>`u.first_name || ' ' || u.last_name`.as('user_name'), sql<string | null>`w.first_name || ' ' || w.last_name`.as('witness_name'),
          sql<string | null>`p.first_name || ' ' || p.last_name`.as('patient_name'), 'p.personal_number', 's.name as supplier_name', 'fl.name as from_name', 'tl.name as to_name'])
        .where('m.item_id', '=', it.id).where('m.location_id', '=', q.location_id).where('m.created_at', '>=', a).where('m.created_at', '<', b).orderBy('m.id').execute();
      let bal = Number(it.opening);
      const rows = moves.map((m) => {
        const qn = Number(m.qty); bal = q3(bal + qn);
        const party = m.patient_name ? `${m.patient_name}${m.personal_number ? ` (${m.personal_number})` : ''}` : m.supplier_name ?? (qn < 0 ? m.to_name : m.from_name) ?? null;
        return { ...m, in: qn > 0 ? qn : 0, out: qn < 0 ? -qn : 0, balance: bal, party };
      });
      out.push({ item: it, opening: Number(it.opening), closing: bal, rows });
    }
    const loc = await this.t.loc(q.location_id);
    return { location: { id: loc.id, name: loc.name }, from: q.from, to: q.to, items: out };
  }

  // ---------------------------------------------------------------- ცარიელი ამპულები
  pendingEmpties(locationId?: string) {
    let x = this.db.selectFrom('stock_doc_lines as x').innerJoin('stock_docs as d', 'd.id', 'x.doc_id').innerJoin('stock_items as i', 'i.id', 'x.item_id')
      .innerJoin('med_generics as g', 'g.id', 'i.generic_id').innerJoin('stock_units as un', 'un.code', 'i.base_unit').innerJoin('stock_locations as l', 'l.id', 'd.location_id')
      .leftJoin('patients as p', 'p.id', 'd.patient_id').innerJoin('users as u', 'u.id', 'd.created_by')
      .select(['x.id', 'x.qty_base', 'x.lot_no', 'x.dose_given', 'x.dose_wasted', 'x.dose_unit', 'd.doc_no', 'd.posted_at', 'd.location_id', 'l.name as location_name', 'i.name as item_name', 'un.name as base_unit_name',
        sql<string | null>`p.first_name || ' ' || p.last_name`.as('patient_name'), sql<string>`u.first_name || ' ' || u.last_name`.as('user_name')])
      .where('d.doc_type', '=', 'consumption').where('d.status', '=', 'posted').where('d.reversed_by', 'is', null)
      .where('g.controlled_class', 'in', EMPTY_RETURN_CLASSES).where('x.empty_returned_at', 'is', null).orderBy('d.posted_at');
    if (locationId) x = x.where('d.location_id', '=', locationId);
    return x.execute();
  }

  async confirmEmpties(lineIds: string[], u: AuthUser, ctx: AuditContext) {
    const pending = await this.pendingEmpties();
    const ok = lineIds.filter((id) => pending.some((p) => p.id === id));
    if (ok.length !== lineIds.length) throw new BadRequestException('ზოგი ხაზი უკვე დადასტურებულია ან არ არის ნარკოტიკულის ხარჯი');
    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable('stock_doc_lines').set({ empty_returned_at: sql`now()`, empty_returned_by: u.id }).where('id', 'in', ok).execute();
      await this.audit.log(ctx, { action: 'CONFIRM_EMPTY_AMPOULES', entityName: 'stock_doc_lines', entityId: ok[0], newData: { lines: ok } }, trx);
    });
    return { confirmed: ok.length };
  }

  // ---------------------------------------------------------------- ცვლის ჩაბარება
  async shiftTemplate(u: AuthUser, locationId: string) {
    const l = await this.t.loc(locationId);
    await this.t.requireOperate(u, l, 'ცვლის ჩაბარება');
    return this.db.selectFrom('stock_balances as b').innerJoin('stock_lots as lt', 'lt.id', 'b.lot_id').innerJoin('stock_items as i', 'i.id', 'b.item_id')
      .innerJoin('med_generics as g', 'g.id', 'i.generic_id').innerJoin('stock_units as un', 'un.code', 'i.base_unit')
      .select(['b.lot_id', 'b.item_id', 'b.qty as expected_qty', 'lt.lot_no', 'lt.serial_no', 'lt.expires_on', 'i.name as item_name', 'un.name as base_unit_name', 'g.controlled_class'])
      .where('b.location_id', '=', locationId).where('b.qty', '>', '0').where('g.controlled_class', 'in', WITNESS_CLASSES).orderBy('i.name').orderBy('lt.expires_on').execute();
  }

  async shift(dto: { location_id: string; notes?: string | null; witness: WitnessIn; lines: { lot_id: string; counted_qty: number }[] }, u: AuthUser, ctx: AuditContext) {
    const l = await this.t.loc(dto.location_id);
    await this.t.requireOperate(u, l, 'ცვლის ჩაბარება');
    const wit = await this.w.verify(dto.witness, u, ctx, `shift:${l.id}`);
    const exp = await this.shiftTemplate(u, l.id);
    const missing = exp.filter((e) => !dto.lines.some((x) => x.lot_id === e.lot_id));
    if (missing.length) throw new BadRequestException(`დასათვლელია: ${missing.map((m) => `${m.item_name} (${m.lot_no ?? '—'})`).join(', ')}`);
    let id = ''; let bad: string[] = [];
    await this.db.transaction().execute(async (trx) => {
      const no = await this.t.nextNo(trx, 'SH', await this.t.today(trx));
      const rows = [];
      for (const x of dto.lines) {
        const e = exp.find((y) => y.lot_id === x.lot_id);
        if (!e) {
          const lot = await trx.selectFrom('stock_lots as lt').innerJoin('stock_items as i', 'i.id', 'lt.item_id').innerJoin('med_generics as g', 'g.id', 'i.generic_id')
            .select(['lt.item_id', 'i.name', 'g.controlled_class']).where('lt.id', '=', x.lot_id).executeTakeFirst();
          if (!lot || !WITNESS_CLASSES.includes(lot.controlled_class ?? '')) throw new BadRequestException('ლოტი ვერ მოიძებნა ან არ არის კონტროლირებადი');
          rows.push({ item_id: lot.item_id, lot_id: x.lot_id, expected_qty: '0', counted_qty: String(q3(x.counted_qty)), name: lot.name });
        } else rows.push({ item_id: e.item_id, lot_id: x.lot_id, expected_qty: e.expected_qty, counted_qty: String(q3(x.counted_qty)), name: e.item_name });
      }
      bad = rows.filter((r) => Number(r.expected_qty) !== Number(r.counted_qty)).map((r) => `${r.name}: სისტემაში ${Number(r.expected_qty)}, დათვლილი ${Number(r.counted_qty)}`);
      const s = await trx.insertInto('stock_shift_counts').values({ shift_no: no, location_id: l.id, handed_by: u.id, received_by: wit.id, status: bad.length ? 'discrepancy' : 'ok', notes: dto.notes?.trim() || null })
        .returning('id').executeTakeFirstOrThrow();
      id = s.id;
      if (rows.length) await trx.insertInto('stock_shift_count_lines').values(rows.map(({ name: _n, ...r }) => ({ ...r, shift_id: id }))).execute();
      await this.audit.log(ctx, { action: 'STOCK_SHIFT_COUNT', entityName: 'stock_shift_counts', entityId: id, newData: { shift_no: no, location: l.name, received_by: wit.id, discrepancies: bad } }, trx);
    });
    if (bad.length) {
      const ids = await this.t.usersWith(['stock_manager', 'pharmacist']);
      await this.t.notifyMany(ids, { kind: 'stock_shift', title: `ცვლის ჩაბარება — სხვაობა (${l.name})`, body: bad.join('; '), urgent: true, link: `/stock/controlled?shift=${id}`, entityId: id });
    }
    return this.shiftOne(id);
  }

  async shifts(u: AuthUser, locationId?: string) {
    let x = this.db.selectFrom('stock_shift_counts as s').innerJoin('stock_locations as l', 'l.id', 's.location_id').innerJoin('users as h', 'h.id', 's.handed_by').innerJoin('users as r', 'r.id', 's.received_by')
      .select(['s.id', 's.shift_no', 's.status', 's.notes', 's.created_at', 'l.name as location_name', 'l.department_id', sql<string>`h.first_name || ' ' || h.last_name`.as('handed_by_name'),
        sql<string>`r.first_name || ' ' || r.last_name`.as('received_by_name'), sql<number>`(SELECT count(*)::int FROM stock_shift_count_lines x WHERE x.shift_id = s.id)`.as('lines')])
      .orderBy('s.created_at', 'desc').limit(200);
    if (locationId) x = x.where('s.location_id', '=', locationId);
    const rows = await x.execute();
    if (has(u, ...CONTROLLED_VIEW)) return rows;
    const me = await this.t.me(u);
    return rows.filter((r) => r.department_id && r.department_id === me.department_id);
  }

  async shiftOne(id: string) {
    const s = await this.db.selectFrom('stock_shift_counts as s').innerJoin('stock_locations as l', 'l.id', 's.location_id').innerJoin('users as h', 'h.id', 's.handed_by').innerJoin('users as r', 'r.id', 's.received_by')
      .selectAll('s').select(['l.name as location_name', sql<string>`h.first_name || ' ' || h.last_name`.as('handed_by_name'), sql<string>`r.first_name || ' ' || r.last_name`.as('received_by_name')])
      .where('s.id', '=', id).executeTakeFirst();
    if (!s) throw new NotFoundException('ჩანაწერი ვერ მოიძებნა');
    const lines = await this.db.selectFrom('stock_shift_count_lines as x').innerJoin('stock_items as i', 'i.id', 'x.item_id').innerJoin('stock_lots as lt', 'lt.id', 'x.lot_id')
      .select(['x.id', 'x.expected_qty', 'x.counted_qty', 'i.name as item_name', 'lt.lot_no', 'lt.serial_no']).where('x.shift_id', '=', id).orderBy('i.name').execute();
    return { ...s, lines };
  }
}

// ======================================================================= DTO
export class WitnessDto { @IsString() @Length(3, 200) username: string; @IsString() @Length(1, 200) password: string }
class ShiftLineDto { @IsUUID() lot_id: string; @IsNumber() @Min(0) @Max(1_000_000) counted_qty: number }
class ShiftDto {
  @IsUUID() location_id: string; @IsOptional() @IsString() @MaxLength(1000) notes?: string | null;
  @ValidateNested() @Type(() => WitnessDto) witness: WitnessDto;
  @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => ShiftLineDto) lines: ShiftLineDto[];
}
class EmptiesDto { @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @IsUUID('all', { each: true }) line_ids: string[] }
const uuidOk = (v?: string) => !v || /^[0-9a-f-]{36}$/i.test(v);

@Controller('stock/controlled')
export class StockControlledController {
  constructor(private readonly s: StockControlledService) {}
  @Get('summary') @Roles(...STOCK_READ) summary(@CurrentUser() u: AuthUser) { return this.s.summary(u); }
  @Get('register') @Roles(...STOCK_READ) register(@CurrentUser() u: AuthUser, @Query() q: { location_id: string; item_id?: string; from: string; to: string }) {
    if (!q.location_id || !uuidOk(q.location_id) || !uuidOk(q.item_id)) throw new BadRequestException('location_id სავალდებულოა');
    return this.s.register(u, q);
  }
  @Get('empties') @Roles(...STOCK_READ) empties(@Query('location_id') loc?: string) { if (!uuidOk(loc)) throw new BadRequestException('არასწორი id'); return this.s.pendingEmpties(loc); }
  @Post('empties/confirm') @Roles(...EMPTIES_CONFIRM) confirm(@Body() d: EmptiesDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.confirmEmpties(d.line_ids, u, auditCtx(r)); }
  @Get('shift/template') @Roles(...STOCK_READ) template(@CurrentUser() u: AuthUser, @Query('location_id') loc: string) {
    if (!loc || !uuidOk(loc)) throw new BadRequestException('location_id სავალდებულოა');
    return this.s.shiftTemplate(u, loc);
  }
  @Get('shifts') @Roles(...STOCK_READ) shifts(@CurrentUser() u: AuthUser, @Query('location_id') loc?: string) { if (!uuidOk(loc)) throw new BadRequestException('არასწორი id'); return this.s.shifts(u, loc); }
  @Get('shifts/:id') @Roles(...STOCK_READ) shiftOne(@Param('id', ParseUUIDPipe) id: string) { return this.s.shiftOne(id); }
  @Post('shift') @Roles(...STOCK_READ) shift(@Body() d: ShiftDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.shift(d, u, auditCtx(r)); }
}
