import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { loadEnv } from '../config/env';
import { InjectDb, type Database } from '../database/database.module';
import { NotifyService } from '../notify/notify.service';
import { NotificationsService } from '../notifications/notifications';

const TZ = loadEnv().CLINIC_TZ;
const SEND_FROM_HOUR = 10;

/**
 * სტაციონარის შეხსენებები (emr-worker): 0041 — ვადაგადაცილებები (გადაყვანა, დროებითი გასვლა, დაუხურავი დოკუმენტაცია);
 * 0040 — გეგმიური ჰოსპიტალიზაციის SMS შეხსენება: წინა დღეს, კლინიკის დროით 10:00-დან.
 * იგზავნება მხოლოდ პაციენტის მოქმედი SMS თანხმობით (SMS_NOTIFICATIONS); ჩანაწერზე ერთხელ (sms_sent_at) — თარიღის შეცვლისას თავიდან.
 * მოდული ან პარამეტრი „planned_sms“ გამორთულია → არაფერი.
 */
@Injectable()
export class InpatientRemindersService {
  private readonly log = new Logger('InpatientReminders');
  constructor(@InjectDb() private readonly db: Database, private readonly notify: NotifyService, private readonly bell: NotificationsService) {}

  async tick() {
    const m = await this.db.selectFrom('system_modules').select(['enabled', 'settings']).where('code', '=', 'inpatient').executeTakeFirst();
    if (m?.enabled) await this.overdue(m.settings as Record<string, number>).catch((e) => this.log.error(`ვადაგადაცილებები: ${(e as Error).message}`));
    return this.plannedSms(m);
  }

  private async staff(departmentId: string, caps: string[]) {
    return (await this.db.selectFrom('users as u').innerJoin('user_capabilities as c', 'c.user_id', 'u.id').select('u.id').distinct()
      .where('u.is_active', '=', true).where('u.department_id', '=', departmentId).where(sql<boolean>`c.capabilities && ${sql.val(caps)}::varchar[]`).execute()).map((r) => r.id);
  }

  /**
   * 0041: ვადაგადაცილებები (ზარის შეტყობინება; თითო ჩანაწერზე ერთხელ):
   *   გადაყვანის მოთხოვნა transfer_wait_hours-ზე მეტხანს უპასუხოდ → ორივე განყოფილება;
   *   დროებითი გასვლიდან არ დაბრუნდა expected_return_at-მდე → განყოფილება;
   *   გაწერილი (თვითნებური / გარდაცვალება), დოკუმენტაცია docs_pending_alert_hours-ზე მეტხანს დაუხურავი → მკურნალი ექიმი.
   */
  async overdue(s: Record<string, number>) {
    const waitH = s.transfer_wait_hours ?? 2; const docsH = s.docs_pending_alert_hours ?? 24;
    const tr = await this.db.selectFrom('inpatient_transfers as t').innerJoin('inpatient_stays as st', 'st.encounter_id', 't.encounter_id').innerJoin('patients as p', 'p.id', 'st.patient_id')
      .innerJoin('departments as fd', 'fd.id', 't.from_department_id').innerJoin('departments as td', 'td.id', 't.to_department_id')
      .select(['t.id', 't.encounter_id', 't.from_department_id', 't.to_department_id', 'fd.name as from_name', 'td.name as to_name', 'st.adm_no', 'p.first_name', 'p.last_name'])
      .where('t.status', '=', 'requested').where('t.overdue_notified_at', 'is', null)
      .where(sql<boolean>`t.requested_at < now() - make_interval(hours => ${waitH})`).execute();
    for (const t of tr) {
      for (const [dep, title] of [[t.to_department_id, `${t.to_name}: გადმოყვანის მოთხოვნა ${waitH} სთ-ზე მეტია უპასუხოა`], [t.from_department_id, `${t.to_name}-მა გადაყვანას ჯერ არ უპასუხა`]] as const) {
        for (const id of await this.staff(dep, ['nurse', 'doctor', 'manager'])) {
          await this.bell.notify(id, { kind: 'ipd_transfer_late', title, body: `${t.last_name} ${t.first_name} (${t.adm_no})`, item: t.adm_no, entityId: t.id, link: `/inpatient/stay/${t.encounter_id}`, urgent: true });
        }
      }
      await this.db.updateTable('inpatient_transfers').set({ overdue_notified_at: sql`now()` }).where('id', '=', t.id).execute();
      await this.db.insertInto('inpatient_events').values({ encounter_id: t.encounter_id, kind: 'transfer_overdue', data: JSON.stringify({ transfer_id: t.id, hours: waitH }) }).execute();
    }
    const lv = await this.db.selectFrom('inpatient_leaves as l').innerJoin('inpatient_stays as st', 'st.encounter_id', 'l.encounter_id').innerJoin('patients as p', 'p.id', 'st.patient_id')
      .innerJoin('bed_assignments as a', (j) => j.onRef('a.encounter_id', '=', 'l.encounter_id').on('a.ended_at', 'is', null))
      .select(['l.id', 'l.encounter_id', 'a.department_id', 'st.adm_no', 'p.first_name', 'p.last_name'])
      .where('l.returned_at', 'is', null).where('l.overdue_notified_at', 'is', null).where('l.expected_return_at', '<', sql<Date>`now()`).execute();
    for (const l of lv) {
      for (const id of await this.staff(l.department_id, ['nurse', 'doctor', 'manager'])) {
        await this.bell.notify(id, { kind: 'ipd_leave_late', title: 'პაციენტი დროებითი გასვლიდან არ დაბრუნებულა', body: `${l.last_name} ${l.first_name} (${l.adm_no})`, item: l.adm_no, entityId: l.id, link: `/inpatient/stay/${l.encounter_id}`, urgent: true });
      }
      await this.db.updateTable('inpatient_leaves').set({ overdue_notified_at: sql`now()` }).where('id', '=', l.id).execute();
      await this.db.insertInto('inpatient_events').values({ encounter_id: l.encounter_id, kind: 'leave_overdue', data: JSON.stringify({ leave_id: l.id }) }).execute();
    }
    const docs = await this.db.selectFrom('inpatient_stays as st').innerJoin('encounters as e', 'e.id', 'st.encounter_id').innerJoin('patients as p', 'p.id', 'st.patient_id')
      .select(['st.encounter_id', 'st.adm_no', 'e.attending_doctor_id', 'p.first_name', 'p.last_name'])
      .where('st.status', '=', 'discharged').where('st.closed_at', 'is', null).where(sql<boolean>`st.ended_at < now() - make_interval(hours => ${docsH})`).execute();
    for (const d of docs) {
      if (!d.attending_doctor_id) continue;
      await this.bell.notify(d.attending_doctor_id, { kind: 'ipd_docs_pending', title: 'გაწერილი პაციენტი: დოკუმენტაცია დაუხურავია (ეპიკრიზი / საბოლოო დიაგნოზი)',
        body: `${d.last_name} ${d.first_name} (${d.adm_no})`, item: d.adm_no, entityId: d.encounter_id, link: `/inpatient/stay/${d.encounter_id}` });
    }
    return { transfers: tr.length, leaves: lv.length, docs: docs.length };
  }

  private async plannedSms(m: { enabled: boolean; settings: unknown } | undefined) {
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
