import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { sql } from 'kysely';
import { InjectDb, type Database } from '../database/database.module';

@Controller('health')
export class HealthController {
  constructor(@InjectDb() private readonly db: Database) {}

  @Get()
  async check() {
    try {
      const { rows } = await sql<{ now: Date; migration: string | null }>`
        SELECT now() AS now,
               (SELECT max(version) FROM schema_migrations) AS migration`.execute(this.db);
      return { status: 'ok', db: 'ok', dbTime: rows[0].now, schemaVersion: rows[0].migration };
    } catch (e) {
      throw new ServiceUnavailableException({ status: 'error', db: (e as Error).message });
    }
  }
}
