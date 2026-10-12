import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, can } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Field, Loading, Modal, useToast } from '../../components/ui';
import { dateGe, todayISO } from '../../lib/format';
import { downloadCsv } from '../stock/types';
import type { TabProps } from './Finance';
import { type Candidate, type Claim, type ClaimItem, type ClaimRow, CLAIM_RESOLVE, CLAIM_STATUS, FIN_EDIT, FIN_FULL, fmt, Kpi, monthStart, type Payer, type Receivables } from './types';

const FILTERS: [string, string][] = [['open', 'ღია'], ['overdue', 'ვადაგადაცილებული'], ['draft', 'მონახაზი'], ['settled', 'დაფარული'], ['', 'ყველა']];

/** გადამხდელის დებიტორები: ხანდაზმულობა + ქლეიმები (მონახაზი → გაგზავნა → ანაზღაურება → დანაკლისის / უარის გადაწყვეტა) */
export default function Claims({ summary }: TabProps) {
  const { user } = useAuth();
  const [sp, setSp] = useSearchParams();
  const [filter, setFilter] = useState('open');
  const [asOf, setAsOf] = useState(todayISO());
  const [creating, setCreating] = useState(false);
  const full = can(user, ...FIN_FULL);
  const list = useQuery({ queryKey: ['fin-claims', filter], queryFn: () => api<ClaimRow[]>('/finance/claims', { query: { status: filter || undefined } }) });
  const recv = useQuery({ queryKey: ['fin-recv', asOf], queryFn: () => api<Receivables>('/finance/receivables', { query: { as_of: asOf } }), enabled: full });
  const open = sp.get('id');
  const cols: [keyof Receivables['totals'], string][] = [['unclaimed', 'შეუტანელი'], ['draft', 'მონახაზი'], ['not_due', 'ვადამდე'], ['d1_30', '1–30'], ['d31_60', '31–60'], ['d61_90', '61–90'], ['d90', '90+']];
  return (
    <div className="content">
      {summary.claims && (
        <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
          <Kpi label="დაუფარავი (გაგზავნილი ქლეიმები)" value={`${fmt(summary.claims.outstanding)} ₾`} />
          <Kpi label="ღია ქლეიმი" value={String(summary.claims.open)} />
          <Kpi label="ვადაგადაცილებული" value={String(summary.claims.overdue)} tone={summary.claims.overdue ? 'danger' : undefined} />
          <Kpi label="მონახაზი" value={String(summary.claims.drafts)} tone={summary.claims.drafts ? 'warn' : undefined} />
          {recv.data && <Kpi label="ქლეიმში შეუტანელი" value={`${fmt(recv.data.totals.unclaimed)} ₾`} tone={recv.data.totals.unclaimed ? 'warn' : undefined} />}
        </div>)}
      {full && (
        <section className="card" style={{ overflowX: 'auto', flexShrink: 0 }}>
          <div className="row card-pad" style={{ paddingBottom: 0, flexWrap: 'wrap' }}>
            <strong className="grow">გადამხდელების დავალიანება (₾)</strong>
            <label className="row small">თარიღით <input className="input mono" type="date" style={{ height: 34, width: 150 }} max={todayISO()} value={asOf} onChange={(e) => setAsOf(e.target.value || todayISO())} /></label>
            <button className="btn sm" type="button" disabled={!recv.data?.rows.length} onClick={() => downloadCsv(`receivables_${asOf}.csv`, ['გადამხდელი', 'ტიპი', ...cols.map((c) => c[1]), 'სულ'],
              recv.data!.rows.map((r) => [r.payer_name, r.kind_ka, ...cols.map(([k]) => (r[k] as number).toFixed(2)), r.total.toFixed(2)]))}>CSV</button>
          </div>
          <ErrorBox error={recv.error} />
          {recv.isLoading ? <Loading /> : (
            <table className="table">
              <thead><tr><th>გადამხდელი</th>{cols.map(([k, l]) => <th key={k} className="num">{l}</th>)}<th className="num">სულ</th></tr></thead>
              <tbody>{recv.data?.rows.map((r) => (
                <tr key={r.payer_id}><td><strong>{r.payer_name}</strong> <span className="small muted">{r.kind_ka}</span></td>
                  {cols.map(([k]) => <td key={k} className="num mono" style={['d1_30', 'd31_60', 'd61_90', 'd90'].includes(k) && (r[k] as number) > 0 ? { color: 'var(--danger-ink)' } : undefined}>{(r[k] as number) ? fmt(r[k] as number) : '—'}</td>)}
                  <td className="num mono"><strong>{fmt(r.total)}</strong></td></tr>))}
                {!recv.data?.rows.length && <tr><td colSpan={9} className="muted">გადამხდელების დავალიანება არ არის</td></tr>}
                {!!recv.data?.rows.length && <tr><td><strong>სულ</strong></td>{cols.map(([k]) => <td key={k} className="num mono"><strong>{fmt(recv.data!.totals[k] as number)}</strong></td>)}<td className="num mono"><strong>{fmt(recv.data.totals.total)}</strong></td></tr>}
              </tbody>
            </table>)}
        </section>)}
      <section className="card" style={{ overflowX: 'auto', flexShrink: 0 }}>
        <div className="row card-pad" style={{ paddingBottom: 0, flexWrap: 'wrap' }}>
          <strong className="grow">ქლეიმები</strong>
          <div className="seg" role="group" aria-label="ფილტრი">{FILTERS.map(([k, l]) => <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}>{l}</button>)}</div>
          {can(user, ...FIN_EDIT) && <button className="btn primary sm" type="button" onClick={() => setCreating(true)}>+ ქლეიმი</button>}
        </div>
        <ErrorBox error={list.error} />
        {list.isLoading ? <Loading /> : (
          <table className="table">
            <thead><tr><th>№</th><th>გადამხდელი</th><th>პერიოდი</th><th>სტატუსი</th><th className="num">შემთხვ.</th><th className="num">მოთხოვნილი</th><th className="num">ანაზღაურებული</th><th className="num">ნაშთი</th><th>ვადა</th></tr></thead>
            <tbody>{list.data?.map((c) => {
              const late = c.days_overdue !== null && c.days_overdue > 0;
              return (
                <tr key={c.id} className="clickable" onClick={() => setSp({ id: c.id })}>
                  <td className="mono">{c.claim_no ?? <span className="muted">მონახაზი</span>}</td><td><strong>{c.payer_name}</strong></td>
                  <td className="mono small">{dateGe(c.period_from)} — {dateGe(c.period_to)}</td><td><span className={`chip ${CLAIM_STATUS[c.status][0]}`}>{CLAIM_STATUS[c.status][1]}</span></td>
                  <td className="num">{c.items}</td><td className="num mono">{fmt(c.total_claimed)}</td><td className="num mono">{fmt(c.total_paid)}</td><td className="num mono"><strong>{fmt(c.outstanding)}</strong></td>
                  <td className="mono small" style={late ? { color: 'var(--danger-ink)', fontWeight: 600 } : undefined}>{c.due_date ? dateGe(c.due_date) : '—'}{late && ` (+${c.days_overdue})`}</td>
                </tr>);
            })}
              {!list.data?.length && <tr><td colSpan={9} className="muted">ქლეიმი არ არის</td></tr>}
            </tbody>
          </table>)}
      </section>
      {creating && <NewClaim onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setSp({ id }); }} />}
      {open && <ClaimModal id={open} onClose={() => setSp({})} />}
    </div>
  );
}

function NewClaim({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const payers = useQuery({ queryKey: ['payers', false], queryFn: () => api<Payer[]>('/billing/payers') });
  const prev = (() => { const d = new Date(`${monthStart(todayISO())}T00:00:00Z`); d.setUTCDate(0); return d.toISOString().slice(0, 10); })();
  const [payer, setPayer] = useState(''); const [from, setFrom] = useState(monthStart(prev)); const [to, setTo] = useState(prev); const [notes, setNotes] = useState('');
  const cand = useQuery({ queryKey: ['fin-cand', payer, from, to], queryFn: () => api<Candidate[]>('/finance/claims/candidates', { query: { payer_id: payer, from, to } }), enabled: !!payer && from <= to });
  const sum = (cand.data ?? []).reduce((s, x) => s + Number(x.claimed), 0);
  const m = useMutation({
    mutationFn: () => api<Claim>('/finance/claims', { body: { payer_id: payer, period_from: from, period_to: to, notes: notes.trim() || null } }),
    onSuccess: (c) => { void qc.invalidateQueries({ queryKey: ['fin-claims'] }); void qc.invalidateQueries({ queryKey: ['fin-summary'] }); onCreated(c.id); },
  });
  return (
    <Modal title="ახალი ქლეიმი" onClose={onClose} width={720} footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button>
      <button className="btn primary" type="button" disabled={!cand.data?.length || m.isPending} onClick={() => m.mutate()}>მონახაზის შექმნა ({cand.data?.length ?? 0})</button></>}>
      <div className="stack">
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 12 }}>
          <Field label="გადამხდელი" htmlFor="ncp" required><select id="ncp" className="select" value={payer} onChange={(e) => setPayer(e.target.value)}>
            <option value="">— აირჩიეთ —</option>{payers.data?.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.code})</option>)}</select></Field>
          <Field label="დან" htmlFor="ncf"><input id="ncf" className="input mono" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="მდე" htmlFor="nct"><input id="nct" className="input mono" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        </div>
        <Field label="შენიშვნა" htmlFor="ncn"><input id="ncn" className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="მაგ. ხელშეკრულება №" /></Field>
        <span className="hint">შედის: სტაციონარი — ფინანსურად დახურული პერიოდში (გადამხდელის წილი); ამბულატორია — ინვოისი, სადაც ეს გადამხდელია მითითებული. სხვა ქლეიმში უკვე შემავალი არ შედის.</span>
        {cand.isFetching ? <Loading /> : payer && (
          <div style={{ maxHeight: 300, overflow: 'auto' }}>
            <table className="table"><thead><tr><th>თარიღი</th><th>პაციენტი</th><th>ინვოისი</th><th className="num">თანხა</th></tr></thead>
              <tbody>{cand.data?.map((x) => <tr key={x.invoice_id}><td className="mono small">{dateGe(x.case_date)}</td><td>{x.patient} <span className="small muted">{x.kind === 'ipd' ? `სტაც. ${x.adm_no ?? ''}` : 'ამბ.'}</span></td>
                <td className="mono small">{x.invoice_number}</td><td className="num mono">{fmt(x.claimed)}</td></tr>)}
                {!cand.data?.length && <tr><td colSpan={4} className="muted">შესატანი შემთხვევა არ არის</td></tr>}
                {!!cand.data?.length && <tr><td colSpan={3}><strong>სულ ({cand.data.length})</strong></td><td className="num mono"><strong>{fmt(sum)}</strong></td></tr>}</tbody></table>
          </div>)}
        <ErrorBox error={cand.error ?? m.error} />
      </div>
    </Modal>
  );
}

function ClaimModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { user } = useAuth(); const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['fin-claim', id], queryFn: () => api<Claim>(`/finance/claims/${id}`) });
  const [pay, setPay] = useState<{ amount: string; paid_on: string; ref: string } | null>(null);
  const [resolve, setResolve] = useState<ClaimItem | null>(null);
  const [reason, setReason] = useState('');
  const [cancelOpen, setCancelOpen] = useState(false);
  const done = (msg: string) => () => { toast.show(msg); ['fin-claim', 'fin-claims', 'fin-summary', 'fin-recv', 'fin-revenue'].forEach((k) => void qc.invalidateQueries({ queryKey: [k] })); };
  const act = useMutation({
    mutationFn: (x: { path: string; body?: unknown; method?: string }) => api<Claim>(x.path, { method: x.method ?? 'POST', body: x.body ?? {} }),
    onSuccess: done('შესრულდა'),
  });
  const c = q.data;
  const edit = can(user, ...FIN_EDIT);
  const open = c && ['sent', 'partial'].includes(c.status);
  return (
    <Modal title={c ? `ქლეიმი ${c.claim_no ?? '(მონახაზი)'} — ${c.payer_name}` : 'ქლეიმი'} onClose={onClose} width={1150}>
      {toast.node}
      {q.isLoading || !c ? <Loading /> : (
        <div className="stack">
          <div className="row" style={{ flexWrap: 'wrap', gap: 14 }}>
            <span className={`chip ${CLAIM_STATUS[c.status][0]}`}>{CLAIM_STATUS[c.status][1]}</span>
            <span className="small">პერიოდი: <span className="mono">{dateGe(c.period_from)} — {dateGe(c.period_to)}</span></span>
            {c.due_date && <span className="small">ვადა: <span className="mono">{dateGe(c.due_date)}</span> ({c.payment_terms_days} დღე)</span>}
            <span className="small">მოთხოვნილი <strong className="mono">{fmt(c.total_claimed)}</strong> · ანაზღაურებული <strong className="mono">{fmt(c.total_paid)}</strong> · გადაწყვეტილი <strong className="mono">{fmt(c.total_resolved)}</strong> · ნაშთი <strong className="mono">{fmt(c.outstanding)}</strong></span>
            <span className="grow" />
            <button className="btn sm" type="button" onClick={() => downloadCsv(`claim-${c.claim_no ?? 'draft'}-${c.payer_code}.csv`,
              ['ტიპი', 'ჰოსპ. №', 'ინვოისი', 'თარიღი', 'პაციენტი', 'პირადი №', 'პოლისი', 'საგარანტიო', 'მოთხოვნილი', 'ანაზღაურებული', 'გადაწყვეტილი', 'ნაშთი'],
              c.items.map((x) => [x.kind === 'ipd' ? 'სტაციონარი' : 'ამბულატორია', x.adm_no, x.invoice_number, x.case_date, x.patient, x.personal_number, x.policy_no, x.guarantee_no, x.claimed, x.paid, x.resolved_amount, x.outstanding]))}>CSV (რეესტრი)</button>
            {edit && c.status === 'draft' && <>
              <button className="btn sm" type="button" disabled={act.isPending} onClick={() => act.mutate({ path: `/finance/claims/${id}`, method: 'PUT', body: {} })}>ახალი შემთხვევების დამატება</button>
              <button className="btn primary sm" type="button" disabled={act.isPending || !c.items.length} onClick={() => act.mutate({ path: `/finance/claims/${id}/send` })}>გაგზავნა</button></>}
            {edit && open && <button className="btn primary sm" type="button" onClick={() => setPay({ amount: Number(c.outstanding).toFixed(2), paid_on: todayISO(), ref: '' })}>ანაზღაურება</button>}
            {edit && ['draft', 'sent'].includes(c.status) && <button className="btn danger sm" type="button" onClick={() => setCancelOpen(true)}>გაუქმება</button>}
          </div>
          {c.notes && <span className="small muted">{c.notes}</span>}
          {c.status === 'cancelled' && <div className="alert warn">გაუქმებულია: {c.cancel_reason} ({c.cancelled_by_name})</div>}
          <ErrorBox error={act.error} />
          {cancelOpen && (
            <div className="row card-pad" style={{ background: 'var(--surface-2)', flexWrap: 'wrap' }}>
              <input className="input grow" placeholder="გაუქმების მიზეზი" value={reason} onChange={(e) => setReason(e.target.value)} />
              <button className="btn" type="button" onClick={() => setCancelOpen(false)}>არა</button>
              <button className="btn danger" type="button" disabled={reason.trim().length < 3} onClick={() => { act.mutate({ path: `/finance/claims/${id}/cancel`, body: { reason } }); setCancelOpen(false); setReason(''); }}>ქლეიმის გაუქმება</button>
            </div>)}
          {pay && (
            <form className="row card-pad" style={{ background: 'var(--surface-2)', flexWrap: 'wrap', alignItems: 'flex-end' }}
              onSubmit={(e) => { e.preventDefault(); act.mutate({ path: `/finance/claims/${id}/payments`, body: { amount: Number(pay.amount), paid_on: pay.paid_on, ref_no: pay.ref || null } }); setPay(null); }}>
              <Field label="თანხა (₾)" htmlFor="cpa"><input id="cpa" className="input mono" inputMode="decimal" value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} /></Field>
              <Field label="თარიღი" htmlFor="cpd"><input id="cpd" className="input mono" type="date" max={todayISO()} value={pay.paid_on} onChange={(e) => setPay({ ...pay, paid_on: e.target.value })} /></Field>
              <Field label="ბანკის საბუთი №" htmlFor="cpr"><input id="cpr" className="input mono" value={pay.ref} onChange={(e) => setPay({ ...pay, ref: e.target.value })} /></Field>
              <span className="hint grow">ნაწილდება შემთხვევებზე რიგით, ნაშთამდე. დანაკლისი — „გადაწყვეტა“ შემთხვევის ხაზზე.</span>
              <button className="btn" type="button" onClick={() => setPay(null)}>გაუქმება</button>
              <button className="btn primary" type="submit" disabled={!(Number(pay.amount) > 0)}>რეგისტრაცია</button>
            </form>)}
          <div style={{ overflowX: 'auto', flexShrink: 0 }}>
            <table className="table">
              <thead><tr><th>თარიღი</th><th>პაციენტი</th><th>ინვოისი</th><th>პოლისი / საგარანტიო</th><th className="num">მოთხოვნილი</th><th className="num">ანაზღ.</th><th className="num">ნაშთი</th><th>გადაწყვეტა</th><th /></tr></thead>
              <tbody>{c.items.map((x) => (
                <tr key={x.id}>
                  <td className="mono small">{dateGe(x.case_date)}</td>
                  <td>{x.patient}<div className="small muted">{x.personal_number} · {x.kind === 'ipd' ? <Link to={`/inpatient/stay/${x.encounter_id}`}>სტაც. {x.adm_no}</Link> : 'ამბულატორია'}</div></td>
                  <td className="mono small">{x.invoice_number}</td><td className="small">{[x.policy_no, x.guarantee_no].filter(Boolean).join(' / ') || '—'}</td>
                  <td className="num mono">{fmt(x.claimed)}</td><td className="num mono">{Number(x.paid) ? fmt(x.paid) : '—'}</td>
                  <td className="num mono"><strong>{Number(x.outstanding) ? fmt(x.outstanding) : '—'}</strong></td>
                  <td className="small">{x.resolution ? <span title={`${x.resolution_reason ?? ''} — ${x.resolved_by_name ?? ''}`} className={`chip ${x.resolution === 'patient' ? 'info' : 'danger'}`}>
                    {x.resolution === 'patient' ? 'პაციენტზე' : 'ჩამოწერა'} {fmt(x.resolved_amount)}</span> : '—'}</td>
                  <td style={{ textAlign: 'right' }}>
                    {edit && c.status === 'draft' && <button className="btn sm" type="button" onClick={() => act.mutate({ path: `/finance/claims/${id}/items/${x.id}`, method: 'DELETE' })}>ამოღება</button>}
                    {can(user, ...CLAIM_RESOLVE) && open && !x.resolution && Number(x.outstanding) > 0 && <button className="btn sm" type="button" onClick={() => setResolve(x)}>გადაწყვეტა</button>}
                  </td>
                </tr>))}
                {!c.items.length && <tr><td colSpan={9} className="muted">შემთხვევა არ არის</td></tr>}
              </tbody>
            </table>
          </div>
          {resolve && <ResolveForm item={resolve} onClose={() => setResolve(null)} onDone={() => { setResolve(null); done('გადაწყვეტილია')(); }} />}
          {c.payments.length > 0 && (
            <section className="stack" style={{ gap: 6 }}>
              <strong>ანაზღაურებები</strong>
              <table className="table"><tbody>{c.payments.map((p) => (
                <tr key={p.id} style={p.is_void ? { opacity: 0.5, textDecoration: 'line-through' } : undefined}>
                  <td className="mono">{dateGe(p.paid_on)}</td><td className="num mono">{fmt(p.amount)} ₾</td><td className="mono small">{p.ref_no ?? '—'}</td><td className="small">{p.items} შემთხვევა · {p.created_by_name}</td>
                  <td className="small">{p.is_void ? `გაუქმდა: ${p.void_reason}` : ''}</td>
                  <td style={{ textAlign: 'right' }}>{edit && !p.is_void && <button className="btn sm" type="button" onClick={() => { const r = window.prompt('გაუქმების მიზეზი'); if (r && r.trim().length >= 3) act.mutate({ path: `/finance/claim-payments/${p.id}/void`, body: { reason: r } }); }}>გაუქმება</button>}</td>
                </tr>))}</tbody></table>
            </section>)}
          <span className="small muted">შექმნა: {c.created_by_name}{c.sent_by_name ? ` · გაგზავნა: ${c.sent_by_name}` : ''}</span>
        </div>)}
    </Modal>
  );
}

function ResolveForm({ item, onClose, onDone }: { item: ClaimItem; onClose: () => void; onDone: () => void }) {
  const [action, setAction] = useState<'patient' | 'writeoff'>('patient');
  const [amount, setAmount] = useState(Number(item.outstanding).toFixed(2)); const [reason, setReason] = useState('');
  const m = useMutation({ mutationFn: () => api(`/finance/claim-items/${item.id}/resolve`, { body: { action, amount: Number(amount), reason } }), onSuccess: onDone });
  return (
    <form className="stack card-pad" style={{ background: 'var(--surface-2)' }} onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
      <strong>დანაკლისი / უარი — {item.patient} ({item.invoice_number}), ნაშთი {fmt(item.outstanding)} ₾</strong>
      <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div className="seg" role="group" aria-label="გადაწყვეტა">
          <button type="button" aria-pressed={action === 'patient'} onClick={() => setAction('patient')}>პაციენტზე გადატანა</button>
          <button type="button" aria-pressed={action === 'writeoff'} onClick={() => setAction('writeoff')}>ჩამოწერა</button>
        </div>
        <Field label="თანხა" htmlFor="rsa"><input id="rsa" className="input mono" inputMode="decimal" style={{ width: 130 }} value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="მიზეზი" htmlFor="rsr" required><input id="rsr" className="input" style={{ minWidth: 300 }} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="მაგ. გამორიცხული მომსახურება / ლიმიტი ამოიწურა" /></Field>
        <button className="btn" type="button" onClick={onClose}>გაუქმება</button>
        <button className="btn primary" type="submit" disabled={m.isPending || reason.trim().length < 3 || !(Number(amount) > 0)}>დადასტურება</button>
      </div>
      <span className="hint">{action === 'patient' ? 'თანხა გადადის პაციენტის წილში — სალაროში გამოჩნდება დავალიანებად.' : 'თანხა ჩამოიწერება — შემოსავლის რეპორტში „უარი — ჩამოწერილი“.'}</span>
      <ErrorBox error={m.error} />
    </form>
  );
}
