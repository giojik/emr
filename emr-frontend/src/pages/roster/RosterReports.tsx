import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import { BarChart, LineChart } from '../../components/charts';
import { ErrorBox, Loading } from '../../components/ui';
import { downloadFile } from '../reporting/types';

/**
 * ცვლები / მორიგეობა (0080): ანგარიშები / KPI — ზეგანაკვეთი, ნორმის შესრულება, გაცდენა / არყოფნა, დასაფარი, გაცვლები, ხარვეზები, წესები, დატვირთვა.
 * ხედვა — სერვერი (A2): სახელობითი სიები მხოლოდ HR / შემდგენს / ხელმძღვანელს / ბუღალტერს; ტიპები — იგივე, სხვაგან — კლასები.
 */
type Num = number | null;
type K = Record<string, Num>;
type Acc = Record<string, number>;
type OpenG = { key: string; name: string; n: number; ontime: number; late: number; unfilled: number; pending: number; volunteer: number; filled_pct: Num; fill_h_avg: Num; lead_h_avg: Num };
type Gap = { department_name: string; label: string; category_name: string | null; need: number; days_plan: number; plan: number; days_fact: number; fact: number };
interface Report {
  from: string; to: string; months: string[]; scope_label: string; preliminary: string[]; today: string;
  access: { named: boolean; types: boolean; closedOnly: boolean };
  settings: { rpt_norm_low_pct: number; rpt_chronic_ot_months: number; rpt_min_group: number; week_norm_hours: number };
  totals: Acc; kpi: K; trend: ({ month: string; preliminary: boolean } & Acc & K)[];
  by_department: ({ department_id: string; name: string; people: number; sick_masked: boolean } & Acc & K)[];
  by_category: ({ category: string | null; name: string } & Acc & K)[];
  overtime: { by_month: ({ month: string; preliminary: boolean } & Acc & K)[];
    top: { staff_id: string; name: string; department_name: string; position_name: string | null; months: number; ot_months: number; norm: number; fact: number; ot: number; ot_pay: number; ot_comp: number; preliminary: boolean }[];
    chronic: { staff_id: string; name: string; department_name: string; months: number; ot: number }[]; chronic_count: number };
  norm: { low_pct: number; buckets: { under: number; normal: number; over: number; no_norm: number };
    under: { month: string; staff_id: string; name: string; department_name: string; position_name: string | null; norm: number; fact: number; credit: number; fulfil_pct: Num; abs_wd: number; closed: boolean }[];
    no_home: { staff_id: string; name: string; department_name: string; months: number; fact: number; ot: number }[]; no_home_count: number };
  absence: { types_visible: boolean; by_type: { code: string; name: string; short: string; paid: boolean; counts_as_work: boolean; days: number; workdays: number; people: number; pct: Num }[];
    no_show_people: { staff_id: string; name: string; department_name: string; no_show: number }[];
    bradford: { staff_id: string; name: string; department_name: string; spells: number; days: number; score: number }[]; bradford_enabled: boolean };
  open: { totals: OpenG | null; by_source: OpenG[]; by_department: OpenG[]; by_category: OpenG[]; by_kind: OpenG[];
    list: { id: string; day: string; department_name: string; code: string; source_name: string; category: string | null; outcome: string; outcome_name: string; volunteer: boolean; fill_h: Num; lead_h: number }[] };
  swaps: { totals: { n: number; approved: number; refused: number; lapsed: number; pending: number; per100: Num; approved_pct: Num; peer_h_avg: Num; head_h_avg: Num; decided_h_avg: Num };
    by_kind: { key: string; name: string; n: number }[]; by_status: { key: string; name: string; n: number }[];
    by_department: { department_id: string; name: string; n: number; approved: number; per100: Num }[]; top: { staff_id: string; name: string; n: number }[] };
  gaps: { by_norm: Gap[]; by_duty: Gap[]; days: { day: string; kind: string; department_name: string; label: string; need: number; plan: number; fact: number }[] };
  rules: { by_rule: { key: string; name: string; n: number; mode: string }[]; people: { staff_id: string; name: string; n: number; rules: string }[];
    list: { day: string; name: string; department_name: string; rule_name: string; message: string }[] };
  load: { by_department: { department_id: string; name: string; care_name: string; limit: Num; pt_h: number; nurse_h: number; ratio: Num; census_h: number; over_h: number; over_pct: Num; nonurse_h: number; avg_patients: Num }[];
    by_hour: { hour: number; ratio: Num }[]; day_night: { key: string; name: string; ratio: Num; over_pct: Num; census_h: number }[]; profile_from: string };
}
interface Meta { today: string; access: { named: boolean; types: boolean; closedOnly: boolean; label: string; depts: string[] | null }; departments: { id: string; name: string }[];
  positions: { id: string; name: string }[]; categories: { code: string; name: string }[]; employment: { code: string; name: string }[] }

const fv = (v: Num | undefined, u = '') => (v === null || v === undefined ? '—' : `${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}${u}`);
const SECTIONS: [string, string][] = [['summary', 'შეჯამება'], ['overtime', 'ზეგანაკვეთი'], ['norm', 'ნორმა'], ['absence', 'გაცდენა / არყოფნა'], ['open', 'დასაფარი'],
  ['swaps', 'გაცვლები'], ['gaps', 'ხარვეზები'], ['rules', 'წესები'], ['load', 'დატვირთვა'], ['departments', 'განყოფილებები']];
const ym = (d: string) => d.slice(0, 7);
const addM = (m: string, n: number) => { const [y, mm] = m.split('-').map(Number); const x = new Date(Date.UTC(y, mm - 1 + n, 1)); return x.toISOString().slice(0, 7); };

function Card({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <section className="card" style={{ overflowX: 'auto', flexShrink: 0 }}>
      <div className="card-pad" style={{ paddingBottom: 6 }}><strong>{title}</strong>{sub && <span className="small muted"> — {sub}</span>}</div>
      {children}
    </section>
  );
}
const Empty = ({ cols }: { cols: number }) => <tr><td colSpan={cols} className="muted">მონაცემი არ არის</td></tr>;
const tone = (v: Num, good: number, warn: number, down = false) => (v === null ? '' : down ? (v <= good ? 'ok' : v <= warn ? 'warn' : 'danger') : v >= good ? 'ok' : v >= warn ? 'warn' : 'danger');
function Tile({ label, value, tn, sub }: { label: string; value: string; tn?: string; sub?: string }) {
  return (
    <div className="card card-pad stack" style={{ gap: 2 }}>
      <span className="small muted">{label}</span>
      <strong style={{ fontSize: 22, color: tn === 'danger' ? 'var(--danger-ink)' : tn === 'warn' ? 'var(--warn-ink)' : tn === 'ok' ? 'var(--ok-ink)' : undefined }}>{value}</strong>
      {sub && <span className="small muted">{sub}</span>}
    </div>
  );
}
const Named = ({ d }: { d: Report }) => (d.access.named ? null : <div className="small muted">სახელობითი სიები თქვენს ხედვაში არ ჩანს (მხოლოდ აგრეგატები).</div>);

export default function RosterReportsPage() {
  const [sp, setSp] = useSearchParams();
  const meta = useQuery({ queryKey: ['roster-rpt-meta'], queryFn: () => api<Meta>('/roster/reports/meta') });
  const today = meta.data?.today ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tbilisi' }).format(new Date());
  const [f, setF] = useState({ from: '', to: '', department_id: '', category: '', position_id: '', employment: '' });
  const p = { ...f, from: f.from || addM(ym(today), -1), to: f.to || addM(ym(today), -1) };
  const sec = sp.get('section') ?? 'summary';
  const setSec = (k: string) => { sp.set('section', k); setSp(sp, { replace: true }); };
  const q = useQuery({ queryKey: ['roster-rpt', p], queryFn: () => api<Report>('/roster/reports/summary', { query: p }), enabled: !!meta.data && p.from <= p.to });
  const [dl, setDl] = useState<unknown>(null);
  const preset = (k: string) => {
    const cur = ym(today); const y = Number(cur.slice(0, 4)); const m = Number(cur.slice(5, 7));
    if (k === 'month') setF({ ...f, from: cur, to: cur });
    if (k === 'prev') setF({ ...f, from: addM(cur, -1), to: addM(cur, -1) });
    if (k === 'quarter') { const qs = Math.floor((m - 1) / 3) * 3 + 1; setF({ ...f, from: `${y}-${String(qs).padStart(2, '0')}`, to: cur }); }
    if (k === 'year') setF({ ...f, from: `${y}-01`, to: cur });
    if (k === '12m') setF({ ...f, from: addM(cur, -11), to: cur });
  };
  const d = q.data; const M = meta.data;
  const sel = (k: keyof typeof f, label: string, opts: { id: string; name: string }[], all: string) => (
    <select className="select" style={{ maxWidth: 220, height: 38 }} aria-label={label} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })}>
      <option value="">{all}</option>{opts.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>);
  return (
    <div className="content">
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <input type="month" className="input" style={{ maxWidth: 170, height: 38 }} aria-label="თვიდან" value={p.from} onChange={(e) => e.target.value && setF({ ...f, from: e.target.value })} />
        <input type="month" className="input" style={{ maxWidth: 170, height: 38 }} aria-label="თვემდე" value={p.to} onChange={(e) => e.target.value && setF({ ...f, to: e.target.value })} />
        <select className="select" style={{ maxWidth: 150, height: 38 }} aria-label="პერიოდი" value="" onChange={(e) => preset(e.target.value)}>
          <option value="">პერიოდი…</option><option value="month">მიმდინარე თვე</option><option value="prev">წინა თვე</option><option value="quarter">კვარტალი</option>
          <option value="year">წელი</option><option value="12m">ბოლო 12 თვე</option></select>
        {M && sel('department_id', 'განყოფილება', M.departments, M.access.depts ? 'ჩემი განყოფილებები' : 'ყველა განყოფილება')}
        {M && sel('category', 'კატეგორია', M.categories.map((c) => ({ id: c.code, name: c.name })), 'ყველა კატეგორია')}
        {M && sel('position_id', 'პოზიცია', M.positions, 'ყველა პოზიცია')}
        {M && sel('employment', 'შრომითი ურთიერთობა', M.employment.map((c) => ({ id: c.code, name: c.name })), 'ყველა ურთიერთობა')}
        <span className="grow" />
        <button className="btn" type="button" disabled={!d} onClick={() => { setDl(null); downloadFile('/roster/reports/export', p, `roster_report_${p.from}_${p.to}.xlsx`).catch(setDl); }}>Excel</button>
      </div>
      <nav className="row" aria-label="ანგარიშის სექციები" style={{ gap: 2, flexWrap: 'wrap' }}>
        {SECTIONS.map(([k, l]) => <button key={k} type="button" className={`admin-tab${sec === k ? ' active' : ''}`} aria-pressed={sec === k} onClick={() => setSec(k)}>{l}</button>)}
      </nav>
      <ErrorBox error={meta.error ?? q.error ?? dl} />
      {p.from > p.to && <div className="alert warn">პერიოდის დასაწყისი დასასრულზე გვიანაა.</div>}
      {q.isLoading || meta.isLoading ? <Loading /> : d && <>
        <div className="small muted">{d.scope_label} · {d.from} — {d.to} ({d.months.length} თვე)
          {d.preliminary.length > 0 && <> · <span className="chip warn">წინასწარი: {d.preliminary.join(', ')}</span> (ტაბელი დახურული არ არის — ცოცხალი გამოთვლა)</>}
          {d.access.closedOnly && ' · თვიური მაჩვენებლები — მხოლოდ დახურული თვეებიდან'}.
          ნორმა / ზეგანაკვეთი — ადამიანზე ერთხელ, ძირითად განყოფილებაში (ყველა განრიგით); დღიური მაჩვენებლები — დღემდე, განრიგის განყოფილებით. იგივე ფორმულა — მენეჯერულ დაფაზე (ჯგუფი „პერსონალი / ცვლები“).</div>
        {sec === 'summary' && <Summary d={d} />}
        {sec === 'overtime' && <Overtime d={d} />}
        {sec === 'norm' && <Norm d={d} />}
        {sec === 'absence' && <Absence d={d} />}
        {sec === 'open' && <Open d={d} />}
        {sec === 'swaps' && <Swaps d={d} />}
        {sec === 'gaps' && <Gaps d={d} />}
        {sec === 'rules' && <Rules d={d} />}
        {sec === 'load' && <Load d={d} />}
        {sec === 'departments' && <Depts d={d} />}
      </>}
    </div>
  );
}

function Summary({ d }: { d: Report }) {
  const k = d.kpi; const t = d.totals; const tr = d.trend;
  return (<>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 10, flexShrink: 0 }}>
      <Tile label="ზეგანაკვეთი" value={k.roster_overtime_h !== null ? `${fv(k.roster_overtime_h)} სთ` : '—'} sub={`${fv(k.roster_overtime_pct, '%')} ნორმის · ${t.ot_staff} ადამიანი-თვე`} />
      <Tile label="ნორმის შესრულება" value={fv(k.roster_norm_fulfil_pct, '%')} sub={`ფაქტი ${fv(t.fact_h)} / ნორმა ${fv(t.norm_h)} სთ · < ${d.settings.rpt_norm_low_pct}%: ${t.under_staff}`} />
      <Tile label="„არ გამოცხადდა“" value={fv(k.roster_no_show_pct, '%')} tn={tone(k.roster_no_show_pct, 1, 3, true)} sub={`${t.no_show} / ${t.shifts} ცვლა`} />
      <Tile label="არყოფნა" value={fv(k.roster_absence_pct, '%')} sub={`ბიულეტენი ${fv(k.roster_sick_pct, '%')} · ${t.abs_wd} სამ. დღე`} />
      <Tile label="დასაფარი — დაწყებამდე" value={fv(k.roster_open_filled_pct, '%')} tn={tone(k.roster_open_filled_pct, 90, 70)} sub={`${t.open_ontime} / ${t.open_n} · დაფარვამდე ${fv(k.roster_open_fill_h)} სთ`} />
      <Tile label="ნორმის ხარვეზი (ფაქტით)" value={fv(k.roster_norm_gaps)} tn={k.roster_norm_gaps ? 'warn' : 'ok'} sub={`გეგმით ${t.norm_gaps_plan}`} />
      <Tile label="მორიგის ხარვეზი (ფაქტით)" value={fv(k.roster_duty_gaps)} tn={k.roster_duty_gaps ? 'danger' : 'ok'} sub={`გეგმით ${t.duty_gaps_plan}`} />
      <Tile label="წესის დარღვევა" value={fv(t.viol_rest + t.viol_continuous + t.viol_week + t.viol_nights)} sub={`გაცვლა ${t.swaps} (დადასტ. ${t.swaps_approved})`} />
      <Tile label="პაციენტი / ექთანი" value={fv(k.roster_nurse_ratio)} sub={`ზღვარზე მეტი ${fv(k.roster_load_over_pct, '%')} საათების · ექთნის გარეშე ${t.nonurse_h} სთ`}
        tn={tone(k.roster_load_over_pct, 5, 20, true)} />
    </div>
    {tr.length > 0 && <Card title="ტრენდი — 13 თვე" sub="თვე ითვლება წინასწარად, სანამ ტაბელი არ დაიხურება">
      <div className="card-pad"><LineChart labels={tr.map((x) => x.month.slice(2))} format={(v) => `${Math.round(v * 10) / 10}%`} series={[
        { name: 'ნორმის შესრულება %', values: tr.map((x) => x.roster_norm_fulfil_pct), color: 'var(--accent)' },
        { name: 'არყოფნა %', values: tr.map((x) => x.roster_absence_pct), color: 'var(--warn-ink)', dashed: true },
        { name: '„არ გამოცხადდა“ %', values: tr.map((x) => x.roster_no_show_pct), color: 'var(--danger-ink)', dashed: true }]} />
        <div className="small muted" style={{ marginTop: 8 }}>ზეგანაკვეთი თვეში, სთ</div>
        <BarChart height={120} points={tr.map((x) => ({ label: x.month.slice(2), value: x.ot_h ?? 0 }))} /></div>
    </Card>}
  </>);
}

function Overtime({ d }: { d: Report }) {
  const o = d.overtime;
  return (<>
    <Card title="ზეგანაკვეთი თვეების მიხედვით" sub="ანაზღ. / COMP — დახურულში HR-ის არჩევანი, წინასწარში — ნაგულისხმევი">
      <table className="table small"><thead><tr><th>თვე</th><th className="num">ადამიანი</th><th className="num">ნორმა</th><th className="num">ფაქტი</th><th className="num">ჩათვლ.</th>
        <th className="num">ზეგანაკვეთი</th><th className="num">ანაზღ.</th><th className="num">COMP</th><th className="num">ზეგ. მქონე</th><th className="num">ზეგ. %</th></tr></thead>
        <tbody>{o.by_month.map((x) => <tr key={x.month}><td>{x.month} {x.preliminary && <span className="chip warn">წინასწ.</span>}</td><td className="num">{x.staff}</td><td className="num">{fv(x.norm_h)}</td>
          <td className="num">{fv(x.fact_h)}</td><td className="num">{fv(x.credit_h)}</td><td className="num"><strong>{fv(x.ot_h)}</strong></td><td className="num">{fv(x.ot_pay_h)}</td><td className="num">{fv(x.ot_comp_h)}</td>
          <td className="num">{x.ot_staff}</td><td className="num">{fv(x.roster_overtime_pct, '%')}</td></tr>)}</tbody></table>
    </Card>
    <Card title="კატეგორიები"><table className="table small"><thead><tr><th>კატეგორია</th><th className="num">ადამიანი-თვე</th><th className="num">ნორმა</th><th className="num">ზეგანაკვეთი</th><th className="num">ზეგ. %</th><th className="num">შესრულება</th></tr></thead>
      <tbody>{d.by_category.map((x) => <tr key={x.category ?? '-'}><td>{x.name}</td><td className="num">{x.staff}</td><td className="num">{fv(x.norm_h)}</td><td className="num">{fv(x.ot_h)}</td>
        <td className="num">{fv(x.roster_overtime_pct, '%')}</td><td className="num">{fv(x.roster_norm_fulfil_pct, '%')}</td></tr>)}{!d.by_category.length && <Empty cols={6} />}</tbody></table></Card>
    <Named d={d} />
    {d.access.named && <Card title="ტოპ-20 ზეგანაკვეთი" sub="პერიოდის ჯამი">
      <table className="table small"><thead><tr><th>თანამშრომელი</th><th>განყოფილება</th><th>პოზიცია</th><th className="num">თვე</th><th className="num">ზეგ. თვე</th><th className="num">ნორმა</th>
        <th className="num">ფაქტი</th><th className="num">ზეგანაკვეთი</th><th className="num">ანაზღ.</th><th className="num">COMP</th></tr></thead>
        <tbody>{o.top.map((x) => <tr key={x.staff_id}><td>{x.name} {x.preliminary && <span className="chip warn">წინასწ.</span>}</td><td>{x.department_name}</td><td>{x.position_name ?? '—'}</td>
          <td className="num">{x.months}</td><td className="num">{x.ot_months}</td><td className="num">{fv(x.norm)}</td><td className="num">{fv(x.fact)}</td><td className="num"><strong>{fv(x.ot)}</strong></td>
          <td className="num">{fv(x.ot_pay)}</td><td className="num">{fv(x.ot_comp)}</td></tr>)}{!o.top.length && <Empty cols={10} />}</tbody></table></Card>}
    <Card title="ქრონიკული ზეგანაკვეთი" sub={`ბოლო 6 დახურული თვიდან ≥ ${d.settings.rpt_chronic_ot_months}-ში · ${o.chronic_count} ადამიანი`}>
      {d.access.named ? <table className="table small"><thead><tr><th>თანამშრომელი</th><th>განყოფილება</th><th className="num">თვე</th><th className="num">ზეგანაკვეთი</th></tr></thead>
        <tbody>{o.chronic.map((x) => <tr key={x.staff_id}><td>{x.name}</td><td>{x.department_name}</td><td className="num">{x.months}</td><td className="num">{fv(x.ot)}</td></tr>)}
          {!o.chronic.length && <Empty cols={4} />}</tbody></table> : <div className="card-pad small">{o.chronic_count} ადამიანი</div>}</Card>
  </>);
}

function Norm({ d }: { d: Report }) {
  const n = d.norm; const b = n.buckets;
  return (<>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 10, flexShrink: 0 }}>
      <Tile label={`< ${n.low_pct}% (ნაკლები)`} value={String(b.under)} tn={b.under ? 'warn' : 'ok'} sub="ადამიანი-თვე" />
      <Tile label={`${n.low_pct}–100%`} value={String(b.normal)} sub="ადამიანი-თვე" />
      <Tile label="> 100% (ზეგანაკვეთი)" value={String(b.over)} sub="ადამიანი-თვე" />
      <Tile label="ძირ. განყოფილების განრიგის გარეშე" value={String(n.no_home_count)} sub="ზეგანაკვეთი ჩანს მხოლოდ ანგარიშში / Excel-ში" />
    </div>
    <div className="small muted">შესრულება = (ფაქტი ყველა განრიგით + „ნამუშევრად ჩათვლილი“) / ნორმა; ნორმა = სამუშაო დღეები × {d.settings.week_norm_hours} / 5 × FTE − არყოფნის სამუშაო დღეები.</div>
    <Named d={d} />
    {d.access.named && <Card title="ნორმაზე ნაკლები" sub="ყველაზე დაბალი 50">
      <table className="table small"><thead><tr><th>თვე</th><th>თანამშრომელი</th><th>განყოფილება</th><th>პოზიცია</th><th className="num">ნორმა</th><th className="num">ფაქტი</th><th className="num">ჩათვლ.</th>
        <th className="num">შესრულება</th><th className="num">არყ. სამ. დღე</th></tr></thead>
        <tbody>{n.under.map((x) => <tr key={`${x.month}-${x.staff_id}`}><td>{x.month} {!x.closed && <span className="chip warn">წინასწ.</span>}</td><td>{x.name}</td><td>{x.department_name}</td>
          <td>{x.position_name ?? '—'}</td><td className="num">{fv(x.norm)}</td><td className="num">{fv(x.fact)}</td><td className="num">{fv(x.credit)}</td>
          <td className="num"><span className="chip warn">{fv(x.fulfil_pct, '%')}</span></td><td className="num">{x.abs_wd}</td></tr>)}{!n.under.length && <Empty cols={9} />}</tbody></table></Card>}
    {d.access.named && n.no_home.length > 0 && <Card title="ძირითადი განყოფილების განრიგის გარეშე" sub="მუშაობს მხოლოდ სხვა განყოფილებ(ებ)ის განრიგში">
      <table className="table small"><thead><tr><th>თანამშრომელი</th><th>განყოფილება</th><th className="num">თვე</th><th className="num">ფაქტი</th><th className="num">ზეგანაკვეთი</th></tr></thead>
        <tbody>{n.no_home.map((x) => <tr key={x.staff_id}><td>{x.name}</td><td>{x.department_name}</td><td className="num">{x.months}</td><td className="num">{fv(x.fact)}</td><td className="num">{fv(x.ot)}</td></tr>)}</tbody></table></Card>}
  </>);
}

function Absence({ d }: { d: Report }) {
  const a = d.absence;
  return (<>
    <Card title={a.types_visible ? 'არყოფნა ტიპებით' : 'არყოფნა კლასებით'} sub={a.types_visible ? 'დადასტურებული, პერიოდის თვეებში' : `ტიპები თქვენს ხედვაში არ ჩანს; ბიულეტენი ცალკე — მხოლოდ ≥ ${d.settings.rpt_min_group} ადამიანზე`}>
      <table className="table small"><thead><tr><th>{a.types_visible ? 'ტიპი' : 'კლასი'}</th><th className="num">დღე (ერთეულით)</th><th className="num">სამუშაო დღე</th><th className="num">ადამიანი</th><th className="num">% სამ. დღეებიდან</th></tr></thead>
        <tbody>{a.by_type.map((x) => <tr key={x.code}><td>{x.short && <span className="chip">{x.short}</span>} {x.name}{x.counts_as_work && <span className="small muted"> (ნამუშევრად ითვლება)</span>}</td>
          <td className="num">{fv(x.days)}</td><td className="num">{x.workdays}</td><td className="num">{x.people}</td><td className="num">{fv(x.pct, '%')}</td></tr>)}{!a.by_type.length && <Empty cols={5} />}</tbody></table>
    </Card>
    <Card title="განყოფილებები"><table className="table small"><thead><tr><th>განყოფილება</th><th className="num">ცვლები</th><th className="num">„არ გამოცხადდა“</th><th className="num">%</th>
      <th className="num">არყოფნა %</th><th className="num">ბიულეტენი %</th></tr></thead>
      <tbody>{d.by_department.filter((x) => x.shifts || x.emp_wd).map((x) => <tr key={x.department_id}><td>{x.name}</td><td className="num">{x.shifts}</td><td className="num">{x.no_show}</td>
        <td className="num">{fv(x.roster_no_show_pct, '%')}</td><td className="num">{fv(x.roster_absence_pct, '%')}</td>
        <td className="num">{x.sick_masked ? <span className="muted" title="მცირე ჯგუფი — ცალკე არ ჩანს">*</span> : fv(x.roster_sick_pct, '%')}</td></tr>)}</tbody></table></Card>
    <Named d={d} />
    {d.access.named && <Card title="„არ გამოცხადდა“ — თანამშრომლები"><table className="table small"><thead><tr><th>თანამშრომელი</th><th>განყოფილება</th><th className="num">რაოდენობა</th></tr></thead>
      <tbody>{a.no_show_people.map((x) => <tr key={x.staff_id}><td>{x.name}</td><td>{x.department_name}</td><td className="num">{x.no_show}</td></tr>)}{!a.no_show_people.length && <Empty cols={3} />}</tbody></table></Card>}
    {a.bradford_enabled && d.access.named && <Card title="Bradford factor" sub="S² × D (S — ბიულეტენის ეპიზოდი, D — სამუშაო დღე); ინფორმაციული">
      <table className="table small"><thead><tr><th>თანამშრომელი</th><th>განყოფილება</th><th className="num">S</th><th className="num">D</th><th className="num">ქულა</th></tr></thead>
        <tbody>{a.bradford.map((x) => <tr key={x.staff_id}><td>{x.name}</td><td>{x.department_name}</td><td className="num">{x.spells}</td><td className="num">{x.days}</td><td className="num"><strong>{x.score}</strong></td></tr>)}
          {!a.bradford.length && <Empty cols={5} />}</tbody></table></Card>}
  </>);
}

function OpenTable({ rows, first }: { rows: OpenG[]; first: string }) {
  return (
    <table className="table small"><thead><tr><th>{first}</th><th className="num">დასაფარი</th><th className="num">დაწყებამდე</th><th className="num">გვიან</th><th className="num">დაუფარავი</th>
      <th className="num">ღია (მომავალი)</th><th className="num">მოხალისე</th><th className="num">დაწყებამდე %</th><th className="num">დაფარვამდე, სთ</th><th className="num">წინასწარობა, სთ</th></tr></thead>
      <tbody>{rows.map((x) => <tr key={x.key}><td>{x.name}</td><td className="num">{x.n}</td><td className="num">{x.ontime}</td><td className="num">{x.late}</td><td className="num">{x.unfilled}</td>
        <td className="num">{x.pending}</td><td className="num">{x.volunteer}</td><td className="num"><span className={`chip ${tone(x.filled_pct, 90, 70)}`}>{fv(x.filled_pct, '%')}</span></td>
        <td className="num">{fv(x.fill_h_avg)}</td><td className="num">{fv(x.lead_h_avg)}</td></tr>)}{!rows.length && <Empty cols={10} />}</tbody></table>);
}
function Open({ d }: { d: Report }) {
  const o = d.open;
  return (<>
    <div className="small muted">დასაფარი — ცვლის დაწყების დღით; ითვლება, როცა დაწყება გავიდა. დაუფარავი = გაუქმებული ან დაწყებისას ღია.</div>
    <Card title="სულ">{o.totals ? <OpenTable rows={[o.totals]} first="" /> : <div className="card-pad muted small">მონაცემი არ არის</div>}</Card>
    <Card title="წყარო"><OpenTable rows={o.by_source} first="წყარო" /></Card>
    <Card title="განყოფილება"><OpenTable rows={o.by_department} first="განყოფილება" /></Card>
    <Card title="კატეგორია / ცვლის სახე"><OpenTable rows={[...o.by_category, ...o.by_kind]} first="ჭრილი" /></Card>
    <Card title="სია" sub="მაქს. 500">
      <table className="table small"><thead><tr><th>დღე</th><th>განყოფილება</th><th>ცვლა</th><th>წყარო</th><th>შედეგი</th><th className="num">დაფარვამდე, სთ</th><th className="num">წინასწარობა, სთ</th></tr></thead>
        <tbody>{o.list.map((x) => <tr key={x.id}><td>{x.day}</td><td>{x.department_name}</td><td className="mono">{x.code}</td><td>{x.source_name}</td>
          <td><span className={`chip ${x.outcome === 'ontime' ? 'ok' : x.outcome === 'late' ? 'warn' : x.outcome === 'unfilled' ? 'danger' : ''}`}>{x.outcome_name}</span>{x.volunteer && ' · მოხალისე'}</td>
          <td className="num">{fv(x.fill_h)}</td><td className="num">{fv(x.lead_h)}</td></tr>)}{!o.list.length && <Empty cols={7} />}</tbody></table></Card>
  </>);
}

function Swaps({ d }: { d: Report }) {
  const s = d.swaps; const t = s.totals;
  return (<>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 10, flexShrink: 0 }}>
      <Tile label="გაცვლა / გადაცემა" value={String(t.n)} sub={`${fv(t.per100)} 100 ცვლაზე`} />
      <Tile label="დადასტურდა" value={String(t.approved)} sub={`${fv(t.approved_pct, '%')} გადაწყვეტილიდან`} />
      <Tile label="უარი / ვადა გავიდა" value={`${t.refused} / ${t.lapsed}`} sub={`მიმდინარე ${t.pending}`} />
      <Tile label="გადაწყვეტამდე, სთ" value={fv(t.decided_h_avg)} sub={`კოლეგა ${fv(t.peer_h_avg)} · ხელმძღვ. ${fv(t.head_h_avg)}`} />
    </div>
    <Card title="სტატუსი / სახე"><table className="table small"><thead><tr><th>ჭრილი</th><th className="num">რაოდენობა</th></tr></thead>
      <tbody>{[...s.by_kind, ...s.by_status].map((x) => <tr key={x.key}><td>{x.name}</td><td className="num">{x.n}</td></tr>)}{!s.by_status.length && <Empty cols={2} />}</tbody></table></Card>
    <Card title="განყოფილებები"><table className="table small"><thead><tr><th>განყოფილება</th><th className="num">რაოდენობა</th><th className="num">დადასტურდა</th><th className="num">100 ცვლაზე</th></tr></thead>
      <tbody>{s.by_department.map((x) => <tr key={x.department_id}><td>{x.name}</td><td className="num">{x.n}</td><td className="num">{x.approved}</td><td className="num">{fv(x.per100)}</td></tr>)}
        {!s.by_department.length && <Empty cols={4} />}</tbody></table></Card>
    <Named d={d} />
    {d.access.named && <Card title="ინიციატორები"><table className="table small"><thead><tr><th>თანამშრომელი</th><th className="num">რაოდენობა</th></tr></thead>
      <tbody>{s.top.map((x) => <tr key={x.staff_id}><td>{x.name}</td><td className="num">{x.n}</td></tr>)}{!s.top.length && <Empty cols={2} />}</tbody></table></Card>}
  </>);
}

function GapTable({ rows, first }: { rows: Gap[]; first: string }) {
  return (
    <table className="table small"><thead><tr><th>განყოფილება</th><th>{first}</th><th className="num">საჭირო</th><th className="num">დღე (გეგმით)</th><th className="num">დაკლ. (გეგმით)</th>
      <th className="num">დღე (ფაქტით)</th><th className="num">დაკლ. (ფაქტით)</th></tr></thead>
      <tbody>{rows.map((x, i) => <tr key={i}><td>{x.department_name}</td><td>{x.label}{x.category_name && <span className="small muted"> · {x.category_name}</span>}</td><td className="num">{x.need}</td>
        <td className="num">{x.days_plan}</td><td className="num">{x.plan}</td><td className="num">{x.days_fact}</td><td className="num"><strong>{x.fact}</strong></td></tr>)}{!rows.length && <Empty cols={7} />}</tbody></table>);
}
function Gaps({ d }: { d: Report }) {
  return (<>
    <div className="small muted">გამოქვეყნებული / დახურული განრიგის დღეები, დღემდე. „ფაქტით“ — „არ გამოცხადდა“ აკლია. შევსების ნორმა — მიმდინარე (წარსულზეც).</div>
    <Card title="შევსების ნორმა" sub="ცვლა × კატეგორია"><GapTable rows={d.gaps.by_norm} first="ცვლა" /></Card>
    <Card title="მორიგეობა (I დონე)"><GapTable rows={d.gaps.by_duty} first="როლი" /></Card>
    <Card title="ყველაზე ცუდი დღეები" sub="მაქს. 200">
      <table className="table small"><thead><tr><th>დღე</th><th>სახე</th><th>განყოფილება</th><th>ცვლა / როლი</th><th className="num">საჭირო</th><th className="num">გეგმა</th><th className="num">ფაქტი</th></tr></thead>
        <tbody>{d.gaps.days.map((x, i) => <tr key={i}><td>{x.day}</td><td>{x.kind === 'duty' ? 'მორიგე' : 'ნორმა'}</td><td>{x.department_name}</td><td>{x.label}</td><td className="num">{x.need}</td>
          <td className="num">{x.plan}</td><td className="num">{x.fact}</td></tr>)}{!d.gaps.days.length && <Empty cols={7} />}</tbody></table></Card>
  </>);
}

function Rules({ d }: { d: Report }) {
  const MODE: Record<string, string> = { block: 'დაბლოკვა', warn: 'გაფრთხილება', off: 'გამორთული' };
  return (<>
    <div className="small muted">ფაქტით: „არ გამოცხადდა“ — არა, შესწორებული დრო / საათები გათვალისწინებულია. „მორიგეობა სახლიდან“ — არა.</div>
    <Card title="წესები"><table className="table small"><thead><tr><th>წესი</th><th>რეჟიმი</th><th className="num">დარღვევა</th></tr></thead>
      <tbody>{d.rules.by_rule.map((x) => <tr key={x.key}><td>{x.name}</td><td>{MODE[x.mode] ?? x.mode}</td><td className="num"><strong>{x.n}</strong></td></tr>)}</tbody></table></Card>
    <Named d={d} />
    {d.access.named && <Card title="თანამშრომლები"><table className="table small"><thead><tr><th>თანამშრომელი</th><th>წესები</th><th className="num">დარღვევა</th></tr></thead>
      <tbody>{d.rules.people.map((x) => <tr key={x.staff_id}><td>{x.name}</td><td>{x.rules}</td><td className="num">{x.n}</td></tr>)}{!d.rules.people.length && <Empty cols={3} />}</tbody></table></Card>}
    {d.access.named && <Card title="სია" sub="მაქს. 300"><table className="table small"><thead><tr><th>დღე</th><th>თანამშრომელი</th><th>განყოფილება</th><th>წესი</th><th>აღწერა</th></tr></thead>
      <tbody>{d.rules.list.map((x, i) => <tr key={i}><td>{x.day}</td><td>{x.name}</td><td>{x.department_name}</td><td>{x.rule_name}</td><td>{x.message}</td></tr>)}{!d.rules.list.length && <Empty cols={5} />}</tbody></table></Card>}
  </>);
}

function Load({ d }: { d: Report }) {
  const l = d.load;
  return (<>
    <div className="small muted">საათობრივად: პაციენტი = საწოლზე მიმაგრება (ან მის მოლოდინში), ექთანი = ცვლაში ფაქტით („მორიგეობა სახლიდან“ — არა). მხოლოდ სტაციონარის განყოფილებები თვის განრიგით. ინფორმაციული.</div>
    <Card title="განყოფილებები"><table className="table small"><thead><tr><th>განყოფილება</th><th>დონე</th><th className="num">ზღვარი</th><th className="num">პაციენტ-სთ</th><th className="num">ექთან-სთ</th>
      <th className="num">პაციენტი / ექთანი</th><th className="num">სთ პაციენტით</th><th className="num">ზღვარზე მეტი</th><th className="num">ექთნის გარეშე, სთ</th></tr></thead>
      <tbody>{l.by_department.map((x) => <tr key={x.department_id}><td>{x.name}</td><td>{x.care_name}</td><td className="num">{fv(x.limit)}</td><td className="num">{fv(x.pt_h)}</td><td className="num">{fv(x.nurse_h)}</td>
        <td className="num"><strong>{fv(x.ratio)}</strong></td><td className="num">{x.census_h}</td><td className="num"><span className={`chip ${tone(x.over_pct, 5, 20, true)}`}>{fv(x.over_pct, '%')}</span> ({x.over_h})</td>
        <td className="num">{x.nonurse_h ? <span className="chip danger">{x.nonurse_h}</span> : 0}</td></tr>)}{!l.by_department.length && <Empty cols={9} />}</tbody></table></Card>
    <Card title="საათობრივი პროფილი" sub={`პაციენტი / ექთანი დღის საათის მიხედვით (${l.profile_from}-დან)`}>
      <div className="card-pad"><BarChart height={140} points={l.by_hour.map((x) => ({ label: String(x.hour).padStart(2, '0'), value: x.ratio ?? 0 }))} /></div></Card>
    <Card title="დღე / ღამე, შაბ.–კვ."><table className="table small"><thead><tr><th>ჭრილი</th><th className="num">პაციენტი / ექთანი</th><th className="num">ზღვარზე მეტი</th><th className="num">სთ პაციენტით</th></tr></thead>
      <tbody>{l.day_night.map((x) => <tr key={x.key}><td>{x.name}</td><td className="num">{fv(x.ratio)}</td><td className="num">{fv(x.over_pct, '%')}</td><td className="num">{x.census_h}</td></tr>)}</tbody></table></Card>
  </>);
}

function Depts({ d }: { d: Report }) {
  return (
    <Card title="განყოფილებები" sub="თვიური — ძირითადი განყოფილება; დღიური — განრიგის განყოფილება">
      <table className="table small"><thead><tr><th>განყოფილება</th><th className="num">ადამიანი</th><th className="num">ნორმა</th><th className="num">ფაქტი</th><th className="num">ზეგანაკვ.</th>
        <th className="num">შესრულება</th><th className="num">„გ“ %</th><th className="num">არყოფნა %</th><th className="num">ნორმის ხარვ.</th><th className="num">მორიგის ხარვ.</th>
        <th className="num">დასაფარი</th><th className="num">დაწყებამდე %</th><th className="num">გაცვლა</th><th className="num">წესი</th><th className="num">პაციენტი / ექთანი</th></tr></thead>
        <tbody>{d.by_department.map((x) => <tr key={x.department_id}><td>{x.name}</td><td className="num">{x.people}</td><td className="num">{fv(x.norm_h)}</td><td className="num">{fv(x.fact_h)}</td>
          <td className="num">{fv(x.ot_h)}</td><td className="num">{fv(x.roster_norm_fulfil_pct, '%')}</td><td className="num">{fv(x.roster_no_show_pct, '%')}</td><td className="num">{fv(x.roster_absence_pct, '%')}</td>
          <td className="num">{x.norm_gaps_fact}</td><td className="num">{x.duty_gaps_fact}</td><td className="num">{x.open_n}</td><td className="num">{fv(x.roster_open_filled_pct, '%')}</td>
          <td className="num">{x.swaps}</td><td className="num">{x.viol_rest + x.viol_continuous + x.viol_week + x.viol_nights}</td><td className="num">{fv(x.roster_nurse_ratio)}</td></tr>)}
          {!d.by_department.length && <Empty cols={15} />}</tbody></table>
    </Card>
  );
}
