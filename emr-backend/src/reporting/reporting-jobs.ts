import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Injectable, Logger, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, Min } from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser, type Role } from '../auth/roles';
import { NotificationsService } from '../notifications/notifications';
import { NotifyService } from '../notify/notify.service';
import { FIN_FULL } from '../finance/finance-rules';
import { addDays, DATE_RE, RPT_ALL, RPT_CONFIG, RPT_READ, RptCommon, TZ } from './reporting-common';
import { ReportingDashService } from './reporting-dash';
import { periodLabel, RptReportService } from './reporting-report';

/**
 * 0063: განრიგით გაგზავნა და „ყურადღების“ შეტყობინებები (worker — tick ყოველ 5 წუთში; ხელით — ადმინისტრირებიდან).
 *  • განრიგი: monthly — წინა თვე, თვის N-ე სამუშაო დღეს (ორშ–პარ) send_hour-დან; weekly — წინა კვირა (ორშ–კვი), send_day-ზე send_hour-დან.
 *    ანგარიში იქმნება მიმღების სახელით (მისი ხედვის არე / უფლებები); ექიმის ფურცლები — მხოლოდ include_doctors და წვდომის შემთხვევაში.
 *    წერილში — მხოლოდ აგრეგატები (პაციენტის მონაცემების გარეშე); ყოველი მიწოდება — rpt_deliveries.
 *  • „ყურადღება“: attention_notify (off / in_app / in_app_email), attention_notify_hour-დან დღეში ერთხელ თითო მომხმარებელზე;
 *    attention_notify_level: red — მხოლოდ წითელი, all — ყვითელიც; ერთი შეტყობინება (ზარი) — ელემენტების ჩამონათვალით.
 */
const LOCK_KEY = 60_063;
const RPT_READ_CAPS = RPT_READ as Role[];
const WD_KA = ['', 'ორშაბათი', 'სამშაბათი', 'ოთხშაბათი', 'ხუთშაბათი', 'პარასკევი', 'შაბათი', 'კვირა'];

class ScheduleDto {
  @IsString() @Length(2, 120) name: string;
  @IsIn(['monthly', 'weekly']) frequency: 'monthly' | 'weekly';
  @IsInt() @Min(1) @Max(10) send_day: number;
  @IsOptional() @IsInt() @Min(0) @Max(23) send_hour?: number;
  @IsOptional() @IsUUID() department_id?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(2) @IsIn(['xlsx', 'pdf'], { each: true }) formats?: string[];
  @IsOptional() @IsBoolean() include_doctors?: boolean;
  @IsArray() @ArrayMaxSize(50) @IsUUID('all', { each: true }) recipients: string[];
  @IsOptional() @IsBoolean() is_active?: boolean;
}
class SchedulePatchDto {
  @IsOptional() @IsString() @Length(2, 120) name?: string;
  @IsOptional() @IsIn(['monthly', 'weekly']) frequency?: 'monthly' | 'weekly';
  @IsOptional() @IsInt() @Min(1) @Max(10) send_day?: number;
  @IsOptional() @IsInt() @Min(0) @Max(23) send_hour?: number;
  @IsOptional() @IsUUID() department_id?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(2) @IsIn(['xlsx', 'pdf'], { each: true }) formats?: string[];
  @IsOptional() @IsBoolean() include_doctors?: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsUUID('all', { each: true }) recipients?: string[];
  @IsOptional() @IsBoolean() is_active?: boolean;
}
class RunDto {
  @IsOptional() @Matches(DATE_RE) from?: string;
  @IsOptional() @Matches(DATE_RE) to?: string;
  /** true — ფაილები იქმნება, ელფოსტა არ იგზავნება (შემოწმება) */
  @IsOptional() @IsBoolean() dry_run?: boolean;
}

type Sched = { id: string; name: string; frequency: string; send_day: number; send_hour: number; department_id: string | null; formats: string[]; include_doctors: boolean;
  recipients: string[]; is_active: boolean; last_period: string | null };

/** ISO კვირის ნომერი */
const isoWeek = (d: string) => {
  const t = new Date(`${d}T00:00:00Z`); const day = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - day + 3);
  const y = t.getUTCFullYear(); const first = new Date(Date.UTC(y, 0, 4));
  return `${y}-W${String(1 + Math.round(((t.getTime() - first.getTime()) / 86_400_000 - 3 + ((first.getUTCDay() + 6) % 7)) / 7)).padStart(2, '0')}`;
};
const dow = (d: string) => ((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;   // 1 ორშ … 7 კვი
const monthEnd = (ym: string) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
/** თვის N-ე სამუშაო დღე (ორშ–პარ) */
export function nthWorkday(ym: string, nth: number) {
  let d = `${ym}-01`; let k = 0;
  for (;;) { if (dow(d) <= 5 && ++k === nth) return d; d = addDays(d, 1); }
}
/** განრიგის მიმდინარე პერიოდი და გაგზავნის მომენტი (დღე) — today-ს მიხედვით */
export function schedulePeriod(s: Pick<Sched, 'frequency' | 'send_day'>, today: string) {
  if (s.frequency === 'monthly') {
    const ym = today.slice(0, 7);
    const prev = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7);
    return { period: prev, from: `${prev}-01`, to: monthEnd(prev), due_day: nthWorkday(ym, s.send_day) };
  }
  const monday = addDays(today, -(dow(today) - 1));
  const from = addDays(monday, -7); const to = addDays(monday, -1);
  return { period: isoWeek(from), from, to, due_day: addDays(monday, s.send_day - 1) };
}

/** მიმდინარე პერიოდის ვადა უკვე გავიდა? (ახალ / შეცვლილ განრიგზე — ძველი პერიოდი ავტომატურად აღარ იგზავნება) */
const duePassed = (s: Pick<Sched, 'frequency' | 'send_day' | 'send_hour'>, today: string, hour: number) => {
  const p = schedulePeriod(s, today);
  return today > p.due_day || (today === p.due_day && hour >= s.send_hour);
};
/** შემდეგი ავტომატური გაგზავნა: მიმდინარე პერიოდი გაგზავნილია → მომდევნო ციკლი */
export function nextRun(s: Pick<Sched, 'frequency' | 'send_day' | 'last_period'>, today: string) {
  const p = schedulePeriod(s, today);
  if (s.last_period !== p.period) return { period: p.period, due_day: p.due_day };
  if (s.frequency === 'monthly') {
    const ym = today.slice(0, 7); const nx = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 1)).toISOString().slice(0, 7);
    return { period: ym, due_day: nthWorkday(nx, s.send_day) };
  }
  const monday = addDays(today, -(dow(today) - 1));
  return { period: isoWeek(monday), due_day: addDays(monday, 7 + s.send_day - 1) };
}

@Injectable()
export class RptJobsService {
  private readonly log = new Logger('RptJobs');
  private busy = false;
  constructor(private readonly c: RptCommon, private readonly rep: RptReportService, private readonly dash: ReportingDashService,
              private readonly notify: NotifyService, private readonly notifications: NotificationsService, private readonly audit: AuditService) {}

  /** მომხმარებელი AuthUser-ად (worker / მიმღები) */
  async asUser(id: string): Promise<(AuthUser & { email: string | null; active: boolean }) | null> {
    const r = await this.c.db.selectFrom('users as u').leftJoin('user_capabilities as c', 'c.user_id', 'u.id')
      .select(['u.id', 'u.role', 'u.is_active', 'u.email', 'u.first_name', 'u.last_name', 'c.capabilities']).where('u.id', '=', id).executeTakeFirst();
    if (!r) return null;
    return { id: r.id, role: r.role, caps: (r.capabilities ?? []) as Role[], name: `${r.first_name} ${r.last_name}`, mustChangePassword: false, email: r.email, active: r.is_active };
  }
  private async now() {
    const r = (await sql<{ d: string; h: number }>`SELECT to_char(now() AT TIME ZONE ${TZ}, 'YYYY-MM-DD') AS d, extract(hour FROM now() AT TIME ZONE ${TZ})::int AS h`.execute(this.c.db)).rows[0];
    return { today: r.d, hour: r.h };
  }

  // ------------------------------------------------------------------------------------ განრიგი: CRUD
  async list() {
    const rows = await this.c.db.selectFrom('rpt_schedules as s').leftJoin('departments as d', 'd.id', 's.department_id')
      .select(['s.id', 's.name', 's.frequency', 's.send_day', 's.send_hour', 's.department_id', 'd.name as department_name', 's.formats', 's.include_doctors', 's.recipients',
        's.is_active', 's.last_period', 's.last_run_at', 's.created_at', 's.updated_at']).orderBy('s.name').execute();
    const ids = [...new Set(rows.flatMap((r) => r.recipients))];
    const users = ids.length ? await this.c.db.selectFrom('users').select(['id', 'first_name', 'last_name', 'email', 'is_active']).where('id', 'in', ids).execute() : [];
    const { today } = await this.now();
    return rows.map((r) => {
      return { ...r, recipients: r.recipients.map((id) => { const x = users.find((u) => u.id === id);
        return { id, name: x ? `${x.last_name} ${x.first_name}` : '—', email: x?.email ?? null, is_active: x?.is_active ?? false }; }),
        when_ka: r.frequency === 'monthly' ? `ყოველთვიურად, ${r.send_day}-ე სამუშაო დღე, ${r.send_hour}:00 — წინა თვე` : `ყოველკვირეულად, ${WD_KA[r.send_day]}, ${r.send_hour}:00 — წინა კვირა`,
        next: nextRun(r, today) };
    });
  }
  private async checkRecipients(ids: string[]) {
    if (!ids.length) return;
    const found = await this.c.db.selectFrom('users').select('id').where('id', 'in', ids).execute();
    if (found.length !== new Set(ids).size) throw new BadRequestException('recipients: უცნობი მომხმარებელი');
  }
  private checkDay(frequency: string, day: number) {
    if (frequency === 'weekly' && day > 7) throw new BadRequestException('send_day: კვირის დღე 1–7 (ორშ … კვი)');
  }
  async create(d: ScheduleDto, ctx: AuditContext, u: AuthUser) {
    this.checkDay(d.frequency, d.send_day); await this.checkRecipients(d.recipients);
    const { today, hour } = await this.now();
    const sh = { frequency: d.frequency, send_day: d.send_day, send_hour: d.send_hour ?? 9 };
    const row = await this.c.db.insertInto('rpt_schedules').values({ last_period: duePassed(sh, today, hour) ? schedulePeriod(sh, today).period : null, name: d.name, frequency: d.frequency, send_day: d.send_day, send_hour: d.send_hour ?? 9,
      department_id: d.department_id ?? null, formats: d.formats?.length ? d.formats : ['xlsx', 'pdf'], include_doctors: !!d.include_doctors, recipients: [...new Set(d.recipients)],
      is_active: d.is_active ?? true, created_by: u.id }).returning('id').executeTakeFirstOrThrow();
    await this.audit.log(ctx, { action: 'REPORT_SCHEDULE_CREATE', entityName: 'rpt_schedules', entityId: row.id, newData: d });
    return (await this.list()).find((x) => x.id === row.id);
  }
  async patch(id: string, d: SchedulePatchDto, ctx: AuditContext) {
    const old = await this.c.db.selectFrom('rpt_schedules').selectAll().where('id', '=', id).executeTakeFirst();
    if (!old) throw new NotFoundException('განრიგი ვერ მოიძებნა');
    this.checkDay(d.frequency ?? old.frequency, d.send_day ?? old.send_day);
    if (d.recipients) await this.checkRecipients(d.recipients);
    const set: Record<string, unknown> = { updated_at: sql`now()` };
    for (const k of ['name', 'frequency', 'send_day', 'send_hour', 'department_id', 'include_doctors', 'is_active'] as const) if (d[k] !== undefined) set[k] = d[k];
    if (d.formats) { if (!d.formats.length) throw new BadRequestException('formats: xlsx / pdf'); set.formats = d.formats; }
    if (d.recipients) set.recipients = [...new Set(d.recipients)];
    // სიხშირე / დღე / საათი შეიცვალა → ვადაგასული მიმდინარე პერიოდი ავტომატურად აღარ იგზავნება (ხელით — „გაგზავნა ახლა“)
    const sh = { frequency: d.frequency ?? old.frequency, send_day: d.send_day ?? old.send_day, send_hour: d.send_hour ?? old.send_hour };
    if (sh.frequency !== old.frequency || sh.send_day !== old.send_day || sh.send_hour !== old.send_hour) {
      const { today, hour } = await this.now();
      const cur = schedulePeriod(sh, today).period;
      set.last_period = duePassed(sh, today, hour) ? cur : (old.last_period === cur ? old.last_period : null);
    }
    await this.c.db.updateTable('rpt_schedules').set(set).where('id', '=', id).execute();
    await this.audit.log(ctx, { action: 'REPORT_SCHEDULE_UPDATE', entityName: 'rpt_schedules', entityId: id, oldData: old, newData: d });
    return (await this.list()).find((x) => x.id === id);
  }
  async remove(id: string, ctx: AuditContext) {
    const old = await this.c.db.deleteFrom('rpt_schedules').where('id', '=', id).returningAll().executeTakeFirst();
    if (!old) throw new NotFoundException('განრიგი ვერ მოიძებნა');
    await this.audit.log(ctx, { action: 'REPORT_SCHEDULE_DELETE', entityName: 'rpt_schedules', entityId: id, oldData: old });
    return { ok: true };
  }
  /** შესაძლო მიმღებები: აქტიური, მენეჯერული რეპორტინგის უფლებით */
  async recipients() {
    return (await sql<{ id: string; name: string; email: string | null; caps: string[] }>`
      SELECT u.id, u.last_name || ' ' || u.first_name AS name, u.email, c.capabilities::text[] AS caps FROM users u JOIN user_capabilities c ON c.user_id = u.id
       WHERE u.is_active AND c.capabilities::text[] && ${RPT_READ_CAPS}::text[] ORDER BY 2`.execute(this.c.db)).rows
      .map((r) => ({ id: r.id, name: r.name, email: r.email, all: has({ caps: r.caps as Role[] }, ...RPT_ALL), finance: has({ caps: r.caps as Role[] }, ...FIN_FULL, 'reports_all') }));
  }
  async deliveries(q: { schedule_id?: string; limit?: string }) {
    let qb = this.c.db.selectFrom('rpt_deliveries as d').leftJoin('users as u', 'u.id', 'd.user_id').leftJoin('rpt_schedules as s', 's.id', 'd.schedule_id')
      .select(['d.id', 'd.schedule_id', 's.name as schedule_name', 'd.period', 'd.date_from', 'd.date_to', 'd.user_id', sql<string>`u.last_name || ' ' || u.first_name`.as('user_name'),
        'd.email', 'd.status', 'd.error', 'd.files', 'd.bytes', 'd.manual', 'd.created_at']).orderBy('d.id', 'desc').limit(Math.min(500, Number(q.limit) || 100));
    if (q.schedule_id) qb = qb.where('d.schedule_id', '=', q.schedule_id);
    return qb.execute();
  }

  // ------------------------------------------------------------------------------------ გაგზავნა
  /** ერთი განრიგის გაგზავნა ყველა მიმღებზე (პერიოდი — მოცემული ან განრიგის მიმდინარე) */
  async send(s: Sched, period: { period: string; from: string; to: string }, opts: { manual: boolean; dry_run?: boolean; by?: string | null }) {
    const out: { user_id: string; user_name: string; email: string | null; status: string; error: string | null; files: string[]; bytes: number }[] = [];
    const smtp = this.notify.configured().email;
    for (const uid of s.recipients) {
      const u = await this.asUser(uid);
      const r = { user_id: uid, user_name: u?.name ?? '—', email: u?.email ?? null, status: 'skipped', error: null as string | null, files: [] as string[], bytes: 0 };
      try {
        if (!u || !u.active) throw new Error('მომხმარებელი არააქტიურია');
        if (!has(u, ...RPT_READ_CAPS)) throw new Error('მომხმარებელს მენეჯერული რეპორტინგის უფლება არ აქვს');
        if (!u.email) throw new Error('მომხმარებელს ელფოსტა არ აქვს');
        const { data, files } = await this.rep.build(u, { from: period.from, to: period.to, department_id: s.department_id ?? undefined, doctors: s.include_doctors }, s.formats);
        r.files = files.map((f) => f.name); r.bytes = files.reduce((a, f) => a + f.body.length, 0);
        if (opts.dry_run) { r.error = 'სატესტო გაშვება — ელფოსტა არ გაიგზავნა'; }
        else if (!smtp) { r.status = 'failed'; r.error = 'ელფოსტა (SMTP) კონფიგურირებული არ არის'; }
        else {
          const red = data.prev.kpis.filter((k) => k.status === 'red').map((k) => `  • ${k.name}: ${k.value ?? '—'} (სამიზნე ${k.target})`);
          const fin = data.finance ? `\nშემოსავალი (წმინდა): ${data.finance.totals.rev_net.toLocaleString('en-US')} ₾ · შედეგი: ${data.finance.totals.result.toLocaleString('en-US')} ₾\n` : '';
          const text = [`${data.title}`, `${data.clinic} · ${data.scope_label}`, `პერიოდი: ${period.from} — ${period.to}`, fin,
            red.length ? `სამიზნეს ვერ აკმაყოფილებს (${red.length}):\n${red.join('\n')}` : 'ყველა მაჩვენებელი სამიზნის ფარგლებშია ან სამიზნე არ არის დაწესებული.',
            '', `დანართი: ${r.files.join(', ')}`, data.note ? `\n${data.note}` : '',
            '', '— ავტომატური წერილი (EMR, მენეჯერული რეპორტინგი). შეიცავს მხოლოდ აგრეგირებულ მონაცემებს, პაციენტის მონაცემების გარეშე.',
            `განრიგი: ${s.name}`].join('\n');
          const res = await this.notify.email([u.email], `${data.title} · ${data.scope_label}`, text, files.map((f) => ({ filename: f.name, content: f.body, contentType: f.type })));
          if (res.errors.length) { r.status = 'failed'; r.error = res.errors.join('; ').slice(0, 500); } else r.status = 'sent';
        }
      } catch (e) { r.status = opts.dry_run ? 'skipped' : (r.files.length ? 'failed' : 'skipped'); r.error = (e as Error).message?.slice(0, 500) ?? 'შეცდომა';
        const code = (e as { response?: { code?: string; message?: string } }).response; if (code?.message) r.error = code.message; }
      await this.c.db.insertInto('rpt_deliveries').values({ schedule_id: s.id, period: period.period, date_from: period.from, date_to: period.to, user_id: u ? uid : null, email: r.email,
        status: r.status, error: r.error, files: r.files, bytes: r.bytes, manual: opts.manual, created_by: opts.by ?? null }).execute();
      out.push(r);
    }
    return out;
  }

  /** ხელით გაშვება (ადმინისტრირება): ნაგულისხმევად — განრიგის მიმდინარე პერიოდი; last_period არ იცვლება */
  async run(id: string, d: RunDto, u: AuthUser, ctx: AuditContext) {
    const s = await this.c.db.selectFrom('rpt_schedules').selectAll().where('id', '=', id).executeTakeFirst();
    if (!s) throw new NotFoundException('განრიგი ვერ მოიძებნა');
    const { today } = await this.now();
    const p = schedulePeriod(s, today);
    let period = { period: p.period, from: p.from, to: p.to };
    if (d.from || d.to) {
      if (!d.from || !d.to || d.from > d.to) throw new BadRequestException('პერიოდი: from ≤ to');
      period = { period: d.from.endsWith('-01') && d.to === monthEnd(d.from.slice(0, 7)) ? d.from.slice(0, 7) : d.from, from: d.from, to: d.to };
    }
    const res = await this.send(s, period, { manual: true, dry_run: !!d.dry_run, by: u.id });
    await this.audit.log(ctx, { action: 'REPORT_SCHEDULE_RUN', entityName: 'rpt_schedules', entityId: id,
      newData: { ...period, dry_run: !!d.dry_run, sent: res.filter((r) => r.status === 'sent').length, failed: res.filter((r) => r.status === 'failed').length, phi: false } });
    return { ...period, label: periodLabel(period.from, period.to), dry_run: !!d.dry_run, results: res };
  }

  // ------------------------------------------------------------------------------------ worker
  async tick() {
    if (this.busy) return null;
    this.busy = true;
    try {
      return await this.c.db.transaction().execute(async (trx) => {
        const got = (await sql<{ ok: boolean }>`SELECT pg_try_advisory_xact_lock(${LOCK_KEY}) AS ok`.execute(trx)).rows[0].ok;
        if (!got) return null;
        const mod = await this.c.db.selectFrom('system_modules').select('enabled').where('code', '=', 'reporting').executeTakeFirst();
        if (!mod?.enabled) return null;
        return { schedules: await this.scheduleTick(), attention: await this.attentionTick() };
      });
    } finally { this.busy = false; }
  }

  async scheduleTick() {
    const { today, hour } = await this.now();
    const list = await this.c.db.selectFrom('rpt_schedules').selectAll().where('is_active', '=', true).execute();
    let sent = 0;
    for (const s of list) {
      const p = schedulePeriod(s, today);
      if (s.last_period === p.period || today < p.due_day || (today === p.due_day && hour < s.send_hour)) continue;
      // მომდევნო პერიოდის გამოტოვება აღარ: გვიან (worker გაჩერებული) — მაინც იგზავნება მიმდინარე პერიოდი
      const claimed = await this.c.db.updateTable('rpt_schedules').set({ last_period: p.period, last_run_at: sql`now()` })
        .where('id', '=', s.id).where((eb) => eb.or([eb('last_period', 'is', null), eb('last_period', '<>', p.period)])).returning('id').executeTakeFirst();
      if (!claimed) continue;
      try {
        const res = await this.send(s, p, { manual: false });
        sent += res.filter((r) => r.status === 'sent').length;
        this.log.log(`ანგარიში „${s.name}“ ${p.period}: ${res.map((r) => `${r.user_name} — ${r.status}`).join(', ')}`);
      } catch (e) { this.log.error(`ანგარიში „${s.name}“: ${(e as Error).message}`); }
    }
    return sent;
  }

  /** „ყურადღება“ → შეტყობინება: დღეში ერთხელ (attention_notify_hour-დან), RPT_READ მომხმარებლებზე */
  async attentionTick(force = false, onlyUser?: string) {
    const s = await this.c.settings();
    if (s.attention_notify === 'off') return 0;
    const { today, hour } = await this.now();
    if (!force && hour < s.attention_notify_hour) return 0;
    const users = await sql<{ id: string }>`
      SELECT u.id FROM users u JOIN user_capabilities c ON c.user_id = u.id
       WHERE u.is_active AND c.capabilities::text[] && ${RPT_READ_CAPS}::text[]
         ${onlyUser ? sql`AND u.id = ${onlyUser}::uuid` : sql``}
         AND NOT EXISTS (SELECT 1 FROM rpt_attention_sent a WHERE a.user_id = u.id AND a.day = ${today}::date AND a.item_key = '__run__')`.execute(this.c.db);
    let n = 0;
    for (const { id } of users.rows) {
      await this.c.db.insertInto('rpt_attention_sent').values({ user_id: id, day: today, item_key: '__run__' }).onConflict((oc) => oc.doNothing()).execute();
      const u = await this.asUser(id);
      if (!u) continue;
      let items: Awaited<ReturnType<ReportingDashService['attention']>>['items'];
      try { items = (await this.dash.attention(u, {})).items; } catch { continue; }   // NO_SCOPE და სხვ. — გამოტოვება
      items = items.filter((x) => s.attention_notify_level === 'all' || x.severity === 'red');
      if (!items.length) continue;
      const keys = items.map((x) => `${x.kind}:${x.code ?? ''}`.slice(0, 60));
      const fresh = (await this.c.db.selectFrom('rpt_attention_sent').select('item_key').where('user_id', '=', id).where('day', '=', today).where('item_key', 'in', keys).execute())
        .map((r) => r.item_key);
      const list = items.filter((_, i) => !fresh.includes(keys[i]));
      if (!list.length) continue;
      await this.c.db.insertInto('rpt_attention_sent').values(list.map((x) => ({ user_id: id, day: today, item_key: `${x.kind}:${x.code ?? ''}`.slice(0, 60) })))
        .onConflict((oc) => oc.doNothing()).execute();
      const red = list.filter((x) => x.severity === 'red').length;
      const title = `მენეჯერული დაფა: ყურადღება — ${list.length} ${red ? `(წითელი ${red})` : ''}`.trim();
      const lines = list.map((x) => `${x.title}${x.value !== null ? `: ${x.value}${x.unit === 'pct' ? '%' : ''}` : ''}`);
      await this.notifications.notify(id, { kind: 'rpt_attention', title, body: list.map((x) => `${x.title} — ${x.detail}`).join('\n').slice(0, 2000), link: '/dashboard',
        entityId: (await sql<{ u: string }>`SELECT md5(${`rpt_attention:${today}`})::uuid::text AS u`.execute(this.c.db)).rows[0].u, item: null, urgent: red > 0 });
      if (s.attention_notify === 'in_app_email' && u.email && this.notify.configured().email)
        await this.notify.email([u.email], title, [`${today} · ${u.name}`, '', ...lines.map((l) => `• ${l}`), '', 'დეტალები: მენეჯერული დაფა → „ყურადღება“.',
          '— ავტომატური შეტყობინება (EMR). აგრეგირებული მაჩვენებლები, პაციენტის მონაცემების გარეშე.'].join('\n'));
      n++;
    }
    return n;
  }
}

@Controller('reporting')
export class RptJobsController {
  constructor(private readonly s: RptJobsService) {}
  @Get('schedules') @Roles(...RPT_CONFIG) list() { return this.s.list(); }
  @Post('schedules') @Roles(...RPT_CONFIG) create(@Body() d: ScheduleDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.create(d, auditCtx(r), u); }
  @Patch('schedules/:id') @Roles(...RPT_CONFIG) patch(@Param('id', ParseUUIDPipe) id: string, @Body() d: SchedulePatchDto, @Req() r: Request) { return this.s.patch(id, d, auditCtx(r)); }
  @Delete('schedules/:id') @Roles(...RPT_CONFIG) remove(@Param('id', ParseUUIDPipe) id: string, @Req() r: Request) { return this.s.remove(id, auditCtx(r)); }
  @Post('schedules/:id/run') @HttpCode(200) @Roles(...RPT_CONFIG)
  run(@Param('id', ParseUUIDPipe) id: string, @Body() d: RunDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.run(id, d, u, auditCtx(r)); }
  @Get('recipients') @Roles(...RPT_CONFIG) recipients() { return this.s.recipients(); }
  @Get('deliveries') @Roles(...RPT_CONFIG) deliveries(@Query() q: { schedule_id?: string; limit?: string }) { return this.s.deliveries(q); }
  /** „ყურადღების“ შეტყობინება ახლავე — მხოლოდ საკუთარ თავზე (შემოწმება); დღეში ერთხელ */
  @Post('attention/notify-me') @HttpCode(200) @Roles(...RPT_READ)
  async notifyMe(@CurrentUser() u: AuthUser) { return { notified: await this.s.attentionTick(true, u.id) }; }
}
