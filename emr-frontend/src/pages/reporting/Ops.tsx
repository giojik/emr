import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import { BarChart, Heatmap, Sparkline } from '../../components/charts';
import { ErrorBox, Loading } from '../../components/ui';
import { Bar } from '../finance/types';
import { downloadFile, fmtTime, fmtVal, type RptMeta } from './types';

/**
 * ოპერაციული დაფა (0062): ნაკადი (დღეები + სითბური რუკა), საწოლები, საოპერაციო, კვლევები, ლაბორატორია, მარაგი, ექიმები.
 * ყველა მონაცემი — აგრეგაციიდან (rpt_*); პერიოდი და განყოფილება — დაფის ზედა ზოლიდან.
 */
type Sub = 'flow' | 'beds' | 'or' | 'dx' | 'lab' | 'stock' | 'doctors';
const SUB_KA: Record<Sub, string> = { flow: 'ნაკადი', beds: 'საწოლები', or: 'საოპერაციო', dx: 'ინსტრუმენტული კვლევები', lab: 'ლაბორატორია', stock: 'მარაგი', doctors: 'ექიმები' };
interface P { meta: RptMeta; from: string; to: string; dept: string }
const q0 = (p: P) => ({ from: p.from, to: p.to, department_id: p.dept || undefined });
const segBtn = { background: 'none', borderTop: 0, borderLeft: 0, borderRight: 0, font: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap' } as const;
const pc = (v: number | null) => (v === null ? '—' : `${v}%`);
const nv = (v: number | null | undefined, d = '—') => (v === null || v === undefined ? d : v.toLocaleString('en-US', { maximumFractionDigits: 1 }));

function Xls({ p, dataset, extra }: { p: P; dataset: string; extra?: Record<string, string> }) {
  const [err, setErr] = useState<unknown>(null);
  return <>
    <button className="btn sm" type="button" onClick={() => downloadFile('/reporting/ops/export', { dataset, format: 'xlsx', ...q0(p), ...extra }, `ops_${dataset}.xlsx`).catch(setErr)}>Excel</button>
    {!!err && <ErrorBox error={err} />}
  </>;
}

export default function Ops(p: P) {
  const docs = p.meta.settings.doctor_breakdown !== 'off' && (p.meta.scope.all || p.meta.settings.doctor_breakdown === 'scoped');
  const subs = (Object.keys(SUB_KA) as Sub[]).filter((s) => s !== 'doctors' || docs);
  const [sub, setSub] = useState<Sub>('flow');
  return (
    <div className="content">
      <nav className="row" style={{ gap: 2, flexWrap: 'wrap' }} aria-label="ოპერაციული">
        {subs.map((s) => <button key={s} type="button" className={`admin-tab${sub === s ? ' active' : ''}`} style={segBtn} onClick={() => setSub(s)}>{SUB_KA[s]}</button>)}
      </nav>
      {sub === 'flow' ? <Flow {...p} /> : sub === 'beds' ? <Beds {...p} /> : sub === 'or' ? <Or {...p} /> : sub === 'dx' ? <Dx {...p} section="imaging" />
        : sub === 'lab' ? <Dx {...p} section="lab" /> : sub === 'stock' ? <Stock {...p} /> : <Doctors {...p} />}
    </div>
  );
}

// ------------------------------------------------------------------------------------ ნაკადი
const LAYER_KA: Record<string, string> = { visit: 'ვიზიტის დაწყება', admission: 'ჰოსპიტალიზაცია', lab_collect: 'ლაბ. ნიმუშის აღება' };
const VSUB_KA: Record<string, string> = { '': 'ყველა', outpatient: 'ამბულატორია', lab: 'ლაბორატორია', emergency: 'გადაუდებელი', inpatient: 'სტაციონარი' };
function Flow(p: P) {
  const [layer, setLayer] = useState('visit'); const [vsub, setVsub] = useState('');
  const f = useQuery({ queryKey: ['ops-flow', p.from, p.to, p.dept], queryFn: () => api<{ days: string[]; series: { sub: string; name: string; values: number[] }[]; totals: Record<string, number> }>('/reporting/ops/flow', { query: q0(p) }) });
  const h = useQuery({ queryKey: ['ops-heat', p.from, p.to, p.dept, layer, vsub], queryFn: () => api<{ weekdays: string[]; avg: number[][]; sum: number; occurrences: number[];
    peak: { weekday: string; hour: number; value: number } | null }>('/reporting/ops/heatmap', { query: { ...q0(p), layer, sub: layer === 'visit' && vsub ? vsub : undefined } }) });
  const total = f.data ? f.data.days.map((_, i) => f.data!.series.reduce((a, s) => a + s.values[i], 0)) : [];
  return <>
    <ErrorBox error={f.error ?? h.error} />
    <section className="card card-pad stack" style={{ gap: 8 }}>
      <div className="row"><strong className="grow">ვიზიტები დღეების მიხედვით</strong>
        {f.data && <span className="small muted">{f.data.series.map((s) => `${s.name}: ${f.data!.totals[s.sub]}`).join(' · ')}</span>}</div>
      {f.data ? <BarChart points={f.data.days.map((d, i) => ({ label: d.slice(5), value: total[i], hint: `${d}: ${total[i]} (${f.data!.series.filter((s) => s.values[i]).map((s) => `${s.name} ${s.values[i]}`).join(', ')})` }))} /> : <Loading />}
    </section>
    <section className="card card-pad stack" style={{ gap: 8 }}>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <strong className="grow">როდის მოდიან — კვირის დღე × საათი (საშუალო ერთ დღეზე)</strong>
        <select className="select" style={{ height: 34, width: 'auto' }} value={layer} onChange={(e) => setLayer(e.target.value)} aria-label="ფენა">
          {Object.entries(LAYER_KA).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        {layer === 'visit' && <select className="select" style={{ height: 34, width: 'auto' }} value={vsub} onChange={(e) => setVsub(e.target.value)} aria-label="ვიზიტის ტიპი">
          {Object.entries(VSUB_KA).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>}
        <Xls p={p} dataset="heatmap" extra={{ layer, ...(layer === 'visit' && vsub ? { sub: vsub } : {}) }} />
      </div>
      {!h.data ? <Loading /> : <>
        <Heatmap rows={h.data.weekdays} cols={Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'))} values={h.data.avg} format={(v) => `${v} საშ.`} />
        <span className="small muted">სულ {h.data.sum}{h.data.peak ? ` · პიკი: ${h.data.peak.weekday} ${String(h.data.peak.hour).padStart(2, '0')}:00 (საშ. ${h.data.peak.value})` : ''} ·
          საშუალო = საათის ჯამი / ამ კვირის დღის რაოდენობა პერიოდში</span>
      </>}
    </section>
  </>;
}

// ------------------------------------------------------------------------------------ საწოლები
interface BedRow { department_id: string; department_name: string; beds_avg: number; occupancy_pct: number | null; census_avg: number; admissions: number; discharges: number; deaths: number;
  alos: number | null; transfers_in: number; transfers_out: number; readmit30_pct: number | null; daily: { day: string; occupancy_pct: number | null }[] }
function Beds(p: P) {
  const q = useQuery({ queryKey: ['ops-beds', p.from, p.to, p.dept], queryFn: () => api<{ basis: string; rows: BedRow[] }>('/reporting/ops/beds', { query: q0(p) }) });
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data) return <Loading />;
  return (
    <section className="card" style={{ overflowX: 'auto' }}>
      <div className="card-pad row" style={{ paddingBottom: 0 }}><strong className="grow">განყოფილებები</strong>
        <span className="small muted">დატვირთვა — {q.data.basis === 'midnight' ? 'შუაღამის დაკავებით' : 'საწოლ-საათებით'}</span><Xls p={p} dataset="beds" /></div>
      <table className="table">
        <thead><tr><th>განყოფილება</th><th className="num">საწოლი</th><th className="num">დატვირთვა</th><th>დღეებით</th><th className="num">შუაღამე</th><th className="num">მიღება</th>
          <th className="num">გაწერა</th><th className="num">ALOS</th><th className="num">გადმოყვ. / გაყვ.</th><th className="num">ლეტ.</th><th className="num">განმ. 30 დღე</th></tr></thead>
        <tbody>{q.data.rows.map((r) => (
          <tr key={r.department_id}>
            <td>{r.department_name}</td><td className="num mono">{nv(r.beds_avg)}</td>
            <td className="num mono" style={{ color: r.occupancy_pct !== null && r.occupancy_pct > 90 ? 'var(--danger-ink)' : undefined }}>{pc(r.occupancy_pct)}</td>
            <td><Sparkline values={r.daily.map((d) => d.occupancy_pct)} width={110} height={24} /></td>
            <td className="num mono">{nv(r.census_avg)}</td><td className="num mono">{r.admissions}</td><td className="num mono">{r.discharges}</td><td className="num mono">{nv(r.alos)}</td>
            <td className="num mono">{r.transfers_in} / {r.transfers_out}</td><td className="num mono">{r.deaths}</td><td className="num mono">{pc(r.readmit30_pct)}</td>
          </tr>))}
          {!q.data.rows.length && <tr><td colSpan={11} className="muted">მონაცემი არ არის</td></tr>}</tbody>
      </table>
    </section>
  );
}

// ------------------------------------------------------------------------------------ საოპერაციო
function Or(p: P) {
  const q = useQuery({ queryKey: ['ops-or', p.from, p.to, p.dept], queryFn: () => api<{
    rooms: { room_id: string; code: string; name: string; block: string; avail: number; used: number; cases: number; utilization_pct: number | null }[];
    departments: { department_id: string; department_name: string; scheduled: number; done: number; cancelled: number; cancel_pct: number | null; emergency_pct: number | null;
      first_on_time_pct: number | null; surgery_min_avg: number | null }[];
    daily: { day: string; done: number; canc: number }[] }>('/reporting/ops/or', { query: q0(p) }) });
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data) return <Loading />;
  const d = q.data;
  return <>
    <section className="card card-pad stack" style={{ gap: 6 }}><strong>ოპერაციები დღეების მიხედვით</strong>
      <BarChart points={d.daily.map((x) => ({ label: x.day.slice(5), value: x.done, hint: `${x.day}: დასრულდა ${x.done}, გაუქმდა ${x.canc}` }))} height={140} /></section>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 10, alignItems: 'start' }}>
      <section className="card" style={{ overflowX: 'auto' }}>
        <div className="card-pad row" style={{ paddingBottom: 0 }}><strong className="grow">ოთახები</strong><Xls p={p} dataset="or_rooms" /></div>
        <table className="table">
          <thead><tr><th>ოთახი</th><th className="num">ოპერაცია</th><th className="num">გამოყენება</th><th style={{ width: 130 }} /></tr></thead>
          <tbody>{d.rooms.map((r) => <tr key={r.room_id}><td><strong>{r.code}</strong> <span className="small muted">{r.name} · {r.block}</span></td><td className="num mono">{r.cases}</td>
            <td className="num mono">{pc(r.utilization_pct)}</td><td><Bar value={r.used} max={r.avail} /></td></tr>)}
            {!d.rooms.length && <tr><td colSpan={4} className="muted">მონაცემი არ არის</td></tr>}</tbody>
        </table>
      </section>
      <section className="card" style={{ overflowX: 'auto' }}>
        <div className="card-pad row" style={{ paddingBottom: 0 }}><strong className="grow">ქირურგიული განყოფილებები</strong><Xls p={p} dataset="or_departments" /></div>
        <table className="table">
          <thead><tr><th>განყოფილება</th><th className="num">დასრ.</th><th className="num">გაუქმ. %</th><th className="num">გადაუდ. %</th><th className="num">პირველი დროული</th><th className="num">საშ. წთ</th></tr></thead>
          <tbody>{d.departments.map((r) => <tr key={r.department_id}><td>{r.department_name}</td><td className="num mono">{r.done}</td><td className="num mono">{pc(r.cancel_pct)}</td>
            <td className="num mono">{pc(r.emergency_pct)}</td><td className="num mono">{pc(r.first_on_time_pct)}</td><td className="num mono">{nv(r.surgery_min_avg)}</td></tr>)}
            {!d.departments.length && <tr><td colSpan={6} className="muted">მონაცემი არ არის</td></tr>}</tbody>
        </table>
      </section>
    </div>
  </>;
}

// ------------------------------------------------------------------------------------ კვლევები / ლაბორატორია
const BY_KA: Record<string, string> = { device: 'აპარატით', group: 'ჯგუფით', modality: 'მოდალობით' };
function Dx(p: P & { section: 'imaging' | 'lab' }) {
  const [by, setBy] = useState('device');
  const [sec, setSec] = useState(p.section === 'lab' ? 'lab' : 'imaging');
  const section = p.section === 'lab' ? 'lab' : sec;
  const q = useQuery({ queryKey: ['ops-dx', section, by, p.from, p.to, p.dept], queryFn: () => api<{ unit: 'min' | 'hours';
    rows: { key: string; label: string; ordered: number; cancelled: number; external: number; external_pct: number | null; resulted: number; tat_median: number | null; tat_p90: number | null; tat_avg: number | null }[] }>(
    '/reporting/ops/dx', { query: { ...q0(p), section, by } }) });
  const byOpts = p.section === 'lab' ? ['device', 'group'] : ['device', 'modality', 'group'];
  const un = q.data?.unit === 'hours' ? 'hours' : 'min';
  const max = Math.max(0, ...(q.data?.rows.map((r) => r.ordered) ?? [0]));
  return (
    <section className="card" style={{ overflowX: 'auto' }}>
      <div className="card-pad row" style={{ paddingBottom: 0, flexWrap: 'wrap', gap: 8 }}>
        <strong className="grow">{p.section === 'lab' ? 'ლაბორატორია' : 'ინსტრუმენტული კვლევები'}</strong>
        {p.section !== 'lab' && <select className="select" style={{ height: 34, width: 'auto' }} value={sec} onChange={(e) => setSec(e.target.value)} aria-label="სექცია">
          <option value="imaging">რადიოლოგია + ენდოსკოპია</option><option value="radiology">რადიოლოგია</option><option value="endoscopy">ენდოსკოპია</option></select>}
        <div className="seg" role="group" aria-label="ჭრილი">{byOpts.map((b) => <button key={b} type="button" aria-pressed={by === b} onClick={() => setBy(b)}>{BY_KA[b]}</button>)}</div>
        <Xls p={p} dataset="dx" extra={{ section, by }} />
      </div>
      <ErrorBox error={q.error} />
      {!q.data ? <Loading /> : (
        <table className="table">
          <thead><tr><th>{BY_KA[by].replace('ით', 'ი')}</th><th className="num">დანიშნული</th><th style={{ width: 110 }} /><th className="num">გაუქმ.</th><th className="num">გარე</th>
            <th className="num">შესრულ.</th><th className="num">TAT მედიანა</th><th className="num">TAT P90</th><th className="num">TAT საშ.</th></tr></thead>
          <tbody>{q.data.rows.map((r) => (
            <tr key={r.key || '-'}><td>{r.label}</td><td className="num mono">{r.ordered}</td><td><Bar value={r.ordered} max={max} /></td><td className="num mono">{r.cancelled || '—'}</td>
              <td className="num mono">{r.external ? `${r.external} (${pc(r.external_pct)})` : '—'}</td><td className="num mono">{r.resulted}</td>
              <td className="num mono">{fmtVal(r.tat_median, un)}</td><td className="num mono">{fmtVal(r.tat_p90, un)}</td><td className="num mono">{fmtVal(r.tat_avg, un)}</td></tr>))}
            {!q.data.rows.length && <tr><td colSpan={9} className="muted">მონაცემი არ არის</td></tr>}</tbody>
        </table>)}
      <p className="hint card-pad" style={{ margin: 0 }}>დანიშნული / გაუქმებული / გარე — დანიშვნის დღით; შესრულებული და TAT — ვალიდაციის დღით. ლაბ. ანალიზატორი — პირველი შედეგის აპარატი. TAT მედიანა / P90 — ≈ (ინტერვალებიდან).</p>
    </section>
  );
}

// ------------------------------------------------------------------------------------ მარაგი
function Stock(p: P) {
  const q = useQuery({ queryKey: ['ops-stock', p.from, p.to, p.dept], queryFn: () => api<{ window_days: number; dead_stock_days: number;
    locations: { location_id: string; location_name: string; department_name: string | null; consumption: number; loss: number; receipts: number }[];
    daily: { day: string; consumption: number }[];
    top_items: { item_name: string; item_code: string; unit: string; location_name: string; used: number; qty: number; days: number | null; value: number }[];
    dead_stock: { item_name: string; item_code: string; location_name: string; qty: number; value: number; last_move_at: string | null }[] }>('/reporting/ops/stock', { query: q0(p) }) });
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data) return <Loading />;
  const d = q.data; const max = Math.max(0, ...d.locations.map((l) => l.consumption));
  return <>
    <section className="card card-pad stack" style={{ gap: 6 }}><strong>მარაგის ხარჯი დღეების მიხედვით (₾)</strong>
      <BarChart points={d.daily.map((x) => ({ label: x.day.slice(5), value: x.consumption }))} format={(v) => fmtVal(v, 'gel')} height={140} /></section>
    <section className="card" style={{ overflowX: 'auto' }}>
      <div className="card-pad" style={{ paddingBottom: 0 }}><strong>ლოკაციები (პერიოდი)</strong></div>
      <table className="table">
        <thead><tr><th>ლოკაცია</th><th className="num">ხარჯი</th><th style={{ width: 130 }} /><th className="num">დანაკარგი</th><th className="num">მიღება</th></tr></thead>
        <tbody>{d.locations.map((l) => <tr key={l.location_id}><td>{l.location_name}{l.department_name && <span className="small muted"> · {l.department_name}</span>}</td>
          <td className="num mono">{fmtVal(l.consumption, 'gel')}</td><td><Bar value={l.consumption} max={max} /></td>
          <td className="num mono" style={{ color: l.loss ? 'var(--warn-ink)' : undefined }}>{l.loss ? fmtVal(l.loss, 'gel') : '—'}</td><td className="num mono">{l.receipts ? fmtVal(l.receipts, 'gel') : '—'}</td></tr>)}
          {!d.locations.length && <tr><td colSpan={5} className="muted">მონაცემი არ არის</td></tr>}</tbody>
      </table>
    </section>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 10, alignItems: 'start' }}>
      <section className="card" style={{ overflowX: 'auto' }}>
        <div className="card-pad" style={{ paddingBottom: 0 }}><strong>ყველაზე ხარჯვადი (ბოლო {d.window_days} დღე)</strong></div>
        <table className="table"><thead><tr><th>პოზიცია</th><th className="num">ხარჯი</th><th className="num">ნაშთი</th><th className="num">დღე</th></tr></thead>
          <tbody>{d.top_items.map((t, i) => <tr key={i}><td><span className="mono small muted">{t.item_code}</span> {t.item_name}<div className="small muted">{t.location_name}</div></td>
            <td className="num mono">{nv(t.used)} <span className="small muted">{t.unit}</span></td><td className="num mono">{nv(t.qty)}</td><td className="num mono">{nv(t.days)}</td></tr>)}
            {!d.top_items.length && <tr><td colSpan={4} className="muted">მონაცემი არ არის</td></tr>}</tbody></table>
      </section>
      <section className="card" style={{ overflowX: 'auto' }}>
        <div className="card-pad" style={{ paddingBottom: 0 }}><strong>მოძრაობის გარეშე (&gt; {d.dead_stock_days} დღე)</strong></div>
        <table className="table"><thead><tr><th>პოზიცია</th><th className="num">ნაშთი</th><th className="num">ღირებულება</th><th>ბოლო მოძრაობა</th></tr></thead>
          <tbody>{d.dead_stock.map((t, i) => <tr key={i}><td><span className="mono small muted">{t.item_code}</span> {t.item_name}<div className="small muted">{t.location_name}</div></td>
            <td className="num mono">{nv(t.qty)}</td><td className="num mono">{fmtVal(t.value, 'gel')}</td><td className="small">{fmtTime(t.last_move_at)}</td></tr>)}
            {!d.dead_stock.length && <tr><td colSpan={4} className="muted">ასეთი პოზიცია არ არის</td></tr>}</tbody></table>
      </section>
    </div>
  </>;
}

// ------------------------------------------------------------------------------------ ექიმები
const ROLE_KA: Record<string, string> = { surgeon: 'ქირურგი', attending: 'მკურნალი ექიმი', validator: 'ვალიდატორი / რადიოლოგი' };
const DOC_COLS: Record<string, [string, string, 'n' | 'pct' | 'min' | 'days'][]> = {
  surgeon: [['done', 'ოპერაცია', 'n'], ['scheduled', 'დაგეგმილი', 'n'], ['cancel_pct', 'გაუქმება', 'pct'], ['first_on_time_pct', 'პირველი დროული', 'pct'], ['surgery_min_avg', 'საშ. ხანგრძლ.', 'min']],
  attending: [['admissions', 'მიღება', 'n'], ['discharges', 'გაწერა', 'n'], ['alos', 'ALOS', 'days'], ['mortality_pct', 'ლეტალობა', 'pct'], ['readmit30_pct', 'განმ. 30 დღე', 'pct']],
  validator: [['resulted', 'შესრულებული', 'n'], ['tat_median_min', 'TAT მედიანა', 'min'], ['tat_avg_min', 'TAT საშ.', 'min']],
};
function Doctors(p: P) {
  const [role, setRole] = useState('surgeon');
  const q = useQuery({ queryKey: ['ops-doctors', role, p.from, p.to, p.dept], queryFn: () => api<{ min_cases: number; mode: string; rows: (Record<string, number | string | boolean | null> & { doctor_id: string; doctor_name: string; small: boolean })[] }>(
    '/reporting/ops/doctors', { query: { ...q0(p), role } }) });
  const cols = DOC_COLS[role];
  const fmt = (v: unknown, t: string) => (v === null || v === undefined ? '—' : t === 'pct' ? `${v}%` : t === 'min' ? `${v} წთ` : t === 'days' ? `${v} დღე` : String(v));
  return (
    <section className="card" style={{ overflowX: 'auto' }}>
      <div className="card-pad row" style={{ paddingBottom: 0, gap: 8, flexWrap: 'wrap' }}>
        <strong className="grow">ექიმის ჭრილი</strong>
        <div className="seg" role="group" aria-label="როლი">{Object.entries(ROLE_KA).map(([k, v]) => <button key={k} type="button" aria-pressed={role === k} onClick={() => setRole(k)}>{v}</button>)}</div>
        <Xls p={p} dataset="doctors" extra={{ role }} />
      </div>
      <ErrorBox error={q.error} />
      {!q.data ? <Loading /> : <>
        <table className="table">
          <thead><tr><th>ექიმი</th>{cols.map(([k, l]) => <th key={k} className="num">{l}</th>)}</tr></thead>
          <tbody>{q.data.rows.map((r) => (
            <tr key={r.doctor_id} style={{ opacity: r.small ? 0.7 : 1 }}><td>{r.doctor_name}{r.small && <span className="chip" style={{ marginLeft: 6, height: 18 }} title={`< ${q.data!.min_cases} შემთხვევა — % / საშუალო არ ჩანს`}>მცირე ნიმუში</span>}</td>
              {cols.map(([k, , t]) => <td key={k} className="num mono">{fmt(r[k], t)}</td>)}</tr>))}
            {!q.data.rows.length && <tr><td colSpan={cols.length + 1} className="muted">მონაცემი არ არის</td></tr>}</tbody>
        </table>
        <p className="hint card-pad" style={{ margin: 0 }}>{q.data.min_cases}-ზე ნაკლებ შემთხვევაზე % და საშუალო არ ჩანს (მცირე ნიმუში). მკურნალი ექიმი — შემთხვევის ახლანდელი მკურნალი. ნახვა აუდიტში იწერება.</p>
      </>}
    </section>
  );
}
