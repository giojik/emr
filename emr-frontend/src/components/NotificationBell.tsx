import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { time, tsDate } from '../lib/format';

interface Note { id: string; kind: string; title: string; body: string | null; link: string | null; items: string[]; urgent: boolean; updated_at: string; read_at: string | null }

/** ზარი: თანამშრომლის შეტყობინებები (მაგ. „ანალიზის პასუხი მზადაა“). ახლდება 30 წმ-ში; სასწრაფო — წითლად */
export default function NotificationBell() {
  const qc = useQueryClient(); const nav = useNavigate();
  const [open, setOpen] = useState(false); const ref = useRef<HTMLDivElement>(null);
  const cnt = useQuery({ queryKey: ['notif-count'], queryFn: () => api<{ unread: number; urgent: number }>('/notifications/count'), refetchInterval: 30_000 });
  const list = useQuery({ queryKey: ['notif-list'], queryFn: () => api<Note[]>('/notifications'), enabled: open });
  const read = useMutation({ mutationFn: (id?: string) => api(id ? `/notifications/${id}/read` : '/notifications/read-all', { method: 'POST' }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['notif-count'] }); void qc.invalidateQueries({ queryKey: ['notif-list'] }); } });
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h);
  }, [open]);
  const n = cnt.data?.unread ?? 0; const urgent = (cnt.data?.urgent ?? 0) > 0;
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" className="icon-btn" aria-label={`შეტყობინებები${n ? ` (${n})` : ''}`} title="შეტყობინებები" onClick={() => setOpen(!open)} style={{ position: 'relative' }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg>
        {n > 0 && <span style={{ position: 'absolute', top: -2, right: -2, minWidth: 16, height: 16, borderRadius: 8, fontSize: 10, lineHeight: '16px', textAlign: 'center', padding: '0 4px',
          color: '#fff', background: urgent ? '#B42318' : 'var(--accent)', fontWeight: 700 }}>{n > 99 ? '99+' : n}</span>}
      </button>
      {open && <div className="card" role="dialog" aria-label="შეტყობინებები" style={{ position: 'fixed', left: 12, bottom: 64, width: 380, maxHeight: '70vh', overflowY: 'auto', zIndex: 50, boxShadow: '0 8px 30px rgba(0,0,0,.18)' }}>
        <div className="card-pad row" style={{ paddingBottom: 6 }}><strong className="grow">შეტყობინებები</strong>
          {n > 0 && <button className="btn sm" type="button" onClick={() => read.mutate(undefined)}>ყველა წაკითხულია</button>}</div>
        {!list.data?.length ? <div className="empty small">შეტყობინებები არ არის.</div> : list.data.map((x) => (
          <button key={x.id} type="button" className="card-pad" onClick={() => { if (!x.read_at) read.mutate(x.id); setOpen(false); if (x.link) nav(x.link); }}
            style={{ display: 'block', width: '100%', textAlign: 'left', border: 0, borderTop: '1px solid var(--line)', background: x.read_at ? 'transparent' : x.urgent ? 'var(--danger-weak)' : 'var(--accent-weak, #eef4fb)', cursor: 'pointer', font: 'inherit' }}>
            <div className="row" style={{ gap: 6 }}><strong className="grow" style={{ fontSize: 13, color: x.urgent ? 'var(--danger-ink)' : undefined }}>{x.title}</strong>
              <span className="small muted">{tsDate(x.updated_at)} {time(x.updated_at)}</span></div>
            {x.body && <div className="small">{x.body}</div>}
            {x.items.length > 0 && <div className="small muted">{x.items.join(', ')}</div>}
          </button>))}
      </div>}
    </div>
  );
}
