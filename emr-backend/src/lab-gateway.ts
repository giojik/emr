import 'reflect-metadata';
import { Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AuditModule } from './audit/audit.service';
import { loadEnv } from './config/env';
import { DatabaseModule } from './database/database.module';
import { DiagnosticsModule } from './diagnostics/diagnostics.controller';
import { GatewayManager } from './lab-gateway/gateway.manager';
import { StorageModule } from './storage/storage.service';

/**
 * emr-lab-gateway — ანალიზატორების მიერთება (ASTM / HL7), ცალკე პროცესი/კონტეინერი.
 * კონფიგურაცია ბაზიდან (lab_instruments), ცვლილებები 5 წამში მოქმედებს; HTTP-ს არ ისმენს.
 */
@Module({ imports: [DatabaseModule, AuditModule, StorageModule, DiagnosticsModule], providers: [GatewayManager] })
class LabGatewayModule {}

async function bootstrap() {
  loadEnv();
  const app = await NestFactory.createApplicationContext(LabGatewayModule, { logger: ['log', 'warn', 'error'] });
  app.enableShutdownHooks();
  await app.get(GatewayManager).start();
}
bootstrap().catch((e) => { new Logger('LabGateway').error(e); process.exit(1); });
