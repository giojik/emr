import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { BarChart } from '../../components/charts';
import { ErrorBox, Loading, Modal } from '../../components/ui';
import { useModuleEnabled, useModules } from '../../lib/modules';
import { Bar } from '../finance/types';
import {
  type ByDept, CATEGORIES, CATEGORY_KA, changeTone, DIR_KA, type Drill, downloadFile, fmtTime, fmtVal, type KpiValue, type Overview, type RptMeta, type Series,
  shiftDays, STATUS_KA, STATUS_TONE, UNIT_FULL,
} from './types';
import Finance, { doctorRevenueVisible } from './Finance';
import Ops from './Ops';
import { AttentionPanel, DeptRanking, type Headline, HeadlineTiles, LivePanel, TrendCard } from './Panels';

type Tab = 'executive' | 'department' | 'ops' | 'finance' | 'overview' | 'stock';
const TAB_KA: Record<Tab, string> = { executive: 'ხელმძღვანელობა', department: 'განყოფილება', ops: 'ოპერაციული', finance: 'ფინანსები', overview: 'KPI მიმოხილვა', stock: 'მარაგის დღეები' };

/** მენეჯერული დაფა (0060): KPI მიმოხილვა rpt_* ფაქტებიდან — პერიოდი, განყოფილება (ხედვის არის ფარგლებში), შედარება, სამიზნეები, ჩაღრმავება, ექსპორტი */
export default function Dashboard() {
  const mods = useModules(); const enabled = useModuleEnabled('reporting');
  const meta = useQuery({ queryKey: ['rpt-meta'], queryFn: () => api<RptMeta>('/reporting/meta'), enabled });
  const today = meta.data?.today ?? new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(today.slice(0, 8) + '01'); const [to, setTo] = useState(today);
  const [dept, setDept] = useState(''); const [compare, setCompare] = useState<string>('');
  const [tabSel, setTab] = useState<Tab | null>(null);
  const [report, setReport] = useState(false);
  if (mods.isLoading) return <div className="content"><Loading /></div>;
  if (!enabled) return <div className="content"><div className="alert warn">მოდული „მენეჯერული რეპორტინგი“ გამორთულია (ადმინისტრირება → მოდულები).</div></div>;
  if (meta.error) return <div className="content"><ErrorBox error={meta.error} /></div>;
  if (!meta.data) return <div className="content"><Loading /></div>;
  const m = meta.data;
  const cmp = compare || m.settings.compare_default;
  const tabs = ((m.scope.all ? ['executive', 'department', 'ops', 'finance', 'overview', 'stock'] : ['department', 'ops', 'finance', 'overview', 'stock']) as Tab[])
    .filter((t) => t !== 'finance' || m.scope.finance);
  const tab: Tab = tabSel && tabs.includes(tabSel) ? tabSel : tabs[0];
  const periodTab = tab !== 'stock';
  const preset = (k: 'month' | 'prev' | '30' | 'year') => {
    if (k === 'month') { setFrom(today.slice(0, 8) + '01'); setTo(today); }
    if (k === '30') { setFrom(shiftDays(today, -29)); setTo(today); }
    if (k === 'year') { setFrom(`${today.slice(0, 4)}-01-01`); setTo(today); }
    if (k === 'prev') { const e = shiftDays(today.slice(0, 8) + '01', -1); setFrom(e.slice(0, 8) + '01'); setTo(e); }
  };
  return (
    <>
      <header className="topbar" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8, paddingBottom: 0 }}>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <h1 className="grow">მენეჯერული დაფა</h1>
          <span className="chip" title={`დღევანდელი მონაცემები ახლდება ყოველ ${m.settings.refresh_today_min} წუთში; ისტორია — ღამით`}>მონაცემები: {fmtTime(m.data_as_of)}</span>
          {(tab === 'executive' || tab === 'department') && <Link className="btn sm" to={`/dashboard/tv?view=${tab}${dept ? `&department_id=${dept}` : ''}`} target="_blank"
            title={`სრულეკრანიანი ხედი კედლის ეკრანისთვის — ახლდება ყოველ ${m.settings.tv_refresh_min ?? 5} წუთში, პაციენტის მონაცემების გარეშე`}>ეკრანის რეჟიმი</Link>}
          <button className="btn sm" type="button" onClick={() => setReport(true)} title="მენეჯერული ანგარიში — Excel (რამდენიმე ფურცელი) / PDF">ანგარიში</button>
          {periodTab && <>
            <div className="seg" role="group" aria-label="სწრაფი პერიოდი">
              <button type="button" onClick={() => preset('month')}>ეს თვე</button><button type="button" onClick={() => preset('prev')}>წინა თვე</button>
              <button type="button" onClick={() => preset('30')}>30 დღე</button><button type="button" onClick={() => preset('year')}>წელი</button>
            </div>
            <input className="input mono" type="date" style={{ height: 34, width: 150 }} aria-label="დან" value={from} max={to} onChange={(e) => setFrom(e.target.value || from)} />
            <input className="input mono" type="date" style={{ height: 34, width: 150 }} aria-label="მდე" value={to} min={from} onChange={(e) => setTo(e.target.value || to)} />
          </>}
        </div>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <nav aria-label="დაფა" className="row grow" style={{ gap: 2, flexWrap: 'wrap', minWidth: 0 }}>
            {tabs.map((t) => <button key={t} type="button" className={`admin-tab${tab === t ? ' active' : ''}`} style={{ background: 'none', borderTop: 0, borderLeft: 0, borderRight: 0, font: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap' }} onClick={() => setTab(t)}>{TAB_KA[t]}</button>)}
          </nav>
          <label className="row small">განყოფილება
            <select className="select" style={{ height: 34, width: 280 }} value={dept} onChange={(e) => setDept(e.target.value)}>
              <option value="">{m.scope.all ? 'მთელი კლინიკა' : m.scope.departments.length > 1 ? 'ყველა ჩემი განყოფილება' : m.scope.departments[0]?.name}</option>
              {(m.scope.all || m.scope.departments.length > 1) && m.scope.departments.filter((d) => d.is_active).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select></label>
          {periodTab && tab !== 'ops' && tab !== 'finance' && <label className="row small">შედარება
            <select className="select" style={{ height: 34 }} value={cmp} onChange={(e) => setCompare(e.target.value)}>
              <option value="prev">წინა პერიოდთან</option><option value="yoy">შარშანდელთან</option><option value="none">შედარების გარეშე</option>
            </select></label>}
        </div>
      </header>
      {tab === 'executive' || tab === 'department' ? <ThemeView key={tab} dash={tab} meta={m} from={from} to={to} dept={dept} compare={cmp} />
        : tab === 'ops' ? <Ops meta={m} from={from} to={to} dept={dept} />
        : tab === 'finance' ? <Finance meta={m} from={from} to={to} dept={dept} />
        : tab === 'overview' ? <OverviewView meta={m} from={from} to={to} dept={dept} compare={cmp} /> : <StockDays meta={m} dept={dept} />}
      {report && <ReportDialog meta={m} from={from} to={to} dept={dept} onClose={() => setReport(false)} />}
    </>
  );
}

/** თემატური დაფა (0061): ძირითადი KPI-ები (+13 თვე), ტრენდი, რეიტინგი, „ახლა“, „ყურადღება“ */
function ThemeView({ dash, meta, from, to, dept, compare }: { dash: 'executive' | 'department'; meta: RptMeta; from: string; to: string; dept: string; compare: string }) {
  const q = useQuery({ queryKey: ['rpt-headline', dash, from, to, dept, compare],
    queryFn: () => api<Headline>('/reporting/headline', { query: { dashboard: dash, from, to, department_id: dept, compare } }) });
  const [sel, setSel] = useState<string | null>(null);
  const k = q.data?.kpis.find((x) => x.code === sel) ?? q.data?.kpis.find((x) => !x.snapshot);
  return (
    <div className="content">
      <ErrorBox error={q.error} />
      {!q.data ? <Loading /> : <>
        {!meta.data_as_of && <div className="alert warn">მონაცემები ჯერ არ არის დათვლილი — ადმინისტრირება → რეპორტინგი → გადათვლა.</div>}
        <HeadlineTiles h={q.data} selected={k?.code} onSelect={setSel} />
        {k && <div style={{ display: 'grid', gridTemplateColumns: dash === 'executive' && !dept ? 'minmax(0, 3fr) minmax(0, 2fr)' : '1fr', gap: 10 }}>
          <TrendCard kpi={k.code} dept={dept} unit={k.unit} />
          {dash === 'executive' && !dept && <DeptRanking kpi={k.code} from={from} to={to} unit={k.unit} />}
        </div>}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 3fr) minmax(0, 2fr)', gap: 10, alignItems: 'start' }}>
          <LivePanel dept={dept} showDepartments={dash === 'executive'} />
          <AttentionPanel dept={dept} />
        </div>
      </>}
    </div>
  );
}

function OverviewView({ meta, from, to, dept, compare }: { meta: RptMeta; from: string; to: string; dept: string; compare: string }) {
  const q = useQuery({ queryKey: ['rpt-overview', from, to, dept, compare], queryFn: () => api<Overview>('/reporting/overview', { query: { from, to, department_id: dept, compare } }) });
  const [open, setOpen] = useState<KpiValue | null>(null);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<unknown>(null);
  const exp = async (format: 'xlsx' | 'csv') => {
    setBusy(true); setErr(null);
    try { await downloadFile('/reporting/export', { dataset: 'overview', format, from, to, department_id: dept || undefined, compare }, `kpi_${from}_${to}.${format}`); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const d = q.data;
  return (
    <div className="content">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        {d?.compare && <span className="small muted">შედარება: {d.compare.from} — {d.compare.to}</span>}
        <span className="grow" />
        {!meta.scope.finance && <span className="small muted">ფინანსური მაჩვენებლები თქვენთვის არ ჩანს</span>}
        <button className="btn sm" type="button" disabled={busy || !d} onClick={() => exp('xlsx')}>Excel</button>
        <button className="btn sm" type="button" disabled={busy || !d} onClick={() => exp('csv')}>CSV</button>
      </div>
      <ErrorBox error={q.error ?? err} />
      {q.isLoading || !d ? <Loading /> : !meta.data_as_of ? <div className="alert warn">მონაცემები ჯერ არ არის დათვლილი — პირველი გადათვლა worker-ის გაშვებიდან რამდენიმე წუთში მოხდება (ან ადმინისტრირება → რეპორტინგი → გადათვლა).</div> :
        CATEGORIES.map((c) => {
          const list = d.kpis.filter((k) => k.category === c);
          if (!list.length) return null;
          return (
            <section key={c} className="stack" style={{ gap: 8 }}>
              <h2 style={{ fontSize: 15, margin: '6px 0 0' }}>{CATEGORY_KA[c]}</h2>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 10 }}>
                {list.map((k) => <Tile key={k.code} k={k} onOpen={() => setOpen(k)} />)}
              </div>
            </section>);
        })}
      {open && <KpiDetail k={open} meta={meta} from={from} to={to} dept={dept} onClose={() => setOpen(null)} />}
    </div>
  );
}

function Tile({ k, onOpen }: { k: KpiValue; onOpen: () => void }) {
  return (
    <button type="button" className="card card-pad" onClick={onOpen} title={`${k.definition}\n\nფორმულა: ${k.formula}`}
      style={{ textAlign: 'left', cursor: 'pointer', borderLeft: k.status ? `4px solid ${STATUS_TONE[k.status]}` : undefined, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span className="small muted">{k.name}{k.snapshot && <span className="chip" style={{ marginLeft: 6, height: 18 }}>ახლა</span>}</span>
      <span className="mono" style={{ fontSize: 22, fontWeight: 600 }}>{fmtVal(k.value, k.unit)}</span>
      <span className="row small" style={{ gap: 8, flexWrap: 'wrap' }}>
        {k.change_pct !== null && <span style={{ color: changeTone(k.direction, k.change_pct) }}>{k.change_pct > 0 ? '▲' : k.change_pct < 0 ? '▼' : '■'} {Math.abs(k.change_pct)}%</span>}
        {k.compare_value !== null && <span className="muted">იყო {fmtVal(k.compare_value, k.unit)}</span>}
        {k.target !== null && <span className="muted">სამიზნე {fmtVal(k.target, k.unit)}</span>}
      </span>
      {k.status && <span className="small" style={{ color: STATUS_TONE[k.status] }}>● {STATUS_KA[k.status]}</span>}
    </button>
  );
}

function KpiDetail({ k, meta, from, to, dept, onClose }: { k: KpiValue; meta: RptMeta; from: string; to: string; dept: string; onClose: () => void }) {
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
  const [grain, setGrain] = useState(days > 92 ? 'month' : days > 31 ? 'week' : 'day');
  const series = useQuery({ queryKey: ['rpt-series', k.code, from, to, dept, grain], enabled: !k.snapshot,
    queryFn: () => api<Series>('/reporting/series', { query: { kpi: k.code, from, to, department_id: dept, grain } }) });
  const byDept = useQuery({ queryKey: ['rpt-bydept', k.code, from, to], enabled: !dept,
    queryFn: () => api<ByDept>('/reporting/by-department', { query: { kpi: k.code, from, to } }) });
  const [drill, setDrill] = useState(false);
  const dq = useQuery({ queryKey: ['rpt-drill', k.code, from, to, dept], enabled: drill && !!k.drill,
    queryFn: () => api<Drill>('/reporting/drilldown', { query: { kpi: k.code, from, to, department_id: dept } }) });
  const [err, setErr] = useState<unknown>(null);
  const exp = (dataset: string, extra: Record<string, string> = {}) => downloadFile('/reporting/export', { dataset, format: 'xlsx', kpi: k.code, from, to, department_id: dept || undefined, ...extra },
    `${dataset}_${k.code}.xlsx`).catch(setErr);
  const maxDept = Math.max(0, ...(byDept.data?.rows.map((r) => Math.abs(r.value ?? 0)) ?? [0]));
  return (
    <Modal title={k.name} onClose={onClose} width={900}>
      <div className="stack" style={{ gap: 12 }}>
        <div className="row" style={{ flexWrap: 'wrap', gap: 16, alignItems: 'baseline' }}>
          <span className="mono" style={{ fontSize: 26, fontWeight: 600 }}>{fmtVal(k.value, k.unit)}</span>
          {k.change_pct !== null && <span style={{ color: changeTone(k.direction, k.change_pct) }}>{k.change_pct > 0 ? '▲' : '▼'} {Math.abs(k.change_pct)}% (იყო {fmtVal(k.compare_value, k.unit)})</span>}
          {k.target !== null && <span className="small">სამიზნე: <strong>{fmtVal(k.target, k.unit)}</strong>{k.warn !== null && <> · გაფრთხილება: {fmtVal(k.warn, k.unit)}</>}
            {' '}<span className="muted">({k.target_level === 'department' ? 'განყოფილების' : 'კლინიკის'})</span></span>}
        </div>
        <dl className="small" style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 12px', margin: 0 }}>
          <dt className="muted">განმარტება</dt><dd style={{ margin: 0 }}>{k.definition}</dd>
          <dt className="muted">გამოთვლა</dt><dd style={{ margin: 0 }}>{k.formula}</dd>
          <dt className="muted">წყარო</dt><dd style={{ margin: 0 }} className="mono">{k.source}</dd>
          <dt className="muted">ერთეული</dt><dd style={{ margin: 0 }}>{UNIT_FULL[k.unit]} · {DIR_KA[k.direction]}</dd>
          <dt className="muted">პერიოდი</dt><dd style={{ margin: 0 }}>{k.snapshot ? 'მომენტალური (ბოლო გადათვლის მდგომარეობა)' : `${from} — ${to}`}</dd>
        </dl>
        <ErrorBox error={err} />
        {!k.snapshot && (
          <section className="card card-pad stack" style={{ gap: 8 }}>
            <div className="row"><strong className="grow">დინამიკა</strong>
              <div className="seg" role="group" aria-label="ინტერვალი">
                {(['day', 'week', 'month'] as const).map((g) => <button key={g} type="button" aria-pressed={grain === g} onClick={() => setGrain(g)}>{{ day: 'დღე', week: 'კვირა', month: 'თვე' }[g]}</button>)}
              </div>
              <button className="btn sm" type="button" onClick={() => exp('series', { grain })}>Excel</button></div>
            <ErrorBox error={series.error} />
            {series.data ? <BarChart points={series.data.points.map((p) => ({ label: p.period.length > 7 ? p.period.slice(5) : p.period, value: p.value, hint: `${p.period}: ${fmtVal(p.value, k.unit)}` }))}
              format={(v) => fmtVal(v, k.unit)} /> : <Loading />}
          </section>)}
        {!dept && (
          <section className="card" style={{ overflowX: 'auto' }}>
            <div className="card-pad row" style={{ paddingBottom: 0 }}><strong className="grow">განყოფილებებით</strong><button className="btn sm" type="button" onClick={() => exp('by_department')}>Excel</button></div>
            <ErrorBox error={byDept.error} />
            {!byDept.data ? <Loading /> : (
              <table className="table">
                <tbody>
                  {byDept.data.rows.map((r) => <tr key={r.department_id}><td>{r.department_name}</td><td className="num mono">{fmtVal(r.value, k.unit)}</td>
                    <td style={{ width: 160 }}><Bar value={r.value ?? 0} max={maxDept} tone={r.status ? STATUS_TONE[r.status] : undefined} /></td></tr>)}
                  {!byDept.data.rows.length && <tr><td className="muted">მონაცემი არ არის</td></tr>}
                  {byDept.data.scope_all && <tr><td><strong>მთელი კლინიკა</strong></td><td className="num mono"><strong>{fmtVal(byDept.data.total, k.unit)}</strong></td><td /></tr>}
                </tbody>
              </table>)}
          </section>)}
        {k.drill && (
          <section className="card" style={{ overflowX: 'auto' }}>
            <div className="card-pad row" style={{ paddingBottom: 0 }}>
              <strong className="grow">შემთხვევები</strong>
              {!drill ? <button className="btn sm" type="button" onClick={() => setDrill(true)}>ჩვენება</button> : <button className="btn sm" type="button" onClick={() => exp('drilldown')}>Excel</button>}
            </div>
            {drill && <>
              <p className="hint card-pad" style={{ margin: 0 }}>{meta.scope.phi ? 'პაციენტის მონაცემები ჩანს — ნახვა აუდიტში იწერება.' : 'პაციენტი — ინიციალებით (სრული მონაცემი — უფლება „რეპორტების პერსონალური მონაცემები“).'}</p>
              <ErrorBox error={dq.error} />
              {!dq.data ? <Loading /> : (
                <table className="table">
                  <thead><tr>{dq.data.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                  <tbody>{dq.data.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={typeof c === 'number' ? 'num mono' : j === 0 ? 'mono small' : 'small'}>{c ?? '—'}</td>)}</tr>)}
                    {!dq.data.rows.length && <tr><td colSpan={dq.data.columns.length} className="muted">შემთხვევა არ არის</td></tr>}</tbody>
                </table>)}
              {dq.data?.truncated && <p className="hint card-pad">ნაჩვენებია პირველი 2000 — სრული სია ექსპორტით ან უფრო მოკლე პერიოდით.</p>}
            </>}
          </section>)}
      </div>
    </Modal>
  );
}

/** მენეჯერული ანგარიში (0063): პერიოდი → xlsx (ფურცლები) / PDF (1–2 გვერდი); ექიმის ფურცლები — მხოლოდ Excel-ში, წვდომით */
function ReportDialog({ meta, from, to, dept, onClose }: { meta: RptMeta; from: string; to: string; dept: string; onClose: () => void }) {
  const prevEnd = shiftDays(meta.today.slice(0, 8) + '01', -1);
  const [f, setF] = useState(prevEnd.slice(0, 8) + '01'); const [t, setT] = useState(prevEnd);
  const [docs, setDocs] = useState(false); const [busy, setBusy] = useState(''); const [err, setErr] = useState<unknown>(null);
  const canDocs = meta.settings.doctor_breakdown !== 'off' && (meta.scope.all || meta.settings.doctor_breakdown === 'scoped');
  const get = async (format: 'xlsx' | 'pdf') => {
    setBusy(format); setErr(null);
    try { await downloadFile('/reporting/report', { from: f, to: t, format, department_id: dept || undefined, doctors: format === 'xlsx' && docs ? '1' : undefined }, `report_${f}_${t}.${format}`); }
    catch (e) { setErr(e); } finally { setBusy(''); }
  };
  const days = Math.round((Date.parse(t) - Date.parse(f)) / 86_400_000) + 1;
  return (
    <Modal title="მენეჯერული ანგარიში" onClose={onClose} width={560}>
      <div className="stack" style={{ gap: 12 }}>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <div className="seg" role="group" aria-label="პერიოდი">
            <button type="button" onClick={() => { setF(prevEnd.slice(0, 8) + '01'); setT(prevEnd); }}>წინა თვე</button>
            <button type="button" onClick={() => { setF(meta.today.slice(0, 8) + '01'); setT(meta.today); }}>ეს თვე</button>
            <button type="button" onClick={() => { setF(from); setT(to); }}>დაფის პერიოდი</button>
          </div>
          <input className="input mono" type="date" style={{ height: 32, width: 150 }} aria-label="დან" value={f} max={t} onChange={(e) => setF(e.target.value || f)} />
          <input className="input mono" type="date" style={{ height: 32, width: 150 }} aria-label="მდე" value={t} min={f} onChange={(e) => setT(e.target.value || t)} />
        </div>
        <p className="small" style={{ margin: 0 }}>{dept ? meta.scope.departments.find((d) => d.id === dept)?.name : meta.scope.all ? 'მთელი კლინიკა' : 'ჩემი განყოფილებები'} · {days} დღე
          {days > 366 && <span style={{ color: 'var(--danger-ink)' }}> — მაქსიმუმ 1 წელი</span>}</p>
        <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
          <li><strong>Excel</strong> — შეჯამება (KPI, წინა პერიოდი, შარშან, სამიზნე), ტრენდი 13 თვე, ნაკადი, საწოლები, საოპერაციო, კვლევები, ლაბორატორია, მარაგი
            {meta.scope.finance && ', ფინანსები, გადამხდელები'}{meta.scope.finance && meta.scope.all && !dept && ', დებიტორები, კრედიტორები'}.</li>
          <li><strong>PDF</strong> — 1–2 გვერდი: KPI ცხრილი, 13 თვე, ფინანსები მოკლედ.</li>
        </ul>
        {canDocs && <label className="row small"><input type="checkbox" checked={docs} onChange={(e) => setDocs(e.target.checked)} /> ექიმის ფურცლები (მხოლოდ Excel{doctorRevenueVisible(meta) ? ', შემოსავლით' : ''}) — ჩამოტვირთვა აუდიტში იწერება</label>}
        <p className="hint" style={{ margin: 0 }}>მხოლოდ აგრეგირებული მონაცემები, პაციენტის მონაცემების გარეშე. განრიგით გაგზავნა — ადმინისტრირება → რეპორტინგი.</p>
        <ErrorBox error={err} />
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn" type="button" disabled={!!busy || days > 366} onClick={() => get('pdf')}>{busy === 'pdf' ? 'მზადდება…' : 'PDF'}</button>
          <button className="btn primary" type="button" disabled={!!busy || days > 366} onClick={() => get('xlsx')}>{busy === 'xlsx' ? 'მზადდება…' : 'Excel'}</button>
        </div>
      </div>
    </Modal>
  );
}

interface StockRow { location_id: string; location_name: string; department_name: string | null; item_id: string; item_code: string; item_name: string; unit: string; qty: number; value: number;
  avg_daily_use: number; days_of_supply: number | null; expiring_value_90: number; expired_value: number; low: boolean }
function StockDays({ meta, dept }: { meta: RptMeta; dept: string }) {
  const [only, setOnly] = useState(true);
  const q = useQuery({ queryKey: ['rpt-stock', dept, only], queryFn: () => api<{ window_days: number; alert_days: number; computed_at: string | null; rows: StockRow[] }>('/reporting/stock-days',
    { query: { department_id: dept, only_low: only ? 'true' : undefined } }) });
  const [err, setErr] = useState<unknown>(null);
  return (
    <div className="content">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <label className="row small"><input type="checkbox" checked={only} onChange={(e) => setOnly(e.target.checked)} /> მხოლოდ დაბალი მარაგი (&lt; {meta.settings.stock_days_alert} დღე)</label>
        <span className="grow" />
        <span className="small muted">ხარჯი — ბოლო {meta.settings.stock_days_window} დღის საშუალო · {fmtTime(q.data?.computed_at ?? null)}</span>
        <button className="btn sm" type="button" onClick={() => downloadFile('/reporting/export', { dataset: 'stock_days', format: 'xlsx', department_id: dept || undefined, only_low: only ? 'true' : undefined }, 'stock_days.xlsx').catch(setErr)}>Excel</button>
      </div>
      <ErrorBox error={q.error ?? err} />
      {!q.data ? <Loading /> : (
        <section className="card" style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead><tr><th>ლოკაცია</th><th>პოზიცია</th><th className="num">ნაშთი</th><th className="num">დღიური ხარჯი</th><th className="num">დღე</th><th className="num">ღირებულება</th><th className="num">90 დღეში ვადა</th></tr></thead>
            <tbody>
              {q.data.rows.map((r) => (
                <tr key={`${r.location_id}-${r.item_id}`}>
                  <td>{r.location_name}{r.department_name && <div className="small muted">{r.department_name}</div>}</td>
                  <td><span className="mono small muted">{r.item_code}</span> {r.item_name}</td>
                  <td className="num mono">{r.qty} <span className="muted small">{r.unit}</span></td>
                  <td className="num mono">{r.avg_daily_use}</td>
                  <td className="num mono" style={{ color: r.low ? 'var(--danger-ink)' : undefined }}><strong>{r.days_of_supply ?? '—'}</strong></td>
                  <td className="num mono">{fmtVal(r.value, 'gel')}</td>
                  <td className="num mono" style={{ color: r.expiring_value_90 ? 'var(--warn-ink)' : undefined }}>{r.expiring_value_90 ? fmtVal(r.expiring_value_90, 'gel') : '—'}</td>
                </tr>))}
              {!q.data.rows.length && <tr><td colSpan={7} className="muted">{only ? 'დაბალი მარაგი არ არის' : 'მონაცემი არ არის'}</td></tr>}
            </tbody>
          </table>
        </section>)}
    </div>
  );
}
