import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Injectable, Module, NotFoundException,
  Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/roles';
import { dayRange } from '../common/day-range';
import { withPgErrors } from '../common/pg-errors';
import { loadEnv } from '../config/env';
import { InjectDb, type Database } from '../database/database.module';
import { EncounterCoreService } from '../encounters/encounter-core.service';
import { EncountersModule } from '../encounters/encounters.module';

const OVERLAP = { excl_appointments_doctor_overlap: 'ექიმს ამ დროს უკვე აქვს ჩაწერა' };

export class CreateAppointmentDto {
  @IsUUID() patient_id: string;
  @IsUUID() doctor_id: string;
  @IsOptional() @IsUUID() department_id?: string;
  @IsISO8601({ strict: true }) scheduled_start: string;           // 2026-09-24T10:00:00+04:00
  @IsOptional() @IsInt() @Min(5) @Max(240) duration_minutes?: number = 20;
  @IsOptional() @IsString() @MaxLength(1000) reason?: string;
}
export class UpdateAppointmentDto {
  @IsOptional() @IsISO8601({ strict: true }) scheduled_start?: string;
  @IsOptional() @IsInt() @Min(5) @Max(240) duration_minutes?: number;
  @IsOptional() @IsIn(['confirmed', 'cancelled', 'no_show']) status?: 'confirmed' | 'cancelled' | 'no_show';
  @IsOptional() @IsString() @MaxLength(1000) reason?: string;
}

@Injectable()
export class AppointmentsService {
  private readonly tz = loadEnv().CLINIC_TZ;
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService,
              private readonly core: EncounterCoreService) {}

  /** დღის განრიგი (კლინიკის დროის სარტყელით) */
  list(q: { doctorId?: string; date?: string; patientId?: string }) {
    if (!q.date && !q.patientId) throw new BadRequestException('მიუთითეთ date (YYYY-MM-DD) ან patient_id');
    let query = this.db.selectFrom('appointments as a')
      .innerJoin('patients as p', 'p.id', 'a.patient_id')
      .innerJoin('users as d', 'd.id', 'a.doctor_id')
      .select(['a.id', 'a.status', 'a.scheduled_start', 'a.scheduled_end', 'a.reason', 'a.encounter_id', 'a.department_id',
        'a.patient_id', 'p.first_name as patient_first_name', 'p.last_name as patient_last_name', 'p.personal_number', 'p.phone_number',
        'a.doctor_id', sql<string>`d.first_name || ' ' || d.last_name`.as('doctor_name')])
      .orderBy('a.scheduled_start');
    if (q.date) {
      const [from, to] = dayRange(q.date, this.tz);
      query = query.where('a.scheduled_start', '>=', from).where('a.scheduled_start', '<', to);
    }
    if (q.doctorId) query = query.where('a.doctor_id', '=', q.doctorId);
    if (q.patientId) query = query.where('a.patient_id', '=', q.patientId);
    return query.execute();
  }

  async create(dto: CreateAppointmentDto, user: AuthUser, ctx: AuditContext) {
    const start = new Date(dto.scheduled_start);
    const end = new Date(start.getTime() + (dto.duration_minutes ?? 20) * 60_000);
    return withPgErrors(() => this.db.transaction().execute(async (trx) => {
      const doctor = await trx.selectFrom('users as u').select(['u.is_active', 'u.department_id', sql<boolean>`EXISTS (SELECT 1 FROM user_capabilities c WHERE c.user_id = u.id AND 'doctor' = ANY(c.capabilities))`.as('is_doctor')])
        .where('u.id', '=', dto.doctor_id).executeTakeFirst();
      if (!doctor || !doctor.is_doctor || !doctor.is_active) throw new BadRequestException('ექიმი ვერ მოიძებნა ან აქტიური არ არის');
      const departmentId = dto.department_id ?? doctor.department_id;
      if (!departmentId) throw new BadRequestException('ექიმს განყოფილება არ აქვს — მიუთითეთ department_id');
      const a = await trx.insertInto('appointments').values({
        patient_id: dto.patient_id, doctor_id: dto.doctor_id, department_id: departmentId,
        scheduled_start: start, scheduled_end: end, reason: dto.reason ?? null, created_by: user.id,
      }).returningAll().executeTakeFirstOrThrow();
      await this.audit.log(ctx, { action: 'CREATE_APPOINTMENT', entityName: 'appointments', entityId: a.id, newData: a }, trx);
      return a;
    }), { ...OVERLAP, appointments_patient_id_fkey: 'პაციენტი ვერ მოიძებნა' });
  }

  async update(id: string, dto: UpdateAppointmentDto, ctx: AuditContext) {
    return withPgErrors(() => this.db.transaction().execute(async (trx) => {
      const old = await trx.selectFrom('appointments').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!old) throw new NotFoundException('ჩაწერა ვერ მოიძებნა');
      if (!['scheduled', 'confirmed'].includes(old.status)) throw new ConflictException(`სტატუსზე "${old.status}" ცვლილება დაუშვებელია`);
      const start = dto.scheduled_start ? new Date(dto.scheduled_start) : old.scheduled_start;
      const minutes = dto.duration_minutes ?? Math.round((old.scheduled_end.getTime() - old.scheduled_start.getTime()) / 60_000);
      const a = await trx.updateTable('appointments').set({
        ...(dto.status ? { status: dto.status } : {}),
        ...(dto.reason !== undefined ? { reason: dto.reason } : {}),
        scheduled_start: start, scheduled_end: new Date(start.getTime() + minutes * 60_000),
      }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await this.audit.log(ctx, { action: 'UPDATE_APPOINTMENT', entityName: 'appointments', entityId: id, oldData: old, newData: a }, trx);
      return a;
    }), OVERLAP);
  }

  /** check-in: ჩაწერა → ვიზიტი (planned) + ინვოისი ექიმის ტარიფით */
  async checkIn(id: string, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const a = await trx.selectFrom('appointments').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!a) throw new NotFoundException('ჩაწერა ვერ მოიძებნა');
      if (a.encounter_id || a.status === 'checked_in') throw new ConflictException('check-in უკვე შესრულებულია');
      if (!['scheduled', 'confirmed'].includes(a.status)) throw new ConflictException(`სტატუსზე "${a.status}" check-in დაუშვებელია`);
      const { encounter, invoice } = await this.core.open(trx, {
        patientId: a.patient_id, doctorId: a.doctor_id, departmentId: a.department_id, chiefComplaint: a.reason }, ctx);
      await trx.updateTable('appointments').set({ status: 'checked_in', encounter_id: encounter.id }).where('id', '=', id).execute();
      return { encounter_id: encounter.id, invoice_id: invoice.id, invoice_number: invoice.invoice_number };
    });
  }
}

@Controller('appointments')
export class AppointmentsController {
  constructor(private readonly appointments: AppointmentsService) {}

  @Get() @Roles('admin', 'receptionist', 'doctor', 'nurse', 'billing')
  list(@Query('doctor_id') doctorId?: string, @Query('date') date?: string, @Query('patient_id') patientId?: string) {
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BadRequestException('date: YYYY-MM-DD');
    return this.appointments.list({ doctorId, date, patientId });
  }

  @Post() @Roles('admin', 'receptionist')
  create(@Body() dto: CreateAppointmentDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.appointments.create(dto, user, auditCtx(req));
  }

  @Patch(':id') @Roles('admin', 'receptionist')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateAppointmentDto, @Req() req: Request) {
    return this.appointments.update(id, dto, auditCtx(req));
  }

  @Post(':id/check-in') @HttpCode(200) @Roles('admin', 'receptionist')
  checkIn(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request) { return this.appointments.checkIn(id, auditCtx(req)); }
}

@Module({ imports: [EncountersModule], controllers: [AppointmentsController], providers: [AppointmentsService] })
export class AppointmentsModule {}
