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
  billing: 'მოლარე', pharmacist: 'ფარმაცევტი', diagnostic: 'დიაგნოსტიკა',
};
export const REFERRAL_KA: Record<string, string> = { lab: 'ლაბორატორია', imaging: 'რადიოლოგია', hospitalization: 'ჰოსპიტალიზაცია', specialist_consult: 'კონსულტაცია' };
export const SEVERITY_KA: Record<string, string> = { mild: 'მსუბუქი', moderate: 'საშუალო', severe: 'მძიმე' };
