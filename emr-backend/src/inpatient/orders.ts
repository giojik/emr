import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, Module, NotFoundException, Param, ParseUUIDPipe,
  Patch, Post, Query, Req, UnprocessableEntityException } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min,
  ValidateNested } from 'class-validator';
import type { Request } from 'express';
import { sql, type Transaction } from 'kysely';
import { AllergiesModule } from '../allergies/allergies';
import { AllergyCheckService } from '../allergies/allergy-check.service';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser } from '../auth/roles';
import { loadEnv } from '../config/env';
import type { DB } from '../database/db';
import { InjectDb, type Database } from '../database/database.module';
import { compatible, CONC_UNITS, DOSE_RATE_UNITS, doseRateToMlH, type ConcUnit, type DoseRateUnit } from './icu-calc';
import { NotificationsService } from '../notifications/notifications';
import { PharmacyCatalogService } from '../stock/pharmacy-catalog';
import { StockModule } from '../stock/stock.module';
import { StockTransfersService } from '../stock/stock-transfers';
import { InpatientModule, InpatientService, type InpatientSettings } from './inpatient';

type Trx = Transaction<DB>;
type Ex = Database | Trx;
const TZ = loadEnv().CLINIC_TZ;

export const ORDER_UNITS = ['mg', 'mcg', 'g', 'IU', 'ml', 'mmol', 'mEq', 'tab', 'cap', 'amp', 'vial', 'drop', 'puff', 'sachet', 'supp', 'appl'] as const;
const CATEGORIES = ['medication', 'diet', 'nursing', 'activity'] as const;
const TYPES = ['scheduled', 'once', 'prn', 'continuous'] as const;
const ADULT_DAYS = 18 * 365;

export class OrderDto {
  @IsIn(CATEGORIES) category: (typeof CATEGORIES)[number];
  @IsOptional() @IsUUID() generic_id?: string;
  @IsOptional() @IsString() @Length(2, 300) drug_text?: string;
  @IsOptional() @IsIn(TYPES) order_type?: (typeof TYPES)[number];
  @IsOptional() @IsNumber() @Min(0.0001) @Max(1_000_000) dose?: number;
  @IsOptional() @IsIn(ORDER_UNITS) dose_unit?: string;
  @IsOptional() @IsNumber() @Min(0.0001) @Max(100_000) dose_per_kg?: number;
  @IsOptional() @IsNumber() @Min(0.2) @Max(400) weight_kg?: number;
  @IsOptional() @IsString() @Length(2, 10) route_code?: string;
  @IsOptional() @IsString() @Length(1, 20) frequency_code?: string;
  @IsOptional() @IsString() @Length(2, 300) prn_reason?: string;
  @IsOptional() @IsInt() @Min(1) @Max(48) prn_max_per_day?: number;
  @IsOptional() @IsNumber() @Min(0.5) @Max(72) prn_min_interval_h?: number;
  @IsOptional() @IsString() @MaxLength(200) diluent?: string;
  @IsOptional() @IsNumber() @Min(1) @Max(10_000) volume_ml?: number;
  @IsOptional() @IsNumber() @Min(0.1) @Max(2_000) rate_ml_h?: number;
  @IsOptional() @IsInt() @Min(1) @Max(10_080) duration_min?: number;
  @IsOptional() @IsString() @Length(2, 2000) text?: string;
  @IsOptional() @IsString() @MaxLength(2000) instructions?: string;
  @IsOptional() @IsDateString() start_at?: string;
  @IsOptional() @IsInt() @Min(1) @Max(365) duration_days?: number;
  @IsOptional() @IsIn(['ward', 'pharmacy']) supply_mode?: 'ward' | 'pharmacy';
  @IsOptional() @IsUUID() verbal_doctor_id?: string;      // ზეპირი დანიშნულება (შეჰყავს ექთანს)
  @IsOptional() @IsUUID() set_id?: string;
  // 0044: მოვლის დანიშნულების ტიპი — MAR-ში ჩაწერა ხსნის შესაბამის ფორმას
  @IsOptional() @IsIn(['vitals', 'fluid', 'scale', 'other']) nursing_task?: 'vitals' | 'fluid' | 'scale' | 'other';
  @IsOptional() @IsString() @Length(2, 20) task_scale_code?: string;
  // 0047: ვაზოაქტიური ინფუზია / ტიტრაცია — დოზის სიჩქარე + კონცენტრაცია → მლ/სთ ავტომატურად
  @IsOptional() @IsBoolean() titratable?: boolean;
  @IsOptional() @IsNumber() @Min(0.0001) @Max(100_000) dose_rate?: number;
  @IsOptional() @IsIn(DOSE_RATE_UNITS) dose_rate_unit?: DoseRateUnit;
  @IsOptional() @IsNumber() @Min(0.0001) @Max(1_000_000) conc_amount?: number;
  @IsOptional() @IsIn(CONC_UNITS) conc_unit?: ConcUnit;
  @IsOptional() @IsNumber() @Min(1) @Max(5_000) conc_volume_ml?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100_000) titrate_min?: number;
  @IsOptional() @IsNumber() @Min(0.0001) @Max(100_000) titrate_max?: number;
  @IsOptional() @IsString() @MaxLength(300) titrate_goal?: string;
  // შემოწმებების დადასტურება
  @IsOptional() @IsBoolean() ack?: boolean;
  @IsOptional() @IsString() @Length(5, 1000) override_reason?: string;
  @IsOptional() @IsBoolean() confirm_severe?: boolean;
}
export class ModifyDto extends OrderDto { @IsString() @Length(3, 1000) reason: string }
export class ReasonDto { @IsString() @Length(3, 1000) reason: string }
export class NoteDto { @IsOptional() @IsString() @MaxLength(1000) note?: string }
export class VerifyDto {
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
  @IsOptional() @IsUUID() dispense_item_id?: string;               // აფთიაქიდან პაციენტზე: SKU
  @IsOptional() @IsNumber() @Min(0.001) @Max(100_000) dispense_qty?: number;   // საბაზო ერთეულში
}
export class SetDto {
  @IsString() @Length(2, 200) name: string;
  @IsOptional() @IsUUID() department_id?: string;                  // განყოფილების (ხელმძღვანელი); არადა — პირადი
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(40) @ValidateNested({ each: true }) @Type(() => OrderDto) items: OrderDto[];
  @IsOptional() @IsBoolean() is_active?: boolean;
}
export class FrequencyDto {
  @Matches(/^[A-Z0-9_]{1,20}$/) code: string;
  @IsString() @Length(1, 100) name: string;
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(24) @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { each: true }) times_of_day?: string[];
  @IsOptional() @IsInt() @Min(1) @Max(72) interval_hours?: number;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsInt() @Min(0) sort_order?: number;
}

export interface OrderCheck { code: string; level: 'info' | 'warn' | 'reason' | 'block'; message: string; severe?: boolean }
const RANK = { info: 0, warn: 1, reason: 2, block: 3 } as const;

/**
 * დანიშნულებები (0042) — CPOE.
 *   ნიშნავს: მკურნალი ექიმი ან მიმდინარე განყოფილების ექიმი; ზეპირი — განყოფილების ექთანი ექიმის სახელით (verbal_orders), ექიმი ადასტურებს.
 *   შემოწმებები: ალერგია (ჯენერიკის ჯგუფებითაც), დოზა (ერთჯ. / დღიური / ბავშვი მგ/კგ / ასაკი), ურთიერთქმედება და დუბლირება აქტიურ დანიშნულებებთან,
 *     გზა, წონა (ბავშვი / მგ/კგ — სავალდებულო; ძველი — გაფრთხილება). 409 ORDER_CHECKS → კლიენტი ადასტურებს (ack / override_reason / confirm_severe).
 *   ანტიბიოტიკი (ATC J01): ხანგრძლივობა სავალდებულო; სარეზერვო → დამტკიცება (ხელმძღვანელი ექიმი ან ფარმაცევტი).
 *   ვერიფიკაცია: med_verification (all / high_risk / off); აფთიაქიდან მომარაგება — ვერიფიკაციისას მოთხოვნა (0032).
 *   შეცვლა = შეწყვეტა + ახალი (replaces_id); გაწერისას — ყველა აქტიური წყდება.
 */
const VERIFIER_KA: Record<string, string> = {
  pharmacist: 'დანიშნულებას ადასტურებს ფარმაცევტი', head_nurse: 'დანიშნულებას ადასტურებს განყოფილების მთავარი ექთანი',
  both: 'დანიშნულებას ადასტურებს განყოფილების მთავარი ექთანი ან ფარმაცევტი',
};

@Injectable()
export class OrdersService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService, private readonly ipd: InpatientService,
              private readonly allergy: AllergyCheckService, private readonly pharm: PharmacyCatalogService, private readonly stock: StockTransfersService,
              private readonly bell: NotificationsService) {}

  // ================================================================= კონტექსტი
  private async stay(encounterId: string, ex: Ex = this.db, lock = false) {
    let q = ex.selectFrom('inpatient_stays as st').innerJoin('encounters as e', 'e.id', 'st.encounter_id').innerJoin('patients as p', 'p.id', 'st.patient_id')
      .select(['st.encounter_id', 'st.patient_id', 'st.status', 'st.adm_no', 'e.attending_doctor_id', 'p.birth_date', 'p.first_name', 'p.last_name',
        sql<number>`((now() AT TIME ZONE ${TZ})::date - p.birth_date)`.as('age_days'),
        sql<string>`coalesce((SELECT a.department_id FROM bed_assignments a WHERE a.encounter_id = st.encounter_id AND a.end_kind IS DISTINCT FROM 'cancel'
          ORDER BY (a.ended_at IS NULL) DESC, a.started_at DESC, a.id DESC LIMIT 1), e.department_id)`.as('department_id')])
      .where('st.encounter_id', '=', encounterId);
    if (lock) q = q.forUpdate('st');
    const st = await q.executeTakeFirst();
    if (!st) throw new NotFoundException('ჰოსპიტალიზაცია ვერ მოიძებნა');
    return st;
  }
  private async isDoctorFor(u: AuthUser, st: { attending_doctor_id: string | null; department_id: string }, ex: Ex = this.db) {
    if (!has(u, 'doctor')) return false;
    if (st.attending_doctor_id === u.id) return true;
    return (await this.ipd.me(u, ex)).department_id === st.department_id;
  }
  private async canApprove(u: AuthUser, departmentId: string, ex: Ex = this.db) {
    if (has(u, 'pharmacist')) return true;
    if (!has(u, 'doctor')) return false;
    const me = await this.ipd.me(u, ex);
    return me.department_id === departmentId && me.is_section_head;
  }
  /**
   * 0043b: ვინ ადასტურებს დანიშნულებას (med_verifier): pharmacist / head_nurse (განყოფილების მთავარი ექთანი — nurse + is_section_head) / both.
   * აბრუნებს როლს, რომლითაც მომხმარებელი ადასტურებს, ან null.
   */
  async verifierRole(u: AuthUser, departmentId: string | null, s?: InpatientSettings, ex: Ex = this.db): Promise<'admin' | 'pharmacist' | 'head_nurse' | null> {
    const mode = (s ?? await this.ipd.settings()).med_verifier ?? 'both';
    if (has(u, 'admin')) return 'admin';
    if (has(u, 'pharmacist') && mode !== 'head_nurse') return 'pharmacist';
    if (has(u, 'nurse') && mode !== 'pharmacist') {
      const me = await this.ipd.me(u, ex);
      if (me.is_section_head && me.department_id && (!departmentId || me.department_id === departmentId)) return 'head_nurse';
    }
    return null;
  }
  async latestWeight(patientId: string, ex: Ex = this.db) {
    return ex.selectFrom('encounter_vitals as v').innerJoin('encounters as e', 'e.id', 'v.encounter_id').select(['v.weight_kg', 'v.recorded_at'])
      .where('e.patient_id', '=', patientId).where('v.weight_kg', 'is not', null).where('v.voided_at', 'is', null).orderBy('v.recorded_at', 'desc').limit(1).executeTakeFirst();
  }
  private async staffIds(departmentId: string | null, caps: string[], headsOnly = false) {
    let q = this.db.selectFrom('users as u').innerJoin('user_capabilities as c', 'c.user_id', 'u.id').select('u.id').distinct().where('u.is_active', '=', true)
      .where(sql<boolean>`c.capabilities && ${sql.val(caps)}::varchar[]`);
    if (departmentId) q = q.where('u.department_id', '=', departmentId);
    if (headsOnly) q = q.where('u.is_section_head', '=', true);
    return (await q.execute()).map((r) => r.id);
  }
  private async notify(ids: string[], n: { kind: string; title: string; body?: string; item?: string; entityId: string; link: string; urgent?: boolean }, except?: string) {
    for (const id of new Set(ids)) if (id !== except) await this.bell.notify(id, { ...n, urgent: !!n.urgent }).catch(() => undefined);
  }
  private ev(ex: Ex, orderId: string, kind: string, data: Record<string, unknown>, u: AuthUser | null) {
    return ex.insertInto('med_order_events').values({ order_id: orderId, kind, data: JSON.stringify(data), user_id: u?.id ?? null }).execute();
  }

  // ================================================================= ნორმალიზაცია + შემოწმებები
  private async prepare(ex: Ex, st: Awaited<ReturnType<OrdersService['stay']>>, dto: OrderDto, s: InpatientSettings, excludeId: string | null) {
    const checks: OrderCheck[] = [];
    const startAt = dto.start_at ? new Date(dto.start_at) : new Date();
    if (startAt.getTime() < Date.now() - 24 * 3_600_000) throw new BadRequestException('დაწყების დრო 24 სთ-ზე მეტით წარსულშია');
    const base = {
      encounter_id: st.encounter_id, patient_id: st.patient_id, category: dto.category, start_at: startAt,
      instructions: dto.instructions?.trim() || null, duration_days: dto.duration_days ?? null,
      end_at: dto.duration_days ? new Date(startAt.getTime() + dto.duration_days * 86_400_000) : null,
    };
    if (dto.nursing_task && dto.category !== 'nursing') throw new BadRequestException('ტიპი (ვიტალები / ბალანსი / შკალა) — მხოლოდ მოვლის დანიშნულებაზე');
    if ((dto.nursing_task === 'scale') !== !!dto.task_scale_code) throw new BadRequestException('შკალის დავალებას სჭირდება შკალის არჩევა');
    if (dto.task_scale_code && !(await ex.selectFrom('scale_defs').select('code').where('code', '=', dto.task_scale_code).where('is_active', '=', true).executeTakeFirst())) {
      throw new BadRequestException('შკალა ვერ მოიძებნა');
    }
    if (dto.category !== 'medication') {
      if (!dto.text?.trim()) throw new BadRequestException('დანიშნულების ტექსტი სავალდებულოა');
      if (dto.frequency_code) await this.frequency(dto.frequency_code, ex);
      return { values: { ...base, text: dto.text.trim(), frequency_code: dto.frequency_code ?? null,
        nursing_task: dto.category === 'nursing' && dto.nursing_task && dto.nursing_task !== 'other' ? dto.nursing_task : null, task_scale_code: dto.nursing_task === 'scale' ? dto.task_scale_code! : null },
        checks, generic: null, verify: false, approval: false };
    }
    if (!dto.order_type) throw new BadRequestException('დანიშნულების ტიპი სავალდებულოა');
    if (!dto.generic_id && !dto.drug_text?.trim()) throw new BadRequestException('მიუთითეთ მედიკამენტი (კატალოგიდან ან ტექსტით)');
    if (dto.generic_id && dto.drug_text) throw new BadRequestException('მედიკამენტი — ან კატალოგიდან, ან ტექსტით');
    if (!dto.route_code) throw new BadRequestException('მიღების გზა სავალდებულოა');
    const route = await ex.selectFrom('med_routes').select(['code', 'is_active']).where('code', '=', dto.route_code).executeTakeFirst();
    if (!route?.is_active) throw new BadRequestException('მიღების გზა ვერ მოიძებნა');
    const g = dto.generic_id ? await ex.selectFrom('med_generics as g').innerJoin('med_dosage_forms as f', 'f.code', 'g.form_code')
      .select(['g.id', 'g.inn', 'g.inn_latin', 'g.strength', 'g.atc_code', 'g.dose_unit', 'g.routes', 'g.controlled_class', 'g.high_alert', 'g.reserve_antibiotic',
        'g.patient_only', 'g.is_active', 'f.name as form_name'])
      .where('g.id', '=', dto.generic_id).executeTakeFirst() : null;
    if (dto.generic_id && !g?.is_active) throw new BadRequestException('ჯენერიკი ვერ მოიძებნა ან გათიშულია');

    // --- ტიპი
    let freq: Awaited<ReturnType<OrdersService['frequency']>> | null = null;
    if (dto.order_type === 'scheduled') {
      if (!dto.frequency_code) throw new BadRequestException('გეგმიურ დანიშნულებას სიხშირე სჭირდება');
      freq = await this.frequency(dto.frequency_code, ex);
    }
    if (dto.order_type === 'prn' && !dto.prn_reason?.trim()) throw new BadRequestException('PRN: მიუთითეთ ჩვენება (მაგ. ტკივილი > 5)');
    if (dto.order_type === 'continuous' && !dto.rate_ml_h && !dto.dose_rate) throw new BadRequestException('უწყვეტი ინფუზია: სიჩქარე (მლ/სთ ან დოზა) სავალდებულოა');
    const titr = dto.dose_rate !== undefined || dto.titratable || dto.dose_rate_unit || dto.conc_amount;
    if (titr) {
      if (dto.order_type !== 'continuous') throw new BadRequestException('დოზის სიჩქარე / ტიტრაცია — მხოლოდ უწყვეტ ინფუზიაზე');
      if (!dto.dose_rate || !dto.dose_rate_unit || !dto.conc_amount || !dto.conc_unit || !dto.conc_volume_ml) {
        throw new BadRequestException('ტიტრაცია: მიუთითეთ დოზა, ერთეული და კონცენტრაცია (რაოდენობა / მოცულობა)');
      }
      if (!compatible(dto.dose_rate_unit, dto.conc_unit)) throw new BadRequestException('დოზის და კონცენტრაციის ერთეულები შეუთავსებელია (მასა / ერთეული)');
      if (dto.titrate_min !== undefined && dto.titrate_max !== undefined && dto.titrate_min > dto.titrate_max) throw new BadRequestException('ტიტრაცია: მინიმუმი მაქსიმუმზე მეტია');
      if ((dto.titrate_min !== undefined && dto.dose_rate < dto.titrate_min) || (dto.titrate_max !== undefined && dto.dose_rate > dto.titrate_max)) {
        throw new BadRequestException('საწყისი დოზა ტიტრაციის დიაპაზონს გარეთაა');
      }
    }

    // --- წონა
    const child = st.age_days < ADULT_DAYS;
    let weight: number | null = dto.weight_kg ?? null;
    const rateKg = !!dto.dose_rate_unit?.includes('/kg/') && !!dto.dose_rate;
    if (!weight && rateKg) {
      const ep = await ex.selectFrom('icu_episodes').select('admission_weight_kg').where('encounter_id', '=', st.encounter_id).where('ended_at', 'is', null).executeTakeFirst();
      if (ep?.admission_weight_kg) weight = Number(ep.admission_weight_kg);
    }
    if (!weight && (child || dto.dose_per_kg || rateKg)) {
      const w = await this.latestWeight(st.patient_id, ex);
      if (w) {
        weight = Number(w.weight_kg);
        const days = (Date.now() - new Date(w.recorded_at).getTime()) / 86_400_000;
        if (days > s.weight_max_age_days) checks.push({ code: 'weight_old', level: 'warn', message: `წონა (${weight} კგ) ${Math.floor(days)} დღის წინ აიწონა — განაახლეთ` });
      }
    }
    if (!weight && rateKg) throw new UnprocessableEntityException({ code: 'WEIGHT_REQUIRED', message: 'დოზა წონაზე (მკგ/კგ/წთ და სხვ.) — მიუთითეთ წონა' });
    let rateMlH: number | null = dto.rate_ml_h ?? null;
    if (titr) {
      rateMlH = doseRateToMlH(dto.dose_rate!, dto.dose_rate_unit!, { amount: dto.conc_amount!, unit: dto.conc_unit!, volume_ml: dto.conc_volume_ml! }, weight);
      if (rateMlH < 0.1 || rateMlH > 2_000) throw new BadRequestException(`გამოთვლილი სიჩქარე (${rateMlH} მლ/სთ) დასაშვებ ზღვრებს სცდება — შეამოწმეთ კონცენტრაცია`);
    }
    if (!weight && (dto.dose_per_kg || (child && g))) {
      throw new UnprocessableEntityException({ code: 'WEIGHT_REQUIRED', message: child ? 'ბავშვის დანიშნულებას წონა სჭირდება (ვიტალები ან ველი „წონა“)' : 'მგ/კგ დოზას წონა სჭირდება' });
    }

    // --- დოზა
    let dose: number | null = dto.dose ?? null;
    if (dto.dose_per_kg) dose = Math.round(dto.dose_per_kg * weight! * 10_000) / 10_000;
    if (dto.order_type !== 'continuous') {
      if (!dose || !dto.dose_unit) throw new BadRequestException('დოზა და ერთეული სავალდებულოა');
    }
    if (g?.dose_unit && dto.dose_unit && dto.dose_unit !== g.dose_unit) {
      throw new BadRequestException(`დოზის ერთეული ამ ჯენერიკზე — ${g.dose_unit} (ზღვრები ამ ერთეულშია)`);
    }

    // --- ანტიბიოტიკი
    const antibiotic = !!g?.atc_code?.startsWith('J01');
    if (antibiotic && dto.order_type !== 'once' && !dto.duration_days) {
      throw new BadRequestException({ code: 'ANTIBIOTIC_DURATION', message: `ანტიბიოტიკი: მიუთითეთ ხანგრძლივობა (დღეები; ნაგულისხმევად ${s.antibiotic_default_days})` });
    }

    // --- შემოწმებები
    if (!g) checks.push({ code: 'free_text', level: 'info', message: 'კატალოგის გარეშე — დოზისა და ურთიერთქმედების შემოწმება ვერ ხერხდება' });
    const name = [g?.inn, g?.inn_latin, dto.drug_text].filter(Boolean).join(' ');
    const groups = g ? (await ex.selectFrom('med_generic_allergens').select('group_code').where('generic_id', '=', g.id).execute()).map((r) => r.group_code) : [];
    const al = await this.allergy.check(st.patient_id, name, ex as never, groups);
    for (const m of al.matches) {
      checks.push({ code: 'allergy', level: m.level === 'info' ? 'info' : m.level === 'warning' ? 'warn' : 'reason', severe: m.level === 'block',
        message: `ალერგია: ${m.substance}${m.group ? ` (${m.group}${m.match === 'cross' ? ', ჯვარედინი' : ''})` : ''} — ${m.allergy_type === 'intolerance' ? 'აუტანლობა' : m.severity === 'severe' ? 'მძიმე' : m.severity === 'moderate' ? 'საშუალო' : 'მსუბუქი'}` });
    }
    if (g) {
      if (g.routes.length && !g.routes.includes(dto.route_code)) checks.push({ code: 'route', level: 'warn', message: `გზა ${dto.route_code} ამ ჯენერიკისთვის ტიპური არ არის (${g.routes.join(', ')})` });
      if (dose && dto.order_type !== 'continuous') {
        const perDay = dto.order_type === 'scheduled' ? Number(freq!.per_day) : dto.order_type === 'prn' ? (dto.prn_max_per_day ?? 1) : 1;
        const dc = await this.pharm.doseCheck({ generic_id: g.id, dose, doses_per_day: Math.max(1, Math.round(perDay)), weight_kg: weight ?? undefined, age_days: st.age_days });
        for (const w of dc.warnings) {
          if (w.code === 'no_limits') checks.push({ code: 'dose_limits', level: 'info', message: w.message });
          else if (w.code === 'weight_required') checks.push({ code: 'dose_weight', level: 'warn', message: w.message });
          else if (w.code === 'min_age') checks.push({ code: 'dose_age', level: 'reason', message: w.message });
          else checks.push({ code: `dose_${w.code}`, level: s.dose_rule === 'block' ? 'block' : 'reason', message: w.message });
        }
      }
      const active = await ex.selectFrom('med_orders as o').innerJoin('med_generics as g2', 'g2.id', 'o.generic_id').select(['o.generic_id', 'g2.inn'])
        .where('o.encounter_id', '=', st.encounter_id).where('o.status', 'in', ['active', 'on_hold']).where('o.category', '=', 'medication')
        .where('o.generic_id', 'is not', null).$if(!!excludeId, (q) => q.where('o.id', '<>', excludeId!)).execute();
      if (active.some((a) => a.generic_id === g.id)) checks.push({ code: 'duplicate', level: 'warn', message: `დუბლირება: ${g.inn} უკვე დანიშნულია` });
      const others = [...new Set(active.map((a) => a.generic_id!).filter((id) => id !== g.id))];
      if (others.length) {
        for (const x of await this.pharm.check([g.id, ...others])) {
          if (x.a_id !== g.id && x.b_id !== g.id) continue;
          const lvl: OrderCheck['level'] = x.severity === 'contraindicated' || x.severity === 'major'
            ? (s.interaction_rule === 'block' ? 'block' : 'reason') : x.severity === 'moderate' || x.severity === 'duplicate' ? 'warn' : 'info';
          checks.push({ code: x.severity === 'duplicate' ? 'duplicate' : `interaction_${x.severity}`, level: lvl,
            message: `${x.severity === 'duplicate' ? '' : 'ურთიერთქმედება: '}${x.a} + ${x.b} — ${x.effect}${x.recommendation ? ` (${x.recommendation})` : ''}` });
        }
      }
      if (g.high_alert) checks.push({ code: 'high_alert', level: 'info', message: 'მაღალი რისკის მედიკამენტი' });
    }
    if (dto.order_type === 'prn' && !dto.prn_max_per_day) checks.push({ code: 'prn_max', level: 'info', message: 'PRN: დღიური მაქსიმუმი არ არის მითითებული' });

    // --- ვერიფიკაცია / დამტკიცება / მომარაგება
    const supply = dto.supply_mode ?? (g?.patient_only ? 'pharmacy' : 'ward');
    const risky = !g || !!g.high_alert || !!g.controlled_class || !!g.reserve_antibiotic;
    const verify = s.med_verification === 'all' || (s.med_verification === 'high_risk' && (risky || supply === 'pharmacy'));
    const approval = !!g?.reserve_antibiotic;
    return {
      values: {
        ...base, generic_id: g?.id ?? null, drug_text: g ? null : dto.drug_text!.trim(), order_type: dto.order_type, dose, dose_unit: dto.dose_unit ?? null,
        dose_per_kg: dto.dose_per_kg ?? null, weight_kg: dto.dose_per_kg || child || rateKg ? weight : null, route_code: dto.route_code, frequency_code: freq?.code ?? null,
        prn_reason: dto.order_type === 'prn' ? dto.prn_reason!.trim() : null, prn_max_per_day: dto.order_type === 'prn' ? dto.prn_max_per_day ?? null : null,
        prn_min_interval_h: dto.order_type === 'prn' ? dto.prn_min_interval_h ?? null : null,
        diluent: dto.diluent?.trim() || null, volume_ml: dto.volume_ml ?? null, rate_ml_h: rateMlH, duration_min: dto.duration_min ?? null,
        titratable: titr ? !!dto.titratable : false, dose_rate: titr ? String(dto.dose_rate) : null, dose_rate_unit: titr ? dto.dose_rate_unit! : null,
        conc_amount: titr ? String(dto.conc_amount) : null, conc_unit: titr ? dto.conc_unit! : null, conc_volume_ml: titr ? String(dto.conc_volume_ml) : null,
        titrate_min: titr && dto.titrate_min !== undefined ? String(dto.titrate_min) : null, titrate_max: titr && dto.titrate_max !== undefined ? String(dto.titrate_max) : null,
        titrate_goal: titr ? dto.titrate_goal?.trim() || null : null,
        supply_mode: supply,
      },
      checks, generic: g, verify, approval,
    };
  }

  /** შემოწმებების დადასტურების კონტროლი: block → 422; warn → ack; reason → override_reason; severe → confirm_severe */
  private gate(checks: OrderCheck[], dto: OrderDto) {
    const blocked = checks.filter((c) => c.level === 'block');
    if (blocked.length) throw new UnprocessableEntityException({ code: 'ORDER_BLOCKED', message: blocked.map((c) => c.message).join('; '), checks });
    const needAck = checks.some((c) => RANK[c.level] >= RANK.warn);
    const needReason = checks.some((c) => c.level === 'reason');
    const needSevere = checks.some((c) => c.severe);
    if ((needAck && !dto.ack && !dto.override_reason) || (needReason && !dto.override_reason?.trim()) || (needSevere && !dto.confirm_severe)) {
      throw new ConflictException({ code: 'ORDER_CHECKS', message: 'დანიშნულების შემოწმება — საჭიროა დადასტურება', checks,
        requires: { ack: needAck, reason: needReason, severe: needSevere } });
    }
    return needAck;
  }

  // ================================================================= შექმნა / შეცვლა
  async create(encounterId: string, dto: OrderDto, u: AuthUser, ctx: AuditContext, replaces?: { id: string; reason: string }) {
    const s = await this.ipd.settings();
    const out = await this.db.transaction().execute(async (trx) => {
      const st = await this.stay(encounterId, trx, true);
      if (st.status !== 'active') throw new ConflictException('დანიშნულება — მხოლოდ აქტიურ ჰოსპიტალიზაციაზე');
      // ავტორი: ექიმი — თავად; ზეპირი — განყოფილების ექთანი ექიმის სახელით
      let orderedBy = u.id; let verbal = false;
      if (dto.verbal_doctor_id && dto.verbal_doctor_id !== u.id) {
        if (!s.verbal_orders) throw new ForbiddenException('ზეპირი დანიშნულება კლინიკაში გამორთულია');
        if (!has(u, 'nurse') || !(await this.ipd.isStaff(u, st.department_id, trx))) throw new ForbiddenException('ზეპირ დანიშნულებას შეიყვანს განყოფილების ექთანი');
        await this.ipd.doctor(dto.verbal_doctor_id, trx);
        orderedBy = dto.verbal_doctor_id; verbal = true;
      } else if (!(await this.isDoctorFor(u, st, trx))) throw new ForbiddenException('ნიშნავს მკურნალი ექიმი ან განყოფილების ექიმი');
      if (replaces) {
        const old = await trx.selectFrom('med_orders').selectAll().where('id', '=', replaces.id).forUpdate().executeTakeFirst();
        if (!old || old.encounter_id !== encounterId) throw new NotFoundException('დანიშნულება ვერ მოიძებნა');
        if (!['active', 'on_hold'].includes(old.status)) throw new ConflictException('შეიცვლება მხოლოდ აქტიური ან შეჩერებული დანიშნულება');
        if (old.category !== dto.category) throw new BadRequestException('შეცვლისას კატეგორია იგივე რჩება');
      }
      const p = await this.prepare(trx, st, dto, s, replaces?.id ?? null);
      const acked = this.gate(p.checks, dto);
      if (replaces) {
        await trx.updateTable('med_orders').set({ status: 'stopped', stopped_at: sql`now()`, stopped_by: u.id, stop_reason: `შეიცვალა: ${replaces.reason}` })
          .where('id', '=', replaces.id).execute();
      }
      const o = await trx.insertInto('med_orders').values({
        ...p.values, ordered_by: orderedBy, entered_by: u.id, is_verbal: verbal, set_id: dto.set_id ?? null, replaces_id: replaces?.id ?? null,
        checks: JSON.stringify(p.checks), override_reason: acked ? dto.override_reason?.trim() || null : null,
        verify_status: p.verify ? 'pending' : 'not_required', approval_status: p.approval ? 'pending' : 'not_required',
      }).returning(['id']).executeTakeFirstOrThrow();
      await this.ev(trx, o.id, 'created', { verbal, checks: p.checks.filter((c) => c.level !== 'info').map((c) => c.code), override: acked ? dto.override_reason ?? 'ack' : null }, u);
      if (replaces) {
        await this.ev(trx, replaces.id, 'modified', { new_order_id: o.id, reason: replaces.reason }, u);
      }
      await this.audit.log(ctx, { action: replaces ? 'MED_ORDER_MODIFY' : 'MED_ORDER_CREATE', entityName: 'med_orders', entityId: o.id,
        newData: { ...p.values, verbal, replaces: replaces?.id, checks: p.checks, override_reason: dto.override_reason } }, trx);
      return { id: o.id, st, p, verbal, orderedBy };
    });
    // შეტყობინებები
    const v = out.p.values as { drug_text?: string | null; text?: string | null };
    const name = out.p.generic?.inn ?? v.drug_text ?? v.text ?? '';
    const who = `${out.st.last_name} ${out.st.first_name} (${out.st.adm_no})`;
    const link = `/inpatient/stay/${encounterId}?tab=orders`;
    if (out.p.verify) {
      // მთავარი ექთანი — ყველა; ფარმაცევტი — pharmacist რეჟიმში, ან both-ში მხოლოდ კონტროლირებადი / სარეზერვო / აფთიაქიდან / კატალოგის გარეშე (ან თუ მთავარი ექთანი არ ჰყავს)
      const mode = s.med_verifier ?? 'both'; const g = out.p.generic;
      const heads = mode !== 'pharmacist' ? await this.staffIds(out.st.department_id, ['nurse'], true) : [];
      const pharmFocus = !g || !!g.controlled_class || !!g.reserve_antibiotic || out.p.values.supply_mode === 'pharmacy';
      const pharm = mode === 'pharmacist' || (mode === 'both' && (pharmFocus || !heads.length)) ? await this.staffIds(null, ['pharmacist']) : [];
      const n = { kind: 'ipd_order_verify', title: `დანიშნულება — დასადასტურებელი: ${name}`, body: who, item: name, entityId: out.id };
      await this.notify(heads, { ...n, link: `/inpatient?tab=orders&department_id=${out.st.department_id}` }, u.id);
      await this.notify(pharm.filter((x) => !heads.includes(x)), { ...n, link: '/stock/verification' }, u.id);
    }
    if (out.p.approval) {
      const heads = await this.staffIds(out.st.department_id, ['doctor'], true);
      await this.notify([...heads, ...await this.staffIds(null, ['pharmacist'])], { kind: 'ipd_order_approve', title: `სარეზერვო ანტიბიოტიკი — დასამტკიცებელი: ${name}`, body: who, item: name, entityId: out.id, link, urgent: true }, u.id);
    }
    if (out.verbal) await this.notify([out.orderedBy], { kind: 'ipd_verbal_confirm', title: `ზეპირი დანიშნულება — დაადასტურეთ: ${name}`, body: who, item: name, entityId: out.id, link });
    return this.get(out.id);
  }

  modify(orderId: string, dto: ModifyDto, u: AuthUser, ctx: AuditContext) {
    return this.db.selectFrom('med_orders').select('encounter_id').where('id', '=', orderId).executeTakeFirst().then((o) => {
      if (!o) throw new NotFoundException('დანიშნულება ვერ მოიძებნა');
      const { reason, ...order } = dto;
      return this.create(o.encounter_id, order as OrderDto, u, ctx, { id: orderId, reason: reason.trim() });
    });
  }

  private async frequency(code: string, ex: Ex = this.db) {
    const f = await ex.selectFrom('med_frequencies').selectAll().where('code', '=', code).executeTakeFirst();
    if (!f?.is_active) throw new BadRequestException(`სიხშირე ${code} ვერ მოიძებნა`);
    return f;
  }

  // ================================================================= წაკითხვა
  private base(ex: Ex = this.db) {
    return ex.selectFrom('med_orders as o').leftJoin('med_generics as g', 'g.id', 'o.generic_id').leftJoin('med_dosage_forms as f', 'f.code', 'g.form_code')
      .leftJoin('med_routes as r', 'r.code', 'o.route_code').leftJoin('med_frequencies as fq', 'fq.code', 'o.frequency_code')
      .innerJoin('users as ob', 'ob.id', 'o.ordered_by').innerJoin('users as eb', 'eb.id', 'o.entered_by')
      .leftJoin('users as vb', 'vb.id', 'o.verified_by').leftJoin('users as ab', 'ab.id', 'o.approved_by').leftJoin('stock_requests as rq', 'rq.id', 'o.stock_request_id')
      .selectAll('o').select(['g.inn', 'g.inn_latin', 'g.strength', 'g.atc_code', 'g.high_alert', 'g.controlled_class', 'g.reserve_antibiotic', 'f.name as form_name',
        'r.name as route_name', 'fq.name as frequency_name', 'rq.req_no', 'rq.status as request_status',
        sql<string>`ob.last_name || ' ' || ob.first_name`.as('ordered_by_name'), sql<string>`eb.last_name || ' ' || eb.first_name`.as('entered_by_name'),
        sql<string | null>`vb.last_name || ' ' || vb.first_name`.as('verified_by_name'), sql<string | null>`ab.last_name || ' ' || ab.first_name`.as('approved_by_name'),
        sql<string>`CASE WHEN o.category = 'medication' THEN coalesce(g.inn || coalesce(' ' || g.strength, '') || coalesce(', ' || f.name, ''), o.drug_text) ELSE o.text END`.as('title')]);
  }
  async get(id: string) {
    const o = await this.base().where('o.id', '=', id).executeTakeFirst();
    if (!o) throw new NotFoundException('დანიშნულება ვერ მოიძებნა');
    const events = await this.db.selectFrom('med_order_events as e').leftJoin('users as x', 'x.id', 'e.user_id')
      .select(['e.id', 'e.kind', 'e.data', 'e.at', sql<string | null>`x.last_name || ' ' || x.first_name`.as('user_name')]).where('e.order_id', '=', id).orderBy('e.at').orderBy('e.id').execute();
    return { ...o, events };
  }
  async list(encounterId: string, u: AuthUser) {
    const st = await this.stay(encounterId);
    const s = await this.ipd.settings();
    const orders = await this.base().where('o.encounter_id', '=', encounterId)
      .orderBy(sql`CASE o.status WHEN 'active' THEN 0 WHEN 'on_hold' THEN 1 ELSE 2 END`).orderBy('o.category').orderBy('o.created_at', 'desc').execute();
    const w = await this.latestWeight(st.patient_id);
    const doctor = await this.isDoctorFor(u, st);
    const nurse = has(u, 'nurse') && await this.ipd.isStaff(u, st.department_id);
    return {
      orders, weight: w ? { kg: Number(w.weight_kg), at: w.recorded_at } : null, age_days: st.age_days,
      settings: { antibiotic_default_days: s.antibiotic_default_days, verbal_orders: s.verbal_orders, med_verification: s.med_verification },
      can: { order: st.status === 'active' && doctor, verbal: st.status === 'active' && s.verbal_orders && nurse, approve: await this.canApprove(u, st.department_id) },
    };
  }

  // ================================================================= სტატუსი
  private async lockOrder(trx: Trx, id: string) {
    const o = await trx.selectFrom('med_orders').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!o) throw new NotFoundException('დანიშნულება ვერ მოიძებნა');
    return o;
  }
  async setStatus(id: string, action: 'hold' | 'resume' | 'stop', reason: string | null, u: AuthUser, ctx: AuditContext) {
    await this.db.transaction().execute(async (trx) => {
      const o = await this.lockOrder(trx, id);
      const st = await this.stay(o.encounter_id, trx);
      if (!(await this.isDoctorFor(u, st, trx))) throw new ForbiddenException('დანიშნულებას მართავს მკურნალი ან განყოფილების ექიმი');
      if (action === 'hold') {
        if (o.status !== 'active') throw new ConflictException('შეჩერდება მხოლოდ აქტიური');
        await trx.updateTable('med_orders').set({ status: 'on_hold', hold_reason: reason }).where('id', '=', id).execute();
      } else if (action === 'resume') {
        if (o.status !== 'on_hold') throw new ConflictException('განახლდება მხოლოდ შეჩერებული');
        if (st.status !== 'active') throw new ConflictException('ჰოსპიტალიზაცია აქტიური არ არის');
        await trx.updateTable('med_orders').set({ status: 'active', hold_reason: null }).where('id', '=', id).execute();
      } else {
        if (!['active', 'on_hold'].includes(o.status)) throw new ConflictException('დანიშნულება უკვე შეწყვეტილია');
        await trx.updateTable('med_orders').set({ status: 'stopped', stopped_at: sql`now()`, stopped_by: u.id, stop_reason: reason }).where('id', '=', id).execute();
      }
      await this.ev(trx, id, action === 'hold' ? 'held' : action === 'resume' ? 'resumed' : 'stopped', { reason }, u);
      await this.audit.log(ctx, { action: `MED_ORDER_${action.toUpperCase()}`, entityName: 'med_orders', entityId: id, newData: { reason } }, trx);
    });
    return this.get(id);
  }

  async confirmVerbal(id: string, u: AuthUser, ctx: AuditContext) {
    await this.db.transaction().execute(async (trx) => {
      const o = await this.lockOrder(trx, id);
      if (!o.is_verbal || o.verbal_confirmed_at) throw new ConflictException('დასადასტურებელი ზეპირი დანიშნულება არ არის');
      if (o.ordered_by !== u.id) throw new ForbiddenException('ზეპირ დანიშნულებას ადასტურებს ექიმი, ვისი სახელითაც შევიდა');
      await trx.updateTable('med_orders').set({ verbal_confirmed_at: sql`now()` }).where('id', '=', id).execute();
      await this.ev(trx, id, 'verbal_confirmed', {}, u);
      await this.audit.log(ctx, { action: 'MED_ORDER_VERBAL_CONFIRM', entityName: 'med_orders', entityId: id }, trx);
    });
    return this.get(id);
  }

  /** სარეზერვო ანტიბიოტიკი: დამტკიცება / უარყოფა (უარყოფა → დანიშნულება წყდება) */
  async approval(id: string, approve: boolean, note: string | null, u: AuthUser, ctx: AuditContext) {
    const o0 = await this.db.transaction().execute(async (trx) => {
      const o = await this.lockOrder(trx, id);
      if (o.approval_status !== 'pending') throw new ConflictException('დანიშნულება დამტკიცებას არ ელოდება');
      if (!['active', 'on_hold'].includes(o.status)) throw new ConflictException('დანიშნულება შეწყვეტილია');
      const st = await this.stay(o.encounter_id, trx);
      if (!(await this.canApprove(u, st.department_id, trx))) throw new ForbiddenException('ამტკიცებს განყოფილების ხელმძღვანელი ექიმი ან ფარმაცევტი');
      if (o.ordered_by === u.id) throw new ConflictException('საკუთარ დანიშნულებას ვერ დაამტკიცებთ');
      if (!approve && (note ?? '').trim().length < 3) throw new BadRequestException('უარყოფის მიზეზი სავალდებულოა');
      await trx.updateTable('med_orders').set({ approval_status: approve ? 'approved' : 'rejected', approved_by: u.id, approved_at: sql`now()`, approval_note: note?.trim() || null,
        ...(!approve && { status: 'stopped' as const, stopped_at: sql`now()`, stopped_by: u.id, stop_reason: `სარეზერვო ანტიბიოტიკი არ დამტკიცდა: ${note!.trim()}` }) })
        .where('id', '=', id).execute();
      await this.ev(trx, id, approve ? 'approved' : 'approval_rejected', { note }, u);
      await this.audit.log(ctx, { action: approve ? 'MED_ORDER_APPROVE' : 'MED_ORDER_APPROVAL_REJECT', entityName: 'med_orders', entityId: id, newData: { note } }, trx);
      return o;
    });
    if (!approve) {
      const r = await this.get(id);
      await this.notify([o0.ordered_by], { kind: 'ipd_order_rejected', title: `სარეზერვო ანტიბიოტიკი არ დამტკიცდა: ${r.title}`, body: note ?? '', item: r.title, entityId: id, link: `/inpatient/stay/${o0.encounter_id}?tab=orders`, urgent: true });
    }
    return this.get(id);
  }

  // ================================================================= ფარმაცევტი
  async verificationQueue(status: string, u: AuthUser, departmentId?: string) {
    const s = await this.ipd.settings();
    const role = await this.verifierRole(u, null, s);
    if (!role) throw new ForbiddenException(VERIFIER_KA[s.med_verifier ?? 'both']);
    const dep = role === 'head_nurse' ? (await this.ipd.me(u)).department_id : departmentId ?? null;
    let q = this.base().innerJoin('inpatient_stays as st', 'st.encounter_id', 'o.encounter_id').innerJoin('patients as p', 'p.id', 'o.patient_id')
      .select(['st.adm_no', 'p.first_name', 'p.last_name', 'p.birth_date', 'p.gender',
        sql<string | null>`(SELECT d.name FROM bed_assignments a JOIN departments d ON d.id = a.department_id WHERE a.encounter_id = o.encounter_id AND a.ended_at IS NULL LIMIT 1)`.as('department_name'),
        sql<number>`(SELECT count(*)::int FROM patient_allergies pa WHERE pa.patient_id = o.patient_id AND pa.is_active)`.as('allergies')])
      .where('o.category', '=', 'medication').orderBy('o.created_at').limit(300);
    if (dep) q = q.where(sql<boolean>`EXISTS (SELECT 1 FROM bed_assignments a WHERE a.encounter_id = o.encounter_id AND a.ended_at IS NULL AND a.department_id = ${dep})`);
    if (status === 'pending') q = q.where('o.verify_status', '=', 'pending').where('o.status', 'in', ['active', 'on_hold']);
    else q = q.where('o.verify_status', 'in', ['verified', 'rejected']).where('o.verified_at', '>', sql<Date>`now() - interval '3 days'`);
    return q.execute();
  }

  async verify(id: string, ok: boolean, dto: VerifyDto, u: AuthUser, ctx: AuditContext) {
    const s = await this.ipd.settings();
    if (!has(u, 'pharmacist', 'admin', 'nurse')) throw new ForbiddenException('დადასტურება — ფარმაცევტი ან მთავარი ექთანი');
    let role: Awaited<ReturnType<OrdersService['verifierRole']>> = null;
    const res = await this.db.transaction().execute(async (trx) => {
      const o = await this.lockOrder(trx, id);
      role = await this.verifierRole(u, (await this.stay(o.encounter_id, trx)).department_id, s, trx);
      if (!role) throw new ForbiddenException(VERIFIER_KA[s.med_verifier ?? 'both']);
      if (o.verify_status !== 'pending') throw new ConflictException('დანიშნულება ვერიფიკაციას არ ელოდება');
      if (!['active', 'on_hold'].includes(o.status)) throw new ConflictException('დანიშნულება შეწყვეტილია');
      if (!ok && (dto.note ?? '').trim().length < 3) throw new BadRequestException('უარყოფის მიზეზი სავალდებულოა');
      let req: Awaited<ReturnType<StockTransfersService['createPatientDispense']>> | null = null;
      if (ok && dto.dispense_item_id) {
        if (o.supply_mode !== 'pharmacy') throw new BadRequestException('მომარაგება — განყოფილების მარაგიდან (აფთიაქიდან გაცემა არ სჭირდება)');
        if (!dto.dispense_qty) throw new BadRequestException('მიუთითეთ რაოდენობა');
        const it = await trx.selectFrom('stock_items').select(['id', 'generic_id', 'is_active']).where('id', '=', dto.dispense_item_id).executeTakeFirst();
        if (!it?.is_active) throw new BadRequestException('საქონელი ვერ მოიძებნა');
        if (o.generic_id && it.generic_id !== o.generic_id) throw new BadRequestException('საქონელი დანიშნულ ჯენერიკს არ შეესაბამება');
        const st = await this.stay(o.encounter_id, trx);
        const loc = await trx.selectFrom('stock_locations').select('id').where('department_id', '=', st.department_id).where('is_active', '=', true)
          .where('kind', 'in', ['department', 'icu']).orderBy('sort_order').limit(1).executeTakeFirst();
        if (!loc) throw new BadRequestException('განყოფილებას ქვესაწყობი არ აქვს (საწყობი → ლოკაციები)');
        req = await this.stock.createPatientDispense(trx, { toLocationId: loc.id, itemId: it.id, qtyBase: dto.dispense_qty, patientId: o.patient_id, urgent: true,
          notes: `დანიშნულება ${st.adm_no}` }, u);
        await trx.updateTable('med_orders').set({ stock_request_id: req.id }).where('id', '=', id).execute();
        await this.ev(trx, id, 'supply_requested', { req_no: req.no, qty: dto.dispense_qty }, u);
      }
      await trx.updateTable('med_orders').set({ verify_status: ok ? 'verified' : 'rejected', verified_by: u.id, verified_at: sql`now()`, verify_note: dto.note?.trim() || null })
        .where('id', '=', id).execute();
      await this.ev(trx, id, ok ? 'verified' : 'verify_rejected', { note: dto.note ?? null, by_role: role }, u);
      await this.audit.log(ctx, { action: ok ? 'MED_ORDER_VERIFY' : 'MED_ORDER_VERIFY_REJECT', entityName: 'med_orders', entityId: id, newData: dto }, trx);
      return { o, req };
    });
    if (res.req) await this.stock.notifyPatientDispense(res.req, true, u);
    if (!ok || dto.note?.trim()) {
      const r = await this.get(id);
      const who = role === 'head_nurse' ? 'მთავარი ექთანი' : 'ფარმაცევტი';
      await this.notify([res.o.ordered_by], { kind: ok ? 'ipd_order_note' : 'ipd_order_rejected', title: ok ? `შენიშვნა (${who}): ${r.title}` : `უარყოფილია (${who}): ${r.title}`,
        body: dto.note ?? '', item: r.title, entityId: id, link: `/inpatient/stay/${res.o.encounter_id}?tab=orders`, urgent: !ok });
    }
    return this.get(id);
  }

  /** განყოფილების დანიშნულებები (დაფის ჩანართი): დასამტკიცებელი, დაუდასტურებელი ზეპირი, ვერიფიკაციის მოლოდინში */
  async department(departmentId: string, u: AuthUser) {
    const rows = await this.base().innerJoin('inpatient_stays as st', 'st.encounter_id', 'o.encounter_id').innerJoin('patients as p', 'p.id', 'o.patient_id')
      .innerJoin('bed_assignments as a', (j) => j.onRef('a.encounter_id', '=', 'o.encounter_id').on('a.ended_at', 'is', null)).leftJoin('beds as b', 'b.id', 'a.bed_id')
      .select(['st.adm_no', 'p.first_name', 'p.last_name', 'b.code as bed_code'])
      .where('a.department_id', '=', departmentId).where('st.status', '=', 'active').where('o.status', 'in', ['active', 'on_hold'])
      .orderBy('p.last_name').orderBy('o.created_at').execute();
    return { orders: rows, can_approve: await this.canApprove(u, departmentId), can_verify: !!(await this.verifierRole(u, departmentId)) };
  }

  /** გაწერისას: ყველა აქტიური / შეჩერებული დანიშნულება წყდება (იმავე ტრანზაქციაში) */
  async stopAllForDischarge(trx: Trx, encounterId: string, reason: string, u: AuthUser) {
    const rows = await trx.updateTable('med_orders').set({ status: 'stopped', stopped_at: sql`now()`, stopped_by: u.id, stop_reason: reason })
      .where('encounter_id', '=', encounterId).where('status', 'in', ['active', 'on_hold']).returning('id').execute();
    for (const r of rows) await this.ev(trx, r.id, 'discharge_stop', { reason }, u);
    return rows.length;
  }

  // ================================================================= შაბლონები
  async sets(u: AuthUser, departmentId?: string) {
    const me = await this.ipd.me(u);
    const deps = [...new Set([me.department_id, departmentId].filter((x): x is string => !!x))];
    return this.db.selectFrom('med_order_sets as s').leftJoin('departments as d', 'd.id', 's.department_id')
      .select(['s.id', 's.name', 's.department_id', 's.owner_id', 's.items', 's.is_active', 's.updated_at', 'd.name as department_name'])
      .where('s.is_active', '=', true)
      .where((eb) => eb.or([eb('s.owner_id', '=', u.id), ...(deps.length ? [eb('s.department_id', 'in', deps)] : [])]))
      .orderBy('s.department_id').orderBy('s.name').execute();
  }
  async saveSet(id: string | null, dto: SetDto, u: AuthUser, ctx: AuditContext) {
    if (dto.department_id ? !(await this.ipd.isHead(u, dto.department_id)) : !has(u, 'doctor')) {
      throw new ForbiddenException(dto.department_id ? 'განყოფილების შაბლონს მართავს ხელმძღვანელი' : 'პირადი შაბლონი — ექიმი');
    }
    const items = dto.items.map(({ ack, override_reason, confirm_severe, verbal_doctor_id, set_id, start_at, ...x }) => { void ack; void override_reason; void confirm_severe; void verbal_doctor_id; void set_id; void start_at; return x; });
    const v = { name: dto.name.trim(), department_id: dto.department_id ?? null, owner_id: dto.department_id ? null : u.id, items: JSON.stringify(items), is_active: dto.is_active ?? true };
    let rid = id;
    if (id) {
      const old = await this.db.selectFrom('med_order_sets').selectAll().where('id', '=', id).executeTakeFirst();
      if (!old) throw new NotFoundException('შაბლონი ვერ მოიძებნა');
      if (old.owner_id ? old.owner_id !== u.id : !(await this.ipd.isHead(u, old.department_id!))) throw new ForbiddenException('შაბლონი თქვენი არ არის');
      await this.db.updateTable('med_order_sets').set(v).where('id', '=', id).execute();
    } else rid = (await this.db.insertInto('med_order_sets').values({ ...v, created_by: u.id }).returning('id').executeTakeFirstOrThrow()).id;
    await this.audit.log(ctx, { action: id ? 'UPDATE_ORDER_SET' : 'CREATE_ORDER_SET', entityName: 'med_order_sets', entityId: rid!, newData: { name: v.name, items: items.length } });
    return this.db.selectFrom('med_order_sets').selectAll().where('id', '=', rid!).executeTakeFirstOrThrow();
  }

  // ================================================================= სიხშირეები
  frequencies(all: boolean) {
    let q = this.db.selectFrom('med_frequencies').select(['code', 'name', sql<string[] | null>`(SELECT array_agg(to_char(t, 'HH24:MI')) FROM unnest(times_of_day) t)`.as('times_of_day'),
      'interval_hours', 'per_day', 'is_active', 'sort_order']).orderBy('sort_order');
    if (!all) q = q.where('is_active', '=', true);
    return q.execute();
  }
  async saveFrequency(dto: FrequencyDto, isNew: boolean, ctx: AuditContext) {
    if (!!dto.times_of_day === !!dto.interval_hours) throw new BadRequestException('მიუთითეთ ან საათები, ან ინტერვალი');
    const perDay = dto.times_of_day ? new Set(dto.times_of_day).size : Math.round((24 / dto.interval_hours!) * 1000) / 1000;
    const v = { name: dto.name.trim(), times_of_day: dto.times_of_day ? sql<string[]>`${sql.val([...new Set(dto.times_of_day)].sort())}::time[]` : null,
      interval_hours: dto.interval_hours ?? null, per_day: String(perDay), ...(dto.is_active !== undefined && { is_active: dto.is_active }), ...(dto.sort_order !== undefined && { sort_order: dto.sort_order }) };
    const exists = await this.db.selectFrom('med_frequencies').select('code').where('code', '=', dto.code).executeTakeFirst();
    if (isNew && exists) throw new ConflictException(`კოდი ${dto.code} უკვე არსებობს`);
    if (!isNew && !exists) throw new NotFoundException('სიხშირე ვერ მოიძებნა');
    if (isNew) await this.db.insertInto('med_frequencies').values({ code: dto.code, ...v } as never).execute();
    else await this.db.updateTable('med_frequencies').set(v as never).where('code', '=', dto.code).execute();
    await this.audit.log(ctx, { action: isNew ? 'CREATE_FREQUENCY' : 'UPDATE_FREQUENCY', entityName: 'med_frequencies', entityId: dto.code, newData: { ...dto, per_day: perDay } });
    return (await this.frequencies(true)).find((f) => f.code === dto.code);
  }
}

const READ = ['admin', 'doctor', 'nurse', 'manager', 'pharmacist'] as const;

@Controller()
export class OrdersController {
  constructor(private readonly s: OrdersService) {}
  @Get('inpatient/stays/:eid/orders') @Roles(...READ) list(@Param('eid', ParseUUIDPipe) eid: string, @CurrentUser() u: AuthUser) { return this.s.list(eid, u); }
  @Post('inpatient/stays/:eid/orders') @Roles('doctor', 'nurse')
  create(@Param('eid', ParseUUIDPipe) eid: string, @Body() d: OrderDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.create(eid, d, u, auditCtx(r)); }
  @Get('inpatient/orders/units') @Roles(...READ) units() { return ORDER_UNITS; }
  @Get('inpatient/orders/frequencies') @Roles(...READ) freqs(@Query('all') all?: string) { return this.s.frequencies(all === 'true'); }
  @Post('inpatient/orders/frequencies') @Roles('admin') addFreq(@Body() d: FrequencyDto, @Req() r: Request) { return this.s.saveFrequency(d, true, auditCtx(r)); }
  @Patch('inpatient/orders/frequencies') @Roles('admin') editFreq(@Body() d: FrequencyDto, @Req() r: Request) { return this.s.saveFrequency(d, false, auditCtx(r)); }
  @Get('inpatient/orders/sets') @Roles('doctor', 'admin') sets(@CurrentUser() u: AuthUser, @Query('department_id') dep?: string) { return this.s.sets(u, dep); }
  @Post('inpatient/orders/sets') @Roles('doctor', 'admin') addSet(@Body() d: SetDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.saveSet(null, d, u, auditCtx(r)); }
  @Patch('inpatient/orders/sets/:id') @Roles('doctor', 'admin')
  editSet(@Param('id', ParseUUIDPipe) id: string, @Body() d: SetDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.saveSet(id, d, u, auditCtx(r)); }
  @Get('inpatient/departments/:id/orders') @Roles(...READ) dep(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser) { return this.s.department(id, u); }
  @Get('inpatient/orders/:id') @Roles(...READ) get(@Param('id', ParseUUIDPipe) id: string) { return this.s.get(id); }
  @Post('inpatient/orders/:id/modify') @Roles('doctor')
  modify(@Param('id', ParseUUIDPipe) id: string, @Body() d: ModifyDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.modify(id, d, u, auditCtx(r)); }
  @Post('inpatient/orders/:id/hold') @HttpCode(200) @Roles('doctor')
  hold(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.setStatus(id, 'hold', d.reason.trim(), u, auditCtx(r)); }
  @Post('inpatient/orders/:id/resume') @HttpCode(200) @Roles('doctor')
  resume(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.setStatus(id, 'resume', null, u, auditCtx(r)); }
  @Post('inpatient/orders/:id/stop') @HttpCode(200) @Roles('doctor')
  stop(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.setStatus(id, 'stop', d.reason.trim(), u, auditCtx(r)); }
  @Post('inpatient/orders/:id/confirm') @HttpCode(200) @Roles('doctor')
  confirm(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.confirmVerbal(id, u, auditCtx(r)); }
  @Post('inpatient/orders/:id/approve') @HttpCode(200) @Roles('doctor', 'pharmacist')
  approve(@Param('id', ParseUUIDPipe) id: string, @Body() d: NoteDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.approval(id, true, d.note ?? null, u, auditCtx(r)); }
  @Post('inpatient/orders/:id/approve-reject') @HttpCode(200) @Roles('doctor', 'pharmacist')
  approveReject(@Param('id', ParseUUIDPipe) id: string, @Body() d: NoteDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.approval(id, false, d.note ?? null, u, auditCtx(r)); }
  @Get('pharmacy/verification') @Roles('pharmacist', 'admin', 'nurse')
  queue(@CurrentUser() u: AuthUser, @Query('status') status?: string, @Query('department_id') dep?: string) {
    return this.s.verificationQueue(status === 'done' ? 'done' : 'pending', u, dep && /^[0-9a-f-]{36}$/i.test(dep) ? dep : undefined);
  }
  @Post('pharmacy/verification/:id/verify') @HttpCode(200) @Roles('pharmacist', 'admin', 'nurse')
  verify(@Param('id', ParseUUIDPipe) id: string, @Body() d: VerifyDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.verify(id, true, d, u, auditCtx(r)); }
  @Post('pharmacy/verification/:id/reject') @HttpCode(200) @Roles('pharmacist', 'admin', 'nurse')
  reject(@Param('id', ParseUUIDPipe) id: string, @Body() d: VerifyDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.verify(id, false, d, u, auditCtx(r)); }
}

@Module({ imports: [InpatientModule, AllergiesModule, StockModule], providers: [OrdersService], controllers: [OrdersController], exports: [OrdersService] })
export class OrdersModule {}
