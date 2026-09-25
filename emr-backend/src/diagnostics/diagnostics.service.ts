import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { jsonArrayFrom } from 'kysely/helpers/postgres';
import { AllergyCheckService } from '../allergies/allergy-check.service';
import { AuditService, type AuditContext } from '../audit/audit.service';
import type { AuthUser } from '../auth/roles';
import { InjectDb, type Database } from '../database/database.module';
import type { DB } from '../database/db';
import { EncounterCoreService } from '../encounters/encounter-core.service';

type Trx = Transaction<DB>;
export type Flag = 'N' | 'L' | 'H' | 'LL' | 'HH' | 'A';

export interface RangeRow { sex: string | null; age_min_days: number; age_max_days: number; low: string | null; high: string | null; normal_text: string | null }
export interface AnalyteDef { id: string; result_type: string; unit: string; critical_low: string | null; critical_high: string | null; ranges: RangeRow[] }

/** შესაბამისი ნორმა: სქესის სპეციფიკური უპირატესია ზოგადზე */
export function pickRange(ranges: RangeRow[], sex: string, ageDays: number): RangeRow | null {
  const fit = ranges.filter((r) => (r.sex === null || r.sex === sex) && ageDays >= r.age_min_days && ageDays <= r.age_max_days);
  return fit.find((r) => r.sex === sex) ?? fit[0] ?? null;
}

/** ნიშანი: LL/HH — კრიტიკული, L/H — ნორმის გარეთ, A — ხარისხობრივი გადახრა */
export function computeFlag(a: AnalyteDef, range: RangeRow | null, num: number | null, text: string | null): Flag | null {
  if (a.result_type === 'numeric') {
    if (num === null) return null;
    if (a.critical_low !== null && num < Number(a.critical_low)) return 'LL';
    if (a.critical_high !== null && num > Number(a.critical_high)) return 'HH';
    if (range?.low !== null && range?.low !== undefined && num < Number(range.low)) return 'L';
    if (range?.high !== null && range?.high !== undefined && num > Number(range.high)) return 'H';
    return range ? 'N' : null;
  }
  if (!text) return null;
  if (range?.normal_text) return text.trim() === range.normal_text ? 'N' : 'A';
  return null;
}

/** სინჯარების აღების სტანდარტული რიგი (order of draw, CLSI GP41) */
const DRAW_ORDER = ['citrate', 'serum', 'heparin', 'edta', 'fluoride'];
const drawRank = (container: string | null, specimen: string | null) => {
  const c = (container ?? '').toLowerCase();
  const i = DRAW_ORDER.findIndex((k) => c.includes(k));
  if (i >= 0) return i;
  return specimen === 'urine' || specimen === 'stool' || specimen === 'swab' ? 20 : 10;
};
/** ანალიზები → სინჯარები (ნიმუში + კონტეინერი + შიდა/გარე), აღების რიგით */
export function tubesInOrder<T extends { specimen_type: string | null; container: string | null; performed_by: string; name: string }>(items: T[]) {
  const groups = new Map<string, { specimen_type: string; container: string | null; external: boolean; items: T[] }>();
  for (const it of items) {
    const key = `${it.specimen_type}|${it.container ?? ''}|${it.performed_by}`;
    const g = groups.get(key) ?? { specimen_type: it.specimen_type ?? 'other', container: it.container, external: it.performed_by === 'external', items: [] };
    g.items.push(it); groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => drawRank(a.container, a.specimen_type) - drawRank(b.container, b.specimen_type))
    .map((g) => ({ ...g, tests: g.items.map((i) => i.name) }));
}

const ageDays = (birth: string, at: Date) => Math.floor((at.getTime() - new Date(`${birth}T00:00:00Z`).getTime()) / 86_400_000);

@Injectable()
export class DiagnosticsService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService,
              private readonly core: EncounterCoreService, private readonly allergy: AllergyCheckService) {}

  // =============================================================== კატალოგი
  catalog(q: { section?: string; search?: string; includeInactive?: boolean }) {
    let query = this.db.selectFrom('dx_services as s').innerJoin('service_tariffs as t', 't.id', 's.tariff_id')
      .select(['s.id', 's.section', 's.code', 's.name', 's.group_name', 's.performed_by', 's.external_lab', 's.specimen_type', 's.container',
        's.modality', 's.body_part', 's.contrast', 's.is_active', 's.needs_review', 's.sort_order', 't.base_price', 's.tariff_id'])
      .orderBy('s.section').orderBy('s.group_name').orderBy('s.sort_order');
    if (q.section) query = query.where('s.section', '=', q.section);
    if (!q.includeInactive) query = query.where('s.is_active', '=', true);
    if (q.search?.trim()) query = query.where((eb) => eb.or([eb('s.name', 'ilike', `%${q.search!.trim()}%`), eb('s.code', 'ilike', `%${q.search!.trim()}%`)]));
    return query.execute();
  }

  async serviceDetail(id: string) {
    const s = await this.db.selectFrom('dx_services as s').innerJoin('service_tariffs as t', 't.id', 's.tariff_id')
      .selectAll('s').select(['t.base_price'])
      .select((eb) => jsonArrayFrom(eb.selectFrom('lab_analytes as a').selectAll('a')
        .select((eb2) => jsonArrayFrom(eb2.selectFrom('lab_reference_ranges as r').selectAll('r').whereRef('r.analyte_id', '=', 'a.id').orderBy('r.sex')).as('ranges'))
        .whereRef('a.service_id', '=', 's.id').orderBy('a.sort_order')).as('analytes'))
      .where('s.id', '=', id).executeTakeFirst();
    if (!s) throw new NotFoundException('კვლევა ვერ მოიძებნა');
    return s;
  }

  /** ჯგუფები (ჩამოსაშლელისთვის): ჰემატოლოგია, ბიოქიმია… */
  async groups(section: string) {
    const rows = await this.db.selectFrom('dx_services').select('group_name').distinct().where('section', '=', section).orderBy('group_name').execute();
    return rows.map((r) => r.group_name);
  }

  /**
   * ახალი კვლევა (ანალიზის ფორმა). ლაბ. მენეჯერი/ექიმი — მხოლოდ ლაბორატორია; ფასი — მხოლოდ admin/მოლარე.
   * ტარიფი ავტომატურად იქმნება იმავე კოდით (ფასი 0, სანამ ფინანსები არ დააყენებს).
   */
  async createService(dto: { section: 'lab' | 'radiology' | 'endoscopy'; code: string; name: string; group_name: string; specimen_type?: string | null; container?: string | null;
    modality?: string | null; body_part?: string | null; contrast?: string | null; performed_by?: 'internal' | 'external'; external_lab?: string | null; base_price?: number }, user: AuthUser, ctx: AuditContext) {
    const labRole = user.role === 'lab_manager' || user.role === 'lab_doctor';
    if (labRole && dto.section !== 'lab') throw new ForbiddenException('ლაბორატორიის როლს შეუძლია მხოლოდ ლაბორატორიული ანალიზის დამატება');
    if (dto.section === 'lab' && !dto.specimen_type) throw new BadRequestException('მიუთითეთ ნიმუშის ტიპი');
    const price = user.role === 'admin' || user.role === 'billing' ? dto.base_price ?? 0 : 0;
    const code = dto.code.trim().toUpperCase();
    const newId = await this.db.transaction().execute(async (trx) => {
      const dup = await trx.selectFrom('service_tariffs').select('id').where('code', '=', code).executeTakeFirst();
      if (dup) throw new ConflictException(`კოდი ${code} უკვე გამოყენებულია`);
      const t = await trx.insertInto('service_tariffs').values({ code, title: dto.name.trim(), base_price: price.toFixed(2) }).returning('id').executeTakeFirstOrThrow();
      const maxSort = await trx.selectFrom('dx_services').select((eb) => eb.fn.max('sort_order').as('m')).where('section', '=', dto.section).executeTakeFirst();
      const s = await trx.insertInto('dx_services').values({
        section: dto.section, code, name: dto.name.trim(), group_name: dto.group_name.trim(), tariff_id: t.id,
        specimen_type: dto.specimen_type ?? null, container: dto.container?.trim() || null, modality: dto.modality ?? null, body_part: dto.body_part ?? null,
        contrast: dto.contrast ?? null, performed_by: dto.performed_by ?? 'internal', external_lab: dto.performed_by === 'external' ? dto.external_lab?.trim() || null : null,
        sort_order: (Number(maxSort?.m ?? 0) || 0) + 10, needs_review: true,
      }).returning('id').executeTakeFirstOrThrow();
      await this.audit.log(ctx, { action: 'CREATE_DX_SERVICE', entityName: 'dx_services', entityId: s.id, newData: { ...dto, code, base_price: price } }, trx);
      return s.id;
    });
    return this.serviceDetail(newId);   // commit-ის შემდეგ
  }

  async updateService(id: string, dto: { name?: string; group_name?: string; specimen_type?: string | null; container?: string | null; base_price?: number;
    performed_by?: 'internal' | 'external'; external_lab?: string | null; is_active?: boolean; approve?: boolean }, user: AuthUser, ctx: AuditContext) {
    await this.db.transaction().execute(async (trx) => {
      const old = await trx.selectFrom('dx_services').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!old) throw new NotFoundException('კვლევა ვერ მოიძებნა');
      const r = user.role;
      const canPrice = r === 'admin' || r === 'billing';
      const canEdit = r === 'admin' || ((r === 'lab_manager' || r === 'lab_doctor') && old.section === 'lab');
      const canApprove = r === 'admin' || (r === 'lab_doctor' && old.section === 'lab');
      if (dto.base_price !== undefined && !canPrice) throw new ForbiddenException('ფასის შეცვლა შეუძლია მხოლოდ ადმინისტრატორს ან მოლარეს');
      if (dto.approve && !canApprove) throw new ForbiddenException('დამტკიცება შეუძლია ლაბორატორიის ექიმს / ხელმძღვანელს');
      const set: Record<string, unknown> = {};
      for (const k of ['name', 'group_name', 'specimen_type', 'container', 'performed_by', 'external_lab', 'is_active'] as const) {
        if (dto[k] !== undefined) {
          if (!canEdit) throw new ForbiddenException('კვლევის რედაქტირების უფლება არ გაქვთ');
          set[k] = typeof dto[k] === 'string' ? (dto[k] as string).trim() || null : dto[k];
        }
      }
      if (set.performed_by === 'internal') set.external_lab = null;
      const contentChanged = ['name', 'specimen_type', 'container'].some((k) => k in set && set[k] !== (old as Record<string, unknown>)[k]);
      if (dto.approve) set.needs_review = false; else if (contentChanged) set.needs_review = true;
      if (Object.keys(set).length) await trx.updateTable('dx_services').set(set).where('id', '=', id).execute();
      if (dto.base_price !== undefined || set.name) {
        await trx.updateTable('service_tariffs').set({ ...(dto.base_price !== undefined ? { base_price: dto.base_price.toFixed(2) } : {}), ...(set.name ? { title: set.name as string } : {}) })
          .where('id', '=', old.tariff_id).execute();
      }
      await this.audit.log(ctx, { action: dto.approve ? 'APPROVE_DX_SERVICE' : 'UPDATE_DX_SERVICE', entityName: 'dx_services', entityId: id, oldData: old, newData: { ...set, base_price: dto.base_price } }, trx);
    });
    return this.serviceDetail(id);
  }

  /** კომპონენტი + ნორმები (ნორმები მთლიანად იცვლება) */
  async saveAnalyte(serviceId: string, dto: { id?: string; code: string; name: string; unit: string; result_type: 'numeric' | 'text' | 'select'; decimals?: number | null;
    options?: string | null; critical_low?: number | null; critical_high?: number | null; sort_order?: number; is_active?: boolean;
    ranges: { sex: 'male' | 'female' | null; age_min_days?: number; age_max_days?: number; low?: number | null; high?: number | null; normal_text?: string | null }[] }, ctx: AuditContext) {
    await this.db.transaction().execute(async (trx) => {
      const svc = await trx.selectFrom('dx_services').select(['section']).where('id', '=', serviceId).executeTakeFirst();
      if (!svc || svc.section !== 'lab') throw new BadRequestException('კომპონენტები მხოლოდ ლაბორატორიულ კვლევას აქვს');
      const vals = { code: dto.code, name: dto.name, unit: dto.unit ?? '', result_type: dto.result_type, decimals: dto.decimals ?? null, options: dto.options ?? null,
        critical_low: dto.critical_low?.toString() ?? null, critical_high: dto.critical_high?.toString() ?? null, sort_order: dto.sort_order ?? 0, is_active: dto.is_active ?? true };
      const a = dto.id
        ? await trx.updateTable('lab_analytes').set(vals).where('id', '=', dto.id).where('service_id', '=', serviceId).returning('id').executeTakeFirstOrThrow()
        : await trx.insertInto('lab_analytes').values({ service_id: serviceId, ...vals }).returning('id').executeTakeFirstOrThrow();
      await trx.deleteFrom('lab_reference_ranges').where('analyte_id', '=', a.id).execute();
      if (dto.ranges.length) {
        await trx.insertInto('lab_reference_ranges').values(dto.ranges.map((r) => ({
          analyte_id: a.id, sex: r.sex, age_min_days: r.age_min_days ?? 0, age_max_days: r.age_max_days ?? 54750,
          low: r.low?.toString() ?? null, high: r.high?.toString() ?? null, normal_text: r.normal_text ?? null,
        }))).execute();
      }
      await trx.updateTable('dx_services').set({ needs_review: true }).where('id', '=', serviceId).execute();
      await this.audit.log(ctx, { action: 'SAVE_LAB_ANALYTE', entityName: 'lab_analytes', entityId: a.id, newData: dto }, trx);
    });
    return this.serviceDetail(serviceId);
  }

  // =============================================================== შეკვეთა (ექიმი)
  async order(encounterId: string, dto: { items: { service_id: string; priority?: 'routine' | 'urgent'; note?: string }[]; allergy_override_reason?: string }, user: AuthUser, ctx: AuditContext) {
    if (!dto.items?.length) throw new BadRequestException('აირჩიეთ მინიმუმ ერთი კვლევა');
    const res = await this.db.transaction().execute(async (trx) => {
      const e = await this.core.lock(trx, encounterId, ['active']);
      this.core.assertClinicalWriter(e, user);
      return this.insertItems(trx, { id: encounterId, patient_id: e.patient_id }, dto.items, dto.allergy_override_reason, user, ctx);
    });
    if ('conflict' in res) throw new ConflictException({ code: 'ALLERGY_CONFLICT', message: 'პაციენტს აქვს ალერგია კონტრასტზე — საჭიროა დასაბუთება', check: res.conflict });
    return res.created;
  }

  /**
   * ლაბორატორიული ვიზიტი ექიმის გარეშე (რეგისტრატურა): ვიზიტი planned + ინვოისი ანალიზების ხაზებით.
   * გადახდის შემდეგ (pay-initial) → active → ფლებოტომისტის რიგში. ყველა შედეგის დასრულებისას ვიზიტი ავტომატურად იხურება.
   */
  async labVisit(dto: { patient_id: string; items: { service_id: string; priority?: 'routine' | 'urgent'; note?: string }[]; external_referral?: string; department_id?: string; allergy_override_reason?: string }, user: AuthUser, ctx: AuditContext) {
    if (!dto.items?.length) throw new BadRequestException('აირჩიეთ მინიმუმ ერთი ანალიზი');
    const res = await this.db.transaction().execute(async (trx) => {
      const patient = await trx.selectFrom('patients').select(['id', 'is_deceased']).where('id', '=', dto.patient_id).executeTakeFirst();
      if (!patient) throw new NotFoundException('პაციენტი ვერ მოიძებნა');
      if (patient.is_deceased) throw new BadRequestException('პაციენტი გარდაცვლილად არის მონიშნული');
      const dept = dto.department_id
        ? await trx.selectFrom('departments').select('id').where('id', '=', dto.department_id).where('is_active', '=', true).executeTakeFirst()
        : await trx.selectFrom('departments').select('id').where('type', '=', 'diagnostic').where('is_active', '=', true).orderBy('name').executeTakeFirst();
      if (!dept) throw new BadRequestException('ლაბორატორიის (დიაგნოსტიკური) განყოფილება არ არის შექმნილი — ადმინისტრირება → განყოფილებები');
      const enc = await trx.insertInto('encounters').values({
        patient_id: dto.patient_id, attending_doctor_id: null, department_id: dept.id, type: 'outpatient', status: 'planned',
        visit_kind: 'lab', external_referral: dto.external_referral?.trim() || null,
      }).returning(['id', 'patient_id']).executeTakeFirstOrThrow();
      const inv = await trx.insertInto('invoices').values({
        encounter_id: enc.id, invoice_number: sql<string>`'INV-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('invoice_number_seq')::text, 6, '0')`,
        total_amount: '0', patient_share: '0',
      }).returning(['invoice_number']).executeTakeFirstOrThrow();
      const r = await this.insertItems(trx, enc, dto.items, dto.allergy_override_reason, user, ctx);
      if ('conflict' in r) return r;
      await this.audit.log(ctx, { action: 'OPEN_LAB_VISIT', entityName: 'encounters', entityId: enc.id,
        newData: { patient_id: dto.patient_id, invoice_number: inv.invoice_number, external_referral: dto.external_referral ?? null } }, trx);
      return { encounter_id: enc.id, created: r.created };
    });
    if ('conflict' in res) throw new ConflictException({ code: 'ALLERGY_CONFLICT', message: 'პაციენტს აქვს ალერგია კონტრასტზე — საჭიროა დასაბუთება', check: res.conflict });
    return res;
  }

  private async insertItems(trx: Trx, enc: { id: string; patient_id: string }, items: { service_id: string; priority?: 'routine' | 'urgent'; note?: string }[],
                            overrideReason: string | undefined, user: AuthUser, ctx: AuditContext) {
    const ids = [...new Set(items.map((i) => i.service_id))];
    const services = await trx.selectFrom('dx_services as s').innerJoin('service_tariffs as t', 't.id', 's.tariff_id')
      .select(['s.id', 's.section', 's.name', 's.contrast', 's.is_active', 's.modality', 's.tariff_id', 't.base_price']).where('s.id', 'in', ids).execute();
    if (services.length !== ids.length || services.some((s) => !s.is_active)) throw new BadRequestException('ზოგიერთი კვლევა ვერ მოიძებნა ან გათიშულია');
    const labIds = services.filter((s) => s.section === 'lab').map((s) => s.id);
    if (labIds.length) {
      const withAnalytes = await trx.selectFrom('lab_analytes').select('service_id').distinct().where('service_id', 'in', labIds).where('is_active', '=', true).execute();
      const empty = services.filter((s) => s.section === 'lab' && !withAnalytes.some((w) => w.service_id === s.id));
      if (empty.length) throw new BadRequestException(`ანალიზს კომპონენტები ჯერ არ აქვს: ${empty.map((e) => e.name).join(', ')}`);
    }
    // იოდშემცველი კონტრასტი → ალერგიის შემოწმება (იგივე პოლიტიკა, რაც დანიშნულებაზე)
    if (services.some((s) => s.contrast === 'iodinated')) {
      const chk = await this.allergy.check(enc.patient_id, 'იოდშემცველი კონტრასტი', trx);
      if (chk.requires_ack && !overrideReason?.trim()) return { conflict: chk } as const;
    }
    const inv = await trx.selectFrom('invoices').select('id').where('encounter_id', '=', enc.id).forUpdate().executeTakeFirstOrThrow();
    const created = [];
    for (const it of items) {
      const s = services.find((x) => x.id === it.service_id)!;
      const accession = s.section === 'radiology' ? (await sql<{ n: string }>`SELECT nextval('accession_seq') AS n`.execute(trx)).rows[0].n : null;
      const row = await trx.insertInto('dx_order_items').values({
        encounter_id: enc.id, patient_id: enc.patient_id, service_id: s.id, section: s.section, priority: it.priority ?? 'routine',
        clinical_note: it.note?.trim() || null, ordered_by: user.id, accession_number: accession ? `A${accession}` : null,
        allergy_override_reason: s.contrast === 'iodinated' ? overrideReason?.trim() || null : null,
      }).returning(['id', 'section', 'status', 'accession_number']).executeTakeFirstOrThrow();
      await trx.insertInto('invoice_line_items').values({
        invoice_id: inv.id, tariff_id: s.tariff_id, dx_order_item_id: row.id, description: s.name, quantity: 1, unit_price: s.base_price, original_price: s.base_price,
      }).execute();
      created.push({ ...row, name: s.name });
    }
    await this.audit.log(ctx, { action: 'ORDER_DIAGNOSTICS', entityName: 'encounters', entityId: enc.id,
      newData: { items: created.map((c) => c.name), allergy_override: overrideReason ?? null } }, trx);
    return { created } as const;
  }

  /** ლაბორატორიული ვიზიტი იხურება, როცა ყველა კვლევა დასრულდა ან გაუქმდა */
  private async maybeCompleteLabVisit(trx: Trx, encounterId: string) {
    const e = await trx.selectFrom('encounters').select(['visit_kind', 'status']).where('id', '=', encounterId).executeTakeFirst();
    if (!e || e.visit_kind !== 'lab' || e.status !== 'active') return;
    const open = await trx.selectFrom('dx_order_items').select('id').where('encounter_id', '=', encounterId)
      .where('status', 'not in', ['validated', 'cancelled']).executeTakeFirst();
    if (!open) await trx.updateTable('encounters').set({ status: 'discharged', end_time: sql`now()` }).where('id', '=', encounterId).execute();
  }

  /** ვიზიტის ყველა დიაგნოსტიკური შეკვეთა შედეგებით (ექიმის ეკრანი) */
  encounterItems(encounterId: string) {
    return this.itemsQuery().where('i.encounter_id', '=', encounterId).orderBy('i.ordered_at').execute();
  }

  async cancel(itemId: string, reason: string, user: AuthUser, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const it = await trx.selectFrom('dx_order_items').selectAll().where('id', '=', itemId).forUpdate().executeTakeFirst();
      if (!it) throw new NotFoundException('შეკვეთა ვერ მოიძებნა');
      if (it.status !== 'ordered') throw new ConflictException('გაუქმება შესაძლებელია მხოლოდ შესრულების დაწყებამდე');
      const e = await trx.selectFrom('encounters').select(['attending_doctor_id', 'status']).where('id', '=', it.encounter_id).executeTakeFirstOrThrow();
      if (!(user.role === 'admin' || (user.role === 'doctor' && e.attending_doctor_id === user.id))) throw new ForbiddenException('გაუქმება შეუძლია მკურნალ ექიმს');
      await trx.deleteFrom('invoice_line_items').where('dx_order_item_id', '=', itemId).execute();
      await trx.updateTable('dx_order_items').set({ status: 'cancelled', cancel_reason: reason }).where('id', '=', itemId).execute();
      await this.audit.log(ctx, { action: 'CANCEL_DX_ORDER', entityName: 'dx_order_items', entityId: itemId, newData: { reason } }, trx);
      await this.maybeCompleteLabVisit(trx, it.encounter_id);
      return { id: itemId, status: 'cancelled' };
    });
  }

  // =============================================================== ნიმუშის აღება (ფლებოტომისტი / ექთანი)
  /** რიგი: პაციენტები, ვისაც ლაბ. ანალიზი აქვს დანიშნული და ნიმუში არ აუღია (+ გადახდის სტატუსი) */
  pendingCollection(q: { search?: string } = {}) {
    let query = this.db.selectFrom('dx_order_items as i')
      .innerJoin('dx_services as s', 's.id', 'i.service_id')
      .innerJoin('patients as p', 'p.id', 'i.patient_id')
      .innerJoin('encounters as e', 'e.id', 'i.encounter_id')
      .leftJoin('invoices as inv', 'inv.encounter_id', 'e.id')
      .select(['i.encounter_id', 'i.patient_id', 'p.first_name', 'p.last_name', 'p.personal_number', 'p.birth_date', 'e.visit_kind', 'e.status as encounter_status',
        'inv.paid_status', sql<number>`count(*)::int`.as('tests'), sql<string[]>`array_agg(s.name ORDER BY s.sort_order)`.as('names'),
        sql<boolean>`bool_or(i.priority = 'urgent')`.as('urgent'), sql<Date>`min(i.ordered_at)`.as('ordered_at'),
        sql<string | null>`max(i.collection_issue)`.as('collection_issue')])
      .where('i.section', '=', 'lab').where('i.status', '=', 'ordered').where('e.status', 'in', ['planned', 'active', 'discharged'])
      .groupBy(['i.encounter_id', 'i.patient_id', 'p.first_name', 'p.last_name', 'p.personal_number', 'p.birth_date', 'e.visit_kind', 'e.status', 'inv.paid_status'])
      .orderBy(sql`bool_or(i.priority = 'urgent')`, 'desc').orderBy(sql`min(i.ordered_at)`);
    if (q.search?.trim()) {
      const t = q.search.trim();
      query = query.where((eb) => eb.or([eb('p.personal_number', '=', t), eb('p.last_name', 'ilike', `${t}%`), eb('p.first_name', 'ilike', `${t}%`)]));
    }
    return query.execute();
  }

  /** არჩეული პაციენტი: იდენტიფიკაცია + მხოლოდ დანიშნული ანალიზები + სინჯარები აღების რიგით */
  async collectionDetail(encounterId: string) {
    const e = await this.db.selectFrom('encounters as e').innerJoin('patients as p', 'p.id', 'e.patient_id').leftJoin('invoices as inv', 'inv.encounter_id', 'e.id')
      .leftJoin('users as d', 'd.id', 'e.attending_doctor_id')
      .select(['e.id as encounter_id', 'e.status as encounter_status', 'e.visit_kind', 'e.external_referral', 'p.first_name', 'p.last_name', 'p.birth_date', 'p.gender',
        'p.personal_number', 'p.passport_number', 'inv.paid_status', sql<string | null>`d.first_name || ' ' || d.last_name`.as('doctor_name')])
      .where('e.id', '=', encounterId).executeTakeFirst();
    if (!e) throw new NotFoundException('ვიზიტი ვერ მოიძებნა');
    const items = await this.db.selectFrom('dx_order_items as i').innerJoin('dx_services as s', 's.id', 'i.service_id')
      .select(['i.id', 'i.priority', 'i.clinical_note', 'i.collection_issue', 's.name', 's.code', 's.specimen_type', 's.container', 's.performed_by', 's.external_lab'])
      .where('i.encounter_id', '=', encounterId).where('i.section', '=', 'lab').where('i.status', '=', 'ordered').orderBy('s.sort_order').execute();
    return { ...e, items, tubes: tubesInOrder(items) };
  }

  /**
   * აღება: ანალიზები სინჯარებად (ნიმუში + კონტეინერი + შიდა/გარე) → თითო სინჯარას თითო შტრიხკოდი.
   * სავალდებულო: პაციენტის იდენტიფიკაციის დადასტურება; გადაუხდელზე — ცალკე დადასტურება.
   */
  async collect(encounterId: string, dto: { item_ids?: string[]; identity_confirmed?: boolean; unpaid_ack?: boolean }, user: AuthUser, ctx: AuditContext) {
    if (!dto.identity_confirmed) throw new BadRequestException('დაადასტურეთ პაციენტის იდენტიფიკაცია (სახელი და დაბადების თარიღი)');
    const specimens = await this.db.transaction().execute(async (trx) => {
      const inv = await trx.selectFrom('invoices').select('paid_status').where('encounter_id', '=', encounterId).executeTakeFirst();
      if (inv?.paid_status === 'unpaid' && !dto.unpaid_ack) throw new ConflictException({ code: 'UNPAID', message: 'ანალიზები გადახდილი არ არის' });
      let q = trx.selectFrom('dx_order_items as i').innerJoin('dx_services as s', 's.id', 'i.service_id')
        .select(['i.id', 'i.patient_id', 's.specimen_type', 's.container', 's.name', 's.performed_by'])
        .where('i.encounter_id', '=', encounterId).where('i.section', '=', 'lab').where('i.status', '=', 'ordered').forUpdate(['i']);
      if (dto.item_ids?.length) q = q.where('i.id', 'in', dto.item_ids);
      const items = await q.execute();
      if (!items.length) throw new ConflictException('ასაღები ლაბორატორიული შეკვეთა არ არის');
      const out = [];
      for (const g of tubesInOrder(items)) {
        const { rows: [{ n }] } = await sql<{ n: string }>`SELECT nextval('lab_barcode_seq') AS n`.execute(trx);
        const sp = await trx.insertInto('lab_specimens').values({
          barcode: String(n), encounter_id: encounterId, patient_id: items[0].patient_id, specimen_type: g.specimen_type, container: g.container, collected_by: user.id,
        }).returning(['id', 'barcode', 'specimen_type', 'container']).executeTakeFirstOrThrow();
        await trx.updateTable('dx_order_items').set({ status: 'collected', specimen_id: sp.id, collection_issue: null, collection_issue_at: null })
          .where('id', 'in', g.items.map((x) => x.id)).execute();
        out.push({ ...sp, tests: g.items.map((x) => x.name), external: g.external });
      }
      await this.audit.log(ctx, { action: 'COLLECT_SPECIMENS', entityName: 'encounters', entityId: encounterId,
        newData: { specimens: out.map((s) => s.barcode), identity_confirmed: true, unpaid_ack: inv?.paid_status === 'unpaid' ? true : undefined } }, trx);
      return out;
    });
    return specimens;
  }

  /** "ვერ აიღო" — შეკვეთა ღია რჩება, მიზეზი ჩანს რიგში */
  async collectionIssue(encounterId: string, reason: string, ctx: AuditContext) {
    const r = await this.db.updateTable('dx_order_items').set({ collection_issue: reason, collection_issue_at: sql`now()` })
      .where('encounter_id', '=', encounterId).where('section', '=', 'lab').where('status', '=', 'ordered').executeTakeFirst();
    if (!Number(r.numUpdatedRows)) throw new NotFoundException('ასაღები შეკვეთა არ არის');
    await this.audit.log(ctx, { action: 'COLLECTION_ISSUE', entityName: 'encounters', entityId: encounterId, newData: { reason } });
    return { encounter_id: encounterId, reason };
  }

  async labelsData(specimenIds: string[]) {
    return this.db.selectFrom('lab_specimens as sp').innerJoin('patients as p', 'p.id', 'sp.patient_id')
      .select(['sp.id', 'sp.barcode', 'sp.specimen_type', 'sp.container', 'sp.collected_at', 'p.first_name', 'p.last_name', 'p.birth_date', 'p.personal_number',
        (eb) => jsonArrayFrom(eb.selectFrom('dx_order_items as i').innerJoin('dx_services as s', 's.id', 'i.service_id').select(['s.code', 's.name']).whereRef('i.specimen_id', '=', 'sp.id')).as('tests')])
      .where('sp.id', 'in', specimenIds).execute();
  }

  // =============================================================== ლაბორატორია
  /** სინჯარის მიღება ლაბორატორიაში (შტრიხკოდის სკანირება) */
  async receive(barcode: string, user: AuthUser, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const sp = await trx.selectFrom('lab_specimens').selectAll().where('barcode', '=', barcode.trim()).forUpdate().executeTakeFirst();
      if (!sp) throw new NotFoundException(`შტრიხკოდი ${barcode} ვერ მოიძებნა`);
      if (sp.status === 'collected') {
        await trx.updateTable('lab_specimens').set({ status: 'received', received_by: user.id, received_at: sql`now()` }).where('id', '=', sp.id).execute();
        await trx.updateTable('dx_order_items').set({ status: 'in_progress' }).where('specimen_id', '=', sp.id).where('status', '=', 'collected').execute();
        await this.audit.log(ctx, { action: 'RECEIVE_SPECIMEN', entityName: 'lab_specimens', entityId: sp.id, newData: { barcode: sp.barcode } }, trx);
      }
      return { specimen_id: sp.id, barcode: sp.barcode, already_received: sp.status !== 'collected' };
    });
  }

  labWorklist(statuses: string[], search?: string) {
    let q = this.itemsQuery().where('i.section', '=', 'lab').where('i.status', 'in', statuses as never[])
      .orderBy(sql`i.priority = 'urgent'`, 'desc').orderBy('i.ordered_at').limit(500);
    if (search?.trim()) {
      const t = search.trim();
      q = q.where((eb) => eb.or([eb('sp.barcode', '=', t), eb('p.personal_number', '=', t), eb('p.last_name', 'ilike', `${t}%`)]));
    }
    return q.execute();
  }

  /** შედეგის ფორმა: კომპონენტები + პაციენტისთვის შესაბამისი ნორმები + უკვე შეყვანილი მნიშვნელობები */
  async labItem(itemId: string) {
    const it = await this.itemsQuery().where('i.id', '=', itemId).executeTakeFirst();
    if (!it) throw new NotFoundException('შეკვეთა ვერ მოიძებნა');
    const analytes = await this.analyteDefs(it.service_id);
    const at = it.collected_at ? new Date(it.collected_at) : new Date();
    const days = ageDays(it.birth_date, at);
    return {
      ...it,
      analytes: analytes.map((a) => {
        const r = pickRange(a.ranges, it.gender, days);
        return { id: a.id, code: a.code, name: a.name, unit: a.unit, result_type: a.result_type, decimals: a.decimals, options: a.options?.split('|') ?? null,
          critical_low: a.critical_low, critical_high: a.critical_high, range: r ? { low: r.low, high: r.high, normal_text: r.normal_text } : null };
      }),
    };
  }

  async saveResults(itemId: string, values: { analyte_id: string; value: string | number | null }[], user: AuthUser, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const it = await trx.selectFrom('dx_order_items as i').innerJoin('patients as p', 'p.id', 'i.patient_id').leftJoin('lab_specimens as sp', 'sp.id', 'i.specimen_id')
        .select(['i.id', 'i.status', 'i.service_id', 'i.section', 'p.gender', 'p.birth_date', 'sp.collected_at']).where('i.id', '=', itemId).forUpdate(['i']).executeTakeFirst();
      if (!it || it.section !== 'lab') throw new NotFoundException('ლაბორატორიული შეკვეთა ვერ მოიძებნა');
      if (!['in_progress', 'resulted', 'collected'].includes(it.status)) throw new ConflictException(`სტატუსზე "${it.status}" შედეგის შეტანა დაუშვებელია`);
      const defs = await this.analyteDefs(it.service_id, trx);
      const days = ageDays(it.birth_date, it.collected_at ?? new Date());
      const old = await trx.selectFrom('lab_results').selectAll().where('order_item_id', '=', itemId).execute();

      for (const v of values) {
        const a = defs.find((d) => d.id === v.analyte_id);
        if (!a) throw new BadRequestException('უცნობი კომპონენტი');
        const raw = v.value === null || v.value === undefined ? '' : String(v.value).trim().replace(',', '.');
        if (!raw) { await trx.deleteFrom('lab_results').where('order_item_id', '=', itemId).where('analyte_id', '=', a.id).execute(); continue; }
        let num: number | null = null; let text: string | null = null;
        if (a.result_type === 'numeric') {
          num = Number(raw); if (!Number.isFinite(num)) throw new BadRequestException(`${a.name}: რიცხვითი მნიშვნელობა სავალდებულოა`);
        } else {
          text = raw; if (a.result_type === 'select' && a.options && !a.options.split('|').includes(text)) throw new BadRequestException(`${a.name}: დაუშვებელი მნიშვნელობა`);
        }
        const r = pickRange(a.ranges, it.gender, days);
        const row = { value_num: num?.toString() ?? null, value_text: text, unit: a.unit, ref_low: r?.low ?? null, ref_high: r?.high ?? null, ref_text: r?.normal_text ?? null,
          flag: computeFlag(a, r, num, text), entered_by: user.id, entered_at: sql<Date>`now()` };
        await trx.insertInto('lab_results').values({ order_item_id: itemId, analyte_id: a.id, ...row })
          .onConflict((oc) => oc.columns(['order_item_id', 'analyte_id']).doUpdateSet(row)).execute();
      }
      // ყველა სავალდებულო (რიცხვითი/არჩევითი) კომპონენტი შევსებულია → resulted (ვალიდაციას ელოდება)
      const filled = await trx.selectFrom('lab_results').select('analyte_id').where('order_item_id', '=', itemId).execute();
      const required = defs.filter((d) => d.is_active && d.result_type !== 'text');
      const complete = required.every((d) => filled.some((f) => f.analyte_id === d.id));
      const status = complete ? 'resulted' : 'in_progress';
      await trx.updateTable('dx_order_items').set({ status, ...(complete ? { resulted_by: user.id, resulted_at: sql`now()` } : {}) }).where('id', '=', itemId).execute();
      await this.audit.log(ctx, { action: 'ENTER_LAB_RESULTS', entityName: 'dx_order_items', entityId: itemId,
        oldData: old.length ? old.map((o) => ({ a: o.analyte_id, v: o.value_num ?? o.value_text })) : undefined,
        newData: { status, values: values.map((v) => ({ a: v.analyte_id, v: v.value })) } }, trx);
      return { id: itemId, status };
    });
  }

  /** ვალიდაცია — ლაბორატორიის ექიმი / უფროსი. შედეგს მხოლოდ ამის შემდეგ ხედავს მკურნალი ექიმი */
  async validate(itemId: string, user: AuthUser, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const it = await trx.selectFrom('dx_order_items').select(['id', 'status', 'section', 'encounter_id']).where('id', '=', itemId).forUpdate().executeTakeFirst();
      if (!it || it.section !== 'lab') throw new NotFoundException('ლაბორატორიული შეკვეთა ვერ მოიძებნა');
      if (it.status !== 'resulted') throw new ConflictException('ვალიდაციისთვის ყველა კომპონენტი უნდა იყოს შევსებული');
      await trx.updateTable('dx_order_items').set({ status: 'validated', validated_by: user.id, validated_at: sql`now()` }).where('id', '=', itemId).execute();
      await this.audit.log(ctx, { action: 'VALIDATE_LAB', entityName: 'dx_order_items', entityId: itemId }, trx);
      await this.maybeCompleteLabVisit(trx, it.encounter_id);
      return { id: itemId, status: 'validated' };
    });
  }

  /** ვალიდირებული შედეგის შესწორება — მხოლოდ დასაბუთებით; ბრუნდება "resulted"-ში და თავიდან საჭიროებს ვალიდაციას */
  async reopen(itemId: string, reason: string, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const it = await trx.selectFrom('dx_order_items').select(['id', 'status', 'section']).where('id', '=', itemId).forUpdate().executeTakeFirst();
      if (!it || it.section !== 'lab' || it.status !== 'validated') throw new ConflictException('შესწორება შეიძლება მხოლოდ ვალიდირებული შედეგის');
      await trx.updateTable('dx_order_items').set({ status: 'resulted', validated_by: null, validated_at: null }).where('id', '=', itemId).execute();
      await this.audit.log(ctx, { action: 'REOPEN_LAB_RESULT', entityName: 'dx_order_items', entityId: itemId, newData: { reason } }, trx);
      return { id: itemId, status: 'resulted' };
    });
  }

  // =============================================================== რადიოლოგია / ენდოსკოპია (დასკვნა)
  reportWorklist(section: 'radiology' | 'endoscopy', statuses: string[]) {
    return this.itemsQuery().where('i.section', '=', section).where('i.status', 'in', statuses as never[])
      .orderBy(sql`i.priority = 'urgent'`, 'desc').orderBy('i.ordered_at').limit(500).execute();
  }

  async saveReport(itemId: string, text: string, finalize: boolean, user: AuthUser, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const it = await trx.selectFrom('dx_order_items').select(['id', 'status', 'section', 'encounter_id']).where('id', '=', itemId).forUpdate().executeTakeFirst();
      if (!it || it.section === 'lab') throw new NotFoundException('შეკვეთა ვერ მოიძებნა');
      if (['validated', 'cancelled'].includes(it.status)) throw new ConflictException('დასკვნა უკვე დასრულებულია');
      if (finalize && !text.trim()) throw new BadRequestException('დასკვნა ცარიელია');
      await trx.updateTable('dx_order_items').set({
        report_text: text, status: finalize ? 'validated' : 'in_progress', resulted_by: user.id, resulted_at: sql`now()`,
        ...(finalize ? { validated_by: user.id, validated_at: sql`now()` } : {}),
      }).where('id', '=', itemId).execute();
      await this.audit.log(ctx, { action: finalize ? 'FINALIZE_REPORT' : 'SAVE_REPORT_DRAFT', entityName: 'dx_order_items', entityId: itemId }, trx);
      if (finalize) await this.maybeCompleteLabVisit(trx, it.encounter_id);
      return { id: itemId, status: finalize ? 'validated' : 'in_progress' };
    });
  }

  // =============================================================== helpers
  private itemsQuery() {
    return this.db.selectFrom('dx_order_items as i')
      .innerJoin('dx_services as s', 's.id', 'i.service_id')
      .innerJoin('patients as p', 'p.id', 'i.patient_id')
      .leftJoin('lab_specimens as sp', 'sp.id', 'i.specimen_id')
      .leftJoin('users as ob', 'ob.id', 'i.ordered_by')
      .leftJoin('users as vb', 'vb.id', 'i.validated_by')
      .select(['i.id', 'i.encounter_id', 'i.patient_id', 'i.service_id', 'i.section', 'i.status', 'i.priority', 'i.clinical_note', 'i.accession_number',
        'i.report_text', 'i.allergy_override_reason', 'i.ordered_at', 'i.resulted_at', 'i.validated_at', 'i.cancel_reason',
        's.code as service_code', 's.name as service_name', 's.group_name', 's.performed_by', 's.external_lab', 's.modality', 's.contrast',
        'sp.barcode', 'sp.status as specimen_status', 'sp.collected_at', 'sp.received_at',
        'p.first_name', 'p.last_name', 'p.personal_number', 'p.birth_date', 'p.gender',
        sql<string>`ob.first_name || ' ' || ob.last_name`.as('ordered_by_name'),
        sql<string | null>`vb.first_name || ' ' || vb.last_name`.as('validated_by_name'),
        (eb) => jsonArrayFrom(eb.selectFrom('lab_results as r').innerJoin('lab_analytes as a', 'a.id', 'r.analyte_id')
          .select(['r.analyte_id', 'a.code', 'a.name', 'r.value_num', 'r.value_text', 'r.unit', 'r.ref_low', 'r.ref_high', 'r.ref_text', 'r.flag'])
          .whereRef('r.order_item_id', '=', 'i.id').orderBy('a.sort_order')).as('results')]);
  }

  private async analyteDefs(serviceId: string, executor: Database | Trx = this.db) {
    return executor.selectFrom('lab_analytes as a').selectAll('a')
      .select((eb) => jsonArrayFrom(eb.selectFrom('lab_reference_ranges as r').select(['r.sex', 'r.age_min_days', 'r.age_max_days', 'r.low', 'r.high', 'r.normal_text'])
        .whereRef('r.analyte_id', '=', 'a.id')).as('ranges'))
      .where('a.service_id', '=', serviceId).where('a.is_active', '=', true).orderBy('a.sort_order').execute();
  }
}
