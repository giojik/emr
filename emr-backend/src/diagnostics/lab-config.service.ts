import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import PDFDocument from 'pdfkit';
import { sql } from 'kysely';
import { jsonArrayFrom } from 'kysely/helpers/postgres';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { has, type AuthUser } from '../auth/roles';
import { loadEnv } from '../config/env';
import { InjectDb, type Database } from '../database/database.module';
import { ClinicSettingsService } from '../settings/clinic-settings';
import { ageDays, computeFlag, DiagnosticsService } from './diagnostics.service';
import { renderLabBlank, type BlankInput, type BlankItem, type BlankSection } from './lab-blank.pdf';
import { blankImageIds, DEFAULT_BLANK, sanitizeBlank, type BlankSettings } from './lab-blank.settings';
import { AGE_MAX_DAYS, coverageGaps, normalizeRanges, pickRange, validateRanges, type RangeRow } from './lab-norms';

export interface RangeInput {
  sex: 'male' | 'female' | null; age_min_days: number; age_max_days: number; pregnancy?: 'P' | 'T1' | 'T2' | 'T3' | null; method_id?: string | null;
  low?: number | null; high?: number | null; normal_text?: string | null;
}

const MAX_IMAGE = 700 * 1024;   // JSON-ის ლიმიტი 1 MB — base64 ≈ ×1.37

@Injectable()
export class LabConfigService {
  private readonly env = loadEnv();
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService,
              private readonly settings: ClinicSettingsService, private readonly dx: DiagnosticsService) {}

  // =============================================================== უფლებები
  /** ლაბორატორიის ხელმძღვანელი = ლაბ. ექიმი + „ხელმძღვანელი“ (users.is_section_head), ან ადმინისტრატორი */
  async isLabHead(user: AuthUser) {
    if (has(user, 'admin')) return true;
    if (!has(user, 'lab_doctor')) return false;
    const u = await this.db.selectFrom('users').select('is_section_head').where('id', '=', user.id).executeTakeFirst();
    return !!u?.is_section_head;
  }
  private async requireHead(user: AuthUser, what: string) {
    if (!(await this.isLabHead(user))) throw new ForbiddenException(`${what} შეუძლია მხოლოდ ლაბორატორიის ხელმძღვანელს (ლაბ. ექიმი + „ხელმძღვანელი“) ან ადმინისტრატორს`);
  }
  async permissions(user: AuthUser) {
    const head = await this.isLabHead(user);
    return { lab_head: head, norms: head, blanks: head, methods: head || has(user, 'lab_manager') };
  }

  // =============================================================== ანალიზატორები / მეთოდები
  methods(includeInactive = false) {
    let q = this.db.selectFrom('lab_methods as m').selectAll('m')
      .select((eb) => eb.selectFrom('dx_services as s').select((e) => e.fn.countAll<number>().as('n')).whereRef('s.default_method_id', '=', 'm.id').as('services'))
      .orderBy('m.is_active', 'desc').orderBy('m.name');
    if (!includeInactive) q = q.where('m.is_active', '=', true);
    return q.execute();
  }
  async saveMethod(id: string | null, dto: { name?: string; kind?: 'analyzer' | 'manual' | 'method'; manufacturer?: string | null; serial_number?: string | null; note?: string | null; is_active?: boolean },
    user: AuthUser, ctx: AuditContext) {
    if (!(await this.isLabHead(user)) && !has(user, 'lab_manager')) throw new ForbiddenException('ანალიზატორებს მართავს ლაბორატორიის ხელმძღვანელი ან მენეჯერი');
    const vals = Object.fromEntries(Object.entries({ ...dto, name: dto.name?.trim(), manufacturer: dto.manufacturer?.trim() || null,
      serial_number: dto.serial_number?.trim() || null, note: dto.note?.trim() || null }).filter(([k]) => k in dto));
    try {
      return await this.db.transaction().execute(async (trx) => {
        if (id) {
          const old = await trx.selectFrom('lab_methods').selectAll().where('id', '=', id).executeTakeFirst();
          if (!old) throw new NotFoundException('ანალიზატორი ვერ მოიძებნა');
          const m = await trx.updateTable('lab_methods').set(vals).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
          await this.audit.log(ctx, { action: 'UPDATE_LAB_METHOD', entityName: 'lab_methods', entityId: id, oldData: old, newData: vals }, trx);
          return m;
        }
        if (!dto.name?.trim()) throw new BadRequestException('მიუთითეთ დასახელება');
        const m = await trx.insertInto('lab_methods').values({ name: dto.name.trim(), kind: dto.kind ?? 'analyzer', manufacturer: vals.manufacturer as string | null ?? null,
          serial_number: vals.serial_number as string | null ?? null, note: vals.note as string | null ?? null }).returningAll().executeTakeFirstOrThrow();
        await this.audit.log(ctx, { action: 'CREATE_LAB_METHOD', entityName: 'lab_methods', entityId: m.id, newData: m }, trx);
        return m;
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new ConflictException('ასეთი დასახელებით ანალიზატორი უკვე არსებობს');
      throw e;
    }
  }

  // =============================================================== ნორმები
  /** ყველა კომპონენტი მიმდინარე ნორმებით + ბოლო ცვლილება + დაუფარავი ასაკები */
  async normsList(q: { search?: string; group?: string }) {
    let query = this.db.selectFrom('lab_analytes as a').innerJoin('dx_services as s', 's.id', 'a.service_id')
      .leftJoin('lab_norm_versions as v', (j) => j.onRef('v.analyte_id', '=', 'a.id').onRef('v.version', '=', 'a.norm_version'))
      .leftJoin('users as u', 'u.id', 'v.changed_by')
      .select(['a.id', 'a.code', 'a.name', 'a.unit', 'a.result_type', 'a.decimals', 'a.critical_low', 'a.critical_high', 'a.norm_version', 'a.is_active',
        's.id as service_id', 's.name as service_name', 's.code as service_code', 's.group_name', 's.is_active as service_active',
        'v.changed_at', 'v.reason as last_reason', sql<string | null>`u.first_name || ' ' || u.last_name`.as('changed_by_name'),
        (eb) => jsonArrayFrom(eb.selectFrom('lab_reference_ranges as r').select(['r.sex', 'r.age_min_days', 'r.age_max_days', 'r.pregnancy', 'r.method_id', 'r.low', 'r.high', 'r.normal_text'])
          .whereRef('r.analyte_id', '=', 'a.id').orderBy('r.sex').orderBy('r.pregnancy').orderBy('r.age_min_days')).as('ranges')])
      .where('s.section', '=', 'lab').where('a.is_active', '=', true)
      .orderBy('s.group_name').orderBy('s.sort_order').orderBy('a.sort_order');
    if (q.group) query = query.where('s.group_name', '=', q.group);
    if (q.search?.trim()) {
      const t = `%${q.search.trim()}%`;
      query = query.where((eb) => eb.or([eb('a.name', 'ilike', t), eb('a.code', 'ilike', t), eb('s.name', 'ilike', t), eb('s.code', 'ilike', t)]));
    }
    const rows = await query.execute();
    return rows.map((r) => ({ ...r, gaps: coverageGaps(r.ranges as RangeRow[]) }));
  }

  async normHistory(analyteId: string) {
    const a = await this.db.selectFrom('lab_analytes as a').innerJoin('dx_services as s', 's.id', 'a.service_id')
      .select(['a.id', 'a.name', 'a.code', 'a.unit', 'a.result_type', 'a.norm_version', 's.name as service_name']).where('a.id', '=', analyteId).executeTakeFirst();
    if (!a) throw new NotFoundException('კომპონენტი ვერ მოიძებნა');
    const versions = await this.db.selectFrom('lab_norm_versions as v').leftJoin('users as u', 'u.id', 'v.changed_by')
      .select(['v.version', 'v.ranges', 'v.critical_low', 'v.critical_high', 'v.unit', 'v.reason', 'v.changed_at', 'v.recalculated',
        sql<string | null>`u.first_name || ' ' || u.last_name`.as('changed_by_name')])
      .where('v.analyte_id', '=', analyteId).orderBy('v.version', 'desc').execute();
    return { ...a, versions };
  }

  /**
   * ნორმების შეცვლა — ლაბორატორიის ხელმძღვანელი, მიზეზით; მოქმედებს მაშინვე.
   *  • ძველი ვერსია რჩება ისტორიაში (lab_norm_versions — უცვლელი)
   *  • ვალიდირებულ შედეგებს არ ეხება (ნორმის ასლი შედეგშია)
   *  • დაუმტკიცებელი შედეგები (აღებული / მიმდინარე / ვალიდაციას ელოდება) გადაითვლება ახალი ნორმით
   */
  async changeNorms(analyteId: string, dto: { ranges: RangeInput[]; critical_low?: number | null; critical_high?: number | null; reason: string }, user: AuthUser, ctx: AuditContext) {
    await this.requireHead(user, 'ნორმების შეცვლა');
    return this.db.transaction().execute(async (trx) => {
      const a = await trx.selectFrom('lab_analytes as a').innerJoin('dx_services as s', 's.id', 'a.service_id')
        .select(['a.id', 'a.name', 'a.unit', 'a.result_type', 'a.critical_low', 'a.critical_high', 'a.norm_version', 's.section'])
        .where('a.id', '=', analyteId).forUpdate(['a']).executeTakeFirst();
      if (!a || a.section !== 'lab') throw new NotFoundException('კომპონენტი ვერ მოიძებნა');
      const methods = await trx.selectFrom('lab_methods').select(['id', 'name']).execute();
      const mName = (id: string) => methods.find((m) => m.id === id)?.name ?? '?';
      const ranges: RangeRow[] = dto.ranges.map((r) => ({
        sex: r.sex ?? null, age_min_days: r.age_min_days ?? 0, age_max_days: r.age_max_days ?? AGE_MAX_DAYS, pregnancy: r.pregnancy ?? null, method_id: r.method_id ?? null,
        low: a.result_type === 'numeric' && r.low !== null && r.low !== undefined ? String(r.low) : null,
        high: a.result_type === 'numeric' && r.high !== null && r.high !== undefined ? String(r.high) : null,
        normal_text: a.result_type !== 'numeric' ? r.normal_text?.trim() || null : null,
      }));
      for (const r of ranges) if (r.method_id && !methods.some((m) => m.id === r.method_id)) throw new BadRequestException('უცნობი ანალიზატორი');
      const errs = validateRanges(ranges, a.result_type, mName);
      const cl = a.result_type === 'numeric' ? dto.critical_low ?? null : null; const ch = a.result_type === 'numeric' ? dto.critical_high ?? null : null;
      if (cl !== null && ch !== null && cl >= ch) errs.push('კრიტიკული ქვედა ზღვარი ზედაზე ნაკლები უნდა იყოს');
      if (errs.length) throw new BadRequestException(errs.join('; '));

      const current = await trx.selectFrom('lab_reference_ranges').select(['sex', 'age_min_days', 'age_max_days', 'pregnancy', 'method_id', 'low', 'high', 'normal_text'])
        .where('analyte_id', '=', a.id).execute();
      const same = JSON.stringify(normalizeRanges(current)) === JSON.stringify(normalizeRanges(ranges))
        && String(a.critical_low === null ? null : Number(a.critical_low)) === String(cl) && String(a.critical_high === null ? null : Number(a.critical_high)) === String(ch);
      if (same) throw new BadRequestException('ნორმები არ შეცვლილა');

      await trx.deleteFrom('lab_reference_ranges').where('analyte_id', '=', a.id).execute();
      if (ranges.length) await trx.insertInto('lab_reference_ranges').values(ranges.map((r) => ({ analyte_id: a.id, ...r }))).execute();
      const version = a.norm_version + 1;
      await trx.updateTable('lab_analytes').set({ critical_low: cl?.toString() ?? null, critical_high: ch?.toString() ?? null, norm_version: version }).where('id', '=', a.id).execute();

      // დაუმტკიცებელი შედეგების გადათვლა
      const open = await trx.selectFrom('lab_results as r').innerJoin('dx_order_items as i', 'i.id', 'r.order_item_id')
        .innerJoin('patients as p', 'p.id', 'i.patient_id').innerJoin('dx_services as s', 's.id', 'i.service_id').leftJoin('lab_specimens as sp', 'sp.id', 'i.specimen_id')
        .select(['r.id', 'r.value_num', 'r.value_text', 'r.flag', 'p.gender', 'p.birth_date', 'sp.collected_at', 'i.pregnancy_weeks', 'i.lab_method_id', 's.default_method_id'])
        .where('r.analyte_id', '=', a.id).where('i.status', 'in', ['collected', 'in_progress', 'resulted']).execute();
      const def = { id: a.id, result_type: a.result_type, unit: a.unit, critical_low: cl?.toString() ?? null, critical_high: ch?.toString() ?? null, ranges };
      for (const r of open) {
        const range = pickRange(ranges, { sex: r.gender, ageDays: ageDays(r.birth_date, r.collected_at ? new Date(r.collected_at) : new Date()),
          pregnancyWeeks: r.pregnancy_weeks, methodId: r.lab_method_id ?? r.default_method_id });
        await trx.updateTable('lab_results').set({ ref_low: range?.low ?? null, ref_high: range?.high ?? null, ref_text: range?.normal_text ?? null, norm_version: version,
          flag: computeFlag(def, range, r.value_num === null ? null : Number(r.value_num), r.value_text), recalculated_at: sql`now()` }).where('id', '=', r.id).execute();
      }
      await trx.insertInto('lab_norm_versions').values({ analyte_id: a.id, version, ranges: JSON.stringify(normalizeRanges(ranges)), unit: a.unit,
        critical_low: cl?.toString() ?? null, critical_high: ch?.toString() ?? null, reason: dto.reason.trim(), changed_by: user.id, recalculated: open.length }).execute();
      await this.audit.log(ctx, { action: 'CHANGE_LAB_NORMS', entityName: 'lab_analytes', entityId: a.id,
        oldData: { version: a.norm_version, ranges: normalizeRanges(current), critical_low: a.critical_low, critical_high: a.critical_high },
        newData: { version, ranges: normalizeRanges(ranges), critical_low: cl, critical_high: ch, reason: dto.reason, recalculated: open.length } }, trx);
      return { id: a.id, version, recalculated: open.length };
    });
  }

  // =============================================================== ბლანკები — სურათები
  async uploadImage(dataUrl: string, user: AuthUser, ctx: AuditContext) {
    await this.requireHead(user, 'ბლანკის რედაქტირება');
    const m = /^data:(image\/png|image\/jpeg);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
    if (!m) throw new BadRequestException('დაშვებულია მხოლოდ PNG ან JPG');
    const data = Buffer.from(m[2], 'base64');
    if (data.length > MAX_IMAGE) throw new BadRequestException(`სურათი მაქსიმუმ ${Math.round(MAX_IMAGE / 1024)} KB — შეამცირეთ ზომა`);
    const png = data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const jpg = data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    if ((m[1] === 'image/png' && !png) || (m[1] === 'image/jpeg' && !jpg)) throw new BadRequestException('ფაილის შიგთავსი არ ემთხვევა ტიპს');
    let dim: { width: number; height: number };
    try { dim = (new PDFDocument({ autoFirstPage: false }) as unknown as { openImage: (b: Buffer) => { width: number; height: number } }).openImage(data); }
    catch { throw new BadRequestException('სურათი ვერ წაიკითხა (დაზიანებული ან მხარდაუჭერელი ფორმატი)'); }
    const sha = createHash('sha256').update(data).digest('hex');
    const row = await this.db.insertInto('lab_blank_images').values({ sha256: sha, mime: m[1], data, width: dim.width, height: dim.height, uploaded_by: user.id })
      .onConflict((oc) => oc.column('sha256').doNothing()).returning(['id', 'width', 'height']).executeTakeFirst()
      ?? await this.db.selectFrom('lab_blank_images').select(['id', 'width', 'height']).where('sha256', '=', sha).executeTakeFirstOrThrow();
    await this.audit.log(ctx, { action: 'UPLOAD_LAB_BLANK_IMAGE', entityName: 'lab_blank_images', entityId: row.id, newData: { sha256: sha, bytes: data.length } });
    return row;
  }
  async image(id: string) {
    const r = await this.db.selectFrom('lab_blank_images').select(['mime', 'data']).where('id', '=', id).executeTakeFirst();
    if (!r) throw new NotFoundException('სურათი ვერ მოიძებნა');
    return r;
  }
  private async imagesFor(settings: BlankSettings[]) {
    const ids = [...new Set(settings.flatMap(blankImageIds))];
    const map = new Map<string, Buffer>();
    if (ids.length) for (const r of await this.db.selectFrom('lab_blank_images').select(['id', 'data']).where('id', 'in', ids).execute()) map.set(r.id, r.data);
    return map;
  }

  // =============================================================== ბლანკები — შაბლონები
  listBlanks() {
    return this.db.selectFrom('lab_blank_templates as t')
      .innerJoin('lab_blank_versions as v', (j) => j.onRef('v.template_id', '=', 't.id').onRef('v.version', '=', 't.current_version'))
      .leftJoin('users as u', 'u.id', 'v.created_by')
      .select(['t.id', 't.name', 't.is_default', 't.is_active', 't.current_version', 'v.created_at as version_at', 'v.settings',
        sql<string | null>`u.first_name || ' ' || u.last_name`.as('version_by'),
        (eb) => eb.selectFrom('lab_blank_group_assignments as g').select(sql<string[]>`coalesce(array_agg(g.group_name ORDER BY g.group_name), '{}')`.as('x')).whereRef('g.template_id', '=', 't.id').as('groups'),
        (eb) => eb.selectFrom('dx_services as s').select((e) => e.fn.countAll<number>().as('n')).whereRef('s.blank_template_id', '=', 't.id').as('services')])
      .orderBy('t.is_default', 'desc').orderBy('t.is_active', 'desc').orderBy('t.name').execute();
  }

  async blankDetail(id: string) {
    const t = await this.db.selectFrom('lab_blank_templates').selectAll().where('id', '=', id).executeTakeFirst();
    if (!t) throw new NotFoundException('შაბლონი ვერ მოიძებნა');
    const versions = await this.db.selectFrom('lab_blank_versions as v').leftJoin('users as u', 'u.id', 'v.created_by')
      .select(['v.version', 'v.created_at', sql<string | null>`u.first_name || ' ' || u.last_name`.as('created_by_name'),
        (eb) => eb.selectFrom('dx_order_items as i').select((e) => e.fn.countAll<number>().as('n')).whereRef('i.blank_version_id', '=', 'v.id').as('used')])
      .where('v.template_id', '=', id).orderBy('v.version', 'desc').execute();
    const cur = await this.versionSettings(id, t.current_version);
    const groups = (await this.db.selectFrom('lab_blank_group_assignments').select('group_name').where('template_id', '=', id).execute()).map((g) => g.group_name);
    const services = await this.db.selectFrom('dx_services').select(['id', 'code', 'name', 'group_name']).where('blank_template_id', '=', id).orderBy('name').execute();
    return { ...t, settings: cur, versions, groups, service_ids: services.map((s) => s.id), services };
  }

  async versionSettings(templateId: string, version: number) {
    const v = await this.db.selectFrom('lab_blank_versions').select('settings').where('template_id', '=', templateId).where('version', '=', version).executeTakeFirst();
    if (!v) throw new NotFoundException('ვერსია ვერ მოიძებნა');
    return sanitizeBlank(v.settings);
  }

  async createBlank(dto: { name: string; copy_from?: string }, user: AuthUser, ctx: AuditContext) {
    await this.requireHead(user, 'ბლანკის შექმნა');
    let settings = DEFAULT_BLANK;
    if (dto.copy_from) { const src = await this.blankDetail(dto.copy_from); settings = src.settings; }
    try {
      const id = await this.db.transaction().execute(async (trx) => {
        const t = await trx.insertInto('lab_blank_templates').values({ name: dto.name.trim(), created_by: user.id }).returning('id').executeTakeFirstOrThrow();
        await trx.insertInto('lab_blank_versions').values({ template_id: t.id, version: 1, settings: JSON.stringify(settings), created_by: user.id }).execute();
        await this.audit.log(ctx, { action: 'CREATE_LAB_BLANK', entityName: 'lab_blank_templates', entityId: t.id, newData: { name: dto.name, copy_from: dto.copy_from } }, trx);
        return t.id;
      });
      return this.blankDetail(id);
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new ConflictException('ასეთი სახელით შაბლონი უკვე არსებობს');
      throw e;
    }
  }

  /** შენახვა: პარამეტრების ცვლილება = ახალი ვერსია (ძველი ვერსიით დაბეჭდილი პასუხები უცვლელი რჩება) */
  async saveBlank(id: string, dto: { name?: string; settings?: unknown; is_active?: boolean }, user: AuthUser, ctx: AuditContext) {
    await this.requireHead(user, 'ბლანკის რედაქტირება');
    try {
      await this.db.transaction().execute(async (trx) => {
        const t = await trx.selectFrom('lab_blank_templates').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
        if (!t) throw new NotFoundException('შაბლონი ვერ მოიძებნა');
        const set: { name?: string; is_active?: boolean; current_version?: number } = {};
        if (dto.name !== undefined && dto.name.trim() !== t.name) set.name = dto.name.trim();
        if (dto.is_active !== undefined && dto.is_active !== t.is_active) {
          if (!dto.is_active && t.is_default) throw new ConflictException('ნაგულისხმევ შაბლონს ვერ გათიშავთ — ჯერ სხვა გახადეთ ნაგულისხმევი');
          set.is_active = dto.is_active;
        }
        let newVersion: number | null = null;
        if (dto.settings !== undefined) {
          const next = sanitizeBlank(dto.settings);
          const ids = blankImageIds(next);
          if (ids.length) {
            const found = await trx.selectFrom('lab_blank_images').select('id').where('id', 'in', ids).execute();
            if (found.length !== new Set(ids).size) throw new BadRequestException('სურათი ვერ მოიძებნა — ატვირთეთ თავიდან');
          }
          const cur = await trx.selectFrom('lab_blank_versions').select('settings').where('template_id', '=', id).where('version', '=', t.current_version).executeTakeFirstOrThrow();
          if (JSON.stringify(sanitizeBlank(cur.settings)) !== JSON.stringify(next)) {
            newVersion = t.current_version + 1;
            await trx.insertInto('lab_blank_versions').values({ template_id: id, version: newVersion, settings: JSON.stringify(next), created_by: user.id }).execute();
            set.current_version = newVersion;
          }
        }
        if (!Object.keys(set).length) return;
        await trx.updateTable('lab_blank_templates').set(set).where('id', '=', id).execute();
        await this.audit.log(ctx, { action: 'UPDATE_LAB_BLANK', entityName: 'lab_blank_templates', entityId: id, oldData: { name: t.name, is_active: t.is_active, version: t.current_version }, newData: set }, trx);
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new ConflictException('ასეთი სახელით შაბლონი უკვე არსებობს');
      throw e;
    }
    return this.blankDetail(id);
  }

  async setDefault(id: string, user: AuthUser, ctx: AuditContext) {
    await this.requireHead(user, 'ნაგულისხმევი ბლანკის შეცვლა');
    await this.db.transaction().execute(async (trx) => {
      const t = await trx.selectFrom('lab_blank_templates').select(['id', 'is_active']).where('id', '=', id).executeTakeFirst();
      if (!t) throw new NotFoundException('შაბლონი ვერ მოიძებნა');
      if (!t.is_active) throw new ConflictException('გათიშული შაბლონი ნაგულისხმევი ვერ იქნება');
      await trx.updateTable('lab_blank_templates').set({ is_default: false }).where('is_default', '=', true).execute();
      await trx.updateTable('lab_blank_templates').set({ is_default: true }).where('id', '=', id).execute();
      await this.audit.log(ctx, { action: 'SET_DEFAULT_LAB_BLANK', entityName: 'lab_blank_templates', entityId: id }, trx);
    });
    return this.listBlanks();
  }

  /** მინიჭება: ჯგუფები და ცალკეული ანალიზები (სია სრულად იცვლება ამ შაბლონისთვის) */
  async setAssignments(id: string, dto: { groups: string[]; service_ids: string[] }, user: AuthUser, ctx: AuditContext) {
    await this.requireHead(user, 'ბლანკის მინიჭება');
    await this.db.transaction().execute(async (trx) => {
      const t = await trx.selectFrom('lab_blank_templates').select(['id', 'is_active']).where('id', '=', id).executeTakeFirst();
      if (!t) throw new NotFoundException('შაბლონი ვერ მოიძებნა');
      if (!t.is_active && (dto.groups.length || dto.service_ids.length)) throw new ConflictException('გათიშულ შაბლონს ვერ მიანიჭებთ');
      const groups = [...new Set(dto.groups.map((g) => g.trim()).filter(Boolean))];
      await trx.deleteFrom('lab_blank_group_assignments').where('template_id', '=', id).execute();
      if (groups.length) {
        await trx.insertInto('lab_blank_group_assignments').values(groups.map((g) => ({ group_name: g, template_id: id })))
          .onConflict((oc) => oc.column('group_name').doUpdateSet({ template_id: id })).execute();
      }
      await trx.updateTable('dx_services').set({ blank_template_id: null }).where('blank_template_id', '=', id).execute();
      if (dto.service_ids.length) {
        const r = await trx.updateTable('dx_services').set({ blank_template_id: id }).where('id', 'in', dto.service_ids).where('section', '=', 'lab').executeTakeFirst();
        if (Number(r.numUpdatedRows) !== new Set(dto.service_ids).size) throw new BadRequestException('ზოგიერთი ანალიზი ვერ მოიძებნა');
      }
      await this.audit.log(ctx, { action: 'ASSIGN_LAB_BLANK', entityName: 'lab_blank_templates', entityId: id, newData: { groups, service_ids: dto.service_ids } }, trx);
    });
    return this.blankDetail(id);
  }

  // =============================================================== PDF
  /** ნიმუში რედაქტორისთვის — სატესტო პაციენტი და შედეგები (ცხრილი, გადახრები, კრიტიკული, ტექსტური) */
  async previewPdf(input: unknown) {
    const settings = sanitizeBlank(input);
    const clinic = await this.clinic();
    const images = await this.imagesFor([settings]);
    const R = (name: string, v: string | null, unit: string, lo: string | null, hi: string | null, flag: string | null, prev?: string, txt?: string) =>
      ({ name, value_num: v, value_text: txt ?? null, unit, ref_low: lo, ref_high: hi, ref_text: null, flag, previous: prev ? { value: prev, at: '2026-03-02' } : null });
    const now = new Date();
    const items: BlankItem[] = [
      { service_name: 'სისხლის საერთო ანალიზი', group_name: 'ჰემატოლოგია', comment: null, barcode: '1000123', collected_at: now.toISOString(), received_at: now.toISOString(),
        validated_at: now.toISOString(), validated_by_name: 'ნინო ლაბაძე', method_name: 'Mindray BC-6200', results: [
          R('ლეიკოციტები', '11.8', '10^9/L', '4', '10', 'H', '7.2'), R('ერითროციტები', '4.62', '10^12/L', '4.5', '5.9', 'N', '4.70'),
          R('ჰემოგლობინი', '138', 'g/L', '135', '175', 'N', '141'), R('ჰემატოკრიტი', '41.2', '%', '40', '52', 'N'),
          R('თრომბოციტები', '18', '10^9/L', '150', '400', 'LL', '212'), R('ნეიტროფილები', '78.5', '%', '40', '75', 'H'), R('ლიმფოციტები', '15.1', '%', '20', '45', 'L') ] },
      { service_name: 'გლუკოზა', group_name: 'ბიოქიმია', comment: 'უზმოზე. დიაბეტის დიაგნოსტიკური ზღვარი: 7.0 mmol/L და მეტი (ორჯერადი გაზომვით).', barcode: '1000124',
        collected_at: now.toISOString(), received_at: now.toISOString(), validated_at: now.toISOString(), validated_by_name: 'ნინო ლაბაძე', method_name: 'Cobas c311',
        results: [R('გლუკოზა', '5.4', 'mmol/L', '3.9', '6.1', 'N', '5.9')] },
      { service_name: 'შარდის საერთო ანალიზი', group_name: 'შარდი', comment: null, barcode: '1000125', collected_at: now.toISOString(), received_at: now.toISOString(),
        validated_at: now.toISOString(), validated_by_name: 'ნინო ლაბაძე', method_name: null, results: [
          { ...R('ფერი', null, '', null, null, 'N', undefined, 'ჩალისფერი'), ref_text: 'ჩალისფერი' }, { ...R('ცილა', null, '', null, null, 'A', undefined, 'დადებითი (+)'), ref_text: 'უარყოფითი' },
          { ...R('ლეიკოციტები (მიკროსკოპია)', null, '', null, null, null, undefined, '2–3 მხედველობის არეში'), ref_text: '0–5' } ] },
    ];
    return renderLabBlank({
      clinic, preview: true, printed_at: now,
      patient: { name: 'ნიმუში ნიმუშაძე', birth_date: '1984-05-17', gender: 'female', id_number: '01001012345', phone: '599 12 34 56' },
      ordered_by: 'გიორგი ექიმაძე', referral: 'კლინიკა „ჯანმრთელობა“', pregnancy_weeks: null,
      sections: [{ settings, images, items, verify_url: `${this.labVerifyBase()}/00000000-0000-4000-8000-000000000000` }],
    });
  }

  /** ვიზიტის ვალიდირებული ლაბ. შედეგები (ან ერთი ?item=) — თითოეული იმ ბლანკის ვერსიით, რომლითაც დადასტურდა */
  async encounterReport(encounterId: string, itemId?: string) {
    const all = await this.dx.encounterItems(encounterId);
    const items = all.filter((r) => r.section === 'lab' && r.status === 'validated' && (!itemId || r.id === itemId));
    if (!items.length) throw new BadRequestException('ვალიდირებული ლაბორატორიული შედეგი არ არის');
    const p0 = items[0];
    // ბლანკის ვერსიები (ძველ ჩანაწერებს, თუ აკლია — მიმდინარე შაბლონი)
    const verIds = new Map<string, string>();
    for (const it of items) {
      const v = it.blank_version_id ?? (await sql<{ id: string | null }>`SELECT lab_blank_version_for(${it.id}::uuid) AS id`.execute(this.db)).rows[0]?.id;
      if (!v) throw new ConflictException('ბლანკის შაბლონი ვერ მოიძებნა — ლაბორატორიის ხელმძღვანელმა მიუთითოს ნაგულისხმევი შაბლონი');
      verIds.set(it.id, v);
    }
    const versions = await this.db.selectFrom('lab_blank_versions').select(['id', 'settings']).where('id', 'in', [...new Set(verIds.values())]).execute();
    const settingsOf = new Map(versions.map((v) => [v.id, sanitizeBlank(v.settings)]));
    const images = await this.imagesFor([...settingsOf.values()]);
    const methods = new Map((await this.db.selectFrom('lab_methods').select(['id', 'name']).execute()).map((m) => [m.id, m.name]));
    const needPrev = [...settingsOf.values()].some((s) => s.columns.includes('previous'));
    const patient = await this.db.selectFrom('patients').select(['phone_number']).where('id', '=', p0.patient_id).executeTakeFirst();

    const toItem = async (it: (typeof items)[number]): Promise<BlankItem> => {
      let prev = new Map<string, { value: string; at: string }>();
      if (needPrev && it.results.length && it.validated_at) {
        const rows = await sql<{ analyte_id: string; value_num: string | null; value_text: string | null; validated_at: string }>`
          SELECT DISTINCT ON (r.analyte_id) r.analyte_id, r.value_num, r.value_text, i.validated_at::text
          FROM lab_results r JOIN dx_order_items i ON i.id = r.order_item_id
          WHERE i.patient_id = ${it.patient_id} AND i.status = 'validated' AND i.validated_at < ${it.validated_at}
            AND r.analyte_id = ANY(${it.results.map((r) => r.analyte_id)}::uuid[])
          ORDER BY r.analyte_id, i.validated_at DESC`.execute(this.db);
        prev = new Map(rows.rows.map((r) => [r.analyte_id, { value: r.value_num !== null ? String(Number(r.value_num)) : r.value_text ?? '', at: r.validated_at.slice(0, 10) }]));
      }
      const mid = it.lab_method_id ?? it.default_method_id;
      return {
        service_name: it.service_name, group_name: it.group_name, comment: it.report_comment, barcode: it.barcode,
        collected_at: it.collected_at ? String(it.collected_at) : null, received_at: it.received_at ? String(it.received_at) : null,
        validated_at: it.validated_at ? String(it.validated_at) : null, validated_by_name: it.validated_by_name, method_name: mid ? methods.get(mid) ?? null : null,
        results: it.results.map((r) => ({ ...r, previous: prev.get(r.analyte_id) ?? null })),
      };
    };
    // სექციები: ერთნაირი ვერსიის შედეგები ერთად, პირველი გამოჩენის რიგით; ჯგუფების სათაურებისთვის — ჯგუფით დალაგებული
    const order = [...new Set(items.map((i) => verIds.get(i.id)!))];
    const sections: BlankSection[] = [];
    for (const vid of order) {
      const S = settingsOf.get(vid)!;
      const its = items.filter((i) => verIds.get(i.id) === vid);
      if (S.group_headers) its.sort((a, b) => a.group_name.localeCompare(b.group_name, 'ka'));
      sections.push({ settings: S, images, items: await Promise.all(its.map(toItem)), verify_url: its[0].verify_token ? `${this.labVerifyBase()}/${its[0].verify_token}` : null });
    }
    const preg = items.find((i) => i.pregnancy_weeks)?.pregnancy_weeks ?? null;
    const input: BlankInput = {
      clinic: await this.clinic(),
      patient: { name: `${p0.first_name} ${p0.last_name}`, birth_date: p0.birth_date, gender: p0.gender, id_number: p0.personal_number, phone: patient?.phone_number ?? null },
      ordered_by: p0.visit_kind === 'lab' ? null : p0.ordered_by_name, referral: p0.external_referral, pregnancy_weeks: preg, sections,
    };
    return renderLabBlank(input);
  }

  // =============================================================== QR ვერიფიკაცია (საჯარო)
  labVerifyBase() { return this.env.PUBLIC_VERIFY_BASE_URL.replace(/\/+$/, '').replace(/\/verify$/, '/lab-verify'); }

  async publicVerify(token: string) {
    if (!/^[0-9a-f-]{36}$/i.test(token)) return { valid: false as const };
    const it = await this.db.selectFrom('dx_order_items as i').innerJoin('patients as p', 'p.id', 'i.patient_id')
      .select(['i.encounter_id', 'p.first_name', 'p.last_name', 'p.birth_date']).where('i.verify_token', '=', token).where('i.status', '=', 'validated').executeTakeFirst();
    if (!it) return { valid: false as const };
    const tests = await this.db.selectFrom('dx_order_items as i').innerJoin('dx_services as s', 's.id', 'i.service_id')
      .select(['s.name', 'i.validated_at']).where('i.encounter_id', '=', it.encounter_id).where('i.section', '=', 'lab').where('i.status', '=', 'validated')
      .orderBy('i.validated_at').execute();
    const clinic = await this.clinic();
    return { valid: true as const, institution: clinic.name, patient_initials: `${it.first_name.slice(0, 1)}. ${it.last_name.slice(0, 1)}.`, birth_year: it.birth_date.slice(0, 4),
      tests: tests.map((t) => ({ name: t.name, validated_at: t.validated_at })) };
  }

  private async clinic() {
    try { const c = await this.settings.get(); return { name: c.name, address: c.address, phone: c.phone, email: c.email }; }
    catch { return { name: '<კლინიკის დასახელება>', address: '<მისამართი>', phone: null, email: null }; }
  }
}
