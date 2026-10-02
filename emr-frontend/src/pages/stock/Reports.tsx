import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import { ErrorBox, Loading } from '../../components/ui';
import { todayISO } from '../../lib/format';
import { COSTING_KA, downloadCsv, money2, qtyFmt, useStockRefs, WO_REASON_KA, type StockLocation } from './types';

type Turn = { item_id: string; item_name: string; item_code: string; unit: string } & Record<string, number>;
const COLS: [string, string][] = [['open', 'საწყისი'], ['receipt', 'მიღება'], ['transfer', 'გადაადგილება'], ['consumption', 'ხარჯი'], ['writeoff', 'ჩამოწერა'], ['adjustment', 'კორექტირება'], ['close', 'საბოლოო']];
const firstOfMonth = () => `${todayISO().slice(0, 8)}01`;

/** საწყობის რეპორტები: ღირებულება, მოძრაობის უწყისი, ხარჯი / ჩამოწერა — CSV ჩამოტვირთვით */
export default function Reports() {
  const [tab, setTab] = useState<'value' | 'turnover' | 'consumption'>('value');
  return (
    <div className="content">
      <div className="seg" role="group" aria-label="რეპორტი" style={{ alignSelf: 'flex-start' }}>
        <button type="button" aria-pressed={tab === 'value'} onClick={() => setTab('value')}>ნაშთის ღირებულება</button>
        <button type="button" aria-pressed={tab === 'turnover'} onClick={() => setTab('turnover')}>მოძრაობის უწყისი</button>
        <button type="button" aria-pressed={tab === 'consumption'} onClick={() => setTab('consumption')}>ხარჯი და ჩამოწერა</button>
      </div>
      {tab === 'value' ? <Value /> : tab === 'turnover' ? <Turnover /> : <Consumption />}
    </div>
  );
}

function Value() {
  const q = useQuery({ queryKey: ['stock-rep-value'], queryFn: () => api<{ costing_method: 'fifo' | 'average'; total: number; rows: { location_name: string; category_name: string; items: number; lots: number; value: string }[] }>('/stock/reports/value') });
  if (q.isLoading) return <Loading />;
  const d = q.data;
  return (
    <section className="card">
      <div className="card-head row"><h2 className="grow">ნაშთის ღირებულება ახლა {d && <span className="small muted">({COSTING_KA[d.costing_method]}, დღგ-ს გარეშე)</span>}</h2>
        {d && <button className="btn sm" type="button" onClick={() => downloadCsv('ნაშთის-ღირებულება.csv', ['ლოკაცია', 'კატეგორია', 'საქონელი', 'ლოტი', 'ღირებულება'], d.rows.map((r) => [r.location_name, r.category_name, r.items, r.lots, r.value]))}>CSV</button>}</div>
      <table className="table">
        <thead><tr><th>ლოკაცია</th><th>კატეგორია</th><th className="num">საქონელი</th><th className="num">ლოტი</th><th className="num">ღირებულება</th></tr></thead>
        <tbody>{d?.rows.map((r, i) => <tr key={i}><td>{r.location_name}</td><td>{r.category_name}</td><td className="num">{r.items}</td><td className="num">{r.lots}</td><td className="num mono">{Number(r.value).toFixed(2)}</td></tr>)}
          {d && <tr><td colSpan={4}><strong>სულ</strong></td><td className="num mono"><strong>{money2(d.total)}</strong></td></tr>}</tbody>
      </table>
      <ErrorBox error={q.error} />
    </section>
  );
}

function Turnover() {
  const refs = useStockRefs();
  const locs = useQuery({ queryKey: ['stock-locations', false], queryFn: () => api<StockLocation[]>('/stock/locations') });
  const [f, setF] = useState({ from: firstOfMonth(), to: todayISO(), location_id: '', category_id: '' });
  const [mode, setMode] = useState<'qty' | 'value'>('value');
  const q = useQuery({ queryKey: ['stock-rep-turn', f], queryFn: () => api<{ costing_method: 'fifo' | 'average'; rows: Turn[]; totals: Record<string, number> }>('/stock/reports/turnover', { query: f }) });
  const d = q.data;
  return (
    <section className="card">
      <div className="card-head row" style={{ flexWrap: 'wrap' }}>
        <input className="input mono" type="date" style={{ maxWidth: 160, height: 36 }} aria-label="დან" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        <input className="input mono" type="date" style={{ maxWidth: 160, height: 36 }} aria-label="მდე" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
        <select className="select" style={{ maxWidth: 220, height: 36 }} aria-label="ლოკაცია" value={f.location_id} onChange={(e) => setF({ ...f, location_id: e.target.value })}>
          <option value="">ყველა ლოკაცია</option>{locs.data?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
        <select className="select" style={{ maxWidth: 200, height: 36 }} aria-label="კატეგორია" value={f.category_id} onChange={(e) => setF({ ...f, category_id: e.target.value })}>
          <option value="">ყველა კატეგორია</option>{refs.data?.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <div className="seg" role="group" aria-label="ერთეული"><button type="button" aria-pressed={mode === 'value'} onClick={() => setMode('value')}>₾</button><button type="button" aria-pressed={mode === 'qty'} onClick={() => setMode('qty')}>რაოდენობა</button></div>
        <span className="grow" />
        {d && <button className="btn sm" type="button" onClick={() => downloadCsv(`მოძრაობის-უწყისი-${f.from}-${f.to}.csv`, ['საქონელი', 'კოდი', 'ერთეული', ...COLS.flatMap(([, l]) => [`${l} (რაოდ.)`, `${l} (₾)`])],
          d.rows.map((r) => [r.item_name, r.item_code, r.unit, ...COLS.flatMap(([k]) => [r[`${k}_qty`], r[`${k}_value`]])]))}>CSV</button>}
      </div>
      {q.isLoading ? <Loading /> : (
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead><tr><th>საქონელი</th>{COLS.map(([k, l]) => <th key={k} className="num">{l}</th>)}</tr></thead>
            <tbody>{d?.rows.map((r) => <tr key={r.item_id}><td><strong>{r.item_name}</strong> <span className="small muted">{r.unit}</span></td>
              {COLS.map(([k]) => { const v = r[`${k}_${mode}`]; return <td key={k} className="num mono" style={{ color: v < 0 ? 'var(--danger-ink)' : undefined, fontWeight: k === 'close' ? 600 : undefined }}>{v ? (mode === 'qty' ? qtyFmt(v) : v.toFixed(2)) : '—'}</td>; })}</tr>)}
              {d && mode === 'value' && <tr><td><strong>სულ ({COSTING_KA[d.costing_method]})</strong></td>{COLS.map(([k]) => <td key={k} className="num mono"><strong>{d.totals[`${k}_value`].toFixed(2)}</strong></td>)}</tr>}
              {d && !d.rows.length && <tr><td colSpan={8} className="muted">მოძრაობა არ არის</td></tr>}
            </tbody>
          </table>
        </div>)}
      <ErrorBox error={q.error} />
    </section>
  );
}

function Consumption() {
  const [f, setF] = useState({ from: firstOfMonth(), to: todayISO(), group: 'location' });
  const q = useQuery({ queryKey: ['stock-rep-cons', f], queryFn: () => api<{ costing_method: 'fifo' | 'average'; consumption: { name: string; patients: number; cost: string; billed: string }[]; writeoffs: { location_name: string; reason: string; value: string }[] }>('/stock/reports/consumption', { query: f }) });
  const d = q.data;
  return (
    <>
      <section className="card">
        <div className="card-head row" style={{ flexWrap: 'wrap' }}>
          <input className="input mono" type="date" style={{ maxWidth: 160, height: 36 }} aria-label="დან" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
          <input className="input mono" type="date" style={{ maxWidth: 160, height: 36 }} aria-label="მდე" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
          <div className="seg" role="group" aria-label="დაჯგუფება"><button type="button" aria-pressed={f.group === 'location'} onClick={() => setF({ ...f, group: 'location' })}>ლოკაციით</button>
            <button type="button" aria-pressed={f.group === 'item'} onClick={() => setF({ ...f, group: 'item' })}>საქონლით</button></div>
          <h2 className="grow" style={{ margin: 0, fontSize: 15 }}>ხარჯი პაციენტებზე</h2>
          {d && <button className="btn sm" type="button" onClick={() => downloadCsv(`ხარჯი-${f.from}-${f.to}.csv`, [f.group === 'item' ? 'საქონელი' : 'ლოკაცია', 'პაციენტი', 'თვითღირებულება', 'ინვოისში'], d.consumption.map((r) => [r.name, r.patients, r.cost, r.billed]))}>CSV</button>}
        </div>
        {q.isLoading ? <Loading /> : (
          <table className="table">
            <thead><tr><th>{f.group === 'item' ? 'საქონელი' : 'ლოკაცია'}</th><th className="num">პაციენტი</th><th className="num">თვითღირებულება</th><th className="num">ინვოისში</th></tr></thead>
            <tbody>{d?.consumption.map((r) => <tr key={r.name}><td>{r.name}</td><td className="num">{r.patients}</td><td className="num mono">{Number(r.cost).toFixed(2)}</td><td className="num mono">{Number(r.billed).toFixed(2)}</td></tr>)}
              {d && !d.consumption.length && <tr><td colSpan={4} className="muted">ხარჯი არ არის</td></tr>}</tbody>
          </table>)}
      </section>
      <section className="card">
        <div className="card-head"><h2>ჩამოწერა მიზეზებით</h2></div>
        <table className="table">
          <thead><tr><th>ლოკაცია</th><th>მიზეზი</th><th className="num">ღირებულება</th></tr></thead>
          <tbody>{d?.writeoffs.map((r, i) => <tr key={i}><td>{r.location_name}</td><td>{WO_REASON_KA[r.reason] ?? r.reason}</td><td className="num mono">{Number(r.value).toFixed(2)}</td></tr>)}
            {d && !d.writeoffs.length && <tr><td colSpan={3} className="muted">ჩამოწერა არ არის</td></tr>}</tbody>
        </table>
      </section>
      <ErrorBox error={q.error} />
    </>
  );
}
