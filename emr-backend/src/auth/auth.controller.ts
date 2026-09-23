import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { CookieOptions, Request, Response } from 'express';
import { auditCtx } from '../audit/audit-context';
import { loadEnv } from '../config/env';
import { AuthService, type SessionTokens } from './auth.service';
import { AllowPendingPasswordChange, CurrentUser, Public } from './decorators';
import { ChangePasswordDto, LoginDto } from './dto/auth.dto';
import type { AuthUser } from './roles';

const COOKIE = 'emr_rt';

@Controller('auth')
export class AuthController {
  private readonly env = loadEnv();
  constructor(private readonly auth: AuthService) {}

  private cookieOpts(expires?: Date): CookieOptions {
    // refresh-ტოკენი: JS-ისთვის მიუწვდომელი, მხოლოდ /api/auth-ზე იგზავნება
    return { httpOnly: true, secure: this.env.COOKIE_SECURE, sameSite: 'strict', path: '/api/auth', expires };
  }

  private respond(res: Response, t: SessionTokens) {
    res.cookie(COOKIE, t.refreshToken, this.cookieOpts(t.refreshExpiresAt));
    return { accessToken: t.accessToken, expiresIn: t.expiresIn, user: t.user };
  }

  @Public() @Post('login') @HttpCode(200)
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.respond(res, await this.auth.login(dto.username, dto.password, auditCtx(req)));
  }

  @Public() @Post('refresh') @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.respond(res, await this.auth.refresh(req.cookies?.[COOKIE], auditCtx(req)));
  }

  @Public() @Post('logout') @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.cookies?.[COOKIE], auditCtx(req));
    res.clearCookie(COOKIE, this.cookieOpts());
  }

  @Get('me') @AllowPendingPasswordChange()
  me(@CurrentUser() user: AuthUser) { return this.auth.me(user.id); }

  @Post('change-password') @HttpCode(200) @AllowPendingPasswordChange()
  async changePassword(@CurrentUser() user: AuthUser, @Body() dto: ChangePasswordDto,
                       @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.respond(res, await this.auth.changePassword(user.id, dto.currentPassword, dto.newPassword, auditCtx(req)));
  }
}
