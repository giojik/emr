import { forwardRef, Inject,  BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe,
  Patch, Post, Put, Req, Res, StreamableFile } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Length, MaxLength, Min, ValidateNested } from 'class-validator';
import type { Request, Response } from 'express';
import { sql } from 'kysely';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { auditCtx } from '../audit/audit-context';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser } from '../auth/roles';
import { InjectDb, type Database } from '../database/database.module';
import { ClinicSettingsService } from '../settings/clinic-settings';
import { d, dt, newDoc } from './diagnostics.pdf';
import { DiagnosticsService } from './diagnostics.service';
import { LabDeliveryService } from './lab-delivery';

const LAB_STAFF = ['admin', 'diagnostic', 'lab_doctor', 'lab_manager'] as const;
const EDITABLE = ['collected', 'in_progress', 'resulted'];
export interface MicroSnapshot {
  stage: string; gram_stain: string | null; growth_summary: string | null; comment: string | null;
  isolates: { seq: number; organism: string | null; organism_code: string | null; quantity: string | null; comment: string | null;
    ast: { code: string; name: string; mic: string | null; zone_mm: string | null; interp: string | null }[] }[];
}
const STAGE_KA: Record<string, string> = { incubating: 'ინკუბაცია — ზრდა ჯერ არ შეფასებულა', no_growth: 'ზრდა არ აღინიშნა', growth: 'ზრდა', contaminated: 'კონტამინაცია (შერეული ფლორა) — გთხოვთ, ნიმუში განმეორებით' };

/**
 * მიკრობიოლოგია: კულტურა (სტადია, გრამის შეღებვა, ზრდა) → იზოლატები (მიკროორგანიზმი, რაოდენობა) → ანტიბიოგრამა (MIC / ზონა → S/I/R, ხელით)
 * → წინასწარი პასუხი (ლაბ. ექიმი, ექიმს ჩანს) → საბოლოო (ვალიდაცია). ექიმთან — მხოლოდ მონიშნული ანტიბიოტიკები; სარეზერვო — თუ პირველი რიგის რეზისტენტობაა ან ხელით მონიშნულია.
 */
@Injectable()
export class LabMicroService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService, private readonly dx: DiagnosticsService, private readonly clinic: ClinicSettingsService) {}

  // =============================================================== ცნობარი
  refs() {
    return Promise.all([
      this.db.selectFrom('micro_organisms').selectAll().orderBy('is_active', 'desc').orderBy('name').execute(),
      this.db.selectFrom('micro_antibiotics').selectAll().orderBy('is_active', 'desc').orderBy('name').execute(),
      this.db.selectFrom('micro_panels as p').selectAll('p')
        .select((eb) => eb.selectFrom('micro_panel_items as pi').innerJoin('micro_antibiotics as a', 'a.id', 'pi.antibiotic_id')
          .select(sql<unknown>`coalesce(json_agg(json_build_object('antibiotic_id', a.id, 'code', a.code, 'name', a.name, 'reserve', pi.reserve, 'sort_order', pi.sort_order) ORDER BY pi.sort_order), '[]')`.as('x'))
          .whereRef('pi.panel_id', '=', 'p.id').as('items')).orderBy('p.name').execute(),
    ]).then(([organisms, antibiotics, panels]) => ({ organisms, antibiotics, panels }));
  }
  private async requireManage(u: AuthUser) { if (!has(u, 'admin') && !has(u, 'lab_doctor') && !has(u, 'lab_manager')) throw new ForbiddenException('ცნობარს მართავს ლაბ. ექიმი / მენეჯერი'); }
  async saveOrganism(id: string | null, dto: { code?: string; name?: string; gram?: string; group_code?: string; is_active?: boolean }, u: AuthUser, ctx: AuditContext) {
    await this.requireManage(u);
    const vals = Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined));
    const r = id ? await this.db.updateTable('micro_organisms').set(vals).where('id', '=', id).returningAll().executeTakeFirst()
      : await this.db.insertInto('micro_organisms').values({ code: dto.code!, name: dto.name!, gram: dto.gram as 'pos', group_code: dto.group_code ?? 'OTH' }).returningAll().executeTakeFirst();
    if (!r) throw new NotFoundException('ვერ მოიძებნა');
    await this.audit.log(ctx, { action: 'MICRO_ORGANISM', entityName: 'micro_organisms', entityId: r.id, newData: vals });
    return r;
  }
  async saveAntibiotic(id: string | null, dto: { code?: string; name?: string; class?: string | null; is_active?: boolean }, u: AuthUser, ctx: AuditContext) {
    await this.requireManage(u);
    const vals = Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined));
    const r = id ? await this.db.updateTable('micro_antibiotics').set(vals).where('id', '=', id).returningAll().executeTakeFirst()
      : await this.db.insertInto('micro_antibiotics').values({ code: dto.code!, name: dto.name!, class: dto.class ?? null }).returningAll().executeTakeFirst();
    if (!r) throw new NotFoundException('ვერ მოიძებნა');
    await this.audit.log(ctx, { action: 'MICRO_ANTIBIOTIC', entityName: 'micro_antibiotics', entityId: r.id, newData: vals });
    return r;
  }
  async setPanelItems(panelId: string, items: { antibiotic_id: string; reserve: boolean }[], u: AuthUser, ctx: AuditContext) {
    await this.requireManage(u);
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('micro_panel_items').where('panel_id', '=', panelId).execute();
      if (items.length) await trx.insertInto('micro_panel_items').values(items.map((x, i) => ({ panel_id: panelId, antibiotic_id: x.antibiotic_id, reserve: x.reserve, sort_order: i }))).execute();
      await this.audit.log(ctx, { action: 'MICRO_PANEL', entityName: 'micro_panels', entityId: panelId, newData: { items: items.length } }, trx);
    });
    return this.refs();
  }

  // =============================================================== კულტურა
  private async item(itemId: string) {
    const it = await this.db.selectFrom('dx_order_items as i').innerJoin('dx_services as s', 's.id', 'i.service_id').innerJoin('patients as p', 'p.id', 'i.patient_id')
      .leftJoin('lab_specimens as sp', 'sp.id', 'i.specimen_id')
      .select(['i.id', 'i.status', 'i.patient_id', 'i.encounter_id', 's.name as service_name', 's.is_micro', 's.specimen_type', 'p.first_name', 'p.last_name', 'p.birth_date', 'p.gender',
        'p.personal_number', 'sp.barcode', 'sp.collected_at', 'i.validated_at'])
      .where('i.id', '=', itemId).executeTakeFirst();
    if (!it?.is_micro) throw new NotFoundException('მიკრობიოლოგიური შეკვეთა ვერ მოიძებნა');
    return it;
  }
  private async culture(itemId: string) {
    const c = await this.db.selectFrom('micro_cultures').selectAll().where('order_item_id', '=', itemId).executeTakeFirst();
    return c ?? this.db.insertInto('micro_cultures').values({ order_item_id: itemId }).onConflict((oc) => oc.column('order_item_id').doNothing()).returningAll().executeTakeFirst()
      .then(async (r) => r ?? (await this.db.selectFrom('micro_cultures').selectAll().where('order_item_id', '=', itemId).executeTakeFirstOrThrow()));
  }
  private editable(status: string) { if (!EDITABLE.includes(status)) throw new ConflictException(status === 'validated' ? 'საბოლოო პასუხი დადასტურებულია — შესწორება (reopen)' : `სტატუსზე „${status}“ დაუშვებელია`); }

  async detail(itemId: string) {
    const it = await this.item(itemId);
    const c = await this.culture(itemId);
    const isolates = await this.db.selectFrom('micro_isolates as i').leftJoin('micro_organisms as o', 'o.id', 'i.organism_id').leftJoin('micro_panels as p', 'p.id', 'i.panel_id')
      .select(['i.id', 'i.seq', 'i.organism_id', 'o.name as organism', 'o.code as organism_code', 'o.gram', 'i.quantity', 'i.comment', 'i.panel_id', 'p.name as panel',
        (eb) => eb.selectFrom('micro_ast as a').innerJoin('micro_antibiotics as ab', 'ab.id', 'a.antibiotic_id')
          .select(sql<unknown>`coalesce(json_agg(json_build_object('antibiotic_id', ab.id, 'code', ab.code, 'name', ab.name, 'class', ab.class, 'mic', a.mic, 'zone_mm', a.zone_mm,
            'interp', a.interp, 'reported', a.reported, 'reserve', a.reserve) ORDER BY a.sort_order, ab.name), '[]')`.as('x')).whereRef('a.isolate_id', '=', 'i.id').as('ast')])
      .where('i.culture_id', '=', c.id).orderBy('i.seq').execute();
    const reports = await this.db.selectFrom('micro_reports as r').leftJoin('users as u', 'u.id', 'r.issued_by')
      .select(['r.id', 'r.kind', 'r.issued_at', sql<string | null>`u.first_name || ' ' || u.last_name`.as('issued_by_name')]).where('r.order_item_id', '=', itemId).orderBy('r.issued_at', 'desc').execute();
    return { item: it, culture: c, isolates, reports };
  }
  async updateCulture(itemId: string, dto: { stage?: string; gram_stain?: string | null; growth_summary?: string | null; comment?: string | null }, u: AuthUser, ctx: AuditContext) {
    const it = await this.item(itemId); this.editable(it.status);
    const c = await this.culture(itemId);
    const vals = { ...Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined)), updated_by: u.id, updated_at: sql<Date>`now()` };
    await this.db.updateTable('micro_cultures').set(vals).where('id', '=', c.id).execute();
    if (it.status === 'collected') await this.db.updateTable('dx_order_items').set({ status: 'in_progress' }).where('id', '=', itemId).execute();
    await this.audit.log(ctx, { action: 'MICRO_CULTURE', entityName: 'dx_order_items', entityId: itemId, newData: dto });
    return this.detail(itemId);
  }
  /** იზოლატი: ანტიბიოტიკები — პანელიდან (მიკროორგანიზმის ჯგუფით, ან არჩეული); სარეზერვო — ნაგულისხმევად არ ჩანს ექიმთან */
  async addIsolate(itemId: string, dto: { organism_id: string; quantity?: string | null; comment?: string | null; panel_id?: string | null }, u: AuthUser, ctx: AuditContext) {
    const it = await this.item(itemId); this.editable(it.status);
    const c = await this.culture(itemId);
    const org = await this.db.selectFrom('micro_organisms').select(['id', 'group_code', 'name']).where('id', '=', dto.organism_id).executeTakeFirst();
    if (!org) throw new BadRequestException('მიკროორგანიზმი ვერ მოიძებნა');
    const panel = dto.panel_id ? await this.db.selectFrom('micro_panels').select('id').where('id', '=', dto.panel_id).executeTakeFirst()
      : await this.db.selectFrom('micro_panels').select('id').where('group_code', '=', org.group_code).where('is_active', '=', true).orderBy('code').executeTakeFirst();
    const id = await this.db.transaction().execute(async (trx) => {
      const seq = await trx.selectFrom('micro_isolates').select((e) => e.fn.max('seq').as('m')).where('culture_id', '=', c.id).executeTakeFirst();
      const iso = await trx.insertInto('micro_isolates').values({ culture_id: c.id, seq: Number(seq?.m ?? 0) + 1, organism_id: org.id, quantity: dto.quantity ?? null, comment: dto.comment ?? null, panel_id: panel?.id ?? null })
        .returning('id').executeTakeFirstOrThrow();
      if (panel) {
        const items = await trx.selectFrom('micro_panel_items').select(['antibiotic_id', 'reserve', 'sort_order']).where('panel_id', '=', panel.id).execute();
        if (items.length) await trx.insertInto('micro_ast').values(items.map((x) => ({ isolate_id: iso.id, antibiotic_id: x.antibiotic_id, reserve: x.reserve, reported: !x.reserve, sort_order: x.sort_order }))).execute();
      }
      await trx.updateTable('micro_cultures').set({ stage: 'growth', updated_by: u.id, updated_at: sql`now()` }).where('id', '=', c.id).execute();
      if (it.status === 'collected') await trx.updateTable('dx_order_items').set({ status: 'in_progress' }).where('id', '=', itemId).execute();
      await this.audit.log(ctx, { action: 'MICRO_ISOLATE_ADD', entityName: 'dx_order_items', entityId: itemId, newData: { organism: org.name, quantity: dto.quantity } }, trx);
      return iso.id;
    });
    return { id, ...(await this.detail(itemId)) };
  }
  private async isolate(isolateId: string) {
    const r = await this.db.selectFrom('micro_isolates as i').innerJoin('micro_cultures as c', 'c.id', 'i.culture_id').innerJoin('dx_order_items as it', 'it.id', 'c.order_item_id')
      .select(['i.id', 'c.order_item_id', 'it.status']).where('i.id', '=', isolateId).executeTakeFirst();
    if (!r) throw new NotFoundException('იზოლატი ვერ მოიძებნა');
    this.editable(r.status); return r;
  }
  async updateIsolate(isolateId: string, dto: { organism_id?: string; quantity?: string | null; comment?: string | null }, ctx: AuditContext) {
    const r = await this.isolate(isolateId);
    await this.db.updateTable('micro_isolates').set(Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined))).where('id', '=', isolateId).execute();
    await this.audit.log(ctx, { action: 'MICRO_ISOLATE_UPDATE', entityName: 'dx_order_items', entityId: r.order_item_id, newData: dto });
    return this.detail(r.order_item_id);
  }
  async deleteIsolate(isolateId: string, ctx: AuditContext) {
    const r = await this.isolate(isolateId);
    await this.db.deleteFrom('micro_isolates').where('id', '=', isolateId).execute();
    await this.audit.log(ctx, { action: 'MICRO_ISOLATE_DELETE', entityName: 'dx_order_items', entityId: r.order_item_id, newData: { isolate: isolateId } });
    return this.detail(r.order_item_id);
  }
  /** ანტიბიოგრამა: MIC / ზონა (სურვილისამებრ) + S/I/R (ხელით) + „ექიმთან ჩანს“; პანელის გარეთ ანტიბიოტიკის დამატებაც */
  async saveAst(isolateId: string, rows: { antibiotic_id: string; mic?: string | null; zone_mm?: number | null; interp?: 'S' | 'I' | 'R' | null; reported?: boolean }[], ctx: AuditContext) {
    const r = await this.isolate(isolateId);
    await this.db.transaction().execute(async (trx) => {
      const cur = await trx.selectFrom('micro_ast').select(['antibiotic_id', 'sort_order']).where('isolate_id', '=', isolateId).execute();
      let next = Math.max(0, ...cur.map((c) => c.sort_order)) + 1;
      for (const x of rows) {
        const vals = { mic: x.mic?.trim() || null, zone_mm: x.zone_mm === null || x.zone_mm === undefined ? null : String(x.zone_mm), interp: x.interp ?? null, ...(x.reported !== undefined ? { reported: x.reported } : {}) };
        if (cur.some((c) => c.antibiotic_id === x.antibiotic_id)) await trx.updateTable('micro_ast').set(vals).where('isolate_id', '=', isolateId).where('antibiotic_id', '=', x.antibiotic_id).execute();
        else await trx.insertInto('micro_ast').values({ isolate_id: isolateId, antibiotic_id: x.antibiotic_id, sort_order: next++, reported: x.reported ?? true, ...vals }).execute();
      }
      await this.audit.log(ctx, { action: 'MICRO_AST', entityName: 'dx_order_items', entityId: r.order_item_id, newData: { isolate: isolateId, rows: rows.length } }, trx);
    });
    return this.detail(r.order_item_id);
  }

  // =============================================================== პასუხი
  /** ექიმისთვის: მონიშნული ანტიბიოტიკები; სარეზერვო — თუ მონიშნულია, ან პირველი რიგიდან რომელიმე R-ია (კასკადი) */
  async snapshot(itemId: string): Promise<MicroSnapshot> {
    const d0 = await this.detail(itemId);
    type Ast = { code: string; name: string; mic: string | null; zone_mm: string | null; interp: string | null; reported: boolean; reserve: boolean };
    return { stage: d0.culture.stage, gram_stain: d0.culture.gram_stain, growth_summary: d0.culture.growth_summary, comment: d0.culture.comment,
      isolates: d0.isolates.map((i) => {
        const ast = (i.ast as Ast[]) ?? [];
        const firstLineR = ast.some((a) => !a.reserve && a.interp === 'R');
        return { seq: i.seq, organism: i.organism, organism_code: i.organism_code, quantity: i.quantity, comment: i.comment,
          ast: ast.filter((a) => a.interp && (a.reserve ? a.reported || firstLineR : a.reported)).map((a) => ({ code: a.code, name: a.name, mic: a.mic, zone_mm: a.zone_mm, interp: a.interp })) };
      }) };
  }
  /** წინასწარი პასუხი — ლაბ. ექიმი; ექიმთან ჩანს, სანამ საბოლოო არ დადასტურდება */
  async prelim(itemId: string, u: AuthUser, ctx: AuditContext) {
    if (!has(u, 'admin') && !has(u, 'lab_doctor')) throw new ForbiddenException('წინასწარ პასუხს გასცემს ლაბ. ექიმი');
    const it = await this.item(itemId); this.editable(it.status);
    const snap = await this.snapshot(itemId);
    const r = await this.db.insertInto('micro_reports').values({ order_item_id: itemId, kind: 'prelim', snapshot: JSON.stringify(snap), issued_by: u.id }).returning(['id', 'issued_at']).executeTakeFirstOrThrow();
    await this.audit.log(ctx, { action: 'MICRO_PRELIM', entityName: 'dx_order_items', entityId: itemId, newData: { stage: snap.stage, isolates: snap.isolates.length } });
    return r;
  }
  /** ლაბორანტი: შედეგი მზადაა (→ „ვალიდაციას ელოდება“). ინკუბაციის სტადიაზე — არა; ზრდისას — მინიმუმ ერთი იზოლატი */
  async complete(itemId: string, ctx: AuditContext) {
    const it = await this.item(itemId); this.editable(it.status);
    const d0 = await this.detail(itemId);
    if (d0.culture.stage === 'incubating') throw new BadRequestException('ჯერ შეაფასეთ ზრდა (ზრდა / ზრდა არ აღინიშნა / კონტამინაცია)');
    if (d0.culture.stage === 'growth' && !d0.isolates.length) throw new BadRequestException('ზრდისას დაამატეთ მიკროორგანიზმი');
    await this.db.updateTable('dx_order_items').set({ status: 'resulted', resulted_at: sql`now()` }).where('id', '=', itemId).execute();
    await this.audit.log(ctx, { action: 'MICRO_COMPLETE', entityName: 'dx_order_items', entityId: itemId });
    return { id: itemId, status: 'resulted' };
  }
  /** საბოლოო: ვალიდაცია (ლაბ. ექიმი) + საბოლოო პასუხის ფიქსაცია */
  async final(itemId: string, u: AuthUser, ctx: AuditContext) {
    await this.item(itemId);
    const r = await this.dx.validate(itemId, u, ctx);
    await this.db.insertInto('micro_reports').values({ order_item_id: itemId, kind: 'final', snapshot: JSON.stringify(await this.snapshot(itemId)), issued_by: u.id }).execute();
    return r;
  }
  /** ექიმის ხედი: დადასტურებული — საბოლოო; თორემ ბოლო წინასწარი (ან არაფერი). ლაბორატორია — მიმდინარე მდგომარეობა */
  async view(itemId: string, u: AuthUser) {
    const it = await this.item(itemId);
    const lab = LAB_STAFF.some((r) => has(u, r));
    if (it.status === 'validated') {
      const f = await this.db.selectFrom('micro_reports').select(['snapshot', 'issued_at']).where('order_item_id', '=', itemId).where('kind', '=', 'final').orderBy('issued_at', 'desc').executeTakeFirst();
      return { kind: 'final' as const, issued_at: f?.issued_at ?? it.validated_at, report: (f?.snapshot as MicroSnapshot | undefined) ?? await this.snapshot(itemId), item: it };
    }
    const p = await this.db.selectFrom('micro_reports').select(['snapshot', 'issued_at']).where('order_item_id', '=', itemId).where('kind', '=', 'prelim').orderBy('issued_at', 'desc').executeTakeFirst();
    if (p) return { kind: 'prelim' as const, issued_at: p.issued_at, report: p.snapshot as unknown as MicroSnapshot, item: it };
    if (lab) return { kind: 'draft' as const, issued_at: null, report: await this.snapshot(itemId), item: it };
    return { kind: 'none' as const, issued_at: null, report: null, item: it };
  }
  async pdf(itemId: string, u: AuthUser) {
    const v = await this.view(itemId, u);
    if (!v.report) throw new NotFoundException('პასუხი ჯერ არ არის');
    let clinicName = ''; try { clinicName = (await this.clinic.get()).name; } catch { /* */ }
    const { doc, done } = newDoc('A4', 42); doc.addPage();
    const it = v.item; const rep = v.report;
    doc.font('B').fontSize(12).text(clinicName);
    doc.font('B').fontSize(15).fillColor('#1F4E79').text(`მიკრობიოლოგიური კვლევა — ${it.service_name}`, { align: 'center' }).fillColor('black');
    doc.font('B').fontSize(11).fillColor(v.kind === 'final' ? '#17693a' : '#B26B00').text(v.kind === 'final' ? 'საბოლოო პასუხი' : v.kind === 'prelim' ? 'წინასწარი პასუხი' : 'სამუშაო ვერსია (არ არის გაცემული)', { align: 'center' }).fillColor('black').moveDown(0.6);
    doc.font('R').fontSize(10).text(`პაციენტი: ${it.last_name} ${it.first_name}   პ/ნ: ${it.personal_number ?? '—'}   დაბ.: ${d(it.birth_date)}`);
    doc.text(`ნიმუში: ${it.specimen_type ?? '—'}   შტრიხკოდი: ${it.barcode ?? '—'}   აღება: ${it.collected_at ? dt(it.collected_at) : '—'}${v.issued_at ? `   გაცემა: ${dt(v.issued_at)}` : ''}`).moveDown(0.6);
    if (rep.gram_stain) doc.font('B').text('გრამის შეღებვა: ', { continued: true }).font('R').text(rep.gram_stain);
    doc.font('B').text('ზრდა: ', { continued: true }).font('R').text(rep.growth_summary || STAGE_KA[rep.stage] || rep.stage).moveDown(0.4);
    for (const i of rep.isolates) {
      doc.font('B').fontSize(11).text(`${i.seq}. ${i.organism ?? '—'}${i.quantity ? ` — ${i.quantity}` : ''}`); doc.font('R').fontSize(10);
      if (i.comment) doc.fillColor('#555').text(i.comment).fillColor('black');
      if (i.ast.length) {
        let y = doc.y + 4; const L = 60; const cols = [220, 90, 70, 60];
        doc.font('B').fontSize(9);
        ['ანტიბიოტიკი', 'MIC (mg/L)', 'ზონა (მმ)', 'შედეგი'].forEach((h, k) => doc.text(h, L + cols.slice(0, k).reduce((a, b) => a + b, 0), y, { width: cols[k] }));
        y += 14; doc.font('R');
        for (const a of i.ast) {
          if (y > 780) { doc.addPage(); y = 50; }
          const vals = [a.name, a.mic ?? '', a.zone_mm !== null ? String(Number(a.zone_mm)) : '', a.interp === 'S' ? 'S — მგრძნობიარე' : a.interp === 'I' ? 'I — შუალედური' : 'R — რეზისტენტული'];
          vals.forEach((t, k) => { doc.fillColor(k === 3 && a.interp === 'R' ? '#B42318' : 'black').font(k === 3 ? 'B' : 'R').text(t, L + cols.slice(0, k).reduce((q, b) => q + b, 0), y, { width: cols[k] }); });
          y += 13;
        }
        doc.fillColor('black').text('', 42, y + 6);
      }
      doc.moveDown(0.5);
    }
    if (rep.comment) doc.moveDown(0.3).font('B').text('კომენტარი: ', { continued: true }).font('R').text(rep.comment);
    doc.moveDown(1).fontSize(8).fillColor('#777').text('S — მგრძნობიარე; I — მგრძნობიარე, დოზის გაზრდისას; R — რეზისტენტული. ნაჩვენებია ლაბორატორიის მიერ შერჩეული ანტიბიოტიკები.');
    doc.end();
    return done;
  }
}

// ======================================================================= კონტროლერი
class OrganismDto { @IsOptional() @IsString() @Length(2, 12) code?: string; @IsOptional() @IsString() @Length(2, 150) name?: string;
  @IsOptional() @IsIn(['pos', 'neg', 'fungus', 'other']) gram?: string; @IsOptional() @IsString() @Length(2, 6) group_code?: string; @IsOptional() @IsBoolean() is_active?: boolean }
class AntibioticDto { @IsOptional() @IsString() @Length(2, 12) code?: string; @IsOptional() @IsString() @Length(2, 150) name?: string; @IsOptional() @IsString() @MaxLength(100) class?: string | null;
  @IsOptional() @IsBoolean() is_active?: boolean }
class PanelItemDto { @IsUUID() antibiotic_id: string; @IsBoolean() reserve: boolean }
class PanelDto { @IsArray() @ArrayMaxSize(80) @ValidateNested({ each: true }) @Type(() => PanelItemDto) items: PanelItemDto[] }
class CultureDto { @IsOptional() @IsIn(['incubating', 'no_growth', 'growth', 'contaminated']) stage?: string; @IsOptional() @IsString() @MaxLength(1000) gram_stain?: string | null;
  @IsOptional() @IsString() @MaxLength(1000) growth_summary?: string | null; @IsOptional() @IsString() @MaxLength(2000) comment?: string | null }
class IsolateDto { @IsOptional() @IsUUID() organism_id?: string; @IsOptional() @IsString() @MaxLength(100) quantity?: string | null; @IsOptional() @IsString() @MaxLength(500) comment?: string | null;
  @IsOptional() @IsUUID() panel_id?: string | null }
class AstRowDto { @IsUUID() antibiotic_id: string; @IsOptional() @IsString() @MaxLength(20) mic?: string | null; @IsOptional() @IsNumber() @Min(0) zone_mm?: number | null;
  @IsOptional() @IsIn(['S', 'I', 'R']) interp?: 'S' | 'I' | 'R' | null; @IsOptional() @IsBoolean() reported?: boolean }
class AstDto { @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => AstRowDto) rows: AstRowDto[] }
void IsInt;

@Controller('lab/micro')
export class LabMicroController {
  constructor(private readonly m: LabMicroService, @Inject(forwardRef(() => LabDeliveryService)) private readonly delivery: LabDeliveryService) {}
  @Get('refs') @Roles(...LAB_STAFF, 'doctor') refs() { return this.m.refs(); }
  @Post('organisms') @Roles('admin', 'lab_doctor', 'lab_manager') addOrg(@Body() d: OrganismDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.m.saveOrganism(null, d, u, auditCtx(r)); }
  @Patch('organisms/:id') @Roles('admin', 'lab_doctor', 'lab_manager') updOrg(@Param('id', ParseUUIDPipe) id: string, @Body() d: OrganismDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.m.saveOrganism(id, d, u, auditCtx(r)); }
  @Post('antibiotics') @Roles('admin', 'lab_doctor', 'lab_manager') addAb(@Body() d: AntibioticDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.m.saveAntibiotic(null, d, u, auditCtx(r)); }
  @Patch('antibiotics/:id') @Roles('admin', 'lab_doctor', 'lab_manager') updAb(@Param('id', ParseUUIDPipe) id: string, @Body() d: AntibioticDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.m.saveAntibiotic(id, d, u, auditCtx(r)); }
  @Put('panels/:id/items') @Roles('admin', 'lab_doctor', 'lab_manager') panel(@Param('id', ParseUUIDPipe) id: string, @Body() d: PanelDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.m.setPanelItems(id, d.items, u, auditCtx(r)); }

  @Get('items/:id') @Roles(...LAB_STAFF) detail(@Param('id', ParseUUIDPipe) id: string) { return this.m.detail(id); }
  @Put('items/:id/culture') @Roles(...LAB_STAFF) culture(@Param('id', ParseUUIDPipe) id: string, @Body() d: CultureDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.m.updateCulture(id, d, u, auditCtx(r)); }
  @Post('items/:id/isolates') @HttpCode(200) @Roles(...LAB_STAFF) addIso(@Param('id', ParseUUIDPipe) id: string, @Body() d: IsolateDto, @CurrentUser() u: AuthUser, @Req() r: Request) {
    if (!d.organism_id) throw new BadRequestException('აირჩიეთ მიკროორგანიზმი');
    return this.m.addIsolate(id, { organism_id: d.organism_id, quantity: d.quantity, comment: d.comment, panel_id: d.panel_id }, u, auditCtx(r));
  }
  @Patch('isolates/:id') @Roles(...LAB_STAFF) updIso(@Param('id', ParseUUIDPipe) id: string, @Body() d: IsolateDto, @Req() r: Request) { return this.m.updateIsolate(id, d, auditCtx(r)); }
  @Delete('isolates/:id') @Roles(...LAB_STAFF) delIso(@Param('id', ParseUUIDPipe) id: string, @Req() r: Request) { return this.m.deleteIsolate(id, auditCtx(r)); }
  @Put('isolates/:id/ast') @Roles(...LAB_STAFF) ast(@Param('id', ParseUUIDPipe) id: string, @Body() d: AstDto, @Req() r: Request) { return this.m.saveAst(id, d.rows, auditCtx(r)); }
  @Post('items/:id/prelim') @HttpCode(200) @Roles('admin', 'lab_doctor') prelim(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.m.prelim(id, u, auditCtx(r)); }
  @Post('items/:id/complete') @HttpCode(200) @Roles(...LAB_STAFF) complete(@Param('id', ParseUUIDPipe) id: string, @Req() r: Request) { return this.m.complete(id, auditCtx(r)); }
  @Post('items/:id/final') @HttpCode(200) @Roles('admin', 'lab_doctor') final(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() r: Request) {
    return this.m.final(id, u, auditCtx(r)).then((x) => { void this.delivery.afterValidate(id, auditCtx(r)); return x; });
  }
  @Get('items/:id/view') @Roles(...LAB_STAFF, 'doctor', 'nurse', 'receptionist') view(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser) { return this.m.view(id, u); }
  @Get('items/:id/report.pdf') @Roles(...LAB_STAFF, 'doctor', 'nurse', 'receptionist')
  async report(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Res({ passthrough: true }) res: Response) {
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline', 'Cache-Control': 'no-store' });
    return new StreamableFile(await this.m.pdf(id, u));
  }
}
