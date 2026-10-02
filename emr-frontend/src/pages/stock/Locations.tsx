import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, can } from '../../api/client';
import type { Department } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Field, Loading, Modal } from '../../components/ui';
import { STOCK_ADMIN } from './Stock';
import { LOCATION_KA, type LocationKind, type StockLocation } from './types';

const deptCode = (code: string) => `D_${code.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`.slice(0, 30);

/** ლოკაციები: აფთიაქი, სამეურნეო, განყოფილებების ქვესაწყობები, საოპერაციო, CSSD, ლაბორატორია… */
export default function Locations() {
  const { user } = useAuth(); const editable = can(user, ...STOCK_ADMIN);
  const [all, setAll] = useState(false);
  const q = useQuery({ queryKey: ['stock-locations', all], queryFn: () => api<StockLocation[]>('/stock/locations', { query: { all } }) });
  const deps = useQuery({ queryKey: ['departments'], queryFn: () => api<Department[]>('/departments') });
  const [edit, setEdit] = useState<StockLocation | Partial<StockLocation> | null>(null);
  const without = (deps.data ?? []).filter((d) => d.is_active && d.type !== 'administrative' && !(q.data ?? []).some((l) => l.department_id === d.id));
  return (
    <div className="content">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <span className="hint grow">ნაშთი ითვლება ლოკაციაზე. განყოფილების ქვესაწყობიდან მოთხოვნას ამტკიცებს განყოფილების ხელმძღვანელი (თუ „დამტკიცება“ ჩართულია; ნარკოტიკულზე — ყოველთვის).</span>
        <label className="row small"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> გათიშულიც</label>
        {editable && <button className="btn primary" type="button" onClick={() => setEdit({})}>+ ლოკაცია</button>}
      </div>
      {editable && without.length > 0 && (
        <div className="alert info row" style={{ flexWrap: 'wrap', gap: 6 }}>
          <span>ქვესაწყობის გარეშე: </span>
          {without.map((d) => <button key={d.id} className="btn sm" type="button" onClick={() => setEdit({ code: deptCode(d.code), name: d.name, kind: 'department', department_id: d.id, requires_approval: true })}>+ {d.name}</button>)}
        </div>)}
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : (
        <div className="card">
          <table className="table">
            <thead><tr><th>კოდი</th><th>დასახელება</th><th>ტიპი</th><th>განყოფილება</th><th>მოთხოვნის დამტკიცება</th><th>სტატუსი</th></tr></thead>
            <tbody>{q.data?.map((l) => (
              <tr key={l.id} className={editable && l.kind !== 'transit' ? 'clickable' : undefined} onClick={() => editable && l.kind !== 'transit' && setEdit(l)}>
                <td className="mono">{l.code}</td><td><strong>{l.name}</strong></td><td>{LOCATION_KA[l.kind]}</td><td>{l.department_name ?? '—'}</td>
                <td>{l.requires_approval ? 'საჭიროა' : 'არა'}</td>
                <td>{l.is_active ? <span className="chip ok">აქტიური</span> : <span className="chip">გათიშული</span>}</td>
              </tr>))}</tbody>
          </table>
        </div>
      )}
      {edit && <LocationDialog l={edit} deps={deps.data ?? []} onClose={() => setEdit(null)} />}
    </div>
  );
}

function LocationDialog({ l, deps, onClose }: { l: Partial<StockLocation>; deps: Department[]; onClose: () => void }) {
  const qc = useQueryClient(); const isNew = !l.id;
  const all = useQuery({ queryKey: ['stock-locations', false], queryFn: () => api<StockLocation[]>('/stock/locations') });
  const srcs = (all.data ?? []).filter((x) => ['pharmacy', 'central', 'household'].includes(x.kind));
  const [f, setF] = useState({ code: l.code ?? '', name: l.name ?? '', kind: (l.kind ?? 'department') as LocationKind, department_id: l.department_id ?? '',
    requires_approval: l.requires_approval ?? true, is_active: l.is_active ?? true, sort_order: l.sort_order ?? 100, default_source_id: l.default_source_id ?? '' });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));
  const m = useMutation({
    mutationFn: () => {
      const body = { name: f.name.trim(), kind: f.kind, department_id: f.department_id || null, requires_approval: f.requires_approval, sort_order: f.sort_order, default_source_id: f.default_source_id || null, ...(isNew ? { code: f.code.trim() } : { is_active: f.is_active }) };
      return isNew ? api('/stock/locations', { body }) : api(`/stock/locations/${l.id}`, { method: 'PATCH', body });
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['stock-locations'] }); onClose(); },
  });
  return (
    <Modal title={isNew ? 'ახალი ლოკაცია' : `${l.name}`} onClose={onClose} width={640}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button>
        <button className="btn primary" type="submit" form="locf" disabled={m.isPending || f.name.trim().length < 2 || (isNew && !/^[A-Z][A-Z0-9_]{1,29}$/.test(f.code)) || (f.kind === 'department' && !f.department_id)}>შენახვა</button></>}>
      <form id="locf" onSubmit={(e) => { e.preventDefault(); m.mutate(); }} style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
        <Field label="კოდი" htmlFor="lc" required hint="დიდი ლათინური ასოები, ციფრები, _ (მაგ. D_SURG)"><input id="lc" className="input mono" disabled={!isNew} value={f.code} onChange={(e) => set('code', e.target.value.toUpperCase())} /></Field>
        <Field label="დასახელება" htmlFor="ln" required><input id="ln" className="input" value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
        <Field label="ტიპი" htmlFor="lk" required>
          <select id="lk" className="select" value={f.kind} onChange={(e) => set('kind', e.target.value as LocationKind)}>
            {(Object.keys(LOCATION_KA) as LocationKind[]).filter((k) => k !== 'transit').map((k) => <option key={k} value={k}>{LOCATION_KA[k]}</option>)}
          </select></Field>
        <Field label="განყოფილება" htmlFor="ld" required={f.kind === 'department'} hint="ხელმძღვანელი ამტკიცებს მოთხოვნას">
          <select id="ld" className="select" value={f.department_id} onChange={(e) => set('department_id', e.target.value)}>
            <option value="">—</option>{deps.filter((d) => d.is_active || d.id === f.department_id).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select></Field>
        <label className="row"><input type="checkbox" checked={f.requires_approval} onChange={(e) => set('requires_approval', e.target.checked)} /> მოთხოვნას სჭირდება დამტკიცება</label>
        {!isNew && <label className="row"><input type="checkbox" checked={f.is_active} onChange={(e) => set('is_active', e.target.checked)} /> აქტიური</label>}
        <Field label="ნაგულისხმევი მომწოდებელი ლოკაცია" htmlFor="ls" hint="მინ/მაქს-ის მოთხოვნისთვის">
          <select id="ls" className="select" value={f.default_source_id} onChange={(e) => set('default_source_id', e.target.value)}>
            <option value="">—</option>{srcs.filter((x) => x.id !== l.id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select></Field>
        <Field label="რიგი" htmlFor="lo"><input id="lo" className="input mono" type="number" value={f.sort_order} onChange={(e) => set('sort_order', Number(e.target.value))} /></Field>
        <div style={{ gridColumn: '1 / -1' }}><ErrorBox error={m.error} /></div>
      </form>
    </Modal>
  );
}
