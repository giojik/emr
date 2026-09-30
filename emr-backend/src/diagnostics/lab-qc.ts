import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsISO8601, IsNumber, IsOptional, IsString, IsUUID, Length, MaxLength, Min, ValidateNested } from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { auditCtx } from '../audit/audit-context';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser } from '../auth/roles';
import { InjectDb, type Database } from '../database/database.module';
import { LabConfigService } from './lab-config.service';
import { ALL_RULES, evaluate, RULE_KA } from './qc-rules';
import { loadEnv } from '../config/env';
const TZ = loadEnv().CLINIC_TZ;   // კლინიკის დღის საზღვრები

const LAB_ALL = ['admin', 'lab_doctor', 'lab_manager', 'diagnostic'] as const;

/** ლაბორატორიის ხარისხის კონტროლი: მასალები, სამიზნეები, წესები, შედეგები, Levey-Jennings, დარღვევები, პაციენტის შედეგების დაბლოკვა */
@Injectable()
export class LabQcService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService, private readonly cfg: LabConfigService) {}

  private async requireHead(u: AuthUser) { if (!(await this.cfg.isLabHead(u))) throw new ForbiddenException('QC-ის წესებს აკონფიგურირებს ლაბორატორიის ხელმძღვანელი'); }
  private requireManage(u: AuthUser) { if (!has(u, 'admin') && !has(u, 'lab_doctor') && !has(u, 'lab_manager')) throw new ForbiddenException('QC მასალებს მართავს ლაბ. ექიმი / მენეჯერი'); }

  // ---------------------------------------------------------------- მასალები და სამიზნეები
  materials(all: boolean) {
    let q = this.db.selectFrom('lab_qc_materials as m').selectAll('m')
      .select((eb) => eb.selectFrom('lab_qc_targets as t').select((e) => e.fn.countAll<number>().as('n')).whereRef('t.material_id', '=', 'm.id').where('t.is_active', '=', true).as('targets'))
      .orderBy('m.is_active', 'desc').orderBy('m.name').orderBy('m.level');
    if (!all) q = q.where('m.is_active', '=', true);
    return q.execute();
  }
  async saveMaterial(id: string | null, dto: { name?: string; manufacturer?: string | null; level?: string; lot?: string; expires_on?: string | null; barcode?: string | null; is_active?: boolean }, u: AuthUser, ctx: AuditContext) {
    this.requireManage(u);
    const vals = Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined).map(([k, v]) => [k, typeof v === 'string' ? v.trim() || null : v]));
    try {
      const r = id ? await this.db.updateTable('lab_qc_materials').set(vals).where('id', '=', id).returningAll().executeTakeFirst()
        : await this.db.insertInto('lab_qc_materials').values({ name: dto.name!.trim(), level: dto.level!.trim(), lot: dto.lot!.trim(), ...vals }).returningAll().executeTakeFirst();
      if (!r) throw new NotFoundException('მასალა ვერ მოიძებნა');
      await this.audit.log(ctx, { action: id ? 'UPDATE_QC_MATERIAL' : 'CREATE_QC_MATERIAL', entityName: 'lab_qc_materials', entityId: r.id, newData: vals });
      return r;
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new ConflictException('ეს შტრიხკოდი სხვა აქტიურ მასალას აქვს');
      if ((e as { code?: string }).code === '23502') throw new BadRequestException('მიუთითეთ დასახელება, დონე და ლოტი');
      throw e;
    }
  }
  targets(materialId: string) {
    return this.db.selectFrom('lab_qc_targets as t').innerJoin('lab_analytes as a', 'a.id', 't.analyte_id').innerJoin('lab_methods as m', 'm.id', 't.method_id')
      .select(['t.id', 't.analyte_id', 't.method_id', 't.mean', 't.sd', 't.is_active', 'a.name as analyte_name', 'a.code as analyte_code', 'a.unit', 'm.name as method_name'])
      .where('t.material_id', '=', materialId).where('t.is_active', '=', true).orderBy('m.name').orderBy('a.name').execute();
  }
  /** სამიზნეების სია — სრულად; ძველი (შედეგებიანი) ითიშება, არა იშლება */
  async setTargets(materialId: string, list: { analyte_id: string; method_id: string; mean: number; sd: number }[], u: AuthUser, ctx: AuditContext) {
    this.requireManage(u);
    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable('lab_qc_targets').set({ is_active: false }).where('material_id', '=', materialId).execute();
      for (const t of list) {
        if (!(t.sd > 0)) throw new BadRequestException('SD > 0');
        await trx.insertInto('lab_qc_targets').values({ material_id: materialId, analyte_id: t.analyte_id, method_id: t.method_id, mean: String(t.mean), sd: String(t.sd), is_active: true })
          .onConflict((oc) => oc.columns(['material_id', 'analyte_id', 'method_id']).doUpdateSet({ mean: String(t.mean), sd: String(t.sd), is_active: true })).execute();
      }
      await this.audit.log(ctx, { action: 'SET_QC_TARGETS', entityName: 'lab_qc_materials', entityId: materialId, newData: list }, trx);
    });
    return this.targets(materialId);
  }

  // ---------------------------------------------------------------- წესები (კომპონენტის მიხედვით)
  async rulesFor(analyteId: string) {
    const r = await this.db.selectFrom('lab_qc_rules').select(['rules', 'action']).where('analyte_id', '=', analyteId).executeTakeFirst();
    return r ?? { rules: [...ALL_RULES] as string[], action: 'block' as const };
  }
  async rulesList() {
    const rows = await this.db.selectFrom('lab_qc_targets as t').innerJoin('lab_analytes as a', 'a.id', 't.analyte_id').innerJoin('dx_services as s', 's.id', 'a.service_id')
      .leftJoin('lab_qc_rules as r', 'r.analyte_id', 'a.id')
      .select(['a.id', 'a.name', 'a.code', 's.name as service_name', 'r.rules', 'r.action', 'r.updated_at']).distinct()
      .where('t.is_active', '=', true).orderBy('s.name').orderBy('a.name').execute();
    return { all_rules: ALL_RULES.map((k) => ({ key: k, label: RULE_KA[k] })), analytes: rows.map((r) => ({ ...r, rules: r.rules ?? [...ALL_RULES], action: r.action ?? 'block', is_default: !r.rules })) };
  }
  async setRules(analyteId: string, dto: { rules: string[]; action: 'block' | 'warn' }, u: AuthUser, ctx: AuditContext) {
    await this.requireHead(u);
    const rules = [...new Set(dto.rules)].filter((r) => (ALL_RULES as readonly string[]).includes(r));
    await this.db.insertInto('lab_qc_rules').values({ analyte_id: analyteId, rules, action: dto.action, updated_by: u.id })
      .onConflict((oc) => oc.column('analyte_id').doUpdateSet({ rules, action: dto.action, updated_by: u.id, updated_at: sql`now()` })).execute();
    await this.audit.log(ctx, { action: 'SET_QC_RULES', entityName: 'lab_analytes', entityId: analyteId, newData: { rules, action: dto.action } });
    return this.rulesFor(analyteId);
  }

  // ---------------------------------------------------------------- შედეგები
  /** QC-ის შედეგის ჩაწერა + შეფასება; უარყოფისას — დარღვევა (ერთი ღია ანალიზატორ×კომპონენტზე) */
  async record(targetId: string, value: number, source: 'instrument' | 'manual', opt: { at?: Date; userId?: string | null; instrumentResultId?: string | null }, ctx: AuditContext) {
    const t = await this.db.selectFrom('lab_qc_targets as t').innerJoin('lab_qc_materials as m', 'm.id', 't.material_id')
      .select(['t.id', 't.analyte_id', 't.method_id', 't.mean', 't.sd', 'm.expires_on', 'm.is_active']).where('t.id', '=', targetId).where('t.is_active', '=', true).executeTakeFirst();
    if (!t) throw new NotFoundException('QC სამიზნე ვერ მოიძებნა');
    const z = (value - Number(t.mean)) / Number(t.sd);
    const at = opt.at ?? new Date();
    const series = await this.db.selectFrom('lab_qc_results as r').innerJoin('lab_qc_targets as t2', 't2.id', 'r.target_id')
      .select(['r.z', 'r.measured_at', 'r.target_id']).where('t2.analyte_id', '=', t.analyte_id).where('t2.method_id', '=', t.method_id)
      .where('r.excluded_at', 'is', null).where('r.measured_at', '<=', at).orderBy('r.measured_at', 'desc').limit(12).execute();
    const cfg = await this.rulesFor(t.analyte_id);
    const ev = evaluate(z, series.map((s) => ({ z: Number(s.z), at: new Date(s.measured_at), targetId: s.target_id })), { at, targetId: t.id }, cfg.rules);
    return this.db.transaction().execute(async (trx) => {
      const r = await trx.insertInto('lab_qc_results').values({ target_id: t.id, value: String(value), z: String(Math.round(z * 1000) / 1000), measured_at: at, source,
        status: ev.status, violations: ev.violations, entered_by: opt.userId ?? null, instrument_result_id: opt.instrumentResultId ?? null }).returning('id').executeTakeFirstOrThrow();
      if (ev.status === 'reject') {
        await trx.insertInto('lab_qc_violations').values({ method_id: t.method_id, analyte_id: t.analyte_id, result_id: r.id, rules: ev.violations, action: cfg.action as 'block' | 'warn' })
          .onConflict((oc) => oc.columns(['method_id', 'analyte_id']).where('status', '=', 'open').doUpdateSet({ result_id: r.id, rules: ev.violations })).execute();
        await this.audit.log(ctx, { action: 'QC_REJECT', entityName: 'lab_qc_results', entityId: String(r.id), newData: { value, z, rules: ev.violations, action: cfg.action } }, trx);
      }
      return { id: String(r.id), z: Math.round(z * 100) / 100, status: ev.status, violations: ev.violations, action: ev.status === 'reject' ? cfg.action : null, expired: !!t.expires_on && new Date(t.expires_on) < new Date() };
    });
  }
  async manual(dto: { target_id: string; value: number; measured_at?: string }, u: AuthUser, ctx: AuditContext) {
    if (!has(u, 'admin') && !has(u, 'lab_doctor') && !has(u, 'lab_manager') && !has(u, 'diagnostic')) throw new ForbiddenException();
    return this.record(dto.target_id, dto.value, 'manual', { at: dto.measured_at ? new Date(dto.measured_at) : undefined, userId: u.id }, ctx);
  }
  /** ანალიზატორიდან: QC მასალის შტრიხკოდი + ანალიზატორი + კომპონენტი → სამიზნე; ვერ მოიძებნა → null */
  async fromInstrument(methodId: string, barcode: string, analyteId: string, value: number, at: Date | null, instrumentResultId: string, ctx: AuditContext) {
    const t = await this.db.selectFrom('lab_qc_targets as t').innerJoin('lab_qc_materials as m', 'm.id', 't.material_id').select('t.id')
      .where('t.method_id', '=', methodId).where('t.analyte_id', '=', analyteId).where('t.is_active', '=', true).where('m.is_active', '=', true)
      .where(sql`upper(m.barcode)`, '=', barcode.trim().toUpperCase()).executeTakeFirst();
    if (!t) return null;
    return this.record(t.id, value, 'instrument', { at: at ?? undefined, instrumentResultId }, ctx);
  }
  isQcBarcode(barcode: string) {
    return this.db.selectFrom('lab_qc_materials').select('id').where(sql`upper(barcode)`, '=', barcode.trim().toUpperCase()).where('is_active', '=', true).executeTakeFirst().then((r) => !!r);
  }
  /** Levey-Jennings: სამიზნის წერტილები პერიოდში */
  async chart(targetId: string, from: string, to: string) {
    const t = await this.db.selectFrom('lab_qc_targets as t').innerJoin('lab_qc_materials as m', 'm.id', 't.material_id').innerJoin('lab_analytes as a', 'a.id', 't.analyte_id')
      .innerJoin('lab_methods as me', 'me.id', 't.method_id')
      .select(['t.id', 't.mean', 't.sd', 'm.name as material', 'm.level', 'm.lot', 'a.name as analyte', 'a.unit', 'me.name as method']).where('t.id', '=', targetId).executeTakeFirst();
    if (!t) throw new NotFoundException('სამიზნე ვერ მოიძებნა');
    const points = await this.db.selectFrom('lab_qc_results as r').leftJoin('users as u', 'u.id', 'r.entered_by')
      .select(['r.id', 'r.value', 'r.z', 'r.measured_at', 'r.status', 'r.violations', 'r.source', 'r.excluded_at', 'r.exclude_reason', sql<string | null>`u.first_name || ' ' || u.last_name`.as('entered_by_name')])
      .where('r.target_id', '=', targetId).where('r.measured_at', '>=', sql<Date>`(${from}::date::timestamp AT TIME ZONE ${TZ})`).where('r.measured_at', '<', sql<Date>`((${to}::date + 1)::timestamp AT TIME ZONE ${TZ})`).orderBy('r.measured_at').execute();
    return { target: t, points };
  }
  async exclude(id: string, reason: string, u: AuthUser, ctx: AuditContext) {
    await this.requireHead(u);
    const r = await this.db.updateTable('lab_qc_results').set({ excluded_at: sql`now()`, excluded_by: u.id, exclude_reason: reason.trim() }).where('id', '=', id).where('excluded_at', 'is', null).returning('id').executeTakeFirst();
    if (!r) throw new NotFoundException('შედეგი ვერ მოიძებნა ან უკვე გამორიცხულია');
    await this.audit.log(ctx, { action: 'QC_EXCLUDE', entityName: 'lab_qc_results', entityId: id, newData: { reason } });
    return { id, excluded: true };
  }
  /** ანგარიში: თითო სამიზნეზე n, საშუალო, SD, CV %, bias %, უარყოფები */
  summary(from: string, to: string) {
    return this.db.selectFrom('lab_qc_targets as t').innerJoin('lab_qc_materials as m', 'm.id', 't.material_id').innerJoin('lab_analytes as a', 'a.id', 't.analyte_id')
      .innerJoin('lab_methods as me', 'me.id', 't.method_id')
      .leftJoin('lab_qc_results as r', (j) => j.onRef('r.target_id', '=', 't.id').on('r.excluded_at', 'is', null)
        .on(sql<boolean>`r.measured_at >= (${from}::date::timestamp AT TIME ZONE ${TZ}) AND r.measured_at < ((${to}::date + 1)::timestamp AT TIME ZONE ${TZ})`))
      .select(['t.id', 'm.name as material', 'm.level', 'm.lot', 'a.name as analyte', 'a.unit', 'me.name as method', 't.mean', 't.sd',
        sql<number>`count(r.id)`.as('n'), sql<number | null>`avg(r.value)`.as('mean_obs'), sql<number | null>`stddev_samp(r.value)`.as('sd_obs'),
        sql<number>`count(r.id) FILTER (WHERE r.status = 'reject')`.as('rejects'), sql<number>`count(r.id) FILTER (WHERE r.status = 'warn')`.as('warns')])
      .where('t.is_active', '=', true).groupBy(['t.id', 'm.name', 'm.level', 'm.lot', 'a.name', 'a.unit', 'me.name', 't.mean', 't.sd']).orderBy('me.name').orderBy('a.name').orderBy('m.level').execute()
      .then((rows) => rows.map((r) => ({ ...r, cv: r.mean_obs && r.sd_obs ? Math.round((Number(r.sd_obs) / Number(r.mean_obs)) * 1000) / 10 : null,
        bias: r.mean_obs ? Math.round(((Number(r.mean_obs) - Number(r.mean)) / Number(r.mean)) * 1000) / 10 : null })));
  }

  // ---------------------------------------------------------------- დარღვევები
  violations(status: 'open' | 'all') {
    let q = this.db.selectFrom('lab_qc_violations as v').innerJoin('lab_methods as m', 'm.id', 'v.method_id').innerJoin('lab_analytes as a', 'a.id', 'v.analyte_id')
      .innerJoin('lab_qc_results as r', 'r.id', 'v.result_id').innerJoin('lab_qc_targets as t', 't.id', 'r.target_id').innerJoin('lab_qc_materials as mat', 'mat.id', 't.material_id')
      .leftJoin('users as u', 'u.id', 'v.resolved_by')
      .select(['v.id', 'v.method_id', 'v.analyte_id', 'v.rules', 'v.action', 'v.status', 'v.opened_at', 'v.resolved_at', 'v.cause', 'v.corrective_action', 'm.name as method', 'a.name as analyte',
        'r.value', 'r.z', 'mat.level', 'mat.lot', sql<string | null>`u.first_name || ' ' || u.last_name`.as('resolved_by_name')])
      .orderBy('v.opened_at', 'desc').limit(200);
    if (status === 'open') q = q.where('v.status', '=', 'open');
    return q.execute();
  }
  async resolve(id: string, dto: { cause: string; corrective_action: string }, u: AuthUser, ctx: AuditContext) {
    if (!has(u, 'admin') && !has(u, 'lab_doctor')) throw new ForbiddenException('დარღვევას განიხილავს ლაბ. ექიმი');
    const r = await this.db.updateTable('lab_qc_violations').set({ status: 'resolved', resolved_at: sql`now()`, resolved_by: u.id, cause: dto.cause.trim(), corrective_action: dto.corrective_action.trim() })
      .where('id', '=', id).where('status', '=', 'open').returning('id').executeTakeFirst();
    if (!r) throw new NotFoundException('ღია დარღვევა ვერ მოიძებნა');
    await this.audit.log(ctx, { action: 'QC_RESOLVE', entityName: 'lab_qc_violations', entityId: id, newData: dto });
    return { id, status: 'resolved' };
  }
  /** შეკვეთის კომპონენტებზე ღია დარღვევები (ანალიზატორი = შეკვეთის ანალიზატორი ან ანალიზის ნაგულისხმევი) */
  async openFor(methodId: string | null, analyteIds: string[]) {
    if (!methodId || !analyteIds.length) return [];
    return this.db.selectFrom('lab_qc_violations as v').innerJoin('lab_analytes as a', 'a.id', 'v.analyte_id').innerJoin('lab_methods as m', 'm.id', 'v.method_id')
      .select(['v.id', 'v.action', 'v.rules', 'v.opened_at', 'a.name as analyte', 'm.name as method', 'v.analyte_id'])
      .where('v.status', '=', 'open').where('v.method_id', '=', methodId).where('v.analyte_id', 'in', analyteIds).execute();
  }
}

// ======================================================================= კონტროლერი
class MaterialDto { @IsOptional() @IsString() @Length(2, 150) name?: string; @IsOptional() @IsString() @MaxLength(150) manufacturer?: string | null;
  @IsOptional() @IsString() @Length(1, 40) level?: string; @IsOptional() @IsString() @Length(1, 60) lot?: string; @IsOptional() @IsISO8601() expires_on?: string | null;
  @IsOptional() @IsString() @MaxLength(60) barcode?: string | null; @IsOptional() @IsBoolean() is_active?: boolean }
class TargetDto { @IsUUID() analyte_id: string; @IsUUID() method_id: string; @IsNumber() mean: number; @IsNumber() @Min(0.000001) sd: number }
class TargetsDto { @IsArray() @ArrayMaxSize(300) @ValidateNested({ each: true }) @Type(() => TargetDto) targets: TargetDto[] }
class RulesDto { @IsArray() @IsIn([...ALL_RULES], { each: true }) rules: string[]; @IsIn(['block', 'warn']) action: 'block' | 'warn' }
class ManualDto { @IsUUID() target_id: string; @IsNumber() value: number; @IsOptional() @IsISO8601() measured_at?: string }
class ReasonDto { @IsString() @Length(3, 500) reason: string }
class ResolveDto { @IsString() @Length(3, 1000) cause: string; @IsString() @Length(3, 1000) corrective_action: string }
const DAY = /^\d{4}-\d{2}-\d{2}$/;

@Controller('lab/qc')
export class LabQcController {
  constructor(private readonly qc: LabQcService) {}
  @Get('materials') @Roles(...LAB_ALL) materials(@Query('all') all?: string) { return this.qc.materials(all === 'true'); }
  @Post('materials') @Roles('admin', 'lab_doctor', 'lab_manager') createMaterial(@Body() d: MaterialDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.qc.saveMaterial(null, d, u, auditCtx(r)); }
  @Patch('materials/:id') @Roles('admin', 'lab_doctor', 'lab_manager') updateMaterial(@Param('id', ParseUUIDPipe) id: string, @Body() d: MaterialDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.qc.saveMaterial(id, d, u, auditCtx(r)); }
  @Get('materials/:id/targets') @Roles(...LAB_ALL) targets(@Param('id', ParseUUIDPipe) id: string) { return this.qc.targets(id); }
  @Put('materials/:id/targets') @Roles('admin', 'lab_doctor', 'lab_manager') setTargets(@Param('id', ParseUUIDPipe) id: string, @Body() d: TargetsDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.qc.setTargets(id, d.targets, u, auditCtx(r)); }
  @Get('rules') @Roles(...LAB_ALL) rules() { return this.qc.rulesList(); }
  @Put('rules/:analyteId') @Roles('admin', 'lab_doctor') setRules(@Param('analyteId', ParseUUIDPipe) id: string, @Body() d: RulesDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.qc.setRules(id, d, u, auditCtx(r)); }
  @Post('results') @HttpCode(200) @Roles(...LAB_ALL) manual(@Body() d: ManualDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.qc.manual(d, u, auditCtx(r)); }
  @Post('results/:id/exclude') @HttpCode(200) @Roles('admin', 'lab_doctor') exclude(@Param('id') id: string, @Body() d: ReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.qc.exclude(String(Number(id) || 0), d.reason, u, auditCtx(r)); }
  @Get('chart') @Roles(...LAB_ALL) chart(@Query('target_id', ParseUUIDPipe) t: string, @Query('from') from: string, @Query('to') to: string) {
    if (!DAY.test(from ?? '') || !DAY.test(to ?? '')) throw new BadRequestException('from/to: YYYY-MM-DD'); return this.qc.chart(t, from, to);
  }
  @Get('summary') @Roles(...LAB_ALL) summary(@Query('from') from: string, @Query('to') to: string) {
    if (!DAY.test(from ?? '') || !DAY.test(to ?? '')) throw new BadRequestException('from/to: YYYY-MM-DD'); return this.qc.summary(from, to);
  }
  @Get('violations') @Roles(...LAB_ALL) violations(@Query('status') s?: string) { return this.qc.violations(s === 'all' ? 'all' : 'open'); }
  @Post('violations/:id/resolve') @HttpCode(200) @Roles('admin', 'lab_doctor') resolve(@Param('id') id: string, @Body() d: ResolveDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.qc.resolve(String(Number(id) || 0), d, u, auditCtx(r)); }
}
