import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../api/client';
import type { IcdCode } from '../../api/types';
import { ErrorBox, Field, Loading, Modal, useDebounced, useToast } from '../../components/ui';
import { hhmm, localISO, todayISO } from '../../lib/format';
import IcdPicker from '../encounter/IcdPicker';
import { invalOr, ReasonPrompt } from './Dialogs';
import { AIRWAY_KA, ANESTHESIA_KA, chip, COUNT_PHASE_KA, dt, FLUID_KA, LINE_KA, PACK_ST, SIDE_KA, type CaseDetail, type Procedure } from './types';

const num = (v: string) => (v.trim() === '' ? undefined : Number(v));
const n0 = (v: string | number | null | undefined) => (v === null || v === undefined || v === '' ? '' : String(Number(v)));

// ================================================================= ანესთეზიის რუკა
interface Vit { id: string; recorded_at: string; systolic_bp: number | null; diastolic_bp: number | null; map_mmhg: number | null; heart_rate: number | null; spo2: number | null; etco2: number | null;
  respiratory_rate: number | null; temperature: string | null; notes: string | null; voided_at: string | null; void_reason: string | null; by_name: string | null }
interface Anest {
  case_id: string; status: string; planned_anesthesia: string; meds_mode: 'direct' | 'orders' | 'both'; grid_min: number;
  record: null | { id: string; status: string; anesthesia_type: string; airway_device: string | null; ett_size: string | null; intubation_attempts: number | null; cormack_lehane: number | null;
    difficult_airway: boolean; airway_notes: string | null; technique_notes: string | null; position: string | null; complications: string | null; notes: string | null;
    created_by_name: string; signed_by_name: string | null; signed_at: string | null };
  vitals: Vit[];
  fluids: { id: string; direction: string; category: string; volume_ml: string; recorded_at: string; note: string | null; voided_at: string | null; void_reason: string | null; by_name: string }[];
  meds: { id: string; given_at: string; name: string; dose: string; dose_unit: string | null; route_code: string | null; route_name: string | null; qty_base: string; dose_wasted: string | null;
    controlled: boolean; note: string | null; doc_no: string | null; by_name: string; witness_name: string | null }[];
  mar: { id: string; documented_at: string; status: string; dose_given: string | null; dose_unit: string | null; route_code: string | null; name: string; by_name: string | null }[];
  window: { start: string | null; anesthesia_start: string | null; anesthesia_end: string | null; end: string | null };
  balance: { in: number; out: number; net: number; by_category: Record<string, number> };
  location: { id: string; name: string } | null;
  can: { edit: boolean; sign: boolean };
}
const VROWS: [keyof Vit, string, string][] = [['systolic_bp', 'სისტ. წნევა', 'mmHg'], ['diastolic_bp', 'დიასტ. წნევა', 'mmHg'], ['map_mmhg', 'MAP', 'mmHg'], ['heart_rate', 'პულსი', '/წთ'],
  ['spo2', 'SpO₂', '%'], ['etco2', 'EtCO₂', 'mmHg'], ['respiratory_rate', 'სუნთქვა', '/წთ'], ['temperature', 'ტემპ.', '°C']];

export function AnesthesiaTab({ c }: { c: CaseDetail }) {
  const q = useQuery({ queryKey: ['or-anest', c.id], queryFn: () => api<Anest>(`/or/cases/${c.id}/anesthesia`), refetchInterval: 30_000 });
  const [slot, setSlot] = useState<string | null>(null);
  const [med, setMed] = useState(false);
  const [voidV, setVoidV] = useState<Vit | null>(null);
  const a = q.data;
  if (q.isLoading) return <Loading />;
  if (!a) return <ErrorBox error={q.error} />;
  const signed = a.record?.status === 'signed';
  return (
    <div className="stack">
      {!a.window.start && <div className="alert info">ანესთეზიის რუკა იხსნება „საოპერაციოში შემოსვლის“ შემდეგ.</div>}
      {signed && <div className="alert ok">ხელმოწერილია · {a.record!.signed_by_name} · {dt(a.record!.signed_at)} — რუკა უცვლელია.</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(320px, 1fr) minmax(320px, 1.4fr)', gap: 14, alignItems: 'start' }}>
        <RecordForm a={a} key={a.record?.id ?? 'new'} />
        <section className="card">
          <div className="card-head"><h2 className="grow">სითხეები / ბალანსი</h2>
            <span className="chip info">მიღება {a.balance.in} მლ</span><span className="chip warn">გამოყოფა {a.balance.out} მლ</span>
            <span className={`chip ${a.balance.net >= 0 ? 'ok' : 'danger'}`}>{a.balance.net >= 0 ? '+' : ''}{a.balance.net} მლ</span></div>
          <FluidRows a={a} />
        </section>
      </div>
      <section className="card">
        <div className="card-head"><h2 className="grow">ვიტალები — {a.grid_min}-წუთიანი ბადე</h2>
          <span className="small muted">{a.window.anesthesia_start ? `ანესთეზია ${hhmm(a.window.anesthesia_start)}${a.window.anesthesia_end ? `–${hhmm(a.window.anesthesia_end)}` : ''}` : ''}</span></div>
        {a.window.start ? <VitalsGrid a={a} onSlot={(s) => setSlot(s)} onVoid={(v) => setVoidV(v)} /> : <div className="card-pad muted small">—</div>}
      </section>
      <section className="card">
        <div className="card-head"><h2 className="grow">მედიკამენტები</h2>
          <span className="small muted">{a.meds_mode === 'direct' ? 'ჟურნალი + ხარჯი ბლოკის საწყობიდან' : a.meds_mode === 'orders' ? 'დანიშნულებით (CPOE → MAR)' : 'ჟურნალი ან დანიშნულება'}</span>
          {a.can.edit && a.meds_mode !== 'orders' && <button className="btn sm primary" type="button" disabled={!a.location} onClick={() => setMed(true)}>+ მედიკამენტი</button>}</div>
        {a.meds_mode !== 'orders' && !a.location && <div className="alert warn" style={{ margin: 12 }}>ბლოკს საწყობის ლოკაცია არ აქვს — ადმინისტრირება → საოპერაციო → ბლოკი.</div>}
        <table className="table"><tbody>
          {a.meds.map((m) => (
            <tr key={m.id}><td className="mono" style={{ width: 70 }}>{hhmm(m.given_at)}</td>
              <td><strong>{m.name}</strong>{m.controlled && <span className="chip danger" style={{ marginLeft: 6 }}>კონტროლირებადი</span>}
                <div className="small muted">{m.doc_no ? `ხარჯი ${m.doc_no} · ` : ''}{Number(m.qty_base)} ერთ.{m.note ? ` · ${m.note}` : ''}</div></td>
              <td className="mono">{Number(m.dose)} {m.dose_unit ?? ''}{m.dose_wasted !== null && <div className="small muted">ნარჩენი {Number(m.dose_wasted)} {m.dose_unit ?? ''}</div>}</td>
              <td className="small">{m.route_name ?? m.route_code ?? ''}</td>
              <td className="small muted">{m.by_name}{m.witness_name && <div>მოწმე: {m.witness_name}</div>}</td></tr>))}
          {a.mar.map((m) => (
            <tr key={m.id}><td className="mono">{hhmm(m.documented_at)}</td><td>{m.name} <span className="chip info">MAR</span></td>
              <td className="mono">{m.dose_given ? Number(m.dose_given) : ''} {m.dose_unit ?? ''}</td><td className="small">{m.route_code ?? ''}</td><td className="small muted">{m.by_name ?? ''}</td></tr>))}
          {!a.meds.length && !a.mar.length && <tr><td className="muted small">—</td></tr>}
        </tbody></table>
        {a.meds_mode !== 'direct' && <div className="card-pad small muted">დანიშნულება — <Link to={`/inpatient/stay/${c.encounter_id}#orders`}>ჰოსპიტალიზაცია → დანიშნულებები</Link>; აქ ჩანს ოპერაციის დროს MAR-ში ჩაწერილი.</div>}
      </section>
      {slot && <VitalsDialog a={a} at={slot} onClose={() => setSlot(null)} />}
      {med && <MedDialog a={a} onClose={() => setMed(false)} />}
      {voidV && <ReasonPrompt title={`ვიტალები ${hhmm(voidV.recorded_at)} — გაუქმება`} label="მიზეზი" path={`/or/anesthesia/vitals/${voidV.id}/void`} danger onClose={() => setVoidV(null)} />}
    </div>
  );
}

function RecordForm({ a }: { a: Anest }) {
  const qc = useQueryClient(); const toast = useToast(); const r = a.record;
  const [f, setF] = useState({ anesthesia_type: r?.anesthesia_type ?? a.planned_anesthesia, airway_device: r?.airway_device ?? '', ett_size: n0(r?.ett_size), intubation_attempts: n0(r?.intubation_attempts),
    cormack_lehane: r?.cormack_lehane ?? null as number | null, difficult_airway: r?.difficult_airway ?? false, airway_notes: r?.airway_notes ?? '', technique_notes: r?.technique_notes ?? '',
    position: r?.position ?? '', complications: r?.complications ?? '', notes: r?.notes ?? '' });
  const ro = !a.can.edit;
  const upd = (k: keyof typeof f, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  const save = useMutation({
    mutationFn: async (sign: boolean) => {
      await api(`/or/cases/${a.case_id}/anesthesia`, { method: 'PUT', body: { ...f, airway_device: f.airway_device || null, ett_size: f.airway_device === 'ett' ? num(f.ett_size) ?? null : null,
        intubation_attempts: f.airway_device === 'ett' ? num(f.intubation_attempts) ?? null : null } });
      if (sign) await api(`/or/cases/${a.case_id}/anesthesia/sign`, { body: {} });
    },
    onSuccess: (_, sign) => { toast.show(sign ? 'ხელმოწერილია' : 'შენახულია'); invalOr(qc); },
  });
  const missing = save.error instanceof ApiError ? (save.error.body?.missing as string[] | undefined) : undefined;
  return (
    <section className="card">
      {toast.node}
      <div className="card-head"><h2 className="grow">ანესთეზია</h2>
        {r ? (r.status === 'signed' ? <span className="chip ok">ხელმოწერილი</span> : <span className="chip warn">შავი ვერსია</span>) : <span className="chip">არ არის</span>}</div>
      <div className="card-pad stack">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="ანესთეზიის ტიპი (ფაქტობრივი)" htmlFor="an-t"><select id="an-t" className="select" disabled={ro} value={f.anesthesia_type} onChange={(e) => upd('anesthesia_type', e.target.value)}>
            {Object.entries(ANESTHESIA_KA).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          <Field label="სასუნთქი გზები" htmlFor="an-a"><select id="an-a" className="select" disabled={ro} value={f.airway_device} onChange={(e) => upd('airway_device', e.target.value)}>
            <option value="">—</option>{Object.entries(AIRWAY_KA).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        </div>
        {f.airway_device === 'ett' && <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.4fr', gap: 12, alignItems: 'end' }}>
          <Field label="ETT ზომა" htmlFor="an-s"><input id="an-s" className="input mono" type="number" step="0.5" disabled={ro} value={f.ett_size} onChange={(e) => upd('ett_size', e.target.value)} /></Field>
          <Field label="მცდელობა" htmlFor="an-n"><input id="an-n" className="input mono" type="number" disabled={ro} value={f.intubation_attempts} onChange={(e) => upd('intubation_attempts', e.target.value)} /></Field>
          <div className="stack" style={{ gap: 4 }}><span className="label">Cormack-Lehane</span><div className="seg" role="group" aria-label="Cormack-Lehane">
            {[1, 2, 3, 4].map((n) => <button key={n} type="button" disabled={ro} aria-pressed={f.cormack_lehane === n} onClick={() => upd('cormack_lehane', n)}>{['I', 'II', 'III', 'IV'][n - 1]}</button>)}</div></div>
        </div>}
        <label className="row small"><input type="checkbox" disabled={ro} checked={f.difficult_airway} onChange={(e) => upd('difficult_airway', e.target.checked)} /> რთული სასუნთქი გზები</label>
        <Field label="ტექნიკა (რეგიონული / ნეიროაქსიალური: დონე, ნემსი, პრეპარატი)" htmlFor="an-tn"><textarea id="an-tn" className="textarea" rows={2} disabled={ro} value={f.technique_notes} onChange={(e) => upd('technique_notes', e.target.value)} /></Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="პოზიცია" htmlFor="an-p"><input id="an-p" className="input" disabled={ro} value={f.position} onChange={(e) => upd('position', e.target.value)} /></Field>
          <Field label="სასუნთქი გზების შენიშვნა" htmlFor="an-an"><input id="an-an" className="input" disabled={ro} value={f.airway_notes} onChange={(e) => upd('airway_notes', e.target.value)} /></Field>
        </div>
        <Field label="ანესთეზიური გართულებები" htmlFor="an-c"><input id="an-c" className="input" disabled={ro} value={f.complications} onChange={(e) => upd('complications', e.target.value)} /></Field>
        <Field label="შენიშვნა" htmlFor="an-no"><textarea id="an-no" className="textarea" rows={2} disabled={ro} value={f.notes} onChange={(e) => upd('notes', e.target.value)} /></Field>
        {!ro && <div className="row"><span className="grow" /><button className="btn" type="button" disabled={save.isPending} onClick={() => save.mutate(false)}>შენახვა</button>
          {a.can.sign && <button className="btn primary" type="button" disabled={save.isPending} onClick={() => save.mutate(true)}>ხელმოწერა</button>}</div>}
        {missing ? <div className="alert danger small"><div className="stack" style={{ gap: 2 }}><strong>ხელმოწერისთვის აკლია:</strong>{missing.map((m) => <span key={m}>• {m}</span>)}</div></div> : <ErrorBox error={save.error} />}
      </div>
    </section>
  );
}

function VitalsGrid({ a, onSlot, onVoid }: { a: Anest; onSlot: (iso: string) => void; onVoid: (v: Vit) => void }) {
  const g = a.grid_min * 60_000;
  const live = a.vitals.filter((v) => !v.voided_at);
  const slots = useMemo(() => {
    const start = Math.floor(new Date(a.window.start!).getTime() / g) * g;
    const endT = Math.min(Date.now(), a.window.end ? new Date(a.window.end).getTime() + 30 * 60_000 : Date.now());
    const xs: number[] = [];
    for (let t = start; t <= endT && xs.length < 288; t += g) xs.push(t);
    for (const v of live) { const t = new Date(v.recorded_at).getTime(); if (!xs.includes(t)) xs.push(t); }
    return xs.sort((x, y) => x - y);
  }, [a.window.start, a.window.end, g, live]);
  const byT = new Map(live.map((v) => [new Date(v.recorded_at).getTime(), v]));
  // ტრენდი: წნევა (ხაზები) + პულსი (წერტილები)
  const W = Math.max(slots.length * 46, 300); const H = 150; const yMax = 200;
  const x = (i: number) => 23 + i * 46; const y = (v: number) => H - 10 - (Math.min(v, yMax) / yMax) * (H - 20);
  const line = (k: 'systolic_bp' | 'diastolic_bp') => slots.map((t, i) => [i, byT.get(t)?.[k]] as const).filter(([, v]) => v != null).map(([i, v]) => `${x(i)},${y(v as number)}`).join(' ');
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg width={W + 140} height={H} role="img" aria-label="ვიტალების ტრენდი" style={{ display: 'block', marginLeft: 0 }}>
        <g transform="translate(140,0)">
          {[50, 100, 150].map((v) => <g key={v}><line x1={0} x2={W} y1={y(v)} y2={y(v)} stroke="var(--line-soft)" /><text x={-6} y={y(v) + 4} fontSize="10" textAnchor="end" fill="var(--muted)">{v}</text></g>)}
          <polyline points={line('systolic_bp')} fill="none" stroke="var(--danger)" strokeWidth={2} />
          <polyline points={line('diastolic_bp')} fill="none" stroke="var(--danger)" strokeWidth={1.5} strokeDasharray="4 3" />
          {slots.map((t, i) => { const v = byT.get(t); return v?.heart_rate != null ? <circle key={t} cx={x(i)} cy={y(v.heart_rate)} r={3.5} fill="var(--info-line)" /> : null; })}
        </g>
        <text x={8} y={16} fontSize="11" fill="var(--danger)">— წნევა (სისტ. / დიასტ.)</text>
        <text x={8} y={32} fontSize="11" fill="var(--info-ink)">● პულსი</text>
      </svg>
      <table className="table" style={{ width: 'max-content', minWidth: '100%' }}>
        <thead><tr><th style={{ position: 'sticky', left: 0, background: 'var(--surface)', minWidth: 130 }} />
          {slots.map((t) => { const v = byT.get(t); return (
            <th key={t} className="mono" style={{ minWidth: 46, textAlign: 'center', padding: '4px 2px' }}>
              {v ? (a.can.edit ? <button type="button" className="btn sm" style={{ height: 24, padding: '0 4px' }} title="გაუქმება" onClick={() => onVoid(v)}>{hhmm(new Date(t).toISOString())}</button>
                : hhmm(new Date(t).toISOString()))
                : a.can.edit ? <button type="button" className="btn sm" style={{ height: 24, padding: '0 4px' }} aria-label={`ვიტალები ${hhmm(new Date(t).toISOString())}`}
                  onClick={() => onSlot(new Date(t).toISOString())}>+{hhmm(new Date(t).toISOString()).slice(3)}</button> : <span className="muted">{hhmm(new Date(t).toISOString())}</span>}
            </th>); })}</tr></thead>
        <tbody>{VROWS.map(([k, l, u]) => (
          <tr key={k}><td style={{ position: 'sticky', left: 0, background: 'var(--surface)' }} className="small"><strong>{l}</strong> <span className="muted">{u}</span></td>
            {slots.map((t) => { const v = byT.get(t)?.[k]; return <td key={t} className="mono" style={{ textAlign: 'center', padding: '4px 2px' }}>{v === null || v === undefined ? '' : String(Number(v))}</td>; })}</tr>))}
        </tbody>
      </table>
      {a.vitals.some((v) => v.voided_at) && <div className="card-pad small muted">გაუქმებული: {a.vitals.filter((v) => v.voided_at).map((v) => `${hhmm(v.recorded_at)} (${v.void_reason})`).join('; ')}</div>}
    </div>
  );
}

function VitalsDialog({ a, at, onClose }: { a: Anest; at: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState<Record<string, string>>({});
  const m = useMutation({
    mutationFn: () => api(`/or/cases/${a.case_id}/anesthesia/vitals`, { body: { at, ...Object.fromEntries(Object.entries(f).filter(([, v]) => v.trim() !== '').map(([k, v]) => [k, k === 'notes' ? v : Number(v)])) } }),
    onSuccess: () => { invalOr(qc); onClose(); },
  });
  return (
    <Modal title={`ვიტალები — ${hhmm(at)}`} onClose={onClose} width={520}
      footer={<><button className="btn" type="button" onClick={onClose}>დახურვა</button><button className="btn primary" type="button" disabled={m.isPending} onClick={() => m.mutate()}>შენახვა</button></>}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
        {VROWS.map(([k, l, u]) => <Field key={k} label={`${l} (${u})`} htmlFor={`vd-${k}`}><input id={`vd-${k}`} className="input mono" type="number" step={k === 'temperature' ? '0.1' : '1'}
          value={f[k] ?? ''} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>)}
      </div>
      <Field label="შენიშვნა" htmlFor="vd-n"><input id="vd-n" className="input" value={f.notes ?? ''} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      <span className="hint">MAP — თუ ცარიელია, ითვლება წნევიდან.</span>
      <ErrorBox error={m.error} />
    </Modal>
  );
}

function FluidRows({ a }: { a: Anest }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ category: 'iv', volume_ml: '', time: hhmm(new Date().toISOString()), note: '' });
  const [vd, setVd] = useState<string | null>(null);
  const add = useMutation({ mutationFn: () => api(`/or/cases/${a.case_id}/anesthesia/fluids`, { body: { category: f.category, volume_ml: Number(f.volume_ml), at: localISO(todayISO(), f.time), note: f.note || undefined } }),
    onSuccess: () => { invalOr(qc); setF({ ...f, volume_ml: '', note: '' }); } });
  return (
    <>
      <table className="table"><tbody>
        {a.fluids.map((x) => (
          <tr key={x.id} style={x.voided_at ? { opacity: 0.5 } : undefined}>
            <td className="mono" style={{ width: 60 }}>{hhmm(x.recorded_at)}</td><td>{FLUID_KA[x.category] ?? x.category}{x.note && <div className="small muted">{x.note}</div>}</td>
            <td className="mono" style={{ textAlign: 'right' }}>{x.direction === 'in' ? '+' : '−'}{Number(x.volume_ml)} მლ</td>
            <td style={{ width: 40 }}>{x.voided_at ? <span className="small muted" title={x.void_reason ?? ''}>გაუქმ.</span>
              : a.can.edit && <button className="btn sm" type="button" aria-label="გაუქმება" onClick={() => setVd(x.id)}>×</button>}</td></tr>))}
        {!a.fluids.length && <tr><td className="muted small">—</td></tr>}
      </tbody></table>
      {a.can.edit && <div className="card-pad row" style={{ flexWrap: 'wrap', gap: 8, borderTop: '1px solid var(--line-soft)' }}>
        <select className="select" aria-label="კატეგორია" style={{ maxWidth: 230 }} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
          <optgroup label="მიღება">{['iv', 'blood', 'other_in'].map((k) => <option key={k} value={k}>{FLUID_KA[k]}</option>)}</optgroup>
          <optgroup label="გამოყოფა">{['blood_loss', 'urine', 'drain', 'other_out'].map((k) => <option key={k} value={k}>{FLUID_KA[k]}</option>)}</optgroup></select>
        <input className="input mono" aria-label="მოცულობა (მლ)" placeholder="მლ" type="number" style={{ width: 90 }} value={f.volume_ml} onChange={(e) => setF({ ...f, volume_ml: e.target.value })} />
        <input className="input" aria-label="დრო" type="time" style={{ width: 110 }} value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} />
        <input className="input grow" aria-label="შენიშვნა" placeholder="შენიშვნა (პრეპარატი…)" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
        <button className="btn sm primary" type="button" disabled={!(Number(f.volume_ml) > 0) || add.isPending} onClick={() => add.mutate()}>დამატება</button>
        <ErrorBox error={add.error} />
      </div>}
      {vd && <ReasonPrompt title="სითხის ჩანაწერის გაუქმება" label="მიზეზი" path={`/or/anesthesia/fluids/${vd}/void`} danger onClose={() => setVd(null)} />}
    </>
  );
}

interface StockRow { id: string; code: string; name: string; unit_name: string; kind: string; serial_tracked: boolean; controlled_class: string | null; dose_unit: string | null; dose_per_unit: string | null; qty: string }
function MedDialog({ a, onClose }: { a: Anest; onClose: () => void }) {
  const qc = useQueryClient();
  const [q, setQ] = useState(''); const dq = useDebounced(q.trim(), 250);
  const [it, setIt] = useState<StockRow | null>(null);
  const [f, setF] = useState({ dose: '', dose_unit: '', route_code: 'IV', qty_base: '1', dose_wasted: '', time: hhmm(new Date().toISOString()), w_user: '', w_pass: '', note: '' });
  const list = useQuery({ queryKey: ['or-anest-stock', a.case_id, dq], queryFn: () => api<StockRow[]>(`/or/cases/${a.case_id}/anesthesia/stock`, { query: { q: dq || undefined } }) });
  const ctl = !!it && ['narcotic', 'psychotropic'].includes(it.controlled_class ?? '');
  const m = useMutation({
    mutationFn: () => api(`/or/cases/${a.case_id}/anesthesia/meds`, { body: { item_id: it!.id, dose: Number(f.dose), dose_unit: f.dose_unit || it!.dose_unit || undefined, route_code: f.route_code || undefined,
      qty_base: Number(f.qty_base), given_at: localISO(todayISO(), f.time), ...(f.dose_wasted !== '' && { dose_wasted: Number(f.dose_wasted) }),
      ...(ctl && { witness: { username: f.w_user.trim(), password: f.w_pass } }), note: f.note || undefined } }),
    onSuccess: () => { invalOr(qc); onClose(); },
  });
  const total = it?.dose_per_unit ? Number(it.dose_per_unit) * Number(f.qty_base || 0) : null;
  return (
    <Modal title="ანესთეზია — მედიკამენტი" onClose={onClose} width={620}
      footer={<><button className="btn" type="button" onClick={onClose}>დახურვა</button>
        <button className="btn primary" type="button" disabled={!it || !(Number(f.dose) > 0) || !(Number(f.qty_base) > 0) || (ctl && (!f.w_user || !f.w_pass || f.dose_wasted === '')) || m.isPending}
          onClick={() => m.mutate()}>ჩაწერა და ჩამოწერა</button></>}>
      {!it ? <>
        <Field label={`მედიკამენტი (${a.location?.name ?? 'ბლოკის საწყობი'})`} htmlFor="md-q"><input id="md-q" className="input" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="დასახელება / კოდი" /></Field>
        <div className="stack" style={{ gap: 4, maxHeight: 300, overflow: 'auto' }}>{(list.data ?? []).map((s) => (
          <button key={s.id} type="button" className="btn" style={{ justifyContent: 'space-between', height: 'auto', padding: '6px 10px' }} onClick={() => { setIt(s); setF((x) => ({ ...x, dose_unit: s.dose_unit ?? '' })); }}>
            <span>{s.name}{['narcotic', 'psychotropic'].includes(s.controlled_class ?? '') && <span className="chip danger" style={{ marginLeft: 6 }}>კონტრ.</span>}</span>
            <span className="small muted">ნაშთი {Number(s.qty)} {s.unit_name}</span></button>))}
          {list.data && !list.data.length && <span className="small muted">ბლოკის საწყობში ვერ მოიძებნა</span>}</div>
      </> : <>
        <div className="row"><strong className="grow">{it.name}</strong>{ctl && <span className="chip danger">კონტროლირებადი — მოწმე + ნარჩენი</span>}<button className="btn sm" type="button" onClick={() => setIt(null)}>შეცვლა</button></div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
          <Field label="დოზა" htmlFor="md-d" required><input id="md-d" className="input mono" type="number" value={f.dose} onChange={(e) => setF({ ...f, dose: e.target.value })} /></Field>
          <Field label="ერთეული" htmlFor="md-u"><input id="md-u" className="input" value={f.dose_unit} onChange={(e) => setF({ ...f, dose_unit: e.target.value })} /></Field>
          <Field label="გზა" htmlFor="md-r"><select id="md-r" className="select" value={f.route_code} onChange={(e) => setF({ ...f, route_code: e.target.value })}>
            {['IV', 'IM', 'SC', 'INH', 'EPI', 'IT', 'PO', 'TOP'].map((r) => <option key={r} value={r}>{r}</option>)}</select></Field>
          <Field label="დრო" htmlFor="md-t"><input id="md-t" className="input" type="time" value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} /></Field>
          <Field label={`ჩამოსაწერი (${it.unit_name})`} htmlFor="md-q2" required><input id="md-q2" className="input mono" type="number" value={f.qty_base} onChange={(e) => setF({ ...f, qty_base: e.target.value })} /></Field>
          <Field label={`ნარჩენი${ctl ? ' *' : ''}`} htmlFor="md-w"><input id="md-w" className="input mono" type="number" value={f.dose_wasted} onChange={(e) => setF({ ...f, dose_wasted: e.target.value })} /></Field>
          <div className="stack" style={{ gridColumn: 'span 2', justifyContent: 'flex-end' }}>{total !== null && <span className="small muted">სულ ამპულა(ებ)ში: {total} {it.dose_unit ?? ''} = დოზა + ნარჩენი</span>}</div>
        </div>
        {ctl && <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label="მოწმე — მომხმარებელი" htmlFor="md-wu" required><input id="md-wu" className="input" autoComplete="off" value={f.w_user} onChange={(e) => setF({ ...f, w_user: e.target.value })} /></Field>
          <Field label="მოწმის პაროლი" htmlFor="md-wp" required><input id="md-wp" className="input" type="password" autoComplete="new-password" value={f.w_pass} onChange={(e) => setF({ ...f, w_pass: e.target.value })} /></Field>
        </div>}
        <Field label="შენიშვნა" htmlFor="md-n"><input id="md-n" className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
      </>}
      <ErrorBox error={m.error} />
    </Modal>
  );
}

// ================================================================= ოქმი
interface NoteRow { id: string; version: number; status: string; superseded_at: string | null; amend_reason: string | null; preop_icd10_code: string | null; preop_icd10_title: string | null;
  postop_icd10_code: string | null; postop_icd10_title: string | null; procedures: { procedure_id: string; code: string; name: string; ncsp_code: string | null; side: string; is_primary: boolean }[];
  description: string | null; findings: string | null; complications: string | null; complications_none: boolean; blood_loss_ml: number | null;
  drains: { kind: string; site: string | null; size: string | null; details: string | null; line_id: string | null }[]; specimens: { jar_no: number; site: string; pieces: number; description: string | null }[];
  path_lab: string | null; path_clinical_info: string | null; implants: { name: string; lot_no: string; serial_no: string; site: string | null }[]; author_name: string; signed_by_name: string | null;
  signed_at: string | null; created_at: string; template_id: string | null }
interface NoteView {
  case_id: string; status: string; locked_at: string | null; notes: NoteRow[]; draft: NoteRow | null; current: NoteRow | null; required: { key: string; label: string }[]; missing: string[];
  defaults: { preop_icd10_code: string | null; preop_icd10_title: string | null; procedures: NoteRow['procedures'] };
  implants: { id: string; name: string; manufacturer: string | null; lot_no: string; serial_no: string; site: string | null }[];
  pathology: null | { id: string; request_no: string; status: string; external_lab: string | null; result_text: string | null; specimens: NoteRow['specimens'] };
  lines: { id: string; kind: string; site: string | null; size: string | null; inserted_at: string; removed_at: string | null }[];
  templates: { id: string; name: string; procedure_id: string | null; procedure_name: string | null; owner_id: string | null; description: string | null; findings: string | null }[];
  can: { edit: boolean; sign: boolean; amend: boolean };
}

export function NoteTab({ c }: { c: CaseDetail }) {
  const q = useQuery({ queryKey: ['or-note', c.id], queryFn: () => api<NoteView>(`/or/cases/${c.id}/note`) });
  const [amend, setAmend] = useState(false);
  const [ver, setVer] = useState<string | null>(null);
  const n = q.data;
  if (q.isLoading) return <Loading />;
  if (!n) return <ErrorBox error={q.error} />;
  const started = ['in_progress', 'completed'].includes(n.status);
  const shown = ver ? n.notes.find((x) => x.id === ver) ?? null : null;
  return (
    <div className="stack">
      <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
        <span className="small muted">სავალდებულო ველები:</span>
        {n.required.map((r) => <span key={r.key} className={`chip ${n.missing.includes(r.label) ? 'warn' : 'ok'}`}>{n.missing.includes(r.label) ? '' : '✓ '}{r.label}</span>)}
        {!n.required.length && <span className="chip">—</span>}
        <span className="grow" />
        {n.can.amend && <button className="btn sm" type="button" onClick={() => setAmend(true)}>შესწორება (ახალი ვერსია)</button>}
      </div>
      {!started && <div className="alert info">ოქმი — ოპერაციის დაწყების შემდეგ.</div>}
      {n.draft && n.can.edit ? <NoteForm n={n} d={n.draft} canSign={c.can.note_sign} key={n.draft.id} /> : n.current ? <NoteView n={n} x={n.current} />
        : started && n.can.edit ? <NoteForm n={n} d={null} canSign={c.can.note_sign} key="new" />
        : <div className="card empty">ოქმი ჯერ არ არის.{!n.can.edit && ' (ავსებს ქირურგიული გუნდი)'}</div>}
      {n.draft && !n.can.edit && <div className="alert warn">შავი ვერსია (v{n.draft.version}) — ავტორი {n.draft.author_name}.</div>}
      {n.notes.length > 1 && <section className="card"><div className="card-head"><h2>ვერსიები</h2></div><table className="table"><tbody>
        {n.notes.map((x) => <tr key={x.id} className="clickable" onClick={() => setVer(ver === x.id ? null : x.id)}><td className="mono">v{x.version}</td>
          <td>{x.status === 'draft' ? <span className="chip warn">შავი</span> : x.superseded_at ? <span className="chip">ჩანაცვლებული</span> : <span className="chip ok">მოქმედი</span>}</td>
          <td className="small">{x.signed_by_name ? `${x.signed_by_name} · ${dt(x.signed_at)}` : `${x.author_name} · ${dt(x.created_at)}`}</td><td className="small muted">{x.amend_reason ?? ''}</td></tr>)}</tbody></table></section>}
      {shown && shown.id !== n.current?.id && <NoteView n={n} x={shown} />}
      {amend && <ReasonPrompt title="ოქმის შესწორება" label="მიზეზი (ახალი ვერსია; ხელმოწერამდე მოქმედია წინა)" path={`/or/cases/${c.id}/note/amend`} onClose={() => setAmend(false)} />}
    </div>
  );
}

function NoteView({ n, x }: { n: NoteView; x: NoteRow }) {
  const row = (l: string, v: ReactNode) => <div className="row" style={{ alignItems: 'flex-start' }}><span className="muted" style={{ width: 200, flexShrink: 0 }}>{l}</span><span className="grow" style={{ whiteSpace: 'pre-wrap' }}>{v}</span></div>;
  return (
    <section className="card">
      <div className="card-head"><h2 className="grow">ოპერაციის ოქმი · v{x.version}</h2>
        {x.status === 'signed' ? <span className="chip ok">ხელმოწერილი · {x.signed_by_name} · {dt(x.signed_at)}</span> : <span className="chip warn">შავი</span>}</div>
      <div className="card-pad stack">
        {row('წინასაოპერაციო დიაგნოზი', x.preop_icd10_code ? <><span className="mono">{x.preop_icd10_code}</span> {x.preop_icd10_title}</> : '—')}
        {row('პოსტოპერაციული დიაგნოზი', x.postop_icd10_code ? <><span className="mono">{x.postop_icd10_code}</span> {x.postop_icd10_title}</> : '—')}
        {row('პროცედურ(ებ)ი', x.procedures.map((p) => `${p.code} ${p.name}${p.side !== 'na' ? ` (${SIDE_KA[p.side]})` : ''}`).join('; ') || '—')}
        {row('აღწერა', x.description ?? '—')}
        {row('აღმოჩენები', x.findings ?? '—')}
        {row('გართულებები', x.complications_none ? 'არ ყოფილა' : x.complications ?? '—')}
        {row('სისხლის დაკარგვა', x.blood_loss_ml !== null ? `${x.blood_loss_ml} მლ` : '—')}
        {row('დრენაჟები', x.drains.length ? x.drains.map((d) => `${LINE_KA[d.kind] ?? d.kind}${d.site ? ` — ${d.site}` : ''}${d.size ? ` (${d.size})` : ''}`).join('; ') : '—')}
        {row('ბიოფსია', x.specimens.length ? <>{x.specimens.map((s) => `№${s.jar_no} ${s.site}`).join('; ')}{n.pathology && <span className="chip info" style={{ marginLeft: 6 }}>{n.pathology.request_no} · {n.pathology.status}</span>}</> : '—')}
        {row('იმპლანტები', (x.status === 'signed' ? x.implants : n.implants).map((i) => `${i.name} — ლოტი ${i.lot_no}, სერია ${i.serial_no}${i.site ? `, ${i.site}` : ''}`).join('; ') || '—')}
        {x.amend_reason && row('შესწორების მიზეზი', x.amend_reason)}
      </div>
    </section>
  );
}

function NoteForm({ n, d, canSign }: { n: NoteView; d: NoteRow | null; canSign: boolean }) {
  const qc = useQueryClient(); const toast = useToast();
  const [f, setF] = useState({
    preop: d?.preop_icd10_code ? { code: d.preop_icd10_code, title: d.preop_icd10_title ?? '' } : n.defaults.preop_icd10_code ? { code: n.defaults.preop_icd10_code, title: n.defaults.preop_icd10_title ?? '' } : null,
    postop: d?.postop_icd10_code ? { code: d.postop_icd10_code, title: d.postop_icd10_title ?? '' } : null,
    procedures: d?.procedures ?? n.defaults.procedures, description: d?.description ?? '', findings: d?.findings ?? '', complications: d?.complications ?? '', complications_none: d?.complications_none ?? false,
    blood_loss_ml: d?.blood_loss_ml !== null && d?.blood_loss_ml !== undefined ? String(d.blood_loss_ml) : '', drains: d?.drains ?? [], specimens: d?.specimens ?? [], path_lab: d?.path_lab ?? '',
    path_clinical_info: d?.path_clinical_info ?? '', template_id: d?.template_id ?? null as string | null,
  });
  const [dx, setDx] = useState<'pre' | 'post' | null>(null);
  const upd = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const body = () => ({ preop_icd10_code: f.preop?.code ?? null, postop_icd10_code: f.postop?.code ?? null, procedures: f.procedures.map((p) => ({ procedure_id: p.procedure_id, side: p.side, is_primary: p.is_primary })),
    description: f.description || null, findings: f.findings || null, complications: f.complications_none ? null : f.complications || null, complications_none: f.complications_none,
    blood_loss_ml: f.blood_loss_ml === '' ? null : Number(f.blood_loss_ml), drains: f.drains.map(({ kind, site, size, details, line_id }) => ({ kind, site: site || undefined, size: size || undefined,
      details: details || undefined, ...(line_id && { line_id }) })), specimens: f.specimens.map((s, i) => ({ jar_no: i + 1, site: s.site, pieces: s.pieces || 1, description: s.description || undefined })),
    path_lab: f.path_lab || null, path_clinical_info: f.path_clinical_info || null, template_id: f.template_id });
  const save = useMutation({
    mutationFn: async (sign: boolean) => { await api(`/or/cases/${n.case_id}/note`, { method: 'PUT', body: body() }); if (sign) await api(`/or/cases/${n.case_id}/note/sign`, { body: {} }); },
    onSuccess: (_, sign) => { toast.show(sign ? 'ოქმი ხელმოწერილია' : 'შენახულია'); invalOr(qc); },
  });
  const missing = save.error instanceof ApiError ? (save.error.body?.missing as string[] | undefined) : undefined;
  const tpl = (id: string) => { const t = n.templates.find((x) => x.id === id); if (!t) return;
    setF((x) => ({ ...x, template_id: t.id, description: t.description ?? x.description, findings: x.findings || t.findings || '' })); };
  return (
    <section className="card">
      {toast.node}
      <div className="card-head"><h2 className="grow">ოპერაციის ოქმი · v{d?.version ?? 1} <span className="chip warn">შავი</span></h2>
        {n.templates.length > 0 && <select className="select" aria-label="შაბლონი" style={{ maxWidth: 280, height: 34 }} value="" onChange={(e) => tpl(e.target.value)}>
          <option value="">შაბლონიდან…</option>{n.templates.map((t) => <option key={t.id} value={t.id}>{t.name}{t.owner_id ? ' (პირადი)' : ''}</option>)}</select>}</div>
      <div className="card-pad stack">
        {d?.amend_reason && <div className="alert info small">შესწორება: {d.amend_reason}</div>}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {(['pre', 'post'] as const).map((k) => { const v = k === 'pre' ? f.preop : f.postop; return (
            <div key={k} className="stack" style={{ gap: 4 }}><span className="label">{k === 'pre' ? 'წინასაოპერაციო დიაგნოზი' : 'პოსტოპერაციული დიაგნოზი'}</span>
              {dx === k ? <div className="row"><IcdPicker primary onPick={(x: IcdCode) => { upd(k === 'pre' ? 'preop' : 'postop', { code: x.code, title: x.title }); setDx(null); }} />
                <button className="btn sm" type="button" onClick={() => setDx(null)}>×</button></div>
                : <div className="row">{v ? <span className="grow"><span className="mono">{v.code}</span> {v.title}</span> : <span className="grow muted">—</span>}
                  <button className="btn sm" type="button" onClick={() => setDx(k)}>{v ? 'შეცვლა' : 'არჩევა'}</button>
                  {k === 'post' && !v && f.preop && <button className="btn sm" type="button" onClick={() => upd('postop', f.preop)}>= წინასაოპ.</button>}</div>}
            </div>); })}
        </div>
        <ProcEditor procs={f.procedures} set={(p) => upd('procedures', p)} />
        <Field label="ოპერაციის აღწერა" htmlFor="nt-d"><textarea id="nt-d" className="textarea" rows={7} value={f.description} onChange={(e) => upd('description', e.target.value)} /></Field>
        <Field label="აღმოჩენები" htmlFor="nt-f"><textarea id="nt-f" className="textarea" rows={3} value={f.findings} onChange={(e) => upd('findings', e.target.value)} /></Field>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12, alignItems: 'end' }}>
          <Field label="გართულებები" htmlFor="nt-c"><input id="nt-c" className="input" disabled={f.complications_none} value={f.complications_none ? '' : f.complications} onChange={(e) => upd('complications', e.target.value)} /></Field>
          <label className="row" style={{ height: 40 }}><input type="checkbox" checked={f.complications_none} onChange={(e) => upd('complications_none', e.target.checked)} /> გართულება არ ყოფილა</label>
        </div>
        <Field label="სისხლის დაკარგვა (მლ)" htmlFor="nt-b"><input id="nt-b" className="input mono" type="number" style={{ maxWidth: 160 }} value={f.blood_loss_ml} onChange={(e) => upd('blood_loss_ml', e.target.value)} /></Field>
        <div className="stack" style={{ gap: 6 }}><div className="row"><span className="label grow">დრენაჟები / კათეტერები (ხელმოწერისას → „ხაზები / დრენაჟები“)</span>
          <button className="btn sm" type="button" onClick={() => upd('drains', [...f.drains, { kind: 'drain', site: '', size: '', details: '', line_id: null }])}>+ დრენაჟი</button></div>
          {f.drains.map((dr, i) => (
            <div key={i} className="row" style={{ gap: 6 }}>
              <select className="select" aria-label="ტიპი" style={{ maxWidth: 200 }} disabled={!!dr.line_id} value={dr.kind} onChange={(e) => upd('drains', f.drains.map((x, j) => (j === i ? { ...x, kind: e.target.value } : x)))}>
                {Object.entries(LINE_KA).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
              <input className="input grow" aria-label="ადგილი" placeholder="ადგილი" disabled={!!dr.line_id} value={dr.site ?? ''} onChange={(e) => upd('drains', f.drains.map((x, j) => (j === i ? { ...x, site: e.target.value } : x)))} />
              <input className="input" aria-label="ზომა" placeholder="ზომა" style={{ width: 100 }} disabled={!!dr.line_id} value={dr.size ?? ''} onChange={(e) => upd('drains', f.drains.map((x, j) => (j === i ? { ...x, size: e.target.value } : x)))} />
              {dr.line_id ? <span className="chip ok">ჩადგმულია</span> : <button className="btn sm" type="button" aria-label="წაშლა" onClick={() => upd('drains', f.drains.filter((_, j) => j !== i))}>×</button>}
            </div>))}
        </div>
        <div className="stack" style={{ gap: 6 }}><div className="row"><span className="label grow">ბიოფსია / ნიმუშები (ხელმოწერისას → გარე პათოლოგიის მიმართვა)</span>
          {n.pathology && n.pathology.status !== 'draft' && <span className="chip info">{n.pathology.request_no} — გაგზავნილია (ქილები აღარ იცვლება)</span>}
          <button className="btn sm" type="button" onClick={() => upd('specimens', [...f.specimens, { jar_no: f.specimens.length + 1, site: '', pieces: 1, description: '' }])}>+ ქილა</button></div>
          {f.specimens.map((s, i) => (
            <div key={i} className="row" style={{ gap: 6 }}><span className="mono" style={{ width: 30 }}>№{i + 1}</span>
              <input className="input grow" aria-label="ლოკალიზაცია" placeholder="ლოკალიზაცია" value={s.site} onChange={(e) => upd('specimens', f.specimens.map((x, j) => (j === i ? { ...x, site: e.target.value } : x)))} />
              <input className="input mono" aria-label="ნაჭრები" type="number" style={{ width: 70 }} value={s.pieces} onChange={(e) => upd('specimens', f.specimens.map((x, j) => (j === i ? { ...x, pieces: Number(e.target.value) } : x)))} />
              <input className="input grow" aria-label="აღწერა" placeholder="აღწერა" value={s.description ?? ''} onChange={(e) => upd('specimens', f.specimens.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
              <button className="btn sm" type="button" aria-label="წაშლა" onClick={() => upd('specimens', f.specimens.filter((_, j) => j !== i))}>×</button></div>))}
          {f.specimens.length > 0 && <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 10 }}>
            <Field label="ლაბორატორია" htmlFor="nt-pl"><input id="nt-pl" className="input" value={f.path_lab} onChange={(e) => upd('path_lab', e.target.value)} /></Field>
            <Field label="კლინიკური ინფორმაცია" htmlFor="nt-pc" hint="ცარიელი — პოსტოპ. დიაგნოზი"><input id="nt-pc" className="input" value={f.path_clinical_info} onChange={(e) => upd('path_clinical_info', e.target.value)} /></Field></div>}
        </div>
        <div className="stack" style={{ gap: 4 }}><span className="label">იმპლანტები (რეესტრიდან, ავტომატურად)</span>
          <span>{n.implants.map((i) => `${i.name} — ლოტი ${i.lot_no}, სერია ${i.serial_no}${i.site ? `, ${i.site}` : ''}`).join('; ') || <span className="muted">— (მასალების ჩამოწერისას)</span>}</span></div>
        <div className="row"><span className="grow" />
          <button className="btn" type="button" disabled={save.isPending} onClick={() => save.mutate(false)}>შენახვა</button>
          {canSign && <button className="btn primary" type="button" disabled={save.isPending} onClick={() => save.mutate(true)}>ხელმოწერა</button>}</div>
        {missing ? <div className="alert danger small"><div className="stack" style={{ gap: 2 }}><strong>სავალდებულო ველები:</strong>{missing.map((m) => <span key={m}>• {m}</span>)}</div></div> : <ErrorBox error={save.error} />}
        <span className="hint">ხელმოწერის შემდეგ ოქმი უცვლელია (შესწორება — ახალი ვერსიით), ოპერაციის გუნდი და ნიშნულები იბლოკება.</span>
      </div>
    </section>
  );
}

function ProcEditor({ procs, set }: { procs: NoteRow['procedures']; set: (p: NoteRow['procedures']) => void }) {
  const [q, setQ] = useState(''); const dq = useDebounced(q.trim(), 250);
  const r = useQuery({ queryKey: ['or-procs', dq], queryFn: () => api<Procedure[]>('/or/procedures', { query: { q: dq } }), enabled: dq.length >= 2 });
  return (
    <div className="stack" style={{ gap: 6 }}><span className="label">ჩატარებული პროცედურ(ებ)ი</span>
      {procs.map((p, i) => (
        <div key={p.procedure_id} className="row" style={{ gap: 6 }}>
          <input type="radio" name="nt-prim" aria-label="ძირითადი" checked={p.is_primary} onChange={() => set(procs.map((x, j) => ({ ...x, is_primary: j === i })))} />
          <span className="grow"><span className="mono small">{p.code}</span> {p.name}</span>
          <select className="select" aria-label="მხარე" style={{ width: 130, height: 32 }} value={p.side} onChange={(e) => set(procs.map((x, j) => (j === i ? { ...x, side: e.target.value } : x)))}>
            {Object.entries(SIDE_KA).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          <button className="btn sm" type="button" aria-label="წაშლა" disabled={procs.length === 1} onClick={() => set(procs.filter((_, j) => j !== i))}>×</button></div>))}
      <div style={{ position: 'relative' }}><input className="input" aria-label="პროცედურის დამატება" placeholder="+ პროცედურა (ძებნა)" value={q} onChange={(e) => setQ(e.target.value)} />
        {dq.length >= 2 && (r.data ?? []).length > 0 && <div className="card" style={{ position: 'absolute', zIndex: 5, left: 0, right: 0, maxHeight: 220, overflow: 'auto' }}>
          {r.data!.filter((p) => !procs.some((x) => x.procedure_id === p.id)).map((p) => <button key={p.id} type="button" className="btn" style={{ display: 'block', width: '100%', textAlign: 'left', border: 0, height: 'auto', padding: '6px 10px' }}
            onClick={() => { set([...procs, { procedure_id: p.id, code: p.code, name: p.name, ncsp_code: p.ncsp_code, side: p.laterality ? 'right' : 'na', is_primary: !procs.length }]); setQ(''); }}>
            <span className="mono small">{p.code}</span> {p.name}</button>)}</div>}</div>
    </div>
  );
}

// ================================================================= მასალები / დათვლა / CSSD
interface Mat {
  case_id: string; status: string; location: { id: string; name: string } | null; count_mode: 'off' | 'warn' | 'block'; count_kinds: Record<string, string>; cssd: boolean;
  items: { id: string; item_id: string; name: string; code: string; unit_name: string; serial_tracked: boolean; qty: string; lot_id: string | null; lot_no: string | null; serial_no: string | null;
    expires_on: string | null; source: string; is_implant: boolean; implant_site: string | null; note: string | null; posted_at: string | null; doc_no: string | null; added_by_name: string | null }[];
  counts: { id: string; phase: string; lines: { kind: string; label: string; expected: number; counted: number }[]; correct: boolean; explanation: string | null; xray: boolean; done_at: string; by_name: string; second_name: string | null }[];
  count_state: Record<string, { done: boolean; correct: boolean; resolved: boolean }>;
  packs: { id: string; pack_no: string; status: string; expires_on: string | null; template_name: string; barcode: string; added_at: string; removed_at: string | null; remove_reason: string | null; used_at: string | null; added_by_name: string | null }[];
  implants: { id: string; name: string; lot_no: string; serial_no: string; site: string | null; implanted_at: string }[];
  card: { mode: string; items: { item_id: string; qty: number; name: string }[]; assembled: boolean };
  can: { edit: boolean; post: boolean; count: boolean };
}

export function MaterialsTab({ c }: { c: CaseDetail }) {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['or-mat', c.id], queryFn: () => api<Mat>(`/or/cases/${c.id}/materials`), refetchInterval: 30_000 });
  const [scan, setScan] = useState(''); const [site, setSite] = useState('');
  const [add, setAdd] = useState(false); const [cnt, setCnt] = useState<string | null>(null); const [pack, setPack] = useState('');
  const [rmPack, setRmPack] = useState<string | null>(null);
  const done = () => invalOr(qc);
  const sc = useMutation({ mutationFn: () => api(`/or/cases/${c.id}/items/scan`, { body: { code: scan.trim(), implant_site: site.trim() || undefined } }), onSuccess: () => { setScan(''); done(); } });
  const asm = useMutation({ mutationFn: () => api(`/or/cases/${c.id}/items/assemble`, { body: {} }), onSuccess: done });
  const post = useMutation({ mutationFn: () => api<{ doc_no: string; warnings: string[] }>(`/or/cases/${c.id}/items/post`, { body: {} }),
    onSuccess: (r) => { toast.show(`ჩამოიწერა: ${r.doc_no}${r.warnings.length ? ` · ${r.warnings.join('; ')}` : ''}`); done(); } });
  const patch = useMutation({ mutationFn: (a: { id: string; body: Record<string, unknown> }) => api(`/or/items/${a.id}`, { method: 'PATCH', body: a.body }), onSuccess: done });
  const rm = useMutation({ mutationFn: (id: string) => api(`/or/items/${id}/remove`, { body: {} }), onSuccess: done });
  const pk = useMutation({ mutationFn: () => api(`/or/cases/${c.id}/packs`, { body: { code: pack.trim() } }), onSuccess: () => { setPack(''); done(); } });
  const m = q.data;
  if (q.isLoading) return <Loading />;
  if (!m) return <ErrorBox error={q.error} />;
  const open = m.items.filter((i) => !i.posted_at); const posted = m.items.filter((i) => i.posted_at);
  const itemRow = (i: Mat['items'][number], editable: boolean) => (
    <tr key={i.id}>
      <td><strong>{i.name}</strong>{i.is_implant && <span className="chip accent" style={{ marginLeft: 6 }}>იმპლანტი</span>}{i.source === 'card' && <span className="chip" style={{ marginLeft: 6 }}>ბარათი</span>}
        <div className="small muted">{i.lot_no ? `ლოტი ${i.lot_no}` : i.is_implant || i.serial_tracked ? <span style={{ color: 'var(--danger)' }}>ლოტი / სერია — სკანირებით</span> : 'FEFO'}{i.serial_no ? ` · სერია ${i.serial_no}` : ''}
          {i.implant_site ? ` · ${i.implant_site}` : ''}{i.doc_no ? ` · ${i.doc_no}` : ''}</div></td>
      <td style={{ width: 150 }}>{editable && !i.serial_tracked ? <input className="input mono" type="number" aria-label={`რაოდენობა — ${i.name}`} defaultValue={Number(i.qty)} style={{ width: 90, height: 32 }}
        onBlur={(e) => { const v = Number(e.target.value); if (v > 0 && v !== Number(i.qty)) patch.mutate({ id: i.id, body: { qty: v } }); }} /> : <span className="mono">{Number(i.qty)}</span>} <span className="small muted">{i.unit_name}</span></td>
      <td style={{ width: 50 }}>{editable && <button className="btn sm" type="button" aria-label="წაშლა" onClick={() => rm.mutate(i.id)}>×</button>}</td>
    </tr>);
  return (
    <div className="stack">
      {toast.node}
      {!m.location && <div className="alert warn">ბლოკს საწყობის ლოკაცია არ აქვს — ჩამოწერა შეუძლებელია (ადმინისტრირება → საოპერაციო → ბლოკი).</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(380px, 1.5fr) minmax(320px, 1fr)', gap: 14, alignItems: 'start' }}>
        <section className="card">
          <div className="card-head"><h2 className="grow">მასალები / იმპლანტები</h2>
            {m.card.mode !== 'off' && m.card.items.length > 0 && !m.card.assembled && m.can.edit && <button className="btn sm" type="button" disabled={asm.isPending} onClick={() => asm.mutate()}>preference card → შეკრება ({m.card.items.length})</button>}
            {m.can.edit && <button className="btn sm" type="button" onClick={() => setAdd(true)}>+ ძებნით</button>}</div>
          {m.can.edit && <div className="card-pad row" style={{ gap: 8, borderBottom: '1px solid var(--line-soft)' }}>
            <input className="input grow" aria-label="სკანირება" placeholder="სკანირება: შტრიხკოდი / GS1 / იმპლანტის სერია" value={scan} onChange={(e) => setScan(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && scan.trim()) sc.mutate(); }} />
            <input className="input" aria-label="იმპლანტის ადგილი" placeholder="ადგილი (იმპლანტი)" style={{ width: 170 }} value={site} onChange={(e) => setSite(e.target.value)} />
            <button className="btn sm primary" type="button" disabled={!scan.trim() || sc.isPending} onClick={() => sc.mutate()}>დამატება</button></div>}
          <ErrorBox error={sc.error ?? asm.error ?? patch.error ?? rm.error} />
          <table className="table"><tbody>{open.map((i) => itemRow(i, m.can.edit))}
            {!open.length && <tr><td className="muted small">{m.card.items.length && !m.card.assembled ? `preference card — ${m.card.items.length} პოზიცია (შეიკრიბება დასრულებისას ან ღილაკით)` : 'დასადასტურებელი მასალა არ არის'}</td></tr>}</tbody></table>
          {m.can.post && open.length > 0 && <div className="card-pad row"><span className="small muted grow">ექთანი ადასტურებს → ჩამოწერა ბლოკის საწყობიდან (FEFO) + ინვოისი; იმპლანტი → რეესტრი</span>
            <button className="btn primary" type="button" disabled={post.isPending || !m.location} onClick={() => post.mutate()}>დადასტურება და ჩამოწერა ({open.length})</button></div>}
          <ErrorBox error={post.error} />
          {posted.length > 0 && <><div className="card-pad small muted" style={{ borderTop: '1px solid var(--line-soft)' }}>ჩამოწერილი</div><table className="table"><tbody>{posted.map((i) => itemRow(i, false))}</tbody></table></>}
        </section>
        <div className="stack">
          <section className="card">
            <div className="card-head"><h2 className="grow">დათვლა</h2><span className="small muted">{m.count_mode === 'block' ? 'სავალდებულო (ბლოკი)' : m.count_mode === 'warn' ? 'გაფრთხილება (ახსნით)' : 'გამორთული'}</span></div>
            <table className="table"><tbody>{(['initial', 'pre_closure', 'final'] as const).map((ph) => { const st = m.count_state[ph]; const last = [...m.counts].reverse().find((k) => k.phase === ph); return (
              <tr key={ph}><td><strong>{COUNT_PHASE_KA[ph]}</strong>{last && <div className="small muted">{last.by_name}{last.second_name ? ` + ${last.second_name}` : ''} · {hhmm(last.done_at)}{last.explanation ? ` · ${last.explanation}` : ''}{last.xray ? ' · რენტგენი' : ''}</div>}</td>
                <td>{!st?.done ? <span className="chip">—</span> : st.correct ? <span className="chip ok">სწორია</span> : st.resolved ? <span className="chip warn">შეუსაბამობა · რენტგენი</span> : <span className="chip danger">შეუსაბამობა</span>}</td>
                <td>{m.can.count && <button className="btn sm" type="button" onClick={() => setCnt(ph)}>{st?.done ? 'ხელახლა' : 'დათვლა'}</button>}</td></tr>); })}</tbody></table>
          </section>
          <section className="card">
            <div className="card-head"><h2 className="grow">CSSD ნაკრები</h2></div>
            {m.cssd && m.can.edit && ['scheduled', 'in_progress'].includes(m.status) && <div className="card-pad row" style={{ gap: 8 }}>
              <input className="input grow" aria-label="შეფუთვის ნომერი" placeholder="შეფუთვის № / ნაკრების კოდი" value={pack} onChange={(e) => setPack(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && pack.trim()) pk.mutate(); }} />
              <button className="btn sm primary" type="button" disabled={!pack.trim() || pk.isPending} onClick={() => pk.mutate()}>დამატება</button></div>}
            {pk.error instanceof ApiError && pk.error.code === 'PACK_NOT_STERILE' ? <div className="alert danger" style={{ margin: 12 }}>⛔ {pk.error.message}</div> : <ErrorBox error={pk.error} />}
            <table className="table"><tbody>{m.packs.map((p) => (
              <tr key={p.id} style={p.removed_at ? { opacity: 0.5 } : undefined}><td><span className="mono">{p.pack_no}</span><div className="small muted">{p.template_name} · {p.barcode}</div></td>
                <td>{p.removed_at ? <span className="small muted">მოიხსნა: {p.remove_reason}</span> : chip(PACK_ST, p.status)}</td>
                <td>{!p.removed_at && !p.used_at && m.can.edit && <button className="btn sm" type="button" onClick={() => setRmPack(p.id)}>მოხსნა</button>}</td></tr>))}
              {!m.packs.length && <tr><td className="muted small">{m.cssd ? 'ნაკრები არ არის დამატებული' : 'მოდული CSSD გამორთულია'}</td></tr>}</tbody></table>
            <div className="card-pad small muted">არასტერილური / ვადაგასული შეფუთვა — ბლოკი. დასრულებისას → „გამოყენებული“ პაციენტზე.</div>
          </section>
          {m.implants.length > 0 && <section className="card"><div className="card-head"><h2>იმპლანტების რეესტრი</h2></div><table className="table"><tbody>
            {m.implants.map((i) => <tr key={i.id}><td><strong>{i.name}</strong><div className="small muted">ლოტი {i.lot_no} · სერია {i.serial_no}{i.site ? ` · ${i.site}` : ''}</div></td><td className="small">{dt(i.implanted_at)}</td></tr>)}</tbody></table></section>}
        </div>
      </div>
      {add && <ItemDialog m={m} onClose={() => setAdd(false)} />}
      {cnt && <CountDialog m={m} phase={cnt} onClose={() => setCnt(null)} />}
      {rmPack && <ReasonPrompt title="ნაკრების მოხსნა" label="მიზეზი" path={`/or/packs/${rmPack}/remove`} onClose={() => setRmPack(null)} />}
    </div>
  );
}

function ItemDialog({ m, onClose }: { m: Mat; onClose: () => void }) {
  const qc = useQueryClient();
  const [q, setQ] = useState(''); const dq = useDebounced(q.trim(), 250);
  const [it, setIt] = useState<StockRow | null>(null); const [qty, setQty] = useState('1'); const [lot, setLot] = useState(''); const [site, setSite] = useState('');
  const list = useQuery({ queryKey: ['or-mat-stock', m.case_id, dq], queryFn: () => api<StockRow[]>(`/or/cases/${m.case_id}/materials/stock`, { query: { q: dq || undefined } }) });
  const lots = useQuery({ queryKey: ['or-mat-lots', m.case_id, it?.id], queryFn: () => api<{ lot_id: string; lot_no: string | null; serial_no: string | null; expires_on: string | null; qty: string }[]>(
    `/or/cases/${m.case_id}/materials/lots`, { query: { item_id: it!.id } }), enabled: !!it });
  const mut = useMutation({ mutationFn: () => api(`/or/cases/${m.case_id}/items`, { body: { item_id: it!.id, qty: Number(qty), lot_id: lot || undefined, implant_site: site || undefined } }),
    onSuccess: () => { invalOr(qc); onClose(); } });
  const needLot = !!it && (it.serial_tracked || it.kind === 'implant');
  return (
    <Modal title="მასალის დამატება" onClose={onClose} width={600}
      footer={<><button className="btn" type="button" onClick={onClose}>დახურვა</button><button className="btn primary" type="button" disabled={!it || !(Number(qty) > 0) || (needLot && !lot) || mut.isPending} onClick={() => mut.mutate()}>დამატება</button></>}>
      {!it ? <>
        <Field label={`საქონელი (${m.location?.name ?? 'ბლოკის საწყობი'})`} htmlFor="it-q"><input id="it-q" className="input" autoFocus value={q} onChange={(e) => setQ(e.target.value)} /></Field>
        <div className="stack" style={{ gap: 4, maxHeight: 300, overflow: 'auto' }}>{(list.data ?? []).map((s) => (
          <button key={s.id} type="button" className="btn" style={{ justifyContent: 'space-between', height: 'auto', padding: '6px 10px' }} onClick={() => { setIt(s); setQty('1'); }}>
            <span>{s.name}{s.kind === 'implant' && <span className="chip accent" style={{ marginLeft: 6 }}>იმპლანტი</span>}</span><span className="small muted">{Number(s.qty)} {s.unit_name}</span></button>))}</div>
      </> : <>
        <div className="row"><strong className="grow">{it.name}</strong><button className="btn sm" type="button" onClick={() => { setIt(null); setLot(''); }}>შეცვლა</button></div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 10 }}>
          <Field label={`რაოდენობა (${it.unit_name})`} htmlFor="it-n"><input id="it-n" className="input mono" type="number" disabled={it.serial_tracked} value={it.serial_tracked ? '1' : qty} onChange={(e) => setQty(e.target.value)} /></Field>
          <Field label={needLot ? 'ლოტი / სერია *' : 'ლოტი (ცარიელი — FEFO)'} htmlFor="it-l"><select id="it-l" className="select" value={lot} onChange={(e) => setLot(e.target.value)}>
            <option value="">{needLot ? '—' : 'FEFO (ავტომატურად)'}</option>{(lots.data ?? []).map((l) => <option key={l.lot_id} value={l.lot_id}>{l.lot_no ?? '—'}{l.serial_no ? ` · ${l.serial_no}` : ''}{l.expires_on ? ` · ${l.expires_on}` : ''} ({Number(l.qty)})</option>)}</select></Field>
        </div>
        {it.kind === 'implant' && <Field label="იმპლანტის ადგილი" htmlFor="it-s"><input id="it-s" className="input" value={site} onChange={(e) => setSite(e.target.value)} /></Field>}
      </>}
      <ErrorBox error={mut.error} />
    </Modal>
  );
}

function CountDialog({ m, phase, onClose }: { m: Mat; phase: string; onClose: () => void }) {
  const qc = useQueryClient();
  const base = [...m.counts].reverse().find((k) => k.phase === 'initial');
  const [lines, setLines] = useState(base ? base.lines.map((l) => ({ kind: l.kind, label: l.label, expected: String(l.expected), counted: '' }))
    : [{ kind: 'sponges', label: m.count_kinds.sponges, expected: '', counted: '' }, { kind: 'needles', label: m.count_kinds.needles, expected: '', counted: '' }, { kind: 'instruments', label: m.count_kinds.instruments, expected: '', counted: '' }]);
  const [expl, setExpl] = useState(''); const [xray, setXray] = useState(false); const [second, setSecond] = useState('');
  const staff = useQuery({ queryKey: ['or-staff', 'or_nurse'], queryFn: () => api<{ id: string; name: string }[]>('/or/staff', { query: { cap: 'nurse' } }) });
  const initial = phase === 'initial';
  const ready = lines.every((l) => l.counted !== '' && (initial || l.expected !== ''));
  const diff = !initial && lines.some((l) => l.counted !== '' && l.expected !== '' && Number(l.counted) !== Number(l.expected));
  const mut = useMutation({ mutationFn: () => api(`/or/cases/${m.case_id}/counts`, { body: { phase, lines: lines.map((l) => ({ kind: l.kind, label: l.label, expected: Number(initial ? l.counted : l.expected), counted: Number(l.counted) })),
    explanation: expl.trim() || undefined, xray, second_by: second || undefined } }), onSuccess: () => { invalOr(qc); onClose(); } });
  return (
    <Modal title={`დათვლა — ${COUNT_PHASE_KA[phase]}`} onClose={onClose} width={560}
      footer={<><button className="btn" type="button" onClick={onClose}>დახურვა</button><button className={`btn ${diff ? 'danger' : 'primary'}`} type="button" disabled={!ready || (diff && expl.trim().length < 3) || mut.isPending} onClick={() => mut.mutate()}>შენახვა</button></>}>
      <table className="table"><thead><tr><th>პოზიცია</th>{!initial && <th>უნდა იყოს</th>}<th>დათვლილი</th></tr></thead><tbody>
        {lines.map((l, i) => <tr key={i}><td>{initial ? <select className="select" aria-label="პოზიცია" style={{ height: 32 }} value={l.kind} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, kind: e.target.value, label: m.count_kinds[e.target.value] } : x)))}>
          {Object.entries(m.count_kinds).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select> : l.label}</td>
          {!initial && <td><input className="input mono" type="number" aria-label={`უნდა იყოს — ${l.label}`} style={{ width: 90, height: 32 }} value={l.expected} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, expected: e.target.value } : x)))} /></td>}
          <td><input className="input mono" type="number" aria-label={`დათვლილი — ${l.label}`} style={{ width: 90, height: 32, ...(diff && l.expected !== '' && l.counted !== '' && Number(l.counted) !== Number(l.expected) ? { borderColor: 'var(--danger)' } : {}) }}
            value={l.counted} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, counted: e.target.value } : x)))} /></td></tr>)}</tbody></table>
      {initial && <button className="btn sm" type="button" onClick={() => setLines([...lines, { kind: 'other', label: m.count_kinds.other, expected: '', counted: '' }])}>+ პოზიცია</button>}
      <Field label="მეორე დამთვლელი" htmlFor="cn-s"><select id="cn-s" className="select" value={second} onChange={(e) => setSecond(e.target.value)}><option value="">—</option>
        {(staff.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
      {diff && <>
        <div className="alert danger small">შეუსაბამობა — საჭიროა ახსნა; {m.count_mode === 'block' ? 'გაგრძელება — ხელახლა დათვლით (სწორი) ან რენტგენით' : 'გაგრძელება — ახსნით'}.</div>
        <Field label="ახსნა" htmlFor="cn-e" required><textarea id="cn-e" className="textarea" rows={2} value={expl} onChange={(e) => setExpl(e.target.value)} /></Field>
        <label className="row"><input type="checkbox" checked={xray} onChange={(e) => setXray(e.target.checked)} /> რენტგენით შემოწმდა (უცხო სხეული გამოირიცხა)</label></>}
      <ErrorBox error={mut.error} />
    </Modal>
  );
}
