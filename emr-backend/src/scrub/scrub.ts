import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, HttpCode, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post,
  Req } from '@nestjs/common';
import { IsArray, IsBoolean, IsIn, IsObject, IsOptional, IsString, IsUUID, Length, Matches, MaxLength } from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser, Role } from '../auth/roles';
import { mapPgError } from '../common/pg-errors';
import { InjectDb, type Database } from '../database/database.module';
import { type Cond, condsText, FIELDS, normPattern, parseConds, PATTERN_RE, validateCond } from '../drg/drg-engine';
import { BUILTIN_PARAMS, CUSTOM_FORBIDDEN, GROUP_KA, PAYER_RULES, scrubInvoice, scrubSettings } from './scrub-engine';

const READ: Role[] = ['admin', 'billing', 'drg', 'drg_admin', 'accountant', 'viewer', 'tariffs'];
const ADMIN: Role[] = ['admin', 'drg_admin'];
const OVERRIDE: Role[] = ['admin', 'billing', 'drg'];
const CASE_READ: Role[] = ['admin', 'billing', 'drg', 'drg_admin', 'accountant', 'viewer', 'receptionist', 'manager'];
const KINDS = ['insurance', 'state', 'other'] as const;

class RuleDto {
  @IsOptional() @Matches(/^[A-Z][A-Z0-9_]{1,39}$/, { message: 'კოდი: ლათ. დიდი ასოები, ციფრები, _' }) code?: string;
  @IsOptional() @IsString() @Length(2, 300) title?: string;
  @IsOptional() @IsString() @MaxLength(500) message?: string | null;
  @IsOptional() @IsIn(['error', 'warn']) severity?: 'error' | 'warn';
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsArray() @IsIn(KINDS, { each: true }) payer_kinds?: string[];
  @IsOptional() @IsArray() @IsUUID('all', { each: true }) payer_ids?: string[];
  @IsOptional() @IsObject() params?: Record<string, unknown>;
  @IsOptional() @IsString() @MaxLength(5000) conditions_text?: string;
  @IsOptional() @IsBoolean() allow_override?: boolean;
}
class OverrideDto {
  @IsUUID() invoice_id: string;
  @Matches(/^[A-Z][A-Z0-9_]{1,39}$/) rule_code: string;
  @IsOptional() @IsUUID() payer_id?: string | null;
  @IsString() @Length(5, 500) reason: string;
}
class ReasonDto { @IsString() @Length(5, 500) reason: string }

/** Claim scrubber (0057): წესების კონფიგურაცია, შემთხვევის შედეგი, გამონაკლისები */
@Injectable()
export class ScrubService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService) {}

  meta() {
    const fields = Object.fromEntries(Object.entries(FIELDS).filter(([k]) => !CUSTOM_FORBIDDEN.has(k)));
    return { groups: GROUP_KA, builtin_params: BUILTIN_PARAMS, payer_rules: [...PAYER_RULES], fields,
      examples: ['los > 20 & pdx in J18', 'age < 1 & proc none JEA', 'discharge in death & icu_hours = 0'] };
  }

  async rules() {
    const rows = await this.db.selectFrom('scrub_rules as r').leftJoin('users as u', 'u.id', 'r.updated_by')
      .selectAll('r').select(sql<string | null>`u.first_name || ' ' || u.last_name`.as('updated_by_name')).orderBy('r.sort_order').orderBy('r.code').execute();
    return rows.map((r) => ({ ...r, conditions_text: r.builtin ? null : condsText(r.conditions as unknown as Cond[]), group_ka: GROUP_KA[r.grp], payer_scoped: PAYER_RULES.has(r.code) }));
  }

  private params(code: string, p: Record<string, unknown>) {
    const defs = BUILTIN_PARAMS[code] ?? [];
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(p)) if (!defs.some((d) => d.key === k)) throw new BadRequestException(`უცნობი პარამეტრი: ${k}`);
    for (const d of defs) {
      const v = p[d.key];
      if (v === undefined) continue;
      if (d.type === 'int') {
        if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 100000) throw new BadRequestException(`${d.label}: მთელი რიცხვი`);
        out[d.key] = v;
      } else {
        if (!Array.isArray(v) || v.length > 200) throw new BadRequestException(`${d.label}: სია`);
        const pats = (v as unknown[]).map((x) => normPattern(String(x))).filter(Boolean);
        const bad = pats.find((x) => !PATTERN_RE.test(x));
        if (bad) throw new BadRequestException(`${d.label}: „${bad}“ არასწორია`);
        out[d.key] = [...new Set(pats)];
      }
    }
    return out;
  }
  private conds(text: string): Cond[] {
    const r = parseConds(text, new Map());
    if ('error' in r) throw new BadRequestException(`პირობები: ${r.error.replace('ვერსიაში არ არის', 'საკუთარ წესში სია არ გამოიყენება — მიუთითეთ კოდები')}`);
    if (!r.conds.length) throw new BadRequestException('საკუთარ წესს სჭირდება პირობა');
    const f = r.conds.find((c) => CUSTOM_FORBIDDEN.has(c.f));
    if (f) throw new BadRequestException(`ველი „${f.f}“ საკუთარ წესში არ გამოიყენება`);
    for (const c of r.conds) { const e = validateCond(c, new Map()); if (e) throw new BadRequestException(e); }
    return r.conds;
  }
  private async payerIds(ids: string[] | undefined) {
    if (!ids?.length) return ids;
    const n = (await this.db.selectFrom('payers').select(sql<number>`count(*)::int`.as('n')).where('id', 'in', ids).executeTakeFirstOrThrow()).n;
    if (n !== new Set(ids).size) throw new BadRequestException('გადამხდელი ვერ მოიძებნა');
    return [...new Set(ids)];
  }

  async create(dto: RuleDto, u: AuthUser, ctx: AuditContext) {
    if (!dto.code || !dto.title || !dto.conditions_text) throw new BadRequestException('საკუთარი წესი: კოდი, დასახელება, პირობები');
    if (!dto.code.startsWith('X_')) throw new BadRequestException('საკუთარი წესის კოდი იწყება „X_“-ით (მაგ. X_LONG_PNEU)');
    const conds = this.conds(dto.conditions_text);
    const payer_ids = await this.payerIds(dto.payer_ids);
    try {
      return await this.db.transaction().execute(async (trx) => {
        const r = await trx.insertInto('scrub_rules').values({ code: dto.code!, builtin: false, grp: 'custom', title: dto.title!.trim(), message: dto.message?.trim() || null,
          severity: dto.severity ?? 'warn', is_active: dto.is_active ?? true, applies_kind: 'ipd', payer_kinds: dto.payer_kinds ?? [], payer_ids: payer_ids ?? [],
          conditions: JSON.stringify(conds), allow_override: dto.allow_override ?? true, sort_order: 500, updated_by: u.id }).returningAll().executeTakeFirstOrThrow();
        await this.audit.log(ctx, { action: 'SCRUB_RULE_CREATE', entityName: 'scrub_rules', entityId: r.code, newData: r }, trx);
        return r;
      });
    } catch (e) { mapPgError(e, { scrub_rules_code_key: `კოდი ${dto.code} უკვე არსებობს` }); }
  }

  async update(code: string, dto: RuleDto, u: AuthUser, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const old = await trx.selectFrom('scrub_rules').selectAll().where('code', '=', code).forUpdate().executeTakeFirst();
      if (!old) throw new NotFoundException('წესი ვერ მოიძებნა');
      if (old.builtin && (dto.title !== undefined || dto.conditions_text !== undefined)) throw new BadRequestException('მზა წესის დასახელება / ლოგიკა არ იცვლება (ტექსტი — „message“)');
      if (!old.builtin && dto.params !== undefined) throw new BadRequestException('საკუთარ წესს პარამეტრები არ აქვს');
      const payer_ids = await this.payerIds(dto.payer_ids);
      const r = await trx.updateTable('scrub_rules').set({
        ...(dto.title !== undefined && { title: dto.title.trim() }), ...(dto.message !== undefined && { message: dto.message?.trim() || null }),
        ...(dto.severity !== undefined && { severity: dto.severity }), ...(dto.is_active !== undefined && { is_active: dto.is_active }),
        ...(dto.payer_kinds !== undefined && { payer_kinds: dto.payer_kinds }), ...(payer_ids !== undefined && { payer_ids }),
        ...(dto.params !== undefined && { params: JSON.stringify({ ...(old.params as object), ...this.params(code, dto.params) }) }),
        ...(dto.conditions_text !== undefined && { conditions: JSON.stringify(this.conds(dto.conditions_text)) }),
        ...(dto.allow_override !== undefined && { allow_override: dto.allow_override }), updated_by: u.id, updated_at: sql`now()`,
      }).where('code', '=', code).returningAll().executeTakeFirstOrThrow();
      await this.audit.log(ctx, { action: 'SCRUB_RULE_UPDATE', entityName: 'scrub_rules', entityId: code, oldData: old, newData: r }, trx);
      return r;
    });
  }

  async remove(code: string, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const old = await trx.selectFrom('scrub_rules').selectAll().where('code', '=', code).forUpdate().executeTakeFirst();
      if (!old) throw new NotFoundException('წესი ვერ მოიძებნა');
      if (old.builtin) throw new BadRequestException('მზა წესი არ იშლება — გათიშეთ');
      const used = (await trx.selectFrom('scrub_overrides').select(sql<number>`count(*)::int`.as('n')).where('rule_code', '=', code).executeTakeFirstOrThrow()).n;
      if (used) throw new ConflictException(`წესზე არის გამონაკლისები (${used}) — გათიშეთ წაშლის ნაცვლად`);
      await trx.deleteFrom('scrub_rules').where('code', '=', code).execute();
      await this.audit.log(ctx, { action: 'SCRUB_RULE_DELETE', entityName: 'scrub_rules', entityId: code, oldData: old }, trx);
      return { ok: true };
    });
  }

  // ---------------------------------------------------------------- შემთხვევა
  async forInvoice(invoiceId: string) {
    const s = await scrubSettings(this.db);
    const r = await scrubInvoice(this.db, invoiceId);
    return { enabled: s.enabled, settings: { finalize_check: s.finalize_check, claim_check: s.claim_check }, ...r };
  }
  async forStay(eid: string) {
    const inv = await this.db.selectFrom('invoices').select('id').where('encounter_id', '=', eid).executeTakeFirst();
    if (!inv) throw new NotFoundException('ინვოისი ვერ მოიძებნა');
    return this.forInvoice(inv.id);
  }

  async override(dto: OverrideDto, u: AuthUser, ctx: AuditContext) {
    const rule = await this.db.selectFrom('scrub_rules').select(['code', 'allow_override', 'title']).where('code', '=', dto.rule_code).executeTakeFirst();
    if (!rule) throw new NotFoundException('წესი ვერ მოიძებნა');
    if (!rule.allow_override) throw new ForbiddenException({ code: 'SCRUB_NO_OVERRIDE', message: `„${rule.title}“ — გამონაკლისი დაუშვებელია, საჭიროა გასწორება` });
    const res = await scrubInvoice(this.db, dto.invoice_id);
    const hit = res.issues.find((i) => i.code === dto.rule_code && (dto.payer_id ? i.payer_id === dto.payer_id : true));
    if (!hit) throw new BadRequestException('ეს პრობლემა შემთხვევაზე ახლა არ ფიქსირდება');
    if (hit.overridden) throw new ConflictException('გამონაკლისი უკვე არის');
    try {
      return await this.db.transaction().execute(async (trx) => {
        const r = await trx.insertInto('scrub_overrides').values({ invoice_id: dto.invoice_id, rule_code: dto.rule_code, payer_id: dto.payer_id ?? hit.payer_id ?? null,
          reason: dto.reason.trim(), created_by: u.id }).returningAll().executeTakeFirstOrThrow();
        await this.audit.log(ctx, { action: 'SCRUB_OVERRIDE', entityName: 'scrub_overrides', entityId: r.id, newData: { ...dto, title: rule.title, detail: hit.detail } }, trx);
        return r;
      });
    } catch (e) { mapPgError(e, { ux_scrub_override_active: 'გამონაკლისი უკვე არის' }); }
  }
  async revoke(id: string, dto: ReasonDto, u: AuthUser, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const o = await trx.selectFrom('scrub_overrides').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!o) throw new NotFoundException('გამონაკლისი ვერ მოიძებნა');
      if (o.revoked_at) throw new ConflictException('უკვე გაუქმებულია');
      await trx.updateTable('scrub_overrides').set({ revoked_at: sql`now()`, revoked_by: u.id, revoke_reason: dto.reason.trim() }).where('id', '=', id).execute();
      await this.audit.log(ctx, { action: 'SCRUB_OVERRIDE_REVOKE', entityName: 'scrub_overrides', entityId: id, oldData: o, newData: { reason: dto.reason } }, trx);
      return { ok: true };
    });
  }
}

@Controller('scrub')
export class ScrubController {
  constructor(private readonly s: ScrubService) {}
  @Get('meta') @Roles(...READ) meta() { return this.s.meta(); }
  @Get('rules') @Roles(...READ) rules() { return this.s.rules(); }
  @Post('rules') @Roles(...ADMIN) create(@Body() d: RuleDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.create(d, u, auditCtx(r)); }
  @Patch('rules/:code') @Roles(...ADMIN) update(@Param('code') c: string, @Body() d: RuleDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.update(c.toUpperCase(), d, u, auditCtx(r)); }
  @Delete('rules/:code') @Roles(...ADMIN) remove(@Param('code') c: string, @Req() r: Request) { return this.s.remove(c.toUpperCase(), auditCtx(r)); }
  @Get('invoices/:id') @Roles(...CASE_READ) inv(@Param('id', ParseUUIDPipe) id: string) { return this.s.forInvoice(id); }
  @Get('stays/:eid') @Roles(...CASE_READ) stay(@Param('eid', ParseUUIDPipe) eid: string) { return this.s.forStay(eid); }
  @Post('overrides') @Roles(...OVERRIDE) override(@Body() d: OverrideDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.override(d, u, auditCtx(r)); }
  @Post('overrides/:id/revoke') @HttpCode(200) @Roles(...OVERRIDE)
  revoke(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.revoke(id, d, u, auditCtx(r)); }
}

@Module({ providers: [ScrubService], controllers: [ScrubController] })
export class ScrubModule {}
