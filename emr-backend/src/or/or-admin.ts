import { BadRequestException, Body, ConflictException, Controller, Get, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { Roles } from '../auth/decorators';
import { mapPgError } from '../common/pg-errors';
import { InjectDb, type Database } from '../database/database.module';

/** საოპერაციოს ნახვა (დაფა, ცნობარები) — 0048 */
export const OR_READ = ['admin', 'doctor', 'nurse', 'or_schedule', 'anesthesiologist', 'or_nurse', 'manager', 'viewer'] as const;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

// ================================================================= DTO
export class BlockDto { @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() stock_location_id?: string | null }
export class RoomDto {
  @IsOptional() @IsUUID() department_id?: string;
  @IsOptional() @Transform(trim) @Matches(/^[A-Za-z0-9_.-]{1,20}$/, { message: 'კოდი: ლათინური ასოები, ციფრები, _ . - (მაგ. OR1)' }) code?: string;
  @IsOptional() @Transform(trim) @IsString() @Length(2, 120) name?: string;
  @IsOptional() @Matches(HHMM) work_start?: string;
  @IsOptional() @Matches(HHMM) work_end?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(7) @IsInt({ each: true }) @Min(1, { each: true }) @Max(7, { each: true }) work_days?: number[];
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) specialties?: string[];
  @IsOptional() @IsBoolean() emergency_only?: boolean;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(1000) notes?: string | null;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(10_000) sort_order?: number;
}
export class RefDto {
  @IsOptional() @Matches(/^[a-z][a-z0-9_]{1,29}$/, { message: 'კოდი: ლათინური პატარა ასოები, ციფრები, _' }) code?: string;
  @IsOptional() @Transform(trim) @IsString() @Length(2, 200) name?: string;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(10_000) sort_order?: number;
}
export class TeamRoleDto extends RefDto {
  @IsOptional() @IsIn(['surgical', 'anesthesia', 'nursing']) grp?: string;
  @IsOptional() @IsIn(['doctor', 'anesthesiologist', 'or_nurse', 'nurse']) capability?: string;
  @IsOptional() @IsBoolean() multiple?: boolean;
}
export class ProcedureDto {
  @IsOptional() @Transform(trim) @Matches(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,19}$/, { message: 'კოდი: ლათინური ასოები, ციფრები, _ . -' }) code?: string;
  @IsOptional() @ValidateIf((_, v) => v !== null && v !== '') @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @Matches(/^[A-Z]{3}[0-9]{2}[A-Z0-9]?$/, { message: 'NCSP კოდი: 3 ასო + 2 ციფრი (+1), მაგ. JDF10' }) ncsp_code?: string | null;
  @IsOptional() @Transform(trim) @IsString() @Length(3, 300) name?: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() specialty_code?: string | null;
  @IsOptional() @IsInt() @Min(5) @Max(1440) default_duration_min?: number;
  @IsOptional() @IsBoolean() laterality?: boolean;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() tariff_id?: string | null;
  @IsOptional() @IsBoolean() is_active?: boolean;
}
export class ProcedureImportDto {
  @IsString() @Length(5, 900_000) csv: string;
  @IsOptional() @IsBoolean() deactivate_missing?: boolean;
  @IsOptional() @IsBoolean() dry_run?: boolean;
}
export class ReadinessItemDto {
  @IsOptional() @Transform(trim) @IsString() @Length(3, 300) label?: string;
  @IsOptional() @IsIn(['always', 'anesthesia', 'laterality', 'blood', 'implant']) applies?: string;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(10_000) sort_order?: number;
}
export class WhoItemDto {
  @IsOptional() @IsIn(['sign_in', 'time_out', 'sign_out']) phase?: string;
  @IsOptional() @Transform(trim) @IsString() @Length(3, 300) label?: string;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(10_000) sort_order?: number;
}

/**
 * საოპერაციო ბლოკის სტრუქტურა და ცნობარები (0048): ბლოკი (განყოფილება type = or) + საწყობის ლოკაცია, ოთახები, სპეციალობები,
 * პროცედურების კატალოგი (CSV იმპორტი), გუნდის როლები, გაუქმების მიზეზები, მზადყოფნის / WHO ჩეკლისტის პუნქტები. ცვლილება — admin.
 */
@Injectable()
export class OrAdminService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService) {}

  async setup(all: boolean) {
    const [blocks, rooms, specialties, team_roles, cancel_reasons, readiness_items, who_items, locations] = await Promise.all([
      this.db.selectFrom('departments as d').leftJoin('stock_locations as l', 'l.id', 'd.or_stock_location_id')
        .select(['d.id', 'd.name', 'd.code', 'd.is_active', 'd.or_stock_location_id as stock_location_id', 'l.name as stock_location_name'])
        .where('d.type', '=', 'or').$if(!all, (q) => q.where('d.is_active', '=', true)).orderBy('d.name').execute(),
      this.db.selectFrom('or_rooms as r').innerJoin('departments as d', 'd.id', 'r.department_id').selectAll('r').select('d.name as block_name')
        .$if(!all, (q) => q.where('r.is_active', '=', true)).orderBy('d.name').orderBy('r.sort_order').orderBy('r.code').execute(),
      this.db.selectFrom('or_specialties').selectAll().$if(!all, (q) => q.where('is_active', '=', true)).orderBy('sort_order').orderBy('name').execute(),
      this.db.selectFrom('or_team_roles').selectAll().$if(!all, (q) => q.where('is_active', '=', true)).orderBy('sort_order').execute(),
      this.db.selectFrom('or_cancel_reasons').selectAll().$if(!all, (q) => q.where('is_active', '=', true)).orderBy('sort_order').execute(),
      this.db.selectFrom('or_readiness_items').selectAll().$if(!all, (q) => q.where('is_active', '=', true)).orderBy('sort_order').execute(),
      this.db.selectFrom('or_who_items').selectAll().$if(!all, (q) => q.where('is_active', '=', true)).orderBy('phase').orderBy('sort_order').execute(),
      this.db.selectFrom('stock_locations').select(['id', 'code', 'name', 'kind', 'department_id']).where('is_active', '=', true)
        .where('kind', 'in', ['operating', 'department', 'other']).orderBy('sort_order').orderBy('name').execute(),
    ]);
    return { blocks, rooms, specialties, team_roles, cancel_reasons, readiness_items, who_items, locations };
  }

  // ---------------------------------------------------------------- ბლოკი
  async setBlock(id: string, dto: BlockDto, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const d = await trx.selectFrom('departments').select(['id', 'type', 'or_stock_location_id']).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!d || d.type !== 'or') throw new NotFoundException('საოპერაციო ბლოკი ვერ მოიძებნა (განყოფილების ტიპი „or“)');
      if (dto.stock_location_id) {
        const l = await trx.selectFrom('stock_locations').select('is_active').where('id', '=', dto.stock_location_id).executeTakeFirst();
        if (!l?.is_active) throw new BadRequestException('საწყობის ლოკაცია ვერ მოიძებნა ან გათიშულია');
      }
      await trx.updateTable('departments').set({ or_stock_location_id: dto.stock_location_id ?? null }).where('id', '=', id).execute();
      await this.audit.log(ctx, { action: 'OR_BLOCK', entityName: 'departments', entityId: id, oldData: { stock_location_id: d.or_stock_location_id }, newData: dto }, trx);
      return { id, stock_location_id: dto.stock_location_id ?? null };
    });
  }

  // ---------------------------------------------------------------- ოთახები
  async saveRoom(id: string | null, dto: RoomDto, ctx: AuditContext) {
    if (dto.specialties) dto.specialties = [...new Set(dto.specialties)];
    if (dto.work_days) dto.work_days = [...new Set(dto.work_days)].sort();
    if (dto.work_start && dto.work_end && dto.work_end <= dto.work_start) throw new BadRequestException('სამუშაო საათები: დასასრული დაწყებაზე გვიან უნდა იყოს');
    try {
      return await this.db.transaction().execute(async (trx) => {
        const old = id ? await trx.selectFrom('or_rooms').selectAll().where('id', '=', id).forUpdate().executeTakeFirst() : null;
        if (id && !old) throw new NotFoundException('ოთახი ვერ მოიძებნა');
        if (!id && (!dto.department_id || !dto.code || !dto.name)) throw new BadRequestException('ბლოკი, კოდი და დასახელება სავალდებულოა');
        if (dto.department_id && dto.department_id !== old?.department_id) {
          const d = await trx.selectFrom('departments').select(['type', 'is_active']).where('id', '=', dto.department_id).executeTakeFirst();
          if (!d || d.type !== 'or') throw new BadRequestException('ოთახი მხოლოდ საოპერაციო ბლოკს ეკუთვნის (განყოფილების ტიპი „საოპერაციო ბლოკი“)');
          if (!d.is_active) throw new BadRequestException('ბლოკი გათიშულია');
        }
        if (old && dto.is_active === false && old.is_active) {
          const busy = await trx.selectFrom('or_cases').select('case_no').where('room_id', '=', old.id).where('status', 'in', ['tentative', 'scheduled', 'in_progress'])
            .where('scheduled_end', '>', sql<Date>`now()`).limit(1).executeTakeFirst();
          if (busy) throw new ConflictException(`ოთახში დაგეგმილია ოპერაცია (${busy.case_no}) — ჯერ გადაიტანეთ`);
        }
        const v = {
          ...(dto.department_id !== undefined && { department_id: dto.department_id }), ...(dto.code !== undefined && { code: dto.code }),
          ...(dto.name !== undefined && { name: dto.name }), ...(dto.work_start !== undefined && { work_start: dto.work_start }), ...(dto.work_end !== undefined && { work_end: dto.work_end }),
          ...(dto.work_days !== undefined && { work_days: dto.work_days }), ...(dto.specialties !== undefined && { specialties: dto.specialties }),
          ...(dto.emergency_only !== undefined && { emergency_only: dto.emergency_only }), ...(dto.notes !== undefined && { notes: dto.notes?.trim() || null }),
          ...(dto.is_active !== undefined && { is_active: dto.is_active }), ...(dto.sort_order !== undefined && { sort_order: dto.sort_order }),
        };
        const r = old
          ? await trx.updateTable('or_rooms').set(v).where('id', '=', old.id).returningAll().executeTakeFirstOrThrow()
          : await trx.insertInto('or_rooms').values(v as never).returningAll().executeTakeFirstOrThrow();
        if (r.work_end <= r.work_start) throw new BadRequestException('სამუშაო საათები: დასასრული დაწყებაზე გვიან უნდა იყოს');
        await this.audit.log(ctx, { action: old ? 'OR_ROOM_UPDATE' : 'OR_ROOM_CREATE', entityName: 'or_rooms', entityId: r.id, oldData: old ?? undefined, newData: dto }, trx);
        return r;
      });
    } catch (e) { mapPgError(e, { or_rooms_department_id_code_key: 'ამ კოდით ოთახი ბლოკში უკვე არსებობს' }); }
  }

  // ---------------------------------------------------------------- მარტივი ცნობარები (სპეციალობა, გაუქმების მიზეზი, გუნდის როლი)
  async saveRef(table: 'or_specialties' | 'or_cancel_reasons' | 'or_team_roles', code: string | null, dto: TeamRoleDto, ctx: AuditContext) {
    try {
      return await this.db.transaction().execute(async (trx) => {
        const old = code ? await trx.selectFrom(table).selectAll().where('code', '=', code).forUpdate().executeTakeFirst() : null;
        if (code && !old) throw new NotFoundException('ჩანაწერი ვერ მოიძებნა');
        if (!code && (!dto.code || !dto.name)) throw new BadRequestException('კოდი და დასახელება სავალდებულოა');
        if (old && 'is_system' in old && old.is_system && (dto.is_active === false || (dto.grp && dto.grp !== old.grp) || (dto.capability && dto.capability !== old.capability)))
          throw new BadRequestException('სისტემური როლი: იცვლება მხოლოდ დასახელება და რიგი');
        if (table === 'or_team_roles' && !old && (!dto.grp || !dto.capability)) throw new BadRequestException('როლის ჯგუფი და უფლება სავალდებულოა');
        const v: Record<string, unknown> = {
          ...(dto.name !== undefined && { name: dto.name }), ...(dto.is_active !== undefined && { is_active: dto.is_active }), ...(dto.sort_order !== undefined && { sort_order: dto.sort_order }),
          ...(table === 'or_team_roles' && dto.grp !== undefined && { grp: dto.grp }), ...(table === 'or_team_roles' && dto.capability !== undefined && { capability: dto.capability }),
          ...(table === 'or_team_roles' && dto.multiple !== undefined && { multiple: dto.multiple }),
        };
        const r = old
          ? await trx.updateTable(table).set(v as never).where('code', '=', code!).returningAll().executeTakeFirstOrThrow()
          : await trx.insertInto(table).values({ ...v, code: dto.code } as never).returningAll().executeTakeFirstOrThrow();
        await this.audit.log(ctx, { action: 'OR_REF', entityName: table, entityId: r.code, oldData: old ?? undefined, newData: dto }, trx);
        return r;
      });
    } catch (e) { mapPgError(e, { or_specialties_pkey: 'ეს კოდი უკვე არსებობს', or_cancel_reasons_pkey: 'ეს კოდი უკვე არსებობს', or_team_roles_pkey: 'ეს კოდი უკვე არსებობს' }); }
  }

  async saveReadinessItem(id: string | null, dto: ReadinessItemDto, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const old = id ? await trx.selectFrom('or_readiness_items').selectAll().where('id', '=', id).forUpdate().executeTakeFirst() : null;
      if (id && !old) throw new NotFoundException('პუნქტი ვერ მოიძებნა');
      if (!id && !dto.label) throw new BadRequestException('პუნქტის ტექსტი სავალდებულოა');
      const v = { ...(dto.label !== undefined && { label: dto.label }), ...(dto.applies !== undefined && { applies: dto.applies }),
        ...(dto.is_active !== undefined && { is_active: dto.is_active }), ...(dto.sort_order !== undefined && { sort_order: dto.sort_order }) };
      const r = old ? await trx.updateTable('or_readiness_items').set(v).where('id', '=', old.id).returningAll().executeTakeFirstOrThrow()
        : await trx.insertInto('or_readiness_items').values({ label: dto.label!, applies: dto.applies ?? 'always', source: 'manual', sort_order: dto.sort_order ?? 100 }).returningAll().executeTakeFirstOrThrow();
      await this.audit.log(ctx, { action: 'OR_READINESS_ITEM', entityName: 'or_readiness_items', entityId: r.id, oldData: old ?? undefined, newData: dto }, trx);
      return r;
    });
  }

  async saveWhoItem(id: string | null, dto: WhoItemDto, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const old = id ? await trx.selectFrom('or_who_items').selectAll().where('id', '=', id).forUpdate().executeTakeFirst() : null;
      if (id && !old) throw new NotFoundException('პუნქტი ვერ მოიძებნა');
      if (!id && (!dto.label || !dto.phase)) throw new BadRequestException('ეტაპი და პუნქტის ტექსტი სავალდებულოა');
      const v = { ...(dto.phase !== undefined && { phase: dto.phase }), ...(dto.label !== undefined && { label: dto.label }),
        ...(dto.is_active !== undefined && { is_active: dto.is_active }), ...(dto.sort_order !== undefined && { sort_order: dto.sort_order }) };
      const r = old ? await trx.updateTable('or_who_items').set(v).where('id', '=', old.id).returningAll().executeTakeFirstOrThrow()
        : await trx.insertInto('or_who_items').values({ phase: dto.phase!, label: dto.label!, sort_order: dto.sort_order ?? 100 }).returningAll().executeTakeFirstOrThrow();
      if (r.is_active === false || old?.phase !== r.phase) {
        const left = await trx.selectFrom('or_who_items').select(sql<number>`count(*)::int`.as('n')).where('phase', '=', old?.phase ?? r.phase).where('is_active', '=', true).executeTakeFirstOrThrow();
        if (old && left.n === 0) throw new BadRequestException('ეტაპს მინიმუმ ერთი აქტიური პუნქტი უნდა ჰქონდეს');
      }
      await this.audit.log(ctx, { action: 'OR_WHO_ITEM', entityName: 'or_who_items', entityId: r.id, oldData: old ?? undefined, newData: dto }, trx);
      return r;
    });
  }

  // ---------------------------------------------------------------- პროცედურების კატალოგი
  procedures(q: string | undefined, all: boolean, specialty?: string) {
    let x = this.db.selectFrom('or_procedures as p').leftJoin('or_specialties as s', 's.code', 'p.specialty_code').leftJoin('service_tariffs as t', 't.id', 'p.tariff_id')
      .selectAll('p').select(['s.name as specialty_name', 't.code as tariff_code', 't.title as tariff_title', 't.base_price as tariff_price'])
      .orderBy('p.name').limit(q ? 50 : 1000);
    if (!all) x = x.where('p.is_active', '=', true);
    if (specialty) x = x.where('p.specialty_code', '=', specialty);
    if (q?.trim()) {
      const t = `%${q.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
      x = x.where((eb) => eb.or([eb('p.name', 'ilike', t), eb('p.code', 'ilike', t), eb('p.ncsp_code', 'ilike', t)]));
    }
    return x.execute();
  }

  private async checkProcRefs(dto: ProcedureDto) {
    if (dto.specialty_code) {
      const s = await this.db.selectFrom('or_specialties').select('is_active').where('code', '=', dto.specialty_code).executeTakeFirst();
      if (!s) throw new BadRequestException('სპეციალობა ვერ მოიძებნა');
    }
    if (dto.tariff_id) {
      const t = await this.db.selectFrom('service_tariffs').select('is_active').where('id', '=', dto.tariff_id).executeTakeFirst();
      if (!t?.is_active) throw new BadRequestException('ტარიფი ვერ მოიძებნა ან გათიშულია');
    }
  }

  async saveProcedure(id: string | null, dto: ProcedureDto, ctx: AuditContext) {
    await this.checkProcRefs(dto);
    try {
      return await this.db.transaction().execute(async (trx) => {
        const old = id ? await trx.selectFrom('or_procedures').selectAll().where('id', '=', id).forUpdate().executeTakeFirst() : null;
        if (id && !old) throw new NotFoundException('პროცედურა ვერ მოიძებნა');
        if (!id && (!dto.code || !dto.name)) throw new BadRequestException('კოდი და დასახელება სავალდებულოა');
        const v = {
          ...(dto.code !== undefined && { code: dto.code }), ...(dto.ncsp_code !== undefined && { ncsp_code: dto.ncsp_code || null }), ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.specialty_code !== undefined && { specialty_code: dto.specialty_code || null }), ...(dto.default_duration_min !== undefined && { default_duration_min: dto.default_duration_min }),
          ...(dto.laterality !== undefined && { laterality: dto.laterality }), ...(dto.tariff_id !== undefined && { tariff_id: dto.tariff_id }),
          ...(dto.is_active !== undefined && { is_active: dto.is_active }),
        };
        const r = old ? await trx.updateTable('or_procedures').set(v).where('id', '=', old.id).returningAll().executeTakeFirstOrThrow()
          : await trx.insertInto('or_procedures').values(v as never).returningAll().executeTakeFirstOrThrow();
        await this.audit.log(ctx, { action: old ? 'OR_PROCEDURE_UPDATE' : 'OR_PROCEDURE_CREATE', entityName: 'or_procedures', entityId: r.id, oldData: old ?? undefined, newData: dto }, trx);
        return r;
      });
    } catch (e) { mapPgError(e, { or_procedures_code_key: 'ამ კოდით პროცედურა უკვე არსებობს' }); }
  }

  /**
   * CSV იმპორტი (როგორც DRG): code;name[;duration_min[;specialty[;ncsp[;laterality]]]] — გამყოფი ; ან TAB ან ,; პირველი სტრიქონი შეიძლება სათაური იყოს.
   * არსებული კოდი → განახლდება, ახალი → დაემატება; deactivate_missing → ფაილში არმყოფი გაითიშება. ტარიფი იმპორტით არ იცვლება (კატალოგიდან).
   */
  async importProcedures(dto: ProcedureImportDto, ctx: AuditContext) {
    const lines = dto.csv.replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const sep = [';', '\t', ','].find((s) => lines[0]?.includes(s)) ?? ';';
    const unq = (s: string) => s.trim().replace(/^"(.*)"$/, '$1').replace(/""/g, '"').trim();
    const parse = (l: string) => {
      const out: string[] = []; let cur = ''; let q = false;
      for (const ch of l) { if (ch === '"') { q = !q; cur += ch; } else if (ch === sep && !q) { out.push(unq(cur)); cur = ''; } else cur += ch; }
      out.push(unq(cur)); return out;
    };
    const specs = new Set((await this.db.selectFrom('or_specialties').select('code').execute()).map((s) => s.code));
    const rows: { code: string; name: string; duration: number | null; specialty: string | null; ncsp: string | null; laterality: boolean | null }[] = [];
    const errors: string[] = [];
    const yes = (v: string) => ['1', 'true', 'yes', 'კი', 'y'].includes(v.toLowerCase());
    lines.forEach((l, i) => {
      const c = parse(l);
      const code = c[0] ?? '';
      if (i === 0 && /^(code|კოდი)$/i.test(code)) return;
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,19}$/.test(code)) { errors.push(`სტრ. ${i + 1}: კოდი „${code}“ არასწორია`); return; }
      if (!c[1] || c[1].length < 3) { errors.push(`სტრ. ${i + 1}: დასახელება აკლია`); return; }
      const d = c[2] ? Number(c[2]) : null;
      if (d !== null && (!Number.isInteger(d) || d < 5 || d > 1440)) { errors.push(`სტრ. ${i + 1}: ხანგრძლივობა „${c[2]}“ არასწორია (5–1440 წთ)`); return; }
      const sp = c[3]?.trim() || null;
      if (sp && !specs.has(sp)) { errors.push(`სტრ. ${i + 1}: სპეციალობა „${sp}“ ცნობარში არ არის`); return; }
      const nc = c[4]?.trim().toUpperCase() || null;
      if (nc && !/^[A-Z]{3}[0-9]{2}[A-Z0-9]?$/.test(nc)) { errors.push(`სტრ. ${i + 1}: NCSP კოდი „${c[4]}“ არასწორია`); return; }
      rows.push({ code, name: c[1].slice(0, 300), duration: d, specialty: sp, ncsp: nc, laterality: c[5] ? yes(c[5]) : null });
    });
    const dup = rows.map((r) => r.code).filter((c, i, a) => a.indexOf(c) !== i);
    if (dup.length) errors.push(`გამეორებული კოდები: ${[...new Set(dup)].slice(0, 10).join(', ')}`);
    if (!rows.length && !errors.length) errors.push('ფაილში ჩანაწერი ვერ მოიძებნა');
    const existing = new Map((await this.db.selectFrom('or_procedures').select(['code', 'name', 'is_active', 'default_duration_min', 'specialty_code', 'ncsp_code', 'laterality']).execute()).map((r) => [r.code, r]));
    const added = rows.filter((r) => !existing.has(r.code)).length;
    const changed = rows.filter((r) => { const e = existing.get(r.code); return e && (e.name !== r.name || !e.is_active || (r.duration !== null && e.default_duration_min !== r.duration)
      || (r.specialty !== null && e.specialty_code !== r.specialty) || (r.ncsp !== null && e.ncsp_code !== r.ncsp) || (r.laterality !== null && e.laterality !== r.laterality)); }).length;
    const codes = new Set(rows.map((r) => r.code));
    const missing = [...existing.values()].filter((e) => e.is_active && !codes.has(e.code)).length;
    const summary = { rows: rows.length, added, changed, deactivated: dto.deactivate_missing ? missing : 0, missing, errors: errors.slice(0, 50) };
    if (errors.length || dto.dry_run) return { ...summary, applied: false };
    await this.db.transaction().execute(async (trx) => {
      for (const r of rows) {
        const upd = { name: r.name, is_active: true, ...(r.duration !== null && { default_duration_min: r.duration }), ...(r.specialty !== null && { specialty_code: r.specialty }),
          ...(r.ncsp !== null && { ncsp_code: r.ncsp }), ...(r.laterality !== null && { laterality: r.laterality }) };
        await trx.insertInto('or_procedures').values({ code: r.code, ...upd }).onConflict((oc) => oc.column('code').doUpdateSet(upd)).execute();
      }
      if (dto.deactivate_missing && codes.size) await trx.updateTable('or_procedures').set({ is_active: false }).where('code', 'not in', [...codes]).where('is_active', '=', true).execute();
      await this.audit.log(ctx, { action: 'OR_PROCEDURE_IMPORT', entityName: 'or_procedures', entityId: 'import', newData: summary }, trx);
    });
    return { ...summary, applied: true };
  }
}

@Controller('or')
export class OrAdminController {
  constructor(private readonly s: OrAdminService) {}
  @Get('setup') @Roles(...OR_READ, 'receptionist') setup(@Query('all') all?: string) { return this.s.setup(all === 'true'); }
  @Patch('blocks/:id') @Roles('admin') block(@Param('id', ParseUUIDPipe) id: string, @Body() d: BlockDto, @Req() r: Request) { return this.s.setBlock(id, d, auditCtx(r)); }
  @Post('rooms') @Roles('admin') addRoom(@Body() d: RoomDto, @Req() r: Request) { return this.s.saveRoom(null, d, auditCtx(r)); }
  @Patch('rooms/:id') @Roles('admin') updRoom(@Param('id', ParseUUIDPipe) id: string, @Body() d: RoomDto, @Req() r: Request) { return this.s.saveRoom(id, d, auditCtx(r)); }
  @Post('refs/:kind') @Roles('admin') addRef(@Param('kind') kind: string, @Body() d: TeamRoleDto, @Req() r: Request) { return this.s.saveRef(refTable(kind), null, d, auditCtx(r)); }
  @Patch('refs/:kind/:code') @Roles('admin') updRef(@Param('kind') kind: string, @Param('code') code: string, @Body() d: TeamRoleDto, @Req() r: Request) {
    return this.s.saveRef(refTable(kind), code, d, auditCtx(r));
  }
  @Post('readiness-items') @Roles('admin') addRi(@Body() d: ReadinessItemDto, @Req() r: Request) { return this.s.saveReadinessItem(null, d, auditCtx(r)); }
  @Patch('readiness-items/:id') @Roles('admin') updRi(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReadinessItemDto, @Req() r: Request) { return this.s.saveReadinessItem(id, d, auditCtx(r)); }
  @Post('who-items') @Roles('admin') addWho(@Body() d: WhoItemDto, @Req() r: Request) { return this.s.saveWhoItem(null, d, auditCtx(r)); }
  @Patch('who-items/:id') @Roles('admin') updWho(@Param('id', ParseUUIDPipe) id: string, @Body() d: WhoItemDto, @Req() r: Request) { return this.s.saveWhoItem(id, d, auditCtx(r)); }
  @Get('procedures') @Roles(...OR_READ, 'billing')
  procs(@Query('q') q?: string, @Query('all') all?: string, @Query('specialty') sp?: string) { return this.s.procedures(q, all === 'true', sp || undefined); }
  @Post('procedures') @Roles('admin') addProc(@Body() d: ProcedureDto, @Req() r: Request) { return this.s.saveProcedure(null, d, auditCtx(r)); }
  @Patch('procedures/:id') @Roles('admin') updProc(@Param('id', ParseUUIDPipe) id: string, @Body() d: ProcedureDto, @Req() r: Request) { return this.s.saveProcedure(id, d, auditCtx(r)); }
  @Post('procedures/import') @Roles('admin') importProc(@Body() d: ProcedureImportDto, @Req() r: Request) { return this.s.importProcedures(d, auditCtx(r)); }
}

function refTable(kind: string) {
  const t = ({ specialties: 'or_specialties', 'cancel-reasons': 'or_cancel_reasons', 'team-roles': 'or_team_roles' } as const)[kind as 'specialties'];
  if (!t) throw new BadRequestException('უცნობი ცნობარი');
  return t;
}

@Module({ providers: [OrAdminService], controllers: [OrAdminController], exports: [OrAdminService] })
export class OrAdminModule {}
