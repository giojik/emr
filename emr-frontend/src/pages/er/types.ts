import type { Diagnosis } from '../../api/types';
import type { Role } from '../../api/client';

/** 0087: გადაუდებელი დახმარება (ER) — ტიპები / ქართული წარწერები */
export const ER_READ: Role[] = ['admin', 'er_triage', 'er_doctor', 'er_manage', 'manager', 'viewer'];
export const ER_WRITE: Role[] = ['admin', 'er_triage', 'er_doctor', 'er_manage'];
export const ER_REG: Role[] = ['admin', 'er_triage', 'er_manage'];
export const ER_MANAGE: Role[] = ['admin', 'er_manage'];

export interface ErSettings {
  triage_scale: string; triage_target_min: number; doctor_before_triage: 'allow' | 'block'; ambulance_fields: 'optional' | 'required';
  retriage_alert: boolean; news2_hint: boolean; show_on_duty: boolean; board_refresh_sec: number; tv_patient_names: 'initials' | 'full';
}
export interface TriageLevel { scale_code: string; level: number; name: string; color: string; target_doctor_min: number; retriage_min: number | null; description: string | null; is_active: boolean }
export interface TriageScale { code: string; name: string; description: string | null; is_system: boolean; is_active: boolean; sort_order: number; levels: TriageLevel[] }
export interface ArrivalMode { code: string; name: string; kind: 'walk_in' | 'ambulance' | 'transfer' | 'police' | 'other'; is_active: boolean; sort_order: number }
export interface Spot { id: string; department_id: string; department_name?: string; code: string; name: string; kind: SpotKind; is_active?: boolean; sort_order?: number; encounter_id?: string | null }
export type SpotKind = 'bed' | 'chair' | 'corridor' | 'resus' | 'isolation' | 'other';
export interface ErMeta {
  settings: ErSettings; departments: { id: string; name: string; code: string }[]; arrival_modes: ArrivalMode[]; scales: TriageScale[]; spots: Spot[];
  institutions: { id: string; name: string }[]; waiting_for: string[];
  perms: { register: boolean; triage: boolean; pickup: boolean; assign: boolean; manage: boolean; identify: boolean; merge: boolean };
}
export type ErStatus = 'waiting' | 'triaged' | 'in_treatment' | 'cancelled';
export interface BoardItem {
  encounter_id: string; visit_no: string; department_id: string; department_name: string; arrived_at: string; arrival_mode: string; arrival_name: string; arrival_kind: string;
  status: ErStatus; spot: { id: string; code: string; name: string; kind: SpotKind } | null;
  triage: { scale: string; level: number; name: string; color: string; target_doctor_min: number; retriage_min: number | null } | null;
  first_triage_at: string | null; last_triage_at: string | null; doctor_at: string | null;
  doctor: { id: string; name: string } | null; nurse: { id: string; name: string } | null; waiting_for: string[]; news2: { score: number; level: string } | null;
  /** 0088: ღია შეკვეთა (lab / imaging) / ღია კონსულტაცია — ავტომატურად; პირველადი ჩანაწერის ვადა (აყვანიდან) */
  waiting_auto?: string[]; initial_note?: { signed: boolean; due_at: string | null; overdue: boolean } | null;
  /** 0089: შეუსრულებელი STAT / ერთჯერადი, STAT-ის ვადაგადაცილება (stat_due_min), დაუდასტურებელი ზეპირი */
  orders?: { pending: number; overdue: number; verbal_pending: number; verbal_overdue: number };
  patient: { name: string; gender: string; age: number; age_estimated: boolean; is_unknown: boolean; unknown_no: number | null; first_name?: string; last_name?: string; personal_number?: string | null };
  patient_id?: string; chief_complaint?: string; ambulance_crew?: string | null; has_allergy?: boolean;
  timers: { wait_min: number; door_to_triage_min: number | null; door_to_doctor_min: number | null; triage_due_at: string | null; triage_overdue: boolean;
    doctor_due_at: string | null; doctor_overdue: boolean; retriage_due_at: string | null; retriage_overdue: boolean };
}
export interface Board {
  now: string; settings: Pick<ErSettings, 'board_refresh_sec' | 'triage_target_min' | 'retriage_alert' | 'news2_hint'>;
  items: BoardItem[]; spots: Spot[]; on_duty: { department_id: string; name: string; phone: string | null; duty_name: string | null }[];
  counts: { total: number; waiting_triage: number; waiting_doctor: number; in_treatment: number; overdue: number; notes_overdue?: number; orders_overdue?: number; verbal_overdue?: number; by_level: Record<string, number>; spots_free: number; spots_total: number };
}
export interface TriageRow {
  id: string; scale_code: string; level: number; level_name: string; color: string; is_retriage: boolean; news2_score: number | null; news2_level: string | null; gcs: number | null;
  discriminator: string | null; note: string | null; recorded_at: string; user_name: string;
  systolic_bp: number | null; diastolic_bp: number | null; heart_rate: number | null; respiratory_rate: number | null; temperature: string | null; spo2: number | null;
  o2_supplement: boolean | null; o2_flow: string | null; consciousness: string | null; pain: number | null; glucose: string | null; weight_kg: string | null;
}
export interface ErVisit {
  encounter_id: string; visit_no: string; patient_id: string; department_id: string; department_name: string; arrived_at: string; arrival_mode: string; arrival_name: string; arrival_kind: string;
  ambulance_crew: string | null; ambulance_call_at: string | null; referral_institution_name: string | null; arrival_note: string | null; chief_complaint: string;
  status: ErStatus; spot_id: string | null; spot_name: string | null; triage_scale: string | null; triage_level: number | null; level_name: string | null; color: string | null;
  first_triage_at: string | null; last_triage_at: string | null; doctor_id: string | null; doctor_name: string | null; doctor_at: string | null; nurse_id: string | null; nurse_name: string | null;
  waiting_for: string[]; ended_at: string | null; end_reason: string | null; created_by_name: string | null;
  patient: { id: string; first_name: string; last_name: string; personal_number: string | null; passport_number: string | null; birth_date: string; birth_date_estimated: boolean; gender: string;
    phone_number: string; is_unknown: boolean; unknown_no: number | null; merged_into_id: string | null; age: number };
  triage: TriageRow[]; allergies: { id: string; substance: string; reaction_type: string | null; severity: string }[];
  // 0088: ICD-10 (ბირთვი) და კლინიკური ჩაწერის უფლება (doctor_write: team / attending; ER აქტიური; შემთხვევა მიმდინარე)
  diagnoses: Diagnosis[]; clinical: { write: boolean; dx_default_priority: 'urgent' | 'routine'; doctor_write: 'team' | 'attending' };
  /** 0089: დანიშნულებები (აქტიური / დაუდასტურებელი ზეპირი) */
  orders?: { active: number; verbal_pending: number };
}

export const STATUS_KA: Record<ErStatus, string> = { waiting: 'ტრიაჟის მოლოდინში', triaged: 'ექიმის მოლოდინში', in_treatment: 'მკურნალობაში', cancelled: 'გაუქმებული' };
export const WAIT_KA: Record<string, string> = { lab: 'ანალიზი', imaging: 'კვლევა (გამოსახულება)', consult: 'კონსულტაცია', bed: 'საწოლი', transport: 'ტრანსპორტი', other: 'სხვა' };
export const SPOT_KA: Record<SpotKind, string> = { bed: 'ტახტი', chair: 'სავარძელი', corridor: 'დერეფანი', resus: 'რეანიმაციული', isolation: 'იზოლაცია', other: 'სხვა' };
export const ARRIVAL_KIND_KA: Record<string, string> = { walk_in: 'თვითდინება', ambulance: 'სასწრაფო', transfer: 'გადმოყვანა', police: 'პოლიცია', other: 'სხვა' };
export const NEWS2_KA: Record<string, string> = { low: 'დაბალი', low_red: 'დაბალი (ერთი პარამ. — 3)', medium: 'საშუალო', high: 'მაღალი' };
export const ACVPU: Record<string, string> = { A: 'A — ფხიზელი', C: 'C — ახალი დაბნეულობა', V: 'V — ხმაზე', P: 'P — ტკივილზე', U: 'U — არ რეაგირებს' };
export const GENDER_KA: Record<string, string> = { male: 'მ', female: 'მდ', other: '—' };

/** წუთები → „1 სთ 05 წთ“ / „12 წთ“ */
export const dur = (m: number | null | undefined) => {
  if (m === null || m === undefined) return '—';
  if (m < 0) return '0 წთ';
  return m >= 60 ? `${Math.floor(m / 60)} სთ ${String(m % 60).padStart(2, '0')} წთ` : `${m} წთ`;
};
export const minsSince = (iso: string | null, now: number) => (iso ? Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000)) : null);
export const minsUntil = (iso: string | null, now: number) => (iso ? Math.floor((new Date(iso).getTime() - now) / 60_000) : null);
/** ტექსტის ფერი ფონზე (ტრიაჟის ფერი) */
export const onColor = (hex: string) => {
  const n = parseInt(hex.slice(1), 16); const r = (n >> 16) & 255; const g = (n >> 8) & 255; const b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#1B221F' : '#fff';
};
export const hm = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('ka-GE', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Tbilisi' }) : '—');
export const patientLabel = (p: { first_name?: string; last_name?: string; name?: string; is_unknown: boolean; unknown_no: number | null }) => {
  const nm = p.name ?? `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim();
  return p.is_unknown && p.first_name !== 'უცნობი' && p.unknown_no ? `${nm} (დაუდასტ. #${p.unknown_no})` : nm;
};
