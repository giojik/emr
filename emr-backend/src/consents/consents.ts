import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Injectable, Module, NotFoundException,
  Param, ParseUUIDPipe, Post, Put, Query, Req, Res, StreamableFile } from '@nestjs/common';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, MaxLength, Min } from 'class-validator';
import type { Request, Response } from 'express';
import { sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/roles';
import { InjectDb, type Database } from '../database/database.module';
import { PatientFilesModule, PatientFilesService, sniffMime } from '../patient-files/patient-files';
import { ClinicSettingsModule, ClinicSettingsService } from '../settings/clinic-settings';
import { renderConsent } from './consent.pdf';

export class CreateConsentDto {
  @IsString() @Length(2, 40) type_code: string;
  @IsIn(['granted', 'refused']) decision: 'granted' | 'refused';
  @IsIn(['paper', 'electronic']) method: 'paper' | 'electronic';
  @IsIn(['patient', 'representative']) signer_type: 'patient' | 'representative';
  @IsOptional() @IsString() @MaxLength(200) representative_name?: string;
  @IsOptional() @IsString() @MaxLength(100) representative_relation?: string;
  @IsOptional() @IsString() @MaxLength(50) representative_id_number?: string;
  @IsOptional() @IsUUID() encounter_id?: string;
  @IsOptional() @IsUUID() file_id?: string;                         // paper: ატვირთული სკანი (doc_type=consent_scan)
  @IsOptional() @IsString() @MaxLength(700_000) signature_png?: string;   // electronic: data:image/png;base64,...
}
export class RevokeConsentDto { @IsString() @Length(5, 1000) reason: string }
export class UpdateConsentTypeDto {
  @IsOptional() @IsString() @Length(3, 300) name?: string;
  @IsOptional() @IsString() @Length(20, 50_000) body_text?: string;
  @IsOptional() @IsBoolean() text_approved?: boolean;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsInt() @Min(0) sort_order?: number;
}

type Status = 'granted' | 'refused' | 'revoked' | 'missing';

@Injectable()
export class ConsentsService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService,
              private readonly files: PatientFilesService, private readonly settings: ClinicSettingsService) {}

  private currentVersions() {
    return this.db.selectFrom('consent_types as t')
      .innerJoin('consent_type_versions as v', (j) => j.onRef('v.type_code', '=', 't.code')
        .on('v.version', '=', (eb) => eb.selectFrom('consent_type_versions as v2').select((e) => e.fn.max('v2.version').as('m')).whereRef('v2.type_code', '=', 't.code')))
      .select(['t.code', 't.name', 't.scope', 't.is_active', 't.sort_order', 'v.id as version_id', 'v.version', 'v.body_text', 'v.text_approved', 'v.created_at as version_created_at'])
      .orderBy('t.sort_order');
  }

  types(activeOnly: boolean) {
    let q = this.currentVersions();
    if (activeOnly) q = q.where('t.is_active', '=', true);
    return q.execute();
  }

  /** ტექსტის ან დამტკიცების ცვლილება = ახალი ვერსია (ძველ ვერსიაზე მოწერილი თანხმობები ხელუხლებელია) */
  async updateType(code: string, dto: UpdateConsentTypeDto, user: AuthUser, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const cur = await this.currentVersions().where('t.code', '=', code).executeTakeFirst();
      if (!cur) throw new NotFoundException('თანხმობის ტიპი ვერ მოიძებნა');
      const meta: Record<string, unknown> = {};
      if (dto.name !== undefined) meta.name = dto.name;
      if (dto.is_active !== undefined) meta.is_active = dto.is_active;
      if (dto.sort_order !== undefined) meta.sort_order = dto.sort_order;
      if (Object.keys(meta).length) await trx.updateTable('consent_types').set(meta).where('code', '=', code).execute();
      const textChanged = dto.body_text !== undefined && dto.body_text.trim() !== cur.body_text;
      const approveChanged = dto.text_approved !== undefined && dto.text_approved !== cur.text_approved;
      let version = cur.version;
      if (textChanged || approveChanged) {
        version = cur.version + 1;
        await trx.insertInto('consent_type_versions').values({
          type_code: code, version, body_text: textChanged ? dto.body_text!.trim() : cur.body_text,
          text_approved: dto.text_approved ?? (textChanged ? false : cur.text_approved), created_by: user.id,
        }).execute();
      }
      await this.audit.log(ctx, { action: 'UPDATE_CONSENT_TYPE', entityName: 'consent_types', entityId: code,
        newData: { ...meta, new_version: version !== cur.version ? version : undefined, text_changed: textChanged, text_approved: dto.text_approved } }, trx);
      return this.currentVersions().where('t.code', '=', code).executeTakeFirstOrThrow();
    });
  }

  /** პაციენტის თანხმობები: მიმდინარე სტატუსი თითო ტიპზე + ისტორია */
  async forPatient(patientId: string, encounterId?: string) {
    const [types, rows] = await Promise.all([
      this.types(true),
      this.db.selectFrom('patient_consents as c')
        .innerJoin('consent_type_versions as v', 'v.id', 'c.version_id')
        .leftJoin('users as u', 'u.id', 'c.recorded_by')
        .select(['c.id', 'c.type_code', 'c.encounter_id', 'c.decision', 'c.method', 'c.signer_type', 'c.representative_name', 'c.representative_relation',
          'c.file_id', 'c.signed_at', 'c.revoked_at', 'c.revoke_reason', 'v.version', 'v.text_approved',
          sql<string>`u.first_name || ' ' || u.last_name`.as('recorded_by_name')])
        .where('c.patient_id', '=', patientId).orderBy('c.signed_at', 'desc').execute(),
    ]);
    return types.map((t) => {
      const relevant = rows.filter((r) => r.type_code === t.code && (t.scope === 'patient' || (encounterId ? r.encounter_id === encounterId : true)));
      const latest = t.scope === 'encounter' && !encounterId ? undefined : relevant[0];
      const status: Status = !latest ? 'missing' : latest.revoked_at ? 'revoked' : (latest.decision as 'granted' | 'refused');
      return {
        code: t.code, name: t.name, scope: t.scope, version: t.version, text_approved: t.text_approved, status,
        outdated: !!latest && latest.version < t.version,
        latest: latest ?? null, history: relevant,
      };
    });
  }

  /** აქტიური თანხმობის შემოწმება — მაგ. მომავალში კლინიკებს შორის მონაცემთა გაცვლამდე */
  async hasActive(patientId: string, code: string) {
    const r = await this.db.selectFrom('patient_consents').select(['decision', 'revoked_at'])
      .where('patient_id', '=', patientId).where('type_code', '=', code).orderBy('signed_at', 'desc').executeTakeFirst();
    return !!r && r.decision === 'granted' && !r.revoked_at;
  }

  private async context(patientId: string, typeCode: string, encounterId?: string) {
    const [type, clinic, patient] = await Promise.all([
      this.currentVersions().where('t.code', '=', typeCode).where('t.is_active', '=', true).executeTakeFirst(),
      this.settings.get(),
      this.db.selectFrom('patients').select(['id', 'first_name', 'last_name', 'birth_date', 'personal_number', 'passport_number', 'address'])
        .where('id', '=', patientId).executeTakeFirst(),
    ]);
    if (!type) throw new NotFoundException('თანხმობის ტიპი ვერ მოიძებნა ან გათიშულია');
    if (!patient) throw new NotFoundException('პაციენტი ვერ მოიძებნა');
    let encounterDate: string | null = null;
    if (type.scope === 'encounter') {
      if (!encounterId) throw new BadRequestException('ამ თანხმობას სჭირდება ვიზიტი (encounter_id)');
      const e = await this.db.selectFrom('encounters').select(['patient_id', 'start_time', 'status']).where('id', '=', encounterId).executeTakeFirst();
      if (!e || e.patient_id !== patientId) throw new BadRequestException('ვიზიტი ამ პაციენტს არ ეკუთვნის');
      encounterDate = e.start_time.toISOString();
    }
    return { type, clinic, patient, encounterDate };
  }

  async blankForm(patientId: string, typeCode: string, encounterId: string | undefined, ctx: AuditContext) {
    const c = await this.context(patientId, typeCode, encounterId);
    await this.audit.log(ctx, { action: 'PRINT_CONSENT_FORM', entityName: 'patients', entityId: patientId, newData: { type: typeCode, version: c.type.version } });
    return renderConsent({
      clinic: c.clinic, title: c.type.name, version: c.type.version, body: c.type.body_text, textApproved: c.type.text_approved,
      patient: { name: `${c.patient.first_name} ${c.patient.last_name}`, birthDate: c.patient.birth_date, idNumber: c.patient.personal_number ?? c.patient.passport_number, address: c.patient.address },
      encounterDate: c.encounterDate, mode: 'blank',
    });
  }

  async create(patientId: string, dto: CreateConsentDto, user: AuthUser, ctx: AuditContext) {
    const c = await this.context(patientId, dto.type_code, dto.encounter_id);
    if (!(c.clinic.consent_methods ?? []).includes(dto.method)) throw new BadRequestException(`ხელმოწერის მეთოდი "${dto.method}" ამ კლინიკაში გათიშულია`);
    if (dto.signer_type === 'representative' && (!dto.representative_name?.trim() || !dto.representative_relation?.trim())) {
      throw new BadRequestException('წარმომადგენლის სახელი და კავშირი სავალდებულოა');
    }

    return this.db.transaction().execute(async (trx) => {
      let fileId: string;
      if (dto.method === 'paper') {
        if (!dto.file_id) throw new BadRequestException('ქაღალდის მეთოდს სჭირდება ხელმოწერილი ფურცლის სკანი (file_id)');
        const f = await trx.selectFrom('patient_files').select(['id', 'patient_id', 'doc_type', 'is_active']).where('id', '=', dto.file_id).executeTakeFirst();
        if (!f || f.patient_id !== patientId || !f.is_active || f.doc_type !== 'consent_scan') throw new BadRequestException('სკანი ვერ მოიძებნა (ტიპი: თანხმობის სკანი)');
        const used = await trx.selectFrom('patient_consents').select('id').where('file_id', '=', f.id).executeTakeFirst();
        if (used) throw new ConflictException('ეს სკანი სხვა თანხმობაზეა მიბმული');
        fileId = f.id;
      } else {
        const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dto.signature_png ?? '');
        const png = m ? Buffer.from(m[1], 'base64') : null;
        if (!png || sniffMime(png) !== 'image/png' || png.length < 500) throw new BadRequestException('ელექტრონული ხელმოწერა ცარიელია ან არასწორია');
        const consentId = randomUUID();
        const pdf = await renderConsent({
          clinic: c.clinic, title: c.type.name, version: c.type.version, body: c.type.body_text, textApproved: c.type.text_approved,
          patient: { name: `${c.patient.first_name} ${c.patient.last_name}`, birthDate: c.patient.birth_date, idNumber: c.patient.personal_number ?? c.patient.passport_number, address: c.patient.address },
          encounterDate: c.encounterDate, mode: 'electronic', decision: dto.decision,
          signer: { type: dto.signer_type, name: dto.representative_name, relation: dto.representative_relation, idNumber: dto.representative_id_number },
          signaturePng: png, signedAt: new Date(), recordedBy: user.name, documentId: consentId,
        });
        const f = await this.files.store({ patientId, docType: 'consent_signed', data: pdf, originalName: `${dto.type_code}.pdf`, userId: user.id }, ctx, trx);
        fileId = f.id;
      }
      const row = await trx.insertInto('patient_consents').values({
        patient_id: patientId, encounter_id: c.type.scope === 'encounter' ? dto.encounter_id! : null, type_code: dto.type_code, version_id: c.type.version_id,
        decision: dto.decision, method: dto.method, signer_type: dto.signer_type,
        representative_name: dto.signer_type === 'representative' ? dto.representative_name!.trim() : null,
        representative_relation: dto.signer_type === 'representative' ? dto.representative_relation!.trim() : null,
        representative_id_number: dto.signer_type === 'representative' ? dto.representative_id_number?.trim() || null : null,
        file_id: fileId, recorded_by: user.id,
      }).returningAll().executeTakeFirstOrThrow();
      await this.audit.log(ctx, { action: dto.decision === 'granted' ? 'CONSENT_GRANTED' : 'CONSENT_REFUSED', entityName: 'patient_consents', entityId: row.id,
        newData: { patient_id: patientId, type: dto.type_code, version: c.type.version, method: dto.method, signer: dto.signer_type } }, trx);
      return { ...row, text_approved: c.type.text_approved };
    });
  }

  /** გაუქმება (პაციენტის მოთხოვნით). ჩანაწერი რჩება, ისტორია არ იკარგება. */
  async revoke(id: string, reason: string, user: AuthUser, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const c = await trx.selectFrom('patient_consents').select(['id', 'decision', 'revoked_at']).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!c) throw new NotFoundException('თანხმობა ვერ მოიძებნა');
      if (c.revoked_at) throw new ConflictException('თანხმობა უკვე გაუქმებულია');
      if (c.decision !== 'granted') throw new ForbiddenException('გაუქმება შეიძლება მხოლოდ გაცემული თანხმობის');
      await trx.updateTable('patient_consents').set({ revoked_at: sql`now()`, revoke_reason: reason, revoked_by: user.id }).where('id', '=', id).execute();
      await this.audit.log(ctx, { action: 'CONSENT_REVOKED', entityName: 'patient_consents', entityId: id, newData: { reason } }, trx);
      return { id, status: 'revoked' };
    });
  }
}

const FRONT = ['admin', 'receptionist', 'doctor', 'nurse'] as const;

@Controller()
export class ConsentsController {
  constructor(private readonly consents: ConsentsService) {}

  @Get('consent-types')
  types(@Query('all') all?: string) { return this.consents.types(all !== 'true'); }

  @Put('consent-types/:code') @Roles('admin')
  update(@Param('code') code: string, @Body() dto: UpdateConsentTypeDto, @CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.consents.updateType(code, dto, u, auditCtx(req));
  }

  @Get('patients/:id/consents') @Roles(...FRONT, 'billing')
  list(@Param('id', ParseUUIDPipe) id: string, @Query('encounter_id') encounterId?: string) { return this.consents.forPatient(id, encounterId); }

  @Get('patients/:id/consents/:code/form') @Roles(...FRONT)
  async form(@Param('id', ParseUUIDPipe) id: string, @Param('code') code: string, @Query('encounter_id') encounterId: string | undefined,
             @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const pdf = await this.consents.blankForm(id, code, encounterId, auditCtx(req));
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline', 'Cache-Control': 'no-store' });
    return new StreamableFile(pdf);
  }

  @Post('patients/:id/consents') @Roles(...FRONT)
  create(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateConsentDto, @CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.consents.create(id, dto, u, auditCtx(req));
  }

  @Post('consents/:cid/revoke') @Roles(...FRONT)
  revoke(@Param('cid', ParseUUIDPipe) cid: string, @Body() dto: RevokeConsentDto, @CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.consents.revoke(cid, dto.reason, u, auditCtx(req));
  }
}

@Module({ imports: [PatientFilesModule, ClinicSettingsModule], controllers: [ConsentsController], providers: [ConsentsService], exports: [ConsentsService] })
export class ConsentsModule {}
