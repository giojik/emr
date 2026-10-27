import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsISO8601, IsNumber, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min } from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser } from '../auth/roles';
import { mapPgError } from '../common/pg-errors';
import { InjectDb, type Database } from '../database/database.module';
import { ModulesService } from '../modules/modules';
import {
  CATEGORIES, CATEGORY_KA, EMPLOYMENT, REST, ROSTER_HR, ROSTER_SETUP, SHIFT_KINDS, STAFF_ALL, absenceScope, canEdit, canView, rosterScope, shiftTimes, staffName,
  type RosterSettings,
} from './roster-common';

const PG = {
  staff_positions_code_key: 'იგივე კოდის პოზიცია უკვე არსებობს', shift_templates_code_key: 'იგივე კოდის ცვლა უკვე არსებობს', duty_roles_code_key: 'იგივე კოდის მორიგის როლი უკვე არსებობს',
  rotation_patterns_code_key: 'იგივე კოდის ნიმუში უკვე არსებობს', staff_members_user_id_key: 'ეს მომხმარებელი სხვა თანამშრომელს უკვე მიებმა',
  staff_members_personal_number_key: 'ამ პირადი ნომრით თანამშრომელი უკვე რეესტრშია', public_holidays_pkey: 'ეს დღე უკვე დღესასწაულია',
};
const t = (v: string | null | undefined) => (typeof v === 'string' ? (v.trim() || null) : v);

/** ცნობარები და თანამშრომლები (0077) */
@Injectable()
export class RosterSetupService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService, private readonly modules: ModulesService) {}
  settings() { return this.modules.require<RosterSettings>('roster'); }

  // ---------------------------------------------------------------- ცნობარები ერთად (ეკრანისთვის)
  async refs(u: AuthUser) {
    const settings = await this.settings();
    const sc = await rosterScope(this.db, u);
    const as = await absenceScope(this.db, u);
    const [positions, templates, duty_roles, patterns, departments, absence_types, me] = await Promise.all([
      this.db.selectFrom('staff_positions as p').selectAll('p').select(sql<number>`(SELECT count(*)::int FROM staff_members s WHERE s.position_id = p.id AND s.is_active)`.as('staff'))
        .orderBy('p.sort_order').orderBy('p.name').execute(),
      this.db.selectFrom('shift_templates').selectAll().orderBy('sort_order').orderBy('code').execute(),
      this.db.selectFrom('duty_roles as r').leftJoin('departments as d', 'd.id', 'r.department_id').selectAll('r').select('d.name as department_name').orderBy('r.sort_order').orderBy('r.name').execute(),
      this.db.selectFrom('rotation_patterns').selectAll().orderBy('code').execute(),
      this.db.selectFrom('departments').select(['id', 'name', 'code', 'type']).where('is_active', '=', true).orderBy('name').execute(),
      this.db.selectFrom('absence_types').selectAll().orderBy('sort_order').orderBy('name').execute(),
      this.db.selectFrom('staff_members as s').leftJoin('staff_positions as p', 'p.id', 's.position_id').select(['s.id', staffName('s').as('name'), 's.department_id', 'p.category'])
        .where('s.user_id', '=', u.id).executeTakeFirst(),
    ]);
    return {
      settings, positions, patterns, duty_roles,
      templates: templates.map((x) => ({ ...x, hours: shiftTimes('2026-01-15', x.start_time, x.end_time, x.break_min, x.counted_hours === null ? null : Number(x.counted_hours)).hours })),
      departments: departments.map((d) => ({ ...d, can_edit: canEdit(sc, d.id), can_view: canView(sc, d.id) })),
      categories: CATEGORIES.map((c) => ({ code: c, name: CATEGORY_KA[c] })), kinds: SHIFT_KINDS, employment: EMPLOYMENT, rest: REST,
      absence_types, me: me ?? null,
      can: { setup: has(u, ...ROSTER_SETUP), hr: has(u, ...ROSTER_HR), staff_all: has(u, ...STAFF_ALL), edit_all: sc.editAll, view_all: sc.viewAll, edit_depts: sc.edit,
        // 0078: არყოფნის დადასტურება (ხელმძღვანელი — განყოფილებები / მთელი კლინიკა; HR ნაბიჯი)
        absence_all: as.all, absence_hr: as.hr, absence_depts: as.depts },
    };
  }

  // ---------------------------------------------------------------- პოზიციები
  async savePosition(id: string | null, d: PositionDto, ctx: AuditContext) {
    await this.settings();
    const v = { ...(d.name !== undefined && { name: d.name.trim() }), ...(d.category !== undefined && { category: d.category }), ...(d.is_active !== undefined && { is_active: d.is_active }),
      ...(d.sort_order !== undefined && { sort_order: d.sort_order }) };
    try {
      const r = id ? await this.db.updateTable('staff_positions').set(v).where('id', '=', id).returningAll().executeTakeFirst()
        : await this.db.insertInto('staff_positions').values({ code: d.code!, name: d.name!.trim(), category: d.category!, ...v }).returningAll().executeTakeFirst();
      if (!r) throw new NotFoundException('პოზიცია ვერ მოიძებნა');
      await this.audit.log(ctx, { action: id ? 'UPDATE_STAFF_POSITION' : 'CREATE_STAFF_POSITION', entityName: 'staff_positions', entityId: r.id, newData: d });
      return r;
    } catch (e) { mapPgError(e, PG); }
  }

  // ---------------------------------------------------------------- ცვლის შაბლონები
  private async checkDepts(ids: string[] | undefined) {
    if (!ids?.length) return;
    const n = (await this.db.selectFrom('departments').select(sql<number>`count(*)::int`.as('n')).where('id', 'in', ids).executeTakeFirstOrThrow()).n;
    if (n !== new Set(ids).size) throw new BadRequestException('განყოფილება ვერ მოიძებნა');
  }
  async saveTemplate(id: string | null, d: TemplateDto, ctx: AuditContext) {
    await this.settings();
    await this.checkDepts(d.department_ids);
    const v = {
      ...(d.name !== undefined && { name: d.name.trim() }), ...(d.kind !== undefined && { kind: d.kind }), ...(d.start_time !== undefined && { start_time: d.start_time }),
      ...(d.end_time !== undefined && { end_time: d.end_time }), ...(d.break_min !== undefined && { break_min: d.break_min }),
      ...(d.counted_hours !== undefined && { counted_hours: d.counted_hours === null ? null : String(d.counted_hours) }), ...(d.color !== undefined && { color: d.color }),
      ...(d.department_ids !== undefined && { department_ids: [...new Set(d.department_ids)] }), ...(d.categories !== undefined && { categories: [...new Set(d.categories)] }),
      ...(d.is_active !== undefined && { is_active: d.is_active }), ...(d.sort_order !== undefined && { sort_order: d.sort_order }),
    };
    const old = id ? await this.db.selectFrom('shift_templates').select(['start_time', 'end_time', 'break_min']).where('id', '=', id).executeTakeFirst() : null;
    if (id && !old) throw new NotFoundException('ცვლა ვერ მოიძებნა');
    const st = d.start_time ?? old!.start_time, en = d.end_time ?? old!.end_time, br = d.break_min ?? old?.break_min ?? 0;
    const chk = shiftTimes('2026-01-15', st, en, 0, null);
    if ((chk.ends - chk.starts) / 6e4 <= br) throw new BadRequestException('შესვენება ცვლის ხანგრძლივობაზე მეტია');
    try {
      const r = id ? await this.db.updateTable('shift_templates').set(v).where('id', '=', id).returningAll().executeTakeFirst()
        : await this.db.insertInto('shift_templates').values({ code: d.code!, name: d.name!.trim(), kind: d.kind!, start_time: d.start_time!, end_time: d.end_time!, ...v }).returningAll().executeTakeFirst();
      if (!r) throw new NotFoundException('ცვლა ვერ მოიძებნა');
      const h = shiftTimes('2026-01-15', r.start_time, r.end_time, r.break_min, r.counted_hours === null ? null : Number(r.counted_hours));
      await this.audit.log(ctx, { action: id ? 'UPDATE_SHIFT_TEMPLATE' : 'CREATE_SHIFT_TEMPLATE', entityName: 'shift_templates', entityId: r.id, newData: d });
      return { ...r, hours: h.hours };
    } catch (e) { mapPgError(e, PG); }
  }

  // ---------------------------------------------------------------- დღესასწაულები
  async holidays(year?: string) {
    await this.settings();
    let q = this.db.selectFrom('public_holidays').select(['day', 'name']).orderBy('day');
    if (year) q = q.where(sql`extract(year FROM day)`, '=', Number(year));
    return q.execute();
  }
  async addHoliday(d: HolidayDto, u: AuthUser, ctx: AuditContext) {
    await this.settings();
    try {
      const r = await this.db.insertInto('public_holidays').values({ day: d.day, name: d.name.trim(), created_by: u.id }).returning(['day', 'name']).executeTakeFirstOrThrow();
      await this.audit.log(ctx, { action: 'CREATE_HOLIDAY', entityName: 'public_holidays', entityId: d.day, newData: d });
      return r;
    } catch (e) { mapPgError(e, PG); }
  }
  async removeHoliday(day: string, ctx: AuditContext) {
    await this.settings();
    const r = await this.db.deleteFrom('public_holidays').where('day', '=', day).returning(['day', 'name']).executeTakeFirst();
    if (!r) throw new NotFoundException('დღესასწაული ვერ მოიძებნა');
    await this.audit.log(ctx, { action: 'DELETE_HOLIDAY', entityName: 'public_holidays', entityId: day, oldData: r });
    return { ok: true };
  }

  // ---------------------------------------------------------------- მორიგის როლები
  async saveDutyRole(id: string | null, d: DutyRoleDto, ctx: AuditContext) {
    await this.settings();
    if (d.department_id) await this.checkDepts([d.department_id]);
    const v = {
      ...(d.name !== undefined && { name: d.name.trim() }), ...(d.department_id !== undefined && { department_id: d.department_id }),
      ...(d.categories !== undefined && { categories: [...new Set(d.categories)] }), ...(d.required_count !== undefined && { required_count: d.required_count }),
      ...(d.has_backup !== undefined && { has_backup: d.has_backup }), ...(d.phone !== undefined && { phone: t(d.phone) }),
      ...(d.is_active !== undefined && { is_active: d.is_active }), ...(d.sort_order !== undefined && { sort_order: d.sort_order }),
    };
    try {
      const r = id ? await this.db.updateTable('duty_roles').set(v).where('id', '=', id).returningAll().executeTakeFirst()
        : await this.db.insertInto('duty_roles').values({ code: d.code!, name: d.name!.trim(), ...v }).returningAll().executeTakeFirst();
      if (!r) throw new NotFoundException('მორიგის როლი ვერ მოიძებნა');
      await this.audit.log(ctx, { action: id ? 'UPDATE_DUTY_ROLE' : 'CREATE_DUTY_ROLE', entityName: 'duty_roles', entityId: r.id, newData: d });
      return r;
    } catch (e) { mapPgError(e, PG); }
  }

  // ---------------------------------------------------------------- როტაციის ნიმუშები
  async savePattern(id: string | null, d: PatternDto, ctx: AuditContext) {
    await this.settings();
    if (d.cycle) {
      const ids = [...new Set(d.cycle.filter((x) => x !== REST))];
      if (!ids.length) throw new BadRequestException('ციკლში მინიმუმ ერთი ცვლა უნდა იყოს');
      const n = (await this.db.selectFrom('shift_templates').select(sql<number>`count(*)::int`.as('n')).where('id', 'in', ids).executeTakeFirstOrThrow()).n;
      if (n !== ids.length) throw new BadRequestException('ციკლის ცვლა ვერ მოიძებნა');
    }
    const v = { ...(d.name !== undefined && { name: d.name.trim() }), ...(d.cycle !== undefined && { cycle: d.cycle }), ...(d.is_active !== undefined && { is_active: d.is_active }) };
    try {
      const r = id ? await this.db.updateTable('rotation_patterns').set(v).where('id', '=', id).returningAll().executeTakeFirst()
        : await this.db.insertInto('rotation_patterns').values({ code: d.code!, name: d.name!.trim(), cycle: d.cycle! }).returningAll().executeTakeFirst();
      if (!r) throw new NotFoundException('ნიმუში ვერ მოიძებნა');
      await this.audit.log(ctx, { action: id ? 'UPDATE_ROTATION' : 'CREATE_ROTATION', entityName: 'rotation_patterns', entityId: r.id, newData: d });
      return r;
    } catch (e) { mapPgError(e, PG); }
  }

  // ---------------------------------------------------------------- შევსების ნორმა (განყოფილების შემდგენიც)
  async norms(departmentId: string, u: AuthUser) {
    await this.settings();
    const sc = await rosterScope(this.db, u);
    if (!canView(sc, departmentId)) throw new ForbiddenException('განყოფილება თქვენს არეში არ არის');
    return this.db.selectFrom('staffing_norms as n').innerJoin('shift_templates as t', 't.id', 'n.shift_template_id')
      .select(['n.id', 'n.department_id', 'n.shift_template_id', 't.code as shift_code', 't.name as shift_name', 'n.category', 'n.min_count', 'n.weekdays', 'n.holidays', 'n.is_active'])
      .where('n.department_id', '=', departmentId).orderBy('t.sort_order').orderBy('n.category').execute();
  }
  async saveNorm(id: string | null, d: NormDto, u: AuthUser, ctx: AuditContext) {
    await this.settings();
    const old = id ? await this.db.selectFrom('staffing_norms').selectAll().where('id', '=', id).executeTakeFirst() : null;
    if (id && !old) throw new NotFoundException('ნორმა ვერ მოიძებნა');
    const dept = old?.department_id ?? d.department_id;
    if (!dept) throw new BadRequestException('განყოფილება სავალდებულოა');
    const sc = await rosterScope(this.db, u);
    if (!canEdit(sc, dept)) throw new ForbiddenException('ამ განყოფილების ნორმის ცვლილების უფლება არ გაქვთ');
    if (d.shift_template_id && !(await this.db.selectFrom('shift_templates').select('id').where('id', '=', d.shift_template_id).executeTakeFirst())) throw new BadRequestException('ცვლა ვერ მოიძებნა');
    const v = { ...(d.shift_template_id !== undefined && { shift_template_id: d.shift_template_id }), ...(d.category !== undefined && { category: d.category }),
      ...(d.min_count !== undefined && { min_count: d.min_count }), ...(d.weekdays !== undefined && { weekdays: [...new Set(d.weekdays)].sort() }),
      ...(d.holidays !== undefined && { holidays: d.holidays }), ...(d.is_active !== undefined && { is_active: d.is_active }) };
    const r = id ? await this.db.updateTable('staffing_norms').set(v).where('id', '=', id).returningAll().executeTakeFirstOrThrow()
      : await this.db.insertInto('staffing_norms').values({ department_id: dept, shift_template_id: d.shift_template_id!, category: d.category!, min_count: d.min_count!, created_by: u.id, ...v })
        .returningAll().executeTakeFirstOrThrow();
    await this.audit.log(ctx, { action: id ? 'UPDATE_STAFFING_NORM' : 'CREATE_STAFFING_NORM', entityName: 'staffing_norms', entityId: r.id, newData: d });
    return r;
  }

  // ---------------------------------------------------------------- თანამშრომლები
  /** რეესტრის ნახვა: HR / roster_all — ყველა; roster — თავისი განყოფილებ(ებ)ის (ძირითადი ან დამატებითი); roster_view / manager — ყველა (ნახვა) */
  async staff(u: AuthUser, q: StaffQ) {
    await this.settings();
    const sc = await rosterScope(this.db, u);
    let x = this.db.selectFrom('staff_members as s').innerJoin('departments as d', 'd.id', 's.department_id').leftJoin('staff_positions as p', 'p.id', 's.position_id')
      .leftJoin('users as u', 'u.id', 's.user_id')
      .select(['s.id', 's.user_id', 's.first_name', 's.last_name', staffName('s').as('name'), 's.personal_number', 's.phone', 's.position_id', 'p.name as position_name', 'p.category',
        's.department_id', 'd.name as department_name', 's.fte', 's.employment', 's.hired_on', 's.left_on', 's.is_active', 's.notes', 'u.email as user_email', 'u.is_active as user_active',
        sql<string[]>`coalesce((SELECT array_agg(x.department_id) FROM staff_member_departments x WHERE x.staff_id = s.id), '{}')`.as('extra_department_ids')])
      .orderBy('s.last_name').orderBy('s.first_name').limit(3000);
    if (!sc.viewAll) {
      if (!sc.edit.length) throw new ForbiddenException('თანამშრომლების რეესტრზე წვდომა არ გაქვთ');
      x = x.where((eb) => eb.or([eb('s.department_id', 'in', sc.edit), eb.exists(eb.selectFrom('staff_member_departments as m').select('m.staff_id').whereRef('m.staff_id', '=', 's.id').where('m.department_id', 'in', sc.edit))]));
    }
    if (q.department_id) x = x.where((eb) => eb.or([eb('s.department_id', '=', q.department_id!),
      eb.exists(eb.selectFrom('staff_member_departments as m').select('m.staff_id').whereRef('m.staff_id', '=', 's.id').where('m.department_id', '=', q.department_id!))]));
    if (q.active !== 'all') x = x.where('s.is_active', '=', q.active !== '0');
    if (q.category) x = x.where('p.category', '=', q.category);
    if (q.position_id) x = x.where('s.position_id', '=', q.position_id);
    if (q.no_user === '1') x = x.where('s.user_id', 'is', null);
    const s = q.search?.trim().toLowerCase();
    if (s) x = x.where(sql`lower(s.first_name || ' ' || s.last_name || ' ' || coalesce(s.personal_number, ''))`, 'like', `%${s}%`);
    return x.execute();
  }

  private async canManageStaff(u: AuthUser, dept: string) {
    if (has(u, ...STAFF_ALL)) return;
    const sc = await rosterScope(this.db, u);
    if (!canEdit(sc, dept)) throw new ForbiddenException('ამ განყოფილების თანამშრომლების მართვის უფლება არ გაქვთ');
  }
  async saveStaff(id: string | null, d: StaffDto, u: AuthUser, ctx: AuditContext) {
    await this.settings();
    const old = id ? await this.db.selectFrom('staff_members').selectAll().where('id', '=', id).executeTakeFirst() : null;
    if (id && !old) throw new NotFoundException('თანამშრომელი ვერ მოიძებნა');
    if (old) await this.canManageStaff(u, old.department_id);
    const dept = d.department_id ?? old?.department_id;
    if (!dept) throw new BadRequestException('ძირითადი განყოფილება სავალდებულოა');
    await this.canManageStaff(u, dept);
    await this.checkDepts([dept, ...(d.extra_department_ids ?? [])]);
    let first = d.first_name, last = d.last_name;
    if (d.user_id) {
      const usr = await this.db.selectFrom('users').select(['first_name', 'last_name']).where('id', '=', d.user_id).executeTakeFirst();
      if (!usr) throw new BadRequestException('მომხმარებელი ვერ მოიძებნა');
      if (!id) { first ??= usr.first_name; last ??= usr.last_name; }
    }
    if (!id && (!first?.trim() || !last?.trim())) throw new BadRequestException('სახელი და გვარი სავალდებულოა');
    if (d.position_id && !(await this.db.selectFrom('staff_positions').select('id').where('id', '=', d.position_id).where('is_active', '=', true).executeTakeFirst())) throw new BadRequestException('პოზიცია ვერ მოიძებნა ან გათიშულია');
    const v = {
      ...(d.user_id !== undefined && { user_id: d.user_id }), ...(first !== undefined && { first_name: first.trim() }), ...(last !== undefined && { last_name: last.trim() }),
      ...(d.personal_number !== undefined && { personal_number: t(d.personal_number) }), ...(d.phone !== undefined && { phone: t(d.phone) }),
      ...(d.position_id !== undefined && { position_id: d.position_id }), ...(d.department_id !== undefined && { department_id: d.department_id }),
      ...(d.fte !== undefined && { fte: String(d.fte) }), ...(d.employment !== undefined && { employment: d.employment }), ...(d.hired_on !== undefined && { hired_on: d.hired_on }),
      ...(d.left_on !== undefined && { left_on: d.left_on }), ...(d.is_active !== undefined && { is_active: d.is_active }), ...(d.notes !== undefined && { notes: t(d.notes) }),
    };
    try {
      return await this.db.transaction().execute(async (trx) => {
        const r = id ? await trx.updateTable('staff_members').set(v).where('id', '=', id).returningAll().executeTakeFirstOrThrow()
          : await trx.insertInto('staff_members').values({ first_name: first!.trim(), last_name: last!.trim(), department_id: dept, created_by: u.id, ...v }).returningAll().executeTakeFirstOrThrow();
        if (d.extra_department_ids !== undefined) {
          await trx.deleteFrom('staff_member_departments').where('staff_id', '=', r.id).execute();
          const extra = [...new Set(d.extra_department_ids)].filter((x) => x !== r.department_id);
          if (extra.length) await trx.insertInto('staff_member_departments').values(extra.map((x) => ({ staff_id: r.id, department_id: x }))).execute();
        }
        await this.audit.log(ctx, { action: id ? 'UPDATE_STAFF_MEMBER' : 'CREATE_STAFF_MEMBER', entityName: 'staff_members', entityId: r.id, oldData: old ?? undefined, newData: d }, trx);
        return r;
      });
    } catch (e) { mapPgError(e, PG); }
  }

  /** ანგარიშიანი თანამშრომლები, რომლებიც ჯერ რეესტრში არ არის (მასობრივი დამატებისთვის) */
  async usersWithout(u: AuthUser, search?: string, departmentId?: string) {
    await this.settings();
    const sc = await rosterScope(this.db, u);
    if (!has(u, ...STAFF_ALL) && !sc.edit.length) throw new ForbiddenException('თანამშრომლების დამატების უფლება არ გაქვთ');
    let x = this.db.selectFrom('users as u').leftJoin('departments as d', 'd.id', 'u.department_id')
      .select(['u.id', 'u.first_name', 'u.last_name', sql<string>`u.last_name || ' ' || u.first_name`.as('name'), 'u.email', 'u.department_id', 'd.name as department_name', 'u.specialty', 'u.phone'])
      .where('u.is_active', '=', true).where((eb) => eb.not(eb.exists(eb.selectFrom('staff_members as s').select('s.id').whereRef('s.user_id', '=', 'u.id'))))
      .orderBy('u.last_name').limit(500);
    if (departmentId) x = x.where('u.department_id', '=', departmentId);
    const s = search?.trim().toLowerCase();
    if (s) x = x.where(sql`lower(u.first_name || ' ' || u.last_name || ' ' || u.email)`, 'like', `%${s}%`);
    return x.execute();
  }
  async fromUsers(d: FromUsersDto, u: AuthUser, ctx: AuditContext) {
    await this.settings();
    if (d.position_id && !(await this.db.selectFrom('staff_positions').select('id').where('id', '=', d.position_id).where('is_active', '=', true).executeTakeFirst())) throw new BadRequestException('პოზიცია ვერ მოიძებნა ან გათიშულია');
    const users = await this.db.selectFrom('users').select(['id', 'first_name', 'last_name', 'department_id', 'phone']).where('id', 'in', d.user_ids).where('is_active', '=', true).execute();
    const created: string[] = []; const skipped: { user_id: string; message: string }[] = [];
    await this.db.transaction().execute(async (trx) => {
      for (const id of d.user_ids) {
        const usr = users.find((x) => x.id === id);
        if (!usr) { skipped.push({ user_id: id, message: 'მომხმარებელი ვერ მოიძებნა ან გათიშულია' }); continue; }
        const dept = d.department_id ?? usr.department_id;
        if (!dept) { skipped.push({ user_id: id, message: 'განყოფილება არ აქვს — მიუთითეთ' }); continue; }
        try { await this.canManageStaff(u, dept); } catch { skipped.push({ user_id: id, message: 'განყოფილება თქვენს არეში არ არის' }); continue; }
        const r = await trx.insertInto('staff_members').values({ user_id: id, first_name: usr.first_name, last_name: usr.last_name, phone: usr.phone, department_id: dept,
          position_id: d.position_id ?? null, created_by: u.id }).onConflict((oc) => oc.column('user_id').doNothing()).returning('id').executeTakeFirst();
        if (r) created.push(r.id); else skipped.push({ user_id: id, message: 'უკვე რეესტრშია' });
      }
      await this.audit.log(ctx, { action: 'CREATE_STAFF_FROM_USERS', entityName: 'staff_members', entityId: '-', newData: { ...d, created: created.length } }, trx);
    });
    return { created: created.length, ids: created, skipped };
  }
}

// ======================================================================= DTO
const CAT = CATEGORIES as readonly string[];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
class PositionDto {
  @IsOptional() @Matches(/^[A-Z][A-Z0-9_]{1,29}$/) code?: string; @IsOptional() @IsString() @Length(2, 200) name?: string; @IsOptional() @IsIn(CAT) category?: string;
  @IsOptional() @IsBoolean() is_active?: boolean; @IsOptional() @IsInt() sort_order?: number;
}
class TemplateDto {
  @IsOptional() @Matches(/^[A-Z0-9][A-Z0-9_]{0,5}$/) code?: string; @IsOptional() @IsString() @Length(2, 200) name?: string; @IsOptional() @IsIn(SHIFT_KINDS) kind?: string;
  @IsOptional() @Matches(HHMM) start_time?: string; @IsOptional() @Matches(HHMM) end_time?: string; @IsOptional() @IsInt() @Min(0) @Max(240) break_min?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(24) counted_hours?: number | null; @IsOptional() @Matches(/^#[0-9a-fA-F]{6}$/) color?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsUUID('all', { each: true }) department_ids?: string[]; @IsOptional() @IsArray() @IsIn(CAT, { each: true }) categories?: string[];
  @IsOptional() @IsBoolean() is_active?: boolean; @IsOptional() @IsInt() sort_order?: number;
}
class HolidayDto { @IsISO8601({ strict: true }) @Matches(/^\d{4}-\d{2}-\d{2}$/) day: string; @IsString() @Length(2, 200) name: string }
class DutyRoleDto {
  @IsOptional() @Matches(/^[A-Z][A-Z0-9_]{1,29}$/) code?: string; @IsOptional() @IsString() @Length(2, 200) name?: string; @IsOptional() @IsUUID() department_id?: string | null;
  @IsOptional() @IsArray() @IsIn(CAT, { each: true }) categories?: string[]; @IsOptional() @IsInt() @Min(0) @Max(20) required_count?: number;
  @IsOptional() @IsBoolean() has_backup?: boolean; @IsOptional() @IsString() @MaxLength(50) phone?: string | null; @IsOptional() @IsBoolean() is_active?: boolean; @IsOptional() @IsInt() sort_order?: number;
}
class PatternDto {
  @IsOptional() @Matches(/^[A-Z0-9][A-Z0-9_]{1,29}$/) code?: string; @IsOptional() @IsString() @Length(2, 200) name?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(56) @IsUUID('all', { each: true }) cycle?: string[]; @IsOptional() @IsBoolean() is_active?: boolean;
}
class NormDto {
  @IsOptional() @IsUUID() department_id?: string; @IsOptional() @IsUUID() shift_template_id?: string; @IsOptional() @IsIn(CAT) category?: string;
  @IsOptional() @IsInt() @Min(1) @Max(100) min_count?: number; @IsOptional() @IsArray() @IsInt({ each: true }) @Min(1, { each: true }) @Max(7, { each: true }) weekdays?: number[];
  @IsOptional() @IsBoolean() holidays?: boolean; @IsOptional() @IsBoolean() is_active?: boolean;
}
class StaffDto {
  @IsOptional() @IsUUID() user_id?: string | null; @IsOptional() @IsString() @Length(1, 100) first_name?: string; @IsOptional() @IsString() @Length(1, 100) last_name?: string;
  @IsOptional() @IsString() @Matches(/^(\d{11})?$/) personal_number?: string | null; @IsOptional() @IsString() @MaxLength(50) phone?: string | null;
  @IsOptional() @IsUUID() position_id?: string | null; @IsOptional() @IsUUID() department_id?: string; @IsOptional() @IsArray() @ArrayMaxSize(20) @IsUUID('all', { each: true }) extra_department_ids?: string[];
  @IsOptional() @IsNumber() @Min(0.05) @Max(1.5) fte?: number; @IsOptional() @IsIn(EMPLOYMENT) employment?: string;
  @IsOptional() @IsISO8601({ strict: true }) hired_on?: string | null; @IsOptional() @IsISO8601({ strict: true }) left_on?: string | null;
  @IsOptional() @IsBoolean() is_active?: boolean; @IsOptional() @IsString() @MaxLength(2000) notes?: string | null;
}
class FromUsersDto { @IsArray() @ArrayMaxSize(500) @IsUUID('all', { each: true }) user_ids: string[]; @IsOptional() @IsUUID() position_id?: string; @IsOptional() @IsUUID() department_id?: string }
interface StaffQ { department_id?: string; search?: string; active?: string; category?: string; position_id?: string; no_user?: string }
const uuidOk = (v?: string) => !v || /^[0-9a-f-]{36}$/i.test(v);

/** ცვლები / მორიგეობა — ცნობარები და თანამშრომლები */
@Controller('roster')
export class RosterSetupController {
  constructor(private readonly s: RosterSetupService) {}
  @Get('refs') refs(@CurrentUser() u: AuthUser) { return this.s.refs(u); }

  @Post('positions') @Roles(...ROSTER_HR) position(@Body() d: PositionDto, @Req() r: Request) {
    if (!d.code || !d.name || !d.category) throw new BadRequestException('კოდი, დასახელება და კატეგორია სავალდებულოა');
    return this.s.savePosition(null, d, auditCtx(r));
  }
  @Patch('positions/:id') @Roles(...ROSTER_HR) positionU(@Param('id', ParseUUIDPipe) id: string, @Body() d: PositionDto, @Req() r: Request) {
    if (d.code !== undefined) throw new BadRequestException('კოდი არ იცვლება');
    return this.s.savePosition(id, d, auditCtx(r));
  }
  @Post('templates') @Roles(...ROSTER_SETUP) template(@Body() d: TemplateDto, @Req() r: Request) {
    if (!d.code || !d.name || !d.kind || !d.start_time || !d.end_time) throw new BadRequestException('კოდი, დასახელება, სახე და დრო სავალდებულოა');
    return this.s.saveTemplate(null, d, auditCtx(r));
  }
  @Patch('templates/:id') @Roles(...ROSTER_SETUP) templateU(@Param('id', ParseUUIDPipe) id: string, @Body() d: TemplateDto, @Req() r: Request) {
    if (d.code !== undefined) throw new BadRequestException('კოდი არ იცვლება');
    return this.s.saveTemplate(id, d, auditCtx(r));
  }
  @Get('holidays') holidays(@Query('year') year?: string) { if (year && !/^\d{4}$/.test(year)) throw new BadRequestException('year — YYYY'); return this.s.holidays(year); }
  @Post('holidays') @Roles(...ROSTER_HR) holiday(@Body() d: HolidayDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.addHoliday(d, u, auditCtx(r)); }
  @Delete('holidays/:day') @Roles(...ROSTER_HR) holidayD(@Param('day') day: string, @Req() r: Request) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new BadRequestException('day — YYYY-MM-DD');
    return this.s.removeHoliday(day, auditCtx(r));
  }
  @Post('duty-roles') @Roles(...ROSTER_SETUP) duty(@Body() d: DutyRoleDto, @Req() r: Request) {
    if (!d.code || !d.name) throw new BadRequestException('კოდი და დასახელება სავალდებულოა');
    return this.s.saveDutyRole(null, d, auditCtx(r));
  }
  @Patch('duty-roles/:id') @Roles(...ROSTER_SETUP) dutyU(@Param('id', ParseUUIDPipe) id: string, @Body() d: DutyRoleDto, @Req() r: Request) {
    if (d.code !== undefined) throw new BadRequestException('კოდი არ იცვლება');
    return this.s.saveDutyRole(id, d, auditCtx(r));
  }
  @Post('patterns') @Roles(...ROSTER_SETUP) pattern(@Body() d: PatternDto, @Req() r: Request) {
    if (!d.code || !d.name || !d.cycle?.length) throw new BadRequestException('კოდი, დასახელება და ციკლი სავალდებულოა');
    return this.s.savePattern(null, d, auditCtx(r));
  }
  @Patch('patterns/:id') @Roles(...ROSTER_SETUP) patternU(@Param('id', ParseUUIDPipe) id: string, @Body() d: PatternDto, @Req() r: Request) {
    if (d.code !== undefined) throw new BadRequestException('კოდი არ იცვლება');
    return this.s.savePattern(id, d, auditCtx(r));
  }
  @Get('norms') norms(@Query('department_id') dept: string, @CurrentUser() u: AuthUser) {
    if (!dept || !uuidOk(dept)) throw new BadRequestException('department_id');
    return this.s.norms(dept, u);
  }
  @Post('norms') norm(@Body() d: NormDto, @CurrentUser() u: AuthUser, @Req() r: Request) {
    if (!d.department_id || !d.shift_template_id || !d.category || !d.min_count) throw new BadRequestException('განყოფილება, ცვლა, კატეგორია და რაოდენობა სავალდებულოა');
    return this.s.saveNorm(null, d, u, auditCtx(r));
  }
  @Patch('norms/:id') normU(@Param('id', ParseUUIDPipe) id: string, @Body() d: NormDto, @CurrentUser() u: AuthUser, @Req() r: Request) {
    if (d.department_id !== undefined) throw new BadRequestException('განყოფილება არ იცვლება');
    return this.s.saveNorm(id, d, u, auditCtx(r));
  }

  @Get('staff') staff(@CurrentUser() u: AuthUser, @Query() q: StaffQ) {
    if (!uuidOk(q.department_id) || !uuidOk(q.position_id)) throw new BadRequestException('არასწორი id');
    if (q.category && !CAT.includes(q.category)) throw new BadRequestException('category');
    return this.s.staff(u, q);
  }
  @Post('staff') staffC(@Body() d: StaffDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.saveStaff(null, d, u, auditCtx(r)); }
  @Patch('staff/:id') staffU(@Param('id', ParseUUIDPipe) id: string, @Body() d: StaffDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.saveStaff(id, d, u, auditCtx(r)); }
  @Get('users-without-staff') usersWithout(@CurrentUser() u: AuthUser, @Query('search') search?: string, @Query('department_id') dept?: string) {
    if (!uuidOk(dept)) throw new BadRequestException('არასწორი id');
    return this.s.usersWithout(u, search, dept);
  }
  @Post('staff/from-users') @HttpCode(200) fromUsers(@Body() d: FromUsersDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.fromUsers(d, u, auditCtx(r)); }
}
