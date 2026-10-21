import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, can } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Field, Loading, Modal, useDebounced } from '../../components/ui';
import { tsDate } from '../../lib/format';
import { CreateCase } from './Surveillance';
import {
  FU_Q, FU_ST, HAI_ST, IPC_FULL, PROPH_KA, SSI_KA, SSI_OP_ST, WOUND_KA, useSsiCatalog,
  type SsiFollowup, type SsiOp, type SsiOpDetail, type SsiRateRow, type SsiRates,
} from './types';

const todayTb = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tbilisi' }).format(new Date());
const shift = (d: string, days: number) => new Date(new Date(d).getTime() + days * 86400000).toISOString().slice(0, 10);
const hm = (v: string | null) => (v ? new Date(v).toLocaleTimeString('ka-GE', { timeZone: 'Asia/Tbilisi', hour: '2-digit', minute: '2-digit', hour12: false }) : '');

/** SSI (0069): ოპერაციები ზედამხედველობაში, გაწერის შემდგომი კონტაქტი, მაჩვენებლები */
export default function SsiTab() {
  const [view, setView] = useState<'ops' | 'calls' | 'rates'>('ops');
  const due = useQuery({ queryKey: ['ipc-ssi-fu', 'pending', 'now'], queryFn: () => api<SsiFollowup[]>('/ipc/ssi/followups', { query: { status: 'pending', due: 'now' } }), refetchInterval: 5 * 60_000 });
  return (
    <div className="content">
      <div className="seg" role="group" aria-label="SSI">
        {([['ops', 'ოპერაციები'], ['calls', 'გაწერის შემდგომი კონტაქტი'], ['rates', 'მაჩვენებლები']] as const).map(([k, l]) =>
          <button key={k} type="button" aria-pressed={view === k} onClick={() => setView(k)}>{l}{k === 'calls' && (due.data?.length ?? 0) > 0 && <span className="chip warn" style={{ marginLeft: 6, height: 18 }}>{due.data!.length}</span>}</button>)}
      </div>
      {view === 'ops' && <Ops />}
      {view === 'calls' && <Calls />}
      {view === 'rates' && <SsiRatesView />}
    </div>
  );
}

// ================================================================ ოპერაციები
function Ops() {
  const { user } = useAuth(); const qc = useQueryClient(); const cat = useSsiCatalog();
  const t = todayTb();
  const [from, setFrom] = useState(shift(t, -90)); const [to, setTo] = useState(t);
  const [category, setCategory] = useState(''); const [status, setStatus] = useState('');
  const [search, setSearch] = useState(''); const ds = useDebounced(search.trim(), 300);
  const [open, setOpen] = useState<string | null>(null);
  const query = { from, to, category, status, q: ds };
  const q = useQuery({ queryKey: ['ipc-ssi-ops', query], queryFn: () => api<SsiOp[]>('/ipc/ssi/ops', { query }) });
  const ref = useMutation({ mutationFn: () => api<{ ops: number; followups: number }>('/ipc/ssi/refresh', { body: { days: 365 } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['ipc-ssi-ops'] }) });
  return (
    <>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <input className="input" type="date" style={{ maxWidth: 160, height: 38 }} aria-label="დან" value={from} onChange={(e) => setFrom(e.target.value)} />
        <input className="input" type="date" style={{ maxWidth: 160, height: 38 }} aria-label="მდე" value={to} max={t} onChange={(e) => setTo(e.target.value)} />
        <select className="select" style={{ maxWidth: 240, height: 38 }} aria-label="კატეგორია" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">ყველა კატეგორია</option>{cat.data?.categories.map((k) => <option key={k.code} value={k.code}>{k.code} — {k.name}</option>)}</select>
        <select className="select" style={{ maxWidth: 200, height: 38 }} aria-label="სტატუსი" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">ყველა სტატუსი</option>{Object.entries(SSI_OP_ST).map(([k, [, l]]) => <option key={k} value={k}>{l}</option>)}</select>
        <input className="input" style={{ maxWidth: 200, height: 38 }} aria-label="ძებნა" placeholder="პაციენტი, OR №" value={search} onChange={(e) => setSearch(e.target.value)} />
        <span className="grow" />
        {ref.data && <span className="small muted">განახლდა: {ref.data.ops}</span>}
        {can(user, ...IPC_FULL) && <button className="btn" type="button" disabled={ref.isPending} onClick={() => ref.mutate()}>გადათვლა</button>}
      </div>
      <span className="hint">დასრულებული ოპერაციები, რომელთა პროცედურა SSI კატეგორიაშია (ცნობარები → SSI). რისკის ინდექსი (NNIS): ASA ≥ 3, ჭრილობის კლასი III–IV, ხანგრძლივობა &gt; T-წერტილი — თითო 1 ქულა.</span>
      <ErrorBox error={q.error ?? ref.error} />
      {q.isLoading ? <Loading /> : (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead><tr><th>ოპერაცია</th><th>პაციენტი</th><th>კატეგორია</th><th>კლასი / ASA / წთ</th><th>რისკი</th><th>პროფილაქტიკა</th><th>დაკვირვება</th><th>სტატუსი</th></tr></thead>
            <tbody>{q.data?.map((o) => {
              const wc = o.wound_class_ipc ?? o.wound_class;
              return (
                <tr key={o.case_id} className="clickable" onClick={() => setOpen(o.case_id)}>
                  <td><span className="mono">{o.case_no}</span><div className="small muted mono">{tsDate(o.op_at)} {hm(o.op_at)}</div><div className="small">{o.procedures}</div></td>
                  <td><strong>{o.last_name} {o.first_name}</strong><div className="small muted">{o.department}</div></td>
                  <td><span className="chip">{o.category}</span>{o.implant && <span className="chip info" style={{ marginLeft: 4 }}>იმპლანტი</span>}{o.emergency && <span className="chip warn" style={{ marginLeft: 4 }}>გადაუდებელი</span>}</td>
                  <td className="small mono">{wc ? ['', 'I', 'II', 'III', 'IV'][wc] : '—'}{o.wound_class_ipc ? '*' : ''} / {o.asa ?? '—'} / {o.duration_min ?? '—'}{o.t_point_min && o.duration_min && o.duration_min > o.t_point_min ? ' ↑' : ''}</td>
                  <td className="mono">{o.risk_index ?? '—'}</td>
                  <td><span className={`chip ${PROPH_KA[o.prophylaxis]?.[0] ?? ''}`}>{PROPH_KA[o.prophylaxis]?.[1] ?? o.prophylaxis}</span></td>
                  <td className="small mono">{tsDate(o.followup_until)}-მდე<div className="muted">{o.followup_days} დღე</div>
                    {o.followup_status && <span className={`chip ${FU_ST[o.followup_status][0]}`}>{FU_ST[o.followup_status][1]}</span>}</td>
                  <td><span className={`chip ${SSI_OP_ST[o.status][0]}`}>{SSI_OP_ST[o.status][1]}</span>{o.ssi_case_no && <div className="small mono">{o.ssi_case_no}</div>}
                    {o.open_cases > 0 && <div><span className="chip warn">ეჭვი: {o.open_cases}</span></div>}</td>
                </tr>); })}
              {!q.data?.length && <tr><td colSpan={8} className="muted">ოპერაცია არ არის</td></tr>}
            </tbody>
          </table>
        </div>)}
      {open && <OpDialog caseId={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function OpDialog({ caseId, onClose }: { caseId: string; onClose: () => void }) {
  const qc = useQueryClient(); const nav = useNavigate(); const cat = useSsiCatalog();
  const q = useQuery({ queryKey: ['ipc-ssi-op', caseId], queryFn: () => api<SsiOpDetail>(`/ipc/ssi/ops/${caseId}`) });
  const [wc, setWc] = useState<{ v: string; note: string } | null>(null);
  const [exc, setExc] = useState<string | null>(null);
  const [mk, setMk] = useState(false);
  const patch = useMutation({ mutationFn: (b: Record<string, unknown>) => api(`/ipc/ssi/ops/${caseId}`, { method: 'PATCH', body: b }),
    onSuccess: () => { setWc(null); setExc(null); void qc.invalidateQueries({ queryKey: ['ipc-ssi-op', caseId] }); void qc.invalidateQueries({ queryKey: ['ipc-ssi-ops'] }); } });
  const o = q.data;
  const row = (l: string, v: React.ReactNode) => <div className="row small" style={{ alignItems: 'flex-start' }}><span className="muted" style={{ width: 190, flexShrink: 0 }}>{l}</span><span className="grow">{v}</span></div>;
  return (
    <Modal title={o ? `SSI · ${o.case_no}` : 'SSI'} onClose={onClose} width={760}>
      {!o ? <><ErrorBox error={q.error} />{q.isLoading && <Loading />}</> : (
        <div className="stack" style={{ gap: 10 }}>
          <ErrorBox error={patch.error} />
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
            <strong className="grow">{o.last_name} {o.first_name} <span className="small muted">{o.personal_number}</span></strong>
            <span className={`chip ${SSI_OP_ST[o.status][0]}`}>{SSI_OP_ST[o.status][1]}</span>
            <Link className="btn sm" to={`/or/case/${o.case_id}`}>ოპერაცია →</Link>
          </div>
          {row('პროცედურა', o.procedures ?? '—')}
          {row('კატეგორია', o.can.edit && o.status !== 'ssi' ? <select className="select" style={{ maxWidth: 360, height: 32 }} aria-label="კატეგორია" value={o.category}
            onChange={(e) => patch.mutate({ category: e.target.value })}>{cat.data?.categories.map((k) => <option key={k.code} value={k.code}>{k.code} — {k.name}</option>)}</select>
            : `${o.category} — ${o.category_name}`)}
          {o.category_manual && row('', <span className="muted">კატეგორია IPC-მ შეცვალა</span>)}
          {row('დრო', `${tsDate(o.op_at)} ${hm(o.op_at)} · ${o.duration_min ?? '—'} წთ (T-წერტილი ${o.t_point_min ?? '—'})${o.emergency ? ' · გადაუდებელი' : ''}`)}
          {row('ASA', o.asa ?? '— (წინასაოპერაციო შეფასება ხელმოუწერელია)')}
          {row('ჭრილობის კლასი', <>{o.wound_class ? WOUND_KA[o.wound_class] : '— (ოქმში არ არის)'}{o.wound_class_ipc && <> → <strong>{WOUND_KA[o.wound_class_ipc]}</strong> <span className="muted">(IPC: {o.wound_class_note})</span></>}
            {o.can.edit && <button className="btn sm" type="button" style={{ marginLeft: 8 }} onClick={() => setWc({ v: String(o.wound_class_ipc ?? o.wound_class ?? ''), note: o.wound_class_note ?? '' })}>შესწორება</button>}</>)}
          {row('იმპლანტი', o.implant ? 'კი' : 'არა')}
          {row('რისკის ინდექსი (NNIS)', o.risk_index ?? '— (მონაცემი აკლია)')}
          {row('პროფილაქტიკა', <><span className={`chip ${PROPH_KA[o.prophylaxis][0]}`}>{PROPH_KA[o.prophylaxis][1]}</span> {o.prophylaxis_drug ?? ''}{o.prophylaxis_at ? ` · ${hm(o.prophylaxis_at)}` : ''}</>)}
          {row('დაკვირვება', `${o.followup_days} დღე — ${tsDate(o.followup_until)}-მდე${o.discharged_at ? ` · გაწერილია ${tsDate(o.discharged_at)}` : ' · სტაციონარშია'}`)}
          {o.followup && row('გაწერის შემდგომი კონტაქტი', <><span className={`chip ${FU_ST[o.followup.status][0]}`}>{FU_ST[o.followup.status][1]}</span> {tsDate(o.followup.due_date)}
            {o.followup.outcome && ` · ${o.followup.outcome === 'suspected' ? 'ეჭვი' : 'ინფექცია არ არის'}`}{o.followup.cancel_reason ? ` · ${o.followup.cancel_reason}` : ''}{o.followup.contacted_by_name ? ` · ${o.followup.contacted_by_name}` : ''}</>)}
          {o.status === 'excluded' && row('გამორიცხულია', o.excluded_reason)}
          <div className="stack" style={{ gap: 4 }}><span className="label">HAI შემთხვევები (SSI)</span>
            {o.hai_cases.map((h) => <div key={h.id} className="small row" style={{ gap: 6 }}><button type="button" className="linklike mono" onClick={() => nav(`/ipc/hai/${h.id}`)}>{h.case_no}</button>
              <span className={`chip ${HAI_ST[h.status][0]}`}>{HAI_ST[h.status][1]}</span>{h.ssi_depth && SSI_KA[h.ssi_depth]} · {tsDate(h.onset_date)}{h.post_discharge && ' · გაწერის შემდეგ'}</div>)}
            {!o.hai_cases.length && <span className="small muted">არ არის</span>}</div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {o.status !== 'excluded' && <button className="btn sm primary" type="button" onClick={() => setMk(true)}>+ SSI შემთხვევა</button>}
            {o.can.edit && o.status !== 'ssi' && o.status !== 'excluded' && <button className="btn sm" type="button" onClick={() => setExc('')}>ზედამხედველობიდან გამორიცხვა</button>}
            {o.can.edit && o.status === 'excluded' && <button className="btn sm" type="button" onClick={() => patch.mutate({ excluded: false })}>დაბრუნება</button>}
          </div>
          {wc && <div className="card card-pad stack" style={{ gap: 8 }}>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <select className="select" style={{ maxWidth: 300 }} aria-label="კლასი" value={wc.v} onChange={(e) => setWc({ ...wc, v: e.target.value })}>
                {[1, 2, 3, 4].map((k) => <option key={k} value={k}>{WOUND_KA[k]}</option>)}</select>
              <input className="input grow" aria-label="მიზეზი" placeholder="მიზეზი (სავალდებულო)" value={wc.note} onChange={(e) => setWc({ ...wc, note: e.target.value })} />
            </div>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn sm primary" type="button" disabled={!wc.v || wc.note.trim().length < 3} onClick={() => patch.mutate({ wound_class_ipc: Number(wc.v), wound_class_note: wc.note.trim() })}>შენახვა</button>
              {o.wound_class_ipc && <button className="btn sm" type="button" onClick={() => patch.mutate({ wound_class_ipc: null })}>ოქმის მნიშვნელობაზე დაბრუნება</button>}
              <button className="btn sm" type="button" onClick={() => setWc(null)}>გაუქმება</button></div></div>}
          {exc !== null && <div className="card card-pad row" style={{ gap: 8 }}>
            <input className="input grow" aria-label="მიზეზი" placeholder="გამორიცხვის მიზეზი (მაგ. არასწორი კატეგორია)" value={exc} onChange={(e) => setExc(e.target.value)} />
            <button className="btn sm primary" type="button" disabled={exc.trim().length < 3} onClick={() => patch.mutate({ excluded: true, excluded_reason: exc.trim() })}>გამორიცხვა</button>
            <button className="btn sm" type="button" onClick={() => setExc(null)}>×</button></div>}
        </div>)}
      {mk && o && <CreateCase preset={{ patient: { id: o.patient_id, name: `${o.last_name} ${o.first_name}` }, hai_type: 'ssi', or_case_id: o.case_id }}
        onClose={() => setMk(false)} onDone={(id) => nav(`/ipc/hai/${id}`)} />}
    </Modal>
  );
}

// ================================================================ გაწერის შემდგომი კონტაქტი
function Calls() {
  const nav = useNavigate();
  const [st, setSt] = useState<'due' | 'pending' | 'all'>('due');
  const query = st === 'due' ? { status: 'pending', due: 'now' } : st === 'pending' ? { status: 'pending' } : { status: 'all' };
  const q = useQuery({ queryKey: ['ipc-ssi-fu', query.status, query.due ?? ''], queryFn: () => api<SsiFollowup[]>('/ipc/ssi/followups', { query }) });
  const [call, setCall] = useState<SsiFollowup | null>(null);
  return (
    <>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <div className="seg" role="group" aria-label="სტატუსი">{([['due', 'დღეს / 3 დღეში'], ['pending', 'ყველა მოსალოდნელი'], ['all', 'ყველა']] as const).map(([k, l]) =>
          <button key={k} type="button" aria-pressed={st === k} onClick={() => setSt(k)}>{l}</button>)}</div>
      </div>
      <span className="hint">გაწერილ პაციენტთან — დაკვირვების ვადის ბოლოს (30 / 90 დღე). ეჭვი → HAI შემთხვევა (SSI, „გაწერის შემდეგ“). ცდების ლიმიტის შემდეგ — „ვერ დავუკავშირდით“.</span>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead><tr><th>ვადა</th><th>პაციენტი</th><th>ოპერაცია</th><th>ცდა</th><th>სტატუსი</th><th /></tr></thead>
            <tbody>{q.data?.map((f) => (
              <tr key={f.id}>
                <td className="mono">{tsDate(f.due_date)}</td>
                <td><strong>{f.last_name} {f.first_name}</strong><div className="small mono">{f.phone_number ?? '—'}</div></td>
                <td className="small"><span className="mono">{f.case_no}</span> · {f.category} · {tsDate(f.op_date)}<div className="muted">{f.department}</div></td>
                <td className="mono">{f.attempts}{f.sms_sent_at && <div className="small muted">SMS ✓</div>}</td>
                <td><span className={`chip ${FU_ST[f.status][0]}`}>{FU_ST[f.status][1]}</span>
                  {f.outcome && <div className="small">{f.outcome === 'suspected' ? 'ეჭვი' : 'ინფექცია არ არის'}</div>}
                  {f.hai_case_no && <div><button type="button" className="linklike small mono" onClick={() => nav(`/ipc/hai/${f.hai_case_id}`)}>{f.hai_case_no}</button></div>}
                  {f.cancel_reason && <div className="small muted">{f.cancel_reason}</div>}</td>
                <td>{f.status === 'pending' && <button className="btn sm primary" type="button" onClick={() => setCall(f)}>დარეკვა</button>}</td>
              </tr>))}
              {!q.data?.length && <tr><td colSpan={6} className="muted">კონტაქტი არ არის</td></tr>}
            </tbody>
          </table>
        </div>)}
      {call && <CallDialog f={call} onClose={() => setCall(null)} />}
    </>
  );
}

function CallDialog({ f, onClose }: { f: SsiFollowup; onClose: () => void }) {
  const qc = useQueryClient(); const nav = useNavigate();
  const [ans, setAns] = useState<Record<string, boolean>>({});
  const [outcome, setOutcome] = useState<'no_infection' | 'suspected' | ''>('');
  const [onset, setOnset] = useState(todayTb()); const [note, setNote] = useState('');
  const m = useMutation({ mutationFn: (action: 'attempt' | 'done' | 'cancel') => api<SsiFollowup>(`/ipc/ssi/followups/${f.id}`, { body: { action, note: note.trim() || undefined,
      ...(action === 'done' && { outcome, answers: ans, ...(outcome === 'suspected' && { onset_date: onset }) }) } }),
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ['ipc-ssi-fu'] }); void qc.invalidateQueries({ queryKey: ['ipc-ssi-ops'] }); if (r?.hai_case_id) nav(`/ipc/hai/${r.hai_case_id}`); else onClose(); } });
  const anyYes = Object.values(ans).some(Boolean);
  return (
    <Modal title={`გაწერის შემდგომი კონტაქტი — ${f.last_name} ${f.first_name}`} onClose={onClose} width={620} footer={<>
      <button className="btn" type="button" disabled={m.isPending} onClick={() => m.mutate('attempt')} title="ცდა ჩაითვლება">ვერ დავუკავშირდი</button>
      <button className="btn" type="button" disabled={m.isPending || note.trim().length < 3} onClick={() => m.mutate('cancel')} title="მიზეზი — შენიშვნაში">გაუქმება</button>
      <span className="grow" />
      <button className="btn primary" type="button" disabled={m.isPending || !outcome} onClick={() => m.mutate('done')}>{outcome === 'suspected' ? 'შენახვა → SSI შემთხვევა' : 'შენახვა'}</button></>}>
      <div className="stack" style={{ gap: 10 }}>
        <ErrorBox error={m.error} />
        <div className="small">ტელ.: <strong className="mono">{f.phone_number ?? '—'}</strong> · ოპერაცია <span className="mono">{f.case_no}</span> ({f.category}, {tsDate(f.op_date)}) · ცდა {f.attempts + 1}</div>
        <span className="label">ოპერაციის შემდეგ გქონდათ…</span>
        {FU_Q.map(([k, l]) => <label key={k} className="row small"><input type="checkbox" checked={!!ans[k]} onChange={(e) => setAns({ ...ans, [k]: e.target.checked })} /> {l}</label>)}
        <div className="seg" role="group" aria-label="შედეგი">
          <button type="button" aria-pressed={outcome === 'no_infection'} onClick={() => setOutcome('no_infection')}>ინფექცია არ არის</button>
          <button type="button" aria-pressed={outcome === 'suspected'} onClick={() => setOutcome('suspected')}>ეჭვი SSI-ზე</button>
        </div>
        {anyYes && outcome === 'no_infection' && <div className="alert warn small">დადებითი პასუხია — დარწმუნდით, რომ ინფექცია არ არის.</div>}
        {outcome === 'suspected' && <Field label="სიმპტომების დაწყება" htmlFor="cl-o"><input id="cl-o" type="date" className="input" style={{ maxWidth: 180 }} value={onset} max={todayTb()} onChange={(e) => setOnset(e.target.value)} /></Field>}
        <Field label="შენიშვნა" htmlFor="cl-n"><textarea id="cl-n" className="textarea" rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

// ================================================================ მაჩვენებლები
function SsiRatesView() {
  const t = todayTb();
  const [from, setFrom] = useState(`${t.slice(0, 4)}-01-01`); const [to, setTo] = useState(t);
  const q = useQuery({ queryKey: ['ipc-ssi-rates', from, to], queryFn: () => api<SsiRates>('/ipc/ssi/rates', { query: { from, to } }), enabled: from <= to });
  const p = (v: number | null) => (v === null ? '—' : `${v.toLocaleString('ka-GE', { maximumFractionDigits: 2 })}%`);
  const risk = (x: SsiRateRow, i: 0 | 1 | 2 | 3) => { const n = x[`r${i}`]; const s = x[`s${i}`]; return n ? `${s}/${n}` : '—'; };
  const cells = (x: SsiRateRow) => <>
    <td className="mono">{x.ops}{x.active > 0 && <div className="small muted">დაკვ.: {x.active}</div>}</td>
    <td className="mono">{x.ssi}</td><td className="mono"><strong>{p(x.rate)}</strong></td>
    <td className="mono small">{x.superficial} / {x.deep} / {x.organ}</td>
    {([0, 1, 2, 3] as const).map((i) => <td key={i} className="mono small">{risk(x, i)}</td>)}
    <td className="mono small">{x.post_discharge}{x.ssi > 0 && <div className="muted">{p(x.post_discharge_pct)}</div>}</td>
    <td className="mono small">{p(x.ph_timely_pct)}<div className="muted">{x.ph_timely}/{x.ph_known}</div></td>
    <td className="mono small">{x.fu_done}/{x.fu_due}</td></>;
  return (
    <>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <input className="input" type="date" style={{ maxWidth: 160, height: 38 }} aria-label="დან" value={from} onChange={(e) => setFrom(e.target.value)} />
        <input className="input" type="date" style={{ maxWidth: 160, height: 38 }} aria-label="მდე" value={to} max={t} onChange={(e) => setTo(e.target.value)} />
      </div>
      <span className="hint">კუმულაციური ინციდენტობა: დადასტურებული SSI / ოპერაციები (ოპერაციის თარიღით; გამორიცხულის გარეშე). „დაკვ.“ — დაკვირვება ჯერ არ დასრულებულა (მაჩვენებელი შეიძლება გაიზარდოს).
        რისკის ინდექსი — SSI / ოპერაციები. პროფილაქტიკა — ჭრილობამდე ფანჯარაში (მოდულის პარამეტრი).</span>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : q.data && (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead><tr><th>კატეგორია</th><th>ოპერაცია</th><th>SSI</th><th>%</th><th>ზედაპ. / ღრმა / ორგანო</th><th>NNIS 0</th><th>1</th><th>2</th><th>3</th><th>გაწერის შემდეგ</th><th>პროფილაქტიკა დროულად</th><th>კონტაქტი (შესრ. / სულ)</th></tr></thead>
            <tbody>{q.data.rows.map((x) => <tr key={x.category}><td><strong>{x.category}</strong><div className="small muted">{x.name}</div></td>{cells(x)}</tr>)}
              {!q.data.rows.length && <tr><td colSpan={12} className="muted">მონაცემი არ არის</td></tr>}</tbody>
            {q.data.rows.length > 1 && <tfoot><tr><th>სულ</th>{cells(q.data.total)}</tr></tfoot>}
          </table>
        </div>)}
    </>
  );
}

// ================================================================ ცნობარი: SSI კატეგორიები და პროცედურები
export function SsiCatalogSection() {
  const qc = useQueryClient(); const cat = useSsiCatalog();
  const [edit, setEdit] = useState<{ code: string | null; name: string; followup_days: string; implant_followup_days: string; t_point_min: string; ncsp: string; is_active: boolean; newCode?: string } | null>(null);
  const [onlyOpen, setOnlyOpen] = useState(true); const [search, setSearch] = useState('');
  const inval = () => void qc.invalidateQueries({ queryKey: ['ipc-ssi-catalog'] });
  const save = useMutation({ mutationFn: () => { const e = edit!;
      const b = { name: e.name.trim(), followup_days: Number(e.followup_days), implant_followup_days: e.implant_followup_days ? Number(e.implant_followup_days) : null,
        t_point_min: e.t_point_min ? Number(e.t_point_min) : null, ncsp_prefixes: e.ncsp.split(/[\s,;]+/).map((x) => x.trim().toUpperCase()).filter(Boolean), is_active: e.is_active };
      return e.code ? api(`/ipc/ssi/categories/${e.code}`, { method: 'PATCH', body: b }) : api('/ipc/ssi/categories', { body: { ...b, code: e.newCode } }); },
    onSuccess: () => { setEdit(null); inval(); } });
  const proc = useMutation({ mutationFn: (x: { id: string; c: string | null }) => api(`/ipc/ssi/procedures/${x.id}`, { method: 'PATCH', body: { ssi_category: x.c } }), onSuccess: inval });
  const apply = useMutation({ mutationFn: () => api<{ applied: number }>('/ipc/ssi/procedures/apply-suggestions', { body: {} }), onSuccess: inval });
  const c = cat.data;
  if (!c) return <ErrorBox error={cat.error} />;
  const sugg = c.procedures.filter((p) => p.suggested).length;
  const procs = c.procedures.filter((p) => (!onlyOpen || p.ssi_category || p.suggested) && (!search.trim() || `${p.code} ${p.ncsp_code ?? ''} ${p.name}`.toLowerCase().includes(search.trim().toLowerCase())));
  return (
    <section className="card card-pad stack" style={{ gap: 8 }}>
      <div className="row"><h2 style={{ margin: 0 }} className="grow">SSI კატეგორიები</h2>
        <button className="btn sm primary" type="button" onClick={() => setEdit({ code: null, name: '', followup_days: '30', implant_followup_days: '', t_point_min: '', ncsp: '', is_active: true })}>+ კატეგორია</button></div>
      <span className="hint">ზედამხედველობა მხოლოდ აქტიურ კატეგორიებზე. დაკვირვება: 30 დღე; იმპლანტით (ოქმის „იმპლანტები“) — „იმპლანტით“ სვეტი. T-წერტილი — NNIS რისკის ინდექსისთვის (ხანგრძლივობის 75-ე პერცენტილი).</span>
      <ErrorBox error={save.error ?? proc.error ?? apply.error} />
      <table className="table">
        <thead><tr><th>კოდი</th><th>დასახელება</th><th>დაკვირვება</th><th>იმპლანტით</th><th>T-წერტ.</th><th>NCSP</th><th /></tr></thead>
        <tbody>{c.categories.map((k) => (
          <tr key={k.code} style={k.is_active ? undefined : { opacity: 0.55 }}><td className="mono">{k.code}</td><td>{k.name}{!k.is_active && <span className="chip" style={{ marginLeft: 6 }}>გათიშულია</span>}</td>
            <td className="mono">{k.followup_days}</td><td className="mono">{k.implant_followup_days ?? '—'}</td><td className="mono">{k.t_point_min ?? '—'}</td>
            <td className="mono small">{k.ncsp_prefixes.join(', ') || '—'}</td>
            <td><button className="btn sm" type="button" onClick={() => setEdit({ code: k.code, name: k.name, followup_days: String(k.followup_days), implant_followup_days: k.implant_followup_days ? String(k.implant_followup_days) : '',
              t_point_min: k.t_point_min ? String(k.t_point_min) : '', ncsp: k.ncsp_prefixes.join(', '), is_active: k.is_active })}>შეცვლა</button></td></tr>))}</tbody>
      </table>
      <div className="row" style={{ flexWrap: 'wrap', marginTop: 6 }}><h3 style={{ margin: 0, fontSize: 15 }} className="grow">ოპერაციების ცნობარი → კატეგორია</h3>
        <label className="row small"><input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} /> მხოლოდ მიბმული / შეთავაზებული</label>
        <input className="input" style={{ maxWidth: 220, height: 34 }} aria-label="ძებნა" placeholder="ძებნა" value={search} onChange={(e) => setSearch(e.target.value)} />
        {sugg > 0 && <button className="btn sm" type="button" disabled={apply.isPending} onClick={() => apply.mutate()}>შეთავაზებულის მიღება ({sugg})</button>}</div>
      <table className="table">
        <thead><tr><th>კოდი</th><th>NCSP</th><th>პროცედურა</th><th>SSI კატეგორია</th></tr></thead>
        <tbody>{procs.slice(0, 300).map((p) => (
          <tr key={p.id}><td className="mono">{p.code}</td><td className="mono">{p.ncsp_code ?? '—'}</td><td>{p.name}<div className="small muted">{p.specialty ?? ''}</div></td>
            <td><div className="row" style={{ gap: 6 }}>
              <select className="select" style={{ maxWidth: 220, height: 32 }} aria-label="კატეგორია" value={p.ssi_category ?? ''} onChange={(e) => proc.mutate({ id: p.id, c: e.target.value || null })}>
                <option value="">—</option>{c.categories.map((k) => <option key={k.code} value={k.code}>{k.code}</option>)}</select>
              {p.suggested && <button className="btn sm" type="button" onClick={() => proc.mutate({ id: p.id, c: p.suggested })}>→ {p.suggested}?</button>}</div></td></tr>))}
          {!procs.length && <tr><td colSpan={4} className="muted">პროცედურა არ არის</td></tr>}</tbody>
      </table>
      {edit && <Modal title={edit.code ? `კატეგორია ${edit.code}` : 'ახალი კატეგორია'} onClose={() => setEdit(null)} footer={<>
        <button className="btn" type="button" onClick={() => setEdit(null)}>გაუქმება</button>
        <button className="btn primary" type="button" disabled={save.isPending || edit.name.trim().length < 2 || (!edit.code && !/^[A-Z][A-Z0-9_]{1,9}$/.test(edit.newCode ?? ''))} onClick={() => save.mutate()}>შენახვა</button></>}>
        <div className="stack" style={{ gap: 10 }}>
          <ErrorBox error={save.error} />
          {!edit.code && <Field label="კოდი" htmlFor="sc-c" hint="დიდი ლათ. ასოები (მაგ. HER — თიაქარი)"><input id="sc-c" className="input mono" maxLength={10}
            value={edit.newCode ?? ''} onChange={(e) => setEdit({ ...edit, newCode: e.target.value.toUpperCase() })} /></Field>}
          <Field label="დასახელება" htmlFor="sc-n"><input id="sc-n" className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
            <Field label="დაკვირვება, დღე" htmlFor="sc-f"><input id="sc-f" className="input mono" type="number" min={7} max={365} value={edit.followup_days} onChange={(e) => setEdit({ ...edit, followup_days: e.target.value })} /></Field>
            <Field label="იმპლანტით, დღე" htmlFor="sc-i"><input id="sc-i" className="input mono" type="number" min={7} max={365} value={edit.implant_followup_days} onChange={(e) => setEdit({ ...edit, implant_followup_days: e.target.value })} /></Field>
            <Field label="T-წერტილი, წთ" htmlFor="sc-t"><input id="sc-t" className="input mono" type="number" min={10} max={1440} value={edit.t_point_min} onChange={(e) => setEdit({ ...edit, t_point_min: e.target.value })} /></Field>
          </div>
          <Field label="NCSP პრეფიქსები" htmlFor="sc-p" hint="მძიმით, მაგ. JFB, JFH"><input id="sc-p" className="input mono" value={edit.ncsp} onChange={(e) => setEdit({ ...edit, ncsp: e.target.value })} /></Field>
          <label className="row"><input type="checkbox" checked={edit.is_active} onChange={(e) => setEdit({ ...edit, is_active: e.target.checked })} /> ზედამხედველობა აქტიურია</label>
        </div>
      </Modal>}
    </section>
  );
}
