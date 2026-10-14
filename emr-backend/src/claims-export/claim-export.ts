import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, Res,
  UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min } from 'class-validator';
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { sql } from 'kysely';
import { memoryStorage } from 'multer';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/roles';
import { mapPgError } from '../common/pg-errors';
import { FinClaimsService } from '../finance/finance-claims';
import { FinCommon, n, r2, type Trx } from '../finance/finance-common';
import { CLAIM_RESOLVE, FIN_EDIT, FIN_FULL } from '../finance/finance-rules';
import { stableJson } from '../drg/drg-engine';
import { errorText, loadRules, scrubInvoice, scrubSettings } from '../scrub/scrub-engine';
import { DATE_FORMAT_LIST, type ExportConfig, FILE_TOKENS, FIELDS_FOR_UI, parseResponseFile, type ParsedResp, renderExport, RESP_KEYS, RESP_STATUSES, type RespStatus,
  validateExport, validateResponse } from './claim-template';
import { claimRows } from './export-fields';

const ERR = {
  claim_templates_code_key: 'შაბლონი ამ კოდით უკვე არსებობს',
  chk_claim_tpl_xml: 'XML — მხოლოდ ექსპორტის შაბლონისთვის',
  denial_reasons_pkey: 'მიზეზი ამ კოდით უკვე არსებობს',
  fin_claim_item_resp: 'პასუხი: მიღებულია — მოთხოვნილი თანხა; ნაწილობრივ — 0 < თანხა < მოთხოვნილი, მიზეზით; უარყოფილია — 0, მიზეზით',
  fin_claim_not_sent: 'ქლეიმი ჯერ არ არის გაგზავნილი',
  fin_claim_export_immutable: 'ექსპორტის ჩანაწერი უცვლელია',
};
const pg = (e: unknown): never => mapPgError(e, ERR);
const CATEGORIES = ['clinical', 'coding', 'admin', 'tariff', 'duplicate', 'other'] as const;
export const CATEGORY_KA: Record<string, string> = { clinical: 'კლინიკური', coding: 'კოდირება', admin: 'ადმინისტრაციული', tariff: 'ტარიფი / თანხა', duplicate: 'დუბლიკატი', other: 'სხვა' };
export const RESP_KA: Record<string, string> = { accepted: 'მიღებულია', partial: 'ნაწილობრივ', rejected: 'უარყოფილია', pending: 'განხილვაში' };
const TPL_READ = [...FIN_FULL, 'billing'] as const;

type Tpl = { id: string; code: string; name: string; kind: string; format: string; config: unknown; revision: number; is_active: boolean };

/**
 * 0058: გადამხდელის ექსპორტი / პასუხი — შაბლონები, ექსპორტის ჟურნალი, პასუხის ჩაწერა / იმპორტი, უარის მიზეზები, უარის ანგარიში.
 */
@Injectable()
export class ClaimExportService {
  constructor(private readonly c: FinCommon, private readonly claims: FinClaimsService, private readonly audit: AuditService) {}
  private get db() { return this.c.db; }

  meta() {
    return { fields: FIELDS_FOR_UI, date_formats: DATE_FORMAT_LIST, file_tokens: FILE_TOKENS, resp_keys: RESP_KEYS, resp_statuses: RESP_STATUSES, resp_ka: RESP_KA,
      categories: CATEGORIES.map((c) => ({ code: c, title: CATEGORY_KA[c] })) };
  }

  // ---------------------------------------------------------------- შაბლონები
  async templates(kind?: string) {
    let q = this.db.selectFrom('claim_templates as t').leftJoin('users as u', 'u.id', 't.updated_by')
      .select(['t.id', 't.code', 't.name', 't.kind', 't.format', 't.revision', 't.is_active', 't.notes', 't.updated_at', sql<string | null>`u.last_name || ' ' || u.first_name`.as('updated_by_name'),
        sql<string[]>`ARRAY(SELECT p.name FROM payers p WHERE p.export_template_id = t.id OR p.response_template_id = t.id ORDER BY p.name)`.as('payers'),
        sql<number>`(SELECT count(*)::int FROM fin_claim_exports e WHERE e.template_id = t.id)`.as('exports')])
      .orderBy('t.kind').orderBy('t.name');
    if (kind) q = q.where('t.kind', '=', kind);
    return q.execute();
  }
  async template(id: string) {
    const t = await this.db.selectFrom('claim_templates').selectAll().where('id', '=', id).executeTakeFirst();
    if (!t) throw new NotFoundException('შაბლონი ვერ მოიძებნა');
    const payers = await this.db.selectFrom('payers').select(['id', 'name', 'code', 'export_template_id', 'response_template_id'])
      .where((eb) => eb.or([eb('export_template_id', '=', id), eb('response_template_id', '=', id)])).orderBy('name').execute();
    return { ...t, payers };
  }
  private checkConfig(kind: string, format: string, config: unknown) {
    if (kind === 'response' && format === 'xml') throw new BadRequestException('პასუხის შაბლონი — xlsx ან csv');
    const v = kind === 'export' ? validateExport(config, format) : validateResponse(config);
    if (v.errors.length) throw new BadRequestException({ statusCode: 400, error: 'Bad Request', message: `შაბლონი: ${v.errors[0]}${v.errors.length > 1 ? ` (+${v.errors.length - 1})` : ''}`, errors: v.errors });
    return v.cfg;
  }
  async createTemplate(d: TemplateDto, u: AuthUser, ctx: AuditContext) {
    if (!d.code || !d.name || !d.kind || !d.format) throw new BadRequestException('კოდი, სახელი, ტიპი, ფორმატი — სავალდებულოა');
    const cfg = this.checkConfig(d.kind, d.format, d.config ?? {});
    try {
      return await this.db.transaction().execute(async (trx) => {
        const t = await trx.insertInto('claim_templates').values({ code: d.code!, name: d.name!.trim(), kind: d.kind!, format: d.format!, config: JSON.stringify(cfg),
          notes: d.notes?.trim() || null, is_active: d.is_active ?? true, created_by: u.id, updated_by: u.id }).returning('id').executeTakeFirstOrThrow();
        await this.audit.log(ctx, { action: 'CLAIM_TEMPLATE_CREATE', entityName: 'claim_templates', entityId: t.id, newData: { code: d.code, kind: d.kind, format: d.format, columns: this.colCount(cfg) } }, trx);
        return t;
      }).then((t) => this.template(t.id));
    } catch (e) { return pg(e); }
  }
  private colCount(cfg: unknown) { const c = (cfg as { columns?: unknown }).columns; return Array.isArray(c) ? c.length : Object.keys(c ?? {}).length; }
  async updateTemplate(id: string, d: TemplateDto, u: AuthUser, ctx: AuditContext) {
    try {
      return await this.db.transaction().execute(async (trx) => {
        const t = await trx.selectFrom('claim_templates').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
        if (!t) throw new NotFoundException('შაბლონი ვერ მოიძებნა');
        if (d.kind && d.kind !== t.kind) throw new BadRequestException('შაბლონის ტიპი არ იცვლება — შექმენით ახალი');
        if (d.code && d.code !== t.code) throw new BadRequestException('კოდი არ იცვლება');
        const format = d.format ?? t.format;
        const touchCfg = d.config !== undefined || d.format !== undefined;
        const cfg = touchCfg ? this.checkConfig(t.kind, format, d.config ?? t.config) : null;
        // jsonb გასაღებებს ალაგებს — შედარება სტაბილური JSON-ით (ძველიც ვალიდაციით ნორმალიზდება)
        const prev = t.kind === 'export' ? validateExport(t.config, t.format).cfg : validateResponse(t.config).cfg;
        const changed = touchCfg && (stableJson(cfg) !== stableJson(prev) || format !== t.format);
        const set: Record<string, unknown> = { updated_by: u.id };
        if (d.name !== undefined) set.name = d.name.trim();
        if (d.notes !== undefined) set.notes = d.notes?.trim() || null;
        if (d.is_active !== undefined) set.is_active = d.is_active;
        if (changed) { set.format = format; set.config = JSON.stringify(cfg); set.revision = t.revision + 1; }
        await trx.updateTable('claim_templates').set(set).where('id', '=', id).execute();
        await this.audit.log(ctx, { action: 'CLAIM_TEMPLATE_UPDATE', entityName: 'claim_templates', entityId: id,
          oldData: { name: t.name, format: t.format, revision: t.revision, is_active: t.is_active, ...(changed && { config: t.config }) },
          newData: { ...d, ...(changed && { revision: t.revision + 1, config: cfg }) } }, trx);
        return id;
      }).then((x) => this.template(x));
    } catch (e) { return pg(e); }
  }
  async copyTemplate(id: string, d: { code: string; name: string }, u: AuthUser, ctx: AuditContext) {
    const t = await this.template(id);
    return this.createTemplate({ code: d.code, name: d.name, kind: t.kind as 'export', format: t.format as 'csv', config: t.config as Record<string, unknown>, notes: t.notes }, u, ctx);
  }
  /** გადამხდელის ნაგულისხმევი შაბლონები */
  async setPayerTemplates(payerId: string, d: { export_template_id?: string | null; response_template_id?: string | null }, ctx: AuditContext) {
    try {
      return await this.db.transaction().execute(async (trx) => {
        const p = await trx.selectFrom('payers').select(['id', 'name', 'export_template_id', 'response_template_id']).where('id', '=', payerId).forUpdate().executeTakeFirst();
        if (!p) throw new NotFoundException('გადამხდელი ვერ მოიძებნა');
        for (const [k, kind] of [['export_template_id', 'export'], ['response_template_id', 'response']] as const) {
          const v = d[k];
          if (!v) continue;
          const t = await trx.selectFrom('claim_templates').select(['kind', 'is_active']).where('id', '=', v).executeTakeFirst();
          if (!t || t.kind !== kind) throw new BadRequestException(kind === 'export' ? 'ექსპორტის შაბლონი ვერ მოიძებნა' : 'პასუხის შაბლონი ვერ მოიძებნა');
          if (!t.is_active) throw new BadRequestException('შაბლონი გამორთულია');
        }
        const set = { ...(d.export_template_id !== undefined && { export_template_id: d.export_template_id || null }),
          ...(d.response_template_id !== undefined && { response_template_id: d.response_template_id || null }) };
        if (Object.keys(set).length) await trx.updateTable('payers').set(set).where('id', '=', payerId).execute();
        await this.audit.log(ctx, { action: 'PAYER_CLAIM_TEMPLATES', entityName: 'payers', entityId: payerId,
          oldData: { export_template_id: p.export_template_id, response_template_id: p.response_template_id }, newData: set }, trx);
        return trx.selectFrom('payers').select(['id', 'name', 'export_template_id', 'response_template_id']).where('id', '=', payerId).executeTakeFirstOrThrow();
      });
    } catch (e) { return pg(e); }
  }
  async payers() {
    return this.db.selectFrom('payers as p').leftJoin('claim_templates as e', 'e.id', 'p.export_template_id').leftJoin('claim_templates as r', 'r.id', 'p.response_template_id')
      .select(['p.id', 'p.name', 'p.code', 'p.kind', 'p.is_active', 'p.export_template_id', 'p.response_template_id', 'e.name as export_template_name', 'r.name as response_template_name'])
      .orderBy('p.is_active', 'desc').orderBy('p.name').execute();
  }

  // ---------------------------------------------------------------- უარის მიზეზები
  async reasons(all = true) {
    let q = this.db.selectFrom('denial_reasons as d').selectAll('d')
      .select(sql<number>`(SELECT count(*)::int FROM fin_claim_items ci WHERE ci.resp_reason = d.code)`.as('used')).orderBy('d.sort_order').orderBy('d.code');
    if (!all) q = q.where('d.is_active', '=', true);
    return (await q.execute()).map((r) => ({ ...r, category_ka: CATEGORY_KA[r.category] }));
  }
  async createReason(d: ReasonDto, ctx: AuditContext) {
    if (!d.code || !d.title) throw new BadRequestException('კოდი და დასახელება სავალდებულოა');
    try {
      await this.db.transaction().execute(async (trx) => {
        await trx.insertInto('denial_reasons').values({ code: d.code!, title: d.title!.trim(), category: d.category ?? 'other', external_codes: this.extCodes(d.external_codes),
          default_action: d.default_action ?? null, is_active: d.is_active ?? true, sort_order: d.sort_order ?? 100 }).execute();
        await this.audit.log(ctx, { action: 'DENIAL_REASON_CREATE', entityName: 'denial_reasons', entityId: d.code!, newData: d }, trx);
      });
    } catch (e) { return pg(e); }
    return this.reasons();
  }
  private extCodes(x?: string[]) { return [...new Set((x ?? []).map((s) => s.trim()).filter(Boolean))].slice(0, 50); }
  async updateReason(code: string, d: ReasonDto, ctx: AuditContext) {
    try {
      await this.db.transaction().execute(async (trx) => {
        const r = await trx.selectFrom('denial_reasons').selectAll().where('code', '=', code).forUpdate().executeTakeFirst();
        if (!r) throw new NotFoundException('მიზეზი ვერ მოიძებნა');
        if (d.code && d.code !== code) throw new BadRequestException('კოდი არ იცვლება');
        const set = { ...(d.title !== undefined && { title: d.title.trim() }), ...(d.category !== undefined && { category: d.category }),
          ...(d.external_codes !== undefined && { external_codes: this.extCodes(d.external_codes) }), ...(d.default_action !== undefined && { default_action: d.default_action }),
          ...(d.is_active !== undefined && { is_active: d.is_active }), ...(d.sort_order !== undefined && { sort_order: d.sort_order }) };
        if (!Object.keys(set).length) return;
        await trx.updateTable('denial_reasons').set(set).where('code', '=', code).execute();
        await this.audit.log(ctx, { action: 'DENIAL_REASON_UPDATE', entityName: 'denial_reasons', entityId: code, oldData: r, newData: set }, trx);
      });
    } catch (e) { return pg(e); }
    return this.reasons();
  }

  // ---------------------------------------------------------------- ექსპორტი
  private async loadTemplate(ex: Trx | FinCommon['db'], templateId: string | undefined, payerTemplateId: string | null, kind: 'export' | 'response'): Promise<Tpl> {
    const id = templateId ?? payerTemplateId;
    if (!id) throw new BadRequestException(kind === 'export' ? 'აირჩიეთ ექსპორტის შაბლონი (ან მიუთითეთ გადამხდელს ნაგულისხმევი)' : 'აირჩიეთ პასუხის შაბლონი (ან მიუთითეთ გადამხდელს ნაგულისხმევი)');
    const t = await ex.selectFrom('claim_templates').select(['id', 'code', 'name', 'kind', 'format', 'config', 'revision', 'is_active']).where('id', '=', id).executeTakeFirst();
    if (!t || t.kind !== kind) throw new BadRequestException('შაბლონი ვერ მოიძებნა');
    if (!t.is_active) throw new BadRequestException(`შაბლონი „${t.name}“ გამორთულია`);
    return t;
  }
  private async claimHead(ex: Trx | FinCommon['db'], id: string) {
    const c = await ex.selectFrom('fin_claims as c').innerJoin('payers as p', 'p.id', 'c.payer_id')
      .select(['c.id', 'c.claim_no', 'c.status', 'c.payer_id', 'p.code as payer_code', 'p.name as payer_name', 'p.export_template_id', 'p.response_template_id',
        sql<string>`to_char(c.period_from, 'YYYY-MM-DD')`.as('period_from'), sql<string>`to_char(c.period_to, 'YYYY-MM-DD')`.as('period_to')])
      .where('c.id', '=', id).executeTakeFirst();
    if (!c) throw new NotFoundException('ქლეიმი ვერ მოიძებნა');
    return c;
  }
  /** ფაილის აწყობა + შემოწმება (scrubber.claim_check) */
  private async build(ex: Trx | FinCommon['db'], claimId: string, templateId?: string) {
    const c = await this.claimHead(ex, claimId);
    if (c.status === 'cancelled') throw new ConflictException('ქლეიმი გაუქმებულია');
    const t = await this.loadTemplate(ex, templateId, c.export_template_id, 'export');
    const v = validateExport(t.config, t.format);
    if (v.errors.length) throw new BadRequestException(`შაბლონი „${t.name}“: ${v.errors[0]}`);
    const items = await claimRows(ex, claimId);
    // შემოწმება — ჩართულია და claim_check ≠ off
    const sc = await scrubSettings(ex);
    let errors: { invoice_number: string; errors: string }[] = []; let warnings = 0;
    if (sc.enabled && sc.claim_check !== 'off' && items.length) {
      const rules = await loadRules(ex);
      for (const it of items) {
        const r = await scrubInvoice(ex, it.invoice_id, { payerId: c.payer_id, rules });
        if (r.errors) errors.push({ invoice_number: String(it.data.invoice_number), errors: errorText(r) });
        else if (r.warnings) warnings++;
      }
    }
    if (sc.claim_check !== 'block') { warnings += errors.length; errors = []; }
    const today = await this.c.today(ex);
    const out = renderExport(t.format, v.cfg as ExportConfig, items, { claim_no: c.claim_no, payer_code: c.payer_code, period_from: c.period_from, period_to: c.period_to, today, template_code: t.code });
    return { c, t, cfg: v.cfg, out, scrub: { errors, warnings, mode: sc.enabled ? sc.claim_check : 'off' } };
  }
  async preview(claimId: string, templateId?: string) {
    await this.c.rules();
    const b = await this.build(this.db, claimId, templateId);
    return { template: { id: b.t.id, code: b.t.code, name: b.t.name, format: b.t.format, revision: b.t.revision }, file_name: b.out.file_name, rows: b.out.rows, total: b.out.total,
      header: b.out.preview.header, preview: b.out.preview.rows, scrub: b.scrub, claim_status: b.c.status, can_export: b.c.status !== 'draft' && !b.scrub.errors.length };
  }
  async export(claimId: string, d: { template_id?: string; note?: string | null }, u: AuthUser, ctx: AuditContext) {
    await this.c.rules();
    try {
      return await this.db.transaction().execute(async (trx) => {
        await trx.selectFrom('fin_claims').select('id').where('id', '=', claimId).forUpdate().executeTakeFirst();
        const b = await this.build(trx, claimId, d.template_id);
        if (b.c.status === 'draft') throw new ConflictException('ექსპორტი — გაგზავნის შემდეგ (მონახაზზე — მხოლოდ გადახედვა)');
        if (b.scrub.errors.length) {
          throw new ConflictException({ code: 'SCRUB_ERRORS', message: `შემოწმება: ${b.scrub.errors.length} შემთხვევას აქვს შეცდომა — გაასწორეთ ან დაუშვით გამონაკლისი (${b.scrub.errors.slice(0, 3).map((x) => x.invoice_number).join(', ')}${b.scrub.errors.length > 3 ? ' …' : ''})`,
            items: b.scrub.errors });
        }
        if (!b.out.rows) throw new BadRequestException(`შაბლონის ფილტრით (${b.cfg.kinds.join(', ')}) ქლეიმში შემთხვევა არ არის`);
        const r = await trx.insertInto('fin_claim_exports').values({ claim_id: claimId, template_id: b.t.id, template_revision: b.t.revision,
          template_snapshot: JSON.stringify({ code: b.t.code, name: b.t.name, format: b.t.format, config: b.cfg }), file_name: b.out.file_name, content_type: b.out.content_type,
          content: b.out.content, sha256: b.out.sha256, rows: b.out.rows, total: b.out.total.toFixed(2), scrub_warnings: b.scrub.warnings, note: d.note?.trim() || null, created_by: u.id })
          .returning(['id', 'created_at']).executeTakeFirstOrThrow();
        const prev = await trx.selectFrom('fin_claim_exports').select(sql<number>`count(*)::int`.as('n')).where('claim_id', '=', claimId).executeTakeFirstOrThrow();
        await this.audit.log(ctx, { action: 'FIN_CLAIM_FILE_EXPORT', entityName: 'fin_claims', entityId: claimId,
          newData: { export_id: r.id, template: b.t.code, revision: b.t.revision, file: b.out.file_name, rows: b.out.rows, total: b.out.total, sha256: b.out.sha256, n: prev.n } }, trx);
        return { id: r.id, file_name: b.out.file_name, rows: b.out.rows, total: b.out.total, sha256: b.out.sha256, scrub_warnings: b.scrub.warnings, repeat: prev.n > 1 };
      });
    } catch (e) { return pg(e); }
  }
  async exports(claimId: string) {
    return this.db.selectFrom('fin_claim_exports as e').innerJoin('users as u', 'u.id', 'e.created_by').innerJoin('claim_templates as t', 't.id', 'e.template_id')
      .select(['e.id', 'e.file_name', 'e.content_type', 'e.sha256', 'e.rows', 'e.total', 'e.scrub_warnings', 'e.note', 'e.created_at', 'e.template_revision', 't.code as template_code',
        't.name as template_name', sql<number>`octet_length(e.content)`.as('size'), sql<string>`u.last_name || ' ' || u.first_name`.as('created_by_name')])
      .where('e.claim_id', '=', claimId).orderBy('e.created_at', 'desc').execute();
  }
  async file(id: string, ctx: AuditContext) {
    await this.c.rules();
    const e = await this.db.selectFrom('fin_claim_exports').select(['id', 'claim_id', 'file_name', 'content_type', 'content', 'sha256']).where('id', '=', id).executeTakeFirst();
    if (!e) throw new NotFoundException('ექსპორტი ვერ მოიძებნა');
    await this.audit.log(ctx, { action: 'FIN_CLAIM_FILE_DOWNLOAD', entityName: 'fin_claims', entityId: e.claim_id, newData: { export_id: id, file: e.file_name, sha256: e.sha256 } });
    return e;
  }

  // ---------------------------------------------------------------- პასუხი
  private async reasonCode(trx: Trx, code: string | null | undefined) {
    if (!code) return null;
    const r = await trx.selectFrom('denial_reasons').select(['code', 'is_active']).where('code', '=', code).executeTakeFirst();
    if (!r) throw new BadRequestException(`უარის მიზეზი „${code}“ ვერ მოიძებნა`);
    if (!r.is_active) throw new BadRequestException(`უარის მიზეზი „${code}“ გამორთულია`);
    return r.code;
  }
  /** სტატუსი + თანხა → ჩასაწერი მნიშვნელობები (ან შეცდომის ტექსტი) */
  private respValues(claimed: number, st: RespStatus, amount: number | undefined, reason: string | null): { amount: number | null; error?: string } {
    if (st === 'pending') return { amount: null };
    if (st === 'accepted') {
      if (amount !== undefined && Math.abs(amount - claimed) > 0.001) return { amount: null, error: `მიღებულია, მაგრამ თანხა (${amount.toFixed(2)}) ≠ მოთხოვნილს (${claimed.toFixed(2)})` };
      return { amount: claimed };
    }
    if (!reason) return { amount: null, error: 'უარის მიზეზი სავალდებულოა' };
    if (st === 'rejected') {
      if (amount !== undefined && amount > 0.001) return { amount: null, error: `უარყოფილია, მაგრამ თანხა ${amount.toFixed(2)} > 0` };
      return { amount: 0 };
    }
    if (amount === undefined) return { amount: null, error: 'ნაწილობრივ — დამტკიცებული თანხა სავალდებულოა' };
    if (!(amount > 0 && amount < claimed)) return { amount: null, error: `ნაწილობრივ: 0 < თანხა < ${claimed.toFixed(2)}` };
    return { amount };
  }
  private async lockSent(trx: Trx, claimId: string) {
    const c = await trx.selectFrom('fin_claims').select(['id', 'status']).where('id', '=', claimId).forUpdate().executeTakeFirst();
    if (!c) throw new NotFoundException('ქლეიმი ვერ მოიძებნა');
    if (!['sent', 'partial', 'settled'].includes(c.status)) throw new ConflictException('პასუხი — მხოლოდ გაგზავნილ ქლეიმზე');
    return c;
  }
  async setResponse(itemId: string, d: ResponseDto, u: AuthUser, ctx: AuditContext) {
    await this.c.rules();
    try {
      return await this.db.transaction().execute(async (trx) => {
        const it = await trx.selectFrom('fin_claim_items').select(['id', 'claim_id', 'claimed', 'resp_status', 'resp_amount', 'resp_reason', 'resp_note', 'resp_ref'])
          .where('id', '=', itemId).forUpdate().executeTakeFirst();
        if (!it) throw new NotFoundException('შემთხვევა ვერ მოიძებნა');
        await this.lockSent(trx, it.claim_id);
        let set: Record<string, unknown>;
        if (!d.status) {
          set = { resp_status: null, resp_amount: null, resp_reason: null, resp_note: null, resp_ref: null, resp_at: null, resp_by: null, resp_import_id: null };
        } else {
          const reason = d.status === 'accepted' || d.status === 'pending' ? (d.reason ? await this.reasonCode(trx, d.reason) : null) : await this.reasonCode(trx, d.reason);
          const v = this.respValues(n(it.claimed), d.status, d.amount, reason);
          if (v.error) throw new BadRequestException(v.error);
          set = { resp_status: d.status, resp_amount: v.amount === null ? null : v.amount.toFixed(2), resp_reason: reason, resp_note: d.note?.trim() || null, resp_ref: d.ref?.trim() || null,
            resp_at: sql`now()`, resp_by: u.id, resp_import_id: null };
        }
        await trx.updateTable('fin_claim_items').set(set).where('id', '=', itemId).execute();
        await this.audit.log(ctx, { action: 'FIN_CLAIM_RESPONSE', entityName: 'fin_claim_items', entityId: itemId,
          oldData: { status: it.resp_status, amount: it.resp_amount, reason: it.resp_reason }, newData: { claim_id: it.claim_id, ...d } }, trx);
        return this.claims.get(it.claim_id, trx);
      });
    } catch (e) { return pg(e); }
  }

  /** პასუხის ფაილი → შესაბამისობა (dry_run) / ჩაწერა */
  async importResponses(claimId: string, file: { buffer: Buffer; originalname: string }, templateId: string | undefined, commit: boolean, u: AuthUser, ctx: AuditContext) {
    await this.c.rules();
    if (!file.buffer.length) throw new BadRequestException('ფაილი ცარიელია');
    try {
      return await this.db.transaction().execute(async (trx) => {
        const c = await this.claimHead(trx, claimId);
        await this.lockSent(trx, claimId);
        const t = await this.loadTemplate(trx, templateId, c.response_template_id, 'response');
        const v = validateResponse(t.config);
        if (v.errors.length) throw new BadRequestException(`შაბლონი „${t.name}“: ${v.errors[0]}`);
        let parsed: ParsedResp[];
        try { parsed = parseResponseFile(file.buffer, file.originalname, v.cfg); } catch (e) { throw new BadRequestException(`ფაილი: ${(e as Error).message}`); }
        if (parsed.length > 20_000) throw new BadRequestException('ფაილი: მაქსიმუმ 20 000 ხაზი');
        const rows = await claimRows(trx, claimId);
        const items = await trx.selectFrom('fin_claim_items').select(['id', 'claimed']).where('claim_id', '=', claimId).execute();
        const claimedOf = new Map(items.map((x) => [x.id, n(x.claimed)]));
        // გასაღები → შემთხვევები
        const keyOf = (data: Record<string, unknown>) => String(data[v.cfg.key_field] ?? '').trim().toLowerCase();
        const idx = new Map<string, { id: string; invoice_number: string; patient: string }[]>();
        for (const r of rows) {
          const k = keyOf(r.data); if (!k) continue;
          const a = idx.get(k) ?? []; a.push({ id: r.id, invoice_number: String(r.data.invoice_number), patient: String(r.data.full_name) }); idx.set(k, a);
        }
        const reasons = await trx.selectFrom('denial_reasons').select(['code', 'title', 'external_codes', 'is_active']).execute();
        const reasonOf = (raw: string | undefined) => {
          if (!raw) return null;
          const k = raw.trim().toLowerCase();
          const r = reasons.find((x) => x.is_active && (x.code.toLowerCase() === k || x.external_codes.some((e) => e.toLowerCase() === k) || x.title.trim().toLowerCase() === k));
          return r?.code ?? null;
        };
        const hasOther = reasons.some((r) => r.code === 'OTHER' && r.is_active);
        const seen = new Set<string>();
        const out: { row: number; key: string; item_id?: string; invoice_number?: string; patient?: string; status?: RespStatus; amount?: number | null; reason?: string | null;
          note?: string; ref?: string; problem?: string; warn?: string }[] = [];
        for (const p of parsed) {
          const o: (typeof out)[number] = { row: p.row, key: p.key };
          out.push(o);
          if (p.error) { o.problem = p.error; continue; }
          const m = idx.get(p.key.toLowerCase()) ?? [];
          if (!m.length) { o.problem = 'ქლეიმში შემთხვევა ვერ მოიძებნა'; continue; }
          if (m.length > 1) { o.problem = `გასაღები ემთხვევა ${m.length} შემთხვევას — აირჩიეთ სხვა საიდენტიფიკაციო ველი`; continue; }
          const it = m[0]; o.item_id = it.id; o.invoice_number = it.invoice_number; o.patient = it.patient;
          if (seen.has(it.id)) { o.problem = 'შემთხვევა ფაილში მეორდება'; continue; }
          seen.add(it.id);
          const claimed = claimedOf.get(it.id)!;
          let amount = p.amount;
          if (amount !== undefined && v.cfg.amount_kind === 'denied') amount = r2(claimed - amount);
          let st = p.status;
          if (!st) {
            if (amount === undefined) { o.problem = 'სტატუსი / თანხა არ არის'; continue; }
            st = amount >= claimed - 0.001 ? 'accepted' : amount <= 0.001 ? 'rejected' : 'partial';
            if (st === 'accepted') amount = claimed;
          }
          let reason = reasonOf(p.reason_raw);
          let note = p.note;
          if (p.reason_raw && !reason) {
            if ((st === 'rejected' || st === 'partial') && hasOther) { reason = 'OTHER'; note = [`მიზეზი: ${p.reason_raw}`, note].filter(Boolean).join('; '); o.warn = `მიზეზი „${p.reason_raw}“ ცნობარში არ არის → OTHER`; }
            else if (st === 'rejected' || st === 'partial') { o.problem = `მიზეზი „${p.reason_raw}“ ცნობარში არ არის`; continue; }
          }
          const rv = this.respValues(claimed, st, amount, reason);
          if (rv.error) { o.problem = rv.error; continue; }
          Object.assign(o, { status: st, amount: rv.amount, reason, note, ref: p.ref });
        }
        const ok = out.filter((o) => !o.problem && o.item_id);
        const summary = { template: { id: t.id, name: t.name }, rows: parsed.length, matched: ok.length, problems: out.filter((o) => o.problem).length,
          by_status: Object.fromEntries(RESP_STATUSES.map((s) => [s, ok.filter((o) => o.status === s).length])), not_in_file: items.length - seen.size };
        if (!commit) return { dry_run: true, ...summary, lines: out.slice(0, 1000) };
        if (!ok.length) throw new BadRequestException('ჩასაწერი პასუხი არ არის (ყველა ხაზს აქვს პრობლემა)');
        const sha = createHash('sha256').update(file.buffer).digest('hex');
        const imp = await trx.insertInto('fin_claim_response_imports').values({ claim_id: claimId, template_id: t.id, file_name: file.originalname.slice(0, 200), sha256: sha,
          rows: parsed.length, matched: ok.length, applied: ok.length, problems: JSON.stringify(out.filter((o) => o.problem || o.warn).slice(0, 2000).map((o) => ({ row: o.row, key: o.key, message: o.problem ?? o.warn, warn: !o.problem }))),
          created_by: u.id }).returning('id').executeTakeFirstOrThrow();
        for (const o of ok) {
          await trx.updateTable('fin_claim_items').set({ resp_status: o.status!, resp_amount: o.amount === null || o.amount === undefined ? null : o.amount.toFixed(2), resp_reason: o.reason ?? null,
            resp_note: o.note?.trim() || null, resp_ref: o.ref?.trim() || null, resp_at: sql`now()`, resp_by: u.id, resp_import_id: imp.id }).where('id', '=', o.item_id!).execute();
        }
        await this.audit.log(ctx, { action: 'FIN_CLAIM_RESPONSE_IMPORT', entityName: 'fin_claims', entityId: claimId,
          newData: { import_id: imp.id, file: file.originalname, sha256: sha, template: t.code, rows: parsed.length, applied: ok.length, problems: summary.problems } }, trx);
        return { dry_run: false, import_id: imp.id, ...summary, lines: out.filter((o) => o.problem || o.warn).slice(0, 1000) };
      });
    } catch (e) { return pg(e); }
  }
  async imports(claimId: string) {
    return this.db.selectFrom('fin_claim_response_imports as i').innerJoin('users as u', 'u.id', 'i.created_by').leftJoin('claim_templates as t', 't.id', 'i.template_id')
      .select(['i.id', 'i.file_name', 'i.sha256', 'i.rows', 'i.matched', 'i.applied', 'i.problems', 'i.created_at', 't.name as template_name',
        sql<string>`u.last_name || ' ' || u.first_name`.as('created_by_name')]).where('i.claim_id', '=', claimId).orderBy('i.created_at', 'desc').execute();
  }

  /** უარი / ნაწილობრივი → გადაწყვეტა მიზეზის ნაგულისხმევი ქმედებით (პაციენტზე / ჩამოწერა) */
  async applyDenials(claimId: string, d: { item_ids?: string[] }, u: AuthUser, ctx: AuditContext) {
    await this.c.rules();
    try {
      return await this.db.transaction().execute(async (trx) => {
        const c = await trx.selectFrom('fin_claims').select(['id', 'status']).where('id', '=', claimId).forUpdate().executeTakeFirst();
        if (!c) throw new NotFoundException('ქლეიმი ვერ მოიძებნა');
        if (!['sent', 'partial'].includes(c.status)) throw new ConflictException('გადაწყვეტა — მხოლოდ გაგზავნილ, დაუფარავ ქლეიმზე');
        let q = trx.selectFrom('fin_claim_items as ci').innerJoin('denial_reasons as dr', 'dr.code', 'ci.resp_reason')
          .select(['ci.id', 'ci.claimed', 'ci.paid', 'ci.resolved_amount', 'ci.resp_amount', 'ci.resolution', 'dr.code', 'dr.title', 'dr.default_action'])
          .where('ci.claim_id', '=', claimId).where('ci.resp_status', 'in', ['rejected', 'partial']);
        if (d.item_ids?.length) q = q.where('ci.id', 'in', d.item_ids);
        const list = await q.execute();
        const done: { item_id: string; action: string; amount: number }[] = []; const skipped: { item_id: string; reason: string }[] = [];
        for (const x of list) {
          if (x.resolution) { skipped.push({ item_id: x.id, reason: 'უკვე გადაწყვეტილია' }); continue; }
          if (!x.default_action) { skipped.push({ item_id: x.id, reason: `მიზეზს „${x.title}“ ნაგულისხმევი ქმედება არ აქვს — გადაწყვიტეთ ხელით` }); continue; }
          const outstanding = r2(n(x.claimed) - n(x.paid) - n(x.resolved_amount));
          const denied = r2(n(x.claimed) - n(x.resp_amount));
          const amount = r2(Math.min(denied, outstanding));
          if (amount <= 0) { skipped.push({ item_id: x.id, reason: 'დაუფარავი ნაშთი არ არის' }); continue; }
          await this.claims.resolveTx(trx, x.id, { action: x.default_action as 'patient' | 'writeoff', amount, reason: `უარი: ${x.code} — ${x.title}` }, u, ctx);
          done.push({ item_id: x.id, action: x.default_action, amount });
        }
        if (d.item_ids?.length) for (const id of d.item_ids) if (!list.some((x) => x.id === id)) skipped.push({ item_id: id, reason: 'პასუხი არ არის „უარყოფილია / ნაწილობრივ“' });
        await this.audit.log(ctx, { action: 'FIN_CLAIM_APPLY_DENIALS', entityName: 'fin_claims', entityId: claimId, newData: { done: done.length, skipped: skipped.length,
          amount: r2(done.reduce((s, x) => s + x.amount, 0)) } }, trx);
        return { done, skipped, claim: await this.claims.get(claimId, trx) };
      });
    } catch (e) { return pg(e); }
  }

  // ---------------------------------------------------------------- უარის ანგარიში
  async denialsReport(from: string, to: string, payerId?: string) {
    await this.c.rules();
    const p = this.c.period(from, to);
    const rows = (await sql<{ item_id: string; claim_id: string; claim_no: string | null; payer_id: string; payer_name: string; kind: string; claimed: string; resp_amount: string;
      resp_status: string; reason: string; reason_title: string; category: string; dept: string | null; invoice_number: string; patient: string; resp_date: string; resolution: string | null; resolved_amount: string }>`
      SELECT ci.id AS item_id, c.id AS claim_id, c.claim_no, c.payer_id, py.name AS payer_name, ci.kind, ci.claimed::text, ci.resp_amount::text, ci.resp_status,
             dr.code AS reason, dr.title AS reason_title, dr.category, coalesce(bd.name, d.name) AS dept, i.invoice_number, pt.last_name || ' ' || pt.first_name AS patient,
             to_char(fin_local_date(ci.resp_at), 'YYYY-MM-DD') AS resp_date, ci.resolution, ci.resolved_amount::text
        FROM fin_claim_items ci JOIN fin_claims c ON c.id = ci.claim_id JOIN payers py ON py.id = ci.payer_id
        JOIN denial_reasons dr ON dr.code = ci.resp_reason JOIN invoices i ON i.id = ci.invoice_id JOIN encounters e ON e.id = i.encounter_id JOIN patients pt ON pt.id = e.patient_id
        LEFT JOIN departments d ON d.id = e.department_id
        LEFT JOIN LATERAL (SELECT dd.name FROM bed_assignments a JOIN departments dd ON dd.id = a.department_id WHERE a.encounter_id = e.id AND a.end_kind IS DISTINCT FROM 'cancel'
                            ORDER BY a.ended_at IS NULL DESC, a.started_at DESC, a.id DESC LIMIT 1) bd ON TRUE
       WHERE ci.resp_status IN ('rejected', 'partial') AND fin_local_date(ci.resp_at) BETWEEN ${p.from}::date AND ${p.to}::date
         ${payerId ? sql`AND ci.payer_id = ${payerId}::uuid` : sql``}
       ORDER BY ci.resp_at DESC`.execute(this.db)).rows;
    // საერთო (უარის წილისთვის) — პასუხიანი შემთხვევები იმავე პერიოდში
    const base = (await sql<{ cases: number; claimed: string }>`
      SELECT count(*)::int AS cases, coalesce(sum(ci.claimed), 0)::text AS claimed FROM fin_claim_items ci
       WHERE ci.resp_status IN ('accepted', 'partial', 'rejected') AND fin_local_date(ci.resp_at) BETWEEN ${p.from}::date AND ${p.to}::date
         ${payerId ? sql`AND ci.payer_id = ${payerId}::uuid` : sql``}`.execute(this.db)).rows[0];
    type G = { key: string; title: string; cases: number; rejected: number; partial: number; claimed: number; denied: number; resolved_patient: number; resolved_writeoff: number };
    const group = (keyFn: (r: (typeof rows)[number]) => [string, string]) => {
      const m = new Map<string, G>();
      for (const r of rows) {
        const [k, t] = keyFn(r);
        const g = m.get(k) ?? { key: k, title: t, cases: 0, rejected: 0, partial: 0, claimed: 0, denied: 0, resolved_patient: 0, resolved_writeoff: 0 };
        g.cases++; if (r.resp_status === 'rejected') g.rejected++; else g.partial++;
        g.claimed = r2(g.claimed + n(r.claimed)); g.denied = r2(g.denied + n(r.claimed) - n(r.resp_amount));
        if (r.resolution === 'patient') g.resolved_patient = r2(g.resolved_patient + n(r.resolved_amount));
        if (r.resolution === 'writeoff') g.resolved_writeoff = r2(g.resolved_writeoff + n(r.resolved_amount));
        m.set(k, g);
      }
      return [...m.values()].sort((a, b) => b.denied - a.denied);
    };
    const denied = r2(rows.reduce((s, r) => s + n(r.claimed) - n(r.resp_amount), 0));
    return {
      from: p.from, to: p.to,
      totals: { responded_cases: base.cases, responded_claimed: n(base.claimed), denied_cases: rows.length, denied, denial_rate: n(base.claimed) ? r2((denied / n(base.claimed)) * 100) : 0,
        rejected: rows.filter((r) => r.resp_status === 'rejected').length, partial: rows.filter((r) => r.resp_status === 'partial').length,
        unresolved: r2(rows.filter((r) => !r.resolution).reduce((s, r) => s + n(r.claimed) - n(r.resp_amount), 0)) },
      by_reason: group((r) => [r.reason, r.reason_title]),
      by_category: group((r) => [r.category, CATEGORY_KA[r.category] ?? r.category]),
      by_department: group((r) => [r.dept ?? '—', r.dept ?? '—']),
      by_payer: group((r) => [r.payer_id, r.payer_name]),
      items: rows.slice(0, 500).map((r) => ({ ...r, claimed: n(r.claimed), approved: n(r.resp_amount), denied: r2(n(r.claimed) - n(r.resp_amount)), resp_ka: RESP_KA[r.resp_status] })),
    };
  }
}

// ======================================================================= DTO
class TemplateDto {
  @IsOptional() @Matches(/^[A-Z][A-Z0-9_]{1,39}$/, { message: 'კოდი: ლათ. დიდი ასოები, ციფრები, _ (2–40)' }) code?: string;
  @IsOptional() @IsString() @Length(2, 200) name?: string;
  @IsOptional() @IsIn(['export', 'response']) kind?: 'export' | 'response';
  @IsOptional() @IsIn(['xlsx', 'csv', 'xml']) format?: 'xlsx' | 'csv' | 'xml';
  @IsOptional() @IsObject() config?: Record<string, unknown>;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string | null;
  @IsOptional() @IsBoolean() is_active?: boolean;
}
class CopyDto { @Matches(/^[A-Z][A-Z0-9_]{1,39}$/, { message: 'კოდი: ლათ. დიდი ასოები, ციფრები, _ (2–40)' }) code: string; @IsString() @Length(2, 200) name: string }
class PayerTplDto { @IsOptional() @IsUUID() export_template_id?: string | null; @IsOptional() @IsUUID() response_template_id?: string | null }
class ReasonDto {
  @IsOptional() @Matches(/^[A-Z0-9][A-Z0-9_.-]{0,19}$/, { message: 'კოდი: ლათ. დიდი ასოები, ციფრები, _ . - (≤ 20)' }) code?: string;
  @IsOptional() @IsString() @Length(2, 300) title?: string;
  @IsOptional() @IsIn(CATEGORIES) category?: (typeof CATEGORIES)[number];
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) @MaxLength(100, { each: true }) external_codes?: string[];
  @IsOptional() @IsIn(['patient', 'writeoff', null]) default_action?: 'patient' | 'writeoff' | null;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(100_000) sort_order?: number;
}
class ExportDto { @IsOptional() @IsUUID() template_id?: string; @IsOptional() @IsString() @MaxLength(500) note?: string | null }
class ResponseDto {
  @IsOptional() @IsIn([...RESP_STATUSES, null]) status?: RespStatus | null;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100_000_000) amount?: number;
  @IsOptional() @IsString() @MaxLength(20) reason?: string | null;
  @IsOptional() @IsString() @MaxLength(1000) note?: string | null;
  @IsOptional() @IsString() @MaxLength(60) ref?: string | null;
}
class IdsDto { @IsOptional() @IsArray() @ArrayMaxSize(5000) @IsUUID('all', { each: true }) item_ids?: string[] }

const uuidOk = (x?: string) => !x || /^[0-9a-f-]{36}$/i.test(x);

@Controller()
export class ClaimExportController {
  constructor(private readonly s: ClaimExportService) {}
  // შაბლონები
  @Get('claim-templates/meta') @Roles(...TPL_READ) meta() { return this.s.meta(); }
  @Get('claim-templates/payers') @Roles(...TPL_READ) payers() { return this.s.payers(); }
  @Get('claim-templates') @Roles(...TPL_READ) list(@Query('kind') kind?: string) {
    if (kind && !['export', 'response'].includes(kind)) throw new BadRequestException('kind: export | response');
    return this.s.templates(kind);
  }
  @Get('claim-templates/:id') @Roles(...TPL_READ) one(@Param('id', ParseUUIDPipe) id: string) { return this.s.template(id); }
  @Post('claim-templates') @Roles(...FIN_EDIT) create(@Body() d: TemplateDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.createTemplate(d, u, auditCtx(r)); }
  @Patch('claim-templates/:id') @Roles(...FIN_EDIT) update(@Param('id', ParseUUIDPipe) id: string, @Body() d: TemplateDto, @CurrentUser() u: AuthUser, @Req() r: Request) {
    return this.s.updateTemplate(id, d, u, auditCtx(r));
  }
  @Post('claim-templates/:id/copy') @Roles(...FIN_EDIT) copy(@Param('id', ParseUUIDPipe) id: string, @Body() d: CopyDto, @CurrentUser() u: AuthUser, @Req() r: Request) {
    return this.s.copyTemplate(id, d, u, auditCtx(r));
  }
  @Put('claim-templates/payers/:payerId') @Roles(...FIN_EDIT) payerTpl(@Param('payerId', ParseUUIDPipe) id: string, @Body() d: PayerTplDto, @Req() r: Request) {
    return this.s.setPayerTemplates(id, d, auditCtx(r));
  }
  // უარის მიზეზები
  @Get('denial-reasons') @Roles(...FIN_FULL, 'billing') reasons(@Query('active') active?: string) { return this.s.reasons(active !== '1'); }
  @Post('denial-reasons') @Roles(...FIN_EDIT) createReason(@Body() d: ReasonDto, @Req() r: Request) { return this.s.createReason(d, auditCtx(r)); }
  @Patch('denial-reasons/:code') @Roles(...FIN_EDIT) updateReason(@Param('code') code: string, @Body() d: ReasonDto, @Req() r: Request) {
    if (!/^[A-Z0-9][A-Z0-9_.-]{0,19}$/.test(code)) throw new BadRequestException('კოდი');
    return this.s.updateReason(code, d, auditCtx(r));
  }
  // ექსპორტი
  @Get('finance/claims/:id/export-preview') @Roles(...FIN_FULL, 'billing') preview(@Param('id', ParseUUIDPipe) id: string, @Query('template_id') t?: string) {
    if (!uuidOk(t)) throw new BadRequestException('template_id');
    return this.s.preview(id, t);
  }
  @Get('finance/claims/:id/exports') @Roles(...FIN_FULL, 'billing') exports(@Param('id', ParseUUIDPipe) id: string) { return this.s.exports(id); }
  @Post('finance/claims/:id/exports') @Roles(...FIN_EDIT) exp(@Param('id', ParseUUIDPipe) id: string, @Body() d: ExportDto, @CurrentUser() u: AuthUser, @Req() r: Request) {
    return this.s.export(id, d, u, auditCtx(r));
  }
  @Get('finance/claim-exports/:id/file') @Roles(...FIN_FULL, 'billing')
  async file(@Param('id', ParseUUIDPipe) id: string, @Req() r: Request, @Res() res: Response) {
    const e = await this.s.file(id, auditCtx(r));
    res.setHeader('content-type', e.content_type);
    res.setHeader('content-disposition', `attachment; filename="${encodeURIComponent(e.file_name)}"; filename*=UTF-8''${encodeURIComponent(e.file_name)}`);
    res.setHeader('x-content-sha256', e.sha256);
    res.end(e.content);
  }
  // პასუხი
  @Put('finance/claim-items/:id/response') @HttpCode(200) @Roles(...CLAIM_RESOLVE) resp(@Param('id', ParseUUIDPipe) id: string, @Body() d: ResponseDto, @CurrentUser() u: AuthUser, @Req() r: Request) {
    return this.s.setResponse(id, d, u, auditCtx(r));
  }
  @Post('finance/claims/:id/responses/import') @HttpCode(200) @Roles(...CLAIM_RESOLVE) @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }))
  imp(@Param('id', ParseUUIDPipe) id: string, @UploadedFile() file: Express.Multer.File | undefined, @Query('template_id') t: string | undefined, @Query('commit') commit: string | undefined,
      @CurrentUser() u: AuthUser, @Req() r: Request) {
    if (!file) throw new BadRequestException('ფაილი არ არის (ველი file)');
    if (!uuidOk(t)) throw new BadRequestException('template_id');
    return this.s.importResponses(id, file, t, commit === 'true', u, auditCtx(r));
  }
  @Get('finance/claims/:id/response-imports') @Roles(...FIN_FULL, 'billing') imports(@Param('id', ParseUUIDPipe) id: string) { return this.s.imports(id); }
  @Post('finance/claims/:id/apply-denials') @HttpCode(200) @Roles(...CLAIM_RESOLVE) apply(@Param('id', ParseUUIDPipe) id: string, @Body() d: IdsDto, @CurrentUser() u: AuthUser, @Req() r: Request) {
    return this.s.applyDenials(id, d, u, auditCtx(r));
  }
  // ანგარიში
  @Get('finance/reports/denials') @Roles(...FIN_FULL, 'billing') denials(@Query('from') from: string, @Query('to') to: string, @Query('payer_id') payer?: string) {
    if (!uuidOk(payer)) throw new BadRequestException('payer_id');
    return this.s.denialsReport(from, to, payer);
  }
}
