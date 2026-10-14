import { Module } from '@nestjs/common';
import { AuditModule } from './audit/audit.service';
import { DatabaseModule } from './database/database.module';
import { LabAlertsService } from './lab-gateway/lab-alerts.service';
import { NotifyModule } from './notify/notify.service';
import { LabMailPoller, LabMailService } from './diagnostics/lab-mail';
import { StorageModule } from './storage/storage.service';
import { NotificationsService } from './notifications/notifications';
import { StockAlertsService } from './stock/stock-alerts';
import { InpatientRemindersService } from './inpatient/inpatient-reminders';
import { TariffTickService } from './tariffs/tariff-tick';
import { RptCommonModule } from './reporting/reporting-common';
import { RptRefreshService } from './reporting/reporting-refresh';

/**
 * ფონური პროცესები: SSA სინქრონიზაცია, SMS, ფორმა 100-ის მასიური გენერაცია.
 * რიგები (BullMQ + Redis) აქ დაემატება — worker HTTP-ს არ ისმენს.
 */
@Module({ imports: [DatabaseModule, AuditModule, NotifyModule, StorageModule, RptCommonModule], providers: [LabAlertsService, LabMailService, LabMailPoller, NotificationsService, StockAlertsService, InpatientRemindersService, TariffTickService, RptRefreshService] })
export class WorkerModule {}
