/**
 * ლაბორატორიული ბლანკის შაბლონის პარამეტრები (lab_blank_versions.settings).
 * sanitizeBlank() — ყოველთვის სრულ და უსაფრთხო ობიექტს აბრუნებს (უცნობი ველები იშლება, ზღვრები მოწმდება),
 * ამიტომ ძველი ვერსიებიც სწორად დაიბეჭდება, თუ მომავალში ახალი ველები დაემატება.
 */
export const PATIENT_FIELDS = ['personal_number', 'birth_date', 'age', 'gender', 'phone', 'ordered_by', 'referral', 'pregnancy'] as const;
export const COLUMNS = ['unit', 'reference', 'flag', 'method', 'previous'] as const;
export type PatientField = (typeof PATIENT_FIELDS)[number];
export type Column = (typeof COLUMNS)[number];

export interface BlankSettings {
  paper: 'A4' | 'A5';
  margin_mm: number;
  font_size: number;
  accent_color: string;
  header: {
    logo_image_id: string | null; logo_position: 'left' | 'center' | 'right'; logo_height_mm: number;
    show_clinic: boolean; extra_lines: string[]; title: string; subtitle: string;
  };
  patient_fields: PatientField[];
  layout: 'table' | 'two_column' | 'text';
  group_headers: boolean;
  columns: Column[];
  flag_style: 'words' | 'arrows' | 'letters';
  highlight_abnormal: boolean;
  show_sample_info: boolean;
  show_service_comment: boolean;
  footer: {
    note: string; show_validator: boolean; signer_title: string;
    signature_image_id: string | null; stamp_image_id: string | null;
    show_qr: boolean; show_page_numbers: boolean; legend: boolean;
  };
}

export const DEFAULT_BLANK: BlankSettings = {
  paper: 'A4', margin_mm: 16, font_size: 9, accent_color: '#1F4E79',
  header: { logo_image_id: null, logo_position: 'left', logo_height_mm: 16, show_clinic: true, extra_lines: [], title: 'ლაბორატორიული კვლევის პასუხი', subtitle: '' },
  patient_fields: ['personal_number', 'birth_date', 'age', 'gender', 'ordered_by', 'referral'],
  layout: 'table', group_headers: false, columns: ['unit', 'reference', 'flag'],
  flag_style: 'words', highlight_abnormal: true, show_sample_info: true, show_service_comment: true,
  footer: { note: '', show_validator: true, signer_title: 'ლაბორატორიის ექიმი', signature_image_id: null, stamp_image_id: null, show_qr: false, show_page_numbers: true, legend: true },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown, d: string, max: number) => (typeof v === 'string' ? v.slice(0, max) : d);
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const num = (v: unknown, d: number, min: number, max: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d);
const oneOf = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d);
const img = (v: unknown) => (typeof v === 'string' && UUID.test(v) ? v : null);
/** სიიდან მხოლოდ დაშვებული მნიშვნელობები, დუბლიკატების გარეშე, გადმოცემული რიგით */
const subset = <T extends string>(v: unknown, list: readonly T[], d: T[]): T[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is T => list.includes(x as T)))] : d;

export function sanitizeBlank(input: unknown): BlankSettings {
  const s = obj(input); const h = obj(s.header); const f = obj(s.footer); const D = DEFAULT_BLANK;
  return {
    paper: oneOf(s.paper, ['A4', 'A5'] as const, D.paper),
    margin_mm: num(s.margin_mm, D.margin_mm, 8, 30),
    font_size: num(s.font_size, D.font_size, 7, 12),
    accent_color: typeof s.accent_color === 'string' && /^#[0-9a-f]{6}$/i.test(s.accent_color) ? s.accent_color : D.accent_color,
    header: {
      logo_image_id: img(h.logo_image_id),
      logo_position: oneOf(h.logo_position, ['left', 'center', 'right'] as const, D.header.logo_position),
      logo_height_mm: num(h.logo_height_mm, D.header.logo_height_mm, 8, 40),
      show_clinic: bool(h.show_clinic, D.header.show_clinic),
      extra_lines: Array.isArray(h.extra_lines) ? h.extra_lines.filter((x): x is string => typeof x === 'string').map((x) => x.slice(0, 200)).slice(0, 5) : [],
      title: str(h.title, D.header.title, 120),
      subtitle: str(h.subtitle, D.header.subtitle, 200),
    },
    patient_fields: subset(s.patient_fields, PATIENT_FIELDS, D.patient_fields),
    layout: oneOf(s.layout, ['table', 'two_column', 'text'] as const, D.layout),
    group_headers: bool(s.group_headers, D.group_headers),
    columns: subset(s.columns, COLUMNS, D.columns),
    flag_style: oneOf(s.flag_style, ['words', 'arrows', 'letters'] as const, D.flag_style),
    highlight_abnormal: bool(s.highlight_abnormal, D.highlight_abnormal),
    show_sample_info: bool(s.show_sample_info, D.show_sample_info),
    show_service_comment: bool(s.show_service_comment, D.show_service_comment),
    footer: {
      note: str(f.note, D.footer.note, 1000),
      show_validator: bool(f.show_validator, D.footer.show_validator),
      signer_title: str(f.signer_title, D.footer.signer_title, 100),
      signature_image_id: img(f.signature_image_id),
      stamp_image_id: img(f.stamp_image_id),
      show_qr: bool(f.show_qr, D.footer.show_qr),
      show_page_numbers: bool(f.show_page_numbers, D.footer.show_page_numbers),
      legend: bool(f.legend, D.footer.legend),
    },
  };
}

/** შაბლონში გამოყენებული სურათები */
export const blankImageIds = (s: BlankSettings) => [s.header.logo_image_id, s.footer.signature_image_id, s.footer.stamp_image_id].filter((x): x is string => !!x);
