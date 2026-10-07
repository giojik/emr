import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, Module, NotFoundException, Param, ParseUUIDPipe,
  Patch, Post, Query, Req } from '@nestjs/common';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, MaxLength, Min } from 'class-validator';
import type { Request } from 'express';
import { sql, type Transaction } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { loadBilling } from './ipd-billing-calc';
import { has, type AuthUser } from '../auth/roles';
import { mapPgError } from '../common/pg-errors';
import type { DB } from '../database/db';
import { InjectDb, type Database } from '../database/database.module';
import { DISCHARGE_KA } from '../templates/template-context';
import { EpicrisisModule, EpicrisisService } from './epicrisis';
import { loadEnv } from '../config/env';
import { LINE_KA } from './nursing';
import { OrdersModule, OrdersService } from './orders';
import { InpatientModule, InpatientService, type InpatientSettings } from './inpatient';

const TZ = loadEnv().CLINIC_TZ;
type Trx = Transaction<DB>;
const TYPES = ['home', 'other_clinic', 'against_advice', 'death'] as const;
type DischargeType = (typeof TYPES)[number];
const TRANSPORT = ['own', 'ambulance', 'clinic_transport', 'other'] as const;
const BODY_HOLD = 'გარდაცვლილი — გვამის გატანამდე';

export class DischargeDto {
  @IsIn(TYPES) type: DischargeType;
  @IsOptional() @IsBoolean() sign_epicrisis?: boolean;                 // „ხელმოწერა და გაწერა“ — ერთ ტრანზაქციაში
  @IsOptional() @IsUUID() destination_id?: string;
  @IsOptional() @IsString() @MaxLength(300) destination_text?: string;
  @IsOptional() @IsIn(TRANSPORT) transport?: (typeof TRANSPORT)[number];
  @IsOptional() @IsUUID() refusal_consent_id?: string;
  @IsOptional() @IsArray() @ArrayMinSize(2) @ArrayMaxSize(3) @IsUUID('all', { each: true }) refusal_witnesses?: string[];
  @IsOptional() @IsDateString() death_at?: string;
  @IsOptional() @IsString() @Length(2, 10) death_icd10_code?: string;
  @IsOptional() @IsBoolean() autopsy_required?: boolean;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
  @IsOptional() @IsString() @Length(5, 1000) override_reason?: string;  // გაფრთხილებების (ღია შეკვეთები, ბალანსი…) დადასტურება
}
export class CloseDto { @IsOptional() @IsBoolean() sign_epicrisis?: boolean }
export class BodyReleaseDto { @IsOptional() @IsDateString() at?: string }
export class DischargeCancelDto {
  @IsString() @Length(5, 1000) reason: string;
  @IsOptional() @IsUUID() bed_id?: string;
  @IsOptional() @IsBoolean() confirm?: boolean;
}
export class LeaveDto {
  @IsDateString() expected_return_at: string;
  @IsString() @Length(3, 1000) reason: string;
  @IsOptional() @IsUUID() permitted_by?: string;
}
export class InstitutionDto {
  @IsString() @Length(2, 200) name: string;
  @IsOptional() @IsString() @MaxLength(300) address?: string;
  @IsOptional() @IsString() @MaxLength(50) phone?: string;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsInt() @Min(0) sort_order?: number;
}

/** soft — შეხსენება (ჩანს შემოწმებაში / დიალოგში), დასაბუთებას არ მოითხოვს (0045: ჩანაწერები, ფორმა 100) */
export interface DischargeWarning { code: string; message: string; soft?: boolean }

/**
 * გაწერა (0041). ტიპები: ბინაზე / სხვა კლინიკაში / თვითნებური (ხელწერილით ან 2 მოწმით) / გარდაცვალება.
 *   გაწერა (status = discharged, ended_at) ≠ შემთხვევის დახურვა (closed_at — ხელმოწერილი ეპიკრიზი + საბოლოო დიაგნოზი).
 *     ბინაზე / სხვა კლინიკაში — ბლოკი გაწერამდე (ან „ხელმოწერა და გაწერა“ ერთად) → იხურება მაშინვე, ვიზიტი → discharged;
 *     თვითნებური / გარდაცვალება — პაციენტი / საწოლი თავისუფლდება მაშინვე; ვიზიტი active რჩება, სანამ დოკუმენტაცია არ დაიხურება.
 *   გაფრთხილებები (არა ბლოკი): ღია დიაგნოსტიკური შეკვეთები, გადაუხდელი ინვოისი; [MAR — hook, მოდული ჯერ არ არის] — დადასტურება მიზეზით.
 *   ღია გადაყვანის მოთხოვნა უქმდება ავტომატურად. გარდაცვალება: საწოლი დაბლოკილია გვამის გატანამდე, შემდეგ → დასალაგებელი.
 *   გაუქმება (შეცდომა): discharge_cancel_hours-ში, განყოფილების ხელმძღვანელი (გარდაცვალება — მხოლოდ admin).
 *   დროებითი გასვლა: საწოლი დაკავებული რჩება; leave_max_hours; ვადაგადაცილება — worker.
 */
@Injectable()
export class DischargeService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService, private readonly ipd: InpatientService,
              private readonly epicrisis: EpicrisisService, private readonly orders: OrdersService) {}

  private async curDept(trx: Trx | Database, encounterId: string) {
    const a = await trx.selectFrom('bed_assignments').select(['id', 'department_id', 'bed_id', 'ended_at']).where('encounter_id', '=', encounterId)
      .where('end_kind', 'is distinct from', 'cancel').orderBy(sql`ended_at IS NULL`, 'desc').orderBy('started_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirstOrThrow();
    return a;
  }
  private async canDischarge(u: AuthUser, attendingId: string | null, departmentId: string, trx: Trx) {
    if (has(u, 'admin')) return true;
    if (!has(u, 'doctor')) return false;
    return attendingId === u.id || await this.ipd.isStaff(u, departmentId, trx);
  }

  /** გაფრთხილებები გაწერამდე (UI აჩვენებს წინასწარ: GET .../discharge/check) */
  async warnings(encounterId: string, ex: Trx | Database = this.db): Promise<DischargeWarning[]> {
    const out: DischargeWarning[] = [];
    const open = await ex.selectFrom('dx_order_items as i').innerJoin('dx_services as s', 's.id', 'i.service_id').select(['s.name', 'i.status', 'i.section'])
      .where('i.encounter_id', '=', encounterId).where('i.status', 'not in', ['validated', 'cancelled']).execute();
    if (open.length) out.push({ code: 'OPEN_ORDERS', message: `დაუსრულებელი შეკვეთები (${open.length}): ${open.slice(0, 5).map((o) => o.name).join(', ')}${open.length > 5 ? '…' : ''}` });
    // 0046: პაციენტის წილი (გადამხდელების / ავანსის გათვალისწინებით); discharge_balance: warn — შეხსენება, block — დასაბუთებით, off
    const bal = (await this.ipd.settings()).discharge_balance ?? 'warn';
    if (bal !== 'off') {
      const b = await loadBilling(ex, encounterId);
      if (b && b.money.due > 0.009) {
        out.push({ code: 'BALANCE', soft: bal === 'warn', message: `პაციენტის დავალიანება (შეფასებით): ${b.money.due.toFixed(2)} ₾ — ინვოისი ${b.invoice.invoice_number}${b.finalized ? '' : ' (ფინანსური დახურვა — ბილინგი)'}` });
      }
    }
    // MAR (0043): ბოლო 24 სთ-ის გამოტოვებული / ვადაგადაცილებული დოზები
    const win = (await this.ipd.settings()).mar_window_min ?? 60;
    const mar = await ex.selectFrom('mar_entries').select(sql<number>`count(*)::int`.as('n')).where('encounter_id', '=', encounterId).where('voided_at', 'is', null)
      .where((eb) => eb.or([eb('status', '=', 'missed'), eb.and([eb('status', '=', 'due'), eb('scheduled_at', '<', sql<Date>`now() - make_interval(mins => ${win})`)])]))
      .where('scheduled_at', '>', sql<Date>`now() - interval '24 hours'`).executeTakeFirstOrThrow();
    if (mar.n) out.push({ code: 'MAR_MISSED', message: `MAR: ბოლო 24 სთ-ში მიუცემელი / გამოტოვებული დოზა (${mar.n})` });
    // 0045: ექიმის ჩანაწერები (მიმღები გასინჯვა, დღიურები) და ფორმა 100
    const s45 = await this.ipd.settings();
    const nm = await sql<{ adm: boolean; days: string[] }>`SELECT
        NOT EXISTS (SELECT 1 FROM doctor_notes n WHERE n.encounter_id = st.encounter_id AND n.kind = 'admission' AND n.status = 'signed' AND n.superseded_at IS NULL) AS adm,
        ARRAY(SELECT to_char(d, 'DD/MM') FROM generate_series((st.admitted_at AT TIME ZONE ${TZ})::date + 1, (now() AT TIME ZONE ${TZ})::date - 1, interval '1 day') d
          WHERE ${s45.progress_note_daily !== false} AND NOT EXISTS (SELECT 1 FROM doctor_notes n WHERE n.encounter_id = st.encounter_id AND n.kind = 'progress'
            AND n.status = 'signed' AND n.superseded_at IS NULL AND n.note_date = d::date) ORDER BY d) AS days
      FROM inpatient_stays st WHERE st.encounter_id = ${encounterId}`.execute(ex);
    const n0 = nm.rows[0];
    if (n0 && (n0.adm || n0.days.length)) {
      out.push({ code: 'NOTES_MISSING', soft: true, message: [n0.adm && 'მიმღები გასინჯვა არ არის ხელმოწერილი',
        n0.days.length && `დღიური აკლია (${n0.days.length}): ${n0.days.slice(0, 7).join(', ')}${n0.days.length > 7 ? '…' : ''}`].filter(Boolean).join('; ') });
    }
    if ((s45.form100_on_discharge ?? 'warn') === 'warn') {
      const f = await ex.selectFrom('generated_documents').select('id').where('encounter_id', '=', encounterId).where('document_type', '=', 'form_100').where('status', '=', 'issued').executeTakeFirst();
      if (!f) out.push({ code: 'FORM100_MISSING', soft: true, message: 'ფორმა №IV-100/ა არ არის გაცემული (შეგიძლიათ გასცეთ გაწერამდე ან გაწერის შემდეგ)' });
    }
    // 0044: ამოუღებელი ხაზები / დრენაჟები
    const lines = await ex.selectFrom('lines_drains').select(['kind', 'site']).where('encounter_id', '=', encounterId).where('removed_at', 'is', null).where('voided_at', 'is', null).execute();
    if (lines.length) out.push({ code: 'LINES_IN_PLACE', message: `ამოუღებელი კათეტერი / დრენაჟი (${lines.length}): ${lines.map((l) => (LINE_KA[l.kind] ?? l.kind) + (l.site ? ` — ${l.site}` : '')).join(', ')}` });
    return out;
  }

  /** დახურვის პირობები: ზუსტად ერთი primary + ეპიკრიზი ხელმოწერილი (signed / awaiting_cosign) */
  private async closureMissing(trx: Trx, encounterId: string) {
    const m: string[] = [];
    const dx = await this.epicrisis.diagnoses(encounterId, trx);
    if (dx.final.primary.length !== 1) m.push('საბოლოო დიაგნოზი: საჭიროა ზუსტად ერთი ძირითადი (ICD-10)');
    const e = await trx.selectFrom('epicrises').select('status').where('encounter_id', '=', encounterId).executeTakeFirst();
    if (!e) m.push('ეპიკრიზი არ არის შექმნილი');
    else if (e.status === 'draft') m.push('ეპიკრიზი ხელმოწერილი არ არის');
    return m;
  }

  async check(encounterId: string, u: AuthUser) {
    const st = await this.db.selectFrom('inpatient_stays as st').innerJoin('encounters as e', 'e.id', 'st.encounter_id').select(['st.status', 'e.attending_doctor_id'])
      .where('st.encounter_id', '=', encounterId).executeTakeFirst();
    if (!st) throw new NotFoundException('ჰოსპიტალიზაცია ვერ მოიძებნა');
    const [warnings, missing, epi, leave, transfer] = await Promise.all([
      this.warnings(encounterId),
      this.db.transaction().execute((trx) => this.closureMissing(trx, encounterId)),
      this.db.selectFrom('epicrises').select(['status']).where('encounter_id', '=', encounterId).executeTakeFirst(),
      this.db.selectFrom('inpatient_leaves').select(['id', 'expected_return_at']).where('encounter_id', '=', encounterId).where('returned_at', 'is', null).executeTakeFirst(),
      this.db.selectFrom('inpatient_transfers').select(['id']).where('encounter_id', '=', encounterId).where('status', '=', 'requested').executeTakeFirst(),
    ]);
    const cur = await this.curDept(this.db, encounterId);
    return {
      status: st.status, warnings, closure_missing: missing, epicrisis_status: epi?.status ?? null, on_leave: !!leave, transfer_pending: !!transfer,
      can_sign_with_discharge: epi?.status === 'draft' && missing.length === 1 && missing[0] === 'ეპიკრიზი ხელმოწერილი არ არის',
      can_discharge: st.status === 'active' && await this.db.transaction().execute((trx) => this.canDischarge(u, st.attending_doctor_id, cur.department_id, trx)),
    };
  }

  async discharge(encounterId: string, dto: DischargeDto, u: AuthUser, ctx: AuditContext) {
    const s = await this.ipd.settings();
    try {
      return await this.db.transaction().execute(async (trx) => {
        const st = await this.ipd.lockStay(trx, encounterId);
        const e = await trx.selectFrom('encounters').select(['attending_doctor_id', 'patient_id']).where('id', '=', encounterId).forUpdate().executeTakeFirstOrThrow();
        const cur = await trx.selectFrom('bed_assignments').selectAll().where('encounter_id', '=', encounterId).where('ended_at', 'is', null).forUpdate().executeTakeFirstOrThrow();
        if (!(await this.canDischarge(u, e.attending_doctor_id, cur.department_id, trx))) throw new ForbiddenException('გაწერას აფორმებს მკურნალი ექიმი ან განყოფილების ექიმი');
        const regular = dto.type === 'home' || dto.type === 'other_clinic';
        const set: Record<string, unknown> = { status: 'discharged', ended_at: sql`now()`, discharge_type: dto.type, discharged_by: u.id, discharge_note: dto.note?.trim() || null };

        // --- ტიპის მიხედვით
        if (dto.type === 'other_clinic') {
          if (dto.destination_id) {
            const inst = await trx.selectFrom('external_institutions').select(['id', 'is_active']).where('id', '=', dto.destination_id).executeTakeFirst();
            if (!inst?.is_active) throw new BadRequestException('დაწესებულება ვერ მოიძებნა ცნობარში');
          } else if (!dto.destination_text?.trim() || dto.destination_text.trim().length < 3) throw new BadRequestException('მიუთითეთ დაწესებულება (ცნობარიდან ან ტექსტით)');
          Object.assign(set, { destination_id: dto.destination_id ?? null, destination_text: dto.destination_text?.trim() || null, transport: dto.transport ?? null });
        }
        if (dto.type === 'against_advice') {
          if (dto.refusal_consent_id) {
            const c = await trx.selectFrom('patient_consents').select(['id', 'type_code', 'encounter_id', 'decision', 'revoked_at']).where('id', '=', dto.refusal_consent_id).executeTakeFirst();
            if (!c || c.type_code !== 'SELF_DISCHARGE' || c.encounter_id !== encounterId || c.decision !== 'granted' || c.revoked_at) {
              throw new BadRequestException('ხელწერილი (SELF_DISCHARGE) ამ ჰოსპიტალიზაციაზე ვერ მოიძებნა');
            }
            set.refusal_consent_id = c.id;
          } else if (dto.refusal_witnesses?.length) {
            const ids = [...new Set(dto.refusal_witnesses)];
            const n = (await trx.selectFrom('users').select(sql<number>`count(*)::int`.as('n')).where('id', 'in', ids).where('is_active', '=', true).executeTakeFirstOrThrow()).n;
            if (ids.length < 2 || n !== ids.length) throw new BadRequestException('ხელმოწერაზე უარი: საჭიროა 2 აქტიური თანამშრომელი-მოწმე');
            set.refusal_witnesses = ids;
          } else throw new BadRequestException({ code: 'REFUSAL_REQUIRED', message: 'თვითნებური წასვლა: ხელწერილი (SELF_DISCHARGE) ან — ხელმოწერაზე უარისას — 2 მოწმე' });
          if (dto.transport) set.transport = dto.transport;
        }
        if (dto.type === 'death') {
          if (!dto.death_at || !dto.death_icd10_code || dto.autopsy_required === undefined) throw new BadRequestException('გარდაცვალება: დრო, მიზეზი (ICD-10) და აუტოფსიის საჭიროება სავალდებულოა');
          const at = new Date(dto.death_at);
          if (at.getTime() > Date.now() + 60_000) throw new BadRequestException('გარდაცვალების დრო მომავალშია');
          if (at < new Date(st.admitted_at)) throw new BadRequestException('გარდაცვალების დრო ჰოსპიტალიზაციამდეა');
          const icd = await trx.selectFrom('icd10_codes').select(['code', 'title', 'is_active']).where('code', '=', dto.death_icd10_code.trim().toUpperCase()).executeTakeFirst();
          if (!icd?.is_active) throw new BadRequestException(`ICD-10 კოდი ${dto.death_icd10_code} კლასიფიკატორში არ არსებობს`);
          Object.assign(set, { death_at: at, death_icd10_code: icd.code, death_icd10_title: icd.title, autopsy_required: dto.autopsy_required });
        }

        // --- გაფრთხილებები
        const warnings = (await this.warnings(encounterId, trx)).filter((w) => !w.soft);
        if (warnings.length) {
          if (!dto.override_reason?.trim()) throw new ConflictException({ code: 'DISCHARGE_WARNINGS', message: warnings.map((w) => w.message).join('; '), warnings });
          set.discharge_overrides = JSON.stringify({ warnings, reason: dto.override_reason.trim() });
        }

        // --- დროებითი გასვლა / ღია გადაყვანა
        const leave = await trx.selectFrom('inpatient_leaves').select('id').where('encounter_id', '=', encounterId).where('returned_at', 'is', null).forUpdate().executeTakeFirst();
        if (leave) {
          if (regular) throw new ConflictException('პაციენტი დროებით გასულია — ჯერ დააფიქსირეთ დაბრუნება');
          await trx.updateTable('inpatient_leaves').set({ returned_at: sql`now()`, returned_by: u.id }).where('id', '=', leave.id).execute();
        }
        const tr = await trx.updateTable('inpatient_transfers').set({ status: 'cancelled', decided_by: u.id, decided_at: sql`now()`, decision_reason: 'პაციენტი გაეწერა' })
          .where('encounter_id', '=', encounterId).where('status', '=', 'requested').returning('id').executeTakeFirst();
        if (tr) await this.ipd.event(trx, { encounter_id: encounterId, kind: 'transfer_cancelled', data: { transfer_id: tr.id, reason: 'პაციენტი გაეწერა' } }, u);

        // --- ბლოკი (ბინაზე / სხვა კლინიკაში): საბოლოო დიაგნოზი + ხელმოწერილი ეპიკრიზი (ან ხელმოწერა ახლავე — გაწერის თარიღით)
        let signDraft = false;
        if (regular) {
          const missing = await this.closureMissing(trx, encounterId);
          signDraft = !!dto.sign_epicrisis && missing.length === 1 && missing[0] === 'ეპიკრიზი ხელმოწერილი არ არის';
          if (missing.length && !signDraft) throw new ConflictException({ code: 'DISCHARGE_BLOCKED', message: missing.join('; '), missing });
          Object.assign(set, { closed_at: sql`now()`, closed_by: u.id });
        }

        await trx.updateTable('inpatient_stays').set(set).where('encounter_id', '=', encounterId).execute();
        await trx.updateTable('bed_assignments').set({ ended_at: sql`now()`, ended_by: u.id, end_kind: 'discharge' }).where('id', '=', cur.id).execute();
        let bedCode: string | null = null;
        if (cur.bed_id) {
          const b = await trx.selectFrom('beds').select(['id', 'code']).where('id', '=', cur.bed_id).forUpdate().executeTakeFirstOrThrow();
          bedCode = b.code;
          if (dto.type === 'death') await this.ipd.setBed(trx, b.id, 'blocked', u, BODY_HOLD);
          else await this.ipd.releaseBed(trx, b.id, s, u);
        }
        if (dto.type === 'death') {
          await trx.updateTable('patients').set({ is_deceased: true, death_datetime: set.death_at as Date }).where('id', '=', st.patient_id).execute();
        }
        if (regular) await trx.updateTable('encounters').set({ status: 'discharged', end_time: sql`now()` }).where('id', '=', encounterId).execute();
        if (signDraft) await this.epicrisis.signInTrx(trx, encounterId, u, ctx);
        // 0042: აქტიური / შეჩერებული დანიშნულებები წყდება
        await sql`SELECT ipd_sync_bed_days(${encounterId}::uuid, ${TZ}, ${s.leave_counts_bed_day !== false})`.execute(trx);   // 0046: საბოლოო საწოლდღეები
        const stopped = await this.orders.stopAllForDischarge(trx, encounterId, `გაწერა (${DISCHARGE_KA[dto.type]})`, u);
        if (stopped) await this.ipd.event(trx, { encounter_id: encounterId, kind: 'orders_stopped', data: { count: stopped } }, u);

        await this.ipd.event(trx, { encounter_id: encounterId, bed_id: cur.bed_id, kind: dto.type === 'death' ? 'death' : 'discharged',
          data: { type: dto.type, type_ka: DISCHARGE_KA[dto.type], bed: bedCode, overrides: warnings.map((w) => w.code), epicrisis_signed_now: signDraft } }, u);
        if (cur.bed_id && dto.type !== 'death') await this.ipd.event(trx, { encounter_id: encounterId, bed_id: cur.bed_id, kind: 'bed_released', data: { bed: bedCode, to: s.cleaning_required ? 'cleaning' : 'free' } }, u);
        if (regular) await this.ipd.event(trx, { encounter_id: encounterId, kind: 'closed', data: {} }, u);
        await this.audit.log(ctx, { action: 'INPATIENT_DISCHARGE', entityName: 'encounters', entityId: encounterId,
          newData: { ...dto, overrides: warnings.map((w) => w.code), closed: regular } }, trx);
        return { encounter_id: encounterId, status: 'discharged', discharge_type: dto.type, closed: regular, warnings_overridden: warnings.map((w) => w.code) };
      });
    } catch (e) { mapPgError(e); }
  }

  /** თვითნებური / გარდაცვალება: დოკუმენტაციის დასრულება (ეპიკრიზი + საბოლოო დიაგნოზი) → ვიზიტი discharged */
  async close(encounterId: string, dto: CloseDto, u: AuthUser, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const st = await trx.selectFrom('inpatient_stays').selectAll().where('encounter_id', '=', encounterId).forUpdate().executeTakeFirst();
      if (!st) throw new NotFoundException('ჰოსპიტალიზაცია ვერ მოიძებნა');
      if (st.status !== 'discharged' || st.closed_at) throw new ConflictException('დასახურად მოსალოდნელი შემთხვევა არ არის');
      const e = await trx.selectFrom('encounters').select('attending_doctor_id').where('id', '=', encounterId).executeTakeFirstOrThrow();
      const cur = await this.curDept(trx, encounterId);
      if (!(await this.canDischarge(u, e.attending_doctor_id, cur.department_id, trx))) throw new ForbiddenException('შემთხვევას ხურავს მკურნალი ექიმი ან განყოფილების ექიმი');
      const missing = await this.closureMissing(trx, encounterId);
      const signNow = !!dto.sign_epicrisis && missing.length === 1 && missing[0] === 'ეპიკრიზი ხელმოწერილი არ არის';
      if (missing.length && !signNow) throw new ConflictException({ code: 'CLOSE_BLOCKED', message: missing.join('; '), missing });
      if (signNow) await this.epicrisis.signInTrx(trx, encounterId, u, ctx);
      await trx.updateTable('inpatient_stays').set({ closed_at: sql`now()`, closed_by: u.id }).where('encounter_id', '=', encounterId).execute();
      await trx.updateTable('encounters').set({ status: 'discharged', end_time: st.ended_at }).where('id', '=', encounterId).execute();
      await this.ipd.event(trx, { encounter_id: encounterId, kind: 'closed', data: { epicrisis_signed_now: signNow } }, u);
      await this.audit.log(ctx, { action: 'INPATIENT_CLOSE', entityName: 'encounters', entityId: encounterId }, trx);
      return { encounter_id: encounterId, closed: true };
    });
  }

  async bodyReleased(encounterId: string, dto: BodyReleaseDto, u: AuthUser, ctx: AuditContext) {
    const s = await this.ipd.settings();
    return this.db.transaction().execute(async (trx) => {
      const st = await trx.selectFrom('inpatient_stays').selectAll().where('encounter_id', '=', encounterId).forUpdate().executeTakeFirst();
      if (!st || st.discharge_type !== 'death') throw new ConflictException('გარდაცვალება არ არის დაფიქსირებული');
      if (st.body_released_at) throw new ConflictException('გვამის გატანა უკვე დაფიქსირებულია');
      const cur = await this.curDept(trx, encounterId);
      if (!(await this.ipd.isStaff(u, cur.department_id, trx))) throw new ForbiddenException('აფიქსირებს განყოფილების თანამშრომელი');
      const at = dto.at ? new Date(dto.at) : new Date();
      if (at.getTime() > Date.now() + 60_000 || at < new Date(st.death_at!)) throw new BadRequestException('გატანის დრო: გარდაცვალების შემდეგ და არა მომავალში');
      await trx.updateTable('inpatient_stays').set({ body_released_at: at, body_released_by: u.id }).where('encounter_id', '=', encounterId).execute();
      let bed: string | null = null;
      if (cur.bed_id) {
        const b = await trx.selectFrom('beds').select(['id', 'code', 'status', 'status_reason']).where('id', '=', cur.bed_id).forUpdate().executeTakeFirstOrThrow();
        if (b.status === 'blocked' && b.status_reason === BODY_HOLD) { await this.ipd.releaseBed(trx, b.id, s, u); bed = b.code; }
      }
      await this.ipd.event(trx, { encounter_id: encounterId, bed_id: cur.bed_id, kind: 'body_released', data: { bed, at: at.toISOString() } }, u);
      await this.audit.log(ctx, { action: 'INPATIENT_BODY_RELEASED', entityName: 'encounters', entityId: encounterId, newData: { at } }, trx);
      return { encounter_id: encounterId, body_released_at: at, bed_released: !!bed };
    });
  }

  /** გაწერის გაუქმება (შეცდომა): ჰოსპიტალიზაცია ისევ აქტიურია, ახალი ეპიზოდი იმავე განყოფილებაში (ძველ საწოლზე, თუ თავისუფალია) */
  async cancelDischarge(encounterId: string, dto: DischargeCancelDto, u: AuthUser, ctx: AuditContext) {
    const s = await this.ipd.settings();
    try {
      return await this.db.transaction().execute(async (trx) => {
        const st = await trx.selectFrom('inpatient_stays').selectAll().where('encounter_id', '=', encounterId).forUpdate().executeTakeFirst();
        if (!st) throw new NotFoundException('ჰოსპიტალიზაცია ვერ მოიძებნა');
        if (st.status !== 'discharged') throw new ConflictException('ჰოსპიტალიზაცია გაწერილი არ არის');
        const last = await this.curDept(trx, encounterId);
        if (st.discharge_type === 'death' ? !has(u, 'admin') : !(await this.ipd.isHead(u, last.department_id, trx))) {
          throw new ForbiddenException(st.discharge_type === 'death' ? 'გარდაცვალების ჩანაწერს აუქმებს მხოლოდ admin' : 'გაწერას აუქმებს განყოფილების ხელმძღვანელი ან admin');
        }
        const hours = (Date.now() - new Date(st.ended_at!).getTime()) / 3_600_000;
        if (hours > s.discharge_cancel_hours) throw new ConflictException(`გაწერის გაუქმების ვადა (${s.discharge_cancel_hours} სთ) ამოწურულია`);
        if (st.body_released_at) throw new ConflictException('გვამის გატანა დაფიქსირებულია — გაუქმება შეუძლებელია');
        const fin = await trx.selectFrom('invoices').select('finalized_at').where('encounter_id', '=', encounterId).executeTakeFirst();
        if (fin?.finalized_at) throw new ConflictException('ინვოისი ფინანსურად დახურულია — ჯერ ბილინგმა უნდა გახსნას');
        const active = await trx.selectFrom('inpatient_stays').select('encounter_id').where('patient_id', '=', st.patient_id).where('status', '=', 'active').executeTakeFirst();
        if (active) throw new ConflictException('პაციენტს უკვე აქვს სხვა აქტიური ჰოსპიტალიზაცია');
        const gender = (await trx.selectFrom('patients').select('gender').where('id', '=', st.patient_id).executeTakeFirstOrThrow()).gender;
        // საწოლი: მითითებული → შემოწმებით; არადა ძველი, თუ თავისუფალი / დასალაგებელი / (გარდაცვალება) ჩვენ მიერ დაბლოკილი; სხვაგვარად — „ელოდება საწოლს“
        let bedId: string | null = null; let bedCode: string | null = null; let warnings: string[] = [];
        if (dto.bed_id) {
          const b = await this.ipd.lockBed(trx, dto.bed_id, { departmentId: last.department_id, gender, isolation: st.isolation, confirm: dto.confirm }, s as InpatientSettings);
          bedId = b.id; bedCode = b.code; warnings = b.warnings;
        } else if (last.bed_id) {
          const b = await trx.selectFrom('beds').select(['id', 'code', 'status', 'status_reason', 'is_active']).where('id', '=', last.bed_id).forUpdate().executeTakeFirstOrThrow();
          const mine = b.status === 'blocked' && b.status_reason === BODY_HOLD;
          if (b.is_active && (b.status === 'free' || b.status === 'cleaning' || mine)) { bedId = b.id; bedCode = b.code; }
        }
        await trx.updateTable('inpatient_stays').set({
          status: 'active', ended_at: null, discharge_type: null, discharged_by: null, discharge_note: null, discharge_overrides: null, destination_id: null, destination_text: null,
          transport: null, refusal_consent_id: null, refusal_witnesses: null, death_at: null, death_icd10_code: null, death_icd10_title: null, autopsy_required: null,
          closed_at: null, closed_by: null,
        }).where('encounter_id', '=', encounterId).execute();
        await trx.updateTable('encounters').set({ status: 'active', end_time: null }).where('id', '=', encounterId).execute();
        if (st.discharge_type === 'death') await trx.updateTable('patients').set({ is_deceased: false, death_datetime: null }).where('id', '=', st.patient_id).execute();
        await trx.insertInto('bed_assignments').values({ encounter_id: encounterId, department_id: last.department_id, bed_id: bedId, bed_at: bedId ? sql`now()` : null,
          bed_by: bedId ? u.id : null, reason: `გაწერის გაუქმება: ${dto.reason.trim()}`, assigned_by: u.id }).execute();
        if (bedId) await this.ipd.setBed(trx, bedId, 'occupied', u);
        const epi = await trx.selectFrom('epicrises').select('status').where('encounter_id', '=', encounterId).executeTakeFirst();
        await this.ipd.event(trx, { encounter_id: encounterId, bed_id: bedId, kind: 'discharge_cancelled', data: { was: st.discharge_type, reason: dto.reason.trim(), bed: bedCode, warnings } }, u);
        await this.audit.log(ctx, { action: 'INPATIENT_DISCHARGE_CANCEL', entityName: 'encounters', entityId: encounterId, newData: { reason: dto.reason, was: st.discharge_type, bed: bedCode } }, trx);
        return { encounter_id: encounterId, status: 'active', bed: bedCode,
          notice: [epi && epi.status !== 'draft' ? 'ეპიკრიზი ხელმოწერილია (გაწერის თარიღით) — საჭიროების შემთხვევაში გახსენით ხელახლა' : null,
            (await trx.selectFrom('med_order_events as e').innerJoin('med_orders as o', 'o.id', 'e.order_id').select('e.id').where('o.encounter_id', '=', encounterId)
              .where('e.kind', '=', 'discharge_stop').limit(1).executeTakeFirst()) ? 'გაწერისას დანიშნულებები შეწყდა — საჭიროებისამებრ დანიშნეთ ხელახლა' : null]
            .filter(Boolean).join(' · ') || null };
      });
    } catch (e) { mapPgError(e, { ux_inpatient_stays_patient_active: 'პაციენტს უკვე აქვს სხვა აქტიური ჰოსპიტალიზაცია', ux_bed_assignments_bed: 'საწოლი უკვე დაკავებულია' }); }
  }

  // ================================================================= დროებითი გასვლა
  async leave(encounterId: string, dto: LeaveDto, u: AuthUser, ctx: AuditContext) {
    const s = await this.ipd.settings();
    try {
      return await this.db.transaction().execute(async (trx) => {
        await this.ipd.lockStay(trx, encounterId);
        const e = await trx.selectFrom('encounters').select('attending_doctor_id').where('id', '=', encounterId).executeTakeFirstOrThrow();
        const cur = await this.curDept(trx, encounterId);
        if (!(await this.ipd.isStaff(u, cur.department_id, trx)) && e.attending_doctor_id !== u.id) throw new ForbiddenException('დროებით გასვლას აფორმებს განყოფილების თანამშრომელი');
        const permitter = dto.permitted_by ?? (has(u, 'doctor') ? u.id : null);
        if (!permitter) throw new BadRequestException('მიუთითეთ ნებართვის გამცემი ექიმი');
        await this.ipd.doctor(permitter, trx);
        const back = new Date(dto.expected_return_at);
        const h = (back.getTime() - Date.now()) / 3_600_000;
        if (h <= 0) throw new BadRequestException('დაბრუნების დრო მომავალში უნდა იყოს');
        if (h > s.leave_max_hours) throw new BadRequestException(`დროებითი გასვლა მაქსიმუმ ${s.leave_max_hours} სთ`);
        const tr = await trx.selectFrom('inpatient_transfers').select('id').where('encounter_id', '=', encounterId).where('status', '=', 'requested').executeTakeFirst();
        if (tr) throw new ConflictException('პაციენტზე ღია გადაყვანის მოთხოვნაა');
        const l = await trx.insertInto('inpatient_leaves').values({ encounter_id: encounterId, expected_return_at: back, reason: dto.reason.trim(), permitted_by: permitter, created_by: u.id })
          .returning('id').executeTakeFirstOrThrow();
        await this.ipd.event(trx, { encounter_id: encounterId, kind: 'leave_started', data: { leave_id: l.id, until: back.toISOString(), reason: dto.reason.trim() } }, u);
        await this.audit.log(ctx, { action: 'INPATIENT_LEAVE', entityName: 'inpatient_leaves', entityId: l.id, newData: dto }, trx);
        return { id: l.id, expected_return_at: back };
      });
    } catch (e) { mapPgError(e, { ux_inpatient_leaves_open: 'პაციენტი უკვე დროებით გასულია' }); }
  }

  async leaveReturn(encounterId: string, u: AuthUser, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      await this.ipd.lockStay(trx, encounterId);
      const l = await trx.selectFrom('inpatient_leaves').selectAll().where('encounter_id', '=', encounterId).where('returned_at', 'is', null).forUpdate().executeTakeFirst();
      if (!l) throw new ConflictException('პაციენტი დროებით გასული არ არის');
      const cur = await this.curDept(trx, encounterId);
      if (!(await this.ipd.isStaff(u, cur.department_id, trx))) throw new ForbiddenException('დაბრუნებას აფიქსირებს განყოფილების თანამშრომელი');
      await trx.updateTable('inpatient_leaves').set({ returned_at: sql`now()`, returned_by: u.id }).where('id', '=', l.id).execute();
      const late = new Date(l.expected_return_at).getTime() < Date.now();
      await this.ipd.event(trx, { encounter_id: encounterId, kind: 'leave_returned', data: { leave_id: l.id, late } }, u);
      await this.audit.log(ctx, { action: 'INPATIENT_LEAVE_RETURN', entityName: 'inpatient_leaves', entityId: l.id }, trx);
      return { id: l.id, returned: true, late };
    });
  }

  leaves(encounterId: string) {
    return this.db.selectFrom('inpatient_leaves as l').leftJoin('users as p', 'p.id', 'l.permitted_by')
      .select(['l.id', 'l.started_at', 'l.expected_return_at', 'l.returned_at', 'l.reason', sql<string>`p.last_name || ' ' || p.first_name`.as('permitted_by_name')])
      .where('l.encounter_id', '=', encounterId).orderBy('l.started_at', 'desc').execute();
  }

  /** განყოფილების თანამშრომლები (მოწმეები — თვითნებური წასვლისას ხელმოწერაზე უარი) */
  staff(departmentId: string) {
    return this.db.selectFrom('users as u').innerJoin('user_capabilities as c', 'c.user_id', 'u.id').select(['u.id', 'u.first_name', 'u.last_name']).distinct()
      .where('u.is_active', '=', true).where('u.department_id', '=', departmentId)
      .where(sql<boolean>`c.capabilities && ARRAY['nurse', 'doctor', 'manager']::varchar[]`).orderBy('u.last_name').execute();
  }

  // ================================================================= კლინიკების ცნობარი
  institutions(all: boolean) {
    let q = this.db.selectFrom('external_institutions').selectAll().orderBy('sort_order').orderBy('name');
    if (!all) q = q.where('is_active', '=', true);
    return q.execute();
  }
  async saveInstitution(id: string | null, dto: InstitutionDto, ctx: AuditContext) {
    try {
      const v = { name: dto.name.trim(), address: dto.address?.trim() || null, phone: dto.phone?.trim() || null, ...(dto.is_active !== undefined && { is_active: dto.is_active }),
        ...(dto.sort_order !== undefined && { sort_order: dto.sort_order }) };
      const r = id
        ? await this.db.updateTable('external_institutions').set(v).where('id', '=', id).returningAll().executeTakeFirst()
        : await this.db.insertInto('external_institutions').values(v).returningAll().executeTakeFirst();
      if (!r) throw new NotFoundException('დაწესებულება ვერ მოიძებნა');
      await this.audit.log(ctx, { action: id ? 'UPDATE_INSTITUTION' : 'CREATE_INSTITUTION', entityName: 'external_institutions', entityId: r.id, newData: v });
      return r;
    } catch (e) { mapPgError(e, { external_institutions_name_key: 'ასეთი დაწესებულება უკვე არსებობს' }); }
  }
}

const IPD = ['admin', 'doctor', 'nurse', 'manager'] as const;

@Controller('inpatient')
export class DischargeController {
  constructor(private readonly s: DischargeService) {}
  @Get('stays/:eid/discharge/check') @Roles(...IPD) check(@Param('eid', ParseUUIDPipe) eid: string, @CurrentUser() u: AuthUser) { return this.s.check(eid, u); }
  @Post('stays/:eid/discharge') @HttpCode(200) @Roles('admin', 'doctor')
  discharge(@Param('eid', ParseUUIDPipe) eid: string, @Body() d: DischargeDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.discharge(eid, d, u, auditCtx(r)); }
  @Post('stays/:eid/close') @HttpCode(200) @Roles('admin', 'doctor')
  close(@Param('eid', ParseUUIDPipe) eid: string, @Body() d: CloseDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.close(eid, d, u, auditCtx(r)); }
  @Post('stays/:eid/body-released') @HttpCode(200) @Roles(...IPD)
  body(@Param('eid', ParseUUIDPipe) eid: string, @Body() d: BodyReleaseDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.bodyReleased(eid, d, u, auditCtx(r)); }
  @Post('stays/:eid/discharge/cancel') @HttpCode(200) @Roles('admin', 'doctor', 'nurse', 'manager')
  cancel(@Param('eid', ParseUUIDPipe) eid: string, @Body() d: DischargeCancelDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.cancelDischarge(eid, d, u, auditCtx(r)); }
  @Get('stays/:eid/leaves') @Roles(...IPD) leaves(@Param('eid', ParseUUIDPipe) eid: string) { return this.s.leaves(eid); }
  @Post('stays/:eid/leave') @Roles(...IPD)
  leave(@Param('eid', ParseUUIDPipe) eid: string, @Body() d: LeaveDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.leave(eid, d, u, auditCtx(r)); }
  @Post('stays/:eid/leave/return') @HttpCode(200) @Roles(...IPD)
  leaveReturn(@Param('eid', ParseUUIDPipe) eid: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.leaveReturn(eid, u, auditCtx(r)); }
  @Get('departments/:id/staff') @Roles(...IPD) staff(@Param('id', ParseUUIDPipe) id: string) { return this.s.staff(id); }
  @Get('institutions') @Roles(...IPD, 'receptionist') institutions(@Query('all') all?: string) { return this.s.institutions(all === 'true'); }
  @Post('institutions') @Roles('admin') addInst(@Body() d: InstitutionDto, @Req() r: Request) { return this.s.saveInstitution(null, d, auditCtx(r)); }
  @Patch('institutions/:id') @Roles('admin') editInst(@Param('id', ParseUUIDPipe) id: string, @Body() d: InstitutionDto, @Req() r: Request) { return this.s.saveInstitution(id, d, auditCtx(r)); }
}

@Module({ imports: [InpatientModule, EpicrisisModule, OrdersModule], providers: [DischargeService], controllers: [DischargeController], exports: [DischargeService] })
export class DischargeModule {}
