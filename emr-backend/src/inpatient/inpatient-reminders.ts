import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { loadEnv } from '../config/env';
import { InjectDb, type Database } from '../database/database.module';
import { NotifyService } from '../notify/notify.service';

const TZ = loadEnv().CLINIC_TZ;
const SEND_FROM_HOUR = 10;

/**
 * გეგმიური ჰოსპიტალიზაციის SMS შეხსენება (emr-worker, 0040): წინა დღეს, კლინიკის დროით 10:00-დან.
 * იგზავნება მხოლოდ პაციენტის მოქმედი SMS თანხმობით (SMS_NOTIFICATIONS); ჩანაწერზე ერთხელ (sms_sent_at) — თარიღის შეცვლისას თავიდან.
 * მოდული ან პარამეტრი „planned_sms“ გამორთულია → არაფერი.
 */
@Injectable()
export class InpatientRemindersService {
  private readonly log = new Logger('InpatientReminders');
  constructor(@InjectDb() private readonly db: Database, private readonly notify: NotifyService) {}

  async tick() {
    const m = await this.db.selectFrom('system_modules').select(['enabled', 'settings']).where('code', '=', 'inpatient').executeTakeFirst();
    const st = (m?.settings ?? {}) as { planned_queue?: boolean; planned_sms?: boolean };
    if (!m?.enabled || !st.planned_queue || !st.planned_sms || !this.notify.configured().sms) return null;
    const h = (await sql<{ h: number }>`SELECT extract(hour FROM now() AT TIME ZONE ${TZ})::int AS h`.execute(this.db)).rows[0].h;
    if (h < SEND_FROM_HOUR || h >= 21) return null;
    const rows = await this.db.selectFrom('inpatient_planned as pl').innerJoin('patients as p', 'p.id', 'pl.patient_id').innerJoin('departments as d', 'd.id', 'pl.department_id')
      .select(['pl.id', 'pl.plan_no', 'pl.planned_date', 'p.phone_number', 'd.name as department',
        sql<boolean>`(SELECT c.decision = 'granted' AND c.revoked_at IS NULL FROM patient_consents c WHERE c.patient_id = p.id AND c.type_code = 'SMS_NOTIFICATIONS' ORDER BY c.signed_at DESC LIMIT 1)`.as('consent')])
      .where('pl.status', '=', 'waiting').where('pl.sms_sent_at', 'is', null)
      .where(sql<boolean>`pl.planned_date = (now() AT TIME ZONE ${TZ})::date + 1`).execute();
    if (!rows.length) return { sent: 0, skipped: 0 };
    const clinic = await this.db.selectFrom('clinic_settings').select(['name', 'phone']).executeTakeFirst();
    let sent = 0; let skipped = 0;
    for (const r of rows) {
      const [y, mo, dd] = r.planned_date.slice(0, 10).split('-');
      let result: Record<string, unknown>;
      if (!r.consent || !r.phone_number) { result = { skipped: !r.consent ? 'SMS თანხმობა არ არის' : 'ტელეფონი არ არის' }; skipped++; }
      else {
        const text = `${clinic?.name ?? ''}: ხვალ, ${dd}.${mo}.${y}, დაგეგმილია თქვენი ჰოსპიტალიზაცია (${r.department}).${clinic?.phone ? ` ინფორმაცია: ${clinic.phone}` : ''}`;
        const res = await this.notify.sms([r.phone_number], text);
        if (res.errors.length) { this.log.warn(`${r.plan_no}: ${res.errors.join('; ')}`); continue; }     // შემდეგ ტიკზე თავიდან
        result = { sent: r.phone_number }; sent++;
      }
      await this.db.updateTable('inpatient_planned').set({ sms_sent_at: sql`now()` }).where('id', '=', r.id).execute();
      await this.db.insertInto('inpatient_events').values({ planned_id: r.id, kind: 'planned_sms', data: JSON.stringify(result) }).execute();
    }
    if (sent || skipped) this.log.log(`SMS შეხსენება: გაიგზავნა ${sent}, გამოტოვდა ${skipped}`);
    return { sent, skipped };
  }
}
