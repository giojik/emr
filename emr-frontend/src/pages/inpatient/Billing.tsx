import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, can, openBlob, printBlob } from '../../api/client';
import type { Tariff } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { uploadPatientFile } from '../../components/DocumentsPanel';
import { ErrorBox, Field, Loading, Modal, useDebounced, useToast } from '../../components/ui';
import { dateGe, money, shiftDay, todayISO, tsDate } from '../../lib/format';
import { CAT_KA, MODE_KA, type Drg, type Package, type Payer } from '../admin/BillingSetup';

/** სტაციონარის ბილინგი (0046): ჰოსპიტალიზაციის პანელი + სამუშაო სია / რეპორტი */
type Money = Record<'total' | 'insurance' | 'state' | 'writeoff' | 'patient' | 'deposits' | 'refunds' | 'deposit_net' | 'deposit_applied' | 'deposit_unapplied' | 'paid' | 'due' | 'refund_due' | 'surplus', string>;
interface StayPayer {
  id: string; payer_id: string; payer_name: string; payer_code: string; kind: string; kind_ka: string; seq: number; mode: string; mode_ka: string; status: string;
  coverage_pct?: string; limit_amount?: string | null; deductible?: string; fixed_amount?: string | null; drg_code: string | null; drg_title: string | null; drg_weight?: string | null; drg_base_rate?: string | null;
  writeoff_excess?: boolean; excluded_categories?: string[]; policy_no: string | null; guarantee_no: string | null; guarantee_day?: string | null; valid_day?: string | null; file_id?: string | null;
  override_amount?: string | null; override_reason?: string | null; covered_amount?: string | null; cancel_reason?: string | null; created_by_name?: string;
  calc: { tariff: number | null; eligible: number; amount: number; writeoff: number } | null;
}
interface Line { id: string; category: string; category_ka: string; description: string; quantity: number; unit_price?: string; line_total?: string; package_included: boolean; service_date: string | null;
  created_at: string; added_by: string | null; added_by_name: string | null; manual: boolean; discount_reason?: string | null }
interface BillingView {
  stay: { encounter_id: string; patient_id: string; adm_no: string; status: string; admitted_at: string; ended_at: string | null; first_name: string; last_name: string };
  invoice_number: string; finalized: boolean; finalized_at: string | null; finalized_by_name: string | null; reopen_count: number;
  package: { id: string; code: string; name: string; price?: string; includes_bed: boolean; included_days: number | null; set_by_name: string | null } | null;
  bed_days: { day: string; department_name: string; bed_code: string | null; bed_type_name: string; on_leave: boolean; minimum: boolean; package_included: boolean; tariff_title: string | null; price?: string }[];
  bed_days_count: number; missing_tariff_days: number; lines: Line[]; by_category: { category: string; label: string; amount: string; included: string }[];
  payers: StayPayer[]; deposits: { id: string; kind: string; amount: string; method: string; terminal_ref: string | null; receipt_no: string; note: string | null; created_at: string; voided_at: string | null; void_reason: string | null; created_by_name: string }[];
  payments: { id: string; amount: string; method: string; paid_at: string; received_by_name: string | null }[];
  money: Money | null; amounts_visible: boolean;
  can: { services: boolean; package: boolean; payers: boolean; override: boolean; deposits: boolean; void_deposit: boolean; finalize: boolean; reopen: boolean };
}
const METHOD_KA: Record<string, string> = { cash: 'ნაღდი', card_terminal: 'ბარათი', bank_transfer: 'გადარიცხვა', deposit: 'ავანსიდან' };
const n = (v: string | number | null | undefined) => Number(v ?? 0);

export default function StayBillingPanel({ encounterId }: { encounterId: string }) {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['ipd-billing', encounterId], queryFn: () => api<BillingView>(`/inpatient/stays/${encounterId}/billing`) });
  const [dlg, setDlg] = useState<null | 'service' | 'payer' | 'deposit' | 'refund' | 'reopen' | 'days' | { payer: StayPayer } | { cancelPayer: StayPayer } | { voidDep: string } | { rmLine: Line }>(null);
  const inval = () => { void qc.invalidateQueries({ queryKey: ['ipd-billing', encounterId] }); void qc.invalidateQueries({ queryKey: ['ipd-billing-list'] }); };
  const pkgs = useQuery({ queryKey: ['billing-packages', false], queryFn: () => api<Package[]>('/billing/packages'), enabled: !!q.data?.can.package });
  const setPkg = useMutation({ mutationFn: (id: string | null) => api(`/inpatient/stays/${encounterId}/billing/package`, { body: { package_id: id } }), onSuccess: () => { toast.show('პაკეტი შეიცვალა'); inval(); } });
  const fin = useMutation({ mutationFn: () => api(`/inpatient/stays/${encounterId}/billing/finalize`, { body: {} }), onSuccess: () => { toast.show('ინვოისი ფინალიზებულია'); inval(); } });
  if (q.isLoading) return <section id="billing" className="card card-pad"><Loading /></section>;
  if (q.error || !q.data) return <section id="billing" className="card card-pad"><ErrorBox error={q.error} /></section>;
  const b = q.data; const m = b.money;
  const cats = [...new Set(b.lines.map((l) => l.category))];
  return (
    <section id="billing" className="card">
      <div className="card-head row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }} className="grow">ბილინგი <span className="small muted mono" style={{ fontWeight: 400 }}>{b.invoice_number}</span>
          {b.finalized ? <span className="chip ok" style={{ marginLeft: 8 }}>ფინალიზებული{b.finalized_at ? ` · ${tsDate(b.finalized_at)}` : ''}</span> : <span className="chip info" style={{ marginLeft: 8 }}>მიმდინარე (შეფასება)</span>}</h2>
        {b.amounts_visible && <button className="btn sm" type="button" onClick={() => void openBlob(`/inpatient/stays/${encounterId}/billing/pdf`)}>კალკულაცია (PDF)</button>}
        {b.can.services && <button className="btn sm" type="button" onClick={() => setDlg('service')}>+ მომსახურება</button>}
        {b.can.deposits && <button className="btn sm" type="button" onClick={() => setDlg('deposit')}>ავანსი</button>}
        {b.can.finalize && <button className="btn sm primary" type="button" disabled={fin.isPending} onClick={() => fin.mutate()}>ფინანსური დახურვა</button>}
        {b.can.reopen && <button className="btn sm" type="button" onClick={() => setDlg('reopen')}>გახსნა</button>}
      </div>
      <div className="card-pad stack" style={{ gap: 14 }}>
        <ErrorBox error={fin.error ?? setPkg.error} />
        {b.missing_tariff_days > 0 && <div className="alert warn">საწოლდღე ({b.missing_tariff_days}) ტარიფის გარეშეა — ადმინისტრირება → სტაციონარის ბილინგი → საწოლდღის ტარიფები.</div>}
        {m && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10 }}>
          <Kpi label="ჯამი" value={m.total} />
          <Kpi label="გადამხდელი" value={String(n(m.insurance) + n(m.state))} sub={n(m.writeoff) > 0 ? `ჩამოწერა ${money(m.writeoff)}` : undefined} />
          <Kpi label="პაციენტის წილი" value={m.patient} />
          <Kpi label="ავანსი" value={m.deposit_net} sub={n(m.paid) > 0 ? `გადახდილი ${money(m.paid)}` : undefined} />
          {n(m.refund_due) > 0 ? <Kpi label="დასაბრუნებელი" value={m.refund_due} tone="info" /> : n(m.surplus) > 0 ? <Kpi label="ავანსის ნაშთი" value={m.surplus} tone="ok" sub="შეფასებით, ჯერჯერობით" />
            : <Kpi label={b.finalized ? 'გადასახდელი' : 'გადასახდელი (შეფასებით)'} value={m.due} tone={n(m.due) > 0 ? 'warn' : 'ok'} />}
        </div>}
        {!b.amounts_visible && <span className="hint">თანხებს ხედავს ბილინგი / სალარო{' '}(და — პარამეტრით — განყოფილების ხელმძღვანელი).</span>}

        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <strong className="small">პაკეტი:</strong>
          {b.can.package ? (
            <select aria-label="პაკეტი" className="select" style={{ maxWidth: 360 }} value={b.package?.id ?? ''} disabled={setPkg.isPending} onChange={(e) => setPkg.mutate(e.target.value || null)}>
              <option value="">— მომსახურებით (პაკეტის გარეშე) —</option>
              {pkgs.data?.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.code}) — {money(p.price)}</option>)}
              {b.package && !pkgs.data?.some((p) => p.id === b.package!.id) && <option value={b.package.id}>{b.package.name}</option>}
            </select>
          ) : <span>{b.package ? `${b.package.name} (${b.package.code})` : 'მომსახურებით'}</span>}
          {b.package && <span className="small muted">{b.package.includes_bed ? `საწოლდღე: ${b.package.included_days ? `${b.package.included_days} დღე` : 'შეუზღუდავი'}` : 'საწოლდღე არ შედის'}</span>}
          <span className="grow" />
          <button className="btn sm" type="button" onClick={() => setDlg('days')}>საწოლდღე: {b.bed_days_count}</button>
        </div>

        <div className="stack" style={{ gap: 6 }}>
          <div className="row"><h3 style={{ margin: 0 }} className="grow">გადამხდელები</h3>{b.can.payers && <button className="btn sm" type="button" onClick={() => setDlg('payer')}>+ გადამხდელი</button>}</div>
          {b.payers.length === 0 ? <span className="small muted">თვითდაფინანსება (გადამხდელი არ არის).</span> : (
            <table className="table">
              <thead><tr><th>#</th><th>გადამხდელი</th><th>პირობა</th><th>საგარანტიო / პოლისი</th>{b.amounts_visible && <th className="num">ფარავს</th>}<th /></tr></thead>
              <tbody>{b.payers.map((p) => (
                <tr key={p.id} style={p.status !== 'active' ? { opacity: 0.55 } : undefined}>
                  <td>{p.seq}</td><td><strong>{p.payer_name}</strong><div className="small muted">{p.kind_ka}</div></td>
                  <td className="small">{p.mode === 'drg' ? <>DRG <span className="mono">{p.drg_code}</span> — {p.drg_title}{p.drg_weight && <> · {Number(p.drg_weight)} × {money(p.drg_base_rate)}</>}</>
                    : p.mode === 'fixed' ? `ფიქსირებული ${money(p.fixed_amount)}` : `${p.coverage_pct ? Number(p.coverage_pct) : ''}%`}
                    {p.mode !== 'percent' && p.coverage_pct && ` · ${Number(p.coverage_pct)}%`}
                    {p.limit_amount && ` · ლიმიტი ${money(p.limit_amount)}`}{n(p.deductible) > 0 && ` · ფრანშიზა ${money(p.deductible)}`}
                    {(p.excluded_categories?.length ?? 0) > 0 && <div className="muted">არ ფარავს: {p.excluded_categories!.map((c) => CAT_KA[c]).join(', ')}</div>}
                    {p.override_amount && <div><span className="chip warn">ხელით: {money(p.override_amount)}</span> {p.override_reason}</div>}
                    {p.status !== 'active' && <div className="muted">გაუქმებულია: {p.cancel_reason}</div>}</td>
                  <td className="small">{p.guarantee_no && <>№ {p.guarantee_no}{p.guarantee_day && ` · ${dateGe(p.guarantee_day)}`}</>}{p.policy_no && <div>პოლისი {p.policy_no}</div>}
                    {p.valid_day && <div className="muted">ვადა {dateGe(p.valid_day)}</div>}
                    {p.file_id && <button className="btn sm" type="button" style={{ marginTop: 4 }} onClick={() => void openBlob(`/patient-files/${p.file_id}/content`)}>ფაილი</button>}</td>
                  {b.amounts_visible && <td className="num">{p.status === 'active' ? money(b.finalized ? p.covered_amount : p.calc?.amount) : '—'}
                    {p.calc && p.calc.writeoff > 0 && <div className="small muted">ჩამოწერა {money(p.calc.writeoff)}</div>}</td>}
                  <td className="num" style={{ whiteSpace: 'nowrap' }}>{p.status === 'active' && b.can.payers && <>
                    <button className="btn sm" type="button" onClick={() => setDlg({ payer: p })}>შეცვლა</button>{' '}
                    <button className="btn sm" type="button" onClick={() => setDlg({ cancelPayer: p })}>გაუქმება</button></>}</td>
                </tr>))}</tbody>
            </table>)}
        </div>

        <div className="stack" style={{ gap: 6 }}>
          <h3 style={{ margin: 0 }}>მომსახურება და ხარჯი</h3>
          {b.lines.length === 0 ? <span className="small muted">ჩანაწერი არ არის.</span> : (
            <table className="table">
              <thead><tr><th>დასახელება</th><th>თარიღი</th><th className="num">რაოდ.</th>{b.amounts_visible && <><th className="num">ფასი</th><th className="num">ჯამი</th></>}<th /></tr></thead>
              {cats.map((c) => {
                const ls = b.lines.filter((l) => l.category === c); const sum = b.by_category.find((x) => x.category === c);
                return (
                  <tbody key={c}>
                    <tr style={{ background: 'var(--surface-2, #f6f6f6)' }}><td colSpan={3}><strong>{CAT_KA[c] ?? c}</strong></td>
                      {b.amounts_visible && <><td /><td className="num"><strong>{money(sum?.amount)}</strong>{n(sum?.included) > 0 && <div className="small muted">პაკეტში {money(sum?.included)}</div>}</td></>}<td /></tr>
                    {ls.map((l) => (
                      <tr key={l.id}>
                        <td>{l.description}{l.package_included && <span className="chip accent" style={{ marginLeft: 6 }}>პაკეტში</span>}
                          {l.manual && l.added_by_name && <div className="small muted">{l.added_by_name}</div>}</td>
                        <td className="small">{l.service_date ? dateGe(l.service_date) : tsDate(l.created_at)}</td><td className="num">{l.quantity}</td>
                        {b.amounts_visible && <><td className="num">{money(l.unit_price)}</td><td className="num" style={l.package_included ? { textDecoration: 'line-through', color: 'var(--muted)' } : undefined}>{money(l.line_total)}</td></>}
                        <td className="num">{l.manual && b.can.services && <button className="btn sm" type="button" onClick={() => setDlg({ rmLine: l })}>წაშლა</button>}</td>
                      </tr>))}
                  </tbody>);
              })}
            </table>)}
        </div>

        {b.amounts_visible && (b.deposits.length > 0 || b.payments.length > 0) && <div className="stack" style={{ gap: 6 }}>
          <div className="row"><h3 style={{ margin: 0 }} className="grow">ავანსი და გადახდები</h3>
            {b.can.deposits && n(m?.refund_due) > 0 && <button className="btn sm" type="button" onClick={() => setDlg('refund')}>დაბრუნება ({money(m?.refund_due)})</button>}</div>
          <table className="table"><tbody>
            {b.deposits.map((d) => (
              <tr key={d.id} style={d.voided_at ? { opacity: 0.55 } : undefined}>
                <td className="small">{tsDate(d.created_at)}</td><td>{d.kind === 'deposit' ? 'ავანსი' : 'დაბრუნება'} <span className="mono small">{d.receipt_no}</span>
                  {d.voided_at && <div className="small muted">გაუქმებულია: {d.void_reason}</div>}</td>
                <td className="small">{METHOD_KA[d.method]}{d.terminal_ref ? ` (${d.terminal_ref})` : ''}</td><td className="small muted">{d.created_by_name}</td>
                <td className="num">{d.kind === 'refund' ? '−' : ''}{money(d.amount)}</td>
                <td className="num" style={{ whiteSpace: 'nowrap' }}><button className="btn sm" type="button" onClick={() => void printBlob(`/inpatient/deposits/${d.id}/receipt`)}>ქვითარი</button>
                  {!d.voided_at && b.can.void_deposit && <> <button className="btn sm" type="button" onClick={() => setDlg({ voidDep: d.id })}>გაუქმება</button></>}</td>
              </tr>))}
            {b.payments.map((p) => (
              <tr key={p.id}><td className="small">{tsDate(p.paid_at)}</td><td>{p.method === 'deposit' ? 'ავანსის მიმართვა ინვოისზე' : 'გადახდა ინვოისზე'}</td>
                <td className="small">{METHOD_KA[p.method]}</td><td className="small muted">{p.received_by_name}</td><td className="num">{money(p.amount)}</td><td /></tr>))}
          </tbody></table>
        </div>}
        {b.finalized && b.finalized_by_name && <span className="small muted">ფინალიზება: {b.finalized_by_name}{b.reopen_count > 0 ? ` · გაიხსნა ${b.reopen_count}-ჯერ` : ''}. დარჩენილი თანხა — <Link to={`/cashier/${encounterId}`}>სალარო</Link>.</span>}
        {!b.finalized && b.stay.status === 'discharged' && !b.can.finalize && <span className="small muted">გაწერილია — ფინანსურ დახურვას აკეთებს ბილინგი.</span>}
      </div>

      {dlg === 'service' && <ServiceDialog encounterId={encounterId} onClose={() => setDlg(null)} onDone={inval} />}
      {dlg === 'payer' && <PayerDialog view={b} onClose={() => setDlg(null)} onDone={inval} />}
      {dlg && typeof dlg === 'object' && 'payer' in dlg && <PayerDialog view={b} sp={dlg.payer} onClose={() => setDlg(null)} onDone={inval} />}
      {(dlg === 'deposit' || dlg === 'refund') && <DepositDialog encounterId={encounterId} kind={dlg} max={dlg === 'refund' ? n(m?.refund_due) : undefined} onClose={() => setDlg(null)} onDone={inval} />}
      {dlg === 'days' && <DaysDialog b={b} onClose={() => setDlg(null)} />}
      {dlg === 'reopen' && <ReasonPrompt title="ინვოისის გახსნა" label="მიზეზი" hint="ავანსის მიმართვა მოიხსნება, გადამხდელების თანხები ხელახლა დაითვლება" path={`/inpatient/stays/${encounterId}/billing/reopen`} method="POST" onClose={() => setDlg(null)} onDone={inval} />}
      {dlg && typeof dlg === 'object' && 'cancelPayer' in dlg && <ReasonPrompt title={`გადამხდელის გაუქმება — ${dlg.cancelPayer.payer_name}`} label="მიზეზი" path={`/inpatient/stay-payers/${dlg.cancelPayer.id}/cancel`} method="POST" onClose={() => setDlg(null)} onDone={inval} />}
      {dlg && typeof dlg === 'object' && 'voidDep' in dlg && <ReasonPrompt title="ავანსის / დაბრუნების გაუქმება" label="მიზეზი" path={`/inpatient/deposits/${dlg.voidDep}/void`} method="POST" onClose={() => setDlg(null)} onDone={inval} />}
      {dlg && typeof dlg === 'object' && 'rmLine' in dlg && <ReasonPrompt title={`წაშლა — ${dlg.rmLine.description}`} label="მიზეზი" path={`/inpatient/stays/${encounterId}/services/${dlg.rmLine.id}`} method="DELETE" onClose={() => setDlg(null)} onDone={inval} />}
    </section>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'ok' | 'warn' | 'info' }) {
  const color = tone === 'warn' ? 'var(--warn, #b26a00)' : tone === 'ok' ? 'var(--ok, #1a7f37)' : tone === 'info' ? 'var(--accent)' : 'var(--ink)';
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '10px 12px' }}>
      <div className="small muted">{label}</div>
      <div className="mono" style={{ fontSize: 20, fontWeight: 600, color }}>{money(value)}</div>
      {sub && <div className="small muted">{sub}</div>}
    </div>
  );
}

function ReasonPrompt({ title, label, hint, path, method, onClose, onDone }: { title: string; label: string; hint?: string; path: string; method: string; onClose: () => void; onDone: () => void }) {
  const [r, setR] = useState('');
  const m = useMutation({ mutationFn: () => api(path, { method, body: { reason: r } }), onSuccess: () => { onDone(); onClose(); } });
  return (
    <Modal title={title} onClose={onClose} width={480}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="submit" form="rsn" disabled={r.trim().length < 5 || m.isPending}>დადასტურება</button></>}>
      <form id="rsn" className="stack" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <Field label={label} htmlFor="rsn-r" required hint={hint ?? 'მინ. 5 სიმბოლო'}><textarea id="rsn-r" className="textarea" rows={3} value={r} onChange={(e) => setR(e.target.value)} autoFocus /></Field>
        <ErrorBox error={m.error} />
      </form>
    </Modal>
  );
}

function ServiceDialog({ encounterId, onClose, onDone }: { encounterId: string; onClose: () => void; onDone: () => void }) {
  const [search, setSearch] = useState(''); const dq = useDebounced(search.trim(), 250);
  const tf = useQuery({ queryKey: ['tariffs', dq, false], queryFn: () => api<Tariff[]>('/tariffs', { query: { search: dq } }) });
  const [sel, setSel] = useState<Tariff | null>(null); const [qty, setQty] = useState('1'); const [day, setDay] = useState(todayISO()); const [note, setNote] = useState('');
  const m = useMutation({ mutationFn: () => api(`/inpatient/stays/${encounterId}/services`, { body: { tariff_id: sel!.id, quantity: Number(qty), service_date: day, note: note || undefined } }), onSuccess: () => { onDone(); onClose(); } });
  return (
    <Modal title="მომსახურების დამატება" onClose={onClose} width={620}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="submit" form="svc" disabled={!sel || m.isPending}>დამატება</button></>}>
      <form id="svc" className="stack" style={{ gap: 12 }} onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <Field label="მომსახურება (ტარიფი)" htmlFor="svc-s" required><input id="svc-s" className="input" placeholder="კოდი ან დასახელება" value={search} onChange={(e) => { setSearch(e.target.value); setSel(null); }} autoFocus /></Field>
        {!sel && <div style={{ maxHeight: 220, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 8 }}>
          {tf.data?.slice(0, 50).map((t) => <button key={t.id} type="button" onClick={() => { setSel(t); setSearch(`${t.code} — ${t.title}`); }}
            style={{ display: 'flex', width: '100%', justifyContent: 'space-between', gap: 8, padding: '8px 12px', border: 0, borderBottom: '1px solid var(--line-soft)', background: 'transparent', font: 'inherit', textAlign: 'left', cursor: 'pointer', color: 'var(--ink)' }}>
            <span><span className="mono small">{t.code}</span> {t.title}</span><span className="mono">{money(t.base_price)}</span></button>)}
          {tf.data?.length === 0 && <div className="empty">ვერ მოიძებნა.</div>}
        </div>}
        <div style={{ display: 'grid', gridTemplateColumns: '120px 180px 1fr', gap: 12 }}>
          <Field label="რაოდენობა" htmlFor="svc-q" required><input id="svc-q" className="input mono" type="number" min={1} max={999} value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
          <Field label="თარიღი" htmlFor="svc-d" required><input id="svc-d" className="input" type="date" max={todayISO()} value={day} onChange={(e) => setDay(e.target.value)} /></Field>
          <Field label="შენიშვნა" htmlFor="svc-n"><input id="svc-n" className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        </div>
        <ErrorBox error={m.error} />
      </form>
    </Modal>
  );
}

function PayerDialog({ view, sp, onClose, onDone }: { view: BillingView; sp?: StayPayer; onClose: () => void; onDone: () => void }) {
  const payers = useQuery({ queryKey: ['payers', false], queryFn: () => api<Payer[]>('/billing/payers') });
  const [payerId, setPayerId] = useState(sp?.payer_id ?? '');
  const p = payers.data?.find((x) => x.id === payerId);
  const s = (v: string | null | undefined) => (v === null || v === undefined ? '' : String(Number(v)));
  const [f, setF] = useState({ mode: sp?.mode ?? '', coverage_pct: s(sp?.coverage_pct), limit_amount: s(sp?.limit_amount), deductible: s(sp?.deductible), fixed_amount: s(sp?.fixed_amount),
    drg_code: sp?.drg_code ?? '', writeoff_excess: sp?.writeoff_excess, policy_no: sp?.policy_no ?? '', guarantee_no: sp?.guarantee_no ?? '', guarantee_date: sp?.guarantee_day ?? '',
    valid_until: sp?.valid_day ?? '', override_amount: s(sp?.override_amount), override_reason: sp?.override_reason ?? '' });
  const [excl, setExcl] = useState<string[] | null>(sp?.excluded_categories ?? null);
  const [file, setFile] = useState<File | null>(null);
  const mode = f.mode || p?.default_mode || 'percent';
  const [drgQ, setDrgQ] = useState(''); const dq = useDebounced(drgQ.trim(), 250);
  const drg = useQuery({ queryKey: ['drg', dq, false], queryFn: () => api<{ rows: Drg[] }>('/billing/drg', { query: { search: dq, limit: 30 } }), enabled: mode === 'drg' });
  const pickPayer = (id: string) => {
    setPayerId(id); const x = payers.data?.find((y) => y.id === id);
    if (x && !sp) { setF({ ...f, mode: x.default_mode, coverage_pct: s(x.default_coverage_pct), limit_amount: s(x.default_limit), deductible: s(x.default_deductible), writeoff_excess: x.writeoff_excess }); setExcl(x.excluded_categories); }
  };
  const m = useMutation({
    mutationFn: async () => {
      let fileId: string | undefined;
      if (file) fileId = (await uploadPatientFile(view.stay.patient_id, file, 'guarantee_letter', f.guarantee_no ? `საგარანტიო № ${f.guarantee_no}` : undefined)).id;
      const num = (v: string) => (v === '' ? null : Number(v.replace(',', '.')));
      const body: Record<string, unknown> = { mode, coverage_pct: num(f.coverage_pct) ?? 100, limit_amount: mode === 'percent' ? num(f.limit_amount) : null, deductible: mode === 'percent' ? num(f.deductible) ?? 0 : 0,
        fixed_amount: mode === 'fixed' ? num(f.fixed_amount) : null, drg_code: mode === 'drg' ? f.drg_code || null : null, writeoff_excess: !!f.writeoff_excess, excluded_categories: excl ?? [],
        policy_no: f.policy_no || null, guarantee_no: f.guarantee_no || null, guarantee_date: f.guarantee_date || null, valid_until: f.valid_until || null, ...(fileId && { file_id: fileId }) };
      if (view.can.override && (f.override_amount !== s(sp?.override_amount) || (f.override_amount && f.override_reason !== (sp?.override_reason ?? '')))) {
        body.override_amount = num(f.override_amount); body.override_reason = f.override_reason || null;
      }
      return sp ? api(`/inpatient/stay-payers/${sp.id}`, { method: 'PATCH', body }) : api(`/inpatient/stays/${view.stay.encounter_id}/payers`, { body: { ...body, payer_id: payerId } });
    },
    onSuccess: () => { onDone(); onClose(); },
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const g3 = { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 } as const;
  return (
    <Modal title={sp ? `გადამხდელი — ${sp.payer_name}` : 'გადამხდელის დამატება'} onClose={onClose} width={720}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="submit" form="spf" disabled={!payerId || m.isPending}>შენახვა</button></>}>
      <form id="spf" className="stack" style={{ gap: 12 }} onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 240px', gap: 12 }}>
          <Field label="გადამხდელი" htmlFor="sp-p" required><select id="sp-p" className="select" value={payerId} disabled={!!sp} onChange={(e) => pickPayer(e.target.value)} required>
            <option value="">—</option>{payers.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}{sp && !payers.data?.some((x) => x.id === sp.payer_id) && <option value={sp.payer_id}>{sp.payer_name}</option>}</select></Field>
          <Field label="რეჟიმი" htmlFor="sp-m"><select id="sp-m" className="select" value={mode} onChange={set('mode')}>{Object.entries(MODE_KA).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        </div>
        <div style={g3}>
          <Field label="დაფარვა (%)" htmlFor="sp-c"><input id="sp-c" className="input mono" type="number" min={0} max={100} step="0.01" value={f.coverage_pct} onChange={set('coverage_pct')} /></Field>
          {mode === 'percent' && <><Field label="ლიმიტი (₾)" htmlFor="sp-l" hint="ცარიელი — შეუზღუდავი"><input id="sp-l" className="input mono" inputMode="decimal" value={f.limit_amount} onChange={set('limit_amount')} /></Field>
            <Field label="ფრანშიზა (₾)" htmlFor="sp-d"><input id="sp-d" className="input mono" inputMode="decimal" value={f.deductible} onChange={set('deductible')} /></Field></>}
          {mode === 'fixed' && <Field label="თანხა (₾)" htmlFor="sp-f" required><input id="sp-f" className="input mono" inputMode="decimal" value={f.fixed_amount} onChange={set('fixed_amount')} required /></Field>}
        </div>
        {mode === 'drg' && <div className="stack" style={{ gap: 6 }}>
          <Field label="DRG ჯგუფი" htmlFor="sp-g" required hint={p?.drg_base_rate ? `საბაზისო განაკვეთი: ${money(p.drg_base_rate)}` : 'გადამხდელს განაკვეთი არ აქვს'}>
            <input id="sp-g" className="input" placeholder="კოდი ან დასახელება" value={drgQ || f.drg_code} onChange={(e) => { setDrgQ(e.target.value); setF({ ...f, drg_code: '' }); }} /></Field>
          {!f.drg_code && drgQ && <div style={{ maxHeight: 180, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 8 }}>
            {drg.data?.rows.map((g) => <button key={g.code} type="button" onClick={() => { setF({ ...f, drg_code: g.code }); setDrgQ(''); }}
              style={{ display: 'flex', width: '100%', justifyContent: 'space-between', gap: 8, padding: '6px 12px', border: 0, borderBottom: '1px solid var(--line-soft)', background: 'transparent', font: 'inherit', textAlign: 'left', cursor: 'pointer', color: 'var(--ink)' }}>
              <span><span className="mono">{g.code}</span> {g.title}</span><span className="mono small">{Number(g.relative_weight).toFixed(4)}{p?.drg_base_rate && ` → ${money(Number(g.relative_weight) * Number(p.drg_base_rate))}`}</span></button>)}
            {drg.data?.rows.length === 0 && <div className="empty">ვერ მოიძებნა.</div>}</div>}
        </div>}
        {mode !== 'percent' && <label className="row small"><input type="checkbox" checked={!!f.writeoff_excess} onChange={(e) => setF({ ...f, writeoff_excess: e.target.checked })} /> ტარიფს ზემოთ ხარჯი ჩამოიწერება (პაციენტი იხდის მხოლოდ თანაგადახდას)</label>}
        <div className="stack" style={{ gap: 6 }}><span className="small muted">არ ფარავს:</span>
          <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>{Object.keys(CAT_KA).map((c) => (
            <label key={c} className="row small"><input type="checkbox" checked={(excl ?? []).includes(c)} onChange={(e) => setExcl(e.target.checked ? [...(excl ?? []), c] : (excl ?? []).filter((x) => x !== c))} /> {CAT_KA[c]}</label>))}</div></div>
        <fieldset className="stack" style={{ gap: 10, border: '1px solid var(--line)', borderRadius: 8, padding: 12 }}>
          <legend className="small">საგარანტიო წერილი / პოლისი</legend>
          <div style={g3}>
            <Field label="საგარანტიო №" htmlFor="sp-gn"><input id="sp-gn" className="input" value={f.guarantee_no} onChange={set('guarantee_no')} /></Field>
            <Field label="თარიღი" htmlFor="sp-gd"><input id="sp-gd" className="input" type="date" value={f.guarantee_date} onChange={set('guarantee_date')} /></Field>
            <Field label="მოქმედებს —მდე" htmlFor="sp-vu"><input id="sp-vu" className="input" type="date" value={f.valid_until} onChange={set('valid_until')} /></Field>
            <Field label="პოლისის №" htmlFor="sp-po"><input id="sp-po" className="input" value={f.policy_no} onChange={set('policy_no')} /></Field>
            <div style={{ gridColumn: 'span 2' }}><Field label={sp?.file_id ? 'ფაილი (ახლით ჩანაცვლება)' : 'ფაილი (სკანი)'} htmlFor="sp-fl" hint="JPG, PNG ან PDF — ინახება პაციენტის დოკუმენტებში">
              <input id="sp-fl" className="input" style={{ padding: 8, height: 'auto' }} type="file" accept="image/jpeg,image/png,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field></div>
          </div>
        </fieldset>
        {view.can.override && <fieldset className="stack" style={{ gap: 10, border: '1px solid var(--line)', borderRadius: 8, padding: 12 }}>
          <legend className="small">ხელით შესწორება (ბილინგი)</legend>
          <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 12 }}>
            <Field label="თანხა (₾)" htmlFor="sp-oa" hint="ცარიელი — ავტომატური"><input id="sp-oa" className="input mono" inputMode="decimal" value={f.override_amount} onChange={set('override_amount')} /></Field>
            <Field label="მიზეზი" htmlFor="sp-or" required={!!f.override_amount}><input id="sp-or" className="input" value={f.override_reason} onChange={set('override_reason')} required={!!f.override_amount} /></Field>
          </div>
        </fieldset>}
        <ErrorBox error={m.error} />
      </form>
    </Modal>
  );
}

function DepositDialog({ encounterId, kind, max, onClose, onDone }: { encounterId: string; kind: 'deposit' | 'refund'; max?: number; onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState(max ? max.toFixed(2) : ''); const [method, setMethod] = useState<'cash' | 'card_terminal' | 'bank_transfer'>('cash'); const [ref, setRef] = useState(''); const [note, setNote] = useState('');
  const m = useMutation({
    mutationFn: () => api<{ id: string }>(`/inpatient/stays/${encounterId}/deposits`, { body: { kind, amount: Number(amount.replace(',', '.')), method, terminal_ref: method === 'card_terminal' ? ref : undefined, note: note || undefined } }),
    onSuccess: (d) => { onDone(); onClose(); void printBlob(`/inpatient/deposits/${d.id}/receipt`); },
  });
  return (
    <Modal title={kind === 'deposit' ? 'ავანსის მიღება' : 'თანხის დაბრუნება'} onClose={onClose} width={480}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="submit" form="dpf" disabled={!(Number(amount) > 0) || m.isPending}>{kind === 'deposit' ? 'მიღება და ქვითარი' : 'დაბრუნება და ქვითარი'}</button></>}>
      <form id="dpf" className="stack" style={{ gap: 12 }} onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <Field label="თანხა (₾)" htmlFor="dp-a" required hint={max ? `მაქს. ${money(max)}` : undefined}><input id="dp-a" className="input mono" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus /></Field>
        <Field label="მეთოდი" htmlFor="dp-m"><select id="dp-m" className="select" value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
          <option value="cash">ნაღდი</option><option value="card_terminal">ბარათი (ტერმინალი)</option><option value="bank_transfer">გადარიცხვა</option></select></Field>
        {method === 'card_terminal' && <Field label="ტრანზაქციის №" htmlFor="dp-r" required><input id="dp-r" className="input mono" value={ref} onChange={(e) => setRef(e.target.value)} required /></Field>}
        <Field label="შენიშვნა" htmlFor="dp-n"><input id="dp-n" className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <ErrorBox error={m.error} />
      </form>
    </Modal>
  );
}

function DaysDialog({ b, onClose }: { b: BillingView; onClose: () => void }) {
  return (
    <Modal title={`საწოლდღეები — ${b.bed_days_count}`} onClose={onClose} width={720} footer={<button className="btn" type="button" onClick={onClose}>დახურვა</button>}>
      <span className="hint">დღე = ღამე, რომელიც ამ თარიღზე დაიწყო (აღრიცხვა შუაღამით). ტარიფი — შუაღამის საწოლის ტიპით.</span>
      <table className="table">
        <thead><tr><th>თარიღი</th><th>განყოფილება</th><th>საწოლი</th><th>ტარიფი</th>{b.amounts_visible && <th className="num">ფასი</th>}</tr></thead>
        <tbody>{b.bed_days.map((d) => (
          <tr key={d.day}><td>{dateGe(d.day)}{d.minimum && <div className="small muted">მინიმუმი (შუაღამე არ გადაკვეთა)</div>}{d.on_leave && <div className="small muted">დროებით გასული</div>}</td>
            <td className="small">{d.department_name}</td><td className="small">{d.bed_code ?? '—'} · {d.bed_type_name}</td>
            <td className="small">{d.tariff_title ?? <span className="chip warn">ტარიფი არ არის</span>}{d.package_included && <span className="chip accent" style={{ marginLeft: 6 }}>პაკეტში</span>}</td>
            {b.amounts_visible && <td className="num">{d.price ? money(d.price) : '—'}</td>}</tr>))}</tbody>
      </table>
    </Modal>
  );
}

// ================================================================= სამუშაო სია (სტაციონარი → ბილინგი)
interface WorkRow { encounter_id: string; adm_no: string; status: string; admitted_at: string; ended_at: string | null; first_name: string; last_name: string; personal_number: string | null;
  invoice_number: string; finalized_at: string | null; package_name: string | null; department_name: string | null; payer_names: string[]; money: Money | null }
export function BillingWorklist() {
  const { user } = useAuth();
  const [status, setStatus] = useState('active');
  const q = useQuery({ queryKey: ['ipd-billing-list', status], queryFn: () => api<WorkRow[]>('/inpatient/billing/worklist', { query: { status } }), refetchInterval: 60_000 });
  const rows = q.data ?? [];
  const sum = (k: keyof Money) => rows.reduce((s, r) => s + n(r.money?.[k]), 0);
  return (
    <div className="content">
      <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
        {([['active', 'აქტიური'], ['unfinalized', 'გაწერილი — დასახურია'], ['due', 'დავალიანება'], ['finalized', 'ფინალიზებული (30 დღე)']] as const).map(([k, l]) => (
          <button key={k} type="button" className={`btn sm${status === k ? ' primary' : ''}`} onClick={() => setStatus(k)}>{l}</button>))}
        <span className="grow" />
        {can(user, 'admin', 'billing') && <Link className="btn sm" to="/admin/billing">ცნობარები</Link>}
      </div>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : (
        <div className="card">
          <table className="table">
            <thead><tr><th>პაციენტი</th><th>განყოფილება</th><th>პერიოდი</th><th>პაკეტი / გადამხდელი</th><th className="num">ჯამი</th><th className="num">გადამხდელი</th><th className="num">პაციენტი</th><th className="num">ავანსი</th><th className="num">გადასახდელი</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.encounter_id}>
                <td><Link to={`/inpatient/stay/${r.encounter_id}#billing`}><strong>{r.last_name} {r.first_name}</strong></Link><div className="small muted mono">{r.adm_no} · {r.invoice_number}</div></td>
                <td className="small">{r.department_name}</td>
                <td className="small">{tsDate(r.admitted_at)} — {r.ended_at ? tsDate(r.ended_at) : 'მიმდინარე'}</td>
                <td className="small">{r.package_name && <div>{r.package_name}</div>}{r.payer_names.join(', ') || (r.package_name ? '' : 'თვითდაფინანსება')}</td>
                <td className="num" style={{ whiteSpace: 'nowrap' }}>{money(r.money?.total)}</td><td className="num" style={{ whiteSpace: 'nowrap' }}>{money(n(r.money?.insurance) + n(r.money?.state))}</td>
                <td className="num" style={{ whiteSpace: 'nowrap' }}>{money(r.money?.patient)}</td><td className="num" style={{ whiteSpace: 'nowrap' }}>{money(r.money?.deposit_net)}</td>
                <td className="num" style={{ whiteSpace: 'nowrap' }}><strong style={{ color: n(r.money?.due) > 0 ? 'var(--warn, #b26a00)' : undefined }}>{money(r.money?.due)}</strong>
                  {n(r.money?.refund_due) > 0 && <div className="small">დასაბრ. {money(r.money?.refund_due)}</div>}</td>
              </tr>))}
              {rows.length === 0 && <tr><td colSpan={9} className="empty">ჩანაწერი არ არის.</td></tr>}</tbody>
            {rows.length > 0 && <tfoot><tr><td colSpan={4}><strong>ჯამი ({rows.length})</strong></td><td className="num" style={{ whiteSpace: 'nowrap' }}>{money(sum('total'))}</td><td className="num" style={{ whiteSpace: 'nowrap' }}>{money(sum('insurance') + sum('state'))}</td>
              <td className="num" style={{ whiteSpace: 'nowrap' }}>{money(sum('patient'))}</td><td className="num" style={{ whiteSpace: 'nowrap' }}>{money(sum('deposit_net'))}</td><td className="num" style={{ whiteSpace: 'nowrap' }}><strong>{money(sum('due'))}</strong></td></tr></tfoot>}
          </table>
        </div>
      )}
      {can(user, 'admin', 'billing', 'manager') && <BillingReport />}
    </div>
  );
}

function BillingReport() {
  const { user } = useAuth();
  const [from, setFrom] = useState(shiftDay(todayISO(), -30)); const [to, setTo] = useState(todayISO()); const [payer, setPayer] = useState('');
  const q = useQuery({ queryKey: ['ipd-billing-report', from, to], queryFn: () => api<{ departments: { department: string; stays: number; bed_days: number; total: string; covered: string; patient: string; writeoff: string }[];
    payers: { payer_id: string; payer: string; kind_ka: string; stays: number; covered: string }[]; totals: { stays: number; bed_days: number; total: string; covered: string; patient: string; writeoff: string } }>('/inpatient/billing/report', { query: { from, to } }) });
  const payers = useQuery({ queryKey: ['payers', true], queryFn: () => api<Payer[]>('/billing/payers', { query: { include_inactive: true } }), enabled: can(user, 'admin', 'billing') });
  const dl = useMutation({
    mutationFn: async () => {
      const blob = await api<Blob>(`/inpatient/billing/register/${payer}`, { query: { from, to }, raw: true });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `register-${payers.data?.find((p) => p.id === payer)?.code ?? 'payer'}-${from}-${to}.csv`; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    },
  });
  const r = q.data;
  return (
    <section className="card card-pad stack">
      <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <h2 style={{ margin: 0 }} className="grow">რეპორტი (ფინალიზებული შემთხვევები)</h2>
        <Field label="დან" htmlFor="br-f"><input id="br-f" className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="მდე" htmlFor="br-t"><input id="br-t" className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      <ErrorBox error={q.error} />
      {r && <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 3fr) minmax(0, 2fr)', gap: 16 }}>
        <table className="table">
          <thead><tr><th>განყოფილება</th><th className="num">შემთხვ.</th><th className="num">საწოლდღე</th><th className="num">ჯამი</th><th className="num">გადამხდელი</th><th className="num">პაციენტი</th><th className="num">ჩამოწერა</th></tr></thead>
          <tbody>{r.departments.map((d) => <tr key={d.department}><td>{d.department}</td><td className="num">{d.stays}</td><td className="num">{d.bed_days}</td><td className="num">{money(d.total)}</td>
            <td className="num">{money(d.covered)}</td><td className="num">{money(d.patient)}</td><td className="num">{money(d.writeoff)}</td></tr>)}
            {r.departments.length === 0 && <tr><td colSpan={7} className="empty">პერიოდში ფინალიზებული შემთხვევა არ არის.</td></tr>}</tbody>
          {r.departments.length > 0 && <tfoot><tr><td><strong>ჯამი</strong></td><td className="num">{r.totals.stays}</td><td className="num">{r.totals.bed_days}</td><td className="num"><strong>{money(r.totals.total)}</strong></td>
            <td className="num">{money(r.totals.covered)}</td><td className="num">{money(r.totals.patient)}</td><td className="num">{money(r.totals.writeoff)}</td></tr></tfoot>}
        </table>
        <table className="table">
          <thead><tr><th>გადამხდელი</th><th className="num">შემთხვ.</th><th className="num">თანხა</th></tr></thead>
          <tbody>{r.payers.map((p) => <tr key={p.payer_id}><td>{p.payer}<div className="small muted">{p.kind_ka}</div></td><td className="num">{p.stays}</td><td className="num">{money(p.covered)}</td></tr>)}
            {r.payers.length === 0 && <tr><td colSpan={3} className="empty">—</td></tr>}</tbody>
        </table>
      </div>}
      {can(user, 'admin', 'billing') && <div className="row" style={{ gap: 10, alignItems: 'flex-end' }}>
        <Field label="გადამხდელის რეესტრი (CSV / Excel)" htmlFor="br-p"><select id="br-p" className="select" value={payer} onChange={(e) => setPayer(e.target.value)} style={{ minWidth: 280 }}>
          <option value="">—</option>{payers.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
        <button className="btn" type="button" disabled={!payer || dl.isPending} onClick={() => dl.mutate()}>ჩამოტვირთვა</button>
        <ErrorBox error={dl.error} />
      </div>}
    </section>
  );
}
