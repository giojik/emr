import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import { jsonArrayFrom } from 'kysely/helpers/postgres';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { InjectDb, type Database } from '../database/database.module';
import type { CreatePatientDto } from './dto/create-patient.dto';

const LIST_COLUMNS = ['id', 'personal_number', 'passport_number', 'first_name', 'last_name',
  'birth_date', 'gender', 'phone_number'] as const;

@Injectable()
export class PatientsService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService) {}

  /** ძებნა: პირადი № / პასპორტი / ტელეფონი (ზუსტი), გვარი/სახელი (პრეფიქსი + მიახლოებითი, pg_trgm). */
  async search(q: string) {
    const term = q.trim();
    if (term.length < 2) throw new BadRequestException('ძებნის ტექსტი მინიმუმ 2 სიმბოლო');

    return this.db.selectFrom('patients')
      .select(LIST_COLUMNS)
      .where((eb) => eb.or([
        eb('personal_number', '=', term),
        eb('passport_number', '=', term),
        eb('phone_number', '=', term),
        eb('last_name', 'ilike', `${term}%`),
        eb('first_name', 'ilike', `${term}%`),
        sql<boolean>`last_name % ${term}`,          // fuzzy: "ბერიძე" ≈ "ბერიზე"
      ]))
      .orderBy(sql`similarity(last_name, ${term})`, 'desc')
      .orderBy('last_name').orderBy('first_name')
      .limit(50)
      .execute();
  }

  async create(dto: CreatePatientDto, ctx: AuditContext) {
    if (!dto.personal_number && !dto.passport_number) {
      throw new BadRequestException('საჭიროა პირადი ნომერი ან პასპორტის ნომერი');
    }
    try {
      // პაციენტი და აუდიტ-ჩანაწერი ერთ ტრანზაქციაში
      return await this.db.transaction().execute(async (trx) => {
        const patient = await trx.insertInto('patients').values(dto).returningAll().executeTakeFirstOrThrow();
        await this.audit.log(ctx, { action: 'CREATE_PATIENT', entityName: 'patients', entityId: patient.id, newData: patient }, trx);
        return patient;
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new ConflictException('პაციენტი ამ პირადი ნომრით უკვე არსებობს');
      throw e;
    }
  }

  /** პაციენტის ბარათი: დემოგრაფია + აქტიური ალერგიები + ქრონიკული დაავადებები — ერთი SQL query. */
  async findOne(id: string, ctx: AuditContext) {
    const patient = await this.db.selectFrom('patients as p')
      .selectAll('p')
      .select((eb) => [
        jsonArrayFrom(eb.selectFrom('patient_allergies as a')
          .select(['a.id', 'a.substance', 'a.reaction_type', 'a.severity', 'a.created_at'])
          .whereRef('a.patient_id', '=', 'p.id').where('a.is_active', '=', true)
          .orderBy('a.created_at', 'desc')).as('allergies'),
        jsonArrayFrom(eb.selectFrom('patient_chronic_conditions as c')
          .select(['c.id', 'c.icd10_code', 'c.condition_name', 'c.created_at'])
          .whereRef('c.patient_id', '=', 'p.id').where('c.is_active', '=', true)
          .orderBy('c.created_at', 'desc')).as('chronic_conditions'),
      ])
      .where('p.id', '=', id)
      .executeTakeFirst();

    if (!patient) throw new NotFoundException('პაციენტი ვერ მოიძებნა');
    await this.audit.log(ctx, { action: 'VIEW_PATIENT', entityName: 'patients', entityId: id });
    return patient;
  }
}
