import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, can } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Field, Loading, Modal, useDebounced } from '../../components/ui';
import { dateGe, todayISO } from '../../lib/format';
import ItemSearch from '../stock/ItemSearch';
import { qtyFmt, type StockItem, type Supplier } from '../stock/types';
import { fmt, num, PO_EDIT, type PriceRow } from './types';

/** მომწოდებლის ფასთა ნუსხა: ერთ მომწოდებელს ერთ საქონელზე (ერთეულზე) ერთ დღეს — ერთი აქტიური ფასი; ახალი ფასისთვის ძველს ვადა დაუსრულეთ */
export default function Prices() {
  const { user } = useAuth();
  const [sup, setSup] = useState(''); const [search, setSearch] = useState(''); const ds = useDebounced(search.trim(), 300); const [current, setCurrent] = useState(true);
  const sups = useQuery({ queryKey: ['stock-suppliers', '', false], queryFn: () => api<Supplier[]>('/stock/suppliers') });
  const query = { supplier_id: sup, search: ds, current: String(current) };
  const q = useQuery({ queryKey: ['proc-prices', query], queryFn: () => api<PriceRow[]>('/procurement/prices', { query }) });
  const [edit, setEdit] = useState<PriceRow | 'new' | null>(null);
  return (
    <div className="content">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <select className="select" style={{ maxWidth: 260, height: 38 }} aria-label="მომწოდებელი" value={sup} onChange={(e) => setSup(e.target.value)}>
          <option value="">ყველა მომწოდებელი</option>{sups.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        <input className="input" style={{ maxWidth: 260, height: 38 }} aria-label="ძებნა" placeholder="საქონელი ან მომწოდებელი" value={search} onChange={(e) => setSearch(e.target.value)} />
        <label className="row small"><input type="checkbox" checked={current} onChange={(e) => setCurrent(e.target.checked)} /> მხოლოდ მოქმედი</label>
        <span className="grow" />
        {can(user, ...PO_EDIT) && <button className="btn primary" type="button" onClick={() => setEdit('new')}>+ ფასი</button>}
      </div>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : (
        <div className="card">
          <table className="table">
            <thead><tr><th>საქონელი</th><th>მომწოდებელი</th><th>ერთეული</th><th className="num">ფასი (დღგ-ს გ.)</th><th className="num">საბაზოზე</th><th>დღგ</th><th>მოქმედებს</th><th>ხელშეკრულება</th></tr></thead>
            <tbody>{q.data?.map((p) => (
              <tr key={p.id} className="clickable" onClick={() => setEdit(p)}>
                <td><strong>{p.item_name}</strong> <span className="mono small muted">{p.item_code}</span></td><td>{p.supplier_name}</td>
                <td>{p.pack_name ? `${p.pack_name} (${qtyFmt(p.pack_qty_base)})` : p.base_unit_name}</td>
                <td className="num mono">{fmt(p.price, 4)} ₾</td><td className="num mono small">{fmt(Number(p.price) / Number(p.pack_qty_base), 4)}</td><td>{Number(p.vat_rate)}%</td>
                <td className="mono small">{dateGe(p.valid_from)} — {p.valid_to ? dateGe(p.valid_to) : '∞'} {p.current ? <span className="chip ok">მოქმედი</span> : !p.is_active ? <span className="chip">გათიშული</span> : null}</td>
                <td className="small">{p.contract_no ?? '—'}</td>
              </tr>))}
              {!q.data?.length && <tr><td colSpan={8} className="muted">ფასი არ არის. ფასთა ნუსხა არასავალდებულოა — მის გარეშე შეკვეთაში ბოლო მიღების ფასი შემოგვთავაზდება.</td></tr>}
            </tbody>
          </table>
        </div>)}
      {edit && <PriceDialog p={edit === 'new' ? null : edit} supplier={sup} onClose={() => setEdit(null)} />}
    </div>
  );
}

function PriceDialog({ p, supplier, onClose }: { p: PriceRow | null; supplier: string; onClose: () => void }) {
  const { user } = useAuth(); const qc = useQueryClient(); const editable = can(user, ...PO_EDIT);
  const sups = useQuery({ queryKey: ['stock-suppliers', '', false], queryFn: () => api<Supplier[]>('/stock/suppliers') });
  const [item, setItem] = useState<Pick<StockItem, 'id' | 'name' | 'base_unit_name' | 'packs'> | null>(p ? { id: p.item_id, name: p.item_name, base_unit_name: p.base_unit_name, packs: [] } : null);
  useQuery({ queryKey: ['stock-item', p?.item_id], enabled: !!p, queryFn: async () => { const it = await api<StockItem>(`/stock/items/${p!.item_id}`); setItem(it); return it; } });
  const [f, setF] = useState({ supplier_id: p?.supplier_id ?? supplier, pack_id: p?.pack_id ?? '', price: p ? String(Number(p.price)) : '', vat_rate: p ? Number(p.vat_rate) : 18,
    min_qty: p?.min_qty ? qtyFmt(p.min_qty) : '', valid_from: p?.valid_from ?? todayISO(), valid_to: p?.valid_to ?? '', contract_no: p?.contract_no ?? '', notes: p?.notes ?? '', is_active: p?.is_active ?? true });
  const m = useMutation({
    mutationFn: () => {
      const body = { supplier_id: f.supplier_id, item_id: item!.id, pack_id: f.pack_id || null, price: num(f.price), vat_rate: f.vat_rate, min_qty: f.min_qty ? num(f.min_qty) : null,
        valid_from: f.valid_from, valid_to: f.valid_to || null, contract_no: f.contract_no || null, notes: f.notes || null, is_active: f.is_active };
      return p ? api(`/procurement/prices/${p.id}`, { method: 'PUT', body }) : api('/procurement/prices', { body });
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['proc-prices'] }); onClose(); },
  });
  return (
    <Modal title={p ? `${p.item_name} — ${p.supplier_name}` : 'ახალი ფასი'} onClose={onClose} width={680}
      footer={<><button className="btn" type="button" onClick={onClose}>{editable ? 'გაუქმება' : 'დახურვა'}</button>
        {editable && <button className="btn primary" type="submit" form="prf" disabled={m.isPending || !item || !f.supplier_id || f.price.trim() === ''}>შენახვა</button>}</>}>
      <form id="prf" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <fieldset disabled={!editable} style={{ border: 0, padding: 0, margin: 0, display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
          <Field label="მომწოდებელი" htmlFor="ps" required><select id="ps" className="select" value={f.supplier_id} onChange={(e) => setF({ ...f, supplier_id: e.target.value })}>
            <option value="">— აირჩიეთ —</option>{sups.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
          <div className="field"><label>საქონელი <span className="req">*</span></label>{item ? <div className="row"><strong className="grow">{item.name}</strong>{!p && <button className="btn sm" type="button" onClick={() => setItem(null)}>შეცვლა</button>}</div>
            : <ItemSearch onPick={(i) => { setItem(i); setF((x) => ({ ...x, pack_id: i.packs.find((k) => k.is_receipt_default)?.id ?? '' })); }} />}</div>
          <Field label="ერთეული" htmlFor="pp"><select id="pp" className="select" value={f.pack_id} onChange={(e) => setF({ ...f, pack_id: e.target.value })}>
            <option value="">{item?.base_unit_name ?? 'საბაზო'}</option>{item?.packs.map((k) => <option key={k.id} value={k.id}>{k.name} ({qtyFmt(k.qty_base)})</option>)}</select></Field>
          <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
            <Field label="ფასი (დღგ-ს გარეშე, ₾)" htmlFor="pr" required><input id="pr" className="input mono" inputMode="decimal" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} /></Field>
            <Field label="დღგ" htmlFor="pv"><select id="pv" className="select" style={{ width: 80 }} value={f.vat_rate} onChange={(e) => setF({ ...f, vat_rate: Number(e.target.value) })}><option value={18}>18%</option><option value={0}>0%</option></select></Field></div>
          <Field label="მოქმედებს — დან" htmlFor="pf" required><input id="pf" className="input mono" type="date" value={f.valid_from} onChange={(e) => setF({ ...f, valid_from: e.target.value })} /></Field>
          <Field label="მოქმედებს — მდე" htmlFor="pt" hint="ცარიელი — უვადო"><input id="pt" className="input mono" type="date" min={f.valid_from} value={f.valid_to} onChange={(e) => setF({ ...f, valid_to: e.target.value })} /></Field>
          <Field label="მინ. შეკვეთა (ერთეულში)" htmlFor="pm"><input id="pm" className="input mono" inputMode="decimal" value={f.min_qty} onChange={(e) => setF({ ...f, min_qty: e.target.value })} /></Field>
          <Field label="ხელშეკრულება / ტენდერი" htmlFor="pc"><input id="pc" className="input" value={f.contract_no} onChange={(e) => setF({ ...f, contract_no: e.target.value })} /></Field>
          <div style={{ gridColumn: '1 / -1' }}><Field label="შენიშვნა" htmlFor="pn"><input id="pn" className="input" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field></div>
          {p && <label className="row"><input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> აქტიური</label>}
        </fieldset>
        <ErrorBox error={m.error} />
      </form>
    </Modal>
  );
}
