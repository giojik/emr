import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min, ValidateIf, ValidateNested } from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/roles';
import { mapPgError } from '../common/pg-errors';
import { InjectDb, type Database } from '../database/database.module';
import { StockWitnessService, WitnessDto } from '../stock/stock-controlled';
import { StockOpsService } from '../stock/stock-ops';
import { OR_READ } from './or-admin';
import { ANESTHESIA, OrService } from './or';
import { orEvent, stockAt, type Ex } from './or-shared';

const num = ({ value }: { value: unknown }) => (value === '' || value === null || value === undefined ? undefined : Number(value));
const nul = ({ value }: { value: unknown }) => (value === '' ? null : value);
const GRID_MIN = 5;                                    // ვიტალების ბადე (წთ)
const CONTROLLED = ['narcotic', 'psychotropic'];       // მოწმე + ნარჩენი — ყოველთვის (არაარჩევადი)
export const FLUID_IN = ['iv', 'blood', 'other_in'] as const;
export const FLUID_OUT = ['urine', 'blood_loss', 'drain', 'other_out'] as const;

export class AnesthesiaDto {
  @IsOptional() @IsIn(ANESTHESIA) anesthesia_type?: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsIn(['none', 'nasal', 'mask', 'lma', 'ett', 'trach', 'other']) airway_device?: string | null;
  @IsOptional() @Transform(nul) @ValidateIf((_, v) => v !== null) @Transform(num) @IsNumber({ maxDecimalPlaces: 1 }) @Min(2) @Max(10) ett_size?: number | null;
  @IsOptional() @Transform(nul) @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) @Max(10) intubation_attempts?: number | null;
  @IsOptional() @Transform(nul) @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) @Max(4) cormack_lehane?: number | null;
  @IsOptional() @IsBoolean() difficult_airway?: boolean;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(2000) airway_notes?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(4000) technique_notes?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(300) position?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(4000) complications?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(4000) notes?: string | null;
}
export class VitalsDto {
  @IsDateString() at: string;
  @IsOptional() @Transform(num) @IsInt() @Min(30) @Max(300) systolic_bp?: number;
  @IsOptional() @Transform(num) @IsInt() @Min(10) @Max(200) diastolic_bp?: number;
  @IsOptional() @Transform(num) @IsInt() @Min(15) @Max(250) map_mmhg?: number;
  @IsOptional() @Transform(num) @IsInt() @Min(10) @Max(300) heart_rate?: number;
  @IsOptional() @Transform(num) @IsInt() @Min(40) @Max(100) spo2?: number;
  @IsOptional() @Transform(num) @IsInt() @Min(0) @Max(150) etco2?: number;
  @IsOptional() @Transform(num) @IsInt() @Min(0) @Max(80) respiratory_rate?: number;
  @IsOptional() @Transform(num) @IsNumber({ maxDecimalPlaces: 1 }) @Min(25) @Max(45) temperature?: number;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}
export class FluidDto {
  @IsIn([...FLUID_IN, ...FLUID_OUT]) category: string;
  @Transform(num) @IsNumber({ maxDecimalPlaces: 1 }) @Min(1) @Max(20000) volume_ml: number;
  @IsOptional() @IsDateString() at?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}
export class MedDto {
  @IsUUID() item_id: string;
  @Transform(num) @IsNumber({ maxDecimalPlaces: 4 }) @Min(0.0001) dose: number;
  @IsOptional() @IsString() @MaxLength(20) dose_unit?: string;
  @IsOptional() @IsString() @MaxLength(10) route_code?: string;
  @Transform(num) @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) @Max(10000) qty_base: number;
  @IsOptional() @IsDateString() given_at?: string;
  @IsOptional() @IsUUID() lot_id?: string;
  @IsOptional() @Transform(num) @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) dose_wasted?: number;
  @IsOptional() @ValidateNested() @Type(() => WitnessDto) witness?: WitnessDto;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}
export class VoidDto { @IsString() @Length(3, 500) reason: string }

/**
 * ანესთეზიის რუკა (0049, #9): ტიპი, სასუნთქი გზები, ტექნიკა; ვიტალები 5-წთ ბადეზე (encounter_vitals.or_case_id — 0047 ფურცლის ძრავა, ხელით);
 * სითხეები / სისხლის დაკარგვა / შარდი → fluid_entries (ჰოსპიტალიზაციის ბალანსი); მედიკამენტები — anesthesia_meds:
 *   direct — ჟურნალი + ხარჯი ბლოკის ლოკაციიდან (FEFO; ინვოისი კატეგორიის წესით); orders — CPOE → ვერიფიკაცია → MAR (აქ ჩანს ფანჯრის MAR); both.
 * ნარკოტიკული / ფსიქოტროპული — მოწმე + ნარჩენი ყოველთვის. ანესთეზიოლოგი ხელს აწერს → რუკა უცვლელია.
 */
@Injectable()
export class OrAnesthesiaService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService, private readonly or: OrService, private readonly stock: StockOpsService,
              private readonly witness: StockWitnessService) {}

  private async load(id: string, u: AuthUser, ex: Ex = this.db, lock = false) {
    const s = await this.or.settings();
    const c = await this.or.loadCase(id, ex, lock);
    const p = await this.or.perms(u, c, s, ex);
    return { s, c, p };
  }
  private async record(caseId: string, ex: Ex = this.db) {
    return ex.selectFrom('or_anesthesia_records').selectAll().where('case_id', '=', caseId).executeTakeFirst();
  }
  /** ჩაწერა შესაძლებელია: უფლება + მიმდინარე / დასრულებული + ხელმოუწერელი რუკა */
  private async writable(id: string, u: AuthUser, ex: Ex) {
    const x = await this.load(id, u, ex, true);
    if (!x.p.anesthesia) throw new ForbiddenException('ანესთეზიის რუკა — ანესთეზიოლოგი / ანესთეზიის ექთანი (გუნდში)');
    if (!['in_progress', 'completed'].includes(x.c.status)) throw new ConflictException('ანესთეზიის რუკა — დაწყებულ ოპერაციაზე („საოპერაციოში შემოვიდა“)');
    if (!x.c.encounter_id) throw new ConflictException('ჰოსპიტალიზაცია არ არის');
    const r = await this.record(id, ex);
    if (r?.status === 'signed') throw new ConflictException('ანესთეზიის რუკა ხელმოწერილია — ცვლილება შეუძლებელია');
    return { ...x, r };
  }
  private async window(caseId: string, ex: Ex = this.db) {
    const t = await ex.selectFrom('or_case_times').select(['kind', 'at']).where('case_id', '=', caseId).where('superseded_by', 'is', null).execute();
    const m = new Map(t.map((x) => [x.kind, new Date(x.at)]));
    return { start: m.get('in_room') ?? null, anesthesia_start: m.get('anesthesia_start') ?? null, anesthesia_end: m.get('anesthesia_end') ?? null, end: m.get('out_of_room') ?? null };
  }

  async view(id: string, u: AuthUser) {
    const { s, c, p } = await this.load(id, u);
    const [rec, vitals, fluids, meds, win, loc] = await Promise.all([
      this.db.selectFrom('or_anesthesia_records as a').leftJoin('users as cb', 'cb.id', 'a.created_by').leftJoin('users as sb', 'sb.id', 'a.signed_by').selectAll('a')
        .select([sql<string>`cb.last_name || ' ' || cb.first_name`.as('created_by_name'), sql<string | null>`sb.last_name || ' ' || sb.first_name`.as('signed_by_name')])
        .where('a.case_id', '=', id).executeTakeFirst(),
      this.db.selectFrom('encounter_vitals as v').leftJoin('users as x', 'x.id', 'v.taken_by')
        .select(['v.id', 'v.recorded_at', 'v.systolic_bp', 'v.diastolic_bp', 'v.map_mmhg', 'v.heart_rate', 'v.spo2', 'v.etco2', 'v.respiratory_rate', 'v.temperature', 'v.notes',
          'v.voided_at', 'v.void_reason', sql<string | null>`x.last_name || ' ' || x.first_name`.as('by_name')])
        .where('v.or_case_id', '=', id).orderBy('v.recorded_at').execute(),
      this.db.selectFrom('fluid_entries as f').leftJoin('users as x', 'x.id', 'f.created_by')
        .select(['f.id', 'f.direction', 'f.category', 'f.volume_ml', 'f.recorded_at', 'f.note', 'f.voided_at', 'f.void_reason', sql<string>`x.last_name || ' ' || x.first_name`.as('by_name')])
        .where('f.or_case_id', '=', id).orderBy('f.recorded_at').execute(),
      this.db.selectFrom('or_anesthesia_meds as m').innerJoin('users as x', 'x.id', 'm.recorded_by').leftJoin('users as w', 'w.id', 'm.witness_id').leftJoin('stock_docs as d', 'd.id', 'm.stock_doc_id')
        .leftJoin('med_routes as rt', 'rt.code', 'm.route_code')
        .select(['m.id', 'm.given_at', 'm.item_id', 'm.name', 'm.dose', 'm.dose_unit', 'm.route_code', 'rt.name as route_name', 'm.qty_base', 'm.dose_wasted', 'm.controlled', 'm.note', 'd.doc_no',
          sql<string>`x.last_name || ' ' || x.first_name`.as('by_name'), sql<string | null>`w.last_name || ' ' || w.first_name`.as('witness_name')])
        .where('m.case_id', '=', id).orderBy('m.given_at').execute(),
      this.window(id),
      c.block_id ? this.db.selectFrom('departments as d').leftJoin('stock_locations as l', 'l.id', 'd.or_stock_location_id').select(['l.id', 'l.name']).where('d.id', '=', c.block_id).executeTakeFirst() : null,
    ]);
    // orders / both: ოპერაციის ფანჯარაში MAR-ის ჩანაწერები (CPOE → ვერიფიკაცია → MAR)
    const mar = s.anesthesia_meds !== 'direct' && c.encounter_id && win.start ? await this.db.selectFrom('mar_entries as m').innerJoin('med_orders as o', 'o.id', 'm.order_id')
      .leftJoin('med_generics as g', 'g.id', 'o.generic_id').leftJoin('users as x', 'x.id', 'm.documented_by')
      .select(['m.id', 'm.documented_at', 'm.status', 'm.dose_given', 'm.dose_unit', 'm.route_code', sql<string>`coalesce(g.inn, o.drug_text, '—')`.as('name'),
        sql<string | null>`x.last_name || ' ' || x.first_name`.as('by_name')])
      .where('m.encounter_id', '=', c.encounter_id).where('m.status', 'in', ['given', 'partial']).where('m.voided_at', 'is', null)
      .where('m.documented_at', '>=', win.start).where('m.documented_at', '<=', win.end ?? new Date()).orderBy('m.documented_at').execute() : [];
    const live = fluids.filter((f) => !f.voided_at);
    const sum = (d: string) => live.filter((f) => f.direction === d).reduce((a, f) => a + Number(f.volume_ml), 0);
    const byCat = Object.fromEntries([...FLUID_IN, ...FLUID_OUT].map((k) => [k, live.filter((f) => f.category === k).reduce((a, f) => a + Number(f.volume_ml), 0)]));
    return { case_id: id, case_no: c.case_no, status: c.status, planned_anesthesia: c.anesthesia_type, record: rec ?? null, vitals, fluids, meds, mar, window: win,
      balance: { in: sum('in'), out: sum('out'), net: sum('in') - sum('out'), by_category: byCat }, location: loc?.id ? loc : null, grid_min: GRID_MIN,
      meds_mode: s.anesthesia_meds, can: { edit: p.anesthesia && rec?.status !== 'signed' && ['in_progress', 'completed'].includes(c.status), sign: p.anesthesia_sign && rec?.status !== 'signed' } };
  }

  async save(id: string, dto: AnesthesiaDto, u: AuthUser, ctx: AuditContext) {
    await this.db.transaction().execute(async (trx) => {
      const { c, r } = await this.writable(id, u, trx);
      const v = {
        ...(dto.anesthesia_type !== undefined && { anesthesia_type: dto.anesthesia_type }), ...(dto.airway_device !== undefined && { airway_device: dto.airway_device }),
        ...(dto.ett_size !== undefined && { ett_size: dto.ett_size === null ? null : String(dto.ett_size) }),
        ...(dto.intubation_attempts !== undefined && { intubation_attempts: dto.intubation_attempts }), ...(dto.cormack_lehane !== undefined && { cormack_lehane: dto.cormack_lehane }),
        ...(dto.difficult_airway !== undefined && { difficult_airway: dto.difficult_airway }), ...(dto.airway_notes !== undefined && { airway_notes: dto.airway_notes?.trim() || null }),
        ...(dto.technique_notes !== undefined && { technique_notes: dto.technique_notes?.trim() || null }), ...(dto.position !== undefined && { position: dto.position?.trim() || null }),
        ...(dto.complications !== undefined && { complications: dto.complications?.trim() || null }), ...(dto.notes !== undefined && { notes: dto.notes?.trim() || null }),
      };
      const dev = dto.airway_device !== undefined ? dto.airway_device : r?.airway_device;
      if (dev !== 'ett') Object.assign(v, { ett_size: null, intubation_attempts: null });
      if (r) await trx.updateTable('or_anesthesia_records').set(v).where('id', '=', r.id).execute();
      else await trx.insertInto('or_anesthesia_records').values({ anesthesia_type: c.anesthesia_type, ...v, case_id: c.id, patient_id: c.patient_id, created_by: u.id }).execute();
      await this.audit.log(ctx, { action: 'OR_ANESTHESIA_SAVE', entityName: 'or_anesthesia_records', entityId: c.id, newData: dto }, trx);
    });
    return this.view(id, u);
  }

  async sign(id: string, u: AuthUser, ctx: AuditContext) {
    await this.db.transaction().execute(async (trx) => {
      const { c, p, r } = await this.writable(id, u, trx);
      if (!p.anesthesia_sign) throw new ForbiddenException('ანესთეზიის რუკას ხელს აწერს ანესთეზიოლოგი');
      if (!r) throw new BadRequestException('ანესთეზიის რუკა ჯერ არ არის შევსებული');
      const miss: string[] = [];
      if (r.anesthesia_type === 'general' && !r.airway_device) miss.push('სასუნთქი გზები (ზოგადი ანესთეზია)');
      const w = await this.window(c.id, trx);
      if (w.anesthesia_start && !w.anesthesia_end) miss.push('ნიშნული „ანესთეზიის დასრულება“');
      const nv = await trx.selectFrom('encounter_vitals').select(sql<number>`count(*)::int`.as('n')).where('or_case_id', '=', c.id).where('voided_at', 'is', null).executeTakeFirstOrThrow();
      if (!['local', 'none'].includes(r.anesthesia_type) && !nv.n) miss.push('ვიტალები (მინიმუმ ერთი ჩანაწერი)');
      if (miss.length) throw new BadRequestException({ code: 'ANESTHESIA_INCOMPLETE', message: `ხელმოწერისთვის აკლია: ${miss.join('; ')}`, missing: miss });
      await trx.updateTable('or_anesthesia_records').set({ status: 'signed', signed_by: u.id, signed_at: sql`now()` }).where('id', '=', r.id).execute();
      await orEvent(trx, c, 'anesthesia_signed', { type: r.anesthesia_type, vitals: nv.n }, u.id);
      await this.audit.log(ctx, { action: 'OR_ANESTHESIA_SIGN', entityName: 'or_anesthesia_records', entityId: r.id }, trx);
    });
    return this.view(id, u);
  }

  /** ვიტალები — 5-წთ ბადის სლოტზე (ოპერაციის ფანჯარაში) */
  async vitals(id: string, dto: VitalsDto, u: AuthUser, ctx: AuditContext) {
    const at = new Date(dto.at);
    if (at.getUTCSeconds() || at.getUTCMilliseconds() || at.getUTCMinutes() % GRID_MIN) throw new BadRequestException(`დრო — ${GRID_MIN}-წუთიანი ბადის სლოტზე (მაგ. 10:05, 10:10)`);
    const vals = ['systolic_bp', 'diastolic_bp', 'map_mmhg', 'heart_rate', 'spo2', 'etco2', 'respiratory_rate', 'temperature'] as const;
    if (!vals.some((k) => dto[k] !== undefined)) throw new BadRequestException('შეიყვანეთ მინიმუმ ერთი მაჩვენებელი');
    if (dto.systolic_bp !== undefined && dto.diastolic_bp !== undefined && dto.diastolic_bp >= dto.systolic_bp) throw new BadRequestException('დიასტოლური ≥ სისტოლურზე');
    try {
      await this.db.transaction().execute(async (trx) => {
        const { c } = await this.writable(id, u, trx);
        const w = await this.window(c.id, trx);
        if (!w.start) throw new ConflictException('ჯერ — „საოპერაციოში შემოვიდა“');
        if (at.getTime() < w.start.getTime() - 30 * 60_000) throw new BadRequestException('დრო ოპერაციის დაწყებამდე (> 30 წთ) — ანესთეზიის რუკის გარეთაა');
        if (at.getTime() > Date.now() + 5 * 60_000) throw new BadRequestException('დრო მომავალშია');
        if (w.end && at.getTime() > w.end.getTime() + 30 * 60_000) throw new BadRequestException('დრო ოთახიდან გასვლის შემდეგ (> 30 წთ) — PACU-ს ჩანაწერია');
        const r = await trx.insertInto('encounter_vitals').values({ encounter_id: c.encounter_id!, or_case_id: c.id, recorded_at: at, taken_by: u.id, source: 'manual',
          systolic_bp: dto.systolic_bp ?? null, diastolic_bp: dto.diastolic_bp ?? null, map_mmhg: dto.map_mmhg ?? (dto.systolic_bp && dto.diastolic_bp ? Math.round((dto.systolic_bp + 2 * dto.diastolic_bp) / 3) : null),
          heart_rate: dto.heart_rate ?? null, spo2: dto.spo2 ?? null, etco2: dto.etco2 ?? null, respiratory_rate: dto.respiratory_rate ?? null,
          temperature: dto.temperature === undefined ? null : String(dto.temperature), notes: dto.notes?.trim() || null }).returning('id').executeTakeFirstOrThrow();
        await this.audit.log(ctx, { action: 'OR_ANESTHESIA_VITALS', entityName: 'encounter_vitals', entityId: r.id, newData: dto }, trx);
      });
    } catch (e) { mapPgError(e, { ux_vitals_or_slot: 'ამ სლოტზე ვიტალები უკვე ჩაწერილია — შესწორებისთვის გააუქმეთ (მიზეზით)' }); }
    return this.view(id, u);
  }

  async voidVitals(vid: string, reason: string, u: AuthUser, ctx: AuditContext) {
    const v = await this.db.selectFrom('encounter_vitals').select(['id', 'or_case_id', 'voided_at']).where('id', '=', vid).executeTakeFirst();
    if (!v?.or_case_id || v.voided_at) throw new NotFoundException('ჩანაწერი ვერ მოიძებნა');
    await this.db.transaction().execute(async (trx) => {
      await this.writable(v.or_case_id!, u, trx);
      await trx.updateTable('encounter_vitals').set({ voided_at: sql`now()`, voided_by: u.id, void_reason: reason }).where('id', '=', vid).execute();
      await this.audit.log(ctx, { action: 'OR_ANESTHESIA_VITALS_VOID', entityName: 'encounter_vitals', entityId: vid, newData: { reason } }, trx);
    });
    return this.view(v.or_case_id, u);
  }

  /** სითხეები (მიღება) / სისხლის დაკარგვა, შარდი, დრენაჟი (გამოყოფა) → ჰოსპიტალიზაციის ბალანსი */
  async fluid(id: string, dto: FluidDto, u: AuthUser, ctx: AuditContext) {
    await this.db.transaction().execute(async (trx) => {
      const { c } = await this.writable(id, u, trx);
      const at = dto.at ? new Date(dto.at) : new Date();
      if (at.getTime() > Date.now() + 5 * 60_000) throw new BadRequestException('დრო მომავალშია');
      const w = await this.window(c.id, trx);
      if (w.start && at.getTime() < w.start.getTime() - 30 * 60_000) throw new BadRequestException('დრო ოპერაციის დაწყებამდეა');
      const r = await trx.insertInto('fluid_entries').values({ encounter_id: c.encounter_id!, patient_id: c.patient_id, or_case_id: c.id, direction: (FLUID_IN as readonly string[]).includes(dto.category) ? 'in' : 'out',
        category: dto.category, volume_ml: String(dto.volume_ml), recorded_at: at, note: dto.note?.trim() || null, created_by: u.id }).returning('id').executeTakeFirstOrThrow();
      await this.audit.log(ctx, { action: 'OR_ANESTHESIA_FLUID', entityName: 'fluid_entries', entityId: r.id, newData: dto }, trx);
    });
    return this.view(id, u);
  }

  async voidFluid(fid: string, reason: string, u: AuthUser, ctx: AuditContext) {
    const f = await this.db.selectFrom('fluid_entries').select(['id', 'or_case_id', 'voided_at']).where('id', '=', fid).executeTakeFirst();
    if (!f?.or_case_id || f.voided_at) throw new NotFoundException('ჩანაწერი ვერ მოიძებნა');
    await this.db.transaction().execute(async (trx) => {
      await this.writable(f.or_case_id!, u, trx);
      await trx.updateTable('fluid_entries').set({ voided_at: sql`now()`, voided_by: u.id, void_reason: reason }).where('id', '=', fid).execute();
      await this.audit.log(ctx, { action: 'OR_ANESTHESIA_FLUID_VOID', entityName: 'fluid_entries', entityId: fid, newData: { reason } }, trx);
    });
    return this.view(f.or_case_id, u);
  }

  /** მედიკამენტი (direct / both): ჟურნალი + ხარჯი ბლოკის ლოკაციიდან; ნარკოტიკული / ფსიქოტროპული — მოწმე + ნარჩენი */
  async med(id: string, dto: MedDto, u: AuthUser, ctx: AuditContext) {
    const { s, c, p } = await this.load(id, u);
    if (s.anesthesia_meds === 'orders') throw new ConflictException({ code: 'MEDS_VIA_ORDERS', message: 'მედიკამენტები — დანიშნულებით (CPOE → ვერიფიკაცია → MAR); პირდაპირი ჟურნალი გამორთულია' });
    if (!p.anesthesia) throw new ForbiddenException('ანესთეზიის რუკა — ანესთეზიოლოგი / ანესთეზიის ექთანი (გუნდში)');
    if (!['in_progress', 'completed'].includes(c.status) || !c.encounter_id) throw new ConflictException('მედიკამენტი — დაწყებულ ოპერაციაზე');
    const rec = await this.record(id);
    if (rec?.status === 'signed') throw new ConflictException('ანესთეზიის რუკა ხელმოწერილია — ცვლილება შეუძლებელია');
    const loc = c.block_id ? await this.db.selectFrom('departments').select('or_stock_location_id').where('id', '=', c.block_id).executeTakeFirst() : null;
    if (!loc?.or_stock_location_id) throw new ConflictException({ code: 'NO_BLOCK_LOCATION', message: 'ბლოკს საწყობის ლოკაცია არ აქვს (ადმინისტრირება → საოპერაციო → ბლოკი)' });
    const it = await this.db.selectFrom('stock_items as i').leftJoin('med_generics as g', 'g.id', 'i.generic_id').innerJoin('stock_categories as k', 'k.id', 'i.category_id')
      .select(['i.id', 'i.name', 'i.is_active', 'k.kind', 'g.controlled_class', 'g.dose_unit', 'g.dose_per_unit']).where('i.id', '=', dto.item_id).executeTakeFirst();
    if (!it?.is_active) throw new BadRequestException('საქონელი ვერ მოიძებნა ან გათიშულია');
    if (it.kind !== 'medication') throw new BadRequestException('ანესთეზიის რუკაში — მედიკამენტი (მასალები — „მასალები“ ჩანართში)');
    const controlled = CONTROLLED.includes(it.controlled_class ?? '');
    if (dto.route_code && !(await this.db.selectFrom('med_routes').select('code').where('code', '=', dto.route_code).executeTakeFirst())) throw new BadRequestException('მიღების გზა ვერ მოიძებნა');
    const unit = dto.dose_unit?.trim() || it.dose_unit || null;
    if (controlled) {
      if (!dto.witness?.username || !dto.witness.password) throw new BadRequestException({ code: 'WITNESS_REQUIRED', message: `„${it.name}“ — კონტროლირებადი: საჭიროა მოწმე (მომხმარებელი და პაროლი)` });
      if (dto.dose_wasted === undefined) throw new BadRequestException({ code: 'WASTE_REQUIRED', message: `„${it.name}“ — მიუთითეთ ნარჩენი (განადგურებული; 0 თუ არ არის)` });
    }
    if (it.dose_per_unit && unit === it.dose_unit && (controlled || dto.dose_wasted !== undefined)) {
      const total = Math.round(Number(it.dose_per_unit) * dto.qty_base * 1000) / 1000; const used = Math.round((dto.dose + (dto.dose_wasted ?? 0)) * 1000) / 1000;
      if (Math.abs(total - used) > 0.001) throw new BadRequestException(`„${it.name}“: დოზა + ნარჩენი (${used}) ≠ ${dto.qty_base} × ${Number(it.dose_per_unit)} = ${total} ${unit ?? ''}`);
    }
    const givenAt = dto.given_at ? new Date(dto.given_at) : new Date();
    if (givenAt.getTime() > Date.now() + 5 * 60_000) throw new BadRequestException('დრო მომავალშია');
    const doseFields = controlled || dto.dose_wasted !== undefined ? { dose_given: dto.dose, dose_wasted: dto.dose_wasted ?? 0 } : {};
    // არაარჩევადი: მოწმე მოწმდება აქ (კლინიკის stock.witness_classes-ისგან დამოუკიდებლად); ხარჯი თავად — წესის მიხედვით
    const witnessId = controlled ? (await this.witness.verify(dto.witness, u, ctx, 'or_anesthesia')).id : null;
    await this.stock.createConsumption({ location_id: loc.or_stock_location_id, patient_id: c.patient_id, encounter_id: c.encounter_id, notes: `ანესთეზია — ${c.case_no}`,
      witness: dto.witness ?? null, lines: [{ item_id: it.id, qty_base: dto.qty_base, lot_id: dto.lot_id ?? null, ...doseFields }] }, u, ctx, async (trx, docId) => {
      const cur = await trx.selectFrom('or_anesthesia_records').select('status').where('case_id', '=', c.id).forUpdate().executeTakeFirst();
      if (cur?.status === 'signed') throw new ConflictException('ანესთეზიის რუკა ხელმოწერილია');
      await trx.insertInto('or_anesthesia_meds').values({ case_id: c.id, given_at: givenAt, item_id: it.id, name: it.name, dose: String(dto.dose), dose_unit: unit,
        route_code: dto.route_code ?? null, qty_base: String(dto.qty_base), dose_wasted: dto.dose_wasted === undefined ? null : String(dto.dose_wasted), controlled, witness_id: witnessId,
        stock_doc_id: docId, note: dto.note?.trim() || null, recorded_by: u.id }).execute();
      await orEvent(trx, c, 'anesthesia_med', { name: it.name, dose: dto.dose, unit, controlled }, u.id);
    }, { authorized: true });
    return this.view(id, u);
  }

  /** ბლოკის ლოკაციის მედიკამენტები (ნაშთით) */
  async stock_(id: string, q: string | undefined) {
    const c = await this.or.loadCase(id);
    const loc = c.block_id ? await this.db.selectFrom('departments').select('or_stock_location_id').where('id', '=', c.block_id).executeTakeFirst() : null;
    if (!loc?.or_stock_location_id) return [];
    return stockAt(this.db, loc.or_stock_location_id, q, ['medication']);
  }
}

@Controller('or')
export class OrAnesthesiaController {
  constructor(private readonly s: OrAnesthesiaService) {}
  @Get('cases/:id/anesthesia') @Roles(...OR_READ) view(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser) { return this.s.view(id, u); }
  @Get('cases/:id/anesthesia/stock') @Roles('admin', 'anesthesiologist', 'or_nurse') stock(@Param('id', ParseUUIDPipe) id: string, @Query('q') q?: string) { return this.s.stock_(id, q); }
  @Put('cases/:id/anesthesia') @Roles('admin', 'anesthesiologist', 'or_nurse')
  save(@Param('id', ParseUUIDPipe) id: string, @Body() d: AnesthesiaDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.save(id, d, u, auditCtx(r)); }
  @Post('cases/:id/anesthesia/sign') @HttpCode(200) @Roles('admin', 'anesthesiologist')
  sign(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.sign(id, u, auditCtx(r)); }
  @Post('cases/:id/anesthesia/vitals') @Roles('admin', 'anesthesiologist', 'or_nurse')
  vitals(@Param('id', ParseUUIDPipe) id: string, @Body() d: VitalsDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.vitals(id, d, u, auditCtx(r)); }
  @Post('anesthesia/vitals/:vid/void') @HttpCode(200) @Roles('admin', 'anesthesiologist', 'or_nurse')
  voidVitals(@Param('vid', ParseUUIDPipe) vid: string, @Body() d: VoidDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.voidVitals(vid, d.reason, u, auditCtx(r)); }
  @Post('cases/:id/anesthesia/fluids') @Roles('admin', 'anesthesiologist', 'or_nurse')
  fluid(@Param('id', ParseUUIDPipe) id: string, @Body() d: FluidDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.fluid(id, d, u, auditCtx(r)); }
  @Post('anesthesia/fluids/:fid/void') @HttpCode(200) @Roles('admin', 'anesthesiologist', 'or_nurse')
  voidFluid(@Param('fid', ParseUUIDPipe) fid: string, @Body() d: VoidDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.voidFluid(fid, d.reason, u, auditCtx(r)); }
  @Post('cases/:id/anesthesia/meds') @Roles('admin', 'anesthesiologist', 'or_nurse')
  med(@Param('id', ParseUUIDPipe) id: string, @Body() d: MedDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.med(id, d, u, auditCtx(r)); }
}
