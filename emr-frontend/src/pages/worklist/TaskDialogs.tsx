import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Field, Loading, Modal, useDebounced } from '../../components/ui';
import { localISO, time, tsDate } from '../../lib/format';
import { EVENT_KA, PRIORITY_CHIP, PRIORITY_KA, STATUS_CHIP, TARGET_KA, useWlRefs, type Priority, type Refs, type Target, type TargetKind, type Task } from './types';

export const dueLabel = (iso: string | null, dateOnly = false) => (iso ? (dateOnly ? tsDate(iso) : `${tsDate(iso)} ${time(iso)}`) : '—');
/** datetime-local (YYYY-MM-DDTHH:MM) ↔ ISO (კლინიკის დრო) */
const toLocal = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tbilisi', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '00';
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}`;
};
const fromLocal = (v: string) => (v ? localISO(v.slice(0, 10), v.slice(11, 16)) : null);
const invalidate = (qc: ReturnType<typeof useQueryClient>) => {
  for (const k of ['wl-mine', 'wl-tasks', 'wl-team', 'wl-count', 'wl-task', 'wl-patient']) void qc.invalidateQueries({ queryKey: [k] });
};

// ---------------------------------------------------------------- სამიზნე
export function TargetPicker({ refs, value, onChange, idp }: { refs: Refs; value: Target; onChange: (t: Target) => void; idp: string }) {
  const { user } = useAuth();
  const [search, setSearch] = useState('');
  const q = useDebounced(search, 300);
  const people = useQuery({ queryKey: ['wl-people', q], queryFn: () => api<{ id: string; name: string; department_name: string | null }[]>('/worklist/people', { query: { search: q } }),
    enabled: value.target_kind === 'user' && q.trim().length >= 2 });
  const [picked, setPicked] = useState<string | null>(null);
  const kinds = (Object.keys(TARGET_KA) as TargetKind[]).filter((k) => k !== 'duty' || refs.duty_roles.length > 0);
  const set = (p: Partial<Target>) => onChange({ ...value, ...p });
  return (
    <div className="stack" style={{ gap: 8 }}>
      <Field label="ვის" htmlFor={`${idp}-k`}>
        <select id={`${idp}-k`} className="select" value={value.target_kind}
          onChange={(e) => onChange({ target_kind: e.target.value as TargetKind, assignee_id: e.target.value === 'user' ? user?.id ?? null : null })}>
          {kinds.map((k) => <option key={k} value={k}>{TARGET_KA[k]}</option>)}</select>
      </Field>
      {value.target_kind === 'user' && <div className="stack" style={{ gap: 6 }}>
        <div className="row small" style={{ gap: 8 }}>
          <span className="grow">{value.assignee_id === user?.id ? <strong>მე ({user?.name})</strong> : picked ? <strong>{picked}</strong> : value.assignee_id ? 'არჩეულია' : 'აირჩიეთ თანამშრომელი'}</span>
          {value.assignee_id !== user?.id && <button type="button" className="btn sm" onClick={() => { setPicked(null); set({ assignee_id: user?.id ?? null }); }}>მე</button>}
        </div>
        <input className="input" aria-label="თანამშრომლის ძებნა" placeholder="სხვა თანამშრომელი — გვარი / სახელი (მინ. 2 ასო)" value={search} onChange={(e) => setSearch(e.target.value)} />
        {!!people.data?.length && <div className="card" style={{ maxHeight: 180, overflowY: 'auto' }}>
          {people.data.map((p) => <button key={p.id} type="button" className="card-pad" style={{ display: 'block', width: '100%', textAlign: 'left', border: 0, borderTop: '1px solid var(--line-soft)', background: value.assignee_id === p.id ? 'var(--info-weak)' : 'transparent', cursor: 'pointer', font: 'inherit', padding: '6px 10px' }}
            onClick={() => { setPicked(p.name); set({ assignee_id: p.id }); setSearch(''); }}>{p.name} <span className="small muted">{p.department_name ?? ''}</span></button>)}
        </div>}
      </div>}
      {(value.target_kind === 'role' || value.target_kind === 'role_department') && <Field label="როლი" htmlFor={`${idp}-r`}>
        <select id={`${idp}-r`} className="select" value={value.target_role_id ?? ''} onChange={(e) => set({ target_role_id: e.target.value || null })}>
          <option value="">—</option>{refs.roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>}
      {(value.target_kind === 'department' || value.target_kind === 'role_department') && <Field label="განყოფილება" htmlFor={`${idp}-d`}>
        <select id={`${idp}-d`} className="select" value={value.target_department_id ?? ''} onChange={(e) => set({ target_department_id: e.target.value || null })}>
          <option value="">—</option>{refs.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>}
      {value.target_kind === 'duty' && <Field label="მორიგის როლი" htmlFor={`${idp}-du`} hint="მიმღები — ვინც ნახვის მომენტში მორიგეა (გამოქვეყნებული განრიგით)">
        <select id={`${idp}-du`} className="select" value={value.target_duty_role_id ?? ''} onChange={(e) => set({ target_duty_role_id: e.target.value || null })}>
          <option value="">—</option>{refs.duty_roles.map((d) => <option key={d.id} value={d.id}>{d.name}{d.department_name ? ` · ${d.department_name}` : ''}</option>)}</select></Field>}
      {value.target_kind !== 'user' && <span className="hint">ჯგუფური დავალება: წევრიდან ერთი იღებს („ავიღებ“), სხვები ხედავენ, ვინ აიღო.</span>}
    </div>
  );
}
const targetOk = (t: Target) => (t.target_kind === 'user' ? !!t.assignee_id : t.target_kind === 'role' ? !!t.target_role_id : t.target_kind === 'department' ? !!t.target_department_id
  : t.target_kind === 'role_department' ? !!t.target_role_id && !!t.target_department_id : !!t.target_duty_role_id);

// ---------------------------------------------------------------- ახალი დავალება
export function NewTaskDialog({ onClose, patient, encounterId, onCreated }: { onClose: () => void; patient?: { id: string; name: string } | null; encounterId?: string | null; onCreated?: (t: Task) => void }) {
  const refs = useWlRefs(); const qc = useQueryClient(); const { user } = useAuth();
  const [f, setF] = useState({ title: '', description: '', category_id: '', priority: 'normal' as Priority, due: '' });
  const [tg, setTg] = useState<Target>({ target_kind: 'user', assignee_id: user?.id ?? null });
  const [pat, setPat] = useState<{ id: string; name: string } | null>(patient ?? null);
  const [ps, setPs] = useState(''); const pq = useDebounced(ps, 300);
  const pats = useQuery({ queryKey: ['wl-pat', pq], queryFn: () => api<{ id: string; name: string; personal_number: string | null }[]>('/worklist/patients', { query: { q: pq } }),
    enabled: !patient && !!refs.data?.can.patients && pq.trim().length >= 2 });
  const cat = refs.data?.categories.find((c) => c.id === f.category_id);
  const save = useMutation({
    mutationFn: () => api<Task>('/worklist/tasks', { body: { title: f.title.trim(), description: f.description.trim() || null, category_id: f.category_id || null, priority: f.priority,
      due_at: fromLocal(f.due), ...tg, patient_id: pat?.id ?? null, encounter_id: pat && patient && pat.id === patient.id ? encounterId ?? null : null } }),
    onSuccess: (t) => { invalidate(qc); onCreated?.(t); onClose(); },
  });
  const pickCat = (id: string) => {
    setF({ ...f, category_id: id });
    const c = refs.data?.categories.find((x) => x.id === id);
    if (c?.default_target_kind) setTg({ target_kind: c.default_target_kind, target_role_id: c.default_role_id, target_department_id: c.default_department_id });
    if (c && !c.allow_patient && !patient) setPat(null);
  };
  const allowPatient = !!refs.data?.settings.patient_tasks && (!cat || cat.allow_patient);
  return (
    <Modal title="ახალი დავალება" onClose={onClose} width={640}
      footer={<><button type="button" className="btn" onClick={onClose}>გაუქმება</button>
        <button type="button" className="btn primary" disabled={save.isPending || f.title.trim().length < 3 || !targetOk(tg) || (!!patient && !allowPatient)} onClick={() => save.mutate()}>შექმნა</button></>}>
      {!refs.data ? <Loading /> : <div className="stack">
        <Field label="სათაური" htmlFor="nt-t" required><input id="nt-t" className="input" maxLength={200} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <Field label="აღწერა" htmlFor="nt-d"><textarea id="nt-d" className="textarea" rows={3} maxLength={4000} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <div className="row" style={{ gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <Field label="კატეგორია" htmlFor="nt-c" hint={cat?.sla_hours ? `SLA: ${cat.sla_hours} სთ (თუ ვადა ცარიელია)` : undefined}>
            <select id="nt-c" className="select" value={f.category_id} onChange={(e) => pickCat(e.target.value)}>
              <option value="">—</option>{refs.data.categories.filter((c) => c.is_active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
          <Field label="პრიორიტეტი" htmlFor="nt-p"><select id="nt-p" className="select" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value as Priority })}>
            {(Object.keys(PRIORITY_KA) as Priority[]).map((p) => <option key={p} value={p}>{PRIORITY_KA[p]}</option>)}</select></Field>
          <Field label="ვადა" htmlFor="nt-due" hint="ცარიელი — კატეგორიის SLA / პრიორიტეტის ნაგულისხმევი"><input id="nt-due" className="input" type="datetime-local" value={f.due} onChange={(e) => setF({ ...f, due: e.target.value })} /></Field>
        </div>
        <TargetPicker refs={refs.data} value={tg} onChange={setTg} idp="nt" />
        {allowPatient && (patient ? <div className="alert info small">პაციენტი: <strong>{patient.name}</strong> — დავალება <strong>არ არის დანიშნულება</strong>; მედიკამენტი / კვლევა — მხოლოდ დანიშნულებით.</div>
          : refs.data.can.patients && <Field label="პაციენტი (არჩევითი)" htmlFor="nt-pat" hint="დავალება არ არის დანიშნულება — მედიკამენტი / კვლევა მხოლოდ დანიშნულებით (CPOE / MAR)">
            {pat ? <div className="row small"><strong className="grow">{pat.name}</strong><button type="button" className="btn sm" onClick={() => setPat(null)}>მოხსნა</button></div>
              : <><input id="nt-pat" className="input" placeholder="პირადი № / გვარი" value={ps} onChange={(e) => setPs(e.target.value)} />
                {!!pats.data?.length && <div className="card" style={{ maxHeight: 160, overflowY: 'auto' }}>{pats.data.map((p) => <button key={p.id} type="button" className="card-pad"
                  style={{ display: 'block', width: '100%', textAlign: 'left', border: 0, borderTop: '1px solid var(--line-soft)', background: 'transparent', cursor: 'pointer', font: 'inherit', padding: '6px 10px' }}
                  onClick={() => { setPat({ id: p.id, name: p.name }); setPs(''); }}>{p.name} <span className="small muted mono">{p.personal_number ?? ''}</span></button>)}</div>}</>}
          </Field>)}
        {!!patient && !allowPatient && <div className="alert warn small">ამ კატეგორიაზე / პარამეტრით პაციენტის მიბმა არ არის დაშვებული.</div>}
        <ErrorBox error={save.error} />
      </div>}
    </Modal>
  );
}

// ---------------------------------------------------------------- დავალება (ნახვა / ქმედებები)
export function TaskDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient(); const refs = useWlRefs();
  const q = useQuery({ queryKey: ['wl-task', id], queryFn: () => api<Task>(`/worklist/tasks/${id}`) });
  const [mode, setMode] = useState<null | 'done' | 'cancel' | 'reopen' | 'release' | 'edit' | 'reassign'>(null);
  const [note, setNote] = useState(''); const [comment, setComment] = useState('');
  const [ed, setEd] = useState<{ title: string; description: string; priority: Priority; due: string; category_id: string } | null>(null);
  const [tg, setTg] = useState<Target | null>(null);
  const act = useMutation({
    mutationFn: ({ path, body, method }: { path: string; body?: unknown; method?: string }) => api<Task>(`/worklist/tasks/${id}${path}`, { method: method ?? 'POST', body: body ?? {} }),
    onSuccess: (t) => { qc.setQueryData(['wl-task', id], t); invalidate(qc); setMode(null); setNote(''); setComment(''); },
  });
  const t = q.data; const c = t?.can;
  const needDoneNote = !!t && !!refs.data && (refs.data.settings.done_comment === 'all' || (refs.data.settings.done_comment === 'urgent' && t.priority === 'urgent'));
  return (
    <Modal title={t ? `${t.task_no}: ${t.title}` : 'დავალება'} onClose={onClose} width={720}>
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : t && <div className="stack">
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <span className={`chip ${STATUS_CHIP[t.status] ?? ''}`}>{t.status_name}</span>
          <span className={`chip ${PRIORITY_CHIP[t.priority]}`}>{t.priority_name}</span>
          {t.overdue && <span className="chip danger">ვადაგადაცილებული</span>}
          {t.escalated_at && <span className="chip danger">ესკალაცია</span>}
          {t.category_name && <span className="chip">{t.category_name}</span>}
        </div>
        {t.patient_id && <div className="alert info small">პაციენტი: <Link to={`/patients/${t.patient_id}`}><strong>{t.patient_name}</strong></Link>{t.patient_personal_number ? ` (${t.patient_personal_number})` : ''} — დავალება <strong>არ არის დანიშნულება</strong>.</div>}
        {t.description && <div style={{ whiteSpace: 'pre-line' }}>{t.description}</div>}
        <table className="table small"><tbody>
          <tr><th>ვის</th><td>{TARGET_KA[t.target_kind]}: <strong>{t.target_label}</strong>{t.group && <> · {t.claimed_by_name ? <>აიღო <strong>{t.claimed_by_name}</strong></> : <span className="muted">ჯერ არავინ აიღო</span>}</>}</td></tr>
          <tr><th>ვადა</th><td style={{ color: t.overdue ? 'var(--danger-ink)' : undefined }}>{dueLabel(t.due_at)}</td></tr>
          <tr><th>შექმნა</th><td>{t.created_by_name} · {dueLabel(t.created_at)}{t.department_name ? ` · ${t.department_name}` : ''}</td></tr>
          {t.done_at && <tr><th>შესრულდა</th><td>{dueLabel(t.done_at)}{t.done_note ? ` — ${t.done_note}` : ''}</td></tr>}
          {t.cancelled_at && <tr><th>გაუქმდა</th><td>{dueLabel(t.cancelled_at)} — {t.cancel_reason}</td></tr>}
        </tbody></table>

        {!mode && <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {c?.claim && <button type="button" className="btn sm primary" disabled={act.isPending} onClick={() => act.mutate({ path: '/claim' })}>ავიღებ</button>}
          {c?.start && <button type="button" className="btn sm" disabled={act.isPending} onClick={() => act.mutate({ path: '/start' })}>დაწყება</button>}
          {c?.done && <button type="button" className="btn sm primary" onClick={() => setMode('done')}>შესრულებულია</button>}
          {c?.release && <button type="button" className="btn sm" onClick={() => setMode('release')}>დაბრუნება ჯგუფში</button>}
          {c?.edit && <button type="button" className="btn sm" onClick={() => { setEd({ title: t.title, description: t.description ?? '', priority: t.priority, due: toLocal(t.due_at), category_id: t.category_id ?? '' }); setMode('edit'); }}>რედაქტირება</button>}
          {c?.reassign && <button type="button" className="btn sm" onClick={() => { setTg({ target_kind: t.target_kind, assignee_id: t.assignee_id, target_role_id: t.target_role_id, target_department_id: t.target_department_id, target_duty_role_id: t.target_duty_role_id }); setMode('reassign'); }}>გადანაწილება</button>}
          {c?.cancel && <button type="button" className="btn sm danger" onClick={() => setMode('cancel')}>გაუქმება</button>}
          {c?.reopen && <button type="button" className="btn sm" onClick={() => setMode('reopen')}>ხელახლა გახსნა</button>}
        </div>}
        {(mode === 'done' || mode === 'cancel' || mode === 'reopen' || mode === 'release') && <div className="card card-pad stack">
          <Field label={mode === 'done' ? `შესრულების კომენტარი${needDoneNote ? ' (სავალდებულო)' : ''}` : mode === 'release' ? 'კომენტარი (არჩევითი)' : 'მიზეზი (სავალდებულო)'} htmlFor="td-n">
            <textarea id="td-n" className="textarea" rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          <div className="row" style={{ gap: 6 }}><span className="grow" />
            <button type="button" className="btn sm" onClick={() => { setMode(null); setNote(''); }}>უკან</button>
            <button type="button" className={`btn sm ${mode === 'cancel' ? 'danger' : 'primary'}`} disabled={act.isPending || ((mode === 'cancel' || mode === 'reopen' || (mode === 'done' && needDoneNote)) && note.trim().length < 3)}
              onClick={() => act.mutate(mode === 'done' ? { path: '/done', body: { note: note.trim() || null } } : mode === 'release' ? { path: '/release', body: { note: note.trim() || null } }
                : { path: `/${mode}`, body: { reason: note.trim() } })}>დადასტურება</button></div>
        </div>}
        {mode === 'edit' && ed && refs.data && <div className="card card-pad stack">
          <Field label="სათაური" htmlFor="te-t"><input id="te-t" className="input" value={ed.title} onChange={(e) => setEd({ ...ed, title: e.target.value })} /></Field>
          <Field label="აღწერა" htmlFor="te-d"><textarea id="te-d" className="textarea" rows={3} value={ed.description} onChange={(e) => setEd({ ...ed, description: e.target.value })} /></Field>
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
            <Field label="კატეგორია" htmlFor="te-c"><select id="te-c" className="select" value={ed.category_id} onChange={(e) => setEd({ ...ed, category_id: e.target.value })}>
              <option value="">—</option>{refs.data.categories.filter((x) => x.is_active || x.id === ed.category_id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
            <Field label="პრიორიტეტი" htmlFor="te-p"><select id="te-p" className="select" value={ed.priority} onChange={(e) => setEd({ ...ed, priority: e.target.value as Priority })}>
              {(Object.keys(PRIORITY_KA) as Priority[]).map((p) => <option key={p} value={p}>{PRIORITY_KA[p]}</option>)}</select></Field>
            <Field label="ვადა" htmlFor="te-due"><input id="te-due" className="input" type="datetime-local" value={ed.due} onChange={(e) => setEd({ ...ed, due: e.target.value })} /></Field>
          </div>
          <div className="row" style={{ gap: 6 }}><span className="grow" /><button type="button" className="btn sm" onClick={() => setMode(null)}>უკან</button>
            <button type="button" className="btn sm primary" disabled={act.isPending || ed.title.trim().length < 3} onClick={() => act.mutate({ path: '', method: 'PATCH', body: {
              title: ed.title.trim(), description: ed.description.trim() || null, priority: ed.priority, category_id: ed.category_id || null,
              ...(ed.due !== toLocal(t.due_at) && { due_at: fromLocal(ed.due) }) } })}>შენახვა</button></div>
        </div>}
        {mode === 'reassign' && tg && refs.data && <div className="card card-pad stack">
          <TargetPicker refs={refs.data} value={tg} onChange={setTg} idp="tr" />
          <Field label="კომენტარი (არჩევითი)" htmlFor="tr-n"><input id="tr-n" className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          <div className="row" style={{ gap: 6 }}><span className="grow" /><button type="button" className="btn sm" onClick={() => setMode(null)}>უკან</button>
            <button type="button" className="btn sm primary" disabled={act.isPending || !targetOk(tg)} onClick={() => act.mutate({ path: '/reassign', body: { ...tg, note: note.trim() || null } })}>გადანაწილება</button></div>
        </div>}
        <ErrorBox error={act.error} />

        <strong className="small">ისტორია / კომენტარები</strong>
        <div className="stack" style={{ gap: 4 }}>
          {t.events?.map((e) => <div key={e.id} className="small" style={{ borderLeft: `3px solid ${e.kind === 'comment' ? 'var(--accent)' : e.kind === 'escalated' ? 'var(--danger-ink)' : 'var(--line)'}`, paddingLeft: 8 }}>
            <span className="muted">{dueLabel(e.created_at)}</span> · <strong>{EVENT_KA[e.kind] ?? e.kind}</strong>{e.user_name ? ` — ${e.user_name}` : ''}
            {e.note && <div style={{ whiteSpace: 'pre-line' }}>{e.note}</div>}
          </div>)}
        </div>
        <div className="row" style={{ gap: 6 }}>
          <input className="input grow" aria-label="კომენტარი" placeholder="კომენტარი…" value={comment} maxLength={2000} onChange={(e) => setComment(e.target.value)} />
          <button type="button" className="btn sm" disabled={!comment.trim() || act.isPending} onClick={() => act.mutate({ path: '/comment', body: { note: comment.trim() } })}>დამატება</button>
        </div>
      </div>}
    </Modal>
  );
}
