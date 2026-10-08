import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, Module, NotFoundException, Param, ParseUUIDPipe,
  Patch, Post, Query, Req } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import type { Request } from 'express';
import { sql, type Transaction } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser } from '../auth/roles';
import { mapPgError } from '../common/pg-errors';
import { loadEnv } from '../config/env';
import type { DB } from '../database/db';
import { InjectDb, type Database } from '../database/database.module';
import { ModulesService } from '../modules/modules';
import { NotificationsService } from '../notifications/notifications';
import { apache2, infusedVolume, labCanonical, mlHToDoseRate, rateAt, sofa, toMcgKgMin, type ApacheAdmission, type ApacheOverrides, type DoseRateUnit,
  type InfusionEvent, type Obs, type SofaOverrides } from './icu-calc';
import { InpatientModule, InpatientService } from './inpatient';
import { news2 } from './news2';

type Trx = Transaction<DB>;
type Ex = Database | Trx;
const TZ = loadEnv().CLINIC_TZ;
const num = ({ value }: { value: unknown }) => (value === '' || value === null || value === undefined ? undefined : Number(value));
const READ = ['admin', 'doctor', 'nurse', 'manager', 'pharmacist'] as const;
const WRITE = ['admin', 'doctor', 'nurse'] as const;
const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const r1 = (v: number) => Math.round(v * 10) / 10;

export const ICU_FEATURES = ['sheet', 'ventilation', 'infusions', 'sofa', 'apache', 'abg', 'bundles', 'icu_note', 'board'] as const;
export type IcuFeature = (typeof ICU_FEATURES)[number];
export const FEATURE_KA: Record<IcuFeature, string> = {
  sheet: 'მონიტორინგის ფურცელი', ventilation: 'ხელოვნური ვენტილაცია', infusions: 'ვაზოპრესორები / ტიტრაცია', sofa: 'SOFA', apache: 'APACHE II', abg: 'სისხლის აირები',
  bundles: 'bundle-ები (VAP / CLABSI)', icu_note: 'ICU დღიური / გაყვანის შეჯამება', board: 'რეანიმაციის დაფა',
};
export interface IcuSettings {
  monitor_interval_min: 15 | 30 | 60; fast_interval_max_hours: number; monitor_gap_hours: number; intensive_features: IcuFeature[];
  news2_alerts: boolean; infusion_to_balance: boolean; titration_reason: boolean; bundle_reminder_time: string; sofa_reminder_time: string; readmit_hours: number;
  vent_billing: boolean; vent_day_tariff_id: string | null; vasoactive: Record<string, string[]>; lab_map: Record<string, string>;
}
export const ORIGIN_KA: Record<string, string> = { er: 'მიმღები / სასწრაფო', or: 'საოპერაციო', ward: 'განყოფილება', other_clinic: 'სხვა კლინიკა', direct: 'პირდაპირ' };
export const EXIT_KA: Record<string, string> = { improved: 'გაუმჯობესებით', stable: 'სტაბილური', worse: 'გაუარესებით', died: 'გარდაიცვალა' };
export const VENT_KA: Record<string, string> = { invasive: 'ინვაზიური', niv: 'არაინვაზიური (NIV)', hfnc: 'მაღალი ნაკადის ჟანგბადი (HFNC)' };
const END_KA: Record<string, string> = { extubated: 'ექსტუბაცია', self_extub: 'თვითექსტუბაცია', accidental: 'შემთხვევითი', switch: 'სხვა რეჟიმზე გადასვლა', trach: 'ტრაქეოსტომა', death: 'გარდაცვალება', transfer: 'გადაყვანა' };
export const VENT_MODES = ['VC-AC', 'PC-AC', 'PRVC', 'SIMV', 'PSV', 'CPAP', 'APRV', 'BiPAP', 'NIV-PS', 'HFNC', 'სხვა'] as const;

// ================================================================= DTO
export class ObservationDto {
  @IsOptional() @IsDateString() recorded_at?: string;
  @IsOptional() @Transform(num) @IsInt() @Min(40) @Max(300) systolic_bp?: number;
  @IsOptional() @Transform(num) @IsInt() @Min(20) @Max(200) diastolic_bp?: number;
  @IsOptional() @Transform(num) @IsInt() @Min(15) @Max(250) map_mmhg?: number;
  @IsOptional() @IsBoolean() map_invasive?: boolean;
  @IsOptional() @Transform(num) @IsInt() @Min(20) @Max(300) heart_rate?: number;
  @IsOptional() @Transform(num) @IsInt() @Min(4) @Max(80) respiratory_rate?: number;
  @IsOptional() @Transform(num) @IsInt() @Min(30) @Max(100) spo2?: number;
  @IsOptional() @Transform(num) @IsNumber({ maxDecimalPlaces: 1 }) @Min(30) @Max(45) temperature?: number;
  @IsOptional() @Transform(num) @IsInt() @Min(-10) @Max(40) cvp?: number;
  @IsOptional() @Transform(num) @IsInt() @Min(0) @Max(150) etco2?: number;
  @IsOptional() @Transform(num) @IsNumber({ maxDecimalPlaces: 1 }) @Min(1) @Max(9) pupil_l?: number;
  @IsOptional() @Transform(num) @IsNumber({ maxDecimalPlaces: 1 }) @Min(1) @Max(9) pupil_r?: number;
  @IsOptional() @IsIn(['brisk', 'sluggish', 'fixed']) pupil_l_react?: string;
  @IsOptional() @IsIn(['brisk', 'sluggish', 'fixed']) pupil_r_react?: string;
  @IsOptional() @Transform(num) @IsInt() @Min(1) @Max(4) gcs_e?: number;
  @IsOptional() @Transform(num) @IsInt() @Min(1) @Max(5) gcs_v?: number;
  @IsOptional() @Transform(num) @IsInt() @Min(1) @Max(6) gcs_m?: number;
  @IsOptional() @IsBoolean() gcs_intubated?: boolean;
  @IsOptional() @Transform(num) @IsInt() @Min(-5) @Max(4) rass?: number;
  @IsOptional() @IsIn(['A', 'C', 'V', 'P', 'U']) consciousness?: 'A' | 'C' | 'V' | 'P' | 'U';
  @IsOptional() @IsBoolean() o2_supplement?: boolean;
  @IsOptional() @Transform(num) @IsNumber() @Min(0) @Max(80) o2_flow?: number;
  @IsOptional() @Transform(num) @IsNumber({ maxDecimalPlaces: 1 }) @Min(0.5) @Max(60) glucose?: number;
  @IsOptional() @Transform(num) @IsNumber() @Min(0) @Max(5000) urine_ml?: number;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}
export class EpisodePatchDto {
  @IsOptional() @IsIn(Object.keys(ORIGIN_KA)) origin?: string;
  @IsOptional() @IsString() @MaxLength(2000) reason?: string;
  @IsOptional() @Transform(num) @IsNumber({ maxDecimalPlaces: 1 }) @Min(0.3) @Max(400) admission_weight_kg?: number;
  @IsOptional() @IsIn(Object.keys(EXIT_KA)) exit_condition?: string;
  @IsOptional() @IsString() @MaxLength(2000) exit_note?: string;
}
export class IntervalDto {
  @IsOptional() @IsIn([15, 30, 60, null]) interval_min?: 15 | 30 | 60 | null;
  @IsOptional() @IsInt() @Min(1) @Max(72) hours?: number;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
export class VentSettingsDto {
  @IsOptional() @IsDateString() recorded_at?: string;
  @IsString() @Length(2, 12) mode: string;
  @IsOptional() @Transform(num) @IsInt() @Min(21) @Max(100) fio2?: number;
  @IsOptional() @Transform(num) @IsNumber({ maxDecimalPlaces: 1 }) @Min(0) @Max(30) peep?: number;
  @IsOptional() @Transform(num) @IsInt() @Min(10) @Max(2500) vt_ml?: number;
  @IsOptional() @Transform(num) @IsInt() @Min(0) @Max(80) rate_set?: number;
  @IsOptional() @Transform(num) @IsInt() @Min(0) @Max(100) rate_total?: number;
  @IsOptional() @Transform(num) @IsInt() @Min(0) @Max(80) ppeak?: number;
  @IsOptional() @Transform(num) @IsInt() @Min(0) @Max(80) pplat?: number;
  @IsOptional() @Transform(num) @IsNumber({ maxDecimalPlaces: 1 }) @Min(0) @Max(40) ps?: number;
  @IsOptional() @Transform(num) @IsNumber({ maxDecimalPlaces: 1 }) @Min(0) @Max(40) ipap?: number;
  @IsOptional() @Transform(num) @IsNumber({ maxDecimalPlaces: 1 }) @Min(0) @Max(30) epap?: number;
  @IsOptional() @Transform(num) @IsInt() @Min(1) @Max(80) flow_lpm?: number;
  @IsOptional() @Transform(num) @IsNumber({ maxDecimalPlaces: 1 }) @Min(0) @Max(60) mv_l?: number;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}
export class VentStartDto {
  @IsIn(['invasive', 'niv', 'hfnc']) kind: 'invasive' | 'niv' | 'hfnc';
  @IsIn(['ett', 'trach', 'mask', 'nasal', 'helmet']) airway: string;
  @IsOptional() @IsDateString() started_at?: string;
  @IsOptional() @IsUUID() performed_by?: string;
  @IsOptional() @IsString() @MaxLength(200) performed_where?: string;
  @IsOptional() @Transform(num) @IsNumber({ maxDecimalPlaces: 1 }) @Min(2) @Max(10) ett_size?: number;
  @IsOptional() @Transform(num) @IsNumber({ maxDecimalPlaces: 1 }) @Min(5) @Max(35) ett_depth_cm?: number;
  @IsOptional() @IsInt() @Min(1) @Max(10) attempts?: number;
  @IsOptional() @IsBoolean() difficult?: boolean;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  @IsOptional() @ValidateNested() @Type(() => VentSettingsDto) settings?: VentSettingsDto;
}
export class VentEndDto {
  @IsOptional() @IsDateString() ended_at?: string;
  @IsIn(Object.keys(END_KA)) reason: string;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
}
export class AbgDto {
  @IsOptional() @IsDateString() sampled_at?: string;
  @IsOptional() @IsIn(['arterial', 'venous', 'capillary']) sample?: string;
  @IsOptional() @Transform(num) @IsNumber({ maxDecimalPlaces: 2 }) @Min(6.5) @Max(8) ph?: number;
  @IsOptional() @Transform(num) @IsNumber({ maxDecimalPlaces: 1 }) @Min(5) @Max(200) pco2?: number;
  @IsOptional() @Transform(num) @IsNumber({ maxDecimalPlaces: 1 }) @Min(10) @Max(700) po2?: number;
  @IsOptional() @Transform(num) @IsNumber({ maxDecimalPlaces: 1 }) @Min(1) @Max(60) hco3?: number;
  @IsOptional() @Transform(num) @IsNumber({ maxDecimalPlaces: 1 }) @Min(-40) @Max(40) be?: number;
  @IsOptional() @Transform(num) @IsNumber({ maxDecimalPlaces: 1 }) @Min(0) @Max(40) lactate?: number;
  @IsOptional() @Transform(num) @IsNumber({ maxDecimalPlaces: 1 }) @Min(0) @Max(100) sao2?: number;
  @IsOptional() @Transform(num) @IsInt() @Min(21) @Max(100) fio2?: number;
  @IsOptional() @Transform(num) @IsNumber({ maxDecimalPlaces: 1 }) @Min(90) @Max(200) na?: number;
  @IsOptional() @Transform(num) @IsNumber({ maxDecimalPlaces: 1 }) @Min(1) @Max(12) k?: number;
  @IsOptional() @Transform(num) @IsNumber({ maxDecimalPlaces: 1 }) @Min(0.5) @Max(60) glucose?: number;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}
class ApacheOptsDto {
  @IsOptional() @IsString() @Length(2, 30) category?: string;
  @IsOptional() @IsBoolean() emergency_surgery?: boolean;
  @IsOptional() @IsBoolean() chronic_health?: boolean;
  @IsOptional() @IsIn(['nonoperative', 'emergency_postop', 'elective_postop']) admission_type?: ApacheAdmission;
  @IsOptional() @IsBoolean() arf?: boolean;
}
export class ScoreDto {
  @IsIn(['sofa', 'apache2']) kind: 'sofa' | 'apache2';
  @IsOptional() @IsDateString() window_to?: string;
  @IsOptional() @IsObject() overrides?: Record<string, number | null>;
  @IsOptional() @IsBoolean() resp_support?: boolean;
  @IsOptional() @IsBoolean() accept_missing?: boolean;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
  @IsOptional() @ValidateNested() @Type(() => ApacheOptsDto) apache?: ApacheOptsDto;
}
export class BundleDto {
  @IsIn(['vap', 'clabsi']) bundle: 'vap' | 'clabsi';
  @IsObject() answers: Record<string, 'yes' | 'no' | 'na'>;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
}
export class BundleItemDto {
  @IsOptional() @IsIn(['vap', 'clabsi']) bundle?: 'vap' | 'clabsi';
  @IsOptional() @IsString() @Length(3, 300) label?: string;
  @IsOptional() @IsInt() @Min(0) @Max(10_000) sort_order?: number;
  @IsOptional() @IsBoolean() is_active?: boolean;
}
export class ApacheCategoryDto {
  @IsOptional() @IsString() @Length(2, 200) name?: string;
  @IsOptional() @IsNumber() @Min(-10) @Max(10) weight?: number;
  @IsOptional() @IsBoolean() is_active?: boolean;
}
export class VoidDto { @IsString() @Length(3, 1000) reason: string }
export class StatsQuery { @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) from?: string; @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) to?: string; @IsOptional() @IsUUID() department_id?: string }

interface Ctx {
  encounter_id: string; patient_id: string; status: string; adm_no: string; first_name: string; last_name: string; birth_date: string; age: number; attending_doctor_id: string | null;
  department_id: string | null; department_name: string | null; care_level: string; dep_features: string[] | null; dep_interval: number | null;
  episode: { id: string; started_at: string; department_id: string; admission_weight_kg: string | null; monitor_interval_min: number | null; monitor_interval_from: string | null;
    monitor_interval_until: string | null } | null;
  features: IcuFeature[];
}

/**
 * რეანიმაცია / ინტენსიური (0047).
 *   წერს: მიმდინარე (ICU / ინტენსიური) განყოფილების ექთანი / ექიმი (admin); SOFA / APACHE II-ის დადასტურება, ფურცლის ინტერვალი, გასვლის მდგომარეობა — ექიმი.
 *   ფუნქციები — განყოფილების დონით (icu: ყველა; intensive: icu.intensive_features) ან განყოფილების საკუთარი სიით.
 *   ჩანაწერები არ რედაქტირდება — გაუქმება მიზეზით (DB trigger).
 */
@Injectable()
export class IcuService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService, private readonly ipd: InpatientService,
              private readonly modules: ModulesService, private readonly bell: NotificationsService) {}

  settings() { return this.modules.require<IcuSettings>('icu'); }

  featuresFor(s: IcuSettings, level: string, own: string[] | null) { return icuFeatures(s, level, own); }

  // ---------------------------------------------------------------- კონტექსტი
  async ctx(encounterId: string, ex: Ex = this.db): Promise<Ctx> {
    const s = await this.settings();
    const st = await ex.selectFrom('inpatient_stays as st').innerJoin('patients as p', 'p.id', 'st.patient_id').innerJoin('encounters as e', 'e.id', 'st.encounter_id')
      .leftJoin('bed_assignments as a', (j) => j.onRef('a.encounter_id', '=', 'st.encounter_id').on('a.ended_at', 'is', null))
      .leftJoin('departments as d', 'd.id', 'a.department_id')
      .select(['st.encounter_id', 'st.patient_id', 'st.status', 'st.adm_no', 'p.first_name', 'p.last_name', sql<string>`to_char(p.birth_date, 'YYYY-MM-DD')`.as('birth_date'),
        sql<number>`extract(year FROM age(p.birth_date))::int`.as('age'), 'e.attending_doctor_id', 'a.department_id', 'd.name as department_name',
        sql<string>`coalesce(d.care_level, 'ward')`.as('care_level'), 'd.icu_features as dep_features', 'd.monitor_interval_min as dep_interval'])
      .where('st.encounter_id', '=', encounterId).executeTakeFirst();
    if (!st) throw new NotFoundException('ჰოსპიტალიზაცია ვერ მოიძებნა');
    const ep = await ex.selectFrom('icu_episodes').select(['id', 'started_at', 'department_id', 'admission_weight_kg', 'monitor_interval_min', 'monitor_interval_from', 'monitor_interval_until'])
      .where('encounter_id', '=', encounterId).where('ended_at', 'is', null).executeTakeFirst();
    const episode = ep ? { ...ep, started_at: String(ep.started_at), monitor_interval_from: ep.monitor_interval_from ? String(ep.monitor_interval_from) : null,
      monitor_interval_until: ep.monitor_interval_until ? String(ep.monitor_interval_until) : null } : null;
    return { ...st, episode, features: this.featuresFor(s, st.care_level, st.dep_features) };
  }
  async canWrite(u: AuthUser, departmentId: string | null, ex: Ex = this.db) {
    if (has(u, 'admin')) return true;
    if (!departmentId || !has(u, 'nurse', 'doctor')) return false;
    return (await this.ipd.me(u, ex)).department_id === departmentId;
  }
  /** ჩაწერა: აქტიური ჰოსპიტალიზაცია, ღია ICU ეპიზოდი, ჩართული ფუნქცია, განყოფილების თანამშრომელი */
  private async writable(encounterId: string, u: AuthUser, feature: IcuFeature | null, ex: Ex = this.db, doctor = false) {
    const c = await this.ctx(encounterId, ex);
    if (c.status !== 'active') throw new ConflictException('ჰოსპიტალიზაცია აქტიური არ არის');
    if (!c.episode) throw new ConflictException({ code: 'ICU_NO_EPISODE', message: 'პაციენტი რეანიმაციაში / ინტენსიურში არ იმყოფება' });
    if (feature && !c.features.includes(feature)) throw new ForbiddenException({ code: 'ICU_FEATURE_OFF', message: `ამ განყოფილებაში გამორთულია: ${FEATURE_KA[feature]}` });
    if (!(await this.canWrite(u, c.department_id, ex))) throw new ForbiddenException('ჩაწერს მიმდინარე განყოფილების ექთანი ან ექიმი');
    if (doctor && !has(u, 'doctor', 'admin')) throw new ForbiddenException('საჭიროა ექიმი');
    return c;
  }
  private when(iso: string | undefined, label = 'დრო', maxHours = 24) {
    const at = iso ? new Date(iso) : new Date();
    if (at.getTime() > Date.now() + 5 * 60_000) throw new BadRequestException(`${label} მომავალშია`);
    if (at.getTime() < Date.now() - maxHours * 3_600_000) throw new BadRequestException(`${label}: ${maxHours} სთ-ზე ძველი ჩანაწერი — მიმართეთ ხელმძღვანელს`);
    return at;
  }
  /** ფურცლის ინტერვალი მომენტში: პაციენტის დროებითი → განყოფილების → მოდულის */
  intervalAt(s: IcuSettings, c: Pick<Ctx, 'episode' | 'dep_interval'>, at: Date) {
    const e = c.episode;
    if (e?.monitor_interval_min && e.monitor_interval_from && e.monitor_interval_until
        && at.getTime() >= new Date(e.monitor_interval_from).getTime() && at.getTime() < new Date(e.monitor_interval_until).getTime()) return e.monitor_interval_min;
    return c.dep_interval ?? s.monitor_interval_min ?? 60;
  }
  /** წონა: ეპიზოდის → ბოლო აწონვა */
  async weight(c: Pick<Ctx, 'episode' | 'patient_id'>, ex: Ex = this.db) {
    if (c.episode?.admission_weight_kg) return Number(c.episode.admission_weight_kg);
    const w = await ex.selectFrom('encounter_vitals as v').innerJoin('encounters as e', 'e.id', 'v.encounter_id').select('v.weight_kg')
      .where('e.patient_id', '=', c.patient_id).where('v.weight_kg', 'is not', null).where('v.voided_at', 'is', null).orderBy('v.recorded_at', 'desc').limit(1).executeTakeFirst();
    return w?.weight_kg ? Number(w.weight_kg) : null;
  }
  private async today(ex: Ex = this.db) { return (await sql<{ d: string }>`SELECT to_char(now() AT TIME ZONE ${TZ}, 'YYYY-MM-DD') AS d`.execute(ex)).rows[0].d; }
  private async dayStart(): Promise<string> {
    const m = await this.db.selectFrom('system_modules').select('settings').where('code', '=', 'inpatient').executeTakeFirst();
    const v = (m?.settings as Record<string, unknown> | undefined)?.fluid_day_start;
    return typeof v === 'string' && /^\d{2}:\d{2}$/.test(v) ? v : '08:00';
  }
  private name(c: { last_name: string; first_name: string; adm_no: string }) { return `${c.last_name} ${c.first_name} (${c.adm_no})`; }

  // ---------------------------------------------------------------- ეპიზოდი
  async patchEpisode(id: string, dto: EpisodePatchDto, u: AuthUser, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const ep = await trx.selectFrom('icu_episodes').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!ep) throw new NotFoundException('ეპიზოდი ვერ მოიძებნა');
      if (!(await this.canWrite(u, ep.department_id, trx))) throw new ForbiddenException('არედაქტირებს განყოფილების თანამშრომელი');
      const exitFields = dto.exit_condition !== undefined || dto.exit_note !== undefined;
      if (exitFields && !has(u, 'doctor', 'admin')) throw new ForbiddenException('გასვლის მდგომარეობას წერს ექიმი');
      if (exitFields && !ep.ended_at) throw new ConflictException('გასვლის მდგომარეობა — ეპიზოდის დასრულების შემდეგ');
      if (!ep.ended_at || has(u, 'admin')) { /* ok */ } else if (dto.origin !== undefined || dto.admission_weight_kg !== undefined || dto.reason !== undefined) {
        throw new ConflictException('დასრულებულ ეპიზოდში იცვლება მხოლოდ გასვლის მონაცემები');
      }
      const set: Record<string, unknown> = { updated_by: u.id };
      if (dto.origin !== undefined) set.origin = dto.origin;
      if (dto.reason !== undefined) set.reason = dto.reason.trim() || null;
      if (dto.admission_weight_kg !== undefined) set.admission_weight_kg = dto.admission_weight_kg.toFixed(1);
      if (dto.exit_condition !== undefined) set.exit_condition = dto.exit_condition;
      if (dto.exit_note !== undefined) set.exit_note = dto.exit_note.trim() || null;
      const r = await trx.updateTable('icu_episodes').set(set).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await this.audit.log(ctx, { action: 'ICU_EPISODE_UPDATE', entityName: 'icu_episodes', entityId: id, oldData: ep, newData: dto }, trx);
      return r;
    });
  }
  async setInterval(id: string, dto: IntervalDto, u: AuthUser, ctx: AuditContext) {
    const s = await this.settings();
    return this.db.transaction().execute(async (trx) => {
      const ep = await trx.selectFrom('icu_episodes').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!ep || ep.ended_at) throw new NotFoundException('აქტიური ეპიზოდი ვერ მოიძებნა');
      if (!has(u, 'doctor', 'admin') || !(await this.canWrite(u, ep.department_id, trx))) throw new ForbiddenException('ფურცლის ინტერვალს ცვლის განყოფილების ექიმი');
      const min = dto.interval_min ?? null;
      const hours = dto.hours ?? Math.min(6, s.fast_interval_max_hours);
      if (min && hours > s.fast_interval_max_hours) throw new BadRequestException(`ხანგრძლივობა — მაქს. ${s.fast_interval_max_hours} სთ`);
      const r = await trx.updateTable('icu_episodes').set(min
        ? { monitor_interval_min: min, monitor_interval_from: sql`now()`, monitor_interval_until: sql`now() + make_interval(hours => ${hours})`, monitor_interval_by: u.id, updated_by: u.id }
        : { monitor_interval_min: null, monitor_interval_from: null, monitor_interval_until: null, monitor_interval_by: u.id, updated_by: u.id })
        .where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await this.ipd.event(trx, { encounter_id: ep.encounter_id, kind: 'icu_interval', data: { interval_min: min, hours: min ? hours : null, reason: dto.reason ?? null } }, u);
      await this.audit.log(ctx, { action: 'ICU_INTERVAL', entityName: 'icu_episodes', entityId: id, newData: { ...dto, hours } }, trx);
      return r;
    });
  }

  // ---------------------------------------------------------------- მონიტორინგის ფურცელი
  async observe(encounterId: string, dto: ObservationDto, u: AuthUser, ctx: AuditContext) {
    const s = await this.settings();
    const { recorded_at, urine_ml, notes, ...vals } = dto;
    const filled = Object.entries(vals).filter(([k, v]) => v !== undefined && !['map_invasive', 'gcs_intubated', 'o2_flow', 'pupil_l_react', 'pupil_r_react'].includes(k));
    if (!filled.length && urine_ml === undefined) throw new BadRequestException('მინიმუმ ერთი პარამეტრი');
    if (dto.systolic_bp && dto.diastolic_bp && dto.diastolic_bp >= dto.systolic_bp) throw new BadRequestException('დიასტოლური წნევა სისტოლურზე ნაკლები უნდა იყოს');
    if (dto.gcs_intubated && dto.gcs_v) throw new BadRequestException('ინტუბირებულზე ვერბალური პასუხი არ ფასდება (V = T)');
    if ([dto.gcs_e, dto.gcs_m].some((x) => x !== undefined) && !(dto.gcs_e && dto.gcs_m && (dto.gcs_v || dto.gcs_intubated))) throw new BadRequestException('GCS: შეავსეთ E, V (ან T) და M');
    if ((dto.pupil_l_react && !dto.pupil_l) || (dto.pupil_r_react && !dto.pupil_r)) throw new BadRequestException('გუგა: მიუთითეთ ზომა');
    const at = this.when(recorded_at);
    const map = dto.map_mmhg ?? (dto.systolic_bp && dto.diastolic_bp ? Math.round((dto.systolic_bp + 2 * dto.diastolic_bp) / 3) : undefined);
    const gcs = dto.gcs_e && dto.gcs_m ? dto.gcs_e + dto.gcs_m + (dto.gcs_intubated ? 1 : dto.gcs_v ?? 0) : null;
    return this.db.transaction().execute(async (trx) => {
      const c = await this.writable(encounterId, u, 'sheet', trx);
      const nw = c.age >= 16 ? news2({ ...dto, spo2_scale: 1 }) : null;
      let v;
      try {
        v = await trx.insertInto('encounter_vitals').values({
          encounter_id: encounterId, taken_by: u.id, recorded_at: at, icu_sheet: true, source: 'manual',
          systolic_bp: dto.systolic_bp ?? null, diastolic_bp: dto.diastolic_bp ?? null, map_mmhg: map ?? null, map_invasive: !!dto.map_invasive && dto.map_mmhg !== undefined,
          heart_rate: dto.heart_rate ?? null, respiratory_rate: dto.respiratory_rate ?? null, spo2: dto.spo2 ?? null, temperature: dto.temperature?.toFixed(1) ?? null,
          cvp: dto.cvp ?? null, etco2: dto.etco2 ?? null, pupil_l: dto.pupil_l?.toFixed(1) ?? null, pupil_r: dto.pupil_r?.toFixed(1) ?? null,
          pupil_l_react: dto.pupil_l_react ?? null, pupil_r_react: dto.pupil_r_react ?? null,
          gcs_e: dto.gcs_e ?? null, gcs_v: dto.gcs_intubated ? null : dto.gcs_v ?? null, gcs_m: dto.gcs_m ?? null, gcs_intubated: !!dto.gcs_intubated, gcs_total: gcs,
          rass: dto.rass ?? null, consciousness: dto.consciousness ?? null, o2_supplement: dto.o2_supplement ?? null, o2_flow: dto.o2_flow?.toString() ?? null,
          glucose: dto.glucose?.toFixed(1) ?? null, notes: notes?.trim() || null,
          news2: nw?.score ?? null, news2_parts: nw ? JSON.stringify(nw.parts) : null, news2_level: nw?.level ?? null,
        }).returningAll().executeTakeFirstOrThrow();
      } catch (e) { mapPgError(e, { chk_vitals_ranges: 'მნიშვნელობა ფიზიოლოგიურ საზღვრებს სცდება — გადაამოწმეთ' }); }
      if (urine_ml !== undefined && urine_ml > 0) {
        await trx.insertInto('fluid_entries').values({ encounter_id: encounterId, patient_id: c.patient_id, direction: 'out', category: 'urine', volume_ml: String(urine_ml),
          recorded_at: at, vitals_id: v.id, note: 'ICU ფურცელი', created_by: u.id }).execute();
      }
      await this.audit.log(ctx, { action: 'ICU_OBSERVATION', entityName: 'encounter_vitals', entityId: v.id, newData: { ...dto, map_mmhg: map, gcs_total: gcs } }, trx);
      return { ...v, news2_alerts: s.news2_alerts };
    });
  }

  /** ფურცელი: დღე (fluid_day_start-დან 24 სთ) — სლოტები ინტერვალით, დაკვირვებები, ვენტილაცია, ინფუზიები, საათობრივი ბალანსი, ABG */
  async sheet(encounterId: string, day: string | undefined, u: AuthUser) {
    const s = await this.settings();
    const c = await this.ctx(encounterId);
    if (c.episode && s.infusion_to_balance) await this.syncInfusionVolumes(encounterId).catch(() => undefined);
    const ds = await this.dayStart();
    const cur = (await sql<{ d: string }>`SELECT to_char((now() AT TIME ZONE ${TZ}) - ${ds}::time, 'YYYY-MM-DD') AS d`.execute(this.db)).rows[0].d;
    const d = day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : cur;
    const start = new Date((await sql<{ t: string }>`SELECT ((${d}::date + ${ds}::time) AT TIME ZONE ${TZ}) AS t`.execute(this.db)).rows[0].t);
    const end = new Date(start.getTime() + 24 * 3_600_000);
    // სლოტები: ინტერვალი თითო მომენტში (პაციენტის დროებითი რეჟიმი — ფანჯარაში)
    // 15-წუთიან ბადეზე: წერტილი სლოტია, თუ იმ მომენტის ინტერვალის ჯერადია (დღის დასაწყისიდან). ასე დროებითი რეჟიმი
    // საათის შუაში დაწყებისასაც (მაგ. 07:20) მაშინვე ჩანს (07:30, 07:45 …), და მის შემდეგ ბადე ისევ საათებზე სწორდება.
    const slots: string[] = [];
    for (let t = start.getTime(); t < end.getTime(); t += 15 * 60_000) {
      if ((t - start.getTime()) % (this.intervalAt(s, c, new Date(t)) * 60_000) === 0) slots.push(new Date(t).toISOString());
    }
    const vitals = await this.db.selectFrom('encounter_vitals as v').leftJoin('users as x', 'x.id', 'v.taken_by')
      .selectAll('v').select(sql<string>`x.last_name || ' ' || left(x.first_name, 1) || '.'`.as('taken_by_name'))
      .where('v.encounter_id', '=', encounterId).where('v.voided_at', 'is', null).where('v.recorded_at', '>=', start).where('v.recorded_at', '<', end)
      .orderBy('v.recorded_at').execute();
    const vent = await this.db.selectFrom('icu_vent_settings as vs').innerJoin('icu_ventilation as v', 'v.id', 'vs.ventilation_id').leftJoin('users as x', 'x.id', 'vs.recorded_by')
      .selectAll('vs').select(['v.kind', sql<string>`x.last_name || ' ' || left(x.first_name, 1) || '.'`.as('recorded_by_name')])
      .where('vs.encounter_id', '=', encounterId).where('vs.voided_at', 'is', null).where('v.voided_at', 'is', null).where('vs.recorded_at', '>=', start).where('vs.recorded_at', '<', end)
      .orderBy('vs.recorded_at').execute();
    const infusions = await this.infusionsFor(encounterId, start, end, c);
    const fl = await this.db.selectFrom('fluid_entries').select(['direction', 'category', 'volume_ml', 'recorded_at', 'auto_hour', 'order_id'])
      .where('encounter_id', '=', encounterId).where('voided_at', 'is', null).where('recorded_at', '>', start).where('recorded_at', '<=', end).execute();
    const hours = Array.from({ length: 24 }, (_, i) => ({ at: new Date(start.getTime() + i * 3_600_000).toISOString(), in: 0, out: 0, by: {} as Record<string, number> }));
    for (const f of fl) {
      // auto_hour — საათის დასაწყისი; სხვა — ფაქტობრივი დრო (პერიოდის ბოლო) → იმ საათს, რომელშიც მოხვდა
      const t = f.auto_hour ? new Date(f.auto_hour).getTime() : new Date(f.recorded_at).getTime() - 1;
      const i = Math.floor((t - start.getTime()) / 3_600_000);
      if (i < 0 || i >= 24) continue;
      const v = Number(f.volume_ml);
      if (f.direction === 'in') hours[i].in += v; else hours[i].out += v;
      hours[i].by[f.category] = (hours[i].by[f.category] ?? 0) + v;
    }
    let cum = 0;
    const balance = hours.map((h) => { cum += h.in - h.out; return { ...h, in: r1(h.in), out: r1(h.out), net: r1(h.in - h.out), cumulative: r1(cum) }; });
    const abg = await this.abgList(c.patient_id, encounterId, start, end, s);
    const now = Date.now();
    const filledSlots = new Set<number>();
    const vt = vitals.filter((v) => v.icu_sheet).map((v) => new Date(v.recorded_at).getTime());
    for (let i = 0; i < slots.length; i++) {
      const a = new Date(slots[i]).getTime(); const b = i + 1 < slots.length ? new Date(slots[i + 1]).getTime() : end.getTime();
      if (vt.some((t) => t >= a && t < b)) filledSlots.add(i);
    }
    const gaps = slots.map((x, i) => ({ i, at: x })).filter((x) => (x.i + 1 < slots.length ? new Date(slots[x.i + 1]).getTime() : end.getTime()) < now
      && new Date(x.at).getTime() >= (c.episode ? new Date(c.episode.started_at).getTime() - 3_600_000 : Infinity) && !filledSlots.has(x.i)).map((x) => x.at);
    return {
      day: d, today: cur, start, end, day_start: ds, interval_min: this.intervalAt(s, c, new Date()), slots, gaps,
      can_write: c.status === 'active' && !!c.episode && c.features.includes('sheet') && await this.canWrite(u, c.department_id),
      vitals, vent, infusions, balance, totals: { in: r1(balance.reduce((a, h) => a + h.in, 0)), out: r1(balance.reduce((a, h) => a + h.out, 0)), net: r1(cum) }, abg,
    };
  }

  // ---------------------------------------------------------------- ინფუზიები
  /** უწყვეტი ინფუზიები: MAR-ის მოქმედებები → სიჩქარე / დოზა საათობრივად */
  private async infusionsFor(encounterId: string, from: Date, to: Date, c: Pick<Ctx, 'episode' | 'patient_id'>) {
    const orders = await this.db.selectFrom('med_orders as o').leftJoin('med_generics as g', 'g.id', 'o.generic_id')
      .select(['o.id', 'o.status', 'o.titratable', 'o.dose_rate', 'o.dose_rate_unit', 'o.conc_amount', 'o.conc_unit', 'o.conc_volume_ml', 'o.titrate_min', 'o.titrate_max',
        'o.titrate_goal', 'o.weight_kg', 'o.rate_ml_h', 'o.start_at', 'o.stopped_at', 'g.high_alert',
        sql<string>`coalesce(g.inn || coalesce(' ' || g.strength, ''), o.drug_text)`.as('title'), 'g.inn'])
      .where('o.encounter_id', '=', encounterId).where('o.category', '=', 'medication').where('o.order_type', '=', 'continuous')
      .where((eb) => eb.or([eb('o.status', 'in', ['active', 'on_hold']), eb('o.stopped_at', '>', from)])).orderBy('o.created_at').execute();
    if (!orders.length) return [];
    const ev = await this.db.selectFrom('mar_entries as m').leftJoin('users as x', 'x.id', 'm.documented_by')
      .select(['m.id', 'm.order_id', 'm.infusion_action', 'm.rate_ml_h', 'm.dose_rate', 'm.documented_at', 'm.reason', sql<string>`x.last_name || ' ' || left(x.first_name, 1) || '.'`.as('by_name')])
      .where('m.order_id', 'in', orders.map((o) => o.id)).where('m.source', '=', 'infusion').where('m.voided_at', 'is', null).where('m.documented_at', '<', to)
      .orderBy('m.documented_at').execute();
    const w = await this.weight(c);
    return orders.map((o) => {
      const events: InfusionEvent[] = ev.filter((e) => e.order_id === o.id).map((e) => ({ at: new Date(e.documented_at!), action: e.infusion_action as InfusionEvent['action'],
        rate_ml_h: n(e.rate_ml_h), dose_rate: n(e.dose_rate) }));
      const unit = o.dose_rate_unit as DoseRateUnit | null;
      const conc = o.conc_amount && o.conc_unit && o.conc_volume_ml ? { amount: Number(o.conc_amount), unit: o.conc_unit as 'mg', volume_ml: Number(o.conc_volume_ml) } : null;
      const wt = o.weight_kg ? Number(o.weight_kg) : w;
      const doseOf = (rate: number) => { if (!unit || !conc || rate <= 0) return null; try { return mlHToDoseRate(rate, unit, conc, wt); } catch { return null; } };
      const hours = Array.from({ length: Math.ceil((to.getTime() - from.getTime()) / 3_600_000) }, (_, i) => {
        const a = new Date(from.getTime() + i * 3_600_000); const b = new Date(a.getTime() + 3_600_000);
        const st = rateAt(events, a);
        return { at: a.toISOString(), rate_ml_h: st.rate, dose_rate: st.dose_rate ?? doseOf(st.rate), volume_ml: infusedVolume(events, a, b) };
      });
      const nowSt = rateAt(events, new Date());
      return { ...o, unit, weight_used: wt, current_rate_ml_h: nowSt.rate, current_dose_rate: nowSt.dose_rate ?? doseOf(nowSt.rate),
        events: ev.filter((e) => e.order_id === o.id && new Date(e.documented_at!) >= from)
          .map((e) => ({ ...e, dose: e.dose_rate !== null ? Number(e.dose_rate) : n(e.rate_ml_h) !== null ? doseOf(Number(e.rate_ml_h)) : null })), hours };
    });
  }
  /** უწყვეტი ინფუზიის საათობრივი მოცულობა → სითხის ბალანსი (იხ. syncInfusionVolumes) */
  syncInfusionVolumes(encounterId: string) { return syncInfusionVolumes(this.db, encounterId); }

  // ---------------------------------------------------------------- ვენტილაცია
  async ventStart(encounterId: string, dto: VentStartDto, u: AuthUser, ctx: AuditContext) {
    const at = this.when(dto.started_at, 'დაწყების დრო', 72);
    if (dto.kind !== 'invasive' && (dto.ett_size || dto.ett_depth_cm)) throw new BadRequestException('ტუბის ზომა / სიღრმე — მხოლოდ ინვაზიურზე');
    return this.db.transaction().execute(async (trx) => {
      const c = await this.writable(encounterId, u, 'ventilation', trx);
      if (dto.performed_by) {
        const p = await trx.selectFrom('users').select('id').where('id', '=', dto.performed_by).where('is_active', '=', true).executeTakeFirst();
        if (!p) throw new BadRequestException('შემსრულებელი ვერ მოიძებნა');
      }
      let v;
      try {
        v = await trx.insertInto('icu_ventilation').values({ encounter_id: encounterId, patient_id: c.patient_id, episode_id: c.episode!.id, kind: dto.kind, airway: dto.airway,
          started_at: at, performed_by: dto.performed_by ?? (dto.performed_where ? null : dto.kind === 'invasive' && dto.airway === 'ett' ? u.id : null),
          performed_where: dto.performed_where?.trim() || null, ett_size: dto.ett_size?.toFixed(1) ?? null, ett_depth_cm: dto.ett_depth_cm?.toFixed(1) ?? null,
          attempts: dto.attempts ?? null, difficult: !!dto.difficult, notes: dto.notes?.trim() || null, created_by: u.id }).returningAll().executeTakeFirstOrThrow();
      } catch (e) {
        mapPgError(e, { ux_vent_open: 'პაციენტს უკვე აქვს მიმდინარე ვენტილაცია — ჯერ დაასრულეთ (მაგ. „სხვა რეჟიმზე გადასვლა“)',
          chk_vent_airway: 'სასუნთქი გზა ამ ტიპს არ შეესაბამება (ინვაზიური — ტუბი / ტრაქეოსტომა; NIV — ნიღაბი / ცხვირის / ჩაფხუტი; HFNC — ცხვირის კანულა)' });
      }
      if (dto.settings) await this.insertSettings(trx, v.id, encounterId, { ...dto.settings, recorded_at: dto.settings.recorded_at ?? at.toISOString() }, u);
      await this.ipd.event(trx, { encounter_id: encounterId, kind: 'vent_started', data: { id: v.id, kind: dto.kind, airway: dto.airway, ett: dto.ett_size ?? null } }, u);
      await this.audit.log(ctx, { action: 'ICU_VENT_START', entityName: 'icu_ventilation', entityId: v.id, newData: dto }, trx);
      return v;
    });
  }
  private async insertSettings(trx: Trx, ventId: string, encounterId: string, dto: VentSettingsDto, u: AuthUser) {
    return trx.insertInto('icu_vent_settings').values({ ventilation_id: ventId, encounter_id: encounterId, recorded_at: this.when(dto.recorded_at), mode: dto.mode.trim(),
      fio2: dto.fio2 ?? null, peep: dto.peep?.toFixed(1) ?? null, vt_ml: dto.vt_ml ?? null, rate_set: dto.rate_set ?? null, rate_total: dto.rate_total ?? null,
      ppeak: dto.ppeak ?? null, pplat: dto.pplat ?? null, ps: dto.ps?.toFixed(1) ?? null, ipap: dto.ipap?.toFixed(1) ?? null, epap: dto.epap?.toFixed(1) ?? null,
      flow_lpm: dto.flow_lpm ?? null, mv_l: dto.mv_l?.toFixed(1) ?? null, note: dto.note?.trim() || null, recorded_by: u.id }).returningAll().executeTakeFirstOrThrow();
  }
  async ventSettings(ventId: string, dto: VentSettingsDto, u: AuthUser, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const v = await trx.selectFrom('icu_ventilation').selectAll().where('id', '=', ventId).executeTakeFirst();
      if (!v || v.voided_at) throw new NotFoundException('ვენტილაცია ვერ მოიძებნა');
      if (v.ended_at) throw new ConflictException('ვენტილაცია დასრულებულია');
      await this.writable(v.encounter_id, u, 'ventilation', trx);
      const at = this.when(dto.recorded_at);
      if (at < new Date(v.started_at)) throw new BadRequestException('პარამეტრები ვენტილაციის დაწყებამდე ვერ იქნება');
      const r = await this.insertSettings(trx, ventId, v.encounter_id, dto, u);
      await this.audit.log(ctx, { action: 'ICU_VENT_SETTINGS', entityName: 'icu_vent_settings', entityId: r.id, newData: dto }, trx);
      return r;
    });
  }
  async ventEnd(ventId: string, dto: VentEndDto, u: AuthUser, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const v = await trx.selectFrom('icu_ventilation').selectAll().where('id', '=', ventId).forUpdate().executeTakeFirst();
      if (!v || v.voided_at) throw new NotFoundException('ვენტილაცია ვერ მოიძებნა');
      if (v.ended_at) throw new ConflictException('უკვე დასრულებულია');
      const c = await this.ctx(v.encounter_id, trx);
      if (!(await this.canWrite(u, c.department_id, trx))) throw new ForbiddenException('ჩაწერს მიმდინარე განყოფილების ექთანი ან ექიმი');
      const at = this.when(dto.ended_at, 'დასრულების დრო', 72);
      if (at < new Date(v.started_at)) throw new BadRequestException('დასრულება დაწყებამდე ვერ იქნება');
      await trx.updateTable('icu_ventilation').set({ ended_at: at, ended_by: u.id, end_reason: dto.reason, end_note: dto.note?.trim() || null }).where('id', '=', ventId).execute();
      await this.ipd.event(trx, { encounter_id: v.encounter_id, kind: 'vent_ended', data: { id: ventId, kind: v.kind, reason: dto.reason } }, u);
      await this.audit.log(ctx, { action: 'ICU_VENT_END', entityName: 'icu_ventilation', entityId: ventId, newData: dto }, trx);
      return { id: ventId, ended_at: at };
    });
  }

  // ---------------------------------------------------------------- ABG
  async addAbg(encounterId: string, dto: AbgDto, u: AuthUser, ctx: AuditContext) {
    const at = this.when(dto.sampled_at, 'აღების დრო');
    if ([dto.ph, dto.pco2, dto.po2, dto.hco3, dto.lactate].every((x) => x === undefined)) throw new BadRequestException('მინიმუმ ერთი: pH, pCO₂, pO₂, HCO₃⁻, ლაქტატი');
    return this.db.transaction().execute(async (trx) => {
      const c = await this.writable(encounterId, u, 'abg', trx);
      const r = await trx.insertInto('icu_abg').values({ encounter_id: encounterId, patient_id: c.patient_id, sampled_at: at, sample: dto.sample ?? 'arterial',
        ph: dto.ph?.toFixed(2) ?? null, pco2: dto.pco2?.toFixed(1) ?? null, po2: dto.po2?.toFixed(1) ?? null, hco3: dto.hco3?.toFixed(1) ?? null, be: dto.be?.toFixed(1) ?? null,
        lactate: dto.lactate?.toFixed(1) ?? null, sao2: dto.sao2?.toFixed(1) ?? null, fio2: dto.fio2 ?? null, na: dto.na?.toFixed(1) ?? null, k: dto.k?.toFixed(1) ?? null,
        glucose: dto.glucose?.toFixed(1) ?? null, note: dto.note?.trim() || null, created_by: u.id }).returningAll().executeTakeFirstOrThrow();
      await this.audit.log(ctx, { action: 'ICU_ABG', entityName: 'icu_abg', entityId: r.id, newData: dto }, trx);
      return r;
    });
  }

  // ---------------------------------------------------------------- ლაბ. მონაცემები (lab_map → კანონიკური ერთეულები)
  async labValues(patientId: string, keys: string[], from: Date, to: Date, s: IcuSettings) {
    const map = s.lab_map ?? {};
    const want = keys.map((k) => [k, map[k]] as const).filter(([, v]) => typeof v === 'string' && v.includes(':'));
    const out: Record<string, (Obs & { validated: boolean; order_item_id: string; unit: string })[]> = Object.fromEntries(keys.map((k) => [k, []]));
    if (!want.length) return out;
    const codes = want.map(([, v]) => v);
    const rows = await this.db.selectFrom('lab_results as r').innerJoin('lab_analytes as a', 'a.id', 'r.analyte_id').innerJoin('dx_services as sv', 'sv.id', 'a.service_id')
      .innerJoin('dx_order_items as i', 'i.id', 'r.order_item_id').leftJoin('lab_specimens as sp', 'sp.id', 'i.specimen_id')
      .select(['r.value_num', 'r.unit', 'i.status', 'i.id as order_item_id', sql<string>`sv.code || ':' || a.code`.as('code'),
        sql<string>`coalesce(sp.collected_at, i.resulted_at, r.entered_at)`.as('at')])
      .where('i.patient_id', '=', patientId).where('i.status', 'in', ['resulted', 'validated']).where('r.value_num', 'is not', null)
      .where(sql<string>`sv.code || ':' || a.code`, 'in', codes)
      .where(sql<Date>`coalesce(sp.collected_at, i.resulted_at, r.entered_at)`, '>=', from).where(sql<Date>`coalesce(sp.collected_at, i.resulted_at, r.entered_at)`, '<', to)
      .orderBy(sql`coalesce(sp.collected_at, i.resulted_at, r.entered_at)`).execute();
    for (const r of rows) {
      for (const [k, code] of want) {
        if (code !== r.code) continue;
        out[k].push({ value: labCanonical(k, Number(r.value_num), r.unit ?? ''), at: r.at, validated: r.status === 'validated', order_item_id: r.order_item_id, unit: r.unit ?? '',
          detail: r.status === 'validated' ? 'ლაბ.' : 'ლაბ. (დაუდასტურებელი)' });
      }
    }
    return out;
  }
  /** ABG: ლაბ. (ერთი სინჯი = ერთი შეკვეთა) + POC; FiO₂ — ABG-დან ან იმ მომენტის ვენტილაციის პარამეტრებიდან / ოთახის ჰაერი */
  async abgList(patientId: string, encounterId: string, from: Date, to: Date, s: IcuSettings) {
    const L = await this.labValues(patientId, ['ph', 'pao2', 'paco2', 'hco3', 'be', 'lactate', 'sao2', 'fio2'], from, to, s);
    const byItem = new Map<string, Record<string, unknown>>();
    for (const [k, list] of Object.entries(L)) {
      for (const o of list) {
        const x = byItem.get(o.order_item_id) ?? { source: 'lab', id: o.order_item_id, sampled_at: o.at, validated: o.validated };
        x[k === 'pao2' ? 'po2' : k === 'paco2' ? 'pco2' : k] = o.value;
        byItem.set(o.order_item_id, x);
      }
    }
    const poc = await this.db.selectFrom('icu_abg as a').leftJoin('users as x', 'x.id', 'a.created_by')
      .selectAll('a').select(sql<string>`x.last_name || ' ' || left(x.first_name, 1) || '.'`.as('created_by_name'))
      .where('a.encounter_id', '=', encounterId).where('a.voided_at', 'is', null).where('a.sampled_at', '>=', from).where('a.sampled_at', '<', to).orderBy('a.sampled_at').execute();
    type Row = Record<string, unknown> & { source: string; sampled_at: unknown; po2?: number | null; pco2?: number | null; fio2?: number | null; pf?: number; fio2_source?: string };
    const list: Row[] = [...(byItem.values() as Iterable<Row>), ...poc.map((p) => ({ source: 'poc', id: p.id, sampled_at: p.sampled_at, sample: p.sample, ph: n(p.ph), po2: n(p.po2), pco2: n(p.pco2), hco3: n(p.hco3),
      be: n(p.be), lactate: n(p.lactate), sao2: n(p.sao2), fio2: n(p.fio2), na: n(p.na), k: n(p.k), glucose: n(p.glucose), note: p.note, created_by_name: p.created_by_name }))]
      .sort((a, b) => new Date(String(a.sampled_at)).getTime() - new Date(String(b.sampled_at)).getTime());
    for (const a of list) {
      if (a.fio2 === undefined || a.fio2 === null) {
        const f = await this.fio2At(encounterId, new Date(String(a.sampled_at)));
        a.fio2 = f.value; a.fio2_source = f.source;
      } else a.fio2_source = 'abg';
      if (typeof a.po2 === 'number' && typeof a.fio2 === 'number') a.pf = Math.round((a.po2 / a.fio2) * 100);
    }
    return list as (Record<string, unknown> & { sampled_at: string; po2?: number; pco2?: number; fio2: number | null; pf?: number; source: string })[];
  }
  /** FiO₂ მომენტში: ვენტილაციის ბოლო პარამეტრები (ღია ვენტილაცია) → ოთახის ჰაერი (ბოლო ვიტალებში ჟანგბადი „არა“) → უცნობი */
  async fio2At(encounterId: string, at: Date) {
    const v = await this.db.selectFrom('icu_vent_settings as s').innerJoin('icu_ventilation as v', 'v.id', 's.ventilation_id').select(['s.fio2'])
      .where('s.encounter_id', '=', encounterId).where('s.voided_at', 'is', null).where('v.voided_at', 'is', null).where('s.recorded_at', '<=', at)
      .where('v.started_at', '<=', at).where((eb) => eb.or([eb('v.ended_at', 'is', null), eb('v.ended_at', '>', at)])).where('s.fio2', 'is not', null)
      .orderBy('s.recorded_at', 'desc').limit(1).executeTakeFirst();
    if (v?.fio2) return { value: v.fio2, source: 'vent' };
    const vt = await this.db.selectFrom('encounter_vitals').select(['o2_supplement']).where('encounter_id', '=', encounterId).where('voided_at', 'is', null)
      .where('recorded_at', '<=', at).where('recorded_at', '>', new Date(at.getTime() - 6 * 3_600_000)).where('o2_supplement', 'is not', null)
      .orderBy('recorded_at', 'desc').limit(1).executeTakeFirst();
    if (vt && vt.o2_supplement === false) return { value: 21, source: 'room_air' };
    return { value: null, source: 'unknown' };
  }
  private async supportAt(encounterId: string, at: Date) {
    const r = await this.db.selectFrom('icu_ventilation').select('id').where('encounter_id', '=', encounterId).where('voided_at', 'is', null).where('kind', 'in', ['invasive', 'niv'])
      .where('started_at', '<=', at).where((eb) => eb.or([eb('ended_at', 'is', null), eb('ended_at', '>', at)])).executeTakeFirst();
    return !!r;
  }

  // ---------------------------------------------------------------- SOFA / APACHE II
  private async scoreInputs(c: Ctx, from: Date, to: Date, s: IcuSettings) {
    const vit = await this.db.selectFrom('encounter_vitals').select(['recorded_at', 'temperature', 'map_mmhg', 'systolic_bp', 'diastolic_bp', 'heart_rate', 'respiratory_rate', 'gcs_total'])
      .where('encounter_id', '=', c.encounter_id).where('voided_at', 'is', null).where('recorded_at', '>=', from).where('recorded_at', '<', to).execute();
    const at = (x: { recorded_at: unknown }) => String(x.recorded_at);
    const mapOf = (v: (typeof vit)[number]) => v.map_mmhg ?? (v.systolic_bp && v.diastolic_bp ? Math.round((v.systolic_bp + 2 * v.diastolic_bp) / 3) : null);
    const gcsScales = await this.db.selectFrom('scale_assessments').select(['score', 'assessed_at']).where('encounter_id', '=', c.encounter_id).where('scale_code', '=', 'gcs')
      .where('voided_at', 'is', null).where('assessed_at', '>=', from).where('assessed_at', '<', to).execute();
    const gcs: Obs[] = [...vit.filter((v) => v.gcs_total !== null).map((v) => ({ value: v.gcs_total!, at: at(v), detail: 'ფურცელი' })),
      ...gcsScales.map((g) => ({ value: g.score, at: String(g.assessed_at), detail: 'შკალა' }))];
    const L = await this.labValues(c.patient_id, ['platelets', 'bilirubin', 'creatinine', 'sodium', 'potassium', 'hct', 'wbc', 'ph', 'hco3'], from, to, s);
    const abg = await this.abgList(c.patient_id, c.encounter_id, from, to, s);
    const poc = (k: string) => abg.filter((a) => a.source === 'poc' && typeof a[k] === 'number').map((a) => ({ value: a[k] as number, at: a.sampled_at, detail: 'POC' }));
    return { vit, at, mapOf, gcs, L, abg, poc };
  }
  /** ვაზოპრესორები ფანჯარაში: მაქს. დოზა მკგ/კგ/წთ (vasoactive სახელების სიით) */
  private async vasoMax(c: Ctx, from: Date, to: Date, s: IcuSettings) {
    const inf = await this.infusionsFor(c.encounter_id, from, to, c);
    const names = s.vasoactive ?? {};
    const res = { dopamine: 0, dobutamine: 0, epinephrine: 0, norepinephrine: 0 };
    const unknown: string[] = []; const used: string[] = [];
    for (const o of inf) {
      const title = `${o.inn ?? ''} ${o.title ?? ''}`.toLowerCase();
      const kind = (Object.keys(res) as (keyof typeof res)[]).find((k) => (names[k] ?? []).some((x) => title.includes(x.toLowerCase())));
      if (!kind) continue;
      // ფანჯრის დასაწყისის მდგომარეობა + ყველა მოქმედება ფანჯარაში (ხანმოკლე ტიტრაციაც ითვლება)
      const points = [{ rate: o.hours[0]?.rate_ml_h ?? 0, dose: o.hours[0]?.dose_rate ?? null },
        ...o.events.filter((e) => ['start', 'rate', 'bag'].includes(e.infusion_action ?? '')).map((e) => ({ rate: n(e.rate_ml_h) ?? 0, dose: e.dose }))];
      const running = points.filter((h) => h.rate > 0);
      if (!running.length) continue;
      const doses = running.map((h) => (h.dose !== null && o.unit ? toMcgKgMin(h.dose, o.unit, o.weight_used) : null));
      if (doses.some((d) => d === null)) { unknown.push(o.title); continue; }
      const mx = Math.max(...(doses as number[]));
      if (mx > res[kind]) res[kind] = mx;
      used.push(`${o.title} ${mx} მკგ/კგ/წთ`);
    }
    const any = Object.values(res).some((v) => v > 0);
    return { vaso: any ? { ...res, detail: used.join('; ') } : null, unknown };
  }
  async scoreDraft(encounterId: string, kind: 'sofa' | 'apache2', windowTo: string | undefined, dto: Partial<ScoreDto> = {}) {
    const s = await this.settings();
    const c = await this.ctx(encounterId);
    if (!c.episode) throw new ConflictException({ code: 'ICU_NO_EPISODE', message: 'პაციენტი რეანიმაციაში / ინტენსიურში არ იმყოფება' });
    const feature: IcuFeature = kind === 'sofa' ? 'sofa' : 'apache';
    if (!c.features.includes(feature)) throw new ForbiddenException({ code: 'ICU_FEATURE_OFF', message: `ამ განყოფილებაში გამორთულია: ${FEATURE_KA[feature]}` });
    const epStart = new Date(c.episode.started_at);
    let from: Date; let to: Date;
    if (kind === 'sofa') { to = windowTo ? new Date(windowTo) : new Date(); if (to.getTime() > Date.now() + 60_000) to = new Date(); from = new Date(to.getTime() - 24 * 3_600_000); }
    else { from = epStart; to = new Date(Math.min(Date.now(), epStart.getTime() + 24 * 3_600_000)); }
    const incomplete = kind === 'apache2' && to.getTime() < epStart.getTime() + 24 * 3_600_000 - 60_000;
    const I = await this.scoreInputs(c, from, to, s);
    const ov = (dto.overrides ?? {}) as Record<string, number | null>;
    if (kind === 'sofa') {
      const pf = [];
      for (const a of I.abg) if (typeof a.pf === 'number') pf.push({ value: a.pf, support: await this.supportAt(encounterId, new Date(a.sampled_at)), at: a.sampled_at,
        detail: `pO₂ ${a.po2} / FiO₂ ${a.fio2}% (${a.fio2_source === 'abg' ? 'ABG' : a.fio2_source === 'vent' ? 'ვენტილატორი' : 'ოთახის ჰაერი'})` });
      const urine = await sql<{ ml: string | null; n: number }>`SELECT sum(volume_ml) AS ml, count(*)::int AS n FROM fluid_entries
        WHERE encounter_id = ${encounterId} AND voided_at IS NULL AND category = 'urine' AND recorded_at > ${from} AND recorded_at <= ${to}`.execute(this.db);
      const v = await this.vasoMax(c, from, to, s);
      const r = sofa({
        pf, platelets: I.L.platelets, bilirubin: I.L.bilirubin, creatinine: I.L.creatinine, gcs: I.gcs,
        map: I.vit.map((x) => ({ value: I.mapOf(x), at: I.at(x) })).filter((x): x is { value: number; at: string } => x.value !== null),
        vaso: v.vaso, vaso_unknown: v.unknown, urine_24h: urine.rows[0].n ? Number(urine.rows[0].ml) : null,
      }, { ...(ov as SofaOverrides), resp_support: dto.resp_support });
      return { kind, window_from: from, window_to: to, incomplete: false, ...r, predicted_mortality: null };
    }
    const a = dto.apache ?? {};
    const cat = a.category ? await this.db.selectFrom('icu_apache_categories').selectAll().where('code', '=', a.category).where('is_active', '=', true).executeTakeFirst() : null;
    if (a.category && !cat) throw new BadRequestException('დიაგნოსტიკური კატეგორია ვერ მოიძებნა');
    const oxy = I.abg.filter((x) => typeof x.po2 === 'number').map((x) => ({ pao2: x.po2!, paco2: typeof x.pco2 === 'number' ? x.pco2 : null, fio2: x.fio2, at: x.sampled_at }));
    const r = apache2({
      temp: I.vit.filter((x) => x.temperature !== null).map((x) => ({ value: Number(x.temperature), at: I.at(x) })),
      map: I.vit.map((x) => ({ value: I.mapOf(x), at: I.at(x) })).filter((x): x is { value: number; at: string } => x.value !== null),
      hr: I.vit.filter((x) => x.heart_rate !== null).map((x) => ({ value: x.heart_rate!, at: I.at(x) })),
      rr: I.vit.filter((x) => x.respiratory_rate !== null).map((x) => ({ value: x.respiratory_rate!, at: I.at(x) })),
      oxy, ph: [...I.L.ph, ...I.poc('ph')], hco3: [...I.L.hco3, ...I.poc('hco3')], na: [...I.L.sodium, ...I.poc('na')], k: [...I.L.potassium, ...I.poc('k')],
      creatinine: I.L.creatinine, hct: I.L.hct, wbc: I.L.wbc, gcs: I.gcs, age: c.age,
    }, { chronic_health: a.chronic_health, admission_type: a.admission_type ?? (cat?.operative ? (a.emergency_surgery ? 'emergency_postop' : 'elective_postop') : 'nonoperative'),
      arf: a.arf, category_weight: cat ? Number(cat.weight) : null, emergency_surgery: a.emergency_surgery }, ov as ApacheOverrides);
    return { kind, window_from: from, window_to: to, incomplete, ...r };
  }
  async confirmScore(encounterId: string, dto: ScoreDto, u: AuthUser, ctx: AuditContext) {
    const draft = await this.scoreDraft(encounterId, dto.kind, dto.window_to, dto);
    if (draft.missing.length && !dto.accept_missing) {
      throw new ConflictException({ code: 'SCORE_MISSING', message: `დაუდგენელი კომპონენტები: ${draft.components.filter((x) => x.points === null).map((x) => x.label).join(', ')} — შეავსეთ ხელით ან დაადასტურეთ ასე (ნორმად არ ჩაითვლება)`,
        missing: draft.missing });
    }
    if (dto.kind === 'apache2' && draft.incomplete && !dto.accept_missing) {
      throw new ConflictException({ code: 'SCORE_INCOMPLETE', message: 'APACHE II: პირველი 24 სთ ჯერ არ გასულა — დაადასტურეთ ახლანდელი მონაცემებით ან მოიცადეთ', missing: [] });
    }
    try {
      return await this.db.transaction().execute(async (trx) => {
        const c = await this.writable(encounterId, u, dto.kind === 'sofa' ? 'sofa' : 'apache', trx, true);
        const day = (await sql<{ d: string }>`SELECT to_char(${draft.window_to}::timestamptz AT TIME ZONE ${TZ}, 'YYYY-MM-DD') AS d`.execute(trx)).rows[0].d;
        const comps = Object.fromEntries(draft.components.map((x) => [x.key, x]));
        const r = await trx.insertInto('icu_scores').values({ encounter_id: encounterId, patient_id: c.patient_id, episode_id: c.episode!.id, kind: dto.kind,
          window_from: draft.window_from, window_to: draft.window_to, score_date: day, components: JSON.stringify(comps), total: draft.total, missing: draft.missing,
          apache_category: dto.kind === 'apache2' ? dto.apache?.category ?? null : null, emergency_surgery: dto.kind === 'apache2' ? dto.apache?.emergency_surgery ?? null : null,
          predicted_mortality: draft.predicted_mortality !== null ? String(draft.predicted_mortality) : null, note: dto.note?.trim() || null, confirmed_by: u.id })
          .returningAll().executeTakeFirstOrThrow();
        await this.ipd.event(trx, { encounter_id: encounterId, kind: 'icu_score', data: { id: r.id, kind: dto.kind, total: draft.total, missing: draft.missing } }, u);
        await this.audit.log(ctx, { action: 'ICU_SCORE', entityName: 'icu_scores', entityId: r.id, newData: { ...dto, total: draft.total, missing: draft.missing } }, trx);
        return r;
      });
    } catch (e) {
      mapPgError(e, { ux_icu_sofa_day: 'ამ დღის SOFA უკვე დადასტურებულია (საჭიროებისას — გააუქმეთ და თავიდან)', ux_icu_apache_episode: 'ამ ეპიზოდის APACHE II უკვე დადასტურებულია' });
    }
  }

  // ---------------------------------------------------------------- bundle-ები
  bundleItems(all = false) {
    let q = this.db.selectFrom('icu_bundle_items').selectAll().orderBy('bundle').orderBy('sort_order').orderBy('created_at');
    if (!all) q = q.where('is_active', '=', true);
    return q.execute();
  }
  async saveBundleItem(id: string | null, dto: BundleItemDto, ctx: AuditContext) {
    if (!id && (!dto.bundle || !dto.label)) throw new BadRequestException('bundle და პუნქტი სავალდებულოა');
    return this.db.transaction().execute(async (trx) => {
      const r = id
        ? await trx.updateTable('icu_bundle_items').set({ ...(dto.label !== undefined && { label: dto.label.trim() }), ...(dto.sort_order !== undefined && { sort_order: dto.sort_order }),
            ...(dto.is_active !== undefined && { is_active: dto.is_active }), ...(dto.bundle !== undefined && { bundle: dto.bundle }) }).where('id', '=', id).returningAll().executeTakeFirst()
        : await trx.insertInto('icu_bundle_items').values({ bundle: dto.bundle!, label: dto.label!.trim(), sort_order: dto.sort_order ?? 100 }).returningAll().executeTakeFirst();
      if (!r) throw new NotFoundException('პუნქტი ვერ მოიძებნა');
      await this.audit.log(ctx, { action: id ? 'ICU_BUNDLE_ITEM_UPDATE' : 'ICU_BUNDLE_ITEM_CREATE', entityName: 'icu_bundle_items', entityId: r.id, newData: dto }, trx);
      return r;
    });
  }
  /** რომელი bundle ეხება ახლა: VAP — ინვაზიური ვენტილაცია; CLABSI — ცენტრალური ვენა (cvc / picc) */
  async bundlesApplicable(encounterId: string, ex: Ex = this.db) {
    const vap = await ex.selectFrom('icu_ventilation').select('id').where('encounter_id', '=', encounterId).where('kind', '=', 'invasive').where('ended_at', 'is', null)
      .where('voided_at', 'is', null).executeTakeFirst();
    const cl = await ex.selectFrom('lines_drains').select('id').where('encounter_id', '=', encounterId).where('kind', 'in', ['cvc', 'picc']).where('removed_at', 'is', null)
      .where('voided_at', 'is', null).executeTakeFirst();
    return { vap: !!vap, clabsi: !!cl };
  }
  async checkBundle(encounterId: string, dto: BundleDto, u: AuthUser, ctx: AuditContext) {
    const items = (await this.bundleItems()).filter((i) => i.bundle === dto.bundle);
    if (!items.length) throw new BadRequestException('ამ bundle-ს პუნქტები არ აქვს (ადმინისტრირება)');
    const answers = items.map((i) => {
      const a = dto.answers[i.id];
      if (!['yes', 'no', 'na'].includes(a)) throw new BadRequestException(`უპასუხეთ: ${i.label}`);
      return { item_id: i.id, label: i.label, answer: a };
    });
    const extra = Object.keys(dto.answers).filter((k) => !items.some((i) => i.id === k));
    if (extra.length) throw new BadRequestException('უცნობი პუნქტი');
    const compliant = answers.every((a) => a.answer !== 'no');
    if (!compliant && (dto.note?.trim().length ?? 0) < 3) throw new BadRequestException('„არა“ პასუხზე — მიუთითეთ შენიშვნა (რა და რატომ)');
    try {
      return await this.db.transaction().execute(async (trx) => {
        const c = await this.writable(encounterId, u, 'bundles', trx);
        const r = await trx.insertInto('icu_bundle_checks').values({ encounter_id: encounterId, patient_id: c.patient_id, bundle: dto.bundle, check_date: await this.today(trx),
          answers: JSON.stringify(answers), compliant, note: dto.note?.trim() || null, checked_by: u.id }).returningAll().executeTakeFirstOrThrow();
        await this.audit.log(ctx, { action: 'ICU_BUNDLE', entityName: 'icu_bundle_checks', entityId: r.id, newData: dto }, trx);
        return r;
      });
    } catch (e) { mapPgError(e, { ux_bundle_day: 'დღევანდელი შემოწმება უკვე ჩაწერილია (საჭიროებისას — გააუქმეთ და თავიდან)' }); }
  }

  // ---------------------------------------------------------------- გაუქმება
  private static readonly VOIDABLE = {
    ventilation: { table: 'icu_ventilation', by: 'created_by', at: 'created_at' }, vent_settings: { table: 'icu_vent_settings', by: 'recorded_by', at: 'created_at' },
    abg: { table: 'icu_abg', by: 'created_by', at: 'created_at' }, score: { table: 'icu_scores', by: 'confirmed_by', at: 'confirmed_at' },
    bundle: { table: 'icu_bundle_checks', by: 'checked_by', at: 'checked_at' },
  } as const;
  async void(kind: keyof typeof IcuService.VOIDABLE, id: string, reason: string, u: AuthUser, ctx: AuditContext) {
    const { table, by, at } = IcuService.VOIDABLE[kind];
    return this.db.transaction().execute(async (trx) => {
      const row = (await sql<{ encounter_id: string; voided_at: string | null; author: string | null; created_at: string }>`
        SELECT encounter_id, voided_at, ${sql.ref(by)} AS author, ${sql.ref(at)} AS created_at FROM ${sql.table(table)} WHERE id = ${id} FOR UPDATE`.execute(trx)).rows[0];
      if (!row || row.voided_at) throw new NotFoundException('ჩანაწერი ვერ მოიძებნა');
      const c = await this.ctx(row.encounter_id, trx);
      const own = row.author === u.id;
      if (!has(u, 'admin') && !(own || (await this.canWrite(u, c.department_id, trx) && (await this.ipd.me(u, trx)).is_section_head))) {
        throw new ForbiddenException('აუქმებს ავტორი, განყოფილების ხელმძღვანელი ან admin');
      }
      if (!has(u, 'admin') && Date.now() - new Date(row.created_at).getTime() > 24 * 3_600_000) throw new ConflictException('24 სთ-ზე ძველი ჩანაწერი — მიმართეთ admin-ს');
      if (kind === 'ventilation') {
        const s = await trx.selectFrom('icu_vent_settings').select(sql<number>`count(*)::int`.as('n')).where('ventilation_id', '=', id).where('voided_at', 'is', null).executeTakeFirstOrThrow();
        if (s.n) await trx.updateTable('icu_vent_settings').set({ voided_at: sql`now()`, voided_by: u.id, void_reason: `ვენტილაცია გაუქმდა: ${reason.trim()}` })
          .where('ventilation_id', '=', id).where('voided_at', 'is', null).execute();
      }
      await sql`UPDATE ${sql.table(table)} SET voided_at = now(), voided_by = ${u.id}, void_reason = ${reason.trim()} WHERE id = ${id}`.execute(trx);
      await this.audit.log(ctx, { action: `ICU_${kind.toUpperCase()}_VOID`, entityName: table, entityId: id, newData: { reason } }, trx);
      return { id, voided: true };
    });
  }

  // ---------------------------------------------------------------- პაციენტის ICU ხედი
  async stayIcu(encounterId: string, u: AuthUser) {
    const s = await this.settings();
    const c = await this.ctx(encounterId);
    const episodes = await this.db.selectFrom('icu_episodes as e').innerJoin('departments as d', 'd.id', 'e.department_id').leftJoin('departments as fd', 'fd.id', 'e.from_department_id')
      .leftJoin('departments as xd', 'xd.id', 'e.exit_department_id')
      .selectAll('e').select(['d.name as department_name', 'fd.name as from_department_name', 'xd.name as exit_department_name',
        sql<number>`round(extract(epoch FROM coalesce(e.ended_at, now()) - e.started_at) / 3600.0, 1)::float`.as('hours')])
      .where('e.encounter_id', '=', encounterId).orderBy('e.started_at', 'desc').execute();
    if (!episodes.length) return { episode: null, episodes: [], features: c.features, care_level: c.care_level };
    const vent = await this.db.selectFrom('icu_ventilation as v').leftJoin('users as p', 'p.id', 'v.performed_by').leftJoin('users as x', 'x.id', 'v.created_by')
      .leftJoin('users as e', 'e.id', 'v.ended_by')
      .selectAll('v').select([sql<string | null>`p.last_name || ' ' || p.first_name`.as('performed_by_name'), sql<string>`x.last_name || ' ' || x.first_name`.as('created_by_name'),
        sql<string | null>`e.last_name || ' ' || e.first_name`.as('ended_by_name'),
        sql<number>`round(extract(epoch FROM coalesce(v.ended_at, now()) - v.started_at) / 86400.0, 1)::float`.as('days')])
      .where('v.encounter_id', '=', encounterId).orderBy('v.started_at', 'desc').execute();
    const lastSettings = await this.db.selectFrom('icu_vent_settings').selectAll().where('encounter_id', '=', encounterId).where('voided_at', 'is', null)
      .orderBy('recorded_at', 'desc').limit(1).executeTakeFirst();
    const scores = await this.db.selectFrom('icu_scores as s').leftJoin('users as x', 'x.id', 's.confirmed_by').leftJoin('icu_apache_categories as k', 'k.code', 's.apache_category')
      .selectAll('s').select([sql<string>`x.last_name || ' ' || x.first_name`.as('confirmed_by_name'), sql<string>`to_char(s.score_date, 'YYYY-MM-DD')`.as('day'), 'k.name as category_name'])
      .where('s.encounter_id', '=', encounterId).orderBy('s.window_to', 'desc').limit(60).execute();
    const today = await this.today();
    const bundles = await this.db.selectFrom('icu_bundle_checks as b').leftJoin('users as x', 'x.id', 'b.checked_by')
      .selectAll('b').select([sql<string>`x.last_name || ' ' || x.first_name`.as('checked_by_name'), sql<string>`to_char(b.check_date, 'YYYY-MM-DD')`.as('day')])
      .where('b.encounter_id', '=', encounterId).orderBy('b.check_date', 'desc').orderBy('b.checked_at', 'desc').limit(60).execute();
    const applicable = await this.bundlesApplicable(encounterId);
    const now = new Date();
    const vasoactive = c.episode ? (await this.infusionsFor(encounterId, new Date(now.getTime() - 3_600_000), new Date(now.getTime() + 1), c))
      .filter((o) => o.status === 'active' || o.current_rate_ml_h > 0).map(({ hours: _h, ...o }) => o) : [];
    const abg = await this.abgList(c.patient_id, encounterId, new Date(Date.now() - 72 * 3_600_000), new Date(Date.now() + 60_000), s);
    const writable = c.status === 'active' && !!c.episode && await this.canWrite(u, c.department_id);
    const doctors = c.episode ? await this.db.selectFrom('users as x').innerJoin('user_capabilities as k', 'k.user_id', 'x.id').select(['x.id', sql<string>`x.last_name || ' ' || x.first_name`.as('name')])
      .distinct().where('x.is_active', '=', true).where(sql<boolean>`'doctor' = ANY(k.capabilities)`).where('x.department_id', '=', c.department_id).orderBy('name').execute() : [];
    return {
      episode: episodes.find((e) => !e.ended_at) ?? null, episodes, features: c.features, care_level: c.care_level, department_id: c.department_id,
      weight: await this.weight(c), interval_min: this.intervalAt(s, c, now), default_interval: c.dep_interval ?? s.monitor_interval_min, fast_max_hours: s.fast_interval_max_hours,
      ventilation: vent, current_vent: vent.find((v) => !v.ended_at && !v.voided_at) ?? null, last_settings: lastSettings ?? null,
      vent_days: (await sql<{ n: number }>`SELECT count(*)::int AS n FROM stay_vent_days WHERE encounter_id = ${encounterId}`.execute(this.db)).rows[0].n,
      vasoactive, scores, bundles, bundle_items: await this.bundleItems(), applicable, today,
      bundle_due: { vap: applicable.vap && !bundles.some((b) => b.bundle === 'vap' && b.day === today && !b.voided_at), clabsi: applicable.clabsi && !bundles.some((b) => b.bundle === 'clabsi' && b.day === today && !b.voided_at) },
      sofa_today: scores.some((x) => x.kind === 'sofa' && x.day === today && !x.voided_at), apache_done: !!c.episode && scores.some((x) => x.kind === 'apache2' && x.episode_id === c.episode!.id && !x.voided_at),
      abg, can_write: writable, can_doctor: writable && has(u, 'doctor', 'admin'), vent_modes: VENT_MODES, doctors,
      apache_categories: await this.db.selectFrom('icu_apache_categories').selectAll().where('is_active', '=', true).orderBy('sort_order').execute(),
    };
  }

  // ---------------------------------------------------------------- ჩანაწერში ჩასასმელი (A–F)
  async insertData(encounterId: string) {
    const s = await this.settings();
    const c = await this.ctx(encounterId);
    const now = new Date(); const from = new Date(now.getTime() - 24 * 3_600_000);
    const fmt = (x: unknown) => new Intl.DateTimeFormat('ka-GE', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(String(x)));
    const v = await this.db.selectFrom('encounter_vitals').selectAll().where('encounter_id', '=', encounterId).where('voided_at', 'is', null).orderBy('recorded_at', 'desc').limit(1).executeTakeFirst();
    const vent = await this.db.selectFrom('icu_ventilation').selectAll().where('encounter_id', '=', encounterId).where('voided_at', 'is', null).where('ended_at', 'is', null).executeTakeFirst();
    const vs = vent ? await this.db.selectFrom('icu_vent_settings').selectAll().where('ventilation_id', '=', vent.id).where('voided_at', 'is', null).orderBy('recorded_at', 'desc').limit(1).executeTakeFirst() : null;
    const inf = c.episode ? (await this.infusionsFor(encounterId, from, new Date(now.getTime() + 1), c)).filter((o) => o.current_rate_ml_h > 0) : [];
    const bal = (await sql<{ i: string; o: string; u: string }>`SELECT coalesce(sum(volume_ml) FILTER (WHERE direction = 'in'), 0) AS i, coalesce(sum(volume_ml) FILTER (WHERE direction = 'out'), 0) AS o,
      coalesce(sum(volume_ml) FILTER (WHERE category = 'urine'), 0) AS u FROM fluid_entries WHERE encounter_id = ${encounterId} AND voided_at IS NULL AND recorded_at > ${from}`.execute(this.db)).rows[0];
    const sofaRow = await this.db.selectFrom('icu_scores').select(['total', 'missing', 'window_to']).where('encounter_id', '=', encounterId).where('kind', '=', 'sofa').where('voided_at', 'is', null)
      .orderBy('window_to', 'desc').limit(2).execute();
    const lines = await this.db.selectFrom('lines_drains').select(['kind', 'site', 'inserted_at']).where('encounter_id', '=', encounterId).where('removed_at', 'is', null).where('voided_at', 'is', null).execute();
    const abg = (await this.abgList(c.patient_id, encounterId, from, new Date(now.getTime() + 1), s)).pop();
    const LK: Record<string, string> = { pvc: 'პერიფ. ვენა', cvc: 'ცენტრ. ვენა', picc: 'PICC', arterial: 'არტერიული', urinary: 'შარდის კათეტერი', ng_tube: 'NG ზონდი', drain: 'დრენაჟი', trach: 'ტრაქეოსტომა', other: 'სხვა' };
    const a = vent ? `${vent.airway === 'trach' ? 'ტრაქეოსტომა' : vent.airway === 'ett' ? `ენდოტრაქეული მილი${vent.ett_size ? ` №${Number(vent.ett_size)}` : ''}${vent.ett_depth_cm ? `, ${Number(vent.ett_depth_cm)} სმ` : ''}` : 'თავისუფალი (NIV / HFNC)'}` : 'თავისუფალი';
    const b = [vent ? `${VENT_KA[vent.kind]} ${fmt(vent.started_at)}-დან${vs ? ` · ${vs.mode}${vs.fio2 ? `, FiO₂ ${vs.fio2}%` : ''}${vs.peep ? `, PEEP ${Number(vs.peep)}` : ''}${vs.vt_ml ? `, Vt ${vs.vt_ml}` : ''}${vs.rate_set ? `, f ${vs.rate_set}` : ''}${vs.ppeak ? `, Ppeak ${vs.ppeak}` : ''}` : ''}` : 'სპონტანური სუნთქვა',
      v?.spo2 ? `SpO₂ ${v.spo2}%` : '', v?.respiratory_rate ? `სუნთქვა ${v.respiratory_rate}/წთ` : '', v?.etco2 ? `EtCO₂ ${v.etco2}` : '',
      abg ? `ABG (${fmt(abg.sampled_at)}): ${[abg.ph && `pH ${abg.ph}`, abg.pco2 && `pCO₂ ${abg.pco2}`, abg.po2 && `pO₂ ${abg.po2}`, abg.pf && `P/F ${abg.pf}`, abg.lactate && `ლაქტატი ${abg.lactate}`].filter(Boolean).join(', ')}` : ''].filter(Boolean).join('; ');
    const cc = [v ? [v.systolic_bp && `წნევა ${v.systolic_bp}/${v.diastolic_bp ?? '–'}`, v.map_mmhg && `MAP ${v.map_mmhg}${v.map_invasive ? ' (ინვაზ.)' : ''}`, v.heart_rate && `პულსი ${v.heart_rate}`, v.cvp !== null && `CVP ${v.cvp}`].filter(Boolean).join(', ') : '',
      inf.length ? `ინფუზიები: ${inf.map((o) => `${o.title} ${o.current_dose_rate !== null && o.unit ? `${o.current_dose_rate} ${o.unit}` : ''} (${o.current_rate_ml_h} მლ/სთ)`.replace(/\s+/g, ' ')).join('; ')}` : 'ვაზოპრესორები არ არის'].filter(Boolean).join('; ');
    const d = [v?.gcs_total ? `GCS ${v.gcs_total} (E${v.gcs_e}V${v.gcs_intubated ? 'T' : v.gcs_v}M${v.gcs_m})` : '', v?.rass !== null && v?.rass !== undefined ? `RASS ${v.rass}` : '',
      v?.pupil_l ? `გუგები ${Number(v.pupil_l)}/${Number(v.pupil_r ?? 0)} მმ` : ''].filter(Boolean).join('; ');
    const e = [v?.temperature ? `ტ° ${Number(v.temperature)}` : '', lines.length ? `ხაზები: ${lines.map((l) => `${LK[l.kind] ?? l.kind}${l.site ? ` (${l.site})` : ''}, ${Math.floor((Date.now() - new Date(l.inserted_at).getTime()) / 86_400_000)} დღე`).join('; ')}` : ''].filter(Boolean).join('; ');
    const f = `ბალანსი 24 სთ: მიღება ${Math.round(Number(bal.i))} მლ, გამოყოფა ${Math.round(Number(bal.o))} მლ (${Number(bal.i) - Number(bal.o) >= 0 ? '+' : ''}${Math.round(Number(bal.i) - Number(bal.o))}); შარდი ${Math.round(Number(bal.u))} მლ`;
    const sofaTxt = sofaRow[0] ? `SOFA ${sofaRow[0].total}${sofaRow[1] ? ` (წინა ${sofaRow[1].total})` : ''}${sofaRow[0].missing.length ? ` — დაუდგენელი: ${sofaRow[0].missing.join(', ')}` : ''}` : '';
    return { a_airway: a, b_breathing: b, c_circulation: cc, d_disability: d, e_exposure: e, f_fluids: f, assessment: sofaTxt };
  }

  // ---------------------------------------------------------------- დაფა / განყოფილებები / სტატისტიკა
  async departments() {
    const s = await this.settings();
    const deps = await this.db.selectFrom('departments as d').select(['d.id', 'd.name', 'd.care_level', 'd.icu_features', 'd.monitor_interval_min',
      sql<number>`(SELECT count(*)::int FROM icu_episodes e WHERE e.department_id = d.id AND e.ended_at IS NULL)`.as('patients')])
      .where('d.is_active', '=', true).where('d.care_level', 'in', ['icu', 'intensive']).orderBy('d.name').execute();
    return deps.map((d) => ({ ...d, features: this.featuresFor(s, d.care_level, d.icu_features) }));
  }
  async board(departmentId: string, u: AuthUser) {
    const s = await this.settings();
    const dep = await this.db.selectFrom('departments').select(['id', 'name', 'care_level', 'icu_features', 'monitor_interval_min']).where('id', '=', departmentId).executeTakeFirst();
    if (!dep || dep.care_level === 'ward') throw new NotFoundException('რეანიმაციის / ინტენსიური განყოფილება ვერ მოიძებნა');
    const features = this.featuresFor(s, dep.care_level, dep.icu_features);
    const today = await this.today();
    const pts = await this.db.selectFrom('icu_episodes as ep').innerJoin('inpatient_stays as st', 'st.encounter_id', 'ep.encounter_id').innerJoin('patients as p', 'p.id', 'st.patient_id')
      .innerJoin('bed_assignments as a', (j) => j.onRef('a.encounter_id', '=', 'ep.encounter_id').on('a.ended_at', 'is', null)).leftJoin('beds as b', 'b.id', 'a.bed_id')
      .innerJoin('encounters as e', 'e.id', 'st.encounter_id').leftJoin('users as d', 'd.id', 'e.attending_doctor_id')
      .select(['ep.id as episode_id', 'ep.encounter_id', 'ep.started_at', 'ep.origin', 'ep.readmission', 'ep.admission_weight_kg', 'ep.monitor_interval_min', 'ep.monitor_interval_from',
        'ep.monitor_interval_until', 'st.adm_no', 'st.severity', 'st.isolation', 'p.id as patient_id', 'p.first_name', 'p.last_name', 'p.gender',
        sql<number>`extract(year FROM age(p.birth_date))::int`.as('age'), 'b.code as bed_code', sql<string | null>`d.last_name || ' ' || left(d.first_name, 1) || '.'`.as('doctor_name'),
        sql<string | null>`(SELECT x.icd10_code || ' ' || x.icd10_title FROM encounter_diagnoses x WHERE x.encounter_id = e.id ORDER BY (x.diagnosis_type = 'primary') DESC, (x.diagnosis_type = 'admission') DESC, x.created_at LIMIT 1)`.as('diagnosis'),
        sql<number>`(SELECT count(*)::int FROM patient_allergies al WHERE al.patient_id = p.id AND al.is_active)`.as('allergies')])
      .where('ep.department_id', '=', departmentId).where('ep.ended_at', 'is', null).where('st.status', '=', 'active').orderBy('b.code').orderBy('p.last_name').execute();
    const out = [];
    for (const p of pts) {
      const c = { episode: { monitor_interval_min: p.monitor_interval_min, monitor_interval_from: p.monitor_interval_from ? String(p.monitor_interval_from) : null,
        monitor_interval_until: p.monitor_interval_until ? String(p.monitor_interval_until) : null, admission_weight_kg: p.admission_weight_kg, id: p.episode_id, started_at: String(p.started_at),
        department_id: departmentId }, dep_interval: dep.monitor_interval_min, patient_id: p.patient_id };
      // ბოლო მნიშვნელობა თითო პარამეტრზე (ბოლო 6 სთ; ჩანაწერები ხშირად ნაწილობრივია)
      const vr = await this.db.selectFrom('encounter_vitals').selectAll().where('encounter_id', '=', p.encounter_id).where('voided_at', 'is', null)
        .where('recorded_at', '>', sql<Date>`now() - interval '6 hours'`).orderBy('recorded_at', 'desc').limit(24).execute();
      const pick = <K extends keyof (typeof vr)[number]>(k: K) => vr.find((x) => x[k] !== null && x[k] !== undefined)?.[k] ?? null;
      const mapRow = vr.find((x) => x.map_mmhg !== null || (x.systolic_bp !== null && x.diastolic_bp !== null));
      const v = vr[0] ? { recorded_at: vr[0].recorded_at, heart_rate: pick('heart_rate'), systolic_bp: mapRow?.systolic_bp ?? pick('systolic_bp'), diastolic_bp: mapRow?.diastolic_bp ?? null,
        map_mmhg: mapRow ? mapRow.map_mmhg ?? Math.round((mapRow.systolic_bp! + 2 * mapRow.diastolic_bp!) / 3) : null, spo2: pick('spo2'), respiratory_rate: pick('respiratory_rate'),
        temperature: pick('temperature'), cvp: pick('cvp'), gcs_total: pick('gcs_total'), rass: pick('rass') } : null;
      const lastSheet = await this.db.selectFrom('encounter_vitals').select('recorded_at').where('encounter_id', '=', p.encounter_id).where('voided_at', 'is', null).where('icu_sheet', '=', true)
        .orderBy('recorded_at', 'desc').limit(1).executeTakeFirst();
      const vent = await this.db.selectFrom('icu_ventilation').selectAll().where('encounter_id', '=', p.encounter_id).where('voided_at', 'is', null).where('ended_at', 'is', null).executeTakeFirst();
      const vs = vent ? await this.db.selectFrom('icu_vent_settings').selectAll().where('ventilation_id', '=', vent.id).where('voided_at', 'is', null).orderBy('recorded_at', 'desc').limit(1).executeTakeFirst() : null;
      const inf = (await this.infusionsFor(p.encounter_id, new Date(Date.now() - 3_600_000), new Date(Date.now() + 1), c)).filter((o) => o.current_rate_ml_h > 0)
        .map((o) => ({ id: o.id, title: o.title, titratable: o.titratable, rate_ml_h: o.current_rate_ml_h, dose_rate: o.current_dose_rate, unit: o.unit }));
      const sf = await this.db.selectFrom('icu_scores').select(['total', 'missing', sql<string>`to_char(score_date, 'YYYY-MM-DD')`.as('day')]).where('encounter_id', '=', p.encounter_id)
        .where('kind', '=', 'sofa').where('voided_at', 'is', null).orderBy('window_to', 'desc').limit(2).execute();
      const ds = await this.dayStart();
      const bal = (await sql<{ i: string; o: string; hi: string; ho: string }>`SELECT
          coalesce(sum(volume_ml) FILTER (WHERE direction = 'in'), 0) AS i, coalesce(sum(volume_ml) FILTER (WHERE direction = 'out'), 0) AS o,
          coalesce(sum(volume_ml) FILTER (WHERE direction = 'in' AND recorded_at > now() - interval '1 hour'), 0) AS hi,
          coalesce(sum(volume_ml) FILTER (WHERE direction = 'out' AND recorded_at > now() - interval '1 hour'), 0) AS ho
        FROM fluid_entries WHERE encounter_id = ${p.encounter_id} AND voided_at IS NULL
          AND recorded_at > (((now() AT TIME ZONE ${TZ}) - ${ds}::time)::date + ${ds}::time) AT TIME ZONE ${TZ}`.execute(this.db)).rows[0];
      const interval = this.intervalAt(s, c, new Date());
      const mapNow = v?.map_mmhg ?? null;
      const applicable = await this.bundlesApplicable(p.encounter_id);
      const bundlesToday = await this.db.selectFrom('icu_bundle_checks').select('bundle').where('encounter_id', '=', p.encounter_id).where('voided_at', 'is', null)
        .where('check_date', '=', today).execute();
      const alerts: { level: 'danger' | 'warn' | 'info'; text: string }[] = [];
      const sheetAge = lastSheet ? (Date.now() - new Date(lastSheet.recorded_at).getTime()) / 60_000 : (Date.now() - new Date(p.started_at).getTime()) / 60_000;
      if (features.includes('sheet') && sheetAge > interval + 15) alerts.push({ level: sheetAge > s.monitor_gap_hours * 60 ? 'danger' : 'warn', text: `ფურცელი: ბოლო ჩანაწერი ${lastSheet ? `${Math.round(sheetAge)} წთ-ის წინ` : 'არ არის'}` });
      if (!p.admission_weight_kg) alerts.push({ level: 'warn', text: 'წონა არ არის მითითებული' });
      if (mapNow !== null && mapNow < 65) alerts.push({ level: 'danger', text: `MAP ${mapNow}` });
      if (v?.spo2 && v.spo2 < 90) alerts.push({ level: 'danger', text: `SpO₂ ${v.spo2}%` });
      if (features.includes('bundles') && applicable.vap && !bundlesToday.some((b) => b.bundle === 'vap')) alerts.push({ level: 'info', text: 'VAP bundle — დღეს არ შემოწმებულა' });
      if (features.includes('bundles') && applicable.clabsi && !bundlesToday.some((b) => b.bundle === 'clabsi')) alerts.push({ level: 'info', text: 'CLABSI bundle — დღეს არ შემოწმებულა' });
      if (features.includes('sofa') && !sf.some((x) => x.day === today) && (Date.now() - new Date(p.started_at).getTime()) > 12 * 3_600_000) alerts.push({ level: 'info', text: 'SOFA — დღეს არ დადასტურებულა' });
      out.push({ ...p, interval_min: interval, vitals: v ? { recorded_at: v.recorded_at, hr: v.heart_rate, sbp: v.systolic_bp, dbp: v.diastolic_bp, map: mapNow, spo2: v.spo2, rr: v.respiratory_rate,
        temp: n(v.temperature), cvp: v.cvp, gcs: v.gcs_total, rass: v.rass } : null, last_sheet_at: lastSheet?.recorded_at ?? null,
        vent: vent ? { kind: vent.kind, airway: vent.airway, started_at: vent.started_at, days: r1((Date.now() - new Date(vent.started_at).getTime()) / 86_400_000),
          mode: vs?.mode ?? null, fio2: vs?.fio2 ?? null, peep: n(vs?.peep) } : null,
        infusions: inf, sofa: sf[0] ? { total: sf[0].total, day: sf[0].day, prev: sf[1]?.total ?? null, missing: sf[0].missing } : null,
        balance: { in: Math.round(Number(bal.i)), out: Math.round(Number(bal.o)), net: Math.round(Number(bal.i) - Number(bal.o)), hour_net: Math.round(Number(bal.hi) - Number(bal.ho)) },
        days: r1((Date.now() - new Date(p.started_at).getTime()) / 86_400_000), alerts });
    }
    return { department: { ...dep, features }, can_write: await this.canWrite(u, departmentId), patients: out };
  }
  async stats(q: StatsQuery) {
    const to = q.to ?? await this.today();
    const from = q.from ?? (await sql<{ d: string }>`SELECT to_char(${to}::date - 29, 'YYYY-MM-DD') AS d`.execute(this.db)).rows[0].d;
    const rows = (await sql<{ department_id: string; department_name: string; episodes: number; active: number; los_hours: string | null; los_median: string | null; readmissions: number;
      deaths: number; ventilated: number; vent_days: string | null }>`
      SELECT d.id AS department_id, d.name AS department_name, count(e.id)::int AS episodes, count(e.id) FILTER (WHERE e.ended_at IS NULL)::int AS active,
             avg(extract(epoch FROM e.ended_at - e.started_at) / 3600.0) FILTER (WHERE e.ended_at IS NOT NULL AND e.exit_kind <> 'cancel') AS los_hours,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM e.ended_at - e.started_at) / 3600.0) FILTER (WHERE e.ended_at IS NOT NULL AND e.exit_kind <> 'cancel') AS los_median,
             count(e.id) FILTER (WHERE e.readmission)::int AS readmissions,
             count(e.id) FILTER (WHERE e.exit_condition = 'died')::int AS deaths,
             count(e.id) FILTER (WHERE EXISTS (SELECT 1 FROM icu_ventilation v WHERE v.episode_id = e.id AND v.kind = 'invasive' AND v.voided_at IS NULL))::int AS ventilated,
             sum((SELECT sum(extract(epoch FROM coalesce(v.ended_at, now()) - v.started_at)) / 86400.0 FROM icu_ventilation v WHERE v.episode_id = e.id AND v.kind = 'invasive' AND v.voided_at IS NULL)) AS vent_days
        FROM departments d JOIN icu_episodes e ON e.department_id = d.id AND e.exit_kind IS DISTINCT FROM 'cancel'
       WHERE (e.started_at AT TIME ZONE ${TZ})::date BETWEEN ${from}::date AND ${to}::date
         AND (${q.department_id ?? null}::uuid IS NULL OR d.id = ${q.department_id ?? null}::uuid)
       GROUP BY d.id, d.name ORDER BY d.name`.execute(this.db)).rows;
    const bundles = (await sql<{ bundle: string; checks: number; compliant: number }>`
      SELECT b.bundle, count(*)::int AS checks, count(*) FILTER (WHERE b.compliant)::int AS compliant FROM icu_bundle_checks b
        JOIN icu_episodes e ON e.encounter_id = b.encounter_id AND b.checked_at >= e.started_at AND (e.ended_at IS NULL OR b.checked_at <= e.ended_at)
       WHERE b.voided_at IS NULL AND b.check_date BETWEEN ${from}::date AND ${to}::date AND (${q.department_id ?? null}::uuid IS NULL OR e.department_id = ${q.department_id ?? null}::uuid)
       GROUP BY b.bundle ORDER BY b.bundle`.execute(this.db)).rows;
    const scores = (await sql<{ kind: string; n: number; avg: string | null }>`SELECT s.kind, count(*)::int AS n, avg(s.total) AS avg FROM icu_scores s JOIN icu_episodes e ON e.id = s.episode_id
       WHERE s.voided_at IS NULL AND (e.started_at AT TIME ZONE ${TZ})::date BETWEEN ${from}::date AND ${to}::date
         AND (${q.department_id ?? null}::uuid IS NULL OR e.department_id = ${q.department_id ?? null}::uuid)
         AND (s.kind = 'apache2' OR s.window_to < e.started_at + interval '24 hours 1 minute') GROUP BY s.kind`.execute(this.db)).rows;
    return {
      from, to, readmit_hours: (await this.settings()).readmit_hours,
      departments: rows.map((r) => ({ ...r, los_days: r.los_hours ? r1(Number(r.los_hours) / 24) : null, los_median_days: r.los_median ? r1(Number(r.los_median) / 24) : null,
        vent_days: r.vent_days ? r1(Number(r.vent_days)) : 0, mortality_pct: r.episodes ? r1((100 * r.deaths) / r.episodes) : null, readmit_pct: r.episodes ? r1((100 * r.readmissions) / r.episodes) : null })),
      bundles: bundles.map((b) => ({ ...b, pct: b.checks ? r1((100 * b.compliant) / b.checks) : null })),
      admission_scores: scores.map((x) => ({ kind: x.kind, n: x.n, avg: x.avg ? r1(Number(x.avg)) : null })),
    };
  }

  // ---------------------------------------------------------------- APACHE კატეგორიები (admin)
  apacheCategories(all = false) {
    let q = this.db.selectFrom('icu_apache_categories').selectAll().orderBy('sort_order');
    if (!all) q = q.where('is_active', '=', true);
    return q.execute();
  }
  async saveApacheCategory(code: string, dto: ApacheCategoryDto, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const old = await trx.selectFrom('icu_apache_categories').selectAll().where('code', '=', code).forUpdate().executeTakeFirst();
      if (!old) throw new NotFoundException('კატეგორია ვერ მოიძებნა');
      const r = await trx.updateTable('icu_apache_categories').set({ ...(dto.name !== undefined && { name: dto.name.trim() }), ...(dto.weight !== undefined && { weight: dto.weight.toFixed(3) }),
        ...(dto.is_active !== undefined && { is_active: dto.is_active }) }).where('code', '=', code).returningAll().executeTakeFirstOrThrow();
      await this.audit.log(ctx, { action: 'ICU_APACHE_CATEGORY', entityName: 'icu_apache_categories', entityId: code, oldData: old, newData: dto }, trx);
      return r;
    });
  }
}

// ================================================================= ფონური / საერთო ფუნქციები (worker-იც იყენებს)
export function icuFeatures(s: Pick<IcuSettings, 'intensive_features'>, level: string, own: string[] | null): IcuFeature[] {
  if (level === 'ward') return [];
  const list = own ?? (level === 'icu' ? [...ICU_FEATURES] : s.intensive_features ?? []);
  return ICU_FEATURES.filter((f) => list.includes(f));
}
/**
 * უწყვეტი ინფუზიის საათობრივი მოცულობა → სითხის ბალანსი (fluid_entries, auto_hour; იდემპოტენტური, ბოლო 48 სთ):
 * დასრულებულ საათებზე; MAR-ის შესწორებისას (გაუქმება / გვიან ჩაწერა) — გადათვლა (ძველი ჩანაწერი უქმდება).
 */
export async function syncInfusionVolumes(ex: Database, encounterId: string) {
  const orders = await ex.selectFrom('med_orders').select(['id', 'patient_id']).where('encounter_id', '=', encounterId).where('order_type', '=', 'continuous')
    .where('category', '=', 'medication').where((eb) => eb.or([eb('status', 'in', ['active', 'on_hold']), eb('stopped_at', '>', sql<Date>`now() - interval '48 hours'`)])).execute();
  let changed = 0;
  for (const o of orders) {
    const ev = await ex.selectFrom('mar_entries').select(['infusion_action', 'rate_ml_h', 'documented_at', 'documented_by']).where('order_id', '=', o.id)
      .where('source', '=', 'infusion').where('voided_at', 'is', null).orderBy('documented_at').execute();
    if (!ev.length) continue;
    const events: InfusionEvent[] = ev.map((e) => ({ at: new Date(e.documented_at!), action: e.infusion_action as InfusionEvent['action'], rate_ml_h: n(e.rate_ml_h) }));
    const nowH = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    const firstH = Math.max(Math.floor(events[0].at.getTime() / 3_600_000) * 3_600_000, nowH - 48 * 3_600_000);
    const posted = await ex.selectFrom('fluid_entries').select(['id', 'auto_hour', 'volume_ml']).where('order_id', '=', o.id).where('auto_hour', 'is not', null)
      .where('voided_at', 'is', null).where('auto_hour', '>=', new Date(firstH)).execute();
    for (let h = firstH; h < nowH; h += 3_600_000) {
      const vol = infusedVolume(events, new Date(h), new Date(h + 3_600_000));
      const p = posted.find((x) => new Date(x.auto_hour!).getTime() === h);
      if (p && Math.abs(Number(p.volume_ml) - vol) < 0.05) continue;
      const by = [...ev].reverse().find((e) => new Date(e.documented_at!).getTime() < h + 3_600_000)?.documented_by ?? ev[0].documented_by!;
      await ex.transaction().execute(async (trx) => {
        if (p) await trx.updateTable('fluid_entries').set({ voided_at: sql`now()`, voided_by: by, void_reason: 'ინფუზიის მოცულობის გადათვლა (MAR შესწორდა)' }).where('id', '=', p.id).execute();
        if (vol >= 0.1) {
          await sql`INSERT INTO fluid_entries (encounter_id, patient_id, direction, category, volume_ml, recorded_at, order_id, note, created_by, auto_hour)
            VALUES (${encounterId}, ${o.patient_id}, 'in', 'iv', ${vol}, ${new Date(h + 3_600_000)}, ${o.id}, 'ინფუზია (ავტომატურად, საათობრივი)', ${by}, ${new Date(h)})
            ON CONFLICT (order_id, auto_hour) WHERE auto_hour IS NOT NULL AND voided_at IS NULL DO NOTHING`.execute(trx);
        }
      });
      changed++;
    }
  }
  return changed;
}


// ================================================================= controller
@Controller('inpatient')
export class IcuController {
  constructor(private readonly s: IcuService) {}
  @Get('icu/departments') @Roles(...READ, 'receptionist', 'viewer') deps() { return this.s.departments(); }
  @Get('icu/board') @Roles(...READ) board(@Query('department_id', ParseUUIDPipe) dep: string, @CurrentUser() u: AuthUser) { return this.s.board(dep, u); }
  @Get('icu/stats') @Roles('admin', 'doctor', 'nurse', 'manager', 'viewer') stats(@Query() q: StatsQuery) { return this.s.stats(q); }
  @Get('stays/:eid/icu') @Roles(...READ) stay(@Param('eid', ParseUUIDPipe) eid: string, @CurrentUser() u: AuthUser) { return this.s.stayIcu(eid, u); }
  @Get('stays/:eid/icu/sheet') @Roles(...READ) sheet(@Param('eid', ParseUUIDPipe) eid: string, @Query('day') day: string | undefined, @CurrentUser() u: AuthUser) { return this.s.sheet(eid, day, u); }
  @Get('stays/:eid/icu/insert') @Roles('admin', 'doctor') insert(@Param('eid', ParseUUIDPipe) eid: string) { return this.s.insertData(eid); }
  @Get('stays/:eid/icu/scores/:kind/draft') @Roles(...READ)
  draft(@Param('eid', ParseUUIDPipe) eid: string, @Param('kind') kind: string, @Query('window_to') to: string | undefined, @Query('category') category: string | undefined,
        @Query('chronic_health') ch: string | undefined, @Query('emergency_surgery') es: string | undefined, @Query('arf') arf: string | undefined) {
    if (kind !== 'sofa' && kind !== 'apache2') throw new BadRequestException('უცნობი შკალა');
    return this.s.scoreDraft(eid, kind, to, { apache: { category: category || undefined, chronic_health: ch === 'true', emergency_surgery: es === 'true', arf: arf === 'true' } });
  }

  /** მონახაზი ხელით შეცვლილი მნიშვნელობებით (დიალოგში — ჯამის გადათვლა) */
  @Post('stays/:eid/icu/scores/draft') @HttpCode(200) @Roles('admin', 'doctor')
  draftPost(@Param('eid', ParseUUIDPipe) eid: string, @Body() d: ScoreDto) { return this.s.scoreDraft(eid, d.kind, d.window_to, d); }
  @Post('stays/:eid/icu/observations') @Roles(...WRITE)
  observe(@Param('eid', ParseUUIDPipe) eid: string, @Body() d: ObservationDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.observe(eid, d, u, auditCtx(r)); }
  @Patch('icu/episodes/:id') @Roles(...WRITE)
  patchEp(@Param('id', ParseUUIDPipe) id: string, @Body() d: EpisodePatchDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.patchEpisode(id, d, u, auditCtx(r)); }
  @Post('icu/episodes/:id/interval') @HttpCode(200) @Roles('admin', 'doctor')
  interval(@Param('id', ParseUUIDPipe) id: string, @Body() d: IntervalDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.setInterval(id, d, u, auditCtx(r)); }
  @Post('stays/:eid/icu/ventilation') @Roles(...WRITE)
  ventStart(@Param('eid', ParseUUIDPipe) eid: string, @Body() d: VentStartDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.ventStart(eid, d, u, auditCtx(r)); }
  @Post('icu/ventilation/:id/settings') @Roles(...WRITE)
  ventSettings(@Param('id', ParseUUIDPipe) id: string, @Body() d: VentSettingsDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.ventSettings(id, d, u, auditCtx(r)); }
  @Post('icu/ventilation/:id/end') @HttpCode(200) @Roles(...WRITE)
  ventEnd(@Param('id', ParseUUIDPipe) id: string, @Body() d: VentEndDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.ventEnd(id, d, u, auditCtx(r)); }
  @Post('stays/:eid/icu/abg') @Roles(...WRITE)
  abg(@Param('eid', ParseUUIDPipe) eid: string, @Body() d: AbgDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.addAbg(eid, d, u, auditCtx(r)); }
  @Post('stays/:eid/icu/scores') @Roles('admin', 'doctor')
  score(@Param('eid', ParseUUIDPipe) eid: string, @Body() d: ScoreDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.confirmScore(eid, d, u, auditCtx(r)); }
  @Post('stays/:eid/icu/bundles') @Roles(...WRITE)
  bundle(@Param('eid', ParseUUIDPipe) eid: string, @Body() d: BundleDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.checkBundle(eid, d, u, auditCtx(r)); }
  @Post('icu/:kind/:id/void') @HttpCode(200) @Roles(...WRITE)
  void(@Param('kind') kind: string, @Param('id', ParseUUIDPipe) id: string, @Body() d: VoidDto, @CurrentUser() u: AuthUser, @Req() r: Request) {
    if (!['ventilation', 'vent_settings', 'abg', 'score', 'bundle'].includes(kind)) throw new BadRequestException('უცნობი ტიპი');
    return this.s.void(kind as 'abg', id, d.reason, u, auditCtx(r));
  }

  @Get('icu/bundle-items') @Roles(...READ) items(@Query('all') all?: string) { return this.s.bundleItems(all === 'true'); }
  @Post('icu/bundle-items') @Roles('admin') addItem(@Body() d: BundleItemDto, @Req() r: Request) { return this.s.saveBundleItem(null, d, auditCtx(r)); }
  @Patch('icu/bundle-items/:id') @Roles('admin') updItem(@Param('id', ParseUUIDPipe) id: string, @Body() d: BundleItemDto, @Req() r: Request) { return this.s.saveBundleItem(id, d, auditCtx(r)); }
  @Get('icu/apache-categories') @Roles(...READ) cats(@Query('all') all?: string) { return this.s.apacheCategories(all === 'true'); }
  @Patch('icu/apache-categories/:code') @Roles('admin') updCat(@Param('code') code: string, @Body() d: ApacheCategoryDto, @Req() r: Request) { return this.s.saveApacheCategory(code, d, auditCtx(r)); }
}

@Module({ imports: [InpatientModule], providers: [IcuService], controllers: [IcuController], exports: [IcuService] })
export class IcuModule {}
