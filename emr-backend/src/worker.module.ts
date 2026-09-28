import { Module } from '@nestjs/common';
import { AuditModule } from './audit/audit.service';
import { DatabaseModule } from './database/database.module';
import { LabAlertsService } from './lab-gateway/lab-alerts.service';
import { NotifyModule } from './notify/notify.service';

/**
 * ფონური პროცესები: SSA სინქრონიზაცია, SMS, ფორმა 100-ის მასიური გენერაცია.
 * რიგები (BullMQ + Redis) აქ დაემატება — worker HTTP-ს არ ისმენს.
 */
@Module({ imports: [DatabaseModule, AuditModule, NotifyModule], providers: [LabAlertsService] })
export class WorkerModule {}
