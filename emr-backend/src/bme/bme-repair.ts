import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Req,
  UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsISO8601, IsNumber, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { memoryStorage } from 'multer';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser } from '../auth/roles';
import { InjectDb, type Database } from '../database/database.module';
import { ModulesService } from '../modules/modules';
import { NotificationsService } from '../notifications/notifications';
import { NotifyService } from '../notify/notify.service';
import { sniffMime } from '../patient-files/patient-files';
import { StorageService } from '../storage/storage.service';
import { stockRules } from '../stock/stock-rules';
import { BME_DEPT, BME_FULL, BME_VIEW_ALL, userName, viewScope, type BmeSettings, type Ex, type Trx } from './bme-common';
import { today } from './bme-pm-common';
import {
  CONDITIONS, CONDITION_KA, OUTCOMES, OUTCOME_KA, REJECT_KA, REJECT_REASONS, REP_ACTIVE, REP_OPEN, REP_STATUS_KA, URGENCIES, URGENCY_KA,
  coverage, createRepair, deptBmeUsers, devEvent, repEvent, setDeviceStatus, slaHours, slaState, usersWithCaps,
  type Condition, type Outcome, type RepStatus, type Urgency,
} from './bme-repair-common';
import { BmeService } from './bme';
import { PmService } from './bme-pm';
import { BmeRepairJobsService } from './bme-repair-jobs';

const VIEWS = ['open', 'requested', 'mine', 'waiting', 'sla', 'done', 'closed', 'all'] as const;
const QUALITY = ['quality'] as const;
const r2 = (x: number) => Math.round(x * 100) / 100;

/**
 * ბიომედ-აპარატურა, ეტაპი 3 (0075): გაუმართაობის მოთხოვნა → ტრიაჟი → შეკეთების ორდერი → დახურვა.
 *  მოთხოვნა — ყველა თანამშრომელი (თავისი განყოფილების აპარატზე) ან მხოლოდ bme_dept (პარამეტრი); მართვა — სამედიცინო ინჟინერი;
 *  დახურვის დადასტურება — განმცხადებელი / განყოფილების bme_dept; მტკიცებულების შენახვა (hold) — ხარისხი / ინჟინერი, მოხსნა — ხარისხი.
 */
@Injectable()
export class RepairService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService, private readonly modules: ModulesService,
    private readonly notifications: NotificationsService, private readonly notify: NotifyService, private readonly storage: StorageService,
    private readonly bme: BmeService, private readonly pm: PmService) {}

  private settings() { return this.modules.require<BmeSettings>('bme'); }
  private full(u: AuthUser) { if (!has(u, ...BME_FULL)) throw new ForbiddenException('შეკეთების ორდერის მართვა — სამედიცინო ინჟინერი'); }
  private async todayStr(ex: Ex) { return (await sql<{ d: string }>`SELECT to_char(${today()}, 'YYYY-MM-DD') AS d`.execute(ex)).rows[0].d; }

  // ---------------------------------------------------------------- ცნობარები
  async refs() {
    const s = await this.settings();
    const [codes, suppliers, engineers, locations, kinds] = await Promise.all([
      this.db.selectFrom('bme_repair_codes').selectAll().orderBy('kind').orderBy('sort_order').orderBy('name').execute(),
      this.db.selectFrom('stock_suppliers').select(['id', 'name', 'phone', 'contact_person']).where('is_active', '=', true).orderBy('name').limit(1000).execute(),
      sql<{ id: string; name: string }>`SELECT u.id, u.first_name || ' ' || u.last_name AS name FROM users u JOIN user_capabilities c ON c.user_id = u.id
        WHERE u.is_active AND c.capabilities && ARRAY['med_engineer', 'admin']::varchar[] ORDER BY u.last_name`.execute(this.db).then((r) => r.rows),
      this.db.selectFrom('stock_locations').select(['id', 'name', 'code']).where('is_active', '=', true).orderBy('name').execute(),
      this.db.selectFrom('bme_work_kinds').select(['id', 'code', 'name', 'short_name']).where('is_active', '=', true).orderBy('sort_order').execute(),
    ]);
    return {
      settings: { rep_who: s.rep_who, rep_close_mode: s.rep_close_mode, rep_close_auto_days: s.rep_close_auto_days, rep_post_check: s.rep_post_check, rep_pm_fail: s.rep_pm_fail,
        rep_sla_response: s.rep_sla_response, rep_sla_restore: s.rep_sla_restore, rep_labor_rate: s.rep_labor_rate, rep_parts_location_id: s.rep_parts_location_id, rep_sets_down: s.rep_sets_down },
      codes, suppliers, engineers, locations, kinds, statuses: REP_STATUS_KA, conditions: CONDITION_KA, urgencies: URGENCY_KA, outcomes: OUTCOME_KA, reject_reasons: REJECT_KA,
    };
  }

  /** ნაწილის არჩევა (ინჟინერს საწყობის კატალოგზე წვდომა არ აქვს): ლოკაციით — ნაშთიანი საქონელი; ლოკაციის გარეშე — კატალოგი (შესყიდვისთვის) */
  async stockItems(locationId: string | undefined, search: string | undefined) {
    await this.settings();
    const t = search?.trim().toLowerCase() ?? '';
    if (locationId) {
      return this.db.selectFrom('stock_balances as b').innerJoin('stock_items as i', 'i.id', 'b.item_id').innerJoin('stock_lots as lt', 'lt.id', 'b.lot_id')
        .select(['i.id', 'i.name', 'i.code', sql<string>`sum(b.qty)::text`.as('qty')]).where('b.location_id', '=', locationId).where('b.qty', '>', '0').where('lt.status', '=', 'active')
        .where('i.is_active', '=', true).$if(!!t, (q) => q.where(sql`lower(i.name || ' ' || coalesce(i.code, ''))`, 'like', `%${t}%`))
        .groupBy(['i.id', 'i.name', 'i.code']).orderBy('i.name').limit(50).execute();
    }
    if (t.length < 2) return [];
    return this.db.selectFrom('stock_items as i').select(['i.id', 'i.name', 'i.code', sql<string | null>`NULL`.as('qty')]).where('i.is_active', '=', true)
      .where(sql`lower(i.name || ' ' || coalesce(i.code, ''))`, 'like', `%${t}%`).orderBy('i.name').limit(30).execute();
  }

  async saveCode(id: string | null, dto: CodeDto, ctx: AuditContext) {
    await this.settings();
    try {
      const r = id
        ? await this.db.updateTable('bme_repair_codes').set({ ...(dto.name !== undefined && { name: dto.name.trim() }), ...(dto.is_active !== undefined && { is_active: dto.is_active }),
          ...(dto.sort_order !== undefined && { sort_order: dto.sort_order }), updated_at: sql`now()` }).where('id', '=', id).returningAll().executeTakeFirst()
        : await this.db.insertInto('bme_repair_codes').values({ kind: dto.kind!, code: dto.code!, name: dto.name!.trim(), sort_order: dto.sort_order ?? 100 }).returningAll().executeTakeFirst();
      if (!r) throw new NotFoundException('ჩანაწერი ვერ მოიძებნა');
      await this.audit.log(ctx, { action: id ? 'UPDATE_BME_REPAIR_CODE' : 'CREATE_BME_REPAIR_CODE', entityName: 'bme_repair_codes', entityId: r.id, newData: dto });
      return r;
    } catch (e) {
      if ((e as { constraint?: string }).constraint === 'bme_repair_codes_kind_code_key') throw new ConflictException('იგივე კოდი უკვე არსებობს');
      throw e;
    }
  }

  // ---------------------------------------------------------------- ხედვა
  /** ხედვის არე: სრული (ინჟინერი / ნახვა / ხარისხი) → ყველა; bme_dept → განყოფილებ(ებ)ის აპარატები + თავისი მოთხოვნები; სხვა → მხოლოდ საკუთარი მოთხოვნები */
  private async scope(u: AuthUser): Promise<{ all: true } | { all: false; depts: string[] }> {
    if (has(u, ...BME_VIEW_ALL, ...QUALITY)) return { all: true };   // ხარისხის მენეჯერი — ინციდენტი / შენახვა გამოძიებისთვის
    if (has(u, ...BME_DEPT)) return viewScope(this.db, u);
    return { all: false, depts: [] };
  }
  private async canSee(u: AuthUser, r: { reported_by: string; department_id: string | null; reporter_department_id: string | null }) {
    if (r.reported_by === u.id) return true;
    const sc = await this.scope(u);
    return sc.all || (!!r.department_id && sc.depts.includes(r.department_id)) || (!!r.reporter_department_id && sc.depts.includes(r.reporter_department_id));
  }
  /** დახურვის დადასტურება / ხელახლა გახსნა: განმცხადებელი, აპარატის განყოფილების bme_dept, admin */
  private async isDeptSide(u: AuthUser, r: { reported_by: string; department_id: string | null }) {
    if (r.reported_by === u.id || has(u, 'admin')) return true;
    if (!has(u, ...BME_DEPT) || !r.department_id) return false;
    const sc = await viewScope(this.db, u);
    return sc.all || sc.depts.includes(r.department_id);
  }

  private q(ex: Ex = this.db, pct = 80) {
    return ex.selectFrom('bme_repairs as r').innerJoin('bme_devices as b', 'b.id', 'r.device_id').innerJoin('bme_device_types as t', 't.id', 'b.type_id')
      .leftJoin('departments as d', 'd.id', 'b.department_id').leftJoin('users as rb', 'rb.id', 'r.reported_by').leftJoin('users as ra', 'ra.id', 'r.assignee_id')
      .leftJoin('stock_suppliers as rs', 'rs.id', 'r.supplier_id').leftJoin('bme_contracts as c', 'c.id', 'r.contract_id')
      .selectAll('r')
      .select(['b.inv_no', 'b.name as device_name', 'b.status as device_status', 'b.status_reason as device_status_reason', 'b.criticality', 'b.department_id', 'b.room',
        'b.manufacturer', 'b.model', 'b.serial_no', 'd.name as department_name', 't.name as type_name',
        userName('rb').as('reported_by_name'), userName('ra').as('assignee_name'), 'rs.name as supplier_name', 'c.contract_no',
        slaState('response', pct).as('sla_response'), slaState('restore', pct).as('sla_restore'),
        sql<string>`round((r.parts_cost + r.labor_cost + r.external_cost)::numeric, 2)::text`.as('total_cost'),
        sql<number | null>`round(extract(epoch FROM coalesce(r.done_at, now()) - r.reported_at) / 3600.0, 1)::float`.as('age_hours')]);
  }

  async list(u: AuthUser, q: ListQ) {
    const s = await this.settings();
    const view = (VIEWS as readonly string[]).includes(q.view ?? '') ? q.view! : 'open';
    let x = this.q(this.db, s.rep_sla_warn_pct).orderBy(sql`coalesce(r.priority, r.suggested_priority)`).orderBy('r.reported_at', 'desc').limit(1000);
    const sc = await this.scope(u);
    if (!sc.all) {
      const depts = sc.depts;
      x = x.where((eb) => eb.or([eb('r.reported_by', '=', u.id), ...(depts.length ? [eb('b.department_id', 'in', depts), eb('r.reporter_department_id', 'in', depts)] : [])]));
    }
    if (view === 'open') x = x.where('r.status', 'in', REP_ACTIVE);
    else if (view === 'requested') x = x.where('r.status', '=', 'requested');
    else if (view === 'mine') x = x.where('r.assignee_id', '=', u.id).where('r.status', 'in', REP_ACTIVE);
    else if (view === 'waiting') x = x.where('r.status', 'in', ['waiting_parts', 'waiting_vendor']);
    else if (view === 'sla') x = x.where('r.status', 'in', REP_OPEN).where((eb) => eb.or([eb(slaState('response', s.rep_sla_warn_pct), 'in', ['warn', 'breached']), eb(slaState('restore', s.rep_sla_warn_pct), 'in', ['warn', 'breached'])]));
    else if (view === 'done') x = x.where('r.status', '=', 'done');
    else if (view === 'closed') x = x.where('r.status', 'in', ['closed', 'rejected', 'duplicate']).where('r.updated_at', '>', sql<Date>`now() - interval '180 days'`);
    if (q.device_id) x = x.where('r.device_id', '=', q.device_id);
    if (q.department_id) x = x.where('b.department_id', '=', q.department_id);
    if (q.priority && /^[1-4]$/.test(q.priority)) x = x.where(sql`coalesce(r.priority, r.suggested_priority)`, '=', Number(q.priority));
    const t = q.search?.trim();
    if (t) x = x.where((eb) => eb.or([eb(sql`upper(r.repair_no)`, 'like', `%${t.toUpperCase()}%`), eb(sql`upper(b.inv_no)`, 'like', `%${t.toUpperCase()}%`),
      eb(sql`lower(b.name)`, 'like', `%${t.toLowerCase()}%`), eb(sql`lower(r.description)`, 'like', `%${t.toLowerCase()}%`)]));
    return x.execute();
  }

  async counts(u: AuthUser) {
    const s = await this.settings();
    const sc = await this.scope(u);
    let x = this.db.selectFrom('bme_repairs as r').innerJoin('bme_devices as b', 'b.id', 'r.device_id')
      .select([sql<number>`count(*) FILTER (WHERE r.status = ANY (${sql.val(REP_ACTIVE)}::text[]))::int`.as('open'), sql<number>`count(*) FILTER (WHERE r.status = 'requested')::int`.as('requested'),
        sql<number>`count(*) FILTER (WHERE r.assignee_id = ${u.id} AND r.status = ANY (${sql.val(REP_ACTIVE)}::text[]))::int`.as('mine'),
        sql<number>`count(*) FILTER (WHERE r.status IN ('waiting_parts', 'waiting_vendor'))::int`.as('waiting'), sql<number>`count(*) FILTER (WHERE r.status = 'done')::int`.as('done'),
        sql<number>`count(*) FILTER (WHERE r.status = ANY (${sql.val(REP_OPEN)}::text[]) AND (${slaState('response', s.rep_sla_warn_pct)} = 'breached' OR ${slaState('restore', s.rep_sla_warn_pct)} = 'breached'))::int`.as('sla_breached')]);
    if (!sc.all) {
      const depts = sc.depts;
      x = x.where((eb) => eb.or([eb('r.reported_by', '=', u.id), ...(depts.length ? [eb('b.department_id', 'in', depts), eb('r.reporter_department_id', 'in', depts)] : [])]));
    }
    return x.executeTakeFirstOrThrow();
  }

  async get(id: string, u: AuthUser) {
    const s = await this.settings();
    const r = await this.q(this.db, s.rep_sla_warn_pct).leftJoin('users as tb', 'tb.id', 'r.triaged_by').leftJoin('users as db', 'db.id', 'r.done_by').leftJoin('users as cb', 'cb.id', 'r.closed_by')
      .leftJoin('bme_repair_codes as rc', 'rc.id', 'r.cause_id').leftJoin('bme_repair_codes as ac', 'ac.id', 'r.action_id').leftJoin('bme_devices as lo', 'lo.id', 'r.loaner_device_id')
      .leftJoin('bme_repairs as dup', 'dup.id', 'r.duplicate_of').leftJoin('bme_works as pw', 'pw.id', 'r.pm_work_id').leftJoin('bme_works as cw', 'cw.id', 'r.post_check_work_id')
      .leftJoin('qm_incidents as qi', 'qi.id', 'r.incident_id').leftJoin('ap_invoices as ai', 'ai.id', 'r.ap_invoice_id')
      .select([userName('tb').as('triaged_by_name'), userName('db').as('done_by_name'), userName('cb').as('closed_by_name'), 'rc.name as cause_name', 'ac.name as action_name',
        'lo.inv_no as loaner_inv_no', 'lo.name as loaner_name', 'dup.repair_no as duplicate_of_no', 'pw.work_no as pm_work_no', 'cw.work_no as post_check_work_no', 'cw.status as post_check_status',
        'cw.result as post_check_result', 'qi.inc_no as incident_no', 'qi.status as incident_status', 'ai.invoice_no as ap_invoice_no'])
      .where('r.id', '=', id).executeTakeFirst();
    if (!r) throw new NotFoundException('ორდერი ვერ მოიძებნა');
    if (!(await this.canSee(u, r))) throw new ForbiddenException('ორდერი თქვენს ხედვის არეში არ არის');
    const full = has(u, ...BME_FULL);
    const [events, parts, purchases, documents, incidents, dupes, periods] = await Promise.all([
      this.db.selectFrom('bme_repair_events as e').leftJoin('users as eu', 'eu.id', 'e.user_id').select(['e.id', 'e.kind', 'e.data', 'e.created_at', userName('eu').as('user_name')])
        .where('e.repair_id', '=', id).orderBy('e.id').execute(),
      this.db.selectFrom('stock_docs as sd').innerJoin('stock_doc_lines as l', 'l.doc_id', 'sd.id').innerJoin('stock_items as i', 'i.id', 'l.item_id').innerJoin('stock_locations as sl', 'sl.id', 'sd.location_id')
        .select(['sd.id as doc_id', 'sd.doc_no', 'sd.doc_date', 'sd.status', 'sl.name as location_name', 'i.name as item_name', 'l.qty', 'l.lot_no', 'l.unit_cost', 'l.line_net'])
        .where('sd.bme_repair_id', '=', id).orderBy('sd.created_at').orderBy('l.line_no').execute(),
      this.db.selectFrom('proc_requisitions as p').select(['p.id', 'p.pr_no', 'p.status', 'p.est_total', 'p.created_at']).where('p.bme_repair_id', '=', id).orderBy('p.created_at').execute(),
      this.db.selectFrom('bme_documents').select(['id', 'kind', 'title', 'mime_type', 'original_name', 'created_at']).where('repair_id', '=', id).where('is_active', '=', true).orderBy('created_at').execute(),
      // აპარატზე მიბმული ინციდენტები (მხოლოდ № და სტატუსი; შინაარსი — ხარისხის მოდულში)
      this.db.selectFrom('qm_incidents').select(['id', 'inc_no', 'status', 'reported_at']).where('source_type', '=', 'bme_device').where('source_id', '=', r.device_id)
        .where('reported_at', '>=', sql<Date>`${r.reported_at}::timestamptz - interval '2 days'`).orderBy('reported_at').limit(20).execute(),
      this.db.selectFrom('bme_repairs').select(['id', 'repair_no', 'status', 'reported_at']).where('duplicate_of', '=', id).execute(),
      this.db.selectFrom('bme_status_periods').select(['id', 'status', 'started_at', 'ended_at', sql<number>`round(extract(epoch FROM coalesce(ended_at, now()) - started_at) / 3600.0, 1)::float`.as('hours')])
        .where('repair_id', '=', id).orderBy('started_at').execute(),
    ]);
    const cov = full && REP_ACTIVE.includes(r.status as RepStatus) ? await coverage(this.db, r.device_id) : null;
    const openOthers = await this.db.selectFrom('bme_repairs').select(['id', 'repair_no', 'status']).where('device_id', '=', r.device_id).where('id', '<>', id).where('status', 'in', REP_ACTIVE).execute();
    const dept = await this.isDeptSide(u, r);
    const postPending = this.postPending(r);
    return {
      ...r, events, parts, purchases, documents, incidents, duplicates: dupes, periods, coverage_info: cov, open_others: openOthers, post_check_pending: postPending,
      can: {
        manage: full, confirm: r.status === 'done' && dept && !postPending && !r.hold, reopen: ['done', 'closed'].includes(r.status) && (dept || full),
        hold: has(u, ...QUALITY) || full, release: has(u, ...QUALITY, 'admin'), close: r.status === 'done' && !postPending && !r.hold && (full && (s.rep_close_mode === 'engineer' || has(u, 'admin'))),
      },
    };
  }
  private postPending(r: { post_check_required: boolean; post_check_work_id: string | null; post_check_status?: string | null; post_check_result?: string | null }) {
    if (!r.post_check_required) return false;
    return !(r.post_check_status === 'done' && (r.post_check_result === 'pass' || r.post_check_result === 'conditional'));
  }

  /** აპარატის ორდერები (პასპორტის ჩანართი) + დაფარვა */
  async device(deviceId: string, u: AuthUser) {
    const s = await this.settings();
    const d = await this.db.selectFrom('bme_devices').select(['id', 'department_id']).where('id', '=', deviceId).executeTakeFirst();
    if (!d) throw new NotFoundException('აპარატი ვერ მოიძებნა');
    const vs = await viewScope(this.db, u);
    if (!vs.all && !(d.department_id && vs.depts.includes(d.department_id))) throw new ForbiddenException('აპარატი თქვენს განყოფილებაზე არ არის');
    let x = this.q(this.db, s.rep_sla_warn_pct).where('r.device_id', '=', deviceId).orderBy('r.reported_at', 'desc').limit(200);
    const sc = await this.scope(u);
    if (!sc.all && !(d.department_id && sc.depts.includes(d.department_id))) x = x.where('r.reported_by', '=', u.id);
    const [repairs, cov, contracts] = await Promise.all([
      x.execute(), coverage(this.db, deviceId),
      this.db.selectFrom('bme_contracts as c').innerJoin('bme_contract_devices as cd', 'cd.contract_id', 'c.id').innerJoin('stock_suppliers as s', 's.id', 'c.supplier_id')
        .select(['c.id', 'c.contract_no', 'c.title', 'c.kind', 'c.start_date', 'c.end_date', 'c.status', 's.name as supplier_name',
          sql<boolean>`c.status = 'active' AND ${today()} BETWEEN c.start_date AND c.end_date`.as('in_force')])
        .where('cd.device_id', '=', deviceId).orderBy('c.end_date', 'desc').execute(),
    ]);
    return { repairs, coverage: cov, contracts, can_request: await this.canRequest(u, s, d) };
  }

  private async canRequest(u: AuthUser, s: BmeSettings, d: { department_id: string | null }) {
    if (has(u, ...BME_FULL)) return true;
    if (s.rep_who === 'bme_dept' && !has(u, ...BME_DEPT)) return false;
    const vs = await viewScope(this.db, u);
    return vs.all || (!!d.department_id && vs.depts.includes(d.department_id));
  }

  // ---------------------------------------------------------------- მოთხოვნა
  async request(dto: RequestDto, u: AuthUser, ctx: AuditContext) {
    const s = await this.settings();
    const d = await this.db.selectFrom('bme_devices').select(['id', 'inv_no', 'name', 'status', 'department_id', 'criticality']).where('id', '=', dto.device_id).executeTakeFirst();
    if (!d) throw new NotFoundException('აპარატი ვერ მოიძებნა');
    if (!(await this.canRequest(u, s, d))) throw new ForbiddenException(s.rep_who === 'bme_dept' ? 'გაუმართაობის მოთხოვნა — „ბიომედ-აპარატურა (განყოფილება)“ უფლებით' : 'აპარატი თქვენს განყოფილებაზე არ არის');
    if (d.status === 'retired') throw new ConflictException('აპარატი გამოყვანილია');
    const open = await this.db.selectFrom('bme_repairs').select(['id', 'repair_no', 'status', 'description']).where('device_id', '=', d.id).where('status', 'in', REP_ACTIVE).execute();
    if (open.length && !dto.force) throw new ConflictException({ code: 'REPAIR_OPEN', message: `აპარატზე უკვე ღია ორდერია: ${open.map((o) => o.repair_no).join(', ')} — დაამატეთ შენიშვნა არსებულს ან მაინც შექმენით ახალი`, repairs: open });
    const me = await this.db.selectFrom('users').select(['department_id']).where('id', '=', u.id).executeTakeFirst();
    let res!: Awaited<ReturnType<typeof createRepair>>;
    await this.db.transaction().execute(async (trx) => {
      res = await createRepair(trx, s, { device_id: d.id, source: has(u, ...BME_FULL) && dto.as_engineer ? 'engineer' : 'request', condition: dto.condition, urgency: dto.urgency ?? 'normal',
        description: dto.description, patient_involved: dto.patient_involved, contact_phone: dto.contact_phone, reporter_department_id: me?.department_id ?? null }, u.id);
      await this.audit.log(ctx, { action: 'CREATE_BME_REPAIR', entityName: 'bme_repairs', entityId: res.id, newData: { ...dto, repair_no: res.repair_no, status_down: res.status_down } }, trx);
    });
    // ინჟინრებს: ეკრანზე ყოველთვის; P1 / „პაციენტის უსაფრთხოება“ — სასწრაფო + ელფოსტა / SMS (პარამეტრი)
    const urgent = res.priority === 1 || dto.urgency === 'safety';
    const title = `${urgent ? 'სასწრაფო: ' : ''}გაუმართაობა ${res.repair_no} · ${d.inv_no} ${d.name}`;
    const body = `${CONDITION_KA[dto.condition]} · P${res.priority} (შეთავაზება)${res.status_down ? ' · სტატუსი → გაუმართავი' : ''}\n${dto.description.trim().slice(0, 300)}`;
    await this.toEngineers({ kind: 'bme_repair_new', title, body, link: `/bme?tab=repairs&repair=${res.id}`, entityId: res.id, urgent }, u.id, urgent);
    if (res.status_down) await this.notifyDept(d.department_id, { kind: 'bme_status', title: `${d.inv_no} ${d.name}: გაუმართავი`, body: `${res.repair_no}: ${dto.description.trim().slice(0, 200)}`, link: `/bme?device=${d.id}`, entityId: d.id }, u.id);
    return { ...(await this.get(res.id, u)), suggest_incident: !!dto.patient_involved };
  }

  private async toEngineers(n: { kind: string; title: string; body?: string; link: string; entityId: string; urgent?: boolean }, except: string | null, external = false) {
    const s = await this.settings();
    const ids = await usersWithCaps(this.db, ['med_engineer']);
    for (const id of ids) if (id !== except) await this.notifications.notify(id, n);
    if (!external || (!s.rep_notify_email && !s.rep_notify_sms)) return;
    const cs = ids.length ? await this.db.selectFrom('users').select(['email', 'phone']).where('id', 'in', ids).execute() : [];
    if (s.rep_notify_email) { const em = cs.map((c) => c.email).filter((x): x is string => !!x); if (em.length) await this.notify.email(em, `EMR · ${n.title}`, `${n.title}\n\n${n.body ?? ''}`); }
    if (s.rep_notify_sms) { const ph = cs.map((c) => c.phone).filter((x): x is string => !!x); if (ph.length) await this.notify.sms(ph, `EMR ბიომედ: ${n.title}`.slice(0, 300)); }
  }
  private async notifyDept(dep: string | null, n: { kind: string; title: string; body?: string; link: string; entityId: string }, except: string | null, extra: string[] = []) {
    const ids = new Set([...(await deptBmeUsers(this.db, dep)), ...extra]);
    for (const id of ids) if (id !== except) await this.notifications.notify(id, n);
  }

  /** შენიშვნა (ნებისმიერი, ვინც ორდერს ხედავს — მაგ. „იგივე პრობლემა“) */
  async note(id: string, text: string, u: AuthUser, ctx: AuditContext) {
    await this.settings();
    const r = await this.lockless(id);
    if (!(await this.canSee(u, r))) throw new ForbiddenException('ორდერი თქვენს ხედვის არეში არ არის');
    if (['closed', 'rejected', 'duplicate'].includes(r.status)) throw new ConflictException('ორდერი დახურულია');
    await repEvent(this.db, id, 'note', { text: text.trim() }, u.id);
    await this.audit.log(ctx, { action: 'BME_REPAIR_NOTE', entityName: 'bme_repairs', entityId: id, newData: { text } });
    if (r.assignee_id && r.assignee_id !== u.id) await this.notifications.notify(r.assignee_id, { kind: 'bme_repair_note', title: `${r.repair_no}: შენიშვნა`, body: text.trim().slice(0, 300), link: `/bme?tab=repairs&repair=${id}`, entityId: id });
    return this.get(id, u);
  }
  private async lockless(id: string) {
    const r = await this.db.selectFrom('bme_repairs as r').innerJoin('bme_devices as b', 'b.id', 'r.device_id').selectAll('r').select(['b.department_id']).where('r.id', '=', id).executeTakeFirst();
    if (!r) throw new NotFoundException('ორდერი ვერ მოიძებნა');
    return r;
  }
  private async lock(trx: Trx, id: string) {
    const r = await trx.selectFrom('bme_repairs as r').innerJoin('bme_devices as b', 'b.id', 'r.device_id')
      .selectAll('r').select(['b.department_id', 'b.inv_no', 'b.name as device_name', 'b.status as device_status', 'b.criticality', 'b.responsible_user_id'])
      .where('r.id', '=', id).forUpdate('r').executeTakeFirst();
    if (!r) throw new NotFoundException('ორდერი ვერ მოიძებნა');
    return r;
  }

  // ---------------------------------------------------------------- ტრიაჟი / მინიჭება
  private async performer(ex: Ex, dto: PerformerDto) {
    const kind = dto.performer_kind ?? 'internal';
    if (kind === 'internal') {
      if (dto.assignee_id && !(await usersWithCaps(ex, ['med_engineer', 'admin'])).includes(dto.assignee_id)) throw new BadRequestException('შიდა შემსრულებელი — სამედიცინო ინჟინერი (აქტიური)');
      return { performer_kind: 'internal' as const, assignee_id: dto.assignee_id ?? null, supplier_id: null, external_person: null };
    }
    if (!dto.supplier_id && !dto.external_person?.trim()) throw new BadRequestException('გარე შემსრულებელი: მომწოდებელი ან კონტაქტი');
    if (dto.supplier_id && !(await ex.selectFrom('stock_suppliers').select('id').where('id', '=', dto.supplier_id).where('is_active', '=', true).executeTakeFirst())) throw new BadRequestException('მომწოდებელი ვერ მოიძებნა');
    // გარე სამუშაოს კოორდინატორი (შიდა) — სურვილით
    if (dto.assignee_id && !(await usersWithCaps(ex, ['med_engineer', 'admin'])).includes(dto.assignee_id)) throw new BadRequestException('კოორდინატორი — სამედიცინო ინჟინერი');
    return { performer_kind: 'external' as const, assignee_id: dto.assignee_id ?? null, supplier_id: dto.supplier_id ?? null, external_person: dto.external_person?.trim() || null };
  }

  /** SLA-ს ვადები: რეაგირება — შიდა: მოთხოვნიდან; გარე: გამოძახებიდან (სანამ არ გამოიძახეს — არ ითვლება); აღდგენა — მოთხოვნიდან */
  private slaSet(s: BmeSettings, r: { reported_at: Date | string; vendor_called_at: Date | string | null }, priority: number, external: boolean, contract: { response_hours: number[] | null; restore_hours: number[] | null } | null) {
    const h = slaHours(s, priority, external, contract);
    const base = external ? r.vendor_called_at : r.reported_at;
    return {
      sla_response_hours: h.response, sla_restore_hours: h.restore,
      sla_response_due: base ? sql<Date>`${base}::timestamptz + make_interval(hours => ${h.response})` : null,
      sla_restore_due: sql<Date>`${r.reported_at}::timestamptz + make_interval(hours => ${h.restore})`,
      sla_warned_at: null, sla_breach_notified_at: null,
    };
  }

  async triage(id: string, dto: TriageDto, u: AuthUser, ctx: AuditContext) {
    this.full(u);
    const s = await this.settings();
    let notify: string | null = null; let label = ''; let statusMsg: { dep: string | null; title: string; body: string; dev: string } | null = null;
    await this.db.transaction().execute(async (trx) => {
      const r = await this.lock(trx, id);
      const first = r.status === 'requested';
      if (!REP_OPEN.includes(r.status as RepStatus)) throw new ConflictException('ორდერი დასრულებული / დახურულია');
      const perf = await this.performer(trx, { performer_kind: dto.performer_kind ?? (r.performer_kind as 'internal' | 'external'),
        assignee_id: dto.assignee_id !== undefined ? dto.assignee_id : r.assignee_id, supplier_id: dto.supplier_id !== undefined ? dto.supplier_id : r.supplier_id,
        external_person: dto.external_person !== undefined ? dto.external_person : r.external_person });
      const priority = dto.priority ?? r.priority ?? r.suggested_priority;
      // დაფარვა: გარანტია / კონტრაქტი (use_coverage = false — არ ვიყენებთ)
      const cov = await coverage(trx, r.device_id);
      const useCov = dto.use_coverage !== false && !!cov.coverage && perf.performer_kind === 'external';
      const vendorCalled = perf.performer_kind === 'external' && dto.vendor_called ? (r.vendor_called_at ?? new Date()) : (perf.performer_kind === 'external' ? r.vendor_called_at : null);
      const sla = this.slaSet(s, { reported_at: r.reported_at, vendor_called_at: vendorCalled }, priority, perf.performer_kind === 'external', useCov ? cov : null);
      await trx.updateTable('bme_repairs').set({
        ...perf, priority, ...(first && { status: 'triaged', triaged_by: u.id, triaged_at: sql`now()` }), triage_note: dto.triage_note !== undefined ? dto.triage_note?.trim() || null : r.triage_note,
        coverage: useCov ? cov.coverage : null, contract_id: useCov ? cov.contract_id : null, vendor_called_at: vendorCalled, ...(dto.vendor_ref !== undefined && { vendor_ref: dto.vendor_ref?.trim() || null }),
        ...(dto.loaner_device_id !== undefined && { loaner_device_id: dto.loaner_device_id }), ...(dto.loaner_text !== undefined && { loaner_text: dto.loaner_text?.trim() || null }),
        ...sla, updated_at: sql`now()`,
      }).where('id', '=', id).execute();
      await repEvent(trx, id, first ? 'triaged' : 'assigned', { priority, performer_kind: perf.performer_kind, assignee_id: perf.assignee_id, supplier_id: perf.supplier_id, coverage: useCov ? cov.coverage : null,
        response_h: sla.sla_response_hours, restore_h: sla.sla_restore_hours, note: dto.triage_note ?? null }, u.id);
      if (dto.vendor_called && !r.vendor_called_at && perf.performer_kind === 'external') await repEvent(trx, id, 'vendor_called', { vendor_ref: dto.vendor_ref ?? null }, u.id);
      // აპარატის სტატუსი ტრიაჟზე (ინჟინრის გადაწყვეტილება)
      if (dto.device_status && dto.device_status !== r.device_status) {
        if (dto.device_status === 'operational' && r.hold) throw new ConflictException({ code: 'BME_HOLD', message: 'აპარატი შენახულია გამოძიებისთვის — აღდგენა ხარისხის მენეჯერის მოხსნამდე დაბლოკილია' });
        const reason = dto.device_status === 'operational' ? `${r.repair_no}: ტრიაჟი — მუშაობს` : `${r.repair_no}: ${r.description.slice(0, 160)}`;
        if (await setDeviceStatus(trx, r.device_id, dto.device_status, reason, u.id, id)) statusMsg = { dep: r.department_id, title: `${r.inv_no} ${r.device_name}: ${dto.device_status === 'down' ? 'გაუმართავი' : dto.device_status === 'restricted' ? 'შეზღუდულად მუშა' : 'მუშა'}`, body: reason, dev: r.device_id };
      }
      if (perf.assignee_id && perf.assignee_id !== r.assignee_id) { notify = perf.assignee_id; label = `${r.repair_no} · ${r.inv_no} ${r.device_name} · P${priority}`; }
      await this.audit.log(ctx, { action: first ? 'TRIAGE_BME_REPAIR' : 'UPDATE_BME_REPAIR', entityName: 'bme_repairs', entityId: id,
        oldData: { priority: r.priority, performer_kind: r.performer_kind, assignee_id: r.assignee_id, supplier_id: r.supplier_id }, newData: dto }, trx);
    });
    if (notify && notify !== u.id) await this.notifications.notify(notify, { kind: 'bme_repair', title: `შეკეთება მოგენიჭათ: ${label}`, link: `/bme?tab=repairs&repair=${id}`, entityId: id });
    if (statusMsg) { const m = statusMsg as { dep: string | null; title: string; body: string; dev: string }; await this.notifyDept(m.dep, { kind: 'bme_status', title: m.title, body: m.body, link: `/bme?device=${m.dev}`, entityId: m.dev }, u.id); }
    return this.get(id, u);
  }

  /** უარყოფა / დუბლიკატი (ტრიაჟამდე ან ტრიაჟის შემდეგ, სამუშაოს დაწყებამდე); აპარატი ამ მოთხოვნით „გაუმართავი“ → წინა სტატუსი */
  async reject(id: string, dto: RejectDto, u: AuthUser, ctx: AuditContext) {
    this.full(u);
    await this.settings();
    let reporter = ''; let label = '';
    await this.db.transaction().execute(async (trx) => {
      const r = await this.lock(trx, id);
      if (!['requested', 'triaged'].includes(r.status)) throw new ConflictException('უარყოფა — მხოლოდ სამუშაოს დაწყებამდე');
      if (r.hold) throw new ConflictException({ code: 'BME_HOLD', message: 'აპარატი შენახულია გამოძიებისთვის' });
      const dup = dto.reason === 'duplicate';
      if (dup) {
        if (!dto.duplicate_of) throw new BadRequestException('დუბლიკატი: მიუთითეთ ძირითადი ორდერი');
        const o = await trx.selectFrom('bme_repairs').select(['id', 'device_id', 'status', 'repair_no']).where('id', '=', dto.duplicate_of).executeTakeFirst();
        if (!o || o.id === id || o.device_id !== r.device_id) throw new BadRequestException('ძირითადი ორდერი იმავე აპარატზე უნდა იყოს');
        if (!REP_ACTIVE.includes(o.status as RepStatus)) throw new BadRequestException('ძირითადი ორდერი დახურულია');
        // ამ მოთხოვნით გახსნილი „გაუმართავი“ პერიოდი — ძირითად ორდერს გადაეცემა
        await trx.updateTable('bme_status_periods').set({ repair_id: o.id }).where('repair_id', '=', id).where('ended_at', 'is', null).execute();
      }
      if (dto.reason === 'other' && (!dto.note || dto.note.trim().length < 3)) throw new BadRequestException('მიზეზი „სხვა“ — კომენტარი სავალდებულოა');
      await trx.updateTable('bme_repairs').set({ status: dup ? 'duplicate' : 'rejected', reject_reason: dto.reason, reject_note: dto.note?.trim() || null, duplicate_of: dup ? dto.duplicate_of! : null,
        ...(r.status === 'requested' && { triaged_by: u.id, triaged_at: sql`now()` }), updated_at: sql`now()` }).where('id', '=', id).execute();
      await repEvent(trx, id, dup ? 'duplicate' : 'rejected', { reason: dto.reason, note: dto.note ?? null, duplicate_of: dto.duplicate_of ?? null }, u.id);
      await devEvent(trx, r.device_id, 'repair_rejected', { repair_id: id, repair_no: r.repair_no, reason: dto.reason }, u.id);
      // აღდგენა: მიმდინარე ღია პერიოდი ამ ორდერმა გახსნა → წინა სტატუსი
      if (!dup) {
        const p = await trx.selectFrom('bme_status_periods').select(['id']).where('device_id', '=', r.device_id).where('ended_at', 'is', null).where('repair_id', '=', id).executeTakeFirst();
        if (p) {
          const prev = (['operational', 'restricted', 'standby'].includes(r.device_status_before ?? '') ? r.device_status_before : 'operational') as 'operational' | 'restricted' | 'standby';
          await setDeviceStatus(trx, r.device_id, prev, prev === 'operational' ? null : `${r.repair_no}: უარყოფილი მოთხოვნა — წინა სტატუსი`, u.id, null);
        }
      }
      await this.audit.log(ctx, { action: dup ? 'DUPLICATE_BME_REPAIR' : 'REJECT_BME_REPAIR', entityName: 'bme_repairs', entityId: id, newData: dto }, trx);
      reporter = r.reported_by; label = `${r.repair_no} · ${r.inv_no} ${r.device_name}`;
    });
    if (reporter !== u.id) await this.notifications.notify(reporter, { kind: 'bme_repair', title: `${label}: ${dto.reason === 'duplicate' ? 'დუბლიკატი' : 'უარყოფილია'}`, body: `${REJECT_KA[dto.reason]}${dto.note ? ` — ${dto.note.trim()}` : ''}`, link: `/bme?tab=repairs&repair=${id}`, entityId: id });
    return this.get(id, u);
  }

  /** ქმედებები: დაწყება, მომწოდებლის გამოძახება / ჩამოსვლა, ლოდინი (ნაწილები / მომწოდებელი), გაგრძელება */
  async act(id: string, dto: ActDto, u: AuthUser, ctx: AuditContext) {
    this.full(u);
    const s = await this.settings();
    await this.db.transaction().execute(async (trx) => {
      const r = await this.lock(trx, id);
      if (!REP_OPEN.includes(r.status as RepStatus) || r.status === 'requested') throw new ConflictException(r.status === 'requested' ? 'ჯერ ტრიაჟი' : 'ორდერი დასრულებული / დახურულია');
      if (r.hold && ['start', 'vendor_arrived', 'resume'].includes(dto.action)) throw new ConflictException({ code: 'BME_HOLD', message: 'აპარატი შენახულია გამოძიებისთვის — შეკეთება ხარისხის მენეჯერის მოხსნამდე დაბლოკილია' });
      const set: Record<string, unknown> = { updated_at: sql`now()` };
      const note = dto.note?.trim() || null;
      switch (dto.action) {
        case 'start':
          if (!['triaged', 'waiting_parts', 'waiting_vendor'].includes(r.status)) throw new ConflictException('სამუშაო უკვე მიმდინარეობს');
          Object.assign(set, { status: 'in_progress', wait_reason: null, ...(!r.started_at && { started_at: sql`now()` }) });
          break;
        case 'vendor_called': {
          if (r.performer_kind !== 'external') throw new BadRequestException('გამოძახება — გარე შემსრულებელზე');
          if (r.vendor_called_at) throw new ConflictException('მომწოდებელი უკვე გამოძახებულია');
          const cov = r.contract_id ? await trx.selectFrom('bme_contracts').select(['response_hours', 'restore_hours']).where('id', '=', r.contract_id).executeTakeFirst() : null;
          const h = slaHours(s, r.priority ?? r.suggested_priority, true, cov ?? null);
          Object.assign(set, { vendor_called_at: sql`now()`, vendor_ref: dto.vendor_ref?.trim() || r.vendor_ref, status: 'waiting_vendor', wait_reason: note,
            sla_response_hours: h.response, sla_response_due: sql`now() + make_interval(hours => ${h.response})`, sla_warned_at: null });
          break;
        }
        case 'vendor_arrived':
          if (r.performer_kind !== 'external') throw new BadRequestException('ჩამოსვლა — გარე შემსრულებელზე');
          if (!r.vendor_called_at) throw new BadRequestException('ჯერ — გამოძახება');
          if (r.vendor_arrived_at) throw new ConflictException('ჩამოსვლა უკვე აღრიცხულია');
          Object.assign(set, { vendor_arrived_at: sql`now()`, status: 'in_progress', wait_reason: null, ...(!r.started_at && { started_at: sql`now()` }) });
          break;
        case 'wait_parts': case 'wait_vendor':
          if (!['triaged', 'in_progress', 'waiting_parts', 'waiting_vendor'].includes(r.status)) throw new ConflictException('ამ სტატუსიდან ლოდინი არ ირთვება');
          if (!note || note.length < 3) throw new BadRequestException('ლოდინის მიზეზი სავალდებულოა');
          Object.assign(set, { status: dto.action === 'wait_parts' ? 'waiting_parts' : 'waiting_vendor', wait_reason: note });
          break;
        case 'resume':
          if (!['waiting_parts', 'waiting_vendor'].includes(r.status)) throw new ConflictException('ორდერი ლოდინში არ არის');
          Object.assign(set, { status: 'in_progress', wait_reason: null, ...(!r.started_at && { started_at: sql`now()` }) });
          break;
      }
      await trx.updateTable('bme_repairs').set(set).where('id', '=', id).execute();
      const kind = dto.action === 'start' ? 'started' : dto.action === 'resume' ? 'resumed' : dto.action.startsWith('wait') ? 'waiting' : dto.action;
      await repEvent(trx, id, kind, { action: dto.action, note, ...(dto.vendor_ref && { vendor_ref: dto.vendor_ref }) }, u.id);
      await this.audit.log(ctx, { action: 'BME_REPAIR_ACT', entityName: 'bme_repairs', entityId: id, newData: dto }, trx);
    });
    return this.get(id, u);
  }

  // ---------------------------------------------------------------- ნაწილები / შესყიდვა
  /** ჩამოწერა საწყობიდან (FEFO, თვითღირებულება — ლოტით), writeoff_reason = bme_use; დამტკიცების გარეშე */
  async parts(id: string, dto: PartsDto, u: AuthUser, ctx: AuditContext) {
    this.full(u);
    const s = await this.settings();
    const locId = dto.location_id ?? s.rep_parts_location_id;
    if (!locId) throw new BadRequestException('ლოკაცია (საწყობი) სავალდებულოა — ან მიუთითეთ ნაგულისხმევი პარამეტრებში');
    let docNo = ''; let total = 0;
    try {
      await this.db.transaction().execute(async (trx) => {
        const r = await this.lock(trx, id);
        if (!REP_OPEN.includes(r.status as RepStatus) || r.status === 'requested') throw new ConflictException(r.status === 'requested' ? 'ჯერ ტრიაჟი' : 'ორდერი დასრულებული / დახურულია');
        const loc = await trx.selectFrom('stock_locations').select(['id', 'name', 'is_active']).where('id', '=', locId).executeTakeFirst();
        if (!loc?.is_active) throw new BadRequestException('ლოკაცია ვერ მოიძებნა ან გათიშულია');
        const cnt = await trx.selectFrom('stock_counts').select('count_no').where('location_id', '=', locId).where('status', 'in', ['open', 'counted']).executeTakeFirst();
        if (cnt && (await stockRules(this.db)).count_lock) throw new ConflictException(`ლოკაციაზე მიმდინარეობს ინვენტარიზაცია ${cnt.count_no} — მოძრაობა დაბლოკილია`);
        const todayS = await this.todayStr(trx);
        const d = await trx.insertInto('stock_docs').values({ doc_type: 'writeoff', doc_date: todayS, location_id: locId, writeoff_reason: 'bme_use', bme_repair_id: id,
          notes: `ბიომედ: შეკეთება ${r.repair_no} · ${r.inv_no}`, created_by: u.id }).returning('id').executeTakeFirstOrThrow();
        let n = 0;
        for (const c of dto.lines) {
          const it = await trx.selectFrom('stock_items').select(['id', 'name', 'is_active']).where('id', '=', c.item_id).executeTakeFirst();
          if (!it?.is_active) throw new BadRequestException('საქონელი ვერ მოიძებნა ან გათიშულია');
          let need = c.qty;
          const lots = await trx.selectFrom('stock_balances as b').innerJoin('stock_lots as lt', 'lt.id', 'b.lot_id').select(['lt.id', 'lt.lot_no', 'lt.serial_no', 'lt.expires_on', 'lt.produced_on', 'lt.unit_cost', 'b.qty'])
            .where('b.location_id', '=', locId).where('b.item_id', '=', c.item_id).where('b.qty', '>', '0').where('lt.status', '=', 'active')
            .where((eb) => eb.or([eb('lt.expires_on', 'is', null), eb('lt.expires_on', '>=', todayS)])).orderBy(sql`lt.expires_on NULLS LAST`).orderBy('lt.created_at').execute();
          for (const lot of lots) {
            if (need <= 1e-9) break;
            const qn = Math.min(need, Number(lot.qty)); need -= qn; n++; total += qn * Number(lot.unit_cost);
            const line = await trx.insertInto('stock_doc_lines').values({ doc_id: d.id, line_no: n, item_id: c.item_id, qty: String(qn), qty_base: String(qn), lot_no: lot.lot_no, serial_no: lot.serial_no,
              expires_on: lot.expires_on, produced_on: lot.produced_on, unit_cost: lot.unit_cost, lot_id: lot.id, line_net: String(r2(qn * Number(lot.unit_cost))) }).returning('id').executeTakeFirstOrThrow();
            await trx.insertInto('stock_moves').values({ doc_id: d.id, line_id: line.id, move_type: 'writeoff', location_id: locId, lot_id: lot.id, item_id: c.item_id, qty: String(-qn), cost_lot: lot.unit_cost, created_by: u.id }).execute();
          }
          if (need > 1e-9) throw new ConflictException({ code: 'NO_STOCK', message: `„${it.name}“ — „${loc.name}“-ში საკმარისი ნაშთი არ არის (აკლია ${Math.round(need * 1000) / 1000}) — შესყიდვის მოთხოვნა` });
        }
        const { last_value } = await trx.insertInto('document_counters').values({ document_type: 'stock_WO', year: Number(todayS.slice(0, 4)), last_value: 1 })
          .onConflict((oc) => oc.columns(['document_type', 'year']).doUpdateSet({ last_value: sql`document_counters.last_value + 1` })).returning('last_value').executeTakeFirstOrThrow();
        docNo = `WO${todayS.slice(2, 4)}-${String(last_value).padStart(6, '0')}`;
        total = r2(total);
        await trx.updateTable('stock_docs').set({ status: 'posted', doc_no: docNo, posted_by: u.id, posted_at: sql`now()`, total_net: String(total) }).where('id', '=', d.id).execute();
        await trx.updateTable('bme_repairs').set({ parts_cost: sql`parts_cost + ${total}`, updated_at: sql`now()` }).where('id', '=', id).execute();
        await repEvent(trx, id, 'parts_issued', { doc_id: d.id, doc_no: docNo, location: loc.name, lines: dto.lines.length, total }, u.id);
        await this.audit.log(ctx, { action: 'BME_REPAIR_PARTS', entityName: 'bme_repairs', entityId: id, newData: { ...dto, location_id: locId, doc_no: docNo, total } }, trx);
      });
    } catch (e) {
      if ((e as { constraint?: string }).constraint === 'stock_balances_non_negative') throw new ConflictException({ code: 'NO_STOCK', message: 'ნაშთი არასაკმარისია' });
      throw e;
    }
    return { doc_no: docNo, total, repair: await this.get(id, u) };
  }

  /** შესყიდვის მოთხოვნის მონახაზი (0051, source = bme_repair) → ორდერი „ელოდება ნაწილებს“; საწყობის მენეჯერს / შესყიდვებს — შეტყობინება */
  async purchase(id: string, dto: PurchaseDto, u: AuthUser, ctx: AuditContext) {
    this.full(u);
    const s = await this.settings();
    const pm = await this.db.selectFrom('system_modules').select('enabled').where('code', '=', 'procurement').executeTakeFirst();
    if (!pm?.enabled) throw new ConflictException({ code: 'MODULE_DISABLED', message: 'მოდული „შესყიდვები“ გამორთულია' });
    const locId = dto.location_id ?? s.rep_parts_location_id;
    if (!locId) throw new BadRequestException('მიწოდების ლოკაცია სავალდებულოა');
    let prId = ''; let label = '';
    await this.db.transaction().execute(async (trx) => {
      const r = await this.lock(trx, id);
      if (!REP_OPEN.includes(r.status as RepStatus) || r.status === 'requested') throw new ConflictException(r.status === 'requested' ? 'ჯერ ტრიაჟი' : 'ორდერი დასრულებული / დახურულია');
      const loc = await trx.selectFrom('stock_locations').select(['id', 'is_active']).where('id', '=', locId).executeTakeFirst();
      if (!loc?.is_active) throw new BadRequestException('ლოკაცია ვერ მოიძებნა ან გათიშულია');
      const lines = [];
      for (const [i, l] of dto.lines.entries()) {
        if (!l.item_id && (l.free_name ?? '').trim().length < 2) throw new BadRequestException(`ხაზი ${i + 1}: აირჩიეთ საქონელი ან ჩაწერეთ დასახელება`);
        if (l.item_id && !(await trx.selectFrom('stock_items').select('id').where('id', '=', l.item_id).where('is_active', '=', true).executeTakeFirst())) throw new BadRequestException(`ხაზი ${i + 1}: საქონელი ვერ მოიძებნა`);
        lines.push({ line_no: i + 1, item_id: l.item_id ?? null, free_name: l.item_id ? null : l.free_name!.trim(), qty: String(l.qty), qty_base: String(l.qty),
          est_price: l.est_price === undefined || l.est_price === null ? null : String(l.est_price), supplier_id: l.supplier_id ?? r.supplier_id ?? null, notes: null });
      }
      const est = r2(lines.reduce((a, l) => a + Number(l.qty) * Number(l.est_price ?? 0), 0));
      const p = await trx.insertInto('proc_requisitions').values({ location_id: locId, source: 'bme_repair', bme_repair_id: id, urgent: (r.priority ?? 4) <= 2, needed_by: dto.needed_by ?? null,
        notes: `ბიომედ: შეკეთება ${r.repair_no} · ${r.inv_no} ${r.device_name}${dto.notes?.trim() ? ` — ${dto.notes.trim()}` : ''}`, est_total: String(est), created_by: u.id }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('proc_requisition_lines').values(lines.map((l) => ({ ...l, requisition_id: p.id }))).execute();
      prId = p.id; label = `${r.repair_no} · ${r.inv_no} ${r.device_name}`;
      if (['triaged', 'in_progress'].includes(r.status)) await trx.updateTable('bme_repairs').set({ status: 'waiting_parts', wait_reason: 'შესყიდვის მოთხოვნა', updated_at: sql`now()` }).where('id', '=', id).execute();
      await repEvent(trx, id, 'purchase', { requisition_id: p.id, lines: lines.length, est_total: est }, u.id);
      await this.audit.log(ctx, { action: 'BME_REPAIR_PURCHASE', entityName: 'bme_repairs', entityId: id, newData: { ...dto, requisition_id: p.id } }, trx);
    });
    for (const uid of await usersWithCaps(this.db, ['stock_manager', 'procurement'])) if (uid !== u.id) {
      await this.notifications.notify(uid, { kind: 'bme_repair_purchase', title: `შესყიდვის მოთხოვნა (მონახაზი) — შეკეთება ${label}`, body: 'შეამოწმეთ ფასი / მომწოდებელი და გაგზავნეთ', link: '/procurement/requisitions', entityId: prId });
    }
    return { requisition_id: prId, repair: await this.get(id, u) };
  }

  // ---------------------------------------------------------------- დასრულება / სტატუსი / დახურვა
  async complete(id: string, dto: CompleteDto, u: AuthUser, ctx: AuditContext) {
    this.full(u);
    const s = await this.settings();
    let msg: { reporter: string; dep: string | null; title: string } | null = null; let autoClosed = false;
    await this.db.transaction().execute(async (trx) => {
      const r = await this.lock(trx, id);
      if (!REP_OPEN.includes(r.status as RepStatus) || r.status === 'requested') throw new ConflictException(r.status === 'requested' ? 'ჯერ ტრიაჟი' : 'ორდერი უკვე დასრულებული / დახურულია');
      if (r.hold) throw new ConflictException({ code: 'BME_HOLD', message: 'აპარატი შენახულია გამოძიებისთვის — დასრულება ხარისხის მენეჯერის მოხსნამდე დაბლოკილია' });
      if (dto.resolution.trim().length < 3) throw new BadRequestException('შესრულებული სამუშაოს აღწერა სავალდებულოა');
      for (const [k, kind] of [[dto.cause_id, 'cause'], [dto.action_id, 'action']] as const) {
        if (k && !(await trx.selectFrom('bme_repair_codes').select('id').where('id', '=', k).where('kind', '=', kind).executeTakeFirst())) throw new BadRequestException(kind === 'cause' ? 'მიზეზი ვერ მოიძებნა' : 'ქმედება ვერ მოიძებნა');
      }
      if (dto.outcome !== 'no_fault' && !dto.cause_id) throw new BadRequestException('მიზეზი სავალდებულოა (კლასიფიკატორი)');
      if (dto.ap_invoice_id && !(await trx.selectFrom('ap_invoices').select('id').where('id', '=', dto.ap_invoice_id).executeTakeFirst())) throw new BadRequestException('ინვოისი ვერ მოიძებნა');
      if (dto.done_at && new Date(dto.done_at) > new Date()) throw new BadRequestException('დასრულების დრო მომავალში ვერ იქნება');
      // შემოწმება შეკეთების შემდეგ (0074 სამუშაო): life_support / high — შეთავაზება; required_life_support — life_support-ზე სავალდებულო
      const critOk = ['life_support', 'high'].includes(r.criticality);
      const required = s.rep_post_check === 'required_life_support' && r.criticality === 'life_support' && dto.outcome === 'repaired';
      if (required && !dto.post_check_kind_id) throw new BadRequestException({ code: 'POST_CHECK_REQUIRED', message: 'სიცოცხლის შემანარჩუნებელი აპარატი — შეკეთების შემდეგ შემოწმება სავალდებულოა (აირჩიეთ სამუშაოს სახე)' });
      let checkId: string | null = null;
      if (dto.post_check_kind_id && s.rep_post_check !== 'off' && (critOk || required) && dto.outcome === 'repaired') {
        const w = await this.pm.createWorkInTrx(trx, s, { device_id: r.device_id, kind_id: dto.post_check_kind_id, plan_id: null, due_date: await this.todayStr(trx), scheduled_date: await this.todayStr(trx), repair_id: id },
          { performer_kind: 'internal', assignee_id: u.id, supplier_id: null, external_person: null }, u);
        checkId = w.id;
        await repEvent(trx, id, 'post_check', { work_id: w.id, work_no: w.work_no, required }, u.id);
      }
      const labor = dto.labor_hours ?? null;
      const laborCost = r2((labor ?? 0) * (s.rep_labor_rate ?? 0));
      const sugg = dto.outcome === 'not_repairable' ? 'retired' : (r.device_status !== 'operational' && r.device_status !== 'retired' ? 'operational' : null);
      const closeNow = s.rep_close_mode === 'engineer' && !required;
      await trx.updateTable('bme_repairs').set({
        status: closeNow ? 'closed' : 'done', outcome: dto.outcome, cause_id: dto.cause_id ?? null, action_id: dto.action_id ?? null, resolution: dto.resolution.trim(),
        done_at: dto.done_at ? sql`${dto.done_at}::timestamptz` : sql`now()`, done_by: u.id, labor_hours: labor === null ? null : String(labor), labor_cost: String(laborCost),
        ...(dto.external_cost !== undefined && { external_cost: String(dto.external_cost ?? 0) }), ...(dto.invoice_no !== undefined && { invoice_no: dto.invoice_no?.trim() || null }),
        ...(dto.ap_invoice_id !== undefined && { ap_invoice_id: dto.ap_invoice_id }),
        ...(!r.started_at && { started_at: sql`now()` }), ...(r.performer_kind === 'external' && !r.vendor_arrived_at && r.vendor_called_at && { vendor_arrived_at: sql`now()` }),
        suggested_status: sugg, status_applied: false, post_check_required: required, ...(checkId && { post_check_work_id: checkId }), wait_reason: null,
        ...(closeNow && { closed_at: sql`now()`, closed_by: u.id, close_kind: 'engineer' }), updated_at: sql`now()`,
      }).where('id', '=', id).execute();
      await repEvent(trx, id, 'done', { outcome: dto.outcome, labor_hours: labor, external_cost: dto.external_cost ?? 0, suggested_status: sugg, post_check: !!checkId }, u.id);
      await devEvent(trx, r.device_id, 'repair_done', { repair_id: id, repair_no: r.repair_no, outcome: dto.outcome }, u.id);
      if (closeNow) { await repEvent(trx, id, 'closed', { kind: 'engineer' }, u.id); await devEvent(trx, r.device_id, 'repair_closed', { repair_id: id, repair_no: r.repair_no, kind: 'engineer' }, u.id); autoClosed = true; }
      await this.audit.log(ctx, { action: 'COMPLETE_BME_REPAIR', entityName: 'bme_repairs', entityId: id, newData: { ...dto, labor_cost: laborCost, suggested_status: sugg, post_check_work_id: checkId, closed: closeNow } }, trx);
      msg = { reporter: r.reported_by, dep: r.department_id, title: `${r.repair_no} · ${r.inv_no} ${r.device_name}: ${OUTCOME_KA[dto.outcome]}` };
    });
    if (msg) {
      const m = msg as { reporter: string; dep: string | null; title: string };
      const confirm = !autoClosed && s.rep_close_mode === 'confirm';
      await this.notifyDept(m.dep, { kind: 'bme_repair_done', title: m.title, body: confirm ? `დაადასტურეთ მიღება (ავტომატურად დაიხურება ${s.rep_close_auto_days || '—'} დღეში)` : undefined,
        link: `/bme?tab=repairs&repair=${id}`, entityId: id }, u.id, [m.reporter]);
    }
    return this.get(id, u);
  }

  /** შეთავაზებული სტატუსის გამოყენება („მუშა“ / „გამოყვანილი“) — 0073-ის სტატუსის ცვლილება, ორდერის ბმით */
  async applyStatus(id: string, u: AuthUser, ctx: AuditContext) {
    this.full(u);
    await this.settings();
    const r = await this.lockless(id);
    if (!['done', 'closed'].includes(r.status) || !r.suggested_status) throw new ConflictException('სტატუსის შეთავაზება არ არის');
    if (r.status_applied) throw new ConflictException('სტატუსი უკვე გამოყენებულია');
    if (r.hold) throw new ConflictException({ code: 'BME_HOLD', message: 'აპარატი შენახულია გამოძიებისთვის' });
    if (this.postPending(await this.db.selectFrom('bme_repairs as r').leftJoin('bme_works as cw', 'cw.id', 'r.post_check_work_id')
      .select(['r.post_check_required', 'r.post_check_work_id', 'cw.status as post_check_status', 'cw.result as post_check_result']).where('r.id', '=', id).executeTakeFirstOrThrow()) && r.suggested_status === 'operational') {
      throw new ConflictException({ code: 'POST_CHECK_PENDING', message: 'ჯერ — შემოწმება შეკეთების შემდეგ (სამუშაო)' });
    }
    const reason = r.suggested_status === 'retired' ? `${r.repair_no}: შეუკეთებელია — ${(r.resolution ?? '').slice(0, 150)}` : null;
    await this.bme.setStatus(r.device_id, { status: r.suggested_status as 'operational' | 'retired', reason }, u, ctx, { repairId: id });
    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable('bme_repairs').set({ status_applied: true, updated_at: sql`now()` }).where('id', '=', id).execute();
      await repEvent(trx, id, 'status_applied', { status: r.suggested_status }, u.id);
    });
    return this.get(id, u);
  }

  /** განყოფილების დადასტურება (confirm რეჟიმი) */
  async confirm(id: string, note: string | undefined, u: AuthUser, ctx: AuditContext) {
    await this.settings();
    let eng: string | null = null; let label = '';
    await this.db.transaction().execute(async (trx) => {
      const r = await this.lock(trx, id);
      if (r.status !== 'done') throw new ConflictException('დასადასტურებელი ორდერი არ არის');
      if (!(await this.isDeptSide(u, r))) throw new ForbiddenException('დადასტურება — განმცხადებელი / განყოფილება');
      await this.closeChecks(trx, r);
      await trx.updateTable('bme_repairs').set({ status: 'closed', closed_at: sql`now()`, closed_by: u.id, close_kind: 'confirmed', close_note: note?.trim() || null, updated_at: sql`now()` }).where('id', '=', id).execute();
      await repEvent(trx, id, 'confirmed', { note: note ?? null }, u.id);
      await devEvent(trx, r.device_id, 'repair_closed', { repair_id: id, repair_no: r.repair_no, kind: 'confirmed' }, u.id);
      await this.audit.log(ctx, { action: 'CONFIRM_BME_REPAIR', entityName: 'bme_repairs', entityId: id, newData: { note } }, trx);
      eng = r.done_by; label = `${r.repair_no} · ${r.inv_no} ${r.device_name}`;
    });
    if (eng && eng !== u.id) await this.notifications.notify(eng, { kind: 'bme_repair', title: `${label}: განყოფილებამ დაადასტურა`, link: `/bme?tab=repairs&repair=${id}`, entityId: id });
    return this.get(id, u);
  }
  private async closeChecks(trx: Trx, r: { id: string; hold: boolean; post_check_required: boolean; post_check_work_id: string | null }) {
    if (r.hold) throw new ConflictException({ code: 'BME_HOLD', message: 'აპარატი შენახულია გამოძიებისთვის' });
    if (r.post_check_required) {
      const w = r.post_check_work_id ? await trx.selectFrom('bme_works').select(['status', 'result']).where('id', '=', r.post_check_work_id).executeTakeFirst() : null;
      if (!(w?.status === 'done' && (w.result === 'pass' || w.result === 'conditional'))) throw new ConflictException({ code: 'POST_CHECK_PENDING', message: 'ჯერ — შემოწმება შეკეთების შემდეგ (სამუშაო)' });
    }
  }

  /** ინჟინრის დახურვა: engineer რეჟიმი (შემოწმების შემდეგ) ან admin */
  async close(id: string, note: string | undefined, u: AuthUser, ctx: AuditContext) {
    this.full(u);
    const s = await this.settings();
    if (s.rep_close_mode !== 'engineer' && !has(u, 'admin')) throw new ForbiddenException('დახურვა — განყოფილების დადასტურებით (პარამეტრი); ინჟინერს — მხოლოდ admin');
    await this.db.transaction().execute(async (trx) => {
      const r = await this.lock(trx, id);
      if (r.status !== 'done') throw new ConflictException('დასახურად — მხოლოდ შესრულებული ორდერი');
      await this.closeChecks(trx, r);
      await trx.updateTable('bme_repairs').set({ status: 'closed', closed_at: sql`now()`, closed_by: u.id, close_kind: 'engineer', close_note: note?.trim() || null, updated_at: sql`now()` }).where('id', '=', id).execute();
      await repEvent(trx, id, 'closed', { kind: 'engineer', note: note ?? null }, u.id);
      await devEvent(trx, r.device_id, 'repair_closed', { repair_id: id, repair_no: r.repair_no, kind: 'engineer' }, u.id);
      await this.audit.log(ctx, { action: 'CLOSE_BME_REPAIR', entityName: 'bme_repairs', entityId: id, newData: { note } }, trx);
    });
    return this.get(id, u);
  }

  /** ხელახლა გახსნა (განყოფილება / ინჟინერი), მიზეზით: იგივე ორდერი, reopen_count + 1; not_working → „გაუმართავი“ (პარამეტრი) */
  async reopen(id: string, dto: ReopenDto, u: AuthUser, ctx: AuditContext) {
    const s = await this.settings();
    let title = '';
    await this.db.transaction().execute(async (trx) => {
      const r = await this.lock(trx, id);
      if (!['done', 'closed'].includes(r.status)) throw new ConflictException('ხელახლა იხსნება მხოლოდ შესრულებული / დახურული ორდერი');
      if (!(await this.isDeptSide(u, r)) && !has(u, ...BME_FULL)) throw new ForbiddenException('ხელახლა გახსნა — განმცხადებელი / განყოფილება / ინჟინერი');
      if (r.status === 'closed' && r.closed_at && Date.now() - new Date(r.closed_at).getTime() > 30 * 864e5) throw new ConflictException('30 დღეზე ძველი დახურული ორდერი — შექმენით ახალი მოთხოვნა');
      await trx.updateTable('bme_repairs').set({ status: 'in_progress', reopen_count: r.reopen_count + 1, done_at: null, done_by: null, outcome: null, suggested_status: null, status_applied: false,
        closed_at: null, closed_by: null, close_kind: null, close_note: null, post_check_required: false, sla_warned_at: null, sla_breach_notified_at: null, updated_at: sql`now()` }).where('id', '=', id).execute();
      await repEvent(trx, id, 'reopened', { reason: dto.reason.trim(), not_working: !!dto.not_working, count: r.reopen_count + 1 }, u.id);
      if (dto.not_working && s.rep_sets_down && ['operational', 'restricted', 'standby'].includes(r.device_status)) await setDeviceStatus(trx, r.device_id, 'down', `${r.repair_no} (ხელახლა): ${dto.reason.trim().slice(0, 150)}`, u.id, id);
      await this.audit.log(ctx, { action: 'REOPEN_BME_REPAIR', entityName: 'bme_repairs', entityId: id, newData: dto }, trx);
      title = `ხელახლა გაიხსნა ${r.repair_no} · ${r.inv_no} ${r.device_name}`;
    });
    await this.toEngineers({ kind: 'bme_repair_new', title, body: dto.reason.trim(), link: `/bme?tab=repairs&repair=${id}`, entityId: id }, u.id);
    return this.get(id, u);
  }

  // ---------------------------------------------------------------- ინციდენტი / მტკიცებულების შენახვა
  async hold(id: string, dto: HoldDto, u: AuthUser, ctx: AuditContext) {
    await this.settings();
    if (dto.on && !has(u, ...QUALITY, ...BME_FULL)) throw new ForbiddenException('შენახვა გამოძიებისთვის — ხარისხის მენეჯერი / ინჟინერი');
    if (!dto.on && !has(u, ...QUALITY, 'admin')) throw new ForbiddenException('შენახვის მოხსნა — ხარისხის მენეჯერი');
    let dep: string | null = null; let label = ''; let devId = '';
    await this.db.transaction().execute(async (trx) => {
      const r = await this.lock(trx, id);
      if (!REP_ACTIVE.includes(r.status as RepStatus)) throw new ConflictException('ორდერი დახურულია');
      if (dto.on === r.hold) throw new ConflictException(r.hold ? 'უკვე შენახულია' : 'შენახული არ არის');
      if (dto.on && (!dto.note || dto.note.trim().length < 3)) throw new BadRequestException('მიზეზი სავალდებულოა');
      await trx.updateTable('bme_repairs').set(dto.on ? { hold: true, hold_by: u.id, hold_at: sql`now()`, hold_note: dto.note!.trim(), hold_released_by: null, hold_released_at: null, updated_at: sql`now()` }
        : { hold: false, hold_released_by: u.id, hold_released_at: sql`now()`, updated_at: sql`now()` }).where('id', '=', id).execute();
      if (dto.on && r.device_status !== 'down') await setDeviceStatus(trx, r.device_id, 'down', `${r.repair_no}: შენახულია გამოძიებისთვის`, u.id, id);
      await repEvent(trx, id, dto.on ? 'hold' : 'hold_released', { note: dto.note ?? null }, u.id);
      await this.audit.log(ctx, { action: dto.on ? 'HOLD_BME_REPAIR' : 'RELEASE_BME_REPAIR', entityName: 'bme_repairs', entityId: id, newData: dto }, trx);
      dep = r.department_id; label = `${r.repair_no} · ${r.inv_no} ${r.device_name}`; devId = r.device_id;
    });
    const n = { kind: 'bme_repair_hold', title: `${label}: ${dto.on ? 'შენახულია გამოძიებისთვის — არ გამოიყენოთ, არ შეაკეთოთ' : 'შენახვა მოიხსნა'}`, body: dto.note ?? undefined, link: `/bme?tab=repairs&repair=${id}`, entityId: id, urgent: dto.on };
    await this.toEngineers(n, u.id);
    await this.notifyDept(dep, { ...n, link: `/bme?device=${devId}` }, u.id);
    return this.get(id, u);
  }

  async linkIncident(id: string, incidentId: string | null, u: AuthUser, ctx: AuditContext) {
    if (!has(u, ...QUALITY, ...BME_FULL)) throw new ForbiddenException('ინციდენტის ბმა — ხარისხის მენეჯერი / ინჟინერი');
    await this.settings();
    await this.db.transaction().execute(async (trx) => {
      const r = await this.lock(trx, id);
      if (incidentId) {
        const i = await trx.selectFrom('qm_incidents').select(['id', 'inc_no', 'source_type', 'source_id']).where('id', '=', incidentId).executeTakeFirst();
        if (!i || i.source_type !== 'bme_device' || i.source_id !== r.device_id) throw new BadRequestException('ინციდენტი ამ აპარატზე არ არის მიბმული (წყარო — ბიომედ-აპარატი)');
        await repEvent(trx, id, 'incident', { incident_id: i.id, inc_no: i.inc_no }, u.id);
      } else await repEvent(trx, id, 'incident', { incident_id: null }, u.id);
      await trx.updateTable('bme_repairs').set({ incident_id: incidentId, updated_at: sql`now()` }).where('id', '=', id).execute();
      await this.audit.log(ctx, { action: 'BME_REPAIR_INCIDENT', entityName: 'bme_repairs', entityId: id, newData: { incident_id: incidentId } }, trx);
    });
    return this.get(id, u);
  }

  // ---------------------------------------------------------------- ფაილი (სერვისის აქტი / ფოტო)
  async upload(id: string, file: Express.Multer.File | undefined, dto: { kind?: string; title?: string }, u: AuthUser, ctx: AuditContext) {
    await this.settings();
    if (!file) throw new BadRequestException('ფაილი არ არის (ველი "file")');
    const r = await this.lockless(id);
    if (!has(u, ...BME_FULL) && !(r.reported_by === u.id && r.status === 'requested')) throw new ForbiddenException('ფაილი — ინჟინერი (ან განმცხადებელი ტრიაჟამდე)');
    const kind = dto.kind ?? 'act';
    if (!['act', 'photo', 'other'].includes(kind)) throw new BadRequestException('სახეობა: act / photo / other');
    const mime = sniffMime(file.buffer);
    if (!mime) throw new BadRequestException({ code: 'FILE_TYPE', message: 'დაშვებულია მხოლოდ PDF, JPG ან PNG' });
    const fid = randomUUID(); const ext = mime === 'application/pdf' ? 'pdf' : mime === 'image/png' ? 'png' : 'jpg';
    const key = `bme/${r.device_id}/${fid}.${ext}`;
    await this.storage.put(key, file.buffer, mime);
    const name = Buffer.from(file.originalname ?? '', 'latin1').toString('utf8').slice(0, 200) || null;
    const title = (dto.title?.trim() || `${kind === 'act' ? 'სერვისის აქტი' : kind === 'photo' ? 'ფოტო' : 'ფაილი'} ${r.repair_no}`).slice(0, 200);
    await this.db.transaction().execute(async (trx) => {
      await trx.insertInto('bme_documents').values({ id: fid, device_id: r.device_id, repair_id: id, kind, title, valid_until: null, file_path: key, mime_type: mime, size_bytes: file.buffer.length,
        sha256: createHash('sha256').update(file.buffer).digest('hex'), original_name: name, uploaded_by: u.id }).execute();
      await repEvent(trx, id, 'file', { kind, title }, u.id);
      await devEvent(trx, r.device_id, 'document', { kind, title, repair_no: r.repair_no, count: 1 }, u.id);
      await this.audit.log(ctx, { action: 'BME_REPAIR_FILE', entityName: 'bme_repairs', entityId: id, newData: { kind, file: fid } }, trx);
    });
    return this.get(id, u);
  }

  /** PM სამუშაო (0074) „ვერ გაიარა“ / „პირობითად“ → ორდერი (ღილაკით) */
  async fromWork(workId: string, u: AuthUser, ctx: AuditContext) {
    this.full(u);
    const s = await this.settings();
    const id = await this.db.transaction().execute(async (trx) => {
      const r = await this.pm.repairFromWork(trx, s, workId, u, true);
      await this.audit.log(ctx, { action: 'CREATE_BME_REPAIR', entityName: 'bme_repairs', entityId: r.id, newData: { pm_work_id: workId, repair_no: r.repair_no } }, trx);
      return r.id;
    });
    return this.get(id, u);
  }
}

// ======================================================================= DTO
class CodeDto {
  @IsOptional() @IsIn(['cause', 'action']) kind?: 'cause' | 'action'; @IsOptional() @IsString() @Length(2, 30) code?: string; @IsOptional() @IsString() @Length(2, 200) name?: string;
  @IsOptional() @IsBoolean() is_active?: boolean; @IsOptional() @IsInt() sort_order?: number;
}
class RequestDto {
  @IsUUID() device_id: string; @IsIn(CONDITIONS) condition: Condition; @IsOptional() @IsIn(URGENCIES) urgency?: Urgency; @IsString() @Length(5, 2000) description: string;
  @IsOptional() @IsBoolean() patient_involved?: boolean; @IsOptional() @IsString() @MaxLength(40) contact_phone?: string | null; @IsOptional() @IsBoolean() force?: boolean;
  @IsOptional() @IsBoolean() as_engineer?: boolean;
}
class PerformerDto {
  @IsOptional() @IsIn(['internal', 'external']) performer_kind?: 'internal' | 'external'; @IsOptional() @IsUUID() assignee_id?: string | null;
  @IsOptional() @IsUUID() supplier_id?: string | null; @IsOptional() @IsString() @MaxLength(200) external_person?: string | null;
}
class TriageDto extends PerformerDto {
  @IsOptional() @IsInt() @Min(1) @Max(4) priority?: number; @IsOptional() @IsString() @MaxLength(1000) triage_note?: string | null; @IsOptional() @IsBoolean() use_coverage?: boolean;
  @IsOptional() @IsBoolean() vendor_called?: boolean; @IsOptional() @IsString() @MaxLength(60) vendor_ref?: string | null;
  @IsOptional() @IsIn(['down', 'restricted', 'operational']) device_status?: 'down' | 'restricted' | 'operational';
  @IsOptional() @IsUUID() loaner_device_id?: string | null; @IsOptional() @IsString() @MaxLength(200) loaner_text?: string | null;
}
class RejectDto { @IsIn(REJECT_REASONS) reason: (typeof REJECT_REASONS)[number]; @IsOptional() @IsString() @MaxLength(1000) note?: string | null; @IsOptional() @IsUUID() duplicate_of?: string }
class ActDto {
  @IsIn(['start', 'vendor_called', 'vendor_arrived', 'wait_parts', 'wait_vendor', 'resume']) action: 'start' | 'vendor_called' | 'vendor_arrived' | 'wait_parts' | 'wait_vendor' | 'resume';
  @IsOptional() @IsString() @MaxLength(500) note?: string | null; @IsOptional() @IsString() @MaxLength(60) vendor_ref?: string | null;
}
class PartLine { @IsUUID() item_id: string; @IsNumber() @Min(0.001) @Max(1e6) qty: number }
class PartsDto { @IsOptional() @IsUUID() location_id?: string; @IsArray() @ArrayMinSize(1) @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => PartLine) lines: PartLine[] }
class PrLine {
  @IsOptional() @IsUUID() item_id?: string; @IsOptional() @IsString() @MaxLength(200) free_name?: string; @IsNumber() @Min(0.001) @Max(1e6) qty: number;
  @IsOptional() @IsNumber() @Min(0) est_price?: number | null; @IsOptional() @IsUUID() supplier_id?: string | null;
}
class PurchaseDto {
  @IsOptional() @IsUUID() location_id?: string; @IsOptional() @IsISO8601({ strict: true }) needed_by?: string | null; @IsOptional() @IsString() @MaxLength(500) notes?: string | null;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => PrLine) lines: PrLine[];
}
class CompleteDto {
  @IsIn(OUTCOMES) outcome: Outcome; @IsString() @Length(3, 2000) resolution: string; @IsOptional() @IsUUID() cause_id?: string | null; @IsOptional() @IsUUID() action_id?: string | null;
  @IsOptional() @IsNumber() @Min(0) @Max(2000) labor_hours?: number | null; @IsOptional() @IsNumber() @Min(0) @Max(1e8) external_cost?: number | null;
  @IsOptional() @IsString() @MaxLength(60) invoice_no?: string | null; @IsOptional() @IsUUID() ap_invoice_id?: string | null; @IsOptional() @IsUUID() post_check_kind_id?: string | null;
  @IsOptional() @IsISO8601() done_at?: string;
}
class NoteDto { @IsString() @Length(2, 2000) text: string }
class OptNoteDto { @IsOptional() @IsString() @MaxLength(1000) note?: string }
class ReopenDto { @IsString() @Length(3, 1000) reason: string; @IsOptional() @IsBoolean() not_working?: boolean }
class HoldDto { @IsBoolean() on: boolean; @IsOptional() @IsString() @MaxLength(1000) note?: string }
class IncidentDto { @IsOptional() @IsUUID() incident_id?: string | null }
interface ListQ { view?: string; device_id?: string; department_id?: string; priority?: string; search?: string }
const uuidOk = (v?: string) => !v || /^[0-9a-f-]{36}$/i.test(v);

/** შეკეთების ორდერები (0075) */
class RunDto {
  @IsOptional() @IsISO8601() at?: string; @IsOptional() @IsArray() @ArrayMaxSize(200) @IsUUID('all', { each: true }) repair_ids?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsUUID('all', { each: true }) contract_ids?: string[]; @IsOptional() @IsArray() @ArrayMaxSize(200) @IsUUID('all', { each: true }) device_ids?: string[];
}

@Controller('bme')
export class RepairController {
  constructor(private readonly s: RepairService, private readonly jobs: BmeRepairJobsService) {}
  /** SLA / ავტომატური დახურვა / ვადის შეხსენებები — ხელით (admin; worker-ი ყოველ 15 წუთში); at — „ახლა“-ს ჩანაცვლება (ტესტი) */
  @Post('repairs/run-jobs') @HttpCode(200) @Roles('admin') run(@Body() d: RunDto) { return this.jobs.tick(d ?? {}); }
  @Get('repairs/refs') refs() { return this.s.refs(); }
  @Get('repairs/counts') counts(@CurrentUser() u: AuthUser) { return this.s.counts(u); }
  @Get('repairs/stock-items') @Roles(...BME_FULL) stockItems(@Query('location_id') loc?: string, @Query('search') search?: string) {
    if (!uuidOk(loc)) throw new BadRequestException('არასწორი id');
    return this.s.stockItems(loc || undefined, search);
  }
  @Post('repair-codes') @Roles(...BME_FULL) code(@Body() d: CodeDto, @Req() r: Request) {
    if (!d.kind || !d.code || !/^[A-Z][A-Z0-9_]{1,29}$/.test(d.code) || !d.name) throw new BadRequestException('სახე, კოდი (A-Z0-9_) და დასახელება სავალდებულოა');
    return this.s.saveCode(null, d, auditCtx(r));
  }
  @Patch('repair-codes/:id') @Roles(...BME_FULL) codeU(@Param('id', ParseUUIDPipe) id: string, @Body() d: CodeDto, @Req() r: Request) {
    if (d.kind !== undefined || d.code !== undefined) throw new BadRequestException('სახე / კოდი არ იცვლება');
    return this.s.saveCode(id, d, auditCtx(r));
  }
  @Get('repairs') list(@CurrentUser() u: AuthUser, @Query() q: ListQ) {
    if (!uuidOk(q.device_id) || !uuidOk(q.department_id)) throw new BadRequestException('არასწორი id');
    return this.s.list(u, q);
  }
  @Post('repairs') request(@Body() d: RequestDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.request(d, u, auditCtx(r)); }
  @Get('repairs/:id') one(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser) { return this.s.get(id, u); }
  @Get('devices/:id/repairs') device(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser) { return this.s.device(id, u); }
  @Post('works/:id/repair') @Roles(...BME_FULL) fromWork(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.fromWork(id, u, auditCtx(r)); }
  @Post('repairs/:id/triage') @HttpCode(200) @Roles(...BME_FULL) triage(@Param('id', ParseUUIDPipe) id: string, @Body() d: TriageDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.triage(id, d, u, auditCtx(r)); }
  @Post('repairs/:id/reject') @HttpCode(200) @Roles(...BME_FULL) reject(@Param('id', ParseUUIDPipe) id: string, @Body() d: RejectDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.reject(id, d, u, auditCtx(r)); }
  @Post('repairs/:id/act') @HttpCode(200) @Roles(...BME_FULL) act(@Param('id', ParseUUIDPipe) id: string, @Body() d: ActDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.act(id, d, u, auditCtx(r)); }
  @Post('repairs/:id/parts') @HttpCode(200) @Roles(...BME_FULL) parts(@Param('id', ParseUUIDPipe) id: string, @Body() d: PartsDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.parts(id, d, u, auditCtx(r)); }
  @Post('repairs/:id/purchase') @HttpCode(200) @Roles(...BME_FULL) purchase(@Param('id', ParseUUIDPipe) id: string, @Body() d: PurchaseDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.purchase(id, d, u, auditCtx(r)); }
  @Post('repairs/:id/complete') @HttpCode(200) @Roles(...BME_FULL) complete(@Param('id', ParseUUIDPipe) id: string, @Body() d: CompleteDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.complete(id, d, u, auditCtx(r)); }
  @Post('repairs/:id/apply-status') @HttpCode(200) @Roles(...BME_FULL) apply(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.applyStatus(id, u, auditCtx(r)); }
  @Post('repairs/:id/confirm') @HttpCode(200) confirm(@Param('id', ParseUUIDPipe) id: string, @Body() d: OptNoteDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.confirm(id, d?.note, u, auditCtx(r)); }
  @Post('repairs/:id/close') @HttpCode(200) @Roles(...BME_FULL) close(@Param('id', ParseUUIDPipe) id: string, @Body() d: OptNoteDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.close(id, d?.note, u, auditCtx(r)); }
  @Post('repairs/:id/reopen') @HttpCode(200) reopen(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReopenDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.reopen(id, d, u, auditCtx(r)); }
  @Post('repairs/:id/note') @HttpCode(200) note(@Param('id', ParseUUIDPipe) id: string, @Body() d: NoteDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.note(id, d.text, u, auditCtx(r)); }
  @Post('repairs/:id/hold') @HttpCode(200) hold(@Param('id', ParseUUIDPipe) id: string, @Body() d: HoldDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.hold(id, d, u, auditCtx(r)); }
  @Post('repairs/:id/incident') @HttpCode(200) incident(@Param('id', ParseUUIDPipe) id: string, @Body() d: IncidentDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.linkIncident(id, d.incident_id ?? null, u, auditCtx(r)); }
  @Post('repairs/:id/files') @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } }))
  file(@Param('id', ParseUUIDPipe) id: string, @UploadedFile() f: Express.Multer.File | undefined, @Body() b: { kind?: string; title?: string }, @CurrentUser() u: AuthUser, @Req() r: Request) {
    return this.s.upload(id, f, b ?? {}, u, auditCtx(r));
  }
}
