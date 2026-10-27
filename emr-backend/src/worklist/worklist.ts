import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsISO8601, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser, type Role } from '../auth/roles';
import { InjectDb, type Database } from '../database/database.module';
import { PRI_RANK, SOURCES, TARGET_KA, enabledModules, isAll, manageDepts, memberDepts, wlSettings, type WlItem } from './worklist-common';
import { WorklistJobsService } from './worklist-jobs';
import { WorklistSources } from './worklist-sources';
import { WorklistTasksService, countCache, type ListQ, type TargetKind } from './worklist-tasks';

const PATIENT_LOOKUP: Role[] = ['admin', 'receptionist', 'doctor', 'nurse', 'billing', 'diagnostic', 'manager', 'radiographer', 'radiologist',
  'endoscopist', 'endoscopy_nurse', 'phlebotomist', 'lab_doctor', 'anesthesiologist', 'or_nurse', 'or_schedule', 'pharmacist', 'quality'];
const CACHE_MS = 30_000;

/**
 * სამუშაო სიები (D5, 0081): „ჩემი დავალებები“ = სისტემური წყაროები (worklist-sources) + ხელით შექმნილი (worklist-tasks);
 * მთვლელი (30 წმ კეში), ცნობარები, კატეგორიები, ხელმძღვანელის ხედის აგრეგატები.
 */
@Injectable()
export class WorklistService {
  constructor(@InjectDb() private readonly db: Database, private readonly sources: WorklistSources, private readonly tasks: WorklistTasksService,
    private readonly audit: AuditService) {}

  private sort(a: WlItem, b: WlItem) {
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    if (a.priority !== b.priority) return PRI_RANK[a.priority] - PRI_RANK[b.priority];
    const da = a.due_at ? Date.parse(a.due_at) : Infinity; const db = b.due_at ? Date.parse(b.due_at) : Infinity;
    if (da !== db) return da - db;
    return (a.created_at ?? '').localeCompare(b.created_at ?? '');
  }

  async mine(u: AuthUser, q: { source?: string; overdue?: string }) {
    const s = await this.tasks.settings();
    const mods = await enabledModules(this.db);
    const [sys, own] = await Promise.all([
      q.source === 'task' ? Promise.resolve([] as WlItem[]) : this.sources.items(u, { modules: mods, sources: s.sources }, q.source),
      q.source && q.source !== 'task' ? Promise.resolve([] as WlItem[]) : this.tasks.mineItems(u),
    ]);
    let items = [...own, ...sys].sort((a, b) => this.sort(a, b));
    const summary = new Map<string, { source: string; group: string; name: string; count: number; overdue: number }>();
    for (const x of items) {
      const k = summary.get(x.source) ?? { source: x.source, group: x.group, name: x.source === 'task' ? 'ხელით შექმნილი დავალებები' : SOURCES[x.source]?.name ?? x.source, count: 0, overdue: 0 };
      k.count++; if (x.overdue) k.overdue++; summary.set(x.source, k);
    }
    if (q.overdue === '1') items = items.filter((x) => x.overdue);
    const totals = { total: items.length, overdue: items.filter((x) => x.overdue).length, urgent: items.filter((x) => x.priority === 'urgent').length };
    countCache.set(u.id, { t: Date.now(), v: totals });
    return { generated_at: new Date().toISOString(), refresh_seconds: s.refresh_seconds, totals, sources: [...summary.values()], items };
  }

  /** მთვლელი (Shell): 30 წმ კეში; გამორთულ მოდულზე / badge = off — ნულები */
  async count(u: AuthUser) {
    const m = await wlSettings(this.db);
    if (!m.enabled || m.s.badge === 'off') return { total: 0, overdue: 0, urgent: 0, badge: m.enabled ? m.s.badge : 'off', enabled: m.enabled };
    const c = countCache.get(u.id);
    if (c && Date.now() - c.t < CACHE_MS) return { ...c.v, badge: m.s.badge, enabled: true };
    const r = await this.mine(u, {});
    return { ...r.totals, badge: m.s.badge, enabled: true };
  }

  async refs(u: AuthUser) {
    const s = await this.tasks.settings();
    const mods = await enabledModules(this.db);
    const [cats, roles, depts, duty, manage, member] = await Promise.all([
      this.db.selectFrom('wl_categories as k').leftJoin('roles as r', 'r.id', 'k.default_role_id').leftJoin('departments as d', 'd.id', 'k.default_department_id')
        .select(['k.id', 'k.code', 'k.name', 'k.description', 'k.default_target_kind', 'k.default_role_id', 'k.default_department_id', 'r.name as default_role_name',
          'd.name as default_department_name', 'k.sla_hours', 'k.allow_patient', 'k.is_active', 'k.sort_order'])
        .orderBy('k.sort_order').orderBy('k.name').execute(),
      this.db.selectFrom('roles').select(['id', 'code', 'name']).where('is_active', '=', true).orderBy('sort_order').orderBy('name').execute(),
      this.db.selectFrom('departments').select(['id', 'name', 'type']).where('is_active', '=', true).orderBy('name').execute(),
      mods.has('roster') ? this.db.selectFrom('duty_roles as r').leftJoin('departments as d', 'd.id', 'r.department_id').select(['r.id', 'r.name', 'd.name as department_name'])
        .where('r.is_active', '=', true).orderBy('r.sort_order').orderBy('r.name').execute() : Promise.resolve([]),
      manageDepts(this.db, u), memberDepts(this.db, u.id),
    ]);
    const all = isAll(u);
    return {
      settings: { assign_scope: s.assign_scope, done_comment: s.done_comment, reopen_days: s.reopen_days, patient_tasks: s.patient_tasks, refresh_seconds: s.refresh_seconds,
        badge: s.badge, escalate_hours: s.escalate_hours, due_default_hours: s.due_default_hours },
      can: { team: all || manage.length > 0, all, categories: all, patients: has(u, ...PATIENT_LOOKUP) && s.patient_tasks, run_jobs: has(u, 'admin') },
      team_departments: all ? depts.map((d) => d.id) : manage, my_departments: member,
      categories: cats, roles, departments: depts, duty_roles: duty, targets: TARGET_KA,
      sources: Object.entries(SOURCES).map(([code, x]) => ({ code, ...x, enabled: s.sources[code] !== false, module_enabled: mods.has(x.module) })),
    };
  }

  /** ხელმძღვანელის ხედი: დავალებები + აგრეგატები განყოფილებით / შემსრულებლით */
  async team(u: AuthUser, q: ListQ) {
    const rows = await this.tasks.list(u, { ...q, box: 'team', status: q.status ?? 'active' });
    const by = new Map<string, { department_id: string | null; department_name: string | null; open: number; overdue: number; urgent: number; unclaimed: number }>();
    const people = new Map<string, { name: string; open: number; overdue: number }>();
    for (const r of rows) {
      if (r.status !== 'open' && r.status !== 'in_progress') continue;
      const k = r.department_id ?? '—';
      const d = by.get(k) ?? { department_id: r.department_id, department_name: r.department_name, open: 0, overdue: 0, urgent: 0, unclaimed: 0 };
      d.open++; if (r.overdue) d.overdue++; if (r.priority === 'urgent') d.urgent++; if (r.group && !r.claimed_by) d.unclaimed++;
      by.set(k, d);
      const who = r.claimed_by ?? r.assignee_id;
      if (who) { const p = people.get(who) ?? { name: (r.claimed_by ? r.claimed_by_name : r.assignee_name) ?? '—', open: 0, overdue: 0 }; p.open++; if (r.overdue) p.overdue++; people.set(who, p); }
    }
    const mg = isAll(u) ? null : await manageDepts(this.db, u);
    const done7 = await this.db.selectFrom('wl_tasks').select(sql<number>`count(*)::int`.as('n')).where('status', '=', 'done').where('done_at', '>', sql<Date>`now() - interval '7 days'`)
      .$if(!!mg, (x) => x.where('department_id', 'in', mg!.length ? mg! : ['00000000-0000-0000-0000-000000000000']))
      .$if(!!q.department_id, (x) => x.where('department_id', '=', q.department_id!)).executeTakeFirstOrThrow();
    return { tasks: rows, done_7d: done7.n, departments: [...by.values()].sort((a, b) => b.overdue - a.overdue || b.open - a.open),
      assignees: [...people.entries()].map(([id, p]) => ({ user_id: id, ...p })).sort((a, b) => b.overdue - a.overdue || b.open - a.open) };
  }

  // ------------------------------------------------------------------ კატეგორიები
  async saveCategory(id: string | null, d: CategoryDto, u: AuthUser, req: Request) {
    if (!isAll(u)) throw new ForbiddenException('კატეგორიები — worklist_all / admin');
    const kind = d.default_target_kind ?? null;
    const role = kind === 'role' || kind === 'role_department' ? d.default_role_id ?? null : null;
    const dep = kind === 'department' || kind === 'role_department' ? d.default_department_id ?? null : null;
    if (kind && ((kind !== 'department' && !role) || (kind !== 'role' && !dep))) throw new BadRequestException('ნაგულისხმევი სამიზნე: როლი / განყოფილება სავალდებულოა');
    const vals = { ...(d.name !== undefined && { name: d.name.trim() }), ...(d.description !== undefined && { description: d.description?.trim() || null }),
      ...(d.default_target_kind !== undefined && { default_target_kind: kind, default_role_id: role, default_department_id: dep }),
      ...(d.sla_hours !== undefined && { sla_hours: d.sla_hours }), ...(d.allow_patient !== undefined && { allow_patient: d.allow_patient }),
      ...(d.is_active !== undefined && { is_active: d.is_active }), ...(d.sort_order !== undefined && { sort_order: d.sort_order }) };
    const res = await this.db.transaction().execute(async (trx) => {
      if (id) {
        const old = await trx.selectFrom('wl_categories').selectAll().where('id', '=', id).executeTakeFirst();
        if (!old) throw new NotFoundException('კატეგორია ვერ მოიძებნა');
        await trx.updateTable('wl_categories').set({ ...vals, updated_at: sql`now()` }).where('id', '=', id).execute();
        await this.audit.log(auditCtx(req), { action: 'WL_CATEGORY_UPDATE', entityName: 'wl_categories', entityId: id, oldData: old, newData: vals }, trx);
        return id;
      }
      if (!d.code || !d.name) throw new BadRequestException('code, name — სავალდებულოა');
      if (await trx.selectFrom('wl_categories').select('id').where('code', '=', d.code).executeTakeFirst()) throw new BadRequestException('კოდი უკვე არსებობს');
      const r = await trx.insertInto('wl_categories').values({ code: d.code, name: d.name.trim(), description: d.description?.trim() || null, default_target_kind: kind, default_role_id: role,
        default_department_id: dep, sla_hours: d.sla_hours ?? null, allow_patient: d.allow_patient ?? true, sort_order: d.sort_order ?? 100 }).returning('id').executeTakeFirstOrThrow();
      await this.audit.log(auditCtx(req), { action: 'WL_CATEGORY_CREATE', entityName: 'wl_categories', entityId: r.id, newData: vals }, trx);
      return r.id;
    });
    return this.db.selectFrom('wl_categories').selectAll().where('id', '=', res).executeTakeFirstOrThrow();
  }

  people(search?: string) {
    const s = search?.trim();
    return this.db.selectFrom('users as u').leftJoin('departments as d', 'd.id', 'u.department_id')
      .select(['u.id', sql<string>`u.last_name || ' ' || u.first_name`.as('name'), 'd.name as department_name'])
      .where('u.is_active', '=', true)
      .$if(!!s, (x) => x.where(sql<boolean>`(u.first_name || ' ' || u.last_name) ILIKE ${`%${s}%`} OR (u.last_name || ' ' || u.first_name) ILIKE ${`%${s}%`}`))
      .orderBy('u.last_name').limit(30).execute();
  }
  async patients(q?: string) {
    const s = q?.trim() ?? '';
    if (s.length < 2) return [];
    return this.db.selectFrom('patients as p').select(['p.id', sql<string>`p.last_name || ' ' || p.first_name`.as('name'), 'p.personal_number', 'p.birth_date'])
      .where(sql<boolean>`(p.personal_number LIKE ${`${s}%`} OR (p.last_name || ' ' || p.first_name) ILIKE ${`%${s}%`})`).orderBy('p.last_name').limit(20).execute();
  }
}

// ======================================================================= DTO
const TARGETS = ['user', 'role', 'department', 'role_department', 'duty'];
const PRI = ['normal', 'high', 'urgent'];
class TargetDto {
  @IsIn(TARGETS) target_kind: TargetKind;
  @IsOptional() @IsUUID() assignee_id?: string | null; @IsOptional() @IsUUID() target_role_id?: string | null;
  @IsOptional() @IsUUID() target_department_id?: string | null; @IsOptional() @IsUUID() target_duty_role_id?: string | null;
}
class CreateDto {
  @IsString() @Length(3, 200) title: string; @IsOptional() @IsString() @MaxLength(4000) description?: string | null;
  @IsOptional() @IsUUID() category_id?: string | null; @IsOptional() @IsIn(PRI) priority?: 'normal' | 'high' | 'urgent';
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsISO8601() due_at?: string | null;
  @IsOptional() @IsIn(TARGETS) target_kind: TargetKind;
  @IsOptional() @IsUUID() assignee_id?: string | null; @IsOptional() @IsUUID() target_role_id?: string | null;
  @IsOptional() @IsUUID() target_department_id?: string | null; @IsOptional() @IsUUID() target_duty_role_id?: string | null;
  @IsOptional() @IsUUID() patient_id?: string | null; @IsOptional() @IsUUID() encounter_id?: string | null;
}
class EditDto {
  @IsOptional() @IsString() @Length(3, 200) title?: string; @IsOptional() @IsString() @MaxLength(4000) description?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() category_id?: string | null; @IsOptional() @IsIn(PRI) priority?: 'normal' | 'high' | 'urgent';
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsISO8601() due_at?: string | null;
}
class ReassignDto extends TargetDto { @IsOptional() @IsString() @MaxLength(500) note?: string | null }
class NoteDto { @IsOptional() @IsString() @MaxLength(2000) note?: string | null }
class ReasonDto { @IsString() @Length(3, 500) reason: string }
class CommentDto { @IsString() @Length(1, 2000) note: string }
class CategoryDto {
  @IsOptional() @Matches(/^[A-Z][A-Z0-9_]{1,19}$/) code?: string; @IsOptional() @IsString() @Length(2, 100) name?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsIn(['department', 'role', 'role_department']) default_target_kind?: 'department' | 'role' | 'role_department' | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() default_role_id?: string | null; @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() default_department_id?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) @Max(2160) sla_hours?: number | null;
  @IsOptional() @IsBoolean() allow_patient?: boolean; @IsOptional() @IsBoolean() is_active?: boolean; @IsOptional() @IsInt() @Type(() => Number) sort_order?: number;
}
class RunDto { @IsOptional() @IsISO8601() at?: string; @IsOptional() @IsArray() @IsUUID('all', { each: true }) task_ids?: string[] }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const checkQ = (q: ListQ) => {
  for (const k of ['department_id', 'patient_id', 'category_id'] as const) if (q[k] && !UUID_RE.test(q[k]!)) throw new BadRequestException(k);
  if (q.assignee_id && q.assignee_id !== 'none' && !UUID_RE.test(q.assignee_id)) throw new BadRequestException('assignee_id');
  if (q.target_kind && !TARGETS.includes(q.target_kind)) throw new BadRequestException('target_kind');
  return q;
};

/** ყველა შესულ მომხმარებელს (ხილვადობას / ქმედებას სერვისი ამოწმებს) */
@Controller('worklist')
export class WorklistController {
  constructor(private readonly s: WorklistService, private readonly t: WorklistTasksService, private readonly jobs: WorklistJobsService) {}
  @Get('refs') refs(@CurrentUser() u: AuthUser) { return this.s.refs(u); }
  @Get('mine') mine(@CurrentUser() u: AuthUser, @Query('source') source?: string, @Query('overdue') overdue?: string) {
    if (source && source !== 'task' && !SOURCES[source]) throw new BadRequestException('source');
    return this.s.mine(u, { source, overdue });
  }
  @Get('count') count(@CurrentUser() u: AuthUser) { return this.s.count(u); }
  @Get('team') team(@CurrentUser() u: AuthUser, @Query() q: ListQ) { return this.s.team(u, checkQ(q)); }
  @Get('people') people(@Query('search') search?: string) { return this.s.people(search); }
  @Get('patients') @Roles(...PATIENT_LOOKUP) patients(@Query('q') q?: string) { return this.s.patients(q); }
  @Get('categories') categories(@CurrentUser() u: AuthUser) { return this.s.refs(u).then((r) => r.categories); }
  @Post('categories') category(@Body() d: CategoryDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.saveCategory(null, d, u, r); }
  @Patch('categories/:id') categoryPatch(@Param('id', ParseUUIDPipe) id: string, @Body() d: CategoryDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.saveCategory(id, d, u, r); }
  @Get('tasks') list(@CurrentUser() u: AuthUser, @Query() q: ListQ) { return this.t.list(u, checkQ(q)); }
  @Get('tasks/:id') one(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.t.get(id, u, auditCtx(r)); }
  @Post('tasks') create(@Body() d: CreateDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.t.create(d, u, auditCtx(r)); }
  @Patch('tasks/:id') edit(@Param('id', ParseUUIDPipe) id: string, @Body() d: EditDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.t.edit(id, d, u, auditCtx(r)); }
  @Post('tasks/:id/reassign') @HttpCode(200) reassign(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReassignDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.t.reassign(id, d, u, auditCtx(r)); }
  @Post('tasks/:id/claim') @HttpCode(200) claim(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.t.claim(id, u, auditCtx(r)); }
  @Post('tasks/:id/release') @HttpCode(200) release(@Param('id', ParseUUIDPipe) id: string, @Body() d: NoteDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.t.release(id, d?.note, u, auditCtx(r)); }
  @Post('tasks/:id/start') @HttpCode(200) start(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.t.start(id, u, auditCtx(r)); }
  @Post('tasks/:id/done') @HttpCode(200) done(@Param('id', ParseUUIDPipe) id: string, @Body() d: NoteDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.t.done(id, d?.note, u, auditCtx(r)); }
  @Post('tasks/:id/cancel') @HttpCode(200) cancel(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.t.cancel(id, d.reason, u, auditCtx(r)); }
  @Post('tasks/:id/reopen') @HttpCode(200) reopen(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.t.reopen(id, d.reason, u, auditCtx(r)); }
  @Post('tasks/:id/comment') @HttpCode(200) comment(@Param('id', ParseUUIDPipe) id: string, @Body() d: CommentDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.t.comment(id, d.note, u, auditCtx(r)); }
  @Post('run-jobs') @HttpCode(200) @Roles('admin') run(@Body() d: RunDto) { return this.jobs.tick(d ?? {}); }
}
