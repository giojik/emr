import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApiError, api } from '../../api/client';
import { ErrorBox, Field, Loading, Modal, useToast } from '../../components/ui';
import { todayISO, tsDate } from '../../lib/format';
import { downloadFile } from '../reporting/types';
import { CAT_KA, DOW_KA, ddmm, fmtH, monthLabel, type Refs, type Timesheet, type TsOverview, type TsRow } from './types';

const prevMonth = (m: string) => { const [y, mm] = m.split('-').map(Number); return mm === 1 ? `${y - 1}-12` : `${y}-${String(mm - 1).padStart(2, '0')}`; };
const nextMonth = (m: string) => { const [y, mm] = m.split('-').map(Number); return mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, '0')}`; };
const errBody = (e: unknown) => (e instanceof ApiError ? e.body ?? {} : {}) as Record<string, unknown>;
const esc = (s: string | null | undefined) => (s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const NO_SHOW = 'გ';

/**
 * ცვლები / მორიგეობა — საათები / ტაბელი (0079): თვის მიმოხილვა (წარდგენა / დახურვა / მოძველებული), განყოფილების ტაბელი
 * (ფაქტი, ნორმა, ზეგანაკვეთი, ღამე / დღესასწაული / შაბ.–კვ., არყოფნა), წარდგენა (შემდგენი) → დახურვა (HR, COMP) → ხელახლა გახსნა, Excel, ბეჭდვა.
 */
export default function HoursPage({ refs }: { refs: Refs }) {
  const [sp, setSp] = useSearchParams(); const toast = useToast();
  const month = sp.get('month') ?? prevMonth(todayISO().slice(0, 7));
  const setQ = (k: string, v: string) => { sp.set(k, v); setSp(sp, { replace: true }); };
  const ov = useQuery({ queryKey: ['roster-ts-overview', month], queryFn: () => api<TsOverview>('/roster/timesheets', { query: { month } }) });
  const rows = ov.data?.rows ?? [];
  const dept = sp.get('dept') && rows.some((r) => r.department_id === sp.get('dept')) ? sp.get('dept')! : rows[0]?.department_id ?? '';
  const sel = rows.find((r) => r.department_id === dept);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<unknown>(null);
  const exp = async (all: boolean) => {
    setBusy(true); setErr(null);
    try { await downloadFile('/roster/timesheets/export', { month, department_id: all ? undefined : dept }, `timesheet_${month}.xlsx`); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <div className="content">
      {toast.node}
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button className="btn" type="button" aria-label="წინა თვე" onClick={() => setQ('month', prevMonth(month))}>‹</button>
        <input className="input" type="month" aria-label="თვე" style={{ maxWidth: 170, height: 38 }} value={month} onChange={(e) => e.target.value && setQ('month', e.target.value)} />
        <button className="btn" type="button" aria-label="შემდეგი თვე" onClick={() => setQ('month', nextMonth(month))}>›</button>
        <strong>{monthLabel(month)}</strong>
        {ov.data && !ov.data.ended && <span className="chip warn">თვე ჯერ არ დასრულებულა — ტაბელი წინასწარია</span>}
        <span className="grow" />
        {ov.data?.can.export_all && <button className="btn sm" type="button" disabled={busy || !rows.length} onClick={() => void exp(true)} title="ყველა განყოფილება: ტაბელი / ჯამები / არყოფნები">Excel — მთელი კლინიკა</button>}
      </div>
      <ErrorBox error={ov.error ?? err} />
      {ov.isLoading ? <Loading /> : !rows.length ? <div className="card empty">ამ თვეში ტაბელი (გამოქვეყნებული განრიგი) თქვენს არეში არ არის.</div> : (
        <>
          <div className="card" style={{ overflow: 'auto' }}>
            <table className="table small">
              <thead><tr><th>განყოფილება</th><th>სტატუსი</th><th>წარდგენა</th><th>დახურვა</th><th className="num">თანამშრ.</th><th className="num">ფაქტის შესწორება</th><th className="num">ზეგანაკვ., სთ</th></tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r.id} onClick={() => setQ('dept', r.department_id)} style={{ cursor: 'pointer', background: r.department_id === dept ? 'var(--accent-weak, #eef4ff)' : undefined }}>
                  <td><strong>{r.department_name}</strong></td>
                  <td>{r.status === 'closed' ? <span className="chip info">დახურული</span> : <span className="chip ok">გამოქვეყნებული</span>}{r.stale > 0 && <span className="chip danger" style={{ marginLeft: 4 }} title="დახურვის შემდეგ შეიცვალა არყოფნა">მოძველებულია ({r.stale})</span>}</td>
                  <td>{r.timesheet_submitted_at ? tsDate(r.timesheet_submitted_at) : '—'}</td><td>{r.closed_at ? tsDate(r.closed_at) : '—'}</td>
                  <td className="num">{r.staff}</td><td className="num">{r.actuals}</td><td className="num">{r.overtime === null ? '—' : fmtH(r.overtime)}</td></tr>))}</tbody>
            </table>
          </div>
          {sel && <Sheet id={sel.id} refs={refs} onToast={toast.show} onExport={() => void exp(false)} busy={busy} />}
        </>)}
    </div>
  );
}

function Sheet({ id, refs, onToast, onExport, busy }: { id: string; refs: Refs; onToast: (m: string) => void; onExport: () => void; busy: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['roster-ts', id], queryFn: () => api<Timesheet>(`/roster/rosters/${id}/timesheet`) });
  const [dlg, setDlg] = useState<null | 'submit' | 'close' | 'reopen'>(null);
  const [cat, setCat] = useState('');
  const refresh = () => { for (const k of ['roster-ts', 'roster-ts-overview', 'roster', 'roster-list']) void qc.invalidateQueries({ queryKey: [k] }); };
  const t = q.data;
  const rows = useMemo(() => (t?.rows ?? []).filter((r) => !cat || r.category === cat), [t, cat]);
  if (q.isLoading) return <Loading />;
  if (q.error || !t) return <ErrorBox error={q.error} />;
  const r = t.roster; const closed = r.status === 'closed';
  const cellStyle = (v: string | undefined, d: { dow: number; holiday: string | null }) => {
    const abs = v && !/^\d/.test(v) && v !== NO_SHOW;
    return { textAlign: 'center' as const, padding: '2px 1px', minWidth: 28, borderLeft: '1px solid var(--line-soft)',
      background: v === NO_SHOW ? 'var(--danger-weak)' : abs ? '#eef2ff' : d.holiday ? '#fff6f5' : d.dow >= 6 ? '#fffbf2' : undefined,
      color: v === NO_SHOW ? 'var(--danger)' : abs ? '#3730a3' : undefined, fontWeight: abs || v === NO_SHOW ? 700 : 400 };
  };
  return (
    <div className="stack">
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0 }}>{r.department_name} · {monthLabel(r.month)}</h2>
        {closed ? <span className="chip info">დახურული{r.closed_at ? ` · ${tsDate(r.closed_at)}` : ''}{r.closed_by_name ? ` · ${r.closed_by_name}` : ''}</span> : <span className="chip warn">წინასწარი (ცოცხალი)</span>}
        {r.timesheet_submitted_at && <span className="chip ok">წარდგენილია {tsDate(r.timesheet_submitted_at)}{r.submitted_by_name ? ` · ${r.submitted_by_name}` : ''}</span>}
        <span className="small muted">სამუშაო დღე: {t.workdays} · ნორმა: {t.settings.week_norm_hours} სთ / კვირა × FTE · ღამე {t.settings.night_from}–{t.settings.night_to}{t.settings.overtime_basis === 'off' ? ' · ზეგანაკვეთი არ ითვლება' : ''}</span>
        <span className="grow" />
        <select className="select" aria-label="კატეგორია" style={{ maxWidth: 170, height: 32 }} value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="">ყველა კატეგორია</option>{Object.entries(CAT_KA).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <button className="btn sm" type="button" disabled={busy} onClick={onExport}>Excel</button>
        <button className="btn sm" type="button" onClick={() => printSheet(t)}>ბეჭდვა</button>
        {t.can.submit && <button className="btn sm primary" type="button" onClick={() => setDlg('submit')}>წარდგენა</button>}
        {t.can.close && <button className="btn sm primary" type="button" onClick={() => setDlg('close')}>თვის დახურვა</button>}
        {t.can.reopen && <button className="btn sm" type="button" onClick={() => setDlg('reopen')}>ხელახლა გახსნა</button>}
      </div>
      {t.stale.length > 0 && <div className="alert danger">დახურვის შემდეგ შეიცვალა არყოფნა: {t.stale.map((s) => `#${s.no} ${s.staff_name} (${ddmm(s.date_from)}–${ddmm(s.date_to)}, ${s.status === 'approved' ? 'დადასტურდა' : 'გაუქმდა'})`).join('; ')}. ტაბელი მოძველებულია — HR: „ხელახლა გახსნა“ → დახურვა.</div>}
      {!closed && t.checks.pending.length > 0 && <div className="alert warn">განხილვაშია არყოფნის მოთხოვნა: {t.checks.pending.map((p) => `#${p.no} ${p.staff_name}`).join(', ')} — წარდგენა / დახურვა შეჩერებულია.</div>}
      {!closed && !t.ended && <span className="hint">თვე ჯერ არ დასრულებულა: მომავალი დღეები გეგმით ითვლება. ფაქტის შესწორება — განრიგის ბადეში ცვლაზე დაჭერით („ფაქტი“).</span>}
      {!closed && t.ended && !r.timesheet_submitted_at && t.settings.close_requires_submit && <span className="hint">დახურვამდე ტაბელი უნდა წარადგინოს განყოფილების შემდგენმა (ფაქტი შემოწმებულია).</span>}
      <div className="card" style={{ overflow: 'auto', maxHeight: '70vh' }}>
        <table className="table" style={{ fontSize: 12, borderCollapse: 'separate', borderSpacing: 0 }}>
          <thead><tr>
            <th style={{ position: 'sticky', left: 0, top: 0, zIndex: 3, background: 'var(--surface)', minWidth: 190 }}>თანამშრომელი</th>
            {t.days.map((d) => <th key={d.day} title={d.holiday ?? undefined} style={{ position: 'sticky', top: 0, zIndex: 2, textAlign: 'center', padding: '4px 1px', background: d.holiday ? 'var(--danger-weak)' : d.dow >= 6 ? 'var(--warn-weak)' : 'var(--surface)' }}>
              <div>{Number(d.day.slice(8))}</div><div className="muted" style={{ fontWeight: 400 }}>{DOW_KA[d.dow]}</div></th>)}
            {[['ფაქტი', 'ნამუშევარი საათები (ამ განრიგის)'], ['ნორმა', 'თვის ნორმა (ძირითადი განყოფილება)'], ['ზეგ.', 'ზეგანაკვეთი (ყველა განრიგით)'], ['ღამე', 'ღამის საათები'], ['დღესასწ.', 'დღესასწაულის საათები'], ['შ–კ', 'შაბათ-კვირის საათები'], [NO_SHOW, 'არ გამოცხადდა'], ['არყოფნა', 'დღეები ტიპებით']]
              .map(([h, ti]) => <th key={h} title={ti} style={{ position: 'sticky', top: 0, zIndex: 2, background: 'var(--surface)', textAlign: 'right', whiteSpace: 'nowrap' }}>{h}</th>)}
          </tr></thead>
          <tbody>{rows.map((x) => (
            <tr key={x.staff_id}>
              <td style={{ position: 'sticky', left: 0, zIndex: 1, background: 'var(--surface)', whiteSpace: 'nowrap' }}>
                <strong>{x.name}</strong>{!x.home && <span className="chip info" style={{ height: 18, fontSize: 10, marginLeft: 4 }} title={`ძირითადი: ${x.department_name} — ნორმა / ზეგანაკვეთი იქ ითვლება`}>დამ.</span>}
                <div className="small muted">{x.position_name ?? 'პოზიციის გარეშე'}{x.fte !== 1 ? ` · ${x.fte} განაკვ.` : ''}{x.personal_number ? ` · ${x.personal_number}` : ''}</div></td>
              {t.days.map((d) => <td key={d.day} className="mono" style={cellStyle(x.days[d.day], d)}>{x.days[d.day] ?? ''}</td>)}
              <td className="num mono" title={`გეგმა ${fmtH(x.plan_hours)}${x.home && x.total_hours !== x.worked_hours ? ` · ყველა განრიგით ${fmtH(x.total_hours)}` : ''}`}>{fmtH(x.worked_hours)}</td>
              <td className="num mono">{x.home ? fmtH(x.norm_hours) : '—'}</td>
              <td className="num mono" style={{ color: (x.overtime_hours ?? 0) > 0 ? 'var(--warn-ink)' : undefined, fontWeight: (x.overtime_hours ?? 0) > 0 ? 700 : 400 }}
                title={x.home ? `ნამუშევარი ${fmtH(x.total_hours)} + ჩათვლილი ${fmtH(x.credit_hours)} − ნორმა ${fmtH(x.norm_hours)}${x.ot_comp_hours ? ` · COMP ${fmtH(x.ot_comp_hours)} სთ = ${x.comp_days} დღე` : ''}` : undefined}>
                {x.home ? fmtH(x.overtime_hours) : '—'}{x.ot_comp_hours ? <span className="small muted"> (COMP {fmtH(x.ot_comp_hours)})</span> : null}</td>
              <td className="num mono">{fmtH(x.night_hours)}</td><td className="num mono">{fmtH(x.holiday_hours)}</td><td className="num mono">{fmtH(x.weekend_hours)}</td>
              <td className="num mono" style={{ color: x.no_show ? 'var(--danger)' : undefined }}>{x.no_show || ''}</td>
              <td className="small" style={{ whiteSpace: 'nowrap' }}>{x.absence.map((a) => <span key={a.type_id} title={`${a.name}${a.paid ? '' : ' (ანაზღაურების გარეშე)'}${a.counts_as_work ? ' — ნამუშევრად ითვლება' : ''}`} style={{ marginRight: 6 }}>{a.short} {a.days}</span>)}</td>
            </tr>))}
            {!rows.length && <tr><td colSpan={t.days.length + 9} className="muted">სტრიქონი არ არის</td></tr>}
          </tbody>
          <tfoot><tr>
            <td style={{ position: 'sticky', left: 0, background: 'var(--surface-2)' }}><strong>სულ</strong></td><td colSpan={t.days.length} style={{ background: 'var(--surface-2)' }} />
            {(['worked_hours', 'norm_hours', 'overtime_hours', 'night_hours', 'holiday_hours', 'weekend_hours', 'no_show'] as const).map((k) => <td key={k} className="num mono" style={{ background: 'var(--surface-2)' }}><strong>{fmtH(t.totals[k])}</strong></td>)}
            <td style={{ background: 'var(--surface-2)' }} /></tr></tfoot>
        </table>
      </div>
      <div className="row small muted" style={{ flexWrap: 'wrap', gap: 12 }}>
        <span>რიცხვი — ნამუშევარი საათები (ფაქტი)</span><span style={{ color: 'var(--danger)' }}>{NO_SHOW} — არ გამოცხადდა</span>
        {refs.absence_types.filter((a) => a.is_active).map((a) => <span key={a.id}><strong style={{ color: '#3730a3' }}>{a.short}</strong> — {a.name}</span>)}
        <span>ღამის / დღესასწაულის / შაბ.–კვ. საათები — საათობრივი გადაფარვით, ცვლა ეკუთვნის დაწყების თვეს</span>
      </div>
      {r.close_note && <span className="small">დახურვის შენიშვნა: {r.close_note}</span>}
      {dlg === 'submit' && <SubmitDialog t={t} onClose={() => setDlg(null)} onDone={() => { setDlg(null); refresh(); onToast('ტაბელი წარდგენილია (HR-ს ეგზავნება შეტყობინება)'); }} />}
      {dlg === 'close' && <CloseDialog t={t} onClose={() => setDlg(null)} onDone={(m) => { setDlg(null); refresh(); onToast(m); }} />}
      {dlg === 'reopen' && <ReopenDialog t={t} onClose={() => setDlg(null)} onDone={() => { setDlg(null); refresh(); onToast('თვე ხელახლა გაიხსნა'); }} />}
    </div>
  );
}

function SubmitDialog({ t, onClose, onDone }: { t: Timesheet; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState('');
  const m = useMutation({ mutationFn: () => api(`/roster/rosters/${t.roster.id}/submit`, { body: { note: note.trim() || null } }), onSuccess: onDone });
  return <Modal title={`ტაბელის წარდგენა · ${t.roster.department_name} · ${monthLabel(t.roster.month)}`} onClose={onClose}
    footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={m.isPending} onClick={() => m.mutate()}>წარდგენა</button></>}>
    <div className="stack">
      <span>ვადასტურებ, რომ ფაქტი (გადახრები, „არ გამოცხადდა“, გამოძახება) შემოწმებულია. ფაქტის შესწორება დახურვამდე კვლავ შესაძლებელია.</span>
      <span className="small">ფაქტი: <strong>{fmtH(t.totals.worked_hours)}</strong> სთ · ზეგანაკვეთი: <strong>{fmtH(t.totals.overtime_hours)}</strong> · „არ გამოცხადდა“: <strong>{t.checks.no_show}</strong> · დასაფარი (ღია): <strong>{t.checks.open_shifts}</strong></span>
      <Field label="შენიშვნა HR-ისთვის" htmlFor="ts-n"><input id="ts-n" className="input" value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} /></Field>
      <ErrorBox error={m.error} />
    </div>
  </Modal>;
}

/** დახურვა (HR): ზეგანაკვეთი → ანაზღაურება / ნაცვლად დასვენება (COMP), გაფრთხილების დადასტურება */
function CloseDialog({ t, onClose, onDone }: { t: Timesheet; onClose: () => void; onDone: (m: string) => void }) {
  const ot = t.rows.filter((x) => x.home && (x.overtime_hours ?? 0) > 0);
  const [comp, setComp] = useState<Record<string, string>>(() => Object.fromEntries(ot.map((x) => [x.staff_id, String(x.ot_comp_hours ?? 0)])));
  const [note, setNote] = useState(''); const [confirm, setConfirm] = useState(false);
  const daily = (x: TsRow) => (t.settings.week_norm_hours / 5) * x.fte;
  const m = useMutation({
    mutationFn: () => api<{ overtime: number; comp_days: number }>(`/roster/rosters/${t.roster.id}/close`, { body: { confirm_warnings: confirm, note: note.trim() || null,
      comp: ot.map((x) => ({ staff_id: x.staff_id, hours: Math.min(Number(comp[x.staff_id] || 0), x.overtime_hours ?? 0) })) } }),
    onSuccess: (r) => onDone(`თვე დაიხურა · ზეგანაკვეთი ${fmtH(r.overtime)} სთ${r.comp_days ? ` · COMP ${r.comp_days} დღე` : ''}`),
  });
  const b = errBody(m.error);
  const warn = t.checks.open_shifts > 0 || t.checks.no_show > 0;
  return <Modal title={`თვის დახურვა · ${t.roster.department_name} · ${monthLabel(t.roster.month)}`} width={760} onClose={onClose}
    footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={m.isPending || (warn && !confirm)} onClick={() => m.mutate()}>დახურვა</button></>}>
    <div className="stack">
      <span className="small">დახურვისას ტაბელი ინახება (snapshot) და განრიგი იბლოკება. გვიან დარეგისტრირებული არყოფნა ტაბელს „მოძველებულად“ მონიშნავს — მაშინ ხელახლა გახსნა / დახურვა.</span>
      {warn && <label className="alert warn row"><input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /> შეუვსებელი დასაფარი — {t.checks.open_shifts}, „არ გამოცხადდა“ — {t.checks.no_show}. ვადასტურებ დახურვას</label>}
      {ot.length ? <>
        <strong className="small">ზეგანაკვეთი → ნაცვლად დასვენება (COMP, ტიპი „{t.settings.comp_absence_type}“; დანარჩენი — ანაზღაურება)</strong>
        <table className="table small"><thead><tr><th>თანამშრომელი</th><th className="num">ზეგანაკვ., სთ</th><th>COMP, სთ</th><th className="num">ანაზღ., სთ</th><th className="num">COMP, დღე</th></tr></thead>
          <tbody>{ot.map((x) => { const c = Math.min(Math.max(0, Number(comp[x.staff_id] || 0)), x.overtime_hours ?? 0); const d = daily(x) > 0 ? Math.round((c / daily(x)) * 2) / 2 : 0; return (
            <tr key={x.staff_id}><td>{x.name}</td><td className="num mono">{fmtH(x.overtime_hours)}</td>
              <td><div className="row" style={{ gap: 4 }}><input className="input mono" type="number" min={0} max={x.overtime_hours ?? 0} step={0.5} style={{ maxWidth: 90, height: 30 }} aria-label={`${x.name} — COMP საათები`}
                value={comp[x.staff_id] ?? '0'} onChange={(e) => setComp({ ...comp, [x.staff_id]: e.target.value })} />
                <button className="btn sm" type="button" onClick={() => setComp({ ...comp, [x.staff_id]: String(x.overtime_hours ?? 0) })}>ყველა</button>
                <button className="btn sm" type="button" onClick={() => setComp({ ...comp, [x.staff_id]: '0' })}>0</button></div></td>
              <td className="num mono">{fmtH((x.overtime_hours ?? 0) - c)}</td><td className="num mono">{d}</td></tr>); })}</tbody></table>
        <span className="hint">COMP დღე = საათები / (კვირის ნორმა / 5 × FTE), 0.5-მდე დამრგვალებით; ჩაიწერება COMP ბალანსში ({t.roster.month.slice(0, 4)}). ხელახლა გახსნისას — საპირისპირო ჩანაწერით.</span></>
        : <span className="small muted">ზეგანაკვეთი არავის აქვს.</span>}
      <Field label="შენიშვნა" htmlFor="tc-n"><input id="tc-n" className="input" value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} /></Field>
      {Array.isArray(b.pending) && <div className="alert danger">განხილვაშია: {(b.pending as { no: string; staff_name: string }[]).map((p) => `#${p.no} ${p.staff_name}`).join(', ')}</div>}
      <ErrorBox error={m.error} />
    </div>
  </Modal>;
}

function ReopenDialog({ t, onClose, onDone }: { t: Timesheet; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const m = useMutation({ mutationFn: () => api(`/roster/rosters/${t.roster.id}/reopen`, { body: { reason: reason.trim() } }), onSuccess: onDone });
  return <Modal title={`ხელახლა გახსნა · ${t.roster.department_name} · ${monthLabel(t.roster.month)}`} onClose={onClose}
    footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn danger" type="button" disabled={m.isPending || reason.trim().length < 3} onClick={() => m.mutate()}>გახსნა</button></>}>
    <div className="stack">
      <span>განრიგი დაბრუნდება „გამოქვეყნებულ“ სტატუსში, ტაბელი გადაითვლება. ზეგანაკვეთიდან დარიცხული COMP — საპირისპირო ჩანაწერით დაბრუნდება.</span>
      <Field label="მიზეზი" htmlFor="tr-r" required><input id="tr-r" className="input" value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} /></Field>
      <ErrorBox error={m.error} />
    </div>
  </Modal>;
}

/** ბეჭდვა (ბრაუზერი, A4 / A3 landscape): ტაბელი + ხელმოწერის ველები */
function printSheet(t: Timesheet) {
  const r = t.roster;
  const head = t.days.map((d) => `<th class="${d.holiday ? 'h' : d.dow >= 6 ? 'w' : ''}">${Number(d.day.slice(8))}<br><small>${DOW_KA[d.dow]}</small></th>`).join('');
  const body = t.rows.map((x, i) => `<tr><td>${i + 1}</td><td class="l">${esc(x.name)}${x.home ? '' : ' (დამ.)'}<br><small>${esc(x.position_name)}${x.fte !== 1 ? ` · ${x.fte}` : ''}</small></td>`
    + t.days.map((d) => `<td class="${d.holiday ? 'h' : d.dow >= 6 ? 'w' : ''}">${esc(x.days[d.day])}</td>`).join('')
    + `<td class="n">${fmtH(x.worked_hours)}</td><td class="n">${x.home ? fmtH(x.norm_hours) : ''}</td><td class="n">${x.home ? fmtH(x.overtime_hours) : ''}</td><td class="n">${fmtH(x.night_hours)}</td>`
    + `<td class="n">${fmtH(x.holiday_hours)}</td><td class="n">${x.no_show || ''}</td><td class="l">${x.absence.map((a) => `${esc(a.short)} ${a.days}`).join(', ')}</td></tr>`).join('');
  const w = window.open('', '_blank', 'width=1200,height=900');
  if (!w) return;
  w.document.write(`<!doctype html><html lang="ka"><head><meta charset="utf-8"><title>ტაბელი · ${esc(r.department_name)} · ${monthLabel(r.month)}</title><style>
    @page{size:A4 landscape;margin:10mm} body{font:10px/1.3 system-ui,sans-serif;color:#111;margin:0} h1{font-size:15px;margin:0 0 2px}
    table{border-collapse:collapse;width:100%;margin-top:8px} th,td{border:1px solid #999;padding:2px 3px;text-align:center} td.l{text-align:left} td.n{text-align:right;white-space:nowrap}
    th{background:#eee} .w{background:#fff7e6} .h{background:#fdecea} small{color:#555} .s{margin-top:28px;display:grid;grid-template-columns:repeat(3,1fr);gap:40px} .s div{border-top:1px solid #111;padding-top:3px}
  </style></head><body>
    <h1>ტაბელი — ${esc(r.department_name)} · ${monthLabel(r.month)}</h1>
    <div>${r.status === 'closed' ? `დახურული${r.closed_at ? ` ${tsDate(r.closed_at)}` : ''}` : 'წინასწარი (თვე ჯერ არ დახურულა)'} · სამუშაო დღე: ${t.workdays} · ნორმა: ${t.settings.week_norm_hours} სთ / კვირა × FTE ·
      კოდები: რიცხვი — საათები, ${NO_SHOW} — არ გამოცხადდა, ${[...new Map(t.rows.flatMap((x) => x.absence).map((a) => [a.code, `${esc(a.short)} — ${esc(a.name)}`])).values()].join('; ')}</div>
    <table><thead><tr><th>№</th><th>თანამშრომელი</th>${head}<th>ფაქტი</th><th>ნორმა</th><th>ზეგ.</th><th>ღამე</th><th>დღესასწ.</th><th>${NO_SHOW}</th><th>არყოფნა</th></tr></thead><tbody>${body}</tbody></table>
    <div class="s"><div>შემდგენი</div><div>განყოფილების ხელმძღვანელი</div><div>HR</div></div>
    <script>window.onload=()=>window.print()</script></body></html>`);
  w.document.close();
}
