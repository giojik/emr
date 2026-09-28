import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res,
  StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsEmail, IsOptional, IsString, IsUUID, Length, Matches, MaxLength } from 'class-validator';
import type { Request, Response } from 'express';
import { sql } from 'kysely';
import { memoryStorage } from 'multer';
import { randomUUID } from 'node:crypto';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { auditCtx } from '../audit/audit-context';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser } from '../auth/roles';
import { loadEnv } from '../config/env';
import { InjectDb, type Database } from '../database/database.module';
import { sniffMime } from '../patient-files/patient-files';
import { ClinicSettingsService } from '../settings/clinic-settings';
import { StorageService } from '../storage/storage.service';
import { d, dt, newDoc } from './diagnostics.pdf';

const MAX_FILE = 15 * 1024 * 1024;
const LAB_STAFF = ['admin', 'diagnostic', 'lab_doctor', 'lab_manager'] as const;

// ======================================================================= გარე ლაბორატორია
@Injectable()
export class LabExternalService {
  private readonly tz = loadEnv().CLINIC_TZ;
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService, private readonly storage: StorageService, private readonly clinic: ClinicSettingsService) {}

  // ---- რეესტრი
  labs(all = false) {
    let q = this.db.selectFrom('lab_external_labs as l').selectAll('l')
      .select((eb) => eb.selectFrom('dx_services as s').select((e) => e.fn.countAll<number>().as('n')).whereRef('s.external_lab_id', '=', 'l.id').where('s.is_active', '=', true).as('services'))
      .orderBy('l.is_active', 'desc').orderBy('l.name');
    if (!all) q = q.where('l.is_active', '=', true);
    return q.execute();
  }
  async saveLab(id: string | null, dto: { name?: string; contact_person?: string | null; phone?: string | null; email?: string | null; note?: string | null; is_active?: boolean }, ctx: AuditContext) {
    const vals = Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined).map(([k, v]) => [k, typeof v === 'string' ? v.trim() || null : v]));
    try {
      if (id) {
        const r = await this.db.updateTable('lab_external_labs').set(vals).where('id', '=', id).returningAll().executeTakeFirst();
        if (!r) throw new NotFoundException('ლაბორატორია ვერ მოიძებნა');
        if (vals.name) await this.db.updateTable('dx_services').set({ external_lab: String(vals.name) }).where('external_lab_id', '=', id).execute();
        await this.audit.log(ctx, { action: 'UPDATE_EXTERNAL_LAB', entityName: 'lab_external_labs', entityId: id, newData: vals });
        return r;
      }
      if (!dto.name?.trim()) throw new BadRequestException('მიუთითეთ დასახელება');
      const r = await this.db.insertInto('lab_external_labs').values({ ...vals, name: dto.name.trim() }).returningAll().executeTakeFirstOrThrow();
      await this.audit.log(ctx, { action: 'CREATE_EXTERNAL_LAB', entityName: 'lab_external_labs', entityId: r.id, newData: vals });
      return r;
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new ConflictException('ასეთი დასახელებით ლაბორატორია უკვე არსებობს');
      throw e;
    }
  }

  private items() {
    return this.db.selectFrom('dx_order_items as i').innerJoin('dx_services as s', 's.id', 'i.service_id').innerJoin('patients as p', 'p.id', 'i.patient_id')
      .leftJoin('lab_specimens as sp', 'sp.id', 'i.specimen_id').leftJoin('lab_external_labs as l', (j) => j.on(sql<boolean>`l.id = coalesce(i.ext_lab_id, s.external_lab_id)`))
      .leftJoin('lab_ext_shipments as sh', 'sh.id', 'i.ext_shipment_id')
      .select(['i.id', 'i.status', 'i.priority', 'i.encounter_id', 'i.ext_shipment_id', 'i.ext_cost', 'i.ext_due_at', 'i.ext_result_at', 'i.ext_result_name', 'i.validated_at',
        's.name as service_name', 's.code as service_code', 's.specimen_type', 's.container', 's.purchase_price', 's.ext_turnaround_days',
        'p.id as patient_id', 'p.first_name', 'p.last_name', 'p.birth_date', 'p.gender', 'p.personal_number',
        'sp.barcode', 'sp.collected_at', 'sp.status as specimen_status', 'l.id as lab_id', 'l.name as lab_name', 'sh.shipment_no', 'sh.sent_at',
        sql<boolean>`i.ext_due_at < now() AND i.ext_result_at IS NULL`.as('overdue')])
      .where('i.section', '=', 'lab').where('s.performed_by', '=', 'external');
  }
  /** გასაგზავნი: აღებული, ჯერ არ გაგზავნილი */
  toSend() {
    return this.items().where('i.ext_shipment_id', 'is', null).where('i.status', 'in', ['collected', 'in_progress'])
      .where('sp.status', 'in', ['collected', 'received']).orderBy('l.name').orderBy('sp.collected_at').execute();
  }
  /** გაგზავნილი, პასუხს ელოდება (ვადაგადაცილებული — ზემოთ) */
  waiting(labId?: string) {
    let q = this.items().where('i.ext_shipment_id', 'is not', null).where('i.ext_result_at', 'is', null).where('i.status', '<>', 'cancelled');
    if (labId) q = q.where('i.ext_lab_id', '=', labId);
    return q.orderBy('i.ext_due_at').execute();
  }
  shipments(limit = 50) {
    return this.db.selectFrom('lab_ext_shipments as sh').innerJoin('lab_external_labs as l', 'l.id', 'sh.lab_id').leftJoin('users as u', 'u.id', 'sh.sent_by')
      .select(['sh.id', 'sh.shipment_no', 'sh.sent_at', 'sh.courier', 'sh.note', 'l.name as lab_name', sql<string>`u.first_name || ' ' || u.last_name`.as('sent_by_name'),
        (eb) => eb.selectFrom('dx_order_items as i').select((e) => e.fn.countAll<number>().as('n')).whereRef('i.ext_shipment_id', '=', 'sh.id').as('items'),
        (eb) => eb.selectFrom('dx_order_items as i').select((e) => e.fn.countAll<number>().as('n')).whereRef('i.ext_shipment_id', '=', 'sh.id').where('i.ext_result_at', 'is not', null).as('resulted')])
      .orderBy('sh.sent_at', 'desc').limit(limit).execute();
  }

  async ship(dto: { lab_id: string; item_ids: string[]; courier?: string; note?: string }, user: AuthUser, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const lab = await trx.selectFrom('lab_external_labs').select(['id', 'name', 'is_active']).where('id', '=', dto.lab_id).executeTakeFirst();
      if (!lab?.is_active) throw new BadRequestException('ლაბორატორია ვერ მოიძებნა ან გათიშულია');
      const rows = await trx.selectFrom('dx_order_items as i').innerJoin('dx_services as s', 's.id', 'i.service_id').leftJoin('lab_specimens as sp', 'sp.id', 'i.specimen_id')
        .select(['i.id', 'i.status', 'i.ext_shipment_id', 's.performed_by', 's.external_lab_id', 's.purchase_price', 's.ext_turnaround_days', 's.name', 'sp.status as sp_status'])
        .where('i.id', 'in', dto.item_ids).forUpdate(['i']).execute();
      if (rows.length !== new Set(dto.item_ids).size) throw new BadRequestException('ზოგიერთი ანალიზი ვერ მოიძებნა');
      for (const r of rows) {
        if (r.performed_by !== 'external') throw new BadRequestException(`${r.name}: შიდა ანალიზია`);
        if (r.ext_shipment_id) throw new ConflictException(`${r.name}: უკვე გაგზავნილია`);
        if (!['collected', 'in_progress'].includes(r.status) || !['collected', 'received'].includes(r.sp_status ?? '')) throw new ConflictException(`${r.name}: სინჯარა არ არის აღებული ან უარყოფილია`);
        if (r.external_lab_id && r.external_lab_id !== lab.id) throw new BadRequestException(`${r.name}: კატალოგში სხვა ლაბორატორიაა მითითებული`);
      }
      const seq = await sql<{ n: string }>`SELECT nextval('lab_ext_shipment_seq')::text AS n`.execute(trx);
      const yy = new Intl.DateTimeFormat('en-GB', { timeZone: this.tz, year: '2-digit' }).format(new Date());
      const sh = await trx.insertInto('lab_ext_shipments').values({ shipment_no: `EX${yy}-${seq.rows[0].n.padStart(6, '0')}`, lab_id: lab.id, courier: dto.courier?.trim() || null,
        note: dto.note?.trim() || null, sent_by: user.id }).returningAll().executeTakeFirstOrThrow();
      for (const r of rows) {
        await trx.updateTable('dx_order_items').set({ ext_shipment_id: sh.id, ext_lab_id: lab.id, ext_cost: r.purchase_price, status: 'in_progress',
          ext_due_at: sql`now() + make_interval(days => ${r.ext_turnaround_days})` }).where('id', '=', r.id).execute();
      }
      await this.audit.log(ctx, { action: 'EXTERNAL_LAB_SHIP', entityName: 'lab_ext_shipments', entityId: sh.id, newData: { lab: lab.name, items: dto.item_ids } }, trx);
      return sh;
    });
  }

  /** გადაცემის აქტი (PDF) */
  async shipmentPdf(id: string) {
    const sh = await this.db.selectFrom('lab_ext_shipments as sh').innerJoin('lab_external_labs as l', 'l.id', 'sh.lab_id').leftJoin('users as u', 'u.id', 'sh.sent_by')
      .select(['sh.shipment_no', 'sh.sent_at', 'sh.courier', 'sh.note', 'l.name as lab_name', sql<string>`u.first_name || ' ' || u.last_name`.as('sent_by_name')]).where('sh.id', '=', id).executeTakeFirst();
    if (!sh) throw new NotFoundException('გაგზავნა ვერ მოიძებნა');
    const items = await this.items().where('i.ext_shipment_id', '=', id).orderBy('sp.barcode').execute();
    let clinicName = ''; try { clinicName = (await this.clinic.get()).name; } catch { /* რეკვიზიტები ჯერ არ არის */ }
    const { doc, done } = newDoc('A4', 40);
    doc.addPage();
    doc.font('B').fontSize(13).text(clinicName, { align: 'left' });
    doc.font('B').fontSize(15).text(`სინჯების გადაცემის აქტი № ${sh.shipment_no}`, { align: 'center' }).moveDown(0.3);
    doc.font('R').fontSize(10).text(`მიმღები: ${sh.lab_name}    თარიღი: ${dt(sh.sent_at)}${sh.courier ? `    კურიერი: ${sh.courier}` : ''}`, { align: 'center' }).moveDown(0.8);
    const cols = [28, 70, 150, 70, 20, 130, 60]; const heads = ['№', 'შტრიხკოდი', 'პაციენტი', 'დაბ. თარ.', 'სქ.', 'ანალიზი', 'მასალა'];
    const L = 40; let y = doc.y;
    const row = (vals: string[], bold = false) => {
      doc.font(bold ? 'B' : 'R').fontSize(8.5);
      const h = Math.max(...vals.map((v, i) => doc.heightOfString(v, { width: cols[i] - 4 }))) + 5;
      if (y + h > 780) { doc.addPage(); y = 40; }   // A4
      let x = L; vals.forEach((v, i) => { doc.text(v, x + 2, y + 2, { width: cols[i] - 4 }); x += cols[i]; });
      y += h; doc.moveTo(L, y).lineTo(L + cols.reduce((a, b) => a + b, 0), y).lineWidth(0.4).strokeColor('#bbb').stroke();
    };
    row(heads, true);
    items.forEach((it, n) => row([String(n + 1), it.barcode ?? '', `${it.last_name} ${it.first_name}${it.personal_number ? `\n${it.personal_number}` : ''}`, d(it.birth_date),
      it.gender === 'male' ? 'მ' : it.gender === 'female' ? 'მდ' : '', it.service_name, [it.specimen_type, it.container].filter(Boolean).join(', ')]));
    y += 14; doc.font('R').fontSize(10).text(`სულ: ${items.length} სინჯი${sh.note ? ` · ${sh.note}` : ''}`, L, y); y = doc.y + 40;
    doc.text(`გადასცა: ${sh.sent_by_name ?? ''}  ____________________`, L, y); doc.text('ჩაიბარა: ____________________  ____________________', L + 280, y);
    doc.fontSize(8).fillColor('#777').text('(სახელი, გვარი, ხელმოწერა, დრო)', L + 280, doc.y + 2);
    doc.end();
    return done;
  }

  /** პასუხი: PDF (ან სკანი JPG/PNG) → კონკრეტულ ანალიზს; სტატუსი „ვალიდაციას ელოდება“. ვალიდირებულზე — ჯერ შესწორება. */
  async attachResult(itemId: string, file: Buffer | undefined, name: string | undefined, user: AuthUser, ctx: AuditContext) {
    if (!file?.length) throw new BadRequestException('ატვირთეთ ფაილი');
    const mime = sniffMime(file);
    if (!mime) throw new BadRequestException('ფაილი: PDF, JPG ან PNG');
    const it = await this.db.selectFrom('dx_order_items as i').innerJoin('dx_services as s', 's.id', 'i.service_id').select(['i.id', 'i.status', 'i.patient_id', 'i.ext_shipment_id', 's.performed_by'])
      .where('i.id', '=', itemId).executeTakeFirst();
    if (!it || it.performed_by !== 'external') throw new NotFoundException('გარე ლაბორატორიის ანალიზი ვერ მოიძებნა');
    if (!it.ext_shipment_id) throw new ConflictException('ანალიზი ჯერ არ გაგზავნილა');
    if (!['in_progress', 'resulted'].includes(it.status)) throw new ConflictException(it.status === 'validated' ? 'შედეგი დადასტურებულია — შეცვლა მხოლოდ შესწორებით' : `სტატუსზე "${it.status}" დაუშვებელია`);
    const key = `lab-external/${it.patient_id}/${itemId}/${randomUUID()}.${mime === 'application/pdf' ? 'pdf' : mime === 'image/png' ? 'png' : 'jpg'}`;
    await this.storage.put(key, file, mime);
    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable('dx_order_items').set({ ext_result_path: key, ext_result_name: name?.slice(0, 200) ?? null, ext_result_at: sql`now()`, ext_result_by: user.id,
        status: 'resulted', resulted_by: user.id, resulted_at: sql`now()` }).where('id', '=', itemId).execute();
      await this.audit.log(ctx, { action: 'EXTERNAL_LAB_RESULT', entityName: 'dx_order_items', entityId: itemId, newData: { file: name ?? null, bytes: file.length, replaced: it.status === 'resulted' } }, trx);
    });
    return { id: itemId, status: 'resulted' };
  }
  /** ფაილი: ლაბორატორია — ყოველთვის; ექიმი/ექთანი — მხოლოდ ვალიდაციის შემდეგ */
  async resultFile(itemId: string, user: AuthUser) {
    const it = await this.db.selectFrom('dx_order_items').select(['ext_result_path', 'status']).where('id', '=', itemId).executeTakeFirst();
    if (!it?.ext_result_path) throw new NotFoundException('პასუხის ფაილი არ არის');
    const lab = LAB_STAFF.some((r) => has(user, r));
    if (!lab && it.status !== 'validated') throw new ForbiddenException('პასუხი ჯერ არ არის დადასტურებული');
    const mime = it.ext_result_path.endsWith('.pdf') ? 'application/pdf' : it.ext_result_path.endsWith('.png') ? 'image/png' : 'image/jpeg';
    return { stream: await this.storage.get(it.ext_result_path), mime };
  }

  // ---- ანგარიშსწორება
  async settlement(month: string) {
    const start = `${month}-01`;
    const rows = await this.db.selectFrom('dx_order_items as i').innerJoin('lab_ext_shipments as sh', 'sh.id', 'i.ext_shipment_id').innerJoin('lab_external_labs as l', 'l.id', 'sh.lab_id')
      .select(['l.id as lab_id', 'l.name as lab_name', (e) => e.fn.countAll<number>().as('items'), sql<string>`coalesce(sum(i.ext_cost), 0)`.as('amount'),
        sql<number>`count(*) FILTER (WHERE i.ext_cost IS NULL)`.as('no_price'), sql<number>`count(*) FILTER (WHERE i.ext_result_at IS NULL)`.as('no_result')])
      .where('i.status', '<>', 'cancelled')
      .where(sql<boolean>`(sh.sent_at AT TIME ZONE ${this.tz}) >= ${start}::date AND (sh.sent_at AT TIME ZONE ${this.tz}) < (${start}::date + interval '1 month')`)
      .groupBy(['l.id', 'l.name']).orderBy('l.name').execute();
    const recorded = await this.db.selectFrom('lab_ext_settlements').selectAll().where('period', '=', start).execute();
    return rows.map((r) => ({ ...r, settlement: recorded.find((s) => s.lab_id === r.lab_id) ?? null }));
  }
  settlementItems(labId: string, month: string) {
    const start = `${month}-01`;
    return this.items().where('i.ext_lab_id', '=', labId).where('i.status', '<>', 'cancelled')
      .where(sql<boolean>`(sh.sent_at AT TIME ZONE ${this.tz}) >= ${start}::date AND (sh.sent_at AT TIME ZONE ${this.tz}) < (${start}::date + interval '1 month')`)
      .orderBy('sh.sent_at').execute();
  }
  async recordSettlement(dto: { lab_id: string; month: string; invoice_no?: string; note?: string; paid_at?: string | null }, user: AuthUser, ctx: AuditContext) {
    const s = (await this.settlement(dto.month)).find((r) => r.lab_id === dto.lab_id);
    if (!s) throw new BadRequestException('ამ თვეში ამ ლაბორატორიაში გაგზავნა არ ყოფილა');
    const vals = { items_count: Number(s.items), amount: String(s.amount), invoice_no: dto.invoice_no?.trim() || null, note: dto.note?.trim() || null,
      paid_at: dto.paid_at || null, created_by: user.id };
    const r = await this.db.insertInto('lab_ext_settlements').values({ lab_id: dto.lab_id, period: `${dto.month}-01`, ...vals })
      .onConflict((oc) => oc.columns(['lab_id', 'period']).doUpdateSet(vals)).returningAll().executeTakeFirstOrThrow();
    await this.audit.log(ctx, { action: 'EXTERNAL_LAB_SETTLEMENT', entityName: 'lab_ext_settlements', entityId: r.id, newData: { ...vals, lab: s.lab_name, month: dto.month } });
    return r;
  }
}

// ======================================================================= სტატისტიკა და კუმულაციური შედეგები
@Injectable()
export class LabStatsService {
  private readonly tz = loadEnv().CLINIC_TZ;
  constructor(@InjectDb() private readonly db: Database) {}

  async stats(from: string, to: string) {
    const range = sql<boolean>`i.ordered_at >= (${from}::date AT TIME ZONE ${this.tz}) AND i.ordered_at < ((${to}::date + 1) AT TIME ZONE ${this.tz})`;
    const base = this.db.selectFrom('dx_order_items as i').innerJoin('dx_services as s', 's.id', 'i.service_id').leftJoin('lab_specimens as sp', 'sp.id', 'i.specimen_id')
      .where('i.section', '=', 'lab').where(range);
    const totals = await base.select([
      sql<number>`count(*)`.as('ordered'), sql<number>`count(*) FILTER (WHERE i.status = 'validated')`.as('validated'),
      sql<number>`count(*) FILTER (WHERE i.status = 'cancelled')`.as('cancelled'), sql<number>`count(*) FILTER (WHERE i.status IN ('collected','in_progress','resulted'))`.as('open'),
      sql<number>`count(*) FILTER (WHERE s.performed_by = 'external')`.as('external'),
      sql<number>`count(DISTINCT i.specimen_id) FILTER (WHERE sp.status = 'rejected')`.as('rejected_specimens'), sql<number>`count(DISTINCT i.specimen_id)`.as('specimens'),
      sql<number>`percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM i.validated_at - sp.collected_at) / 60) FILTER (WHERE i.status = 'validated' AND s.performed_by = 'internal')`.as('tat_median_min'),
      sql<number>`percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM i.validated_at - sp.collected_at) / 60) FILTER (WHERE i.status = 'validated' AND s.performed_by = 'internal')`.as('tat_p90_min'),
    ]).executeTakeFirstOrThrow();
    const byService = await base.select(['s.id', 's.name', 's.group_name', 's.performed_by', sql<number>`count(*)`.as('n'),
      sql<number>`count(*) FILTER (WHERE i.priority = 'urgent')`.as('urgent'),
      sql<number>`percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM i.validated_at - sp.collected_at) / 60) FILTER (WHERE i.status = 'validated')`.as('tat_collect_median'),
      sql<number>`percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM i.validated_at - sp.collected_at) / 60) FILTER (WHERE i.status = 'validated')`.as('tat_collect_p90'),
      sql<number>`percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM i.validated_at - sp.received_at) / 60) FILTER (WHERE i.status = 'validated')`.as('tat_lab_median'),
      sql<number>`percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM i.validated_at - sp.collected_at) / 60) FILTER (WHERE i.status = 'validated' AND i.priority = 'urgent')`.as('tat_urgent_median')])
      .groupBy(['s.id', 's.name', 's.group_name', 's.performed_by']).orderBy(sql`count(*)`, 'desc').execute();
    const byDay = await base.select([sql<string>`to_char(i.ordered_at AT TIME ZONE ${this.tz}, 'YYYY-MM-DD')`.as('day'), sql<number>`count(*)`.as('n'),
      sql<number>`count(*) FILTER (WHERE i.status = 'validated')`.as('validated')]).groupBy(sql`1`).orderBy(sql`1`).execute();
    const byHour = await base.where('sp.collected_at', 'is not', null).select([sql<number>`extract(hour FROM sp.collected_at AT TIME ZONE ${this.tz})::int`.as('hour'), sql<number>`count(*)`.as('n')])
      .groupBy(sql`1`).orderBy(sql`1`).execute();
    const byValidator = await base.innerJoin('users as u', 'u.id', 'i.validated_by').where('i.status', '=', 'validated')
      .select([sql<string>`u.first_name || ' ' || u.last_name`.as('name'), sql<number>`count(*)`.as('n')]).groupBy(['u.id', 'u.first_name', 'u.last_name']).orderBy(sql`count(*)`, 'desc').execute();
    const byInstrument = await this.db.selectFrom('lab_results as r').innerJoin('dx_order_items as i', 'i.id', 'r.order_item_id').innerJoin('lab_instruments as ins', 'ins.id', 'r.instrument_id')
      .innerJoin('lab_methods as m', 'm.id', 'ins.method_id').where(range)
      .select(['m.name', sql<number>`count(*)`.as('results'), sql<number>`count(DISTINCT i.id)`.as('orders')]).groupBy('m.name').orderBy(sql`count(*)`, 'desc').execute();
    const manual = await this.db.selectFrom('lab_results as r').innerJoin('dx_order_items as i', 'i.id', 'r.order_item_id').where(range).where('r.instrument_id', 'is', null)
      .select(sql<number>`count(*)`.as('n')).executeTakeFirst();
    const ext = await base.where('s.performed_by', '=', 'external').select([
      sql<number>`count(*) FILTER (WHERE i.ext_shipment_id IS NOT NULL)`.as('sent'), sql<number>`count(*) FILTER (WHERE i.ext_result_at IS NOT NULL)`.as('resulted'),
      sql<number>`count(*) FILTER (WHERE i.ext_due_at < now() AND i.ext_result_at IS NULL AND i.status <> 'cancelled')`.as('overdue'),
      sql<number>`percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM i.ext_result_at - i.ext_due_at + make_interval(days => s.ext_turnaround_days)) / 86400) FILTER (WHERE i.ext_result_at IS NOT NULL)`.as('median_days')]).executeTakeFirst();
    return { from, to, totals, by_service: byService, by_day: byDay, by_hour: byHour, by_validator: byValidator, by_instrument: byInstrument, manual_results: Number(manual?.n ?? 0), external: ext };
  }

  /** პაციენტის ვალიდირებული ლაბ. შედეგები (კუმულაციური ხედი): ბრტყელი სია — frontend-ში ცხრილად/გრაფიკად */
  cumulative(patientId: string, q: { service_id?: string; group?: string; analyte_id?: string; limit?: number }) {
    let query = this.db.selectFrom('lab_results as r').innerJoin('dx_order_items as i', 'i.id', 'r.order_item_id').innerJoin('lab_analytes as a', 'a.id', 'r.analyte_id')
      .innerJoin('dx_services as s', 's.id', 'i.service_id').leftJoin('lab_specimens as sp', 'sp.id', 'i.specimen_id')
      .select(['r.analyte_id', 'a.code', 'a.name', 'a.unit', 'a.result_type', 'a.sort_order', 's.id as service_id', 's.name as service_name', 's.group_name', 'i.id as item_id', 'i.encounter_id',
        sql<Date>`coalesce(sp.collected_at, i.validated_at)`.as('at'), 'r.value_num', 'r.value_text', 'r.flag', 'r.ref_low', 'r.ref_high', 'r.ref_text'])
      .where('i.patient_id', '=', patientId).where('i.status', '=', 'validated')
      .orderBy(sql`coalesce(sp.collected_at, i.validated_at)`, 'desc').orderBy('s.name').orderBy('a.sort_order').limit(Math.min(q.limit ?? 2000, 5000));
    if (q.service_id) query = query.where('s.id', '=', q.service_id);
    if (q.group) query = query.where('s.group_name', '=', q.group);
    if (q.analyte_id) query = query.where('r.analyte_id', '=', q.analyte_id);
    return query.execute();
  }
}

// ======================================================================= კონტროლერი
class LabDto { @IsOptional() @IsString() @Length(2, 150) name?: string; @IsOptional() @IsString() @MaxLength(150) contact_person?: string | null;
  @IsOptional() @IsString() @MaxLength(50) phone?: string | null; @IsOptional() @IsEmail() email?: string | null; @IsOptional() @IsString() @MaxLength(500) note?: string | null;
  @IsOptional() @IsBoolean() is_active?: boolean }
class ShipDto { @IsUUID() lab_id: string; @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @IsUUID('4', { each: true }) item_ids: string[];
  @IsOptional() @IsString() @MaxLength(150) courier?: string; @IsOptional() @IsString() @MaxLength(500) note?: string }
class SettleDto { @IsUUID() lab_id: string; @Matches(/^\d{4}-(0[1-9]|1[0-2])$/) month: string; @IsOptional() @IsString() @MaxLength(60) invoice_no?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string; @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) paid_at?: string | null }
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/; const DAY = /^\d{4}-\d{2}-\d{2}$/;

@Controller()
export class LabExternalController {
  constructor(private readonly ext: LabExternalService, private readonly stats: LabStatsService) {}

  @Get('lab/external-labs') @Roles(...LAB_STAFF, 'billing', 'accountant')
  labs(@Query('all') all?: string) { return this.ext.labs(all === 'true'); }
  @Post('lab/external-labs') @Roles('admin', 'lab_doctor', 'lab_manager')
  createLab(@Body() dto: LabDto, @Req() req: Request) { return this.ext.saveLab(null, dto, auditCtx(req)); }
  @Patch('lab/external-labs/:id') @Roles('admin', 'lab_doctor', 'lab_manager')
  updateLab(@Param('id', ParseUUIDPipe) id: string, @Body() dto: LabDto, @Req() req: Request) { return this.ext.saveLab(id, dto, auditCtx(req)); }

  @Get('lab/external/to-send') @Roles(...LAB_STAFF) toSend() { return this.ext.toSend(); }
  @Get('lab/external/waiting') @Roles(...LAB_STAFF) waiting(@Query('lab_id') labId?: string) { return this.ext.waiting(labId); }
  @Get('lab/external/shipments') @Roles(...LAB_STAFF) shipments() { return this.ext.shipments(); }
  @Post('lab/external/shipments') @Roles(...LAB_STAFF)
  ship(@Body() dto: ShipDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.ext.ship(dto, u, auditCtx(req)); }
  @Get('lab/external/shipments/:id/act') @Roles(...LAB_STAFF)
  async act(@Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response) {
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline', 'Cache-Control': 'no-store' });
    return new StreamableFile(await this.ext.shipmentPdf(id));
  }
  @Post('lab/items/:id/external-result') @HttpCode(200) @Roles(...LAB_STAFF)
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_FILE, files: 1 } }))
  attach(@Param('id', ParseUUIDPipe) id: string, @UploadedFile() file: Express.Multer.File | undefined, @CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.ext.attachResult(id, file?.buffer, file?.originalname ? Buffer.from(file.originalname, 'latin1').toString('utf8') : undefined, u, auditCtx(req));
  }
  @Get('lab/items/:id/external-result') @Roles(...LAB_STAFF, 'doctor', 'nurse', 'receptionist')
  async file(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Res({ passthrough: true }) res: Response) {
    const f = await this.ext.resultFile(id, u);
    res.set({ 'Content-Type': f.mime, 'Content-Disposition': 'inline', 'Cache-Control': 'no-store' });
    return new StreamableFile(f.stream);
  }
  @Get('lab/external/settlement') @Roles('admin', 'lab_manager', 'lab_doctor', 'accountant')
  settlement(@Query('month') month: string) { if (!MONTH.test(month ?? '')) throw new BadRequestException('month: YYYY-MM'); return this.ext.settlement(month); }
  @Get('lab/external/settlement/items') @Roles('admin', 'lab_manager', 'lab_doctor', 'accountant')
  settlementItems(@Query('lab_id', ParseUUIDPipe) labId: string, @Query('month') month: string) { if (!MONTH.test(month ?? '')) throw new BadRequestException('month: YYYY-MM'); return this.ext.settlementItems(labId, month); }
  @Post('lab/external/settlements') @HttpCode(200) @Roles('admin', 'lab_manager', 'accountant')
  settle(@Body() dto: SettleDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.ext.recordSettlement(dto, u, auditCtx(req)); }

  @Get('lab/stats') @Roles('admin', 'lab_doctor', 'lab_manager')
  labStats(@Query('from') from: string, @Query('to') to: string) {
    if (!DAY.test(from ?? '') || !DAY.test(to ?? '') || from > to) throw new BadRequestException('from/to: YYYY-MM-DD');
    return this.stats.stats(from, to);
  }
  @Get('patients/:id/lab-cumulative') @Roles(...LAB_STAFF, 'doctor', 'nurse')
  cumulative(@Param('id', ParseUUIDPipe) id: string, @Query('service_id') serviceId?: string, @Query('group') group?: string, @Query('analyte_id') analyteId?: string) {
    return this.stats.cumulative(id, { service_id: serviceId || undefined, group: group || undefined, analyte_id: analyteId || undefined });
  }
}
