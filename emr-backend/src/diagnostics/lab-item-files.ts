import { sql, type Transaction } from 'kysely';
import type { DB } from '../database/db';

/**
 * გარე ანალიზს ფაილის დამატება (ხელით ატვირთვა ან ელ-ფოსტა). იგივე ფაილი (sha256) ორჯერ არ ემატება.
 * პირველი ფაილი → „ვალიდაციას ელოდება“; შემდეგები უბრალოდ ემატება. ext_result_path/name — ბოლო ფაილი (თავსებადობა).
 * აბრუნებს false-ს, თუ ფაილი უკვე მიმაგრებული იყო.
 */
export async function addItemFile(trx: Transaction<DB>, f: { itemId: string; key: string; filename: string; mime: string; size: number; sha256: string | null;
  source: 'upload' | 'mail'; mailFileId?: string | null; userId: string | null }) {
  if (f.sha256) {
    const dup = await trx.selectFrom('dx_item_files').select('id').where('order_item_id', '=', f.itemId).where('sha256', '=', f.sha256).where('removed_at', 'is', null).executeTakeFirst();
    if (dup) return false;
  }
  await trx.insertInto('dx_item_files').values({ order_item_id: f.itemId, storage_path: f.key, filename: f.filename.slice(0, 200), mime: f.mime, size_bytes: f.size, sha256: f.sha256,
    source: f.source, mail_file_id: f.mailFileId ?? null, uploaded_by: f.userId }).execute();
  await trx.updateTable('dx_order_items').set({ ext_result_path: f.key, ext_result_name: f.filename.slice(0, 200), ext_result_at: sql`coalesce(ext_result_at, now())`,
    ext_result_by: sql`coalesce(ext_result_by, ${f.userId})`, status: 'resulted', resulted_by: sql`coalesce(resulted_by, ${f.userId})`, resulted_at: sql`coalesce(resulted_at, now())` })
    .where('id', '=', f.itemId).execute();
  return true;
}
