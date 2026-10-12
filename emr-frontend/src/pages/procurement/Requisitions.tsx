import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, can } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Loading, useDebounced, useToast } from '../../components/ui';
import { dateGe, todayISO, tsDate } from '../../lib/format';
import { useProcRules, useStockRules } from '../../lib/modules';
import ItemSearch from '../stock/ItemSearch';
import { CONTROLLED_KA, qtyFmt, type Controlled, type StockItem, type StockLocation, type Supplier } from '../stock/types';
import { fmt, num, PO_EDIT, PO_STATUS, PR_EDIT, PR_SOURCE, PR_STATUS, STEP_KA, type Hints, type Pr, type PrRow, type PrStatus, type Step } from './types';

/** შესყიდვის მოთხოვნები: სია ↔ მოთხოვნა (?id=new | ?id=<id>) */
export default function Requisitions() {
  const [sp, setSp] = useSearchParams();
  const id = sp.get('id');
  if (id) return <PrPage id={id === 'new' ? null : id} onClose={() => setSp({})} onOpen={(x) => setSp({ id: x })} />;
  return <PrList onOpen={(x) => setSp({ id: x })} initial={sp.get('to_approve') ? 'approve' : 'all'} />;
}

const isApprover = (u: Parameters<typeof can>[0]) => can(u, 'admin', 'stock_manager', 'procurement_approve', 'pharmacist');
type Filter = 'all' | 'approve' | 'mine' | 'to_order' | 'open';

function PrList({ onOpen, initial }: { onOpen: (id: string) => void; initial: string }) {
  const { user } = useAuth();
  const [f, setF] = useState<Filter>(initial === 'approve' && isApprover(user) ? 'approve' : 'all');
  const [loc, setLoc] = useState(''); const [search, setSearch] = useState(''); const ds = useDebounced(search.trim(), 300);
  const locs = useQuery({ queryKey: ['stock-locations', false], queryFn: () => api<StockLocation[]>('/stock/locations') });
  const query = { location_id: loc, search: ds, ...(f === 'approve' && { to_approve: 'true' }), ...(f === 'mine' && { mine: 'true' }), ...(f === 'to_order' && { status: 'approved' }),
    ...(f === 'open' && { status: 'draft,submitted' }) };
  const q = useQuery({ queryKey: ['proc-prs', query], queryFn: () => api<PrRow[]>('/procurement/requisitions', { query }) });
  const rows = f === 'to_order' ? q.data?.filter((r) => r.lines_ordered < r.lines) : q.data;
  const filters: [Filter, string, boolean][] = [['all', 'ყველა', true], ['approve', 'ჩემი დასამტკიცებელი', isApprover(user)], ['open', 'მიმდინარე', true], ['to_order', 'შესაკვეთი', can(user, ...PO_EDIT)], ['mine', 'ჩემი', can(user, ...PR_EDIT)]];
  return (
    <div className="content">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <div className="seg" role="group" aria-label="ფილტრი">{filters.filter((x) => x[2]).map(([k, l]) => <button key={k} type="button" aria-pressed={f === k} onClick={() => setF(k)}>{l}</button>)}</div>
        <select className="select" style={{ maxWidth: 220, height: 38 }} aria-label="ლოკაცია" value={loc} onChange={(e) => setLoc(e.target.value)}>
          <option value="">ყველა ლოკაცია</option>{locs.data?.filter((l) => l.kind !== 'transit').map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <input className="input" style={{ maxWidth: 240, height: 38 }} aria-label="ძებნა" placeholder="PR-№ ან საქონელი" value={search} onChange={(e) => setSearch(e.target.value)} />
        <span className="grow" />
        {can(user, ...PR_EDIT) && <button className="btn primary" type="button" onClick={() => onOpen('new')}>+ შესყიდვის მოთხოვნა</button>}
      </div>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : (
        <div className="card">
          <table className="table">
            <thead><tr><th>№</th><th>თარიღი</th><th>ლოკაცია</th><th>წყარო</th><th>ავტორი</th><th className="num">ხაზი</th><th className="num">სავარაუდო ჯამი</th><th>დამტკიცება</th><th>სტატუსი</th></tr></thead>
            <tbody>{rows?.map((r) => (
              <tr key={r.id} className="clickable" onClick={() => onOpen(r.id)}>
                <td className="mono">{r.pr_no ?? '—'}{r.urgent && <span className="chip danger" style={{ marginLeft: 6, height: 20 }}>სასწრაფო</span>}</td>
                <td className="mono">{tsDate(r.submitted_at ?? r.created_at)}</td><td>{r.location_name}</td><td className="small">{PR_SOURCE[r.source]}</td><td className="small">{r.created_by_name}</td>
                <td className="num">{r.lines_ordered > 0 && r.status === 'approved' ? `${r.lines_ordered} / ${r.lines}` : r.lines}</td>
                <td className="num mono">{fmt(r.est_total)} ₾</td>
                <td className="small"><Trail r={r} /></td>
                <td><span className={`chip ${PR_STATUS[r.status][0]}`}>{PR_STATUS[r.status][1]}</span>
                  {r.status === 'approved' && r.lines_ordered >= r.lines && <span className="chip ok" style={{ marginLeft: 4 }}>შეკვეთილია</span>}</td>
              </tr>))}
              {!rows?.length && <tr><td colSpan={9} className="muted">მოთხოვნა არ არის</td></tr>}
            </tbody>
          </table>
        </div>)}
    </div>
  );
}

/** დამტკიცების ნაბიჯები: ✓ — ხელმოწერილი, ○ — ელოდება */
function Trail({ r }: { r: Pick<PrRow, 'status' | 'l1_at' | 'needs_finance' | 'finance_at' | 'needs_pharmacist' | 'pharm_at'> }) {
  if (r.status === 'draft' || r.status === 'cancelled') return <span className="muted">—</span>;
  const steps: [string, boolean][] = [['მენეჯერი', !!r.l1_at], ...(r.needs_finance ? [['ფინანსური', !!r.finance_at] as [string, boolean]] : []), ...(r.needs_pharmacist ? [['ფარმაცევტი', !!r.pharm_at] as [string, boolean]] : [])];
  return <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>{steps.map(([l, d]) => <span key={l} style={{ color: d ? 'var(--ok-ink)' : 'var(--muted)' }}>{d ? '✓' : '○'} {l}</span>)}</span>;
}

// ---------------------------------------------------------------- მოთხოვნა: რედაქტორი / ნახვა
function PrPage({ id, onClose, onOpen }: { id: string | null; onClose: () => void; onOpen: (id: string) => void }) {
  const { user } = useAuth(); const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['proc-pr', id], queryFn: () => api<Pr>(`/procurement/requisitions/${id}`), enabled: !!id });
  if (id && q.isLoading) return <div className="content"><Loading /></div>;
  if (id && q.error) return <div className="content"><ErrorBox error={q.error} /><button className="btn" type="button" onClick={onClose}>← სია</button></div>;
  const d = q.data;
  const done = (r: Pr, msg?: string) => { qc.setQueryData(['proc-pr', r.id], r); void qc.invalidateQueries({ queryKey: ['proc-prs'] }); void qc.invalidateQueries({ queryKey: ['proc-summary'] }); if (msg) toast.show(msg); if (!id) onOpen(r.id); };
  const editable = (!d || d.status === 'draft') && can(user, ...PR_EDIT);
  return (
    <div className="content">
      {toast.node}
      {editable ? <PrForm key={d?.id ?? 'new'} d={d ?? null} onClose={onClose} onDone={done} /> : d && <PrView d={d} onClose={onClose} onDone={done} />}
    </div>
  );
}

interface Line {
  key: string; item: Pick<StockItem, 'id' | 'name' | 'code' | 'base_unit_name' | 'packs' | 'controlled_class'> | null; free_name: string;
  pack_id: string; qty: string; est_price: string; supplier_id: string; notes: string; request_line_id: string | null;
}
let seq = 0;

function PrForm({ d, onClose, onDone }: { d: Pr | null; onClose: () => void; onDone: (r: Pr, msg?: string) => void }) {
  const { user } = useAuth(); const sr = useStockRules();
  const locs = useQuery({ queryKey: ['stock-locations', false], queryFn: () => api<StockLocation[]>('/stock/locations') });
  const sups = useQuery({ queryKey: ['stock-suppliers', '', false], queryFn: () => api<Supplier[]>('/stock/suppliers') });
  const pharmOnly = !can(user, 'admin', 'procurement', 'stock_manager', 'storekeeper') && sr.pharmacist_scope !== 'any';
  const [h, setH] = useState({ location_id: d?.location_id ?? '', urgent: d?.urgent ?? false, needed_by: d?.needed_by ?? '', notes: d?.notes ?? '' });
  const [lines, setLines] = useState<Line[]>(() => (d?.lines ?? []).map((l) => ({
    key: `p${++seq}`, item: l.item_id ? { id: l.item_id, name: l.item_name!, code: l.item_code!, base_unit_name: l.base_unit_name!, packs: [], controlled_class: l.controlled_class as Controlled | null } : null,
    free_name: l.free_name ?? '', pack_id: l.pack_id ?? '', qty: qtyFmt(l.qty), est_price: l.est_price === null ? '' : String(Number(l.est_price)), supplier_id: l.supplier_id ?? '', notes: l.notes ?? '', request_line_id: l.request_line_id,
  })));
  const ids = useMemo(() => [...new Set(lines.filter((l) => l.item && !l.item.packs.length).map((l) => l.item!.id))], [lines]);
  useQuery({ queryKey: ['proc-item-packs', ids.join(',')], enabled: ids.length > 0, queryFn: async () => {
    const all = await Promise.all(ids.map((x) => api<StockItem>(`/stock/items/${x}`)));
    setLines((ls) => ls.map((l) => { const it = l.item && all.find((a) => a.id === l.item!.id); return it ? { ...l, item: { ...l.item!, packs: it.packs } } : l; }));
    return true;
  } });
  const upd = (key: string, p: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...p } : l)));
  /** ახალი ხაზი: ფასი და მომწოდებელი მინიშნებიდან (ფასთა ნუსხა → ბოლო მიღება) */
  const addItem = async (it: StockItem) => {
    const key = `p${++seq}`; const pack = it.packs.find((p) => p.is_receipt_default);
    setLines((ls) => [...ls, { key, item: it, free_name: '', pack_id: pack?.id ?? '', qty: '1', est_price: '', supplier_id: '', notes: '', request_line_id: null }]);
    try {
      const hint = await api<Hints>('/procurement/price-hints', { query: { item_id: it.id } });
      const per = pack ? Number(pack.qty_base) : 1;
      const p = hint.prices[0]; const l = hint.last[0];
      const base = p ? Number(p.base_price) : l ? Number(l.unit_cost) : null;
      if (base !== null) upd(key, { est_price: String(Math.round(base * per * 10000) / 10000), supplier_id: p?.supplier_id ?? l?.supplier_id ?? '' });
    } catch { /* მინიშნება არ არის */ }
  };
  const body = () => ({
    location_id: h.location_id, urgent: h.urgent, needed_by: h.needed_by || null, notes: h.notes || null,
    lines: lines.map((l) => ({ item_id: l.item?.id ?? null, free_name: l.item ? null : l.free_name, pack_id: l.item ? l.pack_id || null : null, qty: num(l.qty),
      est_price: l.est_price.trim() === '' ? null : num(l.est_price), supplier_id: l.supplier_id || null, notes: l.notes || null, request_line_id: l.request_line_id })),
  });
  const save = useMutation({
    mutationFn: async (submit: boolean) => {
      let r = d ? await api<Pr>(`/procurement/requisitions/${d.id}`, { method: 'PUT', body: body() }) : await api<Pr>('/procurement/requisitions', { body: body() });
      if (submit) r = await api<Pr>(`/procurement/requisitions/${r.id}/submit`, { method: 'POST' }).catch((e) => { onDone(r); throw e; });
      return { r, submit };
    },
    onSuccess: ({ r, submit }) => onDone(r, submit ? `გაიგზავნა: ${r.pr_no}` : 'შენახულია'),
  });
  const cancel = useMutation({ mutationFn: () => api<Pr>(`/procurement/requisitions/${d!.id}/cancel`, { body: { reason: 'მონახაზი გაუქმდა' } }), onSuccess: (r) => onDone(r) });
  const total = lines.reduce((a, l) => a + (l.est_price.trim() === '' ? 0 : num(l.est_price) * num(l.qty)), 0);
  const valid = h.location_id && lines.length > 0 && lines.every((l) => num(l.qty) > 0 && (l.item || l.free_name.trim().length >= 2));
  const locOptions = (locs.data ?? []).filter((l) => l.kind !== 'transit' && (!pharmOnly || l.kind === 'pharmacy'));
  return (
    <>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button className="btn" type="button" onClick={onClose}>← სია</button>
        <h2 className="grow" style={{ margin: 0 }}>{d ? 'შესყიდვის მოთხოვნა — მონახაზი' : 'ახალი შესყიდვის მოთხოვნა'}{d && <span className="chip" style={{ marginLeft: 8 }}>{PR_SOURCE[d.source]}{d.req_no ? ` · ${d.req_no}` : ''}</span>}</h2>
        {d && <button className="btn" type="button" disabled={cancel.isPending} onClick={() => { if (confirm('გავაუქმოთ მონახაზი?')) cancel.mutate(); }}>გაუქმება</button>}
        <button className="btn" type="button" disabled={!h.location_id || save.isPending} onClick={() => save.mutate(false)}>შენახვა</button>
        <button className="btn primary" type="button" disabled={!valid || save.isPending} onClick={() => save.mutate(true)}>დასამტკიცებლად გაგზავნა</button>
      </div>
      <section className="card card-pad" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12 }}>
        <div className="field"><label htmlFor="pl">მიწოდების ლოკაცია <span className="req">*</span></label>
          <select id="pl" className="select" value={h.location_id} onChange={(e) => setH({ ...h, location_id: e.target.value })}>
            <option value="">— აირჩიეთ —</option>{locOptions.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>
        <div className="field"><label htmlFor="pn">საჭიროა თარიღამდე</label><input id="pn" className="input mono" type="date" min={todayISO()} value={h.needed_by} onChange={(e) => setH({ ...h, needed_by: e.target.value })} /></div>
        <label className="row" style={{ alignSelf: 'end', height: 44 }}><input type="checkbox" checked={h.urgent} onChange={(e) => setH({ ...h, urgent: e.target.checked })} /> სასწრაფო</label>
        <div className="field"><label htmlFor="pno">შენიშვნა</label><input id="pno" className="input" value={h.notes} onChange={(e) => setH({ ...h, notes: e.target.value })} /></div>
      </section>
      <section className="card card-pad row" style={{ flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div className="grow" style={{ minWidth: 320 }}><ItemSearch placeholder="კატალოგის საქონელი: ძებნა ან სკანირება" onPick={(i) => void addItem(i)} /></div>
        <button className="btn" type="button" onClick={() => setLines((ls) => [...ls, { key: `p${++seq}`, item: null, free_name: '', pack_id: '', qty: '1', est_price: '', supplier_id: '', notes: '', request_line_id: null }])}>+ თავისუფალი ხაზი (კატალოგში არ არის)</button>
      </section>
      <section className="card" style={{ overflowX: 'auto' }}>
        <table className="table">
          <thead><tr><th>#</th><th>საქონელი</th><th>ერთეული</th><th className="num">რაოდ.</th><th className="num">სავარაუდო ფასი (დღგ-ს გ.)</th><th>მომწოდებელი</th><th className="num">ჯამი</th><th>შენიშვნა</th><th /></tr></thead>
          <tbody>{lines.map((l, i) => {
            const per = l.item && l.pack_id ? Number(l.item.packs.find((p) => p.id === l.pack_id)?.qty_base ?? 1) : 1;
            return (
              <tr key={l.key} style={{ verticalAlign: 'top' }}>
                <td className="mono small">{i + 1}</td>
                <td style={{ minWidth: 200 }}>{l.item ? <><strong>{l.item.name}</strong><div className="small muted mono">{l.item.code}{l.item.controlled_class ? ` · ${CONTROLLED_KA[l.item.controlled_class]}` : ''}{l.request_line_id ? ' · მოთხოვნიდან' : ''}</div></>
                  : <input className="input" style={{ height: 34 }} aria-label="დასახელება" placeholder="დასახელება (თავისუფალი ხაზი)" value={l.free_name} onChange={(e) => upd(l.key, { free_name: e.target.value })} />}</td>
                <td>{l.item ? <><select className="select" style={{ height: 34, minWidth: 140 }} aria-label="ერთეული" value={l.pack_id} onChange={(e) => upd(l.key, { pack_id: e.target.value })}>
                  <option value="">{l.item.base_unit_name}</option>{l.item.packs.map((p) => <option key={p.id} value={p.id}>{p.name} ({qtyFmt(p.qty_base)})</option>)}</select>
                  {per > 1 && <div className="small muted">= {qtyFmt(num(l.qty) * per)} {l.item.base_unit_name}</div>}</> : <span className="small muted">საბაზო ერთეული</span>}</td>
                <td><input className="input mono num" style={{ height: 34, width: 80 }} aria-label="რაოდენობა" inputMode="decimal" value={l.qty} onChange={(e) => upd(l.key, { qty: e.target.value })} /></td>
                <td><input className="input mono num" style={{ height: 34, width: 100 }} aria-label="სავარაუდო ფასი" inputMode="decimal" placeholder="ერთეულზე" value={l.est_price} onChange={(e) => upd(l.key, { est_price: e.target.value })} /></td>
                <td><select className="select" style={{ height: 34, minWidth: 170 }} aria-label="მომწოდებელი" value={l.supplier_id} onChange={(e) => upd(l.key, { supplier_id: e.target.value })}>
                  <option value="">—</option>{sups.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></td>
                <td className="num mono">{l.est_price.trim() ? fmt(num(l.est_price) * num(l.qty)) : '—'}</td>
                <td><input className="input" style={{ height: 34, minWidth: 120 }} aria-label="შენიშვნა" value={l.notes} onChange={(e) => upd(l.key, { notes: e.target.value })} /></td>
                <td><button className="icon-btn" type="button" aria-label="ხაზის წაშლა" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>×</button></td>
              </tr>);
          })}
            {!lines.length && <tr><td colSpan={9} className="muted">დაამატეთ საქონელი ან თავისუფალი ხაზი</td></tr>}
          </tbody>
        </table>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 18, padding: '10px 16px' }}><span>სავარაუდო ჯამი (დღგ-ს გარეშე): <strong className="mono">{fmt(total)} ₾</strong></span></div>
      </section>
      <span className="hint">გაგზავნისას სავარაუდო ფასი სავალდებულოა — მისით განისაზღვრება დამტკიცების დონე. ფასი და მომწოდებელი ავტომატურად ივსება ფასთა ნუსხიდან ან ბოლო მიღებიდან.</span>
      <ErrorBox error={save.error ?? cancel.error} />
    </>
  );
}

function PrView({ d, onClose, onDone }: { d: Pr; onClose: () => void; onDone: (r: Pr, msg?: string) => void }) {
  const { user } = useAuth(); const nav = useNavigate(); const rules = useProcRules();
  const sups = useQuery({ queryKey: ['stock-suppliers', '', false], queryFn: () => api<Supplier[]>('/stock/suppliers') });
  const act = useMutation({ mutationFn: (a: { path: string; body?: unknown; msg?: string }) => api<Pr>(`/procurement/requisitions/${d.id}/${a.path}`, { body: a.body ?? {} }), onSuccess: (r, a) => onDone(r, a.msg) });
  const patch = useMutation({ mutationFn: (a: { line: string; body: unknown }) => api<Pr>(`/procurement/requisitions/${d.id}/lines/${a.line}`, { method: 'PATCH', body: a.body }), onSuccess: (r) => onDone(r) });
  const toPo = useMutation({ mutationFn: () => api<{ orders: string[] }>(`/procurement/requisitions/${d.id}/orders`, { method: 'POST' }),
    onSuccess: (r) => nav(r.orders.length === 1 ? `/procurement/orders?id=${r.orders[0]}` : '/procurement/orders') });
  const ask = (m: string) => { const v = prompt(m); return v && v.trim().length >= 3 ? v.trim() : null; };
  const admin = can(user, 'admin'); const own = d.created_by === user?.id && !admin;
  const myStep: Step | undefined = own ? undefined : d.pending.find((s) => (s === 'l1' ? can(user, 'admin', 'stock_manager')
    : s === 'finance' ? !!d.l1_at && can(user, 'admin', 'procurement_approve') && (admin || d.l1_by !== user?.id) : can(user, 'admin', 'pharmacist')));
  const prep = can(user, ...PO_EDIT) && ['submitted', 'approved'].includes(d.status);
  const [linking, setLinking] = useState<string | null>(null);
  const open = d.lines.filter((l) => Number(l.qty_ordered) < Number(l.qty_base));
  return (
    <>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button className="btn" type="button" onClick={onClose}>← სია</button>
        <h2 className="grow" style={{ margin: 0 }}>შესყიდვის მოთხოვნა <span className="mono">{d.pr_no ?? ''}</span> <span className={`chip ${PR_STATUS[d.status as PrStatus][0]}`}>{PR_STATUS[d.status as PrStatus][1]}</span>
          {d.urgent && <span className="chip danger" style={{ marginLeft: 6 }}>სასწრაფო</span>}</h2>
        {myStep && <>
          <button className="btn" type="button" disabled={act.isPending} onClick={() => { const v = ask('უარყოფის მიზეზი'); if (v) act.mutate({ path: 'reject', body: { reason: v }, msg: 'უარყოფილია' }); }}>უარყოფა</button>
          <button className="btn primary" type="button" disabled={act.isPending} onClick={() => act.mutate({ path: 'approve', body: { step: myStep }, msg: 'დამტკიცებულია' })}>დამტკიცება ({STEP_KA[myStep]})</button></>}
        {d.status === 'submitted' && (d.created_by === user?.id || can(user, 'admin', 'procurement', 'stock_manager')) &&
          <button className="btn" type="button" disabled={act.isPending} onClick={() => { const v = ask('გაუქმების მიზეზი'); if (v) act.mutate({ path: 'cancel', body: { reason: v } }); }}>გაუქმება</button>}
        {d.status === 'approved' && can(user, ...PO_EDIT) && <>
          <button className="btn" type="button" disabled={act.isPending} onClick={() => { const v = ask('დახურვის მიზეზი (დარჩენილი აღარ შეუკვეთდება)'); if (v) act.mutate({ path: 'close', body: { reason: v } }); }}>დახურვა</button>
          {open.length > 0 && rules?.po_mode !== 'off' && <button className="btn primary" type="button" disabled={toPo.isPending} onClick={() => toPo.mutate()}>შეკვეთის მომზადება (PO)</button>}</>}
      </div>
      <section className="card card-pad" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
        <div><span className="small muted">ლოკაცია</span><div><strong>{d.location_name}</strong></div></div>
        <div><span className="small muted">წყარო</span><div>{PR_SOURCE[d.source]}{d.req_no && <span className="mono"> · {d.req_no}</span>}</div></div>
        <div><span className="small muted">ავტორი</span><div className="small">{d.created_by_name} · {tsDate(d.submitted_at ?? d.created_at)}</div></div>
        <div><span className="small muted">სავარაუდო ჯამი</span><div className="mono"><strong>{fmt(d.est_total)} ₾</strong>{d.needed_by && <span className="small muted"> · საჭიროა {dateGe(d.needed_by)}-მდე</span>}</div></div>
        <div style={{ gridColumn: 'span 2' }}><span className="small muted">დამტკიცება</span>
          <div className="small stack" style={{ gap: 2 }}>
            <span>{d.l1_by_name ? `✓ საწყობის მენეჯერი: ${d.l1_by_name}` : '○ საწყობის მენეჯერი — ელოდება'}</span>
            {d.needs_finance && <span>{d.finance_by_name ? `✓ ფინანსური: ${d.finance_by_name}` : '○ ფინანსური — ელოდება (ზღვარს ზემოთ)'}</span>}
            {d.needs_pharmacist && <span>{d.pharm_by_name ? `✓ ფარმაცევტი: ${d.pharm_by_name}` : '○ ფარმაცევტი — ელოდება (კონტროლირებადი)'}</span>}
            {d.rejected_by_name && <span style={{ color: 'var(--danger-ink)' }}>✗ უარყო: {d.rejected_by_name}</span>}
          </div></div>
        {d.reason && <div style={{ gridColumn: 'span 2' }}><span className="small muted">მიზეზი</span><div className="small">{d.reason}</div></div>}
        {d.notes && <div style={{ gridColumn: 'span 2' }}><span className="small muted">შენიშვნა</span><div className="small">{d.notes}</div></div>}
      </section>
      <section className="card" style={{ overflowX: 'auto' }}>
        <table className="table">
          <thead><tr><th>#</th><th>საქონელი</th><th className="num">რაოდენობა</th><th className="num">სავარაუდო ფასი</th><th className="num">ჯამი</th><th>მომწოდებელი</th><th className="num">შეკვეთილი</th></tr></thead>
          <tbody>{d.lines.map((l) => (
            <tr key={l.id} style={{ verticalAlign: 'top' }}>
              <td className="mono small">{l.line_no}</td>
              <td style={{ minWidth: 220 }}>{l.item_id ? <><strong>{l.item_name}</strong> <span className="mono small muted">{l.item_code}</span>
                {l.controlled_class && <span className="chip danger" style={{ marginLeft: 6, height: 20 }}>{CONTROLLED_KA[l.controlled_class as Controlled]}</span>}</>
                : <><span className="chip warn" style={{ height: 20 }}>კატალოგში არ არის</span> <strong>{l.free_name}</strong>
                  {prep && (linking === l.id ? <div style={{ marginTop: 6 }}><ItemSearch placeholder="მიაბით კატალოგის საქონელს" onPick={(i) => { setLinking(null); patch.mutate({ line: l.id, body: { item_id: i.id } }); }} /></div>
                    : <div><button className="btn sm" type="button" style={{ marginTop: 4 }} onClick={() => setLinking(l.id)}>კატალოგზე მიბმა</button></div>)}</>}
                {l.notes && <div className="small muted">{l.notes}</div>}</td>
              <td className="num">{qtyFmt(l.qty)} {l.pack_name ?? l.base_unit_name ?? ''}{l.pack_name && <div className="small muted">= {qtyFmt(l.qty_base)} {l.base_unit_name}</div>}</td>
              <td className="num mono">{fmt(l.est_price)}</td><td className="num mono">{l.est_price ? fmt(Number(l.est_price) * Number(l.qty)) : '—'}</td>
              <td>{prep && Number(l.qty_ordered) < Number(l.qty_base) ? <select className="select" style={{ height: 32, minWidth: 170 }} aria-label="მომწოდებელი" value={l.supplier_id ?? ''} disabled={patch.isPending}
                onChange={(e) => patch.mutate({ line: l.id, body: { supplier_id: e.target.value || null } })}><option value="">— მიუთითეთ —</option>{sups.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
                : l.supplier_name ?? '—'}</td>
              <td className="num">{Number(l.qty_ordered) >= Number(l.qty_base) ? <span className="chip ok">✓ {qtyFmt(l.qty_ordered)}</span> : qtyFmt(l.qty_ordered)}</td>
            </tr>))}</tbody>
        </table>
      </section>
      {d.orders.length > 0 && (
        <section className="card card-pad stack" style={{ gap: 6 }}>
          <strong>შეკვეთები</strong>
          {d.orders.map((o) => <a key={o.id} href={`/procurement/orders?id=${o.id}`} onClick={(e) => { e.preventDefault(); nav(`/procurement/orders?id=${o.id}`); }} className="row small" style={{ gap: 10 }}>
            <span className="mono">{o.po_no ?? 'მონახაზი'}</span><span>{o.supplier_name}</span><span className="mono">{fmt(o.total_gel)} ₾</span><span className={`chip ${PO_STATUS[o.status][0]}`}>{PO_STATUS[o.status][1]}</span></a>)}
        </section>)}
      {own && d.status === 'submitted' && <div className="alert info">საკუთარ მოთხოვნას ვერ დაამტკიცებთ — ელოდება: {d.pending.map((s) => STEP_KA[s]).join(', ')}</div>}
      <ErrorBox error={act.error ?? patch.error ?? toPo.error} />
    </>
  );
}
