import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import { jsonArrayFrom } from 'kysely/helpers/postgres';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { InjectDb, type Database } from '../database/database.module';
import type { CreatePatientDto, UpdatePatientDto } from './dto/create-patient.dto';
import { composeAddress } from './address';

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
        const address = await composeAddress(trx, dto);
        const patient = await trx.insertInto('patients').values({ ...dto, address }).returningAll().executeTakeFirstOrThrow();
        await this.audit.log(ctx, { action: 'CREATE_PATIENT', entityName: 'patients', entityId: patient.id, newData: patient }, trx);
        return patient;
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new ConflictException('პაციენტი ამ პირადი ნომრით უკვე არსებობს');
      throw e;
    }
  }

  /** დემოგრაფიის განახლება (აუდიტი ძველი/ახალი მნიშვნელობით) */
  async update(id: string, dto: UpdatePatientDto, ctx: AuditContext) {
    try {
      return await this.db.transaction().execute(async (trx) => {
        const old = await trx.selectFrom('patients').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
        if (!old) throw new NotFoundException('პაციენტი ვერ მოიძებნა');
        const merged = { ...old, ...dto };
        if (!merged.personal_number && !merged.passport_number) throw new BadRequestException('საჭიროა პირადი ნომერი ან პასპორტის ნომერი');
        const addrTouched = ['address', 'address_unit_code', 'address_district_code', 'address_village', 'address_line', 'address_country'].some((k) => k in dto);
        const address = addrTouched ? await composeAddress(trx, merged) : old.address;
        const p = await trx.updateTable('patients').set({ ...dto, address }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
        const changed = Object.fromEntries(Object.keys({ ...dto, address }).filter((k) => JSON.stringify((old as Record<string, unknown>)[k]) !== JSON.stringify((p as Record<string, unknown>)[k])).map((k) => [k, (p as Record<string, unknown>)[k]]));
        await this.audit.log(ctx, { action: 'UPDATE_PATIENT', entityName: 'patients', entityId: id,
          oldData: Object.fromEntries(Object.keys(changed).map((k) => [k, (old as Record<string, unknown>)[k]])), newData: changed }, trx);
        return p;
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new ConflictException('ამ პირადი ნომრით სხვა პაციენტი უკვე არსებობს');
      throw e;
    }
  }

  addressUnits() {
    return this.db.selectFrom('address_units').select(['code', 'name', 'type', 'parent_code', 'region'])
      .where('is_active', '=', true).orderBy('region').orderBy('name').execute();
  }

  /** სოფლების ავტოშევსება — უკვე რეგისტრირებული პაციენტების მონაცემებიდან ამ მუნიციპალიტეტში */
  async villages(unitCode: string, q: string) {
    const rows = await this.db.selectFrom('patients').select('address_village').distinct()
      .where('address_unit_code', '=', unitCode).where('address_village', 'is not', null)
      .where('address_village', 'ilike', `${q.trim()}%`).orderBy('address_village').limit(15).execute();
    return rows.map((r) => r.address_village);
  }

  /** პაციენტის ბარათი: დემოგრაფია + აქტიური ალერგიები + ქრონიკული დაავადებები — ერთი SQL query. */
  async findOne(id: string, ctx: AuditContext) {
    const patient = await this.db.selectFrom('patients as p')
      .selectAll('p')
      .select((eb) => [
        jsonArrayFrom(eb.selectFrom('patient_allergies as a')
          .select(['a.id', 'a.substance', 'a.reaction_type', 'a.severity', 'a.allergy_type', 'a.created_at'])
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
