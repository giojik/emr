import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { has, type AuthUser } from '../auth/roles';
import { loadEnv } from '../config/env';
import { InjectDb, type Database } from '../database/database.module';
import type { DB } from '../database/db';
import { NotificationsService } from '../notifications/notifications';
import { stockRules } from '../stock/stock-rules';
import { procRules, type ProcRules } from './procurement-rules';

const TZ = loadEnv().CLINIC_TZ;
export type Trx = Transaction<DB>;
export type Ex = Database | Trx;
export const r2 = (n: number) => Math.round(n * 100) / 100;
export const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
export const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
export const r3 = (n: number) => Math.round(n * 1000) / 1000;
export const addDays = (iso: string, d: number) => { const x = new Date(`${iso}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0, 10); };
export const userName = (alias: string) => sql<string | null>`${sql.ref(`${alias}.first_name`)} || ' ' || ${sql.ref(`${alias}.last_name`)}`;

export interface QtyLine { item_id: string; pack_id?: string | null; qty: number }

/** შესყიდვების საერთო: დღე, ნომრები, ლოკაციის უფლება, საქონელი / შეფუთვა, ფასის მინიშნებები, შეტყობინებები */
@Injectable()
export class ProcCommon {
  constructor(@InjectDb() readonly db: Database, private readonly notifications: NotificationsService) {}

  async today(ex: Ex = this.db) {
    const r = await sql<{ d: string }>`SELECT to_char((now() AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS d`.execute(ex);
    return r.rows[0].d;
  }
  async nextNo(trx: Trx, prefix: 'PR' | 'PO' | 'AP', date: string) {
    const year = Number(date.slice(0, 4));
    const { last_value } = await trx.insertInto('document_counters').values({ document_type: `proc_${prefix}`, year, last_value: 1 })
      .onConflict((oc) => oc.columns(['document_type', 'year']).doUpdateSet({ last_value: sql`document_counters.last_value + 1` }))
      .returning('last_value').executeTakeFirstOrThrow();
    return `${prefix}${String(year).slice(2)}-${String(last_value).padStart(6, '0')}`;
  }
  /** მოდული ჩართულია → პარამეტრები; გამორთულზე — 403 */
  async rules(ex: Ex = this.db): Promise<ProcRules> {
    const r = await procRules(ex as Database);
    if (!r.enabled) throw new ForbiddenException({ code: 'MODULE_DISABLED', message: 'მოდული „შესყიდვები“ გამორთულია (ადმინისტრირება → მოდულები)' });
    return r;
  }
  async rulesPo(ex: Ex = this.db) {
    const r = await this.rules(ex);
    if (r.po_mode === 'off') throw new BadRequestException('შეკვეთები (PO) გამორთულია — პარამეტრი po_mode');
    return r;
  }

  /** მიწოდების ლოკაცია: აქტიური, არა „გზაში“; ფარმაცევტი — მხოლოდ აფთიაქი (საწყობის პარამეტრი pharmacist_scope) */
  async location(u: AuthUser, id: string, ex: Ex = this.db) {
    const l = await ex.selectFrom('stock_locations').select(['id', 'name', 'kind', 'is_active']).where('id', '=', id).executeTakeFirst();
    if (!l) throw new BadRequestException('ლოკაცია ვერ მოიძებნა');
    if (l.kind === 'transit') throw new BadRequestException('„გზაში“ სისტემური ლოკაციაა');
    if (!l.is_active) throw new BadRequestException(`ლოკაცია „${l.name}“ გათიშულია`);
    if (!has(u, 'admin', 'procurement', 'stock_manager', 'storekeeper') && l.kind !== 'pharmacy' && (await stockRules(this.db)).pharmacist_scope !== 'any')
      throw new ForbiddenException('ფარმაცევტი შესყიდვას ითხოვს მხოლოდ აფთიაქისთვის (პარამეტრი)');
    return l;
  }
  async supplier(id: string, ex: Ex = this.db) {
    const s = await ex.selectFrom('stock_suppliers').select(['id', 'name', 'is_active', 'vat_payer', 'lead_time_days', 'contract_no']).where('id', '=', id).executeTakeFirst();
    if (!s) throw new BadRequestException('მომწოდებელი ვერ მოიძებნა');
    if (!s.is_active) throw new BadRequestException(`მომწოდებელი „${s.name}“ გათიშულია`);
    return s;
  }

  /** ხაზი: საქონელი აქტიური, შეფუთვა ამ საქონლის → pack_qty_base, qty_base */
  async qtyLines<T extends QtyLine>(ex: Ex, lines: T[]) {
    const ids = [...new Set(lines.map((l) => l.item_id))];
    const items = ids.length ? await ex.selectFrom('stock_items as i').leftJoin('med_generics as g', 'g.id', 'i.generic_id')
      .select(['i.id', 'i.name', 'i.is_active', 'g.controlled_class']).where('i.id', 'in', ids).execute() : [];
    const packIds = [...new Set(lines.map((l) => l.pack_id).filter((p): p is string => !!p))];
    const packs = packIds.length ? await ex.selectFrom('stock_item_packs').select(['id', 'item_id', 'qty_base']).where('id', 'in', packIds).execute() : [];
    return lines.map((l, i) => {
      const it = items.find((x) => x.id === l.item_id);
      if (!it) throw new BadRequestException(`ხაზი ${i + 1}: საქონელი ვერ მოიძებნა`);
      if (!it.is_active) throw new BadRequestException(`ხაზი ${i + 1}: „${it.name}“ გათიშულია`);
      const p = l.pack_id ? packs.find((x) => x.id === l.pack_id && x.item_id === l.item_id) : null;
      if (l.pack_id && !p) throw new BadRequestException(`ხაზი ${i + 1}: შეფუთვა „${it.name}“-ს არ ეკუთვნის`);
      const per = p ? Number(p.qty_base) : 1;
      return { src: l, item: it, pack_id: p?.id ?? null, per, qty_base: r3(l.qty * per) };
    });
  }

  /**
   * ფასის მინიშნებები (საბაზო ერთეულზე, დღგ-ს გარეშე, ₾): მოქმედი ფასთა ნუსხა (ყველა მომწოდებელი, იაფიდან) + ბოლო 5 მიღება.
   */
  async hints(itemId: string, supplierId?: string | null, ex: Ex = this.db) {
    const today = await this.today(ex);
    let pq = ex.selectFrom('proc_supplier_prices as p').innerJoin('stock_suppliers as s', 's.id', 'p.supplier_id').leftJoin('stock_item_packs as k', 'k.id', 'p.pack_id')
      .select(['p.id', 'p.supplier_id', 's.name as supplier_name', 'p.pack_id', 'k.name as pack_name', sql<string>`coalesce(k.qty_base, 1)`.as('pack_qty_base'), 'p.price', 'p.vat_rate',
        'p.min_qty', 'p.valid_from', 'p.valid_to', 'p.contract_no', sql<string>`p.price / coalesce(k.qty_base, 1)`.as('base_price')])
      .where('p.item_id', '=', itemId).where('p.is_active', '=', true).where('s.is_active', '=', true)
      .where('p.valid_from', '<=', today).where((eb) => eb.or([eb('p.valid_to', 'is', null), eb('p.valid_to', '>=', today)]))
      .orderBy(sql`p.price / coalesce(k.qty_base, 1)`);
    if (supplierId) pq = pq.where('p.supplier_id', '=', supplierId);
    const prices = await pq.execute();
    const last = await ex.selectFrom('stock_doc_lines as x').innerJoin('stock_docs as d', 'd.id', 'x.doc_id').leftJoin('stock_suppliers as s', 's.id', 'd.supplier_id')
      .select(['d.doc_no', 'd.doc_date', 'd.supplier_id', 's.name as supplier_name', 'x.unit_cost', 'x.qty_base'])
      .where('x.item_id', '=', itemId).where('d.doc_type', '=', 'receipt').where('d.status', '=', 'posted').where('d.reversed_by', 'is', null).where('x.unit_cost', 'is not', null)
      .orderBy('d.doc_date', 'desc').orderBy('d.posted_at', 'desc').limit(5).execute();
    return { prices, last };
  }
  /** საუკეთესო შეთავაზება: ფასთა ნუსხა (მომწოდებელი მითითებულია — მისი; არა — ყველაზე იაფი) → ბოლო მიღება */
  async bestPrice(itemId: string, supplierId: string | null, ex: Ex = this.db) {
    const h = await this.hints(itemId, supplierId, ex);
    const p = h.prices[0];
    if (p) return { supplier_id: p.supplier_id, base_price: Number(p.base_price), vat_rate: Number(p.vat_rate), pack_id: p.pack_id, pack_price: Number(p.price), source: 'price_list' as const };
    const l = supplierId ? h.last.find((x) => x.supplier_id === supplierId) ?? h.last[0] : h.last[0];
    if (l) return { supplier_id: supplierId ?? l.supplier_id, base_price: Number(l.unit_cost), vat_rate: null, pack_id: null, pack_price: null, source: 'last_receipt' as const };
    return { supplier_id: supplierId, base_price: null, vat_rate: null, pack_id: null, pack_price: null, source: null };
  }

  /** აქტიური მომხმარებლები ჩამოთვლილი უფლებით (ცარიელზე — admin) */
  async usersWith(caps: string[], ex: Ex = this.db) {
    const q = (c: string[]) => ex.selectFrom('users as u').innerJoin('user_capabilities as c', 'c.user_id', 'u.id').select('u.id').where('u.is_active', '=', true)
      .where(sql<boolean>`c.capabilities && ${sql.val(c)}::varchar[]`).execute();
    const r = await q(caps);
    return (r.length ? r : await q(['admin'])).map((x) => x.id);
  }
  async notify(ids: Iterable<string>, n: Parameters<NotificationsService['notify']>[1], except?: string) {
    for (const id of new Set(ids)) if (id !== except) await this.notifications.notify(id, n);
  }
}
