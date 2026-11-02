import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { api } from '../../api/client';
import { LineChart } from '../../components/charts';
import { ErrorBox, Loading } from '../../components/ui';
import { downloadFile } from '../reporting/types';
import { dueLabel } from './TaskDialogs';
import type { Refs } from './types';

/**
 * 0084 — სამუშაო სიების ანგარიში / KPI: ღია ახლა, ვადაგადაცილება (წყარო / განყოფილება, ტრენდი), რეაგირების დრო, ხელით დავალებები, კრიტიკული პასუხი; Excel.
 * worklist_all / admin — მთელი კლინიკა; worklist_manage — თავისი განყოფილებები. სახელობითი (შემსრულებლით) — მხოლოდ ხელით დავალებებზე, worklist_all-ს.
 */
type Num = number | null;
interface R {
  from: string; to: string; scope: { all: boolean; departments: string[] | null; named: boolean };
  tracker: { enabled: boolean; interval_min: number; last_run: { started_at: string; finished_at: string | null; users: number | null; items: number | null; failed: string[]; error: string | null } | null };
  kpi: { closed: number; late_pct: Num; response_median_h: Num; tasks_on_time_pct: Num; tasks_created: number; tasks_done: number; crit_ack_median_min: Num; open_now: number; overdue_now: number };
  open_now: { source: string; name: string; group: string; open: number; overdue: number; urgent: number }[];
  open_by_department: { department_id: string | null; name: string | null; open: number; overdue: number }[];
  by_source: { source: string; name: string; group: string; closed: number; due: number; late: number; late_pct: Num; median_h: Num; p90_h: Num }[];
  by_department: { department_id: string | null; name: string | null; closed: number; due: number; late: number; late_pct: Num; median_h: Num }[];
  trend: { day: string; closed: number; late: number; open_peak: Num; overdue_peak: Num }[];
  tasks: { by_department: { department_id: string | null; name: string | null; created: number; done: number; done_due: number; on_time: number; on_time_pct: Num; cancelled: number;
    overdue_open: number; escalated: number; median_h: Num; from_schedule: number }[];
    by_assignee: { user_id: string; name: string; done: number; done_due: number; on_time: number; on_time_pct: Num; median_h: Num }[]; schedules: { active: number; skipped: number } };
  critical: { n: number; acked: number; open: number; late: number; median_min: Num; p90_min: Num; ack_min: number };
}
const fv = (v: Num | undefined, u = '') => (v === null || v === undefined ? '—' : `${v.toLocaleString('en-US', { maximumFractionDigits: 1 })}${u}`);
const SECTIONS: [string, string][] = [['summary', 'შეჯამება'], ['overdue', 'ვადაგადაცილება'], ['response', 'რეაგირების დრო'], ['tasks', 'ხელით დავალებები'], ['critical', 'კრიტიკული პასუხი']];

function Card({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return <section className="card" style={{ overflowX: 'auto' }}><div className="card-pad" style={{ paddingBottom: 6 }}><strong>{title}</strong>{sub && <span className="small muted"> — {sub}</span>}</div>{children}</section>;
}
function Tile({ label, value, tone, sub }: { label: string; value: string; tone?: string; sub?: string }) {
  return <div className="card card-pad stack" style={{ gap: 2 }}><span className="small muted">{label}</span>
    <strong style={{ fontSize: 22, color: tone === 'danger' ? 'var(--danger-ink)' : tone === 'warn' ? 'var(--warn-ink)' : tone === 'ok' ? 'var(--ok-ink)' : undefined }}>{value}</strong>
    {sub && <span className="small muted">{sub}</span>}</div>;
}
const Empty = ({ cols }: { cols: number }) => <tr><td colSpan={cols} className="muted">მონაცემი არ არის</td></tr>;
const lateTone = (v: Num) => (v === null ? '' : v <= 5 ? 'ok' : v <= 15 ? 'warn' : 'danger');

export function WlReportsPage({ refs }: { refs: Refs }) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tbilisi' }).format(new Date());
  const monthAgo = new Date(Date.parse(`${today}T12:00:00Z`) - 29 * 864e5).toISOString().slice(0, 10);
  const [f, setF] = useState({ from: monthAgo, to: today, department_id: '' });
  const [sec, setSec] = useState('summary');
  const [dl, setDl] = useState<unknown>(null);
  const p = { from: f.from, to: f.to, department_id: f.department_id || undefined };
  const q = useQuery({ queryKey: ['wl-report', p], queryFn: () => api<R>('/worklist/reports/summary', { query: p }), enabled: f.from <= f.to });
  const deps = refs.departments.filter((d) => refs.can.all || refs.team_departments.includes(d.id));
  const d = q.data;
  return (
    <div className="content stack">
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <input type="date" className="input" style={{ maxWidth: 160, height: 38 }} aria-label="დან" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        <input type="date" className="input" style={{ maxWidth: 160, height: 38 }} aria-label="მდე" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
        <select className="select" style={{ maxWidth: 260, height: 38 }} aria-label="განყოფილება" value={f.department_id} onChange={(e) => setF({ ...f, department_id: e.target.value })}>
          <option value="">{refs.can.all ? 'მთელი კლინიკა' : 'ჩემი განყოფილებები'}</option>{deps.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
        <span className="grow" />
        <button className="btn" type="button" disabled={!d} onClick={() => { setDl(null); downloadFile('/worklist/reports/export', p, `worklist_report_${f.from}_${f.to}.xlsx`).catch(setDl); }}>Excel</button>
      </div>
      <nav className="row" aria-label="ანგარიშის სექციები" style={{ gap: 2, flexWrap: 'wrap' }}>
        {SECTIONS.map(([k, l]) => <button key={k} type="button" className={`admin-tab${sec === k ? ' active' : ''}`} aria-pressed={sec === k} onClick={() => setSec(k)}>{l}</button>)}
      </nav>
      <ErrorBox error={q.error ?? dl} />
      {q.isLoading ? <Loading /> : d && <>
        <div className="small muted">
          სისტემური ჩანაწერები აღირიცხება ყოველ {d.tracker.interval_min} წთ-ში (სიზუსტე — ინტერვალი){!d.tracker.enabled && ' — აღრიცხვა გამორთულია (kpi_tracker)'}.
          {d.tracker.last_run && <> ბოლო აღრიცხვა: {dueLabel(d.tracker.last_run.started_at)} · მომხმარებელი {d.tracker.last_run.users ?? '—'} · ღია ჩანაწერი {d.tracker.last_run.items ?? '—'}
            {d.tracker.last_run.failed?.length ? ` · შეცდომით: ${d.tracker.last_run.failed.join(', ')}` : ''}{d.tracker.last_run.error ? ` · შეცდომა: ${d.tracker.last_run.error}` : ''}</>}
          {' '}იგივე ფორმულა — მენეჯერულ დაფაზე (ჯგუფი „სამუშაო სიები“).
        </div>
        {sec === 'summary' && <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10 }}>
            <Tile label="ღია ახლა (სისტემური)" value={String(d.kpi.open_now)} sub={`ვადაგადაცილებული: ${d.kpi.overdue_now}`} tone={d.kpi.overdue_now ? 'warn' : undefined} />
            <Tile label="ვადის შემდეგ დაიხურა" value={fv(d.kpi.late_pct, '%')} tone={lateTone(d.kpi.late_pct)} sub={`დაიხურა: ${d.kpi.closed}`} />
            <Tile label="რეაგირების დრო (მედიანა)" value={d.kpi.response_median_h === null ? '—' : `${fv(d.kpi.response_median_h)} სთ`} />
            <Tile label="ხელით დავალება ვადაში" value={fv(d.kpi.tasks_on_time_pct, '%')} sub={`შექმნილი ${d.kpi.tasks_created} · შესრულებული ${d.kpi.tasks_done}`} />
            <Tile label="კრიტიკული — დადასტურება (მედიანა)" value={d.kpi.crit_ack_median_min === null ? '—' : `${fv(d.kpi.crit_ack_median_min)} წთ`}
              tone={d.critical.open ? 'danger' : undefined} sub={`${d.critical.acked} / ${d.critical.n} · დაუდასტურებელი ${d.critical.open}`} />
            <Tile label="განმეორებადი გრაფიკი" value={String(d.tasks.schedules.active)} sub={`გამოტოვდა (წინა ღია): ${d.tasks.schedules.skipped}`} />
          </div>
          <Card title="ტრენდი" sub="დღეში: დაიხურა / ვადის შემდეგ; ღია და ვადაგადაცილებული — დღის პიკი">
            <div className="card-pad"><LineChart labels={d.trend.map((t) => t.day.slice(5))} series={[
              { name: 'დაიხურა', values: d.trend.map((t) => t.closed), color: 'var(--accent)' },
              { name: 'ვადის შემდეგ', values: d.trend.map((t) => t.late), color: 'var(--danger-ink)' },
              { name: 'ღია (პიკი)', values: d.trend.map((t) => t.open_peak), color: 'var(--muted)', dashed: true },
              { name: 'ვადაგადაცილებული (პიკი)', values: d.trend.map((t) => t.overdue_peak), color: 'var(--warn-ink)', dashed: true }]} /></div>
          </Card>
          <Card title="ღია ახლა — წყაროთი" sub="ბოლო აღრიცხვით">
            <table className="table small"><thead><tr><th>ჯგუფი</th><th>წყარო</th><th className="num">ღია</th><th className="num">ვადაგადაცილებული</th><th className="num">სასწრაფო</th></tr></thead>
              <tbody>{!d.open_now.length ? <Empty cols={5} /> : d.open_now.map((r) => <tr key={r.source}><td>{r.group}</td><td>{r.name}</td><td className="num">{r.open}</td>
                <td className="num" style={{ color: r.overdue ? 'var(--danger-ink)' : undefined }}>{r.overdue}</td><td className="num">{r.urgent}</td></tr>)}</tbody></table>
          </Card>
        </>}
        {sec === 'overdue' && <>
          <Card title="განყოფილებით" sub="დახურული პერიოდში; ღია — ახლა">
            <table className="table small"><thead><tr><th>განყოფილება</th><th className="num">დაიხურა</th><th className="num">ვადით</th><th className="num">ვადის შემდეგ</th><th className="num">%</th><th className="num">ღია ახლა</th><th className="num">ვადაგად. ახლა</th></tr></thead>
              <tbody>{!d.by_department.length && !d.open_by_department.length ? <Empty cols={7} /> : (() => {
                const keys = [...new Set([...d.by_department.map((x) => x.department_id ?? ''), ...d.open_by_department.map((x) => x.department_id ?? '')])];
                return keys.map((k) => { const a = d.by_department.find((x) => (x.department_id ?? '') === k); const o = d.open_by_department.find((x) => (x.department_id ?? '') === k);
                  return <tr key={k || '—'}><td>{a?.name ?? o?.name ?? '— (განყოფილების გარეშე)'}</td><td className="num">{a?.closed ?? 0}</td><td className="num">{a?.due ?? 0}</td>
                    <td className="num">{a?.late ?? 0}</td><td className="num" style={{ color: lateTone(a?.late_pct ?? null) === 'danger' ? 'var(--danger-ink)' : undefined }}>{fv(a?.late_pct ?? null)}</td>
                    <td className="num">{o?.open ?? 0}</td><td className="num" style={{ color: o?.overdue ? 'var(--danger-ink)' : undefined }}>{o?.overdue ?? 0}</td></tr>; }); })()}</tbody></table>
          </Card>
          <Card title="წყაროთი" sub="დახურული პერიოდში">
            <table className="table small"><thead><tr><th>ჯგუფი</th><th>წყარო</th><th className="num">დაიხურა</th><th className="num">ვადით</th><th className="num">ვადის შემდეგ</th><th className="num">%</th></tr></thead>
              <tbody>{!d.by_source.length ? <Empty cols={6} /> : d.by_source.map((r) => <tr key={r.source}><td>{r.group}</td><td>{r.name}</td><td className="num">{r.closed}</td><td className="num">{r.due}</td>
                <td className="num">{r.late}</td><td className="num" style={{ color: lateTone(r.late_pct) === 'danger' ? 'var(--danger-ink)' : undefined }}>{fv(r.late_pct)}</td></tr>)}</tbody></table>
          </Card>
        </>}
        {sec === 'response' && <Card title="რეაგირების დრო — წყაროთი" sub="შექმნიდან (წყაროს დრო; არ არის — პირველი გამოჩენა) დახურვამდე, სთ">
          <table className="table small"><thead><tr><th>ჯგუფი</th><th>წყარო</th><th className="num">დაიხურა</th><th className="num">მედიანა</th><th className="num">p90</th></tr></thead>
            <tbody>{!d.by_source.length ? <Empty cols={5} /> : [...d.by_source].sort((a, b) => (b.median_h ?? 0) - (a.median_h ?? 0)).map((r) => <tr key={r.source}><td>{r.group}</td><td>{r.name}</td>
              <td className="num">{r.closed}</td><td className="num">{fv(r.median_h)}</td><td className="num">{fv(r.p90_h)}</td></tr>)}</tbody></table>
        </Card>}
        {sec === 'tasks' && <>
          <Card title="ხელით დავალებები — განყოფილებით" sub="შექმნა / შესრულება / გაუქმება — პერიოდში; ვადაგადაცილებული ღია — ახლა">
            <table className="table small"><thead><tr><th>განყოფილება</th><th className="num">შექმნილი</th><th className="num">მ.შ. გრაფიკით</th><th className="num">შესრულებული</th><th className="num">ვადაში</th><th className="num">%</th>
              <th className="num">გაუქმებული</th><th className="num">ვადაგად. ღია</th><th className="num">ესკალაცია</th><th className="num">მედიანა, სთ</th></tr></thead>
              <tbody>{!d.tasks.by_department.length ? <Empty cols={10} /> : d.tasks.by_department.map((r) => <tr key={r.department_id ?? '—'}><td>{r.name ?? '—'}</td><td className="num">{r.created}</td>
                <td className="num">{r.from_schedule}</td><td className="num">{r.done}</td><td className="num">{r.on_time} / {r.done_due}</td><td className="num">{fv(r.on_time_pct)}</td><td className="num">{r.cancelled}</td>
                <td className="num" style={{ color: r.overdue_open ? 'var(--danger-ink)' : undefined }}>{r.overdue_open}</td><td className="num">{r.escalated}</td><td className="num">{fv(r.median_h)}</td></tr>)}</tbody></table>
          </Card>
          {d.scope.named && <Card title="შემსრულებლით" sub="მხოლოდ ხელით დავალებები (worklist_all)">
            <table className="table small"><thead><tr><th>თანამშრომელი</th><th className="num">შესრულებული</th><th className="num">ვადაში</th><th className="num">%</th><th className="num">მედიანა, სთ</th></tr></thead>
              <tbody>{!d.tasks.by_assignee.length ? <Empty cols={5} /> : d.tasks.by_assignee.map((r) => <tr key={r.user_id}><td>{r.name}</td><td className="num">{r.done}</td>
                <td className="num">{r.on_time} / {r.done_due}</td><td className="num">{fv(r.on_time_pct)}</td><td className="num">{fv(r.median_h)}</td></tr>)}</tbody></table>
          </Card>}
        </>}
        {sec === 'critical' && <Card title="კრიტიკული პასუხი — ექიმის დადასტურება" sub={`ლაბ. HH / LL, რადიოლოგიის კრიტიკული მიგნება · ვალიდაცია პერიოდში · ზღვარი ${d.critical.ack_min} წთ`}>
          <div className="card-pad" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10 }}>
            <Tile label="კრიტიკული პასუხი" value={String(d.critical.n)} />
            <Tile label="დადასტურებული" value={String(d.critical.acked)} />
            <Tile label="დაუდასტურებელი" value={String(d.critical.open)} tone={d.critical.open ? 'danger' : 'ok'} />
            <Tile label="ზღვარზე გვიან / დაუდასტურებელი" value={String(d.critical.late)} tone={d.critical.late ? 'warn' : undefined} />
            <Tile label="მედიანა" value={d.critical.median_min === null ? '—' : `${d.critical.median_min} წთ`} />
            <Tile label="p90" value={d.critical.p90_min === null ? '—' : `${d.critical.p90_min} წთ`} />
          </div>
        </Card>}
      </>}
    </div>
  );
}
