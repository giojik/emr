import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, can } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Field, Loading, Modal, useDebounced } from '../../components/ui';
import { IPC_FULL } from './types';

interface GroupItem { item_id: string; factor: number; code: string; name: string; base_unit: string; is_active: boolean }
interface Group { id: string; code: string; name: string; unit_label: string; per_days: number; target: string | null; is_active: boolean; sort_order: number; items: GroupItem[] }
interface Rates {
  from: string; to: string; source: string; patient_days: number;
  groups: { id: string; code: string; name: string; unit_label: string; per_days: number; target: number | null; items: number; qty: number; rate: number | null;
    months: { ym: string; qty: number; patient_days: number; rate: number | null }[];
    departments: { department_id: string; department: string; qty: number; patient_days: number; rate: number | null }[] }[];
}

const todayTb = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tbilisi' }).format(new Date());
const monthStart = () => `${todayTb().slice(0, 7)}-01`;
const SRC_KA: Record<string, string> = { issue: 'განყოფილებაზე გაცემა / გადატანა (ნეტო)', consumption: 'განყოფილების ხარჯი / ჩამოწერა' };
const fmt = (n: number | null) => (n === null ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: 2 }));
const low = (r: number | null, t: number | null) => r !== null && t !== null && r < t;

/** IPC მასალები (0071): ხარჯი / 1000 პაციენტ-დღე (ხელის ანტისეპტიკი და სხვ.), ჯგუფები და საწყობის საქონელი */
export default function MaterialsTab() {
  const { user } = useAuth(); const full = can(user, ...IPC_FULL);
  const [view, setView] = useState<'rates' | 'groups'>('rates');
  return (
    <div className="content">
      <div className="seg" role="group" aria-label="მასალები">
        {([['rates', 'მოხმარება'], ['groups', 'ჯგუფები და საქონელი']] as const).map(([k, l]) => <button key={k} type="button" aria-pressed={view === k} onClick={() => setView(k)}>{l}</button>)}
      </div>
      {view === 'rates' && <RatesView />}
      {view === 'groups' && <Groups edit={full} />}
    </div>
  );
}

function RatesView() {
  const [from, setFrom] = useState(monthStart()); const [to, setTo] = useState(todayTb()); const [dept, setDept] = useState('');
  const depts = useQuery({ queryKey: ['departments'], queryFn: () => api<{ id: string; name: string; type: string }[]>('/departments'), staleTime: 5 * 60_000 });
  const q = useQuery({ queryKey: ['ipc-mat-rates', from, to, dept], queryFn: () => api<Rates>('/ipc/materials/rates', { query: { from, to, department_id: dept } }), enabled: !!from && !!to && from <= to });
  return (
    <>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <input type="date" className="input" style={{ maxWidth: 160, height: 38 }} aria-label="დან" value={from} onChange={(e) => setFrom(e.target.value)} />
        <input type="date" className="input" style={{ maxWidth: 160, height: 38 }} aria-label="მდე" value={to} onChange={(e) => setTo(e.target.value)} />
        <select className="select" style={{ maxWidth: 240, height: 38 }} aria-label="განყოფილება" value={dept} onChange={(e) => setDept(e.target.value)}>
          <option value="">ყველა განყოფილება</option>{depts.data?.filter((d) => d.type !== 'administrative').map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
      </div>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : q.data && <>
        <div className="small muted">წყარო: {SRC_KA[q.data.source]} (ადმინისტრირება → მოდულები). მნიშვნელი — პაციენტ-დღე: <strong>{q.data.patient_days}</strong> (device-days ფაქტიდან; „მაჩვენებლები“ → „გადათვლა“).</div>
        {!q.data.groups.length && <div className="alert">აქტიური ჯგუფი არ არის.</div>}
        {q.data.groups.map((g) => (
          <section key={g.id} className="card card-pad stack" style={{ gap: 10, flexShrink: 0 }}>
            <div className="row" style={{ alignItems: 'baseline', flexWrap: 'wrap' }}>
              <strong className="grow">{g.name}</strong>
              {!g.items && <span className="chip warn">საქონელი არ არის მიბმული</span>}
            </div>
            {!g.items ? <span className="small muted">მიაბით საწყობის საქონელი: „ჯგუფები და საქონელი“ → „საქონელი“ (კოეფიციენტით).</span> : <>
            <div className="row" style={{ gap: 24, flexWrap: 'wrap' }}>
              <div><div className="small muted">{g.unit_label} / {g.per_days} პაციენტ-დღე</div>
                <strong style={{ fontSize: 26, color: low(g.rate, g.target) ? 'var(--danger-ink)' : undefined }}>{fmt(g.rate)}</strong>
                {g.target !== null && <div className="small muted">სამიზნე ≥ {fmt(g.target)}</div>}</div>
              <div><div className="small muted">სულ ({g.unit_label})</div><strong style={{ fontSize: 20 }}>{fmt(g.qty)}</strong></div>
            </div>
            {g.months.length > 1 && <table className="table" style={{ fontSize: 13 }}>
              <thead><tr><th>თვე</th><th className="num">{g.unit_label}</th><th className="num">პაციენტ-დღე</th><th className="num">/ {g.per_days}</th></tr></thead>
              <tbody>{g.months.map((m) => <tr key={m.ym}><td className="mono">{m.ym}</td><td className="num">{fmt(m.qty)}</td><td className="num">{m.patient_days}</td>
                <td className="num" style={{ color: low(m.rate, g.target) ? 'var(--danger-ink)' : undefined }}>{fmt(m.rate)}</td></tr>)}</tbody>
            </table>}
            <table className="table" style={{ fontSize: 13 }}>
              <thead><tr><th>განყოფილება</th><th className="num">{g.unit_label}</th><th className="num">პაციენტ-დღე</th><th className="num">/ {g.per_days}</th></tr></thead>
              <tbody>{g.departments.map((d) => <tr key={d.department_id}><td>{d.department}</td><td className="num">{fmt(d.qty)}</td><td className="num">{d.patient_days}</td>
                <td className="num" style={{ color: low(d.rate, g.target) ? 'var(--danger-ink)' : undefined }}><strong>{fmt(d.rate)}</strong></td></tr>)}
                {!g.departments.length && <tr><td colSpan={4} className="muted">მონაცემი არ არის</td></tr>}</tbody>
            </table></>}
          </section>))}
      </>}
    </>
  );
}

function Groups({ edit }: { edit: boolean }) {
  const q = useQuery({ queryKey: ['ipc-mat-groups'], queryFn: () => api<Group[]>('/ipc/materials/groups') });
  const [g, setG] = useState<Group | 'new' | null>(null); const [items, setItems] = useState<Group | null>(null);
  return (
    <>
      {edit && <div className="row"><span className="grow" /><button className="btn primary" type="button" onClick={() => setG('new')}>+ ჯგუფი</button></div>}
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : (
        <div className="card" style={{ overflowX: 'auto', flexShrink: 0 }}>
          <table className="table">
            <thead><tr><th>ჯგუფი</th><th>ერთეული</th><th className="num">სამიზნე</th><th>საწყობის საქონელი (კოეფიციენტი)</th><th /></tr></thead>
            <tbody>{q.data?.map((x) => (
              <tr key={x.id} style={!x.is_active ? { opacity: 0.55 } : undefined}>
                <td><strong>{x.name}</strong><div className="small muted mono">{x.code}{!x.is_active && ' · გათიშული'}</div></td>
                <td className="small">{x.unit_label} / {x.per_days} პ.-დღე</td>
                <td className="num">{x.target === null ? '—' : `≥ ${Number(x.target)}`}</td>
                <td className="small">{x.items.length ? x.items.map((i) => <div key={i.item_id}>{i.name} <span className="muted">— 1 {i.base_unit} = {i.factor} {x.unit_label}</span></div>)
                  : <span className="chip warn">არ არის მიბმული</span>}</td>
                <td>{edit && <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                  <button className="btn sm" type="button" onClick={() => setItems(x)}>საქონელი</button><button className="btn sm" type="button" onClick={() => setG(x)}>რედაქტირება</button></div>}</td>
              </tr>))}
              {!q.data?.length && <tr><td colSpan={5} className="muted">ჯგუფი არ არის</td></tr>}
            </tbody>
          </table>
        </div>)}
      {g && <GroupDialog g={g === 'new' ? null : g} onClose={() => setG(null)} />}
      {items && <ItemsDialog g={items} onClose={() => setItems(null)} />}
    </>
  );
}

function GroupDialog({ g, onClose }: { g: Group | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ code: g?.code ?? '', name: g?.name ?? '', unit_label: g?.unit_label ?? '', per_days: g?.per_days ?? 1000, target: g?.target ?? '', is_active: g?.is_active ?? true });
  const m = useMutation({ mutationFn: () => {
    const body = { name: f.name.trim(), unit_label: f.unit_label.trim(), per_days: Number(f.per_days), target: f.target === '' ? null : Number(f.target), is_active: f.is_active };
    return g ? api(`/ipc/materials/groups/${g.id}`, { method: 'PATCH', body }) : api('/ipc/materials/groups', { body: { ...body, code: f.code.trim() } });
  }, onSuccess: () => { void qc.invalidateQueries({ queryKey: ['ipc-mat-groups'] }); void qc.invalidateQueries({ queryKey: ['ipc-mat-rates'] }); onClose(); } });
  return (
    <Modal title={g ? 'ჯგუფის რედაქტირება' : 'ახალი ჯგუფი'} onClose={onClose} width={560} footer={<>
      <button className="btn" type="button" onClick={onClose}>გაუქმება</button>
      <button className="btn primary" type="button" disabled={m.isPending || f.name.trim().length < 2 || !f.unit_label.trim() || (!g && !/^[a-z][a-z0-9_]{1,19}$/.test(f.code))} onClick={() => m.mutate()}>შენახვა</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <ErrorBox error={m.error} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
          <Field label="კოდი" htmlFor="gc" required hint="ლათინური, პატარა ასოები"><input id="gc" className="input mono" value={f.code} disabled={!!g} onChange={(e) => setF({ ...f, code: e.target.value })} placeholder="gloves" /></Field>
          <Field label="სახელი" htmlFor="gn" required><input id="gn" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="ერთეული" htmlFor="gu" required><input id="gu" className="input" value={f.unit_label} maxLength={12} onChange={(e) => setF({ ...f, unit_label: e.target.value })} placeholder="ლ / წყვილი / ც" /></Field>
          <Field label="მნიშვნელი" htmlFor="gp"><select id="gp" className="select" value={f.per_days} onChange={(e) => setF({ ...f, per_days: Number(e.target.value) })}>
            {[1, 10, 100, 1000].map((n) => <option key={n} value={n}>{n} პაციენტ-დღე</option>)}</select></Field>
          <Field label="სამიზნე (მინიმუმი)" htmlFor="gt" hint="მაგ. WHO — ≥ 20 ლ / 1000"><input id="gt" type="number" min={0} step="0.1" className="input" value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })} /></Field>
          <label className="row small" style={{ gap: 6, alignSelf: 'end', height: 42 }}><input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> აქტიური</label>
        </div>
      </div>
    </Modal>
  );
}

function ItemsDialog({ g, onClose }: { g: Group; onClose: () => void }) {
  const qc = useQueryClient();
  const [rows, setRows] = useState(g.items.map((i) => ({ item_id: i.item_id, name: i.name, base_unit: i.base_unit, factor: String(i.factor) })));
  const [search, setSearch] = useState(''); const ds = useDebounced(search.trim(), 300);
  const found = useQuery({ queryKey: ['ipc-mat-items', ds], queryFn: () => api<{ id: string; code: string; name: string; base_unit: string }[]>('/ipc/materials/stock-items', { query: { q: ds } }),
    enabled: ds.length >= 2 });
  const m = useMutation({ mutationFn: () => api(`/ipc/materials/groups/${g.id}/items`, { method: 'PUT', body: { items: rows.map((r) => ({ item_id: r.item_id, factor: Number(r.factor) })) } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['ipc-mat-groups'] }); void qc.invalidateQueries({ queryKey: ['ipc-mat-rates'] }); onClose(); } });
  const valid = rows.every((r) => Number(r.factor) > 0);
  return (
    <Modal title={`საქონელი — ${g.name}`} onClose={onClose} width={720} footer={<>
      <button className="btn" type="button" onClick={onClose}>გაუქმება</button>
      <button className="btn primary" type="button" disabled={!valid || m.isPending} onClick={() => m.mutate()}>შენახვა</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <ErrorBox error={m.error} />
        <div className="small muted">კოეფიციენტი: საწყობის საბაზო ერთეული → „{g.unit_label}“ (მაგ. 500 მლ ფლაკონი = 0.5 ლ; 100 ცალიანი შეკვრა ხელთათმანი = 50 წყვილი).</div>
        <table className="table">
          <thead><tr><th>საქონელი</th><th>1 საბაზო ერთეული =</th><th /></tr></thead>
          <tbody>{rows.map((r, i) => (
            <tr key={r.item_id}><td>{r.name} <span className="small muted">({r.base_unit})</span></td>
              <td><div className="row" style={{ gap: 6 }}><input className="input" style={{ maxWidth: 120, height: 34 }} type="number" min={0} step="any" aria-label="კოეფიციენტი" value={r.factor}
                onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, factor: e.target.value } : x)))} /> {g.unit_label}</div></td>
              <td><button className="btn sm" type="button" onClick={() => setRows(rows.filter((_, j) => j !== i))}>მოხსნა</button></td></tr>))}
            {!rows.length && <tr><td colSpan={3} className="muted">საქონელი არ არის</td></tr>}
          </tbody>
        </table>
        <Field label="დამატება" htmlFor="is"><input id="is" className="input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="საწყობის საქონელი — დასახელება ან კოდი" /></Field>
        {(found.data ?? []).filter((x) => !rows.some((r) => r.item_id === x.id)).slice(0, 10).map((x) => (
          <div key={x.id} className="row small" style={{ gap: 8 }}><span className="grow">{x.name} <span className="muted mono">{x.code} · {x.base_unit}</span></span>
            <button className="btn sm" type="button" onClick={() => setRows([...rows, { item_id: x.id, name: x.name, base_unit: x.base_unit, factor: '1' }])}>+ დამატება</button></div>))}
      </div>
    </Modal>
  );
}
