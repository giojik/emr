import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { api } from '../../api/client';
import { ErrorBox, Field, Loading, Modal, useToast } from '../../components/ui';
import { dateGe } from '../../lib/format';
import { CAT_KA, DOW_KA, KIND_KA, ROUTE_KA, timeRange, type AbsenceType, type Category, type DutyRole, type Kind, type Pattern, type Position, type Refs, type Template } from './types';

/** ცნობარები (0077): პოზიციები, ცვლის შაბლონები, მორიგის როლები, როტაციის ნიმუშები, დღესასწაულები, შევსების ნორმა */
export default function RosterSetupPage({ refs }: { refs: Refs }) {
  const qc = useQueryClient(); const toast = useToast();
  const done = (m = 'შენახულია') => { toast.show(m); void qc.invalidateQueries({ queryKey: ['roster-refs'] }); void qc.invalidateQueries({ queryKey: ['roster'] }); };
  const c = refs.can;
  return (
    <div className="content">
      {toast.node}
      {(c.edit_all || c.edit_depts.length > 0) && <Norms refs={refs} onDone={done} />}
      {c.setup && <Templates refs={refs} onDone={done} />}
      {c.setup && <Duties refs={refs} onDone={done} />}
      {c.setup && <Patterns refs={refs} onDone={done} />}
      {c.hr && <Positions refs={refs} onDone={done} />}
      {c.hr && <Holidays onDone={done} />}
      {c.hr && <AbsenceTypes refs={refs} onDone={done} />}
    </div>
  );
}

function Section({ title, hint, action, children }: { title: string; hint?: string; action?: ReactNode; children: ReactNode }) {
  return <section className="card card-pad stack"><div className="row"><h2 className="grow" style={{ margin: 0, fontSize: 16 }}>{title}</h2>{action}</div>{hint && <span className="hint">{hint}</span>}{children}</section>;
}
const CatPicks = ({ value, set }: { value: Category[]; set: (v: Category[]) => void }) => <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
  {(Object.keys(CAT_KA) as Category[]).map((k) => <label key={k} className="row small"><input type="checkbox" checked={value.includes(k)} onChange={(e) => set(e.target.checked ? [...value, k] : value.filter((x) => x !== k))} /> {CAT_KA[k]}</label>)}</div>;

// ---------------------------------------------------------------- პოზიციები
function Positions({ refs, onDone }: { refs: Refs; onDone: () => void }) {
  const [e, setE] = useState<Position | 'new' | null>(null);
  return <Section title="პოზიციები" hint="HR-ის ცნება (როლისგან / უფლებისგან დამოუკიდებელი). კატეგორია — ნორმისა და შაბლონის შეზღუდვისთვის." action={<button className="btn sm primary" type="button" onClick={() => setE('new')}>+ პოზიცია</button>}>
    <table className="table small"><thead><tr><th>კოდი</th><th>დასახელება</th><th>კატეგორია</th><th>თანამშრ.</th><th /></tr></thead>
      <tbody>{refs.positions.map((p) => <tr key={p.id} className="clickable" onClick={() => setE(p)}><td className="mono">{p.code}</td><td>{p.name}</td><td>{CAT_KA[p.category]}</td><td>{p.staff}</td>
        <td>{!p.is_active && <span className="chip">გათიშული</span>}</td></tr>)}
        {!refs.positions.length && <tr><td colSpan={5} className="muted">პოზიცია ჯერ არ არის (მაგ. ექიმი-რეზიდენტი, უფროსი ექთანი, სანიტარი, ბიომედ-ინჟინერი)</td></tr>}</tbody></table>
    {e && <PositionDialog p={e === 'new' ? null : e} onClose={() => setE(null)} onDone={() => { setE(null); onDone(); }} />}
  </Section>;
}
function PositionDialog({ p, onClose, onDone }: { p: Position | null; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ code: p?.code ?? '', name: p?.name ?? '', category: p?.category ?? 'nurse', sort_order: String(p?.sort_order ?? 100), is_active: p?.is_active ?? true });
  const m = useMutation({ mutationFn: () => api(p ? `/roster/positions/${p.id}` : '/roster/positions', { method: p ? 'PATCH' : 'POST',
    body: { ...(!p && { code: f.code }), name: f.name.trim(), category: f.category, sort_order: Number(f.sort_order) || 100, ...(p && { is_active: f.is_active }) } }), onSuccess: onDone });
  return <Modal title={p ? p.name : 'ახალი პოზიცია'} onClose={onClose} footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button>
    <button className="btn primary" type="button" disabled={m.isPending || f.name.trim().length < 2 || (!p && !/^[A-Z][A-Z0-9_]{1,29}$/.test(f.code))} onClick={() => m.mutate()}>შენახვა</button></>}>
    <div className="stack">
      {!p && <Field label="კოდი" htmlFor="pc" required hint="ლათ. დიდი ასოები, ციფრები, _ (მაგ. HEAD_NURSE)"><input id="pc" className="input mono" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '') })} /></Field>}
      <Field label="დასახელება" htmlFor="pn" required><input id="pn" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <Field label="კატეგორია" htmlFor="pk"><select id="pk" className="select" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value as Category })}>
        {(Object.keys(CAT_KA) as Category[]).map((k) => <option key={k} value={k}>{CAT_KA[k]}</option>)}</select></Field>
      <Field label="რიგი" htmlFor="ps" hint="განრიგის ბადეში თანამშრომლების დალაგება"><input id="ps" className="input mono" type="number" value={f.sort_order} onChange={(e) => setF({ ...f, sort_order: e.target.value })} /></Field>
      {p && <label className="row"><input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> აქტიური</label>}
      <ErrorBox error={m.error} />
    </div></Modal>;
}

// ---------------------------------------------------------------- ცვლის შაბლონები
function Templates({ refs, onDone }: { refs: Refs; onDone: () => void }) {
  const [e, setE] = useState<Template | 'new' | null>(null);
  return <Section title="ცვლის შაბლონები" hint="დასასრული ≤ დასაწყისი — მეორე დღეს; ტოლი — 24 სთ. ჩასათვლელი საათები ცარიელი — ხანგრძლივობა − შესვენება (მორიგეობა სახლიდან — ჩვეულებრივ 0)."
    action={<button className="btn sm primary" type="button" onClick={() => setE('new')}>+ ცვლა</button>}>
    <table className="table small"><thead><tr><th>კოდი</th><th>დასახელება</th><th>სახე</th><th>დრო</th><th>შესვ.</th><th>სთ</th><th>შეზღუდვა</th><th /></tr></thead>
      <tbody>{refs.templates.map((t) => <tr key={t.id} className="clickable" onClick={() => setE(t)}>
        <td><span className="mono" style={{ background: t.color, color: '#fff', borderRadius: 4, padding: '1px 6px', fontWeight: 600 }}>{t.code}</span></td><td>{t.name}</td><td>{KIND_KA[t.kind]}</td>
        <td className="mono">{timeRange(t)}</td><td>{t.break_min ? `${t.break_min} წთ` : ''}</td><td className="mono">{t.hours}</td>
        <td className="small muted">{[t.department_ids.length ? `${t.department_ids.length} განყ.` : '', t.categories.map((c) => CAT_KA[c]).join(', ')].filter(Boolean).join(' · ') || 'ყველა'}</td>
        <td>{!t.is_active && <span className="chip">გათიშული</span>}</td></tr>)}</tbody></table>
    {e && <TemplateDialog refs={refs} t={e === 'new' ? null : e} onClose={() => setE(null)} onDone={() => { setE(null); onDone(); }} />}
  </Section>;
}
function TemplateDialog({ refs, t, onClose, onDone }: { refs: Refs; t: Template | null; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ code: t?.code ?? '', name: t?.name ?? '', kind: t?.kind ?? 'day', start: t?.start_time.slice(0, 5) ?? '08:00', end: t?.end_time.slice(0, 5) ?? '20:00',
    brk: String(t?.break_min ?? 0), counted: t?.counted_hours !== null && t?.counted_hours !== undefined ? String(Number(t.counted_hours)) : '', color: t?.color ?? '#0ea5e9',
    depts: t?.department_ids ?? [] as string[], cats: t?.categories ?? [] as Category[], sort: String(t?.sort_order ?? 100), is_active: t?.is_active ?? true });
  const set = (k: string, v: unknown) => setF({ ...f, [k]: v });
  const m = useMutation({ mutationFn: () => api(t ? `/roster/templates/${t.id}` : '/roster/templates', { method: t ? 'PATCH' : 'POST', body: {
    ...(!t && { code: f.code }), name: f.name.trim(), kind: f.kind, start_time: f.start, end_time: f.end, break_min: Number(f.brk) || 0,
    counted_hours: f.counted.trim() === '' ? null : Number(f.counted.replace(',', '.')), color: f.color, department_ids: f.depts, categories: f.cats, sort_order: Number(f.sort) || 100,
    ...(t && { is_active: f.is_active }) } }), onSuccess: onDone });
  return <Modal title={t ? `${t.code} — ${t.name}` : 'ახალი ცვლა'} width={640} onClose={onClose} footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button>
    <button className="btn primary" type="button" disabled={m.isPending || f.name.trim().length < 2 || (!t && !/^[A-Z0-9][A-Z0-9_]{0,5}$/.test(f.code))} onClick={() => m.mutate()}>შენახვა</button></>}>
    <div className="stack">
      <div className="row" style={{ gap: 8 }}>
        {!t && <Field label="კოდი" htmlFor="tc" required hint="≤ 6, ბადეში ჩანს"><input id="tc" className="input mono" style={{ maxWidth: 110 }} value={f.code} onChange={(e) => set('code', e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 6))} /></Field>}
        <Field label="დასახელება" htmlFor="tn" required><input id="tn" className="input" value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
        <Field label="ფერი" htmlFor="tco"><input id="tco" className="input" type="color" style={{ width: 60, padding: 2 }} value={f.color} onChange={(e) => set('color', e.target.value)} /></Field>
      </div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <Field label="სახე" htmlFor="tk"><select id="tk" className="select" value={f.kind} onChange={(e) => set('kind', e.target.value as Kind)}>
          {(Object.keys(KIND_KA) as Kind[]).map((k) => <option key={k} value={k}>{KIND_KA[k]}</option>)}</select></Field>
        <Field label="დასაწყისი" htmlFor="ts"><input id="ts" className="input mono" type="time" value={f.start} onChange={(e) => set('start', e.target.value)} /></Field>
        <Field label="დასასრული" htmlFor="te"><input id="te" className="input mono" type="time" value={f.end} onChange={(e) => set('end', e.target.value)} /></Field>
        <Field label="შესვენება (წთ)" htmlFor="tb"><input id="tb" className="input mono" style={{ maxWidth: 90 }} type="number" min={0} max={240} value={f.brk} onChange={(e) => set('brk', e.target.value)} /></Field>
        <Field label="ჩასათვლელი სთ" htmlFor="th" hint="ცარიელი — ავტომატურად"><input id="th" className="input mono" style={{ maxWidth: 90 }} value={f.counted} onChange={(e) => set('counted', e.target.value)} /></Field>
      </div>
      <Field label="კატეგორიები (ცარიელი — ყველა)" htmlFor="tcat"><CatPicks value={f.cats} set={(v) => set('cats', v)} /></Field>
      <Field label="განყოფილებები (ცარიელი — ყველა)" htmlFor="tdep"><div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>{refs.departments.map((d) => <label key={d.id} className="row small">
        <input type="checkbox" checked={f.depts.includes(d.id)} onChange={(e) => set('depts', e.target.checked ? [...f.depts, d.id] : f.depts.filter((x) => x !== d.id))} /> {d.name}</label>)}</div></Field>
      <div className="row" style={{ gap: 8 }}><Field label="რიგი" htmlFor="tso"><input id="tso" className="input mono" style={{ maxWidth: 90 }} type="number" value={f.sort} onChange={(e) => set('sort', e.target.value)} /></Field>
        {t && <label className="row" style={{ marginTop: 24 }}><input type="checkbox" checked={f.is_active} onChange={(e) => set('is_active', e.target.checked)} /> აქტიური</label>}</div>
      <ErrorBox error={m.error} />
    </div></Modal>;
}

// ---------------------------------------------------------------- მორიგის როლები
function Duties({ refs, onDone }: { refs: Refs; onDone: () => void }) {
  const [e, setE] = useState<DutyRole | 'new' | null>(null);
  return <Section title="მორიგის როლები" hint="მაგ. „მორიგე ექიმი — თერაპია“, „მორიგე რეანიმატოლოგი“, „ბიომედ-ინჟინერი“. განრიგში — ★ (I) / ☆ (II). საჭირო რაოდენობა — დღეში; 0 — ხარვეზი არ ითვლება."
    action={<button className="btn sm primary" type="button" onClick={() => setE('new')}>+ მორიგის როლი</button>}>
    <table className="table small"><thead><tr><th>კოდი</th><th>დასახელება</th><th>განყოფილება</th><th>კატეგ.</th><th>საჭ.</th><th>II დონე</th><th>ტელეფონი</th><th /></tr></thead>
      <tbody>{refs.duty_roles.map((d) => <tr key={d.id} className="clickable" onClick={() => setE(d)}><td className="mono">{d.code}</td><td>{d.name}</td><td>{d.department_name ?? 'ნებისმიერი'}</td>
        <td>{d.categories.map((c) => CAT_KA[c]).join(', ') || 'ყველა'}</td><td>{d.required_count}</td><td>{d.has_backup ? '✔' : ''}</td><td className="mono">{d.phone ?? ''}</td>
        <td>{!d.is_active && <span className="chip">გათიშული</span>}</td></tr>)}
        {!refs.duty_roles.length && <tr><td colSpan={8} className="muted">მორიგის როლი ჯერ არ არის</td></tr>}</tbody></table>
    {e && <DutyDialog refs={refs} d={e === 'new' ? null : e} onClose={() => setE(null)} onDone={() => { setE(null); onDone(); }} />}
  </Section>;
}
function DutyDialog({ refs, d, onClose, onDone }: { refs: Refs; d: DutyRole | null; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ code: d?.code ?? '', name: d?.name ?? '', dept: d?.department_id ?? '', cats: d?.categories ?? [] as Category[], req: String(d?.required_count ?? 1),
    backup: d?.has_backup ?? false, phone: d?.phone ?? '', sort: String(d?.sort_order ?? 100), is_active: d?.is_active ?? true });
  const set = (k: string, v: unknown) => setF({ ...f, [k]: v });
  const m = useMutation({ mutationFn: () => api(d ? `/roster/duty-roles/${d.id}` : '/roster/duty-roles', { method: d ? 'PATCH' : 'POST', body: {
    ...(!d && { code: f.code }), name: f.name.trim(), department_id: f.dept || null, categories: f.cats, required_count: Number(f.req) || 0, has_backup: f.backup, phone: f.phone.trim() || null,
    sort_order: Number(f.sort) || 100, ...(d && { is_active: f.is_active }) } }), onSuccess: onDone });
  return <Modal title={d ? d.name : 'ახალი მორიგის როლი'} width={600} onClose={onClose} footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button>
    <button className="btn primary" type="button" disabled={m.isPending || f.name.trim().length < 2 || (!d && !/^[A-Z][A-Z0-9_]{1,29}$/.test(f.code))} onClick={() => m.mutate()}>შენახვა</button></>}>
    <div className="stack">
      {!d && <Field label="კოდი" htmlFor="dc" required hint="მაგ. ICU_DOCTOR"><input id="dc" className="input mono" value={f.code} onChange={(e) => set('code', e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))} /></Field>}
      <Field label="დასახელება" htmlFor="dn" required><input id="dn" className="input" value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
      <Field label="განყოფილება" htmlFor="dd" hint="ამ განყოფილების განრიგში ითვლება ხარვეზი; ცარიელი — ნებისმიერ განრიგში (ხარვეზის გარეშე)"><select id="dd" className="select" value={f.dept} onChange={(e) => set('dept', e.target.value)}>
        <option value="">ნებისმიერი</option>{refs.departments.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
      <Field label="კატეგორიები (ცარიელი — ყველა)" htmlFor="dcat"><CatPicks value={f.cats} set={(v) => set('cats', v)} /></Field>
      <div className="row" style={{ gap: 8 }}>
        <Field label="საჭირო დღეში" htmlFor="dr"><input id="dr" className="input mono" style={{ maxWidth: 90 }} type="number" min={0} max={20} value={f.req} onChange={(e) => set('req', e.target.value)} /></Field>
        <Field label="მორიგის ტელეფონი" htmlFor="dp" hint="საერთო (მობილური / შიდა)"><input id="dp" className="input mono" value={f.phone} onChange={(e) => set('phone', e.target.value)} /></Field>
        <Field label="რიგი" htmlFor="dso"><input id="dso" className="input mono" style={{ maxWidth: 90 }} type="number" value={f.sort} onChange={(e) => set('sort', e.target.value)} /></Field>
      </div>
      <label className="row"><input type="checkbox" checked={f.backup} onChange={(e) => set('backup', e.target.checked)} /> II დონე (backup / სარეზერვო მორიგე)</label>
      {d && <label className="row"><input type="checkbox" checked={f.is_active} onChange={(e) => set('is_active', e.target.checked)} /> აქტიური</label>}
      <ErrorBox error={m.error} />
    </div></Modal>;
}

// ---------------------------------------------------------------- როტაციის ნიმუშები
function Patterns({ refs, onDone }: { refs: Refs; onDone: () => void }) {
  const [e, setE] = useState<Pattern | 'new' | null>(null);
  const code = (id: string) => (id === refs.rest ? '·' : refs.templates.find((t) => t.id === id)?.code ?? '?');
  return <Section title="როტაციის ნიმუშები" hint="ციკლი — დღეების მიმდევრობა (ცვლა ან დასვენება „·“). განრიგში: „როტაცია“ — მონიშნულ თანამშრომლებს, წანაცვლებით."
    action={<button className="btn sm primary" type="button" onClick={() => setE('new')}>+ ნიმუში</button>}>
    <table className="table small"><thead><tr><th>კოდი</th><th>დასახელება</th><th>ციკლი</th><th /></tr></thead>
      <tbody>{refs.patterns.map((p) => <tr key={p.id} className="clickable" onClick={() => setE(p)}><td className="mono">{p.code}</td><td>{p.name}</td><td className="mono">{p.cycle.map(code).join(' ')}</td>
        <td>{!p.is_active && <span className="chip">გათიშული</span>}</td></tr>)}</tbody></table>
    {e && <PatternDialog refs={refs} p={e === 'new' ? null : e} onClose={() => setE(null)} onDone={() => { setE(null); onDone(); }} />}
  </Section>;
}
function PatternDialog({ refs, p, onClose, onDone }: { refs: Refs; p: Pattern | null; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ code: p?.code ?? '', name: p?.name ?? '', cycle: p?.cycle ?? [refs.rest], is_active: p?.is_active ?? true });
  const m = useMutation({ mutationFn: () => api(p ? `/roster/patterns/${p.id}` : '/roster/patterns', { method: p ? 'PATCH' : 'POST', body: { ...(!p && { code: f.code }), name: f.name.trim(), cycle: f.cycle, ...(p && { is_active: f.is_active }) } }), onSuccess: onDone });
  const tpls = refs.templates.filter((t) => t.is_active);
  return <Modal title={p ? p.name : 'ახალი ნიმუში'} width={640} onClose={onClose} footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button>
    <button className="btn primary" type="button" disabled={m.isPending || f.name.trim().length < 2 || !f.cycle.some((x) => x !== refs.rest) || (!p && !/^[A-Z0-9][A-Z0-9_]{1,29}$/.test(f.code))} onClick={() => m.mutate()}>შენახვა</button></>}>
    <div className="stack">
      {!p && <Field label="კოდი" htmlFor="rc" required><input id="rc" className="input mono" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '') })} /></Field>}
      <Field label="დასახელება" htmlFor="rn" required><input id="rn" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <span className="small muted">ციკლი ({f.cycle.length} დღე):</span>
      <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
        {f.cycle.map((x, i) => <select key={i} className="select mono" aria-label={`დღე ${i + 1}`} style={{ width: 82, height: 32 }} value={x} onChange={(e) => setF({ ...f, cycle: f.cycle.map((y, j) => (j === i ? e.target.value : y)) })}>
          <option value={refs.rest}>·</option>{tpls.map((t) => <option key={t.id} value={t.id}>{t.code}</option>)}</select>)}
        <button className="btn sm" type="button" disabled={f.cycle.length >= 56} onClick={() => setF({ ...f, cycle: [...f.cycle, refs.rest] })}>+ დღე</button>
        <button className="btn sm" type="button" disabled={f.cycle.length <= 1} onClick={() => setF({ ...f, cycle: f.cycle.slice(0, -1) })}>− დღე</button>
      </div>
      {p && <label className="row"><input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> აქტიური</label>}
      <ErrorBox error={m.error} />
    </div></Modal>;
}

// ---------------------------------------------------------------- დღესასწაულები
function Holidays({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const [year, setYear] = useState(String(new Date().getFullYear() + (new Date().getMonth() >= 10 ? 1 : 0)));
  const q = useQuery({ queryKey: ['roster-holidays', year], queryFn: () => api<{ day: string; name: string }[]>('/roster/holidays', { query: { year } }) });
  const [f, setF] = useState({ day: '', name: '' });
  const inv = () => { void qc.invalidateQueries({ queryKey: ['roster-holidays'] }); onDone(); };
  const add = useMutation({ mutationFn: () => api('/roster/holidays', { body: { day: f.day, name: f.name.trim() } }), onSuccess: () => { setF({ day: '', name: '' }); inv(); } });
  const del = useMutation({ mutationFn: (d: string) => api(`/roster/holidays/${d}`, { method: 'DELETE' }), onSuccess: inv });
  return <Section title="დღესასწაულები (უქმე დღეები)" hint="ნორმასა და ბადეში ჩანს; საათების აღრიცხვაში — 0079. საწყისი სია საორიენტაციოა (2026–2027) — გადაამოწმეთ, მთავრობის დამატებითი დღეები შეიტანეთ ხელით."
    action={<input className="input mono" aria-label="წელი" style={{ width: 90, height: 32 }} value={year} onChange={(e) => setYear(e.target.value.replace(/\D/g, '').slice(0, 4))} />}>
    {q.isLoading ? <Loading /> : <table className="table small"><tbody>{q.data?.map((h) => <tr key={h.day}><td className="mono" style={{ width: 110 }}>{dateGe(h.day)}</td>
      <td style={{ width: 40 }}>{DOW_KA[((new Date(`${h.day}T00:00:00Z`).getUTCDay() + 6) % 7) + 1]}</td><td>{h.name}</td>
      <td style={{ width: 40 }}><button className="icon-btn" type="button" aria-label={`წაშლა ${h.name}`} disabled={del.isPending} onClick={() => del.mutate(h.day)}>✕</button></td></tr>)}
      {!q.data?.length && <tr><td className="muted">ამ წელს დღესასწაული არ არის შეტანილი</td></tr>}</tbody></table>}
    <div className="row" style={{ gap: 8 }}><input className="input" type="date" aria-label="დღე" style={{ maxWidth: 170 }} value={f.day} onChange={(e) => setF({ ...f, day: e.target.value })} />
      <input className="input" aria-label="დასახელება" placeholder="დასახელება" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      <button className="btn" type="button" disabled={!f.day || f.name.trim().length < 2 || add.isPending} onClick={() => add.mutate()}>დამატება</button></div>
    <ErrorBox error={add.error ?? del.error ?? q.error} />
  </Section>;
}

// ---------------------------------------------------------------- შევსების ნორმა
interface Norm { id: string; department_id: string; shift_template_id: string; shift_code: string; shift_name: string; category: Category; min_count: number; weekdays: number[]; holidays: boolean; is_active: boolean }
function Norms({ refs, onDone }: { refs: Refs; onDone: () => void }) {
  const qc = useQueryClient();
  const deps = refs.departments.filter((d) => d.can_edit);
  const [dept, setDept] = useState(deps[0]?.id ?? '');
  const q = useQuery({ queryKey: ['roster-norms', dept], queryFn: () => api<Norm[]>('/roster/norms', { query: { department_id: dept } }), enabled: !!dept });
  const [e, setE] = useState<Norm | 'new' | null>(null);
  return <Section title="შევსების ნორმა" hint="განყოფილება × ცვლა × კატეგორია — მინიმალური რაოდენობა. ნაკლები → „ხარვეზი“ ბადეში და გაფრთხილება გამოქვეყნებისას (პარამეტრი)."
    action={<div className="row" style={{ gap: 6 }}><select className="select" aria-label="განყოფილება" style={{ maxWidth: 240, height: 32 }} value={dept} onChange={(x) => setDept(x.target.value)}>
      {deps.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select><button className="btn sm primary" type="button" disabled={!dept} onClick={() => setE('new')}>+ ნორმა</button></div>}>
    {q.isLoading ? <Loading /> : <table className="table small"><thead><tr><th>ცვლა</th><th>კატეგორია</th><th>მინ.</th><th>დღეები</th><th>დღესასწ.</th><th /></tr></thead>
      <tbody>{q.data?.map((n) => <tr key={n.id} className="clickable" onClick={() => setE(n)}><td><strong className="mono">{n.shift_code}</strong> {n.shift_name}</td><td>{CAT_KA[n.category]}</td>
        <td className="mono">{n.min_count}</td><td>{n.weekdays.length ? n.weekdays.map((w) => DOW_KA[w]).join(' ') : 'ყოველდღე'}</td><td>{n.holidays ? '✔' : '—'}</td>
        <td>{!n.is_active && <span className="chip">გათიშული</span>}</td></tr>)}
        {!q.data?.length && <tr><td colSpan={6} className="muted">ნორმა არ არის</td></tr>}</tbody></table>}
    <ErrorBox error={q.error} />
    {e && <NormDialog refs={refs} dept={dept} n={e === 'new' ? null : e} onClose={() => setE(null)} onDone={() => { setE(null); void qc.invalidateQueries({ queryKey: ['roster-norms'] }); onDone(); }} />}
  </Section>;
}
function NormDialog({ refs, dept, n, onClose, onDone }: { refs: Refs; dept: string; n: Norm | null; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ tpl: n?.shift_template_id ?? '', cat: n?.category ?? 'nurse', min: String(n?.min_count ?? 1), wd: n?.weekdays ?? [] as number[], hol: n?.holidays ?? true, is_active: n?.is_active ?? true });
  const m = useMutation({ mutationFn: () => api(n ? `/roster/norms/${n.id}` : '/roster/norms', { method: n ? 'PATCH' : 'POST', body: {
    ...(!n && { department_id: dept }), shift_template_id: f.tpl, category: f.cat, min_count: Number(f.min), weekdays: f.wd, holidays: f.hol, ...(n && { is_active: f.is_active }) } }), onSuccess: onDone });
  return <Modal title={n ? 'ნორმა' : 'ახალი ნორმა'} onClose={onClose} footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button>
    <button className="btn primary" type="button" disabled={m.isPending || !f.tpl || !(Number(f.min) >= 1)} onClick={() => m.mutate()}>შენახვა</button></>}>
    <div className="stack">
      <Field label="ცვლა" htmlFor="nt" required><select id="nt" className="select" value={f.tpl} onChange={(e) => setF({ ...f, tpl: e.target.value })}><option value="">—</option>
        {refs.templates.filter((t) => t.is_active && (!t.department_ids.length || t.department_ids.includes(dept))).map((t) => <option key={t.id} value={t.id}>{t.code} — {t.name}</option>)}</select></Field>
      <Field label="კატეგორია" htmlFor="nc"><select id="nc" className="select" value={f.cat} onChange={(e) => setF({ ...f, cat: e.target.value as Category })}>
        {(Object.keys(CAT_KA) as Category[]).map((k) => <option key={k} value={k}>{CAT_KA[k]}</option>)}</select></Field>
      <Field label="მინიმუმი" htmlFor="nm"><input id="nm" className="input mono" type="number" min={1} max={100} value={f.min} onChange={(e) => setF({ ...f, min: e.target.value })} /></Field>
      <Field label="კვირის დღეები (ცარიელი — ყოველდღე)" htmlFor="nw"><div className="row" style={{ gap: 8 }}>{[1, 2, 3, 4, 5, 6, 7].map((w) => <label key={w} className="row small">
        <input type="checkbox" checked={f.wd.includes(w)} onChange={(e) => setF({ ...f, wd: e.target.checked ? [...f.wd, w] : f.wd.filter((x) => x !== w) })} />{DOW_KA[w]}</label>)}</div></Field>
      <label className="row"><input type="checkbox" checked={f.hol} onChange={(e) => setF({ ...f, hol: e.target.checked })} /> დღესასწაულზეც მოქმედებს</label>
      {n && <label className="row"><input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> აქტიური</label>}
      <ErrorBox error={m.error} />
    </div></Modal>;
}

// ---------------------------------------------------------------- არყოფნის ტიპები (0078)
function AbsenceTypes({ refs, onDone }: { refs: Refs; onDone: () => void }) {
  const [e, setE] = useState<AbsenceType | 'new' | null>(null);
  return <Section title="არყოფნის ტიპები" hint="შვებულება / ბიულეტენი / მივლინება… ბალანსი, ერთეული, დადასტურების მარშრუტი, დოკუმენტი. ცვლილება არსებულ მოთხოვნებს არ ცვლის (მარშრუტი მოთხოვნაზე ფიქსირდება)."
    action={<button className="btn sm primary" type="button" onClick={() => setE('new')}>+ ტიპი</button>}>
    <table className="table small"><thead><tr><th>კოდი</th><th>დასახელება</th><th>ერთეული</th><th>ბალანსი</th><th>მარშრუტი</th><th>დოკ.</th><th>ანაზღ.</th><th /></tr></thead>
      <tbody>{refs.absence_types.map((t) => <tr key={t.id} className="clickable" onClick={() => setE(t)}>
        <td className="mono"><span aria-hidden="true" style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 3, background: t.color, marginRight: 4 }} />{t.code} <strong>{t.short}</strong></td>
        <td>{t.name}</td><td>{t.unit === 'workday' ? 'სამუშაო დღე' : 'კალენდარული'}</td><td>{t.has_balance ? (t.default_days !== null ? `${Number(t.default_days)} / წელი` : 'ხელით') : '—'}</td>
        <td>{ROUTE_KA[t.route]}{t.self_request ? '' : ' · მხოლოდ ხელმძღვანელი / HR'}</td><td>{t.requires_document ? '✓' : ''}</td><td>{t.paid ? '✓' : ''}{t.counts_as_work ? ' · ნამუშ.' : ''}</td>
        <td>{!t.is_active && <span className="chip">გათიშული</span>}</td></tr>)}</tbody></table>
    {e && <AbsenceTypeDialog t={e === 'new' ? null : e} onClose={() => setE(null)} onDone={() => { setE(null); onDone(); }} />}
  </Section>;
}
function AbsenceTypeDialog({ t, onClose, onDone }: { t: AbsenceType | null; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ code: t?.code ?? '', name: t?.name ?? '', short: t?.short ?? '', color: t?.color ?? '#94a3b8', paid: t?.paid ?? true, counts_as_work: t?.counts_as_work ?? false,
    unit: t?.unit ?? 'workday', has_balance: t?.has_balance ?? false, default_days: t?.default_days !== null && t?.default_days !== undefined ? String(Number(t.default_days)) : '', route: t?.route ?? 'head_hr',
    requires_document: t?.requires_document ?? false, self_request: t?.self_request ?? true, is_active: t?.is_active ?? true, sort_order: String(t?.sort_order ?? 100) });
  const m = useMutation({ mutationFn: () => api(t ? `/roster/absence-types/${t.id}` : '/roster/absence-types', { method: t ? 'PATCH' : 'POST', body: {
    ...(!t && { code: f.code }), name: f.name.trim(), short: f.short.trim(), color: f.color, paid: f.paid, counts_as_work: f.counts_as_work, unit: f.unit, has_balance: f.has_balance,
    default_days: f.has_balance && f.default_days !== '' ? Number(f.default_days) : null, route: f.route, requires_document: f.requires_document, self_request: f.self_request,
    sort_order: Number(f.sort_order) || 100, ...(t && { is_active: f.is_active }) } }), onSuccess: onDone });
  const ck = (k: 'paid' | 'counts_as_work' | 'has_balance' | 'requires_document' | 'self_request' | 'is_active', l: string) => <label className="row"><input type="checkbox" checked={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.checked })} /> {l}</label>;
  return <Modal title={t ? t.name : 'ახალი არყოფნის ტიპი'} onClose={onClose} footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button>
    <button className="btn primary" type="button" disabled={m.isPending || f.name.trim().length < 2 || !f.short.trim() || (!t && !/^[A-Z][A-Z0-9_]{1,19}$/.test(f.code))} onClick={() => m.mutate()}>შენახვა</button></>}>
    <div className="stack">
      <div className="row" style={{ gap: 8 }}>
        {!t && <Field label="კოდი" htmlFor="at-c" required><input id="at-c" className="input mono" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '') })} /></Field>}
        <Field label="მოკლე (ბადეში)" htmlFor="at-s" required hint="≤ 3 სიმბოლო"><input id="at-s" className="input" maxLength={3} value={f.short} onChange={(e) => setF({ ...f, short: e.target.value })} /></Field>
        <Field label="ფერი" htmlFor="at-k"><input id="at-k" className="input" type="color" value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} /></Field></div>
      <Field label="დასახელება" htmlFor="at-n" required><input id="at-n" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <div className="row" style={{ gap: 8 }}>
        <Field label="ერთეული" htmlFor="at-u"><select id="at-u" className="select" value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value as AbsenceType['unit'] })}>
          <option value="workday">სამუშაო დღე (ორშ.–პარ., დღესასწაულების გარეშე)</option><option value="calendar">კალენდარული დღე</option></select></Field>
        <Field label="დადასტურება" htmlFor="at-r"><select id="at-r" className="select" value={f.route} onChange={(e) => setF({ ...f, route: e.target.value as AbsenceType['route'] })}>
          {Object.entries(ROUTE_KA).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field></div>
      {ck('has_balance', 'ბალანსით (წლიური ნორმა / ჟურნალი)')}
      {f.has_balance && <Field label="წლიური ნორმა (დღე)" htmlFor="at-d" hint="ცარიელი — მხოლოდ ხელით (მაგ. ნაცვლად დასვენება). შრომის კოდექსის მინიმუმი — 24 სამუშაო დღე. ინდივიდუალური — „დასადასტურებელი → ბალანსები“."><input id="at-d" className="input mono" style={{ maxWidth: 120 }} type="number" step="0.5" min={0} value={f.default_days} onChange={(e) => setF({ ...f, default_days: e.target.value })} /></Field>}
      {ck('requires_document', 'დოკუმენტი სავალდებულოა (HR ნაბიჯამდე)')}{ck('self_request', 'თანამშრომელს შეუძლია თავად მოთხოვნა')}{ck('paid', 'ანაზღაურებადი')}{ck('counts_as_work', 'ითვლება ნამუშევრად (ტაბელი — 0079)')}
      <Field label="რიგი" htmlFor="at-o"><input id="at-o" className="input mono" style={{ maxWidth: 120 }} type="number" value={f.sort_order} onChange={(e) => setF({ ...f, sort_order: e.target.value })} /></Field>
      {t && ck('is_active', 'აქტიური')}
      <ErrorBox error={m.error} />
    </div></Modal>;
}
