import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, Module, NotFoundException, Param, ParseUUIDPipe,
  Post, Query, Req } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min, ValidateNested } from 'class-validator';
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
import { NotificationsService } from '../notifications/notifications';
import { InpatientModule, InpatientService, type InpatientSettings } from './inpatient';
import { news2, NEWS2_KA, NEWS2_RANK, type News2Level } from './news2';

type Trx = Transaction<DB>;
type Ex = Database | Trx;
const TZ = loadEnv().CLINIC_TZ;
const num = ({ value }: { value: unknown }) => (value === '' || value === null || value === undefined ? undefined : Number(value));
const READ = ['admin', 'doctor', 'nurse', 'manager', 'pharmacist'] as const;
const WRITE = ['admin', 'doctor', 'nurse'] as const;
export const LINE_KA: Record<string, string> = {
  pvc: 'პერიფერიული ვენური კათეტერი', cvc: 'ცენტრალური ვენური კათეტერი', picc: 'PICC', arterial: 'არტერიული კათეტერი', urinary: 'შარდის კათეტერი',
  ng_tube: 'ნაზოგასტრული ზონდი', drain: 'დრენაჟი', trach: 'ტრაქეოსტომა', other: 'სხვა',
};
const FLUID_IN = ['po', 'iv', 'tube', 'blood', 'other_in'] as const;
const FLUID_OUT = ['urine', 'drain', 'vomit', 'stool', 'other_out'] as const;

// ================================================================= DTO
export class NVitalsDto {
  @IsOptional() @IsDateString() recorded_at?: string;
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
  @IsOptional() @Transform(num) @IsNumber({ maxDecimalPlaces: 1 }) @Min(20) @Max(250) height_cm?: number;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  @IsOptional() @IsUUID() mar_entry_id?: string;
}
export class FluidDto {
  @IsIn([...FLUID_IN, ...FLUID_OUT]) category: (typeof FLUID_IN)[number] | (typeof FLUID_OUT)[number];
  @Transform(num) @IsNumber() @Min(1) @Max(20000) volume_ml: number;
  @IsOptional() @IsDateString() recorded_at?: string;
  @IsOptional() @IsUUID() order_id?: string;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
  @IsOptional() @IsUUID() mar_entry_id?: string;
}
export class ScaleDto {
  @IsString() @Length(2, 20) scale_code: string;
  @IsObject() answers: Record<string, number>;
  @IsOptional() @IsDateString() assessed_at?: string;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
  @IsOptional() @IsUUID() mar_entry_id?: string;
}
export class LineDto {
  @IsIn(Object.keys(LINE_KA)) kind: string;
  @IsOptional() @IsString() @MaxLength(200) site?: string;
  @IsOptional() @IsString() @MaxLength(40) size?: string;
  @IsOptional() @IsString() @MaxLength(1000) details?: string;
  @IsOptional() @IsDateString() inserted_at?: string;
  @IsOptional() @IsString() @MaxLength(200) inserted_where?: string;
}
export class LineRemoveDto {
  @IsOptional() @IsDateString() removed_at?: string;
  @IsOptional() @IsString() @MaxLength(1000) reason?: string;
}
class SbarDto {
  @IsOptional() @IsString() @MaxLength(4000) s?: string;
  @IsOptional() @IsString() @MaxLength(4000) b?: string;
  @IsOptional() @IsString() @MaxLength(4000) a?: string;
  @IsOptional() @IsString() @MaxLength(4000) r?: string;
}
export class NoteDto {
  @IsIn(['note', 'handover']) kind: 'note' | 'handover';
  @IsOptional() @IsString() @Length(2, 8000) text?: string;
  @IsOptional() @ValidateNested() @Type(() => SbarDto) sbar?: SbarDto;
}
export class VoidDto { @IsString() @Length(3, 1000) reason: string }

interface ScaleItem { key: string; label: string; options: { label: string; points: number }[] }
interface ScaleBand { min: number; max: number; label: string; level: 'none' | 'low' | 'medium' | 'high' }

/**
 * ექთნის დოკუმენტაცია (0044): ვიტალები + NEWS2, სითხის ბალანსი, შკალები, ხაზები / დრენაჟები, ჩანაწერები, ცვლის გადაბარება.
 *   წერს მიმდინარე განყოფილების ექთანი / ექიმი (admin); ჩანაწერები არ რედაქტირდება — გაუქმება მიზეზით (DB trigger).
 *   MAR-ის მოვლის დავალება (nursing_task) ფორმის შევსებით სრულდება იმავე ტრანზაქციაში.
 *   NEWS2 — მხოლოდ მინიშნება / შეტყობინება (არაფერს ბლოკავს).
 */
@Injectable()
export class NursingService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService, private readonly ipd: InpatientService,
              private readonly bell: NotificationsService) {}

  // ---------------------------------------------------------------- საერთო
  private async stay(encounterId: string, ex: Ex = this.db) {
    const st = await ex.selectFrom('inpatient_stays as st').innerJoin('patients as p', 'p.id', 'st.patient_id').innerJoin('encounters as e', 'e.id', 'st.encounter_id')
      .select(['st.encounter_id', 'st.patient_id', 'st.status', 'st.adm_no', 'st.admitted_at', 'p.first_name', 'p.last_name', 'p.birth_date', 'e.attending_doctor_id',
        sql<string | null>`(SELECT a.department_id FROM bed_assignments a WHERE a.encounter_id = st.encounter_id AND a.ended_at IS NULL LIMIT 1)`.as('department_id'),
        sql<number>`extract(year FROM age(p.birth_date))::int`.as('age')])
      .where('st.encounter_id', '=', encounterId).executeTakeFirst();
    if (!st) throw new NotFoundException('ჰოსპიტალიზაცია ვერ მოიძებნა');
    return st;
  }
  private async canWrite(u: AuthUser, departmentId: string | null) {
    if (has(u, 'admin')) return true;
    if (!departmentId || !has(u, 'nurse', 'doctor')) return false;
    return (await this.ipd.me(u)).department_id === departmentId;
  }
  private async writable(encounterId: string, u: AuthUser, ex: Ex = this.db) {
    const st = await this.stay(encounterId, ex);
    if (st.status !== 'active') throw new ConflictException('ჰოსპიტალიზაცია აქტიური არ არის');
    if (!(await this.canWrite(u, st.department_id))) throw new ForbiddenException('ჩაწერს მიმდინარე განყოფილების ექთანი ან ექიმი');
    return st;
  }
  private when(iso: string | undefined, label = 'დრო') {
    const at = iso ? new Date(iso) : new Date();
    if (at.getTime() > Date.now() + 5 * 60_000) throw new BadRequestException(`${label} მომავალშია`);
    if (at.getTime() < Date.now() - 72 * 3_600_000) throw new BadRequestException(`${label}: 72 სთ-ზე ძველი ჩანაწერი — მიმართეთ ხელმძღვანელს`);
    return at;
  }
  private name(st: { last_name: string; first_name: string; adm_no: string }) { return `${st.last_name} ${st.first_name} (${st.adm_no})`; }

  /** MAR-ის მოვლის დავალების შესრულება ფორმიდან (იმავე ტრანზაქციაში) */
  private async completeTask(trx: Trx, entryId: string, encounterId: string, task: 'vitals' | 'fluid' | 'scale', at: Date, u: AuthUser, scaleCode?: string) {
    const e = await trx.selectFrom('mar_entries as m').innerJoin('med_orders as o', 'o.id', 'm.order_id')
      .select(['m.id', 'm.status', 'm.voided_at', 'm.encounter_id', 'm.scheduled_at', 'm.order_id', 'o.nursing_task', 'o.task_scale_code', 'o.status as order_status'])
      .where('m.id', '=', entryId).forUpdate().executeTakeFirst();
    if (!e || e.voided_at || e.encounter_id !== encounterId) throw new BadRequestException('MAR დავალება ვერ მოიძებნა');
    if (e.nursing_task !== task || (scaleCode && e.task_scale_code !== scaleCode)) throw new BadRequestException('MAR დავალება სხვა ტიპისაა');
    if (!['due', 'missed'].includes(e.status)) throw new ConflictException('MAR დავალება უკვე ჩაწერილია');
    const s = await this.ipd.settings();
    const diff = e.scheduled_at ? (at.getTime() - new Date(e.scheduled_at).getTime()) / 60_000 : 0;
    const timing = diff < -s.mar_window_min ? 'early' : diff > s.mar_window_min ? 'late' : 'on_time';
    await trx.updateTable('mar_entries').set({ status: 'given', documented_at: at, documented_by: u.id, recorded_at: new Date(), timing }).where('id', '=', entryId).execute();
    await trx.insertInto('med_order_events').values({ order_id: e.order_id, kind: 'administered', data: JSON.stringify({ entry_id: entryId, outcome: 'given', task }), user_id: u.id }).execute();
  }

  // ---------------------------------------------------------------- ვიტალები
  async addVitals(encounterId: string, dto: NVitalsDto, u: AuthUser, ctx: AuditContext) {
    const s = await this.ipd.settings();
    const { mar_entry_id, recorded_at, notes, ...vals } = dto;
    const filled = Object.entries(vals).filter(([k, v]) => v !== undefined && !['spo2_scale', 'o2_flow'].includes(k));
    if (!filled.length) throw new BadRequestException('მინიმუმ ერთი პარამეტრი');
    if (dto.systolic_bp && dto.diastolic_bp && dto.diastolic_bp >= dto.systolic_bp) throw new BadRequestException('დიასტოლური წნევა სისტოლურზე ნაკლები უნდა იყოს');
    if (dto.o2_flow && dto.o2_supplement === false) throw new BadRequestException('ჟანგბადის ნაკადი — მხოლოდ ჟანგბადის მიწოდებისას');
    const at = this.when(recorded_at);
    const res = await this.db.transaction().execute(async (trx) => {
      const st = await this.writable(encounterId, u, trx);
      const n = s.news2_enabled && st.age >= 16 ? news2(dto) : null;
      const prev = await trx.selectFrom('encounter_vitals').select(['news2_level', 'recorded_at']).where('encounter_id', '=', encounterId)
        .where('voided_at', 'is', null).where('news2_level', 'is not', null).orderBy('recorded_at', 'desc').limit(1).executeTakeFirst();
      let v;
      try {
        v = await trx.insertInto('encounter_vitals').values({
          encounter_id: encounterId, taken_by: u.id, recorded_at: at, ...vals, spo2_scale: dto.spo2_scale ?? 1,
          temperature: dto.temperature?.toFixed(1), weight_kg: dto.weight_kg?.toFixed(2), height_cm: dto.height_cm?.toFixed(1),
          o2_flow: dto.o2_flow?.toString(), glucose: dto.glucose?.toFixed(1), notes: notes?.trim() || null,
          news2: n?.score ?? null, news2_parts: n ? JSON.stringify(n.parts) : null, news2_level: n?.level ?? null, mar_entry_id: mar_entry_id ?? null,
        }).returningAll().executeTakeFirstOrThrow();
      } catch (e) { mapPgError(e, { chk_vitals_ranges: 'მნიშვნელობა ფიზიოლოგიურ საზღვრებს სცდება — გადაამოწმეთ' }); }
      if (mar_entry_id) await this.completeTask(trx, mar_entry_id, encounterId, 'vitals', at, u);
      await this.audit.log(ctx, { action: 'IPD_VITALS', entityName: 'encounter_vitals', entityId: v.id, newData: { ...dto, news2: n } }, trx);
      // შეტყობინება: დონე ≥ low_red (ერთ პარამეტრზე 3) / ქულა ≥ news2_alert — თუ წინაზე მაღალია ან წინა 4 სთ-ზე ძველია
      const alert = n && (n.score >= s.news2_alert || n.level === 'low_red' || n.level === 'medium' || n.level === 'high');
      // 0047: რეანიმაციაში / ინტენსიურში NEWS2-ის შეტყობინება — icu.news2_alerts (ნაგულისხმევად გამორთული; მუდმივი მონიტორინგი)
      const icuDep = st.department_id ? await trx.selectFrom('departments').select('care_level').where('id', '=', st.department_id).executeTakeFirst() : null;
      const icuMod = icuDep && icuDep.care_level !== 'ward' ? await trx.selectFrom('system_modules').select(['enabled', 'settings']).where('code', '=', 'icu').executeTakeFirst() : null;
      const muted = !!icuMod?.enabled && (icuMod.settings as Record<string, unknown>)?.news2_alerts !== true;
      const escalated = !muted && alert && (!prev || NEWS2_RANK[n!.level] > NEWS2_RANK[prev.news2_level as News2Level] || Date.now() - new Date(prev.recorded_at).getTime() > 4 * 3_600_000);
      if (escalated) await this.ipd.event(trx, { encounter_id: encounterId, kind: 'news2_alert', data: { score: n!.score, level: n!.level, vitals_id: v.id } }, u);
      return { v, st, n: escalated ? n : null };
    });
    if (res.n) {
      const urgent = res.n.score >= s.news2_urgent;
      const to = new Set<string>();
      if (res.st.attending_doctor_id) to.add(res.st.attending_doctor_id);
      if (res.st.department_id) {
        for (const r of await this.db.selectFrom('users as x').innerJoin('user_capabilities as c', 'c.user_id', 'x.id').select('x.id').distinct()
          .where('x.is_active', '=', true).where('x.department_id', '=', res.st.department_id).where('x.is_section_head', '=', true)
          .where(sql<boolean>`c.capabilities && ARRAY['nurse', 'doctor']::varchar[]`).execute()) to.add(r.id);
      }
      to.delete(u.id);
      for (const id of to) {
        await this.bell.notify(id, { kind: 'ipd_news2', title: `NEWS2 ${res.n.score} — ${NEWS2_KA[res.n.level]}${urgent ? ' (სასწრაფო შეფასება)' : ''}`, body: this.name(res.st),
          item: res.st.adm_no, entityId: encounterId, link: `/inpatient/stay/${encounterId}#nursing`, urgent: urgent || res.n.level !== 'low_red' }).catch(() => undefined);
      }
    }
    return res.v;
  }

  // ---------------------------------------------------------------- გაუქმება (ყველა ტიპი)
  private static readonly VOIDABLE = {
    vitals: { table: 'encounter_vitals', by: 'taken_by' }, fluid: { table: 'fluid_entries', by: 'created_by' }, scale: { table: 'scale_assessments', by: 'assessed_by' },
    line: { table: 'lines_drains', by: 'created_by' }, note: { table: 'nursing_notes', by: 'author_id' },
  } as const;
  async void(kind: keyof typeof NursingService.VOIDABLE, id: string, reason: string, u: AuthUser, ctx: AuditContext) {
    const { table, by } = NursingService.VOIDABLE[kind];
    return this.db.transaction().execute(async (trx) => {
      const row = (await sql<{ encounter_id: string; voided_at: string | null; author: string | null; created_at: string; mar_entry_id: string | null }>`
        SELECT encounter_id, voided_at, ${sql.ref(by)} AS author, ${sql.ref(kind === 'vitals' ? 'recorded_at' : 'created_at')} AS created_at,
          ${kind === 'line' || kind === 'note' ? sql`NULL::uuid` : sql.ref('mar_entry_id')} AS mar_entry_id
        FROM ${sql.table(table)} WHERE id = ${id} FOR UPDATE`.execute(trx)).rows[0];
      if (!row || row.voided_at) throw new NotFoundException('ჩანაწერი ვერ მოიძებნა');
      const st = await this.stay(row.encounter_id, trx);
      const own = row.author === u.id;
      if (!has(u, 'admin') && !(own || (await this.canWrite(u, st.department_id) && (await this.ipd.me(u, trx)).is_section_head))) {
        throw new ForbiddenException('აუქმებს ავტორი, განყოფილების ხელმძღვანელი ან admin');
      }
      if (!has(u, 'admin') && Date.now() - new Date(row.created_at).getTime() > 24 * 3_600_000) throw new ConflictException('24 სთ-ზე ძველი ჩანაწერი — მიმართეთ admin-ს');
      await sql`UPDATE ${sql.table(table)} SET voided_at = now(), voided_by = ${u.id}, void_reason = ${reason.trim()} WHERE id = ${id}`.execute(trx);
      // 0047: ICU ფურცლის ჩანაწერს მიბმული შარდი (fluid_entries.vitals_id) უქმდება იმავე დროს
      if (kind === 'vitals') {
        await trx.updateTable('fluid_entries').set({ voided_at: sql`now()`, voided_by: u.id, void_reason: `ფურცლის ჩანაწერი გაუქმდა: ${reason.trim()}` })
          .where('vitals_id', '=', id).where('voided_at', 'is', null).execute();
      }
      // MAR-ის დავალება თავიდან იხსნება (ჩანაწერი უქმდება, სლოტი — ახალი due)
      if (row.mar_entry_id) {
        const m = await trx.selectFrom('mar_entries').selectAll().where('id', '=', row.mar_entry_id).executeTakeFirst();
        if (m && !m.voided_at && m.status === 'given') {
          await trx.updateTable('mar_entries').set({ voided_at: sql`now()`, voided_by: u.id, void_reason: `ჩანაწერი გაუქმდა: ${reason.trim()}` }).where('id', '=', m.id).execute();
          if (m.scheduled_at) {
            await sql`INSERT INTO mar_entries (order_id, encounter_id, patient_id, scheduled_at, source, status) VALUES (${m.order_id}, ${m.encounter_id}, ${m.patient_id}, ${m.scheduled_at}, ${m.source}, 'due')
              ON CONFLICT (order_id, scheduled_at) WHERE voided_at IS NULL AND scheduled_at IS NOT NULL DO NOTHING`.execute(trx);
          }
        }
      }
      await this.audit.log(ctx, { action: `IPD_${kind.toUpperCase()}_VOID`, entityName: table, entityId: id, newData: { reason } }, trx);
      return { id, voided: true };
    });
  }

  // ---------------------------------------------------------------- სითხის ბალანსი
  async addFluid(encounterId: string, dto: FluidDto, u: AuthUser, ctx: AuditContext) {
    const at = this.when(dto.recorded_at);
    return this.db.transaction().execute(async (trx) => {
      const st = await this.writable(encounterId, u, trx);
      if (dto.order_id) {
        const o = await trx.selectFrom('med_orders').select(['encounter_id']).where('id', '=', dto.order_id).executeTakeFirst();
        if (!o || o.encounter_id !== encounterId) throw new BadRequestException('დანიშნულება ვერ მოიძებნა');
      }
      const dir = (FLUID_IN as readonly string[]).includes(dto.category) ? 'in' : 'out';
      const r = await trx.insertInto('fluid_entries').values({ encounter_id: encounterId, patient_id: st.patient_id, direction: dir, category: dto.category,
        volume_ml: String(dto.volume_ml), recorded_at: at, order_id: dto.order_id ?? null, note: dto.note?.trim() || null, mar_entry_id: dto.mar_entry_id ?? null, created_by: u.id })
        .returningAll().executeTakeFirstOrThrow();
      if (dto.mar_entry_id) await this.completeTask(trx, dto.mar_entry_id, encounterId, 'fluid', at, u);
      await this.audit.log(ctx, { action: 'IPD_FLUID', entityName: 'fluid_entries', entityId: r.id, newData: dto }, trx);
      return r;
    });
  }
  /** ბალანსის დღეები: [day_start, +24h) — fluid_day_start კლინიკის დროით; days ბოლო დღე */
  async fluid(encounterId: string, days: number) {
    const s = await this.ipd.settings();
    const start = s.fluid_day_start ?? '08:00';
    const rows = await this.db.selectFrom('fluid_entries as f').leftJoin('users as x', 'x.id', 'f.created_by').leftJoin('med_orders as o', 'o.id', 'f.order_id')
      .selectAll('f').select([sql<string>`x.last_name || ' ' || x.first_name`.as('created_by_name'), 'o.text as order_text',
        sql<string>`to_char((f.recorded_at AT TIME ZONE ${TZ}) - ${start}::time, 'YYYY-MM-DD')`.as('day')])
      .where('f.encounter_id', '=', encounterId)
      .where('f.recorded_at', '>', sql<Date>`now() - make_interval(days => ${days + 1})`).orderBy('f.recorded_at', 'desc').execute();
    const map = new Map<string, { day: string; in: number; out: number; by: Record<string, number> }>();
    for (const r of rows) {
      if (r.voided_at) continue;
      const d = map.get(r.day) ?? { day: r.day, in: 0, out: 0, by: {} };
      const v = Number(r.volume_ml);
      if (r.direction === 'in') d.in += v; else d.out += v;
      d.by[r.category] = (d.by[r.category] ?? 0) + v;
      map.set(r.day, d);
    }
    const totals = [...map.values()].sort((a, b) => b.day.localeCompare(a.day)).map((d) => ({ ...d, balance: d.in - d.out }));
    // ინფუზიების მინიშნება: აქტიური უწყვეტი ინფუზიები + ბოლო 24 სთ-ის MAR ჩანაწერები
    const infusions = await this.db.selectFrom('mar_entries as m').innerJoin('med_orders as o', 'o.id', 'm.order_id').leftJoin('med_generics as g', 'g.id', 'o.generic_id')
      .select(['m.id', 'm.order_id', 'm.infusion_action', 'm.rate_ml_h', 'm.documented_at', 'o.volume_ml',
        sql<string>`coalesce(g.inn || coalesce(' ' || g.strength, ''), o.drug_text)`.as('title')])
      .where('m.encounter_id', '=', encounterId).where('m.source', '=', 'infusion').where('m.voided_at', 'is', null)
      .where('m.documented_at', '>', sql<Date>`now() - interval '24 hours'`).orderBy('m.documented_at', 'desc').execute();
    return { day_start: start, totals, entries: rows, infusions };
  }

  // ---------------------------------------------------------------- შკალები
  scaleDefs(all = false) {
    let q = this.db.selectFrom('scale_defs').selectAll().orderBy('sort_order');
    if (!all) q = q.where('is_active', '=', true);
    return q.execute();
  }
  async assess(encounterId: string, dto: ScaleDto, u: AuthUser, ctx: AuditContext) {
    const at = this.when(dto.assessed_at);
    const def = await this.db.selectFrom('scale_defs').selectAll().where('code', '=', dto.scale_code).where('is_active', '=', true).executeTakeFirst();
    if (!def) throw new BadRequestException('შკალა ვერ მოიძებნა');
    const items = def.items as unknown as ScaleItem[]; const bands = def.bands as unknown as ScaleBand[];
    let score = 0;
    for (const it of items) {
      const i = dto.answers[it.key];
      if (!Number.isInteger(i) || i < 0 || i >= it.options.length) throw new BadRequestException(`შეავსეთ: ${it.label}`);
      score += it.options[i].points;
    }
    const extra = Object.keys(dto.answers).filter((k) => !items.some((it) => it.key === k));
    if (extra.length) throw new BadRequestException(`უცნობი პუნქტი: ${extra.join(', ')}`);
    const band = bands.find((b) => score >= b.min && score <= b.max) ?? null;
    return this.db.transaction().execute(async (trx) => {
      const st = await this.writable(encounterId, u, trx);
      const r = await trx.insertInto('scale_assessments').values({ encounter_id: encounterId, patient_id: st.patient_id, scale_code: def.code, answers: JSON.stringify(dto.answers),
        score, band_label: band?.label ?? null, level: band?.level ?? null, note: dto.note?.trim() || null, assessed_at: at, assessed_by: u.id, mar_entry_id: dto.mar_entry_id ?? null })
        .returningAll().executeTakeFirstOrThrow();
      if (dto.mar_entry_id) await this.completeTask(trx, dto.mar_entry_id, encounterId, 'scale', at, u, def.code);
      await this.audit.log(ctx, { action: 'IPD_SCALE', entityName: 'scale_assessments', entityId: r.id, newData: { ...dto, score, level: band?.level } }, trx);
      return r;
    });
  }

  // ---------------------------------------------------------------- ხაზები / დრენაჟები
  async addLine(encounterId: string, dto: LineDto, u: AuthUser, ctx: AuditContext) {
    const at = dto.inserted_at ? new Date(dto.inserted_at) : new Date();
    if (at.getTime() > Date.now() + 5 * 60_000) throw new BadRequestException('ჩადგმის დრო მომავალშია');
    return this.db.transaction().execute(async (trx) => {
      const st = await this.writable(encounterId, u, trx);
      const elsewhere = dto.inserted_where?.trim() || null;
      const r = await trx.insertInto('lines_drains').values({ encounter_id: encounterId, patient_id: st.patient_id, kind: dto.kind, site: dto.site?.trim() || null,
        size: dto.size?.trim() || null, details: dto.details?.trim() || null, inserted_at: at, inserted_by: elsewhere ? null : u.id, inserted_where: elsewhere, created_by: u.id })
        .returningAll().executeTakeFirstOrThrow();
      await this.ipd.event(trx, { encounter_id: encounterId, kind: 'line_inserted', data: { line_id: r.id, kind: dto.kind, site: dto.site ?? null } }, u);
      await this.audit.log(ctx, { action: 'IPD_LINE_ADD', entityName: 'lines_drains', entityId: r.id, newData: dto }, trx);
      return r;
    });
  }
  async removeLine(id: string, dto: LineRemoveDto, u: AuthUser, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const l = await trx.selectFrom('lines_drains').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!l || l.voided_at) throw new NotFoundException('ჩანაწერი ვერ მოიძებნა');
      if (l.removed_at) throw new ConflictException('უკვე ამოღებულია');
      const st = await this.stay(l.encounter_id, trx);
      if (!(await this.canWrite(u, st.department_id))) throw new ForbiddenException('ამოღებას წერს მიმდინარე განყოფილების ექთანი ან ექიმი');
      const at = dto.removed_at ? new Date(dto.removed_at) : new Date();
      if (at.getTime() > Date.now() + 5 * 60_000) throw new BadRequestException('დრო მომავალშია');
      if (at < new Date(l.inserted_at)) throw new BadRequestException('ამოღება ჩადგმამდე ვერ იქნება');
      await trx.updateTable('lines_drains').set({ removed_at: at, removed_by: u.id, removal_reason: dto.reason?.trim() || null }).where('id', '=', id).execute();
      await this.ipd.event(trx, { encounter_id: l.encounter_id, kind: 'line_removed', data: { line_id: id, kind: l.kind, reason: dto.reason ?? null } }, u);
      await this.audit.log(ctx, { action: 'IPD_LINE_REMOVE', entityName: 'lines_drains', entityId: id, newData: dto }, trx);
      return { id, removed_at: at };
    });
  }

  // ---------------------------------------------------------------- ჩანაწერები / ცვლა
  /** მიმდინარე ცვლის დასაწყისი (shift_times, კლინიკის დროით) */
  async shiftStart(ex: Ex = this.db) {
    const s = await this.ipd.settings();
    const times = s.shift_times?.length ? s.shift_times : ['08:00', '20:00'];
    const r = await sql<{ t: string }>`SELECT max(x) AS t FROM (
        SELECT ((d::date + tm::time) AT TIME ZONE ${TZ}) AS x
        FROM generate_series((now() AT TIME ZONE ${TZ})::date - 1, (now() AT TIME ZONE ${TZ})::date, interval '1 day') d, unnest(${sql.val(times)}::text[]) tm
      ) q WHERE x <= now()`.execute(ex);
    return new Date(r.rows[0].t);
  }
  /** ცვლის ავტომატური შეჯამება პაციენტზე */
  async summary(encounterId: string, ex: Ex = this.db) {
    const s = await this.ipd.settings();
    const shift = await this.shiftStart(ex);
    const vit = await ex.selectFrom('encounter_vitals').select(['recorded_at', 'systolic_bp', 'diastolic_bp', 'heart_rate', 'respiratory_rate', 'temperature', 'spo2', 'o2_supplement',
      'o2_flow', 'consciousness', 'pain', 'glucose', 'news2', 'news2_level'])
      .where('encounter_id', '=', encounterId).where('voided_at', 'is', null).orderBy('recorded_at', 'desc').limit(1).executeTakeFirst();
    const mar = await sql<{ missed: number; given: number; due_next: number; refused: number }>`SELECT
        count(*) FILTER (WHERE (status = 'missed' OR (status = 'due' AND scheduled_at < now() - make_interval(mins => ${s.mar_window_min}))) AND scheduled_at >= ${shift})::int AS missed,
        count(*) FILTER (WHERE status IN ('given', 'partial') AND documented_at >= ${shift})::int AS given,
        count(*) FILTER (WHERE status IN ('refused', 'not_given', 'held') AND documented_at >= ${shift})::int AS refused,
        count(*) FILTER (WHERE status = 'due' AND scheduled_at >= now() - make_interval(mins => ${s.mar_window_min}) AND scheduled_at < now() + interval '12 hours')::int AS due_next
      FROM mar_entries WHERE encounter_id = ${encounterId} AND voided_at IS NULL`.execute(ex);
    const fl = await sql<{ in_ml: string; out_ml: string }>`SELECT coalesce(sum(volume_ml) FILTER (WHERE direction = 'in'), 0) AS in_ml,
        coalesce(sum(volume_ml) FILTER (WHERE direction = 'out'), 0) AS out_ml
      FROM fluid_entries WHERE encounter_id = ${encounterId} AND voided_at IS NULL AND recorded_at >= ${shift}`.execute(ex);
    const lines = await ex.selectFrom('lines_drains').select(['kind', 'site', 'inserted_at', sql<number>`floor(extract(epoch FROM now() - inserted_at) / 86400)::int`.as('days')])
      .where('encounter_id', '=', encounterId).where('removed_at', 'is', null).where('voided_at', 'is', null).orderBy('inserted_at').execute();
    const risks = await this.risks([encounterId], ex);
    return {
      shift_start: shift, vitals: vit ?? null, mar: mar.rows[0],
      fluid: { in: Number(fl.rows[0].in_ml), out: Number(fl.rows[0].out_ml), balance: Number(fl.rows[0].in_ml) - Number(fl.rows[0].out_ml) },
      lines: lines.map((l) => ({ ...l, kind_ka: LINE_KA[l.kind] ?? l.kind })), risks: risks.get(encounterId) ?? [],
    };
  }
  /** შკალების რისკები (ბოლო შეფასება, medium / high) — დაფა, შეჯამება */
  async risks(encounterIds: string[], ex: Ex = this.db) {
    const out = new Map<string, { code: string; label: string; level: string; score: number; at: string }[]>();
    if (!encounterIds.length) return out;
    const rows = await sql<{ encounter_id: string; scale_code: string; risk_label: string | null; level: string; score: number; assessed_at: string }>`
      SELECT * FROM (SELECT DISTINCT ON (a.encounter_id, a.scale_code) a.encounter_id, a.scale_code, d.risk_label, d.sort_order, a.level, a.score, a.assessed_at
        FROM scale_assessments a JOIN scale_defs d ON d.code = a.scale_code
        WHERE a.encounter_id = ANY(${sql.val(encounterIds)}::uuid[]) AND a.voided_at IS NULL
        ORDER BY a.encounter_id, a.scale_code, a.assessed_at DESC) q ORDER BY sort_order`.execute(ex);
    for (const r of rows.rows) {
      if (!r.risk_label || !['medium', 'high'].includes(r.level)) continue;
      out.set(r.encounter_id, [...(out.get(r.encounter_id) ?? []), { code: r.scale_code, label: r.risk_label, level: r.level, score: r.score, at: r.assessed_at }]);
    }
    return out;
  }

  async addNote(encounterId: string, dto: NoteDto, u: AuthUser, ctx: AuditContext) {
    if (dto.kind === 'note' && (dto.text?.trim().length ?? 0) < 2) throw new BadRequestException('ჩანაწერის ტექსტი');
    if (dto.kind === 'handover' && !Object.values(dto.sbar ?? {}).some((x) => (x ?? '').trim().length >= 2)) throw new BadRequestException('SBAR — მინიმუმ ერთი ველი');
    if (dto.kind === 'handover' && !has(u, 'nurse', 'admin')) throw new ForbiddenException('ცვლას აბარებს ექთანი');
    return this.db.transaction().execute(async (trx) => {
      const st = await this.writable(encounterId, u, trx);
      const shift = dto.kind === 'handover' ? await this.shiftStart(trx) : null;
      const summary = dto.kind === 'handover' ? await this.summary(encounterId, trx) : null;
      const sbar = dto.sbar ? Object.fromEntries(Object.entries(dto.sbar).map(([k, v]) => [k, (v ?? '').trim()])) : null;
      try {
        const r = await trx.insertInto('nursing_notes').values({ encounter_id: encounterId, patient_id: st.patient_id, department_id: st.department_id, kind: dto.kind,
          text: dto.kind === 'note' ? dto.text!.trim() : null, sbar: sbar ? JSON.stringify(sbar) : null, summary: summary ? JSON.stringify(summary) : null,
          shift_start: shift, author_id: u.id }).returningAll().executeTakeFirstOrThrow();
        if (dto.kind === 'handover') await this.ipd.event(trx, { encounter_id: encounterId, kind: 'handover', data: { note_id: r.id } }, u);
        await this.audit.log(ctx, { action: dto.kind === 'handover' ? 'IPD_HANDOVER' : 'IPD_NURSING_NOTE', entityName: 'nursing_notes', entityId: r.id, newData: dto }, trx);
        return r;
      } catch (e) { mapPgError(e, { ux_nn_handover: 'ამ ცვლის გადაბარება ამ პაციენტზე უკვე ჩაწერილია (საჭიროებისას — გააუქმეთ და ჩაწერეთ თავიდან)' }); }
    });
  }
  async ackHandover(id: string, u: AuthUser, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const n = await trx.selectFrom('nursing_notes').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!n || n.voided_at || n.kind !== 'handover') throw new NotFoundException('გადაბარება ვერ მოიძებნა');
      if (n.ack_at) throw new ConflictException('უკვე მიღებულია');
      if (n.author_id === u.id) throw new BadRequestException('საკუთარ გადაბარებას ვერ მიიღებთ');
      if (!has(u, 'nurse', 'admin')) throw new ForbiddenException('ცვლას იღებს ექთანი');
      const st = await this.stay(n.encounter_id, trx);
      if (!(await this.canWrite(u, st.department_id))) throw new ForbiddenException('ცვლას იღებს ამ განყოფილების ექთანი');
      await trx.updateTable('nursing_notes').set({ ack_by: u.id, ack_at: sql`now()` }).where('id', '=', id).execute();
      await this.audit.log(ctx, { action: 'IPD_HANDOVER_ACK', entityName: 'nursing_notes', entityId: id }, trx);
      return { id, ack: true };
    });
  }

  // ---------------------------------------------------------------- წაკითხვა
  /** ჰოსპიტალიზაციის საექთნო მონაცემები (ერთი მოთხოვნით): ვიტალები (days), ბალანსი, შკალები, ხაზები, ჩანაწერები */
  async stayData(encounterId: string, days: number, u: AuthUser) {
    const s = await this.ipd.settings();
    const st = await this.stay(encounterId);
    const vitals = await this.db.selectFrom('encounter_vitals as v').leftJoin('users as x', 'x.id', 'v.taken_by').leftJoin('users as y', 'y.id', 'v.voided_by')
      .selectAll('v').select([sql<string>`x.last_name || ' ' || x.first_name`.as('taken_by_name'), sql<string | null>`y.last_name || ' ' || y.first_name`.as('voided_by_name')])
      .where('v.encounter_id', '=', encounterId).where('v.recorded_at', '>', sql<Date>`now() - make_interval(days => ${days})`).orderBy('v.recorded_at', 'desc').execute();
    const scales = await this.db.selectFrom('scale_assessments as a').leftJoin('users as x', 'x.id', 'a.assessed_by').innerJoin('scale_defs as d', 'd.code', 'a.scale_code')
      .selectAll('a').select(['d.name as scale_name', sql<string>`x.last_name || ' ' || x.first_name`.as('assessed_by_name')])
      .where('a.encounter_id', '=', encounterId).orderBy('a.assessed_at', 'desc').limit(200).execute();
    const defs = await this.scaleDefs();
    const due = defs.filter((d) => d.required && d.reassess_hours).map((d) => {
      const last = scales.find((x) => x.scale_code === d.code && !x.voided_at);
      const dueAt = last ? new Date(new Date(last.assessed_at).getTime() + d.reassess_hours! * 3_600_000) : new Date(new Date(st.admitted_at).getTime() + 24 * 3_600_000);
      return { code: d.code, name: d.name, due_at: dueAt, overdue: dueAt.getTime() < Date.now(), last_at: last?.assessed_at ?? null };
    });
    const lines = await this.db.selectFrom('lines_drains as l').leftJoin('users as x', 'x.id', 'l.inserted_by').leftJoin('users as y', 'y.id', 'l.removed_by')
      .selectAll('l').select([sql<string | null>`x.last_name || ' ' || x.first_name`.as('inserted_by_name'), sql<string | null>`y.last_name || ' ' || y.first_name`.as('removed_by_name'),
        sql<number>`extract(epoch FROM coalesce(l.removed_at, now()) - l.inserted_at)::int / 3600`.as('hours')])
      .where('l.encounter_id', '=', encounterId).orderBy(sql`l.removed_at IS NULL`, 'desc').orderBy('l.inserted_at', 'desc').execute();
    const notes = await this.db.selectFrom('nursing_notes as n').leftJoin('users as x', 'x.id', 'n.author_id').leftJoin('users as y', 'y.id', 'n.ack_by')
      .selectAll('n').select([sql<string>`x.last_name || ' ' || x.first_name`.as('author_name'), sql<string | null>`y.last_name || ' ' || y.first_name`.as('ack_by_name')])
      .where('n.encounter_id', '=', encounterId).orderBy('n.created_at', 'desc').limit(100).execute();
    return {
      can_write: st.status === 'active' && await this.canWrite(u, st.department_id), age: st.age, news2_applicable: s.news2_enabled && st.age >= 16,
      settings: { news2_alert: s.news2_alert, news2_urgent: s.news2_urgent, glucose_low: s.glucose_low, glucose_high: s.glucose_high, line_alert_hours: s.line_alert_hours ?? {} },
      vitals, fluid: await this.fluid(encounterId, Math.min(days, 7)), scale_defs: defs, scales, scales_due: due,
      lines: lines.map((l) => ({ ...l, kind_ka: LINE_KA[l.kind] ?? l.kind, alert_hours: (s.line_alert_hours ?? {})[l.kind] ?? 0 })),
      notes, shift_start: await this.shiftStart(),
    };
  }

  /** განყოფილების ცვლის გადაბარება: პაციენტები + შეჯამება + მიმდინარე ცვლის გადაბარების სტატუსი */
  async departmentHandover(departmentId: string, u: AuthUser) {
    const shift = await this.shiftStart();
    const pts = await this.db.selectFrom('bed_assignments as a').innerJoin('inpatient_stays as st', 'st.encounter_id', 'a.encounter_id').innerJoin('patients as p', 'p.id', 'st.patient_id')
      .innerJoin('encounters as e', 'e.id', 'st.encounter_id').leftJoin('beds as b', 'b.id', 'a.bed_id').leftJoin('users as d', 'd.id', 'e.attending_doctor_id')
      .select(['st.encounter_id', 'st.adm_no', 'st.severity', 'st.isolation', 'p.first_name', 'p.last_name', 'p.birth_date', 'p.gender', 'b.code as bed_code',
        sql<string | null>`d.last_name || ' ' || left(d.first_name, 1) || '.'`.as('doctor_name'),
        sql<string | null>`(SELECT x.icd10_code || ' ' || x.icd10_title FROM encounter_diagnoses x WHERE x.encounter_id = e.id ORDER BY (x.diagnosis_type = 'primary') DESC, (x.diagnosis_type = 'admission') DESC, x.created_at LIMIT 1)`.as('diagnosis'),
        sql<number>`(SELECT count(*)::int FROM patient_allergies al WHERE al.patient_id = p.id AND al.is_active)`.as('allergies')])
      .where('a.department_id', '=', departmentId).where('a.ended_at', 'is', null).where('st.status', '=', 'active').orderBy('b.code').orderBy('p.last_name').execute();
    const ids = pts.map((p) => p.encounter_id);
    const hand = ids.length ? await this.db.selectFrom('nursing_notes as n').leftJoin('users as x', 'x.id', 'n.author_id').leftJoin('users as y', 'y.id', 'n.ack_by')
      .selectAll('n').select([sql<string>`x.last_name || ' ' || x.first_name`.as('author_name'), sql<string | null>`y.last_name || ' ' || y.first_name`.as('ack_by_name')])
      .where('n.encounter_id', 'in', ids).where('n.kind', '=', 'handover').where('n.voided_at', 'is', null)
      .where('n.shift_start', '>=', sql<Date>`${shift}::timestamptz - interval '24 hours'`).orderBy('n.shift_start', 'desc').execute() : [];
    const out = [];
    for (const p of pts) {
      out.push({ ...p, summary: await this.summary(p.encounter_id),
        current: hand.find((h) => h.encounter_id === p.encounter_id && new Date(h.shift_start!).getTime() === shift.getTime()) ?? null,
        previous: hand.find((h) => h.encounter_id === p.encounter_id && new Date(h.shift_start!).getTime() < shift.getTime()) ?? null });
    }
    return { shift_start: shift, can_write: await this.canWrite(u, departmentId), me: u.id, patients: out };
  }

  /** გაწერის გაფრთხილება (0041 hook): ამოუღებელი ხაზები / დრენაჟები */
  async openLines(encounterId: string, ex: Ex = this.db) {
    return ex.selectFrom('lines_drains').select(['kind', 'site']).where('encounter_id', '=', encounterId).where('removed_at', 'is', null).where('voided_at', 'is', null).execute();
  }
}

// ================================================================= controller
@Controller('inpatient')
export class NursingController {
  constructor(private readonly s: NursingService) {}
  @Get('stays/:eid/nursing') @Roles(...READ)
  get(@Param('eid', ParseUUIDPipe) eid: string, @Query('days') days: string | undefined, @CurrentUser() u: AuthUser) {
    return this.s.stayData(eid, Math.min(30, Math.max(1, Number(days) || 3)), u);
  }
  @Get('stays/:eid/nursing/summary') @Roles(...READ) summary(@Param('eid', ParseUUIDPipe) eid: string) { return this.s.summary(eid); }
  @Get('departments/:id/handover') @Roles(...READ) handover(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser) { return this.s.departmentHandover(id, u); }
  @Get('nursing/scales') @Roles(...READ) scales(@Query('all') all?: string) { return this.s.scaleDefs(all === 'true'); }

  @Post('stays/:eid/vitals') @Roles(...WRITE)
  vitals(@Param('eid', ParseUUIDPipe) eid: string, @Body() d: NVitalsDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.addVitals(eid, d, u, auditCtx(r)); }
  @Post('stays/:eid/fluid') @Roles(...WRITE)
  fluid(@Param('eid', ParseUUIDPipe) eid: string, @Body() d: FluidDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.addFluid(eid, d, u, auditCtx(r)); }
  @Post('stays/:eid/scales') @Roles(...WRITE)
  scale(@Param('eid', ParseUUIDPipe) eid: string, @Body() d: ScaleDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.assess(eid, d, u, auditCtx(r)); }
  @Post('stays/:eid/lines') @Roles(...WRITE)
  line(@Param('eid', ParseUUIDPipe) eid: string, @Body() d: LineDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.addLine(eid, d, u, auditCtx(r)); }
  @Post('lines/:id/remove') @HttpCode(200) @Roles(...WRITE)
  remove(@Param('id', ParseUUIDPipe) id: string, @Body() d: LineRemoveDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.removeLine(id, d, u, auditCtx(r)); }
  @Post('stays/:eid/nursing-notes') @Roles(...WRITE)
  note(@Param('eid', ParseUUIDPipe) eid: string, @Body() d: NoteDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.addNote(eid, d, u, auditCtx(r)); }
  @Post('nursing-notes/:id/ack') @HttpCode(200) @Roles(...WRITE)
  ack(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.ackHandover(id, u, auditCtx(r)); }
  @Post('nursing/:kind/:id/void') @HttpCode(200) @Roles(...WRITE)
  void(@Param('kind') kind: string, @Param('id', ParseUUIDPipe) id: string, @Body() d: VoidDto, @CurrentUser() u: AuthUser, @Req() r: Request) {
    if (!['vitals', 'fluid', 'scale', 'line', 'note'].includes(kind)) throw new BadRequestException('უცნობი ტიპი');
    return this.s.void(kind as 'vitals', id, d.reason, u, auditCtx(r));
  }
}

@Module({ imports: [InpatientModule], providers: [NursingService], controllers: [NursingController], exports: [NursingService] })
export class NursingModule {}

export type { InpatientSettings };
