import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, can } from '../../api/client';
import type { PatientListItem } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import PatientSearch from '../../components/PatientSearch';
import { ErrorBox, Field, Loading, Modal, useDebounced } from '../../components/ui';
import { tsDate } from '../../lib/format';
import {
  ATTR_KA, DEVICE_KA, HAI_ST, IPC_FULL, SIGNAL_KA, SIGNAL_ST, SSI_KA, typeForSignal, useHaiCatalog,
  type HaiContext, type HaiDetail, type HaiRow, type PatientOp, type Rates, type SignalRow,
} from './types';

const time = (v: string) => new Date(v).toLocaleTimeString('ka-GE', { timeZone: 'Asia/Tbilisi', hour: '2-digit', minute: '2-digit', hour12: false });
const todayTb = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tbilisi' }).format(new Date());

// ================================================================ სიგნალები
export function Signals() {
  const { user } = useAuth(); const nav = useNavigate(); const qc = useQueryClient();
  const full = can(user, ...IPC_FULL);
  const [st, setSt] = useState<'open' | 'watch' | 'all'>('open');
  const [kind, setKind] = useState('');
  const [mk, setMk] = useState<SignalRow | null>(null);
  const [dis, setDis] = useState<SignalRow | null>(null);
  const q = useQuery({ queryKey: ['ipc-signals', st, kind], queryFn: () => api<SignalRow[]>('/ipc/signals', { query: { status: st === 'open' ? 'open' : st === 'watch' ? 'watch' : 'all', kind } }), refetchInterval: 60_000 });
  const inval = () => void qc.invalidateQueries({ queryKey: ['ipc-signals'] });
  const scan = useMutation({ mutationFn: () => api<{ created: number }>('/ipc/signals/scan', { body: {} }), onSuccess: inval });
  const act = useMutation({ mutationFn: (a: { id: string; what: 'watch' | 'reopen'; days?: number }) => api(`/ipc/signals/${a.id}/${a.what}`, { body: a.what === 'watch' ? { days: a.days ?? 2 } : {} }), onSuccess: inval });
  return (
    <div className="content">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <div className="seg" role="group" aria-label="სტატუსი">{([['open', 'ღია'], ['watch', 'დაკვირვება'], ['all', 'ყველა']] as const).map(([k, l]) =>
          <button key={k} type="button" aria-pressed={st === k} onClick={() => setSt(k)}>{l}</button>)}</div>
        <select className="select" style={{ maxWidth: 260, height: 38 }} aria-label="სახე" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">ყველა სახე</option>{Object.entries(SIGNAL_KA).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <span className="grow" />
        {scan.data && <span className="small muted">ახალი: {scan.data.created}</span>}
        {full && <button className="btn" type="button" disabled={scan.isPending} onClick={() => scan.mutate()}>შემოწმება ახლა</button>}
      </div>
      <span className="hint">სიგნალი მხოლოდ შეთავაზებაა (worker — ყოველ 15 წუთში). HAI შემთხვევას ხსნის ინფექციის კონტროლი; სიგნალი შეიძლება „დაკვირვებაზე“ გადავიდეს ან უარყოფილ იქნას მიზეზით.</span>
      <ErrorBox error={q.error ?? scan.error ?? act.error} />
      {q.isLoading ? <Loading /> : (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead><tr><th>სახე</th><th>პაციენტი / განყოფილება</th><th>აღწერა</th><th>მოვლენა</th><th>სტატუსი</th><th /></tr></thead>
            <tbody>{q.data?.map((s) => (
              <tr key={s.id}>
                <td><span className={`chip ${s.kind === 'cluster' ? 'danger' : 'warn'}`}>{SIGNAL_KA[s.kind]}</span></td>
                <td>{s.patient_id ? <><strong>{s.last_name} {s.first_name}</strong><div className="small muted">{s.adm_no ? <span className="mono">{s.adm_no}</span> : ''} {s.department ?? ''}</div></>
                  : <strong>{s.department}</strong>}</td>
                <td className="small">{s.summary}</td>
                <td className="small mono">{tsDate(s.event_at)} {time(s.event_at)}</td>
                <td><span className={`chip ${SIGNAL_ST[s.status][0]}`}>{SIGNAL_ST[s.status][1]}</span>
                  {s.status === 'watch' && s.watch_until && <div className="small muted">{tsDate(s.watch_until)}-მდე</div>}
                  {s.status === 'dismissed' && <div className="small muted">{s.dismiss_reason}</div>}
                  {s.case_no && <div><button type="button" className="linklike small" onClick={() => nav(`/ipc/hai/${s.case_id}`)}>{s.case_no}</button></div>}</td>
                <td><div className="row" style={{ gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  {['open', 'watch'].includes(s.status) && s.patient_id && <button className="btn sm primary" type="button" onClick={() => setMk(s)}>შემთხვევა</button>}
                  {s.status === 'open' && <button className="btn sm" type="button" onClick={() => act.mutate({ id: s.id, what: 'watch', days: 2 })} title="2 დღე">დაკვირვება</button>}
                  {['open', 'watch'].includes(s.status) && <button className="btn sm" type="button" onClick={() => setDis(s)}>უარყოფა</button>}
                  {['watch', 'dismissed'].includes(s.status) && <button className="btn sm" type="button" onClick={() => act.mutate({ id: s.id, what: 'reopen' })}>გახსნა</button>}
                </div></td>
              </tr>))}
              {!q.data?.length && <tr><td colSpan={6} className="muted">სიგნალი არ არის</td></tr>}
            </tbody>
          </table>
        </div>)}
      {mk && <CreateCase preset={{ patient: { id: mk.patient_id!, name: `${mk.last_name} ${mk.first_name}` }, encounter_id: mk.encounter_id, signal: mk,
        hai_type: typeForSignal(mk.kind, mk.data.specimen as string | undefined), onset_date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tbilisi' }).format(new Date(mk.event_at)) }}
        onClose={() => setMk(null)} onDone={(id) => nav(`/ipc/hai/${id}`)} />}
      {dis && <DismissDialog s={dis} onClose={() => setDis(null)} onDone={() => { setDis(null); inval(); }} />}
    </div>
  );
}

function DismissDialog({ s, onClose, onDone }: { s: SignalRow; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const m = useMutation({ mutationFn: () => api(`/ipc/signals/${s.id}/dismiss`, { body: { reason: reason.trim() } }), onSuccess: onDone });
  return (
    <Modal title={`სიგნალის უარყოფა — ${SIGNAL_KA[s.kind]}`} onClose={onClose} footer={<>
      <button className="btn" type="button" onClick={onClose}>გაუქმება</button>
      <button className="btn primary" type="button" disabled={m.isPending || reason.trim().length < 3} onClick={() => m.mutate()}>უარყოფა</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <ErrorBox error={m.error} /><span className="small">{s.summary}</span>
        <Field label="მიზეზი" htmlFor="sd-r" required><input id="sd-r" className="input" value={reason} maxLength={500} placeholder="მაგ. კოლონიზაცია, პროფილაქტიკა, კონტამინაცია" onChange={(e) => setReason(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

// ================================================================ HAI შემთხვევის შექმნა
export function CreateCase({ preset, onClose, onDone }: {
  preset?: { patient?: { id: string; name: string }; encounter_id?: string | null; signal?: SignalRow; hai_type?: string; onset_date?: string; or_case_id?: string | null };
  onClose: () => void; onDone: (id: string) => void;
}) {
  const qc = useQueryClient(); const cat = useHaiCatalog();
  const [patient, setPatient] = useState<{ id: string; name: string } | null>(preset?.patient ?? null);
  const sigOp = (preset?.signal?.data?.or_case_id as string | undefined) ?? null;
  const [f, setF] = useState({ hai_type: preset?.hai_type ?? 'bsi', onset_date: preset?.onset_date ?? todayTb(), ssi_depth: '', description: '', or_case_id: preset?.or_case_id ?? sigOp ?? '' });
  const ssi = f.hai_type === 'ssi';
  const ops = useQuery({ queryKey: ['ipc-patient-ops', patient?.id], queryFn: () => api<PatientOp[]>(`/ipc/ssi/patients/${patient!.id}/ops`), enabled: !!patient && ssi });
  const ctx = useQuery({ queryKey: ['ipc-hai-ctx', patient?.id, preset?.encounter_id, f.onset_date, f.hai_type, ssi ? f.or_case_id : ''],
    queryFn: () => api<HaiContext>('/ipc/hai/context', { query: { patient_id: patient!.id, encounter_id: preset?.encounter_id ?? '', onset_date: f.onset_date, hai_type: f.hai_type,
      or_case_id: ssi ? f.or_case_id : '' } }),
    enabled: !!patient && /^\d{4}-\d{2}-\d{2}$/.test(f.onset_date), retry: false });
  const m = useMutation({ mutationFn: () => api<HaiDetail>('/ipc/hai', { body: { patient_id: patient!.id, encounter_id: preset?.encounter_id ?? undefined, hai_type: f.hai_type, onset_date: f.onset_date,
    ssi_depth: ssi && f.ssi_depth ? f.ssi_depth : undefined, signal_ids: preset?.signal ? [preset.signal.id] : undefined, description: f.description.trim() || undefined,
    or_case_id: ssi && f.or_case_id ? f.or_case_id : undefined } }),
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ['ipc-signals'] }); void qc.invalidateQueries({ queryKey: ['ipc-hai'] }); onDone(r.id); } });
  const c = ctx.data;
  return (
    <Modal title="ახალი HAI შემთხვევა" onClose={onClose} width={680} footer={<>
      <button className="btn" type="button" onClick={onClose}>გაუქმება</button>
      <button className="btn primary" type="button" disabled={!patient || m.isPending || !!ctx.error} onClick={() => m.mutate()}>შექმნა (ეჭვი)</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <ErrorBox error={m.error} />
        {!patient ? <Field label="პაციენტი" htmlFor="hc-p" required><PatientSearch onSelect={(p: PatientListItem) => setPatient({ id: p.id, name: `${p.last_name} ${p.first_name}` })} autoFocus /></Field>
          : <div className="row card card-pad" style={{ padding: 10 }}><strong className="grow">{patient.name}</strong>{!preset?.patient && <button className="btn sm" type="button" onClick={() => setPatient(null)}>შეცვლა</button>}</div>}
        {preset?.signal && <div className="alert info small">სიგნალი: {SIGNAL_KA[preset.signal.kind]} — {preset.signal.summary}</div>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
          <Field label="ტიპი" htmlFor="hc-t"><select id="hc-t" className="select" value={f.hai_type} onChange={(e) => setF({ ...f, hai_type: e.target.value })}>
            {cat.data?.types.filter((t) => t.is_active).map((t) => <option key={t.code} value={t.code}>{t.short_name} — {t.name}</option>)}</select></Field>
          <Field label="ინფექციის დღე" htmlFor="hc-d"><input id="hc-d" type="date" className="input" value={f.onset_date} max={todayTb()} onChange={(e) => setF({ ...f, onset_date: e.target.value })} /></Field>
          {f.hai_type === 'ssi' && <Field label="სიღრმე" htmlFor="hc-s"><select id="hc-s" className="select" value={f.ssi_depth} onChange={(e) => setF({ ...f, ssi_depth: e.target.value })}>
            <option value="">—</option>{Object.entries(SSI_KA).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>}
        </div>
        {ssi && patient && <Field label="ოპერაცია" htmlFor="hc-o" hint="ცარიელი — ბოლო ოპერაცია, რომლის დაკვირვების ვადაშიცაა ინფექციის დღე">
          <select id="hc-o" className="select" value={f.or_case_id} onChange={(e) => setF({ ...f, or_case_id: e.target.value })}>
            <option value="">ავტომატურად</option>
            {ops.data?.map((o) => <option key={o.id} value={o.id}>{o.case_no} · {o.op_at ? tsDate(o.op_at) : '—'} · {o.procedures ?? ''}{o.category ? ` (${o.category})` : ''}</option>)}</select></Field>}
        <ErrorBox error={ctx.error} />
        {c && <ContextBox c={c} />}
        <Field label="აღწერა" htmlFor="hc-n"><textarea id="hc-n" className="textarea" rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

export function ContextBox({ c, override }: { c: HaiContext; override?: { device?: boolean; attribution?: boolean } }) {
  return (
    <div className="card card-pad stack small" style={{ gap: 4, background: 'var(--bg)' }}>
      {c.or_case_id && <div><span className="muted">ოპერაცია:</span> <Link to={`/or/case/${c.or_case_id}`} className="mono">{c.or_case_no}</Link> · {c.op_date ? tsDate(c.op_date) : '—'}
        · POD <strong>{c.pod}</strong> · დაკვირვება {c.followup_until ? `${tsDate(c.followup_until)}-მდე` : '—'}{c.post_discharge && <span className="chip warn" style={{ marginLeft: 6 }}>გაწერის შემდეგ</span>}</div>}
      <div><span className="muted">ჰოსპიტალიზაცია:</span> {c.adm_no ? <><span className="mono">{c.adm_no}</span>{c.onset_day !== null && <> · დღე <strong>{c.onset_day}</strong></>}</> : '—'}</div>
      <div><span className="muted">მიკუთვნება:</span> <strong>{c.department ?? '—'}</strong> · {ATTR_KA[c.attribution]}{c.previous_adm_no ? ` (${c.previous_adm_no})` : ''}{override?.attribution ? ' · ხელით შეცვლილია' : ''}</div>
      {c.device_kind && <div><span className="muted">მოწყობილობა:</span> {c.device_detail}
        {c.device_assoc ? <span className="chip danger" style={{ marginLeft: 6 }}>{c.device_name}</span> : <span className="chip" style={{ marginLeft: 6 }}>{c.device_name} — არა</span>}
        {override?.device && ' · ხელით შეცვლილია'}</div>}
      {c.warnings.map((w) => <div key={w.code} className="alert warn" style={{ padding: '6px 10px' }}>{w.message}</div>)}
    </div>
  );
}

// ================================================================ HAI სია
export function HaiList() {
  const nav = useNavigate(); const cat = useHaiCatalog();
  const [st, setSt] = useState<'open' | 'confirmed' | 'rejected' | 'all'>('open');
  const [type, setType] = useState(''); const [search, setSearch] = useState(''); const ds = useDebounced(search.trim(), 300);
  const [add, setAdd] = useState(false);
  const query = { status: st === 'open' ? 'suspected,review' : st === 'all' ? '' : st, hai_type: type, q: ds };
  const q = useQuery({ queryKey: ['ipc-hai', query], queryFn: () => api<HaiRow[]>('/ipc/hai', { query }) });
  return (
    <div className="content">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <div className="seg" role="group" aria-label="სტატუსი">{([['open', 'ეჭვი / განხილვა'], ['confirmed', 'დადასტურებული'], ['rejected', 'უარყოფილი'], ['all', 'ყველა']] as const).map(([k, l]) =>
          <button key={k} type="button" aria-pressed={st === k} onClick={() => setSt(k)}>{l}</button>)}</div>
        <select className="select" style={{ maxWidth: 220, height: 38 }} aria-label="ტიპი" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">ყველა ტიპი</option>{cat.data?.types.map((t) => <option key={t.code} value={t.code}>{t.short_name} — {t.name}</option>)}</select>
        <input className="input" style={{ maxWidth: 220, height: 38 }} aria-label="ძებნა" placeholder="პაციენტი, №" value={search} onChange={(e) => setSearch(e.target.value)} />
        <span className="grow" /><button className="btn primary" type="button" onClick={() => setAdd(true)}>+ შემთხვევა</button>
      </div>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead><tr><th>№ / ინფექციის დღე</th><th>პაციენტი</th><th>ტიპი</th><th>განყოფილება</th><th>მიკროორგანიზმი</th><th>სტატუსი</th></tr></thead>
            <tbody>{q.data?.map((h) => (
              <tr key={h.id} className="clickable" onClick={() => nav(`/ipc/hai/${h.id}`)}>
                <td><span className="mono">{h.case_no}</span><div className="small muted mono">{tsDate(h.onset_date)}{h.onset_day ? ` · დღე ${h.onset_day}` : ''}</div></td>
                <td><strong>{h.last_name} {h.first_name}</strong><div className="small muted mono">{h.adm_no ?? ''}</div></td>
                <td>{h.device_assoc && h.device_name ? <span className="chip danger">{h.device_name}</span> : <span className="chip">{h.short_name}</span>}
                  {h.or_case_no && <span className="small mono muted"> {h.or_case_no}</span>}{h.post_discharge && <span className="chip warn" style={{ marginLeft: 4 }}>გაწერის შემდეგ</span>}
                  {h.ssi_depth && <span className="small muted"> {SSI_KA[h.ssi_depth]}</span>}{h.device_assoc && <div className="small muted">მოწყობილობა: დღე {h.device_days}</div>}</td>
                <td className="small">{h.department ?? '—'}{h.attribution !== 'current' && <div className="muted">{ATTR_KA[h.attribution]}</div>}</td>
                <td className="small"><i>{h.organisms.join(', ') || '—'}</i></td>
                <td><span className={`chip ${HAI_ST[h.status][0]}`}>{HAI_ST[h.status][1]}</span></td>
              </tr>))}
              {!q.data?.length && <tr><td colSpan={6} className="muted">შემთხვევა არ არის</td></tr>}
            </tbody>
          </table>
        </div>)}
      {add && <CreateCase onClose={() => setAdd(false)} onDone={(id) => nav(`/ipc/hai/${id}`)} />}
    </div>
  );
}

// ================================================================ device-days / მაჩვენებლები
export function DeviceDays() {
  const { user } = useAuth(); const qc = useQueryClient();
  const t = todayTb();
  const [from, setFrom] = useState(`${t.slice(0, 8)}01`); const [to, setTo] = useState(t);
  const q = useQuery({ queryKey: ['ipc-rates', from, to], queryFn: () => api<Rates>('/ipc/device-days', { query: { from, to } }), enabled: from <= to });
  const ref = useMutation({ mutationFn: () => api('/ipc/device-days/refresh', { body: { from, to } }), onSuccess: () => void qc.invalidateQueries({ queryKey: ['ipc-rates'] }) });
  const n = (v: number | null | undefined, d = 1) => (v === null || v === undefined ? '—' : v.toLocaleString('ka-GE', { maximumFractionDigits: d }));
  const r = q.data;
  const rowCells = (x: Rates['total']) => <>
    <td className="mono">{x.patient_days}</td>
    <td className="mono">{x.cl}<div className="small muted">DUR {n(x.dur_cl, 3)}</div></td><td className="mono">{x.clabsi}<div className="small muted">{n(x.clabsi_rate, 2)}</div></td>
    <td className="mono">{x.uc}<div className="small muted">DUR {n(x.dur_uc, 3)}</div></td><td className="mono">{x.cauti}<div className="small muted">{n(x.cauti_rate, 2)}</div></td>
    <td className="mono">{x.vent}<div className="small muted">DUR {n(x.dur_vent, 3)}</div></td><td className="mono">{x.vap}<div className="small muted">{n(x.vap_rate, 2)}</div></td>
    <td className="mono">{x.hai}<div className="small muted">{n(x.hai_rate, 2)}</div></td></>;
  return (
    <div className="content">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <input className="input" type="date" style={{ maxWidth: 160, height: 38 }} aria-label="დან" value={from} onChange={(e) => setFrom(e.target.value)} />
        <input className="input" type="date" style={{ maxWidth: 160, height: 38 }} aria-label="მდე" value={to} max={t} onChange={(e) => setTo(e.target.value)} />
        <span className="grow" />
        {r && <span className="small muted">დათვლა: {r.basis === 'census' ? 'ფიქსირებულ საათზე' : 'კალენდარული დღე'} · განახლდა {r.computed_at ? `${tsDate(r.computed_at)} ${time(r.computed_at)}` : '—'}</span>}
        {can(user, ...IPC_FULL) && <button className="btn" type="button" disabled={ref.isPending} onClick={() => ref.mutate()}>გადათვლა</button>}
      </div>
      <span className="hint">მრიცხველი — დადასტურებული HAI (ინფექციის დღით, მიკუთვნებული განყოფილებით); მაჩვენებელი — 1000 device-day-ზე (CLABSI / CAUTI / VAP) და 1000 პაციენტ-დღეზე (სულ HAI). DUR — device-days / პაციენტ-დღე. სრული ანგარიშები და KPI — მომდევნო ეტაპზე.</span>
      <ErrorBox error={q.error ?? ref.error} />
      {q.isLoading ? <Loading /> : r && (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead><tr><th>განყოფილება</th><th>პაციენტ-დღე</th><th>ცენტრ. ხაზის დღე</th><th>CLABSI / 1000</th><th>კათეტერის დღე</th><th>CAUTI / 1000</th><th>ვენტ. დღე</th><th>VAP / 1000</th><th>HAI / 1000 პ-დ</th></tr></thead>
            <tbody>{r.rows.map((x) => <tr key={x.department_id}><td>{x.department}</td>{rowCells(x)}</tr>)}
              {!r.rows.length && <tr><td colSpan={9} className="muted">მონაცემი არ არის (გადათვლა)</td></tr>}</tbody>
            {r.rows.length > 1 && <tfoot><tr><th>სულ</th>{rowCells(r.total)}</tr></tfoot>}
          </table>
        </div>)}
      <span className="small muted">ცენტრალური ხაზი: {r?.central_line_kinds.map((k) => ({ cvc: 'CVC', picc: 'PICC', dialysis: 'დიალიზის კათეტერი', arterial: 'არტერიული' }[k] ?? k)).join(', ')} · {Object.values(DEVICE_KA).join(' / ')}</span>
    </div>
  );
}

// ================================================================ სტაციონარი: HAI (განხილვაში / დადასტურებული)
interface StayHaiRow { id: string; case_no: string; status: string; status_ka: string; onset_date: string; label: string }
export function StayHai({ encounterId }: { encounterId: string }) {
  const { user } = useAuth();
  const q = useQuery({ queryKey: ['ipc-stay-hai', encounterId], queryFn: () => api<StayHaiRow[]>(`/ipc/stays/${encounterId}/hai`).catch(() => [] as StayHaiRow[]), staleTime: 60_000 });
  if (!q.data?.length) return null;
  const link = can(user, 'infection', 'infection_dept');
  return (
    <section className="card card-pad stack" style={{ gap: 6 }} aria-label="ჰოსპიტალური ინფექცია">
      <h2 style={{ margin: 0 }}>ჰოსპიტალური ინფექცია (HAI)</h2>
      {q.data.map((h) => <div key={h.id} className="row small" style={{ gap: 8 }}>
        <span className={`chip ${HAI_ST[h.status]?.[0] ?? ''}`}>{h.label}</span>
        {link ? <Link to={`/ipc/hai/${h.id}`} className="mono">{h.case_no}</Link> : <span className="mono">{h.case_no}</span>}
        <span className="muted">{tsDate(h.onset_date)} · {h.status_ka}</span></div>)}
    </section>
  );
}
