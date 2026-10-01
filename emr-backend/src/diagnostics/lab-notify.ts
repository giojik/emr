import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { InjectDb, type Database } from '../database/database.module';
import { NotificationsService } from '../notifications/notifications';

/**
 * ლაბ. პასუხი მზადაა → შეტყობინება დამნიშნავ ექიმს (და ვიზიტის მკურნალ ექიმს, თუ სხვაა). მხოლოდ ექიმის უფლების მქონეს;
 * დამდასტურებელს — არა. კრიტიკული მნიშვნელობა (HH/LL) → სასწრაფო. ერთი ვიზიტის ანალიზები ერთ შეტყობინებაში ერთიანდება.
 */
@Injectable()
export class LabNotifyService {
  constructor(@InjectDb() private readonly db: Database, private readonly n: NotificationsService) {}

  async ready(itemId: string, byUserId: string | null, kind: 'lab_ready' | 'lab_prelim' = 'lab_ready') {
    const it = await this.db.selectFrom('dx_order_items as i').innerJoin('dx_services as s', 's.id', 'i.service_id').innerJoin('patients as p', 'p.id', 'i.patient_id')
      .leftJoin('encounters as e', 'e.id', 'i.encounter_id')
      .select(['i.encounter_id', 'i.ordered_by', 's.name as service', 'p.first_name', 'p.last_name', 'e.attending_doctor_id',
        sql<boolean>`EXISTS (SELECT 1 FROM lab_results r WHERE r.order_item_id = i.id AND r.flag IN ('HH', 'LL'))`.as('critical')])
      .where('i.id', '=', itemId).executeTakeFirst();
    if (!it?.encounter_id) return;
    const ids = [...new Set([it.ordered_by, it.attending_doctor_id].filter((x): x is string => !!x && x !== byUserId))];
    if (!ids.length) return;
    const doctors = await this.db.selectFrom('user_capabilities').select('user_id')
      .where('user_id', 'in', ids).where(sql<boolean>`'doctor' = ANY(capabilities)`).execute();
    for (const d of doctors) {
      if (!d.user_id) continue;
      await this.n.notify(d.user_id, {
        kind: it.critical ? 'lab_critical' : kind, entityId: it.encounter_id, link: `/encounters/${it.encounter_id}`, item: it.service, urgent: it.critical,
        title: it.critical ? '⚠️ კრიტიკული მნიშვნელობა — ანალიზის პასუხი' : kind === 'lab_prelim' ? 'მიკრობიოლოგია — წინასწარი პასუხი' : 'ანალიზის პასუხი მზადაა',
        body: `${it.last_name} ${it.first_name}`,
      });
    }
  }
}
