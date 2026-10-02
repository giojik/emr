import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsISO8601, IsNumber, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import type { Request } from 'express';
import { sql, type Transaction } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser, type Role } from '../auth/roles';
import { InjectDb, type Database } from '../database/database.module';
import type { DB } from '../database/db';
import { STOCK_READ } from './stock-catalog';
import { StockTransfersService } from './stock-transfers';

type Trx = Transaction<DB>;
type Ex = Database | Trx;
const q3 = (n: number) => Math.round(n * 1000) / 1000;
const r2 = (n: number) => Math.round(n * 100) / 100;
const dge = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
/** ჩამოწერის / ინვენტარიზაციის დამტკიცება */
export const STOCK_APPROVE: Role[] = ['admin', 'stock_manager'];
export const WRITEOFF_REASONS = ['expired', 'damaged', 'lost', 'department_use', 'recall', 'other'] as const;
const REASON_KA: Record<string, string> = { expired: 'ვადაგასული', damaged: 'დაზიანებული', lost: 'დაკარგული', department_use: 'განყოფილების ხარჯი', recall: 'გაწვევა', other: 'სხვა' };
export interface WoLineIn { lot_id: string; qty_base: number; notes?: string | null }
export interface CnLineIn { item_id: string; qty_base: number; lot_id?: string | null }

/** ჩამოწერა, ხარჯი პაციენტზე (+ ინვოისი კონფიგურაციით), ინვენტარიზაცია (4A — ლოკაციის ბლოკით) */
@Injectable()
export class StockOpsService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService, private readonly t: StockTransfersService) {}

  private mapErr(e: unknown): never {
    const err = e as { constraint?: string; message?: string };
    if (err.constraint === 'stock_location_counting') throw new ConflictException(err.message ?? 'ლოკაციაზე მიმდინარეობს ინვენტარიზაცია');
    if (err.constraint === 'stock_balances_non_negative') throw new ConflictException('ნაშთი არასაკმარისია (ლოტის ნაშთი ამ ლოკაციაზე ნაკლებია)');
    if (err.constraint === 'ux_stock_counts_active') throw new ConflictException('ამ ლოკაციაზე ინვენტარიზაცია უკვე მიმდინარეობს');
    if (err.constraint === 'chk_invoice_overpaid') throw new ConflictException('ინვოისი უკვე გადახდილია — ხაზის მოხსნამდე საჭიროა გადახდის კორექცია (სალარო)');
    throw e;
  }
  private async counting(locationId: string, ex: Ex = this.db) {
    const c = await ex.selectFrom('stock_counts').select('count_no').where('location_id', '=', locationId).where('status', 'in', ['open', 'counted']).executeTakeFirst();
    if (c) throw new ConflictException(`ლოკაციაზე მიმდინარეობს ინვენტარიზაცია ${c.count_no} — მოძრაობა დაბლოკილია`);
  }
  private async settings(ex: Ex = this.db) {
    return ex.selectFrom('stock_settings').select(['costing_method', 'writeoff_approval_threshold']).where('id', '=', 1).executeTakeFirstOrThrow();
  }
  private async lotAt(trx: Trx, lotId: string, locationId: string) {
    const l = await trx.selectFrom('stock_lots as lt').innerJoin('stock_items as i', 'i.id', 'lt.item_id').leftJoin('med_generics as g', 'g.id', 'i.generic_id')
      .leftJoin('stock_balances as b', (j) => j.onRef('b.lot_id', '=', 'lt.id').on('b.location_id', '=', locationId))
      .select(['lt.id', 'lt.item_id', 'lt.lot_no', 'lt.serial_no', 'lt.expires_on', 'lt.produced_on', 'lt.status', 'lt.unit_cost', 'i.name', 'g.controlled_class', 'g.patient_only',
        sql<string>`coalesce(b.qty, 0)`.as('qty')]).where('lt.id', '=', lotId).executeTakeFirst();
    if (!l) throw new BadRequestException('ლოტი ვერ მოიძებნა');
    return l;
  }

  // ================================================================= ჩამოწერა
  async createWriteoff(dto: { location_id: string; writeoff_reason: string; notes?: string | null; lines: WoLineIn[] }, u: AuthUser, ctx: AuditContext) {
    const loc = await this.t.loc(dto.location_id);
    await this.t.requireOperate(u, loc, 'ჩამოწერა');
    if (dto.writeoff_reason !== 'expired' && (!dto.notes || dto.notes.trim().length < 3)) throw new BadRequestException('ჩამოწერის აღწერა სავალდებულოა (ვადაგასულის გარდა)');
    await this.counting(loc.id);
    let id = ''; let pending = false;
    try {
      await this.db.transaction().execute(async (trx) => {
        const st = await this.settings(trx);
        const today = await this.t.today(trx);
        const d = await trx.insertInto('stock_docs').values({ doc_type: 'writeoff', doc_date: today, location_id: loc.id, writeoff_reason: dto.writeoff_reason, notes: dto.notes?.trim() || null, created_by: u.id })
          .returning('id').executeTakeFirstOrThrow();
        id = d.id;
        let value = 0; let controlled = false; let n = 0;
        for (const p of dto.lines) {
          const l = await this.lotAt(trx, p.lot_id, loc.id);
          const q = q3(p.qty_base);
          const tag = `„${l.name}“${l.lot_no ? ` (ლოტი ${l.lot_no})` : ''}`;
          if (q > Number(l.qty)) throw new BadRequestException(`${tag}: ჩამოსაწერი (${q}) ნაშთზე (${Number(l.qty)}) მეტია`);
          if (l.serial_no && q !== 1) throw new BadRequestException(`${tag}: სერიული — 1 ერთეული`);
          if (dto.writeoff_reason === 'expired' && (!l.expires_on || l.expires_on >= today)) throw new BadRequestException(`${tag}: ვადა არ გასვლია — აირჩიეთ სხვა მიზეზი`);
          if (l.controlled_class) { controlled = true; if (dto.writeoff_reason === 'department_use') throw new BadRequestException(`${tag}: კონტროლირებადი საქონელი — მხოლოდ პაციენტზე ხარჯით`); }
          value += q * Number(l.unit_cost);
          n++;
          await trx.insertInto('stock_doc_lines').values({ doc_id: id, line_no: n, item_id: l.item_id, qty: String(q), qty_base: String(q), lot_no: l.lot_no, serial_no: l.serial_no,
            expires_on: l.expires_on, produced_on: l.produced_on, unit_cost: l.unit_cost, lot_id: l.id, notes: p.notes?.trim() || null, line_net: String(r2(q * Number(l.unit_cost))) }).execute();
        }
        pending = controlled || dto.writeoff_reason === 'lost' || value > Number(st.writeoff_approval_threshold);
        await trx.updateTable('stock_docs').set({ total_net: String(r2(value)), ...(pending && { approval_status: 'pending' }) }).where('id', '=', id).execute();
        if (!pending) await this.postWriteoff(trx, id, u);
        await this.audit.log(ctx, { action: 'CREATE_STOCK_WRITEOFF', entityName: 'stock_docs', entityId: id, newData: { ...dto, value: r2(value), pending } }, trx);
      });
    } catch (e) { this.mapErr(e); }
    if (pending) {
      const ids = await this.t.usersWith(['stock_manager']);
      await this.t.notifyMany(ids, { kind: 'stock_writeoff', title: `ჩამოწერა — დასამტკიცებელი (${loc.name})`, body: REASON_KA[dto.writeoff_reason], link: '/stock/writeoffs', entityId: id }, u.id);
    }
    return this.doc(id);
  }

  private async postWriteoff(trx: Trx, id: string, u: AuthUser) {
    const d = await trx.selectFrom('stock_docs').select(['location_id', 'doc_date']).where('id', '=', id).executeTakeFirstOrThrow();
    const lines = await trx.selectFrom('stock_doc_lines').selectAll().where('doc_id', '=', id).execute();
    for (const l of lines) {
      await trx.insertInto('stock_moves').values({ doc_id: id, line_id: l.id, move_type: 'writeoff', location_id: d.location_id!, lot_id: l.lot_id!, item_id: l.item_id,
        qty: String(-Number(l.qty_base)), cost_lot: l.unit_cost ?? '0', created_by: u.id }).execute();
    }
    const no = await this.t.nextNo(trx, 'WO', await this.t.today(trx));
    await trx.updateTable('stock_docs').set({ status: 'posted', doc_no: no, posted_by: u.id, posted_at: sql`now()` }).where('id', '=', id).execute();
    return no;
  }

  async decideWriteoff(id: string, approve: boolean, reason: string | undefined, u: AuthUser, ctx: AuditContext) {
    let creator = ''; let no = '';
    try {
      await this.db.transaction().execute(async (trx) => {
        const d = await trx.selectFrom('stock_docs').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
        if (!d || d.doc_type !== 'writeoff') throw new NotFoundException('ჩამოწერა ვერ მოიძებნა');
        if (d.status !== 'draft' || d.approval_status !== 'pending') throw new ConflictException('დამტკიცებას არ ელოდება');
        if (d.created_by === u.id && !has(u, 'admin')) throw new ForbiddenException('საკუთარ ჩამოწერას ვერ დაამტკიცებთ');
        creator = d.created_by;
        if (approve) {
          await trx.updateTable('stock_docs').set({ approval_status: 'approved', approved_by: u.id, approved_at: sql`now()` }).where('id', '=', id).execute();
          no = await this.postWriteoff(trx, id, u);
        } else {
          if (!reason || reason.trim().length < 3) throw new BadRequestException('უარის მიზეზი სავალდებულოა');
          await trx.updateTable('stock_docs').set({ approval_status: 'rejected', approved_by: u.id, approved_at: sql`now()`, status: 'cancelled', reason: reason.trim() }).where('id', '=', id).execute();
        }
        await this.audit.log(ctx, { action: approve ? 'APPROVE_STOCK_WRITEOFF' : 'REJECT_STOCK_WRITEOFF', entityName: 'stock_docs', entityId: id, newData: { reason, doc_no: no } }, trx);
      });
    } catch (e) { this.mapErr(e); }
    await this.t.notifyMany([creator], { kind: 'stock_writeoff', title: approve ? `ჩამოწერა დამტკიცდა: ${no}` : 'ჩამოწერა უარყოფილია', body: reason, link: '/stock/writeoffs', entityId: id }, u.id);
    return this.doc(id);
  }

  // ================================================================= ხარჯი პაციენტზე
  async createConsumption(dto: { location_id: string; patient_id: string; encounter_id?: string | null; notes?: string | null; lines: CnLineIn[] }, u: AuthUser, ctx: AuditContext) {
    const loc = await this.t.loc(dto.location_id);
    await this.t.requireOperate(u, loc, 'ხარჯი');
    await this.counting(loc.id);
    const pat = await this.db.selectFrom('patients').select(['id']).where('id', '=', dto.patient_id).executeTakeFirst();
    if (!pat) throw new BadRequestException('პაციენტი ვერ მოიძებნა');
    let enc: { id: string; status: string } | undefined;
    if (dto.encounter_id) {
      enc = await this.db.selectFrom('encounters').select(['id', 'status']).where('id', '=', dto.encounter_id).where('patient_id', '=', dto.patient_id).executeTakeFirst();
      if (!enc) throw new BadRequestException('ვიზიტი ამ პაციენტს არ ეკუთვნის');
      if (enc.status === 'cancelled') throw new BadRequestException('ვიზიტი გაუქმებულია');
    }
    let id = ''; const warnings: string[] = [];
    try {
      await this.db.transaction().execute(async (trx) => {
        const st = await this.settings(trx);
        const today = await this.t.today(trx);
        const inv = enc ? await trx.selectFrom('invoices').select('id').where('encounter_id', '=', enc.id).forUpdate().executeTakeFirst() : undefined;
        const d = await trx.insertInto('stock_docs').values({ doc_type: 'consumption', doc_date: today, location_id: loc.id, patient_id: dto.patient_id, encounter_id: enc?.id ?? null,
          notes: dto.notes?.trim() || null, created_by: u.id }).returning('id').executeTakeFirstOrThrow();
        id = d.id;
        let n = 0; let cost = 0; let billed = 0;
        for (const p of dto.lines) {
          const it = await trx.selectFrom('stock_items as i').innerJoin('stock_categories as c', 'c.id', 'i.category_id').innerJoin('stock_units as un', 'un.code', 'i.base_unit')
            .leftJoin('stock_item_costs as ic', 'ic.item_id', 'i.id')
            .select(['i.id', 'i.name', 'i.sale_price', 'i.serial_tracked', 'un.name as unit_name', 'ic.avg_cost', sql<string>`coalesce(i.billing_mode, c.billing_mode)`.as('billing_mode'), 'c.markup_pct'])
            .where('i.id', '=', p.item_id).executeTakeFirst();
          if (!it) throw new BadRequestException('საქონელი ვერ მოიძებნა');
          let need = q3(p.qty_base);
          if (!(need > 0)) throw new BadRequestException(`„${it.name}“: რაოდენობა > 0`);
          if (it.serial_tracked && (!p.lot_id || need !== 1)) throw new BadRequestException(`„${it.name}“: სერიული საქონელი — მიუთითეთ კონკრეტული სერიული (სკანირებით), 1 ერთეული`);
          // ლოტი: მითითებული (მაგ. სკანირებით) ან FEFO-თი
          const alloc: { lot_id: string; qty: number }[] = [];
          if (p.lot_id) {
            const l = await this.lotAt(trx, p.lot_id, loc.id);
            if (l.item_id !== it.id) throw new BadRequestException('ლოტი სხვა საქონელს ეკუთვნის');
            if (l.status !== 'active') throw new BadRequestException(`„${it.name}“ (ლოტი ${l.lot_no}) დაბლოკილია`);
            if (l.expires_on && l.expires_on < today) throw new BadRequestException(`„${it.name}“ (ლოტი ${l.lot_no}) ვადაგასულია (${dge(l.expires_on)})`);
            alloc.push({ lot_id: l.id, qty: need });
          } else {
            for (const l of await this.t.availableLots(it.id, loc.id, trx)) {
              if (need <= 0) break;
              const q = Math.min(need, Number(l.qty)); alloc.push({ lot_id: l.lot_id, qty: q3(q) }); need = q3(need - q);
            }
            if (need > 0) throw new ConflictException(`„${it.name}“: ნაშთი არასაკმარისია (აკლია ${need} ${it.unit_name})`);
          }
          for (const a of alloc) {
            const l = await this.lotAt(trx, a.lot_id, loc.id);
            const unit = st.costing_method === 'fifo' ? Number(l.unit_cost) : Number(it.avg_cost ?? l.unit_cost);
            const price = it.billing_mode === 'invoice' ? (it.sale_price !== null ? Number(it.sale_price) : r2(unit * (1 + Number(it.markup_pct ?? 0) / 100))) : null;
            n++;
            const line = await trx.insertInto('stock_doc_lines').values({ doc_id: id, line_no: n, item_id: it.id, qty: String(a.qty), qty_base: String(a.qty), lot_no: l.lot_no, serial_no: l.serial_no,
              expires_on: l.expires_on, produced_on: l.produced_on, unit_cost: l.unit_cost, lot_id: l.id, patient_id: dto.patient_id, line_net: String(r2(a.qty * unit)),
              sale_price: price === null ? null : String(price) }).returning('id').executeTakeFirstOrThrow();
            await trx.insertInto('stock_moves').values({ doc_id: id, line_id: line.id, move_type: 'consumption', location_id: loc.id, lot_id: l.id, item_id: it.id, qty: String(-a.qty),
              cost_lot: l.unit_cost, patient_id: dto.patient_id, encounter_id: enc?.id ?? null, created_by: u.id }).execute();
            cost += a.qty * unit;
            if (price !== null) {
              if (!inv) { warnings.push(`„${it.name}“: ${enc ? 'ვიზიტს ინვოისი არ აქვს' : 'ვიზიტი მითითებული არ არის'} — ინვოისში არ დაემატა`); continue; }
              const whole = Number.isInteger(a.qty);
              await trx.insertInto('invoice_line_items').values({ invoice_id: inv.id, stock_doc_line_id: line.id,
                description: `${it.name}${l.lot_no ? ` (ლოტი ${l.lot_no})` : ''}${whole ? '' : ` — ${a.qty} ${it.unit_name}`}`,
                quantity: whole ? a.qty : 1, unit_price: String(whole ? price : r2(price * a.qty)) }).execute();
              billed += r2(price * a.qty);
            }
          }
        }
        const no = await this.t.nextNo(trx, 'CN', today);
        await trx.updateTable('stock_docs').set({ status: 'posted', doc_no: no, posted_by: u.id, posted_at: sql`now()`, total_net: String(r2(cost)), total_vat: '0' }).where('id', '=', id).execute();
        await this.audit.log(ctx, { action: 'STOCK_CONSUMPTION', entityName: 'stock_docs', entityId: id, newData: { ...dto, doc_no: no, cost: r2(cost), billed: r2(billed) } }, trx);
      });
    } catch (e) { this.mapErr(e); }
    return { ...(await this.doc(id)), warnings };
  }

  // ================================================================= სიები
  async doc(id: string) {
    const d = await this.db.selectFrom('stock_docs as d').leftJoin('stock_locations as l', 'l.id', 'd.location_id').innerJoin('users as u', 'u.id', 'd.created_by')
      .leftJoin('users as au', 'au.id', 'd.approved_by').leftJoin('patients as p', 'p.id', 'd.patient_id').leftJoin('stock_docs as rb', 'rb.id', 'd.reversed_by')
      .select(['d.id', 'd.doc_type', 'd.doc_no', 'd.status', 'd.doc_date', 'd.location_id', 'd.writeoff_reason', 'd.approval_status', 'd.approved_at', 'd.notes', 'd.reason', 'd.total_net',
        'd.patient_id', 'd.encounter_id', 'd.posted_at', 'd.created_at', 'd.created_by', 'd.reversed_by', 'rb.doc_no as reversed_by_no', 'l.name as location_name',
        sql<string>`u.first_name || ' ' || u.last_name`.as('created_by_name'), sql<string | null>`au.first_name || ' ' || au.last_name`.as('approved_by_name'),
        sql<string | null>`p.first_name || ' ' || p.last_name`.as('patient_name'), 'p.personal_number as patient_pn'])
      .where('d.id', '=', id).executeTakeFirst();
    if (!d) throw new NotFoundException('დოკუმენტი ვერ მოიძებნა');
    const lines = await this.db.selectFrom('stock_doc_lines as x').innerJoin('stock_items as i', 'i.id', 'x.item_id').innerJoin('stock_units as un', 'un.code', 'i.base_unit')
      .leftJoin('invoice_line_items as il', 'il.stock_doc_line_id', 'x.id')
      .select(['x.id', 'x.line_no', 'x.item_id', 'x.qty_base', 'x.lot_no', 'x.serial_no', 'x.expires_on', 'x.unit_cost', 'x.line_net', 'x.sale_price', 'x.notes', 'i.name as item_name', 'i.code as item_code',
        'un.name as base_unit_name', sql<boolean>`il.id IS NOT NULL`.as('invoiced')])
      .where('x.doc_id', '=', id).orderBy('x.line_no').execute();
    return { ...d, lines };
  }

  async list(u: AuthUser, q: { type: 'writeoff' | 'consumption'; location_id?: string; patient_id?: string; encounter_id?: string; pending?: boolean; from?: string; to?: string }) {
    let x = this.db.selectFrom('stock_docs as d').leftJoin('stock_locations as l', 'l.id', 'd.location_id').innerJoin('users as u', 'u.id', 'd.created_by')
      .leftJoin('patients as p', 'p.id', 'd.patient_id').leftJoin('stock_docs as rb', 'rb.id', 'd.reversed_by')
      .select(['d.id', 'd.doc_no', 'd.status', 'd.doc_date', 'd.writeoff_reason', 'd.approval_status', 'd.total_net', 'd.notes', 'd.created_at', 'd.reversed_by', 'rb.doc_no as reversed_by_no',
        'l.name as location_name', 'l.department_id', sql<string>`u.first_name || ' ' || u.last_name`.as('created_by_name'), sql<string | null>`p.first_name || ' ' || p.last_name`.as('patient_name'),
        sql<number>`(SELECT count(*)::int FROM stock_doc_lines x WHERE x.doc_id = d.id)`.as('lines')])
      .where('d.doc_type', '=', q.type).where('d.status', '<>', 'cancelled').orderBy('d.created_at', 'desc').limit(500);
    if (q.location_id) x = x.where('d.location_id', '=', q.location_id);
    if (q.patient_id) x = x.where('d.patient_id', '=', q.patient_id);
    if (q.encounter_id) x = x.where('d.encounter_id', '=', q.encounter_id);
    if (q.pending) x = x.where('d.approval_status', '=', 'pending').where('d.status', '=', 'draft');
    if (q.from) x = x.where('d.doc_date', '>=', q.from);
    if (q.to) x = x.where('d.doc_date', '<=', q.to);
    const rows = await x.execute();
    if (has(u, 'admin', 'stock_manager', 'storekeeper', 'pharmacist', 'manager', 'viewer', 'accountant')) return rows;
    const me = await this.t.me(u);
    return rows.filter((r) => r.department_id && r.department_id === me.department_id);
  }

  // ================================================================= ინვენტარიზაცია
  async startCount(dto: { location_id: string; category_id?: string | null; blind?: boolean; notes?: string | null }, u: AuthUser, ctx: AuditContext) {
    const loc = await this.t.loc(dto.location_id);
    await this.t.requireOperate(u, loc, 'ინვენტარიზაცია');
    let id = '';
    try {
      await this.db.transaction().execute(async (trx) => {
        const transit = await trx.selectFrom('stock_docs').select('doc_no').where('status', '=', 'posted').where('receive_status', 'is', null)
          .where('doc_type', 'in', ['transfer', 'return']).where((eb) => eb.or([eb('to_location_id', '=', loc.id), eb('from_location_id', '=', loc.id)])).execute();
        if (transit.length) throw new ConflictException(`ჯერ დაასრულეთ გზაში მყოფი: ${transit.map((x) => x.doc_no).join(', ')}`);
        const no = await this.t.nextNo(trx, 'IC', await this.t.today(trx));
        const c = await trx.insertInto('stock_counts').values({ count_no: no, location_id: loc.id, category_id: dto.category_id ?? null, blind: dto.blind ?? true, notes: dto.notes?.trim() || null, started_by: u.id })
          .returning('id').executeTakeFirstOrThrow();
        id = c.id;
        let snap = trx.selectFrom('stock_balances as b').innerJoin('stock_lots as lt', 'lt.id', 'b.lot_id').innerJoin('stock_items as i', 'i.id', 'b.item_id')
          .select(['b.item_id', 'b.lot_id', 'lt.lot_no', 'lt.serial_no', 'lt.expires_on', 'b.qty']).where('b.location_id', '=', loc.id).where('b.qty', '>', '0');
        if (dto.category_id) snap = snap.where('i.category_id', '=', dto.category_id);
        const rows = await snap.execute();
        if (rows.length) await trx.insertInto('stock_count_lines').values(rows.map((r) => ({ count_id: id, item_id: r.item_id, lot_id: r.lot_id, lot_no: r.lot_no, serial_no: r.serial_no, expires_on: r.expires_on, expected_qty: r.qty }))).execute();
        await this.audit.log(ctx, { action: 'START_STOCK_COUNT', entityName: 'stock_counts', entityId: id, newData: { ...dto, count_no: no, lines: rows.length } }, trx);
      });
    } catch (e) { this.mapErr(e); }
    return this.count(id, u);
  }

  async counts(q: { location_id?: string; status?: string }) {
    let x = this.db.selectFrom('stock_counts as c').innerJoin('stock_locations as l', 'l.id', 'c.location_id').innerJoin('users as u', 'u.id', 'c.started_by').leftJoin('stock_categories as cat', 'cat.id', 'c.category_id')
      .leftJoin('stock_docs as ad', 'ad.id', 'c.adjustment_doc_id')
      .select(['c.id', 'c.count_no', 'c.status', 'c.blind', 'c.started_at', 'c.submitted_at', 'c.approved_at', 'l.name as location_name', 'cat.name as category_name', 'ad.doc_no as adjustment_no',
        sql<string>`u.first_name || ' ' || u.last_name`.as('started_by_name'),
        sql<number>`(SELECT count(*)::int FROM stock_count_lines x WHERE x.count_id = c.id)`.as('lines'),
        sql<number>`(SELECT count(*)::int FROM stock_count_lines x WHERE x.count_id = c.id AND x.counted_qty IS NOT NULL)`.as('counted')])
      .orderBy('c.started_at', 'desc').limit(300);
    if (q.location_id) x = x.where('c.location_id', '=', q.location_id);
    if (q.status) x = x.where('c.status', 'in', q.status.split(','));
    return x.execute();
  }

  async count(id: string, u: AuthUser) {
    const c = await this.db.selectFrom('stock_counts as c').innerJoin('stock_locations as l', 'l.id', 'c.location_id').innerJoin('users as su', 'su.id', 'c.started_by')
      .leftJoin('users as au', 'au.id', 'c.approved_by').leftJoin('stock_docs as ad', 'ad.id', 'c.adjustment_doc_id').leftJoin('stock_categories as cat', 'cat.id', 'c.category_id')
      .selectAll('c').select(['l.name as location_name', 'cat.name as category_name', 'ad.doc_no as adjustment_no', sql<string>`su.first_name || ' ' || su.last_name`.as('started_by_name'),
        sql<string | null>`au.first_name || ' ' || au.last_name`.as('approved_by_name')])
      .where('c.id', '=', id).executeTakeFirst();
    if (!c) throw new NotFoundException('ინვენტარიზაცია ვერ მოიძებნა');
    const st = await this.settings();
    const lines = await this.db.selectFrom('stock_count_lines as x').innerJoin('stock_items as i', 'i.id', 'x.item_id').innerJoin('stock_units as un', 'un.code', 'i.base_unit')
      .leftJoin('stock_lots as lt', 'lt.id', 'x.lot_id').leftJoin('stock_item_costs as ic', 'ic.item_id', 'x.item_id').leftJoin('users as cu', 'cu.id', 'x.counted_by')
      .select(['x.id', 'x.item_id', 'x.lot_id', 'x.lot_no', 'x.serial_no', 'x.expires_on', 'x.expected_qty', 'x.counted_qty', 'x.counted_at', 'x.is_extra', 'x.note', 'i.name as item_name', 'i.code as item_code',
        'un.name as base_unit_name', 'lt.unit_cost', 'ic.avg_cost', sql<string | null>`cu.first_name || ' ' || cu.last_name`.as('counted_by_name')])
      .where('x.count_id', '=', id).orderBy('i.name').orderBy(sql`x.expires_on NULLS LAST`).execute();
    // ბრმა დათვლა: სანამ დათვლა არ დასრულებულა, სისტემური ნაშთი არავის ჩანს
    const hide = c.blind && c.status === 'open';
    const out = lines.map((l) => {
      const unit = Number(st.costing_method === 'fifo' ? l.unit_cost ?? l.avg_cost ?? 0 : l.avg_cost ?? l.unit_cost ?? 0);
      const diff = l.counted_qty === null ? null : q3(Number(l.counted_qty) - Number(l.expected_qty));
      return { ...l, expected_qty: hide ? null : l.expected_qty, diff: hide ? null : diff, diff_value: hide || diff === null ? null : r2(diff * unit), unit_cost: undefined, avg_cost: undefined };
    });
    const sum = (f: (x: typeof out[number]) => boolean) => r2(out.filter(f).reduce((a, x) => a + (x.diff_value ?? 0), 0));
    return { ...c, can_approve: has(u, ...STOCK_APPROVE), lines: out,
      totals: hide ? null : { shortage: sum((x) => (x.diff ?? 0) < 0), surplus: sum((x) => (x.diff ?? 0) > 0), lines_diff: out.filter((x) => (x.diff ?? 0) !== 0).length } };
  }

  private async lockCount(trx: Trx, id: string, u: AuthUser, status: string[], what: string) {
    const c = await trx.selectFrom('stock_counts').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!c) throw new NotFoundException('ინვენტარიზაცია ვერ მოიძებნა');
    if (!status.includes(c.status)) throw new ConflictException(`${what}: ინვენტარიზაცია ${c.status === 'approved' ? 'დამტკიცებულია' : c.status === 'cancelled' ? 'გაუქმებულია' : c.status === 'counted' ? 'დათვლილია — ელოდება დამტკიცებას' : 'ღიაა'}`);
    return c;
  }

  async setCounted(id: string, lines: { id: string; counted_qty: number | null; note?: string | null }[], u: AuthUser, ctx: AuditContext) {
    await this.db.transaction().execute(async (trx) => {
      const c = await this.lockCount(trx, id, u, ['open'], 'დათვლა');
      await this.t.requireOperate(u, await this.t.loc(c.location_id, trx), 'დათვლა', trx);
      for (const l of lines) {
        const r = await trx.updateTable('stock_count_lines').set({ counted_qty: l.counted_qty === null ? null : String(q3(l.counted_qty)), note: l.note?.trim() || null,
          counted_by: l.counted_qty === null ? null : u.id, counted_at: l.counted_qty === null ? null : sql`now()` }).where('id', '=', l.id).where('count_id', '=', id).executeTakeFirst();
        if (!Number(r.numUpdatedRows)) throw new BadRequestException('ხაზი ამ ინვენტარიზაციას არ ეკუთვნის');
      }
      await this.audit.log(ctx, { action: 'COUNT_STOCK_LINES', entityName: 'stock_counts', entityId: id, newData: { lines: lines.length } }, trx);
    });
    return this.count(id, u);
  }

  async addExtra(id: string, dto: { item_id: string; lot_id?: string | null; lot_no?: string | null; serial_no?: string | null; expires_on?: string | null; counted_qty: number; note?: string | null }, u: AuthUser, ctx: AuditContext) {
    await this.db.transaction().execute(async (trx) => {
      const c = await this.lockCount(trx, id, u, ['open'], 'დამატება');
      await this.t.requireOperate(u, await this.t.loc(c.location_id, trx), 'დათვლა', trx);
      const it = await trx.selectFrom('stock_items').select(['id', 'name', 'requires_lot', 'requires_expiry', 'serial_tracked']).where('id', '=', dto.item_id).executeTakeFirst();
      if (!it) throw new BadRequestException('საქონელი ვერ მოიძებნა');
      const lotNo = it.requires_lot ? (dto.lot_no?.trim().toUpperCase() || null) : null; const serial = it.serial_tracked ? (dto.serial_no?.trim().toUpperCase() || null) : null;
      let lot = dto.lot_id ? await trx.selectFrom('stock_lots').select(['id', 'item_id', 'lot_no', 'serial_no', 'expires_on']).where('id', '=', dto.lot_id).executeTakeFirst()
        : await trx.selectFrom('stock_lots').select(['id', 'item_id', 'lot_no', 'serial_no', 'expires_on']).where('item_id', '=', it.id)
          .where(sql`coalesce(lot_no, '')`, '=', lotNo ?? '').where(sql`coalesce(serial_no, '')`, '=', serial ?? '').executeTakeFirst();
      if (lot && lot.item_id !== it.id) throw new BadRequestException('ლოტი სხვა საქონელს ეკუთვნის');
      if (!lot && it.requires_lot && !lotNo) throw new BadRequestException('ლოტი სავალდებულოა');
      if (!lot && it.requires_expiry && !dto.expires_on) throw new BadRequestException('ახალ ლოტს ვადა სჭირდება');
      if (lot) {
        const dup = await trx.selectFrom('stock_count_lines').select('id').where('count_id', '=', id).where('lot_id', '=', lot.id).executeTakeFirst();
        if (dup) throw new ConflictException('ეს ლოტი სიაშია — შეიყვანეთ რაოდენობა არსებულ ხაზზე');
      }
      await trx.insertInto('stock_count_lines').values({ count_id: id, item_id: it.id, lot_id: lot?.id ?? null, lot_no: lot?.lot_no ?? lotNo, serial_no: lot?.serial_no ?? serial,
        expires_on: lot?.expires_on ?? (dto.expires_on || null), expected_qty: '0', counted_qty: String(q3(dto.counted_qty)), counted_by: u.id, counted_at: sql`now()`, is_extra: true, note: dto.note?.trim() || null }).execute();
      await this.audit.log(ctx, { action: 'COUNT_STOCK_EXTRA', entityName: 'stock_counts', entityId: id, newData: dto }, trx);
    });
    return this.count(id, u);
  }

  async removeExtra(id: string, lineId: string, u: AuthUser) {
    await this.db.transaction().execute(async (trx) => {
      const c = await this.lockCount(trx, id, u, ['open'], 'წაშლა');
      await this.t.requireOperate(u, await this.t.loc(c.location_id, trx), 'დათვლა', trx);
      const r = await trx.deleteFrom('stock_count_lines').where('id', '=', lineId).where('count_id', '=', id).where('is_extra', '=', true).executeTakeFirst();
      if (!Number(r.numDeletedRows)) throw new BadRequestException('იშლება მხოლოდ დამატებული (ნაპოვნი) ხაზი');
    });
    return this.count(id, u);
  }

  async submitCount(id: string, u: AuthUser, ctx: AuditContext) {
    await this.db.transaction().execute(async (trx) => {
      const c = await this.lockCount(trx, id, u, ['open'], 'დასრულება');
      await this.t.requireOperate(u, await this.t.loc(c.location_id, trx), 'დათვლა', trx);
      const left = await trx.selectFrom('stock_count_lines').select(sql<number>`count(*)::int`.as('n')).where('count_id', '=', id).where('counted_qty', 'is', null).executeTakeFirstOrThrow();
      if (left.n > 0) throw new BadRequestException(`დასათვლელია კიდევ ${left.n} ხაზი (არ არის — მიუთითეთ 0)`);
      await trx.updateTable('stock_counts').set({ status: 'counted', submitted_by: u.id, submitted_at: sql`now()` }).where('id', '=', id).execute();
      await this.audit.log(ctx, { action: 'SUBMIT_STOCK_COUNT', entityName: 'stock_counts', entityId: id }, trx);
    });
    const ids = await this.t.usersWith(['stock_manager']);
    await this.t.notifyMany(ids, { kind: 'stock_count', title: 'ინვენტარიზაცია დათვლილია — დასამტკიცებელი', link: `/stock/counts?count=${id}`, entityId: id }, u.id);
    return this.count(id, u);
  }

  async recount(id: string, reason: string, u: AuthUser, ctx: AuditContext) {
    await this.db.transaction().execute(async (trx) => {
      await this.lockCount(trx, id, u, ['counted'], 'ხელახალი დათვლა');
      await trx.updateTable('stock_counts').set({ status: 'open', reason: reason.trim(), submitted_at: null, submitted_by: null }).where('id', '=', id).execute();
      await this.audit.log(ctx, { action: 'RECOUNT_STOCK_COUNT', entityName: 'stock_counts', entityId: id, newData: { reason } }, trx);
    });
    return this.count(id, u);
  }

  async cancelCount(id: string, reason: string, u: AuthUser, ctx: AuditContext) {
    await this.db.transaction().execute(async (trx) => {
      await this.lockCount(trx, id, u, ['open', 'counted'], 'გაუქმება');
      await trx.updateTable('stock_counts').set({ status: 'cancelled', reason: reason.trim() }).where('id', '=', id).execute();
      await this.audit.log(ctx, { action: 'CANCEL_STOCK_COUNT', entityName: 'stock_counts', entityId: id, newData: { reason } }, trx);
    });
    return this.count(id, u);
  }

  /** დამტკიცება: სხვაობა (დათვლილი − მიმდინარე ნაშთი; ბლოკის გამო = ნაშთი დაწყებისას) → კორექტირების დოკუმენტი AD; ლოკაცია იხსნება */
  async approveCount(id: string, u: AuthUser, ctx: AuditContext) {
    try {
      await this.db.transaction().execute(async (trx) => {
        const c = await this.lockCount(trx, id, u, ['counted'], 'დამტკიცება');
        const lines = await trx.selectFrom('stock_count_lines').selectAll().where('count_id', '=', id).execute();
        const today = await this.t.today(trx);
        let docId: string | null = null; let n = 0;
        for (const l of lines) {
          let lotId = l.lot_id;
          const cur = lotId ? Number((await trx.selectFrom('stock_balances').select('qty').where('location_id', '=', c.location_id).where('lot_id', '=', lotId).executeTakeFirst())?.qty ?? 0) : 0;
          const diff = q3(Number(l.counted_qty ?? 0) - cur);
          if (diff === 0) continue;
          if (!lotId) {
            const avg = await trx.selectFrom('stock_item_costs').select('avg_cost').where('item_id', '=', l.item_id).executeTakeFirst();
            const ex = await trx.selectFrom('stock_lots').select('id').where('item_id', '=', l.item_id)
              .where(sql`coalesce(lot_no, '')`, '=', l.lot_no ?? '').where(sql`coalesce(serial_no, '')`, '=', l.serial_no ?? '').executeTakeFirst();
            lotId = ex?.id ?? (await trx.insertInto('stock_lots').values({ item_id: l.item_id, lot_no: l.lot_no, serial_no: l.serial_no, expires_on: l.expires_on, unit_cost: avg?.avg_cost ?? '0' })
              .returning('id').executeTakeFirstOrThrow()).id;
            await trx.updateTable('stock_count_lines').set({ lot_id: lotId }).where('id', '=', l.id).execute();
          }
          const lot = await trx.selectFrom('stock_lots').select(['unit_cost', 'lot_no', 'serial_no', 'expires_on']).where('id', '=', lotId).executeTakeFirstOrThrow();
          if (!docId) {
            docId = (await trx.insertInto('stock_docs').values({ doc_type: 'adjustment', doc_date: today, location_id: c.location_id, count_id: id, notes: `ინვენტარიზაცია ${c.count_no}`, created_by: u.id })
              .returning('id').executeTakeFirstOrThrow()).id;
          }
          n++;
          const line = await trx.insertInto('stock_doc_lines').values({ doc_id: docId, line_no: n, item_id: l.item_id, qty: String(Math.abs(diff)), qty_base: String(Math.abs(diff)), lot_no: lot.lot_no,
            serial_no: lot.serial_no, expires_on: lot.expires_on, unit_cost: lot.unit_cost, lot_id: lotId, notes: diff > 0 ? 'ზედმეტობა' : 'დანაკლისი' }).returning('id').executeTakeFirstOrThrow();
          await trx.insertInto('stock_moves').values({ doc_id: docId, line_id: line.id, move_type: 'adjustment', location_id: c.location_id, lot_id: lotId, item_id: l.item_id, qty: String(diff), cost_lot: lot.unit_cost, created_by: u.id }).execute();
        }
        let no: string | null = null;
        if (docId) {
          no = await this.t.nextNo(trx, 'AD', today);
          await trx.updateTable('stock_docs').set({ status: 'posted', doc_no: no, posted_by: u.id, posted_at: sql`now()` }).where('id', '=', docId).execute();
        }
        await trx.updateTable('stock_counts').set({ status: 'approved', approved_by: u.id, approved_at: sql`now()`, adjustment_doc_id: docId }).where('id', '=', id).execute();
        await this.audit.log(ctx, { action: 'APPROVE_STOCK_COUNT', entityName: 'stock_counts', entityId: id, newData: { adjustment_no: no, lines_adjusted: n } }, trx);
      });
    } catch (e) { this.mapErr(e); }
    return this.count(id, u);
  }
}

// ======================================================================= DTO
class WoLineDto { @IsUUID() lot_id: string; @IsNumber() @Min(0.001) @Max(1_000_000) qty_base: number; @IsOptional() @IsString() @MaxLength(500) notes?: string | null }
class WriteoffDto {
  @IsUUID() location_id: string; @IsIn(WRITEOFF_REASONS as unknown as string[]) writeoff_reason: string; @IsOptional() @IsString() @MaxLength(1000) notes?: string | null;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(300) @ValidateNested({ each: true }) @Type(() => WoLineDto) lines: WoLineDto[];
}
class CnLineDto { @IsUUID() item_id: string; @IsNumber() @Min(0.001) @Max(100_000) qty_base: number; @IsOptional() @IsUUID() lot_id?: string | null }
class ConsumptionDto {
  @IsUUID() location_id: string; @IsUUID() patient_id: string; @IsOptional() @IsUUID() encounter_id?: string | null; @IsOptional() @IsString() @MaxLength(1000) notes?: string | null;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => CnLineDto) lines: CnLineDto[];
}
class DecideDto { @IsBoolean() approve: boolean; @IsOptional() @IsString() @MaxLength(500) reason?: string }
class CountDto { @IsUUID() location_id: string; @IsOptional() @IsUUID() category_id?: string | null; @IsOptional() @IsBoolean() blind?: boolean; @IsOptional() @IsString() @MaxLength(1000) notes?: string | null }
class CountLineDto { @IsUUID() id: string; @IsOptional() @IsNumber() @Min(0) @Max(10_000_000) counted_qty: number | null; @IsOptional() @IsString() @MaxLength(500) note?: string | null }
class CountLinesDto { @IsArray() @ArrayMaxSize(3000) @ValidateNested({ each: true }) @Type(() => CountLineDto) lines: CountLineDto[] }
class ExtraDto {
  @IsUUID() item_id: string; @IsOptional() @IsUUID() lot_id?: string | null; @IsOptional() @IsString() @MaxLength(40) lot_no?: string | null; @IsOptional() @IsString() @MaxLength(60) serial_no?: string | null;
  @IsOptional() @IsISO8601({ strict: true }) expires_on?: string | null; @IsNumber() @Min(0) @Max(10_000_000) counted_qty: number; @IsOptional() @IsString() @MaxLength(500) note?: string | null;
}
class ReasonDto { @IsString() @Length(3, 500) reason: string }
const uuidOk = (v?: string) => !v || /^[0-9a-f-]{36}$/i.test(v);
const dateOk = (v?: string) => !v || /^\d{4}-\d{2}-\d{2}$/.test(v);

@Controller('stock')
export class StockOpsController {
  constructor(private readonly s: StockOpsService) {}
  @Get('writeoffs') @Roles(...STOCK_READ) writeoffs(@CurrentUser() u: AuthUser, @Query() q: { location_id?: string; pending?: string; from?: string; to?: string }) {
    if (!uuidOk(q.location_id) || !dateOk(q.from) || !dateOk(q.to)) throw new BadRequestException('არასწორი ფილტრი');
    return this.s.list(u, { type: 'writeoff', location_id: q.location_id, pending: q.pending === 'true', from: q.from, to: q.to });
  }
  @Post('writeoffs') @Roles(...STOCK_READ) writeoff(@Body() d: WriteoffDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.createWriteoff(d, u, auditCtx(r)); }
  @Post('writeoffs/:id/decide') @HttpCode(200) @Roles(...STOCK_APPROVE) decide(@Param('id', ParseUUIDPipe) id: string, @Body() d: DecideDto, @CurrentUser() u: AuthUser, @Req() r: Request) {
    return this.s.decideWriteoff(id, d.approve, d.reason, u, auditCtx(r));
  }
  @Get('consumptions') @Roles(...STOCK_READ) consumptions(@CurrentUser() u: AuthUser, @Query() q: { location_id?: string; patient_id?: string; encounter_id?: string; from?: string; to?: string }) {
    if (!uuidOk(q.location_id) || !uuidOk(q.patient_id) || !uuidOk(q.encounter_id) || !dateOk(q.from) || !dateOk(q.to)) throw new BadRequestException('არასწორი ფილტრი');
    return this.s.list(u, { type: 'consumption', ...q });
  }
  @Post('consumptions') @Roles(...STOCK_READ) consume(@Body() d: ConsumptionDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.createConsumption(d, u, auditCtx(r)); }
  @Get('ops/:id') @Roles(...STOCK_READ) doc(@Param('id', ParseUUIDPipe) id: string) { return this.s.doc(id); }

  @Get('counts') @Roles(...STOCK_READ) counts(@Query('location_id') location_id?: string, @Query('status') status?: string) {
    if (!uuidOk(location_id)) throw new BadRequestException('არასწორი id');
    if (status && status.split(',').some((x) => !['open', 'counted', 'approved', 'cancelled'].includes(x))) throw new BadRequestException('უცნობი სტატუსი');
    return this.s.counts({ location_id, status });
  }
  @Post('counts') @Roles(...STOCK_READ) start(@Body() d: CountDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.startCount(d, u, auditCtx(r)); }
  @Get('counts/:id') @Roles(...STOCK_READ) one(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser) { return this.s.count(id, u); }
  @Put('counts/:id/lines') @Roles(...STOCK_READ) lines(@Param('id', ParseUUIDPipe) id: string, @Body() d: CountLinesDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.setCounted(id, d.lines, u, auditCtx(r)); }
  @Post('counts/:id/extra') @Roles(...STOCK_READ) extra(@Param('id', ParseUUIDPipe) id: string, @Body() d: ExtraDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.addExtra(id, d, u, auditCtx(r)); }
  @Delete('counts/:id/lines/:lineId') @Roles(...STOCK_READ) del(@Param('id', ParseUUIDPipe) id: string, @Param('lineId', ParseUUIDPipe) lineId: string, @CurrentUser() u: AuthUser) { return this.s.removeExtra(id, lineId, u); }
  @Post('counts/:id/submit') @HttpCode(200) @Roles(...STOCK_READ) submit(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.submitCount(id, u, auditCtx(r)); }
  @Post('counts/:id/recount') @HttpCode(200) @Roles(...STOCK_APPROVE) recount(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.recount(id, d.reason, u, auditCtx(r)); }
  @Post('counts/:id/cancel') @HttpCode(200) @Roles(...STOCK_APPROVE) cancel(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.cancelCount(id, d.reason, u, auditCtx(r)); }
  @Post('counts/:id/approve') @HttpCode(200) @Roles(...STOCK_APPROVE) approve(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.approveCount(id, u, auditCtx(r)); }
}
