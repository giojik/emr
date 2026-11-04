import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiError, api, can } from '../../api/client';
import type { Patient, PatientListItem } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import PatientSearch from '../../components/PatientSearch';
import { IdentifyDialog, MergeDialog, UnknownChip } from '../../components/UnknownPatient';
import { ErrorBox, Field, Loading, Modal, useToast } from '../../components/ui';
import { dateGe, tsDate } from '../../lib/format';
import { Diagnoses } from '../encounter/Clinical';
import DiagnosticsPanel from '../encounter/DiagnosticsPanel';
import DoctorNotesPanel from '../inpatient/DoctorNotes';
import {
  ACVPU, ARRIVAL_KIND_KA, type Board, type BoardItem, dur, type ErMeta, type ErVisit, GENDER_KA, hm, minsSince, minsUntil, NEWS2_KA, onColor, patientLabel,
  SPOT_KA, STATUS_KA, type TriageScale, WAIT_KA,
} from './types';

/**
 * გადაუდებელი დახმარება (ER), 0087: დაფა (ტრიაჟის ფერი, ადგილი, ტაიმერები კარი → ტრიაჟი / ექიმი, ER-ში ყოფნა, ექიმი / ექთანი, მოლოდინი),
 * რეგისტრაცია (+ უცნობი პაციენტი), ტრიაჟი / განმეორებითი ტრიაჟი (NEWS2 — მინიშნება), აყვანა, მინიჭება, გაუქმება.
 * ?visit=<id> — ბარათი (&tab=notes | dx — 0088: ჩანაწერები / კონსულტაცია, დიაგნოზი / დიაგნოსტიკა); ?register=<patient_id> — მიღება პაციენტის ბარათიდან.
 */
export function useNow(ms = 30_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}
export const useErMeta = () => useQuery({ queryKey: ['er-meta'], queryFn: () => api<ErMeta>('/er/meta'), staleTime: 60_000 });

export default function Er() {
  const { user } = useAuth();
  const [sp, setSp] = useSearchParams();
  const meta = useErMeta();
  const [dep, setDep] = useState(sp.get('department_id') ?? '');
  const board = useQuery({ queryKey: ['er-board', dep], queryFn: () => api<Board>('/er/board', { query: { department_id: dep } }),
    refetchInterval: (q) => ((q.state.data?.settings.board_refresh_sec ?? 30) * 1000) });
  const now = useNow(15_000);
  const skew = board.data ? new Date(board.data.now).getTime() - board.dataUpdatedAt : 0;
  const t = now + skew;
  const [reg, setReg] = useState<string | 'new' | null>(sp.get('register') ? sp.get('register') : null);
  const [tri, setTri] = useState<BoardItem | null>(null);
  const visitId = sp.get('visit');
  const openVisit = (id: string | null) => { const n = new URLSearchParams(sp); if (id) n.set('visit', id); else { n.delete('visit'); n.delete('tab'); } setSp(n, { replace: true }); };
  const perms = meta.data?.perms;
  const qc = useQueryClient(); const toast = useToast();
  const pickup = useMutation({
    mutationFn: (id: string) => api(`/er/visits/${id}/pickup`, { method: 'POST' }),
    onSuccess: () => { toast.show('პაციენტი აყვანილია'); void qc.invalidateQueries({ queryKey: ['er-board'] }); void qc.invalidateQueries({ queryKey: ['er-visit'] }); },
  });
  const c = board.data?.counts;
  const deps = meta.data?.departments ?? [];

  if (meta.isLoading) return <Loading />;
  return (
    <>
      <header className="topbar" style={{ flexWrap: 'wrap', gap: 12 }}>
        <h1 className="grow">გადაუდებელი დახმარება</h1>
        {deps.length > 1 && <select aria-label="განყოფილება" className="select" style={{ width: 'auto' }} value={dep} onChange={(e) => setDep(e.target.value)}>
          <option value="">ყველა ER განყოფილება</option>{deps.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>}
        <Link className="btn" to={`/er/tv${dep ? `?department_id=${dep}` : ''}`} target="_blank" data-ro-ok>TV ეკრანი</Link>
        {perms?.register && <button className="btn primary" type="button" disabled={!deps.length} onClick={() => setReg('new')}>+ მიღება ER-ში</button>}
      </header>
      <div className="content">
        {toast.node}
        <ErrorBox error={meta.error ?? board.error ?? pickup.error} />
        {!deps.length && <div className="alert warn">ER-ის განყოფილება არ არის — ადმინისტრირება → განყოფილებები → ტიპი „გადაუდებელი (ER)“; ადგილები — ადმინისტრირება → გადაუდებელი (ER).</div>}
        {c && <div className="row" style={{ gap: 10, flexWrap: 'wrap' }} data-testid="er-counts">
          <Tile k="ER-ში" v={c.total} /><Tile k="ტრიაჟის მოლოდინში" v={c.waiting_triage} /><Tile k="ექიმის მოლოდინში" v={c.waiting_doctor} />
          <Tile k="მკურნალობაში" v={c.in_treatment} /><Tile k="ვადაგადაცილებული" v={c.overdue} danger={c.overdue > 0} />
          {(c.notes_overdue ?? 0) > 0 && <Tile k="ჩანაწერი აკლია" v={c.notes_overdue!} danger />}
          <Tile k="თავისუფალი ადგილი" v={`${c.spots_free} / ${c.spots_total}`} />
          {board.data!.on_duty.length > 0 && <div className="card card-pad stack grow" style={{ gap: 2, minWidth: 220 }}><span className="small muted">მორიგე ექიმი ახლა</span>
            <span className="small">{board.data!.on_duty.map((d) => `${d.name}${d.duty_name ? ` (${d.duty_name})` : ''}${d.phone ? ` · ${d.phone}` : ''}`).join('; ')}</span></div>}
        </div>}
        {!board.data ? <Loading /> : (
          <div className="card">
            <table className="table" data-testid="er-board">
              <thead><tr><th style={{ width: 8 }} /><th>ადგილი</th><th>პაციენტი</th><th>ჩივილი</th><th>შემოსვლა</th><th>სტატუსი</th><th>ტაიმერები</th><th>ექიმი / ექთანი</th><th /></tr></thead>
              <tbody>
                {board.data.items.length === 0 && <tr><td colSpan={9}><div className="empty">ER-ში პაციენტი არ არის.</div></td></tr>}
                {board.data.items.map((i) => <Row key={i.encounter_id} i={i} t={t} perms={perms} meDoctor={can(user, 'er_doctor')} meId={user?.id}
                  onOpen={() => openVisit(i.encounter_id)} onTriage={() => setTri(i)} onPickup={() => pickup.mutate(i.encounter_id)} busy={pickup.isPending} />)}
              </tbody>
            </table>
          </div>
        )}
        {board.data && board.data.spots.length > 0 && <section className="card card-pad stack" style={{ gap: 8 }}>
          <h2 style={{ margin: 0 }}>ადგილები</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 8 }} data-testid="er-spots">
            {board.data.spots.map((s) => { const occ = board.data!.items.find((i) => i.encounter_id === s.encounter_id);
              return <button key={s.id} type="button" className="card card-pad stack ro-ok" style={{ gap: 2, textAlign: 'left', cursor: occ ? 'pointer' : 'default', borderLeft: `5px solid ${occ?.triage?.color ?? (occ ? 'var(--control)' : 'var(--ok-line)')}` }}
                onClick={() => occ && openVisit(occ.encounter_id)} aria-label={`${s.name}${occ ? ` — ${occ.patient.name}` : ' — თავისუფალი'}`}>
                <strong>{s.name}</strong><span className="small muted">{SPOT_KA[s.kind]}{deps.length > 1 ? ` · ${s.department_name}` : ''}</span>
                <span className="small">{occ ? occ.patient.name : <span style={{ color: 'var(--ok-ink)' }}>თავისუფალი</span>}</span></button>; })}
          </div>
        </section>}
      </div>
      {reg && meta.data && <RegisterDialog meta={meta.data} dep={dep} patientId={reg === 'new' ? null : reg} spots={board.data?.spots ?? []}
        onClose={() => { setReg(null); if (sp.get('register')) { const n = new URLSearchParams(sp); n.delete('register'); setSp(n, { replace: true }); } }}
        onDone={(id) => { setReg(null); openVisit(id); }} />}
      {tri && meta.data && <TriageDialog meta={meta.data} encounterId={tri.encounter_id} title={`${tri.triage ? 'განმეორებითი ტრიაჟი' : 'ტრიაჟი'} — ${tri.patient.name}`}
        scale={tri.triage?.scale} age={tri.patient.age} onClose={() => setTri(null)} />}
      {visitId && meta.data && <VisitDialog id={visitId} meta={meta.data} spots={board.data?.spots ?? []} onClose={() => openVisit(null)} />}
    </>
  );
}

const Tile = ({ k, v, danger }: { k: string; v: number | string; danger?: boolean }) => (
  <div className="card card-pad stack" style={{ gap: 0, minWidth: 120, borderColor: danger ? 'var(--danger-line)' : undefined, background: danger ? 'var(--danger-weak)' : undefined }}>
    <span className="small muted">{k}</span><strong style={{ fontSize: 22 }}>{v}</strong></div>
);

function Timer({ label, due, since, t, overdue }: { label: string; due?: string | null; since?: string | null; t: number; overdue?: boolean }) {
  if (due) {
    const left = minsUntil(due, t)!;
    return <span className={`small ${overdue || left < 0 ? '' : 'muted'}`} style={overdue || left < 0 ? { color: 'var(--danger)', fontWeight: 600 } : undefined}>{label}: {left < 0 ? `გადაცილება ${dur(-left)}` : `დარჩა ${dur(left)}`}</span>;
  }
  return <span className="small muted">{label}: {dur(minsSince(since ?? null, t))}</span>;
}

function Row({ i, t, perms, meDoctor, meId, onOpen, onTriage, onPickup, busy }: { i: BoardItem; t: number; perms?: ErMeta['perms']; meDoctor: boolean; meId?: string;
  onOpen: () => void; onTriage: () => void; onPickup: () => void; busy: boolean }) {
  const p = i.patient;
  return (
    <tr className="clickable" onClick={onOpen} data-testid="er-row">
      <td style={{ padding: 0, background: i.triage?.color ?? 'var(--line-soft)' }} title={i.triage?.name ?? 'ტრიაჟი არ ჩატარებულა'} />
      <td>{i.spot ? <><strong>{i.spot.name}</strong><div className="small muted">{SPOT_KA[i.spot.kind]}</div></> : <span className="muted">—</span>}</td>
      <td><div className="row" style={{ gap: 6, flexWrap: 'wrap' }}><strong>{p.is_unknown && p.first_name === 'უცნობი' ? `უცნობი #${p.unknown_no}` : p.name}</strong>
        {p.is_unknown && p.first_name !== 'უცნობი' && <UnknownChip p={p} />}{i.has_allergy && <span className="chip danger" title="აქტიური ალერგია">ალერგია</span>}</div>
        <div className="small muted">{GENDER_KA[p.gender] ?? ''} · {p.age_estimated ? '~' : ''}{p.age} წ. · <span className="mono">{i.visit_no}</span></div></td>
      <td style={{ maxWidth: 260 }}><span className="small">{i.chief_complaint}</span>
        {i.news2 && <div className="small" title="NEWS2 — მინიშნება (გადაწყვეტილებას იღებს ექიმი / ექთანი)">NEWS2 {i.news2.score} · {NEWS2_KA[i.news2.level] ?? i.news2.level}</div>}</td>
      <td><span className="mono">{hm(i.arrived_at)}</span><div className="small muted">{i.arrival_name}{i.ambulance_crew ? ` · №${i.ambulance_crew}` : ''}</div></td>
      <td>{i.triage ? <span className="chip" style={{ background: i.triage.color, color: onColor(i.triage.color) }}>{i.triage.name}</span> : <span className="chip warn">ტრიაჟის გარეშე</span>}
        <div className="small muted" style={{ marginTop: 4 }}>{STATUS_KA[i.status]}</div>
        {(() => { const w = [...new Set([...i.waiting_for, ...(i.waiting_auto ?? [])])]; return w.length > 0 && <div className="small" data-testid="er-waiting">მოლოდინი: {w.map((x) => WAIT_KA[x] ?? x).join(', ')}</div>; })()}
        {i.initial_note && !i.initial_note.signed && i.initial_note.overdue && <span className="chip danger" data-testid="er-note-overdue" title="პირველადი გასინჯვა არ არის ხელმოწერილი">ჩანაწერი აკლია</span>}</td>
      <td><div className="stack" style={{ gap: 0 }}>
        <Timer label="ER-ში" since={i.arrived_at} t={t} />
        {!i.first_triage_at && <Timer label="ტრიაჟამდე" due={i.timers.triage_due_at} t={t} overdue={i.timers.triage_overdue} />}
        {i.first_triage_at && !i.doctor_at && i.timers.doctor_due_at && <Timer label="ექიმამდე" due={i.timers.doctor_due_at} t={t} overdue={i.timers.doctor_overdue} />}
        {i.doctor_at && <span className="small muted">კარი → ექიმი: {dur(i.timers.door_to_doctor_min)}</span>}
        {i.timers.retriage_due_at && <Timer label="განმ. ტრიაჟი" due={i.timers.retriage_due_at} t={t} overdue={i.timers.retriage_overdue} />}
      </div></td>
      <td><div className="small">{i.doctor ? <>{i.doctor.name}{!i.doctor_at && <span className="muted"> (მინიჭებული)</span>}</> : <span className="muted">ექიმი —</span>}</div>
        <div className="small muted">{i.nurse?.name ?? 'ექთანი —'}</div></td>
      <td onClick={(e) => e.stopPropagation()} style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
        {perms?.triage && <button className="btn sm" type="button" onClick={onTriage}>{i.triage ? 'განმ. ტრიაჟი' : 'ტრიაჟი'}</button>}{' '}
        {meDoctor && !(i.doctor_at && i.doctor?.id === meId) && <button className="btn sm primary" type="button" disabled={busy} onClick={onPickup}>{i.doctor_at ? 'გადაბარება ჩემზე' : 'აყვანა'}</button>}
      </td>
    </tr>
  );
}

// ======================================================================= რეგისტრაცია
function RegisterDialog({ meta, dep, patientId, spots, onClose, onDone }: { meta: ErMeta; dep: string; patientId: string | null; spots: Board['spots']; onClose: () => void; onDone: (id: string) => void }) {
  const qc = useQueryClient();
  const pre = useQuery({ queryKey: ['patient', patientId], enabled: !!patientId, queryFn: () => api<Patient>(`/patients/${patientId}`) });
  const [mode, setMode] = useState<'search' | 'new' | 'unknown'>(patientId ? 'search' : 'search');
  const [picked, setPicked] = useState<PatientListItem | null>(null);
  const pat = picked ?? (pre.data as PatientListItem | undefined) ?? null;
  const activeModes = meta.arrival_modes.filter((a) => a.is_active);
  const [f, setF] = useState({ department_id: dep || meta.departments[0]?.id || '', arrival_mode: activeModes[0]?.code ?? '', chief_complaint: '', ambulance_crew: '', ambulance_call_at: '',
    referral_institution_id: '', arrival_note: '', spot_id: '' });
  const [np, setNp] = useState({ first_name: '', last_name: '', gender: 'male', birth_date: '', age_years: '', personal_number: '', passport_number: '', phone_number: '' });
  const kind = activeModes.find((a) => a.code === f.arrival_mode)?.kind;
  const freeSpots = spots.filter((s) => s.department_id === f.department_id && !s.encounter_id);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const setP = (k: keyof typeof np) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setNp({ ...np, [k]: e.target.value });
  const m = useMutation({
    mutationFn: () => api<{ encounter_id: string }>('/er/visits', { body: {
      department_id: f.department_id, arrival_mode: f.arrival_mode, chief_complaint: f.chief_complaint.trim(), spot_id: f.spot_id || undefined, arrival_note: f.arrival_note.trim() || undefined,
      ...(kind === 'ambulance' && { ambulance_crew: f.ambulance_crew.trim() || undefined, ambulance_call_at: f.ambulance_call_at ? new Date(f.ambulance_call_at).toISOString() : undefined }),
      ...(kind === 'transfer' && f.referral_institution_id && { referral_institution_id: f.referral_institution_id }),
      ...(mode === 'search' ? { patient_id: pat?.id } : { new_patient: {
        gender: np.gender, first_name: np.first_name.trim() || undefined, last_name: np.last_name.trim() || undefined,
        ...(np.birth_date ? { birth_date: np.birth_date } : { age_years: Number(np.age_years) }),
        ...(mode === 'new' && np.personal_number && { personal_number: np.personal_number }), ...(mode === 'new' && np.passport_number && { passport_number: np.passport_number.trim() }),
        ...(np.phone_number.trim() && { phone_number: np.phone_number.trim() }) } }),
    } }),
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ['er-board'] }); onDone(r.encounter_id); },
  });
  const active = m.error instanceof ApiError && m.error.code === 'ER_ALREADY_ACTIVE' ? (m.error.body?.encounter_id as string) : null;
  const pOk = mode === 'search' ? !!pat : (!!np.birth_date || np.age_years !== '') && (mode === 'unknown' || (!!np.first_name.trim() && !!np.last_name.trim()));
  const ok = pOk && !!f.department_id && !!f.arrival_mode && f.chief_complaint.trim().length >= 2 && !(kind === 'ambulance' && meta.settings.ambulance_fields === 'required' && !f.ambulance_crew.trim());
  return (
    <Modal title="მიღება ER-ში" onClose={onClose} width={720}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={!ok || m.isPending} onClick={() => m.mutate()}>მიღება</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        {!patientId && <div className="seg" role="group" aria-label="პაციენტი" style={{ width: 'max-content' }}>
          <button type="button" aria-pressed={mode === 'search'} onClick={() => setMode('search')}>არსებული პაციენტი</button>
          <button type="button" aria-pressed={mode === 'new'} onClick={() => setMode('new')}>ახალი (სწრაფი)</button>
          <button type="button" aria-pressed={mode === 'unknown'} onClick={() => setMode('unknown')}>უცნობი პაციენტი</button>
        </div>}
        {mode === 'search' && (pat ? <div className="card card-pad row" style={{ gap: 8 }}><strong className="grow">{pat.first_name} {pat.last_name} <UnknownChip p={pat} /></strong>
          <span className="small mono">{pat.personal_number ?? pat.passport_number ?? ''} · {dateGe(pat.birth_date)}</span>
          {!patientId && <button className="btn sm" type="button" onClick={() => setPicked(null)}>შეცვლა</button>}</div>
          : patientId ? <Loading /> : <PatientSearch autoFocus onSelect={setPicked} />)}
        {mode !== 'search' && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
          <Field label="სახელი" htmlFor="rg-fn" required={mode === 'new'} hint={mode === 'unknown' ? 'ცარიელი — „უცნობი“' : undefined}><input id="rg-fn" className="input" value={np.first_name} onChange={setP('first_name')} /></Field>
          <Field label="გვარი" htmlFor="rg-ln" required={mode === 'new'} hint={mode === 'unknown' ? 'ცარიელი — „#N“' : undefined}><input id="rg-ln" className="input" value={np.last_name} onChange={setP('last_name')} /></Field>
          <Field label="სქესი" htmlFor="rg-g" required><select id="rg-g" className="select" value={np.gender} onChange={setP('gender')}><option value="male">მამრობითი</option><option value="female">მდედრობითი</option><option value="other">სხვა / უცნობი</option></select></Field>
          <Field label="დაბადების თარიღი" htmlFor="rg-bd" hint="ან სავარაუდო ასაკი"><input id="rg-bd" className="input" type="date" value={np.birth_date} onChange={setP('birth_date')} /></Field>
          <Field label="სავარაუდო ასაკი (წ.)" htmlFor="rg-age"><input id="rg-age" className="input mono" type="number" min={0} max={120} disabled={!!np.birth_date} value={np.age_years} onChange={setP('age_years')} /></Field>
          <Field label="ტელეფონი" htmlFor="rg-ph"><input id="rg-ph" className="input mono" value={np.phone_number} onChange={setP('phone_number')} /></Field>
          {mode === 'new' && <>
            <Field label="პირადი ნომერი" htmlFor="rg-pn" hint="საბუთის გარეშე — „დაუდასტურებელი იდენტობა“"><input id="rg-pn" className="input mono" maxLength={11} value={np.personal_number} onChange={(e) => setNp({ ...np, personal_number: e.target.value.replace(/\D/g, '') })} /></Field>
            <Field label="პასპორტი" htmlFor="rg-pp"><input id="rg-pp" className="input mono" value={np.passport_number} onChange={setP('passport_number')} /></Field>
          </>}
        </div>}
        {mode === 'unknown' && <span className="small muted">შეიქმნება დროებითი ჩანაწერი „უცნობი #N“; იდენტიფიკაცია / გაერთიანება — მოგვიანებით (ბარათიდან).</span>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
          {meta.departments.length > 1 && <Field label="განყოფილება" htmlFor="rg-dep" required><select id="rg-dep" className="select" value={f.department_id} onChange={(e) => setF({ ...f, department_id: e.target.value, spot_id: '' })}>
            {meta.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>}
          <Field label="შემოსვლის გზა" htmlFor="rg-am" required><select id="rg-am" className="select" value={f.arrival_mode} onChange={set('arrival_mode')}>
            {activeModes.map((a) => <option key={a.code} value={a.code}>{a.name}</option>)}</select></Field>
          <Field label="ადგილი" htmlFor="rg-sp"><select id="rg-sp" className="select" value={f.spot_id} onChange={set('spot_id')}><option value="">— მოგვიანებით —</option>
            {freeSpots.map((s) => <option key={s.id} value={s.id}>{s.name} ({SPOT_KA[s.kind]})</option>)}</select></Field>
          {kind === 'ambulance' && <>
            <Field label="ბრიგადის №" htmlFor="rg-ac" required={meta.settings.ambulance_fields === 'required'}><input id="rg-ac" className="input mono" value={f.ambulance_crew} onChange={set('ambulance_crew')} /></Field>
            <Field label="გამოძახების დრო" htmlFor="rg-at"><input id="rg-at" className="input" type="datetime-local" value={f.ambulance_call_at} onChange={set('ambulance_call_at')} /></Field>
          </>}
          {kind === 'transfer' && <Field label="გამგზავნი კლინიკა" htmlFor="rg-ri"><select id="rg-ri" className="select" value={f.referral_institution_id} onChange={set('referral_institution_id')}>
            <option value="">—</option>{meta.institutions.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>}
        </div>
        <Field label="მთავარი ჩივილი" htmlFor="rg-cc" required><textarea id="rg-cc" className="textarea" rows={2} value={f.chief_complaint} onChange={set('chief_complaint')} /></Field>
        {kind && kind !== 'walk_in' && <Field label={`შენიშვნა (${ARRIVAL_KIND_KA[kind]})`} htmlFor="rg-an"><input id="rg-an" className="input" value={f.arrival_note} onChange={set('arrival_note')} /></Field>}
        <ErrorBox error={m.error} />
        {active && <button className="btn sm" type="button" style={{ width: 'max-content' }} onClick={() => onDone(active)}>მიმდინარე ER-ის ბარათის გახსნა →</button>}
      </div>
    </Modal>
  );
}

// ======================================================================= ტრიაჟი
export function TriageDialog({ meta, encounterId, title, scale, age, onClose }: { meta: ErMeta; encounterId: string; title: string; scale?: string; age: number; onClose: () => void }) {
  const qc = useQueryClient();
  const scales = meta.scales.filter((s) => s.is_active);
  const [sc, setSc] = useState(scale ?? meta.settings.triage_scale);
  const cur: TriageScale | undefined = scales.find((s) => s.code === sc) ?? meta.scales.find((s) => s.code === sc);
  const [level, setLevel] = useState<number | null>(null);
  const [v, setV] = useState<Record<string, string>>({ consciousness: 'A', o2_supplement: 'false' });
  const [gcs, setGcs] = useState(''); const [disc, setDisc] = useState(''); const [note, setNote] = useState('');
  const n = (k: string) => (v[k] !== undefined && v[k] !== '' ? Number(v[k]) : undefined);
  const vitals = { systolic_bp: n('systolic_bp'), diastolic_bp: n('diastolic_bp'), heart_rate: n('heart_rate'), respiratory_rate: n('respiratory_rate'), temperature: n('temperature'),
    spo2: n('spo2'), o2_supplement: v.o2_supplement === 'true', o2_flow: v.o2_supplement === 'true' ? n('o2_flow') : undefined, consciousness: v.consciousness || undefined, pain: n('pain'), glucose: n('glucose'), weight_kg: n('weight_kg') };
  const anyVital = ['systolic_bp', 'heart_rate', 'respiratory_rate', 'temperature', 'spo2', 'pain', 'glucose', 'weight_kg', 'diastolic_bp'].some((k) => v[k]);
  const hint = useMemo(() => (meta.settings.news2_hint && age >= 16 ? news2Hint(vitals) : null), [JSON.stringify(vitals), age]);   // eslint-disable-line react-hooks/exhaustive-deps
  const m = useMutation({
    mutationFn: () => api(`/er/visits/${encounterId}/triage`, { body: { scale_code: sc, level, gcs: gcs ? Number(gcs) : undefined, discriminator: disc.trim() || undefined, note: note.trim() || undefined,
      vitals: anyVital ? vitals : undefined } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['er-board'] }); void qc.invalidateQueries({ queryKey: ['er-visit', encounterId] }); onClose(); },
  });
  const inp = (k: string, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <Field label={label} htmlFor={`tr-${k}`}><input id={`tr-${k}`} className="input mono" type="number" value={v[k] ?? ''} onChange={(e) => setV({ ...v, [k]: e.target.value })} {...props} /></Field>);
  return (
    <Modal title={title} onClose={onClose} width={780}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={!level || m.isPending} onClick={() => m.mutate()}>შენახვა</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        {scales.length > 1 && <div className="row" style={{ gap: 8 }}><span className="small muted">შკალა:</span>
          <select aria-label="შკალა" className="select" style={{ width: 'auto' }} value={sc} onChange={(e) => { setSc(e.target.value); setLevel(null); }}>{scales.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}</select></div>}
        <div className="stack" style={{ gap: 6 }} role="radiogroup" aria-label="ტრიაჟის დონე">
          {cur?.levels.filter((l) => l.is_active).map((l) => (
            <button key={l.level} type="button" role="radio" aria-checked={level === l.level} onClick={() => setLevel(l.level)} className="card card-pad row"
              style={{ gap: 10, textAlign: 'left', borderWidth: level === l.level ? 3 : 1, borderColor: level === l.level ? 'var(--ink)' : 'var(--line)', padding: '8px 12px' }}>
              <span className="chip" style={{ background: l.color, color: onColor(l.color), minWidth: 32, justifyContent: 'center' }}>{l.level}</span>
              <strong className="grow">{l.name}</strong>
              <span className="small muted">{l.target_doctor_min === 0 ? 'ექიმი — მაშინვე' : `ექიმამდე ≤ ${dur(l.target_doctor_min)}`}{l.retriage_min ? ` · განმ. ტრიაჟი ${dur(l.retriage_min)}` : ''}</span>
            </button>))}
        </div>
        <h3 style={{ margin: 0 }}>ვიტალები <span className="small muted" style={{ fontWeight: 400 }}>(არასავალდებულო — რეანიმაციულ შემთხვევაში შეიძლება მოგვიანებით)</span></h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: 10 }}>
          {inp('systolic_bp', 'სისტ. წნევა')}{inp('diastolic_bp', 'დიასტ. წნევა')}{inp('heart_rate', 'პულსი')}{inp('respiratory_rate', 'სუნთქვა / წთ')}{inp('temperature', 'ტემპ. °C', { step: 0.1 })}
          {inp('spo2', 'SpO₂ %')}
          <Field label="ჟანგბადი" htmlFor="tr-o2"><select id="tr-o2" className="select" value={v.o2_supplement} onChange={(e) => setV({ ...v, o2_supplement: e.target.value })}><option value="false">ჰაერი</option><option value="true">ჟანგბადი</option></select></Field>
          {v.o2_supplement === 'true' ? inp('o2_flow', 'ნაკადი ლ/წთ', { step: 0.5 }) : <span />}
          <Field label="ცნობიერება" htmlFor="tr-c"><select id="tr-c" className="select" value={v.consciousness} onChange={(e) => setV({ ...v, consciousness: e.target.value })}>{Object.entries(ACVPU).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          <Field label="GCS" htmlFor="tr-gcs"><input id="tr-gcs" className="input mono" type="number" min={3} max={15} value={gcs} onChange={(e) => setGcs(e.target.value)} /></Field>
          {inp('pain', 'ტკივილი 0–10', { min: 0, max: 10 })}{inp('glucose', 'გლუკოზა', { step: 0.1 })}{inp('weight_kg', 'წონა კგ', { step: 0.1 })}
        </div>
        {hint && <div className={`alert ${hint.level === 'high' ? 'danger' : hint.level === 'medium' || hint.level === 'low_red' ? 'warn' : 'info'}`} data-testid="news2-hint">
          NEWS2 = {hint.score} ({NEWS2_KA[hint.level]}) — მხოლოდ მინიშნება; დონეს ირჩევს ტრიაჟის თანამშრომელი.</div>}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label="მთავარი ნიშანი / წარდგენა" htmlFor="tr-d"><input id="tr-d" className="input" value={disc} onChange={(e) => setDisc(e.target.value)} placeholder="მაგ. გულმკერდის ტკივილი, ST↑" /></Field>
          <Field label="შენიშვნა" htmlFor="tr-n"><input id="tr-n" className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        </div>
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}
/** NEWS2-ის კლიენტური მინიშნება (იგივე ფორმულა, რაც backend-ის inpatient/news2.ts) — მხოლოდ სრულ ნაკრებზე */
function news2Hint(v: { respiratory_rate?: number; spo2?: number; o2_supplement?: boolean; systolic_bp?: number; heart_rate?: number; consciousness?: string; temperature?: number }) {
  const { respiratory_rate: rr, spo2, systolic_bp: sbp, heart_rate: hr, consciousness: c, temperature: t } = v;
  if (rr === undefined || spo2 === undefined || sbp === undefined || hr === undefined || !c || t === undefined) return null;
  const band = (x: number, rules: [number, number][]) => { for (const [max, p] of rules) if (x <= max) return p; return 0; };
  const parts = [band(rr, [[8, 3], [11, 1], [20, 0], [24, 2], [Infinity, 3]]), band(spo2, [[91, 3], [93, 2], [95, 1], [Infinity, 0]]), v.o2_supplement ? 2 : 0,
    band(sbp, [[90, 3], [100, 2], [110, 1], [219, 0], [Infinity, 3]]), band(hr, [[40, 3], [50, 1], [90, 0], [110, 1], [130, 2], [Infinity, 3]]), c === 'A' ? 0 : 3,
    band(Math.round(t * 10) / 10, [[35.0, 3], [36.0, 1], [38.0, 0], [39.0, 1], [Infinity, 2]])];
  const score = parts.reduce((a, b) => a + b, 0);
  return { score, level: score >= 7 ? 'high' : score >= 5 ? 'medium' : parts.some((p) => p === 3) ? 'low_red' : 'low' };
}

// ======================================================================= ბარათი
function VisitDialog({ id, meta, spots, onClose }: { id: string; meta: ErMeta; spots: Board['spots']; onClose: () => void }) {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['er-visit', id], queryFn: () => api<ErVisit>(`/er/visits/${id}`) });
  const staff = useQuery({ queryKey: ['er-staff'], enabled: meta.perms.assign, queryFn: () => api<{ doctors: { id: string; name: string }[]; nurses: { id: string; name: string }[] }>('/er/staff') });
  const [dlg, setDlg] = useState<'triage' | 'cancel' | 'identify' | 'merge' | null>(null);
  const [mergeTarget, setMergeTarget] = useState<string | undefined>();
  const [reason, setReason] = useState('');
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as 'card' | 'notes' | 'dx' | null) ?? 'card';
  const setTab = (t: string) => { const n = new URLSearchParams(sp); if (t === 'card') n.delete('tab'); else n.set('tab', t); setSp(n, { replace: true }); };
  const inv = () => { void qc.invalidateQueries({ queryKey: ['er-board'] }); void qc.invalidateQueries({ queryKey: ['er-visit', id] }); };
  const assign = useMutation({ mutationFn: (body: Record<string, unknown>) => api(`/er/visits/${id}`, { method: 'PATCH', body }), onSuccess: () => { toast.show('შენახულია'); inv(); } });
  const cancel = useMutation({ mutationFn: () => api(`/er/visits/${id}/cancel`, { body: { reason: reason.trim() } }), onSuccess: () => { inv(); onClose(); } });
  if (!q.data) return <Modal title="ER-ის ბარათი" onClose={onClose}>{q.error ? <ErrorBox error={q.error} /> : <Loading />}</Modal>;
  const v = q.data; const p = v.patient; const open = !v.ended_at;
  const free = spots.filter((s) => s.department_id === v.department_id && (!s.encounter_id || s.encounter_id === id));
  return (
    <Modal title={`${v.visit_no} — ${patientLabel(p)}`} onClose={onClose} width={980}>
      {toast.node}
      <div className="seg" role="tablist" aria-label="ER-ის ბარათი" style={{ width: 'max-content', marginBottom: 12 }}>
        <button type="button" role="tab" aria-selected={tab === 'card'} aria-pressed={tab === 'card'} className="ro-ok" onClick={() => setTab('card')}>ბარათი / ტრიაჟი</button>
        <button type="button" role="tab" aria-selected={tab === 'notes'} aria-pressed={tab === 'notes'} className="ro-ok" onClick={() => setTab('notes')}>ჩანაწერები / კონსულტაცია</button>
        <button type="button" role="tab" aria-selected={tab === 'dx'} aria-pressed={tab === 'dx'} className="ro-ok" onClick={() => setTab('dx')}>დიაგნოზი / კვლევები</button>
      </div>
      {tab === 'notes' && <div data-testid="er-notes"><DoctorNotesPanel encounterId={id} scope="er" /></div>}
      {tab === 'dx' && <div className="stack" style={{ gap: 12 }} data-testid="er-dx">
        <Diagnoses e={{ id, diagnoses: v.diagnoses }} canWrite={v.clinical.write} onChanged={inv} />
        <DiagnosticsPanel encounterId={id} canWrite={v.clinical.write} defaultUrgent={v.clinical.dx_default_priority === 'urgent'} />
      </div>}
      {tab === 'card' && <div className="stack" style={{ gap: 12 }} data-testid="er-visit">
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {v.color ? <span className="chip" style={{ background: v.color, color: onColor(v.color) }}>{v.level_name}</span> : <span className="chip warn">ტრიაჟის გარეშე</span>}
          <span className="chip">{STATUS_KA[v.status]}</span><UnknownChip p={p} />
          {p.merged_into_id && <Link className="chip info" to={`/patients/${p.merged_into_id}`}>გაერთიანებულია → ნამდვილი ბარათი</Link>}
          <span className="grow" />
          <Link className="btn sm" to={`/patients/${p.id}`} data-ro-ok>პაციენტის ბარათი</Link>
          {open && meta.perms.triage && <button className="btn sm" type="button" onClick={() => setDlg('triage')}>{v.first_triage_at ? 'განმეორებითი ტრიაჟი' : 'ტრიაჟი'}</button>}
          {p.is_unknown && !p.merged_into_id && meta.perms.identify && <button className="btn sm" type="button" onClick={() => setDlg('identify')}>იდენტიფიკაცია</button>}
          {p.is_unknown && !p.merged_into_id && meta.perms.merge && <button className="btn sm" type="button" onClick={() => { setMergeTarget(undefined); setDlg('merge'); }}>გაერთიანება…</button>}
          {open && (meta.perms.manage || (meta.perms.register && v.status === 'waiting')) && <button className="btn sm" type="button" onClick={() => setDlg('cancel')} style={{ color: 'var(--danger)' }}>გაუქმება (შეცდომა)</button>}
        </div>
        {v.allergies.length > 0 && <div className="alert danger">ალერგია: {v.allergies.map((a) => `${a.substance}${a.reaction_type ? ` (${a.reaction_type})` : ''}`).join(', ')}</div>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: '10px 16px' }}>
          <Info k="პაციენტი" v={`${p.gender === 'male' ? 'მამრ.' : p.gender === 'female' ? 'მდედრ.' : '—'} · ${p.birth_date_estimated ? '~' : ''}${p.age} წ.`} />
          <Info k="საბუთი" v={<span className="mono">{p.personal_number ?? p.passport_number ?? '—'}</span>} />
          <Info k="შემოსვლა" v={`${tsDate(v.arrived_at)} ${hm(v.arrived_at)}`} />
          <Info k="გზა" v={`${v.arrival_name}${v.ambulance_crew ? ` · ბრიგ. №${v.ambulance_crew}` : ''}${v.referral_institution_name ? ` · ${v.referral_institution_name}` : ''}`} />
          <div style={{ gridColumn: '1 / -1' }}><Info k="მთავარი ჩივილი" v={v.chief_complaint} /></div>
          {v.arrival_note && <div style={{ gridColumn: '1 / -1' }}><Info k="შენიშვნა" v={v.arrival_note} /></div>}
          <Info k="პირველი ტრიაჟი" v={hm(v.first_triage_at)} /><Info k="ექიმმა ნახა" v={v.doctor_at ? `${hm(v.doctor_at)} (${v.doctor_name})` : '—'} />
          <Info k="განყოფილება" v={v.department_name} /><Info k="დაარეგისტრირა" v={v.created_by_name ?? '—'} />
          {v.ended_at && <div style={{ gridColumn: '1 / -1' }}><Info k="დასრულდა" v={`${tsDate(v.ended_at)} ${hm(v.ended_at)} — ${v.end_reason ?? ''}`} /></div>}
        </div>
        {open && meta.perms.assign && <section className="card card-pad stack" style={{ gap: 8 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
            <Field label="ადგილი" htmlFor="vs-sp"><select id="vs-sp" className="select" value={v.spot_id ?? ''} onChange={(e) => assign.mutate({ spot_id: e.target.value || null })}>
              <option value="">— არ არის —</option>{free.map((s) => <option key={s.id} value={s.id}>{s.name} ({SPOT_KA[s.kind]})</option>)}</select></Field>
            <Field label="ექთანი" htmlFor="vs-n"><select id="vs-n" className="select" value={v.nurse_id ?? ''} onChange={(e) => assign.mutate({ nurse_id: e.target.value || null })}>
              <option value="">—</option>{staff.data?.nurses.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
            <Field label="ექიმი" htmlFor="vs-d" hint={v.doctor_at ? 'აყვანილია — შეცვლა = გადაბარება' : 'მინიჭება; „კარი → ექიმი“ ითვლება აყვანით'}><select id="vs-d" className="select" value={v.doctor_id ?? ''} onChange={(e) => assign.mutate({ doctor_id: e.target.value || null })}>
              <option value="">—</option>{staff.data?.doctors.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
          </div>
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}><span className="small muted">მოლოდინი:</span>
            {meta.waiting_for.map((w) => <label key={w} className="row small"><input type="checkbox" checked={v.waiting_for.includes(w)}
              onChange={(e) => assign.mutate({ waiting_for: e.target.checked ? [...v.waiting_for, w] : v.waiting_for.filter((x) => x !== w) })} /> {WAIT_KA[w] ?? w}</label>)}</div>
          <ErrorBox error={assign.error} />
        </section>}
        <section className="card">
          <div className="card-head"><h2>ტრიაჟის ისტორია</h2><span className="small muted">{v.triage.length}</span></div>
          {v.triage.length === 0 ? <div className="empty">ტრიაჟი ჯერ არ ჩატარებულა.</div> : (
            <table className="table" data-testid="er-triage-history"><thead><tr><th>დრო</th><th>დონე</th><th>ვიტალები</th><th>NEWS2</th><th>ნიშანი / შენიშვნა</th><th>ვინ</th></tr></thead>
              <tbody>{v.triage.map((t) => <tr key={t.id}>
                <td className="mono">{hm(t.recorded_at)}{t.is_retriage && <div className="small muted">განმეორებითი</div>}</td>
                <td><span className="chip" style={{ background: t.color, color: onColor(t.color) }}>{t.level_name}</span></td>
                <td className="small">{[t.systolic_bp && `${t.systolic_bp}/${t.diastolic_bp ?? '—'}`, t.heart_rate && `HR ${t.heart_rate}`, t.respiratory_rate && `RR ${t.respiratory_rate}`,
                  t.spo2 && `SpO₂ ${t.spo2}%${t.o2_supplement ? ' O₂' : ''}`, t.temperature && `${t.temperature}°`, t.consciousness && t.consciousness !== 'A' && `ACVPU ${t.consciousness}`, t.gcs && `GCS ${t.gcs}`,
                  t.pain !== null && `ტკ. ${t.pain}`, t.glucose && `გლ. ${t.glucose}`].filter(Boolean).join(' · ') || '—'}</td>
                <td>{t.news2_score !== null ? `${t.news2_score} (${NEWS2_KA[t.news2_level ?? ''] ?? ''})` : '—'}</td>
                <td className="small">{[t.discriminator, t.note].filter(Boolean).join(' — ') || '—'}</td><td className="small">{t.user_name}</td></tr>)}</tbody></table>)}
        </section>
      </div>}
      {dlg === 'triage' && <TriageDialog meta={meta} encounterId={id} title={`${v.first_triage_at ? 'განმეორებითი ტრიაჟი' : 'ტრიაჟი'} — ${patientLabel(p)}`} scale={v.triage_scale ?? undefined} age={p.age} onClose={() => setDlg(null)} />}
      {dlg === 'identify' && <IdentifyDialog patient={p} onClose={() => setDlg(null)} onMerge={meta.perms.merge ? (t) => { setMergeTarget(t.id); setDlg('merge'); } : undefined} />}
      {dlg === 'merge' && <MergeDialog source={p} initialTarget={mergeTarget} onClose={() => setDlg(null)} />}
      {dlg === 'cancel' && <Modal title="ER-ის შემთხვევის გაუქმება" onClose={() => setDlg(null)} width={480}
        footer={<><button className="btn" type="button" onClick={() => setDlg(null)}>დახურვა</button><button className="btn primary" type="button" disabled={reason.trim().length < 3 || cancel.isPending} onClick={() => cancel.mutate()}>გაუქმება</button></>}>
        <span className="small muted">მხოლოდ შეცდომით რეგისტრაცია (მაგ. სხვა პაციენტი / დუბლიკატი). პაციენტის გასვლა / გაწერა — შემდეგ ეტაპზე („გამოსავალი“).</span>
        <Field label="მიზეზი" htmlFor="cn-r" required><input id="cn-r" className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <ErrorBox error={cancel.error} />
      </Modal>}
    </Modal>
  );
}
const Info = ({ k, v }: { k: string; v: React.ReactNode }) => <div className="stack" style={{ gap: 2 }}><span className="small muted">{k}</span><span style={{ fontWeight: 500 }}>{v}</span></div>;
