import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { InjectDb, type Database } from '../database/database.module';
import type { CreateDepartmentDto, UpdateDepartmentDto } from './departments.dto';

@Injectable()
export class DepartmentsService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService) {}

  list(includeInactive: boolean) {
    let q = this.db.selectFrom('departments as d')
      .select((eb) => ['d.id', 'd.name', 'd.code', 'd.type', 'd.is_active', 'd.created_at', 'd.updated_at', 'd.care_level', 'd.icu_features', 'd.monitor_interval_min',
        eb.selectFrom('users as u').select(eb.fn.countAll<string>().as('c'))
          .whereRef('u.department_id', '=', 'd.id').where('u.is_active', '=', true).as('active_users')])
      .orderBy('d.name');
    if (!includeInactive) q = q.where('d.is_active', '=', true);
    return q.execute();
  }

  async create(dto: CreateDepartmentDto, ctx: AuditContext) {
    if (dto.care_level && dto.care_level !== 'ward' && dto.type !== 'inpatient') throw new BadRequestException('რეანიმაცია / ინტენსიური — მხოლოდ სტაციონარული განყოფილება');
    try {
      return await this.db.transaction().execute(async (trx) => {
        const d = await trx.insertInto('departments').values(dto).returningAll().executeTakeFirstOrThrow();
        await this.audit.log(ctx, { action: 'CREATE_DEPARTMENT', entityName: 'departments', entityId: d.id, newData: d }, trx);
        return d;
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new ConflictException(`კოდი ${dto.code} უკვე არსებობს`);
      throw e;
    }
  }

  async update(id: string, dto: UpdateDepartmentDto, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const old = await trx.selectFrom('departments').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!old) throw new NotFoundException('განყოფილება ვერ მოიძებნა');
      if (Object.keys(dto).length === 0) return old;
      const level = dto.care_level ?? old.care_level; const type = dto.type ?? old.type;
      if (level !== 'ward' && type !== 'inpatient') throw new BadRequestException('რეანიმაცია / ინტენსიური — მხოლოდ სტაციონარული განყოფილება');
      if (old.care_level !== 'ward' && level === 'ward') {
        const open = await trx.selectFrom('icu_episodes').select('id').where('department_id', '=', id).where('ended_at', 'is', null).executeTakeFirst();
        if (open) throw new ConflictException('განყოფილებაში რეანიმაციის პაციენტები არიან — დონეს ვერ შეცვლით, სანამ ისინი არ გადაიყვანება / გაეწერება');
      }
      const d = await trx.updateTable('departments').set(dto).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      // 0047: განყოფილება გახდა რეანიმაცია / ინტენსიური — იქ მყოფ პაციენტებს ეპიზოდი ეხსნება ახლა
      if (old.care_level === 'ward' && level !== 'ward') {
        await sql`INSERT INTO icu_episodes (encounter_id, patient_id, department_id, care_level, assignment_id, started_at, origin)
          SELECT a.encounter_id, st.patient_id, a.department_id, ${level}, a.id, now(), 'direct' FROM bed_assignments a JOIN inpatient_stays st ON st.encounter_id = a.encounter_id
           WHERE a.department_id = ${id} AND a.ended_at IS NULL AND st.status = 'active'
             AND NOT EXISTS (SELECT 1 FROM icu_episodes e WHERE e.encounter_id = a.encounter_id AND e.ended_at IS NULL)`.execute(trx);
      }
      if (old.care_level !== 'ward' && level !== 'ward' && old.care_level !== level) {
        await trx.updateTable('icu_episodes').set({ care_level: level }).where('department_id', '=', id).where('ended_at', 'is', null).execute();
      }
      await this.audit.log(ctx, { action: 'UPDATE_DEPARTMENT', entityName: 'departments', entityId: id, oldData: old, newData: d }, trx);
      return d;
    });
  }
}
