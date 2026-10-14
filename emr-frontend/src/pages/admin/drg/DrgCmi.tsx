import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../../api/client';
import { ErrorBox, Loading } from '../../../components/ui';
import { dateGe, todayISO } from '../../../lib/format';
import { Bar, Kpi, monthStart } from '../../finance/types';
import { downloadCsv } from '../../stock/types';
import type { Scheme } from './types';

interface Agg { key: string; title: string; cases: number; weight: number; cmi: number; avg_los: number; alos: number | null; los_index: number | null; high: number; low: number;
  surgical: number; surgical_pct: number; amount: number }
interface Cmi {
  from: string; to: string; by: string; totals: Agg; rows: Agg[]; unmapped: number;
  groups: (Agg & { kind: string | null; mdc: string | null; share_pct: number; weight_share_pct: number })[];
  outliers: { encounter_id: string; adm_no: string; patient: string; drg_code: string; title: string | null; los: number; los_low: number | null; los_high: number | null; alos: number | null; kind: 'high' | 'low'; dept: string | null; finalized: string }[];
}
const BY: [string, string, string][] = [['department', 'განყოფილება', 'განყოფილებების მიხედვით'], ['doctor', 'ექიმი', 'მკურნალი ექიმების მიხედვით'], ['month', 'თვე', 'თვეების მიხედვით'],
  ['payer', 'გადამხდელი', 'გადამხდელების მიხედვით']];
const KIND_KA: Record<string, string> = { medical: 'თერაპ.', surgical: 'ქირურგ.', other: 'სხვა' };
const f2 = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * DRG ანგარიში (0058): CMI — შემთხვევის საშუალო წონა; ჯგუფების განაწილება; ხანგრძლივობა ALOS-თან (ინდექსი); outlier-ები.
 * შემთხვევა — ფინანსურად დახურული სტაციონარი პერიოდში, DRG გადამხდელით.
 */
export default function DrgCmi({ schemes }: { schemes: Scheme[] }) {
  const [from, setFrom] = useState(monthStart(todayISO())); const [to, setTo] = useState(todayISO());
  const [by, setBy] = useState('department'); const [scheme, setScheme] = useState('');
  const q = useQuery({ queryKey: ['drg-cmi', from, to, by, scheme], queryFn: () => api<Cmi>('/drg/reports/cmi', { query: { from, to, by, scheme_id: scheme || undefined } }) });
  const d = q.data; const maxW = d ? Math.max(0, ...d.rows.map((r) => r.cmi)) : 0;
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <select className="select" aria-label="სქემა" style={{ maxWidth: 320 }} value={scheme} onChange={(e) => setScheme(e.target.value)}>
          <option value="">ყველა სქემა</option>{schemes.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        <input className="input mono" type="date" aria-label="დან" style={{ width: 150 }} value={from} max={to} onChange={(e) => setFrom(e.target.value || from)} />
        <input className="input mono" type="date" aria-label="მდე" style={{ width: 150 }} value={to} min={from} onChange={(e) => setTo(e.target.value || to)} />
        <div className="seg" role="group" aria-label="ჭრილი">{BY.map(([k, l]) => <button key={k} type="button" aria-pressed={by === k} onClick={() => setBy(k)}>{l}</button>)}</div>
        <span className="grow" />
        <button className="btn sm" type="button" disabled={!d?.groups.length} onClick={() => downloadCsv(`drg_cmi_${from}_${to}.csv`,
          ['DRG', 'დასახელება', 'ტიპი', 'MDC', 'შემთხვევა', 'წილი %', 'წონა (ჯამი)', 'წონის წილი %', 'საშ. ხანგრძლ.', 'ALOS', 'ინდექსი', '> ზედა', '< ქვედა', 'თანხა'],
          d!.groups.map((g) => [g.key, g.title, g.kind ? KIND_KA[g.kind] : '', g.mdc ?? '', g.cases, g.share_pct, g.weight, g.weight_share_pct, g.avg_los, g.alos ?? '', g.los_index ?? '', g.high, g.low, g.amount.toFixed(2)]))}>CSV (ჯგუფები)</button>
      </div>
      <span className="hint">CMI (Case Mix Index) = შემთხვევების DRG წონების საშუალო. ხანგრძლივობის ინდექსი = ფაქტობრივი დღეები / ჯგუფის ALOS (1-ზე მეტი — საშუალოზე ხანგრძლივი).
        შემთხვევა — ფინანსურად დახურული (ფინალიზაციის დღით), DRG გადამხდელით.</span>
      <ErrorBox error={q.error} />
      {q.isLoading || !d ? <Loading /> : <>
        <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
          <Kpi label="CMI" value={d.totals.cmi.toFixed(4)} tone="ok" />
          <Kpi label="შემთხვევა" value={String(d.totals.cases)} hint={`ქირურგიული ${d.totals.surgical_pct}%`} />
          <Kpi label="წონა (ჯამი)" value={d.totals.weight.toFixed(2)} />
          <Kpi label="საშ. ხანგრძლივობა" value={`${d.totals.avg_los} დღე`} hint={d.totals.alos !== null ? `ALOS ${d.totals.alos} · ინდექსი ${d.totals.los_index}` : undefined} />
          <Kpi label="outlier (ზედა / ქვედა)" value={`${d.totals.high} / ${d.totals.low}`} tone={d.totals.high ? 'warn' : undefined} />
          <Kpi label="DRG თანხა" value={`${f2(d.totals.amount)} ₾`} />
        </div>
        {d.unmapped > 0 && <span className="small muted">{d.unmapped} შემთხვევის ჯგუფი ვერსიაში ვერ მოიძებნა (ძველი / ხელით მითითებული კოდი) — ALOS / ზღვრები მათთვის არ ითვლება.</span>}
        <section className="card" style={{ overflowX: 'auto' }}>
          <div className="card-head"><strong>{BY.find((x) => x[0] === by)![2]}</strong></div>
          <table className="table">
            <thead><tr><th>{BY.find((x) => x[0] === by)![1]}</th><th className="num">შემთხვ.</th><th className="num">CMI</th><th style={{ width: 160 }} /><th className="num">წონა</th><th className="num">საშ. დღე</th>
              <th className="num">ALOS</th><th className="num">ინდექსი</th><th className="num">ქირურგ. %</th><th className="num">outlier</th><th className="num">თანხა</th></tr></thead>
            <tbody>{d.rows.map((r) => (
              <tr key={r.key}><td><strong>{r.title}</strong></td><td className="num">{r.cases}</td><td className="num mono"><strong>{r.cmi.toFixed(4)}</strong></td><td><Bar value={r.cmi} max={maxW} /></td>
                <td className="num mono">{r.weight.toFixed(2)}</td><td className="num">{r.avg_los}</td><td className="num">{r.alos ?? '—'}</td>
                <td className="num mono" style={r.los_index !== null && r.los_index > 1.2 ? { color: 'var(--danger-ink)' } : undefined}>{r.los_index ?? '—'}</td>
                <td className="num">{r.surgical_pct}</td><td className="num">{r.high + r.low || '—'}</td><td className="num mono">{f2(r.amount)}</td></tr>))}
              {!d.rows.length && <tr><td colSpan={11} className="muted">პერიოდში DRG შემთხვევა არ არის</td></tr>}</tbody>
          </table>
        </section>
        {d.groups.length > 0 && (
          <section className="card" style={{ overflowX: 'auto' }}>
            <div className="card-head"><strong>ჯგუფების განაწილება</strong></div>
            <table className="table">
              <thead><tr><th>DRG</th><th>ტიპი</th><th className="num">შემთხვ.</th><th className="num">წილი</th><th className="num">წონის წილი</th><th className="num">საშ. დღე</th><th className="num">ALOS</th><th className="num">ინდექსი</th><th className="num">&gt; / &lt;</th><th className="num">თანხა</th></tr></thead>
              <tbody>{d.groups.map((g) => (
                <tr key={g.key}><td><span className="mono"><strong>{g.key}</strong></span> {g.title}{g.mdc && <span className="small muted"> · MDC {g.mdc}</span>}</td><td className="small">{g.kind ? KIND_KA[g.kind] : '—'}</td>
                  <td className="num">{g.cases}</td><td className="num">{g.share_pct}%</td><td className="num">{g.weight_share_pct}%</td><td className="num">{g.avg_los}</td><td className="num">{g.alos ?? '—'}</td>
                  <td className="num mono">{g.los_index ?? '—'}</td><td className="num">{g.high || g.low ? `${g.high} / ${g.low}` : '—'}</td><td className="num mono">{f2(g.amount)}</td></tr>))}</tbody>
            </table>
          </section>)}
        {d.outliers.length > 0 && (
          <section className="card" style={{ overflowX: 'auto' }}>
            <div className="card-head"><strong>ხანგრძლივობა ზღვრებს გარეთ ({d.outliers.length})</strong></div>
            <table className="table">
              <thead><tr><th>ფინალიზაცია</th><th>ისტორია</th><th>პაციენტი</th><th>DRG</th><th className="num">დღე</th><th>ზღვრები</th><th>განყოფილება</th></tr></thead>
              <tbody>{d.outliers.map((o) => (
                <tr key={o.encounter_id}><td className="mono small">{dateGe(o.finalized)}</td><td className="mono"><Link to={`/inpatient/stay/${o.encounter_id}`}>{o.adm_no}</Link></td><td>{o.patient}</td>
                  <td><span className="mono">{o.drg_code}</span> <span className="small muted">{o.title}</span></td>
                  <td className="num"><span className={`chip ${o.kind === 'high' ? 'danger' : 'warn'}`}>{o.los}</span></td><td className="small mono">{o.los_low ?? '—'} – {o.los_high ?? '—'} (ALOS {o.alos ?? '—'})</td><td className="small">{o.dept ?? '—'}</td></tr>))}</tbody>
            </table>
          </section>)}
      </>}
    </div>
  );
}
