import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { InjectDb, type Database } from '../database/database.module';
import { applyOpdRules } from './payer-shares';
import { syncPayerDefaults } from './tariff-lists';

/**
 * worker (0054), ყოველ 10 წუთში:
 *   • სამომავლო ფასის / წესის ცვლილება ამოქმედდა → ძველი სვეტები (service_tariffs.base_price, stock_items.sale_price, stock_categories.markup_pct, payers.default_*);
 *   • ამბ. წილი წესებით (opd_payer_mode = rules) — „გადასათვლელი“ ინვოისები (payer_shares_stale), რომლებიც ჯერ არავის გაუხსნია.
 */
@Injectable()
export class TariffTickService {
  private readonly log = new Logger('Tariffs');
  constructor(@InjectDb() private readonly db: Database) {}

  async tick() {
    await this.db.transaction().execute(async (trx) => {
      await sql`SELECT tariff_sync_base(NULL)`.execute(trx);
      for (const p of await trx.selectFrom('payers').select('id').execute()) await syncPayerDefaults(trx, p.id);
    });
    const stale = await this.db.selectFrom('invoices').select('id').where('payer_shares_stale', '=', true).limit(200).execute();
    let n = 0;
    for (const s of stale) {
      try { if (await this.db.transaction().execute((trx) => applyOpdRules(trx, s.id, { onlyStale: true }))) n++; } catch (e) { this.log.warn(`ამბ. წილი (${s.id}): ${(e as Error).message}`); }
    }
    if (n) this.log.log(`ამბ. წილი წესებით გადაითვალა: ${n}`);
  }
}
