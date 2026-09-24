import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import type { DxSection, DxService } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Field, Loading, Modal, useDebounced } from '../../components/ui';
import { money, SECTION_KA, unitFmt } from '../../lib/format';

interface Range { sex: 'male' | 'female' | null; age_min_days: number; age_max_days: number; low: string | null; high: string | null; normal_text: string | null }
interface Analyte { id: string; code: string; name: string; unit: string; result_type: 'numeric' | 'text' | 'select'; decimals: number | null; options: string | null; critical_low: string | null; critical_high: string | null; sort_order: number; is_active: boolean; ranges: Range[] }
type ServiceDetail = DxService & { analytes: Analyte[] };

export default function Catalog() {
  const [section, setSection] = useState<DxSection>('lab');
  const [search, setSearch] = useState(''); const [inactive, setInactive] = useState(false);
  const [edit, setEdit] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const { user } = useAuth();
  const canCreate = user?.role === 'admin' || ((user?.role === 'lab_manager' || user?.role === 'lab_doctor') && section === 'lab');
  const ds = useDebounced(search.trim(), 250);
  const q = useQuery({ queryKey: ['dx-catalog-admin', section, ds, inactive], queryFn: () => api<DxService[]>('/dx/catalog', { query: { section, search: ds, include_inactive: inactive } }) });
  const unreviewed = q.data?.filter((s) => s.needs_review).length ?? 0;
  const noPrice = q.data?.filter((s) => Number(s.base_price) <= 0).length ?? 0;
  return (
    <div className="content">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <div className="seg" role="group" aria-label="განყოფილება">{(['lab', 'radiology', 'endoscopy'] as DxSection[]).map((s) => <button key={s} type="button" aria-pressed={section === s} onClick={() => setSection(s)}>{SECTION_KA[s]}</button>)}</div>
        <input aria-label="ძებნა" className="input" style={{ maxWidth: 300, height: 38 }} placeholder="დასახელება ან კოდი" value={search} onChange={(e) => setSearch(e.target.value)} />
        <label className="row small"><input type="checkbox" checked={inactive} onChange={(e) => setInactive(e.target.checked)} /> გათიშულებიც</label>
        {canCreate && <button className="btn primary" type="button" style={{ marginLeft: 'auto' }} onClick={() => setCreating(true)}>{section === 'lab' ? '+ ახალი ანალიზი' : '+ ახალი კვლევა'}</button>}
      </div>
      {(unreviewed > 0 || noPrice > 0) && <div className="alert warn">{unreviewed > 0 && `${unreviewed} კვლევა გადასამოწმებელია (საწყისი შაბლონი). `}{noPrice > 0 && `${noPrice} კვლევას ფასი არ აქვს.`}</div>}
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : (
        <div className="card">
          <table className="table">
            <thead><tr><th>კვლევა</th><th>ჯგუფი</th>{section === 'lab' && <th>სინჯარა</th>}<th>შესრულება</th><th className="num">ფასი</th><th>სტატუსი</th></tr></thead>
            <tbody>{q.data?.map((s) => (
              <tr key={s.id} className="clickable" onClick={() => setEdit(s.id)}>
                <td><strong>{s.name}</strong><div className="mono small muted">{s.code}</div></td>
                <td className="small">{s.group_name}</td>
                {section === 'lab' && <td className="small">{s.container ?? s.specimen_type}</td>}
                <td className="small">{s.performed_by === 'internal' ? 'შიდა' : `გარე${s.external_lab ? `: ${s.external_lab}` : ''}`}</td>
                <td className="num">{Number(s.base_price) > 0 ? money(s.base_price) : <span className="chip warn">—</span>}</td>
                <td>{!s.is_active ? <span className="chip">გათიშული</span> : s.needs_review ? <span className="chip warn">გადასამოწმებელი</span> : <span className="chip ok">დამტკიცებული</span>}</td>
              </tr>))}</tbody>
          </table>
        </div>
      )}
      {edit && <ServiceDialog id={edit} onClose={() => setEdit(null)} />}
      {creating && <CreateServiceDialog section={section} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setEdit(id); }} />}
    </div>
  );
}

const SPECIMENS: [string, string][] = [['blood', 'სისხლი (მთლიანი)'], ['serum', 'შრატი'], ['plasma', 'პლაზმა'], ['urine', 'შარდი'], ['stool', 'განავალი'], ['swab', 'ნაცხი'], ['other', 'სხვა']];
const CONTAINERS = ['EDTA', 'Serum gel', 'Citrate', 'Heparin', 'Fluoride', 'Urine container', 'Stool container', 'Swab'];
const MODALITIES: [string, string][] = [['CT', 'კომპიუტერული ტომოგრაფია'], ['MR', 'მაგნიტურ-რეზონანსული ტომოგრაფია'], ['US', 'ულტრაბგერა'], ['DX', 'რენტგენოგრაფია'], ['RF', 'რენტგენოსკოპია'], ['MG', 'მამოგრაფია'], ['DXA', 'დენსიტომეტრია']];

/** ახალი ანალიზის ფორმა / კვლევა — შექმნის შემდეგ იხსნება კომპონენტების დასამატებლად */
function CreateServiceDialog({ section, onClose, onCreated }: { section: DxSection; onClose: () => void; onCreated: (id: string) => void }) {
  const qc = useQueryClient(); const { user } = useAuth();
  const groups = useQuery({ queryKey: ['dx-groups', section], queryFn: () => api<string[]>('/dx/catalog/groups', { query: { section } }) });
  const [f, setF] = useState({ name: '', code: '', group_name: '', specimen_type: 'serum', container: 'Serum gel', modality: 'CT', performed_by: 'internal', external_lab: '', base_price: '' });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const canPrice = user?.role === 'admin' || user?.role === 'billing';
  const prefix = section === 'lab' ? 'LAB_' : section === 'radiology' ? 'RAD_' : 'ENDO_';
  const m = useMutation({
    mutationFn: () => api<{ id: string }>('/dx/catalog', { body: {
      section, code: f.code.startsWith(prefix) ? f.code : prefix + f.code, name: f.name, group_name: section === 'radiology' ? MODALITIES.find(([k]) => k === f.modality)![1] : f.group_name,
      ...(section === 'lab' ? { specimen_type: f.specimen_type, container: f.container || undefined } : {}),
      ...(section === 'radiology' ? { modality: f.modality } : {}),
      performed_by: f.performed_by, external_lab: f.performed_by === 'external' ? f.external_lab || undefined : undefined,
      ...(canPrice && f.base_price ? { base_price: Number(f.base_price) } : {}),
    } }),
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ['dx-catalog-admin'] }); void qc.invalidateQueries({ queryKey: ['dx-catalog'] }); onCreated(r.id); },
  });
  const valid = f.name.trim().length >= 2 && f.code.trim().length >= 2 && (section === 'radiology' || f.group_name.trim().length >= 2);
  return (
    <Modal title={section === 'lab' ? 'ახალი ანალიზი' : `ახალი კვლევა — ${SECTION_KA[section]}`} onClose={onClose} width={680}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={!valid || m.isPending} onClick={() => m.mutate()}>{section === 'lab' ? 'შექმნა და კომპონენტების დამატება' : 'შექმნა'}</button></>}>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
        <Field label="დასახელება" htmlFor="cn" required><input id="cn" className="input" value={f.name} onChange={set('name')} placeholder={section === 'lab' ? 'მაგ. ფერიტინი' : ''} autoFocus /></Field>
        <Field label="კოდი" htmlFor="cc" required hint={`ლათინური, მაგ. ${prefix}FERR`}><input id="cc" className="input mono" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '') })} /></Field>
        {section === 'radiology' ? (
          <Field label="მოდალობა" htmlFor="cm"><select id="cm" className="select" value={f.modality} onChange={set('modality')}>{MODALITIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        ) : (
          <Field label="ჯგუფი" htmlFor="cg" required hint="არსებულიდან ან ახალი"><input id="cg" className="input" list="dx-groups" value={f.group_name} onChange={set('group_name')} placeholder={section === 'lab' ? 'მაგ. ბიოქიმია' : ''} />
            <datalist id="dx-groups">{groups.data?.map((g) => <option key={g} value={g} />)}</datalist></Field>
        )}
        {canPrice ? <Field label="ფასი (₾)" htmlFor="cp"><input id="cp" className="input mono" inputMode="decimal" value={f.base_price} onChange={set('base_price')} /></Field>
          : <div className="hint" style={{ alignSelf: 'end', paddingBottom: 10 }}>ფასს დააყენებს ადმინისტრატორი / მოლარე</div>}
        {section === 'lab' && <>
          <Field label="ნიმუში" htmlFor="cs"><select id="cs" className="select" value={f.specimen_type} onChange={set('specimen_type')}>{SPECIMENS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          <Field label="სინჯარა / კონტეინერი" htmlFor="ct" hint="ერთნაირ სინჯარაზე ანალიზები ერთ შტრიხკოდზე ჯგუფდება"><input id="ct" className="input" list="dx-containers" value={f.container} onChange={set('container')} />
            <datalist id="dx-containers">{CONTAINERS.map((c) => <option key={c} value={c} />)}</datalist></Field>
        </>}
      </div>
      {section === 'lab' && (
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <div className="seg" role="group" aria-label="შესრულება">
            <button type="button" aria-pressed={f.performed_by === 'internal'} onClick={() => setF({ ...f, performed_by: 'internal' })}>შიდა ლაბორატორია</button>
            <button type="button" aria-pressed={f.performed_by === 'external'} onClick={() => setF({ ...f, performed_by: 'external' })}>გარე ლაბორატორია</button>
          </div>
          {f.performed_by === 'external' && <input aria-label="გარე ლაბორატორია" className="input" style={{ maxWidth: 280, height: 38 }} placeholder="ლაბორატორიის დასახელება" value={f.external_lab} onChange={set('external_lab')} />}
        </div>
      )}
      <ErrorBox error={m.error} />
    </Modal>
  );
}

function ServiceDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient(); const { user } = useAuth();
  const q = useQuery({ queryKey: ['dx-service', id], queryFn: () => api<ServiceDetail>(`/dx/catalog/${id}`) });
  const [f, setF] = useState<{ name: string; group_name: string; container: string; price: string; performed_by: 'internal' | 'external'; external_lab: string; is_active: boolean } | null>(null);
  const [analyte, setAnalyte] = useState<Analyte | 'new' | null>(null);
  const s = q.data;
  if (s && !f) setF({ name: s.name, group_name: s.group_name, container: s.container ?? '', price: Number(s.base_price).toFixed(2), performed_by: s.performed_by, external_lab: s.external_lab ?? '', is_active: s.is_active });
  const role = user?.role;
  const canEdit = role === 'admin' || ((role === 'lab_manager' || role === 'lab_doctor') && s?.section === 'lab');
  const canPrice = role === 'admin' || role === 'billing';
  const canApprove = role === 'admin' || (role === 'lab_doctor' && s?.section === 'lab');
  const canAnalytes = role === 'admin' || role === 'lab_manager' || role === 'lab_doctor';
  const isAdmin = canEdit || canPrice;
  const save = useMutation({
    mutationFn: (approve: boolean) => api(`/dx/catalog/${id}`, { method: 'PATCH', body: {
      ...(canEdit ? { name: f!.name, group_name: f!.group_name, ...(s!.section === 'lab' ? { container: f!.container || null } : {}), performed_by: f!.performed_by, external_lab: f!.performed_by === 'external' ? f!.external_lab || null : null, is_active: f!.is_active } : {}),
      ...(canPrice ? { base_price: Number(f!.price) } : {}), ...(approve ? { approve: true } : {}),
    } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['dx-catalog-admin'] }); void qc.invalidateQueries({ queryKey: ['dx-catalog'] }); onClose(); },
  });
  return (
    <Modal title={s?.name ?? '…'} onClose={onClose} width={900}
      footer={isAdmin && f ? <>
        <button className="btn" type="button" onClick={onClose}>დახურვა</button>
        <button className="btn" type="button" disabled={save.isPending} onClick={() => save.mutate(false)}>შენახვა</button>
        {s?.needs_review && canApprove && <button className="btn primary" type="button" disabled={save.isPending} onClick={() => save.mutate(true)}>შენახვა და დამტკიცება</button>}
      </> : <button className="btn" type="button" onClick={onClose}>დახურვა</button>}>
      {!s || !f ? <Loading /> : (<>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
          <Field label="დასახელება" htmlFor="sn"><input id="sn" className="input" value={f.name} disabled={!canEdit} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="ფასი (₾)" htmlFor="sp" hint={canPrice ? undefined : 'ცვლის ადმინი / მოლარე'}><input id="sp" className="input mono" inputMode="decimal" value={f.price} disabled={!canPrice} onChange={(e) => setF({ ...f, price: e.target.value })} /></Field>
          <Field label="ჯგუფი" htmlFor="sg"><input id="sg" className="input" value={f.group_name} disabled={!canEdit} onChange={(e) => setF({ ...f, group_name: e.target.value })} /></Field>
          {s.section === 'lab' && <Field label="სინჯარა" htmlFor="sc"><input id="sc" className="input" value={f.container} disabled={!canEdit} onChange={(e) => setF({ ...f, container: e.target.value })} /></Field>}
        </div>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <div className="seg" role="group" aria-label="შესრულება">
            <button type="button" disabled={!canEdit} aria-pressed={f.performed_by === 'internal'} onClick={() => setF({ ...f, performed_by: 'internal' })}>შიდა</button>
            <button type="button" disabled={!canEdit} aria-pressed={f.performed_by === 'external'} onClick={() => setF({ ...f, performed_by: 'external' })}>გარე ლაბორატორია</button>
          </div>
          {f.performed_by === 'external' && <input aria-label="გარე ლაბორატორია" className="input" style={{ maxWidth: 280, height: 38 }} placeholder="ლაბორატორიის დასახელება" value={f.external_lab} disabled={!canEdit} onChange={(e) => setF({ ...f, external_lab: e.target.value })} />}
          <label className="row"><input type="checkbox" checked={f.is_active} disabled={!canEdit} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> აქტიური</label>
        </div>
        <span className="small muted mono">{s.code} · {s.group_name}{s.container ? ` · ${s.container}` : ''}{s.modality ? ` · ${s.modality}` : ''}{s.contrast ? ` · კონტრასტი: ${s.contrast}` : ''}</span>
        {s.section === 'lab' && (
          <div className="stack">
            <div className="row"><h3 className="grow">კომპონენტები და ნორმები</h3>{canAnalytes && <button className="btn sm" type="button" onClick={() => setAnalyte('new')}>+ კომპონენტი</button>}</div>
            {s.analytes.length === 0 && <div className="alert warn">ანალიზს კომპონენტები ჯერ არ აქვს — შედეგის შეტანა შეუძლებელი იქნება. დაამატეთ მინიმუმ ერთი.</div>}
            <table className="table">
              <thead><tr><th>კომპონენტი</th><th>ერთეული</th><th>ნორმა</th><th>კრიტიკული</th></tr></thead>
              <tbody>{s.analytes.map((a) => (
                <tr key={a.id} className={canAnalytes ? 'clickable' : undefined} onClick={() => canAnalytes && setAnalyte(a)} style={a.is_active ? undefined : { opacity: 0.5 }}>
                  <td><strong>{a.name}</strong> <span className="mono small muted">{a.code}</span></td>
                  <td className="small">{unitFmt(a.unit)}</td>
                  <td className="small">{a.ranges.map((r, i) => <div key={i}>{r.sex ? (r.sex === 'male' ? 'მ: ' : 'ქ: ') : ''}{r.normal_text ?? `${r.low ?? '…'} – ${r.high ?? '…'}`}</div>)}</td>
                  <td className="small">{a.critical_low ?? ''}{a.critical_low || a.critical_high ? ' / ' : ''}{a.critical_high ?? ''}</td>
                </tr>))}</tbody>
            </table>
            <span className="hint">კომპონენტის ან ნორმის შეცვლა კვლევას ხელახლა „გადასამოწმებლად“ აბრუნებს. უკვე შეყვანილი შედეგები ინახავს იმ ნორმას, რომელიც შეყვანის მომენტში მოქმედებდა.</span>
          </div>
        )}
        <ErrorBox error={save.error} />
      </>)}
      {analyte && s && <AnalyteDialog serviceId={s.id} a={analyte === 'new' ? null : analyte} onClose={() => setAnalyte(null)} />}
    </Modal>
  );
}

function AnalyteDialog({ serviceId, a, onClose }: { serviceId: string; a: Analyte | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ code: a?.code ?? '', name: a?.name ?? '', unit: a?.unit ?? '', result_type: a?.result_type ?? 'numeric', decimals: a?.decimals?.toString() ?? '1',
    options: a?.options ?? '', critical_low: a?.critical_low ?? '', critical_high: a?.critical_high ?? '', sort_order: String(a?.sort_order ?? 99), is_active: a?.is_active ?? true });
  const [ranges, setRanges] = useState<Range[]>(a?.ranges ?? [{ sex: null, age_min_days: 0, age_max_days: 54750, low: null, high: null, normal_text: null }]);
  const num = (v: string | null) => (v === null || v === '' ? null : Number(v));
  const m = useMutation({
    mutationFn: () => api(`/dx/catalog/${serviceId}/analytes`, { body: {
      id: a?.id, code: f.code, name: f.name, unit: f.unit, result_type: f.result_type, decimals: f.result_type === 'numeric' ? Number(f.decimals) : null,
      options: f.result_type === 'select' ? f.options : null, critical_low: num(f.critical_low), critical_high: num(f.critical_high), sort_order: Number(f.sort_order), is_active: f.is_active,
      ranges: ranges.map((r) => ({ sex: r.sex, age_min_days: Number(r.age_min_days), age_max_days: Number(r.age_max_days), low: num(r.low), high: num(r.high), normal_text: r.normal_text || null })),
    } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['dx-service', serviceId] }); onClose(); },
  });
  const setR = (i: number, k: keyof Range, v: string | null) => setRanges(ranges.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return (
    <Modal title={a ? a.name : 'ახალი კომპონენტი'} onClose={onClose} width={820}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={!f.code || !f.name || m.isPending} onClick={() => m.mutate()}>შენახვა</button></>}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr 1fr 1fr', gap: 10 }}>
        <Field label="კოდი" htmlFor="ac"><input id="ac" className="input mono" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
        <Field label="დასახელება" htmlFor="an"><input id="an" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="ერთეული" htmlFor="au"><input id="au" className="input mono" value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} placeholder="10^9/L" /></Field>
        <Field label="ტიპი" htmlFor="at"><select id="at" className="select" value={f.result_type} onChange={(e) => setF({ ...f, result_type: e.target.value as Analyte['result_type'] })}><option value="numeric">რიცხვი</option><option value="select">არჩევანი</option><option value="text">ტექსტი</option></select></Field>
        {f.result_type === 'select' && <div style={{ gridColumn: '1 / -1' }}><Field label="ვარიანტები (| -ით)" htmlFor="ao"><input id="ao" className="input" value={f.options} onChange={(e) => setF({ ...f, options: e.target.value })} placeholder="უარყოფითი|დადებითი" /></Field></div>}
        {f.result_type === 'numeric' && <>
          <Field label="ათწილადი" htmlFor="ad"><input id="ad" className="input mono" value={f.decimals} onChange={(e) => setF({ ...f, decimals: e.target.value })} /></Field>
          <Field label="კრიტ. ქვედა" htmlFor="acl"><input id="acl" className="input mono" value={f.critical_low} onChange={(e) => setF({ ...f, critical_low: e.target.value })} /></Field>
          <Field label="კრიტ. ზედა" htmlFor="ach"><input id="ach" className="input mono" value={f.critical_high} onChange={(e) => setF({ ...f, critical_high: e.target.value })} /></Field>
        </>}
        <Field label="რიგი" htmlFor="as"><input id="as" className="input mono" value={f.sort_order} onChange={(e) => setF({ ...f, sort_order: e.target.value })} /></Field>
      </div>
      <label className="row"><input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> აქტიური</label>
      <div className="row"><h3 className="grow">ნორმები</h3><button className="btn sm" type="button" onClick={() => setRanges([...ranges, { sex: null, age_min_days: 0, age_max_days: 54750, low: null, high: null, normal_text: null }])}>+ ნორმა</button></div>
      <table className="table">
        <thead><tr><th>სქესი</th><th>ასაკი (დღე) დან</th><th>მდე</th>{f.result_type === 'numeric' ? <><th>ქვედა</th><th>ზედა</th></> : <th>ნორმალური მნიშვნელობა</th>}<th /></tr></thead>
        <tbody>{ranges.map((r, i) => (
          <tr key={i}>
            <td><select aria-label="სქესი" className="select" style={{ height: 34 }} value={r.sex ?? ''} onChange={(e) => setR(i, 'sex', e.target.value || null)}><option value="">ორივე</option><option value="male">მამრ.</option><option value="female">მდედრ.</option></select></td>
            <td><input aria-label="ასაკი დან" className="input mono" style={{ height: 34 }} value={r.age_min_days} onChange={(e) => setR(i, 'age_min_days', e.target.value)} /></td>
            <td><input aria-label="ასაკი მდე" className="input mono" style={{ height: 34 }} value={r.age_max_days} onChange={(e) => setR(i, 'age_max_days', e.target.value)} /></td>
            {f.result_type === 'numeric' ? <>
              <td><input aria-label="ქვედა" className="input mono" style={{ height: 34 }} value={r.low ?? ''} onChange={(e) => setR(i, 'low', e.target.value)} /></td>
              <td><input aria-label="ზედა" className="input mono" style={{ height: 34 }} value={r.high ?? ''} onChange={(e) => setR(i, 'high', e.target.value)} /></td>
            </> : <td><input aria-label="ნორმა" className="input" style={{ height: 34 }} value={r.normal_text ?? ''} onChange={(e) => setR(i, 'normal_text', e.target.value)} /></td>}
            <td><button className="icon-btn" type="button" aria-label="წაშლა" onClick={() => setRanges(ranges.filter((_, j) => j !== i))}>×</button></td>
          </tr>))}</tbody>
      </table>
      <span className="hint">ასაკი დღეებში: 1 წელი = 365, 18 წელი = 6570. ბავშვების ნორმებისთვის დაამატეთ ცალკე ხაზები.</span>
      <ErrorBox error={m.error} />
    </Modal>
  );
}
