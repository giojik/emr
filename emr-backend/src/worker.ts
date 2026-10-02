import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { sql } from 'kysely';
import { loadEnv } from './config/env';
import { KYSELY, type Database } from './database/database.module';
import { LabMailPoller } from './diagnostics/lab-mail';
import { LabAlertsService } from './lab-gateway/lab-alerts.service';
import { StockAlertsService } from './stock/stock-alerts';
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
  // გარე ლაბორატორიის პასუხები ელ-ფოსტით (IMAP) — თუ კონფიგურირებულია
  app.get(LabMailPoller).start();
  const gwTimer = setInterval(() => void alerts.evaluateGateway().catch((e) => log.error(`gateway-ის შემოწმება: ${(e as Error).message}`)), 60_000);
  // საწყობი: ვადები და მინიმუმი — დღეში ერთხელ (stock_settings.alert_hour-ის შემდეგ, კლინიკის დროით)
  const stock = app.get(StockAlertsService);
  const stockTick = () => void stock.tick().catch((e) => log.error(`საწყობის შემოწმება: ${(e as Error).message}`));
  const stockTimer = setInterval(stockTick, 5 * 60_000); setTimeout(stockTick, 30_000);
  process.once('SIGTERM', () => { clearInterval(timer); clearInterval(gwTimer); clearInterval(stockTimer); });
  process.once('SIGINT', () => { clearInterval(timer); clearInterval(gwTimer); clearInterval(stockTimer); });

  log.log('EMR worker started (queues: none yet)');
}
bootstrap();
