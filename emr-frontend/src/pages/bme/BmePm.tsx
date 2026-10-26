import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, apiUpload, can, openBlob, type Role } from '../../api/client';
import type { Department } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Field, Loading, Modal, useDebounced, useToast } from '../../components/ui';
import { dateGe, todayISO } from '../../lib/format';

// ======================================================================= ბიომედ-აპარატურა, ეტაპი 2 (0074): PM / კალიბრაცია / ელ. უსაფრთხოება / მეტროლოგია
type Result = 'pass' | 'conditional' | 'fail';
type Outcome = 'pass' | 'fail' | 'na';
export interface Kind { id: string; code: string; name: string; short_name: string; type_field: string | null; default_months: number | null; groups: string[]; standard: string | null;
  needs_certificate: boolean; is_active: boolean; sort_order: number; plans: number }
interface CItem { id?: number; text: string; item_type: 'check' | 'measure'; unit: string | null; nominal: string | null; tolerance: string | null; limit_low: string | null; limit_high: string | null; critical: boolean; required: boolean }
interface Checklist { id: string; kind_id: string; type_id: string | null; type_name: string | null; type_code: string | null; name: string; is_active: boolean; version: number; items: CItem[] }
interface PmRefs { kinds: Kind[]; checklists: Checklist[]; suppliers: { id: string; name: string; phone: string | null; contact_person: string | null }[]; engineers: { id: string; name: string }[] }
export interface Plan { id: string; device_id: string; kind_id: string; interval_months: number | null; type_interval: number | null; interval: number | null; next_due: string | null; last_done_on: string | null;
  last_result: Result | null; is_active: boolean; source: string; notes: string | null; kind_code: string; kind_name: string; kind_short: string; needs_certificate: boolean; days_left: number | null;
  work_id: string | null; work_no: string | null; work_status: string | null; scheduled_date: string | null; performer_kind: string | null; assignee_name: string | null; supplier_name: string | null; external_person: string | null }
interface Work { id: string; work_no: string; device_id: string; plan_id: string | null; kind_id: string; status: 'planned' | 'in_progress' | 'done' | 'cancelled'; due_date: string | null; scheduled_date: string | null;
  performer_kind: 'internal' | 'external'; assignee_id: string | null; supplier_id: string | null; external_person: string | null; performed_on: string | null; result: Result | null; result_note: string | null;
  suggested_status: 'restricted' | 'down' | null; status_applied: boolean; cert_no: string | null; cert_valid_until: string | null; next_due: string | null; completed_at: string | null; cancel_reason: string | null;
  inv_no: string; device_name: string; device_status: string; department_name: string | null; room: string | null; kind_code: string; kind_name: string; kind_short: string; needs_certificate: boolean;
  assignee_name: string | null; supplier_name: string | null; completed_by_name: string | null; manufacturer?: string | null; model?: string | null; serial_no?: string | null; days_left: number | null }
interface WItem { id: string; sort_order: number; text: string; item_type: 'check' | 'measure'; unit: string | null; nominal: string | null; tolerance: string | null; limit_low: string | null; limit_high: string | null;
  critical: boolean; required: boolean; value_num: string | null; outcome: Outcome | null; note: string | null }
interface WorkFull extends Work { items: WItem[]; documents: { id: string; kind: string; title: string; valid_until: string | null; original_name: string | null; created_at: string }[]; auto_result: Result; missing: number;
  repair: { id: string; repair_no: string; status: string } | null; for_repair: { id: string; repair_no: string; status: string } | null }
type BoardRow = (Plan & { row: 'plan'; inv_no: string; device_name: string; department_name: string | null; room: string | null; criticality: string; due_date: string | null })
  | (Work & { row: 'work' });
interface Meter { id: string; unit: string; value: string; read_on: string; note: string | null; user_name: string }

const FULL: Role[] = ['admin', 'med_engineer'];
export const RESULT_KA: Record<Result, string> = { pass: 'გავლილი', conditional: 'პირობითად', fail: 'ვერ გაიარა' };
const RESULT_CHIP: Record<Result, string> = { pass: 'ok', conditional: 'warn', fail: 'danger' };
const WSTATUS_KA: Record<string, string> = { planned: 'დაგეგმილი', in_progress: 'მიმდინარე', done: 'შესრულდა', cancelled: 'გაუქმდა' };
const METER_KA: Record<string, string> = { hours: 'მუშაობის საათები', cycles: 'ციკლები', exposures: 'ექსპოზიციები', scans: 'კვლევები / სკანები', other: 'სხვა' };
const TYPE_FIELD_KA: Record<string, string> = { pm_months: 'ტიპის „PM“', calibration_months: 'ტიპის „კალიბრაცია“', safety_months: 'ტიპის „ელ. უსაფრთხოება“' };
const GRP_KA: Record<string, string> = { imaging: 'გამოსახულება', life_support: 'სიცოცხლის შენარჩუნება', monitoring: 'მონიტორინგი', therapy: 'თერაპია', surgical: 'ქირურგია',
  lab: 'ლაბორატორია', sterilization: 'სტერილიზაცია', endoscopy: 'ენდოსკოპია', measuring: 'საზომი (მეტროლოგია)', other: 'სხვა' };
const usePmRefs = () => useQuery({ queryKey: ['bme-pm-refs'], queryFn: () => api<PmRefs>('/bme/pm/refs') });
const num = (x: string | number | null) => (x === null || x === '' ? '' : String(Number(x)));

/** ნორმის ტექსტი */
export const normText = (i: { nominal: string | null; tolerance: string | null; limit_low: string | null; limit_high: string | null; unit: string | null }) => {
  const u = i.unit ? ` ${i.unit}` : '';
  if (i.tolerance !== null && i.nominal !== null) return `${num(i.nominal)} ± ${num(i.tolerance)}${u}`;
  if (i.limit_low !== null && i.limit_high !== null) return `${num(i.limit_low)} – ${num(i.limit_high)}${u}`;
  if (i.limit_low !== null) return `≥ ${num(i.limit_low)}${u}`;
  if (i.limit_high !== null) return `≤ ${num(i.limit_high)}${u}`;
  return '';
};
/** გაზომვის შედეგი (ეკრანზე — სერვერის წესით) */
const measureOk = (i: WItem, v: number) => {
  if (i.tolerance !== null && i.nominal !== null) return Math.abs(v - Number(i.nominal)) <= Number(i.tolerance) + 1e-9;
  if (i.limit_low !== null && v < Number(i.limit_low) - 1e-9) return false;
  if (i.limit_high !== null && v > Number(i.limit_high) + 1e-9) return false;
  return true;
};

/** ვადის ჩიპი: ვადაგადაცილებული / ≤ 7 / ≤ 31 / შორს / დასადგენი */
export function DueChip({ due, days }: { due: string | null; days: number | null }) {
  if (!due) return <span className="chip warn">დასადგენი</span>;
  const d = days ?? 0;
  const cls = d < 0 ? 'danger' : d <= 7 ? 'warn' : d <= 31 ? 'info' : '';
  return <span className={`chip ${cls}`} title={d < 0 ? `ვადაგადაცილებული ${-d} დღით` : `${d} დღეში`}>{dateGe(due)}{d < 0 ? ` · −${-d} დღ.` : ''}</span>;
}
const performerText = (w: { performer_kind: string | null; assignee_name: string | null; supplier_name: string | null; external_person: string | null }) =>
  w.performer_kind === 'external' ? [w.supplier_name, w.external_person].filter(Boolean).join(' · ') + ' (გარე)' : w.assignee_name ?? '';

// ---------------------------------------------------------------- „სამუშაოები“
const VIEWS: [string, string][] = [['overdue', 'ვადაგადაცილებული'], ['week', 'კვირაში'], ['month', 'თვეში'], ['open', 'დაგეგმილი / მიმდინარე'], ['undated', 'ვადა დასადგენი'], ['all', 'ყველა გეგმა'], ['done', 'შესრულებული (90 დღე)']];
export function WorksPage() {
  const { user } = useAuth(); const refs = usePmRefs(); const toast = useToast(); const qc = useQueryClient();
  const [sp, setSp] = useSearchParams();
  const view = sp.get('view') ?? 'month';
  const [f, setF] = useState({ department_id: '', kind_id: '', assignee: sp.get('assignee') ?? '', search: '', result: '' });
  const ds = useDebounced(f.search.trim(), 300);
  const deps = useQuery({ queryKey: ['departments'], queryFn: () => api<Department[]>('/departments') });
  const counts = useQuery({ queryKey: ['bme-pm-counts'], queryFn: () => api<Record<string, number>>('/bme/pm/counts') });
  const q = useQuery({ queryKey: ['bme-works', view, { ...f, search: ds }], queryFn: () => api<BoardRow[]>('/bme/works', { query: { view, ...f, search: ds } }) });
  const [sel, setSel] = useState<string[]>([]); const [bulk, setBulk] = useState(false);
  useEffect(() => setSel([]), [view, f.department_id, f.kind_id, f.assignee]);
  const full = can(user, ...FULL);
  const rows = q.data ?? [];
  const plans = rows.filter((r): r is Extract<BoardRow, { row: 'plan' }> => r.row === 'plan');
  const setView = (v: string) => { sp.set('view', v); setSp(sp, { replace: true }); };
  const openWork = (id: string) => { sp.set('work', id); setSp(sp); };
  const openDevice = (id: string) => { sp.set('device', id); setSp(sp); };
  const create = useMutation({ mutationFn: (planId: string) => api<WorkFull>('/bme/works', { body: { plan_id: planId } }),
    onSuccess: (w) => { void qc.invalidateQueries({ queryKey: ['bme-works'] }); void qc.invalidateQueries({ queryKey: ['bme-pm-counts'] }); openWork(w.id); } });
  const c = counts.data;
  return (
    <div className="content">
      {toast.node}
      <div className="seg" role="group" aria-label="ხედი" style={{ alignSelf: 'flex-start', flexWrap: 'wrap' }}>
        {VIEWS.map(([k, l]) => <button key={k} type="button" aria-pressed={view === k} onClick={() => setView(k)}>{l}{c && k in c && c[k] ? <span className={`chip ${k === 'overdue' ? 'danger' : k === 'undated' ? 'warn' : ''}`} style={{ height: 18, fontSize: 11, marginLeft: 6 }}>{c[k]}</span> : null}</button>)}
      </div>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <input className="input" style={{ maxWidth: 240, height: 38 }} aria-label="ძებნა" placeholder="№, დასახელება" value={f.search} onChange={(e) => setF({ ...f, search: e.target.value })} />
        <select className="select" style={{ maxWidth: 220, height: 38 }} aria-label="განყოფილება" value={f.department_id} onChange={(e) => setF({ ...f, department_id: e.target.value })}>
          <option value="">ყველა განყოფილება</option>{deps.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
        <select className="select" style={{ maxWidth: 220, height: 38 }} aria-label="სახე" value={f.kind_id} onChange={(e) => setF({ ...f, kind_id: e.target.value })}>
          <option value="">ყველა სახე</option>{refs.data?.kinds.map((k) => <option key={k.id} value={k.id}>{k.short_name}</option>)}</select>
        {view === 'done' ? <select className="select" style={{ maxWidth: 180, height: 38 }} aria-label="შედეგი" value={f.result} onChange={(e) => setF({ ...f, result: e.target.value })}>
          <option value="">ყველა შედეგი</option>{(Object.keys(RESULT_KA) as Result[]).map((r) => <option key={r} value={r}>{RESULT_KA[r]}</option>)}</select>
          : <select className="select" style={{ maxWidth: 220, height: 38 }} aria-label="შემსრულებელი" value={f.assignee} onChange={(e) => setF({ ...f, assignee: e.target.value })}>
            <option value="">ყველა შემსრულებელი</option><option value="me">ჩემი</option><option value="none">მიუნიჭებელი</option>
            {refs.data?.engineers.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select>}
        <span className="grow" />
        {full && sel.length > 0 && <button className="btn primary" type="button" onClick={() => setBulk(true)}>დაგეგმვა / მინიჭება ({sel.length})</button>}
      </div>
      <ErrorBox error={q.error ?? create.error} />
      {q.isLoading ? <Loading /> : (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead><tr>{full && view !== 'done' && <th><input type="checkbox" aria-label="ყველას მონიშვნა" checked={plans.length > 0 && sel.length === plans.length} onChange={(e) => setSel(e.target.checked ? plans.map((p) => p.id) : [])} /></th>}
              <th>ვადა</th><th>აპარატი</th><th>სამუშაო</th><th>ადგილი</th><th>{view === 'done' ? 'შედეგი' : 'სამუშაო / შემსრულებელი'}</th><th /></tr></thead>
            <tbody>{rows.map((r) => r.row === 'plan' ? (
              <tr key={`p-${r.id}`}>
                {full && view !== 'done' && <td><input type="checkbox" aria-label={`მონიშვნა ${r.inv_no} ${r.kind_short}`} checked={sel.includes(r.id)} onChange={(e) => setSel(e.target.checked ? [...sel, r.id] : sel.filter((x) => x !== r.id))} /></td>}
                <td style={{ whiteSpace: 'nowrap' }}><DueChip due={r.next_due} days={r.days_left} /></td>
                <td><button className="link" type="button" onClick={() => openDevice(r.device_id)}><span className="mono">{r.inv_no}</span></button> {r.device_name}</td>
                <td><strong className="small">{r.kind_short}</strong><div className="small muted">ყოველ {r.interval ?? '—'} თვეში{r.last_done_on ? ` · ბოლო ${dateGe(r.last_done_on)}` : ''}
                  {r.last_result && r.last_result !== 'pass' && <> · <span className={`chip ${RESULT_CHIP[r.last_result]}`} style={{ height: 18, fontSize: 11 }}>{RESULT_KA[r.last_result]}</span></>}</div></td>
                <td className="small">{r.department_name ?? '—'}{r.room && <div className="muted">ოთახი {r.room}</div>}</td>
                <td className="small">{r.work_id ? <><span className="mono">{r.work_no}</span> · <span className={`chip ${r.work_status === 'in_progress' ? 'info' : ''}`} style={{ height: 20, fontSize: 11 }}>{WSTATUS_KA[r.work_status!]}</span>
                  <div className="muted">{[r.scheduled_date && dateGe(r.scheduled_date), performerText(r)].filter(Boolean).join(' · ') || 'შემსრულებელი არ არის'}</div></> : <span className="muted">—</span>}</td>
                <td className="num" style={{ whiteSpace: 'nowrap' }}>{r.work_id ? <button className="btn sm" type="button" onClick={() => openWork(r.work_id!)}>გახსნა</button>
                  : full ? <button className="btn sm" type="button" disabled={create.isPending} onClick={() => create.mutate(r.id)}>სამუშაო</button> : null}</td>
              </tr>) : (
              <tr key={`w-${r.id}`} className="clickable" onClick={() => openWork(r.id)}>
                {full && view !== 'done' && <td />}
                <td style={{ whiteSpace: 'nowrap' }}>{view === 'done' ? (r.performed_on ? dateGe(r.performed_on) : '') : <DueChip due={r.scheduled_date ?? r.due_date} days={r.days_left} />}</td>
                <td><span className="mono">{r.inv_no}</span> {r.device_name}</td>
                <td><strong className="small">{r.kind_short}</strong>{!r.plan_id && <div className="small muted">გეგმის გარეშე</div>}</td>
                <td className="small">{r.department_name ?? '—'}</td>
                <td className="small"><span className="mono">{r.work_no}</span> · {view === 'done' && r.result ? <span className={`chip ${RESULT_CHIP[r.result]}`} style={{ height: 20, fontSize: 11 }}>{RESULT_KA[r.result]}</span>
                  : <span className="chip" style={{ height: 20, fontSize: 11 }}>{WSTATUS_KA[r.status]}</span>}<div className="muted">{performerText(r) || r.completed_by_name}</div></td>
                <td className="num"><button className="btn sm" type="button">გახსნა</button></td>
              </tr>))}
              {!rows.length && <tr><td colSpan={7} className="muted">{view === 'overdue' ? 'ვადაგადაცილებული სამუშაო არ არის' : 'ჩანაწერი არ არის'}</td></tr>}
            </tbody>
          </table>
        </div>)}
      {view === 'undated' && rows.length > 0 && <span className="hint">პირველი ვადა უცნობია (არსებული აპარატი / ექსპლ. შეყვანის თარიღის გარეშე) — აპარატის „გეგმები“-ში მიუთითეთ ბოლო შესრულება ან შემდეგი ვადა.</span>}
      {bulk && <BulkDialog planIds={sel} onClose={() => setBulk(false)} onDone={(r) => { setBulk(false); setSel([]); toast.show(`შეიქმნა ${r.created}, განახლდა ${r.updated}${r.skipped.length ? `, გამოტოვდა ${r.skipped.length}` : ''}`);
        void qc.invalidateQueries({ queryKey: ['bme-works'] }); void qc.invalidateQueries({ queryKey: ['bme-pm-counts'] }); }} />}
    </div>
  );
}

/** შემსრულებლის ველები (შიდა ინჟინერი / გარე მომწოდებელი + კონტაქტი) */
type Perf = { performer_kind: 'internal' | 'external'; assignee_id: string; supplier_id: string; external_person: string };
function PerformerFields({ p, set, refs }: { p: Perf; set: (p: Perf) => void; refs: PmRefs | undefined }) {
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="seg" role="group" aria-label="შემსრულებელი" style={{ alignSelf: 'flex-start' }}>
        <button type="button" aria-pressed={p.performer_kind === 'internal'} onClick={() => set({ ...p, performer_kind: 'internal' })}>შიდა (ინჟინერი)</button>
        <button type="button" aria-pressed={p.performer_kind === 'external'} onClick={() => set({ ...p, performer_kind: 'external' })}>გარე (სერვის-კომპანია)</button>
      </div>
      {p.performer_kind === 'internal'
        ? <Field label="ინჟინერი" htmlFor="pa"><select id="pa" className="select" value={p.assignee_id} onChange={(e) => set({ ...p, assignee_id: e.target.value })}>
          <option value="">— მიუნიჭებელი —</option>{refs?.engineers.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
        : <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label="მომწოდებელი" htmlFor="ps"><select id="ps" className="select" value={p.supplier_id} onChange={(e) => set({ ...p, supplier_id: e.target.value })}>
            <option value="">—</option>{refs?.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
          <Field label="კონტაქტი / ინჟინერი" htmlFor="pe"><input id="pe" className="input" value={p.external_person} onChange={(e) => set({ ...p, external_person: e.target.value })} /></Field>
        </div>}
    </div>
  );
}
const perfBody = (p: Perf) => (p.performer_kind === 'internal' ? { performer_kind: 'internal', assignee_id: p.assignee_id || null }
  : { performer_kind: 'external', supplier_id: p.supplier_id || null, external_person: p.external_person.trim() || null });
const perfOk = (p: Perf) => p.performer_kind === 'internal' || !!p.supplier_id || p.external_person.trim().length > 1;

function BulkDialog({ planIds, onClose, onDone }: { planIds: string[]; onClose: () => void; onDone: (r: { created: number; updated: number; skipped: string[] }) => void }) {
  const refs = usePmRefs();
  const [p, setP] = useState<Perf>({ performer_kind: 'internal', assignee_id: '', supplier_id: '', external_person: '' }); const [date, setDate] = useState('');
  const m = useMutation({ mutationFn: () => api<{ created: number; updated: number; skipped: string[] }>('/bme/works/bulk', { body: { plan_ids: planIds, ...perfBody(p), ...(date && { scheduled_date: date }) } }), onSuccess: onDone });
  return (
    <Modal title={`ჯგუფური დაგეგმვა — ${planIds.length} გეგმა`} onClose={onClose} width={620}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={m.isPending || !perfOk(p)} onClick={() => m.mutate()}>დაგეგმვა</button></>}>
      <div className="stack">
        <span className="hint">გეგმას ღია სამუშაო თუ არ აქვს — შეიქმნება (ჩეკლისტით); თუ აქვს — შეიცვლება დღე / შემსრულებელი. შიდა შემსრულებელს მიუვა შეტყობინება.</span>
        <Field label="დაგეგმილი დღე" htmlFor="bd"><input id="bd" className="input mono" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <PerformerFields p={p} set={setP} refs={refs.data} />
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- სამუშაო (შესრულება)
type Val = { value: string; outcome: Outcome | ''; note: string };
export function WorkDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { user } = useAuth(); const qc = useQueryClient(); const refs = usePmRefs(); const toast = useToast();
  const q = useQuery({ queryKey: ['bme-work', id], queryFn: () => api<WorkFull>(`/bme/works/${id}`) });
  const w = q.data; const full = can(user, ...FULL);
  const open = !!w && (w.status === 'planned' || w.status === 'in_progress');
  const [vals, setVals] = useState<Record<string, Val>>({});
  const [fin, setFin] = useState({ result: '' as Result | '', performed_on: todayISO(), result_note: '', cert_no: '', cert_valid_until: '' });
  const [perf, setPerf] = useState<Perf | null>(null); const [sched, setSched] = useState('');
  const [file, setFile] = useState<File | null>(null);
  useEffect(() => {
    if (!w) return;
    setVals(Object.fromEntries(w.items.map((i) => [i.id, { value: i.value_num !== null ? String(Number(i.value_num)) : '', outcome: (i.item_type === 'check' || i.outcome === 'na' ? i.outcome ?? '' : '') as Outcome | '', note: i.note ?? '' }])));
    setPerf({ performer_kind: w.performer_kind, assignee_id: w.assignee_id ?? '', supplier_id: w.supplier_id ?? '', external_person: w.external_person ?? '' }); setSched(w.scheduled_date ?? '');
    setFin((f) => ({ ...f, cert_no: w.cert_no ?? '', cert_valid_until: w.cert_valid_until ?? '' }));
  }, [w?.id, w?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  const done = (r?: WorkFull) => { if (r) qc.setQueryData(['bme-work', id], r); for (const k of ['bme-works', 'bme-pm-counts', 'bme-device-pm', 'bme-device', 'bme-devices']) void qc.invalidateQueries({ queryKey: [k] }); };
  // ეკრანზე: მიმდინარე (შეუნახავი) შედეგი პუნქტებზე
  const live = useMemo(() => (w?.items ?? []).map((i) => {
    const v = vals[i.id]; if (!v) return { i, outcome: i.outcome };
    if (i.item_type === 'measure') { const n = v.value.trim() === '' ? null : Number(v.value.replace(',', '.')); return { i, outcome: (n === null || Number.isNaN(n) ? (v.outcome === 'na' ? 'na' : null) : measureOk(i, n) ? 'pass' : 'fail') as Outcome | null }; }
    return { i, outcome: (v.outcome || null) as Outcome | null };
  }), [w, vals]);
  const auto: Result = live.some((x) => x.outcome === 'fail' && x.i.critical) ? 'fail' : live.some((x) => x.outcome === 'fail') ? 'conditional' : 'pass';
  const missing = live.filter((x) => x.i.required && !x.outcome).length;
  const body = () => (w?.items ?? []).map((i) => {
    const v = vals[i.id] ?? { value: '', outcome: '', note: '' };
    if (i.item_type === 'measure') { const n = v.value.trim() === '' ? null : Number(v.value.replace(',', '.')); return { id: Number(i.id), value_num: n !== null && !Number.isNaN(n) ? n : null, ...(n === null && v.outcome === 'na' && { outcome: 'na' }), note: v.note.trim() || null }; }
    return { id: Number(i.id), outcome: v.outcome || null, note: v.note.trim() || null };
  });
  const save = useMutation({ mutationFn: () => api<WorkFull>(`/bme/works/${id}/items`, { method: 'PUT', body: { items: body() } }), onSuccess: (r) => { done(r); toast.show('შენახულია'); } });
  const assign = useMutation({ mutationFn: () => api<WorkFull>(`/bme/works/${id}`, { method: 'PATCH', body: { ...perfBody(perf!), scheduled_date: sched || null } }), onSuccess: (r) => { done(r); toast.show('შენახულია'); } });
  const upload = useMutation({ mutationFn: () => { const fd = new FormData(); fd.append('file', file!); fd.append('kind', 'certificate'); if (fin.cert_valid_until) fd.append('valid_until', fin.cert_valid_until); return apiUpload<WorkFull>(`/bme/works/${id}/files`, fd); },
    onSuccess: (r) => { setFile(null); done(r); } });
  const complete = useMutation({ mutationFn: () => api<WorkFull>(`/bme/works/${id}/complete`, { body: { items: body(), result: fin.result || auto, performed_on: fin.performed_on, result_note: fin.result_note.trim() || null,
    cert_no: fin.cert_no.trim() || null, cert_valid_until: fin.cert_valid_until || null } }), onSuccess: (r) => { done(r); toast.show('სამუშაო დასრულდა'); } });
  const cancel = useMutation({ mutationFn: (reason: string) => api<WorkFull>(`/bme/works/${id}/cancel`, { body: { reason } }), onSuccess: (r) => done(r) });
  const apply = useMutation({ mutationFn: (status: 'restricted' | 'down') => api<WorkFull>(`/bme/works/${id}/apply-status`, { body: { status } }), onSuccess: (r) => { done(r); toast.show('აპარატის სტატუსი შეიცვალა'); } });
  const [sp, setSp] = useSearchParams();
  const goRepair = (rid: string) => { sp.delete('work'); sp.set('repair', rid); setSp(sp); };
  const mkRepair = useMutation({ mutationFn: () => api<{ id: string }>(`/bme/works/${id}/repair`, { body: {} }), onSuccess: (r) => { done(); goRepair(r.id); } });
  const result = fin.result || auto;
  const rank = { pass: 0, conditional: 1, fail: 2 } as const;
  const certNeed = !!w?.needs_certificate && result !== 'fail';
  const canDone = open && missing === 0 && rank[result] >= rank[auto] && (result === 'pass' || fin.result_note.trim().length >= 3) && (!certNeed || (fin.cert_no.trim() && fin.cert_valid_until)) && !!fin.performed_on;
  const setV = (iid: string, p: Partial<Val>) => setVals((x) => ({ ...x, [iid]: { ...(x[iid] ?? { value: '', outcome: '', note: '' }), ...p } }));
  return (
    <Modal title={w ? `${w.work_no} — ${w.kind_short}` : 'სამუშაო'} onClose={onClose} width={1000}
      footer={<>{w && <button className="btn" type="button" onClick={() => void openBlob(`/bme/works/${id}/act`)}>{w.status === 'done' ? 'აქტი (PDF)' : 'ფორმა (PDF)'}</button>}
        {full && open && <button className="btn" type="button" disabled={cancel.isPending} onClick={() => { const r = prompt('გაუქმების მიზეზი'); if (r && r.trim().length >= 3) cancel.mutate(r.trim()); }}>გაუქმება</button>}
        <span className="grow" /><button className="btn" type="button" onClick={onClose}>დახურვა</button>
        {full && open && <button className="btn" type="button" disabled={save.isPending} onClick={() => save.mutate()}>შენახვა</button>}
        {full && open && <button className="btn primary" type="button" disabled={!canDone || complete.isPending} onClick={() => complete.mutate()}>დასრულება</button>}</>}>
      {toast.node}
      {!w ? (q.error ? <ErrorBox error={q.error} /> : <Loading />) : (
        <div className="stack">
          <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
            <strong><span className="mono">{w.inv_no}</span> {w.device_name}</strong>
            <span className="small muted">{[w.manufacturer, w.model, w.serial_no && `SN ${w.serial_no}`].filter(Boolean).join(' · ')}</span>
            <span className="small">{w.department_name ?? ''}{w.room ? ` · ოთახი ${w.room}` : ''}</span>
            <span className="grow" />
            <span className={`chip ${w.status === 'done' ? 'ok' : w.status === 'cancelled' ? '' : 'info'}`}>{WSTATUS_KA[w.status]}</span>
            {w.due_date && open && <DueChip due={w.due_date} days={w.days_left} />}
          </div>
          <div className="small muted">{w.kind_name}{w.plan_id ? '' : ' · გეგმის გარეშე'}{w.cancel_reason ? ` · გაუქმდა: ${w.cancel_reason}` : ''}
            {w.for_repair && <> · შემოწმება შეკეთების შემდეგ: <button className="link" type="button" onClick={() => goRepair(w.for_repair!.id)}>{w.for_repair.repair_no}</button></>}</div>

          {open && full && perf && (
            <section className="card card-pad stack" style={{ gap: 8 }}>
              <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <Field label="დაგეგმილი დღე" htmlFor="ws"><input id="ws" className="input mono" type="date" value={sched} onChange={(e) => setSched(e.target.value)} /></Field>
                <div className="grow"><PerformerFields p={perf} set={setPerf} refs={refs.data} /></div>
                <button className="btn sm" type="button" disabled={assign.isPending || !perfOk(perf)} onClick={() => assign.mutate()}>მინიჭება</button>
              </div>
            </section>)}
          {!open && <div className="small">შემსრულებელი: <strong>{performerText(w) || w.completed_by_name || '—'}</strong>{w.performed_on && <> · შესრულდა: <strong>{dateGe(w.performed_on)}</strong></>}
            {w.completed_by_name && <> · დაასრულა: {w.completed_by_name}</>}</div>}

          <section className="card" style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead><tr><th>#</th><th>შემოწმება / გაზომვა</th><th>ნორმა</th><th>მნიშვნელობა / შედეგი</th><th>შენიშვნა</th></tr></thead>
              <tbody>{live.map(({ i, outcome }, n) => {
                const v = vals[i.id] ?? { value: '', outcome: '', note: '' };
                return (
                  <tr key={i.id}>
                    <td className="num">{n + 1}</td>
                    <td>{i.text}{!i.critical && <span className="chip" style={{ height: 18, fontSize: 10, marginLeft: 6 }}>არაკრიტ.</span>}{!i.required && <span className="chip" style={{ height: 18, fontSize: 10, marginLeft: 6 }}>არასავალდ.</span>}</td>
                    <td className="small mono" style={{ whiteSpace: 'nowrap' }}>{i.item_type === 'measure' ? normText(i) : '—'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{i.item_type === 'measure'
                      ? <div className="row" style={{ gap: 6 }}><input className="input mono" style={{ width: 110, height: 34 }} inputMode="decimal" aria-label={`მნიშვნელობა: ${i.text}`} disabled={!open || !full} value={v.value}
                        onChange={(e) => setV(i.id, { value: e.target.value, outcome: '' })} /><span className="small muted">{i.unit ?? ''}</span>
                        {outcome && <span className={`chip ${outcome === 'pass' ? 'ok' : outcome === 'fail' ? 'danger' : ''}`} style={{ height: 22, fontSize: 11 }}>{outcome === 'pass' ? 'ნორმაშია' : outcome === 'fail' ? 'ნორმის გარეთ' : 'არ ეხება'}</span>}
                        {!i.required && open && full && !v.value && <button className="btn sm" type="button" aria-pressed={v.outcome === 'na'} onClick={() => setV(i.id, { outcome: v.outcome === 'na' ? '' : 'na' })}>არ ეხება</button>}</div>
                      : <div className="seg" role="group" aria-label={i.text}>
                        {(['pass', 'fail', ...(i.required ? [] : ['na'])] as Outcome[]).map((o) => <button key={o} type="button" disabled={!open || !full} aria-pressed={v.outcome === o}
                          onClick={() => setV(i.id, { outcome: o })}>{o === 'pass' ? 'კი' : o === 'fail' ? 'არა' : 'არ ეხება'}</button>)}</div>}</td>
                    <td><input className="input" style={{ height: 34, minWidth: 160 }} aria-label={`შენიშვნა: ${i.text}`} disabled={!open || !full} value={v.note} onChange={(e) => setV(i.id, { note: e.target.value })} /></td>
                  </tr>);
              })}
                {!w.items.length && <tr><td colSpan={5} className="muted">ამ სახეზე / ტიპზე ჩეკლისტის შაბლონი არ არის — შედეგი შეიყვანეთ ქვემოთ („ჩეკლისტები / სახეები“ ჩანართში შეგიძლიათ დაამატოთ).</td></tr>}
              </tbody>
            </table>
          </section>

          {open && full && (
            <section className="card card-pad stack" style={{ gap: 10 }}>
              <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
                <span className="small">ჩეკლისტის მიხედვით: <span className={`chip ${RESULT_CHIP[auto]}`}>{RESULT_KA[auto]}</span></span>
                {missing > 0 && <span className="chip warn">შესავსებია: {missing}</span>}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
                <Field label="შედეგი" htmlFor="wr"><select id="wr" className="select" value={result} onChange={(e) => setFin({ ...fin, result: e.target.value as Result })}>
                  {(Object.keys(RESULT_KA) as Result[]).filter((r) => rank[r] >= rank[auto]).map((r) => <option key={r} value={r}>{RESULT_KA[r]}</option>)}</select></Field>
                <Field label="შესრულების დღე" htmlFor="wp" required><input id="wp" className="input mono" type="date" max={todayISO()} value={fin.performed_on} onChange={(e) => setFin({ ...fin, performed_on: e.target.value })} /></Field>
                <Field label="სერტიფიკატის №" htmlFor="wc" required={certNeed}><input id="wc" className="input mono" value={fin.cert_no} onChange={(e) => setFin({ ...fin, cert_no: e.target.value })} /></Field>
                <Field label="სერტიფიკატის ვადა" htmlFor="wcv" required={certNeed} hint="შემდეგ ვადად აიღება (პარამეტრი)"><input id="wcv" className="input mono" type="date" value={fin.cert_valid_until} onChange={(e) => setFin({ ...fin, cert_valid_until: e.target.value })} /></Field>
              </div>
              <Field label="კომენტარი" htmlFor="wn" required={result !== 'pass'}><input id="wn" className="input" value={fin.result_note} onChange={(e) => setFin({ ...fin, result_note: e.target.value })}
                placeholder={result === 'fail' ? 'რა არ შეესაბამება, რა არის საჭირო' : ''} /></Field>
              {result !== 'pass' && <span className="hint">„{RESULT_KA[result]}“ — აპარატის სტატუსი ავტომატურად არ იცვლება: დასრულების შემდეგ შემოგთავაზებთ „{result === 'fail' ? 'გაუმართავი' : 'შეზღუდულად მუშა'}“-ს. „ვერ გაიარა“ — გეგმის ვადა არ გადაიწევს.</span>}
            </section>)}

          {w.status === 'done' && w.result && (
            <section className={`alert ${w.result === 'pass' ? 'ok' : w.result === 'conditional' ? 'warn' : 'danger'}`} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <strong>{RESULT_KA[w.result]}</strong>{w.result_note && <span>{w.result_note}</span>}
              {w.next_due && <span>· შემდეგი ვადა: <strong>{dateGe(w.next_due)}</strong></span>}
              {w.cert_no && <span>· სერტ. № {w.cert_no}{w.cert_valid_until ? ` (${dateGe(w.cert_valid_until)}-მდე)` : ''}</span>}
              <span className="grow" />
              {w.suggested_status && !w.status_applied && full && w.device_status !== 'retired' && <button className="btn sm primary" type="button" disabled={apply.isPending}
                onClick={() => { if (confirm(`აპარატის სტატუსი → „${w.suggested_status === 'down' ? 'გაუმართავი / შეკეთებაში' : 'შეზღუდულად მუშა'}“?`)) apply.mutate(w.suggested_status!); }}>
                სტატუსი: {w.suggested_status === 'down' ? 'გაუმართავი' : 'შეზღუდულად მუშა'}</button>}
              {w.suggested_status && w.status_applied && <span className="chip">სტატუსი შეიცვალა</span>}
              {w.repair ? <button className="btn sm" type="button" onClick={() => goRepair(w.repair!.id)}>შეკეთება {w.repair.repair_no}</button>
                : w.result !== 'pass' && full && w.device_status !== 'retired' && <button className="btn sm" type="button" disabled={mkRepair.isPending} onClick={() => mkRepair.mutate()}>შეკეთების ორდერი</button>}
            </section>)}

          <section className="stack" style={{ gap: 6 }}>
            <strong className="small">ფაილები (აქტი / სერტიფიკატი)</strong>
            <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>{w.documents.map((d) => <button key={d.id} className="btn sm" type="button" onClick={() => void openBlob(`/bme/devices/${w.device_id}/documents/${d.id}`)}>
              {d.title}{d.valid_until ? ` · ${dateGe(d.valid_until)}-მდე` : ''}</button>)}{!w.documents.length && <span className="small muted">—</span>}</div>
            {full && w.status !== 'cancelled' && <div className="row" style={{ gap: 6 }}><input type="file" aria-label="სერტიფიკატის ფაილი" accept="application/pdf,image/jpeg,image/png" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              <button className="btn sm" type="button" disabled={!file || upload.isPending} onClick={() => upload.mutate()}>სერტიფიკატის ატვირთვა</button></div>}
          </section>
          <ErrorBox error={save.error ?? assign.error ?? complete.error ?? cancel.error ?? apply.error ?? upload.error ?? mkRepair.error} />
        </div>)}
    </Modal>
  );
}

// ---------------------------------------------------------------- აპარატი: გეგმები, სამუშაოები, მთვლელი
export function DevicePm({ deviceId, retired }: { deviceId: string; retired: boolean }) {
  const { user } = useAuth(); const qc = useQueryClient(); const refs = usePmRefs(); const [sp, setSp] = useSearchParams();
  const q = useQuery({ queryKey: ['bme-device-pm', deviceId], queryFn: () => api<{ plans: Plan[]; works: Work[]; meters: Meter[] }>(`/bme/devices/${deviceId}/pm`) });
  const full = can(user, ...FULL) && !retired;
  const [edit, setEdit] = useState<Plan | 'new' | null>(null);
  const [mt, setMt] = useState({ unit: 'hours', value: '', read_on: todayISO(), note: '' });
  const inv = () => { for (const k of ['bme-device-pm', 'bme-works', 'bme-pm-counts', 'bme-devices']) void qc.invalidateQueries({ queryKey: [k] }); };
  const create = useMutation({ mutationFn: (planId: string) => api<WorkFull>('/bme/works', { body: { plan_id: planId } }), onSuccess: (w) => { inv(); sp.set('work', w.id); setSp(sp); } });
  const meter = useMutation({ mutationFn: () => api('/bme/devices/' + deviceId + '/meters', { body: { unit: mt.unit, value: Number(mt.value.replace(',', '.')), read_on: mt.read_on, note: mt.note.trim() || null } }),
    onSuccess: () => { setMt({ ...mt, value: '', note: '' }); inv(); } });
  if (q.isLoading) return <Loading />;
  const d = q.data;
  if (!d) return <ErrorBox error={q.error} />;
  const lastBy = new Map<string, Meter>(); for (const m of d.meters) if (!lastBy.has(m.unit)) lastBy.set(m.unit, m);
  return (
    <div className="stack">
      <div className="row"><strong className="grow">გეგმები</strong>{full && <button className="btn sm" type="button" onClick={() => setEdit('new')}>+ გეგმა</button>}</div>
      <table className="table">
        <thead><tr><th>სახე</th><th>ინტერვალი</th><th>ბოლო შესრულება</th><th>შემდეგი ვადა</th><th>ღია სამუშაო</th><th /></tr></thead>
        <tbody>{d.plans.map((p) => <tr key={p.id} style={p.is_active ? undefined : { opacity: 0.5 }}>
          <td><strong className="small">{p.kind_short}</strong>{!p.is_active && <span className="chip" style={{ marginLeft: 6 }}>გათიშული</span>}{p.notes && <div className="small muted">{p.notes}</div>}</td>
          <td className="small">{p.interval ?? '—'} თვე{p.interval_months ? <span className="chip info" style={{ height: 18, fontSize: 10, marginLeft: 6 }} title={`ტიპით: ${p.type_interval ?? '—'}`}>აპარატზე</span> : ''}</td>
          <td className="small">{p.last_done_on ? dateGe(p.last_done_on) : '—'}{p.last_result && <> <span className={`chip ${RESULT_CHIP[p.last_result]}`} style={{ height: 18, fontSize: 10 }}>{RESULT_KA[p.last_result]}</span></>}</td>
          <td>{p.is_active ? <DueChip due={p.next_due} days={p.days_left} /> : '—'}</td>
          <td className="small">{p.work_id ? <button className="link" type="button" onClick={() => { sp.set('work', p.work_id!); setSp(sp); }}>{p.work_no}</button> : '—'}</td>
          <td className="num" style={{ whiteSpace: 'nowrap' }}>{full && <>{p.is_active && !p.work_id && <button className="btn sm" type="button" disabled={create.isPending} onClick={() => create.mutate(p.id)}>სამუშაო</button>}{' '}
            <button className="btn sm" type="button" onClick={() => setEdit(p)}>რედაქტ.</button></>}</td>
        </tr>)}{!d.plans.length && <tr><td colSpan={6} className="muted">გეგმა არ არის{full ? ' — „+ გეგმა“ ან ტიპზე ინტერვალების მითითება' : ''}</td></tr>}</tbody>
      </table>
      <strong>სამუშაოების ისტორია</strong>
      <table className="table">
        <thead><tr><th>№</th><th>სახე</th><th>სტატუსი / შედეგი</th><th>შესრულდა</th><th>შემსრულებელი</th></tr></thead>
        <tbody>{d.works.map((w) => <tr key={w.id} className="clickable" onClick={() => { sp.set('work', w.id); setSp(sp); }}>
          <td className="mono small">{w.work_no}</td><td className="small">{w.kind_short}</td>
          <td>{w.result ? <span className={`chip ${RESULT_CHIP[w.result]}`}>{RESULT_KA[w.result]}</span> : <span className="chip">{WSTATUS_KA[w.status]}</span>}</td>
          <td className="small">{w.performed_on ? dateGe(w.performed_on) : w.scheduled_date ? `დაგეგმ. ${dateGe(w.scheduled_date)}` : '—'}</td><td className="small">{performerText(w) || w.completed_by_name || '—'}</td>
        </tr>)}{!d.works.length && <tr><td colSpan={5} className="muted">სამუშაო არ ყოფილა</td></tr>}</tbody>
      </table>
      <strong>მოხმარების მთვლელი</strong>
      {lastBy.size > 0 && <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>{[...lastBy.values()].map((m) => <span key={m.unit} className="chip info">{METER_KA[m.unit]}: <strong style={{ marginLeft: 4 }}>{Number(m.value)}</strong>&nbsp;({dateGe(m.read_on)})</span>)}</div>}
      {full && <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <select className="select" style={{ maxWidth: 200, height: 36 }} aria-label="მთვლელი" value={mt.unit} onChange={(e) => setMt({ ...mt, unit: e.target.value })}>{Object.entries(METER_KA).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <input className="input mono" style={{ maxWidth: 140, height: 36 }} inputMode="decimal" aria-label="მნიშვნელობა" placeholder="მნიშვნელობა" value={mt.value} onChange={(e) => setMt({ ...mt, value: e.target.value })} />
        <input className="input mono" style={{ maxWidth: 160, height: 36 }} type="date" max={todayISO()} aria-label="თარიღი" value={mt.read_on} onChange={(e) => setMt({ ...mt, read_on: e.target.value })} />
        <input className="input" style={{ maxWidth: 260, height: 36 }} aria-label="შენიშვნა" placeholder="შენიშვნა (შემცირებისას — სავალდ.)" value={mt.note} onChange={(e) => setMt({ ...mt, note: e.target.value })} />
        <button className="btn sm" type="button" disabled={!mt.value.trim() || meter.isPending} onClick={() => meter.mutate()}>ჩაწერა</button></div>}
      {d.meters.length > 0 && <table className="table"><tbody>{d.meters.slice(0, 10).map((m) => <tr key={m.id}><td className="small">{dateGe(m.read_on)}</td><td className="small">{METER_KA[m.unit]}</td><td className="num mono">{Number(m.value)}</td>
        <td className="small muted">{m.note ?? ''}</td><td className="small">{m.user_name}</td></tr>)}</tbody></table>}
      <ErrorBox error={create.error ?? meter.error} />
      {edit && <PlanDialog deviceId={deviceId} plan={edit === 'new' ? null : edit} kinds={refs.data?.kinds ?? []} existing={d.plans.map((p) => p.kind_id)} onClose={() => setEdit(null)} onDone={() => { setEdit(null); inv(); }} />}
    </div>
  );
}

function PlanDialog({ deviceId, plan, kinds, existing, onClose, onDone }: { deviceId: string; plan: Plan | null; kinds: Kind[]; existing: string[]; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ kind_id: '', override: !!plan?.interval_months, interval_months: plan?.interval_months ? String(plan.interval_months) : '', next_due: plan?.next_due ?? '', last_done_on: '',
    is_active: plan?.is_active ?? true, notes: plan?.notes ?? '' });
  const m = useMutation({
    mutationFn: () => {
      const iv = f.override && f.interval_months.trim() ? Number(f.interval_months) : null;
      if (!plan) return api(`/bme/devices/${deviceId}/plans`, { body: { kind_id: f.kind_id, interval_months: iv, next_due: f.next_due || null, notes: f.notes.trim() || null } });
      const body: Record<string, unknown> = {};
      if (iv !== plan.interval_months) body.interval_months = iv;
      if (f.last_done_on) body.last_done_on = f.last_done_on;
      else if ((f.next_due || null) !== plan.next_due) body.next_due = f.next_due || null;
      if (f.is_active !== plan.is_active) body.is_active = f.is_active;
      if ((f.notes.trim() || null) !== plan.notes) body.notes = f.notes.trim() || null;
      return api(`/bme/plans/${plan.id}`, { method: 'PATCH', body });
    },
    onSuccess: onDone,
  });
  const free = kinds.filter((k) => k.is_active && !existing.includes(k.id));
  return (
    <Modal title={plan ? `გეგმა: ${plan.kind_short}` : 'ახალი გეგმა'} onClose={onClose} width={620}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={m.isPending || (!plan && !f.kind_id) || (f.override && !(Number(f.interval_months) >= 1 && Number(f.interval_months) <= 120))} onClick={() => m.mutate()}>შენახვა</button></>}>
      <div className="stack">
        {!plan && <Field label="სამუშაოს სახე" htmlFor="pk" required><select id="pk" className="select" value={f.kind_id} onChange={(e) => setF({ ...f, kind_id: e.target.value })}>
          <option value="">— აირჩიეთ —</option>{free.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}</select></Field>}
        <label className="row"><input type="checkbox" checked={f.override} onChange={(e) => setF({ ...f, override: e.target.checked })} /> ინტერვალი აპარატზე (გადაფარვა){plan && <span className="small muted">&nbsp;· ტიპით: {plan.type_interval ?? '—'} თვე</span>}</label>
        {f.override && <Field label="ინტერვალი (თვე)" htmlFor="pi"><input id="pi" className="input mono" inputMode="numeric" value={f.interval_months} onChange={(e) => setF({ ...f, interval_months: e.target.value.replace(/\D/g, '') })} /></Field>}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {plan && <Field label="ბოლო შესრულება (ისტორია)" htmlFor="pl" hint="შემდეგი ვადა ავტომატურად დაითვლება"><input id="pl" className="input mono" type="date" max={todayISO()} value={f.last_done_on} onChange={(e) => setF({ ...f, last_done_on: e.target.value })} /></Field>}
          <Field label="შემდეგი ვადა" htmlFor="pn" hint={plan ? 'ან პირდაპირ' : 'ცარიელი — დასადგენი'}><input id="pn" className="input mono" type="date" disabled={!!f.last_done_on} value={f.next_due} onChange={(e) => setF({ ...f, next_due: e.target.value })} /></Field>
        </div>
        <Field label="შენიშვნა" htmlFor="pno"><input id="pno" className="input" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
        {plan && <label className="row"><input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> აქტიური</label>}
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- ცნობარები: სახეები და ჩეკლისტები
export function PmRefsPage({ types }: { types: { id: string; name: string; code: string; grp: string }[] }) {
  const refs = usePmRefs(); const qc = useQueryClient(); const toast = useToast();
  const [kind, setKind] = useState<Kind | 'new' | null>(null); const [cl, setCl] = useState<Checklist | 'new' | null>(null);
  const sync = useMutation({ mutationFn: () => api<{ created: number }>('/bme/plans/sync', { method: 'POST' }), onSuccess: (r) => { toast.show(`შეიქმნა ${r.created} გეგმა`); void qc.invalidateQueries({ queryKey: ['bme-pm-refs'] }); } });
  if (!refs.data) return <div className="content">{refs.error ? <ErrorBox error={refs.error} /> : <Loading />}</div>;
  const r = refs.data;
  const kName = (id: string) => r.kinds.find((k) => k.id === id)?.short_name ?? '';
  return (
    <div className="content">
      {toast.node}
      <section className="card">
        <div className="card-head row"><h2 className="grow">სამუშაოს სახეები</h2>
          <button className="btn sm" type="button" disabled={sync.isPending} onClick={() => sync.mutate()} title="ტიპის ინტერვალის / სახის დამატების შემდეგ — აკლებულ აპარატებს გეგმა შეექმნება">გეგმების სინქრონიზაცია</button>
          <button className="btn sm primary" type="button" onClick={() => setKind('new')}>+ სახე</button></div>
        <table className="table"><thead><tr><th>სახე</th><th>ინტერვალი</th><th>სტანდარტი</th><th>სერტიფიკატი</th><th className="num">გეგმა</th></tr></thead>
          <tbody>{r.kinds.map((k) => <tr key={k.id} className="clickable" onClick={() => setKind(k)} style={k.is_active ? undefined : { opacity: 0.5 }}>
            <td><strong>{k.name}</strong><div className="mono small muted">{k.code}</div></td>
            <td className="small">{k.type_field ? TYPE_FIELD_KA[k.type_field] : k.default_months ? `${k.default_months} თვე${k.groups.length ? ` · ${k.groups.map((g) => GRP_KA[g]).join(', ')}` : ' (ხელით)'}` : '—'}</td>
            <td className="small">{k.standard ?? ''}</td><td>{k.needs_certificate ? <span className="chip info">სავალდებულო</span> : ''}</td><td className="num">{k.plans || ''}</td></tr>)}</tbody></table>
      </section>
      <section className="card">
        <div className="card-head row"><h2 className="grow">ჩეკლისტის შაბლონები</h2><button className="btn sm primary" type="button" onClick={() => setCl('new')}>+ ჩეკლისტი</button></div>
        <span className="hint" style={{ margin: '0 16px' }}>სამუშაოზე აიღება: ჯერ აპარატის ტიპის + სახის, მერე ზოგადი (სახის). შაბლონის ცვლილება უკვე შექმნილ სამუშაოებს არ ეხება. ნიმუში-ზღვრები გადაამოწმეთ მწარმოებლის ინსტრუქციასთან.</span>
        <table className="table"><thead><tr><th>ჩეკლისტი</th><th>სახე</th><th>ტიპი</th><th className="num">პუნქტი</th><th>ვერსია</th></tr></thead>
          <tbody>{r.checklists.map((c) => <tr key={c.id} className="clickable" onClick={() => setCl(c)} style={c.is_active ? undefined : { opacity: 0.5 }}>
            <td><strong>{c.name}</strong>{!c.is_active && <span className="chip" style={{ marginLeft: 6 }}>გათიშული</span>}</td><td className="small">{kName(c.kind_id)}</td>
            <td className="small">{c.type_name ?? <span className="muted">ზოგადი</span>}</td><td className="num">{c.items.length}</td><td className="small">v{c.version}</td></tr>)}</tbody></table>
      </section>
      {kind && <KindDialog k={kind === 'new' ? null : kind} onClose={() => setKind(null)} />}
      {cl && <ChecklistDialog c={cl === 'new' ? null : cl} kinds={r.kinds} types={types} onClose={() => setCl(null)} />}
    </div>
  );
}

function KindDialog({ k, onClose }: { k: Kind | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ code: k?.code ?? '', name: k?.name ?? '', short_name: k?.short_name ?? '', src: k?.type_field ?? (k ? 'default' : 'default'), default_months: k?.default_months ? String(k.default_months) : '12',
    groups: k?.groups ?? [], standard: k?.standard ?? '', needs_certificate: k?.needs_certificate ?? false, is_active: k?.is_active ?? true });
  const m = useMutation({
    mutationFn: () => { const body = { name: f.name.trim(), short_name: (f.short_name.trim() || f.name.trim()).slice(0, 30), type_field: f.src === 'default' ? null : f.src,
      default_months: f.src === 'default' ? Number(f.default_months) : null, groups: f.src === 'default' ? f.groups : [], standard: f.standard.trim() || null, needs_certificate: f.needs_certificate, is_active: f.is_active };
      return k ? api(`/bme/kinds/${k.id}`, { method: 'PATCH', body }) : api('/bme/kinds', { body: { ...body, code: f.code } }); },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['bme-pm-refs'] }); onClose(); },
  });
  return (
    <Modal title={k ? `სახე: ${k.name}` : 'ახალი სამუშაოს სახე'} onClose={onClose} width={700}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={m.isPending || f.name.trim().length < 2 || (!k && !/^[A-Z][A-Z0-9_]{1,19}$/.test(f.code))
        || (f.src === 'default' && !(Number(f.default_months) >= 1 && Number(f.default_months) <= 120))} onClick={() => m.mutate()}>შენახვა</button></>}>
      <div className="stack">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr 1fr', gap: 12 }}>
          <Field label="კოდი" htmlFor="kc" required hint={k ? 'არ იცვლება' : 'A-Z, 0-9, _'}><input id="kc" className="input mono" disabled={!!k} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
          <Field label="დასახელება" htmlFor="kn" required><input id="kn" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="მოკლე" htmlFor="ks"><input id="ks" className="input" maxLength={30} value={f.short_name} onChange={(e) => setF({ ...f, short_name: e.target.value })} /></Field>
        </div>
        <Field label="ინტერვალი" htmlFor="ksrc"><select id="ksrc" className="select" value={f.src} onChange={(e) => setF({ ...f, src: e.target.value })}>
          <option value="default">სახის ნაგულისხმევი (თვე) — ჯგუფებზე</option>{Object.entries(TYPE_FIELD_KA).map(([key, v]) => <option key={key} value={key}>{v} (თვე) — ტიპიდან</option>)}</select></Field>
        {f.src === 'default' && <>
          <Field label="ნაგულისხმევი ინტერვალი (თვე)" htmlFor="kdm"><input id="kdm" className="input mono" inputMode="numeric" value={f.default_months} onChange={(e) => setF({ ...f, default_months: e.target.value.replace(/\D/g, '') })} /></Field>
          <div className="field"><span className="label">ავტომატურად ჯგუფებზე (ცარიელი — მხოლოდ ხელით გეგმა)</span>
            <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>{Object.entries(GRP_KA).map(([g, l]) => <label key={g} className="row small"><input type="checkbox" checked={f.groups.includes(g)}
              onChange={(e) => setF({ ...f, groups: e.target.checked ? [...f.groups, g] : f.groups.filter((x) => x !== g) })} /> {l}</label>)}</div></div></>}
        <Field label="სტანდარტი / საფუძველი" htmlFor="kst"><input id="kst" className="input" value={f.standard} onChange={(e) => setF({ ...f, standard: e.target.value })} placeholder="მაგ. IEC 62353" /></Field>
        <label className="row"><input type="checkbox" checked={f.needs_certificate} onChange={(e) => setF({ ...f, needs_certificate: e.target.checked })} /> სერტიფიკატის № და ვადა სავალდებულოა</label>
        {k && <label className="row"><input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> აქტიური (გათიშულზე ახალი გეგმა არ იქმნება)</label>}
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}

type CForm = { text: string; item_type: 'check' | 'measure'; unit: string; mode: 'tol' | 'limits'; nominal: string; tolerance: string; limit_low: string; limit_high: string; critical: boolean; required: boolean };
const toC = (i: CItem): CForm => ({ text: i.text, item_type: i.item_type, unit: i.unit ?? '', mode: i.tolerance !== null ? 'tol' : 'limits', nominal: num(i.nominal), tolerance: num(i.tolerance),
  limit_low: num(i.limit_low), limit_high: num(i.limit_high), critical: i.critical, required: i.required });
const nn = (x: string) => (x.trim() === '' ? null : Number(x.replace(',', '.')));
function ChecklistDialog({ c, kinds, types, onClose }: { c: Checklist | null; kinds: Kind[]; types: { id: string; name: string }[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ kind_id: c?.kind_id ?? '', type_id: c?.type_id ?? '', name: c?.name ?? '', is_active: c?.is_active ?? true });
  const [items, setItems] = useState<CForm[]>(c?.items.map(toC) ?? [{ text: '', item_type: 'check', unit: '', mode: 'tol', nominal: '', tolerance: '', limit_low: '', limit_high: '', critical: true, required: true }]);
  const m = useMutation({
    mutationFn: () => { const its = items.filter((i) => i.text.trim()).map((i) => ({ text: i.text.trim(), item_type: i.item_type, unit: i.unit.trim() || null, critical: i.critical, required: i.required,
      ...(i.item_type === 'measure' && (i.mode === 'tol' ? { nominal: nn(i.nominal), tolerance: nn(i.tolerance) } : { limit_low: nn(i.limit_low), limit_high: nn(i.limit_high) })) }));
      return c ? api(`/bme/checklists/${c.id}`, { method: 'PATCH', body: { name: f.name.trim(), is_active: f.is_active, items: its } })
        : api('/bme/checklists', { body: { kind_id: f.kind_id, type_id: f.type_id || null, name: f.name.trim(), items: its } }); },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['bme-pm-refs'] }); onClose(); },
  });
  const set = (n: number, p: Partial<CForm>) => setItems(items.map((x, i) => (i === n ? { ...x, ...p } : x)));
  const move = (n: number, d: -1 | 1) => { const a = [...items]; const t = a[n + d]; if (!t) return; a[n + d] = a[n]; a[n] = t; setItems(a); };
  return (
    <Modal title={c ? `ჩეკლისტი: ${c.name}` : 'ახალი ჩეკლისტი'} onClose={onClose} width={1040}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={m.isPending || f.name.trim().length < 2 || (!c && !f.kind_id) || !items.some((i) => i.text.trim().length >= 2)} onClick={() => m.mutate()}>შენახვა</button></>}>
      <div className="stack">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 2fr', gap: 12 }}>
          <Field label="სახე" htmlFor="ck" required><select id="ck" className="select" disabled={!!c} value={f.kind_id} onChange={(e) => setF({ ...f, kind_id: e.target.value })}>
            <option value="">—</option>{kinds.map((k) => <option key={k.id} value={k.id}>{k.short_name}</option>)}</select></Field>
          <Field label="აპარატის ტიპი" htmlFor="ct" hint="ცარიელი — ზოგადი"><select id="ct" className="select" disabled={!!c} value={f.type_id} onChange={(e) => setF({ ...f, type_id: e.target.value })}>
            <option value="">— ზოგადი —</option>{types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
          <Field label="დასახელება" htmlFor="cn" required><input id="cn" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        </div>
        <table className="table">
          <thead><tr><th style={{ width: '34%' }}>პუნქტი</th><th>სახე</th><th>ნორმა</th><th>ერთ.</th><th>კრიტ.</th><th>სავალდ.</th><th /></tr></thead>
          <tbody>{items.map((i, n) => <tr key={n}>
            <td><input className="input" style={{ height: 34 }} aria-label={`პუნქტი ${n + 1}`} value={i.text} onChange={(e) => set(n, { text: e.target.value })} /></td>
            <td><select className="select" style={{ height: 34 }} aria-label="სახე" value={i.item_type} onChange={(e) => set(n, { item_type: e.target.value as 'check' | 'measure' })}><option value="check">კი / არა</option><option value="measure">გაზომვა</option></select></td>
            <td>{i.item_type === 'measure' ? <div className="row" style={{ gap: 4 }}>
              <select className="select" style={{ height: 34, width: 92 }} aria-label="ნორმის სახე" value={i.mode} onChange={(e) => set(n, { mode: e.target.value as 'tol' | 'limits' })}><option value="tol">± დასაშვ.</option><option value="limits">ზღვრები</option></select>
              {i.mode === 'tol' ? <><input className="input mono" style={{ height: 34, width: 70 }} aria-label="ნორმა" placeholder="ნორმა" value={i.nominal} onChange={(e) => set(n, { nominal: e.target.value })} />±
                <input className="input mono" style={{ height: 34, width: 60 }} aria-label="დასაშვები" placeholder="±" value={i.tolerance} onChange={(e) => set(n, { tolerance: e.target.value })} /></>
                : <><input className="input mono" style={{ height: 34, width: 66 }} aria-label="მინ." placeholder="≥ მინ." value={i.limit_low} onChange={(e) => set(n, { limit_low: e.target.value })} />
                  <input className="input mono" style={{ height: 34, width: 66 }} aria-label="მაქს." placeholder="≤ მაქს." value={i.limit_high} onChange={(e) => set(n, { limit_high: e.target.value })} /></>}</div> : <span className="muted small">—</span>}</td>
            <td><input className="input" style={{ height: 34, width: 70 }} aria-label="ერთეული" disabled={i.item_type === 'check'} value={i.unit} onChange={(e) => set(n, { unit: e.target.value })} /></td>
            <td><input type="checkbox" aria-label="კრიტიკული" checked={i.critical} onChange={(e) => set(n, { critical: e.target.checked })} /></td>
            <td><input type="checkbox" aria-label="სავალდებულო" checked={i.required} onChange={(e) => set(n, { required: e.target.checked })} /></td>
            <td style={{ whiteSpace: 'nowrap' }}><button className="icon-btn" type="button" aria-label="ზემოთ" onClick={() => move(n, -1)}>↑</button><button className="icon-btn" type="button" aria-label="ქვემოთ" onClick={() => move(n, 1)}>↓</button>
              <button className="icon-btn" type="button" aria-label="წაშლა" onClick={() => setItems(items.filter((_, x) => x !== n))}>×</button></td>
          </tr>)}</tbody>
        </table>
        <button className="btn sm" type="button" style={{ alignSelf: 'flex-start' }} onClick={() => setItems([...items, { text: '', item_type: 'check', unit: '', mode: 'tol', nominal: '', tolerance: '', limit_low: '', limit_high: '', critical: true, required: true }])}>+ პუნქტი</button>
        <span className="hint">კრიტიკული პუნქტის „არა“ / ნორმის გარეთ → „ვერ გაიარა“; არაკრიტიკულის → „პირობითად“. გაზომვის შედეგი ავტომატურია.</span>
        {c && <label className="row"><input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> აქტიური</label>}
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}
