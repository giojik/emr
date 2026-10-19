import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, can } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { openIncidentReport, useQmMeta } from '../../components/IncidentReport';
import { ErrorBox, Loading, useDebounced } from '../../components/ui';
import { hhmm, tsDate } from '../../lib/format';
import { useModuleEnabled, useModules } from '../../lib/modules';
import QmCatalog from './Catalog';
import {
  catLabel, EVENT_KA, HARM_CHIP, HARM_KA, QM_FULL, QM_READ, RISK_UI, STATUS_UI,
  CAPA_KIND_KA, CAPA_ST, LEVEL_KA, ANALYSIS_ST,
  type CapaRow, type Classifier, type EventType, type Harm, type IncidentRow, type MyReport, type MyWork, type QmSummary, type Status,
} from './types';

type Tab = 'registry' | 'work' | 'capa' | 'mine' | 'catalog';

/** ხარისხი და ინციდენტები (0064): რეესტრი (quality / quality_dept), ჩემი შეტყობინებები (ყველა), ცნობარები (quality) */
export default function Quality() {
  const { user } = useAuth();
  const [sp] = useSearchParams();
  const mods = useModules(); const enabled = useModuleEnabled('quality');
  const reg = can(user, ...QM_READ);
  const sum = useQuery({ queryKey: ['qm-summary'], queryFn: () => api<QmSummary>('/quality/incidents/summary'), enabled: enabled && reg, refetchInterval: 60_000 });
  const work = useQuery({ queryKey: ['qm-work'], queryFn: () => api<MyWork>('/quality/my-work'), enabled, refetchInterval: 120_000 });
  const workN = (work.data?.incidents.length ?? 0) + (work.data?.capas.length ?? 0);
  if (mods.isLoading) return <div className="content"><Loading /></div>;
  if (!enabled) return <div className="content"><div className="alert warn">მოდული „ხარისხი და ინციდენტები“ გამორთულია (ადმინისტრირება → მოდულები).</div></div>;
  const tabs: [Tab, string, boolean, number][] = [
    ['registry', 'ინციდენტების რეესტრი', reg, sum.data ? (can(user, ...QM_FULL) ? sum.data.submitted : sum.data.open) : 0],
    ['work', 'ჩემი ქმედებები', true, workN],
    ['capa', 'ქმედებები (CAPA)', can(user, ...QM_FULL), 0],
    ['mine', 'ჩემი შეტყობინებები', true, 0],
    ['catalog', 'ცნობარები', can(user, ...QM_FULL), 0],
  ];
  const allowed = tabs.filter((t) => t[2]);
  const def = reg ? 'registry' : workN ? 'work' : 'mine';
  const cur = (allowed.find((t) => t[0] === sp.get('tab'))?.[0] ?? def) as Tab;
  return (
    <>
      <header className="topbar" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8, paddingBottom: 0 }}>
        <div className="row"><h1 className="grow">ხარისხი და ინციდენტები</h1>
          <button className="btn primary" type="button" onClick={() => openIncidentReport()}>⚠ ახალი შეტყობინება</button></div>
        <nav aria-label="ხარისხი" className="row" style={{ gap: 2, flexWrap: 'wrap' }}>
          {allowed.map(([k, l, , n]) => <Link key={k} to={`/quality?tab=${k}`} className={`admin-tab${cur === k ? ' active' : ''}`} aria-current={cur === k ? 'page' : undefined}>
            {l}{n > 0 && <span className="chip danger" style={{ marginLeft: 6, height: 20 }}>{n}</span>}</Link>)}
        </nav>
      </header>
      {cur === 'registry' && <Registry sum={sum.data} />}
      {cur === 'work' && <Work data={work.data} loading={work.isLoading} error={work.error} />}
      {cur === 'capa' && <CapaList />}
      {cur === 'mine' && <Mine />}
      {cur === 'catalog' && <QmCatalog />}
    </>
  );
}

type Preset = 'triage' | 'open' | 'all' | 'urgent' | 'closed';
function Registry({ sum }: { sum?: QmSummary }) {
  const { user } = useAuth(); const nav = useNavigate();
  const full = can(user, ...QM_FULL);
  const [preset, setPreset] = useState<Preset>(full ? 'triage' : 'open');
  const [dept, setDept] = useState(''); const [cat, setCat] = useState(''); const [harm, setHarm] = useState(''); const [et, setEt] = useState('');
  const [from, setFrom] = useState(''); const [to, setTo] = useState(''); const [search, setSearch] = useState(''); const ds = useDebounced(search.trim(), 300);
  const depts = useQuery({ queryKey: ['departments'], queryFn: () => api<{ id: string; name: string }[]>('/departments'), staleTime: 5 * 60_000 });
  const cats = useQuery({ queryKey: ['qm-classifiers', 'category'], queryFn: () => api<Classifier[]>('/quality/classifiers', { query: { kind: 'category' } }), staleTime: 5 * 60_000 });
  const query = { department_id: dept, category_id: cat, harm, event_type: et, from, to, search: ds,
    ...(preset === 'triage' && { status: 'submitted' }), ...(preset === 'open' && { status: 'investigation,analysis,capa' }),
    ...(preset === 'urgent' && { urgent: '1', status: 'submitted,investigation,analysis,capa' }), ...(preset === 'closed' && { status: 'closed,rejected' }) };
  const q = useQuery({ queryKey: ['qm-list', query], queryFn: () => api<IncidentRow[]>('/quality/incidents', { query }) });
  const presets: [Preset, string, boolean][] = [['triage', 'ტრიაჟი', full], ['open', 'განიხილება', true], ['urgent', 'სასწრაფო', true], ['closed', 'დახურული / უარყოფილი', true], ['all', 'ყველა', true]];
  return (
    <div className="content">
      {sum && (
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          {full && <Kpi label="ტრიაჟს ელოდება" v={sum.submitted} tone={sum.submitted ? 'warn' : ''} />}
          {full && <Kpi label="ტრიაჟის ვადა გადაცილებულია" v={sum.overdue} tone={sum.overdue ? 'danger' : ''} />}
          <Kpi label="განიხილება" v={sum.open} />
          <Kpi label="სასწრაფო (ღია)" v={sum.urgent_open} tone={sum.urgent_open ? 'danger' : ''} />
          <Kpi label="სენტინელური (ღია)" v={sum.sentinel_open} tone={sum.sentinel_open ? 'danger' : ''} />
          <Kpi label="ამ თვეში" v={sum.month} sub={`near-miss: ${sum.near_miss_month}`} />
          {sum.scope === 'dept' && <span className="small muted" style={{ alignSelf: 'center' }}>ხედვა: თქვენი განყოფილებ(ებ)ის მიღებული ინციდენტები</span>}
        </div>)}
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <div className="seg" role="group" aria-label="სტატუსი">{presets.filter((p) => p[2]).map(([k, l]) => <button key={k} type="button" aria-pressed={preset === k} onClick={() => setPreset(k)}>{l}</button>)}</div>
        <select className="select" style={{ maxWidth: 200, height: 38 }} aria-label="განყოფილება" value={dept} onChange={(e) => setDept(e.target.value)}>
          <option value="">ყველა განყოფილება</option>{depts.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
        <select className="select" style={{ maxWidth: 200, height: 38 }} aria-label="კატეგორია" value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="">ყველა კატეგორია</option>{cats.data?.filter((c) => !c.parent_id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <select className="select" style={{ maxWidth: 160, height: 38 }} aria-label="ზიანი" value={harm} onChange={(e) => setHarm(e.target.value)}>
          <option value="">ნებისმიერი ზიანი</option>{(Object.keys(HARM_KA) as Harm[]).map((k) => <option key={k} value={k}>{HARM_KA[k]}</option>)}</select>
        <select className="select" style={{ maxWidth: 190, height: 38 }} aria-label="ტიპი" value={et} onChange={(e) => setEt(e.target.value)}>
          <option value="">ნებისმიერი ტიპი</option>{(Object.keys(EVENT_KA) as EventType[]).map((k) => <option key={k} value={k}>{EVENT_KA[k][0]}</option>)}</select>
        <input className="input" type="date" style={{ maxWidth: 150, height: 38 }} aria-label="თარიღიდან" value={from} onChange={(e) => setFrom(e.target.value)} />
        <input className="input" type="date" style={{ maxWidth: 150, height: 38 }} aria-label="თარიღამდე" value={to} onChange={(e) => setTo(e.target.value)} />
        <input className="input" style={{ maxWidth: 220, height: 38 }} aria-label="ძებნა" placeholder="№, აღწერა, პაციენტი" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead><tr><th>№ / მოხდა</th><th>განყოფილება</th><th>კატეგორია</th><th>ტიპი · ზიანი · რისკი</th><th>პაციენტი / მოვლენა</th><th>ავტორი</th><th>სტატუსი</th></tr></thead>
            <tbody>{q.data?.map((r) => {
              const h = (r.harm ?? r.harm_reported) as Harm;
              return (
                <tr key={r.id} className="clickable" onClick={() => nav(`/quality/incidents/${r.id}`)}>
                  <td style={{ whiteSpace: 'nowrap' }}><span className="mono">{r.inc_no}</span>{r.is_sentinel && <span className="chip danger" style={{ marginLeft: 6, height: 20 }} title="სენტინელური">⚑</span>}
                    {r.urgent && !r.is_sentinel && <span className="chip danger" style={{ marginLeft: 6, height: 20 }} title="სასწრაფო">!</span>}
                    <div className="mono small muted">{tsDate(r.occurred_at)} {hhmm(r.occurred_at)}</div></td>
                  <td className="small">{r.department_name}</td>
                  <td className="small">{catLabel(r)}<div className="muted" style={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.summary}</div></td>
                  <td className="small">{EVENT_KA[r.event_type][0]}
                    <div className="row" style={{ gap: 4, marginTop: 2, flexWrap: 'wrap' }}>{h !== 'none' && <span className={`chip ${HARM_CHIP[h]}`} style={{ height: 20 }}>{HARM_KA[h]}{!r.harm ? ' (წინასწ.)' : ''}</span>}
                      {r.risk_level && <span className={`chip ${RISK_UI[r.risk_level][0]}`} style={{ height: 20 }}>რისკი {r.risk_score} · {RISK_UI[r.risk_level][1]}</span>}</div></td>
                  <td className="small">{r.patient_name ?? r.patient_text ?? '—'}{r.source_label && <div className="muted">{r.source_label}</div>}</td>
                  <td className="small">{r.identity_mode === 'anonymous' ? <span className="muted">ანონიმური</span> : r.reporter_name ?? <span className="muted">კონფიდენციალური</span>}</td>
                  <td><span className={`chip ${STATUS_UI[r.status][0]}`}>{STATUS_UI[r.status][1]}</span>{r.overdue && <span className="chip danger" style={{ marginLeft: 4 }}>ვადა</span>}</td>
                </tr>);
            })}
              {!q.data?.length && <tr><td colSpan={7} className="muted">ინციდენტი არ არის</td></tr>}
            </tbody>
          </table>
        </div>)}
    </div>
  );
}

function Kpi({ label, v, tone = '', sub }: { label: string; v: number; tone?: string; sub?: string }) {
  return (
    <div className="card card-pad stack" style={{ gap: 2, minWidth: 150 }}>
      <span className="small muted">{label}</span>
      <strong style={{ fontSize: 22, color: tone === 'danger' ? 'var(--danger)' : tone === 'warn' ? 'var(--warn-ink)' : undefined }}>{v}</strong>
      {sub && <span className="small muted">{sub}</span>}
    </div>
  );
}

function Mine() {
  const nav = useNavigate();
  const meta = useQmMeta();
  const q = useQuery({ queryKey: ['qm-mine'], queryFn: () => api<MyReport[]>('/quality/incidents/mine') });
  const [code, setCode] = useState('');
  const track = useMutation({ mutationFn: () => api<{ inc_no: string; status: Status; status_label: string; reported_at: string; reject_label: string | null; feedback: string | null }>('/quality/track', { query: { code } }) });
  return (
    <div className="content">
      <span className="hint">თქვენ მიერ (ღია ან კონფიდენციალური რეჟიმით) გაგზავნილი შეტყობინებები და მათი სტატუსი. ანონიმური შეტყობინება აქ არ ჩანს — სტატუსი იხილეთ კოდით.</span>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : (
        <div className="card">
          <table className="table">
            <thead><tr><th>№</th><th>გაიგზავნა</th><th>კატეგორია</th><th>განყოფილება</th><th>ტიპი</th><th>სტატუსი</th></tr></thead>
            <tbody>{q.data?.map((r) => (
              <tr key={r.id} className="clickable" onClick={() => nav(`/quality/incidents/${r.id}`)}>
                <td className="mono">{r.inc_no}</td><td className="mono small">{tsDate(r.reported_at)} {hhmm(r.reported_at)}</td><td className="small">{r.category_name}</td>
                <td className="small">{r.department_name}</td><td className="small">{EVENT_KA[r.event_type][0]}</td>
                <td><span className={`chip ${STATUS_UI[r.status][0]}`}>{r.status_label}</span>{r.reject_label && <span className="small muted"> · {r.reject_label}</span>}</td>
              </tr>))}
              {!q.data?.length && <tr><td colSpan={6} className="muted">შეტყობინება არ გაქვთ</td></tr>}
            </tbody>
          </table>
        </div>)}
      {meta.data?.anonymous_tracking !== false && (
        <section className="card card-pad stack" style={{ maxWidth: 560 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>ანონიმური შეტყობინების სტატუსი — კოდით</h2>
          <div className="row"><input className="input mono" aria-label="კოდი" placeholder="XXXX-XXXX-XXXX-XXXX" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
            <button className="btn" type="button" disabled={code.replace(/[^A-Z0-9]/g, '').length !== 16 || track.isPending} onClick={() => track.mutate()}>ნახვა</button></div>
          {track.data && <div className="row"><strong className="mono">{track.data.inc_no}</strong><span className={`chip ${STATUS_UI[track.data.status][0]}`}>{track.data.status_label}</span>
            {track.data.reject_label && <span className="small muted">{track.data.reject_label}</span>}<span className="small muted">გაიგზავნა {tsDate(track.data.reported_at)}</span></div>}
          {track.data?.status === 'closed' && <div className="alert ok">განხილვა დასრულდა{track.data.feedback ? `: ${track.data.feedback}` : '.'}</div>}
          <ErrorBox error={track.error} />
        </section>)}
    </div>
  );
}

function Work({ data, loading, error }: { data?: MyWork; loading: boolean; error: unknown }) {
  const nav = useNavigate();
  if (loading) return <div className="content"><Loading /></div>;
  return (
    <div className="content">
      <ErrorBox error={error} />
      {(data?.incidents.length || !data?.capas.length) ? <>
      <h2 style={{ margin: 0, fontSize: 16 }}>გამოძიება / ანალიზი</h2>
      <div className="card">
        <table className="table">
          <thead><tr><th>№</th><th>კატეგორია</th><th>განყოფილება</th><th>როლი</th><th>დონე</th><th>ანალიზი</th><th>ვადა</th></tr></thead>
          <tbody>{data?.incidents.map((i) => (
            <tr key={i.id} className="clickable" onClick={() => nav(`/quality/incidents/${i.id}`)}>
              <td className="mono">{i.inc_no}</td><td className="small">{i.category_name}</td><td className="small">{i.department_name}</td>
              <td className="small">{i.is_investigator ? 'გამომძიებელი' : 'RCA გუნდი'}</td><td className="small">{i.analysis_level ? LEVEL_KA[i.analysis_level] : '—'}</td>
              <td>{i.analysis_status ? <span className={`chip ${ANALYSIS_ST[i.analysis_status][0]}`}>{ANALYSIS_ST[i.analysis_status][1]}</span> : <span className={`chip ${STATUS_UI[i.status][0]}`}>{STATUS_UI[i.status][1]}</span>}</td>
              <td className="mono small">{i.analysis_due_at ? tsDate(i.analysis_due_at) : '—'}{i.overdue && <span className="chip danger" style={{ marginLeft: 4 }}>ვადა</span>}</td>
            </tr>))}
            {!data?.incidents.length && <tr><td colSpan={7} className="muted">მინიჭებული ინციდენტი არ არის</td></tr>}
          </tbody>
        </table>
      </div></> : null}
      <h2 style={{ margin: 0, fontSize: 16 }}>ჩემი ქმედებები (CAPA)</h2>
      <div className="card">
        <table className="table">
          <thead><tr><th>№</th><th>ქმედება</th><th>ტიპი</th><th>განყოფილება</th><th>ვადა</th><th>სტატუსი</th></tr></thead>
          <tbody>{data?.capas.map((c) => (
            <tr key={c.id} className="clickable" onClick={() => nav(`/quality/capas/${c.id}`)}>
              <td className="mono">{c.capa_no}</td><td>{c.title}</td><td className="small">{CAPA_KIND_KA[c.kind]}</td><td className="small">{c.department_name ?? '—'}</td>
              <td className="mono small">{tsDate(c.due_date)}{c.overdue && <span className="chip danger" style={{ marginLeft: 4 }}>ვადა</span>}{c.due_request_pending && <span className="chip warn" style={{ marginLeft: 4 }}>ვადის მოთხოვნა</span>}</td>
              <td><span className={`chip ${CAPA_ST[c.status][0]}`}>{CAPA_ST[c.status][1]}</span></td>
            </tr>))}
            {!data?.capas.length && <tr><td colSpan={6} className="muted">ღია ქმედება არ არის</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

type CapaPreset = 'open' | 'overdue' | 'effectiveness' | 'done' | 'all';
function CapaList() {
  const nav = useNavigate();
  const [p, setP] = useState<CapaPreset>('open'); const [search, setSearch] = useState(''); const ds = useDebounced(search.trim(), 300);
  const query = { search: ds, ...(p === 'open' && { status: 'open,in_progress' }), ...(p === 'overdue' && { overdue: '1' }), ...(p === 'effectiveness' && { effectiveness: '1' }), ...(p === 'done' && { status: 'done,cancelled' }) };
  const q = useQuery({ queryKey: ['qm-capas', query], queryFn: () => api<CapaRow[]>('/quality/capas', { query }) });
  const presets: [CapaPreset, string][] = [['open', 'ღია'], ['overdue', 'ვადაგადაცილებული'], ['effectiveness', 'ეფექტიანობის შემოწმება'], ['done', 'დასრულებული / გაუქმებული'], ['all', 'ყველა']];
  return (
    <div className="content">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <div className="seg" role="group" aria-label="ფილტრი">{presets.map(([k, l]) => <button key={k} type="button" aria-pressed={p === k} onClick={() => setP(k)}>{l}</button>)}</div>
        <input className="input" style={{ maxWidth: 240, height: 38 }} aria-label="ძებნა" placeholder="№ ან ქმედება" value={search} onChange={(e) => setSearch(e.target.value)} />
        <span className="small muted">ახალი ქმედება — ინციდენტის ბარათიდან.</span>
      </div>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead><tr><th>№</th><th>ქმედება</th><th>ინციდენტ(ებ)ი</th><th>პასუხისმგებელი</th><th>ვადა</th><th>სტატუსი</th><th>ეფექტიანობა</th></tr></thead>
            <tbody>{q.data?.map((c) => (
              <tr key={c.id} className="clickable" onClick={() => nav(`/quality/capas/${c.id}`)}>
                <td className="mono">{c.capa_no}</td><td>{c.title}<div className="small muted">{CAPA_KIND_KA[c.kind]}{c.department_name ? ` · ${c.department_name}` : ''}</div></td>
                <td className="mono small">{c.incidents}</td><td className="small">{c.owner_name}</td>
                <td className="mono small">{tsDate(c.due_date)}{c.overdue && <span className="chip danger" style={{ marginLeft: 4 }}>ვადა</span>}{c.due_request_pending && <span className="chip warn" style={{ marginLeft: 4 }}>მოთხოვნა</span>}</td>
                <td><span className={`chip ${CAPA_ST[c.status][0]}`}>{CAPA_ST[c.status][1]}</span></td>
                <td className="small">{c.effectiveness_result ? <span className={`chip ${c.effectiveness_result === 'effective' ? 'ok' : 'danger'}`}>{c.effectiveness_result === 'effective' ? 'ეფექტიანი' : 'არაეფექტიანი'}</span>
                  : c.effectiveness_pending ? <span className="chip warn">შესამოწმებელი</span> : c.effectiveness_due ? `ვადა ${tsDate(c.effectiveness_due)}` : '—'}</td>
              </tr>))}
              {!q.data?.length && <tr><td colSpan={7} className="muted">ქმედება არ არის</td></tr>}
            </tbody>
          </table>
        </div>)}
    </div>
  );
}
