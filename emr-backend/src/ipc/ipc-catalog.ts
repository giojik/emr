import { BadRequestException, Body, ConflictException, Controller, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService } from '../audit/audit.service';
import { Roles } from '../auth/decorators';
import { IPC_FULL, IPC_STATUS_READ, IpcCommon, ISO_TYPES, MARKERS } from './ipc-common';

class IsoTypeDto {
  @IsOptional() @IsString() @Length(2, 80) name?: string;
  @IsOptional() @IsString() @Length(2, 12) short_name?: string;
  @IsOptional() @Matches(/^#[0-9A-Fa-f]{6}$/) color?: string;
  @IsOptional() @IsString() @MaxLength(2000) ppe?: string;
  @IsOptional() @IsString() @MaxLength(2000) door_text?: string;
}
class MdroTypeDto {
  @IsOptional() @Matches(/^[a-z][a-z0-9_]{1,15}$/, { message: 'კოდი: ლათინური პატარა ასოები / ციფრები / _, 2–16' }) code?: string;
  @IsOptional() @IsString() @Length(2, 200) name?: string;
  @IsOptional() @IsIn(ISO_TYPES) isolation_type?: string;
  @IsOptional() @IsBoolean() urgent?: boolean;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(30) @Max(3650) expiry_days?: number | null;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(100000) sort_order?: number;
}
class MdroRuleDto {
  @IsOptional() @IsString() @Length(2, 16) mdro_code?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) organism_codes?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) group_codes?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) abx_codes?: string[];
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsIn(MARKERS) marker?: string | null;
  @IsOptional() @IsString() @MaxLength(300) note?: string | null;
  @IsOptional() @IsBoolean() is_active?: boolean;
}

/** ცნობარები (0067): იზოლაციის ტიპები (ტექსტები), MDRO ტიპები, ამოცნობის წესები. კითხვა — ყველა კლინიკური; ცვლილება — infection */
@Injectable()
export class IpcCatalogService {
  constructor(private readonly c: IpcCommon, private readonly audit: AuditService) {}
  private get db() { return this.c.db; }

  async all() {
    const [isolation_types, mdro_types, rules, organisms, groups, antibiotics] = await Promise.all([
      this.db.selectFrom('ipc_isolation_types').selectAll().orderBy('sort_order').execute(),
      this.db.selectFrom('ipc_mdro_types as t').selectAll('t')
        .select(sql<number>`(SELECT count(*)::int FROM ipc_patient_flags f WHERE f.mdro_code = t.code AND f.status = 'active')`.as('active_flags'))
        .orderBy('t.sort_order').orderBy('t.code').execute(),
      this.db.selectFrom('ipc_mdro_rules').selectAll().orderBy('mdro_code').orderBy('created_at').execute(),
      this.db.selectFrom('micro_organisms').select(['code', 'name', 'group_code']).where('is_active', '=', true).orderBy('name').execute(),
      this.db.selectFrom('micro_organisms').select('group_code').distinct().orderBy('group_code').execute(),
      this.db.selectFrom('micro_antibiotics').select(['code', 'name', 'class']).where('is_active', '=', true).orderBy('name').execute(),
    ]);
    return { isolation_types, mdro_types, rules, markers: MARKERS, organisms, groups: groups.map((g) => g.group_code), antibiotics };
  }

  async updateIsoType(code: string, d: IsoTypeDto, req: Request) {
    await this.c.rules();
    const old = await this.db.selectFrom('ipc_isolation_types').selectAll().where('code', '=', code).executeTakeFirst();
    if (!old) throw new NotFoundException('ტიპი ვერ მოიძებნა');
    const vals = Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));
    if (!Object.keys(vals).length) throw new BadRequestException({ code: 'NO_CHANGE', message: 'ცვლილება არ არის' });
    const row = await this.db.updateTable('ipc_isolation_types').set(vals).where('code', '=', code).returningAll().executeTakeFirstOrThrow();
    await this.audit.log(auditCtx(req), { action: 'IPC_ISO_TYPE_UPDATE', entityName: 'ipc_isolation_types', entityId: code, oldData: old, newData: vals });
    return row;
  }

  async saveMdroType(code: string | null, d: MdroTypeDto, req: Request) {
    await this.c.rules();
    if (!code) {
      if (!d.code || !d.name || !d.isolation_type) throw new BadRequestException('code, name და isolation_type სავალდებულოა');
      const dup = await this.db.selectFrom('ipc_mdro_types').select('code').where('code', '=', d.code).executeTakeFirst();
      if (dup) throw new ConflictException({ code: 'CODE_EXISTS', message: 'ასეთი კოდი უკვე არსებობს' });
      const row = await this.db.insertInto('ipc_mdro_types').values({ code: d.code, name: d.name.trim(), isolation_type: d.isolation_type, urgent: !!d.urgent,
        expiry_days: d.expiry_days ?? null, sort_order: d.sort_order ?? 100 }).returningAll().executeTakeFirstOrThrow();
      await this.audit.log(auditCtx(req), { action: 'IPC_MDRO_TYPE_CREATE', entityName: 'ipc_mdro_types', entityId: row.code, newData: d });
      return row;
    }
    const old = await this.db.selectFrom('ipc_mdro_types').selectAll().where('code', '=', code).executeTakeFirst();
    if (!old) throw new NotFoundException('MDRO ტიპი ვერ მოიძებნა');
    const { code: _ignore, ...rest } = d; void _ignore;
    const vals = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));
    if (!Object.keys(vals).length) throw new BadRequestException({ code: 'NO_CHANGE', message: 'ცვლილება არ არის' });
    const row = await this.db.updateTable('ipc_mdro_types').set(vals).where('code', '=', code).returningAll().executeTakeFirstOrThrow();
    await this.audit.log(auditCtx(req), { action: 'IPC_MDRO_TYPE_UPDATE', entityName: 'ipc_mdro_types', entityId: code, oldData: old, newData: vals });
    return row;
  }

  /** კოდების შემოწმება ცნობარის მიხედვით (მიკრობიოლოგია) */
  private async checkCodes(d: { organism_codes: string[]; group_codes: string[]; abx_codes: string[] }) {
    const bad: string[] = [];
    if (d.organism_codes.length) {
      const r = await this.db.selectFrom('micro_organisms').select(sql<string>`lower(code)`.as('c')).where(sql`lower(code)`, 'in', d.organism_codes).execute();
      bad.push(...d.organism_codes.filter((x) => !r.some((y) => y.c === x)));
    }
    if (d.group_codes.length) {
      const r = await this.db.selectFrom('micro_organisms').select(sql<string>`upper(group_code)`.as('c')).distinct().where(sql`upper(group_code)`, 'in', d.group_codes).execute();
      bad.push(...d.group_codes.filter((x) => !r.some((y) => y.c === x)));
    }
    if (d.abx_codes.length) {
      const r = await this.db.selectFrom('micro_antibiotics').select(sql<string>`upper(code)`.as('c')).where(sql`upper(code)`, 'in', d.abx_codes).execute();
      bad.push(...d.abx_codes.filter((x) => !r.some((y) => y.c === x)));
    }
    if (bad.length) throw new BadRequestException({ code: 'UNKNOWN_CODE', message: `უცნობი კოდ(ებ)ი: ${bad.join(', ')}` });
  }

  async saveRule(id: string | null, d: MdroRuleDto, req: Request) {
    await this.c.rules();
    const old = id ? await this.db.selectFrom('ipc_mdro_rules').selectAll().where('id', '=', id).executeTakeFirst() : undefined;
    if (id && !old) throw new NotFoundException('წესი ვერ მოიძებნა');
    const norm = {
      mdro_code: d.mdro_code ?? old?.mdro_code,
      organism_codes: (d.organism_codes ?? old?.organism_codes ?? []).map((x) => x.trim().toLowerCase()).filter(Boolean),
      group_codes: (d.group_codes ?? old?.group_codes ?? []).map((x) => x.trim().toUpperCase()).filter(Boolean),
      abx_codes: (d.abx_codes ?? old?.abx_codes ?? []).map((x) => x.trim().toUpperCase()).filter(Boolean),
      marker: d.marker !== undefined ? d.marker : old?.marker ?? null,
      note: d.note !== undefined ? d.note?.trim() || null : old?.note ?? null,
      is_active: d.is_active ?? old?.is_active ?? true,
    };
    if (!norm.mdro_code) throw new BadRequestException('mdro_code სავალდებულოა');
    const t = await this.db.selectFrom('ipc_mdro_types').select('code').where('code', '=', norm.mdro_code).executeTakeFirst();
    if (!t) throw new BadRequestException({ code: 'MDRO_TYPE', message: 'MDRO ტიპი ვერ მოიძებნა' });
    if (!norm.organism_codes.length && !norm.group_codes.length) throw new BadRequestException({ code: 'RULE_TARGET', message: 'მიუთითეთ მიკროორგანიზმი ან ჯგუფი' });
    if (!norm.abx_codes.length && !norm.marker && !norm.organism_codes.length) throw new BadRequestException({ code: 'RULE_COND', message: 'ჯგუფზე საჭიროა პირობა — R ანტიბიოტიკი ან მარკერი' });
    await this.checkCodes(norm);
    const row = id
      ? await this.db.updateTable('ipc_mdro_rules').set(norm).where('id', '=', id).returningAll().executeTakeFirstOrThrow()
      : await this.db.insertInto('ipc_mdro_rules').values(norm as typeof norm & { mdro_code: string }).returningAll().executeTakeFirstOrThrow();
    await this.audit.log(auditCtx(req), { action: id ? 'IPC_RULE_UPDATE' : 'IPC_RULE_CREATE', entityName: 'ipc_mdro_rules', entityId: row.id, oldData: old, newData: norm });
    return row;
  }
}

@Controller('ipc')
export class IpcCatalogController {
  constructor(private readonly s: IpcCatalogService) {}
  @Get('catalog') @Roles(...IPC_STATUS_READ, 'infection_view') all() { return this.s.all(); }
  @Patch('isolation-types/:code') @Roles(...IPC_FULL) isoType(@Param('code') code: string, @Body() d: IsoTypeDto, @Req() r: Request) { return this.s.updateIsoType(code, d, r); }
  @Post('mdro-types') @Roles(...IPC_FULL) addType(@Body() d: MdroTypeDto, @Req() r: Request) { return this.s.saveMdroType(null, d, r); }
  @Patch('mdro-types/:code') @Roles(...IPC_FULL) updType(@Param('code') code: string, @Body() d: MdroTypeDto, @Req() r: Request) { return this.s.saveMdroType(code, d, r); }
  @Post('mdro-rules') @Roles(...IPC_FULL) addRule(@Body() d: MdroRuleDto, @Req() r: Request) { return this.s.saveRule(null, d, r); }
  @Patch('mdro-rules/:id') @Roles(...IPC_FULL) updRule(@Param('id', ParseUUIDPipe) id: string, @Body() d: MdroRuleDto, @Req() r: Request) { return this.s.saveRule(id, d, r); }
}
