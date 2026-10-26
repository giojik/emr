import { Module } from '@nestjs/common';
import { AuditModule } from './audit/audit.service';
import { DatabaseModule } from './database/database.module';
import { LabAlertsService } from './lab-gateway/lab-alerts.service';
import { NotifyModule } from './notify/notify.service';
import { LabMailPoller, LabMailService } from './diagnostics/lab-mail';
import { StorageModule } from './storage/storage.service';
import { NotificationsModule } from './notifications/notifications';
import { StockAlertsService } from './stock/stock-alerts';
import { InpatientRemindersService } from './inpatient/inpatient-reminders';
import { TariffTickService } from './tariffs/tariff-tick';
import { RptCommonModule } from './reporting/reporting-common';
import { ReportingModule } from './reporting/reporting.module';
import { ModulesModule } from './modules/modules';
import { QualityModule } from './quality/quality.module';
import { IpcModule } from './ipc/ipc.module';
import { BmePmJobsService } from './bme/bme-pm-jobs';
import { BmeRepairJobsService } from './bme/bme-repair-jobs';

/**
 * ფონური პროცესები: SSA სინქრონიზაცია, SMS, ფორმა 100-ის მასიური გენერაცია.
 * რიგები (BullMQ + Redis) აქ დაემატება — worker HTTP-ს არ ისმენს.
 */
@Module({ imports: [DatabaseModule, AuditModule, NotifyModule, StorageModule, RptCommonModule, NotificationsModule, ReportingModule, ModulesModule, QualityModule, IpcModule],
  providers: [LabAlertsService, LabMailService, LabMailPoller, StockAlertsService, InpatientRemindersService, TariffTickService, BmePmJobsService, BmeRepairJobsService] })
export class WorkerModule {}
