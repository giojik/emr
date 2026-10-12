import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { has, type AuthUser } from '../auth/roles';
import { loadEnv } from '../config/env';
import { InjectDb, type Database } from '../database/database.module';
import type { DB } from '../database/db';
import { NotificationsService } from '../notifications/notifications';
import { FIN_FULL, finRules, type FinRules } from './finance-rules';

export const TZ = loadEnv().CLINIC_TZ;
export type Trx = Transaction<DB>;
export type Ex = Database | Trx;
export const r2 = (n: number) => Math.round(n * 100) / 100;
export const n = (v: unknown) => Number(v ?? 0) || 0;
export const addDays = (iso: string, d: number) => { const x = new Date(`${iso}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0, 10); };
export const userName = (alias: string) => sql<string | null>`${sql.ref(`${alias}.first_name`)} || ' ' || ${sql.ref(`${alias}.last_name`)}`;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const UUID_RE = /^[0-9a-f-]{36}$/i;

/** CSV Excel-ისთვის: UTF-8 BOM, „;“ */
export function toCsv(head: string[], rows: (string | number | null | undefined)[][], title?: string) {
  const esc = (v: unknown) => { const t = v === null || v === undefined ? '' : String(v); return /[;"\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  return '﻿' + [...(title ? [esc(title)] : []), head.map(esc).join(';'), ...rows.map((r) => r.map(esc).join(';'))].join('\r\n');
}

/** ხედვის არე: null — მთელი კლინიკა; string — მხოლოდ ეს განყოფილება (მენეჯერი, dept_finance_visible = heads) */
export type Scope = { dept: string | null; dept_name: string | null };

@Injectable()
export class FinCommon {
  constructor(@InjectDb() readonly db: Database, private readonly notifications: NotificationsService) {}

  async today(ex: Ex = this.db) {
    const r = await sql<{ d: string }>`SELECT to_char((now() AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS d`.execute(ex);
    return r.rows[0].d;
  }
  /** მოდული ჩართულია → პარამეტრები; გამორთულზე — 403 */
  async rules(ex: Ex = this.db): Promise<FinRules> {
    const r = await finRules(ex as Database);
    if (!r.enabled) throw new ForbiddenException({ code: 'MODULE_DISABLED', message: 'მოდული „ფინანსები“ გამორთულია (ადმინისტრირება → მოდულები)' });
    return r;
  }
  /** მენეჯერი (მხოლოდ) — თავისი განყოფილება; dept_finance_visible = off → 403 */
  async scope(u: AuthUser, rules: FinRules): Promise<Scope> {
    if (has(u, ...FIN_FULL)) return { dept: null, dept_name: null };
    if (rules.dept_finance_visible !== 'heads') throw new ForbiddenException('განყოფილების ფინანსების ნახვა გამორთულია (პარამეტრი dept_finance_visible)');
    const me = await this.db.selectFrom('users as u').leftJoin('departments as d', 'd.id', 'u.department_id').select(['u.department_id', 'd.name']).where('u.id', '=', u.id).executeTakeFirst();
    if (!me?.department_id) throw new ForbiddenException('განყოფილება არ გაქვთ მინიჭებული — განყოფილების ფინანსები ვერ გამოჩნდება');
    return { dept: me.department_id, dept_name: me.name };
  }
  /** მხოლოდ მთელი კლინიკის ხედვა */
  full(u: AuthUser) { if (!has(u, ...FIN_FULL)) throw new ForbiddenException('მხოლოდ ბუღალტერია / ხელმძღვანელობა'); }

  period(from?: string, to?: string) {
    if (!from || !to || !DATE_RE.test(from) || !DATE_RE.test(to) || from > to) throw new BadRequestException('პერიოდი: from ≤ to (YYYY-MM-DD)');
    if (Date.parse(to) - Date.parse(from) > 3 * 366 * 86_400_000) throw new BadRequestException('პერიოდი — მაქსიმუმ 3 წელი');
    return { from, to };
  }
  async costingMethod(ex: Ex = this.db) {
    return (await ex.selectFrom('stock_settings').select('costing_method').where('id', '=', 1).executeTakeFirstOrThrow()).costing_method as 'fifo' | 'average';
  }
  async nextNo(trx: Trx, prefix: 'CL', date: string) {
    const year = Number(date.slice(0, 4));
    const { last_value } = await trx.insertInto('document_counters').values({ document_type: `fin_${prefix}`, year, last_value: 1 })
      .onConflict((oc) => oc.columns(['document_type', 'year']).doUpdateSet({ last_value: sql`document_counters.last_value + 1` }))
      .returning('last_value').executeTakeFirstOrThrow();
    return `${prefix}${String(year).slice(2)}-${String(last_value).padStart(6, '0')}`;
  }
  async usersWith(caps: string[], ex: Ex = this.db) {
    const r = await ex.selectFrom('users as u').innerJoin('user_capabilities as c', 'c.user_id', 'u.id').select('u.id').where('u.is_active', '=', true)
      .where(sql<boolean>`c.capabilities && ${sql.val(caps)}::varchar[]`).execute();
    return r.map((x) => x.id);
  }
  async notify(ids: Iterable<string>, msg: Parameters<NotificationsService['notify']>[1], except?: string) {
    for (const id of new Set(ids)) if (id !== except) await this.notifications.notify(id, msg);
  }
}
