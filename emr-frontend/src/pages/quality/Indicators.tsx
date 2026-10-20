import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import { ErrorBox, Field, Loading, Modal, useToast } from '../../components/ui';
import { type Classifier, EVENT_KA, type EventType, HARM_KA, type Harm, type QmIndicatorDef, SERVICE_KA } from './types';

/**
 * ინდიკატორები (0066) — ხარისხი → ცნობარები → „ინდიკატორები“ (quality).
 * მრიცხველი: კატეგორიები (ძირეული — ქვეკატეგორიებითაც), ტიპები, მინ. ზიანი, მხოლოდ პაციენტი, მომსახურების ტიპები; მნიშვნელი × მამრავლი.
 * ყოველ ინდიკატორს მენეჯერულ დაფაზე შეესაბამება KPI qm_ind_<code> (სამიზნე — ადმინისტრირება → რეპორტინგი).
 */
interface Form { code: string; name: string; description: string; category_ids: string[]; event_types: EventType[]; min_harm: Harm | ''; patient_only: boolean; service_types: string[];
  denominator: 'bed_days' | 'admissions' | 'visits'; per: number }
const EMPTY: Form = { code: '', name: '', description: '', category_ids: [], event_types: ['harm', 'no_harm'], min_harm: '', patient_only: true, service_types: ['inpatient'], denominator: 'bed_days', per: 1000 };
const DENOM: Record<string, string> = { bed_days: 'საწოლ-დღე', admissions: 'ჰოსპიტალიზაცია', visits: 'ვიზიტი' };

export default function QmIndicators() {
  const q = useQuery({ queryKey: ['qm-indicators', 'all'], queryFn: () => api<QmIndicatorDef[]>('/quality/indicators', { query: { all: 'true' } }) });
  const [edit, setEdit] = useState<QmIndicatorDef | 'new' | null>(null);
  return (
    <div className="stack">
      <div className="row"><span className="small muted grow">მაჩვენებელი = მრიცხველი / მნიშვნელი × მამრავლი (მაგ. 1000 საწოლ-დღეზე). ყოველი ინდიკატორი მენეჯერულ დაფაზეც ჩანს (KPI, ჯგუფი „ხარისხი“) — სამიზნე: ადმინისტრირება → რეპორტინგი.</span>
        <button className="btn primary sm" type="button" onClick={() => setEdit('new')}>+ ინდიკატორი</button></div>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : (
        <div className="card">
          <table className="table">
            <thead><tr><th>ინდიკატორი</th><th>მრიცხველი / მნიშვნელი</th><th>KPI</th><th /></tr></thead>
            <tbody>{q.data?.map((i) => (
              <tr key={i.id} style={{ opacity: i.is_active ? 1 : 0.55 }}>
                <td><strong>{i.name}</strong> <span className="mono small muted">{i.code}</span>{!i.is_active && <span className="chip" style={{ marginLeft: 6, height: 20 }}>გათიშული</span>}
                  {i.description && <div className="small muted">{i.description}</div>}</td>
                <td className="small">{i.formula}</td>
                <td className="mono small">{i.kpi_code}</td>
                <td><button className="btn sm" type="button" onClick={() => setEdit(i)}>შეცვლა</button></td>
              </tr>))}
              {!q.data?.length && <tr><td colSpan={4} className="muted">ინდიკატორი არ არის</td></tr>}
            </tbody>
          </table>
        </div>)}
      {edit && <IndicatorModal row={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function IndicatorModal({ row, onClose }: { row: QmIndicatorDef | null; onClose: () => void }) {
  const qc = useQueryClient(); const toast = useToast();
  const cats = useQuery({ queryKey: ['qm-classifiers', 'category'], queryFn: () => api<Classifier[]>('/quality/classifiers', { query: { kind: 'category' } }), staleTime: 5 * 60_000 });
  const [f, setF] = useState<Form>(() => (row ? { code: row.code, name: row.name, description: row.description ?? '', category_ids: row.category_ids, event_types: row.event_types,
    min_harm: row.min_harm ?? '', patient_only: row.patient_only, service_types: row.service_types, denominator: row.denominator, per: row.per } : EMPTY));
  const [active, setActive] = useState(row?.is_active ?? true);
  const [reason, setReason] = useState('');
  const set = (p: Partial<Form>) => setF((x) => ({ ...x, ...p }));
  const tog = <T,>(xs: T[], v: T) => (xs.includes(v) ? xs.filter((x) => x !== v) : [...xs, v]);
  const save = useMutation({
    mutationFn: () => {
      const body = { name: f.name.trim(), description: f.description.trim() || null, category_ids: f.category_ids, event_types: f.event_types, min_harm: f.min_harm || null,
        patient_only: f.patient_only, service_types: f.service_types, denominator: f.denominator, per: f.per };
      return row ? api(`/quality/indicators/${row.id}`, { method: 'PATCH', body: { ...body, is_active: active, reason: reason.trim() } }) : api('/quality/indicators', { body: { ...body, code: f.code } });
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['qm-indicators'] }); toast.show('შენახულია'); onClose(); },
  });
  const roots = (cats.data ?? []).filter((c) => !c.parent_id);
  const ok = (row || /^[a-z][a-z0-9_]{1,29}$/.test(f.code)) && f.name.trim().length >= 3 && f.category_ids.length > 0 && f.event_types.length > 0 && (!row || reason.trim().length >= 3);
  return (
    <Modal title={row ? `ინდიკატორი: ${row.name}` : 'ახალი ინდიკატორი'} onClose={onClose} width={760}
      footer={<><ErrorBox error={save.error} />{row && <input className="input" style={{ maxWidth: 320 }} aria-label="ცვლილების მიზეზი" placeholder="ცვლილების მიზეზი (სავალდებულო)" value={reason} onChange={(e) => setReason(e.target.value)} />}
        <button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={!ok || save.isPending} onClick={() => save.mutate()}>შენახვა</button></>}>
      {toast.node}
      <div className="stack" style={{ gap: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: 10 }}>
          <Field label="კოდი" htmlFor="qi-code" hint={row ? 'არ იცვლება' : 'lat_a_z, KPI: qm_ind_<კოდი>'}>
            <input id="qi-code" className="input mono" disabled={!!row} value={f.code} onChange={(e) => set({ code: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') })} /></Field>
          <Field label="დასახელება" htmlFor="qi-name"><input id="qi-name" className="input" value={f.name} onChange={(e) => set({ name: e.target.value })} /></Field>
        </div>
        <Field label="განმარტება" htmlFor="qi-desc"><input id="qi-desc" className="input" value={f.description} onChange={(e) => set({ description: e.target.value })} /></Field>
        <fieldset className="stack" style={{ gap: 4, border: 0, padding: 0 }}>
          <legend className="small" style={{ fontWeight: 600 }}>კატეგორიები (ძირეული — ქვეკატეგორიებითაც)</legend>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 4 }}>
            {roots.map((c) => <label key={c.id} className="row small"><input type="checkbox" checked={f.category_ids.includes(c.id)} onChange={() => set({ category_ids: tog(f.category_ids, c.id) })} /> {c.name}</label>)}
          </div>
          <details className="small"><summary>ქვეკატეგორიები</summary>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 4, marginTop: 6 }}>
              {(cats.data ?? []).filter((c) => c.parent_id).map((c) => <label key={c.id} className="row small"><input type="checkbox" checked={f.category_ids.includes(c.id)} onChange={() => set({ category_ids: tog(f.category_ids, c.id) })} />
                {roots.find((r) => r.id === c.parent_id)?.name} → {c.name}</label>)}
            </div></details>
        </fieldset>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <fieldset className="stack" style={{ gap: 4, border: 0, padding: 0 }}><legend className="small" style={{ fontWeight: 600 }}>ტიპები</legend>
            {(Object.keys(EVENT_KA) as EventType[]).map((e) => <label key={e} className="row small"><input type="checkbox" checked={f.event_types.includes(e)} onChange={() => set({ event_types: tog(f.event_types, e) })} /> {EVENT_KA[e][0]}</label>)}
          </fieldset>
          <fieldset className="stack" style={{ gap: 4, border: 0, padding: 0 }}><legend className="small" style={{ fontWeight: 600 }}>მომსახურების ტიპი (არცერთი — ყველა)</legend>
            {Object.entries(SERVICE_KA).map(([k, v]) => <label key={k} className="row small"><input type="checkbox" checked={f.service_types.includes(k)} onChange={() => set({ service_types: tog(f.service_types, k) })} /> {v}</label>)}
          </fieldset>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
          <Field label="მინიმალური ზიანი" htmlFor="qi-mh"><select id="qi-mh" className="select" value={f.min_harm} onChange={(e) => set({ min_harm: e.target.value as Harm | '' })}>
            <option value="">ნებისმიერი</option>{(['mild', 'moderate', 'severe', 'death'] as Harm[]).map((h) => <option key={h} value={h}>{HARM_KA[h]} და მეტი</option>)}</select></Field>
          <Field label="მნიშვნელი" htmlFor="qi-den"><select id="qi-den" className="select" value={f.denominator} onChange={(e) => set({ denominator: e.target.value as Form['denominator'] })}>
            {Object.entries(DENOM).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="მამრავლი" htmlFor="qi-per"><select id="qi-per" className="select" value={f.per} onChange={(e) => set({ per: Number(e.target.value) })}>
            {[100, 1000, 10000].map((x) => <option key={x} value={x}>{x}-ზე</option>)}</select></Field>
        </div>
        <label className="row small"><input type="checkbox" checked={f.patient_only} onChange={(e) => set({ patient_only: e.target.checked })} /> მხოლოდ პაციენტთან დაკავშირებული (ვის შეეხო = პაციენტი)</label>
        {row && <label className="row small"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> აქტიური (გათიშულზე KPI-ც ითიშება)</label>}
      </div>
    </Modal>
  );
}
