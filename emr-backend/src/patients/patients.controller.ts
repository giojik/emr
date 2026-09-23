import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { auditCtx } from '../audit/audit-context';
import { Roles } from '../auth/decorators';
import { CreatePatientDto } from './dto/create-patient.dto';
import { PatientsService } from './patients.service';

@Controller('patients')
export class PatientsController {
  constructor(private readonly patients: PatientsService) {}

  @Get() @Roles('admin', 'receptionist', 'doctor', 'nurse', 'billing', 'diagnostic')
  search(@Query('search') search = '') { return this.patients.search(search); }

  @Post() @Roles('admin', 'receptionist')
  create(@Body() dto: CreatePatientDto, @Req() req: Request) { return this.patients.create(dto, auditCtx(req)); }

  @Get(':id') @Roles('admin', 'receptionist', 'doctor', 'nurse', 'billing', 'diagnostic')
  findOne(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request) { return this.patients.findOne(id, auditCtx(req)); }
}
