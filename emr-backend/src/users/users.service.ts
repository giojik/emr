import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { invalidateUserStatus } from '../auth/auth.guard';
import { PasswordService } from '../auth/password.service';
import type { AuthUser } from '../auth/roles';
import { loadEnv } from '../config/env';
import { InjectDb, type Database } from '../database/database.module';
import type { DB } from '../database/db';
import type { CreateUserDto, ListUsersQuery, UpdateUserDto } from './dto/users.dto';

/** password_hash არასოდეს გამოდის API-დან და არ იწერება აუდიტში */
const SAFE = ['u.id', 'u.email', 'u.first_name', 'u.last_name', 'u.personal_number', 'u.phone', 'u.role',
  'u.department_id', 'u.specialty', 'u.license_number', 'u.auth_provider', 'u.ldap_username', 'u.is_active',
  'u.must_change_password', 'u.failed_login_count', 'u.locked_until', 'u.last_login_at',
  'u.password_changed_at', 'u.created_at', 'u.updated_at'] as const;

const UNIQUE_MSG: Record<string, string> = {
  users_email_key: 'ეს ელ-ფოსტა უკვე გამოყენებულია',
  users_personal_number_key: 'ამ პირადი ნომრით მომხმარებელი უკვე არსებობს',
  users_ldap_username_key: 'ეს დომენის სახელი უკვე მიბმულია სხვა მომხმარებელზე',
};

@Injectable()
export class UsersService {
  private readonly env = loadEnv();
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService,
              private readonly passwords: PasswordService) {}

  private base(executor: Database | Transaction<DB> = this.db) {
    return executor.selectFrom('users as u')
      .leftJoin('departments as d', 'd.id', 'u.department_id')
      .select([...SAFE, 'd.name as department_name',
        sql<boolean>`coalesce(u.locked_until > now(), false)`.as('is_locked')]);
  }

  async list(q: ListUsersQuery) {
    let query = this.base();
    if (q.role) query = query.where('u.role', '=', q.role);
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

    return this.guard(() => this.db.transaction().execute(async (trx) => {
      const { id } = await trx.insertInto('users').values({
        ...dto, auth_provider: provider,
        ldap_username: provider === 'ldap' ? dto.ldap_username : null,
        password_hash: temp ? await this.passwords.hash(temp) : null,
        must_change_password: provider === 'local',
      }).returning('id').executeTakeFirstOrThrow();
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
      const roleChanged = dto.role !== undefined && dto.role !== old.role;
      if (roleChanged && old.role === 'admin') {
        if (id === actor.id) throw new ForbiddenException('საკუთარი admin როლის მოხსნა შეუძლებელია');
        await this.assertNotLastAdmin(trx, id);
      }
      if (Object.keys(dto).length === 0) return old;

      await trx.updateTable('users').set(dto).where('id', '=', id).execute();
      // როლის შეცვლისას ძველი უფლებებით გაცემული სესიები უქმდება
      if (roleChanged) { await this.revokeAll(trx, id, 'role_changed'); invalidateUserStatus(id); }
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
        if (old.role === 'admin') await this.assertNotLastAdmin(trx, id);
      }
      if (old.is_active === active) return old;
      await trx.updateTable('users').set({ is_active: active, ...(active ? { failed_login_count: 0, locked_until: null } : {}) })
        .where('id', '=', id).execute();
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

  /** ბოლო აქტიური admin-ის დაკარგვის აკრძალვა. FOR UPDATE — ორი ერთდროული ცვლილებისგან დაცვა. */
  private async assertNotLastAdmin(trx: Transaction<DB>, id: string) {
    const admins = await trx.selectFrom('users').select('id')
      .where('role', '=', 'admin').where('is_active', '=', true).forUpdate().execute();
    if (admins.length <= 1 && admins.some((a) => a.id === id)) {
      throw new ConflictException('ეს ბოლო აქტიური ადმინისტრატორია — ჯერ სხვა admin დანიშნეთ');
    }
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
      if (err.code === '23503') throw new BadRequestException('მითითებული განყოფილება არ არსებობს');
      throw e;
    }
  }
}
