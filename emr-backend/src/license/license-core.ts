import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';

/**
 * ლიცენზიის ფორმატი (0085) — სუფთა ფუნქციები (backend, worker, CLI):
 *   { v: 1, kid, payload: { clinic, install_id, modules[], issued, expires | null, max_users?, note? }, sig }
 * ხელი ეწერება payload-ის კანონიკურ JSON-ს (გასაღებები დალაგებული, სივრცეების გარეშე), Ed25519.
 * ვადა: `expires` დღის ბოლომდე (23:59:59.999) კლინიკის დროის სარტყელში; null — უვადო.
 */
export interface LicensePayload {
  clinic: string;
  install_id: string;
  modules: string[];
  issued: string;
  expires: string | null;
  max_users?: number | null;
  note?: string;
}
export interface LicenseFile { v: 1; kid: string; payload: LicensePayload; sig: string }

export const WARN_DAYS = 30;
export const GRACE_DAYS = 30;
export const ALL_DAYS_BANNER = 7;
const DAY = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export const publicKeyFromB64 = (b64: string): KeyObject => createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
export const privateKeyFromPem = (pem: string): KeyObject => createPrivateKey(pem);

export function signLicense(payload: LicensePayload, kid: string, key: KeyObject): LicenseFile {
  const sig = sign(null, Buffer.from(canonical(payload)), key).toString('base64');
  return { v: 1, kid, payload, sig };
}

export type LicenseError = 'LICENSE_FORMAT' | 'LICENSE_UNKNOWN_KEY' | 'LICENSE_BAD_SIGNATURE' | 'LICENSE_WRONG_INSTALL' | 'LICENSE_UNKNOWN_MODULE';

/** ფორმატის შემოწმება; შეცდომა — ტექსტი, სწორი — null */
export function formatError(x: unknown): string | null {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return 'ფაილი JSON ობიექტი არ არის';
  const f = x as Record<string, unknown>;
  if (f.v !== 1) return 'ვერსია (v) უნდა იყოს 1';
  if (typeof f.kid !== 'string' || !/^[A-Za-z0-9._-]{1,40}$/.test(f.kid)) return 'kid არასწორია';
  if (typeof f.sig !== 'string' || f.sig.length < 40) return 'ხელმოწერა (sig) არ არის';
  const p = f.payload as Record<string, unknown> | undefined;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'payload არ არის';
  const known = ['clinic', 'install_id', 'modules', 'issued', 'expires', 'max_users', 'note'];
  const extra = Object.keys(p).filter((k) => !known.includes(k));
  if (extra.length) return `უცნობი ველი: ${extra.join(', ')}`;
  if (typeof p.clinic !== 'string' || p.clinic.trim().length < 2 || p.clinic.length > 200) return 'clinic არასწორია';
  if (typeof p.install_id !== 'string' || !UUID.test(p.install_id)) return 'install_id არასწორია';
  if (!Array.isArray(p.modules) || p.modules.some((m) => typeof m !== 'string' || !/^[a-z_]{2,40}$/.test(m)) || new Set(p.modules).size !== p.modules.length) return 'modules არასწორია';
  if (typeof p.issued !== 'string' || !DATE.test(p.issued) || Number.isNaN(Date.parse(p.issued))) return 'issued არასწორია (YYYY-MM-DD)';
  if (p.expires !== null && (typeof p.expires !== 'string' || !DATE.test(p.expires) || Number.isNaN(Date.parse(p.expires)))) return 'expires არასწორია (YYYY-MM-DD ან null)';
  if (typeof p.expires === 'string' && p.expires < p.issued) return 'expires issued-ზე ადრეა';
  if (p.max_users !== undefined && p.max_users !== null && (!Number.isInteger(p.max_users) || (p.max_users as number) < 1)) return 'max_users არასწორია';
  if (p.note !== undefined && (typeof p.note !== 'string' || p.note.length > 500)) return 'note არასწორია';
  return null;
}

/** ხელმოწერის შემოწმება მოცემული გასაღებების ნაკრებით */
export function verifySignature(f: LicenseFile, keys: Record<string, string>): 'ok' | 'LICENSE_UNKNOWN_KEY' | 'LICENSE_BAD_SIGNATURE' {
  const b64 = keys[f.kid];
  if (!b64) return 'LICENSE_UNKNOWN_KEY';
  try {
    return verify(null, Buffer.from(canonical(f.payload)), publicKeyFromB64(b64), Buffer.from(f.sig, 'base64')) ? 'ok' : 'LICENSE_BAD_SIGNATURE';
  } catch { return 'LICENSE_BAD_SIGNATURE'; }
}

/** დროის სარტყლის წანაცვლება (ms) მოცემულ მომენტში */
function tzOffset(at: number, tz: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(at / 1000) * 1000;
}
/** YYYY-MM-DD დღის ბოლო (23:59:59.999) კლინიკის დროით → epoch ms */
export function endOfDay(date: string, tz: string): number {
  const [y, mo, d] = date.split('-').map(Number);
  const local = Date.UTC(y, mo - 1, d, 23, 59, 59, 999);
  return local - tzOffset(local - 12 * 3600_000, tz);
}

export type LicensePhase = 'valid' | 'warning' | 'grace' | 'expired';
export interface LicenseTiming { phase: LicensePhase; expires_at: string | null; grace_until: string | null; days_left: number | null }
/**
 * valid → (30 დღით ადრე) warning → (ვადა) grace — 30 დღე სრული ფუნქციით → expired — ოპციური მოდულები მხოლოდ წაკითხვაზე.
 * days_left — ვადამდე კალენდარული დღეები (0 — დღეს იწურება; უარყოფითი — ვადის შემდეგ).
 */
export function timing(expires: string | null, now: number, tz: string): LicenseTiming {
  if (!expires) return { phase: 'valid', expires_at: null, grace_until: null, days_left: null };
  const exp = endOfDay(expires, tz);
  const grace = exp + GRACE_DAYS * DAY;
  // კალენდარული დღეები: ვადის თარიღი − დღევანდელი თარიღი (კლინიკის დროით)
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(now));
  const days = Math.round((Date.parse(`${expires}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY);
  const phase: LicensePhase = now <= exp - WARN_DAYS * DAY ? 'valid' : now <= exp ? 'warning' : now <= grace ? 'grace' : 'expired';
  return { phase, expires_at: new Date(exp).toISOString(), grace_until: new Date(grace).toISOString(), days_left: days };
}
