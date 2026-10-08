import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min, ValidateIf, ValidateNested } from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser } from '../auth/roles';
import { InjectDb, type Database } from '../database/database.module';
import { OR_READ } from './or-admin';
import { OrService } from './or';
import { NOTE_FIELDS, noteMissing, orEvent, type Ex, type Trx } from './or-shared';

const num = ({ value }: { value: unknown }) => (value === '' || value === null || value === undefined ? value === '' ? null : value : Number(value));
const LINE_KINDS = ['drain', 'urinary', 'ng_tube', 'cvc', 'arterial', 'pvc', 'picc', 'trach', 'other'] as const;

export class NoteProcDto { @IsUUID() procedure_id: string; @IsOptional() @IsIn(['left', 'right', 'bilateral', 'na']) side?: string; @IsOptional() @IsBoolean() is_primary?: boolean }
export class DrainDto {
  @IsIn(LINE_KINDS) kind: string;
  @IsOptional() @IsString() @MaxLength(200) site?: string;
  @IsOptional() @IsString() @MaxLength(40) size?: string;
  @IsOptional() @IsString() @MaxLength(500) details?: string;
  @IsOptional() @IsUUID() line_id?: string;
}
export class SpecimenDto {
  @IsInt() @Min(1) @Max(30) jar_no: number;
  @IsString() @Length(2, 300) site: string;
  @IsOptional() @IsInt() @Min(1) @Max(50) pieces?: number;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
}
export class NoteDto {
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @Length(2, 10) preop_icd10_code?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @Length(2, 10) postop_icd10_code?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => NoteProcDto) procedures?: NoteProcDto[];
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(20000) description?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(8000) findings?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(4000) complications?: string | null;
  @IsOptional() @IsBoolean() complications_none?: boolean;
  @IsOptional() @Transform(num) @ValidateIf((_, v) => v !== null) @IsInt() @Min(0) @Max(50000) blood_loss_ml?: number | null;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => DrainDto) drains?: DrainDto[];
  @IsOptional() @IsArray() @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => SpecimenDto) specimens?: SpecimenDto[];
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(300) path_lab?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(2000) path_clinical_info?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() template_id?: string | null;
}
export class AmendDto { @IsString() @Length(3, 1000) reason: string }
export class NoteTemplateDto {
  @IsOptional() @IsString() @Length(2, 200) name?: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() procedure_id?: string | null;
  @IsOptional() @IsBoolean() personal?: boolean;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(20000) description?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(8000) findings?: string | null;
  @IsOptional() @IsBoolean() is_active?: boolean;
}

/**
 * ოპერაციის ოქმი (0049, #10): წინა- / პოსტოპ. დიაგნოზი (ICD-10), პროცედურ(ებ)ი, აღწერა (შაბლონი — პროცედურაზე / პერსონალური), აღმოჩენები,
 * გართულებები, სისხლის დაკარგვა, დრენაჟები (→ lines_drains), ბიოფსია (→ გარე პათოლოგიის მიმართვა), იმპლანტები (რეესტრიდან, ავტომატურად).
 * ქირურგის ხელმოწერა → უცვლელი (შესწორება — ახალი ვერსია მიზეზით); ოპერაციის გუნდი / ნიშნულები იბლოკება (locked_at).
 * სავალდებულო ველები (note_required) ბლოკავს ხელმოწერას და ოპერაციის დასრულებას.
 */
@Injectable()
export class OrNoteService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService, private readonly or: OrService) {}

  private async load(id: string, u: AuthUser, ex: Ex = this.db, lock = false) {
    const s = await this.or.settings();
    const c = await this.or.loadCase(id, ex, lock);
    const p = await this.or.perms(u, c, s, ex);
    return { s, c, p };
  }
  private notes(caseId: string, ex: Ex = this.db) {
    return ex.selectFrom('or_op_notes as n').innerJoin('users as a', 'a.id', 'n.author_id').leftJoin('users as sg', 'sg.id', 'n.signed_by').selectAll('n')
      .select([sql<string>`a.last_name || ' ' || a.first_name`.as('author_name'), sql<string | null>`sg.last_name || ' ' || sg.first_name`.as('signed_by_name')])
      .where('n.case_id', '=', caseId).orderBy('n.version', 'desc').orderBy('n.created_at', 'desc').execute();
  }
  private async icd(code: string | null | undefined, ex: Ex) {
    if (!code) return null;
    const c = await ex.selectFrom('icd10_codes').select(['code', 'title', 'is_active']).where('code', '=', code.trim().toUpperCase()).executeTakeFirst();
    if (!c || !c.is_active) throw new BadRequestException(`ICD-10 კოდი ${code} კლასიფიკატორში არ არსებობს`);
    return c;
  }
  private async procSnapshot(ex: Ex, list: NoteProcDto[]) {
    const ids = [...new Set(list.map((p) => p.procedure_id))];
    if (ids.length !== list.length) throw new BadRequestException('პროცედურა მეორდება');
    const rows = ids.length ? await ex.selectFrom('or_procedures').select(['id', 'code', 'name', 'ncsp_code', 'laterality']).where('id', 'in', ids).execute() : [];
    const m = new Map(rows.map((r) => [r.id, r]));
    const prim = Math.max(0, list.findIndex((p) => p.is_primary));
    return list.map((p, i) => {
      const r = m.get(p.procedure_id);
      if (!r) throw new BadRequestException('პროცედურა ვერ მოიძებნა კატალოგში');
      if (r.laterality && (!p.side || p.side === 'na')) throw new BadRequestException(`„${r.name}“ — მიუთითეთ მხარე`);
      return { procedure_id: r.id, code: r.code, name: r.name, ncsp_code: r.ncsp_code, side: p.side ?? 'na', is_primary: i === prim };
    });
  }

  async view(id: string, u: AuthUser) {
    const { s, c, p } = await this.load(id, u);
    const [notes, implants, path, lines, procs, templates] = await Promise.all([
      this.notes(id),
      this.db.selectFrom('patient_implants').selectAll().where('case_id', '=', id).orderBy('implanted_at').execute(),
      this.db.selectFrom('path_requests').select(['id', 'request_no', 'status', 'external_lab', 'sent_at', 'result_text', 'result_received_at', 'reviewed_at']).where('or_case_id', '=', id).executeTakeFirst(),
      this.db.selectFrom('lines_drains').select(['id', 'kind', 'site', 'size', 'inserted_at', 'removed_at']).where('or_case_id', '=', id).where('voided_at', 'is', null).execute(),
      this.db.selectFrom('or_case_procedures as cp').innerJoin('or_procedures as pr', 'pr.id', 'cp.procedure_id')
        .select(['cp.procedure_id', 'cp.side', 'cp.is_primary', 'pr.code', 'pr.name', 'pr.ncsp_code']).where('cp.case_id', '=', id).orderBy('cp.is_primary', 'desc').orderBy('cp.sort_order').execute(),
      this.templates(u, id),
    ]);
    const specimens = path ? await this.db.selectFrom('path_specimens').select(['jar_no', 'site', 'pieces', 'description']).where('request_id', '=', path.id).orderBy('jar_no').execute() : [];
    const draft = notes.find((n) => n.status === 'draft') ?? null;
    const current = notes.find((n) => n.status === 'signed' && !n.superseded_at) ?? null;
    const latest = draft ?? current;
    return {
      case_id: id, case_no: c.case_no, status: c.status, locked_at: c.locked_at, notes, draft, current,
      required: (s.note_required ?? []).map((k) => ({ key: k, label: NOTE_FIELDS[k] ?? k })), missing: noteMissing(latest, s.note_required ?? []),
      defaults: { preop_icd10_code: c.icd10_code, preop_icd10_title: c.icd10_title, procedures: procs },
      implants, pathology: path ? { ...path, specimens } : null, lines, templates,
      can: { edit: p.note && (!current || !!draft), sign: p.note_sign && !!draft, amend: p.note_sign && !!current && !draft },
    };
  }

  /** შავი ვერსია: შექმნა / განახლება (ხელმოწერილის შემდეგ — მხოლოდ „შესწორებით“) */
  async save(id: string, dto: NoteDto, u: AuthUser, ctx: AuditContext) {
    await this.db.transaction().execute(async (trx) => {
      const { c, p } = await this.load(id, u, trx, true);
      if (!p.note) throw new ForbiddenException('ოქმი — ქირურგიული გუნდი (ოპერატორი, ასისტენტი), განყოფილების ხელმძღვანელი, admin');
      if (!['in_progress', 'completed'].includes(c.status)) throw new ConflictException('ოქმი — დაწყებულ ოპერაციაზე');
      let draft = await trx.selectFrom('or_op_notes').selectAll().where('case_id', '=', c.id).where('status', '=', 'draft').forUpdate().executeTakeFirst();
      if (!draft) {
        const cur = await trx.selectFrom('or_op_notes').select('id').where('case_id', '=', c.id).where('status', '=', 'signed').executeTakeFirst();
        if (cur) throw new ConflictException({ code: 'NOTE_SIGNED', message: 'ოქმი ხელმოწერილია — ცვლილებისთვის შექმენით შესწორებული ვერსია (მიზეზით)' });
        const procs = await trx.selectFrom('or_case_procedures as cp').innerJoin('or_procedures as pr', 'pr.id', 'cp.procedure_id')
          .select(['cp.procedure_id', 'cp.side', 'cp.is_primary', 'pr.code', 'pr.name', 'pr.ncsp_code']).where('cp.case_id', '=', c.id).orderBy('cp.is_primary', 'desc').orderBy('cp.sort_order').execute();
        draft = await trx.insertInto('or_op_notes').values({ case_id: c.id, patient_id: c.patient_id, author_id: u.id, preop_icd10_code: c.icd10_code, preop_icd10_title: c.icd10_title,
          procedures: JSON.stringify(procs) }).returningAll().executeTakeFirstOrThrow();
      }
      const [pre, post] = await Promise.all([dto.preop_icd10_code !== undefined ? this.icd(dto.preop_icd10_code, trx) : undefined, dto.postop_icd10_code !== undefined ? this.icd(dto.postop_icd10_code, trx) : undefined]);
      if (dto.specimens) {
        const nos = dto.specimens.map((x) => x.jar_no);
        if (new Set(nos).size !== nos.length) throw new BadRequestException('ქილების ნომრები მეორდება');
      }
      if (dto.template_id) {
        const t = await trx.selectFrom('or_note_templates').select(['id', 'owner_id', 'is_active']).where('id', '=', dto.template_id).executeTakeFirst();
        if (!t?.is_active || (t.owner_id && t.owner_id !== u.id)) throw new BadRequestException('შაბლონი ვერ მოიძებნა');
      }
      const compNone = dto.complications_none ?? (dto.complications?.trim() ? false : undefined);
      const v = {
        ...(pre !== undefined && { preop_icd10_code: pre?.code ?? null, preop_icd10_title: pre?.title ?? null }),
        ...(post !== undefined && { postop_icd10_code: post?.code ?? null, postop_icd10_title: post?.title ?? null }),
        ...(dto.procedures !== undefined && { procedures: JSON.stringify(await this.procSnapshot(trx, dto.procedures)) }),
        ...(dto.description !== undefined && { description: dto.description?.trim() || null }), ...(dto.findings !== undefined && { findings: dto.findings?.trim() || null }),
        ...(dto.complications !== undefined && { complications: dto.complications?.trim() || null }), ...(compNone !== undefined && { complications_none: compNone }),
        ...(compNone === true && { complications: null }),
        ...(dto.blood_loss_ml !== undefined && { blood_loss_ml: dto.blood_loss_ml }),
        ...(dto.drains !== undefined && { drains: JSON.stringify(dto.drains.map((d) => ({ kind: d.kind, site: d.site?.trim() || null, size: d.size?.trim() || null, details: d.details?.trim() || null,
          line_id: d.line_id && (draft!.drains as { line_id?: string }[]).some((x) => x.line_id === d.line_id) ? d.line_id : null }))) }),
        ...(dto.specimens !== undefined && { specimens: JSON.stringify(dto.specimens.map((x) => ({ jar_no: x.jar_no, site: x.site.trim(), pieces: x.pieces ?? 1, description: x.description?.trim() || null }))) }),
        ...(dto.path_lab !== undefined && { path_lab: dto.path_lab?.trim() || null }), ...(dto.path_clinical_info !== undefined && { path_clinical_info: dto.path_clinical_info?.trim() || null }),
        ...(dto.template_id !== undefined && { template_id: dto.template_id }),
      };
      if (Object.keys(v).length) await trx.updateTable('or_op_notes').set(v).where('id', '=', draft.id).execute();
      await this.audit.log(ctx, { action: 'OR_NOTE_SAVE', entityName: 'or_op_notes', entityId: draft.id, newData: dto }, trx);
    });
    return this.view(id, u);
  }

  /** ხელმოწერა: სავალდებულო ველები → დრენაჟები (ხაზები), ბიოფსია (მიმართვა), იმპლანტები (სნეპშოტი) → უცვლელი; გუნდი / ნიშნულები იბლოკება */
  async sign(id: string, u: AuthUser, ctx: AuditContext) {
    await this.db.transaction().execute(async (trx) => {
      const { s, c, p } = await this.load(id, u, trx, true);
      if (!p.note_sign) throw new ForbiddenException('ოქმს ხელს აწერს ოპერატორი ქირურგი / განყოფილების ხელმძღვანელი / admin');
      const d = await trx.selectFrom('or_op_notes').selectAll().where('case_id', '=', c.id).where('status', '=', 'draft').forUpdate().executeTakeFirst();
      if (!d) throw new BadRequestException('ხელმოსაწერი (შავი) ვერსია არ არის');
      const times = new Map((await trx.selectFrom('or_case_times').select(['kind', 'at']).where('case_id', '=', c.id).where('superseded_by', 'is', null).execute()).map((t) => [t.kind, new Date(t.at)]));
      if (!times.has('closure')) throw new ConflictException({ code: 'NOTE_TOO_EARLY', message: 'ოქმის ხელმოწერა — „ნაკერის“ ნიშნულის შემდეგ' });
      const miss = noteMissing(d, s.note_required ?? []);
      if (miss.length) throw new BadRequestException({ code: 'NOTE_INCOMPLETE', message: `ოქმი: სავალდებულო ველები შესავსებია — ${miss.join(', ')}`, missing: miss });
      const events: Record<string, unknown> = { version: d.version };
      // დრენაჟები → ხაზები / დრენაჟები (0044)
      const drains = d.drains as { kind: string; site: string | null; size: string | null; details: string | null; line_id: string | null }[];
      let newLines = 0;
      for (const dr of drains) {
        if (dr.line_id || !c.encounter_id) continue;
        const l = await trx.insertInto('lines_drains').values({ encounter_id: c.encounter_id, patient_id: c.patient_id, kind: dr.kind, site: dr.site, size: dr.size, details: dr.details,
          inserted_at: times.get('closure') ?? new Date(), inserted_by: c.surgeon_id, inserted_where: `ოპერაცია ${c.case_no}`, created_by: u.id, or_case_id: c.id }).returning('id').executeTakeFirstOrThrow();
        dr.line_id = l.id; newLines++;
        await trx.insertInto('inpatient_events').values({ encounter_id: c.encounter_id, kind: 'line_inserted', data: JSON.stringify({ line_id: l.id, kind: dr.kind, site: dr.site, or_case_id: c.id }), user_id: u.id }).execute();
      }
      if (newLines) events.drains = newLines;
      // ბიოფსია → გარე პათოლოგიის მიმართვა (შავი; იგზავნება პათოლოგიის რეესტრიდან)
      const specs = d.specimens as { jar_no: number; site: string; pieces: number; description: string | null }[];
      if (specs.length) events.pathology = await this.pathology(trx, c, d, specs, u);
      // იმპლანტები — რეესტრიდან (ავტომატურად)
      const implants = await trx.selectFrom('patient_implants').select(['id', 'name', 'manufacturer', 'lot_no', 'serial_no', 'site', 'implanted_at']).where('case_id', '=', c.id).execute();
      if (d.amends_id) await trx.updateTable('or_op_notes').set({ superseded_at: sql`now()` }).where('id', '=', d.amends_id).execute();
      await trx.updateTable('or_op_notes').set({ status: 'signed', signed_by: u.id, signed_at: sql`now()`, drains: JSON.stringify(drains), implants: JSON.stringify(implants) }).where('id', '=', d.id).execute();
      await trx.updateTable('or_cases').set({ locked_at: sql`coalesce(locked_at, now())`, updated_by: u.id }).where('id', '=', c.id).execute();
      await orEvent(trx, c, 'note_signed', { ...events, implants: implants.length }, u.id, 'or_note_signed');
      await this.audit.log(ctx, { action: 'OR_NOTE_SIGN', entityName: 'or_op_notes', entityId: d.id, newData: events }, trx);
    });
    return this.view(id, u);
  }

  private async pathology(trx: Trx, c: { id: string; patient_id: string; case_no: string }, d: { path_lab: string | null; path_clinical_info: string | null; postop_icd10_code: string | null; postop_icd10_title: string | null },
                          specs: { jar_no: number; site: string; pieces: number; description: string | null }[], u: AuthUser) {
    let req = await trx.selectFrom('path_requests').select(['id', 'status', 'request_no']).where('or_case_id', '=', c.id).forUpdate().executeTakeFirst();
    const info = d.path_clinical_info ?? (d.postop_icd10_code ? `${d.postop_icd10_code} ${d.postop_icd10_title ?? ''} · ოპერაცია ${c.case_no}`.trim() : `ოპერაცია ${c.case_no}`);
    if (req && req.status !== 'draft') return `${req.request_no} (უკვე ${req.status === 'cancelled' ? 'გაუქმებულია' : 'გაგზავნილია'} — ქილები არ შეიცვალა)`;
    if (!req) {
      const { rows: [{ n }] } = await sql<{ n: string }>`SELECT nextval('path_request_seq') AS n`.execute(trx);
      req = await trx.insertInto('path_requests').values({ or_case_id: c.id, patient_id: c.patient_id, request_no: `P${new Date().getFullYear() % 100}-${String(n).padStart(6, '0')}`,
        external_lab: d.path_lab, clinical_info: info, created_by: u.id }).returning(['id', 'status', 'request_no']).executeTakeFirstOrThrow();
    } else {
      await trx.updateTable('path_requests').set({ external_lab: d.path_lab, clinical_info: info }).where('id', '=', req.id).execute();
      await trx.deleteFrom('path_specimens').where('request_id', '=', req.id).execute();
    }
    await trx.insertInto('path_specimens').values(specs.map((x) => ({ request_id: req!.id, jar_no: x.jar_no, site: x.site, pieces: x.pieces ?? 1, description: x.description, fixative: 'ფორმალინი 10%' }))).execute();
    await orEvent(trx, { id: c.id, encounter_id: null }, 'pathology', { request_no: req.request_no, jars: specs.length }, u.id);
    return req.request_no;
  }

  /** შესწორება: ხელმოწერილის ასლი → ახალი შავი ვერსია (მიზეზით); ხელმოწერისას წინა — superseded */
  async amend(id: string, reason: string, u: AuthUser, ctx: AuditContext) {
    await this.db.transaction().execute(async (trx) => {
      const { p, c } = await this.load(id, u, trx, true);
      if (!p.note_sign) throw new ForbiddenException('შესწორება — ოპერატორი ქირურგი / განყოფილების ხელმძღვანელი / admin');
      const cur = await trx.selectFrom('or_op_notes').selectAll().where('case_id', '=', c.id).where('status', '=', 'signed').where('superseded_at', 'is', null).executeTakeFirst();
      if (!cur) throw new BadRequestException('ხელმოწერილი ოქმი არ არის');
      if (await trx.selectFrom('or_op_notes').select('id').where('case_id', '=', c.id).where('status', '=', 'draft').executeTakeFirst()) throw new ConflictException('შესწორება უკვე მიმდინარეობს (შავი ვერსია)');
      const n = await trx.insertInto('or_op_notes').values({ case_id: c.id, patient_id: c.patient_id, version: cur.version + 1, root_id: cur.root_id ?? cur.id, amends_id: cur.id, amend_reason: reason,
        preop_icd10_code: cur.preop_icd10_code, preop_icd10_title: cur.preop_icd10_title, postop_icd10_code: cur.postop_icd10_code, postop_icd10_title: cur.postop_icd10_title,
        procedures: JSON.stringify(cur.procedures), description: cur.description, findings: cur.findings, complications: cur.complications, complications_none: cur.complications_none,
        blood_loss_ml: cur.blood_loss_ml, drains: JSON.stringify(cur.drains), specimens: JSON.stringify(cur.specimens), path_lab: cur.path_lab, path_clinical_info: cur.path_clinical_info,
        template_id: cur.template_id, author_id: u.id }).returning('id').executeTakeFirstOrThrow();
      await orEvent(trx, c, 'note_amend', { version: cur.version + 1, reason }, u.id);
      await this.audit.log(ctx, { action: 'OR_NOTE_AMEND', entityName: 'or_op_notes', entityId: n.id, newData: { reason } }, trx);
    });
    return this.view(id, u);
  }

  // ================================================================= შაბლონები
  /** ხილული შაბლონები: პროცედურის (ოპერაციის პროცედურებზე, ან ყველა admin-ს) + პერსონალური */
  async templates(u: AuthUser, caseId?: string, all = false) {
    let procIds: string[] | null = null;
    if (caseId) procIds = (await this.db.selectFrom('or_case_procedures').select('procedure_id').where('case_id', '=', caseId).execute()).map((r) => r.procedure_id);
    return this.db.selectFrom('or_note_templates as t').leftJoin('or_procedures as p', 'p.id', 't.procedure_id').leftJoin('users as o', 'o.id', 't.owner_id')
      .select(['t.id', 't.name', 't.procedure_id', 'p.name as procedure_name', 'p.code as procedure_code', 't.owner_id', sql<string | null>`o.last_name || ' ' || o.first_name`.as('owner_name'),
        't.description', 't.findings', 't.is_active', 't.updated_at'])
      .$if(!all, (q) => q.where('t.is_active', '=', true))
      .where((eb) => eb.or([
        eb('t.owner_id', '=', u.id),
        eb.and([eb('t.owner_id', 'is', null), procIds ? (procIds.length ? eb('t.procedure_id', 'in', procIds) : eb.val(false)) : eb.val(true)]),
      ]))
      .orderBy('t.name').limit(300).execute();
  }

  async saveTemplate(id: string | null, dto: NoteTemplateDto, u: AuthUser, ctx: AuditContext) {
    const admin = has(u, 'admin');
    return this.db.transaction().execute(async (trx) => {
      const old = id ? await trx.selectFrom('or_note_templates').selectAll().where('id', '=', id).forUpdate().executeTakeFirst() : null;
      if (id && !old) throw new NotFoundException('შაბლონი ვერ მოიძებნა');
      const personal = old ? !!old.owner_id : !!dto.personal;
      if (personal ? (old && old.owner_id !== u.id && !admin) || (!old && !has(u, 'doctor', 'admin')) : !admin) {
        throw new ForbiddenException(personal ? 'პერსონალური შაბლონი — მხოლოდ მფლობელი' : 'პროცედურის შაბლონი — admin');
      }
      if (!old && (!dto.name || (!personal && !dto.procedure_id))) throw new BadRequestException(personal ? 'დასახელება სავალდებულოა' : 'დასახელება და პროცედურა სავალდებულოა');
      if (dto.procedure_id && !(await trx.selectFrom('or_procedures').select('id').where('id', '=', dto.procedure_id).executeTakeFirst())) throw new BadRequestException('პროცედურა ვერ მოიძებნა');
      if (!personal && dto.procedure_id === null) throw new BadRequestException('პროცედურის შაბლონს პროცედურა სჭირდება');
      const v = { ...(dto.name !== undefined && { name: dto.name.trim() }), ...(dto.procedure_id !== undefined && { procedure_id: dto.procedure_id }),
        ...(dto.description !== undefined && { description: dto.description?.trim() || null }), ...(dto.findings !== undefined && { findings: dto.findings?.trim() || null }),
        ...(dto.is_active !== undefined && { is_active: dto.is_active }) };
      const r = old ? await trx.updateTable('or_note_templates').set(v).where('id', '=', old.id).returningAll().executeTakeFirstOrThrow()
        : await trx.insertInto('or_note_templates').values({ ...v, name: dto.name!.trim(), owner_id: personal ? u.id : null, created_by: u.id }).returningAll().executeTakeFirstOrThrow();
      await this.audit.log(ctx, { action: old ? 'OR_NOTE_TEMPLATE_UPDATE' : 'OR_NOTE_TEMPLATE_CREATE', entityName: 'or_note_templates', entityId: r.id, newData: dto }, trx);
      return r;
    });
  }
}

@Controller('or')
export class OrNoteController {
  constructor(private readonly s: OrNoteService) {}
  @Get('cases/:id/note') @Roles(...OR_READ) view(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser) { return this.s.view(id, u); }
  @Put('cases/:id/note') @Roles('admin', 'doctor')
  save(@Param('id', ParseUUIDPipe) id: string, @Body() d: NoteDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.save(id, d, u, auditCtx(r)); }
  @Post('cases/:id/note/sign') @HttpCode(200) @Roles('admin', 'doctor')
  sign(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.sign(id, u, auditCtx(r)); }
  @Post('cases/:id/note/amend') @HttpCode(200) @Roles('admin', 'doctor')
  amend(@Param('id', ParseUUIDPipe) id: string, @Body() d: AmendDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.amend(id, d.reason, u, auditCtx(r)); }
  @Get('note-templates') @Roles('admin', 'doctor') templates(@CurrentUser() u: AuthUser, @Query('all') all?: string) { return this.s.templates(u, undefined, all === 'true'); }
  @Post('note-templates') @Roles('admin', 'doctor') addTpl(@Body() d: NoteTemplateDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.saveTemplate(null, d, u, auditCtx(r)); }
  @Patch('note-templates/:id') @Roles('admin', 'doctor')
  updTpl(@Param('id', ParseUUIDPipe) id: string, @Body() d: NoteTemplateDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.saveTemplate(id, d, u, auditCtx(r)); }
}
