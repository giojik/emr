import { AssetsModule } from './assets/assets';
import { CssdModule } from './cssd/cssd';
import { InpatientModule } from './inpatient/inpatient';
import { TemplatesModule } from './templates/templates';
import { EpicrisisModule } from './inpatient/epicrisis';
import { TransfersModule } from './inpatient/transfers';
import { DischargeModule } from './inpatient/discharge';
import { OrdersModule } from './inpatient/orders';
import { MarModule } from './inpatient/mar';
import { NursingModule } from './inpatient/nursing';
import { IcuModule } from './inpatient/icu';
import { OrAdminModule } from './or/or-admin';
import { OrModule } from './or/or.module';
import { NotesModule } from './inpatient/notes';
import { IpdBillingModule } from './inpatient/ipd-billing';
import { BillingConfigModule } from './billing/billing-config';
import { ModulesModule } from './modules/modules';
import { NotificationsModule } from './notifications/notifications';
import { Module } from '@nestjs/common';
import { AuditModule } from './audit/audit.service';
import { AuthModule } from './auth/auth.module';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { DepartmentsModule } from './departments/departments.module';
import { Icd10Module } from './icd10/icd10.module';
import { AllergiesModule } from './allergies/allergies';
import { AppointmentsModule } from './appointments/appointments';
import { BillingModule } from './billing/billing';
import { EncountersModule } from './encounters/encounters.module';
import { DocumentsModule } from './documents/documents.module';
import { PatientsModule } from './patients/patients.module';
import { ReportsModule } from './reports/reports';
import { ConsentsModule } from './consents/consents';
import { DiagnosticsModule } from './diagnostics/diagnostics.controller';
import { PatientFilesModule } from './patient-files/patient-files';
import { ClinicSettingsModule } from './settings/clinic-settings';
import { StorageModule } from './storage/storage.service';
import { TariffsModule } from './tariffs/tariffs';
import { UsersModule } from './users/users.module';
import { RolesModule } from './roles/roles';
import { ManagementReportsModule } from './reports/management';
import { StockModule } from './stock/stock.module';
import { ProcurementModule } from './procurement/procurement.module';
import { FinanceModule } from './finance/finance.module';
import { DrgModule } from './drg/drg.module';
import { ScrubModule } from './scrub/scrub';
import { ConfigPackageModule } from './config-package/config-package';
import { RptCommonModule } from './reporting/reporting-common';
import { ReportingModule } from './reporting/reporting.module';
import { APP_FILTER } from '@nestjs/core';
import { PgLockFilter } from './common/pg-lock.filter';

@Module({
  imports: [DatabaseModule, AuditModule, NotificationsModule, ModulesModule, AssetsModule, CssdModule, InpatientModule, TemplatesModule, EpicrisisModule, TransfersModule, DischargeModule, OrdersModule, MarModule, NursingModule, IcuModule, OrAdminModule, OrModule, NotesModule, IpdBillingModule, BillingConfigModule, AuthModule, DepartmentsModule, UsersModule, RolesModule, ManagementReportsModule, Icd10Module, PatientsModule,
    TariffsModule, AppointmentsModule, EncountersModule, BillingModule,
    StorageModule, ClinicSettingsModule, DocumentsModule, AllergiesModule, ReportsModule, PatientFilesModule, ConsentsModule, DiagnosticsModule, StockModule, ProcurementModule, FinanceModule, DrgModule, ScrubModule, ConfigPackageModule, RptCommonModule, ReportingModule],
  controllers: [HealthController],
  providers: [{ provide: APP_FILTER, useClass: PgLockFilter }],
})
export class AppModule {}
