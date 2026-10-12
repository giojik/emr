import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, can } from '../../api/client';
import type { Department } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Loading, useDebounced, useToast } from '../../components/ui';
import { dateGe, todayISO, tsDate } from '../../lib/format';
import { useProcRules } from '../../lib/modules';
import type { Supplier } from '../stock/types';
import { AP_EDIT, CUR_SIGN, fmt, MATCH_KA, num, PAY_METHOD_KA, type ApInvoice, type ApRow, type Currency, type UninvoicedRc } from './types';

/** მომწოდებლის ინვოისები: სია ↔ ინვოისი (?id=new | ?id=<id>) */
export default function Invoices() {
  const [sp, setSp] = useSearchParams();
  const id = sp.get('id');
  if (id) return <InvPage id={id === 'new' ? null : id} supplier={sp.get('supplier_id') ?? ''} onClose={() => setSp({})} onOpen={(x) => setSp({ id: x })} />;
  return <InvList onOpen={(x) => setSp({ id: x })} />;
}

type Filter = 'open' | 'overdue' | 'mismatch' | 'draft' | 'paid' | 'all';
const payState = (r: Pick<ApRow, 'status' | 'paid' | 'total'>) => (r.status !== 'posted' ? null : Number(r.paid) >= Number(r.total) ? ['ok', 'გადახდილი'] : Number(r.paid) > 0 ? ['warn', 'ნაწილობრივ'] : ['', 'გადაუხდელი']);

function InvList({ onOpen }: { onOpen: (id: string) => void }) {
  const { user } = useAuth();
  const [f, setF] = useState<Filter>('open'); const [sup, setSup] = useState(''); const [search, setSearch] = useState(''); const ds = useDebounced(search.trim(), 300);
  const sups = useQuery({ queryKey: ['stock-suppliers', '', true], queryFn: () => api<Supplier[]>('/stock/suppliers', { query: { all: true } }) });
  const query = { supplier_id: sup, search: ds, ...(['open', 'overdue', 'mismatch', 'paid'].includes(f) && { state: f }), ...(f === 'draft' && { status: 'draft' }), ...(f === 'all' && { status: 'draft,posted,void' }) };
  const q = useQuery({ queryKey: ['ap-list', query], queryFn: () => api<ApRow[]>('/payables/invoices', { query }) });
  const sum = (q.data ?? []).filter((r) => r.status === 'posted').reduce((a, r) => a + Number(r.balance) * Number(r.fx_rate), 0);
  return (
    <div className="content">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <div className="seg" role="group" aria-label="ფილტრი">{([['open', 'გადასახდელი'], ['overdue', 'ვადაგადაცილებული'], ['mismatch', 'სხვაობით'], ['draft', 'მონახაზი'], ['paid', 'გადახდილი'], ['all', 'ყველა']] as [Filter, string][])
          .map(([k, l]) => <button key={k} type="button" aria-pressed={f === k} onClick={() => setF(k)}>{l}</button>)}</div>
        <select className="select" style={{ maxWidth: 240, height: 38 }} aria-label="მომწოდებელი" value={sup} onChange={(e) => setSup(e.target.value)}>
          <option value="">ყველა მომწოდებელი</option>{sups.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        <input className="input" style={{ maxWidth: 220, height: 38 }} aria-label="ძებნა" placeholder="AP-№, ფაქტურა, მომწოდებელი" value={search} onChange={(e) => setSearch(e.target.value)} />
        <span className="grow" />
        {can(user, ...AP_EDIT) && <button className="btn primary" type="button" onClick={() => onOpen('new')}>+ მომწოდებლის ინვოისი</button>}
      </div>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : (
        <div className="card">
          <table className="table">
            <thead><tr><th>AP-№</th><th>მომწოდებელი</th><th>ფაქტურა</th><th>თარიღი</th><th>გადახდის ვადა</th><th className="num">ჯამი</th><th className="num">ნაშთი</th><th>შეჯერება</th><th>სტატუსი</th></tr></thead>
            <tbody>{q.data?.map((r) => {
              const ps = payState(r); const late = r.status === 'posted' && Number(r.balance) > 0 && (r.days_overdue ?? 0) > 0;
              return (
                <tr key={r.id} className="clickable" onClick={() => onOpen(r.id)} style={r.status === 'void' ? { opacity: 0.5 } : undefined}>
                  <td className="mono">{r.ap_no ?? '—'}</td><td>{r.supplier_name}</td><td className="mono small">{r.invoice_no}</td><td className="mono">{dateGe(r.invoice_date)}</td>
                  <td className="mono" style={late ? { color: 'var(--danger-ink)', fontWeight: 600 } : undefined}>{dateGe(r.due_date)}{late && ` (+${r.days_overdue} დ.)`}</td>
                  <td className="num mono">{fmt(r.total)} {CUR_SIGN[r.currency]}</td>
                  <td className="num mono">{r.status === 'posted' ? `${fmt(r.balance)} ${CUR_SIGN[r.currency]}` : '—'}</td>
                  <td>{r.status === 'posted' && r.match_status !== 'none' ? <span className={`chip ${MATCH_KA[r.match_status][0]}`}>{MATCH_KA[r.match_status][1]}</span> : <span className="muted small">—</span>}</td>
                  <td>{r.status === 'draft' ? <span className="chip warn">მონახაზი</span> : r.status === 'void' ? <span className="chip">გაუქმებული</span> : ps && <span className={`chip ${ps[0]}`}>{ps[1]}</span>}</td>
                </tr>);
            })}
              {!q.data?.length && <tr><td colSpan={9} className="muted">ინვოისი არ არის</td></tr>}
            </tbody>
          </table>
          {sum > 0 && <div className="row" style={{ justifyContent: 'flex-end', padding: '10px 16px' }}>გადასახდელი (ფილტრით): <strong className="mono" style={{ marginLeft: 6 }}>{fmt(sum)} ₾</strong></div>}
        </div>)}
    </div>
  );
}

function InvPage({ id, supplier, onClose, onOpen }: { id: string | null; supplier: string; onClose: () => void; onOpen: (id: string) => void }) {
  const { user } = useAuth(); const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['ap-inv', id], queryFn: () => api<ApInvoice>(`/payables/invoices/${id}`), enabled: !!id });
  if (id && q.isLoading) return <div className="content"><Loading /></div>;
  if (id && q.error) return <div className="content"><ErrorBox error={q.error} /><button className="btn" type="button" onClick={onClose}>← სია</button></div>;
  const d = q.data;
  const done = (r: ApInvoice, msg?: string) => { qc.setQueryData(['ap-inv', r.id], r); void qc.invalidateQueries({ queryKey: ['ap-list'] }); void qc.invalidateQueries({ queryKey: ['ap-summary'] }); if (msg) toast.show(msg); if (!id) onOpen(r.id); };
  const editable = (!d || d.status === 'draft') && can(user, ...AP_EDIT);
  return <div className="content">{toast.node}{editable ? <InvForm key={d?.id ?? 'new'} d={d ?? null} supplier={supplier} onClose={onClose} onDone={done} /> : d && <InvView d={d} onClose={onClose} onDone={done} />}</div>;
}

interface Line { key: string; description: string; category: string; department_id: string; amount: string; vat_rate: number }
let seq = 0;

function InvForm({ d, supplier, onClose, onDone }: { d: ApInvoice | null; supplier: string; onClose: () => void; onDone: (r: ApInvoice, msg?: string) => void }) {
  const qc = useQueryClient(); const rules = useProcRules();
  const sups = useQuery({ queryKey: ['stock-suppliers', '', false], queryFn: () => api<Supplier[]>('/stock/suppliers') });
  const deps = useQuery({ queryKey: ['departments'], queryFn: () => api<Department[]>('/departments') });
  const cats = useQuery({ queryKey: ['expense-cats'], queryFn: () => api<string[]>('/expenses/categories') });
  const [h, setH] = useState({ supplier_id: d?.supplier_id ?? supplier, invoice_no: d?.invoice_no ?? '', invoice_date: d?.invoice_date ?? todayISO(), due_date: d?.due_date ?? '',
    currency: (d?.currency ?? 'GEL') as Currency, fx_rate: d ? String(Number(d.fx_rate)) : '1', total: d ? String(Number(d.total)) : '', total_vat: d ? String(Number(d.total_vat)) : '', notes: d?.notes ?? '' });
  const [rcs, setRcs] = useState<string[]>(() => d?.receipts.map((r) => r.doc_id) ?? []);
  const [lines, setLines] = useState<Line[]>(() => (d?.lines ?? []).map((l) => ({ key: `e${++seq}`, description: l.description, category: l.category, department_id: l.department_id ?? '', amount: String(Number(l.amount)), vat_rate: Number(l.vat_rate) })));
  const free = useQuery({ queryKey: ['ap-uninvoiced', h.supplier_id, d?.id], enabled: !!h.supplier_id,
    queryFn: () => api<UninvoicedRc[]>('/payables/uninvoiced', { query: { supplier_id: h.supplier_id, invoice_id: d?.id ?? '' } }) });
  const sup = sups.data?.find((s) => s.id === h.supplier_id);
  const fx = h.currency === 'GEL' ? 1 : num(h.fx_rate || '0');
  const rcList = [...(d?.receipts.filter((r) => !free.data?.some((x) => x.id === r.doc_id)).map((r) => ({ id: r.doc_id, doc_no: r.doc_no, doc_date: r.doc_date, invoice_no: r.invoice_no, invoice_date: null, waybill_no: r.waybill_no, total_net: r.total_net, total_vat: r.total_vat, po_no: r.po_no, location_name: r.location_name })) ?? []), ...(free.data ?? [])];
  const rcSum = rcList.filter((r) => rcs.includes(r.id)).reduce((a, r) => a + Number(r.total_net) + Number(r.total_vat), 0);
  const exp = lines.reduce((a, l) => a + num(l.amount || '0'), 0);
  const total = num(h.total || '0');
  const stockGel = (total - exp) * fx; const diff = stockGel - rcSum;
  const tol = rules?.match_tolerance ?? 1;
  const upd = (key: string, p: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...p } : l)));
  const body = () => ({ supplier_id: h.supplier_id, invoice_no: h.invoice_no.trim(), invoice_date: h.invoice_date, due_date: h.due_date || null, currency: h.currency,
    ...(h.currency !== 'GEL' && { fx_rate: fx }), total, total_vat: num(h.total_vat || '0'), notes: h.notes || null, receipts: rcs,
    lines: lines.map((l) => ({ description: l.description, category: l.category, department_id: l.department_id || null, amount: num(l.amount || '0'), vat_rate: l.vat_rate })) });
  const save = useMutation({
    mutationFn: async (post: boolean) => {
      let r = d ? await api<ApInvoice>(`/payables/invoices/${d.id}`, { method: 'PUT', body: body() }) : await api<ApInvoice>('/payables/invoices', { body: body() });
      if (post) r = await api<ApInvoice>(`/payables/invoices/${r.id}/post`, { method: 'POST' }).catch((e) => { onDone(r); throw e; });
      void qc.invalidateQueries({ queryKey: ['ap-uninvoiced'] }); void qc.invalidateQueries({ queryKey: ['expenses'] });
      return { r, post };
    },
    onSuccess: ({ r, post }) => onDone(r, post ? `გატარდა: ${r.ap_no}${r.match_status === 'mismatch' ? ' — სხვაობით!' : ''}` : 'შენახულია'),
  });
  const del = useMutation({ mutationFn: () => api(`/payables/invoices/${d!.id}`, { method: 'DELETE' }), onSuccess: onClose });
  const valid = h.supplier_id && h.invoice_no.trim() && total > 0 && (rcs.length > 0 || lines.length > 0) && lines.every((l) => l.description.trim().length >= 2 && l.category.trim().length >= 2 && num(l.amount || '0') > 0) && (h.currency === 'GEL' || fx > 0);
  const cur = CUR_SIGN[h.currency];
  return (
    <>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button className="btn" type="button" onClick={onClose}>← სია</button>
        <h2 className="grow" style={{ margin: 0 }}>{d ? 'მომწოდებლის ინვოისი — მონახაზი' : 'ახალი მომწოდებლის ინვოისი'}</h2>
        {d && <button className="btn" type="button" disabled={del.isPending} onClick={() => { if (confirm('წავშალოთ მონახაზი?')) del.mutate(); }}>წაშლა</button>}
        <button className="btn" type="button" disabled={!h.supplier_id || !h.invoice_no.trim() || !(total > 0) || save.isPending} onClick={() => save.mutate(false)}>შენახვა</button>
        <button className="btn primary" type="button" disabled={!valid || save.isPending} onClick={() => { if (confirm('გავატაროთ? გატარებული ინვოისი აღარ შეიცვლება (მხოლოდ გაუქმებით).')) save.mutate(true); }}>გატარება</button>
      </div>
      <section className="card card-pad" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12 }}>
        <div className="field"><label htmlFor="as">მომწოდებელი <span className="req">*</span></label>
          <select id="as" className="select" value={h.supplier_id} onChange={(e) => { setH({ ...h, supplier_id: e.target.value }); setRcs([]); }}>
            <option value="">— აირჩიეთ —</option>{sups.data?.map((s) => <option key={s.id} value={s.id}>{s.name}{s.tax_id ? ` (${s.tax_id})` : ''}</option>)}</select></div>
        <div className="field"><label htmlFor="an">ანგარიშ-ფაქტურა № <span className="req">*</span></label><input id="an" className="input mono" value={h.invoice_no} onChange={(e) => setH({ ...h, invoice_no: e.target.value })} /></div>
        <div className="field"><label htmlFor="ad">ფაქტურის თარიღი</label><input id="ad" className="input mono" type="date" max={todayISO()} value={h.invoice_date} onChange={(e) => setH({ ...h, invoice_date: e.target.value })} /></div>
        <div className="field"><label htmlFor="adu">გადახდის ვადა</label><input id="adu" className="input mono" type="date" min={h.invoice_date} value={h.due_date} onChange={(e) => setH({ ...h, due_date: e.target.value })} />
          <span className="small muted">{h.due_date ? '' : sup?.payment_terms_days != null ? `ცარიელი — თარიღი + ${sup.payment_terms_days} დღე` : 'ცარიელი — ფაქტურის თარიღი'}</span></div>
        <div className="field"><label htmlFor="at">სულ (დღგ-ით) <span className="req">*</span></label>
          <div className="row" style={{ gap: 6 }}><input id="at" className="input mono" inputMode="decimal" value={h.total} onChange={(e) => setH({ ...h, total: e.target.value })} />
            <select className="select" style={{ width: 90 }} aria-label="ვალუტა" value={h.currency} onChange={(e) => setH({ ...h, currency: e.target.value as Currency })}><option value="GEL">₾</option><option value="USD">$</option><option value="EUR">€</option></select></div></div>
        <div className="field"><label htmlFor="av">მ.შ. დღგ</label><input id="av" className="input mono" inputMode="decimal" value={h.total_vat} onChange={(e) => setH({ ...h, total_vat: e.target.value })} /></div>
        {h.currency !== 'GEL' ? <div className="field"><label htmlFor="afx">კურსი (1 {h.currency} = ? ₾)</label><input id="afx" className="input mono" inputMode="decimal" value={h.fx_rate} onChange={(e) => setH({ ...h, fx_rate: e.target.value })} /></div> : <div />}
        <div className="field"><label htmlFor="ano">შენიშვნა</label><input id="ano" className="input" value={h.notes} onChange={(e) => setH({ ...h, notes: e.target.value })} /></div>
      </section>

      <section className="card" style={{ overflowX: 'auto' }}>
        <div className="row card-pad" style={{ paddingBottom: 0 }}><strong className="grow">მიღებები (მარაგი)</strong><span className="small muted">მომწოდებლის გატარებული, ჯერ ინვოისზე მიუბმელი მიღებები</span></div>
        <table className="table">
          <thead><tr><th /><th>RC</th><th>თარიღი</th><th>ფაქტურა / ზედნადები</th><th>შეკვეთა</th><th>ლოკაცია</th><th className="num">ჯამი (დღგ-ით, ₾)</th></tr></thead>
          <tbody>{rcList.map((r) => {
            const hit = !!h.invoice_no.trim() && (r.invoice_no ?? '').trim().toUpperCase() === h.invoice_no.trim().toUpperCase();
            return (
              <tr key={r.id} className="clickable" onClick={() => setRcs((x) => (x.includes(r.id) ? x.filter((y) => y !== r.id) : [...x, r.id]))} style={hit && !rcs.includes(r.id) ? { background: 'var(--info-weak)' } : undefined}>
                <td><input type="checkbox" aria-label={`მიბმა ${r.doc_no}`} checked={rcs.includes(r.id)} readOnly /></td>
                <td className="mono">{r.doc_no}</td><td className="mono">{dateGe(r.doc_date)}</td>
                <td className="small">{[r.invoice_no, r.waybill_no].filter(Boolean).join(' · ') || '—'}{hit && <span className="chip info" style={{ marginLeft: 6, height: 20 }}>№ ემთხვევა</span>}</td>
                <td className="mono small">{r.po_no ?? '—'}</td><td className="small">{r.location_name}</td><td className="num mono">{fmt(Number(r.total_net) + Number(r.total_vat))}</td>
              </tr>);
          })}
            {!rcList.length && <tr><td colSpan={7} className="muted">{h.supplier_id ? 'მიუბმელი მიღება არ არის' : 'აირჩიეთ მომწოდებელი'}</td></tr>}
          </tbody>
        </table>
      </section>

      <section className="card" style={{ overflowX: 'auto' }}>
        <div className="row card-pad" style={{ paddingBottom: 0 }}><strong className="grow">არა-მარაგის ხაზები (მომსახურება, კომუნალური, რემონტი…) → ხარჯების ჟურნალი</strong>
          <button className="btn sm" type="button" onClick={() => setLines((ls) => [...ls, { key: `e${++seq}`, description: '', category: '', department_id: '', amount: '', vat_rate: sup?.vat_payer ? 18 : 0 }])}>+ ხაზი</button></div>
        <datalist id="ap-cats">{cats.data?.map((c) => <option key={c} value={c} />)}</datalist>
        <table className="table">
          <thead><tr><th>აღწერა</th><th>ხარჯის კატეგორია</th><th>განყოფილება (ხარჯის ცენტრი)</th><th className="num">თანხა (დღგ-ით, {cur})</th><th>დღგ</th><th /></tr></thead>
          <tbody>{lines.map((l) => (
            <tr key={l.key}>
              <td><input className="input" style={{ height: 34, minWidth: 220 }} aria-label="აღწერა" value={l.description} onChange={(e) => upd(l.key, { description: e.target.value })} /></td>
              <td><input className="input" style={{ height: 34, minWidth: 160 }} aria-label="კატეგორია" list="ap-cats" value={l.category} onChange={(e) => upd(l.key, { category: e.target.value })} /></td>
              <td><select className="select" style={{ height: 34, minWidth: 180 }} aria-label="განყოფილება" value={l.department_id} onChange={(e) => upd(l.key, { department_id: e.target.value })}>
                <option value="">საერთო</option>{deps.data?.filter((x) => x.is_active).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></td>
              <td><input className="input mono num" style={{ height: 34, width: 110 }} aria-label="თანხა" inputMode="decimal" value={l.amount} onChange={(e) => upd(l.key, { amount: e.target.value })} /></td>
              <td><select className="select" style={{ height: 34, width: 72 }} aria-label="დღგ" value={l.vat_rate} onChange={(e) => upd(l.key, { vat_rate: Number(e.target.value) })}><option value={18}>18%</option><option value={0}>0%</option></select></td>
              <td><button className="icon-btn" type="button" aria-label="ხაზის წაშლა" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>×</button></td>
            </tr>))}
            {!lines.length && <tr><td colSpan={6} className="muted small">მარაგის ინვოისს ხაზი არ სჭირდება — ხარჯი აღირიცხება მოხმარებისას</td></tr>}
          </tbody>
        </table>
      </section>

      <section className="card card-pad" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
        <div><span className="small muted">ინვოისი</span><div className="mono"><strong>{fmt(total)} {cur}</strong>{h.currency !== 'GEL' && fx > 0 && <span className="small muted"> ≈ {fmt(total * fx)} ₾</span>}</div></div>
        <div><span className="small muted">მ.შ. არა-მარაგი</span><div className="mono">{fmt(exp)} {cur}</div></div>
        <div><span className="small muted">მარაგის ნაწილი ↔ მიღებები</span><div className="mono">{fmt(stockGel)} ₾ ↔ {fmt(rcSum)} ₾</div></div>
        <div><span className="small muted">სხვაობა</span><div className="mono" style={{ color: rcs.length && Math.abs(diff) > tol ? 'var(--danger-ink)' : rcs.length ? 'var(--ok-ink)' : undefined }}>
          {rcs.length ? `${diff >= 0 ? '+' : ''}${fmt(diff)} ₾` : !lines.length ? '—' : Math.abs(total - exp) > 0.005 ? `ხაზები ≠ ჯამი (${fmt(total - exp)})` : '✓'}</div></div>
      </section>
      {rcs.length > 0 && Math.abs(diff) > tol && rules?.invoice_match !== 'off' && <div className="alert warn">სხვაობა ტოლერანტობაზე ({tol} ₾) მეტია — გატარების შემდეგ გადახდა დაიბლოკება, სანამ სხვაობას მიზეზით არ დაადასტურებთ.</div>}
      <ErrorBox error={save.error ?? del.error} />
    </>
  );
}

function InvView({ d, onClose, onDone }: { d: ApInvoice; onClose: () => void; onDone: (r: ApInvoice, msg?: string) => void }) {
  const { user } = useAuth(); const nav = useNavigate(); const qc = useQueryClient();
  const edit = can(user, ...AP_EDIT); const cur = CUR_SIGN[d.currency];
  const act = useMutation({ mutationFn: (a: { path: string; body?: unknown; msg?: string }) => api<ApInvoice>(a.path, { body: a.body ?? {} }),
    onSuccess: (r, a) => { void qc.invalidateQueries({ queryKey: ['expenses'] }); void qc.invalidateQueries({ queryKey: ['ap-uninvoiced'] }); onDone(r, a.msg); } });
  const ask = (m: string) => { const v = prompt(m); return v && v.trim().length >= 3 ? v.trim() : null; };
  const bal = Number(d.balance);
  const [pay, setPay] = useState<{ kind: 'payment' | 'credit_note'; pay_date: string; amount: string; fx_rate: string; method: string; reference: string; note: string } | null>(null);
  return (
    <>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button className="btn" type="button" onClick={onClose}>← სია</button>
        <h2 className="grow" style={{ margin: 0 }}>ინვოისი <span className="mono">{d.ap_no ?? ''}</span>
          {d.status === 'void' ? <span className="chip" style={{ marginLeft: 6 }}>გაუქმებული</span> : bal <= 0 ? <span className="chip ok" style={{ marginLeft: 6 }}>გადახდილი</span>
            : <span className={`chip ${d.overdue ? 'danger' : Number(d.paid) > 0 ? 'warn' : ''}`} style={{ marginLeft: 6 }}>{d.overdue ? 'ვადაგადაცილებული' : Number(d.paid) > 0 ? 'ნაწილობრივ' : 'გადაუხდელი'}</span>}
          {d.match_status !== 'none' && <span className={`chip ${MATCH_KA[d.match_status][0]}`} style={{ marginLeft: 6 }}>{MATCH_KA[d.match_status][1]}</span>}</h2>
        {edit && d.status === 'posted' && d.match_status === 'mismatch' && <button className="btn" type="button" disabled={act.isPending}
          onClick={() => { const v = ask('სხვაობის დადასტურების მიზეზი (მაგ. მიტანის ღირებულება)'); if (v) act.mutate({ path: `/payables/invoices/${d.id}/accept-match`, body: { reason: v }, msg: 'სხვაობა დადასტურდა' }); }}>სხვაობის დადასტურება</button>}
        {edit && d.status === 'posted' && !d.payments.some((p) => !p.is_void) && <button className="btn" type="button" disabled={act.isPending}
          onClick={() => { const v = ask('გაუქმების მიზეზი (მიღებები გათავისუფლდება, ხარჯის ჩანაწერები გაუქმდება)'); if (v) act.mutate({ path: `/payables/invoices/${d.id}/void`, body: { reason: v } }); }}>გაუქმება</button>}
        {edit && d.status === 'posted' && bal > 0 && !pay && <>
          <button className="btn" type="button" onClick={() => setPay({ kind: 'credit_note', pay_date: todayISO(), amount: '', fx_rate: String(Number(d.fx_rate)), method: '', reference: '', note: '' })}>კრედიტ-ნოტა</button>
          <button className="btn primary" type="button" disabled={d.match_status === 'mismatch'} title={d.match_status === 'mismatch' ? 'ჯერ დაადასტურეთ სხვაობა' : undefined}
            onClick={() => setPay({ kind: 'payment', pay_date: todayISO(), amount: String(bal), fx_rate: String(Number(d.fx_rate)), method: 'bank_transfer', reference: '', note: '' })}>გადახდა</button></>}
      </div>
      {d.match_status === 'mismatch' && <div className="alert danger">შეჯერება: {d.match_note}. გადახდა დაბლოკილია, სანამ სხვაობას მიზეზით არ დაადასტურებთ (ან არ გააუქმებთ ინვოისს).</div>}
      {d.match_status === 'accepted' && <div className="alert warn small">{d.match_note}{d.accepted_by_name && ` — ${d.accepted_by_name}`}</div>}
      {d.void_reason && <div className="alert info small">გაუქმდა: {d.void_reason}{d.voided_by_name && ` — ${d.voided_by_name}`}</div>}
      {pay && (
        <section className="card card-pad stack" style={{ gap: 10, borderColor: 'var(--accent)' }}>
          <strong>{pay.kind === 'payment' ? 'გადახდის რეგისტრაცია' : 'კრედიტ-ნოტა (ამცირებს დავალიანებას)'}</strong>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: 10 }}>
            <div className="field"><label htmlFor="pd">თარიღი</label><input id="pd" className="input mono" type="date" max={todayISO()} value={pay.pay_date} onChange={(e) => setPay({ ...pay, pay_date: e.target.value })} /></div>
            <div className="field"><label htmlFor="pa">თანხა ({cur}, ნაშთი {fmt(bal)})</label><input id="pa" className="input mono" inputMode="decimal" value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} /></div>
            {d.currency !== 'GEL' && <div className="field"><label htmlFor="pf">კურსი</label><input id="pf" className="input mono" inputMode="decimal" value={pay.fx_rate} onChange={(e) => setPay({ ...pay, fx_rate: e.target.value })} /></div>}
            {pay.kind === 'payment' && <div className="field"><label htmlFor="pm">მეთოდი</label><select id="pm" className="select" value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}>
              {Object.entries(PAY_METHOD_KA).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>}
            <div className="field"><label htmlFor="pr">{pay.kind === 'payment' ? 'ბანკის საბუთი №' : 'კრედიტ-ნოტის №'}</label><input id="pr" className="input mono" value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} /></div>
            <div className="field"><label htmlFor="pn">შენიშვნა</label><input id="pn" className="input" value={pay.note} onChange={(e) => setPay({ ...pay, note: e.target.value })} /></div>
          </div>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn" type="button" onClick={() => setPay(null)}>გაუქმება</button>
            <button className="btn primary" type="button" disabled={act.isPending || !(num(pay.amount || '0') > 0)} onClick={() => act.mutate({ path: `/payables/invoices/${d.id}/payments`, msg: 'შენახულია',
              body: { kind: pay.kind, pay_date: pay.pay_date, amount: num(pay.amount), ...(d.currency !== 'GEL' && { fx_rate: num(pay.fx_rate) }), ...(pay.kind === 'payment' && { method: pay.method }),
                reference: pay.reference || null, note: pay.note || null } }, { onSuccess: () => setPay(null) })}>შენახვა</button>
          </div>
        </section>)}
      <section className="card card-pad" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
        <div><span className="small muted">მომწოდებელი</span><div><strong>{d.supplier_name}</strong>{d.supplier_tax_id && <span className="mono small muted"> · {d.supplier_tax_id}</span>}</div>
          {d.supplier_iban && <div className="mono small">{d.supplier_iban}{d.supplier_bank && <span className="muted"> · {d.supplier_bank}</span>}</div>}</div>
        <div><span className="small muted">ფაქტურა</span><div className="mono">{d.invoice_no} · {dateGe(d.invoice_date)}</div></div>
        <div><span className="small muted">გადახდის ვადა</span><div className="mono" style={d.overdue ? { color: 'var(--danger-ink)', fontWeight: 600 } : undefined}>{dateGe(d.due_date)}</div></div>
        <div><span className="small muted">ჯამი / ნაშთი</span><div className="mono"><strong>{fmt(d.total)} {cur}</strong> · ნაშთი <strong>{fmt(bal)} {cur}</strong>{d.currency !== 'GEL' && <div className="small muted">კურსი {Number(d.fx_rate)} · {fmt(d.total_gel)} ₾</div>}</div></div>
        <div><span className="small muted">მ.შ. დღგ</span><div className="mono">{fmt(d.total_vat)} {cur}</div></div>
        <div><span className="small muted">მარაგი (მიღებები) / არა-მარაგი</span><div className="mono">{fmt(d.stock_gel)} ₾ / {fmt(d.expense_total)} {cur}</div></div>
        <div><span className="small muted">გაატარა</span><div className="small">{d.posted_by_name ?? '—'}{d.posted_at && ` · ${tsDate(d.posted_at)}`}</div></div>
        <div><span className="small muted">შეიყვანა</span><div className="small">{d.created_by_name}</div></div>
        {d.notes && <div style={{ gridColumn: 'span 4' }}><span className="small muted">შენიშვნა</span><div className="small">{d.notes}</div></div>}
      </section>
      {d.receipts.length > 0 && (
        <section className="card" style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead><tr><th>მიღება</th><th>თარიღი</th><th>შეკვეთა</th><th>ფაქტურა / ზედნადები</th><th className="num">ჯამი (დღგ-ით, ₾)</th></tr></thead>
            <tbody>{d.receipts.map((r) => (
              <tr key={r.doc_id} className="clickable" onClick={() => nav(`/stock/receipts?doc=${r.doc_id}`)}>
                <td className="mono">{r.doc_no}{r.reversed_by_no && <span className="chip danger" style={{ marginLeft: 6, height: 20 }}>შემობრუნდა {r.reversed_by_no}</span>}</td><td className="mono">{dateGe(r.doc_date)}</td>
                <td className="mono small">{r.po_no ?? '—'}</td><td className="small">{[r.invoice_no, r.waybill_no].filter(Boolean).join(' · ') || '—'}</td><td className="num mono">{fmt(r.amount_gel)}</td>
              </tr>))}</tbody>
          </table>
        </section>)}
      {d.lines.length > 0 && (
        <section className="card" style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead><tr><th>არა-მარაგის ხაზი</th><th>კატეგორია</th><th>განყოფილება</th><th className="num">თანხა ({cur})</th><th>დღგ</th></tr></thead>
            <tbody>{d.lines.map((l) => <tr key={l.id}><td>{l.description}</td><td>{l.category}</td><td>{l.department_name ?? 'საერთო'}</td><td className="num mono">{fmt(l.amount)}</td><td>{Number(l.vat_rate)}%</td></tr>)}</tbody>
          </table>
        </section>)}
      <section className="card" style={{ overflowX: 'auto' }}>
        <div className="card-pad" style={{ paddingBottom: 0 }}><strong>გადახდები და კრედიტ-ნოტები</strong></div>
        <table className="table">
          <thead><tr><th>თარიღი</th><th>ტიპი</th><th className="num">თანხა</th><th>მეთოდი</th><th>საბუთი</th><th>შეიყვანა</th><th /></tr></thead>
          <tbody>{d.payments.map((p) => (
            <tr key={p.id} style={p.is_void ? { opacity: 0.5, textDecoration: 'line-through' } : undefined} title={p.is_void ? `გაუქმდა: ${p.void_reason}` : undefined}>
              <td className="mono">{dateGe(p.pay_date)}</td><td>{p.kind === 'payment' ? 'გადახდა' : 'კრედიტ-ნოტა'}</td>
              <td className="num mono">{fmt(p.amount)} {cur}{d.currency !== 'GEL' && <div className="small muted">{fmt(p.amount_gel)} ₾</div>}</td>
              <td>{p.method ? PAY_METHOD_KA[p.method] : '—'}</td><td className="mono small">{p.reference ?? '—'}</td><td className="small">{p.created_by_name}</td>
              <td>{edit && !p.is_void && d.status === 'posted' && <button className="btn sm" type="button" disabled={act.isPending}
                onClick={() => { const v = ask('გაუქმების მიზეზი'); if (v) act.mutate({ path: `/payables/payments/${p.id}/void`, body: { reason: v } }); }}>გაუქმება</button>}</td>
            </tr>))}
            {!d.payments.length && <tr><td colSpan={7} className="muted small">გადახდა არ ყოფილა</td></tr>}
          </tbody>
        </table>
      </section>
      {d.expenses.length > 0 && (
        <section className="card card-pad stack" style={{ gap: 4 }}>
          <strong>ხარჯების ჟურნალი</strong>
          {d.expenses.map((x) => <span key={x.id} className="small row" style={{ gap: 10, ...(x.is_void ? { opacity: 0.5, textDecoration: 'line-through' } : {}) }}>
            <span className="mono">{dateGe(x.expense_date)}</span><span>{x.category}</span><span>{x.department_name ?? 'საერთო'}</span><span className="mono">{fmt(x.amount)} ₾</span>
            <span className="muted">{x.source === 'ap_payment' ? 'გადახდიდან' : x.source === 'ap_credit' ? 'კრედიტ-ნოტა' : 'ინვოისიდან'}</span></span>)}
        </section>)}
      <ErrorBox error={act.error} />
    </>
  );
}
