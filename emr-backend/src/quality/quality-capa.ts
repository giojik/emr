import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res,
  StreamableFile, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsISO8601, IsOptional, IsString, IsUUID, Length, MaxLength } from 'class-validator';
import type { Request, Response } from 'express';
import { sql } from 'kysely';
import { memoryStorage } from 'multer';
import { createHash, randomUUID } from 'node:crypto';
import { auditCtx } from '../audit/audit-context';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser } from '../auth/roles';
import { sniffMime } from '../patient-files/patient-files';
import { StorageService } from '../storage/storage.service';
import { CAPA_STATUS_KA, QM_FULL, QmCommon, type Ex, type Trx, userName } from './quality-common';
import { QmIncidentsService } from './quality-incidents';

const LINKABLE = ['investigation', 'analysis', 'capa'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

class CapaDto {
  @IsString() @Length(5, 300) title: string;
  @IsOptional() @IsString() @MaxLength(4000) description?: string | null;
  @IsIn(['corrective', 'preventive']) kind: 'corrective' | 'preventive';
  @IsUUID() owner_id: string;
  @IsOptional() @IsUUID() department_id?: string | null;
  @IsISO8601() due_date: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @IsUUID('all', { each: true }) incident_ids: string[];
  @IsOptional() @IsUUID() follow_up_of?: string;
}
class CapaPatchDto {
  @IsOptional() @IsString() @Length(5, 300) title?: string;
  @IsOptional() @IsString() @MaxLength(4000) description?: string | null;
  @IsOptional() @IsIn(['corrective', 'preventive']) kind?: 'corrective' | 'preventive';
  @IsOptional() @IsUUID() owner_id?: string;
  @IsOptional() @IsUUID() department_id?: string | null;
  @IsOptional() @IsISO8601() due_date?: string;
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @IsUUID('all', { each: true }) incident_ids?: string[];
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
class NoteDto { @IsString() @Length(3, 4000) note: string }
class ReasonDto { @IsString() @Length(3, 1000) reason: string }
class DueReqDto { @IsISO8601() new_due: string; @IsString() @Length(3, 1000) reason: string }
class DecideDto { @IsBoolean() approve: boolean; @IsOptional() @IsString() @MaxLength(1000) note?: string }
class EffDto { @IsIn(['effective', 'ineffective']) result: 'effective' | 'ineffective'; @IsString() @Length(3, 2000) note: string }
interface ListQ { status?: string; overdue?: string; owner_id?: string; department_id?: string; incident_id?: string; search?: string; effectiveness?: string }

/**
 * CAPA (0065): ქმედება → პასუხისმგებელი (იწყებს / ასრულებს მტკიცებულებით / ითხოვს ვადის შეცვლას) → ეფექტიანობის შემოწმება.
 * ერთი CAPA შეიძლება რამდენიმე ინციდენტს ეხებოდეს. ქმნის ხარისხის მენეჯერი ან მიბმული ინციდენტ(ებ)ის გამომძიებელი.
 * პასუხისმგებელი ხედავს მხოლოდ თავის CAPA-ს და ინციდენტის მოკლე შეჯამებას (№, კატეგორია, განყოფილება, ძირეული მიზეზი) — პაციენტისა და ავტორის გარეშე.
 */
@Injectable()
export class QmCapaService {
  constructor(private readonly c: QmCommon, private readonly inc: QmIncidentsService, private readonly audit: AuditService, private readonly storage: StorageService) {}
  private get db() { return this.c.db; }

  private ev(trx: Trx, id: string, u: AuthUser | null, kind: string, text?: string | null, data?: unknown) {
    return trx.insertInto('qm_capa_events').values({ capa_id: id, user_id: u?.id ?? null, kind, text: text ?? null, data: data === undefined ? null : JSON.stringify(data) }).execute();
  }
  private async lock(trx: Trx, id: string) {
    const x = await trx.selectFrom('qm_capas').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!x) throw new NotFoundException('ქმედება ვერ მოიძებნა');
    return x;
  }

  /** ინციდენტები: არსებობს, ღიაა; ხარისხის მენეჯერი — ნებისმიერი; სხვა — მხოლოდ თავისი (გამომძიებელი) */
  private async checkIncidents(trx: Trx, ids: string[], u: AuthUser) {
    const rows = await trx.selectFrom('qm_incidents').select(['id', 'status', 'investigator_id', 'inc_no']).where('id', 'in', ids).execute();
    if (rows.length !== new Set(ids).size) throw new BadRequestException({ code: 'INCIDENT', message: 'ინციდენტი ვერ მოიძებნა' });
    const bad = rows.filter((r) => !LINKABLE.includes(r.status));
    if (bad.length) throw new ConflictException({ code: 'INCIDENT_NOT_OPEN', message: `ქმედება ებმება მხოლოდ მიღებულ, დაუხურავ ინციდენტს: ${bad.map((b) => b.inc_no).join(', ')}` });
    if (!has(u, ...QM_FULL) && rows.some((r) => r.investigator_id !== u.id)) throw new ForbiddenException('ქმედებას ქმნის ხარისხის მენეჯერი ან ინციდენტის გამომძიებელი');
    return rows;
  }
  private async dept(id: string | null | undefined, ex: Ex) {
    if (!id) return;
    const d = await ex.selectFrom('departments').select('is_active').where('id', '=', id).executeTakeFirst();
    if (!d?.is_active) throw new BadRequestException({ code: 'DEPARTMENT', message: 'განყოფილება ვერ მოიძებნა ან გათიშულია' });
  }
  private due(v: string) {
    const d = v.slice(0, 10);
    if (!DATE.test(d)) throw new BadRequestException({ code: 'DUE_DATE', message: 'ვადა — თარიღი' });
    return d;
  }
  private async notFuture(d: string, ex: Ex) {
    const r = await sql<{ ok: boolean }>`SELECT ${d}::date >= (now() AT TIME ZONE current_setting('TimeZone'))::date AS ok`.execute(ex);
    if (!r.rows[0].ok) throw new BadRequestException({ code: 'DUE_DATE', message: 'ვადა წარსულში ვერ იქნება' });
  }

  // ---------------------------------------------------------------- წვდომა
  /** full — ხარისხის მენეჯერი; inv — მიბმული ინციდენტის გამომძიებელი / გუნდი; owner — პასუხისმგებელი */
  private async access(u: AuthUser, capa: { id: string; owner_id: string }, ex: Ex = this.db): Promise<'full' | 'inv' | 'owner' | null> {
    if (has(u, ...QM_FULL)) return 'full';
    const inv = await sql<{ n: number }>`SELECT count(*)::int AS n FROM qm_capa_incidents ci JOIN qm_incidents i ON i.id = ci.incident_id
      WHERE ci.capa_id = ${capa.id} AND (i.investigator_id = ${u.id} OR EXISTS (SELECT 1 FROM qm_analysis_team t WHERE t.incident_id = i.id AND t.user_id = ${u.id}))`.execute(ex);
    if (inv.rows[0].n > 0) return 'inv';
    if (capa.owner_id === u.id) return 'owner';
    return null;
  }

  // ---------------------------------------------------------------- სია / ნახვა
  async list(u: AuthUser, q: ListQ) {
    await this.c.rules();
    let x = this.db.selectFrom('qm_capas as c').innerJoin('users as uo', 'uo.id', 'c.owner_id').leftJoin('departments as d', 'd.id', 'c.department_id')
      .select(['c.id', 'c.capa_no', 'c.title', 'c.kind', 'c.status', 'c.due_date', 'c.done_at', 'c.effectiveness_due', 'c.effectiveness_result', 'c.owner_id', userName('uo').as('owner_name'),
        'c.department_id', 'd.name as department_name', 'c.created_at',
        sql<boolean>`c.status IN ('open', 'in_progress') AND c.due_date < (now() AT TIME ZONE current_setting('TimeZone'))::date`.as('overdue'),
        sql<boolean>`c.status = 'done' AND c.effectiveness_result IS NULL AND c.effectiveness_due IS NOT NULL AND c.effectiveness_due <= (now() AT TIME ZONE current_setting('TimeZone'))::date`.as('effectiveness_pending'),
        sql<boolean>`EXISTS (SELECT 1 FROM qm_capa_due_requests r WHERE r.capa_id = c.id AND r.status = 'pending')`.as('due_request_pending'),
        sql<string>`(SELECT string_agg(i.inc_no, ', ' ORDER BY i.inc_no) FROM qm_capa_incidents ci JOIN qm_incidents i ON i.id = ci.incident_id WHERE ci.capa_id = c.id)`.as('incidents')])
      .orderBy(sql`c.status IN ('done', 'cancelled')`).orderBy('c.due_date').limit(1000);
    if (!has(u, ...QM_FULL)) x = x.where('c.owner_id', '=', u.id);
    if (q.status) x = x.where('c.status', 'in', q.status.split(','));
    if (q.owner_id) x = x.where('c.owner_id', '=', q.owner_id);
    if (q.department_id) x = x.where('c.department_id', '=', q.department_id);
    if (q.incident_id) x = x.where(sql<boolean>`EXISTS (SELECT 1 FROM qm_capa_incidents ci WHERE ci.capa_id = c.id AND ci.incident_id = ${q.incident_id})`, '=', true);
    if (q.overdue === '1') x = x.where('c.status', 'in', ['open', 'in_progress']).where('c.due_date', '<', sql<string>`(now() AT TIME ZONE current_setting('TimeZone'))::date`);
    if (q.effectiveness === '1') x = x.where('c.status', '=', 'done').where('c.effectiveness_result', 'is', null).where('c.effectiveness_due', 'is not', null);
    const s = q.search?.trim();
    if (s) x = x.where((eb) => eb.or([eb('c.capa_no', 'ilike', `%${s}%`), eb('c.title', 'ilike', `%${s}%`)]));
    return (await x.execute()).map((r) => ({ ...r, status_label: CAPA_STATUS_KA[r.status] }));
  }

  async get(id: string, u: AuthUser) {
    await this.c.rules();
    const c = await this.db.selectFrom('qm_capas as c').innerJoin('users as uo', 'uo.id', 'c.owner_id').leftJoin('departments as d', 'd.id', 'c.department_id')
      .leftJoin('users as ucr', 'ucr.id', 'c.created_by').leftJoin('users as udn', 'udn.id', 'c.done_by').leftJoin('users as uef', 'uef.id', 'c.effectiveness_by')
      .leftJoin('qm_capas as fu', 'fu.id', 'c.follow_up_of')
      .selectAll('c').select([userName('uo').as('owner_name'), 'd.name as department_name', userName('ucr').as('created_by_name'), userName('udn').as('done_by_name'),
        userName('uef').as('effectiveness_by_name'), 'fu.capa_no as follow_up_of_no',
        sql<boolean>`c.status IN ('open', 'in_progress') AND c.due_date < (now() AT TIME ZONE current_setting('TimeZone'))::date`.as('overdue')])
      .where('c.id', '=', id).executeTakeFirst();
    if (!c) throw new NotFoundException('ქმედება ვერ მოიძებნა');
    const a = await this.access(u, c);
    if (!a) throw new NotFoundException('ქმედება ვერ მოიძებნა');
    // ინციდენტის მოკლე შეჯამება — პაციენტისა და ავტორის გარეშე
    const incidents = await this.db.selectFrom('qm_capa_incidents as ci').innerJoin('qm_incidents as i', 'i.id', 'ci.incident_id')
      .innerJoin('qm_classifiers as k', 'k.id', 'i.category_id').innerJoin('departments as d', 'd.id', 'i.department_id').leftJoin('qm_analyses as an', 'an.incident_id', 'i.id')
      .select(['i.id', 'i.inc_no', 'i.status', 'k.name as category_name', 'd.name as department_name', 'i.occurred_at',
        sql<string | null>`coalesce(an.root_cause, an.root_causes)`.as('root_cause')])
      .where('ci.capa_id', '=', id).orderBy('i.inc_no').execute();
    const files = await this.db.selectFrom('qm_capa_files').select(['id', 'mime_type', 'size_bytes', 'original_name', 'created_at']).where('capa_id', '=', id).orderBy('created_at').execute();
    const events = await this.db.selectFrom('qm_capa_events as e').leftJoin('users as eu', 'eu.id', 'e.user_id')
      .select(['e.id', 'e.at', 'e.kind', 'e.text', 'e.data', userName('eu').as('user_name')]).where('e.capa_id', '=', id).orderBy('e.at').orderBy('e.id').execute();
    const requests = await this.db.selectFrom('qm_capa_due_requests as r').innerJoin('users as ru', 'ru.id', 'r.requested_by').leftJoin('users as rd', 'rd.id', 'r.decided_by')
      .selectAll('r').select([userName('ru').as('requested_by_name'), userName('rd').as('decided_by_name')]).where('r.capa_id', '=', id).orderBy('r.requested_at', 'desc').execute();
    const owner = c.owner_id === u.id; const full = a === 'full'; const openSt = ['open', 'in_progress'].includes(c.status);
    return {
      ...c, status_label: CAPA_STATUS_KA[c.status], access: a, incidents, files, events, requests,
      can: {
        edit: full && openSt, start: (owner || full) && c.status === 'open', complete: (owner || full) && openSt, cancel: full && openSt,
        request_due: owner && openSt && !requests.some((r) => r.status === 'pending'), decide_due: full,
        effectiveness: full && c.status === 'done' && !c.effectiveness_result, upload: (owner || full || a === 'inv') && c.status !== 'cancelled',
      },
    };
  }

  // ---------------------------------------------------------------- შექმნა / შეცვლა
  async create(d: CapaDto, u: AuthUser, req: Request) {
    await this.c.rules();
    const out = await this.db.transaction().execute(async (trx) => {
      const incs = await this.checkIncidents(trx, [...new Set(d.incident_ids)], u);
      await this.inc.activeUser(d.owner_id, trx); await this.dept(d.department_id, trx);
      const due = this.due(d.due_date); await this.notFuture(due, trx);
      if (d.follow_up_of && !(await trx.selectFrom('qm_capas').select('id').where('id', '=', d.follow_up_of).executeTakeFirst())) throw new BadRequestException({ code: 'FOLLOW_UP', message: 'წინა ქმედება ვერ მოიძებნა' });
      const no = await this.c.nextNo(trx, 'CAPA');
      const c = await trx.insertInto('qm_capas').values({ capa_no: no, title: d.title.trim(), description: d.description?.trim() || null, kind: d.kind, owner_id: d.owner_id,
        department_id: d.department_id ?? null, due_date: due, created_by: u.id, follow_up_of: d.follow_up_of ?? null }).returning(['id', 'capa_no']).executeTakeFirstOrThrow();
      await trx.insertInto('qm_capa_incidents').values(incs.map((i) => ({ capa_id: c.id, incident_id: i.id, linked_by: u.id }))).execute();
      await this.ev(trx, c.id, u, 'created', null, { incidents: incs.map((i) => i.inc_no), due });
      for (const i of incs) await trx.insertInto('qm_incident_events').values({ incident_id: i.id, user_id: u.id, kind: 'capa', data: JSON.stringify({ capa_no: no, title: d.title.trim() }) }).execute();
      await this.audit.log(auditCtx(req), { action: 'QM_CAPA_CREATE', entityName: 'qm_capas', entityId: c.id, newData: { ...d, capa_no: no } }, trx);
      return c;
    });
    await this.c.bell([d.owner_id], { kind: 'qm_capa', title: `ქმედება: ${out.capa_no}`, body: `${d.title.trim()} · ვადა ${this.due(d.due_date)}`, link: `/quality/capas/${out.id}`, entityId: out.id });
    return this.get(out.id, u);
  }

  async update(id: string, d: CapaPatchDto, u: AuthUser, req: Request) {
    await this.c.rules();
    if (!has(u, ...QM_FULL)) throw new ForbiddenException('მხოლოდ ხარისხის მენეჯერი');
    const newOwner = await this.db.transaction().execute(async (trx) => {
      const c = await this.lock(trx, id);
      if (!['open', 'in_progress'].includes(c.status)) throw new ConflictException({ code: 'NOT_OPEN', message: 'დასრულებული / გაუქმებული ქმედება არ იცვლება' });
      if (d.owner_id) await this.inc.activeUser(d.owner_id, trx);
      if (d.department_id) await this.dept(d.department_id, trx);
      const due = d.due_date ? this.due(d.due_date) : undefined;
      if (due && due !== String(c.due_date).slice(0, 10)) { await this.notFuture(due, trx); if ((d.reason?.trim().length ?? 0) < 3) throw new BadRequestException({ code: 'REASON_REQUIRED', message: 'ვადის შეცვლა — მიზეზით' }); }
      const v = { ...(d.title !== undefined && { title: d.title.trim() }), ...(d.description !== undefined && { description: d.description?.trim() || null }), ...(d.kind && { kind: d.kind }),
        ...(d.owner_id && { owner_id: d.owner_id }), ...(d.department_id !== undefined && { department_id: d.department_id }),
        ...(due && { due_date: due, warn_sent_at: null, overdue_sent_at: null }) };
      if (Object.keys(v).length) await trx.updateTable('qm_capas').set(v).where('id', '=', id).execute();
      if (d.incident_ids) {
        const incs = await this.checkIncidents(trx, [...new Set(d.incident_ids)], u);
        const before = (await trx.selectFrom('qm_capa_incidents').select('incident_id').where('capa_id', '=', id).execute()).map((x) => x.incident_id);
        await trx.deleteFrom('qm_capa_incidents').where('capa_id', '=', id).where('incident_id', 'not in', incs.map((i) => i.id)).execute();
        const add = incs.filter((i) => !before.includes(i.id));
        if (add.length) await trx.insertInto('qm_capa_incidents').values(add.map((i) => ({ capa_id: id, incident_id: i.id, linked_by: u.id }))).execute();
      }
      await this.ev(trx, id, u, 'updated', d.reason?.trim() || null, { fields: Object.keys(v), incidents: d.incident_ids?.length });
      await this.audit.log(auditCtx(req), { action: 'QM_CAPA_UPDATE', entityName: 'qm_capas', entityId: id, oldData: c, newData: d }, trx);
      return d.owner_id && d.owner_id !== c.owner_id ? { id: d.owner_id, no: c.capa_no } : null;
    });
    if (newOwner) await this.c.bell([newOwner.id], { kind: 'qm_capa', title: `ქმედება: ${newOwner.no}`, body: 'თქვენ დაგენიშნათ პასუხისმგებლად', link: `/quality/capas/${id}`, entityId: id });
    return this.get(id, u);
  }

  // ---------------------------------------------------------------- სტატუსები
  async start(id: string, u: AuthUser, req: Request) {
    await this.c.rules();
    await this.db.transaction().execute(async (trx) => {
      const c = await this.lock(trx, id);
      if (c.owner_id !== u.id && !has(u, ...QM_FULL)) throw new ForbiddenException('მხოლოდ პასუხისმგებელი');
      if (c.status !== 'open') throw new ConflictException({ code: 'NOT_OPEN', message: 'ქმედება უკვე დაწყებულია / დასრულებულია' });
      await trx.updateTable('qm_capas').set({ status: 'in_progress', started_at: sql`now()` }).where('id', '=', id).execute();
      await this.ev(trx, id, u, 'started');
      await this.audit.log(auditCtx(req), { action: 'QM_CAPA_START', entityName: 'qm_capas', entityId: id }, trx);
    });
    return this.get(id, u);
  }

  async complete(id: string, d: NoteDto, files: Express.Multer.File[], u: AuthUser, req: Request) {
    const r = await this.c.rules();
    await this.db.transaction().execute(async (trx) => {
      const c = await this.lock(trx, id);
      if (c.owner_id !== u.id && !has(u, ...QM_FULL)) throw new ForbiddenException('მხოლოდ პასუხისმგებელი');
      if (!['open', 'in_progress'].includes(c.status)) throw new ConflictException({ code: 'NOT_OPEN', message: 'ქმედება უკვე დასრულებულია / გაუქმებულია' });
      const fids = await this.storeFiles(trx, id, files, u);
      await trx.updateTable('qm_capas').set({ status: 'done', done_at: sql`now()`, done_by: u.id, done_note: d.note.trim(), started_at: sql`coalesce(started_at, now())`,
        effectiveness_due: r.capa_effectiveness ? sql`(now() AT TIME ZONE current_setting('TimeZone'))::date + ${r.effectiveness_days}::int` : null }).where('id', '=', id).execute();
      await this.ev(trx, id, u, 'done', d.note.trim(), { files: fids.length });
      await this.audit.log(auditCtx(req), { action: 'QM_CAPA_DONE', entityName: 'qm_capas', entityId: id, newData: { note: d.note, files: fids } }, trx);
    });
    const q = (await this.c.usersWith(QM_FULL)).map((x) => x.id).filter((x) => x !== u.id);
    const c = await this.db.selectFrom('qm_capas').select(['capa_no', 'title']).where('id', '=', id).executeTakeFirstOrThrow();
    await this.c.bell(q, { kind: 'qm_capa_done', title: `ქმედება შესრულდა: ${c.capa_no}`, body: c.title, link: `/quality/capas/${id}`, entityId: id });
    return this.get(id, u);
  }

  async cancel(id: string, d: ReasonDto, u: AuthUser, req: Request) {
    await this.c.rules();
    if (!has(u, ...QM_FULL)) throw new ForbiddenException('მხოლოდ ხარისხის მენეჯერი');
    await this.db.transaction().execute(async (trx) => {
      const c = await this.lock(trx, id);
      if (!['open', 'in_progress'].includes(c.status)) throw new ConflictException({ code: 'NOT_OPEN', message: 'ქმედება უკვე დასრულებულია / გაუქმებულია' });
      await trx.updateTable('qm_capas').set({ status: 'cancelled', cancelled_at: sql`now()`, cancelled_by: u.id, cancel_reason: d.reason.trim() }).where('id', '=', id).execute();
      await trx.updateTable('qm_capa_due_requests').set({ status: 'rejected', decided_by: u.id, decided_at: sql`now()`, decision_note: 'ქმედება გაუქმდა' }).where('capa_id', '=', id).where('status', '=', 'pending').execute();
      await this.ev(trx, id, u, 'cancelled', d.reason.trim());
      await this.audit.log(auditCtx(req), { action: 'QM_CAPA_CANCEL', entityName: 'qm_capas', entityId: id, newData: { reason: d.reason } }, trx);
    });
    return this.get(id, u);
  }

  // ---------------------------------------------------------------- ვადის შეცვლის მოთხოვნა
  async requestDue(id: string, d: DueReqDto, u: AuthUser, req: Request) {
    await this.c.rules();
    const no = await this.db.transaction().execute(async (trx) => {
      const c = await this.lock(trx, id);
      if (c.owner_id !== u.id) throw new ForbiddenException('ვადის შეცვლას ითხოვს პასუხისმგებელი');
      if (!['open', 'in_progress'].includes(c.status)) throw new ConflictException({ code: 'NOT_OPEN', message: 'ქმედება დასრულებულია / გაუქმებულია' });
      const nd = this.due(d.new_due); await this.notFuture(nd, trx);
      if (nd === String(c.due_date).slice(0, 10)) throw new BadRequestException({ code: 'NO_CHANGE', message: 'ვადა იგივეა' });
      const pend = await trx.selectFrom('qm_capa_due_requests').select('id').where('capa_id', '=', id).where('status', '=', 'pending').executeTakeFirst();
      if (pend) throw new ConflictException({ code: 'DUE_REQUEST_PENDING', message: 'მოთხოვნა უკვე განხილვაშია' });
      await trx.insertInto('qm_capa_due_requests').values({ capa_id: id, old_due: c.due_date, new_due: nd, reason: d.reason.trim(), requested_by: u.id }).execute();
      await this.ev(trx, id, u, 'due_requested', d.reason.trim(), { from: c.due_date, to: nd });
      await this.audit.log(auditCtx(req), { action: 'QM_CAPA_DUE_REQUEST', entityName: 'qm_capas', entityId: id, newData: { new_due: nd, reason: d.reason } }, trx);
      return c.capa_no;
    });
    const q = (await this.c.usersWith(QM_FULL)).map((x) => x.id);
    await this.c.bell(q, { kind: 'qm_capa_due', title: `ვადის შეცვლის მოთხოვნა: ${no}`, body: d.reason.trim(), link: `/quality/capas/${id}`, entityId: id });
    return this.get(id, u);
  }

  async decideDue(id: string, rid: string, d: DecideDto, u: AuthUser, req: Request) {
    await this.c.rules();
    if (!has(u, ...QM_FULL)) throw new ForbiddenException('მხოლოდ ხარისხის მენეჯერი');
    const owner = await this.db.transaction().execute(async (trx) => {
      const c = await this.lock(trx, id);
      const r = await trx.selectFrom('qm_capa_due_requests').selectAll().where('id', '=', rid).where('capa_id', '=', id).forUpdate().executeTakeFirst();
      if (!r) throw new NotFoundException('მოთხოვნა ვერ მოიძებნა');
      if (r.status !== 'pending') throw new ConflictException({ code: 'DECIDED', message: 'მოთხოვნა უკვე განხილულია' });
      if (!d.approve && (d.note?.trim().length ?? 0) < 3) throw new BadRequestException({ code: 'NOTE_REQUIRED', message: 'უარის მიზეზი სავალდებულოა' });
      await trx.updateTable('qm_capa_due_requests').set({ status: d.approve ? 'approved' : 'rejected', decided_by: u.id, decided_at: sql`now()`, decision_note: d.note?.trim() || null })
        .where('id', '=', rid).execute();
      if (d.approve) await trx.updateTable('qm_capas').set({ due_date: r.new_due, warn_sent_at: null, overdue_sent_at: null }).where('id', '=', id).execute();
      await this.ev(trx, id, u, d.approve ? 'due_approved' : 'due_rejected', d.note?.trim() || null, { from: r.old_due, to: r.new_due });
      await this.audit.log(auditCtx(req), { action: 'QM_CAPA_DUE_DECIDE', entityName: 'qm_capas', entityId: id, newData: { request: rid, approve: d.approve, note: d.note ?? null } }, trx);
      return { id: c.owner_id, no: c.capa_no };
    });
    await this.c.bell([owner.id], { kind: 'qm_capa_due', title: `ვადის შეცვლა ${d.approve ? 'დამტკიცდა' : 'არ დამტკიცდა'}: ${owner.no}`, body: d.note?.trim() || null, link: `/quality/capas/${id}`, entityId: id });
    return this.get(id, u);
  }

  // ---------------------------------------------------------------- ეფექტიანობა
  async effectiveness(id: string, d: EffDto, u: AuthUser, req: Request) {
    await this.c.rules();
    if (!has(u, ...QM_FULL)) throw new ForbiddenException('მხოლოდ ხარისხის მენეჯერი');
    await this.db.transaction().execute(async (trx) => {
      const c = await this.lock(trx, id);
      if (c.status !== 'done') throw new ConflictException({ code: 'NOT_DONE', message: 'ეფექტიანობა ფასდება შესრულებულ ქმედებაზე' });
      if (c.effectiveness_result) throw new ConflictException({ code: 'DECIDED', message: 'ეფექტიანობა უკვე შეფასებულია' });
      await trx.updateTable('qm_capas').set({ effectiveness_result: d.result, effectiveness_note: d.note.trim(), effectiveness_at: sql`now()`, effectiveness_by: u.id }).where('id', '=', id).execute();
      await this.ev(trx, id, u, 'effectiveness', d.note.trim(), { result: d.result });
      await this.audit.log(auditCtx(req), { action: 'QM_CAPA_EFFECTIVENESS', entityName: 'qm_capas', entityId: id, newData: d }, trx);
    });
    return this.get(id, u);
  }

  // ---------------------------------------------------------------- ფაილები (მტკიცებულება)
  private async storeFiles(trx: Trx, id: string, files: Express.Multer.File[], u: AuthUser) {
    const n = (await trx.selectFrom('qm_capa_files').select(sql<number>`count(*)::int`.as('n')).where('capa_id', '=', id).executeTakeFirstOrThrow()).n;
    if (n + files.length > 20) throw new BadRequestException({ code: 'FILES', message: 'ქმედებაზე მაქსიმუმ 20 ფაილი' });
    const out: string[] = [];
    for (const f of files) {
      const mime = sniffMime(f.buffer);
      if (!mime) throw new BadRequestException({ code: 'FILE_TYPE', message: `${f.originalname}: დაშვებულია მხოლოდ JPG, PNG ან PDF` });
      const fid = randomUUID(); const ext = mime === 'application/pdf' ? 'pdf' : mime === 'image/png' ? 'png' : 'jpg';
      const key = `qm/capa/${id}/${fid}.${ext}`;
      await this.storage.put(key, f.buffer, mime);
      await trx.insertInto('qm_capa_files').values({ id: fid, capa_id: id, file_path: key, mime_type: mime, size_bytes: f.buffer.length,
        sha256: createHash('sha256').update(f.buffer).digest('hex'), original_name: f.originalname?.slice(0, 200) ?? null, uploaded_by: u.id }).execute();
      out.push(fid);
    }
    return out;
  }
  async upload(id: string, files: Express.Multer.File[], u: AuthUser, req: Request) {
    await this.c.rules();
    if (!files.length) throw new BadRequestException('ფაილი არ არის (ველი "files")');
    const ids = await this.db.transaction().execute(async (trx) => {
      const c = await this.lock(trx, id);
      if (!(await this.access(u, c, trx))) throw new NotFoundException('ქმედება ვერ მოიძებნა');
      if (c.status === 'cancelled') throw new ConflictException({ code: 'CANCELLED', message: 'გაუქმებულ ქმედებაზე ფაილი არ ემატება' });
      const out = await this.storeFiles(trx, id, files, u);
      await this.ev(trx, id, u, 'files', null, { count: out.length });
      await this.audit.log(auditCtx(req), { action: 'QM_CAPA_FILE_UPLOAD', entityName: 'qm_capas', entityId: id, newData: { files: out } }, trx);
      return out;
    });
    return { files: ids };
  }
  async file(id: string, fid: string, u: AuthUser, req: Request) {
    await this.c.rules();
    const c = await this.db.selectFrom('qm_capas').select(['id', 'owner_id']).where('id', '=', id).executeTakeFirst();
    if (!c || !(await this.access(u, c))) throw new NotFoundException('ქმედება ვერ მოიძებნა');
    const f = await this.db.selectFrom('qm_capa_files').select(['file_path', 'mime_type']).where('id', '=', fid).where('capa_id', '=', id).executeTakeFirst();
    if (!f) throw new NotFoundException('ფაილი ვერ მოიძებნა');
    await this.audit.log(auditCtx(req), { action: 'QM_CAPA_FILE_VIEW', entityName: 'qm_capa_files', entityId: fid, newData: { capa_id: id } });
    return { stream: await this.storage.get(f.file_path), mime: f.mime_type };
  }
}

const upload = FilesInterceptor('files', 5, { storage: memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 5 } });

@Controller('quality/capas')
export class QmCapaController {
  constructor(private readonly s: QmCapaService) {}
  @Get() list(@CurrentUser() u: AuthUser, @Query() q: ListQ) { return this.s.list(u, q); }
  @Post() create(@Body() d: CapaDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.create(d, u, req); }
  @Get(':id') get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser) { return this.s.get(id, u); }
  @Patch(':id') @Roles(...QM_FULL) update(@Param('id', ParseUUIDPipe) id: string, @Body() d: CapaPatchDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.update(id, d, u, req); }
  @Post(':id/start') @HttpCode(200) start(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.start(id, u, req); }
  /** შესრულება: multipart (note + files[]) ან JSON {note} */
  @Post(':id/complete') @HttpCode(200) @UseInterceptors(upload)
  complete(@Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>, @UploadedFiles() files: Express.Multer.File[] | undefined, @CurrentUser() u: AuthUser, @Req() req: Request) {
    const note = typeof body?.note === 'string' ? body.note : '';
    if (note.trim().length < 3) throw new BadRequestException({ code: 'NOTE_REQUIRED', message: 'შესრულების აღწერა სავალდებულოა (მინ. 3 სიმბოლო)' });
    return this.s.complete(id, { note }, files ?? [], u, req);
  }
  @Post(':id/cancel') @HttpCode(200) @Roles(...QM_FULL) cancel(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReasonDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.cancel(id, d, u, req); }
  @Post(':id/due-requests') @HttpCode(200) requestDue(@Param('id', ParseUUIDPipe) id: string, @Body() d: DueReqDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.requestDue(id, d, u, req); }
  @Post(':id/due-requests/:rid/decide') @HttpCode(200) @Roles(...QM_FULL)
  decideDue(@Param('id', ParseUUIDPipe) id: string, @Param('rid', ParseUUIDPipe) rid: string, @Body() d: DecideDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.decideDue(id, rid, d, u, req); }
  @Post(':id/effectiveness') @HttpCode(200) @Roles(...QM_FULL) effectiveness(@Param('id', ParseUUIDPipe) id: string, @Body() d: EffDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.effectiveness(id, d, u, req); }
  @Post(':id/files') @UseInterceptors(upload)
  upload(@Param('id', ParseUUIDPipe) id: string, @UploadedFiles() files: Express.Multer.File[] | undefined, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.upload(id, files ?? [], u, req); }
  @Get(':id/files/:fid')
  async file(@Param('id', ParseUUIDPipe) id: string, @Param('fid', ParseUUIDPipe) fid: string, @CurrentUser() u: AuthUser, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const f = await this.s.file(id, fid, u, req);
    res.set({ 'Content-Type': f.mime, 'Content-Disposition': 'inline', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    return new StreamableFile(f.stream);
  }
}
