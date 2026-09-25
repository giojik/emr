import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { jsonArrayFrom } from 'kysely/helpers/postgres';
import { AuditService, type AuditContext } from '../audit/audit.service';
import type { AuthUser } from '../auth/roles';
import { dayRange } from '../common/day-range';
import { mapPgError } from '../common/pg-errors';
import { loadEnv } from '../config/env';
import { InjectDb, type Database } from '../database/database.module';
import type { DB } from '../database/db';
import { DiagnosticsService } from './diagnostics.service';

type Trx = Transaction<DB>;
export type ImagingSection = 'radiology' | 'endoscopy';

/** მაიონებელი გამოსხივება — ორსულობის შემოწმება 12–55 წლის ქალებში */
const IONIZING = ['CT', 'DX', 'RF', 'MG', 'DXA'];
/** შესავსები ადგილი შაბლონში — ხელმოწერამდე უნდა შეივსოს */
const BLANK = '___';

export interface ReportInput {
  technique?: string | null; findings?: string | null; impression?: string | null; recommendation?: string | null;
  is_critical?: boolean; critical_notified_to?: string | null; template_id?: string | null;
}
export interface PerformInput {
  contrast_agent?: string | null; contrast_volume_ml?: number | null; dose_text?: string | null; tech_note?: string | null;
  safety?: { mr_screening?: boolean; pregnancy?: 'not_pregnant' | 'pregnant_approved'; renal?: 'ok' | 'not_checked_approved'; notes?: string } | null;
  identity_confirmed?: boolean; unpaid_ack?: boolean;
}
export interface TemplateInput {
  section: ImagingSection; kind: 'template' | 'phrase'; name: string; modality?: string | null; service_id?: string | null; shared?: boolean;
  technique?: string | null; findings?: string | null; impression?: string | null; recommendation?: string | null;
  target?: 'technique' | 'findings' | 'impression' | 'recommendation' | null; body?: string | null; sort_order?: number; is_active?: boolean;
}

const clean = (v: string | null | undefined) => (v ?? '').replace(/\r\n/g, '\n').trim() || null;
const ageYears = (birth: string) => { const b = new Date(`${birth}T00:00:00Z`); const n = new Date(); let a = n.getUTCFullYear() - b.getUTCFullYear(); if (n.getUTCMonth() < b.getUTCMonth() || (n.getUTCMonth() === b.getUTCMonth() && n.getUTCDate() < b.getUTCDate())) a--; return a; };

/** დასკვნის ტექსტი ფორმა 100-ისა და ექიმის ეკრანისთვის */
export function composeReport(r: ReportInput) {
  return [
    r.technique && `ტექნიკა: ${r.technique}`,
    r.findings && `აღწერა:\n${r.findings}`,
    r.impression && `დასკვნა: ${r.impression}`,
    r.recommendation && `რეკომენდაცია: ${r.recommendation}`,
  ].filter(Boolean).join('\n\n');
}

@Injectable()
export class RadiologyService {
  private readonly tz = loadEnv().CLINIC_TZ;
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService, private readonly dx: DiagnosticsService) {}

  // =============================================================== უფლებები
  private isReporter(user: AuthUser, section: ImagingSection) {
    return user.role === 'admin' || (section === 'radiology' ? user.role === 'radiologist' : user.role === 'endoscopist');
  }
  private assertReporter(user: AuthUser, section: ImagingSection) {
    if (!this.isReporter(user, section)) throw new ForbiddenException(section === 'radiology' ? 'დასკვნას წერს რადიოლოგი' : 'ოქმს წერს ენდოსკოპისტი');
  }
  /** საერთო შაბლონები: admin ან განყოფილების ხელმძღვანელი (ცოცხალი შემოწმება ბაზაში) */
  async canManageShared(user: AuthUser, section: ImagingSection, executor: Database | Trx = this.db) {
    if (user.role === 'admin') return true;
    if (!this.isReporter(user, section)) return false;
    const u = await executor.selectFrom('users').select('is_section_head').where('id', '=', user.id).executeTakeFirst();
    return !!u?.is_section_head;
  }

  // =============================================================== აპარატები
  devices(q: { section?: string; includeInactive?: boolean } = {}) {
    let query = this.db.selectFrom('dx_devices').selectAll().orderBy('sort_order').orderBy('name');
    if (q.section) query = query.where('section', '=', q.section);
    if (!q.includeInactive) query = query.where('is_active', '=', true);
    return query.execute();
  }

  async saveDevice(id: string | null, dto: { section?: ImagingSection; name?: string; modalities?: string[]; room?: string | null; ae_title?: string | null;
    slot_minutes?: number; work_start?: string; work_end?: string; is_active?: boolean; sort_order?: number }, ctx: AuditContext) {
    const vals = {
      ...(dto.section !== undefined && { section: dto.section }), ...(dto.name !== undefined && { name: dto.name.trim() }),
      ...(dto.modalities !== undefined && { modalities: dto.modalities.map((m) => m.trim().toUpperCase()) }),
      ...(dto.room !== undefined && { room: clean(dto.room) }), ...(dto.ae_title !== undefined && { ae_title: clean(dto.ae_title)?.toUpperCase() ?? null }),
      ...(dto.slot_minutes !== undefined && { slot_minutes: dto.slot_minutes }), ...(dto.work_start !== undefined && { work_start: dto.work_start }),
      ...(dto.work_end !== undefined && { work_end: dto.work_end }), ...(dto.is_active !== undefined && { is_active: dto.is_active }),
      ...(dto.sort_order !== undefined && { sort_order: dto.sort_order }),
    };
    try {
      return await this.db.transaction().execute(async (trx) => {
        let row;
        if (id) {
          const old = await trx.selectFrom('dx_devices').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
          if (!old) throw new NotFoundException('აპარატი ვერ მოიძებნა');
          row = await trx.updateTable('dx_devices').set(vals).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
          await this.audit.log(ctx, { action: 'UPDATE_DX_DEVICE', entityName: 'dx_devices', entityId: id, oldData: old, newData: vals }, trx);
        } else {
          if (!dto.name || !dto.modalities?.length) throw new BadRequestException('მიუთითეთ დასახელება და მოდალობა');
          row = await trx.insertInto('dx_devices').values({ name: dto.name.trim(), modalities: dto.modalities, ...vals }).returningAll().executeTakeFirstOrThrow();
          await this.audit.log(ctx, { action: 'CREATE_DX_DEVICE', entityName: 'dx_devices', entityId: row.id, newData: vals }, trx);
        }
        return row;
      });
    } catch (e) { mapPgError(e, { dx_devices_name_key: 'ასეთი დასახელების აპარატი უკვე არსებობს', dx_devices_work_start_work_end_check: 'სამუშაო საათების დასაწყისი უნდა იყოს დასასრულამდე' }); }
  }

  // =============================================================== განრიგი
  /** დღის განრიგი: აპარატები + ჩაწერილი კვლევები + დასაგეგმი (ჯერ დრო არ აქვს) */
  async board(date: string, section: ImagingSection = 'radiology') {
    const [from, to] = dayRange(date, this.tz);
    const [devices, booked, unscheduled] = await Promise.all([
      this.devices({ section }),
      this.dx.itemsQuery().where('i.section', '=', section).where('i.device_id', 'is not', null)
        .where('i.scheduled_start', '>=', from).where('i.scheduled_start', '<', to).where('i.status', '<>', 'cancelled')
        .orderBy('i.scheduled_start').execute(),
      this.dx.itemsQuery().where('i.section', '=', section).where('i.status', '=', 'ordered')
        .where('enc.status', 'in', ['planned', 'active']).orderBy(sql`i.priority = 'urgent'`, 'desc').orderBy('i.ordered_at').limit(300).execute(),
    ]);
    return { date, tz: this.tz, devices, booked, unscheduled };
  }

  async schedule(itemId: string, dto: { device_id: string; start: string; outside_hours?: boolean }, user: AuthUser, ctx: AuditContext) {
    try {
      return await this.db.transaction().execute(async (trx) => {
        const it = await this.lockItem(trx, itemId);
        if (it.section !== 'radiology' && it.section !== 'endoscopy') throw new BadRequestException('ჩაწერა დროზე — რადიოლოგია / ენდოსკოპია');
        if (!['ordered', 'scheduled'].includes(it.status)) throw new ConflictException('კვლევა უკვე მიღებულია ან დასრულებულია — გადაწერა შეუძლებელია');
        const dev = await trx.selectFrom('dx_devices').selectAll().where('id', '=', dto.device_id).executeTakeFirst();
        if (!dev || !dev.is_active || dev.section !== it.section) throw new BadRequestException('აპარატი / ოთახი ვერ მოიძებნა ან გათიშულია');
        if (!it.modality || !dev.modalities.includes(it.modality)) throw new BadRequestException(`აპარატზე „${dev.name}“ ${it.modality ?? '—'} კვლევა არ სრულდება`);
        const start = new Date(dto.start);
        if (Number.isNaN(start.getTime())) throw new BadRequestException('არასწორი დრო');
        const minutes = it.duration_minutes ?? dev.slot_minutes;
        const end = new Date(start.getTime() + minutes * 60_000);
        const { rows: [h] } = await sql<{ ok: boolean; past: boolean }>`
          SELECT ((${start}::timestamptz AT TIME ZONE ${this.tz})::time >= ${dev.work_start}::time
             AND (${end}::timestamptz AT TIME ZONE ${this.tz})::time <= ${dev.work_end}::time
             AND (${start}::timestamptz AT TIME ZONE ${this.tz})::date = (${end}::timestamptz AT TIME ZONE ${this.tz})::date) AS ok,
                 ${start}::timestamptz < now() - interval '15 minutes' AS past`.execute(trx);
        if (h.past) throw new BadRequestException('წარსულ დროზე ჩაწერა შეუძლებელია');
        if (!h.ok && !dto.outside_hours) throw new ConflictException({ code: 'OUTSIDE_HOURS', message: `დრო სცდება აპარატის სამუშაო საათებს (${dev.work_start.slice(0, 5)}–${dev.work_end.slice(0, 5)})` });
        await trx.updateTable('dx_order_items').set({ status: 'scheduled', device_id: dev.id, scheduled_start: start, scheduled_end: end, scheduled_by: user.id })
          .where('id', '=', itemId).execute();
        await this.audit.log(ctx, { action: it.status === 'scheduled' ? 'RESCHEDULE_DX' : 'SCHEDULE_DX', entityName: 'dx_order_items', entityId: itemId,
          oldData: it.status === 'scheduled' ? { device_id: it.device_id, start: it.scheduled_start } : undefined,
          newData: { device: dev.name, start: start.toISOString(), minutes, outside_hours: !h.ok || undefined } }, trx);
        return { id: itemId, status: 'scheduled', device_id: dev.id, scheduled_start: start, scheduled_end: end };
      });
    } catch (e) { mapPgError(e, { excl_dx_device_overlap: 'ეს დრო ამ აპარატზე უკვე დაკავებულია' }); }
  }

  async unschedule(itemId: string, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const it = await this.lockItem(trx, itemId);
      if (it.status !== 'scheduled') throw new ConflictException('კვლევა ჩაწერილი არ არის');
      await trx.updateTable('dx_order_items').set({ status: 'ordered', device_id: null, scheduled_start: null, scheduled_end: null, scheduled_by: null }).where('id', '=', itemId).execute();
      await this.audit.log(ctx, { action: 'UNSCHEDULE_DX', entityName: 'dx_order_items', entityId: itemId, oldData: { device_id: it.device_id, start: it.scheduled_start } }, trx);
      return { id: itemId, status: 'ordered' };
    });
  }

  // =============================================================== ტექნიკოსი
  /** რიგი: დღის ჩაწერები + მოსული პაციენტები + ცოცხალი რიგი (ჩაწერის გარეშე) + დღეს შესრულებული */
  async techQueue(date: string, deviceId?: string, section: ImagingSection = 'radiology') {
    const [from, to] = dayRange(date, this.tz);
    let q = this.dx.itemsQuery().where('i.section', '=', section).where((eb) => eb.or([
      eb.and([eb('i.status', '=', 'scheduled'), eb('i.scheduled_start', '>=', from), eb('i.scheduled_start', '<', to)]),
      eb('i.status', '=', 'arrived'),
      eb.and([eb('i.status', '=', 'ordered'), eb('enc.status', 'in', ['planned', 'active'])]),
      eb.and([eb('i.status', 'in', ['performed', 'in_progress', 'validated']), eb('i.performed_at', '>=', from), eb('i.performed_at', '<', to)]),
    ]));
    if (deviceId) q = q.where((eb) => eb.or([eb('i.device_id', '=', deviceId), eb('i.device_id', 'is', null)]));
    return q.orderBy(sql`i.priority = 'urgent'`, 'desc').orderBy(sql`coalesce(i.scheduled_start, i.arrived_at, i.ordered_at)`).limit(500).execute();
  }

  /** პაციენტი მოვიდა (რეგისტრატურა / ტექნიკოსი). გადაუხდელზე — ცალკე დადასტურება */
  async arrive(itemId: string, dto: { unpaid_ack?: boolean }, user: AuthUser, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const it = await this.lockItem(trx, itemId);
      if (!['ordered', 'scheduled'].includes(it.status)) throw new ConflictException('პაციენტი უკვე მიღებულია');
      this.assertPayable(it, dto.unpaid_ack);
      await trx.updateTable('dx_order_items').set({ status: 'arrived', arrived_at: sql`now()`, arrived_by: user.id, collection_issue: null, collection_issue_at: null }).where('id', '=', itemId).execute();
      await this.audit.log(ctx, { action: 'DX_ARRIVED', entityName: 'dx_order_items', entityId: itemId, newData: { unpaid_ack: it.paid_status === 'unpaid' || undefined } }, trx);
      return { id: itemId, status: 'arrived' };
    });
  }

  /** კვლევა შესრულდა: კონტრასტი, დოზა, უსაფრთხოების კითხვარი, შენიშვნა რადიოლოგისთვის → რადიოლოგის სიაში */
  async perform(itemId: string, dto: PerformInput, user: AuthUser, ctx: AuditContext) {
    if (!dto.identity_confirmed) throw new BadRequestException('დაადასტურეთ პაციენტის იდენტიფიკაცია (სახელი და დაბადების თარიღი)');
    return this.db.transaction().execute(async (trx) => {
      const it = await this.lockItem(trx, itemId);
      if (it.section !== 'radiology') throw new BadRequestException('მხოლოდ რადიოლოგიური კვლევა');
      if (!['ordered', 'scheduled', 'arrived'].includes(it.status)) throw new ConflictException('კვლევა უკვე შესრულებულად არის მონიშნული');
      this.assertPayable(it, dto.unpaid_ack);
      const safety = dto.safety ?? {};
      if (it.modality === 'MR' && safety.mr_screening !== true) throw new BadRequestException('MRI: შეავსეთ უსაფრთხოების კითხვარი (იმპლანტები, კარდიოსტიმულატორი, მეტალი)');
      const age = ageYears(it.birth_date);
      if (IONIZING.includes(it.modality ?? '') && it.gender === 'female' && age >= 12 && age <= 55 && !safety.pregnancy) {
        throw new BadRequestException('ორსულობის სტატუსი სავალდებულოა (ქალი, 12–55 წ, მაიონებელი გამოსხივება)');
      }
      if (it.contrast && !clean(dto.contrast_agent)) throw new BadRequestException('მიუთითეთ კონტრასტული პრეპარატი');
      if ((it.contrast === 'iodinated' || it.contrast === 'gadolinium') && !dto.contrast_volume_ml) throw new BadRequestException('მიუთითეთ კონტრასტის მოცულობა (მლ)');
      await trx.updateTable('dx_order_items').set({
        status: 'performed', performed_at: sql`now()`, technician_id: user.id,
        arrived_at: it.arrived_at ?? sql`now()`, arrived_by: it.arrived_by ?? user.id,
        contrast_agent: it.contrast ? clean(dto.contrast_agent) : null, contrast_volume_ml: it.contrast && dto.contrast_volume_ml ? String(dto.contrast_volume_ml) : null,
        dose_text: clean(dto.dose_text), tech_note: clean(dto.tech_note), safety: JSON.stringify(safety), collection_issue: null, collection_issue_at: null,
      }).where('id', '=', itemId).execute();
      await this.audit.log(ctx, { action: 'DX_PERFORMED', entityName: 'dx_order_items', entityId: itemId,
        newData: { identity_confirmed: true, contrast_agent: dto.contrast_agent, contrast_volume_ml: dto.contrast_volume_ml, dose_text: dto.dose_text, safety } }, trx);
      return { id: itemId, status: 'performed' };
    });
  }

  /** „ვერ შესრულდა“ — შეკვეთა ღია რჩება, მიზეზი ჩანს სიაში */
  async issue(itemId: string, reason: string, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const it = await this.lockItem(trx, itemId);
      if (!['ordered', 'scheduled', 'arrived'].includes(it.status)) throw new ConflictException('კვლევა უკვე შესრულებულია');
      await trx.updateTable('dx_order_items').set({ collection_issue: reason, collection_issue_at: sql`now()` }).where('id', '=', itemId).execute();
      await this.audit.log(ctx, { action: 'DX_EXAM_ISSUE', entityName: 'dx_order_items', entityId: itemId, newData: { reason } }, trx);
      return { id: itemId, reason };
    });
  }

  // =============================================================== დასკვნა
  /** რადიოლოგი / ენდოსკოპისტი: todo — აღსაწერი; done — ხელმოწერილი (თარიღით) */
  reportWorklist(section: ImagingSection, tab: 'todo' | 'done', q: { date?: string; search?: string } = {}) {
    let query = this.dx.itemsQuery().where('i.section', '=', section);
    if (tab === 'todo') {
      query = query.where('i.status', 'in', ['performed', 'in_progress']);
    } else {
      query = query.where('i.status', '=', 'validated');
      if (q.date) { const [from, to] = dayRange(q.date, this.tz); query = query.where('i.validated_at', '>=', from).where('i.validated_at', '<', to); }
    }
    if (q.search?.trim()) {
      const t = q.search.trim();
      query = query.where((eb) => eb.or([eb('i.accession_number', '=', t.toUpperCase()), eb('p.personal_number', '=', t), eb('p.last_name', 'ilike', `${t}%`)]));
    }
    return query.orderBy(sql`i.priority = 'urgent'`, 'desc').orderBy(tab === 'todo' ? sql`coalesce(i.performed_at, i.ordered_at)` : sql`i.validated_at`, tab === 'todo' ? 'asc' : 'desc').limit(500).execute();
  }

  /** რედაქტორის მონაცემები: შეკვეთა + დასკვნა + ვერსიები + პაციენტის წინა კვლევები (შედარებისთვის) */
  async reportDetail(itemId: string) {
    const it = await this.dx.itemsQuery().where('i.id', '=', itemId).executeTakeFirst();
    if (!it || it.section === 'lab') throw new NotFoundException('შეკვეთა ვერ მოიძებნა');
    const [report, versions, priors, tech] = await Promise.all([
      this.db.selectFrom('dx_reports as r').leftJoin('users as a', 'a.id', 'r.author_id').leftJoin('users as sb', 'sb.id', 'r.signed_by').leftJoin('users as am', 'am.id', 'r.amended_by')
        .selectAll('r').select([sql<string | null>`a.first_name || ' ' || a.last_name`.as('author_name'), sql<string | null>`sb.first_name || ' ' || sb.last_name`.as('signed_by_name'),
          sql<string | null>`am.first_name || ' ' || am.last_name`.as('amended_by_name')])
        .where('r.order_item_id', '=', itemId).executeTakeFirst(),
      this.db.selectFrom('dx_report_versions as v').innerJoin('users as u', 'u.id', 'v.signed_by')
        .selectAll('v').select(sql<string>`u.first_name || ' ' || u.last_name`.as('signed_by_name'))
        .where('v.order_item_id', '=', itemId).orderBy('v.version', 'desc').execute(),
      this.db.selectFrom('dx_order_items as i').innerJoin('dx_services as s', 's.id', 'i.service_id').leftJoin('dx_reports as r', 'r.order_item_id', 'i.id')
        .select(['i.id', 's.name as service_name', 's.modality', 'i.accession_number', 'i.performed_at', 'i.validated_at', 'r.impression', 'r.findings', 'i.report_text'])
        .where('i.patient_id', '=', it.patient_id).where('i.section', '=', it.section).where('i.status', '=', 'validated').where('i.id', '<>', itemId)
        .orderBy('i.validated_at', 'desc').limit(10).execute(),
      this.db.selectFrom('dx_order_items as i').leftJoin('users as t', 't.id', 'i.technician_id')
        .select(['i.safety', sql<string | null>`t.first_name || ' ' || t.last_name`.as('technician_name')]).where('i.id', '=', itemId).executeTakeFirst(),
    ]);
    const [endo, images, pathology] = await Promise.all([
      this.db.selectFrom('endo_procedures as ep').leftJoin('endo_scopes as sc', 'sc.id', 'ep.scope_id').leftJoin('users as n', 'n.id', 'ep.nurse_id')
        .selectAll('ep').select(['sc.name as scope_name', 'sc.serial_number as scope_serial', sql<string | null>`n.first_name || ' ' || n.last_name`.as('nurse_name')])
        .where('ep.order_item_id', '=', itemId).executeTakeFirst(),
      this.db.selectFrom('dx_images').select(['id', 'source', 'caption', 'in_report', 'sort_order', 'mime_type', 'created_at'])
        .where('order_item_id', '=', itemId).where('is_active', '=', true).orderBy('sort_order').orderBy('created_at').execute(),
      this.db.selectFrom('path_requests as r').selectAll('r')
        .select((eb) => jsonArrayFrom(eb.selectFrom('path_specimens as s').selectAll('s').whereRef('s.request_id', '=', 'r.id').orderBy('s.jar_no')).as('specimens'))
        .where('r.order_item_id', '=', itemId).executeTakeFirst(),
    ]);
    return { ...it, ...tech, report: report ?? null, versions, priors, endo: endo ?? null, images, pathology: pathology ?? null };
  }

  private readonly SECTIONS = ['technique', 'findings', 'impression', 'recommendation'] as const;

  async saveDraft(itemId: string, dto: ReportInput, user: AuthUser, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const it = await this.lockItem(trx, itemId);
      this.assertReporter(user, it.section as ImagingSection);
      this.assertReportable(it);
      const rep = await trx.selectFrom('dx_reports').select(['status']).where('order_item_id', '=', itemId).forUpdate().executeTakeFirst();
      if (rep?.status === 'signed') throw new ConflictException('დასკვნა ხელმოწერილია — შესწორებისთვის გამოიყენეთ „ხელახლა გახსნა“');
      await this.upsertReport(trx, itemId, dto, user, rep ? 'update' : 'insert');
      if (it.status !== 'in_progress') await trx.updateTable('dx_order_items').set({ status: 'in_progress' }).where('id', '=', itemId).execute();
      await this.audit.log(ctx, { action: 'SAVE_REPORT_DRAFT', entityName: 'dx_order_items', entityId: itemId }, trx);
      return { id: itemId, status: 'in_progress', report_status: 'draft' };
    });
  }

  async sign(itemId: string, dto: ReportInput, user: AuthUser, ctx: AuditContext) {
    const v = Object.fromEntries(this.SECTIONS.map((k) => [k, clean(dto[k])])) as Record<(typeof this.SECTIONS)[number], string | null>;
    if (!v.impression) throw new BadRequestException('„დასკვნა“ სავალდებულოა');
    const blanks = this.SECTIONS.filter((k) => v[k]?.includes(BLANK));
    if (blanks.length) throw new BadRequestException({ code: 'BLANKS', message: `შეუვსებელი ადგილები (${BLANK}): ${blanks.map((k) => SECTION_KA[k]).join(', ')}`, fields: blanks });
    if (dto.is_critical && !clean(dto.critical_notified_to)) throw new BadRequestException('კრიტიკული მიგნება: მიუთითეთ, ვის ეცნობა (ექიმი, დრო, საშუალება)');
    return this.db.transaction().execute(async (trx) => {
      const it = await this.lockItem(trx, itemId);
      this.assertReporter(user, it.section as ImagingSection);
      this.assertReportable(it);
      const rep = await trx.selectFrom('dx_reports').select(['status', 'version', 'amend_reason']).where('order_item_id', '=', itemId).forUpdate().executeTakeFirst();
      if (rep?.status === 'signed') throw new ConflictException('დასკვნა უკვე ხელმოწერილია');
      if (it.section === 'endoscopy') await this.endoSignCheck(trx, itemId);
      await this.upsertReport(trx, itemId, dto, user, rep ? 'update' : 'insert');
      const signed = await trx.updateTable('dx_reports').set({
        status: 'signed', signed_by: user.id, signed_at: sql`now()`,
        critical_notified_at: dto.is_critical ? sql`now()` : null,
      }).where('order_item_id', '=', itemId).returning(['version', 'amend_reason', 'signed_at']).executeTakeFirstOrThrow();
      await trx.insertInto('dx_report_versions').values({
        order_item_id: itemId, version: signed.version, ...v, impression: v.impression!, is_critical: !!dto.is_critical,
        critical_notified_to: dto.is_critical ? clean(dto.critical_notified_to) : null, amend_reason: signed.amend_reason, signed_by: user.id, signed_at: signed.signed_at!,
      }).execute();
      await trx.updateTable('dx_order_items').set({
        status: 'validated', report_text: composeReport(v), resulted_by: user.id, resulted_at: sql`coalesce(resulted_at, now())`,
        validated_by: user.id, validated_at: sql`now()`,
      }).where('id', '=', itemId).execute();
      await this.audit.log(ctx, { action: 'SIGN_REPORT', entityName: 'dx_order_items', entityId: itemId,
        newData: { version: signed.version, is_critical: !!dto.is_critical, critical_notified_to: dto.critical_notified_to ?? undefined } }, trx);
      await this.dx.maybeCompleteLabVisit(trx, it.encounter_id);
      return { id: itemId, status: 'validated', version: signed.version };
    });
  }

  /** ხელახლა გახსნა: ხელმომწერი, განყოფილების ხელმძღვანელი ან admin. ძველი ვერსია რჩება არქივში, ახალი ვერსია = +1 */
  async reopen(itemId: string, reason: string, user: AuthUser, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const it = await this.lockItem(trx, itemId);
      const rep = await trx.selectFrom('dx_reports').select(['status', 'version', 'signed_by']).where('order_item_id', '=', itemId).forUpdate().executeTakeFirst();
      if (!rep || rep.status !== 'signed') throw new ConflictException('ხელახლა გახსნა შეიძლება მხოლოდ ხელმოწერილი დასკვნის');
      const allowed = user.role === 'admin' || (this.isReporter(user, it.section as ImagingSection) && (rep.signed_by === user.id || await this.canManageShared(user, it.section as ImagingSection, trx)));
      if (!allowed) throw new ForbiddenException('ხელახლა გახსნა შეუძლია ხელმომწერს ან განყოფილების ხელმძღვანელს');
      await trx.updateTable('dx_reports').set({
        status: 'draft', version: rep.version + 1, amend_reason: reason, amended_by: user.id, amended_at: sql`now()`, signed_by: null, signed_at: null,
      }).where('order_item_id', '=', itemId).execute();
      await trx.updateTable('dx_order_items').set({ status: 'in_progress', validated_by: null, validated_at: null }).where('id', '=', itemId).execute();
      await this.audit.log(ctx, { action: 'REOPEN_REPORT', entityName: 'dx_order_items', entityId: itemId, newData: { reason, from_version: rep.version } }, trx);
      return { id: itemId, status: 'in_progress', version: rep.version + 1 };
    });
  }

  /** ბლანკისთვის: ხელმოწერილი დასკვნა (მიმდინარე ან კონკრეტული ვერსია) */
  async printData(itemId: string, version?: number) {
    const d = await this.reportDetail(itemId);
    const v = version ? d.versions.find((x) => x.version === version) : d.versions[0];
    if (!v) throw new BadRequestException('ხელმოწერილი დასკვნა არ არის');
    const referrer = await this.db.selectFrom('dx_order_items as i').innerJoin('users as u', 'u.id', 'i.ordered_by').leftJoin('encounters as e', 'e.id', 'i.encounter_id')
      .select([sql<string>`u.first_name || ' ' || u.last_name`.as('name'), 'u.role', 'e.external_referral']).where('i.id', '=', itemId).executeTakeFirstOrThrow();
    return { item: d, version: v, latest: v.version === d.versions[0]?.version && d.report?.status === 'signed', referrer };
  }

  // =============================================================== შაბლონები
  async templates(user: AuthUser, q: { section: ImagingSection; modality?: string; service_id?: string; manage?: boolean }) {
    let query = this.db.selectFrom('dx_report_templates as t').leftJoin('users as o', 'o.id', 't.owner_id').leftJoin('dx_services as s', 's.id', 't.service_id')
      .selectAll('t').select(['s.name as service_name', sql<string | null>`o.first_name || ' ' || o.last_name`.as('owner_name')])
      .where('t.section', '=', q.section)
      .where((eb) => eb.or([eb('t.owner_id', 'is', null), eb('t.owner_id', '=', user.id)]))
      .orderBy(sql`t.owner_id IS NULL`, 'desc').orderBy('t.kind').orderBy('t.sort_order').orderBy('t.name');
    if (!q.manage) query = query.where('t.is_active', '=', true);
    if (q.modality) query = query.where((eb) => eb.or([eb('t.modality', 'is', null), eb('t.modality', '=', q.modality!)]));
    if (q.service_id) query = query.where((eb) => eb.or([eb('t.service_id', 'is', null), eb('t.service_id', '=', q.service_id!)]));
    const rows = await query.execute();
    return { can_manage_shared: await this.canManageShared(user, q.section), items: rows };
  }

  async saveTemplate(id: string | null, dto: TemplateInput, user: AuthUser, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const old = id ? await trx.selectFrom('dx_report_templates').selectAll().where('id', '=', id).forUpdate().executeTakeFirst() : undefined;
      if (id && !old) throw new NotFoundException('შაბლონი ვერ მოიძებნა');
      const section = (old?.section ?? dto.section) as ImagingSection;
      const shared = old ? old.owner_id === null : !!dto.shared;
      if (!this.isReporter(user, section)) throw new ForbiddenException('შაბლონებს მართავს დასკვნის ავტორი');
      if (shared && !(await this.canManageShared(user, section, trx))) throw new ForbiddenException('საერთო შაბლონს ცვლის განყოფილების ხელმძღვანელი');
      if (old && !shared && old.owner_id !== user.id) throw new ForbiddenException('სხვისი პირადი შაბლონი');
      const kind = old?.kind ?? dto.kind;
      const vals = {
        name: dto.name.trim(), modality: clean(dto.modality)?.toUpperCase() ?? null, service_id: dto.service_id ?? null,
        technique: kind === 'template' ? clean(dto.technique) : null, findings: kind === 'template' ? clean(dto.findings) : null,
        impression: kind === 'template' ? clean(dto.impression) : null, recommendation: kind === 'template' ? clean(dto.recommendation) : null,
        target: kind === 'phrase' ? dto.target ?? null : null, body: kind === 'phrase' ? clean(dto.body) : null,
        sort_order: dto.sort_order ?? old?.sort_order ?? 0, is_active: dto.is_active ?? old?.is_active ?? true,
      };
      if (kind === 'phrase' && (!vals.body || !vals.target)) throw new BadRequestException('ფრაზას სჭირდება ტექსტი და ველი');
      if (kind === 'template' && !vals.technique && !vals.findings && !vals.impression && !vals.recommendation) throw new BadRequestException('შაბლონი ცარიელია');
      const row = old
        ? await trx.updateTable('dx_report_templates').set(vals).where('id', '=', id!).returningAll().executeTakeFirstOrThrow()
        : await trx.insertInto('dx_report_templates').values({ ...vals, section, kind, owner_id: shared ? null : user.id, created_by: user.id }).returningAll().executeTakeFirstOrThrow();
      await this.audit.log(ctx, { action: old ? 'UPDATE_REPORT_TEMPLATE' : 'CREATE_REPORT_TEMPLATE', entityName: 'dx_report_templates', entityId: row.id,
        oldData: old, newData: { ...vals, shared } }, trx);
      return row;
    });
  }

  /** ენდოსკოპია: ხელმოწერამდე — ბიოფსია მითითებულია → ქილები სავალდებულოა */
  private async endoSignCheck(trx: Trx, itemId: string) {
    const p = await trx.selectFrom('endo_procedures').select(['interventions']).where('order_item_id', '=', itemId).executeTakeFirst();
    const biopsy = ((p?.interventions ?? []) as { type?: string }[]).some((x) => x.type === 'biopsy' || x.type === 'polypectomy');
    const jars = await trx.selectFrom('path_specimens as s').innerJoin('path_requests as r', 'r.id', 's.request_id')
      .select((eb) => eb.fn.countAll<string>().as('n')).where('r.order_item_id', '=', itemId).where('r.status', '<>', 'cancelled').executeTakeFirst();
    if (biopsy && !Number(jars?.n ?? 0)) throw new BadRequestException('მითითებულია ბიოფსია / პოლიპექტომია — დაამატეთ ნიმუშები (ქილები) პათოლოგიისთვის');
  }

  // =============================================================== helpers
  private async lockItem(trx: Trx, itemId: string) {
    const it = await trx.selectFrom('dx_order_items as i').innerJoin('dx_services as s', 's.id', 'i.service_id').innerJoin('patients as p', 'p.id', 'i.patient_id')
      .leftJoin('invoices as inv', 'inv.encounter_id', 'i.encounter_id')
      .select(['i.id', 'i.status', 'i.section', 'i.encounter_id', 'i.device_id', 'i.scheduled_start', 'i.arrived_at', 'i.arrived_by',
        's.modality', 's.contrast', 's.duration_minutes', 's.name', 'p.gender', 'p.birth_date', 'inv.paid_status'])
      .where('i.id', '=', itemId).forUpdate(['i']).executeTakeFirst();
    if (!it || it.section === 'lab') throw new NotFoundException('შეკვეთა ვერ მოიძებნა');
    if (it.status === 'cancelled') throw new ConflictException('შეკვეთა გაუქმებულია');
    return it;
  }
  private assertPayable(it: { paid_status: string | null }, ack?: boolean) {
    if (it.paid_status === 'unpaid' && !ack) throw new ConflictException({ code: 'UNPAID', message: 'კვლევა გადახდილი არ არის' });
  }
  private assertReportable(it: { section: string; status: string }) {
    if (!['performed', 'in_progress'].includes(it.status)) {
      throw new ConflictException(['ordered', 'scheduled', 'arrived'].includes(it.status)
        ? (it.section === 'radiology' ? 'კვლევა ჯერ არ არის შესრულებული (ტექნიკოსი)' : 'პროცედურა ჯერ არ არის დასრულებული (ექთანი)') : 'დასკვნის შეცვლა ამ სტატუსზე შეუძლებელია');
    }
  }
  private async upsertReport(trx: Trx, itemId: string, dto: ReportInput, user: AuthUser, mode: 'insert' | 'update') {
    const vals = {
      technique: clean(dto.technique), findings: clean(dto.findings), impression: clean(dto.impression), recommendation: clean(dto.recommendation),
      is_critical: !!dto.is_critical, critical_notified_to: dto.is_critical ? clean(dto.critical_notified_to) : null,
      ...(dto.template_id !== undefined && { template_id: dto.template_id }),
    };
    if (mode === 'insert') await trx.insertInto('dx_reports').values({ order_item_id: itemId, ...vals, author_id: user.id }).execute();
    else await trx.updateTable('dx_reports').set({ ...vals, author_id: sql`coalesce(author_id, ${user.id}::uuid)` }).where('order_item_id', '=', itemId).execute();
  }
}

export const SECTION_KA: Record<string, string> = { technique: 'ტექნიკა', findings: 'აღწერა', impression: 'დასკვნა', recommendation: 'რეკომენდაცია' };
