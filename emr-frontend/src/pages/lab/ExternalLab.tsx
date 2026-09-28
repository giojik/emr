import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api, apiUpload, can, openBlob } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Field, Loading, Modal, useToast } from '../../components/ui';
import { money, tsDate } from '../../lib/format';

interface ExtItem {
  id: string; status: string; priority: string; ext_shipment_id: string | null; ext_cost: string | null; ext_due_at: string | null; ext_result_at: string | null; ext_result_name: string | null;
  service_name: string; specimen_type: string | null; purchase_price: string | null; first_name: string; last_name: string; birth_date: string; barcode: string | null; collected_at: string | null;
  lab_id: string | null; lab_name: string | null; shipment_no: string | null; sent_at: string | null; overdue: boolean;
}
interface ExtLab { id: string; name: string; contact_person: string | null; phone: string | null; email: string | null; note: string | null; is_active: boolean; services: number }
const useLabs = (all = false) => useQuery({ queryKey: ['ext-labs', all], queryFn: () => api<ExtLab[]>('/lab/external-labs', { query: { all } }) });

/** ლაბორატორია → „გარე ლაბორატორია“: გასაგზავნი → პასუხს ელოდება (PDF) → გაგზავნები → ანგარიშსწორება → ლაბორატორიები */
export function ExternalLab() {
  const { user } = useAuth();
  const canSettle = can(user, 'admin', 'lab_manager', 'lab_doctor', 'accountant');
  const canLabs = can(user, 'admin', 'lab_manager', 'lab_doctor');
  const [tab, setTab] = useState<'send' | 'wait' | 'ship' | 'settle' | 'labs'>('send');
  const T: [typeof tab, string, boolean][] = [['send', 'გასაგზავნი', true], ['wait', 'პასუხს ელოდება', true], ['ship', 'გაგზავნები', true], ['settle', 'ანგარიშსწორება', canSettle], ['labs', 'ლაბორატორიები', canLabs]];
  return (
    <div className="stack">
      <div className="seg" role="tablist" aria-label="გარე ლაბორატორია">{T.filter((t) => t[2]).map(([k, l]) =>
        <button key={k} type="button" role="tab" aria-selected={tab === k} aria-pressed={tab === k} onClick={() => setTab(k)}>{l}</button>)}</div>
      {tab === 'send' && <ToSend />}
      {tab === 'wait' && <Waiting />}
      {tab === 'ship' && <Shipments />}
      {tab === 'settle' && <Settlement />}
      {tab === 'labs' && <Labs />}
    </div>
  );
}

function ToSend() {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['ext-to-send'], queryFn: () => api<ExtItem[]>('/lab/external/to-send'), refetchInterval: 20_000 });
  const labs = useLabs();
  const [sel, setSel] = useState<Set<string>>(new Set()); const [labId, setLabId] = useState(''); const [courier, setCourier] = useState('');
  const groups = useMemo(() => { const m = new Map<string, ExtItem[]>(); for (const i of q.data ?? []) m.set(i.lab_id ?? '', [...(m.get(i.lab_id ?? '') ?? []), i]); return [...m.entries()]; }, [q.data]);
  const ship = useMutation({
    mutationFn: () => api<{ id: string; shipment_no: string }>('/lab/external/shipments', { body: { lab_id: labId, item_ids: [...sel], courier: courier.trim() || undefined } }),
    onSuccess: (r) => { setSel(new Set()); void qc.invalidateQueries({ queryKey: ['ext-to-send'] }); void qc.invalidateQueries({ queryKey: ['ext-waiting'] }); toast.show(`გაიგზავნა: ${r.shipment_no}`); void openBlob(`/lab/external/shipments/${r.id}/act`); },
  });
  if (q.isLoading) return <Loading />;
  if (!q.data?.length) return <div className="card empty">გასაგზავნი სინჯი არ არის.</div>;
  const toggle = (i: ExtItem) => { const s = new Set(sel); if (s.has(i.id)) s.delete(i.id); else { s.add(i.id); if (!labId && i.lab_id) setLabId(i.lab_id); } setSel(s); };
  return (
    <div className="stack">
      {groups.map(([lid, items]) => (
        <section key={lid} className="card">
          <div className="card-pad row" style={{ paddingBottom: 0 }}><strong className="grow">{items[0].lab_name ?? 'ლაბორატორია არ არის მითითებული კატალოგში'}</strong>
            <button className="btn sm" type="button" onClick={() => { setSel(new Set(items.map((i) => i.id))); if (lid) setLabId(lid); }}>ყველას მონიშვნა</button></div>
          <table className="table"><tbody>{items.map((i) => (
            <tr key={i.id} className="clickable" onClick={() => toggle(i)}>
              <td style={{ width: 28 }}><input type="checkbox" readOnly checked={sel.has(i.id)} aria-label="მონიშვნა" /></td>
              <td className="mono">{i.barcode}</td><td><strong>{i.last_name} {i.first_name}</strong> <span className="small muted">{tsDate(i.birth_date)}</span></td>
              <td>{i.service_name}{i.priority === 'urgent' && <span className="chip danger" style={{ marginLeft: 6 }}>სასწრაფო</span>}</td>
              <td className="small muted">{i.collected_at && `აღება ${tsDate(i.collected_at)}`}</td>
              <td className="num small">{i.purchase_price !== null ? money(Number(i.purchase_price)) : <span style={{ color: 'var(--warn-ink)' }}>ფასი?</span>}</td>
            </tr>))}</tbody></table>
        </section>))}
      <div className="card card-pad row" style={{ flexWrap: 'wrap', position: 'sticky', bottom: 8 }}>
        <strong>მონიშნულია: {sel.size}</strong>
        <select aria-label="ლაბორატორია" className="select" style={{ maxWidth: 260, height: 36 }} value={labId} onChange={(e) => setLabId(e.target.value)}>
          <option value="">— ლაბორატორია</option>{labs.data?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
        <input aria-label="კურიერი" className="input" style={{ maxWidth: 220, height: 36 }} placeholder="კურიერი (არასავალდებულო)" value={courier} onChange={(e) => setCourier(e.target.value)} />
        <button className="btn primary" type="button" style={{ marginLeft: 'auto' }} disabled={!sel.size || !labId || ship.isPending} onClick={() => ship.mutate()}>გაგზავნა + აქტი (PDF)</button>
      </div>
      <ErrorBox error={ship.error} />{toast.node}
    </div>
  );
}

function Waiting() {
  const qc = useQueryClient(); const toast = useToast();
  const labs = useLabs(); const [labId, setLabId] = useState('');
  const q = useQuery({ queryKey: ['ext-waiting', labId], queryFn: () => api<ExtItem[]>('/lab/external/waiting', { query: { lab_id: labId || undefined } }), refetchInterval: 30_000 });
  const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState<string | null>(null);
  const upload = async (i: ExtItem, f: File | undefined) => {
    if (!f) return; setBusy(i.id); setErr(null);
    try { const fd = new FormData(); fd.append('file', f); await apiUpload(`/lab/items/${i.id}/external-result`, fd); toast.show(`${i.service_name}: პასუხი მიება — ვალიდაციას ელოდება`);
      void qc.invalidateQueries({ queryKey: ['ext-waiting'] }); void qc.invalidateQueries({ queryKey: ['lab-worklist'] }); }
    catch (e) { setErr(e); } finally { setBusy(null); }
  };
  const over = (q.data ?? []).filter((i) => i.overdue).length;
  return (
    <div className="stack">
      <div className="row"><select aria-label="ლაბორატორია" className="select" style={{ maxWidth: 260, height: 36 }} value={labId} onChange={(e) => setLabId(e.target.value)}>
        <option value="">ყველა ლაბორატორია</option>{labs.data?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
        {over > 0 && <span className="chip danger">ვადაგადაცილებული: {over}</span>}
        <span className="hint grow" style={{ textAlign: 'right' }}>პასუხი (PDF / სკანი) ებმება კონკრეტულ ანალიზს; შემდეგ — ლაბ. ექიმის ვალიდაცია („ვალიდაციას ელოდება“ სიაში).</span></div>
      <ErrorBox error={err} />
      {q.isLoading ? <Loading /> : !q.data?.length ? <div className="card empty">პასუხს არაფერი ელოდება.</div> : (
        <div className="card"><table className="table">
          <thead><tr><th>გაგზავნა</th><th>შტრიხკოდი</th><th>პაციენტი</th><th>ანალიზი</th><th>ვადა</th><th /></tr></thead>
          <tbody>{q.data.map((i) => (
            <tr key={i.id} style={i.overdue ? { background: 'var(--danger-weak)' } : undefined}>
              <td className="small"><span className="mono">{i.shipment_no}</span><div className="muted">{i.lab_name} · {i.sent_at && tsDate(i.sent_at)}</div></td>
              <td className="mono">{i.barcode}</td><td><strong>{i.last_name} {i.first_name}</strong></td><td>{i.service_name}</td>
              <td className="small">{i.ext_due_at && tsDate(i.ext_due_at)}{i.overdue && <div style={{ color: 'var(--danger-ink)', fontWeight: 600 }}>ვადაგადაცილებული</div>}</td>
              <td><label className="btn sm" style={{ cursor: 'pointer' }}>{busy === i.id ? '…' : 'პასუხი (PDF)'}
                <input type="file" accept="application/pdf,image/jpeg,image/png" hidden onChange={(e) => { void upload(i, e.target.files?.[0]); e.target.value = ''; }} /></label></td>
            </tr>))}</tbody></table></div>)}
      {toast.node}
    </div>
  );
}

function Shipments() {
  const q = useQuery({ queryKey: ['ext-shipments'], queryFn: () => api<{ id: string; shipment_no: string; sent_at: string; courier: string | null; lab_name: string; sent_by_name: string | null; items: string; resulted: string }[]>('/lab/external/shipments') });
  if (q.isLoading) return <Loading />;
  if (!q.data?.length) return <div className="card empty">გაგზავნები ჯერ არ ყოფილა.</div>;
  return (
    <div className="card"><table className="table">
      <thead><tr><th>№</th><th>ლაბორატორია</th><th>თარიღი</th><th>გაგზავნა</th><th className="num">სინჯი</th><th className="num">პასუხი</th><th /></tr></thead>
      <tbody>{q.data.map((s) => (
        <tr key={s.id}><td className="mono">{s.shipment_no}</td><td>{s.lab_name}</td><td className="small">{tsDate(s.sent_at)}</td>
          <td className="small muted">{s.sent_by_name}{s.courier ? ` · ${s.courier}` : ''}</td><td className="num">{s.items}</td>
          <td className="num">{Number(s.resulted) === Number(s.items) ? <span className="chip ok">{s.resulted}</span> : `${s.resulted} / ${s.items}`}</td>
          <td><button className="btn sm" type="button" onClick={() => void openBlob(`/lab/external/shipments/${s.id}/act`)}>აქტი</button></td></tr>))}</tbody>
    </table></div>
  );
}

function Settlement() {
  const qc = useQueryClient(); const toast = useToast();
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const q = useQuery({ queryKey: ['ext-settle', month], queryFn: () => api<{ lab_id: string; lab_name: string; items: string; amount: string; no_price: string; no_result: string;
    settlement: { invoice_no: string | null; paid_at: string | null; amount: string; note: string | null } | null }[]>('/lab/external/settlement', { query: { month } }) });
  const [detail, setDetail] = useState<{ id: string; name: string } | null>(null);
  const [rec, setRec] = useState<{ lab_id: string; name: string; invoice_no: string; paid_at: string; note: string } | null>(null);
  const save = useMutation({ mutationFn: () => api('/lab/external/settlements', { body: { lab_id: rec!.lab_id, month, invoice_no: rec!.invoice_no || undefined, note: rec!.note || undefined, paid_at: rec!.paid_at || null } }),
    onSuccess: () => { setRec(null); void qc.invalidateQueries({ queryKey: ['ext-settle'] }); toast.show('ჩაიწერა'); } });
  const total = (q.data ?? []).reduce((a, r) => a + Number(r.amount), 0);
  return (
    <div className="stack">
      <div className="row"><Field label="თვე" htmlFor="sm"><input id="sm" type="month" className="input" value={month} onChange={(e) => setMonth(e.target.value)} /></Field>
        <span className="hint grow" style={{ textAlign: 'right' }}>თანხა — გაგზავნის მომენტის შესყიდვის ფასით (კატალოგის შემდგომი ცვლილება ძველ გაგზავნებზე არ მოქმედებს).</span></div>
      {q.isLoading ? <Loading /> : !q.data?.length ? <div className="card empty">ამ თვეში გაგზავნა არ ყოფილა.</div> : (
        <div className="card"><table className="table">
          <thead><tr><th>ლაბორატორია</th><th className="num">ანალიზი</th><th className="num">თანხა</th><th>შენიშვნა</th><th>ანგარიშსწორება</th><th /></tr></thead>
          <tbody>{q.data.map((r) => (
            <tr key={r.lab_id}><td><strong>{r.lab_name}</strong></td><td className="num">{r.items}</td><td className="num mono">{money(Number(r.amount))}</td>
              <td className="small">{Number(r.no_price) > 0 && <div style={{ color: 'var(--warn-ink)' }}>ფასის გარეშე: {r.no_price}</div>}{Number(r.no_result) > 0 && <div className="muted">პასუხის გარეშე: {r.no_result}</div>}</td>
              <td className="small">{r.settlement ? <>{r.settlement.paid_at ? <span className="chip ok">გადახდილია {tsDate(r.settlement.paid_at)}</span> : <span className="chip warn">ჩაწერილია, გადაუხდელი</span>}
                {r.settlement.invoice_no && <div className="muted">ინვოისი {r.settlement.invoice_no}</div>}{Number(r.settlement.amount) !== Number(r.amount) && <div style={{ color: 'var(--warn-ink)' }}>ჩაწერისას: {money(Number(r.settlement.amount))}</div>}</> : <span className="muted">—</span>}</td>
              <td style={{ whiteSpace: 'nowrap' }}><button className="btn sm" type="button" onClick={() => setDetail({ id: r.lab_id, name: r.lab_name })}>სია</button>{' '}
                <button className="btn sm" type="button" onClick={() => setRec({ lab_id: r.lab_id, name: r.lab_name, invoice_no: r.settlement?.invoice_no ?? '', paid_at: r.settlement?.paid_at?.slice(0, 10) ?? '', note: r.settlement?.note ?? '' })}>ანგარიშსწორება</button></td></tr>))}
            <tr><td><strong>სულ</strong></td><td /><td className="num mono"><strong>{money(total)}</strong></td><td colSpan={3} /></tr></tbody>
        </table></div>)}
      {detail && <SettleItems labId={detail.id} name={detail.name} month={month} onClose={() => setDetail(null)} />}
      {rec && <Modal title={`${rec.name} — ${month}`} onClose={() => setRec(null)} width={480}
        footer={<><button className="btn" type="button" onClick={() => setRec(null)}>გაუქმება</button><button className="btn primary" type="button" disabled={save.isPending} onClick={() => save.mutate()}>შენახვა</button></>}>
        <Field label="ინვოისის №" htmlFor="ri"><input id="ri" className="input" value={rec.invoice_no} onChange={(e) => setRec({ ...rec, invoice_no: e.target.value })} /></Field>
        <Field label="გადახდის თარიღი" htmlFor="rp" hint="ცარიელი — ჯერ გადაუხდელი"><input id="rp" type="date" className="input" value={rec.paid_at} onChange={(e) => setRec({ ...rec, paid_at: e.target.value })} /></Field>
        <Field label="შენიშვნა" htmlFor="rn"><input id="rn" className="input" value={rec.note} onChange={(e) => setRec({ ...rec, note: e.target.value })} /></Field>
        <ErrorBox error={save.error} /></Modal>}
      {toast.node}
    </div>
  );
}
function SettleItems({ labId, name, month, onClose }: { labId: string; name: string; month: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['ext-settle-items', labId, month], queryFn: () => api<ExtItem[]>('/lab/external/settlement/items', { query: { lab_id: labId, month } }) });
  const csv = () => {
    const rows = [['გაგზავნა', 'თარიღი', 'შტრიხკოდი', 'პაციენტი', 'ანალიზი', 'თანხა'], ...(q.data ?? []).map((i) => [i.shipment_no ?? '', i.sent_at ? tsDate(i.sent_at) : '', i.barcode ?? '', `${i.last_name} ${i.first_name}`, i.service_name, i.ext_cost ?? ''])];
    const blob = new Blob(['\ufeff' + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${name}-${month}.csv`; a.click(); URL.revokeObjectURL(a.href);
  };
  return (
    <Modal title={`${name} — ${month}`} onClose={onClose} width={900} footer={<><button className="btn" type="button" onClick={csv} disabled={!q.data?.length}>CSV (Excel)</button><button className="btn" type="button" onClick={onClose}>დახურვა</button></>}>
      {q.isLoading ? <Loading /> : <table className="table"><tbody>{q.data?.map((i) => <tr key={i.id}><td className="mono small">{i.shipment_no}</td><td className="small">{i.sent_at && tsDate(i.sent_at)}</td>
        <td className="mono">{i.barcode}</td><td>{i.last_name} {i.first_name}</td><td>{i.service_name}</td><td className="num mono">{i.ext_cost !== null ? money(Number(i.ext_cost)) : '—'}</td></tr>)}</tbody></table>}
    </Modal>
  );
}

function Labs() {
  const qc = useQueryClient(); const q = useLabs(true);
  const [edit, setEdit] = useState<Partial<ExtLab> | null>(null);
  const save = useMutation({ mutationFn: () => api(edit!.id ? `/lab/external-labs/${edit!.id}` : '/lab/external-labs', { method: edit!.id ? 'PATCH' : 'POST',
    body: { name: edit!.name, contact_person: edit!.contact_person || null, phone: edit!.phone || null, email: edit!.email || null, note: edit!.note || null, ...(edit!.id ? { is_active: edit!.is_active } : {}) } }),
    onSuccess: () => { setEdit(null); void qc.invalidateQueries({ queryKey: ['ext-labs'] }); } });
  return (
    <div className="stack">
      <div className="row"><span className="hint grow">ანალიზს ლაბორატორია, შესყიდვის ფასი და პასუხის ვადა მიეთითება კატალოგში (ანალიზი → „გარე“).</span><button className="btn primary" type="button" onClick={() => setEdit({ is_active: true })}>+ ლაბორატორია</button></div>
      {q.isLoading ? <Loading /> : <div className="card"><table className="table">
        <thead><tr><th>დასახელება</th><th>კონტაქტი</th><th className="num">ანალიზები</th><th>სტატუსი</th></tr></thead>
        <tbody>{q.data?.map((l) => <tr key={l.id} className="clickable" onClick={() => setEdit(l)} style={l.is_active ? undefined : { opacity: 0.55 }}>
          <td><strong>{l.name}</strong>{l.note && <div className="small muted">{l.note}</div>}</td><td className="small">{[l.contact_person, l.phone, l.email].filter(Boolean).join(' · ')}</td>
          <td className="num">{l.services}</td><td>{l.is_active ? <span className="chip ok">აქტიური</span> : <span className="chip">გათიშული</span>}</td></tr>)}</tbody></table></div>}
      {edit && <Modal title={edit.id ? edit.name ?? '' : 'ახალი გარე ლაბორატორია'} onClose={() => setEdit(null)} width={560}
        footer={<><button className="btn" type="button" onClick={() => setEdit(null)}>გაუქმება</button><button className="btn primary" type="button" disabled={!edit.name?.trim() || save.isPending} onClick={() => save.mutate()}>შენახვა</button></>}>
        <Field label="დასახელება" htmlFor="ln" required><input id="ln" className="input" value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label="საკონტაქტო პირი" htmlFor="lc"><input id="lc" className="input" value={edit.contact_person ?? ''} onChange={(e) => setEdit({ ...edit, contact_person: e.target.value })} /></Field>
          <Field label="ტელეფონი" htmlFor="lp"><input id="lp" className="input" value={edit.phone ?? ''} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} /></Field>
          <Field label="ელ-ფოსტა" htmlFor="le"><input id="le" className="input" value={edit.email ?? ''} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></Field>
          <Field label="შენიშვნა" htmlFor="lnote"><input id="lnote" className="input" value={edit.note ?? ''} onChange={(e) => setEdit({ ...edit, note: e.target.value })} /></Field>
        </div>
        {edit.id && <label className="row"><input type="checkbox" checked={!!edit.is_active} onChange={(e) => setEdit({ ...edit, is_active: e.target.checked })} /> აქტიური</label>}
        <ErrorBox error={save.error} /></Modal>}
    </div>
  );
}

// ======================================================================= სტატისტიკა
interface Stats {
  totals: Record<string, number | string | null>; by_service: { id: string; name: string; group_name: string; performed_by: string; n: string; urgent: string; tat_collect_median: number | null; tat_collect_p90: number | null; tat_lab_median: number | null; tat_urgent_median: number | null }[];
  by_day: { day: string; n: string; validated: string }[]; by_hour: { hour: number; n: string }[]; by_validator: { name: string; n: string }[]; by_instrument: { name: string; results: string; orders: string }[];
  manual_results: number; external: Record<string, number | string | null>;
}
const fmtMin = (m: number | string | null) => { if (m === null || m === undefined) return '—'; const v = Number(m); return v < 90 ? `${Math.round(v)} წთ` : v < 2880 ? `${Math.round(v / 6) / 10} სთ` : `${Math.round(v / 144) / 10} დღ`; };
function Bars({ data, label }: { data: { k: string; v: number }[]; label: string }) {
  const max = Math.max(1, ...data.map((d) => d.v));
  return (
    <div className="stack" style={{ gap: 2 }}><span className="small muted">{label}</span>
      <div className="row" style={{ alignItems: 'flex-end', gap: 2, height: 110 }}>{data.map((d) => (
        <div key={d.k} title={`${d.k}: ${d.v}`} style={{ flex: 1, minWidth: 4, height: `${(d.v / max) * 100}%`, background: 'var(--accent)', borderRadius: '2px 2px 0 0', opacity: 0.85 }} />))}</div>
      <div className="row small muted" style={{ justifyContent: 'space-between' }}><span>{data[0]?.k}</span><span>{data[data.length - 1]?.k}</span></div>
    </div>
  );
}
export function LabStats() {
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10)); const [to, setTo] = useState(today);
  const q = useQuery({ queryKey: ['lab-stats', from, to], queryFn: () => api<Stats>('/lab/stats', { query: { from, to } }), enabled: from <= to });
  const t = q.data?.totals;
  const card = (label: string, v: string | number, sub?: string) => <div className="card card-pad stack" style={{ gap: 2, minWidth: 150 }}><span className="small muted">{label}</span><strong style={{ fontSize: 22 }}>{v}</strong>{sub && <span className="small muted">{sub}</span>}</div>;
  return (
    <div className="stack">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <Field label="დან" htmlFor="sf"><input id="sf" type="date" className="input" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="მდე" htmlFor="st"><input id="st" type="date" className="input" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} /></Field>
        <span className="hint grow" style={{ textAlign: 'right' }}>TAT — აღებიდან დადასტურებამდე (მედიანა / 90-ე პროცენტილი); შიდა ანალიზები</span>
      </div>
      <ErrorBox error={q.error} />
      {q.isLoading || !q.data || !t ? <Loading /> : <>
        <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
          {card('შეკვეთა', Number(t.ordered), `დადასტურდა ${t.validated} · ღიაა ${t.open} · გაუქმდა ${t.cancelled}`)}
          {card('TAT (მედიანა)', fmtMin(t.tat_median_min as number), `90 % — ${fmtMin(t.tat_p90_min as number)}`)}
          {card('უარყოფილი სინჯარა', `${t.rejected_specimens} / ${t.specimens}`, Number(t.specimens) ? `${Math.round((Number(t.rejected_specimens) / Number(t.specimens)) * 1000) / 10} %` : undefined)}
          {card('გარე ლაბორატორია', `${q.data.external.sent ?? 0} გაგზ.`, `პასუხი ${q.data.external.resulted ?? 0} · ვადაგადაც. ${q.data.external.overdue ?? 0}${q.data.external.median_days ? ` · მედიანა ${Math.round(Number(q.data.external.median_days) * 10) / 10} დღ` : ''}`)}
          {card('ანალიზატორიდან', q.data.by_instrument.reduce((a, r) => a + Number(r.results), 0), `ხელით: ${q.data.manual_results} შედეგი`)}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16 }}>
          <div className="card card-pad"><Bars label="შეკვეთები დღეების მიხედვით" data={q.data.by_day.map((d) => ({ k: d.day.slice(5), v: Number(d.n) }))} /></div>
          <div className="card card-pad"><Bars label="აღება საათების მიხედვით" data={Array.from({ length: 24 }, (_, h) => ({ k: `${h}:00`, v: Number(q.data!.by_hour.find((x) => Number(x.hour) === h)?.n ?? 0) }))} /></div>
        </div>
        <div className="card" style={{ overflowX: 'auto' }}><table className="table">
          <thead><tr><th>ანალიზი</th><th className="num">რაოდ.</th><th className="num">სასწრ.</th><th className="num">TAT მედიანა</th><th className="num">TAT 90 %</th><th className="num">ლაბ. შიგნით</th><th className="num">სასწრაფოს TAT</th></tr></thead>
          <tbody>{q.data.by_service.map((s) => <tr key={s.id}><td>{s.name} <span className="small muted">{s.group_name}{s.performed_by === 'external' ? ' · გარე' : ''}</span></td>
            <td className="num">{s.n}</td><td className="num">{Number(s.urgent) || ''}</td><td className="num">{fmtMin(s.tat_collect_median)}</td><td className="num">{fmtMin(s.tat_collect_p90)}</td>
            <td className="num">{fmtMin(s.tat_lab_median)}</td><td className="num">{fmtMin(s.tat_urgent_median)}</td></tr>)}</tbody></table></div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div className="card"><table className="table"><thead><tr><th>ვალიდატორი</th><th className="num">დადასტურება</th></tr></thead>
            <tbody>{q.data.by_validator.map((v) => <tr key={v.name}><td>{v.name}</td><td className="num">{v.n}</td></tr>)}</tbody></table></div>
          <div className="card"><table className="table"><thead><tr><th>ანალიზატორი</th><th className="num">შედეგი</th><th className="num">შეკვეთა</th></tr></thead>
            <tbody>{q.data.by_instrument.length ? q.data.by_instrument.map((v) => <tr key={v.name}><td>{v.name}</td><td className="num">{v.results}</td><td className="num">{v.orders}</td></tr>)
              : <tr><td colSpan={3} className="small muted">ანალიზატორიდან შედეგი ჯერ არ მოსულა</td></tr>}</tbody></table></div>
        </div>
      </>}
    </div>
  );
}
