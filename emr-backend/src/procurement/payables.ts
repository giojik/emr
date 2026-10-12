import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsISO8601, IsNumber, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/roles';
import { addDays, ProcCommon, r2, type Ex, type Trx, userName } from './procurement-common';
import { AP_EDIT, AP_READ } from './procurement-rules';

export interface ApLineIn { description: string; category: string; department_id?: string | null; amount: number; vat_rate?: number }
export interface ApIn {
  supplier_id: string; invoice_no: string; invoice_date: string; due_date?: string | null; currency?: 'GEL' | 'USD' | 'EUR'; fx_rate?: number;
  total: number; total_vat?: number; notes?: string | null; receipts?: string[]; lines?: ApLineIn[];
}
export interface PayIn { kind?: 'payment' | 'credit_note'; pay_date: string; amount: number; fx_rate?: number; method?: 'bank_transfer' | 'cash' | 'card' | null; reference?: string | null; reversal_doc_id?: string | null; note?: string | null }

/** ინვოისის ნაშთი (ვალუტაში): ჯამი − გადახდები − კრედიტ-ნოტები (გაუქმებულის გარდა) */
const PAID = sql<string>`coalesce((SELECT sum(p.amount) FROM ap_payments p WHERE p.invoice_id = i.id AND NOT p.is_void), 0)`;

/**
 * მომწოდებლის ინვოისი (0052): მონახაზი (RC-ები + არა-მარაგის ხაზები) → გატარება (AP-ნომერი, შეჯერება, ხარჯი) → გადახდები / კრედიტ-ნოტა → გაუქმება.
 * ხარჯების ჟურნალი: მხოლოდ არა-მარაგის ხაზები (მარაგი ხარჯი ხდება მოხმარებით); expense_recognition — ინვოისის ან გადახდის თარიღით.
 */
@Injectable()
export class PayablesService {
  constructor(private readonly c: ProcCommon, private readonly audit: AuditService) {}
  private get db() { return this.c.db; }

  // ---------------------------------------------------------------- სია / ნახვა
  async list(q: { status?: string; state?: string; supplier_id?: string; search?: string; from?: string; to?: string }) {
    await this.c.rules();
    const today = await this.c.today();
    let x = this.db.selectFrom('ap_invoices as i').innerJoin('stock_suppliers as s', 's.id', 'i.supplier_id')
      .select(['i.id', 'i.ap_no', 'i.status', 'i.invoice_no', 'i.invoice_date', 'i.due_date', 'i.currency', 'i.fx_rate', 'i.total', 'i.total_gel', 'i.expense_total', 'i.stock_gel',
        'i.match_status', 'i.match_diff', 'i.supplier_id', 's.name as supplier_name', 'i.created_at', PAID.as('paid'),
        sql<number>`(SELECT count(*)::int FROM ap_invoice_receipts r WHERE r.invoice_id = i.id)`.as('receipts'),
        sql<number>`CASE WHEN i.status = 'posted' THEN ${today}::date - i.due_date END`.as('days_overdue')])
      .orderBy('i.invoice_date', 'desc').orderBy('i.created_at', 'desc').limit(1000);
    if (q.status) x = x.where('i.status', 'in', q.status.split(','));
    if (q.supplier_id) x = x.where('i.supplier_id', '=', q.supplier_id);
    if (q.from) x = x.where('i.invoice_date', '>=', q.from);
    if (q.to) x = x.where('i.invoice_date', '<=', q.to);
    if (q.state === 'open') x = x.where('i.status', '=', 'posted').where(sql<boolean>`(${PAID} < i.total)`, '=', true);
    if (q.state === 'overdue') x = x.where('i.status', '=', 'posted').where(sql<boolean>`(${PAID} < i.total)`, '=', true).where('i.due_date', '<', today);
    if (q.state === 'paid') x = x.where('i.status', '=', 'posted').where(sql<boolean>`(${PAID} >= i.total)`, '=', true);
    if (q.state === 'mismatch') x = x.where('i.status', '=', 'posted').where('i.match_status', '=', 'mismatch');
    const s = q.search?.trim();
    if (s) x = x.where((eb) => eb.or([eb(sql`upper(coalesce(i.ap_no, ''))`, 'like', `%${s.toUpperCase()}%`), eb(sql`upper(i.invoice_no)`, 'like', `%${s.toUpperCase()}%`),
      eb(sql`lower(s.name)`, 'like', `%${s.toLowerCase()}%`)]));
    return (await x.execute()).map((r) => ({ ...r, balance: String(r2(Number(r.total) - Number(r.paid))) }));
  }

  async get(id: string, ex: Ex = this.db) {
    const i = await ex.selectFrom('ap_invoices as i').innerJoin('stock_suppliers as s', 's.id', 'i.supplier_id').innerJoin('users as u', 'u.id', 'i.created_by')
      .leftJoin('users as up', 'up.id', 'i.posted_by').leftJoin('users as ua', 'ua.id', 'i.accepted_by').leftJoin('users as uv', 'uv.id', 'i.voided_by')
      .selectAll('i').select(['s.name as supplier_name', 's.tax_id as supplier_tax_id', 's.iban as supplier_iban', 's.bank_name as supplier_bank', 's.payment_terms_days',
        userName('u').as('created_by_name'), userName('up').as('posted_by_name'), userName('ua').as('accepted_by_name'), userName('uv').as('voided_by_name'), PAID.as('paid')])
      .where('i.id', '=', id).executeTakeFirst();
    if (!i) throw new NotFoundException('ინვოისი ვერ მოიძებნა');
    const [lines, receipts, payments, expenses] = await Promise.all([
      ex.selectFrom('ap_invoice_lines as l').leftJoin('departments as d', 'd.id', 'l.department_id').selectAll('l').select('d.name as department_name')
        .where('l.invoice_id', '=', id).orderBy('l.line_no').execute(),
      ex.selectFrom('ap_invoice_receipts as r').innerJoin('stock_docs as d', 'd.id', 'r.doc_id').leftJoin('stock_docs as rv', 'rv.id', 'd.reversed_by')
        .leftJoin('proc_orders as po', 'po.id', 'd.po_id').leftJoin('stock_locations as lc', 'lc.id', 'd.location_id')
        .select(['r.doc_id', 'r.amount_gel', 'd.doc_no', 'd.doc_date', 'd.invoice_no', 'd.waybill_no', 'd.total_net', 'd.total_vat', 'po.po_no', 'lc.name as location_name', 'rv.doc_no as reversed_by_no', 'd.reversed_by'])
        .where('r.invoice_id', '=', id).orderBy('d.doc_date').execute(),
      ex.selectFrom('ap_payments as p').innerJoin('users as u', 'u.id', 'p.created_by').leftJoin('stock_docs as rv', 'rv.id', 'p.reversal_doc_id')
        .selectAll('p').select([userName('u').as('created_by_name'), 'rv.doc_no as reversal_doc_no']).where('p.invoice_id', '=', id).orderBy('p.pay_date').orderBy('p.created_at').execute(),
      ex.selectFrom('expenses as x').leftJoin('departments as d', 'd.id', 'x.department_id')
        .select(['x.id', 'x.expense_date', 'x.category', 'x.amount', 'x.source', 'x.is_void', 'd.name as department_name']).where('x.ap_invoice_id', '=', id).orderBy('x.expense_date').execute(),
    ]);
    const today = await this.c.today(ex);
    const balance = r2(Number(i.total) - Number(i.paid));
    return { ...i, balance: String(balance), overdue: i.status === 'posted' && balance > 0 && i.due_date < today, lines, receipts, payments, expenses };
  }

  /** მომწოდებლის გატარებული, შეუბრუნებელი მიღებები, რომლებიც ჯერ ინვოისზე არ არის მიბმული */
  async uninvoiced(supplierId: string, invoiceId?: string) {
    await this.c.rules();
    return this.db.selectFrom('stock_docs as d').leftJoin('proc_orders as po', 'po.id', 'd.po_id').leftJoin('stock_locations as lc', 'lc.id', 'd.location_id')
      .select(['d.id', 'd.doc_no', 'd.doc_date', 'd.invoice_no', 'd.invoice_date', 'd.waybill_no', 'd.total_net', 'd.total_vat', 'po.po_no', 'lc.name as location_name'])
      .where('d.supplier_id', '=', supplierId).where('d.doc_type', '=', 'receipt').where('d.status', '=', 'posted').where('d.reversed_by', 'is', null)
      .where(sql<boolean>`NOT EXISTS (SELECT 1 FROM ap_invoice_receipts r WHERE r.doc_id = d.id ${invoiceId ? sql`AND r.invoice_id <> ${invoiceId}` : sql``})`, '=', true)
      .orderBy('d.doc_date', 'desc').limit(300).execute();
  }

  // ---------------------------------------------------------------- მონახაზი
  private async build(trx: Trx, dto: ApIn, id: string | null) {
    const s = await this.c.supplier(dto.supplier_id, trx);
    const sup = await trx.selectFrom('stock_suppliers').select('payment_terms_days').where('id', '=', s.id).executeTakeFirstOrThrow();
    const today = await this.c.today(trx);
    if (dto.invoice_date > today) throw new BadRequestException('ინვოისის თარიღი მომავალშია');
    const cur = dto.currency ?? 'GEL'; const fx = cur === 'GEL' ? 1 : dto.fx_rate ?? 0;
    if (cur !== 'GEL' && !(fx > 0)) throw new BadRequestException('უცხოურ ვალუტაზე კურსი სავალდებულოა (1 ერთეული = ? ₾)');
    const due = dto.due_date || addDays(dto.invoice_date, sup.payment_terms_days ?? 0);
    if (due < dto.invoice_date) throw new BadRequestException('გადახდის ვადა ინვოისის თარიღამდეა');
    const vat = dto.total_vat ?? 0;
    if (vat > dto.total) throw new BadRequestException('დღგ ჯამზე მეტია');
    const lines = (dto.lines ?? []).map((l, i) => {
      if ((l.description ?? '').trim().length < 2 || (l.category ?? '').trim().length < 2) throw new BadRequestException(`ხაზი ${i + 1}: აღწერა და ხარჯის კატეგორია სავალდებულოა`);
      return { line_no: i + 1, description: l.description.trim(), category: l.category.trim(), department_id: l.department_id ?? null, amount: String(r2(l.amount)), vat_rate: String(l.vat_rate ?? 0) };
    });
    const ids = [...new Set(dto.receipts ?? [])];
    const docs = ids.length ? await trx.selectFrom('stock_docs as d').select(['d.id', 'd.doc_no', 'd.doc_type', 'd.status', 'd.supplier_id', 'd.reversed_by', 'd.total_net', 'd.total_vat',
      sql<string | null>`(SELECT a.ap_no || ' / ' || a.invoice_no FROM ap_invoice_receipts r JOIN ap_invoices a ON a.id = r.invoice_id WHERE r.doc_id = d.id ${id ? sql`AND a.id <> ${id}` : sql``} LIMIT 1)`.as('taken')])
      .where('d.id', 'in', ids).execute() : [];
    const receipts = ids.map((did) => {
      const d = docs.find((x) => x.id === did);
      if (!d || d.doc_type !== 'receipt' || d.status !== 'posted') throw new BadRequestException('მიბმა შეიძლება მხოლოდ გატარებულ მიღებაზე (RC)');
      if (d.reversed_by) throw new BadRequestException(`${d.doc_no} შემობრუნებულია`);
      if (d.supplier_id !== s.id) throw new BadRequestException(`${d.doc_no} სხვა მომწოდებლისაა`);
      if (d.taken) throw new ConflictException(`${d.doc_no} უკვე მიბმულია ინვოისზე ${d.taken}`);
      return { doc_id: d.id, amount_gel: String(r2(Number(d.total_net) + Number(d.total_vat))) };
    });
    if (!receipts.length && !lines.length) throw new BadRequestException('მიაბით მიღება (RC) ან დაამატეთ არა-მარაგის ხაზი');
    const expenseTotal = r2(lines.reduce((a, l) => a + Number(l.amount), 0));
    if (expenseTotal > dto.total + 0.005) throw new BadRequestException('ხაზების ჯამი ინვოისის ჯამზე მეტია');
    const head = { supplier_id: s.id, invoice_no: dto.invoice_no.trim(), invoice_date: dto.invoice_date, due_date: due, currency: cur, fx_rate: String(fx), total: String(r2(dto.total)),
      total_vat: String(r2(vat)), total_gel: String(r2(dto.total * fx)), expense_total: String(expenseTotal), notes: dto.notes?.trim() || null };
    return { head, lines, receipts };
  }
  private mapErr(e: unknown): never {
    const err = e as { constraint?: string; message?: string };
    if (err.constraint === 'ux_ap_invoices_supplier_no') throw new ConflictException('ამ მომწოდებლის ეს ფაქტურა უკვე რეგისტრირებულია');
    if (err.constraint === 'ux_ap_invoice_receipts_doc') throw new ConflictException('მიღება უკვე მიბმულია სხვა ინვოისზე');
    if (err.constraint === 'ap_payments_overpaid') throw new ConflictException(err.message ?? 'თანხა აჭარბებს ნაშთს');
    if (err.constraint === 'ap_invoices_immutable' || err.constraint === 'ap_payments_immutable' || err.constraint === 'ap_payments_invoice_status') throw new ConflictException(err.message);
    throw e;
  }

  async save(id: string | null, dto: ApIn, u: AuthUser, ctx: AuditContext) {
    await this.c.rules();
    try {
      const rid = await this.db.transaction().execute(async (trx) => {
        if (id) {
          const o = await trx.selectFrom('ap_invoices').select('status').where('id', '=', id).forUpdate().executeTakeFirst();
          if (!o) throw new NotFoundException('ინვოისი ვერ მოიძებნა');
          if (o.status !== 'draft') throw new ConflictException('მხოლოდ მონახაზი იცვლება');
        }
        const b = await this.build(trx, dto, id);
        let iid = id;
        if (iid) {
          await trx.updateTable('ap_invoices').set(b.head).where('id', '=', iid).execute();
          await trx.deleteFrom('ap_invoice_lines').where('invoice_id', '=', iid).execute();
          await trx.deleteFrom('ap_invoice_receipts').where('invoice_id', '=', iid).execute();
        } else iid = (await trx.insertInto('ap_invoices').values({ ...b.head, created_by: u.id }).returning('id').executeTakeFirstOrThrow()).id;
        if (b.lines.length) await trx.insertInto('ap_invoice_lines').values(b.lines.map((l) => ({ ...l, invoice_id: iid! }))).execute();
        if (b.receipts.length) await trx.insertInto('ap_invoice_receipts').values(b.receipts.map((r) => ({ ...r, invoice_id: iid! }))).execute();
        await this.audit.log(ctx, { action: id ? 'UPDATE_AP_INVOICE' : 'CREATE_AP_INVOICE', entityName: 'ap_invoices', entityId: iid, newData: { ...b.head, receipts: b.receipts.length, lines: b.lines.length } }, trx);
        return iid;
      });
      return this.get(rid);
    } catch (e) { this.mapErr(e); }
  }

  async remove(id: string, ctx: AuditContext) {
    await this.c.rules();
    await this.db.transaction().execute(async (trx) => {
      const o = await trx.selectFrom('ap_invoices').select(['status', 'invoice_no']).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!o) throw new NotFoundException('ინვოისი ვერ მოიძებნა');
      if (o.status !== 'draft') throw new ConflictException('წაიშლება მხოლოდ მონახაზი (გატარებული — გაუქმებით)');
      await trx.deleteFrom('ap_invoices').where('id', '=', id).execute();
      await this.audit.log(ctx, { action: 'DELETE_AP_INVOICE', entityName: 'ap_invoices', entityId: id, oldData: o }, trx);
    });
    return { ok: true };
  }

  // ---------------------------------------------------------------- გატარება: შეჯერება + ხარჯი
  /** შეჯერება: ინვოისის მარაგის ნაწილი (₾) ↔ მიღებები; three_way — + PO-ს ფასით მიღებული რაოდენობა */
  private async match(trx: Ex, inv: { id: string; total: string; expense_total: string; fx_rate: string }, mode: string, tol: number) {
    const rcs = await trx.selectFrom('ap_invoice_receipts as r').innerJoin('stock_docs as d', 'd.id', 'r.doc_id')
      .select(['d.id', 'd.doc_no', 'd.reversed_by', 'd.total_net', 'd.total_vat']).where('r.invoice_id', '=', inv.id).execute();
    const rev = rcs.filter((d) => d.reversed_by).map((d) => d.doc_no);
    if (rev.length) throw new BadRequestException(`მიღება შემობრუნებულია: ${rev.join(', ')} — მოხსენით ინვოისიდან`);
    const rcGel = r2(rcs.reduce((a, d) => a + Number(d.total_net) + Number(d.total_vat), 0));
    const stockGel = r2((Number(inv.total) - Number(inv.expense_total)) * Number(inv.fx_rate));
    if (!rcs.length) {
      if (Math.abs(Number(inv.total) - Number(inv.expense_total)) > 0.005) throw new BadRequestException('მიღების გარეშე ინვოისის ჯამი ხაზების ჯამს უნდა ემთხვეოდეს');
      return { status: 'none' as const, diff: null, note: null, rcGel };
    }
    if (mode === 'off') return { status: 'none' as const, diff: r2(stockGel - rcGel), note: null, rcGel };
    const diff = r2(stockGel - rcGel);
    const notes: string[] = [];
    if (Math.abs(diff) > tol) notes.push(`ინვოისის მარაგის ნაწილი ${stockGel.toFixed(2)} ₾ ≠ მიღებები ${rcGel.toFixed(2)} ₾ (სხვაობა ${diff.toFixed(2)} ₾)`);
    if (mode === 'three_way') {
      const po = await trx.selectFrom('stock_doc_lines as x').innerJoin('proc_order_lines as ol', 'ol.id', 'x.po_line_id').innerJoin('proc_orders as o', 'o.id', 'ol.order_id')
        .select([sql<string>`sum(x.qty_base * ol.unit_cost_gel * (1 + ol.vat_rate / 100))`.as('po_value'), sql<string>`sum(coalesce(x.line_net, 0) + coalesce(x.line_vat, 0))`.as('rc_value')])
        .where('x.doc_id', 'in', rcs.map((d) => d.id)).executeTakeFirst();
      const pv = r2(Number(po?.po_value ?? 0)); const rv = r2(Number(po?.rc_value ?? 0));
      if (Math.abs(pv - rv) > tol) notes.push(`მიღებული რაოდენობა შეკვეთის ფასით ${pv.toFixed(2)} ₾ ≠ მიღების ფასით ${rv.toFixed(2)} ₾`);
    }
    return { status: notes.length ? ('mismatch' as const) : ('ok' as const), diff, note: notes.join('; ') || null, rcGel };
  }

  /** ხარჯის ჩანაწერები ინვოისის ხაზებიდან: factor — წილი (გადახდა / კრედიტ-ნოტა: თანხა ÷ ჯამი); ნიშანი — კრედიტ-ნოტაზე უარყოფითი */
  private async expenseRows(trx: Trx, inv: { id: string; supplier_id: string; invoice_no: string; total: string; expense_total: string }, lines: { description: string; category: string; department_id: string | null; amount: string }[],
    o: { date: string; factor: number; fx: number; source: 'ap_invoice' | 'ap_payment' | 'ap_credit'; payment_id?: string; method?: string | null; sign?: 1 | -1 }, u: AuthUser) {
    if (!lines.length) return 0;
    const sup = await trx.selectFrom('stock_suppliers').select('name').where('id', '=', inv.supplier_id).executeTakeFirstOrThrow();
    let n = 0;
    for (const l of lines) {
      const amount = r2(Number(l.amount) * o.factor * o.fx) * (o.sign ?? 1);
      if (amount === 0) continue;
      await trx.insertInto('expenses').values({ expense_date: o.date, category: l.category, description: `${l.description}${o.source === 'ap_credit' ? ' (კრედიტ-ნოტა)' : o.source === 'ap_payment' ? ' (გადახდა)' : ''}`,
        amount: String(amount), payment_method: o.method ?? 'bank_transfer', supplier: sup.name, doc_number: inv.invoice_no, department_id: l.department_id, source: o.source,
        ap_invoice_id: inv.id, ap_payment_id: o.payment_id ?? null, supplier_id: inv.supplier_id, created_by: u.id }).execute();
      n++;
    }
    return n;
  }

  async post(id: string, u: AuthUser, ctx: AuditContext) {
    const rules = await this.c.rules();
    try {
      await this.db.transaction().execute(async (trx) => {
        const inv = await trx.selectFrom('ap_invoices').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
        if (!inv) throw new NotFoundException('ინვოისი ვერ მოიძებნა');
        if (inv.status !== 'draft') throw new ConflictException('ინვოისი უკვე გატარებულია ან გაუქმებულია');
        await this.c.supplier(inv.supplier_id, trx);
        const m = await this.match(trx, inv, rules.invoice_match, rules.match_tolerance);
        const no = await this.c.nextNo(trx, 'AP', inv.invoice_date);
        await trx.updateTable('ap_invoices').set({ status: 'posted', ap_no: no, stock_gel: String(m.rcGel), match_status: m.status, match_diff: m.diff === null ? null : String(m.diff),
          match_note: m.note, posted_by: u.id, posted_at: sql`now()` }).where('id', '=', id).execute();
        const lines = await trx.selectFrom('ap_invoice_lines').select(['description', 'category', 'department_id', 'amount']).where('invoice_id', '=', id).orderBy('line_no').execute();
        const n = rules.expense_recognition === 'on_invoice' ? await this.expenseRows(trx, inv, lines, { date: inv.invoice_date, factor: 1, fx: Number(inv.fx_rate), source: 'ap_invoice' }, u) : 0;
        await this.audit.log(ctx, { action: 'POST_AP_INVOICE', entityName: 'ap_invoices', entityId: id, newData: { ap_no: no, match_status: m.status, match_diff: m.diff, expense_rows: n } }, trx);
      });
    } catch (e) { this.mapErr(e); }
    return this.get(id);
  }

  async acceptMatch(id: string, note: string, u: AuthUser, ctx: AuditContext) {
    await this.c.rules();
    await this.db.transaction().execute(async (trx) => {
      const inv = await trx.selectFrom('ap_invoices').select(['status', 'match_status', 'match_note']).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!inv) throw new NotFoundException('ინვოისი ვერ მოიძებნა');
      if (inv.status !== 'posted' || inv.match_status !== 'mismatch') throw new ConflictException('დასადასტურებელი სხვაობა არ არის');
      await trx.updateTable('ap_invoices').set({ match_status: 'accepted', match_note: `${inv.match_note ?? ''} — დადასტურდა: ${note.trim()}`, accepted_by: u.id, accepted_at: sql`now()` }).where('id', '=', id).execute();
      await this.audit.log(ctx, { action: 'ACCEPT_AP_MATCH', entityName: 'ap_invoices', entityId: id, newData: { note } }, trx);
    });
    return this.get(id);
  }

  /** გაუქმება: გადახდების გარეშე; ხარჯის ჩანაწერები უქმდება, მიღებები თავისუფლდება */
  async voidInvoice(id: string, reason: string, u: AuthUser, ctx: AuditContext) {
    await this.c.rules();
    try {
      await this.db.transaction().execute(async (trx) => {
        const inv = await trx.selectFrom('ap_invoices').select(['status', 'ap_no']).where('id', '=', id).forUpdate().executeTakeFirst();
        if (!inv) throw new NotFoundException('ინვოისი ვერ მოიძებნა');
        if (inv.status !== 'posted') throw new ConflictException('გაუქმდება გატარებული ინვოისი (მონახაზი — წაშლით)');
        const p = await trx.selectFrom('ap_payments').select(sql<number>`count(*)::int`.as('n')).where('invoice_id', '=', id).where('is_void', '=', false).executeTakeFirstOrThrow();
        if (p.n > 0) throw new ConflictException('ინვოისზე არის გადახდა / კრედიტ-ნოტა — ჯერ გააუქმეთ ისინი');
        await trx.updateTable('ap_invoices').set({ status: 'void', void_reason: reason.trim(), voided_by: u.id, voided_at: sql`now()` }).where('id', '=', id).execute();
        await trx.deleteFrom('ap_invoice_receipts').where('invoice_id', '=', id).execute();
        await trx.updateTable('expenses').set({ is_void: true, void_reason: `ინვოისი ${inv.ap_no} გაუქმდა: ${reason.trim()}` }).where('ap_invoice_id', '=', id).where('is_void', '=', false).execute();
        await this.audit.log(ctx, { action: 'VOID_AP_INVOICE', entityName: 'ap_invoices', entityId: id, newData: { reason } }, trx);
      });
    } catch (e) { this.mapErr(e); }
    return this.get(id);
  }

  // ---------------------------------------------------------------- გადახდა / კრედიტ-ნოტა
  async pay(id: string, dto: PayIn, u: AuthUser, ctx: AuditContext) {
    const rules = await this.c.rules();
    const kind = dto.kind ?? 'payment';
    try {
      await this.db.transaction().execute(async (trx) => {
        const inv = await trx.selectFrom('ap_invoices').selectAll().where('id', '=', id).executeTakeFirst();
        if (!inv) throw new NotFoundException('ინვოისი ვერ მოიძებნა');
        if (inv.status !== 'posted') throw new ConflictException('გადახდა — მხოლოდ გატარებულ ინვოისზე');
        if (kind === 'payment' && inv.match_status === 'mismatch') throw new ConflictException('შეჯერებაში სხვაობაა — გადახდამდე ბუღალტერმა უნდა დაადასტუროს (მიზეზით)');
        const today = await this.c.today(trx);
        if (dto.pay_date > today) throw new BadRequestException('თარიღი მომავალშია');
        if (kind === 'payment' && !dto.method) throw new BadRequestException('მიუთითეთ გადახდის მეთოდი');
        const fx = inv.currency === 'GEL' ? 1 : dto.fx_rate ?? Number(inv.fx_rate);
        if (dto.reversal_doc_id) {
          const rv = await trx.selectFrom('stock_docs as d').innerJoin('ap_invoice_receipts as r', 'r.doc_id', 'd.reversal_of').select('d.id')
            .where('d.id', '=', dto.reversal_doc_id).where('d.doc_type', '=', 'reversal').where('r.invoice_id', '=', id).executeTakeFirst();
          if (!rv) throw new BadRequestException('შემობრუნების დოკუმენტი ამ ინვოისის მიღებას არ ეკუთვნის');
        }
        const p = await trx.insertInto('ap_payments').values({ invoice_id: id, kind, pay_date: dto.pay_date, amount: String(r2(dto.amount)), fx_rate: String(fx), amount_gel: String(r2(dto.amount * fx)),
          method: kind === 'payment' ? dto.method! : null, reference: dto.reference?.trim() || null, reversal_doc_id: dto.reversal_doc_id ?? null, note: dto.note?.trim() || null, created_by: u.id })
          .returning('id').executeTakeFirstOrThrow();
        // ხარჯი: გადახდისას (on_payment) — წილი; კრედიტ-ნოტაზე (on_invoice) — უარყოფითი წილი
        const lines = await trx.selectFrom('ap_invoice_lines').select(['description', 'category', 'department_id', 'amount']).where('invoice_id', '=', id).orderBy('line_no').execute();
        const factor = dto.amount / Number(inv.total);
        let n = 0;
        if (kind === 'payment' && rules.expense_recognition === 'on_payment') n = await this.expenseRows(trx, inv, lines, { date: dto.pay_date, factor, fx, source: 'ap_payment', payment_id: p.id, method: dto.method }, u);
        if (kind === 'credit_note' && rules.expense_recognition === 'on_invoice') n = await this.expenseRows(trx, inv, lines, { date: dto.pay_date, factor, fx, source: 'ap_credit', payment_id: p.id, sign: -1 }, u);
        await this.audit.log(ctx, { action: kind === 'payment' ? 'CREATE_AP_PAYMENT' : 'CREATE_AP_CREDIT_NOTE', entityName: 'ap_invoices', entityId: id, newData: { ...dto, payment_id: p.id, expense_rows: n } }, trx);
      });
    } catch (e) { this.mapErr(e); }
    return this.get(id);
  }

  async voidPayment(paymentId: string, reason: string, u: AuthUser, ctx: AuditContext) {
    await this.c.rules();
    let invId = '';
    try {
      await this.db.transaction().execute(async (trx) => {
        const p = await trx.selectFrom('ap_payments').select(['invoice_id', 'is_void', 'kind']).where('id', '=', paymentId).forUpdate().executeTakeFirst();
        if (!p) throw new NotFoundException('გადახდა ვერ მოიძებნა');
        if (p.is_void) throw new ConflictException('უკვე გაუქმებულია');
        invId = p.invoice_id;
        await trx.updateTable('ap_payments').set({ is_void: true, void_reason: reason.trim(), voided_by: u.id, voided_at: sql`now()` }).where('id', '=', paymentId).execute();
        await trx.updateTable('expenses').set({ is_void: true, void_reason: `${p.kind === 'payment' ? 'გადახდა' : 'კრედიტ-ნოტა'} გაუქმდა: ${reason.trim()}` }).where('ap_payment_id', '=', paymentId).where('is_void', '=', false).execute();
        await this.audit.log(ctx, { action: 'VOID_AP_PAYMENT', entityName: 'ap_invoices', entityId: p.invoice_id, newData: { payment_id: paymentId, reason } }, trx);
      });
    } catch (e) { this.mapErr(e); }
    return this.get(invId);
  }

  // ---------------------------------------------------------------- რეპორტები
  /** ხანდაზმულობა: გატარებული ინვოისების ნაშთი (₾, ინვოისის კურსით) მომწოდებლებით — ვადამდე / 1–30 / 31–60 / 61–90 / 90+ დღე ვადაგადაცილებით */
  async aging(asOf?: string) {
    await this.c.rules();
    const d = asOf || await this.c.today();
    const rows = await this.db.selectFrom('ap_invoices as i').innerJoin('stock_suppliers as s', 's.id', 'i.supplier_id')
      .select(['i.supplier_id', 's.name as supplier_name', 'i.due_date', 'i.fx_rate', 'i.total',
        sql<string>`coalesce((SELECT sum(p.amount) FROM ap_payments p WHERE p.invoice_id = i.id AND NOT p.is_void AND p.pay_date <= ${d}::date), 0)`.as('paid')])
      .where('i.status', '=', 'posted').where('i.invoice_date', '<=', d).execute();
    const by = new Map<string, { supplier_id: string; supplier_name: string; not_due: number; d1_30: number; d31_60: number; d61_90: number; d90: number; total: number; invoices: number }>();
    for (const r of rows) {
      const bal = r2((Number(r.total) - Number(r.paid)) * Number(r.fx_rate));
      if (bal <= 0) continue;
      const late = Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${r.due_date}T00:00:00Z`)) / 86_400_000);
      const g = by.get(r.supplier_id) ?? { supplier_id: r.supplier_id, supplier_name: r.supplier_name, not_due: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90: 0, total: 0, invoices: 0 };
      const k = late <= 0 ? 'not_due' : late <= 30 ? 'd1_30' : late <= 60 ? 'd31_60' : late <= 90 ? 'd61_90' : 'd90';
      g[k] = r2(g[k] + bal); g.total = r2(g.total + bal); g.invoices++;
      by.set(r.supplier_id, g);
    }
    const list = [...by.values()].sort((a, b) => b.total - a.total);
    const sum = (k: 'not_due' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90' | 'total') => r2(list.reduce((a, x) => a + x[k], 0));
    return { as_of: d, rows: list, totals: { not_due: sum('not_due'), d1_30: sum('d1_30'), d31_60: sum('d31_60'), d61_90: sum('d61_90'), d90: sum('d90'), total: sum('total') } };
  }

  /** გადახდების რეესტრი პერიოდზე (₾) */
  async payments(from: string, to: string, includeVoid: boolean) {
    await this.c.rules();
    let x = this.db.selectFrom('ap_payments as p').innerJoin('ap_invoices as i', 'i.id', 'p.invoice_id').innerJoin('stock_suppliers as s', 's.id', 'i.supplier_id').innerJoin('users as u', 'u.id', 'p.created_by')
      .select(['p.id', 'p.kind', 'p.pay_date', 'p.amount', 'p.amount_gel', 'p.method', 'p.reference', 'p.is_void', 'p.void_reason', 'i.id as invoice_id', 'i.ap_no', 'i.invoice_no', 'i.currency',
        's.name as supplier_name', 's.iban as supplier_iban', userName('u').as('created_by_name')])
      .where('p.pay_date', '>=', from).where('p.pay_date', '<=', to).orderBy('p.pay_date', 'desc').orderBy('p.created_at', 'desc').limit(3000);
    if (!includeVoid) x = x.where('p.is_void', '=', false);
    return x.execute();
  }

  async summary() {
    const rules = await this.c.rules();
    const today = await this.c.today();
    const soon = addDays(today, rules.ap_due_days);
    const r = await this.db.selectFrom('ap_invoices as i').select([
      sql<number>`count(*) FILTER (WHERE i.status = 'draft')::int`.as('drafts'),
      sql<number>`count(*) FILTER (WHERE i.status = 'posted' AND i.match_status = 'mismatch')::int`.as('mismatch'),
      sql<number>`count(*) FILTER (WHERE i.status = 'posted' AND ${PAID} < i.total AND i.due_date < ${today}::date)::int`.as('overdue'),
      sql<number>`count(*) FILTER (WHERE i.status = 'posted' AND ${PAID} < i.total AND i.due_date BETWEEN ${today}::date AND ${soon}::date)::int`.as('due_soon'),
      sql<string>`coalesce(sum((i.total - ${PAID}) * i.fx_rate) FILTER (WHERE i.status = 'posted'), 0)`.as('open_gel'),
    ]).executeTakeFirstOrThrow();
    return { ...r, open_gel: String(r2(Number(r.open_gel))) };
  }
}

// ======================================================================= DTO
class ApLineDto {
  @IsString() @Length(2, 500) description: string; @IsString() @Length(2, 100) category: string; @IsOptional() @IsUUID() department_id?: string | null;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(100_000_000) amount: number; @IsOptional() @IsIn([0, 18]) vat_rate?: number;
}
class ApDto {
  @IsUUID() supplier_id: string; @IsString() @Length(1, 60) invoice_no: string; @IsISO8601({ strict: true }) invoice_date: string; @IsOptional() @IsISO8601({ strict: true }) due_date?: string | null;
  @IsOptional() @IsIn(['GEL', 'USD', 'EUR']) currency?: 'GEL' | 'USD' | 'EUR'; @IsOptional() @IsNumber() @Min(0.000001) @Max(10_000) fx_rate?: number;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(1_000_000_000) total: number; @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) total_vat?: number;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsUUID('all', { each: true }) receipts?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => ApLineDto) lines?: ApLineDto[];
}
class PayDto {
  @IsOptional() @IsIn(['payment', 'credit_note']) kind?: 'payment' | 'credit_note'; @IsISO8601({ strict: true }) pay_date: string;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(1_000_000_000) amount: number; @IsOptional() @IsNumber() @Min(0.000001) @Max(10_000) fx_rate?: number;
  @IsOptional() @IsIn(['bank_transfer', 'cash', 'card']) method?: 'bank_transfer' | 'cash' | 'card' | null; @IsOptional() @IsString() @MaxLength(80) reference?: string | null;
  @IsOptional() @IsUUID() reversal_doc_id?: string | null; @IsOptional() @IsString() @MaxLength(500) note?: string | null;
}
class ReasonDto { @IsString() @Length(3, 500) reason: string }
const uuidOk = (v?: string) => !v || /^[0-9a-f-]{36}$/i.test(v);
const dateOk = (v?: string) => !v || /^\d{4}-\d{2}-\d{2}$/.test(v);

@Controller('payables')
export class PayablesController {
  constructor(private readonly s: PayablesService) {}
  @Get('summary') @Roles(...AP_READ) summary() { return this.s.summary(); }
  @Get('invoices') @Roles(...AP_READ) list(@Query() q: { status?: string; state?: string; supplier_id?: string; search?: string; from?: string; to?: string }) {
    if (!uuidOk(q.supplier_id) || !dateOk(q.from) || !dateOk(q.to)) throw new BadRequestException('არასწორი ფილტრი');
    if (q.status && q.status.split(',').some((x) => !['draft', 'posted', 'void'].includes(x))) throw new BadRequestException('უცნობი სტატუსი');
    return this.s.list(q);
  }
  @Get('invoices/:id') @Roles(...AP_READ) one(@Param('id', ParseUUIDPipe) id: string) { return this.s.get(id); }
  @Get('uninvoiced') @Roles(...AP_READ) uninvoiced(@Query('supplier_id') sup?: string, @Query('invoice_id') inv?: string) {
    if (!sup || !uuidOk(sup) || !uuidOk(inv)) throw new BadRequestException('supplier_id სავალდებულოა');
    return this.s.uninvoiced(sup, inv);
  }
  @Post('invoices') @Roles(...AP_EDIT) create(@Body() d: ApDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.save(null, d, u, auditCtx(r)); }
  @Put('invoices/:id') @Roles(...AP_EDIT) update(@Param('id', ParseUUIDPipe) id: string, @Body() d: ApDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.save(id, d, u, auditCtx(r)); }
  @Delete('invoices/:id') @Roles(...AP_EDIT) remove(@Param('id', ParseUUIDPipe) id: string, @Req() r: Request) { return this.s.remove(id, auditCtx(r)); }
  @Post('invoices/:id/post') @HttpCode(200) @Roles(...AP_EDIT) post(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.post(id, u, auditCtx(r)); }
  @Post('invoices/:id/accept-match') @HttpCode(200) @Roles(...AP_EDIT) accept(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.acceptMatch(id, d.reason, u, auditCtx(r)); }
  @Post('invoices/:id/void') @HttpCode(200) @Roles(...AP_EDIT) void(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.voidInvoice(id, d.reason, u, auditCtx(r)); }
  @Post('invoices/:id/payments') @HttpCode(200) @Roles(...AP_EDIT) pay(@Param('id', ParseUUIDPipe) id: string, @Body() d: PayDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.pay(id, d, u, auditCtx(r)); }
  @Post('payments/:id/void') @HttpCode(200) @Roles(...AP_EDIT) voidPay(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.voidPayment(id, d.reason, u, auditCtx(r)); }
  @Get('aging') @Roles(...AP_READ) aging(@Query('as_of') asOf?: string) { if (!dateOk(asOf)) throw new BadRequestException('as_of: YYYY-MM-DD'); return this.s.aging(asOf); }
  @Get('payments') @Roles(...AP_READ) payments(@Query('from') from?: string, @Query('to') to?: string, @Query('include_void') iv?: string) {
    if (!from || !to || !dateOk(from) || !dateOk(to) || from > to) throw new BadRequestException('პერიოდი: from ≤ to (YYYY-MM-DD)');
    return this.s.payments(from, to, iv === 'true');
  }
}
