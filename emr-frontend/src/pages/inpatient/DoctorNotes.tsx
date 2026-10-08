import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, openBlob } from '../../api/client';
import type { Department, Doctor } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Field, Loading, Modal, useToast } from '../../components/ui';
import { hhmm, todayISO, tsDate } from '../../lib/format';
import { useIcu } from './Icu';

// ================================================================= ტიპები (0045)
export type NoteKind = 'admission' | 'progress' | 'rounds' | 'consult' | 'icu_daily' | 'icu_out';
export interface DoctorNote {
  id: string; encounter_id: string; kind: NoteKind; day: string; consultation_id: string | null; content: Record<string, string>; participants: string[]; participant_names: string[];
  status: 'draft' | 'signed'; version: number; root_id: string | null; amends_id: string | null; amend_reason: string | null; superseded_at: string | null;
  author_id: string; author_name: string; author_specialty: string | null; department_name: string | null; signed_at: string | null; created_at: string; updated_at: string;
  billed?: { amount: string; tariff: string } | null; warning?: string | null;
}
export interface Consultation {
  id: string; encounter_id: string; requested_by: string; requested_by_name: string; from_department_name: string | null; target_department_id: string | null; target_department_name: string | null;
  target_doctor_id: string | null; target_doctor_name: string | null; urgency: 'routine' | 'urgent' | 'emergency'; question: string; status: 'requested' | 'answered' | 'cancelled';
  due_at: string; answered_at: string | null; answered_by_name: string | null; answer_note_id: string | null; cancel_reason: string | null; created_at: string;
  // inbox
  adm_no?: string; first_name?: string; last_name?: string; birth_date?: string; gender?: string; bed_code?: string | null; patient_department?: string | null; my_draft_id?: string | null;
}
type Fields = Record<NoteKind, { key: string; label: string; required?: boolean }[]>;
interface NotesResp {
  notes: DoctorNote[]; consultations: Consultation[]; fields: Fields; today: string; admitted_day: string; last_day: string;
  admission: { note_id: string | null; due_at: string; overdue: boolean }; missing_days: string[]; can: { write: boolean; head: boolean; consult: boolean };
}
interface Template { id: string; kind: NoteKind; name: string; content: Record<string, string>; department_id: string | null; department_name: string | null; owner_id: string | null }

export const KIND_KA: Record<NoteKind, string> = { admission: 'მიმღები გასინჯვა', progress: 'დღიური', rounds: 'შემოვლა', consult: 'კონსულტაცია', icu_daily: 'ICU დღიური', icu_out: 'რეანიმაციიდან გაყვანა' };
const URG: Record<string, [string, string]> = { routine: ['', 'გეგმიური'], urgent: ['warn', 'სასწრაფო'], emergency: ['danger', 'გადაუდებელი'] };
const CST: Record<string, [string, string]> = { requested: ['info', 'მოლოდინში'], answered: ['ok', 'პასუხი მზადაა'], cancelled: ['', 'გაუქმდა'] };
const dd = (d: string) => d.split('-').reverse().join('/');
const dt = (iso: string) => `${tsDate(iso)} ${hhmm(iso)}`;
const INSERT_INTO: Partial<Record<NoteKind, string>> = { progress: 'o', admission: 'objective' };
const CONSULT_FIELDS = [{ key: 'assessment', label: 'შეფასება / დასკვნა', required: true }, { key: 'recommendations', label: 'რეკომენდაციები', required: true }];

function useInval() {
  const qc = useQueryClient();
  return () => { void qc.invalidateQueries({ queryKey: ['ipd-notes'] }); void qc.invalidateQueries({ queryKey: ['consult-inbox'] }); void qc.invalidateQueries({ queryKey: ['ipd-stay'] }); };
}

// ================================================================= პანელი (ჰოსპიტალიზაციის გვერდი)
export default function DoctorNotesPanel({ encounterId }: { encounterId: string }) {
  const { user } = useAuth(); const toast = useToast(); const inval = useInval();
  const q = useQuery({ queryKey: ['ipd-notes', encounterId], queryFn: () => api<NotesResp>(`/inpatient/stays/${encounterId}/notes`) });
  const [ed, setEd] = useState<null | { note?: DoctorNote; kind: NoteKind; date?: string; consultationId?: string }>(null);
  const [amend, setAmend] = useState<DoctorNote | null>(null); const [hist, setHist] = useState<DoctorNote | null>(null);
  const [consult, setConsult] = useState(false); const [old, setOld] = useState(false); const [filter, setFilter] = useState<NoteKind | ''>('');
  const icu = useIcu(encounterId);   // 0047: ICU დღიური / გაყვანის შეჯამება — ღია ეპიზოდზე, ფუნქცია „icu_note“
  const icuNotes = !!icu.data?.episode && icu.data.features.includes('icu_note');
  const cancel = useMutation({ mutationFn: (a: { id: string; reason: string }) => api(`/inpatient/consultations/${a.id}/cancel`, { body: { reason: a.reason } }), onSuccess: () => { toast.show('კონსულტაცია გაუქმდა'); inval(); } });
  if (q.isLoading) return <section className="card card-pad" id="notes"><Loading /></section>;
  if (!q.data) return <section className="card card-pad" id="notes"><ErrorBox error={q.error} /></section>;
  const d = q.data;
  const drafts = d.notes.filter((n) => n.status === 'draft' && n.author_id === user?.id);
  const signed = d.notes.filter((n) => n.status === 'signed' && (old || !n.superseded_at) && (!filter || n.kind === filter));
  const openC = d.consultations.filter((c) => c.status === 'requested');
  return (
    <section className="card" id="notes">
      {toast.node}
      <div className="card-head" style={{ flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0 }}>ექიმის ჩანაწერები</h2>
        {openC.length > 0 && <span className="chip info">კონსულტაცია მოლოდინში: {openC.length}</span>}
        <span className="grow" />
        <button className="btn sm" type="button" onClick={() => void openBlob(`/inpatient/stays/${encounterId}/notes/pdf`)}>PDF</button>
        {d.can.consult && <button className="btn sm" type="button" onClick={() => setConsult(true)}>კონსულტაცია</button>}
        {d.can.write && <>
          {!d.admission.note_id && <button className="btn sm" type="button" onClick={() => setEd({ kind: 'admission' })}>+ მიმღები გასინჯვა</button>}
          <button className="btn sm" type="button" onClick={() => setEd({ kind: 'rounds' })}>+ შემოვლა</button>
          {icuNotes && <button className="btn sm" type="button" onClick={() => setEd({ kind: 'icu_out' })}>+ გაყვანის შეჯამება</button>}
          {icuNotes ? <button className="btn sm primary" type="button" onClick={() => setEd({ kind: 'icu_daily' })}>+ ICU დღიური (A–F)</button>
            : <button className="btn sm primary" type="button" onClick={() => setEd({ kind: 'progress' })}>+ დღიური</button>}</>}
      </div>
      <div className="card-pad stack" style={{ gap: 10 }}>
        <ErrorBox error={cancel.error} />
        {!d.admission.note_id && <div className={`alert ${d.admission.overdue ? 'danger' : 'info'}`}>მიმღები გასინჯვა არ არის ხელმოწერილი{d.admission.overdue ? ' — ვადა გავიდა' : ` (ვადა: ${dt(d.admission.due_at)})`}.</div>}
        {d.missing_days.length > 0 && <div className="alert warn row" style={{ gap: 6, flexWrap: 'wrap' }}>დღიური აკლია:
          {d.missing_days.map((x) => d.can.write ? <button key={x} className="btn sm" type="button" onClick={() => setEd({ kind: 'progress', date: x })}>{dd(x)}</button> : <span key={x} className="chip">{dd(x)}</span>)}</div>}
        {drafts.length > 0 && <div className="stack" style={{ gap: 4 }}><span className="label">ჩემი შავი ვერსიები</span>
          {drafts.map((n) => <div key={n.id} className="row" style={{ gap: 8 }}><span className="chip warn">შავი ვერსია</span><span>{KIND_KA[n.kind]}{n.amends_id ? ` — შესწორება (ვ.${n.version})` : ''} · {dd(n.day)}</span>
            <span className="small muted">შენახულია {dt(n.updated_at)}</span><span className="grow" /><button className="btn sm" type="button" onClick={() => setEd({ note: n, kind: n.kind })}>გაგრძელება</button></div>)}</div>}
        {d.consultations.length > 0 && <div className="stack" style={{ gap: 4 }}><span className="label">კონსულტაციები</span>
          {d.consultations.map((c) => (
            <div key={c.id} className="row" style={{ gap: 8, flexWrap: 'wrap', borderBottom: '1px solid var(--line-soft)', paddingBottom: 4 }}>
              <span className={`chip ${CST[c.status][0]}`}>{CST[c.status][1]}</span><span className={`chip ${URG[c.urgency][0]}`}>{URG[c.urgency][1]}</span>
              <strong>{c.target_doctor_name ?? c.target_department_name}</strong>{c.target_doctor_name && c.target_department_name && <span className="small muted">{c.target_department_name}</span>}
              <span className="small grow" title={c.question}>{c.question.length > 120 ? `${c.question.slice(0, 120)}…` : c.question}</span>
              <span className="small muted">{c.status === 'requested' ? `ვადა ${dt(c.due_at)}` : c.status === 'answered' ? `${c.answered_by_name} · ${dt(c.answered_at!)}` : c.cancel_reason}</span>
              {c.status === 'requested' && c.requested_by === user?.id && <button className="btn sm" type="button" onClick={() => { const r = window.prompt('გაუქმების მიზეზი'); if (r && r.trim().length >= 3) cancel.mutate({ id: c.id, reason: r.trim() }); }}>გაუქმება</button>}
            </div>))}</div>}
        <div className="row" style={{ gap: 8 }}>
          <div className="seg" role="group" aria-label="ფილტრი" style={{ width: 'max-content', flexWrap: 'wrap' }}>
            <button type="button" aria-pressed={filter === ''} onClick={() => setFilter('')}>ყველა</button>
            {(Object.keys(KIND_KA) as NoteKind[]).map((k) => <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}>{KIND_KA[k]}</button>)}</div>
          <span className="grow" /><label className="row small"><input type="checkbox" checked={old} onChange={(e) => setOld(e.target.checked)} /> ძველი ვერსიებიც</label>
        </div>
        {!signed.length && <span className="muted">ხელმოწერილი ჩანაწერი არ არის.</span>}
        {signed.map((n) => <NoteCard key={n.id} n={n} fields={d.fields} canAmend={d.can.write || n.author_id === user?.id} onAmend={() => setAmend(n)} onHistory={() => setHist(n)} />)}
      </div>
      {ed && <NoteEditor encounterId={encounterId} kind={ed.kind} note={ed.note} date={ed.date} consultationId={ed.consultationId} fields={d.fields[ed.kind]} limits={{ min: d.admitted_day, max: d.last_day }}
        onClose={() => setEd(null)} onDone={(m) => { toast.show(m); inval(); }} />}
      {amend && <AmendDialog note={amend} onClose={() => setAmend(null)} onDone={(n) => { setAmend(null); inval(); setEd({ note: n, kind: n.kind }); }} />}
      {hist && <HistoryDialog note={hist} fields={d.fields} onClose={() => setHist(null)} />}
      {consult && <ConsultDialog encounterId={encounterId} onClose={() => setConsult(false)} onDone={(m) => { toast.show(m); inval(); }} />}
    </section>
  );
}

function NoteCard({ n, fields, canAmend, onAmend, onHistory }: { n: DoctorNote; fields: Fields; canAmend: boolean; onAmend: () => void; onHistory: () => void }) {
  return (
    <article className="card card-pad stack" style={{ gap: 6, opacity: n.superseded_at ? 0.55 : 1 }}>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <span className={`chip ${n.kind === 'admission' ? 'info' : n.kind === 'consult' ? 'warn' : ''}`}>{KIND_KA[n.kind]}</span>
        <strong>{dd(n.day)}</strong><span className="small muted">{n.author_name}{n.author_specialty ? `, ${n.author_specialty}` : ''}{n.kind === 'consult' && n.department_name ? ` · ${n.department_name}` : ''} · {dt(n.signed_at!)}</span>
        {n.version > 1 && <button type="button" className="chip" style={{ cursor: 'pointer' }} title={n.amend_reason ?? ''} onClick={onHistory}>შესწორებული · ვ.{n.version}</button>}
        {n.superseded_at && <span className="chip">შეცვლილია {dt(n.superseded_at)}</span>}
        <span className="grow" />
        {canAmend && !n.superseded_at && <button className="btn sm" type="button" onClick={onAmend}>შესწორება</button>}
      </div>
      {n.participant_names.length > 0 && <div className="small muted">მონაწილეები: {n.participant_names.join(', ')}</div>}
      {fields[n.kind].filter((f) => (n.content[f.key] ?? '').trim()).map((f) => (
        <div key={f.key}><span className="small" style={{ fontWeight: 600 }}>{f.label}</span><div style={{ whiteSpace: 'pre-wrap' }}>{n.content[f.key]}</div></div>))}
    </article>
  );
}

// ---------------------------------------------------------------- რედაქტორი
export function NoteEditor({ encounterId, kind, note, date, consultationId, fields, limits, onClose, onDone }: { encounterId: string; kind: NoteKind; note?: DoctorNote; date?: string;
  consultationId?: string; fields: { key: string; label: string; required?: boolean }[]; limits?: { min: string; max: string }; onClose: () => void; onDone: (m: string) => void }) {
  const inval = useInval();
  const [id, setId] = useState<string | null>(note?.id ?? null);
  const [c, setC] = useState<Record<string, string>>(note?.content ?? {});
  const [day, setDay] = useState(note?.day ?? date ?? (limits && todayISO() > limits.max ? limits.max : todayISO()));
  const [parts, setParts] = useState<string[]>(note?.participants ?? []);
  const [dirty, setDirty] = useState(false); const [saved, setSaved] = useState<string | null>(note ? note.updated_at : null);
  const [tplName, setTplName] = useState<string | null>(null);
  const tpls = useQuery({ queryKey: ['note-templates', kind], queryFn: () => api<Template[]>('/inpatient/note-templates', { query: { kind } }) });
  const doctors = useQuery({ queryKey: ['doctors'], queryFn: () => api<Doctor[]>('/doctors'), enabled: kind === 'rounds' });
  const save = async () => {
    if (id) { await api(`/inpatient/notes/${id}`, { method: 'PUT', body: { content: c, participants: parts, ...(!note?.amends_id && { note_date: day }) } }); }
    else {
      const r = await api<DoctorNote>(`/inpatient/stays/${encounterId}/notes`, { body: { kind, content: c, note_date: day, participants: parts, consultation_id: consultationId } });
      setId(r.id); return r.id;
    }
    return id;
  };
  const sv = useMutation({ mutationFn: save, onSuccess: () => { setDirty(false); setSaved(new Date().toISOString()); inval(); } });
  const sign = useMutation({ mutationFn: async () => { const x = await save(); return api<DoctorNote>(`/inpatient/notes/${x}/sign`, { body: {} }); },
    onSuccess: (r) => { onDone(`${KIND_KA[kind]} — ხელმოწერილია${r.billed ? ` · ინვოისში: ${r.billed.tariff} ${Number(r.billed.amount).toFixed(2)} ₾` : ''}${r.warning ? ` · ${r.warning}` : ''}`); inval(); onClose(); } });
  const discard = useMutation({ mutationFn: () => api(`/inpatient/notes/${id}`, { method: 'DELETE' }), onSuccess: () => { onDone('შავი ვერსია წაიშალა'); inval(); onClose(); } });
  const ins = useMutation({ mutationFn: () => api<{ text: string }>(`/inpatient/stays/${encounterId}/notes/insert`),
    onSuccess: (r) => { const k = INSERT_INTO[kind]!; setC((x) => ({ ...x, [k]: [x[k]?.trim(), r.text].filter(Boolean).join('\n') })); setDirty(true); } });
  // 0047: ICU — „ჩასმა“ სისტემების მიხედვით (ვენტილაცია, ვაზოპრესორები, ბალანსი, SOFA); გაყვანის შეჯამებაში — ჩატარებული
  const insIcu = useMutation({ mutationFn: () => api<Record<string, string>>(`/inpatient/stays/${encounterId}/icu/insert`),
    onSuccess: (r) => {
      setC((x) => {
        const out = { ...x };
        const put = (k: string, v: string) => { if (v?.trim()) out[k] = [out[k]?.trim(), v.trim()].filter(Boolean).join('\n'); };
        if (kind === 'icu_daily') for (const [k, v] of Object.entries(r)) put(k, v);
        else put('procedures', [r.b_breathing, r.c_circulation, r.e_exposure, r.assessment].filter(Boolean).join('\n'));
        return out;
      });
      setDirty(true);
    } });
  const saveTpl = useMutation({ mutationFn: () => api('/inpatient/note-templates', { body: { kind, name: tplName!.trim(), content: c } }),
    onSuccess: () => { setTplName(null); void tpls.refetch(); } });
  const missing = fields.filter((f) => f.required && !(c[f.key] ?? '').trim());
  const err = sign.error instanceof ApiError && sign.error.code === 'NOTE_REQUIRED' ? null : sign.error ?? sv.error ?? discard.error ?? ins.error ?? insIcu.error ?? saveTpl.error;
  const close = () => { if (dirty && !window.confirm('შენახვის გარეშე დახურვა?')) return; onClose(); };
  return (
    <Modal title={`${KIND_KA[kind]}${note?.amends_id ? ` — შესწორება (ვ.${note.version})` : ''}`} onClose={close} width={820}
      footer={<>
        {id && !note?.amends_id && <button className="btn danger" type="button" style={{ marginRight: 'auto' }} onClick={() => window.confirm('შავი ვერსიის წაშლა?') && discard.mutate()}>წაშლა</button>}
        {id && note?.amends_id && <button className="btn" type="button" style={{ marginRight: 'auto' }} onClick={() => window.confirm('შესწორების გაუქმება?') && discard.mutate()}>შესწორების გაუქმება</button>}
        <span className="small muted">{saved ? `შენახულია ${hhmm(saved)}` : 'არ არის შენახული'}{dirty ? ' · ცვლილებები' : ''}</span>
        <button className="btn" type="button" disabled={sv.isPending} onClick={() => sv.mutate()}>შავად შენახვა</button>
        <button className="btn primary" type="button" disabled={missing.length > 0 || sign.isPending} title={missing.length ? `შეავსეთ: ${missing.map((f) => f.label).join(', ')}` : ''} onClick={() => sign.mutate()}>ხელმოწერა</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        {note?.amend_reason && <div className="alert info">შესწორების მიზეზი: {note.amend_reason}</div>}
        <div className="row" style={{ gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          {kind !== 'consult' && <Field label="თარიღი" htmlFor="ne-d"><input id="ne-d" className="input" type="date" value={day} min={limits?.min} max={limits?.max} disabled={!!note?.amends_id}
            onChange={(e) => { setDay(e.target.value); setDirty(true); }} /></Field>}
          <Field label="შაბლონი" htmlFor="ne-t"><select id="ne-t" className="select" value="" onChange={(e) => { const t = tpls.data?.find((x) => x.id === e.target.value); if (t) { setC((x) => ({ ...x, ...Object.fromEntries(Object.entries(t.content).filter(([, v]) => v)) })); setDirty(true); } }}>
            <option value="">— აირჩიეთ —</option>{tpls.data?.map((t) => <option key={t.id} value={t.id}>{t.name}{t.department_name ? ` (${t.department_name})` : ''}</option>)}</select></Field>
          {INSERT_INTO[kind] && <button className="btn sm" type="button" disabled={ins.isPending} onClick={() => ins.mutate()} title="ბოლო ვიტალები, NEWS2, ბალანსი, ბოლო 24 სთ-ის კვლევები, აქტიური მკურნალობა">ჩასმა: ვიტალები / კვლევები / მკურნალობა</button>}
          {(kind === 'icu_daily' || kind === 'icu_out') && <button className="btn sm" type="button" disabled={insIcu.isPending} onClick={() => insIcu.mutate()} title="ვენტილაცია, ABG, ჰემოდინამიკა, ვაზოპრესორები, GCS / RASS, ხაზები, ბალანსი, SOFA">ჩასმა: ICU მონაცემები</button>}
          <span className="grow" />
          {tplName === null ? <button className="btn sm" type="button" onClick={() => setTplName('')}>შაბლონად შენახვა</button>
            : <div className="row" style={{ gap: 6 }}><input className="input" style={{ maxWidth: 200 }} aria-label="შაბლონის სახელი" placeholder="სახელი" value={tplName} onChange={(e) => setTplName(e.target.value)} />
              <button className="btn sm" type="button" disabled={tplName.trim().length < 2 || saveTpl.isPending} onClick={() => saveTpl.mutate()}>შენახვა</button>
              <button className="btn sm" type="button" onClick={() => setTplName(null)}>×</button></div>}
        </div>
        {kind === 'rounds' && <Field label="მონაწილეები" htmlFor="ne-p" hint="Ctrl / Shift — რამდენიმე"><select id="ne-p" className="select" multiple size={5} value={parts}
          onChange={(e) => { setParts([...e.target.selectedOptions].map((o) => o.value)); setDirty(true); }} style={{ height: 'auto' }}>
          {doctors.data?.map((x) => <option key={x.id} value={x.id}>{x.last_name} {x.first_name}{x.department_name ? ` · ${x.department_name}` : ''}</option>)}</select></Field>}
        {fields.map((f) => (
          <Field key={f.key} label={f.label} htmlFor={`ne-${f.key}`} required={f.required}>
            <textarea id={`ne-${f.key}`} className="textarea" rows={f.key === 'o' || f.key === 'objective' || f.key === 'anamnesis_morbi' ? 5 : 3} value={c[f.key] ?? ''}
              onChange={(e) => { setC({ ...c, [f.key]: e.target.value }); setDirty(true); }} onBlur={() => { if (dirty && id) sv.mutate(); }} /></Field>))}
        {sign.error instanceof ApiError && sign.error.code === 'NOTE_REQUIRED' && <div className="alert danger">{sign.error.message}</div>}
        <ErrorBox error={err} />
      </div>
    </Modal>
  );
}

function AmendDialog({ note, onClose, onDone }: { note: DoctorNote; onClose: () => void; onDone: (n: DoctorNote) => void }) {
  const [reason, setReason] = useState('');
  const m = useMutation({ mutationFn: () => api<DoctorNote>(`/inpatient/notes/${note.id}/amend`, { body: { reason: reason.trim() } }), onSuccess: onDone });
  return (
    <Modal title={`შესწორება — ${KIND_KA[note.kind]} ${dd(note.day)}`} onClose={onClose} width={520}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={reason.trim().length < 3 || m.isPending} onClick={() => m.mutate()}>გაგრძელება</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <span className="small muted">შეიქმნება ახალი ვერსია (ვ.{note.version + 1}) — ხელმოწერამდე მოქმედებს ძველი; ძველი ვერსია ისტორიაში რჩება.</span>
        <Field label="მიზეზი" htmlFor="am-r" required><textarea id="am-r" className="textarea" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}
function HistoryDialog({ note, fields, onClose }: { note: DoctorNote; fields: Fields; onClose: () => void }) {
  const q = useQuery({ queryKey: ['note-history', note.id], queryFn: () => api<DoctorNote[]>(`/inpatient/notes/${note.id}/history`) });
  return (
    <Modal title={`ვერსიები — ${KIND_KA[note.kind]} ${dd(note.day)}`} onClose={onClose} width={820}>
      {q.isLoading ? <Loading /> : <div className="stack" style={{ gap: 10 }}>{(q.data ?? []).map((n) => (
        <div key={n.id} className="stack" style={{ gap: 4 }}><div className="small"><strong>ვ.{n.version}</strong> · {n.author_name} · {dt(n.signed_at!)}{n.amend_reason ? ` · მიზეზი: ${n.amend_reason}` : ''}</div>
          <NoteCard n={n} fields={fields} canAmend={false} onAmend={() => undefined} onHistory={() => undefined} /></div>))}</div>}
    </Modal>
  );
}

// ---------------------------------------------------------------- კონსულტაცია
function ConsultDialog({ encounterId, onClose, onDone }: { encounterId: string; onClose: () => void; onDone: (m: string) => void }) {
  const deps = useQuery({ queryKey: ['departments'], queryFn: () => api<Department[]>('/departments') });
  const doctors = useQuery({ queryKey: ['doctors'], queryFn: () => api<Doctor[]>('/doctors') });
  const [dep, setDep] = useState(''); const [doc, setDoc] = useState(''); const [urg, setUrg] = useState<'routine' | 'urgent' | 'emergency'>('routine'); const [q, setQ] = useState('');
  const m = useMutation({ mutationFn: () => api(`/inpatient/stays/${encounterId}/consultations`, { body: { target_department_id: dep || undefined, target_doctor_id: doc || undefined, urgency: urg, question: q.trim() } }),
    onSuccess: () => { onDone('კონსულტაცია მოთხოვნილია'); onClose(); } });
  return (
    <Modal title="კონსულტაციის მოთხოვნა" onClose={onClose} width={620}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={(!dep && !doc) || q.trim().length < 3 || m.isPending} onClick={() => m.mutate()}>მოთხოვნა</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="განყოფილება / სპეციალობა" htmlFor="cq-d"><select id="cq-d" className="select" value={dep} onChange={(e) => { setDep(e.target.value); setDoc(''); }}>
            <option value="">—</option>{deps.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
          <Field label="ექიმი (არასავალდებულო)" htmlFor="cq-x" hint="მითითებისას — მხოლოდ მას ეგზავნება"><select id="cq-x" className="select" value={doc} onChange={(e) => setDoc(e.target.value)}>
            <option value="">— განყოფილების ნებისმიერი ექიმი —</option>{doctors.data?.filter((x) => !dep || x.department_id === dep).map((x) => <option key={x.id} value={x.id}>{x.last_name} {x.first_name}{x.specialty ? ` · ${x.specialty}` : ''}</option>)}</select></Field>
        </div>
        <div className="seg" role="group" aria-label="სასწრაფოობა" style={{ width: 'max-content' }}>
          {(['routine', 'urgent', 'emergency'] as const).map((k) => <button key={k} type="button" aria-pressed={urg === k} onClick={() => setUrg(k)}>{URG[k][1]}</button>)}</div>
        <Field label="კითხვა / მიზეზი" htmlFor="cq-q" required><textarea id="cq-q" className="textarea" rows={4} value={q} onChange={(e) => setQ(e.target.value)} /></Field>
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}

/** სტაციონარი → კონსულტაციები: ჩემთვის / ჩემი განყოფილებისთვის */
export function ConsultInbox() {
  const q = useQuery({ queryKey: ['consult-inbox'], queryFn: () => api<Consultation[]>('/inpatient/consultations/inbox'), refetchInterval: 60_000 });
  const toast = useToast(); const [ans, setAns] = useState<Consultation | null>(null);
  const draft = useQuery({ queryKey: ['consult-draft', ans?.my_draft_id], queryFn: () => api<DoctorNote>(`/inpatient/notes/${ans!.my_draft_id}`), enabled: !!ans?.my_draft_id });
  if (q.isLoading) return <Loading />;
  if (!q.data) return <ErrorBox error={q.error} />;
  return (
    <div className="stack" style={{ gap: 12 }}>
      {toast.node}
      {!q.data.length && <div className="card empty">კონსულტაციის მოთხოვნა არ არის.</div>}
      {q.data.length > 0 && <div className="card"><table className="table"><tbody>{q.data.map((c) => (
        <tr key={c.id} style={{ opacity: c.status === 'requested' ? 1 : 0.65 }}>
          <td style={{ width: 130 }}><span className={`chip ${URG[c.urgency][0]}`}>{URG[c.urgency][1]}</span><div className="small muted" style={{ marginTop: 4 }}>{c.status === 'requested' ? `ვადა ${dt(c.due_at)}` : CST[c.status][1]}</div>
            {c.status === 'requested' && new Date(c.due_at) < new Date() && <span className="chip danger">ვადაგადაცილებული</span>}</td>
          <td><Link to={`/inpatient/stay/${c.encounter_id}#notes`}><strong>{c.last_name} {c.first_name}</strong></Link> <span className="small muted mono">{c.adm_no}</span>
            <div className="small muted">{c.patient_department}{c.bed_code ? ` · ${c.bed_code}` : ''} · ითხოვს: {c.requested_by_name}{c.target_doctor_name ? ` → ${c.target_doctor_name}` : ''}</div>
            <div style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{c.question}</div></td>
          <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{c.status === 'requested' ? <button className="btn sm primary" type="button" onClick={() => setAns(c)}>{c.my_draft_id ? 'პასუხი (გაგრძელება)' : 'პასუხი'}</button>
            : c.answered_by_name && <span className="small muted">{c.answered_by_name}</span>}</td>
        </tr>))}</tbody></table></div>}
      {ans && (!ans.my_draft_id || draft.data) && <NoteEditor encounterId={ans.encounter_id} kind="consult" consultationId={ans.id} fields={CONSULT_FIELDS}
        note={ans.my_draft_id ? draft.data : undefined} onClose={() => setAns(null)} onDone={(m) => { toast.show(m); void q.refetch(); }} />}
    </div>
  );
}
