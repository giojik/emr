import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, Module, NotFoundException, Param, ParseUUIDPipe,
  Post, Query, Req, UnprocessableEntityException } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsNumber, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import type { Request } from 'express';
import { sql, type Transaction } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser } from '../auth/roles';
import { loadEnv } from '../config/env';
import type { DB } from '../database/db';
import { InjectDb, type Database } from '../database/database.module';
import { parseBarcode } from '../stock/gs1';
import { StockWitnessService, WitnessDto } from '../stock/stock-controlled';
import { StockDocsService } from '../stock/stock-docs';
import { StockOpsService } from '../stock/stock-ops';
import { StockModule } from '../stock/stock.module';
import { InpatientModule, InpatientService, type InpatientSettings } from './inpatient';
import { ensureMarSlots } from './mar-schedule';

type Trx = Transaction<DB>;
const TZ = loadEnv().CLINIC_TZ;
const OUTCOMES = ['given', 'partial', 'held', 'refused', 'not_given'] as const;
type Outcome = (typeof OUTCOMES)[number];
const INFUSION = ['start', 'rate', 'bag', 'pause', 'stop'] as const;
const q3 = (n: number) => Math.round(n * 1000) / 1000;

export class MarDocumentDto {
  @IsIn(OUTCOMES) outcome: Outcome;
  @IsOptional() @IsDateString() documented_at?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(1_000_000) dose?: number;
  @IsOptional() @IsString() @Length(2, 10) route_code?: string;
  @IsOptional() @IsString() @MaxLength(200) site?: string;
  @IsOptional() @IsString() @Length(2, 1000) reason?: string;
  @IsOptional() @IsDateString() postponed_to?: string;
  @IsOptional() @IsUUID() item_id?: string;
  @IsOptional() @IsNumber() @Min(0.001) @Max(10_000) qty_base?: number;
  @IsOptional() @IsUUID() lot_id?: string;
  @IsOptional() @ValidateNested() @Type(() => WitnessDto) witness?: WitnessDto;
  @IsOptional() @ValidateNested() @Type(() => WitnessDto) double_check?: WitnessDto;
  @IsOptional() @IsString() @MaxLength(60) scanned_patient?: string;
  @IsOptional() @IsString() @MaxLength(200) scanned_barcode?: string;
  @IsOptional() @IsString() @Length(5, 1000) override_reason?: string;
  @IsOptional() @IsIn(INFUSION) infusion_action?: (typeof INFUSION)[number];
  @IsOptional() @IsNumber() @Min(0.1) @Max(2_000) rate_ml_h?: number;
}
export class MarVoidDto { @IsString() @Length(3, 1000) reason: string }

interface MarCheck { code: string; message: string }
type OrderCtx = Awaited<ReturnType<MarService['order']>>;

/**
 * MAR (0043): დოზების / დავალებების სლოტები, ჩანაწერი, მარაგის ჩამოწერა, შესწორება.
 *   ჩაწერს: მიმდინარე განყოფილების ექთანი ან ექიმი (admin). მიცემისას (given / partial):
 *     ბლოკი — დანიშნულება შეჩერებულია / ფარმაცევტმა უარყო / სარეზერვო ანტიბიოტიკი დამტკიცებამდე მეორე დოზა / სამაჯური ან მედიკამენტი არ ემთხვევა;
 *     მიზეზით (409 MAR_CHECKS → override_reason) — ვერიფიკაციის მოლოდინში, დამტკიცებამდე პირველი დოზა, ფანჯრის გარეთ, PRN ინტერვალი / დღიური მაქსიმუმი;
 *     high-alert — მეორე ექთანი (double_check), კონტროლირებადი — მოწმე (0035), მარაგი — ხარჯი პაციენტზე (0033) იმავე ტრანზაქციაში.
 *   შესწორება — გაუქმება მიზეზით (ხარჯი შემობრუნდება), სლოტი თავიდან იხსნება.
 */
@Injectable()
export class MarService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService, private readonly ipd: InpatientService,
              private readonly ops: StockOpsService, private readonly docs: StockDocsService, private readonly wit: StockWitnessService) {}

  private async settings() { return this.ipd.settings(); }

  async order(orderId: string, ex: Database | Trx = this.db) {
    const o = await ex.selectFrom('med_orders as o').leftJoin('med_generics as g', 'g.id', 'o.generic_id').innerJoin('inpatient_stays as st', 'st.encounter_id', 'o.encounter_id')
      .selectAll('o').select(['g.inn', 'g.dose_unit as g_dose_unit', 'g.dose_per_unit', 'g.high_alert', 'g.controlled_class', 'st.adm_no', 'st.status as stay_status',
        sql<string>`(SELECT a.department_id FROM bed_assignments a WHERE a.encounter_id = o.encounter_id AND a.ended_at IS NULL LIMIT 1)`.as('department_id'),
        sql<boolean>`EXISTS (SELECT 1 FROM inpatient_leaves l WHERE l.encounter_id = o.encounter_id AND l.returned_at IS NULL)`.as('on_leave')])
      .where('o.id', '=', orderId).executeTakeFirst();
    if (!o) throw new NotFoundException('დანიშნულება ვერ მოიძებნა');
    return o;
  }
  private async canDocument(u: AuthUser, departmentId: string | null) {
    if (has(u, 'admin')) return true;
    if (!departmentId || !has(u, 'nurse', 'doctor')) return false;
    return (await this.ipd.me(u)).department_id === departmentId;
  }
  private async location(departmentId: string, ex: Database | Trx = this.db) {
    return ex.selectFrom('stock_locations').select(['id', 'name']).where('department_id', '=', departmentId).where('is_active', '=', true)
      .where('kind', 'in', ['department', 'icu']).orderBy('sort_order').limit(1).executeTakeFirst();
  }
  /** განყოფილების ქვესაწყობში ჯენერიკის SKU-ები ნაშთით (ვადაგაუსვლელი, აქტიური ლოტები) */
  async stockFor(o: OrderCtx) {
    if (!o.generic_id || !o.department_id) return { location: null, items: [], qty_suggest: null };
    const loc = await this.location(o.department_id);
    if (!loc) return { location: null, items: [], qty_suggest: null };
    const items = await this.db.selectFrom('stock_items as i').innerJoin('stock_units as un', 'un.code', 'i.base_unit')
      .select(['i.id', 'i.name', 'i.code', 'un.name as unit_name',
        sql<string>`coalesce((SELECT sum(b.qty) FROM stock_balances b JOIN stock_lots lt ON lt.id = b.lot_id WHERE b.item_id = i.id AND b.location_id = ${loc.id}
          AND lt.status = 'active' AND (lt.expires_on IS NULL OR lt.expires_on >= (now() AT TIME ZONE ${TZ})::date)), 0)`.as('available')])
      .where('i.generic_id', '=', o.generic_id).where('i.is_active', '=', true).orderBy('i.name').execute();
    return { location: loc, items: items.map((i) => ({ ...i, available: Number(i.available) })), qty_suggest: this.qtyFor(o, o.dose ? Number(o.dose) : null) };
  }
  private qtyFor(o: OrderCtx, dose: number | null) {
    if (o.order_type === 'continuous') return 1;
    if (dose && o.dose_per_unit && o.dose_unit && o.dose_unit === o.g_dose_unit) return Math.max(1, Math.ceil(q3(dose / Number(o.dose_per_unit))));
    return 1;
  }

  // ================================================================= ჩანაწერი
  /** სლოტის ჩაწერა (გეგმიური / ერთჯერადი / მოვლის დავალება) */
  async document(entryId: string, dto: MarDocumentDto, u: AuthUser, ctx: AuditContext) {
    const e = await this.db.selectFrom('mar_entries').selectAll().where('id', '=', entryId).executeTakeFirst();
    if (!e || e.voided_at) throw new NotFoundException('MAR ჩანაწერი ვერ მოიძებნა');
    if (!['due', 'missed'].includes(e.status)) throw new ConflictException('ეს დოზა უკვე ჩაწერილია (შესწორება — გაუქმებით)');
    if (e.source === 'prn' || e.source === 'infusion') throw new BadRequestException('PRN / ინფუზია — ახალი ჩანაწერით');
    return this.record(await this.order(e.order_id), e, dto, u, ctx);
  }
  /** PRN / უწყვეტი ინფუზია — ჩანაწერი სლოტის გარეშე */
  async administer(orderId: string, dto: MarDocumentDto, u: AuthUser, ctx: AuditContext) {
    const o = await this.order(orderId);
    if (o.order_type !== 'prn' && o.order_type !== 'continuous') throw new BadRequestException('გეგმიური / ერთჯერადი დოზა იწერება განრიგის სლოტზე');
    if (o.order_type === 'continuous' && !dto.infusion_action) throw new BadRequestException('ინფუზია: მიუთითეთ მოქმედება (დაწყება / სიჩქარე / პარკი / შეჩერება / დასრულება)');
    return this.record(o, null, dto, u, ctx);
  }

  private async record(o: OrderCtx, slot: { id: string; scheduled_at: string | Date | null } | null, dto: MarDocumentDto, u: AuthUser, ctx: AuditContext) {
    const s = await this.settings();
    if (o.stay_status !== 'active') throw new ConflictException('ჰოსპიტალიზაცია აქტიური არ არის');
    if (!(await this.canDocument(u, o.department_id))) throw new ForbiddenException('MAR-ში წერს მიმდინარე განყოფილების ექთანი ან ექიმი');
    const now = Date.now();
    const at = dto.documented_at ? new Date(dto.documented_at) : new Date();
    if (at.getTime() > now + 5 * 60_000) throw new BadRequestException('დრო მომავალშია');
    if (at.getTime() < now - 24 * 3_600_000) throw new BadRequestException('24 სთ-ზე ძველი ჩანაწერი — მიმართეთ ხელმძღვანელს');
    const given = dto.outcome === 'given' || dto.outcome === 'partial';
    const med = o.category === 'medication';
    const infusion = o.order_type === 'continuous';
    if (!given && (dto.reason?.trim().length ?? 0) < 2) throw new BadRequestException('მიუთითეთ მიზეზი');
    if (dto.postponed_to && dto.outcome !== 'held') throw new BadRequestException('ახალი დრო — მხოლოდ გადადებისას');
    if (dto.postponed_to) {
      const p = new Date(dto.postponed_to).getTime();
      if (p <= now || p > now + 24 * 3_600_000) throw new BadRequestException('გადადება: მომავალი 24 სთ-ის ფარგლებში');
    }
    if (infusion && !dto.infusion_action) throw new BadRequestException('ინფუზია: მიუთითეთ მოქმედება');

    const checks: MarCheck[] = [];
    let timing: 'on_time' | 'early' | 'late' | null = null;
    let itemId: string | null = dto.item_id ?? null; let lotId: string | null = dto.lot_id ?? null;
    let scannedPatient = false; let scannedMed = false;
    let dose: number | null = null;
    if (given) {
      if (o.status !== 'active') throw new ConflictException(o.status === 'on_hold' ? 'დანიშნულება შეჩერებულია' : 'დანიშნულება აქტიური არ არის');
      if (o.on_leave) throw new ConflictException('პაციენტი დროებით გასულია');
      if (med) {
        if (o.verify_status === 'rejected') throw new UnprocessableEntityException({ code: 'MAR_BLOCKED', message: 'ფარმაცევტმა დანიშნულება უარყო — მიმართეთ ექიმს' });
        if (o.verify_status === 'pending') checks.push({ code: 'verify_pending', message: 'ფარმაცევტის ვერიფიკაცია ჯერ არ არის' });
        if (o.approval_status === 'pending') {
          const prev = await this.db.selectFrom('mar_entries').select('id').where('order_id', '=', o.id).where('status', 'in', ['given', 'partial']).where('voided_at', 'is', null).executeTakeFirst();
          if (prev) throw new UnprocessableEntityException({ code: 'MAR_BLOCKED', message: 'სარეზერვო ანტიბიოტიკი: დამტკიცებამდე მხოლოდ პირველი დოზა' });
          checks.push({ code: 'approval_pending', message: 'სარეზერვო ანტიბიოტიკი დამტკიცებული არ არის — პირველი დოზა' });
        }
        // შტრიხკოდი: სამაჯური + მედიკამენტი
        if (dto.scanned_patient !== undefined && s.mar_barcode !== 'off') {
          if (dto.scanned_patient.trim().toUpperCase() !== o.adm_no.toUpperCase()) throw new UnprocessableEntityException({ code: 'MAR_WRONG_PATIENT', message: `სამაჯური არ ემთხვევა (${dto.scanned_patient} ≠ ${o.adm_no})` });
          scannedPatient = true;
        }
        if (dto.scanned_barcode && s.mar_barcode !== 'off') {
          const p = parseBarcode(dto.scanned_barcode);
          const hit = await this.db.selectFrom('stock_item_barcodes as b').innerJoin('stock_items as i', 'i.id', 'b.item_id').select(['i.id', 'i.generic_id', 'i.name'])
            .where('b.barcode', '=', p.normalized).where('b.is_active', '=', true).executeTakeFirst();
          if (!hit) throw new UnprocessableEntityException({ code: 'MAR_UNKNOWN_BARCODE', message: 'შტრიხკოდი კატალოგში არ არის' });
          if (!o.generic_id || hit.generic_id !== o.generic_id) throw new UnprocessableEntityException({ code: 'MAR_WRONG_DRUG', message: `სხვა მედიკამენტი: ${hit.name}` });
          itemId = hit.id; scannedMed = true;
          if (p.lot) {
            const lot = await this.db.selectFrom('stock_lots').select('id').where('item_id', '=', hit.id).where('lot_no', '=', p.lot).executeTakeFirst();
            if (lot) lotId = lot.id;
          }
        }
        if (s.mar_barcode === 'required' && o.generic_id && (!scannedPatient || !scannedMed)) {
          throw new UnprocessableEntityException({ code: 'MAR_SCAN_REQUIRED', message: 'სავალდებულოა სამაჯურის და მედიკამენტის სკანირება' });
        }
        // დოზა
        if (!infusion) {
          dose = dto.dose ?? (o.dose ? Number(o.dose) : null);
          if (!dose) throw new BadRequestException('მიუთითეთ მიცემული დოზა');
          if (dto.outcome === 'given' && o.dose && dose > Number(o.dose) * 1.0001) checks.push({ code: 'dose_over', message: `დოზა (${dose}) დანიშნულზე (${Number(o.dose)}) მეტია` });
          if (dto.outcome === 'partial' && o.dose && dose >= Number(o.dose)) throw new BadRequestException('ნაწილობრივ — დოზა დანიშნულზე ნაკლები უნდა იყოს');
        }
        // PRN: ინტერვალი / დღიური მაქსიმუმი
        if (o.order_type === 'prn') {
          const prev = await this.db.selectFrom('mar_entries').select(['documented_at']).where('order_id', '=', o.id).where('status', 'in', ['given', 'partial'])
            .where('voided_at', 'is', null).where('documented_at', '>', new Date(at.getTime() - 24 * 3_600_000)).orderBy('documented_at', 'desc').execute();
          if (o.prn_max_per_day && prev.length >= o.prn_max_per_day) checks.push({ code: 'prn_max', message: `PRN: 24 სთ-ში უკვე ${prev.length} დოზა (მაქს. ${o.prn_max_per_day})` });
          if (o.prn_min_interval_h && prev[0]) {
            const h = (at.getTime() - new Date(prev[0].documented_at!).getTime()) / 3_600_000;
            if (h < Number(o.prn_min_interval_h)) checks.push({ code: 'prn_interval', message: `PRN: წინა დოზიდან ${Math.round(h * 10) / 10} სთ (მინ. ${Number(o.prn_min_interval_h)})` });
          }
        }
      }
      // დროის ფანჯარა (სლოტი)
      if (slot?.scheduled_at) {
        const diff = (at.getTime() - new Date(slot.scheduled_at).getTime()) / 60_000;
        timing = diff < -s.mar_window_min ? 'early' : diff > s.mar_window_min ? 'late' : 'on_time';
        if (timing !== 'on_time') checks.push({ code: `timing_${timing}`, message: `${timing === 'early' ? 'ადრე' : 'დაგვიანებით'}: ${Math.abs(Math.round(diff))} წთ (ფანჯარა ±${s.mar_window_min})` });
      }
    }

    // --- მარაგი
    const deduct = given && med && !!o.generic_id && s.mar_stock_deduct && (!infusion || dto.infusion_action === 'start' || dto.infusion_action === 'bag');
    let qty: number | null = null; let noStock = false; let locId: string | null = null;
    if (deduct) {
      const st = await this.stockFor(o);
      locId = st.location?.id ?? null;
      qty = dto.qty_base ?? this.qtyFor(o, dose);
      if (!itemId) {
        const withStock = st.items.filter((i) => i.available >= qty!);
        if (withStock.length === 1) itemId = withStock[0].id;
        else if (withStock.length > 1) throw new ConflictException({ code: 'MAR_ITEM_REQUIRED', message: 'აირჩიეთ საქონელი (რამდენიმე SKU)', items: st.items, qty_suggest: qty });
      }
      const avail = st.items.find((i) => i.id === itemId)?.available ?? 0;
      if (!locId || !itemId || avail < qty) {
        const msg = !locId ? 'განყოფილებას ქვესაწყობი არ აქვს' : !itemId ? 'ქვესაწყობში ამ მედიკამენტის ნაშთი არ არის' : `ნაშთი არასაკმარისია (${avail} < ${qty})`;
        if (!s.mar_allow_no_stock) throw new ConflictException({ code: 'MAR_NO_STOCK', message: `${msg} — მიცემა შეუძლებელია (მოითხოვეთ აფთიაქიდან)`, items: st.items });
        checks.push({ code: 'no_stock', message: `${msg} — მიცემა ჩამოწერის გარეშე` });
        noStock = true;
      }
    }
    if (checks.length && !dto.override_reason?.trim()) {
      throw new ConflictException({ code: 'MAR_CHECKS', message: 'საჭიროა დასაბუთება', checks });
    }
    // --- მეორე ექთანი (high-alert)
    let dbl: { id: string } | null = null;
    if (given && med && o.high_alert && s.mar_double_check) {
      if (!dto.double_check) throw new UnprocessableEntityException({ code: 'MAR_DOUBLE_CHECK', message: 'მაღალი რისკის მედიკამენტი — საჭიროა მეორე ექთნის დადასტურება' });
      dbl = await this.wit.verify(dto.double_check, u, ctx, 'mar_double_check');
    }

    const values = {
      status: dto.outcome, documented_at: at, documented_by: u.id, recorded_at: new Date(),
      dose_given: given && dose !== null ? String(dose) : null, dose_unit: given ? o.dose_unit : null, route_code: given ? (dto.route_code ?? o.route_code) : null,
      site: dto.site?.trim() || null, timing, reason: dto.reason?.trim() || null, postponed_to: dto.postponed_to ? new Date(dto.postponed_to) : null,
      rate_ml_h: infusion ? String(dto.rate_ml_h ?? o.rate_ml_h) : null, no_stock: noStock, double_check_by: dbl?.id ?? null,
      scanned_patient: scannedPatient, scanned_med: scannedMed, override_reason: checks.length ? dto.override_reason!.trim() : null, warnings: JSON.stringify(checks),
    };
    let entryId = slot?.id ?? '';
    const write = async (trx: Trx, docId: string | null) => {
      const witness = docId ? (await trx.selectFrom('stock_docs').select('witness_id').where('id', '=', docId).executeTakeFirstOrThrow()).witness_id : null;
      const v = { ...values, stock_doc_id: docId, stock_item_id: docId ? itemId : null, qty_base: docId ? String(qty) : null, witness_id: witness };
      if (slot) {
        const r = await trx.updateTable('mar_entries').set(v).where('id', '=', slot.id).where('status', 'in', ['due', 'missed']).where('voided_at', 'is', null).returning('id').executeTakeFirst();
        if (!r) throw new ConflictException('ეს დოზა უკვე ჩაწერილია');
      } else {
        entryId = (await trx.insertInto('mar_entries').values({ ...v, order_id: o.id, encounter_id: o.encounter_id, patient_id: o.patient_id, scheduled_at: null,
          source: infusion ? 'infusion' : 'prn', infusion_action: infusion ? dto.infusion_action! : null }).returning('id').executeTakeFirstOrThrow()).id;
      }
      if (dto.outcome === 'held' && dto.postponed_to) {
        await sql`INSERT INTO mar_entries (order_id, encounter_id, patient_id, scheduled_at, source, status)
          VALUES (${o.id}, ${o.encounter_id}, ${o.patient_id}, ${new Date(dto.postponed_to)}, 'postponed', 'due')
          ON CONFLICT (order_id, scheduled_at) WHERE voided_at IS NULL AND scheduled_at IS NOT NULL DO NOTHING`.execute(trx);
      }
      await trx.insertInto('med_order_events').values({ order_id: o.id, kind: 'administered', data: JSON.stringify({ entry_id: entryId, outcome: dto.outcome, dose, action: dto.infusion_action ?? null }), user_id: u.id }).execute();
      // ერთჯერადი — მიცემისას სრულდება
      if (given && o.order_type === 'once') {
        await trx.updateTable('med_orders').set({ status: 'completed', stopped_at: sql`now()` }).where('id', '=', o.id).where('status', '=', 'active').execute();
        await trx.insertInto('med_order_events').values({ order_id: o.id, kind: 'completed', data: JSON.stringify({ by: 'mar' }), user_id: u.id }).execute();
      }
      if (infusion && dto.infusion_action === 'stop') {
        await trx.updateTable('med_orders').set({ status: 'completed', stopped_at: sql`now()` }).where('id', '=', o.id).where('status', '=', 'active').execute();
        await trx.insertInto('med_order_events').values({ order_id: o.id, kind: 'completed', data: JSON.stringify({ by: 'infusion_stop' }), user_id: u.id }).execute();
      }
      await this.audit.log(ctx, { action: 'MAR_DOCUMENT', entityName: 'mar_entries', entityId: entryId,
        newData: { order_id: o.id, outcome: dto.outcome, dose, at, timing, stock_doc_id: docId, no_stock: noStock, checks, override: values.override_reason, double_check: dbl?.id ?? null } }, trx);
    };

    if (deduct && !noStock) {
      const controlled = !!o.controlled_class;
      const dpu = o.dose_per_unit ? Number(o.dose_per_unit) : null;
      await this.ops.createConsumption({
        location_id: locId!, patient_id: o.patient_id, encounter_id: o.encounter_id, notes: `MAR: ${o.inn ?? ''} ${o.adm_no}`, witness: dto.witness ?? null,
        lines: [{ item_id: itemId!, qty_base: qty!, lot_id: lotId,
          ...(controlled && dose !== null && { dose_given: dose, dose_wasted: dpu && o.dose_unit === o.g_dose_unit ? Math.max(0, q3(qty! * dpu - dose)) : 0 }) }],
      }, u, ctx, (trx, docId) => write(trx, docId));
    } else {
      await this.db.transaction().execute((trx) => write(trx, null));
    }
    return this.entry(entryId);
  }

  async void(entryId: string, reason: string, u: AuthUser, ctx: AuditContext) {
    const e = await this.db.selectFrom('mar_entries').selectAll().where('id', '=', entryId).executeTakeFirst();
    if (!e || e.voided_at) throw new NotFoundException('MAR ჩანაწერი ვერ მოიძებნა');
    if (['due', 'missed', 'cancelled'].includes(e.status)) throw new ConflictException('გასაუქმებელი ჩანაწერი არ არის');
    const o = await this.order(e.order_id);
    if (!(await this.canDocument(u, o.department_id)) && e.documented_by !== u.id) throw new ForbiddenException('აუქმებს განყოფილების ექთანი / ექიმი');
    if (Date.now() - new Date(e.recorded_at ?? e.created_at).getTime() > 24 * 3_600_000 && !has(u, 'admin')) throw new ConflictException('24 სთ-ზე ძველი ჩანაწერი — მიმართეთ admin-ს');
    const write = async (trx: Trx, revId: string | null) => {
      await trx.updateTable('mar_entries').set({ voided_at: sql`now()`, voided_by: u.id, void_reason: reason.trim(), void_stock_doc_id: revId }).where('id', '=', entryId).execute();
      if (e.scheduled_at && o.status === 'active') {
        await sql`INSERT INTO mar_entries (order_id, encounter_id, patient_id, scheduled_at, source, status)
          VALUES (${e.order_id}, ${e.encounter_id}, ${e.patient_id}, ${e.scheduled_at}, ${e.source}, 'due')
          ON CONFLICT (order_id, scheduled_at) WHERE voided_at IS NULL AND scheduled_at IS NOT NULL DO NOTHING`.execute(trx);
      }
      if (e.postponed_to) {
        await trx.updateTable('mar_entries').set({ status: 'cancelled' }).where('order_id', '=', e.order_id).where('scheduled_at', '=', e.postponed_to)
          .where('source', '=', 'postponed').where('status', '=', 'due').where('voided_at', 'is', null).execute();
      }
      await this.audit.log(ctx, { action: 'MAR_VOID', entityName: 'mar_entries', entityId: entryId, newData: { reason, reversal: revId } }, trx);
    };
    if (e.stock_doc_id) await this.docs.reverse(e.stock_doc_id, `MAR გაუქმება: ${reason.trim()}`, u, ctx, (trx, rid) => write(trx, rid));
    else await this.db.transaction().execute((trx) => write(trx, null));
    return this.entry(entryId);
  }

  // ================================================================= წაკითხვა
  private base() {
    return this.db.selectFrom('mar_entries as m').leftJoin('users as du', 'du.id', 'm.documented_by').leftJoin('users as wu', 'wu.id', 'm.witness_id')
      .leftJoin('users as dc', 'dc.id', 'm.double_check_by').leftJoin('users as vu', 'vu.id', 'm.voided_by').leftJoin('stock_docs as sd', 'sd.id', 'm.stock_doc_id')
      .leftJoin('stock_items as si', 'si.id', 'm.stock_item_id')
      .selectAll('m').select(['sd.doc_no as stock_doc_no', 'si.name as stock_item_name',
        sql<string | null>`du.last_name || ' ' || du.first_name`.as('documented_by_name'), sql<string | null>`wu.last_name || ' ' || wu.first_name`.as('witness_name'),
        sql<string | null>`dc.last_name || ' ' || dc.first_name`.as('double_check_name'), sql<string | null>`vu.last_name || ' ' || vu.first_name`.as('voided_by_name')]);
  }
  entry(id: string) { return this.base().where('m.id', '=', id).executeTakeFirstOrThrow(); }

  private ordersSel() {
    return this.db.selectFrom('med_orders as o').leftJoin('med_generics as g', 'g.id', 'o.generic_id').leftJoin('med_dosage_forms as f', 'f.code', 'g.form_code')
      .leftJoin('med_routes as r', 'r.code', 'o.route_code').leftJoin('med_frequencies as fq', 'fq.code', 'o.frequency_code')
      .select(['o.id', 'o.encounter_id', 'o.category', 'o.order_type', 'o.dose', 'o.dose_unit', 'o.route_code', 'o.status', 'o.verify_status', 'o.approval_status', 'o.prn_reason',
        'o.prn_max_per_day', 'o.prn_min_interval_h', 'o.rate_ml_h', 'o.instructions', 'o.start_at', 'o.end_at', 'g.high_alert', 'g.controlled_class', 'r.name as route_name',
        'fq.name as frequency_name', 'o.generic_id',
        sql<string>`CASE WHEN o.category = 'medication' THEN coalesce(g.inn || coalesce(' ' || g.strength, '') || coalesce(', ' || f.name, ''), o.drug_text) ELSE o.text END`.as('title'),
        sql<string | null>`(SELECT max(m.documented_at) FROM mar_entries m WHERE m.order_id = o.id AND m.status IN ('given', 'partial') AND m.voided_at IS NULL)`.as('last_given_at'),
        sql<string | null>`(SELECT m.infusion_action FROM mar_entries m WHERE m.order_id = o.id AND m.source = 'infusion' AND m.voided_at IS NULL ORDER BY m.documented_at DESC LIMIT 1)`.as('infusion_state')]);
  }

  /** განყოფილება: ვადაგადაცილებული / ახლა / მომდევნო N სთ + PRN / ინფუზიები (ექთნის ეკრანი) */
  async department(departmentId: string, hours: number, u: AuthUser) {
    const s = await this.settings();
    await ensureMarSlots(this.db, TZ, s, { departmentId });
    const pts = await this.db.selectFrom('bed_assignments as a').innerJoin('inpatient_stays as st', 'st.encounter_id', 'a.encounter_id').innerJoin('patients as p', 'p.id', 'st.patient_id')
      .leftJoin('beds as b', 'b.id', 'a.bed_id')
      .select(['st.encounter_id', 'st.adm_no', 'p.first_name', 'p.last_name', 'p.birth_date', 'p.gender', 'b.code as bed_code',
        sql<number>`(SELECT count(*)::int FROM patient_allergies pa WHERE pa.patient_id = p.id AND pa.is_active)`.as('allergies'),
        sql<boolean>`EXISTS (SELECT 1 FROM inpatient_leaves l WHERE l.encounter_id = st.encounter_id AND l.returned_at IS NULL)`.as('on_leave')])
      .where('a.department_id', '=', departmentId).where('a.ended_at', 'is', null).where('st.status', '=', 'active').orderBy('b.code').orderBy('p.last_name').execute();
    const ids = pts.map((p) => p.encounter_id);
    const entries = ids.length ? await this.base().innerJoin('med_orders as o', 'o.id', 'm.order_id')
      .where('m.encounter_id', 'in', ids).where('m.voided_at', 'is', null)
      .where((eb) => eb.or([
        eb.and([eb('m.status', '=', 'due'), eb('m.scheduled_at', '<=', sql<Date>`now() + make_interval(hours => ${hours})`)]),
        eb.and([eb('m.status', '=', 'missed'), eb('m.scheduled_at', '>', sql<Date>`now() - interval '24 hours'`)]),
      ])).orderBy('m.scheduled_at').execute() : [];
    const orders = ids.length ? await this.ordersSel().where('o.encounter_id', 'in', ids).where('o.status', 'in', ['active', 'on_hold']).execute() : [];
    return {
      window_min: s.mar_window_min, can_document: await this.canDocument(u, departmentId), barcode: s.mar_barcode, double_check: s.mar_double_check,
      patients: pts.map((p) => ({ ...p, entries: entries.filter((e) => e.encounter_id === p.encounter_id),
        prn: orders.filter((o) => o.encounter_id === p.encounter_id && o.order_type === 'prn' && o.status === 'active'),
        infusions: orders.filter((o) => o.encounter_id === p.encounter_id && o.order_type === 'continuous' && o.status === 'active') })),
      orders,
    };
  }

  /** ჰოსპიტალიზაცია: 24 სთ-ის ბადე (დღე — კლინიკის დროით) */
  async stay(encounterId: string, day: string | undefined, u: AuthUser) {
    const s = await this.settings();
    await ensureMarSlots(this.db, TZ, s, { encounterId });
    const st = await this.db.selectFrom('inpatient_stays').select(['encounter_id', 'status']).where('encounter_id', '=', encounterId).executeTakeFirst();
    if (!st) throw new NotFoundException('ჰოსპიტალიზაცია ვერ მოიძებნა');
    const d = day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : (await sql<{ d: string }>`SELECT to_char(now() AT TIME ZONE ${TZ}, 'YYYY-MM-DD') AS d`.execute(this.db)).rows[0].d;
    const from = sql<Date>`(${d}::date::timestamp AT TIME ZONE ${TZ})`; const to = sql<Date>`((${d}::date + 1)::timestamp AT TIME ZONE ${TZ})`;
    const entries = await this.base().where('m.encounter_id', '=', encounterId)
      .where((eb) => eb.or([eb.and([eb('m.scheduled_at', '>=', from), eb('m.scheduled_at', '<', to)]),
        eb.and([eb('m.scheduled_at', 'is', null), eb('m.documented_at', '>=', from), eb('m.documented_at', '<', to)])]))
      .orderBy(sql`coalesce(m.scheduled_at, m.documented_at)`).execute();
    const used = [...new Set(entries.map((e) => e.order_id))];
    const orders = await this.ordersSel().where('o.encounter_id', '=', encounterId)
      .where((eb) => eb.or([eb('o.status', 'in', ['active', 'on_hold']), ...(used.length ? [eb('o.id', 'in', used)] : [])]))
      .where((eb) => eb.or([eb('o.category', '=', 'medication'), eb('o.frequency_code', 'is not', null)])).orderBy('o.category').orderBy('o.created_at').execute();
    const dep = (await this.db.selectFrom('bed_assignments').select('department_id').where('encounter_id', '=', encounterId).where('ended_at', 'is', null).executeTakeFirst())?.department_id ?? null;
    return { day: d, window_min: s.mar_window_min, can_document: st.status === 'active' && await this.canDocument(u, dep), barcode: s.mar_barcode, double_check: s.mar_double_check, orders, entries };
  }

  async orderStock(orderId: string) { return this.stockFor(await this.order(orderId)); }

  /** გაწერის გაფრთხილება (0041 hook): ბოლო 24 სთ-ის გამოტოვებული / ვადაგადაცილებული დოზები */
  async missedFor(encounterId: string, ex: Database | Trx = this.db) {
    const s = await this.settings();
    const r = await ex.selectFrom('mar_entries').select(sql<number>`count(*)::int`.as('n')).where('encounter_id', '=', encounterId).where('voided_at', 'is', null)
      .where((eb) => eb.or([eb('status', '=', 'missed'), eb.and([eb('status', '=', 'due'), eb('scheduled_at', '<', sql<Date>`now() - make_interval(mins => ${s.mar_window_min})`)])]))
      .where('scheduled_at', '>', sql<Date>`now() - interval '24 hours'`).executeTakeFirstOrThrow();
    return r.n;
  }
}

const READ = ['admin', 'doctor', 'nurse', 'manager', 'pharmacist'] as const;

@Controller('inpatient')
export class MarController {
  constructor(private readonly s: MarService) {}
  @Get('departments/:id/mar') @Roles(...READ)
  dep(@Param('id', ParseUUIDPipe) id: string, @Query('hours') hours: string | undefined, @CurrentUser() u: AuthUser) {
    const h = Math.min(24, Math.max(1, Number(hours) || 4)); return this.s.department(id, h, u);
  }
  @Get('stays/:eid/mar') @Roles(...READ) stay(@Param('eid', ParseUUIDPipe) eid: string, @Query('day') day: string | undefined, @CurrentUser() u: AuthUser) { return this.s.stay(eid, day, u); }
  @Get('orders/:id/stock') @Roles(...READ) stock(@Param('id', ParseUUIDPipe) id: string) { return this.s.orderStock(id); }
  @Post('mar/:id/document') @HttpCode(200) @Roles('admin', 'nurse', 'doctor')
  doc(@Param('id', ParseUUIDPipe) id: string, @Body() d: MarDocumentDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.document(id, d, u, auditCtx(r)); }
  @Post('orders/:id/administer') @Roles('admin', 'nurse', 'doctor')
  adm(@Param('id', ParseUUIDPipe) id: string, @Body() d: MarDocumentDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.administer(id, d, u, auditCtx(r)); }
  @Post('mar/:id/void') @HttpCode(200) @Roles('admin', 'nurse', 'doctor')
  void(@Param('id', ParseUUIDPipe) id: string, @Body() d: MarVoidDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.void(id, d.reason, u, auditCtx(r)); }
}

@Module({ imports: [InpatientModule, StockModule], providers: [MarService], controllers: [MarController], exports: [MarService] })
export class MarModule {}

export type { InpatientSettings };
