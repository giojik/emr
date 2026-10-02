import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, can } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Loading } from '../../components/ui';
import ItemSearch from './ItemSearch';
import { qtyFmt, type MinmaxRow, type StockLocation } from './types';

/** მინ/მაქს ლოკაციაზე: მინიმუმზე ქვემოთ → მოთხოვნის მონახაზი მაქსიმუმამდე (ნაშთი + გზაში + გაუცემელი მოთხოვნა ითვლება) */
export default function Minmax() {
  const { user } = useAuth(); const qc = useQueryClient(); const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const loc = sp.get('location_id') ?? '';
  const locs = useQuery({ queryKey: ['stock-locations', false], queryFn: () => api<StockLocation[]>('/stock/locations') });
  const mine = useQuery({ queryKey: ['stock-my-locations'], queryFn: () => api<StockLocation[]>('/stock/my-locations') });
  const q = useQuery({ queryKey: ['stock-minmax', loc], queryFn: () => api<MinmaxRow[]>('/stock/minmax', { query: { location_id: loc } }), enabled: !!loc });
  const [edit, setEdit] = useState<Record<string, { min: string; max: string }>>({});
  const [src, setSrc] = useState('');
  const l = locs.data?.find((x) => x.id === loc);
  const done = (r: MinmaxRow[]) => { qc.setQueryData(['stock-minmax', loc], r); };
  const save = useMutation({ mutationFn: (b: { item_id: string; min: string; max: string }) => api<MinmaxRow[]>('/stock/minmax', { method: 'PUT', body: { location_id: loc, item_id: b.item_id, min_qty: Number(b.min.replace(',', '.')), max_qty: Number(b.max.replace(',', '.')) } }),
    onSuccess: (r, b) => { done(r); setEdit((e) => { const n = { ...e }; delete n[b.item_id]; return n; }); } });
  const del = useMutation({ mutationFn: (itemId: string) => api<MinmaxRow[]>(`/stock/minmax/${loc}/${itemId}`, { method: 'DELETE' }), onSuccess: done });
  const req = useMutation({ mutationFn: () => api<{ id: string }>('/stock/minmax/request', { body: { location_id: loc, from_location_id: src || null } }), onSuccess: (r) => nav(`/stock/requests?req=${r.id}`) });
  const below = (q.data ?? []).filter((r) => r.below);
  const canSet = can(user, 'admin', 'stock_manager') || !!l?.department_id;   // ხელმძღვანელი — სერვერი ამოწმებს
  const sources = (locs.data ?? []).filter((x) => ['pharmacy', 'central', 'household'].includes(x.kind) && x.id !== loc);
  const options = can(user, 'admin', 'stock_manager', 'storekeeper') ? (locs.data ?? []).filter((x) => x.kind !== 'transit') : mine.data ?? [];
  return (
    <div className="content">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <select className="select" style={{ maxWidth: 320, height: 38 }} aria-label="ლოკაცია" value={loc} onChange={(e) => setSp(e.target.value ? { location_id: e.target.value } : {})}>
          <option value="">— ლოკაცია —</option>{options.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
        <span className="hint grow">მინიმუმზე ქვემოთ: ნაშთი (აქტიური, ვადიანი) + გზაში + გაუცემელი მოთხოვნა &lt; მინ. შემოწმება — ყოველ დილით (შეტყობინება ხელმძღვანელს / საწყობს).</span>
      </div>
      {loc && (
        <>
          {below.length > 0 && (
            <div className="alert warn row" style={{ flexWrap: 'wrap' }}>
              <span className="grow">მინიმუმზე ქვემოთ: <strong>{below.length}</strong> პოზიცია</span>
              <select className="select" style={{ maxWidth: 260, height: 36 }} aria-label="საიდან" value={src} onChange={(e) => setSrc(e.target.value)}>
                <option value="">{l?.default_source_id ? `ნაგულისხმევი: ${locs.data?.find((x) => x.id === l.default_source_id)?.name ?? ''}` : '— საიდან —'}</option>
                {sources.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
              <button className="btn primary" type="button" disabled={req.isPending || (!src && !l?.default_source_id)} onClick={() => req.mutate()}>მოთხოვნის მონახაზი</button>
            </div>)}
          <ErrorBox error={req.error} />
          {canSet && <section className="card card-pad"><ItemSearch placeholder="დაამატეთ საქონელი მინ/მაქს-ისთვის" onPick={(i) => setEdit((e) => ({ ...e, [i.id]: { min: '', max: '' } }))} /></section>}
          {q.isLoading ? <Loading /> : (
            <div className="card">
              <table className="table">
                <thead><tr><th>საქონელი</th><th className="num">ნაშთი</th><th className="num">გზაში</th><th className="num">მოთხოვნილი</th><th className="num">მინ.</th><th className="num">მაქს.</th><th className="num">შეთავაზება</th><th /></tr></thead>
                <tbody>
                  {Object.entries(edit).filter(([id]) => !q.data?.some((r) => r.item_id === id)).map(([id, v]) => (
                    <tr key={id}><td className="muted">ახალი პოზიცია</td><td colSpan={3} />
                      <td className="num"><input className="input mono num" style={{ height: 32, width: 80 }} aria-label="მინ." value={v.min} onChange={(e) => setEdit({ ...edit, [id]: { ...v, min: e.target.value } })} /></td>
                      <td className="num"><input className="input mono num" style={{ height: 32, width: 80 }} aria-label="მაქს." value={v.max} onChange={(e) => setEdit({ ...edit, [id]: { ...v, max: e.target.value } })} /></td>
                      <td /><td><button className="btn sm primary" type="button" disabled={!v.min || !v.max} onClick={() => save.mutate({ item_id: id, ...v })}>შენახვა</button></td></tr>))}
                  {q.data?.map((r) => {
                    const e = edit[r.item_id];
                    return (
                      <tr key={r.item_id} style={r.below ? { background: 'var(--warn-weak)' } : undefined}>
                        <td><strong>{r.item_name}</strong> <span className="mono small muted">{r.item_code}</span></td>
                        <td className="num">{qtyFmt(r.on_hand)} <span className="small muted">{r.base_unit_name}</span></td><td className="num">{qtyFmt(r.in_transit)}</td><td className="num">{qtyFmt(Math.max(0, Number(r.requested)))}</td>
                        <td className="num">{e ? <input className="input mono num" style={{ height: 32, width: 80 }} aria-label="მინ." value={e.min} onChange={(x) => setEdit({ ...edit, [r.item_id]: { ...e, min: x.target.value } })} /> : qtyFmt(r.min_qty)}</td>
                        <td className="num">{e ? <input className="input mono num" style={{ height: 32, width: 80 }} aria-label="მაქს." value={e.max} onChange={(x) => setEdit({ ...edit, [r.item_id]: { ...e, max: x.target.value } })} /> : qtyFmt(r.max_qty)}</td>
                        <td className="num">{r.below ? <strong>{qtyFmt(r.suggested)}</strong> : '—'}</td>
                        <td>{canSet && (e ? <button className="btn sm primary" type="button" onClick={() => save.mutate({ item_id: r.item_id, ...e })}>შენახვა</button>
                          : <span className="row" style={{ gap: 4 }}><button className="btn sm" type="button" onClick={() => setEdit({ ...edit, [r.item_id]: { min: qtyFmt(r.min_qty), max: qtyFmt(r.max_qty) } })}>შეცვლა</button>
                            <button className="icon-btn" type="button" aria-label="წაშლა" onClick={() => { if (confirm(`მოვხსნათ მინ/მაქს: ${r.item_name}?`)) del.mutate(r.item_id); }}>×</button></span>)}</td>
                      </tr>);
                  })}
                  {!q.data?.length && !Object.keys(edit).length && <tr><td colSpan={8} className="muted">მინ/მაქს არ არის დაყენებული</td></tr>}
                </tbody>
              </table>
            </div>)}
          <ErrorBox error={q.error ?? save.error ?? del.error} />
        </>)}
    </div>
  );
}
