import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, can } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Field, Loading, Modal } from '../../components/ui';
import { dateGe, tsDate } from '../../lib/format';
import { invalOr } from './Dialogs';
import { caseLink, useOrModule, type Procedure } from './types';

/** ოქმის შაბლონები + preference card-ები (0049) — ქირურგი (პირადი), admin / ბლოკის მთავარი ექთანი (ზოგადი) */
interface Tpl { id: string; name: string; procedure_id: string | null; procedure_name: string | null; procedure_code: string | null; owner_id: string | null; owner_name: string | null;
  description: string | null; findings: string | null; is_active: boolean; updated_at: string }
interface CardItem { item_id: string; qty: string; note: string | null; name: string; unit_name: string; kind: string }
interface Card { id: string; procedure_id: string; procedure_code: string; procedure_name: string; surgeon_id: string | null; surgeon_name: string | null; notes: string | null;
  is_active: boolean; updated_at: string; updated_by_name: string | null; items: CardItem[] }
interface CatItem { id: string; code: string; name: string; unit_name: string; kind: string }
interface Staff { id: string; name: string }

const useProcs = () => useQuery({ queryKey: ['or-procs-all'], queryFn: () => api<Procedure[]>('/or/procedures'), staleTime: 60_000 });

export default function Library() {
  const { user } = useAuth(); const mod = useOrModule();
  const docs = can(user, 'admin', 'doctor');
  const [v, setV] = useState<'tpl' | 'cards'>(docs ? 'tpl' : 'cards');
  return (
    <div className="content">
      <div className="row" style={{ gap: 2, borderBottom: '1px solid var(--line)' }}>
        {docs && <button type="button" className={`admin-tab${v === 'tpl' ? ' active' : ''}`} style={{ border: 0, background: 'none', font: 'inherit', cursor: 'pointer' }} onClick={() => setV('tpl')}>ოქმის შაბლონები</button>}
        <button type="button" className={`admin-tab${v === 'cards' ? ' active' : ''}`} style={{ border: 0, background: 'none', font: 'inherit', cursor: 'pointer' }} onClick={() => setV('cards')}>Preference card-ები</button>
      </div>
      {v === 'tpl' && docs ? <Templates /> : mod.settings.preference_cards === 'off'
        ? <div className="card empty">Preference card-ები გამორთულია (პარამეტრი preference_cards = off).</div> : <Cards />}
    </div>
  );
}

// ================================================================= ოქმის შაბლონები
function Templates() {
  const { user } = useAuth(); const admin = can(user, 'admin');
  const [all, setAll] = useState(false);
  const q = useQuery({ queryKey: ['or-note-tpl', all], queryFn: () => api<Tpl[]>('/or/note-templates', { query: { all } }) });
  const [ed, setEd] = useState<Tpl | 'new' | null>(null);
  const mine = (t: Tpl) => t.owner_id === user?.id;
  return (
    <section className="card">
      <div className="card-head"><h2 className="grow">ოქმის შაბლონები</h2>
        <label className="row small"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> არააქტიურებიც</label>
        <button className="btn primary sm" type="button" onClick={() => setEd('new')}>+ შაბლონი</button></div>
      <div className="card-pad small muted" style={{ paddingTop: 0 }}>პროცედურის შაბლონი (ყველასთვის) — admin; პირადი — თავად ქირურგი. ოქმში ჩანს: პირადი + ოპერაციის პროცედურების შაბლონები.</div>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : !q.data?.length ? <div className="empty">შაბლონები ჯერ არ არის.</div> : (
        <table className="table">
          <thead><tr><th>დასახელება</th><th>პროცედურა</th><th>ტიპი</th><th>განახლდა</th><th /></tr></thead>
          <tbody>{q.data.map((t) => (
            <tr key={t.id} style={t.is_active ? undefined : { opacity: 0.55 }}>
              <td><strong>{t.name}</strong>{t.description && <div className="small muted" style={{ maxWidth: 520, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.description}</div>}</td>
              <td>{t.procedure_name ? <><span className="mono small">{t.procedure_code}</span> {t.procedure_name}</> : <span className="muted">—</span>}</td>
              <td>{t.owner_id ? <span className="chip info">პირადი{mine(t) ? '' : ` · ${t.owner_name}`}</span> : <span className="chip">პროცედურის</span>}</td>
              <td className="small mono">{tsDate(t.updated_at)}</td>
              <td>{(t.owner_id ? mine(t) || admin : admin) && <button className="btn sm" type="button" onClick={() => setEd(t)}>რედაქტირება</button>}</td>
            </tr>))}</tbody>
        </table>)}
      {ed && <TplDialog t={ed === 'new' ? null : ed} onClose={() => setEd(null)} />}
    </section>
  );
}

function TplDialog({ t, onClose }: { t: Tpl | null; onClose: () => void }) {
  const { user } = useAuth(); const qc = useQueryClient(); const procs = useProcs();
  const admin = can(user, 'admin'); const doctor = can(user, 'doctor');
  const [f, setF] = useState({ name: t?.name ?? '', personal: t ? !!t.owner_id : !admin || doctor, procedure_id: t?.procedure_id ?? '',
    description: t?.description ?? '', findings: t?.findings ?? '', is_active: t?.is_active ?? true });
  const m = useMutation({
    mutationFn: () => {
      const body = { name: f.name.trim(), procedure_id: f.procedure_id || null, description: f.description || null, findings: f.findings || null, is_active: f.is_active };
      return t ? api(`/or/note-templates/${t.id}`, { method: 'PATCH', body }) : api('/or/note-templates', { body: { ...body, personal: f.personal } });
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['or-note-tpl'] }); invalOr(qc); onClose(); } });
  return (
    <Modal title={t ? `შაბლონი — ${t.name}` : 'ახალი ოქმის შაბლონი'} onClose={onClose} width={720}
      footer={<><button className="btn" type="button" onClick={onClose}>დახურვა</button>
        <button className="btn primary" type="button" disabled={f.name.trim().length < 2 || (!f.personal && !f.procedure_id) || m.isPending} onClick={() => m.mutate()}>შენახვა</button></>}>
      {!t && admin && doctor && <div className="row" style={{ gap: 14 }}>
        <label className="row"><input type="radio" checked={f.personal} onChange={() => setF({ ...f, personal: true })} /> პირადი</label>
        <label className="row"><input type="radio" checked={!f.personal} onChange={() => setF({ ...f, personal: false })} /> პროცედურის (ყველასთვის)</label></div>}
      <Field label="დასახელება" htmlFor="nt-n" required><input id="nt-n" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <Field label={f.personal ? 'პროცედურა (არასავალდებულო)' : 'პროცედურა'} htmlFor="nt-p" required={!f.personal}>
        <select id="nt-p" className="select" value={f.procedure_id} onChange={(e) => setF({ ...f, procedure_id: e.target.value })}><option value="">—</option>
          {t?.procedure_id && !procs.data?.some((p) => p.id === t.procedure_id) && <option value={t.procedure_id}>{t.procedure_code} — {t.procedure_name}</option>}
          {(procs.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}</select></Field>
      <Field label="ოპერაციის აღწერა" htmlFor="nt-d"><textarea id="nt-d" className="textarea" rows={9} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      <Field label="აღმოჩენები (ნაგულისხმევი)" htmlFor="nt-f"><textarea id="nt-f" className="textarea" rows={3} value={f.findings} onChange={(e) => setF({ ...f, findings: e.target.value })} /></Field>
      {t && <label className="row"><input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> აქტიური</label>}
      <ErrorBox error={m.error} />
    </Modal>
  );
}

// ================================================================= preference card-ები
function Cards() {
  const { user } = useAuth(); const mod = useOrModule();
  const [mineOnly, setMineOnly] = useState(can(user, 'doctor') && !can(user, 'admin', 'or_nurse'));
  const q = useQuery({ queryKey: ['or-pref-cards', mineOnly], queryFn: () => api<Card[]>('/or/preference-cards', { query: mineOnly && user ? { surgeon_id: user.id } : {} }) });
  const [ed, setEd] = useState<Card | 'new' | null>(null);
  const canEdit = (k: Card) => can(user, 'admin', 'or_nurse') || (k.surgeon_id === user?.id && can(user, 'doctor'));
  return (
    <section className="card">
      <div className="card-head"><h2 className="grow">Preference card-ები</h2>
        {can(user, 'doctor') && <label className="row small"><input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} /> მხოლოდ ჩემი</label>}
        <button className="btn primary sm" type="button" onClick={() => setEd('new')}>+ ბარათი</button></div>
      <div className="card-pad small muted" style={{ paddingTop: 0 }}>
        {mod.settings.preference_cards === 'procedure' ? 'რეჟიმი: პროცედურაზე — გამოიყენება მხოლოდ ზოგადი ბარათი.' : 'რეჟიმი: პროცედურა + ქირურგი — ქირურგის ბარათი, თუ არ აქვს — ზოგადი.'}
        {' '}ზოგადი — admin / ბლოკის მთავარი ექთანი; ქირურგის — თავად ქირურგი ან მთავარი ექთანი. ოპერაციაზე „შეკრება“ ბარათიდან ავსებს მასალებს.</div>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : !q.data?.length ? <div className="empty">ბარათები ჯერ არ არის.</div> : (
        <table className="table">
          <thead><tr><th>პროცედურა</th><th>ქირურგი</th><th>პოზიციები</th><th>განახლდა</th><th /></tr></thead>
          <tbody>{q.data.map((k) => (
            <tr key={k.id} style={k.is_active ? undefined : { opacity: 0.55 }}>
              <td><span className="mono small">{k.procedure_code}</span> {k.procedure_name}</td>
              <td>{k.surgeon_name ?? <span className="chip">ზოგადი</span>}</td>
              <td className="small">{k.items.map((i) => `${i.name} × ${Number(i.qty)}`).join(', ') || '—'}</td>
              <td className="small"><span className="mono">{tsDate(k.updated_at)}</span><div className="muted">{k.updated_by_name}</div></td>
              <td>{canEdit(k) && <button className="btn sm" type="button" onClick={() => setEd(k)}>რედაქტირება</button>}</td>
            </tr>))}</tbody>
        </table>)}
      {ed && <CardDialog k={ed === 'new' ? null : ed} onClose={() => setEd(null)} />}
    </section>
  );
}

function CardDialog({ k, onClose }: { k: Card | null; onClose: () => void }) {
  const { user } = useAuth(); const qc = useQueryClient(); const procs = useProcs();
  const staffer = can(user, 'admin', 'or_nurse');
  const surgeons = useQuery({ queryKey: ['or-staff', 'doctor'], queryFn: () => api<Staff[]>('/or/staff', { query: { cap: 'doctor' } }), enabled: staffer });
  const [proc, setProc] = useState(k?.procedure_id ?? '');
  const [surgeon, setSurgeon] = useState<string>(k ? k.surgeon_id ?? '' : staffer ? '' : user?.id ?? '');
  const [items, setItems] = useState<{ item_id: string; name: string; unit_name: string; qty: string; note: string }[]>(
    (k?.items ?? []).map((i) => ({ item_id: i.item_id, name: i.name, unit_name: i.unit_name, qty: String(Number(i.qty)), note: i.note ?? '' })));
  const [notes, setNotes] = useState(k?.notes ?? ''); const [active, setActive] = useState(k?.is_active ?? true);
  const [s, setS] = useState('');
  const cat = useQuery({ queryKey: ['or-cat', s], queryFn: () => api<CatItem[]>('/or/catalog-items', { query: { q: s } }), enabled: s.trim().length >= 2 });
  const m = useMutation({
    mutationFn: () => api('/or/preference-cards', { method: 'PUT', body: { procedure_id: proc, surgeon_id: surgeon || null, notes: notes || null, is_active: active,
      items: items.map((i) => ({ item_id: i.item_id, qty: Number(i.qty), ...(i.note && { note: i.note }) })) } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['or-pref-cards'] }); invalOr(qc); onClose(); } });
  const valid = !!proc && items.every((i) => Number(i.qty) > 0);
  return (
    <Modal title={k ? `ბარათი — ${k.procedure_name}` : 'ახალი preference card'} onClose={onClose} width={760}
      footer={<><button className="btn" type="button" onClick={onClose}>დახურვა</button><button className="btn primary" type="button" disabled={!valid || m.isPending} onClick={() => m.mutate()}>შენახვა</button></>}>
      <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
        <div className="grow"><Field label="პროცედურა" htmlFor="pc-p" required><select id="pc-p" className="select" value={proc} disabled={!!k} onChange={(e) => setProc(e.target.value)}><option value="">—</option>
          {k && !procs.data?.some((p) => p.id === k.procedure_id) && <option value={k.procedure_id}>{k.procedure_code} — {k.procedure_name}</option>}
          {(procs.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}</select></Field></div>
        <div className="grow"><Field label="ქირურგი" htmlFor="pc-s">{staffer
          ? <select id="pc-s" className="select" value={surgeon} disabled={!!k} onChange={(e) => setSurgeon(e.target.value)}><option value="">ზოგადი (ყველა ქირურგი)</option>
              {(surgeons.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
          : <input id="pc-s" className="input" disabled value={k?.surgeon_name ?? user?.name ?? 'მე'} />}</Field></div>
      </div>
      <Field label="მასალის დამატება (კატალოგიდან)" htmlFor="pc-q"><input id="pc-q" className="input" placeholder="დასახელება ან კოდი…" value={s} onChange={(e) => setS(e.target.value)} /></Field>
      {s.trim().length >= 2 && <div className="card" style={{ maxHeight: 180, overflow: 'auto' }}>
        {(cat.data ?? []).filter((c) => !items.some((i) => i.item_id === c.id)).map((c) => (
          <button key={c.id} type="button" className="btn sm" style={{ display: 'block', width: '100%', textAlign: 'left', border: 0, borderRadius: 0 }}
            onClick={() => { setItems([...items, { item_id: c.id, name: c.name, unit_name: c.unit_name, qty: '1', note: '' }]); setS(''); }}>
            <span className="mono small">{c.code}</span> {c.name} <span className="muted small">· {c.unit_name}{c.kind === 'implant' ? ' · იმპლანტი' : ''}</span></button>))}
        {cat.data?.length === 0 && <div className="empty small">ვერ მოიძებნა</div>}</div>}
      <table className="table"><thead><tr><th>პოზიცია</th><th style={{ width: 110 }}>რაოდ.</th><th>შენიშვნა</th><th /></tr></thead>
        <tbody>{items.map((i, n) => (
          <tr key={i.item_id}><td>{i.name} <span className="small muted">· {i.unit_name}</span></td>
            <td><input className="input mono" type="number" min={0} step="any" aria-label={`რაოდენობა — ${i.name}`} value={i.qty} onChange={(e) => setItems(items.map((x, j) => j === n ? { ...x, qty: e.target.value } : x))} /></td>
            <td><input className="input" aria-label={`შენიშვნა — ${i.name}`} value={i.note} onChange={(e) => setItems(items.map((x, j) => j === n ? { ...x, note: e.target.value } : x))} /></td>
            <td><button className="btn sm" type="button" aria-label={`მოხსნა — ${i.name}`} onClick={() => setItems(items.filter((_, j) => j !== n))}>×</button></td></tr>))}
          {!items.length && <tr><td colSpan={4} className="muted small">პოზიციები არ არის</td></tr>}</tbody></table>
      <Field label="შენიშვნა (პოზიცია, ინსტრუმენტები, ქირურგის სურვილები)" htmlFor="pc-n"><textarea id="pc-n" className="textarea" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      {k && <label className="row"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> აქტიური</label>}
      <ErrorBox error={m.error} />
    </Modal>
  );
}

// ================================================================= პაციენტის იმპლანტების რეესტრი (პაციენტის ბარათზე)
interface Implant { id: string; name: string; manufacturer: string | null; lot_no: string; serial_no: string; expires_on: string | null; site: string | null; implanted_at: string;
  removed_at: string | null; removed_reason: string | null; case_id: string | null; case_no: string | null; recorded_by_name: string }
export function ImplantsPanel({ patientId }: { patientId: string }) {
  const { user } = useAuth();
  const allowed = can(user, 'admin', 'doctor', 'nurse', 'or_schedule', 'anesthesiologist', 'or_nurse', 'manager', 'viewer', 'receptionist', 'billing');
  const q = useQuery({ queryKey: ['or-implants', patientId], queryFn: () => api<Implant[]>('/or/implants', { query: { patient_id: patientId } }), enabled: allowed });
  if (!allowed || !q.data?.length) return null;
  return (
    <section className="card">
      <div className="card-head"><h2 className="grow">იმპლანტები</h2><span className="small muted">{q.data.length}</span></div>
      <table className="table">
        <thead><tr><th>იმპლანტი</th><th>ლოტი / სერია</th><th>ადგილი</th><th>თარიღი</th><th>ოპერაცია</th></tr></thead>
        <tbody>{q.data.map((i) => (
          <tr key={i.id} style={i.removed_at ? { opacity: 0.55 } : undefined}>
            <td><strong>{i.name}</strong>{i.manufacturer && <div className="small muted">{i.manufacturer}</div>}{i.removed_at && <div className="small">ამოღებულია: {i.removed_reason}</div>}</td>
            <td className="mono small">{i.lot_no} / {i.serial_no}{i.expires_on && <div className="muted">ვადა {dateGe(i.expires_on)}</div>}</td>
            <td>{i.site ?? '—'}</td>
            <td className="mono small">{tsDate(i.implanted_at)}</td>
            <td>{i.case_id ? <Link to={caseLink(i.case_id)} className="mono small">{i.case_no}</Link> : '—'}</td>
          </tr>))}</tbody>
      </table>
    </section>
  );
}
