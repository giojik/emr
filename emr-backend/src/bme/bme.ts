import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res,
  StreamableFile, UploadedFile, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import bwipjs from 'bwip-js';
import { IsBoolean, IsIn, IsInt, IsISO8601, IsNumber, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min } from 'class-validator';
import type { Request, Response } from 'express';
import { sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { memoryStorage } from 'multer';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser } from '../auth/roles';
import { mapPgError } from '../common/pg-errors';
import { InjectDb, type Database } from '../database/database.module';
import { newDoc } from '../diagnostics/diagnostics.pdf';
import { ModulesService } from '../modules/modules';
import { NotificationsService } from '../notifications/notifications';
import { sniffMime } from '../patient-files/patient-files';
import { StorageService } from '../storage/storage.service';
import { readCsv, readXlsx, writeXlsx } from '../stock/xlsx';
import {
  AREAS, BME_DEPT, BME_FULL, BME_VIEW_ALL, BmeGuard, CRITICALITY, DOC_KINDS, GROUPS, LINKS, LINK_KA, REASON_REQUIRED, RISK_CLASSES, STATUS_KA, STATUSES, userName, viewScope,
  type Area, type BmeSettings, type BmeStatus, type Ex, type LinkKind, type Trx,
} from './bme-common';
import { ensurePlans } from './bme-pm-common';

const mm = (v: number) => (v * 72) / 25.4;
const tz = 'Asia/Tbilisi';
const MAX_FILE = 20 * 1024 * 1024;
class DryRun extends Error {}

/** პასპორტის რედაქტირებადი ველები (ადგილი — გადაადგილებით, სტატუსი — სტატუსის ცვლილებით, ბმა — ცალკე) */
const FIELDS = ['name', 'type_id', 'manufacturer', 'model', 'serial_no', 'gmdn_code', 'risk_class', 'criticality', 'responsible_user_id', 'manufacture_year', 'install_date',
  'purchase_date', 'purchase_value', 'supplier_id', 'warranty_until', 'asset_id', 'notes'] as const;
type DeviceIn = Partial<Record<(typeof FIELDS)[number], string | number | null>> & { inv_no?: string | null; department_id?: string | null; room?: string | null; or_room_id?: string | null;
  status?: BmeStatus; status_reason?: string | null; link_kind?: LinkKind | null; link_id?: string | null };

@Injectable()
export class BmeService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService, private readonly modules: ModulesService, private readonly notifications: NotificationsService,
    private readonly storage: StorageService, private readonly guard: BmeGuard) {}

  private settings() { return this.modules.require<BmeSettings>('bme'); }
  private event(ex: Ex, deviceId: string, kind: string, data: Record<string, unknown>, u: AuthUser | null) {
    return ex.insertInto('bme_events').values({ device_id: deviceId, kind, data: JSON.stringify(data), user_id: u?.id ?? null }).execute();
  }
  private full(u: AuthUser) { if (!has(u, ...BME_FULL)) throw new ForbiddenException('ბიომედ-აპარატურის მართვა — სამედიცინო ინჟინერი'); }

  // ---------------------------------------------------------------- ცნობარები
  async refs() {
    const settings = await this.settings();
    const types = await this.db.selectFrom('bme_device_types as t')
      .selectAll('t').select(sql<number>`(SELECT count(*)::int FROM bme_devices b WHERE b.type_id = t.id AND b.status <> 'retired')`.as('devices'))
      .orderBy('t.sort_order').orderBy('t.name').execute();
    // საოპერაციო ოთახები — მდებარეობისთვის (საოპერაციოს გაფრთხილებები)
    const or_rooms = await this.db.selectFrom('or_rooms as o').innerJoin('departments as d', 'd.id', 'o.department_id')
      .select(['o.id', 'o.code', 'o.name', 'o.department_id', 'd.name as department_name']).where('o.is_active', '=', true).orderBy('o.sort_order').orderBy('o.name').execute();
    return { settings, types, or_rooms, statuses: STATUSES, groups: GROUPS, criticality: CRITICALITY, risk_classes: RISK_CLASSES, doc_kinds: DOC_KINDS, links: Object.keys(LINKS) };
  }
  async saveType(id: string | null, dto: TypeDto, ctx: AuditContext) {
    await this.settings();
    const vals = {
      ...(dto.name !== undefined && { name: dto.name.trim() }), ...(dto.grp !== undefined && { grp: dto.grp }),
      ...(dto.default_criticality !== undefined && { default_criticality: dto.default_criticality }), ...(dto.default_risk_class !== undefined && { default_risk_class: dto.default_risk_class }),
      ...(dto.pm_months !== undefined && { pm_months: dto.pm_months }), ...(dto.calibration_months !== undefined && { calibration_months: dto.calibration_months }),
      ...(dto.safety_months !== undefined && { safety_months: dto.safety_months }), ...(dto.is_active !== undefined && { is_active: dto.is_active }),
      ...(dto.sort_order !== undefined && { sort_order: dto.sort_order }),
    };
    try {
      const r = id ? await this.db.updateTable('bme_device_types').set({ ...vals, updated_at: sql`now()` }).where('id', '=', id).returningAll().executeTakeFirst()
        : await this.db.insertInto('bme_device_types').values({ code: dto.code!, name: dto.name!.trim(), grp: dto.grp ?? 'other', ...vals }).returningAll().executeTakeFirst();
      if (!r) throw new NotFoundException('ტიპი ვერ მოიძებნა');
      await this.audit.log(ctx, { action: id ? 'UPDATE_BME_TYPE' : 'CREATE_BME_TYPE', entityName: 'bme_device_types', entityId: r.id, newData: dto });
      return r;
    } catch (e) { mapPgError(e, { bme_device_types_code_key: 'იგივე კოდი უკვე არსებობს' }); }
  }
  /** პასუხისმგებლის / მიმღების ასარჩევად — აქტიური თანამშრომლები */
  async people(search?: string) {
    await this.settings();
    let x = this.db.selectFrom('users as u').leftJoin('departments as d', 'd.id', 'u.department_id')
      .select(['u.id', userName('u').as('name'), 'u.department_id', 'd.name as department_name']).where('u.is_active', '=', true).orderBy('u.last_name').limit(30);
    const s = search?.trim().toLowerCase();
    if (s) x = x.where(sql`lower(u.first_name || ' ' || u.last_name || ' ' || coalesce(u.email, ''))`, 'like', `%${s}%`);
    return x.execute();
  }

  // ---------------------------------------------------------------- რეესტრი
  private base(ex: Ex = this.db) {
    return ex.selectFrom('bme_devices as b').innerJoin('bme_device_types as t', 't.id', 'b.type_id')
      .leftJoin('departments as d', 'd.id', 'b.department_id').leftJoin('users as r', 'r.id', 'b.responsible_user_id').leftJoin('stock_suppliers as s', 's.id', 'b.supplier_id')
      .leftJoin('or_rooms as o', 'o.id', 'b.or_room_id').leftJoin('assets as a', 'a.id', 'b.asset_id')
      .leftJoin('dx_devices as x', 'x.id', 'b.dx_device_id').leftJoin('lab_methods as lm', 'lm.id', 'b.lab_method_id')
      .leftJoin('cssd_machines as cm', 'cm.id', 'b.cssd_machine_id').leftJoin('endo_scopes as es', 'es.id', 'b.endo_scope_id')
      .selectAll('b').select(['t.code as type_code', 't.name as type_name', 't.grp', 'd.name as department_name', 's.name as supplier_name', 'o.name as or_room_name', 'a.inv_no as asset_inv_no',
        userName('r').as('responsible_name'),
        sql<string | null>`CASE WHEN b.dx_device_id IS NOT NULL THEN 'dx_device' WHEN b.lab_method_id IS NOT NULL THEN 'lab_method' WHEN b.cssd_machine_id IS NOT NULL THEN 'cssd_machine'
          WHEN b.endo_scope_id IS NOT NULL THEN 'endo_scope' END`.as('link_kind'),
        sql<string | null>`coalesce(x.name || ' (' || x.section || ')', lm.name, cm.name, es.name || ' · ' || es.serial_number)`.as('link_name'),
        sql<string | null>`(SELECT m.id FROM bme_moves m WHERE m.device_id = b.id AND m.status = 'pending')`.as('pending_move_id'),
        // 0074: უახლოესი გეგმიური სამუშაო
        sql<string | null>`(SELECT to_char(min(p.next_due), 'YYYY-MM-DD') FROM bme_plans p WHERE p.device_id = b.id AND p.is_active)`.as('pm_next_due'),
        sql<number>`(SELECT count(*)::int FROM bme_plans p WHERE p.device_id = b.id AND p.is_active AND p.next_due < (now() AT TIME ZONE ${tz})::date)`.as('pm_overdue'),
        sql<boolean>`b.warranty_until IS NOT NULL AND b.warranty_until >= (now() AT TIME ZONE ${tz})::date`.as('under_warranty')]);
  }

  async list(u: AuthUser, q: ListQ) {
    await this.settings();
    let x = this.base().orderBy('b.inv_no').limit(3000);
    const sc = await viewScope(this.db, u);
    if (!sc.all) { if (!sc.depts.length) return []; x = x.where('b.department_id', 'in', sc.depts); }
    if (q.status === 'active') x = x.where('b.status', '<>', 'retired');
    else if (q.status === 'unavailable') x = x.where('b.status', 'in', ['restricted', 'down']);
    else if (q.status && (STATUSES as readonly string[]).includes(q.status)) x = x.where('b.status', '=', q.status);
    if (q.department_id) x = x.where('b.department_id', '=', q.department_id);
    if (q.type_id) x = x.where('b.type_id', '=', q.type_id);
    if (q.grp) x = x.where('t.grp', '=', q.grp);
    if (q.criticality) x = x.where('b.criticality', '=', q.criticality);
    if (q.needs_review === '1') x = x.where('b.needs_review', '=', true);
    if (q.link === 'none') x = x.where(sql<boolean>`num_nonnulls(b.dx_device_id, b.lab_method_id, b.cssd_machine_id, b.endo_scope_id) = 0`);
    else if (q.link && q.link in LINKS) x = x.where(LINKS[q.link as LinkKind], 'is not', null);
    if (q.or_room_id) x = x.where('b.or_room_id', '=', q.or_room_id);
    const s = q.search?.trim();
    if (s) {
      const inv = this.invFromCode(s) ?? s;
      x = x.where((eb) => eb.or([eb(sql`upper(b.inv_no)`, 'like', `%${inv.toUpperCase()}%`), eb(sql`lower(b.name)`, 'like', `%${s.toLowerCase()}%`),
        eb(sql`upper(coalesce(b.serial_no, ''))`, 'like', `%${s.toUpperCase()}%`), eb(sql`lower(coalesce(b.model, '') || ' ' || coalesce(b.manufacturer, ''))`, 'like', `%${s.toLowerCase()}%`)]));
    }
    return x.execute();
  }

  private async canView(u: AuthUser, d: { department_id: string | null }, pendingTo?: string | null) {
    const sc = await viewScope(this.db, u);
    return sc.all || (!!d.department_id && sc.depts.includes(d.department_id)) || (!!pendingTo && sc.depts.includes(pendingTo));
  }

  async get(id: string, u: AuthUser) {
    await this.settings();
    const d = await this.base().where('b.id', '=', id).executeTakeFirst();
    if (!d) throw new NotFoundException('აპარატი ვერ მოიძებნა');
    const pend = d.pending_move_id ? await this.db.selectFrom('bme_moves').select(['to_department_id']).where('id', '=', d.pending_move_id).executeTakeFirst() : undefined;
    if (!(await this.canView(u, d, pend?.to_department_id))) throw new ForbiddenException('აპარატი თქვენს განყოფილებაზე არ არის');
    const [events, periods, documents] = await Promise.all([
      this.db.selectFrom('bme_events as e').leftJoin('users as u', 'u.id', 'e.user_id').select(['e.id', 'e.kind', 'e.data', 'e.created_at', userName('u').as('user_name')])
        .where('e.device_id', '=', id).orderBy('e.id', 'desc').limit(300).execute(),
      this.db.selectFrom('bme_status_periods as p').leftJoin('users as u', 'u.id', 'p.started_by')
        .select(['p.id', 'p.status', 'p.reason', 'p.started_at', 'p.ended_at', userName('u').as('started_by_name'),
          sql<number>`round(extract(epoch FROM coalesce(p.ended_at, now()) - p.started_at) / 3600.0, 1)::float`.as('hours')])
        .where('p.device_id', '=', id).orderBy('p.started_at', 'desc').limit(200).execute(),
      this.documents(id),
    ]);
    return { ...d, events, periods, documents };
  }

  private async nextInv(trx: Trx, s: BmeSettings) {
    const yr = Number(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric' }).format(new Date()));
    const year = s.inv_year ? yr : 0;
    for (let i = 0; i < 50; i++) {
      const { last_value } = await trx.insertInto('document_counters').values({ document_type: `bme_${s.inv_prefix || 'BME'}`, year, last_value: 1 })
        .onConflict((oc) => oc.columns(['document_type', 'year']).doUpdateSet({ last_value: sql`document_counters.last_value + 1` })).returning('last_value').executeTakeFirstOrThrow();
      const no = [s.inv_prefix, s.inv_year ? String(yr).slice(2) : '', String(last_value).padStart(s.inv_digits, '0')].filter(Boolean).join('-');
      if (!(await trx.selectFrom('bme_devices').select('id').where('inv_no', '=', no).executeTakeFirst())) return no;
    }
    throw new ConflictException('საინვენტარო ნომრის გენერაცია ვერ მოხერხდა');
  }

  private clean(dto: DeviceIn) {
    const o: Record<string, unknown> = {};
    for (const k of FIELDS) {
      if (dto[k] === undefined) continue;
      const v = dto[k];
      o[k] = typeof v === 'string' ? (v.trim() || null) : k === 'purchase_value' && v !== null ? String(v) : v;
    }
    if (typeof o.serial_no === 'string') o.serial_no = (o.serial_no as string).toUpperCase();
    return o;
  }
  private async checkRefs(ex: Ex, o: Record<string, unknown>) {
    if (o.type_id) {
      const t = await ex.selectFrom('bme_device_types').select(['is_active']).where('id', '=', o.type_id as string).executeTakeFirst();
      if (!t) throw new BadRequestException('ტიპი ვერ მოიძებნა');
    }
    if (o.asset_id) {
      const a = await ex.selectFrom('assets').select('status').where('id', '=', o.asset_id as string).executeTakeFirst();
      if (!a) throw new BadRequestException('ინვენტარის ჩანაწერი ვერ მოიძებნა');
    }
  }
  private async checkLocation(ex: Ex, s: BmeSettings, loc: { department_id?: string | null; or_room_id?: string | null }) {
    if (s.require_department && !loc.department_id) throw new BadRequestException('განყოფილება სავალდებულოა (პარამეტრი)');
    if (loc.department_id && !(await ex.selectFrom('departments').select('id').where('id', '=', loc.department_id).where('is_active', '=', true).executeTakeFirst())) throw new BadRequestException('განყოფილება ვერ მოიძებნა ან გათიშულია');
    if (loc.or_room_id && !(await ex.selectFrom('or_rooms').select('id').where('id', '=', loc.or_room_id).executeTakeFirst())) throw new BadRequestException('საოპერაციო ოთახი ვერ მოიძებნა');
  }
  private static readonly PG = {
    bme_devices_inv_no_key: 'ეს საინვენტარო ნომერი უკვე გამოყენებულია', ux_bme_serial: 'იგივე სერიული ნომერი (მწარმოებლით) უკვე რეესტრშია',
    bme_devices_asset_id_key: 'ეს ინვენტარის ჩანაწერი სხვა აპარატს უკვე მიებმა', bme_devices_dx_device_id_key: 'ეს აპარატი სხვა პასპორტს უკვე მიებმა',
    bme_devices_lab_method_id_key: 'ეს ანალიზატორი სხვა პასპორტს უკვე მიებმა', bme_devices_cssd_machine_id_key: 'ეს CSSD აპარატი სხვა პასპორტს უკვე მიებმა',
    bme_devices_endo_scope_id_key: 'ეს ენდოსკოპი სხვა პასპორტს უკვე მიებმა', chk_bme_one_link: 'პასპორტს მხოლოდ ერთი ოპერაციული ჩანაწერი მიებმება',
  };

  async create(dto: DeviceIn, u: AuthUser, ctx: AuditContext) {
    this.full(u);
    const s = await this.settings();
    if (!dto.name || !dto.type_id) throw new BadRequestException('დასახელება და ტიპი სავალდებულოა');
    try {
      const id = await this.db.transaction().execute(async (trx) => {
        await this.checkLocation(trx, s, dto);
        const o = this.clean(dto);
        await this.checkRefs(trx, o);
        const t = await trx.selectFrom('bme_device_types').select(['default_criticality', 'default_risk_class', 'is_active']).where('id', '=', dto.type_id as string).executeTakeFirstOrThrow();
        if (!t.is_active) throw new BadRequestException('ტიპი გათიშულია');
        const status = dto.status ?? 'operational';
        if (REASON_REQUIRED.includes(status) && !dto.status_reason?.trim()) throw new BadRequestException('სტატუსის მიზეზი სავალდებულოა');
        const link = dto.link_kind && dto.link_id ? await this.resolveLink(trx, dto.link_kind, dto.link_id) : null;
        const inv = dto.inv_no?.trim().toUpperCase() || await this.nextInv(trx, s);
        const b = await trx.insertInto('bme_devices').values({
          ...(o as { name: string; type_id: string }), inv_no: inv, criticality: (o.criticality as string) ?? t.default_criticality, risk_class: o.risk_class !== undefined ? (o.risk_class as string | null) : t.default_risk_class,
          department_id: dto.department_id ?? null, room: dto.room?.trim() || null, or_room_id: dto.or_room_id ?? null, status, status_reason: dto.status_reason?.trim() || null,
          ...(link && { [LINKS[link.kind]]: link.id }), created_by: u.id,
        }).returning('id').executeTakeFirstOrThrow();
        await trx.insertInto('bme_status_periods').values({ device_id: b.id, status, reason: dto.status_reason?.trim() || null, started_by: u.id }).execute();
        await this.event(trx, b.id, 'created', { inv_no: inv, department_id: dto.department_id ?? null, room: dto.room ?? null, ...(link && { link: link.kind, link_name: link.name }) }, u);
        if (s.pm_auto_plans !== false) await ensurePlans(trx, b.id, u.id);
        await this.audit.log(ctx, { action: 'CREATE_BME_DEVICE', entityName: 'bme_devices', entityId: b.id, newData: { ...dto, inv_no: inv } }, trx);
        return b.id;
      });
      return this.get(id, u);
    } catch (e) { mapPgError(e, BmeService.PG); }
  }

  async update(id: string, dto: DeviceIn, u: AuthUser, ctx: AuditContext) {
    this.full(u);
    await this.settings();
    if (dto.department_id !== undefined || dto.room !== undefined || dto.or_room_id !== undefined) throw new BadRequestException('მდებარეობა იცვლება გადაადგილებით');
    if (dto.status !== undefined) throw new BadRequestException('სტატუსი იცვლება სტატუსის ცვლილებით (მიზეზით)');
    try {
      await this.db.transaction().execute(async (trx) => {
        const old = await trx.selectFrom('bme_devices').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
        if (!old) throw new NotFoundException('აპარატი ვერ მოიძებნა');
        const set = this.clean(dto);
        await this.checkRefs(trx, set);
        if (dto.inv_no && dto.inv_no.trim().toUpperCase() !== old.inv_no) set.inv_no = dto.inv_no.trim().toUpperCase();
        const changed = Object.keys(set).filter((k) => String((old as Record<string, unknown>)[k] ?? '') !== String(set[k] ?? ''));
        if (!changed.length) return;
        await trx.updateTable('bme_devices').set({ ...set, updated_at: sql`now()` }).where('id', '=', id).execute();
        await this.event(trx, id, 'updated', { fields: changed }, u);
        if (changed.includes('type_id') || changed.includes('install_date')) {
          const s = await this.settings();
          if (s.pm_auto_plans !== false) await ensurePlans(trx, id, u.id);
        }
        await this.audit.log(ctx, { action: 'UPDATE_BME_DEVICE', entityName: 'bme_devices', entityId: id, oldData: Object.fromEntries(changed.map((k) => [k, (old as Record<string, unknown>)[k]])), newData: set }, trx);
      });
    } catch (e) { mapPgError(e, BmeService.PG); }
    return this.get(id, u);
  }

  /** „შესავსები“ (backfill) — ინჟინერმა გადაამოწმა */
  async review(id: string, u: AuthUser, ctx: AuditContext) {
    this.full(u);
    const s = await this.settings();
    await this.db.transaction().execute(async (trx) => {
      const d = await trx.selectFrom('bme_devices').select(['needs_review', 'department_id']).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!d) throw new NotFoundException('აპარატი ვერ მოიძებნა');
      if (!d.needs_review) throw new ConflictException('აპარატი უკვე გადამოწმებულია');
      if (s.require_department && !d.department_id) throw new BadRequestException('ჯერ მიუთითეთ განყოფილება (გადაადგილება)');
      await trx.updateTable('bme_devices').set({ needs_review: false, updated_at: sql`now()` }).where('id', '=', id).execute();
      await this.event(trx, id, 'reviewed', {}, u);
      await this.audit.log(ctx, { action: 'REVIEW_BME_DEVICE', entityName: 'bme_devices', entityId: id }, trx);
    });
    return this.get(id, u);
  }

  // ---------------------------------------------------------------- სტატუსი
  async setStatus(id: string, dto: { status: BmeStatus; reason?: string | null }, u: AuthUser, ctx: AuditContext) {
    this.full(u);
    await this.settings();
    const reason = dto.reason?.trim() || null;
    if (REASON_REQUIRED.includes(dto.status) && (!reason || reason.length < 3)) throw new BadRequestException(`სტატუსზე „${STATUS_KA[dto.status]}“ მიზეზი სავალდებულოა`);
    let notifyIds: string[] = []; let title = '';
    await this.db.transaction().execute(async (trx) => {
      const d = await trx.selectFrom('bme_devices').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!d) throw new NotFoundException('აპარატი ვერ მოიძებნა');
      if (d.status === dto.status && (d.status_reason ?? '') === (reason ?? '')) throw new ConflictException('სტატუსი უკვე ასეთია');
      if (dto.status === 'retired') {
        const pm = await trx.selectFrom('bme_moves').select('id').where('device_id', '=', id).where('status', '=', 'pending').executeTakeFirst();
        if (pm) throw new ConflictException('გადაადგილება მიმდინარეობს — ჯერ დაასრულეთ ან გააუქმეთ');
      }
      await trx.updateTable('bme_status_periods').set({ ended_at: sql`now()`, ended_by: u.id }).where('device_id', '=', id).where('ended_at', 'is', null).execute();
      await trx.insertInto('bme_status_periods').values({ device_id: id, status: dto.status, reason, started_by: u.id }).execute();
      await trx.updateTable('bme_devices').set({ status: dto.status, status_reason: reason, status_since: sql`now()`, updated_at: sql`now()` }).where('id', '=', id).execute();
      await this.event(trx, id, 'status', { from: d.status, to: dto.status, reason }, u);
      if (dto.status === 'retired') {   // 0074: გეგმები ჩერდება, ღია სამუშაოები უქმდება
        await trx.updateTable('bme_plans').set({ is_active: false, updated_at: sql`now()` }).where('device_id', '=', id).where('is_active', '=', true).execute();
        await trx.updateTable('bme_works').set({ status: 'cancelled', cancel_reason: 'აპარატი გამოყვანილია', updated_at: sql`now()` })
          .where('device_id', '=', id).where('status', 'in', ['planned', 'in_progress']).execute();
      }
      await this.audit.log(ctx, { action: 'BME_STATUS', entityName: 'bme_devices', entityId: id, oldData: { status: d.status, reason: d.status_reason }, newData: { status: dto.status, reason } }, trx);
      // განყოფილების (bme_dept) და პასუხისმგებლის ინფორმირება: გაუმართავი / შეზღუდული / აღდგა
      if (d.department_id && (['down', 'restricted'].includes(dto.status) || (['down', 'restricted'].includes(d.status) && dto.status === 'operational'))) {
        const r = await sql<{ id: string }>`
          SELECT u.id FROM users u JOIN user_capabilities c ON c.user_id = u.id
           WHERE u.is_active AND c.capabilities && ARRAY['bme_dept']::varchar[]
             AND (u.department_id = ${d.department_id} OR EXISTS (SELECT 1 FROM rpt_user_scopes s WHERE s.user_id = u.id AND s.department_id = ${d.department_id}))`.execute(trx);
        notifyIds = [...r.rows.map((x) => x.id), ...(d.responsible_user_id ? [d.responsible_user_id] : [])];
        title = `${d.inv_no} ${d.name}: ${STATUS_KA[dto.status]}`;
      }
    });
    for (const nid of new Set(notifyIds)) if (nid !== u.id) await this.notifications.notify(nid, { kind: 'bme_status', title, body: reason, link: `/bme?device=${id}`, entityId: id });
    return this.get(id, u);
  }

  // ---------------------------------------------------------------- გადაადგილება
  async move(id: string, dto: MoveDto, u: AuthUser, ctx: AuditContext) {
    this.full(u);
    const s = await this.settings();
    let moveId = ''; let direct = false; let notify: string[] = []; let title = '';
    await this.db.transaction().execute(async (trx) => {
      await this.checkLocation(trx, { ...s, require_department: true }, { department_id: dto.to_department_id, or_room_id: dto.to_or_room_id });
      const d = await trx.selectFrom('bme_devices').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!d) throw new NotFoundException('აპარატი ვერ მოიძებნა');
      if (d.status === 'retired') throw new ConflictException('გამოყვანილი აპარატი არ გადაადგილდება');
      if (await trx.selectFrom('bme_moves').select('id').where('device_id', '=', id).where('status', '=', 'pending').executeTakeFirst()) throw new ConflictException('გადაადგილება უკვე მიმდინარეობს — ელოდება მიმღებს');
      const to = { department_id: dto.to_department_id, room: dto.to_room?.trim() || null, or_room_id: dto.to_or_room_id ?? null };
      if (d.department_id === to.department_id && (d.room ?? '') === (to.room ?? '') && (d.or_room_id ?? null) === to.or_room_id && (dto.to_responsible_id === undefined || dto.to_responsible_id === d.responsible_user_id))
        throw new BadRequestException('ახალი ადგილი ძველს ემთხვევა');
      // დადასტურება საჭიროა, თუ რეჟიმი confirm და განყოფილება იცვლება (იმავე განყოფილების შიგნით — პირდაპირ)
      direct = s.move_mode === 'direct' || d.department_id === to.department_id;
      const m = await trx.insertInto('bme_moves').values({ device_id: id, from_department_id: d.department_id, from_room: d.room, from_or_room_id: d.or_room_id,
        to_department_id: to.department_id, to_room: to.room, to_or_room_id: to.or_room_id, to_responsible_id: dto.to_responsible_id ?? null, status: direct ? 'done' : 'pending',
        reason: dto.reason?.trim() || null, requested_by: u.id, ...(direct && { decided_by: u.id, decided_at: sql`now()` }) }).returning('id').executeTakeFirstOrThrow();
      moveId = m.id; title = `${d.inv_no} ${d.name}`;
      if (direct) {
        await trx.updateTable('bme_devices').set({ department_id: to.department_id, room: to.room, or_room_id: to.or_room_id,
          ...(dto.to_responsible_id !== undefined && { responsible_user_id: dto.to_responsible_id }), updated_at: sql`now()` }).where('id', '=', id).execute();
        await this.event(trx, id, 'moved', { move_id: m.id, from: { department_id: d.department_id, room: d.room, or_room_id: d.or_room_id }, to, reason: dto.reason ?? null }, u);
      } else {
        await this.event(trx, id, 'move_requested', { move_id: m.id, to, reason: dto.reason ?? null }, u);
        notify = await this.receivers(trx, to.department_id);
      }
      await this.audit.log(ctx, { action: direct ? 'MOVE_BME_DEVICE' : 'REQUEST_BME_MOVE', entityName: 'bme_devices', entityId: id, newData: { ...dto, move_id: m.id } }, trx);
    });
    for (const nid of new Set(notify)) if (nid !== u.id) await this.notifications.notify(nid, { kind: 'bme_move', title: `აპარატი გადმოგეცემათ: ${title}`, body: 'დაადასტურეთ მიღება', link: '/bme?tab=incoming', entityId: moveId });
    return { move_id: moveId, status: direct ? 'done' : 'pending', device: await this.get(id, u) };
  }
  /** მიმღები: განყოფილების bme_dept (+ რეპორტინგის ხედვის არე); თუ არავინ — სამედიცინო ინჟინრები */
  private async receivers(ex: Ex, dep: string) {
    const r = await sql<{ id: string }>`
      SELECT u.id FROM users u JOIN user_capabilities c ON c.user_id = u.id
       WHERE u.is_active AND c.capabilities && ARRAY['bme_dept']::varchar[]
         AND (u.department_id = ${dep} OR EXISTS (SELECT 1 FROM rpt_user_scopes s WHERE s.user_id = u.id AND s.department_id = ${dep}))`.execute(ex);
    if (r.rows.length) return r.rows.map((x) => x.id);
    return (await sql<{ id: string }>`SELECT u.id FROM users u JOIN user_capabilities c ON c.user_id = u.id WHERE u.is_active AND c.capabilities && ARRAY['med_engineer']::varchar[]`.execute(ex)).rows.map((x) => x.id);
  }
  private async canReceive(u: AuthUser, depId: string) {
    if (has(u, ...BME_FULL)) return true;
    if (!has(u, ...BME_DEPT)) return false;
    const sc = await viewScope(this.db, u);
    return sc.all || sc.depts.includes(depId);
  }

  async moves(u: AuthUser, q: { scope?: string; device_id?: string }) {
    await this.settings();
    let x = this.db.selectFrom('bme_moves as m').innerJoin('bme_devices as b', 'b.id', 'm.device_id').innerJoin('users as rq', 'rq.id', 'm.requested_by')
      .leftJoin('departments as fd', 'fd.id', 'm.from_department_id').leftJoin('departments as td', 'td.id', 'm.to_department_id')
      .leftJoin('or_rooms as fo', 'fo.id', 'm.from_or_room_id').leftJoin('or_rooms as tor', 'tor.id', 'm.to_or_room_id').leftJoin('users as tr', 'tr.id', 'm.to_responsible_id')
      .select(['m.id', 'm.device_id', 'm.status', 'm.reason', 'm.decision_note', 'm.requested_at', 'm.decided_at', 'm.from_room', 'm.to_room', 'm.to_department_id', 'b.inv_no', 'b.name as device_name',
        'fd.name as from_department', 'td.name as to_department', 'fo.name as from_or_room', 'tor.name as to_or_room', userName('tr').as('to_responsible'), userName('rq').as('requested_by_name')])
      .orderBy('m.requested_at', 'desc').limit(500);
    if (q.device_id) x = x.where('m.device_id', '=', q.device_id);
    if (q.scope === 'incoming') {
      x = x.where('m.status', '=', 'pending');
      if (!has(u, ...BME_FULL)) {
        if (!has(u, ...BME_DEPT)) return [];
        const sc = await viewScope(this.db, u);
        if (!sc.all) { if (!sc.depts.length) return []; x = x.where('m.to_department_id', 'in', sc.depts); }
      }
    } else if (!has(u, ...BME_VIEW_ALL)) {
      const sc = await viewScope(this.db, u);
      if (!sc.all) { if (!sc.depts.length) return []; x = x.where((eb) => eb.or([eb('m.to_department_id', 'in', sc.depts), eb('m.from_department_id', 'in', sc.depts)])); }
    }
    return x.execute();
  }

  async decideMove(id: string, accept: boolean, note: string | undefined, u: AuthUser, ctx: AuditContext) {
    await this.settings();
    let requester = ''; let label = '';
    await this.db.transaction().execute(async (trx) => {
      const m = await trx.selectFrom('bme_moves').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!m) throw new NotFoundException('გადაადგილება ვერ მოიძებნა');
      if (m.status !== 'pending') throw new ConflictException('გადაადგილება უკვე გადაწყვეტილია');
      if (!(await this.canReceive(u, m.to_department_id))) throw new ForbiddenException('დადასტურება — მიმღები განყოფილება (bme_dept) ან სამედიცინო ინჟინერი');
      if (!accept && (!note || note.trim().length < 3)) throw new BadRequestException('უარის მიზეზი სავალდებულოა');
      await trx.updateTable('bme_moves').set({ status: accept ? 'done' : 'rejected', decided_by: u.id, decided_at: sql`now()`, decision_note: note?.trim() || null }).where('id', '=', id).execute();
      const d = await trx.selectFrom('bme_devices').select(['inv_no', 'name', 'department_id', 'room', 'or_room_id']).where('id', '=', m.device_id).forUpdate().executeTakeFirstOrThrow();
      requester = m.requested_by; label = `${d.inv_no} ${d.name}`;
      if (accept) {
        await trx.updateTable('bme_devices').set({ department_id: m.to_department_id, room: m.to_room, or_room_id: m.to_or_room_id,
          ...(m.to_responsible_id && { responsible_user_id: m.to_responsible_id }), updated_at: sql`now()` }).where('id', '=', m.device_id).execute();
        await this.event(trx, m.device_id, 'moved', { move_id: id, from: { department_id: d.department_id, room: d.room, or_room_id: d.or_room_id },
          to: { department_id: m.to_department_id, room: m.to_room, or_room_id: m.to_or_room_id }, note: note ?? null }, u);
      } else await this.event(trx, m.device_id, 'move_rejected', { move_id: id, note }, u);
      await this.audit.log(ctx, { action: accept ? 'ACCEPT_BME_MOVE' : 'REJECT_BME_MOVE', entityName: 'bme_moves', entityId: id, newData: { note } }, trx);
    });
    if (requester && requester !== u.id) await this.notifications.notify(requester, { kind: 'bme_move', title: `${label}: ${accept ? 'მიღება დადასტურდა' : 'მიღებაზე უარი'}`, body: note, link: '/bme?tab=moves', entityId: id });
    return { status: accept ? 'done' : 'rejected' };
  }

  async cancelMove(id: string, u: AuthUser, ctx: AuditContext) {
    this.full(u);
    await this.settings();
    await this.db.transaction().execute(async (trx) => {
      const m = await trx.selectFrom('bme_moves').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!m) throw new NotFoundException('გადაადგილება ვერ მოიძებნა');
      if (m.status !== 'pending') throw new ConflictException('გადაადგილება უკვე გადაწყვეტილია');
      await trx.updateTable('bme_moves').set({ status: 'cancelled', decided_by: u.id, decided_at: sql`now()` }).where('id', '=', id).execute();
      await this.event(trx, m.device_id, 'move_cancelled', { move_id: id }, u);
      await this.audit.log(ctx, { action: 'CANCEL_BME_MOVE', entityName: 'bme_moves', entityId: id }, trx);
    });
    return { status: 'cancelled' };
  }

  // ---------------------------------------------------------------- ბმები ოპერაციულ ჩანაწერებთან
  private async resolveLink(ex: Ex, kind: LinkKind, targetId: string): Promise<{ kind: LinkKind; id: string; name: string }> {
    if (!(kind in LINKS)) throw new BadRequestException('უცნობი ბმის სახეობა');
    const row = kind === 'dx_device' ? await ex.selectFrom('dx_devices').select(['id', sql<string>`name || ' (' || section || ')'`.as('name')]).where('id', '=', targetId).executeTakeFirst()
      : kind === 'lab_method' ? await ex.selectFrom('lab_methods').select(['id', 'name', 'kind']).where('id', '=', targetId).executeTakeFirst()
        : kind === 'cssd_machine' ? await ex.selectFrom('cssd_machines').select(['id', 'name']).where('id', '=', targetId).executeTakeFirst()
          : await ex.selectFrom('endo_scopes').select(['id', sql<string>`name || ' · ' || serial_number`.as('name')]).where('id', '=', targetId).executeTakeFirst();
    if (!row) throw new BadRequestException(`${LINK_KA[kind]} ვერ მოიძებნა`);
    if (kind === 'lab_method' && (row as { kind?: string }).kind !== 'analyzer') throw new BadRequestException('მიება მხოლოდ ანალიზატორი (არა ხელით მეთოდი)');
    return { kind, id: row.id, name: row.name };
  }

  async link(id: string, dto: { kind: LinkKind; target_id: string }, u: AuthUser, ctx: AuditContext) {
    this.full(u);
    await this.settings();
    try {
      await this.db.transaction().execute(async (trx) => {
        const d = await trx.selectFrom('bme_devices').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
        if (!d) throw new NotFoundException('აპარატი ვერ მოიძებნა');
        if (d.dx_device_id || d.lab_method_id || d.cssd_machine_id || d.endo_scope_id) throw new ConflictException('პასპორტს უკვე აქვს ბმა — ჯერ მოხსენით');
        const l = await this.resolveLink(trx, dto.kind, dto.target_id);
        await trx.updateTable('bme_devices').set({ [LINKS[l.kind]]: l.id, updated_at: sql`now()` }).where('id', '=', id).execute();
        await this.event(trx, id, 'linked', { kind: l.kind, target_id: l.id, name: l.name }, u);
        await this.audit.log(ctx, { action: 'LINK_BME_DEVICE', entityName: 'bme_devices', entityId: id, newData: { kind: l.kind, target_id: l.id } }, trx);
      });
    } catch (e) { mapPgError(e, BmeService.PG); }
    return this.get(id, u);
  }
  async unlink(id: string, u: AuthUser, ctx: AuditContext) {
    this.full(u);
    await this.settings();
    await this.db.transaction().execute(async (trx) => {
      const d = await trx.selectFrom('bme_devices').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!d) throw new NotFoundException('აპარატი ვერ მოიძებნა');
      const kind = (Object.keys(LINKS) as LinkKind[]).find((k) => d[LINKS[k]]);
      if (!kind) throw new ConflictException('პასპორტს ბმა არ აქვს');
      await trx.updateTable('bme_devices').set({ dx_device_id: null, lab_method_id: null, cssd_machine_id: null, endo_scope_id: null, updated_at: sql`now()` }).where('id', '=', id).execute();
      await this.event(trx, id, 'unlinked', { kind, target_id: d[LINKS[kind]] }, u);
      await this.audit.log(ctx, { action: 'UNLINK_BME_DEVICE', entityName: 'bme_devices', entityId: id, oldData: { kind, target_id: d[LINKS[kind]] } }, trx);
    });
    return this.get(id, u);
  }

  /** ოპერაციული ჩანაწერები პასპორტის გარეშე (ახლად დამატებული აპარატი / ანალიზატორი / ენდოსკოპი…) */
  async unlinked(u: AuthUser) {
    this.full(u);
    await this.settings();
    const [dx, lab, cssd, scopes] = await Promise.all([
      this.db.selectFrom('dx_devices as x').select(['x.id', 'x.name', 'x.section as sub', 'x.room', 'x.is_active', sql<string | null>`NULL`.as('serial_no'), sql<string | null>`array_to_string(x.modalities, ', ')`.as('extra')])
        .where(({ not, exists, selectFrom }) => not(exists(selectFrom('bme_devices as b').select('b.id').whereRef('b.dx_device_id', '=', 'x.id')))).orderBy('x.name').execute(),
      this.db.selectFrom('lab_methods as m').select(['m.id', 'm.name', sql<string>`'analyzer'`.as('sub'), sql<string | null>`NULL`.as('room'), 'm.is_active', 'm.serial_number as serial_no', 'm.manufacturer as extra'])
        .where('m.kind', '=', 'analyzer').where(({ not, exists, selectFrom }) => not(exists(selectFrom('bme_devices as b').select('b.id').whereRef('b.lab_method_id', '=', 'm.id')))).orderBy('m.name').execute(),
      this.db.selectFrom('cssd_machines as c').select(['c.id', 'c.name', 'c.kind as sub', sql<string | null>`NULL`.as('room'), 'c.is_active', 'c.serial_no', 'c.model as extra'])
        .where(({ not, exists, selectFrom }) => not(exists(selectFrom('bme_devices as b').select('b.id').whereRef('b.cssd_machine_id', '=', 'c.id')))).orderBy('c.name').execute(),
      this.db.selectFrom('endo_scopes as s').select(['s.id', 's.name', 's.scope_type as sub', sql<string | null>`NULL`.as('room'), 's.is_active', 's.serial_number as serial_no', sql<string | null>`NULL`.as('extra')])
        .where(({ not, exists, selectFrom }) => not(exists(selectFrom('bme_devices as b').select('b.id').whereRef('b.endo_scope_id', '=', 's.id')))).orderBy('s.name').execute(),
    ]);
    return [...dx.map((r) => ({ ...r, kind: 'dx_device' })), ...lab.map((r) => ({ ...r, kind: 'lab_method' })), ...cssd.map((r) => ({ ...r, kind: 'cssd_machine' })), ...scopes.map((r) => ({ ...r, kind: 'endo_scope' }))];
  }

  /** პასპორტი ოპერაციული ჩანაწერიდან (ტიპი — ავტომატურად; needs_review — შესავსები) */
  async fromLink(dto: { kind: LinkKind; target_id: string; department_id?: string | null }, u: AuthUser, ctx: AuditContext) {
    this.full(u);
    const s = await this.settings();
    try {
      const id = await this.db.transaction().execute(async (trx) => {
        const l = await this.resolveLink(trx, dto.kind, dto.target_id);
        let typeCode = 'OTHER'; let base: { name: string; manufacturer?: string | null; model?: string | null; serial_no?: string | null; room?: string | null; department_id?: string | null } = { name: l.name };
        if (l.kind === 'dx_device') {
          const x = await trx.selectFrom('dx_devices').selectAll().where('id', '=', l.id).executeTakeFirstOrThrow();
          const MAP: Record<string, string> = { CT: 'CT', MR: 'MRI', US: 'US', DX: 'XRAY', RF: 'FLUORO', MG: 'MAMMO', DXA: 'DXA' };
          typeCode = x.section === 'endoscopy' ? 'ENDO_TOWER' : MAP[x.modalities[0]] ?? 'OTHER'; base = { name: x.name, room: x.room };
        } else if (l.kind === 'lab_method') {
          const x = await trx.selectFrom('lab_methods').selectAll().where('id', '=', l.id).executeTakeFirstOrThrow();
          typeCode = 'LAB_ANALYZER'; base = { name: x.name, manufacturer: x.manufacturer, serial_no: x.serial_number };
        } else if (l.kind === 'cssd_machine') {
          const x = await trx.selectFrom('cssd_machines as c').innerJoin('stock_locations as sl', 'sl.id', 'c.location_id').selectAll('c').select('sl.department_id').where('c.id', '=', l.id).executeTakeFirstOrThrow();
          typeCode = x.kind === 'washer' ? 'WASHER_DIS' : 'STERILIZER'; base = { name: x.name, manufacturer: x.manufacturer, model: x.model, serial_no: x.serial_no, department_id: x.department_id };
        } else {
          const x = await trx.selectFrom('endo_scopes').selectAll().where('id', '=', l.id).executeTakeFirstOrThrow();
          typeCode = 'ENDOSCOPE'; base = { name: x.name, serial_no: x.serial_number };
        }
        const t = await trx.selectFrom('bme_device_types').select(['id', 'default_criticality', 'default_risk_class']).where('code', '=', typeCode).executeTakeFirst()
          ?? await trx.selectFrom('bme_device_types').select(['id', 'default_criticality', 'default_risk_class']).where('code', '=', 'OTHER').executeTakeFirstOrThrow();
        const dep = dto.department_id ?? base.department_id ?? null;
        if (dep) await this.checkLocation(trx, s, { department_id: dep });
        const inv = await this.nextInv(trx, s);
        const b = await trx.insertInto('bme_devices').values({ inv_no: inv, name: base.name.trim().slice(0, 300), type_id: t.id, manufacturer: base.manufacturer?.trim() || null, model: base.model?.trim() || null,
          serial_no: base.serial_no?.trim().toUpperCase() || null, criticality: t.default_criticality, risk_class: t.default_risk_class, department_id: dep, room: base.room ?? null,
          [LINKS[l.kind]]: l.id, needs_review: true, created_by: u.id }).returning('id').executeTakeFirstOrThrow();
        await trx.insertInto('bme_status_periods').values({ device_id: b.id, status: 'operational', started_by: u.id }).execute();
        await this.event(trx, b.id, 'created', { inv_no: inv, link: l.kind, link_name: l.name }, u);
        if (s.pm_auto_plans !== false) await ensurePlans(trx, b.id, u.id, 'backfill');
        await this.audit.log(ctx, { action: 'CREATE_BME_DEVICE', entityName: 'bme_devices', entityId: b.id, newData: { from_link: l, inv_no: inv } }, trx);
        return b.id;
      });
      return this.get(id, u);
    } catch (e) { mapPgError(e, BmeService.PG); }
  }

  // ---------------------------------------------------------------- დოკუმენტები
  private documents(deviceId: string) {
    return this.db.selectFrom('bme_documents as f').innerJoin('users as u', 'u.id', 'f.uploaded_by')
      .select(['f.id', 'f.kind', 'f.title', 'f.valid_until', 'f.mime_type', 'f.size_bytes', 'f.original_name', 'f.created_at', userName('u').as('uploaded_by_name'),
        sql<boolean>`f.valid_until IS NOT NULL AND f.valid_until < (now() AT TIME ZONE ${tz})::date`.as('expired')])
      .where('f.device_id', '=', deviceId).where('f.is_active', '=', true).orderBy('f.created_at', 'desc').execute();
  }
  async upload(id: string, files: Express.Multer.File[], dto: { kind?: string; title?: string; valid_until?: string }, u: AuthUser, ctx: AuditContext) {
    this.full(u);
    await this.settings();
    if (!files.length) throw new BadRequestException('ფაილი არ არის (ველი "files")');
    if (!dto.kind || !(DOC_KINDS as readonly string[]).includes(dto.kind)) throw new BadRequestException('დოკუმენტის სახეობა');
    if (dto.valid_until && !/^\d{4}-\d{2}-\d{2}$/.test(dto.valid_until)) throw new BadRequestException('ვადა — YYYY-MM-DD');
    const title = (dto.title ?? '').trim();
    if (title && (title.length < 2 || title.length > 200)) throw new BadRequestException('დასახელება — 2–200 სიმბოლო');
    const out: string[] = [];
    await this.db.transaction().execute(async (trx) => {
      const d = await trx.selectFrom('bme_devices').select('id').where('id', '=', id).executeTakeFirst();
      if (!d) throw new NotFoundException('აპარატი ვერ მოიძებნა');
      for (const f of files) {
        const mime = sniffMime(f.buffer);
        if (!mime) throw new BadRequestException({ code: 'FILE_TYPE', message: `${f.originalname}: დაშვებულია მხოლოდ PDF, JPG ან PNG` });
        const fid = randomUUID(); const ext = mime === 'application/pdf' ? 'pdf' : mime === 'image/png' ? 'png' : 'jpg';
        const key = `bme/${id}/${fid}.${ext}`;
        await this.storage.put(key, f.buffer, mime);
        const name = Buffer.from(f.originalname ?? '', 'latin1').toString('utf8').slice(0, 200) || null;
        await trx.insertInto('bme_documents').values({ id: fid, device_id: id, kind: dto.kind!, title: title || name?.replace(/\.[a-z0-9]{2,4}$/i, '') || dto.kind!, valid_until: dto.valid_until || null,
          file_path: key, mime_type: mime, size_bytes: f.buffer.length, sha256: createHash('sha256').update(f.buffer).digest('hex'), original_name: name, uploaded_by: u.id }).execute();
        out.push(fid);
      }
      await this.event(trx, id, 'document', { kind: dto.kind, title: title || null, count: out.length }, u);
      await this.audit.log(ctx, { action: 'BME_DOC_UPLOAD', entityName: 'bme_devices', entityId: id, newData: { kind: dto.kind, files: out, valid_until: dto.valid_until ?? null } }, trx);
    });
    return { files: out, documents: await this.documents(id) };
  }
  async file(id: string, fid: string, u: AuthUser) {
    await this.settings();
    const d = await this.db.selectFrom('bme_devices').select(['department_id']).where('id', '=', id).executeTakeFirst();
    if (!d) throw new NotFoundException('აპარატი ვერ მოიძებნა');
    if (!(await this.canView(u, d))) throw new ForbiddenException('აპარატი თქვენს განყოფილებაზე არ არის');
    const f = await this.db.selectFrom('bme_documents').select(['file_path', 'mime_type', 'original_name']).where('id', '=', fid).where('device_id', '=', id).where('is_active', '=', true).executeTakeFirst();
    if (!f) throw new NotFoundException('ფაილი ვერ მოიძებნა');
    return { stream: await this.storage.get(f.file_path), mime: f.mime_type };
  }
  async removeDoc(id: string, fid: string, reason: string, u: AuthUser, ctx: AuditContext) {
    this.full(u);
    await this.settings();
    await this.db.transaction().execute(async (trx) => {
      const f = await trx.selectFrom('bme_documents').select(['id', 'kind', 'title']).where('id', '=', fid).where('device_id', '=', id).where('is_active', '=', true).forUpdate().executeTakeFirst();
      if (!f) throw new NotFoundException('დოკუმენტი ვერ მოიძებნა');
      await trx.updateTable('bme_documents').set({ is_active: false, removed_by: u.id, removed_at: sql`now()`, remove_reason: reason.trim() }).where('id', '=', fid).execute();
      await this.event(trx, id, 'document_removed', { kind: f.kind, title: f.title, reason: reason.trim() }, u);
      await this.audit.log(ctx, { action: 'BME_DOC_REMOVE', entityName: 'bme_documents', entityId: fid, newData: { reason } }, trx);
    });
    return { documents: await this.documents(id) };
  }

  // ---------------------------------------------------------------- QR / ეტიკეტები
  /** QR / სკანერის კოდიდან საინვენტარო ნომერი: „…/bme?inv=BME-00012“ ან თავად ნომერი */
  invFromCode(code: string) {
    const c = code.trim();
    const m = /[?&]inv=([^&#\s]+)/i.exec(c);
    if (m) { try { return decodeURIComponent(m[1]).toUpperCase(); } catch { return m[1].toUpperCase(); } }
    return /^[A-Za-z0-9\-/._]{2,40}$/.test(c) ? c.toUpperCase() : null;
  }
  async scan(code: string, u: AuthUser) {
    await this.settings();
    const inv = this.invFromCode(code);
    if (!inv) throw new BadRequestException('კოდი ვერ ამოიცნო');
    const d = await this.db.selectFrom('bme_devices').select(['id', 'inv_no', 'department_id']).where('inv_no', '=', inv).executeTakeFirst();
    if (!d) throw new NotFoundException(`აპარატი ${inv} ვერ მოიძებნა`);
    if (!(await this.canView(u, d))) throw new ForbiddenException('აპარატი თქვენს განყოფილებაზე არ არის');
    return { id: d.id, inv_no: d.inv_no };
  }
  async labels(ids: string[], base: string | undefined, u: AuthUser) {
    this.full(u);
    const s = await this.settings();
    const rows = await this.db.selectFrom('bme_devices as b').leftJoin('departments as d', 'd.id', 'b.department_id')
      .select(['b.inv_no', 'b.name', 'b.model', 'b.serial_no', 'b.room', 'd.name as department_name']).where('b.id', 'in', ids).orderBy('b.inv_no').execute();
    if (!rows.length) throw new NotFoundException('აპარატი ვერ მოიძებნა');
    const [W, H] = s.label_size.split('x').map(Number);
    const clinic = await this.db.selectFrom('clinic_settings').select('name').where('id', '=', 1).executeTakeFirst();
    const { doc, done } = newDoc([mm(W), mm(H)], mm(1.5));
    for (const r of rows) {
      doc.addPage();
      const pad = mm(1.5);
      if (s.label_code === 'qr') {
        const side = mm(H - 3);
        const text = base ? `${base.replace(/\/+$/, '')}/bme?inv=${encodeURIComponent(r.inv_no)}` : r.inv_no;
        const png = await bwipjs.toBuffer({ bcid: 'qrcode', text, scale: 4 });
        doc.image(png, pad, pad, { width: side, height: side });
        const x = pad + side + mm(1.5); const tw = mm(W) - x - pad;
        doc.font('B').fontSize(H >= 30 ? 10 : 8).text(r.inv_no, x, pad, { width: tw, lineBreak: false });
        doc.font('R').fontSize(H >= 30 ? 7 : 5.5).text(r.name.slice(0, 60), x, pad + mm(H >= 30 ? 5 : 4), { width: tw, height: mm(H / 3) });
        if (r.serial_no) doc.font('R').fontSize(5).text(`SN ${r.serial_no}`.slice(0, 40), x, mm(H) - pad - mm(8), { width: tw, lineBreak: false });
        doc.font('R').fontSize(5).text([r.department_name, r.room].filter(Boolean).join(' · ').slice(0, 50), x, mm(H) - pad - mm(5.5), { width: tw, lineBreak: false });
        if (clinic?.name) doc.font('R').fontSize(4.5).text(`${clinic.name.slice(0, 30)} · ბიომედ`, x, mm(H) - pad - mm(2.6), { width: tw, lineBreak: false });
      } else {
        const tw = mm(W) - 2 * pad;
        doc.font('R').fontSize(5.5).text(`${clinic?.name ?? ''} · ბიომედ`.slice(0, 50), pad, pad, { width: tw, lineBreak: false });
        const png = await bwipjs.toBuffer({ bcid: 'code128', text: r.inv_no, scale: 3, height: 8, includetext: false });
        doc.image(png, pad, pad + mm(3), { width: tw, height: mm(H * 0.45) });
        doc.font('B').fontSize(7).text(r.inv_no, pad, pad + mm(3) + mm(H * 0.45) + mm(0.5), { width: tw, align: 'center', lineBreak: false });
        doc.font('R').fontSize(5).text(r.name.slice(0, 50), pad, mm(H) - pad - mm(2.5), { width: tw, align: 'center', lineBreak: false });
      }
    }
    doc.end();
    return done;
  }

  // ---------------------------------------------------------------- შემაჯამებელი
  async summary(u: AuthUser) {
    if (!has(u, ...BME_VIEW_ALL)) throw new ForbiddenException('შემაჯამებელი — ბიომედ-აპარატურის რეესტრის ნახვის უფლება');
    await this.settings();
    const [byStatus, byType, byDept, flags] = await Promise.all([
      this.db.selectFrom('bme_devices').select(['status', sql<number>`count(*)::int`.as('n')]).groupBy('status').execute(),
      this.db.selectFrom('bme_devices as b').innerJoin('bme_device_types as t', 't.id', 'b.type_id')
        .select(['t.name as type_name', 't.grp', sql<number>`count(*)::int`.as('total'), sql<number>`count(*) FILTER (WHERE b.status IN ('down', 'restricted'))::int`.as('unavailable')])
        .where('b.status', '<>', 'retired').groupBy(['t.name', 't.grp', 't.sort_order']).orderBy('t.sort_order').execute(),
      this.db.selectFrom('bme_devices as b').leftJoin('departments as d', 'd.id', 'b.department_id')
        .select(['d.name as department_name', sql<number>`count(*)::int`.as('total'), sql<number>`count(*) FILTER (WHERE b.status = 'down')::int`.as('down'),
          sql<number>`count(*) FILTER (WHERE b.status = 'restricted')::int`.as('restricted'), sql<number>`count(*) FILTER (WHERE b.criticality = 'life_support')::int`.as('life_support'),
          sql<string>`coalesce(sum(b.purchase_value), 0)`.as('value')])
        .where('b.status', '<>', 'retired').groupBy('d.name').orderBy('d.name').execute(),
      this.db.selectFrom('bme_devices').select([
        sql<number>`count(*) FILTER (WHERE needs_review)::int`.as('needs_review'),
        sql<number>`count(*) FILTER (WHERE status <> 'retired' AND warranty_until BETWEEN (now() AT TIME ZONE ${tz})::date AND (now() AT TIME ZONE ${tz})::date + 60)::int`.as('warranty_60'),
        sql<number>`count(*) FILTER (WHERE status <> 'retired' AND department_id IS NULL)::int`.as('no_department'),
        sql<number>`(SELECT count(*)::int FROM bme_documents f WHERE f.is_active AND f.valid_until < (now() AT TIME ZONE ${tz})::date)`.as('expired_docs'),
      ]).executeTakeFirstOrThrow(),
    ]);
    return { by_status: byStatus, by_type: byType, by_department: byDept, ...flags };
  }

  // ---------------------------------------------------------------- იმპორტი (არსებული აპარატურა)
  static readonly COLS = ['საინვენტარო №', 'დასახელება', 'ტიპი (კოდი)', 'მწარმოებელი', 'მოდელი', 'სერიული №', 'განყოფილება (კოდი)', 'ოთახი', 'კრიტიკულობა', 'რისკის კლასი',
    'გამოშვების წელი', 'ექსპლ. შეყვანა', 'შეძენის თარიღი', 'ღირებულება', 'გარანტია (მდე)', 'შენიშვნა'];
  template() {
    return writeXlsx('აპარატურა', [BmeService.COLS, ['ცარიელი — ავტომატური', 'მონიტორი Mindray iMEC10', 'PATIENT_MONITOR', 'Mindray', 'iMEC10', 'AB12345', 'ICU', '3',
      'ცარიელი — ტიპით (life_support / high / medium / low)', 'IIb', '2021', '2022-03-01', '2022-02-15', '4500', '2025-02-15', '']], [16, 30, 18, 16, 16, 16, 18, 10, 18, 12, 12, 14, 14, 12, 14, 24]);
  }
  async import(buf: Buffer, name: string, commit: boolean, u: AuthUser, ctx: AuditContext) {
    this.full(u);
    const s = await this.settings();
    const table = /\.xlsx$/i.test(name) ? readXlsx(buf) : readCsv(buf.toString('utf8'));
    const [head, ...data] = table;
    if (!head || BmeService.COLS.some((c, i) => (head[i] ?? '').trim() !== c)) throw new BadRequestException('სათაურები შაბლონს არ ემთხვევა (ჩამოტვირთეთ შაბლონი)');
    const report: { row: number; status: 'create' | 'skip' | 'error'; inv_no: string; name: string; message?: string }[] = [];
    let created = 0;
    try {
      await this.db.transaction().execute(async (trx) => {
        const types = await trx.selectFrom('bme_device_types').select(['id', 'code', 'default_criticality', 'default_risk_class']).where('is_active', '=', true).execute();
        const deps = await trx.selectFrom('departments').select(['id', 'code']).where('is_active', '=', true).execute();
        const seenSerial = new Set<string>();
        for (const [i, r] of data.entries()) {
          const row = i + 2; const v = (k: number) => (r[k] ?? '').trim();
          if (!r.some((c) => (c ?? '').trim())) continue;
          const nm = v(1);
          try {
            if (nm.length < 2) throw new Error('დასახელება სავალდებულოა');
            const t = types.find((x) => x.code === v(2).toUpperCase()); if (!t) throw new Error(`უცნობი ტიპი: ${v(2)}`);
            let dep: string | null = null;
            if (v(6)) { const d = deps.find((x) => x.code.toUpperCase() === v(6).toUpperCase()); if (!d) throw new Error(`უცნობი განყოფილება: ${v(6)}`); dep = d.id; }
            if (s.require_department && !dep) throw new Error('განყოფილება სავალდებულოა (პარამეტრი)');
            const crit = v(8) ? v(8).toLowerCase() : t.default_criticality; if (!(CRITICALITY as readonly string[]).includes(crit)) throw new Error(`უცნობი კრიტიკულობა: ${v(8)}`);
            const risk = v(9) ? (RISK_CLASSES as readonly string[]).find((x) => x.toLowerCase() === v(9).toLowerCase()) : t.default_risk_class;
            if (v(9) && !risk) throw new Error(`უცნობი რისკის კლასი: ${v(9)}`);
            const year = v(10) ? Number(v(10)) : null; if (year !== null && !(Number.isInteger(year) && year >= 1950 && year <= 2100)) throw new Error('გამოშვების წელი — 1950–2100');
            for (const k of [11, 12, 14]) if (v(k) && !/^\d{4}-\d{2}-\d{2}$/.test(v(k))) throw new Error('თარიღი — YYYY-MM-DD');
            const value = v(13) ? Number(v(13).replace(',', '.')) : null; if (value !== null && !(value >= 0)) throw new Error('ღირებულება — რიცხვი');
            const serial = v(5).toUpperCase() || null;
            if (serial) {
              const key = `${v(3).toLowerCase()}|${serial}`;
              if (seenSerial.has(key) || await trx.selectFrom('bme_devices').select('id').where(sql`lower(coalesce(manufacturer, ''))`, '=', v(3).toLowerCase()).where(sql`upper(serial_no)`, '=', serial).executeTakeFirst())
                { report.push({ row, status: 'skip', inv_no: v(0), name: nm, message: `სერიული ${serial} უკვე რეესტრშია` }); continue; }
              seenSerial.add(key);
            }
            const inv = v(0).toUpperCase();
            if (inv && await trx.selectFrom('bme_devices').select('id').where('inv_no', '=', inv).executeTakeFirst()) { report.push({ row, status: 'skip', inv_no: inv, name: nm, message: 'ნომერი უკვე რეესტრშია' }); continue; }
            const no = inv || await this.nextInv(trx, s);
            const b = await trx.insertInto('bme_devices').values({ inv_no: no, name: nm, type_id: t.id, manufacturer: v(3) || null, model: v(4) || null, serial_no: serial, department_id: dep, room: v(7) || null,
              criticality: crit, risk_class: risk ?? null, manufacture_year: year, install_date: v(11) || null, purchase_date: v(12) || null, purchase_value: value !== null ? String(value) : null,
              warranty_until: v(14) || null, notes: v(15) || null, created_by: u.id }).returning('id').executeTakeFirstOrThrow();
            await trx.insertInto('bme_status_periods').values({ device_id: b.id, status: 'operational', started_by: u.id }).execute();
            await this.event(trx, b.id, 'created', { inv_no: no, import: name }, u);
            if (s.pm_auto_plans !== false) await ensurePlans(trx, b.id, u.id, 'backfill');
            created++; report.push({ row, status: 'create', inv_no: no, name: nm });
          } catch (e) { report.push({ row, status: 'error', inv_no: v(0), name: nm, message: (e as Error).message }); }
        }
        if (report.some((r) => r.status === 'error') && commit) throw new BadRequestException({ message: 'იმპორტი შეჩერდა — გაასწორეთ შეცდომები (შემოწმება)', report });
        if (commit) await this.audit.log(ctx, { action: 'IMPORT_BME_DEVICES', entityName: 'bme_devices', entityId: '-', newData: { file: name, created } }, trx);
        if (!commit) throw new DryRun();
      });
    } catch (e) { if (!(e instanceof DryRun)) throw e; }
    return { commit, created, skipped: report.filter((r) => r.status === 'skip').length, errors: report.filter((r) => r.status === 'error').length, report };
  }

  alerts(area: Area) { return this.guard.alerts(area); }
}

// ======================================================================= DTO
const INV = /^[A-Za-z0-9\-/._]{2,40}$/;
class DeviceDto {
  @IsOptional() @IsString() @Matches(INV) inv_no?: string | null;
  @IsOptional() @IsString() @Length(2, 200) name?: string; @IsOptional() @IsUUID() type_id?: string;
  @IsOptional() @IsString() @MaxLength(120) manufacturer?: string | null; @IsOptional() @IsString() @MaxLength(120) model?: string | null; @IsOptional() @IsString() @MaxLength(120) serial_no?: string | null;
  @IsOptional() @IsString() @MaxLength(20) gmdn_code?: string | null; @IsOptional() @IsIn([...RISK_CLASSES, null]) risk_class?: string | null; @IsOptional() @IsIn(CRITICALITY) criticality?: string;
  @IsOptional() @IsUUID() department_id?: string | null; @IsOptional() @IsString() @MaxLength(60) room?: string | null; @IsOptional() @IsUUID() or_room_id?: string | null;
  @IsOptional() @IsUUID() responsible_user_id?: string | null;
  @IsOptional() @IsIn(STATUSES) status?: BmeStatus; @IsOptional() @IsString() @MaxLength(500) status_reason?: string | null;
  @IsOptional() @IsInt() @Min(1950) @Max(2100) manufacture_year?: number | null; @IsOptional() @IsISO8601({ strict: true }) install_date?: string | null;
  @IsOptional() @IsISO8601({ strict: true }) purchase_date?: string | null; @IsOptional() @IsNumber() @Min(0) @Max(1_000_000_000) purchase_value?: number | null;
  @IsOptional() @IsUUID() supplier_id?: string | null; @IsOptional() @IsISO8601({ strict: true }) warranty_until?: string | null; @IsOptional() @IsUUID() asset_id?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string | null;
  @IsOptional() @IsIn([...Object.keys(LINKS), null]) link_kind?: LinkKind | null; @IsOptional() @IsUUID() link_id?: string | null;
}
class StatusDto { @IsIn(STATUSES) status: BmeStatus; @IsOptional() @IsString() @MaxLength(500) reason?: string | null }
class MoveDto { @IsUUID() to_department_id: string; @IsOptional() @IsString() @MaxLength(60) to_room?: string | null; @IsOptional() @IsUUID() to_or_room_id?: string | null;
  @IsOptional() @IsUUID() to_responsible_id?: string | null; @IsOptional() @IsString() @MaxLength(500) reason?: string | null }
class DecideDto { @IsBoolean() accept: boolean; @IsOptional() @IsString() @MaxLength(500) note?: string }
class LinkDto { @IsIn(Object.keys(LINKS)) kind: LinkKind; @IsUUID() target_id: string }
class FromLinkDto extends LinkDto { @IsOptional() @IsUUID() department_id?: string | null }
class ReasonDto { @IsString() @Length(3, 500) reason: string }
class TypeDto {
  @IsOptional() @IsString() @Matches(/^[A-Z][A-Z0-9_]{1,29}$/) code?: string; @IsOptional() @IsString() @Length(2, 200) name?: string; @IsOptional() @IsIn(GROUPS) grp?: string;
  @IsOptional() @IsIn(CRITICALITY) default_criticality?: string; @IsOptional() @IsIn([...RISK_CLASSES, null]) default_risk_class?: string | null;
  @IsOptional() @IsInt() @Min(1) @Max(120) pm_months?: number | null; @IsOptional() @IsInt() @Min(1) @Max(120) calibration_months?: number | null; @IsOptional() @IsInt() @Min(1) @Max(120) safety_months?: number | null;
  @IsOptional() @IsBoolean() is_active?: boolean; @IsOptional() @IsInt() sort_order?: number;
}
interface ListQ { search?: string; department_id?: string; type_id?: string; grp?: string; status?: string; criticality?: string; needs_review?: string; link?: string; or_room_id?: string }
const uuidOk = (v?: string) => !v || /^[0-9a-f-]{36}$/i.test(v);
const upload = FilesInterceptor('files', 5, { storage: memoryStorage(), limits: { fileSize: MAX_FILE, files: 5 } });

/** ბიომედ-აპარატურა (0073). ნახვა — ყველა შესულს (ხედვის არე სერვისში), მართვა — med_engineer */
@Controller('bme')
export class BmeController {
  constructor(private readonly s: BmeService) {}
  @Get('refs') refs() { return this.s.refs(); }
  @Get('people') people(@Query('search') search?: string) { return this.s.people(search); }
  @Get('alerts') alerts(@Query('area') area: string) {
    if (!(AREAS as readonly string[]).includes(area)) throw new BadRequestException(`area: ${AREAS.join(' / ')}`);
    return this.s.alerts(area as Area);
  }
  @Get('scan') scan(@Query('code') code: string | undefined, @CurrentUser() u: AuthUser) { if (!code) throw new BadRequestException('code'); return this.s.scan(code, u); }
  @Post('types') @Roles(...BME_FULL) type(@Body() d: TypeDto, @Req() r: Request) {
    if (!d.code || !d.name) throw new BadRequestException('კოდი და დასახელება სავალდებულოა');
    return this.s.saveType(null, d, auditCtx(r));
  }
  @Patch('types/:id') @Roles(...BME_FULL) typeU(@Param('id', ParseUUIDPipe) id: string, @Body() d: TypeDto, @Req() r: Request) {
    if (d.code !== undefined) throw new BadRequestException('კოდი არ იცვლება');
    return this.s.saveType(id, d, auditCtx(r));
  }
  @Get('summary') summary(@CurrentUser() u: AuthUser) { return this.s.summary(u); }
  @Get('unlinked') @Roles(...BME_FULL) unlinked(@CurrentUser() u: AuthUser) { return this.s.unlinked(u); }
  @Post('devices/from-link') @Roles(...BME_FULL) fromLink(@Body() d: FromLinkDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.fromLink(d, u, auditCtx(r)); }
  @Get('moves') moves(@CurrentUser() u: AuthUser, @Query('scope') scope?: string, @Query('device_id') deviceId?: string) {
    if (!uuidOk(deviceId)) throw new BadRequestException('არასწორი id');
    return this.s.moves(u, { scope, device_id: deviceId });
  }
  @Post('moves/:id/decide') @HttpCode(200) decide(@Param('id', ParseUUIDPipe) id: string, @Body() d: DecideDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.decideMove(id, d.accept, d.note, u, auditCtx(r)); }
  @Post('moves/:id/cancel') @HttpCode(200) @Roles(...BME_FULL) cancel(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.cancelMove(id, u, auditCtx(r)); }
  @Get('labels') async labels(@Query('ids') ids: string, @Query('base') base: string | undefined, @CurrentUser() u: AuthUser, @Res() res: Response) {
    const list = (ids ?? '').split(',').filter(Boolean);
    if (!list.length || list.length > 500 || !list.every((x) => uuidOk(x))) throw new BadRequestException('ids — აპარატების id-ები, მძიმით');
    if (base && !/^https?:\/\/[^\s"'<>]{3,200}$/.test(base)) throw new BadRequestException('base — http(s) მისამართი');
    const buf = await this.s.labels(list, base, u);
    res.setHeader('content-type', 'application/pdf'); res.setHeader('content-disposition', 'inline; filename="bme-labels.pdf"'); res.end(buf);
  }
  @Get('import/template') @Roles(...BME_FULL) tpl(@Res() res: Response) {
    res.setHeader('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); res.setHeader('content-disposition', 'attachment; filename="bme-template.xlsx"');
    res.end(this.s.template());
  }
  @Post('import') @Roles(...BME_FULL) @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }))
  import(@UploadedFile() file: Express.Multer.File | undefined, @Query('commit') commit: string | undefined, @CurrentUser() u: AuthUser, @Req() r: Request) {
    if (!file) throw new BadRequestException('ფაილი არ არის');
    return this.s.import(file.buffer, file.originalname, commit === 'true', u, auditCtx(r));
  }
  @Get('devices') list(@CurrentUser() u: AuthUser, @Query() q: ListQ) {
    if (!uuidOk(q.department_id) || !uuidOk(q.type_id) || !uuidOk(q.or_room_id)) throw new BadRequestException('არასწორი id');
    return this.s.list(u, q);
  }
  @Post('devices') @Roles(...BME_FULL) create(@Body() d: DeviceDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.create(d as DeviceIn, u, auditCtx(r)); }
  @Get('devices/:id') one(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser) { return this.s.get(id, u); }
  @Patch('devices/:id') @Roles(...BME_FULL) update(@Param('id', ParseUUIDPipe) id: string, @Body() d: DeviceDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.update(id, d as DeviceIn, u, auditCtx(r)); }
  @Post('devices/:id/status') @HttpCode(200) @Roles(...BME_FULL) status(@Param('id', ParseUUIDPipe) id: string, @Body() d: StatusDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.setStatus(id, d, u, auditCtx(r)); }
  @Post('devices/:id/review') @HttpCode(200) @Roles(...BME_FULL) review(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.review(id, u, auditCtx(r)); }
  @Post('devices/:id/move') @Roles(...BME_FULL) move(@Param('id', ParseUUIDPipe) id: string, @Body() d: MoveDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.move(id, d, u, auditCtx(r)); }
  @Post('devices/:id/link') @HttpCode(200) @Roles(...BME_FULL) link(@Param('id', ParseUUIDPipe) id: string, @Body() d: LinkDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.link(id, d, u, auditCtx(r)); }
  @Post('devices/:id/unlink') @HttpCode(200) @Roles(...BME_FULL) unlink(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.unlink(id, u, auditCtx(r)); }
  @Post('devices/:id/documents') @Roles(...BME_FULL) @UseInterceptors(upload)
  upload(@Param('id', ParseUUIDPipe) id: string, @UploadedFiles() files: Express.Multer.File[] | undefined, @Body() b: { kind?: string; title?: string; valid_until?: string }, @CurrentUser() u: AuthUser, @Req() r: Request) {
    return this.s.upload(id, files ?? [], b ?? {}, u, auditCtx(r));
  }
  @Get('devices/:id/documents/:fid')
  async file(@Param('id', ParseUUIDPipe) id: string, @Param('fid', ParseUUIDPipe) fid: string, @CurrentUser() u: AuthUser, @Res({ passthrough: true }) res: Response) {
    const f = await this.s.file(id, fid, u);
    res.set({ 'Content-Type': f.mime, 'Content-Disposition': 'inline', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    return new StreamableFile(f.stream);
  }
  @Post('devices/:id/documents/:fid/remove') @HttpCode(200) @Roles(...BME_FULL)
  removeDoc(@Param('id', ParseUUIDPipe) id: string, @Param('fid', ParseUUIDPipe) fid: string, @Body() d: ReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) {
    return this.s.removeDoc(id, fid, d.reason, u, auditCtx(r));
  }
}
