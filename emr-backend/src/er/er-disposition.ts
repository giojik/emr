import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Post, Query,
  Req, Res, StreamableFile } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsISO8601, IsObject, IsOptional, IsString, IsUUID, Length, MaxLength, ValidateNested } from 'class-validator';
import type { Request, Response } from 'express';
import { sql, type Kysely, type Transaction } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser, type Role } from '../auth/roles';
import { mapPgError } from '../common/pg-errors';
import { InjectDb, type Database } from '../database/database.module';
import type { DB } from '../database/db';
import { InpatientModule, InpatientService, type AdmitDto, type InpatientSettings } from '../inpatient/inpatient';
import { ClinicalHistory, RequireModule } from '../modules/module-guard';
import { modActive } from '../modules/modules-ref';
import { modulesRef } from '../modules/modules-ref';
import { NotificationsService } from '../notifications/notifications';
import { ER_DISPOSITION_KA } from '../templates/template-context';
import { TemplatesModule } from '../templates/templates';
import { erCanWrite, erClinicalSettings, type ErClinicalSettings } from './er-access';
import { reopenErVisitTx } from './er-hooks';
import { ER_MANAGE, ER_READ } from './er';
import { ErSummaryService } from './er-summary';

/**
 * გადაუდებელი დახმარება (ER), 0090 — გამოსავალი.
 *  • სახეები: home / admitted / transfer / ama / lwbs / death. LWBS — ექიმის აყვანამდე (er_triage / er_doctor); სხვა — ER-ის ექიმი (doctor_write) / admin.
 *  • შემოწმებები (require_initial_note / require_diagnosis / verbal_unconfirmed / open_items_check): block → 409 ER_DISPOSITION_BLOCKED,
 *    warn → 409 ER_DISPOSITION_WARNINGS (override_reason). აქტიური დანიშნულებები: admitted → გადატანა (transfer_orders), სხვა → წყდება.
 *  • ჰოსპიტალიზაცია: admit_mode = direct — ER-ის ექიმი აფორმებს (InpatientService.admitTx, იმავე ტრანზაქციაში; საწოლს — განყოფილება);
 *    request — მოთხოვნა → განყოფილება იღებს (საწოლით ან მის გარეშე) / უარყოფს. რბილი: er → inpatient, er → ipd_orders.
 *  • ER-ის ფურცელი (ErSummaryService) — გამოსავლისას; doc_window_h — ჩანაწერი / ICD-10 / ფურცლის განახლება; reopen_h — გაუქმება (შეცდომა).
 */
type Trx = Transaction<DB>;
type Ex = Kysely<DB> | Trx;
const KINDS = ['home', 'admitted', 'transfer', 'ama', 'lwbs', 'death'] as const;
type Kind = (typeof KINDS)[number];
const ACTIVE = ['waiting', 'triaged', 'in_treatment'];
const SEVERITY = ['stable', 'moderate', 'severe', 'critical'] as const;
const ISOLATION = ['contact', 'droplet', 'airborne', 'protective'] as const;
const TRANSPORT = ['own', 'ambulance', 'clinic_transport', 'other'] as const;
type Plan = Record<string, 'continue' | 'stop'>;
export interface DispCheck { code: string; level: 'block' | 'warn' | 'info'; message: string }

// ======================================================================= DTO
export class AdmitPartDto {
  @IsUUID() department_id: string;
  @IsOptional() @IsUUID() attending_doctor_id?: string;
  @IsString() @Length(2, 10) icd10_code: string;
  @IsOptional() @IsIn(SEVERITY) severity?: string;
  @IsOptional() @IsIn(ISOLATION) isolation?: string;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
  @IsOptional() @IsBoolean() confirm?: boolean;
}
export class DispositionDto {
  @IsIn(KINDS) kind: Kind;
  @IsOptional() @IsISO8601() departed_at?: string;
  @IsOptional() @IsString() @MaxLength(4000) recommendations?: string;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
  @IsOptional() @IsUUID() destination_id?: string;
  @IsOptional() @IsString() @MaxLength(300) destination_text?: string;
  @IsOptional() @IsIn(TRANSPORT) transport?: string;
  @IsOptional() @IsString() @MaxLength(1000) transfer_reason?: string;
  @IsOptional() @IsString() @MaxLength(300) receiver?: string;
  @IsOptional() @IsUUID() refusal_consent_id?: string;
  @IsOptional() @IsArray() @ArrayMinSize(2) @ArrayMaxSize(3) @IsUUID('all', { each: true }) refusal_witnesses?: string[];
  @IsOptional() @IsString() @MaxLength(1000) ama_reason?: string;
  @IsOptional() @IsISO8601() death_at?: string;
  @IsOptional() @IsString() @Length(2, 10) death_icd10_code?: string;
  @IsOptional() @IsBoolean() autopsy_required?: boolean;
  @IsOptional() @IsBoolean() dead_on_arrival?: boolean;
  @IsOptional() @ValidateNested() @Type(() => AdmitPartDto) admit?: AdmitPartDto;
  @IsOptional() @IsObject() orders_plan?: Plan;
  @IsOptional() @IsString() @Length(5, 1000) override_reason?: string;
}
export class AdmitRequestDto extends AdmitPartDto {
  @IsOptional() @IsObject() orders_plan?: Plan;
  @IsOptional() @IsString() @Length(5, 1000) override_reason?: string;
}
export class AcceptDto {
  @IsUUID() attending_doctor_id: string;
  @IsOptional() @IsUUID() bed_id?: string;
  @IsOptional() @IsBoolean() confirm?: boolean;
  @IsOptional() @IsObject() orders_plan?: Plan;
}
export class ReasonDto { @IsString() @Length(3, 1000) reason: string }

interface VisitRow {
  encounter_id: string; patient_id: string; department_id: string; status: string; arrived_at: Date | string; ended_at: Date | string | null; doctor_id: string | null;
  doctor_at: Date | string | null; visit_no: string; chief_complaint: string; first_name: string; last_name: string; waiting_for: string[];
}
interface ActiveOrder {
  id: string; kind: string; order_type: string; generic_id: string | null; drug_text: string | null; text: string | null; dose: string | null; dose_unit: string | null;
  route_code: string | null; weight_kg: string | null; volume_ml: string | null; rate_ml_h: string | null; diluent: string | null; prn_reason: string | null;
  prn_min_interval_h: string | null; prn_max_doses: number | null; instructions: string | null; is_verbal: boolean; verbal_confirmed_at: Date | string | null;
  checks: unknown; override_reason: string | null; inn: string | null; strength: string | null; patient_only: boolean | null; high_alert: boolean | null; controlled_class: string | null;
  running: boolean;
}

// ======================================================================= სერვისი
@Injectable()
export class ErDispositionService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService, private readonly ipd: InpatientService,
              private readonly summary: ErSummaryService, private readonly bell: NotificationsService) {}

  private async assertEr() { if (modulesRef.svc) await modulesRef.svc.assertActive('er'); }
  private async visit(id: string, ex: Ex = this.db, lock = false): Promise<VisitRow> {
    let q = ex.selectFrom('er_visits as v').innerJoin('patients as p', 'p.id', 'v.patient_id')
      .select(['v.encounter_id', 'v.patient_id', 'v.department_id', 'v.status', 'v.arrived_at', 'v.ended_at', 'v.doctor_id', 'v.doctor_at', 'v.visit_no', 'v.chief_complaint',
        'v.waiting_for', 'p.first_name', 'p.last_name'])
      .where('v.encounter_id', '=', id);
    if (lock) q = q.forUpdate('v');
    const v = await q.executeTakeFirst();
    if (!v) throw new NotFoundException('ER-ის შემთხვევა ვერ მოიძებნა');
    return v as VisitRow;
  }
  private attending(v: VisitRow) { return v.doctor_id && v.doctor_at ? v.doctor_id : null; }
  private async canDispose(u: AuthUser, v: VisitRow, kind: Kind, s: ErClinicalSettings) {
    if (has(u, 'admin')) return true;
    if (kind === 'lwbs') return has(u, 'er_triage', 'er_doctor', 'er_manage');
    return erCanWrite(u, this.attending(v), s);
  }
  private async notify(ids: (string | null | undefined)[], n: { kind: string; title: string; body?: string; entityId: string; link: string; urgent?: boolean }, except?: string) {
    for (const id of new Set(ids.filter(Boolean) as string[])) if (id !== except) await this.bell.notify(id, { ...n, urgent: !!n.urgent }).catch(() => undefined);
  }

  /** აქტიური დანიშნულებები (+ მიმდინარე ინფუზია) — PRN-ის ვადის გასვლის შემდეგ */
  private async activeOrders(ex: Ex, encounterId: string): Promise<ActiveOrder[]> {
    await ex.updateTable('er_orders').set({ status: 'expired', stopped_at: sql`expires_at` }).where('encounter_id', '=', encounterId)
      .where('status', '=', 'active').where('order_type', '=', 'prn').where('expires_at', '<', sql<Date>`now()`).execute();
    const rows = await ex.selectFrom('er_orders as o').leftJoin('med_generics as g', 'g.id', 'o.generic_id')
      .select(['o.id', 'o.kind', 'o.order_type', 'o.generic_id', 'o.drug_text', 'o.text', 'o.dose', 'o.dose_unit', 'o.route_code', 'o.weight_kg', 'o.volume_ml', 'o.rate_ml_h',
        'o.diluent', 'o.prn_reason', 'o.prn_min_interval_h', 'o.prn_max_doses', 'o.instructions', 'o.is_verbal', 'o.verbal_confirmed_at', 'o.checks', 'o.override_reason',
        'g.inn', 'g.strength', 'g.patient_only', 'g.high_alert', 'g.controlled_class',
        sql<boolean>`EXISTS (SELECT 1 FROM er_administrations a WHERE a.order_id = o.id AND a.voided_at IS NULL AND a.infusion_action = 'start'
          AND NOT EXISTS (SELECT 1 FROM er_administrations b WHERE b.order_id = o.id AND b.voided_at IS NULL AND b.infusion_action = 'stop' AND b.administered_at >= a.administered_at))`.as('running')])
      .where('o.encounter_id', '=', encounterId).where('o.status', '=', 'active').orderBy('o.created_at').execute();
    return rows as unknown as ActiveOrder[];
  }
  private orderLabel(o: ActiveOrder) {
    if (o.kind === 'procedure') return `პროცედურა: ${o.text}`;
    return `${o.inn ? `${o.inn}${o.strength ? ` ${o.strength}` : ''}` : o.drug_text}${o.dose ? ` ${Number(o.dose)} ${o.dose_unit ?? ''}` : ''}${o.rate_ml_h ? ` · ${Number(o.rate_ml_h)} მლ/სთ` : ''}`;
  }
  /** სტაციონარში გადატანა შესაძლებელია? (null — კი; ტექსტი — მიზეზი) */
  private untransferable(o: ActiveOrder): string | null {
    if (o.is_verbal && !o.verbal_confirmed_at) return 'ზეპირი — დაუდასტურებელი';
    if (o.kind === 'procedure') return null;
    if (o.kind === 'infusion' && o.rate_ml_h) return null;
    if (!o.dose || !o.dose_unit) return 'დოზა / ერთეული არ არის მითითებული';
    return null;
  }

  // ---------------------------------------------------------------- შემოწმებები
  private async facts(ex: Ex, v: VisitRow) {
    const r = await sql<{ initial: boolean; primary_dx: boolean; verbal: number; dx_open: number; consult_open: number; running: number; request_id: string | null }>`SELECT
        EXISTS (SELECT 1 FROM doctor_notes n WHERE n.encounter_id = ${v.encounter_id} AND n.kind = 'er_initial' AND n.status = 'signed' AND n.superseded_at IS NULL) AS initial,
        EXISTS (SELECT 1 FROM encounter_diagnoses d WHERE d.encounter_id = ${v.encounter_id} AND d.diagnosis_type = 'primary') AS primary_dx,
        (SELECT count(*)::int FROM er_orders o WHERE o.encounter_id = ${v.encounter_id} AND o.is_verbal AND o.verbal_confirmed_at IS NULL AND o.status <> 'stopped') AS verbal,
        (SELECT count(*)::int FROM dx_order_items i WHERE i.encounter_id = ${v.encounter_id} AND i.status NOT IN ('validated', 'cancelled')) AS dx_open,
        (SELECT count(*)::int FROM consultations c WHERE c.encounter_id = ${v.encounter_id} AND c.status = 'requested') AS consult_open,
        (SELECT count(*)::int FROM er_orders o WHERE o.encounter_id = ${v.encounter_id} AND o.status = 'active' AND EXISTS (SELECT 1 FROM er_administrations a WHERE a.order_id = o.id
           AND a.voided_at IS NULL AND a.infusion_action = 'start' AND NOT EXISTS (SELECT 1 FROM er_administrations b WHERE b.order_id = o.id AND b.voided_at IS NULL
           AND b.infusion_action = 'stop' AND b.administered_at >= a.administered_at))) AS running,
        (SELECT q.id FROM er_admit_requests q WHERE q.encounter_id = ${v.encounter_id} AND q.status = 'requested') AS request_id`.execute(ex);
    const [inpatient, ipdOrders] = [await modActive(ex, 'inpatient'), await modActive(ex, 'ipd_orders')];
    return { ...r.rows[0], inpatient, ipdOrders };
  }
  private checksFor(kind: Kind, f: Awaited<ReturnType<ErDispositionService['facts']>>, v: VisitRow, s: ErClinicalSettings, activeOrders: number, viaRequest = false): DispCheck[] {
    const out: DispCheck[] = [];
    const lvl = (x: 'block' | 'warn' | 'off'): DispCheck['level'] | null => (x === 'off' ? null : x);
    if (kind === 'lwbs') {
      if (v.doctor_at) out.push({ code: 'LWBS_AFTER_DOCTOR', level: 'block', message: 'ექიმმა პაციენტი უკვე აიყვანა — გამოიყენეთ „წავიდა ექიმის რეკომენდაციის საწინააღმდეგოდ“' });
    } else if (kind !== 'death' && !v.doctor_at) {
      out.push({ code: 'DOCTOR_REQUIRED', level: 'block', message: 'ექიმს პაციენტი არ აუყვანია — ექიმამდე წასვლა: „წავიდა ექიმის ნახვამდე“ (LWBS)' });
    }
    if (kind === 'admitted' && !f.inpatient) out.push({ code: 'INPATIENT_INACTIVE', level: 'block', message: 'მოდული „სტაციონარი“ არააქტიურია — ჰოსპიტალიზაცია შეუძლებელია' });
    if (kind !== 'lwbs') {
      const ni = kind === 'death' ? (s.require_initial_note === 'off' ? null : 'warn') : lvl(s.require_initial_note);
      if (ni && !f.initial) out.push({ code: 'INITIAL_NOTE', level: ni, message: 'პირველადი გასინჯვა (ER) ხელმოწერილი არ არის' });
      const nd = kind === 'death' ? (s.require_diagnosis === 'off' ? null : 'warn') : lvl(s.require_diagnosis);
      if (nd && !f.primary_dx) out.push({ code: 'DIAGNOSIS', level: nd, message: 'ძირითადი დიაგნოზი (ICD-10) არ არის მითითებული' });
    }
    if (f.verbal > 0) out.push({ code: 'VERBAL_UNCONFIRMED', level: kind === 'death' || kind === 'lwbs' ? 'warn' : s.verbal_unconfirmed, message: `დაუდასტურებელი ზეპირი დანიშნულება (${f.verbal})` });
    if (s.open_items_check === 'warn' && kind !== 'death') {
      if (f.dx_open > 0) out.push({ code: 'DX_OPEN', level: 'warn', message: `ღია კვლევა — შედეგის გარეშე (${f.dx_open})` });
      if (f.consult_open > 0) out.push({ code: 'CONSULT_OPEN', level: 'warn', message: `ღია კონსულტაცია (${f.consult_open})` });
      if (f.running > 0 && kind !== 'admitted') out.push({ code: 'INFUSION_RUNNING', level: 'warn', message: `მიმდინარე ინფუზია (${f.running}) — დასრულება არ არის აღრიცხული` });
    }
    if (activeOrders > 0) {
      if (kind === 'admitted' && f.ipdOrders && s.transfer_orders === 'reconcile') out.push({ code: 'ORDERS_RECONCILE', level: 'info', message: `აქტიური დანიშნულებები (${activeOrders}) — გაგრძელება / შეწყვეტა ჰოსპიტალიზაციისას` });
      else out.push({ code: 'ORDERS_STOP', level: 'info', message: `აქტიური დანიშნულებები (${activeOrders}) შეწყდება${kind === 'admitted' && !f.ipdOrders ? ' (მოდული „დანიშნულებები“ არააქტიურია)' : ''}` });
    }
    if (f.request_id && !viaRequest && kind !== 'admitted') out.push({ code: 'ADMIT_REQUEST_OPEN', level: 'info', message: 'ჰოსპიტალიზაციის ღია მოთხოვნა გაუქმდება' });
    return out;
  }
  private gate(checks: DispCheck[], override: string | undefined) {
    const blocks = checks.filter((c) => c.level === 'block');
    if (blocks.length) throw new ConflictException({ code: 'ER_DISPOSITION_BLOCKED', message: blocks.map((c) => c.message).join('; '), checks });
    const warns = checks.filter((c) => c.level === 'warn');
    if (warns.length && !override?.trim()) throw new ConflictException({ code: 'ER_DISPOSITION_WARNINGS', message: warns.map((c) => c.message).join('; '), checks, requires: { reason: true } });
    return warns.length ? { warnings: warns.map((w) => ({ code: w.code, message: w.message })), reason: override!.trim() } : null;
  }

  // ---------------------------------------------------------------- ინფორმაცია (ბარათის ჩანართი „გამოსავალი“)
  async info(id: string, u: AuthUser) {
    const v = await this.visit(id);
    const s = await erClinicalSettings();
    const erActive = modulesRef.svc ? await modulesRef.svc.isActive('er').catch(() => false) : true;
    const open = ACTIVE.includes(v.status);
    const orders = open && erActive ? await this.db.transaction().execute((trx) => this.activeOrders(trx, id)) : [];
    const f = await this.facts(this.db, v);
    const disp = await this.db.selectFrom('er_dispositions as x').leftJoin('users as d', 'd.id', 'x.decided_by').leftJoin('external_institutions as ei', 'ei.id', 'x.destination_id')
      .leftJoin('inpatient_stays as st', 'st.encounter_id', 'x.inpatient_encounter_id').leftJoin('encounters as ie', 'ie.id', 'x.inpatient_encounter_id')
      .leftJoin('departments as idp', 'idp.id', 'ie.department_id').leftJoin('generated_documents as g', 'g.id', 'x.summary_document_id')
      .selectAll('x').select(['ei.name as destination_name', 'st.adm_no', 'idp.name as admit_department', 'g.document_number as summary_number', 'g.status as summary_status',
        sql<string | null>`d.first_name || ' ' || d.last_name`.as('decided_by_name')])
      .where('x.encounter_id', '=', id).orderBy('x.decided_at', 'desc').execute();
    const current = disp.find((x) => !x.reopened_at) ?? null;
    const request = await this.db.selectFrom('er_admit_requests as q').innerJoin('departments as d', 'd.id', 'q.department_id').leftJoin('users as a', 'a.id', 'q.attending_doctor_id')
      .leftJoin('users as rb', 'rb.id', 'q.requested_by').leftJoin('users as db', 'db.id', 'q.decided_by')
      .selectAll('q').select(['d.name as department_name', sql<string | null>`a.first_name || ' ' || a.last_name`.as('attending_name'),
        sql<string>`rb.first_name || ' ' || rb.last_name`.as('requested_by_name'), sql<string | null>`db.first_name || ' ' || db.last_name`.as('decided_by_name')])
      .where('q.encounter_id', '=', id).orderBy('q.requested_at', 'desc').execute();
    const docOpen = (await sql<{ o: boolean }>`SELECT status = 'departed' AND doc_closes_at > now() AS o FROM er_visits WHERE encounter_id = ${id}`.execute(this.db)).rows[0]?.o ?? false;
    const doctor = erActive && (await erCanWrite(u, this.attending(v), s));
    const departedAt = (await this.db.selectFrom('er_visits').select(['ended_at', 'doc_closes_at']).where('encounter_id', '=', id).executeTakeFirstOrThrow());
    const reopenWindow = !!current && s.reopen_h > 0 && Date.now() - new Date(departedAt.ended_at!).getTime() <= s.reopen_h * 3_600_000;
    return {
      status: v.status, open, doc_open: docOpen, doc_closes_at: departedAt.doc_closes_at,
      settings: { admit_mode: s.admit_mode, transfer_orders: s.transfer_orders, ama_proof: s.ama_proof, recommendations_required: s.recommendations_required,
        doc_window_h: s.doc_window_h, reopen_h: s.reopen_h, summary_mode: s.summary_mode },
      modules: { inpatient: f.inpatient, ipd_orders: f.ipdOrders },
      checks: Object.fromEntries(KINDS.map((k) => [k, open ? this.checksFor(k, f, v, s, orders.length) : []])),
      orders: orders.map((o) => ({ id: o.id, label: this.orderLabel(o), kind: o.kind, order_type: o.order_type, running: o.running, untransferable: this.untransferable(o),
        default: this.untransferable(o) ? 'stop' : 'continue' })),
      disposition: current, history: disp.filter((x) => x.reopened_at), requests: request,
      can: {
        dispose: open && erActive && (has(u, 'admin') || doctor), lwbs: open && erActive && !v.doctor_at && has(u, 'admin', 'er_triage', 'er_doctor', 'er_manage'),
        request: open && erActive && (has(u, 'admin') || doctor) && s.admit_mode === 'request' && f.inpatient,
        regenerate: !!current && docOpen && (has(u, 'admin') || (erActive && (await erCanWrite(u, this.attending(v), s)))),
        reopen: !!current && erActive && current.kind !== 'admitted' && reopenWindow && (current.kind === 'death' ? has(u, 'admin') : has(u, ...ER_MANAGE)),
      },
    };
  }

  // ---------------------------------------------------------------- გამოსავალი
  async dispose(id: string, dto: DispositionDto, u: AuthUser, ctx: AuditContext) {
    await this.assertEr();
    const s = await erClinicalSettings();
    if (dto.kind === 'admitted' && s.admit_mode === 'request') throw new BadRequestException({ code: 'ER_ADMIT_REQUEST_MODE', message: 'კლინიკაში ჰოსპიტალიზაცია — მოთხოვნით (განყოფილება იღებს)' });
    if (dto.kind === 'admitted' && modulesRef.svc) await modulesRef.svc.assertActive('inpatient');
    const ipdS = dto.kind === 'admitted' ? await this.ipd.settings() : null;
    try {
      const out = await this.db.transaction().execute(async (trx) => {
        const v = await this.visit(id, trx, true);
        if (!ACTIVE.includes(v.status)) throw new ConflictException({ code: 'ER_VISIT_CLOSED', message: 'ER-ის შემთხვევა დახურულია' });
        if (!(await this.canDispose(u, v, dto.kind, s))) throw new ForbiddenException(dto.kind === 'lwbs' ? 'LWBS — ER-ის თანამშრომელი' : 'გამოსავალს აფორმებს ER-ის ექიმი');
        const orders = await this.activeOrders(trx, id);
        const f = await this.facts(trx, v);
        const overrides = this.gate(this.checksFor(dto.kind, f, v, s, orders.length), dto.override_reason);
        const fields = await this.kindFields(trx, v, dto, s, u);
        let admitted: Awaited<ReturnType<InpatientService['admitTx']>> | null = null;
        let result: { continued: { er_order_id: string; med_order_id: string }[]; stopped: string[] } = { continued: [], stopped: [] };
        if (dto.kind === 'admitted') {
          if (!dto.admit) throw new BadRequestException('ჰოსპიტალიზაცია: განყოფილება, მკურნალი ექიმი და დიაგნოზი');
          if (!dto.admit.attending_doctor_id) throw new BadRequestException('მიუთითეთ მკურნალი ექიმი (განყოფილების)');
          admitted = await this.ipd.admitTx(trx, this.admitDto(v, dto.admit, dto.admit.attending_doctor_id), u, ctx, ipdS!);
          result = await this.transferOrders(trx, v, orders, admitted, dto.orders_plan ?? {}, s, ipdS!, u, f.ipdOrders);
        } else {
          result.stopped = await this.stopOrders(trx, orders, `გამოსავალი: ${ER_DISPOSITION_KA[dto.kind]}`, u);
        }
        await this.finish(trx, v, dto.kind, u, ctx, s, { ...fields, overrides, orders_plan: dto.orders_plan ?? {}, orders_result: result,
          inpatient_encounter_id: admitted?.encounter_id ?? null, recommendations: dto.recommendations?.trim() || null, note: dto.note?.trim() || null });
        return { v, admitted, result };
      });
      if (out.admitted) await this.afterAdmit(out.v, out.admitted, u);
      return { encounter_id: id, disposition: dto.kind, inpatient_encounter_id: out.admitted?.encounter_id ?? null, adm_no: out.admitted?.adm_no ?? null, orders: out.result };
    } catch (e) { mapPgError(e, { ux_inpatient_stays_patient_active: 'პაციენტი უკვე ჰოსპიტალიზებულია', ux_er_disposition_active: 'გამოსავალი უკვე გაფორმებულია' }); }
  }

  /** სახის ველები + ვალიდაცია */
  private async kindFields(trx: Trx, v: VisitRow, dto: DispositionDto, s: ErClinicalSettings, u: AuthUser) {
    const now = Date.now();
    const departed = dto.departed_at ? new Date(dto.departed_at) : new Date();
    if (departed.getTime() > now + 5 * 60_000) throw new BadRequestException('გასვლის დრო მომავალშია');
    if (departed < new Date(v.arrived_at)) throw new BadRequestException('გასვლის დრო შემოსვლამდეა');
    const out: Record<string, unknown> = { departed_at: departed };
    if (['home', 'transfer', 'ama'].includes(dto.kind) && s.recommendations_required && (dto.recommendations?.trim().length ?? 0) < 3) {
      throw new BadRequestException({ code: 'RECOMMENDATIONS_REQUIRED', message: 'მიუთითეთ რეკომენდაციები' });
    }
    if (dto.kind === 'transfer') {
      if (dto.destination_id) {
        const inst = await trx.selectFrom('external_institutions').select(['id', 'is_active']).where('id', '=', dto.destination_id).executeTakeFirst();
        if (!inst?.is_active) throw new BadRequestException('დაწესებულება ვერ მოიძებნა ცნობარში');
      } else if ((dto.destination_text?.trim().length ?? 0) < 3) throw new BadRequestException('მიუთითეთ დაწესებულება (ცნობარიდან ან ტექსტით)');
      if ((dto.transfer_reason?.trim().length ?? 0) < 3) throw new BadRequestException('მიუთითეთ გადაყვანის მიზეზი');
      Object.assign(out, { destination_id: dto.destination_id ?? null, destination_text: dto.destination_text?.trim() || null, transport: dto.transport ?? null,
        transfer_reason: dto.transfer_reason!.trim(), receiver: dto.receiver?.trim() || null });
    }
    if (dto.kind === 'ama') {
      if (s.ama_proof === 'consent_or_witnesses') {
        if (dto.refusal_consent_id) {
          const c = await trx.selectFrom('patient_consents').select(['id', 'type_code', 'encounter_id', 'decision', 'revoked_at']).where('id', '=', dto.refusal_consent_id).executeTakeFirst();
          if (!c || c.type_code !== 'ER_SELF_DISCHARGE' || c.encounter_id !== v.encounter_id || c.decision !== 'granted' || c.revoked_at) {
            throw new BadRequestException('ხელწერილი (ER_SELF_DISCHARGE) ამ ER-ის შემთხვევაზე ვერ მოიძებნა');
          }
          out.refusal_consent_id = c.id;
        } else if (dto.refusal_witnesses?.length) {
          const ids = [...new Set(dto.refusal_witnesses)];
          const n = (await trx.selectFrom('users').select(sql<number>`count(*)::int`.as('n')).where('id', 'in', ids).where('is_active', '=', true).executeTakeFirstOrThrow()).n;
          if (ids.length < 2 || n !== ids.length) throw new BadRequestException('ხელმოწერაზე უარი: საჭიროა 2 აქტიური თანამშრომელი-მოწმე');
          out.refusal_witnesses = ids;
        } else throw new BadRequestException({ code: 'REFUSAL_REQUIRED', message: 'AMA: ხელწერილი (ER_SELF_DISCHARGE) ან — ხელმოწერაზე უარისას — 2 მოწმე' });
      } else if ((dto.ama_reason?.trim().length ?? 0) < 3) throw new BadRequestException({ code: 'AMA_REASON_REQUIRED', message: 'მიუთითეთ მიზეზი' });
      out.ama_reason = dto.ama_reason?.trim() || null;
    }
    if (dto.kind === 'death') {
      if (!dto.death_at || !dto.death_icd10_code || dto.autopsy_required === undefined) throw new BadRequestException('გარდაცვალება: დრო, მიზეზი (ICD-10) და აუტოფსიის საჭიროება სავალდებულოა');
      const at = new Date(dto.death_at);
      if (at.getTime() > now + 60_000) throw new BadRequestException('გარდაცვალების დრო მომავალშია');
      if (!dto.dead_on_arrival && at < new Date(v.arrived_at)) throw new BadRequestException('გარდაცვალების დრო შემოსვლამდეა (ან მონიშნეთ „შემოყვანილია გარდაცვლილი“)');
      const icd = await trx.selectFrom('icd10_codes').select(['code', 'title', 'is_active']).where('code', '=', dto.death_icd10_code.trim().toUpperCase()).executeTakeFirst();
      if (!icd?.is_active) throw new BadRequestException(`ICD-10 კოდი ${dto.death_icd10_code} კლასიფიკატორში არ არსებობს`);
      Object.assign(out, { death_at: at, death_icd10_code: icd.code, death_icd10_title: icd.title, autopsy_required: dto.autopsy_required, dead_on_arrival: !!dto.dead_on_arrival });
      if (!dto.departed_at) out.departed_at = at > new Date(v.arrived_at) ? at : new Date(v.arrived_at);
    }
    void u;
    return out;
  }

  private admitDto(v: VisitRow, a: AdmitPartDto, attending: string, bed?: string, confirm?: boolean): AdmitDto {
    return { patient_id: v.patient_id, department_id: a.department_id, attending_doctor_id: attending, source: 'emergency', source_encounter_id: v.encounter_id,
      icd10_code: a.icd10_code.trim().toUpperCase(), chief_complaint: v.chief_complaint, severity: a.severity, isolation: a.isolation, bed_id: bed, confirm: confirm ?? a.confirm } as AdmitDto;
  }

  private async stopOrders(trx: Trx, orders: ActiveOrder[], reason: string, u: AuthUser) {
    if (!orders.length) return [];
    await trx.updateTable('er_orders').set({ status: 'stopped', stopped_at: sql`now()`, stopped_by: u.id, stop_reason: reason }).where('id', 'in', orders.map((o) => o.id)).execute();
    return orders.map((o) => o.id);
  }

  /** ჰოსპიტალიზაცია: აქტიური ER-ის დანიშნულებები → med_orders (reconcile; ipd_orders აქტიური) ან წყდება */
  private async transferOrders(trx: Trx, v: VisitRow, orders: ActiveOrder[], adm: { encounter_id: string; adm_no: string }, plan: Plan, s: ErClinicalSettings,
                               ipdS: InpatientSettings, u: AuthUser, ipdOrders: boolean) {
    for (const [k, x] of Object.entries(plan)) if (!['continue', 'stop'].includes(x as string) || !/^[0-9a-f-]{36}$/i.test(k)) throw new BadRequestException('orders_plan: {id: continue | stop}');
    const result = { continued: [] as { er_order_id: string; med_order_id: string }[], stopped: [] as string[] };
    const transfer = ipdOrders && s.transfer_orders === 'reconcile';
    for (const o of orders) {
      const want = transfer ? (plan[o.id] ?? (this.untransferable(o) ? 'stop' : 'continue')) : 'stop';
      const why = this.untransferable(o);
      if (want === 'continue' && why) throw new BadRequestException({ code: 'ER_ORDER_UNTRANSFERABLE', message: `${this.orderLabel(o)}: ${why} — გადატანა შეუძლებელია` });
      if (want === 'stop') {
        await trx.updateTable('er_orders').set({ status: 'stopped', stopped_at: sql`now()`, stopped_by: u.id, stop_reason: `ჰოსპიტალიზაცია (${adm.adm_no}) — შეწყდა` }).where('id', '=', o.id).execute();
        result.stopped.push(o.id); continue;
      }
      const instr = ['ER-იდან გაგრძელება', o.instructions].filter(Boolean).join('; ');
      let values: Record<string, unknown>;
      if (o.kind === 'procedure') {
        values = { category: 'nursing', text: o.text, verify_status: 'not_required' };
      } else {
        const continuous = o.kind === 'infusion' && !!o.rate_ml_h;
        const supply = o.patient_only ? 'pharmacy' : 'ward';
        const risky = !o.generic_id || !!o.high_alert || !!o.controlled_class;
        const verify = ipdS.med_verification === 'all' || (ipdS.med_verification === 'high_risk' && (risky || supply === 'pharmacy'));
        values = {
          category: 'medication', generic_id: o.generic_id, drug_text: o.generic_id ? null : o.drug_text, order_type: continuous ? 'continuous' : o.order_type === 'prn' ? 'prn' : 'once',
          dose: o.dose, dose_unit: o.dose ? o.dose_unit : null, weight_kg: o.weight_kg, route_code: o.route_code, volume_ml: o.volume_ml, rate_ml_h: o.rate_ml_h, diluent: o.diluent,
          prn_reason: o.order_type === 'prn' ? o.prn_reason : null, prn_min_interval_h: o.order_type === 'prn' ? o.prn_min_interval_h : null,
          prn_max_per_day: o.order_type === 'prn' ? o.prn_max_doses : null, supply_mode: supply, verify_status: verify ? 'pending' : 'not_required',
          checks: JSON.stringify(o.checks ?? []), override_reason: o.override_reason,
        };
      }
      const mo = await trx.insertInto('med_orders').values({ ...values, encounter_id: adm.encounter_id, patient_id: v.patient_id, instructions: instr, start_at: sql`now()`,
        ordered_by: u.id, entered_by: u.id, is_verbal: false, er_order_id: o.id } as never).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('med_order_events').values({ order_id: mo.id, kind: 'created', data: JSON.stringify({ from_er: o.id, er_visit: v.visit_no }), user_id: u.id }).execute();
      await trx.updateTable('er_orders').set({ status: 'stopped', stopped_at: sql`now()`, stopped_by: u.id, stop_reason: `გადატანილია სტაციონარში (${adm.adm_no})` }).where('id', '=', o.id).execute();
      result.continued.push({ er_order_id: o.id, med_order_id: mo.id });
    }
    return result;
  }

  /** ER-ის შემთხვევის დახურვა + გამოსავლის ჩანაწერი + ER-ის ფურცელი */
  private async finish(trx: Trx, v: VisitRow, kind: Kind, u: AuthUser, ctx: AuditContext, s: ErClinicalSettings, f: Record<string, unknown>, opts: { decidedBy?: string; requestId?: string } = {}) {
    const departed = f.departed_at as Date;
    const { overrides, orders_plan, orders_result, ...rest } = f;
    await trx.insertInto('er_dispositions').values({ ...(rest as object), encounter_id: v.encounter_id, kind, decided_by: opts.decidedBy ?? u.id, prev_status: v.status,
      overrides: overrides ? JSON.stringify(overrides) : null, orders_plan: JSON.stringify(orders_plan ?? {}), orders_result: JSON.stringify(orders_result ?? {}),
      admit_request_id: opts.requestId ?? null } as never).execute();
    await trx.updateTable('er_visits').set({ status: 'departed', disposition: kind, ended_at: departed, end_reason: ER_DISPOSITION_KA[kind], spot_id: null,
      waiting_for: sql`array_remove(waiting_for, 'bed')`, doc_closes_at: sql`greatest(now(), ${departed}::timestamptz) + make_interval(hours => ${s.doc_window_h})` })
      .where('encounter_id', '=', v.encounter_id).execute();
    await trx.updateTable('encounters').set({ status: 'discharged', end_time: departed }).where('id', '=', v.encounter_id).execute();
    await trx.updateTable('er_admit_requests').set({ status: 'cancelled', decided_by: u.id, decided_at: sql`now()`, decision_reason: `გამოსავალი: ${ER_DISPOSITION_KA[kind]}` })
      .where('encounter_id', '=', v.encounter_id).where('status', '=', 'requested').$if(!!opts.requestId, (q) => q.where('id', '<>', opts.requestId!)).execute();
    if (kind === 'death') await trx.updateTable('patients').set({ is_deceased: true, death_datetime: f.death_at as Date }).where('id', '=', v.patient_id).execute();
    const doc = await this.summary.issue(trx, v.encounter_id, u, (t, ty, p) => this.ipd.nextNo(t, ty, p));
    await this.audit.log(ctx, { action: 'ER_DISPOSITION', entityName: 'er_visits', entityId: v.encounter_id,
      newData: { kind, departed_at: departed, overrides, orders: orders_result, inpatient_encounter_id: f.inpatient_encounter_id ?? null, summary: doc.number } }, trx);
    return doc;
  }

  private async afterAdmit(v: VisitRow, adm: Awaited<ReturnType<InpatientService['admitTx']>>, u: AuthUser) {
    await this.ipd.afterAdmit(adm);
    const e = await this.db.selectFrom('encounters').select('attending_doctor_id').where('id', '=', adm.encounter_id).executeTakeFirst();
    await this.notify([e?.attending_doctor_id], { kind: 'er_admitted', title: `ER → ${adm.department.name}: ახალი პაციენტი`, body: `${v.last_name} ${v.first_name} (${adm.adm_no}, ER ${v.visit_no})`,
      entityId: adm.encounter_id, link: `/inpatient/stay/${adm.encounter_id}`, urgent: true }, u.id);
  }

  // ---------------------------------------------------------------- ჰოსპიტალიზაციის მოთხოვნა (admit_mode = request)
  async request(id: string, dto: AdmitRequestDto, u: AuthUser, ctx: AuditContext) {
    await this.assertEr();
    const s = await erClinicalSettings();
    if (s.admit_mode !== 'request') throw new BadRequestException({ code: 'ER_ADMIT_DIRECT_MODE', message: 'კლინიკაში ჰოსპიტალიზაციას ER-ის ექიმი აფორმებს პირდაპირ' });
    if (modulesRef.svc) await modulesRef.svc.assertActive('inpatient');
    const out = await this.db.transaction().execute(async (trx) => {
      const v = await this.visit(id, trx, true);
      if (!ACTIVE.includes(v.status)) throw new ConflictException({ code: 'ER_VISIT_CLOSED', message: 'ER-ის შემთხვევა დახურულია' });
      if (!(await this.canDispose(u, v, 'admitted', s))) throw new ForbiddenException('ჰოსპიტალიზაციას ითხოვს ER-ის ექიმი');
      const orders = await this.activeOrders(trx, id);
      const f = await this.facts(trx, v);
      if (f.request_id) throw new ConflictException({ code: 'ER_ADMIT_REQUEST_EXISTS', message: 'ჰოსპიტალიზაციის მოთხოვნა უკვე გაგზავნილია' });
      const overrides = this.gate(this.checksFor('admitted', f, v, s, orders.length, true), dto.override_reason);
      const dep = await this.ipd.department(dto.department_id, trx);
      if (dto.attending_doctor_id) await this.ipd.doctor(dto.attending_doctor_id, trx);
      const icd = await trx.selectFrom('icd10_codes').select(['code', 'title', 'is_active']).where('code', '=', dto.icd10_code.trim().toUpperCase()).executeTakeFirst();
      if (!icd?.is_active) throw new BadRequestException(`ICD-10 კოდი ${dto.icd10_code} კლასიფიკატორში არ არსებობს`);
      for (const [k, x] of Object.entries(dto.orders_plan ?? {})) if (!['continue', 'stop'].includes(x) || !orders.some((o) => o.id === k)) throw new BadRequestException('orders_plan: აქტიური დანიშნულება — continue | stop');
      const r = await trx.insertInto('er_admit_requests').values({ encounter_id: id, patient_id: v.patient_id, department_id: dep.id, attending_doctor_id: dto.attending_doctor_id ?? null,
        icd10_code: icd.code, icd10_title: icd.title, severity: dto.severity ?? null, isolation: dto.isolation ?? null, note: dto.note?.trim() || null,
        orders_plan: JSON.stringify(dto.orders_plan ?? {}), overrides: overrides ? JSON.stringify(overrides) : null, requested_by: u.id }).returning('id').executeTakeFirstOrThrow();
      if (!v.waiting_for.includes('bed')) await trx.updateTable('er_visits').set({ waiting_for: sql`array_append(waiting_for, 'bed')` }).where('encounter_id', '=', id).execute();
      await this.audit.log(ctx, { action: 'ER_ADMIT_REQUEST', entityName: 'er_admit_requests', entityId: r.id, newData: { ...dto, overrides } }, trx);
      return { id: r.id, v, dep };
    }).catch((e) => mapPgError(e, { ux_er_admit_open: 'ჰოსპიტალიზაციის მოთხოვნა უკვე გაგზავნილია' }));
    await this.ipd.notifyDepartment(out.dep.id, ['doctor', 'manager'], { kind: 'er_admit_request', title: `ER: ჰოსპიტალიზაციის მოთხოვნა — ${out.dep.name}`,
      body: `${out.v.last_name} ${out.v.first_name} (ER ${out.v.visit_no})`, item: out.v.visit_no, entityId: out.id, link: `/inpatient?tab=er&department_id=${out.dep.id}`, urgent: true }).catch(() => undefined);
    if (dto.attending_doctor_id) await this.notify([dto.attending_doctor_id], { kind: 'er_admit_request', title: `ER: ჰოსპიტალიზაციის მოთხოვნა`, body: `${out.v.last_name} ${out.v.first_name} (ER ${out.v.visit_no})`,
      entityId: out.id, link: `/inpatient?tab=er&department_id=${out.dep.id}`, urgent: true }, u.id);
    return { id: out.id, status: 'requested' };
  }

  private async lockRequest(trx: Trx, rid: string) {
    const r = await trx.selectFrom('er_admit_requests').selectAll().where('id', '=', rid).forUpdate().executeTakeFirst();
    if (!r) throw new NotFoundException('მოთხოვნა ვერ მოიძებნა');
    if (r.status !== 'requested') throw new ConflictException({ code: 'ER_ADMIT_REQUEST_CLOSED', message: 'მოთხოვნა უკვე დამუშავებულია' });
    return r;
  }
  private async canDecide(u: AuthUser, departmentId: string, ex: Ex) {
    if (has(u, 'admin')) return true;
    return has(u, 'doctor') && (await this.ipd.isStaff(u, departmentId, ex));
  }

  async cancelRequest(rid: string, reason: string, u: AuthUser, ctx: AuditContext) {
    await this.assertEr();
    const s = await erClinicalSettings();
    return this.db.transaction().execute(async (trx) => {
      const r = await this.lockRequest(trx, rid);
      const v = await this.visit(r.encounter_id, trx, true);
      if (!has(u, 'admin') && !(await erCanWrite(u, this.attending(v), s))) throw new ForbiddenException('მოთხოვნას აუქმებს ER-ის ექიმი');
      await trx.updateTable('er_admit_requests').set({ status: 'cancelled', decided_by: u.id, decided_at: sql`now()`, decision_reason: reason }).where('id', '=', rid).execute();
      await trx.updateTable('er_visits').set({ waiting_for: sql`array_remove(waiting_for, 'bed')` }).where('encounter_id', '=', r.encounter_id).execute();
      await this.audit.log(ctx, { action: 'ER_ADMIT_REQUEST_CANCEL', entityName: 'er_admit_requests', entityId: rid, newData: { reason } }, trx);
      return { id: rid, status: 'cancelled' };
    });
  }

  async reject(rid: string, reason: string, u: AuthUser, ctx: AuditContext) {
    await this.assertEr();
    const out = await this.db.transaction().execute(async (trx) => {
      const r = await this.lockRequest(trx, rid);
      if (!(await this.canDecide(u, r.department_id, trx))) throw new ForbiddenException('მოთხოვნას განიხილავს განყოფილების ექიმი');
      await trx.updateTable('er_admit_requests').set({ status: 'rejected', decided_by: u.id, decided_at: sql`now()`, decision_reason: reason }).where('id', '=', rid).execute();
      await trx.updateTable('er_visits').set({ waiting_for: sql`array_remove(waiting_for, 'bed')` }).where('encounter_id', '=', r.encounter_id).execute();
      await this.audit.log(ctx, { action: 'ER_ADMIT_REQUEST_REJECT', entityName: 'er_admit_requests', entityId: rid, newData: { reason } }, trx);
      return r;
    });
    await this.notify([out.requested_by], { kind: 'er_admit_rejected', title: 'ჰოსპიტალიზაციის მოთხოვნა უარყოფილია', body: reason, entityId: out.encounter_id,
      link: `/er?visit=${out.encounter_id}&tab=disposition`, urgent: true }, u.id);
    return { id: rid, status: 'rejected' };
  }

  async accept(rid: string, dto: AcceptDto, u: AuthUser, ctx: AuditContext) {
    await this.assertEr();
    if (modulesRef.svc) await modulesRef.svc.assertActive('inpatient');
    const s = await erClinicalSettings();
    const ipdS = await this.ipd.settings();
    try {
      const out = await this.db.transaction().execute(async (trx) => {
        const r = await this.lockRequest(trx, rid);
        if (!(await this.canDecide(u, r.department_id, trx))) throw new ForbiddenException('მოთხოვნას იღებს განყოფილების ექიმი');
        const v = await this.visit(r.encounter_id, trx, true);
        if (!ACTIVE.includes(v.status)) throw new ConflictException({ code: 'ER_VISIT_CLOSED', message: 'ER-ის შემთხვევა დახურულია' });
        const orders = await this.activeOrders(trx, v.encounter_id);
        const f = await this.facts(trx, v);
        if (f.verbal > 0 && s.verbal_unconfirmed === 'block') throw new ConflictException({ code: 'ER_DISPOSITION_BLOCKED', message: `დაუდასტურებელი ზეპირი დანიშნულება (${f.verbal}) — ER-ის ექიმმა უნდა დაადასტუროს`,
          checks: [{ code: 'VERBAL_UNCONFIRMED', level: 'block', message: 'დაუდასტურებელი ზეპირი დანიშნულება' }] });
        const part: AdmitPartDto = { department_id: r.department_id, icd10_code: r.icd10_code, severity: r.severity ?? undefined, isolation: r.isolation ?? undefined };
        const admitted = await this.ipd.admitTx(trx, this.admitDto(v, part, dto.attending_doctor_id, dto.bed_id, dto.confirm), u, ctx, ipdS);
        const plan = { ...(r.orders_plan as Plan), ...(dto.orders_plan ?? {}) };
        const result = await this.transferOrders(trx, v, orders, admitted, plan, s, ipdS, u, f.ipdOrders);
        await trx.updateTable('er_admit_requests').set({ status: 'accepted', decided_by: u.id, decided_at: sql`now()`, inpatient_encounter_id: admitted.encounter_id }).where('id', '=', rid).execute();
        await this.finish(trx, v, 'admitted', u, ctx, s, { departed_at: new Date(), overrides: r.overrides, orders_plan: plan, orders_result: result, inpatient_encounter_id: admitted.encounter_id,
          note: r.note }, { decidedBy: r.requested_by, requestId: rid });
        return { v, admitted, r, result };
      });
      await this.afterAdmit(out.v, out.admitted, u);
      await this.notify([out.r.requested_by], { kind: 'er_admit_accepted', title: `ჰოსპიტალიზაცია მიღებულია — ${out.admitted.department.name}`, body: `${out.v.last_name} ${out.v.first_name} (${out.admitted.adm_no})`,
        entityId: out.v.encounter_id, link: `/er?visit=${out.v.encounter_id}&tab=disposition` }, u.id);
      return { id: rid, status: 'accepted', inpatient_encounter_id: out.admitted.encounter_id, adm_no: out.admitted.adm_no, bed: out.admitted.bed, orders: out.result };
    } catch (e) { mapPgError(e, { ux_inpatient_stays_patient_active: 'პაციენტი უკვე ჰოსპიტალიზებულია', ux_bed_assignments_bed: 'საწოლი უკვე დაკავებულია' }); }
  }

  /** განყოფილების სია (სტაციონარი → „ER — მოთხოვნები“) */
  async requests(q: { department_id?: string; status?: string }) {
    const st = q.status && ['requested', 'accepted', 'rejected', 'cancelled'].includes(q.status) ? q.status : 'requested';
    const rows = await this.db.selectFrom('er_admit_requests as r').innerJoin('er_visits as v', 'v.encounter_id', 'r.encounter_id').innerJoin('patients as p', 'p.id', 'r.patient_id')
      .innerJoin('departments as d', 'd.id', 'r.department_id').innerJoin('users as rb', 'rb.id', 'r.requested_by').leftJoin('users as a', 'a.id', 'r.attending_doctor_id')
      .leftJoin('er_triage_levels as l', (j) => j.onRef('l.scale_code', '=', 'v.triage_scale').onRef('l.level', '=', 'v.triage_level'))
      .select(['r.id', 'r.encounter_id', 'r.department_id', 'd.name as department_name', 'r.icd10_code', 'r.icd10_title', 'r.severity', 'r.isolation', 'r.note', 'r.status', 'r.requested_at',
        'r.decided_at', 'r.decision_reason', 'r.attending_doctor_id', 'r.orders_plan', 'v.visit_no', 'v.chief_complaint', 'v.arrived_at', 'l.name as level_name', 'l.color',
        'p.id as patient_id', 'p.first_name', 'p.last_name', 'p.gender', 'p.birth_date', 'p.is_unknown', 'p.unknown_no',
        sql<string>`rb.first_name || ' ' || rb.last_name`.as('requested_by_name'), sql<string | null>`a.first_name || ' ' || a.last_name`.as('attending_name'),
        sql<number>`(SELECT count(*)::int FROM er_orders o WHERE o.encounter_id = r.encounter_id AND o.status = 'active')`.as('active_orders')])
      .where('r.status', '=', st).$if(!!q.department_id, (x) => x.where('r.department_id', '=', q.department_id!))
      .orderBy('r.requested_at', st === 'requested' ? 'asc' : 'desc').limit(200).execute();
    return rows;
  }

  /** ER-ის აქტიური დანიშნულებები მოთხოვნის მიმღებისთვის (reconcile) */
  async requestOrders(rid: string) {
    const r = await this.db.selectFrom('er_admit_requests').select(['encounter_id', 'orders_plan', 'status']).where('id', '=', rid).executeTakeFirst();
    if (!r) throw new NotFoundException('მოთხოვნა ვერ მოიძებნა');
    const orders = r.status === 'requested' ? await this.db.transaction().execute((trx) => this.activeOrders(trx, r.encounter_id)) : [];
    const plan = r.orders_plan as Plan;
    const s = await erClinicalSettings();
    return { transfer_orders: s.transfer_orders, ipd_orders: await modActive(this.db, 'ipd_orders'),
      orders: orders.map((o) => ({ id: o.id, label: this.orderLabel(o), order_type: o.order_type, kind: o.kind, running: o.running, untransferable: this.untransferable(o),
        default: plan[o.id] ?? (this.untransferable(o) ? 'stop' : 'continue') })) };
  }

  /** ჰოსპიტალიზაციის ფორმა: სტაციონარის განყოფილებები + ექიმები */
  async admitOptions() {
    const deps = await this.db.selectFrom('departments').select(['id', 'name']).where('type', '=', 'inpatient').where('is_active', '=', true).orderBy('name').execute();
    const docs = await this.db.selectFrom('users as u').innerJoin('user_capabilities as c', 'c.user_id', 'u.id')
      .select(['u.id', 'u.department_id', sql<string>`u.first_name || ' ' || u.last_name`.as('name'), 'u.specialty']).distinct()
      .where('u.is_active', '=', true).where(sql<boolean>`'doctor' = ANY(c.capabilities)`).orderBy('name').execute();
    const institutions = await this.db.selectFrom('external_institutions').select(['id', 'name']).where('is_active', '=', true).orderBy('sort_order').orderBy('name').execute();
    return { departments: deps.map((d) => ({ ...d, doctors: docs.filter((x) => x.department_id === d.id).map(({ id, name, specialty }) => ({ id, name, specialty })) })), institutions };
  }

  // ---------------------------------------------------------------- გაუქმება / ფურცელი / სია
  async reopen(id: string, reason: string, u: AuthUser, ctx: AuditContext) {
    await this.assertEr();
    const s = await erClinicalSettings();
    try {
      return await this.db.transaction().execute(async (trx) => {
        const x = await trx.selectFrom('er_dispositions').selectAll().where('encounter_id', '=', id).where('reopened_at', 'is', null).forUpdate().executeTakeFirst();
        if (!x) throw new ConflictException('გამოსავალი გაფორმებული არ არის');
        if (x.kind === 'admitted') throw new ConflictException({ code: 'ER_REOPEN_ADMITTED', message: 'ჰოსპიტალიზაცია ER-იდან არ უქმდება — გააუქმეთ ჰოსპიტალიზაცია სტაციონარში (ER-ის შემთხვევა ავტომატურად გაიხსნება)' });
        if (x.kind === 'death' ? !has(u, 'admin') : !has(u, ...ER_MANAGE)) throw new ForbiddenException(x.kind === 'death' ? 'გარდაცვალების გაუქმება — მხოლოდ admin' : 'გაუქმება — ER-ის მენეჯერი / admin');
        const v = await trx.selectFrom('er_visits').select(['ended_at']).where('encounter_id', '=', id).executeTakeFirstOrThrow();
        if (s.reopen_h === 0 || Date.now() - new Date(v.ended_at!).getTime() > s.reopen_h * 3_600_000) {
          throw new ConflictException({ code: 'ER_REOPEN_EXPIRED', message: s.reopen_h === 0 ? 'გამოსავლის გაუქმება კლინიკაში გამორთულია' : `გაუქმების ვადა (${s.reopen_h} სთ) გასულია` });
        }
        await reopenErVisitTx(trx, id, u.id, reason);
        await this.audit.log(ctx, { action: 'ER_DISPOSITION_REOPEN', entityName: 'er_visits', entityId: id, oldData: { kind: x.kind }, newData: { reason } }, trx);
        return { encounter_id: id, status: x.prev_status };
      });
    } catch (e) { mapPgError(e, { uq_er_visit_active_patient: 'პაციენტს უკვე აქვს სხვა მიმდინარე ER-ის შემთხვევა', uq_er_visit_active_spot: 'ადგილი დაკავებულია' }); }
  }

  async regenerate(id: string, u: AuthUser, ctx: AuditContext) {
    const s = await erClinicalSettings();
    await this.assertEr();
    return this.db.transaction().execute(async (trx) => {
      const v = await this.visit(id, trx, true);
      const open = (await sql<{ o: boolean }>`SELECT status = 'departed' AND doc_closes_at > now() AS o FROM er_visits WHERE encounter_id = ${id}`.execute(trx)).rows[0]?.o;
      if (!open) throw new ConflictException({ code: 'ER_DOC_CLOSED', message: 'დოკუმენტაციის ფანჯარა დახურულია' });
      if (!has(u, 'admin') && !(await erCanWrite(u, this.attending(v), s))) throw new ForbiddenException('ER-ის ფურცელს ანახლებს ER-ის ექიმი');
      const d = await this.summary.issue(trx, id, u, (t, ty, p) => this.ipd.nextNo(t, ty, p));
      await this.audit.log(ctx, { action: 'ER_SUMMARY_REISSUE', entityName: 'er_visits', entityId: id, newData: { number: d.number } }, trx);
      return d;
    });
  }

  async departed(q: { hours?: number; department_id?: string; disposition?: string }) {
    const h = Math.max(1, Math.min(168, q.hours ?? 24));
    return this.db.selectFrom('er_visits as v').innerJoin('patients as p', 'p.id', 'v.patient_id').innerJoin('departments as d', 'd.id', 'v.department_id')
      .leftJoin('users as doc', 'doc.id', 'v.doctor_id')
      .leftJoin('er_dispositions as x', (j) => j.onRef('x.encounter_id', '=', 'v.encounter_id').on('x.reopened_at', 'is', null))
      .leftJoin('inpatient_stays as st', 'st.encounter_id', 'x.inpatient_encounter_id').leftJoin('generated_documents as g', 'g.id', 'x.summary_document_id')
      .leftJoin('er_triage_levels as l', (j) => j.onRef('l.scale_code', '=', 'v.triage_scale').onRef('l.level', '=', 'v.triage_level'))
      .select(['v.encounter_id', 'v.visit_no', 'v.arrived_at', 'v.ended_at', 'v.disposition', 'v.doc_closes_at', 'v.chief_complaint', 'd.name as department_name', 'l.name as level_name', 'l.color',
        'p.id as patient_id', 'p.first_name', 'p.last_name', 'p.is_unknown', 'p.unknown_no', sql<string | null>`doc.first_name || ' ' || doc.last_name`.as('doctor_name'),
        'st.adm_no', 'g.document_number as summary_number'])
      .where('v.status', '=', 'departed').where('v.ended_at', '>', sql<Date>`now() - make_interval(hours => ${h})`)
      .$if(!!q.department_id, (x) => x.where('v.department_id', '=', q.department_id!))
      .$if(!!q.disposition && (KINDS as readonly string[]).includes(q.disposition), (x) => x.where('v.disposition', '=', q.disposition!))
      .orderBy('v.ended_at', 'desc').limit(300).execute();
  }

  preview(id: string, u: AuthUser) { return this.summary.preview(id, u); }
  file(id: string) { return this.summary.file(id); }
}

// ======================================================================= controller
const DISP_READ: Role[] = [...ER_READ, 'doctor', 'nurse'];
const REQ_ROLES: Role[] = ['admin', 'doctor', 'nurse', 'manager', 'er_doctor', 'er_triage', 'er_manage'];

@Controller('er')
@RequireModule('er')
export class ErDispositionController {
  constructor(private readonly s: ErDispositionService) {}
  @Get('visits/:id/disposition') @ClinicalHistory() @Roles(...DISP_READ) info(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser) { return this.s.info(id, u); }
  @Post('visits/:id/disposition') @HttpCode(200) @Roles('admin', 'er_doctor', 'er_triage', 'er_manage')
  dispose(@Param('id', ParseUUIDPipe) id: string, @Body() d: DispositionDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.dispose(id, d, u, auditCtx(r)); }
  @Post('visits/:id/reopen') @HttpCode(200) @Roles(...ER_MANAGE)
  reopen(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.reopen(id, d.reason.trim(), u, auditCtx(r)); }
  @Post('visits/:id/admit-request') @Roles('admin', 'er_doctor')
  request(@Param('id', ParseUUIDPipe) id: string, @Body() d: AdmitRequestDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.request(id, d, u, auditCtx(r)); }
  @Get('admit/options') @Roles(...REQ_ROLES) options() { return this.s.admitOptions(); }
  @Get('admit-requests') @Roles(...REQ_ROLES) requests(@Query('department_id') dep?: string, @Query('status') st?: string) {
    if (dep && !/^[0-9a-f-]{36}$/i.test(dep)) throw new BadRequestException('არასწორი department_id');
    return this.s.requests({ department_id: dep || undefined, status: st });
  }
  @Get('admit-requests/:rid/orders') @Roles(...REQ_ROLES) reqOrders(@Param('rid', ParseUUIDPipe) rid: string) { return this.s.requestOrders(rid); }
  @Post('admit-requests/:rid/accept') @HttpCode(200) @Roles('admin', 'doctor')
  accept(@Param('rid', ParseUUIDPipe) rid: string, @Body() d: AcceptDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.accept(rid, d, u, auditCtx(r)); }
  @Post('admit-requests/:rid/reject') @HttpCode(200) @Roles('admin', 'doctor')
  reject(@Param('rid', ParseUUIDPipe) rid: string, @Body() d: ReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.reject(rid, d.reason.trim(), u, auditCtx(r)); }
  @Post('admit-requests/:rid/cancel') @HttpCode(200) @Roles('admin', 'er_doctor')
  cancelReq(@Param('rid', ParseUUIDPipe) rid: string, @Body() d: ReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.cancelRequest(rid, d.reason.trim(), u, auditCtx(r)); }
  @Get('departed') @Roles(...ER_READ) departed(@Query('hours') h?: string, @Query('department_id') dep?: string, @Query('disposition') disp?: string) {
    if (dep && !/^[0-9a-f-]{36}$/i.test(dep)) throw new BadRequestException('არასწორი department_id');
    return this.s.departed({ hours: h ? Number(h) || 24 : 24, department_id: dep || undefined, disposition: disp });
  }
  @Post('visits/:id/summary') @HttpCode(200) @Roles('admin', 'er_doctor')
  regenerate(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.regenerate(id, u, auditCtx(r)); }
  @Get('visits/:id/summary/preview') @ClinicalHistory() @Roles(...DISP_READ)
  async preview(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Res({ passthrough: true }) res: Response) {
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="er-summary-preview.pdf"', 'Cache-Control': 'no-store' });
    return new StreamableFile(await this.s.preview(id, u));
  }
  @Get('visits/:id/summary/pdf') @ClinicalHistory() @Roles(...DISP_READ)
  async pdf(@Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response) {
    const f = await this.s.file(id);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${(f.number ?? 'er-summary').replace(/[^\w.-]+/g, '_')}.pdf"`, 'Cache-Control': 'no-store' });
    return new StreamableFile(f.stream);
  }
}

@Module({ imports: [InpatientModule, TemplatesModule], controllers: [ErDispositionController], providers: [ErDispositionService, ErSummaryService] })
export class ErDispositionModule {}
