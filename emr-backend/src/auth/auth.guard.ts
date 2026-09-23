import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { InjectDb, type Database } from '../database/database.module';
import { ALLOW_PENDING_PASSWORD, IS_PUBLIC, ROLES_KEY } from './decorators';
import type { AuthUser, Role } from './roles';

export interface AccessTokenPayload { sub: string; role: Role; name: string; mcp: boolean }

/** მომხმარებლის მიმდინარე სტატუსის მოკლევადიანი cache (per-process) — DB-ზე დატვირთვის შესამცირებლად */
const STATUS_TTL_MS = 5_000;
const statusCache = new Map<string, { role: Role; active: boolean; at: number }>();
export const invalidateUserStatus = (userId: string) => statusCache.delete(userId);

/**
 * გლობალური guard: ყველა endpoint დახურულია, სანამ @Public() არ აქვს.
 * 1) Bearer JWT → req.user   2) დროებითი პაროლი → მხოლოდ /auth/*   3) @Roles() შემოწმება
 *
 * როლი და is_active მოწმდება ბაზიდან (და არა მხოლოდ JWT-იდან): გათიშვა ან როლის შეცვლა
 * მოქმედებს მაქსიმუმ STATUS_TTL_MS-ში და არა access token-ის ვადის (15 წთ) ბოლოს.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly jwt: JwtService,
              @InjectDb() private readonly db: Database) {}

  private async currentStatus(userId: string) {
    const hit = statusCache.get(userId);
    if (hit && Date.now() - hit.at < STATUS_TTL_MS) return hit;
    const row = await this.db.selectFrom('users').select(['role', 'is_active']).where('id', '=', userId).executeTakeFirst();
    const status = { role: (row?.role ?? 'nurse') as Role, active: row?.is_active ?? false, at: Date.now() };
    statusCache.set(userId, status);
    return status;
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const [scheme, token] = (req.headers.authorization ?? '').split(' ');
    if (scheme !== 'Bearer' || !token) throw new UnauthorizedException('ავტორიზაცია საჭიროა');

    let payload: AccessTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessTokenPayload>(token, { algorithms: ['HS256'] });
    } catch {
      throw new UnauthorizedException('ტოკენი არავალიდურია ან ვადაგასულია');
    }
    const status = await this.currentStatus(payload.sub);
    if (!status.active) throw new UnauthorizedException('ანგარიში გათიშულია');
    // role — ბაზიდან: როლის შეცვლა მაშინვე მოქმედებს
    req.user = { id: payload.sub, role: status.role, name: payload.name, mustChangePassword: payload.mcp };

    if (payload.mcp && !this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_PASSWORD, targets)) {
      throw new ForbiddenException({ code: 'PASSWORD_CHANGE_REQUIRED', message: 'საჭიროა დროებითი პაროლის შეცვლა' });
    }

    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, targets);
    if (roles && !roles.includes(status.role)) throw new ForbiddenException('ამ მოქმედების უფლება არ გაქვთ');
    return true;
  }
}
