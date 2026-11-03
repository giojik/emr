import { ConflictException } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import type { DB } from '../database/db';

/**
 * ხაზის გადაფასება (0054, #10–#11): ფასი ფიქსირდება შექმნისას; „გადაფასება“ — მიმდინარე ნუსხებით (ხაზის თარიღი, განყოფილება, გადამხდელი).
 *   არ ეხება: ავტომატურ ხაზებს (საწოლდღე / ვენტილაცია / პაკეტი / ოპერაცია — სინქრონიზაცია თვითონ ითვლის), პაკეტში შემავალს,
 *   ხელით შესწორებულს / ფასდაკლებიანს (includeAdjusted-ის გარეშე).
 *   manual: ფინალიზებული → 409 (DB invoice_finalized), დახურული პერიოდი → 409 (period_locked), ქლეიმში → 409;
 *   payer_change (ავტომატური): ამ შემთხვევებში ხაზი / ინვოისი უბრალოდ გამოტოვდება.
 */
export interface RepriceOpts { lineIds?: string[]; reason: string; kind: 'manual' | 'payer_change'; userId: string | null; includeAdjusted?: boolean }
export interface RepriceChange { line_id: string; description: string; old_price: number; new_price: number; skipped?: string }

export async function repriceLines(trx: Transaction<DB>, invoiceId: string, o: RepriceOpts) {
  const inv = await trx.selectFrom('invoices').select(['id', 'finalized_at']).where('id', '=', invoiceId).forUpdate().executeTakeFirst();
  if (!inv) return { changed: [] as RepriceChange[], skipped: [] as RepriceChange[] };
  const auto = o.kind === 'payer_change';
  if (inv.finalized_at) {
    if (auto) return { changed: [], skipped: [] };
    throw new ConflictException({ code: 'FINALIZED', message: 'ინვოისი ფინალიზებულია — გადაფასებისთვის საჭიროა გახსნა' });
  }
  if (await trx.selectFrom('fin_claim_items').select('id').where('invoice_id', '=', invoiceId).executeTakeFirst()) {
    if (auto) return { changed: [], skipped: [] };
    throw new ConflictException({ code: 'INVOICE_IN_CLAIM', message: 'ინვოისი შედის გადამხდელის ქლეიმში — გადაფასება შეუძლებელია' });
  }
  let q = trx.selectFrom('invoice_line_items as l')
    .select(['l.id', 'l.description', 'l.unit_price', 'l.original_price', 'l.price_item_id', 'l.adjusted_by', 'l.category', 'l.or_case_id', 'l.package_included',
      'l.tariff_id', 'l.stock_doc_line_id', sql<boolean>`fin_period_locked(l.service_date)`.as('locked'),
      sql<string | null>`(SELECT q.price::text FROM tariff_reprice_quote(l.id) q)`.as('q_price'),
      sql<string | null>`(SELECT q.item_id::text FROM tariff_reprice_quote(l.id) q)`.as('q_item')])
    .where('l.invoice_id', '=', invoiceId);
  if (o.lineIds?.length) q = q.where('l.id', 'in', o.lineIds);
  const lines = await q.orderBy('l.created_at').execute();
  const changed: RepriceChange[] = []; const skipped: RepriceChange[] = [];
  for (const l of lines) {
    const base = { line_id: l.id, description: l.description, old_price: Number(l.unit_price), new_price: Number(l.unit_price) };
    const why = ['bed', 'ventilation', 'package'].includes(l.category) || l.or_case_id ? 'ავტომატური ხაზი (სინქრონიზაციით)'
      : l.package_included ? 'პაკეტშია'
      : !l.tariff_id && !l.stock_doc_line_id ? 'ტარიფის / საქონლის გარეშე'
      : !o.includeAdjusted && (l.adjusted_by || (l.original_price !== null && l.original_price !== l.unit_price)) ? 'ხელით შესწორებული ფასი'
      : l.q_price === null ? 'ფასი ნუსხაში ვერ მოიძებნა'
      : auto && l.locked ? 'დახურული პერიოდი' : null;
    if (why) { if (o.lineIds?.length || !auto) skipped.push({ ...base, skipped: why }); continue; }
    const np = Number(l.q_price);
    if (np === Number(l.unit_price) && l.q_item === l.price_item_id) continue;
    await trx.updateTable('invoice_line_items').set({ unit_price: np.toFixed(2), original_price: np.toFixed(2), price_item_id: l.q_item, discount_reason: null, adjusted_by: null })
      .where('id', '=', l.id).execute();
    await trx.insertInto('invoice_line_reprices').values({ line_id: l.id, invoice_id: invoiceId, kind: o.kind, old_price: l.unit_price, new_price: np.toFixed(2),
      old_item_id: l.price_item_id, new_item_id: l.q_item, reason: o.reason, created_by: o.userId }).execute();
    changed.push({ ...base, new_price: np });
  }
  return { changed, skipped };
}

/** გადამხდელის ცვლილება → ავტომატური გადაფასება (reprice_on_payer_change = auto_unpaid; გადახდის გარეშე) */
export async function repriceOnPayerChange(trx: Transaction<DB>, invoiceId: string, userId: string | null, mode: string) {
  if (mode !== 'auto_unpaid') return null;
  const paid = await trx.selectFrom('payments').select(sql<string>`coalesce(sum(amount), 0)`.as('s')).where('invoice_id', '=', invoiceId).executeTakeFirstOrThrow();
  if (Number(paid.s) > 0) return null;
  return repriceLines(trx, invoiceId, { reason: 'გადამხდელის ცვლილება (ავტომატური)', kind: 'payer_change', userId });
}
