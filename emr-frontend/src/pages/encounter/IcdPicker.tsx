import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import type { IcdCode } from '../../api/types';
import { Spinner, useDebounced } from '../../components/ui';

/** ICD-10 ძებნა (კოდი ან სიტყვები). primary=true — "*" კოდები გამოირიცხება */
export default function IcdPicker({ primary, onPick, disabled }: { primary: boolean; onPick: (c: IcdCode) => void; disabled?: boolean }) {
  const [q, setQ] = useState(''); const [idx, setIdx] = useState(0); const [open, setOpen] = useState(false);
  const dq = useDebounced(q.trim(), 200);
  const r = useQuery({
    queryKey: ['icd10', dq, primary],
    queryFn: () => api<IcdCode[]>('/icd10', { query: { search: dq, limit: 12, primary } }),
    enabled: dq.length >= 2,
  });
  const items = dq.length >= 2 ? r.data ?? [] : [];
  const pick = (c: IcdCode) => { onPick(c); setQ(''); setOpen(false); };
  return (
    <div style={{ position: 'relative' }} className="grow">
      <label htmlFor="icd" className="sr-only">ICD-10 ძებნა</label>
      <input id="icd" className="input" disabled={disabled} autoComplete="off" placeholder="კოდი (I10) ან დიაგნოზი"
        role="combobox" aria-expanded={open && items.length > 0} aria-controls="icd-list"
        value={q} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => { setQ(e.target.value); setIdx(0); setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(i + 1, items.length - 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
          if (e.key === 'Enter' && items[idx]) { e.preventDefault(); pick(items[idx]); }
          if (e.key === 'Escape') setOpen(false);
        }} />
      {r.isFetching && <div style={{ position: 'absolute', right: 10, top: 13 }}><Spinner /></div>}
      {open && items.length > 0 && (
        <ul className="listbox" id="icd-list" role="listbox" aria-label="ICD-10" style={{ position: 'absolute', left: 0, right: 0, zIndex: 20 }}>
          {items.map((c, i) => (
            <li key={c.code} role="option" aria-selected={i === idx} onMouseEnter={() => setIdx(i)} onMouseDown={(e) => { e.preventDefault(); pick(c); }}>
              <span className="mono" style={{ width: 56, fontWeight: 600, color: 'var(--accent)', flexShrink: 0 }}>{c.code}{c.is_asterisk ? '*' : ''}</span>
              <span style={{ fontSize: 13 }}>{c.title}</span>
            </li>
          ))}
        </ul>
      )}
      {open && dq.length >= 2 && !r.isFetching && items.length === 0 && <div className="hint" style={{ padding: 6 }}>ვერ მოიძებნა{primary ? ' („*“ კოდები ძირითადად დაუშვებელია)' : ''}</div>}
    </div>
  );
}
