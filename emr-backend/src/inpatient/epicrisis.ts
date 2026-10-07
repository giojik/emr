import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, Module, NotFoundException, Param, ParseUUIDPipe,
  Post, Put, Req, Res, StreamableFile } from '@nestjs/common';
import { ArrayMaxSize, IsArray, IsObject, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import type { Request, Response } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser } from '../auth/roles';
import { loadEnv } from '../config/env';
import type { DB } from '../database/db';
import { InjectDb, type Database } from '../database/database.module';
import { StorageService } from '../storage/storage.service';
import { validateBody, type Block, type Body as TplBody } from '../templates/template-blocks';
import { fmtDate, fmtDateTime, TemplateContextService } from '../templates/template-context';
import { renderTemplatePdf, type DxItem, type DxResultRow, type LabRow, type TemplatePdfInput } from '../templates/template.pdf';
import { TemplatesModule } from '../templates/templates';
import { InpatientModule, InpatientService } from './inpatient';

type Trx = Transaction<DB>;
type Ex = Database | Trx;
const MAX_FIELD = 20_000;

export class EpicrisisSaveDto {
  @IsOptional() @IsObject() content?: Record<string, string>;
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsUUID('all', { each: true }) selected_lab_ids?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsUUID('all', { each: true }) selected_dx_ids?: string[];
}
export class EpicrisisReopenDto { @IsString() @Length(5, 1000) reason: string }

/**
 * ეპიკრიზი (0041): თითო ჰოსპიტალიზაციაზე ერთი; შაბლონი — EPICRISIS (გამოქვეყნებული ვერსია, მიბმულია ინსტანსს).
 *   draft → (awaiting_cosign — თუ inpatient.epicrisis_cosign) → signed. ხელმოწერისას — დოკუმენტი №, PDF, QR (generated_documents).
 *   წერს: მკურნალი ექიმი / განყოფილების ექიმი / admin; ხელს აწერს: მკურნალი ექიმი ან განყოფილების ხელმძღვანელი (ექიმი);
 *   თანახელმოწერა: განყოფილების ხელმძღვანელი (თუ თავად არ მოაწერა); შესწორება — ხელახლა გახსნა მიზეზით (წინა PDF → revoked).
 *   საბოლოო დიაგნოზი = ჰოსპიტალიზაციის primary (ზუსტად ერთი) + secondary + complication.
 */
@Injectable()
export class EpicrisisService {
  private readonly env = loadEnv();
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService, private readonly ipd: InpatientService,
              private readonly vars: TemplateContextService, private readonly storage: StorageService) {}

  // ----------------------------------------------------------------- კონტექსტი
  private async stayCtx(encounterId: string, ex: Ex = this.db, lock = false) {
    let q = ex.selectFrom('inpatient_stays as st').innerJoin('encounters as e', 'e.id', 'st.encounter_id')
      .select(['st.encounter_id', 'st.patient_id', 'st.status', 'st.closed_at', 'st.discharge_type', 'e.attending_doctor_id', 'e.status as encounter_status',
        sql<string>`coalesce((SELECT a.department_id FROM bed_assignments a WHERE a.encounter_id = st.encounter_id AND a.end_kind IS DISTINCT FROM 'cancel'
          ORDER BY (a.ended_at IS NULL) DESC, a.started_at DESC, a.id DESC LIMIT 1), e.department_id)`.as('department_id')])
      .where('st.encounter_id', '=', encounterId);
    if (lock) q = q.forUpdate('st');
    const st = await q.executeTakeFirst();
    if (!st) throw new NotFoundException('ჰოსპიტალიზაცია ვერ მოიძებნა');
    if (st.status === 'cancelled') throw new ConflictException('ჰოსპიტალიზაცია გაუქმებულია');
    return st;
  }
  private async perms(u: AuthUser, st: { attending_doctor_id: string | null; department_id: string }, ex: Ex = this.db) {
    const doctor = has(u, 'doctor');
    const head = doctor && (await this.ipd.isHead(u, st.department_id, ex));
    const attending = doctor && st.attending_doctor_id === u.id;
    const staffDoctor = doctor && (await this.ipd.isStaff(u, st.department_id, ex));
    return { edit: attending || staffDoctor || has(u, 'admin'), sign: attending || head, head, attending };
  }

  async diagnoses(encounterId: string, ex: Ex = this.db) {
    const rows = await ex.selectFrom('encounter_diagnoses').select(['icd10_code as code', 'icd10_title as title', 'diagnosis_type'])
      .where('encounter_id', '=', encounterId).orderBy('created_at').execute();
    const of = (t: string): DxItem[] => rows.filter((r) => r.diagnosis_type === t).map((r) => ({ code: r.code, title: r.title }));
    return { admission: of('admission'), final: { primary: of('primary'), secondary: of('secondary'), complication: of('complication') } };
  }

  /** ეპიკრიზისთვის ხელმისაწვდომი შედეგები + ნაგულისხმევი არჩევანი (ლაბ.: თითო მაჩვენებლის ბოლო + ყველა გადახრილი; რადიოლოგია / ენდოსკოპია — ყველა) */
  async sources(encounterId: string, ex: Ex = this.db) {
    const lab = await ex.selectFrom('lab_results as r').innerJoin('dx_order_items as i', 'i.id', 'r.order_item_id').innerJoin('lab_analytes as a', 'a.id', 'r.analyte_id')
      .select(['r.id', 'r.analyte_id', 'a.name as test', 'r.value_num', 'r.value_text', 'r.unit', 'r.ref_low', 'r.ref_high', 'r.ref_text', 'r.flag',
        sql<Date>`coalesce(i.validated_at, i.resulted_at, r.entered_at)`.as('at')])
      .where('i.encounter_id', '=', encounterId).where('i.section', '=', 'lab').where('i.validated_at', 'is not', null)
      .where((eb) => eb.or([eb('r.value_num', 'is not', null), eb('r.value_text', 'is not', null)]))
      .orderBy('a.name').orderBy(sql`coalesce(i.validated_at, i.resulted_at, r.entered_at)`).execute();
    const latest = new Map<string, string>();
    for (const r of lab) latest.set(r.analyte_id, r.id);
    const latestIds = new Set(latest.values());
    const dx = await ex.selectFrom('dx_order_items as i').innerJoin('dx_services as s', 's.id', 'i.service_id')
      .innerJoin('dx_reports as rep', (j) => j.onRef('rep.order_item_id', '=', 'i.id').on('rep.status', '=', 'signed'))
      .select(['i.id', 'i.section', 's.name as title', 'rep.signed_at as at', 'rep.impression as conclusion'])
      .where('i.encounter_id', '=', encounterId).where('i.section', 'in', ['radiology', 'endoscopy']).orderBy('rep.signed_at').execute();
    const ref = (r: (typeof lab)[number]) => r.ref_text ?? (r.ref_low != null || r.ref_high != null ? `${r.ref_low ?? ''}–${r.ref_high ?? ''}` : null);
    return {
      lab: lab.map((r) => ({ id: r.id, date: fmtDate(r.at)!, at: r.at, test: r.test, value: r.value_num ?? r.value_text ?? '', unit: r.unit || null, ref: ref(r),
        flag: r.flag && r.flag !== 'N' ? r.flag : null, default: latestIds.has(r.id) || (!!r.flag && r.flag !== 'N') })),
      dx: dx.map((r) => ({ id: r.id, section: r.section, date: fmtDate(r.at)!, at: r.at, title: r.title, conclusion: r.conclusion, default: true })),
    };
  }

  private async row(encounterId: string, ex: Ex = this.db, lock = false) {
    let q = ex.selectFrom('epicrises').selectAll().where('encounter_id', '=', encounterId);
    if (lock) q = q.forUpdate();
    return q.executeTakeFirst();
  }
  private async templateOf(versionId: string, ex: Ex = this.db) {
    const v = await ex.selectFrom('document_template_versions').select(['id', 'version', 'body', 'template_code']).where('id', '=', versionId).executeTakeFirstOrThrow();
    return { ...v, body: v.body as unknown as TplBody };
  }
  private fields(body: TplBody) { return body.blocks.filter((b): b is Extract<Block, { type: 'field' }> => b.type === 'field'); }

  // ----------------------------------------------------------------- წაკითხვა
  async get(encounterId: string, u: AuthUser) {
    const st = await this.stayCtx(encounterId);
    const p = await this.perms(u, st);
    const e = await this.row(encounterId);
    const [sources, diagnoses] = await Promise.all([this.sources(encounterId), this.diagnoses(encounterId)]);
    const settings = await this.ipd.settings();
    if (!e) {
      return { epicrisis: null, template: null, sources, diagnoses, revisions: [],
        can: { create: p.edit && st.closed_at === null, edit: false, sign: false, cosign: false, reopen: false } };
    }
    const tpl = await this.templateOf(e.template_version_id);
    const names = await this.db.selectFrom('users').select(['id', sql<string>`last_name || ' ' || first_name`.as('name')])
      .where('id', 'in', [e.signed_by, e.cosigned_by, e.created_by].filter((x): x is string => !!x)).execute();
    const nm = (id: string | null) => names.find((n) => n.id === id)?.name ?? null;
    const revisions = await this.db.selectFrom('epicrisis_revisions as r').leftJoin('users as x', 'x.id', 'r.reopened_by').leftJoin('generated_documents as g', 'g.id', 'r.document_id')
      .select(['r.revision', 'r.signed_at', 'r.reopened_at', 'r.reopen_reason', 'r.document_id', 'g.document_number', sql<string | null>`x.last_name || ' ' || x.first_name`.as('reopened_by_name')])
      .where('r.epicrisis_id', '=', e.id).orderBy('r.revision', 'desc').execute();
    const doc = e.document_id ? await this.db.selectFrom('generated_documents').select(['document_number', 'verification_token',
      sql<string | null>`payload->'stay'->>'discharged_at'`.as('discharged_at')]).where('id', '=', e.document_id).executeTakeFirst() : null;
    return {
      epicrisis: { ...e, signed_by_name: nm(e.signed_by), cosigned_by_name: nm(e.cosigned_by), created_by_name: nm(e.created_by), document_number: doc?.document_number ?? null,
        // გაწერამდე ხელმოწერილ ეპიკრიზს გაწერის თარიღი არ აქვს — UI სთავაზობს ხელახლა გახსნას / „ხელმოწერა და გაწერა“-ს
        document_has_discharge_date: doc ? doc.discharged_at !== null : null },
      template: { version: tpl.version, blocks: tpl.body.blocks },
      sources, diagnoses, revisions, cosign_required: settings.epicrisis_cosign,
      missing: e.status === 'draft' ? this.missing(tpl.body, e.content as Record<string, string>, diagnoses) : [],
      can: {
        create: false, edit: e.status === 'draft' && p.edit,
        sign: e.status === 'draft' && p.sign,
        cosign: e.status === 'awaiting_cosign' && p.head && e.signed_by !== u.id,
        reopen: e.status !== 'draft' && (p.sign || has(u, 'admin') || e.signed_by === u.id),
      },
    };
  }

  private missing(body: TplBody, content: Record<string, string>, dx: Awaited<ReturnType<EpicrisisService['diagnoses']>>) {
    const out: string[] = [];
    if (dx.final.primary.length !== 1) out.push('საბოლოო დიაგნოზი: საჭიროა ზუსტად ერთი ძირითადი (ICD-10)');
    for (const f of this.fields(body)) if (f.required && !(content[f.key] ?? '').trim()) out.push(`შესავსებია: ${f.label}`);
    return out;
  }

  // ----------------------------------------------------------------- შექმნა / შენახვა
  async create(encounterId: string, u: AuthUser, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const st = await this.stayCtx(encounterId, trx, true);
      if (!(await this.perms(u, st, trx)).edit) throw new ForbiddenException('ეპიკრიზს წერს მკურნალი ექიმი ან განყოფილების ექიმი');
      if (st.closed_at) throw new ConflictException('შემთხვევა დახურულია');
      if (await this.row(encounterId, trx)) throw new ConflictException('ეპიკრიზი უკვე არსებობს');
      const t = await trx.selectFrom('document_template_versions as v').innerJoin('document_templates as t', 't.code', 'v.template_code')
        .select(['v.id', 'v.body']).where('t.code', '=', 'EPICRISIS').where('v.status', '=', 'published').executeTakeFirst();
      if (!t) throw new ConflictException('ეპიკრიზის შაბლონი გამოქვეყნებული არ არის (ადმინისტრირება → დოკუმენტების შაბლონები)');
      const body = t.body as unknown as TplBody;
      const v = await this.vars.resolve(st.patient_id, encounterId, u, trx);
      const content: Record<string, string> = {};
      for (const f of this.fields(body)) if (f.prefill) content[f.key] = f.prefill.replace(/\{\{\s*([a-z_]+\.[a-z_]+)\s*\}\}/g, (_, k: string) => v[k] || '');
      const src = await this.sources(encounterId, trx);
      const e = await trx.insertInto('epicrises').values({
        encounter_id: encounterId, patient_id: st.patient_id, template_version_id: t.id, content: JSON.stringify(content),
        selected_lab_ids: src.lab.filter((r) => r.default).map((r) => r.id), selected_dx_ids: src.dx.map((r) => r.id), created_by: u.id,
      }).returning('id').executeTakeFirstOrThrow();
      await this.ipd.event(trx, { encounter_id: encounterId, kind: 'epicrisis_created', data: {} }, u);
      await this.audit.log(ctx, { action: 'EPICRISIS_CREATE', entityName: 'epicrises', entityId: e.id, newData: { encounter_id: encounterId } }, trx);
    }).then(() => this.get(encounterId, u));
  }

  async save(encounterId: string, dto: EpicrisisSaveDto, u: AuthUser, ctx: AuditContext) {
    await this.db.transaction().execute(async (trx) => {
      const st = await this.stayCtx(encounterId, trx);
      const e = await this.row(encounterId, trx, true);
      if (!e) throw new NotFoundException('ეპიკრიზი ჯერ არ შექმნილა');
      if (e.status !== 'draft') throw new ConflictException('ხელმოწერილი ეპიკრიზი არ რედაქტირდება — გახსენით ხელახლა (მიზეზით)');
      if (!(await this.perms(u, st, trx)).edit) throw new ForbiddenException('ეპიკრიზს წერს მკურნალი ექიმი ან განყოფილების ექიმი');
      const tpl = await this.templateOf(e.template_version_id, trx);
      const set: Record<string, unknown> = {};
      if (dto.content) {
        const keys = new Set(this.fields(tpl.body).map((f) => f.key));
        const content: Record<string, string> = { ...(e.content as Record<string, string>) };
        for (const [k, val] of Object.entries(dto.content)) {
          if (!keys.has(k)) throw new BadRequestException(`უცნობი სექცია: ${k}`);
          if (typeof val !== 'string' || val.length > MAX_FIELD) throw new BadRequestException(`სექცია ${k}: ტექსტი (მაქს. ${MAX_FIELD} სიმბოლო)`);
          content[k] = val;
        }
        set.content = JSON.stringify(content);
      }
      if (dto.selected_lab_ids || dto.selected_dx_ids) {
        const src = await this.sources(encounterId, trx);
        if (dto.selected_lab_ids) {
          const ok = new Set(src.lab.map((r) => r.id));
          if (dto.selected_lab_ids.some((id) => !ok.has(id))) throw new BadRequestException('ლაბ. შედეგი ამ ჰოსპიტალიზაციას არ ეკუთვნის ან ვალიდირებული არ არის');
          set.selected_lab_ids = [...new Set(dto.selected_lab_ids)];
        }
        if (dto.selected_dx_ids) {
          const ok = new Set(src.dx.map((r) => r.id));
          if (dto.selected_dx_ids.some((id) => !ok.has(id))) throw new BadRequestException('კვლევა ამ ჰოსპიტალიზაციას არ ეკუთვნის ან დასკვნა ხელმოწერილი არ არის');
          set.selected_dx_ids = [...new Set(dto.selected_dx_ids)];
        }
      }
      if (!Object.keys(set).length) return;
      await trx.updateTable('epicrises').set(set).where('id', '=', e.id).execute();
      await this.audit.log(ctx, { action: 'EPICRISIS_SAVE', entityName: 'epicrises', entityId: e.id, newData: { keys: Object.keys(dto.content ?? {}), lab: dto.selected_lab_ids?.length, dx: dto.selected_dx_ids?.length } }, trx);
    });
    return this.get(encounterId, u);
  }

  // ----------------------------------------------------------------- PDF
  private async pdfInput(encounterId: string, e: NonNullable<Awaited<ReturnType<EpicrisisService['row']>>>, u: AuthUser | null, ex: Ex,
                         extra: { number?: string; verifyUrl?: string; watermark?: string | null; signedAt?: Date; cosignedAt?: Date | null; signerId?: string; cosignerId?: string | null }) {
    const tpl = await this.templateOf(e.template_version_id, ex);
    const v = await this.vars.resolve(e.patient_id, encounterId, u, ex);
    const [src, diagnoses, clinic] = await Promise.all([this.sources(encounterId, ex), this.diagnoses(encounterId, ex),
      ex.selectFrom('clinic_settings').select(['name', 'address', 'phone']).where('id', '=', 1).executeTakeFirst()]);
    if (!clinic) throw new ConflictException('კლინიკის რეკვიზიტები შევსებული არ არის');
    const labIds = new Set(e.selected_lab_ids); const dxIds = new Set(e.selected_dx_ids);
    const lab: LabRow[] = src.lab.filter((r) => labIds.has(r.id)).map(({ date, test, value, unit, ref, flag }) => ({ date, test, value, unit, ref, flag }));
    const dx: DxResultRow[] = src.dx.filter((r) => dxIds.has(r.id)).map(({ date, title, conclusion }) => ({ date, title, conclusion }));
    const person = async (id: string | null | undefined) => id ? ex.selectFrom('users').select([sql<string>`first_name || ' ' || last_name`.as('name'), 'specialty']).where('id', '=', id).executeTakeFirst() : undefined;
    const [sg, cs] = await Promise.all([person(extra.signerId ?? e.signed_by), person(extra.cosignerId ?? e.cosigned_by)]);
    const input: TemplatePdfInput = {
      clinic, title: 'ეპიკრიზი', number: extra.number ?? null, verifyUrl: extra.verifyUrl ?? null, watermark: extra.watermark ?? null, vars: v, blocks: tpl.body.blocks,
      footer: v['stay.adm_no'] ? `ჰოსპიტალიზაცია ${v['stay.adm_no']}` : null,
      data: {
        patient: { full_name: v['patient.full_name'], birth_date: v['patient.birth_date'], id_number: v['patient.id_number'], address: v['patient.address'], phone: v['patient.phone'] },
        diagnoses, fields: e.content as Record<string, string>, lab, dx,
        signatures: {
          attending: sg ? { name: sg.name, role: sg.specialty, at: extra.signedAt ? fmtDateTime(extra.signedAt) : e.signed_at ? fmtDateTime(e.signed_at) : null } : { name: v['stay.attending_doctor'] },
          department_head: cs ? { name: cs.name, role: cs.specialty, at: fmtDateTime(extra.cosignedAt ?? e.cosigned_at) } : undefined,
        },
      },
    };
    return { input, vars: v, diagnoses, lab, dx, templateVersion: tpl.version };
  }

  async previewPdf(encounterId: string, u: AuthUser) {
    const e = await this.row(encounterId);
    if (!e) throw new NotFoundException('ეპიკრიზი ჯერ არ შექმნილა');
    const { input } = await this.pdfInput(encounterId, e, u, this.db, { watermark: e.status === 'draft' ? 'პროექტი' : e.status === 'awaiting_cosign' ? 'თანახელმოწერის მოლოდინში' : null });
    return renderTemplatePdf(input);
  }

  /** ხელმოწერის / თანახელმოწერის საბოლოო ეტაპი: ნომერი, PDF, QR, generated_documents */
  private async issue(trx: Trx, encounterId: string, e: NonNullable<Awaited<ReturnType<EpicrisisService['row']>>>, u: AuthUser, at: { signedAt: Date; signerId: string; cosignedAt: Date | null; cosignerId: string | null }) {
    const number = await this.ipd.nextNo(trx, 'epicrisis', 'EPI');
    const token = randomUUID();
    const verifyUrl = `${this.env.PUBLIC_VERIFY_BASE_URL.replace(/\/$/, '')}/${token}`;
    const r = await this.pdfInput(encounterId, e, u, trx, { number, verifyUrl, ...at });
    const pdf = await renderTemplatePdf(r.input);
    const sha = createHash('sha256').update(pdf).digest('hex');
    const now = new Date();
    const key = `documents/epicrisis/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${token}.pdf`;
    await this.storage.put(key, pdf, 'application/pdf');
    const payload = {
      form: 'epicrisis', number, issued_at: now.toISOString(), template_version: r.templateVersion, revision: e.revision,
      institution: { name: r.input.clinic.name }, patient: { full_name: r.vars['patient.full_name'] },
      stay: { adm_no: r.vars['stay.adm_no'], admitted_at: r.vars['stay.admitted_at'], discharged_at: r.vars['stay.discharged_at'] || null, department: r.vars['stay.department'] },
      diagnoses: r.diagnoses, content: e.content, lab: r.lab, dx: r.dx, signed_by: at.signerId, cosigned_by: at.cosignerId, verify_url: verifyUrl,
    };
    const doc = await trx.insertInto('generated_documents').values({
      encounter_id: encounterId, document_type: 'epicrisis', file_path: key, verification_token: token, generated_by: u.id,
      document_number: number, payload: JSON.stringify(payload), file_sha256: sha,
    }).returning(['id']).executeTakeFirstOrThrow();
    return { documentId: doc.id, number };
  }

  /** ხელმოწერა. მოიხმარს გაწერაც (იმავე ტრანზაქციაში — გაწერის თარიღი ეპიკრიზში ხვდება). */
  async signInTrx(trx: Trx, encounterId: string, u: AuthUser, ctx: AuditContext) {
    const st = await this.stayCtx(encounterId, trx);
    const e = await this.row(encounterId, trx, true);
    if (!e) throw new NotFoundException({ code: 'EPICRISIS_MISSING', message: 'ეპიკრიზი არ არის შექმნილი' });
    if (e.status !== 'draft') throw new ConflictException('ეპიკრიზი უკვე ხელმოწერილია');
    const p = await this.perms(u, st, trx);
    if (!p.sign) throw new ForbiddenException('ეპიკრიზს ხელს აწერს მკურნალი ექიმი ან განყოფილების ხელმძღვანელი');
    const tpl = await this.templateOf(e.template_version_id, trx);
    const check = validateBody('epicrisis', tpl.body);
    if (check.errors.length) throw new ConflictException('ეპიკრიზის შაბლონი არასწორია: ' + check.errors.join('; '));
    const missing = this.missing(tpl.body, e.content as Record<string, string>, await this.diagnoses(encounterId, trx));
    if (missing.length) throw new BadRequestException({ code: 'EPICRISIS_INCOMPLETE', message: missing.join('; '), missing });
    const s = await this.ipd.settings();
    const now = new Date();
    if (s.epicrisis_cosign && !p.head) {
      await trx.updateTable('epicrises').set({ status: 'awaiting_cosign', signed_by: u.id, signed_at: now }).where('id', '=', e.id).execute();
      await this.ipd.event(trx, { encounter_id: encounterId, kind: 'epicrisis_signed', data: { revision: e.revision, cosign: 'pending' } }, u);
      await this.audit.log(ctx, { action: 'EPICRISIS_SIGN', entityName: 'epicrises', entityId: e.id, newData: { revision: e.revision, cosign_pending: true } }, trx);
      return { status: 'awaiting_cosign' as const, document_number: null };
    }
    const d = await this.issue(trx, encounterId, e, u, { signedAt: now, signerId: u.id, cosignedAt: null, cosignerId: null });
    await trx.updateTable('epicrises').set({ status: 'signed', signed_by: u.id, signed_at: now, document_id: d.documentId }).where('id', '=', e.id).execute();
    await this.ipd.event(trx, { encounter_id: encounterId, kind: 'epicrisis_signed', data: { revision: e.revision, number: d.number } }, u);
    await this.audit.log(ctx, { action: 'EPICRISIS_SIGN', entityName: 'epicrises', entityId: e.id, newData: { revision: e.revision, number: d.number } }, trx);
    return { status: 'signed' as const, document_number: d.number };
  }

  async sign(encounterId: string, u: AuthUser, ctx: AuditContext) {
    await this.db.transaction().execute((trx) => this.signInTrx(trx, encounterId, u, ctx));
    return this.get(encounterId, u);
  }

  async cosign(encounterId: string, u: AuthUser, ctx: AuditContext) {
    await this.db.transaction().execute(async (trx) => {
      const st = await this.stayCtx(encounterId, trx);
      const e = await this.row(encounterId, trx, true);
      if (!e || e.status !== 'awaiting_cosign') throw new ConflictException('ეპიკრიზი თანახელმოწერას არ ელოდება');
      if (!(await this.perms(u, st, trx)).head) throw new ForbiddenException('თანახელმოწერა — განყოფილების ხელმძღვანელი (ექიმი)');
      if (e.signed_by === u.id) throw new ConflictException('თანახელმოწერა სხვა პირმა უნდა შეასრულოს');
      const now = new Date();
      const d = await this.issue(trx, encounterId, e, u, { signedAt: e.signed_at!, signerId: e.signed_by!, cosignedAt: now, cosignerId: u.id });
      await trx.updateTable('epicrises').set({ status: 'signed', cosigned_by: u.id, cosigned_at: now, document_id: d.documentId }).where('id', '=', e.id).execute();
      await this.ipd.event(trx, { encounter_id: encounterId, kind: 'epicrisis_cosigned', data: { revision: e.revision, number: d.number } }, u);
      await this.audit.log(ctx, { action: 'EPICRISIS_COSIGN', entityName: 'epicrises', entityId: e.id, newData: { number: d.number } }, trx);
    });
    return this.get(encounterId, u);
  }

  async reopen(encounterId: string, reason: string, u: AuthUser, ctx: AuditContext) {
    await this.db.transaction().execute(async (trx) => {
      const st = await this.stayCtx(encounterId, trx);
      const e = await this.row(encounterId, trx, true);
      if (!e || e.status === 'draft') throw new ConflictException('ეპიკრიზი ხელმოწერილი არ არის');
      const p = await this.perms(u, st, trx);
      if (!(p.sign || has(u, 'admin') || e.signed_by === u.id)) throw new ForbiddenException('ხელახლა გახსნა — ხელმომწერი, მკურნალი ექიმი, ხელმძღვანელი ან admin');
      await trx.insertInto('epicrisis_revisions').values({
        epicrisis_id: e.id, revision: e.revision, template_version_id: e.template_version_id, content: JSON.stringify(e.content),
        selected_lab_ids: e.selected_lab_ids, selected_dx_ids: e.selected_dx_ids, signed_by: e.signed_by!, signed_at: e.signed_at!,
        cosigned_by: e.cosigned_by, cosigned_at: e.cosigned_at, document_id: e.document_id, reopened_by: u.id, reopen_reason: reason.trim(),
      }).execute();
      if (e.document_id) {
        await trx.updateTable('generated_documents').set({ status: 'revoked', revoked_at: sql`now()`, revoked_by: u.id, revoke_reason: `ეპიკრიზი ხელახლა გაიხსნა: ${reason.trim()}` })
          .where('id', '=', e.document_id).where('status', '=', 'issued').execute();
      }
      await trx.updateTable('epicrises').set({ status: 'draft', revision: e.revision + 1, signed_by: null, signed_at: null, cosigned_by: null, cosigned_at: null, document_id: null })
        .where('id', '=', e.id).execute();
      await this.ipd.event(trx, { encounter_id: encounterId, kind: 'epicrisis_reopened', data: { revision: e.revision + 1, reason: reason.trim() } }, u);
      await this.audit.log(ctx, { action: 'EPICRISIS_REOPEN', entityName: 'epicrises', entityId: e.id, newData: { revision: e.revision + 1, reason } }, trx);
    });
    return this.get(encounterId, u);
  }

  async documentPdf(encounterId: string, ctx: AuditContext) {
    const e = await this.row(encounterId);
    if (!e?.document_id) throw new NotFoundException('ხელმოწერილი ეპიკრიზი არ არის');
    const d = await this.db.selectFrom('generated_documents').select(['file_path', 'document_number']).where('id', '=', e.document_id).executeTakeFirstOrThrow();
    await this.audit.log(ctx, { action: 'DOWNLOAD_DOCUMENT', entityName: 'generated_documents', entityId: e.document_id });
    return { stream: await this.storage.get(d.file_path), number: d.document_number };
  }
}

const IPD_READ = ['admin', 'doctor', 'nurse', 'manager'] as const;

@Controller('inpatient/stays/:eid/epicrisis')
export class EpicrisisController {
  constructor(private readonly s: EpicrisisService) {}
  @Get() @Roles(...IPD_READ) get(@Param('eid', ParseUUIDPipe) eid: string, @CurrentUser() u: AuthUser) { return this.s.get(eid, u); }
  @Post() @Roles('admin', 'doctor') create(@Param('eid', ParseUUIDPipe) eid: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.create(eid, u, auditCtx(r)); }
  @Put() @Roles('admin', 'doctor') save(@Param('eid', ParseUUIDPipe) eid: string, @Body() d: EpicrisisSaveDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.save(eid, d, u, auditCtx(r)); }
  @Post('sign') @HttpCode(200) @Roles('doctor') sign(@Param('eid', ParseUUIDPipe) eid: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.sign(eid, u, auditCtx(r)); }
  @Post('cosign') @HttpCode(200) @Roles('doctor') cosign(@Param('eid', ParseUUIDPipe) eid: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.cosign(eid, u, auditCtx(r)); }
  @Post('reopen') @HttpCode(200) @Roles('admin', 'doctor')
  reopen(@Param('eid', ParseUUIDPipe) eid: string, @Body() d: EpicrisisReopenDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.reopen(eid, d.reason, u, auditCtx(r)); }
  @Get('preview') @Roles(...IPD_READ)
  async preview(@Param('eid', ParseUUIDPipe) eid: string, @CurrentUser() u: AuthUser, @Res({ passthrough: true }) res: Response) {
    const pdf = await this.s.previewPdf(eid, u);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline', 'Cache-Control': 'no-store' });
    return new StreamableFile(pdf);
  }
  @Get('pdf') @Roles(...IPD_READ)
  async pdf(@Param('eid', ParseUUIDPipe) eid: string, @Req() r: Request, @Res({ passthrough: true }) res: Response) {
    const d = await this.s.documentPdf(eid, auditCtx(r));
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${(d.number ?? 'epicrisis').replace(/[^\w.-]+/g, '_')}.pdf"`, 'Cache-Control': 'no-store' });
    return new StreamableFile(d.stream);
  }
}

@Module({ imports: [InpatientModule, TemplatesModule], providers: [EpicrisisService], controllers: [EpicrisisController], exports: [EpicrisisService] })
export class EpicrisisModule {}
