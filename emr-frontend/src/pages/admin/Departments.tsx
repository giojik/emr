import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import type { Department } from '../../api/types';
import { ErrorBox, Field, Loading, Modal } from '../../components/ui';

const TYPES: Record<string, string> = { outpatient: 'ამბულატორიული', inpatient: 'სტაციონარული', diagnostic: 'დიაგნოსტიკური', administrative: 'ადმინისტრაციული' };

export default function Departments() {
  const q = useQuery({ queryKey: ['departments', 'all'], queryFn: () => api<Department[]>('/departments', { query: { include_inactive: true } }) });
  const [edit, setEdit] = useState<Department | 'new' | null>(null);
  return (
    <div className="content">
      <div className="row"><span className="muted grow">{q.data?.length ?? 0} განყოფილება</span><button className="btn primary" type="button" onClick={() => setEdit('new')}>+ განყოფილება</button></div>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : (
        <div className="card">
          <table className="table">
            <thead><tr><th>დასახელება</th><th>კოდი</th><th>ტიპი</th><th className="num">აქტიური თანამშრომელი</th><th>სტატუსი</th></tr></thead>
            <tbody>{q.data?.map((d) => (
              <tr key={d.id} className="clickable" onClick={() => setEdit(d)}>
                <td><strong>{d.name}</strong></td><td className="mono">{d.code}</td><td>{TYPES[d.type] ?? d.type}</td>
                <td className="num">{d.active_users ?? 0}</td><td>{d.is_active ? <span className="chip ok">აქტიური</span> : <span className="chip">გათიშული</span>}</td>
              </tr>))}</tbody>
          </table>
        </div>
      )}
      {edit && <DeptDialog d={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function DeptDialog({ d, onClose }: { d: Department | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(d?.name ?? ''); const [code, setCode] = useState(d?.code ?? ''); const [type, setType] = useState(d?.type ?? 'outpatient'); const [active, setActive] = useState(d?.is_active ?? true);
  const m = useMutation({
    mutationFn: () => d ? api(`/departments/${d.id}`, { method: 'PATCH', body: { name, type, is_active: active } }) : api('/departments', { body: { name, code, type } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['departments'] }); void qc.invalidateQueries({ queryKey: ['doctors'] }); onClose(); },
  });
  return (
    <Modal title={d ? d.name : 'ახალი განყოფილება'} onClose={onClose} width={520}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="submit" form="dd" disabled={m.isPending}>შენახვა</button></>}>
      <form id="dd" className="stack" style={{ gap: 14 }} onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <Field label="დასახელება" htmlFor="dn" required><input id="dn" className="input" value={name} onChange={(e) => setName(e.target.value)} required /></Field>
        <Field label="კოდი" htmlFor="dc" required hint={d ? 'კოდი არ იცვლება (რეპორტებსა და SSA-ზეა მიბმული)' : 'დიდი ლათინური ასოები და ციფრები, მაგ. CARDIO'}>
          <input id="dc" className="input mono" value={code} disabled={!!d} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))} required />
        </Field>
        <Field label="ტიპი" htmlFor="dt"><select id="dt" className="select" value={type} onChange={(e) => setType(e.target.value)}>{Object.entries(TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        {d && <label className="row"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> აქტიური</label>}
        <ErrorBox error={m.error} />
      </form>
    </Modal>
  );
}
