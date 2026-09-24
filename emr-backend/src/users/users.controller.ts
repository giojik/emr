import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { auditCtx } from '../audit/audit-context';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/roles';
import { CreateUserDto, ListUsersQuery, UpdateUserDto } from './dto/users.dto';
import { UsersService } from './users.service';

@Controller('users')
@Roles('admin')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get() list(@Query() q: ListUsersQuery) { return this.users.list(q); }

  @Get(':id') get(@Param('id', ParseUUIDPipe) id: string) { return this.users.get(id); }

  @Post() create(@Body() dto: CreateUserDto, @Req() req: Request) { return this.users.create(dto, auditCtx(req)); }

  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateUserDto, @CurrentUser() me: AuthUser, @Req() req: Request) {
    return this.users.update(id, dto, me, auditCtx(req));
  }

  @Post(':id/disable') @HttpCode(200)
  disable(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() me: AuthUser, @Req() req: Request) {
    return this.users.setActive(id, false, me, auditCtx(req));
  }

  @Post(':id/enable') @HttpCode(200)
  enable(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() me: AuthUser, @Req() req: Request) {
    return this.users.setActive(id, true, me, auditCtx(req));
  }

  @Post(':id/reset-password') @HttpCode(200)
  resetPassword(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request) { return this.users.resetPassword(id, auditCtx(req)); }

  @Post(':id/unlock') @HttpCode(200)
  unlock(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request) { return this.users.unlock(id, auditCtx(req)); }

  @Get(':id/sessions') sessions(@Param('id', ParseUUIDPipe) id: string) { return this.users.sessions(id); }

  @Delete(':id/sessions')
  revokeSessions(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request) { return this.users.revokeSessions(id, auditCtx(req)); }
}

/** ექიმების ცნობარი — განრიგისა და ჩაწერისთვის (ყველა ავტორიზებული მომხმარებელი) */
@Controller('doctors')
export class DoctorsController {
  constructor(private readonly users: UsersService) {}
  @Get() list() { return this.users.doctors(); }
}
