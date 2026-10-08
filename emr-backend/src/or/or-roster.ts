import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { IsOptional, IsString, IsUUID, Length, Matches, MaxLength, ValidateIf } from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser } from '../auth/roles';
import { mapPgError } from '../common/pg-errors';
import { InjectDb, type Database } from '../database/database.module';
import { ModulesService } from '../modules/modules';
import { OR_READ } from './or-admin';
import { OR_SETTINGS_0049, orEvent, TZ, type Ex, type OrSettings, type Trx } from './or-shared';

const NO_ANESTHESIOLOGIST = ['local', 'none'];
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export class RosterDto { @IsUUID() room_id: string; @IsUUID() user_id: string; @IsString() @Length(2, 30) role_code: string }
export class RosterDayDto {
  @Matches(DAY) day: string;
  @IsUUID() user_id: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() room_id?: string | null;     // null — დღეს არ არის
  @IsOptional() @IsString() @Length(2, 30) role_code?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export interface DayMember { user_id: string; name: string; role_code: string; role_name: string; grp: string; source: 'room' | 'day'; override_id: string | null }

/**
 * ოთახის გუნდი (0049, room_teams): მუდმივი გუნდი ოთახზე + დღის ცვლილება („დღეს X → OR2“ / „დღეს Y არ არის“).
 * დღის გუნდი = მუდმივი (ვისაც ამ დღეს ცვლილება არ აქვს) + ამ დღეს ოთახში გადმოყვანილი.
 * ოპერაციის დაგეგმვისას (და ოთახის / თარიღის / გუნდის ცვლილებისას, დაწყებამდე) დღის გუნდი ოპერაციის გუნდს ემატება (auto);
 * ხელით დამატებულს / შეცვლილს / მოხსნილს არ ეხება.
 * მართავს: საექთნო როლები — ბლოკის მთავარი ექთანი (or_nurse + ხელმძღვანელი) / admin; ანესთეზიის — anesthesia_team_by-ით (ანესთეზიოლოგიის ხელმძღვანელი) / admin.
 */
@Injectable()
export class OrRosterService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService, private readonly modules: ModulesService) {}

  async settings(): Promise<OrSettings> { return { ...OR_SETTINGS_0049, ...(await this.modules.require<OrSettings>('or')) }; }
  private me(u: AuthUser, ex: Ex = this.db) { return ex.selectFrom('users').select(['id', 'department_id', 'is_section_head']).where('id', '=', u.id).executeTakeFirstOrThrow(); }

  /** ვის შეუძლია roster-ის მართვა (ჯგუფის მიხედვით) */
  async rights(u: AuthUser, s: OrSettings, ex: Ex = this.db) {
    if (has(u, 'admin')) return { nursing: true, anesthesia: true };
    const me = await this.me(u, ex);
    const headNurse = has(u, 'or_nurse') && !!me.is_section_head;
    const anesthHead = has(u, 'anesthesiologist') && !!me.is_section_head;
    return { nursing: headNurse, anesthesia: s.anesthesia_team_by === 'anesthesia_head' ? anesthHead : headNurse };
  }
  private async requireRight(u: AuthUser, s: OrSettings, grp: string, ex: Ex) {
    const r = await this.rights(u, s, ex);
    if (!(grp === 'anesthesia' ? r.anesthesia : r.nursing)) {
      throw new ForbiddenException(grp === 'anesthesia' ? (s.anesthesia_team_by === 'anesthesia_head' ? 'ოთახის ანესთეზიის გუნდს მართავს ანესთეზიოლოგიის ხელმძღვანელი / admin'
        : 'ოთახის გუნდს მართავს ბლოკის მთავარი ექთანი / admin') : 'ოთახის გუნდს მართავს ბლოკის მთავარი ექთანი / admin');
    }
  }

  /** დღის გუნდი ოთახ(ებ)ზე */
  async dayTeams(day: string, roomIds: string[], ex: Ex = this.db): Promise<Map<string, DayMember[]>> {
    const out = new Map<string, DayMember[]>(roomIds.map((r) => [r, []]));
    if (!roomIds.length) return out;
    const perm = await ex.selectFrom('or_room_staff as s').innerJoin('users as x', 'x.id', 's.user_id').innerJoin('or_team_roles as r', 'r.code', 's.role_code')
      .select(['s.room_id', 's.user_id', 's.role_code', 'r.name as role_name', 'r.grp', 'r.sort_order', sql<string>`x.last_name || ' ' || x.first_name`.as('name')])
      .where('s.room_id', 'in', roomIds).where('s.removed_at', 'is', null).where('x.is_active', '=', true).where('r.is_active', '=', true)
      .where((eb) => eb.not(eb.exists(eb.selectFrom('or_room_staff_days as d').select('d.id').whereRef('d.user_id', '=', 's.user_id').where('d.day', '=', day).where('d.cancelled_at', 'is', null))))
      .execute();
    const moved = await ex.selectFrom('or_room_staff_days as d').innerJoin('users as x', 'x.id', 'd.user_id').innerJoin('or_team_roles as r', 'r.code', 'd.role_code')
      .select(['d.id', 'd.room_id', 'd.user_id', 'd.role_code', 'r.name as role_name', 'r.grp', 'r.sort_order', sql<string>`x.last_name || ' ' || x.first_name`.as('name')])
      .where('d.day', '=', day).where('d.cancelled_at', 'is', null).where('d.room_id', 'in', roomIds).where('x.is_active', '=', true).where('r.is_active', '=', true).execute();
    const all = [...perm.map((p) => ({ ...p, source: 'room' as const, override_id: null })), ...moved.map((m) => ({ ...m, room_id: m.room_id!, role_code: m.role_code!, source: 'day' as const, override_id: m.id }))]
      .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
    for (const m of all) out.get(m.room_id)?.push({ user_id: m.user_id, name: m.name, role_code: m.role_code, role_name: m.role_name, grp: m.grp, source: m.source, override_id: m.override_id });
    return out;
  }

  /**
   * ოპერაციის ავტომატური გუნდის სინქრონიზაცია ოთახის დღის გუნდთან (დაწყებამდე).
   * ხელით მოხსნილი ავტომატური წევრი (removed_auto = false) აღარ ბრუნდება; ხელით შევსებული ერთადერთი როლი — არ იცვლება.
   */
  async syncCase(trx: Trx, caseId: string, userId: string, s?: OrSettings) {
    const st = s ?? (await this.settings());
    const c = await trx.selectFrom('or_cases').select(['id', 'status', 'room_id', 'scheduled_start', 'anesthesia_type', 'encounter_id', 'planned_id', 'locked_at']).where('id', '=', caseId).executeTakeFirstOrThrow();
    if (!['requested', 'tentative', 'scheduled'].includes(c.status) || c.locked_at) return 0;
    let desired: DayMember[] = [];
    if (st.room_teams && c.room_id && c.scheduled_start && c.status !== 'requested') {
      const day = (await sql<{ d: string }>`SELECT (${c.scheduled_start}::timestamptz AT TIME ZONE ${TZ})::date::text AS d`.execute(trx)).rows[0].d;
      desired = (await this.dayTeams(day, [c.room_id], trx)).get(c.room_id) ?? [];
      if (NO_ANESTHESIOLOGIST.includes(c.anesthesia_type)) desired = desired.filter((d) => d.grp !== 'anesthesia');
    }
    const rows = await trx.selectFrom('or_case_team as t').innerJoin('or_team_roles as r', 'r.code', 't.role_code')
      .select(['t.id', 't.role_code', 't.user_id', 't.auto', 't.removed_at', 't.removed_auto', 't.out_at', 'r.multiple', 'r.name as role_name'])
      .where('t.case_id', '=', c.id).forUpdate('t').execute();
    const active = rows.filter((r) => !r.removed_at && !r.out_at);
    const key = (x: { user_id: string; role_code: string }) => `${x.user_id}:${x.role_code}`;
    const want = new Set(desired.map(key));
    const changes: string[] = [];
    for (const r of active.filter((a) => a.auto && !want.has(key(a)))) {
      await trx.updateTable('or_case_team').set({ removed_at: sql`now()`, removed_by: userId, remove_reason: 'ოთახის გუნდი შეიცვალა', removed_auto: true }).where('id', '=', r.id).execute();
      active.splice(active.indexOf(r), 1);
      changes.push(`− ${r.role_name}`);
    }
    const roles = new Map((await trx.selectFrom('or_team_roles').select(['code', 'multiple', 'is_active']).execute()).map((r) => [r.code, r]));
    for (const d of desired) {
      if (active.some((a) => key(a) === key(d))) continue;
      if (rows.some((r) => key(r) === key(d) && r.auto && r.removed_at && !r.removed_auto)) continue;      // ხელით მოხსნილი
      const role = roles.get(d.role_code);
      if (!role?.is_active) continue;
      if (!role.multiple && active.some((a) => a.role_code === d.role_code)) continue;
      if (active.some((a) => a.user_id === d.user_id && a.role_code !== 'surgeon' && !a.auto)) continue;  // უკვე გუნდშია სხვა როლით (ხელით)
      const row = await trx.insertInto('or_case_team').values({ case_id: c.id, role_code: d.role_code, user_id: d.user_id, added_by: userId, auto: true })
        .returning(['id']).executeTakeFirstOrThrow();
      active.push({ id: row.id, role_code: d.role_code, user_id: d.user_id, auto: true, removed_at: null, removed_auto: false, out_at: null, multiple: role.multiple, role_name: d.role_name });
      changes.push(`+ ${d.role_name}: ${d.name}`);
    }
    if (changes.length) await orEvent(trx, c, 'team_auto', { changes }, userId);
    return changes.length;
  }

  /** ოთახ(ებ)ის დაწყებამდე ოპერაციების ხელახალი სინქრონიზაცია (day = null → დღეიდან ყველა) */
  private async resync(trx: Trx, roomIds: string[], day: string | null, userId: string, s: OrSettings) {
    if (!roomIds.length) return 0;
    const cases = await trx.selectFrom('or_cases').select('id').where('room_id', 'in', roomIds).where('status', 'in', ['tentative', 'scheduled'])
      .$if(!!day, (q) => q.where(sql<boolean>`(scheduled_start AT TIME ZONE ${TZ})::date = ${day}::date`))
      .$if(!day, (q) => q.where(sql<boolean>`(scheduled_start AT TIME ZONE ${TZ})::date >= (now() AT TIME ZONE ${TZ})::date`)).execute();
    let n = 0;
    for (const c of cases) n += await this.syncCase(trx, c.id, userId, s);
    return n;
  }

  // ================================================================= API
  async view(day: string | undefined, u: AuthUser) {
    const s = await this.settings();
    const d = day ?? (await sql<{ d: string }>`SELECT (now() AT TIME ZONE ${TZ})::date::text AS d`.execute(this.db)).rows[0].d;
    const rooms = await this.db.selectFrom('or_rooms as r').innerJoin('departments as b', 'b.id', 'r.department_id').select(['r.id', 'r.code', 'r.name', 'b.name as block_name', 'r.department_id'])
      .where('r.is_active', '=', true).where('b.is_active', '=', true).orderBy('b.name').orderBy('r.sort_order').orderBy('r.code').execute();
    const staff = await this.db.selectFrom('or_room_staff as s').innerJoin('users as x', 'x.id', 's.user_id').innerJoin('or_team_roles as r', 'r.code', 's.role_code')
      .select(['s.id', 's.room_id', 's.user_id', 's.role_code', 'r.name as role_name', 'r.grp', sql<string>`x.last_name || ' ' || x.first_name`.as('name'), 'x.is_active', 's.added_at'])
      .where('s.removed_at', 'is', null).orderBy('r.sort_order').orderBy('x.last_name').execute();
    const overrides = await this.db.selectFrom('or_room_staff_days as d').innerJoin('users as x', 'x.id', 'd.user_id').leftJoin('or_rooms as r', 'r.id', 'd.room_id')
      .leftJoin('or_team_roles as tr', 'tr.code', 'd.role_code').leftJoin('users as cb', 'cb.id', 'd.created_by')
      .select(['d.id', 'd.day', 'd.user_id', 'd.room_id', 'd.role_code', 'd.note', 'd.created_at', 'r.code as room_code', 'tr.name as role_name',
        sql<string>`x.last_name || ' ' || x.first_name`.as('name'), sql<string>`cb.last_name || ' ' || cb.first_name`.as('created_by_name'),
        sql<string | null>`(SELECT ro.code FROM or_room_staff s JOIN or_rooms ro ON ro.id = s.room_id WHERE s.user_id = d.user_id AND s.removed_at IS NULL LIMIT 1)`.as('home_room_code')])
      .where('d.day', '=', d).where('d.cancelled_at', 'is', null).orderBy('x.last_name').execute();
    const teams = await this.dayTeams(d, rooms.map((r) => r.id));
    return { day: d, enabled: s.room_teams, rooms: rooms.map((r) => ({ ...r, staff: staff.filter((x) => x.room_id === r.id), team: teams.get(r.id) ?? [] })), overrides,
      can: await this.rights(u, s) };
  }

  async add(dto: RosterDto, u: AuthUser, ctx: AuditContext) {
    const s = await this.settings();
    try {
      await this.db.transaction().execute(async (trx) => {
        const role = await trx.selectFrom('or_team_roles').selectAll().where('code', '=', dto.role_code).executeTakeFirst();
        if (!role?.is_active || role.grp === 'surgical') throw new BadRequestException('ოთახის გუნდში — მხოლოდ ანესთეზიის / საექთნო როლები');
        await this.requireRight(u, s, role.grp, trx);
        const room = await trx.selectFrom('or_rooms').select(['id', 'is_active', 'code']).where('id', '=', dto.room_id).executeTakeFirst();
        if (!room?.is_active) throw new BadRequestException('ოთახი ვერ მოიძებნა ან გათიშულია');
        const caps = role.capability === 'nurse' ? ['nurse', 'or_nurse'] : [role.capability];
        const x = await trx.selectFrom('users as x').select(['x.id', 'x.is_active', sql<string[]>`coalesce((SELECT c.capabilities FROM user_capabilities c WHERE c.user_id = x.id), '{}')`.as('caps')])
          .where('x.id', '=', dto.user_id).executeTakeFirst();
        if (!x?.is_active || !caps.some((c) => x.caps.includes(c))) throw new BadRequestException(`თანამშრომელს „${role.name}“-ის უფლება არ აქვს ან გათიშულია`);
        const cur = await trx.selectFrom('or_room_staff as s').innerJoin('or_rooms as r', 'r.id', 's.room_id').select(['s.id', 'r.code']).where('s.user_id', '=', x.id).where('s.removed_at', 'is', null).executeTakeFirst();
        if (cur) throw new ConflictException({ code: 'ROSTER_TAKEN', message: `თანამშრომელი უკვე ოთახ ${cur.code}-ის გუნდშია — ჯერ მოხსენით (ან დღის ცვლილებით გადაიყვანეთ)` });
        const r = await trx.insertInto('or_room_staff').values({ room_id: room.id, user_id: x.id, role_code: role.code, added_by: u.id }).returning('id').executeTakeFirstOrThrow();
        const n = await this.resync(trx, [room.id], null, u.id, s);
        await this.audit.log(ctx, { action: 'OR_ROSTER_ADD', entityName: 'or_room_staff', entityId: r.id, newData: { ...dto, synced: n } }, trx);
      });
    } catch (e) { mapPgError(e, { ux_or_room_staff_user: 'თანამშრომელი უკვე სხვა ოთახის გუნდშია' }); }
    return this.view(undefined, u);
  }

  async remove(id: string, u: AuthUser, ctx: AuditContext) {
    const s = await this.settings();
    await this.db.transaction().execute(async (trx) => {
      const r = await trx.selectFrom('or_room_staff as s').innerJoin('or_team_roles as r', 'r.code', 's.role_code').select(['s.id', 's.room_id', 's.removed_at', 'r.grp'])
        .where('s.id', '=', id).forUpdate('s').executeTakeFirst();
      if (!r || r.removed_at) throw new NotFoundException('ჩანაწერი ვერ მოიძებნა');
      await this.requireRight(u, s, r.grp, trx);
      await trx.updateTable('or_room_staff').set({ removed_at: sql`now()`, removed_by: u.id }).where('id', '=', id).execute();
      const n = await this.resync(trx, [r.room_id], null, u.id, s);
      await this.audit.log(ctx, { action: 'OR_ROSTER_REMOVE', entityName: 'or_room_staff', entityId: id, newData: { synced: n } }, trx);
    });
    return this.view(undefined, u);
  }

  /** დღის ცვლილება: სხვა ოთახში (room_id) ან „დღეს არ არის“ (room_id = null). იმავე დღის წინა ცვლილება უქმდება. */
  async setDay(dto: RosterDayDto, u: AuthUser, ctx: AuditContext) {
    const s = await this.settings();
    const today = (await sql<{ d: string }>`SELECT (now() AT TIME ZONE ${TZ})::date::text AS d`.execute(this.db)).rows[0].d;
    if (dto.day < today) throw new BadRequestException('წარსული დღე');
    await this.db.transaction().execute(async (trx) => {
      const home = await trx.selectFrom('or_room_staff as s').innerJoin('or_team_roles as r', 'r.code', 's.role_code').select(['s.room_id', 's.role_code', 'r.grp'])
        .where('s.user_id', '=', dto.user_id).where('s.removed_at', 'is', null).executeTakeFirst();
      const roleCode = dto.room_id ? (dto.role_code ?? home?.role_code) : null;
      if (dto.room_id && !roleCode) throw new BadRequestException('მიუთითეთ როლი (თანამშრომელი მუდმივ გუნდში არ არის)');
      const role = roleCode ? await trx.selectFrom('or_team_roles').selectAll().where('code', '=', roleCode).executeTakeFirst() : null;
      if (roleCode && (!role?.is_active || role.grp === 'surgical')) throw new BadRequestException('ოთახის გუნდში — მხოლოდ ანესთეზიის / საექთნო როლები');
      const grp = role?.grp ?? home?.grp;
      if (!grp) throw new BadRequestException('თანამშრომელი ოთახის გუნდში არ არის — „დღეს არ არის“ არ ეხება');
      await this.requireRight(u, s, grp, trx);
      if (role) {
        const caps = role.capability === 'nurse' ? ['nurse', 'or_nurse'] : [role.capability];
        const x = await trx.selectFrom('users as x').select(['x.is_active', sql<string[]>`coalesce((SELECT c.capabilities FROM user_capabilities c WHERE c.user_id = x.id), '{}')`.as('caps')])
          .where('x.id', '=', dto.user_id).executeTakeFirst();
        if (!x?.is_active || !caps.some((c) => x.caps.includes(c))) throw new BadRequestException(`თანამშრომელს „${role.name}“-ის უფლება არ აქვს ან გათიშულია`);
      }
      if (dto.room_id) {
        const room = await trx.selectFrom('or_rooms').select('is_active').where('id', '=', dto.room_id).executeTakeFirst();
        if (!room?.is_active) throw new BadRequestException('ოთახი ვერ მოიძებნა ან გათიშულია');
      }
      const prev = await trx.selectFrom('or_room_staff_days').select(['id', 'room_id']).where('day', '=', dto.day).where('user_id', '=', dto.user_id).where('cancelled_at', 'is', null).forUpdate().executeTakeFirst();
      if (prev) await trx.updateTable('or_room_staff_days').set({ cancelled_at: sql`now()`, cancelled_by: u.id }).where('id', '=', prev.id).execute();
      const back = dto.room_id && home && dto.room_id === home.room_id && roleCode === home.role_code;   // საკუთარ ოთახში დაბრუნება = ცვლილების გაუქმება
      let id: string | null = null;
      if (!back) {
        id = (await trx.insertInto('or_room_staff_days').values({ day: dto.day, user_id: dto.user_id, room_id: dto.room_id ?? null, role_code: roleCode, note: dto.note?.trim() || null, created_by: u.id })
          .returning('id').executeTakeFirstOrThrow()).id;
      }
      const rooms = [...new Set([home?.room_id, prev?.room_id, dto.room_id].filter((x): x is string => !!x))];
      const n = await this.resync(trx, rooms, dto.day, u.id, s);
      await this.audit.log(ctx, { action: 'OR_ROSTER_DAY', entityName: 'or_room_staff_days', entityId: id ?? prev?.id ?? dto.user_id, newData: { ...dto, synced: n } }, trx);
    });
    return this.view(dto.day, u);
  }

  async cancelDay(id: string, u: AuthUser, ctx: AuditContext) {
    const s = await this.settings();
    const day = await this.db.transaction().execute(async (trx) => {
      const d = await trx.selectFrom('or_room_staff_days').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!d || d.cancelled_at) throw new NotFoundException('ცვლილება ვერ მოიძებნა');
      const home = await trx.selectFrom('or_room_staff as s').innerJoin('or_team_roles as r', 'r.code', 's.role_code').select(['s.room_id', 'r.grp'])
        .where('s.user_id', '=', d.user_id).where('s.removed_at', 'is', null).executeTakeFirst();
      const grp = d.role_code ? (await trx.selectFrom('or_team_roles').select('grp').where('code', '=', d.role_code).executeTakeFirstOrThrow()).grp : home?.grp ?? 'nursing';
      await this.requireRight(u, s, grp, trx);
      await trx.updateTable('or_room_staff_days').set({ cancelled_at: sql`now()`, cancelled_by: u.id }).where('id', '=', id).execute();
      const n = await this.resync(trx, [...new Set([home?.room_id, d.room_id].filter((x): x is string => !!x))], d.day, u.id, s);
      await this.audit.log(ctx, { action: 'OR_ROSTER_DAY_CANCEL', entityName: 'or_room_staff_days', entityId: id, newData: { synced: n } }, trx);
      return d.day;
    });
    return this.view(day, u);
  }
}

@Controller('or')
export class OrRosterController {
  constructor(private readonly s: OrRosterService) {}
  @Get('roster') @Roles(...OR_READ) view(@Query('date') date: string | undefined, @CurrentUser() u: AuthUser) {
    if (date && !DAY.test(date)) throw new BadRequestException('თარიღი: YYYY-MM-DD');
    return this.s.view(date, u);
  }
  @Post('roster') @Roles('admin', 'or_nurse', 'anesthesiologist') add(@Body() d: RosterDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.add(d, u, auditCtx(r)); }
  @Post('roster/:id/remove') @HttpCode(200) @Roles('admin', 'or_nurse', 'anesthesiologist')
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.remove(id, u, auditCtx(r)); }
  @Post('roster/day') @HttpCode(200) @Roles('admin', 'or_nurse', 'anesthesiologist') day(@Body() d: RosterDayDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.setDay(d, u, auditCtx(r)); }
  @Post('roster/day/:id/cancel') @HttpCode(200) @Roles('admin', 'or_nurse', 'anesthesiologist')
  cancelDay(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.cancelDay(id, u, auditCtx(r)); }
}
