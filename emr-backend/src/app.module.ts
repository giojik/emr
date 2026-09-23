import { Module } from '@nestjs/common';
import { AuditModule } from './audit/audit.service';
import { AuthModule } from './auth/auth.module';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { DepartmentsModule } from './departments/departments.module';
import { Icd10Module } from './icd10/icd10.module';
import { AppointmentsModule } from './appointments/appointments';
import { BillingModule } from './billing/billing';
import { EncountersModule } from './encounters/encounters.module';
import { DocumentsModule } from './documents/documents.module';
import { PatientsModule } from './patients/patients.module';
import { ClinicSettingsModule } from './settings/clinic-settings';
import { StorageModule } from './storage/storage.service';
import { TariffsModule } from './tariffs/tariffs';
import { UsersModule } from './users/users.module';

@Module({
  imports: [DatabaseModule, AuditModule, AuthModule, DepartmentsModule, UsersModule, Icd10Module, PatientsModule,
    TariffsModule, AppointmentsModule, EncountersModule, BillingModule,
    StorageModule, ClinicSettingsModule, DocumentsModule],
  controllers: [HealthController],
})
export class AppModule {}
