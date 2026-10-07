import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError, can } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import type { Doctor } from '../../api/types';
import { ErrorBox, Field, Loading, Modal, useToast } from '../../components/ui';
import { age, dateGe, genderShort, tsDate } from '../../lib/format';
import { AssignDialog, invalIpd, openWristband, ReasonDialog } from './Inpatient';
import Form100Dialog from '../../components/Form100Dialog';
import DoctorNotesPanel from './DoctorNotes';
import EpicrisisPanel from './Epicrisis';
import MarPanel from './Mar';
import NursingPanel from './Nursing';
import OrdersPanel from './Orders';
import StayBillingPanel from './Billing';
import { DischargeDialog, LeaveDialog, TransferDialog } from './StayActions';
import { chipOf, DISCHARGE_KA, ISOLATION_KA, SEVERITY_KA, SOURCE_KA, STAY_ST, TRANSPORT_KA, type Board, type InpatientSettings, type Printer } from './types';

interface StayDetail {
  encounter_id: string; adm_no: string; patient_id: string; source: string; source_encounter_id: string | null; referral_id: string | null; planned_id: string | null; plan_no: string | null;
  referring_institution: string | null; severity: string | null; isolation: string | null; admitted_at: string; admitted_by_name: string; status: string; ended_at: string | null; cancel_reason: string | null;
  department_id: string; department_name: string; attending_doctor_id: string | null; doctor_name: string | null; chief_complaint: string | null; parent_encounter_id: string | null;
  first_name: string; last_name: string; personal_number: string | null; birth_date: string; gender: string; phone_number: string;
  current: Assignment | null; assignments: Assignment[]; events: { id: string; kind: string; data: Record<string, unknown>; at: string; user_name: string | null }[];
  diagnoses: { id: string; icd10_code: string; icd10_title: string; diagnosis_type: string }[]; allergies: { substance: string; severity: string; allergy_type: string }[];
  consent: 'granted' | 'refused' | 'revoked' | 'missing'; settings: InpatientSettings; can: { assign: boolean; manage: boolean; staff: boolean; cancel: boolean };
  // 0041
  discharge_type: string | null; discharge_note: string | null; destination_text: string | null; transport: string | null; closed_at: string | null;
  death_at: string | null; death_icd10_code: string | null; death_icd10_title: string | null; autopsy_required: boolean | null; body_released_at: string | null;
}
interface TransferRow { id: string; status: string; to_department: string; from_department: string; reason: string; requested_at: string; requested_by_name: string; decision_reason: string | null }
interface LeaveRow { id: string; started_at: string; expected_return_at: string; returned_at: string | null; reason: string; permitted_by_name: string | null }
interface Assignment { id: string; department_id: string; department_name: string; bed_id: string | null; bed_code: string | null; ward_code: string | null; started_at: string; bed_at: string | null; ended_at: string | null; end_kind: string | null; reason: string | null; assigned_by_name: string; bed_by_name: string | null }

const EV_KA: Record<string, string> = { admitted: 'ჰოსპიტალიზაცია', bed_assigned: 'საწოლი მიენიჭა', bed_changed: 'საწოლი შეიცვალა', attending_changed: 'მკურნალი ექიმი შეიცვალა', severity: 'მდგომარეობა',
  isolation: 'იზოლაცია', cancelled: 'გაუქმდა', bed_released: 'საწოლი გათავისუფლდა', wristband: 'სამაჯური დაიბეჭდა',
  transfer_requested: 'გადაყვანის მოთხოვნა', transfer_accepted: 'გადაყვანა', transfer_rejected: 'გადაყვანა უარყოფილია', transfer_cancelled: 'გადაყვანის მოთხოვნა გაუქმდა', transfer_overdue: 'გადაყვანა — პასუხი აგვიანებს',
  leave_started: 'დროებითი გასვლა', leave_returned: 'დაბრუნდა', leave_overdue: 'გასვლიდან არ დაბრუნებულა', discharged: 'გაწერა', discharge_cancelled: 'გაწერა გაუქმდა', death: 'გარდაცვალება',
  body_released: 'გვამის გატანა', closed: 'შემთხვევა დაიხურა', epicrisis_created: 'ეპიკრიზი შეიქმნა', epicrisis_signed: 'ეპიკრიზი ხელმოწერილია', epicrisis_cosigned: 'ეპიკრიზი თანახელმოწერილია',
  epicrisis_reopened: 'ეპიკრიზი ხელახლა გაიხსნა' };
const END_KA: Record<string, string> = { bed_change: 'საწოლის შეცვლა', transfer: 'გადაყვანა', discharge: 'გაწერა', cancel: 'გაუქმება' };
const TR_KA: Record<string, string> = { requested: 'მოლოდინში', accepted: 'მიღებულია', rejected: 'უარყოფილია', cancelled: 'გაუქმებულია' };
const DX_KA: Record<string, string> = { admission: 'მიმღები', primary: 'ძირითადი', secondary: 'თანმხლები', complication: 'გართულება' };

function evText(k: string, d: Record<string, unknown>) {
  const x = (v: unknown) => (v == null ? '—' : String(v));
  switch (k) {
    case 'admitted': return `${x(d.adm_no)} · ${SOURCE_KA[x(d.source)] ?? d.source} · ${x(d.department)}${d.bed ? ` · საწოლი ${d.bed}` : ''}`;
    case 'bed_assigned': return `${x(d.bed)} (პალატა ${x(d.ward)})`;
    case 'bed_changed': return `${x(d.from)} → ${x(d.to)} · ${x(d.reason)}`;
    case 'attending_changed': return `${x(d.to_name)} · ${x(d.reason)}`;
    case 'severity': return `${SEVERITY_KA[x(d.from)]?.[1] ?? '—'} → ${SEVERITY_KA[x(d.to)]?.[1] ?? '—'}`;
    case 'isolation': return `${ISOLATION_KA[x(d.from)] ?? 'არა'} → ${ISOLATION_KA[x(d.to)] ?? 'არა'}`;
    case 'cancelled': return x(d.reason);
    case 'bed_released': return `${x(d.bed)}`;
    case 'wristband': return d.mode === 'zpl' ? `Zebra: ${x(d.printer)}` : 'PDF';
    case 'transfer_requested': return `${x(d.from)} → ${x(d.to)} · ${x(d.reason)}`;
    case 'transfer_accepted': return `${x(d.to)}${d.bed ? ` · საწოლი ${d.bed}` : ' · საწოლის გარეშე'}`;
    case 'transfer_rejected': case 'transfer_cancelled': case 'leave_started': case 'discharge_cancelled': case 'epicrisis_reopened': return x(d.reason);
    case 'discharged': case 'death': return `${DISCHARGE_KA[x(d.type)] ?? ''}${d.bed ? ` · საწოლი ${d.bed}` : ''}${d.epicrisis_signed_now ? ' · ეპიკრიზი ხელმოწერილია' : ''}`;
    case 'epicrisis_signed': case 'epicrisis_cosigned': return d.number ? `№ ${x(d.number)}` : 'თანახელმოწერას ელოდება';
    case 'leave_returned': return d.late ? 'დაგვიანებით' : '';
    default: return '';
  }
}

/** ჰოსპიტალიზაციის ბარათი (0040): ადგილი, ექიმი, მდგომარეობა, სამაჯური, ისტორია */
export default function Stay() {
  const { id } = useParams(); const [sp] = useSearchParams(); const nav = useNavigate(); const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['ipd-stay', id], queryFn: () => api<StayDetail>(`/inpatient/stays/${id}`) });
  const s = q.data;
  const { hash } = useLocation();
  useEffect(() => { if (s && hash === '#billing') setTimeout(() => document.getElementById('billing')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 400); }, [s?.encounter_id, hash]);   // eslint-disable-line react-hooks/exhaustive-deps
  const board = useQuery({ queryKey: ['ipd-board', s?.current?.department_id], queryFn: () => api<Board>('/inpatient/board', { query: { department_id: s!.current!.department_id } }), enabled: !!s?.current && s.can.assign });
  const printers = useQuery({ queryKey: ['printers', 'wristband'], queryFn: () => api<Printer[]>('/inpatient/printers', { query: { kind: 'wristband' } }), enabled: s?.settings.wristband_print === 'zpl' });
  const [err, setErr] = useState<unknown>(null);
  const [dlg, setDlg] = useState<'bed' | 'doctor' | 'cancel' | 'transfer' | 'leave' | 'discharge' | 'undischarge' | 'form100' | null>(null);
  const { user } = useAuth();
  const transfers = useQuery({ queryKey: ['ipd-stay-transfers', id], queryFn: () => api<TransferRow[]>('/inpatient/transfers', { query: { encounter_id: id } }), enabled: !!s });
  const leaves = useQuery({ queryKey: ['ipd-stay-leaves', id], queryFn: () => api<LeaveRow[]>(`/inpatient/stays/${id}/leaves`), enabled: !!s });
  const post = useMutation({ mutationFn: (a: { path: string; body?: unknown; msg: string }) => api(a.path, { body: a.body ?? {} }).then(() => a.msg),
    onSuccess: (msg) => { toast.show(msg); invalIpd(qc); void qc.invalidateQueries({ queryKey: ['ipd-stay-transfers', id] }); void qc.invalidateQueries({ queryKey: ['ipd-stay-leaves', id] });
      void qc.invalidateQueries({ queryKey: ['ipd-epicrisis', id] }); }, onError: setErr });
  const patch = useMutation({ mutationFn: (body: Record<string, unknown>) => api(`/inpatient/stays/${id}`, { method: 'PATCH', body }), onSuccess: () => invalIpd(qc), onError: setErr });
  const print = useMutation({ mutationFn: (printer_id?: string) => api<{ printer: string }>(`/inpatient/stays/${id}/wristband`, { body: { printer_id } }),
    onSuccess: (r) => { toast.show(`სამაჯური გაიგზავნა: ${r.printer}`); invalIpd(qc); }, onError: setErr });
  if (q.isLoading) return <div className="content"><Loading /></div>;
  if (!s) return <div className="content"><ErrorBox error={q.error} /></div>;
  const active = s.status === 'active';
  const isAttending = s.attending_doctor_id === user?.id;
  const pendingTransfer = (transfers.data ?? []).find((t) => t.status === 'requested');
  const openLeave = (leaves.data ?? []).find((l) => !l.returned_at);
  const activePrinters = (printers.data ?? []).filter((p) => p.is_active);
  const wb = async () => { setErr(null); if (s.settings.wristband_print === 'pdf') { try { await openWristband(s.encounter_id); invalIpd(qc); } catch (e) { setErr(e); } } else print.mutate(undefined); };
  return (
    <>
      <header className="topbar" style={{ flexWrap: 'wrap', gap: 10 }}>
        <button className="btn sm" type="button" onClick={() => nav(-1)}>←</button>
        <h1 style={{ margin: 0 }}>{s.last_name} {s.first_name}</h1>
        <span className="muted">{genderShort(s.gender)} · {age(s.birth_date)} · {dateGe(s.birth_date)} · {s.personal_number}</span>
        <span className="mono">{s.adm_no}</span>{chipOf(STAY_ST, s.status)}
        <span className="grow" />
        <Link className="btn sm" to={`/patients/${s.patient_id}`}>პაციენტის ბარათი</Link>
      </header>
      <div className="content">
        {toast.node}
        {sp.get('new') && active && <div className="alert info">ჰოსპიტალიზაცია გაფორმდა ({s.adm_no}). {!s.current?.bed_id && 'საწოლს მიანიჭებს განყოფილება.'} დაბეჭდეთ სამაჯური{s.consent !== 'granted' ? ' და გააფორმეთ ჰოსპიტალიზაციის თანხმობა (პაციენტის ბარათი → თანხმობები)' : ''}.</div>}
        {s.allergies.length > 0 && <div className="alert danger">ალერგია: {s.allergies.map((a) => a.substance).join(', ')}</div>}
        {s.status === 'cancelled' && <div className="alert warn">გაუქმებულია: {s.cancel_reason}</div>}
        <ErrorBox error={err} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14 }}>
          <section className="card card-pad stack" style={{ gap: 10 }}>
            <h2 style={{ margin: 0 }}>ადგილი</h2>
            <div className="row"><span className="muted" style={{ width: 130 }}>განყოფილება</span><strong>{s.current?.department_name ?? s.department_name}</strong></div>
            <div className="row"><span className="muted" style={{ width: 130 }}>საწოლი</span>
              {s.current?.bed_code ? <strong className="mono">{s.current.bed_code} <span className="small muted">(პალატა {s.current.ward_code})</span></strong> : active ? <span className="chip warn">ელოდება საწოლს</span> : '—'}
              <span className="grow" />
              {active && s.can.assign && board.data && <button className="btn sm" type="button" onClick={() => setDlg('bed')}>{s.current?.bed_id ? 'შეცვლა' : 'მინიჭება'}</button>}</div>
            <div className="row"><span className="muted" style={{ width: 130 }}>მკურნალი ექიმი</span><strong>{s.doctor_name ?? '—'}</strong><span className="grow" />
              {active && (s.can.manage || s.can.staff) && <button className="btn sm" type="button" onClick={() => setDlg('doctor')}>შეცვლა</button>}</div>
            <div className="row"><span className="muted" style={{ width: 130 }}>მიღება</span><span>{tsDate(s.admitted_at)} · {SOURCE_KA[s.source]}{s.plan_no ? ` (${s.plan_no})` : ''}{s.referring_institution ? ` · ${s.referring_institution}` : ''}</span></div>
            <div className="row"><span className="muted" style={{ width: 130 }}>გააფორმა</span><span>{s.admitted_by_name}</span></div>
            {s.parent_encounter_id && <div className="row"><span className="muted" style={{ width: 130 }}>წყარო ვიზიტი</span><Link to={`/encounters/${s.parent_encounter_id}`}>გახსნა</Link></div>}
          </section>
          <section className="card card-pad stack" style={{ gap: 10 }}>
            <h2 style={{ margin: 0 }}>მდგომარეობა</h2>
            <Field label="სიმძიმე" htmlFor="sv"><select id="sv" className="select" disabled={!active || !s.can.staff || patch.isPending} value={s.severity ?? ''} onChange={(e) => patch.mutate({ severity: e.target.value || null })}>
              <option value="">—</option>{Object.entries(SEVERITY_KA).map(([k, [, l]]) => <option key={k} value={k}>{l}</option>)}</select></Field>
            <Field label="იზოლაცია" htmlFor="is"><select id="is" className="select" disabled={!active || !s.can.staff || patch.isPending} value={s.isolation ?? ''} onChange={(e) => patch.mutate({ isolation: e.target.value || null })}>
              <option value="">არ სჭირდება</option>{Object.entries(ISOLATION_KA).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
            <div className="stack" style={{ gap: 4 }}><span className="label">დიაგნოზები</span>
              {s.diagnoses.map((d) => <span key={d.id} className="small"><span className="chip">{DX_KA[d.diagnosis_type] ?? d.diagnosis_type}</span> <span className="mono">{d.icd10_code}</span> {d.icd10_title}</span>)}</div>
            {s.chief_complaint && <div className="small"><span className="muted">ჩივილები: </span>{s.chief_complaint}</div>}
            <div className="row"><span className="muted">ჰოსპიტალიზაციის თანხმობა:</span>
              {s.consent === 'granted' ? <span className="chip ok">მოწერილია</span> : s.consent === 'refused' ? <span className="chip danger">უარი</span> : <span className="chip warn">{s.consent === 'revoked' ? 'გაუქმებულია' : 'არ არის'}</span>}
              {s.consent !== 'granted' && <Link className="small" to={`/patients/${s.patient_id}`}>გაფორმება →</Link>}</div>
          </section>
          {active && <section className="card card-pad stack" style={{ gap: 10 }}>
            <h2 style={{ margin: 0 }}>მოქმედებები</h2>
            {s.settings.wristband && <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <button className="btn primary" type="button" disabled={print.isPending} onClick={wb}>სამაჯურის ბეჭდვა</button>
              {s.settings.wristband_print === 'zpl' && activePrinters.length > 1 && <select className="select" style={{ maxWidth: 220, height: 40 }} aria-label="პრინტერი" defaultValue=""
                onChange={(e) => { if (e.target.value) { setErr(null); print.mutate(e.target.value); e.target.value = ''; } }}>
                <option value="">სხვა პრინტერზე…</option>{activePrinters.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}
              {s.settings.wristband_print === 'zpl' && <button className="btn" type="button" onClick={() => openWristband(s.encounter_id).catch(setErr)}>PDF</button>}
            </div>}
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              {pendingTransfer ? <><span className="chip info">→ {pendingTransfer.to_department} (ელოდება მიღებას)</span>
                <button className="btn sm" type="button" onClick={() => { const r = window.prompt('გაუქმების მიზეზი'); if (r && r.trim().length >= 3) post.mutate({ path: `/inpatient/transfers/${pendingTransfer.id}/cancel`, body: { reason: r }, msg: 'მოთხოვნა გაუქმდა' }); }}>მოთხოვნის გაუქმება</button></>
                : (s.can.staff || isAttending) && !openLeave && <button className="btn" type="button" onClick={() => setDlg('transfer')}>გადაყვანა სხვა განყოფილებაში</button>}
              {openLeave ? <><span className="chip warn">გასულია · დაბრუნება {tsDate(openLeave.expected_return_at)} {new Date(openLeave.expected_return_at).toLocaleTimeString('ka-GE', { timeZone: 'Asia/Tbilisi', hour: '2-digit', minute: '2-digit', hour12: false })}</span>
                {s.can.staff && <button className="btn sm" type="button" onClick={() => post.mutate({ path: `/inpatient/stays/${s.encounter_id}/leave/return`, msg: 'დაბრუნება დაფიქსირდა' })}>დაბრუნდა</button>}</>
                : (s.can.staff || isAttending) && !pendingTransfer && <button className="btn" type="button" onClick={() => setDlg('leave')}>დროებითი გასვლა</button>}
            </div>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              {can(user, 'doctor', 'admin') && <button className="btn primary" type="button" onClick={() => setDlg('discharge')}>გაწერა…</button>}
              {can(user, 'doctor', 'admin') && <button className="btn" type="button" onClick={() => setDlg('form100')}>ფორმა №100/ა</button>}</div>
            {s.can.cancel && <button className="btn" type="button" onClick={() => setDlg('cancel')}>ჰოსპიტალიზაციის გაუქმება (შეცდომა)</button>}
          </section>}
          {s.status === 'discharged' && <section className="card card-pad stack" style={{ gap: 8 }}>
            <h2 style={{ margin: 0 }}>გაწერა</h2>
            <div className="row"><span className="muted" style={{ width: 130 }}>ტიპი</span><strong>{DISCHARGE_KA[s.discharge_type ?? ''] ?? s.discharge_type}</strong></div>
            <div className="row"><span className="muted" style={{ width: 130 }}>თარიღი</span><span>{s.ended_at && `${tsDate(s.ended_at)} ${new Date(s.ended_at).toLocaleTimeString('ka-GE', { timeZone: 'Asia/Tbilisi', hour: '2-digit', minute: '2-digit', hour12: false })}`}</span></div>
            {s.destination_text && <div className="row"><span className="muted" style={{ width: 130 }}>დაწესებულება</span><span>{s.destination_text}</span></div>}
            {s.transport && <div className="row"><span className="muted" style={{ width: 130 }}>ტრანსპორტი</span><span>{TRANSPORT_KA[s.transport]}</span></div>}
            {s.death_at && <div className="row"><span className="muted" style={{ width: 130 }}>გარდაცვალება</span><span>{tsDate(s.death_at)} · <span className="mono">{s.death_icd10_code}</span> {s.death_icd10_title} · აუტოფსია: {s.autopsy_required ? 'საჭიროა' : 'არა'}</span></div>}
            {s.discharge_note && <div className="small">{s.discharge_note}</div>}
            <div className="row"><span className="muted" style={{ width: 130 }}>დოკუმენტაცია</span>
              {s.closed_at ? <span className="chip ok">შემთხვევა დახურულია</span> : <span className="chip warn">მოსალოდნელია (ეპიკრიზი / საბოლოო დიაგნოზი)</span>}</div>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              {!s.closed_at && can(user, 'doctor', 'admin') && <button className="btn primary" type="button" disabled={post.isPending}
                onClick={() => post.mutate({ path: `/inpatient/stays/${s.encounter_id}/close`, body: { sign_epicrisis: true }, msg: 'შემთხვევა დაიხურა' })}>შემთხვევის დახურვა</button>}
              {s.death_at && !s.body_released_at && s.can.staff && <button className="btn" type="button" disabled={post.isPending}
                onClick={() => window.confirm('გვამის გატანა — ახლა?') && post.mutate({ path: `/inpatient/stays/${s.encounter_id}/body-released`, msg: 'გატანა დაფიქსირდა; საწოლი — დასალაგებელი' })}>გვამის გატანა</button>}
              {s.body_released_at && <span className="small muted">გვამი გატანილია: {tsDate(s.body_released_at)}</span>}
              {can(user, 'doctor', 'admin') && <button className="btn" type="button" onClick={() => setDlg('form100')}>ფორმა №100/ა</button>}
              {s.can.manage && !s.body_released_at && <button className="btn" type="button" onClick={() => setDlg('undischarge')}>გაწერის გაუქმება (შეცდომა)</button>}
            </div>
          </section>}
        </div>
        {s.status !== 'cancelled' && <DoctorNotesPanel encounterId={s.encounter_id} />}
        {s.status !== 'cancelled' && <OrdersPanel encounterId={s.encounter_id} departmentId={s.current?.department_id ?? s.department_id} />}
        {s.status !== 'cancelled' && <MarPanel encounterId={s.encounter_id} admNo={s.adm_no} />}
        {s.status !== 'cancelled' && <NursingPanel encounterId={s.encounter_id} />}
        {s.status !== 'cancelled' && <StayBillingPanel encounterId={s.encounter_id} />}
        {s.status !== 'cancelled' && <EpicrisisPanel encounterId={s.encounter_id} diagnoses={s.diagnoses} encounterActive={active || (s.status === 'discharged' && !s.closed_at)} />}
        {((transfers.data ?? []).length > 0 || (leaves.data ?? []).length > 0) && <section className="card">
          <div className="card-head"><h2 style={{ margin: 0 }}>გადაყვანები და დროებითი გასვლები</h2></div>
          <table className="table"><tbody>
            {(transfers.data ?? []).map((t) => <tr key={t.id}><td className="small">{tsDate(t.requested_at)}</td><td>გადაყვანა: {t.from_department} → {t.to_department}</td>
              <td><span className={`chip ${t.status === 'accepted' ? 'ok' : t.status === 'requested' ? 'info' : ''}`}>{TR_KA[t.status]}</span></td><td className="small">{t.reason}{t.decision_reason ? ` · ${t.decision_reason}` : ''}</td><td className="small muted">{t.requested_by_name}</td></tr>)}
            {(leaves.data ?? []).map((l) => <tr key={l.id}><td className="small">{tsDate(l.started_at)}</td><td>დროებითი გასვლა — {tsDate(l.expected_return_at)}-მდე</td>
              <td>{l.returned_at ? <span className={`chip ${new Date(l.returned_at) > new Date(l.expected_return_at) ? 'warn' : 'ok'}`}>დაბრუნდა {tsDate(l.returned_at)}</span> : <span className="chip warn">გასულია</span>}</td>
              <td className="small">{l.reason}</td><td className="small muted">{l.permitted_by_name}</td></tr>)}
          </tbody></table>
        </section>}
        <section className="card">
          <div className="card-head"><h2 style={{ margin: 0 }}>ეპიზოდები</h2></div>
          <table className="table"><thead><tr><th>განყოფილება</th><th>საწოლი</th><th>დან</th><th>მდე</th><th>მიზეზი</th><th>ვინ</th></tr></thead>
            <tbody>{s.assignments.map((a) => (
              <tr key={a.id}><td>{a.department_name}</td><td className="mono">{a.bed_code ?? '—'}</td><td className="small">{tsDate(a.bed_at ?? a.started_at)}</td>
                <td className="small">{a.ended_at ? `${tsDate(a.ended_at)} · ${END_KA[a.end_kind ?? ''] ?? ''}` : <span className="chip ok">მიმდინარე</span>}</td>
                <td className="small">{a.reason ?? ''}</td><td className="small">{a.bed_by_name ?? a.assigned_by_name}</td></tr>))}</tbody></table>
        </section>
        <section className="card">
          <div className="card-head"><h2 style={{ margin: 0 }}>ისტორია</h2></div>
          <table className="table"><tbody>{s.events.map((e) => (
            <tr key={e.id}><td className="small mono" style={{ whiteSpace: 'nowrap' }}>{new Date(e.at).toLocaleString('ka-GE', { timeZone: 'Asia/Tbilisi', hour12: false })}</td>
              <td><strong>{EV_KA[e.kind] ?? e.kind}</strong></td><td className="small">{evText(e.kind, e.data)}
                {Array.isArray(e.data.warnings) && e.data.warnings.length > 0 && <div style={{ color: 'var(--warn-ink)' }}>გაფრთხილება დადასტურდა: {(e.data.warnings as string[]).join('; ')}</div>}</td>
              <td className="small muted">{e.user_name ?? 'სისტემა'}</td></tr>))}</tbody></table>
        </section>
      </div>
      {dlg === 'bed' && board.data && <AssignDialog encounterId={s.encounter_id} title={`${s.last_name} ${s.first_name}`} board={board.data} change={!!s.current?.bed_id} onClose={() => setDlg(null)} />}
      {dlg === 'doctor' && <DoctorDialog s={s} onClose={() => setDlg(null)} />}
      {dlg === 'cancel' && <ReasonDialog title={`ჰოსპიტალიზაციის გაუქმება — ${s.adm_no}`} path={`/inpatient/stays/${s.encounter_id}/cancel`} onClose={() => setDlg(null)} />}
      {dlg === 'transfer' && <TransferDialog encounterId={s.encounter_id} currentDepartmentId={s.current?.department_id ?? s.department_id} onClose={() => { setDlg(null); void qc.invalidateQueries({ queryKey: ['ipd-stay-transfers', id] }); }} />}
      {dlg === 'leave' && <LeaveDialog encounterId={s.encounter_id} maxHours={s.settings.leave_max_hours} onClose={() => { setDlg(null); void qc.invalidateQueries({ queryKey: ['ipd-stay-leaves', id] }); }} />}
      {dlg === 'form100' && <Form100Dialog encounterId={s.encounter_id} onClose={() => setDlg(null)} />}
      {dlg === 'discharge' && <DischargeDialog encounterId={s.encounter_id} patientId={s.patient_id} departmentId={s.current?.department_id ?? s.department_id} onClose={() => setDlg(null)} />}
      {dlg === 'undischarge' && <ReasonDialog title={`გაწერის გაუქმება — ${s.adm_no}`} path={`/inpatient/stays/${s.encounter_id}/discharge/cancel`} onClose={() => setDlg(null)} />}
    </>
  );
}

function DoctorDialog({ s, onClose }: { s: StayDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const doctors = useQuery({ queryKey: ['doctors'], queryFn: () => api<Doctor[]>('/doctors') });
  const [doc, setDoc] = useState(''); const [reason, setReason] = useState('');
  const m = useMutation({ mutationFn: () => api(`/inpatient/stays/${s.encounter_id}`, { method: 'PATCH', body: { attending_doctor_id: doc, reason } }), onSuccess: () => { invalIpd(qc); onClose(); } });
  return (
    <Modal title="მკურნალი ექიმის შეცვლა" onClose={onClose} width={480}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={m.isPending || !doc || reason.trim().length < 3} onClick={() => m.mutate()}>შენახვა</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <Field label="ექიმი" htmlFor="dd"><select id="dd" className="select" value={doc} onChange={(e) => setDoc(e.target.value)}>
          <option value="">— აირჩიეთ —</option>{doctors.data?.filter((d) => d.id !== s.attending_doctor_id).map((d) => <option key={d.id} value={d.id}>{d.last_name} {d.first_name}{d.department_name ? ` · ${d.department_name}` : ''}</option>)}</select></Field>
        <Field label="მიზეზი" htmlFor="dr" required><input id="dr" className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        {m.error instanceof ApiError && m.error.status === 403 && <span className="small muted">ექიმს ცვლის განყოფილების ხელმძღვანელი, admin ან ამჟამინდელი მკურნალი ექიმი.</span>}
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}
