import { ForbiddenException, Global, Inject, Injectable, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import { has, type AuthUser, type Role } from '../auth/roles';
import { loadEnv } from '../config/env';
import { InjectDb, KYSELY, type Database } from '../database/database.module';
import type { DB } from '../database/db';
import { finRules, FIN_FULL } from '../finance/finance-rules';

/**
 * მენეჯერული რეპორტინგი (0060) — საერთო: პარამეტრები, უფლებები, ხედვის არე, წყაროს ბაზა.
 *
 * READ_DB — საიდანაც იკითხება წყარო (აგრეგაცია) და rpt_* (დაფები): REPORTING_DB_URL (რეპლიკა) ან მთავარი ბაზა.
 * ჩაწერა (rpt_*, ჟურნალი, აუდიტი) — ყოველთვის მთავარ ბაზაში (InjectDb).
 */
export const READ_DB = Symbol('REPORTING_READ_DB');
export const InjectReadDb = () => Inject(READ_DB);

export const TZ = loadEnv().CLINIC_TZ;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const n = (v: unknown) => Number(v ?? 0) || 0;
export const r1 = (x: number) => Math.round(x * 10) / 10;
export const r2 = (x: number) => Math.round(x * 100) / 100;
export const addDays = (iso: string, d: number) => { const x = new Date(`${iso}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0, 10); };
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000) + 1;

/** დაფის ნახვა: reports (განყოფილება), reports_all (კლინიკა); manager — განყოფილება, viewer — კლინიკა (უკუთავსებადობა) */
export const RPT_READ: Role[] = ['admin', 'reports', 'reports_all', 'manager', 'viewer'];
/** მთელი კლინიკის ხედვა */
export const RPT_ALL: Role[] = ['admin', 'reports_all', 'viewer'];
/** KPI ცნობარი / სამიზნეები */
export const RPT_CONFIG: Role[] = ['admin', 'reports_all'];
/** ჩაღრმავებაში პერსონალური ველები: reports_phi ან კლინიკური როლი */
export const RPT_PHI: Role[] = ['admin', 'reports_phi', 'doctor', 'nurse'];

export interface RptSettings {
  refresh_today_min: number; nightly_hour: number; recompute_days: number; freeze_closed_periods: boolean;
  occupancy_basis: 'hours' | 'midnight'; stock_days_window: number; stock_days_alert: number;
  compare_default: 'prev' | 'yoy' | 'none'; lab_tat_start: 'collected' | 'ordered';
  /** 0061 */
  lab_overdue_min: number; dx_overdue_hours: number; dead_stock_days: number; tv_refresh_min: number;
  /** 0062 */
  doctor_breakdown: 'off' | 'all_only' | 'scoped'; min_cases: number;
  /** 0063 */
  doctor_revenue: 'on' | 'off'; attention_notify: 'off' | 'in_app' | 'in_app_email'; attention_notify_hour: number; attention_notify_level: 'red' | 'all';
}
export const RPT_DEFAULTS: RptSettings = {
  refresh_today_min: 15, nightly_hour: 2, recompute_days: 35, freeze_closed_periods: true, occupancy_basis: 'hours',
  stock_days_window: 30, stock_days_alert: 7, compare_default: 'prev', lab_tat_start: 'collected',
  lab_overdue_min: 120, dx_overdue_hours: 24, dead_stock_days: 90, tv_refresh_min: 5,
  doctor_breakdown: 'all_only', min_cases: 5,
  doctor_revenue: 'on', attention_notify: 'in_app', attention_notify_hour: 8, attention_notify_level: 'red',
};
export async function rptModule(db: Database) {
  const m = await db.selectFrom('system_modules').select(['enabled', 'settings']).where('code', '=', 'reporting').executeTakeFirst();
  return { enabled: m?.enabled ?? false, settings: { ...RPT_DEFAULTS, ...((m?.settings ?? {}) as Partial<RptSettings>) } };
}

/** ხედვის არე: all — მთელი კლინიკა; depts — დაშვებული განყოფილებები; finance — ფინანსური KPI-ები ჩანს;
 *  quality (0066) — ხარისხის KPI-ები / „ყურადღება“ / თვიური სექცია ჩანს (მოდული ჩართულია და dashboard_visibility-ის წესი) */
export interface RptScope { all: boolean; depts: string[]; finance: boolean; phi: boolean; quality?: boolean; ipc?: boolean; bme?: boolean }
/** 0072: ინფექციის კონტროლის KPI / „ყურადღება“ / თვიური სექცია (მოდული ჩართულია და dashboard_visibility-ის წესი) */
export const IPC_REPORT_CAPS: Role[] = ['infection', 'infection_dept', 'infection_view'];
export async function ipcVisibility(db: Database, u: AuthUser) {
  const m = await db.selectFrom('system_modules').select(['enabled', 'settings']).where('code', '=', 'ipc').executeTakeFirst();
  if (!m?.enabled) return false;
  const st = (m.settings ?? {}) as { dashboard_visibility?: string };
  return st.dashboard_visibility === 'ipc_only' ? has(u, ...IPC_REPORT_CAPS) : true;
}
/** 0076: ბიომედ-აპარატურის KPI / „ყურადღება“ / თვიური სექცია (მოდული ჩართულია და dashboard_visibility-ის წესი) */
export const BME_REPORT_CAPS: Role[] = ['med_engineer', 'bme_view', 'bme_dept'];
export async function bmeVisibility(db: Database, u: AuthUser) {
  const m = await db.selectFrom('system_modules').select(['enabled', 'settings']).where('code', '=', 'bme').executeTakeFirst();
  if (!m?.enabled) return false;
  const st = (m.settings ?? {}) as { dashboard_visibility?: string };
  return st.dashboard_visibility === 'bme_only' ? has(u, ...BME_REPORT_CAPS) : true;
}
/** 0066: ხარისხის უფლებები (dashboard_visibility = quality_only) */
export const QM_REPORT_CAPS: Role[] = ['quality', 'quality_dept', 'quality_view'];
export async function qmVisibility(db: Database, u: AuthUser) {
  const m = await db.selectFrom('system_modules').select(['enabled', 'settings']).where('code', '=', 'quality').executeTakeFirst();
  if (!m?.enabled) return false;
  const st = (m.settings ?? {}) as { dashboard_visibility?: string };
  return st.dashboard_visibility === 'quality_only' ? has(u, ...QM_REPORT_CAPS) : true;
}

@Injectable()
export class RptCommon {
  constructor(@InjectDb() readonly db: Database, @InjectReadDb() readonly rdb: Database) {}

  async settings() {
    const m = await rptModule(this.db);
    if (!m.enabled) throw new ForbiddenException({ code: 'MODULE_DISABLED', message: 'მოდული „მენეჯერული რეპორტინგი“ გამორთულია (ადმინისტრირება → მოდულები)' });
    return m.settings;
  }
  async today() {
    return (await sql<{ d: string }>`SELECT to_char((now() AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS d`.execute(this.db)).rows[0].d;
  }
  /** მომხმარებლის განყოფილებები: rpt_user_scopes ∪ users.department_id */
  async userDepts(userId: string) {
    const r = await sql<{ id: string }>`
      SELECT department_id AS id FROM rpt_user_scopes WHERE user_id = ${userId}
      UNION SELECT department_id FROM users WHERE id = ${userId} AND department_id IS NOT NULL`.execute(this.db);
    return r.rows.map((x) => x.id);
  }
  async scope(u: AuthUser): Promise<RptScope> {
    const fr = await finRules(this.db);
    const phi = has(u, ...RPT_PHI);
    const quality = await qmVisibility(this.db, u);
    const ipc = await ipcVisibility(this.db, u);
    const bme = await bmeVisibility(this.db, u);
    if (has(u, ...RPT_ALL)) return { all: true, depts: [], finance: fr.enabled && has(u, ...FIN_FULL, 'reports_all'), phi, quality, ipc, bme };
    const depts = await this.userDepts(u.id);
    if (!depts.length) throw new ForbiddenException({ code: 'NO_SCOPE', message: 'განყოფილება არ გაქვთ მინიჭებული — მენეჯერული დაფა ვერ გამოჩნდება (ადმინისტრირება → რეპორტინგი → ხედვის არე)' });
    return { all: false, depts, finance: fr.enabled && (has(u, ...FIN_FULL) || fr.dept_finance_visible === 'heads'), phi, quality, ipc, bme };
  }
  /** მოთხოვნილი განყოფილება ხედვის არეშია? (null — მთელი არე) */
  narrow(scope: RptScope, dept?: string | null): RptScope {
    if (!dept) return scope;
    if (!UUID_RE.test(dept)) throw new ForbiddenException('department_id');
    if (!scope.all && !scope.depts.includes(dept)) throw new ForbiddenException({ code: 'OUT_OF_SCOPE', message: 'ეს განყოფილება თქვენი ხედვის არის გარეთაა' });
    return { ...scope, all: false, depts: [dept] };
  }
}

/** READ_DB: REPORTING_DB_URL → ცალკე pool (application_name emr-reporting); სხვა შემთხვევაში — მთავარი ბაზა */
export const isReplica = () => !!loadEnv().REPORTING_DB_URL;
export function readDbFactory(main: Database): Database {
  const env = loadEnv();
  if (!env.REPORTING_DB_URL) return main;
  new Logger('Reporting').log('რეპორტინგის წყარო: REPORTING_DB_URL (რეპლიკა)');
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: env.REPORTING_DB_URL, max: 4, application_name: 'emr-reporting' }) }) });
}

@Injectable()
class ReadDbLifecycle implements OnApplicationShutdown {
  constructor(@InjectReadDb() private readonly rdb: Database, @InjectDb() private readonly db: Database) {}
  async onApplicationShutdown() { if (this.rdb !== this.db) await this.rdb.destroy(); }
}

/** API-შიც და worker-შიც: READ_DB + RptCommon */
@Global()
@Module({
  providers: [{ provide: READ_DB, inject: [KYSELY], useFactory: readDbFactory }, ReadDbLifecycle, RptCommon],
  exports: [READ_DB, RptCommon],
})
export class RptCommonModule {}
