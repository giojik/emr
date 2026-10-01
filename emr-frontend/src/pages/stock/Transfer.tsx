import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, can } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, useDebounced, useToast } from '../../components/ui';
import { dateGe } from '../../lib/format';
import { qtyFmt, type LotAvail, type StockItem, type StockLocation } from './types';

interface Line { key: string; item: Pick<StockItem, 'id' | 'name' | 'code' | 'base_unit_name'>; lots: LotAvail[]; lot_id: string; qty: string; override_reason: string }
let seq = 0;

/** პირდაპირი გადაცემა (საწყობი → ლოკაცია, მოთხოვნის გარეშე) ან დაბრუნება (ქვესაწყობი → აფთიაქი / საწყობი) */
export default function Transfer() {
  const { user } = useAuth(); const qc = useQueryClient(); const toast = useToast();
  const stockRole = can(user, 'admin', 'storekeeper', 'stock_manager', 'pharmacist');
  const [type, setType] = useState<'transfer' | 'return'>(stockRole ? 'transfer' : 'return');
  const mine = useQuery({ queryKey: ['stock-my-locations'], queryFn: () => api<StockLocation[]>('/stock/my-locations') });
  const locs = useQuery({ queryKey: ['stock-locations', false], queryFn: () => api<StockLocation[]>('/stock/locations') });
  const [h, setH] = useState({ from: '', to: '', notes: '' });
  const [lines, setLines] = useState<Line[]>([]);
  const [search, setSearch] = useState(''); const ds = useDebounced(search.trim(), 250);
  const found = useQuery({ queryKey: ['stock-items', 'pick', ds], queryFn: () => api<StockItem[]>('/stock/items', { query: { search: ds, limit: 20 } }), enabled: ds.length >= 2 && !!h.from });
  const add = async (i: StockItem) => {
    const lots = await api<LotAvail[]>(`/stock/locations/${h.from}/lots`, { query: { item_id: i.id } });
    setLines((ls) => [...ls, { key: `t${++seq}`, item: i, lots, lot_id: lots[0]?.lot_id ?? '', qty: '1', override_reason: '' }]); setSearch('');
  };
  const send = useMutation({
    mutationFn: () => api<{ id: string; no: string }>('/stock/transfers', { body: { doc_type: type, from_location_id: h.from, to_location_id: h.to, notes: h.notes || null,
      lines: lines.map((l) => ({ lot_id: l.lot_id, qty_base: Number(l.qty.replace(',', '.')), override_reason: l.override_reason || null })) } }),
    onSuccess: (r) => { toast.show(`გაიგზავნა: ${r.no} — ელოდება მიმღების დადასტურებას`); setLines([]); setH({ ...h, notes: '' }); for (const k of ['stock-balances', 'stock-transit']) void qc.invalidateQueries({ queryKey: [k] }); },
  });
  const targets = (locs.data ?? []).filter((l) => l.kind !== 'transit' && l.id !== h.from && (type === 'transfer' || ['pharmacy', 'central', 'household'].includes(l.kind)));
  const upd = (k: string, p: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === k ? { ...l, ...p } : l)));
  const valid = h.from && h.to && lines.length && lines.every((l) => l.lot_id && Number(l.qty.replace(',', '.')) > 0) && (type === 'transfer' || h.notes.trim().length >= 3);
  return (
    <div className="content">
      {toast.node}
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <div className="seg" role="group" aria-label="ტიპი">
          {stockRole && <button type="button" aria-pressed={type === 'transfer'} onClick={() => setType('transfer')}>გადაცემა</button>}
          <button type="button" aria-pressed={type === 'return'} onClick={() => setType('return')}>დაბრუნება საწყობში</button>
        </div>
        <span className="hint grow">{type === 'transfer' ? 'მოთხოვნის გარეშე გადაცემა (მაგ. საოპერაციოს მარაგის შევსება). FEFO — სხვა ლოტისთვის მიზეზი.' : 'ზედმეტი / გამოუყენებელი მარაგის დაბრუნება; მიზეზი სავალდებულოა.'} მიმღები ადასტურებს „მისაღებში“.</span>
        <button className="btn primary" type="button" disabled={!valid || send.isPending} onClick={() => { if (confirm('გავგზავნოთ?')) send.mutate(); }}>გაგზავნა</button>
      </div>
      <section className="card card-pad" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
        <div className="field"><label htmlFor="tf">ვისგან (ჩემი ლოკაცია) <span className="req">*</span></label>
          <select id="tf" className="select" value={h.from} onChange={(e) => { setH({ ...h, from: e.target.value }); setLines([]); }}>
            <option value="">— აირჩიეთ —</option>{mine.data?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>
        <div className="field"><label htmlFor="tt">ვისთვის <span className="req">*</span></label>
          <select id="tt" className="select" value={h.to} onChange={(e) => setH({ ...h, to: e.target.value })}>
            <option value="">— აირჩიეთ —</option>{targets.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>
        <div className="field"><label htmlFor="tn">{type === 'return' ? 'დაბრუნების მიზეზი' : 'შენიშვნა'}{type === 'return' && <span className="req"> *</span>}</label>
          <input id="tn" className="input" value={h.notes} onChange={(e) => setH({ ...h, notes: e.target.value })} /></div>
      </section>
      <section className="card card-pad stack" style={{ gap: 0, position: 'relative' }}>
        <input className="input" style={{ height: 38 }} aria-label="საქონლის ძებნა" disabled={!h.from} placeholder={h.from ? 'საქონელი: დასახელება, INN, კოდი' : 'ჯერ აირჩიეთ „ვისგან“'} value={search} onChange={(e) => setSearch(e.target.value)} />
        {ds.length >= 2 && (found.data?.length ?? 0) > 0 && (
          <ul className="listbox" role="listbox" aria-label="საქონელი" style={{ position: 'absolute', top: 54, left: 16, right: 16, zIndex: 5 }}>
            {found.data!.map((i) => <li key={i.id} role="option" aria-selected={false} onMouseDown={(e) => { e.preventDefault(); void add(i); }}><span className="grow">{i.name}</span><span className="mono small muted">{i.code}</span></li>)}
          </ul>)}
      </section>
      <section className="card">
        <table className="table">
          <thead><tr><th>საქონელი</th><th>ლოტი (FEFO)</th><th className="num">რაოდენობა</th><th /></tr></thead>
          <tbody>{lines.map((l) => {
            const notFefo = l.lots.length > 1 && l.lot_id !== l.lots[0].lot_id && (l.lots.find((y) => y.lot_id === l.lot_id)?.expires_on ?? '9999') > (l.lots[0].expires_on ?? '9999');
            return (
              <tr key={l.key}>
                <td><strong>{l.item.name}</strong> <span className="mono small muted">{l.item.code}</span></td>
                <td>{l.lots.length ? <select className="select" style={{ height: 34, maxWidth: 340 }} aria-label="ლოტი" value={l.lot_id} onChange={(e) => upd(l.key, { lot_id: e.target.value })}>
                  {l.lots.map((y) => <option key={y.lot_id} value={y.lot_id}>{y.lot_no ?? 'ლოტის გარეშე'}{y.serial_no ? ` · SN ${y.serial_no}` : ''} — {y.expires_on ? dateGe(y.expires_on) : 'ვადის გარეშე'} (ნაშთი {qtyFmt(y.qty ?? 0)})</option>)}
                </select> : <span className="small" style={{ color: 'var(--danger-ink)' }}>ნაშთი არ არის</span>}
                  {notFefo && type === 'transfer' && <input className="input" style={{ height: 32, marginTop: 4, maxWidth: 340 }} aria-label="მიზეზი" placeholder="არა FEFO — მიზეზი" value={l.override_reason} onChange={(e) => upd(l.key, { override_reason: e.target.value })} />}</td>
                <td><input className="input mono num" style={{ height: 34, width: 90 }} aria-label="რაოდენობა" inputMode="decimal" value={l.qty} onChange={(e) => upd(l.key, { qty: e.target.value })} /> <span className="small muted">{l.item.base_unit_name}</span></td>
                <td><button className="icon-btn" type="button" aria-label="წაშლა" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>×</button></td>
              </tr>);
          })}
            {!lines.length && <tr><td colSpan={4} className="muted">დაამატეთ საქონელი</td></tr>}
          </tbody>
        </table>
      </section>
      <ErrorBox error={send.error} />
    </div>
  );
}
