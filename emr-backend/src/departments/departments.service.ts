import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { InjectDb, type Database } from '../database/database.module';
import type { CreateDepartmentDto, UpdateDepartmentDto } from './departments.dto';

@Injectable()
export class DepartmentsService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService) {}

  list(includeInactive: boolean) {
    let q = this.db.selectFrom('departments as d')
      .select((eb) => ['d.id', 'd.name', 'd.code', 'd.type', 'd.is_active', 'd.created_at', 'd.updated_at',
        eb.selectFrom('users as u').select(eb.fn.countAll<string>().as('c'))
          .whereRef('u.department_id', '=', 'd.id').where('u.is_active', '=', true).as('active_users')])
      .orderBy('d.name');
    if (!includeInactive) q = q.where('d.is_active', '=', true);
    return q.execute();
  }

  async create(dto: CreateDepartmentDto, ctx: AuditContext) {
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
      const d = await trx.updateTable('departments').set(dto).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await this.audit.log(ctx, { action: 'UPDATE_DEPARTMENT', entityName: 'departments', entityId: id, oldData: old, newData: d }, trx);
      return d;
    });
  }
}
