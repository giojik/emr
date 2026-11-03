import { Body, Controller, Delete, Get, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/roles';
import { RequireModule } from '../modules/module-guard';
import { LicenseService } from './license.service';

/**
 * ლიცენზია (0085): სტატუსი (ყველას — ბანერი), ატვირთვა / შემოწმება / ისტორია (admin), მოხსნა (მხოლოდ dev / e2e).
 * ფაილი — JSON ტანად ({ license: {...} }).
 */
@Controller('license')
@RequireModule('core')
export class LicenseController {
  constructor(private readonly s: LicenseService) {}

  @Get('status') async status(@CurrentUser() u: AuthUser) {
    const st = await this.s.status();
    if (u.caps.includes('admin')) return st;
    // არა-admin: მხოლოდ ბანერისთვის საჭირო ველები
    return { mode: st.mode, phase: st.phase, banner: st.banner, expires: st.expires, days_left: st.days_left, grace_until: st.grace_until };
  }
  @Get() @Roles('admin') async full() { return { status: await this.s.status(), history: await this.s.history() }; }
  @Post('verify') @HttpCode(200) @Roles('admin') async verify(@Body() b: { license?: unknown }) {
    const f = await this.s.check(b?.license);
    return { ok: true, clinic: f.payload.clinic, modules: f.payload.modules, issued: f.payload.issued, expires: f.payload.expires, max_users: f.payload.max_users ?? null, kid: f.kid };
  }
  @Post() @HttpCode(200) @Roles('admin') upload(@Body() b: { license?: unknown }, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.upload(b?.license, u, r); }
  @Delete() @Roles('admin') remove(@CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.remove(u, r); }
}
