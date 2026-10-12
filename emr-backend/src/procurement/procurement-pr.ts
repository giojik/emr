import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsISO8601, IsNumber, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser } from '../auth/roles';
import { StockAlertsService } from '../stock/stock-alerts';
import { addDays, ProcCommon, r2, r3, r4, type Ex, type Trx, userName } from './procurement-common';
import { PO_EDIT, PR_APPROVE, PR_EDIT, PROC_CONTROLLED, PROC_READ } from './procurement-rules';

export interface PrLineIn { item_id?: string | null; free_name?: string | null; pack_id?: string | null; qty: number; est_price?: number | null; supplier_id?: string | null; notes?: string | null; request_line_id?: string | null }
export interface PrIn { location_id: string; urgent?: boolean; needed_by?: string | null; notes?: string | null; lines: PrLineIn[] }
type Step = 'l1' | 'finance' | 'pharmacist';
const STEP_KA: Record<Step, string> = { l1: 'საწყობის მენეჯერი', finance: 'ფინანსური', pharmacist: 'ფარმაცევტი' };

/**
 * შესყიდვის მოთხოვნა (PR, 0051): მონახაზი → გაგზავნა (PR-ნომერი, დამტკიცების გზა) → დამტკიცება (1–3 ნაბიჯი) → PO(-ები) მომწოდებლის მიხედვით.
 * შეკვეთილი რაოდენობა — PO-ს ხაზებიდან (გაუქმებული PO არ ითვლება; დახურულში — მხოლოდ მიღებული).
 */
@Injectable()
export class ProcRequisitionsService {
  constructor(private readonly c: ProcCommon, private readonly audit: AuditService, private readonly alerts: StockAlertsService) {}
  private get db() { return this.c.db; }
  /** მოდული ჩართულია (ნახვისთვისაც) */
  async ready() { await this.c.rules(); }

  /** ხაზზე შეკვეთილი (PO-ებში) რაოდენობა საბაზოში */
  static orderedSql = sql<string>`coalesce((SELECT sum(CASE WHEN o.status = 'closed' THEN ol.qty_received ELSE ol.qty_base END) FROM proc_order_lines ol
    JOIN proc_orders o ON o.id = ol.order_id WHERE ol.requisition_line_id = l.id AND o.status <> 'cancelled'), 0)`;

  // ---------------------------------------------------------------- სია / ნახვა
  async list(u: AuthUser, q: { status?: string; location_id?: string; search?: string; mine?: boolean; to_approve?: boolean }) {
    await this.c.rules();
    let x = this.db.selectFrom('proc_requisitions as p').innerJoin('stock_locations as lc', 'lc.id', 'p.location_id').innerJoin('users as u', 'u.id', 'p.created_by')
      .select(['p.id', 'p.pr_no', 'p.status', 'p.source', 'p.urgent', 'p.needed_by', 'p.est_total', 'p.created_at', 'p.submitted_at', 'p.created_by', 'p.needs_finance', 'p.needs_pharmacist',
        'p.l1_at', 'p.finance_at', 'p.pharm_at', 'p.location_id', 'lc.name as location_name', userName('u').as('created_by_name'),
        sql<number>`(SELECT count(*)::int FROM proc_requisition_lines l WHERE l.requisition_id = p.id)`.as('lines'),
        sql<number>`(SELECT count(*)::int FROM proc_requisition_lines l WHERE l.requisition_id = p.id AND ${ProcRequisitionsService.orderedSql} >= l.qty_base)`.as('lines_ordered')])
      .orderBy('p.created_at', 'desc').limit(500);
    if (q.status) x = x.where('p.status', 'in', q.status.split(','));
    if (q.location_id) x = x.where('p.location_id', '=', q.location_id);
    if (q.mine) x = x.where('p.created_by', '=', u.id);
    if (q.to_approve) {
      x = x.where('p.status', '=', 'submitted').where((eb) => eb.or([
        ...(has(u, 'admin', 'stock_manager') ? [eb('p.l1_at', 'is', null)] : []),
        ...(has(u, 'admin', 'procurement_approve') ? [eb.and([eb('p.needs_finance', '=', true), eb('p.finance_at', 'is', null), eb('p.l1_at', 'is not', null)])] : []),
        ...(has(u, 'admin', 'pharmacist') ? [eb.and([eb('p.needs_pharmacist', '=', true), eb('p.pharm_at', 'is', null)])] : []),
        eb(sql`false`, '=', true)]));
      if (!has(u, 'admin')) x = x.where('p.created_by', '<>', u.id);
    }
    const s = q.search?.trim();
    if (s) x = x.where((eb) => eb.or([eb(sql`upper(coalesce(p.pr_no, ''))`, 'like', `%${s.toUpperCase()}%`),
      eb(sql<boolean>`EXISTS (SELECT 1 FROM proc_requisition_lines l LEFT JOIN stock_items i ON i.id = l.item_id WHERE l.requisition_id = p.id
        AND lower(coalesce(i.name, l.free_name)) LIKE ${`%${s.toLowerCase()}%`})`, '=', true)]));
    return x.execute();
  }

  async get(id: string, ex: Ex = this.db) {
    const p = await ex.selectFrom('proc_requisitions as p').innerJoin('stock_locations as lc', 'lc.id', 'p.location_id').innerJoin('users as u', 'u.id', 'p.created_by')
      .leftJoin('users as u1', 'u1.id', 'p.l1_by').leftJoin('users as uf', 'uf.id', 'p.finance_by').leftJoin('users as up', 'up.id', 'p.pharm_by').leftJoin('users as ur', 'ur.id', 'p.rejected_by')
      .leftJoin('stock_requests as rq', 'rq.id', 'p.request_id')
      .selectAll('p').select(['lc.name as location_name', 'lc.kind as location_kind', 'rq.req_no', userName('u').as('created_by_name'), userName('u1').as('l1_by_name'),
        userName('uf').as('finance_by_name'), userName('up').as('pharm_by_name'), userName('ur').as('rejected_by_name')])
      .where('p.id', '=', id).executeTakeFirst();
    if (!p) throw new NotFoundException('შესყიდვის მოთხოვნა ვერ მოიძებნა');
    const lines = await ex.selectFrom('proc_requisition_lines as l').leftJoin('stock_items as i', 'i.id', 'l.item_id').leftJoin('stock_units as un', 'un.code', 'i.base_unit')
      .leftJoin('stock_item_packs as k', 'k.id', 'l.pack_id').leftJoin('stock_suppliers as s', 's.id', 'l.supplier_id').leftJoin('med_generics as g', 'g.id', 'i.generic_id')
      .selectAll('l').select(['i.name as item_name', 'i.code as item_code', 'un.name as base_unit_name', 'k.name as pack_name', 's.name as supplier_name', 'g.controlled_class',
        ProcRequisitionsService.orderedSql.as('qty_ordered')])
      .where('l.requisition_id', '=', id).orderBy('l.line_no').execute();
    const orders = await ex.selectFrom('proc_orders as o').innerJoin('stock_suppliers as s', 's.id', 'o.supplier_id')
      .select(['o.id', 'o.po_no', 'o.status', 'o.order_date', 's.name as supplier_name', 'o.total_gel'])
      .where(sql<boolean>`EXISTS (SELECT 1 FROM proc_order_lines ol JOIN proc_requisition_lines l ON l.id = ol.requisition_line_id WHERE ol.order_id = o.id AND l.requisition_id = ${id})`, '=', true)
      .orderBy('o.created_at').execute();
    return { ...p, lines, orders, pending: this.pending(p) };
  }
  private pending(p: { status: string; l1_at: unknown; needs_finance: boolean; finance_at: unknown; needs_pharmacist: boolean; pharm_at: unknown }): Step[] {
    if (p.status !== 'submitted') return [];
    const out: Step[] = [];
    if (!p.l1_at) out.push('l1');
    if (p.needs_finance && !p.finance_at) out.push('finance');
    if (p.needs_pharmacist && !p.pharm_at) out.push('pharmacist');
    return out;
  }

  // ---------------------------------------------------------------- მონახაზი
  private async buildLines(trx: Ex, lines: PrLineIn[]) {
    const cat = lines.filter((l) => l.item_id);
    const built = await this.c.qtyLines(trx, cat.map((l) => ({ item_id: l.item_id!, pack_id: l.pack_id ?? null, qty: l.qty })));
    const sups = [...new Set(lines.map((l) => l.supplier_id).filter((s): s is string => !!s))];
    if (sups.length) {
      const n = (await trx.selectFrom('stock_suppliers').select(sql<number>`count(*)::int`.as('n')).where('id', 'in', sups).executeTakeFirstOrThrow()).n;
      if (n !== sups.length) throw new BadRequestException('მომწოდებელი ვერ მოიძებნა');
    }
    let k = 0;
    return lines.map((l, i) => {
      if (!l.item_id && (l.free_name ?? '').trim().length < 2) throw new BadRequestException(`ხაზი ${i + 1}: აირჩიეთ საქონელი ან ჩაწერეთ დასახელება`);
      const b = l.item_id ? built[k++] : null;
      return {
        line_no: i + 1, item_id: l.item_id ?? null, free_name: l.item_id ? null : l.free_name!.trim(), pack_id: b?.pack_id ?? null, pack_qty_base: String(b?.per ?? 1),
        qty: String(l.qty), qty_base: String(b?.qty_base ?? r3(l.qty)), est_price: l.est_price === undefined || l.est_price === null ? null : String(r4(l.est_price)),
        supplier_id: l.supplier_id ?? null, notes: l.notes?.trim() || null, request_line_id: l.request_line_id ?? null,
      };
    });
  }
  private header(dto: PrIn) {
    return { location_id: dto.location_id, urgent: !!dto.urgent, needed_by: dto.needed_by || null, notes: dto.notes?.trim() || null };
  }
  private estTotal(lines: { qty: string; est_price: string | null }[]) { return r2(lines.reduce((a, l) => a + Number(l.qty) * Number(l.est_price ?? 0), 0)); }

  async create(dto: PrIn, u: AuthUser, ctx: AuditContext, extra: { source?: 'manual' | 'minmax' | 'request'; request_id?: string | null } = {}) {
    await this.c.rules();
    await this.c.location(u, dto.location_id);
    const id = await this.db.transaction().execute(async (trx) => {
      const lines = await this.buildLines(trx, dto.lines);
      const p = await trx.insertInto('proc_requisitions').values({ ...this.header(dto), source: extra.source ?? 'manual', request_id: extra.request_id ?? null, est_total: String(this.estTotal(lines)), created_by: u.id })
        .returning('id').executeTakeFirstOrThrow();
      if (lines.length) await trx.insertInto('proc_requisition_lines').values(lines.map((l) => ({ ...l, requisition_id: p.id }))).execute();
      await this.audit.log(ctx, { action: 'CREATE_PROC_PR', entityName: 'proc_requisitions', entityId: p.id, newData: { ...this.header(dto), source: extra.source ?? 'manual', lines: lines.length } }, trx);
      return p.id;
    });
    return this.get(id);
  }

  private async lockOwn(trx: Trx, id: string, u: AuthUser) {
    const p = await trx.selectFrom('proc_requisitions').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!p) throw new NotFoundException('შესყიდვის მოთხოვნა ვერ მოიძებნა');
    if (p.created_by !== u.id && !has(u, 'admin', 'procurement', 'stock_manager')) throw new ForbiddenException('სხვისი მოთხოვნა — მხოლოდ საწყობის მენეჯერი / შესყიდვები / admin');
    return p;
  }

  async update(id: string, dto: PrIn, u: AuthUser, ctx: AuditContext) {
    await this.c.rules();
    await this.c.location(u, dto.location_id);
    await this.db.transaction().execute(async (trx) => {
      const p = await this.lockOwn(trx, id, u);
      if (p.status !== 'draft') throw new ConflictException('მხოლოდ მონახაზი იცვლება');
      const lines = await this.buildLines(trx, dto.lines);
      // წყაროს ბმა (RQ ხაზი) — ხაზის ხელახლა ჩაწერისას იკარგება მხოლოდ მაშინ, თუ კლიენტმა არ დააბრუნა
      await trx.updateTable('proc_requisitions').set({ ...this.header(dto), est_total: String(this.estTotal(lines)) }).where('id', '=', id).execute();
      await trx.deleteFrom('proc_requisition_lines').where('requisition_id', '=', id).execute();
      if (lines.length) await trx.insertInto('proc_requisition_lines').values(lines.map((l) => ({ ...l, requisition_id: id }))).execute();
      await this.audit.log(ctx, { action: 'UPDATE_PROC_PR', entityName: 'proc_requisitions', entityId: id, newData: { ...this.header(dto), lines: lines.length } }, trx);
    });
    return this.get(id);
  }

  // ---------------------------------------------------------------- გაგზავნა / დამტკიცება
  async submit(id: string, u: AuthUser, ctx: AuditContext) {
    const rules = await this.c.rules();
    let notifyIds: { l1: string[]; ph: string[] } = { l1: [], ph: [] };
    let prNo = '';
    await this.db.transaction().execute(async (trx) => {
      const p = await this.lockOwn(trx, id, u);
      if (p.status !== 'draft') throw new ConflictException('გაიგზავნება მხოლოდ მონახაზი');
      const lines = await trx.selectFrom('proc_requisition_lines as l').leftJoin('stock_items as i', 'i.id', 'l.item_id').leftJoin('med_generics as g', 'g.id', 'i.generic_id')
        .select(['l.line_no', 'l.qty', 'l.est_price', 'l.item_id', 'i.is_active', 'i.name', 'g.controlled_class']).where('l.requisition_id', '=', id).orderBy('l.line_no').execute();
      if (!lines.length) throw new BadRequestException('მოთხოვნას ხაზი არ აქვს');
      const noPrice = lines.filter((l) => l.est_price === null).map((l) => l.line_no);
      if (noPrice.length) throw new BadRequestException(`სავარაუდო ფასი სავალდებულოა (დამტკიცების ზღვრისთვის) — ხაზი: ${noPrice.join(', ')}`);
      const off = lines.filter((l) => l.item_id && !l.is_active).map((l) => l.name);
      if (off.length) throw new BadRequestException(`საქონელი გათიშულია: ${off.join(', ')}`);
      const total = this.estTotal(lines);
      const needsFinance = rules.pr_approval_levels === 2 && (rules.pr_finance_threshold === 0 || total > rules.pr_finance_threshold);
      const needsPharm = rules.controlled_pharmacist && lines.some((l) => l.controlled_class && PROC_CONTROLLED.includes(l.controlled_class));
      const today = await this.c.today(trx);
      prNo = await this.c.nextNo(trx, 'PR', today);
      await trx.updateTable('proc_requisitions').set({ status: 'submitted', pr_no: prNo, est_total: String(total), needs_finance: needsFinance, needs_pharmacist: needsPharm, submitted_at: sql`now()` })
        .where('id', '=', id).execute();
      await this.audit.log(ctx, { action: 'SUBMIT_PROC_PR', entityName: 'proc_requisitions', entityId: id, newData: { pr_no: prNo, est_total: total, needs_finance: needsFinance, needs_pharmacist: needsPharm } }, trx);
      notifyIds = { l1: await this.c.usersWith(['stock_manager'], trx), ph: needsPharm ? await this.c.usersWith(['pharmacist'], trx) : [] };
    });
    const link = `/procurement/requisitions?id=${id}`;
    await this.c.notify(notifyIds.l1, { kind: 'proc_pr_approve', title: `შესყიდვის მოთხოვნა ${prNo} — დასამტკიცებელი`, body: 'დონე 1: საწყობის მენეჯერი', entityId: id, link }, u.id);
    await this.c.notify(notifyIds.ph, { kind: 'proc_pr_approve', title: `შესყიდვის მოთხოვნა ${prNo} — კონტროლირებადი საქონელი`, body: 'საჭიროა ფარმაცევტის დადასტურება', entityId: id, link }, u.id);
    return this.get(id);
  }

  /** რომელი ნაბიჯის ხელმოწერა შეუძლია მომხმარებელს (რიგით: დონე 1 → ფინანსური → ფარმაცევტი) */
  private eligible(p: { created_by: string; l1_by: string | null; l1_at: unknown; needs_finance: boolean; finance_at: unknown; needs_pharmacist: boolean; pharm_at: unknown; status: string }, u: AuthUser): Step[] {
    const admin = has(u, 'admin'); const own = p.created_by === u.id && !admin;
    if (own) return [];
    return this.pending(p).filter((s) => (s === 'l1' ? has(u, 'admin', 'stock_manager')
      : s === 'finance' ? !!p.l1_at && has(u, 'admin', 'procurement_approve') && (admin || p.l1_by !== u.id)
        : has(u, 'admin', 'pharmacist')));
  }

  async approve(id: string, step: Step | undefined, u: AuthUser, ctx: AuditContext) {
    await this.c.rules();
    let done: Step = 'l1'; let approved = false; let prNo = ''; let creator = ''; let next: string[] = [];
    await this.db.transaction().execute(async (trx) => {
      const p = await trx.selectFrom('proc_requisitions').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!p) throw new NotFoundException('შესყიდვის მოთხოვნა ვერ მოიძებნა');
      if (p.status !== 'submitted') throw new ConflictException('დამტკიცდება მხოლოდ გაგზავნილი მოთხოვნა');
      if (p.created_by === u.id && !has(u, 'admin')) throw new ForbiddenException('საკუთარ მოთხოვნას ავტორი ვერ ამტკიცებს');
      const can = this.eligible(p, u);
      if (step && !can.includes(step)) throw new ForbiddenException(step === 'finance' && !p.l1_at ? 'ფინანსური დამტკიცება — დონე 1-ის შემდეგ' : `ნაბიჯი „${STEP_KA[step]}“ თქვენთვის ხელმისაწვდომი არ არის`);
      if (!can.length) {
        const pend = this.pending(p);
        throw new ForbiddenException(pend.includes('finance') && !p.l1_at && has(u, 'procurement_approve') ? 'ფინანსური დამტკიცება — დონე 1-ის შემდეგ'
          : pend.includes('finance') && p.l1_by === u.id ? 'დონე 1 და ფინანსური დამტკიცება სხვადასხვა პირმა უნდა გააკეთოს' : 'ამ მოთხოვნის დამტკიცება თქვენ არ შეგიძლიათ');
      }
      done = step ?? can[0];
      const set = done === 'l1' ? { l1_by: u.id, l1_at: sql<Date>`now()` } : done === 'finance' ? { finance_by: u.id, finance_at: sql<Date>`now()` } : { pharm_by: u.id, pharm_at: sql<Date>`now()` };
      const after = { ...p, ...(done === 'l1' ? { l1_at: 1, l1_by: u.id } : done === 'finance' ? { finance_at: 1 } : { pharm_at: 1 }) };
      approved = this.pending(after).length === 0;
      await trx.updateTable('proc_requisitions').set({ ...set, ...(approved && { status: 'approved' }) }).where('id', '=', id).execute();
      await this.audit.log(ctx, { action: 'APPROVE_PROC_PR', entityName: 'proc_requisitions', entityId: id, newData: { step: done, approved } }, trx);
      prNo = p.pr_no!; creator = p.created_by;
      if (approved) next = [creator, ...(await this.c.usersWith(['procurement'], trx))];
      else if (done === 'l1' && p.needs_finance && !p.finance_at) next = await this.c.usersWith(['procurement_approve'], trx);
    });
    const link = `/procurement/requisitions?id=${id}`;
    if (approved) await this.c.notify(next, { kind: 'proc_pr_done', title: `შესყიდვის მოთხოვნა ${prNo} დამტკიცდა`, body: 'შეკვეთის (PO) მომზადება', entityId: id, link }, u.id);
    else if (next.length) await this.c.notify(next, { kind: 'proc_pr_approve', title: `შესყიდვის მოთხოვნა ${prNo} — დასამტკიცებელი`, body: 'დონე 2: ფინანსური დამტკიცება', entityId: id, link }, u.id);
    return this.get(id);
  }

  async reject(id: string, reason: string, u: AuthUser, ctx: AuditContext) {
    await this.c.rules();
    let prNo = ''; let creator = '';
    await this.db.transaction().execute(async (trx) => {
      const p = await trx.selectFrom('proc_requisitions').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!p) throw new NotFoundException('შესყიდვის მოთხოვნა ვერ მოიძებნა');
      if (p.status !== 'submitted') throw new ConflictException('უარი — მხოლოდ გაგზავნილ მოთხოვნაზე');
      if (!this.eligible(p, u).length) throw new ForbiddenException('ამ მოთხოვნის დამტკიცება / უარყოფა თქვენ არ შეგიძლიათ');
      await trx.updateTable('proc_requisitions').set({ status: 'rejected', rejected_by: u.id, rejected_at: sql`now()`, reason: reason.trim() }).where('id', '=', id).execute();
      await this.audit.log(ctx, { action: 'REJECT_PROC_PR', entityName: 'proc_requisitions', entityId: id, newData: { reason } }, trx);
      prNo = p.pr_no!; creator = p.created_by;
    });
    await this.c.notify([creator], { kind: 'proc_pr_done', title: `შესყიდვის მოთხოვნა ${prNo} — უარყოფილია`, body: reason, entityId: id, link: `/procurement/requisitions?id=${id}` }, u.id);
    return this.get(id);
  }

  /** გაუქმება (მონახაზი / გაგზავნილი — ავტორი ან შესყიდვები) ან დახურვა (დამტკიცებული — დარჩენილი აღარ შეუკვეთდება) */
  async cancel(id: string, reason: string, close: boolean, u: AuthUser, ctx: AuditContext) {
    await this.c.rules();
    await this.db.transaction().execute(async (trx) => {
      const p = await this.lockOwn(trx, id, u);
      if (close) {
        if (!has(u, ...PO_EDIT)) throw new ForbiddenException('დახურვა — შესყიდვები / საწყობის მენეჯერი');
        if (p.status !== 'approved') throw new ConflictException('დაიხურება მხოლოდ დამტკიცებული მოთხოვნა');
      } else if (!['draft', 'submitted'].includes(p.status)) throw new ConflictException('გაუქმდება მონახაზი ან გაგზავნილი (დამტკიცებული — დახურვით)');
      await trx.updateTable('proc_requisitions').set({ status: close ? 'closed' : 'cancelled', reason: reason.trim(), ...(close && { closed_at: sql<Date>`now()` }) }).where('id', '=', id).execute();
      await this.audit.log(ctx, { action: close ? 'CLOSE_PROC_PR' : 'CANCEL_PROC_PR', entityName: 'proc_requisitions', entityId: id, newData: { reason } }, trx);
    });
    return this.get(id);
  }

  /** გაგზავნილ / დამტკიცებულ ხაზზე: მომწოდებელი, სავარაუდო ფასი, „თავისუფალი ხაზის“ მიბმა კატალოგზე (რაოდენობა — საბაზო ერთეულში) */
  async patchLine(id: string, lineId: string, dto: { supplier_id?: string | null; est_price?: number | null; item_id?: string }, u: AuthUser, ctx: AuditContext) {
    await this.c.rules();
    await this.db.transaction().execute(async (trx) => {
      const p = await trx.selectFrom('proc_requisitions').select(['status']).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!p) throw new NotFoundException('შესყიდვის მოთხოვნა ვერ მოიძებნა');
      if (!['submitted', 'approved'].includes(p.status)) throw new ConflictException('ხაზის მომზადება — გაგზავნილ / დამტკიცებულ მოთხოვნაზე (მონახაზი — რედაქტირებით)');
      const l = await trx.selectFrom('proc_requisition_lines').selectAll().where('id', '=', lineId).where('requisition_id', '=', id).executeTakeFirst();
      if (!l) throw new NotFoundException('ხაზი ვერ მოიძებნა');
      const set: Record<string, unknown> = {};
      if (dto.supplier_id !== undefined) { if (dto.supplier_id) await this.c.supplier(dto.supplier_id, trx); set.supplier_id = dto.supplier_id; }
      if (dto.est_price !== undefined) set.est_price = dto.est_price === null ? null : String(r4(dto.est_price));
      if (dto.item_id) {
        if (l.item_id) throw new ConflictException('ხაზი უკვე კატალოგის საქონელია');
        await this.c.qtyLines(trx, [{ item_id: dto.item_id, qty: 1 }]);
        set.item_id = dto.item_id;
      }
      if (!Object.keys(set).length) return;
      await trx.updateTable('proc_requisition_lines').set(set).where('id', '=', lineId).execute();
      await this.audit.log(ctx, { action: 'UPDATE_PROC_PR_LINE', entityName: 'proc_requisitions', entityId: id, newData: { line_id: lineId, ...dto } }, trx);
    });
    return this.get(id);
  }

  // ---------------------------------------------------------------- წყაროები: მინ/მაქს, განყოფილების მოთხოვნა
  /** მინიმუმზე ქვემოთ → PR მაქსიმუმამდე (საბაზო ერთეულში); ფასი / მომწოდებელი — ფასთა ნუსხიდან ან ბოლო მიღებიდან */
  async fromMinmax(locationId: string, u: AuthUser, ctx: AuditContext) {
    await this.c.rules();
    await this.c.location(u, locationId);
    const below = (await this.alerts.belowMin(locationId)).filter((b) => b.suggested > 0);
    if (!below.length) throw new ConflictException('მინიმუმზე ქვემოთ არაფერია (შეკვეთილის და დამტკიცების პროცესში მყოფის გათვალისწინებით)');
    const lines: PrLineIn[] = [];
    for (const b of below) {
      const bp = await this.c.bestPrice(b.item_id, null);
      lines.push({ item_id: b.item_id, qty: b.suggested, est_price: bp.base_price === null ? null : r4(bp.base_price), supplier_id: bp.supplier_id ?? null });
    }
    return this.create({ location_id: locationId, notes: 'მინ/მაქს — მინიმუმზე ქვემოთ', lines }, u, ctx, { source: 'minmax' });
  }

  /** განყოფილების მოთხოვნის (RQ) გაუცემელი ნაწილი, რომელსაც გამცემის მარაგი ვერ ფარავს → PR გამცემ ლოკაციაზე */
  async fromRequest(requestId: string, u: AuthUser, ctx: AuditContext) {
    await this.c.rules();
    const r = await this.db.selectFrom('stock_requests').select(['id', 'req_no', 'status', 'from_location_id']).where('id', '=', requestId).executeTakeFirst();
    if (!r) throw new NotFoundException('მოთხოვნა ვერ მოიძებნა');
    if (!['submitted', 'approved', 'partial'].includes(r.status)) throw new ConflictException('შესყიდვაზე გადაეცემა გაგზავნილი / დამტკიცებული / ნაწილობრივ გაცემული მოთხოვნა');
    await this.c.location(u, r.from_location_id);
    const today = await this.c.today();
    const rows = await this.db.selectFrom('stock_request_lines as l').select(['l.id', 'l.item_id', 'l.qty_base', 'l.qty_approved', 'l.qty_issued',
      sql<string>`coalesce((SELECT sum(b.qty) FROM stock_balances b JOIN stock_lots lt ON lt.id = b.lot_id WHERE b.location_id = ${r.from_location_id} AND b.item_id = l.item_id
        AND lt.status = 'active' AND (lt.expires_on IS NULL OR lt.expires_on >= ${today}::date)), 0)`.as('available'),
      sql<boolean>`EXISTS (SELECT 1 FROM proc_requisition_lines pl JOIN proc_requisitions p ON p.id = pl.requisition_id WHERE pl.request_line_id = l.id
        AND p.status IN ('draft', 'submitted', 'approved'))`.as('covered')])
      .where('l.request_id', '=', requestId).orderBy('l.line_no').execute();
    // ერთი საქონელი რამდენიმე ხაზზე — მარაგი ერთხელ ნაწილდება
    const avail = new Map<string, number>();
    const lines: PrLineIn[] = [];
    for (const l of rows) {
      if (!avail.has(l.item_id)) avail.set(l.item_id, Number(l.available));
      const remaining = Math.max(0, Number(l.qty_approved ?? l.qty_base) - Number(l.qty_issued));
      const take = Math.min(remaining, avail.get(l.item_id)!);
      avail.set(l.item_id, avail.get(l.item_id)! - take);
      const shortage = r3(remaining - take);
      if (shortage <= 0 || l.covered) continue;
      const bp = await this.c.bestPrice(l.item_id, null);
      lines.push({ item_id: l.item_id, qty: shortage, est_price: bp.base_price === null ? null : r4(bp.base_price), supplier_id: bp.supplier_id ?? null, request_line_id: l.id });
    }
    if (!lines.length) throw new ConflictException('დეფიციტი არ არის — გამცემის მარაგი ფარავს (ან უკვე გადაცემულია შესყიდვაზე)');
    return this.create({ location_id: r.from_location_id, notes: `მოთხოვნა ${r.req_no ?? ''} — გაუცემელი ნაწილი`, lines }, u, ctx, { source: 'request', request_id: r.id });
  }

  // ---------------------------------------------------------------- PR → PO
  /** დამტკიცებული PR-ის შეუკვეთავი ხაზები → PO-ს მონახაზები მომწოდებლის მიხედვით */
  async toOrders(id: string, u: AuthUser, ctx: AuditContext) {
    await this.c.rulesPo();
    const created: string[] = [];
    await this.db.transaction().execute(async (trx) => {
      const p = await trx.selectFrom('proc_requisitions').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!p) throw new NotFoundException('შესყიდვის მოთხოვნა ვერ მოიძებნა');
      if (p.status !== 'approved') throw new ConflictException('შეკვეთა მზადდება მხოლოდ დამტკიცებული მოთხოვნიდან');
      const lines = await trx.selectFrom('proc_requisition_lines as l').selectAll('l').select(ProcRequisitionsService.orderedSql.as('ordered'))
        .where('l.requisition_id', '=', id).orderBy('l.line_no').execute();
      const open = lines.map((l) => ({ ...l, rest: r3(Number(l.qty_base) - Number(l.ordered)) })).filter((l) => l.rest > 0);
      if (!open.length) throw new ConflictException('ყველა ხაზი უკვე შეკვეთილია');
      const noItem = open.filter((l) => !l.item_id).map((l) => l.line_no);
      if (noItem.length) throw new BadRequestException(`ხაზი ${noItem.join(', ')}: მიაბით კატალოგის საქონელს (თავისუფალი ხაზი)`);
      const noSup = open.filter((l) => !l.supplier_id).map((l) => l.line_no);
      if (noSup.length) throw new BadRequestException(`ხაზი ${noSup.join(', ')}: მიუთითეთ მომწოდებელი`);
      const today = await this.c.today(trx);
      const bySup = new Map<string, typeof open>();
      for (const l of open) bySup.set(l.supplier_id!, [...(bySup.get(l.supplier_id!) ?? []), l]);
      for (const [supId, ls] of bySup) {
        const s = await this.c.supplier(supId, trx);
        const vals = [];
        for (const [i, l] of ls.entries()) {
          const bp = await this.c.bestPrice(l.item_id!, supId, trx);
          // ერთეული: PR-ის შეფუთვა, თუ დარჩენილი მთელი შეფუთვებია; სხვა შემთხვევაში — საბაზო
          const per = Number(l.pack_qty_base); const usePack = l.pack_id && Number.isInteger(r3(l.rest / per)) ? l.pack_id : null;
          const unitPer = usePack ? per : 1;
          // ფასი: მომწოდებლის ფასთა ნუსხა → PR-ის სავარაუდო → ბოლო მიღება
          const basePrice = bp.source === 'price_list' && bp.base_price !== null ? bp.base_price : l.est_price !== null ? Number(l.est_price) / per : bp.base_price ?? 0;
          const price = r4(basePrice * unitPer); const rate = bp.vat_rate ?? (s.vat_payer ? 18 : 0);
          const qty = r3(l.rest / unitPer);
          vals.push({ line_no: i + 1, item_id: l.item_id!, pack_id: usePack, pack_qty_base: String(unitPer), qty: String(qty), qty_base: String(l.rest), price: String(price), vat_rate: String(rate),
            unit_cost_gel: String(Math.round((price / unitPer) * 1e6) / 1e6), line_net: String(r2(price * qty)), line_vat: String(r2((r2(price * qty) * rate) / 100)), requisition_line_id: l.id });
        }
        const net = r2(vals.reduce((a, v) => a + Number(v.line_net), 0)); const vat = r2(vals.reduce((a, v) => a + Number(v.line_vat), 0));
        const o = await trx.insertInto('proc_orders').values({ supplier_id: supId, location_id: p.location_id, order_date: today, expected_date: s.lead_time_days ? addDays(today, s.lead_time_days) : p.needed_by && p.needed_by >= today ? p.needed_by : null,
          contract_no: s.contract_no, notes: `შესყიდვის მოთხოვნა ${p.pr_no}`, total_net: String(net), total_vat: String(vat), total_gel: String(net), created_by: u.id }).returning('id').executeTakeFirstOrThrow();
        await trx.insertInto('proc_order_lines').values(vals.map((v) => ({ ...v, order_id: o.id }))).execute();
        created.push(o.id);
      }
      await this.audit.log(ctx, { action: 'PROC_PR_TO_PO', entityName: 'proc_requisitions', entityId: id, newData: { orders: created } }, trx);
    });
    return { orders: created };
  }
}

// ======================================================================= DTO
class PrLineDto {
  @IsOptional() @IsUUID() item_id?: string | null; @IsOptional() @IsString() @MaxLength(300) free_name?: string | null; @IsOptional() @IsUUID() pack_id?: string | null;
  @IsNumber() @Min(0.001) @Max(10_000_000) qty: number; @IsOptional() @IsNumber() @Min(0) @Max(100_000_000) est_price?: number | null;
  @IsOptional() @IsUUID() supplier_id?: string | null; @IsOptional() @IsString() @MaxLength(500) notes?: string | null; @IsOptional() @IsUUID() request_line_id?: string | null;
}
class PrDto {
  @IsUUID() location_id: string; @IsOptional() @IsBoolean() urgent?: boolean; @IsOptional() @IsISO8601({ strict: true }) needed_by?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string | null;
  @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => PrLineDto) lines: PrLineDto[];
}
class ReasonDto { @IsString() @Length(3, 500) reason: string }
class ApproveDto { @IsOptional() @IsIn(['l1', 'finance', 'pharmacist']) step?: Step }
class PrLinePatchDto { @IsOptional() @IsUUID() supplier_id?: string | null; @IsOptional() @IsNumber() @Min(0) @Max(100_000_000) est_price?: number | null; @IsOptional() @IsUUID() item_id?: string }
class LocDto { @IsUUID() location_id: string }
class RqDto { @IsUUID() request_id: string }
const uuidOk = (v?: string) => !v || /^[0-9a-f-]{36}$/i.test(v);
const PR_STATUSES = ['draft', 'submitted', 'approved', 'rejected', 'closed', 'cancelled'];

@Controller('procurement/requisitions')
export class ProcRequisitionsController {
  constructor(private readonly s: ProcRequisitionsService) {}
  @Get() @Roles(...PROC_READ) list(@Query() q: { status?: string; location_id?: string; search?: string; mine?: string; to_approve?: string }, @CurrentUser() u: AuthUser) {
    if (!uuidOk(q.location_id)) throw new BadRequestException('არასწორი ფილტრი');
    if (q.status && q.status.split(',').some((x) => !PR_STATUSES.includes(x))) throw new BadRequestException('უცნობი სტატუსი');
    return this.s.list(u, { ...q, mine: q.mine === 'true', to_approve: q.to_approve === 'true' });
  }
  @Get(':id') @Roles(...PROC_READ) async one(@Param('id', ParseUUIDPipe) id: string) { await this.s.ready(); return this.s.get(id); }
  @Post() @Roles(...PR_EDIT) create(@Body() d: PrDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.create(d, u, auditCtx(r)); }
  @Post('from-minmax') @Roles(...PR_EDIT) fromMinmax(@Body() d: LocDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.fromMinmax(d.location_id, u, auditCtx(r)); }
  @Post('from-request') @Roles(...PR_EDIT) fromRequest(@Body() d: RqDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.fromRequest(d.request_id, u, auditCtx(r)); }
  @Put(':id') @Roles(...PR_EDIT) update(@Param('id', ParseUUIDPipe) id: string, @Body() d: PrDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.update(id, d, u, auditCtx(r)); }
  @Post(':id/submit') @HttpCode(200) @Roles(...PR_EDIT) submit(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.submit(id, u, auditCtx(r)); }
  @Post(':id/approve') @HttpCode(200) @Roles(...PR_APPROVE) approve(@Param('id', ParseUUIDPipe) id: string, @Body() d: ApproveDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.approve(id, d.step, u, auditCtx(r)); }
  @Post(':id/reject') @HttpCode(200) @Roles(...PR_APPROVE) reject(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.reject(id, d.reason, u, auditCtx(r)); }
  @Post(':id/cancel') @HttpCode(200) @Roles(...PR_EDIT) cancel(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.cancel(id, d.reason, false, u, auditCtx(r)); }
  @Post(':id/close') @HttpCode(200) @Roles(...PO_EDIT) close(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.cancel(id, d.reason, true, u, auditCtx(r)); }
  @Patch(':id/lines/:lineId') @Roles(...PO_EDIT) patchLine(@Param('id', ParseUUIDPipe) id: string, @Param('lineId', ParseUUIDPipe) lineId: string, @Body() d: PrLinePatchDto, @CurrentUser() u: AuthUser, @Req() r: Request) {
    return this.s.patchLine(id, lineId, d, u, auditCtx(r));
  }
  @Post(':id/orders') @HttpCode(200) @Roles(...PO_EDIT) toOrders(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.toOrders(id, u, auditCtx(r)); }
}
