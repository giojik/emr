import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import type { Request, Response } from 'express';
import { sql, type Transaction } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser } from '../auth/roles';
import { mapPgError } from '../common/pg-errors';
import { loadEnv } from '../config/env';
import { InjectDb, type Database } from '../database/database.module';
import type { DB } from '../database/db';
import { ModulesService } from '../modules/modules';
import { NotificationsService } from '../notifications/notifications';
import { probe, sendRaw, wristbandPdf, wristbandZpl, type WristbandData } from './wristband';

type Trx = Transaction<DB>;
type Ex = Database | Trx;
const TZ = loadEnv().CLINIC_TZ;

export interface InpatientSettings {
  bed_assign_mode: 'two_step' | 'direct'; cleaning_required: boolean; sex_rule: 'block' | 'warn' | 'off'; overflow_beds: boolean;
  planned_queue: boolean; planned_sms: boolean; cancel_hours: number;
  wristband: boolean; wristband_print: 'zpl' | 'pdf'; wristband_width_mm: number; wristband_length_mm: number; wristband_offset_mm: number;
  // 0041
  transfer_wait_hours: number; epicrisis_cosign: boolean; discharge_cancel_hours: number; leave_counts_bed_day: boolean; leave_max_hours: number; docs_pending_alert_hours: number;
  med_verification: 'all' | 'high_risk' | 'off'; dose_rule: 'warn' | 'block'; interaction_rule: 'warn' | 'block'; antibiotic_default_days: number;
  verbal_orders: boolean; verbal_confirm_hours: number; weight_max_age_days: number;
  // 0043 MAR
  mar_window_min: number; mar_missed_hours: number; mar_horizon_hours: number; mar_stock_deduct: boolean; mar_allow_no_stock: boolean;
  mar_double_check: boolean; mar_barcode: 'off' | 'optional' | 'required';
  // 0043b: ვინ ადასტურებს დანიშნულებას (ნაგულისხმევი — both)
  med_verifier?: 'pharmacist' | 'head_nurse' | 'both';
  // 0044: ექთნის დოკუმენტაცია
  news2_enabled: boolean; news2_alert: number; news2_urgent: number; glucose_low: number; glucose_high: number;
  fluid_day_start: string; shift_times: string[]; scale_reminders: boolean; line_alert_hours: Record<string, number>;
}
const SEVERITY = ['stable', 'moderate', 'severe', 'critical'] as const;
const ISOLATION = ['contact', 'droplet', 'airborne', 'protective'] as const;
const SOURCES = ['emergency', 'outpatient', 'planned', 'transfer_in', 'direct'] as const;
const READ = ['admin', 'doctor', 'nurse', 'receptionist', 'manager', 'viewer', 'billing'] as const;
const ISO_KA: Record<string, string> = { contact: 'კონტაქტური', droplet: 'წვეთოვანი', airborne: 'საჰაერო', protective: 'დამცავი' };

// ================================================================= DTO
export class WardDto {
  @IsOptional() @IsUUID() department_id?: string;
  @IsOptional() @IsString() @Length(1, 20) code?: string;
  @IsOptional() @IsString() @MaxLength(120) name?: string | null;
  @IsOptional() @IsString() @MaxLength(20) floor?: string | null;
  @IsOptional() @IsIn(['male', 'female', 'mixed']) sex?: 'male' | 'female' | 'mixed';
  @IsOptional() @IsBoolean() isolation_capable?: boolean;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsInt() @Min(0) sort_order?: number;
}
export class BedsBulkDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(40) count: number;
  @IsOptional() @IsString() @Matches(/^[a-z][a-z0-9_]{1,29}$/) type_code?: string;
  @IsOptional() @IsString() @MaxLength(15) prefix?: string;          // ნაგულისხმევი: „<პალატა>-“
  @IsOptional() @IsBoolean() is_overflow?: boolean;
}
export class BedDto {
  @IsOptional() @IsString() @Length(1, 20) code?: string;
  @IsOptional() @IsString() @Matches(/^[a-z][a-z0-9_]{1,29}$/) type_code?: string;
  @IsOptional() @IsBoolean() is_overflow?: boolean;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsInt() @Min(0) sort_order?: number;
}
export class BedTypeDto {
  @IsOptional() @IsString() @Matches(/^[a-z][a-z0-9_]{1,29}$/) code?: string;
  @IsOptional() @IsString() @Length(2, 80) name?: string;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsInt() @Min(0) sort_order?: number;
}
export class PrinterDto {
  @IsOptional() @IsString() @Length(2, 120) name?: string;
  @IsOptional() @IsIn(['wristband', 'label']) kind?: 'wristband' | 'label';
  @IsOptional() @IsString() @Matches(/^[A-Za-z0-9.:-]{1,255}$/, { message: 'host: IP მისამართი ან სახელი' }) host?: string;
  @IsOptional() @IsInt() @Min(1) @Max(65535) port?: number;
  @IsOptional() @IsIn([203, 300, 600]) dpi?: number;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() department_id?: string | null;
  @IsOptional() @IsBoolean() is_active?: boolean;
}
export class AdmitDto {
  @IsUUID() patient_id: string;
  @IsUUID() department_id: string;
  @IsUUID() attending_doctor_id: string;
  @IsIn(SOURCES) source: (typeof SOURCES)[number];
  @IsOptional() @IsUUID() source_encounter_id?: string;
  @IsOptional() @IsUUID() referral_id?: string;
  @IsOptional() @IsUUID() planned_id?: string;
  @IsOptional() @IsString() @MaxLength(300) referring_institution?: string;
  @IsString() @Length(2, 10) icd10_code: string;
  @IsOptional() @IsString() @MaxLength(2000) chief_complaint?: string;
  @IsOptional() @IsIn(SEVERITY) severity?: string;
  @IsOptional() @IsIn(ISOLATION) isolation?: string;
  @IsOptional() @IsUUID() bed_id?: string;
  @IsOptional() @IsBoolean() confirm?: boolean;                       // გაფრთხილებების დადასტურება (სქესი, იზოლაცია)
}
export class BedAssignDto {
  @IsUUID() bed_id: string;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
  @IsOptional() @IsBoolean() confirm?: boolean;
}
export class StayPatchDto {
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsIn(SEVERITY) severity?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsIn(ISOLATION) isolation?: string | null;
  @IsOptional() @IsUUID() attending_doctor_id?: string;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
export class ReasonDto { @IsString() @Length(3, 500) reason: string }
export class PlannedDto {
  @IsOptional() @IsUUID() patient_id?: string;
  @IsOptional() @IsUUID() department_id?: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() doctor_id?: string | null;
  @IsOptional() @IsDateString() planned_date?: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @Length(2, 10) icd10_code?: string | null;
  @IsOptional() @IsString() @Length(3, 1000) reason?: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(2000) notes?: string | null;
}
export class ReserveDto { @IsUUID() bed_id: string; @IsOptional() @IsBoolean() confirm?: boolean }
export class PrintDto { @IsOptional() @IsUUID() printer_id?: string }
export class PrinterTestDto { @IsOptional() @IsBoolean() print?: boolean }

// ================================================================= სერვისი
/**
 * სტაციონარი (0040): საწოლფონდი, ჰოსპიტალიზაცია, საწოლის მინიჭება / შეცვლა, დაფა, გეგმიური რიგი, სამაჯური.
 * უფლებები: საწოლფონდი / პრინტერები — admin; ჰოსპიტალიზაცია — admin / რეგისტრატორი / ექიმი;
 *   საწოლის მინიჭება — განყოფილების თანამშრომელი (ექთანი / ექიმი / მენეჯერი) ან admin; „პირდაპირ“ რეჟიმში — მიმღებიც;
 *   საწოლის ბლოკი — განყოფილების ხელმძღვანელი / admin; დალაგება — განყოფილების თანამშრომელი.
 */
@Injectable()
export class InpatientService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService, private readonly modules: ModulesService,
    private readonly notifications: NotificationsService) {}

  settings() { return this.modules.require<InpatientSettings>('inpatient'); }
  /** @internal (0041: გამოიყენება გადაყვანა / გაწერა / ეპიკრიზი სერვისებში) */
  me(u: AuthUser, ex: Ex = this.db) { return ex.selectFrom('users').select(['id', 'department_id', 'is_section_head']).where('id', '=', u.id).executeTakeFirstOrThrow(); }
  async isStaff(u: AuthUser, departmentId: string, ex: Ex = this.db) {
    if (has(u, 'admin')) return true;
    if (!has(u, 'nurse', 'doctor', 'manager')) return false;
    return (await this.me(u, ex)).department_id === departmentId;
  }
  async isHead(u: AuthUser, departmentId: string, ex: Ex = this.db) {
    if (has(u, 'admin')) return true;
    const me = await this.me(u, ex);
    return me.department_id === departmentId && (me.is_section_head || has(u, 'manager'));
  }
  async canAssign(u: AuthUser, departmentId: string, s: InpatientSettings, ex: Ex = this.db) {
    if (await this.isStaff(u, departmentId, ex)) return true;
    return s.bed_assign_mode === 'direct' && has(u, 'receptionist', 'doctor');
  }
  event(ex: Ex, e: { encounter_id?: string | null; bed_id?: string | null; planned_id?: string | null; kind: string; data?: Record<string, unknown> }, u: AuthUser | null) {
    return ex.insertInto('inpatient_events').values({ encounter_id: e.encounter_id ?? null, bed_id: e.bed_id ?? null, planned_id: e.planned_id ?? null, kind: e.kind,
      data: JSON.stringify(e.data ?? {}), user_id: u?.id ?? null }).execute();
  }
  async nextNo(trx: Trx, type: string, prefix: string) {
    const year = Number((await sql<{ y: string }>`SELECT to_char(now() AT TIME ZONE ${TZ}, 'YYYY') AS y`.execute(trx)).rows[0].y);
    const { last_value } = await trx.insertInto('document_counters').values({ document_type: type, year, last_value: 1 })
      .onConflict((oc) => oc.columns(['document_type', 'year']).doUpdateSet({ last_value: sql`document_counters.last_value + 1` })).returning('last_value').executeTakeFirstOrThrow();
    return `${prefix}${String(year).slice(2)}-${String(last_value).padStart(6, '0')}`;
  }
  async department(id: string, ex: Ex = this.db) {
    const d = await ex.selectFrom('departments').select(['id', 'name', 'type', 'is_active']).where('id', '=', id).executeTakeFirst();
    if (!d || !d.is_active) throw new BadRequestException('განყოფილება ვერ მოიძებნა ან გათიშულია');
    if (d.type !== 'inpatient') throw new BadRequestException(`„${d.name}“ სტაციონარული განყოფილება არ არის (ტიპი: inpatient)`);
    return d;
  }
  async doctor(id: string, ex: Ex = this.db) {
    const d = await ex.selectFrom('users as u').select(['u.id', 'u.first_name', 'u.last_name', 'u.is_active',
      sql<boolean>`EXISTS (SELECT 1 FROM user_capabilities c WHERE c.user_id = u.id AND 'doctor' = ANY(c.capabilities))`.as('is_doctor')]).where('u.id', '=', id).executeTakeFirst();
    if (!d || !d.is_doctor || !d.is_active) throw new BadRequestException('მკურნალი ექიმი ვერ მოიძებნა ან აქტიური არ არის');
    return d;
  }
  private async icd(code: string, ex: Ex = this.db) {
    const c = await ex.selectFrom('icd10_codes').select(['code', 'title', 'is_active']).where('code', '=', code.trim().toUpperCase()).executeTakeFirst();
    if (!c || !c.is_active) throw new BadRequestException(`ICD-10 კოდი ${code} კლასიფიკატორში არ არსებობს`);
    return c;
  }

  /** საწოლი ბლოკით + შემოწმებები: აქტიური, განყოფილება, სტატუსი; გაფრთხილებები (სქესი, იზოლაცია) — confirm-ით */
  async lockBed(trx: Trx, bedId: string, p: { departmentId: string; gender: string; isolation?: string | null; plannedId?: string | null; confirm?: boolean }, s: InpatientSettings) {
    const b = await trx.selectFrom('beds as b').innerJoin('wards as w', 'w.id', 'b.ward_id')
      .select(['b.id', 'b.code', 'b.status', 'b.is_active', 'b.is_overflow', 'w.id as ward_id', 'w.code as ward_code', 'w.department_id', 'w.sex', 'w.isolation_capable', 'w.is_active as ward_active'])
      .where('b.id', '=', bedId).forUpdate('b').executeTakeFirst();
    if (!b || !b.is_active || !b.ward_active) throw new BadRequestException('საწოლი ვერ მოიძებნა ან გათიშულია');
    if (b.department_id !== p.departmentId) throw new BadRequestException(`საწოლი ${b.code} სხვა განყოფილებისაა`);
    if (b.is_overflow && !s.overflow_beds) throw new BadRequestException('დამატებითი საწოლები გამორთულია (ადმინისტრირება → მოდულები → სტაციონარი)');
    const reservedForMe = b.status === 'reserved' && p.plannedId
      && await trx.selectFrom('inpatient_planned').select('id').where('id', '=', p.plannedId).where('bed_id', '=', b.id).where('status', '=', 'waiting').executeTakeFirst();
    if (b.status !== 'free' && !reservedForMe) {
      const ka: Record<string, string> = { reserved: 'დაჯავშნილია', occupied: 'დაკავებულია', cleaning: 'დასალაგებელია', blocked: 'დაბლოკილია' };
      throw new ConflictException({ code: 'BED_NOT_FREE', message: `საწოლი ${b.code} ${ka[b.status] ?? b.status}` });
    }
    const warnings: string[] = [];
    if (s.sex_rule !== 'off' && b.sex !== 'mixed' && b.sex !== p.gender) {
      const msg = `პალატა ${b.ward_code} — ${b.sex === 'male' ? 'მამაკაცის' : 'ქალის'}; პაციენტი — ${p.gender === 'male' ? 'მამაკაცი' : p.gender === 'female' ? 'ქალი' : 'სხვა'}`;
      if (s.sex_rule === 'block') throw new ConflictException({ code: 'SEX_RULE', message: `${msg} (წესი: აკრძალულია)` });
      warnings.push(msg);
    }
    if (p.isolation && !b.isolation_capable) warnings.push(`პაციენტს სჭირდება ${ISO_KA[p.isolation]} იზოლაცია; პალატა ${b.ward_code} იზოლაციისთვის არ არის მონიშნული`);
    if (warnings.length && !p.confirm) throw new ConflictException({ code: 'CONFIRM_REQUIRED', message: warnings.join('; '), warnings });
    return { ...b, warnings };
  }
  async setBed(ex: Ex, bedId: string, status: string, u: AuthUser | null, reason: string | null = null) {
    await ex.updateTable('beds').set({ status, status_reason: reason, status_at: sql`now()`, status_by: u?.id ?? null }).where('id', '=', bedId).execute();
  }
  /** გათავისუფლებული საწოლი: დალაგება სავალდებულოა → „დასალაგებელი“, არადა → „თავისუფალი“ */
  async releaseBed(ex: Ex, bedId: string, s: InpatientSettings, u: AuthUser) {
    await this.setBed(ex, bedId, s.cleaning_required ? 'cleaning' : 'free', u);
  }

  // ================================================================= საწოლფონდი (admin)
  async structure(includeInactive: boolean) {
    const s = await this.settings();
    const deps = await this.db.selectFrom('departments').select(['id', 'name', 'code']).where('type', '=', 'inpatient').where('is_active', '=', true).orderBy('name').execute();
    let wq = this.db.selectFrom('wards').selectAll().orderBy('sort_order').orderBy('code');
    if (!includeInactive) wq = wq.where('is_active', '=', true);
    let bq = this.db.selectFrom('beds as b').innerJoin('bed_types as t', 't.code', 'b.type_code').selectAll('b').select('t.name as type_name').orderBy('b.sort_order').orderBy('b.code');
    if (!includeInactive) bq = bq.where('b.is_active', '=', true);
    const [wards, beds, types] = await Promise.all([wq.execute(), bq.execute(), this.db.selectFrom('bed_types').selectAll().orderBy('sort_order').execute()]);
    return { settings: s, types, departments: deps.map((d) => ({ ...d, wards: wards.filter((w) => w.department_id === d.id).map((w) => ({ ...w, beds: beds.filter((b) => b.ward_id === w.id) })) })) };
  }

  async saveWard(id: string | null, dto: WardDto, ctx: AuditContext) {
    await this.settings();
    if (!id && (!dto.department_id || !dto.code)) throw new BadRequestException('department_id და code სავალდებულოა');
    if (dto.department_id) await this.department(dto.department_id);
    try {
      return await this.db.transaction().execute(async (trx) => {
        const old = id ? await trx.selectFrom('wards').selectAll().where('id', '=', id).forUpdate().executeTakeFirst() : undefined;
        if (id && !old) throw new NotFoundException('პალატა ვერ მოიძებნა');
        if (old && dto.department_id && dto.department_id !== old.department_id) {
          const busy = await trx.selectFrom('beds').select('id').where('ward_id', '=', old.id).where('status', 'in', ['occupied', 'reserved']).executeTakeFirst();
          if (busy) throw new ConflictException('პალატაში დაკავებული / დაჯავშნილი საწოლია — სხვა განყოფილებაში ვერ გადავა');
        }
        if (old && dto.is_active === false) {
          const busy = await trx.selectFrom('beds').select('code').where('ward_id', '=', old.id).where('is_active', '=', true).where('status', 'in', ['occupied', 'reserved']).executeTakeFirst();
          if (busy) throw new ConflictException(`საწოლი ${busy.code} დაკავებული / დაჯავშნილია — პალატა ვერ გაითიშება`);
          await trx.updateTable('beds').set({ is_active: false }).where('ward_id', '=', old.id).where('is_active', '=', true).execute();
        }
        const vals = { ...(dto.department_id && { department_id: dto.department_id }), ...(dto.code && { code: dto.code.trim() }), ...(dto.name !== undefined && { name: dto.name?.trim() || null }),
          ...(dto.floor !== undefined && { floor: dto.floor?.trim() || null }), ...(dto.sex && { sex: dto.sex }), ...(dto.isolation_capable !== undefined && { isolation_capable: dto.isolation_capable }),
          ...(dto.is_active !== undefined && { is_active: dto.is_active }), ...(dto.sort_order !== undefined && { sort_order: dto.sort_order }) };
        const w = old ? await trx.updateTable('wards').set(vals).where('id', '=', old.id).returningAll().executeTakeFirstOrThrow()
          : await trx.insertInto('wards').values({ department_id: dto.department_id!, code: dto.code!.trim(), name: dto.name?.trim() || null, floor: dto.floor?.trim() || null,
            sex: dto.sex ?? 'mixed', isolation_capable: dto.isolation_capable ?? false, sort_order: dto.sort_order ?? 100 }).returningAll().executeTakeFirstOrThrow();
        await this.audit.log(ctx, { action: old ? 'UPDATE_WARD' : 'CREATE_WARD', entityName: 'wards', entityId: w.id, oldData: old ?? undefined, newData: w }, trx);
        return w;
      });
    } catch (e) { mapPgError(e, { wards_department_id_code_key: 'განყოფილებაში ამ ნომრით პალატა უკვე არსებობს' }); }
  }

  /** პალატაში N საწოლი, ავტომატური დანომრვით (არსებული კოდები გამოიტოვება) */
  async addBeds(wardId: string, dto: BedsBulkDto, ctx: AuditContext) {
    const s = await this.settings();
    if (dto.is_overflow && !s.overflow_beds) throw new BadRequestException('დამატებითი საწოლები გამორთულია (მოდულები → სტაციონარი)');
    return this.db.transaction().execute(async (trx) => {
      const w = await trx.selectFrom('wards').selectAll().where('id', '=', wardId).forUpdate().executeTakeFirst();
      if (!w || !w.is_active) throw new NotFoundException('პალატა ვერ მოიძებნა ან გათიშულია');
      const type = dto.type_code ?? 'standard';
      if (!(await trx.selectFrom('bed_types').select('code').where('code', '=', type).where('is_active', '=', true).executeTakeFirst())) throw new BadRequestException('საწოლის ტიპი ვერ მოიძებნა');
      const prefix = dto.prefix ?? (dto.is_overflow ? `${w.code}-D` : `${w.code}-`);
      const existing = new Set((await trx.selectFrom('beds').select('code').where('ward_id', '=', w.id).execute()).map((b) => b.code));
      const max = (await trx.selectFrom('beds').select(sql<number>`coalesce(max(sort_order), 0)::int`.as('m')).where('ward_id', '=', w.id).executeTakeFirstOrThrow()).m;
      const codes: string[] = [];
      for (let n = 1; codes.length < dto.count && n < 1000; n++) if (!existing.has(`${prefix}${n}`)) codes.push(`${prefix}${n}`);
      const beds = await trx.insertInto('beds').values(codes.map((code, i) => ({ ward_id: w.id, code, type_code: type, is_overflow: !!dto.is_overflow, sort_order: max + (i + 1) * 10 }))).returningAll().execute();
      await this.audit.log(ctx, { action: 'CREATE_BEDS', entityName: 'wards', entityId: w.id, newData: { codes, type, is_overflow: !!dto.is_overflow } }, trx);
      return beds;
    });
  }

  async updateBed(id: string, dto: BedDto, ctx: AuditContext) {
    const s = await this.settings();
    try {
      return await this.db.transaction().execute(async (trx) => {
        const b = await trx.selectFrom('beds').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
        if (!b) throw new NotFoundException('საწოლი ვერ მოიძებნა');
        if (dto.is_active === false && ['occupied', 'reserved'].includes(b.status)) throw new ConflictException(`საწოლი ${b.code} დაკავებული / დაჯავშნილია — ვერ გაითიშება`);
        if (dto.is_overflow && !s.overflow_beds) throw new BadRequestException('დამატებითი საწოლები გამორთულია');
        if (dto.is_active === true) {
          const w = await trx.selectFrom('wards').select('is_active').where('id', '=', b.ward_id).executeTakeFirstOrThrow();
          if (!w.is_active) throw new ConflictException('პალატა გათიშულია — ჯერ პალატა ჩართეთ');
        }
        const r = await trx.updateTable('beds').set({ ...(dto.code && { code: dto.code.trim() }), ...(dto.type_code && { type_code: dto.type_code }), ...(dto.is_overflow !== undefined && { is_overflow: dto.is_overflow }),
          ...(dto.is_active !== undefined && { is_active: dto.is_active }), ...(dto.sort_order !== undefined && { sort_order: dto.sort_order }) }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
        await this.audit.log(ctx, { action: 'UPDATE_BED', entityName: 'beds', entityId: id, oldData: b, newData: r }, trx);
        return r;
      });
    } catch (e) { mapPgError(e, { beds_ward_id_code_key: 'პალატაში ამ აღნიშვნით საწოლი უკვე არსებობს', beds_type_code_fkey: 'საწოლის ტიპი ვერ მოიძებნა' }); }
  }

  async saveBedType(code: string | null, dto: BedTypeDto, ctx: AuditContext) {
    await this.settings();
    try {
      const r = code ? await this.db.updateTable('bed_types').set({ ...(dto.name && { name: dto.name.trim() }), ...(dto.is_active !== undefined && { is_active: dto.is_active }),
        ...(dto.sort_order !== undefined && { sort_order: dto.sort_order }) }).where('code', '=', code).returningAll().executeTakeFirst()
        : await this.db.insertInto('bed_types').values({ code: dto.code!, name: dto.name!.trim(), sort_order: dto.sort_order ?? 100 }).returningAll().executeTakeFirst();
      if (!r) throw new NotFoundException('საწოლის ტიპი ვერ მოიძებნა');
      await this.audit.log(ctx, { action: code ? 'UPDATE_BED_TYPE' : 'CREATE_BED_TYPE', entityName: 'bed_types', entityId: r.code, newData: dto });
      return r;
    } catch (e) { mapPgError(e, { bed_types_pkey: 'ეს კოდი უკვე არსებობს' }); }
  }

  // ================================================================= პრინტერები
  printers(kind?: string) {
    let q = this.db.selectFrom('label_printers as p').leftJoin('departments as d', 'd.id', 'p.department_id').selectAll('p').select('d.name as department_name').orderBy('p.name');
    if (kind) q = q.where('p.kind', '=', kind);
    return q.execute();
  }
  async savePrinter(id: string | null, dto: PrinterDto, ctx: AuditContext) {
    if (!id && (!dto.name || !dto.host)) throw new BadRequestException('name და host სავალდებულოა');
    try {
      const vals = { ...(dto.name && { name: dto.name.trim() }), ...(dto.kind && { kind: dto.kind }), ...(dto.host && { host: dto.host.trim() }), ...(dto.port && { port: dto.port }),
        ...(dto.dpi && { dpi: dto.dpi }), ...(dto.department_id !== undefined && { department_id: dto.department_id }), ...(dto.is_active !== undefined && { is_active: dto.is_active }) };
      const r = id ? await this.db.updateTable('label_printers').set(vals).where('id', '=', id).returningAll().executeTakeFirst()
        : await this.db.insertInto('label_printers').values({ name: dto.name!.trim(), host: dto.host!.trim(), kind: dto.kind ?? 'wristband', port: dto.port ?? 9100, dpi: dto.dpi ?? 203,
          department_id: dto.department_id ?? null }).returningAll().executeTakeFirst();
      if (!r) throw new NotFoundException('პრინტერი ვერ მოიძებნა');
      await this.audit.log(ctx, { action: id ? 'UPDATE_PRINTER' : 'CREATE_PRINTER', entityName: 'label_printers', entityId: r.id, newData: dto });
      return r;
    } catch (e) { mapPgError(e, { label_printers_name_key: 'ამ სახელით პრინტერი უკვე არსებობს', label_printers_department_id_fkey: 'განყოფილება ვერ მოიძებნა' }); }
  }
  /** კავშირის შემოწმება; print=true — სატესტო სამაჯური */
  async testPrinter(id: string, print: boolean) {
    const p = await this.db.selectFrom('label_printers').selectAll().where('id', '=', id).executeTakeFirst();
    if (!p) throw new NotFoundException('პრინტერი ვერ მოიძებნა');
    let ms: number;
    try { ms = await probe(p.host, p.port); } catch (e) { throw new ConflictException({ code: 'PRINTER_UNREACHABLE', message: (e as Error).message }); }
    if (print) {
      const s = await this.settings();
      const clinic = await this.db.selectFrom('clinic_settings').select('name').executeTakeFirst();
      const data: WristbandData = { adm_no: 'IP00-000000', last_name: 'სატესტო', first_name: 'ბეჭდვა', birth_date: '2000-01-01', age: '—', sex: '—', personal_number: null,
        department: `${p.name} · ${p.host}`, bed: null, admitted_at: new Date(), allergies: [], clinic: clinic?.name ?? 'EMR' };
      try { await sendRaw(p.host, p.port, await wristbandZpl(data, this.band(s), p.dpi)); } catch (e) { throw new ConflictException({ code: 'PRINTER_ERROR', message: (e as Error).message }); }
    }
    return { ok: true, ms, printed: print };
  }
  private band(s: InpatientSettings) { return { width_mm: s.wristband_width_mm, length_mm: s.wristband_length_mm, offset_mm: s.wristband_offset_mm }; }

  // ================================================================= დაფა / საწოლფონდის მდგომარეობა
  async census(u: AuthUser) {
    const s = await this.settings();
    const me = await this.me(u);
    const rows = await this.db.selectFrom('departments as d').leftJoin('wards as w', (j) => j.onRef('w.department_id', '=', 'd.id').on('w.is_active', '=', true))
      .leftJoin('beds as b', (j) => j.onRef('b.ward_id', '=', 'w.id').on('b.is_active', '=', true))
      .select(['d.id', 'd.name',
        sql<number>`count(b.id) FILTER (WHERE NOT b.is_overflow)::int`.as('beds'),
        sql<number>`count(b.id) FILTER (WHERE b.is_overflow)::int`.as('overflow'),
        sql<number>`count(b.id) FILTER (WHERE b.status = 'free' AND NOT b.is_overflow)::int`.as('free'),
        sql<number>`count(b.id) FILTER (WHERE b.status = 'occupied')::int`.as('occupied'),
        sql<number>`count(b.id) FILTER (WHERE b.status = 'occupied' AND b.is_overflow)::int`.as('occupied_overflow'),
        sql<number>`count(b.id) FILTER (WHERE b.status = 'reserved')::int`.as('reserved'),
        sql<number>`count(b.id) FILTER (WHERE b.status = 'cleaning')::int`.as('cleaning'),
        sql<number>`count(b.id) FILTER (WHERE b.status = 'blocked')::int`.as('blocked'),
        sql<number>`(SELECT count(*)::int FROM bed_assignments a WHERE a.department_id = d.id AND a.ended_at IS NULL AND a.bed_id IS NULL)`.as('awaiting'),
        sql<number>`(SELECT count(*)::int FROM inpatient_planned p WHERE p.department_id = d.id AND p.status = 'waiting' AND p.planned_date = (now() AT TIME ZONE ${TZ})::date)`.as('planned_today')])
      .where('d.type', '=', 'inpatient').where('d.is_active', '=', true).groupBy(['d.id', 'd.name']).orderBy('d.name').execute();
    return { settings: s, departments: rows, my_department_id: me.department_id };
  }

  async board(departmentId: string, u: AuthUser) {
    const s = await this.settings();
    const dep = await this.department(departmentId);
    const occRaw = await this.db.selectFrom('bed_assignments as a').innerJoin('inpatient_stays as st', 'st.encounter_id', 'a.encounter_id')
      .innerJoin('encounters as e', 'e.id', 'a.encounter_id').innerJoin('patients as p', 'p.id', 'st.patient_id').leftJoin('users as d', 'd.id', 'e.attending_doctor_id')
      .select(['a.bed_id', 'a.encounter_id', 'a.started_at', 'st.adm_no', 'st.severity', 'st.isolation', 'st.admitted_at', 'p.id as patient_id', 'p.first_name', 'p.last_name', 'p.birth_date', 'p.gender',
        'e.attending_doctor_id', sql<string | null>`d.last_name || ' ' || left(d.first_name, 1) || '.'`.as('doctor_name'),
        sql<number>`((now() AT TIME ZONE ${TZ})::date - (st.admitted_at AT TIME ZONE ${TZ})::date)::int`.as('day'),
        sql<string | null>`(SELECT x.icd10_code || ' ' || x.icd10_title FROM encounter_diagnoses x WHERE x.encounter_id = e.id ORDER BY (x.diagnosis_type = 'primary') DESC, (x.diagnosis_type = 'admission') DESC, x.created_at LIMIT 1)`.as('diagnosis'),
        sql<number>`(SELECT count(*)::int FROM patient_allergies al WHERE al.patient_id = p.id AND al.is_active)`.as('allergies'),
        // 0041: სავალდებულო თანხმობები (document_templates.required_on_admission) — consent = ყველა გაცემულია; consents_missing — რომელი აკლია
        sql<string[]>`ARRAY(SELECT t.name FROM document_templates t WHERE t.required_on_admission AND t.is_active AND NOT EXISTS (
          SELECT 1 FROM patient_consents c WHERE c.type_code = t.code AND c.patient_id = p.id AND (t.scope = 'patient' OR c.encounter_id = e.id)
            AND c.decision = 'granted' AND c.revoked_at IS NULL) ORDER BY t.sort_order)`.as('consents_missing'),
        sql<string | null>`(SELECT td.name FROM inpatient_transfers t JOIN departments td ON td.id = t.to_department_id WHERE t.encounter_id = a.encounter_id AND t.status = 'requested')`.as('transfer_to'),
        sql<string | null>`(SELECT to_char(l.expected_return_at AT TIME ZONE ${TZ}, 'DD.MM HH24:MI') FROM inpatient_leaves l WHERE l.encounter_id = a.encounter_id AND l.returned_at IS NULL)`.as('on_leave_until'),
        // 0044: ბოლო NEWS2 (24 სთ), შკალების რისკები (საშუალო / მაღალი), ხაზები
        sql<{ score: number; level: string; at: string } | null>`(SELECT json_build_object('score', v.news2, 'level', v.news2_level, 'at', v.recorded_at) FROM encounter_vitals v
          WHERE v.encounter_id = a.encounter_id AND v.voided_at IS NULL AND v.news2 IS NOT NULL AND v.recorded_at > now() - interval '24 hours' ORDER BY v.recorded_at DESC LIMIT 1)`.as('news2'),
        sql<{ label: string; level: string }[]>`(SELECT coalesce(json_agg(json_build_object('label', d.risk_label, 'level', x.level) ORDER BY d.sort_order), '[]'::json) FROM (
          SELECT DISTINCT ON (sa.scale_code) sa.scale_code, sa.level FROM scale_assessments sa WHERE sa.encounter_id = a.encounter_id AND sa.voided_at IS NULL
          ORDER BY sa.scale_code, sa.assessed_at DESC) x JOIN scale_defs d ON d.code = x.scale_code WHERE d.risk_label IS NOT NULL AND x.level IN ('medium', 'high'))`.as('risks'),
        sql<number>`(SELECT count(*)::int FROM lines_drains ld WHERE ld.encounter_id = a.encounter_id AND ld.removed_at IS NULL AND ld.voided_at IS NULL)`.as('lines')])
      .where('a.department_id', '=', departmentId).where('a.ended_at', 'is', null).orderBy('a.started_at').execute();
    const occ = occRaw.map((o) => ({ ...o, consent: o.consents_missing.length === 0 }));
    const reserved = await this.db.selectFrom('inpatient_planned as pl').innerJoin('patients as p', 'p.id', 'pl.patient_id')
      .select(['pl.id', 'pl.bed_id', 'pl.plan_no', 'pl.planned_date', sql<string>`p.last_name || ' ' || p.first_name`.as('patient_name')])
      .where('pl.department_id', '=', departmentId).where('pl.status', '=', 'waiting').where('pl.bed_id', 'is not', null).execute();
    const st = await this.structure(false);
    const wards = st.departments.find((d) => d.id === departmentId)?.wards ?? [];
    return {
      department: dep, settings: s, can_assign: await this.canAssign(u, departmentId, s), can_manage: await this.isHead(u, departmentId),
      wards: wards.map((w) => ({ ...w, beds: w.beds.map((b) => ({ ...b, occupant: occ.find((o) => o.bed_id === b.id) ?? null, reservation: reserved.find((r) => r.bed_id === b.id) ?? null })) })),
      awaiting: occ.filter((o) => !o.bed_id),
      // 0041: გადმოყვანის მოთხოვნები ამ განყოფილებაში
      incoming_transfers: await this.db.selectFrom('inpatient_transfers as t').innerJoin('inpatient_stays as st', 'st.encounter_id', 't.encounter_id')
        .innerJoin('patients as p', 'p.id', 'st.patient_id').innerJoin('departments as fd', 'fd.id', 't.from_department_id')
        .select(['t.id', 't.encounter_id', 't.reason', 't.requested_at', 'st.adm_no', 'st.severity', 'st.isolation', 'p.first_name', 'p.last_name', 'p.gender', 'fd.name as from_department'])
        .where('t.to_department_id', '=', departmentId).where('t.status', '=', 'requested').orderBy('t.requested_at').execute(),
    };
  }

  // ================================================================= ჰოსპიტალიზაცია
  async admit(dto: AdmitDto, u: AuthUser, ctx: AuditContext) {
    const s = await this.settings();
    if (dto.source === 'transfer_in' && !dto.referring_institution?.trim()) throw new BadRequestException('სხვა კლინიკიდან გადმოყვანისას მიუთითეთ დაწესებულება');
    if (dto.planned_id && !s.planned_queue) throw new BadRequestException('გეგმიური რიგი გამორთულია');
    try {
      const out = await this.db.transaction().execute(async (trx) => {
        const patient = await trx.selectFrom('patients').select(['id', 'gender', 'is_deceased', 'first_name', 'last_name']).where('id', '=', dto.patient_id).forUpdate().executeTakeFirst();
        if (!patient) throw new NotFoundException('პაციენტი ვერ მოიძებნა');
        if (patient.is_deceased) throw new BadRequestException('პაციენტი გარდაცვლილად არის მონიშნული');
        const active = await trx.selectFrom('inpatient_stays').select('adm_no').where('patient_id', '=', patient.id).where('status', '=', 'active').executeTakeFirst();
        if (active) throw new ConflictException({ code: 'ALREADY_ADMITTED', message: `პაციენტი უკვე ჰოსპიტალიზებულია (${active.adm_no})` });
        const dep = await this.department(dto.department_id, trx);
        await this.doctor(dto.attending_doctor_id, trx);
        const icd = await this.icd(dto.icd10_code, trx);

        // წყარო: ვიზიტი / მიმართვა / გეგმიური
        if (dto.source_encounter_id) {
          const src = await trx.selectFrom('encounters').select(['patient_id', 'status', 'type']).where('id', '=', dto.source_encounter_id).executeTakeFirst();
          if (!src || src.patient_id !== patient.id) throw new BadRequestException('წყარო ვიზიტი სხვა პაციენტისაა ან არ არსებობს');
          if (src.type === 'inpatient') throw new BadRequestException('წყარო ვიზიტი სტაციონარულია');
          if (src.status === 'cancelled') throw new BadRequestException('წყარო ვიზიტი გაუქმებულია');
        }
        let referral: { id: string; encounter_id: string } | undefined;
        if (dto.referral_id) {
          const r = await trx.selectFrom('referrals as r').innerJoin('encounters as e', 'e.id', 'r.encounter_id').select(['r.id', 'r.encounter_id', 'r.type', 'r.status', 'e.patient_id'])
            .where('r.id', '=', dto.referral_id).forUpdate('r').executeTakeFirst();
          if (!r || r.patient_id !== patient.id || r.type !== 'hospitalization') throw new BadRequestException('ჰოსპიტალიზაციის მიმართვა ვერ მოიძებნა');
          if (!['requested', 'in_progress'].includes(r.status)) throw new ConflictException('მიმართვა უკვე დასრულებული / გაუქმებულია');
          referral = r;
        }
        let planned: { id: string; bed_id: string | null } | undefined;
        if (dto.planned_id) {
          const pl = await trx.selectFrom('inpatient_planned').select(['id', 'patient_id', 'status', 'bed_id', 'department_id']).where('id', '=', dto.planned_id).forUpdate().executeTakeFirst();
          if (!pl || pl.patient_id !== patient.id) throw new BadRequestException('გეგმიური ჩანაწერი ვერ მოიძებნა');
          if (pl.status !== 'waiting') throw new ConflictException('გეგმიური ჩანაწერი უკვე დამუშავებულია');
          if (pl.department_id !== dto.department_id && pl.bed_id) throw new BadRequestException('დაჯავშნილი საწოლი სხვა განყოფილებაშია — ჯერ მოხსენით დაჯავშნა');
          planned = pl;
        }

        // საწოლი: მითითებული ან გეგმიურზე დაჯავშნილი
        const bedId = dto.bed_id ?? planned?.bed_id ?? undefined;
        if (dto.bed_id && !(await this.canAssign(u, dep.id, s, trx))) {
          throw new ForbiddenException('საწოლს ანიჭებს განყოფილება (ორეტაპიანი მინიჭება) — ჰოსპიტალიზაცია გააფორმეთ საწოლის გარეშე');
        }
        const bed = bedId ? await this.lockBed(trx, bedId, { departmentId: dep.id, gender: patient.gender, isolation: dto.isolation, plannedId: planned?.id, confirm: dto.confirm }, s) : null;

        const enc = await trx.insertInto('encounters').values({ patient_id: patient.id, attending_doctor_id: dto.attending_doctor_id, department_id: dep.id, type: 'inpatient', status: 'active',
          chief_complaint: dto.chief_complaint?.trim() || null, parent_encounter_id: dto.source_encounter_id ?? referral?.encounter_id ?? null }).returningAll().executeTakeFirstOrThrow();
        await trx.insertInto('invoices').values({ encounter_id: enc.id, total_amount: '0', patient_share: '0',
          invoice_number: sql<string>`'INV-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('invoice_number_seq')::text, 6, '0')` }).execute();
        const admNo = await this.nextNo(trx, 'inpatient_admission', 'IP');
        await trx.insertInto('inpatient_stays').values({ encounter_id: enc.id, adm_no: admNo, patient_id: patient.id, source: dto.source, source_encounter_id: dto.source_encounter_id ?? referral?.encounter_id ?? null,
          referral_id: referral?.id ?? null, planned_id: planned?.id ?? null, referring_institution: dto.referring_institution?.trim() || null,
          severity: dto.severity ?? null, isolation: dto.isolation ?? null, admitted_by: u.id }).execute();
        await trx.insertInto('bed_assignments').values({ encounter_id: enc.id, department_id: dep.id, bed_id: bed?.id ?? null, bed_at: bed ? sql`now()` : null, assigned_by: u.id, bed_by: bed ? u.id : null }).execute();
        if (bed) await this.setBed(trx, bed.id, 'occupied', u);
        await trx.insertInto('encounter_diagnoses').values({ encounter_id: enc.id, icd10_code: icd.code, icd10_title: icd.title, diagnosis_type: 'admission', diagnosed_by: u.id }).execute();
        if (referral) await trx.updateTable('referrals').set({ status: 'completed', completed_at: sql`now()`, result_text: `ჰოსპიტალიზებულია: ${admNo}, ${dep.name}` }).where('id', '=', referral.id).execute();
        if (planned) await trx.updateTable('inpatient_planned').set({ status: 'admitted', encounter_id: enc.id }).where('id', '=', planned.id).execute();
        if (planned?.bed_id && planned.bed_id !== bed?.id) {                                                        // დაჯავშნილის ნაცვლად სხვა საწოლი
          await trx.selectFrom('beds').select('id').where('id', '=', planned.bed_id).forUpdate().execute();
          await this.setBed(trx, planned.bed_id, 'free', u);
        }

        await this.event(trx, { encounter_id: enc.id, bed_id: bed?.id, planned_id: planned?.id, kind: 'admitted', data: { adm_no: admNo, source: dto.source, department: dep.name, bed: bed?.code ?? null, warnings: bed?.warnings ?? [] } }, u);
        if (bed) await this.event(trx, { encounter_id: enc.id, bed_id: bed.id, kind: 'bed_assigned', data: { bed: bed.code, ward: bed.ward_code, warnings: bed.warnings } }, u);
        await this.audit.log(ctx, { action: 'INPATIENT_ADMIT', entityName: 'encounters', entityId: enc.id, newData: { adm_no: admNo, ...dto } }, trx);
        return { encounter_id: enc.id, adm_no: admNo, bed: bed?.code ?? null, department: dep, patient };
      });
      if (!out.bed) await this.notifyAwaiting(out.department.id, out.department.name, `${out.patient.last_name} ${out.patient.first_name}`, out.adm_no);
      return { encounter_id: out.encounter_id, adm_no: out.adm_no, bed: out.bed };
    } catch (e) { mapPgError(e, { ux_inpatient_stays_patient_active: 'პაციენტი უკვე ჰოსპიტალიზებულია', ux_bed_assignments_bed: 'საწოლი უკვე დაკავებულია' }); }
  }

  /** ორეტაპიანი: განყოფილების ექთნებს / ხელმძღვანელს — „პაციენტი ელოდება საწოლს“ */
  /** განყოფილების თანამშრომლებს (ჩამოთვლილი უფლებით) — შეტყობინება ზარში */
  async notifyDepartment(departmentId: string, caps: string[], n: { kind: string; title: string; body?: string; item?: string; entityId: string; link: string; urgent?: boolean }) {
    const ids = await this.db.selectFrom('users as u').innerJoin('user_capabilities as c', 'c.user_id', 'u.id').select('u.id').distinct()
      .where('u.is_active', '=', true).where('u.department_id', '=', departmentId).where(sql<boolean>`c.capabilities && ${sql.val(caps)}::varchar[]`).execute();
    for (const { id } of ids) await this.notifications.notify(id, { ...n, urgent: !!n.urgent });
  }
  private async notifyAwaiting(departmentId: string, depName: string, patient: string, admNo: string) {
    const ids = await this.db.selectFrom('users as u').innerJoin('user_capabilities as c', 'c.user_id', 'u.id').select('u.id').distinct()
      .where('u.is_active', '=', true).where('u.department_id', '=', departmentId).where(sql<boolean>`c.capabilities && ARRAY['nurse', 'manager']::varchar[]`).execute();
    for (const { id } of ids) {
      await this.notifications.notify(id, { kind: 'inpatient_awaiting', title: `${depName}: ახალი პაციენტი ელოდება საწოლს`, body: `${patient} (${admNo})`, item: admNo,
        entityId: departmentId, link: `/inpatient?tab=board&department_id=${departmentId}`, urgent: false });
    }
  }

  /** საწოლის მინიჭება (ეპიზოდს საწოლი ჯერ არ აქვს) ან შეცვლა იმავე განყოფილებაში (მიზეზით) */
  async assignBed(encounterId: string, dto: BedAssignDto, u: AuthUser, ctx: AuditContext) {
    const s = await this.settings();
    try {
      return await this.db.transaction().execute(async (trx) => {
        const st = await this.lockStay(trx, encounterId);
        const cur = await trx.selectFrom('bed_assignments').selectAll().where('encounter_id', '=', encounterId).where('ended_at', 'is', null).forUpdate().executeTakeFirstOrThrow();
        if (!(await this.canAssign(u, cur.department_id, s, trx))) throw new ForbiddenException('საწოლს ანიჭებს განყოფილების თანამშრომელი');
        if (cur.bed_id === dto.bed_id) throw new ConflictException('პაციენტი უკვე ამ საწოლზეა');
        const gender = (await trx.selectFrom('patients').select('gender').where('id', '=', st.patient_id).executeTakeFirstOrThrow()).gender;
        const bed = await this.lockBed(trx, dto.bed_id, { departmentId: cur.department_id, gender, isolation: st.isolation, confirm: dto.confirm }, s);
        if (!cur.bed_id) {
          await trx.updateTable('bed_assignments').set({ bed_id: bed.id, bed_at: sql`now()`, bed_by: u.id }).where('id', '=', cur.id).execute();
          await this.setBed(trx, bed.id, 'occupied', u);
          await this.event(trx, { encounter_id: encounterId, bed_id: bed.id, kind: 'bed_assigned', data: { bed: bed.code, ward: bed.ward_code, warnings: bed.warnings } }, u);
        } else {
          if (!dto.reason?.trim() || dto.reason.trim().length < 3) throw new BadRequestException('საწოლის შეცვლას სჭირდება მიზეზი');
          const old = await trx.selectFrom('beds').select(['id', 'code']).where('id', '=', cur.bed_id).forUpdate().executeTakeFirstOrThrow();
          await trx.updateTable('bed_assignments').set({ ended_at: sql`now()`, ended_by: u.id, end_kind: 'bed_change' }).where('id', '=', cur.id).execute();
          await this.releaseBed(trx, old.id, s, u);
          await trx.insertInto('bed_assignments').values({ encounter_id: encounterId, department_id: cur.department_id, bed_id: bed.id, bed_at: sql`now()`, reason: dto.reason.trim(), assigned_by: u.id, bed_by: u.id }).execute();
          await this.setBed(trx, bed.id, 'occupied', u);
          await this.event(trx, { encounter_id: encounterId, bed_id: bed.id, kind: 'bed_changed', data: { from: old.code, to: bed.code, reason: dto.reason.trim(), warnings: bed.warnings } }, u);
          await this.event(trx, { bed_id: old.id, encounter_id: encounterId, kind: 'bed_released', data: { bed: old.code, to: s.cleaning_required ? 'cleaning' : 'free' } }, u);
        }
        await this.audit.log(ctx, { action: cur.bed_id ? 'INPATIENT_BED_CHANGE' : 'INPATIENT_BED_ASSIGN', entityName: 'encounters', entityId: encounterId, newData: { bed_id: bed.id, reason: dto.reason } }, trx);
        return { encounter_id: encounterId, bed: bed.code };
      });
    } catch (e) { mapPgError(e, { ux_bed_assignments_bed: 'საწოლი უკვე დაკავებულია' }); }
  }

  async lockStay(trx: Trx, encounterId: string) {
    const st = await trx.selectFrom('inpatient_stays').selectAll().where('encounter_id', '=', encounterId).forUpdate().executeTakeFirst();
    if (!st) throw new NotFoundException('ჰოსპიტალიზაცია ვერ მოიძებნა');
    if (st.status !== 'active') throw new ConflictException('ჰოსპიტალიზაცია აქტიური არ არის');
    return st;
  }

  async patchStay(encounterId: string, dto: StayPatchDto, u: AuthUser, ctx: AuditContext) {
    await this.settings();
    return this.db.transaction().execute(async (trx) => {
      const st = await this.lockStay(trx, encounterId);
      const e = await trx.selectFrom('encounters').select(['attending_doctor_id', 'department_id']).where('id', '=', encounterId).forUpdate().executeTakeFirstOrThrow();
      const staff = await this.isStaff(u, e.department_id, trx);
      const changes: Record<string, unknown> = {};
      if (dto.severity !== undefined || dto.isolation !== undefined) {
        if (!staff && e.attending_doctor_id !== u.id) throw new ForbiddenException('მდგომარეობას / იზოლაციას ცვლის განყოფილების თანამშრომელი ან მკურნალი ექიმი');
        if (dto.severity !== undefined && dto.severity !== st.severity) {
          await trx.updateTable('inpatient_stays').set({ severity: dto.severity }).where('encounter_id', '=', encounterId).execute();
          await this.event(trx, { encounter_id: encounterId, kind: 'severity', data: { from: st.severity, to: dto.severity } }, u); changes.severity = dto.severity;
        }
        if (dto.isolation !== undefined && dto.isolation !== st.isolation) {
          await trx.updateTable('inpatient_stays').set({ isolation: dto.isolation }).where('encounter_id', '=', encounterId).execute();
          await this.event(trx, { encounter_id: encounterId, kind: 'isolation', data: { from: st.isolation, to: dto.isolation, reason: dto.reason ?? null } }, u); changes.isolation = dto.isolation;
        }
      }
      if (dto.attending_doctor_id && dto.attending_doctor_id !== e.attending_doctor_id) {
        if (!(await this.isHead(u, e.department_id, trx)) && e.attending_doctor_id !== u.id) throw new ForbiddenException('მკურნალ ექიმს ცვლის განყოფილების ხელმძღვანელი, admin ან ამჟამინდელი მკურნალი ექიმი');
        if (!dto.reason?.trim()) throw new BadRequestException('მკურნალი ექიმის შეცვლას სჭირდება მიზეზი');
        const d = await this.doctor(dto.attending_doctor_id, trx);
        await trx.updateTable('encounters').set({ attending_doctor_id: d.id }).where('id', '=', encounterId).execute();
        await this.event(trx, { encounter_id: encounterId, kind: 'attending_changed', data: { from: e.attending_doctor_id, to: d.id, to_name: `${d.last_name} ${d.first_name}`, reason: dto.reason.trim() } }, u);
        changes.attending_doctor_id = d.id;
      }
      if (Object.keys(changes).length) await this.audit.log(ctx, { action: 'INPATIENT_UPDATE', entityName: 'encounters', entityId: encounterId, newData: { ...changes, reason: dto.reason } }, trx);
      return { encounter_id: encounterId, changed: Object.keys(changes) };
    });
  }

  /** ჰოსპიტალიზაციის გაუქმება (შეცდომა): cancel_hours-ის განმავლობაში, თუ ვიზიტზე ჯერ არაფერია ჩაწერილი */
  async cancel(encounterId: string, reason: string, u: AuthUser, ctx: AuditContext) {
    const s = await this.settings();
    return this.db.transaction().execute(async (trx) => {
      const st = await this.lockStay(trx, encounterId);
      const e = await trx.selectFrom('encounters').select(['attending_doctor_id']).where('id', '=', encounterId).forUpdate().executeTakeFirstOrThrow();
      if (!has(u, 'admin')) {
        if (st.admitted_by !== u.id && e.attending_doctor_id !== u.id) throw new ForbiddenException('გაუქმება — ვინც გააფორმა, მკურნალი ექიმი ან admin');
        const hours = (Date.now() - new Date(st.admitted_at).getTime()) / 3_600_000;
        if (hours > s.cancel_hours) throw new ConflictException(`გაუქმების ვადა (${s.cancel_hours} სთ) გასულია — მიმართეთ ადმინისტრატორს`);
      }
      const used = await sql<{ n: number }>`SELECT (
          (SELECT count(*) FROM invoice_line_items l JOIN invoices i ON i.id = l.invoice_id WHERE i.encounter_id = ${encounterId})
        + (SELECT count(*) FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE i.encounter_id = ${encounterId})
        + (SELECT count(*) FROM dx_order_items x WHERE x.encounter_id = ${encounterId} AND x.status <> 'cancelled')
        + (SELECT count(*) FROM stock_docs d WHERE d.encounter_id = ${encounterId})
        + (SELECT count(*) FROM cssd_packs c WHERE c.encounter_id = ${encounterId})
        + (SELECT count(*) FROM encounter_vitals v WHERE v.encounter_id = ${encounterId})
        + (SELECT count(*) FROM prescriptions r WHERE r.encounter_id = ${encounterId})
        + (SELECT count(*) FROM med_orders mo WHERE mo.encounter_id = ${encounterId})
        + (SELECT count(*) FROM fluid_entries fe WHERE fe.encounter_id = ${encounterId})
        + (SELECT count(*) FROM scale_assessments sa WHERE sa.encounter_id = ${encounterId})
        + (SELECT count(*) FROM lines_drains ld WHERE ld.encounter_id = ${encounterId})
        + (SELECT count(*) FROM nursing_notes nn WHERE nn.encounter_id = ${encounterId}))::int AS n`.execute(trx);
      if (used.rows[0].n > 0) throw new ConflictException({ code: 'STAY_IN_USE', message: 'ვიზიტზე უკვე არის ჩანაწერები (მომსახურება, შეკვეთები, დანიშნულებები, ხარჯი, ვიტალები) — გაუქმება შეუძლებელია; გამოიყენეთ გაწერა' });
      const cur = await trx.selectFrom('bed_assignments').selectAll().where('encounter_id', '=', encounterId).where('ended_at', 'is', null).forUpdate().executeTakeFirst();
      if (cur) {
        await trx.updateTable('bed_assignments').set({ ended_at: sql`now()`, ended_by: u.id, end_kind: 'cancel' }).where('id', '=', cur.id).execute();
        if (cur.bed_id) { await trx.selectFrom('beds').select('id').where('id', '=', cur.bed_id).forUpdate().execute(); await this.releaseBed(trx, cur.bed_id, s, u); }
      }
      await trx.updateTable('inpatient_stays').set({ status: 'cancelled', cancel_reason: reason, ended_at: sql`now()` }).where('encounter_id', '=', encounterId).execute();
      await trx.updateTable('encounters').set({ status: 'cancelled', end_time: sql`now()` }).where('id', '=', encounterId).execute();
      if (st.planned_id) await trx.updateTable('inpatient_planned').set({ status: 'waiting', encounter_id: null, bed_id: null }).where('id', '=', st.planned_id).execute();
      if (st.referral_id) await trx.updateTable('referrals').set({ status: 'requested', completed_at: null, result_text: null }).where('id', '=', st.referral_id).execute();
      await this.event(trx, { encounter_id: encounterId, bed_id: cur?.bed_id, kind: 'cancelled', data: { reason } }, u);
      await this.audit.log(ctx, { action: 'INPATIENT_CANCEL', entityName: 'encounters', entityId: encounterId, newData: { reason } }, trx);
      return { encounter_id: encounterId, status: 'cancelled' };
    });
  }

  async stays(q: { status?: string; department_id?: string; search?: string; patient_id?: string }) {
    await this.settings();
    let x = this.db.selectFrom('inpatient_stays as st').innerJoin('encounters as e', 'e.id', 'st.encounter_id').innerJoin('patients as p', 'p.id', 'st.patient_id')
      .innerJoin('departments as d', 'd.id', 'e.department_id').leftJoin('users as doc', 'doc.id', 'e.attending_doctor_id')
      .leftJoin('bed_assignments as a', (j) => j.onRef('a.encounter_id', '=', 'st.encounter_id').on('a.ended_at', 'is', null)).leftJoin('beds as b', 'b.id', 'a.bed_id')
      .select(['st.encounter_id', 'st.adm_no', 'st.status', 'st.source', 'st.severity', 'st.isolation', 'st.admitted_at', 'st.ended_at', 'p.id as patient_id', 'p.first_name', 'p.last_name', 'p.personal_number',
        'p.birth_date', 'p.gender', 'e.department_id', 'd.name as department_name', 'b.code as bed_code', sql<string | null>`doc.last_name || ' ' || doc.first_name`.as('doctor_name')])
      .orderBy('st.admitted_at', 'desc').limit(300);
    if (q.status) x = x.where('st.status', 'in', q.status.split(','));
    if (q.department_id) x = x.where('e.department_id', '=', q.department_id);
    if (q.patient_id) x = x.where('st.patient_id', '=', q.patient_id);
    if (q.search?.trim()) {
      const t = q.search.trim();
      x = x.where((eb) => eb.or([eb('st.adm_no', '=', t.toUpperCase()), eb('p.personal_number', '=', t), eb(sql`lower(p.last_name || ' ' || p.first_name)`, 'like', `%${t.toLowerCase()}%`)]));
    }
    return x.execute();
  }

  async stay(encounterId: string, u: AuthUser, ctx: AuditContext) {
    const s = await this.settings();
    const st = await this.db.selectFrom('inpatient_stays as st').innerJoin('encounters as e', 'e.id', 'st.encounter_id').innerJoin('patients as p', 'p.id', 'st.patient_id')
      .innerJoin('departments as d', 'd.id', 'e.department_id').leftJoin('users as doc', 'doc.id', 'e.attending_doctor_id').leftJoin('users as adm', 'adm.id', 'st.admitted_by')
      .leftJoin('inpatient_planned as pl', 'pl.id', 'st.planned_id')
      .selectAll('st').select(['e.department_id', 'd.name as department_name', 'e.attending_doctor_id', 'e.chief_complaint', 'e.parent_encounter_id', 'pl.plan_no',
        sql<string | null>`doc.last_name || ' ' || doc.first_name`.as('doctor_name'), sql<string>`adm.last_name || ' ' || adm.first_name`.as('admitted_by_name'),
        'p.first_name', 'p.last_name', 'p.personal_number', 'p.birth_date', 'p.gender', 'p.phone_number'])
      .where('st.encounter_id', '=', encounterId).executeTakeFirst();
    if (!st) throw new NotFoundException('ჰოსპიტალიზაცია ვერ მოიძებნა');
    const [assignments, events, diagnoses, allergies, consent] = await Promise.all([
      this.db.selectFrom('bed_assignments as a').innerJoin('departments as d', 'd.id', 'a.department_id').leftJoin('beds as b', 'b.id', 'a.bed_id').leftJoin('wards as w', 'w.id', 'b.ward_id')
        .leftJoin('users as x', 'x.id', 'a.assigned_by').leftJoin('users as y', 'y.id', 'a.bed_by')
        .select(['a.id', 'a.department_id', 'd.name as department_name', 'a.bed_id', 'b.code as bed_code', 'w.code as ward_code', 'b.type_code', 'a.started_at', 'a.bed_at', 'a.ended_at', 'a.end_kind', 'a.reason',
          sql<string>`x.last_name || ' ' || x.first_name`.as('assigned_by_name'), sql<string | null>`y.last_name || ' ' || y.first_name`.as('bed_by_name')])
        .where('a.encounter_id', '=', encounterId).orderBy('a.id').execute(),
      this.db.selectFrom('inpatient_events as ev').leftJoin('users as x', 'x.id', 'ev.user_id').select(['ev.id', 'ev.kind', 'ev.data', 'ev.at', sql<string | null>`x.last_name || ' ' || x.first_name`.as('user_name')])
        .where('ev.encounter_id', '=', encounterId).orderBy('ev.id').execute(),
      this.db.selectFrom('encounter_diagnoses').select(['id', 'icd10_code', 'icd10_title', 'diagnosis_type', 'created_at']).where('encounter_id', '=', encounterId).orderBy('created_at').execute(),
      this.db.selectFrom('patient_allergies').select(['substance', 'severity', 'allergy_type']).where('patient_id', '=', st.patient_id).where('is_active', '=', true).execute(),
      this.db.selectFrom('patient_consents').select(['decision', 'signed_at', 'revoked_at']).where('encounter_id', '=', encounterId).where('type_code', '=', 'HOSPITALIZATION').orderBy('signed_at', 'desc').executeTakeFirst(),
    ]);
    const cur = assignments.find((a) => !a.ended_at) ?? null;
    await this.audit.log(ctx, { action: 'VIEW_INPATIENT', entityName: 'encounters', entityId: encounterId });
    const depId = cur?.department_id ?? st.department_id;
    return { ...st, current: cur, assignments, events, diagnoses, allergies, consent: consent ? (consent.revoked_at ? 'revoked' : consent.decision) : 'missing', settings: s,
      can: { assign: st.status === 'active' && await this.canAssign(u, depId, s), manage: await this.isHead(u, depId), staff: await this.isStaff(u, depId),
        cancel: st.status === 'active' && (has(u, 'admin') || st.admitted_by === u.id || st.attending_doctor_id === u.id) } };
  }

  // ================================================================= საწოლის სტატუსები
  async bedAction(bedId: string, action: 'clean' | 'block' | 'unblock', reason: string | undefined, u: AuthUser, ctx: AuditContext) {
    await this.settings();
    return this.db.transaction().execute(async (trx) => {
      const b = await trx.selectFrom('beds as b').innerJoin('wards as w', 'w.id', 'b.ward_id').select(['b.id', 'b.code', 'b.status', 'b.is_active', 'w.department_id'])
        .where('b.id', '=', bedId).forUpdate('b').executeTakeFirst();
      if (!b) throw new NotFoundException('საწოლი ვერ მოიძებნა');
      if (action === 'clean') {
        if (!(await this.isStaff(u, b.department_id, trx))) throw new ForbiddenException('დალაგებას ადასტურებს განყოფილების თანამშრომელი');
        if (b.status !== 'cleaning') throw new ConflictException('საწოლი დასალაგებელი არ არის');
        await this.setBed(trx, b.id, 'free', u);
        await this.event(trx, { bed_id: b.id, kind: 'bed_cleaned', data: { bed: b.code } }, u);
      } else if (action === 'block') {
        if (!(await this.isHead(u, b.department_id, trx))) throw new ForbiddenException('საწოლს ბლოკავს განყოფილების ხელმძღვანელი ან admin');
        if (!reason || reason.trim().length < 3) throw new BadRequestException('დაბლოკვას სჭირდება მიზეზი');
        if (!['free', 'cleaning'].includes(b.status)) throw new ConflictException('დაბლოკვა შესაძლებელია მხოლოდ თავისუფალ / დასალაგებელ საწოლზე');
        await this.setBed(trx, b.id, 'blocked', u, reason.trim());
        await this.event(trx, { bed_id: b.id, kind: 'bed_blocked', data: { bed: b.code, reason: reason.trim() } }, u);
      } else {
        if (!(await this.isHead(u, b.department_id, trx))) throw new ForbiddenException('ბლოკს ხსნის განყოფილების ხელმძღვანელი ან admin');
        if (b.status !== 'blocked') throw new ConflictException('საწოლი დაბლოკილი არ არის');
        await this.setBed(trx, b.id, 'free', u);
        await this.event(trx, { bed_id: b.id, kind: 'bed_unblocked', data: { bed: b.code } }, u);
      }
      await this.audit.log(ctx, { action: `BED_${action.toUpperCase()}`, entityName: 'beds', entityId: b.id, newData: { reason } }, trx);
      return trx.selectFrom('beds').selectAll().where('id', '=', b.id).executeTakeFirstOrThrow();
    });
  }

  bedHistory(bedId: string) {
    return this.db.selectFrom('inpatient_events as ev').leftJoin('users as x', 'x.id', 'ev.user_id').leftJoin('inpatient_stays as st', 'st.encounter_id', 'ev.encounter_id')
      .select(['ev.id', 'ev.kind', 'ev.data', 'ev.at', 'ev.encounter_id', 'st.adm_no', sql<string | null>`x.last_name || ' ' || x.first_name`.as('user_name')])
      .where('ev.bed_id', '=', bedId).orderBy('ev.id', 'desc').limit(200).execute();
  }

  // ================================================================= გეგმიური რიგი
  private async plannedOn() { const s = await this.settings(); if (!s.planned_queue) throw new ForbiddenException('გეგმიური ჰოსპიტალიზაციის რიგი გამორთულია (მოდულები → სტაციონარი)'); return s; }

  async plannedList(q: { status?: string; department_id?: string; from?: string; to?: string; patient_id?: string }) {
    await this.plannedOn();
    let x = this.db.selectFrom('inpatient_planned as pl').innerJoin('patients as p', 'p.id', 'pl.patient_id').innerJoin('departments as d', 'd.id', 'pl.department_id')
      .leftJoin('users as doc', 'doc.id', 'pl.doctor_id').leftJoin('beds as b', 'b.id', 'pl.bed_id').leftJoin('users as c', 'c.id', 'pl.created_by').leftJoin('inpatient_stays as st', 'st.encounter_id', 'pl.encounter_id')
      .selectAll('pl').select(['p.first_name', 'p.last_name', 'p.personal_number', 'p.birth_date', 'p.gender', 'p.phone_number', 'd.name as department_name', 'b.code as bed_code', 'st.adm_no',
        sql<string | null>`doc.last_name || ' ' || doc.first_name`.as('doctor_name'), sql<string>`c.last_name || ' ' || c.first_name`.as('created_by_name'),
        sql<boolean>`pl.status = 'waiting' AND pl.planned_date < (now() AT TIME ZONE ${TZ})::date`.as('overdue')])
      .orderBy('pl.planned_date').orderBy('pl.created_at').limit(500);
    x = x.where('pl.status', 'in', (q.status ?? 'waiting').split(','));
    if (q.department_id) x = x.where('pl.department_id', '=', q.department_id);
    if (q.patient_id) x = x.where('pl.patient_id', '=', q.patient_id);
    if (q.from) x = x.where('pl.planned_date', '>=', q.from);
    if (q.to) x = x.where('pl.planned_date', '<=', q.to);
    return x.execute();
  }

  async plannedCreate(dto: PlannedDto, u: AuthUser, ctx: AuditContext) {
    await this.plannedOn();
    if (!dto.patient_id || !dto.department_id || !dto.planned_date || !dto.reason) throw new BadRequestException('patient_id, department_id, planned_date და reason სავალდებულოა');
    return this.db.transaction().execute(async (trx) => {
      const p = await trx.selectFrom('patients').select(['id', 'is_deceased']).where('id', '=', dto.patient_id!).executeTakeFirst();
      if (!p || p.is_deceased) throw new BadRequestException('პაციენტი ვერ მოიძებნა');
      await this.department(dto.department_id!, trx);
      if (dto.doctor_id) await this.doctor(dto.doctor_id, trx);
      const icd = dto.icd10_code ? await this.icd(dto.icd10_code, trx) : null;
      const today = (await sql<{ d: string }>`SELECT to_char((now() AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS d`.execute(trx)).rows[0].d;
      if (dto.planned_date! < today) throw new BadRequestException('თარიღი წარსულშია');
      const dup = await trx.selectFrom('inpatient_planned').select('plan_no').where('patient_id', '=', p.id).where('status', '=', 'waiting').executeTakeFirst();
      if (dup) throw new ConflictException(`პაციენტი უკვე რიგშია (${dup.plan_no})`);
      const no = await this.nextNo(trx, 'inpatient_planned', 'PL');
      const r = await trx.insertInto('inpatient_planned').values({ plan_no: no, patient_id: p.id, department_id: dto.department_id!, doctor_id: dto.doctor_id ?? null, planned_date: dto.planned_date!,
        icd10_code: icd?.code ?? null, icd10_title: icd?.title ?? null, reason: dto.reason!.trim(), notes: dto.notes?.trim() || null, created_by: u.id }).returningAll().executeTakeFirstOrThrow();
      await this.event(trx, { planned_id: r.id, kind: 'planned_created', data: { plan_no: no, planned_date: dto.planned_date } }, u);
      await this.audit.log(ctx, { action: 'INPATIENT_PLANNED_CREATE', entityName: 'inpatient_planned', entityId: r.id, newData: r }, trx);
      return r;
    });
  }

  async plannedUpdate(id: string, dto: PlannedDto, u: AuthUser, ctx: AuditContext) {
    await this.plannedOn();
    return this.db.transaction().execute(async (trx) => {
      const pl = await this.lockPlanned(trx, id);
      if (dto.patient_id && dto.patient_id !== pl.patient_id) throw new BadRequestException('პაციენტის შეცვლა შეუძლებელია — გააუქმეთ და შექმენით ახალი');
      if (dto.department_id && dto.department_id !== pl.department_id) {
        if (pl.bed_id) throw new ConflictException('დაჯავშნილია საწოლი — განყოფილების შეცვლამდე მოხსენით დაჯავშნა');
        await this.department(dto.department_id, trx);
      }
      if (dto.doctor_id) await this.doctor(dto.doctor_id, trx);
      const icd = dto.icd10_code ? await this.icd(dto.icd10_code, trx) : dto.icd10_code === null ? null : undefined;
      const vals = { ...(dto.department_id && { department_id: dto.department_id }), ...(dto.doctor_id !== undefined && { doctor_id: dto.doctor_id }),
        ...(dto.planned_date && { planned_date: dto.planned_date, ...(dto.planned_date !== pl.planned_date && { sms_sent_at: null }) }),
        ...(icd !== undefined && { icd10_code: icd?.code ?? null, icd10_title: icd?.title ?? null }), ...(dto.reason && { reason: dto.reason.trim() }), ...(dto.notes !== undefined && { notes: dto.notes?.trim() || null }) };
      const r = await trx.updateTable('inpatient_planned').set(vals).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await this.event(trx, { planned_id: id, kind: 'planned_updated', data: { ...dto } }, u);
      await this.audit.log(ctx, { action: 'INPATIENT_PLANNED_UPDATE', entityName: 'inpatient_planned', entityId: id, oldData: pl, newData: r }, trx);
      return r;
    });
  }
  private async lockPlanned(trx: Trx, id: string) {
    const pl = await trx.selectFrom('inpatient_planned').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!pl) throw new NotFoundException('გეგმიური ჩანაწერი ვერ მოიძებნა');
    if (pl.status !== 'waiting') throw new ConflictException('ჩანაწერი უკვე დამუშავებულია');
    return pl;
  }

  async plannedReserve(id: string, dto: ReserveDto, u: AuthUser, ctx: AuditContext) {
    const s = await this.plannedOn();
    try {
      return await this.db.transaction().execute(async (trx) => {
        const pl = await this.lockPlanned(trx, id);
        if (!(await this.canAssign(u, pl.department_id, s, trx))) throw new ForbiddenException('საწოლს ჯავშნის განყოფილების თანამშრომელი');
        if (pl.bed_id === dto.bed_id) return { planned_id: id, bed_id: dto.bed_id };
        const gender = (await trx.selectFrom('patients').select('gender').where('id', '=', pl.patient_id).executeTakeFirstOrThrow()).gender;
        const bed = await this.lockBed(trx, dto.bed_id, { departmentId: pl.department_id, gender, confirm: dto.confirm }, s);
        if (pl.bed_id) { await trx.selectFrom('beds').select('id').where('id', '=', pl.bed_id).forUpdate().execute(); await this.setBed(trx, pl.bed_id, 'free', u);
          await this.event(trx, { planned_id: id, bed_id: pl.bed_id, kind: 'bed_released', data: { plan_no: pl.plan_no } }, u); }
        await trx.updateTable('inpatient_planned').set({ bed_id: bed.id }).where('id', '=', id).execute();
        await this.setBed(trx, bed.id, 'reserved', u, `გეგმიური ${pl.plan_no} · ${pl.planned_date}`);
        await this.event(trx, { planned_id: id, bed_id: bed.id, kind: 'bed_reserved', data: { plan_no: pl.plan_no, bed: bed.code, warnings: bed.warnings } }, u);
        await this.audit.log(ctx, { action: 'INPATIENT_BED_RESERVE', entityName: 'inpatient_planned', entityId: id, newData: { bed_id: bed.id } }, trx);
        return { planned_id: id, bed_id: bed.id, bed: bed.code };
      });
    } catch (e) { mapPgError(e, { ux_inpatient_planned_bed: 'საწოლი უკვე დაჯავშნილია' }); }
  }

  async plannedRelease(id: string, u: AuthUser, ctx: AuditContext) {
    const s = await this.plannedOn();
    return this.db.transaction().execute(async (trx) => {
      const pl = await this.lockPlanned(trx, id);
      if (!pl.bed_id) throw new ConflictException('საწოლი დაჯავშნილი არ არის');
      if (!(await this.canAssign(u, pl.department_id, s, trx))) throw new ForbiddenException('დაჯავშნას ხსნის განყოფილების თანამშრომელი');
      await trx.selectFrom('beds').select('id').where('id', '=', pl.bed_id).forUpdate().execute();
      await this.setBed(trx, pl.bed_id, 'free', u);
      await trx.updateTable('inpatient_planned').set({ bed_id: null }).where('id', '=', id).execute();
      await this.event(trx, { planned_id: id, bed_id: pl.bed_id, kind: 'bed_released', data: { plan_no: pl.plan_no } }, u);
      await this.audit.log(ctx, { action: 'INPATIENT_BED_RELEASE', entityName: 'inpatient_planned', entityId: id }, trx);
      return { planned_id: id };
    });
  }

  async plannedCancel(id: string, reason: string, u: AuthUser, ctx: AuditContext) {
    await this.plannedOn();
    return this.db.transaction().execute(async (trx) => {
      const pl = await this.lockPlanned(trx, id);
      if (pl.bed_id) { await trx.selectFrom('beds').select('id').where('id', '=', pl.bed_id).forUpdate().execute(); await this.setBed(trx, pl.bed_id, 'free', u); }
      await trx.updateTable('inpatient_planned').set({ status: 'cancelled', cancel_reason: reason, bed_id: null }).where('id', '=', id).execute();
      await this.event(trx, { planned_id: id, bed_id: pl.bed_id, kind: 'planned_cancelled', data: { plan_no: pl.plan_no, reason } }, u);
      await this.audit.log(ctx, { action: 'INPATIENT_PLANNED_CANCEL', entityName: 'inpatient_planned', entityId: id, newData: { reason } }, trx);
      return { planned_id: id, status: 'cancelled' };
    });
  }

  // ================================================================= სამაჯური
  private async wristbandData(encounterId: string): Promise<{ data: WristbandData; departmentId: string }> {
    const st = await this.db.selectFrom('inpatient_stays as st').innerJoin('encounters as e', 'e.id', 'st.encounter_id').innerJoin('patients as p', 'p.id', 'st.patient_id')
      .innerJoin('departments as d', 'd.id', 'e.department_id')
      .leftJoin('bed_assignments as a', (j) => j.onRef('a.encounter_id', '=', 'st.encounter_id').on('a.ended_at', 'is', null)).leftJoin('beds as b', 'b.id', 'a.bed_id')
      .select(['st.adm_no', 'st.status', 'st.admitted_at', 'st.patient_id', 'p.first_name', 'p.last_name', 'p.birth_date', 'p.gender', 'p.personal_number', 'd.name as department', 'e.department_id', 'b.code as bed',
        sql<string>`age((now() AT TIME ZONE ${TZ})::date, p.birth_date)::text`.as('age_iv'),
        sql<number>`date_part('year', age((now() AT TIME ZONE ${TZ})::date, p.birth_date))::int`.as('years'),
        sql<number>`(date_part('year', age((now() AT TIME ZONE ${TZ})::date, p.birth_date)) * 12 + date_part('month', age((now() AT TIME ZONE ${TZ})::date, p.birth_date)))::int`.as('months'),
        sql<number>`((now() AT TIME ZONE ${TZ})::date - p.birth_date)::int`.as('days')])
      .where('st.encounter_id', '=', encounterId).executeTakeFirst();
    if (!st) throw new NotFoundException('ჰოსპიტალიზაცია ვერ მოიძებნა');
    if (st.status !== 'active') throw new ConflictException('ჰოსპიტალიზაცია აქტიური არ არის');
    const [allergies, clinic] = await Promise.all([
      this.db.selectFrom('patient_allergies').select('substance').where('patient_id', '=', st.patient_id).where('is_active', '=', true).where('allergy_type', '=', 'allergy').orderBy('severity', 'desc').execute(),
      this.db.selectFrom('clinic_settings').select('name').executeTakeFirst()]);
    const age = st.years >= 2 ? `${st.years} წ` : st.months >= 1 ? `${st.months} თვ` : `${st.days} დღ`;
    return { departmentId: st.department_id, data: { adm_no: st.adm_no, last_name: st.last_name, first_name: st.first_name, birth_date: st.birth_date, age,
      sex: st.gender === 'male' ? 'მ' : st.gender === 'female' ? 'მდ' : '—', personal_number: st.personal_number, department: st.department, bed: st.bed, admitted_at: st.admitted_at,
      allergies: allergies.map((a) => a.substance), clinic: clinic?.name ?? '' } };
  }

  async wristbandPdf(encounterId: string, u: AuthUser) {
    const s = await this.settings();
    if (!s.wristband) throw new ForbiddenException('სამაჯური გამორთულია (მოდულები → სტაციონარი)');
    const { data } = await this.wristbandData(encounterId);
    await this.event(this.db, { encounter_id: encounterId, kind: 'wristband', data: { mode: 'pdf' } }, u);
    return { pdf: await wristbandPdf(data, this.band(s)), adm_no: data.adm_no };
  }

  async wristbandPrint(encounterId: string, printerId: string | undefined, u: AuthUser) {
    const s = await this.settings();
    if (!s.wristband) throw new ForbiddenException('სამაჯური გამორთულია (მოდულები → სტაციონარი)');
    if (s.wristband_print !== 'zpl') throw new BadRequestException('ბეჭდვის რეჟიმი — PDF (მოდულები → სტაციონარი)');
    const { data, departmentId } = await this.wristbandData(encounterId);
    let q = this.db.selectFrom('label_printers').selectAll().where('kind', '=', 'wristband').where('is_active', '=', true);
    q = printerId ? q.where('id', '=', printerId) : q.orderBy(sql`(department_id = ${departmentId})`, sql`DESC NULLS LAST`).orderBy(sql`(department_id IS NULL)`, 'desc').orderBy('name');
    const p = await q.executeTakeFirst();
    if (!p) throw new BadRequestException('სამაჯურის პრინტერი არ არის დამატებული (ადმინისტრირება → პრინტერები)');
    try { await sendRaw(p.host, p.port, await wristbandZpl(data, this.band(s), p.dpi)); } catch (e) { throw new ConflictException({ code: 'PRINTER_ERROR', message: (e as Error).message }); }
    await this.event(this.db, { encounter_id: encounterId, kind: 'wristband', data: { mode: 'zpl', printer: p.name } }, u);
    return { printed: true, printer: p.name, adm_no: data.adm_no };
  }
}

// ================================================================= კონტროლერი
@Controller('inpatient')
export class InpatientController {
  constructor(private readonly s: InpatientService) {}

  // საწოლფონდი (admin)
  @Get('structure') @Roles(...READ) structure(@Query('all') all?: string) { return this.s.structure(all === 'true'); }
  @Post('wards') @Roles('admin') addWard(@Body() d: WardDto, @Req() r: Request) { return this.s.saveWard(null, d, auditCtx(r)); }
  @Patch('wards/:id') @Roles('admin') updWard(@Param('id', ParseUUIDPipe) id: string, @Body() d: WardDto, @Req() r: Request) { return this.s.saveWard(id, d, auditCtx(r)); }
  @Post('wards/:id/beds') @Roles('admin') addBeds(@Param('id', ParseUUIDPipe) id: string, @Body() d: BedsBulkDto, @Req() r: Request) { return this.s.addBeds(id, d, auditCtx(r)); }
  @Patch('beds/:id') @Roles('admin') updBed(@Param('id', ParseUUIDPipe) id: string, @Body() d: BedDto, @Req() r: Request) { return this.s.updateBed(id, d, auditCtx(r)); }
  @Post('bed-types') @Roles('admin') addType(@Body() d: BedTypeDto, @Req() r: Request) { return this.s.saveBedType(null, d, auditCtx(r)); }
  @Patch('bed-types/:code') @Roles('admin') updType(@Param('code') code: string, @Body() d: BedTypeDto, @Req() r: Request) { return this.s.saveBedType(code, d, auditCtx(r)); }

  // პრინტერები
  @Get('printers') @Roles(...READ) printers(@Query('kind') kind?: string) { return this.s.printers(kind); }
  @Post('printers') @Roles('admin') addPrinter(@Body() d: PrinterDto, @Req() r: Request) { return this.s.savePrinter(null, d, auditCtx(r)); }
  @Patch('printers/:id') @Roles('admin') updPrinter(@Param('id', ParseUUIDPipe) id: string, @Body() d: PrinterDto, @Req() r: Request) { return this.s.savePrinter(id, d, auditCtx(r)); }
  @Post('printers/:id/test') @HttpCode(200) @Roles('admin') testPrinter(@Param('id', ParseUUIDPipe) id: string, @Body() d: PrinterTestDto) { return this.s.testPrinter(id, !!d.print); }

  // დაფა
  @Get('census') @Roles(...READ) census(@CurrentUser() u: AuthUser) { return this.s.census(u); }
  @Get('board') @Roles(...READ) board(@Query('department_id', ParseUUIDPipe) dep: string, @CurrentUser() u: AuthUser) { return this.s.board(dep, u); }
  @Post('beds/:id/clean') @HttpCode(200) @Roles('admin', 'nurse', 'doctor', 'manager') clean(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.bedAction(id, 'clean', undefined, u, auditCtx(r)); }
  @Post('beds/:id/block') @HttpCode(200) @Roles('admin', 'nurse', 'doctor', 'manager') block(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.bedAction(id, 'block', d.reason, u, auditCtx(r)); }
  @Post('beds/:id/unblock') @HttpCode(200) @Roles('admin', 'nurse', 'doctor', 'manager') unblock(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.bedAction(id, 'unblock', undefined, u, auditCtx(r)); }
  @Get('beds/:id/history') @Roles(...READ) bedHistory(@Param('id', ParseUUIDPipe) id: string) { return this.s.bedHistory(id); }

  // ჰოსპიტალიზაცია
  @Post('admissions') @Roles('admin', 'receptionist', 'doctor') admit(@Body() d: AdmitDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.admit(d, u, auditCtx(r)); }
  @Get('stays') @Roles(...READ) stays(@Query('status') status?: string, @Query('department_id') dep?: string, @Query('search') search?: string, @Query('patient_id') pid?: string) {
    return this.s.stays({ status, department_id: dep, search, patient_id: pid });
  }
  @Get('stays/:id') @Roles(...READ) stay(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.stay(id, u, auditCtx(r)); }
  @Patch('stays/:id') @Roles('admin', 'doctor', 'nurse', 'manager') patch(@Param('id', ParseUUIDPipe) id: string, @Body() d: StayPatchDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.patchStay(id, d, u, auditCtx(r)); }
  @Post('stays/:id/bed') @HttpCode(200) @Roles('admin', 'doctor', 'nurse', 'manager', 'receptionist') bed(@Param('id', ParseUUIDPipe) id: string, @Body() d: BedAssignDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.assignBed(id, d, u, auditCtx(r)); }
  @Post('stays/:id/cancel') @HttpCode(200) @Roles('admin', 'doctor', 'receptionist') cancel(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.cancel(id, d.reason, u, auditCtx(r)); }
  @Get('stays/:id/wristband.pdf') @Roles('admin', 'doctor', 'nurse', 'receptionist', 'manager')
  async wbPdf(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Res() res: Response) {
    const { pdf, adm_no } = await this.s.wristbandPdf(id, u);
    res.setHeader('content-type', 'application/pdf'); res.setHeader('content-disposition', `inline; filename="wristband-${adm_no}.pdf"`); res.send(pdf);
  }
  @Post('stays/:id/wristband') @HttpCode(200) @Roles('admin', 'doctor', 'nurse', 'receptionist', 'manager') wbPrint(@Param('id', ParseUUIDPipe) id: string, @Body() d: PrintDto, @CurrentUser() u: AuthUser) { return this.s.wristbandPrint(id, d.printer_id, u); }

  // გეგმიური რიგი
  @Get('planned') @Roles(...READ) planned(@Query('status') status?: string, @Query('department_id') dep?: string, @Query('from') from?: string, @Query('to') to?: string, @Query('patient_id') pid?: string) {
    return this.s.plannedList({ status, department_id: dep, from, to, patient_id: pid });
  }
  @Post('planned') @Roles('admin', 'receptionist', 'doctor') addPlanned(@Body() d: PlannedDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.plannedCreate(d, u, auditCtx(r)); }
  @Patch('planned/:id') @Roles('admin', 'receptionist', 'doctor') updPlanned(@Param('id', ParseUUIDPipe) id: string, @Body() d: PlannedDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.plannedUpdate(id, d, u, auditCtx(r)); }
  @Post('planned/:id/reserve') @HttpCode(200) @Roles('admin', 'nurse', 'doctor', 'manager', 'receptionist') reserve(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReserveDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.plannedReserve(id, d, u, auditCtx(r)); }
  @Post('planned/:id/release') @HttpCode(200) @Roles('admin', 'nurse', 'doctor', 'manager', 'receptionist') release(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.plannedRelease(id, u, auditCtx(r)); }
  @Post('planned/:id/cancel') @HttpCode(200) @Roles('admin', 'receptionist', 'doctor') cancelPlanned(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.plannedCancel(id, d.reason, u, auditCtx(r)); }
}

@Module({ providers: [InpatientService], controllers: [InpatientController], exports: [InpatientService] })
export class InpatientModule {}
