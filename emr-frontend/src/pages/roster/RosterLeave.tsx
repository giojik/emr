import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiError, api, apiUpload, openBlob } from '../../api/client';
import { ErrorBox, Field, Loading, Modal, useToast } from '../../components/ui';
import { dateGe, hhmm, todayISO, tsDate } from '../../lib/format';
import {
  ABS_STATUS, CAT_KA, DOW_KA, ROUTE_KA, SRC_KA, SWAP_STATUS, ddmm, monthLabel,
  type AbsenceRow, type AbsenceType, type OpenShift, type Refs, type SwapRow,
} from './types';

/** 0078: თვითმომსახურება (ჩემი განრიგი → არყოფნა / გაცვლები / სურვილები / დასაფარი) და „დასადასტურებელი“ (ხელმძღვანელი / HR / შემდგენი) */
const nextMonth = (m: string) => { const [y, mm] = m.split('-').map(Number); return mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, '0')}`; };
const prevMonth = (m: string) => { const [y, mm] = m.split('-').map(Number); return mm === 1 ? `${y - 1}-12` : `${y}-${String(mm - 1).padStart(2, '0')}`; };
const dowOf = (d: string) => ((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
const errBody = (e: unknown) => (e instanceof ApiError ? e.body ?? {} : {}) as Record<string, unknown>;
const period = (a: string, b: string) => (a === b ? dateGe(a) : `${dateGe(a)} — ${dateGe(b)}`);
const Chip = ({ m, s }: { m: Record<string, [string, string]>; s: string }) => <span className={`chip ${m[s]?.[0] ?? ''}`} style={{ height: 20, fontSize: 11 }}>{m[s]?.[1] ?? s}</span>;
const TypeDot = ({ c }: { c: string }) => <span aria-hidden="true" style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 3, background: c, marginRight: 4 }} />;
const useInvalidate = () => { const qc = useQueryClient(); return () => { for (const k of ['roster-abs', 'roster-bal', 'roster-inbox', 'roster-swaps', 'roster-open', 'roster-my', 'roster', 'roster-prefs']) void qc.invalidateQueries({ queryKey: [k] }); }; };

// ================================================================ ჩემი განრიგი (ჩანართები)
type MyEntry = { id: string; day: string; code: string; shift_name: string; kind: string; color: string; starts_at: string; ends_at: string; hours: string; department_name: string; duty_name: string | null; duty_level: number | null; note: string | null };
export function MyHub({ refs }: { refs: Refs }) {
  const [sp, setSp] = useSearchParams();
  const sub = sp.get('sub') ?? 'schedule';
  const subs: [string, string][] = [['schedule', 'განრიგი'], ['absence', 'არყოფნა / ბალანსი'], ['swaps', 'გაცვლები'], ['prefs', '„არ შემიძლია“ / სურვილები'], ['open', 'დასაფარი']];
  const set = (k: string) => { sp.set('sub', k); setSp(sp, { replace: true }); };
  return (
    <div className="content">
      <div className="row" role="tablist" aria-label="ჩემი განრიგი" style={{ gap: 4, flexWrap: 'wrap' }}>
        {subs.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={sub === k} className={`btn sm${sub === k ? ' primary' : ''}`} onClick={() => set(k)}>{l}</button>)}
      </div>
      {!refs.me ? <div className="card empty">თქვენი ანგარიში თანამშრომლების რეესტრში არ არის მიბმული — მიმართეთ განრიგის შემდგენს / HR-ს.</div>
        : sub === 'absence' ? <MyAbsence refs={refs} /> : sub === 'swaps' ? <MySwaps /> : sub === 'prefs' ? <MyPrefs refs={refs} /> : sub === 'open' ? <MyOpen refs={refs} /> : <MySchedule refs={refs} />}
    </div>
  );
}

function MySchedule({ refs }: { refs: Refs }) {
  const [sp, setSp] = useSearchParams();
  const month = sp.get('month') ?? todayISO().slice(0, 7);
  const [swap, setSwap] = useState<MyEntry | null>(null);
  const q = useQuery({ queryKey: ['roster-my', month], queryFn: () => api<{ staff: { id: string; name: string } | null; month: string; hours?: number; entries: MyEntry[] }>('/roster/my', { query: { month } }) });
  const abs = useQuery({ queryKey: ['roster-abs', 'my'], queryFn: () => api<AbsenceRow[]>('/roster/absences', { query: { scope: 'my' } }) });
  useEffect(() => { if (!sp.get('month')) { sp.set('month', month); setSp(sp, { replace: true }); } }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (m: string) => { sp.set('month', m); setSp(sp, { replace: true }); };
  const notice = refs.settings.swap_min_notice_hours * 36e5;
  const mineAbs = (abs.data ?? []).filter((a) => ['head', 'hr', 'approved'].includes(a.status) && a.date_to >= `${month}-01` && a.date_from <= `${month}-31`);
  return <>
    <div className="row">
      <button className="btn" type="button" aria-label="წინა თვე" onClick={() => set(prevMonth(month))}>‹</button>
      <input className="input" type="month" aria-label="თვე" style={{ maxWidth: 170, height: 38 }} value={month} onChange={(e) => e.target.value && set(e.target.value)} />
      <button className="btn" type="button" aria-label="შემდეგი თვე" onClick={() => set(nextMonth(month))}>›</button>
      <span className="grow" />{q.data?.staff && <span>{q.data.staff.name} · <strong>{q.data.hours ?? 0} სთ</strong> · {q.data.entries.length} ცვლა</span>}
    </div>
    <ErrorBox error={q.error} />
    {mineAbs.length > 0 && <div className="row small" style={{ flexWrap: 'wrap', gap: 8 }}>{mineAbs.map((a) => <span key={a.id} className="chip info"><TypeDot c={a.color} />{a.type_name}: {period(a.date_from, a.date_to)} · {ABS_STATUS[a.status]?.[1]}</span>)}</div>}
    {q.isLoading ? <Loading /> : <div className="card"><table className="table"><thead><tr><th>დღე</th><th>ცვლა</th><th>დრო</th><th>სთ</th><th>განყოფილება</th><th>მორიგეობა</th><th>შენიშვნა</th><th /></tr></thead>
      <tbody>{q.data?.entries.map((e) => <tr key={e.id}><td style={{ whiteSpace: 'nowrap' }}>{ddmm(e.day)} <span className="muted">{DOW_KA[dowOf(e.day)]}</span></td>
        <td><span className="mono" style={{ background: e.color, color: '#fff', borderRadius: 4, padding: '1px 6px', fontWeight: 600 }}>{e.code}</span> <span className="small">{e.shift_name}</span></td>
        <td>{hhmm(e.starts_at)}–{hhmm(e.ends_at)}</td><td className="mono">{Number(e.hours)}</td><td>{e.department_name}</td>
        <td>{e.duty_name ? `${e.duty_level === 2 ? '☆' : '★'} ${e.duty_name}` : ''}</td><td className="small">{e.note ?? ''}</td>
        <td>{new Date(e.starts_at).getTime() - Date.now() > notice && <button className="btn sm" type="button" title="გაცვლა / გადაცემა კოლეგასთან" onClick={() => setSwap(e)}>⇄</button>}</td></tr>)}
        {!q.data?.entries.length && <tr><td colSpan={8} className="muted">{monthLabel(month)} — გამოქვეყნებულ განრიგში ცვლა არ გაქვთ</td></tr>}</tbody></table></div>}
    <span className="hint">⇄ — გაცვლა / გადაცემა: კოლეგა ეთანხმება{refs.settings.swap_approval === 'head' ? ', შემდეგ ადასტურებს განრიგის შემდგენი' : ''}. დაწყებამდე მინ. {refs.settings.swap_min_notice_hours} სთ.</span>
    {swap && <SwapDialog e={swap} onClose={() => setSwap(null)} />}
  </>;
}

// ---------------------------------------------------------------- გაცვლა / გადაცემა
function SwapDialog({ e, onClose }: { e: MyEntry; onClose: () => void }) {
  const inv = useInvalidate(); const [kind, setKind] = useState<'swap' | 'give'>('swap');
  const [peer, setPeer] = useState(''); const [entry, setEntry] = useState(''); const [note, setNote] = useState('');
  const q = useQuery({ queryKey: ['roster-swap-opt', e.id], queryFn: () => api<{ colleagues: { id: string; name: string; position_name: string | null }[]; shifts: { id: string; staff_id: string; day: string; code: string; starts_at: string; ends_at: string }[]; approval: string }>('/roster/swaps/options', { query: { entry_id: e.id } }) });
  const m = useMutation({ mutationFn: () => api<{ warnings: string[] }>('/roster/swaps', { body: { kind, from_entry_id: e.id, ...(kind === 'swap' ? { to_entry_id: entry } : { to_staff_id: peer }), ...(note.trim() && { note: note.trim() }) } }),
    onSuccess: () => { inv(); onClose(); } });
  const shifts = (q.data?.shifts ?? []).filter((s) => s.staff_id === peer);
  return <Modal title={`${ddmm(e.day)} ${e.code} — გაცვლა / გადაცემა`} onClose={onClose} footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button>
    <button className="btn primary" type="button" disabled={m.isPending || !peer || (kind === 'swap' && !entry)} onClick={() => m.mutate()}>შეთავაზება</button></>}>
    {q.isLoading ? <Loading /> : <div className="stack">
      <div className="row" style={{ gap: 12 }}>
        <label className="row"><input type="radio" name="sk" checked={kind === 'swap'} onChange={() => setKind('swap')} /> გაცვლა (ჩემი ↔ კოლეგის)</label>
        <label className="row"><input type="radio" name="sk" checked={kind === 'give'} onChange={() => setKind('give')} /> გადაცემა (კოლეგა იღებს)</label></div>
      <Field label="კოლეგა" htmlFor="sw-p" required hint="იმავე განყოფილების, იმავე კატეგორიის, EMR ანგარიშით"><select id="sw-p" className="select" value={peer} onChange={(x) => { setPeer(x.target.value); setEntry(''); }}>
        <option value="">—</option>{q.data?.colleagues.map((c) => <option key={c.id} value={c.id}>{c.name}{c.position_name ? ` · ${c.position_name}` : ''}</option>)}</select></Field>
      {kind === 'swap' && peer && <Field label="კოლეგის ცვლა" htmlFor="sw-e" required><select id="sw-e" className="select" value={entry} onChange={(x) => setEntry(x.target.value)}>
        <option value="">—</option>{shifts.map((s) => <option key={s.id} value={s.id}>{ddmm(s.day)} {s.code} ({hhmm(s.starts_at)}–{hhmm(s.ends_at)})</option>)}</select></Field>}
      {kind === 'swap' && peer && !shifts.length && <span className="small muted">კოლეგას გამოქვეყნებულ განრიგში შესაბამისი ცვლა არ აქვს</span>}
      <Field label="შენიშვნა კოლეგისთვის" htmlFor="sw-n"><input id="sw-n" className="input" value={note} maxLength={500} onChange={(x) => setNote(x.target.value)} /></Field>
      <span className="hint">წესები (დასვენება, ზედიზედ საათები, არყოფნა…) მოწმდება ახლა და დადასტურებისას. {q.data?.approval === 'head' ? 'კოლეგის თანხმობის შემდეგ — შემდგენის დადასტურება.' : 'კოლეგის თანხმობით სრულდება.'}</span>
      <ErrorBox error={m.error} />
    </div>}
  </Modal>;
}

function MySwaps() {
  const inv = useInvalidate(); const toast = useToast();
  const q = useQuery({ queryKey: ['roster-swaps', 'mine'], queryFn: () => api<SwapRow[]>('/roster/swaps') });
  const [dlg, setDlg] = useState<{ sw: SwapRow; accept: boolean } | null>(null);
  const cancel = useMutation({ mutationFn: (id: string) => api(`/roster/swaps/${id}/cancel`, { body: {} }), onSuccess: () => { inv(); toast.show('გაუქმდა'); } });
  return <>
    {toast.node}<ErrorBox error={q.error ?? cancel.error} />
    {q.isLoading ? <Loading /> : <div className="card"><table className="table small"><thead><tr><th>#</th><th>სახე</th><th>ვინ → ვის</th><th>ცვლა</th><th>სტატუსი</th><th>შენიშვნა</th><th /></tr></thead>
      <tbody>{q.data?.map((s) => <tr key={s.id}><td className="mono">{s.no}</td><td>{s.kind === 'swap' ? 'გაცვლა' : 'გადაცემა'} {s.direction === 'in' ? <span className="chip info" style={{ height: 18, fontSize: 10 }}>შემომავალი</span> : null}</td>
        <td>{s.a_staff_name} → {s.b_staff_name}</td>
        <td className="mono">{ddmm(s.a_day)} {s.a_code}{s.b_day ? ` ↔ ${ddmm(s.b_day)} ${s.b_code}` : ''}</td><td><Chip m={SWAP_STATUS} s={s.status} /></td>
        <td>{[s.note, s.peer_note, s.head_note, s.reason].filter(Boolean).join(' · ')}{s.warnings?.length ? <div className="small" style={{ color: 'var(--warn-ink)' }}>⚠ {s.warnings.join('; ')}</div> : null}</td>
        <td style={{ whiteSpace: 'nowrap' }}>{s.direction === 'in' && s.status === 'peer' && <><button className="btn sm primary" type="button" onClick={() => setDlg({ sw: s, accept: true })}>თანხმობა</button>{' '}
          <button className="btn sm" type="button" onClick={() => setDlg({ sw: s, accept: false })}>უარი</button></>}
          {s.direction === 'out' && (s.status === 'peer' || s.status === 'head') && <button className="btn sm" type="button" disabled={cancel.isPending} onClick={() => cancel.mutate(s.id)}>გაუქმება</button>}</td></tr>)}
        {!q.data?.length && <tr><td colSpan={7} className="muted">გაცვლა / გადაცემა არ არის. ახალი — „განრიგი“ → ⇄</td></tr>}</tbody></table></div>}
    {dlg && <PeerDialog sw={dlg.sw} accept={dlg.accept} onClose={() => setDlg(null)} onDone={(m) => { setDlg(null); inv(); toast.show(m); }} />}
  </>;
}
function PeerDialog({ sw, accept, onClose, onDone }: { sw: SwapRow; accept: boolean; onClose: () => void; onDone: (m: string) => void }) {
  const [note, setNote] = useState('');
  const m = useMutation({ mutationFn: () => api<{ status: string }>(`/roster/swaps/${sw.id}/peer`, { body: { accept, ...(note.trim() && { note: note.trim() }) } }),
    onSuccess: (r) => onDone(r.status === 'approved' ? 'შესრულდა' : r.status === 'head' ? 'გაიგზავნა შემდგენთან' : 'უარი გაიგზავნა') });
  return <Modal title={`${accept ? 'თანხმობა' : 'უარი'} · #${sw.no}`} onClose={onClose} footer={<><button className="btn" type="button" onClick={onClose}>დახურვა</button>
    <button className={`btn ${accept ? 'primary' : 'danger'}`} type="button" disabled={m.isPending} onClick={() => m.mutate()}>{accept ? 'ვეთანხმები' : 'უარი'}</button></>}>
    <div className="stack"><span>{sw.a_staff_name}: {ddmm(sw.a_day)} {sw.a_code}{sw.b_day ? ` ↔ თქვენი ${ddmm(sw.b_day)} ${sw.b_code}` : ' — გადმოგეცემათ'}</span>
      {accept && sw.warnings?.length > 0 && <div className="alert warn">{sw.warnings.join('; ')}</div>}
      <Field label="შენიშვნა" htmlFor="pd-n"><input id="pd-n" className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field><ErrorBox error={m.error} /></div>
  </Modal>;
}

// ---------------------------------------------------------------- არყოფნა / ბალანსი
type BalItem = { type: AbsenceType & { color: string }; entitlement: number | null; override: boolean; accrued: number; adjusted: number; used: number; total: number; pending: number; available: number;
  ledger: { id: string; kind: string; period: number; days: string; reason: string | null; created_at: string; request_no: string | null; user_name: string | null }[] };
const KIND_LEDGER: Record<string, string> = { accrual: 'დარიცხვა', adjust: 'კორექცია', carry: 'გადატანა', use: 'გამოყენება', restore: 'აღდგენა' };
export function BalanceCards({ staffId, year, canAdjust }: { staffId?: string; year: number; canAdjust?: boolean }) {
  const q = useQuery({ queryKey: ['roster-bal', staffId ?? 'me', year], queryFn: () => api<{ year: number; staff: { id: string; name: string } | null; items: BalItem[]; can_adjust?: boolean }>('/roster/balances', { query: { staff_id: staffId, year } }) });
  const [adj, setAdj] = useState<BalItem | null>(null); const [open, setOpen] = useState<string | null>(null);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  return <div className="stack">
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 10 }}>
      {q.data?.items.map((b) => <section key={b.type.id} className="card card-pad stack" style={{ gap: 4 }}>
        <strong><TypeDot c={b.type.color} />{b.type.name}</strong>
        <span style={{ fontSize: 22, fontWeight: 700 }}>{b.available} <span className="small muted">ხელმისაწვდომი</span></span>
        <span className="small muted">ნორმა {b.entitlement ?? '—'}{b.override ? ' (ინდივ.)' : ''} · დარიცხ. {b.accrued} · კორექცია {b.adjusted} · გამოყ. {b.used}{b.pending ? ` · განხილვაში ${b.pending}` : ''}</span>
        <div className="row" style={{ gap: 6 }}><button className="btn sm" type="button" onClick={() => setOpen(open === b.type.id ? null : b.type.id)}>ჟურნალი</button>
          {(canAdjust ?? q.data.can_adjust) && staffId && <button className="btn sm" type="button" onClick={() => setAdj(b)}>კორექცია</button>}</div>
        {open === b.type.id && <ul className="small" style={{ margin: 0, paddingLeft: 16 }}>{b.ledger.map((l) => <li key={l.id}>{tsDate(l.created_at)} · {KIND_LEDGER[l.kind]}{l.period ? ` (${l.period} თვე)` : ''}: <strong>{Number(l.days) > 0 ? '+' : ''}{Number(l.days)}</strong>
          {l.request_no ? ` · #${l.request_no}` : ''}{l.reason ? ` · ${l.reason}` : ''}{l.user_name ? ` · ${l.user_name}` : ''}</li>)}{!b.ledger.length && <li className="muted">ცარიელია</li>}</ul>}
      </section>)}
    </div>
    {adj && staffId && <AdjustDialog b={adj} staffId={staffId} year={year} onClose={() => setAdj(null)} onDone={() => { setAdj(null); void q.refetch(); }} />}
  </div>;
}
function AdjustDialog({ b, staffId, year, onClose, onDone }: { b: BalItem; staffId: string; year: number; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ kind: 'adjust', days: '', reason: '', ent: b.override ? String(b.entitlement ?? '') : '' });
  const m = useMutation({ mutationFn: () => api('/roster/balances/entries', { body: { staff_id: staffId, absence_type_id: b.type.id, year, kind: f.kind, days: Number(f.days), reason: f.reason.trim() } }), onSuccess: onDone });
  const e = useMutation({ mutationFn: () => api('/roster/balances/entitlement', { method: 'PUT', body: { staff_id: staffId, absence_type_id: b.type.id, days_per_year: f.ent === '' ? null : Number(f.ent) } }), onSuccess: onDone });
  return <Modal title={`${b.type.name} · ${year}`} onClose={onClose} footer={<button className="btn" type="button" onClick={onClose}>დახურვა</button>}>
    <div className="stack">
      <strong className="small">კორექცია / გადატანა (ჟურნალში ახალი ჩანაწერი)</strong>
      <div className="row" style={{ gap: 8 }}>
        <select className="select" aria-label="სახე" value={f.kind} onChange={(x) => setF({ ...f, kind: x.target.value })}><option value="adjust">კორექცია</option><option value="carry">გადატანა წინა წლიდან</option></select>
        <input className="input mono" style={{ maxWidth: 100 }} type="number" step="0.5" aria-label="დღეები (+/−)" placeholder="± დღე" value={f.days} onChange={(x) => setF({ ...f, days: x.target.value })} /></div>
      <Field label="მიზეზი" htmlFor="adj-r" required><input id="adj-r" className="input" value={f.reason} onChange={(x) => setF({ ...f, reason: x.target.value })} /></Field>
      <button className="btn primary" type="button" disabled={m.isPending || !Number(f.days) || f.reason.trim().length < 3} onClick={() => m.mutate()}>ჩაწერა</button>
      <hr style={{ border: 0, borderTop: '1px solid var(--line-soft)', width: '100%' }} />
      <Field label="ინდივიდუალური წლიური ნორმა" htmlFor="adj-e" hint={`ცარიელი — ტიპის ნორმა (${b.type.default_days ?? '—'}). უკვე დარიცხულ წელს არ ცვლის — საჭიროებისას კორექცია.`}>
        <div className="row" style={{ gap: 6 }}><input id="adj-e" className="input mono" style={{ maxWidth: 100 }} type="number" step="0.5" value={f.ent} onChange={(x) => setF({ ...f, ent: x.target.value })} />
          <button className="btn" type="button" disabled={e.isPending} onClick={() => e.mutate()}>შენახვა</button></div></Field>
      <ErrorBox error={m.error ?? e.error} />
    </div></Modal>;
}

function MyAbsence({ refs }: { refs: Refs }) {
  const [year, setYear] = useState(Number(todayISO().slice(0, 4)));
  const [neu, setNeu] = useState(false); const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['roster-abs', 'my'], queryFn: () => api<AbsenceRow[]>('/roster/absences', { query: { scope: 'my' } }) });
  return <>
    <div className="row"><strong>ბალანსი</strong>
      <select className="select" aria-label="წელი" style={{ maxWidth: 110, height: 34 }} value={year} onChange={(e) => setYear(Number(e.target.value))}>{[year - 1, year, year + 1].map((y) => <option key={y} value={y}>{y}</option>)}</select>
      <span className="grow" /><button className="btn primary" type="button" onClick={() => setNeu(true)}>+ ახალი მოთხოვნა</button></div>
    <BalanceCards year={year} />
    <strong>ჩემი მოთხოვნები</strong>
    <AbsTable rows={q.data ?? []} loading={q.isLoading} error={q.error} onOpen={setOpen} hideStaff />
    {neu && <NewAbsenceDialog refs={refs} onClose={() => setNeu(false)} />}
    {open && <AbsenceDialog id={open} onClose={() => setOpen(null)} />}
  </>;
}

function AbsTable({ rows, loading, error, onOpen, hideStaff }: { rows: AbsenceRow[]; loading: boolean; error: unknown; onOpen: (id: string) => void; hideStaff?: boolean }) {
  if (loading) return <Loading />;
  return <><ErrorBox error={error} /><div className="card"><table className="table small"><thead><tr><th>#</th>{!hideStaff && <th>თანამშრომელი</th>}<th>ტიპი</th><th>პერიოდი</th><th>დღე</th><th>სტატუსი</th><th>შენიშვნა</th></tr></thead>
    <tbody>{rows.map((a) => <tr key={a.id} className="clickable" onClick={() => onOpen(a.id)}><td className="mono">{a.no}</td>
      {!hideStaff && <td><strong>{a.staff_name}</strong><div className="muted">{a.department_name}{a.position_name ? ` · ${a.position_name}` : ''}</div></td>}
      <td><TypeDot c={a.color} />{a.type_name}</td><td style={{ whiteSpace: 'nowrap' }}>{period(a.date_from, a.date_to)}</td><td className="mono">{Number(a.days)}</td>
      <td><Chip m={ABS_STATUS} s={a.status} />{a.cancel_requested_at && a.status === 'approved' && <div><span className="chip warn" style={{ height: 18, fontSize: 10 }}>გაუქმების თხოვნა</span></div>}</td>
      <td>{a.note ?? ''}{a.reject_reason ? ` · უარი: ${a.reject_reason}` : ''}</td></tr>)}
      {!rows.length && <tr><td colSpan={hideStaff ? 6 : 7} className="muted">მოთხოვნა არ არის</td></tr>}</tbody></table></div></>;
}

/** ახალი მოთხოვნა: თავისთვის, ან (ხელმძღვანელი / შემდგენი / HR) თანამშრომლის მაგივრად */
export function NewAbsenceDialog({ refs, staff, onClose }: { refs: Refs; staff?: { id: string; name: string }[]; onClose: () => void }) {
  const inv = useInvalidate();
  const types = refs.absence_types.filter((t) => t.is_active && (staff || t.self_request));
  const [f, setF] = useState({ staff_id: '', type: types[0]?.id ?? '', from: todayISO(), to: todayISO(), note: '', doc: '', over: '' });
  const ty = types.find((t) => t.id === f.type);
  const m = useMutation({ mutationFn: () => api<{ status: string; warnings: string[] }>('/roster/absences', { body: { ...(f.staff_id && { staff_id: f.staff_id }), absence_type_id: f.type, date_from: f.from, date_to: f.to,
    ...(f.note.trim() && { note: f.note.trim() }), ...(f.doc.trim() && { document_no: f.doc.trim() }), ...(f.over.trim() && { overdraw_reason: f.over.trim() }) } }), onSuccess: () => { inv(); onClose(); } });
  const b = errBody(m.error);
  return <Modal title={staff ? 'არყოფნის რეგისტრაცია' : 'ახალი მოთხოვნა'} onClose={onClose} footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button>
    <button className="btn primary" type="button" disabled={m.isPending || !f.type || f.to < f.from || (!!staff && !f.staff_id)} onClick={() => m.mutate()}>გაგზავნა</button></>}>
    <div className="stack">
      {staff && <Field label="თანამშრომელი" htmlFor="na-s" required><select id="na-s" className="select" value={f.staff_id} onChange={(e) => setF({ ...f, staff_id: e.target.value })}>
        <option value="">—</option>{staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>}
      <Field label="ტიპი" htmlFor="na-t" required hint={ty ? `${ty.unit === 'workday' ? 'სამუშაო დღეები (ორშ.–პარ., დღესასწაულების გარეშე)' : 'კალენდარული დღეები'} · დადასტურება: ${ROUTE_KA[ty.route]}${ty.requires_document ? ' · დოკუმენტი სავალდებულოა' : ''}` : undefined}>
        <select id="na-t" className="select" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
      <div className="row" style={{ gap: 8 }}>
        <Field label="დან" htmlFor="na-f" required><input id="na-f" className="input" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value, to: e.target.value > f.to ? e.target.value : f.to })} /></Field>
        <Field label="მდე (ჩათვლით)" htmlFor="na-to" required><input id="na-to" className="input" type="date" value={f.to} min={f.from} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field></div>
      {ty?.requires_document && <Field label="დოკუმენტის № (ბიულეტენი, ცნობა…)" htmlFor="na-d" hint="შეიძლება მოგვიანებით — HR ნაბიჯამდე"><input id="na-d" className="input" value={f.doc} maxLength={60} onChange={(e) => setF({ ...f, doc: e.target.value })} /></Field>}
      <Field label="შენიშვნა" htmlFor="na-n"><input id="na-n" className="input" value={f.note} maxLength={1000} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
      {(b.code === 'ABSENCE_BALANCE' && refs.can.absence_hr) && <Field label="ნაშთის გადაჭარბების მიზეზი (HR)" htmlFor="na-o" required><input id="na-o" className="input" value={f.over} onChange={(e) => setF({ ...f, over: e.target.value })} /></Field>}
      <ErrorBox error={m.error} />
    </div></Modal>;
}

/** მოთხოვნის დეტალი + ქმედებები (დადასტურება / უარი / გაუქმება / თხოვნის გადაწყვეტა / ადრე დასრულება / დოკუმენტი) */
type AbsDetail = AbsenceRow & { head_at: string | null; head_note: string | null; hr_at: string | null; hr_note: string | null; head_by_name: string | null; hr_by_name: string | null; cancelled_at: string | null;
  cancelled_by_name: string | null; shortened_from: string | null; roster_applied: { deleted: string[]; cancelled: string[]; closed: string[] } | null; doc_name: string | null; route_name: string; status_name: string;
  impact: { id: string; day: string; code: string; roster_status: string; department_name: string }[]; balance: { total: number; pending: number; available: number } | null;
  can: { approve: boolean; reject: boolean; cancel: boolean; cancel_is_request: boolean; cancel_decide: boolean; shorten: boolean; edit: boolean; overdraw: boolean } };
export function AbsenceDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const inv = useInvalidate();
  const q = useQuery({ queryKey: ['roster-abs', 'one', id], queryFn: () => api<AbsDetail>(`/roster/absences/${id}`) });
  const [txt, setTxt] = useState(''); const [doc, setDoc] = useState<string | null>(null); const [to, setTo] = useState(''); const [over, setOver] = useState('');
  const done = () => { inv(); void q.refetch(); };
  const act = useMutation({ mutationFn: (a: { path: string; body: object }) => api(`/roster/absences/${id}/${a.path}`, { body: a.body }), onSuccess: () => { setTxt(''); done(); } });
  const save = useMutation({ mutationFn: () => api(`/roster/absences/${id}`, { method: 'PATCH', body: { document_no: doc } }), onSuccess: () => { setDoc(null); done(); } });
  const up = useMutation({ mutationFn: (f: File) => { const fd = new FormData(); fd.append('file', f); return apiUpload(`/roster/absences/${id}/document`, fd); }, onSuccess: done });
  const a = q.data; const b = errBody(act.error);
  return <Modal title={a ? `#${a.no} · ${a.type_name}` : 'მოთხოვნა'} width={620} onClose={onClose} footer={<button className="btn" type="button" onClick={onClose}>დახურვა</button>}>
    {q.isLoading || !a ? <><Loading /><ErrorBox error={q.error} /></> : <div className="stack">
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}><Chip m={ABS_STATUS} s={a.status} /><strong>{a.staff_name}</strong><span className="muted">{a.department_name}</span></div>
      <span>{period(a.date_from, a.date_to)} · <strong>{Number(a.days)}</strong> {a.has_balance ? 'დღე (ბალანსიდან)' : 'დღე'}{a.shortened_from ? ` · ადრე დასრულდა (იყო ${dateGe(a.shortened_from)}-მდე)` : ''}</span>
      <span className="small muted">მარშრუტი: {a.route_name}{a.head_skipped ? ' · ხელმძღვანელის ნაბიჯი გამოტოვდა (ერთადერთი ხელმძღვანელი)' : ''}{a.on_behalf ? ` · შეიტანა ${a.created_by_name ?? ''}` : ''}</span>
      {a.note && <span>„{a.note}“</span>}
      <ul className="small" style={{ margin: 0, paddingLeft: 16 }}>
        <li>შეიქმნა {tsDate(a.created_at)} {hhmm(a.created_at)}</li>
        {a.head_at && <li>ხელმძღვანელი: {a.head_by_name} · {tsDate(a.head_at)}{a.head_note ? ` · ${a.head_note}` : ''}</li>}
        {a.hr_at && <li>HR: {a.hr_by_name} · {tsDate(a.hr_at)}{a.hr_note ? ` · ${a.hr_note}` : ''}</li>}
        {a.reject_reason && <li style={{ color: 'var(--danger)' }}>უარი: {a.reject_reason}</li>}
        {a.cancelled_at && <li>გაუქმდა: {a.cancelled_by_name} · {tsDate(a.cancelled_at)}{a.cancel_reason ? ` · ${a.cancel_reason}` : ''}</li>}
        {a.cancel_requested_at && a.status === 'approved' && <li style={{ color: 'var(--warn-ink)' }}>გაუქმების თხოვნა: {a.cancel_request_note}</li>}
        {a.overdraw_reason && <li>ნაშთის გადაჭარბება: {a.overdraw_reason}</li>}
      </ul>
      {a.balance && <span className="small">ბალანსი ({a.balance_year}): ხელმისაწვდომი <strong>{a.balance.available}</strong>{a.balance.pending ? ` · განხილვაში ${a.balance.pending}` : ''}</span>}
      {a.roster_applied ? <span className="small">განრიგი: {a.roster_applied.cancelled.length ? `გაუქმდა ${a.roster_applied.cancelled.length} (→ დასაფარი)` : ''}{a.roster_applied.deleted.length ? ` · მონახაზიდან წაიშალა ${a.roster_applied.deleted.length}` : ''}
        {a.roster_applied.closed.length ? ` · დახურულ განრიგში ${a.roster_applied.closed.length} — ხელით` : ''}{!a.roster_applied.cancelled.length && !a.roster_applied.deleted.length && !a.roster_applied.closed.length ? 'ცვლები არ იყო' : ''}</span>
        : a.impact.length > 0 && (a.status === 'head' || a.status === 'hr') && <div className="alert warn small">დადასტურებისას შეეხება {a.impact.length} ცვლას: {a.impact.map((x) => `${ddmm(x.day)} ${x.code}${x.roster_status === 'published' ? ' (→ დასაფარი)' : x.roster_status === 'draft' ? ' (მონახაზი — წაიშლება)' : ' (დახურული)'}`).join(', ')}</div>}
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <span className="small">დოკუმენტი: {a.document_no ?? '—'}</span>
        {a.has_file && <button className="btn sm" type="button" onClick={() => void openBlob(`/roster/absences/${id}/document`)}>ფაილი{a.doc_name ? `: ${a.doc_name}` : ''}</button>}
        {a.can.edit && doc === null && <button className="btn sm" type="button" onClick={() => setDoc(a.document_no ?? '')}>№</button>}
        {a.can.edit && <label className="btn sm">ფაილის მიბმა<input type="file" accept="application/pdf,image/jpeg,image/png" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) up.mutate(f); }} /></label>}
        {doc !== null && <><input className="input" aria-label="დოკუმენტის №" style={{ maxWidth: 180, height: 30 }} value={doc} onChange={(e) => setDoc(e.target.value)} /><button className="btn sm primary" type="button" onClick={() => save.mutate()}>შენახვა</button></>}
      </div>
      {(a.can.approve || a.can.cancel || a.can.cancel_decide || a.can.shorten) && <Field label="შენიშვნა / მიზეზი" htmlFor="ad-t" hint="უარს, გაუქმებას, ადრე დასრულებას მიზეზი სჭირდება (მინ. 3 სიმბოლო)"><input id="ad-t" className="input" value={txt} onChange={(e) => setTxt(e.target.value)} /></Field>}
      {b.code === 'ABSENCE_BALANCE' && a.can.overdraw && <Field label="ნაშთის გადაჭარბების მიზეზი (HR)" htmlFor="ad-o"><input id="ad-o" className="input" value={over} onChange={(e) => setOver(e.target.value)} /></Field>}
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        {a.can.approve && <button className="btn primary" type="button" disabled={act.isPending} onClick={() => act.mutate({ path: 'approve', body: { ...(txt.trim() && { note: txt.trim() }), ...(over.trim() && { overdraw_reason: over.trim() }) } })}>
          დადასტურება{a.status === 'head' && a.route === 'head_hr' ? ' (→ HR)' : ''}</button>}
        {a.can.reject && <button className="btn danger" type="button" disabled={act.isPending || txt.trim().length < 3} onClick={() => act.mutate({ path: 'reject', body: { reason: txt.trim() } })}>უარი</button>}
        {a.can.cancel_decide && <><button className="btn primary" type="button" disabled={act.isPending} onClick={() => act.mutate({ path: 'cancel-decision', body: { approve: true, ...(txt.trim() && { note: txt.trim() }) } })}>გაუქმების თხოვნა — დაკმაყოფილება</button>
          <button className="btn" type="button" disabled={act.isPending} onClick={() => act.mutate({ path: 'cancel-decision', body: { approve: false, ...(txt.trim() && { note: txt.trim() }) } })}>არ დაკმაყოფილდეს</button></>}
        {a.can.cancel && <button className="btn" type="button" disabled={act.isPending || txt.trim().length < 3} onClick={() => act.mutate({ path: 'cancel', body: { reason: txt.trim() } })}>{a.can.cancel_is_request ? 'გაუქმების თხოვნა' : 'გაუქმება'}</button>}
      </div>
      {a.can.shorten && <div className="row" style={{ gap: 6 }}><span className="small">ადრე დასრულება (HR):</span>
        <input className="input" type="date" aria-label="ახალი დასასრული" style={{ maxWidth: 170, height: 32 }} min={a.date_from} max={a.date_to} value={to} onChange={(e) => setTo(e.target.value)} />
        <button className="btn sm" type="button" disabled={act.isPending || !to || to >= a.date_to || txt.trim().length < 3} onClick={() => act.mutate({ path: 'shorten', body: { date_to: to, reason: txt.trim() } })}>დასრულება</button></div>}
      <ErrorBox error={act.error ?? save.error ?? up.error} />
    </div>}
  </Modal>;
}

// ---------------------------------------------------------------- „არ შემიძლია“ / სურვილები
type PrefItem = { day: string; kind: 'unavailable' | 'prefer'; part: 'all' | 'day' | 'night'; shift_template_id: string | null; code?: string | null; note: string | null };
export function MyPrefs({ refs, staffId }: { refs: Refs; staffId?: string }) {
  const inv = useInvalidate(); const toast = useToast();
  const [month, setMonth] = useState(nextMonth(todayISO().slice(0, 7)));
  const q = useQuery({ queryKey: ['roster-prefs', staffId ?? 'me', month], queryFn: () => api<{ staff: { id: string; name: string }; items: PrefItem[]; roster_status: string; deadline: string | null; limit: number; editable: boolean; planner: boolean }>('/roster/prefs', { query: { month, staff_id: staffId } }) });
  const [items, setItems] = useState<PrefItem[]>([]);
  useEffect(() => { if (q.data) setItems(q.data.items.map((x) => ({ ...x, note: x.note ?? null }))); }, [q.data]);
  const m = useMutation({ mutationFn: () => api('/roster/prefs', { method: 'PUT', body: { month, ...(staffId && { staff_id: staffId }), items: items.map(({ code: _c, ...x }) => ({ ...x, note: x.note || null, ...(x.kind === 'unavailable' ? { shift_template_id: null } : {}) })) } }),
    onSuccess: () => { inv(); toast.show('შენახულია'); } });
  const days = useMemo(() => { const [y, mm] = month.split('-').map(Number); const n = new Date(Date.UTC(y, mm, 0)).getUTCDate(); return Array.from({ length: n }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`); }, [month]);
  const get = (d: string, k: 'unavailable' | 'prefer') => items.find((x) => x.day === d && x.kind === k);
  const toggle = (d: string, k: 'unavailable' | 'prefer') => setItems(get(d, k) ? items.filter((x) => !(x.day === d && x.kind === k)) : [...items, { day: d, kind: k, part: 'all', shift_template_id: k === 'prefer' ? refs.templates.find((t) => t.is_active)?.id ?? null : null, note: null }]);
  const upd = (d: string, k: 'unavailable' | 'prefer', p: Partial<PrefItem>) => setItems(items.map((x) => (x.day === d && x.kind === k ? { ...x, ...p } : x)));
  const un = items.filter((x) => x.kind === 'unavailable').length; const ed = !!q.data?.editable;
  const tpls = refs.templates.filter((t) => t.is_active);
  return <>
    {toast.node}
    <div className="row" style={{ flexWrap: 'wrap' }}>
      <button className="btn" type="button" aria-label="წინა თვე" onClick={() => setMonth(prevMonth(month))}>‹</button><strong>{monthLabel(month)}</strong>
      <button className="btn" type="button" aria-label="შემდეგი თვე" onClick={() => setMonth(nextMonth(month))}>›</button>
      <span className="grow" />{q.data && <span className="small muted">განრიგი: {q.data.roster_status === 'none' ? 'ჯერ არ შექმნილა' : q.data.roster_status === 'draft' ? 'მონახაზი' : 'გამოქვეყნებული'}
        {q.data.deadline ? ` · ვადა ${dateGe(q.data.deadline)}` : ''}{q.data.limit && !q.data.planner ? ` · „არ შემიძლია“ მაქს. ${q.data.limit}` : ''}</span>}
      {ed && <button className="btn primary" type="button" disabled={m.isPending || (!q.data?.planner && !!q.data?.limit && un > q.data.limit)} onClick={() => m.mutate()}>შენახვა</button>}
    </div>
    <ErrorBox error={q.error ?? m.error} />
    {q.data && !ed && <div className="alert info">რედაქტირება შეუძლებელია: {q.data.roster_status === 'published' || q.data.roster_status === 'closed' ? 'განრიგი უკვე გამოქვეყნებულია — მიმართეთ შემდგენს' : 'ვადა ამოიწურა'}.</div>}
    {q.isLoading ? <Loading /> : <div className="card"><table className="table small"><thead><tr><th>დღე</th><th>⊘ არ შემიძლია</th><th>♡ მირჩევნია</th><th>შენიშვნა</th></tr></thead>
      <tbody>{days.map((d) => { const u = get(d, 'unavailable'); const p = get(d, 'prefer'); return <tr key={d} style={{ background: dowOf(d) >= 6 ? '#fffbf2' : undefined }}>
        <td style={{ whiteSpace: 'nowrap' }}>{ddmm(d)} <span className="muted">{DOW_KA[dowOf(d)]}</span></td>
        <td><label className="row" style={{ gap: 4 }}><input type="checkbox" disabled={!ed} checked={!!u} aria-label={`არ შემიძლია ${ddmm(d)}`} onChange={() => toggle(d, 'unavailable')} />
          {u && <select className="select" aria-label="ნაწილი" style={{ height: 28, maxWidth: 150 }} disabled={!ed} value={u.part} onChange={(e) => upd(d, 'unavailable', { part: e.target.value as PrefItem['part'] })}>
            <option value="all">მთელი დღე</option><option value="day">დღის ცვლა</option><option value="night">ღამის ცვლა</option></select>}</label></td>
        <td><label className="row" style={{ gap: 4 }}><input type="checkbox" disabled={!ed} checked={!!p} aria-label={`მირჩევნია ${ddmm(d)}`} onChange={() => toggle(d, 'prefer')} />
          {p && <select className="select" aria-label="ცვლა" style={{ height: 28, maxWidth: 110 }} disabled={!ed} value={p.shift_template_id ?? ''} onChange={(e) => upd(d, 'prefer', { shift_template_id: e.target.value || null })}>
            <option value="">ნებისმიერი</option>{tpls.map((t) => <option key={t.id} value={t.id}>{t.code}</option>)}</select>}</label></td>
        <td>{(u || p) && <input className="input" aria-label={`შენიშვნა ${ddmm(d)}`} style={{ height: 28 }} disabled={!ed} maxLength={300} value={(u ?? p)!.note ?? ''} onChange={(e) => upd(d, u ? 'unavailable' : 'prefer', { note: e.target.value })} />}</td></tr>; })}</tbody></table></div>}
    <span className="hint">„არ შემიძლია“ — შემდგენი ხედავს ბადეში (⊘) და ამ დღეს ცვლის დამატებისას იღებს გაფრთხილებას; საბოლოო გადაწყვეტილება შემდგენისაა. „მირჩევნია“ — რბილი სურვილი (♡). არყოფნა (შვებულება, ბიულეტენი) — „არყოფნა / ბალანსი“.</span>
  </>;
}

// ---------------------------------------------------------------- დასაფარი (თანამშრომელი)
function MyOpen({ refs }: { refs: Refs }) {
  const inv = useInvalidate(); const toast = useToast();
  const q = useQuery({ queryKey: ['roster-open', 'mine'], queryFn: () => api<{ volunteer: boolean; items: OpenShift[] }>('/roster/open-shifts', { query: { mine: 1 } }) });
  const offer = useMutation({ mutationFn: (id: string) => api(`/roster/open-shifts/${id}/offer`, { body: {} }), onSuccess: () => { inv(); toast.show('შემდგენს ეცნობა'); } });
  const wd = useMutation({ mutationFn: (id: string) => api(`/roster/open-shifts/${id}/withdraw`, { body: {} }), onSuccess: () => { inv(); toast.show('გაუქმდა'); } });
  return <>{toast.node}<ErrorBox error={q.error ?? offer.error ?? wd.error} />
    {q.isLoading ? <Loading /> : <div className="card"><table className="table small"><thead><tr><th>დღე</th><th>ცვლა</th><th>დრო</th><th>განყოფილება</th><th>მორიგეობა</th><th>წყარო</th><th /></tr></thead>
      <tbody>{q.data?.items.map((o) => <tr key={o.id}><td style={{ whiteSpace: 'nowrap' }}>{ddmm(o.day)} <span className="muted">{DOW_KA[dowOf(o.day)]}</span></td>
        <td><span className="mono" style={{ background: o.color, color: '#fff', borderRadius: 4, padding: '1px 6px', fontWeight: 600 }}>{o.code}</span> {o.shift_name}</td>
        <td>{hhmm(o.starts_at)}–{hhmm(o.ends_at)}</td><td>{o.department_name}</td><td>{o.duty_name ? `${o.duty_level === 2 ? '☆' : '★'} ${o.duty_name}` : ''}</td><td>{SRC_KA[o.source]}{o.note ? ` · ${o.note}` : ''}</td>
        <td style={{ whiteSpace: 'nowrap' }}>{o.busy ? <span className="small muted">ამ დროს ცვლა გაქვთ</span> : o.absent ? <span className="small muted">არყოფნაში ხართ</span>
          : o.my_offer === 'offered' ? <><span className="chip ok" style={{ height: 20, fontSize: 11 }}>შეთავაზებულია</span> <button className="btn sm" type="button" onClick={() => wd.mutate(o.id)}>გაუქმება</button></>
          : q.data.volunteer && <button className="btn sm primary" type="button" disabled={offer.isPending} onClick={() => offer.mutate(o.id)}>ავიღებ</button>}</td></tr>)}
        {!q.data?.items.length && <tr><td colSpan={7} className="muted">ღია ცვლა არ არის ({refs.me?.category ? CAT_KA[refs.me.category] : 'თქვენი კატეგორია'}, თქვენი განყოფილებ(ებ)ი)</td></tr>}</tbody></table></div>}
    <span className="hint">„ავიღებ“ — შეთავაზება შემდგენს; ცვლაზე დაგნიშნავთ შემდგენი (წესების შემოწმებით) და მოგივათ შეტყობინება.</span></>;
}

// ================================================================ „დასადასტურებელი“ + არყოფნის რეესტრი (ხელმძღვანელი / HR / შემდგენი)
type Inbox = { absences: AbsenceRow[]; swaps: SwapRow[]; offers: (OpenShift & { offers: { staff_id: string; name: string; note: string | null }[] })[]; peer: SwapRow[];
  counts: { absences: number; swaps: number; offers: number; peer: number; total: number } };
export const useInbox = (on = true) => useQuery({ queryKey: ['roster-inbox'], queryFn: () => api<Inbox>('/roster/inbox'), enabled: on, refetchInterval: 120_000 });
export function ApprovalsPage({ refs }: { refs: Refs }) {
  const [sp, setSp] = useSearchParams();
  const c = refs.can;
  const manager = c.absence_all || c.absence_depts.length > 0 || c.edit_all || c.edit_depts.length > 0;
  const sub = sp.get('sub') ?? 'inbox';
  const set = (k: string) => { sp.set('sub', k); setSp(sp, { replace: true }); };
  return <div className="content">
    <div className="row" role="tablist" aria-label="დასადასტურებელი" style={{ gap: 4 }}>
      {([['inbox', 'დასადასტურებელი'], ...(manager ? [['registry', 'არყოფნის რეესტრი'], ['balances', 'ბალანსები']] : [])] as [string, string][]).map(([k, l]) =>
        <button key={k} type="button" role="tab" aria-selected={sub === k} className={`btn sm${sub === k ? ' primary' : ''}`} onClick={() => set(k)}>{l}</button>)}
    </div>
    {sub === 'registry' && manager ? <Registry refs={refs} /> : sub === 'balances' && manager ? <DeptBalances refs={refs} /> : <InboxView refs={refs} />}
  </div>;
}

function InboxView({ refs }: { refs: Refs }) {
  const q = useInbox(); const inv = useInvalidate(); const toast = useToast();
  const [abs, setAbs] = useState<string | null>(null); const [sw, setSw] = useState<SwapRow | null>(null); const [peer, setPeer] = useState<{ sw: SwapRow; accept: boolean } | null>(null);
  const [os, setOs] = useState<(Inbox['offers'])[number] | null>(null);
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBox error={q.error} />;
  const d = q.data;
  return <>
    {toast.node}
    {!d.counts.total && <div className="card empty">დასადასტურებელი არაფერია</div>}
    {d.absences.length > 0 && <section className="stack"><strong>არყოფნა ({d.absences.length})</strong><AbsTable rows={d.absences} loading={false} error={null} onOpen={setAbs} /></section>}
    {d.peer.length > 0 && <section className="stack"><strong>გაცვლის შეთავაზება თქვენთვის ({d.peer.length})</strong>
      <div className="card"><table className="table small"><tbody>{d.peer.map((s) => <tr key={s.id}><td className="mono">#{s.no}</td><td>{s.a_staff_name}</td><td className="mono">{ddmm(s.a_day)} {s.a_code}{s.b_day ? ` ↔ ${ddmm(s.b_day)} ${s.b_code}` : ''}</td>
        <td>{s.note}</td><td><button className="btn sm primary" type="button" onClick={() => setPeer({ sw: s, accept: true })}>თანხმობა</button> <button className="btn sm" type="button" onClick={() => setPeer({ sw: s, accept: false })}>უარი</button></td></tr>)}</tbody></table></div></section>}
    {d.swaps.length > 0 && <section className="stack"><strong>გაცვლა / გადაცემა — შემდგენის დადასტურება ({d.swaps.length})</strong>
      <div className="card"><table className="table small"><thead><tr><th>#</th><th>ვინ → ვის</th><th>ცვლა</th><th>განყოფილება</th><th>გაფრთხილება</th><th /></tr></thead>
        <tbody>{d.swaps.map((s) => <tr key={s.id}><td className="mono">{s.no}</td><td>{s.a_staff_name} → {s.b_staff_name}</td><td className="mono">{ddmm(s.a_day)} {s.a_code}{s.b_day ? ` ↔ ${ddmm(s.b_day)} ${s.b_code}` : ''}</td>
          <td>{s.a_department}</td><td className="small" style={{ color: 'var(--warn-ink)' }}>{s.warnings?.join('; ')}</td><td><button className="btn sm primary" type="button" onClick={() => setSw(s)}>განხილვა</button></td></tr>)}</tbody></table></div></section>}
    {d.offers.length > 0 && <section className="stack"><strong>დასაფარი — „ავიღებ“ ({d.offers.length})</strong>
      <div className="card"><table className="table small"><thead><tr><th>დღე</th><th>ცვლა</th><th>განყოფილება</th><th>მოხალისეები</th><th /></tr></thead>
        <tbody>{d.offers.map((o) => <tr key={o.id}><td>{ddmm(o.day)}</td><td className="mono">{o.code}</td><td>{o.department_name}</td><td>{o.offers.map((x) => x.name).join(', ')}</td>
          <td><button className="btn sm primary" type="button" onClick={() => setOs(o)}>დანიშვნა</button></td></tr>)}</tbody></table></div></section>}
    {abs && <AbsenceDialog id={abs} onClose={() => setAbs(null)} />}
    {sw && <HeadSwapDialog sw={sw} onClose={() => setSw(null)} onDone={(m) => { setSw(null); inv(); toast.show(m); }} />}
    {peer && <PeerDialog sw={peer.sw} accept={peer.accept} onClose={() => setPeer(null)} onDone={(m) => { setPeer(null); inv(); toast.show(m); }} />}
    {os && <OpenShiftDialog o={os} staff={os.offers.map((x) => ({ id: x.staff_id, name: x.name }))} onClose={() => setOs(null)} onDone={(m) => { setOs(null); inv(); toast.show(m); }} />}
    {(refs.can.absence_all || refs.can.absence_depts.length > 0 || refs.can.edit_all || refs.can.edit_depts.length > 0) &&
      <span className="hint">ხელმძღვანელის ნაბიჯი — {refs.can.absence_all ? 'მთელი კლინიკა' : 'თქვენი განყოფილებ(ებ)ი'}; საკუთარ მოთხოვნას / გაცვლას ვერ დაადასტურებთ.</span>}
  </>;
}

function HeadSwapDialog({ sw, onClose, onDone }: { sw: SwapRow; onClose: () => void; onDone: (m: string) => void }) {
  const [note, setNote] = useState(''); const [confirm, setConfirm] = useState(false);
  const m = useMutation({ mutationFn: (approve: boolean) => api(`/roster/swaps/${sw.id}/decide`, { body: { approve, confirm_warnings: confirm, ...(note.trim() && { note: note.trim() }) } }),
    onSuccess: (_r, approve) => onDone(approve ? 'შესრულდა' : 'უარყოფილია') });
  const w = (errBody(m.error).warnings as string[] | undefined) ?? sw.warnings ?? [];
  return <Modal title={`${sw.kind === 'swap' ? 'გაცვლა' : 'გადაცემა'} #${sw.no}`} onClose={onClose} footer={<><button className="btn danger" type="button" disabled={m.isPending || note.trim().length < 3} onClick={() => m.mutate(false)}>უარი</button>
    <span className="grow" /><button className="btn" type="button" onClick={onClose}>დახურვა</button>
    <button className="btn primary" type="button" disabled={m.isPending || (w.length > 0 && !confirm)} onClick={() => m.mutate(true)}>დადასტურება</button></>}>
    <div className="stack">
      <span>{sw.a_staff_name}: {ddmm(sw.a_day)} {sw.a_code} ({hhmm(sw.a_starts_at)}–{hhmm(sw.a_ends_at)}) → {sw.b_staff_name}</span>
      {sw.b_day && <span>{sw.b_staff_name}: {ddmm(sw.b_day)} {sw.b_code} ({hhmm(sw.b_starts_at!)}–{hhmm(sw.b_ends_at!)}) → {sw.a_staff_name}</span>}
      {sw.note && <span className="small">„{sw.note}“</span>}
      {w.length > 0 && <><div className="alert warn">{w.join('; ')}</div><label className="row"><input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /> გაფრთხილებები ვნახე</label></>}
      <Field label="შენიშვნა / უარის მიზეზი" htmlFor="hs-n"><input id="hs-n" className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <span className="hint">წესები ხელახლა მოწმდება; შესრულებისას ორივე განრიგში იწერება ისტორია და ეგზავნება შეტყობინება.</span>
      <ErrorBox error={m.error} />
    </div></Modal>;
}

/** დასაფარის დანიშვნა / გაუქმება (ბადიდან და „დასადასტურებელიდან“) */
export function OpenShiftDialog({ o, staff, onClose, onDone }: { o: OpenShift; staff: { id: string; name: string; note?: string }[]; onClose: () => void; onDone: (m: string) => void }) {
  const [sid, setSid] = useState(o.offers?.[0]?.staff_id ?? ''); const [reason, setReason] = useState('');
  const assign = useMutation({ mutationFn: () => api<{ warnings: string[] }>(`/roster/open-shifts/${o.id}/assign`, { body: { staff_id: sid, ...(reason.trim() && { reason: reason.trim() }) } }),
    onSuccess: (r) => onDone(r.warnings.length ? `დაინიშნა · ⚠ ${r.warnings[0]}` : 'დაინიშნა') });
  const cancel = useMutation({ mutationFn: () => api(`/roster/open-shifts/${o.id}/cancel`, { body: { reason: reason.trim() } }), onSuccess: () => onDone('დასაფარი გაუქმდა') });
  const vols = new Set((o.offers ?? []).map((x) => x.staff_id));
  return <Modal title={`დასაფარი · ${ddmm(o.day)} ${o.code}`} onClose={onClose} footer={<><button className="btn danger" type="button" disabled={cancel.isPending || reason.trim().length < 3} onClick={() => cancel.mutate()}>გაუქმება</button>
    <span className="grow" /><button className="btn" type="button" onClick={onClose}>დახურვა</button>
    <button className="btn primary" type="button" disabled={assign.isPending || !sid} onClick={() => assign.mutate()}>დანიშვნა</button></>}>
    <div className="stack">
      <span className="small">{hhmm(o.starts_at)}–{hhmm(o.ends_at)} · {Number(o.hours)} სთ{o.duty_name ? ` · ${o.duty_level === 2 ? '☆' : '★'} ${o.duty_name}` : ''}{o.category ? ` · ${CAT_KA[o.category]}` : ''} · {SRC_KA[o.source]}{o.note ? ` · ${o.note}` : ''}</span>
      {o.offers && o.offers.length > 0 && <span className="small">„ავიღებ“: <strong>{o.offers.map((x) => x.name).join(', ')}</strong></span>}
      <Field label="თანამშრომელი" htmlFor="os-s" required><select id="os-s" className="select" value={sid} onChange={(e) => setSid(e.target.value)}>
        <option value="">—</option>{staff.map((s) => <option key={s.id} value={s.id}>{vols.has(s.id) ? '✋ ' : ''}{s.name}</option>)}</select></Field>
      <Field label="მიზეზი (ისტორიაში) / გაუქმების მიზეზი" htmlFor="os-r"><input id="os-r" className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <ErrorBox error={assign.error ?? cancel.error} />
    </div></Modal>;
}

/** ხელით დასაფარი (გამოქვეყნებული განრიგი) */
export function NewOpenShiftDialog({ rosterId, refs, deptId, days, onClose, onDone }: { rosterId: string; refs: Refs; deptId: string; days: string[]; onClose: () => void; onDone: () => void }) {
  const tpls = refs.templates.filter((t) => t.is_active && (!t.department_ids.length || t.department_ids.includes(deptId)));
  const [f, setF] = useState({ day: days[0], tpl: tpls[0]?.id ?? '', cat: '', note: '' });
  const m = useMutation({ mutationFn: () => api(`/roster/rosters/${rosterId}/open-shifts`, { body: { day: f.day, shift_template_id: f.tpl, ...(f.cat && { category: f.cat }), ...(f.note.trim() && { note: f.note.trim() }) } }), onSuccess: onDone });
  return <Modal title="ახალი დასაფარი ცვლა" onClose={onClose} footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={m.isPending || !f.tpl} onClick={() => m.mutate()}>შექმნა</button></>}>
    <div className="stack">
      <Field label="დღე" htmlFor="no-d"><input id="no-d" className="input" type="date" min={days[0]} max={days[days.length - 1]} value={f.day} onChange={(e) => setF({ ...f, day: e.target.value })} /></Field>
      <Field label="ცვლა" htmlFor="no-t"><select id="no-t" className="select" value={f.tpl} onChange={(e) => setF({ ...f, tpl: e.target.value })}>{tpls.map((t) => <option key={t.id} value={t.id}>{t.code} — {t.name}</option>)}</select></Field>
      <Field label="კატეგორია" htmlFor="no-c" hint="ვის ეგზავნება შეტყობინება / ვინ იტყვის „ავიღებ“"><select id="no-c" className="select" value={f.cat} onChange={(e) => setF({ ...f, cat: e.target.value })}><option value="">ნებისმიერი</option>
        {Object.entries(CAT_KA).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
      <Field label="შენიშვნა" htmlFor="no-n"><input id="no-n" className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
      <ErrorBox error={m.error} />
    </div></Modal>;
}

function Registry({ refs }: { refs: Refs }) {
  const c = refs.can;
  const deps = refs.departments.filter((d) => c.absence_all || c.edit_all || c.absence_depts.includes(d.id) || c.edit_depts.includes(d.id));
  const [f, setF] = useState({ dept: deps[0]?.id ?? '', status: '', year: todayISO().slice(0, 4) });
  const [open, setOpen] = useState<string | null>(null); const [neu, setNeu] = useState(false);
  const q = useQuery({ queryKey: ['roster-abs', 'all', f], queryFn: () => api<AbsenceRow[]>('/roster/absences', { query: { scope: 'all', department_id: f.dept || undefined, status: f.status || undefined, year: f.year } }) });
  const staff = useQuery({ queryKey: ['roster-staff-min', f.dept], enabled: !!f.dept, queryFn: () => api<{ id: string; name: string }[]>('/roster/staff', { query: { department_id: f.dept } }) });
  return <>
    <div className="row" style={{ flexWrap: 'wrap' }}>
      <select className="select" aria-label="განყოფილება" style={{ maxWidth: 260, height: 36 }} value={f.dept} onChange={(e) => setF({ ...f, dept: e.target.value })}>
        {(c.absence_all || c.edit_all) && <option value="">ყველა</option>}{deps.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
      <select className="select" aria-label="სტატუსი" style={{ maxWidth: 180, height: 36 }} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
        <option value="">ყველა სტატუსი</option>{Object.entries(ABS_STATUS).map(([k, v]) => <option key={k} value={k}>{v[1]}</option>)}</select>
      <input className="input mono" aria-label="წელი" style={{ maxWidth: 90, height: 36 }} value={f.year} onChange={(e) => setF({ ...f, year: e.target.value.replace(/\D/g, '').slice(0, 4) })} />
      <span className="grow" />{f.dept && <button className="btn primary" type="button" onClick={() => setNeu(true)}>+ რეგისტრაცია თანამშრომლის მაგივრად</button>}
    </div>
    <AbsTable rows={q.data ?? []} loading={q.isLoading} error={q.error} onOpen={setOpen} />
    {open && <AbsenceDialog id={open} onClose={() => setOpen(null)} />}
    {neu && <NewAbsenceDialog refs={refs} staff={staff.data ?? []} onClose={() => setNeu(false)} />}
  </>;
}

function DeptBalances({ refs }: { refs: Refs }) {
  const c = refs.can;
  const deps = refs.departments.filter((d) => c.absence_all || c.edit_all || c.absence_depts.includes(d.id) || c.edit_depts.includes(d.id));
  const [dept, setDept] = useState(deps[0]?.id ?? ''); const [year, setYear] = useState(Number(todayISO().slice(0, 4))); const [one, setOne] = useState<{ id: string; name: string } | null>(null);
  const q = useQuery({ queryKey: ['roster-bal', 'dept', dept, year], enabled: !!dept, queryFn: () => api<{ year: number; types: (AbsenceType & { color: string })[]; staff: { id: string; name: string; items: { absence_type_id: string; total: number; used: number; pending: number; available: number }[] }[] }>('/roster/balances', { query: { department_id: dept, year } }) });
  return <>
    <div className="row"><select className="select" aria-label="განყოფილება" style={{ maxWidth: 260, height: 36 }} value={dept} onChange={(e) => setDept(e.target.value)}>{deps.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
      <select className="select" aria-label="წელი" style={{ maxWidth: 110, height: 36 }} value={year} onChange={(e) => setYear(Number(e.target.value))}>{[year - 1, year, year + 1].map((y) => <option key={y} value={y}>{y}</option>)}</select></div>
    <ErrorBox error={q.error} />
    {q.isLoading ? <Loading /> : q.data && <div className="card"><table className="table small"><thead><tr><th>თანამშრომელი</th>{q.data.types.map((t) => <th key={t.id}><TypeDot c={t.color} />{t.name} <span className="muted">(ნაშთი / გამოყ. / განხ.)</span></th>)}</tr></thead>
      <tbody>{q.data.staff.map((s) => <tr key={s.id} className="clickable" onClick={() => setOne({ id: s.id, name: s.name })}><td><strong>{s.name}</strong></td>
        {s.items.map((i) => <td key={i.absence_type_id} className="mono"><strong>{i.available}</strong> / {i.used}{i.pending ? ` / ${i.pending}` : ''}</td>)}</tr>)}
        {!q.data.staff.length && <tr><td colSpan={q.data.types.length + 1} className="muted">თანამშრომელი არ არის</td></tr>}</tbody></table></div>}
    {one && <Modal title={`${one.name} · ${year}`} width={760} onClose={() => setOne(null)} footer={<button className="btn" type="button" onClick={() => setOne(null)}>დახურვა</button>}>
      <BalanceCards staffId={one.id} year={year} canAdjust={refs.can.absence_hr} /></Modal>}
    <span className="hint">კორექცია / გადატანა / ინდივიდუალური ნორმა — HR (თანამშრომელზე დაჭერით). დარიცხვა ავტომატურია ({refs.settings.accrual === 'monthly' ? 'თვიური' : 'წლიური'}).</span>
  </>;
}

export const ApprovalsLink = ({ n }: { n: number }) => n > 0 ? <Link to="/roster?tab=approvals" className="chip warn">დასადასტურებელი: {n}</Link> : null;
