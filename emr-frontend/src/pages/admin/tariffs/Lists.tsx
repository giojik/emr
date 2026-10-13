import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { api, can } from '../../../api/client';
import type { Department } from '../../../api/types';
import { useAuth } from '../../../auth/AuthContext';
import { ErrorBox, Field, Loading, Modal, useDebounced, useToast } from '../../../components/ui';
import { todayISO } from '../../../lib/format';
import type { Payer } from '../BillingSetup';
import { dg, type HistoryRow, KIND_KA, type ListItem, n2, SCOPE_KA, TARIFF_EDIT, type TariffList } from './types';

interface Draft { list_id: string; list_name: string; kind: ListItem['kind']; ref: string; code: string; name: string; action: 'set' | 'end'; value: number | null; current: string | null }

/** ფასთა ნუსხები: არჩეული ნუსხის ჩანაწერები თარიღზე, ისტორია, ცვლილების კალათა → ერთი ცვლილების მოთხოვნა */
export default function Lists() {
  const { user } = useAuth(); const edit = can(user, ...TARIFF_EDIT);
  const lists = useQuery({ queryKey: ['tariff-lists'], queryFn: () => api<TariffList[]>('/tariff-lists') });
  const [sel, setSel] = useState<string | null>(null);
  const [date, setDate] = useState(todayISO()); const [search, setSearch] = useState(''); const [kind, setKind] = useState(''); const [all, setAll] = useState(false);
  const [hist, setHist] = useState<ListItem | null>(null); const [newList, setNewList] = useState(false); const [csv, setCsv] = useState(false);
  const [draft, setDraft] = useState<Draft[]>([]); const [submit, setSubmit] = useState(false);
  const [showOff, setShowOff] = useState(false);
  useEffect(() => { if (!sel && lists.data?.length) setSel(lists.data[0].id); }, [lists.data, sel]);
  const list = lists.data?.find((l) => l.id === sel);
  const dq = useDebounced(search.trim(), 250);
  const items = useQuery({ queryKey: ['tariff-items', sel, date, dq, kind, all], enabled: !!sel,
    queryFn: () => api<{ items: ListItem[] }>(`/tariff-lists/${sel}/items`, { query: { date, search: dq, kind, all } }) });
  const put = (it: ListItem, action: 'set' | 'end', value: number | null) => {
    if (!list) return;
    setDraft((d) => [...d.filter((x) => !(x.list_id === list.id && x.ref === it.ref)),
      { list_id: list.id, list_name: list.name, kind: it.kind, ref: it.ref, code: it.code, name: it.name, action, value, current: it.kind === 'stock_category' ? it.markup_pct : it.price }]);
  };
  const exportCsv = async () => {
    const blob = await api<Blob>(`/tariff-lists/${sel}/csv`, { query: { date }, raw: true });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${list?.code ?? 'list'}_${date}.csv`; a.click(); URL.revokeObjectURL(a.href);
  };
  if (lists.isLoading) return <div className="content"><Loading /></div>;
  return (
    <div className="content" style={{ display: 'grid', gridTemplateColumns: '280px minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
      <section className="card">
        <div className="card-head row"><strong className="grow">ნუსხები</strong>{edit && <button className="btn sm" type="button" onClick={() => setNewList(true)}>+ ნუსხა</button>}</div>
        <div className="stack" style={{ gap: 2, padding: 6 }}>
          {lists.data?.filter((l) => showOff || l.is_active || l.id === sel).map((l) => (
            <button key={l.id} type="button" className={`list-item ${l.id === sel ? 'active' : ''}`} onClick={() => setSel(l.id)}
              style={{ textAlign: 'left', padding: '8px 10px', border: 0, borderRadius: 8, background: l.id === sel ? 'var(--surface-2, #eef2f7)' : 'transparent', cursor: 'pointer', opacity: l.is_active ? 1 : 0.55 }}>
              <div className="row"><span className="grow" style={{ fontWeight: 600 }}>{l.name}</span><span className={`chip ${l.scope === 'base' ? 'accent' : l.scope === 'payer' ? 'info' : ''}`}>{SCOPE_KA[l.scope]}</span></div>
              <div className="small muted">{l.department_name ?? l.payer_name ?? 'ყველა ერთეული'} · {l.items_now} ჩან.{l.items_future ? ` · ${l.items_future} სამომავლო` : ''}{!l.is_active && ' · გათიშული'}</div>
            </button>))}
        </div>
        {(lists.data ?? []).some((l) => !l.is_active) && <label className="row small" style={{ padding: '0 12px' }}><input type="checkbox" checked={showOff} onChange={(e) => setShowOff(e.target.checked)} /> გათიშული ნუსხებიც ({(lists.data ?? []).filter((l) => !l.is_active).length})</label>}
        <div className="small muted" style={{ padding: '4px 12px 12px' }}>ფასის ძებნის რიგი: გადამხდელი → განყოფილება → საბაზო.</div>
      </section>

      <section className="stack" style={{ gap: 12 }}>
        <ErrorBox error={lists.error} />
        {list && <h2 style={{ margin: 0 }}>{list.name} <span className="small muted mono">{list.code}</span></h2>}
        {list && <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <input className="input mono" type="date" aria-label="თარიღი" style={{ width: 150, height: 34 }} value={date} onChange={(e) => setDate(e.target.value || todayISO())} />
          <input className="input" aria-label="ძებნა" placeholder="კოდი ან დასახელება" style={{ width: 220, height: 34 }} value={search} onChange={(e) => setSearch(e.target.value)} />
          <select className="select" aria-label="ტიპი" style={{ height: 34, width: 190 }} value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">ყველა ტიპი</option>{Object.entries(KIND_KA).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          {list.scope !== 'base' && <label className="row small"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> ყველა ერთეული (დასამატებლად)</label>}
          <button className="btn sm" type="button" onClick={() => void exportCsv()}>CSV</button>
          {edit && <button className="btn sm" type="button" onClick={() => setCsv(true)}>იმპორტი</button>}
          {edit && list.scope !== 'base' && <ListActive list={list} />}
        </div>}
        {list && list.scope !== 'base' && !list.is_active && <div className="alert warn">ნუსხა გათიშულია — ფასის ძებნაში არ მონაწილეობს.</div>}
        <ErrorBox error={items.error} />
        {items.isLoading ? <Loading /> : (
          <div className="card" style={{ overflowX: 'auto' }}>
            {!items.data?.items.length ? <div className="empty">{list?.scope === 'base' ? 'ჩანაწერი არ არის.' : 'ნუსხაში ჯერ ჩანაწერი არ არის — მონიშნეთ „ყველა ერთეული“ და დაამატეთ ფასი.'}</div> : (
              <table className="table">
                <thead><tr><th>ტიპი</th><th>კოდი</th><th>დასახელება</th><th className="num">ფასი / %</th>{list?.scope !== 'base' && <th className="num">საბაზო</th>}<th>მოქმედებს</th><th>შემდეგი</th>{edit && <th style={{ width: 210 }}>ცვლილება</th>}</tr></thead>
                <tbody>{items.data.items.map((it) => {
                  const pct = it.kind === 'stock_category'; const d = draft.find((x) => x.list_id === sel && x.ref === it.ref);
                  return (
                    <tr key={it.ref} style={{ opacity: it.is_active ? 1 : 0.55 }}>
                      <td className="small">{KIND_KA[it.kind]}{it.group_name ? <div className="muted">{it.group_name}</div> : null}</td>
                      <td className="mono small"><button type="button" className="linklike" style={{ border: 0, background: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0, font: 'inherit' }} onClick={() => setHist(it)}>{it.code}</button></td>
                      <td>{it.name}{it.pending > 0 && <span className="chip warn" style={{ marginLeft: 6 }}>დასამტკიცებელი</span>}</td>
                      <td className="num mono">{it.item_id ? (pct ? `${Number(it.markup_pct)}%` : n2(it.price)) : <span className="muted">—</span>}</td>
                      {list?.scope !== 'base' && <td className="num mono muted">{pct ? (it.base_markup !== null ? `${Number(it.base_markup)}%` : '—') : n2(it.base_price)}</td>}
                      <td className="small">{it.item_id ? `${it.valid_from ? dg(it.valid_from) : '∞'} — ${it.valid_to ? dg(it.valid_to) : '∞'}` : ''}</td>
                      <td className="small">{it.next ? <span className="chip info">{dg(it.next.valid_from)}: {pct ? `${Number(it.next.markup_pct)}%` : n2(it.next.price)}</span> : ''}</td>
                      {edit && <td><DraftCell it={it} pct={pct} d={d} canEnd={list?.scope !== 'base' || it.kind !== 'tariff'} put={put} remove={() => setDraft((x) => x.filter((y) => y !== d))} /></td>}
                    </tr>);
                })}</tbody>
              </table>)}
          </div>)}
        {draft.length > 0 && (
          <div className="card card-pad row" style={{ position: 'sticky', bottom: 12, boxShadow: '0 6px 24px rgba(0,0,0,.12)', flexWrap: 'wrap' }}>
            <strong className="grow">ცვლილების კალათა: {draft.length} ჩანაწერი{new Set(draft.map((d) => d.list_id)).size > 1 ? ` (${new Set(draft.map((d) => d.list_id)).size} ნუსხა)` : ''}</strong>
            <button className="btn" type="button" onClick={() => setDraft([])}>გასუფთავება</button>
            <button className="btn primary" type="button" onClick={() => setSubmit(true)}>გაგზავნა…</button>
          </div>)}
      </section>
      {hist && list && <HistoryModal list={list} it={hist} onClose={() => setHist(null)} />}
      {newList && <NewListModal onClose={() => setNewList(false)} onCreated={(id) => { setNewList(false); setSel(id); }} />}
      {csv && list && <CsvModal list={list} onClose={() => setCsv(false)} />}
      {submit && <SubmitModal draft={draft} onClose={() => setSubmit(false)} onDone={() => { setSubmit(false); setDraft([]); }} />}
    </div>
  );
}

function DraftCell({ it, pct, d, canEnd, put, remove }: { it: ListItem; pct: boolean; d?: Draft; canEnd: boolean; put: (it: ListItem, a: 'set' | 'end', v: number | null) => void; remove: () => void }) {
  const [v, setV] = useState('');
  if (d) return <span className="row small" style={{ gap: 6 }}><span className="chip accent">{d.action === 'end' ? 'ამოღება' : pct ? `→ ${d.value}%` : `→ ${n2(d.value)}`}</span><button className="btn sm" type="button" onClick={remove}>×</button></span>;
  return (
    <form className="row" style={{ gap: 4 }} onSubmit={(e) => { e.preventDefault(); const x = Number(v.replace(',', '.')); if (v.trim() !== '' && Number.isFinite(x) && x >= 0) { put(it, 'set', Math.round(x * 100) / 100); setV(''); } }}>
      <input className="input mono" style={{ height: 30, width: 90 }} inputMode="decimal" aria-label={`ახალი ${pct ? '%' : 'ფასი'}: ${it.code}`} placeholder={pct ? '%' : 'ფასი'} value={v} onChange={(e) => setV(e.target.value)} />
      <button className="btn sm" type="submit" disabled={!v.trim()}>+</button>
      {it.item_id && canEnd && <button className="btn sm" type="button" title="ნუსხიდან ამოღება (შემდეგი დონის ფასი)" onClick={() => put(it, 'end', null)}>−</button>}
    </form>
  );
}

function ListActive({ list }: { list: TariffList }) {
  const qc = useQueryClient();
  const m = useMutation({ mutationFn: () => api(`/tariff-lists/${list.id}`, { method: 'PATCH', body: { is_active: !list.is_active } }), onSuccess: () => void qc.invalidateQueries({ queryKey: ['tariff-lists'] }) });
  return <button className="btn sm" type="button" disabled={m.isPending} onClick={() => m.mutate()}>{list.is_active ? 'გათიშვა' : 'ჩართვა'}</button>;
}

function HistoryModal({ list, it, onClose }: { list: TariffList; it: ListItem; onClose: () => void }) {
  const h = useQuery({ queryKey: ['tariff-history', list.id, it.ref], queryFn: () => api<HistoryRow[]>(`/tariff-lists/${list.id}/history/${it.ref}`) });
  const pct = it.kind === 'stock_category';
  return (
    <Modal title={`${it.code} — ${it.name}`} onClose={onClose} width={760}>
      <div className="small muted" style={{ marginBottom: 8 }}>{list.name} · {KIND_KA[it.kind]}</div>
      <ErrorBox error={h.error} />
      {h.isLoading ? <Loading /> : !h.data?.length ? <div className="empty">ისტორია არ არის.</div> : (
        <table className="table">
          <thead><tr><th className="num">{pct ? '%' : 'ფასი'}</th><th>დან</th><th>მდე</th><th>ცვლილება</th><th>ვინ</th><th className="num">ხაზები</th></tr></thead>
          <tbody>{h.data.map((r) => (
            <tr key={r.id} style={{ opacity: r.superseded ? 0.5 : 1 }}>
              <td className="num mono">{pct ? `${Number(r.markup_pct)}%` : n2(r.price)}{r.superseded && <div className="small muted">ჩანაცვლებული</div>}</td>
              <td className="small">{r.valid_from ? dg(r.valid_from) : '∞ (მიგრაცია)'}</td><td className="small">{r.valid_to ? dg(r.valid_to) : '∞'}</td>
              <td className="small">{r.change_no ?? (r.valid_from ? 'ძველი ეკრანიდან' : '—')}{r.reason ? <div className="muted">{r.reason}</div> : null}</td>
              <td className="small">{r.by_name ?? '—'}</td><td className="num">{r.lines}</td>
            </tr>))}</tbody>
        </table>)}
    </Modal>
  );
}

function SubmitModal({ draft, onClose, onDone }: { draft: Draft[]; onClose: () => void; onDone: () => void }) {
  const qc = useQueryClient(); const toast = useToast();
  const [title, setTitle] = useState(''); const [reason, setReason] = useState(''); const [from, setFrom] = useState(todayISO());
  const m = useMutation({
    mutationFn: () => api<{ status: string; change_no: string }>('/tariff-changes', { body: { title: title.trim(), reason: reason.trim(), items: draft.map((d) => ({
      list_id: d.list_id, kind: d.kind, ref: d.ref, action: d.action, valid_from: from, ...(d.action === 'set' ? (d.kind === 'stock_category' ? { markup_pct: d.value } : { price: d.value }) : {}) })) } }),
    onSuccess: (r) => { toast.show(r.status === 'applied' ? `${r.change_no} — გატარდა` : `${r.change_no} — გაიგზავნა დასამტკიცებლად`);
      void qc.invalidateQueries({ queryKey: ['tariff-items'] }); void qc.invalidateQueries({ queryKey: ['tariff-lists'] }); void qc.invalidateQueries({ queryKey: ['tariff-changes'] }); onDone(); },
  });
  return (
    <Modal title="ცვლილების მოთხოვნა" onClose={onClose} width={720}
      footer={<><button className="btn" type="button" onClick={onClose}>დახურვა</button><button className="btn primary" type="submit" form="tcs" disabled={m.isPending || title.trim().length < 3 || reason.trim().length < 3}>გაგზავნა</button></>}>
      {toast.node}
      <form id="tcs" className="stack" style={{ gap: 12 }} onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
          <Field label="სათაური" htmlFor="tct" required><input id="tct" className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="მაგ. 2027 წლის ინდექსაცია" /></Field>
          <Field label="მოქმედებს" htmlFor="tcf" required hint="დღეიდან ან მომავლიდან"><input id="tcf" className="input mono" type="date" min={todayISO()} value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        </div>
        <Field label="მიზეზი / საფუძველი" htmlFor="tcr" required><textarea id="tcr" className="textarea" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="ხელშეკრულება № …, ბრძანება …" /></Field>
        <table className="table">
          <thead><tr><th>ნუსხა</th><th>კოდი</th><th>დასახელება</th><th className="num">ახლა</th><th className="num">ახალი</th></tr></thead>
          <tbody>{draft.map((d) => (
            <tr key={`${d.list_id}${d.ref}`}><td className="small">{d.list_name}</td><td className="mono small">{d.code}</td><td>{d.name}</td>
              <td className="num mono muted">{d.current === null ? '—' : d.kind === 'stock_category' ? `${Number(d.current)}%` : n2(d.current)}</td>
              <td className="num mono">{d.action === 'end' ? 'ამოღება' : d.kind === 'stock_category' ? `${d.value}%` : n2(d.value)}</td></tr>))}</tbody>
        </table>
        <span className="hint">უკვე გამოწერილ ინვოისის ხაზებს ცვლილება არ ეხება — ფასი ხაზზე ფიქსირდება შექმნისას (საჭიროებისას — „გადაფასება“ ბილინგში).</span>
        <ErrorBox error={m.error} />
      </form>
    </Modal>
  );
}

function NewListModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const deps = useQuery({ queryKey: ['departments'], queryFn: () => api<Department[]>('/departments') });
  const payers = useQuery({ queryKey: ['billing-payers'], queryFn: () => api<Payer[]>('/billing/payers') });
  const [scope, setScope] = useState<'department' | 'payer'>('payer'); const [ref, setRef] = useState(''); const [code, setCode] = useState(''); const [name, setName] = useState('');
  const opts = useMemo(() => (scope === 'department' ? (deps.data ?? []).filter((d) => d.is_active).map((d) => ({ id: d.id, name: d.name })) : (payers.data ?? []).filter((p) => p.is_active).map((p) => ({ id: p.id, name: p.name }))), [scope, deps.data, payers.data]);
  const m = useMutation({
    mutationFn: () => api<{ id: string }>('/tariff-lists', { body: { code, name: name.trim(), scope, ...(scope === 'department' ? { department_id: ref } : { payer_id: ref }) } }),
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ['tariff-lists'] }); onCreated(r.id); },
  });
  return (
    <Modal title="ახალი ფასთა ნუსხა" onClose={onClose} width={520}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="submit" form="tnl" disabled={m.isPending || !ref || !code || name.trim().length < 2}>შექმნა</button></>}>
      <form id="tnl" className="stack" style={{ gap: 12 }} onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <div className="seg" role="group" aria-label="ნუსხის ტიპი">
          <button type="button" aria-pressed={scope === 'payer'} onClick={() => { setScope('payer'); setRef(''); }}>გადამხდელის (ხელშეკრულება)</button>
          <button type="button" aria-pressed={scope === 'department'} onClick={() => { setScope('department'); setRef(''); }}>განყოფილების</button></div>
        <Field label={scope === 'payer' ? 'გადამხდელი' : 'განყოფილება'} htmlFor="tnr" required>
          <select id="tnr" className="select" value={ref} onChange={(e) => { setRef(e.target.value); if (!name) setName(opts.find((o) => o.id === e.target.value)?.name ?? ''); }}>
            <option value="">— აირჩიეთ —</option>{opts.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></Field>
        <Field label="კოდი" htmlFor="tnc" required hint="დიდი ლათინური, ციფრები, _ . -"><input id="tnc" className="input mono" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} /></Field>
        <Field label="დასახელება" htmlFor="tnn" required><input id="tnn" className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <span className="hint">ნუსხაში შეიტანეთ მხოლოდ ის ფასები, რომლებიც საბაზოსგან განსხვავდება — დანარჩენი მოიძებნება შემდეგ დონეზე.</span>
        <ErrorBox error={m.error} />
      </form>
    </Modal>
  );
}

function CsvModal({ list, onClose }: { list: TariffList; onClose: () => void }) {
  const qc = useQueryClient(); const toast = useToast();
  const [csv, setCsv] = useState(''); const [from, setFrom] = useState(todayISO()); const [title, setTitle] = useState(`${list.name} — CSV`); const [reason, setReason] = useState('');
  const m = useMutation({
    mutationFn: () => api<{ status: string; change_no: string }>('/tariff-changes/import', { body: { list_id: list.id, valid_from: from, title, reason, csv } }),
    onSuccess: (r) => { toast.show(`${r.change_no} — ${r.status === 'applied' ? 'გატარდა' : 'დასამტკიცებელი'}`); void qc.invalidateQueries({ queryKey: ['tariff-items'] }); void qc.invalidateQueries({ queryKey: ['tariff-changes'] }); setTimeout(onClose, 600); },
  });
  const errs = (m.error as { body?: { errors?: string[] } } | null)?.body?.errors;
  return (
    <Modal title={`CSV იმპორტი — ${list.name}`} onClose={onClose} width={680}
      footer={<><button className="btn" type="button" onClick={onClose}>დახურვა</button><button className="btn primary" type="submit" form="tci" disabled={m.isPending || !csv.trim() || reason.trim().length < 3}>იმპორტი</button></>}>
      {toast.node}
      <form id="tci" className="stack" style={{ gap: 12 }} onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <span className="hint">ფორმატი: <span className="mono">kind;code;price</span> ან <span className="mono">code;price</span> (kind: tariff / stock_item / stock_category — კატეგორიაზე მნიშვნელობა = ფასნამატი %). ცარიელი ფასი — ნუსხიდან ამოღება. შეიძლება ექსპორტირებული ფაილის ჩასმაც.</span>
        <input type="file" accept=".csv,text/csv" aria-label="CSV ფაილი" onChange={(e) => { const f = e.target.files?.[0]; if (f) void f.text().then(setCsv); }} />
        <textarea className="textarea mono" rows={8} aria-label="CSV" value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={'code;price\nCONS_CARDIO;80'} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 160px', gap: 12 }}>
          <Field label="სათაური" htmlFor="tcit" required><input id="tcit" className="input" value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
          <Field label="მოქმედებს" htmlFor="tcif" required><input id="tcif" className="input mono" type="date" min={todayISO()} value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        </div>
        <Field label="მიზეზი" htmlFor="tcir" required><input id="tcir" className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        {errs?.length ? <div className="alert danger small"><strong>შეცდომები:</strong><ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{errs.map((x) => <li key={x}>{x}</li>)}</ul></div> : <ErrorBox error={m.error} />}
      </form>
    </Modal>
  );
}
