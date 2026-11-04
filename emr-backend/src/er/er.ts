import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsISO8601, IsNumber, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import type { Request } from 'express';
import { sql, type Kysely, type Transaction } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser, type Role } from '../auth/roles';
import { mapPgError } from '../common/pg-errors';
import { InjectDb, type Database } from '../database/database.module';
import type { DB } from '../database/db';
import { news2 } from '../inpatient/news2';
import { ClinicalHistory, RequireModule } from '../modules/module-guard';
import { ModulesService } from '../modules/modules';
import { RosterLookup } from '../roster/roster-common';
import { erCanWrite, type ErClinicalSettings } from './er-access';

/**
 * გადაუდებელი დახმარება (ER), 0087 — რეგისტრაცია (+ უცნობი პაციენტი), ტრიაჟი, დაფა / TV, ადგილები, ცნობარები.
 *  • ER-ის შემთხვევა = encounters.type 'emergency' + er_visits (ცარიელი ინვოისით — ბილინგი 0090-ში);
 *  • ტრიაჟის დონეს ირჩევს ადამიანი — NEWS2 მხოლოდ მინიშნებაა (სისტემა დონეს არ ანიჭებს);
 *  • რბილი კავშირი: roster — „მორიგე ექიმი ახლა“ (RosterLookup: არააქტიურზე ცარიელი).
 */
type Trx = Transaction<DB>;
type Ex = Kysely<DB> | Trx;
const TZ = 'Asia/Tbilisi';

export interface ErSettings extends Partial<ErClinicalSettings> {
  triage_scale: string; triage_target_min: number; doctor_before_triage: 'allow' | 'block'; ambulance_fields: 'optional' | 'required';
  retriage_alert: boolean; news2_hint: boolean; show_on_duty: boolean; board_refresh_sec: number; tv_patient_names: 'initials' | 'full';
}
/** დაფის / ბარათის ნახვა */
export const ER_READ: Role[] = ['admin', 'er_triage', 'er_doctor', 'er_manage', 'manager', 'viewer'];
/** ER-ის ჩაწერა (ადგილი / ექთანი / მოლოდინი / განმეორებითი ტრიაჟი) */
export const ER_WRITE: Role[] = ['admin', 'er_triage', 'er_doctor', 'er_manage'];
/** რეგისტრაცია / ტრიაჟი */
export const ER_REG: Role[] = ['admin', 'er_triage', 'er_manage'];
/** ცნობარები, ნებისმიერი გაუქმება */
export const ER_MANAGE: Role[] = ['admin', 'er_manage'];
const ACTIVE = ['waiting', 'triaged', 'in_treatment'] as const;
export const WAITING_FOR = ['lab', 'imaging', 'consult', 'bed', 'transport', 'other'] as const;
export const SPOT_KINDS = ['bed', 'chair', 'corridor', 'resus', 'isolation', 'other'] as const;
const ARRIVAL_KINDS = ['walk_in', 'ambulance', 'transfer', 'police', 'other'] as const;

const ageYears = (birth: string | Date, at = new Date()) => {
  const b = new Date(birth); let a = at.getFullYear() - b.getFullYear();
  if (at.getMonth() < b.getMonth() || (at.getMonth() === b.getMonth() && at.getDate() < b.getDate())) a--;
  return a;
};
const minutes = (from: Date | string | null, to: Date) => (from ? Math.floor((to.getTime() - new Date(from).getTime()) / 60_000) : null);
const initials = (f: string, l: string) => `${(f || '?').trim().charAt(0)}. ${(l || '?').trim().charAt(0)}.`;

// ======================================================================= DTO
const num = ({ value }: { value: unknown }) => (value === '' || value === null || value === undefined ? undefined : Number(value));
class NewPatientDto {
  @IsOptional() @IsString() @MaxLength(100) first_name?: string;
  @IsOptional() @IsString() @MaxLength(100) last_name?: string;
  @IsIn(['male', 'female', 'other']) gender: 'male' | 'female' | 'other';
  @IsOptional() @IsISO8601({ strict: true }) @Matches(/^\d{4}-\d{2}-\d{2}$/) birth_date?: string;
  @IsOptional() @Transform(num) @IsInt() @Min(0) @Max(120) age_years?: number;
  @IsOptional() @Matches(/^\d{11}$/, { message: 'პირადი ნომერი უნდა იყოს 11 ციფრი' }) personal_number?: string;
  @IsOptional() @IsString() @Length(3, 50) passport_number?: string;
  @IsOptional() @Matches(/^[A-Z]{3}$/) citizenship?: string;
  @IsOptional() @IsString() @MaxLength(50) phone_number?: string;
}
export class RegisterDto {
  @IsOptional() @IsUUID() patient_id?: string;
  @IsOptional() @ValidateNested() @Type(() => NewPatientDto) new_patient?: NewPatientDto;
  @IsUUID() department_id: string;
  @IsString() @Matches(/^[a-z][a-z0-9_]{1,19}$/) arrival_mode: string;
  @IsOptional() @IsISO8601() arrived_at?: string;
  @IsString() @Length(2, 1000) chief_complaint: string;
  @IsOptional() @IsString() @MaxLength(40) ambulance_crew?: string;
  @IsOptional() @IsISO8601() ambulance_call_at?: string;
  @IsOptional() @IsUUID() referral_institution_id?: string;
  @IsOptional() @IsString() @MaxLength(1000) arrival_note?: string;
  @IsOptional() @IsUUID() spot_id?: string;
}
class TriageVitals {
  @IsOptional() @Transform(num) @IsInt() @Min(40) @Max(300) systolic_bp?: number;
  @IsOptional() @Transform(num) @IsInt() @Min(20) @Max(200) diastolic_bp?: number;
  @IsOptional() @Transform(num) @IsInt() @Min(20) @Max(300) heart_rate?: number;
  @IsOptional() @Transform(num) @IsInt() @Min(4) @Max(80) respiratory_rate?: number;
  @IsOptional() @Transform(num) @IsNumber({ maxDecimalPlaces: 1 }) @Min(30) @Max(45) temperature?: number;
  @IsOptional() @Transform(num) @IsInt() @Min(30) @Max(100) spo2?: number;
  @IsOptional() @IsIn([1, 2]) spo2_scale?: 1 | 2;
  @IsOptional() @IsBoolean() o2_supplement?: boolean;
  @IsOptional() @Transform(num) @IsNumber() @Min(0) @Max(80) o2_flow?: number;
  @IsOptional() @IsIn(['A', 'C', 'V', 'P', 'U']) consciousness?: 'A' | 'C' | 'V' | 'P' | 'U';
  @IsOptional() @Transform(num) @IsInt() @Min(0) @Max(10) pain?: number;
  @IsOptional() @Transform(num) @IsNumber({ maxDecimalPlaces: 1 }) @Min(0.5) @Max(60) glucose?: number;
  @IsOptional() @Transform(num) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.3) @Max(400) weight_kg?: number;
}
export class TriageDto {
  @IsOptional() @IsString() @Matches(/^[A-Z][A-Z0-9_]{1,19}$/) scale_code?: string;
  @Transform(num) @IsInt() @Min(1) @Max(9) level: number;
  @IsOptional() @ValidateNested() @Type(() => TriageVitals) vitals?: TriageVitals;
  @IsOptional() @Transform(num) @IsInt() @Min(3) @Max(15) gcs?: number;
  @IsOptional() @IsString() @MaxLength(500) discriminator?: string;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
}
export class AssignDto {
  @IsOptional() @IsUUID() spot_id?: string | null;
  @IsOptional() @IsUUID() nurse_id?: string | null;
  @IsOptional() @IsUUID() doctor_id?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(6) @IsIn(WAITING_FOR as unknown as string[], { each: true }) waiting_for?: string[];
}
class CancelDto { @IsString() @Length(3, 500) reason: string }
class SpotDto {
  @IsOptional() @IsUUID() department_id?: string;
  @IsOptional() @IsString() @Matches(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,19}$/) code?: string;
  @IsOptional() @IsString() @Length(1, 60) name?: string;
  @IsOptional() @IsIn(SPOT_KINDS as unknown as string[]) kind?: string;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(10000) sort_order?: number;
}
class ArrivalDto {
  @IsOptional() @IsString() @Matches(/^[a-z][a-z0-9_]{1,19}$/) code?: string;
  @IsOptional() @IsString() @Length(2, 80) name?: string;
  @IsOptional() @IsIn(ARRIVAL_KINDS as unknown as string[]) kind?: string;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(10000) sort_order?: number;
}
class LevelDto {
  @IsInt() @Min(1) @Max(9) level: number;
  @IsString() @Length(2, 80) name: string;
  @Matches(/^#[0-9a-fA-F]{6}$/) color: string;
  @IsInt() @Min(0) @Max(1440) target_doctor_min: number;
  @IsOptional() @IsInt() @Min(5) @Max(1440) retriage_min?: number | null;
  @IsOptional() @IsString() @MaxLength(300) description?: string | null;
  @IsOptional() @IsBoolean() is_active?: boolean;
}
class ScaleDto {
  @IsOptional() @IsString() @Matches(/^[A-Z][A-Z0-9_]{1,19}$/) code?: string;
  @IsOptional() @IsString() @Length(2, 120) name?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string | null;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(9) @ValidateNested({ each: true }) @Type(() => LevelDto) levels?: LevelDto[];
}

// ======================================================================= სერვისი
@Injectable()
export class ErService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService, private readonly modules: ModulesService, private readonly roster: RosterLookup) {}

  settings() { return this.modules.require<ErSettings>('er'); }

  private async nextNo(trx: Trx) {
    const year = Number((await sql<{ y: string }>`SELECT to_char(now() AT TIME ZONE ${TZ}, 'YYYY') AS y`.execute(trx)).rows[0].y);
    const { last_value } = await trx.insertInto('document_counters').values({ document_type: 'er_visit', year, last_value: 1 })
      .onConflict((oc) => oc.columns(['document_type', 'year']).doUpdateSet({ last_value: sql`document_counters.last_value + 1` })).returning('last_value').executeTakeFirstOrThrow();
    return `ER${String(year).slice(2)}-${String(last_value).padStart(6, '0')}`;
  }
  private async erDepartment(id: string, ex: Ex = this.db) {
    const d = await ex.selectFrom('departments').select(['id', 'name', 'type', 'is_active']).where('id', '=', id).executeTakeFirst();
    if (!d || !d.is_active) throw new BadRequestException('განყოფილება ვერ მოიძებნა ან გათიშულია');
    if (d.type !== 'emergency') throw new BadRequestException('განყოფილება არ არის გადაუდებელი დახმარების (ტიპი — emergency)');
    return d;
  }
  private departments() {
    return this.db.selectFrom('departments').select(['id', 'name', 'code']).where('type', '=', 'emergency').where('is_active', '=', true).orderBy('name').execute();
  }
  private async scaleLevels(code: string, ex: Ex = this.db) {
    return ex.selectFrom('er_triage_levels').selectAll().where('scale_code', '=', code).orderBy('level').execute();
  }
  private perms(u: AuthUser) {
    return { register: has(u, ...ER_REG), triage: has(u, ...ER_WRITE), pickup: has(u, 'er_doctor'), assign: has(u, ...ER_WRITE), manage: has(u, ...ER_MANAGE),
      identify: has(u, 'admin', 'receptionist', 'er_triage', 'er_manage'), merge: has(u, 'admin', 'er_manage') };
  }

  // ---------------------------------------------------------------- მეტა / ცნობარები
  async meta(u: AuthUser) {
    const s = await this.settings();
    const [departments, arrival, scales, levels, spots, institutions] = await Promise.all([
      this.departments(),
      this.db.selectFrom('er_arrival_modes').selectAll().orderBy('sort_order').orderBy('name').execute(),
      this.db.selectFrom('er_triage_scales').selectAll().orderBy('sort_order').orderBy('code').execute(),
      this.db.selectFrom('er_triage_levels').selectAll().orderBy('scale_code').orderBy('level').execute(),
      this.db.selectFrom('er_spots as s').innerJoin('departments as d', 'd.id', 's.department_id').selectAll('s').select('d.name as department_name').orderBy('d.name').orderBy('s.sort_order').orderBy('s.code').execute(),
      this.db.selectFrom('external_institutions').select(['id', 'name']).where('is_active', '=', true).orderBy('sort_order').orderBy('name').execute(),
    ]);
    return { settings: s, departments, arrival_modes: arrival, scales: scales.map((x) => ({ ...x, levels: levels.filter((l) => l.scale_code === x.code) })),
      spots, institutions, waiting_for: WAITING_FOR, perms: this.perms(u) };
  }
  async staff() {
    const rows = await this.db.selectFrom('users as u').innerJoin('user_capabilities as c', 'c.user_id', 'u.id')
      .select(['u.id', sql<string>`u.first_name || ' ' || u.last_name`.as('name'), 'c.capabilities']).where('u.is_active', '=', true).orderBy('u.last_name').execute();
    const caps = (r: { capabilities: string[] | null }) => r.capabilities ?? [];
    return {
      doctors: rows.filter((r) => caps(r).includes('er_doctor')).map(({ id, name }) => ({ id, name })),
      nurses: rows.filter((r) => caps(r).some((c) => c === 'er_triage' || c === 'nurse')).map(({ id, name }) => ({ id, name })),
    };
  }

  // ---------------------------------------------------------------- რეგისტრაცია
  async register(dto: RegisterDto, u: AuthUser, ctx: AuditContext) {
    const s = await this.settings();
    if (!!dto.patient_id === !!dto.new_patient) throw new BadRequestException('მიუთითეთ არსებული პაციენტი (patient_id) ან ახალი / უცნობი (new_patient)');
    try {
      return await this.db.transaction().execute(async (trx) => {
        const dep = await this.erDepartment(dto.department_id, trx);
        const mode = await trx.selectFrom('er_arrival_modes').selectAll().where('code', '=', dto.arrival_mode).executeTakeFirst();
        if (!mode?.is_active) throw new BadRequestException('შემოსვლის გზა ვერ მოიძებნა ან გათიშულია');
        if (mode.kind === 'ambulance' && s.ambulance_fields === 'required' && !dto.ambulance_crew?.trim()) throw new BadRequestException('სასწრაფო: მიუთითეთ ბრიგადის ნომერი');
        if (dto.referral_institution_id && !(await trx.selectFrom('external_institutions').select('id').where('id', '=', dto.referral_institution_id).executeTakeFirst())) {
          throw new BadRequestException('გამგზავნი კლინიკა ვერ მოიძებნა');
        }
        const arrived = dto.arrived_at ? new Date(dto.arrived_at) : new Date();
        if (arrived.getTime() > Date.now() + 5 * 60_000) throw new BadRequestException('შემოსვლის დრო მომავალშია');
        if (arrived.getTime() < Date.now() - 24 * 3600_000) throw new BadRequestException('შემოსვლის დრო 24 საათზე ძველია');

        const patient = dto.patient_id ? await this.existingPatient(trx, dto.patient_id) : await this.createPatient(trx, dto.new_patient!, ctx);
        const active = await trx.selectFrom('er_visits').select(['encounter_id', 'visit_no']).where('patient_id', '=', patient.id).where('ended_at', 'is', null).executeTakeFirst();
        if (active) throw new ConflictException({ code: 'ER_ALREADY_ACTIVE', message: `პაციენტი უკვე ER-შია (${active.visit_no})`, encounter_id: active.encounter_id });
        if (dto.spot_id) await this.checkSpot(trx, dto.spot_id, dep.id, null);

        const enc = await trx.insertInto('encounters').values({ patient_id: patient.id, department_id: dep.id, type: 'emergency', status: 'active',
          start_time: arrived.toISOString(), chief_complaint: dto.chief_complaint.trim() }).returningAll().executeTakeFirstOrThrow();
        await trx.insertInto('invoices').values({ encounter_id: enc.id, total_amount: '0', patient_share: '0',
          invoice_number: sql<string>`'INV-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('invoice_number_seq')::text, 6, '0')` }).execute();
        const visitNo = await this.nextNo(trx);
        const v = await trx.insertInto('er_visits').values({
          encounter_id: enc.id, visit_no: visitNo, patient_id: patient.id, department_id: dep.id, arrived_at: arrived.toISOString(), arrival_mode: mode.code,
          ambulance_crew: dto.ambulance_crew?.trim() || null, ambulance_call_at: dto.ambulance_call_at ?? null, referral_institution_id: dto.referral_institution_id ?? null,
          arrival_note: dto.arrival_note?.trim() || null, chief_complaint: dto.chief_complaint.trim(), spot_id: dto.spot_id ?? null, created_by: u.id,
        }).returningAll().executeTakeFirstOrThrow();
        await this.audit.log(ctx, { action: 'ER_REGISTER', entityName: 'er_visits', entityId: enc.id,
          newData: { visit_no: visitNo, patient_id: patient.id, unknown: patient.is_unknown, department_id: dep.id, arrival_mode: mode.code, spot_id: v.spot_id } }, trx);
        return { ...v, patient };
      });
    } catch (e) { mapPgError(e, { uq_er_visit_active_patient: 'პაციენტი უკვე ER-შია', uq_er_visit_active_spot: 'ადგილი დაკავებულია', patients_personal_number_key: 'პაციენტი ამ პირადი ნომრით უკვე არსებობს — აირჩიეთ ძებნით' }); }
  }
  private async existingPatient(trx: Trx, id: string) {
    const p = await trx.selectFrom('patients').select(['id', 'first_name', 'last_name', 'is_unknown', 'unknown_no', 'is_deceased', 'merged_into_id']).where('id', '=', id).executeTakeFirst();
    if (!p) throw new NotFoundException('პაციენტი ვერ მოიძებნა');
    if (p.merged_into_id) throw new ConflictException('ჩანაწერი გაერთიანებულია სხვა პაციენტთან — აირჩიეთ ნამდვილი ჩანაწერი');
    if (p.is_deceased) throw new BadRequestException('პაციენტი გარდაცვლილად არის მონიშნული');
    return p;
  }
  /** ახალი პაციენტი: საბუთით (პირადი № / პასპორტი + სახელი + დაბადება) — ჩვეულებრივი; სხვაგვარად — „უცნობი #N“ (იდენტობა დაუდასტურებელია) */
  private async createPatient(trx: Trx, d: NewPatientDto, ctx: AuditContext) {
    const first = d.first_name?.trim() ?? ''; const last = d.last_name?.trim() ?? '';
    if (!d.birth_date && d.age_years === undefined) throw new BadRequestException('მიუთითეთ დაბადების თარიღი ან სავარაუდო ასაკი');
    const known = !!(d.personal_number || d.passport_number) && !!first && !!last && !!d.birth_date;
    if ((d.personal_number || d.passport_number) && !known) throw new BadRequestException('საბუთით რეგისტრაციას სჭირდება სახელი, გვარი და დაბადების თარიღი (სხვაგვარად — უცნობი პაციენტი, საბუთის ველების გარეშე)');
    if (d.personal_number) {
      const dup = await trx.selectFrom('patients').select(['id', 'first_name', 'last_name']).where('personal_number', '=', d.personal_number).executeTakeFirst();
      if (dup) throw new ConflictException({ code: 'PATIENT_EXISTS', message: `პაციენტი ამ პირადი ნომრით უკვე არსებობს (${dup.first_name} ${dup.last_name}) — აირჩიეთ ძებნით`, patient: dup });
    }
    let birth = d.birth_date; let estimated = false;
    if (!birth) {
      const y = Number((await sql<{ y: string }>`SELECT to_char(now() AT TIME ZONE ${TZ}, 'YYYY') AS y`.execute(trx)).rows[0].y);
      birth = `${y - (d.age_years as number)}-01-01`; estimated = true;
    }
    if (new Date(birth).getTime() > Date.now()) throw new BadRequestException('დაბადების თარიღი მომავალშია');
    const no = known ? null : Number((await sql<{ n: string }>`SELECT nextval('patient_unknown_seq') AS n`.execute(trx)).rows[0].n);
    const p = await trx.insertInto('patients').values({
      first_name: first || 'უცნობი', last_name: last || `#${no}`, birth_date: birth, birth_date_estimated: estimated, gender: d.gender,
      phone_number: d.phone_number?.trim() ?? '', personal_number: d.personal_number ?? null, passport_number: d.passport_number ?? null,
      citizenship: d.citizenship ?? 'GEO', is_unknown: !known, unknown_no: no,
    }).returning(['id', 'first_name', 'last_name', 'is_unknown', 'unknown_no', 'is_deceased', 'merged_into_id']).executeTakeFirstOrThrow();
    await this.audit.log(ctx, { action: known ? 'CREATE_PATIENT' : 'ER_CREATE_UNKNOWN_PATIENT', entityName: 'patients', entityId: p.id,
      newData: { first_name: p.first_name, last_name: p.last_name, unknown_no: no, gender: d.gender, birth_date: birth, estimated, source: 'er' } }, trx);
    return p;
  }
  private async checkSpot(trx: Trx, spotId: string, depId: string, encounterId: string | null) {
    const sp = await trx.selectFrom('er_spots').select(['id', 'department_id', 'is_active', 'name']).where('id', '=', spotId).executeTakeFirst();
    if (!sp || !sp.is_active) throw new BadRequestException('ადგილი ვერ მოიძებნა ან გათიშულია');
    if (sp.department_id !== depId) throw new BadRequestException('ადგილი სხვა განყოფილებისაა');
    const busy = await trx.selectFrom('er_visits').select('visit_no').where('spot_id', '=', spotId).where('ended_at', 'is', null)
      .$if(!!encounterId, (q) => q.where('encounter_id', '<>', encounterId!)).executeTakeFirst();
    if (busy) throw new ConflictException({ code: 'ER_SPOT_BUSY', message: `ადგილი „${sp.name}“ დაკავებულია (${busy.visit_no})` });
  }

  // ---------------------------------------------------------------- ტრიაჟი
  private async lockVisit(trx: Trx, id: string) {
    const v = await trx.selectFrom('er_visits').selectAll().where('encounter_id', '=', id).forUpdate().executeTakeFirst();
    if (!v) throw new NotFoundException('ER-ის შემთხვევა ვერ მოიძებნა');
    if (v.ended_at) throw new ConflictException({ code: 'ER_VISIT_CLOSED', message: 'ER-ის შემთხვევა დახურულია' });
    return v;
  }
  async triage(id: string, dto: TriageDto, u: AuthUser, ctx: AuditContext) {
    const s = await this.settings();
    const vt = dto.vitals ?? {};
    if (vt.systolic_bp && vt.diastolic_bp && vt.diastolic_bp >= vt.systolic_bp) throw new BadRequestException('დიასტოლური წნევა სისტოლურზე ნაკლები უნდა იყოს');
    if (vt.o2_flow && vt.o2_supplement === false) throw new BadRequestException('ჟანგბადის ნაკადი — მხოლოდ ჟანგბადის მიწოდებისას');
    try {
      return await this.db.transaction().execute(async (trx) => {
        const v = await this.lockVisit(trx, id);
        const first = !v.first_triage_at;
        if (!first && !has(u, ...ER_WRITE)) throw new ForbiddenException('უფლება არ გაქვთ');
        if (first && !has(u, ...ER_REG, 'er_doctor')) throw new ForbiddenException('ტრიაჟის უფლება არ გაქვთ');
        const scale = dto.scale_code ?? (first ? s.triage_scale : v.triage_scale ?? s.triage_scale);
        const sc = await trx.selectFrom('er_triage_scales').select(['code', 'is_active']).where('code', '=', scale).executeTakeFirst();
        if (!sc?.is_active) throw new BadRequestException('ტრიაჟის შკალა ვერ მოიძებნა ან გათიშულია');
        const lvl = await trx.selectFrom('er_triage_levels').selectAll().where('scale_code', '=', scale).where('level', '=', dto.level).executeTakeFirst();
        if (!lvl?.is_active) throw new BadRequestException('ტრიაჟის დონე ვერ მოიძებნა ან გათიშულია');
        const p = await trx.selectFrom('patients').select(['birth_date']).where('id', '=', v.patient_id).executeTakeFirstOrThrow();
        const age = ageYears(p.birth_date as unknown as string);
        const filled = Object.entries(vt).filter(([k, x]) => x !== undefined && !['spo2_scale', 'o2_flow'].includes(k));
        const n = filled.length && age >= 16 ? news2(vt) : null;
        let vitalsId: string | null = null;
        if (filled.length || dto.gcs) {
          const row = await trx.insertInto('encounter_vitals').values({
            encounter_id: id, taken_by: u.id, systolic_bp: vt.systolic_bp ?? null, diastolic_bp: vt.diastolic_bp ?? null, heart_rate: vt.heart_rate ?? null,
            respiratory_rate: vt.respiratory_rate ?? null, temperature: vt.temperature?.toFixed(1) ?? null, spo2: vt.spo2 ?? null, spo2_scale: vt.spo2_scale ?? 1,
            o2_supplement: vt.o2_supplement ?? null, o2_flow: vt.o2_flow?.toString() ?? null, consciousness: vt.consciousness ?? null, pain: vt.pain ?? null,
            glucose: vt.glucose?.toFixed(1) ?? null, weight_kg: vt.weight_kg?.toFixed(2) ?? null, gcs_total: dto.gcs ?? null,
            news2: n?.score ?? null, news2_level: n?.level ?? null, news2_parts: n ? JSON.stringify(n.parts) : null, notes: 'ER — ტრიაჟი',
          }).returning('id').executeTakeFirstOrThrow();
          vitalsId = row.id;
        }
        const t = await trx.insertInto('er_triage').values({ encounter_id: id, scale_code: scale, level: dto.level, is_retriage: !first, vitals_id: vitalsId,
          news2_score: n?.score ?? null, news2_level: n?.level ?? null, gcs: dto.gcs ?? null, discriminator: dto.discriminator?.trim() || null, note: dto.note?.trim() || null, user_id: u.id,
        }).returningAll().executeTakeFirstOrThrow();
        await trx.updateTable('er_visits').set({ triage_scale: scale, triage_level: dto.level, last_triage_at: t.recorded_at, ...(first && { first_triage_at: t.recorded_at }),
          ...(v.status === 'waiting' && { status: 'triaged' }), ...(first && !v.nurse_id && has(u, 'er_triage') && { nurse_id: u.id }) }).where('encounter_id', '=', id).execute();
        await this.audit.log(ctx, { action: first ? 'ER_TRIAGE' : 'ER_RETRIAGE', entityName: 'er_visits', entityId: id,
          oldData: first ? undefined : { scale: v.triage_scale, level: v.triage_level }, newData: { scale, level: dto.level, news2: n?.score ?? null, triage_id: t.id } }, trx);
        return { ...t, level_name: lvl.name, color: lvl.color, news2: n };
      });
    } catch (e) { mapPgError(e, { chk_vitals_ranges: 'მნიშვნელობა ფიზიოლოგიურ საზღვრებს სცდება — გადაამოწმეთ' }); }
  }

  // ---------------------------------------------------------------- ექიმი / მინიჭება / გაუქმება
  /** ექიმმა აიყვანა პაციენტი („კარი → ექიმი“) */
  async pickup(id: string, u: AuthUser, ctx: AuditContext) {
    const s = await this.settings();
    if (!has(u, 'er_doctor')) throw new ForbiddenException('პაციენტის აყვანა — მხოლოდ ER-ის ექიმს');
    return this.db.transaction().execute(async (trx) => {
      const v = await this.lockVisit(trx, id);
      if (!v.first_triage_at && s.doctor_before_triage === 'block') throw new ConflictException({ code: 'ER_TRIAGE_REQUIRED', message: 'ჯერ ტრიაჟი (კლინიკის წესი)' });
      if (v.doctor_at && v.doctor_id === u.id) return v;
      const r = await trx.updateTable('er_visits').set({ doctor_id: u.id, doctor_at: v.doctor_at ?? sql<string>`now()`, status: 'in_treatment' })
        .where('encounter_id', '=', id).returningAll().executeTakeFirstOrThrow();
      await trx.updateTable('encounters').set({ attending_doctor_id: u.id }).where('id', '=', id).execute();
      await this.audit.log(ctx, { action: 'ER_PICKUP', entityName: 'er_visits', entityId: id, oldData: { doctor_id: v.doctor_id, status: v.status }, newData: { doctor_id: u.id, first: !v.doctor_at } }, trx);
      return r;
    });
  }
  async assign(id: string, dto: AssignDto, u: AuthUser, ctx: AuditContext) {
    await this.settings();
    try {
      return await this.db.transaction().execute(async (trx) => {
        const v = await this.lockVisit(trx, id);
        const set: Record<string, unknown> = {};
        if (dto.spot_id !== undefined) { if (dto.spot_id) await this.checkSpot(trx, dto.spot_id, v.department_id, id); set.spot_id = dto.spot_id; }
        if (dto.nurse_id !== undefined) { if (dto.nurse_id) await this.checkUser(trx, dto.nurse_id, ['er_triage', 'nurse'], 'ექთანი'); set.nurse_id = dto.nurse_id; }
        if (dto.doctor_id !== undefined) {
          if (dto.doctor_id !== v.doctor_id && !has(u, ...ER_MANAGE, 'er_triage')) throw new ForbiddenException('ექიმის მინიჭება — ტრიაჟის ექთანს / ER-ის მენეჯერს');
          if (dto.doctor_id) await this.checkUser(trx, dto.doctor_id, ['er_doctor'], 'ექიმი');
          if (!dto.doctor_id && v.doctor_at) throw new ConflictException('ექიმმა პაციენტი უკვე აიყვანა — შეცვალეთ სხვა ექიმით');
          set.doctor_id = dto.doctor_id;
          if (dto.doctor_id && v.doctor_at) set.doctor_at = v.doctor_at;   // გადაბარება: „კარი → ექიმი“ არ იცვლება
        }
        if (dto.waiting_for !== undefined) set.waiting_for = [...new Set(dto.waiting_for)];
        if (!Object.keys(set).length) throw new BadRequestException('ცვლილება არ არის');
        const r = await trx.updateTable('er_visits').set(set).where('encounter_id', '=', id).returningAll().executeTakeFirstOrThrow();
        if (set.doctor_id !== undefined && r.doctor_at) await trx.updateTable('encounters').set({ attending_doctor_id: r.doctor_id }).where('id', '=', id).execute();
        await this.audit.log(ctx, { action: 'ER_ASSIGN', entityName: 'er_visits', entityId: id,
          oldData: Object.fromEntries(Object.keys(set).map((k) => [k, (v as Record<string, unknown>)[k]])), newData: set }, trx);
        return r;
      });
    } catch (e) { mapPgError(e, { uq_er_visit_active_spot: 'ადგილი დაკავებულია' }); }
  }
  private async checkUser(trx: Trx, id: string, caps: string[], label: string) {
    const r = await trx.selectFrom('users as u').leftJoin('user_capabilities as c', 'c.user_id', 'u.id').select(['u.is_active', 'c.capabilities']).where('u.id', '=', id).executeTakeFirst();
    if (!r?.is_active || !(r.capabilities ?? []).some((c) => caps.includes(c))) throw new BadRequestException(`${label} ვერ მოიძებნა ან შესაბამისი უფლება არ აქვს`);
  }
  /** შეცდომით რეგისტრაციის გაუქმება: შემთხვევა cancelled, ადგილი თავისუფლდება */
  async cancel(id: string, reason: string, u: AuthUser, ctx: AuditContext) {
    await this.settings();
    return this.db.transaction().execute(async (trx) => {
      const v = await this.lockVisit(trx, id);
      if (!has(u, ...ER_MANAGE)) {
        if (!has(u, 'er_triage')) throw new ForbiddenException('უფლება არ გაქვთ');
        if (v.status !== 'waiting') throw new ForbiddenException('ტრიაჟის შემდეგ გაუქმება — მხოლოდ ER-ის მენეჯერს');
      }
      const paid = await trx.selectFrom('invoices as i').innerJoin('invoice_line_items as l', 'l.invoice_id', 'i.id').select('l.id').where('i.encounter_id', '=', id).limit(1).executeTakeFirst();
      if (paid) throw new ConflictException('შემთხვევას უკვე აქვს მომსახურება ინვოისში — გაუქმება შეუძლებელია');
      const r = await trx.updateTable('er_visits').set({ status: 'cancelled', ended_at: sql<string>`now()`, end_reason: reason, spot_id: null })
        .where('encounter_id', '=', id).returningAll().executeTakeFirstOrThrow();
      await trx.updateTable('encounters').set({ status: 'cancelled', end_time: sql<string>`now()` }).where('id', '=', id).execute();
      await this.audit.log(ctx, { action: 'ER_CANCEL', entityName: 'er_visits', entityId: id, oldData: { status: v.status, spot_id: v.spot_id }, newData: { reason } }, trx);
      return r;
    });
  }

  // ---------------------------------------------------------------- დაფა
  async board(q: { department_id?: string; tv?: boolean }) {
    const s = await this.settings();
    const now = new Date();
    if (q.department_id) await this.erDepartment(q.department_id);
    const rows = await this.db.selectFrom('er_visits as v').innerJoin('patients as p', 'p.id', 'v.patient_id').innerJoin('er_arrival_modes as am', 'am.code', 'v.arrival_mode')
      .leftJoin('er_triage_levels as l', (j) => j.onRef('l.scale_code', '=', 'v.triage_scale').onRef('l.level', '=', 'v.triage_level'))
      .leftJoin('er_spots as sp', 'sp.id', 'v.spot_id').leftJoin('users as d', 'd.id', 'v.doctor_id').leftJoin('users as n', 'n.id', 'v.nurse_id')
      .innerJoin('departments as dep', 'dep.id', 'v.department_id')
      .select(['v.encounter_id', 'v.visit_no', 'v.patient_id', 'v.department_id', 'dep.name as department_name', 'v.arrived_at', 'v.arrival_mode', 'am.name as arrival_name', 'am.kind as arrival_kind',
        'v.chief_complaint', 'v.status', 'v.spot_id', 'sp.code as spot_code', 'sp.name as spot_name', 'sp.kind as spot_kind', 'v.triage_scale', 'v.triage_level', 'l.name as level_name', 'l.color',
        'l.target_doctor_min', 'l.retriage_min', 'v.first_triage_at', 'v.last_triage_at', 'v.doctor_id', 'v.doctor_at', 'v.nurse_id', 'v.waiting_for', 'v.ambulance_crew',
        sql<string | null>`d.first_name || ' ' || d.last_name`.as('doctor_name'), sql<string | null>`n.first_name || ' ' || n.last_name`.as('nurse_name'),
        'p.first_name', 'p.last_name', 'p.gender', 'p.birth_date', 'p.birth_date_estimated', 'p.is_unknown', 'p.unknown_no', 'p.personal_number',
        sql<boolean>`EXISTS (SELECT 1 FROM patient_allergies a WHERE a.patient_id = p.id AND a.is_active)`.as('has_allergy'),
        sql<number | null>`(SELECT t.news2_score FROM er_triage t WHERE t.encounter_id = v.encounter_id ORDER BY t.recorded_at DESC LIMIT 1)`.as('news2_score'),
        sql<string | null>`(SELECT t.news2_level FROM er_triage t WHERE t.encounter_id = v.encounter_id ORDER BY t.recorded_at DESC LIMIT 1)`.as('news2_level'),
        // 0088: „მოლოდინი“ ავტომატურად — ღია შეკვეთა (ლაბ. / კვლევა) და ღია კონსულტაცია; ხელით მონიშვნა (waiting_for) რჩება
        sql<string[]>`ARRAY(SELECT DISTINCT CASE WHEN i.section = 'lab' THEN 'lab' ELSE 'imaging' END FROM dx_order_items i
          WHERE i.encounter_id = v.encounter_id AND i.status NOT IN ('validated', 'cancelled'))
          || CASE WHEN EXISTS (SELECT 1 FROM consultations k WHERE k.encounter_id = v.encounter_id AND k.status = 'requested') THEN ARRAY['consult'] ELSE ARRAY[]::text[] END`.as('waiting_auto'),
        sql<boolean>`EXISTS (SELECT 1 FROM doctor_notes n WHERE n.encounter_id = v.encounter_id AND n.kind = 'er_initial' AND n.status = 'signed' AND n.superseded_at IS NULL)`.as('initial_signed')])
      .where('v.ended_at', 'is', null)
      .$if(!!q.department_id, (x) => x.where('v.department_id', '=', q.department_id!))
      .orderBy(sql`v.triage_level IS NOT NULL`).orderBy('v.triage_level').orderBy('v.arrived_at').execute();
    const items = rows.map((r) => {
      const triageDue = new Date(new Date(r.arrived_at).getTime() + s.triage_target_min * 60_000);
      const doctorDue = r.first_triage_at && r.target_doctor_min !== null ? new Date(new Date(r.first_triage_at).getTime() + r.target_doctor_min * 60_000) : null;
      const retriageDue = s.retriage_alert && r.status === 'triaged' && r.last_triage_at && r.retriage_min ? new Date(new Date(r.last_triage_at).getTime() + r.retriage_min * 60_000) : null;
      // 0088 (C): პირველადი ჩანაწერი — ექიმის აყვანიდან initial_note_min წთ-ში
      const noteDue = r.doctor_at && !r.initial_signed ? new Date(new Date(r.doctor_at).getTime() + (s.initial_note_min ?? 60) * 60_000) : null;
      const name = q.tv && s.tv_patient_names === 'initials' ? (r.is_unknown && r.first_name === 'უცნობი' ? `უცნობი #${r.unknown_no}` : initials(r.first_name, r.last_name)) : `${r.first_name} ${r.last_name}`;
      const base = {
        encounter_id: r.encounter_id, visit_no: r.visit_no, department_id: r.department_id, department_name: r.department_name, arrived_at: r.arrived_at,
        arrival_mode: r.arrival_mode, arrival_name: r.arrival_name, arrival_kind: r.arrival_kind, status: r.status,
        spot: r.spot_id ? { id: r.spot_id, code: r.spot_code, name: r.spot_name, kind: r.spot_kind } : null,
        triage: r.triage_level ? { scale: r.triage_scale, level: r.triage_level, name: r.level_name, color: r.color, target_doctor_min: r.target_doctor_min, retriage_min: r.retriage_min } : null,
        first_triage_at: r.first_triage_at, last_triage_at: r.last_triage_at, doctor_at: r.doctor_at,
        doctor: r.doctor_id ? { id: r.doctor_id, name: r.doctor_name } : null, nurse: r.nurse_id ? { id: r.nurse_id, name: r.nurse_name } : null,
        waiting_for: r.waiting_for, waiting_auto: r.waiting_auto, news2: r.news2_score !== null ? { score: r.news2_score, level: r.news2_level } : null,
        initial_note: r.doctor_at ? { signed: r.initial_signed, due_at: noteDue?.toISOString() ?? null, overdue: !!noteDue && now > noteDue } : null,
        patient: { name, gender: r.gender, age: ageYears(r.birth_date as unknown as string, now), age_estimated: r.birth_date_estimated, is_unknown: r.is_unknown, unknown_no: r.unknown_no },
        timers: {
          wait_min: minutes(r.arrived_at, now), door_to_triage_min: r.first_triage_at ? minutes(r.arrived_at, new Date(r.first_triage_at)) : null,
          door_to_doctor_min: r.doctor_at ? minutes(r.arrived_at, new Date(r.doctor_at)) : null,
          triage_due_at: r.first_triage_at ? null : triageDue.toISOString(), triage_overdue: !r.first_triage_at && now > triageDue,
          doctor_due_at: !r.doctor_at && doctorDue ? doctorDue.toISOString() : null, doctor_overdue: !r.doctor_at && !!doctorDue && now > doctorDue,
          retriage_due_at: retriageDue?.toISOString() ?? null, retriage_overdue: !!retriageDue && now > retriageDue,
        },
      };
      if (q.tv) return base;
      return { ...base, patient_id: r.patient_id, chief_complaint: r.chief_complaint, ambulance_crew: r.ambulance_crew, has_allergy: r.has_allergy,
        patient: { ...base.patient, first_name: r.first_name, last_name: r.last_name, personal_number: r.personal_number } };
    });
    const spots = await this.db.selectFrom('er_spots as s').innerJoin('departments as d', 'd.id', 's.department_id')
      .select(['s.id', 's.code', 's.name', 's.kind', 's.department_id', 'd.name as department_name']).where('s.is_active', '=', true).where('d.type', '=', 'emergency').where('d.is_active', '=', true)
      .$if(!!q.department_id, (x) => x.where('s.department_id', '=', q.department_id!)).orderBy('d.name').orderBy('s.sort_order').orderBy('s.code').execute();
    const occ = new Map(items.filter((i) => i.spot).map((i) => [i.spot!.id, i.encounter_id]));
    const counts = {
      total: items.length, waiting_triage: items.filter((i) => i.status === 'waiting').length, waiting_doctor: items.filter((i) => i.status === 'triaged').length,
      in_treatment: items.filter((i) => i.status === 'in_treatment').length,
      overdue: items.filter((i) => i.timers.triage_overdue || i.timers.doctor_overdue || i.timers.retriage_overdue).length,
      notes_overdue: items.filter((i) => i.initial_note?.overdue).length,
      by_level: Object.fromEntries([...new Set(items.filter((i) => i.triage).map((i) => i.triage!.level))].sort().map((l) => [l, items.filter((i) => i.triage?.level === l).length])),
      spots_free: spots.filter((x) => !occ.has(x.id)).length, spots_total: spots.length,
    };
    // რბილი კავშირი → roster: „მორიგე ექიმი ახლა“ (roster არააქტიური / გამორთული პარამეტრი → ცარიელი)
    let onDuty: { department_id: string; name: string; phone: string | null; duty_name: string | null }[] = [];
    if (s.show_on_duty) {
      const deps = q.department_id ? [q.department_id] : (await this.departments()).map((d) => d.id);
      for (const dep of deps) onDuty.push(...(await this.roster.now({ departmentId: dep, category: 'doctor' }, now)).map((x) => ({ department_id: dep, name: x.name, phone: q.tv ? null : x.phone, duty_name: x.duty_name ?? null })));
      onDuty = onDuty.slice(0, 20);
    }
    return { now: now.toISOString(), settings: { board_refresh_sec: s.board_refresh_sec, triage_target_min: s.triage_target_min, retriage_alert: s.retriage_alert, news2_hint: s.news2_hint },
      items, spots: spots.map((x) => ({ ...x, encounter_id: occ.get(x.id) ?? null })), counts, on_duty: onDuty };
  }

  // ---------------------------------------------------------------- ბარათი / ისტორია
  async visit(id: string, u?: AuthUser) {
    const v = await this.db.selectFrom('er_visits as v').innerJoin('er_arrival_modes as am', 'am.code', 'v.arrival_mode').innerJoin('departments as dep', 'dep.id', 'v.department_id')
      .leftJoin('er_spots as sp', 'sp.id', 'v.spot_id').leftJoin('users as d', 'd.id', 'v.doctor_id').leftJoin('users as n', 'n.id', 'v.nurse_id')
      .leftJoin('users as c', 'c.id', 'v.created_by').leftJoin('external_institutions as ei', 'ei.id', 'v.referral_institution_id')
      .leftJoin('er_triage_levels as l', (j) => j.onRef('l.scale_code', '=', 'v.triage_scale').onRef('l.level', '=', 'v.triage_level'))
      .selectAll('v').select(['am.name as arrival_name', 'am.kind as arrival_kind', 'dep.name as department_name', 'sp.name as spot_name', 'ei.name as referral_institution_name',
        'l.name as level_name', 'l.color', sql<string | null>`d.first_name || ' ' || d.last_name`.as('doctor_name'), sql<string | null>`n.first_name || ' ' || n.last_name`.as('nurse_name'),
        sql<string | null>`c.first_name || ' ' || c.last_name`.as('created_by_name')])
      .where('v.encounter_id', '=', id).executeTakeFirst();
    if (!v) throw new NotFoundException('ER-ის შემთხვევა ვერ მოიძებნა');
    const [patient, triage, allergies, diagnoses] = await Promise.all([
      this.db.selectFrom('patients').select(['id', 'first_name', 'last_name', 'personal_number', 'passport_number', 'birth_date', 'birth_date_estimated', 'gender', 'phone_number', 'is_unknown', 'unknown_no', 'merged_into_id'])
        .where('id', '=', v.patient_id).executeTakeFirstOrThrow(),
      this.db.selectFrom('er_triage as t').innerJoin('er_triage_levels as l', (j) => j.onRef('l.scale_code', '=', 't.scale_code').onRef('l.level', '=', 't.level'))
        .innerJoin('users as u', 'u.id', 't.user_id').leftJoin('encounter_vitals as ev', 'ev.id', 't.vitals_id')
        .select(['t.id', 't.scale_code', 't.level', 'l.name as level_name', 'l.color', 't.is_retriage', 't.news2_score', 't.news2_level', 't.gcs', 't.discriminator', 't.note', 't.recorded_at',
          sql<string>`u.first_name || ' ' || u.last_name`.as('user_name'), 'ev.systolic_bp', 'ev.diastolic_bp', 'ev.heart_rate', 'ev.respiratory_rate', 'ev.temperature', 'ev.spo2', 'ev.o2_supplement',
          'ev.o2_flow', 'ev.consciousness', 'ev.pain', 'ev.glucose', 'ev.weight_kg'])
        .where('t.encounter_id', '=', id).orderBy('t.recorded_at', 'desc').execute(),
      this.db.selectFrom('patient_allergies').select(['id', 'substance', 'reaction_type', 'severity']).where('patient_id', '=', v.patient_id).where('is_active', '=', true).execute(),
      this.db.selectFrom('encounter_diagnoses').selectAll().where('encounter_id', '=', id).orderBy('created_at').execute(),
    ]);
    // 0088: კლინიკური ჩაწერა (ჩანაწერი / ICD-10 / დიაგნოსტიკა / კონსულტაცია) — ER აქტიური, შემთხვევა მიმდინარე, doctor_write
    const s = await this.settings();
    const active = await this.modules.isActive('er').catch(() => false);
    const clinical = { write: !!u && active && !v.ended_at && await erCanWrite(u, v.doctor_id && v.doctor_at ? v.doctor_id : null),
      dx_default_priority: s.dx_default_priority ?? 'urgent', doctor_write: s.doctor_write ?? 'team' };
    return { ...v, patient: { ...patient, age: ageYears(patient.birth_date as unknown as string) }, triage, allergies, diagnoses, clinical };
  }
  async patientVisits(patientId: string) {
    return this.db.selectFrom('er_visits as v').innerJoin('departments as d', 'd.id', 'v.department_id')
      .leftJoin('er_triage_levels as l', (j) => j.onRef('l.scale_code', '=', 'v.triage_scale').onRef('l.level', '=', 'v.triage_level'))
      .select(['v.encounter_id', 'v.visit_no', 'v.arrived_at', 'v.status', 'v.chief_complaint', 'v.ended_at', 'v.end_reason', 'd.name as department_name', 'l.name as level_name', 'l.color'])
      .where('v.patient_id', '=', patientId).orderBy('v.arrived_at', 'desc').limit(100).execute();
  }

  // ---------------------------------------------------------------- ადმინისტრირება (ცნობარები)
  async saveSpot(id: string | null, d: SpotDto, ctx: AuditContext) {
    await this.settings();
    try {
      let r;
      if (id) {
        if (d.is_active === false && await this.db.selectFrom('er_visits').select('visit_no').where('spot_id', '=', id).where('ended_at', 'is', null).executeTakeFirst()) {
          throw new ConflictException('ადგილი ახლა დაკავებულია — ჯერ გაათავისუფლეთ');
        }
        const set = { ...(d.name && { name: d.name.trim() }), ...(d.kind && { kind: d.kind }), ...(d.code && { code: d.code }),
          ...(d.is_active !== undefined && { is_active: d.is_active }), ...(d.sort_order !== undefined && { sort_order: d.sort_order }) };
        if (!Object.keys(set).length) throw new BadRequestException('ცვლილება არ არის');
        r = await this.db.updateTable('er_spots').set(set).where('id', '=', id).returningAll().executeTakeFirst();
        if (!r) throw new NotFoundException('ადგილი ვერ მოიძებნა');
      } else {
        if (!d.department_id || !d.code || !d.name) throw new BadRequestException('განყოფილება, კოდი და დასახელება სავალდებულოა');
        await this.erDepartment(d.department_id);
        r = await this.db.insertInto('er_spots').values({ department_id: d.department_id, code: d.code, name: d.name.trim(), kind: d.kind ?? 'bed', sort_order: d.sort_order ?? 100 }).returningAll().executeTakeFirstOrThrow();
      }
      await this.audit.log(ctx, { action: id ? 'ER_SPOT_UPDATE' : 'ER_SPOT_CREATE', entityName: 'er_spots', entityId: r.id, newData: d });
      return r;
    } catch (e) { mapPgError(e, { er_spots_department_id_code_key: 'ამ განყოფილებაში იგივე კოდი უკვე არის' }); }
  }
  async saveArrival(code: string | null, d: ArrivalDto, ctx: AuditContext) {
    await this.settings();
    try {
      const set = { ...(d.name && { name: d.name.trim() }), ...(d.kind && { kind: d.kind }), ...(d.is_active !== undefined && { is_active: d.is_active }), ...(d.sort_order !== undefined && { sort_order: d.sort_order }) };
      if (code && !Object.keys(set).length) throw new BadRequestException('ცვლილება არ არის');
      const r = code
        ? await this.db.updateTable('er_arrival_modes').set(set).where('code', '=', code).returningAll().executeTakeFirst()
        : await this.db.insertInto('er_arrival_modes').values({ code: d.code!, name: d.name!.trim(), kind: d.kind ?? 'other', sort_order: d.sort_order ?? 100 }).returningAll().executeTakeFirst();
      if (!r) throw new NotFoundException('შემოსვლის გზა ვერ მოიძებნა');
      await this.audit.log(ctx, { action: code ? 'ER_ARRIVAL_UPDATE' : 'ER_ARRIVAL_CREATE', entityName: 'er_arrival_modes', entityId: r.code, newData: d });
      return r;
    } catch (e) { mapPgError(e, { er_arrival_modes_pkey: 'იგივე კოდი უკვე არსებობს' }); }
  }
  /** შკალა + დონეები (დონე არ იშლება — მხოლოდ is_active; სისტემური შკალის კოდი / დონეების რაოდენობა — მხოლოდ რედაქტირება) */
  async saveScale(code: string | null, d: ScaleDto, ctx: AuditContext) {
    const s = await this.settings();
    try {
      return await this.db.transaction().execute(async (trx) => {
        let sc;
        if (code) {
          const set = { ...(d.name && { name: d.name.trim() }), ...(d.description !== undefined && { description: d.description }), ...(d.is_active !== undefined && { is_active: d.is_active }) };
          sc = Object.keys(set).length ? await trx.updateTable('er_triage_scales').set(set).where('code', '=', code).returningAll().executeTakeFirst()
            : await trx.selectFrom('er_triage_scales').selectAll().where('code', '=', code).executeTakeFirst();
          if (!sc) throw new NotFoundException('შკალა ვერ მოიძებნა');
          if (d.is_active === false && s.triage_scale === code) throw new ConflictException('მოქმედ (ნაგულისხმევ) შკალას ვერ გათიშავთ — ჯერ შეცვალეთ მოდულის პარამეტრი');
        } else {
          if (!d.code || !d.name || !d.levels?.length) throw new BadRequestException('კოდი, დასახელება და მინიმუმ ერთი დონე სავალდებულოა');
          sc = await trx.insertInto('er_triage_scales').values({ code: d.code, name: d.name.trim(), description: d.description ?? null }).returningAll().executeTakeFirstOrThrow();
        }
        for (const l of d.levels ?? []) {
          await trx.insertInto('er_triage_levels').values({ scale_code: sc.code, level: l.level, name: l.name.trim(), color: l.color, target_doctor_min: l.target_doctor_min,
            retriage_min: l.retriage_min ?? null, description: l.description ?? null, is_active: l.is_active ?? true })
            .onConflict((oc) => oc.columns(['scale_code', 'level']).doUpdateSet({ name: l.name.trim(), color: l.color, target_doctor_min: l.target_doctor_min, retriage_min: l.retriage_min ?? null,
              description: l.description ?? null, is_active: l.is_active ?? true })).execute();
        }
        const levels = await this.scaleLevels(sc.code, trx);
        if (!levels.some((l) => l.is_active)) throw new BadRequestException('შკალას მინიმუმ ერთი აქტიური დონე სჭირდება');
        await this.audit.log(ctx, { action: code ? 'ER_SCALE_UPDATE' : 'ER_SCALE_CREATE', entityName: 'er_triage_scales', entityId: sc.code, newData: d }, trx);
        return { ...sc, levels };
      });
    } catch (e) { mapPgError(e, { er_triage_scales_pkey: 'იგივე კოდი უკვე არსებობს' }); }
  }
}

// ======================================================================= controller
const uuidOk = (v?: string) => !v || /^[0-9a-f-]{36}$/i.test(v);

@Controller('er')
@RequireModule('er')
export class ErController {
  constructor(private readonly s: ErService) {}
  @Get('meta') @Roles(...ER_READ, 'receptionist') meta(@CurrentUser() u: AuthUser) { return this.s.meta(u); }
  @Get('staff') @Roles(...ER_WRITE) staff() { return this.s.staff(); }
  @Get('board') @Roles(...ER_READ) board(@Query('department_id') dep?: string, @Query('tv') tv?: string) {
    if (!uuidOk(dep)) throw new BadRequestException('არასწორი department_id');
    return this.s.board({ department_id: dep || undefined, tv: tv === '1' || tv === 'true' });
  }
  @Post('visits') @Roles(...ER_REG) register(@Body() d: RegisterDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.register(d, u, auditCtx(r)); }
  @Get('visits/:id') @ClinicalHistory() @Roles(...ER_READ, 'doctor', 'nurse') visit(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser) { return this.s.visit(id, u); }
  @Post('visits/:id/triage') @HttpCode(200) @Roles(...ER_WRITE) triage(@Param('id', ParseUUIDPipe) id: string, @Body() d: TriageDto, @CurrentUser() u: AuthUser, @Req() r: Request) {
    return this.s.triage(id, d, u, auditCtx(r));
  }
  @Post('visits/:id/pickup') @HttpCode(200) @Roles('er_doctor') pickup(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.pickup(id, u, auditCtx(r)); }
  @Patch('visits/:id') @Roles(...ER_WRITE) assign(@Param('id', ParseUUIDPipe) id: string, @Body() d: AssignDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.assign(id, d, u, auditCtx(r)); }
  @Post('visits/:id/cancel') @HttpCode(200) @Roles(...ER_REG) cancel(@Param('id', ParseUUIDPipe) id: string, @Body() d: CancelDto, @CurrentUser() u: AuthUser, @Req() r: Request) {
    return this.s.cancel(id, d.reason.trim(), u, auditCtx(r));
  }
  @Get('patients/:id/visits') @ClinicalHistory() @Roles(...ER_READ, 'receptionist', 'doctor', 'nurse') patientVisits(@Param('id', ParseUUIDPipe) id: string) { return this.s.patientVisits(id); }

  @Post('admin/spots') @Roles(...ER_MANAGE) spot(@Body() d: SpotDto, @Req() r: Request) { return this.s.saveSpot(null, d, auditCtx(r)); }
  @Patch('admin/spots/:id') @Roles(...ER_MANAGE) spotU(@Param('id', ParseUUIDPipe) id: string, @Body() d: SpotDto, @Req() r: Request) { return this.s.saveSpot(id, d, auditCtx(r)); }
  @Post('admin/arrival-modes') @Roles(...ER_MANAGE) arr(@Body() d: ArrivalDto, @Req() r: Request) {
    if (!d.code || !d.name) throw new BadRequestException('კოდი და დასახელება სავალდებულოა');
    return this.s.saveArrival(null, d, auditCtx(r));
  }
  @Patch('admin/arrival-modes/:code') @Roles(...ER_MANAGE) arrU(@Param('code') code: string, @Body() d: ArrivalDto, @Req() r: Request) { return this.s.saveArrival(code, d, auditCtx(r)); }
  @Post('admin/scales') @Roles(...ER_MANAGE) scale(@Body() d: ScaleDto, @Req() r: Request) { return this.s.saveScale(null, d, auditCtx(r)); }
  @Patch('admin/scales/:code') @Roles(...ER_MANAGE) scaleU(@Param('code') code: string, @Body() d: ScaleDto, @Req() r: Request) { return this.s.saveScale(code, d, auditCtx(r)); }
}

@Module({ controllers: [ErController], providers: [ErService], exports: [ErService] })
export class ErModule {}
