import { Body, Controller, Get, Param, ParseBoolPipe, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { auditCtx } from '../audit/audit-context';
import { Roles } from '../auth/decorators';
import { CreateDepartmentDto, UpdateDepartmentDto } from './departments.dto';
import { DepartmentsService } from './departments.service';

@Controller('departments')
export class DepartmentsController {
  constructor(private readonly departments: DepartmentsService) {}

  /** ნებისმიერი ავტორიზებული მომხმარებლისთვის (dropdown-ები, ფილტრები) */
  @Get()
  list(@Query('include_inactive', new ParseBoolPipe({ optional: true })) includeInactive = false) {
    return this.departments.list(includeInactive);
  }

  @Post() @Roles('admin')
  create(@Body() dto: CreateDepartmentDto, @Req() req: Request) { return this.departments.create(dto, auditCtx(req)); }

  @Patch(':id') @Roles('admin')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDepartmentDto, @Req() req: Request) {
    return this.departments.update(id, dto, auditCtx(req));
  }
}
