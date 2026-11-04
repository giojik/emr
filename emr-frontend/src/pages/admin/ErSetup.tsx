import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { ErrorBox, Field, Loading, Modal } from '../../components/ui';
import { useErMeta } from '../er/Er';
import { ARRIVAL_KIND_KA, type ArrivalMode, dur, onColor, SPOT_KA, type Spot, type SpotKind, type TriageLevel, type TriageScale } from '../er/types';

/** ადმინისტრირება → გადაუდებელი (ER), 0087: ადგილები, შემოსვლის გზები, ტრიაჟის შკალები (დონე / ფერი / სამიზნე დრო). პარამეტრები — „მოდულები“. */
export default function ErSetup() {
  const meta = useErMeta();
  const [tab, setTab] = useState<'spots' | 'arrival' | 'scales'>('spots');
  const [spot, setSpot] = useState<Spot | 'new' | null>(null);
  const [arr, setArr] = useState<ArrivalMode | 'new' | null>(null);
  const [scale, setScale] = useState<TriageScale | 'new' | null>(null);
  if (meta.isLoading) return <Loading />;
  const m = meta.data;
  return (
    <div className="content">
      <ErrorBox error={meta.error} />
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <div className="seg grow" role="tablist" aria-label="ER-ის ცნობარები" style={{ maxWidth: 'max-content' }}>
          <button type="button" aria-pressed={tab === 'spots'} onClick={() => setTab('spots')}>ადგილები</button>
          <button type="button" aria-pressed={tab === 'arrival'} onClick={() => setTab('arrival')}>შემოსვლის გზები</button>
          <button type="button" aria-pressed={tab === 'scales'} onClick={() => setTab('scales')}>ტრიაჟის შკალები</button>
        </div>
        <span className="small muted grow">პარამეტრები (ნაგულისხმევი შკალა, სამიზნე დრო ტრიაჟამდე, TV) — <Link to="/admin/modules">მოდულები → გადაუდებელი დახმარება</Link></span>
      </div>
      {m && !m.departments.length && <div className="alert warn">ER-ის განყოფილება არ არის — <Link to="/admin/departments">განყოფილებები</Link> → ტიპი „გადაუდებელი (ER)“.</div>}
      {m && tab === 'spots' && <div className="card">
        <div className="card-head"><h2 className="grow">ადგილები</h2><button className="btn primary sm" type="button" disabled={!m.departments.length} onClick={() => setSpot('new')}>+ ადგილი</button></div>
        <table className="table"><thead><tr><th>განყოფილება</th><th>კოდი</th><th>დასახელება</th><th>ტიპი</th><th className="num">რიგი</th><th>სტატუსი</th></tr></thead>
          <tbody>{m.spots.map((s) => <tr key={s.id} className="clickable" onClick={() => setSpot(s)} style={{ opacity: s.is_active ? 1 : 0.55 }}>
            <td>{s.department_name}</td><td className="mono">{s.code}</td><td><strong>{s.name}</strong></td><td>{SPOT_KA[s.kind]}</td><td className="num">{s.sort_order}</td>
            <td>{s.is_active ? <span className="chip ok">აქტიური</span> : <span className="chip">გათიშული</span>}</td></tr>)}
            {!m.spots.length && <tr><td colSpan={6}><div className="empty">ადგილი ჯერ არ არის.</div></td></tr>}</tbody></table></div>}
      {m && tab === 'arrival' && <div className="card">
        <div className="card-head"><h2 className="grow">შემოსვლის გზები</h2><button className="btn primary sm" type="button" onClick={() => setArr('new')}>+ დამატება</button></div>
        <table className="table"><thead><tr><th>კოდი</th><th>დასახელება</th><th>ტიპი (ველები)</th><th>სტატუსი</th></tr></thead>
          <tbody>{m.arrival_modes.map((a) => <tr key={a.code} className="clickable" onClick={() => setArr(a)} style={{ opacity: a.is_active ? 1 : 0.55 }}>
            <td className="mono">{a.code}</td><td>{a.name}</td><td>{ARRIVAL_KIND_KA[a.kind]}</td><td>{a.is_active ? <span className="chip ok">აქტიური</span> : <span className="chip">გათიშული</span>}</td></tr>)}</tbody></table></div>}
      {m && tab === 'scales' && <div className="stack">
        <div className="row"><span className="small muted grow">სამიზნე დროები — ნაგულისხმევი; კლინიკა ადასტურებს / ცვლის. დონე არ იშლება (მხოლოდ გათიშვა) — ისტორია რჩება.</span>
          <button className="btn primary sm" type="button" onClick={() => setScale('new')}>+ საკუთარი შკალა</button></div>
        {m.scales.map((s) => <section key={s.code} className="card">
          <div className="card-head"><h2 className="grow">{s.name} <span className="small mono muted">{s.code}</span>{m.settings.triage_scale === s.code && <span className="chip ok" style={{ marginLeft: 8 }}>მოქმედი</span>}
            {!s.is_active && <span className="chip" style={{ marginLeft: 8 }}>გათიშული</span>}</h2><button className="btn sm" type="button" onClick={() => setScale(s)}>რედაქტირება</button></div>
          <table className="table"><tbody>{s.levels.map((l) => <tr key={l.level} style={{ opacity: l.is_active ? 1 : 0.55 }}>
            <td style={{ width: 50 }}><span className="chip" style={{ background: l.color, color: onColor(l.color) }}>{l.level}</span></td><td><strong>{l.name}</strong>{l.description && <div className="small muted">{l.description}</div>}</td>
            <td className="small">ექიმამდე: {l.target_doctor_min === 0 ? 'მაშინვე' : dur(l.target_doctor_min)}</td><td className="small">განმ. ტრიაჟი: {l.retriage_min ? dur(l.retriage_min) : '—'}</td></tr>)}</tbody></table>
        </section>)}
      </div>}
      {spot && m && <SpotDialog s={spot === 'new' ? null : spot} deps={m.departments} onClose={() => setSpot(null)} />}
      {arr && <ArrivalDialog a={arr === 'new' ? null : arr} onClose={() => setArr(null)} />}
      {scale && <ScaleDialog s={scale === 'new' ? null : scale} onClose={() => setScale(null)} />}
    </div>
  );
}

function useSave(onClose: () => void, fn: () => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => { void qc.invalidateQueries({ queryKey: ['er-meta'] }); void qc.invalidateQueries({ queryKey: ['er-board'] }); onClose(); } });
}

function SpotDialog({ s, deps, onClose }: { s: Spot | null; deps: { id: string; name: string }[]; onClose: () => void }) {
  const [f, setF] = useState({ department_id: s?.department_id ?? deps[0]?.id ?? '', code: s?.code ?? '', name: s?.name ?? '', kind: (s?.kind ?? 'bed') as SpotKind, sort_order: String(s?.sort_order ?? 100), is_active: s?.is_active ?? true });
  const m = useSave(onClose, () => s ? api(`/er/admin/spots/${s.id}`, { method: 'PATCH', body: { code: f.code, name: f.name, kind: f.kind, sort_order: Number(f.sort_order), is_active: f.is_active } })
    : api('/er/admin/spots', { body: { department_id: f.department_id, code: f.code, name: f.name, kind: f.kind, sort_order: Number(f.sort_order) } }));
  return (
    <Modal title={s ? `ადგილი — ${s.name}` : 'ახალი ადგილი'} onClose={onClose} width={520}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={!f.code || !f.name.trim() || m.isPending} onClick={() => m.mutate()}>შენახვა</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        {!s && deps.length > 1 && <Field label="განყოფილება" htmlFor="sp-d"><select id="sp-d" className="select" value={f.department_id} onChange={(e) => setF({ ...f, department_id: e.target.value })}>{deps.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>}
        <div className="row" style={{ gap: 12 }}>
          <Field label="კოდი" htmlFor="sp-c" required><input id="sp-c" className="input mono" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.replace(/[^A-Za-z0-9_.-]/g, '') })} /></Field>
          <Field label="დასახელება" htmlFor="sp-n" required><input id="sp-n" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="მაგ. ტახტი 1" /></Field>
        </div>
        <div className="row" style={{ gap: 12 }}>
          <Field label="ტიპი" htmlFor="sp-k"><select id="sp-k" className="select" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as SpotKind })}>{Object.entries(SPOT_KA).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          <Field label="რიგი" htmlFor="sp-o"><input id="sp-o" className="input mono" type="number" value={f.sort_order} onChange={(e) => setF({ ...f, sort_order: e.target.value })} /></Field>
        </div>
        {s && <label className="row"><input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> აქტიური</label>}
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}

function ArrivalDialog({ a, onClose }: { a: ArrivalMode | null; onClose: () => void }) {
  const [f, setF] = useState({ code: a?.code ?? '', name: a?.name ?? '', kind: a?.kind ?? 'other', is_active: a?.is_active ?? true, sort_order: String(a?.sort_order ?? 100) });
  const m = useSave(onClose, () => a ? api(`/er/admin/arrival-modes/${a.code}`, { method: 'PATCH', body: { name: f.name, kind: f.kind, is_active: f.is_active, sort_order: Number(f.sort_order) } })
    : api('/er/admin/arrival-modes', { body: { code: f.code, name: f.name, kind: f.kind, sort_order: Number(f.sort_order) } }));
  return (
    <Modal title={a ? `შემოსვლის გზა — ${a.name}` : 'ახალი შემოსვლის გზა'} onClose={onClose} width={520}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={!f.code || f.name.trim().length < 2 || m.isPending} onClick={() => m.mutate()}>შენახვა</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <div className="row" style={{ gap: 12 }}>
          <Field label="კოდი" htmlFor="am-c" required><input id="am-c" className="input mono" disabled={!!a} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') })} /></Field>
          <Field label="დასახელება" htmlFor="am-n" required><input id="am-n" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        </div>
        <Field label="ტიპი" htmlFor="am-k" hint="განსაზღვრავს დამატებით ველებს (სასწრაფო — ბრიგადის №, გადმოყვანა — კლინიკა)"><select id="am-k" className="select" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as ArrivalMode['kind'] })}>
          {Object.entries(ARRIVAL_KIND_KA).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        {a && <label className="row"><input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> აქტიური</label>}
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}

function ScaleDialog({ s, onClose }: { s: TriageScale | null; onClose: () => void }) {
  const blank = (n: number): TriageLevel => ({ scale_code: '', level: n, name: '', color: '#888888', target_doctor_min: 30, retriage_min: null, description: null, is_active: true });
  const [f, setF] = useState({ code: s?.code ?? '', name: s?.name ?? '', description: s?.description ?? '', is_active: s?.is_active ?? true });
  const [levels, setLevels] = useState<TriageLevel[]>(s?.levels ?? [1, 2, 3, 4, 5].map(blank));
  const setL = (i: number, patch: Partial<TriageLevel>) => setLevels(levels.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const m = useSave(onClose, () => api(s ? `/er/admin/scales/${s.code}` : '/er/admin/scales', { method: s ? 'PATCH' : 'POST', body: {
    ...(s ? {} : { code: f.code }), name: f.name, description: f.description || null, ...(s && { is_active: f.is_active }),
    levels: levels.map((l) => ({ level: l.level, name: l.name, color: l.color, target_doctor_min: Number(l.target_doctor_min), retriage_min: l.retriage_min ? Number(l.retriage_min) : null, description: l.description || null, is_active: l.is_active })) } }));
  const ok = (s || /^[A-Z][A-Z0-9_]{1,19}$/.test(f.code)) && f.name.trim().length >= 2 && levels.every((l) => l.name.trim().length >= 2);
  return (
    <Modal title={s ? `შკალა — ${s.code}` : 'ახალი ტრიაჟის შკალა'} onClose={onClose} width={860}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={!ok || m.isPending} onClick={() => m.mutate()}>შენახვა</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <div className="row" style={{ gap: 12 }}>
          <Field label="კოდი" htmlFor="sc-c" required><input id="sc-c" className="input mono" disabled={!!s} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '') })} /></Field>
          <Field label="დასახელება" htmlFor="sc-n" required><input id="sc-n" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        </div>
        <Field label="აღწერა" htmlFor="sc-d"><input id="sc-d" className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <table className="table"><thead><tr><th>დონე</th><th>დასახელება</th><th>ფერი</th><th>ექიმამდე (წთ)</th><th>განმ. ტრიაჟი (წთ)</th><th>აქტ.</th></tr></thead>
          <tbody>{levels.map((l, i) => <tr key={l.level}>
            <td className="mono">{l.level}</td>
            <td><input aria-label={`დონე ${l.level} — დასახელება`} className="input" value={l.name} onChange={(e) => setL(i, { name: e.target.value })} /></td>
            <td><input aria-label={`დონე ${l.level} — ფერი`} type="color" value={l.color} onChange={(e) => setL(i, { color: e.target.value })} /></td>
            <td><input aria-label={`დონე ${l.level} — ექიმამდე`} className="input mono" type="number" min={0} max={1440} value={l.target_doctor_min} onChange={(e) => setL(i, { target_doctor_min: Number(e.target.value) })} /></td>
            <td><input aria-label={`დონე ${l.level} — განმეორებითი`} className="input mono" type="number" min={5} max={1440} value={l.retriage_min ?? ''} onChange={(e) => setL(i, { retriage_min: e.target.value ? Number(e.target.value) : null })} /></td>
            <td><input aria-label={`დონე ${l.level} — აქტიური`} type="checkbox" checked={l.is_active} onChange={(e) => setL(i, { is_active: e.target.checked })} /></td></tr>)}</tbody></table>
        {levels.length < 9 && !s?.is_system && <button className="btn sm" type="button" style={{ width: 'max-content' }} onClick={() => setLevels([...levels, blank(levels.length + 1)])}>+ დონე</button>}
        {s && <label className="row"><input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> შკალა აქტიურია</label>}
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}
