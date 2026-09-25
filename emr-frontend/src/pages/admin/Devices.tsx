import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import type { DxDevice } from '../../api/types';
import { ErrorBox, Field, Loading, Modal } from '../../components/ui';
import { MODALITY_KA } from '../../lib/format';

const MODS = ['CT', 'MR', 'US', 'DX', 'RF', 'MG', 'DXA'];

/** რადიოლოგიის აპარატები / კაბინეტები — ჩაწერის განრიგის სვეტები */
export default function Devices() {
  const q = useQuery({ queryKey: ['dx-devices', 'all'], queryFn: () => api<DxDevice[]>('/dx/devices', { query: { section: 'radiology', include_inactive: true } }) });
  const [edit, setEdit] = useState<DxDevice | 'new' | null>(null);
  return (
    <div className="content">
      <div className="row"><span className="muted grow">რადიოლოგიის აპარატები — განრიგის სვეტები. AE Title გამოიყენება dcm4chee-სთან კავშირისას (შემდეგი ეტაპი).</span>
        <button className="btn primary" type="button" onClick={() => setEdit('new')}>+ აპარატი</button></div>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : (
        <div className="card">
          <table className="table">
            <thead><tr><th>დასახელება</th><th>მოდალობა</th><th>კაბინეტი</th><th>სამუშაო საათები</th><th className="num">სლოტი</th><th>AE Title</th><th>სტატუსი</th></tr></thead>
            <tbody>{q.data?.map((d) => (
              <tr key={d.id} className="clickable" onClick={() => setEdit(d)}>
                <td><strong>{d.name}</strong></td><td>{d.modalities.map((m) => MODALITY_KA[m] ?? m).join(', ')}</td><td>{d.room ?? '—'}</td>
                <td className="mono">{d.work_start.slice(0, 5)}–{d.work_end.slice(0, 5)}</td><td className="num">{d.slot_minutes} წთ</td><td className="mono">{d.ae_title ?? '—'}</td>
                <td>{d.is_active ? <span className="chip ok">აქტიური</span> : <span className="chip">გათიშული</span>}</td>
              </tr>))}</tbody>
          </table>
        </div>
      )}
      {edit && <DeviceDialog d={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function DeviceDialog({ d, onClose }: { d: DxDevice | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ name: d?.name ?? '', room: d?.room ?? '', ae_title: d?.ae_title ?? '', slot_minutes: d?.slot_minutes ?? 20,
    work_start: d?.work_start.slice(0, 5) ?? '09:00', work_end: d?.work_end.slice(0, 5) ?? '18:00', is_active: d?.is_active ?? true, sort_order: d?.sort_order ?? 0 });
  const [mods, setMods] = useState<string[]>(d?.modalities ?? []);
  const m = useMutation({
    mutationFn: () => {
      const body = { ...f, room: f.room || null, ae_title: f.ae_title || null, modalities: mods, section: 'radiology' };
      return d ? api(`/dx/devices/${d.id}`, { method: 'PATCH', body }) : api('/dx/devices', { body });
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['dx-devices'] }); onClose(); },
  });
  return (
    <Modal title={d ? d.name : 'ახალი აპარატი'} onClose={onClose} width={600}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="submit" form="devf" disabled={m.isPending || !mods.length || !f.name.trim()}>შენახვა</button></>}>
      <form id="devf" onSubmit={(e) => { e.preventDefault(); m.mutate(); }} style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 14 }}>
        <Field label="დასახელება" htmlFor="dvn" required><input id="dvn" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="მაგ. CT Siemens 64" /></Field>
        <Field label="კაბინეტი" htmlFor="dvr"><input id="dvr" className="input" value={f.room} onChange={(e) => setF({ ...f, room: e.target.value })} placeholder="მაგ. 104" /></Field>
        <div style={{ gridColumn: '1 / -1' }}>
          <span className="label">მოდალობა <span className="req">*</span></span>
          <div className="row" style={{ flexWrap: 'wrap', gap: 12, marginTop: 6 }}>
            {MODS.map((x) => <label key={x} className="row"><input type="checkbox" checked={mods.includes(x)} onChange={(e) => setMods(e.target.checked ? [...mods, x] : mods.filter((y) => y !== x))} />{MODALITY_KA[x]}</label>)}
          </div>
        </div>
        <Field label="სამუშაოს დასაწყისი" htmlFor="dvs"><input id="dvs" className="input mono" type="time" value={f.work_start} onChange={(e) => setF({ ...f, work_start: e.target.value })} /></Field>
        <Field label="სამუშაოს დასასრული" htmlFor="dve"><input id="dve" className="input mono" type="time" value={f.work_end} onChange={(e) => setF({ ...f, work_end: e.target.value })} /></Field>
        <Field label="სლოტი (წთ)" htmlFor="dvsl" hint="კვლევის ხანგრძლივობა, თუ კატალოგში სხვა არ წერია"><input id="dvsl" className="input mono" type="number" min={5} max={240} value={f.slot_minutes} onChange={(e) => setF({ ...f, slot_minutes: Number(e.target.value) })} /></Field>
        <Field label="AE Title (DICOM)" htmlFor="dva" hint="dcm4chee Worklist — შემდეგ ეტაპზე"><input id="dva" className="input mono" value={f.ae_title} maxLength={16} onChange={(e) => setF({ ...f, ae_title: e.target.value.toUpperCase() })} /></Field>
        <Field label="რიგი" htmlFor="dvo"><input id="dvo" className="input mono" type="number" value={f.sort_order} onChange={(e) => setF({ ...f, sort_order: Number(e.target.value) })} /></Field>
        {d && <label className="row" style={{ alignSelf: 'end' }}><input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> აქტიური</label>}
        <div style={{ gridColumn: '1 / -1' }}><ErrorBox error={m.error} /></div>
      </form>
    </Modal>
  );
}
