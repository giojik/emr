import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../database/db';

type Ex = Kysely<DB> | Transaction<DB>;

export interface MarScheduleSettings { mar_window_min: number; mar_horizon_hours: number }

/**
 * MAR-ის სლოტების გენერაცია (0043) — იდემპოტენტური (API იძახებს გვერდის გახსნისას, worker — პერიოდულად).
 *   გეგმიური მედიკამენტი და მოვლის დავალება სიხშირით:
 *     საათები (times_of_day) — ყოველ კალენდარულ დღეს კლინიკის დროით; ინტერვალი — start_at + k × interval_hours;
 *     დიაპაზონი: max(start_at, created_at − ფანჯარა) … min(end_at, now + horizon) — ახალ დანიშნულებას „გამოტოვებული“ წარსული არ უჩნდება.
 *   ერთჯერადი — ერთი სლოტი start_at-ზე.
 *   არააქტიური დანიშნულების (შეჩერებული / შეწყვეტილი / დასრულებული) ღია სლოტები → cancelled;
 *     განახლებისას (active) მომავალი cancelled სლოტები ისევ due ხდება.
 * scope: encounter_id ან department_id (მიმდინარე ეპიზოდით) — ან ყველა.
 */
export async function ensureMarSlots(db: Ex, tz: string, s: MarScheduleSettings, scope: { encounterId?: string; departmentId?: string } = {}) {
  const win = s.mar_window_min; const hz = s.mar_horizon_hours;
  const filter = scope.encounterId ? sql`AND o.encounter_id = ${scope.encounterId}`
    : scope.departmentId ? sql`AND EXISTS (SELECT 1 FROM bed_assignments a WHERE a.encounter_id = o.encounter_id AND a.ended_at IS NULL AND a.department_id = ${scope.departmentId})`
    : sql``;
  // 1) არააქტიური დანიშნულების ღია სლოტები → cancelled
  await sql`UPDATE mar_entries m SET status = 'cancelled' FROM med_orders o
    WHERE o.id = m.order_id AND m.status = 'due' AND m.voided_at IS NULL AND o.status <> 'active' ${filter}`.execute(db);
  // 2) გეგმიური / მოვლის დავალება — სიხშირით
  await sql`
    INSERT INTO mar_entries (order_id, encounter_id, patient_id, scheduled_at, source, status)
    SELECT o.id, o.encounter_id, o.patient_id, x.at, 'schedule', 'due'
    FROM med_orders o
    JOIN med_frequencies f ON f.code = o.frequency_code
    JOIN inpatient_stays st ON st.encounter_id = o.encounter_id AND st.status = 'active'
    CROSS JOIN LATERAL (
      SELECT ((d::date + t) AT TIME ZONE ${tz}) AS at
      FROM generate_series((now() AT TIME ZONE ${tz})::date - 1, (now() AT TIME ZONE ${tz})::date + ${Math.ceil(hz / 24) + 1}::int, interval '1 day') d,
           unnest(f.times_of_day) t
      WHERE f.times_of_day IS NOT NULL
      UNION ALL
      SELECT o.start_at + make_interval(hours => f.interval_hours * k)
      FROM generate_series(
        greatest(0, floor(extract(epoch FROM (greatest(o.start_at, o.created_at - make_interval(mins => ${win})) - o.start_at)) / 3600.0 / f.interval_hours))::int,
        ceil(extract(epoch FROM (now() + make_interval(hours => ${hz}) - o.start_at)) / 3600.0 / f.interval_hours)::int) k
      WHERE f.interval_hours IS NOT NULL
    ) x
    WHERE o.status = 'active'
      AND ((o.category = 'medication' AND o.order_type = 'scheduled') OR o.category = 'nursing')
      AND x.at >= greatest(o.start_at, o.created_at - make_interval(mins => ${win}))
      AND x.at <= now() + make_interval(hours => ${hz})
      AND (o.end_at IS NULL OR x.at < o.end_at)
      ${filter}
    ON CONFLICT (order_id, scheduled_at) WHERE voided_at IS NULL AND scheduled_at IS NOT NULL
    DO UPDATE SET status = 'due' WHERE mar_entries.status = 'cancelled' AND mar_entries.scheduled_at >= now() - make_interval(mins => ${win})`.execute(db);
  // 3) ერთჯერადი — start_at
  await sql`
    INSERT INTO mar_entries (order_id, encounter_id, patient_id, scheduled_at, source, status)
    SELECT o.id, o.encounter_id, o.patient_id, o.start_at, 'schedule', 'due'
    FROM med_orders o JOIN inpatient_stays st ON st.encounter_id = o.encounter_id AND st.status = 'active'
    WHERE o.status = 'active' AND o.category = 'medication' AND o.order_type = 'once' ${filter}
    ON CONFLICT (order_id, scheduled_at) WHERE voided_at IS NULL AND scheduled_at IS NOT NULL
    DO UPDATE SET status = 'due' WHERE mar_entries.status = 'cancelled'`.execute(db);
}
