import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { auditCtx } from '../audit/audit-context';
import { Roles } from '../auth/decorators';
import { CreatePatientDto, UpdatePatientDto } from './dto/create-patient.dto';
import { PatientsService } from './patients.service';

@Controller('patients')
export class PatientsController {
  constructor(private readonly patients: PatientsService) {}

  @Get() @Roles('admin', 'receptionist', 'doctor', 'nurse', 'billing', 'diagnostic')
  search(@Query('search') search = '') { return this.patients.search(search); }

  @Post() @Roles('admin', 'receptionist')
  create(@Body() dto: CreatePatientDto, @Req() req: Request) { return this.patients.create(dto, auditCtx(req)); }

  @Get('address-units')
  addressUnits() { return this.patients.addressUnits(); }

  @Get('address-units/:code/villages')
  villages(@Param('code') code: string, @Query('q') q = '') { return this.patients.villages(code, q); }

  @Patch(':id') @Roles('admin', 'receptionist')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePatientDto, @Req() req: Request) { return this.patients.update(id, dto, auditCtx(req)); }

  @Get(':id') @Roles('admin', 'receptionist', 'doctor', 'nurse', 'billing', 'diagnostic', 'radiographer', 'radiologist', 'endoscopist', 'endoscopy_nurse')
  findOne(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request) { return this.patients.findOne(id, auditCtx(req)); }
}
