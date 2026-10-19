import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { ErrorBox, Field, Modal, useDebounced } from '../../components/ui';
import { dateGe, hhmm, todayISO, tsDate } from '../../lib/format';
import {
  ANALYSIS_ST, CAPA_KIND_KA, CAPA_ST, LEVEL_KA, METHOD_KA,
  type Analysis, type Classifier, type Incident, type QmMeta,
} from './types';

const when = (ts: string) => `${tsDate(ts)} ${hhmm(ts)}`;
const localNow = () => `${todayISO()}T${hhmm(new Date().toISOString())}`;
interface PersonHit { id: string; name: string; department_name: string | null }

/** თანამშრომლის არჩევა (/quality/people) */
export function PersonPick({ value, onChange, label = 'თანამშრომელი', exclude = [] }: { value: { id: string; name: string } | null; onChange: (p: { id: string; name: string } | null) => void; label?: string; exclude?: string[] }) {
  const [q, setQ] = useState(''); const dq = useDebounced(q.trim(), 250);
  const hits = useQuery({ queryKey: ['qm-people', dq], queryFn: () => api<PersonHit[]>('/quality/people', { query: { search: dq } }), enabled: dq.length >= 2 });
  if (value) return <div className="row small"><strong>{value.name}</strong><button className="btn sm" type="button" onClick={() => onChange(null)}>შეცვლა</button></div>;
  return (
    <div className="stack" style={{ gap: 4 }}>
      <input className="input" aria-label={label} placeholder={`${label}: სახელი, გვარი`} value={q} onChange={(e) => setQ(e.target.value)} />
      {dq.length >= 2 && <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>{hits.data?.filter((h) => !exclude.includes(h.id)).slice(0, 8).map((h) =>
        <button key={h.id} className="btn sm" type="button" onClick={() => { onChange({ id: h.id, name: h.name }); setQ(''); }}>{h.name}{h.department_name ? ` · ${h.department_name}` : ''}</button>)}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- გამოძიება: გამომძიებელი, დონე, ვადა
export function InvestigationPanel({ d, onDone }: { d: Incident; onDone: (r: Incident, m: string) => void }) {
  const [inv, setInv] = useState<{ id: string; name: string } | null>(null);
  const [edit, setEdit] = useState(false); const [lvlReason, setLvlReason] = useState('');
  const save = useMutation({ mutationFn: (uid: string | null) => api<Incident>(`/quality/incidents/${d.id}/investigator`, { body: { user_id: uid } }), onSuccess: (r) => { setEdit(false); setInv(null); onDone(r, 'გამომძიებელი შენახულია'); } });
  const lvl = useMutation({ mutationFn: (level: string) => api<Incident>(`/quality/incidents/${d.id}/level`, { body: { level, reason: lvlReason.trim() || undefined } }), onSuccess: (r) => { setLvlReason(''); onDone(r, 'დონე შეიცვალა'); } });
  const other = d.analysis_level === 'rca' ? 'review' : 'rca';
  return (
    <section className="card card-pad stack" style={{ gap: 8 }}>
      <h2 style={{ margin: 0, fontSize: 16 }}>გამოძიება</h2>
      <div className="row small" style={{ flexWrap: 'wrap' }}>
        <span className="muted">დონე:</span><strong>{d.analysis_level ? LEVEL_KA[d.analysis_level] : '—'}</strong>
        {d.analysis_due_at && <><span className="muted">· ვადა:</span><span className={d.analysis_overdue ? 'chip danger' : ''}>{tsDate(d.analysis_due_at)}</span></>}
      </div>
      <div className="row small"><span className="muted">გამომძიებელი:</span><strong>{d.investigator_name ?? '—'}</strong>
        {['investigation', 'analysis', 'capa'].includes(d.status) && !edit && <button className="btn sm" type="button" onClick={() => setEdit(true)}>{d.investigator_id ? 'შეცვლა' : 'დანიშვნა'}</button>}</div>
      {edit && <div className="stack" style={{ gap: 6 }}>
        <PersonPick value={inv} onChange={setInv} label="გამომძიებელი" />
        <div className="row"><span className="grow" />{d.investigator_id && <button className="btn sm" type="button" onClick={() => save.mutate(null)}>მოხსნა</button>}
          <button className="btn sm" type="button" onClick={() => { setEdit(false); setInv(null); }}>გაუქმება</button>
          <button className="btn sm primary" type="button" disabled={!inv || save.isPending} onClick={() => save.mutate(inv!.id)}>შენახვა</button></div>
      </div>}
      {d.status === 'investigation' && d.analysis_level && (
        <div className="row small" style={{ flexWrap: 'wrap', gap: 6 }}>
          {other === 'review' && <input className="input" style={{ height: 32, maxWidth: 260 }} aria-label="დაწევის მიზეზი" placeholder="დაწევის მიზეზი (სავალდებულო)" value={lvlReason} onChange={(e) => setLvlReason(e.target.value)} />}
          <button className="btn sm" type="button" disabled={lvl.isPending || (other === 'review' && lvlReason.trim().length < 3) || (other === 'review' && d.is_sentinel)}
            onClick={() => lvl.mutate(other)}>{other === 'rca' ? '↑ RCA-ზე აწევა' : '↓ მიმოხილვაზე დაწევა'}</button>
          {other === 'review' && d.is_sentinel && <span className="muted">სენტინელურზე RCA სავალდებულოა</span>}
        </div>)}
      <ErrorBox error={save.error ?? lvl.error} />
    </section>
  );
}

// ---------------------------------------------------------------- ანალიზი (რედაქტორი / ნახვა)
interface Draft { what_happened: string; root_cause: string; action_taken: string; whys: string[]; root_causes: string; conclusion: string;
  timeline: { at: string; text: string }[]; factors: { factor_id: string; comment: string }[]; team: { user_id: string; name: string; role_text: string }[] }
const toLocal = (ts: string | null) => (ts ? `${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tbilisi' }).format(new Date(ts))}T${hhmm(ts)}` : '');
const draftOf = (a: Analysis | null): Draft => ({
  what_happened: a?.what_happened ?? '', root_cause: a?.root_cause ?? '', action_taken: a?.action_taken ?? '', whys: a?.whys?.length ? [...a.whys] : [''],
  root_causes: a?.root_causes ?? '', conclusion: a?.conclusion ?? '',
  timeline: (a?.timeline ?? []).map((t) => ({ at: toLocal(t.at), text: t.text })), factors: (a?.factors ?? []).map((f) => ({ factor_id: f.factor_id, comment: f.comment ?? '' })),
  team: (a?.team ?? []).map((m) => ({ user_id: m.user_id, name: m.name, role_text: m.role_text ?? '' })),
});

export function AnalysisSection({ d, onDone }: { d: Incident; onDone: (r: Incident, m: string) => void }) {
  const a = d.analysis; const level = d.analysis_level ?? a?.level ?? 'review';
  const [edit, setEdit] = useState(false);
  if (!d.can.edit_analysis || !edit) return <AnalysisView d={d} a={a} level={level} onEdit={d.can.edit_analysis ? () => setEdit(true) : undefined} onDone={onDone} />;
  return <AnalysisEditor d={d} a={a} level={level} onClose={() => setEdit(false)} onDone={onDone} />;
}

function AnalysisView({ d, a, level, onEdit, onDone }: { d: Incident; a: Analysis | null; level: string; onEdit?: () => void; onDone: (r: Incident, m: string) => void }) {
  const submit = useMutation({ mutationFn: () => api<Incident>(`/quality/incidents/${d.id}/analysis/submit`, { body: {} }), onSuccess: (r) => onDone(r, 'ანალიზი გაიგზავნა') });
  const empty = !a || (!a.what_happened && !a.root_cause && !a.root_causes && !a.timeline.length && !a.factors.length);
  return (
    <section className="card card-pad stack" style={{ gap: 10 }}>
      <div className="row"><h2 className="grow" style={{ margin: 0, fontSize: 16 }}>ანალიზი — {LEVEL_KA[level]}</h2>
        {a && <span className={`chip ${ANALYSIS_ST[a.status][0]}`}>{ANALYSIS_ST[a.status][1]}</span>}
        {onEdit && <button className="btn sm" type="button" onClick={onEdit}>რედაქტირება</button>}
        {d.can.submit && !empty && <button className="btn sm primary" type="button" disabled={submit.isPending} onClick={() => submit.mutate()}>გაგზავნა</button>}</div>
      {a?.status === 'returned' && a.return_reason && <div className="alert warn">დაბრუნდა შესასწორებლად: {a.return_reason}</div>}
      {empty ? <span className="small muted">ანალიზი ჯერ შევსებული არ არის{onEdit ? ' — დააჭირეთ „რედაქტირება“' : ''}.</span> : level === 'review' ? (
        <>
          <Block t="რა მოხდა" v={a!.what_happened} /><Block t="ძირეული მიზეზი" v={a!.root_cause} /><Block t="მიღებული ზომა" v={a!.action_taken} />
          {a!.factors.length > 0 && <Block t="ხელშემწყობი ფაქტორები" v={a!.factors.map((f) => `• ${f.name}${f.comment ? ` — ${f.comment}` : ''}`).join('\n')} />}
        </>) : (
        <>
          <div><div className="small muted">ქრონოლოგია</div>
            {a!.timeline.map((t) => <div key={t.id} className="row small" style={{ alignItems: 'flex-start' }}><span className="mono muted" style={{ minWidth: 120 }}>{t.at ? when(t.at) : '—'}</span><span>{t.text}</span></div>)}
            {!a!.timeline.length && <span className="small muted">—</span>}</div>
          <Block t="ხელშემწყობი ფაქტორები" v={a!.factors.map((f) => `• ${f.group_name ? `${f.group_name} — ` : ''}${f.name}${f.comment ? `: ${f.comment}` : ''}`).join('\n')} />
          <Block t="„5 რატომ“" v={a!.whys.map((w, k) => `${k + 1}. ${w}`).join('\n')} />
          <Block t="ძირეული მიზეზები" v={a!.root_causes} /><Block t="დასკვნა" v={a!.conclusion} />
          {a!.team.length > 0 && <Block t="RCA გუნდი" v={a!.team.map((m) => `${m.name}${m.role_text ? ` (${m.role_text})` : ''}`).join('; ')} />}
        </>)}
      {a?.submitted_at && <span className="small muted">გაიგზავნა {when(a.submitted_at)} · {a.submitted_by_name}{a.approved_at ? ` · დამტკიცდა ${when(a.approved_at)} · ${a.approved_by_name}` : ''}</span>}
      <ErrorBox error={submit.error} />
    </section>
  );
}
const Block = ({ t, v }: { t: string; v: string | null | undefined }) => <div><div className="small muted">{t}</div><div style={{ whiteSpace: 'pre-wrap' }}>{v?.trim() || '—'}</div></div>;

function AnalysisEditor({ d, a, level, onClose, onDone }: { d: Incident; a: Analysis | null; level: string; onClose: () => void; onDone: (r: Incident, m: string) => void }) {
  const [f, setF] = useState<Draft>(() => draftOf(a));
  const [pick, setPick] = useState<{ id: string; name: string } | null>(null);
  const factors = useQuery({ queryKey: ['qm-classifiers', 'factor'], queryFn: () => api<Classifier[]>('/quality/classifiers', { query: { kind: 'factor' } }), staleTime: 5 * 60_000 });
  const upd = (p: Partial<Draft>) => setF((x) => ({ ...x, ...p }));
  const body = () => ({
    what_happened: f.what_happened, root_cause: f.root_cause, action_taken: f.action_taken, whys: f.whys.filter((w) => w.trim()), root_causes: f.root_causes, conclusion: f.conclusion,
    timeline: f.timeline.filter((t) => t.text.trim().length >= 2).map((t) => ({ at: t.at ? new Date(t.at).toISOString() : null, text: t.text.trim() })),
    factors: f.factors.map((x) => ({ factor_id: x.factor_id, comment: x.comment.trim() || null })),
    ...(d.can.edit_team && { team: f.team.map((m) => ({ user_id: m.user_id, role_text: m.role_text.trim() || null })) }),
  });
  const save = useMutation({ mutationFn: () => api<Incident>(`/quality/incidents/${d.id}/analysis`, { method: 'PUT', body: body() }), onSuccess: (r) => { onDone(r, 'ანალიზი შენახულია'); onClose(); } });
  const roots = (factors.data ?? []).filter((x) => !x.parent_id);
  const has = (id: string) => f.factors.some((x) => x.factor_id === id);
  const ta = (k: 'what_happened' | 'root_cause' | 'action_taken' | 'root_causes' | 'conclusion', label: string, rows = 3, hint?: string) => (
    <Field label={label} htmlFor={`an-${k}`} hint={hint}><textarea id={`an-${k}`} className="textarea" rows={rows} maxLength={8000} value={f[k]} onChange={(e) => upd({ [k]: e.target.value } as Partial<Draft>)} /></Field>);
  return (
    <section className="card card-pad stack" style={{ gap: 12 }}>
      <div className="row"><h2 className="grow" style={{ margin: 0, fontSize: 16 }}>ანალიზი — {LEVEL_KA[level]} (რედაქტირება)</h2></div>
      {level === 'review' ? (
        <>{ta('what_happened', 'რა მოხდა', 4)}{ta('root_cause', 'ძირეული მიზეზი', 3)}{ta('action_taken', 'მიღებული / დაგეგმილი ზომა', 3, 'დამატებითი ქმედებები — „ქმედებები (CAPA)“')}</>
      ) : (
        <>
          <div className="stack" style={{ gap: 6 }}>
            <strong className="small">1. მოვლენების ქრონოლოგია</strong>
            {f.timeline.map((t, k) => (
              <div key={k} className="row" style={{ gap: 6 }}>
                <input className="input" type="datetime-local" style={{ maxWidth: 210 }} aria-label="დრო" max={localNow()} value={t.at} onChange={(e) => upd({ timeline: f.timeline.map((x, j) => (j === k ? { ...x, at: e.target.value } : x)) })} />
                <input className="input grow" aria-label="მოვლენა" placeholder="რა მოხდა" value={t.text} onChange={(e) => upd({ timeline: f.timeline.map((x, j) => (j === k ? { ...x, text: e.target.value } : x)) })} />
                <button className="btn sm" type="button" aria-label="წაშლა" onClick={() => upd({ timeline: f.timeline.filter((_, j) => j !== k) })}>×</button>
              </div>))}
            <div><button className="btn sm" type="button" onClick={() => upd({ timeline: [...f.timeline, { at: '', text: '' }] })}>+ მოვლენა</button></div>
          </div>
          <div className="stack" style={{ gap: 6 }}>
            <strong className="small">2. ხელშემწყობი ფაქტორები</strong>
            {roots.map((g) => (
              <div key={g.id} className="stack" style={{ gap: 2 }}>
                <span className="small muted">{g.name}</span>
                <div className="stack" style={{ gap: 4, paddingLeft: 12 }}>{(factors.data ?? []).filter((x) => x.parent_id === g.id).map((x) => (
                  <div key={x.id} className="row small" style={{ gap: 6 }}>
                    <label className="row" style={{ gap: 6, minWidth: 260 }}><input type="checkbox" checked={has(x.id)} onChange={(e) => upd({ factors: e.target.checked ? [...f.factors, { factor_id: x.id, comment: '' }] : f.factors.filter((y) => y.factor_id !== x.id) })} /> {x.name}</label>
                    {has(x.id) && <input className="input grow" style={{ height: 30 }} aria-label="კომენტარი" placeholder="როგორ შეუწყო ხელი" value={f.factors.find((y) => y.factor_id === x.id)!.comment}
                      onChange={(e) => upd({ factors: f.factors.map((y) => (y.factor_id === x.id ? { ...y, comment: e.target.value } : y)) })} />}
                  </div>))}</div>
              </div>))}
          </div>
          <div className="stack" style={{ gap: 6 }}>
            <strong className="small">3. „5 რატომ“</strong>
            {f.whys.map((w, k) => (
              <div key={k} className="row" style={{ gap: 6 }}><span className="small muted" style={{ minWidth: 70 }}>{k + 1}. რატომ?</span>
                <input className="input grow" aria-label={`რატომ ${k + 1}`} value={w} onChange={(e) => upd({ whys: f.whys.map((x, j) => (j === k ? e.target.value : x)) })} />
                {f.whys.length > 1 && <button className="btn sm" type="button" aria-label="წაშლა" onClick={() => upd({ whys: f.whys.filter((_, j) => j !== k) })}>×</button>}</div>))}
            {f.whys.length < 5 && <div><button className="btn sm" type="button" onClick={() => upd({ whys: [...f.whys, ''] })}>+ რატომ?</button></div>}
          </div>
          {ta('root_causes', '4. ძირეული მიზეზები', 3)}
          {ta('conclusion', '5. დასკვნა', 3)}
          {d.can.edit_team && (
            <div className="stack" style={{ gap: 6 }}>
              <strong className="small">RCA გუნდი</strong>
              {f.team.map((m, k) => <div key={m.user_id} className="row small" style={{ gap: 6 }}><span style={{ minWidth: 200 }}>{m.name}</span>
                <input className="input" style={{ height: 30, maxWidth: 220 }} aria-label="როლი" placeholder="როლი (არჩევითი)" value={m.role_text} onChange={(e) => upd({ team: f.team.map((x, j) => (j === k ? { ...x, role_text: e.target.value } : x)) })} />
                <button className="btn sm" type="button" aria-label="მოხსნა" onClick={() => upd({ team: f.team.filter((_, j) => j !== k) })}>×</button></div>)}
              <PersonPick value={pick} label="გუნდის წევრი" exclude={f.team.map((m) => m.user_id)} onChange={(p) => { if (p) upd({ team: [...f.team, { user_id: p.id, name: p.name, role_text: '' }] }); setPick(null); }} />
            </div>)}
        </>)}
      <div className="row"><span className="small muted grow">შენახვა — მონახაზი; „გაგზავნა“ — ნახვის რეჟიმიდან.</span>
        <button className="btn" type="button" onClick={onClose}>გაუქმება</button>
        <button className="btn primary" type="button" disabled={save.isPending} onClick={() => save.mutate()}>შენახვა</button></div>
      <ErrorBox error={save.error} />
    </section>
  );
}

// ---------------------------------------------------------------- დამტკიცება / დაბრუნება
export function ApprovePanel({ d, onDone }: { d: Incident; onDone: (r: Incident, m: string) => void }) {
  const [reason, setReason] = useState('');
  const ok = useMutation({ mutationFn: () => api<Incident>(`/quality/incidents/${d.id}/analysis/approve`, { body: {} }), onSuccess: (r) => onDone(r, 'ანალიზი დამტკიცდა') });
  const back = useMutation({ mutationFn: () => api<Incident>(`/quality/incidents/${d.id}/analysis/return`, { body: { reason: reason.trim() } }), onSuccess: (r) => { setReason(''); onDone(r, 'ანალიზი დაბრუნდა') } });
  return (
    <section className="card card-pad stack" style={{ gap: 8, borderColor: 'var(--warn-line)' }}>
      <h2 style={{ margin: 0, fontSize: 16 }}>ანალიზი დამტკიცებას ელოდება</h2>
      <button className="btn primary" type="button" disabled={ok.isPending} onClick={() => ok.mutate()}>დამტკიცება → ქმედებები (CAPA)</button>
      <div className="row" style={{ gap: 6 }}><input className="input grow" aria-label="დაბრუნების მიზეზი" placeholder="დაბრუნების მიზეზი" value={reason} onChange={(e) => setReason(e.target.value)} />
        <button className="btn" type="button" disabled={reason.trim().length < 3 || back.isPending} onClick={() => back.mutate()}>დაბრუნება</button></div>
      <ErrorBox error={ok.error ?? back.error} />
    </section>
  );
}

// ---------------------------------------------------------------- CAPA (ინციდენტის ბარათზე)
export function CapaPanel({ d, onDone }: { d: Incident; onDone: () => void }) {
  const [dlg, setDlg] = useState(false);
  const capas = d.capas ?? [];
  return (
    <section className="card card-pad stack" style={{ gap: 8 }}>
      <div className="row"><h2 className="grow" style={{ margin: 0, fontSize: 16 }}>ქმედებები (CAPA)</h2>
        {d.can.add_capa && <button className="btn sm" type="button" onClick={() => setDlg(true)}>+ ქმედება</button>}</div>
      {capas.map((c) => (
        <Link key={c.id} to={`/quality/capas/${c.id}`} className="card card-pad stack" style={{ gap: 2, textDecoration: 'none', color: 'inherit' }}>
          <div className="row small"><span className="mono">{c.capa_no}</span><span className={`chip ${CAPA_ST[c.status][0]}`} style={{ height: 20 }}>{CAPA_ST[c.status][1]}</span>
            {c.overdue && <span className="chip danger" style={{ height: 20 }}>ვადა</span>}{Number(c.incidents) > 1 && <span className="chip" style={{ height: 20 }} title="რამდენიმე ინციდენტი">×{c.incidents}</span>}</div>
          <span>{c.title}</span>
          <span className="small muted">{CAPA_KIND_KA[c.kind]} · {c.owner_name} · ვადა {dateGe(c.due_date)}{c.effectiveness_result ? ` · ${c.effectiveness_result === 'effective' ? 'ეფექტიანი' : 'არაეფექტიანი'}` : ''}</span>
        </Link>))}
      {!capas.length && <span className="small muted">ქმედება ჯერ არ არის{d.status === 'capa' ? ' — დახურვა შესაძლებელია ქმედებების გარეშეც (დასკვნაში ახსენით)' : ''}.</span>}
      {dlg && <CapaDialog incidentIds={[d.id]} onClose={() => setDlg(false)} onDone={() => { setDlg(false); onDone(); }} />}
    </section>
  );
}

export function CapaDialog({ incidentIds, followUp, initial, onClose, onDone }: { incidentIds: string[]; followUp?: string; initial?: { title?: string; kind?: string }; onClose: () => void; onDone: (id: string) => void }) {
  const qc = useQueryClient();
  const depts = useQuery({ queryKey: ['departments'], queryFn: () => api<{ id: string; name: string }[]>('/departments'), staleTime: 5 * 60_000 });
  const [f, setF] = useState({ title: initial?.title ?? '', description: '', kind: initial?.kind ?? 'corrective', department_id: '', due_date: '' });
  const [owner, setOwner] = useState<{ id: string; name: string } | null>(null);
  const save = useMutation({
    mutationFn: () => api<{ id: string }>('/quality/capas', { body: { ...f, title: f.title.trim(), description: f.description.trim() || null, department_id: f.department_id || null, owner_id: owner!.id,
      incident_ids: incidentIds, ...(followUp && { follow_up_of: followUp }) } }),
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ['qm-capas'] }); onDone(r.id); },
  });
  return (
    <Modal title="ახალი ქმედება (CAPA)" onClose={onClose} width={620}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button>
        <button className="btn primary" type="button" disabled={f.title.trim().length < 5 || !owner || !f.due_date || save.isPending} onClick={() => save.mutate()}>შექმნა</button></>}>
      <div className="stack">
        <Field label="ქმედება" htmlFor="cp-t" required><input id="cp-t" className="input" maxLength={300} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <Field label="აღწერა" htmlFor="cp-d"><textarea id="cp-d" className="textarea" rows={3} maxLength={4000} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
          <Field label="ტიპი" htmlFor="cp-k"><select id="cp-k" className="select" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            <option value="corrective">მაკორექტირებელი</option><option value="preventive">პრევენციული</option></select></Field>
          <Field label="ვადა" htmlFor="cp-due" required><input id="cp-due" className="input" type="date" min={todayISO()} value={f.due_date} onChange={(e) => setF({ ...f, due_date: e.target.value })} /></Field>
          <Field label="განყოფილება" htmlFor="cp-dep"><select id="cp-dep" className="select" value={f.department_id} onChange={(e) => setF({ ...f, department_id: e.target.value })}>
            <option value="">—</option>{depts.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
        </div>
        <Field label="პასუხისმგებელი" htmlFor="cp-o" required><PersonPick value={owner} onChange={setOwner} label="პასუხისმგებელი" /></Field>
        <span className="small muted">პასუხისმგებელი ხედავს მხოლოდ ამ ქმედებას და ინციდენტის მოკლე შეჯამებას (პაციენტისა და ავტორის გარეშე).</span>
        <ErrorBox error={save.error} />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- ინფორმირება
export function DisclosurePanel({ d, onDone, required }: { d: Incident; onDone: (r: Incident, m: string) => void; required: boolean }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ status: 'done', at: localNow(), method: 'in_person', to: '', note: '' });
  const [by, setBy] = useState<{ id: string; name: string } | null>(null);
  const save = useMutation({
    mutationFn: () => api<Incident>(`/quality/incidents/${d.id}/disclosure`, { method: 'PUT', body: f.status === 'done'
      ? { status: 'done', at: new Date(f.at).toISOString(), method: f.method, by_user_id: by?.id, to: f.to.trim() || null, note: f.note.trim() || null }
      : { status: 'not_disclosed', note: f.note.trim() } }),
    onSuccess: (r) => { setOpen(false); onDone(r, 'ინფორმირება შენახულია'); },
  });
  if (d.affected !== 'patient' && !d.disclosure_status) return null;
  return (
    <section className="card card-pad stack" style={{ gap: 8 }}>
      <div className="row"><h2 className="grow" style={{ margin: 0, fontSize: 16 }}>პაციენტის / ოჯახის ინფორმირება</h2>
        {required && !d.disclosure_status && <span className="chip warn">დახურვამდე სავალდებულო</span>}
        {d.can.disclose && !open && <button className="btn sm" type="button" onClick={() => setOpen(true)}>{d.disclosure_status ? 'შეცვლა' : 'აღრიცხვა'}</button>}</div>
      {!open && (d.disclosure_status === 'done'
        ? <span className="small">ეცნობა: {d.disclosed_at && when(d.disclosed_at)} · {METHOD_KA[d.disclosure_method ?? ''] ?? ''}{d.disclosure_by_name ? ` · ${d.disclosure_by_name}` : ''}{d.disclosure_to ? ` · ${d.disclosure_to}` : ''}{d.disclosure_note ? ` — ${d.disclosure_note}` : ''}</span>
        : d.disclosure_status === 'not_disclosed' ? <span className="small">არ ეცნობა: {d.disclosure_note}</span> : <span className="small muted">აღრიცხული არ არის</span>)}
      {open && (
        <div className="stack" style={{ gap: 8 }}>
          <div className="seg" role="group" aria-label="ინფორმირება"><button type="button" aria-pressed={f.status === 'done'} onClick={() => setF({ ...f, status: 'done' })}>ეცნობა</button>
            <button type="button" aria-pressed={f.status === 'not_disclosed'} onClick={() => setF({ ...f, status: 'not_disclosed' })}>არ ეცნობა</button></div>
          {f.status === 'done' && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
            <Field label="როდის" htmlFor="ds-at"><input id="ds-at" className="input" type="datetime-local" max={localNow()} value={f.at} onChange={(e) => setF({ ...f, at: e.target.value })} /></Field>
            <Field label="როგორ" htmlFor="ds-m"><select id="ds-m" className="select" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>{Object.entries(METHOD_KA).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
            <Field label="ვის (პაციენტი / ოჯახის წევრი)" htmlFor="ds-to"><input id="ds-to" className="input" maxLength={300} value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
            <Field label="ვინ აცნობა (ცარიელი — თქვენ)" htmlFor="ds-by"><PersonPick value={by} onChange={setBy} label="ვინ აცნობა" /></Field>
          </div>}
          <Field label={f.status === 'done' ? 'შენიშვნა' : 'მიზეზი (სავალდებულო)'} htmlFor="ds-n"><textarea id="ds-n" className="textarea" rows={2} maxLength={2000} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
          <div className="row"><span className="grow" /><button className="btn" type="button" onClick={() => setOpen(false)}>გაუქმება</button>
            <button className="btn primary" type="button" disabled={save.isPending || (f.status === 'not_disclosed' && f.note.trim().length < 3)} onClick={() => save.mutate()}>შენახვა</button></div>
          <ErrorBox error={save.error} />
        </div>)}
    </section>
  );
}

// ---------------------------------------------------------------- დახურვა
interface CloseCheck { ok: boolean; blockers: { code: string; message: string }[]; need_disclosure: boolean }
export function ClosePanel({ d, meta, onDone }: { d: Incident; meta: QmMeta; onDone: (r: Incident, m: string) => void }) {
  const chk = useQuery({ queryKey: ['qm-close-check', d.id, d.capas?.map((c) => c.status).join(), d.disclosure_status, d.status], queryFn: () => api<CloseCheck>(`/quality/incidents/${d.id}/close-check`) });
  const [f, setF] = useState({ summary: '', feedback: '' });
  const save = useMutation({ mutationFn: () => api<Incident>(`/quality/incidents/${d.id}/close`, { body: { summary: f.summary.trim(), feedback_text: f.feedback.trim() || null } }), onSuccess: (r) => onDone(r, 'ინციდენტი დაიხურა') });
  return (
    <section className="card card-pad stack" style={{ gap: 8 }}>
      <h2 style={{ margin: 0, fontSize: 16 }}>დახურვა</h2>
      {chk.data && !chk.data.ok && <div className="alert warn"><div className="stack" style={{ gap: 2 }}>{chk.data.blockers.map((b) => <span key={b.code}>• {b.message}</span>)}</div></div>}
      <Field label="დასკვნა (შიდა)" htmlFor="cl-s" required hint="რა გაირკვა, რა შეიცვალა; მინ. 10 სიმბოლო"><textarea id="cl-s" className="textarea" rows={3} maxLength={8000} value={f.summary} onChange={(e) => setF({ ...f, summary: e.target.value })} /></Field>
      {meta.closure_feedback && <Field label="ავტორს — მოკლე უკუკავშირი (არჩევითი)" htmlFor="cl-f" hint={d.identity_mode === 'anonymous' ? 'ანონიმური ავტორი ნახავს კოდით' : 'მიუვა შეტყობინებით; პაციენტის / პირის მონაცემების გარეშე'}>
        <textarea id="cl-f" className="textarea" rows={2} maxLength={2000} value={f.feedback} onChange={(e) => setF({ ...f, feedback: e.target.value })} /></Field>}
      <div className="row"><span className="grow" /><button className="btn primary" type="button" disabled={!chk.data?.ok || f.summary.trim().length < 10 || save.isPending} onClick={() => save.mutate()}>დახურვა</button></div>
      <ErrorBox error={save.error} />
    </section>
  );
}

