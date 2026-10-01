import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsISO8601, IsNumber, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import type { Request } from 'express';
import { sql, type Transaction } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser, type Role } from '../auth/roles';
import { loadEnv } from '../config/env';
import { InjectDb, type Database } from '../database/database.module';
import type { DB } from '../database/db';
import { STOCK_READ } from './stock-catalog';

const TZ = loadEnv().CLINIC_TZ;   // კლინიკის დღის საზღვრები
/** მიღების დოკუმენტი: შექმნა / გატარება */
export const RECEIPT_EDIT: Role[] = ['admin', 'storekeeper', 'stock_manager', 'pharmacist'];
/** გატარებულის შემობრუნება */
export const STOCK_REVERSE: Role[] = ['admin', 'stock_manager'];
const PREFIX: Record<string, string> = { receipt: 'RC', reversal: 'RV', transfer: 'TR', issue: 'IS', return: 'RT', writeoff: 'WO', adjustment: 'AD', consumption: 'CN' };
const r2 = (n: number) => Math.round(n * 100) / 100;
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
const norm = (s?: string | null) => (s && s.trim() ? s.trim().toUpperCase() : null);
const addMonths = (iso: string, m: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + m); return d.toISOString().slice(0, 10); };
const dge = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
type Trx = Transaction<DB>;

export interface LineIn {
  item_id: string; pack_id?: string | null; qty: number; lot_no?: string | null; serial_no?: string | null; expires_on?: string | null; produced_on?: string | null;
  price?: number | null; vat_rate?: number; short_expiry_reason?: string | null; notes?: string | null;
}
export interface ReceiptIn {
  location_id: string; supplier_id?: string | null; doc_date?: string; invoice_no?: string | null; invoice_date?: string | null; waybill_no?: string | null;
  prices_include_vat?: boolean; notes?: string | null; lines: LineIn[];
}
interface Issue { line_no: number; level: 'error' | 'warn'; code: string; message: string }

@Injectable()
export class StockDocsService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService) {}

  private async today(ex: Database | Trx = this.db) {
    const r = await sql<{ d: string }>`SELECT to_char((now() AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS d`.execute(ex);
    return r.rows[0].d;
  }
  private async nextNo(trx: Trx, type: string, date: string) {
    const year = Number(date.slice(0, 4));
    const { last_value } = await trx.insertInto('document_counters').values({ document_type: `stock_${PREFIX[type]}`, year, last_value: 1 })
      .onConflict((oc) => oc.columns(['document_type', 'year']).doUpdateSet({ last_value: sql`document_counters.last_value + 1` }))
      .returning('last_value').executeTakeFirstOrThrow();
    return `${PREFIX[type]}${String(year).slice(2)}-${String(last_value).padStart(6, '0')}`;
  }
  /** ლოკაციაზე უფლება: ფარმაცევტი — მხოლოდ აფთიაქის ტიპის ლოკაცია */
  private async checkLocation(u: AuthUser, locationId: string, ex: Database | Trx = this.db) {
    const l = await ex.selectFrom('stock_locations').select(['id', 'kind', 'is_active', 'name']).where('id', '=', locationId).executeTakeFirst();
    if (!l) throw new BadRequestException('ლოკაცია ვერ მოიძებნა');
    if (l.kind === 'transit') throw new BadRequestException('„გზაში“ სისტემური ლოკაციაა');
    if (!l.is_active) throw new BadRequestException(`ლოკაცია „${l.name}“ გათიშულია`);
    if (!has(u, 'admin', 'storekeeper', 'stock_manager') && l.kind !== 'pharmacy') throw new ForbiddenException('ფარმაცევტი მიღებას აფორმებს მხოლოდ აფთიაქში');
    return l;
  }

  // ---------------------------------------------------------------- სია / ნახვა
  async list(q: { type?: string; status?: string; location_id?: string; supplier_id?: string; from?: string; to?: string; search?: string }) {
    let x = this.db.selectFrom('stock_docs as d').leftJoin('stock_locations as l', 'l.id', 'd.location_id').leftJoin('stock_suppliers as s', 's.id', 'd.supplier_id')
      .innerJoin('users as u', 'u.id', 'd.created_by').leftJoin('stock_docs as rv', 'rv.id', 'd.reversed_by')
      .leftJoin('stock_locations as fl', 'fl.id', 'd.from_location_id').leftJoin('stock_locations as tl', 'tl.id', 'd.to_location_id').leftJoin('stock_requests as rq', 'rq.id', 'd.request_id')
      .select(['d.id', 'd.doc_type', 'd.doc_no', 'd.status', 'd.doc_date', 'd.invoice_no', 'd.waybill_no', 'd.total_net', 'd.total_vat', 'd.posted_at', 'd.reversal_of', 'd.reversed_by', 'd.created_at',
        'd.receive_status', 'd.received_at', 'fl.name as from_name', 'tl.name as to_name', 'rq.req_no', 'd.request_id',
        'l.name as location_name', 's.name as supplier_name', 'rv.doc_no as reversed_by_no', sql<string>`u.first_name || ' ' || u.last_name`.as('created_by_name'),
        sql<number>`(SELECT count(*)::int FROM stock_doc_lines x WHERE x.doc_id = d.id)`.as('lines')])
      .orderBy('d.doc_date', 'desc').orderBy('d.created_at', 'desc').limit(500);
    x = q.type ? x.where('d.doc_type', 'in', q.type.split(',')) : x.where('d.doc_type', 'in', ['receipt', 'reversal']);
    if (q.status) x = x.where('d.status', '=', q.status);
    if (q.location_id) x = x.where((eb) => eb.or([eb('d.location_id', '=', q.location_id!), eb('d.from_location_id', '=', q.location_id!), eb('d.to_location_id', '=', q.location_id!)]));
    if (q.supplier_id) x = x.where('d.supplier_id', '=', q.supplier_id);
    if (q.from) x = x.where('d.doc_date', '>=', q.from);
    if (q.to) x = x.where('d.doc_date', '<=', q.to);
    const s = q.search?.trim();
    if (s) x = x.where((eb) => eb.or([eb(sql`upper(coalesce(d.doc_no, ''))`, 'like', `%${s.toUpperCase()}%`), eb(sql`upper(coalesce(d.invoice_no, ''))`, 'like', `%${s.toUpperCase()}%`),
      eb(sql`upper(coalesce(d.waybill_no, ''))`, 'like', `%${s.toUpperCase()}%`), eb(sql`lower(coalesce(s.name, ''))`, 'like', `%${s.toLowerCase()}%`)]));
    return x.execute();
  }

  async get(id: string, ex: Database | Trx = this.db) {
    const d = await ex.selectFrom('stock_docs as d').leftJoin('stock_locations as l', 'l.id', 'd.location_id').leftJoin('stock_suppliers as s', 's.id', 'd.supplier_id')
      .innerJoin('users as u', 'u.id', 'd.created_by').leftJoin('users as pu', 'pu.id', 'd.posted_by')
      .leftJoin('stock_docs as ro', 'ro.id', 'd.reversal_of').leftJoin('stock_docs as rb', 'rb.id', 'd.reversed_by')
      .leftJoin('stock_locations as fl', 'fl.id', 'd.from_location_id').leftJoin('stock_locations as tl', 'tl.id', 'd.to_location_id')
      .leftJoin('stock_requests as rq', 'rq.id', 'd.request_id').leftJoin('users as rcu', 'rcu.id', 'd.received_by')
      .selectAll('d').select(['fl.name as from_name', 'tl.name as to_name', 'rq.req_no', sql<string | null>`rcu.first_name || ' ' || rcu.last_name`.as('received_by_name')]).select(['l.name as location_name', 'l.kind as location_kind', 's.name as supplier_name', 's.tax_id as supplier_tax_id', 's.vat_payer as supplier_vat_payer',
        sql<string>`u.first_name || ' ' || u.last_name`.as('created_by_name'), sql<string | null>`pu.first_name || ' ' || pu.last_name`.as('posted_by_name'),
        'ro.doc_no as reversal_of_no', 'rb.doc_no as reversed_by_no'])
      .where('d.id', '=', id).executeTakeFirst();
    if (!d) throw new NotFoundException('დოკუმენტი ვერ მოიძებნა');
    const lines = await ex.selectFrom('stock_doc_lines as x').innerJoin('stock_items as i', 'i.id', 'x.item_id').innerJoin('stock_units as un', 'un.code', 'i.base_unit')
      .leftJoin('stock_item_packs as p', 'p.id', 'x.pack_id').leftJoin('med_generics as g', 'g.id', 'i.generic_id')
      .leftJoin('patients as pt', 'pt.id', 'x.patient_id')
      .selectAll('x').select([sql<string | null>`pt.first_name || ' ' || pt.last_name`.as('patient_name'), 'i.name as item_name', 'i.code as item_code', 'i.requires_lot', 'i.requires_expiry', 'i.serial_tracked', 'un.name as base_unit_name', 'p.name as pack_name', 'g.controlled_class'])
      .where('x.doc_id', '=', id).orderBy('x.line_no').execute();
    return { ...d, lines };
  }

  // ---------------------------------------------------------------- მიღება: მონახაზი
  /** ხაზების გადათვლა (ფასი → საბაზო ერთეულის თვითღირებულება, ჯამები) */
  private async buildLines(trx: Trx, lines: LineIn[], includeVat: boolean) {
    const ids = [...new Set(lines.map((l) => l.item_id))];
    const items = ids.length ? await trx.selectFrom('stock_items').select(['id', 'name', 'is_active', 'requires_lot', 'requires_expiry', 'serial_tracked']).where('id', 'in', ids).execute() : [];
    const packIds = [...new Set(lines.map((l) => l.pack_id).filter((p): p is string => !!p))];
    const packs = packIds.length ? await trx.selectFrom('stock_item_packs').select(['id', 'item_id', 'qty_base', 'is_active']).where('id', 'in', packIds).execute() : [];
    let net = 0; let vat = 0;
    const out = lines.map((l, i) => {
      const it = items.find((x) => x.id === l.item_id);
      if (!it) throw new BadRequestException(`ხაზი ${i + 1}: საქონელი ვერ მოიძებნა`);
      const p = l.pack_id ? packs.find((x) => x.id === l.pack_id && x.item_id === l.item_id) : null;
      if (l.pack_id && !p) throw new BadRequestException(`ხაზი ${i + 1}: შეფუთვა „${it.name}“-ს არ ეკუთვნის`);
      const per = p ? Number(p.qty_base) : 1;
      const qtyBase = Math.round(l.qty * per * 1000) / 1000;
      const rate = l.vat_rate ?? 0;
      let unitCost: number | null = null; let lineNet: number | null = null; let lineVat: number | null = null;
      if (l.price !== undefined && l.price !== null) {
        const netPer = includeVat ? l.price / (1 + rate / 100) : l.price;
        unitCost = r6(netPer / per);
        if (includeVat) { const gross = r2(l.price * l.qty); lineNet = r2(gross / (1 + rate / 100)); lineVat = r2(gross - lineNet); }
        else { lineNet = r2(l.price * l.qty); lineVat = r2((lineNet * rate) / 100); }
        net += lineNet; vat += lineVat;
      }
      return {
        line_no: i + 1, item_id: l.item_id, pack_id: p?.id ?? null, pack_qty_base: String(per), qty: String(l.qty), qty_base: String(qtyBase),
        lot_no: it.requires_lot ? norm(l.lot_no) : null, serial_no: it.serial_tracked ? norm(l.serial_no) : null,
        expires_on: it.requires_expiry ? l.expires_on || null : null, produced_on: it.requires_lot ? l.produced_on || null : null,
        price: l.price === undefined || l.price === null ? null : String(l.price), vat_rate: String(rate), unit_cost: unitCost === null ? null : String(unitCost),
        line_net: lineNet === null ? null : String(lineNet), line_vat: lineVat === null ? null : String(lineVat),
        short_expiry_reason: l.short_expiry_reason?.trim() || null, notes: l.notes?.trim() || null,
      };
    });
    return { lines: out, net: r2(net), vat: r2(vat) };
  }

  private headerVals(dto: ReceiptIn) {
    return {
      location_id: dto.location_id, supplier_id: dto.supplier_id ?? null, invoice_no: dto.invoice_no?.trim() || null, invoice_date: dto.invoice_date || null,
      waybill_no: dto.waybill_no?.trim() || null, prices_include_vat: dto.prices_include_vat ?? true, notes: dto.notes?.trim() || null,
    };
  }

  async createReceipt(dto: ReceiptIn, u: AuthUser, ctx: AuditContext) {
    await this.checkLocation(u, dto.location_id);
    const id = await this.db.transaction().execute(async (trx) => {
      const today = await this.today(trx);
      const b = await this.buildLines(trx, dto.lines, dto.prices_include_vat ?? true);
      const d = await trx.insertInto('stock_docs').values({ doc_type: 'receipt', doc_date: dto.doc_date ?? today, ...this.headerVals(dto), total_net: String(b.net), total_vat: String(b.vat), created_by: u.id })
        .returning('id').executeTakeFirstOrThrow();
      if (b.lines.length) await trx.insertInto('stock_doc_lines').values(b.lines.map((l) => ({ ...l, doc_id: d.id }))).execute();
      await this.audit.log(ctx, { action: 'CREATE_STOCK_RECEIPT', entityName: 'stock_docs', entityId: d.id, newData: { ...this.headerVals(dto), lines: dto.lines.length } }, trx);
      return d.id;
    });
    return this.withIssues(id);
  }

  async updateReceipt(id: string, dto: ReceiptIn, u: AuthUser, ctx: AuditContext) {
    await this.checkLocation(u, dto.location_id);
    await this.db.transaction().execute(async (trx) => {
      const d = await trx.selectFrom('stock_docs').select(['id', 'status', 'doc_type', 'location_id']).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!d || d.doc_type !== 'receipt') throw new NotFoundException('მიღების დოკუმენტი ვერ მოიძებნა');
      if (d.status !== 'draft') throw new ConflictException('მხოლოდ მონახაზი იცვლება');
      if (d.location_id) await this.checkLocation(u, d.location_id, trx);
      const b = await this.buildLines(trx, dto.lines, dto.prices_include_vat ?? true);
      await trx.updateTable('stock_docs').set({ ...this.headerVals(dto), ...(dto.doc_date && { doc_date: dto.doc_date }), total_net: String(b.net), total_vat: String(b.vat) }).where('id', '=', id).execute();
      await trx.deleteFrom('stock_doc_lines').where('doc_id', '=', id).execute();
      if (b.lines.length) await trx.insertInto('stock_doc_lines').values(b.lines.map((l) => ({ ...l, doc_id: id }))).execute();
      await this.audit.log(ctx, { action: 'UPDATE_STOCK_RECEIPT', entityName: 'stock_docs', entityId: id, newData: { ...this.headerVals(dto), lines: dto.lines.length } }, trx);
    });
    return this.withIssues(id);
  }

  async cancelDraft(id: string, reason: string | undefined, u: AuthUser, ctx: AuditContext) {
    await this.db.transaction().execute(async (trx) => {
      const d = await trx.selectFrom('stock_docs').select(['status', 'location_id']).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!d) throw new NotFoundException('დოკუმენტი ვერ მოიძებნა');
      if (d.status !== 'draft') throw new ConflictException('გაუქმდება მხოლოდ მონახაზი; გატარებული — შემობრუნებით');
      if (d.location_id) await this.checkLocation(u, d.location_id, trx);
      await trx.updateTable('stock_docs').set({ status: 'cancelled', reason: reason?.trim() || null }).where('id', '=', id).execute();
      await this.audit.log(ctx, { action: 'CANCEL_STOCK_DOC', entityName: 'stock_docs', entityId: id, newData: { reason } }, trx);
    });
    return this.get(id);
  }

  // ---------------------------------------------------------------- შემოწმება (მონახაზზე — გაფრთხილებები, გატარებისას — ბლოკი)
  private async issues(id: string, ex: Database | Trx = this.db): Promise<Issue[]> {
    const d = await this.get(id, ex);
    const today = await this.today(ex);
    const st = await ex.selectFrom('stock_settings').select('short_expiry_months').where('id', '=', 1).executeTakeFirstOrThrow();
    const out: Issue[] = [];
    if (d.doc_date > today) out.push({ line_no: 0, level: 'error', code: 'future_date', message: 'დოკუმენტის თარიღი მომავალშია' });
    if (!d.lines.length) out.push({ line_no: 0, level: 'error', code: 'no_lines', message: 'დოკუმენტს ხაზი არ აქვს' });
    if (!d.supplier_id) out.push({ line_no: 0, level: 'warn', code: 'no_supplier', message: 'მომწოდებელი არ არის მითითებული' });
    const shortLimit = addMonths(d.doc_date, st.short_expiry_months);
    const serials = new Map<string, number>();
    for (const l of d.lines) {
      const e = (code: string, message: string) => out.push({ line_no: l.line_no, level: 'error', code, message: `ხაზი ${l.line_no} (${l.item_name}): ${message}` });
      if (l.requires_lot && !l.lot_no) e('lot_required', 'ლოტი / სერია სავალდებულოა');
      if (l.requires_expiry && !l.expires_on) e('expiry_required', 'ვადა სავალდებულოა');
      if (l.serial_tracked) {
        if (!l.serial_no) e('serial_required', 'სერიული ნომერი სავალდებულოა');
        if (Number(l.qty_base) !== 1) e('serial_qty', 'სერიულ საქონელზე თითო ხაზი = 1 ერთეული');
        if (l.serial_no) { const k = `${l.item_id}|${l.serial_no}`; if (serials.has(k)) e('serial_dup', `სერიული ${l.serial_no} დოკუმენტში მეორდება`); serials.set(k, 1); }
      }
      if (l.price === null) e('price_required', 'ფასი სავალდებულოა (უფასო — 0)');
      if (l.expires_on && l.expires_on < d.doc_date) e('expired', `ვადაგასულია (${dge(l.expires_on)}) — მიღება აკრძალულია`);
      else if (l.expires_on && l.expires_on < shortLimit) {
        const msg = `მოკლე ვადა: ${dge(l.expires_on)} (< ${st.short_expiry_months} თვე)`;
        out.push({ line_no: l.line_no, level: l.short_expiry_reason ? 'warn' : 'error', code: 'short_expiry', message: `ხაზი ${l.line_no} (${l.item_name}): ${msg}${l.short_expiry_reason ? ` — მიზეზი: ${l.short_expiry_reason}` : ' — მიუთითეთ მიზეზი'}` });
      }
      // არსებული ლოტი: სხვა ვადა / სერიული უკვე მიღებულია / ბლოკირებული
      if (l.lot_no || l.serial_no) {
        const lot = await ex.selectFrom('stock_lots').select(['expires_on', 'status', 'received_qty']).where('item_id', '=', l.item_id)
          .where(sql`coalesce(lot_no, '')`, '=', l.lot_no ?? '').where(sql`coalesce(serial_no, '')`, '=', l.serial_no ?? '').executeTakeFirst();
        if (lot) {
          if (lot.expires_on && l.expires_on && lot.expires_on !== l.expires_on) e('lot_expiry_mismatch', `ლოტი ${l.lot_no} უკვე არსებობს სხვა ვადით (${dge(lot.expires_on)})`);
          if (lot.status !== 'active') e('lot_blocked', `ლოტი ${l.lot_no ?? ''} დაბლოკილია (${lot.status === 'recalled' ? 'გაწვეული' : 'ქარანტინი'})`);
          if (l.serial_no && Number(lot.received_qty) > 0) e('serial_exists', `სერიული ${l.serial_no} უკვე მიღებულია`);
        }
      }
    }
    return out;
  }
  async withIssues(id: string) { const d = await this.get(id); return { ...d, issues: d.status === 'draft' ? await this.issues(id) : [] }; }

  // ---------------------------------------------------------------- გატარება
  async postReceipt(id: string, u: AuthUser, ctx: AuditContext) {
    try {
      await this.db.transaction().execute(async (trx) => {
        const d = await trx.selectFrom('stock_docs').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
        if (!d || d.doc_type !== 'receipt') throw new NotFoundException('მიღების დოკუმენტი ვერ მოიძებნა');
        if (d.status !== 'draft') throw new ConflictException('დოკუმენტი უკვე გატარებულია ან გაუქმებულია');
        await this.checkLocation(u, d.location_id!, trx);
        const errs = (await this.issues(id, trx)).filter((i) => i.level === 'error');
        if (errs.length) throw new BadRequestException({ message: errs.map((e) => e.message).join('; '), issues: errs });
        const lines = await trx.selectFrom('stock_doc_lines').selectAll().where('doc_id', '=', id).orderBy('line_no').execute();
        for (const l of lines) {
          const q = Number(l.qty_base); const c = Number(l.unit_cost ?? 0);
          let lot = await trx.selectFrom('stock_lots').select(['id', 'received_qty', 'received_value']).where('item_id', '=', l.item_id)
            .where(sql`coalesce(lot_no, '')`, '=', l.lot_no ?? '').where(sql`coalesce(serial_no, '')`, '=', l.serial_no ?? '').forUpdate().executeTakeFirst();
          if (lot) {
            const rq = Number(lot.received_qty) + q; const rv = Number(lot.received_value) + c * q;
            await trx.updateTable('stock_lots').set({ received_qty: String(rq), received_value: rv.toFixed(8), unit_cost: String(rq > 0 ? r6(rv / rq) : c),
              ...(l.expires_on && { expires_on: l.expires_on }), ...(l.produced_on && { produced_on: l.produced_on }) }).where('id', '=', lot.id).execute();
          } else {
            lot = await trx.insertInto('stock_lots').values({ item_id: l.item_id, lot_no: l.lot_no, serial_no: l.serial_no, expires_on: l.expires_on, produced_on: l.produced_on,
              unit_cost: String(c), received_qty: String(q), received_value: (c * q).toFixed(8), first_supplier_id: d.supplier_id }).returning(['id', 'received_qty', 'received_value']).executeTakeFirstOrThrow();
          }
          await trx.updateTable('stock_doc_lines').set({ lot_id: lot.id }).where('id', '=', l.id).execute();
          await trx.insertInto('stock_moves').values({ doc_id: id, line_id: l.id, move_type: 'receipt', location_id: d.location_id!, lot_id: lot.id, item_id: l.item_id, qty: String(q), cost_lot: String(c), created_by: u.id }).execute();
        }
        const no = await this.nextNo(trx, 'receipt', d.doc_date);
        await trx.updateTable('stock_docs').set({ status: 'posted', doc_no: no, posted_by: u.id, posted_at: sql`now()` }).where('id', '=', id).execute();
        await this.audit.log(ctx, { action: 'POST_STOCK_RECEIPT', entityName: 'stock_docs', entityId: id, newData: { doc_no: no, lines: lines.length, total_net: d.total_net, total_vat: d.total_vat } }, trx);
      });
    } catch (e) { this.mapLedgerError(e); }
    return this.get(id);
  }

  // ---------------------------------------------------------------- შემობრუნება (გატარებული მიღება → საპირისპირო მოძრაობები)
  async reverse(id: string, reason: string, u: AuthUser, ctx: AuditContext) {
    let rid = '';
    try {
      await this.db.transaction().execute(async (trx) => {
        const d = await trx.selectFrom('stock_docs').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
        if (!d) throw new NotFoundException('დოკუმენტი ვერ მოიძებნა');
        if (d.status !== 'posted') throw new ConflictException('შემობრუნდება მხოლოდ გატარებული დოკუმენტი');
        if (d.doc_type !== 'receipt') throw new BadRequestException('ამ ეტაპზე შემობრუნდება მიღება');
        if (d.reversed_by) throw new ConflictException('დოკუმენტი უკვე შემობრუნებულია');
        const today = await this.today(trx);
        const r = await trx.insertInto('stock_docs').values({ doc_type: 'reversal', doc_date: today, location_id: d.location_id, supplier_id: d.supplier_id, invoice_no: d.invoice_no,
          invoice_date: d.invoice_date, waybill_no: d.waybill_no, prices_include_vat: d.prices_include_vat, total_net: String(-Number(d.total_net)), total_vat: String(-Number(d.total_vat)),
          reversal_of: id, reason: reason.trim(), notes: `შემობრუნება: ${d.doc_no}`, created_by: u.id }).returning('id').executeTakeFirstOrThrow();
        rid = r.id;
        const lines = await trx.selectFrom('stock_doc_lines').selectAll().where('doc_id', '=', id).orderBy('line_no').execute();
        for (const l of lines) {
          const { id: _i, doc_id: _d, ...rest } = l;
          const nl = await trx.insertInto('stock_doc_lines').values({ ...rest, doc_id: rid }).returning('id').executeTakeFirstOrThrow();
          const q = Number(l.qty_base); const c = Number(l.unit_cost ?? 0);
          const lot = await trx.selectFrom('stock_lots').select(['id', 'unit_cost', 'received_qty', 'received_value']).where('id', '=', l.lot_id!).forUpdate().executeTakeFirstOrThrow();
          const rq = Number(lot.received_qty) - q; const rv = Math.max(0, Number(lot.received_value) - c * q);
          await trx.updateTable('stock_lots').set({ received_qty: String(Math.max(0, rq)), received_value: (rq > 0 ? rv : 0).toFixed(8), ...(rq > 0 && { unit_cost: String(r6(rv / rq)) }) })
            .where('id', '=', lot.id).execute();
          await trx.insertInto('stock_moves').values({ doc_id: rid, line_id: nl.id, move_type: 'receipt', location_id: d.location_id!, lot_id: lot.id, item_id: l.item_id, qty: String(-q), cost_lot: String(c), created_by: u.id }).execute();
        }
        const no = await this.nextNo(trx, 'reversal', today);
        await trx.updateTable('stock_docs').set({ status: 'posted', doc_no: no, posted_by: u.id, posted_at: sql`now()` }).where('id', '=', rid).execute();
        await trx.updateTable('stock_docs').set({ reversed_by: rid }).where('id', '=', id).execute();
        await this.audit.log(ctx, { action: 'REVERSE_STOCK_DOC', entityName: 'stock_docs', entityId: id, newData: { reversal_id: rid, reversal_no: no, reason } }, trx);
      });
    } catch (e) { this.mapLedgerError(e); }
    return this.get(rid);
  }

  private mapLedgerError(e: unknown): never {
    const err = e as { code?: string; constraint?: string };
    if (err.constraint === 'stock_balances_non_negative') throw new ConflictException('ნაშთი არასაკმარისია — მარაგის ნაწილი უკვე გაცემულია / გადატანილია');
    if (err.constraint === 'ux_stock_lots_key') throw new ConflictException('ლოტი ერთდროულად სხვა დოკუმენტით შეიქმნა — სცადეთ ხელახლა');
    if (err.constraint === 'ux_stock_docs_reversal') throw new ConflictException('დოკუმენტი უკვე შემობრუნებულია');
    throw e;
  }

  // ---------------------------------------------------------------- ნაშთები / ისტორია
  async balances(q: { location_id?: string; item_id?: string; search?: string; category_id?: string; expiring_days?: number; include_zero?: boolean }) {
    const st = await this.db.selectFrom('stock_settings').select('costing_method').where('id', '=', 1).executeTakeFirstOrThrow();
    const today = await this.today();
    let x = this.db.selectFrom('stock_balances as b').innerJoin('stock_lots as lt', 'lt.id', 'b.lot_id').innerJoin('stock_items as i', 'i.id', 'b.item_id')
      .innerJoin('stock_locations as l', 'l.id', 'b.location_id').innerJoin('stock_units as un', 'un.code', 'i.base_unit').innerJoin('stock_categories as c', 'c.id', 'i.category_id')
      .leftJoin('stock_item_costs as ic', 'ic.item_id', 'i.id').leftJoin('med_generics as g', 'g.id', 'i.generic_id')
      .select(['b.location_id', 'b.lot_id', 'b.item_id', 'b.qty', 'l.name as location_name', 'i.name as item_name', 'i.code as item_code', 'un.name as base_unit_name', 'c.name as category_name',
        'lt.lot_no', 'lt.serial_no', 'lt.expires_on', 'lt.status as lot_status', 'lt.unit_cost as cost_lot', 'ic.avg_cost as cost_avg', 'g.inn', 'g.strength', 'g.controlled_class',
        sql<number | null>`CASE WHEN lt.expires_on IS NULL THEN NULL ELSE lt.expires_on - ${today}::date END`.as('days_left'),
        sql<number | null>`coalesce(i.expiry_warn_days, c.expiry_warn_days)`.as('warn_days'),
        sql<{ name: string; qty_base: string }[]>`coalesce((SELECT json_agg(json_build_object('name', p.name, 'qty_base', p.qty_base) ORDER BY p.qty_base DESC) FROM stock_item_packs p WHERE p.item_id = i.id AND p.is_active), '[]')`.as('packs')])
      .orderBy('i.name').orderBy(sql`lt.expires_on NULLS LAST`).orderBy('l.name').limit(3000);
    if (!q.include_zero) x = x.where('b.qty', '>', '0');
    if (q.location_id) x = x.where('b.location_id', '=', q.location_id);
    if (q.item_id) x = x.where('b.item_id', '=', q.item_id);
    if (q.category_id) x = x.where('i.category_id', '=', q.category_id);
    if (q.expiring_days !== undefined) x = x.where('lt.expires_on', '<=', sql<string>`${today}::date + ${q.expiring_days}::int`);
    const s = q.search?.trim();
    if (s) {
      const like = `%${s.toLowerCase()}%`;
      x = x.where((eb) => eb.or([eb(sql`lower(i.name)`, 'like', like), eb(sql`lower(i.code)`, 'like', like), eb(sql`lower(coalesce(g.inn, ''))`, 'like', like),
        eb(sql`upper(coalesce(lt.lot_no, ''))`, 'like', `%${s.toUpperCase()}%`), eb(sql`upper(coalesce(lt.serial_no, ''))`, 'like', `%${s.toUpperCase()}%`)]));
    }
    const rows = await x.execute();
    const method = st.costing_method;
    const out = rows.map((r) => {
      const unit = Number(method === 'fifo' ? r.cost_lot : r.cost_avg ?? r.cost_lot);
      return { ...r, unit_cost: r6(unit), value: r2(unit * Number(r.qty)) };
    });
    return { costing_method: method, today, total_value: r2(out.reduce((a, r) => a + r.value, 0)), rows: out };
  }

  async moves(itemId: string, q: { location_id?: string; lot_id?: string }) {
    let x = this.db.selectFrom('stock_moves as m').innerJoin('stock_docs as d', 'd.id', 'm.doc_id').innerJoin('stock_lots as lt', 'lt.id', 'm.lot_id')
      .innerJoin('stock_locations as l', 'l.id', 'm.location_id').innerJoin('users as u', 'u.id', 'm.created_by')
      .select(['m.id', 'm.created_at', 'm.move_type', 'm.qty', 'm.cost_lot', 'm.cost_avg', 'd.id as doc_id', 'd.doc_no', 'd.doc_type', 'd.doc_date', 'l.name as location_name',
        'lt.lot_no', 'lt.serial_no', 'lt.expires_on', sql<string>`u.first_name || ' ' || u.last_name`.as('user_name')])
      .where('m.item_id', '=', itemId).orderBy('m.id', 'desc').limit(1000);
    if (q.location_id) x = x.where('m.location_id', '=', q.location_id);
    if (q.lot_id) x = x.where('m.lot_id', '=', q.lot_id);
    const [rows, item, cost] = await Promise.all([x.execute(),
      this.db.selectFrom('stock_items as i').innerJoin('stock_units as un', 'un.code', 'i.base_unit').select(['i.id', 'i.name', 'i.code', 'un.name as base_unit_name']).where('i.id', '=', itemId).executeTakeFirst(),
      this.db.selectFrom('stock_item_costs').selectAll().where('item_id', '=', itemId).executeTakeFirst()]);
    if (!item) throw new NotFoundException('საქონელი ვერ მოიძებნა');
    return { item, qty_on_hand: cost?.qty_on_hand ?? '0', avg_cost: cost?.avg_cost ?? '0', moves: rows };
  }

  lots(itemId: string) {
    return this.db.selectFrom('stock_lots as lt').leftJoin('stock_suppliers as s', 's.id', 'lt.first_supplier_id').selectAll('lt').select(['s.name as supplier_name',
      sql<string>`coalesce((SELECT sum(b.qty) FROM stock_balances b WHERE b.lot_id = lt.id), 0)`.as('qty')])
      .where('lt.item_id', '=', itemId).orderBy(sql`lt.expires_on NULLS LAST`).orderBy('lt.created_at').execute();
  }
}

// ======================================================================= DTO
class LineDto {
  @IsUUID() item_id: string; @IsOptional() @IsUUID() pack_id?: string | null;
  @IsNumber() @Min(0.001) @Max(10_000_000) qty: number;
  @IsOptional() @IsString() @MaxLength(40) lot_no?: string | null; @IsOptional() @IsString() @MaxLength(60) serial_no?: string | null;
  @IsOptional() @IsISO8601({ strict: true }) expires_on?: string | null; @IsOptional() @IsISO8601({ strict: true }) produced_on?: string | null;
  @IsOptional() @IsNumber() @Min(0) @Max(100_000_000) price?: number | null; @IsOptional() @IsIn([0, 18]) vat_rate?: number;
  @IsOptional() @IsString() @MaxLength(500) short_expiry_reason?: string | null; @IsOptional() @IsString() @MaxLength(500) notes?: string | null;
}
class ReceiptDto {
  @IsUUID() location_id: string; @IsOptional() @IsUUID() supplier_id?: string | null; @IsOptional() @IsISO8601({ strict: true }) doc_date?: string;
  @IsOptional() @IsString() @MaxLength(60) invoice_no?: string | null; @IsOptional() @IsISO8601({ strict: true }) invoice_date?: string | null;
  @IsOptional() @IsString() @MaxLength(40) waybill_no?: string | null; @IsOptional() @IsBoolean() prices_include_vat?: boolean; @IsOptional() @IsString() @MaxLength(2000) notes?: string | null;
  @IsArray() @ArrayMinSize(0) @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => LineDto) lines: LineDto[];
}
class ReasonDto { @IsString() @Length(3, 500) reason: string }
class OptReasonDto { @IsOptional() @IsString() @MaxLength(500) reason?: string }
const uuidOk = (v?: string) => !v || /^[0-9a-f-]{36}$/i.test(v);
const dateOk = (v?: string) => !v || /^\d{4}-\d{2}-\d{2}$/.test(v);

@Controller('stock')
export class StockDocsController {
  constructor(private readonly s: StockDocsService) {}
  @Get('docs') @Roles(...STOCK_READ) list(@Query() q: { type?: string; status?: string; location_id?: string; supplier_id?: string; from?: string; to?: string; search?: string }) {
    if (!uuidOk(q.location_id) || !uuidOk(q.supplier_id) || !dateOk(q.from) || !dateOk(q.to)) throw new BadRequestException('არასწორი ფილტრი');
    if (q.type && q.type.split(',').some((t) => !Object.keys(PREFIX).includes(t))) throw new BadRequestException('უცნობი ტიპი');
    if (q.status && !['draft', 'posted', 'cancelled'].includes(q.status)) throw new BadRequestException('უცნობი სტატუსი');
    return this.s.list(q);
  }
  @Get('docs/:id') @Roles(...STOCK_READ) one(@Param('id', ParseUUIDPipe) id: string) { return this.s.withIssues(id); }
  @Post('receipts') @Roles(...RECEIPT_EDIT) create(@Body() d: ReceiptDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.createReceipt(d, u, auditCtx(r)); }
  @Put('receipts/:id') @Roles(...RECEIPT_EDIT) update(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReceiptDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.updateReceipt(id, d, u, auditCtx(r)); }
  @Post('receipts/:id/post') @HttpCode(200) @Roles(...RECEIPT_EDIT) post(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.postReceipt(id, u, auditCtx(r)); }
  @Post('docs/:id/cancel') @HttpCode(200) @Roles(...RECEIPT_EDIT) cancel(@Param('id', ParseUUIDPipe) id: string, @Body() d: OptReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.cancelDraft(id, d.reason, u, auditCtx(r)); }
  @Post('docs/:id/reverse') @HttpCode(200) @Roles(...STOCK_REVERSE) reverse(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.reverse(id, d.reason, u, auditCtx(r)); }

  @Get('balances') @Roles(...STOCK_READ) balances(@Query() q: { location_id?: string; item_id?: string; category_id?: string; search?: string; expiring_days?: string; include_zero?: string }) {
    if (!uuidOk(q.location_id) || !uuidOk(q.item_id) || !uuidOk(q.category_id)) throw new BadRequestException('არასწორი id');
    const ed = q.expiring_days !== undefined && q.expiring_days !== '' ? Number(q.expiring_days) : undefined;
    if (ed !== undefined && (!Number.isInteger(ed) || ed < -3650 || ed > 3650)) throw new BadRequestException('expiring_days — მთელი რიცხვი');
    return this.s.balances({ ...q, expiring_days: ed, include_zero: q.include_zero === 'true' });
  }
  @Get('items/:id/moves') @Roles(...STOCK_READ) moves(@Param('id', ParseUUIDPipe) id: string, @Query('location_id') location_id?: string, @Query('lot_id') lot_id?: string) {
    if (!uuidOk(location_id) || !uuidOk(lot_id)) throw new BadRequestException('არასწორი id');
    return this.s.moves(id, { location_id, lot_id });
  }
  @Get('items/:id/lots') @Roles(...STOCK_READ) lots(@Param('id', ParseUUIDPipe) id: string) { return this.s.lots(id); }
}
