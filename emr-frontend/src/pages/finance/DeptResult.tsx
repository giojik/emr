import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import { ErrorBox, Loading } from '../../components/ui';
import { downloadCsv } from '../stock/types';
import type { TabProps } from './Finance';
import { ALLOC_KA, DEPT_BASIS_KA, type DeptResult, fmt, Kpi, STOCK_BASIS_KA } from './types';

/** განყოფილების შედეგი: წმინდა შემოსავალი − პირდაპირი ხარჯი − მარაგი − საერთო ხარჯის წილი (overhead_allocation) */
export default function DeptResultView({ from, to, summary }: TabProps) {
  const [alloc, setAlloc] = useState(summary.rules.overhead_allocation);
  const [dept, setDept] = useState(summary.rules.revenue_dept_basis);
  const q = useQuery({ queryKey: ['fin-result', from, to, alloc, dept], queryFn: () => api<DeptResult>('/finance/dept-result', { query: { from, to, allocation: alloc, dept_basis: dept } }) });
  const d = q.data;
  const head = ['განყოფილება', 'შემოსავალი', 'ჩამოწერა / უარი', 'წმინდა', 'პირდაპირი ხარჯი', 'მარაგი', 'საერთოს წილი', 'შედეგი', 'მარჟა %'];
  return (
    <div className="content">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <label className="row small">საერთო ხარჯის განაწილება
          <select className="select" style={{ height: 34 }} value={alloc} onChange={(e) => setAlloc(e.target.value as typeof alloc)}>
            {Object.entries(ALLOC_KA).map(([k, v]) => <option key={k} value={k}>{v}{k === summary.rules.overhead_allocation ? ' (ნაგულისხმევი)' : ''}</option>)}</select></label>
        <label className="row small">შემოსავალი
          <select className="select" style={{ height: 34 }} value={dept} onChange={(e) => setDept(e.target.value as typeof dept)}>
            {Object.entries(DEPT_BASIS_KA).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <span className="grow" />
        <button className="btn sm" type="button" disabled={!d?.rows.length} onClick={() => downloadCsv(`dept-result_${from}_${to}.csv`, head,
          d!.rows.map((r) => [r.department_name, r.revenue, r.writeoff, r.revenue_net, r.expenses, r.stock_cost, r.overhead, r.result].map((x) => (typeof x === 'number' ? x.toFixed(2) : x)).concat([r.margin_pct === null ? '' : String(r.margin_pct)])))}>CSV</button>
      </div>
      <ErrorBox error={q.error} />
      {q.isLoading || !d ? <Loading /> : <>
        {d.totals && (
          <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
            <Kpi label="წმინდა შემოსავალი" value={`${fmt(d.totals.revenue_net)} ₾`} />
            <Kpi label="ხარჯი (ჟურნალი)" value={`${fmt(d.totals.expenses)} ₾`} />
            <Kpi label={`მარაგი (${STOCK_BASIS_KA[d.stock_basis as keyof typeof STOCK_BASIS_KA]?.toLowerCase() ?? d.stock_basis})`} value={`${fmt(d.totals.stock_cost)} ₾`} />
            <Kpi label="შედეგი" value={`${fmt(d.totals.result)} ₾`} tone={d.totals.result < 0 ? 'danger' : 'ok'} />
          </div>)}
        <section className="card" style={{ overflowX: 'auto', flexShrink: 0 }}>
          <table className="table">
            <thead><tr>{head.map((h, i) => <th key={h} className={i ? 'num' : undefined}>{h}</th>)}</tr></thead>
            <tbody>
              {d.rows.map((r) => (
                <tr key={r.department_id}>
                  <td><strong>{r.department_name}</strong>{r.bed_days > 0 && <div className="small muted">{r.bed_days} საწოლდღე</div>}</td>
                  <td className="num mono">{fmt(r.revenue)}</td><td className="num mono">{r.writeoff ? fmt(-r.writeoff) : '—'}</td><td className="num mono">{fmt(r.revenue_net)}</td>
                  <td className="num mono">{r.expenses ? fmt(-r.expenses) : '—'}</td><td className="num mono">{r.stock_cost ? fmt(-r.stock_cost) : '—'}</td>
                  <td className="num mono">{r.overhead ? fmt(-r.overhead) : '—'}</td>
                  <td className="num mono"><strong style={{ color: r.result < 0 ? 'var(--danger-ink)' : 'var(--ok-ink)' }}>{fmt(r.result)}</strong></td>
                  <td className="num mono">{r.margin_pct === null ? '—' : `${r.margin_pct}%`}</td>
                </tr>))}
              {!d.rows.length && <tr><td colSpan={9} className="muted">მონაცემი არ არის</td></tr>}
              {d.unallocated ? <tr><td><strong>საერთო — გაუნაწილებელი</strong><div className="small muted">{d.allocation === 'none' ? 'განაწილება გამორთულია' : 'განაწილების გასაღები ცარიელია'}</div></td>
                <td colSpan={5} /><td className="num mono">{fmt(-d.unallocated)}</td><td className="num mono"><strong style={{ color: 'var(--danger-ink)' }}>{fmt(-d.unallocated)}</strong></td><td /></tr> : null}
              {d.totals && d.rows.length > 0 && <tr><td><strong>სულ</strong></td><td className="num mono"><strong>{fmt(d.totals.revenue)}</strong></td><td className="num mono">{fmt(-d.totals.writeoff)}</td>
                <td className="num mono"><strong>{fmt(d.totals.revenue_net)}</strong></td><td className="num mono">{fmt(-d.totals.expenses)}</td><td className="num mono">{fmt(-d.totals.stock_cost)}</td>
                <td className="num mono">{fmt(-d.totals.overhead)}</td><td className="num mono"><strong>{fmt(d.totals.result)}</strong></td><td /></tr>}
            </tbody>
          </table>
        </section>
        {d.pool && d.pool.total !== 0 && (
          <section className="card card-pad stack" style={{ gap: 6 }}>
            <strong>საერთო ხარჯი (განსანაწილებელი): {fmt(d.pool.total)} ₾ — {ALLOC_KA[d.allocation].toLowerCase()}</strong>
            <span className="small">ხარჯების ჟურნალი განყოფილების გარეშე / ადმინისტრაციული: <span className="mono">{fmt(d.pool.expenses)}</span> · მარაგი საერთო ლოკაციებზე / ადმინისტრაციაში: <span className="mono">{fmt(d.pool.stock)}</span></span>
            {d.pool.admin_departments.map((a) => <span key={a.department_id ?? '-'} className="small muted">{a.department_name}: ხარჯი {fmt(a.expenses)}, მარაგი {fmt(a.stock_cost)}</span>)}
          </section>)}
        <span className="hint">შემოსავალი — {DEPT_BASIS_KA[d.dept_basis].toLowerCase()}; ხარჯი — ჟურნალის ჩანაწერის განყოფილება (ხარჯის ცენტრი); მარაგი — {d.stock_basis === 'issue' ? 'გაცემით' : 'მოხმარებით'}. განაწილება მხოლოდ რეპორტშია — ჩანაწერები არ იცვლება.</span>
      </>}
    </div>
  );
}
