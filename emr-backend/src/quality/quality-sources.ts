import { BadRequestException, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { AuthUser } from '../auth/roles';
import { QmCommon, type Ex, type SourceType } from './quality-common';

export interface SourceInfo { type: SourceType; id: string; label: string; at: string | null; patient_id: string | null; encounter_id: string | null; department_id: string | null }

const d = (col: string) => sql<string>`to_char(${sql.ref(col)} AT TIME ZONE current_setting('TimeZone'), 'DD.MM.YYYY HH24:MI')`;

/**
 * ინციდენტის წყარო (0064): MAR, დანიშნულება, ოპერაცია, კვლევა / ანალიზი, ნიმუში, ჰოსპიტალიზაცია, ვიზიტი, ინვენტარი, დიაგნოსტიკის აპარატი.
 * სერვერი თვითონ ადგენს პაციენტს / ვიზიტს / განყოფილებას და წარწერას — კლიენტის მონაცემს არ ვენდობით.
 */
@Injectable()
export class QmSources {
  constructor(private readonly c: QmCommon) {}
  private get db() { return this.c.db; }

  /** ერთი წყარო; ვერ მოიძებნა → 400 */
  async resolve(type: SourceType, id: string, ex: Ex = this.db): Promise<SourceInfo> {
    const r = await this.query(type, ex).where(sql.ref(type === 'stay' ? 'src.encounter_id' : 'src.id'), '=', id).executeTakeFirst() as SourceInfo | undefined;
    if (!r) throw new BadRequestException({ code: 'SOURCE_NOT_FOUND', message: 'მიბმული მოვლენა ვერ მოიძებნა' });
    return { ...r, type };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private query(type: SourceType, ex: Ex): any {
    switch (type) {
      case 'encounter':
        return ex.selectFrom('encounters as src').leftJoin('departments as dp', 'dp.id', 'src.department_id')
          .select([sql<string>`'ვიზიტი ' || ${d('src.start_time')} || coalesce(' · ' || dp.name, '')`.as('label'), sql<string>`src.start_time::text`.as('at'),
            'src.patient_id', sql<string>`src.id`.as('encounter_id'), 'src.department_id', 'src.id']);
      case 'stay':
        return ex.selectFrom('inpatient_stays as src').innerJoin('encounters as e', 'e.id', 'src.encounter_id')
          .select([sql<string>`'ჰოსპიტალიზაცია ' || src.adm_no`.as('label'), sql<string>`src.admitted_at::text`.as('at'), 'src.patient_id', 'src.encounter_id', 'e.department_id', sql<string>`src.encounter_id`.as('id')]);
      case 'med_order':
        return ex.selectFrom('med_orders as src').innerJoin('encounters as e', 'e.id', 'src.encounter_id').leftJoin('med_generics as g', 'g.id', 'src.generic_id')
          .select([sql<string>`'დანიშნულება: ' || coalesce(g.inn, src.drug_text, src.text, '—') || coalesce(' · ' || src.dose || ' ' || coalesce(src.dose_unit, ''), '')`.as('label'),
            sql<string>`src.created_at::text`.as('at'), 'src.patient_id', 'src.encounter_id', 'e.department_id', 'src.id']);
      case 'mar_entry':
        return ex.selectFrom('mar_entries as src').innerJoin('med_orders as o', 'o.id', 'src.order_id').innerJoin('encounters as e', 'e.id', 'src.encounter_id')
          .leftJoin('med_generics as g', 'g.id', 'o.generic_id')
          .select([sql<string>`'MAR: ' || coalesce(g.inn, o.drug_text, o.text, '—') || ' · ' || ${d('src.scheduled_at')}`.as('label'),
            sql<string>`coalesce(src.documented_at, src.scheduled_at, src.created_at)::text`.as('at'), 'src.patient_id', 'src.encounter_id', 'e.department_id', 'src.id']);
      case 'or_case':
        return ex.selectFrom('or_cases as src')
          .select([sql<string>`'ოპერაცია ' || src.case_no`.as('label'), sql<string>`src.created_at::text`.as('at'), 'src.patient_id', 'src.encounter_id', 'src.department_id', 'src.id']);
      case 'dx_order_item':
        return ex.selectFrom('dx_order_items as src').innerJoin('dx_services as s', 's.id', 'src.service_id').innerJoin('encounters as e', 'e.id', 'src.encounter_id')
          .select([sql<string>`(CASE src.section WHEN 'lab' THEN 'ანალიზი' WHEN 'radiology' THEN 'რადიოლოგია' WHEN 'endoscopy' THEN 'ენდოსკოპია' ELSE 'კვლევა' END) || ': ' || s.name`.as('label'),
            sql<string>`src.ordered_at::text`.as('at'), 'src.patient_id', 'src.encounter_id', 'e.department_id', 'src.id']);
      case 'lab_specimen':
        return ex.selectFrom('lab_specimens as src').innerJoin('encounters as e', 'e.id', 'src.encounter_id')
          .select([sql<string>`'ნიმუში ' || src.barcode`.as('label'), sql<string>`src.collected_at::text`.as('at'), 'src.patient_id', 'src.encounter_id', 'e.department_id', 'src.id']);
      case 'asset':
        return ex.selectFrom('assets as src')
          .select([sql<string>`'ინვენტარი ' || src.inv_no || ' · ' || src.name`.as('label'), sql<string | null>`NULL`.as('at'), sql<string | null>`NULL::uuid`.as('patient_id'),
            sql<string | null>`NULL::uuid`.as('encounter_id'), 'src.department_id', 'src.id']);
      case 'hai_case':   // 0068: HAI შემთხვევა (ინფექციის კონტროლი → „ხარისხს გადაცემა“)
        return ex.selectFrom('ipc_hai_cases as src').innerJoin('ipc_hai_types as t', 't.code', 'src.hai_type')
          .select([sql<string>`'HAI ' || src.case_no || ' · ' || t.short_name`.as('label'), sql<string>`src.onset_date::text`.as('at'), 'src.patient_id', 'src.encounter_id', 'src.department_id', 'src.id']);
      case 'bme_device':   // 0075: ბიომედ-აპარატის პასპორტი (განყოფილება — აპარატის მდებარეობა)
        return ex.selectFrom('bme_devices as src')
          .select([sql<string>`'აპარატი ' || src.inv_no || ' · ' || src.name`.as('label'), sql<string | null>`NULL`.as('at'), sql<string | null>`NULL::uuid`.as('patient_id'),
            sql<string | null>`NULL::uuid`.as('encounter_id'), 'src.department_id', 'src.id']);
      case 'dx_device':
        return ex.selectFrom('dx_devices as src')
          .select([sql<string>`'აპარატი: ' || src.name`.as('label'), sql<string | null>`NULL`.as('at'), sql<string | null>`NULL::uuid`.as('patient_id'),
            sql<string | null>`NULL::uuid`.as('encounter_id'), sql<string | null>`NULL::uuid`.as('department_id'), 'src.id']);
    }
  }

  /** პაციენტის ბოლო მოვლენები (ფორმაში არჩევისთვის): ბოლო `days` დღე, თითო სახეზე ≤ 30 */
  async recent(patientId: string, days = 14) {
    const since = sql<Date>`now() - make_interval(days => ${days})`;
    const out: SourceInfo[] = [];
    const add = async (type: SourceType, col: string) => {
      const rows = await this.query(type, this.db).where(sql.ref('src.patient_id'), '=', patientId).where(sql.ref(col), '>=', since)
        .orderBy(sql.ref(col), 'desc').limit(30).execute() as SourceInfo[];
      out.push(...rows.map((r) => ({ ...r, type })));
    };
    await add('encounter', 'src.start_time');
    await add('stay', 'src.admitted_at');
    await add('or_case', 'src.created_at');
    await add('med_order', 'src.created_at');
    await add('mar_entry', 'src.scheduled_at');
    await add('dx_order_item', 'src.ordered_at');
    await add('lab_specimen', 'src.collected_at');
    return out;
  }

  /**
   * შეთავაზებები (event_prompts): ბოლო 48 საათის მოვლენები, სადაც ეს მომხმარებელი მონაწილეობდა და რომელიც შეიძლება ინციდენტი იყოს —
   *   MAR: გაფრთხილების / სკანირების გადალახვა (override_reason) ან „გამოტოვებული“ დოზა; საოპერაციო დათვლის შეუსაბამობა.
   *   უკვე მიბმული ან „არ არის ინციდენტი“-თი დახურული — აღარ ჩანს.
   */
  async prompts(u: AuthUser) {
    const r = await sql<{ type: SourceType; id: string; reason: string; label: string; at: string; patient_id: string | null; category_code: string }>`
      SELECT 'mar_entry' AS type, m.id, CASE WHEN m.status = 'missed' THEN 'missed' ELSE 'override' END AS reason,
             'MAR: ' || coalesce(g.inn, o.drug_text, o.text, '—') AS label, coalesce(m.documented_at, m.scheduled_at)::text AS at, m.patient_id,
             CASE WHEN m.status = 'missed' THEN 'med_omission' ELSE 'med_wrong_drug' END AS category_code
        FROM mar_entries m JOIN med_orders o ON o.id = m.order_id LEFT JOIN med_generics g ON g.id = o.generic_id
       WHERE m.documented_by = ${u.id} AND coalesce(m.documented_at, m.scheduled_at) >= now() - interval '48 hours'
         AND (m.override_reason IS NOT NULL OR m.status = 'missed') AND m.voided_at IS NULL
      UNION ALL
      SELECT 'or_case', c.id, 'count', 'ოპერაცია ' || c.case_no || ' — დათვლის შეუსაბამობა', max(k.done_at)::text, c.patient_id, 'surg_count'
        FROM or_counts k JOIN or_cases c ON c.id = k.case_id
       WHERE NOT k.correct AND (k.done_by = ${u.id} OR k.second_by = ${u.id}) AND k.done_at >= now() - interval '48 hours'
       GROUP BY c.id, c.case_no, c.patient_id
      ORDER BY at DESC LIMIT 20`.execute(this.db);
    if (!r.rows.length) return [];
    const ids = r.rows.map((x) => x.id);
    const linked = new Set((await this.db.selectFrom('qm_incidents').select('source_id').where('source_id', 'in', ids).execute()).map((x) => x.source_id));
    const dismissed = new Set((await this.db.selectFrom('qm_prompt_dismissals').select('source_id').where('user_id', '=', u.id).where('source_id', 'in', ids).execute()).map((x) => x.source_id));
    const cats = await this.db.selectFrom('qm_classifiers').select(['id', 'code']).where('kind', '=', 'category').where('is_active', '=', true).execute();
    const cat = new Map(cats.map((x) => [x.code, x.id]));
    return r.rows.filter((x) => !linked.has(x.id) && !dismissed.has(x.id)).map(({ category_code, ...x }) => ({ ...x, category_id: cat.get(category_code) ?? null }));
  }
}
