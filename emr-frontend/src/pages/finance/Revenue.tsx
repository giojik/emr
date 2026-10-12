import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import { ErrorBox, Loading } from '../../components/ui';
import { downloadCsv } from '../stock/types';
import type { TabProps } from './Finance';
import { Bar, BASIS_KA, CAT_KA, DEPT_BASIS_KA, fmt, KIND_HINT, KIND_KA, KINDS, Kpi, type Kind, type Revenue } from './types';

const TONE: Record<Kind, string> = { patient: 'var(--accent)', insurance: 'var(--info-ink)', state: 'var(--ok-ink)', other: 'var(--ink-2)', writeoff: 'var(--warn-ink)', denied: 'var(--danger-ink)', undetermined: 'var(--muted)' };

/** შემოსავალი: გადამხდელით (პაციენტი / დაზღვევა / სახელმწიფო) და განყოფილებით (შემსრულებელი / დამნიშნავი) */
export default function RevenueView({ from, to, summary }: TabProps) {
  const [basis, setBasis] = useState(summary.rules.revenue_basis);
  const [dept, setDept] = useState(summary.rules.revenue_dept_basis);
  const q = useQuery({ queryKey: ['fin-revenue', from, to, basis, dept], queryFn: () => api<Revenue>('/finance/revenue', { query: { from, to, basis, dept_basis: dept } }) });
  const d = q.data;
  const used = d ? KINDS.filter((k) => d.by_department.some((r) => r[k]) || d.totals[k]) : [];
  const maxDept = d ? Math.max(0, ...d.by_department.map((r) => r.total)) : 0;
  const maxCat = d ? Math.max(0, ...d.by_category.map((r) => r.amount)) : 0;
  return (
    <div className="content">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <label className="row small">თარიღი
          <select className="select" style={{ height: 34 }} value={basis} onChange={(e) => setBasis(e.target.value as typeof basis)}>
            {Object.entries(BASIS_KA).map(([k, v]) => <option key={k} value={k}>{v}{k === summary.rules.revenue_basis ? ' (ნაგულისხმევი)' : ''}</option>)}</select></label>
        <label className="row small">განყოფილება
          <select className="select" style={{ height: 34 }} value={dept} onChange={(e) => setDept(e.target.value as typeof dept)}>
            {Object.entries(DEPT_BASIS_KA).map(([k, v]) => <option key={k} value={k}>{v}{k === summary.rules.revenue_dept_basis ? ' (ნაგულისხმევი)' : ''}</option>)}</select></label>
        <span className="grow" />
        <button className="btn sm" type="button" disabled={!d?.by_department.length} onClick={() => downloadCsv(`revenue_${from}_${to}.csv`,
          ['განყოფილება', ...used.map((k) => KIND_KA[k]), 'სულ', 'წმინდა'], d!.by_department.map((r) => [r.department_name, ...used.map((k) => r[k].toFixed(2)), r.total.toFixed(2), r.net.toFixed(2)]))}>CSV</button>
      </div>
      <ErrorBox error={q.error} />
      {q.isLoading || !d ? <Loading /> : <>
        <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
          <Kpi label="შემოსავალი (სულ)" value={`${fmt(d.totals.total)} ₾`} />
          <Kpi label="წმინდა (ჩამოწერის / უარის გარეშე)" value={`${fmt(d.totals.net)} ₾`} tone="ok" />
          <Kpi label="პაციენტი" value={`${fmt(d.totals.patient)} ₾`} />
          <Kpi label="დაზღვევა" value={`${fmt(d.totals.insurance + d.totals.other)} ₾`} />
          <Kpi label="სახელმწიფო" value={`${fmt(d.totals.state)} ₾`} />
          {d.totals.undetermined !== 0 && <Kpi label="განუსაზღვრელი" value={`${fmt(d.totals.undetermined)} ₾`} tone="warn" hint={KIND_HINT.undetermined} />}
        </div>
        {d.totals.total > 0 && (
          <section className="card card-pad stack" style={{ gap: 8 }}>
            <strong>წილი გადამხდელის მიხედვით</strong>
            <div style={{ display: 'flex', height: 14, borderRadius: 7, overflow: 'hidden', background: 'var(--line-soft)' }} aria-hidden="true">
              {d.by_kind.filter((x) => x.amount > 0).map((x) => <div key={x.kind} title={`${KIND_KA[x.kind]}: ${fmt(x.amount)} ₾`} style={{ width: `${(x.amount / d.totals.total) * 100}%`, background: TONE[x.kind] }} />)}
            </div>
            <div className="row small" style={{ flexWrap: 'wrap', gap: 14 }}>
              {d.by_kind.map((x) => <span key={x.kind} className="row" style={{ gap: 6 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: TONE[x.kind], display: 'inline-block' }} />
                {KIND_KA[x.kind]} <strong className="mono">{fmt(x.amount)}</strong> <span className="muted">({((x.amount / d.totals.total) * 100).toFixed(1)}%)</span></span>)}
            </div>
          </section>)}
        <section className="card" style={{ overflowX: 'auto', flexShrink: 0 }}>
          <div className="card-pad" style={{ paddingBottom: 0 }}><strong>განყოფილებით — {DEPT_BASIS_KA[d.dept_basis].toLowerCase()} ({BASIS_KA[d.basis].toLowerCase()})</strong></div>
          <table className="table">
            <thead><tr><th>განყოფილება</th>{used.map((k) => <th key={k} className="num" title={KIND_HINT[k]}>{KIND_KA[k]}</th>)}<th className="num">სულ</th><th className="num">წმინდა</th><th /></tr></thead>
            <tbody>
              {d.by_department.map((r) => (
                <tr key={r.department_id ?? '-'}><td><strong>{r.department_name}</strong></td>{used.map((k) => <td key={k} className="num mono">{r[k] ? fmt(r[k]) : '—'}</td>)}
                  <td className="num mono"><strong>{fmt(r.total)}</strong></td><td className="num mono">{fmt(r.net)}</td><td style={{ width: 120 }}><Bar value={r.total} max={maxDept} /></td></tr>))}
              {!d.by_department.length && <tr><td colSpan={used.length + 4} className="muted">პერიოდში შემოსავალი არ არის</td></tr>}
              {d.by_department.length > 1 && <tr><td><strong>სულ</strong></td>{used.map((k) => <td key={k} className="num mono"><strong>{fmt(d.totals[k])}</strong></td>)}
                <td className="num mono"><strong>{fmt(d.totals.total)}</strong></td><td className="num mono"><strong>{fmt(d.totals.net)}</strong></td><td /></tr>}
            </tbody>
          </table>
        </section>
        <div className="row" style={{ flexWrap: 'wrap', gap: 10, alignItems: 'flex-start' }}>
          <section className="card grow" style={{ overflowX: 'auto', minWidth: 320 }}>
            <div className="card-pad" style={{ paddingBottom: 0 }}><strong>გადამხდელები</strong></div>
            <table className="table">
              <thead><tr><th>გადამხდელი</th><th>ტიპი</th><th className="num">ინვოისი</th><th className="num">თანხა</th></tr></thead>
              <tbody>{d.by_payer.map((r) => <tr key={`${r.kind}-${r.payer_id ?? 'x'}`}><td>{r.payer_id ? r.payer_name : <span className="chip warn">{r.payer_name}</span>}</td><td className="small">{r.kind_ka}</td>
                <td className="num">{r.invoices}</td><td className="num mono">{fmt(r.amount)}</td></tr>)}
                {!d.by_payer.length && <tr><td colSpan={4} className="muted">გადამხდელის წილი არ არის</td></tr>}</tbody>
            </table>
          </section>
          <section className="card grow" style={{ overflowX: 'auto', minWidth: 320 }}>
            <div className="card-pad" style={{ paddingBottom: 0 }}><strong>კატეგორიით</strong></div>
            <table className="table">
              <tbody>{d.by_category.map((r) => <tr key={r.category}><td>{CAT_KA[r.category] ?? r.category}</td><td className="num mono">{fmt(r.amount)}</td><td style={{ width: 120 }}><Bar value={r.amount} max={maxCat} /></td></tr>)}</tbody>
            </table>
          </section>
        </div>
        {d.by_month.length > 1 && (
          <section className="card" style={{ overflowX: 'auto', flexShrink: 0 }}>
            <div className="card-pad" style={{ paddingBottom: 0 }}><strong>თვე-თვეზე</strong></div>
            <table className="table">
              <thead><tr><th>თვე</th>{used.map((k) => <th key={k} className="num">{KIND_KA[k]}</th>)}<th className="num">სულ</th></tr></thead>
              <tbody>{d.by_month.map((r) => <tr key={r.month}><td className="mono">{r.month}</td>{used.map((k) => <td key={k} className="num mono">{r[k] ? fmt(r[k]) : '—'}</td>)}<td className="num mono"><strong>{fmt(r.total)}</strong></td></tr>)}</tbody>
            </table>
          </section>)}
        <span className="hint">გადამხდელის წილი ხაზებზე ნაწილდება პროპორციულად (ინვოისის წილებიდან). საწოლდღე / ვენტილაციის დღე — თავის დღეზე და იმ დღის განყოფილებაზე. „განუსაზღვრელი“ — სტაციონარი ფინანსურ დახურვამდე.</span>
      </>}
    </div>
  );
}
