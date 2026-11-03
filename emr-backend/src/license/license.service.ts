import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { sql } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/roles';
import { loadEnv } from '../config/env';
import { InjectDb, type Database } from '../database/database.module';
import { OPTIONAL_CODES } from '../modules/registry';
import { PROD_KEYS, TEST_KEYS } from './keys';
import { canonical, formatError, sha256, timing, verifySignature, ALL_DAYS_BANNER, type LicenseFile, type LicensePhase } from './license-core';

/** ლიცენზიის მდგომარეობა: dev — ლიცენზია არ არის, NODE_ENV ≠ production (ყველა მოდული); none — production, ლიცენზია არ არის (მხოლოდ ბირთვი) */
export interface LicenseStatus {
  mode: 'dev' | 'licensed' | 'none';
  install_id: string;
  clinic: string | null;
  kid: string | null;
  /** 'all' — dev; სხვა შემთხვევაში — ლიცენზირებული ოპციური მოდულები (ცნობილი კოდები) */
  modules: string[] | 'all';
  unknown_modules: string[];
  issued: string | null;
  expires: string | null;
  expires_at: string | null;
  grace_until: string | null;
  days_left: number | null;
  phase: LicensePhase | null;
  /** ბანერი: admin / manager — warning-ის მთელი პერიოდი; ყველა — ბოლო 7 დღე, grace, expired */
  banner: 'none' | 'admins' | 'all';
  max_users: number | null;
  users_active: number;
  users_warn: boolean;
  uploaded_at: string | null;
  test_key: boolean;
  /** ეფექტური „ახლა“ (საათის დაცვით) */
  now: string;
}

const CLOCK_WRITE_MS = 60_000;

@Injectable()
export class LicenseService {
  private readonly env = loadEnv();
  /** ModulesService აყენებს: ლიცენზიის ცვლილება → მოდულების ქეში მაშინვე (იგივე პროცესი; სხვა — pg_notify) */
  onChange?: () => void;
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService) {}

  get devAllowed() { return this.env.NODE_ENV !== 'production'; }
  get testKeyAllowed() { return this.devAllowed && this.env.LICENSE_TEST_KEY; }
  keys(): Record<string, string> { return { ...PROD_KEYS, ...(this.testKeyAllowed ? TEST_KEYS : {}) }; }

  /** ეფექტური „ახლა“: max(სისტემის საათი, ბოლოს ნანახი) — საათის უკან გადაწევა ვადას ვერ აგრძელებს */
  async now(): Promise<number> {
    const r = await this.db.selectFrom('system_install').select(['clock_max_seen']).executeTakeFirstOrThrow();
    const seen = new Date(r.clock_max_seen as unknown as string).getTime();
    const sys = Date.now();
    if (sys > seen + CLOCK_WRITE_MS) {
      await this.db.updateTable('system_install').set({ clock_max_seen: sql`GREATEST(clock_max_seen, now())` }).execute().catch(() => undefined);
    }
    return Math.max(sys, seen);
  }

  async installId() { return (await this.db.selectFrom('system_install').select('install_id').executeTakeFirstOrThrow()).install_id; }

  current() {
    return this.db.selectFrom('system_licenses').selectAll().where('removed_at', 'is', null).orderBy('uploaded_at', 'desc').limit(1).executeTakeFirst();
  }

  async status(): Promise<LicenseStatus> {
    const [installId, lic, now, users] = await Promise.all([this.installId(), this.current(), this.now(),
      this.db.selectFrom('users').select(sql<number>`count(*)::int`.as('n')).where('is_active', '=', true).executeTakeFirstOrThrow()]);
    const base = { install_id: installId, users_active: users.n, now: new Date(now).toISOString() };
    if (!lic) {
      const mode = this.devAllowed ? 'dev' : 'none';
      return { ...base, mode, clinic: null, kid: null, modules: mode === 'dev' ? 'all' : [], unknown_modules: [], issued: null, expires: null, expires_at: null, grace_until: null,
        days_left: null, phase: null, banner: mode === 'dev' ? 'admins' : 'all', max_users: null, users_warn: false, uploaded_at: null, test_key: false };
    }
    const t = timing(lic.expires as string | null, now, this.env.CLINIC_TZ);
    const banner = t.phase === 'grace' || t.phase === 'expired' || (t.phase === 'warning' && (t.days_left ?? 99) <= ALL_DAYS_BANNER) ? 'all'
      : t.phase === 'warning' ? 'admins' : 'none';
    const mods = lic.modules as string[];
    return { ...base, mode: 'licensed', clinic: lic.clinic, kid: lic.kid, modules: mods.filter((m) => OPTIONAL_CODES.includes(m)), unknown_modules: mods.filter((m) => !OPTIONAL_CODES.includes(m)),
      issued: lic.issued as string, expires: lic.expires as string | null, ...t, banner, max_users: lic.max_users,
      users_warn: !!lic.max_users && users.n >= Math.ceil(lic.max_users * 0.9), uploaded_at: new Date(lic.uploaded_at as unknown as string).toISOString(), test_key: lic.kid in TEST_KEYS };
  }

  /** ფაილის შემოწმება ატვირთვის გარეშე (ადმინის გვერდი / CLI verify) */
  async check(raw: unknown) {
    const err = formatError(raw);
    if (err) throw new BadRequestException({ code: 'LICENSE_FORMAT', message: `ლიცენზიის ფაილი არასწორია: ${err}` });
    const f = raw as LicenseFile;
    const v = verifySignature(f, this.keys());
    if (v === 'LICENSE_UNKNOWN_KEY') throw new BadRequestException({ code: v, message: `ხელმოწერის გასაღები (${f.kid}) ამ ვერსიისთვის უცნობია` });
    if (v === 'LICENSE_BAD_SIGNATURE') throw new BadRequestException({ code: v, message: 'ხელმოწერა არასწორია — ფაილი შეცვლილია ან სხვა გასაღებითაა ხელმოწერილი' });
    const inst = await this.installId();
    if (f.payload.install_id.toLowerCase() !== inst.toLowerCase()) throw new BadRequestException({ code: 'LICENSE_WRONG_INSTALL', message: 'ლიცენზია სხვა ინსტალაციისთვისაა გაცემული (install_id არ ემთხვევა)' });
    return f;
  }

  async upload(raw: unknown, u: AuthUser, req: Request) {
    const f = await this.check(raw);
    const p = f.payload;
    const hash = sha256(canonical(f));
    const cur = await this.current();
    if (cur?.sha256 === hash) throw new ConflictException({ code: 'LICENSE_SAME', message: 'ეს ლიცენზია უკვე ატვირთულია' });
    // max_users: არსებული მომხმარებლები არ ითიშება — ლიმიტზე მეტისას იბლოკება მხოლოდ ახალი გააქტიურება (assertUserSlot)
    await this.db.transaction().execute(async (trx) => {
      const row = await trx.insertInto('system_licenses').values({
        raw: JSON.stringify(f), sha256: hash, kid: f.kid, clinic: p.clinic.trim(), modules: p.modules, issued: p.issued, expires: p.expires,
        max_users: p.max_users ?? null, uploaded_by: u.id,
      }).returning('id').executeTakeFirstOrThrow();
      await this.audit.log(auditCtx(req), { action: 'LICENSE_UPLOAD', entityName: 'system_licenses', entityId: row.id,
        oldData: cur ? { id: cur.id, clinic: cur.clinic, modules: cur.modules, expires: cur.expires } : null,
        newData: { clinic: p.clinic, modules: p.modules, issued: p.issued, expires: p.expires, max_users: p.max_users ?? null, kid: f.kid } }, trx);
      await sql`SELECT pg_notify('emr_modules', 'license')`.execute(trx);
    });
    this.onChange?.();
    return this.status();
  }

  /** ლიცენზიის მოხსნა — მხოლოდ dev / e2e (production-ში ახალი ლიცენზია ძველს ანაცვლებს) */
  async remove(u: AuthUser, req: Request) {
    if (!this.devAllowed) throw new ForbiddenException({ code: 'LICENSE_REMOVE_PROD', message: 'production-ში ლიცენზია არ იხსნება — ატვირთეთ ახალი' });
    const cur = await this.current();
    if (!cur) return this.status();
    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable('system_licenses').set({ removed_at: sql`now()`, removed_by: u.id }).where('removed_at', 'is', null).execute();
      await this.audit.log(auditCtx(req), { action: 'LICENSE_REMOVE', entityName: 'system_licenses', entityId: cur.id, oldData: { clinic: cur.clinic, modules: cur.modules, expires: cur.expires } }, trx);
      await sql`SELECT pg_notify('emr_modules', 'license')`.execute(trx);
    });
    this.onChange?.();
    return this.status();
  }

  history() {
    return this.db.selectFrom('system_licenses as l').leftJoin('users as u', 'u.id', 'l.uploaded_by')
      .select(['l.id', 'l.kid', 'l.clinic', 'l.modules', 'l.issued', 'l.expires', 'l.max_users', 'l.uploaded_at', 'l.removed_at',
        sql<string>`concat_ws(' ', u.first_name, u.last_name)`.as('uploaded_by_name')])
      .orderBy('l.uploaded_at', 'desc').limit(50).execute();
  }

  /** მომხმარებლების ლიმიტი: ახალი / ხელახლა გააქტიურებული მომხმარებელი; ლიმიტი არ არის — თავისუფლად */
  async assertUserSlot(ex: Database = this.db) {
    const lic = await this.current();
    if (!lic?.max_users) return;
    const n = (await ex.selectFrom('users').select(sql<number>`count(*)::int`.as('n')).where('is_active', '=', true).executeTakeFirstOrThrow()).n;
    if (n >= lic.max_users) throw new ConflictException({ code: 'LICENSE_USER_LIMIT', message: `ლიცენზიის მომხმარებლების ლიმიტი (${lic.max_users}) ამოწურულია` });
  }
}
