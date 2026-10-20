import { sql, type Transaction } from 'kysely';
import type { Database } from '../database/database.module';
import type { DB } from '../database/db';
import { TZ } from './reporting-common';
import { TAT_EDGES } from './reporting-refresh';

/**
 * ხარისხის ფაქტები (0066) — იმავე გადათვლაში, იმავე lock-ით.
 *  • rpt_fact_quality — ყოველთვის მთლიანად (მთელი ისტორია): კლასიფიკაციის შესწორება / ხელახლა გახსნა ძველ ინციდენტზეც აისახება.
 *    მხოლოდ მიღებული ინციდენტები; დღე — report_date_basis (occurred / reported). ტრიაჟის ჰისტოგრამა — წუთებში (TAT_EDGES).
 *  • rpt_quality_snapshot — ღია / ვადაგადაცილებული CAPA, ვადაგადაცილებული ტრიაჟი / ანალიზი (მომენტალური).
 *  • მოდული გამორთულია → არაფერი იცვლება.
 */
type Trx = Transaction<DB>;

export async function qualityFacts(rdb: Database, trx: Trx): Promise<Record<string, number>> {
  const m = await rdb.selectFrom('system_modules').select(['enabled', 'settings']).where('code', '=', 'quality').executeTakeFirst();
  if (!m?.enabled) return {};
  const basis = (m.settings as { report_date_basis?: string } | null)?.report_date_basis === 'reported' ? sql`i.reported_at` : sql`i.occurred_at`;
  // ჰისტოგრამის გასაღები (იგივე, რაც JS-ში ქვემოთ; boolean — 'true' / 'false', რადგან concat_ws ბულს 't' / 'f'-ად წერს)
  const keys = sql`to_char((${basis} AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD'), i.department_id, i.category_id, i.event_type, i.harm, i.service_type, i.affected,
    CASE WHEN i.is_sentinel THEN 'true' ELSE 'false' END`;
  const rows = (await sql<{ day: string; department_id: string; category_id: string; event_type: string; harm: string; service_type: string; affected: string; is_sentinel: boolean;
    n: number; anonymous: number; triaged: number; triage_on_time: number }>`
    SELECT to_char((${basis} AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS day, i.department_id, i.category_id, i.event_type, i.harm, i.service_type, i.affected, i.is_sentinel,
           count(*)::int AS n, count(*) FILTER (WHERE i.identity_mode = 'anonymous')::int AS anonymous,
           count(*) FILTER (WHERE i.triaged_at IS NOT NULL)::int AS triaged,
           count(*) FILTER (WHERE i.triaged_at IS NOT NULL AND i.triaged_at <= i.triage_due_at)::int AS triage_on_time
      FROM qm_incidents i
     WHERE i.status IN ('investigation', 'analysis', 'capa', 'closed') AND i.harm IS NOT NULL
     GROUP BY 1, 2, 3, 4, 5, 6, 7, 8`.execute(rdb)).rows;
  const hist = (await sql<{ k: string; bucket: number; c: number }>`
    SELECT concat_ws('|', ${keys}) AS k,
           width_bucket(greatest(0, extract(epoch FROM i.triaged_at - i.reported_at) / 60), ${sql.lit(`{${TAT_EDGES.join(',')}}`)}::numeric[])::int AS bucket, count(*)::int AS c
      FROM qm_incidents i
     WHERE i.status IN ('investigation', 'analysis', 'capa', 'closed') AND i.harm IS NOT NULL AND i.triaged_at IS NOT NULL
     GROUP BY 1, 2`.execute(rdb)).rows;
  const hk = new Map<string, number[]>();
  for (const h of hist) {
    const a = hk.get(h.k) ?? Array(12).fill(0);
    a[Math.min(11, Math.max(0, h.bucket))] += h.c; hk.set(h.k, a);
  }
  await sql`DELETE FROM rpt_fact_quality`.execute(trx);
  const out = rows.map((r) => {
    const k = [r.day, r.department_id, r.category_id, r.event_type, r.harm, r.service_type, r.affected, r.is_sentinel ? 'true' : 'false'].join('|');
    return { ...r, triage_hist: sql`${sql.lit(`{${(hk.get(k) ?? Array(12).fill(0)).join(',')}}`)}::int[]` };
  });
  for (let i = 0; i < out.length; i += 1000) await trx.insertInto('rpt_fact_quality').values(out.slice(i, i + 1000) as never).execute();

  // მომენტალური: CAPA (განყოფილება — CAPA-ს ან პირველი მიბმული ინციდენტის), ტრიაჟი / ანალიზი
  const snap = (await sql<{ department_id: string | null; open_capa: number; overdue_capa: number; triage_overdue: number; analysis_overdue: number }>`
    WITH c AS (SELECT coalesce(c.department_id, (SELECT i.department_id FROM qm_capa_incidents ci JOIN qm_incidents i ON i.id = ci.incident_id
                                                  WHERE ci.capa_id = c.id ORDER BY ci.linked_at LIMIT 1)) AS department_id,
                      count(*)::int AS open_capa, count(*) FILTER (WHERE c.due_date < (now() AT TIME ZONE ${TZ})::date)::int AS overdue_capa
                 FROM qm_capas c WHERE c.status IN ('open', 'in_progress') GROUP BY 1),
         i AS (SELECT i.department_id,
                      count(*) FILTER (WHERE i.status = 'submitted' AND i.triage_due_at < now())::int AS triage_overdue,
                      count(*) FILTER (WHERE i.status IN ('investigation', 'analysis') AND i.analysis_due_at < now())::int AS analysis_overdue
                 FROM qm_incidents i WHERE i.status IN ('submitted', 'investigation', 'analysis') GROUP BY 1)
    SELECT coalesce(c.department_id, i.department_id) AS department_id, coalesce(c.open_capa, 0) AS open_capa, coalesce(c.overdue_capa, 0) AS overdue_capa,
           coalesce(i.triage_overdue, 0) AS triage_overdue, coalesce(i.analysis_overdue, 0) AS analysis_overdue
      FROM c FULL JOIN i ON i.department_id = c.department_id`.execute(rdb)).rows
    .filter((r) => r.open_capa || r.overdue_capa || r.triage_overdue || r.analysis_overdue);
  await sql`DELETE FROM rpt_quality_snapshot`.execute(trx);
  if (snap.length) await trx.insertInto('rpt_quality_snapshot').values(snap).execute();
  return { quality: out.length, quality_snapshot: snap.length };
}
