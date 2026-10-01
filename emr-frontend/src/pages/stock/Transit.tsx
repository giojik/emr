import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import { ErrorBox, Loading, Modal } from '../../components/ui';
import { dateGe, tsDate } from '../../lib/format';
import { DOC_TYPE_KA, qtyFmt, type StockDoc, type TransitRow } from './types';

/** გზაში: მისაღები (დადასტურება / უარი) და გაგზავნილი (ელოდება მიმღებს) — გადაწყვეტილება 1A */
export default function Transit() {
  const [scope, setScope] = useState<'incoming' | 'outgoing'>('incoming');
  const q = useQuery({ queryKey: ['stock-transit', scope], queryFn: () => api<TransitRow[]>('/stock/transit', { query: { scope } }), refetchInterval: 60_000 });
  const [open, setOpen] = useState<TransitRow | null>(null);
  return (
    <div className="content">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <div className="seg" role="group" aria-label="მიმართულება">
          <button type="button" aria-pressed={scope === 'incoming'} onClick={() => setScope('incoming')}>მისაღები</button>
          <button type="button" aria-pressed={scope === 'outgoing'} onClick={() => setScope('outgoing')}>გაგზავნილი — ელოდება მიმღებს</button>
        </div>
        <span className="hint grow">გაგზავნილი მარაგი „გზაშია“ — მიმღების დადასტურებამდე არცერთ საწყობში არ ითვლება. უარისას (მიზეზით) ბრუნდება გამგზავნთან.</span>
      </div>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : (
        <div className="card">
          <table className="table">
            <thead><tr><th>№</th><th>ტიპი</th><th>გაიგზავნა</th><th>ვისგან</th><th>ვისთვის</th><th>მოთხოვნა</th><th className="num">ხაზი</th><th>გამგზავნი</th></tr></thead>
            <tbody>{q.data?.map((d) => (
              <tr key={d.id} className="clickable" onClick={() => setOpen(d)}>
                <td className="mono">{d.doc_no}</td><td>{DOC_TYPE_KA[d.doc_type] === 'დაბრუნება' ? <span className="chip warn">დაბრუნება</span> : 'გაცემა'}</td><td className="small">{tsDate(d.posted_at)}</td>
                <td>{d.from_name}</td><td><strong>{d.to_name}</strong></td><td className="mono small">{d.req_no ?? '—'}</td><td className="num">{d.lines}</td><td className="small">{d.sent_by_name}</td>
              </tr>))}
              {!q.data?.length && <tr><td colSpan={8} className="muted">{scope === 'incoming' ? 'მისაღები არაფერია' : 'ყველა გაგზავნილი მიღებულია'}</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {open && <ReceiveDialog row={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function ReceiveDialog({ row, onClose }: { row: TransitRow; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['stock-doc', row.id], queryFn: () => api<StockDoc>(`/stock/docs/${row.id}`) });
  const [refuse, setRefuse] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: (b: { action: 'receive' | 'return'; note?: string }) => api(`/stock/docs/${row.id}/receive`, { body: b }),
    onSuccess: () => { for (const k of ['stock-transit', 'stock-balances', 'stock-requests', 'stock-request', 'stock-doc']) void qc.invalidateQueries({ queryKey: [k] }); onClose(); },
  });
  const d = q.data;
  return (
    <Modal title={`${row.doc_no} — ${row.from_name} → ${row.to_name}`} onClose={onClose} width={860}
      footer={row.can_receive ? (refuse === null
        ? <><button className="btn" type="button" onClick={() => setRefuse('')}>უარი (დაბრუნება გამგზავნთან)</button>
          <button className="btn primary" type="button" disabled={m.isPending} onClick={() => m.mutate({ action: 'receive' })}>მიღება — რაოდენობა სწორია</button></>
        : <><button className="btn" type="button" onClick={() => setRefuse(null)}>უკან</button>
          <button className="btn danger" type="button" disabled={m.isPending || refuse.trim().length < 3} onClick={() => m.mutate({ action: 'return', note: refuse.trim() })}>უარის დადასტურება</button></>)
        : <button className="btn" type="button" onClick={onClose}>დახურვა</button>}>
      {!d ? <Loading /> : (
        <div className="stack">
          {d.notes && <span className="small">{d.notes}</span>}
          <table className="table">
            <thead><tr><th>#</th><th>საქონელი</th><th>ლოტი</th><th>ვადა</th><th>პაციენტი</th><th className="num">რაოდენობა</th></tr></thead>
            <tbody>{d.lines.map((l) => (
              <tr key={l.id}><td className="mono small">{l.line_no}</td><td><strong>{l.item_name}</strong> <span className="mono small muted">{l.item_code}</span>{l.override_reason && <div className="small muted">არა FEFO: {l.override_reason}</div>}</td>
                <td className="mono small">{l.lot_no ?? '—'}{l.serial_no && ` · SN ${l.serial_no}`}</td><td className="mono small">{l.expires_on ? dateGe(l.expires_on) : '—'}</td>
                <td className="small">{l.patient_name ?? '—'}</td><td className="num"><strong>{qtyFmt(l.qty_base)}</strong> {l.base_unit_name}</td></tr>))}</tbody>
          </table>
          {refuse !== null && <div className="field"><label htmlFor="rf">უარის მიზეზი <span className="req">*</span></label>
            <input id="rf" className="input" autoFocus value={refuse} onChange={(e) => setRefuse(e.target.value)} placeholder="მაგ. რაოდენობა არ ემთხვევა, დაზიანებული შეფუთვა" /></div>}
          <ErrorBox error={q.error ?? m.error} />
        </div>)}
    </Modal>
  );
}
