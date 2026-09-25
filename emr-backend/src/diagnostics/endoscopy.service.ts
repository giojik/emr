import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { jsonArrayFrom } from 'kysely/helpers/postgres';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { has, type AuthUser } from '../auth/roles';
import { mapPgError } from '../common/pg-errors';
import { InjectDb, type Database } from '../database/database.module';
import type { DB } from '../database/db';
import { sniffMime } from '../patient-files/patient-files';
import { StorageService } from '../storage/storage.service';
import { DiagnosticsService } from './diagnostics.service';

type Trx = Transaction<DB>;
const clean = (v: string | null | undefined) => (v ?? '').replace(/\r\n/g, '\n').trim() || null;

export const INTERVENTIONS = ['biopsy', 'polypectomy', 'emr', 'hemostasis', 'clip', 'banding', 'injection', 'dilation', 'foreign_body', 'stent', 'apc', 'other'] as const;
export const SCOPE_TYPES = ['gastroscope', 'colonoscope', 'duodenoscope', 'bronchoscope', 'cystoscope', 'enteroscope', 'other'] as const;

export interface ProcedureInput {
  consent_confirmed?: boolean; fasting_hours?: number | null; anticoagulants?: 'none' | 'stopped' | 'continued' | null; anticoag_note?: string | null;
  allergies_reviewed?: boolean; asa_class?: number | null; bowel_prep?: 'excellent' | 'good' | 'fair' | 'poor' | 'na' | null; checklist_note?: string | null;
  sedation_type?: 'none' | 'topical' | 'moderate' | 'deep' | 'general' | null; sedation_by?: string | null;
  sedation_drugs?: { drug: string; dose: number; unit: string; time?: string }[]; monitoring?: { time: string; hr?: number; spo2?: number; sys?: number; dia?: number }[];
  scope_id?: string | null; started_at?: string | null; ended_at?: string | null; extent_reached?: string | null; withdrawal_minutes?: number | null; bbps_score?: number | null;
  interventions?: { type: string; site?: string; details?: string }[]; complications?: 'none' | 'minor' | 'major'; complication_note?: string | null;
  recovery_score?: number | null; discharged_at?: string | null;
}
export interface PathInput { external_lab?: string | null; clinical_info?: string | null; specimens?: { jar_no: number; site: string; pieces?: number; description?: string | null; fixative?: string | null }[] }

/** ენდოსკოპია: ენდოსკოპები/დეზინფექცია, პროცედურის ჩანაწერი, სურათები (ზოგადი), გარე პათოლოგია */
@Injectable()
export class EndoscopyService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService, private readonly storage: StorageService, private readonly dx: DiagnosticsService) {}

  // =============================================================== ენდოსკოპები
  /** სტატუსი: ready — ბოლო გამოყენების შემდეგ დეზინფიცირებულია; dirty — საჭიროებს დეზინფექციას; failed — ბოლო ციკლი ჩავარდა */
  async scopes(includeInactive = false) {
    let q = this.db.selectFrom('endo_scopes as s')
      .selectAll('s')
      .select([
        sql<Date | null>`(SELECT max(p.scope_used_at) FROM endo_procedures p WHERE p.scope_id = s.id)`.as('last_used_at'),
        sql<Date | null>`(SELECT r.performed_at FROM endo_reprocessing r WHERE r.scope_id = s.id ORDER BY r.performed_at DESC LIMIT 1)`.as('last_reproc_at'),
        sql<string | null>`(SELECT r.result FROM endo_reprocessing r WHERE r.scope_id = s.id ORDER BY r.performed_at DESC LIMIT 1)`.as('last_reproc_result'),
      ]).orderBy('s.scope_type').orderBy('s.name');
    if (!includeInactive) q = q.where('s.is_active', '=', true);
    const rows = await q.execute();
    return rows.map((r) => ({ ...r, state: scopeState(r) }));
  }

  async saveScope(id: string | null, dto: { name?: string; scope_type?: string; serial_number?: string; is_active?: boolean; note?: string | null }, ctx: AuditContext) {
    try {
      return await this.db.transaction().execute(async (trx) => {
        const vals = { ...(dto.name !== undefined && { name: dto.name.trim() }), ...(dto.scope_type !== undefined && { scope_type: dto.scope_type }),
          ...(dto.serial_number !== undefined && { serial_number: dto.serial_number.trim() }), ...(dto.is_active !== undefined && { is_active: dto.is_active }),
          ...(dto.note !== undefined && { note: clean(dto.note) }) };
        if (id) {
          const old = await trx.selectFrom('endo_scopes').selectAll().where('id', '=', id).executeTakeFirst();
          if (!old) throw new NotFoundException('ენდოსკოპი ვერ მოიძებნა');
          const row = await trx.updateTable('endo_scopes').set(vals).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
          await this.audit.log(ctx, { action: 'UPDATE_ENDO_SCOPE', entityName: 'endo_scopes', entityId: id, oldData: old, newData: vals }, trx);
          return row;
        }
        if (!dto.name || !dto.scope_type || !dto.serial_number) throw new BadRequestException('დასახელება, ტიპი და სერიული ნომერი სავალდებულოა');
        const row = await trx.insertInto('endo_scopes').values({ name: dto.name.trim(), scope_type: dto.scope_type, serial_number: dto.serial_number.trim(), note: clean(dto.note) })
          .returningAll().executeTakeFirstOrThrow();
        await this.audit.log(ctx, { action: 'CREATE_ENDO_SCOPE', entityName: 'endo_scopes', entityId: row.id, newData: vals }, trx);
        return row;
      });
    } catch (e) { mapPgError(e, { endo_scopes_serial_number_key: 'ამ სერიული ნომრით ენდოსკოპი უკვე არსებობს' }); }
  }

  async reprocess(scopeId: string, dto: { method: 'aer' | 'manual'; machine?: string | null; disinfectant?: string | null; leak_test: boolean; result: 'passed' | 'failed'; note?: string | null }, user: AuthUser, ctx: AuditContext) {
    if (dto.result === 'passed' && !dto.leak_test) throw new BadRequestException('გაჟონვის ტესტის გარეშე ციკლი „წარმატებულად“ ვერ ჩაითვლება');
    return this.db.transaction().execute(async (trx) => {
      const sc = await trx.selectFrom('endo_scopes').select(['id', 'is_active']).where('id', '=', scopeId).forUpdate().executeTakeFirst();
      if (!sc) throw new NotFoundException('ენდოსკოპი ვერ მოიძებნა');
      const row = await trx.insertInto('endo_reprocessing').values({
        scope_id: scopeId, method: dto.method, machine: clean(dto.machine), disinfectant: clean(dto.disinfectant), leak_test: dto.leak_test, result: dto.result,
        note: clean(dto.note), performed_by: user.id,
      }).returningAll().executeTakeFirstOrThrow();
      await this.audit.log(ctx, { action: 'ENDO_REPROCESS', entityName: 'endo_scopes', entityId: scopeId, newData: dto }, trx);
      return row;
    });
  }

  /** მიკვლევადობა: ენდოსკოპის გამოყენება და დეზინფექცია ქრონოლოგიურად (ინფექციური კონტროლი) */
  async scopeHistory(scopeId: string, limit = 200) {
    const scope = await this.db.selectFrom('endo_scopes').selectAll().where('id', '=', scopeId).executeTakeFirst();
    if (!scope) throw new NotFoundException('ენდოსკოპი ვერ მოიძებნა');
    const [uses, reproc] = await Promise.all([
      this.db.selectFrom('endo_procedures as ep').innerJoin('dx_order_items as i', 'i.id', 'ep.order_item_id').innerJoin('patients as p', 'p.id', 'i.patient_id')
        .innerJoin('dx_services as s', 's.id', 'i.service_id')
        .select(['ep.order_item_id', 'ep.scope_used_at', 'ep.started_at', 'ep.ended_at', 'i.accession_number', 's.name as service_name', 'p.first_name', 'p.last_name', 'p.personal_number'])
        .where('ep.scope_id', '=', scopeId).where('ep.scope_used_at', 'is not', null).orderBy('ep.scope_used_at', 'desc').limit(limit).execute(),
      this.db.selectFrom('endo_reprocessing as r').innerJoin('users as u', 'u.id', 'r.performed_by')
        .selectAll('r').select(sql<string>`u.first_name || ' ' || u.last_name`.as('performed_by_name'))
        .where('r.scope_id', '=', scopeId).orderBy('r.performed_at', 'desc').limit(limit).execute(),
    ]);
    const events = [
      ...uses.map((u) => ({ kind: 'use' as const, at: u.scope_used_at!, ...u })),
      ...reproc.map((r) => ({ kind: 'reprocess' as const, at: r.performed_at, ...r })),
    ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    return { scope, events };
  }

  // =============================================================== პროცედურა
  async procedure(itemId: string, executor: Database | Trx = this.db) {
    return (await executor.selectFrom('endo_procedures').selectAll().where('order_item_id', '=', itemId).executeTakeFirst()) ?? null;
  }

  /** შუალედური შენახვა (ექთანი / ენდოსკოპისტი). ხელმოწერის შემდეგ — მხოლოდ ხელახლა გახსნით */
  async saveProcedure(itemId: string, dto: ProcedureInput, user: AuthUser, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const it = await this.lockEndoItem(trx, itemId);
      if (!['ordered', 'scheduled', 'arrived', 'performed', 'in_progress'].includes(it.status)) throw new ConflictException('პროცედურის ჩანაწერი ჩაკეტილია (ხელმოწერილია)');
      const exists = await trx.selectFrom('endo_procedures').select(['order_item_id', 'scope_id', 'scope_used_at']).where('order_item_id', '=', itemId).executeTakeFirst();
      if (exists?.scope_used_at && dto.scope_id !== undefined && dto.scope_id !== exists.scope_id) throw new ConflictException('ენდოსკოპის შეცვლა პროცედურის დასრულების შემდეგ შეუძლებელია (მიკვლევადობა)');
      try {
        if (exists) await trx.updateTable('endo_procedures').set(this.procValues(dto, user)).where('order_item_id', '=', itemId).execute();
        else await trx.insertInto('endo_procedures').values({ order_item_id: itemId, ...this.procValues(dto, user, 'insert') }).execute();
      } catch (e) { mapPgError(e, { endo_procedures_check: 'დასრულების დრო დაწყებამდეა', endo_procedures_check1: 'გართულებისას აღწერა სავალდებულოა' }); }
      await this.audit.log(ctx, { action: 'SAVE_ENDO_PROCEDURE', entityName: 'dx_order_items', entityId: itemId, newData: dto }, trx);
      return this.procedure(itemId, trx);
    });
  }

  /**
   * პროცედურა დასრულდა → ენდოსკოპისტის ოქმების სიაში. სავალდებულო: იდენტიფიკაცია, თანხმობა, ალერგიები, ASA, ანტიკოაგულანტები,
   * სედაცია (+ პრეპარატი, თუ ზომიერი/ღრმა/ზოგადი), ენდოსკოპი — დეზინფიცირებული (ბოლო გამოყენების შემდეგ), დაწყება/დასრულება.
   */
  async complete(itemId: string, dto: ProcedureInput & { identity_confirmed?: boolean; unpaid_ack?: boolean }, user: AuthUser, ctx: AuditContext) {
    if (!dto.identity_confirmed) throw new BadRequestException('დაადასტურეთ პაციენტის იდენტიფიკაცია');
    return this.db.transaction().execute(async (trx) => {
      const it = await this.lockEndoItem(trx, itemId);
      if (!['ordered', 'scheduled', 'arrived'].includes(it.status)) throw new ConflictException('პროცედურა უკვე დასრულებულად არის მონიშნული');
      if (it.paid_status === 'unpaid' && !dto.unpaid_ack) throw new ConflictException({ code: 'UNPAID', message: 'პროცედურა გადახდილი არ არის' });
      const cur = await trx.selectFrom('endo_procedures').selectAll().where('order_item_id', '=', itemId).executeTakeFirst();
      const m = { ...(cur ?? {}), ...this.procValues(dto, user, 'insert') } as Record<string, unknown>;
      const miss: string[] = [];
      if (!m.consent_confirmed) miss.push('ინფორმირებული თანხმობა');
      if (!m.allergies_reviewed) miss.push('ალერგიები გადამოწმებულია');
      if (!m.asa_class) miss.push('ASA');
      if (!m.anticoagulants) miss.push('ანტიკოაგულანტები');
      if (!m.sedation_type) miss.push('სედაცია');
      if (['moderate', 'deep', 'general'].includes(String(m.sedation_type)) && !(m.sedation_drugs as unknown[] | undefined)?.length) miss.push('სედაციის პრეპარატი');
      if (!m.scope_id) miss.push('ენდოსკოპი');
      if (!m.started_at || !m.ended_at) miss.push('დაწყება / დასრულება');
      if (miss.length) throw new BadRequestException({ code: 'INCOMPLETE', message: `შეავსეთ: ${miss.join(', ')}`, fields: miss });
      // ენდოსკოპის მზადყოფნა — row lock: ორი პროცედურა ერთდროულად ერთ ენდოსკოპს ვერ „დაიკავებს“
      const scope = await trx.selectFrom('endo_scopes').select(['id', 'name', 'is_active']).where('id', '=', m.scope_id as string).forUpdate().executeTakeFirst();
      if (!scope?.is_active) throw new BadRequestException('ენდოსკოპი ვერ მოიძებნა ან გათიშულია');
      const { rows: [st] } = await sql<{ last_used_at: Date | null; last_reproc_at: Date | null; last_reproc_result: string | null }>`
        SELECT (SELECT max(p.scope_used_at) FROM endo_procedures p WHERE p.scope_id = ${scope.id} AND p.order_item_id <> ${itemId}) AS last_used_at,
               (SELECT r.performed_at FROM endo_reprocessing r WHERE r.scope_id = ${scope.id} ORDER BY r.performed_at DESC LIMIT 1) AS last_reproc_at,
               (SELECT r.result FROM endo_reprocessing r WHERE r.scope_id = ${scope.id} ORDER BY r.performed_at DESC LIMIT 1) AS last_reproc_result`.execute(trx);
      const state = scopeState(st);
      if (state !== 'ready') throw new ConflictException({ code: 'SCOPE_NOT_READY', message: `ენდოსკოპი „${scope.name}“ ${state === 'failed' ? '— ბოლო დეზინფექცია ჩავარდა' : 'ბოლო გამოყენების შემდეგ დეზინფიცირებული არ არის'}` });
      if (cur) await trx.updateTable('endo_procedures').set({ ...this.procValues(dto, user), scope_used_at: sql`now()` }).where('order_item_id', '=', itemId).execute();
      else await trx.insertInto('endo_procedures').values({ order_item_id: itemId, ...this.procValues(dto, user, 'insert'), scope_used_at: sql`now()` }).execute();
      await trx.updateTable('dx_order_items').set({
        status: 'performed', performed_at: new Date(m.ended_at as string), technician_id: user.id,
        arrived_at: it.arrived_at ?? sql`now()`, arrived_by: it.arrived_by ?? user.id, collection_issue: null, collection_issue_at: null,
      }).where('id', '=', itemId).execute();
      await this.audit.log(ctx, { action: 'ENDO_PERFORMED', entityName: 'dx_order_items', entityId: itemId,
        newData: { identity_confirmed: true, scope: scope.name, unpaid_ack: it.paid_status === 'unpaid' || undefined } }, trx);
      return { id: itemId, status: 'performed' };
    });
  }

  private procValues(dto: ProcedureInput, user: AuthUser, mode: 'insert' | 'update' = 'update') {
    const v: Record<string, unknown> = {};
    const keys = ['consent_confirmed', 'fasting_hours', 'anticoagulants', 'anticoag_note', 'allergies_reviewed', 'asa_class', 'bowel_prep', 'checklist_note',
      'sedation_type', 'sedation_by', 'scope_id', 'started_at', 'ended_at', 'extent_reached', 'withdrawal_minutes', 'bbps_score', 'complications', 'complication_note',
      'recovery_score', 'discharged_at'] as const;
    for (const k of keys) if (dto[k] !== undefined) v[k] = typeof dto[k] === 'string' ? clean(dto[k] as string) : dto[k];
    for (const k of ['fasting_hours', 'withdrawal_minutes'] as const) if (v[k] != null) v[k] = String(v[k]);
    if (dto.sedation_drugs !== undefined) v.sedation_drugs = JSON.stringify(dto.sedation_drugs.filter((d) => d.drug?.trim()));
    if (dto.monitoring !== undefined) v.monitoring = JSON.stringify(dto.monitoring.filter((x) => x.time));
    if (dto.interventions !== undefined) v.interventions = JSON.stringify(dto.interventions.filter((x) => x.type));
    if (dto.complications === 'none') v.complication_note = null;
    if (dto.consent_confirmed !== undefined || dto.asa_class !== undefined || dto.allergies_reviewed !== undefined) { v.checklist_by = user.id; v.checklist_at = sql`now()`; }
    v.nurse_id = mode === 'insert' ? user.id : sql`coalesce(nurse_id, ${user.id}::uuid)`;
    return v;
  }

  // =============================================================== სურათები (რადიოლოგია / ენდოსკოპია)
  async addImage(itemId: string, data: Buffer, source: 'upload' | 'capture', caption: string | undefined, user: AuthUser, ctx: AuditContext) {
    const mime = sniffMime(data);
    if (mime !== 'image/jpeg' && mime !== 'image/png') throw new BadRequestException('დაშვებულია მხოლოდ JPG ან PNG');
    const it = await this.db.selectFrom('dx_order_items as i').leftJoin('dx_reports as r', 'r.order_item_id', 'i.id')
      .select(['i.id', 'i.section', 'i.status', 'i.patient_id', 'r.status as report_status']).where('i.id', '=', itemId).executeTakeFirst();
    if (!it || it.section === 'lab') throw new NotFoundException('შეკვეთა ვერ მოიძებნა');
    if (it.status === 'cancelled' || it.report_status === 'signed') throw new ConflictException('ხელმოწერილ/გაუქმებულ კვლევაზე სურათის დამატება შეუძლებელია');
    const id = randomUUID();
    const key = `dx/${it.patient_id}/${itemId}/${id}.${mime === 'image/png' ? 'png' : 'jpg'}`;
    await this.storage.put(key, data, mime);
    const max = await this.db.selectFrom('dx_images').select((eb) => eb.fn.max('sort_order').as('m')).where('order_item_id', '=', itemId).executeTakeFirst();
    const row = await this.db.insertInto('dx_images').values({
      id, order_item_id: itemId, file_path: key, mime_type: mime, size_bytes: data.length, sha256: createHash('sha256').update(data).digest('hex'),
      source, caption: clean(caption), sort_order: (Number(max?.m ?? 0) || 0) + 10, created_by: user.id,
    }).returning(['id', 'source', 'caption', 'in_report', 'sort_order', 'mime_type', 'created_at']).executeTakeFirstOrThrow();
    await this.audit.log(ctx, { action: 'ADD_DX_IMAGE', entityName: 'dx_order_items', entityId: itemId, newData: { image: id, source, size: data.length } });
    return row;
  }

  async updateImage(imageId: string, dto: { caption?: string | null; in_report?: boolean; sort_order?: number; deactivate_reason?: string }, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const img = await trx.selectFrom('dx_images as g').innerJoin('dx_order_items as i', 'i.id', 'g.order_item_id').leftJoin('dx_reports as r', 'r.order_item_id', 'i.id')
        .select(['g.id', 'g.order_item_id', 'g.is_active', 'r.status as report_status']).where('g.id', '=', imageId).forUpdate(['g']).executeTakeFirst();
      if (!img || !img.is_active) throw new NotFoundException('სურათი ვერ მოიძებნა');
      if (img.report_status === 'signed') throw new ConflictException('დასკვნა ხელმოწერილია — ცვლილებისთვის გახსენით ხელახლა');
      const set = {
        ...(dto.caption !== undefined && { caption: clean(dto.caption) }), ...(dto.in_report !== undefined && { in_report: dto.in_report }),
        ...(dto.sort_order !== undefined && { sort_order: dto.sort_order }),
        ...(dto.deactivate_reason && { is_active: false, in_report: false, deactivated_reason: dto.deactivate_reason }),
      };
      if (dto.in_report) {
        const n = await trx.selectFrom('dx_images').select((eb) => eb.fn.countAll<string>().as('n')).where('order_item_id', '=', img.order_item_id)
          .where('in_report', '=', true).where('is_active', '=', true).where('id', '<>', imageId).executeTakeFirstOrThrow();
        if (Number(n.n) >= 8) throw new BadRequestException('ბლანკზე მაქსიმუმ 8 სურათი');
      }
      await trx.updateTable('dx_images').set(set).where('id', '=', imageId).execute();
      await this.audit.log(ctx, { action: dto.deactivate_reason ? 'DEACTIVATE_DX_IMAGE' : 'UPDATE_DX_IMAGE', entityName: 'dx_images', entityId: imageId, newData: dto }, trx);
      return { id: imageId, ...set };
    });
  }

  async imageStream(imageId: string) {
    const g = await this.db.selectFrom('dx_images').select(['file_path', 'mime_type']).where('id', '=', imageId).executeTakeFirst();
    if (!g) throw new NotFoundException('სურათი ვერ მოიძებნა');
    return { stream: await this.storage.get(g.file_path), mime: g.mime_type };
  }

  async imageBuffers(itemId: string) {
    const rows = await this.db.selectFrom('dx_images').select(['id', 'file_path', 'caption']).where('order_item_id', '=', itemId)
      .where('is_active', '=', true).where('in_report', '=', true).orderBy('sort_order').limit(8).execute();
    const out: { data: Buffer; caption: string | null }[] = [];
    for (const r of rows) {
      const s = await this.storage.get(r.file_path); const chunks: Buffer[] = [];
      for await (const c of s) chunks.push(c as Buffer);
      out.push({ data: Buffer.concat(chunks), caption: r.caption });
    }
    return out;
  }

  // =============================================================== პათოლოგია (გარე ლაბორატორია)
  /** მიმართვა + ქილები (draft): ენდოსკოპისტი / ექთანი. ქილების სია მთლიანად იცვლება */
  async savePathology(itemId: string, dto: PathInput, user: AuthUser, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const it = await this.lockEndoItem(trx, itemId);
      if (['ordered', 'scheduled', 'cancelled'].includes(it.status)) throw new ConflictException('ბიოფსია — მხოლოდ მიღებულ / შესრულებულ პროცედურაზე');
      let req = await trx.selectFrom('path_requests').selectAll().where('order_item_id', '=', itemId).forUpdate().executeTakeFirst();
      if (req && req.status !== 'draft') throw new ConflictException('მიმართვა უკვე გაგზავნილია — ცვლილება შეუძლებელია');
      const specs = dto.specimens ?? [];
      const nos = specs.map((s) => s.jar_no);
      if (new Set(nos).size !== nos.length) throw new BadRequestException('ქილების ნომრები მეორდება');
      if (specs.some((s) => !s.site?.trim())) throw new BadRequestException('მიუთითეთ თითო ქილის ლოკალიზაცია');
      if (!req) {
        const { rows: [{ n }] } = await sql<{ n: string }>`SELECT nextval('path_request_seq') AS n`.execute(trx);
        req = await trx.insertInto('path_requests').values({
          order_item_id: itemId, patient_id: it.patient_id, request_no: `P${new Date().getFullYear() % 100}-${String(n).padStart(6, '0')}`,
          external_lab: clean(dto.external_lab), clinical_info: clean(dto.clinical_info), created_by: user.id,
        }).returningAll().executeTakeFirstOrThrow();
      } else {
        await trx.updateTable('path_requests').set({
          ...(dto.external_lab !== undefined && { external_lab: clean(dto.external_lab) }), ...(dto.clinical_info !== undefined && { clinical_info: clean(dto.clinical_info) }),
        }).where('id', '=', req.id).execute();
      }
      if (dto.specimens !== undefined) {
        await trx.deleteFrom('path_specimens').where('request_id', '=', req.id).execute();
        if (specs.length) await trx.insertInto('path_specimens').values(specs.map((s) => ({
          request_id: req!.id, jar_no: s.jar_no, site: s.site.trim(), pieces: s.pieces ?? 1, description: clean(s.description), fixative: clean(s.fixative) ?? 'ფორმალინი 10%',
        }))).execute();
      }
      await this.audit.log(ctx, { action: 'SAVE_PATH_REQUEST', entityName: 'path_requests', entityId: req.id, newData: dto }, trx);
      return this.pathRequest(req.id, trx);
    });
  }

  async sendPathology(requestId: string, dto: { external_lab?: string }, user: AuthUser, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const r = await trx.selectFrom('path_requests').selectAll().where('id', '=', requestId).forUpdate().executeTakeFirst();
      if (!r) throw new NotFoundException('მიმართვა ვერ მოიძებნა');
      if (r.status !== 'draft') throw new ConflictException('მიმართვა უკვე გაგზავნილია');
      const lab = clean(dto.external_lab) ?? r.external_lab;
      if (!lab) throw new BadRequestException('მიუთითეთ ლაბორატორია');
      const n = await trx.selectFrom('path_specimens').select((eb) => eb.fn.countAll<string>().as('n')).where('request_id', '=', requestId).executeTakeFirstOrThrow();
      if (!Number(n.n)) throw new BadRequestException('მიმართვაში ნიმუში (ქილა) არ არის');
      await trx.updateTable('path_requests').set({ status: 'sent', external_lab: lab, sent_at: sql`now()`, sent_by: user.id }).where('id', '=', requestId).execute();
      await this.audit.log(ctx, { action: 'SEND_PATH_REQUEST', entityName: 'path_requests', entityId: requestId, newData: { external_lab: lab } }, trx);
      return this.pathRequest(requestId, trx);
    });
  }

  /** პასუხი: ტექსტი და/ან სკანი (PDF/JPG/PNG) */
  async resultPathology(requestId: string, dto: { result_text?: string; file?: Buffer }, user: AuthUser, ctx: AuditContext) {
    const text = clean(dto.result_text);
    let key: string | null = null;
    const r0 = await this.db.selectFrom('path_requests').select(['id', 'patient_id', 'status']).where('id', '=', requestId).executeTakeFirst();
    if (!r0) throw new NotFoundException('მიმართვა ვერ მოიძებნა');
    if (r0.status !== 'sent') throw new ConflictException(r0.status === 'resulted' ? 'პასუხი უკვე შეტანილია' : 'მიმართვა ჯერ არ არის გაგზავნილი');
    if (!text && !dto.file) throw new BadRequestException('შეიყვანეთ პასუხის ტექსტი ან ატვირთეთ სკანი');
    if (dto.file) {
      const mime = sniffMime(dto.file);
      if (!mime) throw new BadRequestException('სკანი: PDF, JPG ან PNG');
      key = `pathology/${r0.patient_id}/${requestId}/${randomUUID()}.${mime === 'application/pdf' ? 'pdf' : mime === 'image/png' ? 'png' : 'jpg'}`;
      await this.storage.put(key, dto.file, mime);
    }
    return this.db.transaction().execute(async (trx) => {
      const r = await trx.selectFrom('path_requests').select(['status']).where('id', '=', requestId).forUpdate().executeTakeFirstOrThrow();
      if (r.status !== 'sent') throw new ConflictException('პასუხი უკვე შეტანილია');
      await trx.updateTable('path_requests').set({ status: 'resulted', result_text: text, result_file_path: key, result_received_at: sql`now()`, result_entered_by: user.id })
        .where('id', '=', requestId).execute();
      await this.audit.log(ctx, { action: 'PATH_RESULT', entityName: 'path_requests', entityId: requestId, newData: { has_text: !!text, has_file: !!key } }, trx);
      return this.pathRequest(requestId, trx);
    });
  }

  async reviewPathology(requestId: string, user: AuthUser, ctx: AuditContext) {
    const r = await this.db.updateTable('path_requests').set({ reviewed_by: user.id, reviewed_at: sql`now()` })
      .where('id', '=', requestId).where('status', '=', 'resulted').where('reviewed_at', 'is', null).returning('id').executeTakeFirst();
    if (!r) throw new ConflictException('პასუხი არ არის ან უკვე გაცნობილია');
    await this.audit.log(ctx, { action: 'PATH_REVIEWED', entityName: 'path_requests', entityId: requestId });
    return this.pathRequest(requestId);
  }

  async cancelPathology(requestId: string, reason: string, ctx: AuditContext) {
    const r = await this.db.updateTable('path_requests').set({ status: 'cancelled' }).where('id', '=', requestId).where('status', '=', 'draft').returning('id').executeTakeFirst();
    if (!r) throw new ConflictException('გაუქმება შეიძლება მხოლოდ გაუგზავნელი მიმართვის');
    await this.audit.log(ctx, { action: 'CANCEL_PATH_REQUEST', entityName: 'path_requests', entityId: requestId, newData: { reason } });
    return { id: requestId, status: 'cancelled' };
  }

  pathRequest(id: string, executor: Database | Trx = this.db) {
    return executor.selectFrom('path_requests as r').innerJoin('patients as p', 'p.id', 'r.patient_id').innerJoin('dx_order_items as i', 'i.id', 'r.order_item_id')
      .innerJoin('dx_services as s', 's.id', 'i.service_id').leftJoin('users as sb', 'sb.id', 'r.sent_by').leftJoin('users as rv', 'rv.id', 'r.reviewed_by')
      .leftJoin('users as ob', 'ob.id', 'i.ordered_by').leftJoin('encounters as e', 'e.id', 'i.encounter_id')
      .selectAll('r').select(['p.first_name', 'p.last_name', 'p.birth_date', 'p.gender', 'p.personal_number', 's.name as service_name', 'i.accession_number', 'i.performed_at',
        'i.encounter_id', 'e.external_referral', sql<string | null>`sb.first_name || ' ' || sb.last_name`.as('sent_by_name'),
        sql<string | null>`rv.first_name || ' ' || rv.last_name`.as('reviewed_by_name'), sql<string | null>`ob.first_name || ' ' || ob.last_name`.as('ordered_by_name'),
        sql<number | null>`CASE WHEN r.status = 'sent' THEN (now()::date - r.sent_at::date) END`.as('days_waiting'),
        (eb) => jsonArrayFrom(eb.selectFrom('path_specimens as ps').selectAll('ps').whereRef('ps.request_id', '=', 'r.id').orderBy('ps.jar_no')).as('specimens')])
      .where('r.id', '=', id).executeTakeFirstOrThrow();
  }

  /** სია: draft (გასაგზავნი) | sent (პასუხს ელოდება; overdue — N დღეზე მეტი) | resulted (unreviewed — გასაცნობი) */
  async pathList(q: { tab: 'draft' | 'sent' | 'resulted'; overdueDays?: number; unreviewed?: boolean; search?: string }) {
    let query = this.db.selectFrom('path_requests as r').innerJoin('patients as p', 'p.id', 'r.patient_id').innerJoin('dx_order_items as i', 'i.id', 'r.order_item_id')
      .innerJoin('dx_services as s', 's.id', 'i.service_id')
      .select(['r.id', 'r.order_item_id', 'r.request_no', 'r.status', 'r.external_lab', 'r.sent_at', 'r.result_received_at', 'r.reviewed_at', 'r.created_at',
        'p.first_name', 'p.last_name', 'p.personal_number', 'p.birth_date', 'p.gender', 's.name as service_name', 'i.performed_at',
        sql<number>`(SELECT count(*)::int FROM path_specimens ps WHERE ps.request_id = r.id)`.as('jars'),
        sql<number | null>`CASE WHEN r.status = 'sent' THEN (now()::date - r.sent_at::date) END`.as('days_waiting')])
      .where('r.status', '=', q.tab);
    if (q.tab === 'sent' && q.overdueDays) query = query.where(sql<boolean>`r.sent_at < now() - make_interval(days => ${q.overdueDays})`);
    if (q.tab === 'resulted' && q.unreviewed) query = query.where('r.reviewed_at', 'is', null);
    if (q.search?.trim()) { const t = q.search.trim(); query = query.where((eb) => eb.or([eb('r.request_no', '=', t.toUpperCase()), eb('p.personal_number', '=', t), eb('p.last_name', 'ilike', `${t}%`)])); }
    return query.orderBy(q.tab === 'sent' ? 'r.sent_at' : q.tab === 'resulted' ? 'r.result_received_at' : 'r.created_at', q.tab === 'resulted' ? 'desc' : 'asc').limit(500).execute();
  }

  async pathResultFile(requestId: string) {
    const r = await this.db.selectFrom('path_requests').select(['result_file_path']).where('id', '=', requestId).executeTakeFirst();
    if (!r?.result_file_path) throw new NotFoundException('სკანი არ არის');
    const mime = r.result_file_path.endsWith('.pdf') ? 'application/pdf' : r.result_file_path.endsWith('.png') ? 'image/png' : 'image/jpeg';
    return { stream: await this.storage.get(r.result_file_path), mime };
  }

  // =============================================================== helpers
  private async lockEndoItem(trx: Trx, itemId: string) {
    const it = await trx.selectFrom('dx_order_items as i').leftJoin('invoices as inv', 'inv.encounter_id', 'i.encounter_id')
      .select(['i.id', 'i.status', 'i.section', 'i.patient_id', 'i.encounter_id', 'i.arrived_at', 'i.arrived_by', 'inv.paid_status'])
      .where('i.id', '=', itemId).forUpdate(['i']).executeTakeFirst();
    if (!it || it.section !== 'endoscopy') throw new NotFoundException('ენდოსკოპიური შეკვეთა ვერ მოიძებნა');
    if (it.status === 'cancelled') throw new ConflictException('შეკვეთა გაუქმებულია');
    return it;
  }

  assertEndoStaff(user: AuthUser) {
    if (!has(user, 'admin', 'endoscopist', 'endoscopy_nurse')) throw new ForbiddenException('ენდოსკოპიის პერსონალი');
  }
}

/** ენდოსკოპის მზადყოფნა: დეზინფექცია უნდა იყოს ბოლო გამოყენების შემდეგ და წარმატებული */
export function scopeState(r: { last_used_at: Date | string | null; last_reproc_at: Date | string | null; last_reproc_result: string | null }): 'ready' | 'dirty' | 'failed' {
  if (!r.last_reproc_at) return 'dirty';
  if (r.last_reproc_result === 'failed') return 'failed';
  if (r.last_used_at && new Date(r.last_used_at) >= new Date(r.last_reproc_at)) return 'dirty';
  return 'ready';
}
