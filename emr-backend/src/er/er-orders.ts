import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, Module, NotFoundException, Param, ParseUUIDPipe,
  Post, Query, Req, UnprocessableEntityException } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsISO8601, IsNumber, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import type { Request } from 'express';
import { sql, type Kysely, type Transaction } from 'kysely';
import { AllergiesModule } from '../allergies/allergies';
import { AllergyCheckService } from '../allergies/allergy-check.service';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser, type Role } from '../auth/roles';
import { mapPgError } from '../common/pg-errors';
import { InjectDb, type Database } from '../database/database.module';
import type { DB } from '../database/db';
import { ClinicalHistory, RequireModule } from '../modules/module-guard';
import { modActive, modulesRef, modUsable } from '../modules/modules-ref';
import { NotificationsService } from '../notifications/notifications';
import { PharmacyCatalogService } from '../stock/pharmacy-catalog';
import { StockWitnessService, WitnessDto } from '../stock/stock-controlled';
import { StockDocsService } from '../stock/stock-docs';
import { StockOpsService } from '../stock/stock-ops';
import { StockModule } from '../stock/stock.module';
import { ER_READ } from './er';
import { erCanWrite, erClinicalSettings, type ErClinicalSettings } from './er-access';

/**
 * 0089 — ER-ის კლინიკური ნაწილი (II): დანიშვნა / მიცემა / ჩამოწერა (ყოფილი „0088b“).
 *  • er_orders — STAT / ერთჯერადი / PRN (≤ prn_max_h სთ); მედიკამენტი / ინფუზია / პროცედურა. სტაციონარის med_orders / mar-ის გარეშე (ER inpatient-ზე არ არის დამოკიდებული).
 *  • ნიშნავს — ER-ის ექიმი (doctor_write: team / attending); ზეპირი — ER-ის ექთანი ექიმის სახელით (verbal_orders), ექიმი ადასტურებს verbal_confirm_h-ში.
 *  • უსაფრთხოება:
 *      - ალერგია — ყოველთვის (დასახელებით; კატალოგის ჯენერიკზე — ალერგენული ჯგუფებითაც);
 *      - დოზის ზღვრები / ურთიერთქმედება / დუბლირება — მხოლოდ pharmacy აქტიურზე (რბილი er → pharmacy), dose_rule: warn / reason;
 *      - ბავშვის წონა — ER-ში არ ბლოკავს (გაფრთხილება);
 *      - ორმაგი შემოწმება მიცემისას — double_check: off / high_alert / high_alert_controlled.
 *  • კატალოგი (med_generics — საწყობის ნომენკლატურა) — stock ხმარებადია; თავისუფალი ტექსტი — ყოველთვის.
 *  • ჩამოწერა (რბილი er → stock): stock აქტიური ∧ stock_deduct → ER-ის განყოფილების ქვესაწყობიდან (department / icu), FEFO, პაციენტზე;
 *    ნაშთი / ლოკაცია არ არის → allow_no_stock: მიცემა იწერება no_stock ნიშნით (დასაბუთებით) ან 409. ნარკოტიკული — მოწმე (stock-ის witness_classes).
 *    stock არააქტიურია → მიცემა იწერება, ჩამოწერა — არა.
 */
type Trx = Transaction<DB>;
type Ex = Kysely<DB> | Trx;

const ER_UNITS = ['mg', 'mcg', 'g', 'IU', 'ml', 'mmol', 'mEq', 'tab', 'cap', 'amp', 'vial', 'drop', 'puff', 'sachet', 'supp', 'appl'] as const;
const KINDS = ['medication', 'infusion', 'procedure'] as const;
const TYPES = ['stat', 'once', 'prn'] as const;
const OUTCOMES = ['given', 'partial', 'held', 'refused'] as const;
const ADULT_DAYS = 18 * 365;
const q3 = (n: number) => Math.round(n * 1000) / 1000;
const NOTE_READ: Role[] = [...ER_READ, 'doctor', 'nurse'];
/** ჩაწერა: ექიმი (დანიშვნა) / ექთანი (ზეპირი, მიცემა) — დეტალური წესი სერვისშია */
const ORDER_WRITE: Role[] = ['admin', 'er_doctor', 'er_triage'];
const ADMIN_WRITE: Role[] = ['admin', 'er_doctor', 'er_triage', 'nurse'];

// ======================================================================= DTO
export class ErOrderDto {
  @IsIn(KINDS) kind: (typeof KINDS)[number];
  @IsIn(TYPES) order_type: (typeof TYPES)[number];
  @IsOptional() @IsUUID() generic_id?: string;
  @IsOptional() @IsString() @Length(2, 300) drug_text?: string;
  @IsOptional() @IsNumber() @Min(0.0001) @Max(1_000_000) dose?: number;
  @IsOptional() @IsIn(ER_UNITS) dose_unit?: string;
  @IsOptional() @IsString() @Length(2, 10) route_code?: string;
  @IsOptional() @IsNumber() @Min(0.2) @Max(400) weight_kg?: number;
  @IsOptional() @IsNumber() @Min(1) @Max(10_000) volume_ml?: number;
  @IsOptional() @IsNumber() @Min(0.1) @Max(2_000) rate_ml_h?: number;
  @IsOptional() @IsString() @MaxLength(200) diluent?: string;
  @IsOptional() @IsString() @Length(2, 300) prn_reason?: string;
  @IsOptional() @IsNumber() @Min(0.5) @Max(24) prn_min_interval_h?: number;
  @IsOptional() @IsInt() @Min(1) @Max(48) prn_max_doses?: number;
  @IsOptional() @IsString() @Length(2, 2000) text?: string;
  @IsOptional() @IsString() @MaxLength(2000) instructions?: string;
  @IsOptional() @IsUUID() verbal_doctor_id?: string;
  @IsOptional() @IsBoolean() ack?: boolean;
  @IsOptional() @IsString() @Length(5, 1000) override_reason?: string;
  @IsOptional() @IsBoolean() confirm_severe?: boolean;
}
export class ErAdministerDto {
  @IsIn(OUTCOMES) outcome: (typeof OUTCOMES)[number];
  @IsOptional() @IsIn(['start', 'stop']) infusion_action?: 'start' | 'stop';
  @IsOptional() @IsISO8601() administered_at?: string;
  @IsOptional() @IsNumber() @Min(0.0001) @Max(1_000_000) dose?: number;
  @IsOptional() @IsString() @Length(2, 10) route_code?: string;
  @IsOptional() @IsNumber() @Min(0.1) @Max(2_000) rate_ml_h?: number;
  @IsOptional() @IsString() @MaxLength(100) site?: string;
  @IsOptional() @IsString() @MaxLength(1000) reason?: string;
  @IsOptional() @IsUUID() item_id?: string;
  @IsOptional() @IsNumber() @Min(0.001) @Max(10_000) qty_base?: number;
  @IsOptional() @ValidateNested() @Type(() => WitnessDto) witness?: WitnessDto;
  @IsOptional() @ValidateNested() @Type(() => WitnessDto) double_check?: WitnessDto;
  @IsOptional() @IsString() @Length(3, 1000) override_reason?: string;
}
class ReasonDto { @IsString() @Length(3, 1000) reason: string }

export interface ErCheck { code: string; level: 'info' | 'warn' | 'reason'; message: string; severe?: boolean }
const RANK = { info: 0, warn: 1, reason: 2 } as const;

interface VisitCtx {
  encounter_id: string; patient_id: string; department_id: string; status: string; ended_at: string | Date | null; doctor_id: string | null; doctor_at: string | Date | null;
  visit_no: string; first_name: string; last_name: string; age_days: number;
}

// ======================================================================= სერვისი
@Injectable()
export class ErOrdersService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService, private readonly allergy: AllergyCheckService,
              private readonly pharm: PharmacyCatalogService, private readonly ops: StockOpsService, private readonly docs: StockDocsService,
              private readonly wit: StockWitnessService, private readonly bell: NotificationsService) {}

  private settings() { return erClinicalSettings(); }
  private async assertEr() { if (modulesRef.svc) await modulesRef.svc.assertActive('er'); }
  private async erActive() { return modulesRef.svc ? modulesRef.svc.isActive('er').catch(() => false) : true; }

  private async visit(id: string, ex: Ex = this.db, lock = false): Promise<VisitCtx> {
    let q = ex.selectFrom('er_visits as v').innerJoin('patients as p', 'p.id', 'v.patient_id')
      .select(['v.encounter_id', 'v.patient_id', 'v.department_id', 'v.status', 'v.ended_at', 'v.doctor_id', 'v.doctor_at', 'v.visit_no', 'p.first_name', 'p.last_name',
        sql<number>`((now() AT TIME ZONE 'Asia/Tbilisi')::date - p.birth_date)`.as('age_days')])
      .where('v.encounter_id', '=', id);
    if (lock) q = q.forUpdate('v');
    const v = await q.executeTakeFirst();
    if (!v) throw new NotFoundException('ER-ის შემთხვევა ვერ მოიძებნა');
    return v as VisitCtx;
  }
  private open(v: VisitCtx) { if (v.ended_at) throw new ConflictException({ code: 'ER_VISIT_CLOSED', message: 'ER-ის შემთხვევა დახურულია' }); }
  private attending(v: VisitCtx) { return v.doctor_id && v.doctor_at ? v.doctor_id : null; }
  private async userDept(u: AuthUser, ex: Ex = this.db) {
    return (await ex.selectFrom('users').select('department_id').where('id', '=', u.id).executeTakeFirst())?.department_id ?? null;
  }
  /** მიცემა: ER-ის ექთანი / ექიმი, ER-ის განყოფილების ექთანი (nurse), ადმინი */
  private async canAdminister(u: AuthUser, v: VisitCtx, ex: Ex = this.db) {
    if (has(u, 'admin', 'er_triage', 'er_doctor')) return true;
    return has(u, 'nurse') && (await this.userDept(u, ex)) === v.department_id;
  }
  private async latestWeight(patientId: string, ex: Ex = this.db) {
    const w = await ex.selectFrom('encounter_vitals as v').innerJoin('encounters as e', 'e.id', 'v.encounter_id').select(['v.weight_kg'])
      .where('e.patient_id', '=', patientId).where('v.weight_kg', 'is not', null).where('v.voided_at', 'is', null).orderBy('v.recorded_at', 'desc').limit(1).executeTakeFirst();
    return w?.weight_kg ? Number(w.weight_kg) : null;
  }
  /** ER-ის განყოფილების ქვესაწყობი (როგორც MAR: department / icu) */
  private async location(departmentId: string, ex: Ex = this.db) {
    return ex.selectFrom('stock_locations').select(['id', 'name']).where('department_id', '=', departmentId).where('is_active', '=', true)
      .where('kind', 'in', ['department', 'icu']).orderBy('sort_order').limit(1).executeTakeFirst();
  }
  /** PRN-ის ვადის გასვლა (prn_max_h) — წაკითხვისას / მიცემისას */
  private async expire(ex: Ex, encounterId: string) {
    await ex.updateTable('er_orders').set({ status: 'expired', stopped_at: sql`expires_at` }).where('encounter_id', '=', encounterId)
      .where('status', '=', 'active').where('order_type', '=', 'prn').where('expires_at', '<', sql<Date>`now()`).execute();
  }
  private async notify(ids: string[], n: { kind: string; title: string; body?: string; entityId: string; link: string; urgent?: boolean }, except?: string) {
    for (const id of new Set(ids)) if (id !== except) await this.bell.notify(id, { ...n, urgent: !!n.urgent }).catch(() => undefined);
  }

  // ---------------------------------------------------------------- კატალოგი
  /** ჯენერიკის ძიება ER-ის დანიშვნისთვის — stock ხმარებადია (კატალოგი — საწყობის ნომენკლატურა); სხვაგვარად — მხოლოდ თავისუფალი ტექსტი */
  async meds(search: string | undefined, departmentId?: string) {
    if (!(await modUsable(this.db, 'stock'))) return { enabled: false, items: [] };
    const s = search?.trim() ?? '';
    if (s.length < 2) return { enabled: true, items: [] };
    const like = `%${s.toLowerCase()}%`;
    const loc = departmentId && (await modActive(this.db, 'stock')) ? await this.location(departmentId) : undefined;
    const items = await this.db.selectFrom('med_generics as g').innerJoin('med_dosage_forms as f', 'f.code', 'g.form_code')
      .select(['g.id', 'g.inn', 'g.inn_latin', 'g.strength', 'g.atc_code', 'f.name as form_name', 'g.dose_unit', 'g.dose_per_unit', 'g.routes', 'g.high_alert', 'g.controlled_class',
        loc ? sql<string>`coalesce((SELECT sum(b.qty) FROM stock_balances b JOIN stock_items i ON i.id = b.item_id JOIN stock_lots lt ON lt.id = b.lot_id
          WHERE i.generic_id = g.id AND i.is_active AND b.location_id = ${loc.id} AND lt.status = 'active'
            AND (lt.expires_on IS NULL OR lt.expires_on >= (now() AT TIME ZONE 'Asia/Tbilisi')::date)), 0)`.as('available') : sql<string | null>`NULL`.as('available')])
      .where('g.is_active', '=', true)
      .where((eb) => eb.or([eb(sql`lower(g.inn)`, 'like', like), eb(sql`lower(coalesce(g.inn_latin, ''))`, 'like', like), eb('g.atc_code', 'like', `${s.toUpperCase()}%`)]))
      .orderBy('g.inn').orderBy('g.strength').limit(30).execute();
    return { enabled: true, location: loc ?? null, items: items.map((i) => ({ ...i, available: i.available === null ? null : Number(i.available) })) };
  }

  // ---------------------------------------------------------------- სია
  async list(id: string, u: AuthUser) {
    const v = await this.visit(id);
    const s = await this.settings();
    if (!v.ended_at && (await this.erActive())) await this.expire(this.db, id);
    const orders = await this.db.selectFrom('er_orders as o').leftJoin('med_generics as g', 'g.id', 'o.generic_id').leftJoin('med_dosage_forms as f', 'f.code', 'g.form_code')
      .leftJoin('med_routes as r', 'r.code', 'o.route_code').innerJoin('users as ob', 'ob.id', 'o.ordered_by').innerJoin('users as eb', 'eb.id', 'o.entered_by')
      .leftJoin('users as sb', 'sb.id', 'o.stopped_by').leftJoin('users as vc', 'vc.id', 'o.verbal_confirmed_by')
      .selectAll('o').select(['g.inn', 'g.inn_latin', 'g.strength', 'f.name as form_name', 'r.name as route_name',
        sql<string>`ob.first_name || ' ' || ob.last_name`.as('ordered_by_name'), sql<string>`eb.first_name || ' ' || eb.last_name`.as('entered_by_name'),
        sql<string | null>`sb.first_name || ' ' || sb.last_name`.as('stopped_by_name'), sql<string | null>`vc.first_name || ' ' || vc.last_name`.as('verbal_confirmed_by_name')])
      .where('o.encounter_id', '=', id).orderBy('o.created_at', 'desc').execute();
    const adms = await this.db.selectFrom('er_administrations as a').innerJoin('users as d', 'd.id', 'a.documented_by').leftJoin('users as w', 'w.id', 'a.witness_id')
      .leftJoin('users as dc', 'dc.id', 'a.double_check_by').leftJoin('users as vb', 'vb.id', 'a.voided_by').leftJoin('stock_docs as sd', 'sd.id', 'a.stock_doc_id')
      .leftJoin('stock_items as si', 'si.id', 'a.stock_item_id')
      .selectAll('a').select(['sd.doc_no as stock_doc_no', 'si.name as stock_item_name',
        sql<string | null>`(SELECT string_agg(DISTINCT lt.lot_no, ', ') FROM stock_moves m JOIN stock_lots lt ON lt.id = m.lot_id WHERE m.doc_id = a.stock_doc_id)`.as('lot_no'),
        sql<string>`d.first_name || ' ' || d.last_name`.as('documented_by_name'), sql<string | null>`w.first_name || ' ' || w.last_name`.as('witness_name'),
        sql<string | null>`dc.first_name || ' ' || dc.last_name`.as('double_check_name'), sql<string | null>`vb.first_name || ' ' || vb.last_name`.as('voided_by_name')])
      .where('a.encounter_id', '=', id).orderBy('a.administered_at', 'desc').execute();
    const now = Date.now();
    const active = !v.ended_at && (await this.erActive());
    const routes = await this.db.selectFrom('med_routes').select(['code', 'name']).where('is_active', '=', true).orderBy('sort_order').execute();
    const [stock, stockUsable, pharmacy] = [await modActive(this.db, 'stock'), await modUsable(this.db, 'stock'), await modActive(this.db, 'pharmacy')];
    const doctorWrite = active && (await erCanWrite(u, this.attending(v), s));
    return {
      orders: orders.map((o) => {
        const a = adms.filter((x) => x.order_id === o.id);
        const given = a.filter((x) => !x.voided_at && (x.outcome === 'given' || x.outcome === 'partial'));
        const due = o.status === 'active' && o.order_type === 'stat' && !given.length ? new Date(new Date(o.created_at).getTime() + s.stat_due_min * 60_000) : null;
        return { ...o, name: o.kind === 'procedure' ? o.text : o.inn ? `${o.inn}${o.strength ? ` ${o.strength}` : ''}${o.form_name ? ` — ${o.form_name}` : ''}` : o.drug_text,
          administrations: a, given_count: given.length, last_given_at: given[0]?.administered_at ?? null,
          stat_overdue: !!due && now > due.getTime(), verbal_overdue: o.is_verbal && !o.verbal_confirmed_at && !!o.verbal_due_at && now > new Date(o.verbal_due_at).getTime() && o.status !== 'stopped' };
      }),
      routes, units: ER_UNITS,
      settings: { prn_max_h: s.prn_max_h, verbal_orders: s.verbal_orders, verbal_confirm_h: s.verbal_confirm_h, double_check: s.double_check, dose_rule: s.dose_rule,
        allow_no_stock: s.allow_no_stock, stock_deduct: s.stock_deduct, stat_due_min: s.stat_due_min },
      modules: { catalog: stockUsable, stock: stock && s.stock_deduct, pharmacy },
      can: {
        order: doctorWrite, administer: active && (await this.canAdminister(u, v)),
        verbal: active && s.verbal_orders && has(u, 'er_triage', 'nurse') && !has(u, 'er_doctor'),
        confirm: active && has(u, 'admin', 'er_doctor'),
      },
    };
  }

  // ---------------------------------------------------------------- დანიშვნა
  private async prepare(ex: Ex, v: VisitCtx, dto: ErOrderDto, s: ErClinicalSettings) {
    const checks: ErCheck[] = [];
    if (dto.kind === 'procedure') {
      if (!dto.text?.trim()) throw new BadRequestException('პროცედურა: მიუთითეთ აღწერა');
      if (dto.generic_id || dto.drug_text) throw new BadRequestException('პროცედურას მედიკამენტი არ ეთითება (ცალკე დანიშნულებით)');
      if (dto.order_type === 'prn' && !dto.prn_reason?.trim()) throw new BadRequestException('PRN: მიუთითეთ ჩვენება');
      return { checks, g: null, values: { kind: dto.kind, order_type: dto.order_type, text: dto.text.trim(), instructions: dto.instructions?.trim() || null,
        prn_reason: dto.order_type === 'prn' ? dto.prn_reason!.trim() : null } };
    }
    if (!dto.generic_id && !dto.drug_text?.trim()) throw new BadRequestException('მიუთითეთ მედიკამენტი (კატალოგიდან ან ტექსტით)');
    if (dto.generic_id && dto.drug_text) throw new BadRequestException('მედიკამენტი — ან კატალოგიდან, ან ტექსტით');
    if (dto.kind === 'infusion' && dto.order_type === 'prn') throw new BadRequestException('ინფუზია — STAT ან ერთჯერადი');
    if (!dto.route_code) throw new BadRequestException('მიღების გზა სავალდებულოა');
    const route = await ex.selectFrom('med_routes').select(['code', 'is_active']).where('code', '=', dto.route_code).executeTakeFirst();
    if (!route?.is_active) throw new BadRequestException('მიღების გზა ვერ მოიძებნა');
    if (dto.kind === 'medication' && (!dto.dose || !dto.dose_unit)) throw new BadRequestException('დოზა და ერთეული სავალდებულოა');
    if (dto.dose && !dto.dose_unit) throw new BadRequestException('მიუთითეთ დოზის ერთეული');
    if (dto.kind === 'infusion' && !dto.volume_ml && !dto.rate_ml_h) throw new BadRequestException('ინფუზია: მიუთითეთ მოცულობა ან სიჩქარე (მლ/სთ)');
    if (dto.order_type === 'prn' && !dto.prn_reason?.trim()) throw new BadRequestException('PRN: მიუთითეთ ჩვენება (მაგ. ტკივილი > 5)');

    const g = dto.generic_id ? await ex.selectFrom('med_generics as g').innerJoin('med_dosage_forms as f', 'f.code', 'g.form_code')
      .select(['g.id', 'g.inn', 'g.inn_latin', 'g.strength', 'g.dose_unit', 'g.routes', 'g.controlled_class', 'g.high_alert', 'g.is_active', 'f.name as form_name'])
      .where('g.id', '=', dto.generic_id).executeTakeFirst() : null;
    if (dto.generic_id) {
      if (!(await modUsable(ex, 'stock'))) throw new BadRequestException({ code: 'ER_CATALOG_UNAVAILABLE', message: 'მედიკამენტების კატალოგი მიუწვდომელია — მიუთითეთ ტექსტით' });
      if (!g?.is_active) throw new BadRequestException('ჯენერიკი ვერ მოიძებნა ან გათიშულია');
    }

    // --- ალერგია (ყოველთვის)
    const name = [g?.inn, g?.inn_latin, dto.drug_text].filter(Boolean).join(' ');
    const groups = g ? (await ex.selectFrom('med_generic_allergens').select('group_code').where('generic_id', '=', g.id).execute()).map((r) => r.group_code) : [];
    const al = await this.allergy.check(v.patient_id, name, ex as never, groups);
    for (const m of al.matches) {
      checks.push({ code: 'allergy', level: m.level === 'info' ? 'info' : m.level === 'warning' ? 'warn' : 'reason', severe: m.level === 'block',
        message: `ალერგია: ${m.substance}${m.group ? ` (${m.group}${m.match === 'cross' ? ', ჯვარედინი' : ''})` : ''} — ${m.allergy_type === 'intolerance' ? 'აუტანლობა' : m.severity === 'severe' ? 'მძიმე' : m.severity === 'moderate' ? 'საშუალო' : 'მსუბუქი'}` });
    }
    // --- წონა (ბავშვი) — ER-ში არ ბლოკავს
    const child = v.age_days < ADULT_DAYS;
    const weight = dto.weight_kg ?? (child ? await this.latestWeight(v.patient_id, ex) : null);
    if (child && !weight) checks.push({ code: 'weight_missing', level: 'warn', message: 'ბავშვი: წონა უცნობია — დოზა წონით ვერ შემოწმდა' });

    // --- დოზა / ურთიერთქმედება / დუბლირება — pharmacy (რბილი)
    const pharmacy = await modActive(ex, 'pharmacy');
    if (!g) checks.push({ code: 'free_text', level: 'info', message: 'კატალოგის გარეშე — დოზისა და ურთიერთქმედების შემოწმება ვერ ხერხდება' });
    else if (!pharmacy) checks.push({ code: 'no_pharmacy', level: 'info', message: 'აფთიაქის მოდული არააქტიურია — დოზის ზღვრები / ურთიერთქმედება არ მოწმდება' });
    if (g && pharmacy) {
      if (g.routes.length && !g.routes.includes(dto.route_code)) checks.push({ code: 'route', level: 'warn', message: `გზა ${dto.route_code} ამ ჯენერიკისთვის ტიპური არ არის (${g.routes.join(', ')})` });
      if (dto.dose && g.dose_unit && dto.dose_unit !== g.dose_unit) {
        checks.push({ code: 'dose_unit', level: 'info', message: `დოზის ზღვრები ${g.dose_unit}-შია — ${dto.dose_unit}-ში ვერ შემოწმდა` });
      } else if (dto.dose) {
        const perDay = dto.order_type === 'prn' ? (dto.prn_max_doses ?? 1) : 1;
        const dc = await this.pharm.doseCheck({ generic_id: g.id, dose: dto.dose, doses_per_day: Math.max(1, perDay), weight_kg: weight ?? undefined, age_days: v.age_days });
        for (const w of dc.warnings) {
          if (w.code === 'no_limits') checks.push({ code: 'dose_limits', level: 'info', message: w.message });
          else if (w.code === 'weight_required') { if (!checks.some((c) => c.code === 'weight_missing')) checks.push({ code: 'dose_weight', level: 'warn', message: w.message }); }
          else if (w.code === 'min_age') checks.push({ code: 'dose_age', level: 'reason', message: w.message });
          else checks.push({ code: `dose_${w.code}`, level: s.dose_rule === 'reason' ? 'reason' : 'warn', message: w.message });
        }
      }
      // ამ შემთხვევის დანიშნულებები (აქტიური / შესრულებული)
      const prior = await ex.selectFrom('er_orders').select(['generic_id', 'status']).where('encounter_id', '=', v.encounter_id)
        .where('generic_id', 'is not', null).where('status', 'in', ['active', 'completed']).execute();
      if (prior.some((p) => p.generic_id === g.id && p.status === 'active')) checks.push({ code: 'duplicate', level: 'warn', message: `დუბლირება: ${g.inn} უკვე დანიშნულია (აქტიური)` });
      const others = [...new Set(prior.map((p) => p.generic_id!).filter((x) => x !== g.id))];
      if (others.length) {
        for (const x of await this.pharm.check([g.id, ...others])) {
          if (x.a_id !== g.id && x.b_id !== g.id) continue;
          const lvl: ErCheck['level'] = x.severity === 'contraindicated' || x.severity === 'major' ? 'reason' : x.severity === 'moderate' || x.severity === 'duplicate' ? 'warn' : 'info';
          checks.push({ code: x.severity === 'duplicate' ? 'duplicate' : `interaction_${x.severity}`, level: lvl,
            message: `${x.severity === 'duplicate' ? '' : 'ურთიერთქმედება: '}${x.a} + ${x.b} — ${x.effect}${x.recommendation ? ` (${x.recommendation})` : ''}` });
        }
      }
    }
    if (g?.high_alert) checks.push({ code: 'high_alert', level: 'info', message: 'მაღალი რისკის მედიკამენტი' });
    if (dto.order_type === 'prn' && !dto.prn_max_doses) checks.push({ code: 'prn_max', level: 'info', message: `PRN: მაქსიმუმი არ არის მითითებული (ვადა — ${s.prn_max_h} სთ)` });

    return { checks, g, values: {
      kind: dto.kind, order_type: dto.order_type, generic_id: g?.id ?? null, drug_text: g ? null : dto.drug_text!.trim(),
      dose: dto.dose ? String(dto.dose) : null, dose_unit: dto.dose ? dto.dose_unit! : null, route_code: dto.route_code, weight_kg: weight ? String(weight) : null,
      volume_ml: dto.volume_ml ? String(dto.volume_ml) : null, rate_ml_h: dto.rate_ml_h ? String(dto.rate_ml_h) : null, diluent: dto.diluent?.trim() || null,
      prn_reason: dto.order_type === 'prn' ? dto.prn_reason!.trim() : null, prn_min_interval_h: dto.order_type === 'prn' && dto.prn_min_interval_h ? String(dto.prn_min_interval_h) : null,
      prn_max_doses: dto.order_type === 'prn' ? dto.prn_max_doses ?? null : null, instructions: dto.instructions?.trim() || null,
      high_alert: !!g?.high_alert, controlled_class: g?.controlled_class ?? null,
    } };
  }

  async create(id: string, dto: ErOrderDto, u: AuthUser, ctx: AuditContext) {
    const s = await this.settings();
    const out = await this.db.transaction().execute(async (trx) => {
      const v = await this.visit(id, trx, true);
      this.open(v);
      // --- ვინ ნიშნავს
      let orderedBy = u.id; let verbal = false;
      if (dto.verbal_doctor_id && dto.verbal_doctor_id !== u.id) {
        if (!s.verbal_orders) throw new ForbiddenException('ზეპირი დანიშვნა კლინიკაში გამორთულია');
        if (!has(u, 'admin', 'er_triage', 'nurse')) throw new ForbiddenException('ზეპირ დანიშნულებას შეიყვანს ER-ის ექთანი');
        if (has(u, 'nurse') && !has(u, 'admin', 'er_triage') && (await this.userDept(u, trx)) !== v.department_id) throw new ForbiddenException('ზეპირი დანიშნულება — ER-ის განყოფილების ექთანი');
        const d = await trx.selectFrom('users as x').leftJoin('user_capabilities as c', 'c.user_id', 'x.id').select(['x.is_active', 'c.capabilities'])
          .where('x.id', '=', dto.verbal_doctor_id).executeTakeFirst();
        if (!d?.is_active || !(d.capabilities ?? []).includes('er_doctor')) throw new BadRequestException('ექიმი ვერ მოიძებნა ან ER-ის ექიმი არ არის');
        if (s.doctor_write === 'attending' && this.attending(v) && this.attending(v) !== dto.verbal_doctor_id) throw new ForbiddenException('ზეპირი დანიშნულება — მკურნალი ექიმის სახელით (კლინიკის წესი)');
        await this.assertEr();
        orderedBy = dto.verbal_doctor_id; verbal = true;
      } else {
        if (!(await erCanWrite(u, this.attending(v), s))) {
          throw new ForbiddenException(s.doctor_write === 'attending' ? 'დანიშვნა — მკურნალი ექიმი (კლინიკის წესი)' : 'დანიშვნა — ER-ის ექიმი (ექთანი — ზეპირი დანიშნულებით)');
        }
        await this.assertEr();
      }
      const p = await this.prepare(trx, v, dto, s);
      // --- შემოწმებების დადასტურება
      const top = p.checks.reduce((m, c) => Math.max(m, RANK[c.level]), 0);
      const severe = p.checks.some((c) => c.severe);
      const needAck = top >= RANK.warn && !dto.ack && !dto.override_reason;
      const needReason = top >= RANK.reason && !dto.override_reason?.trim();
      if (needAck || needReason || (severe && !dto.confirm_severe)) {
        throw new ConflictException({ code: 'ER_ORDER_CHECKS', message: 'შემოწმებები — საჭიროა დადასტურება', checks: p.checks,
          requires: { ack: top >= RANK.warn, reason: top >= RANK.reason, severe } });
      }
      const o = await trx.insertInto('er_orders').values({
        ...p.values, encounter_id: id, patient_id: v.patient_id, ordered_by: orderedBy, entered_by: u.id, is_verbal: verbal,
        verbal_due_at: verbal ? sql<Date>`now() + make_interval(hours => ${s.verbal_confirm_h})` : null,
        expires_at: dto.order_type === 'prn' ? sql<Date>`now() + make_interval(hours => ${s.prn_max_h})` : null,
        checks: JSON.stringify(p.checks), override_reason: top >= RANK.warn ? dto.override_reason?.trim() || 'ack' : null,
      }).returningAll().executeTakeFirstOrThrow();
      await this.audit.log(ctx, { action: 'ER_ORDER_CREATE', entityName: 'er_orders', entityId: o.id,
        newData: { encounter_id: id, ...p.values, verbal, ordered_by: orderedBy, checks: p.checks.filter((c) => c.level !== 'info').map((c) => c.code), override_reason: o.override_reason } }, trx);
      return { o, v, verbal, name: p.g ? p.g.inn : dto.drug_text ?? dto.text ?? '' };
    }).catch((e) => mapPgError(e, { chk_er_order_drug: 'მედიკამენტი — ან კატალოგიდან, ან ტექსტით', chk_er_order_prn: 'PRN: ჩვენება სავალდებულოა' }));
    if (out.verbal) {
      await this.notify([out.o.ordered_by], { kind: 'er_verbal_confirm', title: `ER — ზეპირი დანიშნულება, დაადასტურეთ: ${out.name}`,
        body: `${out.v.last_name} ${out.v.first_name} (${out.v.visit_no}) · ${s.verbal_confirm_h} სთ-ში`, entityId: out.o.id, link: `/er?visit=${id}&tab=orders`, urgent: true });
    }
    return out.o;
  }

  private async lockOrder(trx: Trx, id: string) {
    const o = await trx.selectFrom('er_orders').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!o) throw new NotFoundException('დანიშნულება ვერ მოიძებნა');
    return o;
  }
  async stop(id: string, reason: string, u: AuthUser, ctx: AuditContext) {
    const s = await this.settings();
    return this.db.transaction().execute(async (trx) => {
      const o = await this.lockOrder(trx, id);
      const v = await this.visit(o.encounter_id, trx);
      this.open(v);
      const own = o.is_verbal && !o.verbal_confirmed_at && o.entered_by === u.id;   // ექთანი: საკუთარი დაუდასტურებელი ზეპირი (შეცდომა)
      if (!own && !(await erCanWrite(u, this.attending(v), s))) throw new ForbiddenException('შეწყვეტა — ER-ის ექიმი');
      await this.assertEr();
      if (o.status !== 'active') throw new ConflictException('დანიშნულება აქტიური არ არის');
      const r = await trx.updateTable('er_orders').set({ status: 'stopped', stopped_at: sql`now()`, stopped_by: u.id, stop_reason: reason.trim() })
        .where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await this.audit.log(ctx, { action: 'ER_ORDER_STOP', entityName: 'er_orders', entityId: id, oldData: { status: o.status }, newData: { reason } }, trx);
      return r;
    });
  }
  /** ზეპირი დანიშნულების დადასტურება — ექიმი, ვის სახელითაც შეიყვანეს (team — ნებისმიერი ER-ის ექიმი), ადმინი */
  async confirm(id: string, u: AuthUser, ctx: AuditContext) {
    const s = await this.settings();
    return this.db.transaction().execute(async (trx) => {
      const o = await this.lockOrder(trx, id);
      if (!o.is_verbal || o.verbal_confirmed_at) throw new ConflictException('დასადასტურებელი ზეპირი დანიშნულება არ არის');
      if (!has(u, 'admin') && !(has(u, 'er_doctor') && (o.ordered_by === u.id || s.doctor_write === 'team'))) throw new ForbiddenException('ადასტურებს ექიმი, ვის სახელითაც შეიყვანეს');
      await this.assertEr();
      const r = await trx.updateTable('er_orders').set({ verbal_confirmed_at: sql`now()`, verbal_confirmed_by: u.id }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await this.audit.log(ctx, { action: 'ER_ORDER_VERBAL_CONFIRM', entityName: 'er_orders', entityId: id, newData: { ordered_by: o.ordered_by, late: !!o.verbal_due_at && new Date(o.verbal_due_at) < new Date() } }, trx);
      return r;
    });
  }

  // ---------------------------------------------------------------- მიცემა
  private async genericInfo(genericId: string | null) {
    if (!genericId) return null;
    return (await this.db.selectFrom('med_generics').select(['id', 'dose_unit', 'dose_per_unit', 'controlled_class', 'high_alert', 'inn']).where('id', '=', genericId).executeTakeFirst()) ?? null;
  }
  private qtyFor(o: { kind: string; dose_unit: string | null }, g: { dose_unit: string | null; dose_per_unit: string | null } | null, dose: number | null) {
    if (o.kind === 'infusion') return 1;
    if (dose && g?.dose_per_unit && o.dose_unit && o.dose_unit === g.dose_unit) return Math.max(1, Math.ceil(q3(dose / Number(g.dose_per_unit))));
    return 1;
  }
  /** მიცემის დიალოგისთვის: ქვესაწყობის SKU-ები ნაშთით */
  async orderStock(id: string) {
    const o = await this.db.selectFrom('er_orders').selectAll().where('id', '=', id).executeTakeFirst();
    if (!o) throw new NotFoundException('დანიშნულება ვერ მოიძებნა');
    const v = await this.visit(o.encounter_id);
    const s = await this.settings();
    return this.stockFor(o, v, s, o.dose ? Number(o.dose) : null);
  }
  private async stockFor(o: { generic_id: string | null; kind: string; dose_unit: string | null }, v: VisitCtx, s: ErClinicalSettings, dose: number | null) {
    const g = await this.genericInfo(o.generic_id);
    const deduct = !!o.generic_id && o.kind !== 'procedure' && s.stock_deduct && (await modActive(this.db, 'stock'));
    if (!deduct) return { deduct: false, location: null, items: [] as { id: string; name: string; code: string | null; unit_name: string; available: number }[], qty_suggest: null as number | null, g };
    const loc = await this.location(v.department_id);
    if (!loc) return { deduct: true, location: null, items: [], qty_suggest: this.qtyFor(o, g, dose), g };
    const items = await this.db.selectFrom('stock_items as i').innerJoin('stock_units as un', 'un.code', 'i.base_unit')
      .select(['i.id', 'i.name', 'i.code', 'un.name as unit_name',
        sql<string>`coalesce((SELECT sum(b.qty) FROM stock_balances b JOIN stock_lots lt ON lt.id = b.lot_id WHERE b.item_id = i.id AND b.location_id = ${loc.id}
          AND lt.status = 'active' AND (lt.expires_on IS NULL OR lt.expires_on >= (now() AT TIME ZONE 'Asia/Tbilisi')::date)), 0)`.as('available')])
      .where('i.generic_id', '=', o.generic_id!).where('i.is_active', '=', true).orderBy('i.name').execute();
    return { deduct: true, location: loc, items: items.map((i) => ({ ...i, available: Number(i.available) })), qty_suggest: this.qtyFor(o, g, dose), g };
  }

  async administer(id: string, dto: ErAdministerDto, u: AuthUser, ctx: AuditContext) {
    const s = await this.settings();
    const o0 = await this.db.selectFrom('er_orders').selectAll().where('id', '=', id).executeTakeFirst();
    if (!o0) throw new NotFoundException('დანიშნულება ვერ მოიძებნა');
    const v = await this.visit(o0.encounter_id);
    this.open(v);
    if (!(await this.canAdminister(u, v))) throw new ForbiddenException('მიცემა — ER-ის ექთანი / ექიმი');
    await this.assertEr();
    await this.expire(this.db, v.encounter_id);
    const o = (await this.db.selectFrom('er_orders').selectAll().where('id', '=', id).executeTakeFirstOrThrow());
    if (o.status !== 'active') throw new ConflictException({ code: 'ER_ORDER_INACTIVE', message: o.status === 'expired' ? 'PRN დანიშნულების ვადა ამოიწურა — საჭიროა ახალი დანიშნულება' : 'დანიშნულება აქტიური არ არის' });

    const at = dto.administered_at ? new Date(dto.administered_at) : new Date();
    if (at.getTime() > Date.now() + 5 * 60_000) throw new BadRequestException('დრო მომავალშია');
    if (at.getTime() < new Date(o.created_at).getTime() - 5 * 60_000) throw new BadRequestException('დრო დანიშვნამდეა');
    const given = dto.outcome === 'given' || dto.outcome === 'partial';
    if (!given && (dto.reason?.trim().length ?? 0) < 2) throw new BadRequestException(dto.outcome === 'refused' ? 'უარი: მიუთითეთ მიზეზი' : 'გადადება: მიუთითეთ მიზეზი');
    const proc = o.kind === 'procedure'; const infusion = o.kind === 'infusion';
    if (proc && dto.outcome === 'partial') throw new BadRequestException('პროცედურა — შესრულდა / გადაიდო / უარი');
    const prior = await this.db.selectFrom('er_administrations').select(['administered_at', 'infusion_action', 'outcome']).where('order_id', '=', id).where('voided_at', 'is', null)
      .where('outcome', 'in', ['given', 'partial']).orderBy('administered_at', 'desc').execute();
    if (infusion && given) {
      if (!dto.infusion_action) throw new BadRequestException('ინფუზია: მიუთითეთ მოქმედება (დაწყება / დასრულება)');
      const started = prior.some((p) => p.infusion_action === 'start');
      if (dto.infusion_action === 'start' && started) throw new ConflictException('ინფუზია უკვე დაწყებულია');
      if (dto.infusion_action === 'stop' && !started) throw new ConflictException('ინფუზია ჯერ არ დაწყებულა');
      if (dto.outcome === 'partial') throw new BadRequestException('ინფუზია — დაწყება / დასრულება');
    }
    const checks: ErCheck[] = [];
    let dose: number | null = null;
    if (given && !proc && !(infusion && dto.infusion_action === 'stop')) {
      dose = dto.dose ?? (o.dose ? Number(o.dose) : null);
      if (o.kind === 'medication' && !dose) throw new BadRequestException('მიუთითეთ მიცემული დოზა');
      if (dto.outcome === 'partial' && (!o.dose || !dose || dose >= Number(o.dose))) throw new BadRequestException('ნაწილობრივ — დოზა დანიშნულზე ნაკლები უნდა იყოს');
      if (dto.outcome === 'given' && o.dose && dose && dose > Number(o.dose) * 1.0001) checks.push({ code: 'dose_over', level: 'reason', message: `დოზა (${dose}) დანიშნულზე (${Number(o.dose)}) მეტია` });
      if (o.order_type === 'prn') {
        if (o.prn_max_doses && prior.length >= o.prn_max_doses) checks.push({ code: 'prn_max', level: 'reason', message: `PRN: უკვე ${prior.length} დოზა (მაქს. ${o.prn_max_doses})` });
        if (o.prn_min_interval_h && prior[0]) {
          const h = (at.getTime() - new Date(prior[0].administered_at).getTime()) / 3_600_000;
          if (h < Number(o.prn_min_interval_h)) checks.push({ code: 'prn_interval', level: 'reason', message: `PRN: წინა დოზიდან ${Math.round(h * 10) / 10} სთ (მინ. ${Number(o.prn_min_interval_h)})` });
        }
      } else if (prior.length && !infusion) {
        throw new ConflictException('დანიშნულება უკვე შესრულებულია (შესწორება — გაუქმებით)');
      }
    }
    if (dto.route_code) {
      const r = await this.db.selectFrom('med_routes').select('is_active').where('code', '=', dto.route_code).executeTakeFirst();
      if (!r?.is_active) throw new BadRequestException('მიღების გზა ვერ მოიძებნა');
    }

    // --- მარაგი (რბილი er → stock)
    const wantStock = given && !proc && (!infusion || dto.infusion_action === 'start');
    const st = wantStock ? await this.stockFor(o, v, s, dose) : { deduct: false, location: null, items: [], qty_suggest: null, g: await this.genericInfo(o.generic_id) };
    let itemId: string | null = dto.item_id ?? null; let qty: number | null = null; let noStock = false;
    if (st.deduct) {
      qty = dto.qty_base ?? st.qty_suggest ?? 1;
      if (itemId && !st.items.some((i) => i.id === itemId)) throw new BadRequestException('საქონელი ამ მედიკამენტს არ შეესაბამება');
      if (!itemId) {
        const withStock = st.items.filter((i) => i.available >= qty!);
        if (withStock.length === 1) itemId = withStock[0].id;
        else if (withStock.length > 1) throw new ConflictException({ code: 'ER_ITEM_REQUIRED', message: 'აირჩიეთ საქონელი (რამდენიმე SKU)', items: st.items, qty_suggest: qty });
      }
      const avail = st.items.find((i) => i.id === itemId)?.available ?? 0;
      if (!st.location || !itemId || avail < qty) {
        const msg = !st.location ? 'ER-ის განყოფილებას ქვესაწყობი არ აქვს' : !itemId ? 'ქვესაწყობში ამ მედიკამენტის ნაშთი არ არის' : `ნაშთი არასაკმარისია (${avail} < ${qty})`;
        if (!s.allow_no_stock) throw new ConflictException({ code: 'ER_NO_STOCK', message: `${msg} — მიცემა შეუძლებელია (კლინიკის წესი)`, items: st.items });
        checks.push({ code: 'no_stock', level: 'reason', message: `${msg} — მიცემა ჩამოწერის გარეშე` });
        noStock = true;
      }
    }
    if (checks.length && !dto.override_reason?.trim()) throw new ConflictException({ code: 'ER_ADMIN_CHECKS', message: 'საჭიროა დასაბუთება', checks });
    // --- ორმაგი შემოწმება
    let dbl: { id: string } | null = null;
    const risky = s.double_check === 'high_alert' ? o.high_alert : s.double_check === 'high_alert_controlled' ? o.high_alert || !!o.controlled_class : false;
    if (given && !proc && risky && dto.infusion_action !== 'stop') {
      if (!dto.double_check) throw new UnprocessableEntityException({ code: 'ER_DOUBLE_CHECK', message: 'მაღალი რისკის მედიკამენტი — საჭიროა მეორე თანამშრომლის დადასტურება' });
      dbl = await this.wit.verify(dto.double_check, u, ctx, 'er_double_check');
    }

    const values = {
      order_id: id, encounter_id: o.encounter_id, patient_id: o.patient_id, outcome: dto.outcome, infusion_action: infusion && given ? dto.infusion_action! : null,
      administered_at: at.toISOString(), documented_by: u.id, dose: dose !== null ? String(dose) : null, dose_unit: dose !== null ? o.dose_unit : null,
      route_code: given && !proc ? dto.route_code ?? o.route_code : null, rate_ml_h: infusion && dto.infusion_action === 'start' ? String(dto.rate_ml_h ?? o.rate_ml_h ?? '') || null : null,
      site: dto.site?.trim() || null, reason: dto.reason?.trim() || null, no_stock: noStock, warnings: JSON.stringify(checks),
      override_reason: checks.length ? dto.override_reason!.trim() : null, double_check_by: dbl?.id ?? null,
    };
    let admId = '';
    const write = async (trx: Trx, docId: string | null) => {
      const witness = docId ? (await trx.selectFrom('stock_docs').select('witness_id').where('id', '=', docId).executeTakeFirstOrThrow()).witness_id : null;
      const a = await trx.insertInto('er_administrations').values({ ...values, stock_doc_id: docId, stock_item_id: docId ? itemId : null, qty_base: docId ? String(qty) : null, witness_id: witness })
        .returning('id').executeTakeFirstOrThrow();
      admId = a.id;
      // STAT / ერთჯერადი (მედიკამენტი / პროცედურა) — შესრულებისას სრულდება; ინფუზია — დასრულებით
      const done = given && ((o.order_type !== 'prn' && !infusion) || (infusion && dto.infusion_action === 'stop'));
      if (done) await trx.updateTable('er_orders').set({ status: 'completed', stopped_at: sql`now()` }).where('id', '=', id).where('status', '=', 'active').execute();
      await this.audit.log(ctx, { action: 'ER_ADMINISTER', entityName: 'er_administrations', entityId: a.id,
        newData: { order_id: id, outcome: dto.outcome, action: values.infusion_action, dose, at, stock_doc_id: docId, no_stock: noStock, checks: checks.map((c) => c.code), double_check: dbl?.id ?? null } }, trx);
    };
    try {
      if (st.deduct && !noStock) {
        const g = st.g; const controlled = !!g?.controlled_class; const dpu = g?.dose_per_unit ? Number(g.dose_per_unit) : null;
        const sameUnit = !!dpu && !!o.dose_unit && o.dose_unit === g?.dose_unit;
        await this.ops.createConsumption({
          location_id: st.location!.id, patient_id: o.patient_id, encounter_id: o.encounter_id, notes: `ER: ${g?.inn ?? o.drug_text ?? ''} ${v.visit_no}`, witness: dto.witness ?? null,
          lines: [{ item_id: itemId!, qty_base: qty!, lot_id: null,
            ...(controlled && { dose_given: sameUnit && dose !== null ? dose : dpu ? q3(qty! * dpu) : dose ?? undefined, dose_wasted: sameUnit && dose !== null ? Math.max(0, q3(qty! * dpu! - dose)) : 0 }) }],
        }, u, ctx, (trx, docId) => write(trx, docId), { authorized: true });
      } else {
        await this.db.transaction().execute((trx) => write(trx, null));
      }
    } catch (e) { mapPgError(e, { chk_er_adm_reason: 'უარი / გადადება — მიუთითეთ მიზეზი' }); }
    return this.db.selectFrom('er_administrations').selectAll().where('id', '=', admId).executeTakeFirstOrThrow();
  }

  async void(admId: string, reason: string, u: AuthUser, ctx: AuditContext) {
    const a = await this.db.selectFrom('er_administrations').selectAll().where('id', '=', admId).executeTakeFirst();
    if (!a || a.voided_at) throw new NotFoundException('ჩანაწერი ვერ მოიძებნა');
    const v = await this.visit(a.encounter_id);
    this.open(v);
    if (a.documented_by !== u.id && !has(u, 'admin', 'er_manage', 'er_doctor')) throw new ForbiddenException('აუქმებს ავტორი, ER-ის ექიმი ან მენეჯერი');
    await this.assertEr();
    const write = async (trx: Trx, revId: string | null) => {
      const r = await trx.updateTable('er_administrations').set({ voided_at: sql`now()`, voided_by: u.id, void_reason: reason.trim(), void_stock_doc_id: revId })
        .where('id', '=', admId).where('voided_at', 'is', null).returning('id').executeTakeFirst();
      if (!r) throw new ConflictException('ჩანაწერი უკვე გაუქმებულია');
      // ავტომატურად დასრულებული (STAT / ერთჯერადი / ინფუზია) — ბრუნდება აქტიურში, თუ სხვა მოქმედი შესრულება აღარ არის
      const left = await trx.selectFrom('er_administrations').select('id').where('order_id', '=', a.order_id).where('voided_at', 'is', null)
        .where('outcome', 'in', ['given', 'partial']).$if(a.infusion_action === 'stop', (q) => q.where('infusion_action', '=', 'stop')).executeTakeFirst();
      if (!left) await trx.updateTable('er_orders').set({ status: 'active', stopped_at: null }).where('id', '=', a.order_id).where('status', '=', 'completed').where('stopped_by', 'is', null).execute();
      await this.audit.log(ctx, { action: 'ER_ADMINISTER_VOID', entityName: 'er_administrations', entityId: admId, oldData: { outcome: a.outcome, stock_doc_id: a.stock_doc_id }, newData: { reason, reversal: revId } }, trx);
    };
    if (a.stock_doc_id) await this.docs.reverse(a.stock_doc_id, `ER — მიცემის გაუქმება: ${reason.trim()}`, u, ctx, (trx, rid) => write(trx, rid));
    else await this.db.transaction().execute((trx) => write(trx, null));
    return { ok: true };
  }
}

// ======================================================================= controller
@Controller('er')
@RequireModule('er')
export class ErOrdersController {
  constructor(private readonly s: ErOrdersService) {}
  @Get('meds') @Roles(...ORDER_WRITE) meds(@Query('search') q?: string, @Query('department_id') dep?: string) {
    return this.s.meds(q, dep && /^[0-9a-f-]{36}$/i.test(dep) ? dep : undefined);
  }
  @Get('visits/:id/orders') @ClinicalHistory() @Roles(...NOTE_READ) list(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser) { return this.s.list(id, u); }
  @Post('visits/:id/orders') @Roles(...ORDER_WRITE, 'nurse')
  create(@Param('id', ParseUUIDPipe) id: string, @Body() d: ErOrderDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.create(id, d, u, auditCtx(r)); }
  @Post('orders/:id/stop') @HttpCode(200) @Roles(...ORDER_WRITE, 'nurse')
  stop(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.stop(id, d.reason, u, auditCtx(r)); }
  @Post('orders/:id/confirm') @HttpCode(200) @Roles('admin', 'er_doctor')
  confirm(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.confirm(id, u, auditCtx(r)); }
  @Get('orders/:id/stock') @Roles(...ADMIN_WRITE) stock(@Param('id', ParseUUIDPipe) id: string) { return this.s.orderStock(id).then(({ g, ...x }) => { void g; return x; }); }
  @Post('orders/:id/administer') @Roles(...ADMIN_WRITE)
  administer(@Param('id', ParseUUIDPipe) id: string, @Body() d: ErAdministerDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.administer(id, d, u, auditCtx(r)); }
  @Post('administrations/:id/void') @HttpCode(200) @Roles(...ADMIN_WRITE, 'er_manage')
  void(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.void(id, d.reason, u, auditCtx(r)); }
}

@Module({ imports: [StockModule, AllergiesModule], controllers: [ErOrdersController], providers: [ErOrdersService], exports: [ErOrdersService] })
export class ErOrdersModule {}
