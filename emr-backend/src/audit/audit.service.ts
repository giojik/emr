import { Global, Injectable, Module } from '@nestjs/common';
import type { Kysely, Transaction } from 'kysely';
import { InjectDb, type Database } from '../database/database.module';
import type { DB } from '../database/db';

export interface AuditContext { userId: string | null; ip?: string; userAgent?: string }

export interface AuditEntry {
  action: string;              // 'VIEW_PATIENT', 'CREATE_PATIENT', ...
  entityName: string;          // ცხრილის სახელი
  entityId: string;
  oldData?: unknown;
  newData?: unknown;
}

/**
 * აუდიტ-ჟურნალი. ცვლილების (INSERT/UPDATE) ოპერაციაში გადაეცით იგივე `trx`,
 * რომ ლოგი და მონაცემი ერთად ჩაიწეროს ან ერთად უარყოფილ იქნას.
 */
@Injectable()
export class AuditService {
  constructor(@InjectDb() private readonly db: Database) {}

  async log(ctx: AuditContext, entry: AuditEntry, executor: Kysely<DB> | Transaction<DB> = this.db) {
    await executor.insertInto('audit_logs').values({
      user_id: ctx.userId,
      action: entry.action,
      entity_name: entry.entityName,
      entity_id: entry.entityId,
      old_data: entry.oldData === undefined ? null : JSON.stringify(entry.oldData),
      new_data: entry.newData === undefined ? null : JSON.stringify(entry.newData),
      ip_address: ctx.ip ?? null,
      user_agent: ctx.userAgent ?? null,
    }).execute();
  }
}

@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
