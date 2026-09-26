import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { auditCtx } from '../audit/audit-context';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/roles';
import { CreateUserDto, ListUsersQuery, UpdateUserDto } from './dto/users.dto';
import { UsersService } from './users.service';

/**
 * მომხმარებლები: admin — ყველაფერი; hr — ყველა, ადმინისტრატორის უფლების მქონეების გარდა;
 * manager — მხოლოდ საკუთარი განყოფილება (ნახვა, განბლოკვა, პაროლი, გათიშვა/ჩართვა, სესიები). შემოწმება — UsersService.scope()
 */
@Controller('users')
@Roles('admin', 'hr', 'manager')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get() async list(@Query() q: ListUsersQuery, @CurrentUser() me: AuthUser) { return this.users.list(q, await this.users.scope(me)); }

  @Get(':id') async get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() me: AuthUser) {
    await this.users.assertCanManage(me, id, 'view'); return this.users.get(id);
  }

  @Post() @Roles('admin', 'hr')
  async create(@Body() dto: CreateUserDto, @CurrentUser() me: AuthUser, @Req() req: Request) {
    await this.users.assertCanAssign(me, [...(dto.role ? [dto.role] : []), ...(dto.roles ?? [])]);
    return this.users.create(dto, auditCtx(req));
  }

  @Patch(':id') @Roles('admin', 'hr')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateUserDto, @CurrentUser() me: AuthUser, @Req() req: Request) {
    await this.users.assertCanManage(me, id, 'edit');
    if (dto.role !== undefined || dto.roles !== undefined) await this.users.assertCanAssign(me, [...(dto.role ? [dto.role] : []), ...(dto.roles ?? [])]);
    return this.users.update(id, dto, me, auditCtx(req));
  }

  @Post(':id/disable') @HttpCode(200)
  async disable(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() me: AuthUser, @Req() req: Request) {
    await this.users.assertCanManage(me, id, 'edit'); return this.users.setActive(id, false, me, auditCtx(req));
  }

  @Post(':id/enable') @HttpCode(200)
  async enable(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() me: AuthUser, @Req() req: Request) {
    await this.users.assertCanManage(me, id, 'edit'); return this.users.setActive(id, true, me, auditCtx(req));
  }

  @Post(':id/reset-password') @HttpCode(200)
  async resetPassword(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() me: AuthUser, @Req() req: Request) {
    await this.users.assertCanManage(me, id, 'edit'); return this.users.resetPassword(id, auditCtx(req));
  }

  @Post(':id/unlock') @HttpCode(200)
  async unlock(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() me: AuthUser, @Req() req: Request) {
    await this.users.assertCanManage(me, id, 'edit'); return this.users.unlock(id, auditCtx(req));
  }

  @Get(':id/sessions') async sessions(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() me: AuthUser) {
    await this.users.assertCanManage(me, id, 'view'); return this.users.sessions(id);
  }

  @Delete(':id/sessions')
  async revokeSessions(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() me: AuthUser, @Req() req: Request) {
    await this.users.assertCanManage(me, id, 'edit'); return this.users.revokeSessions(id, auditCtx(req));
  }
}

/** ექიმების ცნობარი — განრიგისა და ჩაწერისთვის (ყველა ავტორიზებული მომხმარებელი) */
@Controller('doctors')
export class DoctorsController {
  constructor(private readonly users: UsersService) {}
  @Get() list() { return this.users.doctors(); }
}
