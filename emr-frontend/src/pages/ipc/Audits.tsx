import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, can } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Field, Loading, Modal } from '../../components/ui';
import { tsDate } from '../../lib/format';
import { IPC_ANY, IPC_FULL } from './types';

interface Item { id: string; template_id: string; section: string | null; text: string; sort_order: number; is_active: boolean }
interface Template { id: string; code: string; name: string; kind: 'hand_hygiene' | 'checklist'; description: string | null; target: number | null; is_active: boolean; items: Item[] }
interface AuditRow { id: string; template_id: string; template: string; kind: string; department_id: string; department: string; audited_at: string; location: string | null;
  status: string; compliance: number | null; auditor: string; obs_n: number; answers_n: number; opps_n: number | null; done_n: number | null; yes_n: number | null; no_n: number | null }
interface Obs { id: string; profession: string; moments: number[]; action: string; gloves: boolean; comment: string | null }
interface Audit extends AuditRow { note: string | null; target: number | null; items: Item[]; answers: { item_id: string; answer: string; comment: string | null }[]; observations: Obs[];
  can_edit: boolean; na_n: number | null }
interface Stats {
  from: string; to: string;
  hand_hygiene: { target: number; min_obs: number; opps: number; done: number; pct: number | null; rub: number; wash: number;
    moments: { moment: number; label: string; opps: number; done: number; pct: number | null }[];
    professions: { profession: string; label: string; opps: number; done: number; pct: number | null }[];
    departments: { department_id: string; department: string; opps: number; done: number; pct: number | null; insufficient: boolean }[];
    months: { ym: string; opps: number; done: number; pct: number | null }[] };
  checklists: { template_id: string; template: string; target: number | null; audits: number; pct: number | null;
    departments: { department_id: string; department: string; audits: number; pct: number | null }[];
    top_no: { item_id: string; text: string; no: number; answered: number; pct_no: number | null }[] }[];
}

export const PROF_KA: Record<string, string> = { doctor: 'ექიმი', nurse: 'ექთანი', assistant: 'უმცროსი პერსონალი', student: 'სტუდენტი / რეზიდენტი', other: 'სხვა' };
export const MOMENT_KA: Record<number, string> = { 1: 'შეხებამდე', 2: 'ასეპტიკურ პროცედურამდე', 3: 'სითხეებთან კონტაქტის შემდეგ', 4: 'შეხების შემდეგ', 5: 'გარემოსთან შეხების შემდეგ' };
const ACTION: Record<string, [string, string]> = { rub: ['ok', 'ანტისეპტიკი'], wash: ['ok', 'დაბანა'], missed: ['danger', 'გამოტოვება'] };
const ANS: [string, string, string][] = [['yes', 'კი', 'ok'], ['no', 'არა', 'danger'], ['na', 'არ ეხება', '']];
const todayTb = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tbilisi' }).format(new Date());
const monthStart = () => `${todayTb().slice(0, 7)}-01`;
const dt = (v: string) => `${tsDate(v)} ${new Date(v).toLocaleTimeString('ka-GE', { timeZone: 'Asia/Tbilisi', hour: '2-digit', minute: '2-digit', hour12: false })}`;
const pctTone = (p: number | null, t: number | null) => (p === null || t === null ? undefined : p >= t ? 'var(--ok-ink)' : 'var(--danger-ink)');
export const useAuditTemplates = (all = false) => useQuery({ queryKey: ['ipc-audit-templates', all], queryFn: () => api<Template[]>('/ipc/audit-templates', { query: { all: all ? '1' : '' } }) });

/** ჩეკლისტები (0072): აუდიტები (ხელის ჰიგიენა — WHO 5 მომენტი, იზოლაცია, დასუფთავება…), შედეგები, შაბლონები */
export default function AuditsTab() {
  const { user } = useAuth(); const full = can(user, ...IPC_FULL);
  const [view, setView] = useState<'list' | 'stats' | 'templates'>('list');
  return (
    <div className="content">
      <div className="seg" role="group" aria-label="ჩეკლისტები">
        {([['list', 'აუდიტები', true], ['stats', 'შედეგები', true], ['templates', 'შაბლონები', full]] as const).filter((x) => x[2]).map(([k, l]) =>
          <button key={k} type="button" aria-pressed={view === k} onClick={() => setView(k)}>{l}</button>)}
      </div>
      {view === 'list' && <List />}
      {view === 'stats' && <StatsView />}
      {view === 'templates' && <Templates />}
    </div>
  );
}

function useDepts() {
  return useQuery({ queryKey: ['departments'], queryFn: () => api<{ id: string; name: string; type: string; is_active?: boolean }[]>('/departments'), staleTime: 5 * 60_000 });
}

function List() {
  const tpl = useAuditTemplates(); const depts = useDepts();
  const [f, setF] = useState({ template_id: '', department_id: '', status: '', from: monthStart(), to: todayTb() });
  const [add, setAdd] = useState(false); const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['ipc-audits', f], queryFn: () => api<AuditRow[]>('/ipc/audits', { query: f }) });
  return (
    <>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <select className="select" style={{ maxWidth: 260, height: 38 }} aria-label="შაბლონი" value={f.template_id} onChange={(e) => setF({ ...f, template_id: e.target.value })}>
          <option value="">ყველა ჩეკლისტი</option>{tpl.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
        <select className="select" style={{ maxWidth: 220, height: 38 }} aria-label="განყოფილება" value={f.department_id} onChange={(e) => setF({ ...f, department_id: e.target.value })}>
          <option value="">ყველა განყოფილება</option>{depts.data?.filter((d) => d.type !== 'administrative').map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
        <select className="select" style={{ maxWidth: 160, height: 38 }} aria-label="სტატუსი" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
          <option value="">ყველა</option><option value="draft">მიმდინარე</option><option value="completed">დასრულებული</option></select>
        <input type="date" className="input" style={{ maxWidth: 160, height: 38 }} aria-label="დან" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        <input type="date" className="input" style={{ maxWidth: 160, height: 38 }} aria-label="მდე" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
        <span className="grow" />
        <button className="btn primary" type="button" onClick={() => setAdd(true)}>+ აუდიტი</button>
      </div>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : (
        <div className="card" style={{ overflowX: 'auto', flexShrink: 0 }}>
          <table className="table">
            <thead><tr><th>დრო</th><th>ჩეკლისტი</th><th>განყოფილება</th><th>ავტორი</th><th className="num">მოცულობა</th><th className="num">შესაბამისობა</th><th>სტატუსი</th></tr></thead>
            <tbody>{q.data?.map((a) => (
              <tr key={a.id} className="clickable" onClick={() => setOpen(a.id)}>
                <td className="mono small">{dt(a.audited_at)}</td><td>{a.template}</td>
                <td className="small">{a.department}{a.location && <div className="muted">{a.location}</div>}</td><td className="small">{a.auditor}</td>
                <td className="num">{a.kind === 'hand_hygiene' ? `${a.obs_n} შესაძლ.` : `${a.answers_n} პასუხი`}</td>
                <td className="num"><strong>{a.compliance === null ? '—' : `${a.compliance}%`}</strong></td>
                <td>{a.status === 'completed' ? <span className="chip ok">დასრულებული</span> : <span className="chip warn">მიმდინარე</span>}</td>
              </tr>))}
              {!q.data?.length && <tr><td colSpan={7} className="muted">აუდიტი არ არის</td></tr>}
            </tbody>
          </table>
        </div>)}
      {add && <NewAudit onClose={() => setAdd(false)} onDone={(id) => { setAdd(false); setOpen(id); }} />}
      {open && <AuditCard id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function NewAudit({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const qc = useQueryClient(); const tpl = useAuditTemplates(); const depts = useDepts();
  const [f, setF] = useState({ template_id: '', department_id: '', location: '' });
  const m = useMutation({ mutationFn: () => api<Audit>('/ipc/audits', { body: { template_id: f.template_id, department_id: f.department_id, location: f.location.trim() || undefined } }),
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ['ipc-audits'] }); onDone(r.id); } });
  return (
    <Modal title="ახალი აუდიტი" onClose={onClose} width={560} footer={<>
      <button className="btn" type="button" onClick={onClose}>გაუქმება</button>
      <button className="btn primary" type="button" disabled={!f.template_id || !f.department_id || m.isPending} onClick={() => m.mutate()}>დაწყება</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <ErrorBox error={m.error} />
        <Field label="ჩეკლისტი" htmlFor="na-t" required><select id="na-t" className="select" value={f.template_id} onChange={(e) => setF({ ...f, template_id: e.target.value })}>
          <option value="">— აირჩიეთ —</option>{tpl.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
        <Field label="განყოფილება" htmlFor="na-d" required><select id="na-d" className="select" value={f.department_id} onChange={(e) => setF({ ...f, department_id: e.target.value })}>
          <option value="">— აირჩიეთ —</option>{depts.data?.filter((d) => d.type !== 'administrative').map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
        <Field label="პალატა / ოთახი" htmlFor="na-l"><input id="na-l" className="input" value={f.location} maxLength={200} onChange={(e) => setF({ ...f, location: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

function AuditCard({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['ipc-audit', id], queryFn: () => api<Audit>(`/ipc/audits/${id}`) });
  const set = (a: Audit) => { qc.setQueryData(['ipc-audit', id], a); void qc.invalidateQueries({ queryKey: ['ipc-audits'] }); };
  const done = useMutation({ mutationFn: () => api<Audit>(`/ipc/audits/${id}/complete`, { body: {} }), onSuccess: set });
  const del = useMutation({ mutationFn: () => api(`/ipc/audits/${id}`, { method: 'DELETE' }), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['ipc-audits'] }); onClose(); } });
  const a = q.data;
  return (
    <Modal title={a ? `${a.template} — ${a.department}` : 'აუდიტი'} onClose={onClose} width={900} footer={a && <>
      {a.can_edit && <button className="btn" type="button" disabled={del.isPending} onClick={() => del.mutate()}>წაშლა</button>}
      <span className="grow" />
      <button className="btn" type="button" onClick={onClose}>დახურვა</button>
      {a.can_edit && <button className="btn primary" type="button" disabled={done.isPending} onClick={() => done.mutate()}>დასრულება</button>}</>}>
      <ErrorBox error={q.error ?? done.error ?? del.error} />
      {q.isLoading || !a ? <Loading /> : (
        <div className="stack" style={{ gap: 12 }}>
          <div className="row small muted" style={{ flexWrap: 'wrap', gap: 14 }}>
            <span>{dt(a.audited_at)}</span><span>{a.auditor}</span>{a.location && <span>{a.location}</span>}
            {a.status === 'completed' ? <span className="chip ok">დასრულებული · {a.compliance === null ? '—' : `${a.compliance}%`}</span> : <span className="chip warn">მიმდინარე</span>}
            {a.target !== null && <span>სამიზნე ≥ {a.target}%</span>}
          </div>
          {a.kind === 'hand_hygiene' ? <HandHygiene a={a} onChange={set} /> : <Checklist a={a} onChange={set} />}
        </div>)}
    </Modal>
  );
}

function HandHygiene({ a, onChange }: { a: Audit; onChange: (a: Audit) => void }) {
  const [f, setF] = useState<{ profession: string; moments: number[]; gloves: boolean }>({ profession: 'nurse', moments: [], gloves: false });
  const add = useMutation({ mutationFn: (action: string) => api<Audit>(`/ipc/audits/${a.id}/observations`, { body: { ...f, action } }),
    onSuccess: (r) => { onChange(r); setF({ ...f, moments: [], gloves: false }); } });
  const del = useMutation({ mutationFn: (oid: string) => api<Audit>(`/ipc/audits/${a.id}/observations/${oid}`, { method: 'DELETE' }), onSuccess: onChange });
  const doneN = a.observations.filter((o) => o.action !== 'missed').length;
  const live = a.observations.length ? Math.round((doneN / a.observations.length) * 1000) / 10 : null;
  return (
    <>
      <ErrorBox error={add.error ?? del.error} />
      {a.can_edit && (
        <div className="card card-pad stack" style={{ gap: 10 }}>
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
            <span className="label" style={{ width: 90 }}>პროფესია</span>
            <div className="seg" role="group" aria-label="პროფესია">{Object.entries(PROF_KA).map(([k, l]) =>
              <button key={k} type="button" aria-pressed={f.profession === k} onClick={() => setF({ ...f, profession: k })}>{l}</button>)}</div>
          </div>
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
            <span className="label" style={{ width: 90 }}>მომენტი</span>
            {[1, 2, 3, 4, 5].map((m) => <label key={m} className="row small" style={{ gap: 4, marginRight: 8 }}><input type="checkbox" checked={f.moments.includes(m)}
              onChange={() => setF({ ...f, moments: f.moments.includes(m) ? f.moments.filter((x) => x !== m) : [...f.moments, m] })} /> {m} — {MOMENT_KA[m]}</label>)}
          </div>
          <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <label className="row small" style={{ gap: 4 }}><input type="checkbox" checked={f.gloves} onChange={(e) => setF({ ...f, gloves: e.target.checked })} /> ხელთათმანი (ჰიგიენის ნაცვლად)</label>
            <span className="grow" />
            <button className="btn" type="button" disabled={!f.moments.length || add.isPending} onClick={() => add.mutate('rub')}>✓ ანტისეპტიკი</button>
            <button className="btn" type="button" disabled={!f.moments.length || add.isPending} onClick={() => add.mutate('wash')}>✓ დაბანა</button>
            <button className="btn danger" type="button" disabled={!f.moments.length || add.isPending} onClick={() => add.mutate('missed')}>✗ გამოტოვება</button>
          </div>
        </div>)}
      <div className="row small" style={{ gap: 16 }}><span>შესაძლებლობა: <strong>{a.observations.length}</strong></span><span>შესრულება: <strong>{doneN}</strong></span>
        <span>შესაბამისობა: <strong style={{ color: pctTone(live, a.target) }}>{live === null ? '—' : `${live}%`}</strong></span></div>
      <table className="table" style={{ fontSize: 13 }}>
        <thead><tr><th>#</th><th>პროფესია</th><th>მომენტი</th><th>ქმედება</th><th /></tr></thead>
        <tbody>{a.observations.map((o, i) => (
          <tr key={o.id}><td className="mono">{i + 1}</td><td>{PROF_KA[o.profession]}</td><td className="small">{o.moments.map((m) => `${m} — ${MOMENT_KA[m]}`).join('; ')}</td>
            <td><span className={`chip ${ACTION[o.action][0]}`}>{ACTION[o.action][1]}</span>{o.gloves && <span className="chip" style={{ marginLeft: 4 }}>ხელთათმანი</span>}</td>
            <td>{a.can_edit && <button className="btn sm" type="button" onClick={() => del.mutate(o.id)}>×</button>}</td></tr>))}
          {!a.observations.length && <tr><td colSpan={5} className="muted">დაკვირვება ჯერ არ არის</td></tr>}
        </tbody>
      </table>
    </>
  );
}

function Checklist({ a, onChange }: { a: Audit; onChange: (a: Audit) => void }) {
  const m = useMutation({ mutationFn: (x: { item_id: string; answer: string; comment?: string | null }) => api<Audit>(`/ipc/audits/${a.id}/answers`, { method: 'PUT', body: { answers: [x] } }),
    onSuccess: onChange });
  const ans = (id: string) => a.answers.find((x) => x.item_id === id);
  const sections = [...new Set(a.items.map((i) => i.section ?? ''))];
  const y = a.answers.filter((x) => x.answer === 'yes').length; const n = a.answers.filter((x) => x.answer === 'no').length;
  const live = y + n ? Math.round((y / (y + n)) * 1000) / 10 : null;
  return (
    <>
      <ErrorBox error={m.error} />
      <div className="row small" style={{ gap: 16 }}><span>პასუხი: <strong>{a.answers.length} / {a.items.filter((i) => i.is_active).length}</strong></span>
        <span>შესაბამისობა: <strong style={{ color: pctTone(live, a.target) }}>{live === null ? '—' : `${live}%`}</strong></span></div>
      {sections.map((s) => (
        <div key={s} className="stack" style={{ gap: 4 }}>
          {s && <strong className="small">{s}</strong>}
          {a.items.filter((i) => (i.section ?? '') === s).map((i) => {
            const cur = ans(i.id);
            return (
              <div key={i.id} className="row" style={{ gap: 10, alignItems: 'flex-start', padding: '6px 0', borderBottom: '1px solid var(--line-soft)' }}>
                <span className="grow small">{i.text}{cur?.comment && <div className="muted">{cur.comment}</div>}</span>
                <div className="seg" role="group" aria-label={i.text}>{ANS.map(([k, l]) =>
                  <button key={k} type="button" aria-pressed={cur?.answer === k} disabled={!a.can_edit || m.isPending}
                    onClick={() => m.mutate({ item_id: i.id, answer: k, comment: cur?.comment ?? null })}>{l}</button>)}</div>
              </div>);
          })}
        </div>))}
    </>
  );
}

function StatsView() {
  const { user } = useAuth(); const depts = useDepts();
  const [from, setFrom] = useState(monthStart()); const [to, setTo] = useState(todayTb()); const [dept, setDept] = useState('');
  const q = useQuery({ queryKey: ['ipc-audit-stats', from, to, dept], queryFn: () => api<Stats>('/ipc/audits/stats', { query: { from, to, department_id: dept } }), enabled: !!from && !!to && from <= to });
  const h = q.data?.hand_hygiene;
  return (
    <>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <input type="date" className="input" style={{ maxWidth: 160, height: 38 }} aria-label="დან" value={from} onChange={(e) => setFrom(e.target.value)} />
        <input type="date" className="input" style={{ maxWidth: 160, height: 38 }} aria-label="მდე" value={to} onChange={(e) => setTo(e.target.value)} />
        {can(user, ...IPC_ANY, 'infection_view') && <select className="select" style={{ maxWidth: 240, height: 38 }} aria-label="განყოფილება" value={dept} onChange={(e) => setDept(e.target.value)}>
          <option value="">ყველა განყოფილება</option>{depts.data?.filter((d) => d.type !== 'administrative').map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>}
      </div>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : h && q.data && <>
        <section className="card card-pad stack" style={{ gap: 10, flexShrink: 0 }}>
          <div className="row" style={{ gap: 24, flexWrap: 'wrap', alignItems: 'baseline' }}>
            <strong className="grow">ხელის ჰიგიენა — WHO „5 მომენტი“</strong>
            <div><span className="small muted">შესაბამისობა </span><strong style={{ fontSize: 24, color: pctTone(h.pct, h.target) }}>{h.pct === null ? '—' : `${h.pct}%`}</strong>
              <span className="small muted"> · სამიზნე ≥ {h.target}% · {h.done} / {h.opps} (ანტისეპტიკი {h.rub}, დაბანა {h.wash})</span></div>
          </div>
          {h.opps > 0 && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14 }}>
            <table className="table" style={{ fontSize: 13 }}><thead><tr><th>მომენტი</th><th className="num">შესაძლ.</th><th className="num">%</th></tr></thead>
              <tbody>{h.moments.map((m) => <tr key={m.moment}><td>{m.moment} — {m.label}</td><td className="num">{m.opps}</td>
                <td className="num" style={{ color: pctTone(m.pct, h.target) }}>{m.pct ?? '—'}</td></tr>)}</tbody></table>
            <table className="table" style={{ fontSize: 13 }}><thead><tr><th>პროფესია</th><th className="num">შესაძლ.</th><th className="num">%</th></tr></thead>
              <tbody>{h.professions.map((p) => <tr key={p.profession}><td>{p.label}</td><td className="num">{p.opps}</td>
                <td className="num" style={{ color: pctTone(p.pct, h.target) }}>{p.pct ?? '—'}</td></tr>)}</tbody></table>
            <table className="table" style={{ fontSize: 13 }}><thead><tr><th>განყოფილება</th><th className="num">შესაძლ.</th><th className="num">%</th></tr></thead>
              <tbody>{h.departments.map((p) => <tr key={p.department_id}><td>{p.department}{p.insufficient && <span className="chip warn" style={{ marginLeft: 6 }}
                title={`${h.min_obs}-ზე ნაკლები შესაძლებლობა თვეში (WHO)`}>არასაკმარისი</span>}</td><td className="num">{p.opps}</td>
                <td className="num" style={{ color: pctTone(p.pct, h.target) }}>{p.pct ?? '—'}</td></tr>)}</tbody></table>
          </div>}
        </section>
        {q.data.checklists.map((t) => (
          <section key={t.template_id} className="card card-pad stack" style={{ gap: 8, flexShrink: 0 }}>
            <div className="row" style={{ alignItems: 'baseline' }}><strong className="grow">{t.template}</strong>
              <strong style={{ fontSize: 20, color: pctTone(t.pct, t.target) }}>{t.pct === null ? '—' : `${t.pct}%`}</strong>
              <span className="small muted" style={{ marginLeft: 8 }}>{t.audits} აუდიტი{t.target !== null ? ` · სამიზნე ≥ ${t.target}%` : ''}</span></div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14 }}>
              <table className="table" style={{ fontSize: 13 }}><thead><tr><th>განყოფილება</th><th className="num">აუდიტი</th><th className="num">%</th></tr></thead>
                <tbody>{t.departments.map((x) => <tr key={x.department_id}><td>{x.department}</td><td className="num">{x.audits}</td>
                  <td className="num" style={{ color: pctTone(x.pct, t.target) }}>{x.pct ?? '—'}</td></tr>)}</tbody></table>
              <table className="table" style={{ fontSize: 13 }}><thead><tr><th>ხშირი „არა“</th><th className="num">%</th></tr></thead>
                <tbody>{t.top_no.map((x) => <tr key={x.item_id}><td className="small">{x.text}</td><td className="num">{x.pct_no ?? '—'}</td></tr>)}
                  {!t.top_no.length && <tr><td colSpan={2} className="muted">—</td></tr>}</tbody></table>
            </div>
          </section>))}
        {!h.opps && !q.data.checklists.length && <div className="alert">პერიოდში დასრულებული აუდიტი არ არის.</div>}
      </>}
    </>
  );
}

function Templates() {
  const q = useAuditTemplates(true);
  const [edit, setEdit] = useState<Template | 'new' | null>(null);
  return (
    <>
      <div className="row"><span className="grow" /><button className="btn primary" type="button" onClick={() => setEdit('new')}>+ ჩეკლისტი</button></div>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : (
        <div className="card" style={{ overflowX: 'auto', flexShrink: 0 }}>
          <table className="table">
            <thead><tr><th>შაბლონი</th><th>ტიპი</th><th className="num">კითხვები</th><th className="num">სამიზნე</th><th /></tr></thead>
            <tbody>{q.data?.map((t) => (
              <tr key={t.id} style={!t.is_active ? { opacity: 0.55 } : undefined}>
                <td><strong>{t.name}</strong><div className="small muted mono">{t.code}{!t.is_active && ' · გათიშული'}</div></td>
                <td className="small">{t.kind === 'hand_hygiene' ? 'დაკვირვება (WHO 5)' : 'ჩეკლისტი'}</td>
                <td className="num">{t.kind === 'checklist' ? t.items.filter((i) => i.is_active).length : '—'}</td>
                <td className="num">{t.target === null ? '—' : `≥ ${t.target}%`}</td>
                <td><button className="btn sm" type="button" onClick={() => setEdit(t)}>რედაქტირება</button></td>
              </tr>))}</tbody>
          </table>
        </div>)}
      {edit && <TemplateDialog t={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </>
  );
}

function TemplateDialog({ t, onClose }: { t: Template | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ code: t?.code ?? '', name: t?.name ?? '', description: t?.description ?? '', target: t?.target === null || t?.target === undefined ? '' : String(t.target),
    is_active: t?.is_active ?? true });
  const [items, setItems] = useState((t?.items ?? []).filter((i) => i.is_active).map((i) => ({ id: i.id as string | undefined, section: i.section ?? '', text: i.text })));
  const hh = t?.kind === 'hand_hygiene';
  const m = useMutation({ mutationFn: () => {
    const body = { name: f.name.trim(), description: f.description.trim() || null, target: f.target === '' ? null : Number(f.target), is_active: f.is_active,
      ...(!hh && { items: items.filter((i) => i.text.trim()).map((i) => ({ ...(i.id && { id: i.id }), section: i.section.trim() || null, text: i.text.trim() })) }) };
    return t ? api(`/ipc/audit-templates/${t.id}`, { method: 'PATCH', body }) : api('/ipc/audit-templates', { body: { ...body, code: f.code.trim() } });
  }, onSuccess: () => { void qc.invalidateQueries({ queryKey: ['ipc-audit-templates'] }); onClose(); } });
  return (
    <Modal title={t ? `შაბლონი — ${t.name}` : 'ახალი ჩეკლისტი'} onClose={onClose} width={760} footer={<>
      <button className="btn" type="button" onClick={onClose}>გაუქმება</button>
      <button className="btn primary" type="button" disabled={m.isPending || f.name.trim().length < 3 || (!t && !/^[a-z][a-z0-9_]{1,19}$/.test(f.code)) || (!hh && !items.some((i) => i.text.trim().length >= 3))}
        onClick={() => m.mutate()}>შენახვა</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <ErrorBox error={m.error} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr 1fr', gap: 12 }}>
          <Field label="კოდი" htmlFor="tp-c" required><input id="tp-c" className="input mono" value={f.code} disabled={!!t} onChange={(e) => setF({ ...f, code: e.target.value })} placeholder="central_line" /></Field>
          <Field label="სახელი" htmlFor="tp-n" required><input id="tp-n" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="სამიზნე, %" htmlFor="tp-t"><input id="tp-t" className="input" type="number" min={0} max={100} value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })} /></Field>
        </div>
        <Field label="აღწერა" htmlFor="tp-d"><textarea id="tp-d" className="textarea" rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> აქტიური</label>
        {hh ? <div className="small muted">ხელის ჰიგიენის შაბლონი — დაკვირვება WHO „5 მომენტით“ (კითხვები არ აქვს).</div> : <>
          <span className="label">კითხვები (ამოღებული კითხვა ითიშება — ძველ აუდიტებში რჩება)</span>
          {items.map((i, k) => (
            <div key={i.id ?? `n${k}`} className="row" style={{ gap: 6 }}>
              <input className="input" style={{ maxWidth: 160, height: 34 }} aria-label="სექცია" placeholder="სექცია" value={i.section} onChange={(e) => setItems(items.map((x, j) => (j === k ? { ...x, section: e.target.value } : x)))} />
              <input className="input grow" style={{ height: 34 }} aria-label="კითხვა" value={i.text} onChange={(e) => setItems(items.map((x, j) => (j === k ? { ...x, text: e.target.value } : x)))} />
              <button className="btn sm" type="button" aria-label="ზემოთ" disabled={k === 0} onClick={() => { const a = [...items]; [a[k - 1], a[k]] = [a[k], a[k - 1]]; setItems(a); }}>↑</button>
              <button className="btn sm" type="button" onClick={() => setItems(items.filter((_, j) => j !== k))}>×</button>
            </div>))}
          <div><button className="btn sm" type="button" onClick={() => setItems([...items, { id: undefined, section: items.at(-1)?.section ?? '', text: '' }])}>+ კითხვა</button></div>
        </>}
      </div>
    </Modal>
  );
}
