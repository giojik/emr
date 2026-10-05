import 'reflect-metadata';
import { Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AuditModule } from './audit/audit.service';
import { loadEnv } from './config/env';
import { DatabaseModule } from './database/database.module';
import { DiagnosticsModule } from './diagnostics/diagnostics.controller';
import { GatewayManager } from './lab-gateway/gateway.manager';
import { LabAlertsService } from './lab-gateway/lab-alerts.service';
import { NotificationsModule } from './notifications/notifications';
import { NotifyModule } from './notify/notify.service';
import { StorageModule } from './storage/storage.service';

/**
 * emr-lab-gateway — ანალიზატორების მიერთება (ASTM / HL7), ცალკე პროცესი/კონტეინერი.
 * კონფიგურაცია ბაზიდან (lab_instruments), ცვლილებები 5 წამში მოქმედებს; HTTP-ს არ ისმენს.
 * NotificationsModule — DiagnosticsModule-ის LabNotifyService-ს სჭირდება (0029-დან; მის გარეშე პროცესი არ ეშვებოდა).
 */
@Module({ imports: [DatabaseModule, AuditModule, NotificationsModule, StorageModule, NotifyModule, DiagnosticsModule], providers: [GatewayManager, LabAlertsService] })
class LabGatewayModule {}

async function bootstrap() {
  loadEnv();
  const app = await NestFactory.createApplicationContext(LabGatewayModule, { logger: ['log', 'warn', 'error'] });
  app.enableShutdownHooks();
  await app.get(GatewayManager).start();
}
bootstrap().catch((e) => { new Logger('LabGateway').error(e); process.exit(1); });
