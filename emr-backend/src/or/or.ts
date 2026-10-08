import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, Module, NotFoundException, Param, ParseUUIDPipe,
  Patch, Post, Put, Query, Req } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min,
  ValidateIf, ValidateNested } from 'class-validator';
import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
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
import { OR_READ } from './or-admin';

type Trx = Transaction<DB>;
type Ex = Database | Trx;
const TZ = loadEnv().CLINIC_TZ;
const num = ({ value }: { value: unknown }) => (value === '' || value === null || value === undefined ? undefined : Number(value));

export interface OrSettings {
  or_scheduling: 'coordinator' | 'surgeon_self' | 'both'; anesthesia_team_by: 'anesthesia_head' | 'surgeon'; preop_readiness: 'warn' | 'block';
  turnover_min: number; default_duration_min: number; self_booking_days: number; notify_requests: boolean;
}
export const ANESTHESIA = ['general', 'spinal', 'epidural', 'combined', 'regional', 'sedation', 'local', 'none'] as const;
export const ANESTHESIA_KA: Record<string, string> = { general: 'ზოგადი', spinal: 'სპინალური', epidural: 'ეპიდურული', combined: 'კომბინირებული (სპინ.-ეპიდ.)',
  regional: 'რეგიონული (ბლოკადა)', sedation: 'სედაცია', local: 'ადგილობრივი', none: 'ანესთეზიის გარეშე' };
const NO_ANESTHESIOLOGIST = ['local', 'none'];
export const URGENCY_KA: Record<string, string> = { elective: 'გეგმიური', urgent: 'სასწრაფო', emergency: 'გადაუდებელი' };
export const STATUS_KA: Record<string, string> = { requested: 'მოთხოვნა', tentative: 'დასადასტურებელი', scheduled: 'დაგეგმილი', in_progress: 'მიმდინარე', completed: 'დასრულებული', cancelled: 'გაუქმებული' };
export const TIME_KINDS = ['in_room', 'anesthesia_start', 'incision', 'closure', 'anesthesia_end', 'out_of_room', 'pacu_in', 'pacu_out'] as const;
type TimeKind = (typeof TIME_KINDS)[number];
export const TIME_KA: Record<TimeKind, string> = { in_room: 'საოპერაციოში შემოვიდა', anesthesia_start: 'ანესთეზიის დაწყება', incision: 'განაკვეთი', closure: 'ნაკერი',
  anesthesia_end: 'ანესთეზიის დასრულება', out_of_room: 'საოპერაციოდან გავიდა', pacu_in: 'PACU — შემოსვლა', pacu_out: 'PACU — გასვლა' };
/** ნიშნულის წინაპირობა: რომელი უნდა იყოს უკვე დაფიქსირებული */
const TIME_NEEDS: Record<TimeKind, TimeKind[]> = { in_room: [], anesthesia_start: ['in_room'], incision: ['in_room'], closure: ['incision'], anesthesia_end: ['anesthesia_start'],
  out_of_room: ['in_room'], pacu_in: ['out_of_room'], pacu_out: ['pacu_in'] };
const WHO_KA: Record<string, string> = { sign_in: 'Sign in', time_out: 'Time out', sign_out: 'Sign out' };
const ACTIVE = ['tentative', 'scheduled', 'in_progress'] as const;

// ================================================================= DTO
export class CaseProcDto {
  @IsUUID() procedure_id: string;
  @IsOptional() @IsIn(['left', 'right', 'bilateral', 'na']) side?: 'left' | 'right' | 'bilateral' | 'na';
  @IsOptional() @IsBoolean() is_primary?: boolean;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}
export class CaseDto {
  @IsOptional() @IsUUID() encounter_id?: string;
  @IsOptional() @IsUUID() planned_id?: string;
  @IsOptional() @IsUUID() surgeon_id?: string;
  @IsOptional() @IsIn(['elective', 'urgent', 'emergency']) urgency?: 'elective' | 'urgent' | 'emergency';
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @Length(2, 10) icd10_code?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @Matches(/^\d{4}-\d{2}-\d{2}$/) preferred_date?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @Matches(/^([01]\d|2[0-3]):[0-5]\d$/) preferred_time?: string | null;
  @IsOptional() @Transform(num) @IsInt() @Min(5) @Max(1440) duration_min?: number;
  @IsOptional() @IsIn(ANESTHESIA) anesthesia_type?: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() preferred_anesthesiologist_id?: string | null;
  @IsOptional() @IsBoolean() needs_implant?: boolean;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(500) needs_equipment?: string | null;
  @IsOptional() @IsBoolean() needs_blood?: boolean;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(500) blood_note?: string | null;
  @IsOptional() @IsBoolean() needs_icu?: boolean;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(2000) notes?: string | null;
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => CaseProcDto) procedures?: CaseProcDto[];
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
export class ScheduleDto {
  @IsUUID() room_id: string;
  @IsDateString() start: string;
  @IsOptional() @Transform(num) @IsInt() @Min(5) @Max(1440) duration_min?: number;
  @IsOptional() @IsBoolean() confirm?: boolean;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
export class ReasonDto { @IsString() @Length(3, 1000) reason: string }
export class CancelDto { @IsString() @Length(2, 30) reason_code: string; @IsOptional() @IsString() @MaxLength(1000) note?: string }
export class SurgeonDto { @IsUUID() surgeon_id: string; @IsString() @Length(3, 500) reason: string }
export class TeamDto {
  @IsString() @Length(2, 30) role_code: string;
  @IsUUID() user_id: string;
  @IsOptional() @IsDateString() at?: string;                  // დაწყების შემდეგ — შემოსვლის დრო
  @IsOptional() @IsUUID() replaces_id?: string;              // ვის ცვლის (გუნდის ჩანაწერი)
  @IsOptional() @IsBoolean() confirm?: boolean;
}
export class TeamRemoveDto { @IsOptional() @IsDateString() at?: string; @IsOptional() @IsString() @MaxLength(500) reason?: string }
export class PreopDto {
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) @Max(6) asa_class?: number | null;
  @IsOptional() @IsBoolean() asa_emergency?: boolean;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) @Max(4) mallampati?: number | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @Transform(num) @IsNumber({ maxDecimalPlaces: 1 }) @Min(0.3) @Max(400) weight_kg?: number | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @Transform(num) @IsNumber({ maxDecimalPlaces: 1 }) @Min(20) @Max(250) height_cm?: number | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString() fasting_solids_at?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString() fasting_liquids_at?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(2000) airway_notes?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(4000) comorbidities?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(13) @IsIn(['difficult_airway', 'aspiration', 'cardiac', 'pulmonary', 'renal', 'hepatic', 'diabetes', 'obesity', 'bleeding', 'ponv',
    'malignant_hyperthermia', 'allergy', 'other'], { each: true }) risks?: string[];
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(4000) risk_notes?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsIn(ANESTHESIA) planned_anesthesia?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(4000) plan_notes?: string | null;
}
export class ReadinessDto { @IsUUID() item_id: string; @IsIn(['yes', 'no', 'na']) answer: 'yes' | 'no' | 'na'; @IsOptional() @IsString() @MaxLength(500) note?: string }
export class WhoDto {
  @IsIn(['sign_in', 'time_out', 'sign_out']) phase: 'sign_in' | 'time_out' | 'sign_out';
  @IsObject() answers: Record<string, 'yes' | 'no' | 'na'>;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
}
export class TimeDto {
  @IsIn(TIME_KINDS) kind: TimeKind;
  @IsOptional() @IsDateString() at?: string;
  @IsOptional() @IsIn(['ward', 'icu', 'pacu', 'other']) destination?: 'ward' | 'icu' | 'pacu' | 'other';
  @IsOptional() @IsString() @Length(3, 500) correction_reason?: string;
  @IsOptional() @IsString() @Length(3, 1000) readiness_override?: string;
}
export class ListQuery {
  @IsOptional() @IsUUID() encounter_id?: string;
  @IsOptional() @IsUUID() patient_id?: string;
  @IsOptional() @IsIn(['requested', 'tentative', 'scheduled', 'in_progress', 'completed', 'cancelled', 'open']) status?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) from?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) to?: string;
}
export class BoardQuery {
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) date?: string;
  @IsOptional() @Transform(num) @IsIn([1, 7]) days?: 1 | 7;
  @IsOptional() @IsUUID() block_id?: string;
}

type CaseRow = Awaited<ReturnType<OrService['loadCase']>>;
interface Readiness { items: { id: string; label: string; source: string; applies: string; answer: 'yes' | 'no' | 'na' | 'pending'; auto: boolean; note: string | null; checked_by_name: string | null; checked_at: string | Date | null }[]; ready: boolean; missing: string[] }

/**
 * საოპერაციო ბლოკი — დაგეგმვა (0048).
 *  მოთხოვნა — ექიმი (საკუთარ თავზე; განყოფილების ხელმძღვანელი / admin — სხვა ქირურგზეც); ჰოსპიტალიზაციიდან ან გეგმიური რიგიდან.
 *  დაგეგმვა — or_scheduling: coordinator (or_schedule) / surgeon_self (ქირურგი — თავისუფალ სლოტზე) / both (ქირურგი → დასადასტურებელი);
 *    გადაუდებელი — ქირურგი / ხელმძღვანელი პირდაპირ (რიგს გვერდს უვლის), გადაფარვა — გაფრთხილებით.
 *  გუნდი — ოპერატორი ქირურგი (საკუთარი), განყოფილების ხელმძღვანელი (ყველა, ოპერატორის შეცვლაც), admin; ანესთეზიის ნაწილი — anesthesia_team_by.
 *  წინასაოპერაციო: გასინჯვა — ანესთეზიოლოგი; მზადყოფნა (preop_readiness: warn — დასაბუთებით / block) — „საოპერაციოში შემოსვლისას“.
 *  WHO / ნიშნულები — გუნდის წევრი, საოპერაციო ექთანი, ანესთეზიოლოგი, admin.
 */
@Injectable()
export class OrService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService, private readonly modules: ModulesService,
              private readonly bell: NotificationsService) {}

  settings() { return this.modules.require<OrSettings>('or'); }
  private me(u: AuthUser, ex: Ex = this.db) { return ex.selectFrom('users').select(['id', 'department_id', 'is_section_head']).where('id', '=', u.id).executeTakeFirstOrThrow(); }
  private async isHeadOf(u: AuthUser, departmentId: string, ex: Ex = this.db) { const m = await this.me(u, ex); return !!m.is_section_head && m.department_id === departmentId; }
  private async nextNo(trx: Trx) {
    const year = Number((await sql<{ y: string }>`SELECT to_char(now() AT TIME ZONE ${TZ}, 'YYYY') AS y`.execute(trx)).rows[0].y);
    const { last_value } = await trx.insertInto('document_counters').values({ document_type: 'or_case', year, last_value: 1 })
      .onConflict((oc) => oc.columns(['document_type', 'year']).doUpdateSet({ last_value: sql`document_counters.last_value + 1` })).returning('last_value').executeTakeFirstOrThrow();
    return `OR${String(year).slice(2)}-${String(last_value).padStart(6, '0')}`;
  }
  private async event(ex: Ex, c: { id: string; encounter_id: string | null; planned_id?: string | null }, kind: string, data: Record<string, unknown>, u: AuthUser | null, ipd?: string) {
    await ex.insertInto('or_case_events').values({ case_id: c.id, kind, data: JSON.stringify(data), user_id: u?.id ?? null }).execute();
    if (ipd && (c.encounter_id || c.planned_id)) {
      await ex.insertInto('inpatient_events').values({ encounter_id: c.encounter_id, planned_id: c.encounter_id ? null : c.planned_id ?? null, kind: ipd,
        data: JSON.stringify({ case_id: c.id, ...data }), user_id: u?.id ?? null }).execute();
    }
  }
  private async userHas(userId: string, caps: string[], ex: Ex = this.db) {
    const r = await ex.selectFrom('users as x').select(['x.id', 'x.first_name', 'x.last_name', 'x.is_active', 'x.department_id',
      sql<string[]>`coalesce((SELECT c.capabilities FROM user_capabilities c WHERE c.user_id = x.id), '{}')`.as('caps')]).where('x.id', '=', userId).executeTakeFirst();
    if (!r || !r.is_active) return null;
    return caps.some((c) => r.caps.includes(c)) ? r : null;
  }

  // ================================================================= წაკითხვა
  async loadCase(id: string, ex: Ex = this.db, lock = false) {
    let q = ex.selectFrom('or_cases').selectAll().where('id', '=', id);
    if (lock) q = q.forUpdate();
    const c = await q.executeTakeFirst();
    if (!c) throw new NotFoundException('ოპერაცია ვერ მოიძებნა');
    return c;
  }
  private async stayActive(encounterId: string | null, ex: Ex = this.db) {
    if (!encounterId) return false;
    return !!(await ex.selectFrom('inpatient_stays').select('status').where('encounter_id', '=', encounterId).where('status', '=', 'active').executeTakeFirst());
  }

  /** უფლებები ოპერაციაზე (UI-სთვისაც) */
  async perms(u: AuthUser, c: CaseRow, s: OrSettings, ex: Ex = this.db) {
    const admin = has(u, 'admin');
    const me = await this.me(u, ex);
    const head = !!me.is_section_head && me.department_id === c.department_id;
    const depNurse = has(u, 'nurse') && me.department_id === c.department_id;
    const own = c.surgeon_id === u.id;
    const edit = admin || own || head;
    const coord = admin || has(u, 'or_schedule');
    const inTeam = !!(await ex.selectFrom('or_case_team').select('id').where('case_id', '=', c.id).where('user_id', '=', u.id).where('removed_at', 'is', null).executeTakeFirst());
    const anesthHead = has(u, 'anesthesiologist') && !!me.is_section_head;
    const open = !['completed', 'cancelled', 'in_progress'].includes(c.status);
    return {
      edit: edit && open,
      schedule: open && (coord || ((own || head) && (c.urgency === 'emergency' || s.or_scheduling !== 'coordinator'))),
      confirm: c.status === 'tentative' && coord,
      cancel: open && (edit || coord),
      surgeon: open && (admin || head),
      team_surgical: c.status !== 'cancelled' && !c.locked_at && edit,
      team_anesthesia: c.status !== 'cancelled' && !c.locked_at && (s.anesthesia_team_by === 'anesthesia_head' ? (admin || anesthHead) : edit),
      preop: c.status !== 'cancelled' && (admin || has(u, 'anesthesiologist')),
      readiness: c.status !== 'cancelled' && c.status !== 'completed' && (edit || has(u, 'or_nurse', 'anesthesiologist') || depNurse),
      periop: !['requested', 'cancelled'].includes(c.status) && !c.locked_at && (admin || inTeam || own || has(u, 'or_nurse', 'anesthesiologist')),
    };
  }

  private async procedures(caseId: string, ex: Ex = this.db) {
    return ex.selectFrom('or_case_procedures as cp').innerJoin('or_procedures as p', 'p.id', 'cp.procedure_id')
      .select(['cp.id', 'cp.procedure_id', 'cp.side', 'cp.is_primary', 'cp.note', 'cp.sort_order', 'p.code', 'p.name', 'p.ncsp_code', 'p.specialty_code', 'p.laterality', 'p.default_duration_min'])
      .where('cp.case_id', '=', caseId).orderBy('cp.is_primary', 'desc').orderBy('cp.sort_order').execute();
  }
  private team(caseId: string, ex: Ex = this.db) {
    return ex.selectFrom('or_case_team as t').innerJoin('users as x', 'x.id', 't.user_id').innerJoin('or_team_roles as r', 'r.code', 't.role_code')
      .leftJoin('users as ab', 'ab.id', 't.added_by')
      .select(['t.id', 't.role_code', 'r.name as role_name', 'r.grp', 't.user_id', sql<string>`x.last_name || ' ' || x.first_name`.as('name'), 't.added_at', 't.in_at', 't.out_at',
        't.replaced_by', 't.removed_at', 't.remove_reason', sql<string>`ab.last_name || ' ' || ab.first_name`.as('added_by_name')])
      .where('t.case_id', '=', caseId).orderBy('r.sort_order').orderBy('t.added_at').execute();
  }
  private times(caseId: string, ex: Ex = this.db) {
    return ex.selectFrom('or_case_times as t').innerJoin('users as x', 'x.id', 't.recorded_by')
      .select(['t.id', 't.kind', 't.at', 't.destination', 't.created_at', 't.correction_reason', 't.superseded_by', sql<string>`x.last_name || ' ' || x.first_name`.as('by_name')])
      .where('t.case_id', '=', caseId).orderBy('t.at').orderBy('t.created_at').execute();
  }
  private async currentTimes(caseId: string, ex: Ex = this.db) {
    const rows = await ex.selectFrom('or_case_times').select(['id', 'kind', 'at']).where('case_id', '=', caseId).where('superseded_by', 'is', null).execute();
    return new Map(rows.map((r) => [r.kind as TimeKind, { id: r.id, at: new Date(r.at) }]));
  }
  private whoList(caseId: string, ex: Ex = this.db) {
    return ex.selectFrom('or_who_checks as w').innerJoin('users as x', 'x.id', 'w.done_by')
      .select(['w.id', 'w.phase', 'w.answers', 'w.note', 'w.done_at', 'w.voided_at', 'w.void_reason', sql<string>`x.last_name || ' ' || x.first_name`.as('by_name')])
      .where('w.case_id', '=', caseId).orderBy('w.done_at').execute();
  }

  /** მზადყოფნის ჩეკლისტის შეფასება: ავტომატური (თანხმობა / გასინჯვა) + ხელით */
  async readiness(c: CaseRow, ex: Ex = this.db): Promise<Readiness> {
    const [items, answers, procs, consents, preop] = await Promise.all([
      ex.selectFrom('or_readiness_items').selectAll().where('is_active', '=', true).orderBy('sort_order').execute(),
      ex.selectFrom('or_case_readiness as r').leftJoin('users as x', 'x.id', 'r.checked_by').select(['r.item_id', 'r.answer', 'r.note', 'r.checked_at',
        sql<string>`x.last_name || ' ' || x.first_name`.as('by_name')]).where('r.case_id', '=', c.id).execute(),
      ex.selectFrom('or_case_procedures as cp').innerJoin('or_procedures as p', 'p.id', 'cp.procedure_id').select(['cp.side', 'p.laterality']).where('cp.case_id', '=', c.id).execute(),
      c.encounter_id ? ex.selectFrom('patient_consents').select(['type_code']).where('encounter_id', '=', c.encounter_id).where('type_code', 'in', ['OR_SURGERY', 'OR_ANESTHESIA'])
        .where('decision', '=', 'granted').where('revoked_at', 'is', null).execute() : Promise.resolve([] as { type_code: string }[]),
      ex.selectFrom('or_preop_assessments').select(['status']).where('case_id', '=', c.id).where('voided_at', 'is', null).executeTakeFirst(),
    ]);
    const anesth = !NO_ANESTHESIOLOGIST.includes(c.anesthesia_type);
    const applies = (a: string) => a === 'always' || (a === 'anesthesia' && anesth) || (a === 'laterality' && procs.some((p) => p.laterality || p.side !== 'na'))
      || (a === 'blood' && c.needs_blood) || (a === 'implant' && (c.needs_implant || !!c.needs_equipment?.trim()));
    const ans = new Map(answers.map((a) => [a.item_id, a]));
    const out: Readiness['items'] = items.map((i) => {
      const a = ans.get(i.id);
      const auto = i.source !== 'manual';
      let answer: Readiness['items'][number]['answer'] = !applies(i.applies) ? 'na' : 'pending';
      if (answer !== 'na') {
        if (i.source === 'consent_surgery') answer = consents.some((x) => x.type_code === 'OR_SURGERY') ? 'yes' : 'no';
        else if (i.source === 'consent_anesthesia') answer = consents.some((x) => x.type_code === 'OR_ANESTHESIA') ? 'yes' : 'no';
        else if (i.source === 'assessment') answer = preop?.status === 'signed' ? 'yes' : 'no';
        else answer = (a?.answer as 'yes' | 'no' | 'na' | undefined) ?? 'pending';
      }
      return { id: i.id, label: i.label, source: i.source, applies: i.applies, answer, auto, note: a?.note ?? null, checked_by_name: auto ? null : a?.by_name ?? null, checked_at: auto ? null : a?.checked_at ?? null };
    });
    const missing = out.filter((i) => i.answer === 'no' || i.answer === 'pending').map((i) => i.label);
    return { items: out, ready: !missing.length, missing };
  }

  async detail(id: string, u: AuthUser) {
    const s = await this.settings();
    const c = await this.loadCase(id);
    const [head, procs, team, times, who, preop, events, readiness, perms, whoItems] = await Promise.all([
      this.db.selectFrom('or_cases as c').innerJoin('patients as p', 'p.id', 'c.patient_id').innerJoin('departments as d', 'd.id', 'c.department_id')
        .innerJoin('users as su', 'su.id', 'c.surgeon_id').innerJoin('users as rq', 'rq.id', 'c.requested_by')
        .leftJoin('or_rooms as r', 'r.id', 'c.room_id').leftJoin('departments as b', 'b.id', 'c.block_id').leftJoin('users as sb', 'sb.id', 'c.scheduled_by')
        .leftJoin('users as pa', 'pa.id', 'c.preferred_anesthesiologist_id').leftJoin('inpatient_stays as st', 'st.encounter_id', 'c.encounter_id')
        .leftJoin('inpatient_planned as pl', 'pl.id', 'c.planned_id').leftJoin('or_cancel_reasons as cr', 'cr.code', 'c.cancel_reason_code')
        .select(['p.first_name', 'p.last_name', 'p.personal_number', 'p.birth_date', 'p.gender', 'd.name as department_name', 'r.code as room_code', 'r.name as room_name',
          'b.name as block_name', 'st.adm_no', 'st.status as stay_status', 'pl.plan_no', 'pl.planned_date', 'pl.status as planned_status', 'cr.name as cancel_reason_name',
          sql<string>`su.last_name || ' ' || su.first_name`.as('surgeon_name'), sql<string>`rq.last_name || ' ' || rq.first_name`.as('requested_by_name'),
          sql<string | null>`sb.last_name || ' ' || sb.first_name`.as('scheduled_by_name'), sql<string | null>`pa.last_name || ' ' || pa.first_name`.as('preferred_anesthesiologist_name'),
          sql<number>`date_part('year', age(p.birth_date))::int`.as('age')])
        .where('c.id', '=', id).executeTakeFirstOrThrow(),
      this.procedures(id), this.team(id), this.times(id), this.whoList(id),
      this.db.selectFrom('or_preop_assessments as a').leftJoin('users as cb', 'cb.id', 'a.created_by').leftJoin('users as sg', 'sg.id', 'a.signed_by').selectAll('a')
        .select([sql<string>`cb.last_name || ' ' || cb.first_name`.as('created_by_name'), sql<string | null>`sg.last_name || ' ' || sg.first_name`.as('signed_by_name')])
        .where('a.case_id', '=', id).orderBy('a.created_at', 'desc').execute(),
      this.db.selectFrom('or_case_events as e').leftJoin('users as x', 'x.id', 'e.user_id').select(['e.id', 'e.kind', 'e.data', 'e.at', sql<string | null>`x.last_name || ' ' || x.first_name`.as('user_name')])
        .where('e.case_id', '=', id).orderBy('e.at', 'desc').orderBy('e.id', 'desc').execute(),
      this.readiness(c), this.perms(u, c, s),
      this.db.selectFrom('or_who_items').select(['id', 'phase', 'label', 'sort_order']).where('is_active', '=', true).orderBy('phase').orderBy('sort_order').execute(),
    ]);
    const allergies = await this.db.selectFrom('patient_allergies').select(['substance', 'severity', 'allergy_type']).where('patient_id', '=', c.patient_id).where('is_active', '=', true).execute();
    const warnings: string[] = [];
    if (!c.encounter_id && c.planned_id && head.planned_status === 'cancelled') warnings.push('გეგმიური ჰოსპიტალიზაცია გაუქმებულია — მოთხოვნა საჭიროებს გადახედვას');
    if (!c.encounter_id && ACTIVE.includes(c.status as never)) warnings.push('პაციენტი ჯერ არ არის ჰოსპიტალიზებული — ოპერაცია ჰოსპიტალიზაციამდე ვერ დაიწყება');
    if (c.encounter_id && head.stay_status !== 'active' && ACTIVE.includes(c.status as never)) warnings.push('ჰოსპიტალიზაცია დასრულებულია / გაუქმებულია');
    return { ...c, ...head, procedures: procs, team, times, who, who_items: whoItems, preop, events, readiness, allergies, can: perms, settings: s, warnings };
  }

  async list(q: ListQuery, u: AuthUser) {
    await this.settings();
    let x = this.baseList().orderBy(sql`coalesce(c.scheduled_start, c.requested_at)`, 'desc').limit(300);
    if (q.encounter_id) x = x.where('c.encounter_id', '=', q.encounter_id);
    if (q.patient_id) x = x.where('c.patient_id', '=', q.patient_id);
    if (q.status === 'open') x = x.where('c.status', 'in', ['requested', ...ACTIVE]);
    else if (q.status) x = x.where('c.status', '=', q.status);
    if (q.from) x = x.where(sql<boolean>`coalesce(c.scheduled_start, c.requested_at) >= (${q.from}::date::timestamp AT TIME ZONE ${TZ})`);
    if (q.to) x = x.where(sql<boolean>`coalesce(c.scheduled_start, c.requested_at) < ((${q.to}::date + 1)::timestamp AT TIME ZONE ${TZ})`);
    void u;
    return x.execute();
  }

  private baseList(ex: Ex = this.db) {
    return ex.selectFrom('or_cases as c').innerJoin('patients as p', 'p.id', 'c.patient_id').innerJoin('users as su', 'su.id', 'c.surgeon_id')
      .innerJoin('departments as d', 'd.id', 'c.department_id').leftJoin('or_rooms as r', 'r.id', 'c.room_id')
      .select(['c.id', 'c.case_no', 'c.status', 'c.urgency', 'c.patient_id', 'c.encounter_id', 'c.planned_id', 'c.department_id', 'c.surgeon_id', 'c.room_id', 'c.block_id',
        'c.scheduled_start', 'c.scheduled_end', 'c.duration_min', 'c.anesthesia_type', 'c.preferred_date', 'c.preferred_time', 'c.requested_at', 'c.needs_blood', 'c.needs_implant',
        'c.needs_icu', 'c.icd10_code', 'c.icd10_title', 'c.postpone_count', 'c.cancel_reason_code', 'c.locked_at',
        'p.first_name', 'p.last_name', 'p.gender', sql<number>`date_part('year', age(p.birth_date))::int`.as('age'), 'd.name as department_name', 'r.code as room_code', 'r.name as room_name',
        sql<string>`su.last_name || ' ' || su.first_name`.as('surgeon_name'),
        sql<string>`(SELECT string_agg(pr.name || CASE cp.side WHEN 'left' THEN ' (მარცხ.)' WHEN 'right' THEN ' (მარჯვ.)' WHEN 'bilateral' THEN ' (ორმხრ.)' ELSE '' END, '; ' ORDER BY cp.is_primary DESC, cp.sort_order)
                     FROM or_case_procedures cp JOIN or_procedures pr ON pr.id = cp.procedure_id WHERE cp.case_id = c.id)`.as('procedures'),
        sql<string | null>`(SELECT x.last_name || ' ' || x.first_name FROM or_case_team t JOIN users x ON x.id = t.user_id
                             WHERE t.case_id = c.id AND t.role_code = 'anesthesiologist' AND t.removed_at IS NULL AND t.out_at IS NULL ORDER BY t.added_at DESC LIMIT 1)`.as('anesthesiologist_name'),
        sql<string | null>`(SELECT t.kind FROM or_case_times t WHERE t.case_id = c.id AND t.superseded_by IS NULL
                             ORDER BY array_position(ARRAY['in_room','anesthesia_start','incision','closure','anesthesia_end','out_of_room','pacu_in','pacu_out']::text[], t.kind::text) DESC LIMIT 1)`.as('phase'),
        sql<string | null>`(SELECT t.at FROM or_case_times t WHERE t.case_id = c.id AND t.superseded_by IS NULL AND t.kind = 'in_room')`.as('actual_start'),
        sql<string | null>`(SELECT t.at FROM or_case_times t WHERE t.case_id = c.id AND t.superseded_by IS NULL AND t.kind = 'out_of_room')`.as('actual_end'),
        sql<string[]>`ARRAY(SELECT w.phase FROM or_who_checks w WHERE w.case_id = c.id AND w.voided_at IS NULL)`.as('who_done')]);
  }

  // ================================================================= მოთხოვნა
  /** ოპერაციის წყაროები პაციენტზე: აქტიური ჰოსპიტალიზაცია + გეგმიური რიგის ჩანაწერები */
  async sources(patientId: string) {
    const [stays, planned] = await Promise.all([
      this.db.selectFrom('inpatient_stays as s').innerJoin('bed_assignments as a', (j) => j.onRef('a.encounter_id', '=', 's.encounter_id').on('a.ended_at', 'is', null))
        .innerJoin('departments as d', 'd.id', 'a.department_id').select(['s.encounter_id', 's.adm_no', 's.admitted_at', 'd.id as department_id', 'd.name as department_name'])
        .where('s.patient_id', '=', patientId).where('s.status', '=', 'active').execute(),
      this.db.selectFrom('inpatient_planned as pl').innerJoin('departments as d', 'd.id', 'pl.department_id')
        .select(['pl.id as planned_id', 'pl.plan_no', 'pl.planned_date', 'pl.reason', 'd.id as department_id', 'd.name as department_name', 'pl.icd10_code', 'pl.icd10_title'])
        .where('pl.patient_id', '=', patientId).where('pl.status', '=', 'waiting').orderBy('pl.planned_date').execute(),
    ]);
    return { stays, planned };
  }

  private async validateProcs(ex: Ex, list: CaseProcDto[]) {
    const ids = [...new Set(list.map((p) => p.procedure_id))];
    if (ids.length !== list.length) throw new BadRequestException('პროცედურა მეორდება');
    const rows = await ex.selectFrom('or_procedures').select(['id', 'name', 'is_active', 'laterality', 'default_duration_min']).where('id', 'in', ids).execute();
    const map = new Map(rows.map((r) => [r.id, r]));
    for (const p of list) {
      const r = map.get(p.procedure_id);
      if (!r || !r.is_active) throw new BadRequestException('პროცედურა ვერ მოიძებნა კატალოგში ან გათიშულია');
      if (r.laterality && (!p.side || p.side === 'na')) throw new BadRequestException(`„${r.name}“ — მიუთითეთ მხარე (მარცხ. / მარჯვ. / ორმხრივი)`);
    }
    const prim = list.filter((p) => p.is_primary).length;
    if (prim > 1) throw new BadRequestException('ძირითადი პროცედურა მხოლოდ ერთია');
    return { duration: list.reduce((a, p) => a + (map.get(p.procedure_id)?.default_duration_min ?? 0), 0) };
  }
  private async writeProcs(trx: Trx, caseId: string, list: CaseProcDto[]) {
    await trx.deleteFrom('or_case_procedures').where('case_id', '=', caseId).execute();
    const primIdx = Math.max(0, list.findIndex((p) => p.is_primary));
    await trx.insertInto('or_case_procedures').values(list.map((p, i) => ({ case_id: caseId, procedure_id: p.procedure_id, side: p.side ?? 'na', is_primary: i === primIdx,
      sort_order: i, note: p.note?.trim() || null }))).execute();
  }
  private async icd(code: string, ex: Ex) {
    const c = await ex.selectFrom('icd10_codes').select(['code', 'title', 'is_active']).where('code', '=', code.trim().toUpperCase()).executeTakeFirst();
    if (!c || !c.is_active) throw new BadRequestException(`ICD-10 კოდი ${code} კლასიფიკატორში არ არსებობს`);
    return c;
  }

  async create(dto: CaseDto, u: AuthUser, ctx: AuditContext) {
    const s = await this.settings();
    if (!!dto.encounter_id === !!dto.planned_id) throw new BadRequestException('მიუთითეთ ჰოსპიტალიზაცია ან გეგმიური რიგის ჩანაწერი (ერთ-ერთი)');
    if (!dto.procedures?.length) throw new BadRequestException('მიუთითეთ მინიმუმ ერთი პროცედურა');
    if (!dto.anesthesia_type) throw new BadRequestException('მიუთითეთ ანესთეზიის ტიპი');
    if (!has(u, 'admin', 'doctor')) throw new ForbiddenException('ოპერაციის მოთხოვნა — მხოლოდ ექიმი');
    const res = await this.db.transaction().execute(async (trx) => {
      let patientId: string; let departmentId: string; let icdDefault: { code: string; title: string } | null = null;
      if (dto.encounter_id) {
        const st = await trx.selectFrom('inpatient_stays as s').innerJoin('bed_assignments as a', (j) => j.onRef('a.encounter_id', '=', 's.encounter_id').on('a.ended_at', 'is', null))
          .select(['s.patient_id', 's.status', 'a.department_id']).where('s.encounter_id', '=', dto.encounter_id).executeTakeFirst();
        if (!st || st.status !== 'active') throw new BadRequestException('აქტიური ჰოსპიტალიზაცია ვერ მოიძებნა');
        patientId = st.patient_id; departmentId = st.department_id;
        const dx = await trx.selectFrom('encounter_diagnoses').select(['icd10_code', 'icd10_title']).where('encounter_id', '=', dto.encounter_id)
          .orderBy(sql`CASE diagnosis_type WHEN 'primary' THEN 0 WHEN 'admission' THEN 1 ELSE 2 END`).limit(1).executeTakeFirst();
        if (dx?.icd10_code) icdDefault = { code: dx.icd10_code, title: dx.icd10_title ?? '' };
      } else {
        const pl = await trx.selectFrom('inpatient_planned').select(['patient_id', 'status', 'department_id', 'icd10_code', 'icd10_title']).where('id', '=', dto.planned_id!).executeTakeFirst();
        if (!pl || pl.status !== 'waiting') throw new BadRequestException('გეგმიური რიგის ჩანაწერი ვერ მოიძებნა ან უკვე დამუშავებულია');
        patientId = pl.patient_id; departmentId = pl.department_id;
        if (pl.icd10_code) icdDefault = { code: pl.icd10_code, title: pl.icd10_title ?? '' };
      }
      const surgeonId = dto.surgeon_id ?? u.id;
      if (surgeonId !== u.id && !has(u, 'admin') && !(await this.isHeadOf(u, departmentId, trx))) throw new ForbiddenException('სხვა ქირურგზე მოთხოვნა — მხოლოდ განყოფილების ხელმძღვანელი / admin');
      if (!(await this.userHas(surgeonId, ['doctor'], trx))) throw new BadRequestException('ოპერატორი ქირურგი ვერ მოიძებნა (აქტიური ექიმი)');
      if (dto.preferred_anesthesiologist_id && !(await this.userHas(dto.preferred_anesthesiologist_id, ['anesthesiologist'], trx))) throw new BadRequestException('ანესთეზიოლოგი ვერ მოიძებნა');
      const pr = await this.validateProcs(trx, dto.procedures!);
      const icd = dto.icd10_code ? await this.icd(dto.icd10_code, trx) : icdDefault;
      const no = await this.nextNo(trx);
      const c = await trx.insertInto('or_cases').values({
        case_no: no, patient_id: patientId, encounter_id: dto.encounter_id ?? null, planned_id: dto.planned_id ?? null, department_id: departmentId, surgeon_id: surgeonId,
        requested_by: u.id, urgency: dto.urgency ?? 'elective', icd10_code: icd?.code ?? null, icd10_title: icd?.title || null,
        preferred_date: dto.preferred_date ?? null, preferred_time: dto.preferred_time ?? null, duration_min: dto.duration_min ?? (pr.duration || s.default_duration_min),
        anesthesia_type: dto.anesthesia_type!, preferred_anesthesiologist_id: dto.preferred_anesthesiologist_id ?? null, needs_implant: dto.needs_implant ?? false,
        needs_equipment: dto.needs_equipment?.trim() || null, needs_blood: dto.needs_blood ?? false, blood_note: dto.blood_note?.trim() || null, needs_icu: dto.needs_icu ?? false,
        notes: dto.notes?.trim() || null, updated_by: u.id,
      }).returningAll().executeTakeFirstOrThrow();
      await this.writeProcs(trx, c.id, dto.procedures!);
      await trx.insertInto('or_case_team').values({ case_id: c.id, role_code: 'surgeon', user_id: surgeonId, added_by: u.id }).execute();
      await this.event(trx, c, 'requested', { urgency: c.urgency }, u, 'or_requested');
      await this.audit.log(ctx, { action: 'OR_REQUEST', entityName: 'or_cases', entityId: c.id, newData: dto }, trx);
      return c;
    });
    if (s.notify_requests) {
      const who = await this.db.selectFrom('user_capabilities as uc').innerJoin('users as x', 'x.id', 'uc.user_id').select('x.id')
        .where('x.is_active', '=', true).where(sql<boolean>`'or_schedule' = ANY(uc.capabilities)`).execute();
      for (const w of who) {
        if (w.id === u.id) continue;
        await this.bell.notify(w.id, { kind: 'or_request', title: `ოპერაციის ${URGENCY_KA[res.urgency].toLowerCase()} მოთხოვნა: ${res.case_no}`, link: `/or/case/${res.id}`, entityId: res.id,
          urgent: res.urgency === 'emergency' });
      }
    }
    return this.detail(res.id, u);
  }

  async update(id: string, dto: CaseDto, u: AuthUser, ctx: AuditContext) {
    const s = await this.settings();
    await this.db.transaction().execute(async (trx) => {
      const c = await this.loadCase(id, trx, true);
      const p = await this.perms(u, c, s, trx);
      if (!p.edit) throw new ForbiddenException('მოთხოვნის შეცვლა — ოპერატორი ქირურგი / განყოფილების ხელმძღვანელი / admin (დაწყებამდე)');
      if (dto.encounter_id !== undefined || dto.planned_id !== undefined || dto.surgeon_id !== undefined) throw new BadRequestException('წყარო / ქირურგი აქ არ იცვლება');
      if (dto.preferred_anesthesiologist_id && !(await this.userHas(dto.preferred_anesthesiologist_id, ['anesthesiologist'], trx))) throw new BadRequestException('ანესთეზიოლოგი ვერ მოიძებნა');
      if (dto.procedures) { await this.validateProcs(trx, dto.procedures); await this.writeProcs(trx, c.id, dto.procedures); }
      const icd = dto.icd10_code ? await this.icd(dto.icd10_code, trx) : undefined;
      const set = {
        ...(dto.urgency !== undefined && { urgency: dto.urgency }), ...(dto.icd10_code !== undefined && { icd10_code: icd?.code ?? null, icd10_title: icd?.title ?? null }),
        ...(dto.preferred_date !== undefined && { preferred_date: dto.preferred_date }), ...(dto.preferred_time !== undefined && { preferred_time: dto.preferred_time }),
        ...(dto.duration_min !== undefined && { duration_min: dto.duration_min }), ...(dto.anesthesia_type !== undefined && { anesthesia_type: dto.anesthesia_type }),
        ...(dto.preferred_anesthesiologist_id !== undefined && { preferred_anesthesiologist_id: dto.preferred_anesthesiologist_id }),
        ...(dto.needs_implant !== undefined && { needs_implant: dto.needs_implant }), ...(dto.needs_equipment !== undefined && { needs_equipment: dto.needs_equipment?.trim() || null }),
        ...(dto.needs_blood !== undefined && { needs_blood: dto.needs_blood }), ...(dto.blood_note !== undefined && { blood_note: dto.blood_note?.trim() || null }),
        ...(dto.needs_icu !== undefined && { needs_icu: dto.needs_icu }), ...(dto.notes !== undefined && { notes: dto.notes?.trim() || null }),
      };
      await trx.updateTable('or_cases').set({ ...set, updated_by: u.id }).where('id', '=', c.id).execute();
      const changed = [...Object.keys(set), ...(dto.procedures ? ['procedures'] : [])];
      await this.event(trx, c, 'updated', { fields: changed, reason: dto.reason ?? null }, u);
      await this.audit.log(ctx, { action: 'OR_UPDATE', entityName: 'or_cases', entityId: c.id, oldData: c, newData: dto }, trx);
    });
    return this.detail(id, u);
  }

  // ================================================================= დაგეგმვა
  /** გადაფარვები: ოთახი (turnover-ით) და გუნდის წევრები სხვა ოთახში */
  private async conflicts(ex: Ex, c: { id: string }, roomId: string, start: Date, end: Date, turnover: number, userIds: string[]) {
    const rng = sql`tstzrange(${start}::timestamptz, ${end}::timestamptz + make_interval(mins => ${turnover}), '[)')`;
    const room = await ex.selectFrom('or_cases').select(['id', 'case_no', 'scheduled_start', 'scheduled_end', 'urgency'])
      .where('room_id', '=', roomId).where('id', '<>', c.id).where('status', 'in', [...ACTIVE])
      .where(sql<boolean>`tstzrange(scheduled_start, scheduled_end + make_interval(mins => ${turnover}), '[)') && ${rng}`).execute();
    const people = userIds.length ? await ex.selectFrom('or_case_team as t').innerJoin('or_cases as o', 'o.id', 't.case_id').innerJoin('users as x', 'x.id', 't.user_id')
      .leftJoin('or_rooms as r', 'r.id', 'o.room_id')
      .select(['o.case_no', 'r.code as room_code', 't.user_id', sql<string>`x.last_name || ' ' || x.first_name`.as('name'), 'o.scheduled_start'])
      .where('t.user_id', 'in', userIds).where('t.removed_at', 'is', null).where('t.out_at', 'is', null).where('o.id', '<>', c.id).where('o.status', 'in', [...ACTIVE])
      .where(sql<boolean>`tstzrange(o.scheduled_start, o.scheduled_end, '[)') && tstzrange(${start}::timestamptz, ${end}::timestamptz, '[)')`).execute() : [];
    return { room, people };
  }
  private async workCheck(ex: Ex, room: { work_start: string; work_end: string; work_days: number[] }, start: Date, end: Date) {
    const r = (await sql<{ ds: string; de: string; ts: string; te: string; dow: number }>`SELECT (${start}::timestamptz AT TIME ZONE ${TZ})::date::text AS ds,
        (${end}::timestamptz AT TIME ZONE ${TZ})::date::text AS de, to_char(${start}::timestamptz AT TIME ZONE ${TZ}, 'HH24:MI') AS ts,
        to_char(${end}::timestamptz AT TIME ZONE ${TZ}, 'HH24:MI') AS te, extract(isodow FROM ${start}::timestamptz AT TIME ZONE ${TZ})::int AS dow`.execute(ex)).rows[0];
    const ws = room.work_start.slice(0, 5); const we = room.work_end.slice(0, 5);
    if (!room.work_days.includes(r.dow)) return 'ოთახის არასამუშაო დღეა';
    if (r.ds !== r.de || r.ts < ws || r.te > we) return `ოთახის სამუშაო საათების გარეთ (${ws}–${we})`;
    return null;
  }

  async schedule(id: string, dto: ScheduleDto, u: AuthUser, ctx: AuditContext, confirmOnly = false) {
    const s = await this.settings();
    const out = await this.db.transaction().execute(async (trx) => {
      const c = await this.loadCase(id, trx, true);
      if (!['requested', 'tentative', 'scheduled'].includes(c.status)) throw new ConflictException(`ოპერაცია ${STATUS_KA[c.status].toLowerCase()}ა — დაგეგმვა შეუძლებელია`);
      const coord = has(u, 'admin', 'or_schedule');
      const own = c.surgeon_id === u.id || (await this.isHeadOf(u, c.department_id, trx)) || has(u, 'admin');
      const emergency = c.urgency === 'emergency';
      let status: 'scheduled' | 'tentative';
      if (coord || (own && emergency)) status = 'scheduled';
      else if (own && s.or_scheduling === 'surgeon_self') status = 'scheduled';
      else if (own && s.or_scheduling === 'both') status = 'tentative';
      else throw new ForbiddenException(s.or_scheduling === 'coordinator' ? 'ოთახს / დროს ანიჭებს კოორდინატორი (ქირურგი — მოთხოვნა)' : 'დაგეგმვა — ოპერატორი ქირურგი, განყოფილების ხელმძღვანელი ან კოორდინატორი');
      if (confirmOnly && !coord) throw new ForbiddenException('დადასტურება — კოორდინატორი / ბლოკის უფროსი');
      const self = !coord && !emergency;                                   // ქირურგის ჯავშანი — მკაცრი წესები
      const room = await trx.selectFrom('or_rooms as r').innerJoin('departments as d', 'd.id', 'r.department_id')
        .select(['r.id', 'r.code', 'r.department_id', 'r.is_active', 'r.work_start', 'r.work_end', 'r.work_days', 'r.specialties', 'r.emergency_only', 'd.is_active as block_active'])
        .where('r.id', '=', dto.room_id).forUpdate('r').executeTakeFirst();
      if (!room || !room.is_active || !room.block_active) throw new BadRequestException('ოთახი ვერ მოიძებნა ან გათიშულია');
      const start = new Date(dto.start);
      const dur = dto.duration_min ?? (confirmOnly && c.scheduled_start ? Math.round((new Date(c.scheduled_end!).getTime() - new Date(c.scheduled_start).getTime()) / 60000) : c.duration_min);
      const end = new Date(start.getTime() + dur * 60_000);
      if (start.getTime() < Date.now() - 60 * 60_000) throw new BadRequestException('დაწყების დრო წარსულშია');
      if (self && start.getTime() > Date.now() + s.self_booking_days * 86_400_000) throw new BadRequestException(`ქირურგის ჯავშანი — მაქსიმუმ ${s.self_booking_days} დღით ადრე`);
      const warnings: string[] = [];
      const hard: string[] = [];
      const specs = (await trx.selectFrom('or_case_procedures as cp').innerJoin('or_procedures as p', 'p.id', 'cp.procedure_id').select('p.specialty_code')
        .where('cp.case_id', '=', c.id).execute()).map((x) => x.specialty_code).filter((x): x is string => !!x);
      if (room.specialties.length && specs.some((sp) => !room.specialties.includes(sp))) (self ? hard : warnings).push(`ოთახი ${room.code} ამ სპეციალობისთვის არ არის განკუთვნილი`);
      const wc = await this.workCheck(trx, { ...room, work_start: String(room.work_start), work_end: String(room.work_end) }, start, end);
      if (wc && !emergency) (self ? hard : warnings).push(wc);
      if (room.emergency_only && !emergency) (self ? hard : warnings).push(`ოთახი ${room.code} — გადაუდებელი ოპერაციებისთვის`);
      const team = (await trx.selectFrom('or_case_team').select('user_id').where('case_id', '=', c.id).where('removed_at', 'is', null).where('out_at', 'is', null).execute()).map((t) => t.user_id);
      const cf = await this.conflicts(trx, c, room.id, start, end, s.turnover_min, team);
      if (cf.room.length) {
        const msg = `ოთახი ${room.code} დაკავებულია: ${cf.room.map((x) => x.case_no).join(', ')} (მომზადების ${s.turnover_min} წთ-ის ჩათვლით)`;
        if (emergency) warnings.push(msg); else hard.push(msg);
      }
      for (const p of cf.people) warnings.push(`${p.name} ამავე დროს — ${p.case_no}${p.room_code ? ` (ოთახი ${p.room_code})` : ''}`);
      if (hard.length) throw new ConflictException({ code: 'SLOT_UNAVAILABLE', message: hard.join('; '), warnings: hard });
      if (warnings.length && !dto.confirm) throw new ConflictException({ code: 'CONFIRM_REQUIRED', message: warnings.join('; '), warnings });
      const kind = confirmOnly ? 'confirmed' : status === 'tentative' ? 'tentative' : c.status === 'scheduled' ? 'rescheduled' : 'scheduled';
      if (kind === 'rescheduled' && !coord && !dto.reason?.trim()) throw new BadRequestException('გადატანის მიზეზი სავალდებულოა');
      await trx.updateTable('or_cases').set({ status, room_id: room.id, block_id: room.department_id, scheduled_start: start, scheduled_end: end, scheduled_by: u.id, scheduled_at: sql`now()`,
        schedule_warnings: warnings.length ? warnings : null, updated_by: u.id }).where('id', '=', c.id).execute();
      await this.event(trx, c, kind, { room: room.code, start: start.toISOString(), end: end.toISOString(), warnings, reason: dto.reason ?? null,
        ...(c.scheduled_start && { from: c.scheduled_start }) }, u, status === 'scheduled' ? 'or_scheduled' : undefined);
      await this.audit.log(ctx, { action: 'OR_SCHEDULE', entityName: 'or_cases', entityId: c.id, oldData: { status: c.status, room_id: c.room_id, start: c.scheduled_start },
        newData: { status, room_id: room.id, start, end, warnings, reason: dto.reason } }, trx);
      return { c, status, kind, room: room.code, start };
    });
    const msg = `${out.c.case_no}: ${out.kind === 'tentative' ? 'წინასწარი ჯავშანი' : out.kind === 'confirmed' ? 'დადასტურდა' : out.kind === 'rescheduled' ? 'გადატანილია' : 'დაიგეგმა'} — ოთახი ${out.room}`;
    if (out.c.surgeon_id !== u.id) await this.bell.notify(out.c.surgeon_id, { kind: 'or_schedule', title: msg, link: `/or/case/${out.c.id}`, entityId: out.c.id });
    return this.detail(id, u);
  }

  async confirm(id: string, confirm: boolean | undefined, u: AuthUser, ctx: AuditContext) {
    const c = await this.loadCase(id);
    if (c.status !== 'tentative' || !c.room_id || !c.scheduled_start) throw new ConflictException('დასადასტურებელი ჯავშანი არ არის');
    return this.schedule(id, { room_id: c.room_id, start: new Date(c.scheduled_start).toISOString(), confirm }, u, ctx, true);
  }

  /** გადადება: დაგეგმილი → რიგში (მოთხოვნა), ოთახი / დრო თავისუფლდება */
  async unschedule(id: string, reason: string, u: AuthUser, ctx: AuditContext) {
    const s = await this.settings();
    await this.db.transaction().execute(async (trx) => {
      const c = await this.loadCase(id, trx, true);
      if (!['tentative', 'scheduled'].includes(c.status)) throw new ConflictException('გადადება — მხოლოდ დაგეგმილი (დაწყებამდე)');
      const p = await this.perms(u, c, s, trx);
      if (!p.cancel) throw new ForbiddenException('გადადება — ქირურგი / განყოფილების ხელმძღვანელი / კოორდინატორი');
      await trx.updateTable('or_cases').set({ status: 'requested', room_id: null, block_id: null, scheduled_start: null, scheduled_end: null, scheduled_by: null, scheduled_at: null,
        schedule_warnings: null, postpone_count: sql`postpone_count + 1`, updated_by: u.id }).where('id', '=', c.id).execute();
      await this.event(trx, c, 'unscheduled', { reason, from: c.scheduled_start }, u);
      await this.audit.log(ctx, { action: 'OR_POSTPONE', entityName: 'or_cases', entityId: c.id, oldData: { room_id: c.room_id, start: c.scheduled_start }, newData: { reason } }, trx);
    });
    return this.detail(id, u);
  }

  async cancel(id: string, dto: CancelDto, u: AuthUser, ctx: AuditContext) {
    const s = await this.settings();
    await this.db.transaction().execute(async (trx) => {
      const c = await this.loadCase(id, trx, true);
      if (['in_progress', 'completed', 'cancelled'].includes(c.status)) throw new ConflictException(`ოპერაცია ${STATUS_KA[c.status].toLowerCase()}ა — გაუქმება შეუძლებელია`);
      const p = await this.perms(u, c, s, trx);
      if (!p.cancel) throw new ForbiddenException('გაუქმება — ქირურგი / განყოფილების ხელმძღვანელი / კოორდინატორი');
      const r = await trx.selectFrom('or_cancel_reasons').select(['code', 'name', 'is_active']).where('code', '=', dto.reason_code).executeTakeFirst();
      if (!r?.is_active) throw new BadRequestException('გაუქმების მიზეზი ვერ მოიძებნა');
      if (r.code === 'other' && (dto.note?.trim().length ?? 0) < 3) throw new BadRequestException('მიზეზი „სხვა“ — მიუთითეთ განმარტება');
      await trx.updateTable('or_cases').set({ status: 'cancelled', cancel_reason_code: r.code, cancel_note: dto.note?.trim() || null, cancelled_by: u.id, cancelled_at: sql`now()`, updated_by: u.id })
        .where('id', '=', c.id).execute();
      await this.event(trx, c, 'cancelled', { reason: r.name, code: r.code, note: dto.note ?? null, was: c.status, start: c.scheduled_start }, u, 'or_cancelled');
      await this.audit.log(ctx, { action: 'OR_CANCEL', entityName: 'or_cases', entityId: c.id, oldData: { status: c.status }, newData: dto }, trx);
    });
    return this.detail(id, u);
  }

  async changeSurgeon(id: string, dto: SurgeonDto, u: AuthUser, ctx: AuditContext) {
    const s = await this.settings();
    await this.db.transaction().execute(async (trx) => {
      const c = await this.loadCase(id, trx, true);
      const p = await this.perms(u, c, s, trx);
      if (!p.surgeon) throw new ForbiddenException('ოპერატორს ცვლის განყოფილების ხელმძღვანელი / admin (დაწყებამდე)');
      if (dto.surgeon_id === c.surgeon_id) throw new BadRequestException('ეს ქირურგი უკვე ოპერატორია');
      const x = await this.userHas(dto.surgeon_id, ['doctor'], trx);
      if (!x) throw new BadRequestException('ქირურგი ვერ მოიძებნა (აქტიური ექიმი)');
      await trx.updateTable('or_case_team').set({ removed_at: sql`now()`, removed_by: u.id, remove_reason: dto.reason }).where('case_id', '=', c.id).where('role_code', '=', 'surgeon')
        .where('removed_at', 'is', null).execute();
      await trx.updateTable('or_case_team').set({ removed_at: sql`now()`, removed_by: u.id, remove_reason: 'გახდა ოპერატორი' }).where('case_id', '=', c.id)
        .where('user_id', '=', dto.surgeon_id).where('role_code', '=', 'assistant').where('removed_at', 'is', null).execute();
      await trx.insertInto('or_case_team').values({ case_id: c.id, role_code: 'surgeon', user_id: dto.surgeon_id, added_by: u.id }).execute();
      await trx.updateTable('or_cases').set({ surgeon_id: dto.surgeon_id, updated_by: u.id }).where('id', '=', c.id).execute();
      await this.event(trx, c, 'surgeon_changed', { to: `${x.last_name} ${x.first_name}`, reason: dto.reason }, u);
      await this.audit.log(ctx, { action: 'OR_SURGEON', entityName: 'or_cases', entityId: c.id, oldData: { surgeon_id: c.surgeon_id }, newData: dto }, trx);
    });
    return this.detail(id, u);
  }

  // ================================================================= გუნდი
  async addTeam(id: string, dto: TeamDto, u: AuthUser, ctx: AuditContext) {
    const s = await this.settings();
    try {
      await this.db.transaction().execute(async (trx) => {
        const c = await this.loadCase(id, trx, true);
        const role = await trx.selectFrom('or_team_roles').selectAll().where('code', '=', dto.role_code).executeTakeFirst();
        if (!role?.is_active) throw new BadRequestException('გუნდის როლი ვერ მოიძებნა');
        if (role.code === 'surgeon') throw new BadRequestException('ოპერატორი იცვლება „ოპერატორის შეცვლით“ (განყოფილების ხელმძღვანელი)');
        const p = await this.perms(u, c, s, trx);
        if (!(role.grp === 'anesthesia' ? p.team_anesthesia : p.team_surgical)) {
          throw new ForbiddenException(c.locked_at ? 'ოქმი ხელმოწერილია — გუნდი დაბლოკილია' : role.grp === 'anesthesia' && s.anesthesia_team_by === 'anesthesia_head'
            ? 'ანესთეზიის გუნდს ნიშნავს ანესთეზიოლოგიის ხელმძღვანელი' : 'გუნდს აყალიბებს ოპერატორი ქირურგი / განყოფილების ხელმძღვანელი / admin');
        }
        const caps = role.capability === 'nurse' ? ['nurse', 'or_nurse'] : [role.capability];
        const x = await this.userHas(dto.user_id, caps, trx);
        if (!x) throw new BadRequestException(`თანამშრომელს „${role.name}“-ის უფლება არ აქვს ან გათიშულია`);
        const started = ['in_progress', 'completed'].includes(c.status);
        const at = dto.at ? new Date(dto.at) : new Date();
        if (started && at.getTime() > Date.now() + 5 * 60_000) throw new BadRequestException('შემოსვლის დრო მომავალშია');
        let replaced: { id: string } | undefined;
        if (dto.replaces_id) {
          replaced = await trx.selectFrom('or_case_team').select(['id']).where('id', '=', dto.replaces_id).where('case_id', '=', c.id).where('role_code', '=', role.code)
            .where('removed_at', 'is', null).where('out_at', 'is', null).executeTakeFirst();
          if (!replaced) throw new BadRequestException('შესაცვლელი წევრი ვერ მოიძებნა (იმავე როლში)');
        } else if (!role.multiple) {
          const cur = await trx.selectFrom('or_case_team').select('id').where('case_id', '=', c.id).where('role_code', '=', role.code).where('removed_at', 'is', null).where('out_at', 'is', null).executeTakeFirst();
          if (cur) throw new ConflictException({ code: 'ROLE_TAKEN', message: `„${role.name}“ უკვე მინიჭებულია — მიუთითეთ, ვის ცვლის` });
        }
        if (c.scheduled_start && !started) {
          const cf = await this.conflicts(trx, c, c.room_id!, new Date(c.scheduled_start), new Date(c.scheduled_end!), s.turnover_min, [x.id]);
          if (cf.people.length && !dto.confirm) {
            const w = cf.people.map((pp) => `${pp.name} ამავე დროს — ${pp.case_no}${pp.room_code ? ` (ოთახი ${pp.room_code})` : ''}`);
            throw new ConflictException({ code: 'CONFIRM_REQUIRED', message: w.join('; '), warnings: w });
          }
        }
        const row = await trx.insertInto('or_case_team').values({ case_id: c.id, role_code: role.code, user_id: x.id, added_by: u.id, in_at: started ? at : null })
          .returning('id').executeTakeFirstOrThrow();
        if (replaced) {
          if (started) await trx.updateTable('or_case_team').set({ out_at: at, replaced_by: row.id }).where('id', '=', replaced.id).execute();
          else await trx.updateTable('or_case_team').set({ removed_at: sql`now()`, removed_by: u.id, remove_reason: 'შეიცვალა', replaced_by: row.id }).where('id', '=', replaced.id).execute();
        }
        await this.event(trx, c, 'team_added', { role: role.name, name: `${x.last_name} ${x.first_name}`, ...(started && { at: at.toISOString() }), replaced: !!replaced }, u);
        await this.audit.log(ctx, { action: 'OR_TEAM_ADD', entityName: 'or_case_team', entityId: row.id, newData: dto }, trx);
        if (x.id !== u.id) await this.bell.notify(x.id, { kind: 'or_team', title: `${c.case_no}: ${role.name}`, link: `/or/case/${c.id}`, entityId: `${c.id}:${role.code}` }).catch(() => undefined);
      });
    } catch (e) { mapPgError(e, { ux_or_team_member: 'ეს თანამშრომელი ამ როლში უკვე გუნდშია' }); }
    return this.detail(id, u);
  }

  async removeTeam(teamId: string, dto: TeamRemoveDto, u: AuthUser, ctx: AuditContext) {
    const s = await this.settings();
    const caseId = await this.db.transaction().execute(async (trx) => {
      const t = await trx.selectFrom('or_case_team as t').innerJoin('or_team_roles as r', 'r.code', 't.role_code').innerJoin('users as x', 'x.id', 't.user_id')
        .select(['t.id', 't.case_id', 't.role_code', 't.removed_at', 't.out_at', 't.in_at', 'r.grp', 'r.name as role_name', sql<string>`x.last_name || ' ' || x.first_name`.as('name')])
        .where('t.id', '=', teamId).forUpdate('t').executeTakeFirst();
      if (!t || t.removed_at || t.out_at) throw new NotFoundException('გუნდის წევრი ვერ მოიძებნა');
      if (t.role_code === 'surgeon') throw new BadRequestException('ოპერატორი იცვლება „ოპერატორის შეცვლით“');
      const c = await this.loadCase(t.case_id, trx, true);
      const p = await this.perms(u, c, s, trx);
      if (!(t.grp === 'anesthesia' ? p.team_anesthesia : p.team_surgical)) throw new ForbiddenException('გუნდის შეცვლის უფლება არ გაქვთ');
      const started = ['in_progress', 'completed'].includes(c.status);
      if (started) {
        const at = dto.at ? new Date(dto.at) : new Date();
        if (t.in_at && at < new Date(t.in_at)) throw new BadRequestException('გასვლის დრო შემოსვლამდეა');
        if (at.getTime() > Date.now() + 5 * 60_000) throw new BadRequestException('გასვლის დრო მომავალშია');
        await trx.updateTable('or_case_team').set({ out_at: at }).where('id', '=', t.id).execute();
        await this.event(trx, c, 'team_out', { role: t.role_name, name: t.name, at: at.toISOString(), reason: dto.reason ?? null }, u);
      } else {
        await trx.updateTable('or_case_team').set({ removed_at: sql`now()`, removed_by: u.id, remove_reason: dto.reason?.trim() || null }).where('id', '=', t.id).execute();
        await this.event(trx, c, 'team_removed', { role: t.role_name, name: t.name, reason: dto.reason ?? null }, u);
      }
      await this.audit.log(ctx, { action: 'OR_TEAM_REMOVE', entityName: 'or_case_team', entityId: t.id, newData: dto }, trx);
      return c.id;
    });
    return this.detail(caseId, u);
  }

  // ================================================================= წინასაოპერაციო
  async savePreop(id: string, dto: PreopDto, u: AuthUser, ctx: AuditContext) {
    const s = await this.settings();
    await this.db.transaction().execute(async (trx) => {
      const c = await this.loadCase(id, trx, true);
      if (!(await this.perms(u, c, s, trx)).preop) throw new ForbiddenException('წინასაოპერაციო გასინჯვა — ანესთეზიოლოგი');
      const old = await trx.selectFrom('or_preop_assessments').selectAll().where('case_id', '=', c.id).where('voided_at', 'is', null).forUpdate().executeTakeFirst();
      if (old?.status === 'signed') throw new ConflictException('გასინჯვა ხელმოწერილია — შესაცვლელად გააუქმეთ (მიზეზით)');
      const v = {
        ...(dto.asa_class !== undefined && { asa_class: dto.asa_class }), ...(dto.asa_emergency !== undefined && { asa_emergency: dto.asa_emergency }),
        ...(dto.mallampati !== undefined && { mallampati: dto.mallampati }), ...(dto.weight_kg !== undefined && { weight_kg: dto.weight_kg === null ? null : String(dto.weight_kg) }),
        ...(dto.height_cm !== undefined && { height_cm: dto.height_cm === null ? null : String(dto.height_cm) }),
        ...(dto.fasting_solids_at !== undefined && { fasting_solids_at: dto.fasting_solids_at }), ...(dto.fasting_liquids_at !== undefined && { fasting_liquids_at: dto.fasting_liquids_at }),
        ...(dto.airway_notes !== undefined && { airway_notes: dto.airway_notes?.trim() || null }), ...(dto.comorbidities !== undefined && { comorbidities: dto.comorbidities?.trim() || null }),
        ...(dto.risks !== undefined && { risks: [...new Set(dto.risks)] }), ...(dto.risk_notes !== undefined && { risk_notes: dto.risk_notes?.trim() || null }),
        ...(dto.planned_anesthesia !== undefined && { planned_anesthesia: dto.planned_anesthesia }), ...(dto.plan_notes !== undefined && { plan_notes: dto.plan_notes?.trim() || null }),
      };
      if (old) await trx.updateTable('or_preop_assessments').set(v).where('id', '=', old.id).execute();
      else await trx.insertInto('or_preop_assessments').values({ ...v, case_id: c.id, patient_id: c.patient_id, created_by: u.id, planned_anesthesia: dto.planned_anesthesia ?? c.anesthesia_type })
        .execute();
      await this.audit.log(ctx, { action: 'OR_PREOP_SAVE', entityName: 'or_preop_assessments', entityId: c.id, newData: dto }, trx);
    });
    return this.detail(id, u);
  }

  async signPreop(id: string, u: AuthUser, ctx: AuditContext) {
    const s = await this.settings();
    await this.db.transaction().execute(async (trx) => {
      const c = await this.loadCase(id, trx, true);
      if (!(await this.perms(u, c, s, trx)).preop) throw new ForbiddenException('წინასაოპერაციო გასინჯვა — ანესთეზიოლოგი');
      const a = await trx.selectFrom('or_preop_assessments').selectAll().where('case_id', '=', c.id).where('voided_at', 'is', null).forUpdate().executeTakeFirst();
      if (!a) throw new BadRequestException('გასინჯვა ჯერ არ არის შევსებული');
      if (a.status === 'signed') throw new ConflictException('უკვე ხელმოწერილია');
      const miss = [!a.asa_class && 'ASA', !a.mallampati && 'Mallampati', !a.planned_anesthesia && 'ანესთეზიის გეგმა'].filter(Boolean);
      if (miss.length) throw new BadRequestException(`ხელმოწერისთვის აკლია: ${miss.join(', ')}`);
      const allergies = await trx.selectFrom('patient_allergies').select(['substance', 'severity', 'allergy_type', 'reaction_type']).where('patient_id', '=', c.patient_id)
        .where('is_active', '=', true).execute();
      await trx.updateTable('or_preop_assessments').set({ status: 'signed', signed_by: u.id, signed_at: sql`now()`, allergies: JSON.stringify(allergies) }).where('id', '=', a.id).execute();
      await this.event(trx, c, 'preop_signed', { asa: `${a.asa_class}${a.asa_emergency ? 'E' : ''}`, mallampati: a.mallampati }, u);
      await this.audit.log(ctx, { action: 'OR_PREOP_SIGN', entityName: 'or_preop_assessments', entityId: a.id }, trx);
    });
    return this.detail(id, u);
  }

  async voidPreop(preopId: string, reason: string, u: AuthUser, ctx: AuditContext) {
    const s = await this.settings();
    const caseId = await this.db.transaction().execute(async (trx) => {
      const a = await trx.selectFrom('or_preop_assessments').selectAll().where('id', '=', preopId).forUpdate().executeTakeFirst();
      if (!a || a.voided_at) throw new NotFoundException('გასინჯვა ვერ მოიძებნა');
      const c = await this.loadCase(a.case_id, trx, true);
      if (!(await this.perms(u, c, s, trx)).preop) throw new ForbiddenException('წინასაოპერაციო გასინჯვა — ანესთეზიოლოგი');
      if (['in_progress', 'completed'].includes(c.status)) throw new ConflictException('ოპერაცია დაწყებულია — გასინჯვა ვეღარ უქმდება');
      await trx.updateTable('or_preop_assessments').set({ voided_at: sql`now()`, voided_by: u.id, void_reason: reason }).where('id', '=', a.id).execute();
      await this.event(trx, c, 'preop_voided', { reason }, u);
      await this.audit.log(ctx, { action: 'OR_PREOP_VOID', entityName: 'or_preop_assessments', entityId: a.id, newData: { reason } }, trx);
      return c.id;
    });
    return this.detail(caseId, u);
  }

  async setReadiness(id: string, dto: ReadinessDto, u: AuthUser, ctx: AuditContext) {
    const s = await this.settings();
    await this.db.transaction().execute(async (trx) => {
      const c = await this.loadCase(id, trx, true);
      if (!(await this.perms(u, c, s, trx)).readiness) throw new ForbiddenException('მზადყოფნის ჩეკლისტის შევსების უფლება არ გაქვთ');
      if (['in_progress', 'completed', 'cancelled'].includes(c.status)) throw new ConflictException('ოპერაცია დაწყებულია / დასრულებულია');
      const it = await trx.selectFrom('or_readiness_items').selectAll().where('id', '=', dto.item_id).executeTakeFirst();
      if (!it?.is_active) throw new BadRequestException('პუნქტი ვერ მოიძებნა');
      if (it.source !== 'manual') throw new BadRequestException('ეს პუნქტი ავტომატურად ფასდება (თანხმობა / გასინჯვა)');
      await trx.insertInto('or_case_readiness').values({ case_id: c.id, item_id: it.id, answer: dto.answer, note: dto.note?.trim() || null, checked_by: u.id })
        .onConflict((oc) => oc.columns(['case_id', 'item_id']).doUpdateSet({ answer: dto.answer, note: dto.note?.trim() || null, checked_by: u.id, checked_at: sql`now()` })).execute();
      await this.event(trx, c, 'readiness', { item: it.label, answer: dto.answer }, u);
      await this.audit.log(ctx, { action: 'OR_READINESS', entityName: 'or_case_readiness', entityId: c.id, newData: dto }, trx);
    });
    return this.detail(id, u);
  }

  // ================================================================= WHO ჩეკლისტი
  async who(id: string, dto: WhoDto, u: AuthUser, ctx: AuditContext) {
    const s = await this.settings();
    try {
      await this.db.transaction().execute(async (trx) => {
        const c = await this.loadCase(id, trx, true);
        if (!(await this.perms(u, c, s, trx)).periop) throw new ForbiddenException('WHO ჩეკლისტი — გუნდის წევრი / საოპერაციო ექთანი / ანესთეზიოლოგი');
        if (!['scheduled', 'in_progress'].includes(c.status)) throw new ConflictException('WHO ჩეკლისტი — დაგეგმილ / მიმდინარე ოპერაციაზე');
        if (!c.encounter_id) throw new ConflictException('პაციენტი ჯერ არ არის ჰოსპიტალიზებული');
        const done = (await trx.selectFrom('or_who_checks').select('phase').where('case_id', '=', c.id).where('voided_at', 'is', null).execute()).map((w) => w.phase);
        if (dto.phase === 'time_out' && !done.includes('sign_in')) throw new ConflictException({ code: 'WHO_ORDER', message: 'ჯერ Sign in' });
        if (dto.phase === 'sign_out' && !done.includes('time_out')) throw new ConflictException({ code: 'WHO_ORDER', message: 'ჯერ Time out' });
        if (dto.phase === 'sign_out' && c.status !== 'in_progress') throw new ConflictException('Sign out — მიმდინარე ოპერაციაზე');
        const items = await trx.selectFrom('or_who_items').select(['id', 'label']).where('phase', '=', dto.phase).where('is_active', '=', true).orderBy('sort_order').execute();
        const answers = items.map((i) => ({ item_id: i.id, label: i.label, answer: dto.answers[i.id] }));
        const missing = answers.filter((a) => a.answer !== 'yes' && a.answer !== 'na');
        if (missing.length) throw new BadRequestException({ code: 'WHO_INCOMPLETE', message: `${WHO_KA[dto.phase]}: ყველა პუნქტი უნდა დადასტურდეს („კი“ ან „არ ეხება“) — ${missing.length} დარჩა`,
          missing: missing.map((m) => m.label) });
        const r = await trx.insertInto('or_who_checks').values({ case_id: c.id, phase: dto.phase, answers: JSON.stringify(answers), note: dto.note?.trim() || null, done_by: u.id })
          .returning('id').executeTakeFirstOrThrow();
        await this.event(trx, c, 'who', { phase: dto.phase }, u);
        await this.audit.log(ctx, { action: 'OR_WHO', entityName: 'or_who_checks', entityId: r.id, newData: dto }, trx);
      });
    } catch (e) { mapPgError(e, { ux_or_who_phase: 'ეს ეტაპი უკვე შევსებულია' }); }
    return this.detail(id, u);
  }

  async voidWho(whoId: string, reason: string, u: AuthUser, ctx: AuditContext) {
    const s = await this.settings();
    const caseId = await this.db.transaction().execute(async (trx) => {
      const w = await trx.selectFrom('or_who_checks').selectAll().where('id', '=', whoId).forUpdate().executeTakeFirst();
      if (!w || w.voided_at) throw new NotFoundException('ჩეკლისტი ვერ მოიძებნა');
      const c = await this.loadCase(w.case_id, trx, true);
      if (!(await this.perms(u, c, s, trx)).periop) throw new ForbiddenException('გაუქმების უფლება არ გაქვთ');
      const t = await this.currentTimes(c.id, trx);
      const blocked = (w.phase === 'time_out' && t.has('incision')) || (w.phase === 'sign_out' && t.has('out_of_room'))
        || (w.phase === 'sign_in' && (await trx.selectFrom('or_who_checks').select('id').where('case_id', '=', c.id).where('phase', '=', 'time_out').where('voided_at', 'is', null).executeTakeFirst()));
      if (blocked) throw new ConflictException('შემდეგი ეტაპი უკვე დაფიქსირებულია — ეს ჩეკლისტი ვეღარ უქმდება');
      await trx.updateTable('or_who_checks').set({ voided_at: sql`now()`, voided_by: u.id, void_reason: reason }).where('id', '=', w.id).execute();
      await this.event(trx, c, 'who_voided', { phase: w.phase, reason }, u);
      await this.audit.log(ctx, { action: 'OR_WHO_VOID', entityName: 'or_who_checks', entityId: w.id, newData: { reason } }, trx);
      return c.id;
    });
    return this.detail(caseId, u);
  }

  // ================================================================= დროის ნიშნულები
  async recordTime(id: string, dto: TimeDto, u: AuthUser, ctx: AuditContext) {
    const s = await this.settings();
    try {
      await this.db.transaction().execute(async (trx) => {
        const c = await this.loadCase(id, trx, true);
        if (!(await this.perms(u, c, s, trx)).periop) throw new ForbiddenException(c.locked_at ? 'ოქმი ხელმოწერილია — ნიშნულები დაბლოკილია' : 'ნიშნულები — გუნდის წევრი / საოპერაციო ექთანი / ანესთეზიოლოგი');
        const k = dto.kind;
        if (!['scheduled', 'in_progress', 'completed'].includes(c.status)) {
          throw new ConflictException(c.status === 'tentative' ? 'ჯავშანი დასადასტურებელია (კოორდინატორი)' : `ოპერაცია ${STATUS_KA[c.status].toLowerCase()}ა`);
        }
        const at = dto.at ? new Date(dto.at) : new Date();
        if (at.getTime() > Date.now() + 5 * 60_000) throw new BadRequestException('დრო მომავალშია');
        const cur = await this.currentTimes(c.id, trx);
        const prev = cur.get(k);
        if (prev && !dto.correction_reason) throw new ConflictException({ code: 'TIME_EXISTS', message: `„${TIME_KA[k]}“ უკვე დაფიქსირებულია — შესწორებისთვის მიუთითეთ მიზეზი` });
        if (!prev && dto.correction_reason) throw new BadRequestException('შესასწორებელი ნიშნული არ არსებობს');
        for (const need of TIME_NEEDS[k]) if (!cur.has(need)) throw new ConflictException({ code: 'TIME_ORDER', message: `ჯერ — „${TIME_KA[need]}“` });
        if (k === 'out_of_room' && cur.has('incision') && !cur.has('closure')) throw new ConflictException({ code: 'TIME_ORDER', message: 'ჯერ — „ნაკერი“' });
        if (k === 'out_of_room' && cur.has('anesthesia_start') && !cur.has('anesthesia_end')) throw new ConflictException({ code: 'TIME_ORDER', message: 'ჯერ — „ანესთეზიის დასრულება“' });
        // ქრონოლოგია: წინა ნიშნულებზე ადრე / შემდეგებზე გვიან ვერ იქნება
        const idx = TIME_KINDS.indexOf(k);
        for (const [kk, v] of cur) {
          if (kk === k) continue;
          const j = TIME_KINDS.indexOf(kk);
          const pair = (a: TimeKind, b: TimeKind) => (a === 'anesthesia_start' && b === 'incision') || (a === 'incision' && b === 'anesthesia_start')
            || (a === 'closure' && b === 'anesthesia_end') || (a === 'anesthesia_end' && b === 'closure');   // ანესთეზია / ოპერაცია — თავისუფალი თანმიმდევრობა ერთმანეთის მიმართ
          if (pair(k, kk)) continue;
          if (j < idx && at < v.at) throw new BadRequestException(`„${TIME_KA[k]}“ ვერ იქნება „${TIME_KA[kk]}“-ზე ადრე`);
          if (j > idx && at > v.at) throw new BadRequestException(`„${TIME_KA[k]}“ ვერ იქნება „${TIME_KA[kk]}“-ზე გვიან`);
        }
        if (k === 'anesthesia_start' && NO_ANESTHESIOLOGIST.includes(c.anesthesia_type) && c.anesthesia_type === 'none') throw new BadRequestException('ანესთეზიის გარეშე ოპერაცია');
        if (k === 'incision') {
          const to = await trx.selectFrom('or_who_checks').select('id').where('case_id', '=', c.id).where('phase', '=', 'time_out').where('voided_at', 'is', null).executeTakeFirst();
          if (!to) throw new ConflictException({ code: 'WHO_TIME_OUT', message: 'WHO: Time out-ის გარეშე განაკვეთი ვერ დაფიქსირდება' });
        }
        if (k === 'out_of_room') {
          const so = await trx.selectFrom('or_who_checks').select('id').where('case_id', '=', c.id).where('phase', '=', 'sign_out').where('voided_at', 'is', null).executeTakeFirst();
          if (!so) throw new ConflictException({ code: 'WHO_SIGN_OUT', message: 'WHO: Sign out-ის გარეშე ოპერაცია ვერ დასრულდება' });
        }
        let override: string | null = null;
        if (k === 'in_room' && !prev) {
          if (!c.encounter_id || !(await this.stayActive(c.encounter_id, trx))) throw new ConflictException({ code: 'NOT_ADMITTED', message: 'ოპერაცია მხოლოდ აქტიურ ჰოსპიტალიზაციაზე (დღის სტაციონარიც)' });
          const rd = await this.readiness(c, trx);
          if (!rd.ready) {
            if (s.preop_readiness === 'block') throw new ConflictException({ code: 'PREOP_NOT_READY', message: `წინასაოპერაციო მზადყოფნა არასრულია: ${rd.missing.join('; ')}`, missing: rd.missing });
            if (!dto.readiness_override?.trim()) throw new ConflictException({ code: 'PREOP_OVERRIDE_REQUIRED', message: `მზადყოფნა არასრულია: ${rd.missing.join('; ')} — საჭიროა დასაბუთება`, missing: rd.missing });
            override = dto.readiness_override.trim();
          }
        }
        const newId = randomUUID();
        if (prev) await trx.updateTable('or_case_times').set({ superseded_by: newId }).where('id', '=', prev.id).execute();
        await trx.insertInto('or_case_times').values({ id: newId, case_id: c.id, kind: k, at, destination: ['out_of_room', 'pacu_out'].includes(k) ? dto.destination ?? null : null,
          recorded_by: u.id, correction_reason: dto.correction_reason ?? null }).execute();
        const set: Record<string, unknown> = { updated_by: u.id };
        if (k === 'in_room' && c.status === 'scheduled') set.status = 'in_progress';
        if (k === 'out_of_room' && c.status === 'in_progress') set.status = 'completed';
        if (override) { set.readiness_override = override; set.readiness_override_by = u.id; }
        await trx.updateTable('or_cases').set(set).where('id', '=', c.id).execute();
        if (k === 'in_room' && !prev) {
          // დაწყების მომენტში გუნდის წევრები — შემოსვლის დრო
          await trx.updateTable('or_case_team').set({ in_at: at }).where('case_id', '=', c.id).where('removed_at', 'is', null).where('in_at', 'is', null).execute();
        }
        if (override) await this.event(trx, c, 'readiness_override', { reason: override }, u);
        await this.event(trx, c, prev ? 'time_corrected' : 'time', { kind: k, at: at.toISOString(), ...(prev && { from: prev.at.toISOString(), reason: dto.correction_reason }),
          ...(dto.destination && { destination: dto.destination }) }, u,
          !prev && k === 'in_room' ? 'or_started' : !prev && k === 'out_of_room' ? 'or_completed' : undefined);
        await this.audit.log(ctx, { action: prev ? 'OR_TIME_CORRECT' : 'OR_TIME', entityName: 'or_case_times', entityId: newId, newData: dto }, trx);
      });
    } catch (e) {
      mapPgError(e, { ux_or_case_time: 'ნიშნული უკვე დაფიქსირებულია', or_who_time_out: 'WHO: Time out-ის გარეშე განაკვეთი ვერ დაფიქსირდება',
        or_who_sign_out: 'WHO: Sign out-ის გარეშე ოპერაცია ვერ დასრულდება' });
    }
    return this.detail(id, u);
  }

  // ================================================================= დაფა / ჩემი ოპერაციები / თანამშრომლები
  async board(q: BoardQuery) {
    await this.settings();
    const date = q.date ?? (await sql<{ d: string }>`SELECT (now() AT TIME ZONE ${TZ})::date::text AS d`.execute(this.db)).rows[0].d;
    const days = q.days ?? 1;
    const rooms = await this.db.selectFrom('or_rooms as r').innerJoin('departments as d', 'd.id', 'r.department_id')
      .select(['r.id', 'r.code', 'r.name', 'r.department_id', 'd.name as block_name', 'r.work_start', 'r.work_end', 'r.work_days', 'r.specialties', 'r.emergency_only'])
      .where('r.is_active', '=', true).where('d.is_active', '=', true).$if(!!q.block_id, (x) => x.where('r.department_id', '=', q.block_id!))
      .orderBy('d.name').orderBy('r.sort_order').orderBy('r.code').execute();
    const from = sql<Date>`(${date}::date::timestamp AT TIME ZONE ${TZ})`;
    const to = sql<Date>`((${date}::date + ${days}::int)::timestamp AT TIME ZONE ${TZ})`;
    const cases = await this.baseList().where('c.status', 'in', [...ACTIVE, 'completed']).where('c.scheduled_start', '<', to).where('c.scheduled_end', '>', from)
      .$if(!!q.block_id, (x) => x.where('c.block_id', '=', q.block_id!)).orderBy('c.scheduled_start').execute();
    const queue = await this.baseList().where((eb) => eb.or([eb('c.status', '=', 'requested'), eb('c.status', '=', 'tentative')]))
      .orderBy(sql`CASE c.urgency WHEN 'emergency' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END`).orderBy(sql`c.preferred_date NULLS LAST`).orderBy('c.requested_at').limit(200).execute();
    const ready = new Map<string, { ready: boolean; missing: number }>();
    for (const c of [...cases, ...queue]) {
      if (['completed', 'in_progress'].includes(c.status) || ready.has(c.id)) continue;
      const r = await this.readiness(await this.loadCase(c.id));
      ready.set(c.id, { ready: r.ready, missing: r.missing.length });
    }
    const withR = <T extends { id: string }>(x: T) => ({ ...x, readiness: ready.get(x.id) ?? null });
    return { date, days, rooms, cases: cases.map(withR), queue: queue.map(withR), now: new Date().toISOString() };
  }

  async my(u: AuthUser, from?: string, to?: string) {
    await this.settings();
    const f = from ?? (await sql<{ d: string }>`SELECT ((now() AT TIME ZONE ${TZ})::date - 1)::text AS d`.execute(this.db)).rows[0].d;
    const rows = await this.baseList()
      .select([sql<string[]>`ARRAY(SELECT r.name FROM or_case_team t JOIN or_team_roles r ON r.code = t.role_code WHERE t.case_id = c.id AND t.user_id = ${u.id} AND t.removed_at IS NULL)`.as('my_roles')])
      .where((eb) => eb.or([eb('c.surgeon_id', '=', u.id), eb('c.requested_by', '=', u.id),
        eb.exists(eb.selectFrom('or_case_team as t').select('t.id').whereRef('t.case_id', '=', 'c.id').where('t.user_id', '=', u.id).where('t.removed_at', 'is', null))]))
      .where('c.status', '<>', 'cancelled')
      .where((eb) => eb.or([eb('c.status', '=', 'requested'), eb(sql`c.scheduled_start`, '>=', sql`(${f}::date::timestamp AT TIME ZONE ${TZ})`)]))
      .$if(!!to, (x) => x.where(sql<boolean>`(c.scheduled_start IS NULL OR c.scheduled_start < ((${to}::date + 1)::timestamp AT TIME ZONE ${TZ}))`))
      .orderBy(sql`c.scheduled_start NULLS FIRST`).limit(300).execute();
    return rows;
  }

  async staff(cap: string, q?: string) {
    if (!['doctor', 'anesthesiologist', 'or_nurse', 'nurse'].includes(cap)) throw new BadRequestException('უცნობი უფლება');
    const caps = cap === 'nurse' ? ['nurse', 'or_nurse'] : [cap];
    let x = this.db.selectFrom('users as x').innerJoin('user_capabilities as uc', 'uc.user_id', 'x.id').leftJoin('departments as d', 'd.id', 'x.department_id')
      .select(['x.id', sql<string>`x.last_name || ' ' || x.first_name`.as('name'), 'x.specialty', 'd.name as department_name', 'x.is_section_head'])
      .where('x.is_active', '=', true).where(sql<boolean>`uc.capabilities && ${sql.val(caps)}::varchar[]`).orderBy('x.last_name').limit(200);
    if (q?.trim()) { const t = `%${q.trim()}%`; x = x.where((eb) => eb.or([eb('x.last_name', 'ilike', t), eb('x.first_name', 'ilike', t)])); }
    return x.execute();
  }
}

// ================================================================= controller
const DOC = ['admin', 'doctor'] as const;
@Controller('or')
export class OrController {
  constructor(private readonly s: OrService) {}
  @Get('board') @Roles(...OR_READ) board(@Query() q: BoardQuery) { return this.s.board(q); }
  @Get('my') @Roles(...OR_READ) my(@CurrentUser() u: AuthUser, @Query('from') from?: string, @Query('to') to?: string) {
    const d = /^\d{4}-\d{2}-\d{2}$/;
    if ((from && !d.test(from)) || (to && !d.test(to))) throw new BadRequestException('თარიღი: YYYY-MM-DD');
    return this.s.my(u, from, to);
  }
  @Get('staff') @Roles(...OR_READ) staff(@Query('cap') cap: string, @Query('q') q?: string) { return this.s.staff(cap, q); }
  @Get('sources') @Roles(...DOC) sources(@Query('patient_id', ParseUUIDPipe) pid: string) { return this.s.sources(pid); }
  @Get('cases') @Roles(...OR_READ, 'receptionist', 'billing') list(@Query() q: ListQuery, @CurrentUser() u: AuthUser) { return this.s.list(q, u); }
  @Get('cases/:id') @Roles(...OR_READ) one(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser) { return this.s.detail(id, u); }
  @Post('cases') @Roles(...DOC) create(@Body() d: CaseDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.create(d, u, auditCtx(r)); }
  @Patch('cases/:id') @Roles(...DOC) update(@Param('id', ParseUUIDPipe) id: string, @Body() d: CaseDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.update(id, d, u, auditCtx(r)); }
  @Post('cases/:id/schedule') @HttpCode(200) @Roles('admin', 'doctor', 'or_schedule')
  schedule(@Param('id', ParseUUIDPipe) id: string, @Body() d: ScheduleDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.schedule(id, d, u, auditCtx(r)); }
  @Post('cases/:id/confirm') @HttpCode(200) @Roles('admin', 'or_schedule')
  confirm(@Param('id', ParseUUIDPipe) id: string, @Body() d: { confirm?: boolean }, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.confirm(id, d?.confirm === true, u, auditCtx(r)); }
  @Post('cases/:id/unschedule') @HttpCode(200) @Roles('admin', 'doctor', 'or_schedule')
  unschedule(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.unschedule(id, d.reason, u, auditCtx(r)); }
  @Post('cases/:id/cancel') @HttpCode(200) @Roles('admin', 'doctor', 'or_schedule')
  cancel(@Param('id', ParseUUIDPipe) id: string, @Body() d: CancelDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.cancel(id, d, u, auditCtx(r)); }
  @Post('cases/:id/surgeon') @HttpCode(200) @Roles(...DOC)
  surgeon(@Param('id', ParseUUIDPipe) id: string, @Body() d: SurgeonDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.changeSurgeon(id, d, u, auditCtx(r)); }
  @Post('cases/:id/team') @Roles('admin', 'doctor', 'anesthesiologist')
  addTeam(@Param('id', ParseUUIDPipe) id: string, @Body() d: TeamDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.addTeam(id, d, u, auditCtx(r)); }
  @Post('team/:tid/remove') @HttpCode(200) @Roles('admin', 'doctor', 'anesthesiologist')
  rmTeam(@Param('tid', ParseUUIDPipe) tid: string, @Body() d: TeamRemoveDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.removeTeam(tid, d, u, auditCtx(r)); }
  @Put('cases/:id/preop') @Roles('admin', 'anesthesiologist')
  preop(@Param('id', ParseUUIDPipe) id: string, @Body() d: PreopDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.savePreop(id, d, u, auditCtx(r)); }
  @Post('cases/:id/preop/sign') @HttpCode(200) @Roles('admin', 'anesthesiologist')
  signPreop(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.signPreop(id, u, auditCtx(r)); }
  @Post('preop/:pid/void') @HttpCode(200) @Roles('admin', 'anesthesiologist')
  voidPreop(@Param('pid', ParseUUIDPipe) pid: string, @Body() d: ReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.voidPreop(pid, d.reason, u, auditCtx(r)); }
  @Put('cases/:id/readiness') @Roles('admin', 'doctor', 'nurse', 'or_nurse', 'anesthesiologist')
  readiness(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReadinessDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.setReadiness(id, d, u, auditCtx(r)); }
  @Post('cases/:id/who') @Roles('admin', 'doctor', 'or_nurse', 'anesthesiologist', 'nurse')
  who(@Param('id', ParseUUIDPipe) id: string, @Body() d: WhoDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.who(id, d, u, auditCtx(r)); }
  @Post('who/:wid/void') @HttpCode(200) @Roles('admin', 'doctor', 'or_nurse', 'anesthesiologist', 'nurse')
  voidWho(@Param('wid', ParseUUIDPipe) wid: string, @Body() d: ReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.voidWho(wid, d.reason, u, auditCtx(r)); }
  @Post('cases/:id/times') @Roles('admin', 'doctor', 'or_nurse', 'anesthesiologist', 'nurse')
  time(@Param('id', ParseUUIDPipe) id: string, @Body() d: TimeDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.recordTime(id, d, u, auditCtx(r)); }
}

@Module({ providers: [OrService], controllers: [OrController], exports: [OrService] })
export class OrModule {}
