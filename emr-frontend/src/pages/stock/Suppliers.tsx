import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, can } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Field, Loading, Modal, useDebounced } from '../../components/ui';
import { nul, type Supplier } from './types';

const EDIT = ['admin', 'stock_manager', 'storekeeper'] as const;

/** მომწოდებლები — მიღების დოკუმენტისთვის (0031) */
export default function Suppliers() {
  const { user } = useAuth();
  const [search, setSearch] = useState(''); const [all, setAll] = useState(false);
  const ds = useDebounced(search.trim(), 250);
  const q = useQuery({ queryKey: ['stock-suppliers', ds, all], queryFn: () => api<Supplier[]>('/stock/suppliers', { query: { search: ds, all } }) });
  const [edit, setEdit] = useState<Supplier | 'new' | null>(null);
  return (
    <div className="content">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <input className="input" style={{ maxWidth: 360, height: 38 }} aria-label="ძებნა" placeholder="დასახელება ან საიდენტიფიკაციო კოდი" value={search} onChange={(e) => setSearch(e.target.value)} />
        <label className="row small"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> გათიშულიც</label>
        <span className="grow" />
        {can(user, ...EDIT) && <button className="btn primary" type="button" onClick={() => setEdit('new')}>+ მომწოდებელი</button>}
      </div>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : (
        <div className="card">
          <table className="table">
            <thead><tr><th>დასახელება</th><th>ს/კ</th><th>დღგ</th><th>საკონტაქტო</th><th>ტელეფონი / ელ-ფოსტა</th><th>სტატუსი</th></tr></thead>
            <tbody>{q.data?.map((s) => (
              <tr key={s.id} className="clickable" onClick={() => setEdit(s)}>
                <td><strong>{s.name}</strong></td><td className="mono">{s.tax_id ?? '—'}</td><td>{s.vat_payer ? 'გადამხდელი' : 'არა'}</td>
                <td>{s.contact_person ?? '—'}</td><td className="small">{[s.phone, s.email].filter(Boolean).join(' · ') || '—'}</td>
                <td>{s.is_active ? <span className="chip ok">აქტიური</span> : <span className="chip">გათიშული</span>}</td>
              </tr>))}
              {!q.data?.length && <tr><td colSpan={6} className="muted">მომწოდებელი არ არის</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {edit && <SupplierDialog s={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function SupplierDialog({ s, onClose }: { s: Supplier | null; onClose: () => void }) {
  const { user } = useAuth(); const qc = useQueryClient(); const editable = can(user, ...EDIT);
  const [f, setF] = useState({ name: s?.name ?? '', tax_id: s?.tax_id ?? '', vat_payer: s?.vat_payer ?? true, address: s?.address ?? '', phone: s?.phone ?? '', email: s?.email ?? '',
    contact_person: s?.contact_person ?? '', notes: s?.notes ?? '', is_active: s?.is_active ?? true });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));
  const m = useMutation({
    mutationFn: () => {
      const body = { name: f.name.trim(), tax_id: nul(f.tax_id), vat_payer: f.vat_payer, address: nul(f.address), phone: nul(f.phone), email: nul(f.email), contact_person: nul(f.contact_person), notes: nul(f.notes), ...(s && { is_active: f.is_active }) };
      return s ? api(`/stock/suppliers/${s.id}`, { method: 'PATCH', body }) : api('/stock/suppliers', { body });
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['stock-suppliers'] }); onClose(); },
  });
  return (
    <Modal title={s ? s.name : 'ახალი მომწოდებელი'} onClose={onClose} width={680}
      footer={<><button className="btn" type="button" onClick={onClose}>{editable ? 'გაუქმება' : 'დახურვა'}</button>
        {editable && <button className="btn primary" type="submit" form="supf" disabled={m.isPending || f.name.trim().length < 2}>შენახვა</button>}</>}>
      <form id="supf" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <fieldset disabled={!editable} style={{ border: 0, padding: 0, margin: 0, display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
          <Field label="დასახელება" htmlFor="sn" required><input id="sn" className="input" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="შპს …" /></Field>
          <Field label="საიდენტიფიკაციო კოდი / პ/ნ" htmlFor="st" hint="9 ან 11 ციფრი"><input id="st" className="input mono" inputMode="numeric" value={f.tax_id} onChange={(e) => set('tax_id', e.target.value.replace(/\D/g, ''))} /></Field>
          <Field label="საკონტაქტო პირი" htmlFor="sc"><input id="sc" className="input" value={f.contact_person} onChange={(e) => set('contact_person', e.target.value)} /></Field>
          <Field label="ტელეფონი" htmlFor="sp"><input id="sp" className="input" value={f.phone} onChange={(e) => set('phone', e.target.value)} /></Field>
          <Field label="ელ-ფოსტა" htmlFor="se"><input id="se" className="input" type="email" value={f.email} onChange={(e) => set('email', e.target.value)} /></Field>
          <Field label="მისამართი" htmlFor="sa"><input id="sa" className="input" value={f.address} onChange={(e) => set('address', e.target.value)} /></Field>
          <label className="row"><input type="checkbox" checked={f.vat_payer} onChange={(e) => set('vat_payer', e.target.checked)} /> დღგ-ის გადამხდელი</label>
          {s && <label className="row"><input type="checkbox" checked={f.is_active} onChange={(e) => set('is_active', e.target.checked)} /> აქტიური</label>}
          <div style={{ gridColumn: '1 / -1' }}><Field label="შენიშვნა" htmlFor="sno"><textarea id="sno" className="textarea" rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} /></Field></div>
        </fieldset>
        <ErrorBox error={m.error} />
      </form>
    </Modal>
  );
}
