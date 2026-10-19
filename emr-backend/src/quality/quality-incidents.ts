import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query,
  Req, Res, StreamableFile, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { OmitType } from '@nestjs/mapped-types';
import { plainToInstance, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min, ValidateNested, validate } from 'class-validator';
import type { Request, Response } from 'express';
import { sql } from 'kysely';
import { memoryStorage } from 'multer';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser } from '../auth/roles';
import { sniffMime } from '../patient-files/patient-files';
import { StorageService } from '../storage/storage.service';
import {
  AFFECTED, EVENT_KA, EVENT_TYPES, HARM_KA, HARMS, harmRank, IDENTITY_MODES, MERP, PATIENT_LOOKUP, QM_DEPT, QM_FULL, QmCommon, REJECT_KA, REJECT_REASONS,
  SOURCE_TYPES, STATUS_KA, levelFor, LEVEL_KA, CAPA_STATUS_KA, type Access, type Ex, type Harm, type QmRules, type SourceType, type Trx, userName,
} from './quality-common';
import { QmSources } from './quality-sources';

const MAX_FILE = 10 * 1024 * 1024;
const MAX_FILES_PER_INCIDENT = 20;
const TRACK_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // I / O / 0 / 1-ის გარეშე
const OPEN_STATUSES = ['investigation', 'analysis', 'capa'];

// ---------------------------------------------------------------- DTO
export class PersonIn {
  @IsIn(['involved', 'witness', 'affected']) role: 'involved' | 'witness' | 'affected';
  @IsOptional() @IsUUID() user_id?: string | null;
  @IsOptional() @IsString() @MaxLength(200) name_text?: string | null;
  @IsOptional() @IsString() @MaxLength(500) note?: string | null;
}
export class ReportDto {
  @IsIn(EVENT_TYPES) event_type: (typeof EVENT_TYPES)[number];
  @IsIn(AFFECTED) affected: (typeof AFFECTED)[number];
  @IsISO8601() occurred_at: string;
  @IsUUID() department_id: string;
  @IsOptional() @IsString() @MaxLength(200) location_text?: string | null;
  @IsUUID() category_id: string;
  @IsIn(HARMS) harm_reported: Harm;
  @IsOptional() @IsIn(MERP) merp_category?: string | null;
  @IsString() @Length(10, 8000) description: string;
  @IsOptional() @IsString() @MaxLength(4000) immediate_actions?: string | null;
  @IsOptional() @IsUUID() patient_id?: string | null;
  @IsOptional() @IsString() @MaxLength(200) patient_text?: string | null;
  @IsOptional() @IsIn(SOURCE_TYPES) source_type?: SourceType | null;
  @IsOptional() @IsUUID() source_id?: string | null;
  @IsIn(IDENTITY_MODES) identity_mode: (typeof IDENTITY_MODES)[number];
  @IsOptional() @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => PersonIn) people?: PersonIn[];
}
export class EditDto extends OmitType(ReportDto, ['identity_mode'] as const) {}

class ClassifyDto {
  @IsOptional() @IsIn(HARMS) harm?: Harm;
  @IsOptional() @IsIn(MERP) merp_category?: string | null;
  @IsOptional() @IsInt() @Min(1) @Max(5) likelihood?: number;
  @IsOptional() @IsInt() @Min(1) @Max(5) consequence?: number;
  @IsOptional() @IsUUID() category_id?: string;
  @IsOptional() @IsUUID() department_id?: string;
  @IsOptional() @IsBoolean() is_sentinel?: boolean;
  @IsOptional() @IsUUID() patient_id?: string | null;
  @IsOptional() @IsIn(EVENT_TYPES) event_type?: (typeof EVENT_TYPES)[number];
  @IsOptional() @IsString() @MaxLength(4000) note?: string | null;
}
export class TriageDto extends ClassifyDto {
  @IsIn(['accept', 'reject']) decision: 'accept' | 'reject';
  @IsOptional() @IsIn(REJECT_REASONS) reject_reason?: (typeof REJECT_REASONS)[number];
  @IsOptional() @IsUUID() duplicate_of?: string;
  /** 0065: გამომძიებელი (არჩევითი) */
  @IsOptional() @IsUUID() investigator_id?: string;
}
export class ReclassifyDto extends ClassifyDto { @IsString() @Length(3, 500) reason: string }
class ReasonDto { @IsString() @Length(3, 500) reason: string }
class CommentDto { @IsString() @Length(2, 4000) text: string; @IsOptional() @IsBoolean() internal?: boolean }
class DismissDto { @IsIn(SOURCE_TYPES) source_type: SourceType; @IsUUID() source_id: string }
interface ListQ { status?: string; department_id?: string; category_id?: string; harm?: string; event_type?: string; from?: string; to?: string; search?: string;
  sentinel?: string; urgent?: string; overdue?: string; risk_level?: string }

type Inc = Awaited<ReturnType<QmIncidentsService['row']>>;

/**
 * ინციდენტები (0064): შეტყობინება → ტრიაჟი (მიღება / უარყოფა) → [0065: გამოძიება, ანალიზი, CAPA, დახურვა].
 * ხედვა: full (quality) — ყველაფერი; dept (quality_dept) — თავისი განყოფილების მიღებული, ავტორის (თუ არ არის ღია) და მონაწილეების გარეშე;
 *   own — ავტორი: საკუთარი შეტყობინება და სტატუსი. ანონიმური ავტორი არსად ინახება (აუდიტშიც).
 */
@Injectable()
export class QmIncidentsService {
  constructor(private readonly c: QmCommon, private readonly src: QmSources, private readonly audit: AuditService, private readonly storage: StorageService) {}
  private get db() { return this.c.db; }

  // ---------------------------------------------------------------- მეტა / დამხმარე
  async meta(u: AuthUser) {
    const r = await this.c.rules();
    const me = await this.db.selectFrom('users').select('department_id').where('id', '=', u.id).executeTakeFirst();
    const access = has(u, ...QM_FULL) ? 'full' : has(u, ...QM_DEPT) ? 'dept' : null;
    return { identity_modes: r.identity_modes, identity_default: r.identity_default, ncc_merp: r.ncc_merp, anonymous_tracking: r.anonymous_tracking,
      event_prompts: r.event_prompts, risk: { low_max: r.risk_low_max, medium_max: r.risk_medium_max, high_max: r.risk_high_max },
      can_lookup: has(u, ...PATIENT_LOOKUP), my_department_id: me?.department_id ?? null, access, reports: has(u, ...QM_FULL, 'quality_view'),
      // 0065
      investigator_at_triage: r.investigator_at_triage !== false, analysis_approval: r.analysis_approval !== false, capa_effectiveness: r.capa_effectiveness !== false,
      closure_feedback: r.closure_feedback !== false, report_mask_patient: r.report_mask_patient !== false,
      disclosure_required_harm: r.disclosure_required_harm ?? 'moderate' };
  }

  async people(search?: string) {
    await this.c.rules();
    let q = this.db.selectFrom('users as u').leftJoin('departments as d', 'd.id', 'u.department_id')
      .select(['u.id', userName('u').as('name'), 'd.name as department_name']).where('u.is_active', '=', true).orderBy('u.last_name').limit(20);
    const s = search?.trim();
    if (s) q = q.where(sql<string>`u.first_name || ' ' || u.last_name`, 'ilike', `%${s}%`);
    return q.execute();
  }

  async patients(q?: string) {
    await this.c.rules();
    const s = q?.trim() ?? '';
    if (s.length < 2) return [];
    let x = this.db.selectFrom('patients').select(['id', 'first_name', 'last_name', 'personal_number', 'birth_date']).orderBy('last_name').limit(15);
    x = /^\d+$/.test(s) ? x.where('personal_number', 'like', `${s}%`)
      : x.where(sql<string>`first_name || ' ' || last_name`, 'ilike', `%${s}%`);
    return x.execute();
  }

  async sources(patientId: string) { await this.c.rules(); return this.src.recent(patientId); }

  async prompts(u: AuthUser) {
    const r = await this.c.rules();
    return r.event_prompts ? this.src.prompts(u) : [];
  }
  async dismiss(u: AuthUser, d: DismissDto) {
    await this.c.rules();
    await this.db.insertInto('qm_prompt_dismissals').values({ user_id: u.id, source_type: d.source_type, source_id: d.source_id }).onConflict((oc) => oc.doNothing()).execute();
    return { ok: true };
  }

  // ---------------------------------------------------------------- ვალიდაცია
  private async category(id: string, ex: Ex) {
    const c = await ex.selectFrom('qm_classifiers as c').leftJoin('qm_classifiers as p', 'p.id', 'c.parent_id')
      .select(['c.id', 'c.kind', 'c.name', 'c.is_active', 'c.is_sentinel', 'c.is_medication', 'p.name as parent_name', 'p.is_medication as parent_medication', 'p.is_active as parent_active'])
      .where('c.id', '=', id).executeTakeFirst();
    if (!c || c.kind !== 'category' || !c.is_active || c.parent_active === false) throw new BadRequestException({ code: 'CATEGORY', message: 'კატეგორია ვერ მოიძებნა ან გათიშულია' });
    return { ...c, medication: c.is_medication || !!c.parent_medication };
  }
  private async department(id: string, ex: Ex) {
    const d = await ex.selectFrom('departments').select(['id', 'name', 'is_active']).where('id', '=', id).executeTakeFirst();
    if (!d || !d.is_active) throw new BadRequestException({ code: 'DEPARTMENT', message: 'განყოფილება ვერ მოიძებნა ან გათიშულია' });
    return d;
  }
  private async patientExists(id: string, ex: Ex) {
    if (!(await ex.selectFrom('patients').select('id').where('id', '=', id).executeTakeFirst())) throw new BadRequestException({ code: 'PATIENT', message: 'პაციენტი ვერ მოიძებნა' });
  }

  /** შეტყობინების ველების შემოწმება / გამოთვლა (შექმნა და ავტორის რედაქტირება) */
  private async build(dto: EditDto, r: QmRules, u: AuthUser, ex: Ex, prev?: { patient_id: string | null; source_id: string | null }) {
    const t = new Date(dto.occurred_at).getTime();
    if (Number.isNaN(t) || t > Date.now() + 10 * 60_000) throw new BadRequestException({ code: 'OCCURRED_AT', message: 'მოვლენის დრო მომავალში ვერ იქნება' });
    if (t < Date.now() - 2 * 366 * 86_400_000) throw new BadRequestException({ code: 'OCCURRED_AT', message: 'მოვლენის დრო 2 წელზე ძველია' });
    const dept = await this.department(dto.department_id, ex);
    const cat = await this.category(dto.category_id, ex);
    if (dto.event_type === 'harm' && dto.harm_reported === 'none') throw new BadRequestException({ code: 'HARM', message: 'ინციდენტი ზიანით — მიუთითეთ ზიანის ხარისხი' });
    if (dto.event_type !== 'harm' && dto.harm_reported !== 'none') throw new BadRequestException({ code: 'HARM', message: 'ზიანის გარეშე / near-miss / სახიფათო მდგომარეობა — ზიანი „არ არის“' });
    if (dto.affected === 'none' && !['hazard', 'near_miss'].includes(dto.event_type)) throw new BadRequestException({ code: 'AFFECTED', message: 'მიუთითეთ, ვის შეეხო' });
    const merp = dto.merp_category || null;
    if (merp && (!r.ncc_merp || !cat.medication)) throw new BadRequestException({ code: 'MERP', message: 'NCC MERP კატეგორია მხოლოდ მედიკამენტურ ინციდენტზე' });
    let patientId = dto.patient_id || null; let encounterId: string | null = null; let source: { type: SourceType; id: string; label: string } | null = null;
    if (!!dto.source_type !== !!dto.source_id) throw new BadRequestException({ code: 'SOURCE', message: 'წყარო: სახე და id ერთად' });
    if (dto.source_type && dto.source_id) {
      const s = await this.src.resolve(dto.source_type, dto.source_id, ex);
      if (patientId && s.patient_id && patientId !== s.patient_id) throw new BadRequestException({ code: 'SOURCE_PATIENT', message: 'მიბმული მოვლენა სხვა პაციენტს ეკუთვნის' });
      patientId = patientId ?? s.patient_id; encounterId = s.encounter_id; source = { type: s.type, id: s.id, label: s.label };
    }
    if (dto.patient_id && dto.patient_id !== prev?.patient_id && !has(u, ...PATIENT_LOOKUP) && !source) {
      throw new ForbiddenException({ code: 'PATIENT_LOOKUP', message: 'პაციენტის არჩევის უფლება არ გაქვთ — ჩაწერეთ სახელი / პალატა ტექსტად' });
    }
    if (patientId) await this.patientExists(patientId, ex);
    const patientText = dto.patient_text?.trim() || null;
    if (dto.affected === 'patient' && !patientId && (patientText ?? '').length < 2) throw new BadRequestException({ code: 'PATIENT_REQUIRED', message: 'პაციენტი: აირჩიეთ ან ჩაწერეთ სახელი / პალატა' });
    const people = dto.people ?? [];
    const uids = [...new Set(people.map((p) => p.user_id).filter((x): x is string => !!x))];
    if (uids.length) {
      const n = (await ex.selectFrom('users').select(sql<number>`count(*)::int`.as('n')).where('id', 'in', uids).executeTakeFirstOrThrow()).n;
      if (n !== uids.length) throw new BadRequestException({ code: 'PERSON', message: 'მონაწილე თანამშრომელი ვერ მოიძებნა' });
    }
    for (const p of people) if (!p.user_id && (p.name_text?.trim() ?? '').length < 2) throw new BadRequestException({ code: 'PERSON', message: 'მონაწილე: აირჩიეთ თანამშრომელი ან ჩაწერეთ სახელი' });
    return {
      values: {
        event_type: dto.event_type, affected: dto.affected, occurred_at: new Date(t).toISOString(), department_id: dept.id, location_text: dto.location_text?.trim() || null,
        category_id: cat.id, harm_reported: dto.harm_reported, merp_category: merp, description: dto.description.trim(), immediate_actions: dto.immediate_actions?.trim() || null,
        patient_id: patientId, patient_text: patientId ? null : patientText, encounter_id: encounterId,
        source_type: source?.type ?? null, source_id: source?.id ?? null, source_label: source?.label ?? null,
      },
      people: people.map((p) => ({ role: p.role, user_id: p.user_id || null, name_text: p.user_id ? null : p.name_text!.trim(), note: p.note?.trim() || null })),
      cat, dept,
    };
  }

  private urgentFor(r: QmRules, harm: string, sentinel: boolean) {
    return sentinel || (r.alert_harm !== 'off' && harmRank(harm) >= harmRank(r.alert_harm));
  }

  private async storeFiles(trx: Trx, incidentId: string, files: Express.Multer.File[], uploadedBy: string | null) {
    const out: string[] = [];
    for (const f of files) {
      const mime = sniffMime(f.buffer);
      if (!mime) throw new BadRequestException({ code: 'FILE_TYPE', message: `${f.originalname}: დაშვებულია მხოლოდ JPG, PNG ან PDF` });
      const id = randomUUID(); const ext = mime === 'application/pdf' ? 'pdf' : mime === 'image/png' ? 'png' : 'jpg';
      const key = `qm/${incidentId}/${id}.${ext}`;
      await this.storage.put(key, f.buffer, mime);
      await trx.insertInto('qm_incident_files').values({ id, incident_id: incidentId, file_path: key, mime_type: mime, size_bytes: f.buffer.length,
        sha256: createHash('sha256').update(f.buffer).digest('hex'), original_name: f.originalname?.slice(0, 200) ?? null, uploaded_by: uploadedBy }).execute();
      out.push(id);
    }
    return out;
  }

  private trackCode() {
    const b = randomBytes(16); let s = '';
    for (let i = 0; i < 16; i++) s += TRACK_ALPHABET[b[i] % TRACK_ALPHABET.length];
    return s.match(/.{4}/g)!.join('-');
  }
  private trackHash(code: string) { return createHash('sha256').update(code.toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex'); }

  // ---------------------------------------------------------------- შეტყობინება
  async report(raw: unknown, files: Express.Multer.File[], u: AuthUser, req: Request) {
    let body: unknown = raw;
    if (raw && typeof raw === 'object' && typeof (raw as { data?: unknown }).data === 'string') {
      try { body = JSON.parse((raw as { data: string }).data); } catch { throw new BadRequestException({ code: 'BAD_JSON', message: 'ველი data — არასწორი JSON' }); }
    }
    const dto = plainToInstance(ReportDto, body ?? {});
    const errs = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    if (errs.length) throw new BadRequestException(errs.flatMap((e) => Object.values(e.constraints ?? {}).concat((e.children ?? []).flatMap((c) => (c.children ?? []).flatMap((x) => Object.values(x.constraints ?? {}))))));
    if (files.length > 5) throw new BadRequestException({ code: 'FILES', message: 'მაქსიმუმ 5 ფაილი' });
    const r = await this.c.rules();
    if (!r.identity_modes.includes(dto.identity_mode)) throw new BadRequestException({ code: 'IDENTITY_MODE', message: 'ავტორის ეს რეჟიმი კლინიკაში დაშვებული არ არის' });
    const anon = dto.identity_mode === 'anonymous';
    const reporter = anon ? null : u.id;
    // ანონიმური: აუდიტში არც მომხმარებელი, არც IP / ბრაუზერი
    const ctx: AuditContext = anon ? { userId: null } : auditCtx(req);
    const track = anon && r.anonymous_tracking ? this.trackCode() : null;
    const res = await this.db.transaction().execute(async (trx) => {
      const b = await this.build(dto, r, u, trx);
      const sentinel = b.cat.is_sentinel;
      const urgent = this.urgentFor(r, dto.harm_reported, sentinel);
      const hours = sentinel ? r.sentinel_triage_hours : r.triage_hours;
      const inc = await trx.insertInto('qm_incidents').values({ ...b.values, inc_no: await this.c.nextNo(trx), identity_mode: dto.identity_mode, reporter_id: reporter,
        track_hash: track ? this.trackHash(track) : null, is_sentinel: sentinel, urgent, triage_due_at: sql`now() + make_interval(hours => ${hours})` })
        .returning(['id', 'inc_no', 'status', 'urgent', 'is_sentinel', 'triage_due_at']).executeTakeFirstOrThrow();
      if (b.people.length) await trx.insertInto('qm_incident_people').values(b.people.map((p) => ({ ...p, incident_id: inc.id }))).execute();
      const fileIds = await this.storeFiles(trx, inc.id, files, reporter);
      await trx.insertInto('qm_incident_events').values({ incident_id: inc.id, user_id: reporter, kind: 'submitted', data: JSON.stringify({ files: fileIds.length }) }).execute();
      await this.audit.log(ctx, { action: 'QM_REPORT', entityName: 'qm_incidents', entityId: inc.id,
        newData: { inc_no: inc.inc_no, identity_mode: dto.identity_mode, event_type: dto.event_type, category_id: b.cat.id, department_id: b.dept.id, harm_reported: dto.harm_reported,
          sentinel, urgent, patient: !!b.values.patient_id, source_type: b.values.source_type, files: fileIds.length, people: b.people.length } }, trx);
      return { inc, cat: b.cat, dept: b.dept };
    });
    await this.announceNew(r, res.inc.id, res.inc.inc_no, res.cat, res.dept.name, dto.harm_reported, res.inc.urgent, res.inc.is_sentinel);
    return { id: anon ? null : res.inc.id, inc_no: res.inc.inc_no, status: res.inc.status, urgent: res.inc.urgent, track_code: track };
  }

  /** ახალი ინციდენტი → ხარისხის მენეჯერები (ზარი); სასწრაფოზე — + მიმღებები და SMS / ელფოსტა */
  private async announceNew(r: QmRules, id: string, no: string, cat: { name: string; parent_name: string | null }, dept: string, harm: string, urgent: boolean, sentinel: boolean) {
    const q = await this.c.usersWith(QM_FULL);
    const what = `${cat.parent_name ? `${cat.parent_name} → ` : ''}${cat.name} · ${dept} · ${HARM_KA[harm as Harm]}${sentinel ? ' · სენტინელური' : ''}`;
    await this.c.bell(q.map((x) => x.id), { kind: 'qm_new', title: `ახალი ინციდენტი ${no}${urgent ? ' — სასწრაფო' : ''}`, body: what, link: `/quality/incidents/${id}`, entityId: id, urgent });
    if (urgent) await this.alertUrgent(r, q, id, no, dept, harm, sentinel);
  }
  private async alertUrgent(r: QmRules, q: { id: string; phone: string | null; email: string | null }[], id: string, no: string, dept: string, harm: string, sentinel: boolean) {
    const extra = r.alert_user_ids.length ? await this.db.selectFrom('users').select(['id', 'phone', 'email']).where('id', 'in', r.alert_user_ids).where('is_active', '=', true).execute() : [];
    const qIds = new Set(q.map((x) => x.id));
    const others = extra.filter((x) => !qIds.has(x.id));
    const text = `${sentinel ? 'სენტინელური' : 'მძიმე'} ინციდენტი ${no} — ${dept}, ზიანი: ${HARM_KA[harm as Harm]}.`;
    await this.c.bell(others.map((x) => x.id), { kind: 'qm_alert', title: `სასწრაფო ინციდენტი ${no}`, body: text, entityId: id, urgent: true });
    await this.c.alertExternal(r, [...q, ...others], `EMR: სასწრაფო ინციდენტი ${no}`, `EMR: ${text} დეტალები — სისტემაში (ხარისხი და ინციდენტები).`);
  }

  // ---------------------------------------------------------------- ავტორის რედაქტირება (ტრიაჟამდე)
  async edit(id: string, dto: EditDto, u: AuthUser, req: Request) {
    const r = await this.c.rules();
    await this.db.transaction().execute(async (trx) => {
      const inc = await trx.selectFrom('qm_incidents').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!inc || inc.reporter_id !== u.id) throw new NotFoundException('ინციდენტი ვერ მოიძებნა');
      if (inc.status !== 'submitted') throw new ConflictException({ code: 'NOT_EDITABLE', message: 'ტრიაჟის შემდეგ შეტყობინება აღარ იცვლება — დაამატეთ კომენტარი' });
      const b = await this.build(dto, r, u, trx, inc);
      const changed = (Object.keys(b.values) as (keyof typeof b.values)[]).filter((k) => String(b.values[k] ?? '') !== String(k === 'occurred_at' ? new Date(inc.occurred_at as unknown as string).toISOString() : inc[k] ?? ''));
      const sentinel = b.cat.is_sentinel;
      const hours = sentinel ? r.sentinel_triage_hours : r.triage_hours;
      await trx.updateTable('qm_incidents').set({ ...b.values, is_sentinel: sentinel, urgent: this.urgentFor(r, dto.harm_reported, sentinel),
        triage_due_at: sql`least(triage_due_at, reported_at + make_interval(hours => ${hours}))` }).where('id', '=', id).execute();
      await trx.deleteFrom('qm_incident_people').where('incident_id', '=', id).execute();
      if (b.people.length) await trx.insertInto('qm_incident_people').values(b.people.map((p) => ({ ...p, incident_id: id }))).execute();
      await trx.insertInto('qm_incident_events').values({ incident_id: id, user_id: u.id, kind: 'edited', data: JSON.stringify({ fields: changed }) }).execute();
      await this.audit.log(auditCtx(req), { action: 'QM_UPDATE', entityName: 'qm_incidents', entityId: id, oldData: Object.fromEntries(changed.map((k) => [k, inc[k]])),
        newData: Object.fromEntries(changed.map((k) => [k, b.values[k]])) }, trx);
    });
    return this.get(id, u, req, false);
  }

  // ---------------------------------------------------------------- სია / ნახვა
  async row(id: string, ex: Ex = this.db) {
    const i = await ex.selectFrom('qm_incidents as i')
      .innerJoin('qm_classifiers as c', 'c.id', 'i.category_id').leftJoin('qm_classifiers as cp', 'cp.id', 'c.parent_id')
      .innerJoin('departments as d', 'd.id', 'i.department_id')
      .leftJoin('patients as p', 'p.id', 'i.patient_id')
      .leftJoin('users as ur', 'ur.id', 'i.reporter_id').leftJoin('users as ut', 'ut.id', 'i.triaged_by')
      .leftJoin('qm_incidents as dup', 'dup.id', 'i.duplicate_of')
      .leftJoin('users as uinv', 'uinv.id', 'i.investigator_id').leftJoin('users as ucl', 'ucl.id', 'i.closed_by').leftJoin('users as udb', 'udb.id', 'i.disclosure_by')
      .selectAll('i')
      .select(['c.name as category_name', 'cp.name as category_parent_name', 'c.parent_id as category_parent_id', 'c.is_medication', 'cp.is_medication as parent_is_medication',
        'd.name as department_name', 'p.first_name as patient_first_name', 'p.last_name as patient_last_name', 'p.personal_number as patient_personal_number', 'p.birth_date as patient_birth_date',
        userName('ur').as('reporter_name'), userName('ut').as('triaged_by_name'), 'dup.inc_no as duplicate_inc_no',
        userName('uinv').as('investigator_name'), userName('ucl').as('closed_by_name'), userName('udb').as('disclosure_by_name'),
        sql<boolean>`i.status IN ('investigation', 'analysis') AND i.analysis_due_at < now()`.as('analysis_overdue'),
        sql<boolean>`i.status = 'submitted' AND i.triage_due_at < now()`.as('overdue')])
      .where('i.id', '=', id).executeTakeFirst();
    if (!i) throw new NotFoundException('ინციდენტი ვერ მოიძებნა');
    return i;
  }

  /** ხედვის მიხედვით გაფილტრული ჩანაწერი */
  private shape(i: Inc, a: Access) {
    const { track_hash: _t, ...rest } = i;
    const base = { ...rest, status_label: STATUS_KA[i.status], event_label: EVENT_KA[i.event_type], access: a,
      medication: !!(i.is_medication || i.parent_is_medication) };
    if (a === 'full') return base;
    if (a === 'dept' || a === 'inv') {
      const showReporter = i.identity_mode === 'open';
      return { ...base, reporter_id: showReporter ? i.reporter_id : null, reporter_name: showReporter ? i.reporter_name : null, triaged_by: null, triaged_by_name: null };
    }
    // ავტორი: თავისი შეტყობინება + სტატუსი; ტრიაჟის შედეგები (რისკი, საბოლოო სიმძიმე, შენიშვნა) — არა
    return { ...base, harm: null, likelihood: null, consequence: null, risk_score: null, risk_level: null, triage_note: null, triaged_by: null, triaged_by_name: null,
      is_sentinel: false, urgent: false, duplicate_of: null, duplicate_inc_no: null, overdue: false, overdue_notified_at: null,
      investigator_id: null, investigator_name: null, analysis_level: null, analysis_due_at: null, analysis_overdue: false, closure_summary: null, closed_by: null, closed_by_name: null,
      disclosure_status: null, disclosed_at: null, disclosure_by: null, disclosure_by_name: null, disclosure_method: null, disclosure_to: null, disclosure_note: null,
      feedback_text: i.status === 'closed' ? i.feedback_text : null };
  }

  async get(id: string, u: AuthUser, req: Request, audit = true) {
    await this.c.rules();
    const i = await this.row(id);
    const a = await this.c.access(u, i);
    if (!a) throw new NotFoundException('ინციდენტი ვერ მოიძებნა');
    const files = await this.db.selectFrom('qm_incident_files').select(['id', 'mime_type', 'size_bytes', 'original_name', 'created_at', 'uploaded_by'])
      .where('incident_id', '=', id).where('is_active', '=', true).orderBy('created_at').execute();
    let ev = this.db.selectFrom('qm_incident_events as e').leftJoin('users as u', 'u.id', 'e.user_id')
      .select(['e.id', 'e.at', 'e.kind', 'e.text', 'e.data', 'e.internal', 'e.user_id', userName('u').as('user_name')]).where('e.incident_id', '=', id).orderBy('e.at').orderBy('e.id');
    if (a === 'dept' || a === 'inv') ev = ev.where('e.internal', '=', false);
    if (a === 'own') ev = ev.where('e.kind', 'in', ['submitted', 'edited', 'author_note', 'accepted', 'rejected', 'reopened']).where('e.internal', '=', false);
    const events = (await ev.execute()).map((e) => {
      // ავტორის ხედვა: სხვისი სახელი / ტრიაჟის ტექსტი არ ჩანს; dept — ავტორის სახელი (თუ არ არის ღია) არ ჩანს
      if (a === 'own') return { ...e, user_name: e.user_id === u.id ? e.user_name : null, text: e.kind === 'author_note' ? e.text : null, data: e.kind === 'rejected' ? e.data : null };
      if ((a === 'dept' || a === 'inv') && e.user_id && e.user_id === i.reporter_id && i.identity_mode !== 'open') return { ...e, user_id: null, user_name: 'ავტორი' };
      return e;
    });
    const people = a === 'full' || a === 'inv' ? await this.db.selectFrom('qm_incident_people as p').leftJoin('users as u', 'u.id', 'p.user_id').leftJoin('departments as d', 'd.id', 'u.department_id')
      .select(['p.id', 'p.role', 'p.user_id', 'p.name_text', 'p.note', userName('u').as('user_name'), 'd.name as department_name']).where('p.incident_id', '=', id).orderBy('p.created_at').execute()
      : a === 'own' ? await this.db.selectFrom('qm_incident_people as p').leftJoin('users as u', 'u.id', 'p.user_id')
        .select(['p.id', 'p.role', 'p.user_id', 'p.name_text', 'p.note', userName('u').as('user_name'), sql<null>`NULL`.as('department_name')]).where('p.incident_id', '=', id).execute() : null;
    if (audit) await this.audit.log(auditCtx(req), { action: 'QM_VIEW', entityName: 'qm_incidents', entityId: id, newData: { inc_no: i.inc_no, access: a } });
    const extra = a === 'own' ? { analysis: null, capas: null, can: { edit_analysis: false, submit: false, disclose: false } } : await this.analysisBundle(i, a, u);
    return { ...this.shape(i, a), files: files.map((f) => ({ ...f, uploaded_by: a === 'full' || f.uploaded_by === u.id ? f.uploaded_by : null })), events, people, ...extra };
  }

  /** 0065: ანალიზი (ქრონოლოგია, ფაქტორები, გუნდი), მიბმული CAPA-ები, მოქმედებების უფლებები */
  async analysisBundle(i: { id: string; status: string; investigator_id: string | null }, a: Access, u: AuthUser, ex: Ex = this.db) {
    const an = await ex.selectFrom('qm_analyses as x').leftJoin('users as us', 'us.id', 'x.submitted_by').leftJoin('users as ua', 'ua.id', 'x.approved_by')
      .selectAll('x').select([userName('us').as('submitted_by_name'), userName('ua').as('approved_by_name')]).where('x.incident_id', '=', i.id).executeTakeFirst();
    const timeline = an ? await ex.selectFrom('qm_analysis_timeline').select(['id', 'at', 'text', 'sort_order']).where('incident_id', '=', i.id).orderBy('sort_order').orderBy('at').execute() : [];
    const factors = an ? await ex.selectFrom('qm_analysis_factors as f').innerJoin('qm_classifiers as c', 'c.id', 'f.factor_id').leftJoin('qm_classifiers as g', 'g.id', 'c.parent_id')
      .select(['f.factor_id', 'f.comment', 'c.name', 'g.name as group_name']).where('f.incident_id', '=', i.id).orderBy('g.sort_order').orderBy('c.sort_order').execute() : [];
    const team = an ? await ex.selectFrom('qm_analysis_team as t').innerJoin('users as tu', 'tu.id', 't.user_id').leftJoin('departments as d', 'd.id', 'tu.department_id')
      .select(['t.user_id', 't.role_text', userName('tu').as('name'), 'd.name as department_name']).where('t.incident_id', '=', i.id).orderBy('t.added_at').execute() : [];
    const capas = await ex.selectFrom('qm_capa_incidents as ci').innerJoin('qm_capas as c', 'c.id', 'ci.capa_id').innerJoin('users as uo', 'uo.id', 'c.owner_id')
      .select(['c.id', 'c.capa_no', 'c.title', 'c.kind', 'c.status', 'c.due_date', 'c.done_at', 'c.effectiveness_due', 'c.effectiveness_result', userName('uo').as('owner_name'),
        sql<boolean>`c.status IN ('open', 'in_progress') AND c.due_date < (now() AT TIME ZONE current_setting('TimeZone'))::date`.as('overdue'),
        sql<number>`(SELECT count(*)::int FROM qm_capa_incidents x WHERE x.capa_id = c.id)`.as('incidents')])
      .where('ci.incident_id', '=', i.id).orderBy('c.created_at').execute();
    const isInv = i.investigator_id === u.id;
    const editable = i.status === 'investigation' && (!an || ['draft', 'returned'].includes(an.status));
    return {
      analysis: an ? { ...an, level_label: LEVEL_KA[an.level], timeline, factors, team } : null,
      capas: capas.map((c) => ({ ...c, status_label: CAPA_STATUS_KA[c.status] })),
      can: {
        edit_analysis: editable && (a === 'full' || a === 'inv'),
        edit_team: editable && (a === 'full' || isInv),
        submit: editable && (a === 'full' || isInv),
        disclose: ['investigation', 'analysis', 'capa'].includes(i.status) && (a === 'full' || isInv),
        add_capa: ['investigation', 'analysis', 'capa'].includes(i.status) && (a === 'full' || isInv),
      },
    };
  }

  /** აქტიური მომხმარებელი (გამომძიებელი / გუნდი / CAPA-ს პასუხისმგებელი) */
  async activeUser(id: string, ex: Ex = this.db) {
    const x = await ex.selectFrom('users').select(['id', 'is_active']).where('id', '=', id).executeTakeFirst();
    if (!x?.is_active) throw new BadRequestException({ code: 'USER', message: 'თანამშრომელი ვერ მოიძებნა ან გათიშულია' });
  }
  async notifyInvestigator(userId: string, id: string, no: string) {
    await this.c.bell([userId], { kind: 'qm_assign', title: `თქვენ ხართ გამომძიებელი: ${no}`, body: 'ინციდენტის ანალიზი — ხარისხი და ინციდენტები → ჩემი ქმედებები', link: `/quality/incidents/${id}`, entityId: id });
  }

  async list(u: AuthUser, q: ListQ) {
    await this.c.rules();
    const scope = await this.c.listScope(u);
    let x = this.db.selectFrom('qm_incidents as i')
      .innerJoin('qm_classifiers as c', 'c.id', 'i.category_id').leftJoin('qm_classifiers as cp', 'cp.id', 'c.parent_id')
      .innerJoin('departments as d', 'd.id', 'i.department_id').leftJoin('patients as p', 'p.id', 'i.patient_id').leftJoin('users as ur', 'ur.id', 'i.reporter_id')
      .select(['i.id', 'i.inc_no', 'i.status', 'i.event_type', 'i.affected', 'i.occurred_at', 'i.reported_at', 'i.department_id', 'd.name as department_name',
        'i.category_id', 'c.name as category_name', 'cp.name as category_parent_name', 'i.harm_reported', 'i.harm', 'i.risk_score', 'i.risk_level', 'i.is_sentinel', 'i.urgent',
        'i.identity_mode', 'i.triage_due_at', 'i.source_label', 'i.patient_text', 'i.patient_id', userName('p').as('patient_name'),
        (scope.full ? userName('ur') : sql<string | null>`CASE WHEN i.identity_mode = 'open' THEN ${userName('ur')} END`).as('reporter_name'),
        sql<string>`left(i.description, 160)`.as('summary'),
        sql<boolean>`i.status = 'submitted' AND i.triage_due_at < now()`.as('overdue'),
        sql<number>`(SELECT count(*)::int FROM qm_incident_files f WHERE f.incident_id = i.id AND f.is_active)`.as('files')])
      .orderBy(sql`(i.status = 'submitted') DESC`).orderBy('i.urgent', 'desc').orderBy('i.reported_at', 'desc').limit(1000);
    if (!scope.full) x = x.where('i.department_id', 'in', scope.depts).where('i.status', 'not in', ['submitted', 'rejected']);
    if (q.status) x = x.where('i.status', 'in', q.status.split(',').filter(Boolean));
    if (q.department_id) x = x.where('i.department_id', '=', q.department_id);
    if (q.category_id) x = x.where((eb) => eb.or([eb('i.category_id', '=', q.category_id!), eb('c.parent_id', '=', q.category_id!)]));
    if (q.harm) x = x.where(sql`coalesce(i.harm, i.harm_reported)`, 'in', q.harm.split(','));
    if (q.event_type) x = x.where('i.event_type', 'in', q.event_type.split(','));
    if (q.risk_level) x = x.where('i.risk_level', 'in', q.risk_level.split(','));
    if (q.from) x = x.where(sql`(i.occurred_at AT TIME ZONE current_setting('TimeZone'))::date`, '>=', q.from);
    if (q.to) x = x.where(sql`(i.occurred_at AT TIME ZONE current_setting('TimeZone'))::date`, '<=', q.to);
    if (q.sentinel === '1') x = x.where('i.is_sentinel', '=', true);
    if (q.urgent === '1') x = x.where('i.urgent', '=', true);
    if (q.overdue === '1') x = x.where('i.status', '=', 'submitted').where('i.triage_due_at', '<', sql<Date>`now()`);
    const s = q.search?.trim();
    if (s) x = x.where((eb) => eb.or([eb('i.inc_no', 'ilike', `%${s}%`), eb('i.description', 'ilike', `%${s}%`), eb('i.source_label', 'ilike', `%${s}%`),
      eb(sql<string>`coalesce(p.first_name || ' ' || p.last_name, i.patient_text, '')`, 'ilike', `%${s}%`), eb('p.personal_number', 'like', `${s}%`)]));
    const rows = await x.execute();
    return rows.map((r) => ({ ...r, status_label: STATUS_KA[r.status] }));
  }

  async summary(u: AuthUser) {
    await this.c.rules();
    const scope = await this.c.listScope(u);
    const w = scope.full ? sql`TRUE` : sql`i.department_id = ANY(${sql.val(scope.depts)}::uuid[]) AND i.status NOT IN ('submitted', 'rejected')`;
    const r = await sql<{ submitted: number; overdue: number; open: number; urgent_open: number; sentinel_open: number; month: number; near_miss_month: number }>`
      SELECT count(*) FILTER (WHERE i.status = 'submitted')::int AS submitted,
             count(*) FILTER (WHERE i.status = 'submitted' AND i.triage_due_at < now())::int AS overdue,
             count(*) FILTER (WHERE i.status IN ('investigation', 'analysis', 'capa'))::int AS open,
             count(*) FILTER (WHERE i.status IN ('submitted', 'investigation', 'analysis', 'capa') AND i.urgent)::int AS urgent_open,
             count(*) FILTER (WHERE i.status IN ('submitted', 'investigation', 'analysis', 'capa') AND i.is_sentinel)::int AS sentinel_open,
             count(*) FILTER (WHERE i.reported_at >= date_trunc('month', now()) AND i.status <> 'rejected')::int AS month,
             count(*) FILTER (WHERE i.reported_at >= date_trunc('month', now()) AND i.status <> 'rejected' AND i.event_type = 'near_miss')::int AS near_miss_month
        FROM qm_incidents i WHERE ${w}`.execute(this.db);
    return { ...r.rows[0], scope: scope.full ? 'all' : 'dept' };
  }

  async mine(u: AuthUser) {
    await this.c.rules();
    const rows = await this.db.selectFrom('qm_incidents as i').innerJoin('qm_classifiers as c', 'c.id', 'i.category_id').innerJoin('departments as d', 'd.id', 'i.department_id')
      .select(['i.id', 'i.inc_no', 'i.status', 'i.event_type', 'i.occurred_at', 'i.reported_at', 'i.identity_mode', 'i.reject_reason', 'c.name as category_name', 'd.name as department_name'])
      .where('i.reporter_id', '=', u.id).orderBy('i.reported_at', 'desc').limit(200).execute();
    return rows.map((r) => ({ ...r, status_label: STATUS_KA[r.status], reject_label: r.reject_reason ? REJECT_KA[r.reject_reason] : null }));
  }

  async track(code?: string) {
    await this.c.rules();
    const c = (code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (c.length !== 16) throw new BadRequestException({ code: 'TRACK_CODE', message: 'კოდი არასწორია (16 სიმბოლო)' });
    const i = await this.db.selectFrom('qm_incidents').select(['inc_no', 'status', 'reported_at', 'reject_reason', 'closed_at', 'feedback_text']).where('track_hash', '=', this.trackHash(c)).executeTakeFirst();
    if (!i) throw new NotFoundException('ასეთი კოდით შეტყობინება ვერ მოიძებნა');
    return { inc_no: i.inc_no, status: i.status, status_label: STATUS_KA[i.status], reported_at: i.reported_at, reject_label: i.reject_reason ? REJECT_KA[i.reject_reason] : null,
      closed_at: i.status === 'closed' ? i.closed_at : null, feedback: i.status === 'closed' ? i.feedback_text : null };
  }

  // ---------------------------------------------------------------- ტრიაჟი / კლასიფიკაცია
  private async lockFull(trx: Trx, id: string, u: AuthUser) {
    if (!has(u, ...QM_FULL)) throw new ForbiddenException('მხოლოდ ხარისხის მენეჯერი');
    const inc = await trx.selectFrom('qm_incidents').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!inc) throw new NotFoundException('ინციდენტი ვერ მოიძებნა');
    return inc;
  }

  /** კლასიფიკაციის ველები (ტრიაჟი და შესწორება): სიმძიმე, რისკი, კატეგორია, განყოფილება, სენტინელური, პაციენტი */
  private async classify(trx: Trx, r: QmRules, inc: { category_id: string; department_id: string; harm: string | null; harm_reported: string; likelihood: number | null; consequence: number | null;
    merp_category: string | null; is_sentinel: boolean; patient_id: string | null; event_type: string }, d: ClassifyDto, requireRisk: boolean) {
    const catChanged = !!d.category_id && d.category_id !== inc.category_id;
    const cat = await this.category(d.category_id ?? inc.category_id, trx).catch((e) => { if (catChanged) throw e; return null; });
    if (d.department_id && d.department_id !== inc.department_id) await this.department(d.department_id, trx);
    const harm = d.harm ?? inc.harm ?? (requireRisk ? undefined : inc.harm_reported);
    const likelihood = d.likelihood ?? inc.likelihood; const consequence = d.consequence ?? inc.consequence;
    if (requireRisk && (!harm || !likelihood || !consequence)) throw new BadRequestException({ code: 'RISK_REQUIRED', message: 'მიღებისას სავალდებულოა: საბოლოო სიმძიმე, ალბათობა და შედეგი (რისკის მატრიცა)' });
    const eventType = d.event_type ?? inc.event_type;
    if (eventType === 'harm' && harm === 'none') throw new BadRequestException({ code: 'HARM', message: 'ინციდენტი ზიანით — ზიანი „არ არის“ ვერ იქნება' });
    if (eventType !== 'harm' && harm && harm !== 'none') throw new BadRequestException({ code: 'HARM', message: 'ზიანის გარეშე / near-miss / სახიფათო — ზიანი „არ არის“' });
    const merp = d.merp_category === undefined ? inc.merp_category : d.merp_category || null;
    if (merp && (!r.ncc_merp || (cat && !cat.medication))) throw new BadRequestException({ code: 'MERP', message: 'NCC MERP კატეგორია მხოლოდ მედიკამენტურ ინციდენტზე' });
    if (d.patient_id && d.patient_id !== inc.patient_id) await this.patientExists(d.patient_id, trx);
    const sentinel = d.is_sentinel ?? (catChanged ? !!cat?.is_sentinel : inc.is_sentinel);
    const score = likelihood && consequence ? likelihood * consequence : null;
    return {
      ...(d.category_id && { category_id: d.category_id }), ...(d.department_id && { department_id: d.department_id }),
      ...(d.patient_id !== undefined && d.patient_id !== null && { patient_id: d.patient_id, patient_text: null }),
      event_type: eventType, harm: harm ?? null, merp_category: merp, likelihood: likelihood ?? null, consequence: consequence ?? null,
      risk_level: score ? this.c.riskLevel(r, score) : null, is_sentinel: sentinel, urgent: this.urgentFor(r, harm ?? inc.harm_reported, sentinel),
    };
  }

  async triage(id: string, d: TriageDto, u: AuthUser, req: Request) {
    const r = await this.c.rules();
    const out = await this.db.transaction().execute(async (trx) => {
      const inc = await this.lockFull(trx, id, u);
      if (inc.status !== 'submitted') throw new ConflictException({ code: 'NOT_SUBMITTED', message: 'ტრიაჟი მხოლოდ ახალ შეტყობინებაზე' });
      if (d.decision === 'reject') {
        if (!d.reject_reason) throw new BadRequestException({ code: 'REJECT_REASON', message: 'მიუთითეთ უარყოფის მიზეზი' });
        if (d.reject_reason === 'duplicate') {
          if (!d.duplicate_of || d.duplicate_of === id) throw new BadRequestException({ code: 'DUPLICATE_OF', message: 'მიუთითეთ ორიგინალი ინციდენტი' });
          const o = await trx.selectFrom('qm_incidents').select(['id', 'status']).where('id', '=', d.duplicate_of).executeTakeFirst();
          if (!o || o.status === 'rejected') throw new BadRequestException({ code: 'DUPLICATE_OF', message: 'ორიგინალი ინციდენტი ვერ მოიძებნა ან უარყოფილია' });
        }
        if (d.reject_reason !== 'duplicate' && (d.note?.trim().length ?? 0) < 3) throw new BadRequestException({ code: 'NOTE_REQUIRED', message: 'უარყოფისას განმარტება სავალდებულოა' });
        await trx.updateTable('qm_incidents').set({ status: 'rejected', reject_reason: d.reject_reason, duplicate_of: d.reject_reason === 'duplicate' ? d.duplicate_of! : null,
          triage_note: d.note?.trim() || null, triaged_at: sql`now()`, triaged_by: u.id }).where('id', '=', id).execute();
        await trx.insertInto('qm_incident_events').values({ incident_id: id, user_id: u.id, kind: 'rejected', text: d.note?.trim() || null,
          data: JSON.stringify({ reason: d.reject_reason, reason_label: REJECT_KA[d.reject_reason], duplicate_of: d.duplicate_of ?? null }) }).execute();
        await this.audit.log(auditCtx(req), { action: 'QM_REJECT', entityName: 'qm_incidents', entityId: id, newData: { reason: d.reject_reason, duplicate_of: d.duplicate_of ?? null } }, trx);
        return { inc, accepted: false, wasUrgent: inc.urgent, urgent: inc.urgent };
      }
      const v = await this.classify(trx, r, inc, d, true);
      if (d.investigator_id) await this.activeUser(d.investigator_id, trx);
      // 0065: ანალიზის დონე და ვადა; ანალიზის მონახაზი
      const level = levelFor(r, { is_sentinel: v.is_sentinel, risk_level: v.risk_level, harm: v.harm });
      const days = level === 'rca' ? r.rca_days : r.review_days;
      await trx.updateTable('qm_incidents').set({ ...v, status: 'investigation', triage_note: d.note?.trim() || null, triaged_at: sql`now()`, triaged_by: u.id,
        analysis_level: level, analysis_due_at: sql`now() + make_interval(days => ${days})`,
        ...(d.investigator_id && { investigator_id: d.investigator_id, investigator_at: sql`now()` }) }).where('id', '=', id).execute();
      await trx.insertInto('qm_analyses').values({ incident_id: id, level }).onConflict((oc) => oc.column('incident_id').doUpdateSet({ level, status: 'draft' })).execute();
      await trx.insertInto('qm_incident_events').values({ incident_id: id, user_id: u.id, kind: 'accepted', text: d.note?.trim() || null,
        data: JSON.stringify({ harm: v.harm, risk: (v.likelihood ?? 0) * (v.consequence ?? 0), risk_level: v.risk_level, sentinel: v.is_sentinel, level }) }).execute();
      if (d.investigator_id) await trx.insertInto('qm_incident_events').values({ incident_id: id, user_id: u.id, kind: 'investigator', data: JSON.stringify({ user_id: d.investigator_id }) }).execute();
      await this.audit.log(auditCtx(req), { action: 'QM_TRIAGE', entityName: 'qm_incidents', entityId: id,
        oldData: { category_id: inc.category_id, department_id: inc.department_id, harm_reported: inc.harm_reported, is_sentinel: inc.is_sentinel }, newData: v }, trx);
      return { inc: { ...inc, ...v }, accepted: true, wasUrgent: inc.urgent, urgent: v.urgent };
    });
    await this.afterTriage(r, out.inc, out.accepted, d.reject_reason, out.wasUrgent, out.urgent);
    if (out.accepted && d.investigator_id) await this.notifyInvestigator(d.investigator_id, id, out.inc.inc_no);
    return this.get(id, u, req, false);
  }

  private async afterTriage(r: QmRules, inc: { id: string; inc_no: string; reporter_id: string | null; department_id: string; harm: string | null; harm_reported: string; is_sentinel: boolean },
    accepted: boolean, reason: string | undefined, wasUrgent: boolean, urgent: boolean) {
    if (r.author_feedback && inc.reporter_id) {
      await this.c.bell([inc.reporter_id], { kind: 'qm_status', title: `თქვენი შეტყობინება ${inc.inc_no}`, entityId: inc.id, link: '/quality?tab=mine',
        body: accepted ? 'მიღებულია და განიხილება. გმადლობთ შეტყობინებისთვის.' : `განხილულია: ${REJECT_KA[reason ?? 'other']}.` });
    }
    if (!accepted) return;
    const dept = await this.db.selectFrom('departments').select('name').where('id', '=', inc.department_id).executeTakeFirst();
    const deptUsers = (await this.c.usersWith(QM_DEPT)).map((x) => x.id);
    const inScope: string[] = [];
    for (const uid of deptUsers) if ((await this.c.userDepts(uid)).includes(inc.department_id)) inScope.push(uid);
    await this.c.bell(inScope, { kind: 'qm_dept', title: `ინციდენტი ${inc.inc_no} — ${dept?.name ?? ''}`, body: 'ხარისხის მენეჯერმა მიიღო განსახილველად', link: `/quality/incidents/${inc.id}`, entityId: inc.id, urgent });
    if (urgent && !wasUrgent) await this.alertUrgent(r, await this.c.usersWith(QM_FULL), inc.id, inc.inc_no, dept?.name ?? '', inc.harm ?? inc.harm_reported, inc.is_sentinel);
  }

  async reclassify(id: string, d: ReclassifyDto, u: AuthUser, req: Request) {
    const r = await this.c.rules();
    await this.db.transaction().execute(async (trx) => {
      const inc = await this.lockFull(trx, id, u);
      if (!OPEN_STATUSES.includes(inc.status)) throw new ConflictException({ code: 'NOT_OPEN', message: 'კლასიფიკაცია იცვლება მხოლოდ მიღებულ, დაუხურავ ინციდენტზე' });
      const v = await this.classify(trx, r, inc, d, true);
      const changed = (Object.keys(v) as (keyof typeof v)[]).filter((k) => String(v[k] ?? '') !== String((inc as Record<string, unknown>)[k] ?? ''));
      if (!changed.length) throw new BadRequestException({ code: 'NO_CHANGE', message: 'ცვლილება არ არის' });
      // 0065: დონე ავტომატურად მხოლოდ მაღლა იწევს (review → rca), ვადა — ტრიაჟიდან rca_days
      const raise = inc.analysis_level === 'review' && levelFor(r, { is_sentinel: v.is_sentinel, risk_level: v.risk_level, harm: v.harm }) === 'rca';
      await trx.updateTable('qm_incidents').set({ ...v, ...(raise && { analysis_level: 'rca' as const, analysis_due_at: sql`coalesce(triaged_at, now()) + make_interval(days => ${r.rca_days})`,
        analysis_warn_sent_at: null, analysis_overdue_sent_at: null }) }).where('id', '=', id).execute();
      if (raise) await trx.updateTable('qm_analyses').set({ level: 'rca' }).where('incident_id', '=', id).execute();
      await trx.insertInto('qm_incident_events').values({ incident_id: id, user_id: u.id, kind: 'reclassified', text: d.reason.trim(), internal: true,
        data: JSON.stringify(Object.fromEntries(changed.map((k) => [k, { from: (inc as Record<string, unknown>)[k] ?? null, to: v[k] ?? null }]))) }).execute();
      await this.audit.log(auditCtx(req), { action: 'QM_RECLASSIFY', entityName: 'qm_incidents', entityId: id,
        oldData: Object.fromEntries(changed.map((k) => [k, (inc as Record<string, unknown>)[k]])), newData: { ...Object.fromEntries(changed.map((k) => [k, v[k]])), reason: d.reason } }, trx);
    });
    return this.get(id, u, req, false);
  }

  async reopen(id: string, d: ReasonDto, u: AuthUser, req: Request) {
    const r = await this.c.rules();
    await this.db.transaction().execute(async (trx) => {
      const inc = await this.lockFull(trx, id, u);
      if (inc.status === 'closed') {
        // 0065: დახურული → გამოძიება (ანალიზი ხელახლა რედაქტირებადია)
        await trx.updateTable('qm_incidents').set({ status: 'investigation', closed_at: null, closed_by: null }).where('id', '=', id).execute();
        await trx.updateTable('qm_analyses').set({ status: 'returned', return_reason: d.reason.trim(), approved_at: null, approved_by: null }).where('incident_id', '=', id).execute();
        await trx.insertInto('qm_incident_events').values({ incident_id: id, user_id: u.id, kind: 'reopened', text: d.reason.trim(), data: JSON.stringify({ from: 'closed' }) }).execute();
        await this.audit.log(auditCtx(req), { action: 'QM_REOPEN', entityName: 'qm_incidents', entityId: id, oldData: { status: 'closed', closure_summary: inc.closure_summary }, newData: { reason: d.reason } }, trx);
        return;
      }
      if (inc.status !== 'rejected') throw new ConflictException({ code: 'NOT_REJECTED', message: 'ხელახლა იხსნება მხოლოდ უარყოფილი ან დახურული' });
      await trx.updateTable('qm_incidents').set({ status: 'submitted', reject_reason: null, duplicate_of: null, triage_note: null, triaged_at: null, triaged_by: null, overdue_notified_at: null,
        triage_due_at: sql`now() + make_interval(hours => ${inc.is_sentinel ? r.sentinel_triage_hours : r.triage_hours})` }).where('id', '=', id).execute();
      await trx.insertInto('qm_incident_events').values({ incident_id: id, user_id: u.id, kind: 'reopened', text: d.reason.trim() }).execute();
      await this.audit.log(auditCtx(req), { action: 'QM_REOPEN', entityName: 'qm_incidents', entityId: id, oldData: { reject_reason: inc.reject_reason }, newData: { reason: d.reason } }, trx);
    });
    return this.get(id, u, req, false);
  }

  // ---------------------------------------------------------------- კომენტარი / ფაილი
  async comment(id: string, d: CommentDto, u: AuthUser, req: Request) {
    await this.c.rules();
    const inc = await this.row(id);
    const a = await this.c.access(u, inc);
    if (!a) throw new NotFoundException('ინციდენტი ვერ მოიძებნა');
    if (inc.status === 'closed') throw new ConflictException({ code: 'CLOSED', message: 'დახურულ ინციდენტზე კომენტარი არ ემატება' });
    if (d.internal && a !== 'full') throw new ForbiddenException('შიდა შენიშვნა — მხოლოდ ხარისხის მენეჯერი');
    const kind = a === 'own' ? 'author_note' : 'comment';
    const e = await this.db.insertInto('qm_incident_events').values({ incident_id: id, user_id: u.id, kind, text: d.text.trim(), internal: !!d.internal && a === 'full' })
      .returning(['id', 'at', 'kind']).executeTakeFirstOrThrow();
    await this.audit.log(auditCtx(req), { action: 'QM_COMMENT', entityName: 'qm_incidents', entityId: id, newData: { kind, internal: !!d.internal } });
    if (a !== 'full') {
      const q = (await this.c.usersWith(QM_FULL)).map((x) => x.id).filter((x) => x !== u.id);
      await this.c.bell(q, { kind: 'qm_comment', title: `ინციდენტი ${inc.inc_no}: ${a === 'own' ? 'ავტორმა დაამატა ინფორმაცია' : 'ახალი კომენტარი'}`, link: `/quality/incidents/${id}`, entityId: id });
    }
    return e;
  }

  async upload(id: string, files: Express.Multer.File[], u: AuthUser, req: Request) {
    await this.c.rules();
    if (!files?.length) throw new BadRequestException('ფაილი არ არის (ველი "files")');
    const inc = await this.row(id);
    const a = await this.c.access(u, inc);
    if (!a) throw new NotFoundException('ინციდენტი ვერ მოიძებნა');
    if (inc.status === 'closed') throw new ConflictException({ code: 'CLOSED', message: 'დახურულ ინციდენტზე ფაილი არ ემატება' });
    const ids = await this.db.transaction().execute(async (trx) => {
      const n = (await trx.selectFrom('qm_incident_files').select(sql<number>`count(*)::int`.as('n')).where('incident_id', '=', id).where('is_active', '=', true).executeTakeFirstOrThrow()).n;
      if (n + files.length > MAX_FILES_PER_INCIDENT) throw new BadRequestException({ code: 'FILES', message: `ინციდენტზე მაქსიმუმ ${MAX_FILES_PER_INCIDENT} ფაილი` });
      const out = await this.storeFiles(trx, id, files, u.id);
      await trx.insertInto('qm_incident_events').values({ incident_id: id, user_id: u.id, kind: 'files', data: JSON.stringify({ count: out.length }) }).execute();
      await this.audit.log(auditCtx(req), { action: 'QM_FILE_UPLOAD', entityName: 'qm_incidents', entityId: id, newData: { files: out } }, trx);
      return out;
    });
    return { files: ids };
  }

  async file(id: string, fid: string, u: AuthUser, req: Request) {
    await this.c.rules();
    const inc = await this.row(id);
    if (!(await this.c.access(u, inc))) throw new NotFoundException('ინციდენტი ვერ მოიძებნა');
    const f = await this.db.selectFrom('qm_incident_files').select(['file_path', 'mime_type', 'original_name']).where('id', '=', fid).where('incident_id', '=', id).where('is_active', '=', true).executeTakeFirst();
    if (!f) throw new NotFoundException('ფაილი ვერ მოიძებნა');
    await this.audit.log(auditCtx(req), { action: 'QM_FILE_VIEW', entityName: 'qm_incident_files', entityId: fid, newData: { incident_id: id } });
    return { stream: await this.storage.get(f.file_path), mime: f.mime_type };
  }
}

const upload = FilesInterceptor('files', 5, { storage: memoryStorage(), limits: { fileSize: MAX_FILE, files: 5 } });

/** ყველა ავტორიზებულს: შეტყობინება, საკუთარი, მეტა, შეთავაზებები, კოდით სტატუსი. რეესტრი / ტრიაჟი — quality / quality_dept (სერვისში) */
@Controller('quality')
export class QmIncidentsController {
  constructor(private readonly s: QmIncidentsService) {}
  @Get('meta') meta(@CurrentUser() u: AuthUser) { return this.s.meta(u); }
  @Get('people') people(@Query('search') search?: string) { return this.s.people(search); }
  @Get('patients') @Roles(...PATIENT_LOOKUP) patients(@Query('q') q?: string) { return this.s.patients(q); }
  @Get('sources') @Roles(...PATIENT_LOOKUP) sources(@Query('patient_id', ParseUUIDPipe) pid: string) { return this.s.sources(pid); }
  @Get('prompts') prompts(@CurrentUser() u: AuthUser) { return this.s.prompts(u); }
  @Post('prompts/dismiss') @HttpCode(200) dismiss(@Body() d: DismissDto, @CurrentUser() u: AuthUser) { return this.s.dismiss(u, d); }
  @Get('track') track(@Query('code') code?: string) { return this.s.track(code); }

  @Post('incidents') @UseInterceptors(upload)
  report(@Body() body: Record<string, unknown>, @UploadedFiles() files: Express.Multer.File[] | undefined, @CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.s.report(body, files ?? [], u, req);
  }
  @Get('incidents') @Roles(...QM_FULL, ...QM_DEPT) list(@CurrentUser() u: AuthUser, @Query() q: ListQ) { return this.s.list(u, q); }
  @Get('incidents/mine') mine(@CurrentUser() u: AuthUser) { return this.s.mine(u); }
  @Get('incidents/summary') @Roles(...QM_FULL, ...QM_DEPT) summary(@CurrentUser() u: AuthUser) { return this.s.summary(u); }
  @Get('incidents/:id') get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.get(id, u, req); }
  @Patch('incidents/:id') edit(@Param('id', ParseUUIDPipe) id: string, @Body() d: EditDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.edit(id, d, u, req); }
  @Post('incidents/:id/triage') @HttpCode(200) @Roles(...QM_FULL)
  triage(@Param('id', ParseUUIDPipe) id: string, @Body() d: TriageDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.triage(id, d, u, req); }
  @Patch('incidents/:id/classification') @Roles(...QM_FULL)
  reclassify(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReclassifyDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.reclassify(id, d, u, req); }
  @Post('incidents/:id/reopen') @HttpCode(200) @Roles(...QM_FULL)
  reopen(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReasonDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.reopen(id, d, u, req); }
  @Post('incidents/:id/comments') comment(@Param('id', ParseUUIDPipe) id: string, @Body() d: CommentDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.comment(id, d, u, req); }
  @Post('incidents/:id/files') @UseInterceptors(upload)
  upload(@Param('id', ParseUUIDPipe) id: string, @UploadedFiles() files: Express.Multer.File[] | undefined, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.upload(id, files ?? [], u, req); }
  @Get('incidents/:id/files/:fid')
  async file(@Param('id', ParseUUIDPipe) id: string, @Param('fid', ParseUUIDPipe) fid: string, @CurrentUser() u: AuthUser, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const f = await this.s.file(id, fid, u, req);
    res.set({ 'Content-Type': f.mime, 'Content-Disposition': 'inline', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    return new StreamableFile(f.stream);
  }
}
