import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { InjectDb, type Database } from '../database/database.module';
import { wlSettings } from './worklist-common';
import { WorklistKpiService } from './worklist-kpi';
import { WorklistSchedulesService } from './worklist-schedules';
import { WorklistTasksService, countCache } from './worklist-tasks';

interface Scope { at?: string; task_ids?: string[]; schedule_ids?: string[]; kpi?: boolean }

/**
 * worker (ყოველ 5 წთ), 0081:
 *  • ვადის შეხსენება (remind_at_due): ვადა დადგა, დავალება ღიაა → შემსრულებელს (ჯგუფურზე — ჯგუფს, თუ ჯერ არავინ აიღო), ერთხელ;
 *  • ესკალაცია (escalate_hours > 0): ვადიდან N საათი გავიდა → განყოფილების ხელმძღვანელებს (worklist_manage, არით) + შემქმნელს;
 *    ხელმძღვანელი არ არის → worklist_all. ერთხელ (ვადის / სამიზნის შეცვლისას — თავიდან).
 * 0084: განმეორებადი დავალებები (გრაფიკით) + KPI აღრიცხვა (kpi_interval_min).
 * scope (ხელით გაშვება, admin / e2e): at — „ახლა“-ს ჩანაცვლება, task_ids — მხოლოდ ეს დავალებები, schedule_ids — მხოლოდ ეს გრაფიკები, kpi — აღრიცხვა ახლავე.
 */
@Injectable()
export class WorklistJobsService {
  constructor(@InjectDb() private readonly db: Database, private readonly tasks: WorklistTasksService, private readonly schedules: WorklistSchedulesService,
    private readonly kpi: WorklistKpiService) {}

  async tick(scope: Scope = {}) {
    const out: { reminded: number; escalated: number; schedules?: { created: number; skipped: number; replaced: number }; kpi?: unknown } = { reminded: 0, escalated: 0 };
    const m = await wlSettings(this.db);
    if (!m.enabled) return out;
    const s = m.s;
    const now = scope.at ? new Date(scope.at) : new Date();
    // 0084: გრაფიკები — ჯერ (ახალ დავალებას შეხსენება / ესკალაცია იმავე გაშვებაში შეიძლება შეეხოს)
    if (!scope.task_ids?.length || scope.schedule_ids?.length) out.schedules = await this.schedules.tick(scope.at ? now : undefined, scope.schedule_ids);
    const ids = scope.task_ids?.length ? sql`AND t.id = ANY (${scope.task_ids}::uuid[])` : sql``;
    if (s.remind_at_due) {
      const due = await sql<{ id: string }>`SELECT t.id FROM wl_tasks t WHERE t.status IN ('open', 'in_progress') AND t.due_at IS NOT NULL AND t.due_at <= ${now}
        AND t.reminded_at IS NULL ${ids} ORDER BY t.due_at LIMIT 500`.execute(this.db);
      for (const r of due.rows) {
        const upd = await this.db.updateTable('wl_tasks').set({ reminded_at: now }).where('id', '=', r.id).where('reminded_at', 'is', null).executeTakeFirst();
        if (!Number(upd.numUpdatedRows)) continue;
        const t = await this.db.selectFrom('wl_tasks').selectAll().where('id', '=', r.id).executeTakeFirstOrThrow();
        await this.db.insertInto('wl_task_events').values({ task_id: r.id, kind: 'reminded', data: JSON.stringify({ at: now.toISOString() }) }).execute();
        const to = await this.tasks.recipients(this.db, t, now);
        if (to.length) await this.tasks.bell(to, r.id, 'ვადა დადგა', t.priority !== 'normal');
        out.reminded++;
      }
    }
    if (s.escalate_hours > 0) {
      const late = await sql<{ id: string; department_id: string | null; created_by: string }>`SELECT t.id, t.department_id, t.created_by FROM wl_tasks t
        WHERE t.status IN ('open', 'in_progress') AND t.due_at IS NOT NULL AND t.due_at + make_interval(hours => ${s.escalate_hours}) <= ${now}
          AND t.escalated_at IS NULL ${ids} ORDER BY t.due_at LIMIT 500`.execute(this.db);
      for (const r of late.rows) {
        const upd = await this.db.updateTable('wl_tasks').set({ escalated_at: now }).where('id', '=', r.id).where('escalated_at', 'is', null).executeTakeFirst();
        if (!Number(upd.numUpdatedRows)) continue;
        let heads = r.department_id ? (await sql<{ id: string }>`SELECT u.id FROM users u JOIN user_capabilities c ON c.user_id = u.id
          WHERE u.is_active AND c.capabilities && ARRAY['worklist_manage']::varchar[]
            AND (u.department_id = ${r.department_id}::uuid OR EXISTS (SELECT 1 FROM rpt_user_scopes x WHERE x.user_id = u.id AND x.department_id = ${r.department_id}::uuid))`.execute(this.db)).rows.map((x) => x.id) : [];
        if (!heads.length) heads = (await sql<{ id: string }>`SELECT u.id FROM users u JOIN user_capabilities c ON c.user_id = u.id
          WHERE u.is_active AND c.capabilities && ARRAY['worklist_all']::varchar[]`.execute(this.db)).rows.map((x) => x.id);
        await this.db.insertInto('wl_task_events').values({ task_id: r.id, kind: 'escalated', data: JSON.stringify({ hours: s.escalate_hours, to: heads.length }) }).execute();
        await this.tasks.bell([...heads, r.created_by], r.id, `ესკალაცია: ვადა ${s.escalate_hours} სთ-ზე მეტით გადაცილებულია`, true);
        out.escalated++;
      }
    }
    if (out.reminded || out.escalated) countCache.clear();
    // 0084: KPI აღრიცხვა (ინტერვალით; scope.kpi — ახლავე)
    if (scope.kpi || (!scope.at && !scope.task_ids?.length && !scope.schedule_ids?.length)) out.kpi = await this.kpi.track(!!scope.kpi).catch((e: Error) => ({ error: e.message }));
    return out;
  }
}
