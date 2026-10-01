import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, openBlob, printBlob } from '../api/client';
import { ErrorBox, Loading, Modal } from './ui';
import { tsDate } from '../lib/format';

interface Doc { id: string; document_number: string; status: string; generated_at: string; revoked_at: string | null; revoke_reason: string | null; encounter_id: string; issued_by: string | null }

/** პაციენტის ფორმა №100/ა — ყველა (წინა ვიზიტებისაც): ნახვა და ბეჭდვა */
export default function Form100History({ patientId, currentEncounterId, onClose }: { patientId: string; currentEncounterId?: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['form100-history', patientId], queryFn: () => api<Doc[]>('/documents', { query: { patient_id: patientId, type: 'form_100' } }) });
  const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState<string | null>(null);
  const run = async (id: string, f: (p: string) => Promise<void>) => { setErr(null); setBusy(id); try { await f(`/documents/${id}/pdf`); } catch (e) { setErr(e); } finally { setBusy(null); } };
  return (
    <Modal title="ფორმა №100/ა — ისტორია" onClose={onClose} width={760} footer={<button className="btn" type="button" onClick={onClose}>დახურვა</button>}>
      <ErrorBox error={q.error ?? err} />
      {q.isLoading ? <Loading /> : !q.data?.length ? <div className="empty">პაციენტს ფორმა №100/ა ჯერ არ აქვს.</div> : (
        <table className="table"><thead><tr><th>№</th><th>თარიღი</th><th>გასცა</th><th>სტატუსი</th><th /></tr></thead>
          <tbody>{q.data.map((d) => (
            <tr key={d.id} style={d.status === 'revoked' ? { opacity: 0.6 } : undefined}>
              <td className="mono">{d.document_number}{d.encounter_id === currentEncounterId && <span className="chip" style={{ marginLeft: 6 }}>ეს ვიზიტი</span>}</td>
              <td className="small">{tsDate(d.generated_at)}</td><td className="small">{d.issued_by}</td>
              <td>{d.status === 'revoked' ? <span className="chip danger" title={d.revoke_reason ?? ''}>გაუქმებულია</span> : <span className="chip ok">მოქმედი</span>}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                <button className="btn sm" type="button" disabled={busy === d.id} onClick={() => void run(d.id, openBlob)}>ნახვა</button>{' '}
                <button className="btn sm" type="button" disabled={busy === d.id} onClick={() => void run(d.id, printBlob)}>ბეჭდვა</button></td>
            </tr>))}</tbody></table>)}
    </Modal>
  );
}
