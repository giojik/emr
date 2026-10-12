import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import { ErrorBox, Loading } from '../../components/ui';
import { todayISO } from '../../lib/format';
import { downloadCsv } from '../stock/types';
import type { TabProps } from './Finance';
import { Bar, type Consumption, fmt, Kpi, STOCK_BASIS_KA, type StockValue } from './types';

const LOC_KIND_KA: Record<string, string> = { central: 'ცენტრალური', pharmacy: 'აფთიაქი', household: 'სამეურნეო', department: 'განყოფილება', operating: 'საოპერაციო', cssd: 'სტერილიზაცია', lab: 'ლაბორატორია', transit: 'გზაში' };

/** მარაგი: ღირებულება თარიღით (ლოკაცია / განყოფილება / კატეგორია) + ხარჯი განყოფილებებზე (dept_consumption_basis) */
export default function StockView({ from, to, summary }: TabProps) {
  const [basis, setBasis] = useState(summary.rules.dept_consumption_basis);
  const [asOf, setAsOf] = useState(todayISO());
  const val = useQuery({ queryKey: ['fin-stock-value', asOf], queryFn: () => api<StockValue>('/finance/stock/value', { query: { as_of: asOf } }) });
  const con = useQuery({ queryKey: ['fin-consumption', from, to, basis], queryFn: () => api<Consumption>('/finance/stock/consumption', { query: { from, to, basis } }) });
  const c = con.data; const v = val.data;
  const maxCost = c ? Math.max(0, ...c.by_department.map((r) => r.cost)) : 0;
  return (
    <div className="content">
      <section className="card" style={{ overflowX: 'auto', flexShrink: 0 }}>
        <div className="row card-pad" style={{ paddingBottom: 0, flexWrap: 'wrap' }}>
          <strong className="grow">ხარჯი განყოფილებებზე · {from} — {to}</strong>
          <div className="seg" role="group" aria-label="საფუძველი">
            {(Object.keys(STOCK_BASIS_KA) as (keyof typeof STOCK_BASIS_KA)[]).map((k) => <button key={k} type="button" aria-pressed={basis === k} onClick={() => setBasis(k)}>
              {STOCK_BASIS_KA[k]}{k === summary.rules.dept_consumption_basis ? ' ★' : ''}</button>)}
          </div>
          <button className="btn sm" type="button" disabled={!c?.by_department.length} onClick={() => downloadCsv(`stock-cost_${from}_${to}.csv`,
            ['განყოფილება', 'ხარჯი', 'მოხმარება', 'დანაკარგი', 'გაცემა (ნეტო)', 'პაციენტზე ჩაწერილი', 'დაუწერელი', 'ჩაწერილის ფასი', 'ქვესაწყობის ნაშთი'],
            c!.by_department.map((r) => [r.department_name, r.cost, r.consumption, r.loss, r.issued, r.billed_cost, r.unbilled_cost, r.billed_revenue, r.on_hand].map((x) => (typeof x === 'number' ? x.toFixed(2) : x))))}>CSV</button>
        </div>
        <ErrorBox error={con.error} />
        {con.isLoading || !c ? <Loading /> : <>
          <div className="row card-pad" style={{ flexWrap: 'wrap', gap: 10 }}>
            <Kpi label={`ხარჯი (${STOCK_BASIS_KA[c.basis].toLowerCase()})`} value={`${fmt(c.totals.cost)} ₾`} />
            <Kpi label="მ.შ. დანაკარგი (ჩამოწერა / ინვენტარიზაცია)" value={`${fmt(c.totals.loss)} ₾`} tone={c.totals.loss > 0 ? 'warn' : undefined} />
            <Kpi label="პაციენტზე ჩაწერილი (თვითღირებულება)" value={`${fmt(c.totals.billed_cost)} ₾`} hint={`ინვოისში: ${fmt(c.totals.billed_revenue)} ₾`} />
            <Kpi label="დაუწერელი მოხმარება" value={`${fmt(c.totals.unbilled_cost)} ₾`} />
            <Kpi label="ქვესაწყობების ნაშთი (პერიოდის ბოლოს)" value={`${fmt(c.totals.on_hand)} ₾`} hint="გაცემული, ჯერ დაუხარჯავი" />
          </div>
          <table className="table">
            <thead><tr><th>განყოფილება</th><th className="num">ხარჯი</th><th className="num">მოხმარება</th><th className="num">დანაკარგი</th><th className="num">გაცემა (ნეტო)</th>
              <th className="num">ჩაწერილი</th><th className="num">დაუწერელი</th><th className="num">ქვესაწყობი</th><th /></tr></thead>
            <tbody>
              {c.by_department.map((r) => (
                <tr key={r.department_id ?? '-'}>
                  <td><strong>{r.department_name}</strong>{r.department_type === 'administrative' && <span className="chip" style={{ marginLeft: 6 }}>ადმ.</span>}</td>
                  <td className="num mono"><strong>{fmt(r.cost)}</strong></td><td className="num mono">{fmt(r.consumption)}</td>
                  <td className="num mono" style={r.loss > 0 ? { color: 'var(--warn-ink)' } : undefined}>{fmt(r.loss)}</td><td className="num mono">{r.department_id ? fmt(r.issued) : '—'}</td>
                  <td className="num mono">{fmt(r.billed_cost)}</td><td className="num mono">{fmt(r.unbilled_cost)}</td><td className="num mono">{r.department_id ? fmt(r.on_hand) : '—'}</td>
                  <td style={{ width: 110 }}><Bar value={r.cost} max={maxCost} /></td>
                </tr>))}
              {!c.by_department.length && <tr><td colSpan={9} className="muted">პერიოდში მოძრაობა არ არის</td></tr>}
            </tbody>
          </table>
          <div className="row" style={{ flexWrap: 'wrap', gap: 10, alignItems: 'flex-start', padding: '0 16px 16px' }}>
            <MiniTable title="კატეგორიით" rows={c.by_category.map((r) => [r.category, r.cost])} />
            <MiniTable title="ტოპ საქონელი" rows={c.top_items.map((r) => [r.item_name, r.cost])} />
            <MiniTable title="თვე-თვეზე" rows={c.by_month.map((r) => [r.month, r.cost])} />
          </div>
        </>}
      </section>
      {c && (
        <span className="hint">
          {c.basis === 'consumption' ? 'ფაქტობრივი მოხმარება ქვესაწყობიდან (+ დანაკარგი), ლოკაციის განყოფილებით.' : 'გაცემა / გადაცემა განყოფილების ლოკაციაზე (ნეტო, დაბრუნების გამოკლებით); განყოფილების გარეშე ლოკაციის მოხმარება — საერთო.'}
          {' '}ღირებულება — {c.costing_method === 'fifo' ? 'ლოტის ფასით (FIFO)' : 'შეწონილი საშუალოთი'}. განყოფილების გარეშე ხარჯი — „საერთო“, ნაწილდება „განყოფილების შედეგში“.
        </span>)}
      <section className="card" style={{ overflowX: 'auto', flexShrink: 0 }}>
        <div className="row card-pad" style={{ paddingBottom: 0, flexWrap: 'wrap' }}>
          <strong className="grow">მარაგის ღირებულება{v ? `: ${fmt(v.total)} ₾` : ''}</strong>
          <label className="row small">თარიღით <input className="input mono" type="date" style={{ height: 34, width: 150 }} max={todayISO()} value={asOf} onChange={(e) => setAsOf(e.target.value || todayISO())} /></label>
        </div>
        <ErrorBox error={val.error} />
        {val.isLoading || !v ? <Loading /> : (
          <div className="row" style={{ flexWrap: 'wrap', gap: 10, alignItems: 'flex-start', padding: 16 }}>
            <section className="card grow" style={{ minWidth: 300 }}>
              <table className="table"><thead><tr><th>ლოკაცია</th><th>განყოფილება</th><th className="num">ღირებულება</th></tr></thead>
                <tbody>{v.by_location.map((r) => <tr key={r.location_id}><td>{r.location_name} <span className="small muted">{LOC_KIND_KA[r.kind] ?? r.kind}</span></td><td className="small">{r.department_name ?? '—'}</td><td className="num mono">{fmt(r.value)}</td></tr>)}
                  {!v.by_location.length && <tr><td colSpan={3} className="muted">მარაგი არ არის</td></tr>}</tbody></table>
            </section>
            <MiniTable title="განყოფილებით" rows={v.by_department.map((r) => [r.department_name, r.value])} />
            <MiniTable title="კატეგორიით" rows={v.by_category.map((r) => [r.category, r.value])} />
          </div>)}
      </section>
    </div>
  );
}

function MiniTable({ title, rows }: { title: string; rows: [string, number][] }) {
  return (
    <section className="card grow" style={{ minWidth: 240 }}>
      <div className="card-pad" style={{ paddingBottom: 0 }}><strong>{title}</strong></div>
      <table className="table"><tbody>{rows.map(([k, x]) => <tr key={k}><td>{k}</td><td className="num mono">{fmt(x)}</td></tr>)}
        {!rows.length && <tr><td className="muted">—</td></tr>}</tbody></table>
    </section>
  );
}
