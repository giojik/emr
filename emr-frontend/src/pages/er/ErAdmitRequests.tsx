import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import { ErrorBox, Field, Loading, Modal, useToast } from '../../components/ui';
import { tsDate } from '../../lib/format';
import type { Board } from '../inpatient/types';
import { hm, onColor } from './types';

/**
 * 0090 — სტაციონარი → „ER — მოთხოვნები“ (admit_mode = request): ER-ის ექიმის ჰოსპიტალიზაციის მოთხოვნა.
 * განყოფილების ექიმი იღებს (მკურნალი ექიმი, საწოლი — არასავალდებულო, ER-ის დანიშნულებები — გაგრძელება / შეწყვეტა) ან უარყოფს (მიზეზით).
 */
interface Req {
  id: string; encounter_id: string; department_id: string; department_name: string; icd10_code: string; icd10_title: string; severity: string | null; isolation: string | null;
  note: string | null; status: string; requested_at: string; decided_at: string | null; decision_reason: string | null; attending_doctor_id: string | null; visit_no: string;
  chief_complaint: string; arrived_at: string; level_name: string | null; color: string | null; patient_id: string; first_name: string; last_name: string;
  requested_by_name: string; attending_name: string | null; active_orders: number;
}
interface Opts { departments: { id: string; name: string; doctors: { id: string; name: string; specialty: string | null }[] }[] }
interface ROrders { transfer_orders: string; ipd_orders: boolean; orders: { id: string; label: string; running: boolean; untransferable: string | null; default: 'continue' | 'stop' }[] }

export default function ErAdmitRequests({ departmentId, picker }: { departmentId: string; picker?: React.ReactNode }) {
  const [status, setStatus] = useState('requested');
  const q = useQuery({ queryKey: ['er-admit-requests', departmentId, status], queryFn: () => api<Req[]>('/er/admit-requests', { query: { department_id: departmentId, status } }), refetchInterval: 30_000 });
  const [acc, setAcc] = useState<Req | null>(null); const [rej, setRej] = useState<Req | null>(null);
  return (
    <div className="content stack" data-testid="er-admit-requests">
      <div className="row" style={{ gap: 8 }}>{picker}<span className="grow" />
        <select aria-label="სტატუსი" className="select" style={{ width: 'auto' }} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="requested">მოლოდინში</option><option value="accepted">მიღებული</option><option value="rejected">უარყოფილი</option><option value="cancelled">გაუქმებული</option></select></div>
      <div className="card">
        {!q.data ? (q.error ? <ErrorBox error={q.error} /> : <Loading />) : q.data.length === 0 ? <div className="empty">ER-იდან მოთხოვნა არ არის.</div> : (
          <table className="table"><thead><tr><th>მოთხოვნა</th><th>პაციენტი</th><th>ტრიაჟი</th><th>დიაგნოზი</th><th>ER-ის ექიმი</th><th>დანიშნ.</th><th /></tr></thead>
            <tbody>{q.data.map((r) => <tr key={r.id}>
              <td className="small">{tsDate(r.requested_at)} {hm(r.requested_at)}<div className="mono muted">{r.visit_no}</div></td>
              <td>{r.last_name} {r.first_name}<div className="small muted">{r.chief_complaint}</div></td>
              <td>{r.level_name ? <span className="chip" style={{ background: r.color ?? undefined, color: r.color ? onColor(r.color) : undefined }}>{r.level_name}</span> : '—'}</td>
              <td className="small"><span className="mono">{r.icd10_code}</span> {r.icd10_title}{r.note && <div className="muted">{r.note}</div>}</td>
              <td className="small">{r.requested_by_name}{r.attending_name && <div className="muted">სასურველი: {r.attending_name}</div>}</td>
              <td>{r.active_orders || '—'}</td>
              <td>{r.status === 'requested' ? <div className="row" style={{ gap: 6 }}>
                <button className="btn sm primary" type="button" onClick={() => setAcc(r)}>მიღება</button>
                <button className="btn sm" type="button" onClick={() => setRej(r)}>უარი</button></div>
                : <span className="small muted">{r.decision_reason ?? ''}</span>}</td></tr>)}</tbody></table>)}
      </div>
      {acc && <AcceptDialog r={acc} onClose={() => setAcc(null)} />}
      {rej && <RejectDialog r={rej} onClose={() => setRej(null)} />}
    </div>
  );
}

function AcceptDialog({ r, onClose }: { r: Req; onClose: () => void }) {
  const qc = useQueryClient(); const toast = useToast();
  const opts = useQuery({ queryKey: ['er-admit-options'], queryFn: () => api<Opts>('/er/admit/options') });
  const ord = useQuery({ queryKey: ['er-admit-req-orders', r.id], queryFn: () => api<ROrders>(`/er/admit-requests/${r.id}/orders`) });
  const board = useQuery({ queryKey: ['ipd-board', r.department_id], queryFn: () => api<Board>('/inpatient/board', { query: { department_id: r.department_id } }) });
  const [att, setAtt] = useState(r.attending_doctor_id ?? ''); const [bed, setBed] = useState(''); const [confirm, setConfirm] = useState(false);
  const [plan, setPlan] = useState<Record<string, 'continue' | 'stop'> | null>(null);
  const cur = plan ?? Object.fromEntries((ord.data?.orders ?? []).map((o) => [o.id, o.default]));
  const m = useMutation({
    mutationFn: () => api<{ adm_no: string }>(`/er/admit-requests/${r.id}/accept`, { body: { attending_doctor_id: att, bed_id: bed || undefined, confirm: confirm || undefined,
      orders_plan: ord.data?.ipd_orders && ord.data.transfer_orders === 'reconcile' ? cur : undefined } }),
    onSuccess: (x) => { toast.show(`ჰოსპიტალიზებულია (${x.adm_no})`); for (const k of ['er-admit-requests', 'ipd-board', 'ipd-census', 'ipd-stays']) void qc.invalidateQueries({ queryKey: [k] }); onClose(); },
  });
  const doctors = opts.data?.departments.find((d) => d.id === r.department_id)?.doctors ?? [];
  const free = (board.data?.wards ?? []).flatMap((w) => w.beds.filter((b) => b.status === 'free' && b.is_active).map((b) => ({ id: b.id, code: b.code, ward: w.code })));
  const reconcile = !!ord.data?.ipd_orders && ord.data.transfer_orders === 'reconcile' && ord.data.orders.length > 0;
  return (
    <Modal title={`ჰოსპიტალიზაცია ER-იდან — ${r.last_name} ${r.first_name}`} onClose={onClose} width={640}
      footer={<><button className="btn" type="button" onClick={onClose}>დახურვა</button><button className="btn primary" type="button" disabled={!att || m.isPending} onClick={() => m.mutate()}>მიღება</button></>}>
      {toast.node}
      <div className="stack" style={{ gap: 12 }}>
        <div className="small">{r.department_name} · <span className="mono">{r.icd10_code}</span> {r.icd10_title}</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label="მკურნალი ექიმი" htmlFor="ea-att" required><select id="ea-att" className="select" value={att} onChange={(e) => setAtt(e.target.value)}>
            <option value="">— აირჩიეთ —</option>{doctors.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
          <Field label="საწოლი" htmlFor="ea-bed" hint="არასავალდებულო — მოგვიანებით (განყოფილების დაფა)"><select id="ea-bed" className="select" value={bed} onChange={(e) => setBed(e.target.value)}>
            <option value="">— მოგვიანებით —</option>{free.map((b) => <option key={b.id} value={b.id}>{b.ward} / {b.code}</option>)}</select></Field>
        </div>
        {reconcile && <div className="stack" style={{ gap: 6 }}><span className="label">ER-ის აქტიური დანიშნულებები</span>
          <table className="table"><tbody>{ord.data!.orders.map((o) => <tr key={o.id}><td className="small">{o.label}{o.untransferable && <div className="muted">{o.untransferable}</div>}</td>
            <td style={{ width: 220 }}><div className="seg" role="group" aria-label={o.label}>
              <button type="button" aria-pressed={cur[o.id] === 'continue'} disabled={!!o.untransferable} onClick={() => setPlan({ ...cur, [o.id]: 'continue' })}>გაგრძელება</button>
              <button type="button" aria-pressed={cur[o.id] === 'stop'} onClick={() => setPlan({ ...cur, [o.id]: 'stop' })}>შეწყვეტა</button></div></td></tr>)}</tbody></table></div>}
        <label className="row small"><input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /> გაფრთხილებების დადასტურება (სქესი / იზოლაცია)</label>
        <ErrorBox error={m.error ?? ord.error} />
      </div>
    </Modal>
  );
}

function RejectDialog({ r, onClose }: { r: Req; onClose: () => void }) {
  const qc = useQueryClient(); const [reason, setReason] = useState('');
  const m = useMutation({ mutationFn: () => api(`/er/admit-requests/${r.id}/reject`, { body: { reason: reason.trim() } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['er-admit-requests'] }); onClose(); } });
  return (
    <Modal title="მოთხოვნის უარყოფა" onClose={onClose} width={480}
      footer={<><button className="btn" type="button" onClick={onClose}>დახურვა</button><button className="btn primary" type="button" disabled={reason.trim().length < 3 || m.isPending} onClick={() => m.mutate()}>უარყოფა</button></>}>
      <Field label="მიზეზი (ER-ის ექიმი მიიღებს შეტყობინებას)" htmlFor="er-rj" required><input id="er-rj" className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <ErrorBox error={m.error} />
    </Modal>
  );
}
