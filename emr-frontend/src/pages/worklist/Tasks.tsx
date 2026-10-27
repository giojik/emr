import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import { ErrorBox, Field, Loading, Modal, useToast } from '../../components/ui';
import { NewTaskDialog, TaskDialog, dueLabel } from './TaskDialogs';
import { PRIORITY_CHIP, PRIORITY_KA, STATUS_CHIP, STATUS_KA, TARGET_KA, useWlRefs, useWorklistEnabled, type Category, type Item, type Mine, type Refs, type Task, type TargetKind } from './types';

type Tab = 'mine' | 'group' | 'created' | 'team' | 'categories';

/**
 * სამუშაო სიები (0081): „ჩემი დავალებები“ — სისტემური (სხვა მოდულების ღია საქმე, ბმულით) + ხელით შექმნილი;
 * ჯგუფის / ჩემ მიერ შექმნილი, ხელმძღვანელის ხედი, კატეგორიები. ?task=ID — დავალების ფანჯარა.
 */
export default function Tasks() {
  const wl = useWorklistEnabled();
  const refs = useWlRefs(wl.enabled);
  const [sp, setSp] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const c = refs.data?.can;
  const tabs: [Tab, string, boolean][] = [['mine', 'ჩემი დავალებები', true], ['group', 'ჯგუფის', true], ['created', 'ჩემ მიერ შექმნილი', true],
    ['team', 'ხელმძღვანელის ხედი', !!c?.team], ['categories', 'კატეგორიები', !!c?.categories]];
  const tab = (sp.get('tab') as Tab) ?? 'mine';
  const taskId = sp.get('task');
  const closeTask = () => { const n = new URLSearchParams(sp); n.delete('task'); setSp(n, { replace: true }); };
  const openTask = (id: string) => { const n = new URLSearchParams(sp); n.set('task', id); setSp(n); };
  if (wl.loading || (wl.enabled && refs.isLoading)) return <div className="content"><Loading /></div>;
  return (
    <>
      <header className="topbar" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8, paddingBottom: 0 }}>
        <div className="row"><h1 className="grow">სამუშაო სიები</h1>
          {wl.enabled && refs.data && <button type="button" className="btn primary" onClick={() => setCreating(true)}>+ ახალი დავალება</button>}</div>
        <nav aria-label="სამუშაო სიები" className="row" style={{ gap: 2, flexWrap: 'wrap' }}>
          {tabs.filter((t) => t[2]).map(([k, l]) => <Link key={k} to={`/tasks?tab=${k}`} className={`admin-tab${tab === k ? ' active' : ''}`} aria-current={tab === k ? 'page' : undefined}>{l}</Link>)}
        </nav>
      </header>
      {!wl.enabled ? <div className="content"><div className="card empty">მოდული „სამუშაო სიები“ გამორთულია (ადმინისტრირება → მოდულები).</div></div>
        : refs.error ? <div className="content"><ErrorBox error={refs.error} /></div>
        : tab === 'group' ? <TaskList box="group" onOpen={openTask} />
        : tab === 'created' ? <TaskList box="created" onOpen={openTask} statusFilter />
        : tab === 'team' && c?.team ? <TeamPage refs={refs.data!} onOpen={openTask} />
        : tab === 'categories' && c?.categories ? <CategoriesPage refs={refs.data!} />
        : <MinePage refs={refs.data!} onOpen={openTask} />}
      {creating && <NewTaskDialog onClose={() => setCreating(false)} onCreated={(t) => openTask(t.id)} />}
      {taskId && <TaskDialog id={taskId} onClose={closeTask} />}
    </>
  );
}

const Pri = ({ p }: { p: Item['priority'] }) => (p === 'normal' ? null : <span className={`chip ${PRIORITY_CHIP[p]}`}>{PRIORITY_KA[p]}</span>);

// ---------------------------------------------------------------- ჩემი დავალებები (ერთიანი)
function MinePage({ refs, onOpen }: { refs: Refs; onOpen: (id: string) => void }) {
  const nav = useNavigate();
  const [src, setSrc] = useState<string>('');
  const [overdue, setOverdue] = useState(false);
  const [text, setText] = useState('');
  const q = useQuery({ queryKey: ['wl-mine'], queryFn: () => api<Mine>('/worklist/mine'), refetchInterval: Math.max(30, refs.settings.refresh_seconds) * 1000 });
  const items = useMemo(() => (q.data?.items ?? []).filter((x) => (!src || x.source === src) && (!overdue || x.overdue)
    && (!text.trim() || `${x.title} ${x.detail ?? ''} ${x.patient ?? ''}`.toLowerCase().includes(text.trim().toLowerCase()))), [q.data, src, overdue, text]);
  const groups = useMemo(() => {
    const m = new Map<string, Mine['sources']>();
    for (const s of q.data?.sources ?? []) m.set(s.group, [...(m.get(s.group) ?? []), s]);
    return [...m.entries()];
  }, [q.data]);
  const open = (x: Item) => (x.kind === 'task' && x.task ? onOpen(x.task.id) : nav(x.link));
  if (q.isLoading) return <div className="content"><Loading /></div>;
  return (
    <div className="content stack">
      <ErrorBox error={q.error} />
      {q.data && <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
        <div className="card card-pad" style={{ minWidth: 140 }}><div className="small muted">სულ</div><strong style={{ fontSize: 22 }}>{q.data.totals.total}</strong></div>
        <div className="card card-pad" style={{ minWidth: 140 }}><div className="small muted">ვადაგადაცილებული</div><strong style={{ fontSize: 22, color: q.data.totals.overdue ? 'var(--danger-ink)' : undefined }}>{q.data.totals.overdue}</strong></div>
        <div className="card card-pad" style={{ minWidth: 140 }}><div className="small muted">სასწრაფო</div><strong style={{ fontSize: 22 }}>{q.data.totals.urgent}</strong></div>
        <span className="grow" />
        <span className="small muted" style={{ alignSelf: 'flex-end' }}>განახლდა {dueLabel(q.data.generated_at)} · ავტომატურად {refs.settings.refresh_seconds} წმ-ში</span>
      </div>}
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <button type="button" className={`btn sm${!src ? ' primary' : ''}`} onClick={() => setSrc('')}>ყველა ({q.data?.totals.total ?? 0})</button>
        {groups.map(([g, list]) => list.map((s) => <button key={s.source} type="button" className={`btn sm${src === s.source ? ' primary' : ''}`} title={g} onClick={() => setSrc(src === s.source ? '' : s.source)}>
          {s.name} ({s.count}{s.overdue ? <span style={{ color: src === s.source ? '#fff' : 'var(--danger-ink)' }}> · {s.overdue}!</span> : null})</button>))}
      </div>
      <div className="row" style={{ gap: 12 }}>
        <input className="input" style={{ maxWidth: 320 }} aria-label="ძებნა" placeholder="ძებნა: სათაური / პაციენტი" value={text} onChange={(e) => setText(e.target.value)} />
        <label className="row small"><input type="checkbox" checked={overdue} onChange={(e) => setOverdue(e.target.checked)} /> მხოლოდ ვადაგადაცილებული</label>
      </div>
      <div className="card">
        {!items.length ? <div className="empty">ღია დავალება არ არის.</div> : <table className="table small">
          <thead><tr><th>ვადა</th><th>დავალება</th><th>პაციენტი</th><th>განყოფილება</th><th>წყარო</th><th /></tr></thead>
          <tbody>{items.map((x) => <tr key={x.key} className="clickable" onClick={() => open(x)}>
            <td className="mono" style={{ color: x.overdue ? 'var(--danger-ink)' : undefined, fontWeight: x.overdue ? 700 : undefined, whiteSpace: 'nowrap' }}>{dueLabel(x.due_at, x.due_date_only)}</td>
            <td><div className="row" style={{ gap: 6 }}><Pri p={x.priority} /><strong>{x.task ? `${x.task.task_no}: ` : ''}{x.title}</strong></div>
              {(x.detail || x.task) && <div className="muted">{x.detail}{x.task && <>{x.detail ? ' · ' : ''}{x.task.group ? `${x.task.target_label}${x.task.claimed_by_name ? ` — აიღო ${x.task.claimed_by_name}` : ' — ჯგუფური'}` : `შემქმნელი: ${x.task.created_by_name ?? '—'}`}</>}</div>}</td>
            <td>{x.patient ?? ''}</td><td>{x.department ?? ''}</td>
            <td><span className="chip">{x.kind === 'task' ? 'ხელით' : x.group}</span></td>
            <td><button type="button" className="btn sm" onClick={(e) => { e.stopPropagation(); open(x); }}>{x.kind === 'task' ? 'გახსნა' : 'გადასვლა →'}</button></td>
          </tr>)}</tbody></table>}
      </div>
      <span className="hint">სისტემური ჩანაწერი ქრება, როცა საქმე თავის მოდულში სრულდება (სამუშაო იქ კეთდება — „გადასვლა“). ხელით შექმნილი დავალება არ არის დანიშნულება.</span>
    </div>
  );
}

// ---------------------------------------------------------------- სიები: ჯგუფის / შექმნილი
function TaskTable({ rows, onOpen, showTarget = true }: { rows: Task[]; onOpen: (id: string) => void; showTarget?: boolean }) {
  if (!rows.length) return <div className="empty">დავალება არ არის.</div>;
  return (
    <table className="table small">
      <thead><tr><th>№</th><th>დავალება</th>{showTarget && <th>ვის</th>}<th>სტატუსი</th><th>ვადა</th><th>პაციენტი</th></tr></thead>
      <tbody>{rows.map((t) => <tr key={t.id} className="clickable" onClick={() => onOpen(t.id)}>
        <td className="mono">{t.task_no}</td>
        <td><div className="row" style={{ gap: 6 }}><Pri p={t.priority} /><strong>{t.title}</strong></div>{t.category_name && <div className="muted">{t.category_name}</div>}</td>
        {showTarget && <td>{TARGET_KA[t.target_kind as TargetKind]}: {t.target_label}{t.group && <div className="muted">{t.claimed_by_name ? `აიღო ${t.claimed_by_name}` : 'ჯერ არავინ აიღო'}</div>}</td>}
        <td><span className={`chip ${STATUS_CHIP[t.status] ?? ''}`}>{STATUS_KA[t.status]}</span></td>
        <td className="mono" style={{ color: t.overdue ? 'var(--danger-ink)' : undefined, fontWeight: t.overdue ? 700 : undefined, whiteSpace: 'nowrap' }}>{dueLabel(t.due_at)}</td>
        <td>{t.patient_name ?? ''}</td>
      </tr>)}</tbody>
    </table>
  );
}

function TaskList({ box, onOpen, statusFilter }: { box: 'group' | 'created'; onOpen: (id: string) => void; statusFilter?: boolean }) {
  const [status, setStatus] = useState('active');
  const q = useQuery({ queryKey: ['wl-tasks', box, status], queryFn: () => api<Task[]>('/worklist/tasks', { query: { box, status: statusFilter ? status : undefined } }) });
  return (
    <div className="content stack">
      {statusFilter && <div className="seg" role="group" aria-label="სტატუსი">
        {[['active', 'ღია'], ['closed', 'დახურული (90 დღე)'], ['all', 'ყველა']].map(([k, l]) => <button key={k} type="button" aria-pressed={status === k} onClick={() => setStatus(k)}>{l}</button>)}</div>}
      {box === 'group' && <span className="hint">თქვენი ჯგუფების (როლი / განყოფილება / მორიგე) ღია დავალებები — აღებულიც. აუღებელს „ავიღებ“-ით იღებთ.</span>}
      <ErrorBox error={q.error} />
      <div className="card">{q.isLoading ? <Loading /> : <TaskTable rows={q.data ?? []} onOpen={onOpen} />}</div>
    </div>
  );
}

// ---------------------------------------------------------------- ხელმძღვანელის ხედი
interface Team { tasks: Task[]; done_7d: number; departments: { department_id: string | null; department_name: string | null; open: number; overdue: number; urgent: number; unclaimed: number }[];
  assignees: { user_id: string; name: string; open: number; overdue: number }[] }
function TeamPage({ refs, onOpen }: { refs: Refs; onOpen: (id: string) => void }) {
  const [f, setF] = useState({ department_id: '', status: 'active', overdue: false, assignee_id: '' });
  const q = useQuery({ queryKey: ['wl-team', f], queryFn: () => api<Team>('/worklist/team', { query: { department_id: f.department_id || undefined, status: f.status, overdue: f.overdue ? '1' : undefined, assignee_id: f.assignee_id || undefined } }) });
  const deps = refs.departments.filter((d) => refs.can.all || refs.team_departments.includes(d.id));
  return (
    <div className="content stack">
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="განყოფილება" htmlFor="tm-d"><select id="tm-d" className="select" value={f.department_id} onChange={(e) => setF({ ...f, department_id: e.target.value })}>
          <option value="">{refs.can.all ? 'ყველა' : 'ჩემი განყოფილებები'}</option>{deps.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
        <Field label="სტატუსი" htmlFor="tm-s"><select id="tm-s" className="select" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
          <option value="active">ღია</option><option value="closed">დახურული (90 დღე)</option><option value="all">ყველა</option></select></Field>
        <label className="row small" style={{ marginBottom: 10 }}><input type="checkbox" checked={f.overdue} onChange={(e) => setF({ ...f, overdue: e.target.checked })} /> ვადაგადაცილებული</label>
        <label className="row small" style={{ marginBottom: 10 }}><input type="checkbox" checked={f.assignee_id === 'none'} onChange={(e) => setF({ ...f, assignee_id: e.target.checked ? 'none' : '' })} /> აუღებელი (ჯგუფური)</label>
        <span className="grow" />{q.data && <span className="small muted" style={{ marginBottom: 10 }}>შესრულდა ბოლო 7 დღეში: <strong>{q.data.done_7d}</strong></span>}
      </div>
      <ErrorBox error={q.error} />
      {q.data && <div className="row" style={{ gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div className="card" style={{ flex: '1 1 380px' }}><div className="card-pad"><strong>განყოფილებები</strong></div>
          {!q.data.departments.length ? <div className="empty small">ღია დავალება არ არის.</div> : <table className="table small"><thead><tr><th>განყოფილება</th><th className="num">ღია</th><th className="num">ვადაგად.</th><th className="num">სასწრაფო</th><th className="num">აუღებელი</th></tr></thead>
            <tbody>{q.data.departments.map((d) => <tr key={d.department_id ?? '—'} className="clickable" onClick={() => setF({ ...f, department_id: d.department_id ?? '' })}><td>{d.department_name ?? '—'}</td><td className="num">{d.open}</td>
              <td className="num" style={{ color: d.overdue ? 'var(--danger-ink)' : undefined }}>{d.overdue}</td><td className="num">{d.urgent}</td><td className="num">{d.unclaimed}</td></tr>)}</tbody></table>}</div>
        <div className="card" style={{ flex: '1 1 300px' }}><div className="card-pad"><strong>შემსრულებლები</strong></div>
          {!q.data.assignees.length ? <div className="empty small">—</div> : <table className="table small"><thead><tr><th>თანამშრომელი</th><th className="num">ღია</th><th className="num">ვადაგად.</th></tr></thead>
            <tbody>{q.data.assignees.map((a) => <tr key={a.user_id} className="clickable" onClick={() => setF({ ...f, assignee_id: a.user_id })}><td>{a.name}</td><td className="num">{a.open}</td>
              <td className="num" style={{ color: a.overdue ? 'var(--danger-ink)' : undefined }}>{a.overdue}</td></tr>)}</tbody></table>}</div>
      </div>}
      <div className="card">{q.isLoading ? <Loading /> : <TaskTable rows={q.data?.tasks ?? []} onOpen={onOpen} />}</div>
      <span className="hint">ხელმძღვანელის ხედი — ხელით შექმნილი დავალებები (სისტემური წყაროების აგრეგატები — მენეჯერული დაფის „ყურადღებაში“). გადანაწილება — დავალების ფანჯრიდან.</span>
    </div>
  );
}

// ---------------------------------------------------------------- კატეგორიები
function CategoriesPage({ refs }: { refs: Refs }) {
  const [edit, setEdit] = useState<Category | 'new' | null>(null);
  return (
    <div className="content stack">
      <div className="row"><span className="hint grow">კატეგორიის ნაგულისხმევი სამიზნე („მოთხოვნა სამსახურს“) ფორმაში ავტომატურად ივსება; SLA — ვადა, თუ ხელით არ არის მითითებული.</span>
        <button type="button" className="btn primary" onClick={() => setEdit('new')}>+ კატეგორია</button></div>
      <div className="card"><table className="table small">
        <thead><tr><th>კოდი</th><th>დასახელება</th><th>ნაგულისხმევი სამიზნე</th><th className="num">SLA, სთ</th><th>პაციენტი</th><th>სტატუსი</th></tr></thead>
        <tbody>{refs.categories.map((c) => <tr key={c.id} className="clickable" onClick={() => setEdit(c)}>
          <td className="mono">{c.code}</td><td><strong>{c.name}</strong>{c.description && <div className="muted">{c.description}</div>}</td>
          <td>{c.default_target_kind ? `${TARGET_KA[c.default_target_kind]}: ${[c.default_role_name, c.default_department_name].filter(Boolean).join(' · ')}` : '—'}</td>
          <td className="num">{c.sla_hours ?? '—'}</td><td>{c.allow_patient ? 'დაშვებული' : '—'}</td>
          <td>{c.is_active ? <span className="chip ok">აქტიური</span> : <span className="chip">გათიშული</span>}</td></tr>)}</tbody></table></div>
      {edit && <CategoryDialog refs={refs} cat={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </div>
  );
}
function CategoryDialog({ refs, cat, onClose }: { refs: Refs; cat: Category | null; onClose: () => void }) {
  const qc = useQueryClient(); const toast = useToast();
  const [f, setF] = useState({ code: cat?.code ?? '', name: cat?.name ?? '', description: cat?.description ?? '', default_target_kind: cat?.default_target_kind ?? '',
    default_role_id: cat?.default_role_id ?? '', default_department_id: cat?.default_department_id ?? '', sla_hours: cat?.sla_hours ? String(cat.sla_hours) : '',
    allow_patient: cat?.allow_patient ?? true, is_active: cat?.is_active ?? true, sort_order: String(cat?.sort_order ?? 100) });
  const k = f.default_target_kind;
  const save = useMutation({
    mutationFn: () => api(cat ? `/worklist/categories/${cat.id}` : '/worklist/categories', { method: cat ? 'PATCH' : 'POST', body: {
      ...(!cat && { code: f.code }), name: f.name.trim(), description: f.description.trim() || null, default_target_kind: k || null,
      default_role_id: k === 'role' || k === 'role_department' ? f.default_role_id || null : null, default_department_id: k === 'department' || k === 'role_department' ? f.default_department_id || null : null,
      sla_hours: f.sla_hours ? Number(f.sla_hours) : null, allow_patient: f.allow_patient, is_active: f.is_active, sort_order: Number(f.sort_order) || 100 } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['wl-refs'] }); toast.show('შენახულია'); onClose(); },
  });
  return (
    <Modal title={cat ? `კატეგორია: ${cat.name}` : 'ახალი კატეგორია'} onClose={onClose} width={560}
      footer={<><button type="button" className="btn" onClick={onClose}>გაუქმება</button><button type="button" className="btn primary" disabled={save.isPending || f.name.trim().length < 2 || (!cat && !/^[A-Z][A-Z0-9_]{1,19}$/.test(f.code))} onClick={() => save.mutate()}>შენახვა</button></>}>
      {toast.node}
      <div className="stack">
        {!cat && <Field label="კოდი" htmlFor="ct-c" hint="ლათინური დიდი ასოები / ციფრები / _"><input id="ct-c" className="input mono" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>}
        <Field label="დასახელება" htmlFor="ct-n" required><input id="ct-n" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="აღწერა" htmlFor="ct-d"><input id="ct-d" className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <Field label="ნაგულისხმევი სამიზნე" htmlFor="ct-k"><select id="ct-k" className="select" value={k} onChange={(e) => setF({ ...f, default_target_kind: e.target.value as TargetKind | '' })}>
          <option value="">— (ფორმაში ირჩევენ)</option><option value="department">{TARGET_KA.department}</option><option value="role">{TARGET_KA.role}</option><option value="role_department">{TARGET_KA.role_department}</option></select></Field>
        {(k === 'role' || k === 'role_department') && <Field label="როლი" htmlFor="ct-r"><select id="ct-r" className="select" value={f.default_role_id} onChange={(e) => setF({ ...f, default_role_id: e.target.value })}>
          <option value="">—</option>{refs.roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>}
        {(k === 'department' || k === 'role_department') && <Field label="განყოფილება" htmlFor="ct-dp"><select id="ct-dp" className="select" value={f.default_department_id} onChange={(e) => setF({ ...f, default_department_id: e.target.value })}>
          <option value="">—</option>{refs.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>}
        <div className="row" style={{ gap: 12 }}>
          <Field label="SLA (სთ)" htmlFor="ct-s"><input id="ct-s" className="input mono" type="number" min={1} max={2160} value={f.sla_hours} onChange={(e) => setF({ ...f, sla_hours: e.target.value })} /></Field>
          <Field label="რიგი" htmlFor="ct-o"><input id="ct-o" className="input mono" type="number" value={f.sort_order} onChange={(e) => setF({ ...f, sort_order: e.target.value })} /></Field>
        </div>
        <label className="row"><input type="checkbox" checked={f.allow_patient} onChange={(e) => setF({ ...f, allow_patient: e.target.checked })} /> პაციენტის მიბმა დაშვებულია</label>
        <label className="row"><input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> აქტიური</label>
        <ErrorBox error={save.error} />
      </div>
    </Modal>
  );
}
