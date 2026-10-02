import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import { ErrorBox, Loading, Modal, useToast } from '../../components/ui';
import { dateGe, tsDate } from '../../lib/format';
import ItemSearch, { type ScanHit } from './ItemSearch';
import { COUNT_STATUS, money2, qtyFmt, useStockRefs, type CountRow, type StockCount, type StockItem, type StockLocation } from './types';

/** ინვენტარიზაცია (4A): ბრმა დათვლა, ლოკაციის ბლოკი, დამტკიცება → კორექტირება */
export default function Counts() {
  const [sp, setSp] = useSearchParams();
  const id = sp.get('count');
  if (id) return <CountPage id={id} onClose={() => setSp({})} />;
  return <CountList onOpen={(x) => setSp({ count: x })} />;
}

function CountList({ onOpen }: { onOpen: (id: string) => void }) {
  const q = useQuery({ queryKey: ['stock-counts'], queryFn: () => api<CountRow[]>('/stock/counts') });
  const [start, setStart] = useState(false);
  return (
    <div className="content">
      <div className="row"><span className="hint grow">დაწყებისას ლოკაცია იბლოკება — მიღება, გაცემა, ხარჯი და ჩამოწერა შეჩერდება დამტკიცებამდე / გაუქმებამდე. სხვაობა აისახება ცალკე კორექტირების დოკუმენტით.</span>
        <button className="btn primary" type="button" onClick={() => setStart(true)}>+ ინვენტარიზაცია</button></div>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : (
        <div className="card">
          <table className="table">
            <thead><tr><th>№</th><th>დაწყება</th><th>ლოკაცია</th><th>არეალი</th><th className="num">დათვლილი</th><th>დაიწყო</th><th>კორექტირება</th><th>სტატუსი</th></tr></thead>
            <tbody>{q.data?.map((c) => (
              <tr key={c.id} className="clickable" onClick={() => onOpen(c.id)}>
                <td className="mono">{c.count_no}</td><td className="small">{tsDate(c.started_at)}</td><td><strong>{c.location_name}</strong></td>
                <td className="small">{c.category_name ?? 'მთელი ლოკაცია'}{c.blind ? ' · ბრმა' : ''}</td><td className="num">{c.counted} / {c.lines}</td>
                <td className="small">{c.started_by_name}</td><td className="mono small">{c.adjustment_no ?? '—'}</td>
                <td><span className={`chip ${COUNT_STATUS[c.status][0]}`}>{COUNT_STATUS[c.status][1]}</span></td>
              </tr>))}
              {!q.data?.length && <tr><td colSpan={8} className="muted">ინვენტარიზაცია არ ჩატარებულა</td></tr>}
            </tbody>
          </table>
        </div>)}
      {start && <StartDialog onClose={() => setStart(false)} onStarted={onOpen} />}
    </div>
  );
}

function StartDialog({ onClose, onStarted }: { onClose: () => void; onStarted: (id: string) => void }) {
  const refs = useStockRefs();
  const mine = useQuery({ queryKey: ['stock-my-locations'], queryFn: () => api<StockLocation[]>('/stock/my-locations') });
  const [f, setF] = useState({ location_id: '', category_id: '', blind: true, notes: '' });
  const m = useMutation({ mutationFn: () => api<StockCount>('/stock/counts', { body: { ...f, category_id: f.category_id || null, notes: f.notes || null } }), onSuccess: (r) => onStarted(r.id) });
  return (
    <Modal title="ინვენტარიზაციის დაწყება" onClose={onClose} width={620}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button>
        <button className="btn primary" type="button" disabled={!f.location_id || m.isPending} onClick={() => { if (confirm('ლოკაცია დაიბლოკება დამტკიცებამდე. დავიწყოთ?')) m.mutate(); }}>დაწყება</button></>}>
      <div className="stack">
        <div className="field"><label htmlFor="sl">ლოკაცია</label>
          <select id="sl" className="select" value={f.location_id} onChange={(e) => setF({ ...f, location_id: e.target.value })}>
            <option value="">— აირჩიეთ —</option>{mine.data?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>
        <div className="field"><label htmlFor="sc">არეალი</label>
          <select id="sc" className="select" value={f.category_id} onChange={(e) => setF({ ...f, category_id: e.target.value })}>
            <option value="">მთელი ლოკაცია</option>{refs.data?.categories.filter((c) => c.is_active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
        <label className="row"><input type="checkbox" checked={f.blind} onChange={(e) => setF({ ...f, blind: e.target.checked })} /> ბრმა დათვლა (მთვლელი სისტემურ რაოდენობას ვერ ხედავს — რეკომენდებულია)</label>
        <div className="field"><label htmlFor="sn">შენიშვნა</label><input id="sn" className="input" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></div>
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}

function CountPage({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['stock-count', id], queryFn: () => api<StockCount>(`/stock/counts/${id}`) });
  const [vals, setVals] = useState<Record<string, string>>({});
  const [extra, setExtra] = useState<ScanHit | StockItem | null>(null);
  const set = (r: StockCount) => { qc.setQueryData(['stock-count', id], r); void qc.invalidateQueries({ queryKey: ['stock-counts'] }); void qc.invalidateQueries({ queryKey: ['stock-balances'] }); };
  const save = useMutation({
    mutationFn: () => api<StockCount>(`/stock/counts/${id}/lines`, { method: 'PUT', body: { lines: Object.entries(vals).map(([lid, v]) => ({ id: lid, counted_qty: v.trim() === '' ? null : Number(v.replace(',', '.')) })) } }),
    onSuccess: (r) => { setVals({}); set(r); toast.show('შენახულია'); },
  });
  const act = useMutation({
    mutationFn: async (a: { path: string; body?: unknown }) => {
      if (Object.keys(vals).length) { await api(`/stock/counts/${id}/lines`, { method: 'PUT', body: { lines: Object.entries(vals).map(([lid, v]) => ({ id: lid, counted_qty: v.trim() === '' ? null : Number(v.replace(',', '.')) })) } }); setVals({}); }
      return api<StockCount>(`/stock/counts/${id}/${a.path}`, { body: a.body ?? {} });
    },
    onSuccess: set,
  });
  const delExtra = useMutation({ mutationFn: (lid: string) => api<StockCount>(`/stock/counts/${id}/lines/${lid}`, { method: 'DELETE' }), onSuccess: set });
  if (q.isLoading) return <div className="content"><Loading /></div>;
  const c = q.data;
  if (!c) return <div className="content"><ErrorBox error={q.error} /><button className="btn" type="button" onClick={onClose}>← სია</button></div>;
  const open = c.status === 'open';
  const val = (l: StockCount['lines'][number]) => vals[l.id] ?? (l.counted_qty === null ? '' : qtyFmt(l.counted_qty));
  const left = c.lines.filter((l) => val(l) === '').length;
  const ask = (m: string) => { const v = prompt(m); return v && v.trim().length >= 3 ? v.trim() : null; };
  /** სკანირება: არსებულ ხაზს +1; ახალი ლოტი — „ნაპოვნი“ */
  const onScan = (h: ScanHit) => {
    const l = c.lines.find((x) => x.item_id === h.item.id && (x.lot_no ?? '') === (h.lot ?? '') && (x.serial_no ?? '') === (h.serial ?? ''))
      ?? (!h.lot && !h.serial ? c.lines.find((x) => x.item_id === h.item.id) : undefined);
    if (l) { setVals((v) => ({ ...v, [l.id]: String((Number(val(l)) || 0) + 1) })); toast.show(`${l.item_name}: +1`); }
    else setExtra(h);
  };
  return (
    <div className="content">
      {toast.node}
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button className="btn" type="button" onClick={onClose}>← სია</button>
        <h2 className="grow" style={{ margin: 0 }}>ინვენტარიზაცია <span className="mono">{c.count_no}</span> — {c.location_name} <span className={`chip ${COUNT_STATUS[c.status][0]}`}>{COUNT_STATUS[c.status][1]}</span></h2>
        {open && <>
          <button className="btn" type="button" disabled={!Object.keys(vals).length || save.isPending} onClick={() => save.mutate()}>შენახვა</button>
          <button className="btn primary" type="button" disabled={act.isPending || left > 0} title={left ? `დასათვლელია ${left}` : ''} onClick={() => { if (confirm('დავასრულოთ დათვლა? შემდეგ რაოდენობა აღარ შეიცვლება (მხოლოდ ხელახალი დათვლით).')) act.mutate({ path: 'submit' }); }}>დასრულება{left ? ` (დარჩა ${left})` : ''}</button></>}
        {c.can_approve && c.status === 'counted' && <>
          <button className="btn" type="button" disabled={act.isPending} onClick={() => { const r = ask('ხელახალი დათვლის მიზეზი'); if (r) act.mutate({ path: 'recount', body: { reason: r } }); }}>ხელახალი დათვლა</button>
          <button className="btn primary" type="button" disabled={act.isPending} onClick={() => { if (confirm('დავამტკიცოთ? სხვაობა აისახება ნაშთებში (კორექტირების დოკუმენტი), ლოკაცია განიბლოკება.')) act.mutate({ path: 'approve' }); }}>დამტკიცება</button></>}
        {c.can_approve && ['open', 'counted'].includes(c.status) && <button className="btn" type="button" disabled={act.isPending} onClick={() => { const r = ask('გაუქმების მიზეზი (ნაშთი არ შეიცვლება)'); if (r) act.mutate({ path: 'cancel', body: { reason: r } }); }}>გაუქმება</button>}
      </div>
      <section className="card card-pad row small" style={{ flexWrap: 'wrap', gap: 18 }}>
        <span>არეალი: <strong>{c.category_name ?? 'მთელი ლოკაცია'}</strong>{c.blind ? ' · ბრმა' : ''}</span><span>დაიწყო: {c.started_by_name} · {tsDate(c.started_at)}</span>
        {c.approved_by_name && <span>დაამტკიცა: {c.approved_by_name}</span>}{c.adjustment_no && <span>კორექტირება: <strong className="mono">{c.adjustment_no}</strong></span>}
        {c.totals && <span>დანაკლისი: <strong style={{ color: 'var(--danger-ink)' }}>{money2(c.totals.shortage)}</strong> · ზედმეტობა: <strong>{money2(c.totals.surplus)}</strong> · სხვაობით: {c.totals.lines_diff} ხაზი</span>}
        {c.reason && <span className="chip warn">{c.reason}</span>}
      </section>
      {open && <section className="card card-pad"><ItemSearch onPick={(i) => setExtra(i)} onScan={onScan} placeholder="სკანირება: არსებულ ხაზს +1; ახალი ლოტი → „ნაპოვნი“. ან ძებნა — ნაპოვნის დასამატებლად" /></section>}
      <section className="card" style={{ overflowX: 'auto' }}>
        <table className="table">
          <thead><tr><th>საქონელი</th><th>ლოტი / სერიული</th><th>ვადა</th>{!c.blind || !open ? <th className="num">სისტემაში</th> : null}<th className="num">დათვლილი</th>{c.totals && <><th className="num">სხვაობა</th><th className="num">ღირებულება</th></>}<th /></tr></thead>
          <tbody>{c.lines.map((l) => (
            <tr key={l.id} style={l.diff ? { background: l.diff < 0 ? 'var(--danger-weak)' : 'var(--warn-weak)' } : undefined}>
              <td><strong>{l.item_name}</strong> <span className="mono small muted">{l.item_code}</span>{l.is_extra && <span className="chip info" style={{ marginLeft: 6, height: 20, fontSize: 11 }}>ნაპოვნი</span>}{l.note && <div className="small muted">{l.note}</div>}</td>
              <td className="mono small">{l.lot_no ?? '—'}{l.serial_no && ` · SN ${l.serial_no}`}</td><td className="mono small">{l.expires_on ? dateGe(l.expires_on) : '—'}</td>
              {!c.blind || !open ? <td className="num">{l.expected_qty !== null ? qtyFmt(l.expected_qty) : '—'}</td> : null}
              <td className="num">{open ? <input className="input mono num" style={{ height: 32, width: 90 }} aria-label={`დათვლილი: ${l.item_name}`} inputMode="decimal" value={val(l)} onChange={(e) => setVals((v) => ({ ...v, [l.id]: e.target.value }))} />
                : <strong>{l.counted_qty !== null ? qtyFmt(l.counted_qty) : '—'}</strong>} <span className="small muted">{l.base_unit_name}</span></td>
              {c.totals && <><td className="num mono">{l.diff ? `${l.diff > 0 ? '+' : ''}${qtyFmt(l.diff)}` : '0'}</td><td className="num mono">{l.diff_value ? l.diff_value.toFixed(2) : ''}</td></>}
              <td>{open && l.is_extra && <button className="icon-btn" type="button" aria-label="წაშლა" onClick={() => delExtra.mutate(l.id)}>×</button>}</td>
            </tr>))}
            {!c.lines.length && <tr><td colSpan={8} className="muted">ლოკაციაზე ნაშთი არ იყო — დაამატეთ ნაპოვნი</td></tr>}
          </tbody>
        </table>
      </section>
      <ErrorBox error={save.error ?? act.error ?? delExtra.error} />
      {extra && <ExtraDialog countId={id} hit={extra} onClose={() => setExtra(null)} onSaved={(r) => { set(r); setExtra(null); }} />}
    </div>
  );
}

function ExtraDialog({ countId, hit, onClose, onSaved }: { countId: string; hit: ScanHit | StockItem; onClose: () => void; onSaved: (r: StockCount) => void }) {
  const item = 'item' in hit ? hit.item : hit;
  const scan = 'item' in hit ? hit : null;
  const [f, setF] = useState({ lot_no: scan?.lot ?? '', serial_no: scan?.serial ?? '', expires_on: scan?.expiry ?? '', qty: '1', note: '' });
  const m = useMutation({ mutationFn: () => api<StockCount>(`/stock/counts/${countId}/extra`, { body: { item_id: item.id, lot_no: f.lot_no || null, serial_no: f.serial_no || null, expires_on: f.expires_on || null, counted_qty: Number(f.qty.replace(',', '.')), note: f.note || null } }), onSuccess: onSaved });
  return (
    <Modal title={`ნაპოვნი: ${item.name}`} onClose={onClose} width={620}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={m.isPending || !(Number(f.qty) >= 0)} onClick={() => m.mutate()}>დამატება</button></>}>
      <div className="stack">
        <span className="hint">ლოტი, რომელიც ამ ლოკაციის სიაში არ იყო. თუ სისტემაში უკვე არსებობს — მიებმება; თუ არა — დამტკიცებისას შეიქმნება (საშუალო ფასით).</span>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
          {item.requires_lot && <div className="field"><label htmlFor="xl">ლოტი</label><input id="xl" className="input mono" value={f.lot_no} onChange={(e) => setF({ ...f, lot_no: e.target.value.toUpperCase() })} /></div>}
          {item.requires_expiry && <div className="field"><label htmlFor="xe">ვადა</label><input id="xe" className="input mono" type="date" value={f.expires_on} onChange={(e) => setF({ ...f, expires_on: e.target.value })} /></div>}
          {item.serial_tracked && <div className="field"><label htmlFor="xs">სერიული</label><input id="xs" className="input mono" value={f.serial_no} onChange={(e) => setF({ ...f, serial_no: e.target.value.toUpperCase() })} /></div>}
          <div className="field"><label htmlFor="xq">დათვლილი ({item.base_unit_name})</label><input id="xq" className="input mono" inputMode="decimal" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} /></div>
          <div className="field" style={{ gridColumn: '1 / -1' }}><label htmlFor="xn">შენიშვნა</label><input id="xn" className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="სად იპოვეთ" /></div>
        </div>
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}
