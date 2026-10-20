import { sql } from 'kysely';
import type { Database } from '../database/database.module';

/**
 * ხარისხის მაჩვენებლების საერთო წესები (0066) — იყენებს მენეჯერული დაფის KPI-ები (rpt) და ხარისხის ანგარიშები, რომ ციფრები ემთხვეოდეს.
 *  • ინციდენტის „ზიანი“ — საბოლოო (ტრიაჟის) კლასიფიკაცია; ანგარიშში მხოლოდ მიღებული (investigation … closed).
 *  • ინდიკატორი: მრიცხველი — qm_indicators-ის ფილტრით; მნიშვნელი — საწოლ-დღე (occupancy_basis-ის წესით) / ჰოსპიტალიზაცია / ვიზიტი.
 */
export const SERVICE_TYPES = ['inpatient', 'outpatient', 'emergency', 'or', 'diagnostic', 'lab', 'non_clinical'] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];
export const SERVICE_KA: Record<string, string> = {
  inpatient: 'სტაციონარი', outpatient: 'ამბულატორია', emergency: 'გადაუდებელი', or: 'საოპერაციო', diagnostic: 'დიაგნოსტიკა', lab: 'ლაბორატორია', non_clinical: 'არაკლინიკური',
};
export const ACCEPTED = ['investigation', 'analysis', 'capa', 'closed'] as const;
export const HARM_ORDER = ['none', 'mild', 'moderate', 'severe', 'death'];
export const DENOM_KA: Record<string, string> = { bed_days: 'საწოლ-დღე', admissions: 'ჰოსპიტალიზაცია', visits: 'ვიზიტი' };

export interface Indicator {
  id: string; code: string; name: string; description: string | null; category_ids: string[]; event_types: string[]; min_harm: string | null;
  patient_only: boolean; service_types: string[]; denominator: 'bed_days' | 'admissions' | 'visits'; per: number; is_active: boolean; sort_order: number;
}
export interface FactRow { category_id: string; event_type: string; harm: string; service_type: string; affected: string; is_sentinel: boolean; n: number }
export interface Denoms { bed_days: number; admissions: number; visits: number }

export async function loadIndicators(db: Database, activeOnly = true): Promise<Indicator[]> {
  let q = db.selectFrom('qm_indicators').select(['id', 'code', 'name', 'description', 'category_ids', 'event_types', 'min_harm', 'patient_only', 'service_types', 'denominator', 'per',
    'is_active', 'sort_order']).orderBy('sort_order').orderBy('code');
  if (activeOnly) q = q.where('is_active', '=', true);
  return (await q.execute()) as Indicator[];
}

/** კატეგორია → თავისი + ქვეკატეგორიები (2 დონე) */
export async function categoryExpander(db: Database) {
  const rows = await db.selectFrom('qm_classifiers').select(['id', 'parent_id']).where('kind', '=', 'category').execute();
  const kids = new Map<string, string[]>();
  for (const r of rows) if (r.parent_id) kids.set(r.parent_id, [...(kids.get(r.parent_id) ?? []), r.id]);
  return (ids: string[]) => new Set(ids.flatMap((id) => [id, ...(kids.get(id) ?? [])]));
}

export function indicatorMatch(ind: Indicator, cats: Set<string>, r: Omit<FactRow, 'n' | 'is_sentinel'>) {
  if (!cats.has(r.category_id)) return false;
  if (!ind.event_types.includes(r.event_type)) return false;
  if (ind.min_harm && HARM_ORDER.indexOf(r.harm) < HARM_ORDER.indexOf(ind.min_harm)) return false;
  if (ind.patient_only && r.affected !== 'patient') return false;
  if (ind.service_types.length && !ind.service_types.includes(r.service_type)) return false;
  return true;
}

/** საწოლ-დღე: occupancy_basis = hours → დაკავებული საწოლ-საათი / 24; midnight → შუაღამის დაკავებათა ჯამი */
export const bedDays = (basis: string, occupiedHours: number, midnightCensus: number) => (basis === 'midnight' ? midnightCensus : occupiedHours / 24);

export function rate(num: number, den: number, per: number): number | null {
  return den > 0 ? Math.round((num / den) * per * 100) / 100 : null;
}

/** მნიშვნელები rpt_fact_beds / rpt_fact_flow-იდან (იგივე, რაც KPI-ში) */
export async function denominators(rdb: Database, depts: string[] | null, from: string, to: string, basis: string): Promise<Denoms> {
  const f = (a: string) => (depts ? sql`${sql.ref(`${a}.department_id`)} = ANY(${depts}::uuid[])` : sql`TRUE`);
  const [b, e] = await Promise.all([
    sql<{ oh: string; mc: string; adm: string }>`
      SELECT coalesce(sum(occupied_hours), 0)::text AS oh, coalesce(sum(midnight_census), 0)::text AS mc, coalesce(sum(admissions), 0)::text AS adm
        FROM rpt_fact_beds f WHERE f.day BETWEEN ${from}::date AND ${to}::date AND ${f('f')}`.execute(rdb),
    sql<{ v: string }>`SELECT coalesce(sum(encounters), 0)::text AS v FROM rpt_fact_flow f WHERE f.day BETWEEN ${from}::date AND ${to}::date AND ${f('f')}`.execute(rdb),
  ]);
  return { bed_days: bedDays(basis, Number(b.rows[0].oh), Number(b.rows[0].mc)), admissions: Number(b.rows[0].adm), visits: Number(e.rows[0].v) };
}

/** „ყურადღება“ (ცოცხალი, მთავარ ბაზაზე): ვადაგადაცილებული ტრიაჟი / ანალიზი / CAPA, სენტინელური ამ თვეში */
export async function qmAttentionCounts(db: Database, depts: string[] | null, tz: string) {
  const f = (col: string) => (depts ? sql`${sql.ref(col)} = ANY(${depts}::uuid[])` : sql`TRUE`);
  const [i, c] = await Promise.all([
    sql<{ triage: number; analysis: number; sentinel: number }>`
      SELECT count(*) FILTER (WHERE i.status = 'submitted' AND i.triage_due_at < now())::int AS triage,
             count(*) FILTER (WHERE i.status IN ('investigation', 'analysis') AND i.analysis_due_at < now())::int AS analysis,
             count(*) FILTER (WHERE i.is_sentinel AND i.status <> 'rejected'
                               AND i.reported_at >= (date_trunc('month', now() AT TIME ZONE ${tz}))::timestamp AT TIME ZONE ${tz})::int AS sentinel
        FROM qm_incidents i WHERE ${f('i.department_id')}`.execute(db),
    sql<{ n: number }>`
      SELECT count(*)::int AS n FROM qm_capas c
       WHERE c.status IN ('open', 'in_progress') AND c.due_date < (now() AT TIME ZONE ${tz})::date
         AND ${depts ? sql`coalesce(c.department_id, (SELECT i.department_id FROM qm_capa_incidents ci JOIN qm_incidents i ON i.id = ci.incident_id
                                                       WHERE ci.capa_id = c.id ORDER BY ci.linked_at LIMIT 1)) = ANY(${depts}::uuid[])` : sql`TRUE`}`.execute(db),
  ]);
  return { triage_overdue: i.rows[0].triage, analysis_overdue: i.rows[0].analysis, sentinel_month: i.rows[0].sentinel, capa_overdue: c.rows[0].n };
}
