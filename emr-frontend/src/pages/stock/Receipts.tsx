import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError, can, type Role } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Loading, Spinner, useDebounced, useToast } from '../../components/ui';
import { dateGe, todayISO, tsDate } from '../../lib/format';
import {
  DOC_STATUS, DOC_TYPE_KA, money2, qtyFmt, RECEIPT_EDIT_ROLES, REVERSE_ROLES, useStockRefs,
  type DocIssue, type StockDoc, type StockDocRow, type StockItem, type StockLocation, type Supplier,
} from './types';

/** მიღება: სია ↔ დოკუმენტი (?doc=new | ?doc=<id>) */
export default function Receipts() {
  const [sp, setSp] = useSearchParams();
  const doc = sp.get('doc');
  if (doc) return <ReceiptEditor id={doc === 'new' ? null : doc} onClose={() => setSp({})} onOpen={(id) => setSp({ doc: id })} />;
  return <ReceiptList onOpen={(id) => setSp({ doc: id })} />;
}

function ReceiptList({ onOpen }: { onOpen: (id: string) => void }) {
  const { user } = useAuth();
  const [f, setF] = useState({ status: '', location_id: '', from: '', to: '', search: '' });
  const ds = useDebounced(f.search.trim(), 300);
  const locs = useQuery({ queryKey: ['stock-locations', false], queryFn: () => api<StockLocation[]>('/stock/locations') });
  const q = useQuery({ queryKey: ['stock-docs', f.status, f.location_id, f.from, f.to, ds], queryFn: () => api<StockDocRow[]>('/stock/docs', { query: { ...f, search: ds } }) });
  return (
    <div className="content">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <input className="input" style={{ maxWidth: 260, height: 38 }} aria-label="ძებნა" placeholder="№, ზედნადები, მომწოდებელი" value={f.search} onChange={(e) => setF({ ...f, search: e.target.value })} />
        <select className="select" style={{ maxWidth: 170, height: 38 }} aria-label="სტატუსი" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
          <option value="">ყველა სტატუსი</option><option value="draft">მონახაზი</option><option value="posted">გატარებული</option><option value="cancelled">გაუქმებული</option>
        </select>
        <select className="select" style={{ maxWidth: 220, height: 38 }} aria-label="ლოკაცია" value={f.location_id} onChange={(e) => setF({ ...f, location_id: e.target.value })}>
          <option value="">ყველა ლოკაცია</option>{locs.data?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <input className="input mono" type="date" style={{ maxWidth: 160, height: 38 }} aria-label="დან" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        <input className="input mono" type="date" style={{ maxWidth: 160, height: 38 }} aria-label="მდე" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
        <span className="grow" />
        {can(user, ...(RECEIPT_EDIT_ROLES as unknown as Role[])) && <button className="btn primary" type="button" onClick={() => onOpen('new')}>+ მიღება</button>}
      </div>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : (
        <div className="card">
          <table className="table">
            <thead><tr><th>№</th><th>თარიღი</th><th>ტიპი</th><th>ლოკაცია</th><th>მომწოდებელი</th><th>ზედნადები</th><th className="num">ხაზი</th><th className="num">ჯამი (დღგ-ს გარეშე)</th><th className="num">დღგ</th><th>სტატუსი</th></tr></thead>
            <tbody>{q.data?.map((d) => (
              <tr key={d.id} className="clickable" onClick={() => onOpen(d.id)}>
                <td className="mono">{d.doc_no ?? '—'}</td><td className="mono">{dateGe(d.doc_date)}</td><td>{DOC_TYPE_KA[d.doc_type] ?? d.doc_type}</td>
                <td>{d.location_name ?? '—'}</td><td>{d.supplier_name ?? '—'}</td><td className="small">{[d.invoice_no, d.waybill_no].filter(Boolean).join(' · ') || '—'}</td>
                <td className="num">{d.lines}</td><td className="num mono">{Number(d.total_net).toFixed(2)}</td><td className="num mono">{Number(d.total_vat).toFixed(2)}</td>
                <td><span className={`chip ${DOC_STATUS[d.status][0]}`}>{DOC_STATUS[d.status][1]}</span>{d.reversed_by_no && <span className="chip" style={{ marginLeft: 4 }}>შემობრუნდა {d.reversed_by_no}</span>}</td>
              </tr>))}
              {!q.data?.length && <tr><td colSpan={10} className="muted">დოკუმენტი არ არის</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- რედაქტორი
interface Line {
  key: string; item: Pick<StockItem, 'id' | 'name' | 'code' | 'requires_lot' | 'requires_expiry' | 'serial_tracked' | 'base_unit_name' | 'packs' | 'controlled_class'>;
  pack_id: string; qty: string; lot_no: string; serial_no: string; expires_on: string; price: string; vat_rate: number; short_expiry_reason: string;
}
interface ScanResult { parsed: { lot: string | null; serial: string | null; expiry: string | null }; item: StockItem | null; pack: { id: string } | null; warnings: string[] }
let seq = 0;
const lineFromItem = (it: Line['item'], vat: number, extra: Partial<Line> = {}): Line => ({
  key: `l${++seq}`, item: it, pack_id: (it.packs.find((p) => p.is_receipt_default) ?? null)?.id ?? '', qty: '1', lot_no: '', serial_no: '', expires_on: '', price: '', vat_rate: vat, short_expiry_reason: '', ...extra,
});
const addMonths = (iso: string, m: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + m); return d.toISOString().slice(0, 10); };
const n = (s: string) => Number(s.replace(',', '.'));

function ReceiptEditor({ id, onClose, onOpen }: { id: string | null; onClose: () => void; onOpen: (id: string) => void }) {
  const { user } = useAuth(); const qc = useQueryClient(); const toast = useToast(); const refs = useStockRefs();
  const q = useQuery({ queryKey: ['stock-doc', id], queryFn: () => api<StockDoc>(`/stock/docs/${id}`), enabled: !!id });
  const d = q.data;
  if (id && (q.isLoading || !refs.data)) return <div className="content"><Loading /></div>;
  if (id && q.error) return <div className="content"><ErrorBox error={q.error} /><button className="btn" type="button" onClick={onClose}>← სია</button></div>;
  const editable = (!d || d.status === 'draft') && can(user, ...(RECEIPT_EDIT_ROLES as unknown as Role[]));
  return (
    <div className="content">
      {toast.node}
      {d && d.status !== 'draft' ? <ReceiptView d={d} onClose={onClose} onOpen={onOpen} />
        : <ReceiptForm key={d?.id ?? 'new'} d={d ?? null} editable={editable} onClose={onClose}
          onSaved={(r, posted) => { void qc.invalidateQueries({ queryKey: ['stock-docs'] }); void qc.invalidateQueries({ queryKey: ['stock-balances'] }); qc.setQueryData(['stock-doc', r.id], r);
            if (posted) toast.show(`გატარდა: ${r.doc_no}`); if (!id) onOpen(r.id); }} />}
    </div>
  );
}

function ReceiptForm({ d, editable, onClose, onSaved }: { d: StockDoc | null; editable: boolean; onClose: () => void; onSaved: (d: StockDoc, posted: boolean) => void }) {
  const { user } = useAuth(); const refs = useStockRefs();
  const locs = useQuery({ queryKey: ['stock-locations', false], queryFn: () => api<StockLocation[]>('/stock/locations') });
  const sups = useQuery({ queryKey: ['stock-suppliers', '', false], queryFn: () => api<Supplier[]>('/stock/suppliers') });
  const pharmOnly = !can(user, 'admin', 'storekeeper', 'stock_manager');
  const today = todayISO();
  const [h, setH] = useState({
    location_id: d?.location_id ?? '', supplier_id: d?.supplier_id ?? '', doc_date: d?.doc_date ?? today, invoice_no: d?.invoice_no ?? '', invoice_date: d?.invoice_date ?? '',
    waybill_no: d?.waybill_no ?? '', prices_include_vat: d?.prices_include_vat ?? true, notes: d?.notes ?? '',
  });
  const [lines, setLines] = useState<Line[]>(() => (d?.lines ?? []).map((l) => ({
    key: `l${++seq}`, item: { id: l.item_id, name: l.item_name, code: l.item_code, requires_lot: l.requires_lot, requires_expiry: l.requires_expiry, serial_tracked: l.serial_tracked,
      base_unit_name: l.base_unit_name, packs: [], controlled_class: l.controlled_class }, pack_id: l.pack_id ?? '', qty: qtyFmt(l.qty), lot_no: l.lot_no ?? '', serial_no: l.serial_no ?? '',
    expires_on: l.expires_on ?? '', price: l.price === null ? '' : String(Number(l.price)), vat_rate: Number(l.vat_rate), short_expiry_reason: l.short_expiry_reason ?? '',
  })));
  // შეფუთვების ჩატვირთვა არსებული ხაზებისთვის
  const itemIds = useMemo(() => [...new Set(lines.filter((l) => !l.item.packs.length).map((l) => l.item.id))], [lines]);
  useQuery({
    queryKey: ['stock-items-packs', itemIds.join(',')], enabled: itemIds.length > 0,
    queryFn: async () => {
      const all = await Promise.all(itemIds.map((x) => api<StockItem>(`/stock/items/${x}`)));
      setLines((ls) => ls.map((l) => { const it = all.find((a) => a.id === l.item.id); return it ? { ...l, item: { ...l.item, packs: it.packs } } : l; }));
      return true;
    },
  });
  const [issues, setIssues] = useState<DocIssue[]>(d?.issues ?? []);
  const sup = sups.data?.find((s) => s.id === h.supplier_id);
  const defVat = sup ? (sup.vat_payer ? 18 : 0) : 18;
  const shortMonths = refs.data?.settings.short_expiry_months ?? 6;
  const shortLimit = addMonths(h.doc_date || today, shortMonths);
  const upd = (key: string, p: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...p } : l)));

  // სკანირება
  const [code, setCode] = useState(''); const [scanMsg, setScanMsg] = useState<string | null>(null);
  const scan = useMutation({
    mutationFn: (c: string) => api<ScanResult>('/stock/scan', { body: { code: c } }),
    onSuccess: (r) => {
      if (!r.item) { setScanMsg(r.warnings.join('; ') || 'ვერ მოიძებნა'); return; }
      if (!r.item.is_active) { setScanMsg(`„${r.item.name}“ გათიშულია`); return; }
      const it = r.item; const packId = r.pack?.id ?? (it.packs.find((p) => p.is_receipt_default)?.id ?? '');
      const lot = (r.parsed.lot ?? '').toUpperCase(); const exp = r.parsed.expiry ?? ''; const serial = (r.parsed.serial ?? '').toUpperCase();
      setScanMsg(r.warnings.filter((w) => !/კოდში არ არის/.test(w)).join('; ') || null);
      setLines((ls) => {
        const same = !it.serial_tracked && ls.find((l) => l.item.id === it.id && l.pack_id === packId && l.lot_no === lot && l.expires_on === exp);
        if (same) return ls.map((l) => (l === same ? { ...l, qty: String(n(l.qty) + 1) } : l));
        if (it.serial_tracked && serial && ls.some((l) => l.item.id === it.id && l.serial_no === serial)) { setScanMsg(`სერიული ${serial} უკვე დამატებულია`); return ls; }
        return [...ls, lineFromItem(it, defVat, { pack_id: packId, lot_no: lot, expires_on: exp, serial_no: serial })];
      });
    },
  });
  // ხელით დამატება
  const [search, setSearch] = useState(''); const dsearch = useDebounced(search.trim(), 250);
  const found = useQuery({ queryKey: ['stock-items', 'pick', dsearch], queryFn: () => api<StockItem[]>('/stock/items', { query: { search: dsearch, limit: 20 } }), enabled: dsearch.length >= 2 });

  const body = () => ({
    location_id: h.location_id, supplier_id: h.supplier_id || null, doc_date: h.doc_date, invoice_no: h.invoice_no || null, invoice_date: h.invoice_date || null,
    waybill_no: h.waybill_no || null, prices_include_vat: h.prices_include_vat, notes: h.notes || null,
    lines: lines.map((l) => ({
      item_id: l.item.id, pack_id: l.pack_id || null, qty: n(l.qty), lot_no: l.lot_no || null, serial_no: l.serial_no || null, expires_on: l.expires_on || null,
      price: l.price.trim() === '' ? null : n(l.price), vat_rate: l.vat_rate, short_expiry_reason: l.short_expiry_reason || null,
    })),
  });
  const save = useMutation({
    mutationFn: async (post: boolean) => {
      let r = d ? await api<StockDoc>(`/stock/receipts/${d.id}`, { method: 'PUT', body: body() }) : await api<StockDoc>('/stock/receipts', { body: body() });
      setIssues(r.issues);
      if (post) {
        if (r.issues.some((i) => i.level === 'error')) { onSaved(r, false); throw new Error('გატარება შეუძლებელია — გაასწორეთ შეცდომები (იხ. ქვემოთ)'); }
        r = await api<StockDoc>(`/stock/receipts/${r.id}/post`, { method: 'POST' });
      }
      return { r, post };
    },
    onSuccess: ({ r, post }) => onSaved(r, post),
    onError: (e) => { if (e instanceof ApiError && Array.isArray(e.body?.issues)) setIssues(e.body.issues as DocIssue[]); },
  });
  const cancel = useMutation({ mutationFn: () => api<StockDoc>(`/stock/docs/${d!.id}/cancel`, { body: { reason: 'მონახაზი გაუქმდა' } }), onSuccess: (r) => onSaved({ ...r, issues: [] }, false) });

  const total = lines.reduce((a, l) => {
    if (l.price.trim() === '') return a;
    const gross = h.prices_include_vat ? n(l.price) * n(l.qty) : n(l.price) * n(l.qty) * (1 + l.vat_rate / 100);
    const net = h.prices_include_vat ? gross / (1 + l.vat_rate / 100) : n(l.price) * n(l.qty);
    return { net: a.net + net, vat: a.vat + (gross - net) };
  }, { net: 0, vat: 0 });
  const locOptions = (locs.data ?? []).filter((l) => !pharmOnly || l.kind === 'pharmacy');
  const lineIssues = (no: number) => issues.filter((i) => i.line_no === no);
  const valid = h.location_id && lines.every((l) => n(l.qty) > 0);

  return (
    <>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button className="btn" type="button" onClick={onClose}>← სია</button>
        <h2 className="grow" style={{ margin: 0 }}>{d ? 'მიღება — მონახაზი' : 'ახალი მიღება'}</h2>
        {d && editable && <button className="btn" type="button" disabled={cancel.isPending} onClick={() => { if (confirm('გავაუქმოთ მონახაზი?')) cancel.mutate(); }}>მონახაზის გაუქმება</button>}
        {editable && <button className="btn" type="button" disabled={!valid || save.isPending} onClick={() => save.mutate(false)}>შენახვა</button>}
        {editable && <button className="btn primary" type="button" disabled={!valid || !lines.length || save.isPending}
          onClick={() => { if (confirm('გავატაროთ? გატარებული დოკუმენტი აღარ შეიცვლება (მხოლოდ შემობრუნებით).')) save.mutate(true); }}>გატარება</button>}
      </div>
      <section className="card card-pad">
        <fieldset disabled={!editable} style={{ border: 0, padding: 0, margin: 0, display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12 }}>
          <div className="field"><label htmlFor="rl">ლოკაცია <span className="req">*</span></label>
            <select id="rl" className="select" value={h.location_id} onChange={(e) => setH({ ...h, location_id: e.target.value })}>
              <option value="">— აირჩიეთ —</option>{locOptions.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select></div>
          <div className="field"><label htmlFor="rs">მომწოდებელი</label>
            <select id="rs" className="select" value={h.supplier_id} onChange={(e) => { const s = sups.data?.find((x) => x.id === e.target.value); setH({ ...h, supplier_id: e.target.value });
              if (s) setLines((ls) => ls.map((l) => ({ ...l, vat_rate: l.price.trim() === '' ? (s.vat_payer ? 18 : 0) : l.vat_rate }))); }}>
              <option value="">—</option>{sups.data?.map((s) => <option key={s.id} value={s.id}>{s.name}{s.tax_id ? ` (${s.tax_id})` : ''}</option>)}
            </select></div>
          <div className="field"><label htmlFor="rd">თარიღი</label><input id="rd" className="input mono" type="date" max={today} value={h.doc_date} onChange={(e) => setH({ ...h, doc_date: e.target.value })} /></div>
          <label className="row" style={{ alignSelf: 'end', height: 44 }}><input type="checkbox" checked={h.prices_include_vat} onChange={(e) => setH({ ...h, prices_include_vat: e.target.checked })} /> ფასები დღგ-ის ჩათვლით</label>
          <div className="field"><label htmlFor="ri">ანგარიშ-ფაქტურა №</label><input id="ri" className="input" value={h.invoice_no} onChange={(e) => setH({ ...h, invoice_no: e.target.value })} /></div>
          <div className="field"><label htmlFor="rid">ფაქტურის თარიღი</label><input id="rid" className="input mono" type="date" value={h.invoice_date} onChange={(e) => setH({ ...h, invoice_date: e.target.value })} /></div>
          <div className="field"><label htmlFor="rw">ზედნადები № (RS.ge)</label><input id="rw" className="input mono" value={h.waybill_no} onChange={(e) => setH({ ...h, waybill_no: e.target.value })} /></div>
          <div className="field"><label htmlFor="rn">შენიშვნა</label><input id="rn" className="input" value={h.notes} onChange={(e) => setH({ ...h, notes: e.target.value })} /></div>
        </fieldset>
      </section>

      {editable && (
        <section className="card card-pad stack" style={{ gap: 8 }}>
          <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <form className="row grow" style={{ minWidth: 320 }} onSubmit={(e) => { e.preventDefault(); if (code.trim()) scan.mutate(code); setCode(''); }}>
              <label htmlFor="rscan" className="label" style={{ whiteSpace: 'nowrap' }}>სკანირება</label>
              <input id="rscan" className="input mono" style={{ height: 38 }} autoComplete="off" autoFocus placeholder="DataMatrix / EAN → Enter (ლოტი, ვადა, სერიული — ავტომატურად)" value={code} onChange={(e) => setCode(e.target.value)} />
              {scan.isPending && <Spinner />}
            </form>
            <div className="stack grow" style={{ gap: 0, minWidth: 320, position: 'relative' }}>
              <input className="input" style={{ height: 38 }} aria-label="საქონლის ძებნა" placeholder="ან ძებნა: დასახელება, INN, კოდი" value={search} onChange={(e) => setSearch(e.target.value)} />
              {dsearch.length >= 2 && (found.data?.length ?? 0) > 0 && (
                <ul className="listbox" role="listbox" aria-label="საქონელი" style={{ position: 'absolute', top: 40, left: 0, right: 0, zIndex: 5 }}>
                  {found.data!.filter((i) => i.is_active).map((i) => <li key={i.id} role="option" aria-selected={false} onMouseDown={(e) => { e.preventDefault(); setLines((ls) => [...ls, lineFromItem(i, defVat)]); setSearch(''); }}>
                    <span className="grow">{i.name}{i.inn && <span className="small muted"> · {i.inn}{i.strength ? ` ${i.strength}` : ''}</span>}</span><span className="mono small muted">{i.code}</span></li>)}
                </ul>)}
            </div>
          </div>
          {scanMsg && <div className="alert warn">{scanMsg}</div>}
          <ErrorBox error={scan.error} />
        </section>
      )}

      <section className="card" style={{ overflowX: 'auto' }}>
        <table className="table">
          <thead><tr><th>#</th><th>საქონელი</th><th>ერთეული</th><th className="num">რაოდ.</th><th>ლოტი</th><th>ვადა</th><th>სერიული</th><th className="num">ფასი</th><th>დღგ</th><th className="num">ჯამი</th><th /></tr></thead>
          <tbody>{lines.map((l, i) => {
            const short = l.expires_on && l.expires_on >= (h.doc_date || today) && l.expires_on < shortLimit;
            const expired = l.expires_on && l.expires_on < (h.doc_date || today);
            const errs = lineIssues(i + 1);
            const sum = l.price.trim() === '' ? null : n(l.price) * n(l.qty);
            const per = l.pack_id ? Number(l.item.packs.find((p) => p.id === l.pack_id)?.qty_base ?? 1) : 1;
            return (
              <tr key={l.key} style={{ verticalAlign: 'top' }}>
                <td className="mono small">{i + 1}</td>
                <td style={{ minWidth: 180 }}><strong>{l.item.name}</strong><div className="small muted mono">{l.item.code}{l.item.controlled_class ? ' · კონტროლირებადი' : ''}</div>
                  {errs.map((x) => <div key={x.code} className={`small ${x.level === 'error' ? 'err' : 'muted'}`} style={{ color: x.level === 'error' ? 'var(--danger-ink)' : undefined }}>{x.message.replace(/^ხაზი \d+ \([^)]*\): /, '')}</div>)}</td>
                <td><select className="select" style={{ height: 34, minWidth: 150 }} aria-label="ერთეული" disabled={!editable} value={l.pack_id} onChange={(e) => upd(l.key, { pack_id: e.target.value })}>
                  <option value="">{l.item.base_unit_name}</option>{l.item.packs.map((p) => <option key={p.id} value={p.id}>{p.name} ({qtyFmt(p.qty_base)})</option>)}
                </select>{per > 1 && <div className="small muted">= {qtyFmt(n(l.qty) * per)} {l.item.base_unit_name}</div>}</td>
                <td><input className="input mono num" style={{ height: 34, width: 80 }} aria-label="რაოდენობა" inputMode="decimal" disabled={!editable || l.item.serial_tracked} value={l.qty} onChange={(e) => upd(l.key, { qty: e.target.value })} /></td>
                <td>{l.item.requires_lot ? <input className="input mono" style={{ height: 34, width: 110 }} aria-label="ლოტი" disabled={!editable} value={l.lot_no} onChange={(e) => upd(l.key, { lot_no: e.target.value.toUpperCase() })} /> : <span className="muted">—</span>}</td>
                <td>{l.item.requires_expiry ? <input className="input mono" style={{ height: 34, width: 140, ...(expired ? { borderColor: 'var(--danger-line)' } : short ? { borderColor: 'var(--warn-line)' } : {}) }} type="date" aria-label="ვადა" disabled={!editable} value={l.expires_on} onChange={(e) => upd(l.key, { expires_on: e.target.value })} /> : <span className="muted">—</span>}
                  {short && editable && <input className="input" style={{ height: 30, marginTop: 4, width: 140, fontSize: 13 }} aria-label="მოკლე ვადის მიზეზი" placeholder={`< ${shortMonths} თვე — მიზეზი`} value={l.short_expiry_reason} onChange={(e) => upd(l.key, { short_expiry_reason: e.target.value })} />}
                  {short && !editable && l.short_expiry_reason && <div className="small muted">{l.short_expiry_reason}</div>}</td>
                <td>{l.item.serial_tracked ? <input className="input mono" style={{ height: 34, width: 130 }} aria-label="სერიული" disabled={!editable} value={l.serial_no} onChange={(e) => upd(l.key, { serial_no: e.target.value.toUpperCase() })} /> : <span className="muted">—</span>}</td>
                <td><input className="input mono num" style={{ height: 34, width: 80 }} aria-label="ფასი" inputMode="decimal" disabled={!editable} placeholder={h.prices_include_vat ? 'დღგ-ით' : 'დღგ-ს გ.'} value={l.price} onChange={(e) => upd(l.key, { price: e.target.value })} /></td>
                <td><select className="select" style={{ height: 34, width: 72 }} aria-label="დღგ" disabled={!editable} value={l.vat_rate} onChange={(e) => upd(l.key, { vat_rate: Number(e.target.value) })}><option value={18}>18%</option><option value={0}>0%</option></select></td>
                <td className="num mono">{sum === null ? '—' : sum.toFixed(2)}</td>
                <td>{editable && <button className="icon-btn" type="button" aria-label="ხაზის წაშლა" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>×</button>}</td>
              </tr>);
          })}
            {!lines.length && <tr><td colSpan={11} className="muted">დაასკანერეთ ან მოძებნეთ საქონელი</td></tr>}
          </tbody>
        </table>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 18, padding: '10px 16px' }}>
          <span>დღგ-ს გარეშე: <strong className="mono">{total.net.toFixed(2)} ₾</strong></span><span>დღგ: <strong className="mono">{total.vat.toFixed(2)} ₾</strong></span>
          <span>სულ: <strong className="mono">{(total.net + total.vat).toFixed(2)} ₾</strong></span>
        </div>
      </section>
      {issues.filter((x) => x.line_no === 0).map((x) => <div key={x.code} className={`alert ${x.level === 'error' ? 'danger' : 'warn'}`}>{x.message}</div>)}
      <ErrorBox error={save.error ?? cancel.error} />
    </>
  );
}

function ReceiptView({ d, onClose, onOpen }: { d: StockDoc; onClose: () => void; onOpen: (id: string) => void }) {
  const { user } = useAuth(); const qc = useQueryClient();
  const rev = useMutation({
    mutationFn: (reason: string) => api<StockDoc>(`/stock/docs/${d.id}/reverse`, { body: { reason } }),
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ['stock-docs'] }); void qc.invalidateQueries({ queryKey: ['stock-doc', d.id] }); void qc.invalidateQueries({ queryKey: ['stock-balances'] }); onOpen(r.id); },
  });
  const canRev = d.status === 'posted' && d.doc_type === 'receipt' && !d.reversed_by && can(user, ...(REVERSE_ROLES as unknown as Role[]));
  return (
    <>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button className="btn" type="button" onClick={onClose}>← სია</button>
        <h2 className="grow" style={{ margin: 0 }}>{DOC_TYPE_KA[d.doc_type]} <span className="mono">{d.doc_no ?? ''}</span> <span className={`chip ${DOC_STATUS[d.status][0]}`}>{DOC_STATUS[d.status][1]}</span></h2>
        {canRev && <button className="btn" type="button" disabled={rev.isPending} onClick={() => { const r = prompt('შემობრუნების მიზეზი (ნაშთი და ფასი დაბრუნდება; დოკუმენტი რჩება ისტორიაში)'); if (r && r.trim().length >= 3) rev.mutate(r.trim()); }}>შემობრუნება</button>}
      </div>
      <section className="card card-pad" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
        <div><span className="small muted">თარიღი</span><div className="mono">{dateGe(d.doc_date)}</div></div>
        <div><span className="small muted">ლოკაცია</span><div>{d.location_name}</div></div>
        <div><span className="small muted">მომწოდებელი</span><div>{d.supplier_name ?? '—'}{d.supplier_tax_id && <span className="mono small muted"> · {d.supplier_tax_id}</span>}</div></div>
        <div><span className="small muted">ფაქტურა / ზედნადები</span><div className="small">{[d.invoice_no && `${d.invoice_no}${d.invoice_date ? ` (${dateGe(d.invoice_date)})` : ''}`, d.waybill_no].filter(Boolean).join(' · ') || '—'}</div></div>
        <div><span className="small muted">გაატარა</span><div className="small">{d.posted_by_name ?? '—'}{d.posted_at && ` · ${tsDate(d.posted_at)}`}</div></div>
        <div><span className="small muted">შექმნა</span><div className="small">{d.created_by_name}</div></div>
        {d.reversal_of_no && <div><span className="small muted">შემობრუნება</span><div className="mono">{d.reversal_of_no}</div></div>}
        {d.reversed_by_no && <div><span className="small muted">შემობრუნდა</span><div className="mono">{d.reversed_by_no}</div></div>}
        {d.reason && <div style={{ gridColumn: 'span 2' }}><span className="small muted">მიზეზი</span><div className="small">{d.reason}</div></div>}
        {d.notes && <div style={{ gridColumn: 'span 2' }}><span className="small muted">შენიშვნა</span><div className="small">{d.notes}</div></div>}
      </section>
      <section className="card" style={{ overflowX: 'auto' }}>
        <table className="table">
          <thead><tr><th>#</th><th>საქონელი</th><th className="num">რაოდენობა</th><th>ლოტი</th><th>ვადა</th><th>სერიული</th><th className="num">ერთ. ფასი (დღგ-ს გ.)</th><th className="num">ჯამი</th><th className="num">დღგ</th></tr></thead>
          <tbody>{d.lines.map((l) => (
            <tr key={l.id}>
              <td className="mono small">{l.line_no}</td><td><strong>{l.item_name}</strong> <span className="mono small muted">{l.item_code}</span>{l.short_expiry_reason && <div className="small muted">მოკლე ვადა: {l.short_expiry_reason}</div>}</td>
              <td className="num">{qtyFmt(l.qty)} {l.pack_name ?? l.base_unit_name}{l.pack_name && <div className="small muted">= {qtyFmt(l.qty_base)} {l.base_unit_name}</div>}</td>
              <td className="mono">{l.lot_no ?? '—'}</td><td className="mono">{l.expires_on ? dateGe(l.expires_on) : '—'}</td><td className="mono">{l.serial_no ?? '—'}</td>
              <td className="num mono">{l.unit_cost !== null ? Number(l.unit_cost).toFixed(4) : '—'}</td><td className="num mono">{money2(l.line_net)}</td><td className="num mono">{money2(l.line_vat)}</td>
            </tr>))}</tbody>
        </table>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 18, padding: '10px 16px' }}>
          <span>დღგ-ს გარეშე: <strong className="mono">{money2(d.total_net)}</strong></span><span>დღგ: <strong className="mono">{money2(d.total_vat)}</strong></span>
          <span>სულ: <strong className="mono">{money2(Number(d.total_net) + Number(d.total_vat))}</strong></span>
        </div>
      </section>
      <ErrorBox error={rev.error} />
    </>
  );
}
