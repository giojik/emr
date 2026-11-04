import { BadRequestException, Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { IsIn, IsISO8601, IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';
import type { Request } from 'express';
import { auditCtx } from '../audit/audit-context';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/roles';
import { CreatePatientDto, UpdatePatientDto } from './dto/create-patient.dto';
import { PatientsService } from './patients.service';
import { RequireModule } from '../modules/module-guard';

/** 0087: უცნობის იდენტიფიკაცია */
class IdentifyDto {
  @IsString() @Length(1, 100) first_name: string; @IsString() @Length(1, 100) last_name: string;
  @IsOptional() @Matches(/^\d{11}$/, { message: 'პირადი ნომერი უნდა იყოს 11 ციფრი' }) personal_number?: string | null;
  @IsOptional() @IsString() @Length(3, 50) passport_number?: string | null;
  @IsOptional() @Matches(/^[A-Z]{3}$/) citizenship?: string;
  @IsISO8601({ strict: true }) @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'თარიღი: YYYY-MM-DD' }) birth_date: string;
  @IsIn(['male', 'female', 'other']) gender: 'male' | 'female' | 'other';
  @IsOptional() @IsString() @Length(5, 50) phone_number?: string | null;
}
class MergeDto { @IsUUID() target_id: string; @IsString() @Length(3, 500) reason: string }

@Controller('patients')
@RequireModule('mpi')
export class PatientsController {
  constructor(private readonly patients: PatientsService) {}

  @Get() @Roles('admin', 'receptionist', 'doctor', 'nurse', 'billing', 'diagnostic', 'manager', 'er_triage', 'er_doctor', 'er_manage')
  search(@Query('search') search = '') { return this.patients.search(search); }

  @Post() @Roles('admin', 'receptionist')
  create(@Body() dto: CreatePatientDto, @Req() req: Request) { return this.patients.create(dto, auditCtx(req)); }

  @Get('address-units')
  addressUnits() { return this.patients.addressUnits(); }

  @Get('address-units/:code/villages')
  villages(@Param('code') code: string, @Query('q') q = '') { return this.patients.villages(code, q); }

  @Patch(':id') @Roles('admin', 'receptionist')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePatientDto, @Req() req: Request) { return this.patients.update(id, dto, auditCtx(req)); }

  @Get(':id') @Roles('admin', 'receptionist', 'doctor', 'nurse', 'billing', 'diagnostic', 'radiographer', 'radiologist', 'endoscopist', 'endoscopy_nurse', 'manager', 'er_triage', 'er_doctor', 'er_manage')
  findOne(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request) { return this.patients.findOne(id, auditCtx(req)); }

  // 0087: უცნობი პაციენტი (ER) — ბირთვი (mpi): ER-ის გამორთვის შემდეგაც უნდა შეიძლებოდეს იდენტიფიკაცია / გაერთიანება
  @Post(':id/identify') @HttpCode(200) @Roles('admin', 'receptionist', 'er_triage', 'er_manage')
  identify(@Param('id', ParseUUIDPipe) id: string, @Body() dto: IdentifyDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.patients.identify(id, dto, u.id, auditCtx(req)); }

  @Get(':id/merge-preview') @Roles('admin', 'er_manage')
  mergePreview(@Param('id', ParseUUIDPipe) id: string, @Query('target_id') target: string) {
    if (!/^[0-9a-f-]{36}$/i.test(target ?? '')) throw new BadRequestException('target_id — სამიზნე პაციენტის id');
    return this.patients.mergePreview(id, target);
  }

  @Post(':id/merge') @HttpCode(200) @Roles('admin', 'er_manage')
  merge(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MergeDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.patients.merge(id, dto.target_id, dto.reason.trim(), u.id, auditCtx(req)); }
}
