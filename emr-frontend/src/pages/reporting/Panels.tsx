import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useState, type CSSProperties, type ReactNode } from 'react';
import { api } from '../../api/client';
import { LineChart, Sparkline, StackBar } from '../../components/charts';
import { ErrorBox, Loading } from '../../components/ui';
import { Bar } from '../finance/types';
import { type ByDept, changeTone, fmtTime, fmtVal, type KpiValue, STATUS_KA, STATUS_TONE } from './types';

/** თემატური დაფების პანელები (0061): ძირითადი KPI-ები, „ახლა“, „ყურადღება“, ტრენდი, განყოფილებების რეიტინგი */
export interface Headline { from: string; to: string; months: string[]; data_from: string | null; data_as_of: string | null; compare: { from: string; to: string } | null;
  kpis: (KpiValue & { spark: (number | null)[] | null })[] }
export interface LiveDept { department_id: string; department_name: string; beds: number; occupied: number; free: number; reserved: number; cleaning: number; blocked: number;
  overflow_occupied: number; no_bed: number; admissions_today: number; discharges_today: number; encounters_today: number; or_planned: number; or_in_progress: number;
  or_completed: number; or_cancelled: number; lab_overdue: number; ext_overdue: number; dx_overdue: number }
export interface Live { generated_at: string; cached: boolean; thresholds: { lab_overdue_min: number; dx_overdue_hours: number }; totals: Omit<LiveDept, 'department_id' | 'department_name'> & { occupancy_now_pct: number | null };
  departments: LiveDept[] }
export interface Attention { from: string; to: string; stock_computed_at: string | null; items: { kind: string; severity: 'red' | 'yellow'; title: string; detail: string; value: number | null; code?: string; unit?: string; link?: string }[] }
export interface Trend { kpi: string; name: string; unit: string; direction: string; data_from: string | null; points: { month: string; from: string; to: string; partial: boolean; value: number | null; prev_year: number | null }[] }

/** დაჭერადი ფილა — ღილაკი; სხვაგან (TV) — ჩვეულებრივი ბარათი (disabled ღილაკი ტექსტს აფერმკრთალებს) */
function Tile({ onClick, title, style, children }: { onClick?: () => void; title: string; style: CSSProperties; children: ReactNode }) {
  return onClick ? <button type="button" className="card card-pad" title={title} onClick={onClick} style={{ ...style, cursor: 'pointer' }}>{children}</button>
    : <div className="card card-pad" title={title} style={style}>{children}</div>;
}

const KIND_UNIT: Record<string, string> = { stock_expired: 'gel', stock_expiring: 'gel', stock_dead: 'gel' };
const BED_COLORS = { occupied: 'var(--accent)', free: 'var(--line)', reserved: 'var(--info-ink)', cleaning: 'var(--warn-ink)', blocked: 'var(--danger-ink)' };

/** ძირითადი KPI-ები: ფილა + 13-თვიანი sparkline; დაჭერა → ტრენდი */
export function HeadlineTiles({ h, selected, onSelect, big }: { h: Headline; selected?: string; onSelect?: (code: string) => void; big?: boolean }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${big ? 280 : 220}px, 1fr))`, gap: 10 }}>
      {h.kpis.map((k) => (
        <Tile key={k.code} onClick={onSelect ? () => onSelect(k.code) : undefined} title={`${k.definition}\n\nფორმულა: ${k.formula}`}
          style={{ textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 4,
            borderLeft: k.status ? `4px solid ${STATUS_TONE[k.status]}` : undefined, outline: selected === k.code ? '2px solid var(--accent)' : undefined }}>
          <span className="small muted" style={big ? { fontSize: 16 } : undefined}>{k.name}</span>
          <span className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-end', gap: 8 }}>
            <span className="mono" style={{ fontSize: (big ? 38 : 24) * (fmtVal(k.value, k.unit).length > 10 ? 0.78 : 1), fontWeight: 600, whiteSpace: 'nowrap' }}>{fmtVal(k.value, k.unit)}</span>
            {k.spark && <Sparkline values={k.spark} color={k.status ? STATUS_TONE[k.status] : 'var(--accent)'} width={big ? 150 : 110} height={big ? 40 : 28} />}
          </span>
          <span className="row small" style={{ gap: 8, flexWrap: 'wrap', fontSize: big ? 15 : undefined }}>
            {k.change_pct !== null && <span style={{ color: changeTone(k.direction, k.change_pct) }}>{k.change_pct > 0 ? '▲' : k.change_pct < 0 ? '▼' : '■'} {Math.abs(k.change_pct)}%</span>}
            {k.target !== null && <span className="muted">სამიზნე {fmtVal(k.target, k.unit)}</span>}
            {k.status && <span style={{ color: STATUS_TONE[k.status] }}>● {STATUS_KA[k.status]}</span>}
          </span>
        </Tile>))}
      {!h.kpis.length && <div className="muted small">ძირითადი KPI არ არის არჩეული (ადმინისტრირება → რეპორტინგი → დაფები)</div>}
    </div>
  );
}

/** „ახლა“: საწოლები, დღევანდელი ნაკადი, საოპერაციო დღეს, ვადაგადაცილებული კვლევები */
export function LivePanel({ dept, refetchMs, big, showDepartments }: { dept: string; refetchMs?: number; big?: boolean; showDepartments?: boolean }) {
  const q = useQuery({ queryKey: ['rpt-live', dept], queryFn: () => api<Live>('/reporting/live', { query: { department_id: dept } }), refetchInterval: refetchMs ?? 60_000 });
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data) return <Loading />;
  const t = q.data.totals;
  const num = (label: string, v: number | string | null | undefined, tone?: string) => (
    <div className="stack" style={{ gap: 2, minWidth: big ? 150 : 110 }}><span className="small muted" style={big ? { fontSize: 15 } : undefined}>{label}</span>
      <span className="mono" style={{ fontSize: big ? 34 : 22, fontWeight: 600, color: tone }}>{v ?? '—'}</span></div>);
  return (
    <section className="card card-pad stack" style={{ gap: 12 }}>
      <div className="row"><strong className="grow" style={big ? { fontSize: 20 } : undefined}>ახლა</strong><span className="small muted">{fmtTime(q.data.generated_at)}</span></div>
      {t.beds > 0 && (
        <div className="stack" style={{ gap: 6 }}>
          <span className="small">საწოლები — დაკავებულია <strong className="mono">{t.occupied}</strong> / {t.beds}{t.occupancy_now_pct !== null && <> (<strong>{t.occupancy_now_pct}%</strong>)</>}
            {t.overflow_occupied > 0 && <> · დამატებით (overflow): <strong>{t.overflow_occupied}</strong></>}</span>
          <StackBar parts={[{ label: 'დაკავებული', value: t.occupied, color: BED_COLORS.occupied }, { label: 'თავისუფალი', value: t.free, color: BED_COLORS.free },
            { label: 'დაჯავშნილი', value: t.reserved, color: BED_COLORS.reserved }, { label: 'დასალაგებელი', value: t.cleaning, color: BED_COLORS.cleaning },
            { label: 'დაბლოკილი', value: t.blocked, color: BED_COLORS.blocked }]} height={big ? 20 : 14} />
        </div>)}
      <div className="row" style={{ flexWrap: 'wrap', gap: 18 }}>
        {num('ვიზიტები დღეს', t.encounters_today)}
        {num('ჰოსპიტალიზაცია დღეს', t.admissions_today)}
        {num('გაწერა დღეს', t.discharges_today)}
        {t.no_bed > 0 && num('საწოლის გარეშე', t.no_bed, 'var(--warn-ink)')}
        {(t.or_planned + t.or_in_progress + t.or_completed + t.or_cancelled) > 0 && <>
          {num('ოპერაცია: მიმდინარე', t.or_in_progress)}{num('დასრულდა / დაგეგმილი', `${t.or_completed} / ${t.or_planned}`)}</>}
        {num(`ლაბ. აგვიანებს (> ${q.data.thresholds.lab_overdue_min} წთ)`, t.lab_overdue, t.lab_overdue ? 'var(--danger-ink)' : undefined)}
        {num(`დასკვნა აგვიანებს (> ${q.data.thresholds.dx_overdue_hours} სთ)`, t.dx_overdue, t.dx_overdue ? 'var(--danger-ink)' : undefined)}
      </div>
      {showDepartments && q.data.departments.length > 1 && (
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead><tr><th>განყოფილება</th><th className="num">საწოლი</th><th className="num">დაკავ.</th><th style={{ width: 140 }} /><th className="num">ვიზიტი</th><th className="num">მიღება</th>
              <th className="num">გაწერა</th><th className="num">ოპერაცია</th><th className="num">აგვიანებს</th></tr></thead>
            <tbody>{q.data.departments.map((d) => (
              <tr key={d.department_id}><td>{d.department_name}</td><td className="num mono">{d.beds || '—'}</td><td className="num mono">{d.beds ? d.occupied : '—'}</td>
                <td>{d.beds > 0 && <Bar value={d.occupied} max={d.beds} tone={d.occupied / d.beds > 0.9 ? 'var(--danger-ink)' : undefined} />}</td>
                <td className="num mono">{d.encounters_today || '—'}</td><td className="num mono">{d.admissions_today || '—'}</td><td className="num mono">{d.discharges_today || '—'}</td>
                <td className="num mono">{d.or_in_progress + d.or_completed + d.or_planned || '—'}</td>
                <td className="num mono" style={{ color: d.lab_overdue + d.dx_overdue ? 'var(--danger-ink)' : undefined }}>{d.lab_overdue + d.dx_overdue + d.ext_overdue || '—'}</td></tr>))}
            </tbody>
          </table>
        </div>)}
    </section>
  );
}

export function AttentionPanel({ dept, refetchMs, big }: { dept: string; refetchMs?: number; big?: boolean }) {
  const q = useQuery({ queryKey: ['rpt-attention', dept], queryFn: () => api<Attention>('/reporting/attention', { query: { department_id: dept } }), refetchInterval: refetchMs ?? 120_000 });
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data) return <Loading />;
  return (
    <section className="card card-pad stack" style={{ gap: 8 }}>
      <div className="row"><strong className="grow" style={big ? { fontSize: 20 } : undefined}>ყურადღება</strong><span className="small muted">KPI: {q.data.from} — {q.data.to}</span></div>
      {!q.data.items.length && <span className="small" style={{ color: 'var(--ok-ink)' }}>● ყველაფერი რიგზეა</span>}
      {q.data.items.map((it, i) => (
        <div key={i} className="row" style={{ gap: 10, alignItems: 'baseline', fontSize: big ? 17 : undefined }}>
          <span style={{ color: STATUS_TONE[it.severity === 'red' ? 'red' : 'yellow'] }}>●</span>
          <span className="grow"><strong>{it.link && !big ? <Link to={it.link}>{it.title}</Link> : it.title}</strong> <span className="small muted">{it.detail}</span></span>
          <span className="mono"><strong>{it.value === null ? '—' : it.unit ? fmtVal(it.value, it.unit) : KIND_UNIT[it.kind] ? fmtVal(it.value, 'gel') : it.value}</strong></span>
        </div>))}
    </section>
  );
}

/** ტრენდი: 13 თვე + შარშან */
export function TrendCard({ kpi, dept, unit }: { kpi: string; dept: string; unit: string }) {
  const q = useQuery({ queryKey: ['rpt-trend', kpi, dept], queryFn: () => api<Trend>('/reporting/trend', { query: { kpi, department_id: dept, months: 13 } }) });
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data) return <Loading />;
  const d = q.data;
  return (
    <section className="card card-pad stack" style={{ gap: 6 }}>
      <div className="row"><strong className="grow">{d.name} — 13 თვე</strong>
        {d.data_from && <span className="small muted">მონაცემები {d.data_from}-დან{d.points.some((p) => p.partial) ? ' · მიმდინარე თვე — დღემდე' : ''}</span>}</div>
      <LineChart labels={d.points.map((p) => p.month.slice(2))} format={(v) => fmtVal(v, unit)}
        series={[{ name: 'ეს წელი', values: d.points.map((p) => p.value), color: 'var(--accent)' }, { name: 'შარშან', values: d.points.map((p) => p.prev_year), color: 'var(--muted)', dashed: true }]} />
      {!d.data_from && <span className="hint">ისტორია ჯერ არ არის დათვლილი — ადმინისტრირება → რეპორტინგი → გადათვლა.</span>}
    </section>
  );
}

/** განყოფილებების რეიტინგი არჩეული KPI-ით */
export function DeptRanking({ kpi, from, to, unit }: { kpi: string; from: string; to: string; unit: string }) {
  const q = useQuery({ queryKey: ['rpt-bydept', kpi, from, to], queryFn: () => api<ByDept>('/reporting/by-department', { query: { kpi, from, to } }) });
  const [all, setAll] = useState(false);
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data) return <Loading />;
  const rows = all ? q.data.rows : q.data.rows.slice(0, 10);
  const max = Math.max(0, ...q.data.rows.map((r) => Math.abs(r.value ?? 0)));
  return (
    <section className="card" style={{ overflowX: 'auto' }}>
      <div className="card-pad" style={{ paddingBottom: 0 }}><strong>{q.data.name} — განყოფილებებით</strong></div>
      <table className="table">
        <tbody>
          {rows.map((r, i) => <tr key={r.department_id}><td className="mono small muted" style={{ width: 28 }}>{i + 1}</td><td>{r.department_name}</td>
            <td className="num mono">{fmtVal(r.value, unit)}</td><td style={{ width: 180 }}><Bar value={r.value ?? 0} max={max} tone={r.status ? STATUS_TONE[r.status] : undefined} /></td></tr>)}
          {!rows.length && <tr><td className="muted">მონაცემი არ არის</td></tr>}
        </tbody>
      </table>
      {q.data.rows.length > 10 && <div className="card-pad"><button className="btn sm" type="button" onClick={() => setAll(!all)}>{all ? 'პირველი 10' : `ყველა (${q.data.rows.length})`}</button></div>}
    </section>
  );
}
