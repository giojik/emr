import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, apiUpload, openBlob } from '../../api/client';
import { ErrorBox, Field, Loading, useToast } from '../../components/ui';
import { dateGe, hhmm, todayISO, tsDate } from '../../lib/format';
import { CapaDialog, PersonPick } from './Investigation';
import { CAPA_EVENT_KA, CAPA_KIND_KA, CAPA_ST, STATUS_UI, type CapaDetail } from './types';

const when = (ts: string) => `${tsDate(ts)} ${hhmm(ts)}`;

/** CAPA ბარათი: დეტალები, ინციდენტ(ებ)ის შეჯამება, შესრულება მტკიცებულებით, ვადის შეცვლა, ეფექტიანობა, ისტორია */
export default function CapaCard() {
  const { id } = useParams(); const nav = useNavigate(); const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['qm-capa', id], queryFn: () => api<CapaDetail>(`/quality/capas/${id}`) });
  if (q.isLoading) return <div className="content"><Loading /></div>;
  if (q.error || !q.data) return <div className="content"><ErrorBox error={q.error} /><button className="btn" type="button" onClick={() => nav('/quality?tab=work')}>←</button></div>;
  const c = q.data;
  const done = (r: CapaDetail, m: string) => { qc.setQueryData(['qm-capa', id], r); toast.show(m); for (const k of ['qm-capas', 'qm-work', 'qm-incident']) void qc.invalidateQueries({ queryKey: [k] }); };
  return (
    <>
      {toast.node}
      <header className="topbar">
        <button className="btn sm" type="button" onClick={() => nav(-1)}>←</button>
        <h1 className="mono" style={{ margin: 0 }}>{c.capa_no}</h1>
        <span className={`chip ${CAPA_ST[c.status][0]}`}>{CAPA_ST[c.status][1]}</span>
        {c.overdue && <span className="chip danger">ვადა გადაცილებულია</span>}
        {c.effectiveness_result && <span className={`chip ${c.effectiveness_result === 'effective' ? 'ok' : 'danger'}`}>{c.effectiveness_result === 'effective' ? 'ეფექტიანი' : 'არაეფექტიანი'}</span>}
      </header>
      <div className="content" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.25fr) minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
        <div className="stack">
          <section className="card card-pad stack" style={{ gap: 10 }}>
            <h2 style={{ margin: 0, fontSize: 18 }}>{c.title}</h2>
            {c.description && <div style={{ whiteSpace: 'pre-wrap' }}>{c.description}</div>}
            <div className="small" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '8px 16px' }}>
              <Kv k="ტიპი" v={CAPA_KIND_KA[c.kind]} /><Kv k="პასუხისმგებელი" v={c.owner_name} />
              <Kv k="ვადა" v={dateGe(c.due_date)} /><Kv k="განყოფილება" v={c.department_name ?? '—'} />
              <Kv k="შექმნა" v={`${when(c.created_at)} · ${c.created_by_name}`} />
              {c.started_at && <Kv k="დაიწყო" v={when(c.started_at)} />}
              {c.follow_up_of && <Kv k="წინა (არაეფექტიანი) ქმედება" v={<Link to={`/quality/capas/${c.follow_up_of}`} className="mono">{c.follow_up_of_no}</Link>} />}
              {c.done_at && <Kv k="შესრულდა" v={`${when(c.done_at)} · ${c.done_by_name ?? ''}`} />}
              {c.effectiveness_due && <Kv k="ეფექტიანობის შემოწმება" v={c.effectiveness_at ? `${when(c.effectiveness_at)} · ${c.effectiveness_by_name ?? ''}` : `ვადა ${dateGe(c.effectiveness_due)}`} />}
            </div>
            {c.done_note && <div><div className="small muted">შესრულება</div><div style={{ whiteSpace: 'pre-wrap' }}>{c.done_note}</div></div>}
            {c.effectiveness_note && <div><div className="small muted">ეფექტიანობა</div><div style={{ whiteSpace: 'pre-wrap' }}>{c.effectiveness_note}</div></div>}
            {c.cancel_reason && <div className="alert">გაუქმდა: {c.cancel_reason}</div>}
          </section>
          <section className="card card-pad stack" style={{ gap: 6 }}>
            <strong className="small">ინციდენტ(ებ)ი</strong>
            {c.incidents.map((i) => (
              <div key={i.id} className="stack" style={{ gap: 2, borderLeft: '3px solid var(--line)', paddingLeft: 10 }}>
                <div className="row small">{c.access === 'owner' ? <span className="mono">{i.inc_no}</span> : <Link to={`/quality/incidents/${i.id}`} className="mono">{i.inc_no}</Link>}
                  <span className={`chip ${STATUS_UI[i.status][0]}`} style={{ height: 20 }}>{STATUS_UI[i.status][1]}</span><span className="muted">{i.category_name} · {i.department_name} · {tsDate(i.occurred_at)}</span></div>
                {i.root_cause && <span className="small"><span className="muted">ძირეული მიზეზი:</span> {i.root_cause}</span>}
              </div>))}
            {c.access === 'owner' && <span className="small muted">ინციდენტის დეტალები (პაციენტი, ავტორი, აღწერა) პასუხისმგებელს არ ჩანს.</span>}
          </section>
          <Files c={c} onDone={() => void q.refetch()} />
          <section className="card card-pad stack" style={{ gap: 6 }}>
            <strong className="small">ისტორია</strong>
            {[...c.events].reverse().map((e) => (
              <div key={e.id} className="stack" style={{ gap: 1, borderLeft: '3px solid var(--line)', paddingLeft: 10 }}>
                <span className="small"><strong>{CAPA_EVENT_KA[e.kind] ?? e.kind}</strong> <span className="muted">· {when(e.at)}{e.user_name ? ` · ${e.user_name}` : ''}</span></span>
                {(e.kind === 'due_requested' || e.kind === 'due_approved' || e.kind === 'due_rejected') && e.data && <span className="small muted">{dateGe(String(e.data.from))} → {dateGe(String(e.data.to))}</span>}
                {e.kind === 'effectiveness' && e.data && <span className="small muted">{e.data.result === 'effective' ? 'ეფექტიანი' : 'არაეფექტიანი'}</span>}
                {e.text && <span style={{ whiteSpace: 'pre-wrap' }}>{e.text}</span>}
              </div>))}
          </section>
        </div>
        <div className="stack">
          {(c.can.start || c.can.complete) && <OwnerActions c={c} onDone={done} />}
          {c.can.edit && <EditPanel c={c} onDone={done} />}
          <DuePanel c={c} onDone={done} />
          {c.can.effectiveness && <Effectiveness c={c} onDone={done} />}
          {c.effectiveness_result === 'ineffective' && c.access !== 'owner' && <FollowUp c={c} />}
          {c.can.cancel && <Cancel c={c} onDone={done} />}
        </div>
      </div>
    </>
  );
}
const Kv = ({ k, v }: { k: string; v: React.ReactNode }) => <div><div className="muted">{k}</div><div>{v}</div></div>;

function OwnerActions({ c, onDone }: { c: CapaDetail; onDone: (r: CapaDetail, m: string) => void }) {
  const [note, setNote] = useState(''); const [files, setFiles] = useState<File[]>([]);
  const start = useMutation({ mutationFn: () => api<CapaDetail>(`/quality/capas/${c.id}/start`, { body: {} }), onSuccess: (r) => onDone(r, 'შესრულება დაიწყო') });
  const done = useMutation({ mutationFn: () => { const fd = new FormData(); fd.append('note', note.trim()); for (const f of files) fd.append('files', f); return apiUpload<CapaDetail>(`/quality/capas/${c.id}/complete`, fd); },
    onSuccess: (r) => { setNote(''); setFiles([]); onDone(r, 'ქმედება შესრულებულია'); } });
  return (
    <section className="card card-pad stack" style={{ gap: 8 }}>
      <h2 style={{ margin: 0, fontSize: 16 }}>შესრულება</h2>
      {c.can.start && <button className="btn" type="button" disabled={start.isPending} onClick={() => start.mutate()}>დაწყება</button>}
      {c.can.complete && <>
        <Field label="რა გაკეთდა (სავალდებულო)" htmlFor="cd-n"><textarea id="cd-n" className="textarea" rows={3} maxLength={4000} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <Field label="მტკიცებულება (ფოტო / PDF, ≤ 5)" htmlFor="cd-f"><input id="cd-f" type="file" multiple accept="image/jpeg,image/png,application/pdf" onChange={(e) => setFiles(Array.from(e.target.files ?? []).slice(0, 5))} /></Field>
        <div className="row"><span className="grow" /><button className="btn primary" type="button" disabled={note.trim().length < 3 || done.isPending} onClick={() => done.mutate()}>შესრულებულია</button></div>
      </>}
      <ErrorBox error={start.error ?? done.error} />
    </section>
  );
}

function EditPanel({ c, onDone }: { c: CapaDetail; onDone: (r: CapaDetail, m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ title: c.title, description: c.description ?? '', due_date: c.due_date.slice(0, 10), reason: '' });
  const [owner, setOwner] = useState<{ id: string; name: string } | null>(null);
  const dueChanged = f.due_date !== c.due_date.slice(0, 10);
  const save = useMutation({
    mutationFn: () => api<CapaDetail>(`/quality/capas/${c.id}`, { method: 'PATCH', body: { title: f.title.trim(), description: f.description.trim() || null, due_date: f.due_date,
      ...(owner && { owner_id: owner.id }), ...(f.reason.trim() && { reason: f.reason.trim() }) } }),
    onSuccess: (r) => { setOpen(false); setOwner(null); onDone(r, 'შენახულია'); },
  });
  if (!open) return <button className="btn" type="button" onClick={() => setOpen(true)}>რედაქტირება (ქმედება, ვადა, პასუხისმგებელი)</button>;
  return (
    <section className="card card-pad stack" style={{ gap: 8 }}>
      <Field label="ქმედება" htmlFor="ce-t"><input id="ce-t" className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
      <Field label="აღწერა" htmlFor="ce-d"><textarea id="ce-d" className="textarea" rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      <Field label="ვადა" htmlFor="ce-due"><input id="ce-due" className="input" type="date" min={todayISO()} value={f.due_date} onChange={(e) => setF({ ...f, due_date: e.target.value })} /></Field>
      {dueChanged && <input className="input" aria-label="ვადის შეცვლის მიზეზი" placeholder="ვადის შეცვლის მიზეზი (სავალდებულო)" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />}
      <Field label={`პასუხისმგებელი (ახლა: ${c.owner_name})`} htmlFor="ce-o"><PersonPick value={owner} onChange={setOwner} label="ახალი პასუხისმგებელი" /></Field>
      <div className="row"><span className="grow" /><button className="btn" type="button" onClick={() => setOpen(false)}>გაუქმება</button>
        <button className="btn primary" type="button" disabled={save.isPending || f.title.trim().length < 5 || (dueChanged && f.reason.trim().length < 3)} onClick={() => save.mutate()}>შენახვა</button></div>
      <ErrorBox error={save.error} />
    </section>
  );
}

function DuePanel({ c, onDone }: { c: CapaDetail; onDone: (r: CapaDetail, m: string) => void }) {
  const [f, setF] = useState({ new_due: '', reason: '' }); const [note, setNote] = useState('');
  const req = useMutation({ mutationFn: () => api<CapaDetail>(`/quality/capas/${c.id}/due-requests`, { body: f }), onSuccess: (r) => { setF({ new_due: '', reason: '' }); onDone(r, 'მოთხოვნა გაიგზავნა'); } });
  const decide = useMutation({ mutationFn: (p: { rid: string; approve: boolean }) => api<CapaDetail>(`/quality/capas/${c.id}/due-requests/${p.rid}/decide`, { body: { approve: p.approve, note: note.trim() || undefined } }),
    onSuccess: (r) => { setNote(''); onDone(r, 'გადაწყვეტილება შენახულია'); } });
  const pending = c.requests.find((r) => r.status === 'pending');
  if (!c.can.request_due && !pending && !c.requests.length) return null;
  return (
    <section className="card card-pad stack" style={{ gap: 8 }}>
      <h2 style={{ margin: 0, fontSize: 16 }}>ვადის შეცვლა</h2>
      {pending && <div className="alert warn"><div className="stack" style={{ gap: 4 }}>
        <span>{pending.requested_by_name} ითხოვს: {dateGe(pending.old_due)} → <strong>{dateGe(pending.new_due)}</strong></span><span>{pending.reason}</span>
        {c.can.decide_due && <><input className="input" aria-label="შენიშვნა" placeholder="შენიშვნა (უარზე — სავალდებულო)" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="row"><button className="btn sm primary" type="button" disabled={decide.isPending} onClick={() => decide.mutate({ rid: pending.id, approve: true })}>დამტკიცება</button>
            <button className="btn sm" type="button" disabled={decide.isPending || note.trim().length < 3} onClick={() => decide.mutate({ rid: pending.id, approve: false })}>უარი</button></div></>}
      </div></div>}
      {c.can.request_due && <div className="stack" style={{ gap: 6 }}>
        <div className="row" style={{ gap: 6 }}><input className="input" type="date" style={{ maxWidth: 180 }} aria-label="ახალი ვადა" min={todayISO()} value={f.new_due} onChange={(e) => setF({ ...f, new_due: e.target.value })} />
          <input className="input grow" aria-label="მიზეზი" placeholder="მიზეზი" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></div>
        <div className="row"><span className="grow" /><button className="btn sm" type="button" disabled={!f.new_due || f.reason.trim().length < 3 || req.isPending} onClick={() => req.mutate()}>მოთხოვნა</button></div>
      </div>}
      {c.requests.filter((r) => r.status !== 'pending').map((r) => <span key={r.id} className="small muted">{tsDate(r.requested_at)}: {dateGe(r.old_due)} → {dateGe(r.new_due)} — {r.status === 'approved' ? 'დამტკიცდა' : 'უარი'}{r.decision_note ? ` (${r.decision_note})` : ''}</span>)}
      <ErrorBox error={req.error ?? decide.error} />
    </section>
  );
}

function Effectiveness({ c, onDone }: { c: CapaDetail; onDone: (r: CapaDetail, m: string) => void }) {
  const [f, setF] = useState({ result: 'effective', note: '' });
  const save = useMutation({ mutationFn: () => api<CapaDetail>(`/quality/capas/${c.id}/effectiveness`, { body: f }), onSuccess: (r) => onDone(r, 'ეფექტიანობა შეფასდა') });
  return (
    <section className="card card-pad stack" style={{ gap: 8 }}>
      <h2 style={{ margin: 0, fontSize: 16 }}>ეფექტიანობის შემოწმება{c.effectiveness_due ? ` (ვადა ${dateGe(c.effectiveness_due)})` : ''}</h2>
      <div className="seg" role="group" aria-label="შედეგი"><button type="button" aria-pressed={f.result === 'effective'} onClick={() => setF({ ...f, result: 'effective' })}>ეფექტიანი</button>
        <button type="button" aria-pressed={f.result === 'ineffective'} onClick={() => setF({ ...f, result: 'ineffective' })}>არაეფექტიანი</button></div>
      <textarea className="textarea" rows={2} aria-label="შენიშვნა" placeholder="როგორ შემოწმდა, რა აჩვენა (სავალდებულო)" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
      <div className="row"><span className="grow" /><button className="btn primary" type="button" disabled={f.note.trim().length < 3 || save.isPending} onClick={() => save.mutate()}>შენახვა</button></div>
      <ErrorBox error={save.error} />
    </section>
  );
}

function FollowUp({ c }: { c: CapaDetail }) {
  const nav = useNavigate(); const [dlg, setDlg] = useState(false);
  return (
    <section className="card card-pad stack" style={{ gap: 6 }}>
      <span className="small">ქმედება არაეფექტიანი აღმოჩნდა — შეიძლება ახალი ქმედების დანიშვნა (იმავე ინციდენტებზე).</span>
      <button className="btn" type="button" onClick={() => setDlg(true)}>+ ახალი ქმედება</button>
      {dlg && <CapaDialog incidentIds={c.incidents.filter((i) => ['investigation', 'analysis', 'capa'].includes(i.status)).map((i) => i.id)} followUp={c.id} initial={{ kind: c.kind }}
        onClose={() => setDlg(false)} onDone={(id) => { setDlg(false); nav(`/quality/capas/${id}`); }} />}
    </section>
  );
}

function Cancel({ c, onDone }: { c: CapaDetail; onDone: (r: CapaDetail, m: string) => void }) {
  const [reason, setReason] = useState('');
  const save = useMutation({ mutationFn: () => api<CapaDetail>(`/quality/capas/${c.id}/cancel`, { body: { reason: reason.trim() } }), onSuccess: (r) => onDone(r, 'ქმედება გაუქმდა') });
  return (
    <section className="card card-pad stack" style={{ gap: 6 }}>
      <div className="row" style={{ gap: 6 }}><input className="input grow" aria-label="გაუქმების მიზეზი" placeholder="გაუქმების მიზეზი" value={reason} onChange={(e) => setReason(e.target.value)} />
        <button className="btn danger" type="button" disabled={reason.trim().length < 3 || save.isPending} onClick={() => save.mutate()}>გაუქმება</button></div>
      <ErrorBox error={save.error} />
    </section>
  );
}

function Files({ c, onDone }: { c: CapaDetail; onDone: () => void }) {
  const up = useMutation({ mutationFn: (fs: File[]) => { const fd = new FormData(); for (const f of fs) fd.append('files', f); return apiUpload(`/quality/capas/${c.id}/files`, fd); }, onSuccess: onDone });
  const open = useMutation({ mutationFn: (fid: string) => openBlob(`/quality/capas/${c.id}/files/${fid}`) });
  if (!c.files.length && !c.can.upload) return null;
  return (
    <section className="card card-pad stack" style={{ gap: 6 }}>
      <div className="row"><strong className="small grow">მტკიცებულება / ფაილები ({c.files.length})</strong>
        {c.can.upload && <label className="btn sm">+ ფაილი<input type="file" multiple hidden accept="image/jpeg,image/png,application/pdf" onChange={(e) => { const fs = Array.from(e.target.files ?? []).slice(0, 5); if (fs.length) up.mutate(fs); e.target.value = ''; }} /></label>}</div>
      {c.files.map((f) => <button key={f.id} type="button" className="btn sm" style={{ justifyContent: 'flex-start' }} onClick={() => open.mutate(f.id)}>
        {f.mime_type === 'application/pdf' ? 'PDF' : 'სურათი'} · {f.original_name ?? f.id.slice(0, 8)} <span className="muted">· {Math.round(f.size_bytes / 1024)} KB · {tsDate(f.created_at)}</span></button>)}
      <ErrorBox error={up.error ?? open.error} />
    </section>
  );
}
