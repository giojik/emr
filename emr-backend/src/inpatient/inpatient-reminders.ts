import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { loadEnv } from '../config/env';
import { InjectDb, type Database } from '../database/database.module';
import { NotifyService } from '../notify/notify.service';
import { NotificationsService } from '../notifications/notifications';
import { ensureMarSlots } from './mar-schedule';
import { loadBilling } from './ipd-billing-calc';

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
    const o = await this.orders(s);
    const mar = await this.mar(s).catch((e) => { this.log.error(`MAR: ${(e as Error).message}`); return { mar_missed: 0 }; });
    const nur = await this.nursing(s as unknown as Record<string, unknown>).catch((e) => { this.log.error(`საექთნო: ${(e as Error).message}`); return { scales_due: 0, lines_alert: 0 }; });
    const notes = await this.notes(s as unknown as Record<string, unknown>).catch((e) => { this.log.error(`ჩანაწერები: ${(e as Error).message}`); return { notes_due: 0, consults_late: 0 }; });
    const bill = await this.billing(s as unknown as Record<string, unknown>).catch((e) => { this.log.error(`ბილინგი: ${(e as Error).message}`); return { bed_days_synced: 0, deposit_alerts: 0 }; });
    return { transfers: tr.length, leaves: lv.length, docs: docs.length, ...o, ...mar, ...nur, ...notes, ...bill };
  }

  /**
   * 0042: დანიშნულებები — ვადის ამოწურვა (completed), ანტიბიოტიკის დასრულებამდე 24 სთ (ექიმს), დაუდასტურებელი ზეპირი (verbal_confirm_hours).
   */
  async orders(s: Record<string, number>) {
    const done = await this.db.updateTable('med_orders').set({ status: 'completed', stopped_at: sql`end_at` })
      .where('status', 'in', ['active', 'on_hold']).where('end_at', '<', sql<Date>`now()`).returning('id').execute();
    for (const r of done) await this.db.insertInto('med_order_events').values({ order_id: r.id, kind: 'completed', data: JSON.stringify({ auto: true }) }).execute();
    const abx = await this.db.selectFrom('med_orders as o').innerJoin('med_generics as g', 'g.id', 'o.generic_id').innerJoin('encounters as e', 'e.id', 'o.encounter_id')
      .innerJoin('inpatient_stays as st', 'st.encounter_id', 'o.encounter_id').innerJoin('patients as p', 'p.id', 'o.patient_id')
      .select(['o.id', 'o.encounter_id', 'o.ordered_by', 'e.attending_doctor_id', 'g.inn', 'st.adm_no', 'p.first_name', 'p.last_name'])
      .where('o.status', '=', 'active').where('o.end_notified_at', 'is', null).where('g.atc_code', 'like', 'J01%')
      .where('o.end_at', '<', sql<Date>`now() + interval '24 hours'`).execute();
    for (const a of abx) {
      for (const id of new Set([a.ordered_by, a.attending_doctor_id].filter((x): x is string => !!x))) {
        await this.bell.notify(id, { kind: 'ipd_abx_ending', title: `ანტიბიოტიკი სრულდება 24 სთ-ში: ${a.inn} — გააგრძელეთ ან დაასრულეთ`, body: `${a.last_name} ${a.first_name} (${a.adm_no})`,
          item: a.inn, entityId: a.id, link: `/inpatient/stay/${a.encounter_id}?tab=orders`, urgent: false });
      }
      await this.db.updateTable('med_orders').set({ end_notified_at: sql`now()` }).where('id', '=', a.id).execute();
      await this.db.insertInto('med_order_events').values({ order_id: a.id, kind: 'end_reminder', data: '{}' }).execute();
    }
    const vh = s.verbal_confirm_hours ?? 24;
    const verbal = await this.db.selectFrom('med_orders as o').innerJoin('inpatient_stays as st', 'st.encounter_id', 'o.encounter_id').innerJoin('patients as p', 'p.id', 'o.patient_id')
      .leftJoin('med_generics as g', 'g.id', 'o.generic_id')
      .select(['o.id', 'o.encounter_id', 'o.ordered_by', 'st.adm_no', 'p.first_name', 'p.last_name', sql<string>`coalesce(g.inn, o.drug_text, o.text)`.as('name')])
      .where('o.is_verbal', '=', true).where('o.verbal_confirmed_at', 'is', null).where('o.verbal_notified_at', 'is', null).where('o.status', 'in', ['active', 'on_hold'])
      .where(sql<boolean>`o.created_at < now() - make_interval(hours => ${vh})`).execute();
    for (const v of verbal) {
      await this.bell.notify(v.ordered_by, { kind: 'ipd_verbal_confirm', title: `ზეპირი დანიშნულება ${vh} სთ-ზე მეტია დაუდასტურებელია: ${v.name}`, body: `${v.last_name} ${v.first_name} (${v.adm_no})`,
        item: v.name, entityId: v.id, link: `/inpatient/stay/${v.encounter_id}?tab=orders`, urgent: true });
      await this.db.updateTable('med_orders').set({ verbal_notified_at: sql`now()` }).where('id', '=', v.id).execute();
    }
    return { orders_completed: done.length, abx_reminders: abx.length, verbal_reminders: verbal.length };
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

  /**
   * 0043 MAR: სლოტების გენერაცია (ყველა აქტიური ჰოსპიტალიზაცია) და გამოტოვებული დოზები:
   *   due, scheduled_at < now − (ფანჯარა + mar_missed_hours) → missed; პაციენტზე ერთი შეტყობინება განყოფილების ექთნებს და მკურნალ ექიმს.
   */
  async mar(s: Record<string, number>) {
    const win = s.mar_window_min ?? 60; const missedH = s.mar_missed_hours ?? 2;
    await ensureMarSlots(this.db, TZ, { mar_window_min: win, mar_horizon_hours: s.mar_horizon_hours ?? 48 });
    const rows = await sql<{ id: string; encounter_id: string }>`
      UPDATE mar_entries SET status = 'missed', missed_notified_at = now()
      WHERE status = 'due' AND voided_at IS NULL AND scheduled_at < now() - make_interval(mins => ${win}) - make_interval(hours => ${missedH})
      RETURNING id, encounter_id`.execute(this.db);
    const byEnc = new Map<string, number>();
    for (const r of rows.rows) byEnc.set(r.encounter_id, (byEnc.get(r.encounter_id) ?? 0) + 1);
    for (const [enc, n] of byEnc) {
      const st = await this.db.selectFrom('inpatient_stays as st').innerJoin('encounters as e', 'e.id', 'st.encounter_id').innerJoin('patients as p', 'p.id', 'st.patient_id')
        .leftJoin('bed_assignments as a', (j) => j.onRef('a.encounter_id', '=', 'st.encounter_id').on('a.ended_at', 'is', null))
        .select(['st.adm_no', 'e.attending_doctor_id', 'a.department_id', 'p.first_name', 'p.last_name']).where('st.encounter_id', '=', enc).executeTakeFirst();
      if (!st) continue;
      const to = new Set<string>(st.department_id ? await this.staff(st.department_id, ['nurse']) : []);
      if (st.attending_doctor_id) to.add(st.attending_doctor_id);
      for (const id of to) {
        await this.bell.notify(id, { kind: 'ipd_mar_missed', title: `MAR: გამოტოვებული დოზა (${n})`, body: `${st.last_name} ${st.first_name} (${st.adm_no})`,
          item: st.adm_no, entityId: enc, link: `/inpatient/stay/${enc}`, urgent: true });
      }
      await this.db.insertInto('inpatient_events').values({ encounter_id: enc, kind: 'mar_missed', data: JSON.stringify({ count: n }) }).execute();
    }
    return { mar_missed: rows.rows.length };
  }

  /**
   * 0044: სავალდებულო შკალები (scale_defs.required): ჰოსპიტალიზაციიდან 24 სთ-ში, შემდეგ reassess_hours — ვადის გასვლაზე განყოფილების ექთნებს (ერთხელ ვადაზე);
   *   ხაზები / დრენაჟები: line_alert_hours[kind] სთ-ზე მეტი — ექთნებს და მკურნალ ექიმს (ერთხელ).
   */
  async nursing(s: Record<string, unknown>) {
    let scales = 0;
    if (s.scale_reminders !== false) {
      const due = await sql<{ encounter_id: string; code: string; name: string; due_at: string; adm_no: string; first_name: string; last_name: string; department_id: string }>`
        SELECT st.encounter_id, d.code, d.name, x.due_at, st.adm_no, p.first_name, p.last_name, a.department_id
        FROM inpatient_stays st
        JOIN patients p ON p.id = st.patient_id
        JOIN bed_assignments a ON a.encounter_id = st.encounter_id AND a.ended_at IS NULL
        CROSS JOIN scale_defs d
        CROSS JOIN LATERAL (SELECT coalesce(
            (SELECT max(sa.assessed_at) + make_interval(hours => d.reassess_hours) FROM scale_assessments sa WHERE sa.encounter_id = st.encounter_id AND sa.scale_code = d.code AND sa.voided_at IS NULL),
            st.admitted_at + interval '24 hours') AS due_at) x
        WHERE st.status = 'active' AND d.required AND d.is_active AND d.reassess_hours IS NOT NULL AND x.due_at < now()
          AND NOT EXISTS (SELECT 1 FROM inpatient_leaves l WHERE l.encounter_id = st.encounter_id AND l.returned_at IS NULL)`.execute(this.db);
      for (const r of due.rows) {
        const ins = await sql`INSERT INTO ipd_reminders (encounter_id, kind, ref) VALUES (${r.encounter_id}, 'scale_due', ${`${r.code}:${new Date(r.due_at).toISOString()}`})
          ON CONFLICT DO NOTHING RETURNING encounter_id`.execute(this.db);
        if (!ins.rows.length) continue;
        scales++;
        for (const id of await this.staff(r.department_id, ['nurse'])) {
          await this.bell.notify(id, { kind: 'ipd_scale_due', title: `შეფასება ვადაგადაცილებულია: ${r.name}`, body: `${r.last_name} ${r.first_name} (${r.adm_no})`,
            item: r.adm_no, entityId: r.encounter_id, link: `/inpatient/stay/${r.encounter_id}#nursing` });
        }
      }
    }
    const hours = (s.line_alert_hours ?? {}) as Record<string, number>;
    const kinds = Object.entries(hours).filter(([, h]) => h > 0);
    let lines = 0;
    if (kinds.length) {
      const rows = await sql<{ id: string; encounter_id: string; kind: string; site: string | null; adm_no: string; first_name: string; last_name: string; department_id: string; attending_doctor_id: string | null; hours: number }>`
        SELECT l.id, l.encounter_id, l.kind, l.site, st.adm_no, p.first_name, p.last_name, a.department_id, e.attending_doctor_id, (extract(epoch FROM now() - l.inserted_at) / 3600)::int AS hours
        FROM lines_drains l
        JOIN inpatient_stays st ON st.encounter_id = l.encounter_id AND st.status = 'active'
        JOIN encounters e ON e.id = l.encounter_id
        JOIN patients p ON p.id = st.patient_id
        JOIN bed_assignments a ON a.encounter_id = l.encounter_id AND a.ended_at IS NULL
        JOIN (SELECT k, h FROM jsonb_each_text(${JSON.stringify(Object.fromEntries(kinds))}::jsonb) AS t(k, h)) cfg ON cfg.k = l.kind
        WHERE l.removed_at IS NULL AND l.voided_at IS NULL AND l.alert_notified_at IS NULL AND l.inserted_at < now() - make_interval(hours => cfg.h::int)`.execute(this.db);
      for (const l of rows.rows) {
        const to = new Set(await this.staff(l.department_id, ['nurse']));
        if (l.attending_doctor_id) to.add(l.attending_doctor_id);
        for (const id of to) {
          await this.bell.notify(id, { kind: 'ipd_line_due', title: `კათეტერი / დრენაჟი ${l.hours} სთ — შეაფასეთ საჭიროება / შეცვლა`, body: `${l.last_name} ${l.first_name} (${l.adm_no})${l.site ? ` — ${l.site}` : ''}`,
            item: l.adm_no, entityId: l.encounter_id, link: `/inpatient/stay/${l.encounter_id}#nursing` });
        }
        await this.db.updateTable('lines_drains').set({ alert_notified_at: sql`now()` }).where('id', '=', l.id).execute();
        lines++;
      }
    }
    return { scales_due: scales, lines_alert: lines };
  }

  /**
   * 0045: მიმღები გასინჯვა admission_note_hours-ში არ არის → მკურნალ ექიმს (ერთხელ);
   *   დღიური: progress_reminder_time-ის შემდეგ, გუშინდელი არ წერია → მკურნალ ექიმს (ერთხელ დღეზე);
   *   კონსულტაცია ვადაგადაცილებული → კონსულტანტს / განყოფილების ექიმებს და მომთხოვნს (ერთხელ).
   */
  async notes(s: Record<string, unknown>) {
    let notes = 0;
    const admH = Number(s.admission_note_hours ?? 24);
    const adm = await sql<{ encounter_id: string; attending_doctor_id: string | null; adm_no: string; first_name: string; last_name: string }>`
      SELECT st.encounter_id, e.attending_doctor_id, st.adm_no, p.first_name, p.last_name FROM inpatient_stays st JOIN encounters e ON e.id = st.encounter_id JOIN patients p ON p.id = st.patient_id
      WHERE st.status = 'active' AND st.admitted_at < now() - make_interval(hours => ${admH})
        AND NOT EXISTS (SELECT 1 FROM doctor_notes n WHERE n.encounter_id = st.encounter_id AND n.kind = 'admission' AND n.status = 'signed')`.execute(this.db);
    for (const r of adm.rows) {
      if (!r.attending_doctor_id) continue;
      const ins = await sql`INSERT INTO ipd_reminders (encounter_id, kind, ref) VALUES (${r.encounter_id}, 'adm_note', 'x') ON CONFLICT DO NOTHING RETURNING encounter_id`.execute(this.db);
      if (!ins.rows.length) continue;
      notes++;
      await this.bell.notify(r.attending_doctor_id, { kind: 'ipd_note_due', title: 'მიმღები გასინჯვა არ არის ხელმოწერილი', body: `${r.last_name} ${r.first_name} (${r.adm_no})`,
        item: r.adm_no, entityId: r.encounter_id, link: `/inpatient/stay/${r.encounter_id}#notes`, urgent: false });
    }
    if (s.progress_note_daily !== false) {
      const time = typeof s.progress_reminder_time === 'string' ? s.progress_reminder_time : '12:00';
      const prog = await sql<{ encounter_id: string; attending_doctor_id: string | null; adm_no: string; first_name: string; last_name: string; d: string }>`
        SELECT st.encounter_id, e.attending_doctor_id, st.adm_no, p.first_name, p.last_name, to_char((now() AT TIME ZONE ${TZ})::date - 1, 'YYYY-MM-DD') AS d
        FROM inpatient_stays st JOIN encounters e ON e.id = st.encounter_id JOIN patients p ON p.id = st.patient_id
        WHERE st.status = 'active' AND (now() AT TIME ZONE ${TZ})::time >= ${time}::time
          AND (st.admitted_at AT TIME ZONE ${TZ})::date < (now() AT TIME ZONE ${TZ})::date - 1
          AND NOT EXISTS (SELECT 1 FROM doctor_notes n WHERE n.encounter_id = st.encounter_id AND n.kind = 'progress' AND n.status = 'signed'
            AND n.note_date = (now() AT TIME ZONE ${TZ})::date - 1)`.execute(this.db);
      for (const r of prog.rows) {
        if (!r.attending_doctor_id) continue;
        const ins = await sql`INSERT INTO ipd_reminders (encounter_id, kind, ref) VALUES (${r.encounter_id}, 'progress', ${r.d}) ON CONFLICT DO NOTHING RETURNING encounter_id`.execute(this.db);
        if (!ins.rows.length) continue;
        notes++;
        await this.bell.notify(r.attending_doctor_id, { kind: 'ipd_note_due', title: `დღიური აკლია (${r.d.split('-').reverse().join('/')})`, body: `${r.last_name} ${r.first_name} (${r.adm_no})`,
          item: r.adm_no, entityId: r.encounter_id, link: `/inpatient/stay/${r.encounter_id}#notes` });
      }
    }
    const late = await sql<{ id: string; encounter_id: string; requested_by: string; target_doctor_id: string | null; target_department_id: string | null; urgency: string; adm_no: string; first_name: string; last_name: string }>`
      UPDATE consultations c SET overdue_notified_at = now() FROM inpatient_stays st JOIN patients p ON p.id = st.patient_id
      WHERE st.encounter_id = c.encounter_id AND c.status = 'requested' AND c.overdue_notified_at IS NULL AND c.due_at < now()
      RETURNING c.id, c.encounter_id, c.requested_by, c.target_doctor_id, c.target_department_id, c.urgency, st.adm_no, p.first_name, p.last_name`.execute(this.db);
    for (const c of late.rows) {
      const to = new Set<string>([c.requested_by]);
      if (c.target_doctor_id) to.add(c.target_doctor_id);
      else if (c.target_department_id) for (const id of await this.staff(c.target_department_id, ['doctor'])) to.add(id);
      for (const id of to) {
        await this.bell.notify(id, { kind: 'ipd_consult_late', title: 'კონსულტაცია ვადაგადაცილებულია', body: `${c.last_name} ${c.first_name} (${c.adm_no})`, item: c.adm_no,
          entityId: c.id, link: id === c.requested_by ? `/inpatient/stay/${c.encounter_id}#notes` : '/inpatient?tab=consults', urgent: c.urgency !== 'routine' });
      }
    }
    return { notes_due: notes, consults_late: late.rows.length };
  }

  /**
   * 0046: ბილინგი — აქტიური ჰოსპიტალიზაციების საწოლდღეები (შუაღამის აღრიცხვა; იდემპოტენტური);
   * პაციენტის წილი (შეფასებით) ავანსს deposit_alert_amount-ზე მეტით აჭარბებს → ბილინგის თანამშრომლებს (დღეში ერთხელ).
   */
  async billing(s: Record<string, unknown>) {
    const stays = await this.db.selectFrom('inpatient_stays as st').innerJoin('invoices as i', 'i.encounter_id', 'st.encounter_id')
      .select(['st.encounter_id']).where('st.status', '=', 'active').where('i.finalized_at', 'is', null).execute();
    for (const st of stays) await sql`SELECT ipd_sync_bed_days(${st.encounter_id}::uuid, ${TZ}, ${s.leave_counts_bed_day !== false})`.execute(this.db);
    const limit = Number(s.deposit_alert_amount ?? 500);
    let alerts = 0;
    if (limit > 0 && stays.length) {
      const today = (await sql<{ d: string }>`SELECT to_char(now() AT TIME ZONE ${TZ}, 'YYYY-MM-DD') AS d`.execute(this.db)).rows[0].d;
      const users = (await this.db.selectFrom('users as u').innerJoin('user_capabilities as c', 'c.user_id', 'u.id').select('u.id').distinct()
        .where('u.is_active', '=', true).where(sql<boolean>`'billing' = ANY(c.capabilities)`).execute()).map((r) => r.id);
      for (const st of stays) {
        const b = await loadBilling(this.db, st.encounter_id);
        if (!b) continue;
        const over = b.money.patient - b.money.deposit_net - b.money.paid;
        if (over <= limit) continue;
        const sb = await this.db.selectFrom('stay_billing as sb').innerJoin('inpatient_stays as x', 'x.encounter_id', 'sb.encounter_id').innerJoin('patients as p', 'p.id', 'x.patient_id')
          .select(['sb.alert_notified_on', 'x.adm_no', 'p.first_name', 'p.last_name', sql<string>`to_char(sb.alert_notified_on, 'YYYY-MM-DD')`.as('day')])
          .where('sb.encounter_id', '=', st.encounter_id).executeTakeFirst();
        if (!sb || sb.day === today) continue;
        for (const id of users) {
          await this.bell.notify(id, { kind: 'ipd_deposit_low', title: `ავანსი არასაკმარისია: დავალიანება ${over.toFixed(2)} ₾`, body: `${sb.last_name} ${sb.first_name} (${sb.adm_no})`,
            item: sb.adm_no, entityId: st.encounter_id, link: `/inpatient/stay/${st.encounter_id}#billing` });
        }
        await this.db.updateTable('stay_billing').set({ alert_notified_on: today }).where('encounter_id', '=', st.encounter_id).execute();
        alerts++;
      }
    }
    return { bed_days_synced: stays.length, deposit_alerts: alerts };
  }
}
