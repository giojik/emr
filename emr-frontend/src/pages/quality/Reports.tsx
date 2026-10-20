import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import { Sparkline } from '../../components/charts';
import { ErrorBox, Loading } from '../../components/ui';
import { downloadFile, fmtTime, shiftDays } from '../reporting/types';
import {
  type Cnt, EVENT_KA, type EventType, type QrCapa, type QrFactors, type QrIndicators, type QrMeta, type QrPivot, type QrSummary, type QrTimeliness, type QrTotals,
} from './types';

/**
 * ხარისხის ანგარიშები (0066): შეჯამება + 13 თვე, განაწილება, ინდიკატორები, ვადები, CAPA, ფაქტორები; Excel / PDF; რეესტრი (დეპერსონალიზებული).
 * quality_view — მხოლოდ აგრეგატები („< N“ — მცირე რიცხვი დამალულია), ჩაღრმავების გარეშე.
 */
type Sec = 'summary' | 'pivot' | 'indicators' | 'timeliness' | 'capa' | 'factors';
const SEC_KA: Record<Sec, string> = { summary: 'შეჯამება', pivot: 'განაწილება', indicators: 'ინდიკატორები', timeliness: 'ვადები და შესრულება', capa: 'ქმედებები (CAPA)', factors: 'ხელშემწყობი ფაქტორები' };
type Period = 'month' | 'prev' | 'q' | 'year' | 'custom';
const EV_COLOR: Record<EventType, string> = { harm: 'var(--danger)', no_harm: 'var(--warn-ink)', near_miss: 'var(--accent)', hazard: 'var(--muted)' };
const STATUS_TONE: Record<string, string> = { green: 'var(--ok-ink)', yellow: 'var(--warn-ink)', red: 'var(--danger-ink)' };
const STATUS_KA: Record<string, string> = { green: 'სამიზნე შესრულებულია', yellow: 'გაფრთხილება', red: 'სამიზნე არ სრულდება' };

function periodOf(p: Period, today: string, custom: { from: string; to: string }) {
  const first = `${today.slice(0, 8)}01`;
  if (p === 'month') return { from: first, to: today };
  if (p === 'prev') { const end = shiftDays(first, -1); return { from: `${end.slice(0, 8)}01`, to: end }; }
  if (p === 'q') { const [y, m] = today.split('-').map(Number); const d = new Date(Date.UTC(y, m - 3, 1)); return { from: d.toISOString().slice(0, 10), to: today }; }
  if (p === 'year') { const [y, m] = today.split('-').map(Number); const d = new Date(Date.UTC(y, m - 12, 1)); return { from: d.toISOString().slice(0, 10), to: today }; }
  return custom;
}

export default function QmReports() {
  const meta = useQuery({ queryKey: ['qr-meta'], queryFn: () => api<QrMeta>('/quality/reports/meta') });
  const [sec, setSec] = useState<Sec>('summary');
  const [period, setPeriod] = useState<Period>('month');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [dept, setDept] = useState(''); const [svc, setSvc] = useState(''); const [cat, setCat] = useState(''); const [et, setEt] = useState(''); const [harm, setHarm] = useState('');
  const [sentinel, setSentinel] = useState(false);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<unknown>(null);
  if (meta.error) return <div className="content"><ErrorBox error={meta.error} /></div>;
  if (!meta.data) return <div className="content"><Loading /></div>;
  const m = meta.data;
  const p = periodOf(period, m.today, custom.from && custom.to ? custom : { from: `${m.today.slice(0, 8)}01`, to: m.today });
  const q: Record<string, string | undefined> = { from: p.from, to: p.to, department_id: dept || undefined, service_type: svc || undefined, category_id: cat || undefined,
    event_type: et || undefined, harm: harm || undefined, sentinel: sentinel ? '1' : undefined };
  const dl = async (path: string, extra: Record<string, string>, name: string) => {
    setBusy(true); setErr(null);
    try { await downloadFile(path, { ...q, ...extra }, name); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <div className="content">
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div className="seg" role="group" aria-label="პერიოდი">
          {([['month', 'ეს თვე'], ['prev', 'წინა თვე'], ['q', '3 თვე'], ['year', '12 თვე'], ['custom', 'თარიღები']] as [Period, string][]).map(([k, l]) =>
            <button key={k} type="button" aria-pressed={period === k} onClick={() => setPeriod(k)}>{l}</button>)}
        </div>
        {period === 'custom' && <>
          <input className="input" type="date" style={{ maxWidth: 150, height: 38 }} aria-label="თარიღიდან" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} />
          <input className="input" type="date" style={{ maxWidth: 150, height: 38 }} aria-label="თარიღამდე" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} /></>}
        <select className="select" style={{ maxWidth: 220, height: 38 }} aria-label="განყოფილება" value={dept} onChange={(e) => setDept(e.target.value)}>
          <option value="">{m.scope_all ? 'მთელი კლინიკა' : 'ყველა ჩემი განყოფილება'}</option>{m.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
        <select className="select" style={{ maxWidth: 190, height: 38 }} aria-label="მომსახურების ტიპი" value={svc} onChange={(e) => setSvc(e.target.value)}>
          <option value="">ყველა მომსახურება</option>{m.service_types.map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}</select>
        <select className="select" style={{ maxWidth: 200, height: 38 }} aria-label="კატეგორია" value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="">ყველა კატეგორია</option>{m.categories.filter((c) => !c.parent_id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <select className="select" style={{ maxWidth: 190, height: 38 }} aria-label="ტიპი" value={et} onChange={(e) => setEt(e.target.value)}>
          <option value="">ყველა ტიპი</option>{m.event_types.map((x) => <option key={x.code} value={x.code}>{EVENT_KA[x.code as EventType]?.[0] ?? x.name}</option>)}</select>
        <select className="select" style={{ maxWidth: 160, height: 38 }} aria-label="ზიანი" value={harm} onChange={(e) => setHarm(e.target.value)}>
          <option value="">ნებისმიერი ზიანი</option>{m.harms.map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}</select>
        <label className="row small"><input type="checkbox" checked={sentinel} onChange={(e) => setSentinel(e.target.checked)} /> სენტინელური</label>
      </div>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div className="seg" role="group" aria-label="სექცია">{(Object.keys(SEC_KA) as Sec[]).map((k) => <button key={k} type="button" aria-pressed={sec === k} onClick={() => setSec(k)}>{SEC_KA[k]}</button>)}</div>
        <span className="grow" />
        <span className="small muted">{p.from} — {p.to} · {m.date_basis === 'reported' ? 'შეტყობინების' : 'მოვლენის'} თარიღით · მონაცემები: {fmtTime(m.data_as_of)}</span>
        <button className="btn sm" type="button" disabled={busy} onClick={() => dl('/quality/reports/export', { format: 'xlsx' }, `qm_report_${p.from}_${p.to}.xlsx`)}>Excel</button>
        <button className="btn sm" type="button" disabled={busy} onClick={() => dl('/quality/reports/export', { format: 'pdf' }, `qm_report_${p.from}_${p.to}.pdf`)}>PDF</button>
        {m.can_registry && <button className="btn sm" type="button" disabled={busy} title="სახელმწიფოსთვის / გარე ანგარიშისთვის — პაციენტის, ავტორისა და აღწერის გარეშე"
          onClick={() => dl('/quality/reports/registry', { format: 'xlsx' }, `qm_registry_${p.from}_${p.to}.xlsx`)}>რეესტრი (დეპერსონალიზებული)</button>}
      </div>
      {!m.reporting_enabled && <div className="alert warn">მოდული „მენეჯერული რეპორტინგი“ გამორთულია — რაოდენობები და ინდიკატორები (აგრეგაცია) არ განახლდება.</div>}
      {m.access === 'view' && m.min_cell > 0 && <span className="small muted">„&lt; {m.min_cell}“ — მცირე რიცხვი დამალულია (კონფიდენციალურობა).</span>}
      <ErrorBox error={err} />
      {sec === 'summary' && <Summary q={q} m={m} />}
      {sec === 'pivot' && <Pivot q={q} m={m} />}
      {sec === 'indicators' && <Indicators q={q} m={m} />}
      {sec === 'timeliness' && <Timeliness q={q} m={m} />}
      {sec === 'capa' && <Capa q={q} m={m} />}
      {sec === 'factors' && <Factors q={q} m={m} />}
    </div>
  );
}

type P = { q: Record<string, string | undefined>; m: QrMeta };
const c = (v: Cnt | undefined, m: QrMeta, sfx = '') => (v === null || v === undefined ? (m.min_cell ? `< ${m.min_cell}` : '—') : `${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}${sfx}`);
/** საწოლ-დღე / მნიშვნელი: მცირეზე — მეტი ათწილადი */
const den = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: v < 10 ? 3 : 1 });
/** საათები: 1-ზე ნაკლები — წუთებში */
const hrs = (v: number | null) => (v === null ? '—' : v < 1 ? `${Math.round(v * 60)} წთ` : `${v} სთ`);
const useQr = <T,>(path: string, q: Record<string, string | undefined>) => useQuery({ queryKey: ['qr', path, q], queryFn: () => api<T>(`/quality/reports/${path}`, { query: q }) });

function Tile({ label, v, prev, m, sfx = '', tone, hint }: { label: string; v: Cnt; prev?: Cnt; m: QrMeta; sfx?: string; tone?: string; hint?: string }) {
  const ch = v !== null && prev !== null && prev !== undefined && prev !== 0 ? Math.round(((v - prev) / Math.abs(prev)) * 1000) / 10 : null;
  return (
    <div className="card card-pad stack" style={{ gap: 2 }} title={hint}>
      <span className="small muted">{label}</span>
      <strong style={{ fontSize: 22, color: tone }}>{c(v, m, sfx)}</strong>
      {prev !== undefined && <span className="small muted">წინა: {c(prev, m, sfx)}{ch !== null ? ` · ${ch > 0 ? '+' : ''}${ch}%` : ''}</span>}
    </div>
  );
}

function Summary({ q, m }: P) {
  const r = useQr<QrSummary>('summary', q);
  if (r.error) return <ErrorBox error={r.error} />;
  if (!r.data) return <Loading />;
  const d = r.data; const T = d.totals; const V = d.prev;
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10 } as const;
  const tiles: [string, keyof QrTotals, string, string?, string?][] = [
    ['ინციდენტები (მიღებული)', 'n', ''], ['ზიანით', 'harm', '', 'var(--danger-ink)'], ['ზიანის გარეშე', 'no_harm', ''], ['near-miss', 'near_miss', ''], ['სახიფათო მდგომარეობა', 'hazard', ''],
    ['სენტინელური', 'sentinel', '', 'var(--danger-ink)'], ['near-miss თანაფარდობა', 'near_miss_ratio', '', undefined, 'near-miss / (ზიანით + ზიანის გარეშე) — მაღალი უკეთესია'],
    ['შეტყობინება 1000 საწოლ-დღეზე', 'report_rate', '', undefined, 'სტაციონარის შეტყობინებები (ყველა ტიპი) / დაკავებული საწოლ-დღე × 1000'],
    ['ტრიაჟი ვადაში', 'triage_on_time_pct', '%'], ['ანონიმური', 'anonymous_pct', '%']];
  const max = Math.max(1, ...d.trend.total.map((x) => x ?? 0), ...d.trend.prev_year.map((x) => x ?? 0));
  return (
    <>
      <div style={grid}>
        {tiles.map(([l, k, sfx, tone, hint]) => <Tile key={k} label={l} v={T[k] as Cnt} prev={V[k] as Cnt} m={m} sfx={sfx} tone={tone} hint={hint} />)}
        {d.pending_triage && <Tile label="ტრიაჟს ელოდება (ახლა)" v={d.pending_triage.n} m={m} tone={d.pending_triage.overdue ? 'var(--danger-ink)' : undefined}
          hint={`აქედან ვადაგადაცილებული: ${d.pending_triage.overdue}`} />}
      </div>
      <span className="small muted">შედარება: წინა პერიოდი {d.compare.from} — {d.compare.to}. უარყოფილი შეტყობინება და დუბლიკატი არ ითვლება.</span>
      <section className="card card-pad stack" style={{ gap: 8 }}>
        <strong>ბოლო 13 თვე — ტიპებით</strong>
        <svg viewBox={`0 0 820 210`} width="100%" role="img" aria-label="13 თვე ტიპებით" style={{ maxHeight: 260 }}>
          {d.trend.months.map((mo, i) => {
            const bw = 760 / d.trend.months.length; const x = 40 + i * bw + bw * 0.15; const w = bw * 0.7;
            let y = 180;
            return (
              <g key={mo}>
                {(Object.keys(EV_COLOR) as EventType[]).map((e) => {
                  const v = d.trend.series[e][i] ?? 0; const h = (v / max) * 160; y -= h;
                  return v > 0 ? <rect key={e} x={x} y={y} width={w} height={h} fill={EV_COLOR[e]}><title>{`${mo} · ${EVENT_KA[e][0]}: ${v}`}</title></rect> : null;
                })}
                {d.trend.prev_year[i] !== null && (d.trend.prev_year[i] ?? 0) > 0 && <line x1={x - 2} x2={x + w + 2} y1={180 - ((d.trend.prev_year[i] ?? 0) / max) * 160} y2={180 - ((d.trend.prev_year[i] ?? 0) / max) * 160}
                  stroke="var(--ink)" strokeWidth={1.5} strokeDasharray="4 3"><title>{`${mo} · შარშან: ${d.trend.prev_year[i]}`}</title></line>}
                <text x={x + w / 2} y={196} fontSize="10" textAnchor="middle" fill="var(--muted)">{mo.slice(2)}</text>
                <text x={x + w / 2} y={y - 4} fontSize="10" textAnchor="middle" fill="var(--ink-2)">{d.trend.total[i] === null ? `<${m.min_cell}` : d.trend.total[i] || ''}</text>
              </g>);
          })}
          <line x1={36} x2={806} y1={180} y2={180} stroke="var(--line)" />
        </svg>
        <div className="row small" style={{ gap: 14, flexWrap: 'wrap' }}>
          {(Object.keys(EV_COLOR) as EventType[]).map((e) => <span key={e} className="row" style={{ gap: 5 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: EV_COLOR[e], display: 'inline-block' }} />{EVENT_KA[e][0]}</span>)}
          <span className="row" style={{ gap: 5 }}><svg width="18" height="6" aria-hidden="true"><line x1="0" x2="18" y1="3" y2="3" stroke="var(--ink)" strokeWidth="1.5" strokeDasharray="4 3" /></svg>შარშან (სულ)</span>
        </div>
      </section>
    </>
  );
}

const DRILL: Record<string, string> = { department: 'department_id', category: 'category_id', harm: 'harm', event_type: 'event_type', service_type: 'service_type' };
function Pivot({ q, m }: P) {
  const nav = useNavigate();
  const [rows, setRows] = useState('category'); const [cols, setCols] = useState('harm');
  const r = useQr<QrPivot>('distribution', { ...q, rows, cols });
  const drill = m.can_drill && DRILL[rows];
  const go = (key: string) => {
    const sp = new URLSearchParams({ tab: 'registry', from: q.from ?? '', to: q.to ?? '' });
    for (const k of ['department_id', 'service_type', 'category_id', 'event_type', 'harm'] as const) if (q[k]) sp.set(k, q[k]!);
    if (q.sentinel) sp.set('sentinel', '1');
    sp.set(DRILL[rows], key);
    nav(`/quality?${sp.toString()}`);
  };
  return (
    <section className="card card-pad stack" style={{ gap: 10 }}>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <label className="row small">მწკრივები <select className="select" style={{ height: 34 }} value={rows} onChange={(e) => { setRows(e.target.value); if (e.target.value === cols) setCols('none'); }}>
          {m.dims.map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}</select></label>
        <label className="row small">სვეტები <select className="select" style={{ height: 34 }} value={cols} onChange={(e) => setCols(e.target.value)}>
          <option value="none">— (მხოლოდ ჯამი)</option>{m.dims.filter((x) => x.code !== rows).map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}</select></label>
        <span className="grow" />
        <button className="btn sm" type="button" onClick={() => downloadFile('/quality/reports/export', { ...q, format: 'csv', dataset: 'distribution', rows, cols }, `qm_${rows}_${cols}.csv`)}>CSV</button>
      </div>
      <ErrorBox error={r.error} />
      {!r.data ? <Loading /> : (
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead><tr><th>{m.dims.find((x) => x.code === rows)?.name}</th>{r.data.cols.map((x) => <th key={x.key} className="num">{x.label}</th>)}{cols !== 'none' && <th className="num">სულ</th>}<th className="num">%</th></tr></thead>
            <tbody>{r.data.rows.map((x, i) => (
              <tr key={x.key}>
                <td>{drill ? <button type="button" className="linklike" onClick={() => go(x.key)} title="რეესტრში ნახვა">{x.label}</button> : x.label}</td>
                {r.data!.cells[i].map((v, j) => <td key={j} className="num mono">{v === 0 ? <span className="muted">0</span> : c(v, m)}</td>)}
                {cols !== 'none' && <td className="num mono"><strong>{c(x.total, m)}</strong></td>}
                <td className="num mono muted">{x.pct ?? '—'}</td>
              </tr>))}
              {!r.data.rows.length && <tr><td colSpan={r.data.cols.length + 3} className="muted">მონაცემი არ არის</td></tr>}
              {r.data.rows.length > 0 && <tr><th>სულ</th>{r.data.cols.map((x) => <th key={x.key} className="num mono">{c(x.total, m)}</th>)}{cols !== 'none' && <th className="num mono">{c(r.data!.total, m)}</th>}<th /></tr>}
            </tbody>
          </table>
        </div>)}
      {drill && <span className="small muted">მწკრივის სახელზე დაჭერა — ინციდენტების რეესტრი იმავე ფილტრებით.</span>}
    </section>
  );
}

function Indicators({ q, m }: P) {
  const r = useQr<QrIndicators>('indicators', { from: q.from, to: q.to, department_id: q.department_id });
  const [open, setOpen] = useState<string | null>(null);
  if (r.error) return <ErrorBox error={r.error} />;
  if (!r.data) return <Loading />;
  return (
    <section className="card stack" style={{ gap: 0 }}>
      <table className="table">
        <thead><tr><th>ინდიკატორი</th><th className="num">მრიცხველი</th><th className="num">მნიშვნელი</th><th className="num">მნიშვნელობა</th><th className="num">სამიზნე</th><th>13 თვე</th><th /></tr></thead>
        <tbody>{r.data.rows.map((x) => (<>
          <tr key={x.code}>
            <td><strong>{x.name}</strong><div className="small muted">{x.description ?? ''}</div></td>
            <td className="num mono">{c(x.numerator, m)}</td>
            <td className="num mono" style={{ whiteSpace: 'nowrap' }}>{den(x.denominator_value)}<div className="small muted">{x.denominator_ka}</div></td>
            <td className="num mono"><strong style={{ color: x.status ? STATUS_TONE[x.status] : undefined }} title={x.status ? STATUS_KA[x.status] : undefined}>{c(x.value, m)}</strong>
              <div className="small muted">{x.per}-ზე</div></td>
            <td className="num mono">{x.target ?? '—'}</td>
            <td><Sparkline values={x.trend} /></td>
            <td>{x.by_department.length > 1 && <button className="btn sm" type="button" onClick={() => setOpen(open === x.code ? null : x.code)}>{open === x.code ? 'დამალვა' : 'განყოფილებებით'}</button>}</td>
          </tr>
          {open === x.code && x.by_department.map((b) => (
            <tr key={`${x.code}-${b.department_id}`} className="small">
              <td style={{ paddingLeft: 28 }}>{b.department_name}</td><td className="num mono">{c(b.numerator, m)}</td><td className="num mono">{den(b.denominator_value)}</td>
              <td className="num mono" style={{ color: b.status ? STATUS_TONE[b.status] : undefined }}>{c(b.value, m)}</td><td colSpan={3} />
            </tr>))}
        </>))}
          {!r.data.rows.length && <tr><td colSpan={7} className="muted">აქტიური ინდიკატორი არ არის (ხარისხი → ცნობარები → ინდიკატორები)</td></tr>}
        </tbody>
      </table>
      <span className="small muted card-pad">საწოლ-დღე — {r.data.occupancy_basis === 'midnight' ? 'შუაღამის დაკავებით' : 'დაკავებული საწოლ-საათებით / 24'} (მენეჯერული რეპორტინგის პარამეტრი). სამიზნეები — ადმინისტრირება → რეპორტინგი → KPI (qm_ind_*).
        ანგარიშის კატეგორიის / ტიპის / ზიანის / მომსახურების ფილტრი ინდიკატორზე არ ვრცელდება — მას თავისი განმარტება აქვს.</span>
    </section>
  );
}

const Kv = ({ k, v, hint }: { k: string; v: ReactNode; hint?: string }) => <div title={hint}><div className="small muted">{k}</div><div style={{ fontSize: 18, fontWeight: 600 }}>{v}</div></div>;
function Timeliness({ q, m }: P) {
  const r = useQr<QrTimeliness>('timeliness', q);
  if (r.error) return <ErrorBox error={r.error} />;
  if (!r.data) return <Loading />;
  const d = r.data; const n = (v: number | null, s = '') => (v === null ? '—' : `${v}${s}`);
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 14 } as const;
  return (
    <>
      <section className="card card-pad stack"><strong>ტრიაჟი</strong>
        <div style={grid}><Kv k="ინციდენტები" v={d.n} /><Kv k="მედიანა" v={hrs(d.triage.median_h)} /><Kv k="P90" v={hrs(d.triage.p90_h)} /><Kv k="საშუალო" v={hrs(d.triage.avg_h)} />
          <Kv k="ვადაში" v={n(d.triage.on_time_pct, '%')} /><Kv k="სენტინელური — მედიანა" v={hrs(d.triage.sentinel.median_h)} /><Kv k="სენტინელური — ვადაში" v={n(d.triage.sentinel.on_time_pct, '%')} /></div></section>
      <section className="card card-pad stack"><strong>ანალიზი და დახურვა</strong>
        <div style={grid}><Kv k="მიმოხილვა — ვადაში" v={n(d.analysis.review.on_time_pct, '%')} hint={`გაგზავნილი ${d.analysis.review.submitted} / ${d.analysis.review.n}`} />
          <Kv k="RCA — საჭირო" v={d.analysis.rca.n} /><Kv k="RCA — შესრულება" v={n(d.analysis.rca.completion_pct, '%')} hint="დამტკიცებული / საჭირო" />
          <Kv k="RCA — ვადაში" v={n(d.analysis.rca.on_time_pct, '%')} /><Kv k="RCA — დამტკიცებამდე (მედიანა)" v={n(d.analysis.rca.median_d, ' დღე')} />
          <Kv k="ანალიზი ვადაგადაცილებული (ახლა)" v={<span style={{ color: d.analysis.overdue_now ? 'var(--danger-ink)' : undefined }}>{d.analysis.overdue_now}</span>} />
          <Kv k="დახურული" v={`${d.closure.closed} (${n(d.closure.closed_pct, '%')})`} /><Kv k="დახურვამდე — მედიანა" v={n(d.closure.median_d, ' დღე')} /><Kv k="დახურვამდე — P90" v={n(d.closure.p90_d, ' დღე')} /></div></section>
      <section className="card" style={{ overflowX: 'auto' }}>
        <table className="table">
          <thead><tr><th>განყოფილება</th><th className="num">ინციდენტები</th><th className="num">ტრიაჟი მედიანა</th><th className="num">ტრიაჟი ვადაში %</th><th className="num">ანალიზი ვადაში %</th><th className="num">RCA შესრ. %</th><th className="num">დახურული %</th><th className="num">დახურვამდე მედ. დღე</th></tr></thead>
          <tbody>{d.by_department.map((x) => <tr key={x.department_id}><td>{x.department_name}</td><td className="num mono">{c(x.n, m)}</td><td className="num mono">{hrs(x.triage_median_h)}</td>
            <td className="num mono">{n(x.triage_on_time_pct)}</td><td className="num mono">{n(x.analysis_on_time_pct)}</td><td className="num mono">{n(x.rca_completion_pct)}</td><td className="num mono">{n(x.closed_pct)}</td><td className="num mono">{n(x.close_median_d)}</td></tr>)}
            {!d.by_department.length && <tr><td colSpan={8} className="muted">მონაცემი არ არის</td></tr>}</tbody>
        </table>
      </section>
      <span className="small muted">პერიოდის ინციდენტები (კოჰორტა) — ცოცხალი მონაცემი. ვადები — მოდულის პარამეტრებით (ტრიაჟი / მიმოხილვა / RCA).</span>
    </>
  );
}

function Capa({ q, m }: P) {
  const r = useQr<QrCapa>('capa', { from: q.from, to: q.to, department_id: q.department_id });
  if (r.error) return <ErrorBox error={r.error} />;
  if (!r.data) return <Loading />;
  const d = r.data; const n = (v: number | null, s = '') => (v === null ? '—' : `${v}${s}`);
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 14 } as const;
  return (
    <>
      <section className="card card-pad stack"><strong>ახლა</strong>
        <div style={grid}><Kv k="ღია" v={c(d.snapshot.open, m)} /><Kv k="შესრულებაში" v={c(d.snapshot.in_progress, m)} />
          <Kv k="ვადაგადაცილებული" v={<span style={{ color: d.snapshot.overdue ? 'var(--danger-ink)' : undefined }}>{c(d.snapshot.overdue, m)}</span>} />
          <Kv k="ვადაგადაცილება: 1–30 / 31–60 / 60+ დღე" v={`${c(d.snapshot.age.d1_30, m)} / ${c(d.snapshot.age.d31_60, m)} / ${c(d.snapshot.age.d60, m)}`} />
          <Kv k="ვადის მოთხოვნა (მოლოდინში)" v={c(d.snapshot.due_requests, m)} /><Kv k="ეფექტიანობის შემოწმება — დრო დადგა" v={c(d.snapshot.effectiveness_due, m)} /></div></section>
      <section className="card card-pad stack"><strong>პერიოდში</strong>
        <div style={grid}><Kv k="შექმნილი" v={c(d.period.created, m)} hint={`მაკორექტირებელი ${c(d.period.corrective, m)} · პრევენციული ${c(d.period.preventive, m)}`} />
          <Kv k="შესრულებული" v={c(d.period.done, m)} /><Kv k="ვადაში" v={n(d.period.on_time_pct, '%')} /><Kv k="გაუქმებული" v={c(d.period.cancelled, m)} />
          <Kv k="ეფექტიანობა შემოწმდა" v={c(d.period.checked, m)} /><Kv k="ეფექტიანი" v={n(d.period.effective_pct, '%')} /></div></section>
      <section className="card" style={{ overflowX: 'auto' }}>
        <table className="table">
          <thead><tr><th>განყოფილება</th><th className="num">ღია</th><th className="num">ვადაგადაცილებული</th><th className="num">შესრულებული</th><th className="num">ვადაში %</th><th className="num">ეფექტიანი %</th></tr></thead>
          <tbody>{d.by_department.map((x) => <tr key={x.department_id ?? '-'}><td>{x.department_name}</td><td className="num mono">{c(x.open, m)}</td><td className="num mono">{c(x.overdue, m)}</td>
            <td className="num mono">{c(x.done, m)}</td><td className="num mono">{n(x.on_time_pct)}</td><td className="num mono">{n(x.effective_pct)}</td></tr>)}
            {!d.by_department.length && <tr><td colSpan={6} className="muted">ქმედება არ არის</td></tr>}</tbody>
        </table>
      </section>
      <span className="small muted">განყოფილება — ქმედების განყოფილება ან პირველი მიბმული ინციდენტის. პასუხისმგებლის მიხედვით ჭრილი არ კეთდება.</span>
    </>
  );
}

function Factors({ q, m }: P) {
  const r = useQr<QrFactors>('factors', q);
  if (r.error) return <ErrorBox error={r.error} />;
  if (!r.data) return <Loading />;
  const d = r.data;
  const bar = (pct: number | null) => <div style={{ height: 8, borderRadius: 4, background: 'var(--line-soft)', minWidth: 120 }}><div style={{ width: `${pct ?? 0}%`, height: 8, borderRadius: 4, background: 'var(--accent)' }} /></div>;
  return (
    <section className="card card-pad stack">
      <span className="small muted">დამტკიცებული ანალიზები (მიმოხილვა / RCA): <strong>{c(d.analyses, m)}</strong> · % — ანალიზების წილი, სადაც ფაქტორი მონიშნულია (London Protocol).</span>
      <table className="table">
        <thead><tr><th>ჯგუფი / ფაქტორი</th><th className="num">ინციდენტები</th><th className="num">%</th><th style={{ width: '30%' }} /></tr></thead>
        <tbody>{d.groups.map((g) => (<>
          <tr key={g.id}><td><strong>{g.name}</strong></td><td className="num mono"><strong>{c(g.n, m)}</strong></td><td className="num mono">{g.pct ?? '—'}</td><td>{bar(g.pct)}</td></tr>
          {g.factors.map((f) => <tr key={f.id} className="small"><td style={{ paddingLeft: 28 }}>{f.name}</td><td className="num mono">{c(f.n, m)}</td><td className="num mono">{f.pct ?? '—'}</td><td>{bar(f.pct)}</td></tr>)}
        </>))}</tbody>
      </table>
    </section>
  );
}

