import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { loadEnv } from '../config/env';
import { InjectDb, type Database } from '../database/database.module';
import { NotifyService, type NotifyResult } from '../notify/notify.service';

type Kind = 'disconnected' | 'silent' | 'gateway';

/**
 * ანალიზატორების გაფრთხილებები: კავშირის გაწყვეტა, „ჩუმი“ ანალიზატორი (სამუშაო საათებში), gateway-ის გაჩერება.
 * თითო (ანალიზატორი, ტიპი) — ერთი ღია გაფრთხილება; გახსნისას და (სურვილისამებრ) აღდგენისას — SMS + ელ-ფოსტა.
 * ანალიზატორებს ამოწმებს gateway (ყოველ წუთს), თავად gateway-ს — emr-worker (პულსით).
 */
@Injectable()
export class LabAlertsService {
  private readonly tz = loadEnv().CLINIC_TZ;
  private readonly log = new Logger('LabAlerts');
  constructor(@InjectDb() private readonly db: Database, private readonly notify: NotifyService) {}

  settings() { return this.db.selectFrom('lab_gateway_alert_settings').selectAll().where('id', '=', 1).executeTakeFirstOrThrow(); }

  /** კლინიკის დროით: კვირის დღე (1–7), წუთები შუაღამიდან */
  private clinicNow(d = new Date()) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: this.tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
      .formatToParts(d).map((x) => [x.type, x.value]));
    const wd = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday) + 1;
    return { weekday: wd, minutes: (Number(p.hour) % 24) * 60 + Number(p.minute), hhmm: `${p.hour}:${p.minute}` };
  }
  private toMin(t: string) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }

  private async send(subject: string, text: string) {
    const s = await this.settings();
    const out: NotifyResult[] = await Promise.all([this.notify.sms(s.sms_phones, `EMR ლაბ.: ${text}`), this.notify.email(s.emails, `EMR: ${subject}`, `${text}\n\n— EMR, ანალიზატორების gateway (ადმინისტრირება → ანალიზატორები)`)]);
    return { sms: out[0].sent, email: out[1].sent, errors: [...out[0].errors, ...out[1].errors] };
  }

  async open(instrumentId: string | null, kind: Kind, message: string) {
    const row = await this.db.insertInto('lab_gateway_alerts').values({ instrument_id: instrumentId, kind, message })
      .onConflict((oc) => oc.expression(sql`coalesce(instrument_id, '00000000-0000-0000-0000-000000000000'::uuid), kind`).where('resolved_at', 'is', null).doNothing())
      .returning('id').executeTakeFirst();
    if (!row) return false;                                   // უკვე ღიაა — ხელახლა არ ვაგზავნით
    this.log.warn(message);
    const n = await this.send(message, message);
    await this.db.updateTable('lab_gateway_alerts').set({ notified: JSON.stringify(n) }).where('id', '=', row.id).execute();
    return true;
  }
  async resolve(instrumentId: string | null, kind: Kind, text: string) {
    let q = this.db.updateTable('lab_gateway_alerts').set({ resolved_at: sql`now()` }).where('kind', '=', kind).where('resolved_at', 'is', null);
    q = instrumentId ? q.where('instrument_id', '=', instrumentId) : q.where('instrument_id', 'is', null);
    const rows = await q.returning('id').execute();
    if (!rows.length) return;
    const s = await this.settings();
    if (!s.enabled || !s.notify_resolved) return;
    const n = await this.send(`აღდგა — ${text}`, `აღდგა: ${text}`);
    await this.db.updateTable('lab_gateway_alerts').set({ notified_resolved: JSON.stringify(n) }).where('id', 'in', rows.map((r) => r.id)).execute();
  }

  /** ყველა ჩართული ანალიზატორი (gateway ყოველ წუთს) */
  async evaluateInstruments() {
    const s = await this.settings();
    const rows = await this.db.selectFrom('lab_instruments as i').innerJoin('lab_methods as m', 'm.id', 'i.method_id')
      .select(['i.id', 'm.name', 'i.conn_mode', 'i.host', 'i.port', 'i.status', 'i.down_since', 'i.last_message_at', 'i.status_at', 'i.last_error', 'i.silent_minutes', 'i.listen_only',
        'i.alerts_enabled', 'i.is_enabled', 'm.is_active'])
      .execute();
    const now = Date.now(); const cn = this.clinicNow();
    const ws = this.toMin(String(s.work_start).slice(0, 5)); const we = this.toMin(String(s.work_end).slice(0, 5));
    const workNow = s.work_days.includes(cn.weekday) && cn.minutes >= ws && cn.minutes < we;
    for (const r of rows) {
      const active = s.enabled && r.is_enabled && r.is_active && r.alerts_enabled;
      const addr = r.conn_mode === 'client' ? `${r.host}:${r.port}` : `:${r.port}`;
      // კავშირი
      const downMin = r.down_since ? (now - new Date(r.down_since).getTime()) / 60_000 : 0;
      if (active && r.down_since && downMin >= s.disconnect_minutes) {
        await this.open(r.id, 'disconnected', `${r.name} (${addr}) — კავშირი არ არის ${Math.round(downMin)} წთ${r.last_error ? `: ${r.last_error}` : ''}`);
      } else if (!r.down_since || !active) await this.resolve(r.id, 'disconnected', `${r.name} — კავშირი აღდგა`);
      // „ჩუმი“ — მხოლოდ სამუშაო საათებში და მხოლოდ მაშინ, როცა სამუშაო დღე უკვე ზღვარზე დიდხანს გრძელდება
      const limit = r.silent_minutes ?? s.silent_minutes;
      const last = r.last_message_at ? new Date(r.last_message_at).getTime() : null;
      const silentMin = last ? (now - last) / 60_000 : Infinity;
      const silent = active && !r.listen_only && !r.down_since && workNow && cn.minutes - ws >= limit && silentMin >= limit;
      if (silent) await this.open(r.id, 'silent', `${r.name} — ${last ? `${Math.round(silentMin / 60 * 10) / 10} სთ` : 'დიდი ხანია'} არაფერი გამოუგზავნია (კავშირი არის)`);
      else if (!active || (last && silentMin < limit)) await this.resolve(r.id, 'silent', `${r.name} — მონაცემები ისევ მოდის`);
    }
  }

  /** თავად gateway (emr-worker ამოწმებს პულსს) */
  async evaluateGateway() {
    const s = await this.settings();
    const g = await this.db.selectFrom('lab_gateway_state').select('heartbeat_at').where('id', '=', 1).executeTakeFirst();
    const anyEnabled = await this.db.selectFrom('lab_instruments').select('id').where('is_enabled', '=', true).limit(1).executeTakeFirst();
    const stale = !!g && Date.now() - new Date(g.heartbeat_at).getTime() > 3 * 60_000;
    if (s.enabled && anyEnabled && stale) await this.open(null, 'gateway', `emr-lab-gateway არ მუშაობს (ბოლო სიგნალი ${new Date(g!.heartbeat_at).toLocaleString('ka-GE', { timeZone: this.tz })}) — ანალიზატორებთან კავშირი შეწყვეტილია`);
    else if (!stale) await this.resolve(null, 'gateway', 'emr-lab-gateway მუშაობს');
  }

  async test() {
    const s = await this.settings();
    const r = await this.send('სატესტო შეტყობინება', `სატესტო შეტყობინება (${this.clinicNow().hhmm}) — გაფრთხილებები მუშაობს`);
    return { ...r, recipients: { sms: s.sms_phones, email: s.emails }, configured: this.notify.configured() };
  }
}
