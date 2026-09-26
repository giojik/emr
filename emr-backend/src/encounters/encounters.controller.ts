import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { auditCtx } from '../audit/audit-context';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/roles';
import { ClinicalService } from './clinical.service';
import { DiagnosisDto, OverrideDto, PayInitialDto, PrescriptionDto, ReferralDto, UpdateClinicalDto, UpdateReferralDto,
  VitalsDto, WalkInDto } from './dto/encounters.dto';
import { EncountersService } from './encounters.service';

const CLINICAL_READ = ['admin', 'doctor', 'nurse', 'receptionist', 'billing', 'diagnostic', 'manager', 'viewer'] as const;

@Controller('encounters')
export class EncountersController {
  constructor(private readonly encounters: EncountersService, private readonly clinical: ClinicalService) {}

  @Get() @Roles(...CLINICAL_READ)
  list(@Query('status') status?: string, @Query('doctor_id') doctorId?: string, @Query('date') date?: string, @Query('patient_id') patientId?: string) {
    return this.encounters.list({ status: status?.split(',').filter(Boolean), doctorId, date, patientId });
  }

  @Get(':id') @Roles('admin', 'doctor', 'nurse', 'billing', 'receptionist')
  detail(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request) { return this.encounters.detail(id, auditCtx(req)); }

  @Post('walk-in') @Roles('admin', 'receptionist')
  walkIn(@Body() dto: WalkInDto, @Req() req: Request) { return this.encounters.walkIn(dto, auditCtx(req)); }

  @Patch(':id') @Roles('admin', 'doctor')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateClinicalDto, @CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.encounters.updateClinical(id, dto, u, auditCtx(req));
  }

  @Post(':id/pay-initial') @HttpCode(200) @Roles('admin', 'receptionist', 'billing')
  payInitial(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PayInitialDto, @CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.encounters.payInitial(id, dto, u, auditCtx(req));
  }

  @Post(':id/payment-override') @HttpCode(200) @Roles('admin', 'doctor')
  override(@Param('id', ParseUUIDPipe) id: string, @Body() dto: OverrideDto, @CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.encounters.paymentOverride(id, dto.reason, u, auditCtx(req));
  }

  @Post(':id/cancel') @HttpCode(200) @Roles('admin', 'receptionist')
  cancel(@Param('id', ParseUUIDPipe) id: string, @Body() dto: OverrideDto, @Req() req: Request) {
    return this.encounters.cancel(id, dto.reason, auditCtx(req));
  }

  @Post(':id/discharge') @HttpCode(200) @Roles('admin', 'doctor')
  discharge(@Param('id', ParseUUIDPipe) id: string, @Query('force') force: string | undefined, @CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.encounters.discharge(id, force === 'true', u, auditCtx(req));
  }

  // --- კლინიკური ქვე-რესურსები
  @Post(':id/vitals') @Roles('admin', 'doctor', 'nurse')
  vitals(@Param('id', ParseUUIDPipe) id: string, @Body() dto: VitalsDto, @CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.clinical.addVitals(id, dto, u, auditCtx(req));
  }

  @Post(':id/diagnoses') @Roles('admin', 'doctor')
  addDx(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DiagnosisDto, @CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.clinical.addDiagnosis(id, dto, u, auditCtx(req));
  }

  @Delete(':id/diagnoses/:dxId') @HttpCode(204) @Roles('admin', 'doctor')
  removeDx(@Param('id', ParseUUIDPipe) id: string, @Param('dxId', ParseUUIDPipe) dxId: string, @CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.clinical.removeDiagnosis(id, dxId, u, auditCtx(req));
  }

  @Post(':id/prescriptions') @Roles('admin', 'doctor')
  addRx(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PrescriptionDto, @CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.clinical.addPrescription(id, dto, u, auditCtx(req));
  }

  @Delete(':id/prescriptions/:rxId') @HttpCode(204) @Roles('admin', 'doctor')
  removeRx(@Param('id', ParseUUIDPipe) id: string, @Param('rxId', ParseUUIDPipe) rxId: string, @CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.clinical.removePrescription(id, rxId, u, auditCtx(req));
  }

  @Post(':id/referrals') @Roles('admin', 'doctor')
  addReferral(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReferralDto, @CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.clinical.addReferral(id, dto, u, auditCtx(req));
  }
}

@Controller('referrals')
export class ReferralsController {
  constructor(private readonly clinical: ClinicalService) {}

  @Get() @Roles('admin', 'diagnostic', 'doctor')
  worklist(@Query('status') status = 'requested,in_progress', @Query('department_id') departmentId?: string,
           @Query('type') type?: string, @Query('completed_date') completedDate?: string) {
    const range = completedDate && /^\d{4}-\d{2}-\d{2}$/.test(completedDate)
      ? { completedFrom: new Date(`${completedDate}T00:00:00+04:00`), completedTo: new Date(new Date(`${completedDate}T00:00:00+04:00`).getTime() + 86_400_000) } : {};
    return this.clinical.worklist({ statuses: status.split(',').filter(Boolean), departmentId, type, ...range });
  }

  @Patch(':id') @Roles('admin', 'diagnostic', 'doctor')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateReferralDto, @CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.clinical.updateReferral(id, dto, u, auditCtx(req));
  }
}
