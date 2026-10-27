import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, Res,
  StreamableFile, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min } from 'class-validator';
import type { Request, Response } from 'express';
import { sql } from 'kysely';
import { memoryStorage } from 'multer';
import { randomUUID } from 'node:crypto';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser } from '../auth/roles';
import { mapPgError } from '../common/pg-errors';
import { InjectDb, type Database } from '../database/database.module';
import { NotificationsService } from '../notifications/notifications';
import { sniffMime } from '../patient-files/patient-files';
import { StorageService } from '../storage/storage.service';
import {
  ABSENCE_HR, ROSTER_HR, absenceScope, addDays, canEdit, canHead, headApprovers, isoDow, rosterScope, staffName, today, usersWithCaps,
  type AbsScope, type Ex, type Trx,
} from './roster-common';
import { RosterService, ddmm, type Change } from './roster';

const PG = {
  absence_types_code_key: 'იგივე კოდის არყოფნის ტიპი უკვე არსებობს',
  ex_ar_overlap: 'ამ პერიოდში თანამშრომელს სხვა არყოფნა (განხილვაში ან დადასტურებული) უკვე აქვს',
};
const ROUTE_KA: Record<string, string> = { head_hr: 'ხელმძღვანელი → HR', head: 'ხელმძღვანელი', hr: 'HR', none: 'მხოლოდ რეგისტრაცია' };
const STATUS_KA: Record<string, string> = { head: 'ხელმძღვანელთან', hr: 'HR-თან', approved: 'დადასტურებული', rejected: 'უარყოფილი', cancelled: 'გაუქმებული' };
const r1 = (x: number) => Math.round(x * 10) / 10;
const half = (x: number) => Math.round(x * 2) / 2;
const span = (a: string, b: string) => { const out: string[] = []; for (let d = a; d <= b; d = addDays(d, 1)) out.push(d); return out; };
const yearDays = (y: number) => ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 366 : 365);
const t = (v: string | null | undefined) => (typeof v === 'string' ? (v.trim() || null) : v);

type AType = { id: string; code: string; name: string; short: string; unit: string; has_balance: boolean; default_days: string | null; route: string; requires_document: boolean; self_request: boolean; is_active: boolean; paid: boolean };
type SRow = { id: string; name: string; user_id: string | null; department_id: string; department_name: string; category: string | null; is_active: boolean; hired_on: string | null; left_on: string | null };
type Req = { id: string; no: string; staff_id: string; absence_type_id: string; date_from: string; date_to: string; days: string; counted_days: string[]; balance_year: number; status: string; route: string;
  document_no: string | null; doc_path: string | null; overdraw_reason: string | null; created_by: string; cancel_requested_at: Date | string | null; head_skipped: boolean };
type Note = { user: string; kind: string; title: string; body?: string; item?: string; entity: string; link?: string };

/**
 * ცვლები / მორიგეობა — შვებულება / არყოფნა (0078): ტიპები, ბალანსი (ჟურნალი), მოთხოვნა → ხელმძღვანელი → HR, დადასტურებისას — განრიგზე ასახვა (D1),
 * გაუქმება / ადრე დასრულება, დოკუმენტი.
 */
@Injectable()
export class AbsenceService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService, private readonly notifications: NotificationsService,
    private readonly roster: RosterService, private readonly storage: StorageService) {}
  private settings() { return this.roster.settings(); }

  // ---------------------------------------------------------------- ტიპები
  async types() {
    await this.settings();
    return this.db.selectFrom('absence_types').selectAll().orderBy('sort_order').orderBy('name').execute();
  }
  async saveType(id: string | null, d: TypeDto, ctx: AuditContext) {
    await this.settings();
    const v = {
      ...(d.name !== undefined && { name: d.name.trim() }), ...(d.short !== undefined && { short: d.short.trim() }), ...(d.color !== undefined && { color: d.color }),
      ...(d.paid !== undefined && { paid: d.paid }), ...(d.counts_as_work !== undefined && { counts_as_work: d.counts_as_work }), ...(d.unit !== undefined && { unit: d.unit }),
      ...(d.has_balance !== undefined && { has_balance: d.has_balance }), ...(d.default_days !== undefined && { default_days: d.default_days === null ? null : String(d.default_days) }),
      ...(d.route !== undefined && { route: d.route }), ...(d.requires_document !== undefined && { requires_document: d.requires_document }),
      ...(d.self_request !== undefined && { self_request: d.self_request }), ...(d.is_active !== undefined && { is_active: d.is_active }), ...(d.sort_order !== undefined && { sort_order: d.sort_order }),
    };
    if (v.has_balance === false) v.default_days = null;
    try {
      const r = id ? await this.db.updateTable('absence_types').set(v).where('id', '=', id).returningAll().executeTakeFirst()
        : await this.db.insertInto('absence_types').values({ code: d.code!, name: d.name!.trim(), short: d.short!.trim(), ...v }).returningAll().executeTakeFirst();
      if (!r) throw new NotFoundException('არყოფნის ტიპი ვერ მოიძებნა');
      await this.audit.log(ctx, { action: id ? 'UPDATE_ABSENCE_TYPE' : 'CREATE_ABSENCE_TYPE', entityName: 'absence_types', entityId: r.id, newData: d });
      return r;
    } catch (e) {
      if ((e as { constraint?: string }).constraint === 'chk_at_balance') throw new BadRequestException('წლიური ნორმა — მხოლოდ ბალანსიან ტიპზე');
      mapPgError(e, PG);
    }
  }
  private async type(ex: Ex, id: string): Promise<AType> {
    const x = await ex.selectFrom('absence_types').select(['id', 'code', 'name', 'short', 'unit', 'has_balance', 'default_days', 'route', 'requires_document', 'self_request', 'is_active', 'paid'])
      .where('id', '=', id).executeTakeFirst();
    if (!x) throw new NotFoundException('არყოფნის ტიპი ვერ მოიძებნა');
    return x;
  }

  // ---------------------------------------------------------------- თანამშრომელი / არე
  private staffQ(ex: Ex) {
    return ex.selectFrom('staff_members as s').innerJoin('departments as d', 'd.id', 's.department_id').leftJoin('staff_positions as p', 'p.id', 's.position_id')
      .select(['s.id', staffName('s').as('name'), 's.user_id', 's.department_id', 'd.name as department_name', 'p.category', 's.is_active',
        sql<string | null>`to_char(s.hired_on, 'YYYY-MM-DD')`.as('hired_on'), sql<string | null>`to_char(s.left_on, 'YYYY-MM-DD')`.as('left_on')]);
  }
  private async staff(ex: Ex, id: string, lock = false): Promise<SRow> {
    let q = this.staffQ(ex).where('s.id', '=', id);
    if (lock) q = q.forUpdate('s');
    const s = await q.executeTakeFirst();
    if (!s) throw new NotFoundException('თანამშრომელი ვერ მოიძებნა');
    return s;
  }
  private async own(u: AuthUser, ex: Ex = this.db) { return this.staffQ(ex).where('s.user_id', '=', u.id).executeTakeFirst(); }
  /** თანამშრომლის მაგივრად რეგისტრაცია / ნახვა: ხელმძღვანელი (absence_approve / roster არე), შემდგენი (roster არე), HR / roster_all */
  private async manager(ex: Ex, u: AuthUser, st: SRow, as?: AbsScope) {
    const a = as ?? (await absenceScope(ex, u));
    if (canHead(a, st.department_id)) return true;
    return canEdit(await rosterScope(ex, u), st.department_id);
  }
  /** მიმდინარე ნაბიჯის შესრულება (საკუთარი მოთხოვნის დადასტურება — არა) */
  private canAct(as: AbsScope, u: AuthUser, r: { status: string; route: string }, st: SRow) {
    if (st.user_id === u.id) return false;
    if (r.status === 'head') return canHead(as, st.department_id);
    if (r.status === 'hr') return as.hr || (r.route === 'head' && has(u, 'roster_all'));
    return false;
  }

  // ---------------------------------------------------------------- დღეების დათვლა
  /**
   * ჩათვლილი დღეები: კალენდარული — ყველა; სამუშაო — ორშ.–პარ., დღესასწაულების გარეშე (B3).
   * absence_unit_mode = roster: თვეებში, სადაც თანამშრომლის ძირითად განყოფილებას განრიგი აქვს — დღეები დაგეგმილი ცვლით; სხვაგან — ორშ.–პარ.
   */
  private async countDays(ex: Ex, st: SRow, ty: AType, from: string, to: string): Promise<string[]> {
    const all = span(from, to);
    if (ty.unit === 'calendar') return all;
    const s = await this.settings();
    const hol = new Set((await ex.selectFrom('public_holidays').select(sql<string>`to_char(day, 'YYYY-MM-DD')`.as('d')).where('day', '>=', from).where('day', '<=', to).execute()).map((x) => x.d));
    const wd = (d: string) => isoDow(d) <= 5 && !hol.has(d);
    if (s.absence_unit_mode !== 'roster') return all.filter(wd);
    const [ent, months] = await Promise.all([
      ex.selectFrom('roster_entries').select(sql<string>`to_char(day, 'YYYY-MM-DD')`.as('d')).where('staff_id', '=', st.id).where('status', '=', 'active').where('day', '>=', from).where('day', '<=', to).execute(),
      ex.selectFrom('rosters').select(sql<string>`to_char(month, 'YYYY-MM')`.as('m')).where('department_id', '=', st.department_id).where('month', '>=', `${from.slice(0, 7)}-01`).where('month', '<=', `${to.slice(0, 7)}-01`).execute(),
    ]);
    const e = new Set(ent.map((x) => x.d)); const m = new Set(months.map((x) => x.m));
    return all.filter((d) => (m.has(d.slice(0, 7)) ? e.has(d) : wd(d)));
  }

  // ---------------------------------------------------------------- ბალანსი
  private async entitlement(ex: Ex, staffId: string, ty: AType) {
    const o = await ex.selectFrom('absence_entitlements').select('days_per_year').where('staff_id', '=', staffId).where('absence_type_id', '=', ty.id).executeTakeFirst();
    return o ? Number(o.days_per_year) : ty.default_days === null ? null : Number(ty.default_days);
  }
  /** ავტომატური დარიცხვა (B2): წლიური — ერთხელ (მიღების / წასვლის წელს — პროპორციულად, 0.5-მდე); თვიური — ყოველ დაწყებულ თვეზე */
  private async ensureAccrual(ex: Ex, st: SRow, ty: AType, year: number) {
    if (!ty.has_balance) return;
    const ent = await this.entitlement(ex, st.id, ty);
    if (ent === null) return;
    const s = await this.settings();
    const y0 = `${year}-01-01`, y1 = `${year}-12-31`;
    const a = st.hired_on && st.hired_on > y0 ? st.hired_on : y0; const b = st.left_on && st.left_on < y1 ? st.left_on : y1;
    const rows: { period: number; days: number }[] = [];
    if (s.accrual === 'monthly') {
      const cur = today(); const upto = year < Number(cur.slice(0, 4)) ? 12 : year > Number(cur.slice(0, 4)) ? 0 : Number(cur.slice(5, 7));
      for (let m = 1; m <= upto; m++) {
        const ms = `${year}-${String(m).padStart(2, '0')}-01`; const me = addDays(m === 12 ? `${year + 1}-01-01` : `${year}-${String(m + 1).padStart(2, '0')}-01`, -1);
        const lo = a > ms ? a : ms, hi = b < me ? b : me;
        const frac = lo > hi ? 0 : span(lo, hi).length / span(ms, me).length;
        rows.push({ period: m, days: r1((ent / 12) * frac) });
      }
    } else {
      const frac = a > b ? 0 : span(a, b).length / yearDays(year);
      rows.push({ period: 0, days: frac >= 1 ? ent : half(ent * frac) });
    }
    if (!rows.length) return;
    await ex.insertInto('absence_balance_entries').values(rows.map((x) => ({ staff_id: st.id, absence_type_id: ty.id, year, kind: 'accrual', period: x.period, days: String(x.days),
      reason: x.period ? `${x.period} თვე` : null })))
      .onConflict((oc) => oc.columns(['staff_id', 'absence_type_id', 'year', 'period']).where('kind', '=', 'accrual').doNothing()).execute();
  }
  /** ნაშთი = ჟურნალის ჯამი; ხელმისაწვდომი = ნაშთი − განხილვაში მყოფი მოთხოვნები */
  private async balance(ex: Ex, staffId: string, typeId: string, year: number, exclude?: string) {
    const [b, p] = await Promise.all([
      ex.selectFrom('absence_balance_entries').select(sql<string>`coalesce(sum(days), 0)`.as('s')).where('staff_id', '=', staffId).where('absence_type_id', '=', typeId).where('year', '=', year).executeTakeFirstOrThrow(),
      ex.selectFrom('absence_requests').select(sql<string>`coalesce(sum(days), 0)`.as('s')).where('staff_id', '=', staffId).where('absence_type_id', '=', typeId).where('balance_year', '=', year)
        .where('status', 'in', ['head', 'hr']).$if(!!exclude, (q) => q.where('id', '<>', exclude!)).executeTakeFirstOrThrow(),
    ]);
    const total = Number(b.s), pending = Number(p.s);
    return { total, pending, available: r1(total - pending) };
  }

  // ---------------------------------------------------------------- მოთხოვნა
  async create(d: CreateDto, u: AuthUser, ctx: AuditContext) {
    const s = await this.settings();
    const ty = await this.type(this.db, d.absence_type_id);
    if (!ty.is_active) throw new BadRequestException('არყოფნის ტიპი გათიშულია');
    if (d.date_to < d.date_from) throw new BadRequestException('პერიოდი: დასასრული დასაწყისზე ადრეა');
    const notes: Note[] = []; let openIds: string[] = []; const warnings: string[] = [];
    const res = await this.db.transaction().execute(async (trx) => {
      const me = await this.own(u, trx);
      const staffId = d.staff_id ?? me?.id;
      if (!staffId) throw new BadRequestException('თქვენი ანგარიში თანამშრომლების რეესტრში არ არის მიბმული — მიმართეთ განრიგის შემდგენს / HR-ს');
      const st = await this.staff(trx, staffId, true);
      const self = st.user_id === u.id;
      const as = await absenceScope(trx, u);
      if (!self && !(await this.manager(trx, u, st, as))) throw new ForbiddenException('ამ თანამშრომლის არყოფნის რეგისტრაციის უფლება არ გაქვთ');
      if (self && !ty.self_request && !(await this.manager(trx, u, st, as))) throw new ForbiddenException(`„${ty.name}“ — არეგისტრირებს ხელმძღვანელი / HR`);
      if (!st.is_active) throw new BadRequestException(`${st.name} — გათიშულია`);
      if (st.hired_on && d.date_from < st.hired_on) throw new BadRequestException(`${st.name} — მიღებულია ${st.hired_on}-დან`);
      if (st.left_on && d.date_to > st.left_on) throw new BadRequestException(`${st.name} — წასულია ${st.left_on}-დან`);
      const days = await this.countDays(trx, st, ty, d.date_from, d.date_to);
      if (!days.length) throw new BadRequestException({ code: 'ABSENCE_NO_DAYS', message: 'პერიოდში ჩასათვლელი (სამუშაო) დღე არ არის' });
      const year = Number(d.date_from.slice(0, 4));
      if (ty.has_balance) {
        await this.ensureAccrual(trx, st, ty, year);
        const b = await this.balance(trx, st.id, ty.id, year);
        if (days.length > b.available + 1e-9) {
          const msg = `ნაშთი არ ყოფნის: მოთხოვნილია ${days.length}, ხელმისაწვდომია ${b.available} (${year})`;
          if (s.balance_overdraw === 'block' && !(as.hr && (d.overdraw_reason?.trim().length ?? 0) >= 3)) throw new ConflictException({ code: 'ABSENCE_BALANCE', message: `${msg}. გადაჭარბება — HR-ის დადასტურებით (მიზეზით)`, available: b.available, days: days.length });
          warnings.push(msg);
        }
      }
      // საწყისი ნაბიჯი; შემქმნელი ასრულებს იმ ნაბიჯებს, რისი უფლებაც აქვს (C6); „ერთადერთი ხელმძღვანელი“ — ნაბიჯი გამოტოვდება (C3)
      const row = { route: ty.route, status: ty.route === 'none' ? 'approved' : ty.route === 'hr' ? 'hr' : 'head' };
      const now = sql<Date>`now()`;
      const extra: Record<string, unknown> = {};
      if (row.status === 'head') {
        if (!self && this.canAct(as, u, row, st)) Object.assign(extra, { head_by: u.id, head_at: now, head_note: 'შეიტანა ხელმძღვანელმა' });
        else if (self && !(await headApprovers(trx, st.department_id)).some((x) => x !== u.id)) extra.head_skipped = true;
        if (extra.head_by || extra.head_skipped) row.status = ty.route === 'head' && !extra.head_skipped ? 'approved' : 'hr';
      }
      const hasDoc = !!t(d.document_no);
      if (row.status === 'hr' && !self && this.canAct(as, u, row, st) && (!ty.requires_document || hasDoc)) {
        Object.assign(extra, { hr_by: u.id, hr_at: now, hr_note: 'შეიტანა HR-მა' }); row.status = 'approved';
      }
      const r = await trx.insertInto('absence_requests').values({
        staff_id: st.id, absence_type_id: ty.id, date_from: d.date_from, date_to: d.date_to, days: String(days.length), counted_days: days, balance_year: year, status: row.status, route: ty.route,
        note: t(d.note) ?? null, document_no: t(d.document_no) ?? null, overdraw_reason: warnings.length ? t(d.overdraw_reason) ?? null : null, created_by: u.id, on_behalf: !self,
        ...extra, ...(row.status === 'approved' && { decided_by: u.id, decided_at: now }),
      }).returning(['id', sql<string>`no::text`.as('no')]).executeTakeFirstOrThrow();
      const req = await this.req(trx, r.id);
      if (row.status === 'approved') openIds = await this.apply(trx, req, st, ty, u);
      await this.audit.log(ctx, { action: 'CREATE_ABSENCE', entityName: 'absence_requests', entityId: r.id, newData: { ...d, status: row.status, days: days.length } }, trx);
      await this.stepNotes(trx, req, st, ty, notes, u);
      return { id: r.id, no: r.no, status: row.status, days: days.length };
    }).catch((e) => mapPgError(e, PG));
    await this.send(notes);
    await this.roster.notifyOpenShifts(openIds);
    return { ...res, warnings };
  }

  private async req(ex: Ex, id: string, lock = false): Promise<Req> {
    let q = ex.selectFrom('absence_requests').select(['id', sql<string>`no::text`.as('no'), 'staff_id', 'absence_type_id', sql<string>`to_char(date_from, 'YYYY-MM-DD')`.as('date_from'),
      sql<string>`to_char(date_to, 'YYYY-MM-DD')`.as('date_to'), 'days', sql<string[]>`array(SELECT to_char(x, 'YYYY-MM-DD') FROM unnest(counted_days) x ORDER BY 1)`.as('counted_days'),
      'balance_year', 'status', 'route', 'document_no', 'doc_path', 'overdraw_reason', 'created_by', 'cancel_requested_at', 'head_skipped']).where('id', '=', id);
    if (lock) q = q.forUpdate();
    const r = await q.executeTakeFirst();
    if (!r) throw new NotFoundException('მოთხოვნა ვერ მოიძებნა');
    return r;
  }
  private label(r: Req, ty: AType) { return `#${r.no} ${ty.short} ${ddmm(r.date_from)}${r.date_to !== r.date_from ? `–${ddmm(r.date_to)}` : ''}`; }

  /** მიმდინარე ნაბიჯის შეტყობინებები: ხელმძღვანელებს / HR-ს — ახალი მოთხოვნა; თანამშრომელს — გადაწყვეტილება */
  private async stepNotes(ex: Ex, r: Req, st: SRow, ty: AType, out: Note[], u: AuthUser) {
    const item = this.label(r, ty); const link = '/roster?tab=approvals';
    if (r.status === 'head' || r.status === 'hr') {
      const to = r.status === 'head' ? await headApprovers(ex, st.department_id) : [...new Set([...(await usersWithCaps(ex, ['hr'])), ...(r.route === 'head' ? await usersWithCaps(ex, ['roster_all']) : [])])];
      for (const x of to) if (x !== st.user_id && x !== u.id) out.push({ user: x, kind: 'absence_requested', title: `არყოფნის მოთხოვნა: ${st.name}`, body: `${ty.name} · ${STATUS_KA[r.status]}`, item, entity: r.id, link });
    }
    if ((r.status === 'approved' || r.status === 'rejected') && st.user_id && st.user_id !== u.id)
      out.push({ user: st.user_id, kind: 'absence_decided', title: `არყოფნა ${r.status === 'approved' ? 'დადასტურდა' : 'უარყოფილია'}: ${ty.name}`, item, entity: r.id, link: '/roster?tab=my&sub=absence' });
  }
  private async send(notes: Note[]) {
    for (const n of notes) await this.notifications.notify(n.user, { kind: n.kind, title: n.title, body: n.body ?? null, link: n.link ?? null, entityId: n.entity, item: n.item ?? null });
  }

  /**
   * საბოლოო დადასტურება (D1): ბალანსიდან ჩამოწერა; თანამშრომლის ცვლები პერიოდში — მონახაზში იშლება, გამოქვეყნებულში უქმდება (მიზეზით, ვერსია +1)
   * და ხდება „დასაფარი“; დახურულ განრიგს არ ეხება (სიაში).
   */
  private async apply(trx: Trx, r: Req, st: SRow, ty: AType, u: AuthUser) {
    if (ty.has_balance) await trx.insertInto('absence_balance_entries').values({ staff_id: st.id, absence_type_id: ty.id, year: r.balance_year, kind: 'use', days: String(-Number(r.days)), request_id: r.id, user_id: u.id }).execute();
    const es = await trx.selectFrom('roster_entries as e').innerJoin('rosters as ro', 'ro.id', 'e.roster_id').innerJoin('shift_templates as tp', 'tp.id', 'e.shift_template_id')
      .select(['e.id', 'e.roster_id', 'ro.status', sql<string>`to_char(e.day, 'YYYY-MM-DD')`.as('day'), 'tp.code'])
      .where('e.staff_id', '=', st.id).where('e.status', '=', 'active').where('e.day', '>=', r.date_from).where('e.day', '<=', r.date_to).orderBy('e.starts_at').execute();
    const reason = `არყოფნა #${r.no}: ${ty.name}`;
    const out = { deleted: [] as string[], cancelled: [] as string[], closed: [] as string[] }; const open: string[] = [];
    for (const rid of [...new Set(es.map((e) => e.roster_id))]) {
      const ro = await this.roster.roster(trx, rid, true);
      const mine = es.filter((e) => e.roster_id === rid);
      if (ro.status === 'draft') { await trx.deleteFrom('roster_entries').where('id', 'in', mine.map((e) => e.id)).execute(); out.deleted.push(...mine.map((e) => `${e.day} ${e.code}`)); continue; }
      if (ro.status === 'closed') { out.closed.push(...mine.map((e) => `${e.day} ${e.code}`)); continue; }
      const changes: Change[] = [];
      for (const e of mine) {
        await trx.updateTable('roster_entries').set({ status: 'cancelled', cancelled_at: sql`now()`, cancelled_by: u.id, cancel_reason: reason }).where('id', '=', e.id).execute();
        open.push(await this.roster.openFromEntry(trx, e.id, 'absence', u, r.id, reason));
        changes.push({ kind: 'absence', entry_id: e.id, staff_id: st.id, data: { day: e.day, code: e.code, absence: r.no } });
        out.cancelled.push(`${e.day} ${e.code}`);
      }
      await this.roster.afterChange(trx, ro, changes, reason, u);
    }
    await trx.updateTable('absence_requests').set({ roster_applied: JSON.stringify(out) }).where('id', '=', r.id).execute();
    return open;
  }

  async approve(id: string, d: DecideDto, u: AuthUser, ctx: AuditContext) {
    const s = await this.settings();
    const notes: Note[] = []; let open: string[] = [];
    const res = await this.db.transaction().execute(async (trx) => {
      const r = await this.req(trx, id, true);
      const st = await this.staff(trx, r.staff_id); const ty = await this.type(trx, r.absence_type_id);
      if (r.status !== 'head' && r.status !== 'hr') throw new ConflictException({ code: 'ABSENCE_STATE', message: `მოთხოვნა ${STATUS_KA[r.status]}ა` });
      const as = await absenceScope(trx, u);
      if (!this.canAct(as, u, r, st)) throw new ForbiddenException(st.user_id === u.id ? 'საკუთარ მოთხოვნას ვერ დაადასტურებთ' : 'ამ ნაბიჯის შესრულების უფლება არ გაქვთ');
      const now = sql<Date>`now()`;
      let next: string; const set: Record<string, unknown> = {};
      if (r.status === 'head') { next = r.route === 'head' ? 'approved' : 'hr'; Object.assign(set, { head_by: u.id, head_at: now, head_note: t(d.note) ?? null }); }
      else {
        if (ty.requires_document && !r.document_no && !r.doc_path) throw new ConflictException({ code: 'ABSENCE_DOCUMENT', message: 'დოკუმენტი (ნომერი ან ფაილი) სავალდებულოა' });
        next = 'approved'; Object.assign(set, { hr_by: u.id, hr_at: now, hr_note: t(d.note) ?? null });
      }
      if (next === 'approved') {
        // ბოლო ნაბიჯი: დღეების გადათვლა (განრიგი შეიძლება შეიცვალა) და ბალანსი
        const days = await this.countDays(trx, st, ty, r.date_from, r.date_to);
        Object.assign(set, { days: String(days.length), counted_days: days, decided_by: u.id, decided_at: now });
        r.days = String(days.length); r.counted_days = days;
        if (ty.has_balance) {
          await this.ensureAccrual(trx, st, ty, r.balance_year);
          const b = await this.balance(trx, st.id, ty.id, r.balance_year, r.id);
          if (days.length > b.available + 1e-9 && s.balance_overdraw === 'block' && !r.overdraw_reason) {
            if (!(as.hr && (d.overdraw_reason?.trim().length ?? 0) >= 3)) throw new ConflictException({ code: 'ABSENCE_BALANCE', message: `ნაშთი არ ყოფნის: ${days.length} / ${b.available}. გადაჭარბება — HR-ის დადასტურებით (მიზეზით)`, available: b.available });
            set.overdraw_reason = d.overdraw_reason!.trim();
          }
        }
      }
      await trx.updateTable('absence_requests').set({ ...set, status: next }).where('id', '=', r.id).execute();
      r.status = next;
      if (next === 'approved') open = await this.apply(trx, r, st, ty, u);
      await this.audit.log(ctx, { action: 'APPROVE_ABSENCE', entityName: 'absence_requests', entityId: r.id, newData: { step: next, note: d.note } }, trx);
      await this.stepNotes(trx, r, st, ty, notes, u);
      return { status: next };
    });
    await this.send(notes);
    await this.roster.notifyOpenShifts(open);
    return res;
  }

  async reject(id: string, reason: string, u: AuthUser, ctx: AuditContext) {
    await this.settings();
    const notes: Note[] = [];
    await this.db.transaction().execute(async (trx) => {
      const r = await this.req(trx, id, true);
      const st = await this.staff(trx, r.staff_id); const ty = await this.type(trx, r.absence_type_id);
      if (r.status !== 'head' && r.status !== 'hr') throw new ConflictException({ code: 'ABSENCE_STATE', message: `მოთხოვნა ${STATUS_KA[r.status]}ა` });
      if (!this.canAct(await absenceScope(trx, u), u, r, st)) throw new ForbiddenException('ამ ნაბიჯის შესრულების უფლება არ გაქვთ');
      await trx.updateTable('absence_requests').set({ status: 'rejected', reject_reason: reason.trim(), decided_by: u.id, decided_at: sql`now()` }).where('id', '=', r.id).execute();
      r.status = 'rejected';
      await this.audit.log(ctx, { action: 'REJECT_ABSENCE', entityName: 'absence_requests', entityId: r.id, newData: { reason } }, trx);
      await this.stepNotes(trx, r, st, ty, notes, u);
    });
    await this.send(notes);
    return { ok: true };
  }

  /** დადასტურებულის გაუქმება: ბალანსი ბრუნდება; განრიგში გაუქმებული ცვლები არ აღდგება (დასაფარი რჩება — შემდგენი წყვეტს) */
  private async cancelNow(trx: Trx, r: Req, ty: AType, reason: string, u: AuthUser) {
    if (r.status === 'approved' && ty.has_balance && Number(r.days) > 0)
      await trx.insertInto('absence_balance_entries').values({ staff_id: r.staff_id, absence_type_id: ty.id, year: r.balance_year, kind: 'restore', days: r.days, request_id: r.id, reason, user_id: u.id }).execute();
    await trx.updateTable('absence_requests').set({ status: 'cancelled', cancelled_by: u.id, cancelled_at: sql`now()`, cancel_reason: reason, cancel_requested_at: null }).where('id', '=', r.id).execute();
  }

  /**
   * გაუქმება (C5): განხილვაში — თანამშრომელი / შემქმნელი / ხელმძღვანელი / HR; დადასტურებული (დაწყებამდე) — ხელმძღვანელი / HR პირდაპირ,
   * თანამშრომელი — თხოვნით (იმავე დამდასტურებლებთან); დაწყებულს — მხოლოდ ადრე დასრულება (HR).
   */
  async cancel(id: string, reason: string, u: AuthUser, ctx: AuditContext) {
    await this.settings();
    const notes: Note[] = [];
    const res = await this.db.transaction().execute(async (trx) => {
      const r = await this.req(trx, id, true);
      const st = await this.staff(trx, r.staff_id); const ty = await this.type(trx, r.absence_type_id);
      const self = st.user_id === u.id; const as = await absenceScope(trx, u);
      const mgr = !self && (canHead(as, st.department_id) || as.hr);
      if (r.status === 'head' || r.status === 'hr') {
        if (!self && !mgr && r.created_by !== u.id) throw new ForbiddenException('გაუქმების უფლება არ გაქვთ');
        await this.cancelNow(trx, r, ty, reason.trim(), u);
        await this.audit.log(ctx, { action: 'CANCEL_ABSENCE', entityName: 'absence_requests', entityId: r.id, newData: { reason } }, trx);
        return { status: 'cancelled' };
      }
      if (r.status !== 'approved') throw new ConflictException({ code: 'ABSENCE_STATE', message: `მოთხოვნა ${STATUS_KA[r.status]}ა` });
      if (r.date_from <= today()) throw new ConflictException({ code: 'ABSENCE_STARTED', message: 'არყოფნა დაწყებულია — გაუქმება შეუძლებელია (HR: ადრე დასრულება)' });
      if (mgr || (self && r.route === 'none')) {
        await this.cancelNow(trx, r, ty, reason.trim(), u);
        await this.audit.log(ctx, { action: 'CANCEL_ABSENCE', entityName: 'absence_requests', entityId: r.id, newData: { reason, approved: true } }, trx);
        if (st.user_id && !self) notes.push({ user: st.user_id, kind: 'absence_cancelled', title: `არყოფნა გაუქმდა: ${ty.name}`, body: reason, item: this.label(r, ty), entity: r.id, link: '/roster?tab=my&sub=absence' });
        return { status: 'cancelled' };
      }
      if (!self) throw new ForbiddenException('გაუქმების უფლება არ გაქვთ');
      if (r.cancel_requested_at) throw new ConflictException({ code: 'ABSENCE_STATE', message: 'გაუქმების თხოვნა უკვე გაგზავნილია' });
      await trx.updateTable('absence_requests').set({ cancel_requested_at: sql`now()`, cancel_request_note: reason.trim() }).where('id', '=', r.id).execute();
      await this.audit.log(ctx, { action: 'REQUEST_CANCEL_ABSENCE', entityName: 'absence_requests', entityId: r.id, newData: { reason } }, trx);
      const to = [...new Set([...(r.route === 'hr' ? [] : await headApprovers(trx, st.department_id)), ...(r.route === 'head' ? [] : await usersWithCaps(trx, ['hr']))])];
      for (const x of to) if (x !== u.id) notes.push({ user: x, kind: 'absence_cancel_req', title: `არყოფნის გაუქმების თხოვნა: ${st.name}`, body: reason, item: this.label(r, ty), entity: r.id, link: '/roster?tab=approvals' });
      return { status: 'approved', cancel_requested: true };
    });
    await this.send(notes);
    return res;
  }
  async cancelDecision(id: string, d: { approve: boolean; note?: string | null }, u: AuthUser, ctx: AuditContext) {
    await this.settings();
    const notes: Note[] = [];
    await this.db.transaction().execute(async (trx) => {
      const r = await this.req(trx, id, true);
      const st = await this.staff(trx, r.staff_id); const ty = await this.type(trx, r.absence_type_id);
      if (r.status !== 'approved' || !r.cancel_requested_at) throw new ConflictException({ code: 'ABSENCE_STATE', message: 'გაუქმების თხოვნა არ არის' });
      const as = await absenceScope(trx, u);
      if (st.user_id === u.id || !(canHead(as, st.department_id) || as.hr)) throw new ForbiddenException('გადაწყვეტილების უფლება არ გაქვთ');
      if (d.approve) {
        if (r.date_from <= today()) throw new ConflictException({ code: 'ABSENCE_STARTED', message: 'არყოფნა დაწყებულია — გაუქმება შეუძლებელია (HR: ადრე დასრულება)' });
        await this.cancelNow(trx, r, ty, `თანამშრომლის თხოვნით${d.note?.trim() ? `: ${d.note.trim()}` : ''}`, u);
      } else await trx.updateTable('absence_requests').set({ cancel_requested_at: null, cancel_request_note: null }).where('id', '=', r.id).execute();
      await this.audit.log(ctx, { action: d.approve ? 'CANCEL_ABSENCE' : 'KEEP_ABSENCE', entityName: 'absence_requests', entityId: r.id, newData: d }, trx);
      if (st.user_id) notes.push({ user: st.user_id, kind: 'absence_cancelled', title: d.approve ? `არყოფნა გაუქმდა (თქვენი თხოვნით): ${ty.name}` : `გაუქმების თხოვნა არ დაკმაყოფილდა: ${ty.name}`,
        body: d.note?.trim() || undefined, item: this.label(r, ty), entity: r.id, link: '/roster?tab=my&sub=absence' });
    });
    await this.send(notes);
    return { ok: true };
  }

  /** ადრე დასრულება (HR): ახალი დასასრული; ჩათვლილი დღეები — თავდაპირველი სიიდან, სხვაობა ბრუნდება ბალანსში */
  async shorten(id: string, d: { date_to: string; reason: string }, u: AuthUser, ctx: AuditContext) {
    await this.settings();
    if (!has(u, ...ABSENCE_HR)) throw new ForbiddenException('ადრე დასრულება — HR');
    const notes: Note[] = [];
    const res = await this.db.transaction().execute(async (trx) => {
      const r = await this.req(trx, id, true);
      const st = await this.staff(trx, r.staff_id); const ty = await this.type(trx, r.absence_type_id);
      if (r.status !== 'approved') throw new ConflictException({ code: 'ABSENCE_STATE', message: 'მხოლოდ დადასტურებული' });
      if (d.date_to < r.date_from || d.date_to >= r.date_to) throw new BadRequestException(`ახალი დასასრული: ${r.date_from} … ${addDays(r.date_to, -1)}`);
      const kept = r.counted_days.filter((x) => x <= d.date_to); const back = r1(Number(r.days) - kept.length);
      if (ty.has_balance && back > 0)
        await trx.insertInto('absence_balance_entries').values({ staff_id: st.id, absence_type_id: ty.id, year: r.balance_year, kind: 'restore', days: String(back), request_id: r.id, reason: `ადრე დასრულება: ${d.reason.trim()}`, user_id: u.id }).execute();
      await trx.updateTable('absence_requests').set({ date_to: d.date_to, days: String(kept.length), counted_days: kept, shortened_from: sql`coalesce(shortened_from, date_to)` }).where('id', '=', r.id).execute();
      await this.audit.log(ctx, { action: 'SHORTEN_ABSENCE', entityName: 'absence_requests', entityId: r.id, oldData: { date_to: r.date_to, days: r.days }, newData: { date_to: d.date_to, days: kept.length, reason: d.reason } }, trx);
      if (st.user_id && st.user_id !== u.id) notes.push({ user: st.user_id, kind: 'absence_cancelled', title: `არყოფნა დასრულდა ადრე (${ddmm(d.date_to)}): ${ty.name}`, body: d.reason, item: this.label(r, ty), entity: r.id, link: '/roster?tab=my&sub=absence' });
      return { days: kept.length, restored: ty.has_balance ? back : 0 };
    });
    await this.send(notes);
    return res;
  }

  async update(id: string, d: { document_no?: string | null; note?: string | null }, u: AuthUser, ctx: AuditContext) {
    await this.settings();
    const r = await this.req(this.db, id);
    const st = await this.staff(this.db, r.staff_id);
    const self = st.user_id === u.id;
    const mgr = await this.manager(this.db, u, st);
    if (!mgr && !(self && (r.status === 'head' || r.status === 'hr'))) throw new ForbiddenException('ცვლილების უფლება არ გაქვთ');
    if (r.status === 'rejected' || r.status === 'cancelled') throw new ConflictException({ code: 'ABSENCE_STATE', message: `მოთხოვნა ${STATUS_KA[r.status]}ა` });
    await this.db.updateTable('absence_requests').set({ ...(d.document_no !== undefined && { document_no: t(d.document_no) ?? null }), ...(d.note !== undefined && { note: t(d.note) ?? null }) }).where('id', '=', id).execute();
    await this.audit.log(ctx, { action: 'UPDATE_ABSENCE', entityName: 'absence_requests', entityId: id, newData: d });
    return { ok: true };
  }

  // ---------------------------------------------------------------- დოკუმენტი (ფაილი)
  async upload(id: string, f: Express.Multer.File | undefined, u: AuthUser, ctx: AuditContext) {
    await this.settings();
    if (!f) throw new BadRequestException('ფაილი არ არის (ველი "file")');
    const r = await this.req(this.db, id); const st = await this.staff(this.db, r.staff_id);
    if (!(st.user_id === u.id || (await this.manager(this.db, u, st)))) throw new ForbiddenException('ფაილის მიბმის უფლება არ გაქვთ');
    if (r.status === 'rejected' || r.status === 'cancelled') throw new ConflictException({ code: 'ABSENCE_STATE', message: `მოთხოვნა ${STATUS_KA[r.status]}ა` });
    const mime = sniffMime(f.buffer);
    if (!mime) throw new BadRequestException({ code: 'FILE_TYPE', message: 'დაშვებულია მხოლოდ PDF, JPG ან PNG' });
    const key = `absence/${id}/${randomUUID()}.${mime === 'application/pdf' ? 'pdf' : mime === 'image/png' ? 'png' : 'jpg'}`;
    await this.storage.put(key, f.buffer, mime);
    const name = Buffer.from(f.originalname ?? '', 'latin1').toString('utf8').slice(0, 200) || null;
    await this.db.updateTable('absence_requests').set({ doc_path: key, doc_mime: mime, doc_name: name }).where('id', '=', id).execute();
    await this.audit.log(ctx, { action: 'ABSENCE_DOC_UPLOAD', entityName: 'absence_requests', entityId: id, newData: { name, mime } });
    return { ok: true };
  }
  async file(id: string, u: AuthUser) {
    await this.settings();
    const r = await this.db.selectFrom('absence_requests').select(['staff_id', 'doc_path', 'doc_mime']).where('id', '=', id).executeTakeFirst();
    if (!r?.doc_path) throw new NotFoundException('ფაილი არ არის');
    const st = await this.staff(this.db, r.staff_id);
    if (!(st.user_id === u.id || (await this.manager(this.db, u, st)))) throw new ForbiddenException('ნახვის უფლება არ გაქვთ');
    return { stream: await this.storage.get(r.doc_path), mime: r.doc_mime ?? 'application/octet-stream' };
  }

  // ---------------------------------------------------------------- სიები / დეტალი
  private listQ() {
    return this.db.selectFrom('absence_requests as a').innerJoin('staff_members as s', 's.id', 'a.staff_id').innerJoin('departments as d', 'd.id', 's.department_id')
      .innerJoin('absence_types as t', 't.id', 'a.absence_type_id').leftJoin('staff_positions as p', 'p.id', 's.position_id').leftJoin('users as cu', 'cu.id', 'a.created_by')
      .select(['a.id', sql<string>`a.no::text`.as('no'), 'a.staff_id', staffName('s').as('staff_name'), 's.user_id as staff_user_id', 's.department_id', 'd.name as department_name', 'p.name as position_name',
        'a.absence_type_id', 't.code as type_code', 't.name as type_name', 't.short', 't.color', 't.has_balance', 't.requires_document', sql<string>`to_char(a.date_from, 'YYYY-MM-DD')`.as('date_from'),
        sql<string>`to_char(a.date_to, 'YYYY-MM-DD')`.as('date_to'), 'a.days', 'a.balance_year', 'a.status', 'a.route', 'a.note', 'a.document_no', sql<boolean>`a.doc_path IS NOT NULL`.as('has_file'),
        'a.on_behalf', 'a.head_skipped', 'a.cancel_requested_at', 'a.cancel_request_note', 'a.reject_reason', 'a.cancel_reason', 'a.overdraw_reason', 'a.created_at', 'a.decided_at',
        sql<string | null>`cu.last_name || ' ' || cu.first_name`.as('created_by_name')]);
  }
  async list(u: AuthUser, q: ListQ) {
    await this.settings();
    const as = await absenceScope(this.db, u); const rs = await rosterScope(this.db, u);
    let x = this.listQ().orderBy('a.date_from', 'desc').limit(1000);
    const scope = q.scope ?? 'my';
    if (scope === 'my') {
      const me = await this.own(u);
      if (!me) return [];
      x = x.where('a.staff_id', '=', me.id);
    } else if (scope === 'approve') {
      x = x.where((eb) => eb.or([eb('a.status', 'in', ['head', 'hr']), eb.and([eb('a.status', '=', 'approved'), eb('a.cancel_requested_at', 'is not', null)])])).where('s.user_id', 'is distinct from', u.id);
    } else {
      const depts = [...new Set([...as.depts, ...rs.edit])];
      if (!as.all && !rs.editAll) {
        if (!depts.length) throw new ForbiddenException('არყოფნის რეესტრზე წვდომა არ გაქვთ');
        x = x.where('s.department_id', 'in', depts);
      }
    }
    if (q.status) x = x.where('a.status', '=', q.status);
    if (q.department_id) x = x.where('s.department_id', '=', q.department_id);
    if (q.staff_id) x = x.where('a.staff_id', '=', q.staff_id);
    if (q.type_id) x = x.where('a.absence_type_id', '=', q.type_id);
    if (q.year) x = x.where('a.balance_year', '=', Number(q.year));
    if (q.from) x = x.where('a.date_to', '>=', q.from);
    if (q.to) x = x.where('a.date_from', '<=', q.to);
    const rows = await x.execute();
    const st = (r: (typeof rows)[number]): SRow => ({ id: r.staff_id, name: r.staff_name, user_id: r.staff_user_id, department_id: r.department_id, department_name: r.department_name, category: null, is_active: true, hired_on: null, left_on: null });
    const out = rows.map((r) => ({ ...r, can_act: this.canAct(as, u, r, st(r)), can_cancel_decide: !!r.cancel_requested_at && r.status === 'approved' && r.staff_user_id !== u.id && (canHead(as, r.department_id) || as.hr) }));
    return scope === 'approve' ? out.filter((r) => r.can_act || r.can_cancel_decide) : out;
  }

  async detail(id: string, u: AuthUser) {
    await this.settings();
    const row = await this.listQ().leftJoin('users as hu', 'hu.id', 'a.head_by').leftJoin('users as ru', 'ru.id', 'a.hr_by').leftJoin('users as xu', 'xu.id', 'a.cancelled_by')
      .select(['a.head_at', 'a.head_note', 'a.hr_at', 'a.hr_note', 'a.cancelled_at', 'a.shortened_from', 'a.roster_applied', 'a.doc_name', 'a.doc_mime',
        sql<string | null>`hu.last_name || ' ' || hu.first_name`.as('head_by_name'), sql<string | null>`ru.last_name || ' ' || ru.first_name`.as('hr_by_name'),
        sql<string | null>`xu.last_name || ' ' || xu.first_name`.as('cancelled_by_name')])
      .where('a.id', '=', id).executeTakeFirst();
    if (!row) throw new NotFoundException('მოთხოვნა ვერ მოიძებნა');
    const st = await this.staff(this.db, row.staff_id);
    const self = st.user_id === u.id;
    const as = await absenceScope(this.db, u);
    const mgr = await this.manager(this.db, u, st, as);
    if (!self && !mgr && !as.all) throw new ForbiddenException('ნახვის უფლება არ გაქვთ');
    // განრიგზე გავლენა (დადასტურებამდე — წინასწარ)
    const impact = await this.db.selectFrom('roster_entries as e').innerJoin('rosters as r', 'r.id', 'e.roster_id').innerJoin('departments as d', 'd.id', 'r.department_id')
      .innerJoin('shift_templates as tp', 'tp.id', 'e.shift_template_id')
      .select(['e.id', sql<string>`to_char(e.day, 'YYYY-MM-DD')`.as('day'), 'tp.code', 'r.status as roster_status', 'd.name as department_name', 'e.duty_role_id'])
      .where('e.staff_id', '=', row.staff_id).where('e.status', '=', 'active').where('e.day', '>=', row.date_from).where('e.day', '<=', row.date_to).orderBy('e.starts_at').execute();
    const ty = await this.type(this.db, row.absence_type_id);
    const bal = ty.has_balance ? await this.balance(this.db, row.staff_id, ty.id, row.balance_year, row.status === 'head' || row.status === 'hr' ? row.id : undefined) : null;
    const started = row.date_from <= today();
    return {
      ...row, route_name: ROUTE_KA[row.route], status_name: STATUS_KA[row.status], impact, balance: bal,
      can: {
        approve: this.canAct(as, u, row, st), reject: this.canAct(as, u, row, st),
        cancel: (row.status === 'head' || row.status === 'hr') ? (self || mgr || row.status === 'head' && canHead(as, st.department_id)) : row.status === 'approved' && !started && (self || (!self && (canHead(as, st.department_id) || as.hr))),
        cancel_is_request: row.status === 'approved' && self && row.route !== 'none',
        cancel_decide: row.status === 'approved' && !!row.cancel_requested_at && !self && (canHead(as, st.department_id) || as.hr),
        shorten: row.status === 'approved' && as.hr && row.date_to > row.date_from,
        edit: row.status !== 'rejected' && row.status !== 'cancelled' && (mgr || (self && (row.status === 'head' || row.status === 'hr'))),
        overdraw: as.hr,
      },
    };
  }

  // ---------------------------------------------------------------- ბალანსები
  /** ერთი თანამშრომელი (ან საკუთარი): ბალანსიანი ტიპები — დარიცხული / კორექცია / გამოყენებული / ნაშთი / განხილვაში / ხელმისაწვდომი + ჟურნალი */
  async balances(u: AuthUser, q: { staff_id?: string; year?: string; department_id?: string }) {
    await this.settings();
    const year = Number(q.year ?? today().slice(0, 4));
    const types = (await this.db.selectFrom('absence_types').select(['id', 'code', 'name', 'short', 'unit', 'has_balance', 'default_days', 'route', 'requires_document', 'self_request', 'is_active', 'paid', 'color'])
      .where('has_balance', '=', true).orderBy('sort_order').execute());
    const as = await absenceScope(this.db, u);
    if (q.department_id) {
      const rs = await rosterScope(this.db, u);
      if (!canHead(as, q.department_id) && !canEdit(rs, q.department_id)) throw new ForbiddenException('განყოფილება თქვენს არეში არ არის');
      const staff = await this.staffQ(this.db).where('s.department_id', '=', q.department_id).where('s.is_active', '=', true).orderBy('s.last_name').execute();
      for (const s of staff) for (const ty of types) await this.ensureAccrual(this.db, s, ty, year);
      const sums = staff.length ? await this.db.selectFrom('absence_balance_entries').select(['staff_id', 'absence_type_id', sql<string>`sum(days)`.as('total'),
        sql<string>`sum(days) FILTER (WHERE kind IN ('use', 'restore'))`.as('used')]).where('staff_id', 'in', staff.map((s) => s.id)).where('year', '=', year).groupBy(['staff_id', 'absence_type_id']).execute() : [];
      const pend = staff.length ? await this.db.selectFrom('absence_requests').select(['staff_id', 'absence_type_id', sql<string>`sum(days)`.as('p')]).where('staff_id', 'in', staff.map((s) => s.id))
        .where('balance_year', '=', year).where('status', 'in', ['head', 'hr']).groupBy(['staff_id', 'absence_type_id']).execute() : [];
      return { year, types, staff: staff.map((s) => ({ id: s.id, name: s.name, items: types.map((ty) => {
        const x = sums.find((z) => z.staff_id === s.id && z.absence_type_id === ty.id); const p = pend.find((z) => z.staff_id === s.id && z.absence_type_id === ty.id);
        const total = Number(x?.total ?? 0); const pending = Number(p?.p ?? 0);
        return { absence_type_id: ty.id, total, used: -Number(x?.used ?? 0), pending, available: r1(total - pending) };
      }) })) };
    }
    const me = q.staff_id ? null : await this.own(u);
    const sid = q.staff_id ?? me?.id;
    if (!sid) return { year, staff: null, items: [] };
    const st = await this.staff(this.db, sid);
    if (st.user_id !== u.id && !(await this.manager(this.db, u, st, as)) && !as.all) throw new ForbiddenException('ნახვის უფლება არ გაქვთ');
    const items = [];
    for (const ty of types) {
      await this.ensureAccrual(this.db, st, ty, year);
      const ledger = await this.db.selectFrom('absence_balance_entries as b').leftJoin('users as u', 'u.id', 'b.user_id').leftJoin('absence_requests as a', 'a.id', 'b.request_id')
        .select(['b.id', 'b.kind', 'b.period', 'b.days', 'b.reason', 'b.created_at', sql<string | null>`a.no::text`.as('request_no'), sql<string | null>`u.last_name || ' ' || u.first_name`.as('user_name')])
        .where('b.staff_id', '=', st.id).where('b.absence_type_id', '=', ty.id).where('b.year', '=', year).orderBy('b.id').execute();
      const sum = (k: string[]) => r1(ledger.filter((l) => k.includes(l.kind)).reduce((a, l) => a + Number(l.days), 0));
      const b = await this.balance(this.db, st.id, ty.id, year);
      items.push({ type: ty, entitlement: await this.entitlement(this.db, st.id, ty), override: !!(await this.db.selectFrom('absence_entitlements').select('staff_id').where('staff_id', '=', st.id).where('absence_type_id', '=', ty.id).executeTakeFirst()),
        accrued: sum(['accrual']), adjusted: sum(['adjust', 'carry']), used: -sum(['use', 'restore']), ...b, ledger });
    }
    return { year, staff: { id: st.id, name: st.name, department_name: st.department_name }, items, can_adjust: as.hr };
  }

  async addEntry(d: BalanceDto, u: AuthUser, ctx: AuditContext) {
    await this.settings();
    const ty = await this.type(this.db, d.absence_type_id);
    if (!ty.has_balance) throw new BadRequestException('ამ ტიპს ბალანსი არ აქვს');
    if (d.days === 0) throw new BadRequestException('დღეები ≠ 0');
    const st = await this.staff(this.db, d.staff_id);
    const r = await this.db.insertInto('absence_balance_entries').values({ staff_id: st.id, absence_type_id: ty.id, year: d.year, kind: d.kind, days: String(r1(d.days)), reason: d.reason.trim(), user_id: u.id })
      .returning('id').executeTakeFirstOrThrow();
    await this.audit.log(ctx, { action: 'ABSENCE_BALANCE_ENTRY', entityName: 'staff_members', entityId: st.id, newData: d });
    return { id: r.id, balance: await this.balance(this.db, st.id, ty.id, d.year) };
  }
  async setEntitlement(d: EntitlementDto, u: AuthUser, ctx: AuditContext) {
    await this.settings();
    const ty = await this.type(this.db, d.absence_type_id);
    if (!ty.has_balance) throw new BadRequestException('ამ ტიპს ბალანსი არ აქვს');
    await this.staff(this.db, d.staff_id);
    if (d.days_per_year === null || d.days_per_year === undefined) await this.db.deleteFrom('absence_entitlements').where('staff_id', '=', d.staff_id).where('absence_type_id', '=', ty.id).execute();
    else await this.db.insertInto('absence_entitlements').values({ staff_id: d.staff_id, absence_type_id: ty.id, days_per_year: String(d.days_per_year), note: t(d.note) ?? null, updated_by: u.id })
      .onConflict((oc) => oc.columns(['staff_id', 'absence_type_id']).doUpdateSet({ days_per_year: String(d.days_per_year), note: t(d.note) ?? null, updated_by: u.id, updated_at: sql`now()` })).execute();
    await this.audit.log(ctx, { action: 'ABSENCE_ENTITLEMENT', entityName: 'staff_members', entityId: d.staff_id, newData: d });
    return { ok: true, note: 'უკვე დარიცხულ წელს არ ცვლის — საჭიროებისას კორექცია' };
  }
}

// ======================================================================= DTO
const DAY = /^\d{4}-\d{2}-\d{2}$/;
class TypeDto {
  @IsOptional() @Matches(/^[A-Z][A-Z0-9_]{1,19}$/) code?: string; @IsOptional() @IsString() @Length(2, 200) name?: string; @IsOptional() @IsString() @Length(1, 3) short?: string;
  @IsOptional() @Matches(/^#[0-9a-fA-F]{6}$/) color?: string; @IsOptional() @IsBoolean() paid?: boolean; @IsOptional() @IsBoolean() counts_as_work?: boolean;
  @IsOptional() @IsIn(['workday', 'calendar']) unit?: string; @IsOptional() @IsBoolean() has_balance?: boolean; @IsOptional() @IsNumber() @Min(0) @Max(366) default_days?: number | null;
  @IsOptional() @IsIn(['head_hr', 'head', 'hr', 'none']) route?: string; @IsOptional() @IsBoolean() requires_document?: boolean; @IsOptional() @IsBoolean() self_request?: boolean;
  @IsOptional() @IsBoolean() is_active?: boolean; @IsOptional() @IsInt() sort_order?: number;
}
class CreateDto {
  @IsOptional() @IsUUID() staff_id?: string; @IsUUID() absence_type_id: string; @Matches(DAY) date_from: string; @Matches(DAY) date_to: string;
  @IsOptional() @IsString() @MaxLength(1000) note?: string | null; @IsOptional() @IsString() @MaxLength(60) document_no?: string | null; @IsOptional() @IsString() @MaxLength(500) overdraw_reason?: string | null;
}
class DecideDto { @IsOptional() @IsString() @MaxLength(1000) note?: string | null; @IsOptional() @IsString() @MaxLength(500) overdraw_reason?: string | null }
class ReasonDto { @IsString() @Length(3, 1000) reason: string }
class CancelDecisionDto { @IsBoolean() approve: boolean; @IsOptional() @IsString() @MaxLength(1000) note?: string | null }
class ShortenDto { @Matches(DAY) date_to: string; @IsString() @Length(3, 1000) reason: string }
class UpdateDto { @IsOptional() @IsString() @MaxLength(60) document_no?: string | null; @IsOptional() @IsString() @MaxLength(1000) note?: string | null }
class BalanceDto {
  @IsUUID() staff_id: string; @IsUUID() absence_type_id: string; @IsInt() @Min(2000) @Max(2100) year: number; @IsIn(['adjust', 'carry']) kind: 'adjust' | 'carry';
  @IsNumber() @Min(-366) @Max(366) days: number; @IsString() @Length(3, 500) reason: string;
}
class EntitlementDto { @IsUUID() staff_id: string; @IsUUID() absence_type_id: string; @IsOptional() @IsNumber() @Min(0) @Max(366) days_per_year?: number | null; @IsOptional() @IsString() @MaxLength(500) note?: string | null }
interface ListQ { scope?: 'my' | 'approve' | 'all'; status?: string; department_id?: string; staff_id?: string; type_id?: string; year?: string; from?: string; to?: string }
const uuidOk = (v?: string) => !v || /^[0-9a-f-]{36}$/i.test(v);

/** ცვლები / მორიგეობა — არყოფნა (0078). უფლებები — სერვისში (თანამშრომელი / ხელმძღვანელის არე / HR) */
@Controller('roster')
export class AbsenceController {
  constructor(private readonly s: AbsenceService) {}
  @Get('absence-types') types() { return this.s.types(); }
  @Post('absence-types') @Roles(...ROSTER_HR) typeC(@Body() d: TypeDto, @Req() r: Request) {
    if (!d.code || !d.name || !d.short) throw new BadRequestException('კოდი, დასახელება და მოკლე კოდი სავალდებულოა');
    return this.s.saveType(null, d, auditCtx(r));
  }
  @Patch('absence-types/:id') @Roles(...ROSTER_HR) typeU(@Param('id', ParseUUIDPipe) id: string, @Body() d: TypeDto, @Req() r: Request) {
    if (d.code !== undefined) throw new BadRequestException('კოდი არ იცვლება');
    return this.s.saveType(id, d, auditCtx(r));
  }
  @Get('absences') list(@CurrentUser() u: AuthUser, @Query() q: ListQ) {
    if (!uuidOk(q.department_id) || !uuidOk(q.staff_id) || !uuidOk(q.type_id)) throw new BadRequestException('არასწორი id');
    if (q.scope && !['my', 'approve', 'all'].includes(q.scope)) throw new BadRequestException('scope');
    if (q.year && !/^\d{4}$/.test(q.year)) throw new BadRequestException('year');
    if ((q.from && !DAY.test(q.from)) || (q.to && !DAY.test(q.to))) throw new BadRequestException('from / to — YYYY-MM-DD');
    return this.s.list(u, q);
  }
  @Post('absences') create(@Body() d: CreateDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.create(d, u, auditCtx(r)); }
  @Get('absences/:id') one(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser) { return this.s.detail(id, u); }
  @Patch('absences/:id') update(@Param('id', ParseUUIDPipe) id: string, @Body() d: UpdateDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.update(id, d, u, auditCtx(r)); }
  @Post('absences/:id/approve') @HttpCode(200) approve(@Param('id', ParseUUIDPipe) id: string, @Body() d: DecideDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.approve(id, d, u, auditCtx(r)); }
  @Post('absences/:id/reject') @HttpCode(200) reject(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.reject(id, d.reason, u, auditCtx(r)); }
  @Post('absences/:id/cancel') @HttpCode(200) cancel(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.cancel(id, d.reason, u, auditCtx(r)); }
  @Post('absences/:id/cancel-decision') @HttpCode(200) cancelDecision(@Param('id', ParseUUIDPipe) id: string, @Body() d: CancelDecisionDto, @CurrentUser() u: AuthUser, @Req() r: Request) {
    return this.s.cancelDecision(id, d, u, auditCtx(r));
  }
  @Post('absences/:id/shorten') @HttpCode(200) shorten(@Param('id', ParseUUIDPipe) id: string, @Body() d: ShortenDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.shorten(id, d, u, auditCtx(r)); }
  @Post('absences/:id/document') @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }))
  upload(@Param('id', ParseUUIDPipe) id: string, @UploadedFile() f: Express.Multer.File | undefined, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.upload(id, f, u, auditCtx(r)); }
  @Get('absences/:id/document')
  async file(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Res({ passthrough: true }) res: Response) {
    const f = await this.s.file(id, u);
    res.set({ 'Content-Type': f.mime, 'Content-Disposition': 'inline', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    return new StreamableFile(f.stream);
  }
  @Get('balances') balances(@CurrentUser() u: AuthUser, @Query('staff_id') staffId?: string, @Query('year') year?: string, @Query('department_id') dept?: string) {
    if (!uuidOk(staffId) || !uuidOk(dept)) throw new BadRequestException('არასწორი id');
    if (year && !/^\d{4}$/.test(year)) throw new BadRequestException('year');
    return this.s.balances(u, { staff_id: staffId, year, department_id: dept });
  }
  @Post('balances/entries') @Roles(...ABSENCE_HR) entry(@Body() d: BalanceDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.addEntry(d, u, auditCtx(r)); }
  @Put('balances/entitlement') @Roles(...ABSENCE_HR) entitlement(@Body() d: EntitlementDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.setEntitlement(d, u, auditCtx(r)); }
}
