import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import { ErrorBox, Loading } from '../../components/ui';
import { dateGe, todayISO } from '../../lib/format';
import { downloadCsv } from '../stock/types';
import { CUR_SIGN, fmt, PAY_METHOD_KA, type AgingRow, type ApPaymentRow, type ApSummary } from './types';

const monthStart = () => todayISO().slice(0, 8) + '01';

/** გადახდები და ხანდაზმულობა: მომწოდებლების დავალიანება ვადის მიხედვით + გადახდების რეესტრი */
export default function Payables() {
  const nav = useNavigate();
  const [asOf, setAsOf] = useState(todayISO());
  const [from, setFrom] = useState(monthStart()); const [to, setTo] = useState(todayISO()); const [showVoid, setShowVoid] = useState(false);
  const sum = useQuery({ queryKey: ['ap-summary'], queryFn: () => api<ApSummary>('/payables/summary') });
  const ag = useQuery({ queryKey: ['ap-aging', asOf], queryFn: () => api<{ as_of: string; rows: AgingRow[]; totals: Omit<AgingRow, 'supplier_id' | 'supplier_name' | 'invoices'> }>('/payables/aging', { query: { as_of: asOf } }) });
  const pays = useQuery({ queryKey: ['ap-payments', from, to, showVoid], queryFn: () => api<ApPaymentRow[]>('/payables/payments', { query: { from, to, include_void: showVoid } }) });
  const live = (pays.data ?? []).filter((p) => !p.is_void);
  const paid = live.filter((p) => p.kind === 'payment').reduce((a, p) => a + Number(p.amount_gel), 0);
  const credit = live.filter((p) => p.kind === 'credit_note').reduce((a, p) => a + Number(p.amount_gel), 0);
  const cols: [keyof AgingRow, string][] = [['not_due', 'ვადამდე'], ['d1_30', '1–30 დღე'], ['d31_60', '31–60'], ['d61_90', '61–90'], ['d90', '90+']];
  return (
    <div className="content">
      {sum.data && (
        <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
          <Kpi label="გადასახდელი (სულ, ₾)" value={`${fmt(sum.data.open_gel)} ₾`} />
          <Kpi label="ვადაგადაცილებული ინვოისი" value={String(sum.data.overdue)} tone={sum.data.overdue ? 'danger' : undefined} />
          <Kpi label="ვადა იწურება" value={String(sum.data.due_soon)} tone={sum.data.due_soon ? 'warn' : undefined} />
          <Kpi label="სხვაობით (გადახდა დაბლოკილია)" value={String(sum.data.mismatch)} tone={sum.data.mismatch ? 'danger' : undefined} />
          <Kpi label="მონახაზი" value={String(sum.data.drafts)} />
        </div>)}
      <section className="card" style={{ overflowX: 'auto' }}>
        <div className="row card-pad" style={{ paddingBottom: 0, flexWrap: 'wrap' }}>
          <strong className="grow">ხანდაზმულობა — მომწოდებლების დავალიანება (₾)</strong>
          <label className="row small">თარიღით <input className="input mono" type="date" style={{ height: 34, width: 150 }} max={todayISO()} value={asOf} onChange={(e) => setAsOf(e.target.value || todayISO())} /></label>
          <button className="btn sm" type="button" disabled={!ag.data?.rows.length} onClick={() => downloadCsv(`aging_${asOf}.csv`, ['მომწოდებელი', 'ინვოისი', ...cols.map((c) => c[1]), 'სულ'],
            ag.data!.rows.map((r) => [r.supplier_name, r.invoices, ...cols.map((c) => r[c[0]] as number), r.total]))}>CSV</button>
        </div>
        {ag.isLoading ? <Loading /> : (
          <table className="table">
            <thead><tr><th>მომწოდებელი</th><th className="num">ინვოისი</th>{cols.map(([k, l]) => <th key={k} className="num">{l}</th>)}<th className="num">სულ</th></tr></thead>
            <tbody>{ag.data?.rows.map((r) => (
              <tr key={r.supplier_id} className="clickable" onClick={() => nav(`/procurement/invoices`)}>
                <td><strong>{r.supplier_name}</strong></td><td className="num">{r.invoices}</td>
                {cols.map(([k]) => <td key={k} className="num mono" style={k !== 'not_due' && (r[k] as number) > 0 ? { color: 'var(--danger-ink)' } : undefined}>{(r[k] as number) ? fmt(r[k] as number) : '—'}</td>)}
                <td className="num mono"><strong>{fmt(r.total)}</strong></td>
              </tr>))}
              {!ag.data?.rows.length && <tr><td colSpan={8} className="muted">დავალიანება არ არის</td></tr>}
              {!!ag.data?.rows.length && <tr><td><strong>სულ</strong></td><td />{cols.map(([k]) => <td key={k} className="num mono"><strong>{fmt(ag.data!.totals[k as keyof typeof ag.data.totals])}</strong></td>)}<td className="num mono"><strong>{fmt(ag.data.totals.total)}</strong></td></tr>}
            </tbody>
          </table>)}
      </section>
      <section className="card" style={{ overflowX: 'auto' }}>
        <div className="row card-pad" style={{ paddingBottom: 0, flexWrap: 'wrap' }}>
          <strong className="grow">გადახდების რეესტრი</strong>
          <input className="input mono" type="date" style={{ height: 34, width: 150 }} aria-label="დან" value={from} onChange={(e) => setFrom(e.target.value)} />
          <input className="input mono" type="date" style={{ height: 34, width: 150 }} aria-label="მდე" value={to} onChange={(e) => setTo(e.target.value)} />
          <label className="row small"><input type="checkbox" checked={showVoid} onChange={(e) => setShowVoid(e.target.checked)} /> გაუქმებულებიც</label>
          <button className="btn sm" type="button" disabled={!live.length} onClick={() => downloadCsv(`ap-payments_${from}_${to}.csv`, ['თარიღი', 'ტიპი', 'მომწოდებელი', 'IBAN', 'AP-№', 'ფაქტურა', 'თანხა', 'ვალუტა', 'თანხა ₾', 'მეთოდი', 'საბუთი'],
            live.map((p) => [p.pay_date, p.kind === 'payment' ? 'გადახდა' : 'კრედიტ-ნოტა', p.supplier_name, p.supplier_iban, p.ap_no, p.invoice_no, p.amount, p.currency, p.amount_gel, p.method ? PAY_METHOD_KA[p.method] : '', p.reference]))}>CSV</button>
        </div>
        <ErrorBox error={pays.error} />
        {pays.isLoading ? <Loading /> : (
          <table className="table">
            <thead><tr><th>თარიღი</th><th>ტიპი</th><th>მომწოდებელი</th><th>ინვოისი</th><th className="num">თანხა</th><th>მეთოდი</th><th>საბუთი</th><th>შეიყვანა</th></tr></thead>
            <tbody>{pays.data?.map((p) => (
              <tr key={p.id} className="clickable" onClick={() => nav(`/procurement/invoices?id=${p.invoice_id}`)} style={p.is_void ? { opacity: 0.5, textDecoration: 'line-through' } : undefined}>
                <td className="mono">{dateGe(p.pay_date)}</td><td>{p.kind === 'payment' ? 'გადახდა' : 'კრედიტ-ნოტა'}</td><td>{p.supplier_name}</td>
                <td className="mono small">{p.ap_no} · {p.invoice_no}</td>
                <td className="num mono">{fmt(p.amount)} {CUR_SIGN[p.currency]}{p.currency !== 'GEL' && <div className="small muted">{fmt(p.amount_gel)} ₾</div>}</td>
                <td>{p.method ? PAY_METHOD_KA[p.method] : '—'}</td><td className="mono small">{p.reference ?? '—'}</td><td className="small">{p.created_by_name}</td>
              </tr>))}
              {!pays.data?.length && <tr><td colSpan={8} className="muted">გადახდა არ არის</td></tr>}
            </tbody>
          </table>)}
        <div className="row" style={{ justifyContent: 'flex-end', gap: 18, padding: '10px 16px' }}>
          <span>გადახდილი: <strong className="mono">{fmt(paid)} ₾</strong></span><span>კრედიტ-ნოტები: <strong className="mono">{fmt(credit)} ₾</strong></span>
        </div>
      </section>
    </div>
  );
}

function Kpi({ label, value, tone }: { label: string; value: string; tone?: 'danger' | 'warn' }) {
  return (
    <div className="card card-pad" style={{ minWidth: 170, flex: '1 1 170px' }}>
      <div className="small muted">{label}</div>
      <div className="mono" style={{ fontSize: 20, fontWeight: 600, color: tone === 'danger' ? 'var(--danger-ink)' : tone === 'warn' ? 'var(--warn-ink)' : undefined }}>{value}</div>
    </div>
  );
}
