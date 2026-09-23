import { Global, Inject, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool, types } from 'pg';
import { loadEnv } from '../config/env';
import type { DB } from './db';

// PostgreSQL DATE → string ('YYYY-MM-DD'), არა JS Date.
// წინააღმდეგ შემთხვევაში დაბადების თარიღი დროის სარტყელის გამო შეიძლება ერთი დღით აიწიოს/ჩამოიწიოს.
types.setTypeParser(1082, (v) => v);

export const KYSELY = Symbol('KYSELY');
export type Database = Kysely<DB>;
export const InjectDb = () => Inject(KYSELY);

@Injectable()
class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(@InjectDb() private readonly db: Database) {}
  async onApplicationShutdown() { await this.db.destroy(); }
}

@Global()
@Module({
  providers: [
    {
      provide: KYSELY,
      useFactory: (): Database => {
        const env = loadEnv();
        return new Kysely<DB>({
          dialect: new PostgresDialect({
            pool: new Pool({ connectionString: env.DATABASE_URL, max: env.DB_POOL_MAX, application_name: 'emr-backend' }),
          }),
          log: env.NODE_ENV === 'development'
            ? (e) => { if (e.level === 'error') console.error('[db]', e.error, e.query.sql); }
            : undefined,
        });
      },
    },
    DatabaseLifecycle,
  ],
  exports: [KYSELY],
})
export class DatabaseModule {}
