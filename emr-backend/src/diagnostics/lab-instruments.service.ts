import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import { AuditService, type AuditContext } from '../audit/audit.service';
import type { AuthUser } from '../auth/roles';
import { loadEnv } from '../config/env';
import { InjectDb, type Database } from '../database/database.module';
import { LabConfigService } from './lab-config.service';

export interface InstrumentDto {
  protocol: 'astm' | 'hl7'; conn_mode: 'client' | 'server'; host?: string | null; port: number; is_enabled: boolean; order_mode: 'none' | 'query' | 'push';
  settings?: Record<string, unknown>;
}
export interface CodeDto { code: string; analyte_id?: string | null; service_id?: string | null; factor?: number; send_order?: boolean }

const HL7_BARCODE = ['OBR-3', 'OBR-2', 'SPM-2', 'ORC-3'];
/** პროტოკოლის პარამეტრები — მხოლოდ ცნობილი ველები, საზღვრებით */
function sanitizeSettings(protocol: 'astm' | 'hl7', s: Record<string, unknown> = {}) {
  const int = (v: unknown, min: number, max: number) => (Number.isInteger(Number(v)) && Number(v) >= min && Number(v) <= max ? Number(v) : undefined);
  const out: Record<string, unknown> = { send_patient_name: s.send_patient_name === true };
  if (protocol === 'astm') {
    out.specimen_field = int(s.specimen_field, 1, 40) ?? 3;
    out.code_component = int(s.code_component, 1, 10) ?? 4;
    const q = int(s.query_component, 1, 10); if (q) out.query_component = q;
  } else {
    out.barcode_field = HL7_BARCODE.includes(String(s.barcode_field)) ? s.barcode_field : 'OBR-3';
    out.code_component = int(s.code_component, 1, 10) ?? 1;
    out.hl7_version = ['2.3.1', '2.4', '2.5', '2.5.1'].includes(String(s.hl7_version)) ? s.hl7_version : '2.3.1';
  }
  return out;
}

/** ანალიზატორების კავშირი (emr-lab-gateway-ის კონფიგურაცია), კოდების რუკა, ჟურნალი, დასამუშავებელი შედეგები */
@Injectable()
export class LabInstrumentsService {
  private readonly ports = loadEnv().LAB_GATEWAY_PORTS.split('-').map(Number) as [number, number];
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService, private readonly cfg: LabConfigService) {}

  private async requireManage(user: AuthUser) {
    if (!(await this.cfg.permissions(user)).methods) throw new ForbiddenException('ანალიზატორების კავშირს მართავს ლაბორატორიის ხელმძღვანელი ან მენეჯერი');
  }

  async gateway() {
    const g = await this.db.selectFrom('lab_gateway_state').selectAll().where('id', '=', 1).executeTakeFirst();
    const alive = !!g && Date.now() - new Date(g.heartbeat_at).getTime() < 90_000;
    return { alive, heartbeat_at: g?.heartbeat_at ?? null, started_at: g?.started_at ?? null, hostname: g?.hostname ?? null, listen_ports: this.ports };
  }

  /** ყველა ანალიზატორი (lab_methods) + კავშირი, თუ აქვს */
  list() {
    return this.db.selectFrom('lab_methods as m').leftJoin('lab_instruments as i', 'i.method_id', 'm.id')
      .select(['m.id as method_id', 'm.name', 'm.kind', 'm.is_active', 'i.id', 'i.protocol', 'i.conn_mode', 'i.host', 'i.port', 'i.is_enabled', 'i.order_mode', 'i.status', 'i.status_at',
        'i.peer', 'i.last_message_at', 'i.last_error',
        (eb) => eb.selectFrom('lab_instrument_codes as c').select((e) => e.fn.countAll<number>().as('n')).whereRef('c.instrument_id', '=', 'i.id').as('codes'),
        (eb) => eb.selectFrom('lab_instrument_results as r').select((e) => e.fn.countAll<number>().as('n')).whereRef('r.instrument_id', '=', 'i.id').where('r.status', '=', 'unmatched').as('unmatched')])
      .orderBy('m.is_active', 'desc').orderBy('m.name').execute();
  }

  async detail(methodId: string) {
    const m = await this.db.selectFrom('lab_methods').select(['id', 'name', 'kind', 'is_active']).where('id', '=', methodId).executeTakeFirst();
    if (!m) throw new NotFoundException('ანალიზატორი ვერ მოიძებნა');
    const i = await this.db.selectFrom('lab_instruments').selectAll().where('method_id', '=', methodId).executeTakeFirst();
    const codes = i ? await this.db.selectFrom('lab_instrument_codes as c').leftJoin('lab_analytes as a', 'a.id', 'c.analyte_id')
      .leftJoin('dx_services as s', (j) => j.on((eb) => eb.or([eb('s.id', '=', eb.ref('c.service_id')), eb('s.id', '=', eb.ref('a.service_id'))])))
      .select(['c.id', 'c.code', 'c.analyte_id', 'c.service_id', 'c.factor', 'c.send_order', 'a.name as analyte_name', 'a.code as analyte_code', 'a.unit', 's.name as service_name', 's.code as service_code'])
      .where('c.instrument_id', '=', i.id).orderBy(sql`upper(c.code)`).execute() : [];
    return { method: m, instrument: i ?? null, codes };
  }

  async save(methodId: string, dto: InstrumentDto, user: AuthUser, ctx: AuditContext) {
    await this.requireManage(user);
    const m = await this.db.selectFrom('lab_methods').select(['id', 'is_active']).where('id', '=', methodId).executeTakeFirst();
    if (!m) throw new NotFoundException('ანალიზატორი ვერ მოიძებნა');
    if (dto.conn_mode === 'server' && (dto.port < this.ports[0] || dto.port > this.ports[1])) {
      throw new BadRequestException(`სერვერის რეჟიმში პორტი ${this.ports[0]}–${this.ports[1]} დიაპაზონიდან (docker-compose-ში გახსნილი)`);
    }
    if (dto.conn_mode === 'client' && !dto.host?.trim()) throw new BadRequestException('კლიენტის რეჟიმში მიუთითეთ მისამართი (Moxa / ანალიზატორის IP)');
    const vals = { protocol: dto.protocol, conn_mode: dto.conn_mode, host: dto.conn_mode === 'client' ? dto.host!.trim() : null, port: dto.port, is_enabled: dto.is_enabled && m.is_active,
      order_mode: dto.order_mode, settings: JSON.stringify(sanitizeSettings(dto.protocol, dto.settings)) };
    try {
      await this.db.transaction().execute(async (trx) => {
        const old = await trx.selectFrom('lab_instruments').selectAll().where('method_id', '=', methodId).forUpdate().executeTakeFirst();
        if (old) await trx.updateTable('lab_instruments').set(vals).where('id', '=', old.id).execute();
        else await trx.insertInto('lab_instruments').values({ method_id: methodId, ...vals }).execute();
        await this.audit.log(ctx, { action: old ? 'UPDATE_LAB_INSTRUMENT' : 'CREATE_LAB_INSTRUMENT', entityName: 'lab_methods', entityId: methodId,
          oldData: old ? { protocol: old.protocol, conn_mode: old.conn_mode, host: old.host, port: old.port, is_enabled: old.is_enabled, order_mode: old.order_mode, settings: old.settings } : undefined, newData: vals }, trx);
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new ConflictException(`პორტი ${dto.port} უკვე სხვა ანალიზატორს უკავია`);
      throw e;
    }
    return this.detail(methodId);
  }

  /** კოდების რუკა — სრულად იცვლება */
  async setCodes(methodId: string, codes: CodeDto[], user: AuthUser, ctx: AuditContext) {
    await this.requireManage(user);
    const i = await this.db.selectFrom('lab_instruments').select('id').where('method_id', '=', methodId).executeTakeFirst();
    if (!i) throw new BadRequestException('ჯერ შეინახეთ კავშირის პარამეტრები');
    const seen = new Set<string>(); const seenA = new Set<string>(); const seenS = new Set<string>();
    const rows = codes.map((c, n) => {
      const code = c.code.trim();
      if (!code) throw new BadRequestException(`ხაზი ${n + 1}: კოდი ცარიელია`);
      if (!!c.analyte_id === !!c.service_id) throw new BadRequestException(`ხაზი ${n + 1} (${code}): აირჩიეთ კომპონენტი ან კვლევა`);
      if (seen.has(code.toUpperCase())) throw new BadRequestException(`კოდი „${code}“ მეორდება`);
      if (c.analyte_id && seenA.has(c.analyte_id)) throw new BadRequestException(`ხაზი ${n + 1} (${code}): კომპონენტი უკვე სხვა კოდზეა მიბმული`);
      if (c.service_id && seenS.has(c.service_id)) throw new BadRequestException(`ხაზი ${n + 1} (${code}): კვლევა უკვე სხვა კოდზეა მიბმული`);
      seen.add(code.toUpperCase()); if (c.analyte_id) seenA.add(c.analyte_id); if (c.service_id) seenS.add(c.service_id);
      const factor = c.factor ?? 1;
      if (!(factor > 0)) throw new BadRequestException(`ხაზი ${n + 1} (${code}): კოეფიციენტი > 0`);
      return { instrument_id: i.id, code, analyte_id: c.analyte_id || null, service_id: c.service_id || null, factor: String(factor), send_order: c.send_order ?? true };
    });
    if (rows.length) {
      const aIds = rows.map((r) => r.analyte_id).filter((x): x is string => !!x);
      const sIds = rows.map((r) => r.service_id).filter((x): x is string => !!x);
      const okA = aIds.length ? await this.db.selectFrom('lab_analytes as a').innerJoin('dx_services as s', 's.id', 'a.service_id').select('a.id').where('a.id', 'in', aIds).where('s.section', '=', 'lab').execute() : [];
      const okS = sIds.length ? await this.db.selectFrom('dx_services').select('id').where('id', 'in', sIds).where('section', '=', 'lab').execute() : [];
      if (okA.length !== aIds.length || okS.length !== sIds.length) throw new BadRequestException('ზოგიერთი კომპონენტი/კვლევა ვერ მოიძებნა');
    }
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('lab_instrument_codes').where('instrument_id', '=', i.id).execute();
      if (rows.length) await trx.insertInto('lab_instrument_codes').values(rows).execute();
      await this.audit.log(ctx, { action: 'SET_LAB_INSTRUMENT_CODES', entityName: 'lab_methods', entityId: methodId, newData: { count: rows.length, codes: rows.map((r) => r.code) } }, trx);
    });
    return this.detail(methodId);
  }

  async messages(methodId: string, limit = 100) {
    const i = await this.db.selectFrom('lab_instruments').select('id').where('method_id', '=', methodId).executeTakeFirst();
    if (!i) return [];
    return this.db.selectFrom('lab_instrument_messages').selectAll().where('instrument_id', '=', i.id).orderBy('id', 'desc').limit(Math.min(Math.max(limit, 1), 500)).execute();
  }

  /** ანალიზატორის შედეგები: დასამუშავებელი (ნაგულისხმევი) / მიბმული / ყველა */
  results(q: { status?: string; method_id?: string; limit?: number }) {
    let query = this.db.selectFrom('lab_instrument_results as r').innerJoin('lab_instruments as ins', 'ins.id', 'r.instrument_id').innerJoin('lab_methods as m', 'm.id', 'ins.method_id')
      .leftJoin('dx_order_items as it', 'it.id', 'r.order_item_id').leftJoin('patients as p', 'p.id', 'it.patient_id').leftJoin('lab_analytes as a', 'a.id', 'r.analyte_id')
      .leftJoin('lab_specimens as sp', (j) => j.onRef('sp.barcode', '=', 'r.barcode'))
      .leftJoin('patients as sp_p', 'sp_p.id', 'sp.patient_id')
      .select(['r.id', 'r.barcode', 'r.code', 'r.value', 'r.unit', 'r.flags', 'r.result_status', 'r.measured_at', 'r.status', 'r.reason', 'r.rerun', 'r.created_at', 'r.order_item_id',
        'm.name as instrument', 'a.name as analyte_name',
        sql<string | null>`coalesce(p.last_name || ' ' || p.first_name, sp_p.last_name || ' ' || sp_p.first_name)`.as('patient_name')])
      .orderBy('r.id', 'desc').limit(Math.min(q.limit ?? 200, 500));
    const st = q.status ?? 'unmatched';
    if (st !== 'all') query = query.where('r.status', '=', st as 'unmatched');
    if (q.method_id) query = query.where('ins.method_id', '=', q.method_id);
    return query.execute();
  }
  async unmatchedCount() {
    const r = await this.db.selectFrom('lab_instrument_results').select((e) => e.fn.countAll<number>().as('n')).where('status', '=', 'unmatched').executeTakeFirst();
    return { unmatched: Number(r?.n ?? 0) };
  }
}
