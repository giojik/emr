import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../../api/client';
import { ErrorBox, Field, Loading } from '../../../components/ui';
import { dateGe, todayISO } from '../../../lib/format';
import { Kpi, monthStart, type Payer } from '../../finance/types';
import { downloadCsv } from '../../stock/types';
import { type Scheme, STATUS_KA, type VersionRow } from './types';

interface Side { code: string | null; title: string | null; weight: number | null; amount: number | null; fallback?: boolean; issue?: string | null }
interface Sim {
  version: { id: string; label: string; version_no: number; status: string }; base: { kind: 'actual' } | { kind: 'version'; label: string; version_no: number; status: string };
  totals: { cases: number; grouped: number; ungrouped: number; fallback: number; changed_group: number; changed_amount: number; cmi_base: number; cmi_sim: number; cmi_diff: number;
    amount_base: number; amount_sim: number; diff: number; diff_pct: number | null };
  transitions: { from: string | null; from_title: string | null; to: string | null; to_title: string | null; cases: number; amount_base: number; amount_sim: number }[];
  by_department: { dept: string; cases: number; changed: number; cmi_base: number; cmi_sim: number; amount_base: number; amount_sim: number; diff: number }[];
  rows: { encounter_id: string; adm_no: string; patient: string; dept: string | null; payer_name: string; finalized: string; los: number; base: Side; sim: Side; changed: boolean; diff: number | null }[];
}
const f2 = (n: number | null | undefined) => (n === null || n === undefined ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const sign = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${n > 0 ? '+' : ''}${f2(n)}`);
const tone = (n: number | null | undefined) => (n ? { color: n > 0 ? 'var(--ok-ink)' : 'var(--danger-ink)' } : undefined);

/**
 * DRG სიმულაცია (0059): ვერსიის (მათ შორის მონახაზის) გავლენა პერიოდის შემთხვევებზე — ჯგუფი, წონა, თანხა, CMI;
 * საწყისი — ფაქტობრივი (დაფიქსირებული) ან სხვა ვერსია. მხოლოდ გამოთვლა — ბაზაში არაფერი იწერება.
 */
export default function DrgSimulate({ schemes, sid }: { schemes: Scheme[]; sid: string }) {
  const [f, setF] = useState({ scheme: sid, version: '', base: '', from: monthStart(todayISO()), to: todayISO(), payer: '', rate: '', only: false });
  const versions = useQuery({ queryKey: ['drg-versions', f.scheme], enabled: !!f.scheme, queryFn: () => api<VersionRow[]>(`/drg/schemes/${f.scheme}/versions`) });
  const payers = useQuery({ queryKey: ['payers', false], queryFn: () => api<Payer[]>('/billing/payers') });
  const m = useMutation({ mutationFn: () => api<Sim>('/drg/simulate', { body: { scheme_id: f.scheme, version_id: f.version, base_version_id: f.base || undefined, from: f.from, to: f.to,
    payer_id: f.payer || undefined, base_rate: f.rate ? Number(f.rate) : undefined, only_changed: f.only } }) });
  const d = m.data;
  const vopt = (versions.data ?? []).map((v) => <option key={v.id} value={v.id}>v{v.version_no} · {v.label} · {STATUS_KA[v.status]}{v.current ? ' (მიმდინარე)' : ''}</option>);
  return (
    <div className="stack" style={{ gap: 12 }}>
      <section className="card card-pad stack" style={{ gap: 10 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10, alignItems: 'end' }}>
          <Field label="სქემა" htmlFor="sm-s"><select id="sm-s" className="select" value={f.scheme} onChange={(e) => setF({ ...f, scheme: e.target.value, version: '', base: '' })}>
            {schemes.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
          <Field label="ახალი ვერსია (სიმულაცია)" htmlFor="sm-v" required><select id="sm-v" className="select" value={f.version} onChange={(e) => setF({ ...f, version: e.target.value })}>
            <option value="">— აირჩიეთ —</option>{vopt}</select></Field>
          <Field label="შედარება" htmlFor="sm-b"><select id="sm-b" className="select" value={f.base} onChange={(e) => setF({ ...f, base: e.target.value })}>
            <option value="">ფაქტობრივი (დაფიქსირებული)</option>{vopt}</select></Field>
          <Field label="გადამხდელი" htmlFor="sm-p"><select id="sm-p" className="select" value={f.payer} onChange={(e) => setF({ ...f, payer: e.target.value })}>
            <option value="">ყველა DRG გადამხდელი</option>{payers.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
        </div>
        <div className="row" style={{ flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
          <Field label="დან" htmlFor="sm-f"><input id="sm-f" className="input mono" type="date" value={f.from} max={f.to} onChange={(e) => setF({ ...f, from: e.target.value || f.from })} /></Field>
          <Field label="მდე" htmlFor="sm-t"><input id="sm-t" className="input mono" type="date" value={f.to} min={f.from} onChange={(e) => setF({ ...f, to: e.target.value || f.to })} /></Field>
          <Field label="საბაზისო განაკვეთი" htmlFor="sm-r" hint="ცარიელი — გადამხდელის"><input id="sm-r" className="input mono" style={{ width: 140 }} inputMode="decimal" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} /></Field>
          <label className="row small" style={{ height: 38 }}><input type="checkbox" checked={f.only} onChange={(e) => setF({ ...f, only: e.target.checked })} /> მხოლოდ შეცვლილი</label>
          <span className="grow" />
          <button className="btn primary" type="button" disabled={!f.version || m.isPending} onClick={() => m.mutate()}>{m.isPending ? 'ითვლება…' : 'სიმულაცია'}</button>
        </div>
        <span className="hint">შემთხვევა — ფინანსურად დახურული სტაციონარი პერიოდში, ამ სქემის DRG გადამხდელით. ახალი ვერსია ითვლება შემთხვევის ახლანდელი მონაცემებით (დიაგნოზი, ოპერაცია, დღეები);
          ბაზაში არაფერი იწერება. მონახაზის შემოწმება გააქტიურებამდე — ზუსტად ამისთვისაა.</span>
      </section>
      <ErrorBox error={m.error} />
      {m.isPending && <Loading />}
      {d && <>
        <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
          <Kpi label="შემთხვევა" value={String(d.totals.cases)} hint={`დაჯგუფდა ${d.totals.grouped}${d.totals.ungrouped ? ` · ვერ: ${d.totals.ungrouped}` : ''}${d.totals.fallback ? ` · ნაგულისხმევი: ${d.totals.fallback}` : ''}`} />
          <Kpi label="ჯგუფი შეიცვალა" value={String(d.totals.changed_group)} tone={d.totals.changed_group ? 'warn' : undefined} hint={`თანხა შეიცვალა: ${d.totals.changed_amount}`} />
          <Kpi label="CMI" value={`${d.totals.cmi_base.toFixed(4)} → ${d.totals.cmi_sim.toFixed(4)}`} hint={sign(d.totals.cmi_diff)} />
          <Kpi label="თანხა" value={`${f2(d.totals.amount_sim)} ₾`} hint={`იყო ${f2(d.totals.amount_base)}`} />
          <Kpi label="სხვაობა" value={`${sign(d.totals.diff)} ₾`} tone={d.totals.diff < 0 ? 'danger' : d.totals.diff > 0 ? 'ok' : undefined} hint={d.totals.diff_pct !== null ? `${d.totals.diff_pct > 0 ? '+' : ''}${d.totals.diff_pct}%` : undefined} />
        </div>
        <span className="small muted">საწყისი: {d.base.kind === 'actual' ? 'ფაქტობრივი (ფინალიზაციისას დაფიქსირებული)' : `v${d.base.version_no} · ${d.base.label}`} → ახალი: v{d.version.version_no} · {d.version.label} ({STATUS_KA[d.version.status]})</span>
        {d.transitions.length > 0 && (
          <section className="card" style={{ overflowX: 'auto' }}>
            <div className="card-head"><strong>ჯგუფის ცვლილებები</strong></div>
            <table className="table"><thead><tr><th>იყო</th><th>ახალი</th><th className="num">შემთხვ.</th><th className="num">თანხა (იყო)</th><th className="num">თანხა (ახალი)</th><th className="num">სხვაობა</th></tr></thead>
              <tbody>{d.transitions.map((t, i) => (
                <tr key={i}><td><span className="mono">{t.from ?? '—'}</span> <span className="small muted">{t.from_title}</span></td><td><span className="mono"><strong>{t.to ?? 'ვერ დაჯგუფდა'}</strong></span> <span className="small muted">{t.to_title}</span></td>
                  <td className="num">{t.cases}</td><td className="num mono">{f2(t.amount_base)}</td><td className="num mono">{f2(t.amount_sim)}</td><td className="num mono" style={tone(t.amount_sim - t.amount_base)}>{sign(t.amount_sim - t.amount_base)}</td></tr>))}</tbody></table>
          </section>)}
        <section className="card" style={{ overflowX: 'auto' }}>
          <div className="card-head"><strong>განყოფილებებით</strong></div>
          <table className="table"><thead><tr><th>განყოფილება</th><th className="num">შემთხვ.</th><th className="num">შეიცვალა</th><th className="num">CMI იყო</th><th className="num">CMI ახალი</th><th className="num">თანხა იყო</th><th className="num">ახალი</th><th className="num">სხვაობა</th></tr></thead>
            <tbody>{d.by_department.map((x) => (
              <tr key={x.dept}><td><strong>{x.dept}</strong></td><td className="num">{x.cases}</td><td className="num">{x.changed || '—'}</td><td className="num mono">{x.cmi_base.toFixed(4)}</td><td className="num mono">{x.cmi_sim.toFixed(4)}</td>
                <td className="num mono">{f2(x.amount_base)}</td><td className="num mono">{f2(x.amount_sim)}</td><td className="num mono" style={tone(x.diff)}><strong>{sign(x.diff)}</strong></td></tr>))}</tbody></table>
        </section>
        <section className="card" style={{ overflowX: 'auto' }}>
          <div className="card-head row"><strong className="grow">შემთხვევები ({d.rows.length})</strong>
            <button className="btn sm" type="button" disabled={!d.rows.length} onClick={() => downloadCsv(`drg_sim_${f.from}_${f.to}.csv`,
              ['ისტორია', 'პაციენტი', 'განყოფილება', 'გადამხდელი', 'ფინალიზაცია', 'დღე', 'DRG იყო', 'წონა იყო', 'თანხა იყო', 'DRG ახალი', 'წონა ახალი', 'თანხა ახალი', 'სხვაობა', 'შენიშვნა'],
              d.rows.map((r) => [r.adm_no, r.patient, r.dept ?? '', r.payer_name, r.finalized, r.los, r.base.code ?? '', r.base.weight ?? '', r.base.amount?.toFixed(2) ?? '', r.sim.code ?? '', r.sim.weight ?? '',
                r.sim.amount?.toFixed(2) ?? '', r.diff?.toFixed(2) ?? '', r.sim.issue ?? '']))}>CSV</button></div>
          <table className="table">
            <thead><tr><th>ისტორია</th><th>პაციენტი</th><th>განყოფილება</th><th className="num">დღე</th><th>იყო</th><th>ახალი</th><th className="num">თანხა იყო</th><th className="num">ახალი</th><th className="num">სხვაობა</th></tr></thead>
            <tbody>{d.rows.map((r) => (
              <tr key={r.encounter_id} style={r.changed ? undefined : { opacity: 0.6 }}>
                <td className="mono"><Link to={`/inpatient/stay/${r.encounter_id}`}>{r.adm_no}</Link><div className="small muted">{dateGe(r.finalized)}</div></td><td>{r.patient}<div className="small muted">{r.payer_name}</div></td>
                <td className="small">{r.dept ?? '—'}</td><td className="num">{r.los}</td>
                <td><span className="mono">{r.base.code ?? '—'}</span> <span className="small muted">{r.base.weight ?? ''}</span></td>
                <td><span className="mono" style={r.base.code !== r.sim.code ? { fontWeight: 700 } : undefined}>{r.sim.code ?? '—'}</span> <span className="small muted">{r.sim.weight ?? ''}</span>
                  {r.sim.issue && <div className="small" style={{ color: r.sim.code ? 'var(--warn-ink)' : 'var(--danger-ink)' }}>{r.sim.issue}</div>}</td>
                <td className="num mono">{f2(r.base.amount)}</td><td className="num mono">{f2(r.sim.amount)}</td><td className="num mono" style={tone(r.diff)}>{sign(r.diff)}</td></tr>))}
              {!d.rows.length && <tr><td colSpan={9} className="muted">შემთხვევა არ არის</td></tr>}</tbody>
          </table>
        </section>
      </>}
    </div>
  );
}
