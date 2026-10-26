import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, Res,
  UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsISO8601, IsNumber, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
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
import { ModulesService } from '../modules/modules';
import { NotificationsService } from '../notifications/notifications';
import { sniffMime } from '../patient-files/patient-files';
import { StorageService } from '../storage/storage.service';
import { BME_FULL, GROUPS, STATUS_KA, userName, viewScope, type BmeSettings, type BmeStatus, type Ex } from './bme-common';
import { renderAct } from './bme-pm-act';
import {
  AUTO_REASON, METER_UNITS, RESULT_KA, RESULT_RANK, RESULTS, SUGGEST, TZ, autoResult, baseInterval, effInterval, ensurePlans, measureOutcome, nextDue, today, type PmResult,
} from './bme-pm-common';
import { BmeService } from './bme';
import { BmePmJobsService } from './bme-pm-jobs';
import { createRepair, repEvent, devEvent } from './bme-repair-common';

const OPEN = ['planned', 'in_progress'] as const;
const VIEWS = ['overdue', 'week', 'month', 'open', 'undated', 'all', 'done'] as const;
type View = (typeof VIEWS)[number];

/**
 * ბიომედ-აპარატურა, ეტაპი 2 (0074): გეგმიური მომსახურება / კალიბრაცია / ელ. უსაფრთხოება / მეტროლოგია.
 *  ცნობარები (სახეები, ჩეკლისტები), გეგმები აპარატზე, სამუშაოები (დაგეგმვა → შესრულება → შედეგი → აქტი), მოხმარების მთვლელი.
 *  მართვა — სამედიცინო ინჟინერი (med_engineer); ნახვა — რეესტრის ხედვის არით (bme_dept — თავისი განყოფილებ(ებ)ი).
 */
@Injectable()
export class PmService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService, private readonly modules: ModulesService,
    private readonly notifications: NotificationsService, private readonly storage: StorageService, private readonly bme: BmeService) {}

  private settings() { return this.modules.require<BmeSettings>('bme'); }
  private full(u: AuthUser) { if (!has(u, ...BME_FULL)) throw new ForbiddenException('გეგმიური სამუშაოების მართვა — სამედიცინო ინჟინერი'); }
  private event(ex: Ex, deviceId: string, kind: string, data: Record<string, unknown>, u: AuthUser | null) {
    return ex.insertInto('bme_events').values({ device_id: deviceId, kind, data: JSON.stringify(data), user_id: u?.id ?? null }).execute();
  }
  private async deviceVisible(u: AuthUser, deviceId: string) {
    const d = await this.db.selectFrom('bme_devices').select(['id', 'department_id', 'status']).where('id', '=', deviceId).executeTakeFirst();
    if (!d) throw new NotFoundException('აპარატი ვერ მოიძებნა');
    const sc = await viewScope(this.db, u);
    if (!sc.all && !(d.department_id && sc.depts.includes(d.department_id))) throw new ForbiddenException('აპარატი თქვენს განყოფილებაზე არ არის');
    return d;
  }
  private static readonly PG = {
    bme_work_kinds_code_key: 'იგივე კოდი უკვე არსებობს', ux_bme_checklist_active: 'ამ სახეზე და ტიპზე აქტიური ჩეკლისტი უკვე არსებობს — ჯერ გათიშეთ',
    bme_plans_device_id_kind_id_key: 'ამ სახის გეგმა აპარატზე უკვე არსებობს', ux_bme_work_open: 'გეგმაზე ღია სამუშაო უკვე არსებობს',
    bme_checklist_items_check: 'გაზომვას სჭირდება ნორმა ± დასაშვები ან ზღვრები',
  };

  // ---------------------------------------------------------------- ცნობარები
  async refs() {
    await this.settings();
    const [kinds, checklists, items, suppliers, engineers] = await Promise.all([
      this.db.selectFrom('bme_work_kinds as k').selectAll('k')
        .select(sql<number>`(SELECT count(*)::int FROM bme_plans p JOIN bme_devices b ON b.id = p.device_id WHERE p.kind_id = k.id AND p.is_active AND b.status <> 'retired')`.as('plans'))
        .orderBy('k.sort_order').orderBy('k.name').execute(),
      this.db.selectFrom('bme_checklists as c').leftJoin('bme_device_types as t', 't.id', 'c.type_id').selectAll('c').select(['t.name as type_name', 't.code as type_code'])
        .orderBy('c.is_active', 'desc').orderBy('t.name').orderBy('c.name').execute(),
      this.db.selectFrom('bme_checklist_items').selectAll().orderBy('checklist_id').orderBy('sort_order').execute(),
      this.db.selectFrom('stock_suppliers').select(['id', 'name', 'phone', 'contact_person']).where('is_active', '=', true).orderBy('name').limit(1000).execute(),
      sql<{ id: string; name: string }>`SELECT u.id, u.first_name || ' ' || u.last_name AS name FROM users u JOIN user_capabilities c ON c.user_id = u.id
        WHERE u.is_active AND c.capabilities && ARRAY['med_engineer', 'admin']::varchar[] ORDER BY u.last_name`.execute(this.db).then((r) => r.rows),
    ]);
    const byList = new Map<string, typeof items>();
    for (const i of items) byList.set(i.checklist_id, [...(byList.get(i.checklist_id) ?? []), i]);
    return { kinds, checklists: checklists.map((c) => ({ ...c, items: byList.get(c.id) ?? [] })), suppliers, engineers, results: RESULTS, meter_units: METER_UNITS, groups: GROUPS };
  }

  async saveKind(id: string | null, dto: KindDto, ctx: AuditContext) {
    await this.settings();
    if (dto.type_field && dto.default_months) throw new BadRequestException('ინტერვალი — ან ტიპის სვეტიდან, ან ნაგულისხმევი (ორივე არა)');
    const vals = {
      ...(dto.name !== undefined && { name: dto.name.trim() }), ...(dto.short_name !== undefined && { short_name: dto.short_name.trim() }),
      ...(dto.type_field !== undefined && { type_field: dto.type_field }), ...(dto.default_months !== undefined && { default_months: dto.default_months }),
      ...(dto.groups !== undefined && { groups: dto.groups }), ...(dto.standard !== undefined && { standard: dto.standard?.trim() || null }),
      ...(dto.needs_certificate !== undefined && { needs_certificate: dto.needs_certificate }), ...(dto.is_active !== undefined && { is_active: dto.is_active }),
      ...(dto.sort_order !== undefined && { sort_order: dto.sort_order }),
    };
    try {
      const r = id ? await this.db.updateTable('bme_work_kinds').set({ ...vals, updated_at: sql`now()` }).where('id', '=', id).returningAll().executeTakeFirst()
        : await this.db.insertInto('bme_work_kinds').values({ code: dto.code!, name: dto.name!.trim(), short_name: (dto.short_name ?? dto.name!).trim().slice(0, 30), ...vals }).returningAll().executeTakeFirst();
      if (!r) throw new NotFoundException('სახე ვერ მოიძებნა');
      await this.audit.log(ctx, { action: id ? 'UPDATE_BME_KIND' : 'CREATE_BME_KIND', entityName: 'bme_work_kinds', entityId: r.id, newData: dto });
      return r;
    } catch (e) { mapPgError(e, PmService.PG); }
  }

  private checkItems(items: ItemDto[]) {
    for (const [n, i] of items.entries()) {
      if (i.item_type === 'check') continue;
      const tol = i.tolerance !== undefined && i.tolerance !== null;
      if (tol && (i.nominal === undefined || i.nominal === null)) throw new BadRequestException(`პუნქტი ${n + 1}: დასაშვებს სჭირდება ნორმა`);
      if (!tol && (i.limit_low ?? null) === null && (i.limit_high ?? null) === null) throw new BadRequestException(`პუნქტი ${n + 1}: გაზომვას სჭირდება ნორმა ± დასაშვები ან ზღვრები`);
      if ((i.limit_low ?? null) !== null && (i.limit_high ?? null) !== null && i.limit_low! > i.limit_high!) throw new BadRequestException(`პუნქტი ${n + 1}: ქვედა ზღვარი ზედაზე მეტია`);
    }
  }
  async saveChecklist(id: string | null, dto: ChecklistDto, ctx: AuditContext) {
    await this.settings();
    if (dto.items) this.checkItems(dto.items);
    try {
      const cid = await this.db.transaction().execute(async (trx) => {
        let cid = id;
        if (id) {
          const old = await trx.selectFrom('bme_checklists').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
          if (!old) throw new NotFoundException('ჩეკლისტი ვერ მოიძებნა');
          await trx.updateTable('bme_checklists').set({ ...(dto.name !== undefined && { name: dto.name.trim() }), ...(dto.is_active !== undefined && { is_active: dto.is_active }),
            ...(dto.items && { version: old.version + 1 }), updated_at: sql`now()` }).where('id', '=', id).execute();
        } else {
          if (!dto.kind_id || !dto.name || !dto.items?.length) throw new BadRequestException('სახე, დასახელება და მინიმუმ ერთი პუნქტი სავალდებულოა');
          cid = (await trx.insertInto('bme_checklists').values({ kind_id: dto.kind_id, type_id: dto.type_id ?? null, name: dto.name.trim() }).returning('id').executeTakeFirstOrThrow()).id;
        }
        if (dto.items) {
          if (!dto.items.length) throw new BadRequestException('მინიმუმ ერთი პუნქტი');
          await trx.deleteFrom('bme_checklist_items').where('checklist_id', '=', cid!).execute();
          await trx.insertInto('bme_checklist_items').values(dto.items.map((i, n) => ({
            checklist_id: cid!, sort_order: (n + 1) * 10, text: i.text.trim(), item_type: i.item_type, unit: i.unit?.trim() || null,
            nominal: i.item_type === 'measure' && i.nominal != null ? String(i.nominal) : null, tolerance: i.item_type === 'measure' && i.tolerance != null ? String(i.tolerance) : null,
            limit_low: i.item_type === 'measure' && i.limit_low != null && i.tolerance == null ? String(i.limit_low) : null,
            limit_high: i.item_type === 'measure' && i.limit_high != null && i.tolerance == null ? String(i.limit_high) : null,
            critical: i.critical ?? true, required: i.required ?? true }))).execute();
        }
        await this.audit.log(ctx, { action: id ? 'UPDATE_BME_CHECKLIST' : 'CREATE_BME_CHECKLIST', entityName: 'bme_checklists', entityId: cid!, newData: dto }, trx);
        return cid!;
      });
      return (await this.refs()).checklists.find((c) => c.id === cid);
    } catch (e) { mapPgError(e, PmService.PG); }
  }

  // ---------------------------------------------------------------- გეგმები (აპარატი)
  private plansQ(ex: Ex = this.db) {
    return ex.selectFrom('bme_plans as p').innerJoin('bme_work_kinds as k', 'k.id', 'p.kind_id').innerJoin('bme_devices as b', 'b.id', 'p.device_id')
      .innerJoin('bme_device_types as t', 't.id', 'b.type_id')
      .leftJoin('bme_works as w', (j) => j.onRef('w.plan_id', '=', 'p.id').on('w.status', 'in', [...OPEN]))
      .leftJoin('users as wa', 'wa.id', 'w.assignee_id').leftJoin('stock_suppliers as ws', 'ws.id', 'w.supplier_id')
      .select(['p.id', 'p.device_id', 'p.kind_id', 'p.interval_months', 'p.next_due', 'p.last_done_on', 'p.last_result', 'p.last_work_id', 'p.is_active', 'p.source', 'p.notes',
        'k.code as kind_code', 'k.name as kind_name', 'k.short_name as kind_short', 'k.needs_certificate',
        baseInterval.as('type_interval'), effInterval.as('interval'),
        sql<number | null>`(p.next_due - ${today()})::int`.as('days_left'),
        'w.id as work_id', 'w.work_no', 'w.status as work_status', 'w.scheduled_date', 'w.performer_kind', userName('wa').as('assignee_name'), 'ws.name as supplier_name', 'w.external_person']);
  }

  async devicePm(id: string, u: AuthUser) {
    await this.settings();
    await this.deviceVisible(u, id);
    const [plans, works, meters] = await Promise.all([
      this.plansQ().where('p.device_id', '=', id).orderBy('k.sort_order').execute(),
      this.worksQ().where('w.device_id', '=', id).orderBy('w.created_at', 'desc').limit(200).execute(),
      this.db.selectFrom('bme_meter_readings as m').innerJoin('users as u', 'u.id', 'm.user_id').select(['m.id', 'm.unit', 'm.value', 'm.read_on', 'm.note', 'm.created_at', userName('u').as('user_name')])
        .where('m.device_id', '=', id).orderBy('m.read_on', 'desc').orderBy('m.id', 'desc').limit(100).execute(),
    ]);
    return { plans, works, meters };
  }

  async addPlan(deviceId: string, dto: PlanDto, u: AuthUser, ctx: AuditContext) {
    this.full(u);
    await this.settings();
    if (!dto.kind_id) throw new BadRequestException('სახე სავალდებულოა');
    try {
      await this.db.transaction().execute(async (trx) => {
        const d = await trx.selectFrom('bme_devices').select(['status']).where('id', '=', deviceId).executeTakeFirst();
        if (!d) throw new NotFoundException('აპარატი ვერ მოიძებნა');
        if (d.status === 'retired') throw new ConflictException('გამოყვანილ აპარატს გეგმა არ ემატება');
        const k = await trx.selectFrom('bme_work_kinds as k').innerJoin('bme_devices as b', (j) => j.on('b.id', '=', deviceId)).innerJoin('bme_device_types as t', 't.id', 'b.type_id')
          .select(['k.is_active', baseInterval.as('iv')]).where('k.id', '=', dto.kind_id!).executeTakeFirst();
        if (!k?.is_active) throw new BadRequestException('სახე ვერ მოიძებნა ან გათიშულია');
        if (!dto.interval_months && !k.iv) throw new BadRequestException('ამ ტიპზე სახის ინტერვალი არ არის — მიუთითეთ თვეები');
        const p = await trx.insertInto('bme_plans').values({ device_id: deviceId, kind_id: dto.kind_id!, interval_months: dto.interval_months ?? null, next_due: dto.next_due ?? null,
          notes: dto.notes?.trim() || null, source: 'manual', created_by: u.id }).returning('id').executeTakeFirstOrThrow();
        await this.event(trx, deviceId, 'plan', { action: 'added', plan_id: p.id, kind_id: dto.kind_id, interval_months: dto.interval_months ?? null, next_due: dto.next_due ?? null }, u);
        await this.audit.log(ctx, { action: 'CREATE_BME_PLAN', entityName: 'bme_plans', entityId: p.id, newData: { device_id: deviceId, ...dto } }, trx);
      });
    } catch (e) { mapPgError(e, PmService.PG); }
    return this.devicePm(deviceId, u);
  }

  /** გეგმის რედაქტირება: ინტერვალის გადაფარვა (null — ტიპიდან), ვადა, ბოლო შესრულება (ისტორია — ვადა ხელახლა ითვლება), გათიშვა */
  async updatePlan(id: string, dto: PlanDto, u: AuthUser, ctx: AuditContext) {
    this.full(u);
    const s = await this.settings();
    let deviceId = '';
    await this.db.transaction().execute(async (trx) => {
      const p = await this.plansQ(trx).where('p.id', '=', id).executeTakeFirst();
      if (!p) throw new NotFoundException('გეგმა ვერ მოიძებნა');
      deviceId = p.device_id;
      const set: Record<string, unknown> = {};
      if (dto.interval_months !== undefined) set.interval_months = dto.interval_months;
      if (dto.notes !== undefined) set.notes = dto.notes?.trim() || null;
      if (dto.is_active !== undefined) {
        if (!dto.is_active && p.work_id) throw new ConflictException('გეგმაზე ღია სამუშაოა — ჯერ დაასრულეთ ან გააუქმეთ');
        set.is_active = dto.is_active;
      }
      if (dto.last_done_on !== undefined) {
        if (dto.last_done_on && dto.last_done_on > (await this.todayStr(trx))) throw new BadRequestException('ბოლო შესრულება მომავალში ვერ იქნება');
        set.last_done_on = dto.last_done_on;
        if (dto.last_done_on && dto.next_due === undefined) {
          const iv = (dto.interval_months !== undefined ? dto.interval_months : p.interval_months) ?? p.type_interval;
          set.next_due = await nextDue(trx, { ...s, pm_due_basis: 'last_done', pm_cert_sets_due: false }, { interval: iv, prevDue: null, performedOn: dto.last_done_on });
        }
      }
      if (dto.next_due !== undefined) set.next_due = dto.next_due;
      if (set.interval_months === null && !p.type_interval) throw new BadRequestException('ამ ტიპზე სახის ინტერვალი არ არის — გადაფარვა საჭიროა');
      if (!Object.keys(set).length) return;
      await trx.updateTable('bme_plans').set({ ...set, updated_at: sql`now()` }).where('id', '=', id).execute();
      // ღია სამუშაოს ვადაც მიჰყვება
      if (set.next_due !== undefined && p.work_id) await trx.updateTable('bme_works').set({ due_date: set.next_due as string | null, updated_at: sql`now()` }).where('id', '=', p.work_id).execute();
      await this.event(trx, p.device_id, 'plan', { action: 'updated', plan_id: id, kind: p.kind_short, ...set }, u);
      await this.audit.log(ctx, { action: 'UPDATE_BME_PLAN', entityName: 'bme_plans', entityId: id, oldData: { interval_months: p.interval_months, next_due: p.next_due, last_done_on: p.last_done_on, is_active: p.is_active }, newData: set }, trx);
    });
    return this.devicePm(deviceId, u);
  }

  /** ტიპების ინტერვალების / სახეების ცვლილების შემდეგ: ყველა აპარატს აკლია გეგმები → იქმნება */
  async sync(u: AuthUser, ctx: AuditContext) {
    this.full(u);
    await this.settings();
    const created = await ensurePlans(this.db, null, u.id, 'backfill');
    await this.audit.log(ctx, { action: 'SYNC_BME_PLANS', entityName: 'bme_plans', entityId: '-', newData: { created } });
    return { created };
  }

  private async todayStr(ex: Ex) { return (await sql<{ d: string }>`SELECT to_char(${today()}, 'YYYY-MM-DD') AS d`.execute(ex)).rows[0].d; }

  // ---------------------------------------------------------------- სამუშაოები: სია („სამუშაოები“)
  private worksQ(ex: Ex = this.db) {
    return ex.selectFrom('bme_works as w').innerJoin('bme_devices as b', 'b.id', 'w.device_id').innerJoin('bme_work_kinds as k', 'k.id', 'w.kind_id')
      .leftJoin('departments as d', 'd.id', 'b.department_id').leftJoin('users as wa', 'wa.id', 'w.assignee_id').leftJoin('stock_suppliers as ws', 'ws.id', 'w.supplier_id')
      .leftJoin('users as wc', 'wc.id', 'w.completed_by')
      .select(['w.id', 'w.work_no', 'w.device_id', 'w.plan_id', 'w.kind_id', 'w.checklist_id', 'w.status', 'w.due_date', 'w.scheduled_date', 'w.performer_kind', 'w.assignee_id', 'w.supplier_id',
        'w.external_person', 'w.started_at', 'w.performed_on', 'w.result', 'w.result_note', 'w.suggested_status', 'w.status_applied', 'w.cert_no', 'w.cert_valid_until', 'w.next_due',
        'w.completed_at', 'w.cancel_reason', 'w.created_at',
        'b.inv_no', 'b.name as device_name', 'b.status as device_status', 'b.department_id', 'd.name as department_name', 'b.room',
        'k.code as kind_code', 'k.name as kind_name', 'k.short_name as kind_short', 'k.needs_certificate',
        userName('wa').as('assignee_name'), 'ws.name as supplier_name', userName('wc').as('completed_by_name')]);
  }

  /**
   * „სამუშაოები“: გეგმები (ვადით / ვადის გარეშე) + მათი ღია სამუშაოები + გეგმის გარეშე ღია სამუშაოები.
   *  view: overdue — ვადაგადაცილებული; week / month — 7 / 31 დღეში (ვადაგადაცილებულიც); open — ღია სამუშაოები; undated — პირველი ვადა დასადგენი; all; done — შესრულებული (90 დღე)
   */
  async board(u: AuthUser, q: BoardQ) {
    await this.settings();
    const view: View = (VIEWS as readonly string[]).includes(q.view ?? '') ? q.view as View : 'month';
    const sc = await viewScope(this.db, u);
    if (!sc.all && !sc.depts.length) return [];
    if (view === 'done') {
      let x = this.worksQ().where('w.status', '=', 'done').where('w.completed_at', '>', sql<Date>`now() - interval '90 days'`).orderBy('w.completed_at', 'desc').limit(1000);
      if (!sc.all) x = x.where('b.department_id', 'in', sc.depts);
      if (q.department_id) x = x.where('b.department_id', '=', q.department_id);
      if (q.kind_id) x = x.where('w.kind_id', '=', q.kind_id);
      if (q.result && (RESULTS as readonly string[]).includes(q.result)) x = x.where('w.result', '=', q.result);
      return (await x.execute()).map((w) => ({ row: 'work' as const, ...w, days_left: null }));
    }
    let p = this.plansQ().innerJoin('bme_device_types as t2', 't2.id', 'b.type_id').leftJoin('departments as d', 'd.id', 'b.department_id')
      .select(['b.inv_no', 'b.name as device_name', 'b.status as device_status', 'b.department_id', 'd.name as department_name', 'b.room', 'b.criticality', 't2.grp',
        'w.due_date', 'w.supplier_id', 'w.assignee_id'])
      .where('p.is_active', '=', true).where('b.status', '<>', 'retired').orderBy(sql`p.next_due NULLS LAST`).orderBy('b.inv_no').limit(2000);
    if (!sc.all) p = p.where('b.department_id', 'in', sc.depts);
    if (view === 'overdue') p = p.where('p.next_due', '<', today());
    else if (view === 'week') p = p.where('p.next_due', '<=', sql<string>`${today()} + 7`);
    else if (view === 'month') p = p.where('p.next_due', '<=', sql<string>`${today()} + 31`);
    else if (view === 'undated') p = p.where('p.next_due', 'is', null);
    else if (view === 'open') p = p.where('w.id', 'is not', null);
    if (q.department_id) p = p.where('b.department_id', '=', q.department_id);
    if (q.kind_id) p = p.where('p.kind_id', '=', q.kind_id);
    if (q.grp) p = p.where('t2.grp', '=', q.grp);
    if (q.assignee === 'me') p = p.where('w.assignee_id', '=', u.id);
    else if (q.assignee === 'none') p = p.where((eb) => eb.or([eb('w.id', 'is', null), eb.and([eb('w.assignee_id', 'is', null), eb('w.supplier_id', 'is', null), eb('w.external_person', 'is', null)])]));
    else if (q.assignee && /^[0-9a-f-]{36}$/i.test(q.assignee)) p = p.where('w.assignee_id', '=', q.assignee);
    const s = q.search?.trim();
    if (s) p = p.where((eb) => eb.or([eb(sql`upper(b.inv_no)`, 'like', `%${s.toUpperCase()}%`), eb(sql`lower(b.name)`, 'like', `%${s.toLowerCase()}%`)]));
    const plans = (await p.execute()).map((r) => ({ row: 'plan' as const, ...r }));
    // გეგმის გარეშე ღია სამუშაოები (ერთჯერადი)
    let adhoc: Awaited<ReturnType<typeof this.adhocQ>> = [];
    if (['open', 'all', 'overdue', 'week', 'month'].includes(view) && !q.grp && q.assignee !== 'none') adhoc = await this.adhocQ(sc, q, view, u);
    return [...plans, ...adhoc];
  }
  private async adhocQ(sc: { all: true } | { all: false; depts: string[] }, q: BoardQ, view: View, u: AuthUser) {
    let x = this.worksQ().select(sql<number | null>`(coalesce(w.scheduled_date, w.due_date) - ${today()})::int`.as('days_left')).where('w.plan_id', 'is', null).where('w.status', 'in', [...OPEN]);
    if (!sc.all) x = x.where('b.department_id', 'in', sc.depts);
    if (view === 'overdue') x = x.where(sql<boolean>`coalesce(w.scheduled_date, w.due_date) < ${today()}`);
    else if (view === 'week') x = x.where(sql<boolean>`coalesce(w.scheduled_date, w.due_date, ${today()}) <= ${today()} + 7`);
    else if (view === 'month') x = x.where(sql<boolean>`coalesce(w.scheduled_date, w.due_date, ${today()}) <= ${today()} + 31`);
    if (q.department_id) x = x.where('b.department_id', '=', q.department_id);
    if (q.kind_id) x = x.where('w.kind_id', '=', q.kind_id);
    if (q.assignee === 'me') x = x.where('w.assignee_id', '=', u.id);
    else if (q.assignee && /^[0-9a-f-]{36}$/i.test(q.assignee)) x = x.where('w.assignee_id', '=', q.assignee);
    return (await x.execute()).map((w) => ({ row: 'work' as const, ...w }));
  }

  // ---------------------------------------------------------------- სამუშაო: შექმნა / მინიჭება / ჯგუფური დაგეგმვა
  private async performer(ex: Ex, dto: AssignDto) {
    const kind = dto.performer_kind ?? 'internal';
    if (kind === 'internal') {
      if (dto.assignee_id) {
        const ok = await sql<{ id: string }>`SELECT u.id FROM users u JOIN user_capabilities c ON c.user_id = u.id WHERE u.id = ${dto.assignee_id} AND u.is_active
          AND c.capabilities && ARRAY['med_engineer', 'admin']::varchar[]`.execute(ex);
        if (!ok.rows.length) throw new BadRequestException('შიდა შემსრულებელი — სამედიცინო ინჟინერი (აქტიური)');
      }
      return { performer_kind: 'internal', assignee_id: dto.assignee_id ?? null, supplier_id: null, external_person: null };
    }
    if (!dto.supplier_id && !dto.external_person?.trim()) throw new BadRequestException('გარე შემსრულებელი: მომწოდებელი ან კონტაქტი');
    if (dto.supplier_id && !(await ex.selectFrom('stock_suppliers').select('id').where('id', '=', dto.supplier_id).where('is_active', '=', true).executeTakeFirst())) throw new BadRequestException('მომწოდებელი ვერ მოიძებნა');
    return { performer_kind: 'external', assignee_id: null, supplier_id: dto.supplier_id ?? null, external_person: dto.external_person?.trim() || null };
  }

  private async nextNo(trx: Ex, s: BmeSettings) {
    const yr = Number(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric' }).format(new Date()));
    const prefix = s.pm_work_prefix || 'PM';
    const { last_value } = await trx.insertInto('document_counters').values({ document_type: `bme_work_${prefix}`, year: yr, last_value: 1 })
      .onConflict((oc) => oc.columns(['document_type', 'year']).doUpdateSet({ last_value: sql`document_counters.last_value + 1` })).returning('last_value').executeTakeFirstOrThrow();
    return `${prefix}-${String(yr).slice(2)}-${String(last_value).padStart(5, '0')}`;
  }

  /** ჩეკლისტი: ტიპზე + სახეზე → ზოგადი (სახეზე) */
  private async checklistFor(ex: Ex, kindId: string, deviceId: string) {
    return ex.selectFrom('bme_checklists as c').innerJoin('bme_devices as b', (j) => j.on('b.id', '=', deviceId)).select(['c.id'])
      .where('c.kind_id', '=', kindId).where('c.is_active', '=', true).where((eb) => eb.or([eb('c.type_id', '=', eb.ref('b.type_id')), eb('c.type_id', 'is', null)]))
      .orderBy(sql`c.type_id IS NULL`).limit(1).executeTakeFirst();
  }

  private async createWork(trx: Ex, s: BmeSettings, p: { device_id: string; kind_id: string; plan_id: string | null; due_date: string | null; scheduled_date: string | null; repair_id?: string | null },
    perf: Awaited<ReturnType<PmService['performer']>>, u: AuthUser) {
    const cl = await this.checklistFor(trx, p.kind_id, p.device_id);
    const no = await this.nextNo(trx, s);
    const w = await trx.insertInto('bme_works').values({ work_no: no, device_id: p.device_id, plan_id: p.plan_id, kind_id: p.kind_id, checklist_id: cl?.id ?? null, due_date: p.due_date,
      scheduled_date: p.scheduled_date, repair_id: p.repair_id ?? null, ...perf, created_by: u.id }).returning('id').executeTakeFirstOrThrow();
    if (cl) {
      await sql`INSERT INTO bme_work_items (work_id, sort_order, text, item_type, unit, nominal, tolerance, limit_low, limit_high, critical, required)
        SELECT ${w.id}, sort_order, text, item_type, unit, nominal, tolerance, limit_low, limit_high, critical, required FROM bme_checklist_items WHERE checklist_id = ${cl.id}`.execute(trx);
    }
    await this.event(trx, p.device_id, 'work_planned', { work_id: w.id, work_no: no, kind_id: p.kind_id, scheduled_date: p.scheduled_date }, u);
    return { id: w.id, work_no: no };
  }

  /** 0075: შემოწმება შეკეთების შემდეგ — სამუშაო ორდერის ტრანზაქციაში (repair_id) */
  createWorkInTrx(trx: Ex, s: BmeSettings, p: { device_id: string; kind_id: string; plan_id: null; due_date: string | null; scheduled_date: string | null; repair_id: string },
    perf: { performer_kind: 'internal'; assignee_id: string | null; supplier_id: null; external_person: null }, u: AuthUser) {
    return this.createWork(trx, s, p, perf, u);
  }

  /**
   * 0075: „ვერ გაიარა“ / „პირობითად“ → შეკეთების ორდერი (ტრიაჟი გავლილია, შემსრულებელი — სამუშაოს დამსრულებელი); აღწერაში — ჩავარდნილი პუნქტები.
   * ერთ სამუშაოზე ერთი ორდერი; manual — ღილაკით (შეცდომა, თუ უკვე არსებობს).
   */
  async repairFromWork(trx: Ex, s: BmeSettings, workId: string, u: AuthUser, manual: boolean) {
    const w = await trx.selectFrom('bme_works as w').innerJoin('bme_work_kinds as k', 'k.id', 'w.kind_id').innerJoin('bme_devices as b', 'b.id', 'w.device_id')
      .select(['w.id', 'w.work_no', 'w.status', 'w.result', 'w.result_note', 'w.device_id', 'w.completed_by', 'k.short_name', 'b.status as device_status']).where('w.id', '=', workId).executeTakeFirst();
    if (!w) throw new NotFoundException('სამუშაო ვერ მოიძებნა');
    if (w.status !== 'done' || !w.result || w.result === 'pass') throw new ConflictException('ორდერი — მხოლოდ „ვერ გაიარა“ / „პირობითად“ შედეგზე');
    if (w.device_status === 'retired') throw new ConflictException('აპარატი გამოყვანილია');
    const ex = await trx.selectFrom('bme_repairs').select(['id', 'repair_no']).where('pm_work_id', '=', workId).where('status', 'not in', ['rejected', 'duplicate']).executeTakeFirst();
    if (ex) { if (manual) throw new ConflictException(`სამუშაოზე ორდერი უკვე არსებობს: ${ex.repair_no}`); return ex; }
    const failed = await trx.selectFrom('bme_work_items').select(['text', 'value_num', 'unit', 'critical']).where('work_id', '=', workId).where('outcome', '=', 'fail').orderBy('sort_order').execute();
    const desc = `${w.work_no} (${w.short_name}) — ${RESULT_KA[w.result as PmResult]}${w.result_note ? `: ${w.result_note}` : ''}`
      + (failed.length ? `\nჩავარდნილი: ${failed.map((f) => `${f.text}${f.value_num !== null ? ` = ${Number(f.value_num)}${f.unit ? ` ${f.unit}` : ''}` : ''}${f.critical ? '' : ' (არაკრიტ.)'}`).join('; ')}` : '');
    const r = await createRepair(trx, s, { device_id: w.device_id, source: 'pm_work', pm_work_id: workId, condition: w.result === 'fail' ? 'limited' : 'issue', urgency: w.result === 'fail' ? 'urgent' : 'normal',
      description: desc.slice(0, 2000), triaged: true }, u.id);
    await this.event(trx, w.device_id, 'work_done', { work_id: workId, work_no: w.work_no, repair_id: r.id, repair_no: r.repair_no, kind: w.short_name, result: w.result, repair: true }, u);
    return { id: r.id, repair_no: r.repair_no };
  }

  async create(dto: CreateWorkDto, u: AuthUser, ctx: AuditContext) {
    this.full(u);
    const s = await this.settings();
    let id = ''; let notify: string | null = null; let label = '';
    try {
      await this.db.transaction().execute(async (trx) => {
        let dev = dto.device_id; let kind = dto.kind_id; let due: string | null = null;
        if (dto.plan_id) {
          const p = await trx.selectFrom('bme_plans').selectAll().where('id', '=', dto.plan_id).forUpdate().executeTakeFirst();
          if (!p || !p.is_active) throw new NotFoundException('გეგმა ვერ მოიძებნა ან გათიშულია');
          dev = p.device_id; kind = p.kind_id; due = p.next_due;
        }
        if (!dev || !kind) throw new BadRequestException('აპარატი და სახე (ან გეგმა) სავალდებულოა');
        const d = await trx.selectFrom('bme_devices').select(['status', 'inv_no', 'name']).where('id', '=', dev).executeTakeFirst();
        if (!d) throw new NotFoundException('აპარატი ვერ მოიძებნა');
        if (d.status === 'retired') throw new ConflictException('გამოყვანილ აპარატზე სამუშაო არ იგეგმება');
        if (!(await trx.selectFrom('bme_work_kinds').select('id').where('id', '=', kind).where('is_active', '=', true).executeTakeFirst())) throw new BadRequestException('სახე ვერ მოიძებნა ან გათიშულია');
        // 0075: შემსრულებელი არ არის მითითებული + აქტიური კონტრაქტი ფარავს ამ სახეს → გარე (კონტრაქტის მომწოდებელი)
        let pdto: AssignDto = dto;
        if (dto.performer_kind === undefined && !dto.assignee_id && !dto.supplier_id) {
          const c = await trx.selectFrom('bme_contracts as c').innerJoin('bme_contract_devices as cd', 'cd.contract_id', 'c.id').select(['c.supplier_id'])
            .where('cd.device_id', '=', dev).where('c.status', '=', 'active').where(sql<boolean>`${today()} BETWEEN c.start_date AND c.end_date`).where(sql<boolean>`${kind}::uuid = ANY (c.covers_kinds)`)
            .orderBy('c.end_date', 'desc').limit(1).executeTakeFirst();
          if (c) pdto = { performer_kind: 'external', supplier_id: c.supplier_id };
        }
        const perf = await this.performer(trx, pdto);
        const w = await this.createWork(trx, s, { device_id: dev, kind_id: kind, plan_id: dto.plan_id ?? null, due_date: due, scheduled_date: dto.scheduled_date ?? null }, perf, u);
        id = w.id; notify = perf.assignee_id; label = `${w.work_no} · ${d.inv_no} ${d.name}`;
        await this.audit.log(ctx, { action: 'CREATE_BME_WORK', entityName: 'bme_works', entityId: w.id, newData: dto }, trx);
      });
    } catch (e) { mapPgError(e, PmService.PG); }
    if (notify && notify !== u.id) await this.notifications.notify(notify, { kind: 'bme_work', title: `სამუშაო მოგენიჭათ: ${label}`, link: `/bme?tab=works&work=${id}`, entityId: id });
    return this.get(id, u);
  }

  /** ჯგუფური დაგეგმვა: გეგმებს — ახალი სამუშაო (ან არსებულ ღიას — დღე / შემსრულებელი) */
  async bulk(dto: BulkDto, u: AuthUser, ctx: AuditContext) {
    this.full(u);
    const s = await this.settings();
    let created = 0; let updated = 0; const skipped: string[] = []; const assigned = new Map<string, string[]>();
    await this.db.transaction().execute(async (trx) => {
      const perf = await this.performer(trx, dto);
      const plans = await trx.selectFrom('bme_plans as p').innerJoin('bme_devices as b', 'b.id', 'p.device_id')
        .leftJoin('bme_works as w', (j) => j.onRef('w.plan_id', '=', 'p.id').on('w.status', 'in', [...OPEN]))
        .select(['p.id', 'p.device_id', 'p.kind_id', 'p.next_due', 'p.is_active', 'b.status', 'b.inv_no', 'w.id as work_id', 'w.work_no'])
        .where('p.id', 'in', dto.plan_ids).forUpdate('p').execute();
      for (const pid of dto.plan_ids) {
        const p = plans.find((x) => x.id === pid);
        if (!p || !p.is_active || p.status === 'retired') { skipped.push(p?.inv_no ?? pid); continue; }
        if (p.work_id) {
          await trx.updateTable('bme_works').set({ ...perf, ...(dto.scheduled_date !== undefined && { scheduled_date: dto.scheduled_date }), updated_at: sql`now()` }).where('id', '=', p.work_id).execute();
          updated++;
          if (perf.assignee_id) assigned.set(perf.assignee_id, [...(assigned.get(perf.assignee_id) ?? []), p.work_no!]);
        } else {
          const w = await this.createWork(trx, s, { device_id: p.device_id, kind_id: p.kind_id, plan_id: p.id, due_date: p.next_due, scheduled_date: dto.scheduled_date ?? null }, perf, u);
          created++;
          if (perf.assignee_id) assigned.set(perf.assignee_id, [...(assigned.get(perf.assignee_id) ?? []), w.work_no]);
        }
      }
      await this.audit.log(ctx, { action: 'BULK_BME_WORKS', entityName: 'bme_works', entityId: '-', newData: { ...dto, created, updated, skipped } }, trx);
    });
    for (const [uid, nos] of assigned) if (uid !== u.id) await this.notifications.notify(uid, { kind: 'bme_work', title: `გეგმიური სამუშაოები მოგენიჭათ: ${nos.length}`, body: nos.slice(0, 10).join(', '),
      link: '/bme?tab=works&view=open&assignee=me', entityId: uid, item: nos.join(', ') });
    return { created, updated, skipped };
  }

  async update(id: string, dto: AssignDto & { scheduled_date?: string | null }, u: AuthUser, ctx: AuditContext) {
    this.full(u);
    await this.settings();
    let notify: string | null = null; let label = '';
    await this.db.transaction().execute(async (trx) => {
      const w = await trx.selectFrom('bme_works').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!w) throw new NotFoundException('სამუშაო ვერ მოიძებნა');
      if (!(OPEN as readonly string[]).includes(w.status)) throw new ConflictException('სამუშაო დასრულებული / გაუქმებულია');
      const perf = dto.performer_kind !== undefined || dto.assignee_id !== undefined || dto.supplier_id !== undefined || dto.external_person !== undefined
        ? await this.performer(trx, { performer_kind: dto.performer_kind ?? (w.performer_kind as 'internal' | 'external'), assignee_id: dto.assignee_id !== undefined ? dto.assignee_id : w.assignee_id,
          supplier_id: dto.supplier_id !== undefined ? dto.supplier_id : w.supplier_id, external_person: dto.external_person !== undefined ? dto.external_person : w.external_person }) : {};
      await trx.updateTable('bme_works').set({ ...perf, ...(dto.scheduled_date !== undefined && { scheduled_date: dto.scheduled_date }), updated_at: sql`now()` }).where('id', '=', id).execute();
      const na = (perf as { assignee_id?: string | null }).assignee_id ?? null;
      if (na && na !== w.assignee_id) { notify = na; label = w.work_no; }
      await this.audit.log(ctx, { action: 'UPDATE_BME_WORK', entityName: 'bme_works', entityId: id, oldData: { scheduled_date: w.scheduled_date, assignee_id: w.assignee_id, supplier_id: w.supplier_id }, newData: dto }, trx);
    });
    if (notify && notify !== u.id) await this.notifications.notify(notify, { kind: 'bme_work', title: `სამუშაო მოგენიჭათ: ${label}`, link: `/bme?tab=works&work=${id}`, entityId: id });
    return this.get(id, u);
  }

  async cancel(id: string, reason: string, u: AuthUser, ctx: AuditContext) {
    this.full(u);
    await this.settings();
    await this.db.transaction().execute(async (trx) => {
      const w = await trx.selectFrom('bme_works').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!w) throw new NotFoundException('სამუშაო ვერ მოიძებნა');
      if (!(OPEN as readonly string[]).includes(w.status)) throw new ConflictException('სამუშაო დასრულებული / გაუქმებულია');
      await trx.updateTable('bme_works').set({ status: 'cancelled', cancel_reason: reason.trim(), updated_at: sql`now()` }).where('id', '=', id).execute();
      await this.event(trx, w.device_id, 'work_cancelled', { work_id: id, work_no: w.work_no, reason: reason.trim() }, u);
      await this.audit.log(ctx, { action: 'CANCEL_BME_WORK', entityName: 'bme_works', entityId: id, newData: { reason } }, trx);
    });
    return this.get(id, u);
  }

  // ---------------------------------------------------------------- სამუშაო: ნახვა / შესრულება
  async get(id: string, u: AuthUser) {
    await this.settings();
    const w = await this.worksQ().select(['b.manufacturer', 'b.model', 'b.serial_no', 'b.criticality', 'b.status_reason as device_status_reason'])
      .select(sql<number | null>`(coalesce(w.scheduled_date, w.due_date) - ${today()})::int`.as('days_left')).where('w.id', '=', id).executeTakeFirst();
    if (!w) throw new NotFoundException('სამუშაო ვერ მოიძებნა');
    await this.deviceVisible(u, w.device_id);
    const [items, documents] = await Promise.all([
      this.db.selectFrom('bme_work_items').selectAll().where('work_id', '=', id).orderBy('sort_order').execute(),
      this.db.selectFrom('bme_documents').select(['id', 'kind', 'title', 'valid_until', 'mime_type', 'original_name', 'created_at']).where('work_id', '=', id).where('is_active', '=', true).orderBy('created_at').execute(),
    ]);
    const auto = autoResult(items.map((i) => ({ outcome: i.outcome, critical: i.critical })));
    // 0075: სამუშაოდან შექმნილი ორდერი / ორდერის შემოწმება
    const [repair, forRepair] = await Promise.all([
      this.db.selectFrom('bme_repairs').select(['id', 'repair_no', 'status']).where('pm_work_id', '=', id).where('status', 'not in', ['rejected', 'duplicate']).executeTakeFirst(),
      this.db.selectFrom('bme_works as w').innerJoin('bme_repairs as r', 'r.id', 'w.repair_id').select(['r.id', 'r.repair_no', 'r.status']).where('w.id', '=', id).executeTakeFirst(),
    ]);
    return { ...w, items, documents, auto_result: auto, missing: items.filter((i) => i.required && !i.outcome).length, repair: repair ?? null, for_repair: forRepair ?? null };
  }

  /** ჩეკლისტის შევსება (ნაწილობრივ შენახვაც): გაზომვა → ავტომატური შედეგი; შემოწმება → pass / fail / na (სავალდებულოზე na — არა) */
  private async writeItems(trx: Ex, w: { id: string }, items: ItemValueDto[]) {
    const cur = await trx.selectFrom('bme_work_items').selectAll().where('work_id', '=', w.id).execute();
    for (const v of items) {
      const i = cur.find((x) => String(x.id) === String(v.id));
      if (!i) throw new BadRequestException(`ჩეკლისტის პუნქტი ${v.id} ვერ მოიძებნა`);
      let outcome: string | null; let value: string | null = null;
      if (i.item_type === 'measure') {
        if (v.value_num === null || v.value_num === undefined) {
          if (v.outcome === 'na' && !i.required) outcome = 'na';
          else if (v.outcome === 'na') throw new BadRequestException(`„${i.text}“ — სავალდებულო გაზომვა`);
          else outcome = null;
        } else { value = String(v.value_num); outcome = measureOutcome(i, v.value_num); }
      } else {
        if (v.outcome === 'na' && i.required) throw new BadRequestException(`„${i.text}“ — სავალდებულო პუნქტი (არ ეხება — არა)`);
        outcome = v.outcome ?? null;
      }
      await trx.updateTable('bme_work_items').set({ value_num: value, outcome, note: v.note?.trim() || null }).where('id', '=', i.id).execute();
    }
  }

  async saveItems(id: string, items: ItemValueDto[], u: AuthUser, ctx: AuditContext) {
    this.full(u);
    await this.settings();
    await this.db.transaction().execute(async (trx) => {
      const w = await trx.selectFrom('bme_works').select(['id', 'status', 'started_at']).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!w) throw new NotFoundException('სამუშაო ვერ მოიძებნა');
      if (!(OPEN as readonly string[]).includes(w.status)) throw new ConflictException('სამუშაო დასრულებული / გაუქმებულია');
      await this.writeItems(trx, w, items);
      await trx.updateTable('bme_works').set({ status: 'in_progress', ...(!w.started_at && { started_at: sql`now()` }), updated_at: sql`now()` }).where('id', '=', id).execute();
      await this.audit.log(ctx, { action: 'BME_WORK_ITEMS', entityName: 'bme_works', entityId: id, newData: { items: items.length } }, trx);
    });
    return this.get(id, u);
  }

  /**
   * დასრულება: შედეგი (≥ ავტომატურის სიმძიმის), შესრულების დღე, სერტიფიკატი (სახე მოითხოვს → № + ვადა);
   *  გეგმა: გავლილი / პირობითად → შემდეგი ვადა; ვერ გაიარა → ვადა რჩება (აპარატი ისევ ვადაზეა). სტატუსის შეთავაზება — არ იცვლება ავტომატურად.
   *  ვადაგადაცილებით ავტომატურად „შეზღუდული“ აპარატი — აღდგება, თუ სხვა ვადაგადაცილებული გეგმა აღარ აქვს. აქტის PDF → დოკუმენტებში.
   */
  async complete(id: string, dto: CompleteDto, u: AuthUser, ctx: AuditContext) {
    this.full(u);
    const s = await this.settings();
    let notify: { dept: string | null; resp: string | null; title: string; body: string } | null = null; let restored = false; let deviceId = ''; let repairNo: string | null = null;
    await this.db.transaction().execute(async (trx) => {
      const w = await trx.selectFrom('bme_works as w').innerJoin('bme_work_kinds as k', 'k.id', 'w.kind_id').innerJoin('bme_devices as b', 'b.id', 'w.device_id')
        .selectAll('w').select(['k.needs_certificate', 'k.short_name', 'b.inv_no', 'b.name as device_name', 'b.department_id', 'b.responsible_user_id', 'b.status as device_status', 'b.status_reason'])
        .where('w.id', '=', id).forUpdate('w').executeTakeFirst();
      if (!w) throw new NotFoundException('სამუშაო ვერ მოიძებნა');
      if (!(OPEN as readonly string[]).includes(w.status)) throw new ConflictException('სამუშაო უკვე დასრულებული / გაუქმებულია');
      deviceId = w.device_id;
      if (dto.items?.length) await this.writeItems(trx, w, dto.items);
      const items = await trx.selectFrom('bme_work_items').select(['outcome', 'critical', 'required', 'text']).where('work_id', '=', id).execute();
      const missing = items.filter((i) => i.required && !i.outcome);
      if (missing.length) throw new BadRequestException({ code: 'CHECKLIST_INCOMPLETE', message: `ჩეკლისტი შეუვსებელია: ${missing.slice(0, 3).map((i) => i.text).join('; ')}${missing.length > 3 ? ` (+${missing.length - 3})` : ''}` });
      const auto = autoResult(items);
      if (RESULT_RANK[dto.result] < RESULT_RANK[auto]) throw new BadRequestException({ code: 'RESULT_TOO_LOW', message: `ჩეკლისტის მიხედვით შედეგი მინიმუმ „${RESULT_KA[auto]}“-ა` });
      if (dto.result !== 'pass' && (!dto.result_note || dto.result_note.trim().length < 3)) throw new BadRequestException('შედეგის კომენტარი სავალდებულოა („პირობითად“ / „ვერ გაიარა“)');
      const todayS = await this.todayStr(trx);
      if (dto.performed_on > todayS) throw new BadRequestException('შესრულების დღე მომავალში ვერ იქნება');
      if (w.needs_certificate && dto.result !== 'fail' && (!dto.cert_no?.trim() || !dto.cert_valid_until)) throw new BadRequestException('სერტიფიკატის № და ვადა სავალდებულოა (სამუშაოს სახე)');
      if (dto.cert_valid_until && dto.cert_valid_until <= dto.performed_on) throw new BadRequestException('სერტიფიკატის ვადა შესრულების დღის შემდეგ უნდა იყოს');

      // გეგმა → შემდეგი ვადა
      let next: string | null = null;
      if (w.plan_id) {
        const p = await trx.selectFrom('bme_plans as p').innerJoin('bme_work_kinds as k', 'k.id', 'p.kind_id').innerJoin('bme_devices as b', 'b.id', 'p.device_id')
          .innerJoin('bme_device_types as t', 't.id', 'b.type_id').select(['p.id', 'p.next_due', effInterval.as('iv')]).where('p.id', '=', w.plan_id).forUpdate('p').executeTakeFirstOrThrow();
        if (dto.result !== 'fail') {
          next = await nextDue(trx, s, { interval: p.iv, prevDue: p.next_due, performedOn: dto.performed_on, certValidUntil: dto.cert_valid_until ?? null });
          await trx.updateTable('bme_plans').set({ last_done_on: dto.performed_on, last_work_id: id, last_result: dto.result, next_due: next, updated_at: sql`now()` }).where('id', '=', p.id).execute();
        } else {
          await trx.updateTable('bme_plans').set({ last_result: 'fail', last_work_id: id, updated_at: sql`now()` }).where('id', '=', p.id).execute();
        }
      }
      const suggested = SUGGEST[dto.result];
      await trx.updateTable('bme_works').set({ status: 'done', result: dto.result, result_note: dto.result_note?.trim() || null, performed_on: dto.performed_on,
        cert_no: dto.cert_no?.trim() || null, cert_valid_until: dto.cert_valid_until ?? null, next_due: next, suggested_status: suggested,
        completed_by: u.id, completed_at: sql`now()`, ...(!w.started_at && { started_at: sql`now()` }), updated_at: sql`now()` }).where('id', '=', id).execute();
      // ატვირთული სერტიფიკატის / აქტის ვადა = სერტიფიკატის ვადა
      if (dto.cert_valid_until) await trx.updateTable('bme_documents').set({ valid_until: dto.cert_valid_until }).where('work_id', '=', id).where('kind', '=', 'certificate').where('valid_until', 'is', null).execute();
      await this.event(trx, w.device_id, 'work_done', { work_id: id, work_no: w.work_no, kind: w.short_name, result: dto.result, next_due: next, suggested_status: suggested }, u);
      // 0075: „ვერ გაიარა“ → შეკეთების ორდერი ავტომატურად (პარამეტრი); ორდერის შემოწმება → ორდერის ისტორია / დახურვა (engineer რეჟიმი)
      if (dto.result === 'fail' && s.rep_pm_fail === 'auto') repairNo = (await this.repairFromWork(trx, s, id, u, false)).repair_no;
      if (w.repair_id) await this.afterPostCheck(trx, s, w.repair_id, { id, work_no: w.work_no, result: dto.result }, u);

      // ავტომატური „შეზღუდული“ (ვადაგადაცილება) — აღდგენა
      if (dto.result !== 'fail' && w.device_status === 'restricted' && (w.status_reason ?? '').startsWith(AUTO_REASON)) {
        const still = await trx.selectFrom('bme_plans').select('id').where('device_id', '=', w.device_id).where('is_active', '=', true).where('next_due', '<', today()).executeTakeFirst();
        if (!still) {
          await trx.updateTable('bme_status_periods').set({ ended_at: sql`now()`, ended_by: u.id }).where('device_id', '=', w.device_id).where('ended_at', 'is', null).execute();
          await trx.insertInto('bme_status_periods').values({ device_id: w.device_id, status: 'operational', reason: `${w.work_no}: გეგმიური სამუშაო შესრულდა`, started_by: u.id }).execute();
          await trx.updateTable('bme_devices').set({ status: 'operational', status_reason: null, status_since: sql`now()`, updated_at: sql`now()` }).where('id', '=', w.device_id).execute();
          await this.event(trx, w.device_id, 'status', { from: 'restricted', to: 'operational', reason: `${w.work_no}: გეგმიური სამუშაო შესრულდა`, auto_pm: true }, u);
          restored = true;
        }
      }
      await this.audit.log(ctx, { action: 'COMPLETE_BME_WORK', entityName: 'bme_works', entityId: id, newData: { ...dto, items: dto.items?.length ?? 0, auto_result: auto, next_due: next, restored } }, trx);
      if (dto.result !== 'pass' && s.pm_fail_notify_dept) notify = { dept: w.department_id, resp: w.responsible_user_id,
        title: `${w.inv_no} ${w.device_name}: ${w.short_name} — ${RESULT_KA[dto.result]}`,
        body: `${dto.result_note?.trim() ?? ''}${suggested ? ` · შეთავაზებული სტატუსი: ${STATUS_KA[suggested]}` : ''}${repairNo ? ` · შეკეთების ორდერი ${repairNo}` : ''}` };
    });
    // აქტის PDF → დოკუმენტებში (შენახული ასლი — უცვლელი)
    try { await this.storeAct(id, u); } catch (e) { /* PDF-ის შეცდომა დასრულებას არ აბრუნებს — აქტი ხელახლა იბეჭდება */ void e; }
    if (notify) {
      const n = notify as { dept: string | null; resp: string | null; title: string; body: string };
      const ids = new Set<string>([...(n.dept ? await this.deptUsers(n.dept) : []), ...(n.resp ? [n.resp] : []), ...(await this.engineers())]);
      for (const nid of ids) if (nid !== u.id) await this.notifications.notify(nid, { kind: 'bme_pm_fail', title: n.title, body: n.body, link: `/bme?device=${deviceId}`, entityId: id, urgent: true });
    }
    return this.get(id, u);
  }

  /** 0075: ორდერის შემოწმება დასრულდა → ორდერის ისტორია; engineer რეჟიმში შესრულებული ორდერი იხურება (გავლილი / პირობითად) */
  private async afterPostCheck(trx: Ex, s: BmeSettings, repairId: string, w: { id: string; work_no: string; result: PmResult }, u: AuthUser) {
    const r = await trx.selectFrom('bme_repairs').select(['id', 'repair_no', 'status', 'device_id', 'hold', 'post_check_work_id']).where('id', '=', repairId).forUpdate().executeTakeFirst();
    if (!r) return;
    await repEvent(trx, repairId, 'post_check', { work_id: w.id, work_no: w.work_no, result: w.result, done: true }, u.id);
    if (r.post_check_work_id === w.id && r.status === 'done' && s.rep_close_mode === 'engineer' && w.result !== 'fail' && !r.hold) {
      await trx.updateTable('bme_repairs').set({ status: 'closed', closed_at: sql`now()`, closed_by: u.id, close_kind: 'engineer', close_note: `შემოწმება ${w.work_no}: ${RESULT_KA[w.result]}`, updated_at: sql`now()` })
        .where('id', '=', repairId).execute();
      await repEvent(trx, repairId, 'closed', { kind: 'engineer', post_check: w.work_no }, u.id);
      await devEvent(trx, r.device_id, 'repair_closed', { repair_id: repairId, repair_no: r.repair_no, kind: 'engineer' }, u.id);
    }
  }

  /** „ვერ გაიარა“ / „პირობითად“ → შეთავაზებული სტატუსის გამოყენება (ინჟინრის გადაწყვეტილებით; 0073-ის სტატუსის ცვლილება — მიზეზით, პერიოდით, შეტყობინებით) */
  async applyStatus(id: string, dto: { status: BmeStatus; reason?: string }, u: AuthUser, ctx: AuditContext) {
    this.full(u);
    await this.settings();
    const w = await this.db.selectFrom('bme_works').select(['device_id', 'work_no', 'status', 'result', 'status_applied']).where('id', '=', id).executeTakeFirst();
    if (!w) throw new NotFoundException('სამუშაო ვერ მოიძებნა');
    if (w.status !== 'done' || w.result === 'pass') throw new ConflictException('სტატუსის შეთავაზება მხოლოდ „პირობითად“ / „ვერ გაიარა“ შედეგზე');
    if (w.status_applied) throw new ConflictException('სტატუსი უკვე გამოყენებულია');
    const reason = `${w.work_no}: ${RESULT_KA[w.result as PmResult]}${dto.reason?.trim() ? ` — ${dto.reason.trim()}` : ''}`;
    const rep = await this.db.selectFrom('bme_repairs').select('id').where('pm_work_id', '=', id).where('status', 'not in', ['rejected', 'duplicate', 'closed']).executeTakeFirst();
    await this.bme.setStatus(w.device_id, { status: dto.status, reason }, u, ctx, { repairId: rep?.id ?? null });
    await this.db.updateTable('bme_works').set({ status_applied: true, updated_at: sql`now()` }).where('id', '=', id).execute();
    return this.get(id, u);
  }

  // ---------------------------------------------------------------- ფაილები (სერტიფიკატი / აქტი) და აქტის PDF
  async upload(id: string, file: Express.Multer.File | undefined, dto: { kind?: string; title?: string; valid_until?: string }, u: AuthUser, ctx: AuditContext) {
    this.full(u);
    await this.settings();
    if (!file) throw new BadRequestException('ფაილი არ არის (ველი "file")');
    const kind = dto.kind ?? 'certificate';
    if (!['certificate', 'act', 'other'].includes(kind)) throw new BadRequestException('სახეობა: certificate / act / other');
    if (dto.valid_until && !/^\d{4}-\d{2}-\d{2}$/.test(dto.valid_until)) throw new BadRequestException('ვადა — YYYY-MM-DD');
    const w = await this.db.selectFrom('bme_works').select(['id', 'device_id', 'work_no', 'status', 'cert_valid_until']).where('id', '=', id).executeTakeFirst();
    if (!w) throw new NotFoundException('სამუშაო ვერ მოიძებნა');
    if (w.status === 'cancelled') throw new ConflictException('სამუშაო გაუქმებულია');
    const mime = sniffMime(file.buffer);
    if (!mime) throw new BadRequestException({ code: 'FILE_TYPE', message: 'დაშვებულია მხოლოდ PDF, JPG ან PNG' });
    const fid = randomUUID(); const ext = mime === 'application/pdf' ? 'pdf' : mime === 'image/png' ? 'png' : 'jpg';
    const key = `bme/${w.device_id}/${fid}.${ext}`;
    await this.storage.put(key, file.buffer, mime);
    const name = Buffer.from(file.originalname ?? '', 'latin1').toString('utf8').slice(0, 200) || null;
    const title = (dto.title?.trim() || `${kind === 'certificate' ? 'სერტიფიკატი' : kind === 'act' ? 'აქტი' : 'ფაილი'} ${w.work_no}`).slice(0, 200);
    await this.db.transaction().execute(async (trx) => {
      await trx.insertInto('bme_documents').values({ id: fid, device_id: w.device_id, work_id: id, kind, title, valid_until: dto.valid_until || (kind === 'certificate' ? w.cert_valid_until : null) || null,
        file_path: key, mime_type: mime, size_bytes: file.buffer.length, sha256: createHash('sha256').update(file.buffer).digest('hex'), original_name: name, uploaded_by: u.id }).execute();
      await this.event(trx, w.device_id, 'document', { kind, title, work_no: w.work_no, count: 1 }, u);
      await this.audit.log(ctx, { action: 'BME_WORK_FILE', entityName: 'bme_works', entityId: id, newData: { kind, file: fid } }, trx);
    });
    return this.get(id, u);
  }

  private async actData(id: string) {
    const w = await this.worksQ().select(['b.manufacturer', 'b.model', 'b.serial_no']).where('w.id', '=', id).executeTakeFirst();
    if (!w) throw new NotFoundException('სამუშაო ვერ მოიძებნა');
    const [items, clinic, settings, standard] = await Promise.all([
      this.db.selectFrom('bme_work_items').selectAll().where('work_id', '=', id).orderBy('sort_order').execute(),
      this.db.selectFrom('clinic_settings').select(['name', 'address', 'phone']).where('id', '=', 1).executeTakeFirst(),
      this.settings(),
      this.db.selectFrom('bme_work_kinds').select('standard').where('id', '=', w.kind_id).executeTakeFirst(),
    ]);
    return { w, items, clinic, settings, standard: standard?.standard ?? null };
  }
  async act(id: string, u: AuthUser) {
    const d = await this.actData(id);
    await this.deviceVisible(u, d.w.device_id);
    return renderAct({ ...d, deptSign: d.settings.pm_act_dept_sign });
  }
  private async storeAct(id: string, u: AuthUser) {
    const d = await this.actData(id);
    const buf = await renderAct({ ...d, deptSign: d.settings.pm_act_dept_sign });
    const fid = randomUUID(); const key = `bme/${d.w.device_id}/${fid}.pdf`;
    await this.storage.put(key, buf, 'application/pdf');
    await this.db.insertInto('bme_documents').values({ id: fid, device_id: d.w.device_id, work_id: id, kind: 'act', title: `აქტი ${d.w.work_no} — ${d.w.kind_short}`, valid_until: null,
      file_path: key, mime_type: 'application/pdf', size_bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex'), original_name: `${d.w.work_no}.pdf`, uploaded_by: u.id }).execute();
  }

  // ---------------------------------------------------------------- მოხმარების მთვლელი
  async addMeter(deviceId: string, dto: MeterDto, u: AuthUser, ctx: AuditContext) {
    this.full(u);
    await this.settings();
    await this.db.transaction().execute(async (trx) => {
      const d = await trx.selectFrom('bme_devices').select(['status']).where('id', '=', deviceId).executeTakeFirst();
      if (!d) throw new NotFoundException('აპარატი ვერ მოიძებნა');
      if (dto.read_on > (await this.todayStr(trx))) throw new BadRequestException('თარიღი მომავალში ვერ იქნება');
      const last = await trx.selectFrom('bme_meter_readings').select(['value', 'read_on']).where('device_id', '=', deviceId).where('unit', '=', dto.unit)
        .orderBy('read_on', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
      // ნაკლები მნიშვნელობა (მთვლელის შეცვლა / ნულოვანი) — მხოლოდ შენიშვნით
      if (last && dto.value < Number(last.value) && (!dto.note || dto.note.trim().length < 3)) throw new BadRequestException({ code: 'METER_DECREASE', message: `წინა ჩანაწერი ${Number(last.value)} — ნაკლები მნიშვნელობისთვის მიუთითეთ მიზეზი (შენიშვნა)` });
      await trx.insertInto('bme_meter_readings').values({ device_id: deviceId, unit: dto.unit, value: String(dto.value), read_on: dto.read_on, note: dto.note?.trim() || null, user_id: u.id }).execute();
      await this.event(trx, deviceId, 'meter', { unit: dto.unit, value: dto.value, read_on: dto.read_on }, u);
      await this.audit.log(ctx, { action: 'BME_METER', entityName: 'bme_devices', entityId: deviceId, newData: dto }, trx);
    });
    return this.devicePm(deviceId, u);
  }

  // ---------------------------------------------------------------- მიმღებები
  private async engineers() {
    return (await sql<{ id: string }>`SELECT u.id FROM users u JOIN user_capabilities c ON c.user_id = u.id WHERE u.is_active AND c.capabilities && ARRAY['med_engineer']::varchar[]`.execute(this.db)).rows.map((r) => r.id);
  }
  private async deptUsers(dep: string) {
    return (await sql<{ id: string }>`SELECT u.id FROM users u JOIN user_capabilities c ON c.user_id = u.id WHERE u.is_active AND c.capabilities && ARRAY['bme_dept']::varchar[]
      AND (u.department_id = ${dep} OR EXISTS (SELECT 1 FROM rpt_user_scopes s WHERE s.user_id = u.id AND s.department_id = ${dep}))`.execute(this.db)).rows.map((r) => r.id);
  }

  /** ეკრანზე: აპარატის ვადაგადაცილებული / ახლო სამუშაოები (რეესტრის ჩიპებისთვის — ჯამი) */
  async counts(u: AuthUser) {
    await this.settings();
    const sc = await viewScope(this.db, u);
    if (!sc.all && !sc.depts.length) return { overdue: 0, week: 0, month: 0, undated: 0, open: 0, mine: 0 };
    const r = await this.db.selectFrom('bme_plans as p').innerJoin('bme_devices as b', 'b.id', 'p.device_id')
      .leftJoin('bme_works as w', (j) => j.onRef('w.plan_id', '=', 'p.id').on('w.status', 'in', [...OPEN]))
      .select([sql<number>`count(*) FILTER (WHERE p.next_due < ${today()})::int`.as('overdue'), sql<number>`count(*) FILTER (WHERE p.next_due <= ${today()} + 7)::int`.as('week'),
        sql<number>`count(*) FILTER (WHERE p.next_due <= ${today()} + 31)::int`.as('month'), sql<number>`count(*) FILTER (WHERE p.next_due IS NULL)::int`.as('undated'),
        sql<number>`count(w.id)::int`.as('open'), sql<number>`count(*) FILTER (WHERE w.assignee_id = ${u.id})::int`.as('mine')])
      .where('p.is_active', '=', true).where('b.status', '<>', 'retired')
      .$if(!sc.all, (x) => x.where('b.department_id', 'in', (sc as { depts: string[] }).depts)).executeTakeFirstOrThrow();
    return r;
  }
}

// ======================================================================= DTO
const DATE = { strict: true } as const;
class KindDto {
  @IsOptional() @IsString() @Matches(/^[A-Z][A-Z0-9_]{1,19}$/) code?: string; @IsOptional() @IsString() @Length(2, 200) name?: string; @IsOptional() @IsString() @Length(2, 30) short_name?: string;
  @IsOptional() @IsIn(['pm_months', 'calibration_months', 'safety_months', null]) type_field?: string | null; @IsOptional() @IsInt() @Min(1) @Max(120) default_months?: number | null;
  @IsOptional() @IsArray() @IsIn(GROUPS, { each: true }) groups?: string[]; @IsOptional() @IsString() @MaxLength(200) standard?: string | null;
  @IsOptional() @IsBoolean() needs_certificate?: boolean; @IsOptional() @IsBoolean() is_active?: boolean; @IsOptional() @IsInt() sort_order?: number;
}
class ItemDto {
  @IsString() @Length(2, 300) text: string; @IsIn(['check', 'measure']) item_type: 'check' | 'measure'; @IsOptional() @IsString() @MaxLength(20) unit?: string | null;
  @IsOptional() @IsNumber() nominal?: number | null; @IsOptional() @IsNumber() @Min(0) tolerance?: number | null; @IsOptional() @IsNumber() limit_low?: number | null; @IsOptional() @IsNumber() limit_high?: number | null;
  @IsOptional() @IsBoolean() critical?: boolean; @IsOptional() @IsBoolean() required?: boolean;
}
class ChecklistDto {
  @IsOptional() @IsUUID() kind_id?: string; @IsOptional() @IsUUID() type_id?: string | null; @IsOptional() @IsString() @Length(2, 200) name?: string; @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(80) @ValidateNested({ each: true }) @Type(() => ItemDto) items?: ItemDto[];
}
class PlanDto {
  @IsOptional() @IsUUID() kind_id?: string; @IsOptional() @IsInt() @Min(1) @Max(120) interval_months?: number | null; @IsOptional() @IsISO8601(DATE) next_due?: string | null;
  @IsOptional() @IsISO8601(DATE) last_done_on?: string | null; @IsOptional() @IsBoolean() is_active?: boolean; @IsOptional() @IsString() @MaxLength(500) notes?: string | null;
}
class AssignDto {
  @IsOptional() @IsIn(['internal', 'external']) performer_kind?: 'internal' | 'external'; @IsOptional() @IsUUID() assignee_id?: string | null;
  @IsOptional() @IsUUID() supplier_id?: string | null; @IsOptional() @IsString() @MaxLength(200) external_person?: string | null;
}
class UpdateWorkDto extends AssignDto { @IsOptional() @IsISO8601(DATE) scheduled_date?: string | null }
class CreateWorkDto extends UpdateWorkDto { @IsOptional() @IsUUID() plan_id?: string; @IsOptional() @IsUUID() device_id?: string; @IsOptional() @IsUUID() kind_id?: string }
class BulkDto extends UpdateWorkDto { @IsArray() @ArrayMinSize(1) @ArrayMaxSize(300) @IsUUID('all', { each: true }) plan_ids: string[] }
class ItemValueDto {
  @IsInt() id: number; @IsOptional() @IsNumber() value_num?: number | null; @IsOptional() @IsIn(['pass', 'fail', 'na', null]) outcome?: 'pass' | 'fail' | 'na' | null;
  @IsOptional() @IsString() @MaxLength(500) note?: string | null;
}
class ItemsDto { @IsArray() @ArrayMaxSize(80) @ValidateNested({ each: true }) @Type(() => ItemValueDto) items: ItemValueDto[] }
class CompleteDto {
  @IsIn(RESULTS) result: PmResult; @IsISO8601(DATE) performed_on: string; @IsOptional() @IsString() @MaxLength(1000) result_note?: string | null;
  @IsOptional() @IsString() @MaxLength(60) cert_no?: string | null; @IsOptional() @IsISO8601(DATE) cert_valid_until?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(80) @ValidateNested({ each: true }) @Type(() => ItemValueDto) items?: ItemValueDto[];
}
class ApplyStatusDto { @IsIn(['restricted', 'down']) status: BmeStatus; @IsOptional() @IsString() @MaxLength(400) reason?: string }
class ReasonDto { @IsString() @Length(3, 500) reason: string }
class MeterDto { @IsIn(METER_UNITS) unit: string; @IsNumber() @Min(0) @Max(1e12) value: number; @IsISO8601(DATE) read_on: string; @IsOptional() @IsString() @MaxLength(300) note?: string | null }
class RunDto { @IsOptional() @IsArray() @ArrayMaxSize(200) @IsUUID('all', { each: true }) device_ids?: string[] }
interface BoardQ { view?: string; department_id?: string; kind_id?: string; grp?: string; assignee?: string; search?: string; result?: string }
const uuidOk = (v?: string) => !v || /^[0-9a-f-]{36}$/i.test(v);

/** გეგმიური სამუშაოები (0074) */
@Controller('bme')
export class PmController {
  constructor(private readonly s: PmService, private readonly jobs: BmePmJobsService) {}
  /** შეხსენებების / ვადაგადაცილების ხელით გაშვება (ადმინი; worker-ი ამას დღეში ერთხელ აკეთებს) */
  @Post('pm/run-reminders') @HttpCode(200) @Roles('admin') run(@Body() d: RunDto) { return this.jobs.tick(true, d?.device_ids); }
  @Get('pm/refs') refs() { return this.s.refs(); }
  @Get('pm/counts') counts(@CurrentUser() u: AuthUser) { return this.s.counts(u); }
  @Post('kinds') @Roles(...BME_FULL) kind(@Body() d: KindDto, @Req() r: Request) {
    if (!d.code || !d.name) throw new BadRequestException('კოდი და დასახელება სავალდებულოა');
    return this.s.saveKind(null, d, auditCtx(r));
  }
  @Patch('kinds/:id') @Roles(...BME_FULL) kindU(@Param('id', ParseUUIDPipe) id: string, @Body() d: KindDto, @Req() r: Request) {
    if (d.code !== undefined) throw new BadRequestException('კოდი არ იცვლება');
    return this.s.saveKind(id, d, auditCtx(r));
  }
  @Post('checklists') @Roles(...BME_FULL) cl(@Body() d: ChecklistDto, @Req() r: Request) { return this.s.saveChecklist(null, d, auditCtx(r)); }
  @Patch('checklists/:id') @Roles(...BME_FULL) clU(@Param('id', ParseUUIDPipe) id: string, @Body() d: ChecklistDto, @Req() r: Request) {
    if (d.kind_id !== undefined || d.type_id !== undefined) throw new BadRequestException('სახე / ტიპი არ იცვლება — შექმენით ახალი');
    return this.s.saveChecklist(id, d, auditCtx(r));
  }
  @Get('devices/:id/pm') pm(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser) { return this.s.devicePm(id, u); }
  @Post('devices/:id/plans') @Roles(...BME_FULL) addPlan(@Param('id', ParseUUIDPipe) id: string, @Body() d: PlanDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.addPlan(id, d, u, auditCtx(r)); }
  @Post('devices/:id/meters') @Roles(...BME_FULL) meter(@Param('id', ParseUUIDPipe) id: string, @Body() d: MeterDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.addMeter(id, d, u, auditCtx(r)); }
  @Patch('plans/:id') @Roles(...BME_FULL) plan(@Param('id', ParseUUIDPipe) id: string, @Body() d: PlanDto, @CurrentUser() u: AuthUser, @Req() r: Request) {
    if (d.kind_id !== undefined) throw new BadRequestException('სახე არ იცვლება');
    return this.s.updatePlan(id, d, u, auditCtx(r));
  }
  @Post('plans/sync') @HttpCode(200) @Roles(...BME_FULL) sync(@CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.sync(u, auditCtx(r)); }
  @Get('works') board(@CurrentUser() u: AuthUser, @Query() q: BoardQ) {
    if (!uuidOk(q.department_id) || !uuidOk(q.kind_id)) throw new BadRequestException('არასწორი id');
    return this.s.board(u, q);
  }
  @Post('works') @Roles(...BME_FULL) create(@Body() d: CreateWorkDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.create(d, u, auditCtx(r)); }
  @Post('works/bulk') @HttpCode(200) @Roles(...BME_FULL) bulk(@Body() d: BulkDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.bulk(d, u, auditCtx(r)); }
  @Get('works/:id') one(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser) { return this.s.get(id, u); }
  @Patch('works/:id') @Roles(...BME_FULL) upd(@Param('id', ParseUUIDPipe) id: string, @Body() d: UpdateWorkDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.update(id, d, u, auditCtx(r)); }
  @Put('works/:id/items') @Roles(...BME_FULL) items(@Param('id', ParseUUIDPipe) id: string, @Body() d: ItemsDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.saveItems(id, d.items, u, auditCtx(r)); }
  @Post('works/:id/complete') @HttpCode(200) @Roles(...BME_FULL) complete(@Param('id', ParseUUIDPipe) id: string, @Body() d: CompleteDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.complete(id, d, u, auditCtx(r)); }
  @Post('works/:id/cancel') @HttpCode(200) @Roles(...BME_FULL) cancel(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.cancel(id, d.reason, u, auditCtx(r)); }
  @Post('works/:id/apply-status') @HttpCode(200) @Roles(...BME_FULL) apply(@Param('id', ParseUUIDPipe) id: string, @Body() d: ApplyStatusDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.applyStatus(id, d, u, auditCtx(r)); }
  @Post('works/:id/files') @Roles(...BME_FULL) @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } }))
  file(@Param('id', ParseUUIDPipe) id: string, @UploadedFile() f: Express.Multer.File | undefined, @Body() b: { kind?: string; title?: string; valid_until?: string }, @CurrentUser() u: AuthUser, @Req() r: Request) {
    return this.s.upload(id, f, b ?? {}, u, auditCtx(r));
  }
  @Get('works/:id/act') async act(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Res() res: Response) {
    const buf = await this.s.act(id, u);
    res.setHeader('content-type', 'application/pdf'); res.setHeader('content-disposition', 'inline; filename="bme-act.pdf"'); res.setHeader('cache-control', 'no-store'); res.end(buf);
  }
}
