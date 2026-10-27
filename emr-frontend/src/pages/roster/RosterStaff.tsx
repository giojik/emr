import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import { ErrorBox, Field, Loading, Modal, useDebounced, useToast } from '../../components/ui';
import { dateGe } from '../../lib/format';
import { CAT_KA, EMP_KA, type Category, type Refs, type Staff } from './types';

/** თანამშრომლები (0077): ანგარიშიანი და ანგარიშის გარეშე, პოზიცია, ძირითადი / დამატებითი განყოფილებები, განაკვეთი */
export default function RosterStaffPage({ refs }: { refs: Refs }) {
  const toast = useToast(); const qc = useQueryClient();
  const [f, setF] = useState({ search: '', department_id: '', category: '', active: '1', no_user: false });
  const ds = useDebounced(f.search.trim(), 300);
  const q = useQuery({ queryKey: ['roster-staff', { ...f, search: ds }], queryFn: () => api<Staff[]>('/roster/staff', { query: { ...f, search: ds, no_user: f.no_user ? '1' : undefined } }) });
  const [edit, setEdit] = useState<Staff | 'new' | null>(null); const [imp, setImp] = useState(false);
  const canAdd = refs.can.staff_all || refs.can.edit_depts.length > 0;
  const done = (m: string) => { setEdit(null); setImp(false); toast.show(m); void qc.invalidateQueries({ queryKey: ['roster-staff'] }); void qc.invalidateQueries({ queryKey: ['roster'] }); };
  return (
    <div className="content">
      {toast.node}
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <input className="input" style={{ maxWidth: 260, height: 38 }} aria-label="ძებნა" placeholder="სახელი, გვარი, პირადი №" value={f.search} onChange={(e) => setF({ ...f, search: e.target.value })} />
        <select className="select" aria-label="განყოფილება" style={{ maxWidth: 240, height: 38 }} value={f.department_id} onChange={(e) => setF({ ...f, department_id: e.target.value })}>
          <option value="">ყველა განყოფილება</option>{refs.departments.filter((d) => d.can_view).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
        <select className="select" aria-label="კატეგორია" style={{ maxWidth: 190, height: 38 }} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
          <option value="">ყველა კატეგორია</option>{(Object.keys(CAT_KA) as Category[]).map((k) => <option key={k} value={k}>{CAT_KA[k]}</option>)}</select>
        <select className="select" aria-label="სტატუსი" style={{ maxWidth: 150, height: 38 }} value={f.active} onChange={(e) => setF({ ...f, active: e.target.value })}>
          <option value="1">აქტიური</option><option value="0">გათიშული</option><option value="all">ყველა</option></select>
        <label className="row small"><input type="checkbox" checked={f.no_user} onChange={(e) => setF({ ...f, no_user: e.target.checked })} /> ანგარიშის გარეშე</label>
        <span className="grow" />
        {canAdd && <><button className="btn" type="button" onClick={() => setImp(true)}>მომხმარებლებიდან</button><button className="btn primary" type="button" onClick={() => setEdit('new')}>+ თანამშრომელი</button></>}
      </div>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : <div className="card" style={{ overflowX: 'auto' }}><table className="table">
        <thead><tr><th>თანამშრომელი</th><th>პოზიცია</th><th>განყოფილება</th><th>განაკვ.</th><th>ურთიერთობა</th><th>EMR ანგარიში</th><th>ტელეფონი</th></tr></thead>
        <tbody>{q.data?.map((s) => <tr key={s.id} className="clickable" onClick={() => setEdit(s)}>
          <td><strong>{s.name}</strong>{!s.is_active && <span className="chip" style={{ marginLeft: 6 }}>გათიშული</span>}{s.personal_number && <div className="small muted mono">{s.personal_number}</div>}</td>
          <td>{s.position_name ?? <span className="muted">—</span>}{s.category && <div className="small muted">{CAT_KA[s.category]}</div>}</td>
          <td>{s.department_name}{s.extra_department_ids.length > 0 && <div className="small muted">+ {s.extra_department_ids.map((x) => refs.departments.find((d) => d.id === x)?.name ?? '?').join(', ')}</div>}</td>
          <td className="mono">{Number(s.fte)}</td>
          <td className="small">{EMP_KA[s.employment] ?? s.employment}{(s.hired_on || s.left_on) && <div className="muted">{s.hired_on ? dateGe(s.hired_on) : '…'} – {s.left_on ? dateGe(s.left_on) : ''}</div>}</td>
          <td className="small">{s.user_id ? <>{s.user_email}{s.user_active === false && <span className="chip" style={{ marginLeft: 4 }}>გათიშ.</span>}</> : <span className="chip info">ანგარიშის გარეშე</span>}</td>
          <td className="mono small">{s.phone ?? ''}</td></tr>)}
          {!q.data?.length && <tr><td colSpan={7} className="muted">თანამშრომელი არ მოიძებნა</td></tr>}</tbody></table></div>}
      {edit && <StaffDialog refs={refs} s={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onDone={() => done('შენახულია')} />}
      {imp && <FromUsersDialog refs={refs} onClose={() => setImp(false)} onDone={(n) => done(`დაემატა ${n}`)} />}
    </div>
  );
}

interface UserRow { id: string; name: string; email: string; department_id: string | null; department_name: string | null; specialty: string | null }
function UserPicker({ onPick }: { onPick: (u: UserRow) => void }) {
  const [q, setQ] = useState(''); const dq = useDebounced(q.trim(), 250);
  const r = useQuery({ queryKey: ['roster-users', dq], queryFn: () => api<UserRow[]>('/roster/users-without-staff', { query: { search: dq } }), enabled: dq.length >= 2 });
  return <div style={{ position: 'relative' }}>
    <input className="input" aria-label="მომხმარებლის ძებნა" placeholder="EMR მომხმარებელი — სახელი / ელფოსტა (არჩევითი)" value={q} onChange={(e) => setQ(e.target.value)} />
    {dq.length >= 2 && (r.data?.length ?? 0) > 0 && <ul className="listbox" role="listbox" aria-label="მომხმარებლები" style={{ position: 'absolute', top: 46, left: 0, right: 0, zIndex: 6 }}>
      {r.data!.map((u) => <li key={u.id} role="option" aria-selected={false} onMouseDown={(e) => { e.preventDefault(); onPick(u); setQ(''); }}><span className="grow">{u.name}</span><span className="small muted">{u.email}</span></li>)}</ul>}
  </div>;
}

function StaffDialog({ refs, s, onClose, onDone }: { refs: Refs; s: Staff | null; onClose: () => void; onDone: () => void }) {
  const editable = refs.departments.filter((d) => d.can_edit || refs.can.staff_all);
  const [f, setF] = useState({ user_id: s?.user_id ?? null as string | null, user_label: s?.user_email ?? '', first_name: s?.first_name ?? '', last_name: s?.last_name ?? '',
    personal_number: s?.personal_number ?? '', phone: s?.phone ?? '', position_id: s?.position_id ?? '', department_id: s?.department_id ?? editable[0]?.id ?? '',
    extra: s?.extra_department_ids ?? [] as string[], fte: s ? String(Number(s.fte)) : '1', employment: s?.employment ?? 'staff', hired_on: s?.hired_on ?? '', left_on: s?.left_on ?? '',
    is_active: s?.is_active ?? true, notes: s?.notes ?? '' });
  const set = (k: string, v: unknown) => setF({ ...f, [k]: v });
  const m = useMutation({
    mutationFn: () => api(s ? `/roster/staff/${s.id}` : '/roster/staff', { method: s ? 'PATCH' : 'POST', body: {
      user_id: f.user_id, first_name: f.first_name.trim(), last_name: f.last_name.trim(), personal_number: f.personal_number.trim() || null, phone: f.phone.trim() || null,
      position_id: f.position_id || null, department_id: f.department_id, extra_department_ids: f.extra.filter((x) => x !== f.department_id), fte: Number(f.fte.replace(',', '.')),
      employment: f.employment, hired_on: f.hired_on || null, left_on: f.left_on || null, ...(s && { is_active: f.is_active }), notes: f.notes.trim() || null } }),
    onSuccess: onDone,
  });
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 } as const;
  return <Modal title={s ? s.name : 'ახალი თანამშრომელი'} width={720} onClose={onClose} footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button>
    <button className="btn primary" type="button" disabled={m.isPending || !f.first_name.trim() || !f.last_name.trim() || !f.department_id} onClick={() => m.mutate()}>შენახვა</button></>}>
    <div className="stack">
      <Field label="EMR ანგარიში" htmlFor="sf-u" hint="ცარიელი — ანგარიშის გარეშე (სანიტარი, მძღოლი…); შეტყობინებები და „ჩემი განრიგი“ — მხოლოდ ანგარიშით">
        {f.user_id ? <div className="row"><span className="grow">{f.user_label || 'მიბმულია'}</span><button className="btn sm" type="button" onClick={() => setF({ ...f, user_id: null, user_label: '' })}>მოხსნა</button></div>
          : <UserPicker onPick={(u) => setF({ ...f, user_id: u.id, user_label: `${u.name} · ${u.email}`, first_name: f.first_name || u.name.split(' ').slice(1).join(' '), last_name: f.last_name || u.name.split(' ')[0],
            department_id: s ? f.department_id : (u.department_id && editable.some((d) => d.id === u.department_id) ? u.department_id : f.department_id) })} />}</Field>
      <div style={grid}>
        <Field label="სახელი" htmlFor="sf-fn" required><input id="sf-fn" className="input" value={f.first_name} onChange={(e) => set('first_name', e.target.value)} /></Field>
        <Field label="გვარი" htmlFor="sf-ln" required><input id="sf-ln" className="input" value={f.last_name} onChange={(e) => set('last_name', e.target.value)} /></Field>
        <Field label="პირადი №" htmlFor="sf-pn"><input id="sf-pn" className="input mono" maxLength={11} value={f.personal_number} onChange={(e) => set('personal_number', e.target.value.replace(/\D/g, ''))} /></Field>
        <Field label="ტელეფონი" htmlFor="sf-ph" hint="ცარიელი — ანგარიშის ტელეფონი"><input id="sf-ph" className="input mono" value={f.phone} onChange={(e) => set('phone', e.target.value)} /></Field>
        <Field label="პოზიცია" htmlFor="sf-pos" hint={refs.positions.length ? undefined : 'პოზიციები — „ცნობარები“'}><select id="sf-pos" className="select" value={f.position_id} onChange={(e) => set('position_id', e.target.value)}>
          <option value="">—</option>{refs.positions.filter((p) => p.is_active || p.id === f.position_id).map((p) => <option key={p.id} value={p.id}>{p.name} ({CAT_KA[p.category]})</option>)}</select></Field>
        <Field label="ძირითადი განყოფილება" htmlFor="sf-d" required><select id="sf-d" className="select" value={f.department_id} onChange={(e) => set('department_id', e.target.value)}>
          {refs.departments.filter((d) => editable.some((x) => x.id === d.id) || d.id === f.department_id).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
        <Field label="განაკვეთი (FTE)" htmlFor="sf-fte" hint="1 — სრული; 0.5 — ნახევარი"><input id="sf-fte" className="input mono" value={f.fte} onChange={(e) => set('fte', e.target.value)} /></Field>
        <Field label="შრომითი ურთიერთობა" htmlFor="sf-emp"><select id="sf-emp" className="select" value={f.employment} onChange={(e) => set('employment', e.target.value)}>
          {Object.entries(EMP_KA).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="მიღების თარიღი" htmlFor="sf-h"><input id="sf-h" className="input" type="date" value={f.hired_on} onChange={(e) => set('hired_on', e.target.value)} /></Field>
        <Field label="წასვლის თარიღი" htmlFor="sf-l"><input id="sf-l" className="input" type="date" value={f.left_on} onChange={(e) => set('left_on', e.target.value)} /></Field>
      </div>
      <Field label="დამატებითი განყოფილებები" htmlFor="sf-x" hint="სადაც შეიძლება მისი დაგეგმვა (მაგ. საერთო ექთანი)">
        <div className="row" style={{ flexWrap: 'wrap', gap: 10 }} id="sf-x">{refs.departments.filter((d) => d.id !== f.department_id).map((d) => <label key={d.id} className="row small">
          <input type="checkbox" checked={f.extra.includes(d.id)} onChange={(e) => set('extra', e.target.checked ? [...f.extra, d.id] : f.extra.filter((x) => x !== d.id))} /> {d.name}</label>)}</div></Field>
      <Field label="შენიშვნა" htmlFor="sf-n"><input id="sf-n" className="input" value={f.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
      {s && <label className="row"><input type="checkbox" checked={f.is_active} onChange={(e) => set('is_active', e.target.checked)} /> აქტიური</label>}
      <ErrorBox error={m.error} />
    </div>
  </Modal>;
}

function FromUsersDialog({ refs, onClose, onDone }: { refs: Refs; onClose: () => void; onDone: (n: number) => void }) {
  const editable = refs.departments.filter((d) => d.can_edit || refs.can.staff_all);
  const [dept, setDept] = useState(''); const [pos, setPos] = useState(''); const [sel, setSel] = useState<string[]>([]); const [search, setSearch] = useState('');
  const ds = useDebounced(search.trim(), 250);
  const q = useQuery({ queryKey: ['roster-users-all', ds, dept], queryFn: () => api<UserRow[]>('/roster/users-without-staff', { query: { search: ds, department_id: dept || undefined } }) });
  const [res, setRes] = useState<{ created: number; skipped: { user_id: string; message: string }[] } | null>(null);
  const m = useMutation({ mutationFn: () => api<{ created: number; skipped: { user_id: string; message: string }[] }>('/roster/staff/from-users', { body: { user_ids: sel, ...(pos && { position_id: pos }), ...(dept && { department_id: dept }) } }), onSuccess: setRes });
  return <Modal title="თანამშრომლები EMR მომხმარებლებიდან" width={680} onClose={onClose} footer={res ? <button className="btn primary" type="button" onClick={() => onDone(res.created)}>მზადაა</button> : <>
    <button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={!sel.length || m.isPending} onClick={() => m.mutate()}>დამატება ({sel.length})</button></>}>
    {res ? <div className="stack"><span>დაემატა: <strong>{res.created}</strong></span>{res.skipped.length > 0 && <ul className="small">{res.skipped.map((x) => <li key={x.user_id}>{q.data?.find((u) => u.id === x.user_id)?.name ?? x.user_id} — {x.message}</li>)}</ul>}</div>
      : <div className="stack">
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <select className="select" aria-label="განყოფილება" style={{ maxWidth: 240 }} value={dept} onChange={(e) => { setDept(e.target.value); setSel([]); }}>
            <option value="">მომხმარებლის განყოფილებით</option>{editable.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
          <select className="select" aria-label="პოზიცია" style={{ maxWidth: 220 }} value={pos} onChange={(e) => setPos(e.target.value)}>
            <option value="">პოზიცია — მოგვიანებით</option>{refs.positions.filter((p) => p.is_active).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          <input className="input" aria-label="ძებნა" placeholder="ძებნა" style={{ maxWidth: 180 }} value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <span className="small muted">ჩანს აქტიური მომხმარებლები, რომლებიც ჯერ რეესტრში არ არიან{dept ? ' (ამ განყოფილების)' : ''}. განყოფილება არჩეული — ყველა მასში დაემატება.</span>
        <div style={{ maxHeight: 320, overflow: 'auto' }}>
          {q.isLoading ? <Loading /> : <table className="table small"><thead><tr><th><input type="checkbox" aria-label="ყველა" checked={!!q.data?.length && sel.length === q.data.length} onChange={(e) => setSel(e.target.checked ? q.data!.map((u) => u.id) : [])} /></th><th>მომხმარებელი</th><th>განყოფილება</th></tr></thead>
            <tbody>{q.data?.map((u) => <tr key={u.id}><td><input type="checkbox" aria-label={u.name} checked={sel.includes(u.id)} onChange={(e) => setSel(e.target.checked ? [...sel, u.id] : sel.filter((x) => x !== u.id))} /></td>
              <td>{u.name}<div className="muted">{u.email}{u.specialty ? ` · ${u.specialty}` : ''}</div></td><td>{u.department_name ?? '—'}</td></tr>)}
              {!q.data?.length && <tr><td colSpan={3} className="muted">ყველა მომხმარებელი უკვე რეესტრშია</td></tr>}</tbody></table>}
        </div>
        <ErrorBox error={m.error ?? q.error} />
      </div>}
  </Modal>;
}
