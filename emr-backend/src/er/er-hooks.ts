import { sql, type Transaction } from 'kysely';
import type { DB } from '../database/db';

/**
 * 0090: ER-ის გამოსავლის გაუქმება (შეცდომა) — DI-ს გარეშე (ER-ის reopen და სტაციონარის „ჰოსპიტალიზაციის გაუქმება“ ერთნაირად იყენებს).
 *  • er_dispositions → reopened; er_visits → წინა სტატუსი (ended_at / disposition / doc_closes_at — NULL); encounters → active;
 *  • ER-ის ფურცელი → revoked; გარდაცვალება → patients.is_deceased მოიხსნება;
 *  • შეწყვეტილი / გადატანილი დანიშნულებები ავტომატურად არ აღდგება (საჭიროებისამებრ — ხელახლა).
 */
export async function reopenErVisitTx(trx: Transaction<DB>, encounterId: string, userId: string, reason: string) {
  const x = await trx.updateTable('er_dispositions').set({ reopened_at: sql`now()`, reopened_by: userId, reopen_reason: reason })
    .where('encounter_id', '=', encounterId).where('reopened_at', 'is', null).returning(['id', 'kind', 'prev_status', 'summary_document_id']).executeTakeFirst();
  if (!x) return null;
  await trx.updateTable('er_visits').set({ status: x.prev_status, disposition: null, ended_at: null, end_reason: null, doc_closes_at: null }).where('encounter_id', '=', encounterId).execute();
  await trx.updateTable('encounters').set({ status: 'active', end_time: null }).where('id', '=', encounterId).execute();
  if (x.summary_document_id) {
    await trx.updateTable('generated_documents').set({ status: 'revoked', revoked_at: sql`now()`, revoked_by: userId, revoke_reason: `გამოსავალი გაუქმდა: ${reason}` })
      .where('id', '=', x.summary_document_id).where('status', '=', 'issued').execute();
  }
  if (x.kind === 'death') {
    const v = await trx.selectFrom('er_visits').select('patient_id').where('encounter_id', '=', encounterId).executeTakeFirstOrThrow();
    await trx.updateTable('patients').set({ is_deceased: false, death_datetime: null }).where('id', '=', v.patient_id).execute();
  }
  return x;
}

/** სტაციონარი: ჰოსპიტალიზაციის გაუქმება (შეცდომა) — ER-იდან ჰოსპიტალიზებულზე ER-ის შემთხვევა ისევ იხსნება (ჩანაწერი ER-ის დაფაზე ბრუნდება) */
export async function erOnAdmissionCancelled(trx: Transaction<DB>, inpatientEncounterId: string, userId: string, reason: string) {
  const x = await trx.selectFrom('er_dispositions').select(['encounter_id']).where('inpatient_encounter_id', '=', inpatientEncounterId).where('reopened_at', 'is', null)
    .where('kind', '=', 'admitted').forUpdate().executeTakeFirst();
  if (!x) return null;
  return reopenErVisitTx(trx, x.encounter_id, userId, `ჰოსპიტალიზაცია გაუქმდა: ${reason}`);
}
