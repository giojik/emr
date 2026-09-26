import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import { AuditService, type AuditContext } from '../audit/audit.service';
import type { AuthUser } from '../auth/roles';
import { InjectDb, type Database } from '../database/database.module';
import { DiagnosticsService } from '../diagnostics/diagnostics.service';

export interface IncomingResult { barcode: string; code: string; value: string; unit: string; flags: string; status: string; measured_at: Date | null; qc: boolean }
export interface OrderInfo { barcode: string; specimen_id: string; patient_id: string; name: string | null; birth: string | null; sex: string | null; priority: 'R' | 'S'; specimen: string; codes: string[] }

/** ერთეულის შედარება: 10^9/L = 10*9/l = 10⁹/L; µ = u */
export const normUnit = (u: string) => u.toLowerCase().replace(/[\s^*]/g, '').replace(/[µμ]/g, 'u').replace(/⁰/g, '0').replace(/¹/g, '1').replace(/²/g, '2')
  .replace(/³/g, '3').replace(/⁶/g, '6').replace(/⁹/g, '9');
const OPEN = ['collected', 'in_progress', 'resulted'] as const;

/**
 * ანალიზატორის შედეგების მიბმა შეკვეთაზე და შეკვეთების მომზადება ანალიზატორისთვის.
 * გამოიყენება emr-lab-gateway-შიც (ახალი შედეგები) და API-შიც („ხელახლა ცდა“ დასამუშავებელ სიაში).
 * შედეგი იწერება DiagnosticsService.saveResults-ით — იგივე ნორმები/ნიშნები/სტატუსი/აუდიტი, რაც ხელით შეტანისას; ვალიდაცია — მხოლოდ ადამიანი.
 */
@Injectable()
export class LabIngestService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService, private readonly dx: DiagnosticsService) {}

  // =============================================================== სინჯარა შტრიხკოდით (ანალიზატორი ხშირად ნულებს უმატებს წინ)
  private specimen(barcode: string) {
    const b = barcode.trim();
    return this.db.selectFrom('lab_specimens').select(['id', 'barcode', 'status', 'patient_id'])
      .where((eb) => eb.or([eb('barcode', '=', b), eb(sql`ltrim(barcode, '0')`, '=', b.replace(/^0+/, ''))]))
      .orderBy(sql`barcode = ${b}`, 'desc').executeTakeFirst();
  }

  // =============================================================== შედეგები
  /** ახალი შედეგები ანალიზატორიდან: ინახება და მაშინვე მუშავდება. QC — ცალკე (არ ებმება პაციენტს). */
  async ingest(instrumentId: string, messageId: bigint | number | string | null, results: IncomingResult[]) {
    if (!results.length) return { applied: 0, unmatched: 0 };
    const rows = await this.db.insertInto('lab_instrument_results').values(results.map((r) => ({
      instrument_id: instrumentId, message_id: messageId === null ? null : String(messageId), barcode: r.barcode || null, code: r.code || '?', value: r.value, unit: r.unit || null,
      flags: r.flags || null, result_status: r.status || null, measured_at: r.measured_at,
      status: r.qc ? 'dismissed' : 'pending', reason: r.qc ? 'QC (ხარისხის კონტროლი)' : null, processed_at: r.qc ? sql<Date>`now()` : null,
    }))).returning('id').execute();
    return this.process(rows.map((r) => String(r.id)));
  }

  /** მიბმა: შტრიხკოდი → სინჯარა → კოდი → კომპონენტი → შეკვეთა; შემდეგ saveResults თითო შეკვეთაზე */
  async process(ids: string[], ctxUser: AuthUser | null = null) {
    if (!ids.length) return { applied: 0, unmatched: 0 };
    const rows = await this.db.selectFrom('lab_instrument_results as r').innerJoin('lab_instruments as ins', 'ins.id', 'r.instrument_id')
      .innerJoin('lab_methods as m', 'm.id', 'ins.method_id')
      .select(['r.id', 'r.instrument_id', 'r.barcode', 'r.code', 'r.value', 'r.unit', 'r.result_status', 'ins.method_id', 'm.name as instrument_name', 'm.is_active as method_active'])
      .where('r.id', 'in', ids).where('r.status', 'in', ['pending', 'unmatched']).orderBy('r.id').execute();
    let applied = 0; let unmatched = 0;
    const fail = async (id: string, reason: string) => {
      await this.db.updateTable('lab_instrument_results').set({ status: 'unmatched', reason, processed_at: sql`now()` }).where('id', '=', id).execute(); unmatched++;
    };
    // შეკვეთა → [მნიშვნელობები]
    const batches = new Map<string, { instrument_id: string; method_id: string; name: string; values: { analyte_id: string; value: string }[]; rows: { id: string; analyte_id: string; rerun: boolean }[] }>();
    for (const r of rows) {
      if (!r.barcode) { await fail(String(r.id), 'შტრიხკოდი არ მოვიდა'); continue; }
      if (['X', 'I'].includes((r.result_status ?? '').toUpperCase())) { await fail(String(r.id), 'ანალიზატორმა ვერ შეასრულა (სტატუსი ' + r.result_status + ')'); continue; }
      const sp = await this.specimen(r.barcode);
      if (!sp) { await fail(String(r.id), `შტრიხკოდი ${r.barcode} ვერ მოიძებნა`); continue; }
      if (sp.status === 'rejected') { await fail(String(r.id), 'სინჯარა უარყოფილია'); continue; }
      const map = await this.db.selectFrom('lab_instrument_codes as c').innerJoin('lab_analytes as a', 'a.id', 'c.analyte_id')
        .select(['c.analyte_id', 'c.factor', 'a.service_id', 'a.name', 'a.unit', 'a.result_type', 'a.options', 'a.is_active'])
        .where('c.instrument_id', '=', r.instrument_id).where(sql`upper(c.code)`, '=', r.code.toUpperCase()).executeTakeFirst();
      if (!map?.analyte_id) { await fail(String(r.id), `კოდი „${r.code}“ რუკაში არ არის`); continue; }
      const items = await this.db.selectFrom('dx_order_items').select(['id', 'status'])
        .where('specimen_id', '=', sp.id).where('service_id', '=', map.service_id).where('status', '<>', 'cancelled').orderBy('ordered_at').execute();
      const it = items.find((i) => (OPEN as readonly string[]).includes(i.status));
      if (!it) { await fail(String(r.id), items.length ? 'შედეგი უკვე დადასტურებულია — შესწორება ხელით, მიზეზით' : `${map.name}: ამ სინჯარაზე არ არის დანიშნული`); continue; }
      // მნიშვნელობა
      let value = (r.value ?? '').trim();
      if (!value) { await fail(String(r.id), 'მნიშვნელობა ცარიელია'); continue; }
      if (map.result_type === 'numeric') {
        const n = Number(value.replace(',', '.'));
        if (!Number.isFinite(n)) { await fail(String(r.id), `არარიცხვითი მნიშვნელობა „${value}“ — შეიყვანეთ ხელით`); continue; }
        const factor = Number(map.factor);
        if (factor === 1 && r.unit && map.unit && normUnit(r.unit) !== normUnit(map.unit)) { await fail(String(r.id), `ერთეული: ანალიზატორი „${r.unit}“ ≠ EMR „${map.unit}“ — მიუთითეთ გადაყვანის კოეფიციენტი`); continue; }
        value = String(Number((n * factor).toPrecision(12)));
      } else if (map.result_type === 'select' && map.options && !map.options.split('|').includes(value)) {
        await fail(String(r.id), `„${value}“ არ არის დაშვებულ ვარიანტებში (${map.options.replace(/\|/g, ', ')})`); continue;
      }
      const prev = await this.db.selectFrom('lab_results').select('id').where('order_item_id', '=', it.id).where('analyte_id', '=', map.analyte_id).executeTakeFirst();
      const b = batches.get(it.id) ?? { instrument_id: r.instrument_id, method_id: r.method_id, name: r.instrument_name, values: [], rows: [] };
      b.values = [...b.values.filter((v) => v.analyte_id !== map.analyte_id), { analyte_id: map.analyte_id, value }];
      b.rows.push({ id: String(r.id), analyte_id: map.analyte_id, rerun: !!prev });
      batches.set(it.id, b);
    }
    for (const [itemId, b] of batches) {
      const ctx: AuditContext = { userId: ctxUser?.id ?? null, userAgent: `emr-lab-gateway: ${b.name}` };
      try {
        await this.dx.saveResults(itemId, b.values, null, ctx, { instrument_id: b.instrument_id, ...(b.method_id ? { lab_method_id: b.method_id } : {}) });
        for (const x of b.rows) {
          await this.db.updateTable('lab_instrument_results').set({ status: 'applied', reason: null, order_item_id: itemId, analyte_id: x.analyte_id, rerun: x.rerun, processed_at: sql`now()` })
            .where('id', '=', x.id).execute();
          applied++;
        }
      } catch (e) {
        for (const x of b.rows) await fail(x.id, (e as Error).message);
      }
    }
    return { applied, unmatched };
  }

  /** დასამუშავებელი → ხელახლა (მაგ. რუკის შესწორების ან სინჯარის მიღების შემდეგ) */
  async retry(id: string, user: AuthUser, ctx: AuditContext) {
    const r = await this.db.selectFrom('lab_instrument_results').select(['id', 'status']).where('id', '=', id).executeTakeFirst();
    if (!r) throw new NotFoundException('ჩანაწერი ვერ მოიძებნა');
    if (r.status !== 'unmatched' && r.status !== 'pending') throw new BadRequestException('ეს ჩანაწერი უკვე დამუშავებულია');
    const res = await this.process([id], user);
    await this.audit.log(ctx, { action: 'RETRY_INSTRUMENT_RESULT', entityName: 'lab_instrument_results', entityId: id, newData: res });
    return this.db.selectFrom('lab_instrument_results').select(['id', 'status', 'reason', 'order_item_id']).where('id', '=', id).executeTakeFirstOrThrow();
  }
  async dismiss(id: string, reason: string, user: AuthUser, ctx: AuditContext) {
    const r = await this.db.updateTable('lab_instrument_results').set({ status: 'dismissed', reason: reason.trim(), resolved_by: user.id, resolved_at: sql`now()` })
      .where('id', '=', id).where('status', 'in', ['unmatched', 'pending']).returning(['id', 'status']).executeTakeFirst();
    if (!r) throw new BadRequestException('ჩანაწერი ვერ მოიძებნა ან უკვე დამუშავებულია');
    await this.audit.log(ctx, { action: 'DISMISS_INSTRUMENT_RESULT', entityName: 'lab_instrument_results', entityId: id, newData: { reason } });
    return r;
  }

  // =============================================================== შეკვეთები ანალიზატორისთვის
  /** შტრიხკოდის დაუსრულებელი ტესტები ამ ანალიზატორის კოდებით: კვლევის (პანელის) კოდი, თუ არის; თორემ კომპონენტების კოდები */
  async ordersForBarcode(instrumentId: string, barcode: string, sendName: boolean): Promise<OrderInfo | null> {
    const sp = await this.specimen(barcode);
    if (!sp || sp.status === 'rejected') return null;
    return this.ordersForSpecimen(instrumentId, sp.id, sp.barcode, sendName);
  }
  private async ordersForSpecimen(instrumentId: string, specimenId: string, barcode: string, sendName: boolean): Promise<OrderInfo | null> {
    const items = await this.db.selectFrom('dx_order_items as i').innerJoin('dx_services as s', 's.id', 'i.service_id').innerJoin('patients as p', 'p.id', 'i.patient_id')
      .select(['i.service_id', 'i.priority', 's.specimen_type', 'p.personal_number', 'p.passport_number', 'p.first_name', 'p.last_name', 'p.birth_date', 'p.gender', 'p.id as patient_uuid'])
      .where('i.specimen_id', '=', specimenId).where('i.section', '=', 'lab').where('i.status', 'in', [...OPEN]).execute();
    if (!items.length) return null;
    const svc = [...new Set(items.map((i) => i.service_id))];
    const codes = await this.db.selectFrom('lab_instrument_codes as c').leftJoin('lab_analytes as a', 'a.id', 'c.analyte_id')
      .select(['c.code', 'c.service_id', 'a.service_id as analyte_service', 'a.is_active', 'a.sort_order'])
      .where('c.instrument_id', '=', instrumentId).where('c.send_order', '=', true)
      .where((eb) => eb.or([eb('c.service_id', 'in', svc), eb('a.service_id', 'in', svc)])).orderBy('a.sort_order').execute();
    const out: string[] = [];
    for (const s of svc) {
      const panel = codes.find((c) => c.service_id === s);
      if (panel) out.push(panel.code);
      else out.push(...codes.filter((c) => c.analyte_service === s && c.is_active !== false).map((c) => c.code));
    }
    const p = items[0];
    return { barcode, specimen_id: specimenId, patient_id: p.personal_number ?? p.passport_number ?? p.patient_uuid.slice(0, 8), name: sendName ? `${p.last_name}^${p.first_name}` : null,
      birth: p.birth_date, sex: p.gender, priority: items.some((i) => i.priority === 'urgent') ? 'S' : 'R', specimen: p.specimen_type ?? '', codes: [...new Set(out)] };
  }

  /** push რეჟიმი: მიღებული სინჯარები (ბოლო 2 დღე), რომლებიც ამ ანალიზატორზე ჯერ არ გაგზავნილა და აქვს მისი ტესტი */
  async pendingPush(instrumentId: string, sendName: boolean, limit = 20) {
    const cands = await this.db.selectFrom('lab_specimens as sp').select(['sp.id', 'sp.barcode'])
      .where('sp.status', '=', 'received').where('sp.received_at', '>', sql<Date>`now() - interval '2 days'`)
      .where((eb) => eb.not(eb.exists(eb.selectFrom('lab_instrument_orders as o').select('o.id').whereRef('o.specimen_id', '=', 'sp.id').where('o.instrument_id', '=', instrumentId)
        .where((e2) => e2.or([e2('o.status', '=', 'sent'), e2('o.attempts', '>=', 5)])))))   // წარუმატებელი — მაქს. 5 ცდა
      .where((eb) => eb.exists(eb.selectFrom('dx_order_items as i').select('i.id').whereRef('i.specimen_id', '=', 'sp.id').where('i.status', 'in', [...OPEN])
        .where((e2) => e2.or([
          e2.exists(e2.selectFrom('lab_instrument_codes as c').select('c.id').where('c.instrument_id', '=', instrumentId).where('c.send_order', '=', true).whereRef('c.service_id', '=', 'i.service_id')),
          e2.exists(e2.selectFrom('lab_instrument_codes as c').innerJoin('lab_analytes as a', 'a.id', 'c.analyte_id').select('c.id').where('c.instrument_id', '=', instrumentId).where('c.send_order', '=', true).whereRef('a.service_id', '=', 'i.service_id')),
        ]))))
      .orderBy('sp.received_at').limit(limit).execute();
    const out: (OrderInfo & { order_id: string })[] = [];
    for (const c of cands) {
      const o = await this.ordersForSpecimen(instrumentId, c.id, c.barcode, sendName);
      if (!o?.codes.length) continue;
      const row = await this.db.insertInto('lab_instrument_orders').values({ instrument_id: instrumentId, specimen_id: c.id, codes: o.codes })
        .onConflict((oc) => oc.columns(['instrument_id', 'specimen_id']).doUpdateSet({ codes: o.codes, status: 'pending', error: null })).returning('id').executeTakeFirstOrThrow();
      out.push({ ...o, order_id: String(row.id) });
    }
    return out;
  }
  async markOrder(orderId: string, ok: boolean, error?: string) {
    await this.db.updateTable('lab_instrument_orders').set(ok ? { status: 'sent', sent_at: sql`now()`, error: null, attempts: sql`attempts + 1` } : { status: 'failed', error: error ?? null, attempts: sql`attempts + 1` })
      .where('id', '=', orderId).execute();
  }
}
