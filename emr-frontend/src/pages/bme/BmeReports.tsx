import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, type Role } from '../../api/client';
import { BarChart, LineChart } from '../../components/charts';
import { ErrorBox, Loading } from '../../components/ui';
import { downloadFile } from '../reporting/types';

/** ბიომედ-აპარატურა (0076): ანგარიშები / KPI — სერვერის BME_RPT */
export const BME_RPT: Role[] = ['admin', 'med_engineer', 'bme_view', 'manager', 'viewer', 'accountant', 'bme_dept'];

type K = Record<string, number | null>;
type Num = number | null;
interface Avail { key: string; name?: string; inv_no?: string; device_id?: string; devices: number; avail_h: number; down_h: number; down_unpl_h: number; restricted_h: number;
  bme_availability_pct: Num; unplanned_availability_pct: Num }
interface Rel { key: string; name?: string; inv_no?: string; device_id?: string; devices: number; failures: number; failures_ue: number; repairs_done: number; bme_mtbf_d: Num; mtbf_gt_d: Num;
  bme_mttr_h: Num; down_per_repair_h: Num; reopen_pct: Num }
interface Sla { n: number; resp_met: number; resp_breached: number; resp_pct: Num; rest_met: number; rest_breached: number; rest_pct: Num; in_progress: number; resp_avg_h: Num; wait_h: number; breached_with_wait: number }
interface Pm { key: string; name?: string; due: number; ontime: number; late: number; open: number; fail: number; ontime_pct: Num }
interface Par { code: string; name: string; n: number; pct: Num; cum_pct: Num }
interface CostRow { name?: string; devices?: number; cost_parts: number; cost_labor: number; cost_external: number; cost_pm: number; cost_contract: number; cost_total: number }
interface Report {
  from: string; to: string; to_effective: string; days: number; scope_label: string; can_cost: boolean; devices: number;
  settings: { rpt_restricted_weight: number; rpt_mtbf_exclude_user_error: boolean; rpt_pm_grace_days: number; rpt_cosr_warn_pct: number; rpt_contract_alloc: string };
  kpi: K; totals: Record<string, number>; trend: ({ ym: string } & K)[] | null;
  availability: { by_dept: Avail[]; by_type: Avail[]; by_criticality: Avail[]; worst: Avail[] };
  reliability: { by_type: Rel[]; by_dept: Rel[]; devices: Rel[] };
  sla: { total: Sla; by_priority: (Sla & { priority: number })[]; by_mode: (Sla & { mode: string; name: string })[]; by_supplier: (Sla & { supplier_id: string | null; name: string })[] };
  contracts: { id: string; contract_no: string; title: string; supplier_name: string; kind_name: string; status: string; window_from: string; window_to: string; devices: number;
    uptime_target: Num; availability_pct: Num; uptime_met: boolean | null; pm_visits_plan: Num; pm_visits_done: number; repairs: number; restore_pct: Num; cost_window?: number }[];
  costs: null | { total: CostRow; purchase_value: number; cosr_pct: Num; cosr_warn_pct: number; by_dept: CostRow[]; by_type: CostRow[];
    devices: (CostRow & { device_id: string; inv_no: string; name: string; type_name: string; department_name: string | null; purchase_value: Num; service_lifetime: number; tco: number; cosr_pct: Num; cosr_flag: boolean })[];
    replace_candidates: { device_id: string; inv_no: string; name: string; cosr_pct: Num; cost_total: number; purchase_value: Num }[] };
  pm: { total: Pm; by_kind: Pm[]; by_criticality: Pm[]; by_dept: Pm[]; by_performer: Pm[];
    overdue: { work_id: string | null; device_id: string; inv_no: string; name: string; kind: string; due: string; overdue_days: number; status: string; department: string | null; work_no: string | null }[] };
  causes: { requests: number; user_error: number; user_error_pct: Num; nff: number; nff_pct: Num; unclassified: number; causes: Par[]; actions: Par[]; rejected: Par[]; by_condition: Par[];
    user_error_by_type: { type_name: string; requests: number; user_error: number; pct: Num }[] };
}
interface Meta { today: string; can_cost: boolean; all_departments: boolean; departments: { id: string; name: string }[]; types: { id: string; name: string; grp: string }[];
  suppliers: { id: string; name: string }[]; groups: { code: string; name: string }[]; criticality: { code: string; name: string }[] }

const fv = (v: Num | undefined, u = '') => (v === null || v === undefined ? '—' : `${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}${u}`);
const money = (v: Num | undefined) => (v === null || v === undefined ? '—' : `${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₾`);
const monthStart = (t: string) => `${t.slice(0, 8)}01`;
const SECTIONS: [string, string][] = [['summary', 'შეჯამება'], ['availability', 'ხელმისაწვდომობა'], ['reliability', 'MTBF / MTTR'], ['sla', 'SLA'], ['contracts', 'კონტრაქტები'],
  ['costs', 'ხარჯი / TCO'], ['pm', 'PM ვადაში'], ['causes', 'მიზეზები']];

function Card({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <section className="card" style={{ overflowX: 'auto', flexShrink: 0 }}>
      <div className="card-pad" style={{ paddingBottom: 6 }}><strong>{title}</strong>{sub && <span className="small muted"> — {sub}</span>}</div>
      {children}
    </section>
  );
}
const Empty = ({ cols }: { cols: number }) => <tr><td colSpan={cols} className="muted">მონაცემი არ არის</td></tr>;
const pctTone = (v: Num, good = 95, warn = 85) => (v === null ? '' : v >= good ? 'ok' : v >= warn ? 'warn' : 'danger');

export default function BmeReportsPage() {
  const [sp, setSp] = useSearchParams();
  const meta = useQuery({ queryKey: ['bme-rpt-meta'], queryFn: () => api<Meta>('/bme/reports/meta') });
  const today = meta.data?.today ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tbilisi' }).format(new Date());
  const [f, setF] = useState({ from: '', to: '', department_id: '', type_id: '', grp: '', criticality: '', supplier_id: '', performer: '' });
  const p = { ...f, from: f.from || monthStart(today), to: f.to || today };
  const [sec, setSec] = useState('summary');
  const q = useQuery({ queryKey: ['bme-rpt', p], queryFn: () => api<Report>('/bme/reports/summary', { query: p }), enabled: !!meta.data && p.from <= p.to });
  const [dl, setDl] = useState<unknown>(null);
  const openDev = (id?: string) => { if (id) { sp.set('device', id); setSp(sp); } };
  const preset = (k: string) => {
    const [y, m] = today.split('-').map(Number);
    if (k === 'month') setF({ ...f, from: monthStart(today), to: today });
    if (k === 'prev') { const a = new Date(Date.UTC(y, m - 2, 1)); const b = new Date(Date.UTC(y, m - 1, 0)); setF({ ...f, from: a.toISOString().slice(0, 10), to: b.toISOString().slice(0, 10) }); }
    if (k === 'quarter') { const qs = Math.floor((m - 1) / 3) * 3; setF({ ...f, from: new Date(Date.UTC(y, qs, 1)).toISOString().slice(0, 10), to: today }); }
    if (k === 'year') setF({ ...f, from: `${y}-01-01`, to: today });
    if (k === '12m') { const a = new Date(Date.UTC(y, m - 1, Number(today.slice(8, 10)))); a.setUTCDate(a.getUTCDate() - 364); setF({ ...f, from: a.toISOString().slice(0, 10), to: today }); }
  };
  const d = q.data; const M = meta.data;
  const sel = (k: keyof typeof f, label: string, opts: { id: string; name: string }[], all: string) => (
    <select className="select" style={{ maxWidth: 220, height: 38 }} aria-label={label} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })}>
      <option value="">{all}</option>{opts.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>);
  return (
    <div className="content">
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <input type="date" className="input" style={{ maxWidth: 160, height: 38 }} aria-label="დან" value={p.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        <input type="date" className="input" style={{ maxWidth: 160, height: 38 }} aria-label="მდე" value={p.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
        <select className="select" style={{ maxWidth: 150, height: 38 }} aria-label="პერიოდი" value="" onChange={(e) => preset(e.target.value)}>
          <option value="">პერიოდი…</option><option value="month">მიმდინარე თვე</option><option value="prev">წინა თვე</option><option value="quarter">კვარტალი</option>
          <option value="year">წელი</option><option value="12m">ბოლო 12 თვე</option></select>
        {M && sel('department_id', 'განყოფილება', M.departments, M.all_departments ? 'ყველა განყოფილება' : 'ჩემი განყოფილებები')}
        {M && sel('type_id', 'ტიპი', M.types, 'ყველა ტიპი')}
        {M && sel('grp', 'ჯგუფი', M.groups.map((g) => ({ id: g.code, name: g.name })), 'ყველა ჯგუფი')}
        {M && sel('criticality', 'კრიტიკულობა', M.criticality.map((g) => ({ id: g.code, name: g.name })), 'ყველა კრიტიკულობა')}
        {M && sel('supplier_id', 'მომწოდებელი', M.suppliers, 'ყველა მომწოდებელი')}
        {sel('performer', 'შემსრულებელი', [{ id: 'internal', name: 'შიდა' }, { id: 'external', name: 'გარე' }], 'შიდა + გარე')}
        <span className="grow" />
        <button className="btn" type="button" disabled={!d} onClick={() => { setDl(null); downloadFile('/bme/reports/export', p, `bme_report_${p.from}_${p.to}.xlsx`).catch(setDl); }}>Excel</button>
      </div>
      <nav className="row" aria-label="ანგარიშის სექციები" style={{ gap: 2, flexWrap: 'wrap' }}>
        {SECTIONS.filter(([k]) => k !== 'costs' || d?.can_cost !== false).map(([k, l]) => <button key={k} type="button" className={`admin-tab${sec === k ? ' active' : ''}`} aria-pressed={sec === k}
          onClick={() => setSec(k)}>{l}</button>)}
      </nav>
      <ErrorBox error={meta.error ?? q.error ?? dl} />
      {p.from > p.to && <div className="alert warn">პერიოდის დასაწყისი დასასრულზე გვიანაა.</div>}
      {q.isLoading || meta.isLoading ? <Loading /> : d && <>
        <div className="small muted">{d.scope_label} · {d.from} — {d.to_effective} ({d.days} დღე) · {d.devices} აპარატი. კალენდარული საათები (24/7); მოცდენა — „გაუმართავი“
          {d.settings.rpt_restricted_weight ? ` + „შეზღუდული“ × ${d.settings.rpt_restricted_weight}` : ''}; MTBF — მომხმ. შეცდომა {d.settings.rpt_mtbf_exclude_user_error ? 'გამორიცხულია' : 'ითვლება'};
          PM ვადაში — {d.settings.rpt_pm_grace_days ? `+${d.settings.rpt_pm_grace_days} დღე` : 'ვადის დღის ჩათვლით'}. იგივე ფორმულა — მენეჯერულ დაფაზე (ჯგუფი „ბიომედ-აპარატურა“).</div>
        {sec === 'summary' && <Summary d={d} />}
        {sec === 'availability' && <AvailSec d={d} openDev={openDev} />}
        {sec === 'reliability' && <RelSec d={d} openDev={openDev} />}
        {sec === 'sla' && <SlaSec d={d} />}
        {sec === 'contracts' && <ContractsSec d={d} open={(id) => { sp.set('contract', id); setSp(sp); }} />}
        {sec === 'costs' && d.costs && <CostSec d={d} openDev={openDev} />}
        {sec === 'pm' && <PmSec d={d} openDev={openDev} />}
        {sec === 'causes' && <CauseSec d={d} />}
      </>}
    </div>
  );
}

function Tile({ label, value, tone, sub }: { label: string; value: string; tone?: string; sub?: string }) {
  return (
    <div className="card card-pad stack" style={{ gap: 2 }}>
      <span className="small muted">{label}</span>
      <strong style={{ fontSize: 22, color: tone === 'danger' ? 'var(--danger-ink)' : tone === 'warn' ? 'var(--warn-ink)' : tone === 'ok' ? 'var(--ok-ink)' : undefined }}>{value}</strong>
      {sub && <span className="small muted">{sub}</span>}
    </div>
  );
}

function Summary({ d }: { d: Report }) {
  const k = d.kpi; const t = d.totals;
  const tr = d.trend ?? [];
  return (<>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 10, flexShrink: 0 }}>
      <Tile label="ხელმისაწვდომობა" value={fv(k.bme_availability_pct, '%')} tone={pctTone(k.bme_availability_pct, 98, 95)} sub={`არადაგეგმილი ${fv(k.unplanned_availability_pct, '%')}`} />
      <Tile label="სიცოცხ. შემანარჩუნებელი" value={fv(k.bme_avail_ls_pct, '%')} tone={pctTone(k.bme_avail_ls_pct, 99, 97)} />
      <Tile label="MTBF" value={k.bme_mtbf_d !== null ? `${fv(k.bme_mtbf_d)} დღე` : k.mtbf_gt_d !== null ? `> ${fv(k.mtbf_gt_d)} დღე` : '—'} sub={`მწყობრიდან გამოსვლა: ${t.failures}`} />
      <Tile label="MTTR (აღდგენა)" value={k.bme_mttr_h !== null ? `${fv(k.bme_mttr_h)} სთ` : '—'} sub={`შესრულდა: ${t.repairs_done} · მოცდენა/ორდერი ${fv(k.down_per_repair_h)} სთ`} />
      <Tile label="SLA — რეაგირება" value={fv(k.bme_sla_response_pct, '%')} tone={pctTone(k.bme_sla_response_pct, 90, 75)} sub={`${t.sla_resp_met} / ${t.sla_resp_n}`} />
      <Tile label="SLA — აღდგენა" value={fv(k.bme_sla_restore_pct, '%')} tone={pctTone(k.bme_sla_restore_pct, 90, 75)} sub={`${t.sla_rest_met} / ${t.sla_rest_n}`} />
      <Tile label="PM / კალიბრაცია ვადაში" value={fv(k.bme_pm_ontime_pct, '%')} tone={pctTone(k.bme_pm_ontime_pct, 95, 85)} sub={`${t.pm_ontime} / ${t.pm_due} · „ვერ გაიარა“ ${t.pm_fail}`} />
      <Tile label="მომხმარებლის შეცდომა" value={fv(k.bme_user_error_pct, '%')} sub={`NFF ${fv(k.nff_pct, '%')} · ხელახლა გახსნა ${fv(k.reopen_pct, '%')}`} />
      {d.can_cost && <Tile label="სერვისის ხარჯი" value={money(k.bme_service_cost)} sub={d.costs?.cosr_pct !== null && d.costs?.cosr_pct !== undefined ? `COSR ${fv(d.costs.cosr_pct, '%')} (წლიური)` : undefined} />}
    </div>
    {tr.length > 0 && <Card title="ტრენდი — 13 თვე">
      <div className="card-pad"><LineChart labels={tr.map((x) => x.ym.slice(2))} format={(v) => `${Math.round(v)}%`} series={[
        { name: 'ხელმისაწვდომობა %', values: tr.map((x) => x.bme_availability_pct), color: 'var(--accent)' },
        { name: 'SLA აღდგენა %', values: tr.map((x) => x.bme_sla_restore_pct), color: 'var(--warn-ink)', dashed: true },
        { name: 'PM ვადაში %', values: tr.map((x) => x.bme_pm_ontime_pct), color: 'var(--ok-ink)', dashed: true }]} />
        <div className="small muted" style={{ marginTop: 8 }}>მწყობრიდან გამოსვლა თვეში</div>
        <BarChart height={120} points={tr.map((x) => ({ label: x.ym.slice(2), value: (x.failures as number) ?? 0 }))} /></div>
    </Card>}
    <div className="row small muted" style={{ gap: 16, flexWrap: 'wrap' }}>
      <span>ექსპლუატაცია <strong>{fv(t.avail_h)} სთ</strong></span><span>მოცდენა <strong>{fv(t.down_h)} სთ</strong> (არადაგეგმ. {fv(t.down_unpl_h)})</span>
      <span>შეზღუდული <strong>{fv(t.restricted_h)} სთ</strong></span><span>მოთხოვნა <strong>{t.requests}</strong></span><span>NFF <strong>{t.nff}</strong></span>
    </div>
  </>);
}

function AvailTable({ rows, first, openDev }: { rows: Avail[]; first: string; openDev?: (id?: string) => void }) {
  return (
    <table className="table" style={{ fontSize: 13 }}>
      <thead><tr><th>{first}</th><th className="num">აპარატი</th><th className="num">ექსპლ. სთ</th><th className="num">down სთ</th><th className="num">არადაგ. სთ</th><th className="num">შეზღ. სთ</th>
        <th className="num">ხელმისაწვდ.</th><th className="num">არადაგ. %</th></tr></thead>
      <tbody>{rows.map((r) => <tr key={r.key} className={openDev && r.device_id ? 'clickable' : undefined} onClick={() => openDev?.(r.device_id)}>
        <td>{r.inv_no ? <><span className="mono small">{r.inv_no}</span> {r.name}</> : r.name}</td><td className="num">{r.devices}</td><td className="num">{fv(r.avail_h)}</td>
        <td className="num">{fv(r.down_h)}</td><td className="num">{fv(r.down_unpl_h)}</td><td className="num">{fv(r.restricted_h)}</td>
        <td className="num"><span className={`chip ${pctTone(r.bme_availability_pct, 98, 95)}`}>{fv(r.bme_availability_pct, '%')}</span></td><td className="num">{fv(r.unplanned_availability_pct, '%')}</td></tr>)}
        {!rows.length && <Empty cols={8} />}</tbody>
    </table>
  );
}
function AvailSec({ d, openDev }: { d: Report; openDev: (id?: string) => void }) {
  return (<>
    <Card title="ყველაზე დაბალი ხელმისაწვდომობა" sub="ტოპ-10 აპარატი"><AvailTable rows={d.availability.worst} first="აპარატი" openDev={openDev} /></Card>
    <Card title="განყოფილებები" sub="იმ დროს მოქმედი განყოფილება (გადაადგილების გათვალისწინებით)"><AvailTable rows={d.availability.by_dept} first="განყოფილება" /></Card>
    <Card title="ტიპები"><AvailTable rows={d.availability.by_type} first="ტიპი" /></Card>
    <Card title="კრიტიკულობა"><AvailTable rows={d.availability.by_criticality} first="კრიტიკულობა" /></Card>
  </>);
}

function RelTable({ rows, first, openDev }: { rows: Rel[]; first: string; openDev?: (id?: string) => void }) {
  return (
    <table className="table" style={{ fontSize: 13 }}>
      <thead><tr><th>{first}</th><th className="num">აპარატი</th><th className="num">მწყობრ. გამოსვლა</th><th className="num">მ.შ. მომხმ. შეცდ.</th><th className="num">შესრულდა</th>
        <th className="num">MTBF, დღე</th><th className="num">MTTR, სთ</th><th className="num">მოცდ./ორდერი, სთ</th><th className="num">ხელახლა %</th></tr></thead>
      <tbody>{rows.map((r) => <tr key={r.key} className={openDev && r.device_id ? 'clickable' : undefined} onClick={() => openDev?.(r.device_id)}>
        <td>{r.inv_no ? <><span className="mono small">{r.inv_no}</span> {r.name}</> : r.name}</td><td className="num">{r.devices}</td><td className="num">{r.failures}</td>
        <td className="num">{r.failures_ue || ''}</td><td className="num">{r.repairs_done}</td>
        <td className="num">{r.bme_mtbf_d !== null ? fv(r.bme_mtbf_d) : r.mtbf_gt_d !== null ? `> ${fv(r.mtbf_gt_d)}` : '—'}</td><td className="num">{fv(r.bme_mttr_h)}</td>
        <td className="num">{fv(r.down_per_repair_h)}</td><td className="num">{fv(r.reopen_pct)}</td></tr>)}
        {!rows.length && <Empty cols={9} />}</tbody>
    </table>
  );
}
function RelSec({ d, openDev }: { d: Report; openDev: (id?: string) => void }) {
  return (<>
    <div className="small muted">MTBF = სამუშაო დრო / მწყობრიდან გამოსვლა (ორდერი, გარდა უარყოფილის / დუბლიკატის / „დაზიანება არ დადასტურდა“); MTTR = მოთხოვნიდან შესრულებამდე.
      0 მწყობრიდან გამოსვლა → „&gt; X დღე“ (სამუშაო დრო).</div>
    <Card title="ტიპები"><RelTable rows={d.reliability.by_type} first="ტიპი" /></Card>
    <Card title="განყოფილებები"><RelTable rows={d.reliability.by_dept} first="განყოფილება" /></Card>
    <Card title="ყველაზე ხშირად გაუმართავი აპარატები" sub="ტოპ-20"><RelTable rows={d.reliability.devices} first="აპარატი" openDev={openDev} /></Card>
  </>);
}

function SlaTable({ rows, first }: { rows: (Sla & { label: string })[]; first: string }) {
  return (
    <table className="table" style={{ fontSize: 13 }}>
      <thead><tr><th>{first}</th><th className="num">ორდერი</th><th className="num">რეაგ. ვადაში</th><th className="num">დარღვ.</th><th className="num">რეაგ. %</th><th className="num">აღდგ. ვადაში</th>
        <th className="num">დარღვ.</th><th className="num">აღდგ. %</th><th className="num">მიმდინარე</th><th className="num">რეაგ. საშ., სთ</th><th className="num">ლოდინი, სთ</th><th className="num">დარღვ. ლოდინით</th></tr></thead>
      <tbody>{rows.map((r) => <tr key={r.label}><td>{r.label}</td><td className="num">{r.n}</td><td className="num">{r.resp_met}</td><td className="num">{r.resp_breached || ''}</td>
        <td className="num"><span className={`chip ${pctTone(r.resp_pct, 90, 75)}`}>{fv(r.resp_pct, '%')}</span></td><td className="num">{r.rest_met}</td><td className="num">{r.rest_breached || ''}</td>
        <td className="num"><span className={`chip ${pctTone(r.rest_pct, 90, 75)}`}>{fv(r.rest_pct, '%')}</span></td><td className="num">{r.in_progress || ''}</td><td className="num">{fv(r.resp_avg_h)}</td>
        <td className="num">{fv(r.wait_h)}</td><td className="num">{r.breached_with_wait || ''}</td></tr>)}
        {!rows.length && <Empty cols={12} />}</tbody>
    </table>
  );
}
function SlaSec({ d }: { d: Report }) {
  return (<>
    <div className="small muted">კოჰორტა მოთხოვნის დღით. ღია ორდერი ვადაგასული → დარღვეული; ვადაში მყოფი ღია — „მიმდინარე“ (წილში არ ითვლება). SLA-ს საათი ლოდინისას არ ჩერდება — ლოდინი ცალკე სვეტია.</div>
    <Card title="პრიორიტეტი"><SlaTable first="პრიორიტეტი" rows={[{ ...d.sla.total, label: 'სულ' }, ...d.sla.by_priority.map((x) => ({ ...x, label: `P${x.priority}` }))]} /></Card>
    <Card title="შემსრულებელი / სამიზნის წყარო"><SlaTable first="შემსრულებელი" rows={d.sla.by_mode.map((x) => ({ ...x, label: x.name }))} /></Card>
    <Card title="მომწოდებელი" sub="გარე შემსრულებელი"><SlaTable first="მომწოდებელი" rows={d.sla.by_supplier.map((x) => ({ ...x, label: x.name }))} /></Card>
  </>);
}

function ContractsSec({ d, open }: { d: Report; open: (id: string) => void }) {
  return (
    <Card title="კონტრაქტების შესრულება" sub="uptime % — კონტრაქტის აპარატების ხელმისაწვდომობა კონტრაქტისა და პერიოდის გადაფარვაში">
      <table className="table" style={{ fontSize: 13 }}>
        <thead><tr><th>კონტრაქტი</th><th>ფანჯარა</th><th className="num">აპარატი</th><th className="num">uptime სამიზნე</th><th className="num">ფაქტი</th><th>შესრულდა</th>
          <th className="num">PM ვიზიტი (გეგმა / ფაქტი)</th><th className="num">ორდერი</th><th className="num">აღდგ. ვადაში</th>{d.can_cost && <th className="num">ხარჯი</th>}</tr></thead>
        <tbody>{d.contracts.map((c) => <tr key={c.id} className="clickable" onClick={() => open(c.id)}>
          <td><span className="mono small">{c.contract_no}</span> {c.title}<div className="small muted">{c.supplier_name} · {c.kind_name}{c.status !== 'active' ? ' · გაუქმებული' : ''}</div></td>
          <td className="small">{c.window_from} — {c.window_to}</td><td className="num">{c.devices}</td><td className="num">{fv(c.uptime_target, '%')}</td><td className="num">{fv(c.availability_pct, '%')}</td>
          <td>{c.uptime_met === null ? '—' : c.uptime_met ? <span className="chip ok">დიახ</span> : <span className="chip danger">არა</span>}</td>
          <td className="num">{c.pm_visits_plan === null ? '—' : `${fv(c.pm_visits_plan)} / ${c.pm_visits_done}`}</td><td className="num">{c.repairs}</td><td className="num">{fv(c.restore_pct, '%')}</td>
          {d.can_cost && <td className="num">{money(c.cost_window ?? null)}</td>}</tr>)}
          {!d.contracts.length && <Empty cols={10} />}</tbody>
      </table>
    </Card>
  );
}

function CostTable({ rows, first }: { rows: (CostRow & { label: string })[]; first: string }) {
  return (
    <table className="table" style={{ fontSize: 13 }}>
      <thead><tr><th>{first}</th><th className="num">აპარატი</th><th className="num">ნაწილები</th><th className="num">შრომა</th><th className="num">გარე</th><th className="num">PM / კალიბრ.</th>
        <th className="num">კონტრაქტი</th><th className="num">სულ</th></tr></thead>
      <tbody>{rows.map((r) => <tr key={r.label}><td>{r.label}</td><td className="num">{r.devices ?? ''}</td><td className="num">{money(r.cost_parts)}</td><td className="num">{money(r.cost_labor)}</td>
        <td className="num">{money(r.cost_external)}</td><td className="num">{money(r.cost_pm)}</td><td className="num">{money(r.cost_contract)}</td><td className="num"><strong>{money(r.cost_total)}</strong></td></tr>)}
        {!rows.length && <Empty cols={8} />}</tbody>
    </table>
  );
}
function CostSec({ d, openDev }: { d: Report; openDev: (id?: string) => void }) {
  const C = d.costs!;
  return (<>
    <div className="small muted">ნაწილები — საწყობის ჩამოწერიდან (შემობრუნების გამოკლებით), შესრულების დღით; კონტრაქტი — წლიური ექვივალენტი / 365 დღეზე, აპარატებზე {d.settings.rpt_contract_alloc === 'value' ? 'შეძენის ღირებულების პროპორციით' : 'თანაბრად'}.
      TCO = შეძენა + სერვისი (მთელი ისტორია); COSR = პერიოდის ხარჯი წლიურად / შეძენის ღირებულება (ზღვარი {C.cosr_warn_pct}%).</div>
    <Card title="ხარჯი" sub={`შეძენის ღირებულება ${money(C.purchase_value)} · COSR ${fv(C.cosr_pct, '%')}`}>
      <CostTable first="" rows={[{ ...C.total, label: 'სულ' }, ...C.by_dept.map((x) => ({ ...x, label: x.name ?? '—' }))]} /></Card>
    <Card title="ტიპები"><CostTable first="ტიპი" rows={C.by_type.map((x) => ({ ...x, label: x.name ?? '—' }))} /></Card>
    {C.replace_candidates.length > 0 && <Card title="ჩანაცვლების / გამოყვანის კანდიდატები" sub={`COSR > ${C.cosr_warn_pct}%`}>
      <table className="table" style={{ fontSize: 13 }}><thead><tr><th>აპარატი</th><th className="num">შეძენა</th><th className="num">პერიოდის ხარჯი</th><th className="num">COSR</th></tr></thead>
        <tbody>{C.replace_candidates.map((x) => <tr key={x.device_id} className="clickable" onClick={() => openDev(x.device_id)}><td><span className="mono small">{x.inv_no}</span> {x.name}</td>
          <td className="num">{money(x.purchase_value)}</td><td className="num">{money(x.cost_total)}</td><td className="num"><span className="chip danger">{fv(x.cosr_pct, '%')}</span></td></tr>)}</tbody></table></Card>}
    <Card title="აპარატები — TCO">
      <table className="table" style={{ fontSize: 13 }}>
        <thead><tr><th>აპარატი</th><th className="num">შეძენა</th><th className="num">ნაწილ.</th><th className="num">შრომა</th><th className="num">გარე</th><th className="num">PM</th><th className="num">კონტრ.</th>
          <th className="num">პერიოდი</th><th className="num">სერვისი (სულ)</th><th className="num">TCO</th><th className="num">COSR</th></tr></thead>
        <tbody>{C.devices.map((x) => <tr key={x.device_id} className="clickable" onClick={() => openDev(x.device_id)}>
          <td><span className="mono small">{x.inv_no}</span> {x.name}<div className="small muted">{x.type_name}{x.department_name ? ` · ${x.department_name}` : ''}</div></td>
          <td className="num">{money(x.purchase_value)}</td><td className="num">{money(x.cost_parts)}</td><td className="num">{money(x.cost_labor)}</td><td className="num">{money(x.cost_external)}</td>
          <td className="num">{money(x.cost_pm)}</td><td className="num">{money(x.cost_contract)}</td><td className="num"><strong>{money(x.cost_total)}</strong></td><td className="num">{money(x.service_lifetime)}</td>
          <td className="num">{money(x.tco)}</td><td className="num">{x.cosr_pct === null ? '—' : <span className={`chip ${x.cosr_flag ? 'danger' : ''}`}>{fv(x.cosr_pct, '%')}</span>}</td></tr>)}
          {!C.devices.length && <Empty cols={11} />}</tbody>
      </table>
    </Card>
  </>);
}

function PmTable({ rows, first }: { rows: (Pm & { label: string })[]; first: string }) {
  return (
    <table className="table" style={{ fontSize: 13 }}>
      <thead><tr><th>{first}</th><th className="num">ვადიანი</th><th className="num">ვადაში</th><th className="num">დაგვიანებით</th><th className="num">შეუსრულებელი</th><th className="num">„ვერ გაიარა“</th><th className="num">ვადაში %</th></tr></thead>
      <tbody>{rows.map((r) => <tr key={r.label}><td>{r.label}</td><td className="num">{r.due}</td><td className="num">{r.ontime}</td><td className="num">{r.late || ''}</td>
        <td className="num">{r.open ? <span className="chip danger">{r.open}</span> : ''}</td><td className="num">{r.fail || ''}</td>
        <td className="num"><span className={`chip ${pctTone(r.ontime_pct, 95, 85)}`}>{fv(r.ontime_pct, '%')}</span></td></tr>)}
        {!rows.length && <Empty cols={7} />}</tbody>
    </table>
  );
}
function PmSec({ d, openDev }: { d: Report; openDev: (id?: string) => void }) {
  const P = d.pm;
  return (<>
    <div className="small muted">ვადა პერიოდში: სამუშაო (ვადით) ან აქტიური გეგმა, რომელზეც სამუშაო არ შექმნილა; ვადაში = შესრულება ≤ ვადა{d.settings.rpt_pm_grace_days ? ` + ${d.settings.rpt_pm_grace_days} დღე` : ''}.
      მომავალი ვადა (დღევანდლის ჩათვლით) შეუსრულებლად არ ითვლება.</div>
    <Card title="სამუშაოს სახე"><PmTable first="სახე" rows={[{ ...P.total, label: 'სულ' }, ...P.by_kind.map((x) => ({ ...x, label: x.name ?? x.key }))]} /></Card>
    <Card title="კრიტიკულობა"><PmTable first="კრიტიკულობა" rows={P.by_criticality.map((x) => ({ ...x, label: x.name ?? x.key }))} /></Card>
    <Card title="განყოფილებები"><PmTable first="განყოფილება" rows={P.by_dept.map((x) => ({ ...x, label: x.name ?? x.key }))} /></Card>
    <Card title="შემსრულებელი"><PmTable first="შემსრულებელი" rows={P.by_performer.map((x) => ({ ...x, label: x.name ?? x.key }))} /></Card>
    <Card title="ვადაგადაცილებული" sub={`${P.overdue.length}`}>
      <table className="table" style={{ fontSize: 13 }}><thead><tr><th>აპარატი</th><th>სახე</th><th>ვადა</th><th className="num">დღე</th><th>სამუშაო</th><th>განყოფილება</th></tr></thead>
        <tbody>{P.overdue.map((x, i) => <tr key={`${x.device_id}-${x.due}-${i}`} className="clickable" onClick={() => openDev(x.device_id)}>
          <td><span className="mono small">{x.inv_no}</span> {x.name}</td><td>{x.kind}</td><td className="mono small">{x.due}</td><td className="num"><span className="chip danger">{x.overdue_days}</span></td>
          <td className="small">{x.work_no ?? <span className="muted">არ შექმნილა</span>}</td><td className="small">{x.department ?? '—'}</td></tr>)}
          {!P.overdue.length && <Empty cols={6} />}</tbody></table>
    </Card>
  </>);
}

function ParTable({ rows }: { rows: Par[] }) {
  return (
    <table className="table" style={{ fontSize: 13 }}>
      <thead><tr><th>დასახელება</th><th className="num">რაოდ.</th><th className="num">%</th><th className="num">კუმულ. %</th><th style={{ width: '30%' }} /></tr></thead>
      <tbody>{rows.map((r) => <tr key={r.code}><td>{r.name}</td><td className="num">{r.n}</td><td className="num">{fv(r.pct)}</td><td className="num">{fv(r.cum_pct)}</td>
        <td><div style={{ height: 8, borderRadius: 4, background: 'var(--accent)', width: `${Math.max(2, r.pct ?? 0)}%` }} /></td></tr>)}
        {!rows.length && <Empty cols={5} />}</tbody>
    </table>
  );
}
function CauseSec({ d }: { d: Report }) {
  const Z = d.causes;
  return (<>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 10, flexShrink: 0 }}>
      <Tile label="მოთხოვნები" value={String(Z.requests)} />
      <Tile label="მომხმარებლის შეცდომა" value={fv(Z.user_error_pct, '%')} sub={`${Z.user_error} — მიზეზი USER_ERROR ან უარყოფა`} />
      <Tile label="დაზიანება არ დადასტურდა (NFF)" value={fv(Z.nff_pct, '%')} sub={String(Z.nff)} />
      <Tile label="შესრულებული, მიზეზის გარეშე" value={String(Z.unclassified)} tone={Z.unclassified ? 'warn' : undefined} sub="მონაცემთა ხარისხი" />
    </div>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 14 }}>
      <Card title="მიზეზი" sub="Pareto, შესრულებული ორდერები"><ParTable rows={Z.causes} /></Card>
      <Card title="ქმედება"><ParTable rows={Z.actions} /></Card>
      <Card title="უარყოფის მიზეზი"><ParTable rows={Z.rejected} /></Card>
      <Card title="მდგომარეობა მოთხოვნისას"><ParTable rows={Z.by_condition} /></Card>
    </div>
    <Card title="მომხმარებლის შეცდომა ტიპებით">
      <table className="table" style={{ fontSize: 13 }}><thead><tr><th>ტიპი</th><th className="num">მოთხოვნა</th><th className="num">მომხმ. შეცდომა</th><th className="num">%</th></tr></thead>
        <tbody>{Z.user_error_by_type.map((x) => <tr key={x.type_name}><td>{x.type_name}</td><td className="num">{x.requests}</td><td className="num">{x.user_error || ''}</td><td className="num">{fv(x.pct)}</td></tr>)}
          {!Z.user_error_by_type.length && <Empty cols={4} />}</tbody></table>
    </Card>
  </>);
}

/** პასპორტი → „შეკეთება / კონტრაქტი“: KPI 12 თვეზე */
export function DeviceKpi({ deviceId }: { deviceId: string }) {
  const q = useQuery({ queryKey: ['bme-device-kpi', deviceId], queryFn: () => api<{ from: string; to: string; kpi: K; failures: number; repairs_done: number; down_h: number; avail_h: number;
    pm_due: number; pm_ontime: number; can_cost: boolean; cost?: { total: number; purchase_value: Num; service_lifetime: number; tco: number; cosr_pct: Num; cosr_warn_pct: number } }>(`/bme/devices/${deviceId}/kpi`) });
  if (q.isLoading) return null;
  if (!q.data) return null;
  const d = q.data; const k = d.kpi;
  const item = (l: string, v: string, tone?: string) => <span className="small">{l}: <strong style={{ color: tone === 'danger' ? 'var(--danger-ink)' : tone === 'warn' ? 'var(--warn-ink)' : undefined }}>{v}</strong></span>;
  return (
    <section className="card card-pad row" style={{ gap: 16, flexWrap: 'wrap' }} aria-label="KPI 12 თვე">
      <span className="small muted">12 თვე ({d.from} — {d.to})</span>
      {item('ხელმისაწვდომობა', fv(k.bme_availability_pct, '%'), pctTone(k.bme_availability_pct, 98, 95))}
      {item('MTBF', k.bme_mtbf_d !== null ? `${fv(k.bme_mtbf_d)} დღე` : k.mtbf_gt_d !== null ? `> ${fv(k.mtbf_gt_d)} დღე` : '—')}
      {item('MTTR', k.bme_mttr_h !== null ? `${fv(k.bme_mttr_h)} სთ` : '—')}
      {item('გაუმართაობა', String(d.failures))}
      {item('PM ვადაში', d.pm_due ? `${d.pm_ontime} / ${d.pm_due}` : '—')}
      {d.cost && <>{item('სერვისის ხარჯი', money(d.cost.total))}{item('TCO', money(d.cost.tco))}
        {item('COSR', fv(d.cost.cosr_pct, '%'), d.cost.cosr_pct !== null && d.cost.cosr_pct > d.cost.cosr_warn_pct ? 'danger' : undefined)}</>}
    </section>
  );
}
