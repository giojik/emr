import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../../api/client';
import type { Diagnosis, EncounterDetail, IcdCode, Vitals } from '../../api/types';
import { ErrorBox, Field, Modal, StatusChip } from '../../components/ui';
import { hhmm, REFERRAL_KA } from '../../lib/format';
import IcdPicker from './IcdPicker';

const inval = (qc: ReturnType<typeof useQueryClient>, id: string) => void qc.invalidateQueries({ queryKey: ['encounter', id] });

// ------------------------------------------------------------------ ჩანაწერები (autosave)
const NOTE_TABS = [['chief_complaint', 'ჩივილები'], ['history_of_present_illness', 'ანამნეზი'], ['objective_status', 'ობიექტური სტატუსი']] as const;
type NoteKey = (typeof NOTE_TABS)[number][0];

export function Notes({ e, canWrite }: { e: EncounterDetail; canWrite: boolean }) {
  const [tab, setTab] = useState<NoteKey>('chief_complaint');
  const [vals, setVals] = useState<Record<NoteKey, string>>({ chief_complaint: e.chief_complaint ?? '', history_of_present_illness: e.history_of_present_illness ?? '', objective_status: e.objective_status ?? '' });
  const [state, setState] = useState<'saved' | 'dirty' | 'saving' | 'error'>('saved');
  const pending = useRef<Partial<Record<NoteKey, string>>>({});
  const timer = useRef<number | undefined>(undefined);
  const qc = useQueryClient();

  const flush = async () => {
    const body = pending.current; if (!Object.keys(body).length) return;
    pending.current = {}; setState('saving');
    try { await api(`/encounters/${e.id}`, { method: 'PATCH', body }); setState('saved'); qc.setQueryData(['encounter', e.id], (old: EncounterDetail | undefined) => old && { ...old, ...body }); }
    catch { pending.current = { ...body, ...pending.current }; setState('error'); }
  };
  useEffect(() => () => { window.clearTimeout(timer.current); void flush(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const change = (v: string) => {
    setVals({ ...vals, [tab]: v }); pending.current[tab] = v; setState('dirty');
    window.clearTimeout(timer.current); timer.current = window.setTimeout(() => void flush(), 800);
  };
  const label = { saved: 'შენახულია', dirty: 'ცვლილება…', saving: 'ინახება…', error: 'ვერ შეინახა — ხელახლა ცდა' }[state];

  return (
    <section className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: 240 }}>
      <div role="tablist" aria-label="კლინიკური ჩანაწერები" className="row" style={{ gap: 4, padding: '6px 10px 0', borderBottom: '1px solid var(--line)' }}>
        {NOTE_TABS.map(([k, l]) => (
          <button key={k} role="tab" type="button" aria-selected={tab === k} onClick={() => setTab(k)}
            style={{ font: 'inherit', fontSize: 14, fontWeight: tab === k ? 600 : 400, padding: '10px 14px', border: 0, background: 'transparent', color: tab === k ? 'var(--ink)' : 'var(--muted)', borderBottom: `2px solid ${tab === k ? 'var(--accent)' : 'transparent'}`, cursor: 'pointer' }}>
            {l}{vals[k] ? <span aria-label="შევსებულია" style={{ display: 'inline-block', width: 6, height: 6, borderRadius: 3, background: 'var(--ok-ink)', marginLeft: 6, verticalAlign: 'middle' }} /> : null}
          </button>
        ))}
        {canWrite && <button type="button" className="small" onClick={() => void flush()} style={{ marginLeft: 'auto', border: 0, background: 'none', cursor: state === 'error' ? 'pointer' : 'default', color: state === 'error' ? 'var(--danger)' : state === 'saved' ? 'var(--ok-ink)' : 'var(--muted)' }}>{label}</button>}
      </div>
      <label htmlFor="note" className="sr-only">{NOTE_TABS.find(([k]) => k === tab)?.[1]}</label>
      <textarea id="note" readOnly={!canWrite} value={vals[tab]} onChange={(x) => change(x.target.value)}
        style={{ flex: 1, minHeight: 180, border: 0, outline: 0, resize: 'vertical', padding: 16, font: 'inherit', fontSize: 15, lineHeight: 1.6, color: 'var(--ink)', background: canWrite ? 'var(--surface)' : 'var(--surface-2)' }} />
    </section>
  );
}

// ------------------------------------------------------------------ ვიტალები
export function VitalsStrip({ e, canAdd }: { e: EncounterDetail; canAdd: boolean }) {
  const [open, setOpen] = useState(false);
  const v: Vitals | undefined = e.vitals[e.vitals.length - 1];
  const high = v && ((v.systolic_bp ?? 0) >= 140 || (v.diastolic_bp ?? 0) >= 90);
  const cell = (k: string, val: string | number | null | undefined, warn?: boolean) => (
    <div style={{ padding: '10px 14px', borderRight: '1px solid var(--line-soft)', background: warn ? 'var(--warn-weak)' : undefined }}>
      <div className="small muted">{k}</div><div className="mono" style={{ fontSize: 18, fontWeight: 600, color: warn ? 'var(--warn-ink)' : undefined }}>{val ?? '—'}</div>
    </div>
  );
  return (
    <section className="card" style={{ display: 'flex', alignItems: 'stretch', overflow: 'hidden' }}>
      {cell('ა/წ', v?.systolic_bp ? `${v.systolic_bp}/${v.diastolic_bp ?? '—'}` : null, !!high)}
      {cell('პულსი', v?.heart_rate)}{cell('ტემპ.', v?.temperature ? `${v.temperature}°` : null)}{cell('SpO₂', v?.spo2 ? `${v.spo2}%` : null)}
      {cell('სუნთქვა', v?.respiratory_rate)}{cell('BMI', v?.bmi)}
      <div className="row" style={{ marginLeft: 'auto', padding: '0 14px' }}>
        {v && <span className="small muted">{hhmm(v.recorded_at)} · {e.vitals.length} გაზომვა</span>}
        {canAdd && <button className="btn sm" type="button" onClick={() => setOpen(true)}>+ ვიტალები</button>}
      </div>
      {open && <VitalsDialog encounterId={e.id} onClose={() => setOpen(false)} />}
    </section>
  );
}

function VitalsDialog({ encounterId, onClose }: { encounterId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState<Record<string, string>>({});
  const FIELDS: [string, string, string][] = [['systolic_bp', 'სისტოლური', 'mmHg'], ['diastolic_bp', 'დიასტოლური', 'mmHg'], ['heart_rate', 'პულსი', '/წთ'], ['respiratory_rate', 'სუნთქვის სიხშირე', '/წთ'], ['temperature', 'ტემპერატურა', '°C'], ['spo2', 'SpO₂', '%'], ['weight_kg', 'წონა', 'კგ'], ['height_cm', 'სიმაღლე', 'სმ']];
  const m = useMutation({
    mutationFn: () => api(`/encounters/${encounterId}/vitals`, { body: Object.fromEntries(Object.entries(f).filter(([, v]) => v.trim()).map(([k, v]) => [k, Number(v.replace(',', '.'))])) }),
    onSuccess: () => { inval(qc, encounterId); onClose(); },
  });
  return (
    <Modal title="სასიცოცხლო მაჩვენებლები" onClose={onClose} width={560}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="submit" form="vit" disabled={m.isPending || !Object.values(f).some((v) => v.trim())}>შენახვა</button></>}>
      <form id="vit" onSubmit={(x: FormEvent) => { x.preventDefault(); m.mutate(); }} style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
        {FIELDS.map(([k, l, u]) => (
          <Field key={k} label={`${l} (${u})`} htmlFor={k}><input id={k} className="input mono" inputMode="decimal" value={f[k] ?? ''} onChange={(x) => setF({ ...f, [k]: x.target.value })} /></Field>
        ))}
        <div style={{ gridColumn: '1 / -1' }}><ErrorBox error={m.error} /></div>
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------------ დიაგნოზები
const DX_KA: Record<Diagnosis['diagnosis_type'], string> = { primary: 'ძირითადი', secondary: 'თანმხლები', complication: 'გართულება', admission: 'შემოსვლისას' };
export function Diagnoses({ e, canWrite }: { e: EncounterDetail; canWrite: boolean }) {
  const qc = useQueryClient();
  const hasPrimary = e.diagnoses.some((d) => d.diagnosis_type === 'primary');
  const [type, setType] = useState<Diagnosis['diagnosis_type']>(hasPrimary ? 'secondary' : 'primary');
  useEffect(() => { setType(hasPrimary ? 'secondary' : 'primary'); }, [hasPrimary]);
  const add = useMutation({ mutationFn: (c: IcdCode) => api(`/encounters/${e.id}/diagnoses`, { body: { icd10_code: c.code, diagnosis_type: type } }), onSuccess: () => inval(qc, e.id) });
  const del = useMutation({ mutationFn: (id: string) => api(`/encounters/${e.id}/diagnoses/${id}`, { method: 'DELETE' }), onSuccess: () => inval(qc, e.id) });
  const sorted = [...e.diagnoses].sort((a, b) => (a.diagnosis_type === 'primary' ? -1 : b.diagnosis_type === 'primary' ? 1 : 0));
  return (
    <section className="card card-pad stack">
      <h2>დიაგნოზი (ICD-10)</h2>
      {sorted.map((d) => (
        <div key={d.id} className="row" style={{ padding: '8px 10px', borderRadius: 8, background: d.diagnosis_type === 'primary' ? 'var(--accent-weak)' : 'var(--surface-2)' }}>
          <span className={`chip${d.diagnosis_type === 'primary' ? ' accent' : ''}`}>{DX_KA[d.diagnosis_type]}</span>
          <span className="mono" style={{ fontWeight: 600 }}>{d.icd10_code}</span>
          <span className="grow" style={{ fontSize: 13 }}>{d.icd10_title}</span>
          {canWrite && <button className="icon-btn" type="button" aria-label={`წაშლა: ${d.icd10_code}`} onClick={() => del.mutate(d.id)}>×</button>}
        </div>
      ))}
      {!e.diagnoses.length && <span className="muted small">დიაგნოზი ჯერ არ არის.</span>}
      {canWrite && (
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <select aria-label="დიაგნოზის ტიპი" className="select" style={{ width: 140, flexShrink: 0 }} value={type} onChange={(x) => setType(x.target.value as Diagnosis['diagnosis_type'])}>
            {!hasPrimary && <option value="primary">ძირითადი</option>}
            <option value="secondary">თანმხლები</option><option value="complication">გართულება</option>
          </select>
          <IcdPicker primary={type === 'primary'} onPick={(c) => add.mutate(c)} disabled={add.isPending} />
        </div>
      )}
      <ErrorBox error={add.error ?? del.error} />
    </section>
  );
}

// ------------------------------------------------------------------ მიმართვები
export function Referrals({ e, canWrite }: { e: EncounterDetail; canWrite: boolean }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false); const [type, setType] = useState('lab'); const [reason, setReason] = useState('');
  const add = useMutation({ mutationFn: () => api(`/encounters/${e.id}/referrals`, { body: { type, reason } }), onSuccess: () => { setOpen(false); setReason(''); inval(qc, e.id); } });
  const cancel = useMutation({ mutationFn: (id: string) => api(`/referrals/${id}`, { method: 'PATCH', body: { status: 'cancelled' } }), onSuccess: () => inval(qc, e.id) });
  const shown = e.referrals.filter((r) => r.status !== 'cancelled');
  return (
    <section className="card card-pad stack">
      <div className="row"><h2 className="grow">მიმართვები</h2>{canWrite && !open && <button className="btn sm" type="button" onClick={() => setOpen(true)}>+ მიმართვა</button>}</div>
      {shown.map((r) => (
        <div key={r.id} className="stack" style={{ gap: 4, padding: '10px 12px', border: '1px solid var(--line-soft)', borderRadius: 8 }}>
          <div className="row"><strong className="grow" style={{ fontSize: 13 }}>{REFERRAL_KA[r.type]} · {r.reason}</strong><StatusChip status={r.status} /></div>
          {r.result_text && <div className="mono small" style={{ whiteSpace: 'pre-wrap' }}>{r.result_text}</div>}
          {canWrite && r.status === 'requested' && <button className="btn sm" type="button" style={{ alignSelf: 'flex-start' }} onClick={() => cancel.mutate(r.id)}>გაუქმება</button>}
        </div>
      ))}
      {!shown.length && !open && <span className="muted small">მიმართვა არ არის.</span>}
      {open && (
        <form className="stack" onSubmit={(x) => { x.preventDefault(); add.mutate(); }}>
          <select aria-label="ტიპი" className="select" value={type} onChange={(x) => setType(x.target.value)}>
            {Object.entries(REFERRAL_KA).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <input aria-label="მიზეზი / კვლევა" className="input" placeholder="მაგ. ლიპიდური პროფილი" value={reason} onChange={(x) => setReason(x.target.value)} required minLength={3} />
          <div className="row"><button className="btn sm" type="button" onClick={() => setOpen(false)}>გაუქმება</button><button className="btn sm primary" type="submit" disabled={add.isPending}>დამატება</button></div>
          <span className="hint">ფასი ავტომატურად დაემატება ინვოისს.</span>
        </form>
      )}
      <ErrorBox error={add.error ?? cancel.error} />
    </section>
  );
}
