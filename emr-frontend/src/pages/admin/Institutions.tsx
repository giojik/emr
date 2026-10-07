import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import { ErrorBox, Field, Loading, Modal } from '../../components/ui';

interface Inst { id: string; name: string; address: string | null; phone: string | null; is_active: boolean; sort_order: number }

/** ადმინისტრირება → სხვა კლინიკები (0041): გადაყვანა სხვა დაწესებულებაში — გაწერის დიალოგის ცნობარი */
export default function Institutions() {
  const q = useQuery({ queryKey: ['ipd-institutions', 'all'], queryFn: () => api<Inst[]>('/inpatient/institutions', { query: { all: true } }) });
  const [edit, setEdit] = useState<Inst | 'new' | null>(null);
  return (
    <div className="stack">
      <div className="row"><h2 style={{ margin: 0 }} className="grow">სხვა სამედიცინო დაწესებულებები</h2><button className="btn primary" type="button" onClick={() => setEdit('new')}>+ დამატება</button></div>
      <span className="small muted">გამოიყენება სტაციონარიდან სხვა კლინიკაში გაწერისას. ცნობარში არარსებული დაწესებულება შეიძლება ჩაიწეროს ტექსტითაც.</span>
      <ErrorBox error={q.error} />
      <div className="card">{q.isLoading ? <Loading /> : (
        <table className="table"><thead><tr><th>დასახელება</th><th>მისამართი</th><th>ტელეფონი</th><th>სტატუსი</th><th /></tr></thead>
          <tbody>{q.data?.map((i) => <tr key={i.id} style={{ opacity: i.is_active ? 1 : 0.55 }}><td><strong>{i.name}</strong></td><td className="small">{i.address ?? ''}</td><td className="small mono">{i.phone ?? ''}</td>
            <td>{i.is_active ? <span className="chip ok">აქტიური</span> : <span className="chip">გათიშული</span>}</td>
            <td style={{ textAlign: 'right' }}><button className="btn sm" type="button" onClick={() => setEdit(i)}>რედაქტირება</button></td></tr>)}
            {!q.data?.length && <tr><td colSpan={5} className="muted">ცნობარი ცარიელია</td></tr>}</tbody></table>)}</div>
      {edit && <EditDialog item={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function EditDialog({ item, onClose }: { item: Inst | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ name: item?.name ?? '', address: item?.address ?? '', phone: item?.phone ?? '', is_active: item?.is_active ?? true });
  const m = useMutation({
    mutationFn: () => api(item ? `/inpatient/institutions/${item.id}` : '/inpatient/institutions', { method: item ? 'PATCH' : 'POST', body: { ...f, address: f.address || undefined, phone: f.phone || undefined } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['ipd-institutions'] }); onClose(); },
  });
  return (
    <Modal title={item ? 'დაწესებულება' : 'ახალი დაწესებულება'} onClose={onClose} width={520}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={m.isPending || f.name.trim().length < 2} onClick={() => m.mutate()}>შენახვა</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <Field label="დასახელება" htmlFor="in-n" required><input id="in-n" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="მისამართი" htmlFor="in-a"><input id="in-a" className="input" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
        <Field label="ტელეფონი" htmlFor="in-p"><input id="in-p" className="input mono" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        {item && <label className="row"><input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> აქტიური</label>}
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}
