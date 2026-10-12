import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsISO8601, IsNumber, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser } from '../auth/roles';
import { RECEIPT_EDIT, StockDocsService, type LineIn } from '../stock/stock-docs';
import { addDays, ProcCommon, r2, r3, r4, r6, type Ex, userName } from './procurement-common';
import { PO_EDIT, PROC_READ } from './procurement-rules';

export interface PoLineIn { item_id: string; pack_id?: string | null; qty: number; price: number; vat_rate?: number; requisition_line_id?: string | null; notes?: string | null }
export interface PoIn {
  supplier_id: string; location_id: string; order_date?: string; expected_date?: string | null; currency?: 'GEL' | 'USD' | 'EUR'; fx_rate?: number;
  prices_include_vat?: boolean; contract_no?: string | null; notes?: string | null; lines: PoLineIn[];
}
const OPEN = ['sent', 'partial'];

/**
 * შეკვეთა მომწოდებელთან (PO, 0051): მონახაზი → გაგზავნა (PO-ნომერი; PR-ის გარეშე ზღვარს ზემოთ — ფინანსური დამტკიცება „pending“) →
 * მიღება RC-ით (ნაწილობრივ — რამდენჯერმე) → მიღებული / დახურული (დარჩენილი აღარ მოვა) / გაუქმებული.
 */
@Injectable()
export class ProcOrdersService {
  constructor(private readonly c: ProcCommon, private readonly audit: AuditService, private readonly docs: StockDocsService) {}
  private get db() { return this.c.db; }

  // ---------------------------------------------------------------- სია / ნახვა
  async list(q: { status?: string; supplier_id?: string; location_id?: string; search?: string; overdue?: boolean }) {
    await this.c.rules();
    const today = await this.c.today();
    let x = this.db.selectFrom('proc_orders as o').innerJoin('stock_suppliers as s', 's.id', 'o.supplier_id').innerJoin('stock_locations as lc', 'lc.id', 'o.location_id')
      .innerJoin('users as u', 'u.id', 'o.created_by')
      .select(['o.id', 'o.po_no', 'o.status', 'o.order_date', 'o.expected_date', 'o.currency', 'o.total_net', 'o.total_vat', 'o.total_gel', 'o.supplier_id', 'o.location_id', 'o.needs_approval',
        's.name as supplier_name', 'lc.name as location_name', userName('u').as('created_by_name'), 'o.created_at', 'o.sent_at',
        sql<boolean>`o.status IN ('sent', 'partial') AND o.expected_date < ${today}::date`.as('overdue'),
        sql<number>`(SELECT count(*)::int FROM proc_order_lines l WHERE l.order_id = o.id)`.as('lines'),
        sql<string>`(SELECT coalesce(sum(least(l.qty_received, l.qty_base)) / nullif(sum(l.qty_base), 0), 0) FROM proc_order_lines l WHERE l.order_id = o.id)`.as('received_ratio')])
      .orderBy('o.created_at', 'desc').limit(500);
    if (q.status) x = x.where('o.status', 'in', q.status.split(','));
    if (q.supplier_id) x = x.where('o.supplier_id', '=', q.supplier_id);
    if (q.location_id) x = x.where('o.location_id', '=', q.location_id);
    if (q.overdue) x = x.where('o.status', 'in', OPEN).where('o.expected_date', '<', today);
    const s = q.search?.trim();
    if (s) x = x.where((eb) => eb.or([eb(sql`upper(coalesce(o.po_no, ''))`, 'like', `%${s.toUpperCase()}%`), eb(sql`lower(s.name)`, 'like', `%${s.toLowerCase()}%`),
      eb(sql<boolean>`EXISTS (SELECT 1 FROM proc_order_lines l JOIN stock_items i ON i.id = l.item_id WHERE l.order_id = o.id AND lower(i.name) LIKE ${`%${s.toLowerCase()}%`})`, '=', true)]));
    return x.execute();
  }

  async get(id: string, ex: Ex = this.db) {
    const today = await this.c.today(ex);
    const o = await ex.selectFrom('proc_orders as o').innerJoin('stock_suppliers as s', 's.id', 'o.supplier_id').innerJoin('stock_locations as lc', 'lc.id', 'o.location_id')
      .innerJoin('users as u', 'u.id', 'o.created_by').leftJoin('users as ua', 'ua.id', 'o.approved_by').leftJoin('users as us', 'us.id', 'o.sent_by').leftJoin('users as uc', 'uc.id', 'o.closed_by')
      .selectAll('o').select(['s.name as supplier_name', 's.tax_id as supplier_tax_id', 's.vat_payer as supplier_vat_payer', 's.address as supplier_address', 's.phone as supplier_phone',
        's.email as supplier_email', 's.contact_person as supplier_contact', 'lc.name as location_name', userName('u').as('created_by_name'), userName('ua').as('approved_by_name'),
        userName('us').as('sent_by_name'), userName('uc').as('closed_by_name'), sql<boolean>`o.status IN ('sent', 'partial') AND o.expected_date < ${today}::date`.as('overdue')])
      .where('o.id', '=', id).executeTakeFirst();
    if (!o) throw new NotFoundException('შეკვეთა ვერ მოიძებნა');
    const lines = await ex.selectFrom('proc_order_lines as l').innerJoin('stock_items as i', 'i.id', 'l.item_id').innerJoin('stock_units as un', 'un.code', 'i.base_unit')
      .leftJoin('stock_item_packs as k', 'k.id', 'l.pack_id').leftJoin('proc_requisition_lines as rl', 'rl.id', 'l.requisition_line_id').leftJoin('proc_requisitions as pr', 'pr.id', 'rl.requisition_id')
      .selectAll('l').select(['i.name as item_name', 'i.code as item_code', 'un.name as base_unit_name', 'k.name as pack_name', 'pr.pr_no', 'pr.id as requisition_id', 'pr.status as requisition_status'])
      .where('l.order_id', '=', id).orderBy('l.line_no').execute();
    const receipts = await ex.selectFrom('stock_docs as d').leftJoin('stock_docs as rv', 'rv.id', 'd.reversed_by')
      .select(['d.id', 'd.doc_no', 'd.status', 'd.doc_date', 'd.total_net', 'd.total_vat', 'd.invoice_no', 'd.waybill_no', 'rv.doc_no as reversed_by_no'])
      .where('d.po_id', '=', id).where('d.doc_type', '=', 'receipt').where('d.status', '<>', 'cancelled').orderBy('d.created_at').execute();
    return { ...o, lines, receipts };
  }

  // ---------------------------------------------------------------- მონახაზი
  private async build(ex: Ex, dto: PoIn) {
    const cur = dto.currency ?? 'GEL'; const fx = cur === 'GEL' ? 1 : dto.fx_rate ?? 0;
    if (cur !== 'GEL' && !(fx > 0)) throw new BadRequestException('უცხოურ ვალუტაზე კურსი სავალდებულოა (1 ერთეული = ? ₾)');
    const incl = dto.prices_include_vat ?? false;
    const q = await this.c.qtyLines(ex, dto.lines);
    const rlIds = [...new Set(dto.lines.map((l) => l.requisition_line_id).filter((x): x is string => !!x))];
    const rls = rlIds.length ? await ex.selectFrom('proc_requisition_lines as l').innerJoin('proc_requisitions as p', 'p.id', 'l.requisition_id')
      .select(['l.id', 'l.item_id', 'p.status', 'p.pr_no']).where('l.id', 'in', rlIds).execute() : [];
    let net = 0; let vat = 0;
    const lines = q.map((b, i) => {
      const l = b.src; const rate = l.vat_rate ?? 18;
      if (l.requisition_line_id) {
        const rl = rls.find((x) => x.id === l.requisition_line_id);
        if (!rl) throw new BadRequestException(`ხაზი ${i + 1}: შესყიდვის მოთხოვნის ხაზი ვერ მოიძებნა`);
        if (rl.status !== 'approved') throw new BadRequestException(`ხაზი ${i + 1}: მოთხოვნა ${rl.pr_no ?? ''} დამტკიცებული არ არის`);
        if (rl.item_id !== l.item_id) throw new BadRequestException(`ხაზი ${i + 1}: საქონელი არ ემთხვევა მოთხოვნის ხაზს`);
      }
      const netPer = incl ? l.price / (1 + rate / 100) : l.price;
      let lineNet: number; let lineVat: number;
      if (incl) { const gross = r2(l.price * l.qty); lineNet = r2(gross / (1 + rate / 100)); lineVat = r2(gross - lineNet); } else { lineNet = r2(l.price * l.qty); lineVat = r2((lineNet * rate) / 100); }
      net += lineNet; vat += lineVat;
      return { line_no: i + 1, item_id: l.item_id, pack_id: b.pack_id, pack_qty_base: String(b.per), qty: String(l.qty), qty_base: String(b.qty_base), price: String(r4(l.price)), vat_rate: String(rate),
        unit_cost_gel: String(r6((netPer * fx) / b.per)), line_net: String(lineNet), line_vat: String(lineVat), requisition_line_id: l.requisition_line_id ?? null, notes: l.notes?.trim() || null };
    });
    return { cur, fx, incl, lines, net: r2(net), vat: r2(vat), gel: r2(net * fx) };
  }
  private async header(u: AuthUser, dto: PoIn, ex: Ex) {
    const s = await this.c.supplier(dto.supplier_id, ex);
    await this.c.location(u, dto.location_id, ex);
    const today = await this.c.today(ex);
    const od = dto.order_date ?? today;
    if (od > today) throw new BadRequestException('შეკვეთის თარიღი მომავალშია');
    return { supplier_id: s.id, location_id: dto.location_id, order_date: od, expected_date: dto.expected_date === undefined ? (s.lead_time_days ? addDays(od, s.lead_time_days) : null) : dto.expected_date || null,
      contract_no: dto.contract_no === undefined ? s.contract_no : dto.contract_no?.trim() || null, notes: dto.notes?.trim() || null };
  }

  async create(dto: PoIn, u: AuthUser, ctx: AuditContext) {
    await this.c.rulesPo();
    const id = await this.db.transaction().execute(async (trx) => {
      const h = await this.header(u, dto, trx); const b = await this.build(trx, dto);
      const o = await trx.insertInto('proc_orders').values({ ...h, currency: b.cur, fx_rate: String(b.fx), prices_include_vat: b.incl, total_net: String(b.net), total_vat: String(b.vat), total_gel: String(b.gel), created_by: u.id })
        .returning('id').executeTakeFirstOrThrow();
      if (b.lines.length) await trx.insertInto('proc_order_lines').values(b.lines.map((l) => ({ ...l, order_id: o.id }))).execute();
      await this.audit.log(ctx, { action: 'CREATE_PROC_PO', entityName: 'proc_orders', entityId: o.id, newData: { ...h, currency: b.cur, total_gel: b.gel, lines: b.lines.length } }, trx);
      return o.id;
    });
    return this.get(id);
  }

  async update(id: string, dto: PoIn, u: AuthUser, ctx: AuditContext) {
    await this.c.rulesPo();
    await this.db.transaction().execute(async (trx) => {
      const o = await trx.selectFrom('proc_orders').select(['status']).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!o) throw new NotFoundException('შეკვეთა ვერ მოიძებნა');
      if (o.status !== 'draft') throw new ConflictException('მხოლოდ მონახაზი იცვლება');
      const h = await this.header(u, dto, trx); const b = await this.build(trx, dto);
      await trx.updateTable('proc_orders').set({ ...h, currency: b.cur, fx_rate: String(b.fx), prices_include_vat: b.incl, total_net: String(b.net), total_vat: String(b.vat), total_gel: String(b.gel) }).where('id', '=', id).execute();
      await trx.deleteFrom('proc_order_lines').where('order_id', '=', id).execute();
      if (b.lines.length) await trx.insertInto('proc_order_lines').values(b.lines.map((l) => ({ ...l, order_id: id }))).execute();
      await this.audit.log(ctx, { action: 'UPDATE_PROC_PO', entityName: 'proc_orders', entityId: id, newData: { ...h, currency: b.cur, total_gel: b.gel, lines: b.lines.length } }, trx);
    });
    return this.get(id);
  }

  // ---------------------------------------------------------------- გაგზავნა / დამტკიცება
  async send(id: string, u: AuthUser, ctx: AuditContext) {
    const rules = await this.c.rulesPo();
    let pending = false; let poNo = '';
    await this.db.transaction().execute(async (trx) => {
      const o = await trx.selectFrom('proc_orders').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!o) throw new NotFoundException('შეკვეთა ვერ მოიძებნა');
      if (o.status !== 'draft') throw new ConflictException('გაიგზავნება მხოლოდ მონახაზი');
      await this.c.supplier(o.supplier_id, trx);
      const lines = await trx.selectFrom('proc_order_lines as l').leftJoin('proc_requisition_lines as rl', 'rl.id', 'l.requisition_line_id').leftJoin('proc_requisitions as p', 'p.id', 'rl.requisition_id')
        .select(['l.line_no', 'p.status as pr_status']).where('l.order_id', '=', id).execute();
      if (!lines.length) throw new BadRequestException('შეკვეთას ხაზი არ აქვს');
      // PR-ის გარეშე (ან დაუმტკიცებელი PR-ით) ხაზები + ზღვარს ზემოთ → ფინანსური დამტკიცება
      const direct = lines.some((l) => l.pr_status !== 'approved' && l.pr_status !== 'closed');
      const needs = direct && rules.pr_approval_levels === 2 && (rules.pr_finance_threshold === 0 || Number(o.total_gel) > rules.pr_finance_threshold);
      const self = has(u, 'admin', 'procurement_approve');
      pending = needs && !self;
      poNo = o.po_no ?? await this.c.nextNo(trx, 'PO', o.order_date);
      await trx.updateTable('proc_orders').set({ po_no: poNo, needs_approval: needs, status: pending ? 'pending' : 'sent', reason: null,
        ...(needs && !pending && { approved_by: u.id, approved_at: sql<Date>`now()` }), ...(!pending && { sent_by: u.id, sent_at: sql<Date>`now()` }) }).where('id', '=', id).execute();
      await this.audit.log(ctx, { action: pending ? 'SUBMIT_PROC_PO' : 'SEND_PROC_PO', entityName: 'proc_orders', entityId: id, newData: { po_no: poNo, needs_approval: needs, total_gel: o.total_gel } }, trx);
    });
    if (pending) await this.c.notify(await this.c.usersWith(['procurement_approve']), { kind: 'proc_po_approve', title: `შეკვეთა ${poNo} — ფინანსური დამტკიცება`,
      body: 'შეკვეთა შესყიდვის მოთხოვნის გარეშე, ზღვარს ზემოთ', entityId: id, link: `/procurement/orders?id=${id}` }, u.id);
    return this.get(id);
  }

  async approve(id: string, approve: boolean, reason: string | undefined, u: AuthUser, ctx: AuditContext) {
    await this.c.rulesPo();
    let poNo = ''; let creator = '';
    await this.db.transaction().execute(async (trx) => {
      const o = await trx.selectFrom('proc_orders').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!o) throw new NotFoundException('შეკვეთა ვერ მოიძებნა');
      if (o.status !== 'pending') throw new ConflictException('დასამტკიცებელი შეკვეთა არ არის');
      if (o.created_by === u.id && !has(u, 'admin')) throw new ForbiddenException('საკუთარ შეკვეთას ავტორი ვერ ამტკიცებს');
      if (!approve && !(reason && reason.trim().length >= 3)) throw new BadRequestException('უარის მიზეზი სავალდებულოა');
      await trx.updateTable('proc_orders').set(approve ? { status: 'sent', approved_by: u.id, approved_at: sql<Date>`now()`, sent_by: u.id, sent_at: sql<Date>`now()` }
        : { status: 'draft', reason: reason!.trim() }).where('id', '=', id).execute();
      await this.audit.log(ctx, { action: approve ? 'APPROVE_PROC_PO' : 'RETURN_PROC_PO', entityName: 'proc_orders', entityId: id, newData: { reason } }, trx);
      poNo = o.po_no!; creator = o.created_by;
    });
    await this.c.notify([creator], { kind: 'proc_po_approve', title: approve ? `შეკვეთა ${poNo} დამტკიცდა` : `შეკვეთა ${poNo} დაბრუნდა`, body: approve ? 'შეკვეთა გაგზავნილია' : reason, entityId: id, link: `/procurement/orders?id=${id}` }, u.id);
    return this.get(id);
  }

  /** გაუქმება (მონახაზი / დასამტკიცებელი / გაგზავნილი მიღების გარეშე) ან დახურვა (გაგზავნილი / ნაწილობრივ მიღებული — დარჩენილი აღარ მოვა) */
  async cancel(id: string, reason: string, close: boolean, u: AuthUser, ctx: AuditContext) {
    await this.c.rules();
    await this.db.transaction().execute(async (trx) => {
      const o = await trx.selectFrom('proc_orders').select(['status']).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!o) throw new NotFoundException('შეკვეთა ვერ მოიძებნა');
      const rc = await trx.selectFrom('stock_docs').select(sql<number>`count(*)::int`.as('n')).where('po_id', '=', id).where('doc_type', '=', 'receipt').where('status', '<>', 'cancelled').executeTakeFirstOrThrow();
      if (close) {
        if (!OPEN.includes(o.status)) throw new ConflictException('დაიხურება გაგზავნილი / ნაწილობრივ მიღებული შეკვეთა');
      } else {
        if (!['draft', 'pending', 'sent'].includes(o.status)) throw new ConflictException('გაუქმდება მონახაზი / დასამტკიცებელი / გაგზავნილი (მიღების გარეშე); ნაწილობრივ მიღებული — დახურვით');
        if (rc.n > 0) throw new ConflictException('შეკვეთაზე არის მიღების დოკუმენტი — გამოიყენეთ დახურვა (ან ჯერ გააუქმეთ / შეაბრუნეთ მიღება)');
      }
      await trx.updateTable('proc_orders').set({ status: close ? 'closed' : 'cancelled', reason: reason.trim(), closed_by: u.id, closed_at: sql<Date>`now()` }).where('id', '=', id).execute();
      await this.audit.log(ctx, { action: close ? 'CLOSE_PROC_PO' : 'CANCEL_PROC_PO', entityName: 'proc_orders', entityId: id, newData: { reason } }, trx);
    });
    return this.get(id);
  }

  // ---------------------------------------------------------------- მიღება შეკვეთიდან
  /** RC-ის მონახაზი: შეკვეთის დარჩენილი რაოდენობა, ფასი ₾-ში (კურსით); ლოტს / ვადას მესაწყობე ავსებს */
  async receipt(id: string, u: AuthUser, ctx: AuditContext) {
    await this.c.rulesPo();
    const o = await this.get(id);
    if (!OPEN.includes(o.status)) throw new ConflictException('მიღება — მხოლოდ გაგზავნილ / ნაწილობრივ მიღებულ შეკვეთაზე');
    const fx = Number(o.fx_rate);
    const lines: LineIn[] = [];
    for (const l of o.lines) {
      const rest = r3(Number(l.qty_base) - Number(l.qty_received));
      if (rest <= 0) continue;
      const per = Number(l.pack_qty_base); const inPacks = l.pack_id && Number.isInteger(r3(rest / per));
      const unitPer = inPacks ? per : 1;
      // ერთი სერიული ერთეული = ერთი ხაზი (0031); სერიულზე — rest ცალი ხაზი
      const it = await this.db.selectFrom('stock_items').select('serial_tracked').where('id', '=', l.item_id).executeTakeFirstOrThrow();
      const price = r4((Number(l.price) * fx * unitPer) / per);
      if (it.serial_tracked) for (let k = 0; k < Math.min(rest, 200); k++) lines.push({ item_id: l.item_id, qty: 1, price: r4((Number(l.price) * fx) / per), vat_rate: Number(l.vat_rate), po_line_id: l.id });
      else lines.push({ item_id: l.item_id, pack_id: inPacks ? l.pack_id : null, qty: r3(rest / unitPer), price, vat_rate: Number(l.vat_rate), po_line_id: l.id });
    }
    if (!lines.length) throw new ConflictException('შეკვეთის ყველა ხაზი მიღებულია');
    const rc = await this.docs.createReceipt({ location_id: o.location_id, supplier_id: o.supplier_id, po_id: o.id, prices_include_vat: o.prices_include_vat,
      notes: `შეკვეთა ${o.po_no}`, lines }, u, ctx);
    return rc;
  }

  /** შესყიდვების მიმოხილვა (ბეჯები): ჩემი დასამტკიცებელი PR / PO, ვადაგადაცილებული PO */
  async summary(u: AuthUser) {
    const r = await this.c.rules();
    const today = await this.c.today();
    const admin = has(u, 'admin');
    const pr = await this.db.selectFrom('proc_requisitions as p').select(sql<number>`count(*)::int`.as('n')).where('p.status', '=', 'submitted')
      .where((eb) => eb.or([
        ...(has(u, 'admin', 'stock_manager') ? [eb('p.l1_at', 'is', null)] : []),
        ...(has(u, 'admin', 'procurement_approve') ? [eb.and([eb('p.needs_finance', '=', true), eb('p.finance_at', 'is', null), eb('p.l1_at', 'is not', null), ...(admin ? [] : [eb('p.l1_by', '<>', u.id)])])] : []),
        ...(has(u, 'admin', 'pharmacist') ? [eb.and([eb('p.needs_pharmacist', '=', true), eb('p.pharm_at', 'is', null)])] : []),
        eb(sql`false`, '=', true)]))
      .$if(!admin, (q) => q.where('p.created_by', '<>', u.id)).executeTakeFirstOrThrow();
    const po = has(u, 'admin', 'procurement_approve') ? (await this.db.selectFrom('proc_orders').select(sql<number>`count(*)::int`.as('n')).where('status', '=', 'pending')
      .$if(!admin, (q) => q.where('created_by', '<>', u.id)).executeTakeFirstOrThrow()).n : 0;
    const overdue = (await this.db.selectFrom('proc_orders').select(sql<number>`count(*)::int`.as('n')).where('status', 'in', OPEN).where('expected_date', '<', today).executeTakeFirstOrThrow()).n;
    const approvedOpen = (await this.db.selectFrom('proc_requisitions as p').select(sql<number>`count(*)::int`.as('n')).where('p.status', '=', 'approved')
      .where(sql<boolean>`EXISTS (SELECT 1 FROM proc_requisition_lines l WHERE l.requisition_id = p.id AND coalesce((SELECT sum(CASE WHEN o.status = 'closed' THEN ol.qty_received ELSE ol.qty_base END)
        FROM proc_order_lines ol JOIN proc_orders o ON o.id = ol.order_id WHERE ol.requisition_line_id = l.id AND o.status <> 'cancelled'), 0) < l.qty_base)`, '=', true).executeTakeFirstOrThrow()).n;
    return { pr_to_approve: pr.n, po_to_approve: po, po_overdue: overdue, pr_to_order: approvedOpen, rules: r };
  }
}

// ======================================================================= ფასთა ნუსხა
export interface PriceIn { supplier_id: string; item_id: string; pack_id?: string | null; price: number; vat_rate?: number; min_qty?: number | null; valid_from: string; valid_to?: string | null; contract_no?: string | null; notes?: string | null; is_active?: boolean }

@Injectable()
export class ProcPricesService {
  constructor(private readonly c: ProcCommon, private readonly audit: AuditService) {}
  private get db() { return this.c.db; }

  async list(q: { supplier_id?: string; item_id?: string; search?: string; current?: boolean; all?: boolean }) {
    await this.c.rules();
    const today = await this.c.today();
    let x = this.db.selectFrom('proc_supplier_prices as p').innerJoin('stock_suppliers as s', 's.id', 'p.supplier_id').innerJoin('stock_items as i', 'i.id', 'p.item_id')
      .innerJoin('stock_units as un', 'un.code', 'i.base_unit').leftJoin('stock_item_packs as k', 'k.id', 'p.pack_id')
      .selectAll('p').select(['s.name as supplier_name', 'i.name as item_name', 'i.code as item_code', 'un.name as base_unit_name', 'k.name as pack_name', sql<string>`coalesce(k.qty_base, 1)`.as('pack_qty_base'),
        sql<boolean>`p.is_active AND p.valid_from <= ${today}::date AND (p.valid_to IS NULL OR p.valid_to >= ${today}::date)`.as('current')])
      .orderBy('i.name').orderBy('s.name').orderBy('p.valid_from', 'desc').limit(2000);
    if (!q.all) x = x.where('p.is_active', '=', true);
    if (q.supplier_id) x = x.where('p.supplier_id', '=', q.supplier_id);
    if (q.item_id) x = x.where('p.item_id', '=', q.item_id);
    if (q.current) x = x.where('p.valid_from', '<=', today).where((eb) => eb.or([eb('p.valid_to', 'is', null), eb('p.valid_to', '>=', today)]));
    const s = q.search?.trim();
    if (s) x = x.where((eb) => eb.or([eb(sql`lower(i.name)`, 'like', `%${s.toLowerCase()}%`), eb(sql`lower(i.code)`, 'like', `%${s.toLowerCase()}%`), eb(sql`lower(s.name)`, 'like', `%${s.toLowerCase()}%`)]));
    return x.execute();
  }

  private readonly msg = { proc_prices_no_overlap: 'ამ მომწოდებელს ამ საქონელზე (ერთეულზე) ამ პერიოდში უკვე აქვს აქტიური ფასი — დაასრულეთ ძველის ვადა', proc_prices_period: 'ვადის დასასრული დაწყებამდეა' };
  private mapErr(e: unknown): never {
    const err = e as { constraint?: string; code?: string };
    if (err.constraint && err.constraint in this.msg) throw (err.code === '23P01' ? new ConflictException(this.msg[err.constraint as keyof typeof this.msg]) : new BadRequestException(this.msg[err.constraint as keyof typeof this.msg]));
    throw e;
  }

  async save(id: string | null, dto: PriceIn, u: AuthUser, ctx: AuditContext) {
    await this.c.rules();
    await this.c.supplier(dto.supplier_id);
    await this.c.qtyLines(this.db, [{ item_id: dto.item_id, pack_id: dto.pack_id ?? null, qty: 1 }]);
    const vals = { supplier_id: dto.supplier_id, item_id: dto.item_id, pack_id: dto.pack_id ?? null, price: String(r4(dto.price)), vat_rate: String(dto.vat_rate ?? 18), min_qty: dto.min_qty == null ? null : String(dto.min_qty),
      valid_from: dto.valid_from, valid_to: dto.valid_to || null, contract_no: dto.contract_no?.trim() || null, notes: dto.notes?.trim() || null, is_active: dto.is_active ?? true };
    try {
      const r = id ? await this.db.updateTable('proc_supplier_prices').set(vals).where('id', '=', id).returning('id').executeTakeFirst()
        : await this.db.insertInto('proc_supplier_prices').values({ ...vals, created_by: u.id }).returning('id').executeTakeFirst();
      if (!r) throw new NotFoundException('ფასი ვერ მოიძებნა');
      await this.audit.log(ctx, { action: id ? 'UPDATE_PROC_PRICE' : 'CREATE_PROC_PRICE', entityName: 'proc_supplier_prices', entityId: r.id, newData: vals });
      return r;
    } catch (e) { this.mapErr(e); }
  }
}

// ======================================================================= DTO
class PoLineDto {
  @IsUUID() item_id: string; @IsOptional() @IsUUID() pack_id?: string | null; @IsNumber() @Min(0.001) @Max(10_000_000) qty: number;
  @IsNumber() @Min(0) @Max(100_000_000) price: number; @IsOptional() @IsIn([0, 18]) vat_rate?: number;
  @IsOptional() @IsUUID() requisition_line_id?: string | null; @IsOptional() @IsString() @MaxLength(500) notes?: string | null;
}
class PoDto {
  @IsUUID() supplier_id: string; @IsUUID() location_id: string; @IsOptional() @IsISO8601({ strict: true }) order_date?: string; @IsOptional() @IsISO8601({ strict: true }) expected_date?: string | null;
  @IsOptional() @IsIn(['GEL', 'USD', 'EUR']) currency?: 'GEL' | 'USD' | 'EUR'; @IsOptional() @IsNumber() @Min(0.000001) @Max(10_000) fx_rate?: number;
  @IsOptional() @IsBoolean() prices_include_vat?: boolean; @IsOptional() @IsString() @MaxLength(60) contract_no?: string | null; @IsOptional() @IsString() @MaxLength(2000) notes?: string | null;
  @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => PoLineDto) lines: PoLineDto[];
}
class ReasonDto { @IsString() @Length(3, 500) reason: string }
class OptReasonDto { @IsOptional() @IsString() @MaxLength(500) reason?: string }
class PriceDto {
  @IsUUID() supplier_id: string; @IsUUID() item_id: string; @IsOptional() @IsUUID() pack_id?: string | null; @IsNumber() @Min(0) @Max(100_000_000) price: number;
  @IsOptional() @IsIn([0, 18]) vat_rate?: number; @IsOptional() @IsNumber() @Min(0.001) min_qty?: number | null; @IsISO8601({ strict: true }) valid_from: string;
  @IsOptional() @IsISO8601({ strict: true }) valid_to?: string | null; @IsOptional() @IsString() @MaxLength(60) contract_no?: string | null; @IsOptional() @IsString() @MaxLength(500) notes?: string | null;
  @IsOptional() @IsBoolean() is_active?: boolean;
}
const uuidOk = (v?: string) => !v || /^[0-9a-f-]{36}$/i.test(v);
const PO_STATUSES = ['draft', 'pending', 'sent', 'partial', 'received', 'closed', 'cancelled'];

@Controller('procurement')
export class ProcOrdersController {
  constructor(private readonly s: ProcOrdersService, private readonly prices: ProcPricesService, private readonly c: ProcCommon) {}
  @Get('summary') @Roles(...PROC_READ, 'storekeeper') summary(@CurrentUser() u: AuthUser) { return this.s.summary(u); }
  @Get('orders') @Roles(...PROC_READ) list(@Query() q: { status?: string; supplier_id?: string; location_id?: string; search?: string; overdue?: string }) {
    if (!uuidOk(q.supplier_id) || !uuidOk(q.location_id)) throw new BadRequestException('არასწორი ფილტრი');
    if (q.status && q.status.split(',').some((x) => !PO_STATUSES.includes(x))) throw new BadRequestException('უცნობი სტატუსი');
    return this.s.list({ ...q, overdue: q.overdue === 'true' });
  }
  @Get('orders/:id') @Roles(...PROC_READ) async one(@Param('id', ParseUUIDPipe) id: string) { await this.c.rules(); return this.s.get(id); }
  @Post('orders') @Roles(...PO_EDIT) create(@Body() d: PoDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.create(d, u, auditCtx(r)); }
  @Put('orders/:id') @Roles(...PO_EDIT) update(@Param('id', ParseUUIDPipe) id: string, @Body() d: PoDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.update(id, d, u, auditCtx(r)); }
  @Post('orders/:id/send') @HttpCode(200) @Roles(...PO_EDIT) send(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.send(id, u, auditCtx(r)); }
  @Post('orders/:id/approve') @HttpCode(200) @Roles('admin', 'procurement_approve') approve(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.approve(id, true, undefined, u, auditCtx(r)); }
  @Post('orders/:id/return') @HttpCode(200) @Roles('admin', 'procurement_approve') ret(@Param('id', ParseUUIDPipe) id: string, @Body() d: OptReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.approve(id, false, d.reason, u, auditCtx(r)); }
  @Post('orders/:id/cancel') @HttpCode(200) @Roles(...PO_EDIT) cancel(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.cancel(id, d.reason, false, u, auditCtx(r)); }
  @Post('orders/:id/close') @HttpCode(200) @Roles(...PO_EDIT) close(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.cancel(id, d.reason, true, u, auditCtx(r)); }
  @Post('orders/:id/receipt') @HttpCode(200) @Roles(...RECEIPT_EDIT) receipt(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.receipt(id, u, auditCtx(r)); }

  @Get('prices') @Roles(...PROC_READ) priceList(@Query() q: { supplier_id?: string; item_id?: string; search?: string; current?: string; all?: string }) {
    if (!uuidOk(q.supplier_id) || !uuidOk(q.item_id)) throw new BadRequestException('არასწორი ფილტრი');
    return this.prices.list({ ...q, current: q.current === 'true', all: q.all === 'true' });
  }
  @Post('prices') @Roles(...PO_EDIT) createPrice(@Body() d: PriceDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.prices.save(null, d, u, auditCtx(r)); }
  @Put('prices/:id') @Roles(...PO_EDIT) updatePrice(@Param('id', ParseUUIDPipe) id: string, @Body() d: PriceDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.prices.save(id, d, u, auditCtx(r)); }
  @Get('price-hints') @Roles(...PROC_READ, 'storekeeper') async hints(@Query('item_id') item?: string, @Query('supplier_id') sup?: string) {
    if (!item || !uuidOk(item) || !uuidOk(sup)) throw new BadRequestException('item_id სავალდებულოა');
    await this.c.rules();
    return this.c.hints(item, sup || null);
  }
}
