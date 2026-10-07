import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsNumber, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import type { Request } from 'express';
import { sql, type Transaction } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser } from '../auth/roles';
import { loadEnv } from '../config/env';
import { InjectDb, type Database } from '../database/database.module';
import { stockRules } from './stock-rules';
import type { DB } from '../database/db';
import { NotificationsService } from '../notifications/notifications';
import { STOCK_READ } from './stock-catalog';

const TZ = loadEnv().CLINIC_TZ;
type Trx = Transaction<DB>;
type Ex = Database | Trx;
const q3 = (n: number) => Math.round(n * 1000) / 1000;
const dge = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const OPEN = ['approved', 'partial'];
interface Loc { id: string; name: string; kind: string; department_id: string | null; requires_approval: boolean; is_active: boolean }
export interface ReqLineIn { item_id: string; pack_id?: string | null; qty: number; patient_id?: string | null; notes?: string | null }
export interface ReqIn { from_location_id: string; to_location_id: string; urgent?: boolean; notes?: string | null; lines: ReqLineIn[] }
export interface PickIn { request_line_id?: string; lot_id: string; qty_base: number; override_reason?: string | null; patient_id?: string | null }

/**
 * მოთხოვნა → დამტკიცება → გაცემა (FEFO, ნაწილობრივი) → მიღების დადასტურება; პირდაპირი გადაცემა და დაბრუნება.
 * გაცემისას მარაგი „გზაშია“ (TRANSIT) — მიმღების დადასტურებამდე არცერთ საწყობში არ ითვლება.
 */
@Injectable()
export class StockTransfersService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService, private readonly notifications: NotificationsService) {}
  private transitCache: string | null = null;

  private async transit(ex: Ex = this.db) {
    if (this.transitCache) return this.transitCache;
    const r = await ex.selectFrom('stock_locations').select('id').where('kind', '=', 'transit').executeTakeFirstOrThrow();
    return (this.transitCache = r.id);
  }
  async today(ex: Ex = this.db) {
    return (await sql<{ d: string }>`SELECT to_char((now() AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS d`.execute(ex)).rows[0].d;
  }
  async nextNo(trx: Trx, prefix: string, date: string) {
    const year = Number(date.slice(0, 4));
    const { last_value } = await trx.insertInto('document_counters').values({ document_type: `stock_${prefix}`, year, last_value: 1 })
      .onConflict((oc) => oc.columns(['document_type', 'year']).doUpdateSet({ last_value: sql`document_counters.last_value + 1` }))
      .returning('last_value').executeTakeFirstOrThrow();
    return `${prefix}${String(year).slice(2)}-${String(last_value).padStart(6, '0')}`;
  }
  async loc(id: string, ex: Ex = this.db): Promise<Loc> {
    const l = await ex.selectFrom('stock_locations').select(['id', 'name', 'kind', 'department_id', 'requires_approval', 'is_active']).where('id', '=', id).executeTakeFirst();
    if (!l) throw new BadRequestException('ლოკაცია ვერ მოიძებნა');
    if (l.kind === 'transit') throw new BadRequestException('„გზაში“ სისტემური ლოკაციაა');
    return l;
  }
  async me(u: AuthUser, ex: Ex = this.db) {
    return ex.selectFrom('users').select(['department_id', 'is_section_head']).where('id', '=', u.id).executeTakeFirstOrThrow();
  }
  /** ლოკაციით მუშაობა: საწყობი — ნებისმიერი; ფარმაცევტი — აფთიაქი; ლაბორატორია — ლაბორატორიის ქვესაწყობი; სხვა — მხოლოდ საკუთარი განყოფილების ქვესაწყობი */
  async canOperate(u: AuthUser, l: Loc, ex: Ex = this.db) {
    if (has(u, 'admin', 'stock_manager', 'storekeeper')) return true;
    if (has(u, 'pharmacist') && (l.kind === 'pharmacy' || (l.kind !== 'transit' && (await stockRules(this.db)).pharmacist_scope === 'any'))) return true;
    if (has(u, 'lab_doctor', 'lab_manager', 'diagnostic') && l.kind === 'lab') return true;   // ლაბორატორიის ქვესაწყობი (0036)
    if (!l.department_id) return false;
    return (await this.me(u, ex)).department_id === l.department_id;
  }
  async requireOperate(u: AuthUser, l: Loc, what: string, ex: Ex = this.db) {
    if (!l.is_active) throw new BadRequestException(`ლოკაცია „${l.name}“ გათიშულია`);
    if (!(await this.canOperate(u, l, ex))) throw new ForbiddenException(`${what}: ლოკაცია „${l.name}“ თქვენი არ არის`);
  }
  /** დამტკიცება: ადმინისტრატორი; განყოფილების ხელმძღვანელი ან მენეჯერი (საკუთარი განყოფილება); განყოფილების გარეშე ლოკაცია — საწყობის მენეჯერი */
  private async canApprove(u: AuthUser, to: Loc, ex: Ex = this.db) {
    if (has(u, 'admin')) return true;
    if (to.kind === 'lab' && has(u, 'lab_manager')) return true;                               // ლაბორატორიის მოთხოვნა — ლაბ. ხელმძღვანელი
    if (!to.department_id) return has(u, 'stock_manager');
    const m = await this.me(u, ex);
    return m.department_id === to.department_id && (m.is_section_head || has(u, 'manager'));
  }
  async usersWith(caps: string[], ex: Ex = this.db, departmentId?: string | null, headsOnly = false) {
    let x = ex.selectFrom('users as u').innerJoin('user_capabilities as c', 'c.user_id', 'u.id').select('u.id').where('u.is_active', '=', true)
      .where(sql<boolean>`c.capabilities && ${sql.val(caps)}::varchar[]`);
    if (departmentId) x = x.where('u.department_id', '=', departmentId);
    if (headsOnly) x = x.where((eb) => eb.or([eb('u.is_section_head', '=', true), eb(sql<boolean>`'manager' = ANY(c.capabilities)`, '=', true)]));
    return (await x.execute()).map((r) => r.id);
  }
  async notifyMany(ids: string[], n: { kind: string; title: string; body?: string; link: string; entityId: string; urgent?: boolean }, except?: string) {
    for (const id of new Set(ids)) if (id !== except) await this.notifications.notify(id, n).catch(() => undefined);
  }

  /** ლოკაციები, რომლებზეც მომხმარებელს მუშაობა შეუძლია (მოთხოვნა, დაბრუნება, მიღება) */
  async myLocations(u: AuthUser) {
    const all = await this.db.selectFrom('stock_locations').select(['id', 'code', 'name', 'kind', 'department_id', 'requires_approval', 'is_active'])
      .where('is_active', '=', true).where('kind', '<>', 'transit').orderBy('sort_order').orderBy('name').execute();
    const out = [];
    for (const l of all) if (await this.canOperate(u, l)) out.push(l);
    return out;
  }

  // ================================================================= მოთხოვნები
  async requests(u: AuthUser, q: { scope?: string; status?: string; location_id?: string }) {
    let x = this.db.selectFrom('stock_requests as r').innerJoin('stock_locations as f', 'f.id', 'r.from_location_id').innerJoin('stock_locations as t', 't.id', 'r.to_location_id')
      .innerJoin('users as cu', 'cu.id', 'r.created_by')
      .select(['r.id', 'r.req_no', 'r.status', 'r.urgent', 'r.requires_approval', 'r.created_at', 'r.submitted_at', 'r.approved_at', 'r.notes', 'r.from_location_id', 'r.to_location_id',
        'f.name as from_name', 't.name as to_name', 't.department_id as to_department_id', sql<string>`cu.first_name || ' ' || cu.last_name`.as('created_by_name'),
        sql<number>`(SELECT count(*)::int FROM stock_request_lines l WHERE l.request_id = r.id)`.as('lines'),
        sql<number>`(SELECT count(*)::int FROM stock_docs d WHERE d.request_id = r.id AND d.status = 'posted' AND d.receive_status IS NULL)`.as('in_transit')])
      .orderBy('r.urgent', 'desc').orderBy('r.created_at', 'desc').limit(500);
    if (q.status) x = x.where('r.status', 'in', q.status.split(','));
    if (q.location_id) x = x.where((eb) => eb.or([eb('r.from_location_id', '=', q.location_id!), eb('r.to_location_id', '=', q.location_id!)]));
    if (q.scope === 'mine') x = x.where('r.created_by', '=', u.id);
    const rows = await x.execute();
    // მხოლოდ ის, რაც მომხმარებელს ეხება (საწყობის როლებს — ყველა)
    if (has(u, 'admin', 'stock_manager', 'storekeeper', 'viewer', 'manager')) return rows;
    const me = await this.me(u);
    return rows.filter((r) => r.to_department_id === me.department_id || (has(u, 'pharmacist') && OPEN.includes(r.status)));
  }

  async request(id: string, ex: Ex = this.db) {
    const r = await ex.selectFrom('stock_requests as r').innerJoin('stock_locations as f', 'f.id', 'r.from_location_id').innerJoin('stock_locations as t', 't.id', 'r.to_location_id')
      .innerJoin('users as cu', 'cu.id', 'r.created_by').leftJoin('users as au', 'au.id', 'r.approved_by').leftJoin('users as ru', 'ru.id', 'r.rejected_by')
      .selectAll('r').select(['f.name as from_name', 'f.kind as from_kind', 't.name as to_name', 't.department_id as to_department_id',
        sql<string>`cu.first_name || ' ' || cu.last_name`.as('created_by_name'), sql<string | null>`au.first_name || ' ' || au.last_name`.as('approved_by_name'),
        sql<string | null>`ru.first_name || ' ' || ru.last_name`.as('rejected_by_name')])
      .where('r.id', '=', id).executeTakeFirst();
    if (!r) throw new NotFoundException('მოთხოვნა ვერ მოიძებნა');
    const lines = await ex.selectFrom('stock_request_lines as l').innerJoin('stock_items as i', 'i.id', 'l.item_id').innerJoin('stock_units as un', 'un.code', 'i.base_unit')
      .leftJoin('stock_item_packs as p', 'p.id', 'l.pack_id').leftJoin('med_generics as g', 'g.id', 'i.generic_id').leftJoin('patients as pt', 'pt.id', 'l.patient_id')
      .selectAll('l').select(['i.name as item_name', 'i.code as item_code', 'un.name as base_unit_name', 'p.name as pack_name', 'p.qty_base as pack_qty_base', 'g.controlled_class', 'g.patient_only',
        sql<string | null>`pt.first_name || ' ' || pt.last_name`.as('patient_name'), 'pt.personal_number as patient_pn',
        sql<string>`coalesce((SELECT sum(b.qty) FROM stock_balances b JOIN stock_lots lt ON lt.id = b.lot_id WHERE b.item_id = l.item_id AND b.location_id = ${r.from_location_id}
          AND lt.status = 'active' AND (lt.expires_on IS NULL OR lt.expires_on >= (now() AT TIME ZONE ${TZ})::date)), 0)`.as('available'),
        sql<string>`coalesce((SELECT sum(b.qty) FROM stock_balances b WHERE b.item_id = l.item_id AND b.location_id = ${r.to_location_id}), 0)`.as('on_hand_to')])
      .where('l.request_id', '=', id).orderBy('l.line_no').execute();
    const docs = await ex.selectFrom('stock_docs as d').leftJoin('users as ru', 'ru.id', 'd.received_by')
      .select(['d.id', 'd.doc_no', 'd.doc_type', 'd.posted_at', 'd.receive_status', 'd.received_at', 'd.receive_note', sql<string | null>`ru.first_name || ' ' || ru.last_name`.as('received_by_name')])
      .where('d.request_id', '=', id).where('d.status', '=', 'posted').orderBy('d.posted_at').execute();
    return { ...r, lines, docs };
  }

  private async buildReqLines(trx: Trx, lines: ReqLineIn[]) {
    const ids = [...new Set(lines.map((l) => l.item_id))];
    const items = ids.length ? await trx.selectFrom('stock_items as i').leftJoin('med_generics as g', 'g.id', 'i.generic_id').select(['i.id', 'i.name', 'i.is_active', 'g.patient_only']).where('i.id', 'in', ids).execute() : [];
    const packIds = lines.map((l) => l.pack_id).filter((p): p is string => !!p);
    const packs = packIds.length ? await trx.selectFrom('stock_item_packs').select(['id', 'item_id', 'qty_base']).where('id', 'in', packIds).execute() : [];
    return lines.map((l, i) => {
      const it = items.find((x) => x.id === l.item_id);
      if (!it) throw new BadRequestException(`ხაზი ${i + 1}: საქონელი ვერ მოიძებნა`);
      if (!it.is_active) throw new BadRequestException(`ხაზი ${i + 1}: „${it.name}“ გათიშულია`);
      const p = l.pack_id ? packs.find((x) => x.id === l.pack_id && x.item_id === l.item_id) : null;
      if (l.pack_id && !p) throw new BadRequestException(`ხაზი ${i + 1}: შეფუთვა „${it.name}“-ს არ ეკუთვნის`);
      return { line_no: i + 1, item_id: l.item_id, pack_id: p?.id ?? null, qty: String(l.qty), qty_base: String(q3(l.qty * (p ? Number(p.qty_base) : 1))),
        patient_id: l.patient_id ?? null, notes: l.notes?.trim() || null };
    });
  }

  async createRequest(dto: ReqIn, u: AuthUser, ctx: AuditContext) {
    const [from, to] = [await this.loc(dto.from_location_id), await this.loc(dto.to_location_id)];
    if (from.id === to.id) throw new BadRequestException('გამცემი და მიმღები ერთი ლოკაციაა');
    await this.requireOperate(u, to, 'მოთხოვნა');
    if (!from.is_active) throw new BadRequestException(`ლოკაცია „${from.name}“ გათიშულია`);
    const id = await this.db.transaction().execute(async (trx) => {
      const lines = await this.buildReqLines(trx, dto.lines);
      const r = await trx.insertInto('stock_requests').values({ from_location_id: from.id, to_location_id: to.id, urgent: !!dto.urgent, notes: dto.notes?.trim() || null, created_by: u.id })
        .returning('id').executeTakeFirstOrThrow();
      if (lines.length) await trx.insertInto('stock_request_lines').values(lines.map((l) => ({ ...l, request_id: r.id }))).execute();
      await this.audit.log(ctx, { action: 'CREATE_STOCK_REQUEST', entityName: 'stock_requests', entityId: r.id, newData: { ...dto, lines: dto.lines.length } }, trx);
      return r.id;
    });
    return this.request(id);
  }

  async updateRequest(id: string, dto: ReqIn, u: AuthUser, ctx: AuditContext) {
    const [from, to] = [await this.loc(dto.from_location_id), await this.loc(dto.to_location_id)];
    if (from.id === to.id) throw new BadRequestException('გამცემი და მიმღები ერთი ლოკაციაა');
    await this.requireOperate(u, to, 'მოთხოვნა');
    await this.db.transaction().execute(async (trx) => {
      const r = await trx.selectFrom('stock_requests').select(['status', 'to_location_id']).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!r) throw new NotFoundException('მოთხოვნა ვერ მოიძებნა');
      if (r.status !== 'draft') throw new ConflictException('მხოლოდ მონახაზი იცვლება');
      await this.requireOperate(u, await this.loc(r.to_location_id, trx), 'მოთხოვნა', trx);
      const lines = await this.buildReqLines(trx, dto.lines);
      await trx.updateTable('stock_requests').set({ from_location_id: from.id, to_location_id: to.id, urgent: !!dto.urgent, notes: dto.notes?.trim() || null }).where('id', '=', id).execute();
      await trx.deleteFrom('stock_request_lines').where('request_id', '=', id).execute();
      if (lines.length) await trx.insertInto('stock_request_lines').values(lines.map((l) => ({ ...l, request_id: id }))).execute();
      await this.audit.log(ctx, { action: 'UPDATE_STOCK_REQUEST', entityName: 'stock_requests', entityId: id, newData: { ...dto, lines: dto.lines.length } }, trx);
    });
    return this.request(id);
  }

  async submit(id: string, u: AuthUser, ctx: AuditContext) {
    const res = await this.db.transaction().execute(async (trx) => {
      const r = await this.request(id, trx);
      if (r.status !== 'draft') throw new ConflictException('მოთხოვნა უკვე გაგზავნილია');
      const to = await this.loc(r.to_location_id, trx);
      await this.requireOperate(u, to, 'მოთხოვნა', trx);
      if (!r.lines.length) throw new BadRequestException('მოთხოვნას ხაზი არ აქვს');
      const noPatient = r.lines.filter((l) => l.patient_only && !l.patient_id);
      if (noPatient.length) throw new BadRequestException(`„მხოლოდ პაციენტზე“ საქონელს პაციენტი სჭირდება: ${noPatient.map((l) => l.item_name).join(', ')}`);
      const controlled = r.lines.some((l) => l.controlled_class);
      const needs = to.requires_approval || controlled;
      const today = await this.today(trx);
      const no = await this.nextNo(trx, 'RQ', today);
      await trx.updateTable('stock_requests').set({ req_no: no, status: needs ? 'submitted' : 'approved', requires_approval: needs, submitted_at: sql`now()`, ...(!needs && { approved_at: sql`now()` }) })
        .where('id', '=', id).execute();
      if (!needs) await trx.updateTable('stock_request_lines').set({ qty_approved: sql`qty_base` }).where('request_id', '=', id).execute();
      await this.audit.log(ctx, { action: 'SUBMIT_STOCK_REQUEST', entityName: 'stock_requests', entityId: id, newData: { req_no: no, requires_approval: needs, controlled } }, trx);
      return { no, needs, to, r };
    });
    const link = `/stock/requests?req=${id}`;
    if (res.needs) {
      const heads = res.to.kind === 'lab' ? await this.usersWith(['lab_manager']) : res.to.department_id ? await this.usersWith(['manager', ...STOCK_READ], this.db, res.to.department_id, true) : await this.usersWith(['stock_manager']);
      await this.notifyMany(heads, { kind: 'stock_approve', title: `მოთხოვნა ${res.no} — დასამტკიცებელი`, body: `${res.r.to_name} ← ${res.r.from_name}`, link, entityId: id, urgent: res.r.urgent }, u.id);
    } else await this.notifyIssuers(id, res.no, res.r.from_kind, res.r.to_name, res.r.urgent, u.id);
    return this.request(id);
  }
  private async notifyIssuers(id: string, no: string, fromKind: string, toName: string, urgent: boolean, except?: string) {
    const ids = await this.usersWith(fromKind === 'pharmacy' ? ['storekeeper', 'stock_manager', 'pharmacist'] : ['storekeeper', 'stock_manager']);
    await this.notifyMany(ids, { kind: 'stock_issue', title: `მოთხოვნა ${no} — გასაცემი`, body: toName, link: `/stock/requests?req=${id}`, entityId: id, urgent }, except);
  }

  /**
   * 0042: აფთიაქიდან პაციენტზე გაცემის მოთხოვნა — ფარმაცევტის ვერიფიკაციისას (დანიშნულებიდან).
   * ვერიფიკაცია = დამტკიცება (კონტროლირებადზე — ჩვეულებრივი წესით, განყოფილების ხელმძღვანელი); შემდეგ — ჩვეულებრივი გაცემა / მიღება.
   */
  async createPatientDispense(trx: Trx, p: { toLocationId: string; itemId: string; qtyBase: number; patientId: string; urgent: boolean; notes: string }, u: AuthUser) {
    const from = await trx.selectFrom('stock_locations').select(['id', 'name', 'is_active']).where('kind', '=', 'pharmacy').where('is_active', '=', true)
      .orderBy('sort_order').limit(1).executeTakeFirst();
    if (!from) throw new BadRequestException('აქტიური აფთიაქის ლოკაცია არ არის');
    const to = await this.loc(p.toLocationId, trx);
    const lines = await this.buildReqLines(trx, [{ item_id: p.itemId, qty: p.qtyBase, patient_id: p.patientId }]);
    const it = await trx.selectFrom('stock_items as i').leftJoin('med_generics as g', 'g.id', 'i.generic_id').select(['g.controlled_class']).where('i.id', '=', p.itemId).executeTakeFirstOrThrow();
    const needs = !!it.controlled_class;
    const no = await this.nextNo(trx, 'RQ', await this.today(trx));
    const r = await trx.insertInto('stock_requests').values({ req_no: no, from_location_id: from.id, to_location_id: to.id, urgent: p.urgent, notes: p.notes, created_by: u.id,
      status: needs ? 'submitted' : 'approved', requires_approval: needs, submitted_at: sql`now()`, ...(!needs && { approved_by: u.id, approved_at: sql`now()` }) })
      .returning('id').executeTakeFirstOrThrow();
    await trx.insertInto('stock_request_lines').values(lines.map((l) => ({ ...l, request_id: r.id, ...(!needs && { qty_approved: l.qty_base }) }))).execute();
    return { id: r.id, no, needs, to_name: to.name, to_department_id: to.department_id };
  }
  /** createPatientDispense-ის შემდეგ (ტრანზაქციის გარეთ): შეტყობინება გამცემებს ან დამმტკიცებლებს */
  async notifyPatientDispense(r: { id: string; no: string; needs: boolean; to_name: string; to_department_id: string | null }, urgent: boolean, u: AuthUser) {
    if (r.needs && r.to_department_id) {
      const heads = await this.usersWith(['manager', ...STOCK_READ], this.db, r.to_department_id, true);
      await this.notifyMany(heads, { kind: 'stock_approve', title: `მოთხოვნა ${r.no} — დასამტკიცებელი`, body: `${r.to_name} ← აფთიაქი`, link: `/stock/requests?req=${r.id}`, entityId: r.id, urgent }, u.id);
    } else await this.notifyIssuers(r.id, r.no, 'pharmacy', r.to_name, urgent, u.id);
  }

  async approve(id: string, lines: { id: string; qty_approved: number }[] | undefined, u: AuthUser, ctx: AuditContext) {
    const r0 = await this.db.transaction().execute(async (trx) => {
      const r = await this.request(id, trx);
      if (r.status !== 'submitted') throw new ConflictException('დასამტკიცებელი მხოლოდ გაგზავნილი მოთხოვნაა');
      if (!(await this.canApprove(u, await this.loc(r.to_location_id, trx), trx))) throw new ForbiddenException('მოთხოვნას ამტკიცებს განყოფილების ხელმძღვანელი');
      for (const l of r.lines) {
        const x = lines?.find((y) => y.id === l.id);
        const qa = x ? q3(x.qty_approved) : Number(l.qty_base);
        if (qa > Number(l.qty_base)) throw new BadRequestException(`„${l.item_name}“: დამტკიცებული მოთხოვნილზე მეტია`);
        await trx.updateTable('stock_request_lines').set({ qty_approved: String(qa) }).where('id', '=', l.id).execute();
      }
      if (lines?.some((x) => !r.lines.some((l) => l.id === x.id))) throw new BadRequestException('ხაზი ამ მოთხოვნას არ ეკუთვნის');
      const all0 = r.lines.every((l) => { const x = lines?.find((y) => y.id === l.id); return x ? x.qty_approved === 0 : false; });
      if (all0) throw new BadRequestException('ყველა ხაზი 0 — გამოიყენეთ უარყოფა');
      await trx.updateTable('stock_requests').set({ status: 'approved', approved_by: u.id, approved_at: sql`now()` }).where('id', '=', id).execute();
      await this.audit.log(ctx, { action: 'APPROVE_STOCK_REQUEST', entityName: 'stock_requests', entityId: id, newData: { lines } }, trx);
      return r;
    });
    await this.notifyIssuers(id, r0.req_no!, r0.from_kind, r0.to_name, r0.urgent, u.id);
    await this.notifyMany([r0.created_by], { kind: 'stock_request', title: `მოთხოვნა ${r0.req_no} დამტკიცდა`, link: `/stock/requests?req=${id}`, entityId: id }, u.id);
    return this.request(id);
  }

  async reject(id: string, reason: string, u: AuthUser, ctx: AuditContext) {
    const r0 = await this.db.transaction().execute(async (trx) => {
      const r = await this.request(id, trx);
      if (r.status !== 'submitted') throw new ConflictException('უარყოფა შესაძლებელია მხოლოდ გაგზავნილზე');
      if (!(await this.canApprove(u, await this.loc(r.to_location_id, trx), trx))) throw new ForbiddenException('მოთხოვნას ამტკიცებს / უარყოფს განყოფილების ხელმძღვანელი');
      await trx.updateTable('stock_requests').set({ status: 'rejected', rejected_by: u.id, rejected_at: sql`now()`, reason: reason.trim() }).where('id', '=', id).execute();
      await this.audit.log(ctx, { action: 'REJECT_STOCK_REQUEST', entityName: 'stock_requests', entityId: id, newData: { reason } }, trx);
      return r;
    });
    await this.notifyMany([r0.created_by], { kind: 'stock_request', title: `მოთხოვნა ${r0.req_no} უარყოფილია`, body: reason, link: `/stock/requests?req=${id}`, entityId: id }, u.id);
    return this.request(id);
  }

  /** გაუქმება (მონახაზი / გაგზავნილი — მომთხოვნი) ან დახურვა (დამტკიცებული / ნაწილობრივ გაცემული — დარჩენილი აღარ გაიცემა) */
  async cancel(id: string, reason: string | undefined, u: AuthUser, ctx: AuditContext) {
    await this.db.transaction().execute(async (trx) => {
      const r = await trx.selectFrom('stock_requests').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!r) throw new NotFoundException('მოთხოვნა ვერ მოიძებნა');
      const to = await this.loc(r.to_location_id, trx); const from = await this.loc(r.from_location_id, trx);
      let status: 'cancelled' | 'closed';
      if (['draft', 'submitted'].includes(r.status)) { await this.requireOperate(u, to, 'გაუქმება', trx); status = 'cancelled'; }
      else if (OPEN.includes(r.status)) {
        if (!(await this.canOperate(u, to, trx)) && !(await this.canOperate(u, from, trx))) throw new ForbiddenException('დახურვა: ლოკაცია თქვენი არ არის');
        if (!reason || reason.trim().length < 3) throw new BadRequestException('დახურვის მიზეზი სავალდებულოა');
        status = 'closed';
      } else throw new ConflictException('მოთხოვნა უკვე დასრულებულია');
      await trx.updateTable('stock_requests').set({ status, reason: reason?.trim() || null, ...(status === 'closed' && { closed_at: sql`now()` }) }).where('id', '=', id).execute();
      await this.audit.log(ctx, { action: status === 'closed' ? 'CLOSE_STOCK_REQUEST' : 'CANCEL_STOCK_REQUEST', entityName: 'stock_requests', entityId: id, newData: { reason } }, trx);
    });
    return this.request(id);
  }

  // ================================================================= FEFO: ლოტების შეთავაზება
  async availableLots(itemId: string, locationId: string, ex: Ex = this.db) {
    const today = await this.today(ex);
    return ex.selectFrom('stock_balances as b').innerJoin('stock_lots as lt', 'lt.id', 'b.lot_id')
      .select(['lt.id as lot_id', 'lt.lot_no', 'lt.serial_no', 'lt.expires_on', 'lt.status', 'lt.unit_cost', 'b.qty'])
      .where('b.item_id', '=', itemId).where('b.location_id', '=', locationId).where('b.qty', '>', '0')
      .where('lt.status', '=', 'active').where((eb) => eb.or([eb('lt.expires_on', 'is', null), eb('lt.expires_on', '>=', today)]))
      .orderBy(sql`lt.expires_on NULLS LAST`).orderBy('lt.created_at').orderBy('lt.id').execute();
  }

  allLots(itemId: string, locationId: string) {
    return this.db.selectFrom('stock_balances as b').innerJoin('stock_lots as lt', 'lt.id', 'b.lot_id')
      .select(['lt.id as lot_id', 'lt.lot_no', 'lt.serial_no', 'lt.expires_on', 'lt.status', 'lt.unit_cost', 'b.qty'])
      .where('b.item_id', '=', itemId).where('b.location_id', '=', locationId).where('b.qty', '>', '0')
      .orderBy(sql`lt.expires_on NULLS LAST`).orderBy('lt.created_at').execute();
  }

  async pick(id: string) {
    const r = await this.request(id);
    if (!OPEN.includes(r.status)) throw new ConflictException('გასაცემი მხოლოდ დამტკიცებული მოთხოვნაა');
    const out = [];
    for (const l of r.lines) {
      let need = q3(Number(l.qty_approved ?? 0) - Number(l.qty_issued));
      const lots = await this.availableLots(l.item_id, r.from_location_id);
      const alloc = [];
      for (const lt of lots) {
        if (need <= 0) break;
        const q = Math.min(need, Number(lt.qty)); need = q3(need - q);
        alloc.push({ lot_id: lt.lot_id, lot_no: lt.lot_no, serial_no: lt.serial_no, expires_on: lt.expires_on, available: lt.qty, qty: q3(q) });
      }
      out.push({ request_line_id: l.id, item_id: l.item_id, item_name: l.item_name, base_unit_name: l.base_unit_name, remaining: q3(Number(l.qty_approved ?? 0) - Number(l.qty_issued)),
        shortage: q3(Math.max(0, need)), lots: lots.map((x) => ({ lot_id: x.lot_id, lot_no: x.lot_no, serial_no: x.serial_no, expires_on: x.expires_on, available: x.qty })), alloc });
    }
    return { request: r, lines: out };
  }

  // ================================================================= გაგზავნა (გაცემა / გადაცემა / დაბრუნება)
  /** ხაზები: ლოტი, რაოდენობა; FEFO — თუ არჩეულია არა ყველაზე ადრე ვადაგასვლადი ხელმისაწვდომი ლოტი, მიზეზი სავალდებულოა */
  private async send(trx: Trx, h: { doc_type: 'transfer' | 'return'; from: Loc; to: Loc; request_id?: string | null; notes?: string | null }, picks: PickIn[], fefo: boolean, u: AuthUser) {
    if (!picks.length) throw new BadRequestException('გასაცემი ხაზი არ არის');
    const transit = await this.transit(trx);
    const today = await this.today(trx);
    const d = await trx.insertInto('stock_docs').values({ doc_type: h.doc_type, doc_date: today, from_location_id: h.from.id, to_location_id: h.to.id, request_id: h.request_id ?? null,
      notes: h.notes?.trim() || null, created_by: u.id }).returning('id').executeTakeFirstOrThrow();
    let n = 0;
    for (const p of picks) {
      const lot = await trx.selectFrom('stock_lots as lt').innerJoin('stock_items as i', 'i.id', 'lt.item_id')
        .select(['lt.id', 'lt.item_id', 'lt.lot_no', 'lt.serial_no', 'lt.expires_on', 'lt.produced_on', 'lt.status', 'lt.unit_cost', 'i.name']).where('lt.id', '=', p.lot_id).executeTakeFirst();
      if (!lot) throw new BadRequestException('ლოტი ვერ მოიძებნა');
      const tag = `„${lot.name}“${lot.lot_no ? ` (ლოტი ${lot.lot_no})` : ''}`;
      // დაბრუნება საწყობში: დაბლოკილი / ვადაგასული ლოტიც შეიძლება (გაწვეულის შეგროვება, ჩამოსაწერად); გაცემა / გადაცემა — არა
      if (h.doc_type !== 'return' && lot.status !== 'active') throw new BadRequestException(`${tag} დაბლოკილია (${lot.status === 'recalled' ? 'გაწვეული' : 'ქარანტინი'})`);
      if (h.doc_type !== 'return' && lot.expires_on && lot.expires_on < today) throw new BadRequestException(`${tag} ვადაგასულია (${dge(lot.expires_on)}) — გაცემა აკრძალულია`);
      if (fefo) {
        const first = (await this.availableLots(lot.item_id, h.from.id, trx))[0];
        if (first && first.lot_id !== lot.id && (first.expires_on ?? '9999') < (lot.expires_on ?? '9999') && !p.override_reason?.trim())
          throw new BadRequestException(`${tag}: FEFO-ით ჯერ გაიცემა ლოტი ${first.lot_no ?? ''} (${first.expires_on ? dge(first.expires_on) : '—'}) — სხვა ლოტისთვის მიუთითეთ მიზეზი`);
      }
      const q = q3(p.qty_base);
      if (!(q > 0)) throw new BadRequestException(`${tag}: რაოდენობა > 0`);
      if (lot.serial_no && q !== 1) throw new BadRequestException(`${tag}: სერიული — 1 ერთეული`);
      n++;
      const line = await trx.insertInto('stock_doc_lines').values({ doc_id: d.id, line_no: n, item_id: lot.item_id, qty: String(q), qty_base: String(q), lot_no: lot.lot_no, serial_no: lot.serial_no,
        expires_on: lot.expires_on, produced_on: lot.produced_on, unit_cost: lot.unit_cost, lot_id: lot.id, request_line_id: p.request_line_id ?? null, patient_id: p.patient_id ?? null,
        override_reason: p.override_reason?.trim() || null }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('stock_moves').values([
        { doc_id: d.id, line_id: line.id, move_type: 'transfer', location_id: h.from.id, lot_id: lot.id, item_id: lot.item_id, qty: String(-q), cost_lot: lot.unit_cost, created_by: u.id },
        { doc_id: d.id, line_id: line.id, move_type: 'transfer', location_id: transit, lot_id: lot.id, item_id: lot.item_id, qty: String(q), cost_lot: lot.unit_cost, created_by: u.id },
      ]).execute();
    }
    const no = await this.nextNo(trx, h.doc_type === 'return' ? 'RT' : 'TR', today);
    await trx.updateTable('stock_docs').set({ status: 'posted', doc_no: no, posted_by: u.id, posted_at: sql`now()` }).where('id', '=', d.id).execute();
    return { id: d.id, no };
  }

  private async recalc(trx: Trx, requestId: string) {
    const lines = await trx.selectFrom('stock_request_lines').select(['qty_approved', 'qty_issued']).where('request_id', '=', requestId).execute();
    const full = lines.every((l) => Number(l.qty_issued) >= Number(l.qty_approved ?? 0));
    const any = lines.some((l) => Number(l.qty_issued) > 0);
    await trx.updateTable('stock_requests').set({ status: full ? 'issued' : any ? 'partial' : 'approved' }).where('id', '=', requestId).where('status', 'in', OPEN.concat('issued')).execute();
  }

  async issue(id: string, picks: PickIn[], notes: string | undefined, u: AuthUser, ctx: AuditContext) {
    let res = { id: '', no: '' }; let creator = ''; let reqNo = '';
    try {
      await this.db.transaction().execute(async (trx) => {
        const r = await trx.selectFrom('stock_requests').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
        if (!r) throw new NotFoundException('მოთხოვნა ვერ მოიძებნა');
        if (!OPEN.includes(r.status)) throw new ConflictException('გასაცემი მხოლოდ დამტკიცებული მოთხოვნაა');
        const from = await this.loc(r.from_location_id, trx); const to = await this.loc(r.to_location_id, trx);
        await this.requireOperate(u, from, 'გაცემა', trx);
        const lines = await trx.selectFrom('stock_request_lines').selectAll().where('request_id', '=', id).execute();
        const per = new Map<string, number>();
        for (const p of picks) {
          const l = lines.find((x) => x.id === p.request_line_id);
          if (!l) throw new BadRequestException('ხაზი ამ მოთხოვნას არ ეკუთვნის');
          const lot = await trx.selectFrom('stock_lots').select('item_id').where('id', '=', p.lot_id).executeTakeFirst();
          if (lot?.item_id !== l.item_id) throw new BadRequestException('ლოტი სხვა საქონელს ეკუთვნის');
          per.set(l.id, q3((per.get(l.id) ?? 0) + p.qty_base));
          p.patient_id = l.patient_id;
        }
        for (const [lid, q] of per) {
          const l = lines.find((x) => x.id === lid)!;
          const rem = q3(Number(l.qty_approved ?? 0) - Number(l.qty_issued));
          if (q > rem) throw new BadRequestException(`ხაზი ${l.line_no}: გასაცემი (${q}) დარჩენილზე (${rem}) მეტია`);
          await trx.updateTable('stock_request_lines').set({ qty_issued: String(q3(Number(l.qty_issued) + q)) }).where('id', '=', lid).execute();
        }
        res = await this.send(trx, { doc_type: 'transfer', from, to, request_id: id, notes: notes ?? `მოთხოვნა ${r.req_no}` }, picks, true, u);
        await this.recalc(trx, id);
        creator = r.created_by; reqNo = r.req_no ?? '';
        await this.audit.log(ctx, { action: 'ISSUE_STOCK_REQUEST', entityName: 'stock_requests', entityId: id, newData: { doc_id: res.id, doc_no: res.no, lines: picks.length } }, trx);
      });
    } catch (e) { this.mapErr(e); }
    if ((await stockRules(this.db)).issue_mode === 'one_step') {
      await this.receive(res.id, 'receive', 'ცალმხრივი გაცემა', u, ctx, true);
      await this.notifyMany([creator], { kind: 'stock_receive', title: `${res.no} გაცემულია და ჩაირიცხა`, body: `მოთხოვნა ${reqNo}`, link: `/stock/requests?req=${id}`, entityId: res.id }, u.id);
    } else await this.notifyMany([creator], { kind: 'stock_receive', title: `${res.no} გაგზავნილია — დაადასტურეთ მიღება`, body: `მოთხოვნა ${reqNo}`, link: `/stock/transit`, entityId: res.id }, u.id);
    return this.request(id);
  }

  /** პირდაპირი გადაცემა (საწყობი → ლოკაცია) ან დაბრუნება (ქვესაწყობი → აფთიაქი / საწყობი) */
  async transfer(dto: { doc_type: 'transfer' | 'return'; from_location_id: string; to_location_id: string; notes?: string | null; lines: PickIn[] }, u: AuthUser, ctx: AuditContext) {
    let res = { id: '', no: '' };
    const from = await this.loc(dto.from_location_id); const to = await this.loc(dto.to_location_id);
    if (from.id === to.id) throw new BadRequestException('გამცემი და მიმღები ერთი ლოკაციაა');
    await this.requireOperate(u, from, dto.doc_type === 'return' ? 'დაბრუნება' : 'გადაცემა');
    if (!to.is_active) throw new BadRequestException(`ლოკაცია „${to.name}“ გათიშულია`);
    if (dto.doc_type === 'return' && !dto.notes?.trim()) throw new BadRequestException('დაბრუნების მიზეზი (შენიშვნა) სავალდებულოა');
    try {
      await this.db.transaction().execute(async (trx) => {
        res = await this.send(trx, { doc_type: dto.doc_type, from, to, notes: dto.notes }, dto.lines.map((l) => ({ ...l, request_line_id: undefined })), dto.doc_type === 'transfer', u);
        await this.audit.log(ctx, { action: dto.doc_type === 'return' ? 'RETURN_STOCK' : 'TRANSFER_STOCK', entityName: 'stock_docs', entityId: res.id, newData: { ...dto, doc_no: res.no } }, trx);
      });
    } catch (e) { this.mapErr(e); }
    if ((await stockRules(this.db)).issue_mode === 'one_step') { await this.receive(res.id, 'receive', 'ცალმხრივი გაცემა', u, ctx, true); return res; }
    const receivers = to.department_id ? (await this.db.selectFrom('users').select('id').where('department_id', '=', to.department_id).where('is_active', '=', true).execute()).map((x) => x.id)
      : await this.usersWith(to.kind === 'pharmacy' ? ['storekeeper', 'stock_manager', 'pharmacist'] : ['storekeeper', 'stock_manager']);
    await this.notifyMany(receivers.slice(0, 50), { kind: 'stock_receive', title: `${res.no} — მისაღები (${from.name})`, link: '/stock/transit', entityId: res.id }, u.id);
    return res;
  }

  // ================================================================= მიღების დადასტურება / უკან დაბრუნება
  async transitList(u: AuthUser, scope: 'incoming' | 'outgoing' | 'all') {
    const rows = await this.db.selectFrom('stock_docs as d').innerJoin('stock_locations as f', 'f.id', 'd.from_location_id').innerJoin('stock_locations as t', 't.id', 'd.to_location_id')
      .leftJoin('stock_requests as r', 'r.id', 'd.request_id').innerJoin('users as pu', 'pu.id', 'd.created_by')
      .select(['d.id', 'd.doc_no', 'd.doc_type', 'd.posted_at', 'd.notes', 'd.from_location_id', 'd.to_location_id', 'f.name as from_name', 't.name as to_name', 'f.kind as from_kind', 't.kind as to_kind',
        'f.department_id as from_department_id', 't.department_id as to_department_id', 'r.req_no', sql<string>`pu.first_name || ' ' || pu.last_name`.as('sent_by_name'),
        sql<number>`(SELECT count(*)::int FROM stock_doc_lines x WHERE x.doc_id = d.id)`.as('lines')])
      .where('d.status', '=', 'posted').where('d.receive_status', 'is', null).where('d.doc_type', 'in', ['transfer', 'return']).orderBy('d.posted_at').execute();
    const out = [];
    for (const r of rows) {
      const inc = await this.canOperate(u, { id: r.to_location_id!, name: r.to_name, kind: r.to_kind, department_id: r.to_department_id, requires_approval: false, is_active: true });
      const outg = await this.canOperate(u, { id: r.from_location_id!, name: r.from_name, kind: r.from_kind, department_id: r.from_department_id, requires_approval: false, is_active: true });
      if ((scope === 'incoming' && inc) || (scope === 'outgoing' && outg) || (scope === 'all' && (inc || outg || has(u, 'viewer', 'manager')))) out.push({ ...r, can_receive: inc });
    }
    return out;
  }

  /** system=true — ცალმხრივი გაცემა (0038, issue_mode = one_step): ჩაირიცხება გამგზავნის სახელით, მიმღების დადასტურების გარეშე */
  async receive(docId: string, action: 'receive' | 'return', note: string | undefined, u: AuthUser, ctx: AuditContext, system = false) {
    let notify: { to: string[]; title: string } | null = null;
    try {
      await this.db.transaction().execute(async (trx) => {
        const d = await trx.selectFrom('stock_docs').selectAll().where('id', '=', docId).forUpdate().executeTakeFirst();
        if (!d || !['transfer', 'return'].includes(d.doc_type)) throw new NotFoundException('გადაცემის დოკუმენტი ვერ მოიძებნა');
        if (d.status !== 'posted') throw new ConflictException('დოკუმენტი გაგზავნილი არ არის');
        if (d.receive_status) throw new ConflictException(d.receive_status === 'received' ? 'უკვე მიღებულია' : 'უკვე დაბრუნებულია გამგზავნთან');
        const to = await this.loc(d.to_location_id!, trx);
        if (!system && !(await this.canOperate(u, to, trx))) throw new ForbiddenException(`მიღებას ადასტურებს „${to.name}“`);
        if (action === 'return' && (!note || note.trim().length < 3)) throw new BadRequestException('უარის მიზეზი სავალდებულოა');
        const transit = await this.transit(trx);
        const dest = action === 'receive' ? d.to_location_id! : d.from_location_id!;
        const lines = await trx.selectFrom('stock_doc_lines').selectAll().where('doc_id', '=', docId).execute();
        for (const l of lines) {
          await trx.insertInto('stock_moves').values([
            { doc_id: docId, line_id: l.id, move_type: 'transfer', location_id: transit, lot_id: l.lot_id!, item_id: l.item_id, qty: String(-Number(l.qty_base)), cost_lot: l.unit_cost ?? '0', created_by: u.id },
            { doc_id: docId, line_id: l.id, move_type: 'transfer', location_id: dest, lot_id: l.lot_id!, item_id: l.item_id, qty: l.qty_base, cost_lot: l.unit_cost ?? '0', created_by: u.id },
          ]).execute();
          if (action === 'return' && l.request_line_id) {
            await trx.updateTable('stock_request_lines').set({ qty_issued: sql`greatest(0, qty_issued - ${l.qty_base}::numeric)` }).where('id', '=', l.request_line_id).execute();
          }
        }
        await trx.updateTable('stock_docs').set({ receive_status: action === 'receive' ? 'received' : 'returned', received_by: u.id, received_at: sql`now()`, receive_note: note?.trim() || null })
          .where('id', '=', docId).execute();
        if (action === 'return' && d.request_id) await this.recalc(trx, d.request_id);
        await this.audit.log(ctx, { action: action === 'receive' ? 'RECEIVE_STOCK_TRANSFER' : 'REFUSE_STOCK_TRANSFER', entityName: 'stock_docs', entityId: docId, newData: { note } }, trx);
        if (action === 'return') notify = { to: [d.created_by], title: `${d.doc_no}: მიმღებმა არ მიიღო — მარაგი დაბრუნდა` };
      });
    } catch (e) { this.mapErr(e); }
    if (notify) { const n = notify as { to: string[]; title: string }; await this.notifyMany(n.to, { kind: 'stock_receive', title: n.title, body: note, link: '/stock/transit', entityId: docId }, u.id); }
    return this.db.selectFrom('stock_docs').select(['id', 'doc_no', 'receive_status', 'received_at']).where('id', '=', docId).executeTakeFirstOrThrow();
  }

  private mapErr(e: unknown): never {
    const err = e as { constraint?: string };
    if (err.constraint === 'stock_balances_non_negative') throw new ConflictException('ნაშთი არასაკმარისია (ლოტის ნაშთი ამ ლოკაციაზე ნაკლებია)');
    throw e;
  }
}

// ======================================================================= DTO
class ReqLineDto {
  @IsUUID() item_id: string; @IsOptional() @IsUUID() pack_id?: string | null; @IsNumber() @Min(0.001) @Max(1_000_000) qty: number;
  @IsOptional() @IsUUID() patient_id?: string | null; @IsOptional() @IsString() @MaxLength(500) notes?: string | null;
}
class ReqDto {
  @IsUUID() from_location_id: string; @IsUUID() to_location_id: string; @IsOptional() @IsBoolean() urgent?: boolean; @IsOptional() @IsString() @MaxLength(1000) notes?: string | null;
  @IsArray() @ArrayMaxSize(300) @ValidateNested({ each: true }) @Type(() => ReqLineDto) lines: ReqLineDto[];
}
class ApproveLineDto { @IsUUID() id: string; @IsNumber() @Min(0) qty_approved: number }
class ApproveDto { @IsOptional() @IsArray() @ArrayMaxSize(300) @ValidateNested({ each: true }) @Type(() => ApproveLineDto) lines?: ApproveLineDto[] }
class PickDto {
  @IsOptional() @IsUUID() request_line_id?: string; @IsUUID() lot_id: string; @IsNumber() @Min(0.001) @Max(1_000_000) qty_base: number;
  @IsOptional() @IsString() @MaxLength(500) override_reason?: string | null;
}
class IssueDto { @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => PickDto) lines: PickDto[]; @IsOptional() @IsString() @MaxLength(1000) notes?: string }
class TransferDto {
  @IsIn(['transfer', 'return']) doc_type: 'transfer' | 'return'; @IsUUID() from_location_id: string; @IsUUID() to_location_id: string; @IsOptional() @IsString() @MaxLength(1000) notes?: string | null;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => PickDto) lines: PickDto[];
}
class ReasonDto { @IsString() @Length(3, 500) reason: string }
class OptReasonDto { @IsOptional() @IsString() @MaxLength(500) reason?: string }
class ReceiveDto { @IsIn(['receive', 'return']) action: 'receive' | 'return'; @IsOptional() @IsString() @MaxLength(500) note?: string }

@Controller('stock')
export class StockTransfersController {
  constructor(private readonly s: StockTransfersService) {}
  @Get('my-locations') @Roles(...STOCK_READ) my(@CurrentUser() u: AuthUser) { return this.s.myLocations(u); }
  @Get('requests') @Roles(...STOCK_READ) list(@CurrentUser() u: AuthUser, @Query('scope') scope?: string, @Query('status') status?: string, @Query('location_id') location_id?: string) {
    if (location_id && !/^[0-9a-f-]{36}$/i.test(location_id)) throw new BadRequestException('არასწორი id');
    if (status && status.split(',').some((x) => !['draft', 'submitted', 'approved', 'partial', 'issued', 'closed', 'rejected', 'cancelled'].includes(x))) throw new BadRequestException('უცნობი სტატუსი');
    return this.s.requests(u, { scope, status, location_id });
  }
  @Get('requests/:id') @Roles(...STOCK_READ) one(@Param('id', ParseUUIDPipe) id: string) { return this.s.request(id); }
  @Post('requests') @Roles(...STOCK_READ) create(@Body() d: ReqDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.createRequest(d, u, auditCtx(r)); }
  @Put('requests/:id') @Roles(...STOCK_READ) update(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReqDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.updateRequest(id, d, u, auditCtx(r)); }
  @Post('requests/:id/submit') @HttpCode(200) @Roles(...STOCK_READ) submit(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.submit(id, u, auditCtx(r)); }
  @Post('requests/:id/approve') @HttpCode(200) @Roles(...STOCK_READ) approve(@Param('id', ParseUUIDPipe) id: string, @Body() d: ApproveDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.approve(id, d.lines, u, auditCtx(r)); }
  @Post('requests/:id/reject') @HttpCode(200) @Roles(...STOCK_READ) reject(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.reject(id, d.reason, u, auditCtx(r)); }
  @Post('requests/:id/cancel') @HttpCode(200) @Roles(...STOCK_READ) cancel(@Param('id', ParseUUIDPipe) id: string, @Body() d: OptReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.cancel(id, d.reason, u, auditCtx(r)); }
  @Get('requests/:id/pick') @Roles('admin', 'storekeeper', 'stock_manager', 'pharmacist') pick(@Param('id', ParseUUIDPipe) id: string) { return this.s.pick(id); }
  @Post('requests/:id/issue') @HttpCode(200) @Roles('admin', 'storekeeper', 'stock_manager', 'pharmacist') issue(@Param('id', ParseUUIDPipe) id: string, @Body() d: IssueDto, @CurrentUser() u: AuthUser, @Req() r: Request) {
    if (d.lines.some((l) => !l.request_line_id)) throw new BadRequestException('ხაზს request_line_id სჭირდება');
    return this.s.issue(id, d.lines, d.notes, u, auditCtx(r));
  }
  @Post('transfers') @Roles(...STOCK_READ) transfer(@Body() d: TransferDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.transfer(d, u, auditCtx(r)); }
  @Get('transit') @Roles(...STOCK_READ) transit(@CurrentUser() u: AuthUser, @Query('scope') scope?: string) { return this.s.transitList(u, scope === 'outgoing' ? 'outgoing' : scope === 'all' ? 'all' : 'incoming'); }
  @Post('docs/:id/receive') @HttpCode(200) @Roles(...STOCK_READ) receive(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReceiveDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.receive(id, d.action, d.note, u, auditCtx(r)); }
  /** ლოკაციის ლოტები: FEFO (გასაცემი); all=true — დაბლოკილი / ვადაგასულიც (დაბრუნებისთვის) */
  @Get('locations/:id/lots') @Roles(...STOCK_READ) lots(@Param('id', ParseUUIDPipe) id: string, @Query('item_id') item: string, @Query('all') all?: string) {
    if (!item || !/^[0-9a-f-]{36}$/i.test(item)) throw new BadRequestException('item_id სავალდებულოა');
    return all === 'true' ? this.s.allLots(item, id) : this.s.availableLots(item, id);
  }
}
