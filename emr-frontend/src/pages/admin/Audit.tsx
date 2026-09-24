import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import type { AuditRow } from '../../api/types';
import { ErrorBox, Loading, useDebounced } from '../../components/ui';
import { hhmm, localISO, shiftDay, todayISO, tsDate } from '../../lib/format';

export default function Audit() {
  const [action, setAction] = useState(''); const [entity, setEntity] = useState(''); const [entityId, setEntityId] = useState('');
  const [from, setFrom] = useState(shiftDay(todayISO(), -1)); const [to, setTo] = useState(todayISO());
  const da = useDebounced(action.trim(), 300); const de = useDebounced(entityId.trim(), 300);
  const q = useQuery({ queryKey: ['audit', da, entity, de, from, to], queryFn: () => api<AuditRow[]>('/audit-logs', { query: { action: da, entity_name: entity, entity_id: de, from: localISO(from, '00:00'), to: localISO(shiftDay(to, 1), '00:00'), limit: 300 } }) });
  return (
    <div className="content">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <input aria-label="მოქმედება" className="input" style={{ width: 220 }} placeholder="მოქმედება (მაგ. LOGIN, VIEW)" value={action} onChange={(e) => setAction(e.target.value)} />
        <select aria-label="ობიექტი" className="select" style={{ width: 200 }} value={entity} onChange={(e) => setEntity(e.target.value)}>
          <option value="">ყველა ობიექტი</option>
          {['patients', 'encounters', 'users', 'prescriptions', 'encounter_diagnoses', 'payments', 'invoice_line_items', 'generated_documents', 'patient_allergies', 'appointments'].map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
        <input aria-label="ობიექტის ID" className="input mono" style={{ width: 300 }} placeholder="ობიექტის ID" value={entityId} onChange={(e) => setEntityId(e.target.value)} />
        <label className="row small">დან <input className="input" type="date" style={{ width: 160 }} value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="row small">მდე <input className="input" type="date" style={{ width: 160 }} value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      <span className="hint">აუდიტ-ჟურნალი უცვლელია — ჩანაწერის შეცვლა ან წაშლა შეუძლებელია ბაზის დონეზეც. ნაჩვენებია ბოლო 300.</span>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : (
        <div className="card">
          {q.data?.length === 0 ? <div className="empty">ჩანაწერი არ მოიძებნა.</div> : (
            <table className="table">
              <thead><tr><th>დრო</th><th>მომხმარებელი</th><th>მოქმედება</th><th>ობიექტი</th><th>IP</th><th>დეტალები</th></tr></thead>
              <tbody>{q.data?.map((r) => (
                <tr key={r.id} style={{ verticalAlign: 'top' }}>
                  <td className="mono small" style={{ whiteSpace: 'nowrap' }}>{tsDate(r.created_at)} {hhmm(r.created_at)}</td>
                  <td>{r.user_name ?? <span className="muted">სისტემა / CLI</span>}</td>
                  <td><span className={`chip${/FAILED|REUSE|OVERRIDE|REVOKE|DISABLE/.test(r.action) ? ' warn' : ''}`}>{r.action}</span></td>
                  <td className="small"><div>{r.entity_name}</div><button type="button" className="mono small" style={{ border: 0, background: 'none', padding: 0, color: 'var(--accent)', cursor: 'pointer' }} onClick={() => setEntityId(r.entity_id)}>{r.entity_id.slice(0, 18)}</button></td>
                  <td className="mono small">{r.ip_address ?? '—'}</td>
                  <td style={{ maxWidth: 380 }}>{(r.old_data || r.new_data) ? (
                    <details><summary className="small" style={{ cursor: 'pointer' }}>{r.old_data ? 'ძველი / ახალი' : 'მონაცემები'}</summary>
                      {r.old_data != null && <><div className="small muted">ძველი</div><pre className="json">{JSON.stringify(r.old_data, null, 1)}</pre></>}
                      {r.new_data != null && <><div className="small muted">ახალი</div><pre className="json">{JSON.stringify(r.new_data, null, 1)}</pre></>}
                    </details>) : <span className="muted small">—</span>}</td>
                </tr>))}</tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
