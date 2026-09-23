import { BadRequestException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { sql, type Transaction } from 'kysely';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { loadEnv } from '../config/env';
import { InjectDb, type Database } from '../database/database.module';
import type { DB } from '../database/db';
import type { AccessTokenPayload } from './auth.guard';
import { LdapService } from './ldap.service';
import { PasswordService } from './password.service';
import type { Role } from './roles';

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const INVALID = 'არასწორი მომხმარებელი ან პაროლი';

export interface SessionTokens {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;            // კონტროლერი httpOnly cookie-ში სვამს, body-ში არ ბრუნდება
  refreshExpiresAt: Date;
  user: { id: string; name: string; role: Role; authProvider: 'local' | 'ldap'; mustChangePassword: boolean };
}

type UserRow = {
  id: string; first_name: string; last_name: string; role: string; is_active: boolean;
  auth_provider: 'local' | 'ldap'; password_hash: string | null; ldap_username: string | null;
  must_change_password: boolean; locked_until: Date | null;
};

@Injectable()
export class AuthService {
  private readonly env = loadEnv();

  constructor(
    @InjectDb() private readonly db: Database,
    private readonly jwt: JwtService,
    private readonly passwords: PasswordService,
    private readonly ldap: LdapService,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------ login
  async login(usernameRaw: string, password: string, ctx: AuditContext): Promise<SessionTokens> {
    const username = usernameRaw.trim().toLowerCase();
    const user = await this.db.selectFrom('users')
      .select(['id', 'first_name', 'last_name', 'role', 'is_active', 'auth_provider', 'password_hash',
        'ldap_username', 'must_change_password', 'locked_until'])
      .where((eb) => eb.or([eb('email', '=', username), eb('ldap_username', '=', username)]))
      .executeTakeFirst() as UserRow | undefined;

    const fail = async (reason: string, userId: string | null) => {
      await this.audit.log({ ...ctx, userId }, {
        action: 'LOGIN_FAILED', entityName: 'users', entityId: userId ?? `username:${username}`, newData: { reason },
      });
    };

    if (!user || !user.is_active) {
      await this.passwords.dummyVerify(password);
      await fail(user ? 'inactive' : 'unknown_user', user?.id ?? null);
      throw new UnauthorizedException(INVALID);
    }

    if (user.locked_until && user.locked_until > new Date()) {
      await fail('locked', user.id);
      const minutes = Math.ceil((user.locked_until.getTime() - Date.now()) / 60_000);
      throw new UnauthorizedException(`ანგარიში დროებით დაბლოკილია (${minutes} წთ). მიმართეთ ადმინისტრატორს.`);
    }

    const providerEnabled = user.auth_provider === 'local' ? this.env.AUTH_LOCAL_ENABLED : this.env.AUTH_LDAP_ENABLED;
    if (!providerEnabled) {
      await fail(`provider_disabled:${user.auth_provider}`, user.id);
      throw new UnauthorizedException(INVALID);
    }

    let ok = false;
    let reason = 'bad_password';
    if (user.auth_provider === 'local') {
      ok = await this.passwords.verify(user.password_hash!, password);
    } else {
      const r = await this.ldap.authenticate(user.ldap_username!, password);   // 503 თუ DC მიუწვდომელია
      ok = r === 'ok';
      reason = r;
    }

    if (!ok) {
      await this.db.updateTable('users')
        .set({
          failed_login_count: sql`failed_login_count + 1`,
          locked_until: sql`CASE WHEN failed_login_count + 1 >= ${this.env.LOGIN_MAX_FAILED}
                                 THEN now() + make_interval(mins => ${this.env.LOGIN_LOCK_MINUTES})
                                 ELSE locked_until END`,
        })
        .where('id', '=', user.id).execute();
      await fail(reason, user.id);
      throw new UnauthorizedException(reason === 'not_in_group' ? 'EMR-ზე წვდომა არ გაქვთ (დომენის ჯგუფი)' : INVALID);
    }

    // წარმატება
    const rehash = user.auth_provider === 'local' && this.passwords.needsRehash(user.password_hash!)
      ? await this.passwords.hash(password) : undefined;

    return this.db.transaction().execute(async (trx) => {
      await trx.updateTable('users')
        .set({ failed_login_count: 0, locked_until: null, last_login_at: sql`now()`, ...(rehash ? { password_hash: rehash } : {}) })
        .where('id', '=', user.id).execute();
      const tokens = await this.issueSession(trx, user, randomUUID(), ctx);
      await this.audit.log({ ...ctx, userId: user.id }, {
        action: 'LOGIN_SUCCESS', entityName: 'users', entityId: user.id, newData: { provider: user.auth_provider },
      }, trx);
      return tokens;
    });
  }

  // ---------------------------------------------------------------- refresh
  async refresh(refreshToken: string | undefined, ctx: AuditContext): Promise<SessionTokens> {
    if (!refreshToken) throw new UnauthorizedException('სესია არ არსებობს');
    const hash = sha256(refreshToken);

    // შენიშვნა: გაუქმების ჩანაწერები (reuse/disabled) უნდა შეინახოს — ამიტომ ტრანზაქციის შიგნით
    // exception-ს არ ვისვრით (rollback წაშლიდა მათ), არამედ შედეგს ვაბრუნებთ და გარეთ ვისვრით.
    const result = await this.db.transaction().execute(async (trx): Promise<SessionTokens | { error: string }> => {
      const s = await trx.selectFrom('auth_sessions').selectAll()
        .where('token_hash', '=', hash).forUpdate().executeTakeFirst();
      if (!s) return { error: 'სესია არ არსებობს' };

      if (s.revoked_at) {
        // ერთდროული refresh ორი ჩანართიდან — ჯაჭვს არ ვაუქმებთ
        if (s.revoke_reason === 'rotated' && Date.now() - s.revoked_at.getTime() < 10_000) return { error: 'refresh_race' };
        // უკვე გამოყენებული ტოკენის ხელახალი გამოყენება = სავარაუდო ქურდობა → ჯაჭვის სრული გაუქმება
        if (s.revoke_reason === 'rotated') {
          await this.revokeFamily(trx, s.family_id, 'reuse_detected');
          await this.audit.log({ ...ctx, userId: s.user_id }, {
            action: 'TOKEN_REUSE_DETECTED', entityName: 'auth_sessions', entityId: s.family_id,
          }, trx);
        }
        return { error: 'სესია გაუქმებულია' };
      }
      if (s.expires_at <= new Date()) return { error: 'სესიას ვადა გაუვიდა' };

      const user = await trx.selectFrom('users')
        .select(['id', 'first_name', 'last_name', 'role', 'is_active', 'auth_provider', 'password_hash',
          'ldap_username', 'must_change_password', 'locked_until'])
        .where('id', '=', s.user_id).executeTakeFirstOrThrow() as UserRow;

      const providerEnabled = user.auth_provider === 'local' ? this.env.AUTH_LOCAL_ENABLED : this.env.AUTH_LDAP_ENABLED;
      if (!user.is_active || !providerEnabled) {
        await this.revokeFamily(trx, s.family_id, 'user_disabled');
        return { error: 'ანგარიში გათიშულია' };
      }

      await trx.updateTable('auth_sessions').set({ revoked_at: sql`now()`, revoke_reason: 'rotated' })
        .where('id', '=', s.id).execute();
      return this.issueSession(trx, user, s.family_id, ctx);
    });

    if ('error' in result) throw new UnauthorizedException(result.error);
    return result;
  }

  // ----------------------------------------------------------------- logout
  async logout(refreshToken: string | undefined, ctx: AuditContext) {
    if (!refreshToken) return;
    const s = await this.db.selectFrom('auth_sessions').select(['family_id', 'user_id'])
      .where('token_hash', '=', sha256(refreshToken)).executeTakeFirst();
    if (!s) return;
    await this.db.transaction().execute(async (trx) => {
      await this.revokeFamily(trx, s.family_id, 'logout');
      await this.audit.log({ ...ctx, userId: s.user_id }, { action: 'LOGOUT', entityName: 'users', entityId: s.user_id }, trx);
    });
  }

  // -------------------------------------------------------- change password
  async changePassword(userId: string, current: string, next: string, ctx: AuditContext): Promise<SessionTokens> {
    const user = await this.db.selectFrom('users')
      .select(['id', 'first_name', 'last_name', 'role', 'is_active', 'auth_provider', 'password_hash',
        'ldap_username', 'must_change_password', 'locked_until'])
      .where('id', '=', userId).executeTakeFirstOrThrow() as UserRow;

    if (user.auth_provider !== 'local') throw new ForbiddenException('დომენის ანგარიშის პაროლი იცვლება Windows-ში');
    if (!(await this.passwords.verify(user.password_hash!, current))) throw new BadRequestException('მიმდინარე პაროლი არასწორია');
    if (current === next) throw new BadRequestException('ახალი პაროლი უნდა განსხვავდებოდეს მიმდინარისგან');
    this.passwords.assertPolicy(next);
    const hash = await this.passwords.hash(next);

    return this.db.transaction().execute(async (trx) => {
      await trx.updateTable('users')
        .set({ password_hash: hash, must_change_password: false, password_changed_at: sql`now()` })
        .where('id', '=', userId).execute();
      // ყველა სხვა მოწყობილობაზე სესიის დახურვა
      await trx.updateTable('auth_sessions').set({ revoked_at: sql`now()`, revoke_reason: 'password_changed' })
        .where('user_id', '=', userId).where('revoked_at', 'is', null).execute();
      await this.audit.log({ ...ctx, userId }, { action: 'PASSWORD_CHANGED', entityName: 'users', entityId: userId }, trx);
      return this.issueSession(trx, { ...user, must_change_password: false }, randomUUID(), ctx);
    });
  }

  async me(userId: string) {
    return this.db.selectFrom('users as u')
      .leftJoin('departments as d', 'd.id', 'u.department_id')
      .select(['u.id', 'u.first_name', 'u.last_name', 'u.email', 'u.role', 'u.specialty', 'u.auth_provider',
        'u.ldap_username', 'u.must_change_password', 'u.last_login_at', 'd.name as department_name'])
      .where('u.id', '=', userId).executeTakeFirstOrThrow();
  }

  // ---------------------------------------------------------------- helpers
  private async issueSession(trx: Transaction<DB>, user: UserRow, familyId: string, ctx: AuditContext): Promise<SessionTokens> {
    const refreshToken = randomBytes(32).toString('base64url');
    const refreshExpiresAt = new Date(Date.now() + this.env.REFRESH_TTL_HOURS * 3_600_000);
    await trx.insertInto('auth_sessions').values({
      user_id: user.id, family_id: familyId, token_hash: sha256(refreshToken), expires_at: refreshExpiresAt,
      ip_address: ctx.ip ?? null, user_agent: ctx.userAgent ?? null,
    }).execute();

    const name = `${user.first_name} ${user.last_name}`;
    const payload: AccessTokenPayload = { sub: user.id, role: user.role as Role, name, mcp: user.must_change_password };
    const accessToken = await this.jwt.signAsync(payload, { expiresIn: this.env.JWT_ACCESS_TTL_SEC, algorithm: 'HS256' });

    return {
      accessToken, expiresIn: this.env.JWT_ACCESS_TTL_SEC, refreshToken, refreshExpiresAt,
      user: { id: user.id, name, role: user.role as Role, authProvider: user.auth_provider, mustChangePassword: user.must_change_password },
    };
  }

  private async revokeFamily(trx: Transaction<DB>, familyId: string, reason: string) {
    await trx.updateTable('auth_sessions').set({ revoked_at: sql`now()`, revoke_reason: reason })
      .where('family_id', '=', familyId).where('revoked_at', 'is', null).execute();
  }
}
