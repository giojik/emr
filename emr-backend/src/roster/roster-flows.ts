import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, IsUUID, Length, Matches, MaxLength, ValidateNested } from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser } from '../auth/decorators';
import type { AuthUser } from '../auth/roles';
import { mapPgError } from '../common/pg-errors';
import { InjectDb, type Database } from '../database/database.module';
import { NotificationsService } from '../notifications/notifications';
import { AbsenceService } from './roster-absence';
import { addDays, canEdit, canView, monthDays, needEdit, rosterEditors, rosterScope, shiftTimes, staffName, today, tz, type Ex, type Trx } from './roster-common';
import { PG, RosterService, ddmm, monthLabel, type Change, type Ctx, type EntryIn, type Roster } from './roster';

type Ent = { id: string; roster_id: string; staff_id: string; day: string; shift_template_id: string; duty_role_id: string | null; duty_level: number | null; note: string | null; status: string;
  code: string; start_local: string; end_local: string; start_time: string; end_time: string; starts_at: Date | string; roster_status: string; department_id: string };
type Note = { user: string; kind: string; title: string; body?: string; item?: string; entity: string; link?: string };
const SW_KA: Record<string, string> = { peer: 'კოლეგასთან', head: 'ხელმძღვანელთან', approved: 'შესრულებული', rejected: 'უარყოფილი', declined: 'კოლეგამ უარი თქვა', cancelled: 'გაუქმებული', expired: 'ვადაგასული' };

/**
 * ცვლები / მორიგეობა (0078): დასაფარი ცვლები (E), გაცვლა / გადაცემა (F), „არ შემიძლია“ / „მირჩევნია“ (H), „დასადასტურებელი“ (I).
 * განრიგის შემოწმება (გადაფარვა, წესები, არყოფნა) — RosterService.check.
 */
@Injectable()
export class RosterFlowsService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService, private readonly notifications: NotificationsService,
    private readonly roster: RosterService, private readonly absence: AbsenceService) {}
  private settings() { return this.roster.settings(); }
  private async send(notes: Note[]) {
    for (const n of notes) await this.notifications.notify(n.user, { kind: n.kind, title: n.title, body: n.body ?? null, link: n.link ?? null, entityId: n.entity, item: n.item ?? null });
  }
  private async me(u: AuthUser, ex: Ex = this.db) {
    return ex.selectFrom('staff_members as s').leftJoin('staff_positions as p', 'p.id', 's.position_id')
      .select(['s.id', staffName('s').as('name'), 's.department_id', 'p.category', 's.is_active',
        sql<string[]>`coalesce((SELECT array_agg(x.department_id) FROM staff_member_departments x WHERE x.staff_id = s.id), '{}')`.as('extra')])
      .where('s.user_id', '=', u.id).executeTakeFirst();
  }
  private async needMe(u: AuthUser, ex: Ex = this.db) {
    const m = await this.me(u, ex);
    if (!m) throw new BadRequestException('თქვენი ანგარიში თანამშრომლების რეესტრში არ არის მიბმული — მიმართეთ განრიგის შემდგენს / HR-ს');
    return m;
  }
  private async ent(ex: Ex, id: string, lock = false): Promise<Ent> {
    let q = ex.selectFrom('roster_entries as e').innerJoin('shift_templates as t', 't.id', 'e.shift_template_id').innerJoin('rosters as r', 'r.id', 'e.roster_id')
      .select(['e.id', 'e.roster_id', 'e.staff_id', sql<string>`to_char(e.day, 'YYYY-MM-DD')`.as('day'), 'e.shift_template_id', 'e.duty_role_id', 'e.duty_level', 'e.note', 'e.status', 't.code',
        sql<string>`to_char(e.starts_at AT TIME ZONE ${tz}, 'HH24:MI')`.as('start_local'), sql<string>`to_char(e.ends_at AT TIME ZONE ${tz}, 'HH24:MI')`.as('end_local'), 't.start_time', 't.end_time',
        'e.starts_at', 'r.status as roster_status', 'r.department_id']).where('e.id', '=', id);
    if (lock) q = q.forUpdate('e');
    const e = await q.executeTakeFirst();
    if (!e) throw new NotFoundException('ცვლა ვერ მოიძებნა');
    return e;
  }
  private entryIn(e: Ent, staffId: string): EntryIn {
    const custom = e.start_local !== e.start_time.slice(0, 5) || e.end_local !== e.end_time.slice(0, 5);
    return { staff_id: staffId, day: e.day, shift_template_id: e.shift_template_id, duty_role_id: e.duty_role_id, duty_level: e.duty_level,
      start_time: custom ? e.start_local : null, end_time: custom ? e.end_local : null, note: e.note };
  }
  private async staffCat(ex: Ex, id: string) {
    const s = await ex.selectFrom('staff_members as s').leftJoin('staff_positions as p', 'p.id', 's.position_id').select(['s.id', staffName('s').as('name'), 's.user_id', 'p.category', 's.is_active'])
      .where('s.id', '=', id).executeTakeFirst();
    if (!s) throw new NotFoundException('თანამშრომელი ვერ მოიძებნა');
    return s;
  }

  // ================================================================ დასაფარი ცვლები (E)
  private openQ(ex: Ex) {
    return ex.selectFrom('roster_open_shifts as o').innerJoin('rosters as r', 'r.id', 'o.roster_id').innerJoin('departments as d', 'd.id', 'r.department_id')
      .innerJoin('shift_templates as t', 't.id', 'o.shift_template_id').leftJoin('duty_roles as dr', 'dr.id', 'o.duty_role_id')
      .select(['o.id', 'o.roster_id', 'r.department_id', 'd.name as department_name', sql<string>`to_char(o.day, 'YYYY-MM-DD')`.as('day'), 'o.shift_template_id', 't.code', 't.name as shift_name', 't.color',
        'o.starts_at', 'o.ends_at', 'o.hours', 'o.duty_role_id', 'dr.name as duty_name', 'o.duty_level', 'o.category', 'o.source', 'o.note', 'o.status', 'o.created_at', 'r.status as roster_status']);
  }
  /** roster_id — შემდგენს / მნახველს; mine — თანამშრომელს: მისი განყოფილებ(ებ)ის და კატეგორიის ღია ცვლები (მომავალში) */
  async openShifts(u: AuthUser, q: { roster_id?: string; mine?: string }) {
    const s = await this.settings();
    if (q.roster_id) {
      const r = await this.roster.roster(this.db, q.roster_id);
      const sc = await rosterScope(this.db, u);
      if (!canEdit(sc, r.department_id) && !(canView(sc, r.department_id) && r.status !== 'draft')) throw new ForbiddenException('განყოფილება თქვენს არეში არ არის');
      return this.openQ(this.db).where('o.roster_id', '=', r.id).where('o.status', '=', 'open').orderBy('o.starts_at').execute();
    }
    const me = await this.me(u);
    if (!me) return { staff: null, volunteer: s.open_shift_volunteer, items: [] };
    const depts = [me.department_id, ...me.extra];
    const rows = await this.openQ(this.db).select([sql<string | null>`(SELECT f.status FROM roster_open_shift_offers f WHERE f.open_shift_id = o.id AND f.staff_id = ${me.id})`.as('my_offer'),
      sql<boolean>`EXISTS (SELECT 1 FROM roster_entries e WHERE e.staff_id = ${me.id} AND e.status = 'active' AND tstzrange(e.starts_at, e.ends_at) && tstzrange(o.starts_at, o.ends_at))`.as('busy'),
      sql<boolean>`EXISTS (SELECT 1 FROM absence_requests a WHERE a.staff_id = ${me.id} AND a.status = 'approved' AND o.day BETWEEN a.date_from AND a.date_to)`.as('absent')])
      .where('o.status', '=', 'open').where('r.status', '=', 'published').where('o.starts_at', '>', new Date()).where('r.department_id', 'in', depts)
      .where((eb) => eb.or([eb('o.category', 'is', null), eb('o.category', '=', me.category ?? '-')]))
      .orderBy('o.starts_at').limit(300).execute();
    return { staff: { id: me.id, name: me.name }, volunteer: s.open_shift_volunteer, items: rows };
  }

  async createOpen(rosterId: string, d: OpenDto, u: AuthUser, ctx: AuditContext) {
    await this.settings();
    const id = await this.db.transaction().execute(async (trx) => {
      const r = await this.roster.roster(trx, rosterId, true);
      needEdit(await rosterScope(trx, u), r.department_id);
      if (r.status !== 'published') throw new ConflictException({ code: 'ROSTER_NOT_PUBLISHED', message: 'დასაფარი — მხოლოდ გამოქვეყნებულ განრიგში (მონახაზში — ხარვეზები ბადეში ჩანს)' });
      if (d.day.slice(0, 7) !== r.month.slice(0, 7)) throw new BadRequestException('დღე განრიგის თვეში არ არის');
      const t = await trx.selectFrom('shift_templates').selectAll().where('id', '=', d.shift_template_id).executeTakeFirst();
      if (!t || !t.is_active) throw new BadRequestException('ცვლა ვერ მოიძებნა ან გათიშულია');
      if (!!d.start_time !== !!d.end_time) throw new BadRequestException('დრო: დასაწყისი და დასასრული ერთად');
      if (d.duty_role_id) {
        const dr = await trx.selectFrom('duty_roles').select(['department_id', 'has_backup', 'is_active']).where('id', '=', d.duty_role_id).executeTakeFirst();
        if (!dr || !dr.is_active || (dr.department_id && dr.department_id !== r.department_id)) throw new BadRequestException('მორიგის როლი ვერ მოიძებნა / სხვა განყოფილებისაა');
        if ((d.duty_level ?? 1) === 2 && !dr.has_backup) throw new BadRequestException('მორიგის როლს II დონე არ აქვს');
      }
      const tm = shiftTimes(d.day, d.start_time ?? t.start_time, d.end_time ?? t.end_time, t.break_min, t.counted_hours === null ? null : Number(t.counted_hours));
      const o = await trx.insertInto('roster_open_shifts').values({ roster_id: r.id, day: d.day, shift_template_id: t.id, starts_at: new Date(tm.starts), ends_at: new Date(tm.ends), hours: String(tm.hours),
        duty_role_id: d.duty_role_id ?? null, duty_level: d.duty_role_id ? d.duty_level ?? 1 : null, category: d.category ?? null, source: 'manual', note: d.note?.trim() || null, created_by: u.id })
        .returning('id').executeTakeFirstOrThrow();
      await this.audit.log(ctx, { action: 'CREATE_OPEN_SHIFT', entityName: 'roster_open_shifts', entityId: o.id, newData: d }, trx);
      return o.id;
    });
    await this.roster.notifyOpenShifts([id]);
    return { id };
  }

  private async open(trx: Trx, id: string) {
    const o = await trx.selectFrom('roster_open_shifts').selectAll().select(sql<string>`to_char(day, 'YYYY-MM-DD')`.as('d')).where('id', '=', id).forUpdate().executeTakeFirst();
    if (!o) throw new NotFoundException('დასაფარი ცვლა ვერ მოიძებნა');
    return o;
  }

  /** „ავიღებ“ (მოხალისე) — თანამშრომელი თავისი განყოფილებ(ებ)ის და კატეგორიის ღია ცვლაზე; შემდგენს — შეტყობინება */
  async offer(id: string, note: string | null | undefined, u: AuthUser) {
    const s = await this.settings();
    if (!s.open_shift_volunteer) throw new ForbiddenException('„ავიღებ“ გამორთულია (პარამეტრი)');
    const notes: Note[] = [];
    await this.db.transaction().execute(async (trx) => {
      const me = await this.needMe(u, trx);
      const o = await this.open(trx, id);
      const r = await this.roster.roster(trx, o.roster_id);
      if (o.status !== 'open' || r.status !== 'published') throw new ConflictException({ code: 'OPEN_SHIFT_CLOSED', message: 'ცვლა უკვე აღარ არის ღია' });
      if (new Date(o.starts_at).getTime() <= Date.now()) throw new ConflictException({ code: 'OPEN_SHIFT_CLOSED', message: 'ცვლა უკვე დაიწყო' });
      if (![me.department_id, ...me.extra].includes(r.department_id)) throw new ForbiddenException('ეს განყოფილება თქვენი (ძირითადი / დამატებითი) არ არის');
      if (o.category && o.category !== me.category) throw new ForbiddenException('ცვლა სხვა კატეგორიისთვისაა');
      await trx.insertInto('roster_open_shift_offers').values({ open_shift_id: o.id, staff_id: me.id, note: note?.trim() || null })
        .onConflict((oc) => oc.columns(['open_shift_id', 'staff_id']).doUpdateSet({ status: 'offered', note: note?.trim() || null })).execute();
      const code = (await trx.selectFrom('shift_templates').select('code').where('id', '=', o.shift_template_id).executeTakeFirstOrThrow()).code;
      for (const x of await rosterEditors(trx, r.department_id)) if (x !== u.id) notes.push({ user: x, kind: 'open_shift_offer', title: `„ავიღებ“: ${me.name}`, body: r.department_name,
        item: `${ddmm(o.d)} ${code}`, entity: o.id, link: `/roster?tab=grid&dept=${r.department_id}&month=${r.month.slice(0, 7)}` });
    });
    await this.send(notes);
    return { ok: true };
  }
  async withdraw(id: string, u: AuthUser) {
    await this.settings();
    const me = await this.needMe(u);
    const r = await this.db.updateTable('roster_open_shift_offers').set({ status: 'withdrawn' }).where('open_shift_id', '=', id).where('staff_id', '=', me.id).where('status', '=', 'offered').executeTakeFirst();
    if (!Number(r.numUpdatedRows)) throw new NotFoundException('შეთავაზება ვერ მოიძებნა');
    return { ok: true };
  }

  /** შევსება (შემდგენი): ჩვეულებრივი შემოწმებით (გადაფარვა, წესები, არყოფნა); მოხალისეებს — სტატუსი; ისტორია „fill“, ვერსია +1 */
  async assign(id: string, d: { staff_id: string; reason?: string | null }, u: AuthUser, ctx: AuditContext) {
    await this.settings();
    const res = await this.db.transaction().execute(async (trx) => {
      const o = await this.open(trx, id);
      const r = await this.roster.roster(trx, o.roster_id, true);
      needEdit(await rosterScope(trx, u), r.department_id);
      if (o.status !== 'open') throw new ConflictException({ code: 'OPEN_SHIFT_CLOSED', message: 'ცვლა უკვე აღარ არის ღია' });
      if (r.status !== 'published') throw new ConflictException({ code: 'ROSTER_NOT_PUBLISHED', message: 'განრიგი გამოქვეყნებული არ არის' });
      const t = await trx.selectFrom('shift_templates').select(['start_time', 'end_time', 'code']).where('id', '=', o.shift_template_id).executeTakeFirstOrThrow();
      const loc = await sql<{ s: string; e: string }>`SELECT to_char(${o.starts_at}::timestamptz AT TIME ZONE ${tz}, 'HH24:MI') s, to_char(${o.ends_at}::timestamptz AT TIME ZONE ${tz}, 'HH24:MI') e`.execute(trx);
      const { s: ls, e: le } = loc.rows[0];
      const custom = ls !== t.start_time.slice(0, 5) || le !== t.end_time.slice(0, 5);
      const c = await this.roster.context(trx, r, [d.staff_id]);
      const v = this.roster.check(c, r, { staff_id: d.staff_id, day: o.d, shift_template_id: o.shift_template_id, duty_role_id: o.duty_role_id, duty_level: o.duty_level,
        start_time: custom ? ls : null, end_time: custom ? le : null, note: o.note });
      if (!v.cand) throw new ConflictException({ code: v.code ?? 'ROSTER_RULE', message: v.error });
      const eid = await this.roster.insert(trx, v.cand, u);
      await trx.updateTable('roster_open_shifts').set({ status: 'filled', filled_entry_id: eid, closed_by: u.id, closed_at: sql`now()` }).where('id', '=', o.id).execute();
      await trx.updateTable('roster_open_shift_offers').set({ status: sql`CASE WHEN staff_id = ${d.staff_id} THEN 'accepted' ELSE 'declined' END` }).where('open_shift_id', '=', o.id).where('status', '=', 'offered').execute();
      const reason = d.reason?.trim() || 'დასაფარის შევსება';
      await this.roster.afterChange(trx, r, [{ kind: 'fill', entry_id: eid, staff_id: d.staff_id, data: { day: o.d, code: t.code, open_shift: o.id } }], reason, u);
      await this.audit.log(ctx, { action: 'FILL_OPEN_SHIFT', entityName: 'roster_open_shifts', entityId: o.id, newData: { staff_id: d.staff_id, entry_id: eid, reason } }, trx);
      return { r, eid, warnings: v.warnings, day: o.d, code: t.code };
    }).catch((e) => mapPgError(e, PG));
    await this.roster.notifyChanged(res.r, [{ staff_id: d.staff_id, kind: 'fill', data: { day: res.day, code: res.code } }]);
    return { entry_id: res.eid, warnings: res.warnings };
  }
  async cancelOpen(id: string, reason: string, u: AuthUser, ctx: AuditContext) {
    await this.settings();
    await this.db.transaction().execute(async (trx) => {
      const o = await this.open(trx, id);
      const r = await this.roster.roster(trx, o.roster_id);
      needEdit(await rosterScope(trx, u), r.department_id);
      if (o.status !== 'open') throw new ConflictException({ code: 'OPEN_SHIFT_CLOSED', message: 'ცვლა უკვე აღარ არის ღია' });
      await trx.updateTable('roster_open_shifts').set({ status: 'cancelled', closed_by: u.id, closed_at: sql`now()`, cancel_reason: reason.trim() }).where('id', '=', o.id).execute();
      await trx.updateTable('roster_open_shift_offers').set({ status: 'declined' }).where('open_shift_id', '=', o.id).where('status', '=', 'offered').execute();
      await this.audit.log(ctx, { action: 'CANCEL_OPEN_SHIFT', entityName: 'roster_open_shifts', entityId: o.id, newData: { reason } }, trx);
    });
    return { ok: true };
  }

  // ================================================================ გაცვლა / გადაცემა (F)
  private async expire(ex: Ex = this.db) {
    await ex.updateTable('roster_swaps').set({ status: 'expired' }).where('status', 'in', ['peer', 'head']).where('expires_at', '<=', new Date()).execute();
  }
  /**
   * წინასწარი / ხელახალი შემოწმება: A (ინიციატორის ცვლა) → კოლეგას; B (კოლეგის, გაცვლისას) → ინიციატორს.
   * ორივეს სიიდან გაიცემული ცვლა ამოიღება, დანარჩენი — ჩვეულებრივი check (გადაფარვა, წესები, არყოფნა, კატეგორია, სხვა განყოფილება).
   */
  private async simulate(ex: Ex, A: Ent, B: Ent | null, fromStaff: string, toStaff: string) {
    const strip = (c: Ctx) => {
      c.list.set(fromStaff, (c.list.get(fromStaff) ?? []).filter((x) => x.id !== A.id));
      if (B) c.list.set(toStaff, (c.list.get(toStaff) ?? []).filter((x) => x.id !== B.id));
      return c;
    };
    const rA = await this.roster.roster(ex, A.roster_id);
    const cA = strip(await this.roster.context(ex, rA, [fromStaff, toStaff]));
    const vA = this.roster.check(cA, rA, this.entryIn(A, toStaff));
    const errors: string[] = []; const warnings = [...vA.warnings];
    if (!vA.cand) errors.push(vA.error!);
    let rB: Roster | null = null;
    if (B) {
      rB = B.roster_id === A.roster_id ? rA : await this.roster.roster(ex, B.roster_id);
      const cB = B.roster_id === A.roster_id ? cA : strip(await this.roster.context(ex, rB, [fromStaff, toStaff]));
      const vB = this.roster.check(cB, rB, this.entryIn(B, fromStaff));
      warnings.push(...vB.warnings);
      if (!vB.cand) errors.push(vB.error!);
    }
    return { errors, warnings: [...new Set(warnings)], rA, rB };
  }

  async createSwap(d: SwapDto, u: AuthUser, ctx: AuditContext) {
    const s = await this.settings();
    const notes: Note[] = [];
    const res = await this.db.transaction().execute(async (trx) => {
      const me = await this.needMe(u, trx);
      const A = await this.ent(trx, d.from_entry_id, true);
      if (A.staff_id !== me.id) throw new ForbiddenException('გაცვლა / გადაცემა — მხოლოდ საკუთარი ცვლის');
      const minStart = Date.now() + s.swap_min_notice_hours * 36e5;
      const ok = (e: Ent, who: string) => {
        if (e.status !== 'active') throw new BadRequestException(`${who}: ცვლა გაუქმებულია`);
        if (e.roster_status !== 'published') throw new ConflictException({ code: 'ROSTER_NOT_PUBLISHED', message: `${who}: მხოლოდ გამოქვეყნებული განრიგის ცვლა` });
        if (new Date(e.starts_at).getTime() < minStart) throw new ConflictException({ code: 'SWAP_TOO_LATE', message: `${who}: დაწყებამდე ${s.swap_min_notice_hours} სთ-ზე ნაკლებია` });
      };
      ok(A, 'ჩემი ცვლა');
      let B: Ent | null = null; let toStaff: string;
      if (d.kind === 'swap') {
        if (!d.to_entry_id) throw new BadRequestException('გაცვლა: კოლეგის ცვლა სავალდებულოა');
        B = await this.ent(trx, d.to_entry_id, true); ok(B, 'კოლეგის ცვლა');
        toStaff = B.staff_id;
        if (new Date(A.starts_at).getTime() === new Date(B.starts_at).getTime() && A.day === B.day && A.shift_template_id === B.shift_template_id && A.roster_id === B.roster_id)
          throw new BadRequestException('ერთი და იგივე ცვლაა — გაცვლას აზრი არ აქვს');
      } else {
        if (!d.to_staff_id) throw new BadRequestException('გადაცემა: კოლეგა სავალდებულოა');
        toStaff = d.to_staff_id;
      }
      if (toStaff === me.id) throw new BadRequestException('კოლეგა — სხვა თანამშრომელი');
      const peer = await this.staffCat(trx, toStaff);
      if (!peer.is_active) throw new BadRequestException(`${peer.name} — გათიშულია`);
      if (!peer.user_id) throw new BadRequestException({ code: 'SWAP_NO_ACCOUNT', message: `${peer.name} — EMR ანგარიში არ აქვს (თანხმობას ვერ მისცემს). ჩანაცვლება — შემდგენის მიერ` });
      if ((peer.category ?? null) !== (me.category ?? null)) throw new BadRequestException({ code: 'SWAP_CATEGORY', message: 'გაცვლა — მხოლოდ იმავე კატეგორიის (ექიმი / ექთანი…) კოლეგასთან' });
      const busy = await trx.selectFrom('roster_swaps').select('no').where('status', 'in', ['peer', 'head'])
        .where((eb) => eb.or([eb('from_entry_id', 'in', [A.id, ...(B ? [B.id] : [])]), eb('to_entry_id', 'in', [A.id, ...(B ? [B.id] : [])])])).executeTakeFirst();
      if (busy) throw new ConflictException({ code: 'SWAP_BUSY', message: `ამ ცვლაზე აქტიური გაცვლა უკვე არის (#${busy.no})` });
      const sim = await this.simulate(trx, A, B, me.id, toStaff);
      if (sim.errors.length) throw new ConflictException({ code: 'SWAP_RULE', message: sim.errors.join('; '), errors: sim.errors });
      const first = Math.min(new Date(A.starts_at).getTime(), B ? new Date(B.starts_at).getTime() : Infinity);
      const sw = await trx.insertInto('roster_swaps').values({ kind: d.kind, from_staff_id: me.id, from_entry_id: A.id, to_staff_id: toStaff, to_entry_id: B?.id ?? null, note: d.note?.trim() || null,
        warnings: JSON.stringify(sim.warnings), expires_at: new Date(first - s.swap_min_notice_hours * 36e5), created_by: u.id }).returning(['id', sql<string>`no::text`.as('no')]).executeTakeFirstOrThrow();
      await this.audit.log(ctx, { action: 'CREATE_SWAP', entityName: 'roster_swaps', entityId: sw.id, newData: d }, trx);
      notes.push({ user: peer.user_id, kind: 'swap_proposed', title: `${d.kind === 'swap' ? 'გაცვლის' : 'გადაცემის'} შეთავაზება: ${me.name}`,
        body: d.note?.trim() || undefined, item: `#${sw.no} ${ddmm(A.day)} ${A.code}${B ? ` ↔ ${ddmm(B.day)} ${B.code}` : ''}`, entity: sw.id, link: '/roster?tab=my&sub=swaps' });
      return { id: sw.id, no: sw.no, warnings: sim.warnings };
    }).catch((e) => mapPgError(e, { uq_sw_from: 'ამ ცვლაზე აქტიური გაცვლა უკვე არის', uq_sw_to: 'კოლეგის ამ ცვლაზე აქტიური გაცვლა უკვე არის' }));
    await this.send(notes);
    return res;
  }

  private async swap(trx: Ex, id: string, lock = false) {
    let q = trx.selectFrom('roster_swaps').selectAll().select(sql<string>`no::text`.as('n')).where('id', '=', id);
    if (lock) q = q.forUpdate();
    const sw = await q.executeTakeFirst();
    if (!sw) throw new NotFoundException('გაცვლა ვერ მოიძებნა');
    return sw;
  }
  private async swapEntries(trx: Ex, sw: { from_entry_id: string; to_entry_id: string | null; from_staff_id: string; to_staff_id: string }) {
    const A = await this.ent(trx, sw.from_entry_id, true); const B = sw.to_entry_id ? await this.ent(trx, sw.to_entry_id, true) : null;
    if (A.status !== 'active' || A.staff_id !== sw.from_staff_id || (B && (B.status !== 'active' || B.staff_id !== sw.to_staff_id)))
      throw new ConflictException({ code: 'SWAP_STALE', message: 'განრიგი შეიცვალა (ცვლა გაუქმდა / სხვას გადაეცა) — გაცვლა შეუძლებელია' });
    return { A, B };
  }
  private async editorOf(trx: Ex, u: AuthUser, A: Ent, B: Ent | null) {
    const sc = await rosterScope(trx, u);
    return canEdit(sc, A.department_id) && (!B || canEdit(sc, B.department_id));
  }
  /** შესრულება (ატომური): ჩანაწერებში staff_id იცვლება, ისტორია swap / give (ორივე განრიგში), ვერსია +1; შეტყობინება ორივეს */
  private async applySwap(trx: Trx, sw: Awaited<ReturnType<RosterFlowsService['swap']>>, A: Ent, B: Ent | null, u: AuthUser) {
    await trx.updateTable('roster_entries').set({ staff_id: sw.to_staff_id }).where('id', '=', A.id).execute();
    if (B) await trx.updateTable('roster_entries').set({ staff_id: sw.from_staff_id }).where('id', '=', B.id).execute();
    const reason = `${sw.kind === 'swap' ? 'გაცვლა' : 'გადაცემა'} #${sw.n}`;
    const per = new Map<string, Change[]>();
    const push = (rid: string, c: Change) => (per.get(rid) ?? per.set(rid, []).get(rid)!).push(c);
    push(A.roster_id, { kind: sw.kind as 'swap' | 'give', entry_id: A.id, staff_id: sw.to_staff_id, data: { day: A.day, code: A.code, from_staff: sw.from_staff_id, swap: sw.n } });
    if (B) push(B.roster_id, { kind: 'swap', entry_id: B.id, staff_id: sw.from_staff_id, data: { day: B.day, code: B.code, from_staff: sw.to_staff_id, swap: sw.n } });
    const rosters: Roster[] = [];
    for (const [rid, ch] of per) { const r = await this.roster.roster(trx, rid, true); await this.roster.afterChange(trx, r, ch, reason, u); rosters.push(r); }
    return { rosters, items: [{ rid: A.roster_id, out: sw.from_staff_id, in: sw.to_staff_id, day: A.day, code: A.code }, ...(B ? [{ rid: B.roster_id, out: sw.to_staff_id, in: sw.from_staff_id, day: B.day, code: B.code }] : [])] };
  }
  private async afterSwap(res: { rosters: Roster[]; items: { rid: string; out: string; in: string; day: string; code: string }[] }) {
    for (const r of res.rosters) {
      const ch = res.items.filter((x) => x.rid === r.id).flatMap((x) => [{ staff_id: x.out, kind: 'remove', data: { day: x.day, code: x.code } }, { staff_id: x.in, kind: 'add', data: { day: x.day, code: x.code } }]);
      await this.roster.notifyChanged(r, ch);
    }
  }
  private async decidedNotes(trx: Ex, sw: { id: string; n: string; from_staff_id: string; to_staff_id: string; kind: string }, status: string, out: Note[], except: string, body?: string) {
    const users = await trx.selectFrom('staff_members').select('user_id').where('id', 'in', [sw.from_staff_id, sw.to_staff_id]).where('user_id', 'is not', null).execute();
    for (const x of users) if (x.user_id !== except) out.push({ user: x.user_id!, kind: 'swap_decided', title: `${sw.kind === 'swap' ? 'გაცვლა' : 'გადაცემა'} #${sw.n}: ${SW_KA[status]}`, body, entity: sw.id, link: '/roster?tab=my&sub=swaps' });
  }

  /** კოლეგის პასუხი: თანხმობა → ხელმძღვანელთან (swap_approval = head) ან პირდაპირ შესრულება; უარი */
  async peer(id: string, d: { accept: boolean; note?: string | null }, u: AuthUser, ctx: AuditContext) {
    const s = await this.settings();
    await this.expire();
    const notes: Note[] = [];
    const res = await this.db.transaction().execute(async (trx) => {
      const sw = await this.swap(trx, id, true);
      const me = await this.needMe(u, trx);
      if (sw.to_staff_id !== me.id) throw new ForbiddenException('შეთავაზება თქვენთვის არ არის');
      if (sw.status !== 'peer') throw new ConflictException({ code: 'SWAP_STATE', message: `გაცვლა ${SW_KA[sw.status]}ა` });
      if (!d.accept) {
        await trx.updateTable('roster_swaps').set({ status: 'declined', peer_at: sql`now()`, peer_note: d.note?.trim() || null }).where('id', '=', sw.id).execute();
        await this.decidedNotes(trx, sw, 'declined', notes, u.id, d.note?.trim() || undefined);
        await this.audit.log(ctx, { action: 'SWAP_PEER_DECLINE', entityName: 'roster_swaps', entityId: sw.id, newData: d }, trx);
        return { status: 'declined' as string, applied: null };
      }
      const { A, B } = await this.swapEntries(trx, sw);
      const sim = await this.simulate(trx, A, B, sw.from_staff_id, sw.to_staff_id);
      if (sim.errors.length) throw new ConflictException({ code: 'SWAP_RULE', message: sim.errors.join('; '), errors: sim.errors });
      await trx.updateTable('roster_swaps').set({ peer_at: sql`now()`, peer_note: d.note?.trim() || null, warnings: JSON.stringify(sim.warnings) }).where('id', '=', sw.id).execute();
      await this.audit.log(ctx, { action: 'SWAP_PEER_ACCEPT', entityName: 'roster_swaps', entityId: sw.id, newData: d }, trx);
      if (s.swap_approval === 'none') {
        const applied = await this.applySwap(trx, sw, A, B, u);
        await trx.updateTable('roster_swaps').set({ status: 'approved' }).where('id', '=', sw.id).execute();
        await this.decidedNotes(trx, sw, 'approved', notes, u.id);
        return { status: 'approved', applied };
      }
      await trx.updateTable('roster_swaps').set({ status: 'head' }).where('id', '=', sw.id).execute();
      const eds = new Set([...(await rosterEditors(trx, A.department_id)), ...(B && B.department_id !== A.department_id ? await rosterEditors(trx, B.department_id) : [])]);
      const names = await trx.selectFrom('staff_members as s').select(['s.id', staffName('s').as('n')]).where('s.id', 'in', [sw.from_staff_id, sw.to_staff_id]).execute();
      const nm = (x: string) => names.find((z) => z.id === x)?.n ?? '';
      for (const x of eds) if (x !== u.id && x !== (await this.userOf(trx, sw.from_staff_id))) notes.push({ user: x, kind: 'swap_to_approve', title: `${sw.kind === 'swap' ? 'გაცვლა' : 'გადაცემა'} — დასადასტურებელი: ${nm(sw.from_staff_id)} → ${nm(sw.to_staff_id)}`,
        item: `#${sw.n} ${ddmm(A.day)} ${A.code}${B ? ` ↔ ${ddmm(B.day)} ${B.code}` : ''}`, entity: sw.id, link: '/roster?tab=approvals', body: sim.warnings.length ? `⚠ ${sim.warnings.length} გაფრთხილება` : undefined });
      return { status: 'head', applied: null };
    }).catch((e) => mapPgError(e, PG));
    await this.send(notes);
    if (res.applied) await this.afterSwap(res.applied);
    return { status: res.status };
  }
  private async userOf(ex: Ex, staffId: string) { return (await ex.selectFrom('staff_members').select('user_id').where('id', '=', staffId).executeTakeFirst())?.user_id ?? null; }

  /** ხელმძღვანელი (განრიგის შემდგენი — ორივე განრიგის არე): ხელახალი შემოწმება; block → შეუძლებელია, warn → confirm_warnings */
  async head(id: string, d: { approve: boolean; note?: string | null; confirm_warnings?: boolean }, u: AuthUser, ctx: AuditContext) {
    await this.settings();
    await this.expire();
    const notes: Note[] = [];
    const res = await this.db.transaction().execute(async (trx) => {
      const sw = await this.swap(trx, id, true);
      if (sw.status !== 'head') throw new ConflictException({ code: 'SWAP_STATE', message: `გაცვლა ${SW_KA[sw.status]}ა` });
      const { A, B } = await this.swapEntries(trx, sw);
      if (!(await this.editorOf(trx, u, A, B))) throw new ForbiddenException('გაცვლის დადასტურება — განრიგის შემდგენი (ორივე განყოფილების)');
      const me = await this.me(u, trx);
      if (me && (me.id === sw.from_staff_id || me.id === sw.to_staff_id)) throw new ForbiddenException('საკუთარ გაცვლას ვერ დაადასტურებთ');
      if (!d.approve) {
        if ((d.note?.trim().length ?? 0) < 3) throw new BadRequestException('უარის მიზეზი სავალდებულოა');
        await trx.updateTable('roster_swaps').set({ status: 'rejected', head_by: u.id, head_at: sql`now()`, head_note: d.note!.trim(), reason: d.note!.trim() }).where('id', '=', sw.id).execute();
        await this.decidedNotes(trx, sw, 'rejected', notes, u.id, d.note!.trim());
        await this.audit.log(ctx, { action: 'SWAP_REJECT', entityName: 'roster_swaps', entityId: sw.id, newData: d }, trx);
        return null;
      }
      const sim = await this.simulate(trx, A, B, sw.from_staff_id, sw.to_staff_id);
      if (sim.errors.length) throw new ConflictException({ code: 'SWAP_RULE', message: sim.errors.join('; '), errors: sim.errors });
      if (sim.warnings.length && !d.confirm_warnings) throw new ConflictException({ code: 'SWAP_WARNINGS', message: `გაფრთხილება: ${sim.warnings.join('; ')} — დაადასტურეთ`, warnings: sim.warnings });
      const applied = await this.applySwap(trx, sw, A, B, u);
      await trx.updateTable('roster_swaps').set({ status: 'approved', head_by: u.id, head_at: sql`now()`, head_note: d.note?.trim() || null, warnings: JSON.stringify(sim.warnings) }).where('id', '=', sw.id).execute();
      await this.decidedNotes(trx, sw, 'approved', notes, u.id);
      await this.audit.log(ctx, { action: 'SWAP_APPROVE', entityName: 'roster_swaps', entityId: sw.id, newData: { ...d, warnings: sim.warnings } }, trx);
      return applied;
    }).catch((e) => mapPgError(e, PG));
    await this.send(notes);
    if (res) await this.afterSwap(res);
    return { status: res ? 'approved' : 'rejected' };
  }

  async cancelSwap(id: string, reason: string | null | undefined, u: AuthUser, ctx: AuditContext) {
    await this.settings();
    const notes: Note[] = [];
    await this.db.transaction().execute(async (trx) => {
      const sw = await this.swap(trx, id, true);
      const me = await this.needMe(u, trx);
      if (sw.from_staff_id !== me.id) throw new ForbiddenException('გაუქმება — ინიციატორი');
      if (sw.status !== 'peer' && sw.status !== 'head') throw new ConflictException({ code: 'SWAP_STATE', message: `გაცვლა ${SW_KA[sw.status]}ა` });
      await trx.updateTable('roster_swaps').set({ status: 'cancelled', reason: reason?.trim() || null }).where('id', '=', sw.id).execute();
      await this.decidedNotes(trx, sw, 'cancelled', notes, u.id, reason?.trim() || undefined);
      await this.audit.log(ctx, { action: 'SWAP_CANCEL', entityName: 'roster_swaps', entityId: sw.id, newData: { reason } }, trx);
    });
    await this.send(notes);
    return { ok: true };
  }

  private swapQ() {
    return this.db.selectFrom('roster_swaps as w').innerJoin('roster_entries as ea', 'ea.id', 'w.from_entry_id').leftJoin('roster_entries as eb', 'eb.id', 'w.to_entry_id')
      .innerJoin('rosters as ra', 'ra.id', 'ea.roster_id').leftJoin('rosters as rb', 'rb.id', 'eb.roster_id')
      .innerJoin('departments as da', 'da.id', 'ra.department_id').leftJoin('departments as db', 'db.id', 'rb.department_id')
      .innerJoin('shift_templates as ta', 'ta.id', 'ea.shift_template_id').leftJoin('shift_templates as tb', 'tb.id', 'eb.shift_template_id')
      .innerJoin('staff_members as sa', 'sa.id', 'w.from_staff_id').innerJoin('staff_members as sb', 'sb.id', 'w.to_staff_id')
      .select(['w.id', sql<string>`w.no::text`.as('no'), 'w.kind', 'w.status', 'w.note', 'w.warnings', 'w.expires_at', 'w.created_at', 'w.peer_at', 'w.peer_note', 'w.head_at', 'w.head_note', 'w.reason',
        'w.from_staff_id', 'w.to_staff_id', 'w.from_entry_id', 'w.to_entry_id', 'sa.user_id as from_user_id', 'sb.user_id as to_user_id',
        staffName('sa').as('a_staff_name'), staffName('sb').as('b_staff_name'),
        sql<string>`to_char(ea.day, 'YYYY-MM-DD')`.as('a_day'), 'ea.starts_at as a_starts_at', 'ea.ends_at as a_ends_at', 'ta.code as a_code', 'da.name as a_department', 'ra.department_id as a_department_id',
        sql<string | null>`to_char(eb.day, 'YYYY-MM-DD')`.as('b_day'), 'eb.starts_at as b_starts_at', 'eb.ends_at as b_ends_at', 'tb.code as b_code', 'db.name as b_department', 'rb.department_id as b_department_id']);
  }
  /** mine — ჩემი (შემომავალი / გამავალი); approve — ხელმძღვანელს: status = head, ჩემი განრიგის არე */
  async swaps(u: AuthUser, box: 'mine' | 'approve' = 'mine') {
    await this.settings();
    await this.expire();
    if (box === 'mine') {
      const me = await this.me(u);
      if (!me) return [];
      const rows = await this.swapQ().where((eb) => eb.or([eb('w.from_staff_id', '=', me.id), eb('w.to_staff_id', '=', me.id)])).orderBy('w.created_at', 'desc').limit(200).execute();
      return rows.map((r) => ({ ...r, direction: r.from_staff_id === me.id ? 'out' : 'in', status_name: SW_KA[r.status] }));
    }
    const sc = await rosterScope(this.db, u);
    const me = await this.me(u);
    const rows = await this.swapQ().where('w.status', '=', 'head').orderBy('w.expires_at').limit(300).execute();
    return rows.filter((r) => canEdit(sc, r.a_department_id) && (!r.b_department_id || canEdit(sc, r.b_department_id)) && (!me || (me.id !== r.from_staff_id && me.id !== r.to_staff_id)))
      .map((r) => ({ ...r, direction: 'approve', status_name: SW_KA[r.status] }));
  }
  /** გაცვლის / გადაცემის ფორმისთვის: ჩემი მომავალი ცვლები (გამოქვეყნებული) და იმავე განყოფილებ(ებ)ის იმავე კატეგორიის კოლეგები / მათი ცვლები */
  async swapOptions(u: AuthUser, entryId: string) {
    const s = await this.settings();
    const me = await this.needMe(u);
    const A = await this.ent(this.db, entryId);
    if (A.staff_id !== me.id) throw new ForbiddenException('მხოლოდ საკუთარი ცვლა');
    const from = A.day.slice(0, 7) + '-01';
    const colleagues = await this.db.selectFrom('staff_members as s').leftJoin('staff_positions as p', 'p.id', 's.position_id')
      .select(['s.id', staffName('s').as('name'), 'p.name as position_name']).where('s.is_active', '=', true).where('s.user_id', 'is not', null).where('s.id', '<>', me.id)
      .where(me.category ? (eb) => eb('p.category', '=', me.category!) : (eb) => eb('p.category', 'is', null))
      .where((eb) => eb.or([eb('s.department_id', '=', A.department_id), eb.exists(eb.selectFrom('staff_member_departments as x').select('x.staff_id').whereRef('x.staff_id', '=', 's.id').where('x.department_id', '=', A.department_id))]))
      .orderBy('s.last_name').execute();
    const shifts = colleagues.length ? await this.db.selectFrom('roster_entries as e').innerJoin('rosters as r', 'r.id', 'e.roster_id').innerJoin('shift_templates as t', 't.id', 'e.shift_template_id')
      .select(['e.id', 'e.staff_id', sql<string>`to_char(e.day, 'YYYY-MM-DD')`.as('day'), 't.code', 'e.starts_at', 'e.ends_at'])
      .where('e.staff_id', 'in', colleagues.map((c) => c.id)).where('e.status', '=', 'active').where('r.status', '=', 'published').where('r.department_id', '=', A.department_id)
      .where('e.starts_at', '>', new Date(Date.now() + s.swap_min_notice_hours * 36e5)).where('e.day', '>=', from).where('e.day', '<=', addDays(from, 62)).orderBy('e.starts_at').execute() : [];
    return { entry: { id: A.id, day: A.day, code: A.code }, colleagues, shifts, min_notice_hours: s.swap_min_notice_hours, approval: s.swap_approval };
  }

  // ================================================================ „არ შემიძლია“ / „მირჩევნია“ (H)
  private async prefsTarget(u: AuthUser, staffId: string | undefined, month: string, ex: Ex = this.db) {
    const s = await this.settings();
    const me = await this.me(u, ex);
    const sid = staffId ?? me?.id;
    if (!sid) throw new BadRequestException('თქვენი ანგარიში თანამშრომლების რეესტრში არ არის მიბმული');
    const st = await ex.selectFrom('staff_members as s').select(['s.id', staffName('s').as('name'), 's.department_id', 's.user_id']).where('s.id', '=', sid).executeTakeFirst();
    if (!st) throw new NotFoundException('თანამშრომელი ვერ მოიძებნა');
    const self = st.user_id === u.id;
    const planner = canEdit(await rosterScope(ex, u), st.department_id);
    if (!self && !planner) throw new ForbiddenException('ამ თანამშრომლის სურვილების ნახვის / ცვლის უფლება არ გაქვთ');
    const r = await ex.selectFrom('rosters').select(['status']).where('department_id', '=', st.department_id).where('month', '=', `${month}-01`).executeTakeFirst();
    const prev = addDays(`${month}-01`, -1).slice(0, 7);
    const deadline = s.prefs_deadline_day > 0 ? `${prev}-${String(s.prefs_deadline_day).padStart(2, '0')}` : null;
    const locked = !!r && r.status !== 'draft';
    const late = !planner && !!deadline && today() > deadline;
    return { st, self, planner, roster_status: r?.status ?? 'none', deadline, limit: s.unavailable_max_per_month, editable: !locked && !late, locked, late };
  }
  async prefs(u: AuthUser, month: string, staffId?: string) {
    const x = await this.prefsTarget(u, staffId, month);
    const days = monthDays(`${month}-01`);
    const items = await this.db.selectFrom('staff_prefs as p').leftJoin('shift_templates as t', 't.id', 'p.shift_template_id')
      .select([sql<string>`to_char(p.day, 'YYYY-MM-DD')`.as('day'), 'p.kind', 'p.part', 'p.shift_template_id', 't.code', 'p.note'])
      .where('p.staff_id', '=', x.st.id).where('p.day', '>=', days[0]).where('p.day', '<=', days[days.length - 1]).orderBy('p.day').execute();
    return { staff: { id: x.st.id, name: x.st.name }, month, items, roster_status: x.roster_status, deadline: x.deadline, limit: x.limit, editable: x.editable, planner: x.planner };
  }
  /** თვის სრული ჩანაცვლება. მხოლოდ სანამ განრიგი არ შექმნილა ან მონახაზშია; ვადა / ლიმიტი — თანამშრომლისთვის (შემდგენს — არა) */
  async savePrefs(u: AuthUser, d: PrefsDto, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const x = await this.prefsTarget(u, d.staff_id, d.month, trx);
      if (x.locked) throw new ConflictException({ code: 'PREFS_LOCKED', message: `${monthLabel(`${d.month}-01`)}: განრიგი უკვე გამოქვეყნებულია — სურვილები აღარ იცვლება (მიმართეთ შემდგენს)` });
      if (x.late) throw new ConflictException({ code: 'PREFS_DEADLINE', message: `სურვილების ვადა ამოიწურა (${x.deadline})` });
      const seen = new Set<string>();
      for (const it of d.items) {
        if (it.day.slice(0, 7) !== d.month) throw new BadRequestException(`${it.day} — თვე ${d.month} არ არის`);
        if (seen.has(`${it.day}|${it.kind}`)) throw new BadRequestException(`${it.day} — ორჯერ`);
        seen.add(`${it.day}|${it.kind}`);
        if (it.kind === 'unavailable' && it.shift_template_id) throw new BadRequestException('„არ შემიძლია“ — ცვლის გარეშე (დღე / ღამე)');
      }
      const n = d.items.filter((i) => i.kind === 'unavailable').length;
      if (!x.planner && x.limit > 0 && n > x.limit) throw new ConflictException({ code: 'PREFS_LIMIT', message: `„არ შემიძლია“ — თვეში მაქს. ${x.limit} დღე` });
      const days = monthDays(`${d.month}-01`);
      await trx.deleteFrom('staff_prefs').where('staff_id', '=', x.st.id).where('day', '>=', days[0]).where('day', '<=', days[days.length - 1]).execute();
      if (d.items.length) await trx.insertInto('staff_prefs').values(d.items.map((i) => ({ staff_id: x.st.id, day: i.day, kind: i.kind, part: i.kind === 'unavailable' ? i.part ?? 'all' : 'all',
        shift_template_id: i.kind === 'prefer' ? i.shift_template_id ?? null : null, note: i.note?.trim() || null, created_by: u.id }))).execute();
      if (!x.self) await this.audit.log(ctx, { action: 'SAVE_STAFF_PREFS', entityName: 'staff_members', entityId: x.st.id, newData: d }, trx);
      return { ok: true, unavailable: n, prefer: d.items.length - n };
    }).catch((e) => mapPgError(e, { staff_prefs_staff_id_day_kind_key: 'ერთ დღეზე ერთი ჩანაწერი (თითო სახე)' }));
  }

  // ================================================================ „დასადასტურებელი“ (I) — ხელმძღვანელი / HR / შემდგენი
  async inbox(u: AuthUser) {
    await this.settings();
    const sc = await rosterScope(this.db, u);
    const [absences, swaps, mine] = await Promise.all([this.absence.list(u, { scope: 'approve' }), this.swaps(u, 'approve'), this.swaps(u, 'mine')]);
    const depts = sc.editAll ? null : sc.edit;
    const offers = depts && !depts.length ? [] : await this.openQ(this.db)
      .select(sql<{ staff_id: string; name: string; note: string | null }[]>`(SELECT json_agg(json_build_object('staff_id', f.staff_id, 'name', s.last_name || ' ' || s.first_name, 'note', f.note) ORDER BY f.created_at)
        FROM roster_open_shift_offers f JOIN staff_members s ON s.id = f.staff_id WHERE f.open_shift_id = o.id AND f.status = 'offered')`.as('offers'))
      .where('o.status', '=', 'open').where('o.starts_at', '>', new Date())
      .where((eb) => eb.exists(eb.selectFrom('roster_open_shift_offers as f').select('f.staff_id').whereRef('f.open_shift_id', '=', 'o.id').where('f.status', '=', 'offered')))
      .$if(!!depts, (q) => q.where('r.department_id', 'in', depts!)).orderBy('o.starts_at').limit(200).execute();
    const peer = mine.filter((x) => x.direction === 'in' && x.status === 'peer');
    return { absences, swaps, offers, peer, counts: { absences: absences.length, swaps: swaps.length, offers: offers.length, peer: peer.length, total: absences.length + swaps.length + offers.length + peer.length } };
  }
}

// ======================================================================= DTO
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
class OpenDto {
  @Matches(DAY) day: string; @IsUUID() shift_template_id: string; @IsOptional() @Matches(HHMM) start_time?: string | null; @IsOptional() @Matches(HHMM) end_time?: string | null;
  @IsOptional() @IsUUID() duty_role_id?: string | null; @IsOptional() @IsIn([1, 2]) duty_level?: number | null;
  @IsOptional() @IsIn(['doctor', 'nurse', 'junior', 'tech', 'admin', 'other']) category?: string | null; @IsOptional() @IsString() @MaxLength(500) note?: string | null;
}
class NoteDto { @IsOptional() @IsString() @MaxLength(500) note?: string | null }
class AssignDto { @IsUUID() staff_id: string; @IsOptional() @IsString() @MaxLength(500) reason?: string | null }
class ReasonDto { @IsString() @Length(3, 500) reason: string }
class OptReasonDto { @IsOptional() @IsString() @MaxLength(500) reason?: string | null }
class SwapDto {
  @IsIn(['swap', 'give']) kind: 'swap' | 'give'; @IsUUID() from_entry_id: string; @IsOptional() @IsUUID() to_entry_id?: string; @IsOptional() @IsUUID() to_staff_id?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string | null;
}
class PeerDto { @IsBoolean() accept: boolean; @IsOptional() @IsString() @MaxLength(500) note?: string | null }
class HeadDto { @IsBoolean() approve: boolean; @IsOptional() @IsString() @MaxLength(500) note?: string | null; @IsOptional() @IsBoolean() confirm_warnings?: boolean }
class PrefItem {
  @Matches(DAY) day: string; @IsIn(['unavailable', 'prefer']) kind: 'unavailable' | 'prefer'; @IsOptional() @IsIn(['all', 'day', 'night']) part?: 'all' | 'day' | 'night';
  @IsOptional() @IsUUID() shift_template_id?: string | null; @IsOptional() @IsString() @MaxLength(300) note?: string | null;
}
class PrefsDto {
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/) month: string; @IsOptional() @IsUUID() staff_id?: string;
  @IsArray() @ArrayMaxSize(62) @ValidateNested({ each: true }) @Type(() => PrefItem) items: PrefItem[];
}
const uuidOk = (v?: string) => !v || /^[0-9a-f-]{36}$/i.test(v);

/** ცვლები / მორიგეობა — დასაფარი, გაცვლა, სურვილები, „დასადასტურებელი“ (0078). უფლებები — სერვისში */
@Controller('roster')
export class RosterFlowsController {
  constructor(private readonly s: RosterFlowsService) {}
  @Get('open-shifts') open(@CurrentUser() u: AuthUser, @Query('roster_id') rosterId?: string, @Query('mine') mine?: string) {
    if (!uuidOk(rosterId)) throw new BadRequestException('არასწორი id');
    return this.s.openShifts(u, { roster_id: rosterId, mine });
  }
  @Post('rosters/:id/open-shifts') openC(@Param('id', ParseUUIDPipe) id: string, @Body() d: OpenDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.createOpen(id, d, u, auditCtx(r)); }
  @Post('open-shifts/:id/offer') @HttpCode(200) offer(@Param('id', ParseUUIDPipe) id: string, @Body() d: NoteDto, @CurrentUser() u: AuthUser) { return this.s.offer(id, d.note, u); }
  @Post('open-shifts/:id/withdraw') @HttpCode(200) withdraw(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser) { return this.s.withdraw(id, u); }
  @Post('open-shifts/:id/assign') @HttpCode(200) assign(@Param('id', ParseUUIDPipe) id: string, @Body() d: AssignDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.assign(id, d, u, auditCtx(r)); }
  @Post('open-shifts/:id/cancel') @HttpCode(200) cancelOpen(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.cancelOpen(id, d.reason, u, auditCtx(r)); }

  @Get('swaps') swaps(@CurrentUser() u: AuthUser, @Query('box') box?: string) {
    if (box && box !== 'mine' && box !== 'approve') throw new BadRequestException('box');
    return this.s.swaps(u, (box as 'mine' | 'approve') ?? 'mine');
  }
  @Get('swaps/options') options(@CurrentUser() u: AuthUser, @Query('entry_id') entryId: string) {
    if (!entryId || !uuidOk(entryId)) throw new BadRequestException('entry_id');
    return this.s.swapOptions(u, entryId);
  }
  @Post('swaps') swapC(@Body() d: SwapDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.createSwap(d, u, auditCtx(r)); }
  @Post('swaps/:id/peer') @HttpCode(200) peer(@Param('id', ParseUUIDPipe) id: string, @Body() d: PeerDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.peer(id, d, u, auditCtx(r)); }
  @Post('swaps/:id/decide') @HttpCode(200) decide(@Param('id', ParseUUIDPipe) id: string, @Body() d: HeadDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.head(id, d, u, auditCtx(r)); }
  @Post('swaps/:id/cancel') @HttpCode(200) cancelSwap(@Param('id', ParseUUIDPipe) id: string, @Body() d: OptReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.cancelSwap(id, d.reason, u, auditCtx(r)); }

  @Get('prefs') prefs(@CurrentUser() u: AuthUser, @Query('month') month: string, @Query('staff_id') staffId?: string) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month ?? '')) throw new BadRequestException('month — YYYY-MM');
    if (!uuidOk(staffId)) throw new BadRequestException('არასწორი id');
    return this.s.prefs(u, month, staffId);
  }
  @Put('prefs') savePrefs(@Body() d: PrefsDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.savePrefs(u, d, auditCtx(r)); }
  @Get('inbox') inbox(@CurrentUser() u: AuthUser) { return this.s.inbox(u); }
}
