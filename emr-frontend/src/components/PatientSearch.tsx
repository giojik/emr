import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api/client';
import type { PatientListItem } from '../api/types';
import { dateGe } from '../lib/format';
import { Spinner, useDebounced } from './ui';

/** პაციენტის ძებნა: პირადი № / გვარი / ტელეფონი; ↑↓ Enter კლავიატურით */
export default function PatientSearch({ onSelect, autoFocus, initial = '' }: { onSelect: (p: PatientListItem) => void; autoFocus?: boolean; initial?: string }) {
  const [q, setQ] = useState(initial);
  const [idx, setIdx] = useState(0);
  const dq = useDebounced(q.trim(), 250);
  const res = useQuery({
    queryKey: ['patients', 'search', dq],
    queryFn: () => api<PatientListItem[]>('/patients', { query: { search: dq } }),
    enabled: dq.length >= 2,
  });
  const items = dq.length >= 2 ? res.data ?? [] : [];

  return (
    <div className="stack" style={{ gap: 0 }}>
      <label htmlFor="psearch" className="sr-only">პაციენტის ძებნა</label>
      <div className="row" style={{ position: 'relative' }}>
        <input id="psearch" className="input" autoFocus={autoFocus} autoComplete="off" placeholder="პირადი ნომერი, გვარი ან ტელეფონი"
          value={q} onChange={(e) => { setQ(e.target.value); setIdx(0); }}
          role="combobox" aria-expanded={items.length > 0} aria-controls="psearch-list"
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(i + 1, items.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
            if (e.key === 'Enter' && items[idx]) { e.preventDefault(); onSelect(items[idx]); }
          }} />
        {res.isFetching && <div style={{ position: 'absolute', right: 12 }}><Spinner /></div>}
      </div>
      {dq.length >= 2 && !res.isFetching && items.length === 0 && <div className="hint" style={{ padding: '8px 2px' }}>ვერ მოიძებნა</div>}
      {items.length > 0 && (
        <ul className="listbox" id="psearch-list" role="listbox" aria-label="შედეგები">
          {items.map((p, i) => (
            <li key={p.id} role="option" aria-selected={i === idx} onMouseEnter={() => setIdx(i)} onMouseDown={(e) => { e.preventDefault(); onSelect(p); }}>
              <span className="grow"><strong>{p.first_name} {p.last_name}</strong></span>
              <span className="mono small muted">{p.personal_number ?? p.passport_number} · {dateGe(p.birth_date)} · {p.phone_number}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
