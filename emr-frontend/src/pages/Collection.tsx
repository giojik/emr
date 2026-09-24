import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, openBlob } from '../api/client';
import type { CollectedSpecimen, PendingCollection } from '../api/types';
import { ErrorBox, Loading, Modal } from '../components/ui';
import { age, dateGe, hhmm } from '../lib/format';

/** ნიმუშის აღება (ექთანი): შეკვეთები → სინჯარები შტრიხკოდით → ეტიკეტების ბეჭდვა */
export default function Collection() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['collection'], queryFn: () => api<PendingCollection[]>('/dx/collection'), refetchInterval: 20_000 });
  const [done, setDone] = useState<{ name: string; specimens: CollectedSpecimen[] } | null>(null);
  const labels = useMutation({ mutationFn: (ids: string[]) => openBlob(`/dx/labels?ids=${ids.join(',')}`) });
  const collect = useMutation({
    mutationFn: (p: PendingCollection) => api<CollectedSpecimen[]>(`/encounters/${p.encounter_id}/dx-collect`, { body: {} }),
    onSuccess: (sp, p) => { setDone({ name: `${p.first_name} ${p.last_name}`, specimens: sp }); void qc.invalidateQueries({ queryKey: ['collection'] }); labels.mutate(sp.map((s) => s.id)); },
  });
  return (
    <>
      <header className="topbar"><h1 className="grow">ნიმუშის აღება</h1><span className="muted">{q.data?.length ?? 0} პაციენტი ელოდება</span></header>
      <div className="content">
        <ErrorBox error={q.error ?? collect.error ?? labels.error} />
        {q.isLoading ? <Loading /> : !q.data?.length ? <div className="card empty">ასაღები ნიმუში არ არის.</div> : (
          <div className="card">
            <table className="table">
              <thead><tr><th>შეკვეთა</th><th>პაციენტი</th><th>ანალიზები</th><th /></tr></thead>
              <tbody>{q.data.map((p) => (
                <tr key={p.encounter_id}>
                  <td className="mono">{hhmm(p.ordered_at)}{p.urgent && <div><span className="chip danger">სასწრაფო</span></div>}</td>
                  <td><strong>{p.first_name} {p.last_name}</strong><div className="small muted mono">{p.personal_number} · {dateGe(p.birth_date)} · {age(p.birth_date)} წ</div></td>
                  <td className="small">{p.names.join(', ')}</td>
                  <td style={{ textAlign: 'right' }}><button className="btn primary" type="button" disabled={collect.isPending} onClick={() => collect.mutate(p)}>აღება და ეტიკეტები</button></td>
                </tr>))}</tbody>
            </table>
          </div>
        )}
      </div>
      {done && (
        <Modal title={`ნიმუშები — ${done.name}`} onClose={() => setDone(null)} width={560}
          footer={<><button className="btn" type="button" onClick={() => labels.mutate(done.specimens.map((s) => s.id))}>ეტიკეტების ხელახლა ბეჭდვა</button><button className="btn primary" type="button" onClick={() => setDone(null)}>დასრულება</button></>}>
          <p style={{ margin: 0 }}>დააკარით ეტიკეტები სინჯარებს და გაგზავნეთ ლაბორატორიაში:</p>
          {done.specimens.map((s) => (
            <div key={s.id} className="row card" style={{ padding: '10px 12px' }}>
              <span className="mono" style={{ fontWeight: 600, fontSize: 16 }}>{s.barcode}</span>
              <span className="chip">{s.container ?? s.specimen_type}</span>
              <span className="small grow">{s.tests.join(', ')}</span>
              {s.external && <span className="chip warn">გარე ლაბ.</span>}
            </div>
          ))}
        </Modal>
      )}
    </>
  );
}
