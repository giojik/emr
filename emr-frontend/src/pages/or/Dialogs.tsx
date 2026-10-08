import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError } from '../../api/client';
import type { IcdCode, PatientListItem } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import PatientSearch from '../../components/PatientSearch';
import { ErrorBox, Field, Modal, useDebounced } from '../../components/ui';
import { dateGe, hhmm, localISO, todayISO } from '../../lib/format';
import IcdPicker from '../encounter/IcdPicker';
import { ANESTHESIA_KA, CASE_ST, chip, hm, SIDE_KA, URGENCY, useOrSetup, type Board, type CaseDetail, type Procedure } from './types';

export const invalOr = (qc: QueryClient) => {
  for (const k of ['or-board', 'or-case', 'or-my', 'or-cases', 'or-queue', 'or-anest', 'or-note', 'or-mat', 'or-roster', 'or-implants']) void qc.invalidateQueries({ queryKey: [k] });
};

// ================================================================= მოთხოვნა (ახალი / რედაქტირება)
interface ProcLine { procedure_id: string; code: string; name: string; laterality: boolean; side: string; is_primary: boolean; duration: number }
interface Sources { stays: { encounter_id: string; adm_no: string; department_name: string }[]; planned: { planned_id: string; plan_no: string; planned_date: string; department_name: string }[] }

export function RequestDialog({ encounterId, plannedId, patient: initPatient, edit, onClose, onDone }: {
  encounterId?: string; plannedId?: string; patient?: { id: string; name: string } | null; edit?: CaseDetail; onClose: () => void; onDone?: (id: string) => void;
}) {
  const qc = useQueryClient(); const { user } = useAuth();
  const [patient, setPatient] = useState<{ id: string; name: string } | null>(initPatient ?? null);
  const [src, setSrc] = useState<string>(encounterId ? `e:${encounterId}` : plannedId ? `p:${plannedId}` : '');
  const sources = useQuery({ queryKey: ['or-sources', patient?.id], queryFn: () => api<Sources>('/or/sources', { query: { patient_id: patient!.id } }),
    enabled: !!patient && !edit && !encounterId && !plannedId });
  const [procs, setProcs] = useState<ProcLine[]>(edit ? edit.procedures.map((p) => ({ procedure_id: p.procedure_id, code: p.code, name: p.name, laterality: p.laterality, side: p.side,
    is_primary: p.is_primary, duration: p.default_duration_min })) : []);
  const [f, setF] = useState({
    urgency: edit?.urgency ?? 'elective', anesthesia_type: edit?.anesthesia_type ?? 'general', preferred_date: edit?.preferred_date?.slice(0, 10) ?? '', preferred_time: edit?.preferred_time ? hm(edit.preferred_time) : '',
    duration_min: edit ? String(edit.duration_min) : '', needs_implant: edit?.needs_implant ?? false, needs_equipment: edit?.needs_equipment ?? '', needs_blood: edit?.needs_blood ?? false,
    blood_note: edit?.blood_note ?? '', needs_icu: edit?.needs_icu ?? false, notes: edit?.notes ?? '', preferred_anesthesiologist_id: edit?.preferred_anesthesiologist_id ?? '', surgeon_id: '',
  });
  const [icd, setIcd] = useState<{ code: string; title: string } | null>(edit?.icd10_code ? { code: edit.icd10_code, title: edit.icd10_title ?? '' } : null);
  const anesth = useQuery({ queryKey: ['or-staff', 'anesthesiologist'], queryFn: () => api<{ id: string; name: string }[]>('/or/staff', { query: { cap: 'anesthesiologist' } }) });
  const doctors = useQuery({ queryKey: ['or-staff', 'doctor'], queryFn: () => api<{ id: string; name: string; department_name: string | null }[]>('/or/staff', { query: { cap: 'doctor' } }) });
  const set = (k: keyof typeof f, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  const sum = procs.reduce((a, p) => a + p.duration, 0);
  const isDoctor = !!user?.caps.includes('doctor');
  // ერთადერთი წყარო (აქტიური ჰოსპიტალიზაცია / გეგმიური) — ავტომატურად
  const only = sources.data && sources.data.stays.length + sources.data.planned.length === 1 ? (sources.data.stays[0] ? `e:${sources.data.stays[0].encounter_id}` : `p:${sources.data.planned[0].planned_id}`) : '';
  if (only && !src) setSrc(only);
  const save = useMutation({
    mutationFn: () => {
      const body = {
        urgency: f.urgency, anesthesia_type: f.anesthesia_type, icd10_code: icd?.code ?? null, preferred_date: f.preferred_date || null, preferred_time: f.preferred_time || null,
        ...(f.duration_min ? { duration_min: Number(f.duration_min) } : {}), needs_implant: f.needs_implant, needs_equipment: f.needs_equipment.trim() || null, needs_blood: f.needs_blood,
        blood_note: f.blood_note.trim() || null, needs_icu: f.needs_icu, notes: f.notes.trim() || null, preferred_anesthesiologist_id: f.preferred_anesthesiologist_id || null,
        procedures: procs.map((p) => ({ procedure_id: p.procedure_id, side: p.side, is_primary: p.is_primary })),
      };
      if (edit) return api<CaseDetail>(`/or/cases/${edit.id}`, { method: 'PATCH', body });
      const [k, id] = src.split(':');
      return api<CaseDetail>('/or/cases', { body: { ...body, ...(k === 'e' ? { encounter_id: id } : { planned_id: id }), ...(f.surgeon_id ? { surgeon_id: f.surgeon_id } : {}) } });
    },
    onSuccess: (c) => { invalOr(qc); void qc.invalidateQueries({ queryKey: ['ipd-stay'] }); onDone?.(c.id); onClose(); },
  });
  // რა აკლია (ღილაკის გვერდით ჩანს — რატომ არ აქტიურდება)
  const missing = [
    !edit && !patient && !encounterId && !plannedId && 'პაციენტი',
    !edit && !src && (patient || encounterId || plannedId) && 'ჰოსპიტალიზაცია / გეგმიური რიგი',
    !procs.length && 'პროცედურა (აირჩიეთ სიიდან)',
    procs.some((p) => p.laterality && p.side === 'na') && 'პროცედურის მხარე',
    !edit && !isDoctor && !f.surgeon_id && 'ოპერატორი ქირურგი',
  ].filter(Boolean) as string[];
  const valid = missing.length === 0;
  return (
    <Modal title={edit ? `მოთხოვნის შეცვლა — ${edit.case_no}` : 'ოპერაციის მოთხოვნა'} onClose={onClose} width={860}
      footer={<>{!valid && <span className="small grow" style={{ color: 'var(--warn-ink)' }}>შესავსებია: {missing.join(', ')}</span>}
        <button className="btn" type="button" onClick={onClose}>გაუქმება</button>
        <button className="btn primary" type="button" disabled={!valid || save.isPending} onClick={() => save.mutate()}>{edit ? 'შენახვა' : 'მოთხოვნის გაგზავნა'}</button></>}>
      {!edit && !encounterId && !plannedId && (
        <div className="stack" style={{ gap: 8 }}>
          <span className="label">პაციენტი</span>
          {patient ? <div className="row"><strong>{patient.name}</strong><button className="btn sm" type="button" onClick={() => { setPatient(null); setSrc(''); }}>შეცვლა</button></div>
            : <PatientSearch autoFocus onSelect={(p: PatientListItem) => setPatient({ id: p.id, name: `${p.last_name} ${p.first_name}` })} />}
          {patient && sources.data && (
            <div className="stack" style={{ gap: 6 }}>
              <span className="label">ჰოსპიტალიზაცია / გეგმიური რიგი</span>
              {sources.data.stays.map((s) => <label key={s.encounter_id} className="row"><input type="radio" name="src" checked={src === `e:${s.encounter_id}`} onChange={() => setSrc(`e:${s.encounter_id}`)} />
                <span><span className="mono">{s.adm_no}</span> · {s.department_name} <span className="chip ok">სტაციონარში</span></span></label>)}
              {sources.data.planned.map((s) => <label key={s.planned_id} className="row"><input type="radio" name="src" checked={src === `p:${s.planned_id}`} onChange={() => setSrc(`p:${s.planned_id}`)} />
                <span><span className="mono">{s.plan_no}</span> · {s.department_name} · {dateGe(s.planned_date)} <span className="chip info">გეგმიური რიგი</span></span></label>)}
              {!sources.data.stays.length && !sources.data.planned.length && <div className="alert warn">პაციენტს არ აქვს აქტიური ჰოსპიტალიზაცია ან გეგმიური რიგის ჩანაწერი. ოპერაცია ყოველთვის ჰოსპიტალიზაციაზეა (დღის სტაციონარიც) — ჯერ გააფორმეთ ჰოსპიტალიზაცია ან გეგმიური რიგი.</div>}
            </div>)}
        </div>)}
      <ProcPicker procs={procs} setProcs={setProcs} />
      <div className="row" style={{ flexWrap: 'wrap' }}><span className="label">სასწრაფოობა</span><div className="seg" role="group" aria-label="სასწრაფოობა">
        {Object.entries(URGENCY).map(([k, [, l]]) => <button key={k} type="button" aria-pressed={f.urgency === k} onClick={() => set('urgency', k)}>{l}</button>)}</div>
        {f.urgency === 'emergency' && <span className="small" style={{ color: 'var(--danger)' }}>გადაუდებელი — რიგს გვერდს უვლის: ქირურგს შეუძლია პირდაპირ დაგეგმოს</span>}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
        <Field label="ანესთეზიის ტიპი" htmlFor="rq-a" required><select id="rq-a" className="select" value={f.anesthesia_type} onChange={(e) => set('anesthesia_type', e.target.value)}>
          {Object.entries(ANESTHESIA_KA).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="ხანგრძლივობა (წთ)" htmlFor="rq-d" hint={sum ? `კატალოგით: ${sum} წთ` : undefined}>
          <input id="rq-d" className="input mono" type="number" min={5} max={1440} placeholder={sum ? String(sum) : ''} value={f.duration_min} onChange={(e) => set('duration_min', e.target.value)} /></Field>
        <Field label="სასურველი თარიღი" htmlFor="rq-pd"><input id="rq-pd" className="input" type="date" min={todayISO()} value={f.preferred_date} onChange={(e) => set('preferred_date', e.target.value)} /></Field>
        <Field label="სასურველი დრო" htmlFor="rq-pt"><input id="rq-pt" className="input" type="time" value={f.preferred_time} onChange={(e) => set('preferred_time', e.target.value)} /></Field>
        <Field label="სასურველი ანესთეზიოლოგი" htmlFor="rq-pa"><select id="rq-pa" className="select" value={f.preferred_anesthesiologist_id} onChange={(e) => set('preferred_anesthesiologist_id', e.target.value)}>
          <option value="">—</option>{anesth.data?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
      </div>
      {!edit && (
        <Field label="ოპერატორი ქირურგი" htmlFor="rq-s" hint="ნაგულისხმევად — თქვენ; სხვა ქირურგზე — განყოფილების ხელმძღვანელი / admin">
          <select id="rq-s" className="select" value={f.surgeon_id} onChange={(e) => set('surgeon_id', e.target.value)}>
            <option value="">{isDoctor ? `${user?.name} (მე)` : '— აირჩიეთ —'}</option>{doctors.data?.filter((d) => d.id !== user?.id).map((d) => <option key={d.id} value={d.id}>{d.name}{d.department_name ? ` — ${d.department_name}` : ''}</option>)}</select></Field>)}
      <div className="stack" style={{ gap: 6 }}>
        <span className="label">წინასაოპერაციო დიაგნოზი (ICD-10)</span>
        {icd ? <div className="row"><span className="mono" style={{ fontWeight: 600 }}>{icd.code}</span><span className="grow">{icd.title}</span><button className="btn sm" type="button" onClick={() => setIcd(null)}>შეცვლა</button></div>
          : <IcdPicker primary onPick={(c: IcdCode) => setIcd({ code: c.code, title: c.title })} />}
        {!icd && !edit && <span className="hint">ცარიელი — ჰოსპიტალიზაციის / გეგმიური რიგის დიაგნოზი</span>}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
        <div className="stack" style={{ gap: 8 }}>
          <label className="row"><input type="checkbox" checked={f.needs_implant} onChange={(e) => set('needs_implant', e.target.checked)} /> იმპლანტი</label>
          <label className="row"><input type="checkbox" checked={f.needs_blood} onChange={(e) => set('needs_blood', e.target.checked)} /> სისხლი / კომპონენტები</label>
          {f.needs_blood && <input className="input" aria-label="სისხლი — კომპონენტი / დოზა" placeholder="კომპონენტი / დოზა" value={f.blood_note} onChange={(e) => set('blood_note', e.target.value)} />}
          <label className="row"><input type="checkbox" checked={f.needs_icu} onChange={(e) => set('needs_icu', e.target.checked)} /> ოპერაციის შემდეგ — ICU საწოლი</label>
        </div>
        <div className="stack" style={{ gap: 8 }}>
          <Field label="აპარატურა" htmlFor="rq-eq"><input id="rq-eq" className="input" placeholder="C-რკალი, ლაპაროსკოპი…" value={f.needs_equipment} onChange={(e) => set('needs_equipment', e.target.value)} /></Field>
          <Field label="შენიშვნა" htmlFor="rq-n"><textarea id="rq-n" className="textarea" rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
        </div>
      </div>
      <ErrorBox error={save.error} />
    </Modal>
  );
}

function ProcPicker({ procs, setProcs }: { procs: ProcLine[]; setProcs: (p: ProcLine[]) => void }) {
  const [q, setQ] = useState(''); const dq = useDebounced(q.trim(), 200);
  const r = useQuery({ queryKey: ['or-procs', dq], queryFn: () => api<Procedure[]>('/or/procedures', { query: { q: dq } }), enabled: dq.length >= 2 });
  const [idx, setIdx] = useState(0);
  const items = dq.length >= 2 ? (r.data ?? []).slice(0, 12) : [];
  const none = dq.length >= 2 && !r.isFetching && r.isSuccess && !r.data.length;
  const pending = q.trim().length > 0 && !none;
  const add = (p: Procedure) => {
    if (procs.some((x) => x.procedure_id === p.id)) return;
    setProcs([...procs, { procedure_id: p.id, code: p.code, name: p.name, laterality: p.laterality, side: 'na', is_primary: procs.length === 0, duration: p.default_duration_min }]);
    setQ('');
  };
  const upd = (i: number, v: Partial<ProcLine>) => setProcs(procs.map((p, j) => (j === i ? { ...p, ...v } : v.is_primary ? { ...p, is_primary: false } : p)));
  return (
    <div className="stack" style={{ gap: 8 }}>
      <span className="label">პროცედურ(ებ)ი <span className="req">*</span></span>
      {procs.length > 0 && <table className="table"><tbody>{procs.map((p, i) => (
        <tr key={p.procedure_id}>
          <td style={{ width: 40 }}><input type="radio" name="primary" aria-label="ძირითადი" title="ძირითადი" checked={p.is_primary} onChange={() => upd(i, { is_primary: true })} /></td>
          <td><span className="mono small">{p.code}</span> {p.name}{p.is_primary && <span className="chip info" style={{ marginLeft: 6 }}>ძირითადი</span>}</td>
          <td style={{ width: 230 }}><select className="select" style={{ height: 36 }} aria-label="მხარე" value={p.side} onChange={(e) => upd(i, { side: e.target.value })}>
            {Object.entries(SIDE_KA).map(([k, l]) => <option key={k} value={k} disabled={k === 'na' && p.laterality}>{k === 'na' ? (p.laterality ? 'მხარე — სავალდებულო' : 'მხარე არ ეხება') : l}</option>)}</select></td>
          <td className="num small" style={{ whiteSpace: 'nowrap' }}>{p.duration} წთ</td>
          <td style={{ width: 40 }}><button className="icon-btn" type="button" aria-label="წაშლა" onClick={() => { const n = procs.filter((_, j) => j !== i); if (p.is_primary && n[0]) n[0] = { ...n[0], is_primary: true }; setProcs(n); }}>✕</button></td>
        </tr>))}</tbody></table>}
      <div style={{ position: 'relative' }}>
        <input className="input" aria-label="პროცედურის ძებნა" placeholder="პროცედურის ძებნა: დასახელება, კოდი, NCSP — აირჩიეთ სიიდან" value={q}
          onChange={(e) => { setQ(e.target.value); setIdx(0); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(i + 1, items.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
            if (e.key === 'Enter' && items[idx]) { e.preventDefault(); add(items[idx]); setIdx(0); }
          }} />
        {none && <div className="alert warn small" style={{ marginTop: 6 }}>„{dq}“ — აქტიურ კატალოგში ვერ მოიძებნა. პროცედურას ამატებს admin: ადმინისტრირება → საოპერაციო → პროცედურების კატალოგი (ან CSV იმპორტი).</div>}
        {pending && !items.length && !procs.length && dq.length < 2 && <span className="hint">მინიმუმ 2 სიმბოლო</span>}
        {items.length > 0 && (
          <ul className="listbox" role="listbox" aria-label="პროცედურები" style={{ position: 'absolute', left: 0, right: 0, zIndex: 20 }}>
            {items.map((p, i) => (
              <li key={p.id} role="option" aria-selected={i === idx} onMouseEnter={() => setIdx(i)} onMouseDown={(e) => { e.preventDefault(); add(p); setIdx(0); }}>
                <span className="mono" style={{ width: 110, fontWeight: 600, color: 'var(--accent)', flexShrink: 0 }}>{p.code}</span>
                <span style={{ fontSize: 13 }} className="grow">{p.name}{p.ncsp_code && <span className="muted"> · NCSP {p.ncsp_code}</span>}</span>
                <span className="small muted">{p.specialty_name ?? ''} · {p.default_duration_min} წთ{p.laterality ? ' · მხარე' : ''}</span>
              </li>))}
          </ul>)}
      </div>
    </div>
  );
}

// ================================================================= დაგეგმვა / გადატანა
export function ScheduleDialog({ c, coordinator, onClose }: { c: Pick<CaseDetail, 'id' | 'case_no' | 'status' | 'duration_min' | 'room_id' | 'scheduled_start' | 'scheduled_end' | 'preferred_date' | 'preferred_time' | 'urgency' | 'last_name' | 'first_name'>; coordinator: boolean; onClose: () => void }) {
  const qc = useQueryClient(); const setup = useOrSetup();
  const startD = c.scheduled_start ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tbilisi' }).format(new Date(c.scheduled_start)) : c.preferred_date?.slice(0, 10) || todayISO();
  const [f, setF] = useState({ room_id: c.room_id ?? '', date: startD, time: c.scheduled_start ? hhmm(c.scheduled_start) : c.preferred_time ? hm(c.preferred_time) : '09:00',
    duration: String(c.scheduled_start && c.scheduled_end ? Math.round((new Date(c.scheduled_end).getTime() - new Date(c.scheduled_start).getTime()) / 60000) : c.duration_min), reason: '' });
  const [warn, setWarn] = useState<string[] | null>(null);
  const day = useQuery({ queryKey: ['or-board', f.date, 1, 'dlg'], queryFn: () => api<Board>('/or/board', { query: { date: f.date } }), enabled: !!f.date });
  const resched = c.status === 'scheduled' || c.status === 'tentative';
  const save = useMutation({
    mutationFn: (confirm: boolean) => api<CaseDetail>(`/or/cases/${c.id}/schedule`, { body: { room_id: f.room_id, start: localISO(f.date, f.time), duration_min: Number(f.duration), confirm,
      ...(f.reason.trim() ? { reason: f.reason.trim() } : {}) } }),
    onSuccess: () => { invalOr(qc); onClose(); },
    onError: (e) => { if (e instanceof ApiError && e.code === 'CONFIRM_REQUIRED') setWarn((e.body?.warnings as string[]) ?? [e.message]); },
  });
  const rooms = (setup.data?.rooms ?? []).filter((r) => r.is_active);
  const busy = (day.data?.cases ?? []).filter((x) => x.room_id === f.room_id && x.id !== c.id).sort((a, b) => (a.scheduled_start ?? '').localeCompare(b.scheduled_start ?? ''));
  const room = rooms.find((r) => r.id === f.room_id);
  const err = save.error instanceof ApiError && save.error.code === 'CONFIRM_REQUIRED' ? null : save.error;
  return (
    <Modal title={`${resched ? 'გადატანა' : 'დაგეგმვა'} — ${c.case_no} · ${c.last_name} ${c.first_name}`} onClose={onClose} width={720}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button>
        {warn ? <button className="btn danger" type="button" disabled={save.isPending} onClick={() => save.mutate(true)}>გაფრთხილებით შენახვა</button>
          : <button className="btn primary" type="button" disabled={!f.room_id || !f.date || !f.time || !Number(f.duration) || save.isPending || (resched && !coordinator && f.reason.trim().length < 3)}
            onClick={() => save.mutate(false)}>შენახვა</button>}</>}>
      {c.urgency === 'emergency' && <div className="alert danger">გადაუდებელი ოპერაცია — რიგს გვერდს უვლის; დაკავებულ ოთახზე მხოლოდ გაფრთხილება.</div>}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1.3fr 1fr 0.7fr', gap: 12 }}>
        <Field label="ოთახი" htmlFor="sc-r" required><select id="sc-r" className="select" value={f.room_id} onChange={(e) => { setF({ ...f, room_id: e.target.value }); setWarn(null); }}>
          <option value="">— აირჩიეთ —</option>{rooms.map((r) => <option key={r.id} value={r.id}>{r.code} — {r.name} ({r.block_name})</option>)}</select></Field>
        <Field label="თარიღი" htmlFor="sc-d" required><input id="sc-d" className="input" type="date" value={f.date} onChange={(e) => { setF({ ...f, date: e.target.value }); setWarn(null); }} /></Field>
        <Field label="დაწყება" htmlFor="sc-t" required><input id="sc-t" className="input" type="time" step={300} value={f.time} onChange={(e) => { setF({ ...f, time: e.target.value }); setWarn(null); }} /></Field>
        <Field label="წთ" htmlFor="sc-du" required><input id="sc-du" className="input mono" type="number" min={5} max={1440} value={f.duration} onChange={(e) => { setF({ ...f, duration: e.target.value }); setWarn(null); }} /></Field>
      </div>
      {room && <span className="small muted">სამუშაო საათები {hm(room.work_start)}–{hm(room.work_end)}{room.specialties.length ? ` · სპეციალობები: ${room.specialties.map((s) => setup.data?.specialties.find((x) => x.code === s)?.name ?? s).join(', ')}` : ''}{room.emergency_only ? ' · გადაუდებლის ოთახი' : ''}</span>}
      {f.room_id && (
        <div className="stack" style={{ gap: 6 }}>
          <span className="label">ოთახის დატვირთვა — {dateGe(f.date)}</span>
          {busy.length ? busy.map((x) => <div key={x.id} className="row small"><span className="mono">{hhmm(x.scheduled_start!)}–{hhmm(x.scheduled_end!)}</span>{chip(CASE_ST, x.status)}
            <span className="grow">{x.last_name} · {x.procedures}</span></div>) : <span className="small muted">ამ დღეს ოთახი თავისუფალია</span>}
        </div>)}
      {resched && <Field label="გადატანის მიზეზი" htmlFor="sc-re" required={!coordinator}><input id="sc-re" className="input" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>}
      {warn && <div className="alert warn"><div className="stack" style={{ gap: 4 }}><strong>გაფრთხილება — შეამოწმეთ და დაადასტურეთ:</strong>{warn.map((w) => <span key={w}>• {w}</span>)}</div></div>}
      <ErrorBox error={err} />
    </Modal>
  );
}

// ================================================================= გაუქმება / გადადება / მიზეზი
export function CancelDialog({ id, title, onClose }: { id: string; title: string; onClose: () => void }) {
  const qc = useQueryClient(); const setup = useOrSetup();
  const [code, setCode] = useState(''); const [note, setNote] = useState('');
  const m = useMutation({ mutationFn: () => api(`/or/cases/${id}/cancel`, { body: { reason_code: code, note: note.trim() || undefined } }), onSuccess: () => { invalOr(qc); onClose(); } });
  return (
    <Modal title={title} onClose={onClose} footer={<><button className="btn" type="button" onClick={onClose}>დახურვა</button>
      <button className="btn danger" type="button" disabled={!code || (code === 'other' && note.trim().length < 3) || m.isPending} onClick={() => m.mutate()}>ოპერაციის გაუქმება</button></>}>
      <Field label="მიზეზი" htmlFor="cn-r" required><select id="cn-r" className="select" value={code} onChange={(e) => setCode(e.target.value)}>
        <option value="">— აირჩიეთ —</option>{setup.data?.cancel_reasons.map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}</select></Field>
      <Field label="განმარტება" htmlFor="cn-n" required={code === 'other'}><textarea id="cn-n" className="textarea" rows={3} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <ErrorBox error={m.error} />
    </Modal>
  );
}

export function ReasonPrompt({ title, label, path, body = {}, danger, onClose, field = 'reason' }: { title: string; label: string; path: string; body?: Record<string, unknown>; danger?: boolean;
  onClose: () => void; field?: string }) {
  const qc = useQueryClient(); const [r, setR] = useState('');
  const m = useMutation({ mutationFn: () => api(path, { body: { ...body, [field]: r.trim() } }), onSuccess: () => { invalOr(qc); onClose(); } });
  return (
    <Modal title={title} onClose={onClose} footer={<><button className="btn" type="button" onClick={onClose}>დახურვა</button>
      <button className={`btn ${danger ? 'danger' : 'primary'}`} type="button" disabled={r.trim().length < 3 || m.isPending} onClick={() => m.mutate()}>დადასტურება</button></>}>
      <Field label={label} htmlFor="rp-r" required><textarea id="rp-r" className="textarea" rows={3} value={r} onChange={(e) => setR(e.target.value)} /></Field>
      <ErrorBox error={m.error} />
    </Modal>
  );
}
