export const CLINIC_TZ = 'Asia/Tbilisi';
const GE_OFFSET = '+04:00';   // საქართველოში DST არ არის

/** დღევანდელი თარიღი კლინიკის დროის სარტყელში: YYYY-MM-DD */
export const todayISO = () => new Intl.DateTimeFormat('en-CA', { timeZone: CLINIC_TZ }).format(new Date());
export const shiftDay = (iso: string, days: number) => {
  const d = new Date(`${iso}T12:00:00${GE_OFFSET}`); d.setUTCDate(d.getUTCDate() + days);
  return new Intl.DateTimeFormat('en-CA', { timeZone: CLINIC_TZ }).format(d);
};
export const localISO = (date: string, time: string) => `${date}T${time}:00${GE_OFFSET}`;

export const time = (ts: string) => new Intl.DateTimeFormat('ka-GE', { timeZone: CLINIC_TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ts));
export const hhmm = (ts: string) => new Intl.DateTimeFormat('en-GB', { timeZone: CLINIC_TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ts));
export const dateGe = (d: string) => { const [y, m, dd] = d.slice(0, 10).split('-'); return `${dd}/${m}/${y}`; };
export const tsDate = (ts: string) => dateGe(new Intl.DateTimeFormat('en-CA', { timeZone: CLINIC_TZ }).format(new Date(ts)));
export const dayTitle = (iso: string) =>
  new Intl.DateTimeFormat('ka-GE', { timeZone: CLINIC_TZ, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${iso}T12:00:00${GE_OFFSET}`));

export const money = (v: string | number | null | undefined) => `${Number(v ?? 0).toFixed(2)} ₾`;
export const age = (birth: string) => {
  const [y, m, d] = birth.split('-').map(Number); const now = new Date();
  let a = now.getFullYear() - y; if (now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d)) a--; return a;
};
export const genderShort = (g: string) => (g === 'male' ? 'მ' : g === 'female' ? 'მდ' : '—');
export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('');

export const ROLE_KA: Record<string, string> = {
  admin: 'ადმინისტრატორი', doctor: 'ექიმი', nurse: 'ექთანი', receptionist: 'რეგისტრატორი',
  billing: 'მოლარე', pharmacist: 'ფარმაცევტი', diagnostic: 'დიაგნოსტიკა (ლაბორანტი/რადიოლოგი)', lab_doctor: 'ლაბორატორიის ექიმი / ხელმძღვანელი', lab_manager: 'ლაბორატორიის მენეჯერი',
};
export const REFERRAL_KA: Record<string, string> = { lab: 'ლაბორატორია', imaging: 'რადიოლოგია', hospitalization: 'ჰოსპიტალიზაცია', specialist_consult: 'კონსულტაცია' };
export const SEVERITY_KA: Record<string, string> = { mild: 'მსუბუქი', moderate: 'საშუალო', severe: 'მძიმე' };

export const SECTION_KA: Record<string, string> = { lab: 'ლაბორატორია', radiology: 'რადიოლოგია', endoscopy: 'ენდოსკოპია' };
export const DX_STATUS: Record<string, [string, string]> = {
  ordered: ['info', 'შეკვეთილი'], collected: ['info', 'ნიმუში აღებულია'], in_progress: ['warn', 'მიმდინარე'],
  resulted: ['warn', 'ვალიდაციას ელოდება'], validated: ['ok', 'მზადაა'], cancelled: ['', 'გაუქმებული'],
};
export const FLAG_UI: Record<string, { sym: string; cls: string; label: string }> = {
  L: { sym: '↓', cls: 'warn', label: 'დაბალი' }, H: { sym: '↑', cls: 'warn', label: 'მაღალი' },
  LL: { sym: '↓↓', cls: 'danger', label: 'კრიტიკული' }, HH: { sym: '↑↑', cls: 'danger', label: 'კრიტიკული' }, A: { sym: '!', cls: 'warn', label: 'გადახრა' },
};
export const refRange = (r: { ref_low?: string | null; ref_high?: string | null; ref_text?: string | null; low?: string | null; high?: string | null; normal_text?: string | null } | null) => {
  if (!r) return '';
  const lo = r.ref_low ?? r.low ?? null; const hi = r.ref_high ?? r.high ?? null; const t = r.ref_text ?? r.normal_text ?? null;
  if (t) return t;
  if (lo !== null && hi !== null) return `${Number(lo)} – ${Number(hi)}`;
  if (lo !== null) return `> ${Number(lo)}`;
  if (hi !== null) return `< ${Number(hi)}`;
  return '';
};
const SUP: Record<string, string> = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };
export const unitFmt = (u: string) => u.replace(/\^(\d+)/g, (_m, d: string) => d.split('').map((c) => SUP[c]).join(''));
