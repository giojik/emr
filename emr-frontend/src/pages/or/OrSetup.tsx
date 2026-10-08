import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { ErrorBox, Field, Loading, Modal, useDebounced, useToast } from '../../components/ui';
import { AnesthesiaTariffs } from './Postop';
import { APPLIES_KA, GRP_KA, hm, SOURCE_KA, useOrSetup, WHO_KA, type Procedure, type Ref, type Room, type Setup, type TeamRole } from './types';

const DOW = ['ორშ', 'სამ', 'ოთხ', 'ხუთ', 'პარ', 'შაბ', 'კვი'];
type View = 'rooms' | 'procedures' | 'refs' | 'checklists' | 'billing';

/** ადმინისტრირება → საოპერაციო (0048): ბლოკი, ოთახები, პროცედურების კატალოგი, ცნობარები, ჩეკლისტები */
export default function OrSetup() {
  const q = useOrSetup(true); const [view, setView] = useState<View>('rooms');
  const V: [View, string][] = [['rooms', 'ბლოკი და ოთახები'], ['procedures', 'პროცედურების კატალოგი'], ['refs', 'ცნობარები'], ['checklists', 'მზადყოფნა / WHO'], ['billing', 'ანესთეზიის ტარიფები']];
  return (
    <div className="content">
      <span className="hint">საოპერაციო ბლოკი — განყოფილება ტიპით „საოპერაციო ბლოკი“ (<Link to="/admin/departments">განყოფილებები</Link>). პარამეტრები (ვინ გეგმავს, ანესთეზიის გუნდი, მზადყოფნის სიმკაცრე) — <Link to="/admin/modules">მოდულები</Link>.</span>
      <div className="seg" role="group" aria-label="განყოფილება" style={{ width: 'max-content', flexWrap: 'wrap' }}>
        {V.map(([k, l]) => <button key={k} type="button" aria-pressed={view === k} onClick={() => setView(k)}>{l}</button>)}</div>
      <ErrorBox error={q.error} />
      {q.isLoading || !q.data ? <Loading /> : view === 'rooms' ? <Rooms s={q.data} /> : view === 'procedures' ? <Procedures s={q.data} /> : view === 'refs' ? <Refs s={q.data} /> : view === 'billing' ? <AnesthesiaTariffs /> : <Checklists s={q.data} />}
    </div>
  );
}
const inval = (qc: ReturnType<typeof useQueryClient>) => { void qc.invalidateQueries({ queryKey: ['or-setup'] }); void qc.invalidateQueries({ queryKey: ['or-procs-admin'] }); };

// ================================================================= ბლოკი + ოთახები
function Rooms({ s }: { s: Setup }) {
  const qc = useQueryClient(); const toast = useToast();
  const [edit, setEdit] = useState<Partial<Room> | null>(null);
  const loc = useMutation({ mutationFn: (a: { id: string; v: string }) => api(`/or/blocks/${a.id}`, { method: 'PATCH', body: { stock_location_id: a.v || null } }),
    onSuccess: () => { toast.show('შენახულია'); inval(qc); } });
  const spec = (c: string) => s.specialties.find((x) => x.code === c)?.name ?? c;
  return (
    <div className="stack">
      {toast.node}
      {!s.blocks.length && <div className="alert warn">საოპერაციო ბლოკი არ არის — შექმენით განყოფილება ტიპით „საოპერაციო ბლოკი“.</div>}
      {s.blocks.map((b) => (
        <section key={b.id} className="card">
          <div className="card-head"><h2 className="grow">{b.name} <span className="small muted mono">{b.code}</span></h2>
            <label className="row small">საწყობის ლოკაცია
              <select className="select" style={{ height: 34, maxWidth: 280 }} value={b.stock_location_id ?? ''} onChange={(e) => loc.mutate({ id: b.id, v: e.target.value })}>
                <option value="">— არ არის —</option>{s.locations.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.code})</option>)}</select></label>
            <button className="btn sm primary" type="button" onClick={() => setEdit({ department_id: b.id, work_start: '08:00', work_end: '18:00', work_days: [1, 2, 3, 4, 5], specialties: [], emergency_only: false })}>+ ოთახი</button>
          </div>
          <table className="table">
            <thead><tr><th>კოდი</th><th>დასახელება</th><th>სამუშაო დრო</th><th>სპეციალობები</th><th>სტატუსი</th><th /></tr></thead>
            <tbody>{s.rooms.filter((r) => r.department_id === b.id).map((r) => (
              <tr key={r.id} style={r.is_active ? undefined : { opacity: 0.55 }}>
                <td className="mono"><strong>{r.code}</strong></td><td>{r.name}{r.notes && <div className="small muted">{r.notes}</div>}</td>
                <td className="small">{hm(r.work_start)}–{hm(r.work_end)}<div className="muted">{r.work_days.length === 7 ? 'ყოველდღე' : r.work_days.map((d) => DOW[d - 1]).join(', ')}</div></td>
                <td className="small">{r.specialties.length ? r.specialties.map(spec).join(', ') : <span className="muted">ნებისმიერი</span>}{r.emergency_only && <div><span className="chip danger">გადაუდებელი</span></div>}</td>
                <td>{r.is_active ? <span className="chip ok">აქტიური</span> : <span className="chip">გათიშული</span>}</td>
                <td><button className="btn sm" type="button" onClick={() => setEdit(r)}>რედაქტირება</button></td>
              </tr>))}
              {!s.rooms.some((r) => r.department_id === b.id) && <tr><td colSpan={6} className="empty">ოთახი არ არის</td></tr>}</tbody>
          </table>
        </section>))}
      <ErrorBox error={loc.error} />
      {edit && <RoomDialog s={s} r={edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function RoomDialog({ s, r, onClose }: { s: Setup; r: Partial<Room>; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ code: r.code ?? '', name: r.name ?? '', work_start: hm(r.work_start ?? '08:00'), work_end: hm(r.work_end ?? '18:00'), work_days: r.work_days ?? [1, 2, 3, 4, 5],
    specialties: r.specialties ?? [], emergency_only: r.emergency_only ?? false, notes: r.notes ?? '', is_active: r.is_active ?? true });
  const m = useMutation({ mutationFn: () => (r.id ? api(`/or/rooms/${r.id}`, { method: 'PATCH', body: { ...f, notes: f.notes || null } })
    : api('/or/rooms', { body: { ...f, department_id: r.department_id, notes: f.notes || null } })), onSuccess: () => { inval(qc); onClose(); } });
  const tog = <T,>(a: T[], v: T) => (a.includes(v) ? a.filter((x) => x !== v) : [...a, v]);
  return (
    <Modal title={r.id ? `ოთახი ${r.code}` : 'ახალი ოთახი'} onClose={onClose} width={640}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={!f.code || f.name.length < 2 || m.isPending} onClick={() => m.mutate()}>შენახვა</button></>}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 12 }}>
        <Field label="კოდი" htmlFor="rm-c" required><input id="rm-c" className="input mono" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} placeholder="OR1" /></Field>
        <Field label="დასახელება" htmlFor="rm-n" required><input id="rm-n" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="დაწყება" htmlFor="rm-s"><input id="rm-s" className="input" type="time" value={f.work_start} onChange={(e) => setF({ ...f, work_start: e.target.value })} /></Field>
        <Field label="დასრულება" htmlFor="rm-e"><input id="rm-e" className="input" type="time" value={f.work_end} onChange={(e) => setF({ ...f, work_end: e.target.value })} /></Field>
      </div>
      <div className="stack" style={{ gap: 4 }}><span className="label">სამუშაო დღეები</span><div className="seg" role="group" aria-label="სამუშაო დღეები" style={{ width: 'max-content' }}>
        {DOW.map((d, i) => <button key={d} type="button" aria-pressed={f.work_days.includes(i + 1)} onClick={() => setF({ ...f, work_days: tog(f.work_days, i + 1).sort() })}>{d}</button>)}</div></div>
      <div className="stack" style={{ gap: 4 }}><span className="label">სპეციალობები (ცარიელი — ნებისმიერი)</span><div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
        {s.specialties.filter((x) => x.is_active || f.specialties.includes(x.code)).map((x) => <label key={x.code} className="row small"><input type="checkbox" checked={f.specialties.includes(x.code)}
          onChange={() => setF({ ...f, specialties: tog(f.specialties, x.code) })} /> {x.name}</label>)}</div></div>
      <label className="row"><input type="checkbox" checked={f.emergency_only} onChange={(e) => setF({ ...f, emergency_only: e.target.checked })} /> გადაუდებლის ოთახი (გეგმიური — გაფრთხილებით)</label>
      <Field label="შენიშვნა" htmlFor="rm-no"><input id="rm-no" className="input" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      {r.id && <label className="row"><input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> აქტიური</label>}
      <ErrorBox error={m.error} />
    </Modal>
  );
}

// ================================================================= პროცედურები
function Procedures({ s }: { s: Setup }) {
  const [q, setQ] = useState(''); const dq = useDebounced(q.trim(), 250); const [sp, setSp] = useState('');
  const list = useQuery({ queryKey: ['or-procs-admin', dq, sp], queryFn: () => api<Procedure[]>('/or/procedures', { query: { q: dq || undefined, all: true, specialty: sp || undefined } }) });
  const [edit, setEdit] = useState<Partial<Procedure> | null>(null); const [imp, setImp] = useState(false);
  return (
    <div className="stack">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <input className="input" style={{ maxWidth: 340, height: 40 }} aria-label="ძებნა" placeholder="ძებნა: დასახელება, კოდი, NCSP" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="select" style={{ maxWidth: 260, height: 40 }} aria-label="სპეციალობა" value={sp} onChange={(e) => setSp(e.target.value)}>
          <option value="">ყველა სპეციალობა</option>{s.specialties.map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}</select>
        <span className="grow" />
        <button className="btn" type="button" onClick={() => setImp(true)}>CSV იმპორტი</button>
        <button className="btn primary" type="button" onClick={() => setEdit({ default_duration_min: 60, laterality: false, is_active: true })}>+ პროცედურა</button>
      </div>
      <ErrorBox error={list.error} />
      {list.isLoading ? <Loading /> : (
        <div className="card"><table className="table">
          <thead><tr><th>კოდი</th><th>NCSP</th><th>დასახელება</th><th>სპეციალობა</th><th className="num">წთ</th><th>მხარე</th><th>ტარიფი</th><th /></tr></thead>
          <tbody>{list.data?.map((p) => (
            <tr key={p.id} style={p.is_active ? undefined : { opacity: 0.55 }}>
              <td className="mono">{p.code}</td><td className="mono">{p.ncsp_code ?? '—'}</td><td>{p.name}</td><td className="small">{p.specialty_name ?? '—'}</td>
              <td className="num">{p.default_duration_min}</td><td>{p.laterality ? <span className="chip warn">სავალდ.</span> : ''}</td>
              <td className="small">{p.tariff_code ? `${p.tariff_code} · ${Number(p.tariff_price).toFixed(2)} ₾` : <span className="muted">—</span>}</td>
              <td><button className="btn sm" type="button" onClick={() => setEdit(p)}>რედაქტირება</button></td>
            </tr>))}
            {!list.data?.length && <tr><td colSpan={8} className="empty">კატალოგი ცარიელია — დაამატეთ ან შემოიტანეთ CSV-ით</td></tr>}</tbody>
        </table></div>)}
      {edit && <ProcDialog s={s} p={edit} onClose={() => setEdit(null)} />}
      {imp && <ImportDialog onClose={() => setImp(false)} />}
    </div>
  );
}

function ProcDialog({ s, p, onClose }: { s: Setup; p: Partial<Procedure>; onClose: () => void }) {
  const qc = useQueryClient();
  const tariffs = useQuery({ queryKey: ['tariffs', 'all'], queryFn: () => api<{ id: string; code: string; title: string; base_price: string; is_active: boolean }[]>('/tariffs') });
  const [f, setF] = useState({ code: p.code ?? '', ncsp_code: p.ncsp_code ?? '', name: p.name ?? '', specialty_code: p.specialty_code ?? '', default_duration_min: p.default_duration_min ?? 60,
    laterality: p.laterality ?? false, tariff_id: p.tariff_id ?? '', is_active: p.is_active ?? true });
  const m = useMutation({
    mutationFn: () => { const b = { ...f, ncsp_code: f.ncsp_code || null, specialty_code: f.specialty_code || null, tariff_id: f.tariff_id || null, default_duration_min: Number(f.default_duration_min) };
      return p.id ? api(`/or/procedures/${p.id}`, { method: 'PATCH', body: b }) : api('/or/procedures', { body: b }); },
    onSuccess: () => { inval(qc); onClose(); } });
  return (
    <Modal title={p.id ? `პროცედურა ${p.code}` : 'ახალი პროცედურა'} onClose={onClose} width={680}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={!f.code || f.name.length < 3 || m.isPending} onClick={() => m.mutate()}>შენახვა</button></>}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="კოდი (კლინიკის)" htmlFor="pr-c" required><input id="pr-c" className="input mono" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
        <Field label="NCSP კოდი" htmlFor="pr-n" hint="DRG grouper-ისთვის (მაგ. JEA00)"><input id="pr-n" className="input mono" value={f.ncsp_code} onChange={(e) => setF({ ...f, ncsp_code: e.target.value.toUpperCase() })} /></Field>
      </div>
      <Field label="დასახელება" htmlFor="pr-na" required><input id="pr-na" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
        <Field label="სპეციალობა" htmlFor="pr-s"><select id="pr-s" className="select" value={f.specialty_code} onChange={(e) => setF({ ...f, specialty_code: e.target.value })}>
          <option value="">—</option>{s.specialties.map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}</select></Field>
        <Field label="ხანგრძლივობა (წთ)" htmlFor="pr-d"><input id="pr-d" className="input mono" type="number" min={5} max={1440} value={f.default_duration_min} onChange={(e) => setF({ ...f, default_duration_min: Number(e.target.value) })} /></Field>
      </div>
      <Field label="ტარიფი (ბილინგი — 0049)" htmlFor="pr-t"><select id="pr-t" className="select" value={f.tariff_id} onChange={(e) => setF({ ...f, tariff_id: e.target.value })}>
        <option value="">—</option>{(tariffs.data ?? []).filter((t) => t.is_active || t.id === f.tariff_id).map((t) => <option key={t.id} value={t.id}>{t.code} — {t.title} ({Number(t.base_price).toFixed(2)} ₾)</option>)}</select></Field>
      <label className="row"><input type="checkbox" checked={f.laterality} onChange={(e) => setF({ ...f, laterality: e.target.checked })} /> მხარე სავალდებულოა (მარცხ. / მარჯვ. / ორმხრივი)</label>
      {p.id && <label className="row"><input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> აქტიური</label>}
      <ErrorBox error={m.error} />
    </Modal>
  );
}

function ImportDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient(); const [csv, setCsv] = useState(''); const [deact, setDeact] = useState(false);
  type Res = { rows: number; added: number; changed: number; deactivated: number; missing: number; errors: string[]; applied: boolean };
  const [res, setRes] = useState<Res | null>(null);
  const m = useMutation({ mutationFn: (dry: boolean) => api<Res>('/or/procedures/import', { body: { csv, deactivate_missing: deact, dry_run: dry } }),
    onSuccess: (r) => { setRes(r); if (r.applied) inval(qc); } });
  return (
    <Modal title="პროცედურების იმპორტი (CSV)" onClose={onClose} width={720}
      footer={<><button className="btn" type="button" onClick={onClose}>დახურვა</button><button className="btn" type="button" disabled={csv.length < 5 || m.isPending} onClick={() => m.mutate(true)}>შემოწმება</button>
        <button className="btn primary" type="button" disabled={csv.length < 5 || m.isPending || !res || res.errors.length > 0 || res.applied} onClick={() => m.mutate(false)}>იმპორტი</button></>}>
      <span className="hint">სვეტები: <span className="mono">code;name;duration_min;specialty;ncsp;laterality</span> — გამყოფი ; / TAB / ,. პირველი სტრიქონი შეიძლება სათაური იყოს. სპეციალობა — ცნობარის კოდი (მაგ. ortho); laterality — კი / 1.
        არსებული კოდი განახლდება, ტარიფი იმპორტით არ იცვლება.</span>
      <input type="file" accept=".csv,.txt,text/csv" aria-label="CSV ფაილი" onChange={async (e) => { const fl = e.target.files?.[0]; if (fl) { setCsv(await fl.text()); setRes(null); } }} />
      <textarea className="textarea mono" rows={8} aria-label="CSV" value={csv} onChange={(e) => { setCsv(e.target.value); setRes(null); }} placeholder="code;name;duration;specialty;ncsp;laterality" />
      <label className="row"><input type="checkbox" checked={deact} onChange={(e) => { setDeact(e.target.checked); setRes(null); }} /> ფაილში არმყოფი პროცედურების გათიშვა</label>
      {res && <div className={`alert ${res.errors.length ? 'danger' : res.applied ? 'ok' : 'info'}`}><div className="stack" style={{ gap: 2 }}>
        <span>სტრიქონი: {res.rows} · ახალი: {res.added} · შეცვლილი: {res.changed} · გაითიშება: {res.deactivated}{res.applied ? ' — ჩაიწერა' : ''}</span>
        {res.errors.map((e) => <span key={e}>• {e}</span>)}</div></div>}
      <ErrorBox error={m.error} />
    </Modal>
  );
}

// ================================================================= ცნობარები
function Refs({ s }: { s: Setup }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: 14, alignItems: 'start' }}>
      <RefList title="სპეციალობები" kind="specialties" rows={s.specialties} />
      <RefList title="გაუქმების მიზეზები" kind="cancel-reasons" rows={s.cancel_reasons} />
      <RefList title="გუნდის როლები" kind="team-roles" rows={s.team_roles} team />
    </div>
  );
}
function RefList({ title, kind, rows, team }: { title: string; kind: string; rows: (Ref | TeamRole)[]; team?: boolean }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ code: '', name: '', grp: 'surgical', capability: 'doctor', multiple: true });
  const save = useMutation({ mutationFn: (a: { code?: string; body: Record<string, unknown> }) => (a.code ? api(`/or/refs/${kind}/${a.code}`, { method: 'PATCH', body: a.body }) : api(`/or/refs/${kind}`, { body: a.body })),
    onSuccess: () => { inval(qc); setF({ ...f, code: '', name: '' }); } });
  return (
    <section className="card">
      <div className="card-head"><h2>{title}</h2></div>
      <table className="table"><tbody>{rows.map((r) => (
        <tr key={r.code} style={r.is_active ? undefined : { opacity: 0.55 }}>
          <td className="mono small">{r.code}</td>
          <td>{r.name}{team && <div className="small muted">{GRP_KA[(r as TeamRole).grp]} · {(r as TeamRole).capability}{(r as TeamRole).multiple ? ' · რამდენიმე' : ''}</div>}</td>
          <td>{!(r as TeamRole).is_system && <label className="row small"><input type="checkbox" checked={r.is_active} onChange={(e) => save.mutate({ code: r.code, body: { is_active: e.target.checked } })} /> აქტიური</label>}
            {(r as TeamRole).is_system && <span className="chip">სისტემური</span>}</td>
        </tr>))}</tbody></table>
      <div className="card-pad stack" style={{ gap: 8, borderTop: '1px solid var(--line-soft)' }}>
        <div className="row"><input className="input mono" style={{ maxWidth: 140 }} aria-label="კოდი" placeholder="code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />
          <input className="input" aria-label="დასახელება" placeholder="დასახელება" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
        {team && <div className="row"><select className="select" aria-label="ჯგუფი" value={f.grp} onChange={(e) => setF({ ...f, grp: e.target.value })}>{Object.entries(GRP_KA).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          <select className="select" aria-label="უფლება" value={f.capability} onChange={(e) => setF({ ...f, capability: e.target.value })}>
            {[['doctor', 'ექიმი'], ['anesthesiologist', 'ანესთეზიოლოგი'], ['or_nurse', 'საოპერაციო ექთანი'], ['nurse', 'ექთანი']].map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>}
        <button className="btn sm" type="button" style={{ alignSelf: 'flex-start' }} disabled={!f.code || f.name.length < 2 || save.isPending}
          onClick={() => save.mutate({ body: { code: f.code, name: f.name, ...(team && { grp: f.grp, capability: f.capability, multiple: f.multiple }) } })}>+ დამატება</button>
        <ErrorBox error={save.error} />
      </div>
    </section>
  );
}

// ================================================================= ჩეკლისტები
function Checklists({ s }: { s: Setup }) {
  const qc = useQueryClient();
  const [ri, setRi] = useState({ label: '', applies: 'always' });
  const [wi, setWi] = useState({ phase: 'sign_in', label: '' });
  const r = useMutation({ mutationFn: (a: { id?: string; body: Record<string, unknown> }) => (a.id ? api(`/or/readiness-items/${a.id}`, { method: 'PATCH', body: a.body }) : api('/or/readiness-items', { body: a.body })),
    onSuccess: () => { inval(qc); setRi({ ...ri, label: '' }); } });
  const w = useMutation({ mutationFn: (a: { id?: string; body: Record<string, unknown> }) => (a.id ? api(`/or/who-items/${a.id}`, { method: 'PATCH', body: a.body }) : api('/or/who-items', { body: a.body })),
    onSuccess: () => { inval(qc); setWi({ ...wi, label: '' }); } });
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(440px, 1fr))', gap: 14, alignItems: 'start' }}>
      <section className="card">
        <div className="card-head"><h2>წინასაოპერაციო მზადყოფნა</h2></div>
        <table className="table"><tbody>{s.readiness_items.map((i) => (
          <tr key={i.id} style={i.is_active ? undefined : { opacity: 0.55 }}>
            <td>{i.label}<div className="small muted">{SOURCE_KA[i.source]} · {APPLIES_KA[i.applies]}</div></td>
            <td><label className="row small"><input type="checkbox" checked={i.is_active} onChange={(e) => r.mutate({ id: i.id, body: { is_active: e.target.checked } })} /> აქტიური</label></td>
          </tr>))}</tbody></table>
        <div className="card-pad row" style={{ borderTop: '1px solid var(--line-soft)' }}>
          <input className="input" aria-label="ახალი პუნქტი" placeholder="ახალი პუნქტი" value={ri.label} onChange={(e) => setRi({ ...ri, label: e.target.value })} />
          <select className="select" style={{ maxWidth: 200 }} aria-label="როდის ეხება" value={ri.applies} onChange={(e) => setRi({ ...ri, applies: e.target.value })}>
            {Object.entries(APPLIES_KA).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          <button className="btn sm" type="button" disabled={ri.label.trim().length < 3 || r.isPending} onClick={() => r.mutate({ body: { label: ri.label.trim(), applies: ri.applies } })}>+</button>
        </div>
        <ErrorBox error={r.error} />
      </section>
      <section className="card">
        <div className="card-head"><h2>WHO ჩეკლისტი</h2></div>
        {(['sign_in', 'time_out', 'sign_out'] as const).map((p) => (
          <div key={p}>
            <div className="card-pad" style={{ paddingBottom: 4 }}><strong>{WHO_KA[p][0]}</strong> <span className="small muted">— {WHO_KA[p][1]}</span></div>
            <table className="table"><tbody>{s.who_items.filter((i) => i.phase === p).map((i) => (
              <tr key={i.id} style={i.is_active ? undefined : { opacity: 0.55 }}><td className="small">{i.label}</td>
                <td style={{ width: 110 }}><label className="row small"><input type="checkbox" checked={i.is_active} onChange={(e) => w.mutate({ id: i.id, body: { is_active: e.target.checked } })} /> აქტიური</label></td></tr>))}</tbody></table>
          </div>))}
        <div className="card-pad row" style={{ borderTop: '1px solid var(--line-soft)' }}>
          <select className="select" style={{ maxWidth: 140 }} aria-label="ეტაპი" value={wi.phase} onChange={(e) => setWi({ ...wi, phase: e.target.value })}>
            {Object.entries(WHO_KA).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select>
          <input className="input" aria-label="ახალი პუნქტი" placeholder="ახალი პუნქტი" value={wi.label} onChange={(e) => setWi({ ...wi, label: e.target.value })} />
          <button className="btn sm" type="button" disabled={wi.label.trim().length < 3 || w.isPending} onClick={() => w.mutate({ body: { phase: wi.phase, label: wi.label.trim() } })}>+</button>
        </div>
        <ErrorBox error={w.error} />
      </section>
    </div>
  );
}
