import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { ErrorBox, Field, Loading, Modal, useToast } from '../../components/ui';
import { age, genderShort } from '../../lib/format';
import { OrderBadges, orderDateTime, orderSummary, type Order } from '../inpatient/Orders';

/** აფთიაქი → დანიშნულებების ვერიფიკაცია (0042): დადასტურება (შენიშვნით, აფთიაქიდან გაცემის მოთხოვნით) / უარყოფა */
export default function Verification() {
  const qc = useQueryClient(); const toast = useToast();
  const [status, setStatus] = useState<'pending' | 'done'>('pending');
  const q = useQuery({ queryKey: ['pharm-verify', status], queryFn: () => api<(Order & { birth_date: string; gender: string })[]>('/pharmacy/verification', { query: { status } }), refetchInterval: 60_000 });
  const [sel, setSel] = useState<{ o: Order; ok: boolean } | null>(null);
  return (
    <div className="content">
      {toast.node}
      <div className="row">
        <div className="seg" role="group" aria-label="სტატუსი">
          <button type="button" aria-pressed={status === 'pending'} onClick={() => setStatus('pending')}>მოლოდინში</button>
          <button type="button" aria-pressed={status === 'done'} onClick={() => setStatus('done')}>დამუშავებული (3 დღე)</button>
        </div>
        <span className="grow" />{status === 'pending' && q.data && <span className="chip warn">{q.data.length}</span>}
      </div>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : !q.data?.length ? <div className="card empty">{status === 'pending' ? 'ვერიფიკაციის მოლოდინში დანიშნულება არ არის.' : 'ჩანაწერი არ არის.'}</div> : (
        <div className="card"><table className="table">
          <thead><tr><th>პაციენტი</th><th>დანიშნულება</th><th>შემოწმებები</th><th>ექიმი</th><th /></tr></thead>
          <tbody>{q.data.map((o) => (
            <tr key={o.id}>
              <td><Link to={`/inpatient/stay/${o.encounter_id}?tab=orders`}><strong>{o.last_name} {o.first_name}</strong></Link>
                <div className="small muted">{genderShort(o.gender)} · {age(o.birth_date)} · {o.adm_no} · {o.department_name}</div>
                {(o.allergies ?? 0) > 0 && <span className="chip danger">ალერგია: {o.allergies}</span>}</td>
              <td><strong>{o.title}</strong><div className="small">{orderSummary(o)}</div>{o.instructions && <div className="small muted">{o.instructions}</div>}
                <div className="row" style={{ gap: 4, flexWrap: 'wrap', marginTop: 4 }}><OrderBadges o={o} /></div></td>
              <td className="small">{o.checks.filter((c) => c.level !== 'info').map((c, i) => <div key={i}>• {c.message}</div>)}
                {o.override_reason && <div><strong>დასაბუთება:</strong> {o.override_reason}</div>}
                {o.verify_note && status === 'done' && <div><strong>{o.verify_status === 'rejected' ? 'უარი' : 'შენიშვნა'}:</strong> {o.verify_note}</div>}</td>
              <td className="small">{o.ordered_by_name}<div className="muted">{orderDateTime(o.created_at)}</div></td>
              <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{status === 'pending' ? <>
                <button className="btn sm primary" type="button" onClick={() => setSel({ o, ok: true })}>დადასტურება</button>{' '}
                <button className="btn sm" type="button" onClick={() => setSel({ o, ok: false })}>უარყოფა</button></>
                : <span className={`chip ${o.verify_status === 'verified' ? 'ok' : 'danger'}`}>{o.verify_status === 'verified' ? 'დადასტურებული' : 'უარყოფილი'}</span>}</td>
            </tr>))}</tbody></table></div>)}
      {sel && <VerifyDialog o={sel.o} ok={sel.ok} onClose={() => setSel(null)} onDone={(m) => { toast.show(m); void qc.invalidateQueries({ queryKey: ['pharm-verify'] }); setSel(null); }} />}
    </div>
  );
}

function VerifyDialog({ o, ok, onClose, onDone }: { o: Order; ok: boolean; onClose: () => void; onDone: (m: string) => void }) {
  const [note, setNote] = useState(''); const [item, setItem] = useState(''); const [qty, setQty] = useState('');
  const gen = useQuery({ queryKey: ['generic', o.generic_id], queryFn: () => api<{ stock_items: { id: string; code: string; name: string; is_active: boolean }[] }>(`/pharmacy/generics/${o.generic_id}`),
    enabled: ok && o.supply_mode === 'pharmacy' && !!o.generic_id });
  const m = useMutation({
    mutationFn: () => api(`/pharmacy/verification/${o.id}/${ok ? 'verify' : 'reject'}`, { body: { note: note.trim() || undefined,
      ...(ok && item && { dispense_item_id: item, dispense_qty: Number(qty) }) } }),
    onSuccess: () => onDone(ok ? 'დადასტურდა' : 'უარყოფილია'),
  });
  const ready = ok ? (!item || Number(qty) > 0) : note.trim().length >= 3;
  return (
    <Modal title={`${ok ? 'ვერიფიკაცია' : 'უარყოფა'} — ${o.title}`} onClose={onClose} width={560}
      footer={<><button className="btn" type="button" onClick={onClose}>დახურვა</button>
        <button className={`btn ${ok ? 'primary' : 'danger'}`} type="button" disabled={!ready || m.isPending} onClick={() => m.mutate()}>{ok ? 'დადასტურება' : 'უარყოფა'}</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <div className="small">{orderSummary(o)}</div>
        <Field label={ok ? 'შენიშვნა ექიმს (არასავალდებულო)' : 'მიზეზი'} htmlFor="vf-n" required={!ok} hint={ok ? 'შევსებისას ექიმი შეტყობინებას მიიღებს' : 'ექიმი მიიღებს შეტყობინებას; დოზას ცვლის მხოლოდ ექიმი'}>
          <textarea id="vf-n" className="textarea" rows={3} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        {ok && o.supply_mode === 'pharmacy' && <div className="card card-pad stack" style={{ gap: 8 }}>
          <span className="label">აფთიაქიდან პაციენტზე გაცემა</span>
          {!o.generic_id ? <span className="small muted">კატალოგის გარეშე — გაცემა ხელით (საწყობი → მოთხოვნები).</span> : <div className="row" style={{ gap: 8 }}>
            <select className="select grow" aria-label="საქონელი" value={item} onChange={(e) => setItem(e.target.value)}>
              <option value="">— გაცემის გარეშე —</option>{gen.data?.stock_items.filter((i) => i.is_active).map((i) => <option key={i.id} value={i.id}>{i.name} ({i.code})</option>)}</select>
            <input className="input mono" style={{ maxWidth: 120 }} type="number" min={0} step="any" aria-label="რაოდენობა" placeholder="რაოდ." value={qty} onChange={(e) => setQty(e.target.value)} disabled={!item} />
          </div>}
          <span className="small muted">შეიქმნება სასწრაფო მოთხოვნა აფთიაქი → განყოფილება (პაციენტზე); გაცემა და მიღება — ჩვეულებრივად.</span>
        </div>}
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}
