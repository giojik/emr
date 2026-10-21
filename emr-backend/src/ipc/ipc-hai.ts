import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, IsUUID, Length, Matches, MaxLength, ValidateIf } from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser } from '../auth/roles';
import { loadEnv } from '../config/env';
import { IPC_ANY, IPC_FULL, IPC_STATUS_READ, IpcCommon, ipcRules, type Ex, type IpcRules, type Trx } from './ipc-common';

const TZ = loadEnv().CLINIC_TZ;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const HAI_STATUS_KA: Record<string, string> = { suspected: 'ეჭვი', review: 'განხილვაში', confirmed: 'დადასტურებული', rejected: 'უარყოფილი' };
const DEVICE_KA: Record<string, string> = { central_line: 'ცენტრალური ხაზი', urinary: 'შარდის კათეტერი', ventilator: 'ინვაზიური ვენტილაცია' };

class CaseCreateDto {
  @IsUUID() patient_id: string;
  @IsOptional() @IsUUID() encounter_id?: string | null;
  @IsString() @Length(2, 12) hai_type: string;
  @Matches(DATE) onset_date: string;
  @IsOptional() @IsIn(['superficial', 'deep', 'organ']) ssi_depth?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsUUID('all', { each: true }) signal_ids?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsUUID('all', { each: true }) organism_ids?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsUUID('all', { each: true }) order_item_ids?: string[];
  @IsOptional() @IsString() @MaxLength(4000) description?: string | null;
}
class CasePatchDto {
  @IsOptional() @IsString() @Length(2, 12) hai_type?: string;
  @IsOptional() @Matches(DATE) onset_date?: string;
  @IsOptional() @IsUUID() encounter_id?: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsIn(['superficial', 'deep', 'organ']) ssi_depth?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsUUID('all', { each: true }) criteria_met?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsUUID('all', { each: true }) organism_ids?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsUUID('all', { each: true }) order_item_ids?: string[];
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsIn(['catheter', 'secondary', 'unknown']) bsi_source?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(4000) description?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsIn(['recovered', 'transferred', 'died', 'ongoing']) outcome?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsIn(['yes', 'no', 'unknown']) hai_contributed?: string | null;
  /** მოწყობილობასთან კავშირის ხელით შეცვლა (მიზეზით); false — ავტომატურზე დაბრუნება */
  @IsOptional() @IsBoolean() device_override?: boolean;
  @IsOptional() @IsBoolean() device_assoc?: boolean;
  @IsOptional() @IsString() @MaxLength(500) device_note?: string;
  /** მიკუთვნების ხელით შეცვლა (მიზეზით); null — ავტომატურზე დაბრუნება */
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() department_id?: string | null;
  @IsOptional() @IsString() @MaxLength(500) attribution_note?: string;
}
class ReasonDto { @IsString() @Length(3, 500) reason: string }

export interface HaiContext {
  encounter_id: string | null; adm_no: string | null; admitted_at: string | null; onset_day: number | null;
  department_id: string | null; department: string | null; attribution: 'current' | 'transfer' | 'readmission'; readmission: boolean; previous_adm_no: string | null;
  device_kind: string | null; device_name: string | null; device_days: number | null; device_assoc: boolean; device_detail: string | null;
  warnings: { code: string; message: string }[];
}

/**
 * HAI რეესტრი (0068): შემთხვევა სიგნალიდან ან ხელით → კონტექსტი (დღე, მიკუთვნება, ხელახალი ჰოსპიტალიზაცია, მოწყობილობა) ავტომატურად;
 * კრიტერიუმების ჩეკლისტი (აქტიური ნაკრები); ეჭვი → განხილვა → დადასტურებული / უარყოფილი (დადასტურება — infection).
 * ხარისხის ინციდენტი — ცალკე (ფორმა წყაროთი hai_case); IPC ხედავს მხოლოდ ნომერს / სტატუსს.
 */
@Injectable()
export class IpcHaiService {
  constructor(private readonly c: IpcCommon, private readonly audit: AuditService) {}
  private get db() { return this.c.db; }

  // =============================================================== კონტექსტი
  async context(ex: Ex, r: IpcRules, p: { patient_id: string; encounter_id?: string | null; onset_date: string; hai_type: string }): Promise<HaiContext> {
    const warnings: HaiContext['warnings'] = [];
    const t = await ex.selectFrom('ipc_hai_types').select(['code', 'device_kind', 'device_name', 'is_active']).where('code', '=', p.hai_type).executeTakeFirst();
    if (!t?.is_active) throw new BadRequestException({ code: 'HAI_TYPE', message: 'HAI ტიპი ვერ მოიძებნა ან გათიშულია' });
    const stayQ = ex.selectFrom('inpatient_stays as st').select(['st.encounter_id', 'st.adm_no', 'st.admitted_at', 'st.ended_at', 'st.status', 'st.patient_id']).where('st.patient_id', '=', p.patient_id)
      .where('st.status', '<>', 'cancelled');
    const stay = p.encounter_id
      ? await stayQ.where('st.encounter_id', '=', p.encounter_id).executeTakeFirst()
      : await stayQ.where(sql<boolean>`(st.admitted_at AT TIME ZONE ${TZ})::date <= ${p.onset_date}::date`)
        .where(sql<boolean>`(st.ended_at IS NULL OR (st.ended_at AT TIME ZONE ${TZ})::date >= ${p.onset_date}::date)`).orderBy('st.admitted_at', 'desc').executeTakeFirst();
    if (p.encounter_id && !stay) throw new BadRequestException({ code: 'STAY', message: 'ჰოსპიტალიზაცია ვერ მოიძებნა (ან სხვა პაციენტისაა)' });
    const ctx: HaiContext = { encounter_id: stay?.encounter_id ?? null, adm_no: stay?.adm_no ?? null, admitted_at: stay ? String(stay.admitted_at) : null, onset_day: null,
      department_id: null, department: null, attribution: 'current', readmission: false, previous_adm_no: null,
      device_kind: t.device_kind, device_name: t.device_name, device_days: null, device_assoc: false, device_detail: null, warnings };
    if (!stay) { warnings.push({ code: 'NO_STAY', message: 'ინფექციის დღეს პაციენტი სტაციონარში არ ყოფილა — მიუთითეთ ჰოსპიტალიზაცია ან მიკუთვნება ხელით' }); return ctx; }
    ctx.onset_day = Number((await sql<{ d: number }>`SELECT (${p.onset_date}::date - (${stay.admitted_at}::timestamptz AT TIME ZONE ${TZ})::date + 1)::int AS d`.execute(ex)).rows[0].d);
    if (ctx.onset_day < 1) throw new BadRequestException({ code: 'ONSET_BEFORE_ADMISSION', message: 'ინფექციის დღე ჰოსპიტალიზაციამდეა' });
    // განყოფილება ინფექციის დღის ბოლოს (ამ ჰოსპიტალიზაციის ბოლო ეპიზოდი, რომელიც მანამდე დაიწყო)
    const asg = await ex.selectFrom('bed_assignments as a').innerJoin('departments as d', 'd.id', 'a.department_id').select(['a.department_id', 'd.name', 'a.started_at'])
      .where('a.encounter_id', '=', stay.encounter_id).where(sql<boolean>`(a.started_at AT TIME ZONE ${TZ})::date <= ${p.onset_date}::date`).orderBy('a.started_at', 'desc').execute();
    if (asg.length) { ctx.department_id = asg[0].department_id; ctx.department = asg[0].name; }
    // გადაყვანის წესი: ინფექცია გადაყვანიდან hai_transfer_days დღეზე ნაკლებში → წინა განყოფილება
    if (r.hai_transfer_days > 0 && asg.length > 1 && asg[0].department_id !== asg[1].department_id) {
      const since = Number((await sql<{ d: number }>`SELECT (${p.onset_date}::date - (${asg[0].started_at}::timestamptz AT TIME ZONE ${TZ})::date)::int AS d`.execute(ex)).rows[0].d);
      if (since < r.hai_transfer_days) { ctx.department_id = asg[1].department_id; ctx.department = asg[1].name; ctx.attribution = 'transfer'; }
    }
    if (ctx.onset_day < r.hospital_onset_day) {
      // ადრეული: ხელახალი ჰოსპიტალიზაცია (წინა გაწერიდან hai_readmit_days-ში) → წინა ჰოსპიტალიზაციის ბოლო განყოფილება
      const prev = r.hai_readmit_days > 0 ? await ex.selectFrom('inpatient_stays as pst').select(['pst.encounter_id', 'pst.adm_no', 'pst.ended_at'])
        .where('pst.patient_id', '=', p.patient_id).where('pst.status', '=', 'discharged').where('pst.encounter_id', '<>', stay.encounter_id)
        .where('pst.ended_at', '<=', stay.admitted_at as unknown as Date)
        .where('pst.ended_at', '>=', sql<Date>`${stay.admitted_at}::timestamptz - make_interval(days => ${r.hai_readmit_days})`).orderBy('pst.ended_at', 'desc').executeTakeFirst() : undefined;
      if (prev) {
        const last = await ex.selectFrom('bed_assignments as a').innerJoin('departments as d', 'd.id', 'a.department_id').select(['a.department_id', 'd.name'])
          .where('a.encounter_id', '=', prev.encounter_id).orderBy('a.started_at', 'desc').executeTakeFirst();
        ctx.readmission = true; ctx.attribution = 'readmission'; ctx.previous_adm_no = prev.adm_no;
        if (last) { ctx.department_id = last.department_id; ctx.department = last.name; }
      } else {
        warnings.push({ code: 'ONSET_EARLY', message: `ინფექცია ჰოსპიტალიზაციის ${ctx.onset_day}-ე დღეს (< ${r.hospital_onset_day}) — ECDC-ით ჰოსპიტალური არ არის (თუ არ არის წინა ჰოსპიტალიზაციიდან / ოპერაციიდან)` });
      }
    }
    // მოწყობილობა: ინფექციის დღეს ან წინა დღეს იდგა; დღე ≥ device_min_days → ასოცირებული
    if (t.device_kind) {
      const dev = t.device_kind === 'ventilator'
        ? (await sql<{ started: string; ended: string | null; d: number }>`
            SELECT iv.started_at AS started, iv.ended_at AS ended, (${p.onset_date}::date - (iv.started_at AT TIME ZONE ${TZ})::date + 1)::int AS d
              FROM icu_ventilation iv WHERE iv.patient_id = ${p.patient_id} AND iv.kind = 'invasive' AND iv.voided_at IS NULL
               AND (iv.started_at AT TIME ZONE ${TZ})::date <= ${p.onset_date}::date
               AND (iv.ended_at IS NULL OR (iv.ended_at AT TIME ZONE ${TZ})::date >= ${p.onset_date}::date - 1)
             ORDER BY iv.started_at LIMIT 1`.execute(ex)).rows
        : (await sql<{ started: string; ended: string | null; d: number; kind: string }>`
            SELECT ld.inserted_at AS started, ld.removed_at AS ended, ld.kind, (${p.onset_date}::date - (ld.inserted_at AT TIME ZONE ${TZ})::date + 1)::int AS d
              FROM lines_drains ld WHERE ld.patient_id = ${p.patient_id} AND ld.voided_at IS NULL
               AND ld.kind = ANY(${sql.val(t.device_kind === 'urinary' ? ['urinary'] : r.central_line_kinds)}::text[])
               AND (ld.inserted_at AT TIME ZONE ${TZ})::date <= ${p.onset_date}::date
               AND (ld.removed_at IS NULL OR (ld.removed_at AT TIME ZONE ${TZ})::date >= ${p.onset_date}::date - 1)
             ORDER BY ld.inserted_at LIMIT 1`.execute(ex)).rows;
      if (dev.length) {
        ctx.device_days = dev[0].d; ctx.device_assoc = dev[0].d >= r.device_min_days;
        ctx.device_detail = `${DEVICE_KA[t.device_kind]}: ${ctx.device_days}-ე დღე${dev[0].ended ? ' (მოხსნილია)' : ''}`;
      } else ctx.device_detail = `${DEVICE_KA[t.device_kind]} ინფექციის დღეს / წინა დღეს არ იდგა`;
    }
    return ctx;
  }

  async preview(q: { patient_id: string; encounter_id?: string; onset_date: string; hai_type: string }) {
    const r = await this.c.rules();
    if (!q.patient_id || !DATE.test(q.onset_date ?? '') || !q.hai_type) throw new BadRequestException('patient_id, onset_date, hai_type სავალდებულოა');
    return this.context(this.db, r, q);
  }

  // =============================================================== შემთხვევები
  private async nextNo(trx: Trx) {
    const year = Number((await sql<{ y: number }>`SELECT extract(year FROM now())::int AS y`.execute(trx)).rows[0].y);
    const { last_value } = await trx.insertInto('document_counters').values({ document_type: 'ipc_HAI', year, last_value: 1 })
      .onConflict((oc) => oc.columns(['document_type', 'year']).doUpdateSet({ last_value: sql`document_counters.last_value + 1` })).returning('last_value').executeTakeFirstOrThrow();
    return `HAI${String(year).slice(2)}-${String(last_value).padStart(6, '0')}`;
  }
  private event(trx: Trx, caseId: string, userId: string | null, kind: string, text?: string | null, data?: unknown) {
    return trx.insertInto('ipc_hai_events').values({ case_id: caseId, user_id: userId, kind, text: text ?? null, data: data === undefined ? null : JSON.stringify(data) }).execute();
  }
  private async activeSet(ex: Ex, r: IpcRules) {
    return ex.selectFrom('ipc_criteria_sets').select(['id']).where('code', '=', r.hai_criteria_set).where('is_active', '=', true).orderBy('created_at', 'desc').executeTakeFirst();
  }
  private ctxValues(ctx: HaiContext) {
    return { encounter_id: ctx.encounter_id, onset_day: ctx.onset_day, department_id: ctx.department_id, attribution: ctx.attribution, readmission: ctx.readmission,
      device_kind: ctx.device_kind as 'central_line' | 'urinary' | 'ventilator' | null, device_assoc: ctx.device_assoc, device_days: ctx.device_days };
  }

  async create(d: CaseCreateDto, u: AuthUser, req: Request) {
    const r = await this.c.rules();
    if (d.ssi_depth && d.hai_type !== 'ssi') throw new BadRequestException({ code: 'SSI_DEPTH', message: 'სიღრმე — მხოლოდ SSI-ზე' });
    const id = await this.db.transaction().execute(async (trx) => {
      const p = await trx.selectFrom('patients').select('id').where('id', '=', d.patient_id).executeTakeFirst();
      if (!p) throw new NotFoundException('პაციენტი ვერ მოიძებნა');
      const sigs = d.signal_ids?.length ? await trx.selectFrom('ipc_signals').selectAll().where('id', 'in', d.signal_ids).forUpdate().execute() : [];
      if (sigs.length !== (d.signal_ids?.length ?? 0)) throw new BadRequestException({ code: 'SIGNAL', message: 'სიგნალი ვერ მოიძებნა' });
      for (const s of sigs) {
        if (s.patient_id && s.patient_id !== d.patient_id) throw new BadRequestException({ code: 'SIGNAL_PATIENT', message: 'სიგნალი სხვა პაციენტისაა' });
        if (s.status === 'case') throw new ConflictException({ code: 'SIGNAL_CASE', message: 'სიგნალი უკვე მიბმულია შემთხვევაზე' });
      }
      const ctx = await this.context(trx, r, d);
      const sc = await this.c.scope(u);
      if (!sc.full && (!ctx.department_id || !sc.depts.includes(ctx.department_id))) throw new ForbiddenException({ code: 'OUT_OF_SCOPE', message: 'შემთხვევა თქვენს განყოფილებას არ მიეკუთვნება' });
      const orgs = [...new Set([...(d.organism_ids ?? []), ...sigs.map((s) => s.organism_id).filter((x): x is string => !!x)])];
      const items = [...new Set([...(d.order_item_ids ?? []), ...sigs.map((s) => s.order_item_id).filter((x): x is string => !!x)])];
      const set = await this.activeSet(trx, r);
      const row = await trx.insertInto('ipc_hai_cases').values({ case_no: await this.nextNo(trx), patient_id: d.patient_id, hai_type: d.hai_type, ssi_depth: d.ssi_depth ?? null,
        onset_date: d.onset_date, ...this.ctxValues(ctx), criteria_set_id: set?.id ?? null, organism_ids: orgs, order_item_ids: items,
        description: d.description?.trim() || null, created_by: u.id }).returning(['id', 'case_no']).executeTakeFirstOrThrow();
      if (sigs.length) await trx.updateTable('ipc_signals').set({ status: 'case', case_id: row.id, handled_by: u.id, handled_at: sql`now()` }).where('id', 'in', sigs.map((s) => s.id)).execute();
      await this.event(trx, row.id, u.id, 'created', null, { signals: sigs.length, warnings: ctx.warnings.map((w) => w.code) });
      await this.audit.log(auditCtx(req), { action: 'IPC_HAI_CREATE', entityName: 'ipc_hai_cases', entityId: row.id, newData: { ...d, case_no: row.case_no } }, trx);
      return row.id;
    });
    return this.detail(id, u);
  }

  private async lock(trx: Trx, id: string, u: AuthUser) {
    const x = await trx.selectFrom('ipc_hai_cases').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!x) throw new NotFoundException('HAI შემთხვევა ვერ მოიძებნა');
    const sc = await this.c.scope(u);
    if (!sc.full && (!x.department_id || !sc.depts.includes(x.department_id))) throw new ForbiddenException({ code: 'OUT_OF_SCOPE', message: 'შემთხვევა თქვენი განყოფილების არ არის' });
    return x;
  }

  async update(id: string, d: CasePatchDto, u: AuthUser, req: Request) {
    const r = await this.c.rules();
    await this.db.transaction().execute(async (trx) => {
      const x = await this.lock(trx, id, u);
      const closed = ['confirmed', 'rejected'].includes(x.status);
      const lockedKeys = (Object.keys(d) as (keyof CasePatchDto)[]).filter((k) => d[k] !== undefined && !['outcome', 'hai_contributed', 'description'].includes(k));
      if (closed && lockedKeys.length) throw new ConflictException({ code: 'CASE_LOCKED', message: 'დასრულებულ შემთხვევაში იცვლება მხოლოდ გამოსავალი / აღწერა — სხვისთვის ხელახლა გახსენით' });
      const type = d.hai_type ?? x.hai_type;
      if ((d.ssi_depth ?? x.ssi_depth) && type !== 'ssi') throw new BadRequestException({ code: 'SSI_DEPTH', message: 'სიღრმე — მხოლოდ SSI-ზე' });
      const vals: Record<string, unknown> = {};
      for (const k of ['ssi_depth', 'bsi_source', 'outcome', 'hai_contributed'] as const) if (d[k] !== undefined) vals[k] = d[k];
      if (d.description !== undefined) vals.description = d.description?.trim() || null;
      if (d.organism_ids) vals.organism_ids = [...new Set(d.organism_ids)];
      if (d.order_item_ids) vals.order_item_ids = [...new Set(d.order_item_ids)];
      if (d.hai_type && d.hai_type !== x.hai_type) { vals.hai_type = d.hai_type; vals.criteria_met = []; if (d.hai_type !== 'ssi') vals.ssi_depth = null; if (d.hai_type !== 'bsi') vals.bsi_source = null; }
      if (d.criteria_met) {
        const ok = await trx.selectFrom('ipc_criteria_items').select('id').where('id', 'in', d.criteria_met.length ? d.criteria_met : ['00000000-0000-0000-0000-000000000000'])
          .where('hai_type', '=', type).where('set_id', '=', x.criteria_set_id ?? '00000000-0000-0000-0000-000000000000').execute();
        if (ok.length !== new Set(d.criteria_met).size) throw new BadRequestException({ code: 'CRITERIA_ITEM', message: 'კრიტერიუმი სხვა ტიპის / ნაკრებისაა' });
        vals.criteria_met = [...new Set(d.criteria_met)];
      }
      // კონტექსტის გადათვლა: ტიპი / დღე / ჰოსპიტალიზაცია შეიცვალა
      if (d.hai_type || d.onset_date || d.encounter_id) {
        const ctx = await this.context(trx, r, { patient_id: x.patient_id, encounter_id: d.encounter_id ?? x.encounter_id, onset_date: d.onset_date ?? String(x.onset_date).slice(0, 10), hai_type: type });
        const cv = this.ctxValues(ctx);
        if (d.onset_date) vals.onset_date = d.onset_date;
        Object.assign(vals, cv);
        if (x.attribution === 'manual') { delete vals.department_id; delete vals.attribution; }
        if (x.device_override) { delete vals.device_assoc; }
      }
      if (d.department_id !== undefined) {
        if (d.department_id === null) {
          const ctx = await this.context(trx, r, { patient_id: x.patient_id, encounter_id: x.encounter_id, onset_date: String(vals.onset_date ?? x.onset_date).slice(0, 10), hai_type: type });
          Object.assign(vals, { department_id: ctx.department_id, attribution: ctx.attribution, attribution_note: null });
        } else {
          if ((d.attribution_note?.trim().length ?? 0) < 3) throw new BadRequestException({ code: 'ATTRIBUTION_NOTE', message: 'მიკუთვნების ხელით შეცვლას სჭირდება მიზეზი' });
          const dep = await trx.selectFrom('departments').select('id').where('id', '=', d.department_id).executeTakeFirst();
          if (!dep) throw new BadRequestException('განყოფილება ვერ მოიძებნა');
          Object.assign(vals, { department_id: d.department_id, attribution: 'manual', attribution_note: d.attribution_note!.trim() });
        }
      }
      if (d.device_override !== undefined) {
        if (d.device_override) {
          if ((d.device_note?.trim().length ?? 0) < 3) throw new BadRequestException({ code: 'DEVICE_NOTE', message: 'მოწყობილობასთან კავშირის შეცვლას სჭირდება მიზეზი' });
          Object.assign(vals, { device_override: true, device_assoc: !!d.device_assoc, device_note: d.device_note!.trim() });
        } else {
          const ctx = await this.context(trx, r, { patient_id: x.patient_id, encounter_id: x.encounter_id, onset_date: String(vals.onset_date ?? x.onset_date).slice(0, 10), hai_type: type });
          Object.assign(vals, { device_override: false, device_assoc: ctx.device_assoc, device_days: ctx.device_days, device_note: null });
        }
      }
      if (!Object.keys(vals).length) throw new BadRequestException({ code: 'NO_CHANGE', message: 'ცვლილება არ არის' });
      await trx.updateTable('ipc_hai_cases').set(vals).where('id', '=', id).execute();
      await this.event(trx, id, u.id, 'updated', null, { fields: Object.keys(vals) });
      await this.audit.log(auditCtx(req), { action: 'IPC_HAI_UPDATE', entityName: 'ipc_hai_cases', entityId: id, oldData: Object.fromEntries(Object.keys(vals).map((k) => [k, (x as Record<string, unknown>)[k]])), newData: vals }, trx);
    });
    return this.detail(id, u);
  }

  async transition(id: string, to: 'review' | 'confirm' | 'reject' | 'reopen', reason: string | null, u: AuthUser, req: Request) {
    const r = await this.c.rules();
    if ((to === 'confirm' || to === 'reject' || to === 'reopen') && !has(u, ...IPC_FULL)) throw new ForbiddenException('დადასტურება / უარყოფა / ხელახლა გახსნა — ინფექციის კონტროლი');
    const notify = await this.db.transaction().execute(async (trx) => {
      const x = await this.lock(trx, id, u);
      if (to === 'review') {
        if (x.status !== 'suspected') throw new ConflictException({ code: 'STATE', message: 'განხილვა იწყება მხოლოდ ეჭვიდან' });
        await trx.updateTable('ipc_hai_cases').set({ status: 'review' }).where('id', '=', id).execute();
      } else if (to === 'confirm') {
        if (!['suspected', 'review'].includes(x.status)) throw new ConflictException({ code: 'STATE', message: 'შემთხვევა უკვე დასრულებულია' });
        if (x.onset_day !== null && x.onset_day < r.hospital_onset_day && !x.readmission && x.attribution !== 'manual')
          throw new ConflictException({ code: 'ONSET_EARLY', message: `ინფექცია ${x.onset_day}-ე დღეს (< ${r.hospital_onset_day}) — ჰოსპიტალური არ არის. საჭიროებისას მიუთითეთ მიკუთვნება ხელით (მიზეზით)` });
        if (!x.department_id) throw new ConflictException({ code: 'NO_DEPARTMENT', message: 'მიკუთვნებული განყოფილება არ არის' });
        if (x.hai_type === 'ssi' && !x.ssi_depth) throw new BadRequestException({ code: 'SSI_DEPTH', message: 'SSI — მიუთითეთ სიღრმე' });
        if (x.hai_type === 'bsi' && !x.bsi_source) throw new BadRequestException({ code: 'BSI_SOURCE', message: 'BSI — მიუთითეთ წყარო (კათეტერი / მეორადი / უცნობი)' });
        const items = x.criteria_set_id ? await trx.selectFrom('ipc_criteria_items').select(['id', 'required', 'text']).where('set_id', '=', x.criteria_set_id)
          .where('hai_type', '=', x.hai_type).where('is_active', '=', true).execute() : [];
        const met = new Set(x.criteria_met);
        const missing = items.filter((i) => i.required && !met.has(i.id));
        if (items.length && (!x.criteria_met.length || missing.length)) throw new BadRequestException({ code: 'CRITERIA', message: missing.length
          ? `სავალდებულო კრიტერიუმი არ არის მონიშნული: ${missing.map((m) => m.text.slice(0, 60)).join('; ')}` : 'მონიშნეთ მინიმუმ ერთი კრიტერიუმი' });
        await trx.updateTable('ipc_hai_cases').set({ status: 'confirmed', confirmed_by: u.id, confirmed_at: sql`now()`, rejected_reason: null }).where('id', '=', id).execute();
      } else if (to === 'reject') {
        if (!['suspected', 'review'].includes(x.status)) throw new ConflictException({ code: 'STATE', message: 'შემთხვევა უკვე დასრულებულია' });
        await trx.updateTable('ipc_hai_cases').set({ status: 'rejected', rejected_reason: reason!.trim() }).where('id', '=', id).execute();
      } else {
        if (!['confirmed', 'rejected'].includes(x.status)) throw new ConflictException({ code: 'STATE', message: 'გაიხსნება მხოლოდ დასრულებული' });
        await trx.updateTable('ipc_hai_cases').set({ status: 'review', confirmed_by: null, confirmed_at: null, rejected_reason: null }).where('id', '=', id).execute();
      }
      await this.event(trx, id, u.id, to, reason);
      await this.audit.log(auditCtx(req), { action: `IPC_HAI_${to.toUpperCase()}`, entityName: 'ipc_hai_cases', entityId: id, oldData: { status: x.status }, newData: { reason } }, trx);
      return to === 'confirm' ? x : null;
    });
    if (notify) {
      const t = await this.db.selectFrom('ipc_hai_types').select(['short_name', 'device_name']).where('code', '=', notify.hai_type).executeTakeFirstOrThrow();
      const st = notify.encounter_id ? await this.db.selectFrom('inpatient_stays as st').innerJoin('encounters as e', 'e.id', 'st.encounter_id')
        .select(['e.attending_doctor_id', 'st.status']).where('st.encounter_id', '=', notify.encounter_id).executeTakeFirst() : undefined;
      const to2 = [...(notify.department_id ? await this.c.deptIpcUsers(notify.department_id) : []), ...(st?.status === 'active' && st.attending_doctor_id ? [st.attending_doctor_id] : [])];
      await this.c.bell(to2, { kind: 'ipc_hai', title: `HAI დადასტურდა: ${notify.device_assoc && t.device_name ? t.device_name : t.short_name} (${notify.case_no})`,
        link: notify.encounter_id ? `/inpatient/stay/${notify.encounter_id}` : null, entityId: id });
    }
    return this.detail(id, u);
  }

  async list(u: AuthUser, q: { status?: string; hai_type?: string; department_id?: string; from?: string; to?: string; device?: string; q?: string }) {
    await this.c.rules();
    const sc = await this.c.scope(u);
    let x = this.db.selectFrom('ipc_hai_cases as h').innerJoin('ipc_hai_types as t', 't.code', 'h.hai_type').innerJoin('patients as p', 'p.id', 'h.patient_id')
      .leftJoin('departments as d', 'd.id', 'h.department_id').leftJoin('inpatient_stays as st', 'st.encounter_id', 'h.encounter_id')
      .select(['h.id', 'h.case_no', 'h.patient_id', 'h.hai_type', 't.short_name', 't.device_name', 'h.ssi_depth', 'h.status', 'h.onset_date', 'h.onset_day', 'h.department_id', 'd.name as department',
        'h.attribution', 'h.readmission', 'h.device_assoc', 'h.device_days', 'h.device_kind', 'h.created_at', 'h.confirmed_at', 'p.first_name', 'p.last_name', 'p.personal_number', 'st.adm_no',
        sql<string[]>`ARRAY(SELECT o.name FROM micro_organisms o WHERE o.id = ANY(h.organism_ids) ORDER BY o.name)`.as('organisms')])
      .orderBy('h.onset_date', 'desc').orderBy('h.created_at', 'desc').limit(500);
    if (q.status) x = x.where('h.status', 'in', q.status.split(','));
    if (q.hai_type) x = x.where('h.hai_type', '=', q.hai_type);
    if (q.department_id) x = x.where('h.department_id', '=', q.department_id);
    if (q.from && DATE.test(q.from)) x = x.where('h.onset_date', '>=', q.from);
    if (q.to && DATE.test(q.to)) x = x.where('h.onset_date', '<=', q.to);
    if (q.device === '1') x = x.where('h.device_assoc', '=', true);
    if (q.q?.trim()) { const s = `%${q.q.trim().toLowerCase()}%`; x = x.where((eb) => eb.or([eb(sql`lower(p.first_name || ' ' || p.last_name)`, 'like', s), eb('p.personal_number', 'like', s), eb(sql`lower(h.case_no)`, 'like', s)])); }
    if (!sc.full) x = x.where('h.department_id', 'in', sc.depts);
    return (await x.execute()).map((h) => ({ ...h, status_ka: HAI_STATUS_KA[h.status] }));
  }

  async detail(id: string, u: AuthUser) {
    const r = await this.c.rules();
    const x = await this.db.selectFrom('ipc_hai_cases as h').innerJoin('ipc_hai_types as t', 't.code', 'h.hai_type').innerJoin('patients as p', 'p.id', 'h.patient_id')
      .leftJoin('departments as d', 'd.id', 'h.department_id').leftJoin('inpatient_stays as st', 'st.encounter_id', 'h.encounter_id')
      .leftJoin('users as cu', 'cu.id', 'h.created_by').leftJoin('users as fu', 'fu.id', 'h.confirmed_by').leftJoin('ipc_criteria_sets as cs', 'cs.id', 'h.criteria_set_id')
      .selectAll('h').select(['t.name as type_name', 't.short_name', 't.device_name', 'd.name as department', 'p.first_name', 'p.last_name', 'p.personal_number', 'p.birth_date', 'p.gender',
        'st.adm_no', 'st.admitted_at', 'st.status as stay_status', 'cs.name as criteria_set', 'cs.version as criteria_version',
        sql<string | null>`cu.first_name || ' ' || cu.last_name`.as('created_by_name'), sql<string | null>`fu.first_name || ' ' || fu.last_name`.as('confirmed_by_name')])
      .where('h.id', '=', id).executeTakeFirst();
    if (!x) throw new NotFoundException('HAI შემთხვევა ვერ მოიძებნა');
    const sc = await this.c.scope(u);
    if (!sc.full && (!x.department_id || !sc.depts.includes(x.department_id))) throw new ForbiddenException({ code: 'OUT_OF_SCOPE', message: 'შემთხვევა თქვენი განყოფილების არ არის' });
    const onset = String(x.onset_date).slice(0, 10);
    const [criteria, organisms, signals, events, cultures, incidents, ctx] = await Promise.all([
      x.criteria_set_id ? this.db.selectFrom('ipc_criteria_items').select(['id', 'grp', 'text', 'required', 'sort_order']).where('set_id', '=', x.criteria_set_id).where('hai_type', '=', x.hai_type)
        .where('is_active', '=', true).orderBy('sort_order').execute() : Promise.resolve([]),
      x.organism_ids.length ? this.db.selectFrom('micro_organisms').select(['id', 'name', 'code']).where('id', 'in', x.organism_ids).execute() : Promise.resolve([]),
      this.db.selectFrom('ipc_signals').select(['id', 'kind', 'summary', 'event_at']).where('case_id', '=', id).orderBy('event_at').execute(),
      this.db.selectFrom('ipc_hai_events as e').leftJoin('users as eu', 'eu.id', 'e.user_id').select(['e.id', 'e.at', 'e.kind', 'e.text', 'e.data', sql<string | null>`eu.first_name || ' ' || eu.last_name`.as('user_name')])
        .where('e.case_id', '=', id).orderBy('e.at').execute(),
      // პაციენტის დადებითი კულტურები ინფექციის დღის ±14 დღეში (არჩევისთვის)
      sql<{ id: string; service: string; specimen_type: string | null; collected_at: string; organisms: { id: string; name: string }[] }>`
        SELECT i.id, s.name AS service, s.specimen_type, coalesce(sp.collected_at, i.ordered_at) AS collected_at,
               (SELECT json_agg(DISTINCT jsonb_build_object('id', o.id, 'name', o.name)) FROM micro_cultures c JOIN micro_isolates mi ON mi.culture_id = c.id
                 JOIN micro_organisms o ON o.id = mi.organism_id WHERE c.order_item_id = i.id) AS organisms
          FROM dx_order_items i JOIN dx_services s ON s.id = i.service_id AND s.is_micro LEFT JOIN lab_specimens sp ON sp.id = i.specimen_id
         WHERE i.patient_id = ${x.patient_id} AND abs((coalesce(sp.collected_at, i.ordered_at) AT TIME ZONE ${TZ})::date - ${onset}::date) <= 14
           AND EXISTS (SELECT 1 FROM micro_cultures c JOIN micro_isolates mi ON mi.culture_id = c.id WHERE c.order_item_id = i.id AND mi.organism_id IS NOT NULL)
         ORDER BY collected_at`.execute(this.db).then((q) => q.rows),
      this.db.selectFrom('qm_incidents').select(['inc_no', 'status', 'reported_at']).where('source_type', '=', 'hai_case').where('source_id', '=', id).orderBy('reported_at').execute(),
      this.context(this.db, r, { patient_id: x.patient_id, encounter_id: x.encounter_id, onset_date: onset, hai_type: x.hai_type }).catch(() => null),
    ]);
    return { ...x, onset_date: onset, status_ka: HAI_STATUS_KA[x.status], criteria, organisms, signals, events, cultures, incidents, context: ctx,
      can: { edit: !['confirmed', 'rejected'].includes(x.status), decide: has(u, ...IPC_FULL), quality: !!x.encounter_id } };
  }

  /** ჰოსპიტალიზაციის გვერდზე (მკურნალი ექიმი, პერსონალი) — მოკლე, მხოლოდ დადასტურებული / განხილვაში */
  async forStay(encounterId: string) {
    if (!(await ipcRules(this.db))) return [];
    return this.db.selectFrom('ipc_hai_cases as h').innerJoin('ipc_hai_types as t', 't.code', 'h.hai_type')
      .select(['h.id', 'h.case_no', 'h.status', 'h.onset_date', 'h.device_assoc', 't.short_name', 't.device_name', 'h.ssi_depth'])
      .where('h.encounter_id', '=', encounterId).where('h.status', 'in', ['review', 'confirmed']).orderBy('h.onset_date').execute()
      .then((rows) => rows.map((h) => ({ ...h, onset_date: String(h.onset_date).slice(0, 10), label: h.device_assoc && h.device_name ? h.device_name : h.short_name, status_ka: HAI_STATUS_KA[h.status] })));
  }

  async catalog() {
    const r = await this.c.rules();
    const [types, sets, items] = await Promise.all([
      this.db.selectFrom('ipc_hai_types').selectAll().orderBy('sort_order').execute(),
      this.db.selectFrom('ipc_criteria_sets').selectAll().orderBy('code').orderBy('created_at').execute(),
      this.db.selectFrom('ipc_criteria_items').selectAll().orderBy('hai_type').orderBy('sort_order').execute(),
    ]);
    return { types, sets: sets.map((s) => ({ ...s, active_for_clinic: s.code === r.hai_criteria_set })), items };
  }
}

@Controller('ipc')
export class IpcHaiController {
  constructor(private readonly s: IpcHaiService) {}
  @Get('hai') @Roles(...IPC_ANY) list(@CurrentUser() u: AuthUser, @Query('status') status?: string, @Query('hai_type') hai_type?: string, @Query('department_id') department_id?: string,
    @Query('from') from?: string, @Query('to') to?: string, @Query('device') device?: string, @Query('q') q?: string) { return this.s.list(u, { status, hai_type, department_id, from, to, device, q }); }
  @Get('hai/context') @Roles(...IPC_ANY) context(@Query('patient_id') patient_id: string, @Query('encounter_id') encounter_id: string, @Query('onset_date') onset_date: string, @Query('hai_type') hai_type: string) {
    return this.s.preview({ patient_id, encounter_id: encounter_id || undefined, onset_date, hai_type });
  }
  @Get('hai-catalog') @Roles(...IPC_ANY, 'infection_view', 'admin') catalog() { return this.s.catalog(); }
  @Get('hai/:id') @Roles(...IPC_ANY) detail(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser) { return this.s.detail(id, u); }
  @Post('hai') @Roles(...IPC_ANY) create(@Body() d: CaseCreateDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.create(d, u, r); }
  @Patch('hai/:id') @Roles(...IPC_ANY) update(@Param('id', ParseUUIDPipe) id: string, @Body() d: CasePatchDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.update(id, d, u, r); }
  @Post('hai/:id/review') @HttpCode(200) @Roles(...IPC_ANY) review(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.transition(id, 'review', null, u, r); }
  @Post('hai/:id/confirm') @HttpCode(200) @Roles(...IPC_FULL) confirm(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.transition(id, 'confirm', null, u, r); }
  @Post('hai/:id/reject') @HttpCode(200) @Roles(...IPC_FULL) reject(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.transition(id, 'reject', d.reason, u, r); }
  @Post('hai/:id/reopen') @HttpCode(200) @Roles(...IPC_FULL) reopen(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.transition(id, 'reopen', d.reason, u, r); }
  @Get('stays/:id/hai') @Roles(...IPC_STATUS_READ) stay(@Param('id', ParseUUIDPipe) id: string) { return this.s.forStay(id); }
}

