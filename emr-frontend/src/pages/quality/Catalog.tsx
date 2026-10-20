import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import { ErrorBox, Loading, useToast } from '../../components/ui';
import QmIndicators from './Indicators';
import type { Classifier } from './types';

type Kind = 'category' | 'factor';
type Tab = Kind | 'indicator';
const KIND_KA: Record<Tab, [string, string]> = {
  category: ['კატეგორიები', 'კატეგორია → ქვეკატეგორია. ⚑ სენტინელური ქვეკატეგორია — ინციდენტი ავტომატურად სასწრაფოა; „მედიკამენტი“ — NCC MERP ველი.'],
  factor: ['ხელშემწყობი ფაქტორები', 'London Protocol: ჯგუფი → ფაქტორი. გამოიყენება ანალიზში (მიმოხილვა / RCA) და ანგარიშში.'],
  indicator: ['ინდიკატორები', ''],
};

/** ცნობარები (quality): დამატება, სახელის / ნიშნების / რიგის შეცვლა, გათიშვა (ისტორია რჩება — წაშლა არ არის) */
export default function QmCatalog() {
  const [tab, setTab] = useState<Tab>('category');
  const kind: Kind = tab === 'indicator' ? 'category' : tab;
  const q = useQuery({ queryKey: ['qm-classifiers', kind, 'all'], queryFn: () => api<Classifier[]>('/quality/classifiers', { query: { kind, all: 'true' } }), enabled: tab !== 'indicator' });
  const roots = (q.data ?? []).filter((c) => !c.parent_id);
  return (
    <div className="content">
      <div className="row"><div className="seg" role="group" aria-label="ცნობარი">{(Object.keys(KIND_KA) as Tab[]).map((k) =>
        <button key={k} type="button" aria-pressed={tab === k} onClick={() => setTab(k)}>{KIND_KA[k][0]}</button>)}</div>
        <span className="small muted grow">{KIND_KA[tab][1]}</span></div>
      {tab === 'indicator' ? <QmIndicators /> : <>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : (
        <div className="stack">
          {roots.map((r) => <Group key={r.id} root={r} kind={kind} items={(q.data ?? []).filter((c) => c.parent_id === r.id)} />)}
          <AddRow kind={kind} parent={null} />
        </div>)}</>}
    </div>
  );
}

function Group({ root, items, kind }: { root: Classifier; items: Classifier[]; kind: Kind }) {
  return (
    <section className="card card-pad stack" style={{ gap: 6, opacity: root.is_active ? 1 : 0.6 }}>
      <ItemRow c={root} kind={kind} strong />
      <div className="stack" style={{ gap: 4, paddingLeft: 18 }}>
        {items.map((c) => <ItemRow key={c.id} c={c} kind={kind} />)}
        <AddRow kind={kind} parent={root} />
      </div>
    </section>
  );
}

function ItemRow({ c, kind, strong }: { c: Classifier; kind: Kind; strong?: boolean }) {
  const qc = useQueryClient(); const toast = useToast();
  const [edit, setEdit] = useState(false); const [name, setName] = useState(c.name);
  const save = useMutation({
    mutationFn: (b: Partial<Classifier>) => api(`/quality/classifiers/${c.id}`, { method: 'PATCH', body: b }),
    onSuccess: () => { setEdit(false); toast.show('შენახულია'); void qc.invalidateQueries({ queryKey: ['qm-classifiers'] }); },
  });
  return (
    <div className="row" style={{ gap: 8, opacity: c.is_active ? 1 : 0.55 }}>
      {toast.node}
      {edit ? <><input className="input" style={{ maxWidth: 360, height: 34 }} aria-label="დასახელება" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn sm primary" type="button" disabled={name.trim().length < 2 || save.isPending} onClick={() => save.mutate({ name: name.trim() })}>შენახვა</button>
        <button className="btn sm" type="button" onClick={() => { setEdit(false); setName(c.name); }}>გაუქმება</button></>
        : <span className="grow" style={{ fontWeight: strong ? 600 : 400 }}>{c.name} <span className="muted mono small">{c.code}</span>
          {c.is_sentinel && <span className="chip danger" style={{ marginLeft: 6, height: 20 }}>⚑ სენტინელური</span>}
          {c.is_medication && <span className="chip info" style={{ marginLeft: 6, height: 20 }}>მედიკამენტი · MERP</span>}
          {c.used > 0 && <span className="small muted"> · {c.used} ინციდენტი</span>}
          {!c.is_active && <span className="chip" style={{ marginLeft: 6, height: 20 }}>გათიშული</span>}</span>}
      {!edit && <>
        {kind === 'category' && c.parent_id && <label className="row small"><input type="checkbox" checked={c.is_sentinel} onChange={(e) => save.mutate({ is_sentinel: e.target.checked })} /> სენტინელური</label>}
        {kind === 'category' && !c.parent_id && <label className="row small"><input type="checkbox" checked={c.is_medication} onChange={(e) => save.mutate({ is_medication: e.target.checked })} /> მედიკამენტი</label>}
        <button className="btn sm" type="button" onClick={() => setEdit(true)}>სახელი</button>
        <button className="btn sm" type="button" onClick={() => save.mutate({ is_active: !c.is_active })}>{c.is_active ? 'გათიშვა' : 'ჩართვა'}</button></>}
      <ErrorBox error={save.error} />
    </div>
  );
}

function AddRow({ kind, parent }: { kind: Kind; parent: Classifier | null }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false); const [f, setF] = useState({ code: '', name: '', is_sentinel: false });
  const add = useMutation({
    mutationFn: () => api('/quality/classifiers', { body: { kind, parent_id: parent?.id ?? null, code: f.code, name: f.name.trim(), ...(parent && kind === 'category' && { is_sentinel: f.is_sentinel }) } }),
    onSuccess: () => { setOpen(false); setF({ code: '', name: '', is_sentinel: false }); void qc.invalidateQueries({ queryKey: ['qm-classifiers'] }); },
  });
  if (!open) return <div><button className="btn sm" type="button" onClick={() => setOpen(true)}>+ {parent ? 'ქვეელემენტი' : kind === 'category' ? 'კატეგორია' : 'ჯგუფი'}</button></div>;
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div className="row" style={{ gap: 6 }}>
        <input className="input mono" style={{ maxWidth: 180, height: 34 }} aria-label="კოდი" placeholder="კოდი (lat_a_z)" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') })} />
        <input className="input" style={{ maxWidth: 320, height: 34 }} aria-label="დასახელება" placeholder="დასახელება" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        {parent && kind === 'category' && <label className="row small"><input type="checkbox" checked={f.is_sentinel} onChange={(e) => setF({ ...f, is_sentinel: e.target.checked })} /> სენტინელური</label>}
        <button className="btn sm primary" type="button" disabled={!/^[a-z][a-z0-9_]{1,39}$/.test(f.code) || f.name.trim().length < 2 || add.isPending} onClick={() => add.mutate()}>დამატება</button>
        <button className="btn sm" type="button" onClick={() => setOpen(false)}>გაუქმება</button>
      </div>
      <ErrorBox error={add.error} />
    </div>
  );
}
