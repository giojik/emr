import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import bwipjs from 'bwip-js';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import type { Request, Response } from 'express';
import { sql, type Transaction } from 'kysely';
import { memoryStorage } from 'multer';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser } from '../auth/roles';
import { mapPgError } from '../common/pg-errors';
import { loadEnv } from '../config/env';
import { InjectDb, type Database } from '../database/database.module';
import type { DB } from '../database/db';
import { dt, newDoc } from '../diagnostics/diagnostics.pdf';
import { ModulesService } from '../modules/modules';
import { NotificationsService } from '../notifications/notifications';
import { StorageService } from '../storage/storage.service';

type Trx = Transaction<DB>;
type Ex = Database | Trx;
const TZ = loadEnv().CLINIC_TZ;
const mm = (v: number) => (v * 72) / 25.4;
export interface CssdSettings {
  instrument_tracking: boolean; cycle_entry: 'manual'; wash_record: boolean; bd_required: boolean; bi_frequency: 'each' | 'daily' | 'weekly' | 'off'; bi_hold: 'all' | 'implant' | 'none';
  shelf_life_mode: 'time' | 'event'; patient_trace: boolean; auto_consume: boolean; label_size: '50x25' | '40x20' | '70x35'; label_code: 'qr' | 'code128';
}
interface Unit { id: string; name: string; department_id: string | null; kind: string }

/**
 * CSSD (0039): ნაკრები → რეცხვა → შეფუთვა → სტერილიზაცია (ციკლი, ინდიკატორები) → შენახვა → გაცემა → გამოყენება → დაბრუნება.
 * დამუშავების ერთეული — stock_locations.kind = 'cssd' (განყოფილებაზე მიბმული): ცენტრალური ან დეცენტრალიზებული — ერთი მექანიზმით.
 * უფლებები: დამუშავება — ერთეულის განყოფილების თანამშრომელი (ან საწყობის მენეჯერი / admin); ცნობარები — + ერთეულის ხელმძღვანელი;
 * გამოყენება / დაუხარჯავის დაბრუნება — გამცემი განყოფილების თანამშრომელი.
 */
@Injectable()
export class CssdService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService, private readonly modules: ModulesService,
    private readonly notifications: NotificationsService, private readonly storage: StorageService) {}

  settings() { return this.modules.require<CssdSettings>('cssd'); }
  private me(u: AuthUser) { return this.db.selectFrom('users').select(['id', 'department_id', 'is_section_head']).where('id', '=', u.id).executeTakeFirstOrThrow(); }
  private async today(ex: Ex = this.db) { return (await sql<{ d: string }>`SELECT to_char((now() AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS d`.execute(ex)).rows[0].d; }
  private event(ex: Ex, setId: string, packId: string | null, kind: string, data: Record<string, unknown>, u: AuthUser) {
    return ex.insertInto('cssd_events').values({ set_id: setId, pack_id: packId, kind, data: JSON.stringify(data), user_id: u.id }).execute();
  }
  private async unit(id: string, ex: Ex = this.db): Promise<Unit> {
    const l = await ex.selectFrom('stock_locations').select(['id', 'name', 'department_id', 'kind', 'is_active']).where('id', '=', id).executeTakeFirst();
    if (!l || l.kind !== 'cssd' || !l.is_active) throw new BadRequestException('ლოკაცია CSSD-ის ერთეული არ არის (ლოკაციის ტიპი „სტერილიზაცია (CSSD)“)');
    return l;
  }
  async canProcess(u: AuthUser, l: Unit) {
    if (has(u, 'admin', 'stock_manager')) return true;
    const me = await this.me(u);
    return !!l.department_id && me.department_id === l.department_id;
  }
  private async requireProcess(u: AuthUser, l: Unit) { if (!(await this.canProcess(u, l))) throw new ForbiddenException(`CSSD „${l.name}“ — მხოლოდ ერთეულის თანამშრომელი`); }
  private async requireManage(u: AuthUser) {
    if (has(u, 'admin', 'stock_manager')) return;
    const me = await this.me(u);
    if (me.is_section_head && me.department_id && await this.db.selectFrom('stock_locations').select('id').where('kind', '=', 'cssd').where('department_id', '=', me.department_id).executeTakeFirst()) return;
    throw new ForbiddenException('ცნობარები — CSSD-ის ხელმძღვანელი, საწყობის მენეჯერი ან admin');
  }
  private async nextNo(trx: Trx, type: string, prefix: string, digits = 6, perYear = true) {
    const year = perYear ? Number((await this.today(trx)).slice(0, 4)) : 0;
    const { last_value } = await trx.insertInto('document_counters').values({ document_type: type, year, last_value: 1 })
      .onConflict((oc) => oc.columns(['document_type', 'year']).doUpdateSet({ last_value: sql`document_counters.last_value + 1` })).returning('last_value').executeTakeFirstOrThrow();
    return `${prefix}${perYear ? String(year).slice(2) + '-' : ''}${String(last_value).padStart(digits, '0')}`;
  }

  // ================================================================= ცნობარები
  async refs(u: AuthUser) {
    const settings = await this.settings();
    const [packaging, machines, units, templates] = await Promise.all([
      this.db.selectFrom('cssd_packaging_types').selectAll().orderBy('sort_order').orderBy('name').execute(),
      this.db.selectFrom('cssd_machines as m').innerJoin('stock_locations as l', 'l.id', 'm.location_id').selectAll('m').select('l.name as location_name').orderBy('m.name').execute(),
      this.db.selectFrom('stock_locations as l').leftJoin('departments as d', 'd.id', 'l.department_id').select(['l.id', 'l.name', 'l.department_id', 'd.name as department_name'])
        .where('l.kind', '=', 'cssd').where('l.is_active', '=', true).orderBy('l.name').execute(),
      this.db.selectFrom('cssd_templates as t').leftJoin('departments as d', 'd.id', 't.owner_department_id').leftJoin('cssd_packaging_types as p', 'p.id', 't.packaging_type_id')
        .selectAll('t').select(['d.name as owner_department_name', 'p.name as packaging_name',
          sql<number>`(SELECT count(*)::int FROM cssd_template_items i WHERE i.template_id = t.id)`.as('items'),
          sql<number>`(SELECT count(*)::int FROM cssd_sets s WHERE s.template_id = t.id AND s.status <> 'retired')`.as('sets')]).orderBy('t.name').execute()]);
    const mine: string[] = []; for (const x of units) if (await this.canProcess(u, { ...x, kind: 'cssd' })) mine.push(x.id);
    return { settings, packaging, machines, units: units.map((x) => ({ ...x, can_process: mine.includes(x.id) })), templates };
  }

  async savePackaging(id: string | null, dto: { name?: string; shelf_days?: number | null; consumables?: { item_id: string; qty: number }[]; is_active?: boolean; sort_order?: number }, u: AuthUser, ctx: AuditContext) {
    await this.settings(); await this.requireManage(u);
    if (dto.consumables?.length) {
      const n = await this.db.selectFrom('stock_items').select(sql<number>`count(*)::int`.as('n')).where('id', 'in', dto.consumables.map((c) => c.item_id)).executeTakeFirstOrThrow();
      if (n.n !== new Set(dto.consumables.map((c) => c.item_id)).size) throw new BadRequestException('მასალა ვერ მოიძებნა საწყობის კატალოგში');
    }
    const vals = { ...(dto.name && { name: dto.name.trim() }), ...(dto.shelf_days !== undefined && { shelf_days: dto.shelf_days }), ...(dto.consumables && { consumables: JSON.stringify(dto.consumables) }),
      ...(dto.is_active !== undefined && { is_active: dto.is_active }), ...(dto.sort_order !== undefined && { sort_order: dto.sort_order }) };
    try {
      const r = id ? await this.db.updateTable('cssd_packaging_types').set(vals).where('id', '=', id).returningAll().executeTakeFirst()
        : await this.db.insertInto('cssd_packaging_types').values({ name: dto.name!.trim(), shelf_days: dto.shelf_days ?? null, consumables: JSON.stringify(dto.consumables ?? []), sort_order: dto.sort_order ?? 100 }).returningAll().executeTakeFirst();
      if (!r) throw new NotFoundException('შეფუთვის ტიპი ვერ მოიძებნა');
      await this.audit.log(ctx, { action: id ? 'UPDATE_CSSD_PACKAGING' : 'CREATE_CSSD_PACKAGING', entityName: 'cssd_packaging_types', entityId: r.id, newData: dto });
      return r;
    } catch (e) { mapPgError(e, { cssd_packaging_types_name_key: 'იგივე დასახელება უკვე არსებობს' }); }
  }

  async saveMachine(id: string | null, dto: { name?: string; kind?: string; location_id?: string; manufacturer?: string | null; model?: string | null; serial_no?: string | null; programs?: { name: string; temp?: number; minutes?: number }[]; is_active?: boolean }, u: AuthUser, ctx: AuditContext) {
    await this.settings(); await this.requireManage(u);
    if (dto.location_id) await this.unit(dto.location_id);
    const vals = { ...(dto.name && { name: dto.name.trim() }), ...(dto.kind && { kind: dto.kind }), ...(dto.location_id && { location_id: dto.location_id }),
      ...(dto.manufacturer !== undefined && { manufacturer: dto.manufacturer?.trim() || null }), ...(dto.model !== undefined && { model: dto.model?.trim() || null }),
      ...(dto.serial_no !== undefined && { serial_no: dto.serial_no?.trim() || null }), ...(dto.programs && { programs: JSON.stringify(dto.programs) }), ...(dto.is_active !== undefined && { is_active: dto.is_active }) };
    const r = id ? await this.db.updateTable('cssd_machines').set(vals).where('id', '=', id).returningAll().executeTakeFirst()
      : await this.db.insertInto('cssd_machines').values({ name: dto.name!.trim(), kind: dto.kind!, location_id: dto.location_id!, manufacturer: dto.manufacturer?.trim() || null, model: dto.model?.trim() || null,
        serial_no: dto.serial_no?.trim() || null, programs: JSON.stringify(dto.programs ?? []) }).returningAll().executeTakeFirst();
    if (!r) throw new NotFoundException('აპარატი ვერ მოიძებნა');
    await this.audit.log(ctx, { action: id ? 'UPDATE_CSSD_MACHINE' : 'CREATE_CSSD_MACHINE', entityName: 'cssd_machines', entityId: r.id, newData: dto });
    return r;
  }

  async template(id: string) {
    const t = await this.db.selectFrom('cssd_templates').selectAll().where('id', '=', id).executeTakeFirst();
    if (!t) throw new NotFoundException('ნაკრების ტიპი ვერ მოიძებნა');
    const items = await this.db.selectFrom('cssd_template_items').select(['line_no', 'name', 'qty']).where('template_id', '=', id).orderBy('line_no').execute();
    return { ...t, items };
  }
  async saveTemplate(id: string | null, dto: { code?: string; name?: string; owner_department_id?: string | null; packaging_type_id?: string | null; is_implant?: boolean; program_hint?: string | null; notes?: string | null; is_active?: boolean; items?: { name: string; qty: number }[] }, u: AuthUser, ctx: AuditContext) {
    await this.settings(); await this.requireManage(u);
    let tid = id ?? '';
    try {
      await this.db.transaction().execute(async (trx) => {
        const vals = { ...(dto.name && { name: dto.name.trim() }), ...(dto.owner_department_id !== undefined && { owner_department_id: dto.owner_department_id }),
          ...(dto.packaging_type_id !== undefined && { packaging_type_id: dto.packaging_type_id }), ...(dto.is_implant !== undefined && { is_implant: dto.is_implant }),
          ...(dto.program_hint !== undefined && { program_hint: dto.program_hint?.trim() || null }), ...(dto.notes !== undefined && { notes: dto.notes?.trim() || null }), ...(dto.is_active !== undefined && { is_active: dto.is_active }) };
        if (id) { const r = await trx.updateTable('cssd_templates').set(vals).where('id', '=', id).executeTakeFirst(); if (!Number(r.numUpdatedRows)) throw new NotFoundException('ნაკრების ტიპი ვერ მოიძებნა'); }
        else tid = (await trx.insertInto('cssd_templates').values({ code: dto.code!, name: dto.name!.trim(), ...vals }).returning('id').executeTakeFirstOrThrow()).id;
        if (dto.items) {
          await trx.deleteFrom('cssd_template_items').where('template_id', '=', tid).execute();
          if (dto.items.length) await trx.insertInto('cssd_template_items').values(dto.items.map((x, i) => ({ template_id: tid, line_no: i + 1, name: x.name.trim(), qty: x.qty }))).execute();
        }
        await this.audit.log(ctx, { action: id ? 'UPDATE_CSSD_TEMPLATE' : 'CREATE_CSSD_TEMPLATE', entityName: 'cssd_templates', entityId: tid, newData: dto }, trx);
      });
    } catch (e) { mapPgError(e, { cssd_templates_code_key: 'იგივე კოდი უკვე არსებობს' }); }
    return this.template(tid);
  }

  // ================================================================= ნაკრები და ინსტრუმენტი
  async createSets(dto: { template_id: string; home_location_id: string; count?: number; barcode?: string | null; serial?: string | null }, u: AuthUser, ctx: AuditContext) {
    await this.settings(); await this.requireManage(u);
    const l = await this.unit(dto.home_location_id);
    const t = await this.template(dto.template_id);
    if (!t.is_active) throw new BadRequestException('ნაკრების ტიპი გათიშულია');
    if (dto.barcode && (dto.count ?? 1) > 1) throw new BadRequestException('ხელით შტრიხკოდი — მხოლოდ ერთ ნაკრებზე');
    const ids: string[] = [];
    try {
      await this.db.transaction().execute(async (trx) => {
        const n = (await trx.selectFrom('cssd_sets').select(sql<number>`count(*)::int`.as('n')).where('template_id', '=', t.id).executeTakeFirstOrThrow()).n;
        for (let i = 0; i < (dto.count ?? 1); i++) {
          const code = dto.barcode?.trim().toUpperCase() || await this.nextNo(trx, 'cssd_set', 'CS-', 6, false);
          const s = await trx.insertInto('cssd_sets').values({ barcode: code, template_id: t.id, serial: dto.serial?.trim() || `№${n + i + 1}`, home_location_id: l.id }).returning('id').executeTakeFirstOrThrow();
          ids.push(s.id);
          await this.event(trx, s.id, null, 'created', { barcode: code }, u);
        }
        await this.audit.log(ctx, { action: 'CREATE_CSSD_SETS', entityName: 'cssd_sets', entityId: ids[0], newData: { ...dto, ids } }, trx);
      });
    } catch (e) { mapPgError(e, { cssd_sets_barcode_key: 'ეს შტრიხკოდი უკვე გამოყენებულია' }); }
    return this.db.selectFrom('cssd_sets').selectAll().where('id', 'in', ids).orderBy('barcode').execute();
  }

  private setsBase() {
    return this.db.selectFrom('cssd_sets as s').innerJoin('cssd_templates as t', 't.id', 's.template_id').innerJoin('stock_locations as l', 'l.id', 's.home_location_id')
      .leftJoin('departments as hd', 'hd.id', 's.holder_department_id').leftJoin('departments as od', 'od.id', 't.owner_department_id')
      .leftJoin('cssd_packs as p', (j) => j.onRef('p.set_id', '=', 's.id').on('p.status', 'in', ['packed', 'sterile', 'quarantine', 'issued']))
      .selectAll('s').select(['t.name as template_name', 't.code as template_code', 't.is_implant', 'l.name as home_location_name', 'hd.name as holder_department_name', 'od.name as owner_department_name',
        'p.id as pack_id', 'p.pack_no', 'p.status as pack_status', 'p.expires_on', 'p.issued_department_id']);
  }
  async sets(q: { search?: string; status?: string; location_id?: string; template_id?: string }) {
    await this.settings();
    let x = this.setsBase().orderBy('t.name').orderBy('s.barcode').limit(1000);
    if (q.status) x = x.where('s.status', 'in', q.status.split(','));
    else x = x.where('s.status', '<>', 'retired');
    if (q.location_id) x = x.where('s.home_location_id', '=', q.location_id);
    if (q.template_id) x = x.where('s.template_id', '=', q.template_id);
    const s = q.search?.trim();
    if (s) x = x.where((eb) => eb.or([eb(sql`upper(s.barcode)`, 'like', `%${s.toUpperCase()}%`), eb(sql`lower(t.name)`, 'like', `%${s.toLowerCase()}%`), eb(sql`upper(coalesce(p.pack_no, ''))`, '=', s.toUpperCase())]));
    return x.execute();
  }
  async set(id: string) {
    await this.settings();
    const s = await this.setsBase().where('s.id', '=', id).executeTakeFirst();
    if (!s) throw new NotFoundException('ნაკრები ვერ მოიძებნა');
    const [items, packs, events, instruments] = await Promise.all([
      this.db.selectFrom('cssd_template_items').select(['line_no', 'name', 'qty']).where('template_id', '=', s.template_id).orderBy('line_no').execute(),
      this.packsBase().where('p.set_id', '=', id).orderBy('p.packed_at', 'desc').limit(100).execute(),
      this.db.selectFrom('cssd_events as e').innerJoin('users as u', 'u.id', 'e.user_id').select(['e.id', 'e.kind', 'e.data', 'e.created_at', 'e.pack_id', sql<string>`u.first_name || ' ' || u.last_name`.as('user_name')])
        .where('e.set_id', '=', id).orderBy('e.id', 'desc').limit(200).execute(),
      this.db.selectFrom('cssd_instruments').selectAll().where('set_id', '=', id).orderBy('name').execute()]);
    return { ...s, items, packs, events, instruments };
  }
  /** სკანირება: ნაკრების შტრიხკოდი ან შეფუთვის № → ნაკრები + ცოცხალი შეფუთვა */
  async scan(code: string) {
    await this.settings();
    const c = code.trim().toUpperCase();
    const s = await this.setsBase().where((eb) => eb.or([eb(sql`upper(s.barcode)`, '=', c), eb('s.id', '=', sql<string>`(SELECT set_id FROM cssd_packs WHERE pack_no = ${c})`)])).executeTakeFirst();
    if (!s) throw new NotFoundException(`კოდი „${c}“ ვერ მოიძებნა`);
    const pack = await this.packsBase().where('p.pack_no', '=', c).executeTakeFirst();
    return { set: s, pack: pack ?? null };
  }
  async retireSet(id: string, reason: string, u: AuthUser, ctx: AuditContext) {
    await this.settings(); await this.requireManage(u);
    await this.db.transaction().execute(async (trx) => {
      const s = await trx.selectFrom('cssd_sets').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!s) throw new NotFoundException('ნაკრები ვერ მოიძებნა');
      if (['packed', 'in_use'].includes(s.status)) throw new ConflictException('ნაკრები შეფუთულია / განყოფილებაშია — ჯერ დაბრუნება');
      await trx.updateTable('cssd_sets').set({ status: 'retired' }).where('id', '=', id).execute();
      await this.event(trx, id, null, 'retired', { reason }, u);
      await this.audit.log(ctx, { action: 'RETIRE_CSSD_SET', entityName: 'cssd_sets', entityId: id, newData: { reason } }, trx);
    });
    return this.set(id);
  }

  async saveInstrument(id: string | null, dto: { code?: string; name?: string; set_id?: string | null; max_cycles?: number | null; status?: string; notes?: string | null }, u: AuthUser, ctx: AuditContext) {
    const s = await this.settings();
    if (!s.instrument_tracking) throw new BadRequestException('ინსტრუმენტების აღრიცხვა გამორთულია (მოდულები → CSSD)');
    await this.requireManage(u);
    const vals = { ...(dto.name && { name: dto.name.trim() }), ...(dto.set_id !== undefined && { set_id: dto.set_id }), ...(dto.max_cycles !== undefined && { max_cycles: dto.max_cycles }),
      ...(dto.status && { status: dto.status }), ...(dto.notes !== undefined && { notes: dto.notes?.trim() || null }) };
    try {
      const r = id ? await this.db.updateTable('cssd_instruments').set(vals).where('id', '=', id).returningAll().executeTakeFirst()
        : await this.db.insertInto('cssd_instruments').values({ code: dto.code!.trim().toUpperCase(), name: dto.name!.trim(), ...vals }).returningAll().executeTakeFirst();
      if (!r) throw new NotFoundException('ინსტრუმენტი ვერ მოიძებნა');
      await this.audit.log(ctx, { action: id ? 'UPDATE_CSSD_INSTRUMENT' : 'CREATE_CSSD_INSTRUMENT', entityName: 'cssd_instruments', entityId: r.id, newData: dto });
      return r;
    } catch (e) { mapPgError(e, { cssd_instruments_code_key: 'ეს კოდი უკვე გამოყენებულია' }); }
  }
  instruments(q: { set_id?: string; search?: string }) {
    let x = this.db.selectFrom('cssd_instruments as i').leftJoin('cssd_sets as s', 's.id', 'i.set_id').selectAll('i').select('s.barcode as set_barcode').orderBy('i.name').limit(1000);
    if (q.set_id) x = x.where('i.set_id', '=', q.set_id);
    const s = q.search?.trim(); if (s) x = x.where((eb) => eb.or([eb(sql`upper(i.code)`, 'like', `%${s.toUpperCase()}%`), eb(sql`lower(i.name)`, 'like', `%${s.toLowerCase()}%`)]));
    return x.execute();
  }

  // ================================================================= დამუშავება
  private async setsFor(trx: Trx, ids: string[], l: Unit) {
    const rows = await trx.selectFrom('cssd_sets').selectAll().where('id', 'in', ids).forUpdate().execute();
    if (rows.length !== new Set(ids).size) throw new BadRequestException('ნაკრები ვერ მოიძებნა');
    const alien = rows.filter((r) => r.home_location_id !== l.id);
    if (alien.length) throw new BadRequestException(`სხვა CSSD-ის ნაკრებია: ${alien.map((a) => a.barcode).join(', ')}`);
    return rows;
  }
  /** ბინძურის მიღება: განყოფილებიდან დაბრუნებული (ან ახალი) ნაკრები; გაცემული, მაგრამ გამოყენება არ აღრიცხულა — „გამოყენებული“ (პაციენტის გარეშე) */
  async receive(dto: { location_id: string; set_ids: string[]; note?: string | null }, u: AuthUser, ctx: AuditContext) {
    await this.settings();
    const l = await this.unit(dto.location_id); await this.requireProcess(u, l);
    await this.db.transaction().execute(async (trx) => {
      for (const s of await this.setsFor(trx, dto.set_ids, l)) {
        if (!['available', 'in_use'].includes(s.status)) throw new ConflictException(`${s.barcode}: ${s.status === 'received' ? 'უკვე მიღებულია' : 'შეფუთულია / დამუშავებაშია'}`);
        const live = await trx.selectFrom('cssd_packs').select(['id', 'status', 'pack_no']).where('set_id', '=', s.id).where('status', 'in', ['issued', 'sterile', 'quarantine']).executeTakeFirst();
        if (live?.status === 'issued') await trx.updateTable('cssd_packs').set({ status: 'used', used_at: sql`now()`, used_by: u.id, note: 'დაბრუნდა ბინძური — გამოყენება არ აღრიცხულა' }).where('id', '=', live.id).execute();
        else if (live) throw new ConflictException(`${s.barcode}: შეფუთვა ${live.pack_no} ჯერ საწყობშია`);
        await trx.updateTable('cssd_sets').set({ status: 'received', holder_department_id: null }).where('id', '=', s.id).execute();
        await this.event(trx, s.id, live?.id ?? null, 'received', { from_department_id: s.holder_department_id, note: dto.note ?? null }, u);
      }
      await this.audit.log(ctx, { action: 'CSSD_RECEIVE', entityName: 'cssd_sets', entityId: dto.set_ids[0], newData: dto }, trx);
    });
    return { received: dto.set_ids.length };
  }

  /** რეცხვა: wash_record — აპარატი + ციკლი (შედეგი); სხვა შემთხვევაში — მარტივი მონიშვნა */
  async wash(dto: { location_id: string; set_ids: string[]; machine_id?: string | null; cycle_no?: string | null; program?: string | null; result?: 'pass' | 'fail'; notes?: string | null }, u: AuthUser, ctx: AuditContext) {
    const st = await this.settings();
    const l = await this.unit(dto.location_id); await this.requireProcess(u, l);
    let cycleId: string | null = null;
    await this.db.transaction().execute(async (trx) => {
      const sets = await this.setsFor(trx, dto.set_ids, l);
      const bad = sets.filter((s) => s.status !== 'received'); if (bad.length) throw new ConflictException(`რეცხვისთვის ჯერ მიღება: ${bad.map((b) => b.barcode).join(', ')}`);
      if (st.wash_record) {
        if (!dto.machine_id) throw new BadRequestException('რეცხვის აპარატი სავალდებულოა (პარამეტრი)');
        const m = await trx.selectFrom('cssd_machines').selectAll().where('id', '=', dto.machine_id).executeTakeFirst();
        if (!m || m.kind !== 'washer' || m.location_id !== l.id || !m.is_active) throw new BadRequestException('რეცხვის აპარატი ამ ერთეულს არ ეკუთვნის');
        const no = dto.cycle_no?.trim() || String((await trx.selectFrom('cssd_cycles').select(sql<number>`count(*)::int`.as('n')).where('machine_id', '=', m.id).executeTakeFirstOrThrow()).n + 1);
        cycleId = (await trx.insertInto('cssd_cycles').values({ cycle_no: no, machine_id: m.id, kind: 'wash', program: dto.program ?? null, result: dto.result ?? 'pass', notes: dto.notes ?? null, operator_id: u.id })
          .returning('id').executeTakeFirstOrThrow()).id;
      }
      const ok = (dto.result ?? 'pass') === 'pass';
      for (const s of sets) {
        if (ok) await trx.updateTable('cssd_sets').set({ status: 'washed' }).where('id', '=', s.id).execute();
        await this.event(trx, s.id, null, ok ? 'washed' : 'wash_failed', { cycle_id: cycleId }, u);
      }
      await this.audit.log(ctx, { action: 'CSSD_WASH', entityName: 'cssd_sets', entityId: dto.set_ids[0], newData: { ...dto, cycle_id: cycleId } }, trx);
    });
    return { washed: (dto.result ?? 'pass') === 'pass' ? dto.set_ids.length : 0, cycle_id: cycleId };
  }

  /** შემოწმება და შეფუთვა: ჩეკლისტი (აკლია / დაზიანებული — შენიშვნით), შეფუთვის ტიპი, მასალის ჩამოწერა → SP-ნომერი, ეტიკეტი */
  async pack(dto: { set_id: string; packaging_type_id?: string | null; checklist?: { line_no: number; counted: number; note?: string | null }[]; note?: string | null }, u: AuthUser, ctx: AuditContext) {
    const st = await this.settings();
    let packId = '';
    try {
      await this.db.transaction().execute(async (trx) => {
        const s = await trx.selectFrom('cssd_sets').selectAll().where('id', '=', dto.set_id).forUpdate().executeTakeFirst();
        if (!s) throw new NotFoundException('ნაკრები ვერ მოიძებნა');
        const l = await this.unit(s.home_location_id, trx); await this.requireProcess(u, l);
        if (!(s.status === 'washed' || (s.status === 'received' && !st.wash_record))) throw new ConflictException(st.wash_record ? 'შეფუთვამდე — რეცხვა' : 'შეფუთვამდე — მიღება');
        const t = await trx.selectFrom('cssd_templates').selectAll().where('id', '=', s.template_id).executeTakeFirstOrThrow();
        const pt = dto.packaging_type_id ?? t.packaging_type_id;
        if (!pt) throw new BadRequestException('შეფუთვის ტიპი სავალდებულოა');
        const ptype = await trx.selectFrom('cssd_packaging_types').selectAll().where('id', '=', pt).executeTakeFirst();
        if (!ptype?.is_active) throw new BadRequestException('შეფუთვის ტიპი ვერ მოიძებნა ან გათიშულია');
        const items = await trx.selectFrom('cssd_template_items').select(['line_no', 'name', 'qty']).where('template_id', '=', t.id).orderBy('line_no').execute();
        const check = items.map((i) => { const c = dto.checklist?.find((x) => x.line_no === i.line_no); return { name: i.name, expected: i.qty, counted: c ? c.counted : i.qty, note: c?.note ?? null }; });
        const incomplete = check.some((c) => c.counted !== c.expected);
        if (incomplete && !(dto.note?.trim() || check.some((c) => c.counted !== c.expected && c.note?.trim()))) throw new BadRequestException('შემადგენლობა არასრულია — შენიშვნა სავალდებულოა');
        const no = await this.nextNo(trx, 'cssd_pack', 'SP');
        packId = (await trx.insertInto('cssd_packs').values({ pack_no: no, set_id: s.id, location_id: l.id, packaging_type_id: pt, checklist: JSON.stringify(check), incomplete, packed_by: u.id, note: dto.note?.trim() || null })
          .returning('id').executeTakeFirstOrThrow()).id;
        // შეფუთვის მასალა — CSSD-ის ქვესაწყობიდან (FEFO), ჩამოწერა cssd_use
        const cons = (ptype.consumables as { item_id: string; qty: number }[]) ?? [];
        if (st.auto_consume && cons.length) await this.consume(trx, l, cons, no, u);
        await trx.updateTable('cssd_sets').set({ status: 'packed' }).where('id', '=', s.id).execute();
        await this.event(trx, s.id, packId, 'packed', { pack_no: no, incomplete, packaging: ptype.name }, u);
        await this.audit.log(ctx, { action: 'CSSD_PACK', entityName: 'cssd_packs', entityId: packId, newData: { ...dto, pack_no: no, incomplete } }, trx);
      });
    } catch (e) {
      const err = e as { constraint?: string };
      if (err.constraint === 'stock_balances_non_negative') throw new ConflictException('შეფუთვის მასალა CSSD-ის ქვესაწყობში არ არის — მოითხოვეთ საწყობიდან');
      if (err.constraint === 'ux_cssd_packs_live') throw new ConflictException('ნაკრები უკვე შეფუთულია');
      throw e;
    }
    return this.packOne(packId);
  }
  private async consume(trx: Trx, l: Unit, cons: { item_id: string; qty: number }[], packNo: string, u: AuthUser) {
    const today = await this.today(trx);
    const d = await trx.insertInto('stock_docs').values({ doc_type: 'writeoff', doc_date: today, location_id: l.id, writeoff_reason: 'cssd_use', notes: `CSSD: შეფუთვა ${packNo}`, created_by: u.id }).returning('id').executeTakeFirstOrThrow();
    let n = 0; let total = 0;
    for (const c of cons) {
      let need = c.qty;
      const lots = await trx.selectFrom('stock_balances as b').innerJoin('stock_lots as lt', 'lt.id', 'b.lot_id').select(['lt.id', 'lt.lot_no', 'lt.serial_no', 'lt.expires_on', 'lt.produced_on', 'lt.unit_cost', 'b.qty'])
        .where('b.location_id', '=', l.id).where('b.item_id', '=', c.item_id).where('b.qty', '>', '0').where('lt.status', '=', 'active')
        .where((eb) => eb.or([eb('lt.expires_on', 'is', null), eb('lt.expires_on', '>=', today)])).orderBy(sql`lt.expires_on NULLS LAST`).execute();
      for (const lot of lots) {
        if (need <= 0) break;
        const q = Math.min(need, Number(lot.qty)); need -= q; n++; total += q * Number(lot.unit_cost);
        const line = await trx.insertInto('stock_doc_lines').values({ doc_id: d.id, line_no: n, item_id: c.item_id, qty: String(q), qty_base: String(q), lot_no: lot.lot_no, serial_no: lot.serial_no,
          expires_on: lot.expires_on, produced_on: lot.produced_on, unit_cost: lot.unit_cost, lot_id: lot.id, line_net: String(Math.round(q * Number(lot.unit_cost) * 100) / 100) }).returning('id').executeTakeFirstOrThrow();
        await trx.insertInto('stock_moves').values({ doc_id: d.id, line_id: line.id, move_type: 'writeoff', location_id: l.id, lot_id: lot.id, item_id: c.item_id, qty: String(-q), cost_lot: lot.unit_cost, created_by: u.id }).execute();
      }
      if (need > 0) throw Object.assign(new Error('no stock'), { constraint: 'stock_balances_non_negative' });
    }
    const { last_value } = await trx.insertInto('document_counters').values({ document_type: 'stock_WO', year: Number(today.slice(0, 4)), last_value: 1 })
      .onConflict((oc) => oc.columns(['document_type', 'year']).doUpdateSet({ last_value: sql`document_counters.last_value + 1` })).returning('last_value').executeTakeFirstOrThrow();
    await trx.updateTable('stock_docs').set({ status: 'posted', doc_no: `WO${today.slice(2, 4)}-${String(last_value).padStart(6, '0')}`, posted_by: u.id, posted_at: sql`now()`, total_net: String(Math.round(total * 100) / 100) }).where('id', '=', d.id).execute();
  }

  /** BI სავალდებულოა? — სიხშირით (ყოველ / დღის პირველ / კვირის პირველ ციკლზე) ან იმპლანტის ჩატვირთვაზე (bi_hold ≠ none) */
  async biRequired(machineId: string, hasImplant: boolean, st?: CssdSettings) {
    const s = st ?? await this.settings();
    if (hasImplant && s.bi_hold !== 'none') return { required: true, why: 'იმპლანტის ჩატვირთვა' };
    if (s.bi_frequency === 'off') return { required: false, why: null };
    if (s.bi_frequency === 'each') return { required: true, why: 'ყოველ ციკლზე' };
    const since = s.bi_frequency === 'daily' ? sql`(now() AT TIME ZONE ${TZ})::date` : sql`(now() AT TIME ZONE ${TZ})::date - 6`;
    const prev = await this.db.selectFrom('cssd_cycles').select('id').where('machine_id', '=', machineId).where('kind', '=', 'sterilize').where('bi_used', '=', true)
      .where(sql`(started_at AT TIME ZONE ${TZ})::date`, '>=', since).executeTakeFirst();
    return prev ? { required: false, why: null } : { required: true, why: s.bi_frequency === 'daily' ? 'დღის პირველი ციკლი' : 'კვირის პირველი ციკლი' };
  }

  /** ციკლი: Bowie-Dick (ცარიელი) ან სტერილიზაცია (ჩატვირთვა — შეფუთვები; ქიმიური ინდიკატორი თითოზე; BI — პარამეტრით) */
  async cycle(dto: { machine_id: string; kind: 'sterilize' | 'bowie_dick'; cycle_no?: string | null; program?: string | null; temp_c?: number | null; minutes?: number | null; pressure_bar?: number | null;
    result: 'pass' | 'fail'; bi_used?: boolean; bi_lot?: string | null; pack_ids?: string[]; ci_fail_pack_ids?: string[]; notes?: string | null }, u: AuthUser, ctx: AuditContext) {
    const st = await this.settings();
    const m = await this.db.selectFrom('cssd_machines').selectAll().where('id', '=', dto.machine_id).executeTakeFirst();
    if (!m || !m.is_active || m.kind === 'washer') throw new BadRequestException('სტერილიზატორი ვერ მოიძებნა');
    const l = await this.unit(m.location_id); await this.requireProcess(u, l);
    if (dto.kind === 'bowie_dick' && m.kind !== 'steam') throw new BadRequestException('Bowie-Dick — მხოლოდ ორთქლის სტერილიზატორზე');
    let id = '';
    const recalled: string[] = [];
    try {
      await this.db.transaction().execute(async (trx) => {
        const ids = [...new Set(dto.pack_ids ?? [])];
        let packs: { id: string; set_id: string; status: string; location_id: string; pack_no: string; shelf_days: number | null; is_implant: boolean }[] = [];
        if (dto.kind === 'sterilize') {
          if (!ids.length) throw new BadRequestException('ჩატვირთვა ცარიელია — მიუთითეთ შეფუთვები');
          if (st.bd_required && m.kind === 'steam') {
            const bd = await trx.selectFrom('cssd_cycles').select(['result']).where('machine_id', '=', m.id).where('kind', '=', 'bowie_dick')
              .where(sql`(started_at AT TIME ZONE ${TZ})::date`, '=', sql`(now() AT TIME ZONE ${TZ})::date`).orderBy('started_at', 'desc').executeTakeFirst();
            if (bd?.result !== 'pass') throw new ConflictException(bd ? 'დღევანდელი Bowie-Dick ჩავარდა — აპარატი დაბლოკილია (გაიმეორეთ ტესტი)' : 'ჯერ დღევანდელი Bowie-Dick ტესტი (პარამეტრი)');
          }
          packs = await trx.selectFrom('cssd_packs as p').innerJoin('cssd_sets as s', 's.id', 'p.set_id').innerJoin('cssd_templates as t', 't.id', 's.template_id')
            .innerJoin('cssd_packaging_types as pt', 'pt.id', 'p.packaging_type_id')
            .select(['p.id', 'p.set_id', 'p.status', 'p.location_id', 'p.pack_no', 'pt.shelf_days', 't.is_implant']).where('p.id', 'in', ids).forUpdate('p').execute();
          if (packs.length !== ids.length) throw new BadRequestException('შეფუთვა ვერ მოიძებნა');
          const bad = packs.filter((p) => p.status !== 'packed' || p.location_id !== l.id);
          if (bad.length) throw new ConflictException(`სტერილიზაციისთვის მზად არ არის: ${bad.map((b) => b.pack_no).join(', ')}`);
          const bi = await this.biRequired(m.id, packs.some((p) => p.is_implant), st);
          if (bi.required && !dto.bi_used) throw new BadRequestException(`ბიოლოგიური ინდიკატორი სავალდებულოა: ${bi.why}`);
        } else if (ids.length) throw new BadRequestException('Bowie-Dick — ცარიელი კამერით');
        const no = dto.cycle_no?.trim() || String((await trx.selectFrom('cssd_cycles').select(sql<number>`count(*)::int`.as('n')).where('machine_id', '=', m.id).executeTakeFirstOrThrow()).n + 1);
        const biUsed = dto.kind === 'sterilize' && !!dto.bi_used;
        id = (await trx.insertInto('cssd_cycles').values({ cycle_no: no, machine_id: m.id, kind: dto.kind, program: dto.program ?? null, temp_c: dto.temp_c != null ? String(dto.temp_c) : null,
          minutes: dto.minutes != null ? String(dto.minutes) : null, pressure_bar: dto.pressure_bar != null ? String(dto.pressure_bar) : null, result: dto.result, bi_used: biUsed,
          bi_lot: biUsed ? dto.bi_lot?.trim() || null : null, bi_result: biUsed ? 'pending' : null, notes: dto.notes?.trim() || null, operator_id: u.id }).returning('id').executeTakeFirstOrThrow()).id;
        const today = await this.today(trx);
        const ciFail = new Set(dto.ci_fail_pack_ids ?? []);
        for (const p of packs) {
          const ok = dto.result === 'pass' && !ciFail.has(p.id);
          const hold = ok && biUsed && (st.bi_hold === 'all' || (st.bi_hold === 'implant' && p.is_implant));
          const exp = ok && st.shelf_life_mode === 'time' && p.shelf_days ? (await sql<{ d: string }>`SELECT to_char(${today}::date + ${p.shelf_days}::int, 'YYYY-MM-DD') AS d`.execute(trx)).rows[0].d : null;
          await trx.updateTable('cssd_packs').set({ cycle_id: id, ci_pass: dto.result === 'pass' ? !ciFail.has(p.id) : null, status: ok ? (hold ? 'quarantine' : 'sterile') : 'failed', expires_on: exp }).where('id', '=', p.id).execute();
          await trx.updateTable('cssd_sets').set({ status: ok ? 'packed' : 'washed' }).where('id', '=', p.set_id).execute();
          if (ok && st.instrument_tracking) await trx.updateTable('cssd_instruments').set({ cycles: sql`cycles + 1` }).where('set_id', '=', p.set_id).where('status', '=', 'active').execute();
          await this.event(trx, p.set_id, p.id, ok ? (hold ? 'quarantine' : 'sterile') : 'sterilize_failed', { cycle_id: id, cycle_no: no, machine: m.name, ci_fail: ciFail.has(p.id) }, u);
          if (!ok) recalled.push(p.pack_no);
        }
        await this.audit.log(ctx, { action: dto.kind === 'bowie_dick' ? 'CSSD_BOWIE_DICK' : 'CSSD_CYCLE', entityName: 'cssd_cycles', entityId: id, newData: { ...dto, cycle_no: no } }, trx);
      });
    } catch (e) { mapPgError(e, { cssd_cycles_machine_id_cycle_no_key: 'ამ აპარატზე ციკლის ეს ნომერი უკვე არსებობს' }); }
    return this.cycleOne(id);
  }

  /** BI-ს პასუხი: დადებითი → ქარანტინიდან სტერილურში; ჩავარდა → გაწვევა: ციკლის ყველა შეფუთვა, სადაც არ უნდა იყოს; გამოყენებული — სიაში პაციენტით */
  async biResult(id: string, result: 'pass' | 'fail', u: AuthUser, ctx: AuditContext) {
    await this.settings();
    let notify: { ids: string[]; title: string; body: string } | null = null;
    await this.db.transaction().execute(async (trx) => {
      const c = await trx.selectFrom('cssd_cycles').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!c) throw new NotFoundException('ციკლი ვერ მოიძებნა');
      if (!c.bi_used || c.bi_result !== 'pending') throw new ConflictException('BI-ს პასუხი არ ელოდება');
      const m = await trx.selectFrom('cssd_machines').select(['location_id', 'name']).where('id', '=', c.machine_id).executeTakeFirstOrThrow();
      const l = await this.unit(m.location_id, trx); await this.requireProcess(u, l);
      await trx.updateTable('cssd_cycles').set({ bi_result: result, bi_read_at: sql`now()`, bi_read_by: u.id }).where('id', '=', id).execute();
      const packs = await trx.selectFrom('cssd_packs').select(['id', 'set_id', 'status', 'pack_no', 'issued_department_id']).where('cycle_id', '=', id).execute();
      if (result === 'pass') {
        for (const p of packs.filter((x) => x.status === 'quarantine')) {
          await trx.updateTable('cssd_packs').set({ status: 'sterile' }).where('id', '=', p.id).execute();
          await this.event(trx, p.set_id, p.id, 'released', { cycle_id: id, bi: 'pass' }, u);
        }
      } else {
        const depts = new Set<string>();
        for (const p of packs) {
          if (['sterile', 'quarantine', 'issued'].includes(p.status)) {
            await trx.updateTable('cssd_packs').set({ status: 'recalled' }).where('id', '=', p.id).execute();
            if (p.status !== 'issued') await trx.updateTable('cssd_sets').set({ status: 'received' }).where('id', '=', p.set_id).execute();     // CSSD-შია — ხელახალი დამუშავება
            if (p.issued_department_id) depts.add(p.issued_department_id);
          }
          await this.event(trx, p.set_id, p.id, 'recalled', { cycle_id: id, bi: 'fail', was: p.status }, u);
        }
        const used = packs.filter((p) => p.status === 'used').length;
        const staff = l.department_id ? (await trx.selectFrom('users').select('id').where('department_id', '=', l.department_id).where('is_active', '=', true).execute()).map((x) => x.id) : [];
        const heads = depts.size ? (await trx.selectFrom('users').select('id').where('department_id', 'in', [...depts]).where('is_active', '=', true).execute()).map((x) => x.id) : [];
        notify = { ids: [...staff, ...heads], title: `CSSD გაწვევა: ${m.name}, ციკლი ${c.cycle_no} — BI ჩავარდა`, body: `${packs.length} შეფუთვა${used ? `, აქედან ${used} უკვე გამოყენებულია პაციენტზე` : ''} — გამოყენება აკრძალულია, დააბრუნეთ CSSD-ში` };
      }
      await this.audit.log(ctx, { action: result === 'pass' ? 'CSSD_BI_PASS' : 'CSSD_BI_FAIL', entityName: 'cssd_cycles', entityId: id, newData: { result } }, trx);
    });
    if (notify) { const n = notify as { ids: string[]; title: string; body: string }; for (const uid of new Set(n.ids)) await this.notifications.notify(uid, { kind: 'cssd_recall', title: n.title, body: n.body, urgent: true, link: `/cssd?tab=cycles&cycle=${id}`, entityId: id }); }
    return this.cycleOne(id);
  }

  async cycleOne(id: string) {
    const c = await this.db.selectFrom('cssd_cycles as c').innerJoin('cssd_machines as m', 'm.id', 'c.machine_id').innerJoin('users as u', 'u.id', 'c.operator_id').leftJoin('users as b', 'b.id', 'c.bi_read_by')
      .selectAll('c').select(['m.name as machine_name', 'm.kind as machine_kind', 'm.location_id', sql<string>`u.first_name || ' ' || u.last_name`.as('operator_name'), sql<string | null>`b.first_name || ' ' || b.last_name`.as('bi_read_by_name')])
      .where('c.id', '=', id).executeTakeFirst();
    if (!c) throw new NotFoundException('ციკლი ვერ მოიძებნა');
    const packs = await this.packsBase().where((eb) => eb.or([eb('p.cycle_id', '=', id), eb('p.wash_cycle_id', '=', id)])).orderBy('p.pack_no').execute();
    return { ...c, packs };
  }
  async cycles(q: { location_id?: string; machine_id?: string; kind?: string; bi_pending?: boolean; from?: string; to?: string }) {
    await this.settings();
    let x = this.db.selectFrom('cssd_cycles as c').innerJoin('cssd_machines as m', 'm.id', 'c.machine_id').innerJoin('users as u', 'u.id', 'c.operator_id')
      .select(['c.id', 'c.cycle_no', 'c.kind', 'c.program', 'c.temp_c', 'c.minutes', 'c.pressure_bar', 'c.started_at', 'c.result', 'c.bi_used', 'c.bi_result', 'c.attachment_key', 'm.name as machine_name', 'm.kind as machine_kind',
        sql<string>`u.first_name || ' ' || u.last_name`.as('operator_name'), sql<number>`(SELECT count(*)::int FROM cssd_packs p WHERE p.cycle_id = c.id)`.as('packs')])
      .orderBy('c.started_at', 'desc').limit(500);
    if (q.location_id) x = x.where('m.location_id', '=', q.location_id);
    if (q.machine_id) x = x.where('c.machine_id', '=', q.machine_id);
    if (q.kind) x = x.where('c.kind', '=', q.kind);
    if (q.bi_pending) x = x.where('c.bi_result', '=', 'pending');
    if (q.from) x = x.where(sql`(c.started_at AT TIME ZONE ${TZ})::date`, '>=', q.from);
    if (q.to) x = x.where(sql`(c.started_at AT TIME ZONE ${TZ})::date`, '<=', q.to);
    return x.execute();
  }
  async attach(id: string, file: Express.Multer.File, u: AuthUser, ctx: AuditContext) {
    await this.settings();
    const c = await this.cycleOne(id);
    await this.requireProcess(u, await this.unit(c.location_id));
    if (!/^image\/(jpeg|png|webp)$|^application\/pdf$/.test(file.mimetype)) throw new BadRequestException('ფაილი — JPG / PNG / WEBP / PDF');
    const key = `cssd/cycles/${id}/${Date.now()}-${file.originalname.replace(/[^A-Za-z0-9._-]/g, '_')}`;
    await this.storage.put(key, file.buffer, file.mimetype);
    await this.db.updateTable('cssd_cycles').set({ attachment_key: key }).where('id', '=', id).execute();
    await this.audit.log(ctx, { action: 'CSSD_CYCLE_ATTACH', entityName: 'cssd_cycles', entityId: id, newData: { key } });
    return this.cycleOne(id);
  }

  // ================================================================= შეფუთვები: საწყობი, გაცემა, გამოყენება
  private packsBase() {
    return this.db.selectFrom('cssd_packs as p').innerJoin('cssd_sets as s', 's.id', 'p.set_id').innerJoin('cssd_templates as t', 't.id', 's.template_id')
      .innerJoin('cssd_packaging_types as pt', 'pt.id', 'p.packaging_type_id').leftJoin('cssd_cycles as c', 'c.id', 'p.cycle_id').leftJoin('cssd_machines as m', 'm.id', 'c.machine_id')
      .leftJoin('departments as d', 'd.id', 'p.issued_department_id').leftJoin('patients as pa', 'pa.id', 'p.patient_id').innerJoin('users as pu', 'pu.id', 'p.packed_by')
      .select(['p.id', 'p.pack_no', 'p.set_id', 'p.location_id', 'p.status', 'p.packed_at', 'p.expires_on', 'p.ci_pass', 'p.incomplete', 'p.checklist', 'p.issued_department_id', 'p.issued_at', 'p.used_at', 'p.patient_id', 'p.note',
        's.barcode as set_barcode', 's.serial', 't.name as template_name', 't.is_implant', 'pt.name as packaging_name', 'c.cycle_no', 'c.bi_result', 'm.name as machine_name', 'd.name as department_name',
        sql<string | null>`pa.first_name || ' ' || pa.last_name`.as('patient_name'), 'pa.personal_number', sql<string>`pu.first_name || ' ' || pu.last_name`.as('packed_by_name'),
        sql<number | null>`p.expires_on - (now() AT TIME ZONE ${TZ})::date`.as('days_left')]);
  }
  async packOne(id: string) { const p = await this.packsBase().where('p.id', '=', id).executeTakeFirst(); if (!p) throw new NotFoundException('შეფუთვა ვერ მოიძებნა'); return p; }
  async packs(u: AuthUser, q: { status?: string; location_id?: string; department_id?: string; mine?: boolean; patient_id?: string }) {
    await this.settings();
    let x = this.packsBase().orderBy('p.expires_on').orderBy('p.pack_no').limit(1000);
    if (q.status) x = x.where('p.status', 'in', q.status.split(','));
    if (q.location_id) x = x.where('p.location_id', '=', q.location_id);
    if (q.department_id) x = x.where('p.issued_department_id', '=', q.department_id);
    if (q.patient_id) x = x.where('p.patient_id', '=', q.patient_id);
    if (q.mine) { const me = await this.me(u); x = x.where('p.issued_department_id', '=', me.department_id ?? '00000000-0000-0000-0000-000000000000'); }
    return x.execute();
  }

  async issue(dto: { location_id: string; department_id: string; pack_ids: string[] }, u: AuthUser, ctx: AuditContext) {
    await this.settings();
    const l = await this.unit(dto.location_id); await this.requireProcess(u, l);
    const today = await this.today();
    await this.db.transaction().execute(async (trx) => {
      const dep = await trx.selectFrom('departments').select(['id', 'is_active']).where('id', '=', dto.department_id).executeTakeFirst();
      if (!dep?.is_active) throw new BadRequestException('განყოფილება ვერ მოიძებნა');
      const packs = await trx.selectFrom('cssd_packs').selectAll().where('id', 'in', dto.pack_ids).forUpdate().execute();
      if (packs.length !== new Set(dto.pack_ids).size) throw new BadRequestException('შეფუთვა ვერ მოიძებნა');
      for (const p of packs) {
        if (p.location_id !== l.id) throw new BadRequestException(`${p.pack_no}: სხვა CSSD`);
        if (p.status === 'quarantine') throw new ConflictException(`${p.pack_no}: ქარანტინშია — BI-ს პასუხს ელოდება`);
        if (p.status !== 'sterile') throw new ConflictException(`${p.pack_no}: არ არის სტერილური (${p.status})`);
        if (p.expires_on && p.expires_on < today) throw new ConflictException(`${p.pack_no}: სტერილობის ვადა გასულია — ხელახალი დამუშავება`);
        await trx.updateTable('cssd_packs').set({ status: 'issued', issued_department_id: dto.department_id, issued_at: sql`now()`, issued_by: u.id }).where('id', '=', p.id).execute();
        await trx.updateTable('cssd_sets').set({ status: 'in_use', holder_department_id: dto.department_id }).where('id', '=', p.set_id).execute();
        await this.event(trx, p.set_id, p.id, 'issued', { department_id: dto.department_id }, u);
      }
      await this.audit.log(ctx, { action: 'CSSD_ISSUE', entityName: 'cssd_packs', entityId: dto.pack_ids[0], newData: dto }, trx);
    });
    return { issued: dto.pack_ids.length };
  }

  private async canDept(u: AuthUser, deptId: string | null) {
    if (has(u, 'admin')) return true;
    const me = await this.me(u);
    return !!deptId && me.department_id === deptId;
  }
  /** გამოყენება პაციენტზე (T2): სკანირება + პაციენტი; patient_trace = false — პაციენტი სურვილით */
  async use(id: string, dto: { patient_id?: string | null; encounter_id?: string | null; note?: string | null }, u: AuthUser, ctx: AuditContext) {
    const st = await this.settings();
    await this.db.transaction().execute(async (trx) => {
      const p = await trx.selectFrom('cssd_packs').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!p) throw new NotFoundException('შეფუთვა ვერ მოიძებნა');
      if (!(await this.canDept(u, p.issued_department_id))) throw new ForbiddenException('გამოყენება — გამცემი განყოფილების თანამშრომელი');
      if (p.status === 'recalled') throw new ConflictException('გაწვეულია — გამოყენება აკრძალულია!');
      if (p.status !== 'issued') throw new ConflictException(`შეფუთვა არ არის გაცემული (${p.status})`);
      if (p.expires_on && p.expires_on < await this.today(trx)) throw new ConflictException('სტერილობის ვადა გასულია — გამოყენება აკრძალულია');
      if (st.patient_trace && !dto.patient_id) throw new BadRequestException('პაციენტი სავალდებულოა (მიკვლევა)');
      if (dto.encounter_id && dto.patient_id) {
        const e = await trx.selectFrom('encounters').select('id').where('id', '=', dto.encounter_id).where('patient_id', '=', dto.patient_id).executeTakeFirst();
        if (!e) throw new BadRequestException('ვიზიტი ამ პაციენტს არ ეკუთვნის');
      }
      await trx.updateTable('cssd_packs').set({ status: 'used', used_at: sql`now()`, used_by: u.id, patient_id: dto.patient_id ?? null, encounter_id: dto.encounter_id ?? null, note: dto.note?.trim() || p.note })
        .where('id', '=', id).execute();
      await this.event(trx, p.set_id, id, 'used', { patient_id: dto.patient_id ?? null }, u);
      await this.audit.log(ctx, { action: 'CSSD_USE', entityName: 'cssd_packs', entityId: id, newData: dto }, trx);
    });
    return this.packOne(id);
  }
  /** გაუხსნელის დაბრუნება CSSD-ის საწყობში (ვადიანი → სტერილური; ვადაგასული → ხელახალი დამუშავება) */
  async returnUnused(id: string, u: AuthUser, ctx: AuditContext) {
    await this.settings();
    await this.db.transaction().execute(async (trx) => {
      const p = await trx.selectFrom('cssd_packs').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!p) throw new NotFoundException('შეფუთვა ვერ მოიძებნა');
      if (!(await this.canDept(u, p.issued_department_id)) && !(await this.canProcess(u, await this.unit(p.location_id, trx)))) throw new ForbiddenException('დაბრუნება — განყოფილება ან CSSD');
      if (!['issued', 'recalled'].includes(p.status) || !p.issued_department_id) throw new ConflictException('შეფუთვა განყოფილებაში არ არის');
      const expired = !!p.expires_on && p.expires_on < await this.today(trx);
      const next = p.status === 'recalled' ? 'recalled' : expired ? 'expired' : 'sterile';
      await trx.updateTable('cssd_packs').set({ status: next, issued_department_id: null }).where('id', '=', id).execute();
      await trx.updateTable('cssd_sets').set({ status: next === 'sterile' ? 'packed' : 'received', holder_department_id: null }).where('id', '=', p.set_id).execute();
      await this.event(trx, p.set_id, id, 'returned_unused', { status: next }, u);
      await this.audit.log(ctx, { action: 'CSSD_RETURN_UNUSED', entityName: 'cssd_packs', entityId: id, newData: { status: next } }, trx);
    });
    return this.packOne(id);
  }
  /** შენახვაში ვადაგასულის ხელახალი დამუშავება */
  async reprocess(id: string, u: AuthUser, ctx: AuditContext) {
    await this.settings();
    await this.db.transaction().execute(async (trx) => {
      const p = await trx.selectFrom('cssd_packs').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!p) throw new NotFoundException('შეფუთვა ვერ მოიძებნა');
      await this.requireProcess(u, await this.unit(p.location_id, trx));
      if (!['sterile', 'expired', 'failed'].includes(p.status)) throw new ConflictException(`ხელახალი დამუშავება — სტერილური / ვადაგასული / ჩავარდნილი (${p.status})`);
      await trx.updateTable('cssd_packs').set({ status: 'reprocess' }).where('id', '=', id).execute();
      await trx.updateTable('cssd_sets').set({ status: 'received' }).where('id', '=', p.set_id).execute();
      await this.event(trx, p.set_id, id, 'reprocess', { was: p.status }, u);
      await this.audit.log(ctx, { action: 'CSSD_REPROCESS', entityName: 'cssd_packs', entityId: id }, trx);
    });
    return this.packOne(id);
  }

  async labels(ids: string[], u: AuthUser) {
    const st = await this.settings();
    const rows = await this.packsBase().where('p.id', 'in', ids).orderBy('p.pack_no').execute();
    if (!rows.length) throw new NotFoundException('შეფუთვა ვერ მოიძებნა');
    for (const r of rows) await this.requireProcess(u, await this.unit(r.location_id));
    const [W, H] = st.label_size.split('x').map(Number);
    const { doc, done } = newDoc([mm(W), mm(H)], mm(1.5));
    const d = (x: string | null) => (x ? `${x.slice(8, 10)}/${x.slice(5, 7)}/${x.slice(0, 4)}` : '—');
    for (const r of rows) {
      doc.addPage(); const pad = mm(1.5);
      if (st.label_code === 'qr') {
        const side = mm(H - 3);
        doc.image(await bwipjs.toBuffer({ bcid: 'qrcode', text: r.pack_no, scale: 4 }), pad, pad, { width: side, height: side });
        const x = pad + side + mm(1.5); const tw = mm(W) - x - pad; const big = H >= 30;
        doc.font('B').fontSize(big ? 9 : 7).text(r.pack_no, x, pad, { width: tw, lineBreak: false });
        doc.font('R').fontSize(big ? 6.5 : 5).text(`${r.template_name} ${r.serial ?? ''}`.slice(0, 60), x, pad + mm(big ? 4.5 : 3.4), { width: tw, height: mm(H / 3.2) });
        doc.font('B').fontSize(big ? 6.5 : 5).text(`ვადა: ${d(r.expires_on)}`, x, mm(H) - pad - mm(big ? 8 : 6.2), { width: tw, lineBreak: false });
        doc.font('R').fontSize(big ? 5.5 : 4.5).text(`${dt(r.packed_at).slice(0, 10)} · ${r.packed_by_name}`.slice(0, 45), x, mm(H) - pad - mm(big ? 4.5 : 3.6), { width: tw, lineBreak: false });
      } else {
        const tw = mm(W) - 2 * pad;
        doc.font('B').fontSize(6).text(`${r.template_name} ${r.serial ?? ''}`.slice(0, 50), pad, pad, { width: tw, lineBreak: false });
        doc.image(await bwipjs.toBuffer({ bcid: 'code128', text: r.pack_no, scale: 3, height: 8, includetext: false }), pad, pad + mm(2.8), { width: tw, height: mm(H * 0.4) });
        doc.font('B').fontSize(6.5).text(`${r.pack_no} · ვადა ${d(r.expires_on)}`, pad, pad + mm(3) + mm(H * 0.4), { width: tw, align: 'center', lineBreak: false });
        doc.font('R').fontSize(4.8).text(`${dt(r.packed_at).slice(0, 10)} · ${r.packed_by_name}`.slice(0, 50), pad, mm(H) - pad - mm(2.3), { width: tw, align: 'center', lineBreak: false });
      }
    }
    doc.end();
    return done;
  }

  /** რეპორტი პერიოდით: ციკლები აპარატით (შედეგი, BI), დამუშავებული / გაცემული / გამოყენებული ნაკრების ტიპით, გაწვევები */
  async report(q: { from: string; to: string }) {
    await this.settings();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(q.from) || !/^\d{4}-\d{2}-\d{2}$/.test(q.to) || q.from > q.to) throw new BadRequestException('პერიოდი: from ≤ to');
    const inP = (col: string) => sql<boolean>`(${sql.ref(col)} AT TIME ZONE ${TZ})::date BETWEEN ${q.from}::date AND ${q.to}::date`;
    const [cycles, templates] = await Promise.all([
      this.db.selectFrom('cssd_cycles as c').innerJoin('cssd_machines as m', 'm.id', 'c.machine_id')
        .select(['m.name as machine_name', 'c.kind', sql<number>`count(*)::int`.as('total'), sql<number>`count(*) FILTER (WHERE c.result = 'fail')::int`.as('failed'),
          sql<number>`count(*) FILTER (WHERE c.bi_used)::int`.as('bi'), sql<number>`count(*) FILTER (WHERE c.bi_result = 'fail')::int`.as('bi_failed')])
        .where(inP('c.started_at')).groupBy(['m.name', 'c.kind']).orderBy('m.name').execute(),
      this.db.selectFrom('cssd_packs as p').innerJoin('cssd_sets as s', 's.id', 'p.set_id').innerJoin('cssd_templates as t', 't.id', 's.template_id')
        .select(['t.name as template_name', sql<number>`count(*) FILTER (WHERE ${inP('p.packed_at')})::int`.as('packed'),
          sql<number>`count(*) FILTER (WHERE p.issued_at IS NOT NULL AND ${inP('p.issued_at')})::int`.as('issued'),
          sql<number>`count(*) FILTER (WHERE p.used_at IS NOT NULL AND ${inP('p.used_at')})::int`.as('used'),
          sql<number>`count(*) FILTER (WHERE p.status = 'recalled' AND ${inP('p.packed_at')})::int`.as('recalled'),
          sql<number>`count(*) FILTER (WHERE p.incomplete AND ${inP('p.packed_at')})::int`.as('incomplete')])
        .groupBy('t.name').orderBy('t.name').execute()]);
    return { cycles, templates: templates.filter((t) => t.packed || t.issued || t.used) };
  }
}

// ======================================================================= DTO
class ConsDto { @IsUUID() item_id: string; @IsNumber() @Min(0.001) @Max(1000) qty: number }
class PackagingDto { @IsOptional() @IsString() @Length(2, 120) name?: string; @IsOptional() @IsInt() @Min(1) @Max(3650) shelf_days?: number | null;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => ConsDto) consumables?: ConsDto[]; @IsOptional() @IsBoolean() is_active?: boolean; @IsOptional() @IsInt() sort_order?: number }
class ProgramDto { @IsString() @Length(1, 60) name: string; @IsOptional() @IsNumber() temp?: number; @IsOptional() @IsNumber() minutes?: number }
class MachineDto { @IsOptional() @IsString() @Length(2, 120) name?: string; @IsOptional() @IsIn(['steam', 'plasma', 'eo', 'dry_heat', 'washer']) kind?: string; @IsOptional() @IsUUID() location_id?: string;
  @IsOptional() @IsString() @MaxLength(120) manufacturer?: string | null; @IsOptional() @IsString() @MaxLength(120) model?: string | null; @IsOptional() @IsString() @MaxLength(120) serial_no?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => ProgramDto) programs?: ProgramDto[]; @IsOptional() @IsBoolean() is_active?: boolean }
class TItemDto { @IsString() @Length(1, 200) name: string; @IsInt() @Min(1) @Max(1000) qty: number }
class TemplateDto { @IsOptional() @IsString() @Matches(/^[A-Z0-9][A-Z0-9_-]{1,29}$/) code?: string; @IsOptional() @IsString() @Length(2, 200) name?: string; @IsOptional() @IsUUID() owner_department_id?: string | null;
  @IsOptional() @IsUUID() packaging_type_id?: string | null; @IsOptional() @IsBoolean() is_implant?: boolean; @IsOptional() @IsString() @MaxLength(60) program_hint?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string | null; @IsOptional() @IsBoolean() is_active?: boolean; @IsOptional() @IsArray() @ArrayMaxSize(300) @ValidateNested({ each: true }) @Type(() => TItemDto) items?: TItemDto[] }
class SetsDto { @IsUUID() template_id: string; @IsUUID() home_location_id: string; @IsOptional() @IsInt() @Min(1) @Max(50) count?: number; @IsOptional() @IsString() @Matches(/^[A-Za-z0-9\-/._]{2,40}$/) barcode?: string | null; @IsOptional() @IsString() @MaxLength(20) serial?: string | null }
class InstrumentDto { @IsOptional() @IsString() @Length(2, 60) code?: string; @IsOptional() @IsString() @Length(2, 200) name?: string; @IsOptional() @IsUUID() set_id?: string | null; @IsOptional() @IsInt() @Min(1) max_cycles?: number | null;
  @IsOptional() @IsIn(['active', 'repair', 'retired']) status?: string; @IsOptional() @IsString() @MaxLength(1000) notes?: string | null }
class ReceiveDto { @IsUUID() location_id: string; @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @IsUUID('all', { each: true }) set_ids: string[]; @IsOptional() @IsString() @MaxLength(500) note?: string | null }
class WashDto { @IsUUID() location_id: string; @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @IsUUID('all', { each: true }) set_ids: string[]; @IsOptional() @IsUUID() machine_id?: string | null;
  @IsOptional() @IsString() @MaxLength(30) cycle_no?: string | null; @IsOptional() @IsString() @MaxLength(60) program?: string | null; @IsOptional() @IsIn(['pass', 'fail']) result?: 'pass' | 'fail'; @IsOptional() @IsString() @MaxLength(1000) notes?: string | null }
class CheckDto { @IsInt() @Min(1) line_no: number; @IsInt() @Min(0) @Max(1000) counted: number; @IsOptional() @IsString() @MaxLength(300) note?: string | null }
class PackDto { @IsUUID() set_id: string; @IsOptional() @IsUUID() packaging_type_id?: string | null; @IsOptional() @IsArray() @ArrayMaxSize(300) @ValidateNested({ each: true }) @Type(() => CheckDto) checklist?: CheckDto[]; @IsOptional() @IsString() @MaxLength(500) note?: string | null }
class CycleDto { @IsUUID() machine_id: string; @IsIn(['sterilize', 'bowie_dick']) kind: 'sterilize' | 'bowie_dick'; @IsOptional() @IsString() @MaxLength(30) cycle_no?: string | null; @IsOptional() @IsString() @MaxLength(60) program?: string | null;
  @IsOptional() @IsNumber() @Min(0) @Max(300) temp_c?: number | null; @IsOptional() @IsNumber() @Min(0) @Max(1000) minutes?: number | null; @IsOptional() @IsNumber() @Min(0) @Max(10) pressure_bar?: number | null;
  @IsIn(['pass', 'fail']) result: 'pass' | 'fail'; @IsOptional() @IsBoolean() bi_used?: boolean; @IsOptional() @IsString() @MaxLength(40) bi_lot?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(300) @IsUUID('all', { each: true }) pack_ids?: string[]; @IsOptional() @IsArray() @ArrayMaxSize(300) @IsUUID('all', { each: true }) ci_fail_pack_ids?: string[]; @IsOptional() @IsString() @MaxLength(1000) notes?: string | null }
class BiDto { @IsIn(['pass', 'fail']) result: 'pass' | 'fail' }
class IssueDto { @IsUUID() location_id: string; @IsUUID() department_id: string; @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @IsUUID('all', { each: true }) pack_ids: string[] }
class UseDto { @IsOptional() @IsUUID() patient_id?: string | null; @IsOptional() @IsUUID() encounter_id?: string | null; @IsOptional() @IsString() @MaxLength(500) note?: string | null }
class ReasonDto { @IsString() @Length(3, 500) reason: string }
const uuidOk = (v?: string) => !v || /^[0-9a-f-]{36}$/i.test(v);
const dateOk = (v?: string) => !v || /^\d{4}-\d{2}-\d{2}$/.test(v);

@Controller('cssd')
export class CssdController {
  constructor(private readonly s: CssdService) {}
  @Get('refs') refs(@CurrentUser() u: AuthUser) { return this.s.refs(u); }
  @Post('packaging') pkg(@Body() d: PackagingDto, @CurrentUser() u: AuthUser, @Req() r: Request) { if (!d.name) throw new BadRequestException('დასახელება სავალდებულოა'); return this.s.savePackaging(null, d, u, auditCtx(r)); }
  @Patch('packaging/:id') pkgU(@Param('id', ParseUUIDPipe) id: string, @Body() d: PackagingDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.savePackaging(id, d, u, auditCtx(r)); }
  @Post('machines') mach(@Body() d: MachineDto, @CurrentUser() u: AuthUser, @Req() r: Request) { if (!d.name || !d.kind || !d.location_id) throw new BadRequestException('დასახელება, ტიპი, ერთეული — სავალდებულო'); return this.s.saveMachine(null, d, u, auditCtx(r)); }
  @Patch('machines/:id') machU(@Param('id', ParseUUIDPipe) id: string, @Body() d: MachineDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.saveMachine(id, d, u, auditCtx(r)); }
  @Get('templates/:id') tpl(@Param('id', ParseUUIDPipe) id: string) { return this.s.template(id); }
  @Post('templates') tplC(@Body() d: TemplateDto, @CurrentUser() u: AuthUser, @Req() r: Request) { if (!d.code || !d.name) throw new BadRequestException('კოდი და დასახელება სავალდებულოა'); return this.s.saveTemplate(null, d, u, auditCtx(r)); }
  @Patch('templates/:id') tplU(@Param('id', ParseUUIDPipe) id: string, @Body() d: TemplateDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.saveTemplate(id, d, u, auditCtx(r)); }
  @Get('sets') sets(@Query() q: { search?: string; status?: string; location_id?: string; template_id?: string }) {
    if (!uuidOk(q.location_id) || !uuidOk(q.template_id)) throw new BadRequestException('არასწორი id');
    if (q.status && q.status.split(',').some((x) => !['available', 'received', 'washed', 'packed', 'in_use', 'retired'].includes(x))) throw new BadRequestException('უცნობი სტატუსი');
    return this.s.sets(q);
  }
  @Post('sets') setsC(@Body() d: SetsDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.createSets(d, u, auditCtx(r)); }
  @Get('sets/:id') set(@Param('id', ParseUUIDPipe) id: string) { return this.s.set(id); }
  @Post('sets/:id/retire') @HttpCode(200) retire(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.retireSet(id, d.reason, u, auditCtx(r)); }
  @Get('scan/:code') scan(@Param('code') code: string) { if (!/^[A-Za-z0-9\-/._]{2,40}$/.test(code)) throw new BadRequestException('არასწორი კოდი'); return this.s.scan(code); }
  @Get('instruments') instruments(@Query('set_id') set_id?: string, @Query('search') search?: string) { if (!uuidOk(set_id)) throw new BadRequestException('არასწორი id'); return this.s.instruments({ set_id, search }); }
  @Post('instruments') instC(@Body() d: InstrumentDto, @CurrentUser() u: AuthUser, @Req() r: Request) { if (!d.code || !d.name) throw new BadRequestException('კოდი და დასახელება სავალდებულოა'); return this.s.saveInstrument(null, d, u, auditCtx(r)); }
  @Patch('instruments/:id') instU(@Param('id', ParseUUIDPipe) id: string, @Body() d: InstrumentDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.saveInstrument(id, d, u, auditCtx(r)); }
  @Post('receive') @HttpCode(200) receive(@Body() d: ReceiveDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.receive(d, u, auditCtx(r)); }
  @Post('wash') @HttpCode(200) wash(@Body() d: WashDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.wash(d, u, auditCtx(r)); }
  @Post('pack') pack(@Body() d: PackDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.pack(d, u, auditCtx(r)); }
  @Get('bi-required') async biReq(@Query('machine_id') m: string, @Query('implant') implant?: string) { if (!uuidOk(m) || !m) throw new BadRequestException('machine_id'); return this.s.biRequired(m, implant === 'true'); }
  @Get('cycles') cycles(@Query() q: { location_id?: string; machine_id?: string; kind?: string; bi_pending?: string; from?: string; to?: string }) {
    if (!uuidOk(q.location_id) || !uuidOk(q.machine_id) || !dateOk(q.from) || !dateOk(q.to)) throw new BadRequestException('არასწორი ფილტრი');
    return this.s.cycles({ ...q, bi_pending: q.bi_pending === 'true' });
  }
  @Post('cycles') cycle(@Body() d: CycleDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.cycle(d, u, auditCtx(r)); }
  @Get('cycles/:id') cycleOne(@Param('id', ParseUUIDPipe) id: string) { return this.s.cycleOne(id); }
  @Post('cycles/:id/bi') @HttpCode(200) bi(@Param('id', ParseUUIDPipe) id: string, @Body() d: BiDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.biResult(id, d.result, u, auditCtx(r)); }
  @Post('cycles/:id/attachment') @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }))
  attach(@Param('id', ParseUUIDPipe) id: string, @UploadedFile() f: Express.Multer.File | undefined, @CurrentUser() u: AuthUser, @Req() r: Request) { if (!f) throw new BadRequestException('ფაილი არ არის'); return this.s.attach(id, f, u, auditCtx(r)); }
  @Get('packs') packs(@CurrentUser() u: AuthUser, @Query() q: { status?: string; location_id?: string; department_id?: string; mine?: string; patient_id?: string }) {
    if (!uuidOk(q.location_id) || !uuidOk(q.department_id) || !uuidOk(q.patient_id)) throw new BadRequestException('არასწორი id');
    return this.s.packs(u, { ...q, mine: q.mine === 'true' });
  }
  @Get('packs/:id') pack1(@Param('id', ParseUUIDPipe) id: string) { return this.s.packOne(id); }
  @Post('issue') @HttpCode(200) issue(@Body() d: IssueDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.issue(d, u, auditCtx(r)); }
  @Post('packs/:id/use') @HttpCode(200) use(@Param('id', ParseUUIDPipe) id: string, @Body() d: UseDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.use(id, d, u, auditCtx(r)); }
  @Post('packs/:id/return') @HttpCode(200) ret(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.returnUnused(id, u, auditCtx(r)); }
  @Post('packs/:id/reprocess') @HttpCode(200) rep(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.reprocess(id, u, auditCtx(r)); }
  @Get('labels') async labels(@Query('ids') ids: string, @CurrentUser() u: AuthUser, @Res() res: Response) {
    const list = (ids ?? '').split(',').filter(Boolean);
    if (!list.length || list.length > 300 || !list.every((x) => uuidOk(x))) throw new BadRequestException('ids');
    const buf = await this.s.labels(list, u);
    res.setHeader('content-type', 'application/pdf'); res.setHeader('content-disposition', 'inline; filename="cssd-labels.pdf"'); res.end(buf);
  }
  @Get('report') @Roles('admin', 'stock_manager', 'manager', 'viewer', 'nurse', 'doctor') report(@Query() q: { from: string; to: string }) { return this.s.report(q); }
}

@Module({ controllers: [CssdController], providers: [CssdService] })
export class CssdModule {}
