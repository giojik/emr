import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { sql } from 'kysely';
import { loadEnv } from './config/env';
import { KYSELY, type Database } from './database/database.module';
import { LabAlertsService } from './lab-gateway/lab-alerts.service';
import { WorkerModule } from './worker.module';

const HEARTBEAT_MS = 60_000;

async function bootstrap() {
  loadEnv();
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  const db = app.get<Database>(KYSELY);
  const log = new Logger('Worker');

  // დროებითი heartbeat: ინარჩუნებს პროცესს და ამოწმებს DB კავშირს.
  // BullMQ რიგების დამატების შემდეგ პროცესს თავად რიგები შეინარჩუნებს და ეს წაიშლება.
  const timer = setInterval(() => {
    sql`SELECT 1`.execute(db).catch((e) => log.error(`DB unreachable: ${(e as Error).message}`));
  }, HEARTBEAT_MS);
  // emr-lab-gateway-ის პულსი: გაჩერდა → გაფრთხილება (SMS + ელ-ფოსტა); აღდგა → შეტყობინება
  const alerts = app.get(LabAlertsService);
  const gwTimer = setInterval(() => void alerts.evaluateGateway().catch((e) => log.error(`gateway-ის შემოწმება: ${(e as Error).message}`)), 60_000);
  process.once('SIGTERM', () => { clearInterval(timer); clearInterval(gwTimer); });
  process.once('SIGINT', () => { clearInterval(timer); clearInterval(gwTimer); });

  log.log('EMR worker started (queues: none yet)');
}
bootstrap();
