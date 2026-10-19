import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { QM_FULL, QmCommon, type QmRules } from './quality-common';

/**
 * worker (ყოველ 10 წუთში), თითო მოვლენა — ერთხელ:
 *  • ტრიაჟის ვადა გადაცილდა (0064) → ხარისხის მენეჯერები (სასწრაფო);
 *  • ანალიზის ვადა: due_warn_days-ით ადრე → გამომძიებელი (ან ხარისხის მენეჯერი); გადაცილდა → გამომძიებელი + ხარისხის მენეჯერი (0065);
 *  • CAPA-ს ვადა: ადრე → პასუხისმგებელი; გადაცილდა → პასუხისმგებელი + ხარისხის მენეჯერი;
 *  • ეფექტიანობის შემოწმების დრო დადგა → ხარისხის მენეჯერი.
 */
@Injectable()
export class QmJobsService {
  constructor(private readonly c: QmCommon) {}

  async tick() {
    const m = await this.c.db.selectFrom('system_modules').select(['enabled', 'settings']).where('code', '=', 'quality').executeTakeFirst();
    if (!m?.enabled) return { overdue: 0, analysis: 0, capa: 0, effectiveness: 0 };
    const r = m.settings as unknown as QmRules;
    const q = (await this.c.usersWith(QM_FULL)).map((x) => x.id);
    const db = this.c.db;

    // ტრიაჟი
    const tri = await db.updateTable('qm_incidents').set({ overdue_notified_at: sql`now()` })
      .where('status', '=', 'submitted').where('triage_due_at', '<', sql<Date>`now()`).where('overdue_notified_at', 'is', null)
      .returning(['id', 'inc_no', 'is_sentinel']).execute();
    for (const x of tri) {
      await this.c.bell(q, { kind: 'qm_overdue', title: `ტრიაჟის ვადა გადაცილებულია: ${x.inc_no}`, body: x.is_sentinel ? 'სენტინელური მოვლენა' : 'შეტყობინება ტრიაჟს ელოდება',
        link: `/quality/incidents/${x.id}`, entityId: x.id, urgent: true });
    }

    // ანალიზი
    const warnDays = Number(r.due_warn_days ?? 3);
    let analysis = 0;
    if (warnDays > 0) {
      const w = await db.updateTable('qm_incidents').set({ analysis_warn_sent_at: sql`now()` })
        .where('status', '=', 'investigation').where('analysis_warn_sent_at', 'is', null).where('analysis_due_at', 'is not', null)
        .where('analysis_due_at', '>=', sql<Date>`now()`).where('analysis_due_at', '<', sql<Date>`now() + make_interval(days => ${warnDays})`)
        .returning(['id', 'inc_no', 'investigator_id', 'analysis_due_at']).execute();
      for (const x of w) {
        await this.c.bell(x.investigator_id ? [x.investigator_id] : q, { kind: 'qm_due', title: `ანალიზის ვადა უახლოვდება: ${x.inc_no}`, link: `/quality/incidents/${x.id}`, entityId: x.id });
      }
      analysis += w.length;
    }
    const o = await db.updateTable('qm_incidents').set({ analysis_overdue_sent_at: sql`now()` })
      .where('status', 'in', ['investigation', 'analysis']).where('analysis_overdue_sent_at', 'is', null).where('analysis_due_at', '<', sql<Date>`now()`)
      .returning(['id', 'inc_no', 'investigator_id', 'status']).execute();
    for (const x of o) {
      const to = x.status === 'analysis' ? q : [...q, ...(x.investigator_id ? [x.investigator_id] : [])];
      await this.c.bell(to, { kind: 'qm_due', title: `ანალიზის ვადა გადაცილებულია: ${x.inc_no}`, body: x.status === 'analysis' ? 'ანალიზი დამტკიცებას ელოდება' : null,
        link: `/quality/incidents/${x.id}`, entityId: x.id, urgent: true });
    }
    analysis += o.length;

    // CAPA
    const today = sql<string>`(now() AT TIME ZONE current_setting('TimeZone'))::date`;
    let capa = 0;
    if (warnDays > 0) {
      const cw = await db.updateTable('qm_capas').set({ warn_sent_at: sql`now()` })
        .where('status', 'in', ['open', 'in_progress']).where('warn_sent_at', 'is', null)
        .where('due_date', '>=', today).where('due_date', '<', sql<string>`(now() AT TIME ZONE current_setting('TimeZone'))::date + ${warnDays}::int`)
        .returning(['id', 'capa_no', 'owner_id', 'title']).execute();
      for (const x of cw) await this.c.bell([x.owner_id], { kind: 'qm_capa_due', title: `ქმედების ვადა უახლოვდება: ${x.capa_no}`, body: x.title, link: `/quality/capas/${x.id}`, entityId: x.id });
      capa += cw.length;
    }
    const co = await db.updateTable('qm_capas').set({ overdue_sent_at: sql`now()` })
      .where('status', 'in', ['open', 'in_progress']).where('overdue_sent_at', 'is', null).where('due_date', '<', today)
      .returning(['id', 'capa_no', 'owner_id', 'title']).execute();
    for (const x of co) {
      await this.c.bell([...q, x.owner_id], { kind: 'qm_capa_due', title: `ქმედების ვადა გადაცილებულია: ${x.capa_no}`, body: x.title, link: `/quality/capas/${x.id}`, entityId: x.id, urgent: true });
    }
    capa += co.length;

    // ეფექტიანობა
    const ef = await db.updateTable('qm_capas').set({ effectiveness_sent_at: sql`now()` })
      .where('status', '=', 'done').where('effectiveness_result', 'is', null).where('effectiveness_sent_at', 'is', null)
      .where('effectiveness_due', 'is not', null).where('effectiveness_due', '<=', today)
      .returning(['id', 'capa_no', 'title']).execute();
    for (const x of ef) await this.c.bell(q, { kind: 'qm_effectiveness', title: `ეფექტიანობის შემოწმება: ${x.capa_no}`, body: x.title, link: `/quality/capas/${x.id}`, entityId: x.id });

    return { overdue: tri.length, analysis, capa, effectiveness: ef.length };
  }
}
