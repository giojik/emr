import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { ErrorBox, Loading } from '../../components/ui';
import { dateGe } from '../../lib/format';
import { downloadCsv } from '../stock/types';
import type { TabProps } from './Finance';
import { Bar, fmt, Kpi, type Payer } from './types';

interface G { key: string; title: string; cases: number; rejected: number; partial: number; claimed: number; denied: number; resolved_patient: number; resolved_writeoff: number }
interface Report {
  from: string; to: string;
  totals: { responded_cases: number; responded_claimed: number; denied_cases: number; denied: number; denial_rate: number; rejected: number; partial: number; unresolved: number };
  by_reason: G[]; by_category: G[]; by_department: G[]; by_payer: G[];
  items: { item_id: string; claim_id: string; claim_no: string | null; payer_name: string; kind: string; claimed: number; approved: number; denied: number; resp_status: string; resp_ka: string;
    reason: string; reason_title: string; dept: string | null; invoice_number: string; patient: string; resp_date: string; resolution: string | null }[];
}
const DIMS: [keyof Pick<Report, 'by_reason' | 'by_category' | 'by_department' | 'by_payer'>, string, string][] = [['by_reason', 'მიზეზით', 'მიზეზი'], ['by_category', 'კატეგორიით', 'კატეგორია'],
  ['by_department', 'განყოფილებით', 'განყოფილება'], ['by_payer', 'გადამხდელით', 'გადამხდელი']];

/** 0058: გადამხდელის უარები — მიზეზით / კატეგორიით / განყოფილებით / გადამხდელით (პასუხის თარიღით) */
export default function Denials({ from, to }: TabProps) {
  const [payer, setPayer] = useState('');
  const [dim, setDim] = useState<(typeof DIMS)[number][0]>('by_reason');
  const payers = useQuery({ queryKey: ['payers', false], queryFn: () => api<Payer[]>('/billing/payers') });
  const q = useQuery({ queryKey: ['fin-denials', from, to, payer], queryFn: () => api<Report>('/finance/reports/denials', { query: { from, to, payer_id: payer || undefined } }) });
  const d = q.data; const rows = d?.[dim] ?? [];
  const max = Math.max(0, ...rows.map((r) => r.denied));
  return (
    <div className="content">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <select className="select" aria-label="გადამხდელი" style={{ height: 34, maxWidth: 320 }} value={payer} onChange={(e) => setPayer(e.target.value)}>
          <option value="">ყველა გადამხდელი</option>{payers.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <div className="seg" role="group" aria-label="ჭრილი">{DIMS.map(([k, l]) => <button key={k} type="button" aria-pressed={dim === k} onClick={() => setDim(k)}>{l}</button>)}</div>
        <span className="hint grow">პერიოდი — გადამხდელის პასუხის ჩაწერის თარიღით. უარი = მოთხოვნილი − დამტკიცებული (უარყოფილი და ნაწილობრივ).</span>
        <button className="btn sm" type="button" disabled={!d?.items.length} onClick={() => downloadCsv(`denials_${from}_${to}.csv`,
          ['პასუხის თარიღი', 'ქლეიმი', 'გადამხდელი', 'პაციენტი', 'ინვოისი', 'განყოფილება', 'პასუხი', 'მიზეზი', 'მოთხოვნილი', 'დამტკიცებული', 'უარი', 'გადაწყვეტა'],
          d!.items.map((x) => [x.resp_date, x.claim_no ?? '', x.payer_name, x.patient, x.invoice_number, x.dept ?? '', x.resp_ka, `${x.reason} — ${x.reason_title}`, x.claimed.toFixed(2), x.approved.toFixed(2), x.denied.toFixed(2), x.resolution ?? '']))}>CSV</button>
      </div>
      <ErrorBox error={q.error} />
      {q.isLoading || !d ? <Loading /> : <>
        <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
          <Kpi label="პასუხი მიღებულია (შემთხვევა)" value={String(d.totals.responded_cases)} hint={`${fmt(d.totals.responded_claimed)} ₾ მოთხოვნილი`} />
          <Kpi label="უარი (თანხა)" value={`${fmt(d.totals.denied)} ₾`} tone={d.totals.denied ? 'danger' : undefined} hint={`${d.totals.rejected} უარყოფილი · ${d.totals.partial} ნაწილობრივ`} />
          <Kpi label="უარის წილი" value={`${d.totals.denial_rate}%`} tone={d.totals.denial_rate > 5 ? 'warn' : undefined} />
          <Kpi label="გადაუწყვეტელი უარი" value={`${fmt(d.totals.unresolved)} ₾`} tone={d.totals.unresolved ? 'warn' : undefined} />
        </div>
        <section className="card" style={{ overflowX: 'auto', flexShrink: 0 }}>
          <table className="table">
            <thead><tr><th>{DIMS.find((x) => x[0] === dim)![2]}</th><th className="num">შემთხვ.</th><th className="num">უარყოფ.</th><th className="num">ნაწილ.</th><th className="num">მოთხოვნილი</th>
              <th className="num">უარი</th><th style={{ width: 180 }} /><th className="num">პაციენტზე</th><th className="num">ჩამოწერა</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.key}><td><strong>{r.title}</strong>{dim === 'by_reason' && <span className="small muted mono"> {r.key}</span>}</td><td className="num">{r.cases}</td><td className="num">{r.rejected || '—'}</td>
                <td className="num">{r.partial || '—'}</td><td className="num mono">{fmt(r.claimed)}</td><td className="num mono"><strong>{fmt(r.denied)}</strong></td><td><Bar value={r.denied} max={max} tone="var(--danger-ink)" /></td>
                <td className="num mono">{r.resolved_patient ? fmt(r.resolved_patient) : '—'}</td><td className="num mono">{r.resolved_writeoff ? fmt(r.resolved_writeoff) : '—'}</td></tr>))}
              {!rows.length && <tr><td colSpan={9} className="muted">პერიოდში უარი არ არის</td></tr>}</tbody>
          </table>
        </section>
        {d.items.length > 0 && (
          <section className="card" style={{ overflowX: 'auto', flexShrink: 0 }}>
            <div className="card-head"><strong>შემთხვევები ({d.items.length})</strong></div>
            <table className="table">
              <thead><tr><th>თარიღი</th><th>ქლეიმი</th><th>პაციენტი</th><th>განყოფილება</th><th>პასუხი</th><th>მიზეზი</th><th className="num">უარი</th><th>გადაწყვეტა</th></tr></thead>
              <tbody>{d.items.map((x) => (
                <tr key={x.item_id}><td className="mono small">{dateGe(x.resp_date)}</td><td className="small"><Link to={`/finance/claims?id=${x.claim_id}`}>{x.claim_no}</Link><div className="muted">{x.payer_name}</div></td>
                  <td>{x.patient}<div className="small muted mono">{x.invoice_number}</div></td><td className="small">{x.dept ?? '—'}</td>
                  <td><span className={`chip ${x.resp_status === 'rejected' ? 'danger' : 'warn'}`}>{x.resp_ka}</span></td><td className="small"><span className="mono">{x.reason}</span> {x.reason_title}</td>
                  <td className="num mono">{fmt(x.denied)}</td><td className="small">{x.resolution === 'patient' ? 'პაციენტზე' : x.resolution === 'writeoff' ? 'ჩამოწერა' : <span className="muted">—</span>}</td></tr>))}</tbody>
            </table>
          </section>)}
      </>}
    </div>
  );
}
