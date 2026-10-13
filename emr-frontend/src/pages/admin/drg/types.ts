import type { Role } from '../../../api/client';

/** DRG კონფიგურაცია (0055) — ტიპები და უფლებები */
export const DRG_READ: Role[] = ['admin', 'billing', 'drg', 'drg_admin', 'tariffs', 'accountant', 'viewer'];
export const DRG_ADMIN: Role[] = ['admin', 'drg_admin'];

export interface Scheme {
  id: string; code: string; name: string; notes: string | null; is_default: boolean; is_active: boolean; versions: number; drafts: number; payers: number;
  current_version: { id: string; label: string; version_no: number; valid_from: string } | null;
}
export interface VersionRow {
  id: string; version_no: number; label: string; valid_from: string; status: 'draft' | 'active' | 'retired'; created_at: string; updated_at: string; activated_at: string | null;
  retired_at: string | null; retire_reason: string | null; notes: string | null; created_by_name: string; activated_by_name: string | null; current: boolean;
  n_groups: number; n_lists: number; n_cc: number; n_rules: number; n_stays: number;
}
export interface VersionSettings {
  los_basis: 'bed_days' | 'calendar_days'; age_basis: 'admission' | 'discharge'; pdx_source: 'primary' | 'primary_or_admission';
  cc_sources: string[]; cc_exclude_same_category: boolean; cc_count_to_mcc: number | null; proc_sources: string[]; vent_kinds: string[]; fallback_code: string | null;
}
export interface VersionDetail extends Omit<VersionRow, 'current'> {
  scheme_id: string; scheme_code: string; scheme_name: string; settings: VersionSettings; created_by: string; updated_by: string | null; updated_by_name: string | null;
  source_label: string | null; version_approval: 'off' | 'required';
}
export interface Group { version_id: string; code: string; title: string; weight: string; alos: string | null; los_low: number | null; los_high: number | null; mdc: string | null; kind: string; notes: string | null; n_rules: number }
export interface CodeList { code: string; title: string; kind: 'dx' | 'proc' | 'service'; notes: string | null; n_items: number; n_used: number }
export interface CcRow { pattern: string; level: 'cc' | 'mcc'; excl_pdx: string[]; notes: string | null }
export interface Cond { f: string; op: string; v: unknown }
export interface Rule { id: string; seq: number; drg_code: string; drg_title: string | null; drg_weight: string | null; label: string | null; conditions: Cond[]; conditions_text: string; is_active: boolean; notes: string | null }
export interface FieldDef { label: string; type: 'codes' | 'num' | 'enum' | 'bool' | 'level'; ops: string[]; list?: 'dx' | 'proc' | 'service'; values?: { v: string; label: string }[]; unit?: string }
export interface Meta { fields: Record<string, FieldDef>; ops: Record<string, string>; list_kinds: Record<string, string>; version_settings_default: VersionSettings; examples: string[] }
export interface CheckResult { errors: string[]; warnings: string[]; ok: boolean }

export const STATUS_KA: Record<string, string> = { draft: 'მონახაზი', active: 'აქტიური', retired: 'გაუქმებული' };
export const STATUS_CHIP: Record<string, string> = { draft: 'info', active: 'ok', retired: '' };
export const GKIND_KA: Record<string, string> = { medical: 'თერაპიული', surgical: 'ქირურგიული', other: 'სხვა' };
export const LKIND_KA: Record<string, string> = { dx: 'დიაგნოზი (ICD-10)', proc: 'პროცედურა', service: 'მომსახურება (ტარიფის კოდი)' };

/** CSV ფაილის ჩამოტვირთვა (ავტორიზაციით) */
export async function download(path: string, name: string, api: <T>(p: string, o?: { raw?: boolean }) => Promise<T>) {
  const blob = await api<Blob>(path, { raw: true });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
