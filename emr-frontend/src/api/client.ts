/**
 * API კლიენტი: access token მეხსიერებაში (არა localStorage — XSS-ის შემთხვევაში არ მოიპარება),
 * refresh — httpOnly cookie-ით. 401-ზე ერთხელ ცდილობს refresh-ს და იმეორებს მოთხოვნას.
 */
export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string, public body?: Record<string, unknown>) {
    super(message);
  }
}

export interface SessionUser {
  id: string; name: string;
  /** ძირითადი როლის კოდი (ჩვენებისთვის) — უფლების შესამოწმებლად: can(user, …) */
  role: string;
  /** ეფექტური უფლებები — ყველა როლის გაერთიანება */
  caps: Role[];
  roles: { code: string; name: string; capabilities: Role[] }[];
  authProvider: 'local' | 'ldap'; mustChangePassword: boolean;
}
/** აქვს თუ არა მომხმარებელს ჩამოთვლილთაგან ერთი უფლება მაინც (სერვერიც იმავეს ამოწმებს) */
export const can = (u: Pick<SessionUser, 'caps'> | null | undefined, ...caps: Role[]) => !!u && caps.some((c) => u.caps.includes(c));
export type Role = 'admin' | 'doctor' | 'nurse' | 'receptionist' | 'billing' | 'pharmacist' | 'diagnostic' | 'lab_doctor' | 'lab_manager' | 'phlebotomist' | 'radiographer' | 'radiologist' | 'endoscopist' | 'endoscopy_nurse';
export interface SessionResponse { accessToken: string; expiresIn: number; user: SessionUser }

let accessToken: string | null = null;
let refreshing: Promise<SessionResponse | null> | null = null;
let onSession: (s: SessionResponse | null) => void = () => {};

export const setSessionListener = (fn: typeof onSession) => { onSession = fn; };
export const setAccessToken = (t: string | null) => { accessToken = t; };

async function parse(res: Response) {
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

function toError(status: number, body: unknown): ApiError {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const m = b.message;
  const msg = Array.isArray(m) ? m.join('; ') : typeof m === 'string' ? m : `შეცდომა (${status})`;
  return new ApiError(status, msg, typeof b.code === 'string' ? b.code : undefined, b);
}

/** refresh — ერთდროულად მხოლოდ ერთი (რამდენიმე 401 ერთ refresh-ს იზიარებს) */
export function refreshSession(): Promise<SessionResponse | null> {
  refreshing ??= (async () => {
    try {
      const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' });
      if (!res.ok) { accessToken = null; onSession(null); return null; }
      const s = (await res.json()) as SessionResponse;
      accessToken = s.accessToken; onSession(s);
      return s;
    } catch { return null; } finally { setTimeout(() => { refreshing = null; }, 0); }
  })();
  return refreshing;
}

type Query = Record<string, string | number | boolean | undefined | null>;
export interface RequestOpts { method?: string; body?: unknown; query?: Query; raw?: boolean }

export async function api<T = unknown>(path: string, opts: RequestOpts = {}, retried = false): Promise<T> {
  const qs = opts.query ? Object.entries(opts.query).filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&') : '';
  const res = await fetch(`/api${path}${qs ? `?${qs}` : ''}`, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    credentials: 'same-origin',
    headers: {
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && !retried && !path.startsWith('/auth/')) {
    const s = await refreshSession();
    if (s) return api<T>(path, opts, true);
  }
  if (!res.ok) throw toError(res.status, await parse(res));
  if (opts.raw) return (await res.blob()) as T;
  return (await parse(res)) as T;
}

/** PDF/ფაილის გახსნა ახალ ჩანართში (ავტორიზაციით) */
export async function openBlob(path: string) {
  const win = window.open('', '_blank');
  try {
    const blob = await api<Blob>(path, { raw: true });
    const url = URL.createObjectURL(blob);
    if (win) win.location.href = url; else window.location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (e) { win?.close(); throw e; }
}

/** multipart ატვირთვა (FormData) — იგივე ავტორიზაცია და refresh, რაც api()-ში */
export async function apiUpload<T = unknown>(path: string, form: FormData, retried = false): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: 'POST', body: form, credentials: 'same-origin',
    headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
  });
  if (res.status === 401 && !retried) { const s = await refreshSession(); if (s) return apiUpload<T>(path, form, true); }
  if (!res.ok) throw toError(res.status, await parse(res));
  return (await parse(res)) as T;
}
