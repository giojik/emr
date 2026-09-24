import { BadRequestException, Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { sql } from 'kysely';
import { Roles } from '../auth/decorators';
import { InjectDb, type Database } from '../database/database.module';

const range = (from?: string, to?: string) => {
  const f = from ? new Date(from) : new Date(Date.now() - 30 * 86_400_000);
  const t = to ? new Date(to) : new Date();
  if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) throw new BadRequestException('from/to: თარიღის ფორმატი');
  return { f, t };
};

@Injectable()
export class ReportsService {
  constructor(@InjectDb() private readonly db: Database) {}

  /** ალერგიის გაფრთხილების გადალახვები — ხარისხის კონტროლისთვის (ყოველთვიური განხილვა) */
  allergyOverrides(from?: string, to?: string) {
    const { f, t } = range(from, to);
    return this.db.selectFrom('prescriptions as rx')
      .innerJoin('encounters as e', 'e.id', 'rx.encounter_id')
      .innerJoin('patients as p', 'p.id', 'e.patient_id')
      .leftJoin('users as u', 'u.id', 'rx.prescribed_by')
      .select(['rx.id', 'rx.created_at', 'rx.medication_name', 'rx.dosage', 'rx.allergy_alert_level', 'rx.allergy_override_reason', 'rx.allergy_matches',
        'rx.encounter_id', 'p.first_name as patient_first_name', 'p.last_name as patient_last_name', 'p.personal_number',
        sql<string>`u.first_name || ' ' || u.last_name`.as('doctor_name'), 'rx.prescribed_by'])
      .where('rx.allergy_alert_level', 'in', ['warning', 'warning_reason', 'block'])
      .where('rx.created_at', '>=', f).where('rx.created_at', '<', t)
      .orderBy('rx.created_at', 'desc').limit(1000).execute();
  }

  /** აუდიტ-ჟურნალი — მხოლოდ ნახვა */
  audit(q: { entity_name?: string; entity_id?: string; user_id?: string; action?: string; from?: string; to?: string; limit?: string }) {
    const { f, t } = range(q.from, q.to);
    let query = this.db.selectFrom('audit_logs as a').leftJoin('users as u', 'u.id', 'a.user_id')
      .select(['a.id', 'a.created_at', 'a.action', 'a.entity_name', 'a.entity_id', 'a.ip_address', 'a.user_id', 'a.old_data', 'a.new_data',
        sql<string | null>`u.first_name || ' ' || u.last_name`.as('user_name')])
      .where('a.created_at', '>=', f).where('a.created_at', '<', t)
      .orderBy('a.id', 'desc').limit(Math.min(Number(q.limit) || 200, 1000));
    if (q.entity_name) query = query.where('a.entity_name', '=', q.entity_name);
    if (q.entity_id) query = query.where('a.entity_id', '=', q.entity_id);
    if (q.user_id) query = query.where('a.user_id', '=', q.user_id);
    if (q.action) query = query.where('a.action', 'ilike', `%${q.action}%`);
    return query.execute();
  }
}

@Controller()
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('reports/allergy-overrides') @Roles('admin', 'pharmacist')
  overrides(@Query('from') from?: string, @Query('to') to?: string) { return this.reports.allergyOverrides(from, to); }

  @Get('audit-logs') @Roles('admin')
  audit(@Query() q: Record<string, string>) { return this.reports.audit(q); }
}

@Module({ controllers: [ReportsController], providers: [ReportsService] })
export class ReportsModule {}
