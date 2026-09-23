import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { ALLOW_PENDING_PASSWORD, IS_PUBLIC, ROLES_KEY } from './decorators';
import type { AuthUser, Role } from './roles';

export interface AccessTokenPayload { sub: string; role: Role; name: string; mcp: boolean }

/**
 * გლობალური guard: ყველა endpoint დახურულია, სანამ @Public() არ აქვს.
 * 1) Bearer JWT → req.user   2) დროებითი პაროლი → მხოლოდ /auth/*   3) @Roles() შემოწმება
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly jwt: JwtService) {}

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
    req.user = { id: payload.sub, role: payload.role, name: payload.name, mustChangePassword: payload.mcp };

    if (payload.mcp && !this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_PASSWORD, targets)) {
      throw new ForbiddenException({ code: 'PASSWORD_CHANGE_REQUIRED', message: 'საჭიროა დროებითი პაროლის შეცვლა' });
    }

    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, targets);
    if (roles && !roles.includes(payload.role)) throw new ForbiddenException('ამ მოქმედების უფლება არ გაქვთ');
    return true;
  }
}
