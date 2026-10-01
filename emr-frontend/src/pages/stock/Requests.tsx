import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, can, type Role } from '../../api/client';
import type { PatientListItem } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import PatientSearch from '../../components/PatientSearch';
import { ErrorBox, Loading, Modal, useDebounced, useToast } from '../../components/ui';
import { dateGe, tsDate } from '../../lib/format';
import {
  CONTROLLED_KA, ISSUER_ROLES, qtyFmt, REQ_STATUS,
  type PickLine, type ReqRow, type ReqStatus, type StockItem, type StockLocation, type StockRequest,
} from './types';

const OPEN: ReqStatus[] = ['approved', 'partial'];
const isIssuer = (u: Parameters<typeof can>[0]) => can(u, ...(ISSUER_ROLES as unknown as Role[]));

/** მოთხოვნები: სია ↔ მოთხოვნა (?req=new | ?req=<id>) */
export default function Requests() {
  const [sp, setSp] = useSearchParams();
  const req = sp.get('req');
  if (req) return <RequestPage id={req === 'new' ? null : req} onClose={() => setSp({})} onOpen={(id) => setSp({ req: id })} />;
  return <RequestList onOpen={(id) => setSp({ req: id })} />;
}

const FILTERS: [string, string][] = [['active', 'მიმდინარე'], ['submitted', 'დასამტკიცებელი'], ['approved,partial', 'გასაცემი'], ['', 'ყველა']];

function RequestList({ onOpen }: { onOpen: (id: string) => void }) {
  const [st, setSt] = useState('active'); const [mine, setMine] = useState(false);
  const status = st === 'active' ? 'draft,submitted,approved,partial' : st;
  const q = useQuery({ queryKey: ['stock-requests', status, mine], queryFn: () => api<ReqRow[]>('/stock/requests', { query: { status, scope: mine ? 'mine' : undefined } }) });
  return (
    <div className="content">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <div className="seg" role="group" aria-label="ფილტრი">{FILTERS.map(([k, l]) => <button key={k} type="button" aria-pressed={st === k} onClick={() => setSt(k)}>{l}</button>)}</div>
        <label className="row small"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> მხოლოდ ჩემი</label>
        <span className="grow" />
        <button className="btn primary" type="button" onClick={() => onOpen('new')}>+ მოთხოვნა</button>
      </div>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : (
        <div className="card">
          <table className="table">
            <thead><tr><th>№</th><th>შექმნა</th><th>ვისთვის</th><th>ვისგან</th><th className="num">ხაზი</th><th>ავტორი</th><th>სტატუსი</th></tr></thead>
            <tbody>{q.data?.map((r) => (
              <tr key={r.id} className="clickable" onClick={() => onOpen(r.id)}>
                <td className="mono">{r.req_no ?? '—'}{r.urgent && <span className="chip danger" style={{ marginLeft: 6, height: 20, fontSize: 11 }}>სასწრაფო</span>}</td>
                <td className="small">{tsDate(r.created_at)}</td><td><strong>{r.to_name}</strong></td><td>{r.from_name}</td><td className="num">{r.lines}</td><td className="small">{r.created_by_name}</td>
                <td><span className={`chip ${REQ_STATUS[r.status][0]}`}>{REQ_STATUS[r.status][1]}</span>{r.in_transit > 0 && <span className="chip warn" style={{ marginLeft: 4 }}>გზაში: {r.in_transit}</span>}</td>
              </tr>))}
              {!q.data?.length && <tr><td colSpan={7} className="muted">მოთხოვნა არ არის</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function RequestPage({ id, onClose, onOpen }: { id: string | null; onClose: () => void; onOpen: (id: string) => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['stock-request', id], queryFn: () => api<StockRequest>(`/stock/requests/${id}`), enabled: !!id });
  const done = (r: StockRequest) => { qc.setQueryData(['stock-request', r.id], r); void qc.invalidateQueries({ queryKey: ['stock-requests'] }); void qc.invalidateQueries({ queryKey: ['stock-balances'] }); if (!id) onOpen(r.id); };
  if (id && q.isLoading) return <div className="content"><Loading /></div>;
  if (id && q.error) return <div className="content"><ErrorBox error={q.error} /><button className="btn" type="button" onClick={onClose}>← სია</button></div>;
  const r = q.data;
  return (
    <div className="content">
      {!r || r.status === 'draft' ? <RequestForm key={r?.id ?? 'new'} r={r ?? null} onClose={onClose} onDone={done} /> : <RequestView r={r} onClose={onClose} onDone={done} />}
    </div>
  );
}

// ---------------------------------------------------------------- მონახაზი
interface FLine { key: string; item: Pick<StockItem, 'id' | 'name' | 'code' | 'base_unit_name' | 'packs' | 'patient_only' | 'controlled_class'>; pack_id: string; qty: string; patient: { id: string; name: string } | null }
let seq = 0;

function RequestForm({ r, onClose, onDone }: { r: StockRequest | null; onClose: () => void; onDone: (r: StockRequest) => void }) {
  const mine = useQuery({ queryKey: ['stock-my-locations'], queryFn: () => api<StockLocation[]>('/stock/my-locations') });
  const locs = useQuery({ queryKey: ['stock-locations', false], queryFn: () => api<StockLocation[]>('/stock/locations') });
  const sources = (locs.data ?? []).filter((l) => ['pharmacy', 'central', 'household'].includes(l.kind));
  const [h, setH] = useState({ from: r?.from_location_id ?? '', to: r?.to_location_id ?? '', urgent: r?.urgent ?? false, notes: r?.notes ?? '' });
  const [lines, setLines] = useState<FLine[]>(() => (r?.lines ?? []).map((l) => ({ key: `r${++seq}`, item: { id: l.item_id, name: l.item_name, code: l.item_code, base_unit_name: l.base_unit_name, packs: l.pack_id ? [{ id: l.pack_id, name: l.pack_name ?? '', qty_base: l.pack_qty_base ?? '1', is_receipt_default: false }] : [], patient_only: l.patient_only, controlled_class: l.controlled_class },
    pack_id: l.pack_id ?? '', qty: qtyFmt(l.qty), patient: l.patient_id ? { id: l.patient_id, name: l.patient_name ?? '' } : null })));
  const [search, setSearch] = useState(''); const ds = useDebounced(search.trim(), 250);
  const found = useQuery({ queryKey: ['stock-items', 'pick', ds], queryFn: () => api<StockItem[]>('/stock/items', { query: { search: ds, limit: 20 } }), enabled: ds.length >= 2 });
  const [pat, setPat] = useState<string | null>(null);
  const body = () => ({ from_location_id: h.from, to_location_id: h.to, urgent: h.urgent, notes: h.notes || null,
    lines: lines.map((l) => ({ item_id: l.item.id, pack_id: l.pack_id || null, qty: Number(l.qty.replace(',', '.')), patient_id: l.patient?.id ?? null })) });
  const save = useMutation({
    mutationFn: async (submit: boolean) => {
      let x = r ? await api<StockRequest>(`/stock/requests/${r.id}`, { method: 'PUT', body: body() }) : await api<StockRequest>('/stock/requests', { body: body() });
      if (submit) x = await api<StockRequest>(`/stock/requests/${x.id}/submit`, { method: 'POST' });
      return x;
    },
    onSuccess: onDone,
  });
  const cancel = useMutation({ mutationFn: () => api<StockRequest>(`/stock/requests/${r!.id}/cancel`, { body: {} }), onSuccess: onDone });
  const upd = (key: string, p: Partial<FLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...p } : l)));
  const valid = h.from && h.to && h.from !== h.to && lines.every((l) => Number(l.qty.replace(',', '.')) > 0);
  return (
    <>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button className="btn" type="button" onClick={onClose}>← სია</button>
        <h2 className="grow" style={{ margin: 0 }}>{r ? 'მოთხოვნა — მონახაზი' : 'ახალი მოთხოვნა'}</h2>
        {r && <button className="btn" type="button" disabled={cancel.isPending} onClick={() => { if (confirm('გავაუქმოთ მონახაზი?')) cancel.mutate(); }}>გაუქმება</button>}
        <button className="btn" type="button" disabled={!valid || save.isPending} onClick={() => save.mutate(false)}>შენახვა</button>
        <button className="btn primary" type="button" disabled={!valid || !lines.length || save.isPending} onClick={() => save.mutate(true)}>გაგზავნა</button>
      </div>
      <section className="card card-pad" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12 }}>
        <div className="field"><label htmlFor="qt">ვისთვის (ჩემი ლოკაცია) <span className="req">*</span></label>
          <select id="qt" className="select" value={h.to} onChange={(e) => setH({ ...h, to: e.target.value })}>
            <option value="">— აირჩიეთ —</option>{mine.data?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>{mine.data && !mine.data.length && <span className="hint err">ლოკაცია არ გაქვთ — მიმართეთ საწყობის მენეჯერს (განყოფილების ქვესაწყობი)</span>}</div>
        <div className="field"><label htmlFor="qf">ვისგან <span className="req">*</span></label>
          <select id="qf" className="select" value={h.from} onChange={(e) => setH({ ...h, from: e.target.value })}>
            <option value="">— აირჩიეთ —</option>{sources.filter((l) => l.id !== h.to).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select></div>
        <div className="field"><label htmlFor="qn">შენიშვნა</label><input id="qn" className="input" value={h.notes} onChange={(e) => setH({ ...h, notes: e.target.value })} /></div>
        <label className="row" style={{ alignSelf: 'end', height: 44 }}><input type="checkbox" checked={h.urgent} onChange={(e) => setH({ ...h, urgent: e.target.checked })} /> სასწრაფო</label>
      </section>
      <section className="card card-pad stack" style={{ gap: 0, position: 'relative' }}>
        <input className="input" style={{ height: 38 }} aria-label="საქონლის ძებნა" placeholder="დაამატეთ: დასახელება, INN, კოდი, შტრიხკოდი" value={search} onChange={(e) => setSearch(e.target.value)} />
        {ds.length >= 2 && (found.data?.length ?? 0) > 0 && (
          <ul className="listbox" role="listbox" aria-label="საქონელი" style={{ position: 'absolute', top: 54, left: 16, right: 16, zIndex: 5 }}>
            {found.data!.filter((i) => i.is_active).map((i) => <li key={i.id} role="option" aria-selected={false} onMouseDown={(e) => { e.preventDefault();
              setLines((ls) => [...ls, { key: `r${++seq}`, item: i, pack_id: '', qty: '1', patient: null }]); setSearch(''); }}>
              <span className="grow">{i.name}{i.inn && <span className="small muted"> · {i.inn}{i.strength ? ` ${i.strength}` : ''}</span>}</span>
              {i.controlled_class && <span className="chip danger" style={{ height: 20, fontSize: 11 }}>{CONTROLLED_KA[i.controlled_class]}</span>}</li>)}
          </ul>)}
      </section>
      <section className="card">
        <table className="table">
          <thead><tr><th>#</th><th>საქონელი</th><th>ერთეული</th><th className="num">რაოდენობა</th><th>პაციენტი</th><th /></tr></thead>
          <tbody>{lines.map((l, i) => (
            <tr key={l.key}>
              <td className="mono small">{i + 1}</td>
              <td><strong>{l.item.name}</strong> <span className="mono small muted">{l.item.code}</span>
                {l.item.controlled_class && <div className="small" style={{ color: 'var(--danger-ink)' }}>{CONTROLLED_KA[l.item.controlled_class]} — დამტკიცება სავალდებულოა</div>}</td>
              <td><select className="select" style={{ height: 34, minWidth: 140 }} aria-label="ერთეული" value={l.pack_id} onChange={(e) => upd(l.key, { pack_id: e.target.value })}>
                <option value="">{l.item.base_unit_name}</option>{l.item.packs.map((p) => <option key={p.id} value={p.id}>{p.name} ({qtyFmt(p.qty_base)})</option>)}</select></td>
              <td><input className="input mono num" style={{ height: 34, width: 90 }} aria-label="რაოდენობა" inputMode="decimal" value={l.qty} onChange={(e) => upd(l.key, { qty: e.target.value })} /></td>
              <td>{l.patient ? <span className="row small" style={{ gap: 6 }}>{l.patient.name}<button className="icon-btn" type="button" aria-label="პაციენტის მოხსნა" onClick={() => upd(l.key, { patient: null })}>×</button></span>
                : <button className={`btn sm${l.item.patient_only ? ' primary' : ''}`} type="button" onClick={() => setPat(l.key)}>{l.item.patient_only ? 'პაციენტი (სავალდებულო)' : '+ პაციენტი'}</button>}</td>
              <td><button className="icon-btn" type="button" aria-label="ხაზის წაშლა" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>×</button></td>
            </tr>))}
            {!lines.length && <tr><td colSpan={6} className="muted">დაამატეთ საქონელი</td></tr>}
          </tbody>
        </table>
      </section>
      <ErrorBox error={save.error ?? cancel.error} />
      {pat && <Modal title="პაციენტი" onClose={() => setPat(null)} width={640}>
        <PatientSearch autoFocus onSelect={(p: PatientListItem) => { upd(pat, { patient: { id: p.id, name: `${p.first_name} ${p.last_name}` } }); setPat(null); }} />
      </Modal>}
    </>
  );
}

// ---------------------------------------------------------------- გაგზავნილი: დამტკიცება / გაცემა / დახურვა
function RequestView({ r, onClose, onDone }: { r: StockRequest; onClose: () => void; onDone: (r: StockRequest) => void }) {
  const { user } = useAuth(); const toast = useToast();
  const [appr, setAppr] = useState<Record<string, string> | null>(null);
  const [picking, setPicking] = useState(false);
  const act = useMutation({
    mutationFn: (a: { path: string; body?: unknown }) => api<StockRequest>(`/stock/requests/${r.id}/${a.path}`, { body: a.body ?? {} }),
    onSuccess: (x) => { setAppr(null); onDone(x); },
  });
  const ask = (msg: string) => { const v = prompt(msg); return v && v.trim().length >= 3 ? v.trim() : null; };
  return (
    <>
      {toast.node}
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button className="btn" type="button" onClick={onClose}>← სია</button>
        <h2 className="grow" style={{ margin: 0 }}>მოთხოვნა <span className="mono">{r.req_no}</span> <span className={`chip ${REQ_STATUS[r.status][0]}`}>{REQ_STATUS[r.status][1]}</span>
          {r.urgent && <span className="chip danger" style={{ marginLeft: 6 }}>სასწრაფო</span>}</h2>
        {r.status === 'submitted' && !appr && <>
          <button className="btn" type="button" disabled={act.isPending} onClick={() => { const v = ask('უარყოფის მიზეზი'); if (v) act.mutate({ path: 'reject', body: { reason: v } }); }}>უარყოფა</button>
          <button className="btn primary" type="button" onClick={() => setAppr(Object.fromEntries(r.lines.map((l) => [l.id, qtyFmt(l.qty_base)])))}>დამტკიცება</button>
          <button className="btn" type="button" disabled={act.isPending} onClick={() => { if (confirm('გავაუქმოთ მოთხოვნა?')) act.mutate({ path: 'cancel' }); }}>გაუქმება</button></>}
        {appr && <><button className="btn" type="button" onClick={() => setAppr(null)}>უკან</button>
          <button className="btn primary" type="button" disabled={act.isPending} onClick={() => act.mutate({ path: 'approve', body: { lines: Object.entries(appr).map(([id, v]) => ({ id, qty_approved: Number(v.replace(',', '.')) || 0 })) } })}>დამტკიცების დადასტურება</button></>}
        {OPEN.includes(r.status) && !picking && <>
          <button className="btn" type="button" disabled={act.isPending} onClick={() => { const v = ask('დახურვის მიზეზი (დარჩენილი აღარ გაიცემა)'); if (v) act.mutate({ path: 'cancel', body: { reason: v } }); }}>დახურვა</button>
          {isIssuer(user) && <button className="btn primary" type="button" onClick={() => setPicking(true)}>გაცემა</button>}</>}
      </div>
      <section className="card card-pad" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
        <div><span className="small muted">ვისთვის</span><div><strong>{r.to_name}</strong></div></div>
        <div><span className="small muted">ვისგან</span><div>{r.from_name}</div></div>
        <div><span className="small muted">ავტორი</span><div className="small">{r.created_by_name} · {tsDate(r.created_at)}</div></div>
        <div><span className="small muted">დამტკიცება</span><div className="small">{!r.requires_approval ? 'არ სჭირდება (ავტომატური)' : r.approved_by_name ? `${r.approved_by_name} · ${tsDate(r.approved_at!)}` : r.rejected_by_name ? `უარყო: ${r.rejected_by_name}` : 'ელოდება'}</div></div>
        {r.notes && <div style={{ gridColumn: 'span 2' }}><span className="small muted">შენიშვნა</span><div className="small">{r.notes}</div></div>}
        {r.reason && <div style={{ gridColumn: 'span 2' }}><span className="small muted">მიზეზი</span><div className="small">{r.reason}</div></div>}
      </section>
      {picking ? <PickPanel r={r} onCancel={() => setPicking(false)} onDone={(x, no) => { setPicking(false); toast.show(`გაიგზავნა: ${no}`); onDone(x); }} /> : (
        <section className="card">
          <table className="table">
            <thead><tr><th>#</th><th>საქონელი</th><th>პაციენტი</th><th className="num">მოთხოვნილი</th><th className="num">დამტკიცებული</th><th className="num">გაცემული</th><th className="num">ვისგან — ხელმისაწვდომი</th><th className="num">ვისთვის — ნაშთი</th></tr></thead>
            <tbody>{r.lines.map((l) => (
              <tr key={l.id}>
                <td className="mono small">{l.line_no}</td>
                <td><strong>{l.item_name}</strong> <span className="mono small muted">{l.item_code}</span>{l.controlled_class && <div><span className="chip danger" style={{ height: 20, fontSize: 11 }}>{CONTROLLED_KA[l.controlled_class]}</span></div>}</td>
                <td className="small">{l.patient_name ?? '—'}</td>
                <td className="num">{qtyFmt(l.qty)} {l.pack_name ?? l.base_unit_name}{l.pack_name && <div className="small muted">= {qtyFmt(l.qty_base)}</div>}</td>
                <td className="num">{appr ? <input className="input mono num" style={{ height: 32, width: 90 }} aria-label="დამტკიცებული" inputMode="decimal" value={appr[l.id]} onChange={(e) => setAppr({ ...appr, [l.id]: e.target.value })} />
                  : l.qty_approved !== null ? qtyFmt(l.qty_approved) : '—'}</td>
                <td className="num">{qtyFmt(l.qty_issued)}</td>
                <td className="num" style={{ color: Number(l.available) < Number(l.qty_approved ?? l.qty_base) - Number(l.qty_issued) ? 'var(--danger-ink)' : undefined }}>{qtyFmt(l.available)}</td>
                <td className="num">{qtyFmt(l.on_hand_to)}</td>
              </tr>))}</tbody>
          </table>
          {appr && <div className="hint" style={{ padding: '8px 16px' }}>რაოდენობა საბაზო ერთეულებში; 0 — ხაზი არ გაიცემა</div>}
        </section>)}
      {r.docs.length > 0 && (
        <section className="card">
          <div className="card-head"><h2>გაგზავნები</h2></div>
          <table className="table">
            <thead><tr><th>№</th><th>გაიგზავნა</th><th>მიღება</th></tr></thead>
            <tbody>{r.docs.map((d) => (
              <tr key={d.id}><td className="mono">{d.doc_no}</td><td className="small">{tsDate(d.posted_at)}</td>
                <td>{d.receive_status === 'received' ? <span className="chip ok">მიღებულია · {d.received_by_name}</span> : d.receive_status === 'returned' ? <span className="chip danger" title={d.receive_note ?? ''}>არ მიიღო — დაბრუნდა</span> : <span className="chip warn">გზაში — ელოდება დადასტურებას</span>}</td></tr>))}</tbody>
          </table>
        </section>)}
      <ErrorBox error={act.error} />
    </>
  );
}

// ---------------------------------------------------------------- გაცემა (FEFO-ს შეთავაზებით)
interface Row { key: string; request_line_id: string; lot_id: string; qty: string; override_reason: string }
function PickPanel({ r, onCancel, onDone }: { r: StockRequest; onCancel: () => void; onDone: (r: StockRequest, no: string) => void }) {
  const q = useQuery({ queryKey: ['stock-pick', r.id], queryFn: () => api<{ lines: PickLine[] }>(`/stock/requests/${r.id}/pick`), staleTime: 0 });
  const [rows, setRows] = useState<Row[] | null>(null);
  const lines = q.data?.lines ?? [];
  const cur = rows ?? lines.flatMap((l) => l.alloc.map((a) => ({ key: `${l.request_line_id}-${a.lot_id}`, request_line_id: l.request_line_id, lot_id: a.lot_id, qty: String(a.qty), override_reason: '' })));
  const set = (k: string, p: Partial<Row>) => setRows(cur.map((x) => (x.key === k ? { ...x, ...p } : x)));
  const issue = useMutation({
    mutationFn: () => api<StockRequest>(`/stock/requests/${r.id}/issue`, { body: { lines: cur.filter((x) => Number(x.qty) > 0).map((x) => ({ request_line_id: x.request_line_id, lot_id: x.lot_id, qty_base: Number(x.qty.replace(',', '.')), override_reason: x.override_reason || null })) } }),
    onSuccess: (x) => onDone(x, x.docs[x.docs.length - 1]?.doc_no ?? ''),
  });
  if (q.isLoading) return <Loading />;
  return (
    <section className="card card-pad stack">
      <div className="row"><h2 className="grow" style={{ margin: 0 }}>გაცემა — {r.from_name} → {r.to_name}</h2>
        <button className="btn" type="button" onClick={onCancel}>უკან</button>
        <button className="btn primary" type="button" disabled={issue.isPending || !cur.some((x) => Number(x.qty) > 0)} onClick={() => { if (confirm('გავგზავნოთ? მარაგი გადავა „გზაში“ — მიმღების დადასტურებამდე.')) issue.mutate(); }}>გაგზავნა</button></div>
      <span className="hint">FEFO: სისტემამ შესთავაზა ყველაზე ადრე ვადაგასვლადი ლოტები. სხვა ლოტის არჩევისას — მიზეზი სავალდებულოა. ნაკლები რაოდენობით — ნაწილობრივი გაცემა (დარჩენილი ღიად რჩება).</span>
      {lines.map((l) => {
        const my = cur.filter((x) => x.request_line_id === l.request_line_id);
        const sum = my.reduce((a, x) => a + (Number(x.qty) || 0), 0);
        const firstLot = l.lots[0]?.lot_id;
        return (
          <div key={l.request_line_id} className="stack" style={{ gap: 4, borderTop: '1px solid var(--line-soft)', paddingTop: 8 }}>
            <div className="row"><strong className="grow">{l.item_name}</strong>
              <span className="small">დარჩენილი: <strong>{qtyFmt(l.remaining)}</strong> · ამ გაცემით: <strong style={{ color: sum > l.remaining ? 'var(--danger-ink)' : undefined }}>{qtyFmt(sum)}</strong> {l.base_unit_name}</span>
              {l.shortage > 0 && <span className="chip warn">აკლია {qtyFmt(l.shortage)}</span>}</div>
            {my.map((x) => {
              const lot = l.lots.find((y) => y.lot_id === x.lot_id);
              const notFefo = !!firstLot && x.lot_id !== firstLot && (lot?.expires_on ?? '9999') > (l.lots[0].expires_on ?? '9999');
              return (
                <div key={x.key} className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <select className="select" style={{ height: 34, maxWidth: 320 }} aria-label="ლოტი" value={x.lot_id} onChange={(e) => set(x.key, { lot_id: e.target.value })}>
                    {l.lots.map((y) => <option key={y.lot_id} value={y.lot_id}>{y.lot_no ?? 'ლოტის გარეშე'}{y.serial_no ? ` · SN ${y.serial_no}` : ''} — {y.expires_on ? dateGe(y.expires_on) : 'ვადის გარეშე'} (ხელმ. {qtyFmt(y.available ?? 0)})</option>)}
                  </select>
                  <input className="input mono num" style={{ height: 34, width: 90 }} aria-label="რაოდენობა" inputMode="decimal" value={x.qty} onChange={(e) => set(x.key, { qty: e.target.value })} />
                  {notFefo && <input className="input" style={{ height: 34, maxWidth: 260 }} aria-label="FEFO-ს გარდა — მიზეზი" placeholder="არა FEFO — მიზეზი" value={x.override_reason} onChange={(e) => set(x.key, { override_reason: e.target.value })} />}
                  <button className="icon-btn" type="button" aria-label="მოხსნა" onClick={() => setRows(cur.filter((y) => y.key !== x.key))}>×</button>
                </div>);
            })}
            {l.lots.length > 0 && <button className="btn sm" type="button" style={{ alignSelf: 'flex-start' }} onClick={() => setRows([...cur, { key: `${l.request_line_id}-${Date.now()}`, request_line_id: l.request_line_id, lot_id: l.lots[0].lot_id, qty: '0', override_reason: '' }])}>+ ლოტი</button>}
            {!l.lots.length && <span className="small" style={{ color: 'var(--danger-ink)' }}>ხელმისაწვდომი მარაგი არ არის</span>}
          </div>);
      })}
      <ErrorBox error={q.error ?? issue.error} />
    </section>
  );
}
