import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Query, Req, Res, StreamableFile } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsNumber, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import type { Request, Response } from 'express';
import { sql } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { writeXlsxBook, type Cell, type SheetSpec } from '../claims-export/xlsx';
import { CurrentUser } from '../auth/decorators';
import { has, type AuthUser } from '../auth/roles';
import { InjectDb, type Database } from '../database/database.module';
import { NotificationsService } from '../notifications/notifications';
import {
  ABSENCE_HR, CATEGORY_KA, RosterLookup, absenceScope, addDays, canEdit, canHead, isoDow, localDay, localMs, monthDays, rosterEditors, rosterScope, staffName, today, tz, usersWithCaps,
  type Category, type Ex, type RosterSettings, type Trx,
} from './roster-common';
import { RosterService, ddmm, monthLabel, type Roster } from './roster';

const r2 = (x: number) => Math.round(x * 100) / 100;
const half = (x: number) => Math.round(x * 2) / 2;
const fmtH = (h: number) => String(r2(h));
const ATT_KA: Record<string, string> = { plan: 'გეგმით', worked: 'ფაქტი შესწორდა', no_show: 'არ გამოცხადდა' };
/** ტაბელის კოდი „არ გამოცხადდა“ */
export const NO_SHOW = 'გ';

type SInfo = { id: string; name: string; personal_number: string | null; user_id: string | null; department_id: string; department_name: string; position_name: string | null;
  category: string | null; fte: number; hired_on: string | null; left_on: string | null; is_active: boolean };
type TE = { id: string; roster_id: string; staff_id: string; day: string; starts: number; ends: number; hours: number; kind: string; code: string; att: string;
  a_start: number | null; a_end: number | null; a_hours: number | null };
type TA = { id: string; no: string; staff_id: string; type_id: string; code: string; short: string; name: string; paid: boolean; counts_as_work: boolean;
  from: string; to: string; counted: string[]; document_no: string | null };
interface G { month: string; days: string[]; hol: Map<string, string>; staff: Map<string, SInfo>; entries: TE[]; abs: TA[]; s: RosterSettings }
export interface AbsSum { type_id: string; code: string; short: string; name: string; paid: boolean; counts_as_work: boolean; days: number; workdays: number }
export interface Row {
  staff_id: string; name: string; personal_number: string | null; position_name: string | null; category: string | null; department_id: string; department_name: string; fte: number;
  home: boolean; shifts: number; plan_hours: number; worked_hours: number; night_hours: number; holiday_hours: number; weekend_hours: number; no_show: number;
  total_hours: number | null; credit_hours: number | null; norm_hours: number | null; overtime_hours: number | null;
  ot_pay_hours: number | null; ot_comp_hours: number | null; comp_days: number | null;
  person: { night?: number; holiday?: number; weekend?: number; no_show?: number; workdays?: number };
  absence: AbsSum[]; days: Record<string, string>;
}

/**
 * ცვლები / მორიგეობა — საათები / ტაბელი (0079): ფაქტი (გადახრები), ნორმა / ზეგანაკვეთი, ღამის / დღესასწაულის / შაბ.–კვ. საათები,
 * თვის დახურვა (წარდგენა → დახურვა → snapshot; ხელახლა გახსნა), ზეგანაკვეთი → COMP, HR ექსპორტი (Excel), „ჩემი საათები“, კავშირები (lookup).
 */
@Injectable()
export class TimesheetService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService, private readonly notifications: NotificationsService,
    private readonly roster: RosterService, private readonly lookup: RosterLookup) {}
  private settings() { return this.roster.settings(); }

  // ================================================================ წვდომა
  private async access(ex: Ex, u: AuthUser, r: { department_id: string; status: string }) {
    const sc = await rosterScope(ex, u); const as = await absenceScope(ex, u);
    const edit = canEdit(sc, r.department_id);
    const hr = has(u, ...ABSENCE_HR);
    const wide = has(u, 'admin', 'hr', 'roster_all');
    const view = edit || wide || canHead(as, r.department_id) || (has(u, 'accountant') && r.status === 'closed');
    return { edit, hr, view, pii: wide || has(u, 'accountant') };
  }

  // ================================================================ გამოთვლა
  /** თანამშრომლები, გამოქვეყნებული / დახურული განრიგების ჩანაწერები (თვე, ყველა განყოფილება), დადასტურებული არყოფნები, დღესასწაულები */
  async gather(ex: Ex, month: string, staffIds: string[]): Promise<G> {
    const s = await this.settings();
    const days = monthDays(month); const d0 = days[0], d1 = days[days.length - 1];
    const ids = staffIds.length ? staffIds : ['00000000-0000-0000-0000-000000000000'];
    const [staff, entries, abs, hol] = await Promise.all([
      ex.selectFrom('staff_members as s').innerJoin('departments as d', 'd.id', 's.department_id').leftJoin('staff_positions as p', 'p.id', 's.position_id')
        .select(['s.id', staffName('s').as('name'), 's.personal_number', 's.user_id', 's.department_id', 'd.name as department_name', 'p.name as position_name', 'p.category', 's.fte',
          sql<string | null>`to_char(s.hired_on, 'YYYY-MM-DD')`.as('hired_on'), sql<string | null>`to_char(s.left_on, 'YYYY-MM-DD')`.as('left_on'), 's.is_active'])
        .where('s.id', 'in', ids).execute(),
      ex.selectFrom('roster_entries as e').innerJoin('rosters as r', 'r.id', 'e.roster_id').innerJoin('shift_templates as t', 't.id', 'e.shift_template_id')
        .select(['e.id', 'e.roster_id', 'e.staff_id', sql<string>`to_char(e.day, 'YYYY-MM-DD')`.as('day'), 'e.starts_at', 'e.ends_at', 'e.hours', 't.kind', 't.code',
          'e.att_status', 'e.actual_start', 'e.actual_end', 'e.actual_hours'])
        .where('e.staff_id', 'in', ids).where('e.status', '=', 'active').where('r.status', 'in', ['published', 'closed']).where('e.day', '>=', d0).where('e.day', '<=', d1)
        .orderBy('e.starts_at').execute(),
      ex.selectFrom('absence_requests as a').innerJoin('absence_types as t', 't.id', 'a.absence_type_id')
        .select(['a.id', sql<string>`a.no::text`.as('no'), 'a.staff_id', 'a.absence_type_id as type_id', 't.code', 't.short', 't.name', 't.paid', 't.counts_as_work',
          sql<string>`to_char(a.date_from, 'YYYY-MM-DD')`.as('from'), sql<string>`to_char(a.date_to, 'YYYY-MM-DD')`.as('to'),
          sql<string[]>`array(SELECT to_char(x, 'YYYY-MM-DD') FROM unnest(a.counted_days) x ORDER BY 1)`.as('counted'), 'a.document_no'])
        .where('a.staff_id', 'in', ids).where('a.status', '=', 'approved').where('a.date_from', '<=', d1).where('a.date_to', '>=', d0).orderBy('a.date_from').execute(),
      ex.selectFrom('public_holidays').select([sql<string>`to_char(day, 'YYYY-MM-DD')`.as('day'), 'name']).where('day', '>=', addDays(d0, -1)).where('day', '<=', addDays(d1, 2)).execute(),
    ]);
    const t = (v: Date | string | null) => (v === null ? null : new Date(v).getTime());
    return {
      month, days, s, hol: new Map(hol.map((h) => [h.day, h.name])),
      staff: new Map(staff.map((x) => [x.id, { ...x, fte: Number(x.fte) }])),
      entries: entries.map((e) => ({ id: e.id, roster_id: e.roster_id, staff_id: e.staff_id, day: e.day, starts: t(e.starts_at)!, ends: t(e.ends_at)!, hours: Number(e.hours), kind: e.kind, code: e.code,
        att: e.att_status, a_start: t(e.actual_start), a_end: t(e.actual_end), a_hours: e.actual_hours === null ? null : Number(e.actual_hours) })),
      abs,
    };
  }

  /** ფაქტის საათები: არ გამოცხადდა — 0; შესწორებული — actual_hours; სხვა — გეგმა */
  static fact(e: Pick<TE, 'att' | 'hours' | 'a_hours'>) { return e.att === 'no_show' ? 0 : e.att === 'worked' ? e.a_hours ?? 0 : e.hours; }

  /** ინტერვალის გადაფარვა ღამის ფანჯრებთან (night_from–night_to, ადგილობრივი დრო), სთ */
  static nightOverlap(s: number, e: number, from: string, to: string) {
    let h = 0;
    for (let d = addDays(localDay(s), -1); d <= localDay(e); d = addDays(d, 1)) {
      const ws = localMs(d, from); const we = localMs(from < to ? d : addDays(d, 1), to);
      h += Math.max(0, Math.min(e, we) - Math.max(s, ws));
    }
    return h / 36e5;
  }
  /** ინტერვალის გადაფარვა კალენდარულ დღეებთან, რომლებიც პირობას აკმაყოფილებს (დღესასწაული / შაბ.–კვ.), სთ */
  static dayOverlap(s: number, e: number, pred: (d: string) => boolean) {
    let h = 0;
    for (let d = localDay(s); d <= localDay(e); d = addDays(d, 1)) {
      if (!pred(d)) continue;
      h += Math.max(0, Math.min(e, localMs(addDays(d, 1), '00:00')) - Math.max(s, localMs(d, '00:00')));
    }
    return h / 36e5;
  }
  /** ერთი ჩანაწერი: ფაქტი, ღამე, დღესასწაული, შაბ.–კვ. (ფაქტის ინტერვალით, თუ შესწორდა; ჩასათვლელ საათებთან პროპორციულად) */
  private entryCalc(g: G, e: TE) {
    const fact = TimesheetService.fact(e);
    const [s, en] = e.a_start !== null && e.a_end !== null ? [e.a_start, e.a_end] : [e.starts, e.ends];
    const dur = (en - s) / 36e5;
    const k = dur > 0 ? Math.min(1, fact / dur) : 0;
    return {
      fact,
      night: TimesheetService.nightOverlap(s, en, g.s.night_from ?? '22:00', g.s.night_to ?? '06:00') * k,
      holiday: TimesheetService.dayOverlap(s, en, (d) => g.hol.has(d)) * k,
      weekend: TimesheetService.dayOverlap(s, en, (d) => isoDow(d) >= 6) * k,
    };
  }
  /** სამუშაო დღე (ნორმისთვის): ორშ.–პარ., დღესასწაულის გარეშე, შრომითი ურთიერთობის პერიოდში */
  private workday(g: G, st: SInfo, d: string) {
    return isoDow(d) <= 5 && !g.hol.has(d) && (!st.hired_on || d >= st.hired_on) && (!st.left_on || d <= st.left_on);
  }

  /**
   * ტაბელის სტრიქონი. rosterId — ამ განრიგის საათები (უჯრები / ფაქტი / ღამე …); null — ყველა განრიგი.
   * home — ნორმა / ზეგანაკვეთი (ადამიანზე ერთხელ: ყველა განრიგის ფაქტი + „ნამუშევრად ჩათვლილი“ არყოფნა − ნორმა).
   */
  row(g: G, staffId: string, rosterId: string | null, home: boolean): Row | null {
    const st = g.staff.get(staffId);
    if (!st) return null;
    const mine = g.entries.filter((e) => e.staff_id === staffId);
    const own = rosterId ? mine.filter((e) => e.roster_id === rosterId) : mine;
    const days: Record<string, string> = {}; const dayH = new Map<string, number>(); const dayNs = new Set<string>();
    let plan = 0, worked = 0, night = 0, holiday = 0, weekend = 0, noShow = 0;
    for (const e of own) {
      const c = this.entryCalc(g, e);
      plan += e.hours; worked += c.fact; night += c.night; holiday += c.holiday; weekend += c.weekend;
      if (e.att === 'no_show') { noShow++; dayNs.add(e.day); } else dayH.set(e.day, (dayH.get(e.day) ?? 0) + c.fact);
    }
    for (const d of g.days) { if (dayH.has(d)) days[d] = fmtH(dayH.get(d)!); else if (dayNs.has(d)) days[d] = NO_SHOW; }
    // არყოფნა: უჯრის კოდი (უპირატესია), დღეები ტიპით (ერთეულით — ჩათვლილი დღეები), სამუშაო დღეები (ნორმისთვის)
    const absMap = new Map<string, AbsSum>(); let absWd = 0, creditWd = 0;
    for (const a of g.abs.filter((x) => x.staff_id === staffId)) {
      const sum = absMap.get(a.type_id) ?? absMap.set(a.type_id, { type_id: a.type_id, code: a.code, short: a.short, name: a.name, paid: a.paid, counts_as_work: a.counts_as_work, days: 0, workdays: 0 }).get(a.type_id)!;
      const counted = new Set(a.counted);
      for (const d of g.days) {
        if (d < a.from || d > a.to) continue;
        days[d] = a.short;
        if (counted.has(d)) sum.days++;
        if (this.workday(g, st, d)) { sum.workdays++; if (a.counts_as_work) creditWd++; else absWd++; }
      }
    }
    const daily = ((g.s.week_norm_hours ?? 40) / 5) * st.fte;
    const r: Row = {
      staff_id: st.id, name: st.name, personal_number: st.personal_number, position_name: st.position_name, category: st.category, department_id: st.department_id,
      department_name: st.department_name, fte: st.fte, home, shifts: own.length - noShow, plan_hours: r2(plan), worked_hours: r2(worked), night_hours: r2(night), holiday_hours: r2(holiday),
      weekend_hours: r2(weekend), no_show: noShow, total_hours: null, credit_hours: null, norm_hours: null, overtime_hours: null, ot_pay_hours: null, ot_comp_hours: null, comp_days: null,
      person: {}, absence: [...absMap.values()], days,
    };
    if (home) {
      let total = 0, pn = 0, ph = 0, pw = 0, pns = 0;
      for (const e of mine) { const c = this.entryCalc(g, e); total += c.fact; pn += c.night; ph += c.holiday; pw += c.weekend; if (e.att === 'no_show') pns++; }
      const empWd = g.days.filter((d) => this.workday(g, st, d)).length;
      const norm = Math.max(0, (empWd - absWd) * daily); const credit = creditWd * daily;
      const ot = g.s.overtime_basis === 'off' ? 0 : Math.max(0, total + credit - norm);
      Object.assign(r, { total_hours: r2(total), credit_hours: r2(credit), norm_hours: r2(norm), overtime_hours: r2(ot), person: { night: r2(pn), holiday: r2(ph), weekend: r2(pw), no_show: pns, workdays: empWd } });
    }
    return r;
  }

  /** განრიგის სტრიქონები: განყოფილების აქტიური თანამშრომლები (ძირითადი / დამატებითი) + ვისაც ამ განრიგში ჩანაწერი აქვს */
  private async rosterStaff(ex: Ex, r: Roster) {
    const rows = await ex.selectFrom('staff_members as s').leftJoin('staff_positions as p', 'p.id', 's.position_id').select(['s.id'])
      .where((eb) => eb.or([
        eb.and([eb('s.is_active', '=', true), eb.or([eb('s.department_id', '=', r.department_id),
          eb.exists(eb.selectFrom('staff_member_departments as x').select('x.staff_id').whereRef('x.staff_id', '=', 's.id').where('x.department_id', '=', r.department_id))])]),
        eb.exists(eb.selectFrom('roster_entries as e').select('e.id').whereRef('e.staff_id', '=', 's.id').where('e.roster_id', '=', r.id).where('e.status', '=', 'active'))]))
      .orderBy(sql`p.sort_order NULLS LAST`).orderBy('s.last_name').orderBy('s.first_name').execute();
    return rows.map((x) => x.id);
  }

  /** ცოცხალი ტაბელი (გამოქვეყნებული / დახურვამდე) */
  async live(ex: Ex, r: Roster) {
    const ids = await this.rosterStaff(ex, r);
    const g = await this.gather(ex, r.month, ids);
    const rows = ids.map((id) => this.row(g, id, r.id, g.staff.get(id)?.department_id === r.department_id)).filter((x): x is Row => !!x);
    // „ზეგანაკვეთი → COMP“ ნაგულისხმევი (overtime_default)
    for (const x of rows) if (x.home && x.overtime_hours !== null) this.split(g.s, x, g.s.overtime_default === 'comp' ? x.overtime_hours : 0);
    return { g, rows };
  }
  private split(s: RosterSettings, x: Row, comp: number) {
    const ot = x.overtime_hours ?? 0; const c = Math.min(ot, Math.max(0, comp));
    const daily = ((s.week_norm_hours ?? 40) / 5) * x.fte;
    x.ot_comp_hours = r2(c); x.ot_pay_hours = r2(ot - c); x.comp_days = c > 0 && daily > 0 ? half(c / daily) : 0;
  }
  /** დახურვის snapshot → სტრიქონები (სახელები / პოზიციები — მიმდინარე ცნობარიდან) */
  private async snapshot(ex: Ex, r: Roster): Promise<Row[]> {
    const rows = await ex.selectFrom('roster_timesheets as t').innerJoin('staff_members as s', 's.id', 't.staff_id').innerJoin('departments as d', 'd.id', 's.department_id')
      .leftJoin('staff_positions as p', 'p.id', 's.position_id')
      .select(['t.staff_id', staffName('s').as('name'), 's.personal_number', 'p.name as position_name', 'p.category', 's.department_id', 'd.name as department_name', 't.fte', 't.home', 't.shifts',
        't.plan_hours', 't.worked_hours', 't.night_hours', 't.holiday_hours', 't.weekend_hours', 't.no_show', 't.total_hours', 't.credit_hours', 't.norm_hours', 't.overtime_hours',
        't.ot_pay_hours', 't.ot_comp_hours', 't.comp_days', 't.absence', 't.days', 't.person'])
      .where('t.roster_id', '=', r.id).orderBy(sql`p.sort_order NULLS LAST`).orderBy('s.last_name').orderBy('s.first_name').execute();
    const n = (v: string | null) => (v === null ? null : Number(v));
    return rows.map((x) => ({ ...x, fte: Number(x.fte), plan_hours: Number(x.plan_hours), worked_hours: Number(x.worked_hours), night_hours: Number(x.night_hours), holiday_hours: Number(x.holiday_hours),
      weekend_hours: Number(x.weekend_hours), total_hours: n(x.total_hours), credit_hours: n(x.credit_hours), norm_hours: n(x.norm_hours), overtime_hours: n(x.overtime_hours),
      ot_pay_hours: n(x.ot_pay_hours), ot_comp_hours: n(x.ot_comp_hours), comp_days: n(x.comp_days),
      absence: x.absence as unknown as AbsSum[], days: x.days as unknown as Record<string, string>, person: x.person as unknown as Row['person'] }));
  }
  /** დახურვის შემდეგ შეცვლილი არყოფნები (თვეში, ტაბელის თანამშრომლებზე) — „მოძველებულია“ */
  private async stale(ex: Ex, r: Roster, closedAt: Date | string | null) {
    if (!closedAt) return [];
    const days = monthDays(r.month);
    return ex.selectFrom('absence_requests as a').innerJoin('roster_timesheets as t', (j) => j.onRef('t.staff_id', '=', 'a.staff_id').on('t.roster_id', '=', r.id))
      .innerJoin('staff_members as s', 's.id', 'a.staff_id')
      .select([sql<string>`a.no::text`.as('no'), staffName('s').as('staff_name'), 'a.status', sql<string>`to_char(a.date_from, 'YYYY-MM-DD')`.as('date_from'), sql<string>`to_char(a.date_to, 'YYYY-MM-DD')`.as('date_to')])
      .where('a.updated_at', '>', new Date(closedAt)).where('a.date_from', '<=', days[days.length - 1]).where('a.date_to', '>=', days[0])
      .where('a.status', 'in', ['approved', 'cancelled']).execute();
  }
  /** განხილვაში მყოფი არყოფნები თვეში (ტაბელის თანამშრომლებზე) — დახურვას / წარდგენას აჩერებს */
  private async pending(ex: Ex, r: Roster, staffIds: string[]) {
    if (!staffIds.length) return [];
    const days = monthDays(r.month);
    return ex.selectFrom('absence_requests as a').innerJoin('staff_members as s', 's.id', 'a.staff_id')
      .select([sql<string>`a.no::text`.as('no'), staffName('s').as('staff_name'), 'a.status']).where('a.staff_id', 'in', staffIds).where('a.status', 'in', ['head', 'hr'])
      .where('a.date_from', '<=', days[days.length - 1]).where('a.date_to', '>=', days[0]).execute();
  }
  private ended(r: Roster) { const d = monthDays(r.month); return today() > d[d.length - 1]; }

  // ================================================================ ტაბელი (ეკრანი)
  async timesheet(id: string, u: AuthUser) {
    await this.settings();
    const r = await this.roster.roster(this.db, id);
    const a = await this.access(this.db, u, r);
    if (!a.view) throw new ForbiddenException('ტაბელზე წვდომა არ გაქვთ');
    if (r.status === 'draft') throw new ConflictException({ code: 'ROSTER_NOT_PUBLISHED', message: 'ტაბელი — გამოქვეყნების შემდეგ' });
    const meta = await this.db.selectFrom('rosters as r').leftJoin('users as su', 'su.id', 'r.timesheet_submitted_by').leftJoin('users as cu', 'cu.id', 'r.closed_by')
      .select(['r.timesheet_submitted_at', 'r.closed_at', 'r.close_note', sql<string | null>`su.last_name || ' ' || su.first_name`.as('submitted_by_name'),
        sql<string | null>`cu.last_name || ' ' || cu.first_name`.as('closed_by_name')]).where('r.id', '=', id).executeTakeFirstOrThrow();
    const s = await this.settings();
    let rows: Row[]; let hol: Map<string, string>;
    if (r.status === 'closed') {
      rows = await this.snapshot(this.db, r);
      hol = new Map((await this.db.selectFrom('public_holidays').select([sql<string>`to_char(day, 'YYYY-MM-DD')`.as('day'), 'name']).where('day', '>=', r.month).where('day', '<=', monthDays(r.month).at(-1)!).execute()).map((h) => [h.day, h.name]));
    } else ({ rows, g: { hol } } = await this.live(this.db, r));
    if (!a.pii) rows = rows.map((x) => ({ ...x, personal_number: null }));
    const [stale, pend, open] = await Promise.all([
      r.status === 'closed' ? this.stale(this.db, r, meta.closed_at) : Promise.resolve([]),
      r.status === 'closed' ? Promise.resolve([]) : this.pending(this.db, r, rows.map((x) => x.staff_id)),
      this.db.selectFrom('roster_open_shifts').select(sql<number>`count(*)::int`.as('n')).where('roster_id', '=', r.id).where('status', '=', 'open').executeTakeFirstOrThrow(),
    ]);
    const days = monthDays(r.month).map((d) => ({ day: d, dow: isoDow(d), holiday: hol.get(d) ?? null }));
    const sum = (k: keyof Row) => r2(rows.reduce((acc, x) => acc + (Number(x[k]) || 0), 0));
    const ended = this.ended(r);
    return {
      roster: { ...r, ...meta }, source: r.status === 'closed' ? 'snapshot' : 'live', preliminary: r.status !== 'closed', ended, stale,
      settings: { week_norm_hours: s.week_norm_hours, overtime_basis: s.overtime_basis, overtime_default: s.overtime_default, night_from: s.night_from, night_to: s.night_to,
        close_requires_submit: s.close_requires_submit, comp_absence_type: s.comp_absence_type },
      workdays: days.filter((d) => d.dow <= 5 && !d.holiday).length, days, rows,
      totals: { plan_hours: sum('plan_hours'), worked_hours: sum('worked_hours'), overtime_hours: sum('overtime_hours'), night_hours: sum('night_hours'), holiday_hours: sum('holiday_hours'),
        weekend_hours: sum('weekend_hours'), no_show: sum('no_show'), norm_hours: sum('norm_hours'), ot_comp_hours: sum('ot_comp_hours') },
      checks: { pending: pend, open_shifts: open.n, no_show: sum('no_show') },
      can: {
        actual: a.edit && r.status === 'published',
        submit: a.edit && r.status === 'published' && ended && !meta.timesheet_submitted_at,
        close: a.hr && r.status === 'published' && ended && (!s.close_requires_submit || !!meta.timesheet_submitted_at),
        reopen: a.hr && r.status === 'closed', export: true, pii: a.pii,
      },
    };
  }

  /** HR / შემდგენის მიმოხილვა: თვის განრიგები — წარდგენა / დახურვა / მოძველებული */
  async overview(u: AuthUser, month: string) {
    await this.settings();
    const sc = await rosterScope(this.db, u); const as = await absenceScope(this.db, u);
    const wide = has(u, 'admin', 'hr', 'roster_all'); const acc = has(u, 'accountant');
    const m = `${month}-01`;
    const rows = await this.db.selectFrom('rosters as r').innerJoin('departments as d', 'd.id', 'r.department_id')
      .select(['r.id', 'r.department_id', 'd.name as department_name', 'r.status', 'r.timesheet_submitted_at', 'r.closed_at',
        sql<number>`(SELECT count(DISTINCT e.staff_id)::int FROM roster_entries e WHERE e.roster_id = r.id AND e.status = 'active')`.as('staff'),
        sql<number>`(SELECT count(*)::int FROM roster_entries e WHERE e.roster_id = r.id AND e.status = 'active' AND e.att_status <> 'plan')`.as('actuals'),
        sql<string | null>`(SELECT sum(t.overtime_hours)::text FROM roster_timesheets t WHERE t.roster_id = r.id)`.as('overtime')])
      .where('r.month', '=', m).where('r.status', 'in', ['published', 'closed']).orderBy('d.name').execute();
    const vis = rows.filter((x) => wide || canEdit(sc, x.department_id) || canHead(as, x.department_id) || (acc && x.status === 'closed'));
    const out = [];
    for (const x of vis) {
      const r: Roster = { id: x.id, department_id: x.department_id, month: m, status: x.status, version: 0, department_name: x.department_name };
      const st = x.status === 'closed' ? await this.stale(this.db, r, x.closed_at) : [];
      out.push({ ...x, overtime: x.overtime === null ? null : Number(x.overtime), stale: st.length });
    }
    const ended = today() > monthDays(m).at(-1)!;
    return { month, ended, rows: out, can: { export_all: wide || acc, close: has(u, ...ABSENCE_HR) } };
  }

  // ================================================================ ფაქტი
  async setActual(id: string, d: ActualDto, u: AuthUser, ctx: AuditContext) {
    await this.settings();
    return this.db.transaction().execute(async (trx) => {
      const e = await trx.selectFrom('roster_entries as e').innerJoin('shift_templates as t', 't.id', 'e.shift_template_id')
        .select(['e.id', 'e.roster_id', 'e.staff_id', sql<string>`to_char(e.day, 'YYYY-MM-DD')`.as('day'), 'e.status', 'e.hours', 'e.att_status', 'e.actual_hours', 'e.starts_at', 'e.ends_at',
          't.code', 't.kind', 't.break_min'])
        .where('e.id', '=', id).forUpdate('e').executeTakeFirst();
      if (!e || e.status !== 'active') throw new NotFoundException('ჩანაწერი ვერ მოიძებნა');
      const r = await this.roster.roster(trx, e.roster_id, true);
      const a = await this.access(trx, u, r);
      if (!a.edit) throw new ForbiddenException('ამ განყოფილების განრიგის მართვის უფლება არ გაქვთ');
      if (r.status === 'draft') throw new ConflictException({ code: 'ROSTER_NOT_PUBLISHED', message: 'ფაქტი — მხოლოდ გამოქვეყნებულ განრიგში' });
      if (r.status === 'closed') throw new ConflictException({ code: 'ROSTER_CLOSED', message: 'თვე დახურულია — ფაქტის შესწორება შეუძლებელია (HR: ხელახლა გახსნა)' });
      if (e.day > today()) throw new ConflictException({ code: 'ACTUAL_FUTURE', message: 'ფაქტი — მხოლოდ დღევანდელ / წარსულ ცვლაზე' });
      const set: Record<string, unknown> = { att_status: d.status, actual_start: null, actual_end: null, actual_hours: null, actual_note: d.note?.trim() || null, actual_by: u.id, actual_at: sql`now()` };
      let hours = d.status === 'no_show' ? 0 : Number(e.hours);
      if (d.status === 'worked') {
        if (!!d.start_time !== !!d.end_time) throw new BadRequestException('დრო: დასაწყისი და დასასრული ერთად');
        if (!d.start_time && (d.hours === undefined || d.hours === null)) throw new BadRequestException({ code: 'ACTUAL_EMPTY', message: 'მიუთითეთ რეალური დრო ან საათები' });
        let dur: number | null = null;
        if (d.start_time && d.end_time) {
          // დაწყება: ცვლის დღე (ან წინა დღე, თუ დაწყება გეგმაზე > 12 სთ-ით გვიანდელია — მაგ. 23:30 → 00:10 ცვლაზე)
          let s = localMs(e.day, d.start_time);
          if (s - new Date(e.starts_at).getTime() > 12 * 36e5) s = localMs(addDays(e.day, -1), d.start_time);
          let en = localMs(localDay(s), d.end_time); if (en <= s) en = localMs(addDays(localDay(s), 1), d.end_time);
          dur = (en - s) / 36e5;
          if (dur > 48) throw new BadRequestException('ფაქტის ხანგრძლივობა > 48 სთ');
          Object.assign(set, { actual_start: new Date(s), actual_end: new Date(en) });
        }
        if (d.hours !== undefined && d.hours !== null) {
          if (dur !== null && d.hours > dur + 1e-9) throw new BadRequestException(`საათები (${d.hours}) ინტერვალზე (${r2(dur)}) მეტია`);
          hours = d.hours;
        } else if (e.kind === 'oncall_home') throw new BadRequestException({ code: 'ACTUAL_HOURS', message: '„მორიგეობა სახლიდან“ — მიუთითეთ გამოძახებით ნამუშევარი საათები' });
        else hours = Math.max(0, dur! - e.break_min / 60);
        set.actual_hours = String(r2(hours));
      }
      if (d.status === 'plan') Object.assign(set, { actual_note: null, actual_by: null, actual_at: null });
      await trx.updateTable('roster_entries').set(set).where('id', '=', e.id).execute();
      const prev = { status: e.att_status, hours: e.att_status === 'worked' ? Number(e.actual_hours) : e.att_status === 'no_show' ? 0 : Number(e.hours) };
      await trx.insertInto('roster_changes').values({ roster_id: r.id, entry_id: e.id, staff_id: e.staff_id, kind: 'actual', reason: d.reason.trim(),
        data: JSON.stringify({ day: e.day, code: e.code, status: d.status, hours: r2(hours), plan: Number(e.hours), prev }), user_id: u.id }).execute();
      await this.audit.log(ctx, { action: 'ROSTER_ACTUAL', entityName: 'roster_entries', entityId: e.id, oldData: prev, newData: { ...d, hours: r2(hours) } }, trx);
      return { ok: true, status: d.status, hours: r2(hours), label: ATT_KA[d.status] };
    });
  }

  // ================================================================ წარდგენა / დახურვა / ხელახლა გახსნა
  async submit(id: string, d: { note?: string | null }, u: AuthUser, ctx: AuditContext) {
    await this.settings();
    const res = await this.db.transaction().execute(async (trx) => {
      const r = await this.roster.roster(trx, id, true);
      const a = await this.access(trx, u, r);
      if (!a.edit) throw new ForbiddenException('ტაბელს წარადგენს განყოფილების განრიგის შემდგენი');
      this.needOpen(r);
      if (!this.ended(r)) throw new ConflictException({ code: 'TIMESHEET_EARLY', message: 'თვე ჯერ არ დასრულებულა' });
      const cur = await trx.selectFrom('rosters').select('timesheet_submitted_at').where('id', '=', r.id).executeTakeFirstOrThrow();
      if (cur.timesheet_submitted_at) throw new ConflictException({ code: 'TIMESHEET_SUBMITTED', message: 'ტაბელი უკვე წარდგენილია' });
      const p = await this.pending(trx, r, await this.rosterStaff(trx, r));
      if (p.length) throw new ConflictException({ code: 'TIMESHEET_PENDING', message: `თვეში განხილვაშია არყოფნის მოთხოვნა: ${p.map((x) => `#${x.no} ${x.staff_name}`).join(', ')}`, pending: p });
      await trx.updateTable('rosters').set({ timesheet_submitted_at: sql`now()`, timesheet_submitted_by: u.id }).where('id', '=', r.id).execute();
      await trx.insertInto('roster_changes').values({ roster_id: r.id, kind: 'submit', reason: d.note?.trim() || null, user_id: u.id }).execute();
      await this.audit.log(ctx, { action: 'SUBMIT_TIMESHEET', entityName: 'rosters', entityId: r.id, newData: d }, trx);
      return r;
    });
    for (const x of await usersWithCaps(this.db, ['hr'])) if (x !== u.id) await this.notifications.notify(x, { kind: 'timesheet_submitted', title: `ტაბელი წარდგენილია: ${res.department_name} · ${monthLabel(res.month)}`,
      body: 'შეამოწმეთ და დახურეთ თვე', link: `/roster?tab=hours&month=${res.month.slice(0, 7)}&dept=${res.department_id}`, entityId: res.id });
    return { ok: true };
  }
  private needOpen(r: Roster) {
    if (r.status === 'draft') throw new ConflictException({ code: 'ROSTER_NOT_PUBLISHED', message: 'განრიგი ჯერ არ გამოქვეყნებულა' });
    if (r.status === 'closed') throw new ConflictException({ code: 'ROSTER_CLOSED', message: 'თვე უკვე დახურულია' });
  }

  async close(id: string, d: CloseDto, u: AuthUser, ctx: AuditContext) {
    await this.settings();
    if (!has(u, ...ABSENCE_HR)) throw new ForbiddenException('თვეს ხურავს HR');
    const res = await this.db.transaction().execute(async (trx) => {
      const r = await this.roster.roster(trx, id, true);
      this.needOpen(r);
      if (!this.ended(r)) throw new ConflictException({ code: 'TIMESHEET_EARLY', message: 'თვე ჯერ არ დასრულებულა' });
      const s = await this.settings();
      const cur = await trx.selectFrom('rosters').select('timesheet_submitted_at').where('id', '=', r.id).executeTakeFirstOrThrow();
      if (s.close_requires_submit && !cur.timesheet_submitted_at) throw new ConflictException({ code: 'TIMESHEET_NOT_SUBMITTED', message: 'ტაბელი ჯერ არ წარუდგენია განყოფილებას (შემდგენი → „წარდგენა“)' });
      const { rows } = await this.live(trx, r);
      const p = await this.pending(trx, r, rows.map((x) => x.staff_id));
      if (p.length) throw new ConflictException({ code: 'TIMESHEET_PENDING', message: `თვეში განხილვაშია არყოფნის მოთხოვნა: ${p.map((x) => `#${x.no} ${x.staff_name}`).join(', ')}`, pending: p });
      const open = (await trx.selectFrom('roster_open_shifts').select(sql<number>`count(*)::int`.as('n')).where('roster_id', '=', r.id).where('status', '=', 'open').executeTakeFirstOrThrow()).n;
      const noShow = rows.reduce((a, x) => a + x.no_show, 0);
      if ((open || noShow) && !d.confirm_warnings) throw new ConflictException({ code: 'TIMESHEET_WARNINGS', message: `შეუვსებელი დასაფარი — ${open}, „არ გამოცხადდა“ — ${noShow}. დაადასტურეთ დახურვა`, open_shifts: open, no_show: noShow });
      // ზეგანაკვეთი → COMP (HR-ის არჩევანი; დანარჩენი — overtime_default)
      for (const c of d.comp ?? []) {
        const x = rows.find((y) => y.staff_id === c.staff_id && y.home);
        if (!x) throw new BadRequestException(`COMP: თანამშრომელი ამ ტაბელში (ძირითადი განყოფილება) არ არის`);
        if (c.hours > (x.overtime_hours ?? 0) + 1e-9) throw new BadRequestException(`COMP: ${x.name} — ${c.hours} სთ > ზეგანაკვეთი ${x.overtime_hours}`);
        this.split(s, x, c.hours);
      }
      const comp = rows.filter((x) => (x.comp_days ?? 0) > 0);
      let typeId: string | null = null;
      if (comp.length) {
        const ty = await trx.selectFrom('absence_types').select(['id', 'has_balance', 'is_active']).where('code', '=', s.comp_absence_type).executeTakeFirst();
        if (!ty?.has_balance) throw new BadRequestException({ code: 'COMP_TYPE', message: `COMP ტიპი „${s.comp_absence_type}“ ვერ მოიძებნა ან ბალანსი არ აქვს (პარამეტრი comp_absence_type)` });
        typeId = ty.id;
      }
      if (rows.length) await trx.insertInto('roster_timesheets').values(rows.map((x) => ({
        roster_id: r.id, staff_id: x.staff_id, home: x.home, fte: String(x.fte), shifts: x.shifts, plan_hours: String(x.plan_hours), worked_hours: String(x.worked_hours),
        night_hours: String(x.night_hours), holiday_hours: String(x.holiday_hours), weekend_hours: String(x.weekend_hours), no_show: x.no_show,
        total_hours: x.total_hours === null ? null : String(x.total_hours), credit_hours: x.credit_hours === null ? null : String(x.credit_hours),
        norm_hours: x.norm_hours === null ? null : String(x.norm_hours), overtime_hours: x.overtime_hours === null ? null : String(x.overtime_hours),
        ot_pay_hours: x.ot_pay_hours === null ? null : String(x.ot_pay_hours), ot_comp_hours: x.ot_comp_hours === null ? null : String(x.ot_comp_hours),
        comp_days: x.comp_days === null ? null : String(x.comp_days), absence: JSON.stringify(x.absence), days: JSON.stringify(x.days), person: JSON.stringify(x.person) }))).execute();
      const year = Number(r.month.slice(0, 4));
      for (const x of comp) await trx.insertInto('absence_balance_entries').values({ staff_id: x.staff_id, absence_type_id: typeId!, year, kind: 'comp', days: String(x.comp_days), roster_id: r.id,
        reason: `ზეგანაკვეთი ${x.ot_comp_hours} სთ → ნაცვლად დასვენება: ${r.department_name} · ${monthLabel(r.month)}`, user_id: u.id }).execute();
      await trx.updateTable('rosters').set({ status: 'closed', closed_at: sql`now()`, closed_by: u.id, close_note: d.note?.trim() || null }).where('id', '=', r.id).execute();
      const totals = { staff: rows.length, worked: r2(rows.reduce((a, x) => a + x.worked_hours, 0)), overtime: r2(rows.reduce((a, x) => a + (x.overtime_hours ?? 0), 0)),
        comp_days: rows.reduce((a, x) => a + (x.comp_days ?? 0), 0), open_shifts: open, no_show: noShow };
      await trx.insertInto('roster_changes').values({ roster_id: r.id, kind: 'close', reason: d.note?.trim() || null, data: JSON.stringify(totals), user_id: u.id }).execute();
      await this.audit.log(ctx, { action: 'CLOSE_ROSTER', entityName: 'rosters', entityId: r.id, newData: { ...totals, comp: d.comp ?? [] } }, trx);
      const users = comp.length ? await trx.selectFrom('staff_members').select(['id', 'user_id']).where('id', 'in', comp.map((x) => x.staff_id)).where('user_id', 'is not', null).execute() : [];
      return { r, totals, comp: comp.map((x) => ({ user: users.find((y) => y.id === x.staff_id)?.user_id ?? null, days: x.comp_days, hours: x.ot_comp_hours })) };
    });
    for (const x of await rosterEditors(this.db, res.r.department_id)) if (x !== u.id) await this.notifications.notify(x, { kind: 'timesheet_closed', title: `თვე დაიხურა: ${res.r.department_name} · ${monthLabel(res.r.month)}`,
      link: `/roster?tab=hours&month=${res.r.month.slice(0, 7)}&dept=${res.r.department_id}`, entityId: res.r.id });
    for (const c of res.comp) if (c.user) await this.notifications.notify(c.user, { kind: 'comp_added', title: `ნაცვლად დასვენება: +${c.days} დღე (ზეგანაკვეთი ${c.hours} სთ, ${monthLabel(res.r.month)})`,
      link: '/roster?tab=my&sub=absence', entityId: res.r.id });
    return { ok: true, ...res.totals };
  }

  async reopen(id: string, reason: string, u: AuthUser, ctx: AuditContext) {
    await this.settings();
    if (!has(u, ...ABSENCE_HR)) throw new ForbiddenException('თვეს ხელახლა ხსნის HR');
    const r = await this.db.transaction().execute(async (trx) => {
      const r = await this.roster.roster(trx, id, true);
      if (r.status !== 'closed') throw new ConflictException({ code: 'ROSTER_NOT_CLOSED', message: 'თვე დახურული არ არის' });
      // COMP — საპირისპირო ჩანაწერი (ჟურნალი მხოლოდ INSERT)
      const comp = await trx.selectFrom('absence_balance_entries').select(['staff_id', 'absence_type_id', 'year', sql<string>`sum(days)`.as('d')]).where('roster_id', '=', r.id).where('kind', '=', 'comp')
        .groupBy(['staff_id', 'absence_type_id', 'year']).execute();
      for (const c of comp) if (Number(c.d) !== 0) await trx.insertInto('absence_balance_entries').values({ staff_id: c.staff_id, absence_type_id: c.absence_type_id, year: c.year, kind: 'comp',
        days: String(-Number(c.d)), roster_id: r.id, reason: `თვე ხელახლა გაიხსნა: ${reason.trim()}`, user_id: u.id }).execute();
      await trx.deleteFrom('roster_timesheets').where('roster_id', '=', r.id).execute();
      await trx.updateTable('rosters').set({ status: 'published', closed_at: null, closed_by: null }).where('id', '=', r.id).execute();
      await trx.insertInto('roster_changes').values({ roster_id: r.id, kind: 'reopen', reason: reason.trim(), data: JSON.stringify({ comp_reversed: comp.length }), user_id: u.id }).execute();
      await this.audit.log(ctx, { action: 'REOPEN_ROSTER', entityName: 'rosters', entityId: r.id, newData: { reason, comp_reversed: comp.length } }, trx);
      return r;
    });
    for (const x of await rosterEditors(this.db, r.department_id)) if (x !== u.id) await this.notifications.notify(x, { kind: 'timesheet_reopened', title: `თვე ხელახლა გაიხსნა: ${r.department_name} · ${monthLabel(r.month)}`,
      body: reason.trim(), link: `/roster?tab=hours&month=${r.month.slice(0, 7)}&dept=${r.department_id}`, entityId: r.id });
    return { ok: true };
  }

  // ================================================================ HR ექსპორტი (Excel)
  async export(u: AuthUser, q: { month: string; department_id?: string }, req: Request) {
    await this.settings();
    const m = `${q.month}-01`;
    let rosters: Roster[];
    const wide = has(u, 'admin', 'hr', 'roster_all'); const acc = has(u, 'accountant');
    if (q.department_id) {
      const x = await this.db.selectFrom('rosters').select('id').where('department_id', '=', q.department_id).where('month', '=', m).executeTakeFirst();
      if (!x) throw new NotFoundException('ამ განყოფილებას ამ თვის განრიგი არ აქვს');
      const r = await this.roster.roster(this.db, x.id);
      if (!(await this.access(this.db, u, r)).view) throw new ForbiddenException('ტაბელზე წვდომა არ გაქვთ');
      if (r.status === 'draft') throw new ConflictException({ code: 'ROSTER_NOT_PUBLISHED', message: 'ტაბელი — გამოქვეყნების შემდეგ' });
      rosters = [r];
    } else {
      if (!wide && !acc) throw new ForbiddenException('მთელი კლინიკის ტაბელი — HR / ბუღალტერია');
      const ids = await this.db.selectFrom('rosters').select('id').where('month', '=', m).where('status', 'in', acc && !wide ? ['closed'] : ['published', 'closed']).execute();
      rosters = [];
      for (const x of ids) rosters.push(await this.roster.roster(this.db, x.id));
      rosters.sort((a, b) => a.department_name.localeCompare(b.department_name));
    }
    const pii = wide || acc;
    const blocks: { r: Roster; rows: Row[] }[] = [];
    for (const r of rosters) blocks.push({ r, rows: r.status === 'closed' ? await this.snapshot(this.db, r) : (await this.live(this.db, r)).rows });
    // ჯამები ადამიანზე: ძირითადი განყოფილების სტრიქონი (ნორმა / ზეგანაკვეთი); თუ ძირითად განყოფილებას განრიგი არ აქვს — ყველა განრიგით ცოცხლად
    const people = new Map<string, Row & { status: string; dept: string }>();
    for (const b of blocks) for (const x of b.rows) if (x.home) people.set(x.staff_id, { ...x, status: b.r.status, dept: b.r.department_name });
    const orphans = [...new Set(blocks.flatMap((b) => b.rows.filter((x) => !x.home).map((x) => x.staff_id)))].filter((id) => !people.has(id));
    if (orphans.length) {
      const g = await this.gather(this.db, m, orphans);
      for (const id of orphans) { const x = this.row(g, id, null, true); if (x) { this.split(g.s, x, 0); people.set(id, { ...x, status: 'no_home', dept: x.department_name }); } }
    }
    const allIds = [...new Set(blocks.flatMap((b) => b.rows.map((x) => x.staff_id)))];
    const g = await this.gather(this.db, m, allIds);
    const clinic = (await this.db.selectFrom('clinic_settings').select('name').where('id', '=', 1).executeTakeFirst())?.name ?? '';
    const scope = q.department_id ? rosters[0].department_name : 'მთელი კლინიკა';
    const closedAll = rosters.length > 0 && rosters.every((r) => r.status === 'closed');
    const title = `ტაბელი · ${monthLabel(m)} · ${scope} · ${closedAll ? 'დახურული' : 'წინასწარი (თვე ჯერ არ დახურულა)'}`;
    const days = monthDays(m);
    const num = (v: number | null | undefined): Cell => (v === null || v === undefined ? null : { v: r2(v), fmt: '0.##' });
    const cellOf = (s: string | undefined): Cell => (s === undefined ? null : /^\d+(\.\d+)?$/.test(s) ? { v: Number(s), fmt: '0.##' } : s);
    // 1. ტაბელი
    const t: Cell[][] = [[clinic], [title], [`კოდები: ${[...new Set(g.abs.map((a) => `${a.short} — ${a.name}`))].join('; ') || '—'}; ${NO_SHOW} — არ გამოცხადდა; რიცხვი — ნამუშევარი საათები`], []];
    const bold: number[] = [1];
    for (const b of blocks) {
      bold.push(t.length); t.push([`${b.r.department_name} — ${b.r.status === 'closed' ? 'დახურული' : 'წინასწარი'}`]);
      bold.push(t.length); t.push(['№', 'გვარი, სახელი', 'პოზიცია', 'FTE', ...days.map((d) => `${Number(d.slice(8))}`), 'ფაქტი, სთ', 'ნორმა', 'ზეგანაკვ.', 'ღამე', 'დღესასწ.', 'შაბ.–კვ.', NO_SHOW]);
      b.rows.forEach((x, i) => t.push([i + 1, `${x.name}${x.home ? '' : ' (დამ.)'}`, x.position_name ?? '', num(x.fte), ...days.map((d) => cellOf(x.days[d])), num(x.worked_hours), num(x.norm_hours),
        num(x.overtime_hours), num(x.night_hours), num(x.holiday_hours), num(x.weekend_hours), x.no_show || null]));
      t.push([]);
    }
    t.push(['შემდგენი: ____________________', '', '', '', '', '', '', '', 'ხელმძღვანელი: ____________________', '', '', '', '', '', '', '', 'HR: ____________________']);
    // 2. ჯამები
    const types = [...new Map(g.abs.map((a) => [a.type_id, a])).values()];
    const sum: Cell[][] = [[clinic], [title], [], ['პირადი №', 'გვარი, სახელი', 'განყოფილება', 'პოზიცია', 'კატეგორია', 'FTE', 'სამუშაო დღე', 'ნორმა, სთ', 'ფაქტი, სთ', 'ჩათვლ. არყოფნა, სთ',
      'ზეგანაკვეთი, სთ', 'ანაზღაურება, სთ', 'COMP, სთ', 'COMP, დღე', 'ღამე, სთ', 'დღესასწ., სთ', 'შაბ.–კვ., სთ', 'გაცდენა', ...types.map((ty) => `${ty.short} — ${ty.name}`),
      'ანაზღ. არყოფნა, დღე', 'ანაზღ. გარეშე, დღე', 'სტატუსი']];
    const ST: Record<string, string> = { closed: 'დახურული', published: 'წინასწარი', no_home: 'ძირ. განყოფილების განრიგის გარეშე' };
    for (const x of [...people.values()].sort((a, b) => a.dept.localeCompare(b.dept) || a.name.localeCompare(b.name))) {
      const ab = (id: string) => x.absence.find((a) => a.type_id === id)?.days ?? null;
      sum.push([pii ? x.personal_number ?? '' : '', x.name, x.department_name, x.position_name ?? '', x.category ? CATEGORY_KA[x.category as Category] ?? x.category : '', num(x.fte), x.person.workdays ?? null,
        num(x.norm_hours), num(x.total_hours), num(x.credit_hours), num(x.overtime_hours), num(x.ot_pay_hours), num(x.ot_comp_hours), num(x.comp_days), num(x.person.night ?? x.night_hours),
        num(x.person.holiday ?? x.holiday_hours), num(x.person.weekend ?? x.weekend_hours), (x.person.no_show ?? x.no_show) || null, ...types.map((ty) => ab(ty.type_id)),
        x.absence.filter((a) => a.paid).reduce((a, y) => a + y.days, 0) || null, x.absence.filter((a) => !a.paid).reduce((a, y) => a + y.days, 0) || null, ST[x.status] ?? x.status]);
    }
    // 3. არყოფნები
    const ab: Cell[][] = [[clinic], [title], [], ['#', 'თანამშრომელი', 'განყოფილება', 'ტიპი', 'დან', 'მდე', 'დღეები (თვეში)', 'ანაზღაურებადი', 'ნამუშევრად ითვლება', 'დოკუმენტი №']];
    for (const a of g.abs) {
      const st = g.staff.get(a.staff_id);
      ab.push([`#${a.no}`, st?.name ?? '', st?.department_name ?? '', a.name, a.from, a.to, a.counted.filter((d) => d.slice(0, 7) === m.slice(0, 7)).length, a.paid ? 'კი' : 'არა', a.counts_as_work ? 'კი' : 'არა', a.document_no ?? '']);
    }
    const sheets: SheetSpec[] = [
      { name: 'ტაბელი', rows: t, boldRows: bold, widths: [5, 28, 22, 6, ...days.map(() => 4.5), 9, 8, 9, 7, 8, 8, 4] },
      { name: 'ჯამები', rows: sum, boldRows: [1, 3], widths: [13, 28, 22, 22, 14, 6, 8, 9, 9, 10, 10, 10, 9, 9, 8, 9, 9, 8, ...types.map(() => 10), 10, 10, 18] },
      { name: 'არყოფნები', rows: ab, boldRows: [1, 3], widths: [8, 28, 22, 30, 11, 11, 10, 10, 10, 14] },
    ];
    await this.audit.log(auditCtx(req), { action: 'TIMESHEET_EXPORT', entityName: 'rosters', entityId: q.department_id ? rosters[0]?.id ?? 'none' : 'all', newData: { month: q.month, department_id: q.department_id ?? null, rosters: rosters.length } });
    return { name: `timesheet_${q.month}${q.department_id ? `_${rosters[0].department_name.replace(/[^\p{L}\p{N}]+/gu, '_')}` : ''}.xlsx`,
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: writeXlsxBook(sheets) };
  }

  // ================================================================ ჩემი საათები (თანამშრომელი)
  async myHours(u: AuthUser, month?: string) {
    await this.settings();
    const m = `${month ?? today().slice(0, 7)}-01`;
    const st = await this.db.selectFrom('staff_members').select(['id']).where('user_id', '=', u.id).executeTakeFirst();
    if (!st) return { month: m.slice(0, 7), row: null };
    // დახურული ძირითადი განყოფილების ტაბელი — snapshot; სხვა შემთხვევაში — ცოცხლად (ყველა განრიგი)
    const snap = await this.db.selectFrom('roster_timesheets as t').innerJoin('rosters as r', 'r.id', 't.roster_id').select(['t.roster_id']).where('t.staff_id', '=', st.id).where('t.home', '=', true)
      .where('r.month', '=', m).where('r.status', '=', 'closed').executeTakeFirst();
    if (snap) {
      const r = await this.roster.roster(this.db, snap.roster_id);
      const row = (await this.snapshot(this.db, r)).find((x) => x.staff_id === st.id) ?? null;
      return { month: m.slice(0, 7), closed: true, row: row && { ...row, personal_number: null } };
    }
    const g = await this.gather(this.db, m, [st.id]);
    const row = this.row(g, st.id, null, true);
    if (row) this.split(g.s, row, 0);
    return { month: m.slice(0, 7), closed: false, row: row && { ...row, personal_number: null, ot_pay_hours: null, ot_comp_hours: null, comp_days: null } };
  }

  // ================================================================ კავშირები (lookup) — სხვა მოდულების ეკრანებისთვის
  async now(purpose: 'consult' | 'bme', departmentId?: string) {
    const s = await this.lookup.settings();
    if (!s) return { mode: 'off', people: [] };
    const mode = purpose === 'consult' ? s.link_consult : s.link_bme;
    if (mode === 'off') return { mode, people: [] };
    const people = purpose === 'consult' ? (departmentId ? await this.lookup.now({ departmentId, category: 'doctor' }) : []) : await this.lookup.now({ capability: 'med_engineer' });
    const phone = s.duty_phone !== 'off';
    return { mode, people: people.filter((p) => p.user_id).map((p) => ({ ...p, phone: phone ? p.phone : null })) };
  }
  async load() { return { departments: (await this.lookup.load()) ?? [], at: new Date().toISOString() }; }
}

// ======================================================================= DTO
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
class ActualDto {
  @IsIn(['plan', 'worked', 'no_show']) status: 'plan' | 'worked' | 'no_show';
  @IsOptional() @Matches(HHMM) start_time?: string | null; @IsOptional() @Matches(HHMM) end_time?: string | null;
  @IsOptional() @IsNumber() @Min(0) @Max(48) hours?: number | null;
  @IsOptional() @IsString() @MaxLength(500) note?: string | null; @IsString() @Length(3, 500) reason: string;
}
class NoteDto { @IsOptional() @IsString() @MaxLength(1000) note?: string | null }
class CompItem { @IsUUID() staff_id: string; @IsNumber() @Min(0) @Max(400) hours: number }
class CloseDto {
  @IsOptional() @IsBoolean() confirm_warnings?: boolean; @IsOptional() @IsString() @MaxLength(1000) note?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(2000) @ValidateNested({ each: true }) @Type(() => CompItem) comp?: CompItem[];
}
class ReasonDto { @IsString() @Length(3, 1000) reason: string }

/** ცვლები / მორიგეობა — საათები / ტაბელი / დახურვა / ექსპორტი / კავშირები (0079). უფლებები — სერვისში */
@Controller('roster')
export class TimesheetController {
  constructor(private readonly s: TimesheetService) {}
  @Get('rosters/:id/timesheet') timesheet(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser) { return this.s.timesheet(id, u); }
  @Post('entries/:id/actual') @HttpCode(200) actual(@Param('id', ParseUUIDPipe) id: string, @Body() d: ActualDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.setActual(id, d, u, auditCtx(r)); }
  @Post('rosters/:id/submit') @HttpCode(200) submit(@Param('id', ParseUUIDPipe) id: string, @Body() d: NoteDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.submit(id, d, u, auditCtx(r)); }
  @Post('rosters/:id/close') @HttpCode(200) close(@Param('id', ParseUUIDPipe) id: string, @Body() d: CloseDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.close(id, d, u, auditCtx(r)); }
  @Post('rosters/:id/reopen') @HttpCode(200) reopen(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.reopen(id, d.reason, u, auditCtx(r)); }
  @Get('timesheets') overview(@CurrentUser() u: AuthUser, @Query('month') month: string) {
    if (!MONTH.test(month ?? '')) throw new BadRequestException('month — YYYY-MM');
    return this.s.overview(u, month);
  }
  @Get('timesheets/export')
  async export(@CurrentUser() u: AuthUser, @Query('month') month: string, @Query('department_id') dept: string | undefined, @Req() r: Request, @Res({ passthrough: true }) res: Response) {
    if (!MONTH.test(month ?? '')) throw new BadRequestException('month — YYYY-MM');
    if (dept && !/^[0-9a-f-]{36}$/i.test(dept)) throw new BadRequestException('არასწორი id');
    const out = await this.s.export(u, { month, department_id: dept || undefined }, r);
    res.set({ 'Content-Type': out.type, 'Content-Disposition': `attachment; filename="${encodeURIComponent(out.name)}"` });
    return new StreamableFile(out.body);
  }
  @Get('my/hours') myHours(@CurrentUser() u: AuthUser, @Query('month') month?: string) {
    if (month && !MONTH.test(month)) throw new BadRequestException('month — YYYY-MM');
    return this.s.myHours(u, month);
  }
  @Get('lookup/now') now(@Query('purpose') purpose: string, @Query('department_id') dept?: string) {
    if (purpose !== 'consult' && purpose !== 'bme') throw new BadRequestException('purpose — consult / bme');
    if (dept && !/^[0-9a-f-]{36}$/i.test(dept)) throw new BadRequestException('არასწორი id');
    return this.s.now(purpose, dept);
  }
  @Get('lookup/load') load() { return this.s.load(); }
}
