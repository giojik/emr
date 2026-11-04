import { ForbiddenException } from '@nestjs/common';
import { has, type AuthUser } from '../auth/roles';
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
}
export const ER_CLINICAL_DEFAULTS: ErClinicalSettings = {
  initial_note_min: 60, doctor_write: 'team', dx_unpaid_check: 'skip', dx_default_priority: 'urgent',
  consult_due_min: { routine: 240, urgent: 60, emergency: 30 }, consult_billing: true,
  prn_max_h: 12, verbal_orders: true, verbal_confirm_h: 4, double_check: 'off', dose_rule: 'warn', allow_no_stock: true, stock_deduct: true, stat_due_min: 15,
};

export async function erClinicalSettings(): Promise<ErClinicalSettings> {
  const s: Partial<ErClinicalSettings> = modulesRef.svc ? await modulesRef.svc.require<Partial<ErClinicalSettings>>('er').catch(() => ({})) : {};
  return { ...ER_CLINICAL_DEFAULTS, ...s, consult_due_min: { ...ER_CLINICAL_DEFAULTS.consult_due_min, ...(s.consult_due_min ?? {}) } };
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

/** გადაუხდელობის შემოწმება დიაგნოსტიკაზე (ნიმუში / მისვლა / პროცედურა): ER + skip → არ მოითხოვება */
export async function unpaidApplies(encounterType: string | null | undefined) {
  if (encounterType !== 'emergency') return true;
  return (await erClinicalSettings()).dx_unpaid_check === 'ack';
}
