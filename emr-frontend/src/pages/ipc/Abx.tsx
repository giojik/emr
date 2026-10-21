import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, can } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Field, Loading, Modal, useDebounced } from '../../components/ui';
import { tsDate } from '../../lib/format';
import { ABX_IND_KA, AWARE_KA, AbxReviewDialog, type Order } from '../inpatient/Orders';
import { IPC_FULL } from './types';

const todayTb = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tbilisi' }).format(new Date());
const dt = (v: string | null) => (v ? `${tsDate(v)} ${new Date(v).toLocaleTimeString('ka-GE', { timeZone: 'Asia/Tbilisi', hour: '2-digit', minute: '2-digit', hour12: false })}` : '—');
const APPR: Record<string, [string, string]> = { pending: ['warn', 'დასამტკიცებელი'], approved: ['ok', 'დამტკიცებული'], rejected: ['danger', 'უარყოფილი'] };
const DEC_KA: Record<string, string> = { continue: 'გაგრძელება', deescalate: 'დე-ესკალაცია', iv_to_po: 'IV → per os', stop: 'შეწყვეტა' };

interface AbxOrder {
  id: string; encounter_id: string; patient_id: string; first_name: string; last_name: string; adm_no: string; inn: string; strength: string | null; atc_code: string | null;
  aware: string | null; reserve_antibiotic: boolean; dose: string | null; dose_unit: string | null; route_code: string | null; route_name: string | null; frequency_name: string | null;
  order_type: string; start_at: string; end_at: string | null; duration_days: number | null; status: string; verify_status: string; approval_status: string;
  abx_indication: string | null; abx_icd10: string | null; abx_icd10_title: string | null; abx_review_due: string | null; abx_reviewed_at: string | null; abx_review_decision: string | null;
  abx_review_note: string | null; ordered_by_name: string; reviewed_by_name: string | null; dot_day: number; department_id: string | null; department: string | null;
  restricted: boolean; timeout_overdue: boolean;
}
interface Agg { doses: number; ddd: number; dot: number; missing_ddd: number }
interface AbxRates {
  from: string; to: string; prefixes: string[]; access_target: number; patient_days: number;
  total: Agg & { ddd_per_100: number | null; dot_per_1000: number | null };
  aware: (Agg & { aware: string; ddd_pct: number | null; dot_pct: number | null })[];
  agents: (Agg & { key: string; inn: string; atc_code: string | null; aware: string | null; parenteral_pct: number; ddd_per_100: number | null; dot_per_1000: number | null })[];
  departments: (Agg & { department_id: string; department: string; patient_days: number; ddd_per_100: number | null; dot_per_1000: number | null; access_pct: number | null })[];
  orders: { total: number; indication: Record<string, number>; restricted: { total: number; pending: number; approved: number; rejected: number; median_hours: number | null };
    timeout: { due: number; reviewed: number; on_time: number; overdue: number; on_time_pct: number | null; decisions: Record<string, number> } };
}
interface RefRow { atc_code: string; name: string; ddd_oral: string | null; ddd_parenteral: string | null; ddd_unit: string; aware_oral: string | null; aware_parenteral: string | null }
interface RefResp { reference: RefRow[]; generics: { id: string; inn: string; strength: string | null; atc_code: string; form_code: string; ddd_oral: string | null; ddd_parenteral: string | null;
  ddd_unit: string | null; aware: string | null; reserve_antibiotic: boolean; in_reference: boolean; missing: boolean }[] }

const Aw = ({ a }: { a: string | null }) => (a && AWARE_KA[a] ? <span className={`chip ${AWARE_KA[a][0]}`}>{AWARE_KA[a][1]}</span> : <span className="chip">—</span>);

/** ანტიბიოტიკები (0070): აქტიური დანიშნულებები (შეზღუდული / დასამტკიცებელი / time-out), მაჩვენებლები, DDD / AWaRe ცნობარი */
export default function AbxTab() {
  const [view, setView] = useState<'orders' | 'rates' | 'ref'>('orders');
  return (
    <div className="content">
      <div className="seg" role="group" aria-label="ანტიბიოტიკები">
        {([['orders', 'დანიშნულებები'], ['rates', 'მაჩვენებლები'], ['ref', 'DDD / AWaRe']] as const).map(([k, l]) =>
          <button key={k} type="button" aria-pressed={view === k} onClick={() => setView(k)}>{l}</button>)}
      </div>
      {view === 'orders' && <Orders />}
      {view === 'rates' && <Rates />}
      {view === 'ref' && <Reference />}
    </div>
  );
}

function Orders() {
  const { user } = useAuth(); const qc = useQueryClient();
  const [v, setV] = useState<'active' | 'restricted' | 'pending' | 'timeout'>('active');
  const [search, setSearch] = useState(''); const ds = useDebounced(search.trim(), 300);
  const [rej, setRej] = useState<AbxOrder | null>(null); const [review, setReview] = useState<AbxOrder | null>(null);
  const q = useQuery({ queryKey: ['ipc-abx-orders', v, ds], queryFn: () => api<AbxOrder[]>('/ipc/abx/orders', { query: { view: v === 'active' ? '' : v, q: ds } }), refetchInterval: 60_000 });
  const inval = () => void qc.invalidateQueries({ queryKey: ['ipc-abx-orders'] });
  const appr = useMutation({ mutationFn: (id: string) => api(`/inpatient/orders/${id}/approve`, { body: {} }), onSuccess: inval });
  const full = can(user, ...IPC_FULL);
  return (
    <>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <div className="seg" role="group" aria-label="ფილტრი">{([['active', 'ყველა აქტიური'], ['restricted', 'შეზღუდული'], ['pending', 'დასამტკიცებელი'], ['timeout', 'გადასახედი (time-out)']] as const).map(([k, l]) =>
          <button key={k} type="button" aria-pressed={v === k} onClick={() => setV(k)}>{l}</button>)}</div>
        <input className="input" style={{ maxWidth: 240, height: 38 }} aria-label="ძებნა" placeholder="პაციენტი, INN, IP №" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <span className="hint">ანტიმიკრობული დანიშნულებები სტაციონარში (ATC: მოდულის პარამეტრი). დღე — თერაპიის დღე (დაწყება = 1). დამტკიცება / გადახედვა — ინფექციის კონტროლი (პარამეტრის მიხედვით).</span>
      <ErrorBox error={q.error ?? appr.error} />
      {q.isLoading ? <Loading /> : (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead><tr><th>პაციენტი</th><th>ანტიბიოტიკი</th><th>ჩვენება</th><th>დღე</th><th>დამტკიცება</th><th>გადახედვა</th><th /></tr></thead>
            <tbody>{q.data?.map((o) => (
              <tr key={o.id}>
                <td><Link to={`/inpatient/stay/${o.encounter_id}?tab=orders`}><strong>{o.last_name} {o.first_name}</strong></Link><div className="small muted"><span className="mono">{o.adm_no}</span> · {o.department ?? '—'}</div></td>
                <td><strong>{o.inn}</strong>{o.strength ? ` ${o.strength}` : ''} <Aw a={o.aware} />
                  <div className="small muted">{[o.dose ? `${Number(o.dose)} ${o.dose_unit ?? ''}` : null, o.route_code, o.frequency_name, o.duration_days ? `${o.duration_days} დღე` : null].filter(Boolean).join(' · ')}</div>
                  <div className="small muted">{o.ordered_by_name}</div></td>
                <td className="small">{o.abx_indication ? ABX_IND_KA[o.abx_indication] : <span className="muted">—</span>}{o.abx_icd10 && <div className="mono">{o.abx_icd10} <span className="muted">{o.abx_icd10_title?.slice(0, 40)}</span></div>}</td>
                <td className="mono">{o.dot_day}</td>
                <td>{o.restricted ? <span className={`chip ${APPR[o.approval_status]?.[0] ?? ''}`}>{APPR[o.approval_status]?.[1] ?? o.approval_status}</span> : <span className="muted small">—</span>}</td>
                <td className="small">{o.abx_review_decision ? <><span className="chip info">{DEC_KA[o.abx_review_decision]}</span><div className="muted">{o.reviewed_by_name} · {dt(o.abx_reviewed_at)}</div></>
                  : o.timeout_overdue ? <span className="chip danger">ვადაგასულია ({dt(o.abx_review_due)})</span> : o.abx_review_due ? <span className="muted">{dt(o.abx_review_due)}</span> : '—'}</td>
                <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                  {o.approval_status === 'pending' && <><button className="btn sm primary" type="button" disabled={appr.isPending} onClick={() => appr.mutate(o.id)}>დამტკიცება</button>{' '}
                    <button className="btn sm" type="button" onClick={() => setRej(o)}>უარი</button>{' '}</>}
                  {full && !o.abx_review_decision && o.abx_review_due && <button className="btn sm" type="button" onClick={() => setReview(o)}>გადახედვა</button>}
                </td>
              </tr>))}
              {!q.data?.length && <tr><td colSpan={7} className="muted">დანიშნულება არ არის</td></tr>}
            </tbody>
          </table>
        </div>)}
      {rej && <RejectDialog o={rej} onClose={() => setRej(null)} onDone={() => { setRej(null); inval(); }} />}
      {review && <AbxReviewDialog o={{ ...review, title: review.inn } as unknown as Order} onClose={() => setReview(null)} onDone={() => { setReview(null); inval(); }} />}
    </>
  );
}

function RejectDialog({ o, onClose, onDone }: { o: AbxOrder; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState('');
  const m = useMutation({ mutationFn: () => api(`/inpatient/orders/${o.id}/approve-reject`, { body: { note: note.trim() } }), onSuccess: onDone });
  return (
    <Modal title={`შეზღუდული ანტიბიოტიკი — უარი: ${o.inn}`} onClose={onClose} footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button>
      <button className="btn primary" type="button" disabled={m.isPending || note.trim().length < 3} onClick={() => m.mutate()}>უარი (დანიშნულება შეწყდება)</button></>}>
      <div className="stack" style={{ gap: 10 }}><ErrorBox error={m.error} />
        <Field label="მიზეზი / რეკომენდაცია" htmlFor="ar-r" required><input id="ar-r" className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="მაგ. კულტურით მგრძნობიარეა ცეფტრიაქსონზე" /></Field></div>
    </Modal>
  );
}

function Rates() {
  const t = todayTb();
  const [from, setFrom] = useState(`${t.slice(0, 8)}01`); const [to, setTo] = useState(t);
  const q = useQuery({ queryKey: ['ipc-abx-rates', from, to], queryFn: () => api<AbxRates>('/ipc/abx/rates', { query: { from, to } }), enabled: from <= to });
  const n = (v: number | null | undefined, d = 2) => (v === null || v === undefined ? '—' : v.toLocaleString('ka-GE', { maximumFractionDigits: d }));
  const r = q.data;
  const acc = r?.aware.find((a) => a.aware === 'access');
  return (
    <>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <input className="input" type="date" style={{ maxWidth: 160, height: 38 }} aria-label="დან" value={from} onChange={(e) => setFrom(e.target.value)} />
        <input className="input" type="date" style={{ maxWidth: 160, height: 38 }} aria-label="მდე" value={to} max={t} onChange={(e) => setTo(e.target.value)} />
      </div>
      <span className="hint">MAR-იდან (მიცემული დოზები). DDD — WHO ATC/DDD (გზის მიხედვით); DOT — პაციენტი × აგენტი × დღე. პაციენტ-დღე — device-days ფაქტიდან („მაჩვენებლები“ → „გადათვლა“).</span>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : r && <>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          {[['DDD / 100 პაციენტ-დღე', n(r.total.ddd_per_100)], ['DOT / 1000 პაციენტ-დღე', n(r.total.dot_per_1000, 1)], ['პაციენტ-დღე', n(r.patient_days, 0)],
            ['Access (DDD)', acc?.ddd_pct !== null && acc?.ddd_pct !== undefined ? `${n(acc.ddd_pct, 1)}%` : '—'], ['DDD აკლია (დოზა)', n(r.total.missing_ddd, 0)]].map(([l, v]) => (
            <div key={l} className="card card-pad" style={{ minWidth: 180 }}><div className="small muted">{l}</div><div style={{ fontSize: 24, fontWeight: 700 }}>{v}</div>
              {l === 'Access (DDD)' && <div className="small muted">მიზანი ≥ {r.access_target}%</div>}</div>))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 14, flexShrink: 0 }}>
          <section className="card card-pad stack" style={{ gap: 6 }}>
            <h2 style={{ margin: 0 }}>AWaRe</h2>
            <table className="table small"><thead><tr><th>ჯგუფი</th><th>DDD</th><th>%</th><th>DOT</th><th>%</th></tr></thead>
              <tbody>{r.aware.filter((a) => a.doses > 0).map((a) => <tr key={a.aware}><td>{a.aware === 'unclassified' ? 'კლასიფიკაციის გარეშე' : <Aw a={a.aware} />}</td>
                <td className="mono">{n(a.ddd)}</td><td className="mono">{a.ddd_pct !== null ? `${n(a.ddd_pct, 1)}%` : '—'}</td><td className="mono">{a.dot}</td><td className="mono">{a.dot_pct !== null ? `${n(a.dot_pct, 1)}%` : '—'}</td></tr>)}
                {!r.aware.some((a) => a.doses > 0) && <tr><td colSpan={5} className="muted">მონაცემი არ არის</td></tr>}</tbody></table>
          </section>
          <section className="card card-pad stack small" style={{ gap: 4 }}>
            <h2 style={{ margin: 0 }}>დანიშნულებები ({r.orders.total})</h2>
            <div>ჩვენება: {Object.entries(ABX_IND_KA).map(([k, l]) => `${l} ${r.orders.indication[k] ?? 0}`).join(' · ')} · მითითების გარეშე {r.orders.indication.none}</div>
            <div>შეზღუდული: {r.orders.restricted.total} — დამტკიცდა {r.orders.restricted.approved}, უარი {r.orders.restricted.rejected}, მოლოდინში {r.orders.restricted.pending}
              {r.orders.restricted.median_hours !== null && ` · მედიანა ${n(r.orders.restricted.median_hours, 1)} სთ`}</div>
            <div>Time-out: ვადა დადგა {r.orders.timeout.due}, გადაიხედა {r.orders.timeout.reviewed} (დროულად {r.orders.timeout.on_time}{r.orders.timeout.on_time_pct !== null ? `, ${n(r.orders.timeout.on_time_pct, 1)}%` : ''}),
              ვადაგასული ახლა {r.orders.timeout.overdue}</div>
            <div>გადაწყვეტილება: {Object.entries(DEC_KA).map(([k, l]) => `${l} ${r.orders.timeout.decisions[k] ?? 0}`).join(' · ')}</div>
          </section>
        </div>
        <section className="card" style={{ overflowX: 'auto', flexShrink: 0 }}>
          <table className="table">
            <thead><tr><th>აგენტი</th><th>AWaRe</th><th>დოზა</th><th>DDD</th><th>DDD / 100</th><th>DOT</th><th>DOT / 1000</th><th>IV %</th></tr></thead>
            <tbody>{r.agents.map((a) => <tr key={a.key}><td><strong>{a.inn}</strong> <span className="mono small muted">{a.atc_code}</span>{a.missing_ddd > 0 && <div className="small" style={{ color: 'var(--danger-ink)' }}>DDD აკლია: {a.missing_ddd} დოზა</div>}</td>
              <td><Aw a={a.aware} /></td><td className="mono">{a.doses}</td><td className="mono">{n(a.ddd)}</td><td className="mono">{n(a.ddd_per_100)}</td><td className="mono">{a.dot}</td><td className="mono">{n(a.dot_per_1000, 1)}</td><td className="mono">{n(a.parenteral_pct, 0)}</td></tr>)}
              {!r.agents.length && <tr><td colSpan={8} className="muted">მიცემული დოზა არ არის</td></tr>}</tbody>
          </table>
        </section>
        <section className="card" style={{ overflowX: 'auto', flexShrink: 0 }}>
          <table className="table">
            <thead><tr><th>განყოფილება</th><th>პაციენტ-დღე</th><th>DDD / 100</th><th>DOT / 1000</th><th>Access %</th></tr></thead>
            <tbody>{r.departments.map((d) => <tr key={d.department_id}><td>{d.department}</td><td className="mono">{d.patient_days}</td><td className="mono">{n(d.ddd_per_100)}</td>
              <td className="mono">{n(d.dot_per_1000, 1)}</td><td className="mono">{d.access_pct !== null ? <span style={{ color: d.access_pct < r.access_target ? 'var(--danger-ink)' : undefined }}>{n(d.access_pct, 1)}%</span> : '—'}</td></tr>)}
              {!r.departments.length && <tr><td colSpan={5} className="muted">მონაცემი არ არის</td></tr>}</tbody>
          </table>
        </section>
      </>}
    </>
  );
}

function Reference() {
  const { user } = useAuth(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['ipc-abx-ref'], queryFn: () => api<RefResp>('/ipc/abx/reference') });
  const [edit, setEdit] = useState<RefRow | null>(null);
  const apply = useMutation({ mutationFn: () => api<{ updated: number }>('/ipc/abx/reference/apply', { body: {} }), onSuccess: () => void qc.invalidateQueries({ queryKey: ['ipc-abx-ref'] }) });
  const full = can(user, ...IPC_FULL); const canApply = can(user, 'infection', 'pharmacist', 'admin');
  const r = q.data;
  const miss = r?.generics.filter((g) => g.missing) ?? [];
  return (
    <>
      <ErrorBox error={q.error ?? apply.error} />
      {q.isLoading ? <Loading /> : r && <>
        <section className="card card-pad stack" style={{ gap: 8 }}>
          <div className="row"><h2 style={{ margin: 0 }} className="grow">ჯენერიკები — DDD / AWaRe ({r.generics.length})</h2>
            {apply.data && <span className="small muted">შეივსო: {apply.data.updated}</span>}
            {canApply && <button className="btn sm" type="button" disabled={apply.isPending} onClick={() => apply.mutate()}>საცნობაროდან შევსება (ცარიელი ველები)</button>}</div>
          <span className="hint">ჯენერიკის DDD / AWaRe-ს ასწორებს ფარმაცევტი (საწყობი → ჯენერიკები). შეზღუდულია: „სარეზერვო“ დროშა ან AWaRe Reserve (პარამეტრი).</span>
          {miss.length > 0 && <div className="alert warn small">DDD ან AWaRe აკლია: {miss.map((g) => `${g.inn}${g.strength ? ` ${g.strength}` : ''} (${g.atc_code})`).join(', ')}</div>}
          <table className="table small"><thead><tr><th>ჯენერიკი</th><th>ATC</th><th>DDD per os</th><th>DDD პარ.</th><th>AWaRe</th><th /></tr></thead>
            <tbody>{r.generics.map((g) => <tr key={g.id}><td>{g.inn}{g.strength ? ` ${g.strength}` : ''} <span className="muted">{g.form_code}</span></td><td className="mono">{g.atc_code}</td>
              <td className="mono">{g.ddd_oral ? `${Number(g.ddd_oral)} ${g.ddd_unit}` : '—'}</td><td className="mono">{g.ddd_parenteral ? `${Number(g.ddd_parenteral)} ${g.ddd_unit}` : '—'}</td>
              <td><Aw a={g.aware} /></td><td>{g.reserve_antibiotic && <span className="chip warn">სარეზერვო</span>}</td></tr>)}
              {!r.generics.length && <tr><td colSpan={6} className="muted">ანტიმიკრობული ჯენერიკი არ არის</td></tr>}</tbody></table>
        </section>
        <section className="card card-pad stack" style={{ gap: 8 }}>
          <h2 style={{ margin: 0 }}>საცნობარო ცხრილი (WHO ATC/DDD, AWaRe)</h2>
          <span className="hint">ორიენტირებისთვის — გადაამოწმეთ WHO-ს მოქმედ ინდექსთან (whocc.no, AWaRe). ჯენერიკზე გადაიტანება მხოლოდ ცარიელ ველებზე.</span>
          <table className="table small"><thead><tr><th>ATC</th><th>დასახელება</th><th>DDD per os</th><th>DDD პარ.</th><th>AWaRe (per os / პარ.)</th><th /></tr></thead>
            <tbody>{r.reference.map((x) => <tr key={x.atc_code}><td className="mono">{x.atc_code}</td><td>{x.name}</td>
              <td className="mono">{x.ddd_oral ? `${Number(x.ddd_oral)} ${x.ddd_unit}` : '—'}</td><td className="mono">{x.ddd_parenteral ? `${Number(x.ddd_parenteral)} ${x.ddd_unit}` : '—'}</td>
              <td><Aw a={x.aware_oral} /> / <Aw a={x.aware_parenteral} /></td>
              <td>{full && <button className="btn sm" type="button" onClick={() => setEdit(x)}>შეცვლა</button>}</td></tr>)}</tbody></table>
        </section>
      </>}
      {edit && <RefDialog x={edit} onClose={() => setEdit(null)} />}
    </>
  );
}

function RefDialog({ x, onClose }: { x: RefRow; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ name: x.name, ddd_oral: x.ddd_oral ? String(Number(x.ddd_oral)) : '', ddd_parenteral: x.ddd_parenteral ? String(Number(x.ddd_parenteral)) : '', ddd_unit: x.ddd_unit,
    aware_oral: x.aware_oral ?? '', aware_parenteral: x.aware_parenteral ?? '' });
  const num = (v: string) => (v.trim() ? Number(v.replace(',', '.')) : null);
  const m = useMutation({ mutationFn: () => api(`/ipc/abx/reference/${x.atc_code}`, { method: 'PATCH', body: { name: f.name.trim(), ddd_oral: num(f.ddd_oral), ddd_parenteral: num(f.ddd_parenteral),
      ddd_unit: f.ddd_unit, aware_oral: f.aware_oral || null, aware_parenteral: f.aware_parenteral || null } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['ipc-abx-ref'] }); onClose(); } });
  const aw = (k: 'aware_oral' | 'aware_parenteral', l: string) => <Field label={l} htmlFor={`rf-${k}`}><select id={`rf-${k}`} className="select" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })}>
    <option value="">—</option>{Object.entries(AWARE_KA).map(([kk, [, ll]]) => <option key={kk} value={kk}>{ll}</option>)}</select></Field>;
  return (
    <Modal title={`${x.atc_code} — ${x.name}`} onClose={onClose} footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button>
      <button className="btn primary" type="button" disabled={m.isPending || (!f.ddd_oral && !f.ddd_parenteral)} onClick={() => m.mutate()}>შენახვა</button></>}>
      <div className="stack" style={{ gap: 10 }}><ErrorBox error={m.error} />
        <Field label="დასახელება" htmlFor="rf-n"><input id="rf-n" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
          <Field label="DDD per os" htmlFor="rf-o"><input id="rf-o" className="input mono" value={f.ddd_oral} onChange={(e) => setF({ ...f, ddd_oral: e.target.value })} /></Field>
          <Field label="DDD პარენტ." htmlFor="rf-p"><input id="rf-p" className="input mono" value={f.ddd_parenteral} onChange={(e) => setF({ ...f, ddd_parenteral: e.target.value })} /></Field>
          <Field label="ერთეული" htmlFor="rf-u"><select id="rf-u" className="select" value={f.ddd_unit} onChange={(e) => setF({ ...f, ddd_unit: e.target.value })}><option value="g">g</option><option value="mg">mg</option><option value="MU">MU</option></select></Field>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>{aw('aware_oral', 'AWaRe per os')}{aw('aware_parenteral', 'AWaRe პარენტერალური')}</div>
      </div>
    </Modal>
  );
}
