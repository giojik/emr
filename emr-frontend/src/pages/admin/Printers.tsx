import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import type { Department } from '../../api/types';
import { ErrorBox, Field, Loading, Modal, useToast } from '../../components/ui';
import type { Printer } from '../inpatient/types';

/** ეტიკეტების / სამაჯურის ქსელური პრინტერები (Zebra, RAW TCP 9100) — 0040 */
export default function Printers() {
  const q = useQuery({ queryKey: ['printers'], queryFn: () => api<Printer[]>('/inpatient/printers') });
  const [edit, setEdit] = useState<Printer | 'new' | null>(null);
  const toast = useToast();
  const test = useMutation({
    mutationFn: (a: { id: string; print: boolean }) => api<{ ms: number; printed: boolean }>(`/inpatient/printers/${a.id}/test`, { body: { print: a.print } }),
    onSuccess: (r) => toast.show(r.printed ? `სატესტო სამაჯური გაიგზავნა (${r.ms} მწმ)` : `კავშირი OK (${r.ms} მწმ)`),
  });
  return (
    <div className="content">
      {toast.node}
      <span className="hint">ქსელური Zebra პრინტერი: IP მისამართი და პორტი (ჩვეულებრივ 9100). განყოფილებაზე მიბმული პრინტერი იმ განყოფილების სამაჯურისთვის ავტომატურად აირჩევა; მიუბმელი — საერთოა.</span>
      <div className="row"><span className="muted grow">{q.data?.length ?? 0} პრინტერი</span><button className="btn primary" type="button" onClick={() => setEdit('new')}>+ პრინტერი</button></div>
      <ErrorBox error={q.error ?? test.error} />
      {q.isLoading ? <Loading /> : !!q.data?.length && (
        <div className="card"><table className="table">
          <thead><tr><th>დასახელება</th><th>დანიშნულება</th><th>მისამართი</th><th>DPI</th><th>განყოფილება</th><th>სტატუსი</th><th /></tr></thead>
          <tbody>{q.data.map((p) => (
            <tr key={p.id}>
              <td><button className="btn sm" type="button" onClick={() => setEdit(p)}>{p.name}</button></td>
              <td>{p.kind === 'wristband' ? 'სამაჯური' : 'ეტიკეტი'}</td><td className="mono">{p.host}:{p.port}</td><td className="mono">{p.dpi}</td>
              <td>{p.department_name ?? <span className="muted">საერთო</span>}</td>
              <td>{p.is_active ? <span className="chip ok">აქტიური</span> : <span className="chip">გათიშული</span>}</td>
              <td className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                <button className="btn sm" type="button" disabled={test.isPending} onClick={() => test.mutate({ id: p.id, print: false })}>კავშირი</button>
                {p.kind === 'wristband' && <button className="btn sm" type="button" disabled={test.isPending} onClick={() => test.mutate({ id: p.id, print: true })}>სატესტო ბეჭდვა</button>}
              </td>
            </tr>))}</tbody>
        </table></div>)}
      {edit && <PrinterDialog p={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function PrinterDialog({ p, onClose }: { p: Printer | null; onClose: () => void }) {
  const qc = useQueryClient();
  const deps = useQuery({ queryKey: ['departments'], queryFn: () => api<Department[]>('/departments') });
  const [f, setF] = useState({ name: p?.name ?? '', kind: p?.kind ?? 'wristband', host: p?.host ?? '', port: p?.port ?? 9100, dpi: p?.dpi ?? 203, department_id: p?.department_id ?? '', is_active: p?.is_active ?? true });
  const m = useMutation({
    mutationFn: () => { const body = { ...f, department_id: f.department_id || null }; return p ? api(`/inpatient/printers/${p.id}`, { method: 'PATCH', body }) : api('/inpatient/printers', { body }); },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['printers'] }); onClose(); },
  });
  return (
    <Modal title={p ? p.name : 'ახალი პრინტერი'} onClose={onClose} width={520}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={m.isPending || f.name.trim().length < 2 || !f.host.trim()} onClick={() => m.mutate()}>შენახვა</button></>}>
      <div className="stack" style={{ gap: 14 }}>
        <Field label="დასახელება" htmlFor="pn" required><input id="pn" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="მაგ. Zebra ZD510 — მიმღები" /></Field>
        <div className="row" style={{ gap: 12 }}>
          <Field label="IP / ჰოსტი" htmlFor="ph" required><input id="ph" className="input mono" value={f.host} onChange={(e) => setF({ ...f, host: e.target.value.trim() })} placeholder="192.168.1.50" /></Field>
          <Field label="პორტი" htmlFor="pp"><input id="pp" className="input mono" type="number" min={1} max={65535} value={f.port} onChange={(e) => setF({ ...f, port: Number(e.target.value) })} /></Field>
          <Field label="DPI" htmlFor="pd"><select id="pd" className="select" value={f.dpi} onChange={(e) => setF({ ...f, dpi: Number(e.target.value) })}><option value={203}>203</option><option value={300}>300</option><option value={600}>600</option></select></Field>
        </div>
        <Field label="დანიშნულება" htmlFor="pk"><select id="pk" className="select" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as Printer['kind'] })}><option value="wristband">სამაჯური</option><option value="label">ეტიკეტი</option></select></Field>
        <Field label="განყოფილება" htmlFor="pdp" hint="ცარიელი — საერთო"><select id="pdp" className="select" value={f.department_id} onChange={(e) => setF({ ...f, department_id: e.target.value })}>
          <option value="">— საერთო —</option>{deps.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
        {p && <label className="row"><input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> აქტიური</label>}
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}
