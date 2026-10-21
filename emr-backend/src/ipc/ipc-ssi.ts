import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, Logger, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, MaxLength, Min, ValidateIf, ValidateNested } from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser } from '../auth/roles';
import { loadEnv } from '../config/env';
import { NotifyService } from '../notify/notify.service';
import { IPC_ANY, IPC_FULL, IpcCommon, ipcRules, type Ex, type IpcRules } from './ipc-common';
import { IpcHaiService } from './ipc-hai';

const TZ = loadEnv().CLINIC_TZ;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const WOUND_KA: Record<number, string> = { 1: 'I — სუფთა', 2: 'II — პირობით სუფთა', 3: 'III — დაბინძურებული', 4: 'IV — ჩირქოვანი / ინფიცირებული' };
export const PROPH_KA: Record<string, string> = { timely: 'დროულად', early: 'ადრე', late: 'განაკვეთის შემდეგ', none: 'არ ჩატარებულა', unknown: 'უცნობი (დრო არ არის)' };
const ANSWER_KEYS = ['redness', 'discharge', 'dehiscence', 'fever', 'antibiotics', 'doctor_visit', 'reoperation'] as const;

class OpPatchDto {
  @IsOptional() @IsString() @Length(2, 10) category?: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) @Max(4) wound_class_ipc?: number | null;
  @IsOptional() @IsString() @MaxLength(500) wound_class_note?: string;
  /** გამორიცხვა ზედამხედველობიდან (მიზეზით); false — დაბრუნება */
  @IsOptional() @IsBoolean() excluded?: boolean;
  @IsOptional() @IsString() @MaxLength(500) excluded_reason?: string;
}
class AnswersDto {
  @IsOptional() @IsBoolean() redness?: boolean; @IsOptional() @IsBoolean() discharge?: boolean; @IsOptional() @IsBoolean() dehiscence?: boolean;
  @IsOptional() @IsBoolean() fever?: boolean; @IsOptional() @IsBoolean() antibiotics?: boolean; @IsOptional() @IsBoolean() doctor_visit?: boolean;
  @IsOptional() @IsBoolean() reoperation?: boolean;
}
class FollowupDto {
  @IsIn(['attempt', 'done', 'cancel']) action: 'attempt' | 'done' | 'cancel';
  @IsOptional() @IsIn(['no_infection', 'suspected']) outcome?: 'no_infection' | 'suspected';
  @IsOptional() @ValidateNested() @Type(() => AnswersDto) answers?: AnswersDto;
  @IsOptional() @Matches(DATE) onset_date?: string;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
}
class CategoryDto {
  @IsOptional() @Matches(/^[A-Z][A-Z0-9_]{1,9}$/) code?: string;
  @IsOptional() @IsString() @Length(2, 200) name?: string;
  @IsOptional() @IsInt() @Min(7) @Max(365) followup_days?: number;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(7) @Max(365) implant_followup_days?: number | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(10) @Max(1440) t_point_min?: number | null;
  @IsOptional() @IsArray() @ArrayMaxSize(30) @Matches(/^[A-Z]{1,3}[A-Z0-9]{0,3}$/, { each: true }) ncsp_prefixes?: string[];
  @IsOptional() @IsBoolean() is_active?: boolean;
}
class ProcCatDto { @ValidateIf((_, v) => v !== null) @IsString() @Length(2, 10) ssi_category: string | null }
class RefreshDto { @IsOptional() @IsInt() @Min(7) @Max(800) days?: number }

/** HAI შემთხვევის ცვლილების შემდეგ: ოპერაციის სტატუსი (ssi ↔ active / completed) — trx-შიც */
export async function ssiSyncOp(ex: Ex, caseId: string | null | undefined) {
  if (!caseId) return;
  const op = await ex.selectFrom('ipc_ssi_ops').select(['case_id', 'status', 'followup_until']).where('case_id', '=', caseId).executeTakeFirst();
  if (!op || op.status === 'excluded') return;
  const h = await ex.selectFrom('ipc_hai_cases').select(['id']).where('or_case_id', '=', caseId).where('hai_type', '=', 'ssi').where('status', '=', 'confirmed')
    .orderBy('confirmed_at').executeTakeFirst();
  const base = sql<string>`CASE WHEN ${op.followup_until}::date < (now() AT TIME ZONE ${TZ})::date THEN 'completed' ELSE 'active' END`;
  if (h) await ex.updateTable('ipc_ssi_ops').set({ status: 'ssi', ssi_case_id: h.id }).where('case_id', '=', caseId).execute();
  else await ex.updateTable('ipc_ssi_ops').set({ status: base, ssi_case_id: null }).where('case_id', '=', caseId).execute();
  if (h) await ex.updateTable('ipc_ssi_followups').set({ status: 'cancelled', cancel_reason: 'SSI დადასტურდა' }).where('case_id', '=', caseId).where('status', '=', 'pending').execute();
}

/**
 * SSI ზედამხედველობა (0069):
 *  • ჩანაწერი (ipc_ssi_ops) — დასრულებულ ოპერაციაზე, რომლის პროცედურა (ოქმიდან ან გეგმიდან) აქტიურ SSI კატეგორიაშია: დრო (განაკვეთი), ხანგრძლივობა,
 *    ASA (ხელმოწერილი გასინჯვა), ჭრილობის კლასი (ოქმი ან IPC-ის შესწორება), იმპლანტი, NNIS ინდექსი, პროფილაქტიკის დრო, დაკვირვების ვადა;
 *  • worker (საათში) / „გადათვლა“: ბოლო 120 დღის ოპერაციები + აქტიურები; IPC-ის ცვლილებები (კატეგორია, კლასი, გამორიცხვა) არ იკარგება;
 *  • გაწერის შემდგომი კონტაქტი: ვადის ბოლოს (ssi_pd_calls), ცდები (ssi_pd_attempts), ეჭვი → HAI შემთხვევა (SSI, ოპერაციით), SMS შეხსენება (ssi_pd_sms, თანხმობით).
 */
@Injectable()
export class IpcSsiService {
  private readonly log = new Logger('IPC-SSI');
  constructor(private readonly c: IpcCommon, private readonly audit: AuditService, private readonly hai: IpcHaiService, private readonly notify: NotifyService) {}
  private get db() { return this.c.db; }

  // =============================================================== გადათვლა
  async refresh(opts: { days?: number; caseIds?: string[] } = {}, rules?: IpcRules | null) {
    const r = rules ?? await ipcRules(this.db);
    if (!r || !r.ssi_surveillance) return { ops: 0, followups: 0 };
    const days = opts.days ?? 120;
    const cases = await sql<{ id: string }>`
      SELECT oc.id FROM or_cases oc
       WHERE oc.status = 'completed'
         AND (${opts.caseIds?.length ? sql`oc.id = ANY(${sql.val(opts.caseIds)}::uuid[])` : sql`(
              EXISTS (SELECT 1 FROM or_case_times t WHERE t.case_id = oc.id AND t.kind IN ('incision', 'in_room') AND t.superseded_by IS NULL AND t.at > now() - make_interval(days => ${days}))
              OR EXISTS (SELECT 1 FROM ipc_ssi_ops o WHERE o.case_id = oc.id AND o.status = 'active'))`})`.execute(this.db);
    let n = 0;
    for (const x of cases.rows) {
      try { if (await this.one(x.id, r)) n++; } catch (e) { this.log.error(`SSI ${x.id}: ${(e as Error).message}`); }
    }
    // დასრულებული დაკვირვება: active → completed
    await sql`UPDATE ipc_ssi_ops SET status = 'completed' WHERE status = 'active' AND followup_until < (now() AT TIME ZONE ${TZ})::date`.execute(this.db);
    const fu = r.ssi_pd_calls ? await this.followups() : 0;
    return { ops: n, followups: fu };
  }

  /** ერთი ოპერაციის ჩანაწერი (ახალი ან განახლება); აბრუნებს true — თუ ზედამხედველობაშია */
  private async one(caseId: string, r: IpcRules) {
    const c = await this.db.selectFrom('or_cases as oc').select(['oc.id', 'oc.patient_id', 'oc.encounter_id', 'oc.department_id', 'oc.urgency',
      sql<string | null>`(SELECT t.at FROM or_case_times t WHERE t.case_id = oc.id AND t.kind = 'incision' AND t.superseded_by IS NULL)`.as('inc'),
      sql<string | null>`(SELECT t.at FROM or_case_times t WHERE t.case_id = oc.id AND t.kind = 'closure' AND t.superseded_by IS NULL)`.as('clo'),
      sql<string | null>`(SELECT t.at FROM or_case_times t WHERE t.case_id = oc.id AND t.kind = 'in_room' AND t.superseded_by IS NULL)`.as('inr'),
      sql<number | null>`(SELECT a.asa_class FROM or_preop_assessments a WHERE a.case_id = oc.id AND a.status = 'signed' ORDER BY a.signed_at DESC LIMIT 1)`.as('asa'),
      sql<number | null>`(SELECT n.wound_class FROM or_op_notes n WHERE n.case_id = oc.id AND n.status = 'signed' AND n.superseded_at IS NULL)`.as('wc'),
      sql<boolean>`EXISTS (SELECT 1 FROM patient_implants pi WHERE pi.case_id = oc.id AND pi.removed_at IS NULL)`.as('implant'),
      // კატეგორია: ოქმის (ფაქტობრივი) პროცედურებიდან, თორემ გეგმიდან — ძირითადი პირველი
      sql<string | null>`coalesce(
        (SELECT pr.ssi_category FROM or_op_notes n, jsonb_array_elements(n.procedures) WITH ORDINALITY AS e(p, i)
           JOIN or_procedures pr ON pr.id = (e.p->>'procedure_id')::uuid JOIN ipc_ssi_categories k ON k.code = pr.ssi_category AND k.is_active
          WHERE n.case_id = oc.id AND n.status = 'signed' AND n.superseded_at IS NULL ORDER BY (e.p->>'is_primary')::boolean DESC, e.i LIMIT 1),
        (SELECT pr.ssi_category FROM or_case_procedures cp JOIN or_procedures pr ON pr.id = cp.procedure_id JOIN ipc_ssi_categories k ON k.code = pr.ssi_category AND k.is_active
          WHERE cp.case_id = oc.id ORDER BY cp.is_primary DESC, cp.sort_order LIMIT 1))`.as('cat'),
      sql<string | null>`(SELECT st.ended_at FROM inpatient_stays st WHERE st.encounter_id = oc.encounter_id AND st.status = 'discharged')`.as('discharged_at')])
      .where('oc.id', '=', caseId).executeTakeFirst();
    if (!c) return false;
    const ex = await this.db.selectFrom('ipc_ssi_ops').selectAll().where('case_id', '=', caseId).executeTakeFirst();
    const catCode = ex?.category_manual ? ex.category : c.cat;
    const opAt = c.inc ?? c.inr;
    if (!catCode || !opAt) {
      if (ex && ex.status !== 'excluded' && !ex.category_manual) {
        await this.db.updateTable('ipc_ssi_ops').set({ status: 'excluded', excluded_reason: 'პროცედურა SSI კატეგორიაში აღარ არის (ავტომატურად)', ssi_case_id: null }).where('case_id', '=', caseId).execute();
      }
      return false;
    }
    const cat = await this.db.selectFrom('ipc_ssi_categories').selectAll().where('code', '=', catCode).executeTakeFirstOrThrow();
    const duration = c.inc && c.clo ? Math.round((new Date(c.clo).getTime() - new Date(c.inc).getTime()) / 60000) : null;
    const wc = ex?.wound_class_ipc ?? c.wc;
    const risk = c.asa && wc && duration !== null && cat.t_point_min
      ? (c.asa >= 3 ? 1 : 0) + (wc >= 3 ? 1 : 0) + (duration > cat.t_point_min ? 1 : 0) : null;
    const fuDays = c.implant && cat.implant_followup_days ? cat.implant_followup_days : cat.followup_days;
    const opDate = (await sql<{ d: string }>`SELECT to_char((${opAt}::timestamptz AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS d`.execute(this.db)).rows[0].d;
    const until = (await sql<{ d: string }>`SELECT to_char(${opDate}::date + ${fuDays}::int, 'YYYY-MM-DD') AS d`.execute(this.db)).rows[0].d;
    const pr = await this.prophylaxis(c.id, c.patient_id, c.inc, c.clo, r.prophylaxis_window_min);
    const vals = {
      patient_id: c.patient_id, encounter_id: c.encounter_id, department_id: c.department_id, category: catCode, op_at: opAt as unknown as Date, op_date: opDate,
      duration_min: duration, asa: c.asa, emergency: c.urgency === 'emergency', wound_class: c.wc, implant: c.implant, risk_index: risk,
      prophylaxis: pr.status, prophylaxis_at: pr.at as unknown as Date | null, prophylaxis_drug: pr.drug, followup_days: fuDays, followup_until: until,
      discharged_at: c.discharged_at as unknown as Date | null, computed_at: sql<Date>`now()`,
    };
    if (ex) {
      const back = ex.status === 'excluded' && ex.excluded_reason?.endsWith('(ავტომატურად)');
      await this.db.updateTable('ipc_ssi_ops').set({ ...vals, ...(back && { status: 'active', excluded_reason: null }) }).where('case_id', '=', caseId).execute();
    } else {
      await this.db.insertInto('ipc_ssi_ops').values({ case_id: caseId, ...vals, status: 'active' }).execute();
    }
    await ssiSyncOp(this.db, caseId);
    return true;
  }

  /** პირველი J01 დოზა (ანესთეზიის ოქმი / MAR) [განაკვეთი − 24 სთ, ნაკერი]: ფანჯარაში → დროულად; ადრე → ადრე; განაკვეთის შემდეგ → გვიან */
  private async prophylaxis(caseId: string, patientId: string, inc: string | null, clo: string | null, windowMin: number) {
    if (!inc) return { status: 'unknown' as const, at: null, drug: null };
    const end = clo ?? inc;
    const doses = (await sql<{ at: string; drug: string }>`
      SELECT m.given_at AS at, coalesce(g.inn, m.name) AS drug FROM or_anesthesia_meds m JOIN stock_items si ON si.id = m.item_id JOIN med_generics g ON g.id = si.generic_id AND g.atc_code LIKE 'J01%'
       WHERE m.case_id = ${caseId} AND m.given_at BETWEEN ${inc}::timestamptz - interval '24 hours' AND ${end}::timestamptz
      UNION ALL
      SELECT me.documented_at AS at, g.inn AS drug FROM mar_entries me JOIN med_orders o ON o.id = me.order_id JOIN med_generics g ON g.id = o.generic_id AND g.atc_code LIKE 'J01%'
       WHERE me.patient_id = ${patientId} AND me.status IN ('given', 'partial') AND me.voided_at IS NULL
         AND me.documented_at BETWEEN ${inc}::timestamptz - interval '24 hours' AND ${end}::timestamptz
      ORDER BY at`.execute(this.db)).rows;
    const t0 = new Date(inc).getTime();
    const inWin = doses.filter((d) => { const t = new Date(d.at).getTime(); return t <= t0 && t >= t0 - windowMin * 60000; });
    if (inWin.length) return { status: 'timely' as const, at: inWin[inWin.length - 1].at, drug: inWin[inWin.length - 1].drug };
    const before = doses.filter((d) => new Date(d.at).getTime() < t0);
    if (before.length) return { status: 'early' as const, at: before[before.length - 1].at, drug: before[before.length - 1].drug };
    const after = doses.filter((d) => new Date(d.at).getTime() > t0);
    if (after.length) return { status: 'late' as const, at: after[0].at, drug: after[0].drug };
    return { status: 'none' as const, at: null, drug: null };
  }

  /** გაწერის შემდგომი კონტაქტი: გაწერილ, ზედამხედველობაში მყოფ ოპერაციაზე — ვადის ბოლოს (ძველზე — არა, თუ ვადა > 7 დღის წინ გავიდა) */
  private async followups() {
    const ins = await sql<{ id: string }>`
      INSERT INTO ipc_ssi_followups (case_id, due_date)
      SELECT o.case_id, o.followup_until FROM ipc_ssi_ops o
       WHERE o.status IN ('active', 'completed') AND o.discharged_at IS NOT NULL AND o.followup_until >= (now() AT TIME ZONE ${TZ})::date - 7
         AND NOT EXISTS (SELECT 1 FROM ipc_ssi_followups f WHERE f.case_id = o.case_id)
      RETURNING id`.execute(this.db);
    await sql`UPDATE ipc_ssi_followups f SET status = 'cancelled', cancel_reason = CASE o.status WHEN 'ssi' THEN 'SSI დადასტურდა' ELSE 'ოპერაცია გამორიცხულია' END
                FROM ipc_ssi_ops o WHERE o.case_id = f.case_id AND f.status = 'pending' AND o.status IN ('ssi', 'excluded')`.execute(this.db);
    return ins.rows.length;
  }

  /** SMS შეხსენება ვადის დღეს (ssi_pd_sms; პაციენტის SMS თანხმობით; 10:00–21:00) */
  async sms(r: IpcRules) {
    if (!r.ssi_pd_sms || !this.notify.configured().sms) return 0;
    const h = (await sql<{ h: number }>`SELECT extract(hour FROM now() AT TIME ZONE ${TZ})::int AS h`.execute(this.db)).rows[0].h;
    if (h < 10 || h >= 21) return 0;
    const rows = await this.db.selectFrom('ipc_ssi_followups as f').innerJoin('ipc_ssi_ops as o', 'o.case_id', 'f.case_id').innerJoin('patients as p', 'p.id', 'o.patient_id')
      .select(['f.id', 'p.phone_number', 'o.followup_days',
        sql<boolean>`(SELECT c.decision = 'granted' AND c.revoked_at IS NULL FROM patient_consents c WHERE c.patient_id = p.id AND c.type_code = 'SMS_NOTIFICATIONS' ORDER BY c.signed_at DESC LIMIT 1)`.as('consent')])
      .where('f.status', '=', 'pending').where('f.sms_sent_at', 'is', null).where(sql<boolean>`f.due_date <= (now() AT TIME ZONE ${TZ})::date`).limit(100).execute();
    if (!rows.length) return 0;
    const clinic = await this.db.selectFrom('clinic_settings').select(['name', 'phone']).executeTakeFirst();
    let sent = 0;
    for (const x of rows) {
      if (x.consent && x.phone_number) {
        const text = `${clinic?.name ?? ''}: ოპერაციიდან ${x.followup_days} დღე გავიდა. თუ ჭრილობის არეში გაქვთ სიწითლე, გამონადენი, ტკივილი ან ცხელება — გთხოვთ, დაგვიკავშირდეთ${clinic?.phone ? `: ${clinic.phone}` : ''}.`;
        const res = await this.notify.sms([x.phone_number], text);
        if (res.errors.length) { this.log.warn(`SMS ${x.id}: ${res.errors.join('; ')}`); continue; }
        sent++;
      }
      await this.db.updateTable('ipc_ssi_followups').set({ sms_sent_at: sql`now()` }).where('id', '=', x.id).execute();
    }
    return sent;
  }

  /** worker (საათში) */
  async tick() {
    const r = await ipcRules(this.db);
    if (!r || !r.ssi_surveillance) return { ops: 0, followups: 0, sms: 0 };
    const res = await this.refresh({}, r);
    return { ...res, sms: await this.sms(r) };
  }

  async manualRefresh(d: RefreshDto, req: Request) {
    const r = await this.c.rules();
    if (!r.ssi_surveillance) throw new ConflictException({ code: 'SSI_OFF', message: 'SSI ზედამხედველობა გამორთულია (მოდულის პარამეტრები)' });
    const res = await this.refresh({ days: d.days ?? 120 }, r);
    await this.audit.log(auditCtx(req), { action: 'IPC_SSI_REFRESH', entityName: 'ipc_ssi_ops', entityId: 'refresh', newData: res });
    return res;
  }

  // =============================================================== ოპერაციები
  private opsQuery() {
    return this.db.selectFrom('ipc_ssi_ops as o').innerJoin('or_cases as oc', 'oc.id', 'o.case_id').innerJoin('patients as p', 'p.id', 'o.patient_id')
      .innerJoin('ipc_ssi_categories as k', 'k.code', 'o.category').innerJoin('departments as d', 'd.id', 'o.department_id')
      .leftJoin('ipc_hai_cases as h', 'h.id', 'o.ssi_case_id').leftJoin('ipc_ssi_followups as f', 'f.case_id', 'o.case_id')
      .select(['o.case_id', 'oc.case_no', 'o.patient_id', 'p.first_name', 'p.last_name', 'p.personal_number', 'p.phone_number', 'o.encounter_id', 'o.department_id', 'd.name as department',
        'o.category', 'k.name as category_name', 'o.category_manual', 'o.op_at', 'o.op_date', 'o.duration_min', 'k.t_point_min', 'o.asa', 'o.emergency', 'o.wound_class', 'o.wound_class_ipc',
        'o.wound_class_note', 'o.implant', 'o.risk_index', 'o.prophylaxis', 'o.prophylaxis_at', 'o.prophylaxis_drug', 'o.followup_days', 'o.followup_until', 'o.discharged_at',
        'o.status', 'o.excluded_reason', 'o.ssi_case_id', 'h.case_no as ssi_case_no', 'h.ssi_depth', 'f.id as followup_id', 'f.status as followup_status', 'f.due_date as followup_due',
        sql<string | null>`(SELECT string_agg(pr.name, '; ' ORDER BY cp.is_primary DESC, cp.sort_order) FROM or_case_procedures cp JOIN or_procedures pr ON pr.id = cp.procedure_id WHERE cp.case_id = o.case_id)`.as('procedures'),
        sql<number>`(SELECT count(*)::int FROM ipc_hai_cases hx WHERE hx.or_case_id = o.case_id AND hx.status IN ('suspected', 'review'))`.as('open_cases')]);
  }
  private fix<T extends { op_date: unknown; followup_until: unknown; followup_due: unknown }>(x: T) {
    return { ...x, op_date: String(x.op_date).slice(0, 10), followup_until: String(x.followup_until).slice(0, 10), followup_due: x.followup_due ? String(x.followup_due).slice(0, 10) : null };
  }

  async listOps(u: AuthUser, q: { from?: string; to?: string; category?: string; status?: string; department_id?: string; q?: string }) {
    await this.c.rules();
    const sc = await this.c.scope(u);
    let x = this.opsQuery().orderBy('o.op_at', 'desc').limit(500);
    if (q.from && DATE.test(q.from)) x = x.where('o.op_date', '>=', q.from);
    if (q.to && DATE.test(q.to)) x = x.where('o.op_date', '<=', q.to);
    if (q.category) x = x.where('o.category', '=', q.category);
    if (q.status) x = x.where('o.status', 'in', q.status.split(','));
    if (q.department_id) x = x.where('o.department_id', '=', q.department_id);
    if (q.q?.trim()) { const s = `%${q.q.trim().toLowerCase()}%`; x = x.where((eb) => eb.or([eb(sql`lower(p.first_name || ' ' || p.last_name)`, 'like', s), eb('p.personal_number', 'like', s), eb(sql`lower(oc.case_no)`, 'like', s)])); }
    if (!sc.full) x = x.where('o.department_id', 'in', sc.depts);
    return (await x.execute()).map((r) => this.fix(r));
  }

  async op(caseId: string, u: AuthUser) {
    await this.c.rules();
    const o = await this.opsQuery().where('o.case_id', '=', caseId).executeTakeFirst();
    if (!o) throw new NotFoundException('ოპერაცია ზედამხედველობაში არ არის');
    const sc = await this.c.scope(u);
    if (!sc.full && !sc.depts.includes(o.department_id)) throw new ForbiddenException({ code: 'OUT_OF_SCOPE', message: 'ოპერაცია თქვენი განყოფილების არ არის' });
    const [cases, fu] = await Promise.all([
      this.db.selectFrom('ipc_hai_cases').select(['id', 'case_no', 'status', 'onset_date', 'ssi_depth', 'post_discharge']).where('or_case_id', '=', caseId).orderBy('created_at').execute(),
      this.db.selectFrom('ipc_ssi_followups as f').leftJoin('users as cu', 'cu.id', 'f.contacted_by').selectAll('f')
        .select(sql<string | null>`cu.first_name || ' ' || cu.last_name`.as('contacted_by_name')).where('f.case_id', '=', caseId).executeTakeFirst(),
    ]);
    return { ...this.fix(o), hai_cases: cases.map((h) => ({ ...h, onset_date: String(h.onset_date).slice(0, 10) })),
      followup: fu ? { ...fu, due_date: String(fu.due_date).slice(0, 10) } : null, can: { edit: has(u, ...IPC_FULL) } };
  }

  async patchOp(caseId: string, d: OpPatchDto, u: AuthUser, req: Request) {
    await this.c.rules();
    const o = await this.db.selectFrom('ipc_ssi_ops').selectAll().where('case_id', '=', caseId).executeTakeFirst();
    if (!o) throw new NotFoundException('ოპერაცია ზედამხედველობაში არ არის');
    const vals: Record<string, unknown> = {};
    if (d.category !== undefined && d.category !== o.category) {
      const k = await this.db.selectFrom('ipc_ssi_categories').select('code').where('code', '=', d.category).executeTakeFirst();
      if (!k) throw new BadRequestException({ code: 'SSI_CATEGORY', message: 'კატეგორია ვერ მოიძებნა' });
      Object.assign(vals, { category: d.category, category_manual: true });
    }
    if (d.wound_class_ipc !== undefined) {
      if (d.wound_class_ipc !== null && (d.wound_class_note?.trim().length ?? 0) < 3) throw new BadRequestException({ code: 'WOUND_NOTE', message: 'ჭრილობის კლასის შესწორებას სჭირდება მიზეზი' });
      Object.assign(vals, { wound_class_ipc: d.wound_class_ipc, wound_class_note: d.wound_class_ipc === null ? null : d.wound_class_note!.trim() });
    }
    if (d.excluded !== undefined) {
      if (d.excluded) {
        if (o.status === 'ssi') throw new ConflictException({ code: 'SSI_CONFIRMED', message: 'დადასტურებული SSI-ით ოპერაცია ვერ გამოირიცხება' });
        if ((d.excluded_reason?.trim().length ?? 0) < 3) throw new BadRequestException({ code: 'EXCLUDE_REASON', message: 'გამორიცხვას სჭირდება მიზეზი' });
        Object.assign(vals, { status: 'excluded', excluded_reason: d.excluded_reason!.trim() });
      } else if (o.status === 'excluded') Object.assign(vals, { status: 'active', excluded_reason: null });
    }
    if (!Object.keys(vals).length) throw new BadRequestException({ code: 'NO_CHANGE', message: 'ცვლილება არ არის' });
    await this.db.updateTable('ipc_ssi_ops').set(vals).where('case_id', '=', caseId).execute();
    await this.audit.log(auditCtx(req), { action: 'IPC_SSI_OP_UPDATE', entityName: 'ipc_ssi_ops', entityId: caseId,
      oldData: Object.fromEntries(Object.keys(vals).map((k) => [k, (o as Record<string, unknown>)[k]])), newData: vals });
    const r = await this.c.rules();
    if (vals.status !== 'excluded') await this.one(caseId, r);        // ინდექსი / ვადა / სტატუსი თავიდან
    if (r.ssi_pd_calls) await this.followups();
    return this.op(caseId, u);
  }

  // =============================================================== გაწერის შემდგომი კონტაქტი
  async listFollowups(u: AuthUser, q: { status?: string; due?: string }) {
    await this.c.rules();
    const sc = await this.c.scope(u);
    let x = this.db.selectFrom('ipc_ssi_followups as f').innerJoin('ipc_ssi_ops as o', 'o.case_id', 'f.case_id').innerJoin('or_cases as oc', 'oc.id', 'o.case_id')
      .innerJoin('patients as p', 'p.id', 'o.patient_id').innerJoin('ipc_ssi_categories as k', 'k.code', 'o.category').innerJoin('departments as d', 'd.id', 'o.department_id')
      .leftJoin('ipc_hai_cases as h', 'h.id', 'f.hai_case_id').leftJoin('users as cu', 'cu.id', 'f.contacted_by')
      .select(['f.id', 'f.case_id', 'oc.case_no', 'f.due_date', 'f.status', 'f.attempts', 'f.last_attempt_at', 'f.outcome', 'f.answers', 'f.note', 'f.contacted_at', 'f.cancel_reason', 'f.sms_sent_at',
        'f.hai_case_id', 'h.case_no as hai_case_no', 'o.patient_id', 'p.first_name', 'p.last_name', 'p.personal_number', 'p.phone_number', 'o.category', 'k.name as category_name',
        'o.op_date', 'o.followup_days', 'o.discharged_at', 'd.name as department', sql<string | null>`cu.first_name || ' ' || cu.last_name`.as('contacted_by_name')])
      .orderBy('f.due_date').limit(500);
    const st = q.status === 'all' ? null : q.status ? q.status.split(',') : ['pending'];
    if (st) x = x.where('f.status', 'in', st);
    if (q.due === 'now') x = x.where(sql<boolean>`f.due_date <= (now() AT TIME ZONE ${TZ})::date + 3`);
    if (!sc.full) x = x.where('o.department_id', 'in', sc.depts);
    return (await x.execute()).map((f) => ({ ...f, due_date: String(f.due_date).slice(0, 10), op_date: String(f.op_date).slice(0, 10) }));
  }

  async actFollowup(id: string, d: FollowupDto, u: AuthUser, req: Request) {
    const r = await this.c.rules();
    const f = await this.db.selectFrom('ipc_ssi_followups as f').innerJoin('ipc_ssi_ops as o', 'o.case_id', 'f.case_id')
      .select(['f.id', 'f.status', 'f.attempts', 'f.case_id', 'o.patient_id', 'o.department_id', 'o.encounter_id', 'o.op_date', 'o.followup_until']).where('f.id', '=', id).executeTakeFirst();
    if (!f) throw new NotFoundException('კონტაქტი ვერ მოიძებნა');
    const sc = await this.c.scope(u);
    if (!sc.full && !sc.depts.includes(f.department_id)) throw new ForbiddenException({ code: 'OUT_OF_SCOPE', message: 'ოპერაცია თქვენი განყოფილების არ არის' });
    if (f.status !== 'pending') throw new ConflictException({ code: 'STATE', message: 'კონტაქტი უკვე დასრულებულია' });
    const note = d.note?.trim() || null;
    let haiId: string | null = null;
    if (d.action === 'attempt') {
      const n = f.attempts + 1;
      await this.db.updateTable('ipc_ssi_followups').set({ attempts: n, last_attempt_at: sql`now()`, note, status: n >= r.ssi_pd_attempts ? 'unreachable' : 'pending', contacted_by: u.id })
        .where('id', '=', id).execute();
    } else if (d.action === 'cancel') {
      if (!note || note.length < 3) throw new BadRequestException({ code: 'CANCEL_REASON', message: 'გაუქმებას სჭირდება მიზეზი (მაგ. გარდაიცვალა, სხვა კლინიკაშია)' });
      await this.db.updateTable('ipc_ssi_followups').set({ status: 'cancelled', cancel_reason: note, contacted_by: u.id, contacted_at: sql`now()` }).where('id', '=', id).execute();
    } else {
      if (!d.outcome) throw new BadRequestException({ code: 'OUTCOME', message: 'მიუთითეთ შედეგი' });
      const answers = Object.fromEntries(ANSWER_KEYS.map((k) => [k, d.answers?.[k] ?? null]));
      if (d.outcome === 'suspected') {
        const onset = d.onset_date ?? (await sql<{ d: string }>`SELECT to_char((now() AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS d`.execute(this.db)).rows[0].d;
        const KA: Record<string, string> = { redness: 'სიწითლე / შეშუპება', discharge: 'გამონადენი', dehiscence: 'ჭრილობის გახსნა', fever: 'ცხელება', antibiotics: 'ანტიბიოტიკი',
          doctor_visit: 'ექიმთან ვიზიტი', reoperation: 'განმეორებითი ოპერაცია' };
        const pos = ANSWER_KEYS.filter((k) => answers[k] === true).map((k) => KA[k]);
        const h = await this.hai.create({ patient_id: f.patient_id, encounter_id: f.encounter_id, hai_type: 'ssi', onset_date: onset, or_case_id: f.case_id, post_discharge: true,
          description: `გაწერის შემდგომი კონტაქტი: ${pos.join(', ') || 'ეჭვი'}${note ? ` — ${note}` : ''}` }, u, req);
        haiId = h.id;
      }
      await this.db.updateTable('ipc_ssi_followups').set({ status: 'done', outcome: d.outcome, answers: JSON.stringify(answers), note, contacted_by: u.id, contacted_at: sql`now()`,
        attempts: f.attempts + 1, last_attempt_at: sql`now()`, hai_case_id: haiId }).where('id', '=', id).execute();
    }
    await this.audit.log(auditCtx(req), { action: `IPC_SSI_FOLLOWUP_${d.action.toUpperCase()}`, entityName: 'ipc_ssi_followups', entityId: id, newData: { ...d, hai_case_id: haiId } });
    return (await this.listFollowups(u, { status: 'all' })).find((x) => x.id === id);
  }

  // =============================================================== მაჩვენებლები
  async rates(u: AuthUser, q: { from?: string; to?: string; department_id?: string }) {
    await this.c.rules();
    if (!q.from || !q.to || !DATE.test(q.from) || !DATE.test(q.to) || q.from > q.to) throw new BadRequestException({ code: 'RANGE', message: 'from / to (YYYY-MM-DD)' });
    const sc = await this.c.scope(u);
    const depts = q.department_id ? [q.department_id] : sc.full ? null : sc.depts;
    const rows = (await sql<{ category: string; name: string; ops: number; active: number; ssi: number; superficial: number; deep: number; organ: number; post_discharge: number;
      r0: number; r1: number; r2: number; r3: number; rn: number; s0: number; s1: number; s2: number; s3: number; sn: number; ph_known: number; ph_timely: number;
      fu_due: number; fu_done: number }>`
      SELECT o.category, k.name, count(*)::int AS ops,
             count(*) FILTER (WHERE o.status = 'active')::int AS active, count(*) FILTER (WHERE o.status = 'ssi')::int AS ssi,
             count(*) FILTER (WHERE h.ssi_depth = 'superficial')::int AS superficial, count(*) FILTER (WHERE h.ssi_depth = 'deep')::int AS deep,
             count(*) FILTER (WHERE h.ssi_depth = 'organ')::int AS organ, count(*) FILTER (WHERE h.post_discharge)::int AS post_discharge,
             count(*) FILTER (WHERE o.risk_index = 0)::int AS r0, count(*) FILTER (WHERE o.risk_index = 1)::int AS r1,
             count(*) FILTER (WHERE o.risk_index = 2)::int AS r2, count(*) FILTER (WHERE o.risk_index = 3)::int AS r3, count(*) FILTER (WHERE o.risk_index IS NULL)::int AS rn,
             count(*) FILTER (WHERE o.status = 'ssi' AND o.risk_index = 0)::int AS s0, count(*) FILTER (WHERE o.status = 'ssi' AND o.risk_index = 1)::int AS s1,
             count(*) FILTER (WHERE o.status = 'ssi' AND o.risk_index = 2)::int AS s2, count(*) FILTER (WHERE o.status = 'ssi' AND o.risk_index = 3)::int AS s3,
             count(*) FILTER (WHERE o.status = 'ssi' AND o.risk_index IS NULL)::int AS sn,
             count(*) FILTER (WHERE o.prophylaxis <> 'unknown')::int AS ph_known, count(*) FILTER (WHERE o.prophylaxis = 'timely')::int AS ph_timely,
             count(f.id) FILTER (WHERE f.status <> 'cancelled')::int AS fu_due,
             count(f.id) FILTER (WHERE f.status = 'done')::int AS fu_done
        FROM ipc_ssi_ops o JOIN ipc_ssi_categories k ON k.code = o.category
        LEFT JOIN ipc_hai_cases h ON h.id = o.ssi_case_id LEFT JOIN ipc_ssi_followups f ON f.case_id = o.case_id
       WHERE o.status <> 'excluded' AND o.op_date BETWEEN ${q.from}::date AND ${q.to}::date
         ${depts ? sql`AND o.department_id = ANY(${sql.val(depts)}::uuid[])` : sql``}
       GROUP BY o.category, k.name, k.sort_order ORDER BY k.sort_order`.execute(this.db)).rows;
    const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 10000) / 100 : null);
    const sum = (k: keyof (typeof rows)[number]) => rows.reduce((a, x) => a + (x[k] as number), 0);
    const total = Object.fromEntries((['ops', 'active', 'ssi', 'superficial', 'deep', 'organ', 'post_discharge', 'r0', 'r1', 'r2', 'r3', 'rn', 's0', 's1', 's2', 's3', 'sn', 'ph_known', 'ph_timely', 'fu_due', 'fu_done'] as const)
      .map((k) => [k, sum(k)])) as Record<string, number>;
    const dec = <T extends Record<string, unknown>>(x: T & { ops: number; ssi: number; ph_known: number; ph_timely: number; post_discharge: number }) => ({ ...x,
      rate: pct(x.ssi, x.ops), ph_timely_pct: pct(x.ph_timely, x.ph_known), post_discharge_pct: pct(x.post_discharge, x.ssi) });
    return { from: q.from, to: q.to, rows: rows.map((x) => dec(x)), total: dec(total as Record<string, number> & { ops: number; ssi: number; ph_known: number; ph_timely: number; post_discharge: number }) };
  }

  // =============================================================== ცნობარი: კატეგორიები და პროცედურები
  async catalog() {
    await this.c.rules();
    const [cats, procs] = await Promise.all([
      this.db.selectFrom('ipc_ssi_categories').selectAll().orderBy('sort_order').execute(),
      this.db.selectFrom('or_procedures as p').leftJoin('or_specialties as s', 's.code', 'p.specialty_code')
        .select(['p.id', 'p.code', 'p.ncsp_code', 'p.name', 'p.ssi_category', 's.name as specialty']).where('p.is_active', '=', true).orderBy('p.name').execute(),
    ]);
    const suggest = (ncsp: string | null) => (ncsp ? cats.find((k) => k.is_active && k.ncsp_prefixes.some((pre) => ncsp.startsWith(pre)))?.code ?? null : null);
    return { categories: cats, procedures: procs.map((p) => ({ ...p, suggested: p.ssi_category ? null : suggest(p.ncsp_code) })), wound_classes: WOUND_KA };
  }

  async saveCategory(code: string | null, d: CategoryDto, req: Request) {
    await this.c.rules();
    if (code) {
      const ex = await this.db.selectFrom('ipc_ssi_categories').selectAll().where('code', '=', code).executeTakeFirst();
      if (!ex) throw new NotFoundException('კატეგორია ვერ მოიძებნა');
      const vals = { ...(d.name !== undefined && { name: d.name.trim() }), ...(d.followup_days !== undefined && { followup_days: d.followup_days }),
        ...(d.implant_followup_days !== undefined && { implant_followup_days: d.implant_followup_days }), ...(d.t_point_min !== undefined && { t_point_min: d.t_point_min }),
        ...(d.ncsp_prefixes !== undefined && { ncsp_prefixes: [...new Set(d.ncsp_prefixes)] }), ...(d.is_active !== undefined && { is_active: d.is_active }) };
      if (!Object.keys(vals).length) throw new BadRequestException({ code: 'NO_CHANGE', message: 'ცვლილება არ არის' });
      await this.db.updateTable('ipc_ssi_categories').set(vals).where('code', '=', code).execute();
      await this.audit.log(auditCtx(req), { action: 'IPC_SSI_CATEGORY_UPDATE', entityName: 'ipc_ssi_categories', entityId: code,
        oldData: Object.fromEntries(Object.keys(vals).map((k) => [k, (ex as Record<string, unknown>)[k]])), newData: vals });
    } else {
      if (!d.code || !d.name) throw new BadRequestException('code / name სავალდებულოა');
      if (await this.db.selectFrom('ipc_ssi_categories').select('code').where('code', '=', d.code).executeTakeFirst()) throw new ConflictException({ code: 'CODE_EXISTS', message: 'კოდი უკვე არსებობს' });
      const max = await this.db.selectFrom('ipc_ssi_categories').select(sql<number>`coalesce(max(sort_order), 0)`.as('m')).executeTakeFirstOrThrow();
      await this.db.insertInto('ipc_ssi_categories').values({ code: d.code, name: d.name.trim(), followup_days: d.followup_days ?? 30, implant_followup_days: d.implant_followup_days ?? null,
        t_point_min: d.t_point_min ?? null, ncsp_prefixes: [...new Set(d.ncsp_prefixes ?? [])], is_active: d.is_active ?? true, sort_order: Number(max.m) + 10 }).execute();
      await this.audit.log(auditCtx(req), { action: 'IPC_SSI_CATEGORY_CREATE', entityName: 'ipc_ssi_categories', entityId: d.code, newData: d });
    }
    return this.catalog();
  }

  async setProcedure(id: string, d: ProcCatDto, req: Request) {
    await this.c.rules();
    const p = await this.db.selectFrom('or_procedures').select(['id', 'ssi_category']).where('id', '=', id).executeTakeFirst();
    if (!p) throw new NotFoundException('პროცედურა ვერ მოიძებნა');
    if (d.ssi_category && !await this.db.selectFrom('ipc_ssi_categories').select('code').where('code', '=', d.ssi_category).executeTakeFirst())
      throw new BadRequestException({ code: 'SSI_CATEGORY', message: 'კატეგორია ვერ მოიძებნა' });
    await this.db.updateTable('or_procedures').set({ ssi_category: d.ssi_category }).where('id', '=', id).execute();
    await this.audit.log(auditCtx(req), { action: 'IPC_SSI_PROCEDURE', entityName: 'or_procedures', entityId: id, oldData: { ssi_category: p.ssi_category }, newData: d });
    return this.catalog();
  }

  /** NCSP-ით შეთავაზებულის მიღება ყველა მიუბმელ პროცედურაზე */
  async applySuggestions(req: Request) {
    const cat = await this.catalog();
    const todo = cat.procedures.filter((p) => p.suggested);
    for (const p of todo) await this.db.updateTable('or_procedures').set({ ssi_category: p.suggested }).where('id', '=', p.id).where('ssi_category', 'is', null).execute();
    await this.audit.log(auditCtx(req), { action: 'IPC_SSI_PROCEDURE_SUGGEST', entityName: 'or_procedures', entityId: 'bulk', newData: { applied: todo.map((p) => [p.code, p.suggested]) } });
    return { applied: todo.length, ...(await this.catalog()) };
  }

  /** პაციენტის ოპერაციები (HAI SSI-ისთვის არჩევა): დასრულებული, onset-მდე, ბოლო 365 დღე */
  async patientOps(patientId: string) {
    const rows = await this.db.selectFrom('or_cases as oc').leftJoin('ipc_ssi_ops as o', 'o.case_id', 'oc.id').innerJoin('departments as d', 'd.id', 'oc.department_id')
      .select(['oc.id', 'oc.case_no', 'd.name as department', 'o.category', 'o.followup_until', 'o.status as ssi_status',
        sql<string | null>`(SELECT t.at FROM or_case_times t WHERE t.case_id = oc.id AND t.kind IN ('incision', 'in_room') AND t.superseded_by IS NULL ORDER BY t.kind = 'incision' DESC LIMIT 1)`.as('op_at'),
        sql<string | null>`(SELECT string_agg(pr.name, '; ' ORDER BY cp.is_primary DESC, cp.sort_order) FROM or_case_procedures cp JOIN or_procedures pr ON pr.id = cp.procedure_id WHERE cp.case_id = oc.id)`.as('procedures')])
      .where('oc.patient_id', '=', patientId).where('oc.status', '=', 'completed').where('oc.requested_at', '>', sql<Date>`now() - interval '400 days'`).orderBy('oc.requested_at', 'desc').execute();
    return rows.map((x) => ({ ...x, followup_until: x.followup_until ? String(x.followup_until).slice(0, 10) : null }));
  }
}

@Controller('ipc/ssi')
export class IpcSsiController {
  constructor(private readonly s: IpcSsiService) {}
  @Get('ops') @Roles(...IPC_ANY) ops(@CurrentUser() u: AuthUser, @Query('from') from?: string, @Query('to') to?: string, @Query('category') category?: string,
    @Query('status') status?: string, @Query('department_id') department_id?: string, @Query('q') q?: string) {
    return this.s.listOps(u, { from, to, category, status, department_id, q });
  }
  @Get('ops/:id') @Roles(...IPC_ANY) op(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser) { return this.s.op(id, u); }
  @Patch('ops/:id') @Roles(...IPC_FULL) patch(@Param('id', ParseUUIDPipe) id: string, @Body() d: OpPatchDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.patchOp(id, d, u, r); }
  @Post('refresh') @HttpCode(200) @Roles(...IPC_FULL) refresh(@Body() d: RefreshDto, @Req() r: Request) { return this.s.manualRefresh(d, r); }
  @Get('followups') @Roles(...IPC_ANY) followups(@CurrentUser() u: AuthUser, @Query('status') status?: string, @Query('due') due?: string) { return this.s.listFollowups(u, { status, due }); }
  @Post('followups/:id') @HttpCode(200) @Roles(...IPC_ANY) act(@Param('id', ParseUUIDPipe) id: string, @Body() d: FollowupDto, @CurrentUser() u: AuthUser, @Req() r: Request) {
    return this.s.actFollowup(id, d, u, r);
  }
  @Get('rates') @Roles(...IPC_ANY) rates(@CurrentUser() u: AuthUser, @Query('from') from?: string, @Query('to') to?: string, @Query('department_id') department_id?: string) {
    return this.s.rates(u, { from, to, department_id });
  }
  @Get('catalog') @Roles(...IPC_ANY, 'admin') catalog() { return this.s.catalog(); }
  @Post('categories') @Roles(...IPC_FULL) createCat(@Body() d: CategoryDto, @Req() r: Request) { return this.s.saveCategory(null, d, r); }
  @Patch('categories/:code') @Roles(...IPC_FULL) updateCat(@Param('code') code: string, @Body() d: CategoryDto, @Req() r: Request) { return this.s.saveCategory(code, d, r); }
  @Patch('procedures/:id') @Roles(...IPC_FULL) proc(@Param('id', ParseUUIDPipe) id: string, @Body() d: ProcCatDto, @Req() r: Request) { return this.s.setProcedure(id, d, r); }
  @Post('procedures/apply-suggestions') @HttpCode(200) @Roles(...IPC_FULL) apply(@Req() r: Request) { return this.s.applySuggestions(r); }
  @Get('patients/:id/ops') @Roles(...IPC_ANY) patientOps(@Param('id', ParseUUIDPipe) id: string) { return this.s.patientOps(id); }
}
