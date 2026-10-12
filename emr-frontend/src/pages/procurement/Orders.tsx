import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, can } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Loading, useDebounced, useToast } from '../../components/ui';
import { dateGe, todayISO, tsDate } from '../../lib/format';
import { useProcRules } from '../../lib/modules';
import ItemSearch from '../stock/ItemSearch';
import { qtyFmt, type StockItem, type StockLocation, type Supplier } from '../stock/types';
import { CUR_SIGN, fmt, num, PO_EDIT, PO_STATUS, RECEIPT_EDIT, type Currency, type Hints, type Po, type PoRow, type PoStatus } from './types';

/** შეკვეთები მომწოდებელთან: სია ↔ შეკვეთა (?id=new | ?id=<id>) */
export default function Orders() {
  const [sp, setSp] = useSearchParams();
  const id = sp.get('id');
  if (id) return <PoPage id={id === 'new' ? null : id} onClose={() => setSp({})} onOpen={(x) => setSp({ id: x })} />;
  return <PoList onOpen={(x) => setSp({ id: x })} />;
}

type Filter = 'all' | 'open' | 'pending' | 'overdue' | 'draft';
function PoList({ onOpen }: { onOpen: (id: string) => void }) {
  const { user } = useAuth(); const rules = useProcRules();
  const [f, setF] = useState<Filter>('open'); const [sup, setSup] = useState(''); const [search, setSearch] = useState(''); const ds = useDebounced(search.trim(), 300);
  const sups = useQuery({ queryKey: ['stock-suppliers', '', false], queryFn: () => api<Supplier[]>('/stock/suppliers') });
  const query = { supplier_id: sup, search: ds, ...(f === 'open' && { status: 'sent,partial' }), ...(f === 'pending' && { status: 'pending' }), ...(f === 'draft' && { status: 'draft' }), ...(f === 'overdue' && { overdue: 'true' }) };
  const q = useQuery({ queryKey: ['proc-pos', query], queryFn: () => api<PoRow[]>('/procurement/orders', { query }) });
  return (
    <div className="content">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <div className="seg" role="group" aria-label="ფილტრი">{([['open', 'ღია (მოსალოდნელი)'], ['overdue', 'ვადაგადაცილებული'], ['pending', 'დასამტკიცებელი'], ['draft', 'მონახაზი'], ['all', 'ყველა']] as [Filter, string][])
          .map(([k, l]) => <button key={k} type="button" aria-pressed={f === k} onClick={() => setF(k)}>{l}</button>)}</div>
        <select className="select" style={{ maxWidth: 240, height: 38 }} aria-label="მომწოდებელი" value={sup} onChange={(e) => setSup(e.target.value)}>
          <option value="">ყველა მომწოდებელი</option>{sups.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        <input className="input" style={{ maxWidth: 220, height: 38 }} aria-label="ძებნა" placeholder="PO-№, მომწოდებელი, საქონელი" value={search} onChange={(e) => setSearch(e.target.value)} />
        <span className="grow" />
        {can(user, ...PO_EDIT) && rules?.po_mode !== 'off' && <button className="btn primary" type="button" onClick={() => onOpen('new')}>+ შეკვეთა</button>}
      </div>
      {rules?.po_mode === 'off' && <div className="alert info">შეკვეთები (PO) გამორთულია — პარამეტრი „PO-ს რეჟიმი“.</div>}
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : (
        <div className="card">
          <table className="table">
            <thead><tr><th>№</th><th>თარიღი</th><th>მომწოდებელი</th><th>მიწოდება</th><th>მოსალოდნელი</th><th className="num">ჯამი</th><th style={{ width: 140 }}>მიღებული</th><th>სტატუსი</th></tr></thead>
            <tbody>{q.data?.map((o) => {
              const pct = Math.round(Number(o.received_ratio) * 100);
              return (
                <tr key={o.id} className="clickable" onClick={() => onOpen(o.id)}>
                  <td className="mono">{o.po_no ?? '—'}</td><td className="mono">{dateGe(o.order_date)}</td><td>{o.supplier_name}</td><td className="small">{o.location_name}</td>
                  <td className="mono" style={o.overdue ? { color: 'var(--danger-ink)', fontWeight: 600 } : undefined}>{o.expected_date ? dateGe(o.expected_date) : '—'}{o.overdue && ' ⚠'}</td>
                  <td className="num mono">{fmt(Number(o.total_net) + Number(o.total_vat))} {CUR_SIGN[o.currency]}</td>
                  <td><div className="row" style={{ gap: 6 }}><div style={{ flex: 1, height: 6, borderRadius: 3, background: 'var(--line-soft)' }}><div style={{ width: `${pct}%`, height: 6, borderRadius: 3, background: pct >= 100 ? 'var(--ok-ink)' : 'var(--accent)' }} /></div><span className="small mono">{pct}%</span></div></td>
                  <td><span className={`chip ${PO_STATUS[o.status][0]}`}>{PO_STATUS[o.status][1]}</span></td>
                </tr>);
            })}
              {!q.data?.length && <tr><td colSpan={8} className="muted">შეკვეთა არ არის</td></tr>}
            </tbody>
          </table>
        </div>)}
    </div>
  );
}

function PoPage({ id, onClose, onOpen }: { id: string | null; onClose: () => void; onOpen: (id: string) => void }) {
  const { user } = useAuth(); const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['proc-po', id], queryFn: () => api<Po>(`/procurement/orders/${id}`), enabled: !!id });
  if (id && q.isLoading) return <div className="content"><Loading /></div>;
  if (id && q.error) return <div className="content"><ErrorBox error={q.error} /><button className="btn" type="button" onClick={onClose}>← სია</button></div>;
  const d = q.data;
  const done = (r: Po, msg?: string) => { qc.setQueryData(['proc-po', r.id], r); void qc.invalidateQueries({ queryKey: ['proc-pos'] }); void qc.invalidateQueries({ queryKey: ['proc-summary'] }); if (msg) toast.show(msg); if (!id) onOpen(r.id); };
  const editable = (!d || d.status === 'draft') && can(user, ...PO_EDIT);
  return <div className="content">{toast.node}{editable ? <PoForm key={d?.id ?? 'new'} d={d ?? null} onClose={onClose} onDone={done} /> : d && <PoView d={d} onClose={onClose} onDone={done} />}</div>;
}

interface Line { key: string; item: Pick<StockItem, 'id' | 'name' | 'code' | 'base_unit_name' | 'packs'>; pack_id: string; qty: string; price: string; vat_rate: number; requisition_line_id: string | null; pr_no: string | null; notes: string }
let seq = 0;

function PoForm({ d, onClose, onDone }: { d: Po | null; onClose: () => void; onDone: (r: Po, msg?: string) => void }) {
  const locs = useQuery({ queryKey: ['stock-locations', false], queryFn: () => api<StockLocation[]>('/stock/locations') });
  const sups = useQuery({ queryKey: ['stock-suppliers', '', false], queryFn: () => api<Supplier[]>('/stock/suppliers') });
  const rules = useProcRules();
  const [h, setH] = useState({ supplier_id: d?.supplier_id ?? '', location_id: d?.location_id ?? '', order_date: d?.order_date ?? todayISO(), expected_date: d?.expected_date ?? '',
    currency: (d?.currency ?? 'GEL') as Currency, fx_rate: d ? String(Number(d.fx_rate)) : '1', prices_include_vat: d?.prices_include_vat ?? false, contract_no: d?.contract_no ?? '', notes: d?.notes ?? '' });
  const [lines, setLines] = useState<Line[]>(() => (d?.lines ?? []).map((l) => ({ key: `o${++seq}`, item: { id: l.item_id, name: l.item_name, code: l.item_code, base_unit_name: l.base_unit_name, packs: [] },
    pack_id: l.pack_id ?? '', qty: qtyFmt(l.qty), price: String(Number(l.price)), vat_rate: Number(l.vat_rate), requisition_line_id: l.requisition_line_id, pr_no: l.pr_no, notes: l.notes ?? '' })));
  const ids = useMemo(() => [...new Set(lines.filter((l) => !l.item.packs.length).map((l) => l.item.id))], [lines]);
  useQuery({ queryKey: ['proc-item-packs', ids.join(',')], enabled: ids.length > 0, queryFn: async () => {
    const all = await Promise.all(ids.map((x) => api<StockItem>(`/stock/items/${x}`)));
    setLines((ls) => ls.map((l) => { const it = all.find((a) => a.id === l.item.id); return it ? { ...l, item: { ...l.item, packs: it.packs } } : l; }));
    return true;
  } });
  const sup = sups.data?.find((s) => s.id === h.supplier_id);
  const upd = (key: string, p: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...p } : l)));
  const addItem = async (it: StockItem) => {
    const key = `o${++seq}`; const pack = it.packs.find((p) => p.is_receipt_default);
    setLines((ls) => [...ls, { key, item: it, pack_id: pack?.id ?? '', qty: '1', price: '', vat_rate: sup ? (sup.vat_payer ? 18 : 0) : 18, requisition_line_id: null, pr_no: null, notes: '' }]);
    if (!h.supplier_id) return;
    try {
      const hint = await api<Hints>('/procurement/price-hints', { query: { item_id: it.id, supplier_id: h.supplier_id } });
      const p = hint.prices[0];
      if (p) upd(key, { pack_id: p.pack_id ?? '', price: String(Number(p.price)), vat_rate: Number(p.vat_rate) });
      else if (hint.last[0]) upd(key, { price: String(Math.round(Number(hint.last[0].unit_cost) * (pack ? Number(pack.qty_base) : 1) * 10000) / 10000) });
    } catch { /* მინიშნება არ არის */ }
  };
  const fx = h.currency === 'GEL' ? 1 : num(h.fx_rate || '0');
  const body = () => ({ supplier_id: h.supplier_id, location_id: h.location_id, order_date: h.order_date, expected_date: h.expected_date || null, currency: h.currency,
    ...(h.currency !== 'GEL' && { fx_rate: fx }), prices_include_vat: h.prices_include_vat, contract_no: h.contract_no || null, notes: h.notes || null,
    lines: lines.map((l) => ({ item_id: l.item.id, pack_id: l.pack_id || null, qty: num(l.qty), price: num(l.price || '0'), vat_rate: l.vat_rate, requisition_line_id: l.requisition_line_id, notes: l.notes || null })) });
  const save = useMutation({
    mutationFn: async (send: boolean) => {
      let r = d ? await api<Po>(`/procurement/orders/${d.id}`, { method: 'PUT', body: body() }) : await api<Po>('/procurement/orders', { body: body() });
      if (send) r = await api<Po>(`/procurement/orders/${r.id}/send`, { method: 'POST' }).catch((e) => { onDone(r); throw e; });
      return { r, send };
    },
    onSuccess: ({ r, send }) => onDone(r, send ? (r.status === 'pending' ? `${r.po_no} — გადაეცა ფინანსურ დამტკიცებას` : `გაიგზავნა: ${r.po_no}`) : 'შენახულია'),
  });
  const cancel = useMutation({ mutationFn: () => api<Po>(`/procurement/orders/${d!.id}/cancel`, { body: { reason: 'მონახაზი გაუქმდა' } }), onSuccess: (r) => onDone(r) });
  const t = lines.reduce((a, l) => {
    const p = num(l.price || '0'); const qn = num(l.qty || '0');
    if (h.prices_include_vat) { const g = p * qn; const n = g / (1 + l.vat_rate / 100); return { net: a.net + n, vat: a.vat + g - n }; }
    return { net: a.net + p * qn, vat: a.vat + (p * qn * l.vat_rate) / 100 };
  }, { net: 0, vat: 0 });
  const valid = h.supplier_id && h.location_id && lines.length > 0 && lines.every((l) => num(l.qty) > 0 && l.price.trim() !== '') && (h.currency === 'GEL' || fx > 0);
  const over = rules && rules.pr_approval_levels === 2 && lines.some((l) => !l.requisition_line_id) && (rules.pr_finance_threshold === 0 || t.net * fx > rules.pr_finance_threshold);
  const cur = CUR_SIGN[h.currency];
  return (
    <>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button className="btn" type="button" onClick={onClose}>← სია</button>
        <h2 className="grow" style={{ margin: 0 }}>{d ? <>შეკვეთა — მონახაზი {d.po_no && <span className="mono">{d.po_no}</span>}</> : 'ახალი შეკვეთა მომწოდებელთან'}</h2>
        {d && <button className="btn" type="button" disabled={cancel.isPending} onClick={() => { if (confirm('გავაუქმოთ შეკვეთა?')) cancel.mutate(); }}>გაუქმება</button>}
        <button className="btn" type="button" disabled={!h.supplier_id || !h.location_id || save.isPending} onClick={() => save.mutate(false)}>შენახვა</button>
        <button className="btn primary" type="button" disabled={!valid || save.isPending} onClick={() => { if (confirm(over ? 'შეკვეთა ზღვარს ზემოთაა და PR-ის გარეშე — გადაეცემა ფინანსურ დამტკიცებას. გავაგრძელოთ?' : 'გავაგზავნოთ? გაგზავნილი შეკვეთა აღარ შეიცვლება.')) save.mutate(true); }}>გაგზავნა</button>
      </div>
      {d?.reason && <div className="alert warn">დაბრუნდა: {d.reason}</div>}
      <section className="card card-pad" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12 }}>
        <div className="field"><label htmlFor="os">მომწოდებელი <span className="req">*</span></label>
          <select id="os" className="select" value={h.supplier_id} onChange={(e) => { const s = sups.data?.find((x) => x.id === e.target.value);
            setH({ ...h, supplier_id: e.target.value, contract_no: h.contract_no || s?.contract_no || '', expected_date: h.expected_date || (s?.lead_time_days ? shift(h.order_date, s.lead_time_days) : '') }); }}>
            <option value="">— აირჩიეთ —</option>{sups.data?.map((s) => <option key={s.id} value={s.id}>{s.name}{s.tax_id ? ` (${s.tax_id})` : ''}</option>)}</select></div>
        <div className="field"><label htmlFor="ol">მიწოდების ლოკაცია <span className="req">*</span></label>
          <select id="ol" className="select" value={h.location_id} onChange={(e) => setH({ ...h, location_id: e.target.value })}>
            <option value="">— აირჩიეთ —</option>{locs.data?.filter((l) => l.kind !== 'transit').map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>
        <div className="field"><label htmlFor="od">თარიღი</label><input id="od" className="input mono" type="date" max={todayISO()} value={h.order_date} onChange={(e) => setH({ ...h, order_date: e.target.value })} /></div>
        <div className="field"><label htmlFor="oe">მოსალოდნელი მიწოდება</label><input id="oe" className="input mono" type="date" min={h.order_date} value={h.expected_date} onChange={(e) => setH({ ...h, expected_date: e.target.value })} />
          {sup?.lead_time_days ? <span className="small muted">მიწოდების ვადა: {sup.lead_time_days} დღე</span> : null}</div>
        <div className="field"><label htmlFor="oc">ვალუტა</label>
          <div className="row" style={{ gap: 6 }}><select id="oc" className="select" style={{ width: 90 }} value={h.currency} onChange={(e) => setH({ ...h, currency: e.target.value as Currency })}>
            <option value="GEL">₾ GEL</option><option value="USD">$ USD</option><option value="EUR">€ EUR</option></select>
            {h.currency !== 'GEL' && <input className="input mono" style={{ width: 110 }} aria-label="კურსი" inputMode="decimal" placeholder="1 = ? ₾" value={h.fx_rate} onChange={(e) => setH({ ...h, fx_rate: e.target.value })} />}</div></div>
        <label className="row" style={{ alignSelf: 'end', height: 44 }}><input type="checkbox" checked={h.prices_include_vat} onChange={(e) => setH({ ...h, prices_include_vat: e.target.checked })} /> ფასები დღგ-ის ჩათვლით</label>
        <div className="field"><label htmlFor="oct">ხელშეკრულება</label><input id="oct" className="input" value={h.contract_no} onChange={(e) => setH({ ...h, contract_no: e.target.value })} /></div>
        <div className="field"><label htmlFor="on">შენიშვნა</label><input id="on" className="input" value={h.notes} onChange={(e) => setH({ ...h, notes: e.target.value })} /></div>
      </section>
      <section className="card card-pad"><ItemSearch placeholder={h.supplier_id ? 'საქონლის დამატება (ფასი — მომწოდებლის ფასთა ნუსხიდან)' : 'ჯერ აირჩიეთ მომწოდებელი'} disabled={!h.supplier_id} onPick={(i) => void addItem(i)} /></section>
      <section className="card" style={{ overflowX: 'auto' }}>
        <table className="table">
          <thead><tr><th>#</th><th>საქონელი</th><th>ერთეული</th><th className="num">რაოდ.</th><th className="num">ფასი ({cur}, {h.prices_include_vat ? 'დღგ-ით' : 'დღგ-ს გ.'})</th><th>დღგ</th><th className="num">ჯამი</th><th /></tr></thead>
          <tbody>{lines.map((l, i) => {
            const per = l.pack_id ? Number(l.item.packs.find((p) => p.id === l.pack_id)?.qty_base ?? 1) : 1;
            return (
              <tr key={l.key}>
                <td className="mono small">{i + 1}</td>
                <td><strong>{l.item.name}</strong> <span className="mono small muted">{l.item.code}</span>{l.pr_no && <div className="small muted">მოთხოვნა {l.pr_no}</div>}</td>
                <td><select className="select" style={{ height: 34, minWidth: 140 }} aria-label="ერთეული" value={l.pack_id} disabled={!!l.requisition_line_id && !l.item.packs.length} onChange={(e) => upd(l.key, { pack_id: e.target.value })}>
                  <option value="">{l.item.base_unit_name}</option>{l.item.packs.map((p) => <option key={p.id} value={p.id}>{p.name} ({qtyFmt(p.qty_base)})</option>)}</select>
                  {per > 1 && <div className="small muted">= {qtyFmt(num(l.qty) * per)} {l.item.base_unit_name}</div>}</td>
                <td><input className="input mono num" style={{ height: 34, width: 80 }} aria-label="რაოდენობა" inputMode="decimal" value={l.qty} onChange={(e) => upd(l.key, { qty: e.target.value })} /></td>
                <td><input className="input mono num" style={{ height: 34, width: 100 }} aria-label="ფასი" inputMode="decimal" value={l.price} onChange={(e) => upd(l.key, { price: e.target.value })} /></td>
                <td><select className="select" style={{ height: 34, width: 72 }} aria-label="დღგ" value={l.vat_rate} onChange={(e) => upd(l.key, { vat_rate: Number(e.target.value) })}><option value={18}>18%</option><option value={0}>0%</option></select></td>
                <td className="num mono">{l.price ? fmt(num(l.price) * num(l.qty)) : '—'}</td>
                <td><button className="icon-btn" type="button" aria-label="ხაზის წაშლა" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>×</button></td>
              </tr>);
          })}
            {!lines.length && <tr><td colSpan={8} className="muted">დაამატეთ საქონელი (ან შექმენით შეკვეთა დამტკიცებული შესყიდვის მოთხოვნიდან)</td></tr>}
          </tbody>
        </table>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 18, padding: '10px 16px', flexWrap: 'wrap' }}>
          <span>დღგ-ს გარეშე: <strong className="mono">{fmt(t.net)} {cur}</strong></span><span>დღგ: <strong className="mono">{fmt(t.vat)} {cur}</strong></span>
          <span>სულ: <strong className="mono">{fmt(t.net + t.vat)} {cur}</strong></span>{h.currency !== 'GEL' && fx > 0 && <span className="muted">≈ {fmt(t.net * fx)} ₾ (დღგ-ს გ.)</span>}
        </div>
      </section>
      {over && <div className="alert info">შეკვეთა შესყიდვის მოთხოვნის გარეშეა და ზღვარს ({rules!.pr_finance_threshold} ₾) აჭარბებს — გაგზავნამდე საჭიროა ფინანსური დამტკიცება.</div>}
      <ErrorBox error={save.error ?? cancel.error} />
    </>
  );
}
const shift = (iso: string, days: number) => { const x = new Date(`${iso}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + days); return x.toISOString().slice(0, 10); };

function PoView({ d, onClose, onDone }: { d: Po; onClose: () => void; onDone: (r: Po, msg?: string) => void }) {
  const { user } = useAuth(); const nav = useNavigate(); const qc = useQueryClient();
  const act = useMutation({ mutationFn: (a: { path: string; body?: unknown; msg?: string }) => api<Po>(`/procurement/orders/${d.id}/${a.path}`, { body: a.body ?? {} }), onSuccess: (r, a) => onDone(r, a.msg) });
  const rc = useMutation({ mutationFn: () => api<{ id: string }>(`/procurement/orders/${d.id}/receipt`, { method: 'POST' }),
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ['stock-docs'] }); nav(`/stock/receipts?doc=${r.id}`); } });
  const ask = (m: string) => { const v = prompt(m); return v && v.trim().length >= 3 ? v.trim() : null; };
  const cur = CUR_SIGN[d.currency]; const open = ['sent', 'partial'].includes(d.status);
  const canApprove = d.status === 'pending' && can(user, 'admin', 'procurement_approve') && (d.created_by !== user?.id || can(user, 'admin'));
  return (
    <>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button className="btn" type="button" onClick={onClose}>← სია</button>
        <h2 className="grow" style={{ margin: 0 }}>შეკვეთა <span className="mono">{d.po_no ?? ''}</span> <span className={`chip ${PO_STATUS[d.status as PoStatus][0]}`}>{PO_STATUS[d.status as PoStatus][1]}</span>
          {d.overdue && <span className="chip danger" style={{ marginLeft: 6 }}>ვადაგადაცილებული</span>}</h2>
        <button className="btn" type="button" onClick={() => printPo(d)}>ბეჭდვა</button>
        {canApprove && <>
          <button className="btn" type="button" disabled={act.isPending} onClick={() => { const v = ask('დაბრუნების მიზეზი'); if (v) act.mutate({ path: 'return', body: { reason: v }, msg: 'დაბრუნდა' }); }}>დაბრუნება</button>
          <button className="btn primary" type="button" disabled={act.isPending} onClick={() => act.mutate({ path: 'approve', msg: 'დამტკიცდა და გაიგზავნა' })}>დამტკიცება</button></>}
        {can(user, ...PO_EDIT) && ['pending', 'sent'].includes(d.status) && !d.receipts.length &&
          <button className="btn" type="button" disabled={act.isPending} onClick={() => { const v = ask('გაუქმების მიზეზი'); if (v) act.mutate({ path: 'cancel', body: { reason: v } }); }}>გაუქმება</button>}
        {can(user, ...PO_EDIT) && open && d.receipts.length > 0 &&
          <button className="btn" type="button" disabled={act.isPending} onClick={() => { const v = ask('დახურვის მიზეზი (დარჩენილი აღარ მოვა)'); if (v) act.mutate({ path: 'close', body: { reason: v } }); }}>დახურვა</button>}
        {can(user, ...RECEIPT_EDIT) && open && <button className="btn primary" type="button" disabled={rc.isPending} onClick={() => rc.mutate()}>მიღება (RC)</button>}
      </div>
      <section className="card card-pad" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
        <div><span className="small muted">მომწოდებელი</span><div><strong>{d.supplier_name}</strong>{d.supplier_tax_id && <span className="mono small muted"> · {d.supplier_tax_id}</span>}</div></div>
        <div><span className="small muted">მიწოდება</span><div>{d.location_name}</div></div>
        <div><span className="small muted">თარიღი / მოსალოდნელი</span><div className="mono">{dateGe(d.order_date)} → <span style={d.overdue ? { color: 'var(--danger-ink)' } : undefined}>{d.expected_date ? dateGe(d.expected_date) : '—'}</span></div></div>
        <div><span className="small muted">ჯამი</span><div className="mono"><strong>{fmt(Number(d.total_net) + Number(d.total_vat))} {cur}</strong>{d.currency !== 'GEL' && <span className="small muted"> · კურსი {Number(d.fx_rate)} · ≈ {fmt(d.total_gel)} ₾</span>}</div></div>
        <div><span className="small muted">ავტორი</span><div className="small">{d.created_by_name}</div></div>
        <div><span className="small muted">გაგზავნა</span><div className="small">{d.sent_by_name ? `${d.sent_by_name} · ${tsDate(d.sent_at!)}` : '—'}</div></div>
        <div><span className="small muted">ფინანსური დამტკიცება</span><div className="small">{!d.needs_approval ? 'არ სჭირდება' : d.approved_by_name ? `${d.approved_by_name} · ${tsDate(d.approved_at!)}` : 'ელოდება'}</div></div>
        <div><span className="small muted">ხელშეკრულება</span><div className="small">{d.contract_no ?? '—'}</div></div>
        {d.reason && <div style={{ gridColumn: 'span 2' }}><span className="small muted">მიზეზი</span><div className="small">{d.reason}{d.closed_by_name && ` — ${d.closed_by_name}`}</div></div>}
        {d.notes && <div style={{ gridColumn: 'span 2' }}><span className="small muted">შენიშვნა</span><div className="small">{d.notes}</div></div>}
      </section>
      <section className="card" style={{ overflowX: 'auto' }}>
        <table className="table">
          <thead><tr><th>#</th><th>საქონელი</th><th className="num">შეკვეთილი</th><th className="num">ფასი ({cur})</th><th className="num">ჯამი</th><th className="num">მიღებული</th><th>მოთხოვნა</th></tr></thead>
          <tbody>{d.lines.map((l) => {
            const got = Number(l.qty_received); const all = Number(l.qty_base);
            return (
              <tr key={l.id}>
                <td className="mono small">{l.line_no}</td><td><strong>{l.item_name}</strong> <span className="mono small muted">{l.item_code}</span></td>
                <td className="num">{qtyFmt(l.qty)} {l.pack_name ?? l.base_unit_name}{l.pack_name && <div className="small muted">= {qtyFmt(l.qty_base)} {l.base_unit_name}</div>}</td>
                <td className="num mono">{fmt(l.price, 4)}<div className="small muted">დღგ {Number(l.vat_rate)}%</div></td><td className="num mono">{fmt(Number(l.line_net) + Number(l.line_vat))}</td>
                <td className="num">{got >= all ? <span className="chip ok">✓ {qtyFmt(got)}</span> : got > 0 ? <span className="chip warn">{qtyFmt(got)} / {qtyFmt(all)}</span> : <span className="muted">0 / {qtyFmt(all)}</span>}</td>
                <td>{l.pr_no ? <a href={`/procurement/requisitions?id=${l.requisition_id}`} onClick={(e) => { e.preventDefault(); nav(`/procurement/requisitions?id=${l.requisition_id}`); }} className="mono small">{l.pr_no}</a> : <span className="muted small">—</span>}</td>
              </tr>);
          })}</tbody>
        </table>
      </section>
      <section className="card card-pad stack" style={{ gap: 6 }}>
        <strong>მიღებები (RC)</strong>
        {d.receipts.map((r) => <a key={r.id} href={`/stock/receipts?doc=${r.id}`} onClick={(e) => { e.preventDefault(); nav(`/stock/receipts?doc=${r.id}`); }} className="row small" style={{ gap: 10 }}>
          <span className="mono">{r.doc_no ?? 'მონახაზი'}</span><span className="mono">{dateGe(r.doc_date)}</span><span className="mono">{fmt(Number(r.total_net) + Number(r.total_vat))} ₾</span>
          {r.invoice_no && <span>ფაქტურა {r.invoice_no}</span>}{r.status === 'draft' && <span className="chip warn">მონახაზი</span>}{r.reversed_by_no && <span className="chip">შემობრუნდა {r.reversed_by_no}</span>}</a>)}
        {!d.receipts.length && <span className="small muted">მიღება ჯერ არ ყოფილა</span>}
      </section>
      <ErrorBox error={act.error ?? rc.error} />
    </>
  );
}

/** ბეჭდვა / PDF ბრაუზერიდან — მომწოდებლისთვის გასაგზავნი ფორმა */
function printPo(d: Po) {
  const cur = CUR_SIGN[d.currency]; const e = (s: string | null | undefined) => (s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  const rows = d.lines.map((l) => `<tr><td>${l.line_no}</td><td>${e(l.item_name)}<br><small>${e(l.item_code)}</small></td><td class="n">${qtyFmt(l.qty)} ${e(l.pack_name ?? l.base_unit_name)}</td><td class="n">${fmt(l.price, 4)}</td><td class="n">${Number(l.vat_rate)}%</td><td class="n">${fmt(Number(l.line_net) + Number(l.line_vat))}</td></tr>`).join('');
  const w = window.open('', '_blank', 'width=900,height=1000');
  if (!w) return;
  w.document.write(`<!doctype html><html lang="ka"><head><meta charset="utf-8"><title>${e(d.po_no)}</title><style>
    body{font:13px/1.45 system-ui,sans-serif;margin:32px;color:#111} h1{font-size:20px;margin:0 0 4px} table{width:100%;border-collapse:collapse;margin-top:16px}
    th,td{border:1px solid #bbb;padding:6px 8px;text-align:left;vertical-align:top} th{background:#f2f2f2} .n{text-align:right;white-space:nowrap} .g{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:16px}
    .t{margin-top:12px;text-align:right} .s{margin-top:48px;display:grid;grid-template-columns:1fr 1fr;gap:48px} .s div{border-top:1px solid #111;padding-top:4px}
  </style></head><body>
    <h1>შეკვეთა ${e(d.po_no)}</h1><div>თარიღი: ${dateGe(d.order_date)}${d.expected_date ? ` · მოსალოდნელი მიწოდება: ${dateGe(d.expected_date)}` : ''}${d.contract_no ? ` · ხელშეკრულება: ${e(d.contract_no)}` : ''}</div>
    <div class="g"><div><strong>მომწოდებელი</strong><br>${e(d.supplier_name)}${d.supplier_tax_id ? `<br>ს/კ ${e(d.supplier_tax_id)}` : ''}${d.supplier_address ? `<br>${e(d.supplier_address)}` : ''}${d.supplier_contact ? `<br>${e(d.supplier_contact)}` : ''}${d.supplier_phone ? `<br>${e(d.supplier_phone)}` : ''}</div>
      <div><strong>მიწოდების ადგილი</strong><br>${e(d.location_name)}</div></div>
    <table><thead><tr><th>#</th><th>დასახელება</th><th class="n">რაოდენობა</th><th class="n">ფასი (${cur}, ${d.prices_include_vat ? 'დღგ-ით' : 'დღგ-ს გ.'})</th><th class="n">დღგ</th><th class="n">ჯამი (${cur})</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="t">დღგ-ს გარეშე: <b>${fmt(d.total_net)} ${cur}</b> · დღგ: <b>${fmt(d.total_vat)} ${cur}</b> · სულ: <b>${fmt(Number(d.total_net) + Number(d.total_vat))} ${cur}</b></div>
    ${d.notes ? `<p>${e(d.notes)}</p>` : ''}
    <div class="s"><div>შეკვეთა გასცა: ${e(d.sent_by_name ?? d.created_by_name)}</div><div>მომწოდებელი</div></div>
    <script>window.onload=()=>window.print()</script></body></html>`);
  w.document.close();
}
