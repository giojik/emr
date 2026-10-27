import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useModules } from '../lib/modules';

interface Count { total: number; overdue: number; urgent: number; badge: 'all' | 'overdue' | 'off'; enabled: boolean }

/** 0081: „ჩემი დავალებები“ — მთვლელი (სულ / ვადაგადაცილებული წითლად); badge = off ან მოდული გამორთულია — არ ჩანს */
export default function WorklistBadge() {
  const nav = useNavigate();
  const mods = useModules();
  const m = mods.data?.find((x) => x.code === 'worklist');
  const s = (m?.settings ?? {}) as { badge?: string; refresh_seconds?: number };
  const on = !!m?.enabled && s.badge !== 'off';
  const q = useQuery({ queryKey: ['wl-count'], queryFn: () => api<Count>('/worklist/count'), enabled: on, refetchInterval: Math.max(30, s.refresh_seconds ?? 60) * 1000 });
  if (!on) return null;
  const d = q.data;
  const n = d ? (d.badge === 'overdue' ? d.overdue : d.total) : 0;
  const red = !!d && (d.overdue > 0 || d.urgent > 0);
  const label = d ? `ჩემი დავალებები: ${d.total}${d.overdue ? `, ვადაგადაცილებული ${d.overdue}` : ''}` : 'ჩემი დავალებები';
  return (
    <button type="button" className="icon-btn" aria-label={label} title={label} onClick={() => nav('/tasks')} style={{ position: 'relative' }}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M9 6h11M9 12h11M9 18h11" /><path d="M3.5 6l1.5 1.5L7.5 5" /><path d="M3.5 12l1.5 1.5L7.5 11" /><path d="M3.5 18l1.5 1.5L7.5 17" /></svg>
      {n > 0 && <span style={{ position: 'absolute', top: -2, right: -2, minWidth: 16, height: 16, borderRadius: 8, fontSize: 10, lineHeight: '16px', textAlign: 'center', padding: '0 4px',
        color: '#fff', background: red ? '#B42318' : 'var(--accent)', fontWeight: 700 }}>{n > 99 ? '99+' : n}</span>}
    </button>
  );
}
