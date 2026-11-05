import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { ErrorBox, Field, Loading, Modal } from '../../components/ui';
import { tsDate } from '../../lib/format';

/**
 * 0091 — ER-ის ბარათის ჩანართი „ანგარიში“: ინვოისის ხაზები (ER-ის ტარიფი, კვლევა, მედიკამენტი, კონსულტაცია), გადამხდელი, გადახდები, ნაშთი;
 * ტარიფის წინასწარი გათვლა (მიმდინარე შემთხვევაზე); დახურვა / გახსნა (ბილინგი); გადახდა / გადამხდელი — სალაროში.
 */
interface Line { id: string; description: string; category: string; quantity: number; unit_price: string; line_total: string | null; package_included: boolean; er_fee_rule_id: string | null;
  service_date: string; moved: boolean }
interface Billing {
  invoice: { id: string; number: string; finalized_at: string | null; total: string; patient_share: string; insurance_share: string; state_share: string; paid: string; due: string;
    paid_status: string; in_claim: boolean; insurance_payer: { name: string } | null; state_payer: { name: string } | null;
    merged_into: { invoice_number: string; encounter_id: string; adm_no: string } | null };
  lines: Line[]; payments: { id: string; amount: string; method: string; paid_at: string }[];
  fee: { mode: string; at: string; lines: { description: string; quantity: number; code: string }[]; note: string | null; estimate: boolean };
  settings: { invoice_close: string; admit_invoice: string; opd_payer_mode: string };
  can: { close: boolean; open: boolean; pay: boolean; payers: boolean };
}
const CAT_KA: Record<string, string> = { service: 'მომსახურება', consult: 'კონსულტაცია', lab: 'ლაბორატორია', radiology: 'რადიოლოგია', endoscopy: 'ენდოსკოპია', medication: 'მედიკამენტი',
  supply: 'სახარჯი', implant: 'იმპლანტი', other: 'სხვა' };
const METHOD_KA: Record<string, string> = { cash: 'ნაღდი', card_terminal: 'ბარათი', bank_transfer: 'გადარიცხვა', deposit: 'ავანსი' };
const money = (v: string | number | null | undefined) => `${Number(v ?? 0).toFixed(2)} ₾`;

export function ErBillingPanel({ encounterId }: { encounterId: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['er-billing', encounterId], queryFn: () => api<Billing>(`/er/visits/${encounterId}/billing`) });
  const [openDlg, setOpenDlg] = useState(false);
  const inv = () => { void qc.invalidateQueries({ queryKey: ['er-billing', encounterId] }); void qc.invalidateQueries({ queryKey: ['invoice'] }); };
  const close = useMutation({ mutationFn: () => api(`/er/visits/${encounterId}/billing/close`, { body: {} }), onSuccess: inv });
  if (q.isLoading) return <Loading />;
  if (!q.data) return <ErrorBox error={q.error} />;
  const { invoice: i, lines, payments, fee, can } = q.data;
  const status = i.merged_into ? 'გაერთიანებულია სტაციონარისაში' : i.finalized_at ? 'დახურულია' : 'ღიაა';
  return (
    <div className="stack" style={{ gap: 12 }} data-testid="er-billing">
      <section className="card card-pad stack" style={{ gap: 8 }}>
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <div><strong className="mono">{i.number}</strong> · <span className={`chip ${i.merged_into ? 'info' : i.finalized_at ? 'ok' : ''}`} data-testid="er-billing-status">{status}</span>
            {i.in_claim && <span className="chip warn" style={{ marginLeft: 6 }}>ქლეიმში</span>}</div>
          <div className="row" style={{ gap: 6 }}>
            {(can.pay || can.payers) && <Link className="btn sm" to={`/cashier/${encounterId}`}>სალარო (გადახდა / გადამხდელი)</Link>}
            {can.close && <button className="btn sm" type="button" disabled={close.isPending} onClick={() => close.mutate()}>ინვოისის დახურვა</button>}
            {can.open && <button className="btn sm" type="button" onClick={() => setOpenDlg(true)}>გახსნა</button>}
          </div>
        </div>
        {i.merged_into && <div className="alert info small">ხაზები გადავიდა სტაციონარის ინვოისში <span className="mono">{i.merged_into.invoice_number}</span> —{' '}
          <Link to={`/inpatient/stay/${i.merged_into.encounter_id}#billing`}>{i.merged_into.adm_no} → ბილინგი</Link></div>}
        <div className="small">გადამხდელი: {i.insurance_payer?.name ?? '—'}{i.state_payer && ` · სახელმწიფო: ${i.state_payer.name}`} · წილი — {q.data.settings.opd_payer_mode === 'rules' ? 'წესებით' : 'ხელით (სალარო)'}</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: 8 }} className="small">
          <div>ჯამი<br /><strong className="mono">{money(i.total)}</strong></div>
          <div>დაზღვევა<br /><strong className="mono">{money(i.insurance_share)}</strong></div>
          <div>სახელმწიფო<br /><strong className="mono">{money(i.state_share)}</strong></div>
          <div>გადახდილი<br /><strong className="mono">{money(i.paid)}</strong></div>
          <div>ნაშთი<br /><strong className="mono" data-testid="er-billing-due" style={{ color: Number(i.due) > 0 ? 'var(--danger)' : undefined }}>{money(i.due)}</strong></div>
        </div>
      </section>
      <section className="card card-pad stack" style={{ gap: 6 }}>
        <span className="label">ER-ის ტარიფი {fee.estimate && <span className="muted">— წინასწარი (თუ ახლა გაეწერება სახლში)</span>}</span>
        {fee.lines.length ? fee.lines.map((l, k) => <div key={k} className="small"><span className="mono">{l.code}</span> {l.description}{l.quantity > 1 ? ` × ${l.quantity}` : ''}</div>)
          : <div className="small muted">{fee.note ?? '—'}</div>}
      </section>
      <section className="card card-pad stack" style={{ gap: 6 }}>
        <span className="label">ხაზები</span>
        <table className="table"><thead><tr><th>თარიღი</th><th>დასახელება</th><th>კატეგორია</th><th className="num">რაოდ.</th><th className="num">ფასი</th><th className="num">ჯამი</th></tr></thead>
          <tbody>{lines.map((l) => <tr key={l.id} style={{ opacity: l.moved ? 0.6 : 1 }}><td className="mono small">{l.service_date}</td>
            <td className="small">{l.description}{l.er_fee_rule_id && <span className="chip info" style={{ marginLeft: 6 }}>ER-ის ტარიფი</span>}{l.moved && <span className="chip" style={{ marginLeft: 6 }}>სტაციონარში</span>}
              {l.package_included && <span className="chip" style={{ marginLeft: 6 }}>პაკეტში</span>}</td>
            <td className="small">{CAT_KA[l.category] ?? l.category}</td><td className="num mono">{l.quantity}</td><td className="num mono">{Number(l.unit_price).toFixed(2)}</td>
            <td className="num mono">{Number(l.line_total ?? 0).toFixed(2)}</td></tr>)}
            {!lines.length && <tr><td colSpan={6} className="muted">ხაზი ჯერ არ არის</td></tr>}</tbody></table>
        {payments.length > 0 && <><span className="label">გადახდები</span>
          {payments.map((p) => <div key={p.id} className="small">{tsDate(p.paid_at)} · {METHOD_KA[p.method] ?? p.method} · <span className="mono">{money(p.amount)}</span></div>)}</>}
      </section>
      <ErrorBox error={close.error} />
      {openDlg && <OpenDialog encounterId={encounterId} onClose={() => { setOpenDlg(false); inv(); }} />}
    </div>
  );
}

function OpenDialog({ encounterId, onClose }: { encounterId: string; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const m = useMutation({ mutationFn: () => api(`/er/visits/${encounterId}/billing/open`, { body: { reason: reason.trim() } }), onSuccess: onClose });
  return (
    <Modal title="ER-ის ინვოისის გახსნა" onClose={onClose} width={460}
      footer={<><button className="btn" type="button" onClick={onClose}>დახურვა</button><button className="btn primary" type="button" disabled={reason.trim().length < 3 || m.isPending} onClick={() => m.mutate()}>გახსნა</button></>}>
      <Field label="მიზეზი" htmlFor="eb-r" required><input id="eb-r" className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <ErrorBox error={m.error} />
    </Modal>
  );
}
