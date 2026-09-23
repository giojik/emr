import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { AuditContext } from '../audit/audit.service';
import { CreatePatientDto } from './dto/create-patient.dto';
import { PatientsService } from './patients.service';

// TODO(auth): userId JWT-იდან, როცა ავტორიზაციის მოდული დაემატება
const auditCtx = (req: Request): AuditContext => ({ userId: null, ip: req.ip, userAgent: req.get('user-agent') });

@Controller('patients')
export class PatientsController {
  constructor(private readonly patients: PatientsService) {}

  @Get()
  search(@Query('search') search = '') { return this.patients.search(search); }

  @Post()
  create(@Body() dto: CreatePatientDto, @Req() req: Request) { return this.patients.create(dto, auditCtx(req)); }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request) { return this.patients.findOne(id, auditCtx(req)); }
}
