import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/roles';
import { mapPgError } from '../common/pg-errors';
import { InjectDb, type Database } from '../database/database.module';
import { TransfersService } from '../inpatient/transfers';
import { OR_READ } from './or-admin';
import { VoidDto } from './or-anesthesia';
import { OrService } from './or';
import { orEvent, PACU_GRID_MIN, type Ex } from './or-shared';

const num = ({ value }: { value: unknown }) => (value === '' || value === null || value === undefined ? undefined : Number(value));
export const PACU_FLUID_IN = ['iv', 'blood', 'po', 'other_in'] as const;
export const PACU_FLUID_OUT = ['urine', 'drain', 'vomit', 'blood_loss', 'other_out'] as const;
const DEST_KA: Record<string, string> = { ward: 'განყოფილება', icu: 'რეანიმაცია (ICU)', other: 'სხვა' };
const PACU_WRITE = ['admin', 'or_nurse', 'anesthesiologist', 'nurse'] as const;

export class PacuDto {
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() nurse_id?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(20) bay?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(4000) complications?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(4000) notes?: string | null;
}
export class PacuAdmitDto extends PacuDto { @IsOptional() @IsDateString() at?: string }
export class PacuVitalsDto {
  @IsDateString() at: string;
  @IsOptional() @Transform(num) @IsInt() @Min(30) @Max(300) systolic_bp?: number;
  @IsOptional() @Transform(num) @IsInt() @Min(10) @Max(200) diastolic_bp?: number;
  @IsOptional() @Transform(num) @IsInt() @Min(15) @Max(250) map_mmhg?: number;
  @IsOptional() @Transform(num) @IsInt() @Min(10) @Max(300) heart_rate?: number;
  @IsOptional() @Transform(num) @IsInt() @Min(40) @Max(100) spo2?: number;
  @IsOptional() @Transform(num) @IsInt() @Min(0) @Max(80) respiratory_rate?: number;
  @IsOptional() @Transform(num) @IsNumber({ maxDecimalPlaces: 1 }) @Min(25) @Max(45) temperature?: number;
  @IsOptional() @Transform(num) @IsInt() @Min(0) @Max(10) pain?: number;
  @IsOptional() @IsBoolean() o2_supplement?: boolean;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}
export class PacuFluidDto {
  @IsIn([...PACU_FLUID_IN, ...PACU_FLUID_OUT]) category: string;
  @Transform(num) @IsNumber({ maxDecimalPlaces: 1 }) @Min(1) @Max(20000) volume_ml: number;
  @IsOptional() @IsDateString() at?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}
export class AldreteDto {
  @IsOptional() @IsDateString() at?: string;
  @IsInt() @Min(0) @Max(2) activity: number;
  @IsInt() @Min(0) @Max(2) respiration: number;
  @IsInt() @Min(0) @Max(2) circulation: number;
  @IsInt() @Min(0) @Max(2) consciousness: number;
  @IsInt() @Min(0) @Max(2) oxygenation: number;
  @IsOptional() @Transform(num) @IsInt() @Min(0) @Max(10) pain?: number;
  @IsOptional() @IsBoolean() ponv?: boolean;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}
export class PacuDischargeDto {
  @IsIn(['ward', 'icu', 'other']) destination: 'ward' | 'icu' | 'other';
  @IsOptional() @IsDateString() at?: string;
  @IsOptional() @IsUUID() to_department_id?: string;          // სხვა განყოფილება / ICU → გადაყვანის მოთხოვნა (0041)
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

/**
 * PACU — გამოღვიძების განყოფილება (0050, #11).
 *  ეპიზოდი: „PACU — შემოსვლა“ (ოპერაციის დასრულების შემდეგ) → or_pacu; პასუხისმგებელი ექთანი, ადგილი, გართულებები.
 *  ვიტალები 15-წთ ბადეზე (encounter_vitals, or_phase = pacu; + ტკივილი 0–10) — ჰოსპიტალიზაციის ვიტალებშიც; სითხეები → ბალანსი;
 *  Aldrete (5 × 0–2) + ტკივილი + PONV; გამოწერა — Aldrete ≥ pacu_aldrete_min (ICU — ზღვრის გარეშე); სხვა განყოფილება / ICU → გადაყვანის მოთხოვნა.
 *  უფლებები: საოპერაციო ექთანი, ანესთეზიოლოგი, გუნდის ექთანი, admin.
 */
@Injectable()
export class OrPacuService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService, private readonly or: OrService, private readonly transfers: TransfersService) {}

  private async load(id: string, u: AuthUser, ex: Ex = this.db, lock = false) {
    const s = await this.or.settings();
    const c = await this.or.loadCase(id, ex, lock);
    const p = await this.or.perms(u, c, s, ex);
    return { s, c, p };
  }
  private episode(id: string, ex: Ex = this.db) { return ex.selectFrom('or_pacu').selectAll().where('case_id', '=', id).executeTakeFirst(); }
  /** ჩაწერა: უფლება + ღია PACU ეპიზოდი */
  private async writable(id: string, u: AuthUser, ex: Ex) {
    const x = await this.load(id, u, ex, true);
    if (!x.p.pacu) throw new ForbiddenException('PACU — საოპერაციო ექთანი / ანესთეზიოლოგი (დასრულებულ ოპერაციაზე)');
    const ep = await ex.selectFrom('or_pacu').selectAll().where('case_id', '=', id).forUpdate().executeTakeFirst();
    if (!ep) throw new ConflictException({ code: 'PACU_NOT_STARTED', message: 'PACU ეპიზოდი არ არის — ჯერ „PACU — შემოსვლა“' });
    if (ep.discharged_at) throw new ConflictException({ code: 'PACU_DISCHARGED', message: 'პაციენტი PACU-დან გამოწერილია — ცვლილება შეუძლებელია' });
    return { ...x, ep };
  }
  private async times(id: string, ex: Ex = this.db) {
    const t = await ex.selectFrom('or_case_times').select(['kind', 'at', 'destination']).where('case_id', '=', id).where('superseded_by', 'is', null)
      .where('kind', 'in', ['out_of_room', 'pacu_in', 'pacu_out']).execute();
    const m = new Map(t.map((x) => [x.kind, x]));
    return { out_of_room: m.get('out_of_room')?.at ?? null, out_destination: m.get('out_of_room')?.destination ?? null, pacu_in: m.get('pacu_in')?.at ?? null,
      pacu_out: m.get('pacu_out')?.at ?? null, pacu_destination: m.get('pacu_out')?.destination ?? null };
  }
  private async staffOk(userId: string, ex: Ex) {
    const r = await ex.selectFrom('users as x').select(['x.is_active', sql<string[]>`coalesce((SELECT c.capabilities FROM user_capabilities c WHERE c.user_id = x.id), '{}')`.as('caps')])
      .where('x.id', '=', userId).executeTakeFirst();
    return !!r?.is_active && ['nurse', 'or_nurse', 'anesthesiologist'].some((k) => r.caps.includes(k));
  }

  async view(id: string, u: AuthUser) {
    const { s, c, p } = await this.load(id, u);
    const [ep, t, vitals, fluids, scores, cur] = await Promise.all([
      this.db.selectFrom('or_pacu as e').leftJoin('users as n', 'n.id', 'e.nurse_id').leftJoin('users as db', 'db.id', 'e.discharged_by').leftJoin('departments as td', 'td.id', 'e.to_department_id')
        .leftJoin('inpatient_transfers as tr', 'tr.id', 'e.transfer_id').selectAll('e')
        .select([sql<string | null>`n.last_name || ' ' || n.first_name`.as('nurse_name'), sql<string | null>`db.last_name || ' ' || db.first_name`.as('discharged_by_name'),
          'td.name as to_department_name', 'tr.status as transfer_status'])
        .where('e.case_id', '=', id).executeTakeFirst(),
      this.times(id),
      this.db.selectFrom('encounter_vitals as v').leftJoin('users as x', 'x.id', 'v.taken_by')
        .select(['v.id', 'v.recorded_at', 'v.systolic_bp', 'v.diastolic_bp', 'v.map_mmhg', 'v.heart_rate', 'v.spo2', 'v.respiratory_rate', 'v.temperature', 'v.pain', 'v.o2_supplement',
          'v.notes', 'v.voided_at', 'v.void_reason', sql<string | null>`x.last_name || ' ' || x.first_name`.as('by_name')])
        .where('v.or_case_id', '=', id).where('v.or_phase', '=', 'pacu').orderBy('v.recorded_at').execute(),
      this.db.selectFrom('fluid_entries as f').leftJoin('users as x', 'x.id', 'f.created_by')
        .select(['f.id', 'f.direction', 'f.category', 'f.volume_ml', 'f.recorded_at', 'f.note', 'f.voided_at', 'f.void_reason', sql<string>`x.last_name || ' ' || x.first_name`.as('by_name')])
        .where('f.or_case_id', '=', id).where('f.or_phase', '=', 'pacu').orderBy('f.recorded_at').execute(),
      this.db.selectFrom('or_pacu_scores as sc').innerJoin('users as x', 'x.id', 'sc.recorded_by')
        .select(['sc.id', 'sc.recorded_at', 'sc.activity', 'sc.respiration', 'sc.circulation', 'sc.consciousness', 'sc.oxygenation', 'sc.total', 'sc.pain', 'sc.ponv', 'sc.note',
          'sc.voided_at', 'sc.void_reason', sql<string>`x.last_name || ' ' || x.first_name`.as('by_name')])
        .where('sc.case_id', '=', id).orderBy('sc.recorded_at').execute(),
      c.encounter_id ? this.db.selectFrom('bed_assignments as a').innerJoin('departments as d', 'd.id', 'a.department_id')
        .select(['d.id', 'd.name', 'd.care_level']).where('a.encounter_id', '=', c.encounter_id).where('a.ended_at', 'is', null).executeTakeFirst() : null,
    ]);
    const live = fluids.filter((f) => !f.voided_at);
    const sum = (d: string) => live.filter((f) => f.direction === d).reduce((a, f) => a + Number(f.volume_ml), 0);
    const last = scores.filter((x) => !x.voided_at).at(-1) ?? null;
    const lastV = vitals.filter((v) => !v.voided_at).at(-1) ?? null;
    const open = !!ep && !ep.discharged_at;
    const ref = lastV ? new Date(lastV.recorded_at) : t.pacu_in ? new Date(t.pacu_in) : null;
    const overdue = open && !!ref && Date.now() - ref.getTime() > (PACU_GRID_MIN + 5) * 60_000;
    return {
      case_id: id, case_no: c.case_no, status: c.status, encounter_id: c.encounter_id, episode: ep ?? null, times: t, vitals, fluids, scores,
      balance: { in: sum('in'), out: sum('out'), net: sum('in') - sum('out') }, grid_min: PACU_GRID_MIN, aldrete_min: s.pacu_aldrete_min,
      last_score: last ? { total: last.total, pain: last.pain, at: last.recorded_at } : null, ready: !!last && (last.total ?? 0) >= s.pacu_aldrete_min,
      vitals_overdue: overdue, current_department: cur ?? null,
      can: { admit: p.pacu && !ep && !!t.out_of_room, edit: p.pacu && open, discharge: p.pacu && open },
    };
  }

  /** PACU-ში შემოსვლა: ნიშნული „PACU — შემოსვლა“ + ეპიზოდი (ექთანი, ადგილი) */
  async admit(id: string, dto: PacuAdmitDto, u: AuthUser, ctx: AuditContext) {
    const { p, c } = await this.load(id, u);
    if (!p.pacu) throw new ForbiddenException('PACU — საოპერაციო ექთანი / ანესთეზიოლოგი (დასრულებულ ოპერაციაზე)');
    if (c.status !== 'completed') throw new ConflictException('PACU — ოპერაციის დასრულების („საოპერაციოდან გავიდა“) შემდეგ');
    if (dto.nurse_id && !(await this.staffOk(dto.nurse_id, this.db))) throw new BadRequestException('ექთანი ვერ მოიძებნა (აქტიური ექთანი / ანესთეზიოლოგი)');
    await this.or.recordTime(id, { kind: 'pacu_in', at: dto.at }, u, ctx);
    const { at: _at, ...rest } = dto; void _at;
    if (Object.values(rest).some((v) => v !== undefined)) await this.update(id, rest, u, ctx);
    return this.view(id, u);
  }

  async update(id: string, dto: PacuDto, u: AuthUser, ctx: AuditContext) {
    await this.db.transaction().execute(async (trx) => {
      const { c } = await this.writable(id, u, trx);
      if (dto.nurse_id && !(await this.staffOk(dto.nurse_id, trx))) throw new BadRequestException('ექთანი ვერ მოიძებნა (აქტიური ექთანი / ანესთეზიოლოგი)');
      const v = {
        ...(dto.nurse_id !== undefined && { nurse_id: dto.nurse_id }), ...(dto.bay !== undefined && { bay: dto.bay?.trim() || null }),
        ...(dto.complications !== undefined && { complications: dto.complications?.trim() || null }), ...(dto.notes !== undefined && { notes: dto.notes?.trim() || null }),
      };
      if (!Object.keys(v).length) return;
      await trx.updateTable('or_pacu').set(v).where('case_id', '=', c.id).execute();
      await orEvent(trx, c, 'pacu_updated', { fields: Object.keys(v) }, u.id);
      await this.audit.log(ctx, { action: 'OR_PACU_UPDATE', entityName: 'or_pacu', entityId: c.id, newData: dto }, trx);
    });
    return this.view(id, u);
  }

  /** ვიტალები — 15-წთ ბადის სლოტზე (PACU-ში ყოფნის ფანჯარაში) */
  async vitals(id: string, dto: PacuVitalsDto, u: AuthUser, ctx: AuditContext) {
    const at = new Date(dto.at);
    if (at.getUTCSeconds() || at.getUTCMilliseconds() || at.getUTCMinutes() % PACU_GRID_MIN) throw new BadRequestException(`დრო — ${PACU_GRID_MIN}-წუთიანი ბადის სლოტზე (მაგ. 10:15, 10:30)`);
    const vals = ['systolic_bp', 'diastolic_bp', 'map_mmhg', 'heart_rate', 'spo2', 'respiratory_rate', 'temperature', 'pain'] as const;
    if (!vals.some((k) => dto[k] !== undefined)) throw new BadRequestException('შეიყვანეთ მინიმუმ ერთი მაჩვენებელი');
    if (dto.systolic_bp !== undefined && dto.diastolic_bp !== undefined && dto.diastolic_bp >= dto.systolic_bp) throw new BadRequestException('დიასტოლური ≥ სისტოლურზე');
    try {
      await this.db.transaction().execute(async (trx) => {
        const { c } = await this.writable(id, u, trx);
        const t = await this.times(c.id, trx);
        if (t.pacu_in && at.getTime() < new Date(t.pacu_in).getTime() - PACU_GRID_MIN * 60_000) throw new BadRequestException('დრო PACU-ში შემოსვლამდეა');
        if (at.getTime() > Date.now() + 5 * 60_000) throw new BadRequestException('დრო მომავალშია');
        const r = await trx.insertInto('encounter_vitals').values({ encounter_id: c.encounter_id!, or_case_id: c.id, or_phase: 'pacu', recorded_at: at, taken_by: u.id, source: 'manual',
          systolic_bp: dto.systolic_bp ?? null, diastolic_bp: dto.diastolic_bp ?? null,
          map_mmhg: dto.map_mmhg ?? (dto.systolic_bp && dto.diastolic_bp ? Math.round((dto.systolic_bp + 2 * dto.diastolic_bp) / 3) : null),
          heart_rate: dto.heart_rate ?? null, spo2: dto.spo2 ?? null, respiratory_rate: dto.respiratory_rate ?? null, pain: dto.pain ?? null, o2_supplement: dto.o2_supplement ?? null,
          temperature: dto.temperature === undefined ? null : String(dto.temperature), notes: dto.notes?.trim() || null }).returning('id').executeTakeFirstOrThrow();
        await this.audit.log(ctx, { action: 'OR_PACU_VITALS', entityName: 'encounter_vitals', entityId: r.id, newData: dto }, trx);
      });
    } catch (e) { mapPgError(e, { ux_vitals_or_slot: 'ამ სლოტზე ვიტალები უკვე ჩაწერილია — შესწორებისთვის გააუქმეთ (მიზეზით)' }); }
    return this.view(id, u);
  }

  async voidVitals(vid: string, reason: string, u: AuthUser, ctx: AuditContext) {
    const v = await this.db.selectFrom('encounter_vitals').select(['id', 'or_case_id', 'or_phase', 'voided_at']).where('id', '=', vid).executeTakeFirst();
    if (!v?.or_case_id || v.voided_at || v.or_phase !== 'pacu') throw new NotFoundException('ჩანაწერი ვერ მოიძებნა');
    await this.db.transaction().execute(async (trx) => {
      await this.writable(v.or_case_id!, u, trx);
      await trx.updateTable('encounter_vitals').set({ voided_at: sql`now()`, voided_by: u.id, void_reason: reason }).where('id', '=', vid).execute();
      await this.audit.log(ctx, { action: 'OR_PACU_VITALS_VOID', entityName: 'encounter_vitals', entityId: vid, newData: { reason } }, trx);
    });
    return this.view(v.or_case_id, u);
  }

  async fluid(id: string, dto: PacuFluidDto, u: AuthUser, ctx: AuditContext) {
    await this.db.transaction().execute(async (trx) => {
      const { c } = await this.writable(id, u, trx);
      const at = dto.at ? new Date(dto.at) : new Date();
      if (at.getTime() > Date.now() + 5 * 60_000) throw new BadRequestException('დრო მომავალშია');
      const t = await this.times(c.id, trx);
      if (t.pacu_in && at.getTime() < new Date(t.pacu_in).getTime() - 15 * 60_000) throw new BadRequestException('დრო PACU-ში შემოსვლამდეა');
      const r = await trx.insertInto('fluid_entries').values({ encounter_id: c.encounter_id!, patient_id: c.patient_id, or_case_id: c.id, or_phase: 'pacu',
        direction: (PACU_FLUID_IN as readonly string[]).includes(dto.category) ? 'in' : 'out', category: dto.category, volume_ml: String(dto.volume_ml), recorded_at: at,
        note: dto.note?.trim() || null, created_by: u.id }).returning('id').executeTakeFirstOrThrow();
      await this.audit.log(ctx, { action: 'OR_PACU_FLUID', entityName: 'fluid_entries', entityId: r.id, newData: dto }, trx);
    });
    return this.view(id, u);
  }

  async voidFluid(fid: string, reason: string, u: AuthUser, ctx: AuditContext) {
    const f = await this.db.selectFrom('fluid_entries').select(['id', 'or_case_id', 'or_phase', 'voided_at']).where('id', '=', fid).executeTakeFirst();
    if (!f?.or_case_id || f.voided_at || f.or_phase !== 'pacu') throw new NotFoundException('ჩანაწერი ვერ მოიძებნა');
    await this.db.transaction().execute(async (trx) => {
      await this.writable(f.or_case_id!, u, trx);
      await trx.updateTable('fluid_entries').set({ voided_at: sql`now()`, voided_by: u.id, void_reason: reason }).where('id', '=', fid).execute();
      await this.audit.log(ctx, { action: 'OR_PACU_FLUID_VOID', entityName: 'fluid_entries', entityId: fid, newData: { reason } }, trx);
    });
    return this.view(f.or_case_id, u);
  }

  /** Aldrete შეფასება (+ ტკივილი, PONV) */
  async score(id: string, dto: AldreteDto, u: AuthUser, ctx: AuditContext) {
    await this.db.transaction().execute(async (trx) => {
      const { c } = await this.writable(id, u, trx);
      const at = dto.at ? new Date(dto.at) : new Date();
      if (at.getTime() > Date.now() + 5 * 60_000) throw new BadRequestException('დრო მომავალშია');
      const t = await this.times(c.id, trx);
      if (t.pacu_in && at.getTime() < new Date(t.pacu_in).getTime() - 5 * 60_000) throw new BadRequestException('დრო PACU-ში შემოსვლამდეა');
      const r = await trx.insertInto('or_pacu_scores').values({ case_id: c.id, recorded_at: at, activity: dto.activity, respiration: dto.respiration, circulation: dto.circulation,
        consciousness: dto.consciousness, oxygenation: dto.oxygenation, pain: dto.pain ?? null, ponv: dto.ponv ?? false, note: dto.note?.trim() || null, recorded_by: u.id })
        .returning(['id', 'total']).executeTakeFirstOrThrow();
      await orEvent(trx, c, 'pacu_score', { total: r.total, pain: dto.pain ?? null, ponv: dto.ponv ?? false }, u.id);
      await this.audit.log(ctx, { action: 'OR_PACU_SCORE', entityName: 'or_pacu_scores', entityId: r.id, newData: dto }, trx);
    });
    return this.view(id, u);
  }

  async voidScore(sid: string, reason: string, u: AuthUser, ctx: AuditContext) {
    const sc = await this.db.selectFrom('or_pacu_scores').select(['id', 'case_id', 'total', 'voided_at']).where('id', '=', sid).executeTakeFirst();
    if (!sc || sc.voided_at) throw new NotFoundException('შეფასება ვერ მოიძებნა');
    await this.db.transaction().execute(async (trx) => {
      const { c } = await this.writable(sc.case_id, u, trx);
      await trx.updateTable('or_pacu_scores').set({ voided_at: sql`now()`, voided_by: u.id, void_reason: reason }).where('id', '=', sid).execute();
      await orEvent(trx, c, 'pacu_score_voided', { total: sc.total, reason }, u.id);
      await this.audit.log(ctx, { action: 'OR_PACU_SCORE_VOID', entityName: 'or_pacu_scores', entityId: sid, newData: { reason } }, trx);
    });
    return this.view(sc.case_id, u);
  }

  /**
   * გამოწერა: „PACU — გასვლა“ (OrService.recordTime — Aldrete-ის წესი იქ მოწმდება) → სხვა განყოფილება / ICU — გადაყვანის მოთხოვნა (0041);
   * ICU ეპიზოდის წყარო მიღებისას — „საოპერაციო“ (0048 trigger). საკუთარ განყოფილებაში დაბრუნება — გადაყვანის გარეშე.
   */
  async discharge(id: string, dto: PacuDischargeDto, u: AuthUser, ctx: AuditContext) {
    const { c, p } = await this.load(id, u);
    if (!p.pacu) throw new ForbiddenException('PACU — საოპერაციო ექთანი / ანესთეზიოლოგი (დასრულებულ ოპერაციაზე)');
    const ep = await this.episode(id);
    if (!ep) throw new ConflictException({ code: 'PACU_NOT_STARTED', message: 'PACU ეპიზოდი არ არის — ჯერ „PACU — შემოსვლა“' });
    if (ep.discharged_at) throw new ConflictException({ code: 'PACU_DISCHARGED', message: 'პაციენტი PACU-დან უკვე გამოწერილია' });
    // გადაყვანის წინასწარი შემოწმება (გამოწერამდე — რომ ნიშნული არ დაფიქსირდეს წარუმატებელი გადაყვანით)
    const cur = await this.db.selectFrom('bed_assignments as a').innerJoin('departments as d', 'd.id', 'a.department_id').select(['d.id', 'd.name', 'd.care_level'])
      .where('a.encounter_id', '=', c.encounter_id!).where('a.ended_at', 'is', null).executeTakeFirst();
    let to: { id: string; name: string; care_level: string | null } | null = null;
    if (dto.to_department_id && dto.to_department_id !== cur?.id) {
      const d = await this.db.selectFrom('departments').select(['id', 'name', 'type', 'is_active', 'care_level']).where('id', '=', dto.to_department_id).executeTakeFirst();
      if (!d?.is_active || d.type !== 'inpatient') throw new BadRequestException('განყოფილება ვერ მოიძებნა (აქტიური სტაციონარული)');
      to = d;
      const open = await this.db.selectFrom('inpatient_transfers').select('id').where('encounter_id', '=', c.encounter_id!).where('status', '=', 'requested').executeTakeFirst();
      if (open) throw new ConflictException('ამ პაციენტზე გადაყვანის მოთხოვნა უკვე გაგზავნილია');
    }
    if (dto.destination === 'icu') {
      const lvl = to?.care_level ?? (to ? null : cur?.care_level);
      if (!lvl || !['icu', 'intensive'].includes(lvl)) throw new BadRequestException('ICU — მიუთითეთ რეანიმაციის / ინტენსიური თერაპიის განყოფილება');
    } else if (to && ['icu', 'intensive'].includes(to.care_level ?? '')) {
      throw new BadRequestException('რეანიმაციის განყოფილებაში — მიმართულება „რეანიმაცია (ICU)“');
    }
    await this.or.recordTime(id, { kind: 'pacu_out', at: dto.at, destination: dto.destination, note: dto.note, to_department_id: to?.id }, u, ctx);
    const warnings: string[] = [];
    if (to) {
      try {
        const t = await this.transfers.request(c.encounter_id!, { to_department_id: to.id, reason: `PACU → ${DEST_KA[dto.destination]}: ოპერაცია ${c.case_no}${dto.note?.trim() ? ` — ${dto.note.trim()}` : ''}` },
          u, ctx, { authorized: true, source: 'pacu' });
        await this.db.updateTable('or_pacu').set({ transfer_id: t!.id }).where('case_id', '=', id).execute();
      } catch (e) {
        warnings.push(`გამოწერილია, მაგრამ გადაყვანის მოთხოვნა ვერ გაიგზავნა: ${(e as { message?: string }).message ?? e} — მოითხოვეთ ჰოსპიტალიზაციის გვერდიდან`);
      }
    }
    return { ...(await this.view(id, u)), warnings };
  }

  /** PACU-ს დაფა: PACU-ში მყოფი + მოსალოდნელი (ოთახიდან „PACU“ მიმართულებით, ჯერ შემოსვლის გარეშე) */
  async board(blockId?: string) {
    const s = await this.or.settings();
    const rows = await this.db.selectFrom('or_cases as c').innerJoin('patients as p', 'p.id', 'c.patient_id').innerJoin('users as su', 'su.id', 'c.surgeon_id')
      .leftJoin('or_rooms as r', 'r.id', 'c.room_id').leftJoin('or_pacu as e', 'e.case_id', 'c.id').leftJoin('users as n', 'n.id', 'e.nurse_id')
      .select(['c.id', 'c.case_no', 'c.encounter_id', 'c.anesthesia_type', 'c.needs_icu', 'p.first_name', 'p.last_name', 'p.gender', sql<number>`date_part('year', age(p.birth_date))::int`.as('age'),
        'r.code as room_code', 'e.bay', sql<string | null>`n.last_name || ' ' || n.first_name`.as('nurse_name'), sql<string>`su.last_name || ' ' || su.first_name`.as('surgeon_name'),
        sql<string>`(SELECT string_agg(pr.name, '; ' ORDER BY cp.is_primary DESC, cp.sort_order) FROM or_case_procedures cp JOIN or_procedures pr ON pr.id = cp.procedure_id WHERE cp.case_id = c.id)`.as('procedures'),
        sql<string | null>`(SELECT t.at FROM or_case_times t WHERE t.case_id = c.id AND t.kind = 'out_of_room' AND t.superseded_by IS NULL)`.as('out_of_room'),
        sql<string | null>`(SELECT t.at FROM or_case_times t WHERE t.case_id = c.id AND t.kind = 'pacu_in' AND t.superseded_by IS NULL)`.as('pacu_in'),
        sql<string | null>`(SELECT max(v.recorded_at) FROM encounter_vitals v WHERE v.or_case_id = c.id AND v.or_phase = 'pacu' AND v.voided_at IS NULL)`.as('last_vitals'),
        sql<number | null>`(SELECT v.pain FROM encounter_vitals v WHERE v.or_case_id = c.id AND v.or_phase = 'pacu' AND v.voided_at IS NULL AND v.pain IS NOT NULL ORDER BY v.recorded_at DESC LIMIT 1)`.as('last_pain'),
        sql<number | null>`(SELECT s.total FROM or_pacu_scores s WHERE s.case_id = c.id AND s.voided_at IS NULL ORDER BY s.recorded_at DESC LIMIT 1)`.as('aldrete'),
        sql<boolean>`e.case_id IS NOT NULL`.as('admitted')])
      .where('c.status', '=', 'completed')
      .where((eb) => eb.or([
        eb.and([eb('e.case_id', 'is not', null), eb('e.discharged_at', 'is', null)]),
        eb.and([eb('e.case_id', 'is', null), eb.exists(eb.selectFrom('or_case_times as t').select('t.id').whereRef('t.case_id', '=', 'c.id').where('t.kind', '=', 'out_of_room')
          .where('t.superseded_by', 'is', null).where('t.destination', '=', 'pacu').where('t.at', '>', sql<Date>`now() - interval '12 hours'`))]),
      ]))
      .$if(!!blockId, (x) => x.where('c.block_id', '=', blockId!))
      .orderBy(sql`coalesce((SELECT t.at FROM or_case_times t WHERE t.case_id = c.id AND t.kind = 'pacu_in' AND t.superseded_by IS NULL), now())`).execute();
    const now = Date.now();
    return {
      aldrete_min: s.pacu_aldrete_min, grid_min: PACU_GRID_MIN, now: new Date().toISOString(),
      rows: rows.map((r) => {
        const ref = r.last_vitals ?? r.pacu_in;
        return { ...r, minutes: r.pacu_in ? Math.round((now - new Date(r.pacu_in).getTime()) / 60000) : null,
          vitals_overdue: r.admitted && !!ref && now - new Date(ref).getTime() > (PACU_GRID_MIN + 5) * 60_000, ready: r.aldrete !== null && r.aldrete >= s.pacu_aldrete_min };
      }),
    };
  }
}

@Controller('or')
export class OrPacuController {
  constructor(private readonly s: OrPacuService) {}
  @Get('pacu') @Roles(...OR_READ) board(@Query('block_id') b?: string) {
    if (b && !/^[0-9a-f-]{36}$/i.test(b)) throw new BadRequestException('block_id');
    return this.s.board(b || undefined);
  }
  @Get('cases/:id/pacu') @Roles(...OR_READ) view(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser) { return this.s.view(id, u); }
  @Post('cases/:id/pacu/admit') @HttpCode(200) @Roles(...PACU_WRITE)
  admit(@Param('id', ParseUUIDPipe) id: string, @Body() d: PacuAdmitDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.admit(id, d, u, auditCtx(r)); }
  @Put('cases/:id/pacu') @Roles(...PACU_WRITE)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() d: PacuDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.update(id, d, u, auditCtx(r)); }
  @Post('cases/:id/pacu/vitals') @Roles(...PACU_WRITE)
  vitals(@Param('id', ParseUUIDPipe) id: string, @Body() d: PacuVitalsDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.vitals(id, d, u, auditCtx(r)); }
  @Post('pacu/vitals/:vid/void') @HttpCode(200) @Roles(...PACU_WRITE)
  voidVitals(@Param('vid', ParseUUIDPipe) vid: string, @Body() d: VoidDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.voidVitals(vid, d.reason, u, auditCtx(r)); }
  @Post('cases/:id/pacu/fluids') @Roles(...PACU_WRITE)
  fluid(@Param('id', ParseUUIDPipe) id: string, @Body() d: PacuFluidDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.fluid(id, d, u, auditCtx(r)); }
  @Post('pacu/fluids/:fid/void') @HttpCode(200) @Roles(...PACU_WRITE)
  voidFluid(@Param('fid', ParseUUIDPipe) fid: string, @Body() d: VoidDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.voidFluid(fid, d.reason, u, auditCtx(r)); }
  @Post('cases/:id/pacu/scores') @Roles(...PACU_WRITE)
  score(@Param('id', ParseUUIDPipe) id: string, @Body() d: AldreteDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.score(id, d, u, auditCtx(r)); }
  @Post('pacu/scores/:sid/void') @HttpCode(200) @Roles(...PACU_WRITE)
  voidScore(@Param('sid', ParseUUIDPipe) sid: string, @Body() d: VoidDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.voidScore(sid, d.reason, u, auditCtx(r)); }
  @Post('cases/:id/pacu/discharge') @HttpCode(200) @Roles(...PACU_WRITE)
  discharge(@Param('id', ParseUUIDPipe) id: string, @Body() d: PacuDischargeDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.discharge(id, d, u, auditCtx(r)); }
}
