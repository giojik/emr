import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Field, Loading, Modal } from '../../components/ui';
import { TargetPicker, dueLabel } from './TaskDialogs';
import { PRIORITY_CHIP, PRIORITY_KA, TARGET_KA, type Priority, type Refs, type Target, type TargetKind } from './types';

/**
 * 0084 — განმეორებადი (გრაფიკით) ხელით დავალებები: ყოველდღე / კვირის დღეებით / თვის რიცხვი / ყოველ N საათში.
 * worker დგომის მომენტში ქმნის დავალებას; წინა ღიაა — გამოტოვება / მაინც / ჩანაცვლება. პაციენტის მიბმა — არა.
 */
type Freq = 'daily' | 'weekly' | 'monthly' | 'hourly';
interface Schedule {
  id: string; title: string; description: string | null; category_id: string | null; category_name: string | null; priority: Priority; due_hours: number;
  target_kind: TargetKind; target_label: string; assignee_id: string | null; target_role_id: string | null; target_department_id: string | null; target_duty_role_id: string | null;
  department_name: string | null; freq: Freq; times: string[]; weekdays: number[]; month_day: number | null; every_hours: number | null; starts_on: string; ends_on: string | null;
  prev_open: 'skip' | 'create' | 'replace'; is_active: boolean; next_at: string | null; last_occurrence_at: string | null; created_by_name: string | null; open_tasks: number; total_tasks: number;
  can_manage: boolean;
  runs?: { id: number; occurrence_at: string; result: string; task_id: string | null; task_no: string | null; task_status: string | null; created_at: string }[];
}
const FREQ_KA: Record<Freq, string> = { daily: 'ყოველდღე', weekly: 'კვირის დღეებით', monthly: 'თვის რიცხვი', hourly: 'ყოველ N საათში' };
const DOW = ['ორშ', 'სამ', 'ოთხ', 'ხუთ', 'პარ', 'შაბ', 'კვ'];
const PREV_KA = { skip: 'გამოტოვება (წინა ჯერ ღიაა)', create: 'მაინც შეიქმნას', replace: 'წინა გაუქმდეს — ახლით ჩანაცვლება' };
const RUN_KA: Record<string, string> = { created: 'შეიქმნა', skipped: 'გამოტოვდა — წინა ღიაა', replaced: 'ჩანაცვლდა' };
export const ruleLabel = (s: Pick<Schedule, 'freq' | 'times' | 'weekdays' | 'month_day' | 'every_hours'>) =>
  s.freq === 'daily' ? `ყოველდღე ${s.times.join(', ')}`
    : s.freq === 'weekly' ? `${s.weekdays.map((d) => DOW[d - 1]).join(', ')} · ${s.times.join(', ')}`
      : s.freq === 'monthly' ? `თვის ${s.month_day === 0 ? 'ბოლო დღე' : `${s.month_day}`} · ${s.times.join(', ')}`
        : `ყოველ ${s.every_hours} სთ-ში (${s.times[0]}-დან)`;

export function SchedulesPage({ refs, onOpenTask }: { refs: Refs; onOpenTask: (id: string) => void }) {
  const [box, setBox] = useState<'mine' | 'team'>('mine');
  const [edit, setEdit] = useState<string | 'new' | null>(null);
  const q = useQuery({ queryKey: ['wl-schedules', box], queryFn: () => api<Schedule[]>('/worklist/schedules', { query: { box } }) });
  return (
    <div className="content stack">
      <div className="row" style={{ gap: 12 }}>
        {refs.can.team && <div className="seg" role="group" aria-label="ხედი">
          <button type="button" aria-pressed={box === 'mine'} onClick={() => setBox('mine')}>ჩემი</button>
          <button type="button" aria-pressed={box === 'team'} onClick={() => setBox('team')}>განყოფილებ(ებ)ის</button></div>}
        <span className="hint grow">დავალება იქმნება დგომის მომენტში (worker, ყოველ 5 წთ); გაჩერების შემდეგ — მხოლოდ ბოლო ერთი. განმეორებადი დავალება არ არის დანიშნულება (პაციენტი არ ებმება).</span>
        <button type="button" className="btn primary" onClick={() => setEdit('new')}>+ გრაფიკი</button>
      </div>
      <ErrorBox error={q.error} />
      <div className="card">{q.isLoading ? <Loading /> : !q.data?.length ? <div className="empty">გრაფიკი არ არის.</div> : <table className="table small">
        <thead><tr><th>დავალება</th><th>ვის</th><th>გრაფიკი</th><th>შემდეგი</th><th className="num">ღია</th><th>სტატუსი</th></tr></thead>
        <tbody>{q.data.map((s) => <tr key={s.id} className="clickable" onClick={() => setEdit(s.id)}>
          <td><div className="row" style={{ gap: 6 }}>{s.priority !== 'normal' && <span className={`chip ${PRIORITY_CHIP[s.priority]}`}>{PRIORITY_KA[s.priority]}</span>}<strong>{s.title}</strong></div>
            <div className="muted">{s.category_name ?? ''}{s.department_name ? `${s.category_name ? ' · ' : ''}${s.department_name}` : ''}</div></td>
          <td>{TARGET_KA[s.target_kind]}: {s.target_label}</td>
          <td>{ruleLabel(s)}<div className="muted">{s.starts_on}{s.ends_on ? ` — ${s.ends_on}` : ''}</div></td>
          <td className="mono" style={{ whiteSpace: 'nowrap' }}>{s.is_active ? dueLabel(s.next_at) : '—'}</td>
          <td className="num">{s.open_tasks} / {s.total_tasks}</td>
          <td>{s.is_active ? <span className="chip ok">აქტიური</span> : <span className="chip">შეჩერებული</span>}</td>
        </tr>)}</tbody></table>}</div>
      {edit && <ScheduleDialog refs={refs} id={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onOpenTask={onOpenTask} />}
    </div>
  );
}

function ScheduleDialog({ refs, id, onClose, onOpenTask }: { refs: Refs; id: string | null; onClose: () => void; onOpenTask: (id: string) => void }) {
  const qc = useQueryClient(); const { user } = useAuth();
  const one = useQuery({ queryKey: ['wl-schedule', id], queryFn: () => api<Schedule>(`/worklist/schedules/${id}`), enabled: !!id });
  const s = one.data;
  if (id && !s) return <Modal title="გრაფიკი" onClose={onClose}>{one.isLoading ? <Loading /> : <ErrorBox error={one.error} />}</Modal>;
  return <ScheduleForm key={s?.id ?? 'new'} refs={refs} s={s ?? null} userId={user?.id ?? null} onClose={onClose} onOpenTask={onOpenTask}
    onSaved={() => { void qc.invalidateQueries({ queryKey: ['wl-schedules'] }); void qc.invalidateQueries({ queryKey: ['wl-schedule'] }); }} />;
}

function ScheduleForm({ refs, s, userId, onClose, onSaved, onOpenTask }: { refs: Refs; s: Schedule | null; userId: string | null; onClose: () => void; onSaved: () => void; onOpenTask: (id: string) => void }) {
  const ro = !!s && !s.can_manage;
  const [f, setF] = useState({ title: s?.title ?? '', description: s?.description ?? '', category_id: s?.category_id ?? '', priority: (s?.priority ?? 'normal') as Priority,
    due_hours: String(s?.due_hours ?? 0), freq: (s?.freq ?? 'daily') as Freq, times: (s?.times ?? ['09:00']).join(', '), weekdays: s?.weekdays ?? [1, 2, 3, 4, 5],
    month_day: String(s?.month_day ?? 1), every_hours: String(s?.every_hours ?? 4), starts_on: s?.starts_on ?? '', ends_on: s?.ends_on ?? '',
    prev_open: s?.prev_open ?? 'skip', is_active: s?.is_active ?? true });
  const [tg, setTg] = useState<Target>(s ? { target_kind: s.target_kind, assignee_id: s.assignee_id, target_role_id: s.target_role_id, target_department_id: s.target_department_id,
    target_duty_role_id: s.target_duty_role_id } : { target_kind: 'user', assignee_id: userId });
  const [targetTouched, setTargetTouched] = useState(false);
  const times = f.times.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
  const save = useMutation({
    mutationFn: () => api<Schedule>(s ? `/worklist/schedules/${s.id}` : '/worklist/schedules', { method: s ? 'PATCH' : 'POST', body: {
      title: f.title.trim(), description: f.description.trim() || null, category_id: f.category_id || null, priority: f.priority, due_hours: Number(f.due_hours) || 0,
      freq: f.freq, times, ...(f.freq === 'weekly' && { weekdays: f.weekdays }), ...(f.freq === 'monthly' && { month_day: Number(f.month_day) }),
      ...(f.freq === 'hourly' && { every_hours: Number(f.every_hours) }), ...(f.starts_on && { starts_on: f.starts_on }), ends_on: f.ends_on || null,
      prev_open: f.prev_open, is_active: f.is_active, ...((!s || targetTouched) && tg) } }),
    onSuccess: () => { onSaved(); onClose(); },
  });
  const pause = useMutation({ mutationFn: () => api(`/worklist/schedules/${s!.id}`, { method: 'PATCH', body: { is_active: !s!.is_active } }), onSuccess: () => { onSaved(); onClose(); } });
  const valid = f.title.trim().length >= 3 && times.length > 0 && times.every((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)) && (f.freq !== 'weekly' || f.weekdays.length > 0);
  return (
    <Modal title={s ? `გრაფიკი: ${s.title}` : 'ახალი განმეორებადი დავალება'} onClose={onClose} width={720}
      footer={<>{s?.can_manage && <button type="button" className="btn" disabled={pause.isPending} onClick={() => pause.mutate()}>{s.is_active ? 'შეჩერება' : 'გააქტიურება'}</button>}
        <span className="grow" /><button type="button" className="btn" onClick={onClose}>დახურვა</button>
        {!ro && <button type="button" className="btn primary" disabled={!valid || save.isPending} onClick={() => save.mutate()}>შენახვა</button>}</>}>
      <fieldset disabled={ro} style={{ border: 0, padding: 0, margin: 0 }} className="stack">
        <Field label="სათაური" htmlFor="sc-t" required><input id="sc-t" className="input" value={f.title} maxLength={200} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <Field label="აღწერა" htmlFor="sc-d"><textarea id="sc-d" className="input" rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <Field label="კატეგორია" htmlFor="sc-c"><select id="sc-c" className="select" value={f.category_id} onChange={(e) => setF({ ...f, category_id: e.target.value })}>
            <option value="">—</option>{refs.categories.filter((c) => c.is_active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
          <Field label="პრიორიტეტი" htmlFor="sc-p"><select id="sc-p" className="select" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value as Priority })}>
            {(['normal', 'high', 'urgent'] as Priority[]).map((p) => <option key={p} value={p}>{PRIORITY_KA[p]}</option>)}</select></Field>
          <Field label="ვადა — დგომიდან (სთ)" htmlFor="sc-dh" hint="0 — კატეგორიის SLA / პრიორიტეტის ნაგულისხმევი"><input id="sc-dh" className="input mono" type="number" min={0} max={720} value={f.due_hours} onChange={(e) => setF({ ...f, due_hours: e.target.value })} /></Field>
        </div>
        <div className="card card-pad stack" style={{ gap: 8 }}>
          <strong className="small">გრაფიკი (კლინიკის დრო)</strong>
          <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <Field label="სიხშირე" htmlFor="sc-f"><select id="sc-f" className="select" value={f.freq} onChange={(e) => setF({ ...f, freq: e.target.value as Freq })}>
              {(Object.keys(FREQ_KA) as Freq[]).map((k) => <option key={k} value={k}>{FREQ_KA[k]}</option>)}</select></Field>
            <Field label={f.freq === 'hourly' ? 'საწყისი დრო' : 'დრო (მძიმით, მაქს. 6)'} htmlFor="sc-tm"><input id="sc-tm" className="input mono" style={{ maxWidth: 220 }} value={f.times} placeholder="09:00, 21:00" onChange={(e) => setF({ ...f, times: e.target.value })} /></Field>
            {f.freq === 'monthly' && <Field label="თვის რიცხვი" htmlFor="sc-md" hint="0 — თვის ბოლო დღე"><input id="sc-md" className="input mono" type="number" min={0} max={28} value={f.month_day} onChange={(e) => setF({ ...f, month_day: e.target.value })} /></Field>}
            {f.freq === 'hourly' && <Field label="ყოველ (სთ)" htmlFor="sc-eh"><input id="sc-eh" className="input mono" type="number" min={1} max={24} value={f.every_hours} onChange={(e) => setF({ ...f, every_hours: e.target.value })} /></Field>}
          </div>
          {f.freq === 'weekly' && <div className="row" role="group" aria-label="კვირის დღეები" style={{ gap: 8 }}>{DOW.map((d, i) => <label key={d} className="row small">
            <input type="checkbox" checked={f.weekdays.includes(i + 1)} onChange={(e) => setF({ ...f, weekdays: e.target.checked ? [...f.weekdays, i + 1].sort() : f.weekdays.filter((x) => x !== i + 1) })} /> {d}</label>)}</div>}
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
            <Field label="დაწყება" htmlFor="sc-s"><input id="sc-s" className="input" type="date" value={f.starts_on} onChange={(e) => setF({ ...f, starts_on: e.target.value })} /></Field>
            <Field label="დასრულება (არჩევითი)" htmlFor="sc-e"><input id="sc-e" className="input" type="date" value={f.ends_on} onChange={(e) => setF({ ...f, ends_on: e.target.value })} /></Field>
            <Field label="წინა ჯერ ღიაა" htmlFor="sc-po"><select id="sc-po" className="select" value={f.prev_open} onChange={(e) => setF({ ...f, prev_open: e.target.value as typeof f.prev_open })}>
              {Object.entries(PREV_KA).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          </div>
        </div>
        <TargetPicker refs={refs} value={tg} onChange={(t) => { setTg(t); setTargetTouched(true); }} idp="sc" />
      </fieldset>
      {s && <div className="stack" style={{ marginTop: 12 }}>
        <div className="small muted">ავტორი: {s.created_by_name ?? '—'} · შემდეგი: {s.is_active ? dueLabel(s.next_at) : 'შეჩერებულია'} · ბოლო: {dueLabel(s.last_occurrence_at)}</div>
        {!!s.runs?.length && <table className="table small"><thead><tr><th>დგომა</th><th>შედეგი</th><th>დავალება</th></tr></thead>
          <tbody>{s.runs.map((r) => <tr key={r.id} className={r.task_id ? 'clickable' : undefined} onClick={() => { if (r.task_id) { onClose(); onOpenTask(r.task_id); } }}>
            <td className="mono">{dueLabel(r.occurrence_at)}</td><td>{RUN_KA[r.result] ?? r.result}</td><td className="mono">{r.task_no ?? ''}</td></tr>)}</tbody></table>}
      </div>}
      <ErrorBox error={save.error ?? pause.error} />
    </Modal>
  );
}
