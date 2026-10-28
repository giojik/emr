import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsISO8601, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import type { Request } from 'express';
import { sql, type RawBuilder } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser, type Role } from '../auth/roles';
import { InjectDb, type Database } from '../database/database.module';
import { abxPolicy } from '../ipc/ipc-common';
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

  async mine(u: AuthUser, q: { source?: string; overdue?: string }, noCache = false) {
    const s = await this.tasks.settings();
    const mods = await enabledModules(this.db);
    const [sys, own] = await Promise.all([
      q.source === 'task' ? Promise.resolve([] as WlItem[]) : this.sources.items(u, { modules: mods, sources: s.sources, settings: s }, q.source),
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
    if (!noCache && !q.source && q.overdue !== '1') countCache.set(u.id, { t: Date.now(), v: totals });   // 0082: მთვლელის ქეში — მხოლოდ ფილტრის გარეშე სიიდან
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

  // ------------------------------------------------------------------ 0082b: შემოწმება (admin / worklist_all, მხოლოდ წაკითხვა)
  /** სხვა მომხმარებლის „ჩემი დავალებები“ — იმავე წესით, რაც მას თავად უჩანს (კონფიგურაციის შესამოწმებლად); აუდიტი WL_PREVIEW */
  async preview(userId: string, u: AuthUser, req: Request) {
    const t = (await sql<{ id: string; role: string | null; is_active: boolean; is_section_head: boolean; email: string; capabilities: string[] | null; department_name: string | null; name: string }>`
      SELECT x.id, x.role::text AS role, x.is_active, x.is_section_head, x.email, c.capabilities, d.name AS department_name, x.last_name || ' ' || x.first_name AS name
        FROM users x LEFT JOIN user_capabilities c ON c.user_id = x.id LEFT JOIN departments d ON d.id = x.department_id WHERE x.id = ${userId}`.execute(this.db)).rows[0];
    if (!t) throw new NotFoundException('მომხმარებელი ვერ მოიძებნა');
    const target: AuthUser = { id: t.id, role: t.role ?? '', caps: (t.capabilities ?? []) as Role[], name: t.name, mustChangePassword: false };
    const r = await this.mine(target, {}, true);
    await this.audit.log(auditCtx(req), { action: 'WL_PREVIEW', entityName: 'users', entityId: t.id, newData: { by: u.id, total: r.totals.total } });
    return { user: { id: t.id, name: t.name, email: t.email, is_active: t.is_active, is_section_head: t.is_section_head, department_name: t.department_name, caps: target.caps },
      totals: r.totals, sources: r.sources, items: r.items };
  }

  /** კონფიგურაციის ხარვეზები, რომლებზეც სისტემური ჩანაწერის ადრესატი დგას (A1 / B1) */
  async diagnostics(includeTest = false) {
    const REAL = includeTest ? sql`TRUE` : sql`u.email NOT LIKE '%@test.local'`;
    const mods = await enabledModules(this.db);
    const out: { level: 'error' | 'warn' | 'info'; code: string; message: string; total: number; items: string[] }[] = [];
    const push = (level: 'error' | 'warn' | 'info', code: string, message: string, items: string[]) => { if (items.length) out.push({ level, code, message, total: items.length, items: items.slice(0, 50) }); }   // უახლესი — ზემოთ; ≤ 50;
    const q = async (x: RawBuilder<unknown>) => ((await x.execute(this.db)).rows as { n: string }[]).map((r) => r.n);
    const HEAD = sql`(u.is_section_head OR 'manager' = ANY (coalesce(c.capabilities, '{}')))`;
    // განყოფილების ქვესაწყობი, რომლის განყოფილებას ხელმძღვანელი არ ჰყავს → RQ-ს ვერავინ ამტკიცებს (admin-ის გარდა)
    push('error', 'NO_HEAD_APPROVE', 'განყოფილების ქვესაწყობი „დამტკიცება საჭიროა“, მაგრამ განყოფილებას ხელმძღვანელი არ ჰყავს — მოთხოვნას (RQ) მხოლოდ admin ამტკიცებს და ის არავის სიაში ჩანს',
      await q(sql`SELECT l.name || ' (' || d.name || ')' AS n FROM stock_locations l JOIN departments d ON d.id = l.department_id
        WHERE l.is_active AND d.is_active AND (${includeTest} OR l.name NOT LIKE 'ტესტ-E2E%') AND l.requires_approval AND l.kind NOT IN ('lab', 'transit') AND NOT EXISTS (SELECT 1 FROM users u LEFT JOIN user_capabilities c ON c.user_id = u.id
          WHERE u.is_active AND ${REAL} AND u.department_id = d.id AND ${HEAD}) ORDER BY l.created_at DESC, 1`));
    push('warn', 'NO_HEAD', 'აქტიური განყოფილება ხელმძღვანელის გარეშე — dept_side = heads-ზე ჩანაწერს (მიღება, CSSD, გეგმიური) განყოფილების ყველა წევრი ხედავს',
      await q(sql`SELECT d.name AS n FROM departments d WHERE d.is_active AND (${includeTest} OR d.name NOT LIKE 'ტესტ-E2E%') AND EXISTS (SELECT 1 FROM users u WHERE u.is_active AND ${REAL} AND u.department_id = d.id)
        AND NOT EXISTS (SELECT 1 FROM users u LEFT JOIN user_capabilities c ON c.user_id = u.id WHERE u.is_active AND ${REAL} AND u.department_id = d.id AND ${HEAD}) ORDER BY d.created_at DESC, 1`));
    push('warn', 'LOC_NO_MEMBERS', 'განყოფილების ლოკაცია, რომლის განყოფილებას აქტიური წევრი არ ჰყავს — მიღება საწყობის მენეჯერთან გადადის',
      await q(sql`SELECT l.name || ' (' || d.name || ')' AS n FROM stock_locations l JOIN departments d ON d.id = l.department_id
        WHERE l.is_active AND (${includeTest} OR l.name NOT LIKE 'ტესტ-E2E%') AND l.kind NOT IN ('lab', 'cssd', 'pharmacy', 'transit') AND NOT EXISTS (SELECT 1 FROM users u WHERE u.is_active AND ${REAL} AND u.department_id = d.id)
          AND NOT EXISTS (SELECT 1 FROM staff_members s JOIN users u ON u.id = s.user_id WHERE s.is_active AND u.is_active AND ${REAL} AND s.department_id = d.id) ORDER BY l.created_at DESC, 1`));
    push('warn', 'CSSD_NO_STAFF', 'CSSD ერთეული, რომლის განყოფილებაში აქტიური თანამშრომელი არ არის — BI / Bowie-Dick არავის სიაში ჩანს',
      await q(sql`SELECT l.name AS n FROM stock_locations l WHERE l.is_active AND (${includeTest} OR l.name NOT LIKE 'ტესტ-E2E%') AND l.kind = 'cssd'
        AND (l.department_id IS NULL OR NOT EXISTS (SELECT 1 FROM users u WHERE u.is_active AND ${REAL} AND u.department_id = l.department_id)) ORDER BY l.created_at DESC, 1`));
    push('warn', 'CLINICAL_NO_DEPT', 'ექთანი / ექიმი განყოფილების გარეშე — განყოფილების ჩანაწერებს (მიღება, მინიმუმი, CSSD, გეგმიური) ვერ მიიღებს',
      await q(sql`SELECT u.last_name || ' ' || u.first_name || ' <' || u.email || '>' AS n FROM users u JOIN user_capabilities c ON c.user_id = u.id
        WHERE u.is_active AND u.department_id IS NULL AND c.capabilities && ARRAY['nurse', 'doctor']::varchar[] AND ${REAL} ORDER BY u.created_at DESC, 1`));
    // ადრესატის გარეშე დარჩენილი უფლებები (ჩართული მოდულით)
    const capNeed: [string, string, string][] = [['stock', 'storekeeper', 'მესაწყობე — საწყობის გაცემა / მიღება'], ['stock', 'stock_manager', 'საწყობის მენეჯერი — ჩამოწერა, ინვენტარიზაცია, PR L1'],
      ['stock', 'pharmacist', 'ფარმაცევტი — ცარიელი ამპულა, აფთიაქის გაცემა'], ['procurement', 'procurement', 'შესყიდვები — PR → PO, ვადაგადაცილებული PO'],
      ['procurement', 'procurement_approve', 'ფინანსური დამტკიცება — PR / PO ზღვარს ზემოთ'], ['procurement', 'accountant', 'ბუღალტერი — ინვოისები, ქლეიმები, პერიოდი'],
      ['inpatient', 'billing', 'ბილინგი — ფინალიზაცია, ქლეიმის დანაკლისი'], ['tariffs', 'tariffs_approve', 'ტარიფის დამტკიცება (approval = required)'], ['core', 'receptionist', 'რეგისტრატორი — ჩაწერა, გეგმიური, ვალი'],
      // 0083: კლინიკური
      ['inpatient', 'doctor', 'ექიმი — დოკუმენტაცია, დანიშნულებები, კონსულტაცია, NEWS2'], ['inpatient', 'nurse', 'ექთანი — MAR, შკალები, ვიტალები, გადაბარება'],
      ['or', 'anesthesiologist', 'ანესთეზიოლოგი — წინასაოპერაციო შეფასება, ანესთეზიის რუკა, PACU'], ['or', 'or_nurse', 'საოპერაციო ექთანი — PACU']];
    const caps = new Set((await sql<{ c: string }>`SELECT DISTINCT unnest(c.capabilities) AS c FROM user_capabilities c JOIN users u ON u.id = c.user_id
      WHERE u.is_active AND ${REAL}`.execute(this.db)).rows.map((r) => r.c));
    push('info', 'NO_CAP', 'აქტიური მომხმარებელი ამ უფლებით არ არის — შესაბამისი წყაროები არავის სიაში ჩანს', capNeed.filter(([m, c]) => mods.has(m) && !caps.has(c)).map(([, c, d]) => `${c} — ${d}`));
    // ---- 0083: კლინიკური წყაროების ადრესატები
    const INPD = sql`d.is_active AND d.type = 'inpatient' AND (${includeTest} OR d.name NOT LIKE 'ტესტ-E2E%') AND EXISTS (SELECT 1 FROM beds b JOIN wards w ON w.id = b.ward_id WHERE w.department_id = d.id AND b.is_active)`;
    const headOf = (cap: string) => sql`EXISTS (SELECT 1 FROM users u JOIN user_capabilities c ON c.user_id = u.id WHERE u.is_active AND ${REAL} AND u.department_id = d.id
      AND ${cap} = ANY (c.capabilities) AND (u.is_section_head OR 'manager' = ANY (c.capabilities)))`;
    if (mods.has('inpatient')) {
      const ipd = ((await this.db.selectFrom('system_modules').select('settings').where('code', '=', 'inpatient').executeTakeFirst())?.settings ?? {}) as Record<string, unknown>;
      const hasCap = (c: string) => caps.has(c);
      const mode = (ipd.med_verifier as string) ?? 'both';
      if ((ipd.med_verification ?? 'high_risk') !== 'off' && (mode === 'pharmacist' ? !hasCap('pharmacist') : mode === 'head_nurse' || !hasCap('pharmacist'))) {
        push('error', 'NO_VERIFIER', `დანიშნულების ვერიფიკაცია (med_verifier = ${mode}) — დამდასტურებელი არ არის: ${mode === 'pharmacist' ? 'ფარმაცევტი' : 'განყოფილების მთავარი ექთანი (ფარმაცევტიც არ არის)'} — დანიშნულება არავის სიაში ჩანს`,
          mode === 'pharmacist' ? ['pharmacist — აქტიური მომხმარებელი არ არის'] : await q(sql`SELECT d.name AS n FROM departments d WHERE ${INPD} AND NOT EXISTS (SELECT 1 FROM users u JOIN user_capabilities c ON c.user_id = u.id
            WHERE u.is_active AND ${REAL} AND u.department_id = d.id AND 'nurse' = ANY (c.capabilities) AND u.is_section_head) ORDER BY d.created_at DESC, 1`));
      }
      const pol = await abxPolicy(this.db);
      if (pol.restrict_mode !== 'off') {
        const noInf = !hasCap('infection'); const noPh = !hasCap('pharmacist');
        if (pol.approver === 'ipc' && noInf) push('error', 'NO_ABX_APPROVER', 'შეზღუდული ანტიბიოტიკის დამტკიცება (abx_approver = ipc) — ინფექციის კონტროლის (infection) მომხმარებელი არ არის', ['infection']);
        else if (pol.approver !== 'ipc' && noPh && (pol.approver === 'department' || noInf)) push('error', 'NO_ABX_APPROVER',
          `შეზღუდული ანტიბიოტიკის დამტკიცება (abx_approver = ${pol.approver}) — ფარმაცევტი არ არის და განყოფილებას ხელმძღვანელი ექიმი არ ჰყავს`,
          await q(sql`SELECT d.name AS n FROM departments d WHERE ${INPD} AND NOT ${headOf('doctor')} ORDER BY d.created_at DESC, 1`));
      }
      if (ipd.epicrisis_cosign === true) push('error', 'NO_EPI_COSIGNER', 'ეპიკრიზის თანახელმოწერა ჩართულია, მაგრამ განყოფილებას ხელმძღვანელი ექიმი არ ჰყავს — ეპიკრიზი არავის სიაში ჩანს',
        await q(sql`SELECT d.name AS n FROM departments d WHERE ${INPD} AND NOT ${headOf('doctor')} ORDER BY d.created_at DESC, 1`));
      push('warn', 'NO_ATTENDING', 'აქტიური ჰოსპიტალიზაცია მკურნალი ექიმის გარეშე / მკურნალი არააქტიურია — ექიმის ჩანაწერები ხელმძღვანელთან / განყოფილების ექიმებთან მიდის',
        await q(sql`SELECT st.adm_no || ' — ' || p.last_name || ' ' || p.first_name AS n FROM inpatient_stays st JOIN encounters e ON e.id = st.encounter_id JOIN patients p ON p.id = st.patient_id
          LEFT JOIN users au ON au.id = e.attending_doctor_id WHERE st.status = 'active' AND (${includeTest} OR p.last_name NOT LIKE 'ტესტ-E2E%') AND (au.id IS NULL OR NOT au.is_active)
          ORDER BY st.admitted_at DESC, 1`));
      push('warn', 'DEPT_NO_NURSE', 'საწოლიანი განყოფილება აქტიური ექთნის გარეშე (users.department_id) — MAR / შკალები / ვიტალები არავის სიაში ჩანს',
        await q(sql`SELECT d.name AS n FROM departments d WHERE ${INPD} AND NOT EXISTS (SELECT 1 FROM users u JOIN user_capabilities c ON c.user_id = u.id
          WHERE u.is_active AND ${REAL} AND u.department_id = d.id AND 'nurse' = ANY (c.capabilities)) ORDER BY d.created_at DESC, 1`));
    }
    if (mods.has('or')) {
      const or = ((await this.db.selectFrom('system_modules').select('settings').where('code', '=', 'or').executeTakeFirst())?.settings ?? {}) as Record<string, unknown>;
      if ((or.or_scheduling ?? 'coordinator') === 'coordinator' && !caps.has('or_schedule'))
        push('error', 'NO_OR_SCHEDULER', 'or_scheduling = coordinator, მაგრამ or_schedule არავის აქვს — გეგმიურ მოთხოვნას მხოლოდ admin გეგმავს (სიაში — ქირურგს / ხელმძღვანელს)', ['or_schedule']);
    }
    const w = await wlSettings(this.db);
    if (w.s.nurse_scope === 'on_shift' && !mods.has('roster'))
      push('info', 'NURSE_SCOPE_NO_ROSTER', 'nurse_scope = on_shift, მაგრამ „ცვლები და მორიგეობა“ გამორთულია — ექთნის ჩანაწერები განყოფილების ყველა ექთანთან მიდის', ['roster']);
    if (!w.enabled) out.unshift({ level: 'error', code: 'MODULE_OFF', message: 'მოდული „სამუშაო სიები“ გამორთულია', total: 1, items: ['ადმინისტრირება → მოდულები'] });
    const off = Object.entries(w.s.sources ?? {}).filter(([, v]) => v === false).map(([k]) => `${k} — ${SOURCES[k]?.name ?? ''}`);
    push('info', 'SOURCES_OFF', 'გამორთული წყაროები', off);
    return { generated_at: new Date().toISOString(), dept_side: w.s.dept_side, reg_scope: w.s.reg_scope, nurse_scope: w.s.nurse_scope, issues: out };
  }

  /** სიისთვის: აქტიური მომხმარებლები (სატესტოს გარდა) */
  async previewUsers(includeTest = false) {
    return (await sql<{ id: string; email: string; is_section_head: boolean; department_name: string | null; capabilities: string[] | null; name: string }>`
      SELECT u.id, u.email, u.is_section_head, d.name AS department_name, c.capabilities, u.last_name || ' ' || u.first_name AS name
        FROM users u LEFT JOIN departments d ON d.id = u.department_id LEFT JOIN user_capabilities c ON c.user_id = u.id
       WHERE u.is_active AND (${includeTest} OR u.email NOT LIKE '%@test.local') ORDER BY d.name NULLS FIRST, u.last_name`.execute(this.db)).rows;
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
  // 0082b: შემოწმება — სხვისი სია / კონფიგურაციის ხარვეზები (admin / worklist_all)
  @Get('check/users') @Roles('admin', 'worklist_all') checkUsers(@Query('include_test') t?: string) { return this.s.previewUsers(t === '1'); }
  @Get('check/diagnostics') @Roles('admin', 'worklist_all') diagnostics(@Query('include_test') t?: string) { return this.s.diagnostics(t === '1'); }
  @Get('check/preview/:userId') @Roles('admin', 'worklist_all') preview(@Param('userId', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.preview(id, u, r); }
}
