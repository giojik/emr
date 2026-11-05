import { ForbiddenException } from '@nestjs/common';
import { has, type AuthUser } from '../auth/roles';
import { sql, type Kysely } from 'kysely';
import type { DB } from '../database/db';
import { modulesRef } from '../modules/modules-ref';

/**
 * 0088: ER-ის კლინიკური ჩაწერის წესები — DI-ს გარეშე (encounter-core / diagnostics / notes იყენებს).
 *  • doctor_write = team — ნებისმიერი er_doctor (ER გუნდური მუშაობაა; ავტორი = ხელმომწერი, აუდიტით);
 *    attending — მხოლოდ მკურნალი (აყვანილი / მინიჭებული) ER-ის ექიმი;
 *  • dx_unpaid_check = skip — ER-ის შემთხვევაზე გადაუხდელობის დადასტურება (UNPAID) არ მოითხოვება; ack — როგორც სხვა ვიზიტებზე.
 */
export interface ErClinicalSettings {
  initial_note_min: number; doctor_write: 'team' | 'attending'; dx_unpaid_check: 'skip' | 'ack'; dx_default_priority: 'urgent' | 'routine';
  consult_due_min: { routine: number; urgent: number; emergency: number }; consult_billing: boolean;
  // 0089: დანიშვნა / მიცემა / ჩამოწერა
  prn_max_h: number; verbal_orders: boolean; verbal_confirm_h: number; double_check: 'off' | 'high_alert' | 'high_alert_controlled';
  dose_rule: 'warn' | 'reason'; allow_no_stock: boolean; stock_deduct: boolean; stat_due_min: number;
  // 0090: გამოსავალი
  admit_mode: 'direct' | 'request'; transfer_orders: 'reconcile' | 'stop_all';
  require_initial_note: 'block' | 'warn' | 'off'; require_diagnosis: 'block' | 'warn' | 'off'; verbal_unconfirmed: 'block' | 'warn'; open_items_check: 'warn' | 'off';
  recommendations_required: boolean; ama_proof: 'consent_or_witnesses' | 'reason'; doc_window_h: number; reopen_h: number;
  summary_mode: 'builtin' | 'template'; summary_sections: SummarySection[];
  // 0091: ბილინგი / სამუშაო სიები / შეხსენებები
  fee_mode: 'none' | 'visit' | 'level' | 'time'; fee_at: 'departure' | 'doctor'; fee_level_basis: 'last' | 'highest'; fee_exempt: string[];
  admit_invoice: 'merge' | 'separate' | 'ask'; admit_fee: 'charge' | 'exempt'; invoice_close: 'departure' | 'doc_close' | 'manual';
  unpaid_check: 'info' | 'warn' | 'off'; payer_at_registration: 'off' | 'optional' | 'required';
  reminders: Record<ReminderKind, boolean>; remind_repeat_min: number; admit_wait_min: number; doc_close_warn_h: number;
  wl_to: WlTo;
}
export const REMINDER_KINDS = ['verbal', 'stat', 'consult', 'admit_wait', 'retriage', 'doc_close'] as const;
export type ReminderKind = (typeof REMINDER_KINDS)[number];
/** 0091: სამუშაო სიის წყაროს მიმღებები (თითო წყაროზე — არჩევადი) */
export const WL_TO_OPTIONS = {
  er_verbal: ['ordering', 'ordering_team'], er_stat: ['nurses', 'nurses_doctor'], er_admit_req: ['doctors', 'head'],
  er_retriage: ['triage', 'triage_nurses'], er_doc_open: ['attending', 'attending_author'], er_unpaid: ['billing', 'billing_reception'],
} as const;
export type WlTo = { [K in keyof typeof WL_TO_OPTIONS]: (typeof WL_TO_OPTIONS)[K][number] };
export const SUMMARY_SECTIONS = ['arrival', 'triage', 'notes', 'diagnoses', 'lab', 'dx', 'consults', 'orders', 'disposition', 'recommendations'] as const;
export type SummarySection = (typeof SUMMARY_SECTIONS)[number];
export const ER_CLINICAL_DEFAULTS: ErClinicalSettings = {
  initial_note_min: 60, doctor_write: 'team', dx_unpaid_check: 'skip', dx_default_priority: 'urgent',
  consult_due_min: { routine: 240, urgent: 60, emergency: 30 }, consult_billing: true,
  prn_max_h: 12, verbal_orders: true, verbal_confirm_h: 4, double_check: 'off', dose_rule: 'warn', allow_no_stock: true, stock_deduct: true, stat_due_min: 15,
  admit_mode: 'direct', transfer_orders: 'reconcile', require_initial_note: 'block', require_diagnosis: 'block', verbal_unconfirmed: 'block', open_items_check: 'warn',
  recommendations_required: true, ama_proof: 'consent_or_witnesses', doc_window_h: 24, reopen_h: 4, summary_mode: 'builtin', summary_sections: [...SUMMARY_SECTIONS],
  fee_mode: 'visit', fee_at: 'departure', fee_level_basis: 'last', fee_exempt: ['lwbs'], admit_invoice: 'merge', admit_fee: 'charge', invoice_close: 'departure',
  unpaid_check: 'info', payer_at_registration: 'optional',
  reminders: { verbal: true, stat: true, consult: true, admit_wait: true, retriage: true, doc_close: true }, remind_repeat_min: 0, admit_wait_min: 60, doc_close_warn_h: 2,
  wl_to: { er_verbal: 'ordering', er_stat: 'nurses', er_admit_req: 'doctors', er_retriage: 'triage', er_doc_open: 'attending', er_unpaid: 'billing_reception' },
};

export async function erClinicalSettings(): Promise<ErClinicalSettings> {
  const s: Partial<ErClinicalSettings> = modulesRef.svc ? await modulesRef.svc.require<Partial<ErClinicalSettings>>('er').catch(() => ({})) : {};
  return mergeErSettings(s);
}
export function mergeErSettings(s: Partial<ErClinicalSettings>): ErClinicalSettings {
  const d = ER_CLINICAL_DEFAULTS;
  return { ...d, ...s, consult_due_min: { ...d.consult_due_min, ...(s.consult_due_min ?? {}) }, reminders: { ...d.reminders, ...(s.reminders ?? {}) }, wl_to: { ...d.wl_to, ...(s.wl_to ?? {}) } };
}

/** ER-ის შემთხვევაზე კლინიკური ჩანაწერი (ჩანაწერი, ICD-10, დიაგნოსტიკა, კონსულტაციის მოთხოვნა) */
export async function erCanWrite(u: AuthUser, attendingId: string | null, s?: ErClinicalSettings) {
  if (has(u, 'admin')) return true;
  if (!has(u, 'er_doctor')) return false;
  const cfg = s ?? (await erClinicalSettings());
  return cfg.doctor_write === 'team' || attendingId === u.id;
}
export async function assertErWriter(u: AuthUser, attendingId: string | null) {
  const s = await erClinicalSettings();
  if (!(await erCanWrite(u, attendingId, s))) {
    throw new ForbiddenException(s.doctor_write === 'attending' ? 'ER-ის შემთხვევაში ჩაწერა შეუძლია მკურნალ ექიმს (კლინიკის წესი)' : 'ER-ის შემთხვევაში ჩაწერა შეუძლია ER-ის ექიმს');
  }
  // მოდულის ჩაწერა: er გამორთული / ვადაგასული → 403 (ისტორია იკითხება)
  if (modulesRef.svc) await modulesRef.svc.assertActive('er');
}

/**
 * 0090: დოკუმენტაციის ფანჯარა — გამოსავლის შემდეგ doc_window_h საათი (ჩანაწერის ხელმოწერა / შესწორება, ICD-10, ER-ის ფურცელი).
 * true — ER-ის შემთხვევა გასულია (departed) და ფანჯარა ღიაა.
 */
export async function erDocOpen(ex: { selectFrom: Kysely<DB>['selectFrom'] }, encounterId: string) {
  const v = await ex.selectFrom('er_visits').select(sql<boolean>`status = 'departed' AND doc_closes_at > now()`.as('open')).where('encounter_id', '=', encounterId).executeTakeFirst();
  return !!v?.open;
}

/** გადაუხდელობის შემოწმება დიაგნოსტიკაზე (ნიმუში / მისვლა / პროცედურა): ER + skip → არ მოითხოვება */
export async function unpaidApplies(encounterType: string | null | undefined) {
  if (encounterType !== 'emergency') return true;
  return (await erClinicalSettings()).dx_unpaid_check === 'ack';
}
