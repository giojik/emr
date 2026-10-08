import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import type { Department } from '../../api/types';
import { ErrorBox, Field, Loading, Modal } from '../../components/ui';
import { useModules } from '../../lib/modules';
import { ALL_FEATURES, FEATURE_KA, LEVEL_KA, type IcuFeature } from '../inpatient/Icu';

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
                <td><strong>{d.name}</strong></td><td className="mono">{d.code}</td><td>{TYPES[d.type] ?? d.type}{d.care_level && d.care_level !== 'ward' && <span className="chip info" style={{ marginLeft: 6 }}>{LEVEL_KA[d.care_level]}</span>}</td>
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
  // 0047: რეანიმაცია / ინტენსიური
  const mods = useModules(); const icu = mods.data?.find((x) => x.code === 'icu');
  const icuDefaults = (lvl: string) => (lvl === 'icu' ? ALL_FEATURES : ((icu?.settings.intensive_features as IcuFeature[] | undefined) ?? []));
  const [level, setLevel] = useState<string>(d?.care_level ?? 'ward');
  const [own, setOwn] = useState<IcuFeature[] | null>((d?.icu_features as IcuFeature[] | null | undefined) ?? null);
  const [interval, setIntervalMin] = useState<string>(d?.monitor_interval_min ? String(d.monitor_interval_min) : '');
  const icuBody = type === 'inpatient' ? { care_level: level, icu_features: level === 'ward' ? null : own, monitor_interval_min: level === 'ward' || !interval ? null : Number(interval) } : {};
  const m = useMutation({
    mutationFn: () => d ? api(`/departments/${d.id}`, { method: 'PATCH', body: { name, type, is_active: active, ...icuBody } }) : api('/departments', { body: { name, code, type, ...(type === 'inpatient' && { care_level: level }) } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['departments'] }); void qc.invalidateQueries({ queryKey: ['doctors'] }); void qc.invalidateQueries({ queryKey: ['icu-deps'] }); onClose(); },
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
        {type === 'inpatient' && icu?.enabled && <>
          <Field label="დონე" htmlFor="dl" hint="რეანიმაცია / ინტენსიური — ICU ეპიზოდი იხსნება ავტომატურად, როცა პაციენტი აქ მოხვდება"><select id="dl" className="select" value={level} onChange={(e) => setLevel(e.target.value)}>
            {Object.entries(LEVEL_KA).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          {level !== 'ward' && d && <>
            <div className="stack" style={{ gap: 6 }}>
              <label className="row"><input type="checkbox" checked={own !== null} onChange={(e) => setOwn(e.target.checked ? icuDefaults(level) : null)} /> საკუთარი ფუნქციები (სხვაგვარად — დონის ნაგულისხმევი)</label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, opacity: own === null ? 0.6 : 1 }}>
                {ALL_FEATURES.map((f) => <label key={f} className="row small"><input type="checkbox" disabled={own === null} checked={(own ?? icuDefaults(level)).includes(f)}
                  onChange={(e) => setOwn((x) => { const cur = x ?? icuDefaults(level); return e.target.checked ? [...cur, f] : cur.filter((y) => y !== f); })} /> {FEATURE_KA[f]}</label>)}</div>
            </div>
            <Field label="ფურცლის ინტერვალი" htmlFor="di" hint={`ცარიელი — მოდულის (${String(icu?.settings.monitor_interval_min ?? 60)} წთ)`}><select id="di" className="select" value={interval} onChange={(e) => setIntervalMin(e.target.value)}>
              <option value="">მოდულის ნაგულისხმევი</option><option value="15">15 წთ</option><option value="30">30 წთ</option><option value="60">60 წთ</option></select></Field>
          </>}
        </>}
        {d && <label className="row"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> აქტიური</label>}
        <ErrorBox error={m.error} />
      </form>
    </Modal>
  );
}
