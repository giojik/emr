import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, apiUpload, openBlob } from '../../api/client';
import { useQmMeta } from '../../components/IncidentReport';
import { AnalysisSection, ApprovePanel, CapaPanel, ClosePanel, DisclosurePanel, InvestigationPanel, PersonPick } from './Investigation';
import { ErrorBox, Field, Loading, useDebounced, useToast } from '../../components/ui';
import { dateGe, hhmm, tsDate } from '../../lib/format';
import {
  AFFECTED_KA, catLabel, CONSEQUENCE_KA, EVENT_KA, EVENT_LOG_KA, HARM_CHIP, HARM_KA, IDENTITY_KA, LIKELIHOOD_KA, MERP_KA, PERSON_ROLE_KA, REJECT_KA, RISK_UI, riskOf, STATUS_UI,
  disclosureRequired, LEVEL_KA, SERVICE_KA, type Classifier, type EventType, type Harm, type Incident, type IncidentRow, type QmMeta,
} from './types';

const when = (ts: string) => `${tsDate(ts)} ${hhmm(ts)}`;

/** ინციდენტის ბარათი: დეტალები, ტრიაჟი / კლასიფიკაცია (quality), ქრონოლოგია, კომენტარი, ფაილები */
export default function IncidentCard() {
  const { id } = useParams(); const nav = useNavigate();
  const qc = useQueryClient(); const toast = useToast();
  const meta = useQmMeta();
  const q = useQuery({ queryKey: ['qm-incident', id], queryFn: () => api<Incident>(`/quality/incidents/${id}`) });
  if (q.isLoading) return <div className="content"><Loading /></div>;
  if (q.error || !q.data) return <div className="content"><ErrorBox error={q.error} /><button className="btn" type="button" onClick={() => nav('/quality')}>← რეესტრი</button></div>;
  const d = q.data;
  const done = (r: Incident, msg: string) => {
    qc.setQueryData(['qm-incident', id], r); toast.show(msg);
    for (const k of ['qm-list', 'qm-summary', 'qm-mine']) void qc.invalidateQueries({ queryKey: [k] });
  };
  const refresh = () => void qc.invalidateQueries({ queryKey: ['qm-incident', id] });
  return (
    <>
      {toast.node}
      <header className="topbar">
        <button className="btn sm" type="button" onClick={() => nav(d.access === 'own' ? '/quality?tab=mine' : '/quality')}>←</button>
        <h1 className="mono" style={{ margin: 0 }}>{d.inc_no}</h1>
        <span className={`chip ${STATUS_UI[d.status][0]}`}>{STATUS_UI[d.status][1]}</span>
        {d.is_sentinel && <span className="chip danger">⚑ სენტინელური</span>}
        {d.urgent && <span className="chip danger">სასწრაფო</span>}
        {d.overdue && <span className="chip danger">ტრიაჟის ვადა გადაცილებულია</span>}
        <span className="grow" />
        {d.status === 'submitted' && d.access !== 'own' && <span className="small muted">ტრიაჟის ვადა: {when(d.triage_due_at)}</span>}
        {d.analysis_overdue && <span className="chip danger">ანალიზის ვადა გადაცილებულია</span>}
        {(d.access === 'full' || d.access === 'inv') && d.analysis && <PdfButton id={d.id} mask={meta.data?.report_mask_patient !== false} />}
      </header>
      <div className="content" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.25fr) minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
        <div className="stack">
          <section className="card card-pad stack" style={{ gap: 10 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '8px 16px' }} className="small">
              <Kv k="ტიპი" v={EVENT_KA[d.event_type][0]} />
              <Kv k="ვის შეეხო" v={AFFECTED_KA[d.affected]} />
              <Kv k="მოხდა" v={when(d.occurred_at)} />
              <Kv k="გაიგზავნა" v={when(d.reported_at)} />
              <Kv k="განყოფილება" v={d.department_name} />
              {d.access !== 'own' && d.service_type && <Kv k="მომსახურების ტიპი" v={SERVICE_KA[d.service_type] ?? d.service_type} />}
              <Kv k="ადგილი" v={d.location_text ?? '—'} />
              <Kv k="კატეგორია" v={catLabel(d)} />
              <Kv k="ზიანი" v={<>{HARM_KA[d.harm_reported]} <span className="muted">(ავტორი)</span>{d.harm && <> → <span className={`chip ${HARM_CHIP[d.harm]}`} style={{ height: 20 }}>{HARM_KA[d.harm]}</span></>}</>} />
              {d.merp_category && <Kv k="NCC MERP" v={MERP_KA[d.merp_category]} />}
              {d.risk_level && <Kv k="რისკი" v={<span className={`chip ${RISK_UI[d.risk_level][0]}`}>{d.likelihood} × {d.consequence} = {d.risk_score} · {RISK_UI[d.risk_level][1]}</span>} />}
              <Kv k="პაციენტი" v={d.patient_id ? <>{d.access === 'own' ? `${d.patient_first_name} ${d.patient_last_name}`
                : <Link to={`/patients/${d.patient_id}`}>{d.patient_first_name} {d.patient_last_name}</Link>} <span className="muted mono">{d.patient_personal_number ?? ''}{d.patient_birth_date ? ` · ${dateGe(d.patient_birth_date)}` : ''}</span></>
                : d.patient_text ? <>{d.patient_text} <span className="muted">(ტექსტი)</span></> : '—'} />
              <Kv k="მიბმული მოვლენა" v={d.source_label ?? '—'} />
              <Kv k="ავტორი" v={d.identity_mode === 'anonymous' ? <span className="muted">ანონიმური</span> : d.access === 'own' ? 'თქვენ' : d.reporter_name ?? <span className="muted">{IDENTITY_KA[d.identity_mode][0]}</span>} />
              {d.triaged_at && d.access === 'full' && <Kv k="ტრიაჟი" v={`${when(d.triaged_at)} · ${d.triaged_by_name ?? ''}`} />}
              {d.access !== 'own' && d.analysis_level && <Kv k="ანალიზი" v={`${LEVEL_KA[d.analysis_level]}${d.analysis_due_at ? ` · ვადა ${tsDate(d.analysis_due_at)}` : ''}`} />}
              {d.access !== 'own' && d.investigator_name && <Kv k="გამომძიებელი" v={d.investigator_name} />}
              {d.closed_at && d.access !== 'own' && <Kv k="დაიხურა" v={`${when(d.closed_at)} · ${d.closed_by_name ?? ''}`} />}
            </div>
            <div><div className="small muted">აღწერა</div><div style={{ whiteSpace: 'pre-wrap' }}>{d.description}</div></div>
            {d.immediate_actions && <div><div className="small muted">დაუყოვნებლივ მიღებული ზომები</div><div style={{ whiteSpace: 'pre-wrap' }}>{d.immediate_actions}</div></div>}
            {d.triage_note && <div><div className="small muted">ტრიაჟის შენიშვნა</div><div style={{ whiteSpace: 'pre-wrap' }}>{d.triage_note}</div></div>}
            {d.closure_summary && <div><div className="small muted">დასკვნა (დახურვა)</div><div style={{ whiteSpace: 'pre-wrap' }}>{d.closure_summary}</div></div>}
            {d.access === 'own' && d.status === 'closed' && <div className="alert ok">განხილვა დასრულდა{d.feedback_text ? `: ${d.feedback_text}` : '.'} გმადლობთ შეტყობინებისთვის.</div>}
            {d.status === 'rejected' && d.reject_reason && <div className="alert">უარყოფილია: {REJECT_KA[d.reject_reason]}{d.duplicate_inc_no && <> — ორიგინალი <Link to={`/quality/incidents/${d.duplicate_of}`} className="mono">{d.duplicate_inc_no}</Link></>}</div>}
          </section>
          {d.access !== 'own' && !['submitted', 'rejected'].includes(d.status) && <AnalysisSection key={`${d.status}:${d.analysis?.updated_at ?? ''}`} d={d} onDone={done} />}
          {d.people && d.people.length > 0 && (
            <section className="card card-pad stack" style={{ gap: 6 }}>
              <strong className="small">მონაწილეები / მოწმეები</strong>
              {d.people.map((p) => <div key={p.id} className="row small"><span className="chip">{PERSON_ROLE_KA[p.role]}</span><span>{p.user_name ?? p.name_text}</span>{p.department_name && <span className="muted">· {p.department_name}</span>}</div>)}
            </section>)}
          <Files d={d} onDone={refresh} />
          <Timeline d={d} onDone={refresh} />
        </div>
        <div className="stack">
          {d.access === 'full' && d.status === 'submitted' && meta.data && <Triage d={d} meta={meta.data} onDone={(r) => done(r, 'ტრიაჟი შენახულია')} />}
          {d.access === 'full' && d.status === 'analysis' && <ApprovePanel d={d} onDone={done} />}
          {d.access === 'full' && !['submitted', 'rejected'].includes(d.status) && <InvestigationPanel d={d} onDone={done} />}
          {d.access !== 'own' && !['submitted', 'rejected'].includes(d.status) && <CapaPanel d={d} onDone={refresh} />}
          {d.access !== 'own' && !['submitted', 'rejected'].includes(d.status) && meta.data && <DisclosurePanel d={d} onDone={done} required={disclosureRequired(d, meta.data)} />}
          {d.access === 'full' && d.status === 'capa' && meta.data && <ClosePanel d={d} meta={meta.data} onDone={done} />}
          {d.access === 'full' && ['investigation', 'analysis', 'capa'].includes(d.status) && meta.data && <Reclassify d={d} meta={meta.data} onDone={(r) => done(r, 'კლასიფიკაცია შეიცვალა')} />}
          {d.access === 'full' && (d.status === 'rejected' || d.status === 'closed') && <Reopen d={d} onDone={(r) => done(r, 'ხელახლა გაიხსნა')} />}
          {d.access === 'own' && d.status === 'submitted' && <AuthorEdit d={d} onDone={(r) => done(r, 'შენახულია')} />}
        </div>
      </div>
    </>
  );
}

function PdfButton({ id, mask }: { id: string; mask: boolean }) {
  const [m, setM] = useState(mask);
  const open = useMutation({ mutationFn: () => openBlob(`/quality/incidents/${id}/report?mask=${m ? 1 : 0}`) });
  return <span className="row small" style={{ gap: 6 }}><label className="row" style={{ gap: 4 }}><input type="checkbox" checked={m} onChange={(e) => setM(e.target.checked)} /> პაციენტი ნიღბით</label>
    <button className="btn sm" type="button" disabled={open.isPending} onClick={() => open.mutate()}>ანალიზის ანგარიში (PDF)</button></span>;
}

const Kv = ({ k, v }: { k: string; v: React.ReactNode }) => <div><div className="muted">{k}</div><div>{v}</div></div>;

// ---------------------------------------------------------------- რისკის მატრიცა 5×5
function RiskMatrix({ l, c, set, risk }: { l: number; c: number; set: (l: number, c: number) => void; risk: QmMeta['risk'] }) {
  const tone: Record<string, string> = { low: 'var(--ok-weak)', medium: 'var(--info-weak)', high: 'var(--warn-weak)', extreme: 'var(--danger-weak)' };
  return (
    <div className="stack" style={{ gap: 4 }}>
      <table className="table" style={{ tableLayout: 'fixed', fontSize: 12 }} aria-label="რისკის მატრიცა: ალბათობა × შედეგი">
        <thead><tr><th style={{ width: 92 }} title="შედეგი (რიგი) × ალბათობა (სვეტი)">შედ. \ ალბ.</th>{[1, 2, 3, 4, 5].map((x) => <th key={x} style={{ textAlign: 'center' }} title={LIKELIHOOD_KA[x]}>{x}</th>)}</tr></thead>
        <tbody>{[5, 4, 3, 2, 1].map((cc) => (
          <tr key={cc}><th title={CONSEQUENCE_KA[cc]} style={{ fontWeight: 500 }}>{cc}</th>
            {[1, 2, 3, 4, 5].map((ll) => { const s = ll * cc; const on = ll === l && cc === c;
              return <td key={ll} className="num" style={{ padding: 0 }}>
                <button type="button" aria-pressed={on} aria-label={`ალბათობა ${ll}, შედეგი ${cc}, ქულა ${s}`} onClick={() => set(ll, cc)}
                  style={{ width: '100%', height: 30, border: on ? '2px solid var(--ink)' : '1px solid transparent', background: tone[riskOf(s, risk)], cursor: 'pointer', fontWeight: on ? 700 : 400 }}>{s}</button></td>; })}
          </tr>))}
        </tbody>
      </table>
      <span className="small muted">შედეგი: {[1, 2, 3, 4, 5].map((x) => `${x} — ${CONSEQUENCE_KA[x]}`).join('; ')}</span>
      <span className="small muted">ალბათობა: {[1, 2, 3, 4, 5].map((x) => `${x} — ${LIKELIHOOD_KA[x]}`).join('; ')}</span>
    </div>
  );
}

interface ClassState { event_type: EventType; harm: Harm | ''; merp: string; l: number; c: number; category: string; sub: string; department_id: string; sentinel: boolean; patient: { id: string; name: string } | null; note: string;
  service_type: string }
const initClass = (d: Incident): ClassState => ({
  event_type: d.event_type, harm: (d.harm ?? (d.status === 'submitted' ? d.harm_reported : '')) as Harm | '', merp: d.merp_category ?? '', l: d.likelihood ?? 0, c: d.consequence ?? 0,
  category: d.category_parent_id ?? d.category_id, sub: d.category_parent_id ? d.category_id : '', department_id: d.department_id, sentinel: d.is_sentinel, patient: null, note: '',
  service_type: d.service_type ?? '',
});

function ClassFields({ s, set, meta, d }: { s: ClassState; set: (p: Partial<ClassState>) => void; meta: QmMeta; d: Incident }) {
  const cats = useQuery({ queryKey: ['qm-classifiers', 'category'], queryFn: () => api<Classifier[]>('/quality/classifiers', { query: { kind: 'category' } }), staleTime: 5 * 60_000 });
  const depts = useQuery({ queryKey: ['departments'], queryFn: () => api<{ id: string; name: string }[]>('/departments'), staleTime: 5 * 60_000 });
  const roots = (cats.data ?? []).filter((c) => !c.parent_id); const subs = (cats.data ?? []).filter((c) => c.parent_id === s.category);
  const root = roots.find((c) => c.id === s.category);
  const harmful = s.event_type === 'harm';
  const [pq, setPq] = useState(''); const dpq = useDebounced(pq.trim(), 250);
  const ph = useQuery({ queryKey: ['qm-patients', dpq], queryFn: () => api<{ id: string; first_name: string; last_name: string; personal_number: string | null }[]>('/quality/patients', { query: { q: dpq } }), enabled: dpq.length >= 2 });
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
        <Field label="ტიპი" htmlFor="tr-et"><select id="tr-et" className="select" value={s.event_type} onChange={(e) => { const et = e.target.value as EventType; set({ event_type: et, harm: et === 'harm' ? (s.harm && s.harm !== 'none' ? s.harm : 'mild') : 'none' }); }}>
          {(Object.keys(EVENT_KA) as EventType[]).map((k) => <option key={k} value={k}>{EVENT_KA[k][0]}</option>)}</select></Field>
        <Field label="საბოლოო ზიანი" htmlFor="tr-h" required><select id="tr-h" className="select" value={s.harm} onChange={(e) => set({ harm: e.target.value as Harm })}>
          <option value="">—</option>{(Object.keys(HARM_KA) as Harm[]).filter((k) => (harmful ? k !== 'none' : k === 'none')).map((k) => <option key={k} value={k}>{HARM_KA[k]}</option>)}</select></Field>
        <Field label="კატეგორია" htmlFor="tr-cat"><select id="tr-cat" className="select" value={s.category} onChange={(e) => set({ category: e.target.value, sub: '' })}>
          {roots.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        <Field label="ქვეკატეგორია" htmlFor="tr-sub"><select id="tr-sub" className="select" value={s.sub} disabled={!subs.length} onChange={(e) => { const x = subs.find((c) => c.id === e.target.value); set({ sub: e.target.value, sentinel: x ? x.is_sentinel || s.sentinel : s.sentinel }); }}>
          <option value="">—</option>{subs.map((c) => <option key={c.id} value={c.id}>{c.name}{c.is_sentinel ? ' ⚑' : ''}</option>)}</select></Field>
        <Field label="განყოფილება" htmlFor="tr-dept"><select id="tr-dept" className="select" value={s.department_id} onChange={(e) => set({ department_id: e.target.value })}>
          {depts.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
        <Field label="მომსახურების ტიპი" htmlFor="tr-svc" hint="ავტომატურად — მიბმული მოვლენიდან / განყოფილებიდან"><select id="tr-svc" className="select" value={s.service_type} onChange={(e) => set({ service_type: e.target.value })}>
          {Object.entries(SERVICE_KA).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        {root?.is_medication && meta.ncc_merp ? (
          <Field label="NCC MERP" htmlFor="tr-merp"><select id="tr-merp" className="select" value={s.merp} onChange={(e) => set({ merp: e.target.value })}>
            <option value="">—</option>{Object.entries(MERP_KA).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>) : <span />}
      </div>
      <label className="row small"><input type="checkbox" checked={s.sentinel} onChange={(e) => set({ sentinel: e.target.checked })} /> სენტინელური მოვლენა (RCA სავალდებულო)</label>
      {!d.patient_id && (
        <div className="stack" style={{ gap: 4 }}>
          <span className="small muted">პაციენტის მიბმა{d.patient_text ? ` (ავტორის ტექსტი: „${d.patient_text}“)` : ''}</span>
          {s.patient ? <div className="row small"><strong>{s.patient.name}</strong><button className="btn sm" type="button" onClick={() => set({ patient: null })}>მოხსნა</button></div>
            : <><input className="input" aria-label="პაციენტის ძებნა" placeholder="პირადი ნომერი ან სახელი" value={pq} onChange={(e) => setPq(e.target.value)} />
              {ph.data?.map((p) => <button key={p.id} type="button" className="btn sm" style={{ justifyContent: 'flex-start' }} onClick={() => { set({ patient: { id: p.id, name: `${p.first_name} ${p.last_name}` } }); setPq(''); }}>{p.first_name} {p.last_name} <span className="muted mono">{p.personal_number}</span></button>)}</>}
        </div>)}
      <div className="small" style={{ fontWeight: 600 }}>რისკი {s.l && s.c ? <span className={`chip ${RISK_UI[riskOf(s.l * s.c, meta.risk)][0]}`} style={{ marginLeft: 6 }}>{s.l * s.c} · {RISK_UI[riskOf(s.l * s.c, meta.risk)][1]}</span> : <span className="muted">— აირჩიეთ უჯრა</span>}</div>
      <RiskMatrix l={s.l} c={s.c} set={(l, c) => set({ l, c })} risk={meta.risk} />
    </div>
  );
}
const classBody = (s: ClassState) => ({ event_type: s.event_type, harm: s.harm || undefined, merp_category: s.merp || null, likelihood: s.l || undefined, consequence: s.c || undefined,
  category_id: s.sub || s.category, department_id: s.department_id, is_sentinel: s.sentinel, ...(s.patient && { patient_id: s.patient.id }), ...(s.service_type && { service_type: s.service_type }) });

function Triage({ d, meta, onDone }: { d: Incident; meta: QmMeta; onDone: (r: Incident) => void }) {
  const [mode, setMode] = useState<'accept' | 'reject'>('accept');
  const [s, setS] = useState<ClassState>(() => initClass(d));
  const [reason, setReason] = useState('not_incident'); const [dup, setDup] = useState<{ id: string; inc_no: string } | null>(null);
  const [inv, setInv] = useState<{ id: string; name: string } | null>(null);
  const [dq, setDq] = useState(''); const ddq = useDebounced(dq.trim(), 300);
  const dups = useQuery({ queryKey: ['qm-list', 'dup', ddq], queryFn: () => api<IncidentRow[]>('/quality/incidents', { query: { search: ddq } }), enabled: mode === 'reject' && reason === 'duplicate' && ddq.length >= 2 });
  const save = useMutation({
    mutationFn: () => api<Incident>(`/quality/incidents/${d.id}/triage`, { body: mode === 'accept' ? { decision: 'accept', ...classBody(s), note: s.note.trim() || null, ...(inv && { investigator_id: inv.id }) }
      : { decision: 'reject', reject_reason: reason, duplicate_of: reason === 'duplicate' ? dup?.id : undefined, note: s.note.trim() || null } }),
    onSuccess: onDone,
  });
  const ok = mode === 'accept' ? !!s.harm && s.l > 0 && s.c > 0 : reason === 'duplicate' ? !!dup : s.note.trim().length >= 3;
  return (
    <section className="card card-pad stack">
      <div className="row"><h2 className="grow" style={{ margin: 0, fontSize: 16 }}>ტრიაჟი</h2>
        <div className="seg" role="group" aria-label="გადაწყვეტილება"><button type="button" aria-pressed={mode === 'accept'} onClick={() => setMode('accept')}>მიღება</button>
          <button type="button" aria-pressed={mode === 'reject'} onClick={() => setMode('reject')}>უარყოფა</button></div></div>
      {mode === 'accept' ? <><ClassFields s={s} set={(p) => setS((x) => ({ ...x, ...p }))} meta={meta} d={d} />
        {meta.investigator_at_triage && <Field label="გამომძიებელი (არჩევითი)" htmlFor="tr-inv" hint="შეიძლება შემდეგაც დაინიშნოს"><PersonPick value={inv} onChange={setInv} label="გამომძიებელი" /></Field>}</> : (
        <div className="stack" style={{ gap: 8 }}>
          <Field label="მიზეზი" htmlFor="tr-rr"><select id="tr-rr" className="select" value={reason} onChange={(e) => setReason(e.target.value)}>
            {Object.entries(REJECT_KA).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          {reason === 'duplicate' && (dup ? <div className="row small">ორიგინალი: <strong className="mono">{dup.inc_no}</strong><button className="btn sm" type="button" onClick={() => setDup(null)}>შეცვლა</button></div>
            : <><input className="input" aria-label="ორიგინალის ძებნა" placeholder="№ ან აღწერა" value={dq} onChange={(e) => setDq(e.target.value)} />
              {dups.data?.filter((x) => x.id !== d.id && x.status !== 'rejected').slice(0, 8).map((x) => <button key={x.id} type="button" className="btn sm" style={{ justifyContent: 'flex-start' }}
                onClick={() => setDup({ id: x.id, inc_no: x.inc_no })}><span className="mono">{x.inc_no}</span> · {catLabel(x)} · {tsDate(x.occurred_at)}</button>)}</>)}
        </div>)}
      <Field label={mode === 'reject' && reason !== 'duplicate' ? 'განმარტება (სავალდებულო)' : 'შენიშვნა'} htmlFor="tr-note" hint={mode === 'reject' ? 'ავტორი ხედავს მხოლოდ მიზეზს, არა განმარტებას' : undefined}>
        <textarea id="tr-note" className="textarea" rows={2} maxLength={4000} value={s.note} onChange={(e) => setS((x) => ({ ...x, note: e.target.value }))} /></Field>
      <div className="row"><span className="grow" /><button className={`btn ${mode === 'accept' ? 'primary' : 'danger'}`} type="button" disabled={!ok || save.isPending} onClick={() => save.mutate()}>{mode === 'accept' ? 'მიღება განსახილველად' : 'უარყოფა'}</button></div>
      <ErrorBox error={save.error} />
    </section>
  );
}

function Reclassify({ d, meta, onDone }: { d: Incident; meta: QmMeta; onDone: (r: Incident) => void }) {
  const [open, setOpen] = useState(false);
  const [s, setS] = useState<ClassState>(() => initClass(d)); const [reason, setReason] = useState('');
  const save = useMutation({ mutationFn: () => api<Incident>(`/quality/incidents/${d.id}/classification`, { method: 'PATCH', body: { ...classBody(s), reason: reason.trim() } }),
    onSuccess: (r) => { setOpen(false); setReason(''); onDone(r); } });
  if (!open) return <button className="btn" type="button" onClick={() => { setS(initClass(d)); setOpen(true); }}>კლასიფიკაციის / რისკის შესწორება</button>;
  return (
    <section className="card card-pad stack">
      <h2 style={{ margin: 0, fontSize: 16 }}>კლასიფიკაციის შესწორება</h2>
      <ClassFields s={s} set={(p) => setS((x) => ({ ...x, ...p }))} meta={meta} d={d} />
      <input className="input" aria-label="ცვლილების მიზეზი" placeholder="ცვლილების მიზეზი (სავალდებულო)" value={reason} onChange={(e) => setReason(e.target.value)} />
      <div className="row"><span className="grow" /><button className="btn" type="button" onClick={() => setOpen(false)}>გაუქმება</button>
        <button className="btn primary" type="button" disabled={reason.trim().length < 3 || !s.harm || !s.l || !s.c || save.isPending} onClick={() => save.mutate()}>შენახვა</button></div>
      <ErrorBox error={save.error} />
    </section>
  );
}

function Reopen({ d, onDone }: { d: Incident; onDone: (r: Incident) => void }) {
  const [reason, setReason] = useState('');
  const save = useMutation({ mutationFn: () => api<Incident>(`/quality/incidents/${d.id}/reopen`, { body: { reason: reason.trim() } }), onSuccess: onDone });
  return (
    <section className="card card-pad stack" style={{ gap: 8 }}>
      <h2 style={{ margin: 0, fontSize: 16 }}>ხელახლა გახსნა{d.status === 'closed' ? ' (→ გამოძიება)' : ''}</h2>
      <input className="input" aria-label="მიზეზი" placeholder="მიზეზი (სავალდებულო)" value={reason} onChange={(e) => setReason(e.target.value)} />
      <div className="row"><span className="grow" /><button className="btn" type="button" disabled={reason.trim().length < 3 || save.isPending} onClick={() => save.mutate()}>{d.status === 'closed' ? 'ხელახლა გახსნა' : 'ტრიაჟზე დაბრუნება'}</button></div>
      <ErrorBox error={save.error} />
    </section>
  );
}

/** ავტორი ტრიაჟამდე: აღწერა / ზომები / ადგილი / დრო */
function AuthorEdit({ d, onDone }: { d: Incident; onDone: (r: Incident) => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ description: d.description, immediate_actions: d.immediate_actions ?? '', location_text: d.location_text ?? '' });
  const save = useMutation({
    mutationFn: () => api<Incident>(`/quality/incidents/${d.id}`, { method: 'PATCH', body: {
      event_type: d.event_type, affected: d.affected, occurred_at: d.occurred_at, department_id: d.department_id, location_text: f.location_text.trim() || null, category_id: d.category_id,
      harm_reported: d.harm_reported, merp_category: d.merp_category, description: f.description.trim(), immediate_actions: f.immediate_actions.trim() || null,
      patient_id: d.patient_id, patient_text: d.patient_text, source_type: d.source_type, source_id: d.source_id,
      people: (d.people ?? []).map((p) => ({ role: p.role, user_id: p.user_id, name_text: p.user_id ? null : p.name_text, note: p.note })) } }),
    onSuccess: (r) => { setOpen(false); onDone(r); },
  });
  if (!open) return <div className="stack" style={{ gap: 6 }}><span className="small muted">ტრიაჟამდე შეგიძლიათ შეასწოროთ შეტყობინება.</span><button className="btn" type="button" onClick={() => setOpen(true)}>რედაქტირება</button></div>;
  return (
    <section className="card card-pad stack" style={{ gap: 8 }}>
      <Field label="აღწერა" htmlFor="ae-d" required><textarea id="ae-d" className="textarea" rows={5} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      <Field label="დაუყოვნებლივ მიღებული ზომები" htmlFor="ae-a"><textarea id="ae-a" className="textarea" rows={2} value={f.immediate_actions} onChange={(e) => setF({ ...f, immediate_actions: e.target.value })} /></Field>
      <Field label="ადგილი" htmlFor="ae-l"><input id="ae-l" className="input" value={f.location_text} onChange={(e) => setF({ ...f, location_text: e.target.value })} /></Field>
      <div className="row"><span className="grow" /><button className="btn" type="button" onClick={() => setOpen(false)}>გაუქმება</button>
        <button className="btn primary" type="button" disabled={f.description.trim().length < 10 || save.isPending} onClick={() => save.mutate()}>შენახვა</button></div>
      <ErrorBox error={save.error} />
    </section>
  );
}

function Files({ d, onDone }: { d: Incident; onDone: () => void }) {
  const up = useMutation({ mutationFn: (fs: File[]) => { const fd = new FormData(); for (const f of fs) fd.append('files', f); return apiUpload(`/quality/incidents/${d.id}/files`, fd); }, onSuccess: onDone });
  const open = useMutation({ mutationFn: (fid: string) => openBlob(`/quality/incidents/${d.id}/files/${fid}`) });
  const canAdd = d.status !== 'closed' && (d.access !== 'own' || d.status !== 'rejected');
  if (!d.files.length && !canAdd) return null;
  return (
    <section className="card card-pad stack" style={{ gap: 6 }}>
      <div className="row"><strong className="small grow">ფაილები ({d.files.length})</strong>
        {canAdd && <label className="btn sm">+ ფაილი<input type="file" multiple hidden accept="image/jpeg,image/png,application/pdf" onChange={(e) => { const fs = Array.from(e.target.files ?? []).slice(0, 5); if (fs.length) up.mutate(fs); e.target.value = ''; }} /></label>}</div>
      {d.files.map((f) => <button key={f.id} type="button" className="btn sm" style={{ justifyContent: 'flex-start' }} onClick={() => open.mutate(f.id)}>
        {f.mime_type === 'application/pdf' ? 'PDF' : 'სურათი'} · {f.original_name ?? f.id.slice(0, 8)} <span className="muted">· {Math.round(f.size_bytes / 1024)} KB · {tsDate(f.created_at)}</span></button>)}
      <ErrorBox error={up.error ?? open.error} />
    </section>
  );
}

function Timeline({ d, onDone }: { d: Incident; onDone: () => void }) {
  const [text, setText] = useState(''); const [internal, setInternal] = useState(false);
  const add = useMutation({ mutationFn: () => api(`/quality/incidents/${d.id}/comments`, { body: { text: text.trim(), internal: d.access === 'full' ? internal : undefined } }),
    onSuccess: () => { setText(''); onDone(); } });
  const events = useMemo(() => [...d.events].reverse(), [d.events]);
  return (
    <section className="card card-pad stack" style={{ gap: 8 }}>
      <strong className="small">ქრონოლოგია</strong>
      {d.status !== 'closed' && (
        <div className="stack" style={{ gap: 6 }}>
          <textarea className="textarea" rows={2} aria-label="კომენტარი" placeholder={d.access === 'own' ? 'დამატებითი ინფორმაცია ხარისხის მენეჯერისთვის' : 'კომენტარი'} maxLength={4000} value={text} onChange={(e) => setText(e.target.value)} />
          <div className="row">{d.access === 'full' && <label className="row small"><input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> შიდა (მხოლოდ ხარისხის მენეჯერი)</label>}
            <span className="grow" /><button className="btn sm primary" type="button" disabled={text.trim().length < 2 || add.isPending} onClick={() => add.mutate()}>დამატება</button></div>
          <ErrorBox error={add.error} />
        </div>)}
      {events.map((e) => (
        <div key={e.id} className="stack" style={{ gap: 2, borderLeft: `3px solid ${e.internal ? 'var(--warn-line)' : 'var(--line)'}`, paddingLeft: 10 }}>
          <span className="small"><strong>{EVENT_LOG_KA[e.kind] ?? e.kind}</strong> <span className="muted">· {when(e.at)}{e.user_name ? ` · ${e.user_name}` : ''}{e.internal ? ' · შიდა' : ''}</span></span>
          {e.kind === 'rejected' && e.data && <span className="small">მიზეზი: {REJECT_KA[String(e.data.reason)] ?? String(e.data.reason)}</span>}
          {e.kind === 'accepted' && e.data && d.access !== 'own' && <span className="small muted">ზიანი: {HARM_KA[e.data.harm as Harm] ?? '—'} · რისკი: {String(e.data.risk ?? '—')}</span>}
          {e.kind === 'reclassified' && e.data && <span className="small muted">{Object.keys(e.data).join(', ')}</span>}
          {e.kind === 'capa' && e.data && <span className="small muted">{String(e.data.capa_no)} · {String(e.data.title)}</span>}
          {e.kind === 'level' && e.data && <span className="small muted">{LEVEL_KA[String(e.data.from)] ?? '—'} → {LEVEL_KA[String(e.data.to)]}</span>}
          {e.text && <span style={{ whiteSpace: 'pre-wrap' }}>{e.text}</span>}
        </div>))}
      {!events.length && <span className="small muted">ჩანაწერი არ არის</span>}
    </section>
  );
}
