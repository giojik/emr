import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { sql, type RawBuilder } from 'kysely';
import type { AuditContext } from '../audit/audit.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/roles';
import { InjectDb, type Database } from '../database/database.module';
import { PRI_RANK, TZ, iso, userName, wlSettings, type Priority, type WlSettings } from './worklist-common';
import { WorklistTasksService, countCache, type Target, type TargetKind } from './worklist-tasks';

/**
 * 0084 — განმეორებადი (გრაფიკით) ხელით დავალებები.
 *  • გრაფიკი: ყოველდღე (1–6 დრო) / კვირის დღეებით / თვის N რიცხვი (0 — ბოლო დღე) / ყოველ N საათში (ათვლა — დაწყების დღე + პირველი დრო); კლინიკის დროით.
 *  • worker (ყოველ 5 წთ): დგომის მომენტში იქმნება დავალება (ვადა = დგომა + due_hours; 0 — კატეგორიის SLA / პრიორიტეტის ნაგულისხმევი).
 *    worker გაჩერებული თუ იყო — იქმნება მხოლოდ ბოლო ერთი (ძველს არ ავსებს). უნიკალობა: (schedule_id, occurrence_at).
 *  • წინა ჯერ ღიაა (prev_open): skip — გამოტოვება (ჟურნალში), create — მაინც, replace — წინა უქმდება მიზეზით.
 *  • სამიზნე — D1-ის ყველა სახე (მორიგის ჩათვლით); მინიჭების წესი (assign_scope) — როგორც ხელით დავალებაზე. პაციენტის მიბმა — არა (I1).
 *  • მართვა: ავტორი, worklist_manage (გრაფიკის განყოფილება), worklist_all / admin.
 */
export type Freq = 'daily' | 'weekly' | 'monthly' | 'hourly';
export interface ScheduleIn extends Partial<Target> {
  title?: string; description?: string | null; category_id?: string | null; priority?: Priority; due_hours?: number;
  freq?: Freq; times?: string[]; weekdays?: number[]; month_day?: number | null; every_hours?: number | null;
  starts_on?: string; ends_on?: string | null; prev_open?: 'skip' | 'create' | 'replace'; is_active?: boolean;
}
interface Sched {
  id: string; title: string; description: string | null; category_id: string | null; priority: string; due_hours: number; target_kind: string;
  assignee_id: string | null; target_role_id: string | null; target_department_id: string | null; target_duty_role_id: string | null; department_id: string | null;
  freq: string; times: string[]; weekdays: number[]; month_day: number | null; every_hours: number | null; starts_on: string; ends_on: string | null;
  prev_open: string; is_active: boolean; next_at: Date | string | null; created_by: string;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** კლინიკის დღე (YYYY-MM-DD) */
export const localDay = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
/** YYYY-MM-DD + HH:MI კლინიკის დროით → Date (ოფსეტი — იმ მომენტისთვის) */
export function zonedAt(day: string, hhmm: string): Date {
  const probe = new Date(`${day}T${hhmm}:00Z`);
  const off = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset' }).formatToParts(probe).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(off);
  const mins = m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0;
  return new Date(probe.getTime() - mins * 60_000);
}
const addDay = (day: string, n: number) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const isoDow = (day: string) => { const w = new Date(`${day}T12:00:00Z`).getUTCDay(); return w === 0 ? 7 : w; };
const lastDom = (day: string) => new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)), 0)).getUTCDate();

/** შემდეგი დგომა after-ის შემდეგ (მკაცრად მეტი); null — გრაფიკი დასრულდა */
export function nextOccurrence(s: Pick<Sched, 'freq' | 'times' | 'weekdays' | 'month_day' | 'every_hours' | 'starts_on' | 'ends_on'>, after: Date): Date | null {
  const end = s.ends_on ? String(s.ends_on).slice(0, 10) : null;
  const start = String(s.starts_on).slice(0, 10);
  if (s.freq === 'hourly') {
    const anchor = zonedAt(start, s.times[0]);
    const step = (s.every_hours ?? 1) * 3600_000;
    const t = after < anchor ? anchor : new Date(anchor.getTime() + (Math.floor((after.getTime() - anchor.getTime()) / step) + 1) * step);
    return end && localDay(t) > end ? null : t;
  }
  const times = [...s.times].sort();
  let day = localDay(after) < start ? start : localDay(after);
  for (let i = 0; i < 800; i++, day = addDay(day, 1)) {
    if (end && day > end) return null;
    const ok = s.freq === 'daily' || (s.freq === 'weekly' && s.weekdays.includes(isoDow(day)))
      || (s.freq === 'monthly' && Number(day.slice(8, 10)) === (s.month_day === 0 ? lastDom(day) : s.month_day));
    if (!ok) continue;
    for (const hm of times) { const t = zonedAt(day, hm); if (t > after) return t; }
  }
  return null;
}

@Injectable()
export class WorklistSchedulesService {
  private readonly log = new Logger('WorklistSchedules');
  constructor(@InjectDb() private readonly db: Database, private readonly tasks: WorklistTasksService, private readonly audit: AuditService) {}

  // ------------------------------------------------------------------ ვალიდაცია
  private rule(d: ScheduleIn, base?: Sched) {
    const freq = (d.freq ?? base?.freq) as Freq | undefined;
    if (!freq || !['daily', 'weekly', 'monthly', 'hourly'].includes(freq)) throw new BadRequestException('freq: daily / weekly / monthly / hourly');
    const times = [...new Set((d.times ?? base?.times ?? []).map((t) => String(t)))].sort();
    if (!times.length || times.some((t) => !HHMM.test(t))) throw new BadRequestException('დრო: HH:MM (მინ. ერთი)');
    if (freq === 'hourly' ? times.length !== 1 : times.length > 6) throw new BadRequestException(freq === 'hourly' ? 'ყოველ N საათში — ერთი საწყისი დრო' : 'დღეში — მაქს. 6 დრო');
    const weekdays = freq === 'weekly' ? [...new Set((d.weekdays ?? base?.weekdays ?? []).map(Number))].sort() : [];
    if (freq === 'weekly' && (!weekdays.length || weekdays.some((w) => !Number.isInteger(w) || w < 1 || w > 7))) throw new BadRequestException('კვირის დღეები: 1 (ორშ) … 7 (კვ)');
    const month_day = freq === 'monthly' ? (d.month_day !== undefined ? d.month_day : base?.month_day ?? null) : null;
    if (freq === 'monthly' && (month_day === null || !Number.isInteger(month_day) || month_day < 0 || month_day > 28)) throw new BadRequestException('თვის რიცხვი: 1–28 ან 0 (ბოლო დღე)');
    const every_hours = freq === 'hourly' ? (d.every_hours !== undefined ? d.every_hours : base?.every_hours ?? null) : null;
    if (freq === 'hourly' && (every_hours === null || !Number.isInteger(every_hours) || every_hours < 1 || every_hours > 24)) throw new BadRequestException('ყოველ N საათში: 1–24');
    const starts_on = (d.starts_on ?? (base ? String(base.starts_on).slice(0, 10) : localDay(new Date())));
    if (!DAY.test(starts_on)) throw new BadRequestException('starts_on: YYYY-MM-DD');
    const ends_on = d.ends_on !== undefined ? d.ends_on : base?.ends_on ? String(base.ends_on).slice(0, 10) : null;
    if (ends_on !== null && (!DAY.test(ends_on) || ends_on < starts_on)) throw new BadRequestException('ends_on: YYYY-MM-DD, დაწყებაზე არა ადრე');
    const due_hours = d.due_hours ?? base?.due_hours ?? 0;
    if (!Number.isInteger(due_hours) || due_hours < 0 || due_hours > 720) throw new BadRequestException('due_hours: 0–720');
    return { freq, times, weekdays, month_day, every_hours, starts_on, ends_on, due_hours };
  }
  private async canManage(s: Pick<Sched, 'created_by' | 'department_id'>, u: AuthUser) {
    const c = await this.tasks.ctx(u);
    return s.created_by === u.id || c.all || (!!s.department_id && c.manage.includes(s.department_id));
  }

  // ------------------------------------------------------------------ CRUD
  async list(u: AuthUser, box: string) {
    await this.tasks.settings();
    const c = await this.tasks.ctx(u);
    const where = box === 'team'
      ? (c.all ? sql<boolean>`TRUE` : c.manage.length ? sql<boolean>`s.department_id = ANY (${c.manage}::uuid[])` : sql<boolean>`FALSE`)
      : sql<boolean>`(s.created_by = ${u.id} OR s.assignee_id = ${u.id})`;
    if (box === 'team' && !c.all && !c.manage.length) throw new ForbiddenException('ხელმძღვანელის ხედი — worklist_manage / worklist_all');
    const rows = await this.rows(where);
    return rows.map((r) => this.shape(r, u, c));
  }
  private rows(where: RawBuilder<boolean>) {
    return this.db.selectFrom('wl_task_schedules as s').leftJoin('wl_categories as k', 'k.id', 's.category_id').innerJoin('users as cu', 'cu.id', 's.created_by')
      .leftJoin('users as au', 'au.id', 's.assignee_id').leftJoin('roles as ro', 'ro.id', 's.target_role_id').leftJoin('departments as td', 'td.id', 's.target_department_id')
      .leftJoin('duty_roles as dr', 'dr.id', 's.target_duty_role_id').leftJoin('departments as d', 'd.id', 's.department_id')
      .selectAll('s').select(['k.name as category_name', 'd.name as department_name', userName('cu').as('created_by_name'), userName('au').as('assignee_name'), 'ro.name as role_name',
        'td.name as target_department_name', 'dr.name as duty_role_name',
        sql<number>`(SELECT count(*)::int FROM wl_tasks t WHERE t.schedule_id = s.id AND t.status IN ('open', 'in_progress'))`.as('open_tasks'),
        sql<number>`(SELECT count(*)::int FROM wl_tasks t WHERE t.schedule_id = s.id)`.as('total_tasks')])
      .where(where).orderBy('s.is_active', 'desc').orderBy(sql`s.next_at NULLS LAST`).orderBy('s.created_at', 'desc').limit(500).execute();
  }
  private shape(r: Awaited<ReturnType<WorklistSchedulesService['rows']>>[number], u: AuthUser, c: { all: boolean; manage: string[] }) {
    return { ...r, starts_on: String(r.starts_on).slice(0, 10), ends_on: r.ends_on ? String(r.ends_on).slice(0, 10) : null, next_at: iso(r.next_at), last_occurrence_at: iso(r.last_occurrence_at),
      target_label: this.tasks.label(r as never), can_manage: r.created_by === u.id || c.all || (!!r.department_id && c.manage.includes(r.department_id)) };
  }
  async get(id: string, u: AuthUser) {
    await this.tasks.settings();
    const c = await this.tasks.ctx(u);
    const r = (await this.rows(sql<boolean>`s.id = ${id}::uuid`))[0];
    if (!r) throw new NotFoundException('გრაფიკი ვერ მოიძებნა');
    if (!(r.created_by === u.id || r.assignee_id === u.id || c.all || (!!r.department_id && c.manage.includes(r.department_id)))) throw new ForbiddenException('გრაფიკი თქვენს ხედვის არეში არ არის');
    const runs = await this.db.selectFrom('wl_schedule_runs as x').leftJoin('wl_tasks as t', 't.id', 'x.task_id')
      .select(['x.id', 'x.occurrence_at', 'x.result', 'x.task_id', 'x.prev_task_id', 'x.created_at', 't.task_no', 't.status as task_status'])
      .where('x.schedule_id', '=', id).orderBy('x.id', 'desc').limit(30).execute();
    return { ...this.shape(r, u, c), runs: runs.map((x) => ({ ...x, occurrence_at: iso(x.occurrence_at) })) };
  }

  async create(d: ScheduleIn, u: AuthUser, ctx: AuditContext) {
    const s = await this.tasks.settings();
    const c = await this.tasks.ctx(u);
    if (!d.title || d.title.trim().length < 3) throw new BadRequestException('სათაური — მინ. 3 სიმბოლო');
    const rule = this.rule(d);
    await this.checkCategory(d.category_id);
    const t = await this.tasks.resolveTarget(this.db, (d.target_kind ? d : { target_kind: 'user', assignee_id: u.id }) as Target);
    await this.tasks.checkAssign(this.db, u, c, s, t);
    const creatorDept = (await this.db.selectFrom('users').select('department_id').where('id', '=', u.id).executeTakeFirst())?.department_id ?? null;
    const next = nextOccurrence({ ...rule }, new Date());
    const row = await this.db.transaction().execute(async (trx) => {
      const r = await trx.insertInto('wl_task_schedules').values({
        title: d.title!.trim(), description: d.description?.trim() || null, category_id: d.category_id ?? null, priority: d.priority ?? 'normal', due_hours: rule.due_hours,
        target_kind: t.target_kind, assignee_id: t.assignee_id, target_role_id: t.target_role_id, target_department_id: t.target_department_id, target_duty_role_id: t.target_duty_role_id,
        department_id: t.dept ?? creatorDept, freq: rule.freq, times: rule.times, weekdays: rule.weekdays, month_day: rule.month_day, every_hours: rule.every_hours,
        starts_on: rule.starts_on, ends_on: rule.ends_on, prev_open: d.prev_open ?? 'skip', is_active: d.is_active ?? true, next_at: next, created_by: u.id,
      }).returning('id').executeTakeFirstOrThrow();
      await this.audit.log(ctx, { action: 'WL_SCHEDULE_CREATE', entityName: 'wl_task_schedules', entityId: r.id, newData: { ...d, ...rule, next_at: iso(next) } }, trx);
      return r;
    });
    return this.get(row.id, u);
  }

  async update(id: string, d: ScheduleIn, u: AuthUser, ctx: AuditContext) {
    const s = await this.tasks.settings();
    const old = await this.db.selectFrom('wl_task_schedules').selectAll().where('id', '=', id).executeTakeFirst() as Sched | undefined;
    if (!old) throw new NotFoundException('გრაფიკი ვერ მოიძებნა');
    if (!(await this.canManage(old, u))) throw new ForbiddenException('გრაფიკს ცვლის ავტორი / ხელმძღვანელი');
    const rule = this.rule(d, old);
    await this.checkCategory(d.category_id);
    const set: Record<string, unknown> = { ...rule, updated_by: u.id };
    if (d.title !== undefined) { if (d.title.trim().length < 3) throw new BadRequestException('სათაური — მინ. 3 სიმბოლო'); set.title = d.title.trim(); }
    if (d.description !== undefined) set.description = d.description?.trim() || null;
    if (d.category_id !== undefined) set.category_id = d.category_id;
    if (d.priority !== undefined) set.priority = d.priority;
    if (d.prev_open !== undefined) set.prev_open = d.prev_open;
    if (d.is_active !== undefined) set.is_active = d.is_active;
    if (d.target_kind) {
      const c = await this.tasks.ctx(u);
      const t = await this.tasks.resolveTarget(this.db, d as Target);
      await this.tasks.checkAssign(this.db, u, c, s, t);
      Object.assign(set, { target_kind: t.target_kind, assignee_id: t.assignee_id, target_role_id: t.target_role_id, target_department_id: t.target_department_id,
        target_duty_role_id: t.target_duty_role_id, department_id: t.dept ?? old.department_id });
    }
    // შემდეგი დგომა — ახალი წესით, ახლანდელი მომენტიდან (ან ბოლო დგომიდან, რომ იგივე დრო ორჯერ არ შეიქმნას)
    const last = (await this.db.selectFrom('wl_task_schedules').select('last_occurrence_at').where('id', '=', id).executeTakeFirstOrThrow()).last_occurrence_at;
    const from = last && new Date(last) > new Date() ? new Date(last) : new Date();
    set.next_at = (set.is_active ?? old.is_active) ? nextOccurrence(rule, from) : null;
    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable('wl_task_schedules').set(set).where('id', '=', id).execute();
      await this.audit.log(ctx, { action: 'WL_SCHEDULE_UPDATE', entityName: 'wl_task_schedules', entityId: id, oldData: old, newData: { ...set, next_at: iso(set.next_at as Date | null) } }, trx);
    });
    return this.get(id, u);
  }
  private async checkCategory(id: string | null | undefined) {
    if (id && !(await this.db.selectFrom('wl_categories').select('id').where('id', '=', id).where('is_active', '=', true).executeTakeFirst()))
      throw new BadRequestException('კატეგორია ვერ მოიძებნა ან გათიშულია');
  }

  // ------------------------------------------------------------------ worker
  /** დამდგარი გრაფიკები → დავალებები. at — „ახლა“-ს ჩანაცვლება (admin / e2e); ids — მხოლოდ ეს გრაფიკები */
  async tick(at?: Date, ids?: string[]) {
    const out = { created: 0, skipped: 0, replaced: 0 };
    const m = await wlSettings(this.db);
    if (!m.enabled) return out;
    const now = at ?? new Date();
    const due = await this.db.selectFrom('wl_task_schedules').select('id').where('is_active', '=', true).where('next_at', '<=', now)
      .$if(!!ids?.length, (q) => q.where('id', 'in', ids!)).orderBy('next_at').limit(500).execute();
    for (const { id } of due) {
      try {
        const r = await this.fire(id, now, m.s);
        if (r) out[r]++;
      } catch (e) { this.log.error(`გრაფიკი ${id}: ${(e as Error).message}`); }
    }
    if (out.created || out.replaced) countCache.clear();
    return out;
  }

  private async fire(id: string, now: Date, ws: WlSettings): Promise<'created' | 'skipped' | 'replaced' | null> {
    const res = await this.db.transaction().execute(async (trx) => {
      const s = await trx.selectFrom('wl_task_schedules').selectAll().where('id', '=', id).forUpdate().skipLocked().executeTakeFirst() as Sched | undefined;
      if (!s || !s.is_active || !s.next_at || new Date(s.next_at) > now) return null;
      // ძველს არ ავსებს: ბოლო დგომა ≤ now
      let occ = new Date(s.next_at);
      for (let i = 0; i < 20_000; i++) { const n = nextOccurrence(s, occ); if (!n || n > now) break; occ = n; }
      const next = nextOccurrence(s, occ);
      await trx.updateTable('wl_task_schedules').set({ next_at: next, last_occurrence_at: occ, ...(next ? {} : { is_active: false }) }).where('id', '=', id).execute();
      if (await trx.selectFrom('wl_tasks').select('id').where('schedule_id', '=', id).where('occurrence_at', '=', occ).executeTakeFirst()) return null;
      const prev = await trx.selectFrom('wl_tasks').select(['id']).where('schedule_id', '=', id).where('status', 'in', ['open', 'in_progress']).orderBy('occurrence_at', 'desc').execute();
      if (prev.length && s.prev_open === 'skip') {
        await trx.insertInto('wl_schedule_runs').values({ schedule_id: id, occurrence_at: occ, result: 'skipped', prev_task_id: prev[0].id }).execute();
        return { kind: 'skipped' as const, task: null };
      }
      if (prev.length && s.prev_open === 'replace') {
        for (const p of prev) {
          await trx.updateTable('wl_tasks').set({ status: 'cancelled', cancelled_at: sql`now()`, cancelled_by: s.created_by, cancel_reason: 'ჩანაცვლდა გრაფიკის ახალი დავალებით', updated_at: sql`now()` })
            .where('id', '=', p.id).execute();
          await trx.insertInto('wl_task_events').values({ task_id: p.id, kind: 'cancelled', user_id: null, note: 'ჩანაცვლდა გრაფიკის ახალი დავალებით', data: JSON.stringify({ schedule_id: id }) }).execute();
        }
      }
      const due = await this.dueAt(trx, ws, s, occ);
      const no = await this.tasks.nextNo(trx);
      const t = await trx.insertInto('wl_tasks').values({
        task_no: no, title: s.title, description: s.description, category_id: s.category_id, priority: s.priority, due_at: due,
        target_kind: s.target_kind, assignee_id: s.assignee_id, target_role_id: s.target_role_id, target_department_id: s.target_department_id, target_duty_role_id: s.target_duty_role_id,
        department_id: s.department_id, created_by: s.created_by, schedule_id: id, occurrence_at: occ,
      }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('wl_task_events').values({ task_id: t.id, kind: 'created', user_id: null, data: JSON.stringify({ schedule_id: id, occurrence_at: occ.toISOString(), priority: s.priority, due_at: iso(due) }) }).execute();
      const kind = prev.length && s.prev_open === 'replace' ? 'replaced' as const : 'created' as const;
      await trx.insertInto('wl_schedule_runs').values({ schedule_id: id, occurrence_at: occ, result: kind, task_id: t.id, prev_task_id: prev[0]?.id ?? null }).execute();
      return { kind, task: t.id };
    });
    if (res?.task && ws.notify_assign) await this.tasks.notifyTarget(res.task, '', 'ახალი დავალება (გრაფიკით)');
    return res?.kind ?? null;
  }
  private async dueAt(trx: Parameters<WorklistTasksService['nextNo']>[0], ws: WlSettings, s: Sched, occ: Date) {
    if (s.due_hours > 0) return new Date(occ.getTime() + s.due_hours * 36e5);
    if (s.category_id) {
      const k = await trx.selectFrom('wl_categories').select('sla_hours').where('id', '=', s.category_id).executeTakeFirst();
      if (k?.sla_hours) return new Date(occ.getTime() + k.sla_hours * 36e5);
    }
    const p = s.priority as Priority;
    const h = ws.due_default_hours[PRI_RANK[p] === 0 ? 2 : PRI_RANK[p] === 1 ? 1 : 0] ?? 0;
    return h > 0 ? new Date(occ.getTime() + h * 36e5) : null;
  }

  /** diagnostics: აქტიური გრაფიკები, რომელთა სამიზნე ცარიელია / გათიშულია */
  async emptyTargets(includeTest: boolean) {
    const REAL = includeTest ? sql`TRUE` : sql`s.title NOT LIKE 'ტესტ-E2E%'`;
    return (await sql<{ n: string }>`SELECT s.title || ' — ' || CASE s.target_kind
          WHEN 'user' THEN 'შემსრულებელი გათიშულია' WHEN 'role' THEN 'როლის აქტიური წევრი არ არის' WHEN 'department' THEN 'განყოფილებაში აქტიური წევრი არ არის'
          WHEN 'role_department' THEN 'როლი + განყოფილება: წევრი არ არის' ELSE 'მორიგის როლი გათიშულია' END AS n
        FROM wl_task_schedules s
       WHERE s.is_active AND ${REAL} AND CASE s.target_kind
          WHEN 'user' THEN NOT EXISTS (SELECT 1 FROM users u WHERE u.id = s.assignee_id AND u.is_active)
          WHEN 'role' THEN NOT EXISTS (SELECT 1 FROM user_roles ur JOIN users u ON u.id = ur.user_id JOIN roles r ON r.id = ur.role_id WHERE ur.role_id = s.target_role_id AND u.is_active AND r.is_active)
          WHEN 'department' THEN NOT EXISTS (SELECT 1 FROM users u WHERE u.department_id = s.target_department_id AND u.is_active)
          WHEN 'role_department' THEN NOT EXISTS (SELECT 1 FROM user_roles ur JOIN users u ON u.id = ur.user_id WHERE ur.role_id = s.target_role_id AND u.is_active AND u.department_id = s.target_department_id)
          ELSE NOT EXISTS (SELECT 1 FROM duty_roles d WHERE d.id = s.target_duty_role_id AND d.is_active) END
       ORDER BY s.created_at DESC`.execute(this.db)).rows.map((r) => r.n);
  }
}

export const TARGET_KINDS: TargetKind[] = ['user', 'role', 'department', 'role_department', 'duty'];
