import { ConflictException } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { loadEnv } from '../config/env';
import type { DB } from '../database/db';
import type { Database } from '../database/database.module';

/** საოპერაციო (0049) — საერთო: ტიპები, ისტორია, დასრულების წესები (დათვლა, ოქმი, CSSD), preference card-ის შეკრება */
export type Trx = Transaction<DB>;
export type Ex = Database | Trx;
export const TZ = loadEnv().CLINIC_TZ;

export interface OrSettings {
  or_scheduling: 'coordinator' | 'surgeon_self' | 'both'; anesthesia_team_by: 'anesthesia_head' | 'surgeon'; preop_readiness: 'warn' | 'block';
  turnover_min: number; default_duration_min: number; self_booking_days: number; notify_requests: boolean;
  // 0049
  nursing_team_by: 'surgeon' | 'or_head_nurse' | 'both'; room_teams: boolean; anesthesia_meds: 'direct' | 'orders' | 'both';
  preference_cards: 'off' | 'procedure' | 'procedure_surgeon'; count_mode: 'off' | 'warn' | 'block'; note_required: string[];
}
export const OR_SETTINGS_0049: Pick<OrSettings, 'nursing_team_by' | 'room_teams' | 'anesthesia_meds' | 'preference_cards' | 'count_mode' | 'note_required'> = {
  nursing_team_by: 'both', room_teams: true, anesthesia_meds: 'direct', preference_cards: 'procedure_surgeon', count_mode: 'block',
  note_required: ['postop_dx', 'procedures', 'description', 'complications', 'blood_loss'],
};
/** ოქმის ველები, რომლებიც შეიძლება სავალდებულო იყოს (ადმინისტრირება → მოდულები) */
export const NOTE_FIELDS: Record<string, string> = { preop_dx: 'წინასაოპერაციო დიაგნოზი', postop_dx: 'პოსტოპერაციული დიაგნოზი', procedures: 'ჩატარებული პროცედურ(ებ)ი',
  description: 'ოპერაციის აღწერა', findings: 'აღმოჩენები', complications: 'გართულებები (ან „არ ყოფილა“)', blood_loss: 'სისხლის დაკარგვა' };
export const COUNT_PHASE_KA: Record<string, string> = { initial: 'დაწყებისას', pre_closure: 'დახურვამდე', final: 'ბოლოს' };
export const COUNT_KINDS: Record<string, string> = { sponges: 'საფენები / ტამპონები', needles: 'ნემსები', blades: 'სკალპელის პირები', instruments: 'ინსტრუმენტები', other: 'სხვა' };

export async function orEvent(ex: Ex, c: { id: string; encounter_id: string | null; planned_id?: string | null }, kind: string, data: Record<string, unknown>, userId: string | null, ipd?: string) {
  await ex.insertInto('or_case_events').values({ case_id: c.id, kind, data: JSON.stringify(data), user_id: userId }).execute();
  if (ipd && (c.encounter_id || c.planned_id)) {
    await ex.insertInto('inpatient_events').values({ encounter_id: c.encounter_id, planned_id: c.encounter_id ? null : c.planned_id ?? null, kind: ipd,
      data: JSON.stringify({ case_id: c.id, ...data }), user_id: userId }).execute();
  }
}

// ================================================================= დათვლა
/** დათვლის ეტაპის მდგომარეობა: ბოლო ჩანაწერი (თუ ბოლო შეუსაბამოა — რენტგენი + ახსნა ითვლება „გადაწყვეტილად“ block რეჟიმში) */
export async function countState(ex: Ex, caseId: string, phase: 'initial' | 'pre_closure' | 'final') {
  const last = await ex.selectFrom('or_counts').select(['id', 'correct', 'xray', 'explanation', 'done_at']).where('case_id', '=', caseId).where('phase', '=', phase)
    .orderBy('done_at', 'desc').orderBy('id', 'desc').executeTakeFirst();
  return { done: !!last, correct: !!last?.correct, resolved: !!last && (last.correct || (last.xray && (last.explanation?.trim().length ?? 0) >= 3)) };
}

/**
 * დათვლის წესი ნიშნულისას: განაკვეთი ← initial, ნაკერი ← pre_closure, ოთახიდან გასვლა ← final.
 *  block — დათვლა სავალდებულოა; შეუსაბამობა → ხელახლა დათვლა (სწორი) ან რენტგენი + ახსნა;
 *  warn — დათვლის გარეშე / შეუსაბამობით — ახსნით (count_override); off — არ მოწმდება.
 */
export async function countGate(ex: Ex, caseId: string, kind: string, mode: OrSettings['count_mode'], override: string | undefined) {
  const phase = ({ incision: 'initial', closure: 'pre_closure', out_of_room: 'final' } as const)[kind as 'incision'];
  if (!phase || mode === 'off') return null;
  const st = await countState(ex, caseId, phase);
  if (st.done && st.correct) return null;
  const what = !st.done ? `დათვლა (${COUNT_PHASE_KA[phase]}) არ არის ჩატარებული` : `დათვლა (${COUNT_PHASE_KA[phase]}) — შეუსაბამობა`;
  if (mode === 'block') {
    if (st.done && st.resolved) return null;
    throw new ConflictException({ code: st.done ? 'COUNT_DISCREPANCY' : 'COUNT_REQUIRED',
      message: st.done ? `${what}: საჭიროა ხელახლა დათვლა ან რენტგენი (ახსნით)` : `${what} — „მასალები / დათვლა“` });
  }
  if (!override?.trim() || override.trim().length < 3) throw new ConflictException({ code: 'COUNT_OVERRIDE_REQUIRED', message: `${what} — საჭიროა ახსნა`, phase });
  return { phase, what, reason: override.trim() };
}

// ================================================================= ოქმი
/** ოქმის სავალდებულო ველები (ბოლო ვერსია — შავი ან ხელმოწერილი) */
export function noteMissing(n: { preop_icd10_code: string | null; postop_icd10_code: string | null; procedures: unknown; description: string | null; findings: string | null;
  complications: string | null; complications_none: boolean; blood_loss_ml: number | null } | undefined | null, required: string[]) {
  const miss: string[] = [];
  const t = (v: string | null) => !!v && v.trim().length >= 2;
  for (const k of required) {
    const ok = k === 'preop_dx' ? !!n?.preop_icd10_code : k === 'postop_dx' ? !!n?.postop_icd10_code
      : k === 'procedures' ? Array.isArray(n?.procedures) && (n!.procedures as unknown[]).length > 0
      : k === 'description' ? t(n?.description ?? null) : k === 'findings' ? t(n?.findings ?? null)
      : k === 'complications' ? !!n && (n.complications_none || t(n.complications)) : k === 'blood_loss' ? n?.blood_loss_ml !== null && n?.blood_loss_ml !== undefined : true;
    if (!ok) miss.push(NOTE_FIELDS[k] ?? k);
  }
  return miss;
}
export async function latestNote(ex: Ex, caseId: string) {
  return ex.selectFrom('or_op_notes').selectAll().where('case_id', '=', caseId).where('superseded_at', 'is', null)
    .orderBy(sql`CASE status WHEN 'draft' THEN 0 ELSE 1 END`).orderBy('version', 'desc').executeTakeFirst();
}
/** არაარჩევადი: ოპერაცია ვერ დასრულდება ოქმის სავალდებულო ველების გარეშე */
export async function noteGate(ex: Ex, caseId: string, required: string[]) {
  if (!required.length) return;
  const n = await latestNote(ex, caseId);
  const miss = noteMissing(n, required);
  if (miss.length) throw new ConflictException({ code: 'NOTE_INCOMPLETE', message: `ოქმი: სავალდებულო ველები შესავსებია — ${miss.join(', ')}`, missing: miss });
}

// ================================================================= preference card
/** ბარათი ოპერაციისთვის: ოპერატორის (procedure_surgeon) → ზოგადი; მხოლოდ ძირითადი პროცედურის + დანარჩენების ჯამი */
export async function cardItems(ex: Ex, c: { id: string; surgeon_id: string }, mode: OrSettings['preference_cards']) {
  if (mode === 'off') return [];
  const procs = await ex.selectFrom('or_case_procedures').select('procedure_id').where('case_id', '=', c.id).execute();
  if (!procs.length) return [];
  const cards = await ex.selectFrom('or_preference_cards').select(['id', 'procedure_id', 'surgeon_id']).where('is_active', '=', true)
    .where('procedure_id', 'in', procs.map((p) => p.procedure_id))
    .where((eb) => (mode === 'procedure_surgeon' ? eb.or([eb('surgeon_id', 'is', null), eb('surgeon_id', '=', c.surgeon_id)]) : eb('surgeon_id', 'is', null))).execute();
  const pick = procs.map((p) => cards.find((k) => k.procedure_id === p.procedure_id && k.surgeon_id === c.surgeon_id) ?? cards.find((k) => k.procedure_id === p.procedure_id && !k.surgeon_id))
    .filter((k): k is NonNullable<typeof k> => !!k);
  if (!pick.length) return [];
  const rows = await ex.selectFrom('or_preference_card_items as ci').innerJoin('stock_items as i', 'i.id', 'ci.item_id')
    .select(['ci.card_id', 'ci.item_id', 'ci.qty', 'i.name', 'i.is_active']).where('ci.card_id', 'in', pick.map((k) => k.id)).orderBy('ci.sort_order').execute();
  const sum = new Map<string, { item_id: string; qty: number; name: string; card_ids: string[] }>();
  for (const r of rows) {
    if (!r.is_active) continue;
    const cur = sum.get(r.item_id);
    if (cur) { cur.qty += Number(r.qty); cur.card_ids.push(r.card_id); } else sum.set(r.item_id, { item_id: r.item_id, qty: Number(r.qty), name: r.name, card_ids: [r.card_id] });
  }
  return [...sum.values()];
}
/** ავტომატური შეკრება (დასრულებისას / ხელით): ბარათის პოზიციები, თუ ჯერ არ არის დამატებული */
export async function assembleCard(ex: Ex, c: { id: string; surgeon_id: string }, mode: OrSettings['preference_cards'], userId: string) {
  const items = await cardItems(ex, c, mode);
  if (!items.length) return 0;
  const has = await ex.selectFrom('or_case_items').select('id').where('case_id', '=', c.id).where('source', '=', 'card').executeTakeFirst();
  if (has) return 0;
  const kinds = new Map((await ex.selectFrom('stock_items as i').innerJoin('stock_categories as k', 'k.id', 'i.category_id').select(['i.id', 'k.kind'])
    .where('i.id', 'in', items.map((x) => x.item_id)).execute()).map((r) => [r.id, r.kind]));
  await ex.insertInto('or_case_items').values(items.map((x) => ({ case_id: c.id, item_id: x.item_id, qty: String(x.qty), source: 'card', is_implant: kinds.get(x.item_id) === 'implant',
    added_by: userId }))).execute();
  return items.length;
}

// ================================================================= CSSD
/** დასრულებისას: ოპერაციის შეფუთვები → used პაციენტზე (CSSD-ის მიკვლევა) */
export async function packsUsed(ex: Ex, c: { id: string; patient_id: string; encounter_id: string | null }, userId: string) {
  const rows = await ex.selectFrom('or_case_packs as cp').innerJoin('cssd_packs as p', 'p.id', 'cp.pack_id').select(['cp.id', 'p.id as pack_id', 'p.set_id', 'p.pack_no', 'p.status'])
    .where('cp.case_id', '=', c.id).where('cp.removed_at', 'is', null).where('cp.used_at', 'is', null).execute();
  for (const r of rows) {
    if (['sterile', 'issued'].includes(r.status)) {
      await ex.updateTable('cssd_packs').set({ status: 'used', used_at: sql`now()`, used_by: userId, patient_id: c.patient_id, encounter_id: c.encounter_id }).where('id', '=', r.pack_id).execute();
      await ex.insertInto('cssd_events').values({ set_id: r.set_id, pack_id: r.pack_id, kind: 'used', data: JSON.stringify({ patient_id: c.patient_id, or_case_id: c.id }), user_id: userId }).execute();
    }
    await ex.updateTable('or_case_packs').set({ used_at: sql`now()` }).where('id', '=', r.id).execute();
  }
  return rows.map((r) => r.pack_no);
}

// ================================================================= ბლოკის საწყობი
/** ბლოკის ლოკაციის საქონელი ნაშთით (ძებნა დასახელებით / კოდით) */
export function stockAt(ex: Ex, locationId: string, q: string | undefined, kinds?: string[]) {
  let x = ex.selectFrom('stock_balances as b').innerJoin('stock_lots as lt', 'lt.id', 'b.lot_id').innerJoin('stock_items as i', 'i.id', 'b.item_id')
    .innerJoin('stock_categories as k', 'k.id', 'i.category_id').innerJoin('stock_units as un', 'un.code', 'i.base_unit').leftJoin('med_generics as g', 'g.id', 'i.generic_id')
    .select(['i.id', 'i.code', 'i.name', 'i.base_unit', 'un.name as unit_name', 'k.kind', 'i.serial_tracked', 'g.controlled_class', 'g.dose_unit', 'g.dose_per_unit',
      sql<string>`sum(b.qty)`.as('qty')])
    .where('b.location_id', '=', locationId).where('b.qty', '>', '0').where('lt.status', '=', 'active').where('i.is_active', '=', true)
    .where((eb) => eb.or([eb('lt.expires_on', 'is', null), eb('lt.expires_on', '>=', sql<string>`(now() AT TIME ZONE ${TZ})::date`)]))
    .groupBy(['i.id', 'i.code', 'i.name', 'i.base_unit', 'un.name', 'k.kind', 'i.serial_tracked', 'g.controlled_class', 'g.dose_unit', 'g.dose_per_unit'])
    .orderBy('i.name').limit(50);
  if (kinds?.length) x = x.where('k.kind', 'in', kinds);
  if (q?.trim()) { const t = `%${q.trim().replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`; x = x.where((eb) => eb.or([eb('i.name', 'ilike', t), eb('i.code', 'ilike', t)])); }
  return x.execute();
}
/** ლოტები ლოკაციაზე (FEFO რიგით) */
export function lotsAt(ex: Ex, locationId: string, itemId: string) {
  return ex.selectFrom('stock_balances as b').innerJoin('stock_lots as lt', 'lt.id', 'b.lot_id')
    .select(['lt.id as lot_id', 'lt.lot_no', 'lt.serial_no', 'lt.expires_on', 'b.qty']).where('b.item_id', '=', itemId).where('b.location_id', '=', locationId).where('b.qty', '>', '0')
    .where('lt.status', '=', 'active').where((eb) => eb.or([eb('lt.expires_on', 'is', null), eb('lt.expires_on', '>=', sql<string>`(now() AT TIME ZONE ${TZ})::date`)]))
    .orderBy(sql`lt.expires_on NULLS LAST`).orderBy('lt.created_at').execute();
}
