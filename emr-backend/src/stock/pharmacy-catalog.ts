import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min } from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser } from '../auth/roles';
import { mapPgError } from '../common/pg-errors';
import { InjectDb, type Database } from '../database/database.module';
import { clean, STOCK_READ } from './stock-catalog';

const ATC = /^[A-Z]([0-9]{2}([A-Z]([A-Z]([0-9]{2})?)?)?)?$/;
/** კლინიკური ველები — ცვლის მხოლოდ ფარმაცევტი / ადმინისტრატორი */
const CLINICAL = ['controlled_class', 'high_alert', 'reserve_antibiotic', 'patient_only', 'routes', 'dose_unit', 'dose_per_unit', 'max_single_dose', 'max_daily_dose',
  'ped_max_single_per_kg', 'ped_max_daily_per_kg', 'min_age_days', 'allergen_groups'] as const;
const ADULT_DAYS = 18 * 365;
const SEVERITY_ORDER: Record<string, number> = { contraindicated: 0, major: 1, moderate: 2, minor: 3, duplicate: 4 };
const PG_MSG = { ux_med_generics_active: 'ასეთი ჯენერიკი (INN + ფორმა + დოზა) უკვე არსებობს', ux_med_interactions_pair: 'ამ წყვილის ურთიერთქმედება უკვე ჩაწერილია',
  med_generics_check: 'დღიური მაქსიმუმი ერთჯერადზე ნაკლები ვერ იქნება', med_generics_check1: 'დოზის ზღვრებს სჭირდება დოზის ერთეული', med_generic_allergens_group_code_fkey: 'უცნობი ალერგენული ჯგუფი' };

interface G { id: string; inn: string; strength: string | null; atc_code: string | null; form_name: string }
const gName = (g: Pick<G, 'inn' | 'strength' | 'form_name'>) => `${g.inn}${g.strength ? ` ${g.strength}` : ''} — ${g.form_name}`;
interface Side { generic_id: string | null; atc: string | null }
const matches = (s: Side, g: G) => s.generic_id === g.id || (!!s.atc && !!g.atc_code && g.atc_code.startsWith(s.atc));

@Injectable()
export class PharmacyCatalogService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService) {}

  // ---------------------------------------------------------------- ჯენერიკები
  private base() {
    return this.db.selectFrom('med_generics as g').innerJoin('med_dosage_forms as f', 'f.code', 'g.form_code').selectAll('g').select(['f.name as form_name',
      sql<string[]>`coalesce((SELECT array_agg(a.group_code ORDER BY a.group_code) FROM med_generic_allergens a WHERE a.generic_id = g.id), '{}')`.as('allergen_groups'),
      sql<number>`(SELECT count(*)::int FROM stock_items i WHERE i.generic_id = g.id AND i.is_active)`.as('items')]);
  }
  generics(q: { search?: string; all?: boolean; controlled?: boolean; limit?: number }) {
    let x = this.base();
    if (!q.all) x = x.where('g.is_active', '=', true);
    if (q.controlled) x = x.where('g.controlled_class', 'is not', null);
    const s = q.search?.trim();
    if (s) { const like = `%${s.toLowerCase()}%`; x = x.where((eb) => eb.or([eb(sql`lower(g.inn)`, 'like', like), eb(sql`lower(coalesce(g.inn_latin, ''))`, 'like', like), eb('g.atc_code', 'like', `${s.toUpperCase()}%`)])); }
    return x.orderBy('g.is_active', 'desc').orderBy('g.inn').orderBy('g.form_code').orderBy('g.strength').limit(Math.min(q.limit ?? 300, 1000)).execute();
  }
  async generic(id: string) {
    const g = await this.base().where('g.id', '=', id).executeTakeFirst();
    if (!g) throw new NotFoundException('ჯენერიკი ვერ მოიძებნა');
    const items = await this.db.selectFrom('stock_items').select(['id', 'code', 'name', 'manufacturer', 'is_active']).where('generic_id', '=', id).orderBy('name').execute();
    return { ...g, display: gName(g), stock_items: items };
  }
  private async validate(dto: GenericDto) {
    if (dto.routes?.length) {
      const ok = await this.db.selectFrom('med_routes').select('code').where('code', 'in', dto.routes).execute();
      const bad = dto.routes.filter((r) => !ok.some((o) => o.code === r));
      if (bad.length) throw new BadRequestException(`უცნობი შეყვანის გზა: ${bad.join(', ')}`);
    }
  }
  async saveGeneric(id: string | null, dto: GenericDto, u: AuthUser, ctx: AuditContext) {
    const set = (v: unknown) => v !== undefined && v !== null && v !== false && !(Array.isArray(v) && !v.length);
    if (!has(u, 'admin', 'pharmacist') && CLINICAL.some((k) => (id ? dto[k] !== undefined : set(dto[k]))))
      throw new ForbiddenException('კლინიკურ ველებს (კონტროლის კლასი, დოზის ზღვრები, ალერგენები, გზები, დროშები) ცვლის ფარმაცევტი');
    await this.validate(dto);
    const { allergen_groups, ...rest } = dto;
    const vals = clean(rest);
    if (typeof vals.atc_code === 'string') vals.atc_code = vals.atc_code.toUpperCase();
    try {
      const gid = await this.db.transaction().execute(async (trx) => {
        const old = id ? await trx.selectFrom('med_generics').selectAll().where('id', '=', id).forUpdate().executeTakeFirst() : undefined;
        if (id && !old) throw new NotFoundException('ჯენერიკი ვერ მოიძებნა');
        let gid = id;
        if (id) { if (Object.keys(vals).length) await trx.updateTable('med_generics').set(vals).where('id', '=', id).execute(); }
        else gid = (await trx.insertInto('med_generics').values({ ...(vals as { inn: string; form_code: string }), created_by: u.id }).returning('id').executeTakeFirstOrThrow()).id;
        if (allergen_groups !== undefined) {
          await trx.deleteFrom('med_generic_allergens').where('generic_id', '=', gid!).execute();
          if (allergen_groups.length) await trx.insertInto('med_generic_allergens').values([...new Set(allergen_groups)].map((c) => ({ generic_id: gid!, group_code: c }))).execute();
        }
        if (id && dto.is_active === false) {
          const n = await trx.selectFrom('stock_items').select(sql<number>`count(*)::int`.as('n')).where('generic_id', '=', id).where('is_active', '=', true).executeTakeFirstOrThrow();
          if (n.n) throw new BadRequestException(`ჯენერიკს ${n.n} აქტიური საქონელი აქვს — ჯერ ისინი გათიშეთ ან სხვა ჯენერიკზე გადაიტანეთ`);
        }
        await this.audit.log(ctx, { action: id ? 'UPDATE_MED_GENERIC' : 'CREATE_MED_GENERIC', entityName: 'med_generics', entityId: gid!, oldData: old, newData: dto }, trx);
        return gid!;
      });
      return this.generic(gid);
    } catch (e) { mapPgError(e, PG_MSG); }
  }

  // ---------------------------------------------------------------- ურთიერთქმედებები
  async interactions(genericId?: string, all = false) {
    let q = this.db.selectFrom('med_interactions as x')
      .leftJoin('med_generics as ga', 'ga.id', 'x.a_generic_id').leftJoin('med_dosage_forms as fa', 'fa.code', 'ga.form_code')
      .leftJoin('med_generics as gb', 'gb.id', 'x.b_generic_id').leftJoin('med_dosage_forms as fb', 'fb.code', 'gb.form_code')
      .selectAll('x').select(['ga.inn as a_inn', 'ga.strength as a_strength', 'fa.name as a_form', 'gb.inn as b_inn', 'gb.strength as b_strength', 'fb.name as b_form'])
      .orderBy(sql`CASE x.severity WHEN 'contraindicated' THEN 0 WHEN 'major' THEN 1 WHEN 'moderate' THEN 2 ELSE 3 END`).orderBy('x.created_at', 'desc');
    if (!all) q = q.where('x.is_active', '=', true);
    if (genericId) {
      const g = await this.db.selectFrom('med_generics').select(['id', 'atc_code']).where('id', '=', genericId).executeTakeFirst();
      if (!g) throw new NotFoundException('ჯენერიკი ვერ მოიძებნა');
      const atc = g.atc_code ?? '';
      q = q.where((eb) => eb.or([eb('x.a_generic_id', '=', g.id), eb('x.b_generic_id', '=', g.id),
        ...(atc ? [eb(sql.val(atc), 'like', sql<string>`x.a_atc || '%'`), eb(sql.val(atc), 'like', sql<string>`x.b_atc || '%'`)] : [])]));
    }
    const rows = await q.limit(1000).execute();
    return rows.map((r) => ({ ...r, a_label: r.a_inn ? gName({ inn: r.a_inn, strength: r.a_strength, form_name: r.a_form ?? '' }) : `ATC ${r.a_atc}`,
      b_label: r.b_inn ? gName({ inn: r.b_inn, strength: r.b_strength, form_name: r.b_form ?? '' }) : `ATC ${r.b_atc}` }));
  }
  async saveInteraction(id: string | null, dto: InteractionDto, u: AuthUser, ctx: AuditContext) {
    const side = (g?: string | null, a?: string | null) => (g === undefined && a === undefined ? undefined : { generic: g ?? null, atc: a ? a.toUpperCase() : null });
    const A = side(dto.a_generic_id, dto.a_atc); const B = side(dto.b_generic_id, dto.b_atc);
    for (const s of [A, B]) if (s && (!s.generic === !s.atc)) throw new BadRequestException('თითო მხარეს — ან ჯენერიკი, ან ATC ჯგუფი');
    for (const s of [A, B]) if (s?.atc && !ATC.test(s.atc)) throw new BadRequestException(`ATC „${s.atc}“ არასწორია`);
    if (A && B && ((A.generic && A.generic === B.generic) || (A.atc && A.atc === B.atc))) throw new BadRequestException('ორივე მხარე ერთი და იგივეა');
    const vals = { ...clean({ severity: dto.severity, effect: dto.effect, recommendation: dto.recommendation, source: dto.source, source_ref: dto.source_ref, is_active: dto.is_active }),
      ...(A && { a_generic_id: A.generic, a_atc: A.atc }), ...(B && { b_generic_id: B.generic, b_atc: B.atc }) };
    try {
      const r = id ? await this.db.updateTable('med_interactions').set(vals).where('id', '=', id).returning('id').executeTakeFirst()
        : await this.db.insertInto('med_interactions').values({ ...(vals as { severity: string; effect: string }), created_by: u.id }).returning('id').executeTakeFirst();
      if (!r) throw new NotFoundException('ჩანაწერი ვერ მოიძებნა');
      await this.audit.log(ctx, { action: id ? 'UPDATE_MED_INTERACTION' : 'CREATE_MED_INTERACTION', entityName: 'med_interactions', entityId: r.id, newData: vals });
      return (await this.interactions(undefined, true)).find((x) => x.id === r.id);
    } catch (e) { mapPgError(e, PG_MSG); }
  }

  /** ჯენერიკების სიის შემოწმება: ურთიერთქმედებები (ჯენერიკი / ATC-ჯგუფი) + თერაპიის დუბლირება (ერთი ATC-5) */
  async check(ids: string[]) {
    const gs = await this.db.selectFrom('med_generics as g').innerJoin('med_dosage_forms as f', 'f.code', 'g.form_code').select(['g.id', 'g.inn', 'g.strength', 'g.atc_code', 'f.name as form_name'])
      .where('g.id', 'in', [...new Set(ids)]).execute();
    if (gs.length !== new Set(ids).size) throw new BadRequestException('ზოგიერთი ჯენერიკი ვერ მოიძებნა');
    const rules = await this.db.selectFrom('med_interactions').select(['id', 'a_generic_id', 'a_atc', 'b_generic_id', 'b_atc', 'severity', 'effect', 'recommendation', 'source', 'source_ref'])
      .where('is_active', '=', true).execute();
    const out: { a: string; b: string; a_id: string; b_id: string; severity: string; effect: string; recommendation: string | null; source: string; interaction_id: string | null }[] = [];
    for (let i = 0; i < gs.length; i++) for (let j = i + 1; j < gs.length; j++) {
      const [x, y] = [gs[i], gs[j]];
      for (const r of rules) {
        const A = { generic_id: r.a_generic_id, atc: r.a_atc }; const B = { generic_id: r.b_generic_id, atc: r.b_atc };
        if ((matches(A, x) && matches(B, y)) || (matches(A, y) && matches(B, x)))
          out.push({ a: gName(x), b: gName(y), a_id: x.id, b_id: y.id, severity: r.severity, effect: r.effect, recommendation: r.recommendation, source: r.source, interaction_id: r.id });
      }
      if (x.atc_code && x.atc_code.length === 7 && x.atc_code === y.atc_code)
        out.push({ a: gName(x), b: gName(y), a_id: x.id, b_id: y.id, severity: 'duplicate', effect: `თერაპიის დუბლირება — ერთი აქტიური ნივთიერება (ATC ${x.atc_code})`, recommendation: null, source: 'local', interaction_id: null });
    }
    return out.sort((p, q) => SEVERITY_ORDER[p.severity] - SEVERITY_ORDER[q.severity]);
  }

  /** დოზის შემოწმება ჯენერიკის ზღვრებით: dose — ერთჯერადი (ჯენერიკის dose_unit-ში) */
  async doseCheck(dto: DoseDto) {
    const g = await this.db.selectFrom('med_generics').selectAll().where('id', '=', dto.generic_id).executeTakeFirst();
    if (!g) throw new NotFoundException('ჯენერიკი ვერ მოიძებნა');
    const w: { code: string; level: 'block' | 'warn' | 'info'; message: string }[] = [];
    const u = g.dose_unit ?? '';
    const daily = dto.dose * dto.doses_per_day;
    const child = dto.age_days !== undefined && dto.age_days < ADULT_DAYS;
    if (g.min_age_days !== null && dto.age_days !== undefined && dto.age_days < g.min_age_days)
      w.push({ code: 'min_age', level: 'block', message: `ასაკობრივი შეზღუდვა: დაშვებულია ${g.min_age_days} დღიდან (${Math.floor(g.min_age_days / 365)} წ.)` });
    if (!g.dose_unit) return { unit: null, daily, warnings: [...w, { code: 'no_limits', level: 'info' as const, message: 'დოზის ზღვრები ჯენერიკზე არ არის შევსებული' }] };
    const n = (v: string | null) => (v === null ? null : Number(v));
    const [ms, md, pks, pkd] = [n(g.max_single_dose), n(g.max_daily_dose), n(g.ped_max_single_per_kg), n(g.ped_max_daily_per_kg)];
    if (ms !== null && dto.dose > ms) w.push({ code: 'max_single', level: 'warn', message: `ერთჯერადი დოზა ${dto.dose} ${u} > მაქსიმალური ${ms} ${u}` });
    if (md !== null && daily > md) w.push({ code: 'max_daily', level: 'warn', message: `დღიური დოზა ${daily} ${u} > მაქსიმალური ${md} ${u}` });
    if (child) {
      if ((pks !== null || pkd !== null) && !dto.weight_kg) w.push({ code: 'weight_required', level: 'warn', message: 'ბავშვთა დოზის შესამოწმებლად საჭიროა წონა' });
      if (dto.weight_kg) {
        const r = (x: number) => Math.round(x * 100) / 100;
        if (pks !== null && dto.dose / dto.weight_kg > pks) w.push({ code: 'ped_single', level: 'warn', message: `ერთჯერადი ${r(dto.dose / dto.weight_kg)} ${u}/კგ > ${pks} ${u}/კგ (მაქს. ${r(pks * dto.weight_kg)} ${u})` });
        if (pkd !== null && daily / dto.weight_kg > pkd) w.push({ code: 'ped_daily', level: 'warn', message: `დღიური ${r(daily / dto.weight_kg)} ${u}/კგ > ${pkd} ${u}/კგ (მაქს. ${r(pkd * dto.weight_kg)} ${u})` });
      }
    }
    const per = g.dose_per_unit ? Number(g.dose_per_unit) : null;
    return { unit: u, daily, units_per_dose: per ? Math.round((dto.dose / per) * 1000) / 1000 : null, warnings: w };
  }
}

// ======================================================================= DTO
export class GenericDto {
  @IsOptional() @IsString() @Length(2, 200) inn?: string; @IsOptional() @IsString() @MaxLength(200) inn_latin?: string | null;
  @IsOptional() @Matches(ATC, { message: 'ATC: მაგ. J01DD04 (ან ჯგუფი J01DD)' }) atc_code?: string | null;
  @IsOptional() @IsString() @Length(1, 20) form_code?: string; @IsOptional() @IsString() @MaxLength(100) strength?: string | null;
  @IsOptional() @IsIn(['mg', 'mcg', 'g', 'IU', 'ml', 'mmol', 'mEq']) dose_unit?: string | null; @IsOptional() @IsNumber() @Min(0.0001) dose_per_unit?: number | null;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) routes?: string[];
  @IsOptional() @IsIn(['narcotic', 'psychotropic', 'precursor', 'potent']) controlled_class?: string | null;
  @IsOptional() @IsBoolean() high_alert?: boolean; @IsOptional() @IsBoolean() reserve_antibiotic?: boolean; @IsOptional() @IsBoolean() patient_only?: boolean;
  @IsOptional() @IsNumber() @Min(0.0001) max_single_dose?: number | null; @IsOptional() @IsNumber() @Min(0.0001) max_daily_dose?: number | null;
  @IsOptional() @IsNumber() @Min(0.0001) ped_max_single_per_kg?: number | null; @IsOptional() @IsNumber() @Min(0.0001) ped_max_daily_per_kg?: number | null;
  @IsOptional() @IsInt() @Min(0) @Max(40_000) min_age_days?: number | null;
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) allergen_groups?: string[];
  @IsOptional() @IsString() @MaxLength(2000) notes?: string | null; @IsOptional() @IsBoolean() is_active?: boolean;
}
class InteractionDto {
  @IsOptional() @IsUUID() a_generic_id?: string | null; @IsOptional() @IsString() a_atc?: string | null;
  @IsOptional() @IsUUID() b_generic_id?: string | null; @IsOptional() @IsString() b_atc?: string | null;
  @IsOptional() @IsIn(['contraindicated', 'major', 'moderate', 'minor']) severity?: string;
  @IsOptional() @IsString() @Length(3, 2000) effect?: string; @IsOptional() @IsString() @MaxLength(2000) recommendation?: string | null;
  @IsOptional() @IsIn(['local', 'external']) source?: string; @IsOptional() @IsString() @MaxLength(300) source_ref?: string | null; @IsOptional() @IsBoolean() is_active?: boolean;
}
class CheckDto { @IsArray() @ArrayMinSize(2) @ArrayMaxSize(50) @IsUUID('all', { each: true }) generic_ids: string[] }
class DoseDto {
  @IsUUID() generic_id: string; @IsNumber() @Min(0.0001) dose: number; @IsInt() @Min(1) @Max(48) doses_per_day: number;
  @IsOptional() @IsNumber() @Min(0.2) @Max(400) weight_kg?: number; @IsOptional() @IsInt() @Min(0) @Max(45_000) age_days?: number;
}
const bool = (v?: string) => v === 'true' || v === '1';

@Controller('pharmacy')
export class PharmacyCatalogController {
  constructor(private readonly s: PharmacyCatalogService) {}
  @Get('generics') @Roles(...STOCK_READ) list(@Query('search') search?: string, @Query('all') all?: string, @Query('controlled') controlled?: string) {
    return this.s.generics({ search, all: bool(all), controlled: bool(controlled) });
  }
  @Get('generics/:id') @Roles(...STOCK_READ) one(@Param('id', ParseUUIDPipe) id: string) { return this.s.generic(id); }
  @Post('generics') @Roles('admin', 'pharmacist', 'stock_manager') create(@Body() d: GenericDto, @CurrentUser() u: AuthUser, @Req() r: Request) {
    if (!d.inn || !d.form_code) throw new BadRequestException('INN და ფორმა სავალდებულოა'); return this.s.saveGeneric(null, d, u, auditCtx(r));
  }
  @Patch('generics/:id') @Roles('admin', 'pharmacist', 'stock_manager') update(@Param('id', ParseUUIDPipe) id: string, @Body() d: GenericDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.saveGeneric(id, d, u, auditCtx(r)); }
  @Get('interactions') @Roles(...STOCK_READ) interactions(@Query('generic_id') g?: string, @Query('all') all?: string) {
    if (g && !/^[0-9a-f-]{36}$/i.test(g)) throw new BadRequestException('არასწორი id'); return this.s.interactions(g, bool(all));
  }
  @Post('interactions') @Roles('admin', 'pharmacist') createInteraction(@Body() d: InteractionDto, @CurrentUser() u: AuthUser, @Req() r: Request) {
    if (!d.severity || !d.effect) throw new BadRequestException('სიმძიმე და ეფექტი სავალდებულოა');
    if ((d.a_generic_id ?? d.a_atc) == null || (d.b_generic_id ?? d.b_atc) == null) throw new BadRequestException('ორივე მხარე სავალდებულოა');
    return this.s.saveInteraction(null, d, u, auditCtx(r));
  }
  @Patch('interactions/:id') @Roles('admin', 'pharmacist') updateInteraction(@Param('id', ParseUUIDPipe) id: string, @Body() d: InteractionDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.saveInteraction(id, d, u, auditCtx(r)); }
  @Post('interactions/check') @HttpCode(200) @Roles(...STOCK_READ) check(@Body() d: CheckDto) { return this.s.check(d.generic_ids); }
  @Post('dose-check') @HttpCode(200) @Roles(...STOCK_READ) dose(@Body() d: DoseDto) { return this.s.doseCheck(d); }
}
