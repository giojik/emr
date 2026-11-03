import { type ReactNode, type SyntheticEvent } from 'react';
import { Link } from 'react-router-dom';
import { STATE_KA, useModules, type ModuleState, type SystemModule } from '../lib/modules';
import { moduleForPath, type ModuleReq } from '../lib/moduleRoutes';
import { Loading } from './ui';

/**
 * 0086 (F / G / H): მოდულის მიხედვით ჩვენება.
 *  • <IfModule code="icu">…</IfModule> — არააქტიურზე არაფერს ხატავს (მინიშნების გარეშე; G). code — მასივი = „რომელიმე“.
 *    write — მხოლოდ სრულად აქტიურზე (read_only — დამალულია; ახალი ჩანაწერის ბლოკები).
 *  • <WriteGuard code="lab">…</WriteGuard> — read_only (ლიცენზიის ვადა) → შიგნით ღილაკები disabled + tooltip.
 *  • <ModuleRoute code=…> — route guard: არააქტიურზე გვერდი „მოდული არააქტიურია“ მიზეზით (H).
 */
const codes = (c: ModuleReq) => (Array.isArray(c) ? c : [c]);
const usable = (m?: SystemModule) => !!m && (m.state === 'active' || m.state === 'read_only');

/** რომელიმე კოდი გამოსაყენებელია (active ∨ read_only) / სრულად აქტიურია; null — მოდულები ჯერ არ ჩატვირთულა */
export function useModuleReq(code: ModuleReq | null | undefined): { usable: boolean | null; active: boolean | null; mods: SystemModule[] } {
  const q = useModules();
  if (!code) return { usable: true, active: true, mods: [] };
  if (!q.data) return { usable: null, active: null, mods: [] };
  const mods = codes(code).map((c) => q.data!.find((m) => m.code === c)).filter((m): m is SystemModule => !!m);
  return { usable: mods.some(usable), active: mods.some((m) => m.state === 'active'), mods };
}

/** მენიუ / საწყისი გვერდი: მისამართის მოდული გამოსაყენებელია? (ჩატვირთვამდე — true, რომ მენიუ არ „ციმციმებდეს“) */
export function usePathAllowed() {
  const q = useModules();
  return (path: string) => {
    const req = moduleForPath(path);
    if (!req || !q.data) return true;
    return codes(req).some((c) => usable(q.data!.find((m) => m.code === c)));
  };
}

export function IfModule({ code, write, children, fallback = null }: { code: ModuleReq; write?: boolean; children: ReactNode; fallback?: ReactNode }) {
  const r = useModuleReq(code);
  return <>{(write ? r.active : r.usable) ? children : fallback}</>;
}

export const READ_ONLY_TIP = 'ლიცენზიის ვადა გასულია — მხოლოდ ნახვა';
/** ნავიგაცია / ფილტრი / დახურვა — read_only-ზეც მუშაობს (ჩანართები, aria-pressed, დღე ‹ ›, ro-ok, მოდალის დახურვა, ბეჭდვა / ჩამოტვირთვა — data-ro-ok) */
const NAV_SEL = '.ro-ok, [aria-pressed], nav, [role="tablist"], .seg, .modal-head, [data-ro-ok]';
const isNavButton = (el: Element) => !!el.closest(NAV_SEL) || el.getAttribute('aria-label') === 'დახურვა' || /^(‹|›|დღეს|გაუქმება|დახურვა|ბეჭდვა|PDF|ჩამოტვირთვა|ნახვა|ძებნა|გაფილტვრა|ექსპორტი|xlsx|განახლება|მეტი|ყველა)/.test((el.textContent ?? '').trim());
/**
 * read_only (ლიცენზიის ვადა) → ზონის შიგნით ღილაკები / ველები გაითიშება (CSS .ro-zone: pointer-events + ნახევრად გამჭვირვალე; კლავიატურის
 * Enter / Space — click-ის დაჭერა capture ფაზაში). ნავიგაციის ღილაკები (დღე ‹ ›, ჩანართები) — className „ro-ok“ რჩება აქტიური.
 * active ან არააქტიური (გვერდი / პანელი სხვაგან იმალება) — შიგთავსი უცვლელია.
 */
export function WriteGuard({ code, children }: { code: ModuleReq; children: ReactNode }) {
  const r = useModuleReq(code);
  if (r.active !== false || !r.usable) return <>{children}</>;
  const block = (e: SyntheticEvent) => {
    const el = (e.target as HTMLElement).closest('button, [role="button"]');
    if (el && !isNavButton(el)) { e.preventDefault(); e.stopPropagation(); }
  };
  return <div className="ro-zone" style={{ display: 'contents' }} data-testid="ro-zone" onClickCapture={block}>{children}</div>;
}

const REASON: Record<ModuleState, string> = {
  active: '', read_only: STATE_KA.read_only, disabled: 'მოდული გამორთულია (ადმინისტრირება → მოდულები)',
  not_licensed: 'მოდული ლიცენზიაში არ შედის', missing_prereq: 'მოდულს აკლია წინაპირობა',
};
export function ModuleInactive({ mods }: { mods: SystemModule[] }) {
  return (
    <div className="content"><div className="card card-pad stack" style={{ maxWidth: 620 }} data-testid="module-inactive">
      <h2>მოდული არააქტიურია</h2>
      {mods.length ? mods.map((m) => (
        <span key={m.code}>„{m.name}“ — {REASON[m.state] ?? STATE_KA[m.state]}{m.state === 'missing_prereq' && m.missing.length ? `: ${m.missing.join(', ')}` : ''}</span>
      )) : <span>ეს გვერდი ამ ინსტალაციაში არ არის ხელმისაწვდომი.</span>}
      <span className="small muted">შენახული ბმული (bookmark) აღარ მუშაობს, სანამ ადმინისტრატორი მოდულს არ ჩართავს.</span>
      <div><Link className="btn primary" to="/">მთავარზე</Link></div>
    </div></div>
  );
}

/** route guard (App.tsx): code არააქტიურია → „მოდული არააქტიურია“; ჩატვირთვამდე — Loading */
export function ModuleRoute({ code, children }: { code: ModuleReq | null; children: ReactNode }) {
  const r = useModuleReq(code);
  if (r.usable === null) return <Loading />;
  if (!r.usable) return <ModuleInactive mods={r.mods} />;
  return <>{children}</>;
}
