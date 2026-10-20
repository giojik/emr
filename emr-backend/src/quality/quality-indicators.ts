import { BadRequestException, Body, ConflictException, Controller, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min } from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/roles';
import { EVENT_KA, EVENT_TYPES, HARM_KA, type Ex, QM_FULL, QmCommon } from './quality-common';
import { DENOM_KA, SERVICE_KA, SERVICE_TYPES } from './quality-metrics';

class IndicatorDto {
  @Matches(/^[a-z][a-z0-9_]{1,29}$/, { message: 'კოდი: ლათინური პატარა ასოები / ციფრები / _, 2–30' }) code: string;
  @IsString() @Length(3, 200) name: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string | null;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @IsUUID('all', { each: true }) category_ids: string[];
  @IsOptional() @IsArray() @ArrayMinSize(1) @IsIn(EVENT_TYPES, { each: true }) event_types?: string[];
  @IsOptional() @IsIn(['mild', 'moderate', 'severe', 'death']) min_harm?: string | null;
  @IsOptional() @IsBoolean() patient_only?: boolean;
  @IsOptional() @IsArray() @IsIn(SERVICE_TYPES, { each: true }) service_types?: string[];
  @IsOptional() @IsIn(['bed_days', 'admissions', 'visits']) denominator?: 'bed_days' | 'admissions' | 'visits';
  @IsOptional() @IsIn([100, 1000, 10000]) per?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100000) sort_order?: number;
}
class IndicatorPatchDto {
  @IsOptional() @IsString() @Length(3, 200) name?: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string | null;
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @IsUUID('all', { each: true }) category_ids?: string[];
  @IsOptional() @IsArray() @ArrayMinSize(1) @IsIn(EVENT_TYPES, { each: true }) event_types?: string[];
  @IsOptional() @IsIn(['mild', 'moderate', 'severe', 'death']) min_harm?: string | null;
  @IsOptional() @IsBoolean() patient_only?: boolean;
  @IsOptional() @IsArray() @IsIn(SERVICE_TYPES, { each: true }) service_types?: string[];
  @IsOptional() @IsIn(['bed_days', 'admissions', 'visits']) denominator?: 'bed_days' | 'admissions' | 'visits';
  @IsOptional() @IsIn([100, 1000, 10000]) per?: number;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(100000) sort_order?: number;
  @IsString() @Length(3, 500) reason: string;
}

/**
 * ინდიკატორები (0066): ხარისხი → ცნობარები → „ინდიკატორები“ (quality). ყოველ ინდიკატორს მენეჯერულ დაფაზე შეესაბამება KPI qm_ind_<code>
 * (ჯგუფი „ხარისხი“, ↓, ჩაღრმავების გარეშე) — სახელი / განმარტება / ფორმულის ტექსტი / აქტიურობა სინქრონდება. წაშლა არ არის — გათიშვა.
 */
@Injectable()
export class QmIndicatorsService {
  constructor(private readonly c: QmCommon, private readonly audit: AuditService) {}
  private get db() { return this.c.db; }

  async list(all?: boolean) {
    await this.c.rules();
    let q = this.db.selectFrom('qm_indicators').selectAll().orderBy('sort_order').orderBy('code');
    if (!all) q = q.where('is_active', '=', true);
    const rows = await q.execute();
    const cats = await this.db.selectFrom('qm_classifiers as c').leftJoin('qm_classifiers as p', 'p.id', 'c.parent_id')
      .select(['c.id', sql<string>`CASE WHEN p.name IS NULL THEN c.name ELSE p.name || ' → ' || c.name END`.as('name')]).where('c.kind', '=', 'category').execute();
    return rows.map((r) => ({ ...r, kpi_code: `qm_ind_${r.code}`, denominator_ka: DENOM_KA[r.denominator],
      categories: r.category_ids.map((id) => ({ id, name: cats.find((x) => x.id === id)?.name ?? '?' })), formula: this.formula(r, cats) }));
  }

  private formula(i: { category_ids: string[]; event_types: string[]; min_harm: string | null; patient_only: boolean; service_types: string[]; denominator: string; per: number },
    cats: { id: string; name: string }[]) {
    const parts = [i.category_ids.map((id) => cats.find((x) => x.id === id)?.name ?? '?').join(', '), i.event_types.map((e) => EVENT_KA[e]).join(' / '),
      ...(i.min_harm ? [`ზიანი ≥ ${HARM_KA[i.min_harm as keyof typeof HARM_KA]}`] : []), ...(i.patient_only ? ['მხოლოდ პაციენტი'] : []),
      i.service_types.length ? i.service_types.map((x) => SERVICE_KA[x]).join(' / ') : 'ყველა მომსახურება'];
    return `${parts.join(' · ')} / ${DENOM_KA[i.denominator]} × ${i.per}`;
  }

  private async checkCategories(ids: string[], ex: Ex) {
    const u = [...new Set(ids)];
    const n = (await ex.selectFrom('qm_classifiers').select(sql<number>`count(*)::int`.as('n')).where('id', 'in', u).where('kind', '=', 'category').executeTakeFirstOrThrow()).n;
    if (n !== u.length) throw new BadRequestException({ code: 'CATEGORY', message: 'კატეგორია ვერ მოიძებნა' });
    return u;
  }

  /** KPI ცნობარის ჩანაწერი (qm_ind_<code>) — სახელი / განმარტება / ფორმულა / აქტიურობა */
  private async syncKpi(ex: Ex, id: string, userId: string) {
    const i = await ex.selectFrom('qm_indicators').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    const cats = await ex.selectFrom('qm_classifiers as c').leftJoin('qm_classifiers as p', 'p.id', 'c.parent_id')
      .select(['c.id', sql<string>`CASE WHEN p.name IS NULL THEN c.name ELSE p.name || ' → ' || c.name END`.as('name')]).where('c.kind', '=', 'category').execute();
    const v = { name: i.name, definition: i.description?.trim() || `${i.name} (ხარისხი → ცნობარები → ინდიკატორები)`, formula: this.formula(i, cats), is_active: i.is_active };
    await ex.insertInto('rpt_kpis').values({ code: `qm_ind_${i.code}`, category: 'quality', unit: 'ratio', direction: 'down', source: 'rpt_fact_quality, rpt_fact_beds / rpt_fact_flow',
      sort_order: 87 + Math.min(10, Math.round(i.sort_order / 10)), updated_by: userId, ...v })
      .onConflict((oc) => oc.column('code').doUpdateSet({ ...v, updated_by: userId, updated_at: sql`now()` })).execute();
  }

  async create(d: IndicatorDto, u: AuthUser, req: Request) {
    await this.c.rules();
    return this.db.transaction().execute(async (trx) => {
      if (await trx.selectFrom('qm_indicators').select('id').where('code', '=', d.code).executeTakeFirst()) throw new ConflictException({ code: 'CODE_EXISTS', message: 'ასეთი კოდი უკვე არსებობს' });
      if (await trx.selectFrom('rpt_kpis').select('code').where('code', '=', `qm_ind_${d.code}`).executeTakeFirst()) throw new ConflictException({ code: 'CODE_EXISTS', message: 'ასეთი KPI კოდი უკვე არსებობს' });
      const cats = await this.checkCategories(d.category_ids, trx);
      const max = (await trx.selectFrom('qm_indicators').select(sql<number>`coalesce(max(sort_order), 0)::int`.as('m')).executeTakeFirstOrThrow()).m;
      const row = await trx.insertInto('qm_indicators').values({ code: d.code, name: d.name.trim(), description: d.description?.trim() || null, category_ids: cats,
        event_types: [...new Set(d.event_types ?? ['harm', 'no_harm'])], min_harm: d.min_harm ?? null, patient_only: d.patient_only ?? true,
        service_types: [...new Set(d.service_types ?? ['inpatient'])], denominator: d.denominator ?? 'bed_days', per: d.per ?? 1000, sort_order: d.sort_order ?? max + 10, updated_by: u.id })
        .returningAll().executeTakeFirstOrThrow();
      await this.syncKpi(trx, row.id, u.id);
      await this.audit.log(auditCtx(req), { action: 'QM_INDICATOR_CREATE', entityName: 'qm_indicators', entityId: row.id, newData: d }, trx);
      return { ...row, kpi_code: `qm_ind_${row.code}` };
    });
  }

  async update(id: string, d: IndicatorPatchDto, u: AuthUser, req: Request) {
    await this.c.rules();
    return this.db.transaction().execute(async (trx) => {
      const old = await trx.selectFrom('qm_indicators').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!old) throw new NotFoundException('ინდიკატორი ვერ მოიძებნა');
      const set = {
        ...(d.name !== undefined && { name: d.name.trim() }), ...(d.description !== undefined && { description: d.description?.trim() || null }),
        ...(d.category_ids !== undefined && { category_ids: await this.checkCategories(d.category_ids, trx) }),
        ...(d.event_types !== undefined && { event_types: [...new Set(d.event_types)] }), ...(d.min_harm !== undefined && { min_harm: d.min_harm }),
        ...(d.patient_only !== undefined && { patient_only: d.patient_only }), ...(d.service_types !== undefined && { service_types: [...new Set(d.service_types)] }),
        ...(d.denominator !== undefined && { denominator: d.denominator }), ...(d.per !== undefined && { per: d.per }),
        ...(d.is_active !== undefined && { is_active: d.is_active }), ...(d.sort_order !== undefined && { sort_order: d.sort_order }),
      };
      if (!Object.keys(set).length) throw new BadRequestException({ code: 'NO_CHANGE', message: 'ცვლილება არ არის' });
      const row = await trx.updateTable('qm_indicators').set({ ...set, updated_by: u.id }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await this.syncKpi(trx, id, u.id);
      await this.audit.log(auditCtx(req), { action: 'QM_INDICATOR_UPDATE', entityName: 'qm_indicators', entityId: id,
        oldData: Object.fromEntries(Object.keys(set).map((k) => [k, old[k as keyof typeof old]])), newData: { ...set, reason: d.reason } }, trx);
      return { ...row, kpi_code: `qm_ind_${row.code}` };
    });
  }
}

@Controller('quality/indicators')
export class QmIndicatorsController {
  constructor(private readonly s: QmIndicatorsService) {}
  @Get() @Roles('quality', 'quality_dept', 'quality_view') list(@Query('all') all?: string) { return this.s.list(all === 'true'); }
  @Post() @Roles(...QM_FULL) create(@Body() d: IndicatorDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.create(d, u, r); }
  @Patch(':id') @Roles(...QM_FULL) update(@Param('id', ParseUUIDPipe) id: string, @Body() d: IndicatorPatchDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.update(id, d, u, r); }
}
