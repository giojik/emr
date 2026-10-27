import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser } from '../auth/decorators';
import { has, type AuthUser } from '../auth/roles';
import { mapPgError } from '../common/pg-errors';
import { InjectDb, type Database } from '../database/database.module';
import { ModulesService } from '../modules/modules';
import { NotificationsService } from '../notifications/notifications';
import {
  REST, ROSTER_VIEW_ALL, absenceScope, addDays, canEdit, canHead, canView, evaluate, isoDow, monthDays, needEdit, rosterScope, shiftTimes, staffName, today, tz,
  type Ex, type RosterSettings, type RuleEntry, type Trx, type Violation,
} from './roster-common';

const MONTH_KA = ['იანვარი', 'თებერვალი', 'მარტი', 'აპრილი', 'მაისი', 'ივნისი', 'ივლისი', 'აგვისტო', 'სექტემბერი', 'ოქტომბერი', 'ნოემბერი', 'დეკემბერი'];
export const monthLabel = (m: string) => `${MONTH_KA[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
export const ddmm = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
const ms = (d: Date | string) => new Date(d).getTime();
export const PG = { ex_re_overlap: 'ამ დროს თანამშრომელს სხვა ცვლა უკვე აქვს (ერთდროულად ორ ადგილას — არა)', rosters_department_id_month_key: 'ამ განყოფილებას ამ თვის განრიგი უკვე აქვს' };

type Tpl = { id: string; code: string; name: string; kind: string; start_time: string; end_time: string; break_min: number; counted_hours: string | null; department_ids: string[]; categories: string[]; is_active: boolean; color: string };
type Duty = { id: string; code: string; name: string; department_id: string | null; categories: string[]; required_count: number; has_backup: boolean; is_active: boolean };
type Staff = { id: string; name: string; user_id: string | null; department_id: string; extra: string[]; category: string | null; is_active: boolean; hired_on: string | null; left_on: string | null };
export interface Roster { id: string; department_id: string; month: string; status: string; version: number; department_name: string }
type Abs = { no: string; from: string; to: string; status: string };
type Pref = { part: string; note: string | null };
export interface Ctx { s: RosterSettings; tpl: Map<string, Tpl>; duty: Map<string, Duty>; staff: Map<string, Staff>; list: Map<string, RuleEntry[]>; abs: Map<string, Abs[]>; prefs: Map<string, Map<string, Pref>> }
export type Change = { kind: 'add' | 'change' | 'remove' | 'swap' | 'give' | 'replace' | 'absence' | 'fill'; entry_id: string; staff_id: string; data: Record<string, unknown> };
export interface Cand extends RuleEntry { roster_id: string; shift_template_id: string; duty_role_id: string | null; duty_level: number | null; note: string | null }
export interface EntryIn { staff_id: string; day: string; shift_template_id: string; duty_role_id?: string | null; duty_level?: number | null; start_time?: string | null; end_time?: string | null; note?: string | null }

@Injectable()
export class RosterService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService, private readonly modules: ModulesService, private readonly notifications: NotificationsService) {}
  settings() { return this.modules.require<RosterSettings>('roster'); }

  async roster(ex: Ex, id: string, lock = false): Promise<Roster> {
    let q = ex.selectFrom('rosters as r').innerJoin('departments as d', 'd.id', 'r.department_id')
      .select(['r.id', 'r.department_id', sql<string>`to_char(r.month, 'YYYY-MM-DD')`.as('month'), 'r.status', 'r.version', 'd.name as department_name']).where('r.id', '=', id);
    if (lock) q = q.forUpdate('r');
    const r = await q.executeTakeFirst();
    if (!r) throw new NotFoundException('განრიგი ვერ მოიძებნა');
    return r;
  }

  // ---------------------------------------------------------------- სია / შექმნა
  async list(u: AuthUser, month: string) {
    await this.settings();
    const sc = await rosterScope(this.db, u);
    const m = `${month}-01`;
    const deps = await this.db.selectFrom('departments as d').leftJoin('rosters as r', (j) => j.onRef('r.department_id', '=', 'd.id').on('r.month', '=', m))
      .select(['d.id as department_id', 'd.name as department_name', 'd.type', 'r.id', 'r.status', 'r.version', 'r.published_at',
        sql<number>`(SELECT count(*)::int FROM roster_entries e WHERE e.roster_id = r.id AND e.status = 'active')`.as('entries'),
        sql<number>`(SELECT count(DISTINCT e.staff_id)::int FROM roster_entries e WHERE e.roster_id = r.id AND e.status = 'active')`.as('staff'),
        sql<number>`(SELECT count(*)::int FROM staff_members s WHERE s.is_active AND (s.department_id = d.id OR EXISTS (SELECT 1 FROM staff_member_departments x WHERE x.staff_id = s.id AND x.department_id = d.id)))`.as('members')])
      .where('d.is_active', '=', true).orderBy('d.name').execute();
    return deps.filter((d) => canEdit(sc, d.department_id) || (canView(sc, d.department_id) && d.id && d.status !== 'draft'))
      .map((d) => ({ ...d, can_edit: canEdit(sc, d.department_id), status: d.id ? d.status : 'none' }));
  }

  async create(d: { department_id: string; month: string }, u: AuthUser, ctx: AuditContext) {
    await this.settings();
    needEdit(await rosterScope(this.db, u), d.department_id);
    if (!(await this.db.selectFrom('departments').select('id').where('id', '=', d.department_id).where('is_active', '=', true).executeTakeFirst())) throw new BadRequestException('განყოფილება ვერ მოიძებნა ან გათიშულია');
    try {
      return await this.db.transaction().execute(async (trx) => {
        const r = await trx.insertInto('rosters').values({ department_id: d.department_id, month: `${d.month}-01`, created_by: u.id }).returning('id').executeTakeFirstOrThrow();
        await trx.insertInto('roster_changes').values({ roster_id: r.id, kind: 'created', user_id: u.id }).execute();
        await this.audit.log(ctx, { action: 'CREATE_ROSTER', entityName: 'rosters', entityId: r.id, newData: d }, trx);
        return { id: r.id };
      });
    } catch (e) { mapPgError(e, PG); }
  }

  // ---------------------------------------------------------------- კონტექსტი / შემოწმება
  async context(ex: Ex, r: Roster, staffIds: string[]): Promise<Ctx> {
    const s = await this.settings();
    const [tpls, duties, staff] = await Promise.all([
      ex.selectFrom('shift_templates').selectAll().execute(),
      ex.selectFrom('duty_roles').selectAll().execute(),
      staffIds.length ? ex.selectFrom('staff_members as s').leftJoin('staff_positions as p', 'p.id', 's.position_id')
        .select(['s.id', staffName('s').as('name'), 's.user_id', 's.department_id', 'p.category', 's.is_active', sql<string | null>`to_char(s.hired_on, 'YYYY-MM-DD')`.as('hired_on'),
          sql<string | null>`to_char(s.left_on, 'YYYY-MM-DD')`.as('left_on'),
          sql<string[]>`coalesce((SELECT array_agg(x.department_id) FROM staff_member_departments x WHERE x.staff_id = s.id), '{}')`.as('extra')])
        .where('s.id', 'in', staffIds).execute() : Promise.resolve([]),
    ]);
    const days = monthDays(r.month);
    const list = new Map<string, RuleEntry[]>();
    if (staffIds.length) {
      const rows = await ex.selectFrom('roster_entries as e').innerJoin('shift_templates as t', 't.id', 'e.shift_template_id')
        .select(['e.id', 'e.staff_id', sql<string>`to_char(e.day, 'YYYY-MM-DD')`.as('day'), 'e.starts_at', 'e.ends_at', 'e.hours', 't.kind'])
        .where('e.status', '=', 'active').where('e.staff_id', 'in', staffIds)
        .where('e.day', '>=', addDays(days[0], -9)).where('e.day', '<=', addDays(days[days.length - 1], 9)).execute();
      for (const x of rows) (list.get(x.staff_id) ?? list.set(x.staff_id, []).get(x.staff_id)!)
        .push({ id: x.id, staff_id: x.staff_id, day: x.day, starts: ms(x.starts_at), ends: ms(x.ends_at), hours: Number(x.hours), kind: x.kind });
    }
    // 0078: არყოფნა (განხილვაში / დადასტურებული), „არ შემიძლია“
    const abs = new Map<string, Abs[]>(); const prefs = new Map<string, Map<string, Pref>>();
    if (staffIds.length) {
      const [ar, pr] = await Promise.all([
        ex.selectFrom('absence_requests').select(['staff_id', sql<string>`no::text`.as('no'), sql<string>`to_char(date_from, 'YYYY-MM-DD')`.as('from'), sql<string>`to_char(date_to, 'YYYY-MM-DD')`.as('to'), 'status'])
          .where('staff_id', 'in', staffIds).where('status', 'in', ['head', 'hr', 'approved']).where('date_to', '>=', addDays(days[0], -9)).where('date_from', '<=', addDays(days[days.length - 1], 9)).execute(),
        ex.selectFrom('staff_prefs').select(['staff_id', sql<string>`to_char(day, 'YYYY-MM-DD')`.as('day'), 'part', 'note'])
          .where('staff_id', 'in', staffIds).where('kind', '=', 'unavailable').where('day', '>=', days[0]).where('day', '<=', days[days.length - 1]).execute(),
      ]);
      for (const a of ar) (abs.get(a.staff_id) ?? abs.set(a.staff_id, []).get(a.staff_id)!).push(a);
      for (const p of pr) (prefs.get(p.staff_id) ?? prefs.set(p.staff_id, new Map()).get(p.staff_id)!).set(p.day, { part: p.part, note: p.note });
    }
    return { s, tpl: new Map(tpls.map((x) => [x.id, x])), duty: new Map(duties.map((x) => [x.id, x])), staff: new Map(staff.map((x) => [x.id, x])), list, abs, prefs };
  }

  /** ერთი ჩანაწერის შემოწმება: სტატიკური პირობები + გადაფარვა + წესები (block → შეცდომა, warn → გაფრთხილება) */
  check(c: Ctx, r: Roster, it: EntryIn, ignoreId?: string): { cand?: Cand; error?: string; code?: string; warnings: string[] } {
    const warnings: string[] = [];
    const fail = (error: string, code?: string) => ({ error, code, warnings });
    if (it.day.slice(0, 7) !== r.month.slice(0, 7)) return fail(`დღე ${it.day} განრიგის თვეში არ არის`);
    const st = c.staff.get(it.staff_id);
    if (!st) return fail('თანამშრომელი ვერ მოიძებნა');
    if (!st.is_active) return fail(`${st.name} — გათიშულია`);
    if (st.hired_on && it.day < st.hired_on) return fail(`${st.name} — მიღებულია ${st.hired_on}-დან`);
    if (st.left_on && it.day > st.left_on) return fail(`${st.name} — წასულია ${st.left_on}-დან`);
    if (st.department_id !== r.department_id && !st.extra.includes(r.department_id)) {
      if (c.s.cross_department === 'block') return fail(`${st.name} — ამ განყოფილებაზე არ არის მიბმული (თანამშრომლის ბარათი → დამატებითი განყოფილებები)`);
      if (c.s.cross_department === 'warn') warnings.push(`${st.name} — სხვა განყოფილების თანამშრომელია`);
    }
    const t = c.tpl.get(it.shift_template_id);
    if (!t || !t.is_active) return fail('ცვლა ვერ მოიძებნა ან გათიშულია');
    if (t.department_ids.length && !t.department_ids.includes(r.department_id)) return fail(`ცვლა „${t.code}“ ამ განყოფილებისთვის არ არის`);
    if (t.categories.length && !(st.category && t.categories.includes(st.category))) return fail(`ცვლა „${t.code}“ ${st.category ? 'ამ კატეგორიისთვის' : 'პოზიციის გარეშე თანამშრომლისთვის'} არ არის`);
    // 0078: არყოფნა — დადასტურებულზე ყოველთვის იბლოკება, განხილვაში მყოფზე — გაფრთხილება; „არ შემიძლია“ — პარამეტრით
    const ab = (c.abs.get(st.id) ?? []).find((a) => it.day >= a.from && it.day <= a.to);
    if (ab?.status === 'approved') return fail(`${st.name} — ${ddmm(it.day)} არყოფნაშია (#${ab.no})`, 'ROSTER_ABSENCE');
    if (ab) warnings.push(`${st.name} — ${ddmm(it.day)}: არყოფნის მოთხოვნა განხილვაშია (#${ab.no})`);
    const pf = c.s.prefs_mode !== 'off' ? c.prefs.get(st.id)?.get(it.day) : undefined;
    if (pf && (pf.part === 'all' || (pf.part === 'night') === (t.kind === 'night' || t.kind === '24h')))
      warnings.push(`${st.name} — ${ddmm(it.day)}: „არ შემიძლია“${pf.part !== 'all' ? (pf.part === 'night' ? ' (ღამე)' : ' (დღე)') : ''}${pf.note ? ` — ${pf.note}` : ''}`);
    let dutyId: string | null = null, level: number | null = null;
    if (it.duty_role_id) {
      const d = c.duty.get(it.duty_role_id);
      if (!d || !d.is_active) return fail('მორიგის როლი ვერ მოიძებნა ან გათიშულია');
      if (d.department_id && d.department_id !== r.department_id) return fail(`მორიგის როლი „${d.name}“ სხვა განყოფილებისაა`);
      if (d.categories.length && !(st.category && d.categories.includes(st.category))) return fail(`მორიგის როლი „${d.name}“ ამ კატეგორიისთვის არ არის`);
      level = it.duty_level ?? 1;
      if (level === 2 && !d.has_backup) return fail(`მორიგის როლს „${d.name}“ II დონე არ აქვს`);
      dutyId = d.id;
    } else if (it.duty_level) return fail('დონე — მხოლოდ მორიგის როლით');
    if (!!it.start_time !== !!it.end_time) return fail('დრო: დასაწყისი და დასასრული ერთად');
    const tm = shiftTimes(it.day, it.start_time ?? t.start_time, it.end_time ?? t.end_time, t.break_min, t.counted_hours === null ? null : Number(t.counted_hours));
    const id = ignoreId ?? `new-${Math.random().toString(36).slice(2)}`;
    const cand: Cand = { id, staff_id: st.id, day: it.day, starts: tm.starts, ends: tm.ends, hours: tm.hours, kind: t.kind, roster_id: r.id, shift_template_id: t.id,
      duty_role_id: dutyId, duty_level: level, note: it.note?.trim() || null };
    const mine = (c.list.get(st.id) ?? []).filter((x) => x.id !== ignoreId);
    const ov = mine.find((x) => x.starts < cand.ends && cand.starts < x.ends);
    if (ov) return fail(`${st.name} — ${ddmm(ov.day)}-ს უკვე აქვს ცვლა, რომელიც ამ დროს ემთხვევა`);
    for (const v of evaluate([...mine, cand], c.s)) {
      if (!v.entry_ids.includes(id)) continue;
      if (v.mode === 'block') return fail(`${st.name}: ${v.message}`);
      warnings.push(`${st.name}: ${v.message}`);
    }
    return { cand, warnings };
  }

  async insert(trx: Trx, c: Cand, u: AuthUser) {
    const r = await trx.insertInto('roster_entries').values({ roster_id: c.roster_id, staff_id: c.staff_id, day: c.day, shift_template_id: c.shift_template_id,
      starts_at: new Date(c.starts), ends_at: new Date(c.ends), hours: String(c.hours), duty_role_id: c.duty_role_id, duty_level: c.duty_level, note: c.note, created_by: u.id })
      .returning('id').executeTakeFirstOrThrow();
    return r.id;
  }

  /** გამოქვეყნების შემდეგ: მიზეზი სავალდებულოა, ვერსია +1, ისტორია, შეტყობინება თანამშრომელს */
  needReason(r: Roster, reason?: string | null) {
    if (r.status === 'closed') throw new ConflictException({ code: 'ROSTER_CLOSED', message: 'განრიგი დახურულია — ცვლილება შეუძლებელია' });
    if (r.status === 'published' && (reason?.trim().length ?? 0) < 3) throw new BadRequestException({ code: 'REASON_REQUIRED', message: 'გამოქვეყნებულ განრიგში ცვლილებას მიზეზი სჭირდება' });
  }
  async afterChange(trx: Trx, r: Roster, changes: Change[], reason: string | null, u: AuthUser) {
    if (r.status !== 'published' || !changes.length) return [];
    await trx.updateTable('rosters').set({ version: sql`version + 1` }).where('id', '=', r.id).execute();
    await trx.insertInto('roster_changes').values(changes.map((x) => ({ roster_id: r.id, entry_id: x.entry_id, staff_id: x.staff_id, kind: x.kind, reason, data: JSON.stringify(x.data), user_id: u.id }))).execute();
    return changes;
  }
  async notifyChanged(r: Roster, changes: { staff_id: string; data: Record<string, unknown>; kind: string }[]) {
    if (r.status !== 'published' || !changes.length) return;
    const s = await this.settings();
    if (!s.change_notify) return;
    const staff = await this.db.selectFrom('staff_members').select(['id', 'user_id']).where('id', 'in', [...new Set(changes.map((x) => x.staff_id))]).where('user_id', 'is not', null).execute();
    const KA: Record<string, string> = { add: '+', change: '±', remove: '−', fill: '+', absence: '−' };
    for (const st of staff) {
      for (const ch of changes.filter((x) => x.staff_id === st.id)) {
        await this.notifications.notify(st.user_id!, { kind: 'roster_changed', title: `განრიგი შეიცვალა: ${r.department_name} · ${monthLabel(r.month)}`,
          body: 'იხილეთ „ჩემი განრიგი“', link: `/roster?tab=my&month=${r.month.slice(0, 7)}`, entityId: r.id,
          item: `${KA[ch.kind]} ${ddmm(String(ch.data.day))} ${String(ch.data.code ?? '')}`.trim() });
      }
    }
  }

  // ---------------------------------------------------------------- ჩანაწერები
  /** ერთი ან რამდენიმე ჩანაწერი. strict — ყველა ან არცერთი (409 პირველივე დაბლოკვაზე); skip — სწორები ემატება, დანარჩენი — ანგარიშში */
  async addEntries(id: string, d: { items: EntryIn[]; mode?: 'strict' | 'skip'; reason?: string | null }, u: AuthUser, ctx: AuditContext) {
    const res = await this.db.transaction().execute(async (trx) => {
      const r = await this.roster(trx, id, true);
      needEdit(await rosterScope(trx, u), r.department_id);
      this.needReason(r, d.reason);
      const c = await this.context(trx, r, [...new Set(d.items.map((x) => x.staff_id))]);
      const created: { id: string; staff_id: string; day: string; warnings: string[] }[] = []; const skipped: { staff_id: string; day: string; message: string }[] = [];
      const changes: Change[] = [];
      for (const it of d.items) {
        const v = this.check(c, r, it);
        if (!v.cand) {
          if (d.mode !== 'skip') throw new ConflictException({ code: v.code ?? 'ROSTER_RULE', message: v.error, staff_id: it.staff_id, day: it.day });
          skipped.push({ staff_id: it.staff_id, day: it.day, message: v.error! }); continue;
        }
        const eid = await this.insert(trx, v.cand, u);
        (c.list.get(v.cand.staff_id) ?? c.list.set(v.cand.staff_id, []).get(v.cand.staff_id)!).push({ ...v.cand, id: eid });
        created.push({ id: eid, staff_id: v.cand.staff_id, day: v.cand.day, warnings: v.warnings });
        changes.push({ kind: 'add', entry_id: eid, staff_id: v.cand.staff_id, data: { day: v.cand.day, code: c.tpl.get(v.cand.shift_template_id)?.code, duty_role_id: v.cand.duty_role_id } });
      }
      await this.afterChange(trx, r, changes, d.reason?.trim() || null, u);
      if (d.items.length > 1 && r.status === 'draft') await trx.insertInto('roster_changes').values({ roster_id: r.id, kind: 'bulk', data: JSON.stringify({ created: created.length, skipped: skipped.length }), user_id: u.id }).execute();
      if (r.status === 'published') await this.audit.log(ctx, { action: 'ROSTER_ENTRY_ADD', entityName: 'rosters', entityId: r.id, newData: { items: created.length, reason: d.reason } }, trx);
      return { r, created, skipped, changes };
    }).catch((e) => mapPgError(e, PG));
    await this.notifyChanged(res.r, res.changes);
    return { created: res.created, skipped: res.skipped };
  }

  async entry(trx: Trx, id: string) {
    const e = await trx.selectFrom('roster_entries as e').innerJoin('shift_templates as t', 't.id', 'e.shift_template_id')
      .select(['e.id', 'e.roster_id', 'e.staff_id', sql<string>`to_char(e.day, 'YYYY-MM-DD')`.as('day'), 'e.shift_template_id', 'e.duty_role_id', 'e.duty_level', 'e.note', 'e.status', 't.code',
        sql<string>`to_char(e.starts_at AT TIME ZONE ${tz}, 'HH24:MI')`.as('start_local'), sql<string>`to_char(e.ends_at AT TIME ZONE ${tz}, 'HH24:MI')`.as('end_local'), 't.start_time', 't.end_time'])
      .where('e.id', '=', id).forUpdate('e').executeTakeFirst();
    if (!e || e.status !== 'active') throw new NotFoundException('ჩანაწერი ვერ მოიძებნა');
    return e;
  }

  async updateEntry(id: string, d: Partial<EntryIn> & { reason?: string | null }, u: AuthUser, ctx: AuditContext) {
    const res = await this.db.transaction().execute(async (trx) => {
      const e = await this.entry(trx, id);
      const r = await this.roster(trx, e.roster_id, true);
      needEdit(await rosterScope(trx, u), r.department_id);
      this.needReason(r, d.reason);
      const custom = e.start_local !== e.start_time.slice(0, 5) || e.end_local !== e.end_time.slice(0, 5);
      const tplChanged = d.shift_template_id !== undefined && d.shift_template_id !== e.shift_template_id;
      const it: EntryIn = { staff_id: e.staff_id, day: e.day, shift_template_id: d.shift_template_id ?? e.shift_template_id,
        duty_role_id: d.duty_role_id !== undefined ? d.duty_role_id : e.duty_role_id, duty_level: d.duty_role_id === null ? null : d.duty_level !== undefined ? d.duty_level : e.duty_level,
        start_time: d.start_time !== undefined ? d.start_time : custom && !tplChanged ? e.start_local : null,
        end_time: d.end_time !== undefined ? d.end_time : custom && !tplChanged ? e.end_local : null,
        note: d.note !== undefined ? d.note : e.note };
      const c = await this.context(trx, r, [e.staff_id]);
      const v = this.check(c, r, it, e.id);
      if (!v.cand) throw new ConflictException({ code: v.code ?? 'ROSTER_RULE', message: v.error });
      await trx.updateTable('roster_entries').set({ shift_template_id: v.cand.shift_template_id, starts_at: new Date(v.cand.starts), ends_at: new Date(v.cand.ends), hours: String(v.cand.hours),
        duty_role_id: v.cand.duty_role_id, duty_level: v.cand.duty_level, note: v.cand.note }).where('id', '=', e.id).execute();
      const code = c.tpl.get(v.cand.shift_template_id)?.code;
      const changes = await this.afterChange(trx, r, [{ kind: 'change', entry_id: e.id, staff_id: e.staff_id, data: { day: e.day, code, from: e.code, duty_role_id: v.cand.duty_role_id } }], d.reason?.trim() || null, u);
      if (r.status === 'published') await this.audit.log(ctx, { action: 'ROSTER_ENTRY_CHANGE', entityName: 'roster_entries', entityId: e.id, oldData: e, newData: { ...it, reason: d.reason } }, trx);
      return { r, changes, warnings: v.warnings };
    }).catch((e) => mapPgError(e, PG));
    await this.notifyChanged(res.r, res.changes);
    return { ok: true, warnings: res.warnings };
  }

  /** მოხსნა. გამოქვეყნებულში open_shift — გაუქმებული ცვლა „დასაფარი“ ხდება (0078) */
  async removeEntry(id: string, reason: string | null | undefined, u: AuthUser, ctx: AuditContext, openShift = false) {
    const res = await this.db.transaction().execute(async (trx) => {
      const e = await this.entry(trx, id);
      const r = await this.roster(trx, e.roster_id, true);
      needEdit(await rosterScope(trx, u), r.department_id);
      this.needReason(r, reason);
      if (r.status === 'draft') { await trx.deleteFrom('roster_entries').where('id', '=', e.id).execute(); return { r, changes: [], open: [] as string[] }; }
      await trx.updateTable('roster_entries').set({ status: 'cancelled', cancelled_at: sql`now()`, cancelled_by: u.id, cancel_reason: reason!.trim() }).where('id', '=', e.id).execute();
      const changes = await this.afterChange(trx, r, [{ kind: 'remove', entry_id: e.id, staff_id: e.staff_id, data: { day: e.day, code: e.code, ...(openShift && { open_shift: true }) } }], reason!.trim(), u);
      const open = openShift ? [await this.openFromEntry(trx, e.id, 'cancel', u, null, reason!.trim())] : [];
      await this.audit.log(ctx, { action: 'ROSTER_ENTRY_REMOVE', entityName: 'roster_entries', entityId: e.id, oldData: e, newData: { reason, open_shift: openShift } }, trx);
      return { r, changes, open };
    });
    await this.notifyChanged(res.r, res.changes);
    await this.notifyOpenShifts(res.open);
    return { ok: true, open_shift_id: res.open[0] ?? null };
  }

  /** ჩანაცვლება (0078, G): თანამშრომელი იცვლება, დრო / როლი — უცვლელი; გამოქვეყნებულში — მიზეზით, ისტორია „replace“, შეტყობინება ორივეს */
  async replaceEntry(id: string, d: { staff_id: string; reason?: string | null }, u: AuthUser, ctx: AuditContext) {
    const res = await this.db.transaction().execute(async (trx) => {
      const e = await this.entry(trx, id);
      const r = await this.roster(trx, e.roster_id, true);
      needEdit(await rosterScope(trx, u), r.department_id);
      this.needReason(r, d.reason);
      if (d.staff_id === e.staff_id) throw new BadRequestException('იგივე თანამშრომელია');
      const custom = e.start_local !== e.start_time.slice(0, 5) || e.end_local !== e.end_time.slice(0, 5);
      const c = await this.context(trx, r, [d.staff_id]);
      const v = this.check(c, r, { staff_id: d.staff_id, day: e.day, shift_template_id: e.shift_template_id, duty_role_id: e.duty_role_id, duty_level: e.duty_level,
        start_time: custom ? e.start_local : null, end_time: custom ? e.end_local : null, note: e.note });
      if (!v.cand) throw new ConflictException({ code: v.code ?? 'ROSTER_RULE', message: v.error });
      await trx.updateTable('roster_entries').set({ staff_id: d.staff_id }).where('id', '=', e.id).execute();
      const data = { day: e.day, code: e.code, from_staff: e.staff_id, from_name: (await trx.selectFrom('staff_members as s').select(staffName('s').as('n')).where('s.id', '=', e.staff_id).executeTakeFirst())?.n };
      const changes = await this.afterChange(trx, r, [{ kind: 'replace', entry_id: e.id, staff_id: d.staff_id, data }], d.reason?.trim() || null, u);
      if (r.status === 'published') await this.audit.log(ctx, { action: 'ROSTER_ENTRY_REPLACE', entityName: 'roster_entries', entityId: e.id, oldData: { staff_id: e.staff_id }, newData: { staff_id: d.staff_id, reason: d.reason } }, trx);
      return { r, changes, old: e.staff_id, day: e.day, code: e.code, warnings: v.warnings };
    }).catch((e) => mapPgError(e, PG));
    if (res.changes.length) await this.notifyChanged(res.r, [{ staff_id: res.old, kind: 'remove', data: { day: res.day, code: res.code } }, { staff_id: d.staff_id, kind: 'add', data: { day: res.day, code: res.code } }]);
    return { ok: true, warnings: res.warnings };
  }

  // ---------------------------------------------------------------- დასაფარი (0078, E) — საერთო ნაწილი (არყოფნა / მოხსნა / შევსება)
  /** გაუქმებული ჩანაწერიდან დასაფარი ცვლა (დრო, შაბლონი, მორიგის როლი, კატეგორია — თანამშრომლის პოზიციიდან) */
  async openFromEntry(trx: Trx, entryId: string, source: 'absence' | 'cancel', u: AuthUser, absenceId: string | null, note: string | null) {
    const e = await trx.selectFrom('roster_entries as e').leftJoin('staff_members as s', 's.id', 'e.staff_id').leftJoin('staff_positions as p', 'p.id', 's.position_id')
      .select(['e.roster_id', 'e.day', 'e.shift_template_id', 'e.starts_at', 'e.ends_at', 'e.hours', 'e.duty_role_id', 'e.duty_level', 'p.category'])
      .where('e.id', '=', entryId).executeTakeFirstOrThrow();
    const r = await trx.insertInto('roster_open_shifts').values({ roster_id: e.roster_id, day: e.day, shift_template_id: e.shift_template_id, starts_at: e.starts_at, ends_at: e.ends_at, hours: e.hours,
      duty_role_id: e.duty_role_id, duty_level: e.duty_level, category: e.category, source, source_entry_id: entryId, absence_request_id: absenceId, note, created_by: u.id }).returning('id').executeTakeFirstOrThrow();
    return r.id;
  }
  /** ახალი დასაფარი — შეტყობინება განყოფილების (ძირითადი / დამატებითი) იმავე კატეგორიის ანგარიშიან თანამშრომლებს (პარამეტრი) */
  async notifyOpenShifts(ids: string[]) {
    if (!ids.length) return;
    const s = await this.settings();
    if (!s.open_shift_notify) return;
    const rows = await this.db.selectFrom('roster_open_shifts as o').innerJoin('rosters as r', 'r.id', 'o.roster_id').innerJoin('departments as d', 'd.id', 'r.department_id')
      .innerJoin('shift_templates as t', 't.id', 'o.shift_template_id').leftJoin('roster_entries as e', 'e.id', 'o.source_entry_id')
      .select(['o.id', 'r.department_id', 'd.name as department_name', sql<string>`to_char(o.day, 'YYYY-MM-DD')`.as('day'), 't.code', 'o.category', 'e.staff_id as was_staff', 'o.starts_at'])
      .where('o.id', 'in', ids).where('o.status', '=', 'open').execute();
    for (const o of rows) {
      if (new Date(o.starts_at).getTime() <= Date.now()) continue;
      let q = this.db.selectFrom('staff_members as s').leftJoin('staff_positions as p', 'p.id', 's.position_id').select('s.user_id')
        .where('s.is_active', '=', true).where('s.user_id', 'is not', null)
        .where((eb) => eb.or([eb('s.department_id', '=', o.department_id), eb.exists(eb.selectFrom('staff_member_departments as x').select('x.staff_id').whereRef('x.staff_id', '=', 's.id').where('x.department_id', '=', o.department_id))]));
      if (o.category) q = q.where('p.category', '=', o.category);
      if (o.was_staff) q = q.where('s.id', '<>', o.was_staff);
      for (const x of await q.execute()) await this.notifications.notify(x.user_id!, { kind: 'open_shift_new', title: `დასაფარი ცვლა: ${o.department_name}`, body: 'შეგიძლიათ თქვათ „ავიღებ“ — „ჩემი განრიგი → დასაფარი“',
        link: '/roster?tab=my&sub=open', entityId: o.department_id, item: `${ddmm(o.day)} ${o.code}` });
    }
  }

  /** მონახაზის გასუფთავება (თანამშრომლები / პერიოდი) */
  async clear(id: string, d: { staff_ids?: string[]; from?: string; to?: string }, u: AuthUser) {
    return this.db.transaction().execute(async (trx) => {
      const r = await this.roster(trx, id, true);
      needEdit(await rosterScope(trx, u), r.department_id);
      if (r.status !== 'draft') throw new ConflictException({ code: 'ROSTER_NOT_DRAFT', message: 'გასუფთავება — მხოლოდ მონახაზში (გამოქვეყნებულში — თითო ცვლილება მიზეზით)' });
      let q = trx.deleteFrom('roster_entries').where('roster_id', '=', r.id);
      if (d.staff_ids?.length) q = q.where('staff_id', 'in', d.staff_ids);
      if (d.from) q = q.where('day', '>=', d.from);
      if (d.to) q = q.where('day', '<=', d.to);
      const n = (await q.executeTakeFirst()).numDeletedRows;
      return { deleted: Number(n) };
    });
  }

  // ---------------------------------------------------------------- კოპირება, როტაცია
  /** წინა თვიდან: weekday — 4-კვირიანი ციკლი (დღე − 28; 29-ე დღიდან — უკვე გადმოტანილი), date — იგივე რიცხვი */
  async copy(id: string, d: { mode?: 'weekday' | 'date' }, u: AuthUser) {
    return this.db.transaction().execute(async (trx) => {
      const r = await this.roster(trx, id, true);
      needEdit(await rosterScope(trx, u), r.department_id);
      if (r.status !== 'draft') throw new ConflictException({ code: 'ROSTER_NOT_DRAFT', message: 'კოპირება — მხოლოდ მონახაზში' });
      const s = await this.settings();
      const mode = d.mode ?? s.copy_mode;
      const prevMonth = addDays(r.month, -1).slice(0, 7) + '-01';
      const src = await trx.selectFrom('rosters').select('id').where('department_id', '=', r.department_id).where('month', '=', prevMonth).executeTakeFirst();
      if (!src) throw new BadRequestException('წინა თვის განრიგი ამ განყოფილებას არ აქვს');
      const rows = await trx.selectFrom('roster_entries as e').innerJoin('shift_templates as t', 't.id', 'e.shift_template_id')
        .select(['e.staff_id', sql<string>`to_char(e.day, 'YYYY-MM-DD')`.as('day'), 'e.shift_template_id', 'e.duty_role_id', 'e.duty_level', 'e.note',
          sql<string>`to_char(e.starts_at AT TIME ZONE ${tz}, 'HH24:MI')`.as('s'), sql<string>`to_char(e.ends_at AT TIME ZONE ${tz}, 'HH24:MI')`.as('e'), 't.start_time', 't.end_time'])
        .where('e.roster_id', '=', src.id).where('e.status', '=', 'active').orderBy('e.starts_at').execute();
      const toIn = (x: (typeof rows)[number], day: string): EntryIn => ({ staff_id: x.staff_id, day, shift_template_id: x.shift_template_id, duty_role_id: x.duty_role_id, duty_level: x.duty_level,
        note: x.note, ...(x.s !== x.start_time.slice(0, 5) || x.e !== x.end_time.slice(0, 5) ? { start_time: x.s, end_time: x.e } : {}) });
      const byDay = new Map<string, EntryIn[]>();
      for (const x of rows) (byDay.get(x.day) ?? byDay.set(x.day, []).get(x.day)!).push(toIn(x, x.day));
      const c = await this.context(trx, r, [...new Set(rows.map((x) => x.staff_id))]);
      const done = new Map<string, EntryIn[]>();
      let created = 0; const skipped: { staff_id: string; day: string; message: string }[] = [];
      for (const day of monthDays(r.month)) {
        let srcList: EntryIn[] = [];
        if (mode === 'date') srcList = byDay.get(`${prevMonth.slice(0, 8)}${day.slice(8)}`) ?? [];
        else { const sd = addDays(day, -28); srcList = (sd < r.month ? byDay.get(sd) : done.get(sd)) ?? []; }
        for (const x of srcList) {
          const it = { ...x, day };
          const v = this.check(c, r, it);
          if (!v.cand) { skipped.push({ staff_id: x.staff_id, day, message: v.error! }); continue; }
          const eid = await this.insert(trx, v.cand, u);
          (c.list.get(v.cand.staff_id) ?? c.list.set(v.cand.staff_id, []).get(v.cand.staff_id)!).push({ ...v.cand, id: eid });
          (done.get(day) ?? done.set(day, []).get(day)!).push(it);
          created++;
        }
      }
      await trx.insertInto('roster_changes').values({ roster_id: r.id, kind: 'copy', data: JSON.stringify({ from: src.id, mode, created, skipped: skipped.length }), user_id: u.id }).execute();
      return { created, skipped };
    }).catch((e) => mapPgError(e, PG));
  }

  async rotation(id: string, d: RotationDto, u: AuthUser) {
    return this.db.transaction().execute(async (trx) => {
      const r = await this.roster(trx, id, true);
      needEdit(await rosterScope(trx, u), r.department_id);
      if (r.status !== 'draft') throw new ConflictException({ code: 'ROSTER_NOT_DRAFT', message: 'როტაცია — მხოლოდ მონახაზში' });
      const p = await trx.selectFrom('rotation_patterns').selectAll().where('id', '=', d.pattern_id).executeTakeFirst();
      if (!p || !p.is_active) throw new BadRequestException('ნიმუში ვერ მოიძებნა ან გათიშულია');
      const days = monthDays(r.month).filter((x) => (!d.from || x >= d.from) && (!d.to || x <= d.to));
      if (!days.length) throw new BadRequestException('პერიოდი განრიგის თვეში არ არის');
      const ids = d.staff.map((x) => x.staff_id);
      const existing = await trx.selectFrom('roster_entries').select(['staff_id', sql<string>`to_char(day, 'YYYY-MM-DD')`.as('day')]).where('roster_id', '=', r.id).where('status', '=', 'active')
        .where('staff_id', 'in', ids).where('day', '>=', days[0]).where('day', '<=', days[days.length - 1]).execute();
      if (d.overwrite) {
        await trx.deleteFrom('roster_entries').where('roster_id', '=', r.id).where('staff_id', 'in', ids).where('day', '>=', days[0]).where('day', '<=', days[days.length - 1]).execute();
        existing.length = 0;
      }
      const busy = new Set(existing.map((x) => `${x.staff_id}|${x.day}`));
      const c = await this.context(trx, r, ids);
      // ციკლის ათვლა: from (ან თვის პირველი დღე) + თანამშრომლის წანაცვლება
      const base = Date.parse(`${days[0]}T00:00:00Z`);
      let created = 0; const skipped: { staff_id: string; day: string; message: string }[] = [];
      for (const st of d.staff) {
        for (const day of days) {
          const k = Math.round((Date.parse(`${day}T00:00:00Z`) - base) / 864e5) + (st.offset ?? 0);
          const tid = p.cycle[((k % p.cycle.length) + p.cycle.length) % p.cycle.length];
          if (tid === REST) continue;
          if (busy.has(`${st.staff_id}|${day}`)) { skipped.push({ staff_id: st.staff_id, day, message: 'ამ დღეს უკვე აქვს ჩანაწერი' }); continue; }
          const v = this.check(c, r, { staff_id: st.staff_id, day, shift_template_id: tid });
          if (!v.cand) { skipped.push({ staff_id: st.staff_id, day, message: v.error! }); continue; }
          const eid = await this.insert(trx, v.cand, u);
          (c.list.get(v.cand.staff_id) ?? c.list.set(v.cand.staff_id, []).get(v.cand.staff_id)!).push({ ...v.cand, id: eid });
          created++;
        }
      }
      await trx.insertInto('roster_changes').values({ roster_id: r.id, kind: 'rotation', data: JSON.stringify({ pattern: p.code, staff: ids.length, created, skipped: skipped.length }), user_id: u.id }).execute();
      return { created, skipped };
    }).catch((e) => mapPgError(e, PG));
  }

  // ---------------------------------------------------------------- ანალიზი: წესები, ნორმა, მორიგეობა, ჯამები
  private async analyze(ex: Ex, r: Roster) {
    const days = monthDays(r.month);
    const entries = await ex.selectFrom('roster_entries as e').innerJoin('shift_templates as t', 't.id', 'e.shift_template_id')
      .leftJoin('staff_members as s', 's.id', 'e.staff_id').leftJoin('staff_positions as p', 'p.id', 's.position_id')
      .select(['e.id', 'e.staff_id', sql<string>`to_char(e.day, 'YYYY-MM-DD')`.as('day'), 'e.shift_template_id', 't.code', 't.kind', 't.color', 'e.starts_at', 'e.ends_at', 'e.hours',
        'e.duty_role_id', 'e.duty_level', 'e.note', 'p.category',
        sql<string>`to_char(e.starts_at AT TIME ZONE ${tz}, 'HH24:MI')`.as('start_local'), sql<string>`to_char(e.ends_at AT TIME ZONE ${tz}, 'HH24:MI')`.as('end_local')])
      .where('e.roster_id', '=', r.id).where('e.status', '=', 'active').orderBy('e.starts_at').execute();
    const staffIds = [...new Set(entries.map((e) => e.staff_id))];
    const c = await this.context(ex, r, staffIds);
    const all = [...c.list.values()].flat();
    const own = new Set(entries.map((e) => e.id));
    const violations: Violation[] = evaluate(all, c.s).filter((v) => v.entry_ids.some((x) => own.has(x)));
    // ნორმა
    const [norms, holidays] = await Promise.all([
      ex.selectFrom('staffing_norms as n').innerJoin('shift_templates as t', 't.id', 'n.shift_template_id')
        .select(['n.id', 'n.shift_template_id', 't.code', 't.name', 'n.category', 'n.min_count', 'n.weekdays', 'n.holidays']).where('n.department_id', '=', r.department_id).where('n.is_active', '=', true).execute(),
      ex.selectFrom('public_holidays').select([sql<string>`to_char(day, 'YYYY-MM-DD')`.as('day'), 'name']).where('day', '>=', days[0]).where('day', '<=', days[days.length - 1]).execute(),
    ]);
    const hol = new Map(holidays.map((h) => [h.day, h.name]));
    const gaps: { day: string; norm_id: string; code: string; category: string; have: number; need: number }[] = [];
    if (c.s.norm_mode !== 'off') {
      for (const day of days) for (const n of norms) {
        if (n.weekdays.length && !n.weekdays.includes(isoDow(day))) continue;
        if (!n.holidays && hol.has(day)) continue;
        const have = entries.filter((e) => e.day === day && e.shift_template_id === n.shift_template_id && e.category === n.category).length;
        if (have < n.min_count) gaps.push({ day, norm_id: n.id, code: n.code, category: n.category, have, need: n.min_count });
      }
    }
    // მორიგეობის ხარვეზები (ამ განყოფილების როლები, I დონე)
    const duty = [...c.duty.values()].filter((d) => d.is_active && d.department_id === r.department_id && d.required_count > 0);
    const duty_gaps: { day: string; duty_role_id: string; name: string; have: number; need: number }[] = [];
    for (const day of days) for (const d of duty) {
      const have = entries.filter((e) => e.day === day && e.duty_role_id === d.id && e.duty_level === 1).length;
      if (have < d.required_count) duty_gaps.push({ day, duty_role_id: d.id, name: d.name, have, need: d.required_count });
    }
    // ჯამები თანამშრომელზე
    const totals: Record<string, { hours: number; shifts: number; nights: number; weekend: number; holiday: number; duty: number }> = {};
    for (const e of entries) {
      const t = (totals[e.staff_id] ??= { hours: 0, shifts: 0, nights: 0, weekend: 0, holiday: 0, duty: 0 });
      t.hours = Math.round((t.hours + Number(e.hours)) * 100) / 100; t.shifts++;
      if (e.kind === 'night' || e.kind === '24h') t.nights++;
      if (isoDow(e.day) >= 6) t.weekend++;
      if (hol.has(e.day)) t.holiday++;
      if (e.duty_role_id) t.duty++;
    }
    return { entries, violations, gaps, duty_gaps, totals, holidays, c };
  }

  async get(id: string, u: AuthUser) {
    await this.settings();
    const r = await this.roster(this.db, id);
    const sc = await rosterScope(this.db, u);
    const edit = canEdit(sc, r.department_id);
    if (!edit && !(canView(sc, r.department_id) && r.status !== 'draft')) throw new ForbiddenException(r.status === 'draft' ? 'განრიგი ჯერ არ გამოქვეყნებულა' : 'განყოფილება თქვენს არეში არ არის');
    const a = await this.analyze(this.db, r);
    const full = await this.db.selectFrom('rosters as r').leftJoin('users as pu', 'pu.id', 'r.published_by')
      .select(['r.note', 'r.created_at', 'r.published_at', sql<string | null>`pu.first_name || ' ' || pu.last_name`.as('published_by_name')]).where('r.id', '=', id).executeTakeFirstOrThrow();
    // მწკრივები: განყოფილების აქტიური თანამშრომლები (ძირითადი / დამატებითი) + ვისაც ჩანაწერი აქვს
    const ids = [...new Set(a.entries.map((e) => e.staff_id))];
    const staff = await this.db.selectFrom('staff_members as s').leftJoin('staff_positions as p', 'p.id', 's.position_id')
      .select(['s.id', staffName('s').as('name'), 's.user_id', 's.department_id', 's.position_id', 'p.name as position_name', 'p.category', 's.fte', 's.is_active', 'p.sort_order'])
      .where((eb) => eb.or([
        eb.and([eb('s.is_active', '=', true), eb.or([eb('s.department_id', '=', r.department_id),
          eb.exists(eb.selectFrom('staff_member_departments as x').select('x.staff_id').whereRef('x.staff_id', '=', 's.id').where('x.department_id', '=', r.department_id))])]),
        ...(ids.length ? [eb('s.id', 'in', ids)] : [])]))
      .orderBy(sql`p.sort_order NULLS LAST`).orderBy('s.last_name').orderBy('s.first_name').execute();
    const days = monthDays(r.month).map((d) => ({ day: d, dow: isoDow(d), holiday: a.holidays.find((h) => h.day === d)?.name ?? null }));
    const { c: _c, ...rest } = a;
    const extra = await this.gridExtras(r, staff.map((x) => x.id), sc, u, edit);
    return { ...r, ...full, can_edit: edit && r.status !== 'closed', days, staff: staff.map((s) => ({ ...s, home: s.department_id === r.department_id })), ...rest, ...extra,
      blocking: a.violations.filter((v) => v.mode === 'block').length, warnings: a.violations.filter((v) => v.mode === 'warn').length };
  }

  /**
   * 0078: ბადის დამატებითი ფენები — არყოფნა (დადასტურებული / განხილვაში; ტიპი ჩანს მხოლოდ შემდგენს / ხელმძღვანელს / HR-ს, სხვებს — „არყოფნა“, D4),
   * „არ შემიძლია“ / „მირჩევნია“ (მხოლოდ შემდგენს), დასაფარი ცვლები (ღია) მოხალისეებით.
   */
  private async gridExtras(r: Roster, staffIds: string[], sc: Awaited<ReturnType<typeof rosterScope>>, u: AuthUser, edit: boolean) {
    const days = monthDays(r.month);
    const as = await absenceScope(this.db, u);
    const detail = canEdit(sc, r.department_id) || canHead(as, r.department_id);
    const abs = staffIds.length ? await this.db.selectFrom('absence_requests as a').innerJoin('absence_types as t', 't.id', 'a.absence_type_id')
      .select(['a.id', sql<string>`a.no::text`.as('no'), 'a.staff_id', sql<string>`to_char(a.date_from, 'YYYY-MM-DD')`.as('date_from'), sql<string>`to_char(a.date_to, 'YYYY-MM-DD')`.as('date_to'), 'a.status',
        'a.absence_type_id', 't.short', 't.color', 't.name'])
      .where('a.staff_id', 'in', staffIds).where('a.status', 'in', ['head', 'hr', 'approved']).where('a.date_to', '>=', days[0]).where('a.date_from', '<=', days[days.length - 1])
      .orderBy('a.date_from').execute() : [];
    const absences = abs.map((x) => (detail ? x : { ...x, id: null, no: null, absence_type_id: null, short: '—', color: '#94a3b8', name: 'არყოფნა' }));
    const prefs = edit && staffIds.length ? await this.db.selectFrom('staff_prefs as p').leftJoin('shift_templates as t', 't.id', 'p.shift_template_id')
      .select(['p.staff_id', sql<string>`to_char(p.day, 'YYYY-MM-DD')`.as('day'), 'p.kind', 'p.part', 'p.shift_template_id', 't.code', 'p.note'])
      .where('p.staff_id', 'in', staffIds).where('p.day', '>=', days[0]).where('p.day', '<=', days[days.length - 1]).execute() : [];
    const open = await this.db.selectFrom('roster_open_shifts as o').innerJoin('shift_templates as t', 't.id', 'o.shift_template_id').leftJoin('duty_roles as dr', 'dr.id', 'o.duty_role_id')
      .select(['o.id', sql<string>`to_char(o.day, 'YYYY-MM-DD')`.as('day'), 'o.shift_template_id', 't.code', 't.color', 'o.starts_at', 'o.ends_at', 'o.hours', 'o.duty_role_id', 'dr.name as duty_name', 'o.duty_level',
        'o.category', 'o.source', 'o.note', 'o.created_at',
        sql<{ staff_id: string; name: string; status: string }[]>`coalesce((SELECT json_agg(json_build_object('staff_id', f.staff_id, 'name', s.last_name || ' ' || s.first_name, 'status', f.status) ORDER BY f.created_at)
          FROM roster_open_shift_offers f JOIN staff_members s ON s.id = f.staff_id WHERE f.open_shift_id = o.id AND f.status = 'offered'), '[]')`.as('offers')])
      .where('o.roster_id', '=', r.id).where('o.status', '=', 'open').orderBy('o.starts_at').execute();
    return { absences, absence_detail: detail, prefs, open_shifts: open };
  }

  async changes(id: string, u: AuthUser) {
    await this.settings();
    const r = await this.roster(this.db, id);
    const sc = await rosterScope(this.db, u);
    if (!canEdit(sc, r.department_id) && !(canView(sc, r.department_id) && r.status !== 'draft')) throw new ForbiddenException('განყოფილება თქვენს არეში არ არის');
    return this.db.selectFrom('roster_changes as c').innerJoin('users as u', 'u.id', 'c.user_id').leftJoin('staff_members as s', 's.id', 'c.staff_id')
      .select(['c.id', 'c.kind', 'c.reason', 'c.data', 'c.created_at', 'c.entry_id', sql<string>`u.first_name || ' ' || u.last_name`.as('user_name'), sql<string | null>`s.last_name || ' ' || s.first_name`.as('staff_name')])
      .where('c.roster_id', '=', id).orderBy('c.id', 'desc').limit(500).execute();
  }

  // ---------------------------------------------------------------- გამოქვეყნება
  async publish(id: string, d: { confirm_warnings?: boolean; note?: string | null }, u: AuthUser, ctx: AuditContext) {
    const res = await this.db.transaction().execute(async (trx) => {
      const r = await this.roster(trx, id, true);
      needEdit(await rosterScope(trx, u), r.department_id);
      if (r.status !== 'draft') throw new ConflictException({ code: 'ROSTER_NOT_DRAFT', message: 'განრიგი უკვე გამოქვეყნებულია' });
      const a = await this.analyze(trx, r);
      if (!a.entries.length) throw new BadRequestException('განრიგი ცარიელია');
      const blocking = a.violations.filter((v) => v.mode === 'block');
      if (blocking.length) throw new ConflictException({ code: 'ROSTER_BLOCKING', message: `დამბლოკავი დარღვევა: ${blocking.length} (წესები შეიცვალა მონახაზის შემდეგ?) — გაასწორეთ`, violations: blocking });
      const warns = a.violations.filter((v) => v.mode === 'warn');
      if ((warns.length || a.gaps.length || a.duty_gaps.length) && !d.confirm_warnings) {
        throw new ConflictException({ code: 'ROSTER_WARNINGS', message: `გაფრთხილება: წესი — ${warns.length}, ნორმის ხარვეზი — ${a.gaps.length}, მორიგე დაუნიშნავი — ${a.duty_gaps.length}. დაადასტურეთ გამოქვეყნება`,
          violations: warns, gaps: a.gaps.length, duty_gaps: a.duty_gaps.length });
      }
      await trx.updateTable('rosters').set({ status: 'published', published_at: sql`now()`, published_by: u.id, ...(d.note !== undefined && { note: d.note?.trim() || null }) }).where('id', '=', r.id).execute();
      await trx.insertInto('roster_changes').values({ roster_id: r.id, kind: 'publish', data: JSON.stringify({ entries: a.entries.length, warnings: warns.length, gaps: a.gaps.length, duty_gaps: a.duty_gaps.length }), user_id: u.id }).execute();
      await this.audit.log(ctx, { action: 'PUBLISH_ROSTER', entityName: 'rosters', entityId: r.id, newData: { entries: a.entries.length, warnings: warns.length, gaps: a.gaps.length } }, trx);
      return { r, staff: [...new Set(a.entries.map((e) => e.staff_id))], s: a.c.s, entries: a.entries.length };
    });
    if (res.s.publish_notify && res.staff.length) {
      const users = await this.db.selectFrom('staff_members').select('user_id').where('id', 'in', res.staff).where('user_id', 'is not', null).execute();
      for (const x of users) await this.notifications.notify(x.user_id!, { kind: 'roster_published', title: `განრიგი გამოქვეყნდა: ${res.r.department_name} · ${monthLabel(res.r.month)}`,
        body: 'იხილეთ „ჩემი განრიგი“', link: `/roster?tab=my&month=${res.r.month.slice(0, 7)}`, entityId: res.r.id });
    }
    return { ok: true, entries: res.entries };
  }

  // ---------------------------------------------------------------- ვინ არის მორიგე / ცვლაში; ჩემი განრიგი
  async onDuty(u: AuthUser, q: { at?: string; department_id?: string }) {
    const s = await this.settings();
    const at = q.at ? new Date(q.at) : new Date();
    if (Number.isNaN(at.getTime())) throw new BadRequestException('at — ISO თარიღი / დრო');
    const showPhone = s.duty_phone === 'all' || (s.duty_phone === 'staff' && (has(u, ...ROSTER_VIEW_ALL, 'roster')));
    const base = this.db.selectFrom('roster_entries as e').innerJoin('rosters as r', 'r.id', 'e.roster_id').innerJoin('staff_members as s', 's.id', 'e.staff_id')
      .innerJoin('departments as d', 'd.id', 'r.department_id').innerJoin('shift_templates as t', 't.id', 'e.shift_template_id')
      .leftJoin('staff_positions as p', 'p.id', 's.position_id').leftJoin('users as u', 'u.id', 's.user_id').leftJoin('duty_roles as dr', 'dr.id', 'e.duty_role_id')
      .select(['e.id', 'e.staff_id', staffName('s').as('staff_name'), 'p.name as position_name', 'p.category', 'r.department_id', 'd.name as department_name', 't.code', 't.name as shift_name', 't.kind',
        'e.starts_at', 'e.ends_at', 'e.duty_role_id', 'dr.name as duty_name', 'dr.code as duty_code', 'e.duty_level', 'dr.phone as duty_phone', 'dr.sort_order as duty_sort',
        sql<string | null>`coalesce(s.phone, u.phone)`.as('phone')])
      .where('e.status', '=', 'active').where('r.status', 'in', ['published', 'closed']).where('e.starts_at', '<=', at).where('e.ends_at', '>', at);
    const duty = await base.where('e.duty_role_id', 'is not', null).$if(!!q.department_id, (x) => x.where('r.department_id', '=', q.department_id!))
      .orderBy('dr.sort_order').orderBy('dr.name').orderBy('e.duty_level').orderBy('s.last_name').execute();
    const on_shift = q.department_id ? await base.where('r.department_id', '=', q.department_id).orderBy(sql`p.category`).orderBy('s.last_name').execute() : [];
    const strip = <T extends { phone: string | null }>(x: T) => (showPhone ? x : { ...x, phone: null });
    // დაუნიშნავი მორიგის როლები (აქტიური, რაოდენობით) — ეკრანზე „არ არის მორიგე“
    const roles = await this.db.selectFrom('duty_roles as dr').leftJoin('departments as d', 'd.id', 'dr.department_id')
      .select(['dr.id', 'dr.name', 'dr.code', 'dr.phone', 'dr.department_id', 'd.name as department_name', 'dr.required_count'])
      .where('dr.is_active', '=', true).$if(!!q.department_id, (x) => x.where((eb) => eb.or([eb('dr.department_id', '=', q.department_id!), eb('dr.department_id', 'is', null)])))
      .orderBy('dr.sort_order').orderBy('dr.name').execute();
    return { at: at.toISOString(), duty: duty.map(strip), on_shift: on_shift.map(strip), uncovered: roles.filter((x) => x.required_count > 0 && !duty.some((d) => d.duty_role_id === x.id)) };
  }

  async my(u: AuthUser, month?: string) {
    await this.settings();
    const m = month ?? today().slice(0, 7);
    const st = await this.db.selectFrom('staff_members').select(['id', staffName('staff_members').as('name')]).where('user_id', '=', u.id).executeTakeFirst();
    if (!st) return { staff: null, month: m, entries: [] };
    const days = monthDays(`${m}-01`);
    const entries = await this.db.selectFrom('roster_entries as e').innerJoin('rosters as r', 'r.id', 'e.roster_id').innerJoin('departments as d', 'd.id', 'r.department_id')
      .innerJoin('shift_templates as t', 't.id', 'e.shift_template_id').leftJoin('duty_roles as dr', 'dr.id', 'e.duty_role_id')
      .select(['e.id', sql<string>`to_char(e.day, 'YYYY-MM-DD')`.as('day'), 't.code', 't.name as shift_name', 't.kind', 't.color', 'e.starts_at', 'e.ends_at', 'e.hours', 'd.name as department_name',
        'dr.name as duty_name', 'e.duty_level', 'e.note'])
      .where('e.staff_id', '=', st.id).where('e.status', '=', 'active').where('r.status', 'in', ['published', 'closed'])
      .where('e.day', '>=', days[0]).where('e.day', '<=', days[days.length - 1]).orderBy('e.starts_at').execute();
    return { staff: st, month: m, entries, hours: Math.round(entries.reduce((a, e) => a + Number(e.hours), 0) * 100) / 100 };
  }
}

// ======================================================================= DTO
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
class CreateDto { @IsUUID() department_id: string; @Matches(/^\d{4}-(0[1-9]|1[0-2])$/) month: string }
class EntryDto {
  @IsUUID() staff_id: string; @Matches(DAY) day: string; @IsUUID() shift_template_id: string;
  @IsOptional() @IsUUID() duty_role_id?: string | null; @IsOptional() @IsIn([1, 2, null]) duty_level?: number | null;
  @IsOptional() @Matches(HHMM) start_time?: string | null; @IsOptional() @Matches(HHMM) end_time?: string | null; @IsOptional() @IsString() @MaxLength(500) note?: string | null;
}
class AddDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(2000) @ValidateNested({ each: true }) @Type(() => EntryDto) items: EntryDto[];
  @IsOptional() @IsIn(['strict', 'skip']) mode?: 'strict' | 'skip'; @IsOptional() @IsString() @MaxLength(500) reason?: string | null;
}
class UpdateDto {
  @IsOptional() @IsUUID() shift_template_id?: string; @IsOptional() @IsUUID() duty_role_id?: string | null; @IsOptional() @IsIn([1, 2, null]) duty_level?: number | null;
  @IsOptional() @Matches(HHMM) start_time?: string | null; @IsOptional() @Matches(HHMM) end_time?: string | null; @IsOptional() @IsString() @MaxLength(500) note?: string | null;
  @IsOptional() @IsString() @MaxLength(500) reason?: string | null;
}
class ReasonDto { @IsOptional() @IsString() @MaxLength(500) reason?: string | null }
class RemoveDto { @IsOptional() @IsString() @MaxLength(500) reason?: string | null; @IsOptional() @IsBoolean() open_shift?: boolean }
class ReplaceDto { @IsUUID() staff_id: string; @IsOptional() @IsString() @MaxLength(500) reason?: string | null }
class ClearDto { @IsOptional() @IsArray() @IsUUID('all', { each: true }) staff_ids?: string[]; @IsOptional() @Matches(DAY) from?: string; @IsOptional() @Matches(DAY) to?: string }
class CopyDto { @IsOptional() @IsIn(['weekday', 'date']) mode?: 'weekday' | 'date' }
class RotStaff { @IsUUID() staff_id: string; @IsOptional() @IsInt() @Min(0) @Max(55) offset?: number }
class RotationDto {
  @IsUUID() pattern_id: string; @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => RotStaff) staff: RotStaff[];
  @IsOptional() @Matches(DAY) from?: string; @IsOptional() @Matches(DAY) to?: string; @IsOptional() @IsBoolean() overwrite?: boolean;
}
class PublishDto { @IsOptional() @IsBoolean() confirm_warnings?: boolean; @IsOptional() @IsString() @Length(0, 1000) note?: string | null }
const uuidOk = (v?: string) => !v || /^[0-9a-f-]{36}$/i.test(v);

/** ცვლები / მორიგეობა — განრიგი (0077). უფლებები სერვისში (განყოფილების არე) */
@Controller('roster')
export class RosterController {
  constructor(private readonly s: RosterService) {}
  @Get('rosters') list(@Query('month') month: string, @CurrentUser() u: AuthUser) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month ?? '')) throw new BadRequestException('month — YYYY-MM');
    return this.s.list(u, month);
  }
  @Post('rosters') create(@Body() d: CreateDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.create(d, u, auditCtx(r)); }
  @Get('rosters/:id') one(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser) { return this.s.get(id, u); }
  @Get('rosters/:id/changes') changes(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser) { return this.s.changes(id, u); }
  @Post('rosters/:id/entries') add(@Param('id', ParseUUIDPipe) id: string, @Body() d: AddDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.addEntries(id, d, u, auditCtx(r)); }
  @Post('rosters/:id/clear') @HttpCode(200) clear(@Param('id', ParseUUIDPipe) id: string, @Body() d: ClearDto, @CurrentUser() u: AuthUser) { return this.s.clear(id, d, u); }
  @Post('rosters/:id/copy') @HttpCode(200) copy(@Param('id', ParseUUIDPipe) id: string, @Body() d: CopyDto, @CurrentUser() u: AuthUser) { return this.s.copy(id, d, u); }
  @Post('rosters/:id/rotation') @HttpCode(200) rotation(@Param('id', ParseUUIDPipe) id: string, @Body() d: RotationDto, @CurrentUser() u: AuthUser) { return this.s.rotation(id, d, u); }
  @Post('rosters/:id/publish') @HttpCode(200) publish(@Param('id', ParseUUIDPipe) id: string, @Body() d: PublishDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.publish(id, d, u, auditCtx(r)); }
  @Patch('entries/:id') update(@Param('id', ParseUUIDPipe) id: string, @Body() d: UpdateDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.updateEntry(id, d, u, auditCtx(r)); }
  @Post('entries/:id/remove') @HttpCode(200) remove(@Param('id', ParseUUIDPipe) id: string, @Body() d: RemoveDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.removeEntry(id, d.reason, u, auditCtx(r), !!d.open_shift); }
  @Post('entries/:id/replace') @HttpCode(200) replace(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReplaceDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.replaceEntry(id, d, u, auditCtx(r)); }
  @Get('on-duty') onDuty(@CurrentUser() u: AuthUser, @Query('at') at?: string, @Query('department_id') dept?: string) {
    if (!uuidOk(dept)) throw new BadRequestException('არასწორი id');
    return this.s.onDuty(u, { at, department_id: dept });
  }
  @Get('my') my(@CurrentUser() u: AuthUser, @Query('month') month?: string) {
    if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new BadRequestException('month — YYYY-MM');
    return this.s.my(u, month);
  }
}

