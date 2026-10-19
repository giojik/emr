import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, apiUpload } from '../api/client';
import { copyText } from '../lib/clipboard';
import { dateGe, todayISO, tsDate, hhmm } from '../lib/format';
import { useModuleEnabled } from '../lib/modules';
import {
  AFFECTED_KA, EVENT_KA, HARM_KA, IDENTITY_KA, MERP_KA, PERSON_ROLE_KA,
  type Affected, type Classifier, type EventType, type Harm, type IdentityMode, type Person, type Prompt, type QmMeta, type Source, type SourceType,
} from '../pages/quality/types';
import { ErrorBox, Field, Modal, useDebounced } from './ui';

/** ფორმის წინასწარი შევსება — კონტექსტური ღილაკიდან (MAR, ოპერაცია, სტაციონარი, ვიზიტი…) */
export interface ReportPrefill {
  patient?: { id: string; name: string } | null;
  source?: { type: SourceType; id: string; label: string } | null;
  department_id?: string | null;
  category_id?: string | null;
}
/** ინციდენტის შეტყობინების ფანჯრის გახსნა ნებისმიერი გვერდიდან */
export const openIncidentReport = (p: ReportPrefill = {}) => window.dispatchEvent(new CustomEvent<ReportPrefill>('qm:report', { detail: p }));

export const useQmMeta = (enabled = true) => useQuery({ queryKey: ['qm-meta'], queryFn: () => api<QmMeta>('/quality/meta'), staleTime: 5 * 60_000, enabled });

/** კონტექსტური ღილაკი — მხოლოდ ჩართული მოდულისას */
export function ReportIncidentButton({ className = 'btn sm', ...p }: ReportPrefill & { className?: string }) {
  const on = useModuleEnabled('quality');
  if (!on) return null;
  return <button type="button" className={className} title="ინციდენტის / near-miss-ის შეტყობინება" onClick={() => openIncidentReport(p)}>⚠ ინციდენტი</button>;
}

/** Shell: ღილაკი (შეთავაზებების რაოდენობით) + ფანჯარა */
export function IncidentReportHost() {
  const on = useModuleEnabled('quality');
  const [open, setOpen] = useState<ReportPrefill | null>(null);
  const prompts = useQuery({ queryKey: ['qm-prompts'], queryFn: () => api<Prompt[]>('/quality/prompts').catch(() => [] as Prompt[]), enabled: on, refetchInterval: 5 * 60_000 });
  useEffect(() => {
    const h = (e: Event) => setOpen((e as CustomEvent<ReportPrefill>).detail ?? {});
    window.addEventListener('qm:report', h);
    return () => window.removeEventListener('qm:report', h);
  }, []);
  if (!on) return null;
  const n = prompts.data?.length ?? 0;
  return (
    <>
      <button type="button" className="btn sm" style={{ justifyContent: 'center', gap: 6 }} aria-label={`ინციდენტის შეტყობინება${n ? ` (${n} შეთავაზება)` : ''}`} title="ინციდენტის / near-miss-ის შეტყობინება"
        onClick={() => setOpen({})}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 3l10 18H2L12 3z" /><path d="M12 10v5" /><path d="M12 18h.01" /></svg>
        ინციდენტის შეტყობინება
        {n > 0 && <span className="chip danger" style={{ height: 18, minWidth: 18, padding: '0 5px', fontSize: 11 }}>{n}</span>}
      </button>
      {open && <IncidentReportDialog prefill={open} prompts={prompts.data ?? []} onClose={() => setOpen(null)} />}
    </>
  );
}

interface Dept { id: string; name: string; is_active?: boolean }
interface PatientHit { id: string; first_name: string; last_name: string; personal_number: string | null; birth_date: string | null }
interface PersonHit { id: string; name: string; department_name: string | null }
interface Done { id: string | null; inc_no: string; status: string; urgent: boolean; track_code: string | null }

const nowLocal = () => `${todayISO()}T${hhmm(new Date().toISOString())}`;

export function IncidentReportDialog({ prefill, prompts, onClose }: { prefill: ReportPrefill; prompts: Prompt[]; onClose: () => void }) {
  const qc = useQueryClient();
  const meta = useQmMeta();
  const cats = useQuery({ queryKey: ['qm-classifiers', 'category'], queryFn: () => api<Classifier[]>('/quality/classifiers', { query: { kind: 'category' } }), staleTime: 5 * 60_000 });
  const depts = useQuery({ queryKey: ['departments'], queryFn: () => api<Dept[]>('/departments'), staleTime: 5 * 60_000 });
  const [pf, setPf] = useState<ReportPrefill>(prefill);
  const [f, setF] = useState({
    event_type: 'no_harm' as EventType, affected: (prefill.patient || prefill.source ? 'patient' : 'patient') as Affected, occurred: nowLocal(),
    department_id: prefill.department_id ?? '', location_text: '', category: '', sub: '', harm_reported: 'none' as Harm, merp: '',
    description: '', immediate_actions: '', patient_text: '', identity_mode: '' as IdentityMode | '',
  });
  const [patient, setPatient] = useState<{ id: string; name: string } | null>(prefill.patient ?? null);
  const [source, setSource] = useState<ReportPrefill['source']>(prefill.source ?? null);
  const [people, setPeople] = useState<Person[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [done, setDone] = useState<Done | null>(null);
  const [copied, setCopied] = useState(false);
  const upd = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));

  // ნაგულისხმევები მეტადან / წინასწარი შევსებიდან
  useEffect(() => {
    if (!meta.data) return;
    setF((x) => ({ ...x, department_id: x.department_id || meta.data!.my_department_id || '', identity_mode: x.identity_mode || meta.data!.identity_default }));
  }, [meta.data]);
  const roots = useMemo(() => (cats.data ?? []).filter((c) => !c.parent_id), [cats.data]);
  const subs = useMemo(() => (cats.data ?? []).filter((c) => c.parent_id && c.parent_id === f.category), [cats.data, f.category]);
  useEffect(() => {
    const cid = pf.category_id; if (!cid || !cats.data) return;
    const c = cats.data.find((x) => x.id === cid); if (!c) return;
    setF((x) => ({ ...x, category: c.parent_id ?? c.id, sub: c.parent_id ? c.id : '' }));
  }, [pf.category_id, cats.data]);
  const root = roots.find((c) => c.id === f.category); const sub = subs.find((c) => c.id === f.sub);
  const medication = !!root?.is_medication;
  const harmful = f.event_type === 'harm';

  const fromPrompt = (p: Prompt) => {
    setPf({ category_id: p.category_id }); setSource({ type: p.type, id: p.id, label: p.label }); setPatient(null);
    upd({ event_type: p.reason === 'count' ? 'near_miss' : 'no_harm', harm_reported: 'none', affected: 'patient' });
  };
  const dismiss = useMutation({
    mutationFn: (p: Prompt) => api('/quality/prompts/dismiss', { body: { source_type: p.type, source_id: p.id } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['qm-prompts'] }),
  });

  const submit = useMutation({
    mutationFn: () => {
      const body = {
        event_type: f.event_type, affected: f.affected, occurred_at: new Date(f.occurred).toISOString(), department_id: f.department_id,
        location_text: f.location_text.trim() || null, category_id: f.sub || f.category, harm_reported: harmful ? f.harm_reported : 'none',
        merp_category: medication && meta.data?.ncc_merp && f.merp ? f.merp : null, description: f.description.trim(), immediate_actions: f.immediate_actions.trim() || null,
        patient_id: patient?.id ?? null, patient_text: patient ? null : f.patient_text.trim() || null,
        source_type: source?.type ?? null, source_id: source?.id ?? null, identity_mode: f.identity_mode,
        people: people.map((p) => ({ role: p.role, user_id: p.user_id, name_text: p.user_id ? null : p.name_text, note: p.note })),
      };
      const fd = new FormData(); fd.append('data', JSON.stringify(body)); for (const x of files) fd.append('files', x);
      return apiUpload<Done>('/quality/incidents', fd);
    },
    onSuccess: (r) => { setDone(r); void qc.invalidateQueries({ queryKey: ['qm-prompts'] }); void qc.invalidateQueries({ queryKey: ['qm-mine'] }); void qc.invalidateQueries({ queryKey: ['qm-list'] }); void qc.invalidateQueries({ queryKey: ['qm-summary'] }); },
  });

  if (done) {
    return (
      <Modal title="შეტყობინება გაიგზავნა" onClose={onClose} width={560} footer={<button className="btn primary" type="button" onClick={onClose}>დახურვა</button>}>
        <div className="stack">
          <div className="alert ok">გმადლობთ! შეტყობინება <strong className="mono">{done.inc_no}</strong> რეგისტრირებულია{done.urgent ? ' და ხარისხის მენეჯერს სასწრაფოდ ეცნობა' : ''}.</div>
          {done.track_code ? (
            <div className="card card-pad stack" style={{ gap: 8 }}>
              <strong>სტატუსის სანახავი კოდი</strong>
              <div className="row"><span className="mono" style={{ fontSize: 20, letterSpacing: 1 }}>{done.track_code}</span>
                <button className="btn sm" type="button" onClick={async () => setCopied(await copyText(done.track_code!))}>{copied ? 'დაკოპირდა' : 'კოპირება'}</button></div>
              <span className="small">შეინახეთ კოდი — ის მეორედ აღარ გამოჩნდება და სისტემაში თქვენთან დაკავშირებული არ არის. სტატუსი: „ხარისხი და ინციდენტები“ → „ჩემი შეტყობინებები“ → „კოდით“.</span>
            </div>
          ) : done.id ? <span className="small">სტატუსს ნახავთ: <Link to="/quality?tab=mine" onClick={onClose}>ხარისხი და ინციდენტები → ჩემი შეტყობინებები</Link>.</span> : null}
        </div>
      </Modal>
    );
  }
  const okBase = f.department_id && (f.sub || f.category) && f.description.trim().length >= 10 && f.identity_mode && (!harmful || f.harm_reported !== 'none')
    && (f.affected !== 'patient' || patient || source?.type || f.patient_text.trim().length >= 2);
  const m = meta.data;
  return (
    <Modal title="ინციდენტის / near-miss-ის შეტყობინება" onClose={onClose} width={860}
      footer={<><span className="small muted grow">შეტყობინება არ არის დასჯის საფუძველი — მიზანი სისტემის გაუმჯობესებაა.</span>
        <button className="btn" type="button" onClick={onClose}>გაუქმება</button>
        <button className="btn primary" type="button" disabled={!okBase || submit.isPending} onClick={() => submit.mutate()}>გაგზავნა</button></>}>
      <div className="stack">
        {prompts.length > 0 && !source && (
          <div className="card card-pad stack" style={{ gap: 6 }}>
            <strong className="small">შესაძლო ინციდენტები (ბოლო 48 სთ, თქვენი მონაწილეობით)</strong>
            {prompts.map((p) => (
              <div key={`${p.type}:${p.id}`} className="row" style={{ gap: 8 }}>
                <span className="grow small">{p.label} · <span className="muted">{p.reason === 'missed' ? 'გამოტოვებული დოზა' : p.reason === 'override' ? 'გაფრთხილება გადალახულია' : 'დათვლის შეუსაბამობა'} · {tsDate(p.at!)} {hhmm(p.at!)}</span></span>
                <button className="btn sm" type="button" onClick={() => fromPrompt(p)}>შეტყობინება</button>
                <button className="btn sm" type="button" disabled={dismiss.isPending} onClick={() => dismiss.mutate(p)}>არ არის ინციდენტი</button>
              </div>))}
          </div>)}
        <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0, gap: 6 }}>
          <legend className="small" style={{ fontWeight: 600, marginBottom: 6 }}>რა მოხდა</legend>
          <div className="seg" role="group" aria-label="მოვლენის ტიპი" style={{ flexWrap: 'wrap' }}>
            {(Object.keys(EVENT_KA) as EventType[]).map((k) => <button key={k} type="button" aria-pressed={f.event_type === k} title={EVENT_KA[k][1]}
              onClick={() => upd({ event_type: k, harm_reported: k === 'harm' ? (f.harm_reported === 'none' ? 'mild' : f.harm_reported) : 'none', affected: k === 'hazard' ? 'none' : f.affected === 'none' ? 'patient' : f.affected })}>{EVENT_KA[k][0]}</button>)}
          </div>
          <span className="small muted">{EVENT_KA[f.event_type][1]}</span>
        </fieldset>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
          <Field label="როდის" htmlFor="qm-at" required><input id="qm-at" className="input" type="datetime-local" max={nowLocal()} value={f.occurred} onChange={(e) => upd({ occurred: e.target.value })} /></Field>
          <Field label="განყოფილება" htmlFor="qm-dept" required>
            <select id="qm-dept" className="select" value={f.department_id} onChange={(e) => upd({ department_id: e.target.value })}>
              <option value="">— აირჩიეთ —</option>{depts.data?.filter((d) => d.is_active !== false).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
          <Field label="ადგილი" htmlFor="qm-loc" hint="პალატა, ოთახი, დერეფანი…"><input id="qm-loc" className="input" maxLength={200} value={f.location_text} onChange={(e) => upd({ location_text: e.target.value })} /></Field>
          <Field label="კატეგორია" htmlFor="qm-cat" required>
            <select id="qm-cat" className="select" value={f.category} onChange={(e) => upd({ category: e.target.value, sub: '', merp: '' })}>
              <option value="">— აირჩიეთ —</option>{roots.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
          <Field label="ქვეკატეგორია" htmlFor="qm-sub" hint={sub?.is_sentinel ? 'სენტინელური მოვლენა — ხარისხის მენეჯერს სასწრაფოდ ეცნობება' : undefined}>
            <select id="qm-sub" className="select" value={f.sub} disabled={!subs.length} onChange={(e) => upd({ sub: e.target.value })}>
              <option value="">{subs.length ? '— არჩევითი —' : '—'}</option>{subs.map((c) => <option key={c.id} value={c.id}>{c.name}{c.is_sentinel ? ' ⚑' : ''}</option>)}</select></Field>
          <Field label="ვის შეეხო" htmlFor="qm-aff" required>
            <select id="qm-aff" className="select" value={f.affected} onChange={(e) => upd({ affected: e.target.value as Affected })}>
              {(Object.keys(AFFECTED_KA) as Affected[]).filter((k) => k !== 'none' || ['hazard', 'near_miss'].includes(f.event_type)).map((k) => <option key={k} value={k}>{AFFECTED_KA[k]}</option>)}</select></Field>
          <Field label="ზიანი (წინასწარი შეფასება)" htmlFor="qm-harm" required={harmful} hint={harmful ? 'საბოლოოს ხარისხის მენეჯერი დაადგენს' : 'ამ ტიპზე — „არ არის“'}>
            <select id="qm-harm" className="select" value={harmful ? f.harm_reported : 'none'} disabled={!harmful} onChange={(e) => upd({ harm_reported: e.target.value as Harm })}>
              {(Object.keys(HARM_KA) as Harm[]).filter((k) => !harmful || k !== 'none').map((k) => <option key={k} value={k}>{HARM_KA[k]}</option>)}</select></Field>
          {medication && m?.ncc_merp && (
            <Field label="NCC MERP (არჩევითი)" htmlFor="qm-merp">
              <select id="qm-merp" className="select" value={f.merp} onChange={(e) => upd({ merp: e.target.value })}>
                <option value="">—</option>{Object.entries(MERP_KA).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>)}
        </div>

        <PatientBlock canLookup={!!m?.can_lookup} patient={patient} setPatient={(p) => { setPatient(p); if (!p || (source && p.id !== patient?.id)) setSource(null); }}
          source={source ?? null} setSource={setSource} text={f.patient_text} setText={(t) => upd({ patient_text: t })} required={f.affected === 'patient'} />

        <Field label="აღწერა — რა მოხდა" htmlFor="qm-desc" required hint="ფაქტები: რა, როგორ, თანმიმდევრობა; ბრალდებების გარეშე (მინ. 10 სიმბოლო)">
          <textarea id="qm-desc" className="textarea" rows={4} maxLength={8000} value={f.description} onChange={(e) => upd({ description: e.target.value })} /></Field>
        <Field label="დაუყოვნებლივ მიღებული ზომები" htmlFor="qm-act"><textarea id="qm-act" className="textarea" rows={2} maxLength={4000} value={f.immediate_actions} onChange={(e) => upd({ immediate_actions: e.target.value })} /></Field>

        <PeopleBlock people={people} setPeople={setPeople} />

        <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-start', gap: 16 }}>
          <Field label="ფაილები (ფოტო / PDF, ≤ 5, თითო ≤ 10 MB)" htmlFor="qm-files">
            <input id="qm-files" type="file" multiple accept="image/jpeg,image/png,application/pdf" onChange={(e) => setFiles(Array.from(e.target.files ?? []).slice(0, 5))} /></Field>
          <fieldset className="stack grow" style={{ border: 0, padding: 0, margin: 0, gap: 4 }}>
            <legend className="small" style={{ fontWeight: 600, marginBottom: 4 }}>ავტორი</legend>
            {(m?.identity_modes ?? []).map((k) => (
              <label key={k} className="row small" style={{ gap: 6 }}><input type="radio" name="qm-id" checked={f.identity_mode === k} onChange={() => upd({ identity_mode: k })} />
                <strong>{IDENTITY_KA[k][0]}</strong> <span className="muted">— {k === 'anonymous' && !m?.anonymous_tracking ? 'სახელი არსად ინახება' : IDENTITY_KA[k][1]}</span></label>))}
          </fieldset>
        </div>
        <ErrorBox error={submit.error} />
      </div>
    </Modal>
  );
}

function PatientBlock({ canLookup, patient, setPatient, source, setSource, text, setText, required }: {
  canLookup: boolean; patient: { id: string; name: string } | null; setPatient: (p: { id: string; name: string } | null) => void;
  source: { type: SourceType; id: string; label: string } | null; setSource: (s: { type: SourceType; id: string; label: string } | null) => void;
  text: string; setText: (t: string) => void; required: boolean;
}) {
  const [q, setQ] = useState(''); const dq = useDebounced(q.trim(), 250);
  const hits = useQuery({ queryKey: ['qm-patients', dq], queryFn: () => api<PatientHit[]>('/quality/patients', { query: { q: dq } }), enabled: canLookup && dq.length >= 2 && !patient });
  const pid = patient?.id;
  const srcs = useQuery({ queryKey: ['qm-sources', pid], queryFn: () => api<Source[]>('/quality/sources', { query: { patient_id: pid } }), enabled: canLookup && !!pid });
  return (
    <div className="card card-pad stack" style={{ gap: 8 }}>
      <strong className="small">პაციენტი და მიბმული მოვლენა {required && <span className="muted">(პაციენტზე — სავალდებულო)</span>}</strong>
      {source && <div className="row small"><span className="chip info">{source.label}</span><button className="btn sm" type="button" onClick={() => setSource(null)}>მოხსნა</button></div>}
      {patient ? (
        <div className="row small"><strong>{patient.name}</strong><button className="btn sm" type="button" onClick={() => setPatient(null)}>შეცვლა</button></div>
      ) : canLookup ? (
        <div className="stack" style={{ gap: 4 }}>
          <input className="input" aria-label="პაციენტის ძებნა" placeholder="პირადი ნომერი ან სახელი, გვარი" value={q} onChange={(e) => setQ(e.target.value)} />
          {hits.data?.map((p) => <button key={p.id} type="button" className="btn sm" style={{ justifyContent: 'flex-start' }}
            onClick={() => { setPatient({ id: p.id, name: `${p.first_name} ${p.last_name}` }); setQ(''); }}>
            {p.first_name} {p.last_name} <span className="muted mono">{p.personal_number ?? ''}{p.birth_date ? ` · ${dateGe(p.birth_date)}` : ''}</span></button>)}
          {!source && <input className="input" aria-label="პაციენტი ტექსტად" placeholder="ან ჩაწერეთ: სახელი / პალატა (თუ ძებნით ვერ პოულობთ)" maxLength={200} value={text} onChange={(e) => setText(e.target.value)} />}
        </div>
      ) : !source && (
        <input className="input" aria-label="პაციენტი" placeholder="სახელი, გვარი / პალატა" maxLength={200} value={text} onChange={(e) => setText(e.target.value)} />
      )}
      {patient && !source && (srcs.data?.length ?? 0) > 0 && (
        <select className="select" aria-label="მიბმული მოვლენა" value="" onChange={(e) => { const s = srcs.data!.find((x) => `${x.type}:${x.id}` === e.target.value); if (s) setSource({ type: s.type, id: s.id, label: s.label }); }}>
          <option value="">— მიაბით მოვლენა (არჩევითი): MAR, ოპერაცია, კვლევა… —</option>
          {srcs.data!.map((s) => <option key={`${s.type}:${s.id}`} value={`${s.type}:${s.id}`}>{s.label}{s.at ? ` · ${tsDate(s.at)}` : ''}</option>)}
        </select>)}
    </div>
  );
}

function PeopleBlock({ people, setPeople }: { people: Person[]; setPeople: (p: Person[]) => void }) {
  const [q, setQ] = useState(''); const dq = useDebounced(q.trim(), 250);
  const [role, setRole] = useState<Person['role']>('involved');
  const hits = useQuery({ queryKey: ['qm-people', dq], queryFn: () => api<PersonHit[]>('/quality/people', { query: { search: dq } }), enabled: dq.length >= 2 });
  const add = (p: Person) => { setPeople([...people, p]); setQ(''); };
  return (
    <details>
      <summary className="small" style={{ cursor: 'pointer', fontWeight: 600 }}>მონაწილეები / მოწმეები (არჩევითი){people.length ? ` — ${people.length}` : ''}</summary>
      <div className="stack" style={{ gap: 6, marginTop: 8 }}>
        <span className="small muted">ჩანს მხოლოდ ხარისხის მენეჯერთან; პირის მიხედვით რეიტინგი არ კეთდება.</span>
        {people.map((p, i) => <div key={i} className="row small"><span className="chip">{PERSON_ROLE_KA[p.role]}</span><span className="grow">{p.user_name ?? p.name_text}</span>
          <button className="btn sm" type="button" onClick={() => setPeople(people.filter((_, j) => j !== i))}>×</button></div>)}
        <div className="row" style={{ gap: 6 }}>
          <select className="select" style={{ maxWidth: 160 }} aria-label="როლი" value={role} onChange={(e) => setRole(e.target.value as Person['role'])}>
            {Object.entries(PERSON_ROLE_KA).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          <input className="input grow" aria-label="თანამშრომელი ან სახელი" placeholder="თანამშრომლის ძებნა ან სახელი (Enter)" value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && q.trim().length >= 2) { e.preventDefault(); add({ role, user_id: null, name_text: q.trim(), note: null }); } }} />
        </div>
        {dq.length >= 2 && <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>{hits.data?.slice(0, 8).map((h) =>
          <button key={h.id} className="btn sm" type="button" onClick={() => add({ role, user_id: h.id, name_text: null, note: null, user_name: h.name })}>+ {h.name}{h.department_name ? ` · ${h.department_name}` : ''}</button>)}</div>}
      </div>
    </details>
  );
}
