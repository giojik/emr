import { useQuery } from '@tanstack/react-query';
import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, can } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Loading } from '../../components/ui';
import { dateGe, dayTitle, hhmm, shiftDay, todayISO } from '../../lib/format';
import { RequestDialog, ScheduleDialog } from './Dialogs';
import Library from './Library';
import { OrStats, PacuBoard } from './Postop';
import Roster, { DayDialog, useRoster } from './Roster';
import { ANESTHESIA_KA, CASE_ST, caseLink, chip, hm, PHASE_KA, URGENCY, useOrModule, useOrSetup, type Board, type CaseRow } from './types';

/** საოპერაციო ბლოკი (0048): დაფა (დღე / კვირა), რიგი, ჩემი ოპერაციები; 0050: PACU, სტატისტიკა */
export default function Or() {
  const { user } = useAuth(); const mod = useOrModule();
  const [sp] = useSearchParams();
  const tab = sp.get('tab') ?? (can(user, 'or_schedule', 'admin') ? 'board' : can(user, 'doctor', 'anesthesiologist') ? 'my' : 'board');
  const tabs: [string, string][] = [['board', 'ბლოკის დაფა'], ['queue', 'რიგი / მოთხოვნები'], ['my', 'ჩემი ოპერაციები'], ['roster', 'ოთახის გუნდი']];
  tabs.splice(2, 0, ['pacu', 'PACU']);
  if (can(user, 'admin', 'doctor', 'or_nurse')) tabs.push(['library', 'შაბლონები / ბარათები']);
  if (can(user, 'admin', 'manager', 'or_schedule', 'viewer')) tabs.push(['stats', 'სტატისტიკა']);
  if (mod.loading) return <div className="content"><Loading /></div>;
  return (
    <>
      <header className="topbar" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8, paddingBottom: 0 }}>
        <div className="row"><h1 className="grow">საოპერაციო ბლოკი</h1>
          {can(user, 'admin') && <Link className="btn sm" to="/admin/or">ოთახები / კატალოგი</Link>}</div>
        <nav aria-label="საოპერაციო" className="row" style={{ gap: 2, flexWrap: 'wrap' }}>
          {tabs.map(([k, l]) => <Link key={k} to={`/or?tab=${k}`} className={`admin-tab${tab === k ? ' active' : ''}`}>{l}</Link>)}
        </nav>
      </header>
      {!mod.enabled ? <div className="content"><div className="card empty">მოდული „საოპერაციო ბლოკი“ გამორთულია (ადმინისტრირება → მოდულები).</div></div>
        : tab === 'queue' ? <Queue /> : tab === 'my' ? <Mine /> : tab === 'roster' ? <Roster /> : tab === 'library' ? <Library /> : tab === 'pacu' ? <PacuBoard />
          : tab === 'stats' ? <OrStats /> : <BoardView />}
    </>
  );
}

// ================================================================= დაფა
const PX = 1.1;   // px წუთზე
function BoardView() {
  const [sp, setSp] = useSearchParams(); const { user } = useAuth(); const setup = useOrSetup(); const nav = useNavigate();
  const date = sp.get('date') ?? todayISO(); const days = sp.get('view') === 'week' ? 7 : 1; const block = sp.get('block') ?? '';
  const q = useQuery({ queryKey: ['or-board', date, days, block], queryFn: () => api<Board>('/or/board', { query: { date, days, block_id: block || undefined } }), refetchInterval: 30_000 });
  const upd = (k: string, v: string) => { if (v) sp.set(k, v); else sp.delete(k); setSp(sp, { replace: true }); };
  const [sched, setSched] = useState<CaseRow | null>(null);
  const [req, setReq] = useState(false);
  const coord = can(user, 'admin', 'or_schedule');
  const blocks = setup.data?.blocks ?? [];
  return (
    <div className="content">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <div className="seg" role="group" aria-label="ხედი"><button type="button" aria-pressed={days === 1} onClick={() => upd('view', '')}>დღე</button>
          <button type="button" aria-pressed={days === 7} onClick={() => upd('view', 'week')}>კვირა</button></div>
        <button className="btn sm" type="button" aria-label="წინა" onClick={() => upd('date', shiftDay(date, -days))}>←</button>
        <input className="input" type="date" aria-label="თარიღი" style={{ height: 38, maxWidth: 170 }} value={date} onChange={(e) => upd('date', e.target.value)} />
        <button className="btn sm" type="button" aria-label="შემდეგი" onClick={() => upd('date', shiftDay(date, days))}>→</button>
        <button className="btn sm" type="button" onClick={() => upd('date', '')}>დღეს</button>
        <strong>{days === 1 ? dayTitle(date) : `${dateGe(date)} — ${dateGe(shiftDay(date, 6))}`}</strong>
        <span className="grow" />
        {blocks.length > 1 && <select className="select" style={{ maxWidth: 240, height: 38 }} aria-label="ბლოკი" value={block} onChange={(e) => upd('block', e.target.value)}>
          <option value="">ყველა ბლოკი</option>{blocks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>}
        {can(user, 'doctor', 'admin') && <button className="btn primary" type="button" onClick={() => setReq(true)}>+ ოპერაციის მოთხოვნა</button>}
      </div>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : !q.data?.rooms.length ? <div className="card empty">საოპერაციო ოთახები არ არის — ადმინისტრირება → საოპერაციო.</div> : (
        <div className="row-top" style={{ alignItems: 'stretch' }}>
          <div className="grow" style={{ minWidth: 0 }}>{days === 1 ? <DayGrid b={q.data} /> : <WeekGrid b={q.data} onDay={(d) => { sp.set('date', d); sp.delete('view'); setSp(sp); }} />}</div>
          <aside className="card" style={{ width: 320, flexShrink: 0, alignSelf: 'flex-start', maxHeight: 'calc(100vh - 220px)', overflow: 'auto' }}>
            <div className="card-head"><h2 className="grow">რიგი</h2><span className="chip">{q.data.queue.length}</span></div>
            <div className="stack" style={{ padding: 10, gap: 8 }}>
              {q.data.queue.map((c) => (
                <div key={c.id} className="card" style={{ padding: 10, borderLeft: `4px solid ${c.urgency === 'emergency' ? 'var(--danger)' : c.urgency === 'urgent' ? 'var(--warn-line)' : 'var(--line)'}` }}>
                  <div className="row" style={{ gap: 6 }}><Link to={caseLink(c.id)} className="grow" style={{ fontWeight: 600 }}>{c.last_name} {c.first_name}</Link>{chip(URGENCY, c.urgency)}</div>
                  <div className="small">{c.procedures}</div>
                  <div className="small muted">{c.surgeon_name} · {c.duration_min} წთ · {ANESTHESIA_KA[c.anesthesia_type]}</div>
                  <div className="row small" style={{ gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                    {c.status === 'tentative' ? <span className="chip warn">დასადასტურებელი: {c.room_code} {dateGe(c.scheduled_start!.slice(0, 10))} {hhmm(c.scheduled_start!)}</span>
                      : c.preferred_date ? <span className="chip">სასურველი: {dateGe(c.preferred_date)}{c.preferred_time ? ` ${hm(c.preferred_time)}` : ''}</span> : null}
                    {!c.encounter_id && <span className="chip info">გეგმიური რიგი</span>}
                    {c.readiness && !c.readiness.ready && <span className="chip warn" title="მზადყოფნა">მზადება: {c.readiness.missing}</span>}
                    {c.postpone_count > 0 && <span className="chip">გადაიდო ×{c.postpone_count}</span>}
                  </div>
                  {coord && <button className="btn sm" style={{ marginTop: 6 }} type="button" onClick={() => setSched(c)}>{c.status === 'tentative' ? 'დადასტურება / გადატანა' : 'დაგეგმვა'}</button>}
                </div>))}
              {!q.data.queue.length && <span className="small muted" style={{ padding: 6 }}>რიგი ცარიელია</span>}
            </div>
          </aside>
        </div>)}
      {sched && <ScheduleDialog c={{ ...sched, preferred_date: sched.preferred_date, preferred_time: sched.preferred_time }} coordinator={coord} onClose={() => setSched(null)} />}
      {req && <RequestDialog onClose={() => setReq(false)} onDone={(id) => nav(caseLink(id))} />}
    </div>
  );
}

const minutesOf = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const localMin = (iso: string) => minutesOf(hhmm(iso));
function caseColors(c: CaseRow) {
  if (c.status === 'completed') return { bg: 'var(--line-soft)', line: 'var(--line)', ink: 'var(--muted)' };
  if (c.status === 'in_progress') return { bg: 'var(--ok-weak)', line: 'var(--ok-line)', ink: 'var(--ok-ink)' };
  if (c.status === 'tentative') return { bg: 'var(--warn-weak)', line: 'var(--warn-line)', ink: 'var(--warn-ink)' };
  return { bg: 'var(--info-weak)', line: 'var(--info-line)', ink: 'var(--info-ink)' };
}

function DayGrid({ b }: { b: Board }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(t); }, []);
  const dayStart = new Date(`${b.date}T00:00:00+04:00`).getTime();
  const { from, to } = useMemo(() => {
    // ხილული საათები: ოთახების სამუშაო დრო (ცვლა-უწყვეტი 24-საათიანი ოთახების გარდა) + დღის ოპერაციები; ნაგულისხმევი 08–20
    const shift = b.rooms.filter((r) => minutesOf(hm(r.work_end)) - minutesOf(hm(r.work_start)) < 20 * 60);
    let f = shift.length ? Math.min(...shift.map((r) => minutesOf(hm(r.work_start)))) : 8 * 60;
    let t = shift.length ? Math.max(...shift.map((r) => minutesOf(hm(r.work_end)))) : 20 * 60;
    for (const c of b.cases) {
      if (!c.scheduled_start || !c.scheduled_end) continue;
      f = Math.min(f, Math.max(0, (new Date(c.scheduled_start).getTime() - dayStart) / 60000));
      t = Math.max(t, Math.min(24 * 60, (new Date(c.scheduled_end).getTime() - dayStart) / 60000));
    }
    return { from: Math.max(0, Math.floor(f / 60) * 60 - 60), to: Math.min(24 * 60, Math.ceil(t / 60) * 60 + 60) };
  }, [b, dayStart]);
  const height = (to - from) * PX;
  const today = b.date === todayISO();
  const nowMin = localMin(new Date(now).toISOString());
  const hours = []; for (let m = from; m <= to; m += 60) hours.push(m);
  // ოთახის დღის გუნდი (0049): სათაურთან; მმართველს — ერთი დაწკაპებით „დღეს სხვა ოთახში / არ არის“
  const roster = useRoster(b.date, b.room_teams && b.date >= todayISO());
  const [move, setMove] = useState<{ user_id: string } | null>(null);
  const canMove = (grp: string) => !!roster.data && (grp === 'anesthesia' ? roster.data.can.anesthesia : roster.data.can.nursing);
  const pos = (c: CaseRow) => {
    const s = Math.max(0, (new Date(c.scheduled_start!).getTime() - dayStart) / 60000);
    const e = Math.min(24 * 60, (new Date(c.scheduled_end!).getTime() - dayStart) / 60000);
    return { top: (s - from) * PX, h: Math.max(22, (e - s) * PX) };
  };
  return (
    <div className="card" style={{ overflow: 'auto' }}>
      <div style={{ display: 'grid', gridTemplateColumns: `56px repeat(${b.rooms.length}, minmax(190px, 1fr))`, minWidth: 56 + 190 * b.rooms.length }}>
        <div style={{ borderBottom: '1px solid var(--line)', position: 'sticky', top: 0, background: 'var(--surface)', zIndex: 3 }} />
        {b.rooms.map((r) => (
          <div key={r.id} style={{ padding: '10px 12px', borderBottom: '1px solid var(--line)', borderLeft: '1px solid var(--line-soft)', position: 'sticky', top: 0, background: 'var(--surface)', zIndex: 3 }}>
            <strong>{r.code}</strong> <span className="small muted">{r.name}</span>
            <div className="small muted">{hm(r.work_start)}–{hm(r.work_end)}{r.emergency_only ? ' · გადაუდებელი' : ''}</div>
            {b.room_teams && r.team.length > 0 && <div className="row" style={{ gap: 3, flexWrap: 'wrap', marginTop: 4 }} aria-label={`დღის გუნდი — ${r.code}`}>
              {r.team.map((m) => {
                const label = <>{m.name.split(' ')[0]} <span className="muted">· {m.role_name}</span></>;
                const st = { height: 20, fontSize: 11, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block', lineHeight: '20px' } as const;
                return canMove(m.grp)
                  ? <button key={`${m.user_id}${m.role_code}`} type="button" className={`chip ${m.source === 'day' ? 'info' : ''}`} style={{ ...st, cursor: 'pointer', border: 0 }}
                      title={`${m.name} — სხვა ოთახში დღეს / დღეს არ არის`} onClick={() => setMove({ user_id: m.user_id })}>{label}</button>
                  : <span key={`${m.user_id}${m.role_code}`} className={`chip ${m.source === 'day' ? 'info' : ''}`} style={st} title={m.name}>{label}</span>; })}
            </div>}
          </div>))}
        <div style={{ position: 'relative', height }}>
          {hours.map((m) => <span key={m} className="small muted mono" style={{ position: 'absolute', top: Math.max(2, (m - from) * PX - 8), right: 8 }}>{String(m / 60).padStart(2, '0')}:00</span>)}
        </div>
        {b.rooms.map((r) => {
          const ws = minutesOf(hm(r.work_start)); const we = minutesOf(hm(r.work_end));
          const dow = ((new Date(`${b.date}T12:00:00+04:00`).getUTCDay() + 6) % 7) + 1;
          const works = r.work_days.includes(dow);
          return (
            <div key={r.id} style={{ position: 'relative', height, borderLeft: '1px solid var(--line-soft)',
              background: `repeating-linear-gradient(to bottom, transparent 0, transparent ${60 * PX - 1}px, var(--line-soft) ${60 * PX - 1}px, var(--line-soft) ${60 * PX}px)` }}>
              {/* არასამუშაო საათები */}
              {(!works ? [[from, to]] : [[from, ws], [we, to]]).filter(([a, z]) => z > a).map(([a, z]) => (
                <div key={a} aria-hidden="true" style={{ position: 'absolute', left: 0, right: 0, top: (a - from) * PX, height: (z - a) * PX,
                  background: 'repeating-linear-gradient(135deg, transparent 0 6px, rgba(27,34,31,.04) 6px 12px)' }} />))}
              {b.cases.filter((c) => c.room_id === r.id && c.scheduled_start).map((c) => {
                const p = pos(c); const col = caseColors(c);
                return (
                  <Link key={c.id} to={caseLink(c.id)} title={`${c.case_no} · ${c.procedures ?? ''}`}
                    style={{ position: 'absolute', left: 4, right: 4, top: p.top, height: p.h, background: col.bg, border: `1px ${c.status === 'tentative' ? 'dashed' : 'solid'} ${col.line}`,
                      borderLeft: `4px solid ${c.urgency === 'emergency' ? 'var(--danger)' : col.line}`, borderRadius: 8, padding: '4px 8px', overflow: 'hidden', color: col.ink,
                      textDecoration: 'none', fontSize: 12, lineHeight: 1.35, zIndex: 1 }}>
                    <div className="row" style={{ gap: 6 }}><strong className="mono">{hhmm(c.scheduled_start!)}–{hhmm(c.scheduled_end!)}</strong>
                      <span className="grow" />{c.status === 'in_progress' && c.phase ? <span className="chip accent" style={{ height: 18, fontSize: 10 }}>{PHASE_KA[c.phase]}</span> : chip(CASE_ST, c.status)}</div>
                    <div style={{ fontWeight: 600, color: 'var(--ink)' }}>{c.last_name} {c.first_name} <span className="muted" style={{ fontWeight: 400 }}>· {c.age}</span></div>
                    <div>{c.procedures}</div>
                    <div className="muted">{c.surgeon_name}{c.anesthesiologist_name ? ` · ანესთ.: ${c.anesthesiologist_name}` : ''}</div>
                    <div className="row" style={{ gap: 4, flexWrap: 'wrap', marginTop: 2 }}>
                      {c.urgency !== 'elective' && chip(URGENCY, c.urgency)}
                      {c.readiness && !c.readiness.ready && <span className="chip warn" style={{ height: 18, fontSize: 10 }}>მზადება: {c.readiness.missing}</span>}
                      {c.readiness?.ready && <span className="chip ok" style={{ height: 18, fontSize: 10 }}>მზადაა</span>}
                      {!c.encounter_id && <span className="chip info" style={{ height: 18, fontSize: 10 }}>ჯერ არ არის მიღებული</span>}
                      {c.needs_icu && <span className="chip" style={{ height: 18, fontSize: 10 }}>ICU</span>}
                    </div>
                  </Link>);
              })}
              {today && nowMin >= from && nowMin <= to && <div aria-hidden="true" style={{ position: 'absolute', left: 0, right: 0, top: (nowMin - from) * PX, borderTop: '2px solid var(--danger)', zIndex: 2 }} />}
            </div>);
        })}
      </div>
      {move && roster.data && <DayDialog r={roster.data} init={move} onClose={() => setMove(null)} />}
    </div>
  );
}

const shortDay = (iso: string) => `${new Intl.DateTimeFormat('ka-GE', { timeZone: 'Asia/Tbilisi', weekday: 'short' }).format(new Date(`${iso}T12:00:00+04:00`))} ${dateGe(iso).slice(0, 5)}`;
function WeekGrid({ b, onDay }: { b: Board; onDay: (d: string) => void }) {
  const days = Array.from({ length: 7 }, (_, i) => shiftDay(b.date, i));
  const localDate = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tbilisi' }).format(new Date(iso));
  return (
    <div className="card" style={{ overflow: 'auto' }}>
      <table className="table" style={{ tableLayout: 'fixed', minWidth: 140 + 7 * 150 }}>
        <thead><tr><th style={{ width: 140 }}>ოთახი</th>{days.map((d) => <th key={d}><button className="btn sm" type="button" style={{ height: 26 }} onClick={() => onDay(d)}>{shortDay(d)}</button></th>)}</tr></thead>
        <tbody>{b.rooms.map((r) => (
          <tr key={r.id}>
            <td><strong>{r.code}</strong><div className="small muted">{r.name}</div></td>
            {days.map((d) => {
              const xs = b.cases.filter((c) => c.room_id === r.id && c.scheduled_start && localDate(c.scheduled_start) === d);
              const mins = xs.reduce((a, c) => a + (new Date(c.scheduled_end!).getTime() - new Date(c.scheduled_start!).getTime()) / 60000, 0);
              const cap = minutesOf(hm(r.work_end)) - minutesOf(hm(r.work_start));
              return (
                <td key={d} style={{ verticalAlign: 'top', padding: 6 }}>
                  <div className="stack" style={{ gap: 4 }}>
                    {xs.map((c) => { const col = caseColors(c); return (
                      <Link key={c.id} to={caseLink(c.id)} className="small" style={{ display: 'block', background: col.bg, border: `1px ${c.status === 'tentative' ? 'dashed' : 'solid'} ${col.line}`,
                        borderLeft: `3px solid ${c.urgency === 'emergency' ? 'var(--danger)' : col.line}`, borderRadius: 6, padding: '2px 6px', color: 'var(--ink)', textDecoration: 'none' }}>
                        <span className="mono">{hhmm(c.scheduled_start!)}</span> {c.last_name}<div className="muted" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.procedures}</div></Link>); })}
                    {xs.length > 0 && <span className="small muted">{Math.round((mins / cap) * 100)}% დატვირთვა</span>}
                  </div>
                </td>);
            })}
          </tr>))}</tbody>
      </table>
    </div>
  );
}

// ================================================================= რიგი / სია
function Queue() {
  const [status, setStatus] = useState('open'); const { user } = useAuth();
  const q = useQuery({ queryKey: ['or-cases', status], queryFn: () => api<CaseRow[]>('/or/cases', { query: { status } }), refetchInterval: 60_000 });
  const [sched, setSched] = useState<CaseRow | null>(null);
  const coord = can(user, 'admin', 'or_schedule');
  const F: [string, string][] = [['open', 'აქტიური'], ['requested', 'მოთხოვნები'], ['tentative', 'დასადასტურებელი'], ['scheduled', 'დაგეგმილი'], ['completed', 'დასრულებული'], ['cancelled', 'გაუქმებული']];
  return (
    <div className="content">
      <div className="seg" role="group" aria-label="სტატუსი" style={{ width: 'max-content', flexWrap: 'wrap' }}>
        {F.map(([k, l]) => <button key={k} type="button" aria-pressed={status === k} onClick={() => setStatus(k)}>{l}</button>)}</div>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : <CaseTable rows={q.data ?? []} action={coord ? (c) => ['requested', 'tentative', 'scheduled'].includes(c.status)
        ? <button className="btn sm" type="button" onClick={() => setSched(c)}>{c.status === 'requested' ? 'დაგეგმვა' : c.status === 'tentative' ? 'დადასტურება' : 'გადატანა'}</button> : null : undefined} />}
      {sched && <ScheduleDialog c={sched} coordinator={coord} onClose={() => setSched(null)} />}
    </div>
  );
}

function Mine() {
  const q = useQuery({ queryKey: ['or-my'], queryFn: () => api<CaseRow[]>('/or/my'), refetchInterval: 60_000 });
  return (
    <div className="content">
      <span className="hint">ოპერაციები, სადაც ხართ ოპერატორი, მომთხოვნი ან გუნდის წევრი — გუშინდელიდან.</span>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : <CaseTable rows={q.data ?? []} mine />}
    </div>
  );
}

export function CaseTable({ rows, action, mine }: { rows: CaseRow[]; action?: (c: CaseRow) => ReactNode; mine?: boolean }) {
  const nav = useNavigate();
  let lastDay = '';
  return (
    <div className="card"><table className="table">
      <thead><tr><th>დრო / ოთახი</th><th>პაციენტი</th><th>პროცედურა</th><th>ქირურგი / ანესთეზიოლოგი</th><th>სტატუსი</th>{mine && <th>ჩემი როლი</th>}<th /></tr></thead>
      <tbody>{rows.map((c) => {
        const d = c.scheduled_start ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tbilisi' }).format(new Date(c.scheduled_start)) : '';
        const head = mine && d !== lastDay; lastDay = d;
        return (
          <Fragment key={c.id}>
            {head && <tr><td colSpan={7} style={{ background: 'var(--surface-2)', fontWeight: 600 }}>{d ? dayTitle(d) : 'დაუგეგმავი'}</td></tr>}
            <tr className="clickable" onClick={() => nav(caseLink(c.id))}>
              <td className="mono">{c.scheduled_start ? <>{dateGe(d)} {hhmm(c.scheduled_start)}<div className="small">{c.room_code}</div></> : <span className="muted">{c.preferred_date ? `სასურველი ${dateGe(c.preferred_date)}` : '—'}</span>}</td>
              <td><strong>{c.last_name} {c.first_name}</strong> <span className="small muted">{c.age}</span><div className="small muted">{c.case_no} · {c.department_name}</div></td>
              <td className="small">{c.procedures}<div className="muted">{ANESTHESIA_KA[c.anesthesia_type]} · {c.duration_min} წთ</div></td>
              <td className="small">{c.surgeon_name}<div className="muted">{c.anesthesiologist_name ?? '—'}</div></td>
              <td><div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>{c.status === 'in_progress' && c.phase ? <span className="chip accent">{PHASE_KA[c.phase]}</span> : chip(CASE_ST, c.status)}
                {c.urgency !== 'elective' && chip(URGENCY, c.urgency)}{c.readiness && !c.readiness.ready && <span className="chip warn">მზადება: {c.readiness.missing}</span>}</div></td>
              {mine && <td className="small">{c.my_roles?.join(', ') || '—'}</td>}
              <td onClick={(e) => e.stopPropagation()}>{action?.(c)}</td>
            </tr>
          </Fragment>);
      })}
        {!rows.length && <tr><td colSpan={7} className="empty">ჩანაწერი არ არის</td></tr>}</tbody>
    </table></div>
  );
}
