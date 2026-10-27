import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { sql, type RawBuilder } from 'kysely';
import type { AuditContext } from '../audit/audit.service';
import { AuditService } from '../audit/audit.service';
import { has, type AuthUser } from '../auth/roles';
import { InjectDb, type Database } from '../database/database.module';
import { NotificationsService } from '../notifications/notifications';
import {
  ACTIVE, PRIORITY_KA, PRI_RANK, STATUS_KA, TARGET_KA, TZ, iso, isAll, manageDepts, memberDepts, myRoleIds, onDutyCond, userName, wlSettings,
  type Ex, type Priority, type Trx, type WlItem, type WlSettings,
} from './worklist-common';

/** ჩანაწერის კეში (მთვლელი) — დავალების ცვლილებისას იწმინდება */
export const countCache = new Map<string, { t: number; v: { total: number; overdue: number; urgent: number } }>();

export type TargetKind = 'user' | 'role' | 'department' | 'role_department' | 'duty';
export interface Target { target_kind: TargetKind; assignee_id?: string | null; target_role_id?: string | null; target_department_id?: string | null; target_duty_role_id?: string | null }
export interface CreateIn extends Target {
  title: string; description?: string | null; category_id?: string | null; priority?: Priority; due_at?: string | null; patient_id?: string | null; encounter_id?: string | null;
}
export interface EditIn { title?: string; description?: string | null; category_id?: string | null; priority?: Priority; due_at?: string | null }
export interface ListQ { box?: string; status?: string; department_id?: string; overdue?: string; patient_id?: string; q?: string; assignee_id?: string; category_id?: string; target_kind?: string }

interface Ctx { roles: string[]; member: string[]; manage: string[]; all: boolean }
type TaskRow = Awaited<ReturnType<WorklistTasksService['rows']>>[number];

/**
 * ხელით შექმნილი დავალებები (0081): შექმნა / ხილვადობა / ციკლი / მინიჭების წესი / შეტყობინებები.
 *  ხილვადობა: შემქმნელი, შემსრულებელი (assignee / აიღო), ჯგუფის წევრი (როლი / განყოფილება / მორიგე), ხელმძღვანელი (worklist_manage — თავისი განყოფილებები;
 *  worklist_all / admin — ყველა). ჯგუფის წევრობა: როლი — user_roles; განყოფილება — users.department_id ∪ D4 თანამშრომლის განყოფილებები; მორიგე — ახლა მორიგე ვარ.
 */
@Injectable()
export class WorklistTasksService {
  private readonly log = new Logger('Worklist');
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService, private readonly notifications: NotificationsService) {}

  async settings(): Promise<WlSettings> {
    const m = await wlSettings(this.db);
    if (!m.enabled) throw new ForbiddenException({ code: 'MODULE_DISABLED', message: 'მოდული „სამუშაო სიები“ გამორთულია (ადმინისტრირება → მოდულები)' });
    return m.s;
  }
  async ctx(u: AuthUser, ex: Ex = this.db): Promise<Ctx> {
    const [roles, member, manage] = await Promise.all([myRoleIds(ex, u.id), memberDepts(ex, u.id), manageDepts(ex, u)]);
    return { roles, member, manage, all: isAll(u) };
  }

  // ------------------------------------------------------------------ SQL ნაწილები
  private memberCond(u: AuthUser, c: Ctx): RawBuilder<boolean> {
    const roles = c.roles.length ? c.roles : ['00000000-0000-0000-0000-000000000000'];
    const depts = c.member.length ? c.member : ['00000000-0000-0000-0000-000000000000'];
    return sql<boolean>`(
         (t.target_kind = 'role' AND t.target_role_id = ANY (${roles}::uuid[]))
      OR (t.target_kind = 'role_department' AND t.target_role_id = ANY (${roles}::uuid[]) AND t.target_department_id = ANY (${depts}::uuid[]))
      OR (t.target_kind = 'department' AND t.target_department_id = ANY (${depts}::uuid[]))
      OR (t.target_kind = 'duty' AND ${onDutyCond(u.id)}))`;
  }
  private doerCond(u: AuthUser, c: Ctx): RawBuilder<boolean> {
    return sql<boolean>`(t.assignee_id = ${u.id} OR t.claimed_by = ${u.id} OR (t.target_kind <> 'user' AND t.claimed_by IS NULL AND ${this.memberCond(u, c)}))`;
  }
  private teamCond(c: Ctx): RawBuilder<boolean> {
    if (c.all) return sql<boolean>`TRUE`;
    return c.manage.length ? sql<boolean>`t.department_id = ANY (${c.manage}::uuid[])` : sql<boolean>`FALSE`;
  }
  private viewCond(u: AuthUser, c: Ctx): RawBuilder<boolean> {
    return sql<boolean>`(t.created_by = ${u.id} OR t.assignee_id = ${u.id} OR t.claimed_by = ${u.id} OR ${this.memberCond(u, c)} OR ${this.teamCond(c)})`;
  }

  private base(ex: Ex = this.db) {
    return ex.selectFrom('wl_tasks as t').leftJoin('wl_categories as k', 'k.id', 't.category_id').innerJoin('users as cu', 'cu.id', 't.created_by')
      .leftJoin('users as au', 'au.id', 't.assignee_id').leftJoin('users as cl', 'cl.id', 't.claimed_by').leftJoin('roles as ro', 'ro.id', 't.target_role_id')
      .leftJoin('departments as td', 'td.id', 't.target_department_id').leftJoin('duty_roles as dr', 'dr.id', 't.target_duty_role_id')
      .leftJoin('departments as d', 'd.id', 't.department_id').leftJoin('patients as p', 'p.id', 't.patient_id')
      .select(['t.id', 't.task_no', 't.title', 't.description', 't.category_id', 'k.name as category_name', 't.priority', 't.due_at', 't.target_kind', 't.assignee_id',
        't.target_role_id', 't.target_department_id', 't.target_duty_role_id', 't.department_id', 'd.name as department_name', 't.claimed_by', 't.claimed_at',
        't.patient_id', 't.encounter_id', 't.status', 't.created_by', 't.created_at', 't.updated_at', 't.started_at', 't.done_at', 't.done_by', 't.done_note',
        't.cancelled_at', 't.cancel_reason', 't.reminded_at', 't.escalated_at',
        userName('cu').as('created_by_name'), userName('au').as('assignee_name'), userName('cl').as('claimed_by_name'), 'ro.name as role_name', 'td.name as target_department_name',
        'dr.name as duty_role_name', sql<string | null>`CASE WHEN p.id IS NULL THEN NULL ELSE p.last_name || ' ' || p.first_name END`.as('patient_name'), 'p.personal_number as patient_personal_number',
        sql<boolean>`t.status IN ('open', 'in_progress') AND t.due_at IS NOT NULL AND t.due_at < now()`.as('overdue')]);
  }
  private rows(where: RawBuilder<boolean>, limit = 500, ex: Ex = this.db) {
    return this.base(ex).where(where).orderBy(sql`CASE WHEN t.status IN ('open', 'in_progress') THEN 0 ELSE 1 END`)
      .orderBy(sql`CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END`).orderBy(sql`t.due_at NULLS LAST`).orderBy('t.created_at', 'desc').limit(limit).execute();
  }
  private label(r: Pick<TaskRow, 'target_kind' | 'assignee_name' | 'role_name' | 'target_department_name' | 'duty_role_name'>) {
    switch (r.target_kind) {
      case 'user': return r.assignee_name ?? '—';
      case 'role': return r.role_name ?? '—';
      case 'department': return r.target_department_name ?? '—';
      case 'role_department': return `${r.role_name ?? '—'} · ${r.target_department_name ?? '—'}`;
      default: return `მორიგე: ${r.duty_role_name ?? '—'}`;
    }
  }
  private shape(r: TaskRow, u: AuthUser, c: Ctx, s: WlSettings) {
    return { ...r, due_at: iso(r.due_at), target_label: this.label(r), group: r.target_kind !== 'user', status_name: STATUS_KA[r.status], priority_name: PRIORITY_KA[r.priority as Priority],
      can: this.can(r, u, c, s, null) };
  }

  /** ქმედებების უფლებები; member — ჯგუფის წევრობა (null — დათვლა row-იდან შეუძლებელია, list-ში — SQL-ით არ მოწმდება → false) */
  can(r: Pick<TaskRow, 'status' | 'target_kind' | 'assignee_id' | 'claimed_by' | 'created_by' | 'department_id' | 'done_at' | 'cancelled_at'>, u: AuthUser, c: Ctx, s: WlSettings, member: boolean | null) {
    const active = r.status === 'open' || r.status === 'in_progress';
    const doer = r.assignee_id === u.id || r.claimed_by === u.id;
    const creator = r.created_by === u.id;
    const manager = c.all || (!!r.department_id && c.manage.includes(r.department_id));
    const grp = r.target_kind !== 'user';
    const freeMember = grp && !r.claimed_by && !!member;
    const closedAt = r.done_at ?? r.cancelled_at;
    const inWindow = !!closedAt && Date.now() - new Date(closedAt).getTime() <= s.reopen_days * 864e5;
    return {
      claim: active && freeMember,
      release: active && grp && r.claimed_by === u.id,
      start: r.status === 'open' && (doer || freeMember),
      done: active && (doer || freeMember || manager),
      cancel: active && (creator || manager),
      edit: active && (creator || manager),
      reassign: active && (creator || manager),
      reopen: !active && (creator || manager) && inWindow,
      comment: true,
    };
  }

  // ------------------------------------------------------------------ სიები
  async list(u: AuthUser, q: ListQ) {
    const s = await this.settings();
    const c = await this.ctx(u);
    const box = q.box ?? 'mine';
    let where: RawBuilder<boolean>;
    const actv = sql<boolean>`t.status IN ('open', 'in_progress')`;
    if (box === 'mine') where = sql<boolean>`${actv} AND ${this.doerCond(u, c)}`;
    else if (box === 'group') where = sql<boolean>`${actv} AND t.target_kind <> 'user' AND ${this.memberCond(u, c)}`;
    else if (box === 'created') where = sql<boolean>`t.created_by = ${u.id}`;
    else if (box === 'team') {
      if (!c.all && !c.manage.length) throw new ForbiddenException(has(u, 'worklist_manage')
        ? { code: 'NO_SCOPE', message: 'განყოფილება არ გაქვთ მინიჭებული (მომხმარებლის განყოფილება ან რეპორტინგის ხედვის არე)' } : 'ხელმძღვანელის ხედი — worklist_manage / worklist_all');
      where = this.teamCond(c);
    } else if (box === 'patient') {
      if (!q.patient_id) throw new BadRequestException('patient_id');
      where = this.viewCond(u, c);
    } else throw new BadRequestException('box: mine / group / created / team / patient');
    const f: RawBuilder<boolean>[] = [where];
    const st = q.status ?? (box === 'created' || box === 'team' || box === 'patient' ? 'active' : undefined);
    if (st === 'active') f.push(actv);
    else if (st === 'closed') f.push(sql<boolean>`t.status IN ('done', 'cancelled') AND coalesce(t.done_at, t.cancelled_at) > now() - interval '90 days'`);
    else if (st && st !== 'all') { if (!['open', 'in_progress', 'done', 'cancelled'].includes(st)) throw new BadRequestException('status'); f.push(sql<boolean>`t.status = ${st}`); }
    if (q.department_id) f.push(sql<boolean>`t.department_id = ${q.department_id}::uuid`);
    if (q.patient_id) f.push(sql<boolean>`t.patient_id = ${q.patient_id}::uuid`);
    if (q.assignee_id === 'none') f.push(sql<boolean>`t.target_kind <> 'user' AND t.claimed_by IS NULL`);
    else if (q.assignee_id) f.push(sql<boolean>`(t.assignee_id = ${q.assignee_id}::uuid OR t.claimed_by = ${q.assignee_id}::uuid)`);
    if (q.category_id) f.push(sql<boolean>`t.category_id = ${q.category_id}::uuid`);
    if (q.target_kind) f.push(sql<boolean>`t.target_kind = ${q.target_kind}`);
    if (q.overdue === '1') f.push(sql<boolean>`t.status IN ('open', 'in_progress') AND t.due_at < now()`);
    if (q.q?.trim()) f.push(sql<boolean>`(t.title ILIKE ${`%${q.q.trim()}%`} OR t.task_no ILIKE ${`%${q.q.trim()}%`})`);
    const rows = await this.rows(sql.join(f, sql` AND `) as RawBuilder<boolean>);
    // ჯგუფის წევრობა — „ავიღებ“ / „დაწყება“ ღილაკებისთვის
    const memberIds = new Set(rows.some((r) => r.target_kind !== 'user')
      ? (await this.db.selectFrom('wl_tasks as t').select('t.id').where('t.id', 'in', rows.map((r) => r.id)).where(this.memberCond(u, c)).execute()).map((x) => x.id) : []);
    return rows.map((r) => ({ ...this.shape(r, u, c, s), can: this.can(r, u, c, s, memberIds.has(r.id)) }));
  }

  /** „ჩემი დავალებები“-ს ერთიანი სიისთვის */
  async mineItems(u: AuthUser): Promise<WlItem[]> {
    const c = await this.ctx(u);
    const rows = await this.rows(sql<boolean>`t.status IN ('open', 'in_progress') AND ${this.doerCond(u, c)}`, 300);
    const now = Date.now();
    return rows.map((r) => ({
      key: `task:${r.id}`, kind: 'task', source: 'task', group: 'ხელით შექმნილი', title: r.title, detail: r.category_name ?? null, patient: r.patient_name, department: r.department_name,
      due_at: iso(r.due_at), due_date_only: false, overdue: !!r.due_at && new Date(r.due_at).getTime() < now, priority: r.priority as Priority, link: `/tasks?task=${r.id}`,
      created_at: iso(r.created_at),
      task: { id: r.id, task_no: r.task_no, status: r.status, target_kind: r.target_kind, target_label: this.label(r), claimed_by_name: r.claimed_by_name, group: r.target_kind !== 'user',
        created_by_name: r.created_by_name },
    }));
  }

  async get(id: string, u: AuthUser, ctx: AuditContext) {
    const s = await this.settings();
    const c = await this.ctx(u);
    const r = (await this.rows(sql<boolean>`t.id = ${id}::uuid AND ${this.viewCond(u, c)}`, 1))[0];
    if (!r) {
      if (await this.db.selectFrom('wl_tasks').select('id').where('id', '=', id).executeTakeFirst()) throw new ForbiddenException('დავალება თქვენს ხედვის არეში არ არის');
      throw new NotFoundException('დავალება ვერ მოიძებნა');
    }
    const member = !!(await this.db.selectFrom('wl_tasks as t').select('t.id').where('t.id', '=', id).where(this.memberCond(u, c)).executeTakeFirst());
    const events = await this.db.selectFrom('wl_task_events as e').leftJoin('users as eu', 'eu.id', 'e.user_id')
      .select(['e.id', 'e.kind', 'e.note', 'e.data', 'e.created_at', userName('eu').as('user_name')]).where('e.task_id', '=', id).orderBy('e.id').execute();
    if (r.patient_id) await this.audit.log(ctx, { action: 'WL_TASK_VIEW', entityName: 'wl_tasks', entityId: id, newData: { patient_id: r.patient_id } });
    return { ...this.shape(r, u, c, s), can: this.can(r, u, c, s, member), member, events };
  }

  // ------------------------------------------------------------------ სამიზნე / წესი
  private async resolveTarget(ex: Ex, t: Target) {
    const k = t.target_kind;
    const need = (v: string | null | undefined, f: string) => { if (!v) throw new BadRequestException(`${f} — სავალდებულოა (${TARGET_KA[k]})`); return v; };
    const clean = { assignee_id: null as string | null, target_role_id: null as string | null, target_department_id: null as string | null, target_duty_role_id: null as string | null };
    let dept: string | null = null;
    if (k === 'user') {
      const x = await ex.selectFrom('users').select(['id', 'department_id', 'is_active']).where('id', '=', need(t.assignee_id, 'assignee_id')).executeTakeFirst();
      if (!x?.is_active) throw new BadRequestException('შემსრულებელი ვერ მოიძებნა ან გათიშულია');
      clean.assignee_id = x.id; dept = x.department_id;
    }
    if (k === 'role' || k === 'role_department') {
      const x = await ex.selectFrom('roles').select(['id', 'is_active']).where('id', '=', need(t.target_role_id, 'target_role_id')).executeTakeFirst();
      if (!x?.is_active) throw new BadRequestException('როლი ვერ მოიძებნა ან გათიშულია');
      clean.target_role_id = x.id;
    }
    if (k === 'department' || k === 'role_department') {
      const x = await ex.selectFrom('departments').select(['id', 'is_active']).where('id', '=', need(t.target_department_id, 'target_department_id')).executeTakeFirst();
      if (!x?.is_active) throw new BadRequestException('განყოფილება ვერ მოიძებნა ან გათიშულია');
      clean.target_department_id = x.id; dept = x.id;
    }
    if (k === 'duty') {
      const m = await ex.selectFrom('system_modules').select('enabled').where('code', '=', 'roster').executeTakeFirst();
      if (!m?.enabled) throw new BadRequestException('მორიგეზე მინიჭება — საჭიროა მოდული „ცვლები და მორიგეობა“');
      const x = await ex.selectFrom('duty_roles').select(['id', 'is_active', 'department_id']).where('id', '=', need(t.target_duty_role_id, 'target_duty_role_id')).executeTakeFirst();
      if (!x?.is_active) throw new BadRequestException('მორიგის როლი ვერ მოიძებნა ან გათიშულია');
      clean.target_duty_role_id = x.id; dept = x.department_id;
    }
    return { target_kind: k, ...clean, dept };
  }

  /** D2 — ვის შეუძლია სხვისთვის მინიჭება (assign_scope) */
  private async checkAssign(ex: Ex, u: AuthUser, c: Ctx, s: WlSettings, t: Awaited<ReturnType<WorklistTasksService['resolveTarget']>>) {
    if (t.target_kind === 'user' && t.assignee_id === u.id) return;
    if (c.all || s.assign_scope === 'any') return;
    if (t.target_kind === 'department' || t.target_kind === 'duty') return;   // სამსახურის / განყოფილების რიგი, მორიგე — ყოველთვის
    const deny = (m: string) => { throw new ForbiddenException({ code: 'WL_ASSIGN_SCOPE', message: m }); };
    if (t.target_kind === 'role') deny('როლზე განყოფილების გარეშე — მხოლოდ worklist_all (ან პარამეტრი „ნებისმიერს“)');
    const pool = s.assign_scope === 'managers' ? c.manage : [...new Set([...c.member, ...c.manage])];
    if (s.assign_scope === 'managers' && !c.manage.length) deny('სხვისთვის მინიჭება — მხოლოდ ხელმძღვანელს (worklist_manage); შეგიძლიათ — საკუთარ თავზე, განყოფილების რიგში ან მორიგეზე');
    if (t.target_kind === 'role_department') { if (!pool.includes(t.target_department_id!)) deny('განყოფილება თქვენს არეში არ არის'); return; }
    // პირი: მისი რომელიმე განყოფილება (users / D4) ჩემს არეშია
    const theirs = await memberDepts(ex, t.assignee_id!);
    if (!theirs.some((d) => pool.includes(d))) deny('თანამშრომელი თქვენს განყოფილებ(ებ)ში არ არის');
  }

  private async dueFor(ex: Ex, s: WlSettings, d: { due_at?: string | null; category_id?: string | null; priority: Priority }) {
    if (d.due_at) {
      const t = new Date(d.due_at);
      if (Number.isNaN(t.getTime())) throw new BadRequestException('due_at');
      if (t.getTime() < Date.now() - 5 * 60_000) throw new BadRequestException('ვადა წარსულშია');
      return t;
    }
    if (d.category_id) {
      const k = await ex.selectFrom('wl_categories').select('sla_hours').where('id', '=', d.category_id).executeTakeFirst();
      if (k?.sla_hours) return new Date(Date.now() + k.sla_hours * 36e5);
    }
    const h = s.due_default_hours[PRI_RANK[d.priority] === 0 ? 2 : PRI_RANK[d.priority] === 1 ? 1 : 0] ?? 0;
    return h > 0 ? new Date(Date.now() + h * 36e5) : null;
  }

  private async nextNo(trx: Trx) {
    const yr = Number(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric' }).format(new Date()));
    const { last_value } = await trx.insertInto('document_counters').values({ document_type: 'wl_task', year: yr, last_value: 1 })
      .onConflict((oc) => oc.columns(['document_type', 'year']).doUpdateSet({ last_value: sql`document_counters.last_value + 1` })).returning('last_value').executeTakeFirstOrThrow();
    return `TK${String(yr).slice(2)}-${String(last_value).padStart(5, '0')}`;
  }

  // ------------------------------------------------------------------ შექმნა / ცვლილება
  async create(d: CreateIn, u: AuthUser, ctx: AuditContext) {
    const s = await this.settings();
    const c = await this.ctx(u);
    const priority = d.priority ?? 'normal';
    let cat: { id: string; is_active: boolean; allow_patient: boolean; default_target_kind: string | null; default_role_id: string | null; default_department_id: string | null } | undefined;
    if (d.category_id) {
      cat = await this.db.selectFrom('wl_categories').select(['id', 'is_active', 'allow_patient', 'default_target_kind', 'default_role_id', 'default_department_id'])
        .where('id', '=', d.category_id).executeTakeFirst();
      if (!cat?.is_active) throw new BadRequestException('კატეგორია ვერ მოიძებნა ან გათიშულია');
    }
    // კატეგორიის ნაგულისხმევი სამიზნე (თუ ფორმაში არ არის მითითებული)
    const tin: Target = d.target_kind ? d : cat?.default_target_kind
      ? { target_kind: cat.default_target_kind as TargetKind, target_role_id: cat.default_role_id, target_department_id: cat.default_department_id }
      : { target_kind: 'user', assignee_id: u.id };
    const t = await this.resolveTarget(this.db, tin);
    await this.checkAssign(this.db, u, c, s, t);
    if (d.patient_id) {
      if (!s.patient_tasks) throw new BadRequestException('პაციენტთან მიბმა გამორთულია (პარამეტრი)');
      if (cat && !cat.allow_patient) throw new BadRequestException('ამ კატეგორიაზე პაციენტის მიბმა არ არის დაშვებული');
      if (!(await this.db.selectFrom('patients').select('id').where('id', '=', d.patient_id).executeTakeFirst())) throw new BadRequestException('პაციენტი ვერ მოიძებნა');
      if (d.encounter_id && !(await this.db.selectFrom('encounters').select('id').where('id', '=', d.encounter_id).where('patient_id', '=', d.patient_id).executeTakeFirst()))
        throw new BadRequestException('ვიზიტი / ჰოსპიტალიზაცია ამ პაციენტს არ ეკუთვნის');
    } else if (d.encounter_id) throw new BadRequestException('encounter_id — მხოლოდ პაციენტთან ერთად');
    const due = await this.dueFor(this.db, s, { due_at: d.due_at, category_id: d.category_id, priority });
    const creatorDept = (await this.db.selectFrom('users').select('department_id').where('id', '=', u.id).executeTakeFirst())?.department_id ?? null;
    const id = await this.db.transaction().execute(async (trx) => {
      const no = await this.nextNo(trx);
      const row = await trx.insertInto('wl_tasks').values({
        task_no: no, title: d.title.trim(), description: d.description?.trim() || null, category_id: d.category_id ?? null, priority, due_at: due,
        target_kind: t.target_kind, assignee_id: t.assignee_id, target_role_id: t.target_role_id, target_department_id: t.target_department_id, target_duty_role_id: t.target_duty_role_id,
        department_id: t.dept ?? creatorDept, patient_id: d.patient_id ?? null, encounter_id: d.encounter_id ?? null, created_by: u.id,
      }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('wl_task_events').values({ task_id: row.id, kind: 'created', user_id: u.id, data: JSON.stringify({ target_kind: t.target_kind, priority, due_at: iso(due) }) }).execute();
      await this.audit.log(ctx, { action: 'WL_TASK_CREATE', entityName: 'wl_tasks', entityId: row.id,
        newData: { task_no: no, title: d.title, target: t, priority, due_at: iso(due), patient_id: d.patient_id ?? null } }, trx);
      return row.id;
    });
    countCache.clear();
    if (s.notify_assign) await this.notifyTarget(id, u.id, 'ახალი დავალება');
    return this.get(id, u, ctx);
  }

  private async load(trx: Ex, id: string, lock = false) {
    let q = trx.selectFrom('wl_tasks').selectAll().where('id', '=', id);
    if (lock) q = q.forUpdate();
    const r = await q.executeTakeFirst();
    if (!r) throw new NotFoundException('დავალება ვერ მოიძებნა');
    return r;
  }
  private async isMember(ex: Ex, id: string, u: AuthUser, c: Ctx) {
    return !!(await ex.selectFrom('wl_tasks as t').select('t.id').where('t.id', '=', id).where(this.memberCond(u, c)).executeTakeFirst());
  }
  /** ქმედება: ჩაკეტვა → უფლება → ცვლილება → ისტორია → აუდიტი; after — შეტყობინება ტრანზაქციის შემდეგ */
  private async act(id: string, u: AuthUser, ctx: AuditContext, what: keyof ReturnType<WorklistTasksService['can']>,
    fn: (trx: Trx, t: Awaited<ReturnType<WorklistTasksService['load']>>, s: WlSettings, c: Ctx, member: boolean) => Promise<void>) {
    const s = await this.settings();
    const c = await this.ctx(u);
    await this.db.transaction().execute(async (trx) => {
      const t = await this.load(trx, id, true);
      const member = await this.isMember(trx, id, u, c);
      const viewable = t.created_by === u.id || t.assignee_id === u.id || t.claimed_by === u.id || member || c.all || (!!t.department_id && c.manage.includes(t.department_id));
      if (!viewable) throw new ForbiddenException('დავალება თქვენს ხედვის არეში არ არის');
      if (!this.can(t, u, c, s, member)[what]) {
        if (!['open', 'in_progress'].includes(t.status) && what !== 'reopen' && what !== 'comment') throw new ConflictException({ code: 'WL_CLOSED', message: `დავალება ${STATUS_KA[t.status]}ა` });
        throw new ForbiddenException({ code: 'WL_FORBIDDEN', message: 'ეს ქმედება თქვენთვის ხელმისაწვდომი არ არის' });
      }
      await fn(trx, t, s, c, member);
    });
    countCache.clear();
  }
  private ev(trx: Trx, id: string, kind: string, u: AuthUser, note?: string | null, data?: unknown) {
    return trx.insertInto('wl_task_events').values({ task_id: id, kind, user_id: u.id, note: note ?? null, data: data === undefined ? null : JSON.stringify(data) }).execute();
  }

  async edit(id: string, d: EditIn, u: AuthUser, ctx: AuditContext) {
    await this.act(id, u, ctx, 'edit', async (trx, t, s) => {
      const set: Record<string, unknown> = {};
      if (d.title !== undefined) set.title = d.title.trim();
      if (d.description !== undefined) set.description = d.description?.trim() || null;
      if (d.category_id !== undefined) {
        if (d.category_id && !(await trx.selectFrom('wl_categories').select('id').where('id', '=', d.category_id).where('is_active', '=', true).executeTakeFirst()))
          throw new BadRequestException('კატეგორია ვერ მოიძებნა ან გათიშულია');
        set.category_id = d.category_id;
      }
      if (d.priority !== undefined) set.priority = d.priority;
      if (d.due_at !== undefined) {
        set.due_at = d.due_at ? await this.dueFor(trx, s, { due_at: d.due_at, priority: (d.priority ?? t.priority) as Priority }) : null;
        set.reminded_at = null; set.escalated_at = null;
      }
      if (!Object.keys(set).length) return;
      await trx.updateTable('wl_tasks').set({ ...set, updated_at: sql`now()` }).where('id', '=', id).execute();
      const old = Object.fromEntries(Object.keys(set).filter((k) => !['reminded_at', 'escalated_at'].includes(k)).map((k) => [k, (t as Record<string, unknown>)[k]]));
      await this.ev(trx, id, 'edited', u, null, { old, new: Object.fromEntries(Object.entries(set).filter(([k]) => !['reminded_at', 'escalated_at'].includes(k))) });
      await this.audit.log(ctx, { action: 'WL_TASK_UPDATE', entityName: 'wl_tasks', entityId: id, oldData: old, newData: set }, trx);
    });
    return this.get(id, u, ctx);
  }

  async reassign(id: string, d: Target & { note?: string | null }, u: AuthUser, ctx: AuditContext) {
    let notify = false;
    await this.act(id, u, ctx, 'reassign', async (trx, t, s, c) => {
      const nt = await this.resolveTarget(trx, d);
      await this.checkAssign(trx, u, c, s, nt);
      const creatorDept = (await trx.selectFrom('users').select('department_id').where('id', '=', t.created_by).executeTakeFirst())?.department_id ?? null;
      await trx.updateTable('wl_tasks').set({ target_kind: nt.target_kind, assignee_id: nt.assignee_id, target_role_id: nt.target_role_id, target_department_id: nt.target_department_id,
        target_duty_role_id: nt.target_duty_role_id, department_id: nt.dept ?? creatorDept, claimed_by: null, claimed_at: null, reminded_at: null, status: 'open', updated_at: sql`now()` })
        .where('id', '=', id).execute();
      const from = { target_kind: t.target_kind, assignee_id: t.assignee_id, target_role_id: t.target_role_id, target_department_id: t.target_department_id, target_duty_role_id: t.target_duty_role_id, claimed_by: t.claimed_by };
      await this.ev(trx, id, 'reassigned', u, d.note?.trim() || null, { from, to: { ...nt, dept: undefined } });
      await this.audit.log(ctx, { action: 'WL_TASK_REASSIGN', entityName: 'wl_tasks', entityId: id, oldData: from, newData: { ...nt, note: d.note ?? null } }, trx);
      notify = s.notify_assign;
    });
    if (notify) await this.notifyTarget(id, u.id, 'დავალება გადმოგეცათ');
    return this.get(id, u, ctx);
  }

  async claim(id: string, u: AuthUser, ctx: AuditContext) {
    await this.act(id, u, ctx, 'claim', async (trx) => {
      await trx.updateTable('wl_tasks').set({ claimed_by: u.id, claimed_at: sql`now()`, updated_at: sql`now()` }).where('id', '=', id).execute();
      await this.ev(trx, id, 'claimed', u);
    });
    return this.get(id, u, ctx);
  }
  async release(id: string, note: string | null | undefined, u: AuthUser, ctx: AuditContext) {
    await this.act(id, u, ctx, 'release', async (trx) => {
      await trx.updateTable('wl_tasks').set({ claimed_by: null, claimed_at: null, status: 'open', updated_at: sql`now()` }).where('id', '=', id).execute();
      await this.ev(trx, id, 'released', u, note?.trim() || null);
    });
    return this.get(id, u, ctx);
  }
  async start(id: string, u: AuthUser, ctx: AuditContext) {
    await this.act(id, u, ctx, 'start', async (trx, t) => {
      const claim = t.target_kind !== 'user' && !t.claimed_by;
      await trx.updateTable('wl_tasks').set({ status: 'in_progress', started_at: sql`coalesce(started_at, now())`, updated_at: sql`now()`,
        ...(claim && { claimed_by: u.id, claimed_at: sql`now()` }) }).where('id', '=', id).execute();
      if (claim) await this.ev(trx, id, 'claimed', u);
      await this.ev(trx, id, 'started', u);
    });
    return this.get(id, u, ctx);
  }
  async done(id: string, note: string | null | undefined, u: AuthUser, ctx: AuditContext) {
    let creator: string | null = null; let notify = false;
    await this.act(id, u, ctx, 'done', async (trx, t, s, _c, member) => {
      const need = s.done_comment === 'all' || (s.done_comment === 'urgent' && t.priority === 'urgent');
      if (need && (note?.trim().length ?? 0) < 3) throw new BadRequestException({ code: 'WL_COMMENT_REQUIRED', message: 'შესრულების კომენტარი სავალდებულოა (მინ. 3 სიმბოლო)' });
      const claim = t.target_kind !== 'user' && !t.claimed_by && member;
      await trx.updateTable('wl_tasks').set({ status: 'done', done_at: sql`now()`, done_by: u.id, done_note: note?.trim() || null, started_at: sql`coalesce(started_at, now())`,
        updated_at: sql`now()`, ...(claim && { claimed_by: u.id, claimed_at: sql`now()` }) }).where('id', '=', id).execute();
      await this.ev(trx, id, 'done', u, note?.trim() || null);
      await this.audit.log(ctx, { action: 'WL_TASK_DONE', entityName: 'wl_tasks', entityId: id, newData: { note: note ?? null } }, trx);
      creator = t.created_by; notify = s.notify_done;
    });
    if (notify && creator && creator !== u.id) await this.bell([creator], id, 'შესრულდა', false);
    return this.get(id, u, ctx);
  }
  async cancel(id: string, reason: string, u: AuthUser, ctx: AuditContext) {
    let ids: string[] = []; let notify = false;
    await this.act(id, u, ctx, 'cancel', async (trx, t, s) => {
      await trx.updateTable('wl_tasks').set({ status: 'cancelled', cancelled_at: sql`now()`, cancelled_by: u.id, cancel_reason: reason.trim(), updated_at: sql`now()` }).where('id', '=', id).execute();
      await this.ev(trx, id, 'cancelled', u, reason.trim());
      await this.audit.log(ctx, { action: 'WL_TASK_CANCEL', entityName: 'wl_tasks', entityId: id, newData: { reason } }, trx);
      ids = [t.created_by, t.assignee_id, t.claimed_by].filter((x): x is string => !!x && x !== u.id); notify = s.notify_done;
    });
    if (notify && ids.length) await this.bell(ids, id, 'გაუქმდა', false);
    return this.get(id, u, ctx);
  }
  async reopen(id: string, reason: string, u: AuthUser, ctx: AuditContext) {
    await this.act(id, u, ctx, 'reopen', async (trx, t) => {
      await trx.updateTable('wl_tasks').set({ status: 'open', done_at: null, done_by: null, done_note: null, cancelled_at: null, cancelled_by: null, cancel_reason: null,
        reminded_at: null, escalated_at: null, updated_at: sql`now()` }).where('id', '=', id).execute();
      await this.ev(trx, id, 'reopened', u, reason.trim(), { from: t.status });
      await this.audit.log(ctx, { action: 'WL_TASK_REOPEN', entityName: 'wl_tasks', entityId: id, oldData: { status: t.status }, newData: { reason } }, trx);
    });
    await this.notifyTarget(id, u.id, 'ხელახლა გაიხსნა');
    return this.get(id, u, ctx);
  }
  async comment(id: string, note: string, u: AuthUser, ctx: AuditContext) {
    let ids: string[] = [];
    await this.act(id, u, ctx, 'comment', async (trx, t) => {
      await this.ev(trx, id, 'comment', u, note.trim());
      ids = [t.created_by, t.assignee_id, t.claimed_by].filter((x): x is string => !!x && x !== u.id);
    });
    if (ids.length) await this.bell([...new Set(ids)], id, 'კომენტარი', false);
    return this.get(id, u, ctx);
  }

  // ------------------------------------------------------------------ შეტყობინებები
  /** სამიზნის მიმღებები: პირი; როლი (+ განყოფილება) — როლის აქტიური მომხმარებლები; განყოფილება — წევრები; მორიგე — ახლა მორიგეები. ≤ 200 */
  async recipients(ex: Ex, t: { target_kind: string; assignee_id: string | null; claimed_by: string | null; target_role_id: string | null; target_department_id: string | null; target_duty_role_id: string | null },
    at: Date | null = null): Promise<string[]> {
    if (t.target_kind === 'user') return t.assignee_id ? [t.assignee_id] : [];
    if (t.claimed_by) return [t.claimed_by];
    const memberOf = (dep: string) => sql<boolean>`(u.department_id = ${dep}::uuid OR EXISTS (SELECT 1 FROM staff_members s WHERE s.user_id = u.id AND s.is_active
        AND (s.department_id = ${dep}::uuid OR EXISTS (SELECT 1 FROM staff_member_departments x WHERE x.staff_id = s.id AND x.department_id = ${dep}::uuid))))`;
    let r: { rows: { id: string }[] };
    if (t.target_kind === 'duty') {
      r = await sql<{ id: string }>`SELECT DISTINCT s.user_id AS id FROM roster_entries e JOIN rosters ro ON ro.id = e.roster_id JOIN staff_members s ON s.id = e.staff_id
        JOIN users u ON u.id = s.user_id
       WHERE e.duty_role_id = ${t.target_duty_role_id}::uuid AND e.status = 'active' AND ro.status IN ('published', 'closed') AND u.is_active
         AND e.starts_at <= coalesce(${at}::timestamptz, now()) AND e.ends_at > coalesce(${at}::timestamptz, now()) LIMIT 200`.execute(ex);
    } else if (t.target_kind === 'department') {
      r = await sql<{ id: string }>`SELECT u.id FROM users u WHERE u.is_active AND ${memberOf(t.target_department_id!)} LIMIT 200`.execute(ex);
    } else {
      r = await sql<{ id: string }>`SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id
        WHERE u.is_active AND ur.role_id = ${t.target_role_id}::uuid ${t.target_kind === 'role_department' ? sql`AND ${memberOf(t.target_department_id!)}` : sql``} LIMIT 200`.execute(ex);
    }
    return r.rows.map((x) => x.id);
  }
  async bell(ids: string[], taskId: string, what: string, urgent: boolean, body?: string) {
    const t = await this.db.selectFrom('wl_tasks').select(['task_no', 'title', 'priority', 'due_at']).where('id', '=', taskId).executeTakeFirst();
    if (!t) return;
    const due = t.due_at ? new Intl.DateTimeFormat('ka-GE', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(t.due_at)) : null;
    for (const id of [...new Set(ids)]) {
      try {
        await this.notifications.notify(id, { kind: 'wl_task', title: `დავალება ${t.task_no}: ${t.title}`.slice(0, 300),
          body: body ?? `${what}${t.priority !== 'normal' ? ` · ${PRIORITY_KA[t.priority as Priority]}` : ''}${due ? ` · ვადა ${due}` : ''}`, link: `/tasks?task=${taskId}`, entityId: taskId, item: what,
          urgent: urgent || t.priority === 'urgent' });
      } catch (e) { this.log.warn(`შეტყობინება: ${(e as Error).message}`); }
    }
  }
  private async notifyTarget(id: string, actor: string, what: string) {
    const t = await this.db.selectFrom('wl_tasks').selectAll().where('id', '=', id).executeTakeFirst();
    if (!t) return;
    const ids = (await this.recipients(this.db, t)).filter((x) => x !== actor);
    if (ids.length) await this.bell(ids, id, what, false);
  }
}
