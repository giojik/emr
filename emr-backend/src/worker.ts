import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { sql } from 'kysely';
import { loadEnv } from './config/env';
import { KYSELY, type Database } from './database/database.module';
import { LabMailPoller } from './diagnostics/lab-mail';
import { LabAlertsService } from './lab-gateway/lab-alerts.service';
import { StockAlertsService } from './stock/stock-alerts';
import { InpatientRemindersService } from './inpatient/inpatient-reminders';
import { TariffTickService } from './tariffs/tariff-tick';
import { RptRefreshService } from './reporting/reporting-refresh';
import { RptJobsService } from './reporting/reporting-jobs';
import { WorkerModule } from './worker.module';
import { QmJobsService } from './quality/quality-jobs';
import { IpcJobsService } from './ipc/ipc-jobs';
import { BmePmJobsService } from './bme/bme-pm-jobs';

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
  // სტაციონარი: გეგმიური ჰოსპიტალიზაციის SMS შეხსენება (წინა დღეს, 10:00-დან) — ყოველ 10 წუთში
  const ipd = app.get(InpatientRemindersService);
  const ipdTimer = setInterval(() => void ipd.tick().catch((e) => log.error(`სტაციონარის შეხსენება: ${(e as Error).message}`)), 10 * 60_000);
  // 0054: სატარიფო ფენა — სამომავლო ცვლილების ამოქმედება (ძველი სვეტები) + ამბ. წილი წესებით (გადასათვლელი)
  const tariffs = app.get(TariffTickService);
  const tariffTick = () => void tariffs.tick().catch((e) => log.error(`ტარიფები: ${(e as Error).message}`));
  const tariffTimer = setInterval(tariffTick, 10 * 60_000); setTimeout(tariffTick, 45_000);
  // 0060: მენეჯერული რეპორტინგი — დღიური ფაქტების გადათვლა (დღევანდელი — refresh_today_min, ღამის — nightly_hour); ყოველ წუთს მოწმდება
  const rpt = app.get(RptRefreshService);
  const rptTick = () => void rpt.tick().then((r) => { if (r && r.status !== 'ok') log.warn(`რეპორტინგი #${r.run_id}: ${r.status} ${r.error ?? ''}`); })
    .catch((e) => log.error(`რეპორტინგი: ${(e as Error).message}`));
  const rptTimer = setInterval(rptTick, 60_000); setTimeout(rptTick, 20_000);
  // 0063: მენეჯერული ანგარიში განრიგით (ელფოსტა) + „ყურადღების“ შეტყობინებები — ყოველ 5 წუთში
  const jobs = app.get(RptJobsService);
  const jobsTick = () => void jobs.tick().then((r) => { if (r && (r.schedules || r.attention)) log.log(`რეპორტინგი: გაგზავნილი ${r.schedules}, ყურადღება ${r.attention}`); })
    .catch((e) => log.error(`რეპორტინგის განრიგი: ${(e as Error).message}`));
  const jobsTimer = setInterval(jobsTick, 5 * 60_000); setTimeout(jobsTick, 60_000);
  // 0064–0065: ინციდენტები — ტრიაჟის / ანალიზის / CAPA-ს ვადები, ეფექტიანობა (ერთხელ) — ყოველ 10 წუთში
  const qm = app.get(QmJobsService);
  const qmTick = () => void qm.tick().then((r) => { if (r.overdue || r.analysis || r.capa || r.effectiveness) log.log(`ინციდენტები: ტრიაჟი ${r.overdue}, ანალიზი ${r.analysis}, CAPA ${r.capa}, ეფექტიანობა ${r.effectiveness}`); })
    .catch((e) => log.error(`ინციდენტები: ${(e as Error).message}`));
  const qmTimer = setInterval(qmTick, 10 * 60_000); setTimeout(qmTick, 75_000);
  // 0067: ინფექციის კონტროლი — გამოტოვებული მიკრობიოლოგიის პასუხების MDRO შემოწმება, ფლაგის ვადა — ყოველ 5 წუთში
  const ipc = app.get(IpcJobsService);
  const ipcTick = () => void ipc.tick().then((r) => { if (r.scanned || r.expired) log.log(`ინფექციის კონტროლი: შემოწმდა ${r.scanned}, ვადა ${r.expired}`); })
    .catch((e) => log.error(`ინფექციის კონტროლი: ${(e as Error).message}`));
  const ipcTimer = setInterval(ipcTick, 5 * 60_000); setTimeout(ipcTick, 90_000);
  // 0068: სიგნალები (15 წთ), device-days (საათში)
  const sigTick = () => void ipc.signals.scan().then((r) => { if (r.created || r.reopened) log.log(`IPC სიგნალები: ახალი ${r.created}, დაბრუნდა ${r.reopened}`); })
    .catch((e) => log.error(`IPC სიგნალები: ${(e as Error).message}`));
  const sigTimer = setInterval(sigTick, 15 * 60_000); setTimeout(sigTick, 120_000);
  const ddTick = () => void ipc.deviceDays.tick().then((r) => { if (r.rows) log.log(`IPC device-days: ${r.days} დღე, ${r.rows} ხაზი`); })
    .catch((e) => log.error(`IPC device-days: ${(e as Error).message}`));
  const ddTimer = setInterval(ddTick, 60 * 60_000); setTimeout(ddTick, 150_000);
  const ssiTick = () => void ipc.ssi.tick().then((r) => { if (r.ops || r.followups || r.sms) log.log(`IPC SSI: ოპერაცია ${r.ops}, კონტაქტი ${r.followups}, SMS ${r.sms}`); })
    .catch((e) => log.error(`IPC SSI: ${(e as Error).message}`));
  const ssiTimer = setInterval(ssiTick, 60 * 60_000); setTimeout(ssiTick, 170_000);
  const abxTick = () => void ipc.abx.tick().then((r) => { if (r.timeouts) log.log(`IPC ანტიბიოტიკი: time-out ${r.timeouts}`); })
    .catch((e) => log.error(`IPC ანტიბიოტიკი: ${(e as Error).message}`));
  const abxTimer = setInterval(abxTick, 15 * 60_000); setTimeout(abxTick, 180_000);
  // 0074: ბიომედ-აპარატურა — PM / კალიბრაციის შეხსენებები და ვადაგადაცილება (დღეში ერთხელ, pm_remind_hour-ის შემდეგ) — ყოველ 30 წუთში მოწმდება
  const bmePm = app.get(BmePmJobsService);
  const bmeTick = () => void bmePm.tick().then((r) => { if (r.reminders || r.restricted) log.log(`ბიომედ PM: შეხსენება ${r.reminders}, მიმღები ${r.notified}, შეზღუდული ${r.restricted}`); })
    .catch((e) => log.error(`ბიომედ PM: ${(e as Error).message}`));
  const bmeTimer = setInterval(bmeTick, 30 * 60_000); setTimeout(bmeTick, 200_000);
  process.once('SIGTERM', () => { clearInterval(timer); clearInterval(gwTimer); clearInterval(stockTimer); clearInterval(ipdTimer); clearInterval(tariffTimer); clearInterval(rptTimer); clearInterval(jobsTimer); clearInterval(qmTimer); clearInterval(ipcTimer); clearInterval(sigTimer); clearInterval(ddTimer); clearInterval(ssiTimer); clearInterval(abxTimer); clearInterval(bmeTimer); });
  process.once('SIGINT', () => { clearInterval(timer); clearInterval(gwTimer); clearInterval(stockTimer); clearInterval(ipdTimer); clearInterval(tariffTimer); clearInterval(rptTimer); clearInterval(jobsTimer); clearInterval(qmTimer); clearInterval(ipcTimer); clearInterval(sigTimer); clearInterval(ddTimer); clearInterval(ssiTimer); clearInterval(abxTimer); clearInterval(bmeTimer); });

  log.log('EMR worker started (queues: none yet)');
}
bootstrap();
