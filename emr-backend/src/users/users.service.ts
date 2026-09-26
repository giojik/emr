import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { invalidateUserStatus } from '../auth/auth.guard';
import { PasswordService } from '../auth/password.service';
import { has, type AuthUser, type Role } from '../auth/roles';
import { jsonArrayFrom } from 'kysely/helpers/postgres';
import { loadEnv } from '../config/env';
import { InjectDb, type Database } from '../database/database.module';
import type { DB } from '../database/db';
import type { CreateUserDto, ListUsersQuery, UpdateUserDto } from './dto/users.dto';

/** password_hash არასოდეს გამოდის API-დან და არ იწერება აუდიტში */
const SAFE = ['u.id', 'u.email', 'u.first_name', 'u.last_name', 'u.personal_number', 'u.phone', 'u.role',
  'u.department_id', 'u.specialty', 'u.license_number', 'u.auth_provider', 'u.ldap_username', 'u.is_active',
  'u.must_change_password', 'u.failed_login_count', 'u.locked_until', 'u.last_login_at',
  'u.password_changed_at', 'u.consultation_tariff_id', 'u.is_section_head', 'u.created_at', 'u.updated_at'] as const;

const UNIQUE_MSG: Record<string, string> = {
  users_email_key: 'ეს ელ-ფოსტა უკვე გამოყენებულია',
  users_personal_number_key: 'ამ პირადი ნომრით მომხმარებელი უკვე არსებობს',
  users_ldap_username_key: 'ეს დომენის სახელი უკვე მიბმულია სხვა მომხმარებელზე',
};

export type UserScope = { kind: 'all' } | { kind: 'department'; departmentId: string };

@Injectable()
export class UsersService {
  private readonly env = loadEnv();
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService,
              private readonly passwords: PasswordService) {}

  private base(executor: Database | Transaction<DB> = this.db) {
    return executor.selectFrom('users as u')
      .leftJoin('departments as d', 'd.id', 'u.department_id')
      .leftJoin('service_tariffs as t', 't.id', 'u.consultation_tariff_id')
      .select([...SAFE, 'd.name as department_name', 't.title as consultation_tariff_title', 't.base_price as consultation_price',
        sql<boolean>`coalesce(u.locked_until > now(), false)`.as('is_locked'),
        (eb) => jsonArrayFrom(eb.selectFrom('user_roles as ur').innerJoin('roles as r', 'r.id', 'ur.role_id')
          .select(['r.code', 'r.name', 'r.is_active']).whereRef('ur.user_id', '=', 'u.id').orderBy('r.sort_order')).as('roles'),
        (eb) => eb.selectFrom('user_capabilities as c').select('c.capabilities').whereRef('c.user_id', '=', 'u.id').as('capabilities')]);
  }

  async list(q: ListUsersQuery, scope: UserScope = { kind: 'all' }) {
    let query = this.base();
    if (scope.kind === 'department') query = query.where('u.department_id', '=', scope.departmentId);
    if (q.role) query = query.where(sql<boolean>`EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id AND r.code = ${q.role})`);
    if (q.department_id) query = query.where('u.department_id', '=', q.department_id);
    if (q.active !== undefined) query = query.where('u.is_active', '=', q.active);
    if (q.search?.trim()) {
      const t = q.search.trim();
      query = query.where((eb) => eb.or([
        eb('u.email', 'ilike', `%${t}%`), eb('u.personal_number', '=', t), eb('u.ldap_username', '=', t),
        sql<boolean>`(u.last_name || ' ' || u.first_name) ilike ${'%' + t + '%'}`,
      ]));
    }
    return query.orderBy('u.last_name').orderBy('u.first_name').limit(q.limit ?? 50).offset(q.offset ?? 0).execute();
  }

  /** აქტიური ექიმები: სახელი, სპეციალობა, განყოფილება, კონსულტაციის ფასი */
  doctors() {
    return this.db.selectFrom('users as u')
      .leftJoin('departments as d', 'd.id', 'u.department_id')
      .leftJoin('service_tariffs as t', 't.id', 'u.consultation_tariff_id')
      .select(['u.id', 'u.first_name', 'u.last_name', 'u.specialty', 'u.department_id', 'd.name as department_name',
        't.base_price as consultation_price'])
      .where(sql<boolean>`EXISTS (SELECT 1 FROM user_capabilities c WHERE c.user_id = u.id AND 'doctor' = ANY(c.capabilities))`).where('u.is_active', '=', true)
      .orderBy('d.name').orderBy('u.last_name').execute();
  }

  async get(id: string, executor: Database | Transaction<DB> = this.db) {
    const u = await this.base(executor).where('u.id', '=', id).executeTakeFirst();
    if (!u) throw new NotFoundException('მომხმარებელი ვერ მოიძებნა');
    return u;
  }

  async create(dto: CreateUserDto, ctx: AuditContext) {
    const provider = dto.auth_provider ?? 'local';
    this.assertProviderEnabled(provider);
    if (provider === 'ldap' && !dto.ldap_username) throw new BadRequestException('LDAP მომხმარებელს სჭირდება ldap_username');
    const temp = provider === 'local' ? PasswordService.generateTemporary() : null;
    const { roles: roleCodes, role: _p, ...all } = dto;
    const rest = Object.fromEntries(Object.entries(all).filter(([, v]) => v !== undefined)) as typeof all;
    const codes = this.roleList(dto.role, roleCodes);
    if (!codes.length) throw new BadRequestException('მიუთითეთ მინიმუმ ერთი როლი');

    return this.guard(() => this.db.transaction().execute(async (trx) => {
      const roleRows = await this.resolveRoles(trx, codes);
      const { id } = await trx.insertInto('users').values({
        ...rest, role: codes[0], auth_provider: provider,
        ldap_username: provider === 'ldap' ? dto.ldap_username : null,
        password_hash: temp ? await this.passwords.hash(temp) : null,
        must_change_password: provider === 'local',
      }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('user_roles').values(roleRows.map((r) => ({ user_id: id, role_id: r.id }))).onConflict((oc) => oc.doNothing()).execute();
      const user = await this.get(id, trx);
      await this.audit.log(ctx, { action: 'CREATE_USER', entityName: 'users', entityId: id, newData: user }, trx);
      // დროებითი პაროლი ბრუნდება მხოლოდ ერთხელ — არსად ინახება ღია სახით
      return { user, temporaryPassword: temp };
    }));
  }

  async update(id: string, dto: UpdateUserDto, actor: AuthUser, ctx: AuditContext) {
    return this.guard(() => this.db.transaction().execute(async (trx) => {
      const old = await this.lockUser(trx, id);
      if (dto.ldap_username !== undefined && old.auth_provider !== 'ldap') {
        throw new BadRequestException('ldap_username მხოლოდ LDAP მომხმარებლისთვის');
      }
      const { roles: roleCodes, role: primary, ...all } = dto;
      const rest = Object.fromEntries(Object.entries(all).filter(([, v]) => v !== undefined)) as typeof all;
      const oldCodes = old.roles.map((r) => r.code);
      let codes = oldCodes;
      if (roleCodes !== undefined || primary !== undefined) {
        codes = this.roleList(primary ?? (roleCodes?.includes(old.role) ? old.role : undefined), roleCodes ?? oldCodes);
        if (primary && !codes.includes(primary)) codes = [primary, ...codes];
        if (!codes.length) throw new BadRequestException('მიუთითეთ მინიმუმ ერთი როლი');
      }
      const rolesChanged = codes[0] !== old.role || codes.length !== oldCodes.length || codes.some((c) => !oldCodes.includes(c));
      if (Object.keys(rest).length) await trx.updateTable('users').set(rest).where('id', '=', id).execute();
      if (rolesChanged) {
        const rows = await this.resolveRoles(trx, codes);
        await trx.deleteFrom('user_roles').where('user_id', '=', id).execute();
        await trx.insertInto('user_roles').values(rows.map((r) => ({ user_id: id, role_id: r.id }))).execute();
        await trx.updateTable('users').set({ role: codes[0] }).where('id', '=', id).execute();
        if (id === actor.id && has(actor, 'admin')) {
          const me = await trx.selectFrom('user_capabilities').select('capabilities').where('user_id', '=', id).executeTakeFirst();
          if (!me?.capabilities?.includes('admin')) throw new ForbiddenException('საკუთარი ადმინისტრატორის უფლების მოხსნა შეუძლებელია');
        }
        await this.assertAdminRemains(trx);
        // როლის შეცვლისას ძველი უფლებებით გაცემული სესიები უქმდება
        await this.revokeAll(trx, id, 'role_changed');
        invalidateUserStatus(id);
      }
      if (!Object.keys(rest).length && !rolesChanged) return old;
      const user = await this.get(id, trx);
      await this.audit.log(ctx, { action: 'UPDATE_USER', entityName: 'users', entityId: id, oldData: old, newData: user }, trx);
      return user;
    }));
  }

  async setActive(id: string, active: boolean, actor: AuthUser, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const old = await this.lockUser(trx, id);
      if (!active) {
        if (id === actor.id) throw new ForbiddenException('საკუთარი ანგარიშის გათიშვა შეუძლებელია');
      }
      if (old.is_active === active) return old;
      await trx.updateTable('users').set({ is_active: active, ...(active ? { failed_login_count: 0, locked_until: null } : {}) })
        .where('id', '=', id).execute();
      if (!active) await this.assertAdminRemains(trx);
      if (!active) await this.revokeAll(trx, id, 'user_disabled');
      invalidateUserStatus(id);
      await this.audit.log(ctx, { action: active ? 'ENABLE_USER' : 'DISABLE_USER', entityName: 'users', entityId: id }, trx);
      return this.get(id, trx);
    });
  }

  async resetPassword(id: string, ctx: AuditContext) {
    const temp = PasswordService.generateTemporary();
    const hash = await this.passwords.hash(temp);
    await this.db.transaction().execute(async (trx) => {
      const u = await this.lockUser(trx, id);
      if (u.auth_provider !== 'local') throw new BadRequestException('დომენის ანგარიშის პაროლი AD-ში იცვლება');
      await trx.updateTable('users').set({ password_hash: hash, must_change_password: true, failed_login_count: 0, locked_until: null })
        .where('id', '=', id).execute();
      await this.revokeAll(trx, id, 'password_reset');
      await this.audit.log(ctx, { action: 'PASSWORD_RESET', entityName: 'users', entityId: id }, trx);
    });
    return { temporaryPassword: temp };
  }

  async unlock(id: string, ctx: AuditContext) {
    await this.get(id);
    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable('users').set({ failed_login_count: 0, locked_until: null }).where('id', '=', id).execute();
      await this.audit.log(ctx, { action: 'UNLOCK_USER', entityName: 'users', entityId: id }, trx);
    });
    return this.get(id);
  }

  async sessions(id: string) {
    await this.get(id);
    return this.db.selectFrom('auth_sessions')
      .select(['id', 'family_id', 'created_at', 'expires_at', 'ip_address', 'user_agent'])
      .where('user_id', '=', id).where('revoked_at', 'is', null).where('expires_at', '>', sql<Date>`now()`)
      .orderBy('created_at', 'desc').execute();
  }

  async revokeSessions(id: string, ctx: AuditContext) {
    await this.get(id);
    const n = await this.db.transaction().execute(async (trx) => {
      const r = await this.revokeAll(trx, id, 'admin_revoked');
      await this.audit.log(ctx, { action: 'REVOKE_SESSIONS', entityName: 'users', entityId: id, newData: { count: r } }, trx);
      return r;
    });
    return { revoked: n };
  }

  // ---------------------------------------------------------------- helpers
  private async lockUser(trx: Transaction<DB>, id: string) {
    await trx.selectFrom('users').select('id').where('id', '=', id).forUpdate().executeTakeFirst();
    return this.get(id, trx);
  }

  // ---------------------------------------------------------------- მართვის არეალი (admin / hr / manager)
  /** admin — ყველა; hr — ყველა (admin-ის უფლების მქონეებს მხოლოდ ხედავს); manager — საკუთარი განყოფილება */
  async scope(actor: AuthUser): Promise<UserScope> {
    if (has(actor, 'admin', 'hr')) return { kind: 'all' };
    const me = await this.db.selectFrom('users').select('department_id').where('id', '=', actor.id).executeTakeFirst();
    if (!me?.department_id) throw new ForbiddenException('მენეჯერს განყოფილება არ აქვს მინიჭებული — მიმართეთ ადმინისტრატორს');
    return { kind: 'department', departmentId: me.department_id };
  }

  async assertCanManage(actor: AuthUser, targetId: string, op: 'view' | 'edit') {
    if (has(actor, 'admin')) return;
    const t = await this.db.selectFrom('users as u').leftJoin('user_capabilities as c', 'c.user_id', 'u.id')
      .select(['u.department_id', 'c.capabilities']).where('u.id', '=', targetId).executeTakeFirst();
    if (!t) throw new NotFoundException('მომხმარებელი ვერ მოიძებნა');
    const targetAdmin = (t.capabilities ?? []).includes('admin');
    if (has(actor, 'hr')) {
      if (op === 'edit' && targetAdmin) throw new ForbiddenException('ადმინისტრატორის უფლების მქონე მომხმარებელს ცვლის მხოლოდ ადმინისტრატორი');
      return;
    }
    const scope = await this.scope(actor);
    if (scope.kind !== 'department' || t.department_id !== scope.departmentId) throw new ForbiddenException('მხოლოდ საკუთარი განყოფილების თანამშრომლები');
    if (op === 'edit' && (targetAdmin || (t.capabilities ?? []).some((c) => c === 'hr' || c === 'manager'))) {
      throw new ForbiddenException('ადმინისტრატორს, HR-ს ან მენეჯერს მენეჯერი ვერ შეცვლის');
    }
  }

  /** HR ვერ მიანიჭებს როლს, რომელიც ადმინისტრატორის უფლებას შეიცავს */
  async assertCanAssign(actor: AuthUser, codes: string[]) {
    if (has(actor, 'admin') || !codes.length) return;
    const bad = await this.db.selectFrom('roles').select('name').where('code', 'in', codes).where(sql<boolean>`'admin' = ANY(capabilities)`).execute();
    if (bad.length) throw new ForbiddenException(`როლს „${bad.map((b) => b.name).join(', ')}“ ანიჭებს მხოლოდ ადმინისტრატორი`);
  }

  /** ცვლილების შემდეგ (იმავე ტრანზაქციაში) მინიმუმ ერთი აქტიური მომხმარებელი admin უფლებით უნდა დარჩეს */
  async assertAdminRemains(trx: Transaction<DB>) {
    await sql`SELECT pg_advisory_xact_lock(72000002)`.execute(trx);   // ორი ერთდროული ცვლილებისგან დაცვა
    const n = await trx.selectFrom('users as u').innerJoin('user_capabilities as c', 'c.user_id', 'u.id')
      .select((eb) => eb.fn.countAll<string>().as('n')).where('u.is_active', '=', true).where(sql<boolean>`'admin' = ANY(c.capabilities)`).executeTakeFirstOrThrow();
    if (!Number(n.n)) throw new ConflictException('ეს ბოლო აქტიური ადმინისტრატორია — ჯერ სხვას მიანიჭეთ ადმინისტრატორის როლი');
  }

  /** ძირითადი როლი პირველია, დუბლიკატების გარეშე */
  private roleList(primary: string | undefined, all: string[] | undefined) {
    return [...new Set([...(primary ? [primary] : []), ...(all ?? [])])];
  }

  private async resolveRoles(trx: Transaction<DB>, codes: string[]) {
    const rows = await trx.selectFrom('roles').select(['id', 'code', 'is_active', 'capabilities']).where('code', 'in', codes).execute();
    const missing = codes.filter((c) => !rows.some((r) => r.code === c && r.is_active));
    if (missing.length) throw new BadRequestException(`როლი ვერ მოიძებნა ან გათიშულია: ${missing.join(', ')}`);
    return rows as (typeof rows[number] & { capabilities: Role[] })[];
  }

  private async revokeAll(trx: Transaction<DB>, userId: string, reason: string) {
    const r = await trx.updateTable('auth_sessions').set({ revoked_at: sql`now()`, revoke_reason: reason })
      .where('user_id', '=', userId).where('revoked_at', 'is', null).executeTakeFirst();
    return Number(r.numUpdatedRows);
  }

  private assertProviderEnabled(p: 'local' | 'ldap') {
    const on = p === 'local' ? this.env.AUTH_LOCAL_ENABLED : this.env.AUTH_LDAP_ENABLED;
    if (!on) throw new BadRequestException(`${p} ავტორიზაცია ამ კლინიკაში გათიშულია`);
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try { return await fn(); } catch (e) {
      const err = e as { code?: string; constraint?: string };
      if (err.code === '23505') throw new ConflictException(UNIQUE_MSG[err.constraint ?? ''] ?? 'ჩანაწერი უკვე არსებობს');
      if (err.code === '23503') throw new BadRequestException('მითითებული განყოფილება ან ტარიფი არ არსებობს');
      throw e;
    }
  }
}
