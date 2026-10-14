import { api, type Role } from '../../api/client';

/** 0058: გადამხდელის ექსპორტი / პასუხი — საერთო ტიპები */
export interface ExportField { key: string; label: string; group: string; type: 'text' | 'date' | 'number' | 'int'; sum?: boolean; ipd_only?: boolean }
export interface ExportMeta {
  fields: ExportField[]; date_formats: string[]; file_tokens: string[]; resp_keys: string[]; resp_statuses: RespStatus[]; resp_ka: Record<RespStatus, string>;
  categories: { code: string; title: string }[];
}
export type RespStatus = 'accepted' | 'partial' | 'rejected' | 'pending';
export interface ExportColumn { header: string; field?: string; const?: string; format?: string; map?: Record<string, string>; default?: string; width?: number; tag?: string; pad?: number; max_len?: number }
export interface ExportConfig {
  kinds: ('ipd' | 'opd')[]; header_row: boolean; total_row: boolean; date_format: string; decimal_sep: '.' | ','; list_sep: string; sheet_name: string; file_name: string;
  csv_sep: string; csv_bom: boolean; xml_root: string; xml_row: string; columns: ExportColumn[];
}
export interface ResponseConfig {
  header_row: boolean; csv_sep: string; decimal_sep: '.' | ','; key_field: string; amount_kind: 'approved' | 'denied';
  columns: { key: string; status?: string; amount?: string; reason?: string; note?: string; ref?: string }; status_map: Partial<Record<RespStatus, string[]>>;
}
export interface TemplateRow {
  id: string; code: string; name: string; kind: 'export' | 'response'; format: 'xlsx' | 'csv' | 'xml'; revision: number; is_active: boolean; notes: string | null;
  updated_at: string; updated_by_name: string | null; payers: string[]; exports: number;
}
export interface Template extends Omit<TemplateRow, 'payers' | 'exports'> { config: ExportConfig | ResponseConfig; payers: { id: string; name: string; code: string }[] }
export interface DenialReason { code: string; title: string; category: string; category_ka: string; external_codes: string[]; default_action: 'patient' | 'writeoff' | null; is_active: boolean; sort_order: number; used: number;
  /** 0059: მიბმული შემოწმების წესები */
  scrub_rules: string[] }
export interface PayerTpl { id: string; name: string; code: string; kind: string; is_active: boolean; export_template_id: string | null; response_template_id: string | null;
  export_template_name: string | null; response_template_name: string | null }
export interface ExportRow { id: string; file_name: string; sha256: string; rows: number; total: string; scrub_warnings: number; note: string | null; created_at: string; template_revision: number;
  template_code: string; template_name: string; size: number; created_by_name: string }
export interface Preview { template: { id: string; code: string; name: string; format: string; revision: number }; file_name: string; rows: number; total: number; header: string[]; preview: string[][];
  scrub: { errors: { invoice_number: string; errors: string }[]; warnings: number; mode: string }; claim_status: string; can_export: boolean }
export interface ImportLine { row: number; key: string; item_id?: string; invoice_number?: string; patient?: string; status?: RespStatus; amount?: number | null; reason?: string | null; note?: string; problem?: string; warn?: string }
export interface ImportResult { dry_run: boolean; import_id?: string; template: { id: string; name: string }; rows: number; matched: number; problems: number; by_status: Record<RespStatus, number>; not_in_file: number; lines: ImportLine[] }

export const TPL_EDIT: Role[] = ['admin', 'accountant'];
export const TPL_READ: Role[] = ['admin', 'accountant', 'viewer', 'billing'];
export const FORMAT_KA: Record<string, string> = { xlsx: 'Excel (xlsx)', csv: 'CSV', xml: 'XML' };
export const RESP_KA: Record<RespStatus, string> = { accepted: 'მიღებულია', partial: 'ნაწილობრივ', rejected: 'უარყოფილია', pending: 'განხილვაში' };
export const RESP_CHIP: Record<RespStatus, string> = { accepted: 'ok', partial: 'warn', rejected: 'danger', pending: 'info' };
export const RESP_KEY_KA: Record<string, string> = { invoice_number: 'ინვოისის №', adm_no: 'ისტორიის №', personal_number: 'პირადი №', guarantee_no: 'საგარანტიოს №', seq: 'რიგითი № (ექსპორტის)' };
export const ACTION_KA: Record<string, string> = { patient: 'პაციენტზე', writeoff: 'ჩამოწერა' };

/** სერვერის ფაილის ჩამოტვირთვა (ავტორიზაციით) */
export async function downloadFile(path: string, name: string) {
  const blob = await api<Blob>(path, { raw: true });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
export const kb = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
