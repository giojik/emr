import { api, type Role } from '../../api/client';

/** მენეჯერული რეპორტინგი (0060) — სერვერის RPT_READ / RPT_ALL / RPT_CONFIG */
export const RPT_READ: Role[] = ['admin', 'reports', 'reports_all', 'manager', 'viewer'];
export const RPT_CONFIG: Role[] = ['admin', 'reports_all'];

export const CATEGORY_KA: Record<string, string> = {
  flow: 'პაციენტების ნაკადი', beds: 'საწოლები', or: 'საოპერაციო', dx: 'ინსტრუმენტული კვლევები', lab: 'ლაბორატორია', stock: 'მარაგი', finance: 'შემოსავალი / ხარჯი',
  quality: 'ხარისხი და ინციდენტები',   // 0066
  ipc: 'ინფექციის კონტროლი',   // 0072
};
export const CATEGORIES = ['flow', 'beds', 'or', 'dx', 'lab', 'stock', 'finance', 'quality', 'ipc'];
export const STATUS_TONE: Record<string, string> = { green: 'var(--ok-ink)', yellow: 'var(--warn-ink)', red: 'var(--danger-ink)' };
export const STATUS_KA: Record<string, string> = { green: 'სამიზნე შესრულებულია', yellow: 'გაფრთხილება', red: 'სამიზნე არ სრულდება' };
export const DIR_KA: Record<string, string> = { up: 'უკეთესია მეტი ↑', down: 'უკეთესია ნაკლები ↓', none: 'მიმართულების გარეშე' };
export const UNIT_FULL: Record<string, string> = { count: 'რაოდენობა', pct: '%', days: 'დღე', hours: 'საათი', min: 'წუთი', gel: '₾', ratio: 'კოეფიციენტი' };

export interface RptMeta {
  settings: { occupancy_basis: 'hours' | 'midnight'; stock_days_window: number; stock_days_alert: number; compare_default: 'prev' | 'yoy' | 'none'; refresh_today_min: number; lab_tat_start: string;
    tv_refresh_min: number; lab_overdue_min: number; dx_overdue_hours: number; dead_stock_days: number;
    doctor_breakdown: 'off' | 'all_only' | 'scoped'; min_cases: number;
    doctor_revenue: 'on' | 'off'; attention_notify: 'off' | 'in_app' | 'in_app_email'; attention_notify_hour: number; attention_notify_level: 'red' | 'all' };
  today: string;
  scope: { all: boolean; finance: boolean; phi: boolean; departments: { id: string; name: string; type: string; is_active: boolean }[] };
  data_as_of: string | null;
  kpis: { code: string; category: string; name: string; unit: string; unit_ka: string; direction: string; snapshot: boolean; drill: string | null }[];
  can_configure: boolean; can_refresh: boolean;
}
export interface KpiValue {
  code: string; category: string; name: string; unit: string; unit_ka: string; direction: 'up' | 'down' | 'none'; snapshot: boolean; drill: string | null;
  definition: string; formula: string; source: string; value: number | null; compare_value: number | null; change_pct: number | null;
  target: number | null; warn: number | null; target_level: 'clinic' | 'department' | null; status: 'green' | 'yellow' | 'red' | null; status_ka: string | null;
}
export interface Overview { from: string; to: string; compare: { mode: string; from: string; to: string } | null; department_id: string | null; scope_all: boolean; data_as_of: string | null; kpis: KpiValue[] }
export interface Series { kpi: string; name: string; unit: string; unit_ka: string; grain: string; from: string; to: string; points: { period: string; from: string; to: string; value: number | null }[] }
export interface ByDept { kpi: string; name: string; unit: string; unit_ka: string; total: number | null; scope_all: boolean; rows: { department_id: string; department_name: string; value: number | null; status: string | null }[] }
export interface Drill { kpi: string; kind: string; phi: boolean; columns: string[]; rows: (string | number | null)[][]; truncated: boolean }

/** რიცხვის ჩვენება ერთეულით */
export function fmtVal(v: number | null | undefined, unit: string) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const digits = unit === 'gel' ? 2 : unit === 'count' ? 0 : unit === 'ratio' ? 2 : 1;
  const s = v.toLocaleString('en-US', { minimumFractionDigits: unit === 'gel' ? 2 : 0, maximumFractionDigits: digits });
  return unit === 'pct' ? `${s}%` : unit === 'gel' ? `${s} ₾` : unit === 'days' ? `${s} დღე` : unit === 'hours' ? `${s} სთ` : unit === 'min' ? `${s} წთ` : s;
}
/** ცვლილება კარგია? (მიმართულების მიხედვით) */
export const changeTone = (dir: string, ch: number | null) => (ch === null || ch === 0 || dir === 'none' ? 'var(--muted)' : (dir === 'up') === ch > 0 ? 'var(--ok-ink)' : 'var(--danger-ink)');

/** ფაილის ჩამოტვირთვა სერვერიდან (ავტორიზაციით; ფაილის სახელი — სათაურიდან) */
export async function downloadFile(path: string, query: Record<string, string | undefined>, fallback: string) {
  const blob = await api<Blob>(path, { raw: true, query });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = fallback; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const shiftDays = (iso: string, d: number) => { const x = new Date(`${iso}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0, 10); };
export const fmtTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString('ka-GE', { dateStyle: 'short', timeStyle: 'short' }) : '—');
