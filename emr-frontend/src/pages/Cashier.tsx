import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { can, api } from '../api/client';
import type { EncounterDetail, EncounterListItem, Invoice, InvoiceLine } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { ErrorBox, Field, Loading, Modal, StatusChip, useToast } from '../components/ui';
import { hhmm, money, todayISO, tsDate } from '../lib/format';

export default function Cashier() {
  const { encounterId } = useParams();
  const nav = useNavigate();
  const list = useQuery({
    queryKey: ['encounters', 'cashier', todayISO()],
    queryFn: () => api<EncounterListItem[]>('/encounters', { query: { status: 'planned,active,discharged', date: todayISO() } }),
    refetchInterval: 20_000,
  });
  const payable = (list.data ?? []).filter((e) => e.status === 'planned' || Number(e.patient_share ?? 0) - Number(e.paid_amount) > 0);
  // 0046: სტაციონარი — ფინალიზებული, გადაუხდელი (ავანსი — ჰოსპიტალიზაციის გვერდზე)
  const ipd = useQuery({ queryKey: ['ipd-billing-list', 'due'], queryFn: () => api<{ encounter_id: string; first_name: string; last_name: string; adm_no: string; money: { due: string } | null }[]>('/inpatient/billing/worklist', { query: { status: 'due' } }), refetchInterval: 60_000, retry: false });

  return (
    <>
      <header className="topbar"><h1 className="grow">სალარო</h1><span className="muted">{payable.length} გადასახდელი დღეს</span></header>
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <nav aria-label="გადასახდელი ვიზიტები" style={{ width: 300, flexShrink: 0, borderRight: '1px solid var(--line)', background: 'var(--surface)', overflow: 'auto' }}>
          <ErrorBox error={list.error} />
          {list.isLoading && <Loading />}
          {list.data && payable.length === 0 && <div className="empty">გადასახდელი ინვოისი არ არის.</div>}
          {(ipd.data ?? []).length > 0 && <div className="small muted" style={{ padding: '10px 18px 4px' }}>სტაციონარი — დავალიანება</div>}
          {(ipd.data ?? []).map((r) => (
            <button key={r.encounter_id} type="button" onClick={() => nav(`/cashier/${r.encounter_id}`)}
              style={{ width: '100%', display: 'flex', justifyContent: 'space-between', gap: 8, padding: '12px 18px', border: 0, borderBottom: '1px solid var(--line-soft)', background: r.encounter_id === encounterId ? 'var(--accent-weak)' : 'transparent', textAlign: 'left', font: 'inherit', cursor: 'pointer', color: 'var(--ink)' }}>
              <span className="stack" style={{ gap: 2 }}><strong>{r.first_name} {r.last_name}</strong><span className="small muted">სტაციონარი · {r.adm_no}</span></span>
              <span className="mono" style={{ fontWeight: 600 }}>{Number(r.money?.due ?? 0).toFixed(2)}</span>
            </button>))}
          <Link to="/inpatient?tab=billing" className="small" style={{ display: 'block', padding: '10px 18px' }}>სტაციონარი: ავანსები, ბილინგი →</Link>
          {payable.length > 0 && (ipd.data ?? []).length > 0 && <div className="small muted" style={{ padding: '10px 18px 4px' }}>ამბულატორია / დიაგნოსტიკა</div>}
          {payable.map((e) => {
            const due = Number(e.patient_share ?? 0) - Number(e.paid_amount);
            const on = e.id === encounterId;
            return (
              <button key={e.id} type="button" onClick={() => nav(`/cashier/${e.id}`)}
                style={{ width: '100%', display: 'flex', justifyContent: 'space-between', gap: 8, padding: '14px 18px', border: 0, borderBottom: '1px solid var(--line-soft)', background: on ? 'var(--accent-weak)' : 'transparent', textAlign: 'left', font: 'inherit', cursor: 'pointer', color: 'var(--ink)' }}>
                <span className="stack" style={{ gap: 2 }}>
                  <strong>{e.patient_first_name} {e.patient_last_name}</strong>
                  <span className="small muted">{e.visit_kind === 'lab' ? 'ლაბორატორია' : e.status === 'planned' ? 'საწყისი' : 'დამატებითი'} · {e.visit_kind === 'lab' ? 'ანალიზები' : e.doctor_name} · {hhmm(e.start_time)}</span>
                </span>
                <span className="mono" style={{ fontWeight: 600 }}>{due.toFixed(2)}</span>
              </button>
            );
          })}
        </nav>
        <main style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
          {encounterId ? <InvoicePanel key={encounterId} encounterId={encounterId} /> : <div className="empty">აირჩიეთ ვიზიტი სიიდან.</div>}
        </main>
      </div>
    </>
  );
}

function InvoicePanel({ encounterId }: { encounterId: string }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const toast = useToast();
  const enc = useQuery({ queryKey: ['encounter', encounterId], queryFn: () => api<EncounterDetail>(`/encounters/${encounterId}`) });
  const inv = useQuery({ queryKey: ['invoice', encounterId], queryFn: () => api<Invoice>(`/invoices/encounter/${encounterId}`) });
  const [method, setMethod] = useState<'cash' | 'card_terminal' | 'bank_transfer'>('cash');
  const [amount, setAmount] = useState('');
  const [ref, setRef] = useState('');
  const [editLine, setEditLine] = useState<InvoiceLine | null>(null);
  const [payersOpen, setPayersOpen] = useState(false);
  const due = inv.data ? Number(inv.data.balance_due ?? 0) : 0;
  useEffect(() => { if (inv.data) setAmount(Math.max(0, Number(inv.data.balance_due ?? 0)).toFixed(2)); }, [inv.data]);

  const refresh = () => ['invoice', 'encounter', 'encounters'].forEach((k) => void qc.invalidateQueries({ queryKey: [k] }));
  const planned = enc.data?.status === 'planned';
  const isLab = enc.data?.visit_kind === 'lab';
  const pay = useMutation({
    mutationFn: () => {
      const body = { amount: Number(amount), method, terminal_ref: method === 'card_terminal' ? ref : undefined };
      if (planned) return api(`/encounters/${encounterId}/pay-initial`, { body: due > 0 ? body : {} });
      return api(`/invoices/${inv.data!.id}/payments`, { body });
    },
    onSuccess: () => { toast.show(planned ? (isLab ? 'გადახდა მიღებულია — პაციენტი სისხლის ასაღებად' : 'გადახდა მიღებულია — პაციენტი ექიმთან გადაიგზავნა') : 'გადახდა მიღებულია'); setRef(''); refresh(); },
  });
  const submit = (e: FormEvent) => { e.preventDefault(); pay.mutate(); };

  if (enc.isLoading || inv.isLoading) return <Loading />;
  if (enc.error || inv.error) return <div className="content"><ErrorBox error={enc.error ?? inv.error} /></div>;
  const e = enc.data!; const i = inv.data!;
  const canAdjust = can(user, 'admin') || can(user, 'billing');
  const ipdOpen = !!i.is_inpatient && !i.finalized_at;
  const cardNeedsRef = method === 'card_terminal' && !ref.trim();

  return (
    <div style={{ display: 'flex', minHeight: '100%' }}>
      <div className="content grow">
        <div className="row-top">
          <div className="stack grow" style={{ gap: 4 }}>
            <div className="row"><h1>{e.patient.first_name} {e.patient.last_name}</h1><StatusChip status={i.paid_status} /></div>
            <span className="muted"><span className="mono">{i.invoice_number}</span> · {e.doctor ? `${e.doctor.first_name} ${e.doctor.last_name}` : 'დიაგნოსტიკური ვიზიტი'}{e.external_referral ? ` · მიმართვა: ${e.external_referral}` : ''} · {tsDate(e.start_time)} · ვიზიტი: <StatusChip status={e.status} /></span>
          </div>
          <Link className="btn sm" to={`/patients/${e.patient.id}`}>ბარათი</Link>
        </div>

        <section className="card">
          <table className="table">
            <thead><tr><th>მომსახურება</th><th className="num">ტარიფი</th><th className="num">ფასი</th><th className="num">რაოდ.</th><th className="num">ჯამი</th><th /></tr></thead>
            <tbody>
              {i.lines.map((l) => (
                <tr key={l.id}>
                  <td><strong>{l.description}</strong>{l.package_included && <span className="chip accent" style={{ marginLeft: 6 }}>პაკეტში</span>}{l.discount_reason && <div className="small muted">ფასდაკლება: {l.discount_reason}</div>}</td>
                  <td className="num muted">{l.original_price ?? '—'}</td>
                  <td className="num">{l.unit_price}</td>
                  <td className="num">{l.quantity}</td>
                  <td className="num" style={{ fontWeight: 600, ...(l.package_included && { textDecoration: 'line-through', color: 'var(--muted)' }) }}>{l.line_total}</td>
                  <td style={{ textAlign: 'right' }}>{canAdjust && !i.finalized_at && <button className="btn sm" type="button" onClick={() => setEditLine(l)}>ფასდაკლება</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {editLine && <DiscountForm invoiceId={i.id} line={editLine} onDone={() => { setEditLine(null); refresh(); }} />}
        </section>

        <section className="card card-pad stack">
          <h2>გადახდები</h2>
          {i.payments.length === 0 ? <span className="muted">გადახდა ჯერ არ მიღებულა.</span> : (
            <table className="table">
              <tbody>{i.payments.map((p) => <tr key={p.id}><td className="mono">{tsDate(p.paid_at)} {hhmm(p.paid_at)}</td><td>{({ cash: 'ნაღდი', card_terminal: 'ბარათი', bank_transfer: 'გადარიცხვა' } as Record<string, string>)[p.method]}{p.terminal_ref ? ` · ${p.terminal_ref}` : ''}</td><td className="num">{money(p.amount)}</td></tr>)}</tbody>
            </table>
          )}
          {e.payment_override && <div className="alert warn">გააქტიურებულია გადახდის გარეშე: {e.payment_override.reason}</div>}
        </section>
      </div>

      <form onSubmit={submit} style={{ width: 360, flexShrink: 0, background: 'var(--surface)', borderLeft: '1px solid var(--line)', padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="stack" style={{ gap: 6 }}>
          <Line k="ჯამი" v={money(i.total_amount)} />
          <Line k="დაზღვევა" v={money(i.insurance_share)} muted />
          {i.insurance_payer_name && <span className="small muted" style={{ marginTop: -4 }}>{i.insurance_payer_name}</span>}
          <Line k="სახელმწიფო" v={money(i.state_share)} muted />
          {i.state_payer_name && <span className="small muted" style={{ marginTop: -4 }}>{i.state_payer_name}</span>}
          {!i.is_inpatient && can(user, 'admin', 'billing', 'receptionist') && (i.claim_nos
            ? <span className="small muted">ქლეიმში: {i.claim_nos} — გადამხდელი აღარ იცვლება</span>
            : <button className="btn sm" type="button" style={{ alignSelf: 'flex-start' }} onClick={() => setPayersOpen(true)}>დაზღვევა / სახელმწიფო</button>)}
          {Number(i.writeoff_amount ?? 0) > 0 && <Line k="ჩამოწერა" v={money(i.writeoff_amount)} muted />}
          <Line k="გადახდილი" v={money(i.paid_amount)} muted />
          <div className="row" style={{ justifyContent: 'space-between', borderTop: '1px solid var(--line)', paddingTop: 12, marginTop: 4 }}>
            <strong>გადასახდელი</strong><span className="mono" style={{ fontSize: 26, fontWeight: 600 }}>{money(due)}</span>
          </div>
        </div>
        {ipdOpen && <div className="alert info">სტაციონარი: ფინანსურ დახურვამდე თანხა მიიღება ავანსად — <Link to={`/inpatient/stay/${encounterId}#billing`}>ჰოსპიტალიზაცია → ბილინგი</Link>.</div>}
        {!ipdOpen && (due > 0 || planned) && (<>
          {due > 0 && <>
            <div className="field">
              <span className="label">გადახდის მეთოდი</span>
              <div className="seg" role="group" aria-label="მეთოდი">
                <button type="button" aria-pressed={method === 'cash'} onClick={() => setMethod('cash')}>ნაღდი</button>
                <button type="button" aria-pressed={method === 'card_terminal'} onClick={() => setMethod('card_terminal')}>ბარათი</button>
                <button type="button" aria-pressed={method === 'bank_transfer'} onClick={() => setMethod('bank_transfer')}>გადარიცხვა</button>
              </div>
            </div>
            <Field label="თანხა" htmlFor="amt" hint={planned ? 'ნაწილობრივი გადახდაც ააქტიურებს ვიზიტს' : undefined}>
              <input id="amt" className="input mono" style={{ fontSize: 20, fontWeight: 600, height: 48 }} inputMode="decimal" value={amount} onChange={(x) => setAmount(x.target.value)} />
            </Field>
            {method === 'card_terminal' && (
              <Field label="ტერმინალის ტრანზაქციის №" htmlFor="ref" required>
                <input id="ref" className="input mono" value={ref} onChange={(x) => setRef(x.target.value)} placeholder="ქვითრიდან" />
              </Field>
            )}
          </>}
          <ErrorBox error={pay.error} />
          <button className="btn primary lg" type="submit" disabled={pay.isPending || (due > 0 && (!(Number(amount) > 0) || cardNeedsRef))}>
            {planned ? (isLab ? (due > 0 ? 'გადახდა → სისხლის აღება' : 'გაგზავნა სისხლის ასაღებად') : (due > 0 ? 'გადახდა და ექიმთან გაგზავნა' : 'ექიმთან გაგზავნა')) : 'გადახდის მიღება'}
          </button>
          {planned && <span className="hint" style={{ textAlign: 'center' }}>გადახდის გარეშე გააქტიურება — მხოლოდ ექიმი ან ადმინისტრატორი</span>}
        </>)}
        {!ipdOpen && !planned && due <= 0 && <div className="alert ok">ინვოისი სრულად გადახდილია.</div>}
      </form>
      {payersOpen && <PayersDialog invoice={i} onClose={() => setPayersOpen(false)} onDone={() => { setPayersOpen(false); toast.show('გადამხდელი შენახულია'); refresh(); }} />}
      {toast.node}
    </div>
  );
}

interface PayerOpt { id: string; code: string; name: string; kind: 'insurance' | 'state' | 'other' }
/** 0053: ამბულატორიის ინვოისის გადამხდელი და წილი (ხელით) — ქლეიმისა და შემოსავლის რეპორტისთვის */
function PayersDialog({ invoice, onClose, onDone }: { invoice: Invoice; onClose: () => void; onDone: () => void }) {
  const payers = useQuery({ queryKey: ['payers', false], queryFn: () => api<PayerOpt[]>('/billing/payers') });
  const [f, setF] = useState({ insurance_payer_id: invoice.insurance_payer_id ?? '', insurance_share: Number(invoice.insurance_share).toFixed(2),
    state_payer_id: invoice.state_payer_id ?? '', state_share: Number(invoice.state_share).toFixed(2) });
  const m = useMutation({
    mutationFn: () => api(`/invoices/${invoice.id}/payers`, { method: 'PUT', body: { insurance_payer_id: f.insurance_payer_id || null, insurance_share: Number(f.insurance_share || 0),
      state_payer_id: f.state_payer_id || null, state_share: Number(f.state_share || 0) } }),
    onSuccess: onDone,
  });
  const patient = Number(invoice.total_amount) - Number(f.insurance_share || 0) - Number(f.state_share || 0);
  const ins = (payers.data ?? []).filter((p) => p.kind !== 'state'); const st = (payers.data ?? []).filter((p) => p.kind === 'state');
  return (
    <Modal title={`გადამხდელები — ${invoice.invoice_number}`} onClose={onClose} width={600}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={m.isPending || patient < -0.001} onClick={() => m.mutate()}>შენახვა</button></>}>
      <div className="stack">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 140px', gap: 12 }}>
          <Field label="დაზღვევა" htmlFor="ip-i"><select id="ip-i" className="select" value={f.insurance_payer_id} onChange={(e) => setF({ ...f, insurance_payer_id: e.target.value })}>
            <option value="">— არ არის —</option>{ins.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
          <Field label="წილი (₾)" htmlFor="ip-is"><input id="ip-is" className="input mono" inputMode="decimal" value={f.insurance_share} onChange={(e) => setF({ ...f, insurance_share: e.target.value })} /></Field>
          <Field label="სახელმწიფო პროგრამა" htmlFor="ip-s"><select id="ip-s" className="select" value={f.state_payer_id} onChange={(e) => setF({ ...f, state_payer_id: e.target.value })}>
            <option value="">— არ არის —</option>{st.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
          <Field label="წილი (₾)" htmlFor="ip-ss"><input id="ip-ss" className="input mono" inputMode="decimal" value={f.state_share} onChange={(e) => setF({ ...f, state_share: e.target.value })} /></Field>
        </div>
        <Line k="ინვოისი" v={money(invoice.total_amount)} />
        <Line k="პაციენტის წილი" v={money(Math.max(0, patient))} />
        {patient < -0.001 && <div className="alert danger">წილების ჯამი აღემატება ინვოისის თანხას</div>}
        <span className="hint">წილი ივსება ხელით (საგარანტიო / პოლისის პირობებით). გადამხდელის მითითება საჭიროა ქლეიმისთვის (ფინანსები → დებიტორები).</span>
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}

const Line = ({ k, v, muted }: { k: string; v: string; muted?: boolean }) => (
  <div className="row" style={{ justifyContent: 'space-between', color: muted ? 'var(--muted)' : undefined }}><span>{k}</span><span className="mono">{v}</span></div>
);

function DiscountForm({ invoiceId, line, onDone }: { invoiceId: string; line: InvoiceLine; onDone: () => void }) {
  const [price, setPrice] = useState(line.unit_price);
  const [reason, setReason] = useState(line.discount_reason ?? '');
  const lower = line.original_price !== null && Number(price) < Number(line.original_price);
  const m = useMutation({
    mutationFn: () => api(`/invoices/${invoiceId}/lines/${line.id}`, { method: 'PATCH', body: { unit_price: Number(price), discount_reason: reason || undefined } }),
    onSuccess: onDone,
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); m.mutate(); }} style={{ padding: 14, background: 'var(--surface-2)', borderTop: '1px solid var(--line-soft)', display: 'grid', gridTemplateColumns: '150px 1fr auto auto', gap: 12, alignItems: 'end' }}>
      <Field label={`ახალი ფასი (${line.description})`} htmlFor="np"><input id="np" className="input mono" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} /></Field>
      <Field label="დასაბუთება" htmlFor="dr" required={lower} error={lower && !reason.trim() ? 'ფასდაკლებას დასაბუთება სჭირდება' : undefined}>
        <input id="dr" className={`input${lower && !reason.trim() ? ' invalid' : ''}`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="მაგ. სოციალური შეღავათი" />
      </Field>
      <button className="btn" type="button" onClick={onDone}>გაუქმება</button>
      <button className="btn primary" type="submit" disabled={m.isPending || (lower && !reason.trim())}>შენახვა</button>
      <div style={{ gridColumn: '1 / -1' }}><ErrorBox error={m.error} /></div>
    </form>
  );
}
