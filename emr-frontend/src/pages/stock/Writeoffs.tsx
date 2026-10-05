import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, can } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Loading, Modal, useToast } from '../../components/ui';
import { dateGe, tsDate } from '../../lib/format';
import ItemSearch from './ItemSearch';
import WitnessFields from './Witness';
import { useStockRules } from '../../lib/modules';
import { money2, qtyFmt, REVERSE_ROLES, useStockRefs, WO_REASON_KA, type Witness, type LotAvail, type OpsDoc, type OpsRow, type StockItem, type StockLocation } from './types';

interface Line { key: string; item: Pick<StockItem, 'id' | 'name' | 'code' | 'base_unit_name' | 'controlled_class'>; lots: (LotAvail & { qty?: string })[]; lot_id: string; qty: string }
let seq = 0;

/** ჩამოწერა: მიზეზით; ზღვარზე მეტი / დაკარგული / კონტროლირებადი — საწყობის მენეჯერის დამტკიცებით */
export default function Writeoffs() {
  const { user } = useAuth(); const refs = useStockRefs();
  const isMgr = can(user, 'admin', 'stock_manager');
  const [pending, setPending] = useState(isMgr);
  const [form, setForm] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['stock-writeoffs', pending], queryFn: () => api<OpsRow[]>('/stock/writeoffs', { query: { pending: pending ? 'true' : undefined } }) });
  return (
    <div className="content">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <div className="seg" role="group" aria-label="ფილტრი">
          <button type="button" aria-pressed={pending} onClick={() => setPending(true)}>დასამტკიცებელი</button>
          <button type="button" aria-pressed={!pending} onClick={() => setPending(false)}>ყველა</button>
        </div>
        <span className="hint grow">დამტკიცება საჭიროა: ღირებულება &gt; {money2(refs.data?.settings.writeoff_approval_threshold)}, „დაკარგული“ ან კონტროლირებადი საქონელი.</span>
        <button className="btn primary" type="button" onClick={() => setForm(true)}>+ ჩამოწერა</button>
      </div>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : (
        <div className="card">
          <table className="table">
            <thead><tr><th>№</th><th>დრო</th><th>ლოკაცია</th><th>მიზეზი</th><th className="num">ღირებულება</th><th>ავტორი</th><th>სტატუსი</th></tr></thead>
            <tbody>{q.data?.map((d) => (
              <tr key={d.id} className="clickable" onClick={() => setOpen(d.id)}>
                <td className="mono">{d.doc_no ?? '—'}</td><td className="small">{tsDate(d.created_at)}</td><td>{d.location_name}</td>
                <td>{WO_REASON_KA[d.writeoff_reason ?? ''] ?? '—'}{d.notes && <div className="small muted">{d.notes}</div>}</td>
                <td className="num mono">{Number(d.total_net).toFixed(2)}</td><td className="small">{d.created_by_name}</td>
                <td>{d.status === 'draft' ? <span className="chip warn">დასამტკიცებელი</span> : d.reversed_by ? <span className="chip">შემობრუნდა {d.reversed_by_no}</span> : <span className="chip ok">ჩამოწერილი</span>}</td>
              </tr>))}
              {!q.data?.length && <tr><td colSpan={7} className="muted">{pending ? 'დასამტკიცებელი არ არის' : 'ჩანაწერი არ არის'}</td></tr>}
            </tbody>
          </table>
        </div>)}
      {form && <WriteoffForm onClose={() => setForm(false)} />}
      {open && <WriteoffView id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function WriteoffForm({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient(); const toast = useToast();
  const mine = useQuery({ queryKey: ['stock-my-locations'], queryFn: () => api<StockLocation[]>('/stock/my-locations') });
  const [h, setH] = useState({ loc: '', reason: 'damaged', notes: '' });
  const [lines, setLines] = useState<Line[]>([]);
  const [wit, setWit] = useState<Witness>({ username: '', password: '' });
  const rules = useStockRules();
  const controlled = lines.some((l) => !!l.item.controlled_class && rules.witness_classes.includes(l.item.controlled_class));
  const add = async (i: StockItem, lotNo?: string | null, serial?: string | null) => {
    const lots = await api<(LotAvail & { qty: string })[]>(`/stock/locations/${h.loc}/lots`, { query: { item_id: i.id } });
    // ვადაგასულიც ჩანს: ვადაგასული ლოტები ცალკე — ნაშთებიდან
    const exp = (await api<{ rows: { lot_id: string; lot_no: string | null; serial_no: string | null; expires_on: string | null; qty: string }[] }>('/stock/balances', { query: { location_id: h.loc, item_id: i.id } })).rows;
    const all = [...lots, ...exp.filter((x) => !lots.some((l) => l.lot_id === x.lot_id))];
    const pick = all.find((l) => (lotNo || serial) && (l.lot_no ?? '') === (lotNo ?? '') && (l.serial_no ?? '') === (serial ?? '')) ?? all[0];
    setLines((ls) => [...ls, { key: `w${++seq}`, item: i, lots: all, lot_id: pick?.lot_id ?? '', qty: '1' }]);
  };
  const save = useMutation({
    mutationFn: () => api<OpsDoc>('/stock/writeoffs', { body: { location_id: h.loc, writeoff_reason: h.reason, notes: h.notes || null, witness: controlled ? wit : undefined, lines: lines.map((l) => ({ lot_id: l.lot_id, qty_base: Number(l.qty.replace(',', '.')) })) } }),
    onSuccess: (r) => { toast.show(r.status === 'posted' ? `ჩამოიწერა: ${r.doc_no}` : 'გაიგზავნა დასამტკიცებლად'); for (const k of ['stock-writeoffs', 'stock-balances']) void qc.invalidateQueries({ queryKey: [k] }); onClose(); },
  });
  const valid = h.loc && lines.length && lines.every((l) => l.lot_id && Number(l.qty.replace(',', '.')) > 0) && (h.reason === 'expired' || h.notes.trim().length >= 3) && (!controlled || (wit.username.trim() && wit.password));
  return (
    <Modal title="ჩამოწერა" onClose={onClose} width={900}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={!valid || save.isPending} onClick={() => save.mutate()}>ჩამოწერა</button></>}>
      {toast.node}
      <div className="stack">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
          <div className="field"><label htmlFor="wl">ლოკაცია <span className="req">*</span></label>
            <select id="wl" className="select" value={h.loc} onChange={(e) => { setH({ ...h, loc: e.target.value }); setLines([]); }}>
              <option value="">— აირჩიეთ —</option>{mine.data?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>
          <div className="field"><label htmlFor="wr">მიზეზი <span className="req">*</span></label>
            <select id="wr" className="select" value={h.reason} onChange={(e) => setH({ ...h, reason: e.target.value })}>
              {Object.entries(WO_REASON_KA).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
          <div className="field"><label htmlFor="wn">აღწერა {h.reason !== 'expired' && <span className="req">*</span>}</label>
            <input id="wn" className="input" value={h.notes} onChange={(e) => setH({ ...h, notes: e.target.value })} placeholder="რა მოხდა" /></div>
        </div>
        <ItemSearch disabled={!h.loc} onPick={(i) => void add(i)} onScan={(s) => void add(s.item, s.lot, s.serial)} />
        <table className="table">
          <thead><tr><th>საქონელი</th><th>ლოტი</th><th className="num">რაოდენობა</th><th /></tr></thead>
          <tbody>{lines.map((l) => (
            <tr key={l.key}>
              <td><strong>{l.item.name}</strong> <span className="mono small muted">{l.item.code}</span></td>
              <td>{l.lots.length ? <select className="select" style={{ height: 34, maxWidth: 340 }} aria-label="ლოტი" value={l.lot_id} onChange={(e) => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, lot_id: e.target.value } : x)))}>
                {l.lots.map((y) => <option key={y.lot_id} value={y.lot_id}>{y.lot_no ?? 'ლოტის გარეშე'}{y.serial_no ? ` · SN ${y.serial_no}` : ''} — {y.expires_on ? dateGe(y.expires_on) : '—'} (ნაშთი {qtyFmt(y.qty ?? y.available ?? 0)})</option>)}
              </select> : <span className="small" style={{ color: 'var(--danger-ink)' }}>ნაშთი არ არის</span>}</td>
              <td><input className="input mono num" style={{ height: 34, width: 90 }} aria-label="რაოდენობა" inputMode="decimal" value={l.qty} onChange={(e) => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, qty: e.target.value } : x)))} /> <span className="small muted">{l.item.base_unit_name}</span></td>
              <td><button className="icon-btn" type="button" aria-label="წაშლა" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>×</button></td>
            </tr>))}</tbody>
        </table>
        {controlled && <WitnessFields value={wit} onChange={setWit} note="ჩამოწერა / განადგურება" />}
        <ErrorBox error={save.error} />
      </div>
    </Modal>
  );
}

function WriteoffView({ id, onClose }: { id: string; onClose: () => void }) {
  const { user } = useAuth(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['stock-ops', id], queryFn: () => api<OpsDoc>(`/stock/ops/${id}`) });
  const done = () => { for (const k of ['stock-writeoffs', 'stock-balances', 'stock-ops']) void qc.invalidateQueries({ queryKey: [k] }); onClose(); };
  const decide = useMutation({ mutationFn: (b: { approve: boolean; reason?: string }) => api(`/stock/writeoffs/${id}/decide`, { body: b }), onSuccess: done });
  const rev = useMutation({ mutationFn: (reason: string) => api(`/stock/docs/${id}/reverse`, { body: { reason } }), onSuccess: done });
  const d = q.data;
  const isMgr = can(user, 'admin', 'stock_manager');
  return (
    <Modal title={d ? `ჩამოწერა ${d.doc_no ?? ''} — ${d.location_name}` : 'ჩამოწერა'} onClose={onClose} width={860}
      footer={<>{d?.status === 'draft' && d.approval_status === 'pending' && isMgr && <>
        <button className="btn" type="button" disabled={decide.isPending} onClick={() => { const r = prompt('უარის მიზეზი'); if (r && r.trim().length >= 3) decide.mutate({ approve: false, reason: r.trim() }); }}>უარი</button>
        <button className="btn primary" type="button" disabled={decide.isPending} onClick={() => decide.mutate({ approve: true })}>დამტკიცება და ჩამოწერა</button></>}
        {d?.status === 'posted' && !d.reversed_by && can(user, ...(REVERSE_ROLES as unknown as Parameters<typeof can>[1][])) &&
          <button className="btn" type="button" disabled={rev.isPending} onClick={() => { const r = prompt('შემობრუნების მიზეზი'); if (r && r.trim().length >= 3) rev.mutate(r.trim()); }}>შემობრუნება</button>}
        <button className="btn" type="button" onClick={onClose}>დახურვა</button></>}>
      {!d ? <Loading /> : (
        <div className="stack">
          <div className="row small" style={{ flexWrap: 'wrap', gap: 16 }}>
            <span>მიზეზი: <strong>{WO_REASON_KA[d.writeoff_reason ?? '']}</strong></span><span>ავტორი: {d.created_by_name} · {tsDate(d.created_at)}</span>
            {d.approved_by_name && <span>{d.approval_status === 'rejected' ? 'უარყო' : 'დაამტკიცა'}: {d.approved_by_name}</span>}
          </div>
          {d.notes && <div className="small">{d.notes}</div>}{d.reason && <div className="alert warn">{d.reason}</div>}
          <table className="table">
            <thead><tr><th>საქონელი</th><th>ლოტი</th><th>ვადა</th><th className="num">რაოდენობა</th><th className="num">ღირებულება</th></tr></thead>
            <tbody>{d.lines.map((l) => (
              <tr key={l.id}><td><strong>{l.item_name}</strong></td><td className="mono small">{l.lot_no ?? '—'}{l.serial_no && ` · SN ${l.serial_no}`}</td><td className="mono small">{l.expires_on ? dateGe(l.expires_on) : '—'}</td>
                <td className="num">{qtyFmt(l.qty_base)} {l.base_unit_name}</td><td className="num mono">{money2(l.line_net)}</td></tr>))}</tbody>
          </table>
          <div className="row" style={{ justifyContent: 'flex-end' }}>სულ: <strong className="mono">{money2(d.total_net)}</strong></div>
          <ErrorBox error={q.error ?? decide.error ?? rev.error} />
        </div>)}
    </Modal>
  );
}
