import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import bwipjs from 'bwip-js';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsISO8601, IsInt, IsNumber, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min } from 'class-validator';
import type { Request, Response } from 'express';
import { sql, type Transaction } from 'kysely';
import { memoryStorage } from 'multer';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser, type Role } from '../auth/roles';
import { mapPgError } from '../common/pg-errors';
import { InjectDb, type Database } from '../database/database.module';
import type { DB } from '../database/db';
import { newDoc } from '../diagnostics/diagnostics.pdf';
import { ModulesService } from '../modules/modules';
import { NotificationsService } from '../notifications/notifications';
import { readCsv, readXlsx, writeXlsx } from '../stock/xlsx';

type Trx = Transaction<DB>;
export interface AssetSettings {
  inv_prefix: string; inv_year: boolean; inv_digits: number; require_room: boolean; require_responsible: boolean; move_mode: 'direct' | 'confirm';
  writeoff_mode: 'direct' | 'single' | 'committee'; writeoff_committee: string[]; committee_quorum: number; track_value: boolean; label_size: '50x25' | '40x20' | '70x35'; label_code: 'qr' | 'code128';
}
/** რეესტრის მართვა: ცნობარები, ჩამოწერის აქტი, ნებისმიერი გადაადგილება */
const ASSET_MANAGE: Role[] = ['admin', 'stock_manager'];
/** რეგისტრაცია, რედაქტირება, გადაადგილება, ეტიკეტი */
const ASSET_STAFF: Role[] = ['admin', 'stock_manager', 'storekeeper'];
/** მთელი რეესტრის ნახვა */
const ASSET_VIEW_ALL: Role[] = ['admin', 'stock_manager', 'storekeeper', 'manager', 'viewer', 'accountant', 'hr'];
const mm = (v: number) => (v * 72) / 25.4;
const tz = 'Asia/Tbilisi';
class DryRun extends Error {}

@Injectable()
export class AssetsService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService, private readonly modules: ModulesService, private readonly notifications: NotificationsService) {}

  private settings() { return this.modules.require<AssetSettings>('asset_register'); }
  private me(u: AuthUser) { return this.db.selectFrom('users').select(['id', 'department_id', 'is_section_head']).where('id', '=', u.id).executeTakeFirstOrThrow(); }
  private event(trx: Trx | Database, assetId: string, kind: string, data: Record<string, unknown>, u: AuthUser) {
    return trx.insertInto('asset_events').values({ asset_id: assetId, kind, data: JSON.stringify(data), user_id: u.id }).execute();
  }

  // ---------------------------------------------------------------- ცნობარები
  async refs() {
    const settings = await this.settings();
    const [categories, conditions] = await Promise.all([
      this.db.selectFrom('asset_categories').selectAll().orderBy('sort_order').orderBy('name').execute(),
      this.db.selectFrom('asset_conditions').selectAll().orderBy('sort_order').execute()]);
    return { settings, categories, conditions };
  }
  async saveCategory(id: string | null, dto: { code?: string; name?: string; is_active?: boolean; sort_order?: number }, u: AuthUser, ctx: AuditContext) {
    await this.settings();
    try {
      const r = id ? await this.db.updateTable('asset_categories').set({ ...(dto.name && { name: dto.name.trim() }), ...(dto.is_active !== undefined && { is_active: dto.is_active }), ...(dto.sort_order !== undefined && { sort_order: dto.sort_order }) })
        .where('id', '=', id).returningAll().executeTakeFirst()
        : await this.db.insertInto('asset_categories').values({ code: dto.code!, name: dto.name!.trim(), sort_order: dto.sort_order ?? 100 }).returningAll().executeTakeFirst();
      if (!r) throw new NotFoundException('კატეგორია ვერ მოიძებნა');
      await this.audit.log(ctx, { action: id ? 'UPDATE_ASSET_CATEGORY' : 'CREATE_ASSET_CATEGORY', entityName: 'asset_categories', entityId: r.id, newData: dto });
      return r;
    } catch (e) { mapPgError(e, { asset_categories_code_key: 'იგივე კოდი უკვე არსებობს' }); }
  }
  async saveCondition(code: string | null, dto: { code?: string; name?: string; usable?: boolean; is_active?: boolean; sort_order?: number }, u: AuthUser, ctx: AuditContext) {
    await this.settings();
    try {
      const r = code ? await this.db.updateTable('asset_conditions').set({ ...(dto.name && { name: dto.name.trim() }), ...(dto.usable !== undefined && { usable: dto.usable }),
        ...(dto.is_active !== undefined && { is_active: dto.is_active }), ...(dto.sort_order !== undefined && { sort_order: dto.sort_order }) }).where('code', '=', code).returningAll().executeTakeFirst()
        : await this.db.insertInto('asset_conditions').values({ code: dto.code!, name: dto.name!.trim(), usable: dto.usable ?? true, sort_order: dto.sort_order ?? 100 }).returningAll().executeTakeFirst();
      if (!r) throw new NotFoundException('მდგომარეობა ვერ მოიძებნა');
      await this.audit.log(ctx, { action: code ? 'UPDATE_ASSET_CONDITION' : 'CREATE_ASSET_CONDITION', entityName: 'asset_conditions', entityId: r.code, newData: dto });
      return r;
    } catch (e) { mapPgError(e, { asset_conditions_pkey: 'იგივე კოდი უკვე არსებობს' }); }
  }
  /** პასუხისმგებლის ასარჩევად — აქტიური თანამშრომლები */
  async people(search?: string) {
    await this.settings();
    let x = this.db.selectFrom('users as u').leftJoin('departments as d', 'd.id', 'u.department_id')
      .select(['u.id', sql<string>`u.first_name || ' ' || u.last_name`.as('name'), 'u.department_id', 'd.name as department_name']).where('u.is_active', '=', true).orderBy('u.last_name').limit(30);
    const s = search?.trim().toLowerCase();
    if (s) x = x.where(sql`lower(u.first_name || ' ' || u.last_name || ' ' || coalesce(u.email, ''))`, 'like', `%${s}%`);
    return x.execute();
  }

  // ---------------------------------------------------------------- რეესტრი
  private base() {
    return this.db.selectFrom('assets as a').innerJoin('asset_categories as c', 'c.id', 'a.category_id').innerJoin('asset_conditions as cn', 'cn.code', 'a.condition_code')
      .leftJoin('departments as d', 'd.id', 'a.department_id').leftJoin('users as r', 'r.id', 'a.responsible_user_id').leftJoin('stock_suppliers as s', 's.id', 'a.supplier_id')
      .selectAll('a').select(['c.name as category_name', 'cn.name as condition_name', 'cn.usable', 'd.name as department_name', 's.name as supplier_name',
        sql<string | null>`r.first_name || ' ' || r.last_name`.as('responsible_name'),
        sql<string | null>`(SELECT m.id FROM asset_moves m WHERE m.asset_id = a.id AND m.status = 'pending')`.as('pending_move_id'),
        sql<string | null>`(SELECT w.act_no FROM asset_writeoff_lines l JOIN asset_writeoffs w ON w.id = l.writeoff_id WHERE l.asset_id = a.id AND w.status = 'pending' LIMIT 1)`.as('pending_writeoff')]);
  }
  /** ხილვადობა: რეესტრის როლები — ყველა; სხვა — საკუთარი (პასუხისმგებელი) და ხელმძღვანელს — საკუთარი განყოფილების */
  async list(u: AuthUser, q: { search?: string; category_id?: string; department_id?: string; responsible_user_id?: string; condition?: string; status?: string; room?: string }) {
    await this.settings();
    let x = this.base().orderBy('a.inv_no').limit(2000);
    if (!has(u, ...ASSET_VIEW_ALL)) {
      const me = await this.me(u);
      x = x.where((eb) => eb.or([eb('a.responsible_user_id', '=', u.id), ...(me.department_id && me.is_section_head ? [eb('a.department_id', '=', me.department_id)] : [])]));
    }
    x = x.where('a.status', '=', q.status === 'written_off' ? 'written_off' : 'active');
    if (q.category_id) x = x.where('a.category_id', '=', q.category_id);
    if (q.department_id) x = x.where('a.department_id', '=', q.department_id);
    if (q.responsible_user_id) x = x.where('a.responsible_user_id', '=', q.responsible_user_id);
    if (q.condition) x = x.where('a.condition_code', '=', q.condition);
    if (q.room) x = x.where(sql`lower(a.room)`, '=', q.room.trim().toLowerCase());
    const s = q.search?.trim();
    if (s) x = x.where((eb) => eb.or([eb(sql`upper(a.inv_no)`, 'like', `%${s.toUpperCase()}%`), eb(sql`lower(a.name)`, 'like', `%${s.toLowerCase()}%`),
      eb(sql`upper(coalesce(a.serial_no, ''))`, 'like', `%${s.toUpperCase()}%`), eb(sql`lower(coalesce(a.model, ''))`, 'like', `%${s.toLowerCase()}%`)]));
    return x.execute();
  }
  async get(id: string, u: AuthUser) {
    await this.settings();
    const a = await this.base().where('a.id', '=', id).executeTakeFirst();
    if (!a) throw new NotFoundException('ინვენტარი ვერ მოიძებნა');
    if (!has(u, ...ASSET_VIEW_ALL)) {
      const me = await this.me(u);
      const pending = a.pending_move_id ? await this.db.selectFrom('asset_moves').select(['to_responsible_id', 'to_department_id']).where('id', '=', a.pending_move_id).executeTakeFirst() : undefined;
      const ok = a.responsible_user_id === u.id || (me.is_section_head && me.department_id && me.department_id === a.department_id)
        || pending?.to_responsible_id === u.id || (me.is_section_head && pending?.to_department_id === me.department_id);
      if (!ok) throw new ForbiddenException('ინვენტარი თქვენზე / თქვენს განყოფილებაზე არ არის');
    }
    const events = await this.db.selectFrom('asset_events as e').innerJoin('users as u', 'u.id', 'e.user_id')
      .select(['e.id', 'e.kind', 'e.data', 'e.created_at', sql<string>`u.first_name || ' ' || u.last_name`.as('user_name')]).where('e.asset_id', '=', id).orderBy('e.id', 'desc').execute();
    return { ...a, events };
  }

  private async nextInv(trx: Trx, s: AssetSettings) {
    const yr = Number(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric' }).format(new Date()));
    const year = s.inv_year ? yr : 0;
    for (let i = 0; i < 50; i++) {
      const { last_value } = await trx.insertInto('document_counters').values({ document_type: `asset_${s.inv_prefix || 'INV'}`, year, last_value: 1 })
        .onConflict((oc) => oc.columns(['document_type', 'year']).doUpdateSet({ last_value: sql`document_counters.last_value + 1` })).returning('last_value').executeTakeFirstOrThrow();
      const no = [s.inv_prefix, s.inv_year ? String(yr).slice(2) : '', String(last_value).padStart(s.inv_digits, '0')].filter(Boolean).join('-');
      const taken = await trx.selectFrom('assets').select('id').where('inv_no', '=', no).executeTakeFirst();
      if (!taken) return no;                                    // ხელით შეყვანილ ნომერს ავტომატური არ ემთხვევა
    }
    throw new ConflictException('საინვენტარო ნომრის გენერაცია ვერ მოხერხდა');
  }
  private validate(s: AssetSettings, dto: { room?: string | null; responsible_user_id?: string | null; department_id?: string | null }) {
    if (s.require_room && !dto.room?.trim()) throw new BadRequestException('ოთახი სავალდებულოა (პარამეტრი)');
    if (s.require_responsible && !dto.responsible_user_id) throw new BadRequestException('პასუხისმგებელი პირი სავალდებულოა (პარამეტრი)');
    if (!dto.department_id) throw new BadRequestException('განყოფილება სავალდებულოა');
  }
  private clean(dto: Partial<AssetIn>, s: AssetSettings) {
    const o: Record<string, unknown> = {};
    for (const k of ['name', 'category_id', 'manufacturer', 'model', 'serial_no', 'department_id', 'room', 'responsible_user_id', 'condition_code', 'purchase_date', 'purchase_value', 'supplier_id', 'warranty_until', 'notes'] as const) {
      if (dto[k] === undefined) continue;
      if ((k === 'purchase_value' || k === 'supplier_id') && !s.track_value) continue;
      const v = dto[k];
      o[k] = typeof v === 'string' ? (v.trim() || null) : k === 'purchase_value' && v !== null ? String(v) : v;
    }
    return o;
  }

  async create(dto: AssetIn, u: AuthUser, ctx: AuditContext) {
    if (!has(u, ...ASSET_STAFF)) throw new ForbiddenException('რეგისტრაცია — საწყობის / რეესტრის თანამშრომელი');
    const s = await this.settings();
    this.validate(s, dto);
    try {
      const id = await this.db.transaction().execute(async (trx) => {
        const inv = dto.inv_no?.trim().toUpperCase() || await this.nextInv(trx, s);
        const a = await trx.insertInto('assets').values({ ...(this.clean(dto, s) as { name: string; category_id: string }), inv_no: inv, created_by: u.id }).returning('id').executeTakeFirstOrThrow();
        await this.event(trx, a.id, 'created', { inv_no: inv, department_id: dto.department_id, room: dto.room ?? null, responsible_user_id: dto.responsible_user_id ?? null }, u);
        await this.audit.log(ctx, { action: 'CREATE_ASSET', entityName: 'assets', entityId: a.id, newData: { ...dto, inv_no: inv } }, trx);
        return a.id;
      });
      return this.get(id, u);
    } catch (e) { mapPgError(e, { assets_inv_no_key: 'ეს საინვენტარო ნომერი უკვე გამოყენებულია', ux_assets_serial: 'იგივე სერიული ნომერი (მწარმოებლით) უკვე რეესტრშია' }); }
  }

  /** რედაქტირება: მონაცემები და მდგომარეობა; ადგილი / პასუხისმგებელი — მხოლოდ გადაადგილებით */
  async update(id: string, dto: Partial<AssetIn>, u: AuthUser, ctx: AuditContext) {
    if (!has(u, ...ASSET_STAFF)) throw new ForbiddenException('რედაქტირება — საწყობის / რეესტრის თანამშრომელი');
    const s = await this.settings();
    if (dto.department_id !== undefined || dto.room !== undefined || dto.responsible_user_id !== undefined) throw new BadRequestException('ადგილი და პასუხისმგებელი იცვლება გადაადგილებით');
    try {
      await this.db.transaction().execute(async (trx) => {
        const old = await trx.selectFrom('assets').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
        if (!old) throw new NotFoundException('ინვენტარი ვერ მოიძებნა');
        if (old.status !== 'active') throw new ConflictException('ჩამოწერილი ინვენტარი არ იცვლება');
        const set = this.clean(dto, s);
        if (dto.inv_no && dto.inv_no.trim().toUpperCase() !== old.inv_no) set.inv_no = dto.inv_no.trim().toUpperCase();
        await trx.updateTable('assets').set(set).where('id', '=', id).execute();
        if (dto.condition_code && dto.condition_code !== old.condition_code) await this.event(trx, id, 'condition', { from: old.condition_code, to: dto.condition_code }, u);
        const changed = Object.keys(set).filter((k) => k !== 'condition_code');
        if (changed.length) await this.event(trx, id, 'updated', { fields: changed }, u);
        await this.audit.log(ctx, { action: 'UPDATE_ASSET', entityName: 'assets', entityId: id, oldData: old, newData: set }, trx);
      });
    } catch (e) { mapPgError(e, { assets_inv_no_key: 'ეს საინვენტარო ნომერი უკვე გამოყენებულია', ux_assets_serial: 'იგივე სერიული ნომერი (მწარმოებლით) უკვე რეესტრშია' }); }
    return this.get(id, u);
  }

  // ---------------------------------------------------------------- გადაადგილება
  async move(id: string, dto: { to_department_id: string; to_room?: string | null; to_responsible_id?: string | null; reason?: string | null }, u: AuthUser, ctx: AuditContext) {
    const s = await this.settings();
    this.validate(s, { department_id: dto.to_department_id, room: dto.to_room, responsible_user_id: dto.to_responsible_id });
    let moveId = ''; let direct = false; let notify: string[] = []; let invNo = ''; let name = '';
    await this.db.transaction().execute(async (trx) => {
      const a = await trx.selectFrom('assets').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!a) throw new NotFoundException('ინვენტარი ვერ მოიძებნა');
      if (a.status !== 'active') throw new ConflictException('ჩამოწერილი ინვენტარი არ გადაადგილდება');
      if (!has(u, ...ASSET_STAFF) && a.responsible_user_id !== u.id) throw new ForbiddenException('გადაადგილება — პასუხისმგებელი პირი ან საწყობი');
      const pending = await trx.selectFrom('asset_moves').select('id').where('asset_id', '=', id).where('status', '=', 'pending').executeTakeFirst();
      if (pending) throw new ConflictException('გადაადგილება უკვე მიმდინარეობს — ელოდება მიმღებს');
      const pw = await trx.selectFrom('asset_writeoff_lines as l').innerJoin('asset_writeoffs as w', 'w.id', 'l.writeoff_id').select('w.id').where('l.asset_id', '=', id).where('w.status', '=', 'pending').executeTakeFirst();
      if (pw) throw new ConflictException('ინვენტარი ჩამოწერის აქტშია');
      if (a.department_id === dto.to_department_id && (a.room ?? '') === (dto.to_room?.trim() ?? '') && a.responsible_user_id === (dto.to_responsible_id ?? null)) throw new BadRequestException('ახალი ადგილი ძველს ემთხვევა');
      // მიმღების დადასტურება საჭიროა, თუ რეჟიმი confirm და მიმღები სხვა პირია (თავის თავზე / საწყობის შიდა — პირდაპირ)
      direct = s.move_mode === 'direct' || (dto.to_responsible_id ?? null) === u.id;
      const m = await trx.insertInto('asset_moves').values({ asset_id: id, from_department_id: a.department_id, from_room: a.room, from_responsible_id: a.responsible_user_id,
        to_department_id: dto.to_department_id, to_room: dto.to_room?.trim() || null, to_responsible_id: dto.to_responsible_id ?? null, status: direct ? 'done' : 'pending',
        reason: dto.reason?.trim() || null, requested_by: u.id, ...(direct && { decided_by: u.id, decided_at: sql`now()` }) }).returning('id').executeTakeFirstOrThrow();
      moveId = m.id; invNo = a.inv_no; name = a.name;
      if (direct) {
        await trx.updateTable('assets').set({ department_id: dto.to_department_id, room: dto.to_room?.trim() || null, responsible_user_id: dto.to_responsible_id ?? null }).where('id', '=', id).execute();
        await this.event(trx, id, 'moved', { move_id: m.id, from: { department_id: a.department_id, room: a.room, responsible_user_id: a.responsible_user_id }, to: dto, reason: dto.reason ?? null }, u);
      } else {
        await this.event(trx, id, 'move_requested', { move_id: m.id, to: dto, reason: dto.reason ?? null }, u);
        notify = await this.confirmers(trx, dto.to_responsible_id ?? null, dto.to_department_id);
      }
      await this.audit.log(ctx, { action: direct ? 'MOVE_ASSET' : 'REQUEST_ASSET_MOVE', entityName: 'assets', entityId: id, newData: { ...dto, move_id: m.id } }, trx);
    });
    for (const uid of new Set(notify)) if (uid !== u.id) await this.notifications.notify(uid, { kind: 'asset_move', title: `ინვენტარი გადმოგეცემათ: ${invNo} — ${name}`, body: 'დაადასტურეთ მიღება', link: '/assets?tab=incoming', entityId: moveId });
    return { move_id: moveId, status: direct ? 'done' : 'pending', asset: await this.get(id, u) };
  }
  /** ვინ ადასტურებს: მიმღები პასუხისმგებელი; თუ არ არის — განყოფილების ხელმძღვანელი; თუ არც ის — რეესტრის მენეჯერი */
  private async confirmers(ex: Trx | Database, responsible: string | null, dep: string) {
    if (responsible) return [responsible];
    const heads = (await ex.selectFrom('users').select('id').where('department_id', '=', dep).where('is_section_head', '=', true).where('is_active', '=', true).execute()).map((x) => x.id);
    if (heads.length) return heads;
    return (await ex.selectFrom('users as u').innerJoin('user_capabilities as c', 'c.user_id', 'u.id').select('u.id').where('u.is_active', '=', true)
      .where(sql<boolean>`c.capabilities && ARRAY['stock_manager','admin']::varchar[]`).execute()).map((x) => x.id);
  }
  private async canDecideMove(u: AuthUser, m: { to_responsible_id: string | null; to_department_id: string | null }) {
    if (has(u, ...ASSET_MANAGE)) return true;
    if (m.to_responsible_id) return m.to_responsible_id === u.id;
    const me = await this.me(u);
    return !!me.is_section_head && me.department_id === m.to_department_id;
  }

  async moves(u: AuthUser, q: { scope?: string }) {
    await this.settings();
    let x = this.db.selectFrom('asset_moves as m').innerJoin('assets as a', 'a.id', 'm.asset_id').innerJoin('users as rq', 'rq.id', 'm.requested_by')
      .leftJoin('departments as fd', 'fd.id', 'm.from_department_id').leftJoin('departments as td', 'td.id', 'm.to_department_id')
      .leftJoin('users as fr', 'fr.id', 'm.from_responsible_id').leftJoin('users as tr', 'tr.id', 'm.to_responsible_id')
      .select(['m.id', 'm.asset_id', 'm.status', 'm.reason', 'm.decision_note', 'm.requested_at', 'm.decided_at', 'm.from_room', 'm.to_room', 'm.to_responsible_id', 'm.to_department_id', 'a.inv_no', 'a.name as asset_name',
        'fd.name as from_department', 'td.name as to_department', sql<string | null>`fr.first_name || ' ' || fr.last_name`.as('from_responsible'),
        sql<string | null>`tr.first_name || ' ' || tr.last_name`.as('to_responsible'), sql<string>`rq.first_name || ' ' || rq.last_name`.as('requested_by_name')])
      .orderBy('m.requested_at', 'desc').limit(500);
    if (q.scope === 'incoming') {
      const me = await this.me(u);
      x = x.where('m.status', '=', 'pending');
      if (!has(u, ...ASSET_MANAGE)) x = x.where((eb) => eb.or([eb('m.to_responsible_id', '=', u.id),
        ...(me.is_section_head && me.department_id ? [eb.and([eb('m.to_responsible_id', 'is', null), eb('m.to_department_id', '=', me.department_id)])] : [])]));
    } else if (q.scope === 'outgoing') x = x.where('m.status', '=', 'pending').where('m.requested_by', '=', u.id);
    else if (!has(u, ...ASSET_VIEW_ALL)) x = x.where((eb) => eb.or([eb('m.requested_by', '=', u.id), eb('m.to_responsible_id', '=', u.id), eb('m.from_responsible_id', '=', u.id)]));
    return x.execute();
  }

  async decideMove(id: string, accept: boolean, note: string | undefined, u: AuthUser, ctx: AuditContext) {
    await this.settings();
    let requester = ''; let inv = '';
    await this.db.transaction().execute(async (trx) => {
      const m = await trx.selectFrom('asset_moves').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!m) throw new NotFoundException('გადაადგილება ვერ მოიძებნა');
      if (m.status !== 'pending') throw new ConflictException('გადაადგილება უკვე გადაწყვეტილია');
      if (!(await this.canDecideMove(u, m))) throw new ForbiddenException('დადასტურება — მიმღები (ან განყოფილების ხელმძღვანელი)');
      if (!accept && (!note || note.trim().length < 3)) throw new BadRequestException('უარის მიზეზი სავალდებულოა');
      await trx.updateTable('asset_moves').set({ status: accept ? 'done' : 'rejected', decided_by: u.id, decided_at: sql`now()`, decision_note: note?.trim() || null }).where('id', '=', id).execute();
      const a = await trx.selectFrom('assets').select(['inv_no', 'department_id', 'room', 'responsible_user_id']).where('id', '=', m.asset_id).forUpdate().executeTakeFirstOrThrow();
      inv = a.inv_no; requester = m.requested_by;
      if (accept) {
        await trx.updateTable('assets').set({ department_id: m.to_department_id, room: m.to_room, responsible_user_id: m.to_responsible_id }).where('id', '=', m.asset_id).execute();
        await this.event(trx, m.asset_id, 'moved', { move_id: id, from: { department_id: a.department_id, room: a.room, responsible_user_id: a.responsible_user_id },
          to: { department_id: m.to_department_id, room: m.to_room, responsible_user_id: m.to_responsible_id }, note: note ?? null }, u);
      } else await this.event(trx, m.asset_id, 'move_rejected', { move_id: id, note }, u);
      await this.audit.log(ctx, { action: accept ? 'ACCEPT_ASSET_MOVE' : 'REJECT_ASSET_MOVE', entityName: 'asset_moves', entityId: id, newData: { note } }, trx);
    });
    if (requester && requester !== u.id) await this.notifications.notify(requester, { kind: 'asset_move', title: `${inv}: ${accept ? 'მიღება დადასტურდა' : 'მიღებაზე უარი'}`, body: note, link: '/assets', entityId: id });
    return { status: accept ? 'done' : 'rejected' };
  }

  async cancelMove(id: string, u: AuthUser, ctx: AuditContext) {
    await this.settings();
    await this.db.transaction().execute(async (trx) => {
      const m = await trx.selectFrom('asset_moves').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!m) throw new NotFoundException('გადაადგილება ვერ მოიძებნა');
      if (m.status !== 'pending') throw new ConflictException('გადაადგილება უკვე გადაწყვეტილია');
      if (m.requested_by !== u.id && !has(u, ...ASSET_MANAGE)) throw new ForbiddenException('გაუქმება — ავტორი ან მენეჯერი');
      await trx.updateTable('asset_moves').set({ status: 'cancelled', decided_by: u.id, decided_at: sql`now()` }).where('id', '=', id).execute();
      await this.event(trx, m.asset_id, 'move_cancelled', { move_id: id }, u);
      await this.audit.log(ctx, { action: 'CANCEL_ASSET_MOVE', entityName: 'asset_moves', entityId: id }, trx);
    });
    return { status: 'cancelled' };
  }

  // ---------------------------------------------------------------- ჩამოწერის აქტი
  async createWriteoff(dto: { asset_ids: string[]; reason: string; method?: string }, u: AuthUser, ctx: AuditContext) {
    if (!has(u, ...ASSET_MANAGE)) throw new ForbiddenException('ჩამოწერის აქტი — რეესტრის მენეჯერი');
    const s = await this.settings();
    const ids = [...new Set(dto.asset_ids)];
    let wid = ''; let notifyIds: string[] = [];
    await this.db.transaction().execute(async (trx) => {
      const rows = await trx.selectFrom('assets').select(['id', 'status', 'inv_no']).where('id', 'in', ids).forUpdate().execute();
      if (rows.length !== ids.length) throw new BadRequestException('ინვენტარი ვერ მოიძებნა');
      const bad = rows.filter((r) => r.status !== 'active'); if (bad.length) throw new ConflictException(`უკვე ჩამოწერილია: ${bad.map((b) => b.inv_no).join(', ')}`);
      const busy = await trx.selectFrom('asset_writeoff_lines as l').innerJoin('asset_writeoffs as w', 'w.id', 'l.writeoff_id').innerJoin('assets as a', 'a.id', 'l.asset_id')
        .select('a.inv_no').where('l.asset_id', 'in', ids).where('w.status', '=', 'pending').execute();
      if (busy.length) throw new ConflictException(`სხვა აქტშია: ${busy.map((b) => b.inv_no).join(', ')}`);
      const mv = await trx.selectFrom('asset_moves as m').innerJoin('assets as a', 'a.id', 'm.asset_id').select('a.inv_no').where('m.asset_id', 'in', ids).where('m.status', '=', 'pending').execute();
      if (mv.length) throw new ConflictException(`გადაადგილება მიმდინარეობს: ${mv.map((b) => b.inv_no).join(', ')}`);
      const quorum = s.writeoff_mode === 'committee' ? s.committee_quorum : 1;
      const w = await trx.insertInto('asset_writeoffs').values({ status: 'pending', mode: s.writeoff_mode, quorum, reason: dto.reason.trim(), method: dto.method ?? 'disposal', created_by: u.id })
        .returning('id').executeTakeFirstOrThrow();
      wid = w.id;
      await trx.insertInto('asset_writeoff_lines').values(ids.map((a) => ({ writeoff_id: wid, asset_id: a }))).execute();
      for (const a of ids) await this.event(trx, a, 'writeoff_requested', { writeoff_id: wid, reason: dto.reason }, u);
      await this.audit.log(ctx, { action: 'CREATE_ASSET_WRITEOFF', entityName: 'asset_writeoffs', entityId: wid, newData: { ...dto, mode: s.writeoff_mode, quorum } }, trx);
      if (s.writeoff_mode === 'direct') await this.finishWriteoff(trx, wid, true, u);
      else notifyIds = s.writeoff_mode === 'committee' ? s.writeoff_committee
        : (await trx.selectFrom('users as x').innerJoin('user_capabilities as c', 'c.user_id', 'x.id').select('x.id').where('x.is_active', '=', true)
          .where(sql<boolean>`c.capabilities && ARRAY['stock_manager','admin']::varchar[]`).execute()).map((r) => r.id);
    });
    for (const id of new Set(notifyIds)) if (id !== u.id) await this.notifications.notify(id, { kind: 'asset_writeoff', title: `ინვენტარის ჩამოწერის აქტი — ${ids.length} ერთეული`, body: dto.reason, link: '/assets?tab=writeoffs', entityId: wid });
    return this.writeoff(wid);
  }

  private async finishWriteoff(trx: Trx, id: string, approved: boolean, u: AuthUser) {
    const lines = await trx.selectFrom('asset_writeoff_lines').select('asset_id').where('writeoff_id', '=', id).execute();
    let no: string | null = null;
    if (approved) {
      const yr = Number(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric' }).format(new Date()));
      const { last_value } = await trx.insertInto('document_counters').values({ document_type: 'asset_AW', year: yr, last_value: 1 })
        .onConflict((oc) => oc.columns(['document_type', 'year']).doUpdateSet({ last_value: sql`document_counters.last_value + 1` })).returning('last_value').executeTakeFirstOrThrow();
      no = `AW${String(yr).slice(2)}-${String(last_value).padStart(6, '0')}`;
      await trx.updateTable('assets').set({ status: 'written_off' }).where('id', 'in', lines.map((l) => l.asset_id)).execute();
    }
    await trx.updateTable('asset_writeoffs').set({ status: approved ? 'approved' : 'rejected', act_no: no, decided_at: sql`now()` }).where('id', '=', id).execute();
    for (const l of lines) await this.event(trx, l.asset_id, approved ? 'written_off' : 'writeoff_rejected', { writeoff_id: id, act_no: no }, u);
  }

  async vote(id: string, approve: boolean, note: string | undefined, u: AuthUser, ctx: AuditContext) {
    const s = await this.settings();
    let creator = ''; let result = '';
    await this.db.transaction().execute(async (trx) => {
      const w = await trx.selectFrom('asset_writeoffs').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!w) throw new NotFoundException('აქტი ვერ მოიძებნა');
      if (w.status !== 'pending') throw new ConflictException('აქტი უკვე გადაწყვეტილია');
      if (w.mode === 'committee') { if (!s.writeoff_committee.includes(u.id)) throw new ForbiddenException('ხმას აძლევს მხოლოდ კომისიის წევრი'); }
      else { if (!has(u, ...ASSET_MANAGE)) throw new ForbiddenException('დამტკიცება — რეესტრის მენეჯერი'); if (w.created_by === u.id && !has(u, 'admin')) throw new ForbiddenException('საკუთარ აქტს ვერ დაამტკიცებთ'); }
      if (!approve && (!note || note.trim().length < 3)) throw new BadRequestException('უარის მიზეზი სავალდებულოა');
      const prev = await trx.selectFrom('asset_writeoff_votes').select('user_id').where('writeoff_id', '=', id).where('user_id', '=', u.id).executeTakeFirst();
      if (prev) throw new ConflictException('ხმა უკვე მიცემულია');
      await trx.insertInto('asset_writeoff_votes').values({ writeoff_id: id, user_id: u.id, approve, note: note?.trim() || null }).execute();
      const yes = (await trx.selectFrom('asset_writeoff_votes').select(sql<number>`count(*)::int`.as('n')).where('writeoff_id', '=', id).where('approve', '=', true).executeTakeFirstOrThrow()).n;
      creator = w.created_by;
      if (!approve) { await this.finishWriteoff(trx, id, false, u); result = 'rejected'; }
      else if (yes >= w.quorum) { await this.finishWriteoff(trx, id, true, u); result = 'approved'; }
      await this.audit.log(ctx, { action: approve ? 'APPROVE_ASSET_WRITEOFF' : 'REJECT_ASSET_WRITEOFF', entityName: 'asset_writeoffs', entityId: id, newData: { note, result: result || 'vote' } }, trx);
    });
    if (result && creator !== u.id) await this.notifications.notify(creator, { kind: 'asset_writeoff', title: `ჩამოწერის აქტი: ${result === 'approved' ? 'დამტკიცდა' : 'უარყოფილია'}`, body: note, link: '/assets?tab=writeoffs', entityId: id });
    return this.writeoff(id);
  }

  async writeoff(id: string) {
    const w = await this.db.selectFrom('asset_writeoffs as w').innerJoin('users as u', 'u.id', 'w.created_by').selectAll('w')
      .select(sql<string>`u.first_name || ' ' || u.last_name`.as('created_by_name')).where('w.id', '=', id).executeTakeFirst();
    if (!w) throw new NotFoundException('აქტი ვერ მოიძებნა');
    const [assets, votes] = await Promise.all([
      this.db.selectFrom('asset_writeoff_lines as l').innerJoin('assets as a', 'a.id', 'l.asset_id').innerJoin('asset_categories as c', 'c.id', 'a.category_id').leftJoin('departments as d', 'd.id', 'a.department_id')
        .select(['a.id', 'a.inv_no', 'a.name', 'a.serial_no', 'a.purchase_value', 'a.purchase_date', 'a.condition_code', 'c.name as category_name', 'd.name as department_name', 'a.room']).where('l.writeoff_id', '=', id).orderBy('a.inv_no').execute(),
      this.db.selectFrom('asset_writeoff_votes as v').innerJoin('users as u', 'u.id', 'v.user_id').select(['v.user_id', 'v.approve', 'v.note', 'v.created_at', sql<string>`u.first_name || ' ' || u.last_name`.as('user_name')])
        .where('v.writeoff_id', '=', id).orderBy('v.created_at').execute()]);
    return { ...w, assets, votes };
  }
  async writeoffs(u: AuthUser, status?: string) {
    await this.settings();
    let x = this.db.selectFrom('asset_writeoffs as w').innerJoin('users as u', 'u.id', 'w.created_by').selectAll('w')
      .select([sql<string>`u.first_name || ' ' || u.last_name`.as('created_by_name'), sql<number>`(SELECT count(*)::int FROM asset_writeoff_lines l WHERE l.writeoff_id = w.id)`.as('assets'),
        sql<number>`(SELECT count(*)::int FROM asset_writeoff_votes v WHERE v.writeoff_id = w.id AND v.approve)`.as('yes'),
        sql<boolean>`EXISTS (SELECT 1 FROM asset_writeoff_votes v WHERE v.writeoff_id = w.id AND v.user_id = ${u.id})`.as('voted')])
      .orderBy('w.created_at', 'desc').limit(300);
    if (status) x = x.where('w.status', '=', status);
    return x.execute();
  }

  // ---------------------------------------------------------------- ეტიკეტები
  async labels(ids: string[], u: AuthUser) {
    if (!has(u, ...ASSET_STAFF)) throw new ForbiddenException('ეტიკეტი — საწყობის / რეესტრის თანამშრომელი');
    const s = await this.settings();
    const rows = await this.db.selectFrom('assets as a').leftJoin('departments as d', 'd.id', 'a.department_id').select(['a.inv_no', 'a.name', 'a.room', 'd.name as department_name']).where('a.id', 'in', ids).orderBy('a.inv_no').execute();
    if (!rows.length) throw new NotFoundException('ინვენტარი ვერ მოიძებნა');
    const [W, H] = s.label_size.split('x').map(Number);
    const clinic = await this.db.selectFrom('clinic_settings').select('name').where('id', '=', 1).executeTakeFirst();
    const { doc, done } = newDoc([mm(W), mm(H)], mm(1.5));
    for (const r of rows) {
      doc.addPage();
      const pad = mm(1.5);
      if (s.label_code === 'qr') {
        const side = mm(H - 3);
        const png = await bwipjs.toBuffer({ bcid: 'qrcode', text: r.inv_no, scale: 4 });
        doc.image(png, pad, pad, { width: side, height: side });
        const x = pad + side + mm(1.5); const tw = mm(W) - x - pad;
        doc.font('B').fontSize(H >= 30 ? 10 : 8).text(r.inv_no, x, pad, { width: tw, lineBreak: false });
        doc.font('R').fontSize(H >= 30 ? 7 : 5.5).text(r.name.slice(0, 60), x, pad + mm(H >= 30 ? 5 : 4), { width: tw, height: mm(H / 2.6) });
        doc.font('R').fontSize(5).text([r.department_name, r.room].filter(Boolean).join(' · ').slice(0, 50), x, mm(H) - pad - mm(5.5), { width: tw, lineBreak: false });
        if (clinic?.name) doc.font('R').fontSize(4.5).text(clinic.name.slice(0, 40), x, mm(H) - pad - mm(2.6), { width: tw, lineBreak: false });
      } else {
        const tw = mm(W) - 2 * pad;
        doc.font('R').fontSize(5.5).text(`${clinic?.name ?? ''}`.slice(0, 50), pad, pad, { width: tw, lineBreak: false });
        const png = await bwipjs.toBuffer({ bcid: 'code128', text: r.inv_no, scale: 3, height: 8, includetext: false });
        doc.image(png, pad, pad + mm(3), { width: tw, height: mm(H * 0.45) });
        doc.font('B').fontSize(7).text(r.inv_no, pad, pad + mm(3) + mm(H * 0.45) + mm(0.5), { width: tw, align: 'center', lineBreak: false });
        doc.font('R').fontSize(5).text(r.name.slice(0, 50), pad, mm(H) - pad - mm(2.5), { width: tw, align: 'center', lineBreak: false });
      }
    }
    doc.end();
    return done;
  }

  // ---------------------------------------------------------------- იმპორტი (არსებული ინვენტარი)
  static readonly COLS = ['საინვენტარო №', 'დასახელება', 'კატეგორია (კოდი)', 'მწარმოებელი', 'მოდელი', 'სერიული №', 'განყოფილება (კოდი)', 'ოთახი', 'პასუხისმგებელი (ელ-ფოსტა)', 'მდგომარეობა (კოდი)', 'შეძენის თარიღი', 'ღირებულება', 'შენიშვნა'];
  template() {
    return writeXlsx('ინვენტარი', [AssetsService.COLS, ['ცარიელი — ავტომატური', 'მაგიდა საოფისე', 'FURNITURE', '', '', '', 'THER', '101', 'user@clinic.ge', 'good', '2024-05-01', '350', '']],
      [16, 30, 16, 16, 16, 16, 18, 10, 26, 16, 14, 12, 24]);
  }
  async import(buf: Buffer, name: string, commit: boolean, u: AuthUser, ctx: AuditContext) {
    if (!has(u, ...ASSET_MANAGE)) throw new ForbiddenException('იმპორტი — რეესტრის მენეჯერი');
    const s = await this.settings();
    const table = /\.xlsx$/i.test(name) ? readXlsx(buf) : readCsv(buf.toString('utf8'));
    const [head, ...data] = table;
    if (!head || AssetsService.COLS.some((c, i) => (head[i] ?? '').trim() !== c)) throw new BadRequestException('სათაურები შაბლონს არ ემთხვევა (ჩამოტვირთეთ შაბლონი)');
    const report: { row: number; status: 'create' | 'skip' | 'error'; inv_no: string; name: string; message?: string }[] = [];
    let created = 0;
    try {
      await this.db.transaction().execute(async (trx) => {
        const cats = await trx.selectFrom('asset_categories').select(['id', 'code']).where('is_active', '=', true).execute();
        const conds = await trx.selectFrom('asset_conditions').select('code').where('is_active', '=', true).execute();
        const deps = await trx.selectFrom('departments').select(['id', 'code']).where('is_active', '=', true).execute();
        for (const [i, r] of data.entries()) {
          const row = i + 2; const v = (k: number) => (r[k] ?? '').trim();
          if (!r.some((c) => (c ?? '').trim())) continue;
          const nm = v(1);
          try {
            if (nm.length < 2) throw new Error('დასახელება სავალდებულოა');
            const cat = cats.find((c) => c.code === v(2).toUpperCase()); if (!cat) throw new Error(`უცნობი კატეგორია: ${v(2)}`);
            const dep = deps.find((d) => d.code.toUpperCase() === v(6).toUpperCase()); if (!dep) throw new Error(`უცნობი განყოფილება: ${v(6)}`);
            let resp: string | null = null;
            if (v(8)) { const p = await trx.selectFrom('users').select('id').where(sql`lower(email)`, '=', v(8).toLowerCase()).where('is_active', '=', true).executeTakeFirst(); if (!p) throw new Error(`პასუხისმგებელი ვერ მოიძებნა: ${v(8)}`); resp = p.id; }
            const cond = v(9) || 'good'; if (!conds.some((c) => c.code === cond)) throw new Error(`უცნობი მდგომარეობა: ${cond}`);
            if (s.require_room && !v(7)) throw new Error('ოთახი სავალდებულოა (პარამეტრი)');
            if (s.require_responsible && !resp) throw new Error('პასუხისმგებელი სავალდებულოა (პარამეტრი)');
            if (v(10) && !/^\d{4}-\d{2}-\d{2}$/.test(v(10))) throw new Error('თარიღი — YYYY-MM-DD');
            const value = v(11) ? Number(v(11).replace(',', '.')) : null; if (value !== null && !(value >= 0)) throw new Error('ღირებულება — რიცხვი');
            const inv = v(0).toUpperCase();
            if (inv && await trx.selectFrom('assets').select('id').where('inv_no', '=', inv).executeTakeFirst()) { report.push({ row, status: 'skip', inv_no: inv, name: nm, message: 'ნომერი უკვე რეესტრშია' }); continue; }
            const no = inv || await this.nextInv(trx, s);
            const a = await trx.insertInto('assets').values({ inv_no: no, name: nm, category_id: cat.id, manufacturer: v(3) || null, model: v(4) || null, serial_no: v(5) || null, department_id: dep.id,
              room: v(7) || null, responsible_user_id: resp, condition_code: cond, purchase_date: v(10) || null, purchase_value: s.track_value && value !== null ? String(value) : null, notes: v(12) || null, created_by: u.id })
              .returning('id').executeTakeFirstOrThrow();
            await this.event(trx, a.id, 'created', { inv_no: no, import: name }, u);
            created++; report.push({ row, status: 'create', inv_no: no, name: nm });
          } catch (e) { report.push({ row, status: 'error', inv_no: v(0), name: nm, message: (e as Error).message }); }
        }
        if (report.some((r) => r.status === 'error') && commit) throw new BadRequestException({ message: 'იმპორტი შეჩერდა — გაასწორეთ შეცდომები (შემოწმება)', report });
        if (commit) await this.audit.log(ctx, { action: 'IMPORT_ASSETS', entityName: 'assets', entityId: '-', newData: { file: name, created } }, trx);
        if (!commit) throw new DryRun();
      });
    } catch (e) { if (!(e instanceof DryRun)) throw e; }
    return { commit, created, skipped: report.filter((r) => r.status === 'skip').length, errors: report.filter((r) => r.status === 'error').length, report };
  }

  /** შემაჯამებელი: განყოფილება × კატეგორია, მდგომარეობით, ღირებულებით */
  async summary() {
    await this.settings();
    return this.db.selectFrom('assets as a').innerJoin('asset_categories as c', 'c.id', 'a.category_id').innerJoin('asset_conditions as cn', 'cn.code', 'a.condition_code').leftJoin('departments as d', 'd.id', 'a.department_id')
      .select(['d.name as department_name', 'c.name as category_name', sql<number>`count(*)::int`.as('total'), sql<number>`count(*) FILTER (WHERE NOT cn.usable)::int`.as('unusable'),
        sql<number>`count(*) FILTER (WHERE a.condition_code = 'repair')::int`.as('repair'), sql<string>`coalesce(sum(a.purchase_value), 0)`.as('value')])
      .where('a.status', '=', 'active').groupBy(['d.name', 'c.name']).orderBy('d.name').orderBy('c.name').execute();
  }
}

// ======================================================================= DTO
class AssetIn {
  @IsOptional() @IsString() @Matches(/^[A-Za-z0-9\-/._]{2,40}$/) inv_no?: string | null;
  @IsString() @Length(2, 200) name: string; @IsUUID() category_id: string;
  @IsOptional() @IsString() @MaxLength(120) manufacturer?: string | null; @IsOptional() @IsString() @MaxLength(120) model?: string | null; @IsOptional() @IsString() @MaxLength(120) serial_no?: string | null;
  @IsOptional() @IsUUID() department_id?: string | null; @IsOptional() @IsString() @MaxLength(60) room?: string | null; @IsOptional() @IsUUID() responsible_user_id?: string | null;
  @IsOptional() @IsString() @MaxLength(30) condition_code?: string; @IsOptional() @IsISO8601({ strict: true }) purchase_date?: string | null;
  @IsOptional() @IsNumber() @Min(0) @Max(100_000_000) purchase_value?: number | null; @IsOptional() @IsUUID() supplier_id?: string | null;
  @IsOptional() @IsISO8601({ strict: true }) warranty_until?: string | null; @IsOptional() @IsString() @MaxLength(2000) notes?: string | null;
}
class AssetPatch {
  @IsOptional() @IsString() @Matches(/^[A-Za-z0-9\-/._]{2,40}$/) inv_no?: string; @IsOptional() @IsString() @Length(2, 200) name?: string; @IsOptional() @IsUUID() category_id?: string;
  @IsOptional() @IsString() @MaxLength(120) manufacturer?: string | null; @IsOptional() @IsString() @MaxLength(120) model?: string | null; @IsOptional() @IsString() @MaxLength(120) serial_no?: string | null;
  @IsOptional() @IsUUID() department_id?: string | null; @IsOptional() @IsString() @MaxLength(60) room?: string | null; @IsOptional() @IsUUID() responsible_user_id?: string | null;
  @IsOptional() @IsString() @MaxLength(30) condition_code?: string; @IsOptional() @IsISO8601({ strict: true }) purchase_date?: string | null;
  @IsOptional() @IsNumber() @Min(0) @Max(100_000_000) purchase_value?: number | null; @IsOptional() @IsUUID() supplier_id?: string | null;
  @IsOptional() @IsISO8601({ strict: true }) warranty_until?: string | null; @IsOptional() @IsString() @MaxLength(2000) notes?: string | null;
}
class MoveDto { @IsUUID() to_department_id: string; @IsOptional() @IsString() @MaxLength(60) to_room?: string | null; @IsOptional() @IsUUID() to_responsible_id?: string | null; @IsOptional() @IsString() @MaxLength(500) reason?: string | null }
class DecideDto { @IsBoolean() accept: boolean; @IsOptional() @IsString() @MaxLength(500) note?: string }
class WriteoffDto { @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @IsUUID('all', { each: true }) asset_ids: string[]; @IsString() @Length(3, 1000) reason: string; @IsOptional() @IsIn(['disposal', 'sale', 'donation', 'transfer', 'other']) method?: string }
class VoteDto { @IsBoolean() approve: boolean; @IsOptional() @IsString() @MaxLength(500) note?: string }
class CategoryDto { @IsOptional() @IsString() @Matches(/^[A-Z][A-Z0-9_]{1,29}$/) code?: string; @IsOptional() @IsString() @Length(2, 120) name?: string; @IsOptional() @IsBoolean() is_active?: boolean; @IsOptional() @IsInt() sort_order?: number }
class ConditionDto { @IsOptional() @IsString() @Matches(/^[a-z][a-z0-9_]{1,29}$/) code?: string; @IsOptional() @IsString() @Length(2, 80) name?: string; @IsOptional() @IsBoolean() usable?: boolean; @IsOptional() @IsBoolean() is_active?: boolean; @IsOptional() @IsInt() sort_order?: number }
const uuidOk = (v?: string) => !v || /^[0-9a-f-]{36}$/i.test(v);

@Controller('assets')
export class AssetsController {
  constructor(private readonly s: AssetsService) {}
  @Get('refs') refs() { return this.s.refs(); }
  @Get('people') people(@Query('search') search?: string) { return this.s.people(search); }
  @Post('categories') @Roles(...ASSET_MANAGE) cat(@Body() d: CategoryDto, @CurrentUser() u: AuthUser, @Req() r: Request) {
    if (!d.code || !d.name) throw new BadRequestException('კოდი და დასახელება სავალდებულოა');
    return this.s.saveCategory(null, d, u, auditCtx(r));
  }
  @Patch('categories/:id') @Roles(...ASSET_MANAGE) catU(@Param('id', ParseUUIDPipe) id: string, @Body() d: CategoryDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.saveCategory(id, d, u, auditCtx(r)); }
  @Post('conditions') @Roles(...ASSET_MANAGE) cond(@Body() d: ConditionDto, @CurrentUser() u: AuthUser, @Req() r: Request) {
    if (!d.code || !d.name) throw new BadRequestException('კოდი და დასახელება სავალდებულოა');
    return this.s.saveCondition(null, d, u, auditCtx(r));
  }
  @Patch('conditions/:code') @Roles(...ASSET_MANAGE) condU(@Param('code') code: string, @Body() d: ConditionDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.saveCondition(code, d, u, auditCtx(r)); }
  @Get('summary') @Roles(...ASSET_VIEW_ALL) summary() { return this.s.summary(); }
  @Get('moves') moves(@CurrentUser() u: AuthUser, @Query('scope') scope?: string) { return this.s.moves(u, { scope }); }
  @Post('moves/:id/decide') @HttpCode(200) decide(@Param('id', ParseUUIDPipe) id: string, @Body() d: DecideDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.decideMove(id, d.accept, d.note, u, auditCtx(r)); }
  @Post('moves/:id/cancel') @HttpCode(200) cancel(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.cancelMove(id, u, auditCtx(r)); }
  @Get('writeoffs') writeoffs(@CurrentUser() u: AuthUser, @Query('status') status?: string) {
    if (status && !['pending', 'approved', 'rejected'].includes(status)) throw new BadRequestException('უცნობი სტატუსი');
    return this.s.writeoffs(u, status);
  }
  @Post('writeoffs') createW(@Body() d: WriteoffDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.createWriteoff(d, u, auditCtx(r)); }
  @Get('writeoffs/:id') oneW(@Param('id', ParseUUIDPipe) id: string) { return this.s.writeoff(id); }
  @Post('writeoffs/:id/vote') @HttpCode(200) vote(@Param('id', ParseUUIDPipe) id: string, @Body() d: VoteDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.vote(id, d.approve, d.note, u, auditCtx(r)); }
  @Get('labels') async labels(@Query('ids') ids: string, @CurrentUser() u: AuthUser, @Res() res: Response) {
    const list = (ids ?? '').split(',').filter(Boolean);
    if (!list.length || list.length > 500 || !list.every((x) => uuidOk(x))) throw new BadRequestException('ids — ინვენტარის id-ები, მძიმით');
    const buf = await this.s.labels(list, u);
    res.setHeader('content-type', 'application/pdf'); res.setHeader('content-disposition', 'inline; filename="labels.pdf"'); res.end(buf);
  }
  @Get('import/template') @Roles(...ASSET_MANAGE) tpl(@Res() res: Response) {
    res.setHeader('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); res.setHeader('content-disposition', 'attachment; filename="assets-template.xlsx"');
    res.end(this.s.template());
  }
  @Post('import') @Roles(...ASSET_MANAGE) @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }))
  import(@UploadedFile() file: Express.Multer.File | undefined, @Query('commit') commit: string | undefined, @CurrentUser() u: AuthUser, @Req() r: Request) {
    if (!file) throw new BadRequestException('ფაილი არ არის');
    return this.s.import(file.buffer, file.originalname, commit === 'true', u, auditCtx(r));
  }
  @Get() list(@CurrentUser() u: AuthUser, @Query() q: { search?: string; category_id?: string; department_id?: string; responsible_user_id?: string; condition?: string; status?: string; room?: string }) {
    if (!uuidOk(q.category_id) || !uuidOk(q.department_id) || !uuidOk(q.responsible_user_id)) throw new BadRequestException('არასწორი id');
    return this.s.list(u, q);
  }
  @Post() create(@Body() d: AssetIn, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.create(d, u, auditCtx(r)); }
  @Get(':id') one(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser) { return this.s.get(id, u); }
  @Patch(':id') update(@Param('id', ParseUUIDPipe) id: string, @Body() d: AssetPatch, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.update(id, d, u, auditCtx(r)); }
  @Post(':id/move') move(@Param('id', ParseUUIDPipe) id: string, @Body() d: MoveDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.move(id, d, u, auditCtx(r)); }
}

@Module({ controllers: [AssetsController], providers: [AssetsService] })
export class AssetsModule {}
