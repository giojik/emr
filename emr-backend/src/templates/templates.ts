import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, Injectable, Module, NotFoundException, Param, Patch, Post,
  Put, Query, Req, Res, StreamableFile } from '@nestjs/common';
import { IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Length, Matches, MaxLength, Min } from 'class-validator';
import type { Request, Response } from 'express';
import { sql, type Transaction } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/roles';
import type { DB } from '../database/db';
import { InjectDb, type Database } from '../database/database.module';
import { renderConsent } from '../consents/consent.pdf';
import { KINDS, SAMPLE_VARS, VARIABLES, plainText, validateBody, type Body as TplBody, type Kind } from './template-blocks';
import { TemplateContextService } from './template-context';
import { renderTemplatePdf } from './template.pdf';

export class CreateTemplateDto {
  @Matches(/^[A-Z][A-Z0-9_]{1,39}$/, { message: 'კოდი: ლათინური დიდი ასოები, ციფრები, _' }) code: string;
  @IsIn(['consent', 'refusal', 'other']) kind: Kind;
  @IsString() @Length(3, 300) name: string;
  @IsIn(['patient', 'encounter']) scope: 'patient' | 'encounter';
  @IsOptional() @IsBoolean() required_on_admission?: boolean;
  @IsOptional() @IsInt() @Min(0) sort_order?: number;
}
export class PatchTemplateDto {
  @IsOptional() @IsString() @Length(3, 300) name?: string;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsBoolean() required_on_admission?: boolean;
  @IsOptional() @IsInt() @Min(0) sort_order?: number;
}
export class DraftDto {
  @IsObject() body: unknown;
  @IsOptional() @IsBoolean() text_approved?: boolean;
  @IsOptional() @IsString() @MaxLength(1000) change_note?: string;
}
export class PublishDto { @IsOptional() @IsString() @MaxLength(1000) change_note?: string }
export class PreviewDto { @IsOptional() @IsObject() body?: unknown; @IsOptional() @IsInt() @Min(1) version?: number }

type Trx = Transaction<DB>;

/**
 * დოკუმენტების შაბლონები (0041): თანხმობა, ხელწერილი, ეპიკრიზი, სხვა. მართავს მხოლოდ admin.
 *   ვერსია: draft → published → archived; გამოქვეყნებული უცვლელია (DB trigger); ერთი published + ერთი draft.
 *   ცვლადები — დახურული კატალოგი; უცნობი ცვლადი / დაუშვებელი ბლოკი → გამოქვეყნება იბლოკება.
 */
@Injectable()
export class TemplatesService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService, private readonly ctxs: TemplateContextService) {}

  variables() { return Object.entries(VARIABLES).map(([key, v]) => ({ key, label: v.label, sample: v.sample })); }

  async list(q: { kind?: string; all?: boolean }) {
    let query = this.db.selectFrom('document_templates as t')
      .leftJoin('document_template_versions as p', (j) => j.onRef('p.template_code', '=', 't.code').on('p.status', '=', 'published'))
      .leftJoin('document_template_versions as d', (j) => j.onRef('d.template_code', '=', 't.code').on('d.status', '=', 'draft'))
      .select(['t.code', 't.kind', 't.name', 't.scope', 't.required_on_admission', 't.is_system', 't.is_active', 't.sort_order',
        'p.version as published_version', 'p.text_approved', 'p.published_at', 'd.version as draft_version', 'd.created_at as draft_at'])
      .orderBy('t.sort_order').orderBy('t.name');
    if (q.kind) query = query.where('t.kind', '=', q.kind);
    if (!q.all) query = query.where('t.is_active', '=', true);
    return query.execute();
  }

  async get(code: string) {
    const t = await this.db.selectFrom('document_templates').selectAll().where('code', '=', code).executeTakeFirst();
    if (!t) throw new NotFoundException('შაბლონი ვერ მოიძებნა');
    const versions = await this.db.selectFrom('document_template_versions as v')
      .leftJoin('users as c', 'c.id', 'v.created_by').leftJoin('users as pb', 'pb.id', 'v.published_by')
      .select(['v.id', 'v.version', 'v.status', 'v.body', 'v.text_approved', 'v.change_note', 'v.created_at', 'v.published_at', 'v.archived_at',
        sql<string | null>`c.first_name || ' ' || c.last_name`.as('created_by_name'), sql<string | null>`pb.first_name || ' ' || pb.last_name`.as('published_by_name')])
      .where('v.template_code', '=', code).orderBy('v.version', 'desc').execute();
    const draft = versions.find((v) => v.status === 'draft');
    return { ...t, versions, draft_errors: draft ? validateBody(t.kind as Kind, draft.body).errors : [] };
  }

  /** გამოქვეყნებული ვერსია (სხეული — ვალიდირებული ტიპით) */
  async published(code: string, opts: { activeOnly?: boolean; kinds?: Kind[] } = {}) {
    let q = this.db.selectFrom('document_templates as t')
      .innerJoin('document_template_versions as v', (j) => j.onRef('v.template_code', '=', 't.code').on('v.status', '=', 'published'))
      .select(['t.code', 't.kind', 't.name', 't.scope', 't.is_active', 't.required_on_admission', 'v.id as version_id', 'v.version', 'v.body', 'v.text_approved'])
      .where('t.code', '=', code);
    if (opts.activeOnly) q = q.where('t.is_active', '=', true);
    if (opts.kinds) q = q.where('t.kind', 'in', opts.kinds);
    const r = await q.executeTakeFirst();
    if (!r) return null;
    return { ...r, kind: r.kind as Kind, body: r.body as unknown as TplBody };
  }

  async create(dto: CreateTemplateDto, user: AuthUser, ctx: AuditContext) {
    if (dto.required_on_admission && dto.kind !== 'consent') throw new BadRequestException('„სავალდებულო მიღებისას“ — მხოლოდ თანხმობისთვის');
    return this.db.transaction().execute(async (trx) => {
      const exists = await trx.selectFrom('document_templates').select('code').where('code', '=', dto.code).executeTakeFirst();
      if (exists) throw new ConflictException(`კოდი ${dto.code} უკვე არსებობს`);
      await trx.insertInto('document_templates').values({ code: dto.code, kind: dto.kind, name: dto.name.trim(), scope: dto.scope,
        required_on_admission: !!dto.required_on_admission, sort_order: dto.sort_order ?? 100 }).execute();
      const starter: TplBody = { blocks: [{ type: 'text', text: '[ტექსტი — {{patient.full_name}} …]' }] };
      await trx.insertInto('document_template_versions').values({ template_code: dto.code, version: 1, status: 'draft',
        body: JSON.stringify(starter), created_by: user.id }).execute();
      await this.audit.log(ctx, { action: 'CREATE_DOCUMENT_TEMPLATE', entityName: 'document_templates', entityId: dto.code, newData: dto }, trx);
      return { code: dto.code };
    }).then(() => this.get(dto.code));
  }

  async patch(code: string, dto: PatchTemplateDto, ctx: AuditContext) {
    const t = await this.db.selectFrom('document_templates').selectAll().where('code', '=', code).executeTakeFirst();
    if (!t) throw new NotFoundException('შაბლონი ვერ მოიძებნა');
    if (t.is_system && dto.is_active === false) throw new BadRequestException('სისტემური შაბლონი არ ითიშება');
    if (dto.required_on_admission && t.kind !== 'consent') throw new BadRequestException('„სავალდებულო მიღებისას“ — მხოლოდ თანხმობისთვის');
    const set: Record<string, unknown> = {};
    for (const k of ['name', 'is_active', 'required_on_admission', 'sort_order'] as const) if (dto[k] !== undefined) set[k] = typeof dto[k] === 'string' ? (dto[k] as string).trim() : dto[k];
    if (!Object.keys(set).length) return this.get(code);
    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable('document_templates').set(set).where('code', '=', code).execute();
      await this.audit.log(ctx, { action: 'UPDATE_DOCUMENT_TEMPLATE', entityName: 'document_templates', entityId: code,
        oldData: Object.fromEntries(Object.keys(set).map((k) => [k, (t as Record<string, unknown>)[k]])), newData: set }, trx);
    });
    return this.get(code);
  }

  private async lockTemplate(trx: Trx, code: string) {
    const t = await trx.selectFrom('document_templates').selectAll().where('code', '=', code).forUpdate().executeTakeFirst();
    if (!t) throw new NotFoundException('შაბლონი ვერ მოიძებნა');
    return { ...t, kind: t.kind as Kind };
  }

  /** draft-ის შენახვა (ან შექმნა): სტრუქტურა მკაცრად მოწმდება, შინაარსობრივი შეცდომები ბრუნდება გაფრთხილებად (გამოქვეყნებას ბლოკავს) */
  async saveDraft(code: string, dto: DraftDto, user: AuthUser, ctx: AuditContext) {
    await this.db.transaction().execute(async (trx) => {
      const t = await this.lockTemplate(trx, code);
      const v = validateBody(t.kind, dto.body);
      if (!v.body || v.structural.length) throw new BadRequestException({ code: 'TEMPLATE_INVALID', message: 'შაბლონის სტრუქტურა არასწორია', errors: v.structural });
      const draft = await trx.selectFrom('document_template_versions').select(['id', 'version']).where('template_code', '=', code).where('status', '=', 'draft').executeTakeFirst();
      if (draft) {
        await trx.updateTable('document_template_versions').set({ body: JSON.stringify(v.body), text_approved: dto.text_approved ?? false,
          change_note: dto.change_note?.trim() || null }).where('id', '=', draft.id).execute();
      } else {
        const { m } = await trx.selectFrom('document_template_versions').select(sql<number>`coalesce(max(version), 0)::int`.as('m')).where('template_code', '=', code).executeTakeFirstOrThrow();
        await trx.insertInto('document_template_versions').values({ template_code: code, version: m + 1, status: 'draft', body: JSON.stringify(v.body),
          text_approved: dto.text_approved ?? false, change_note: dto.change_note?.trim() || null, created_by: user.id }).execute();
      }
      await this.audit.log(ctx, { action: 'SAVE_TEMPLATE_DRAFT', entityName: 'document_templates', entityId: code, newData: { blocks: v.body.blocks.length, errors: v.errors.length } }, trx);
    });
    return this.get(code);
  }

  async discardDraft(code: string, ctx: AuditContext) {
    await this.db.transaction().execute(async (trx) => {
      await this.lockTemplate(trx, code);
      const r = await trx.deleteFrom('document_template_versions').where('template_code', '=', code).where('status', '=', 'draft').returning('version').executeTakeFirst();
      if (!r) throw new NotFoundException('draft არ არის');
      const pub = await trx.selectFrom('document_template_versions').select('id').where('template_code', '=', code).where('status', '=', 'published').executeTakeFirst();
      if (!pub) throw new ConflictException('შაბლონს გამოქვეყნებული ვერსია არ აქვს — draft-ის წაშლა შეუძლებელია (გათიშეთ შაბლონი)');
      await this.audit.log(ctx, { action: 'DISCARD_TEMPLATE_DRAFT', entityName: 'document_templates', entityId: code, newData: { version: r.version } }, trx);
    });
    return this.get(code);
  }

  async publish(code: string, dto: PublishDto, user: AuthUser, ctx: AuditContext) {
    await this.db.transaction().execute(async (trx) => {
      const t = await this.lockTemplate(trx, code);
      const draft = await trx.selectFrom('document_template_versions').select(['id', 'version', 'body', 'change_note']).where('template_code', '=', code).where('status', '=', 'draft').executeTakeFirst();
      if (!draft) throw new NotFoundException('გამოსაქვეყნებელი draft არ არის');
      const v = validateBody(t.kind, draft.body);
      if (v.errors.length) throw new BadRequestException({ code: 'TEMPLATE_INVALID', message: 'შაბლონს აქვს შეცდომები — გამოქვეყნება შეუძლებელია', errors: v.errors });
      await this.publishLocked(trx, code, draft.id, user, dto.change_note ?? draft.change_note);
      await this.audit.log(ctx, { action: 'PUBLISH_DOCUMENT_TEMPLATE', entityName: 'document_templates', entityId: code, newData: { version: draft.version } }, trx);
    });
    return this.get(code);
  }

  private async publishLocked(trx: Trx, code: string, versionId: string, user: AuthUser, note: string | null | undefined) {
    await trx.updateTable('document_template_versions').set({ status: 'archived', archived_at: sql`now()` })
      .where('template_code', '=', code).where('status', '=', 'published').execute();
    await trx.updateTable('document_template_versions').set({ status: 'published', published_at: sql`now()`, published_by: user.id, change_note: note?.trim() || null })
      .where('id', '=', versionId).execute();
  }

  /**
   * ძველი API (PUT /consent-types/:code) — ტექსტის ან დამტკიცების ცვლილება მაშინვე ქვეყნდება ახალ ვერსიად (ერთი text ბლოკი).
   * ღია draft ასეთ დროს ბლოკავს: ჯერ გამოაქვეყნეთ ან წაშალეთ draft შაბლონების გვერდიდან.
   */
  async publishText(code: string, text: string, approved: boolean, user: AuthUser, trx: Trx) {
    const t = await this.lockTemplate(trx, code);
    const draft = await trx.selectFrom('document_template_versions').select('id').where('template_code', '=', code).where('status', '=', 'draft').executeTakeFirst();
    if (draft) throw new ConflictException('შაბლონს აქვს გამოუქვეყნებელი draft (ადმინისტრირება → დოკუმენტების შაბლონები)');
    const body: TplBody = { blocks: [{ type: 'text', text }] };
    const v = validateBody(t.kind, body);
    if (v.errors.length) throw new BadRequestException({ code: 'TEMPLATE_INVALID', message: v.errors.join('; '), errors: v.errors });
    const { m } = await trx.selectFrom('document_template_versions').select(sql<number>`coalesce(max(version), 0)::int`.as('m')).where('template_code', '=', code).executeTakeFirstOrThrow();
    const row = await trx.insertInto('document_template_versions').values({ template_code: code, version: m + 1, status: 'draft', body: JSON.stringify(body),
      text_approved: approved, created_by: user.id }).returning('id').executeTakeFirstOrThrow();
    await this.publishLocked(trx, code, row.id, user, null);
    return m + 1;
  }

  /** preview: ნიმუშის მონაცემებით (ან რეალური პაციენტით/ვიზიტით — patient_id, encounter_id) */
  async preview(code: string, dto: PreviewDto, user: AuthUser, real?: { patientId: string; encounterId?: string }) {
    const t = await this.get(code);
    const kind = t.kind as Kind;
    let body: unknown;
    let approved = true;
    if (dto.body) body = dto.body;
    else {
      const v = dto.version ? t.versions.find((x) => x.version === dto.version) : (t.versions.find((x) => x.status === 'draft') ?? t.versions.find((x) => x.status === 'published'));
      if (!v) throw new NotFoundException('ვერსია ვერ მოიძებნა');
      body = v.body; approved = v.text_approved;
    }
    const vb = validateBody(kind, body);
    if (!vb.body || vb.structural.length) throw new BadRequestException({ code: 'TEMPLATE_INVALID', message: 'შაბლონის სტრუქტურა არასწორია', errors: vb.errors });
    const vars = real ? await this.ctxs.resolve(real.patientId, real.encounterId, user) : SAMPLE_VARS;
    const clinic = (await this.db.selectFrom('clinic_settings').select(['name', 'address', 'phone']).where('id', '=', 1).executeTakeFirst())
      ?? { name: SAMPLE_VARS['clinic.name'], address: SAMPLE_VARS['clinic.address'], phone: SAMPLE_VARS['clinic.phone'] };
    if (kind === 'consent' || kind === 'refusal') {
      return renderConsent({ clinic, title: t.name, version: dto.version ?? 0, body: plainText(vb.body, vars), textApproved: approved,
        patient: { name: vars['patient.full_name'], birthDate: '1978-03-14', idNumber: vars['patient.id_number'], address: vars['patient.address'] },
        encounterDate: null, mode: 'blank' });
    }
    return renderTemplatePdf({
      clinic, title: t.name, number: 'EPI26-000000', verifyUrl: 'https://example.invalid/verify/preview', watermark: 'ნიმუში', vars, blocks: vb.body.blocks,
      footer: vb.errors.length ? `შეცდომები: ${vb.errors.length}` : null,
      data: {
        patient: { full_name: vars['patient.full_name'], birth_date: vars['patient.birth_date'], id_number: vars['patient.id_number'], address: vars['patient.address'], phone: vars['patient.phone'] },
        diagnoses: { admission: [{ code: 'I20.0', title: 'არასტაბილური სტენოკარდია' }],
          final: { primary: [{ code: 'I21.4', title: 'მიოკარდიუმის მწვავე სუბენდოკარდიული ინფარქტი' }], secondary: [{ code: 'I10', title: 'ესენციური (პირველადი) ჰიპერტენზია' }], complication: [] } },
        fields: {},
        lab: [{ date: '02/10/2026', test: 'ტროპონინი I', value: '1.84', unit: 'ng/mL', ref: '< 0.04', flag: 'H' },
              { date: '02/10/2026', test: 'ჰემოგლობინი', value: '138', unit: 'g/L', ref: '120–160', flag: null }],
        dx: [{ date: '01/10/2026', title: 'ექოკარდიოგრაფია', conclusion: 'LVEF 50%, წინა კედლის ჰიპოკინეზი' }],
        signatures: { attending: { name: vars['stay.attending_doctor'] } },
      },
    });
  }
}

const READ = ['admin', 'doctor', 'nurse', 'receptionist', 'manager'] as const;

@Controller('document-templates')
export class TemplatesController {
  constructor(private readonly s: TemplatesService) {}
  @Get() @Roles(...READ) list(@Query('kind') kind?: string, @Query('all') all?: string) {
    if (kind && !(KINDS as readonly string[]).includes(kind)) throw new BadRequestException('kind: ' + KINDS.join(', '));
    return this.s.list({ kind, all: all === 'true' });
  }
  @Get('variables') @Roles(...READ) variables() { return this.s.variables(); }
  @Get(':code') @Roles('admin') get(@Param('code') code: string) { return this.s.get(code); }
  @Post() @Roles('admin') create(@Body() d: CreateTemplateDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.create(d, u, auditCtx(r)); }
  @Patch(':code') @Roles('admin') patch(@Param('code') code: string, @Body() d: PatchTemplateDto, @Req() r: Request) { return this.s.patch(code, d, auditCtx(r)); }
  @Put(':code/draft') @Roles('admin') draft(@Param('code') code: string, @Body() d: DraftDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.saveDraft(code, d, u, auditCtx(r)); }
  @Delete(':code/draft') @Roles('admin') discard(@Param('code') code: string, @Req() r: Request) { return this.s.discardDraft(code, auditCtx(r)); }
  @Post(':code/publish') @HttpCode(200) @Roles('admin') publish(@Param('code') code: string, @Body() d: PublishDto, @CurrentUser() u: AuthUser, @Req() r: Request) {
    return this.s.publish(code, d, u, auditCtx(r));
  }
  @Post(':code/preview') @HttpCode(200) @Roles('admin')
  async preview(@Param('code') code: string, @Body() d: PreviewDto, @CurrentUser() u: AuthUser, @Res({ passthrough: true }) res: Response) {
    const pdf = await this.s.preview(code, d, u);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline', 'Cache-Control': 'no-store' });
    return new StreamableFile(pdf);
  }
}

@Module({ controllers: [TemplatesController], providers: [TemplatesService, TemplateContextService], exports: [TemplatesService, TemplateContextService] })
export class TemplatesModule {}
