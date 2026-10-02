import { Module } from '@nestjs/common';
import { AuditModule } from './audit/audit.service';
import { DatabaseModule } from './database/database.module';
import { LabAlertsService } from './lab-gateway/lab-alerts.service';
import { NotifyModule } from './notify/notify.service';
import { LabMailPoller, LabMailService } from './diagnostics/lab-mail';
import { StorageModule } from './storage/storage.service';
import { NotificationsService } from './notifications/notifications';
import { StockAlertsService } from './stock/stock-alerts';

/**
 * ფონური პროცესები: SSA სინქრონიზაცია, SMS, ფორმა 100-ის მასიური გენერაცია.
 * რიგები (BullMQ + Redis) აქ დაემატება — worker HTTP-ს არ ისმენს.
 */
@Module({ imports: [DatabaseModule, AuditModule, NotifyModule, StorageModule], providers: [LabAlertsService, LabMailService, LabMailPoller, NotificationsService, StockAlertsService] })
export class WorkerModule {}
