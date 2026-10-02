import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import { ErrorBox, Loading, Modal, useDebounced } from '../../components/ui';
import { dateGe, tsDate } from '../../lib/format';
import { LotDialog } from './Lots';
import { COSTING_KA, CONTROLLED_KA, DOC_TYPE_KA, money2, packBreakdown, qtyFmt, useStockRefs, type Balances as B, type BalanceRow, type MoveRow, type StockLocation } from './types';

const EXP: [string, string][] = [['', 'ყველა ვადა'], ['-1', 'ვადაგასული'], ['30', '≤ 30 დღე'], ['45', '≤ 45 დღე'], ['60', '≤ 60 დღე'], ['90', '≤ 90 დღე'], ['180', '≤ 180 დღე']];

/** ნაშთები ლოკაციებზე, ლოტებით; ღირებულება — კლინიკის მეთოდით (ლოტის ფასი / საშუალო) */
export default function Balances() {
  const refs = useStockRefs(); const [sp] = useSearchParams();
  // შეტყობინებიდან: ?location_id=…&expiring_days=…
  const [f, setF] = useState({ location_id: sp.get('location_id') ?? '', category_id: '', expiring_days: sp.get('expiring_days') ?? '', search: '' });
  const ds = useDebounced(f.search.trim(), 300);
  const locs = useQuery({ queryKey: ['stock-locations', false], queryFn: () => api<StockLocation[]>('/stock/locations') });
  const q = useQuery({ queryKey: ['stock-balances', f.location_id, f.category_id, f.expiring_days, ds], queryFn: () => api<B>('/stock/balances', { query: { ...f, search: ds } }) });
  const [hist, setHist] = useState<BalanceRow | null>(null);
  return (
    <div className="content">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <input className="input" style={{ maxWidth: 300, height: 38 }} aria-label="ძებნა" placeholder="დასახელება, INN, კოდი, ლოტი, სერიული" value={f.search} onChange={(e) => setF({ ...f, search: e.target.value })} />
        <select className="select" style={{ maxWidth: 220, height: 38 }} aria-label="ლოკაცია" value={f.location_id} onChange={(e) => setF({ ...f, location_id: e.target.value })}>
          <option value="">ყველა ლოკაცია</option>{locs.data?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <select className="select" style={{ maxWidth: 220, height: 38 }} aria-label="კატეგორია" value={f.category_id} onChange={(e) => setF({ ...f, category_id: e.target.value })}>
          <option value="">ყველა კატეგორია</option>{refs.data?.categories.filter((c) => c.is_active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select className="select" style={{ maxWidth: 170, height: 38 }} aria-label="ვადა" value={f.expiring_days} onChange={(e) => setF({ ...f, expiring_days: e.target.value })}>
          {EXP.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <span className="grow" />
        {q.data && <span className="small">ღირებულება ({COSTING_KA[q.data.costing_method]}, დღგ-ს გარეშე): <strong className="mono">{money2(q.data.total_value)}</strong></span>}
      </div>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead><tr><th>საქონელი</th><th>ლოკაცია</th><th>ლოტი / სერიული</th><th>ვადა</th><th className="num">ნაშთი</th><th className="num">ერთ. ფასი</th><th className="num">ღირებულება</th></tr></thead>
            <tbody>{q.data?.rows.map((r) => {
              const expired = r.days_left !== null && r.days_left < 0; const soon = r.days_left !== null && r.warn_days !== null && r.days_left <= r.warn_days;
              const qty = Number(r.qty); const pb = packBreakdown(qty, r.packs);
              return (
                <tr key={`${r.location_id}-${r.lot_id}`} className="clickable" onClick={() => setHist(r)}>
                  <td><strong>{r.item_name}</strong> <span className="mono small muted">{r.item_code}</span>
                    {r.inn && <div className="small muted">{r.inn}{r.strength ? ` ${r.strength}` : ''}</div>}
                    {r.controlled_class && <span className="chip danger" style={{ height: 20, fontSize: 11 }}>{CONTROLLED_KA[r.controlled_class]}</span>}</td>
                  <td>{r.location_name}</td>
                  <td className="mono small">{r.lot_no ?? '—'}{r.serial_no && <div>SN {r.serial_no}</div>}{r.lot_status !== 'active' && <span className="chip danger" style={{ height: 20, fontSize: 11 }}>{r.lot_status === 'recalled' ? 'გაწვეული' : 'ქარანტინი'}</span>}</td>
                  <td>{r.expires_on ? <span className={`chip ${expired ? 'danger' : soon ? 'warn' : ''}`}>{dateGe(r.expires_on)}{expired ? ' · ვადაგასული' : soon ? ` · ${r.days_left} დღე` : ''}</span> : '—'}</td>
                  <td className="num"><strong>{qtyFmt(r.qty)}</strong> {r.base_unit_name}{pb && <div className="small muted">{pb}</div>}</td>
                  <td className="num mono">{r.unit_cost.toFixed(4)}</td><td className="num mono">{r.value.toFixed(2)}</td>
                </tr>);
            })}
              {!q.data?.rows.length && <tr><td colSpan={7} className="muted">ნაშთი არ არის</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {hist && <History row={hist} onClose={() => setHist(null)} />}
    </div>
  );
}

interface Moves { item: { id: string; name: string; code: string; base_unit_name: string }; qty_on_hand: string; avg_cost: string; moves: MoveRow[] }

/** საქონლის ბარათი: მოძრაობების ისტორია (ლოკაციით / ლოტით) */
function History({ row, onClose }: { row: BalanceRow; onClose: () => void }) {
  const [scope, setScope] = useState<'lot' | 'location' | 'all'>('lot'); const [trace, setTrace] = useState(false);
  const q = useQuery({ queryKey: ['stock-moves', row.item_id, scope, row.lot_id, row.location_id],
    queryFn: () => api<Moves>(`/stock/items/${row.item_id}/moves`, { query: { ...(scope === 'lot' && { lot_id: row.lot_id, location_id: row.location_id }), ...(scope === 'location' && { location_id: row.location_id }) } }) });
  return (
    <Modal title={`${row.item_name} — მოძრაობები`} onClose={onClose} width={980}>
      <div className="stack">
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <div className="seg" role="group" aria-label="ფილტრი">
            <button type="button" aria-pressed={scope === 'lot'} onClick={() => setScope('lot')}>ეს ლოტი · {row.location_name}</button>
            <button type="button" aria-pressed={scope === 'location'} onClick={() => setScope('location')}>{row.location_name}</button>
            <button type="button" aria-pressed={scope === 'all'} onClick={() => setScope('all')}>ყველა ლოკაცია</button>
          </div>
          <button className="btn sm" type="button" onClick={() => setTrace(true)}>ლოტი: მიკვლევა / ქარანტინი</button>
          <span className="grow" />
          {q.data && <span className="small">სულ მარაგში: <strong>{qtyFmt(q.data.qty_on_hand)} {q.data.item.base_unit_name}</strong> · საშუალო ფასი <span className="mono">{Number(q.data.avg_cost).toFixed(4)} ₾</span></span>}
        </div>
        <ErrorBox error={q.error} />
        {trace && <LotDialog id={row.lot_id} onClose={() => setTrace(false)} />}
        {q.isLoading ? <Loading /> : (
          <table className="table">
            <thead><tr><th>დრო</th><th>დოკუმენტი</th><th>ლოკაცია</th><th>ლოტი</th><th className="num">რაოდენობა</th><th className="num">ლოტის ფასი</th><th className="num">საშუალო</th><th>მომხმარებელი</th></tr></thead>
            <tbody>{q.data?.moves.map((m) => (
              <tr key={m.id}>
                <td className="small">{tsDate(m.created_at)}</td><td><span className="mono">{m.doc_no ?? '—'}</span> <span className="small muted">{DOC_TYPE_KA[m.doc_type] ?? m.doc_type}</span></td>
                <td className="small">{m.location_name}</td><td className="mono small">{m.lot_no ?? '—'}{m.serial_no && ` · SN ${m.serial_no}`}</td>
                <td className="num mono" style={{ color: Number(m.qty) < 0 ? 'var(--danger-ink)' : 'var(--ok-ink)' }}>{Number(m.qty) > 0 ? '+' : ''}{qtyFmt(m.qty)}</td>
                <td className="num mono">{Number(m.cost_lot).toFixed(4)}</td><td className="num mono">{m.cost_avg !== null ? Number(m.cost_avg).toFixed(4) : '—'}</td><td className="small">{m.user_name}</td>
              </tr>))}
              {!q.data?.moves.length && <tr><td colSpan={8} className="muted">მოძრაობა არ არის</td></tr>}
            </tbody>
          </table>)}
      </div>
    </Modal>
  );
}
