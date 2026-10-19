import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { QM_FULL, QmCommon } from './quality-common';

/** worker (ყოველ 10 წუთში): ტრიაჟის ვადა გადაცილდა → ხარისხის მენეჯერებს ერთხელ (სასწრაფო ზარი) */
@Injectable()
export class QmJobsService {
  constructor(private readonly c: QmCommon) {}

  async tick() {
    const m = await this.c.db.selectFrom('system_modules').select('enabled').where('code', '=', 'quality').executeTakeFirst();
    if (!m?.enabled) return { overdue: 0 };
    const rows = await this.c.db.updateTable('qm_incidents').set({ overdue_notified_at: sql`now()` })
      .where('status', '=', 'submitted').where('triage_due_at', '<', sql<Date>`now()`).where('overdue_notified_at', 'is', null)
      .returning(['id', 'inc_no', 'is_sentinel']).execute();
    if (!rows.length) return { overdue: 0 };
    const q = (await this.c.usersWith(QM_FULL)).map((x) => x.id);
    for (const r of rows) {
      await this.c.bell(q, { kind: 'qm_overdue', title: `ტრიაჟის ვადა გადაცილებულია: ${r.inc_no}`, body: r.is_sentinel ? 'სენტინელური მოვლენა' : 'შეტყობინება ტრიაჟს ელოდება',
        link: `/quality/incidents/${r.id}`, entityId: r.id, urgent: true });
    }
    return { overdue: rows.length };
  }
}
