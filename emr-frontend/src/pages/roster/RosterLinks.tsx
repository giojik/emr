import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { hhmm } from '../../lib/format';
import { useModules } from '../../lib/modules';

/**
 * ცვლები / მორიგეობა — კავშირები სხვა მოდულებთან (0079). მხოლოდ გამოქვეყნებული განრიგი; მოდული გამორთული / პარამეტრი „off“ — არაფერი ჩანს.
 * ინფორმაციულია: გადაწყვეტილებას იღებს მომხმარებელი (ტექნიკური დავალება — ავტომატური შეფასება გადაწყვეტილებას არ ცვლის).
 */
export interface NowPerson { user_id: string; staff_id: string; name: string; phone: string | null; position_name: string | null; department_name: string; code: string; kind: string;
  starts_at: string; ends_at: string; duty_name: string | null; duty_level: number | null }

function useRosterOn() { const m = useModules(); return !!m.data?.find((x) => x.code === 'roster')?.enabled; }

/** „ახლა მორიგე / ცვლაში“: კონსულტაცია (განყოფილება → ექიმები) ან ბიომედი (ინჟინრები) */
export function OnDutyHint({ purpose, departmentId, onPick, pickLabel = 'არჩევა', selected }: { purpose: 'consult' | 'bme'; departmentId?: string; onPick?: (userId: string) => void; pickLabel?: string; selected?: string }) {
  const on = useRosterOn();
  const q = useQuery({ queryKey: ['roster-now', purpose, departmentId ?? ''], enabled: on && (purpose === 'bme' || !!departmentId), staleTime: 60_000,
    queryFn: () => api<{ mode: string; people: NowPerson[] }>('/roster/lookup/now', { query: { purpose, department_id: departmentId || undefined } }) });
  if (!on || !q.data || q.data.mode === 'off') return null;
  const ppl = q.data.people;
  return (
    <div className="small" style={{ background: 'var(--surface-2)', borderRadius: 6, padding: '6px 8px' }} role="note" aria-label={purpose === 'consult' ? 'ახლა მორიგე / ცვლაში' : 'ინჟინერი ახლა'}>
      <strong>{purpose === 'consult' ? 'ახლა მორიგე / ცვლაში (განრიგით): ' : 'ინჟინერი ახლა (განრიგით): '}</strong>
      {!ppl.length ? <span className="muted">გამოქვეყნებულ განრიგში ახლა არავინ არის</span> : ppl.map((p) => (
        <span key={p.staff_id} className="row" style={{ display: 'inline-flex', gap: 4, marginRight: 10 }}>
          <span>{p.duty_name ? (p.duty_level === 2 ? '☆ ' : '★ ') : ''}{p.name}</span>
          <span className="muted">· {p.duty_name ?? p.code} {hhmm(p.starts_at)}–{hhmm(p.ends_at)}{p.phone ? ` · ${p.phone}` : ''}</span>
          {onPick && <button className="btn sm" type="button" disabled={selected === p.user_id} onClick={() => onPick(p.user_id)} style={{ height: 22, padding: '0 6px' }}>{selected === p.user_id ? '✓' : pickLabel}</button>}
        </span>))}
      {purpose === 'consult' && q.data.mode === 'duty' && <div className="muted">სასწრაფო / გადაუდებელი განყოფილებაზე (ექიმის მითითების გარეშე) — შეტყობინება მხოლოდ მათ მიდის.</div>}
    </div>
  );
}

export interface LoadRow { department_id: string; department_name: string; care_level: string; patients: number; nurses: number; ratio: number | null; limit: number; level: 'ok' | 'over' | 'none' }
/** დატვირთვის მაჩვენებელი (საწოლფონდის დაფა / მორიგეები): პაციენტი / ექთანი ახლა */
export function LoadBadge({ l }: { l: Pick<LoadRow, 'patients' | 'nurses' | 'ratio' | 'limit' | 'level'> | null | undefined }) {
  if (!l) return null;
  const cls = l.level === 'over' ? 'danger' : l.level === 'none' && l.patients > 0 ? 'warn' : 'info';
  return <span className={`chip ${cls}`} title={`ექთანი ახლა ცვლაში (გამოქვეყნებული განრიგი): ${l.nurses}; პაციენტი: ${l.patients}; ზღვარი 1 : ${l.limit} (ინფორმაციული)`}>
    ექთანი {l.nurses}{l.patients === 0 ? ' · პაციენტი არ არის' : l.ratio !== null ? ` · 1 : ${l.ratio}` : ' · ექთანი არ არის'}</span>;
}

/** სტაციონარის / ICU დატვირთვა ახლა („მორიგეები“ ჩანართი) */
export function LoadCard() {
  const q = useQuery({ queryKey: ['roster-load'], queryFn: () => api<{ departments: LoadRow[]; at: string }>('/roster/lookup/load'), refetchInterval: 120_000 });
  const rows = q.data?.departments ?? [];
  if (!rows.length) return null;
  const LV: Record<string, string> = { ward: 'პალატა', intensive: 'ინტენსიური', icu: 'რეანიმაცია' };
  return (
    <section className="card">
      <div className="card-head"><h2 style={{ margin: 0 }}>დატვირთვა ახლა — პაციენტი / ექთანი</h2><span className="small muted">ინფორმაციული; ზღვარი — მოდულის პარამეტრი (nurse_ratio)</span></div>
      <table className="table small"><thead><tr><th>განყოფილება</th><th>დონე</th><th className="num">პაციენტი</th><th className="num">ექთანი</th><th>თანაფარდობა</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.department_id}><td>{r.department_name}</td><td>{LV[r.care_level] ?? r.care_level}</td><td className="num">{r.patients}</td><td className="num">{r.nurses}</td>
          <td><LoadBadge l={r} /> <span className="muted">ზღვარი 1 : {r.limit}</span></td></tr>)}</tbody></table>
    </section>
  );
}
