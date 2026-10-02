import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import { Spinner, useDebounced } from '../../components/ui';
import { CONTROLLED_KA, type StockItem } from './types';

export interface ScanHit { item: StockItem; lot: string | null; serial: string | null; expiry: string | null; pack_id: string | null }

/** საქონლის ძებნა + სკანირება (GS1 DataMatrix / EAN → საქონელი, ლოტი, სერიული, ვადა) */
export default function ItemSearch({ onPick, onScan, disabled, placeholder }: { onPick: (i: StockItem) => void; onScan?: (h: ScanHit) => void; disabled?: boolean; placeholder?: string }) {
  const [q, setQ] = useState(''); const ds = useDebounced(q.trim(), 250); const [msg, setMsg] = useState<string | null>(null);
  const found = useQuery({ queryKey: ['stock-items', 'pick', ds], queryFn: () => api<StockItem[]>('/stock/items', { query: { search: ds, limit: 20 } }), enabled: ds.length >= 2 && !disabled });
  const scan = useMutation({
    mutationFn: (c: string) => api<{ item: StockItem | null; pack: { id: string } | null; parsed: { lot: string | null; serial: string | null; expiry: string | null }; warnings: string[] }>('/stock/scan', { body: { code: c } }),
    onSuccess: (r) => {
      if (!r.item) { setMsg(r.warnings.join('; ') || 'ვერ მოიძებნა'); return; }
      setMsg(null); setQ('');
      if (onScan) onScan({ item: r.item, lot: r.parsed.lot?.toUpperCase() ?? null, serial: r.parsed.serial?.toUpperCase() ?? null, expiry: r.parsed.expiry, pack_id: r.pack?.id ?? null });
      else onPick(r.item);
    },
  });
  return (
    <div className="stack" style={{ gap: 4, position: 'relative' }}>
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (q.trim().length >= 8 && /\d{8}|\(01\)|^\]d2/.test(q.trim())) scan.mutate(q.trim()); }}>
        <input className="input" style={{ height: 38 }} aria-label="საქონლის ძებნა ან სკანირება" disabled={disabled} placeholder={placeholder ?? 'ძებნა (დასახელება, INN, კოდი) ან სკანირება → Enter'} value={q} onChange={(e) => setQ(e.target.value)} />
        {scan.isPending && <Spinner />}
      </form>
      {ds.length >= 2 && !scan.isPending && (found.data?.length ?? 0) > 0 && (
        <ul className="listbox" role="listbox" aria-label="საქონელი" style={{ position: 'absolute', top: 40, left: 0, right: 0, zIndex: 5 }}>
          {found.data!.filter((i) => i.is_active).map((i) => <li key={i.id} role="option" aria-selected={false} onMouseDown={(e) => { e.preventDefault(); onPick(i); setQ(''); }}>
            <span className="grow">{i.name}{i.inn && <span className="small muted"> · {i.inn}{i.strength ? ` ${i.strength}` : ''}</span>}</span>
            {i.controlled_class && <span className="chip danger" style={{ height: 20, fontSize: 11 }}>{CONTROLLED_KA[i.controlled_class]}</span>}
            <span className="mono small muted">{i.code}</span></li>)}
        </ul>)}
      {msg && <span className="small" style={{ color: 'var(--danger-ink)' }}>{msg}</span>}
    </div>
  );
}
