import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiError, api } from '../../api/client';
import { ErrorBox, Field, Loading, Modal, useToast } from '../../components/ui';
import { hhmm, todayISO, tsDate } from '../../lib/format';
import { useModules } from '../../lib/modules';
import RosterSetupPage from './RosterSetup';
import RosterStaffPage from './RosterStaff';
import {
  CAT_KA, DOW_KA, KIND_KA, STATUS_KA, ddmm, monthLabel, timeRange, useRefs,
  type Category, type Entry, type Refs, type RosterDetail, type RosterRow, type Template, type Violation,
} from './types';

/** ცვლები და მორიგეობა (0077): განრიგი (ბადე), მორიგეები ახლა, ჩემი განრიგი, თანამშრომლები, ცნობარები */
export default function Roster() {
  const mods = useModules(); const refs = useRefs();
  const [sp] = useSearchParams();
  const enabled = mods.data?.find((m) => m.code === 'roster')?.enabled;
  const c = refs.data?.can;
  const anyDept = !!refs.data?.departments.some((d) => d.can_view);
  const tabs: [string, string, boolean][] = [
    ['grid', 'განრიგი', anyDept], ['duty', 'მორიგეები', true], ['my', 'ჩემი განრიგი', true],
    ['staff', 'თანამშრომლები', !!c && (c.staff_all || c.view_all || c.edit_depts.length > 0)], ['setup', 'ცნობარები', !!c && (c.setup || c.hr || c.edit_all || c.edit_depts.length > 0)]];
  const def = anyDept ? 'grid' : 'duty';
  const tab = sp.get('tab') ?? def;
  if (mods.isLoading || (enabled && refs.isLoading)) return <div className="content"><Loading /></div>;
  return (
    <>
      <header className="topbar" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8, paddingBottom: 0 }}>
        <h1>ცვლები და მორიგეობა</h1>
        <nav aria-label="ცვლები და მორიგეობა" className="row" style={{ gap: 2, flexWrap: 'wrap' }}>
          {tabs.filter((t) => t[2]).map(([k, l]) => <Link key={k} to={`/roster?tab=${k}`} className={`admin-tab${tab === k ? ' active' : ''}`} aria-current={tab === k ? 'page' : undefined}>{l}</Link>)}
        </nav>
      </header>
      {!enabled ? <div className="content"><div className="card empty">მოდული „ცვლები და მორიგეობა“ გამორთულია (ადმინისტრირება → მოდულები).</div></div>
        : refs.error ? <div className="content"><ErrorBox error={refs.error} /></div>
        : tab === 'duty' ? <DutyPage refs={refs.data!} /> : tab === 'my' ? <MyPage /> : tab === 'staff' ? <RosterStaffPage refs={refs.data!} />
        : tab === 'setup' ? <RosterSetupPage refs={refs.data!} /> : <GridPage refs={refs.data!} />}
    </>
  );
}

const nextMonth = (m: string) => { const [y, mm] = m.split('-').map(Number); return mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, '0')}`; };
const prevMonth = (m: string) => { const [y, mm] = m.split('-').map(Number); return mm === 1 ? `${y - 1}-12` : `${y}-${String(mm - 1).padStart(2, '0')}`; };
const errBody = (e: unknown) => (e instanceof ApiError ? e.body ?? {} : {}) as Record<string, unknown>;

// ---------------------------------------------------------------- განრიგი
function GridPage({ refs }: { refs: Refs }) {
  const [sp, setSp] = useSearchParams(); const qc = useQueryClient(); const toast = useToast();
  const month = sp.get('month') ?? nextMonth(todayISO().slice(0, 7));
  const deps = refs.departments.filter((d) => d.can_view);
  const dept = sp.get('dept') ?? deps.find((d) => d.can_edit)?.id ?? deps[0]?.id ?? '';
  const setQ = (k: string, v: string) => { sp.set(k, v); setSp(sp, { replace: true }); };
  const list = useQuery({ queryKey: ['roster-list', month], queryFn: () => api<RosterRow[]>('/roster/rosters', { query: { month } }) });
  const row = list.data?.find((x) => x.department_id === dept);
  const create = useMutation({ mutationFn: () => api<{ id: string }>('/roster/rosters', { body: { department_id: dept, month } }), onSuccess: () => void qc.invalidateQueries({ queryKey: ['roster-list'] }) });
  return (
    <div className="content">
      {toast.node}
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button className="btn" type="button" aria-label="წინა თვე" onClick={() => setQ('month', prevMonth(month))}>‹</button>
        <input className="input" type="month" aria-label="თვე" style={{ maxWidth: 170, height: 38 }} value={month} onChange={(e) => e.target.value && setQ('month', e.target.value)} />
        <button className="btn" type="button" aria-label="შემდეგი თვე" onClick={() => setQ('month', nextMonth(month))}>›</button>
        <select className="select" aria-label="განყოფილება" style={{ maxWidth: 280, height: 38 }} value={dept} onChange={(e) => setQ('dept', e.target.value)}>
          {deps.map((d) => { const r = list.data?.find((x) => x.department_id === d.id); return <option key={d.id} value={d.id}>{d.name}{r ? ` — ${STATUS_KA[r.status][1]}` : ''}</option>; })}</select>
        <span className="grow" />
        <strong>{monthLabel(month)}</strong>
      </div>
      <ErrorBox error={list.error ?? create.error} />
      {list.isLoading ? <Loading /> : !row || !row.id ? (
        <div className="card empty stack" style={{ alignItems: 'center' }}>
          <span>{deps.find((d) => d.id === dept)?.name ?? '—'} — {monthLabel(month)}: განრიგი {row?.can_edit ? 'ჯერ არ შექმნილა' : 'ჯერ არ გამოქვეყნებულა'}.</span>
          {row?.can_edit && <button className="btn primary" type="button" disabled={create.isPending} onClick={() => create.mutate()}>+ განრიგის შექმნა (მონახაზი)</button>}
          {row && <span className="small muted">განყოფილების აქტიური თანამშრომლები: {row.members}</span>}
        </div>) : <Grid id={row.id} refs={refs} onToast={toast.show} />}
    </div>
  );
}

type Brush = { kind: 'tpl'; id: string } | { kind: 'erase' } | null;
function Grid({ id, refs, onToast }: { id: string; refs: Refs; onToast: (m: string) => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['roster', id], queryFn: () => api<RosterDetail>(`/roster/rosters/${id}`) });
  const [brush, setBrush] = useState<Brush>(null);
  const [duty, setDuty] = useState<{ id: string; level: number } | null>(null);
  const [cat, setCat] = useState<string>('');
  const [dlg, setDlg] = useState<null | { kind: 'entry'; entry: Entry } | { kind: 'add'; staff: string; day: string } | { kind: 'publish' } | { kind: 'rotation' } | { kind: 'history' } | { kind: 'copy' } | { kind: 'clear' }>(null);
  const [err, setErr] = useState<unknown>(null);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['roster', id] }); void qc.invalidateQueries({ queryKey: ['roster-list'] }); };
  const add = useMutation({
    mutationFn: (b: { items: object[]; mode?: string; reason?: string }) => api<{ created: { warnings: string[] }[]; skipped: { message: string }[] }>(`/roster/rosters/${id}/entries`, { body: b }),
    onSuccess: (r) => { setErr(null); refresh(); const w = r.created.flatMap((x) => x.warnings); if (w.length) onToast(`⚠ ${w[0]}${w.length > 1 ? ` (+${w.length - 1})` : ''}`); },
    onError: setErr,
  });
  const del = useMutation({ mutationFn: (eid: string) => api(`/roster/entries/${eid}/remove`, { body: {} }), onSuccess: () => { setErr(null); refresh(); }, onError: setErr });
  const r = q.data;
  const byCell = useMemo(() => {
    const m = new Map<string, Entry[]>();
    for (const e of r?.entries ?? []) { const k = `${e.staff_id}|${e.day}`; (m.get(k) ?? m.set(k, []).get(k)!).push(e); }
    return m;
  }, [r]);
  const vio = useMemo(() => { const m = new Map<string, Violation[]>(); for (const v of r?.violations ?? []) for (const e of v.entry_ids) (m.get(e) ?? m.set(e, []).get(e)!).push(v); return m; }, [r]);
  if (q.isLoading) return <Loading />;
  if (q.error || !r) return <ErrorBox error={q.error} />;
  const draft = r.status === 'draft'; const edit = r.can_edit;
  const tplOk = (t: Template) => t.is_active && (!t.department_ids.length || t.department_ids.includes(r.department_id));
  const tpls = refs.templates.filter(tplOk);
  const duties = refs.duty_roles.filter((d) => d.is_active && (!d.department_id || d.department_id === r.department_id));
  const staff = r.staff.filter((s) => !cat || s.category === cat || (cat === '-' && !s.category));
  const gapsBy = (day: string) => r.gaps.filter((g) => g.day === day);
  const dgapsBy = (day: string) => r.duty_gaps.filter((g) => g.day === day);
  const cellClick = (staffId: string, day: string) => {
    if (!edit) return;
    if (draft && brush?.kind === 'tpl') add.mutate({ items: [{ staff_id: staffId, day, shift_template_id: brush.id, ...(duty && { duty_role_id: duty.id, duty_level: duty.level }) }] });
    else if (!draft || !brush) setDlg({ kind: 'add', staff: staffId, day });
  };
  const chipClick = (e: Entry) => { if (edit && draft && brush?.kind === 'erase') del.mutate(e.id); else setDlg({ kind: 'entry', entry: e }); };
  return (
    <div className="stack">
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <span className={`chip ${STATUS_KA[r.status][0]}`}>{STATUS_KA[r.status][1]}{r.status !== 'draft' && r.version > 0 ? ` · ცვლილება ${r.version}` : ''}</span>
        {r.published_at && <span className="small muted">გამოქვეყნდა {tsDate(r.published_at)}{r.published_by_name ? ` · ${r.published_by_name}` : ''}</span>}
        {r.blocking > 0 && <span className="chip danger">დამბლოკავი: {r.blocking}</span>}
        {r.warnings > 0 && <span className="chip warn">გაფრთხილება: {r.warnings}</span>}
        {r.gaps.length > 0 && <span className="chip warn" title="შევსების ნორმა">ნორმის ხარვეზი: {r.gaps.length}</span>}
        {r.duty_gaps.length > 0 && <span className="chip warn">მორიგე დაუნიშნავი: {r.duty_gaps.length}</span>}
        <select className="select" aria-label="კატეგორია" style={{ maxWidth: 190, height: 34 }} value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="">ყველა კატეგორია</option>{(Object.keys(CAT_KA) as Category[]).map((k) => <option key={k} value={k}>{CAT_KA[k]}</option>)}<option value="-">პოზიციის გარეშე</option></select>
        <span className="grow" />
        <button className="btn sm" type="button" onClick={() => setDlg({ kind: 'history' })}>ისტორია</button>
        {edit && draft && <><button className="btn sm" type="button" onClick={() => setDlg({ kind: 'copy' })}>წინა თვიდან</button>
          <button className="btn sm" type="button" onClick={() => setDlg({ kind: 'rotation' })}>როტაცია</button>
          <button className="btn sm" type="button" onClick={() => setDlg({ kind: 'clear' })}>გასუფთავება</button>
          <button className="btn sm primary" type="button" onClick={() => setDlg({ kind: 'publish' })}>გამოქვეყნება</button></>}
      </div>
      {edit && draft && (
        <div className="card card-pad row" style={{ flexWrap: 'wrap', gap: 6, padding: 10 }} role="toolbar" aria-label="ფუნჯი">
          <span className="small muted">ფუნჯი:</span>
          {tpls.map((t) => <button key={t.id} type="button" className={`btn sm${brush?.kind === 'tpl' && brush.id === t.id ? ' primary' : ''}`} title={`${t.name} · ${timeRange(t)} · ${t.hours} სთ`}
            onClick={() => setBrush(brush?.kind === 'tpl' && brush.id === t.id ? null : { kind: 'tpl', id: t.id })}>
            <span aria-hidden="true" style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 3, background: t.color, marginRight: 4 }} />{t.code}</button>)}
          <button type="button" className={`btn sm${brush?.kind === 'erase' ? ' primary' : ''}`} onClick={() => setBrush(brush?.kind === 'erase' ? null : { kind: 'erase' })}>✕ წაშლა</button>
          {duties.length > 0 && <select className="select" aria-label="მორიგის როლი ფუნჯზე" style={{ maxWidth: 260, height: 32 }} value={duty ? `${duty.id}|${duty.level}` : ''}
            onChange={(e) => { const [i, l] = e.target.value.split('|'); setDuty(i ? { id: i, level: Number(l) } : null); }}>
            <option value="">მორიგეობის გარეშე</option>
            {duties.flatMap((d) => [<option key={`${d.id}1`} value={`${d.id}|1`}>★ {d.name}</option>, ...(d.has_backup ? [<option key={`${d.id}2`} value={`${d.id}|2`}>☆ {d.name} (II)</option>] : [])])}</select>}
          <span className="small muted grow" style={{ textAlign: 'right' }}>{brush ? (brush.kind === 'erase' ? 'დააჭირეთ ცვლას წასაშლელად' : 'დააჭირეთ უჯრას — დაემატება') : 'ფუნჯის გარეშე: უჯრა → ფორმა'}</span>
        </div>)}
      {!draft && edit && <span className="hint">განრიგი გამოქვეყნებულია: ცვლილება — უჯრაზე / ცვლაზე დაჭერით, მიზეზით (ისტორიაში იწერება, თანამშრომელს ეგზავნება შეტყობინება).</span>}
      <ErrorBox error={err} />
      <div className="card" style={{ overflow: 'auto', maxHeight: '70vh' }}>
        <table className="table roster-grid" style={{ fontSize: 12, borderCollapse: 'separate', borderSpacing: 0 }}>
          <thead><tr>
            <th style={{ position: 'sticky', left: 0, top: 0, zIndex: 3, background: 'var(--surface)', minWidth: 190 }}>თანამშრომელი</th>
            {r.days.map((d) => <th key={d.day} title={d.holiday ?? undefined} style={{ position: 'sticky', top: 0, zIndex: 2, textAlign: 'center', padding: '4px 2px', minWidth: 34,
              background: d.holiday ? 'var(--danger-weak)' : d.dow >= 6 ? 'var(--warn-weak)' : 'var(--surface)' }}>
              <div>{Number(d.day.slice(8))}</div><div className="muted" style={{ fontWeight: 400 }}>{DOW_KA[d.dow]}</div></th>)}
            <th style={{ position: 'sticky', top: 0, zIndex: 2, background: 'var(--surface)' }} title="ჩასათვლელი საათები (გეგმა)">სთ</th>
            <th style={{ position: 'sticky', top: 0, zIndex: 2, background: 'var(--surface)' }} title="ცვლა / ღამე / მორიგეობა">ც / ღ / მ</th>
          </tr></thead>
          <tbody>
            {staff.map((s) => { const t = r.totals[s.id]; return (
              <tr key={s.id}>
                <td style={{ position: 'sticky', left: 0, zIndex: 1, background: 'var(--surface)', whiteSpace: 'nowrap' }}>
                  <strong>{s.name}</strong>{!s.home && <span className="chip info" style={{ height: 18, fontSize: 10, marginLeft: 4 }} title="სხვა განყოფილებიდან / დამატებითი">დამ.</span>}
                  <div className="small muted">{s.position_name ?? 'პოზიციის გარეშე'}{Number(s.fte) !== 1 ? ` · ${Number(s.fte)} განაკვ.` : ''}</div></td>
                {r.days.map((d) => { const es = byCell.get(`${s.id}|${d.day}`) ?? []; return (
                  <td key={d.day} onClick={() => cellClick(s.id, d.day)} style={{ padding: 2, textAlign: 'center', cursor: edit ? 'pointer' : 'default', verticalAlign: 'middle',
                    background: d.holiday ? '#fff6f5' : d.dow >= 6 ? '#fffbf2' : undefined, borderLeft: '1px solid var(--line-soft)' }}
                    aria-label={`${s.name}, ${ddmm(d.day)}${es.length ? `: ${es.map((e) => e.code).join(', ')}` : ''}`}>
                    {es.map((e) => { const vs = vio.get(e.id) ?? []; const blk = vs.some((v) => v.mode === 'block'); return (
                      <button key={e.id} type="button" className="mono" onClick={(ev) => { ev.stopPropagation(); chipClick(e); }}
                        title={`${e.code} ${e.start_local}–${e.end_local} · ${Number(e.hours)} სთ${e.duty_role_id ? ` · ${refs.duty_roles.find((x) => x.id === e.duty_role_id)?.name ?? 'მორიგე'}${e.duty_level === 2 ? ' (II)' : ''}` : ''}${e.note ? ` · ${e.note}` : ''}${vs.length ? `\n${vs.map((v) => `⚠ ${v.message}`).join('\n')}` : ''}`}
                        style={{ display: 'block', width: '100%', border: 0, borderRadius: 4, padding: '2px 0', margin: '1px 0', color: '#fff', fontSize: 11, fontWeight: 600, cursor: 'pointer',
                          background: e.color, outline: vs.length ? `2px solid ${blk ? 'var(--danger)' : '#d97706'}` : undefined, outlineOffset: -2 }}>
                        {e.code}{e.duty_role_id ? (e.duty_level === 2 ? '☆' : '★') : ''}</button>); })}
                  </td>); })}
                <td className="mono" style={{ textAlign: 'right' }}>{t?.hours ?? 0}</td>
                <td className="mono small" style={{ whiteSpace: 'nowrap' }}>{t ? `${t.shifts} / ${t.nights} / ${t.duty}` : '—'}</td>
              </tr>); })}
            {!staff.length && <tr><td colSpan={r.days.length + 3} className="muted">თანამშრომელი არ არის — დაამატეთ „თანამშრომლები“ ჩანართში (ძირითადი ან დამატებითი განყოფილება)</td></tr>}
            {(r.gaps.length > 0 || r.duty_gaps.length > 0) && <tr>
              <td style={{ position: 'sticky', left: 0, background: 'var(--surface-2)' }} className="small"><strong>ხარვეზები</strong><div className="muted">ნორმა / მორიგე</div></td>
              {r.days.map((d) => { const g = gapsBy(d.day); const dg = dgapsBy(d.day); return (
                <td key={d.day} className="small" style={{ textAlign: 'center', background: 'var(--surface-2)', padding: 2 }}
                  title={[...g.map((x) => `${x.code} · ${CAT_KA[x.category]}: ${x.have} / ${x.need}`), ...dg.map((x) => `მორიგე „${x.name}“: ${x.have} / ${x.need}`)].join('\n') || undefined}>
                  {g.length > 0 && <span style={{ color: 'var(--warn-ink)', fontWeight: 600 }}>{g.reduce((a, x) => a + x.need - x.have, 0)}</span>}
                  {dg.length > 0 && <div style={{ color: 'var(--danger)', fontWeight: 700 }}>★</div>}
                </td>); })}
              <td colSpan={2} style={{ background: 'var(--surface-2)' }} /></tr>}
          </tbody>
        </table>
      </div>
      <Legend refs={refs} />
      {r.violations.length > 0 && <details className="card card-pad"><summary><strong>წესების დარღვევები ({r.violations.length})</strong></summary>
        <ul className="small" style={{ margin: '8px 0 0', paddingLeft: 18 }}>{r.violations.map((v, i) => <li key={i}><span className={`chip ${v.mode === 'block' ? 'danger' : 'warn'}`} style={{ height: 18, fontSize: 10 }}>{v.mode === 'block' ? 'დაბლოკვა' : 'გაფრთხ.'}</span>{' '}
          {r.staff.find((s) => s.id === v.staff_id)?.name ?? '—'} · {ddmm(v.day)} — {v.message}</li>)}</ul></details>}
      {dlg?.kind === 'entry' && <EntryDialog r={r} refs={refs} e={dlg.entry} onClose={() => setDlg(null)} onDone={() => { setDlg(null); refresh(); }} />}
      {dlg?.kind === 'add' && <AddDialog r={r} refs={refs} staffId={dlg.staff} day={dlg.day} onClose={() => setDlg(null)} onDone={(w) => { setDlg(null); refresh(); if (w.length) onToast(`⚠ ${w[0]}`); }} />}
      {dlg?.kind === 'publish' && <PublishDialog r={r} onClose={() => setDlg(null)} onDone={() => { setDlg(null); refresh(); onToast('გამოქვეყნდა'); }} />}
      {dlg?.kind === 'rotation' && <RotationDialog r={r} refs={refs} onClose={() => setDlg(null)} onDone={(m) => { setDlg(null); refresh(); onToast(m); }} />}
      {dlg?.kind === 'copy' && <CopyDialog r={r} refs={refs} onClose={() => setDlg(null)} onDone={(m) => { setDlg(null); refresh(); onToast(m); }} />}
      {dlg?.kind === 'clear' && <ClearDialog r={r} onClose={() => setDlg(null)} onDone={(m) => { setDlg(null); refresh(); onToast(m); }} />}
      {dlg?.kind === 'history' && <HistoryDialog id={r.id} onClose={() => setDlg(null)} />}
    </div>
  );
}

function Legend({ refs }: { refs: Refs }) {
  return <div className="row small muted" style={{ flexWrap: 'wrap', gap: 10 }}>
    {refs.templates.filter((t) => t.is_active).map((t) => <span key={t.id} className="row" style={{ gap: 4 }}><span aria-hidden="true" style={{ width: 12, height: 12, borderRadius: 3, background: t.color }} />
      <strong className="mono">{t.code}</strong> {t.name} · {t.hours} სთ</span>)}
    <span>★ მორიგე (I) · ☆ მორიგე (II)</span><span style={{ color: '#d97706' }}>▢ გაფრთხილება</span><span style={{ color: 'var(--danger)' }}>▢ დაბლოკვა</span>
  </div>;
}

function ReasonField({ need, value, set }: { need: boolean; value: string; set: (v: string) => void }) {
  if (!need) return null;
  return <Field label="ცვლილების მიზეზი" htmlFor="rr" required hint="განრიგი გამოქვეყნებულია — ისტორიაში იწერება"><input id="rr" className="input" value={value} onChange={(e) => set(e.target.value)} /></Field>;
}

function ShiftFields({ refs, r, f, set }: { refs: Refs; r: RosterDetail; f: { tpl: string; duty: string; start: string; end: string; note: string }; set: (k: string, v: string) => void }) {
  const tpls = refs.templates.filter((t) => t.is_active && (!t.department_ids.length || t.department_ids.includes(r.department_id)));
  const duties = refs.duty_roles.filter((d) => d.is_active && (!d.department_id || d.department_id === r.department_id));
  const t = refs.templates.find((x) => x.id === f.tpl);
  return <>
    <Field label="ცვლა" htmlFor="rf-t" required><select id="rf-t" className="select" value={f.tpl} onChange={(e) => set('tpl', e.target.value)}>
      <option value="">—</option>{tpls.map((x) => <option key={x.id} value={x.id}>{x.code} — {x.name} ({timeRange(x)}, {x.hours} სთ)</option>)}</select></Field>
    <Field label="მორიგეობა" htmlFor="rf-d"><select id="rf-d" className="select" value={f.duty} onChange={(e) => set('duty', e.target.value)}>
      <option value="">—</option>{duties.flatMap((d) => [<option key={`${d.id}1`} value={`${d.id}|1`}>★ {d.name}</option>, ...(d.has_backup ? [<option key={`${d.id}2`} value={`${d.id}|2`}>☆ {d.name} (II დონე)</option>] : [])])}</select></Field>
    <div className="row" style={{ gap: 8 }}>
      <Field label="დასაწყისი (ხელით)" htmlFor="rf-s" hint={t ? `შაბლონი: ${timeRange(t)}` : undefined}><input id="rf-s" className="input mono" type="time" value={f.start} onChange={(e) => set('start', e.target.value)} /></Field>
      <Field label="დასასრული (ხელით)" htmlFor="rf-e" hint="ცარიელი — შაბლონის დრო"><input id="rf-e" className="input mono" type="time" value={f.end} onChange={(e) => set('end', e.target.value)} /></Field>
    </div>
    <Field label="შენიშვნა" htmlFor="rf-n"><input id="rf-n" className="input" value={f.note} maxLength={500} onChange={(e) => set('note', e.target.value)} /></Field>
  </>;
}

function AddDialog({ r, refs, staffId, day, onClose, onDone }: { r: RosterDetail; refs: Refs; staffId: string; day: string; onClose: () => void; onDone: (w: string[]) => void }) {
  const [f, setF] = useState({ tpl: '', duty: '', start: '', end: '', note: '' }); const [reason, setReason] = useState('');
  const st = r.staff.find((s) => s.id === staffId);
  const m = useMutation({
    mutationFn: () => { const [di, dl] = f.duty.split('|');
      return api<{ created: { warnings: string[] }[] }>(`/roster/rosters/${r.id}/entries`, { body: { items: [{ staff_id: staffId, day, shift_template_id: f.tpl, ...(di && { duty_role_id: di, duty_level: Number(dl) }),
        ...(f.start && f.end && { start_time: f.start, end_time: f.end }), ...(f.note.trim() && { note: f.note.trim() }) }], ...(r.status !== 'draft' && { reason: reason.trim() }) } }); },
    onSuccess: (x) => onDone(x.created.flatMap((c) => c.warnings)),
  });
  const pub = r.status !== 'draft';
  return <Modal title={`${st?.name ?? ''} · ${ddmm(day)}`} onClose={onClose} footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button>
    <button className="btn primary" type="button" disabled={!f.tpl || m.isPending || (pub && reason.trim().length < 3) || (!!f.start !== !!f.end)} onClick={() => m.mutate()}>დამატება</button></>}>
    <div className="stack"><ShiftFields refs={refs} r={r} f={f} set={(k, v) => setF({ ...f, [k]: v })} /><ReasonField need={pub} value={reason} set={setReason} /><ErrorBox error={m.error} /></div>
  </Modal>;
}

function EntryDialog({ r, refs, e, onClose, onDone }: { r: RosterDetail; refs: Refs; e: Entry; onClose: () => void; onDone: () => void }) {
  const t = refs.templates.find((x) => x.id === e.shift_template_id);
  const custom = !!t && (e.start_local !== t.start_time.slice(0, 5) || e.end_local !== t.end_time.slice(0, 5));
  const [f, setF] = useState({ tpl: e.shift_template_id, duty: e.duty_role_id ? `${e.duty_role_id}|${e.duty_level}` : '', start: custom ? e.start_local : '', end: custom ? e.end_local : '', note: e.note ?? '' });
  const [reason, setReason] = useState('');
  const pub = r.status !== 'draft'; const st = r.staff.find((s) => s.id === e.staff_id);
  const save = useMutation({ mutationFn: () => { const [di, dl] = f.duty.split('|');
    return api(`/roster/entries/${e.id}`, { method: 'PATCH', body: { shift_template_id: f.tpl, duty_role_id: di || null, duty_level: di ? Number(dl) : null,
      start_time: f.start && f.end ? f.start : null, end_time: f.start && f.end ? f.end : null, note: f.note.trim() || null, ...(pub && { reason: reason.trim() }) } }); }, onSuccess: onDone });
  const rm = useMutation({ mutationFn: () => api(`/roster/entries/${e.id}/remove`, { body: pub ? { reason: reason.trim() } : {} }), onSuccess: onDone });
  const vs = r.violations.filter((v) => v.entry_ids.includes(e.id));
  const can = r.can_edit;
  return <Modal title={`${st?.name ?? ''} · ${ddmm(e.day)} · ${e.code}`} onClose={onClose} footer={can ? <>
    <button className="btn danger" type="button" disabled={rm.isPending || (pub && reason.trim().length < 3)} onClick={() => rm.mutate()}>{pub ? 'მოხსნა' : 'წაშლა'}</button><span className="grow" />
    <button className="btn" type="button" onClick={onClose}>დახურვა</button>
    <button className="btn primary" type="button" disabled={save.isPending || (pub && reason.trim().length < 3) || (!!f.start !== !!f.end)} onClick={() => save.mutate()}>შენახვა</button></>
    : <button className="btn" type="button" onClick={onClose}>დახურვა</button>}>
    <div className="stack">
      <span className="small">{hhmm(e.starts_at)}–{hhmm(e.ends_at)} · {Number(e.hours)} სთ · {KIND_KA[e.kind]}</span>
      {vs.map((v, i) => <div key={i} className={`alert ${v.mode === 'block' ? 'danger' : 'warn'}`}>{v.message}</div>)}
      {can ? <><ShiftFields refs={refs} r={r} f={f} set={(k, v) => setF({ ...f, [k]: v })} /><ReasonField need={pub} value={reason} set={setReason} /></>
        : e.note && <span>{e.note}</span>}
      <ErrorBox error={save.error ?? rm.error} />
    </div>
  </Modal>;
}

function PublishDialog({ r, onClose, onDone }: { r: RosterDetail; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState(''); const [confirm, setConfirm] = useState(false);
  const m = useMutation({ mutationFn: () => api(`/roster/rosters/${r.id}/publish`, { body: { confirm_warnings: confirm, ...(note.trim() && { note: note.trim() }) } }), onSuccess: onDone });
  const b = errBody(m.error);
  const needConfirm = r.warnings > 0 || r.gaps.length > 0 || r.duty_gaps.length > 0;
  return <Modal title={`გამოქვეყნება · ${r.department_name} · ${monthLabel(r.month)}`} onClose={onClose} footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button>
    <button className="btn primary" type="button" disabled={m.isPending || r.blocking > 0 || (needConfirm && !confirm)} onClick={() => m.mutate()}>გამოქვეყნება</button></>}>
    <div className="stack">
      <span>ჩანაწერი: <strong>{r.entries.length}</strong> · თანამშრომელი: <strong>{new Set(r.entries.map((e) => e.staff_id)).size}</strong></span>
      {r.blocking > 0 && <div className="alert danger">დამბლოკავი დარღვევა: {r.blocking} — ჯერ გაასწორეთ (იხ. „წესების დარღვევები“).</div>}
      {needConfirm && <div className="alert warn">გაფრთხილება: წესი — {r.warnings}, ნორმის ხარვეზი — {r.gaps.length}, მორიგე დაუნიშნავი — {r.duty_gaps.length} დღე/როლი.</div>}
      {needConfirm && <label className="row"><input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /> გაფრთხილებები ვნახე, ვაქვეყნებ</label>}
      <Field label="შენიშვნა (არჩევითი)" htmlFor="pn"><input id="pn" className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <span className="hint">გამოქვეყნების შემდეგ ყოველი ცვლილება მიზეზით ხდება; ანგარიშიან თანამშრომლებს ეგზავნება შეტყობინება (პარამეტრი).</span>
      <ErrorBox error={m.error} />{Array.isArray(b.violations) && <ul className="small">{(b.violations as Violation[]).slice(0, 10).map((v, i) => <li key={i}>{ddmm(v.day)} — {v.message}</li>)}</ul>}
    </div>
  </Modal>;
}

function Report({ skipped, staff }: { skipped: { staff_id: string; day: string; message: string }[]; staff: RosterDetail['staff'] }) {
  if (!skipped.length) return null;
  return <details><summary className="small">გამოტოვებული: {skipped.length}</summary><ul className="small" style={{ maxHeight: 180, overflow: 'auto' }}>
    {skipped.map((x, i) => <li key={i}>{staff.find((s) => s.id === x.staff_id)?.name ?? '—'} · {ddmm(x.day)} — {x.message}</li>)}</ul></details>;
}

function RotationDialog({ r, refs, onClose, onDone }: { r: RosterDetail; refs: Refs; onClose: () => void; onDone: (m: string) => void }) {
  const pats = refs.patterns.filter((p) => p.is_active);
  const [pid, setPid] = useState(pats[0]?.id ?? ''); const [sel, setSel] = useState<Record<string, number>>({});
  const [from, setFrom] = useState(r.days[0].day); const [to, setTo] = useState(r.days[r.days.length - 1].day); const [over, setOver] = useState(false);
  const [res, setRes] = useState<{ created: number; skipped: { staff_id: string; day: string; message: string }[] } | null>(null);
  const p = pats.find((x) => x.id === pid);
  const code = (tid: string) => (tid === refs.rest ? '·' : refs.templates.find((t) => t.id === tid)?.code ?? '?');
  const m = useMutation({ mutationFn: () => api<{ created: number; skipped: { staff_id: string; day: string; message: string }[] }>(`/roster/rosters/${r.id}/rotation`,
    { body: { pattern_id: pid, staff: Object.entries(sel).map(([staff_id, offset]) => ({ staff_id, offset })), from, to, overwrite: over } }), onSuccess: setRes });
  return <Modal title="როტაციის ნიმუშით შევსება" width={640} onClose={onClose} footer={res ? <button className="btn primary" type="button" onClick={() => onDone(`დაემატა ${res.created} ცვლა`)}>მზადაა</button> : <>
    <button className="btn" type="button" onClick={onClose}>გაუქმება</button>
    <button className="btn primary" type="button" disabled={!pid || !Object.keys(sel).length || m.isPending} onClick={() => m.mutate()}>შევსება</button></>}>
    {res ? <div className="stack"><span>დაემატა: <strong>{res.created}</strong></span><Report skipped={res.skipped} staff={r.staff} /></div> : <div className="stack">
      <Field label="ნიმუში" htmlFor="rp"><select id="rp" className="select" value={pid} onChange={(e) => setPid(e.target.value)}>{pats.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
      {p && <span className="mono small">ციკლი: {p.cycle.map(code).join(' ')} ({p.cycle.length} დღე)</span>}
      <div className="row" style={{ gap: 8 }}><Field label="დან" htmlFor="rpf"><input id="rpf" className="input" type="date" value={from} min={r.days[0].day} max={r.days[r.days.length - 1].day} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="მდე" htmlFor="rpt"><input id="rpt" className="input" type="date" value={to} min={r.days[0].day} max={r.days[r.days.length - 1].day} onChange={(e) => setTo(e.target.value)} /></Field></div>
      <span className="small muted">თანამშრომლები და ციკლის წანაცვლება (0 — „დან“ დღე ციკლის პირველი დღეა). ლოგიკური გუნდისთვის: 0, 1, 2, 3…</span>
      <div style={{ maxHeight: 260, overflow: 'auto' }} className="stack">
        {r.staff.filter((s) => s.is_active).map((s) => <label key={s.id} className="row" style={{ gap: 8 }}>
          <input type="checkbox" checked={s.id in sel} onChange={(e) => { const n = { ...sel }; if (e.target.checked) n[s.id] = Object.keys(sel).length % (p?.cycle.length ?? 1); else delete n[s.id]; setSel(n); }} />
          <span className="grow">{s.name} <span className="small muted">{s.position_name ?? ''}</span></span>
          {s.id in sel && <input className="input mono" style={{ width: 70, height: 30 }} type="number" min={0} max={55} aria-label={`წანაცვლება — ${s.name}`} value={sel[s.id]} onChange={(e) => setSel({ ...sel, [s.id]: Number(e.target.value) })} />}
        </label>)}</div>
      <label className="row"><input type="checkbox" checked={over} onChange={(e) => setOver(e.target.checked)} /> არსებული ჩანაწერები (მონიშნულთა, პერიოდში) ჩანაცვლდეს</label>
      <ErrorBox error={m.error} />
    </div>}
  </Modal>;
}

function CopyDialog({ r, refs, onClose, onDone }: { r: RosterDetail; refs: Refs; onClose: () => void; onDone: (m: string) => void }) {
  const [mode, setMode] = useState(refs.settings.copy_mode);
  const [res, setRes] = useState<{ created: number; skipped: { staff_id: string; day: string; message: string }[] } | null>(null);
  const m = useMutation({ mutationFn: () => api<{ created: number; skipped: { staff_id: string; day: string; message: string }[] }>(`/roster/rosters/${r.id}/copy`, { body: { mode } }), onSuccess: setRes });
  return <Modal title="წინა თვიდან კოპირება" onClose={onClose} footer={res ? <button className="btn primary" type="button" onClick={() => onDone(`გადმოვიდა ${res.created} ცვლა`)}>მზადაა</button> : <>
    <button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={m.isPending} onClick={() => m.mutate()}>კოპირება</button></>}>
    {res ? <div className="stack"><span>გადმოვიდა: <strong>{res.created}</strong></span><Report skipped={res.skipped} staff={r.staff} /></div> : <div className="stack">
      <Field label="რეჟიმი" htmlFor="cm"><select id="cm" className="select" value={mode} onChange={(e) => setMode(e.target.value as 'weekday' | 'date')}>
        <option value="weekday">კვირის დღეებით — 4-კვირიანი ციკლი (დღე − 28)</option><option value="date">იგივე რიცხვით</option></select></Field>
      <span className="hint">არსებულ ჩანაწერებს არ ცვლის; წესების / გადაფარვის გამო შეუძლებელი — გამოტოვდება (სიით).</span><ErrorBox error={m.error} /></div>}
  </Modal>;
}

function ClearDialog({ r, onClose, onDone }: { r: RosterDetail; onClose: () => void; onDone: (m: string) => void }) {
  const [from, setFrom] = useState(r.days[0].day); const [to, setTo] = useState(r.days[r.days.length - 1].day);
  const m = useMutation({ mutationFn: () => api<{ deleted: number }>(`/roster/rosters/${r.id}/clear`, { body: { from, to } }), onSuccess: (x) => onDone(`წაიშალა ${x.deleted}`) });
  return <Modal title="მონახაზის გასუფთავება" onClose={onClose} footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button>
    <button className="btn danger" type="button" disabled={m.isPending} onClick={() => m.mutate()}>გასუფთავება</button></>}>
    <div className="stack"><div className="row" style={{ gap: 8 }}><Field label="დან" htmlFor="cf"><input id="cf" className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
      <Field label="მდე" htmlFor="ct"><input id="ct" className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field></div>
      <span className="hint">ყველა თანამშრომლის ჩანაწერი პერიოდში წაიშლება (მხოლოდ მონახაზში).</span><ErrorBox error={m.error} /></div>
  </Modal>;
}

const CH_KA: Record<string, string> = { created: 'შეიქმნა', add: 'დამატება', change: 'ცვლილება', remove: 'მოხსნა', publish: 'გამოქვეყნება', copy: 'კოპირება', rotation: 'როტაცია', bulk: 'მასობრივი' };
function HistoryDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['roster-changes', id], queryFn: () => api<{ id: string; kind: string; reason: string | null; data: Record<string, unknown>; created_at: string; user_name: string; staff_name: string | null }[]>(`/roster/rosters/${id}/changes`) });
  return <Modal title="განრიგის ისტორია" width={720} onClose={onClose}>
    {q.isLoading ? <Loading /> : <table className="table small"><thead><tr><th>დრო</th><th>ქმედება</th><th>თანამშრომელი</th><th>დეტალი</th><th>მიზეზი</th><th>ვინ</th></tr></thead>
      <tbody>{q.data?.map((c) => <tr key={c.id}><td style={{ whiteSpace: 'nowrap' }}>{tsDate(c.created_at)} {hhmm(c.created_at)}</td><td>{CH_KA[c.kind] ?? c.kind}</td><td>{c.staff_name ?? ''}</td>
        <td className="mono">{c.data.day ? `${ddmm(String(c.data.day))} ` : ''}{c.data.from ? `${String(c.data.from)} → ` : ''}{String(c.data.code ?? '')}
          {c.data.created !== undefined ? `+${String(c.data.created)}${c.data.skipped ? ` / გამოტ. ${String(c.data.skipped)}` : ''}` : ''}{c.data.entries !== undefined ? `${String(c.data.entries)} ჩანაწ.` : ''}</td>
        <td>{c.reason ?? ''}</td><td>{c.user_name}</td></tr>)}</tbody></table>}
    <ErrorBox error={q.error} />
  </Modal>;
}

// ---------------------------------------------------------------- მორიგეები ახლა
interface DutyRow { id: string; staff_id: string; staff_name: string; position_name: string | null; category: Category | null; department_id: string; department_name: string; code: string; shift_name: string;
  starts_at: string; ends_at: string; duty_role_id: string | null; duty_name: string | null; duty_level: number | null; duty_phone: string | null; phone: string | null }
function DutyPage({ refs }: { refs: Refs }) {
  const [dept, setDept] = useState(''); const [at, setAt] = useState('');
  const q = useQuery({ queryKey: ['roster-duty', dept, at], queryFn: () => api<{ at: string; duty: DutyRow[]; on_shift: DutyRow[]; uncovered: { id: string; name: string; department_name: string | null; phone: string | null }[] }>('/roster/on-duty',
    { query: { department_id: dept || undefined, at: at ? `${at}:00+04:00` : undefined } }), refetchInterval: at ? false : 60_000 });
  const groups = useMemo(() => { const m = new Map<string, DutyRow[]>(); for (const d of q.data?.duty ?? []) (m.get(d.duty_role_id!) ?? m.set(d.duty_role_id!, []).get(d.duty_role_id!)!).push(d); return [...m.values()]; }, [q.data]);
  return (
    <div className="content">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <select className="select" aria-label="განყოფილება" style={{ maxWidth: 280, height: 38 }} value={dept} onChange={(e) => setDept(e.target.value)}>
          <option value="">ყველა განყოფილება</option>{refs.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
        <input className="input" type="datetime-local" aria-label="მომენტი" style={{ maxWidth: 220, height: 38 }} value={at} onChange={(e) => setAt(e.target.value)} />
        {at && <button className="btn sm" type="button" onClick={() => setAt('')}>ახლა</button>}
        <span className="grow" /><span className="small muted">{q.data ? `${tsDate(q.data.at)} ${hhmm(q.data.at)}` : ''} · მხოლოდ გამოქვეყნებული განრიგი</span>
      </div>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : <>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
          {groups.map((g) => <section key={g[0].duty_role_id} className="card card-pad stack" style={{ gap: 6 }}>
            <div className="row"><strong className="grow">{g[0].duty_name}</strong>{g[0].duty_phone && <a className="mono small" href={`tel:${g[0].duty_phone}`}>☎ {g[0].duty_phone}</a>}</div>
            {g.map((d) => <div key={d.id} className="row" style={{ gap: 8 }}>
              <span className={`chip ${d.duty_level === 2 ? 'info' : 'ok'}`} style={{ height: 20, fontSize: 11 }}>{d.duty_level === 2 ? 'II' : 'I'}</span>
              <div className="stack grow" style={{ gap: 0 }}><span><strong>{d.staff_name}</strong></span>
                <span className="small muted">{d.position_name ?? ''} · {d.department_name} · {hhmm(d.starts_at)}–{hhmm(d.ends_at)}</span></div>
              {d.phone && <a className="mono small" href={`tel:${d.phone}`}>{d.phone}</a>}
            </div>)}
          </section>)}
          {q.data?.uncovered.map((u) => <section key={u.id} className="card card-pad stack" style={{ gap: 6, borderColor: 'var(--danger-line)' }}>
            <div className="row"><strong className="grow">{u.name}</strong>{u.phone && <span className="mono small">☎ {u.phone}</span>}</div>
            <span className="small" style={{ color: 'var(--danger)' }}>ამ მომენტში მორიგე არ არის დანიშნული{u.department_name ? ` · ${u.department_name}` : ''}</span></section>)}
        </div>
        {!groups.length && !q.data?.uncovered.length && <div className="card empty">მორიგეები არ არის (მორიგის როლები — „ცნობარები“; განრიგში — ★)</div>}
        {dept && <section className="card card-pad stack"><strong>ცვლაში ახლა — {refs.departments.find((d) => d.id === dept)?.name}</strong>
          {q.data?.on_shift.length ? <table className="table small"><thead><tr><th>თანამშრომელი</th><th>პოზიცია</th><th>ცვლა</th><th>დრო</th><th>ტელეფონი</th></tr></thead>
            <tbody>{q.data.on_shift.map((d) => <tr key={d.id}><td><strong>{d.staff_name}</strong>{d.duty_name ? ` ★ ${d.duty_name}` : ''}</td><td>{d.position_name ?? '—'}</td><td className="mono">{d.code}</td>
              <td>{hhmm(d.starts_at)}–{hhmm(d.ends_at)}</td><td className="mono">{d.phone ?? ''}</td></tr>)}</tbody></table> : <span className="muted small">არავინ</span>}</section>}
      </>}
    </div>
  );
}

// ---------------------------------------------------------------- ჩემი განრიგი
function MyPage() {
  const [sp, setSp] = useSearchParams();
  const month = sp.get('month') ?? todayISO().slice(0, 7);
  const q = useQuery({ queryKey: ['roster-my', month], queryFn: () => api<{ staff: { id: string; name: string } | null; month: string; hours?: number;
    entries: { id: string; day: string; code: string; shift_name: string; kind: string; color: string; starts_at: string; ends_at: string; hours: string; department_name: string; duty_name: string | null; duty_level: number | null; note: string | null }[] }>('/roster/my', { query: { month } }) });
  useEffect(() => { if (!sp.get('month')) { sp.set('month', month); setSp(sp, { replace: true }); } }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (m: string) => { sp.set('month', m); setSp(sp, { replace: true }); };
  return (
    <div className="content">
      <div className="row">
        <button className="btn" type="button" aria-label="წინა თვე" onClick={() => set(prevMonth(month))}>‹</button>
        <input className="input" type="month" aria-label="თვე" style={{ maxWidth: 170, height: 38 }} value={month} onChange={(e) => e.target.value && set(e.target.value)} />
        <button className="btn" type="button" aria-label="შემდეგი თვე" onClick={() => set(nextMonth(month))}>›</button>
        <span className="grow" />{q.data?.staff && <span>{q.data.staff.name} · <strong>{q.data.hours ?? 0} სთ</strong> · {q.data.entries.length} ცვლა</span>}
      </div>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : !q.data?.staff ? <div className="card empty">თქვენი ანგარიში თანამშრომლების რეესტრში არ არის მიბმული — მიმართეთ განრიგის შემდგენს / HR-ს.</div>
        : <div className="card"><table className="table"><thead><tr><th>დღე</th><th>ცვლა</th><th>დრო</th><th>სთ</th><th>განყოფილება</th><th>მორიგეობა</th><th>შენიშვნა</th></tr></thead>
          <tbody>{q.data.entries.map((e) => <tr key={e.id}><td style={{ whiteSpace: 'nowrap' }}>{ddmm(e.day)} <span className="muted">{DOW_KA[((new Date(`${e.day}T00:00:00Z`).getUTCDay() + 6) % 7) + 1]}</span></td>
            <td><span className="mono" style={{ background: e.color, color: '#fff', borderRadius: 4, padding: '1px 6px', fontWeight: 600 }}>{e.code}</span> <span className="small">{e.shift_name}</span></td>
            <td>{hhmm(e.starts_at)}–{hhmm(e.ends_at)}</td><td className="mono">{Number(e.hours)}</td><td>{e.department_name}</td>
            <td>{e.duty_name ? `${e.duty_level === 2 ? '☆' : '★'} ${e.duty_name}` : ''}</td><td className="small">{e.note ?? ''}</td></tr>)}
            {!q.data.entries.length && <tr><td colSpan={7} className="muted">{monthLabel(month)} — გამოქვეყნებულ განრიგში ცვლა არ გაქვთ</td></tr>}</tbody></table></div>}
    </div>
  );
}
