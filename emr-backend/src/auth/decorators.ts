import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthUser, Role } from './roles';

export const IS_PUBLIC = 'auth:public';
export const ROLES_KEY = 'auth:roles';
export const ALLOW_PENDING_PASSWORD = 'auth:allowPendingPassword';

/** ავტორიზაციის გარეშე (login, health, QR ვერიფიკაცია) */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** მხოლოდ ჩამოთვლილი როლებისთვის. `admin`-ს ავტომატურად არ ემატება — ცხადად უნდა ჩაიწეროს. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

/** ხელმისაწვდომია მაშინაც, როცა მომხმარებელმა დროებითი პაროლი ჯერ არ შეცვალა */
export const AllowPendingPasswordChange = () => SetMetadata(ALLOW_PENDING_PASSWORD, true);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest<Request & { user: AuthUser }>().user;
});
