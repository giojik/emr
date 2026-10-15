import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import { LineChart, StackBar } from '../../components/charts';
import { ErrorBox, Loading } from '../../components/ui';
import { Bar } from '../finance/types';
import { downloadFile, fmtTime, fmtVal, type RptMeta } from './types';

/**
 * ფინანსური დაფა (0063): შეჯამება (შემოსავალი / ხარჯი / შედეგი, 13 თვე, გადამხდელები, განყოფილებები),
 * დებიტორები / კრედიტორები (კლინიკის ხედვა), შემოსავალი ექიმზე (შემსრულებელი / დამნიშნავი).
 */
type Sub = 'summary' | 'balances' | 'doctors';
const SUB_KA: Record<Sub, string> = { summary: 'შეჯამება', balances: 'დებიტორები / კრედიტორები', doctors: 'შემოსავალი ექიმზე' };
interface P { meta: RptMeta; from: string; to: string; dept: string }
const q0 = (p: P) => ({ from: p.from, to: p.to, department_id: p.dept || undefined });
const segBtn = { background: 'none', borderTop: 0, borderLeft: 0, borderRight: 0, font: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap' } as const;
const gel = (v: number | null | undefined) => fmtVal(v ?? null, 'gel');
const pc = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v}%`);
const KIND_COLOR: Record<string, string> = { patient: 'var(--accent)', insurance: '#7c5cd6', state: '#1f9d8a', other: '#c08a1e', undetermined: 'var(--muted)' };

type Calc = { patient: number; insurance: number; state: number; other: number; undetermined: number; writeoff: number; denied: number; stock_cost: number; expenses: number;
  payments: number; rev_net: number; costs: number; result: number; margin_pct: number | null; collection_pct: number | null };
interface Summary {
  from: string; to: string; scope_all: boolean; totals: Calc;
  kinds: { kind: string; name: string; amount: number; share_pct: number | null }[];
  payers: { payer_id: string; name: string; kind: string; kind_ka: string; amount: number; share_pct: number | null }[];
  monthly: (Calc & { month: string; closed: boolean })[];
  departments: (Calc & { department_id: string | null; department_name: string })[];
  closed_months: string[]; open_months: string[];
}
type BalRow = { party_id: string | null; party_name: string; party_kind_ka: string | null; items: number; unclaimed: number; draft: number; not_due: number; d1_30: number; d31_60: number;
  d61_90: number; d90: number; total: number };
type BalGroup = { kind: string; name: string; rows: BalRow[]; totals: Omit<BalRow, 'party_id' | 'party_name' | 'party_kind_ka' | 'items'> };
interface Balances { as_of: string; snapshot_day: string | null; computed_at: string | null; ar_payer: BalGroup; ar_patient: BalGroup; ap: BalGroup;
  trend: { month: string; ar_payer: number | null; ar_patient: number | null; ap: number | null }[] }
interface DocRev { basis: string; basis_ka: string; total_net: number; rows: { doctor_id: string | null; doctor_name: string; unassigned: boolean; net: number; patient: number; insurance: number;
  state: number; other: number; undetermined: number; writeoff: number; denied: number; share_pct: number | null; categories: { category: string; name: string; amount: number }[] }[] }

function Xls({ p, dataset, extra, label = 'Excel' }: { p: P; dataset: string; extra?: Record<string, string | undefined>; label?: string }) {
  const [err, setErr] = useState<unknown>(null);
  return <>
    <button className="btn sm" type="button" onClick={() => downloadFile('/reporting/fin/export', { dataset, format: 'xlsx', ...q0(p), ...extra }, `fin_${dataset}.xlsx`).catch(setErr)}>{label}</button>
    {!!err && <ErrorBox error={err} />}
  </>;
}

/** ექიმის შემოსავალი ჩანს? (სერვერის წესის ასახვა — საბოლოო შემოწმება სერვერზეა) */
export const doctorRevenueVisible = (m: RptMeta) => m.scope.finance && m.settings.doctor_revenue !== 'off' && m.settings.doctor_breakdown !== 'off'
  && (m.scope.all || m.settings.doctor_breakdown === 'scoped');

export default function Finance(p: P) {
  const subs = (Object.keys(SUB_KA) as Sub[]).filter((s) => (s !== 'balances' || p.meta.scope.all) && (s !== 'doctors' || doctorRevenueVisible(p.meta)));
  const [sub, setSub] = useState<Sub>('summary');
  return (
    <div className="content">
      <nav className="row" style={{ gap: 2, flexWrap: 'wrap' }} aria-label="ფინანსები">
        {subs.map((s) => <button key={s} type="button" className={`admin-tab${sub === s ? ' active' : ''}`} style={segBtn} onClick={() => setSub(s)}>{SUB_KA[s]}</button>)}
      </nav>
      {sub === 'summary' ? <SummaryView {...p} /> : sub === 'balances' ? <BalancesView {...p} /> : <DoctorsView {...p} />}
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="card card-pad" style={{ display: 'flex', flexDirection: 'column', gap: 4, borderLeft: tone ? `4px solid ${tone}` : undefined }}>
      <span className="small muted">{label}</span>
      <span className="mono" style={{ fontSize: 21, fontWeight: 600 }}>{value}</span>
      {sub && <span className="small muted">{sub}</span>}
    </div>
  );
}

// ------------------------------------------------------------------------------------ შეჯამება
function SummaryView(p: P) {
  const q = useQuery({ queryKey: ['fin-summary', p.from, p.to, p.dept], queryFn: () => api<Summary>('/reporting/fin/summary', { query: q0(p) }) });
  const d = q.data;
  if (q.error) return <ErrorBox error={q.error} />;
  if (!d) return <Loading />;
  const t = d.totals;
  const maxDept = Math.max(0, ...d.departments.map((x) => Math.abs(x.rev_net)));
  const net = d.kinds.filter((k) => KIND_COLOR[k.kind]);
  return <>
    {d.open_months.length > 0 && <div className="alert warn small">ფინანსური პერიოდი ჯერ არ არის დახურული ({d.open_months.join(', ')}) — ციფრები შეიძლება შეიცვალოს.
      {d.closed_months.length > 0 && <> დახურული ({d.closed_months.join(', ')}) — გაყინულია.</>}</div>}
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 10, flexShrink: 0 }}>
      <Stat label="შემოსავალი (წმინდა)" value={gel(t.rev_net)} sub="უარის და ჩამოწერის შემდეგ" />
      <Stat label="ხარჯი" value={gel(t.costs)} sub={`მარაგი ${gel(t.stock_cost)} · სხვა ${gel(t.expenses)}`} />
      <Stat label="შედეგი" value={gel(t.result)} tone={t.result < 0 ? 'var(--danger-ink)' : 'var(--ok-ink)'} sub={`მარჟა ${pc(t.margin_pct)}`} />
      <Stat label="გადახდები (სალარო)" value={gel(t.payments)} sub={`შემოსავლის ${pc(t.collection_pct)}`} />
      <Stat label="გადამხდელის უარი" value={gel(t.denied)} tone={t.denied ? 'var(--warn-ink)' : undefined} />
      <Stat label="ჩამოწერა" value={gel(t.writeoff)} />
    </div>
    <section className="card card-pad stack" style={{ gap: 8, flexShrink: 0 }}>
      <div className="row"><strong className="grow">ბოლო 13 თვე</strong><span className="small muted">თვის ჯამი; ✓ — დახურული ფინანსური თვე</span></div>
      <LineChart labels={d.monthly.map((m) => `${m.month.slice(2)}${m.closed ? ' ✓' : ''}`)} format={(v) => fmtVal(v, 'gel').replace('.00', '')}
        series={[{ name: 'შემოსავალი', values: d.monthly.map((m) => m.rev_net), color: 'var(--accent)' },
          { name: 'ხარჯი', values: d.monthly.map((m) => m.costs), color: '#c08a1e' },
          { name: 'შედეგი', values: d.monthly.map((m) => m.result), color: '#1f9d8a', dashed: true }]} />
    </section>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 420px), 1fr))', gap: 10, alignItems: 'start', flexShrink: 0 }}>
      <section className="card" style={{ overflowX: 'auto', flexShrink: 0 }}>
        <div className="card-pad stack" style={{ gap: 10, paddingBottom: 0 }}>
          <div className="row"><strong className="grow">გადამხდელები</strong><Xls p={p} dataset="payers" /></div>
          <StackBar parts={net.map((k) => ({ label: `${k.name} ${pc(k.share_pct)}`, value: Math.round(k.amount), color: KIND_COLOR[k.kind] }))} />
        </div>
        <table className="table">
          <thead><tr><th>გადამხდელი</th><th>სახე</th><th className="num">შემოსავალი</th><th className="num">წილი</th></tr></thead>
          <tbody>
            {d.kinds.filter((k) => k.amount && ['patient', 'undetermined'].includes(k.kind)).map((k) => <tr key={k.kind}><td>{k.name}</td><td className="muted small">—</td>
              <td className="num mono">{gel(k.amount)}</td><td className="num mono">{pc(k.share_pct)}</td></tr>)}
            {d.payers.map((x) => <tr key={x.payer_id}><td>{x.name}</td><td className="small">{x.kind_ka}</td><td className="num mono">{gel(x.amount)}</td><td className="num mono">{pc(x.share_pct)}</td></tr>)}
            {!d.payers.length && !t.patient && <tr><td colSpan={4} className="muted">მონაცემი არ არის</td></tr>}
          </tbody>
        </table>
        <p className="hint card-pad" style={{ margin: 0 }}>„დაუზუსტებელი“ — სტაციონარი, ჯერ ფინანსურად დახურული არ არის (გადამხდელის წილი უცნობია).</p>
      </section>
      <section className="card" style={{ overflowX: 'auto', flexShrink: 0 }}>
        <div className="card-pad row" style={{ paddingBottom: 0 }}><strong className="grow">განყოფილებები</strong><Xls p={p} dataset="departments" /></div>
        <table className="table">
          <thead><tr><th>განყოფილება</th><th className="num">შემოსავალი</th><th style={{ width: 110 }} /><th className="num">ხარჯი</th><th className="num">შედეგი</th><th className="num">მარჟა</th></tr></thead>
          <tbody>
            {d.departments.map((x) => <tr key={x.department_id ?? 'none'}><td>{x.department_name}</td><td className="num mono">{gel(x.rev_net)}</td>
              <td><Bar value={x.rev_net} max={maxDept} /></td><td className="num mono">{gel(x.costs)}</td>
              <td className="num mono" style={{ color: x.result < 0 ? 'var(--danger-ink)' : undefined }}>{gel(x.result)}</td><td className="num mono">{pc(x.margin_pct)}</td></tr>)}
            {!d.departments.length && <tr><td colSpan={6} className="muted">მონაცემი არ არის</td></tr>}
          </tbody>
        </table>
      </section>
    </div>
  </>;
}

// ------------------------------------------------------------------------------------ დებიტორები / კრედიტორები
const AGE: [keyof BalRow, string][] = [['unclaimed', 'შეუტანელი'], ['draft', 'მონახაზი'], ['not_due', 'ვადამდე'], ['d1_30', '1–30'], ['d31_60', '31–60'], ['d61_90', '61–90'], ['d90', '90+']];
function BalancesView(p: P) {
  const [asOf, setAsOf] = useState(p.meta.today);
  const q = useQuery({ queryKey: ['fin-bal', asOf], queryFn: () => api<Balances>('/reporting/fin/balances', { query: { as_of: asOf } }) });
  const d = q.data;
  const table = (g: BalGroup, cols: [keyof BalRow, string][]) => (
    <section className="card" style={{ overflowX: 'auto', flexShrink: 0 }} key={g.kind}>
      <div className="card-pad row" style={{ paddingBottom: 0 }}><strong className="grow">{g.name}</strong><span className="mono">{gel(g.totals.total)}</span></div>
      <table className="table">
        <thead><tr><th>{g.kind === 'ap' ? 'მომწოდებელი' : g.kind === 'ar_payer' ? 'გადამხდელი' : ''}</th>{cols.map(([, l]) => <th key={l} className="num">{l}</th>)}<th className="num">სულ</th></tr></thead>
        <tbody>
          {g.rows.map((r) => <tr key={r.party_id ?? r.party_name}><td>{r.party_name}{r.party_kind_ka && <div className="small muted">{r.party_kind_ka}</div>}</td>
            {cols.map(([k]) => <td key={k} className="num mono" style={{ color: (k === 'd90' || k === 'd61_90') && Number(r[k]) > 0 ? 'var(--danger-ink)' : undefined }}>{Number(r[k]) ? gel(Number(r[k])) : '—'}</td>)}
            <td className="num mono"><strong>{gel(r.total)}</strong></td></tr>)}
          {!g.rows.length && <tr><td colSpan={cols.length + 2} className="muted">ნაშთი არ არის</td></tr>}
          {g.rows.length > 1 && <tr><td><strong>სულ</strong></td>{cols.map(([k]) => <td key={k} className="num mono"><strong>{gel(Number(g.totals[k as keyof BalGroup['totals']]))}</strong></td>)}
            <td className="num mono"><strong>{gel(g.totals.total)}</strong></td></tr>}
        </tbody>
      </table>
    </section>);
  return <>
    <div className="row" style={{ flexWrap: 'wrap' }}>
      <label className="row small">მდგომარეობა <input className="input mono" type="date" style={{ height: 32, width: 150 }} value={asOf} max={p.meta.today} onChange={(e) => setAsOf(e.target.value || asOf)} /></label>
      <span className="grow" />
      {d && <span className="small muted">სურათი: {d.snapshot_day ?? '—'} · {fmtTime(d.computed_at)} (დღის ბოლო გადათვლა)</span>}
      <Xls p={p} dataset="ar" label="Excel — დებიტორები" extra={{ as_of: asOf, from: undefined, to: undefined }} /><Xls p={p} dataset="ap" label="Excel — კრედიტორები" extra={{ as_of: asOf, from: undefined, to: undefined }} />
    </div>
    <ErrorBox error={q.error} />
    {!d ? <Loading /> : !d.snapshot_day ? <div className="alert warn">ამ თარიღამდე სურათი არ არის — დებიტორები / კრედიტორები ყოველდღიურად იწერება 0063-დან.</div> : <>
      <section className="card card-pad stack" style={{ gap: 8, flexShrink: 0 }}>
        <div className="row"><strong className="grow">თვის ბოლოს</strong><span className="small muted">თვის ბოლო სურათი</span></div>
        <LineChart labels={d.trend.map((t) => t.month.slice(2))} format={(v) => fmtVal(v, 'gel').replace('.00', '')}
          series={[{ name: 'გადამხდელები', values: d.trend.map((t) => t.ar_payer), color: 'var(--accent)' }, { name: 'პაციენტები', values: d.trend.map((t) => t.ar_patient), color: '#7c5cd6' },
            { name: 'მომწოდებლები', values: d.trend.map((t) => t.ap), color: '#c08a1e', dashed: true }]} />
      </section>
      {table(d.ar_payer, AGE)}
      {table(d.ar_patient, AGE.slice(2))}
      {table(d.ap, AGE.slice(2))}
      <p className="hint" style={{ margin: 0 }}>ვადაგადაცილება — გადამხდელი: ქლეიმის ვადიდან; პაციენტი: ანგარიშის თარიღიდან (სტაციონარი — ფინანსური დახურვიდან); მომწოდებელი: ინვოისის ვადიდან (₾, ინვოისის კურსით).
        „შეუტანელი“ — ფინანსურად დახურული, ქლეიმში ჯერ არ შესული.</p>
    </>}
  </>;
}

// ------------------------------------------------------------------------------------ შემოსავალი ექიმზე
const BASIS_HINT: Record<string, string> = {
  performer: 'ოპერაცია → ქირურგი; კონსულტაცია → პასუხის ავტორი; ინსტრუმენტული კვლევა → ვალიდატორი; ლაბორატორია → ექიმზე არ მიეწერება; სხვა (საწოლ-დღე, მედიკამენტი…) → მკურნალი ექიმი.',
  referrer: 'კვლევა / ანალიზი → დამნიშნავი; კონსულტაცია → მომთხოვნი; ოპერაცია → ქირურგი; სხვა → მკურნალი ექიმი. ორი ხედი ერთმანეთს არ ემატება — ერთი და იგივე შემოსავალია.',
};
function DoctorsView(p: P) {
  const [basis, setBasis] = useState('performer');
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['fin-doctors', basis, p.from, p.to, p.dept], queryFn: () => api<DocRev>('/reporting/fin/doctors', { query: { ...q0(p), basis } }) });
  const d = q.data;
  const max = Math.max(0, ...(d?.rows.map((r) => r.net) ?? [0]));
  return (
    <section className="card" style={{ overflowX: 'auto', flexShrink: 0 }}>
      <div className="card-pad row" style={{ paddingBottom: 0, gap: 8, flexWrap: 'wrap' }}>
        <strong className="grow">შემოსავალი ექიმზე{d && <span className="muted mono" style={{ fontWeight: 400 }}> · {gel(d.total_net)}</span>}</strong>
        <div className="seg" role="group" aria-label="მიწერის წესი">
          {[['performer', 'შემსრულებელი'], ['referrer', 'დამნიშნავი']].map(([k, l]) => <button key={k} type="button" aria-pressed={basis === k} onClick={() => setBasis(k)}>{l}</button>)}
        </div>
        <Xls p={p} dataset="doctors" extra={{ basis }} />
      </div>
      <p className="hint card-pad" style={{ margin: 0, paddingBottom: 0 }}>{BASIS_HINT[basis]}</p>
      <ErrorBox error={q.error} />
      {!d ? <Loading /> : (
        <table className="table">
          <thead><tr><th>ექიმი</th><th className="num">შემოსავალი</th><th style={{ width: 120 }} /><th className="num">წილი</th><th className="num">პაციენტი</th><th className="num">დაზღვევა</th>
            <th className="num">სახელმწიფო</th><th className="num">დაუზუსტ.</th><th className="num">უარი</th></tr></thead>
          <tbody>
            {d.rows.map((r) => {
              const k = r.doctor_id ?? '—';
              return [
                <tr key={k} style={{ cursor: 'pointer', fontStyle: r.unassigned ? 'italic' : undefined }} onClick={() => setOpen(open === k ? null : k)} title="კატეგორიები">
                  <td>{open === k ? '▾' : '▸'} {r.doctor_name}</td><td className="num mono">{gel(r.net)}</td><td><Bar value={r.net} max={max} /></td><td className="num mono">{pc(r.share_pct)}</td>
                  <td className="num mono">{gel(r.patient)}</td><td className="num mono">{gel(r.insurance)}</td><td className="num mono">{gel(r.state)}</td>
                  <td className="num mono">{gel(r.undetermined)}</td><td className="num mono" style={{ color: r.denied ? 'var(--warn-ink)' : undefined }}>{r.denied ? gel(r.denied) : '—'}</td></tr>,
                open === k && <tr key={`${k}-c`}><td colSpan={9} className="small" style={{ background: 'var(--line-soft)' }}>
                  {r.categories.map((c) => `${c.name}: ${gel(c.amount)}`).join(' · ') || '—'}</td></tr>];
            })}
            {!d.rows.length && <tr><td colSpan={9} className="muted">მონაცემი არ არის</td></tr>}
          </tbody>
        </table>)}
      <p className="hint card-pad" style={{ margin: 0 }}>შემოსავალი — როგორც ფინანსურ KPI-ებში (ფასდაკლების / გადაფასების შემდეგ, დახურული თვე — გაყინული). ნახვა და ექსპორტი აუდიტში იწერება.</p>
    </section>
  );
}
