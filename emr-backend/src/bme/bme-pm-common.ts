import { sql } from 'kysely';
import { loadEnv } from '../config/env';
import type { BmeSettings, Ex } from './bme-common';

/**
 * ბიომედ-აპარატურა, ეტაპი 2 (0074) — გეგმების საერთო ლოგიკა (API + worker + რეესტრი):
 *  ინტერვალი: აპარატზე გადაფარვა → ტიპის სვეტი (სახის type_field) → სახის ნაგულისხმევი (ჯგუფებზე);
 *  შემდეგი ვადა: ბოლო შესრულებიდან / კალენდრით (პარამეტრი); სერტიფიკატის ვადა → შემდეგი ვადა (პარამეტრი).
 */
export const TZ = loadEnv().CLINIC_TZ;
export const today = () => sql<string>`(now() AT TIME ZONE ${TZ})::date`;

export const RESULTS = ['pass', 'conditional', 'fail'] as const;
export type PmResult = (typeof RESULTS)[number];
export const RESULT_KA: Record<PmResult, string> = { pass: 'გავლილი', conditional: 'პირობითად გავლილი', fail: 'ვერ გაიარა' };
export const RESULT_RANK: Record<PmResult, number> = { pass: 0, conditional: 1, fail: 2 };
/** შედეგი → სტატუსის შეთავაზება (ავტომატურად არ იცვლება) */
export const SUGGEST: Record<PmResult, 'restricted' | 'down' | null> = { pass: null, conditional: 'restricted', fail: 'down' };
/** ვადაგადაცილებით ავტომატური „შეზღუდულად მუშა“ — ამ პრეფიქსით ვცნობთ სისტემის მიერ შეცვლილს (აღდგენისთვის) */
export const AUTO_REASON = 'ვადაგადაცილებული გეგმიური სამუშაო';
export const METER_UNITS = ['hours', 'cycles', 'exposures', 'scans', 'other'] as const;

/** სახე ვრცელდება ტიპზე? (ცხრილის ალიასები: k — bme_work_kinds, t — bme_device_types) */
export const kindApplies = sql<boolean>`((k.type_field = 'pm_months' AND t.pm_months IS NOT NULL)
  OR (k.type_field = 'calibration_months' AND t.calibration_months IS NOT NULL)
  OR (k.type_field = 'safety_months' AND t.safety_months IS NOT NULL)
  OR (k.type_field IS NULL AND t.grp = ANY (k.groups)))`;
/** ტიპის / სახის ინტერვალი (გადაფარვის გარეშე) */
export const baseInterval = sql<number | null>`coalesce(CASE k.type_field WHEN 'pm_months' THEN t.pm_months WHEN 'calibration_months' THEN t.calibration_months
  WHEN 'safety_months' THEN t.safety_months END, k.default_months)`;
/** ეფექტური ინტერვალი (p — bme_plans) */
export const effInterval = sql<number | null>`coalesce(p.interval_months, ${baseInterval})`;

export async function pmSettings(ex: Ex): Promise<BmeSettings | null> {
  const m = await ex.selectFrom('system_modules').select(['enabled', 'settings']).where('code', '=', 'bme').executeTakeFirst();
  return m?.enabled ? (m.settings as unknown as BmeSettings) : null;
}

/**
 * აპარატს აკლია გეგმები ტიპის მიხედვით → იქმნება (არსებული არ იცვლება). პირველი ვადა: ექსპლ. შეყვანა + ინტერვალი, თუ ჯერ არ გასულა; სხვა შემთხვევაში — დასადგენი (NULL).
 * ბრუნდება შექმნილი გეგმების რაოდენობა.
 */
export async function ensurePlans(ex: Ex, deviceId: string | null, userId: string | null, source: 'auto' | 'backfill' = 'auto'): Promise<number> {
  const r = await sql<{ id: string }>`
    INSERT INTO bme_plans (device_id, kind_id, next_due, source, created_by)
    SELECT b.id, k.id,
           CASE WHEN b.install_date IS NOT NULL AND (b.install_date + make_interval(months => ${baseInterval}))::date >= ${today()}
                THEN (b.install_date + make_interval(months => ${baseInterval}))::date END,
           ${source}, ${userId}
      FROM bme_devices b JOIN bme_device_types t ON t.id = b.type_id
      JOIN bme_work_kinds k ON k.is_active AND ${kindApplies}
     WHERE b.status <> 'retired' ${deviceId ? sql`AND b.id = ${deviceId}` : sql``}
    ON CONFLICT (device_id, kind_id) DO NOTHING
    RETURNING id`.execute(ex);
  return r.rows.length;
}

/** თარიღს + თვეები (SQL — თვის ბოლოს სწორად) */
export async function addMonths(ex: Ex, d: string, months: number): Promise<string> {
  const r = await sql<{ d: string }>`SELECT to_char((${d}::date + make_interval(months => ${months}))::date, 'YYYY-MM-DD') AS d`.execute(ex);
  return r.rows[0].d;
}

/**
 * შემდეგი ვადა შესრულებისას:
 *  last_done — შესრულების დღე + ინტერვალი; calendar — წინა ვადა + k·ინტერვალი (პირველი, შესრულების დღის შემდეგ);
 *  სერტიფიკატის ვადა (თუ პარამეტრი ჩართულია და მითითებულია) — თავად ის.
 */
export async function nextDue(ex: Ex, s: BmeSettings, p: { interval: number | null; prevDue: string | null; performedOn: string; certValidUntil?: string | null }): Promise<string | null> {
  if (s.pm_cert_sets_due && p.certValidUntil) return p.certValidUntil;
  if (!p.interval) return null;
  if (s.pm_due_basis === 'calendar' && p.prevDue) {
    const r = await sql<{ d: string }>`SELECT to_char(min(x.d), 'YYYY-MM-DD') AS d FROM generate_series(1, 480) g(k),
      LATERAL (SELECT (${p.prevDue}::date + make_interval(months => g.k * ${p.interval}))::date AS d) x WHERE x.d > ${p.performedOn}::date`.execute(ex);
    if (r.rows[0]?.d) return r.rows[0].d;
  }
  return addMonths(ex, p.performedOn, p.interval);
}

/** ჩეკლისტის პუნქტის შედეგი: გაზომვა — ავტომატურად (ნორმა ± დასაშვები / ზღვრები); შემოწმება — შემსრულებლის არჩევანი */
export function measureOutcome(i: { nominal: string | null; tolerance: string | null; limit_low: string | null; limit_high: string | null }, v: number): 'pass' | 'fail' {
  if (i.tolerance !== null && i.nominal !== null) return Math.abs(v - Number(i.nominal)) <= Number(i.tolerance) + 1e-9 ? 'pass' : 'fail';
  if (i.limit_low !== null && v < Number(i.limit_low) - 1e-9) return 'fail';
  if (i.limit_high !== null && v > Number(i.limit_high) + 1e-9) return 'fail';
  return 'pass';
}
/** სამუშაოს ავტომატური შედეგი: კრიტიკული fail → ვერ გაიარა; არაკრიტიკული fail → პირობითად */
export function autoResult(items: { outcome: string | null; critical: boolean }[]): PmResult {
  if (items.some((i) => i.outcome === 'fail' && i.critical)) return 'fail';
  if (items.some((i) => i.outcome === 'fail')) return 'conditional';
  return 'pass';
}
/** ნორმის ტექსტი (UI / PDF) */
export function normText(i: { nominal: string | number | null; tolerance: string | number | null; limit_low: string | number | null; limit_high: string | number | null; unit?: string | null }) {
  const u = i.unit ? ` ${i.unit}` : '';
  const f = (x: string | number) => String(Number(x));
  if (i.tolerance !== null && i.nominal !== null) return `${f(i.nominal)} ± ${f(i.tolerance)}${u}`;
  if (i.limit_low !== null && i.limit_high !== null) return `${f(i.limit_low)} – ${f(i.limit_high)}${u}`;
  if (i.limit_low !== null) return `≥ ${f(i.limit_low)}${u}`;
  if (i.limit_high !== null) return `≤ ${f(i.limit_high)}${u}`;
  return '';
}
