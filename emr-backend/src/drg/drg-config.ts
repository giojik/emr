import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query,
  Req, Res } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min } from 'class-validator';
import type { Request, Response } from 'express';
import { sql, type Transaction } from 'kysely';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/roles';
import { mapPgError } from '../common/pg-errors';
import { loadEnv } from '../config/env';
import { InjectDb, type Database } from '../database/database.module';
import type { DB } from '../database/db';
import { buildCsv, num, parseCsv } from './drg-csv';
import { mirrorGroup } from './drg-calc';
import { DRG_ADMIN, DRG_READ, drgRules, listKinds, loadVersion, versionMeta } from './drg-data';
import { type Cond, condsText, FIELDS, group, type GroupInputs, type ListKind, norm, normPattern, OP_KA, parseConds, PATTERN_RE, validateCond, validateVersionSettings,
  VERSION_SETTINGS_DEFAULT, versionSettings } from './drg-engine';

type Trx = Transaction<DB>;
const TZ = loadEnv().CLINIC_TZ;
const nz = (s: string | null | undefined) => (s?.trim() ? s.trim() : null);
const numT = ({ value }: { value: unknown }) => (typeof value === 'string' && value.trim() !== '' ? Number(value.replace(',', '.')) : value === '' ? null : value);
const CODE_RE = /^[A-Z0-9][A-Z0-9_.-]{0,19}$/;
const LIST_RE = /^[A-Z][A-Z0-9_]{1,39}$/;
const KINDS: ListKind[] = ['dx', 'proc', 'service'];
const KIND_KA: Record<string, string> = { dx: 'დიაგნოზი', proc: 'პროცედურა', service: 'მომსახურება' };
const GKIND = ['medical', 'surgical', 'other'] as const;

// ================================================================= DTO
export class SchemeDto {
  @IsOptional() @Matches(/^[A-Z0-9][A-Z0-9_.-]{1,19}$/, { message: 'კოდი: დიდი ლათინური ასოები, ციფრები (2–20)' }) code?: string;
  @IsOptional() @IsString() @Length(2, 200) name?: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string | null;
  @IsOptional() @IsBoolean() is_default?: boolean;
  @IsOptional() @IsBoolean() is_active?: boolean;
}
export class VersionCreateDto {
  @IsString() @Length(2, 200) label: string;
  @IsDateString({ strict: true }) valid_from: string;
  @IsOptional() @IsUUID() copy_from?: string;
  @IsOptional() @IsString() @MaxLength(4000) notes?: string | null;
}
export class VersionUpdateDto {
  @IsOptional() @IsString() @Length(2, 200) label?: string;
  @IsOptional() @IsDateString({ strict: true }) valid_from?: string;
  @IsOptional() @IsObject() settings?: Record<string, unknown>;
  @IsOptional() @IsString() @MaxLength(4000) notes?: string | null;
}
export class ReasonDto { @IsString() @Length(5, 500) reason: string }
export class ActivateDto { @IsOptional() @IsString() @MaxLength(500) note?: string }
export class GroupDto {
  @IsOptional() @IsString() @Length(2, 300) title?: string;
  @IsOptional() @Transform(numT) @IsNumber({ maxDecimalPlaces: 4 }) @Min(0.0001) @Max(9999) weight?: number;
  @IsOptional() @Transform(numT) @IsNumber({ maxDecimalPlaces: 1 }) @Min(0.1) @Max(999) alos?: number | null;
  @IsOptional() @Transform(numT) @IsInt() @Min(0) @Max(9999) los_low?: number | null;
  @IsOptional() @Transform(numT) @IsInt() @Min(1) @Max(9999) los_high?: number | null;
  @IsOptional() @IsString() @MaxLength(10) mdc?: string | null;
  @IsOptional() @IsIn(GKIND) kind?: (typeof GKIND)[number];
  @IsOptional() @IsString() @MaxLength(1000) notes?: string | null;
}
export class ListDto {
  @IsOptional() @IsString() @Length(2, 300) title?: string;
  @IsOptional() @IsIn(KINDS) kind?: ListKind;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string | null;
  /** სრული შემადგენლობა (ჩანაცვლება): „K35“, „K35-K37“, „K35.8“ */
  @IsOptional() @IsArray() @IsString({ each: true }) @MaxLength(60, { each: true }) items?: string[];
}
export class CcDto {
  @IsString() @Length(1, 30) pattern: string;
  @IsIn(['cc', 'mcc']) level: 'cc' | 'mcc';
  @IsOptional() @IsArray() @IsString({ each: true }) excl_pdx?: string[];
  @IsOptional() @IsString() @MaxLength(1000) notes?: string | null;
}
export class RuleDto {
  @IsOptional() @Transform(numT) @IsInt() @Min(1) @Max(1_000_000) seq?: number;
  @IsOptional() @IsString() @Length(1, 20) drg_code?: string;
  @IsOptional() @IsString() @MaxLength(300) label?: string | null;
  @IsOptional() @IsArray() conditions?: Cond[];
  /** ალტერნატივა: ტექსტური ჩანაწერი „pdx in @APPEND & age >= 18“ */
  @IsOptional() @IsString() @MaxLength(20000) conditions_text?: string;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string | null;
}
export class ReorderDto { @IsArray() @IsUUID('all', { each: true }) ids: string[] }
export class CsvImportDto {
  @IsString() @Length(3, 5_000_000) csv: string;
  @IsOptional() @IsBoolean() dry_run?: boolean;
  /** ფაილში არმყოფი ჩანაწერების წაშლა (ვერსიის ეს ცხრილი = ფაილი) */
  @IsOptional() @IsBoolean() replace?: boolean;
}
export class PackageImportDto {
  @IsObject() package: Record<string, unknown>;
  @IsOptional() @IsString() @Length(2, 200) label?: string;
  @IsOptional() @IsDateString({ strict: true }) valid_from?: string;
}
export class DemoDto { @IsOptional() @IsDateString({ strict: true }) valid_from?: string }
export class PayerSchemeDto { @IsOptional() @IsUUID() drg_scheme_id?: string | null }
export class TestDto {
  @IsOptional() @IsString() @MaxLength(20) pdx?: string | null;
  @IsOptional() @IsArray() @IsString({ each: true }) sdx?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) procs?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) services?: string[];
  @IsOptional() @IsBoolean() surgery?: boolean;
  @IsOptional() @Transform(numT) @IsNumber() @Min(0) @Max(130) age?: number | null;
  @IsOptional() @Transform(numT) @IsNumber() @Min(0) @Max(50000) age_days?: number | null;
  @IsOptional() @IsIn(['M', 'F']) sex?: 'M' | 'F' | null;
  @IsOptional() @Transform(numT) @IsNumber() @Min(0) @Max(3650) los?: number;
  @IsOptional() @Transform(numT) @IsNumber() @Min(0) @Max(87600) icu_hours?: number;
  @IsOptional() @Transform(numT) @IsNumber() @Min(0) @Max(87600) vent_hours?: number;
  @IsOptional() @IsString() discharge?: string | null;
  @IsOptional() @IsString() source?: string | null;
}

interface Pkg {
  format: string; format_version: number; label?: string; valid_from?: string; settings?: Record<string, unknown>; notes?: string | null;
  groups: { code: string; title: string; weight: number | string; alos?: number | string | null; los_low?: number | null; los_high?: number | null; mdc?: string | null; kind?: string; notes?: string | null }[];
  lists: { code: string; title: string; kind: string; notes?: string | null; items: (string | { pattern: string; title?: string | null })[] }[];
  cc: { pattern: string; level: string; excl_pdx?: string[]; notes?: string | null }[];
  rules: { seq: number; drg_code: string; label?: string | null; conditions?: Cond[]; conditions_text?: string; is_active?: boolean; notes?: string | null }[];
}

// ================================================================= სერვისი
/**
 * DRG კონფიგურაცია (0055): სქემები, ვერსიები (draft → active → retired), ჯგუფები, კოდების სიები, CC/MCC, წესები;
 * CSV იმპორტი / ექსპორტი თითო ცხრილზე, ვერსიის პაკეტი (JSON), სადემონსტრაციო კონფიგურაცია, ტესტ-შემთხვევა.
 * შემადგენლობა იცვლება მხოლოდ მონახაზში (DB trigger + აქ — გასაგები შეტყობინება).
 */
@Injectable()
export class DrgConfigService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService) {}

  meta() {
    return { fields: FIELDS, ops: OP_KA, list_kinds: KIND_KA, version_settings_default: VERSION_SETTINGS_DEFAULT,
      examples: ['pdx in @APPENDICITIS', 'proc any @APPENDECTOMY & cc >= cc', 'age between 0..17', 'sex = F', 'los >= 3', 'discharge in death', 'surgery is no', 'vent_hours >= 96'] };
  }

  // ---------------------------------------------------------------- სქემები
  async schemes() {
    const rows = await this.db.selectFrom('drg_schemes as s').selectAll('s')
      .select([sql<string | null>`drg_version_at(s.id, (now() AT TIME ZONE ${TZ})::date)`.as('current_version_id'),
        sql<number>`(SELECT count(*)::int FROM drg_versions v WHERE v.scheme_id = s.id)`.as('versions'),
        sql<number>`(SELECT count(*)::int FROM drg_versions v WHERE v.scheme_id = s.id AND v.status = 'draft')`.as('drafts'),
        sql<number>`(SELECT count(*)::int FROM payers p WHERE p.drg_scheme_id = s.id OR (p.drg_scheme_id IS NULL AND s.is_default))`.as('payers')])
      .orderBy('s.is_default', 'desc').orderBy('s.code').execute();
    const cur = rows.map((r) => r.current_version_id).filter((x): x is string => !!x);
    const vs = cur.length ? await this.db.selectFrom('drg_versions').select(['id', 'label', 'version_no', sql<string>`to_char(valid_from, 'YYYY-MM-DD')`.as('valid_from')]).where('id', 'in', cur).execute() : [];
    return rows.map((r) => ({ ...r, current_version: vs.find((v) => v.id === r.current_version_id) ?? null }));
  }
  async saveScheme(id: string | null, dto: SchemeDto, ctx: AuditContext) {
    try {
      return await this.db.transaction().execute(async (trx) => {
        const old = id ? await trx.selectFrom('drg_schemes').selectAll().where('id', '=', id).forUpdate().executeTakeFirst() : null;
        if (id && !old) throw new NotFoundException('სქემა ვერ მოიძებნა');
        if (!old && (!dto.code || !dto.name)) throw new BadRequestException('სქემა: კოდი და დასახელება');
        if (old?.is_default && (dto.is_default === false || dto.is_active === false)) throw new BadRequestException('ნაგულისხმევი სქემა არ ითიშება — ჯერ სხვა მონიშნეთ ნაგულისხმევად');
        if (dto.is_default) await trx.updateTable('drg_schemes').set({ is_default: false }).where('is_default', '=', true).execute();
        const v = { ...(dto.name !== undefined && { name: dto.name.trim() }), ...(dto.notes !== undefined && { notes: nz(dto.notes) }),
          ...(dto.is_default !== undefined && { is_default: dto.is_default }), ...(dto.is_active !== undefined && { is_active: dto.is_active }) };
        const r = old ? await trx.updateTable('drg_schemes').set(v).where('id', '=', old.id).returningAll().executeTakeFirstOrThrow()
          : await trx.insertInto('drg_schemes').values({ code: dto.code!, name: dto.name!.trim(), notes: nz(dto.notes), is_default: dto.is_default ?? false }).returningAll().executeTakeFirstOrThrow();
        await this.audit.log(ctx, { action: old ? 'DRG_SCHEME_UPDATE' : 'DRG_SCHEME_CREATE', entityName: 'drg_schemes', entityId: r.id, oldData: old ?? undefined, newData: r }, trx);
        return r;
      });
    } catch (e) { mapPgError(e, { drg_schemes_code_key: 'ამ კოდით სქემა უკვე არსებობს', chk_drg_scheme_default: 'ნაგულისხმევი სქემა აქტიური უნდა იყოს' }); }
  }
  /** გადამხდელები და მათი სქემა (NULL — ნაგულისხმევი) */
  payers() {
    return this.db.selectFrom('payers as p').leftJoin('drg_schemes as s', 's.id', 'p.drg_scheme_id')
      .select(['p.id', 'p.code', 'p.name', 'p.kind', 'p.default_mode', 'p.is_active', 'p.drg_scheme_id', 's.code as scheme_code', 's.name as scheme_name'])
      .orderBy('p.is_active', 'desc').orderBy('p.name').execute();
  }
  async setPayerScheme(payerId: string, dto: PayerSchemeDto, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const p = await trx.selectFrom('payers').select(['id', 'drg_scheme_id']).where('id', '=', payerId).forUpdate().executeTakeFirst();
      if (!p) throw new NotFoundException('გადამხდელი ვერ მოიძებნა');
      if (dto.drg_scheme_id) {
        const s = await trx.selectFrom('drg_schemes').select('is_active').where('id', '=', dto.drg_scheme_id).executeTakeFirst();
        if (!s?.is_active) throw new BadRequestException('სქემა ვერ მოიძებნა ან გათიშულია');
      }
      await trx.updateTable('payers').set({ drg_scheme_id: dto.drg_scheme_id ?? null }).where('id', '=', payerId).execute();
      await this.audit.log(ctx, { action: 'DRG_PAYER_SCHEME', entityName: 'payers', entityId: payerId, oldData: { drg_scheme_id: p.drg_scheme_id }, newData: { drg_scheme_id: dto.drg_scheme_id ?? null } }, trx);
      return { ok: true };
    });
  }

  // ---------------------------------------------------------------- ვერსიები
  private counts = () => [
    sql<number>`(SELECT count(*)::int FROM drg_version_groups g WHERE g.version_id = v.id)`.as('n_groups'),
    sql<number>`(SELECT count(*)::int FROM drg_code_lists l WHERE l.version_id = v.id)`.as('n_lists'),
    sql<number>`(SELECT count(*)::int FROM drg_cc c WHERE c.version_id = v.id)`.as('n_cc'),
    sql<number>`(SELECT count(*)::int FROM drg_rules r WHERE r.version_id = v.id)`.as('n_rules'),
    sql<number>`(SELECT count(*)::int FROM stay_drg d WHERE d.version_id = v.id)`.as('n_stays'),
  ] as const;
  async versions(schemeId: string) {
    const cur = (await sql<{ id: string | null }>`SELECT drg_version_at(${schemeId}::uuid, (now() AT TIME ZONE ${TZ})::date) AS id`.execute(this.db)).rows[0]?.id;
    const rows = await this.db.selectFrom('drg_versions as v').leftJoin('users as c', 'c.id', 'v.created_by').leftJoin('users as a', 'a.id', 'v.activated_by')
      .select(['v.id', 'v.version_no', 'v.label', sql<string>`to_char(v.valid_from, 'YYYY-MM-DD')`.as('valid_from'), 'v.status', 'v.created_at', 'v.updated_at', 'v.activated_at', 'v.retired_at',
        'v.retire_reason', 'v.notes', sql<string>`c.first_name || ' ' || c.last_name`.as('created_by_name'), sql<string | null>`a.first_name || ' ' || a.last_name`.as('activated_by_name'),
        ...this.counts()])
      .where('v.scheme_id', '=', schemeId).orderBy('v.version_no', 'desc').execute();
    return rows.map((r) => ({ ...r, current: r.id === cur }));
  }
  async version(id: string) {
    const v = await this.db.selectFrom('drg_versions as v').innerJoin('drg_schemes as s', 's.id', 'v.scheme_id').leftJoin('users as c', 'c.id', 'v.created_by')
      .leftJoin('users as e', 'e.id', 'v.updated_by').leftJoin('users as a', 'a.id', 'v.activated_by').leftJoin('drg_versions as src', 'src.id', 'v.source_version_id')
      .select(['v.id', 'v.scheme_id', 's.code as scheme_code', 's.name as scheme_name', 'v.version_no', 'v.label', sql<string>`to_char(v.valid_from, 'YYYY-MM-DD')`.as('valid_from'), 'v.status',
        'v.settings', 'v.notes', 'v.created_at', 'v.updated_at', 'v.activated_at', 'v.retired_at', 'v.retire_reason', 'v.created_by', 'v.updated_by', 'src.label as source_label',
        sql<string>`c.first_name || ' ' || c.last_name`.as('created_by_name'), sql<string | null>`e.first_name || ' ' || e.last_name`.as('updated_by_name'),
        sql<string | null>`a.first_name || ' ' || a.last_name`.as('activated_by_name'), ...this.counts()])
      .where('v.id', '=', id).executeTakeFirst();
    if (!v) throw new NotFoundException('ვერსია ვერ მოიძებნა');
    const rules = await drgRules(this.db);
    return { ...v, settings: versionSettings(v.settings), version_approval: rules.version_approval };
  }
  private async draft(trx: Trx | Database, id: string) {
    const v = await trx.selectFrom('drg_versions').select(['id', 'status', 'scheme_id', 'label']).where('id', '=', id).executeTakeFirst();
    if (!v) throw new NotFoundException('ვერსია ვერ მოიძებნა');
    if (v.status !== 'draft') throw new ConflictException({ code: 'DRG_VERSION_LOCKED', message: `ვერსია „${v.label}“ აქტიური / გაუქმებულია — ცვლილება მხოლოდ ახალ ვერსიაში (ასლი)` });
    return v;
  }
  private touch(trx: Trx, id: string, u: AuthUser) {
    return trx.updateTable('drg_versions').set({ updated_by: u.id, updated_at: sql`now()` }).where('id', '=', id).execute();
  }

  async createVersion(schemeId: string, dto: VersionCreateDto, u: AuthUser, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const s = await trx.selectFrom('drg_schemes').select(['id', 'is_active']).where('id', '=', schemeId).forUpdate().executeTakeFirst();
      if (!s?.is_active) throw new BadRequestException('სქემა ვერ მოიძებნა ან გათიშულია');
      let settings: unknown = VERSION_SETTINGS_DEFAULT;
      if (dto.copy_from) {
        const src = await trx.selectFrom('drg_versions').select(['scheme_id', 'settings']).where('id', '=', dto.copy_from).executeTakeFirst();
        if (!src || src.scheme_id !== schemeId) throw new BadRequestException('ასლის წყარო ამ სქემის ვერსია უნდა იყოს');
        settings = versionSettings(src.settings);
      }
      const no = (await trx.selectFrom('drg_versions').select(sql<number>`coalesce(max(version_no), 0)::int`.as('m')).where('scheme_id', '=', schemeId).executeTakeFirstOrThrow()).m + 1;
      const v = await trx.insertInto('drg_versions').values({ scheme_id: schemeId, version_no: no, label: dto.label.trim(), valid_from: dto.valid_from, settings: JSON.stringify(settings),
        notes: nz(dto.notes), source_version_id: dto.copy_from ?? null, created_by: u.id, updated_by: u.id }).returningAll().executeTakeFirstOrThrow();
      if (dto.copy_from) await this.copyContent(trx, dto.copy_from, v.id);
      await this.audit.log(ctx, { action: 'DRG_VERSION_CREATE', entityName: 'drg_versions', entityId: v.id, newData: { ...dto, version_no: no } }, trx);
      return { id: v.id, version_no: no };
    });
  }
  private async copyContent(trx: Trx, from: string, to: string) {
    await sql`INSERT INTO drg_version_groups (version_id, code, title, weight, alos, los_low, los_high, mdc, kind, notes)
      SELECT ${to}::uuid, code, title, weight, alos, los_low, los_high, mdc, kind, notes FROM drg_version_groups WHERE version_id = ${from}::uuid`.execute(trx);
    await sql`INSERT INTO drg_code_lists (version_id, code, title, kind, notes) SELECT ${to}::uuid, code, title, kind, notes FROM drg_code_lists WHERE version_id = ${from}::uuid`.execute(trx);
    await sql`INSERT INTO drg_code_list_items (version_id, list_code, pattern, title) SELECT ${to}::uuid, list_code, pattern, title FROM drg_code_list_items WHERE version_id = ${from}::uuid`.execute(trx);
    await sql`INSERT INTO drg_cc (version_id, pattern, level, excl_pdx, notes) SELECT ${to}::uuid, pattern, level, excl_pdx, notes FROM drg_cc WHERE version_id = ${from}::uuid`.execute(trx);
    await sql`INSERT INTO drg_rules (version_id, seq, drg_code, label, conditions, is_active, notes)
      SELECT ${to}::uuid, seq, drg_code, label, conditions, is_active, notes FROM drg_rules WHERE version_id = ${from}::uuid`.execute(trx);
  }
  async updateVersion(id: string, dto: VersionUpdateDto, u: AuthUser, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      await this.draft(trx, id);
      const old = await trx.selectFrom('drg_versions').selectAll().where('id', '=', id).forUpdate().executeTakeFirstOrThrow();
      let settings: Record<string, unknown> | undefined;
      if (dto.settings) {
        const err = validateVersionSettings(dto.settings);
        if (err) throw new BadRequestException(`ვერსიის პარამეტრები: ${err}`);
        settings = { ...versionSettings(old.settings), ...dto.settings };
        if (settings.fallback_code) {
          const g = await trx.selectFrom('drg_version_groups').select('code').where('version_id', '=', id).where('code', '=', settings.fallback_code as string).executeTakeFirst();
          if (!g) throw new BadRequestException(`ნაგულისხმევი ჯგუფი ${String(settings.fallback_code)} ვერსიაში არ არის`);
        }
      }
      const r = await trx.updateTable('drg_versions').set({
        ...(dto.label !== undefined && { label: dto.label.trim() }), ...(dto.valid_from !== undefined && { valid_from: dto.valid_from }),
        ...(settings && { settings: JSON.stringify(settings) }), ...(dto.notes !== undefined && { notes: nz(dto.notes) }), updated_by: u.id, updated_at: sql`now()`,
      }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await this.audit.log(ctx, { action: 'DRG_VERSION_UPDATE', entityName: 'drg_versions', entityId: id, oldData: { label: old.label, valid_from: old.valid_from, settings: old.settings },
        newData: dto }, trx);
      return { id: r.id };
    });
  }
  async deleteVersion(id: string, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const v = await this.draft(trx, id);
      await trx.deleteFrom('drg_versions').where('id', '=', id).execute();
      await this.audit.log(ctx, { action: 'DRG_VERSION_DELETE', entityName: 'drg_versions', entityId: id, oldData: v }, trx);
      return { ok: true };
    });
  }

  /** ვერსიის შემოწმება: errors — გააქტიურებას ბლოკავს; warnings — ინფორმაცია */
  async check(id: string) {
    const meta = await versionMeta(this.db, id);
    if (!meta) throw new NotFoundException('ვერსია ვერ მოიძებნა');
    const v = await loadVersion(this.db, id);
    const errors: string[] = []; const warnings: string[] = [];
    if (!v.groups.size) errors.push('ჯგუფები არ არის');
    const active = v.rules.filter((r) => r.is_active);
    if (!active.length) errors.push('აქტიური წესი არ არის');
    if (v.settings.fallback_code && !v.groups.has(v.settings.fallback_code)) errors.push(`ნაგულისხმევი ჯგუფი ${v.settings.fallback_code} ვერსიაში არ არის`);
    const kinds = new Map([...v.lists].map(([k, l]) => [k, l.kind]));
    const used = new Set<string>();
    for (const r of v.rules) {
      for (const c of r.conditions) {
        const err = validateCond(JSON.parse(JSON.stringify(c)) as Cond, kinds);
        if (err) errors.push(`წესი ${r.seq}: ${err}`);
        if (Array.isArray(c.v)) for (const x of c.v as unknown[]) if (typeof x === 'string' && x.startsWith('@')) used.add(x.slice(1));
      }
    }
    for (const c of v.cc) for (const x of c.excl_pdx) if (x.startsWith('@')) { used.add(x.slice(1)); if (!kinds.has(x.slice(1))) errors.push(`CC ${c.pattern}: სია ${x} ვერსიაში არ არის`); }
    for (const [k, l] of v.lists) {
      if (!l.patterns.length) (used.has(k) ? errors : warnings).push(`სია @${k} ცარიელია`);
      else if (!used.has(k)) warnings.push(`სია @${k} არცერთ წესში / CC-ში არ გამოიყენება`);
    }
    const seqs = active.map((r) => r.seq);
    const dup = [...new Set(seqs.filter((s, i) => seqs.indexOf(s) !== i))];
    if (dup.length) warnings.push(`ერთნაირი რიგითი ნომერი (seq): ${dup.slice(0, 10).join(', ')} — რიგი გაურკვეველია`);
    const sorted = [...active].sort((a, b) => a.seq - b.seq);
    const catchAll = sorted.findIndex((r) => r.conditions.length === 0);
    if (catchAll >= 0 && catchAll < sorted.length - 1) warnings.push(`წესი ${sorted[catchAll].seq} პირობების გარეშეა — მის შემდეგ ${sorted.length - catchAll - 1} წესი არასოდეს შესრულდება`);
    const ruled = new Set(active.map((r) => r.drg_code));
    if (v.settings.fallback_code) ruled.add(v.settings.fallback_code);
    const orphan = [...v.groups.keys()].filter((g) => !ruled.has(g));
    if (orphan.length) warnings.push(`ჯგუფები წესის გარეშე (მხოლოდ ხელით არჩევით): ${orphan.length} — ${orphan.slice(0, 15).join(', ')}${orphan.length > 15 ? ' …' : ''}`);
    if (!v.cc.length) warnings.push('CC / MCC სია ცარიელია — სიმძიმე ყოველთვის „არა“');
    return { version: meta, errors, warnings, ok: errors.length === 0 };
  }

  async activate(id: string, u: AuthUser, ctx: AuditContext) {
    const rules = await drgRules(this.db);
    const chk = await this.check(id);
    if (!chk.ok) throw new BadRequestException({ code: 'DRG_VERSION_INVALID', message: `ვერსია ვერ გააქტიურდება: ${chk.errors.slice(0, 5).join('; ')}`, errors: chk.errors });
    try {
      return await this.db.transaction().execute(async (trx) => {
        await this.draft(trx, id);
        const v = await trx.selectFrom('drg_versions').selectAll().where('id', '=', id).forUpdate().executeTakeFirstOrThrow();
        if (rules.version_approval === 'required' && (v.updated_by ?? v.created_by) === u.id) {
          throw new ForbiddenException({ code: 'DRG_APPROVAL_REQUIRED', message: 'გააქტიურება — მეორე პირი (ვერსიის ბოლო რედაქტორი ვერ გაააქტიურებს; version_approval = required)' });
        }
        await trx.updateTable('drg_versions').set({ status: 'active', activated_by: u.id, activated_at: sql`now()` }).where('id', '=', id).execute();
        const groups = await trx.selectFrom('drg_version_groups').select(['code', 'title', 'weight']).where('version_id', '=', id).execute();
        for (const g of groups) await mirrorGroup(trx, g);
        await this.audit.log(ctx, { action: 'DRG_VERSION_ACTIVATE', entityName: 'drg_versions', entityId: id, newData: { label: v.label, valid_from: v.valid_from, warnings: chk.warnings } }, trx);
        return { ok: true, warnings: chk.warnings };
      });
    } catch (e) { mapPgError(e, { ux_drg_version_active_from: 'ამ სქემაში ამ თარიღიდან უკვე მოქმედებს აქტიური ვერსია — შეცვალეთ თარიღი ან გააუქმეთ ძველი' }); }
  }
  async retire(id: string, dto: ReasonDto, u: AuthUser, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const v = await trx.selectFrom('drg_versions').select(['id', 'status', 'label']).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!v) throw new NotFoundException('ვერსია ვერ მოიძებნა');
      if (v.status !== 'active') throw new ConflictException('გაუქმდება მხოლოდ აქტიური ვერსია');
      await trx.updateTable('drg_versions').set({ status: 'retired', retired_by: u.id, retired_at: sql`now()`, retire_reason: dto.reason.trim() }).where('id', '=', id).execute();
      await this.audit.log(ctx, { action: 'DRG_VERSION_RETIRE', entityName: 'drg_versions', entityId: id, newData: { label: v.label, reason: dto.reason } }, trx);
      return { ok: true };
    });
  }

  // ---------------------------------------------------------------- ჯგუფები
  async groups(id: string, q?: string, limit = 500) {
    let x = this.db.selectFrom('drg_version_groups as g').selectAll('g')
      .select(sql<number>`(SELECT count(*)::int FROM drg_rules r WHERE r.version_id = g.version_id AND r.drg_code = g.code)`.as('n_rules'))
      .where('g.version_id', '=', id).orderBy('g.code').limit(Math.min(limit, 5000));
    if (q?.trim()) x = x.where((eb) => eb.or([eb('g.code', 'ilike', `%${q.trim()}%`), eb('g.title', 'ilike', `%${q.trim()}%`)]));
    const total = (await this.db.selectFrom('drg_version_groups').select(sql<number>`count(*)::int`.as('n')).where('version_id', '=', id).executeTakeFirstOrThrow()).n;
    return { total, rows: await x.execute() };
  }
  private groupValues(dto: GroupDto) {
    return {
      ...(dto.title !== undefined && { title: dto.title.trim() }), ...(dto.weight !== undefined && { weight: String(dto.weight) }),
      ...(dto.alos !== undefined && { alos: dto.alos === null ? null : String(dto.alos) }), ...(dto.los_low !== undefined && { los_low: dto.los_low }),
      ...(dto.los_high !== undefined && { los_high: dto.los_high }), ...(dto.mdc !== undefined && { mdc: nz(dto.mdc) }), ...(dto.kind !== undefined && { kind: dto.kind }),
      ...(dto.notes !== undefined && { notes: nz(dto.notes) }),
    };
  }
  async saveGroup(id: string, code: string, dto: GroupDto, u: AuthUser, ctx: AuditContext) {
    const c = code.toUpperCase();
    if (!CODE_RE.test(c)) throw new BadRequestException('DRG კოდი: დიდი ლათინური ასოები, ციფრები, _ . - (მაქს. 20)');
    try {
      return await this.db.transaction().execute(async (trx) => {
        await this.draft(trx, id);
        const old = await trx.selectFrom('drg_version_groups').selectAll().where('version_id', '=', id).where('code', '=', c).executeTakeFirst();
        if (!old && (!dto.title || dto.weight === undefined)) throw new BadRequestException('ახალ ჯგუფს სჭირდება დასახელება და წონა');
        const gv = this.groupValues(dto);
        if (old && !Object.keys(gv).length) return old;
        const r = old ? await trx.updateTable('drg_version_groups').set(gv).where('version_id', '=', id).where('code', '=', c).returningAll().executeTakeFirstOrThrow()
          : await trx.insertInto('drg_version_groups').values({ version_id: id, code: c, title: dto.title!.trim(), weight: String(dto.weight), ...this.groupValues(dto) } as never)
            .returningAll().executeTakeFirstOrThrow();
        await this.touch(trx, id, u);
        await this.audit.log(ctx, { action: old ? 'DRG_GROUP_UPDATE' : 'DRG_GROUP_CREATE', entityName: 'drg_version_groups', entityId: `${id}:${c}`, oldData: old ?? undefined, newData: r }, trx);
        return r;
      });
    } catch (e) { mapPgError(e, { chk_drg_g_trim: 'ქვედა ზღვარი ზედაზე მეტი ვერ იქნება' }); }
  }
  async deleteGroup(id: string, code: string, u: AuthUser, ctx: AuditContext) {
    try {
      return await this.db.transaction().execute(async (trx) => {
        await this.draft(trx, id);
        const r = await trx.deleteFrom('drg_version_groups').where('version_id', '=', id).where('code', '=', code.toUpperCase()).returningAll().executeTakeFirst();
        if (!r) throw new NotFoundException('ჯგუფი ვერ მოიძებნა');
        await this.touch(trx, id, u);
        await this.audit.log(ctx, { action: 'DRG_GROUP_DELETE', entityName: 'drg_version_groups', entityId: `${id}:${r.code}`, oldData: r }, trx);
        return { ok: true };
      });
    } catch (e) { mapPgError(e, { drg_rules_version_id_drg_code_fkey: 'ჯგუფს წესები მიუთითებს — ჯერ წაშალეთ / შეცვალეთ წესები' }); }
  }
  /** CSV: code;title;weight[;alos[;los_low[;los_high[;mdc[;kind]]]]] */
  async importGroups(id: string, dto: CsvImportDto, u: AuthUser, ctx: AuditContext) {
    await this.draft(this.db, id);
    const rows: NonNullable<ReturnType<DrgConfigService['groupRow']>>[] = [];
    const errors: string[] = [];
    parseCsv(dto.csv).forEach((c, i) => {
      const w = num(c[2]);
      if (i === 0 && (w === null || !Number.isFinite(w))) return;   // სათაური
      const r = this.groupRow({ code: c[0], title: c[1], weight: c[2], alos: c[3], los_low: c[4], los_high: c[5], mdc: c[6], kind: c[7] }, `სტრ. ${i + 1}`, errors);
      if (r) rows.push(r);
    });
    const dup = rows.map((r) => r.code).filter((c, i, a) => a.indexOf(c) !== i);
    if (dup.length) errors.push(`გამეორებული კოდები: ${[...new Set(dup)].slice(0, 10).join(', ')}`);
    if (!rows.length && !errors.length) errors.push('ფაილში ჩანაწერი ვერ მოიძებნა');
    const existing = new Map((await this.db.selectFrom('drg_version_groups').selectAll().where('version_id', '=', id).execute()).map((g) => [g.code, g]));
    const codes = new Set(rows.map((r) => r.code));
    const removed = dto.replace ? [...existing.keys()].filter((c) => !codes.has(c)) : [];
    const summary = { rows: rows.length, added: rows.filter((r) => !existing.has(r.code)).length, updated: rows.filter((r) => existing.has(r.code)).length, removed: removed.length, errors: errors.slice(0, 50) };
    if (errors.length || dto.dry_run) return { ...summary, applied: false };
    try {
      await this.db.transaction().execute(async (trx) => {
        for (const r of rows) {
          const v = { title: r.title, weight: String(r.weight), alos: r.alos === null ? null : String(r.alos), los_low: r.los_low, los_high: r.los_high, mdc: r.mdc, kind: r.kind };
          await trx.insertInto('drg_version_groups').values({ version_id: id, code: r.code, ...v }).onConflict((oc) => oc.columns(['version_id', 'code']).doUpdateSet(v)).execute();
        }
        if (removed.length) await trx.deleteFrom('drg_version_groups').where('version_id', '=', id).where('code', 'in', removed).execute();
        await this.touch(trx, id, u);
        await this.audit.log(ctx, { action: 'DRG_GROUPS_IMPORT', entityName: 'drg_version_groups', entityId: id, newData: summary }, trx);
      });
    } catch (e) { mapPgError(e, { drg_rules_version_id_drg_code_fkey: 'ფაილში არმყოფ ჯგუფს წესები მიუთითებს — replace ვერ შესრულდება', chk_drg_g_trim: 'ქვედა ზღვარი ზედაზე მეტია' }); }
    return { ...summary, applied: true };
  }
  private groupRow(g: Record<string, unknown>, at: string, errors: string[]) {
    const code = String(g.code ?? '').trim().toUpperCase();
    const s = (x: unknown) => (x === undefined || x === null ? undefined : String(x));
    const w = num(s(g.weight)); const alos = num(s(g.alos)); const lo = num(s(g.los_low)); const hi = num(s(g.los_high));
    const kind = String(g.kind ?? '').trim().toLowerCase() || 'medical';
    if (!CODE_RE.test(code)) { errors.push(`${at}: კოდი „${String(g.code ?? '')}“ არასწორია`); return null; }
    if (String(g.title ?? '').trim().length < 2) { errors.push(`${at}: დასახელება აკლია`); return null; }
    if (w === null || !Number.isFinite(w) || w <= 0 || w > 9999) { errors.push(`${at}: წონა „${String(g.weight ?? '')}“ არასწორია`); return null; }
    if (alos !== null && (!Number.isFinite(alos) || alos <= 0)) { errors.push(`${at}: საშუალო ხანგრძლივობა არასწორია`); return null; }
    if ((lo !== null && (!Number.isInteger(lo) || lo < 0)) || (hi !== null && (!Number.isInteger(hi) || hi < 1)) || (lo !== null && hi !== null && lo > hi)) { errors.push(`${at}: დღეების ზღვრები არასწორია`); return null; }
    if (!(GKIND as readonly string[]).includes(kind)) { errors.push(`${at}: ტიპი — medical / surgical / other`); return null; }
    return { code, title: String(g.title).trim().slice(0, 300), weight: Math.round(w * 10000) / 10000, alos: alos === null ? null : Math.round(alos * 10) / 10, los_low: lo, los_high: hi,
      mdc: String(g.mdc ?? '').trim().slice(0, 10) || null, kind };
  }

  // ---------------------------------------------------------------- სიები
  async lists(id: string) {
    const v = await loadVersion(this.db, id);
    const used = new Map<string, number>();
    for (const r of v.rules) for (const c of r.conditions) if (Array.isArray(c.v)) for (const x of c.v as unknown[]) if (typeof x === 'string' && x.startsWith('@')) used.set(x.slice(1), (used.get(x.slice(1)) ?? 0) + 1);
    for (const c of v.cc) for (const x of c.excl_pdx) if (x.startsWith('@')) used.set(x.slice(1), (used.get(x.slice(1)) ?? 0) + 1);
    const rows = await this.db.selectFrom('drg_code_lists').selectAll().where('version_id', '=', id).orderBy('code').execute();
    return rows.map((l) => ({ ...l, n_items: v.lists.get(l.code)?.patterns.length ?? 0, n_used: used.get(l.code) ?? 0 }));
  }
  async list(id: string, code: string) {
    const l = await this.db.selectFrom('drg_code_lists').selectAll().where('version_id', '=', id).where('code', '=', code.toUpperCase()).executeTakeFirst();
    if (!l) throw new NotFoundException('სია ვერ მოიძებნა');
    const items = await this.db.selectFrom('drg_code_list_items').select(['pattern', 'title']).where('version_id', '=', id).where('list_code', '=', l.code).orderBy('pattern').execute();
    // დიაგნოზის სიაში — ICD-10 დასახელება, როცა ჩანაწერს საკუთარი არ აქვს
    if (l.kind === 'dx' && items.some((i) => !i.title)) {
      const icd = await this.db.selectFrom('icd10_codes').select(['code', 'title']).where(sql<boolean>`replace(code, '.', '') = ANY(${items.map((i) => i.pattern)}::text[])`).execute();
      const m = new Map(icd.map((x) => [norm(x.code), x.title]));
      for (const i of items) if (!i.title) i.title = m.get(i.pattern) ?? null;
    }
    return { ...l, items };
  }
  private patterns(items: string[], at: string) {
    const out: string[] = [];
    for (const raw of items) {
      const p = normPattern(raw);
      if (!p) continue;
      if (!PATTERN_RE.test(p)) throw new BadRequestException(`${at}: კოდი „${raw}“ არასწორია (დასაწყისი „K35“ ან დიაპაზონი „K35-K37“)`);
      out.push(p);
    }
    return [...new Set(out)];
  }
  async saveList(id: string, code: string, dto: ListDto, u: AuthUser, ctx: AuditContext) {
    const c = code.toUpperCase();
    if (!LIST_RE.test(c)) throw new BadRequestException('სიის კოდი: ლათინური დიდი ასოები, ციფრები, _ (იწყება ასოთი, 2–40)');
    const pats = dto.items ? this.patterns(dto.items, 'სია') : undefined;
    try {
      return await this.db.transaction().execute(async (trx) => {
        await this.draft(trx, id);
        const old = await trx.selectFrom('drg_code_lists').selectAll().where('version_id', '=', id).where('code', '=', c).executeTakeFirst();
        if (!old && (!dto.title || !dto.kind)) throw new BadRequestException('ახალ სიას სჭირდება დასახელება და სახეობა');
        if (old && dto.kind && dto.kind !== old.kind) {
          const usedBy = (await this.lists(id)).find((l) => l.code === c)?.n_used ?? 0;
          if (usedBy) throw new ConflictException(`სიას იყენებს ${usedBy} პირობა — სახეობა ვერ შეიცვლება`);
        }
        const upd = { ...(dto.title !== undefined && { title: dto.title.trim() }), ...(dto.kind !== undefined && { kind: dto.kind }), ...(dto.notes !== undefined && { notes: nz(dto.notes) }) };
        if (old) { if (Object.keys(upd).length) await trx.updateTable('drg_code_lists').set(upd).where('version_id', '=', id).where('code', '=', c).execute(); }
        else await trx.insertInto('drg_code_lists').values({ version_id: id, code: c, title: dto.title!.trim(), kind: dto.kind!, notes: nz(dto.notes) }).execute();
        if (pats) {
          await trx.deleteFrom('drg_code_list_items').where('version_id', '=', id).where('list_code', '=', c).execute();
          if (pats.length) await trx.insertInto('drg_code_list_items').values(pats.map((p) => ({ version_id: id, list_code: c, pattern: p }))).execute();
        }
        await this.touch(trx, id, u);
        await this.audit.log(ctx, { action: old ? 'DRG_LIST_UPDATE' : 'DRG_LIST_CREATE', entityName: 'drg_code_lists', entityId: `${id}:${c}`, oldData: old ?? undefined,
          newData: { ...dto, items: pats?.length } }, trx);
        return { code: c, items: pats?.length ?? null };
      });
    } catch (e) { mapPgError(e); }
  }
  async deleteList(id: string, code: string, u: AuthUser, ctx: AuditContext) {
    const c = code.toUpperCase();
    const usedBy = (await this.lists(id)).find((l) => l.code === c)?.n_used ?? 0;
    if (usedBy) throw new ConflictException(`სიას იყენებს ${usedBy} პირობა (წესი / CC) — ჯერ შეცვალეთ ისინი`);
    return this.db.transaction().execute(async (trx) => {
      await this.draft(trx, id);
      const r = await trx.deleteFrom('drg_code_lists').where('version_id', '=', id).where('code', '=', c).returningAll().executeTakeFirst();
      if (!r) throw new NotFoundException('სია ვერ მოიძებნა');
      await this.touch(trx, id, u);
      await this.audit.log(ctx, { action: 'DRG_LIST_DELETE', entityName: 'drg_code_lists', entityId: `${id}:${c}`, oldData: r }, trx);
      return { ok: true };
    });
  }
  /** CSV: list;kind;pattern[;title] — ახალი სია იქმნება (დასახელება = კოდი); replace → ფაილში მოხსენიებული სიების შემადგენლობა = ფაილი */
  async importLists(id: string, dto: CsvImportDto, u: AuthUser, ctx: AuditContext) {
    await this.draft(this.db, id);
    const errors: string[] = [];
    const byList = new Map<string, { kind: string; items: Map<string, string | null> }>();
    parseCsv(dto.csv).forEach((c, i) => {
      const list = (c[0] ?? '').toUpperCase(); const kind = (c[1] ?? '').toLowerCase(); const p = normPattern(c[2] ?? '');
      if (i === 0 && !KINDS.includes(kind as ListKind)) return;   // სათაური
      if (!LIST_RE.test(list)) { errors.push(`სტრ. ${i + 1}: სიის კოდი „${c[0] ?? ''}“ არასწორია`); return; }
      if (!KINDS.includes(kind as ListKind)) { errors.push(`სტრ. ${i + 1}: სახეობა — dx / proc / service`); return; }
      if (!PATTERN_RE.test(p)) { errors.push(`სტრ. ${i + 1}: კოდი „${c[2] ?? ''}“ არასწორია`); return; }
      const l = byList.get(list) ?? { kind, items: new Map() };
      if (l.kind !== kind) { errors.push(`სტრ. ${i + 1}: სია ${list} — სხვადასხვა სახეობა`); return; }
      l.items.set(p, nz(c[3])?.slice(0, 300) ?? null);
      byList.set(list, l);
    });
    const existing = new Map((await this.db.selectFrom('drg_code_lists').select(['code', 'kind']).where('version_id', '=', id).execute()).map((l) => [l.code, l.kind]));
    for (const [k, l] of byList) if (existing.has(k) && existing.get(k) !== l.kind) errors.push(`სია ${k} ვერსიაში სხვა სახეობისაა (${existing.get(k)})`);
    if (!byList.size && !errors.length) errors.push('ფაილში ჩანაწერი ვერ მოიძებნა');
    const summary = { lists: byList.size, new_lists: [...byList.keys()].filter((k) => !existing.has(k)).length, items: [...byList.values()].reduce((a, l) => a + l.items.size, 0), errors: errors.slice(0, 50) };
    if (errors.length || dto.dry_run) return { ...summary, applied: false };
    await this.db.transaction().execute(async (trx) => {
      for (const [k, l] of byList) {
        if (!existing.has(k)) await trx.insertInto('drg_code_lists').values({ version_id: id, code: k, title: k, kind: l.kind }).execute();
        if (dto.replace) await trx.deleteFrom('drg_code_list_items').where('version_id', '=', id).where('list_code', '=', k).execute();
        const vals = [...l.items].map(([pattern, title]) => ({ version_id: id, list_code: k, pattern, title }));
        for (let i = 0; i < vals.length; i += 1000) {
          await trx.insertInto('drg_code_list_items').values(vals.slice(i, i + 1000)).onConflict((oc) => oc.columns(['version_id', 'list_code', 'pattern']).doUpdateSet({ title: sql`excluded.title` })).execute();
        }
      }
      await this.touch(trx, id, u);
      await this.audit.log(ctx, { action: 'DRG_LISTS_IMPORT', entityName: 'drg_code_lists', entityId: id, newData: summary }, trx);
    });
    return { ...summary, applied: true };
  }

  // ---------------------------------------------------------------- CC / MCC
  async ccList(id: string, q?: string) {
    let x = this.db.selectFrom('drg_cc').selectAll().where('version_id', '=', id).orderBy('pattern').limit(5000);
    if (q?.trim()) x = x.where('pattern', 'like', `${normPattern(q)}%`);
    return x.execute();
  }
  private excl(values: string[] | undefined, kinds: Map<string, ListKind>, at: string) {
    const out: string[] = [];
    for (const raw of values ?? []) {
      const t = raw.trim();
      if (!t) continue;
      if (t.startsWith('@')) {
        const n = t.slice(1).toUpperCase();
        if (kinds.get(n) !== 'dx') throw new BadRequestException(`${at}: სია @${n} — დიაგნოზების სია ვერსიაში არ არის`);
        out.push(`@${n}`);
      } else {
        const p = normPattern(t);
        if (!PATTERN_RE.test(p)) throw new BadRequestException(`${at}: კოდი „${t}“ არასწორია`);
        out.push(p);
      }
    }
    return [...new Set(out)];
  }
  async saveCc(id: string, dto: CcDto, u: AuthUser, ctx: AuditContext) {
    const p = normPattern(dto.pattern);
    if (!/^[A-Z0-9]+(-[A-Z0-9]+)?$/.test(p)) throw new BadRequestException('CC: კოდი „K35“ ან დიაპაზონი „K35-K37“');
    return this.db.transaction().execute(async (trx) => {
      await this.draft(trx, id);
      const ex = this.excl(dto.excl_pdx, await listKinds(trx, id), `CC ${p}`);
      const v = { level: dto.level, excl_pdx: ex, notes: nz(dto.notes) };
      const r = await trx.insertInto('drg_cc').values({ version_id: id, pattern: p, ...v }).onConflict((oc) => oc.columns(['version_id', 'pattern']).doUpdateSet(v)).returningAll().executeTakeFirstOrThrow();
      await this.touch(trx, id, u);
      await this.audit.log(ctx, { action: 'DRG_CC_SAVE', entityName: 'drg_cc', entityId: `${id}:${p}`, newData: r }, trx);
      return r;
    });
  }
  async deleteCc(id: string, pattern: string, u: AuthUser, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      await this.draft(trx, id);
      const r = await trx.deleteFrom('drg_cc').where('version_id', '=', id).where('pattern', '=', normPattern(pattern)).returningAll().executeTakeFirst();
      if (!r) throw new NotFoundException('ჩანაწერი ვერ მოიძებნა');
      await this.touch(trx, id, u);
      await this.audit.log(ctx, { action: 'DRG_CC_DELETE', entityName: 'drg_cc', entityId: `${id}:${r.pattern}`, oldData: r }, trx);
      return { ok: true };
    });
  }
  /** CSV: pattern;level[;excl_pdx (მძიმით)] */
  async importCc(id: string, dto: CsvImportDto, u: AuthUser, ctx: AuditContext) {
    await this.draft(this.db, id);
    const kinds = await listKinds(this.db, id);
    const errors: string[] = []; const rows = new Map<string, { level: 'cc' | 'mcc'; excl: string[] }>();
    parseCsv(dto.csv).forEach((c, i) => {
      const lvl = (c[1] ?? '').toLowerCase();
      if (i === 0 && lvl !== 'cc' && lvl !== 'mcc') return;   // სათაური
      const p = normPattern(c[0] ?? '');
      if (!/^[A-Z0-9]+(-[A-Z0-9]+)?$/.test(p)) { errors.push(`სტრ. ${i + 1}: კოდი „${c[0] ?? ''}“ არასწორია`); return; }
      if (lvl !== 'cc' && lvl !== 'mcc') { errors.push(`სტრ. ${i + 1}: დონე — cc / mcc`); return; }
      try { rows.set(p, { level: lvl, excl: this.excl((c[2] ?? '').split(/[\s,]+/), kinds, `სტრ. ${i + 1}`) }); } catch (e) { errors.push((e as Error).message); }
    });
    if (!rows.size && !errors.length) errors.push('ფაილში ჩანაწერი ვერ მოიძებნა');
    const existing = new Set((await this.db.selectFrom('drg_cc').select('pattern').where('version_id', '=', id).execute()).map((r) => r.pattern));
    const removed = dto.replace ? [...existing].filter((p) => !rows.has(p)) : [];
    const summary = { rows: rows.size, added: [...rows.keys()].filter((p) => !existing.has(p)).length, removed: removed.length, errors: errors.slice(0, 50) };
    if (errors.length || dto.dry_run) return { ...summary, applied: false };
    await this.db.transaction().execute(async (trx) => {
      if (removed.length) await trx.deleteFrom('drg_cc').where('version_id', '=', id).where('pattern', 'in', removed).execute();
      const vals = [...rows].map(([pattern, r]) => ({ version_id: id, pattern, level: r.level, excl_pdx: r.excl }));
      for (let i = 0; i < vals.length; i += 1000) {
        await trx.insertInto('drg_cc').values(vals.slice(i, i + 1000)).onConflict((oc) => oc.columns(['version_id', 'pattern']).doUpdateSet({ level: sql`excluded.level`, excl_pdx: sql`excluded.excl_pdx` })).execute();
      }
      await this.touch(trx, id, u);
      await this.audit.log(ctx, { action: 'DRG_CC_IMPORT', entityName: 'drg_cc', entityId: id, newData: summary }, trx);
    });
    return { ...summary, applied: true };
  }

  // ---------------------------------------------------------------- წესები
  async rules(id: string) {
    const rows = await this.db.selectFrom('drg_rules as r').leftJoin('drg_version_groups as g', (j) => j.onRef('g.version_id', '=', 'r.version_id').onRef('g.code', '=', 'r.drg_code'))
      .selectAll('r').select(['g.title as drg_title', 'g.weight as drg_weight']).where('r.version_id', '=', id).orderBy('r.seq').orderBy('r.id').execute();
    return rows.map((r) => ({ ...r, conditions_text: condsText(r.conditions as unknown as Cond[]) }));
  }
  private async ruleConds(trx: Trx | Database, id: string, dto: RuleDto): Promise<Cond[] | undefined> {
    const kinds = await listKinds(trx, id);
    if (dto.conditions_text !== undefined) {
      const r = parseConds(dto.conditions_text, kinds);
      if ('error' in r) throw new BadRequestException(`პირობები: ${r.error}`);
      return r.conds;
    }
    if (dto.conditions !== undefined) {
      if (dto.conditions.length > 50) throw new BadRequestException('პირობები: მაქს. 50');
      for (const c of dto.conditions) { const err = validateCond(c, kinds); if (err) throw new BadRequestException(`პირობები: ${err}`); }
      return dto.conditions.map((c) => ({ f: c.f, op: c.op, v: c.v }));
    }
    return undefined;
  }
  async createRule(id: string, dto: RuleDto, u: AuthUser, ctx: AuditContext) {
    if (!dto.drg_code) throw new BadRequestException('წესს სჭირდება DRG ჯგუფი');
    try {
      return await this.db.transaction().execute(async (trx) => {
        await this.draft(trx, id);
        const conds = (await this.ruleConds(trx, id, dto)) ?? [];
        const seq = dto.seq ?? ((await trx.selectFrom('drg_rules').select(sql<number>`coalesce(max(seq), 0)::int`.as('m')).where('version_id', '=', id).executeTakeFirstOrThrow()).m + 10);
        const r = await trx.insertInto('drg_rules').values({ version_id: id, seq, drg_code: dto.drg_code!.toUpperCase(), label: nz(dto.label), conditions: JSON.stringify(conds),
          is_active: dto.is_active ?? true, notes: nz(dto.notes) }).returningAll().executeTakeFirstOrThrow();
        await this.touch(trx, id, u);
        await this.audit.log(ctx, { action: 'DRG_RULE_CREATE', entityName: 'drg_rules', entityId: r.id, newData: r }, trx);
        return { ...r, conditions_text: condsText(conds) };
      });
    } catch (e) { mapPgError(e, { drg_rules_version_id_drg_code_fkey: `ჯგუფი ${dto.drg_code?.toUpperCase()} ვერსიაში არ არის` }); }
  }
  async updateRule(ruleId: string, dto: RuleDto, u: AuthUser, ctx: AuditContext) {
    try {
      return await this.db.transaction().execute(async (trx) => {
        const old = await trx.selectFrom('drg_rules').selectAll().where('id', '=', ruleId).forUpdate().executeTakeFirst();
        if (!old) throw new NotFoundException('წესი ვერ მოიძებნა');
        await this.draft(trx, old.version_id);
        const conds = await this.ruleConds(trx, old.version_id, dto);
        if (!conds && [dto.seq, dto.drg_code, dto.label, dto.is_active, dto.notes].every((x) => x === undefined)) return { ...old, conditions_text: condsText(old.conditions as unknown as Cond[]) };
        const r = await trx.updateTable('drg_rules').set({
          ...(dto.seq !== undefined && { seq: dto.seq }), ...(dto.drg_code !== undefined && { drg_code: dto.drg_code.toUpperCase() }), ...(dto.label !== undefined && { label: nz(dto.label) }),
          ...(conds && { conditions: JSON.stringify(conds) }), ...(dto.is_active !== undefined && { is_active: dto.is_active }), ...(dto.notes !== undefined && { notes: nz(dto.notes) }),
        }).where('id', '=', ruleId).returningAll().executeTakeFirstOrThrow();
        await this.touch(trx, old.version_id, u);
        await this.audit.log(ctx, { action: 'DRG_RULE_UPDATE', entityName: 'drg_rules', entityId: ruleId, oldData: old, newData: r }, trx);
        return { ...r, conditions_text: condsText(r.conditions as unknown as Cond[]) };
      });
    } catch (e) { mapPgError(e, { drg_rules_version_id_drg_code_fkey: `ჯგუფი ${dto.drg_code?.toUpperCase()} ვერსიაში არ არის` }); }
  }
  async deleteRule(ruleId: string, u: AuthUser, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const old = await trx.selectFrom('drg_rules').selectAll().where('id', '=', ruleId).executeTakeFirst();
      if (!old) throw new NotFoundException('წესი ვერ მოიძებნა');
      await this.draft(trx, old.version_id);
      await trx.deleteFrom('drg_rules').where('id', '=', ruleId).execute();
      await this.touch(trx, old.version_id, u);
      await this.audit.log(ctx, { action: 'DRG_RULE_DELETE', entityName: 'drg_rules', entityId: ruleId, oldData: old }, trx);
      return { ok: true };
    });
  }
  /** რიგის შეცვლა: ids — ახალი თანმიმდევრობა (seq = 10, 20, …) */
  async reorder(id: string, dto: ReorderDto, u: AuthUser, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      await this.draft(trx, id);
      const all = (await trx.selectFrom('drg_rules').select('id').where('version_id', '=', id).execute()).map((r) => r.id);
      if (dto.ids.length !== all.length || !all.every((x) => dto.ids.includes(x))) throw new BadRequestException('რიგი: ვერსიის ყველა წესი ზუსტად ერთხელ');
      for (const [i, rid] of dto.ids.entries()) await trx.updateTable('drg_rules').set({ seq: (i + 1) * 10 }).where('id', '=', rid).execute();
      await this.touch(trx, id, u);
      await this.audit.log(ctx, { action: 'DRG_RULES_REORDER', entityName: 'drg_rules', entityId: id, newData: { n: dto.ids.length } }, trx);
      return { ok: true };
    });
  }
  /** CSV: seq;drg_code;conditions[;label[;active]] — replace → ვერსიის წესები = ფაილი */
  async importRules(id: string, dto: CsvImportDto, u: AuthUser, ctx: AuditContext) {
    await this.draft(this.db, id);
    const kinds = await listKinds(this.db, id);
    const groups = new Set((await this.db.selectFrom('drg_version_groups').select('code').where('version_id', '=', id).execute()).map((g) => g.code));
    const errors: string[] = []; const rows: { seq: number; drg_code: string; conds: Cond[]; label: string | null; active: boolean }[] = [];
    parseCsv(dto.csv).forEach((c, i) => {
      const seq = num(c[0]);
      if (i === 0 && (seq === null || !Number.isFinite(seq))) return;   // სათაური
      if (seq === null || !Number.isInteger(seq) || seq < 1) { errors.push(`სტრ. ${i + 1}: რიგი (seq) — მთელი რიცხვი`); return; }
      const code = (c[1] ?? '').toUpperCase();
      if (!groups.has(code)) { errors.push(`სტრ. ${i + 1}: ჯგუფი „${c[1] ?? ''}“ ვერსიაში არ არის`); return; }
      const p = parseConds(c[2] ?? '', kinds);
      if ('error' in p) { errors.push(`სტრ. ${i + 1}: ${p.error}`); return; }
      rows.push({ seq, drg_code: code, conds: p.conds, label: nz(c[3])?.slice(0, 300) ?? null, active: !/^(0|no|false|არა)$/i.test(c[4] ?? '') });
    });
    if (!rows.length && !errors.length) errors.push('ფაილში ჩანაწერი ვერ მოიძებნა');
    const summary = { rows: rows.length, replace: !!dto.replace, errors: errors.slice(0, 50) };
    if (errors.length || dto.dry_run) return { ...summary, applied: false };
    await this.db.transaction().execute(async (trx) => {
      if (dto.replace) await trx.deleteFrom('drg_rules').where('version_id', '=', id).execute();
      for (const r of rows) {
        await trx.insertInto('drg_rules').values({ version_id: id, seq: r.seq, drg_code: r.drg_code, label: r.label, conditions: JSON.stringify(r.conds), is_active: r.active }).execute();
      }
      await this.touch(trx, id, u);
      await this.audit.log(ctx, { action: 'DRG_RULES_IMPORT', entityName: 'drg_rules', entityId: id, newData: summary }, trx);
    });
    return { ...summary, applied: true };
  }

  // ---------------------------------------------------------------- ექსპორტი / პაკეტი
  async exportPackage(id: string): Promise<Pkg & { scheme_code: string; exported_at: string }> {
    const v = await this.version(id);
    const [groups, lists, items, cc, rules] = await Promise.all([
      this.db.selectFrom('drg_version_groups').select(['code', 'title', 'weight', 'alos', 'los_low', 'los_high', 'mdc', 'kind', 'notes']).where('version_id', '=', id).orderBy('code').execute(),
      this.db.selectFrom('drg_code_lists').select(['code', 'title', 'kind', 'notes']).where('version_id', '=', id).orderBy('code').execute(),
      this.db.selectFrom('drg_code_list_items').select(['list_code', 'pattern', 'title']).where('version_id', '=', id).orderBy('list_code').orderBy('pattern').execute(),
      this.db.selectFrom('drg_cc').select(['pattern', 'level', 'excl_pdx', 'notes']).where('version_id', '=', id).orderBy('pattern').execute(),
      this.db.selectFrom('drg_rules').select(['seq', 'drg_code', 'label', 'conditions', 'is_active', 'notes']).where('version_id', '=', id).orderBy('seq').execute(),
    ]);
    return {
      format: 'emr-drg-version', format_version: 1, scheme_code: v.scheme_code, label: v.label, valid_from: v.valid_from, settings: v.settings as unknown as Record<string, unknown>,
      notes: v.notes, exported_at: new Date().toISOString(),
      groups: groups.map((g) => ({ ...g, weight: Number(g.weight), alos: g.alos === null ? null : Number(g.alos) })),
      lists: lists.map((l) => ({ ...l, items: items.filter((i) => i.list_code === l.code).map((i) => (i.title ? { pattern: i.pattern, title: i.title } : i.pattern)) })),
      cc: cc.map((c) => ({ ...c, excl_pdx: c.excl_pdx ?? [] })),
      rules: rules.map((r) => ({ ...r, conditions: r.conditions as unknown as Cond[] })),
    };
  }
  async exportCsv(id: string, table: string) {
    await this.version(id);
    if (table === 'groups') {
      const g = await this.db.selectFrom('drg_version_groups').selectAll().where('version_id', '=', id).orderBy('code').execute();
      return buildCsv(['code', 'title', 'weight', 'alos', 'los_low', 'los_high', 'mdc', 'kind'], g.map((x) => [x.code, x.title, x.weight, x.alos, x.los_low, x.los_high, x.mdc, x.kind]));
    }
    if (table === 'lists') {
      const l = await this.db.selectFrom('drg_code_list_items as i').innerJoin('drg_code_lists as l', (j) => j.onRef('l.version_id', '=', 'i.version_id').onRef('l.code', '=', 'i.list_code'))
        .select(['i.list_code', 'l.kind', 'i.pattern', 'i.title']).where('i.version_id', '=', id).orderBy('i.list_code').orderBy('i.pattern').execute();
      return buildCsv(['list', 'kind', 'pattern', 'title'], l.map((x) => [x.list_code, x.kind, x.pattern, x.title]));
    }
    if (table === 'cc') {
      const c = await this.db.selectFrom('drg_cc').selectAll().where('version_id', '=', id).orderBy('pattern').execute();
      return buildCsv(['pattern', 'level', 'excl_pdx'], c.map((x) => [x.pattern, x.level, (x.excl_pdx ?? []).join(',')]));
    }
    if (table === 'rules') {
      const r = await this.db.selectFrom('drg_rules').selectAll().where('version_id', '=', id).orderBy('seq').execute();
      return buildCsv(['seq', 'drg_code', 'conditions', 'label', 'active'], r.map((x) => [x.seq, x.drg_code, condsText(x.conditions as unknown as Cond[]), x.label, x.is_active ? 1 : 0]));
    }
    throw new BadRequestException('ცხრილი: groups / lists / cc / rules');
  }

  /** პაკეტიდან (JSON) — ახალი მონახაზი; ყველაფერი მოწმდება იმავე წესებით, რაც ხელით შეყვანისას */
  async importPackage(schemeId: string, dto: PackageImportDto, u: AuthUser, ctx: AuditContext, action = 'DRG_VERSION_IMPORT') {
    const p = dto.package as unknown as Pkg;
    if (p?.format !== 'emr-drg-version' || p.format_version !== 1) throw new BadRequestException('ფაილი არ არის DRG ვერსიის პაკეტი (format: emr-drg-version, format_version: 1)');
    for (const k of ['groups', 'lists', 'cc', 'rules'] as const) if (!Array.isArray(p[k])) throw new BadRequestException(`პაკეტი: ${k} — სია`);
    const label = (dto.label ?? p.label ?? '').trim(); const from = dto.valid_from ?? p.valid_from;
    if (label.length < 2) throw new BadRequestException('მიუთითეთ ვერსიის დასახელება');
    if (!from || !/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new BadRequestException('მიუთითეთ მოქმედების თარიღი');
    const settings = { ...VERSION_SETTINGS_DEFAULT, ...(p.settings ?? {}) };
    const se = validateVersionSettings(settings);
    if (se) throw new BadRequestException(`პაკეტი — პარამეტრები: ${se}`);
    const errors: string[] = [];
    const groups = p.groups.map((g, i) => this.groupRow(g as unknown as Record<string, unknown>, `ჯგუფი ${i + 1}`, errors)).filter((x): x is NonNullable<typeof x> => !!x);
    const gset = new Set(groups.map((g) => g.code));
    if (gset.size !== groups.length) errors.push('ჯგუფები: გამეორებული კოდები');
    const kinds = new Map<string, ListKind>();
    const lists = p.lists.map((l, i) => {
      const code = String(l.code ?? '').toUpperCase();
      if (!LIST_RE.test(code) || !KINDS.includes(l.kind as ListKind) || String(l.title ?? '').trim().length < 2) { errors.push(`სია ${i + 1}: კოდი / სახეობა / დასახელება`); return null; }
      kinds.set(code, l.kind as ListKind);
      const items: { pattern: string; title: string | null }[] = [];
      for (const it of l.items ?? []) {
        const raw = typeof it === 'string' ? it : it?.pattern; const pt = normPattern(String(raw ?? ''));
        if (!PATTERN_RE.test(pt)) { errors.push(`სია ${code}: კოდი „${String(raw)}“`); continue; }
        items.push({ pattern: pt, title: typeof it === 'string' ? null : nz(it.title ?? null) });
      }
      return { code, title: String(l.title).trim(), kind: l.kind, notes: nz(l.notes ?? null), items: [...new Map(items.map((x) => [x.pattern, x])).values()] };
    }).filter((x): x is NonNullable<typeof x> => !!x);
    const cc = p.cc.map((c, i) => {
      const pt = normPattern(String(c.pattern ?? ''));
      if (!/^[A-Z0-9]+(-[A-Z0-9]+)?$/.test(pt) || !['cc', 'mcc'].includes(c.level)) { errors.push(`CC ${i + 1}: კოდი / დონე`); return null; }
      try { return { pattern: pt, level: c.level, excl_pdx: this.excl(c.excl_pdx, kinds, `CC ${pt}`), notes: nz(c.notes ?? null) }; } catch (e) { errors.push((e as Error).message); return null; }
    }).filter((x): x is NonNullable<typeof x> => !!x);
    const rules = p.rules.map((r, i) => {
      const code = String(r.drg_code ?? '').toUpperCase();
      if (!gset.has(code)) { errors.push(`წესი ${i + 1}: ჯგუფი ${code} პაკეტში არ არის`); return null; }
      if (!Number.isInteger(r.seq) || r.seq < 1) { errors.push(`წესი ${i + 1}: seq`); return null; }
      let conds: Cond[] = [];
      if (typeof r.conditions_text === 'string') { const x = parseConds(r.conditions_text, kinds); if ('error' in x) { errors.push(`წესი ${r.seq}: ${x.error}`); return null; } conds = x.conds; }
      else for (const c of r.conditions ?? []) { const e = validateCond(c, kinds); if (e) { errors.push(`წესი ${r.seq}: ${e}`); return null; } conds.push({ f: c.f, op: c.op, v: c.v }); }
      return { seq: r.seq, drg_code: code, label: nz(r.label ?? null), conditions: conds, is_active: r.is_active !== false, notes: nz(r.notes ?? null) };
    }).filter((x): x is NonNullable<typeof x> => !!x);
    if (settings.fallback_code && !gset.has(settings.fallback_code)) errors.push(`ნაგულისხმევი ჯგუფი ${settings.fallback_code} პაკეტში არ არის`);
    if (errors.length) throw new BadRequestException({ code: 'DRG_PACKAGE_INVALID', message: `პაკეტი: ${errors.slice(0, 5).join('; ')}${errors.length > 5 ? ` (+${errors.length - 5})` : ''}`, errors: errors.slice(0, 100) });
    return this.db.transaction().execute(async (trx) => {
      const s = await trx.selectFrom('drg_schemes').select('is_active').where('id', '=', schemeId).forUpdate().executeTakeFirst();
      if (!s?.is_active) throw new BadRequestException('სქემა ვერ მოიძებნა ან გათიშულია');
      const no = (await trx.selectFrom('drg_versions').select(sql<number>`coalesce(max(version_no), 0)::int`.as('m')).where('scheme_id', '=', schemeId).executeTakeFirstOrThrow()).m + 1;
      const v = await trx.insertInto('drg_versions').values({ scheme_id: schemeId, version_no: no, label, valid_from: from, settings: JSON.stringify(settings), notes: nz(p.notes ?? null),
        created_by: u.id, updated_by: u.id }).returning('id').executeTakeFirstOrThrow();
      if (groups.length) await trx.insertInto('drg_version_groups').values(groups.map((g) => ({ version_id: v.id, ...g, weight: String(g.weight), alos: g.alos === null ? null : String(g.alos) }))).execute();
      for (const l of lists) {
        await trx.insertInto('drg_code_lists').values({ version_id: v.id, code: l.code, title: l.title, kind: l.kind, notes: l.notes }).execute();
        if (l.items.length) await trx.insertInto('drg_code_list_items').values(l.items.map((x) => ({ version_id: v.id, list_code: l.code, ...x }))).execute();
      }
      if (cc.length) await trx.insertInto('drg_cc').values(cc.map((c) => ({ version_id: v.id, ...c }))).execute();
      for (const r of rules) await trx.insertInto('drg_rules').values({ version_id: v.id, ...r, conditions: JSON.stringify(r.conditions) }).execute();
      await this.audit.log(ctx, { action, entityName: 'drg_versions', entityId: v.id, newData: { label, valid_from: from, groups: groups.length, lists: lists.length, cc: cc.length, rules: rules.length } }, trx);
      return { id: v.id, version_no: no, groups: groups.length, lists: lists.length, cc: cc.length, rules: rules.length };
    });
  }
  /** სადემონსტრაციო კონფიგურაცია (assets/drg-demo.json) — მონახაზად; რეალური სტანდარტი არ არის */
  async demo(schemeId: string, dto: DemoDto, u: AuthUser, ctx: AuditContext) {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'assets', 'drg-demo.json'), 'utf8')) as Record<string, unknown>;
    return this.importPackage(schemeId, { package: pkg, valid_from: dto.valid_from ?? new Date().toISOString().slice(0, 10) }, u, ctx, 'DRG_VERSION_DEMO');
  }

  /** ტესტ-შემთხვევა: ხელით შეყვანილი მონაცემები → ჯგუფი და „რატომ“ (ნებისმიერ ვერსიაზე, მონახაზზეც) */
  async test(id: string, dto: TestDto) {
    if (!(await versionMeta(this.db, id))) throw new NotFoundException('ვერსია ვერ მოიძებნა');
    const v = await loadVersion(this.db, id);
    const codes = (xs?: string[]) => [...new Set((xs ?? []).map((x) => norm(x)).filter(Boolean))].sort();
    const pdx = dto.pdx?.trim() ? norm(dto.pdx) : null;
    const x: GroupInputs = {
      pdx, sdx: codes(dto.sdx).filter((c) => c !== pdx), procs: codes(dto.procs), services: codes(dto.services), surgery: dto.surgery ?? (dto.procs ?? []).length > 0,
      age: dto.age ?? null, age_days: dto.age_days ?? (dto.age != null ? Math.floor(dto.age * 365.25) : null), sex: dto.sex ?? null, los: dto.los ?? 1,
      icu_hours: dto.icu_hours ?? 0, vent_hours: dto.vent_hours ?? 0, discharge: dto.discharge || null, source: dto.source || null,
    };
    return { inputs: x, result: group(x, v) };
  }
}

// ================================================================= controller
@Controller('drg')
export class DrgConfigController {
  constructor(private readonly s: DrgConfigService) {}
  @Get('meta') @Roles(...DRG_READ) meta() { return this.s.meta(); }
  @Get('schemes') @Roles(...DRG_READ) schemes() { return this.s.schemes(); }
  @Post('schemes') @Roles(...DRG_ADMIN) addScheme(@Body() d: SchemeDto, @Req() r: Request) { return this.s.saveScheme(null, d, auditCtx(r)); }
  @Patch('schemes/:id') @Roles(...DRG_ADMIN) updScheme(@Param('id', ParseUUIDPipe) id: string, @Body() d: SchemeDto, @Req() r: Request) { return this.s.saveScheme(id, d, auditCtx(r)); }
  @Get('payers') @Roles(...DRG_READ) payers() { return this.s.payers(); }
  @Put('payers/:id/scheme') @Roles(...DRG_ADMIN) payerScheme(@Param('id', ParseUUIDPipe) id: string, @Body() d: PayerSchemeDto, @Req() r: Request) { return this.s.setPayerScheme(id, d, auditCtx(r)); }

  @Get('schemes/:id/versions') @Roles(...DRG_READ) versions(@Param('id', ParseUUIDPipe) id: string) { return this.s.versions(id); }
  @Post('schemes/:id/versions') @Roles(...DRG_ADMIN)
  addVersion(@Param('id', ParseUUIDPipe) id: string, @Body() d: VersionCreateDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.createVersion(id, d, u, auditCtx(r)); }
  @Post('schemes/:id/versions/import') @Roles(...DRG_ADMIN)
  importPkg(@Param('id', ParseUUIDPipe) id: string, @Body() d: PackageImportDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.importPackage(id, d, u, auditCtx(r)); }
  @Post('schemes/:id/versions/demo') @Roles(...DRG_ADMIN)
  demo(@Param('id', ParseUUIDPipe) id: string, @Body() d: DemoDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.demo(id, d, u, auditCtx(r)); }

  @Get('versions/:id') @Roles(...DRG_READ) version(@Param('id', ParseUUIDPipe) id: string) { return this.s.version(id); }
  @Patch('versions/:id') @Roles(...DRG_ADMIN)
  updVersion(@Param('id', ParseUUIDPipe) id: string, @Body() d: VersionUpdateDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.updateVersion(id, d, u, auditCtx(r)); }
  @Delete('versions/:id') @Roles(...DRG_ADMIN) delVersion(@Param('id', ParseUUIDPipe) id: string, @Req() r: Request) { return this.s.deleteVersion(id, auditCtx(r)); }
  @Get('versions/:id/check') @Roles(...DRG_READ) check(@Param('id', ParseUUIDPipe) id: string) { return this.s.check(id); }
  @Post('versions/:id/activate') @HttpCode(200) @Roles(...DRG_ADMIN)
  activate(@Param('id', ParseUUIDPipe) id: string, @Body() _d: ActivateDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.activate(id, u, auditCtx(r)); }
  @Post('versions/:id/retire') @HttpCode(200) @Roles(...DRG_ADMIN)
  retire(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.retire(id, d, u, auditCtx(r)); }
  @Post('versions/:id/test') @HttpCode(200) @Roles(...DRG_READ) test(@Param('id', ParseUUIDPipe) id: string, @Body() d: TestDto) { return this.s.test(id, d); }
  @Get('versions/:id/export') @Roles(...DRG_READ)
  async export(@Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response) {
    const p = await this.s.exportPackage(id);
    res.set({ 'Content-Disposition': `attachment; filename="drg-${p.scheme_code}-${p.valid_from}.json"` });
    return p;
  }
  @Get('versions/:id/csv/:table') @Roles(...DRG_READ)
  async csv(@Param('id', ParseUUIDPipe) id: string, @Param('table') table: string, @Res({ passthrough: true }) res: Response) {
    const csv = await this.s.exportCsv(id, table);
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="drg-${table}.csv"` });
    return csv;
  }

  @Get('versions/:id/groups') @Roles(...DRG_READ)
  groups(@Param('id', ParseUUIDPipe) id: string, @Query('q') q?: string, @Query('limit') l?: string) { return this.s.groups(id, q, Number(l) || 500); }
  @Put('versions/:id/groups/:code') @Roles(...DRG_ADMIN)
  saveGroup(@Param('id', ParseUUIDPipe) id: string, @Param('code') code: string, @Body() d: GroupDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.saveGroup(id, code, d, u, auditCtx(r)); }
  @Delete('versions/:id/groups/:code') @Roles(...DRG_ADMIN)
  delGroup(@Param('id', ParseUUIDPipe) id: string, @Param('code') code: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.deleteGroup(id, code, u, auditCtx(r)); }
  @Post('versions/:id/groups/import') @HttpCode(200) @Roles(...DRG_ADMIN)
  importGroups(@Param('id', ParseUUIDPipe) id: string, @Body() d: CsvImportDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.importGroups(id, d, u, auditCtx(r)); }

  @Get('versions/:id/lists') @Roles(...DRG_READ) lists(@Param('id', ParseUUIDPipe) id: string) { return this.s.lists(id); }
  @Get('versions/:id/lists/:code') @Roles(...DRG_READ) list(@Param('id', ParseUUIDPipe) id: string, @Param('code') code: string) { return this.s.list(id, code); }
  @Put('versions/:id/lists/:code') @Roles(...DRG_ADMIN)
  saveList(@Param('id', ParseUUIDPipe) id: string, @Param('code') code: string, @Body() d: ListDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.saveList(id, code, d, u, auditCtx(r)); }
  @Delete('versions/:id/lists/:code') @Roles(...DRG_ADMIN)
  delList(@Param('id', ParseUUIDPipe) id: string, @Param('code') code: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.deleteList(id, code, u, auditCtx(r)); }
  @Post('versions/:id/lists-import') @HttpCode(200) @Roles(...DRG_ADMIN)
  importLists(@Param('id', ParseUUIDPipe) id: string, @Body() d: CsvImportDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.importLists(id, d, u, auditCtx(r)); }

  @Get('versions/:id/cc') @Roles(...DRG_READ) cc(@Param('id', ParseUUIDPipe) id: string, @Query('q') q?: string) { return this.s.ccList(id, q); }
  @Put('versions/:id/cc') @Roles(...DRG_ADMIN)
  saveCc(@Param('id', ParseUUIDPipe) id: string, @Body() d: CcDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.saveCc(id, d, u, auditCtx(r)); }
  @Delete('versions/:id/cc/:pattern') @Roles(...DRG_ADMIN)
  delCc(@Param('id', ParseUUIDPipe) id: string, @Param('pattern') p: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.deleteCc(id, p, u, auditCtx(r)); }
  @Post('versions/:id/cc-import') @HttpCode(200) @Roles(...DRG_ADMIN)
  importCc(@Param('id', ParseUUIDPipe) id: string, @Body() d: CsvImportDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.importCc(id, d, u, auditCtx(r)); }

  @Get('versions/:id/rules') @Roles(...DRG_READ) rules(@Param('id', ParseUUIDPipe) id: string) { return this.s.rules(id); }
  @Post('versions/:id/rules') @Roles(...DRG_ADMIN)
  addRule(@Param('id', ParseUUIDPipe) id: string, @Body() d: RuleDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.createRule(id, d, u, auditCtx(r)); }
  @Post('versions/:id/rules-reorder') @HttpCode(200) @Roles(...DRG_ADMIN)
  reorder(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReorderDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.reorder(id, d, u, auditCtx(r)); }
  @Post('versions/:id/rules-import') @HttpCode(200) @Roles(...DRG_ADMIN)
  importRules(@Param('id', ParseUUIDPipe) id: string, @Body() d: CsvImportDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.importRules(id, d, u, auditCtx(r)); }
  @Patch('rules/:rid') @Roles(...DRG_ADMIN)
  updRule(@Param('rid', ParseUUIDPipe) rid: string, @Body() d: RuleDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.updateRule(rid, d, u, auditCtx(r)); }
  @Delete('rules/:rid') @Roles(...DRG_ADMIN)
  delRule(@Param('rid', ParseUUIDPipe) rid: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.deleteRule(rid, u, auditCtx(r)); }
}
