import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, can } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Field, Loading, Modal, Spinner, useDebounced } from '../../components/ui';
import { CATALOG_EDIT, CLINICAL_EDIT } from './Stock';
import { CONTROLLED_KA, DOSE_UNITS, genericLabel, nul, useStockRefs, type Controlled, type MedGeneric } from './types';

/** ჯენერიკები: INN + ფორმა + დოზა + ATC; კლინიკური ველები (კონტროლის კლასი, დოზის ზღვრები, ალერგენები) — ფარმაცევტი */
export default function Generics() {
  const { user } = useAuth();
  const [search, setSearch] = useState(''); const [controlled, setControlled] = useState(false); const [all, setAll] = useState(false);
  const ds = useDebounced(search.trim(), 250);
  const q = useQuery({ queryKey: ['med-generics', ds, controlled, all], queryFn: () => api<MedGeneric[]>('/pharmacy/generics', { query: { search: ds, controlled, all } }) });
  const [edit, setEdit] = useState<MedGeneric | 'new' | null>(null);
  const editable = can(user, ...CATALOG_EDIT);
  return (
    <div className="content">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <input className="input" style={{ maxWidth: 360, height: 38 }} aria-label="ძებნა" placeholder="INN, ლათინური დასახელება ან ATC" value={search} onChange={(e) => setSearch(e.target.value)} />
        <label className="row small"><input type="checkbox" checked={controlled} onChange={(e) => setControlled(e.target.checked)} /> მხოლოდ კონტროლირებადი</label>
        <label className="row small"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> გათიშულიც</label>
        <span className="grow" />
        {editable && <button className="btn primary" type="button" onClick={() => setEdit('new')}>+ ჯენერიკი</button>}
      </div>
      <span className="hint">ჯენერიკი = „რა წამალი“ (INN + ფორმა + დოზა). მასზე იწერება ალერგია, ურთიერთქმედება, დოზის ზღვრები და კონტროლის კლასი — ყველა სავაჭრო დასახელებისთვის ერთად.</span>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : (
        <div className="card">
          <table className="table">
            <thead><tr><th>INN</th><th>ფორმა</th><th>დოზა</th><th>ATC</th><th>ნიშნები</th><th className="num">საქონელი</th><th>სტატუსი</th></tr></thead>
            <tbody>{q.data?.map((g) => (
              <tr key={g.id} className="clickable" onClick={() => setEdit(g)}>
                <td><strong>{g.inn}</strong>{g.inn_latin && <span className="small muted"> · {g.inn_latin}</span>}</td>
                <td>{g.form_name}</td><td>{g.strength ?? '—'}</td><td className="mono">{g.atc_code ?? '—'}</td>
                <td><GenericFlags g={g} /></td>
                <td className="num">{g.items}</td>
                <td>{g.is_active ? <span className="chip ok">აქტიური</span> : <span className="chip">გათიშული</span>}</td>
              </tr>))}
              {!q.data?.length && <tr><td colSpan={7} className="muted">ჩანაწერი არ არის</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {edit && <GenericDialog g={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

export function GenericFlags({ g }: { g: Pick<MedGeneric, 'controlled_class' | 'high_alert' | 'reserve_antibiotic' | 'patient_only' | 'allergen_groups'> }) {
  return (
    <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
      {g.controlled_class && <span className="chip danger" style={{ height: 20, fontSize: 11 }}>{CONTROLLED_KA[g.controlled_class]}</span>}
      {g.high_alert && <span className="chip warn" style={{ height: 20, fontSize: 11 }}>მაღალი რისკი</span>}
      {g.reserve_antibiotic && <span className="chip warn" style={{ height: 20, fontSize: 11 }}>სარეზერვო</span>}
      {g.patient_only && <span className="chip info" style={{ height: 20, fontSize: 11 }}>მხოლოდ პაციენტზე</span>}
      {g.allergen_groups.length > 0 && <span className="chip" style={{ height: 20, fontSize: 11 }} title={g.allergen_groups.join(', ')}>ალერგენი: {g.allergen_groups.length}</span>}
    </div>
  );
}

const n2s = (v: string | number | null | undefined) => (v === null || v === undefined ? '' : String(Number(v)));
const s2n = (v: string) => (v.trim() === '' ? null : Number(v.replace(',', '.')));

/** ჯენერიკის ფორმა; onSaved — ახლად შექმნილის არჩევისთვის (საქონლის ფორმიდან) */
export function GenericDialog({ g, onClose, onSaved, initialInn }: { g: MedGeneric | null; onClose: () => void; onSaved?: (g: MedGeneric) => void; initialInn?: string }) {
  const { user } = useAuth(); const refs = useStockRefs(); const qc = useQueryClient();
  const clinical = can(user, ...CLINICAL_EDIT); const editable = can(user, ...CATALOG_EDIT);
  const [f, setF] = useState({
    inn: g?.inn ?? initialInn ?? '', inn_latin: g?.inn_latin ?? '', atc_code: g?.atc_code ?? '', form_code: g?.form_code ?? '', strength: g?.strength ?? '', notes: g?.notes ?? '', is_active: g?.is_active ?? true,
    controlled_class: (g?.controlled_class ?? '') as Controlled | '', high_alert: g?.high_alert ?? false, reserve_antibiotic: g?.reserve_antibiotic ?? false, patient_only: g?.patient_only ?? false,
    dose_unit: g?.dose_unit ?? '', dose_per_unit: n2s(g?.dose_per_unit), max_single_dose: n2s(g?.max_single_dose), max_daily_dose: n2s(g?.max_daily_dose),
    ped_max_single_per_kg: n2s(g?.ped_max_single_per_kg), ped_max_daily_per_kg: n2s(g?.ped_max_daily_per_kg), min_age_days: n2s(g?.min_age_days),
  });
  const [routes, setRoutes] = useState<string[]>(g?.routes ?? []);
  const [allergens, setAllergens] = useState<string[]>(g?.allergen_groups ?? []);
  const set = (k: keyof typeof f, v: string | boolean) => setF((p) => ({ ...p, [k]: v }));
  const m = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { inn: f.inn.trim(), inn_latin: nul(f.inn_latin), atc_code: nul(f.atc_code.toUpperCase()), form_code: f.form_code, strength: nul(f.strength), notes: nul(f.notes) };
      if (g) body.is_active = f.is_active;
      if (clinical) Object.assign(body, {
        controlled_class: f.controlled_class || null, high_alert: f.high_alert, reserve_antibiotic: f.reserve_antibiotic, patient_only: f.patient_only, routes, allergen_groups: allergens,
        dose_unit: f.dose_unit || null, dose_per_unit: s2n(f.dose_per_unit), max_single_dose: s2n(f.max_single_dose), max_daily_dose: s2n(f.max_daily_dose),
        ped_max_single_per_kg: s2n(f.ped_max_single_per_kg), ped_max_daily_per_kg: s2n(f.ped_max_daily_per_kg), min_age_days: s2n(f.min_age_days),
      });
      return g ? api<MedGeneric>(`/pharmacy/generics/${g.id}`, { method: 'PATCH', body }) : api<MedGeneric>('/pharmacy/generics', { body });
    },
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ['med-generics'] }); void qc.invalidateQueries({ queryKey: ['stock-items'] }); onSaved?.(r); onClose(); },
  });
  const r = refs.data;
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 } as const;
  return (
    <Modal title={g ? genericLabel(g) : 'ახალი ჯენერიკი'} onClose={onClose} width={860}
      footer={<><button className="btn" type="button" onClick={onClose}>{editable ? 'გაუქმება' : 'დახურვა'}</button>
        {editable && <button className="btn primary" type="submit" form="genf" disabled={m.isPending || f.inn.trim().length < 2 || !f.form_code}>შენახვა</button>}</>}>
      {!r ? <Loading /> : (
        <form id="genf" className="stack" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
          <fieldset disabled={!editable} style={{ border: 0, padding: 0, margin: 0 }} className="stack">
            <div style={grid}>
              <Field label="INN (ქართულად)" htmlFor="gi" required><input id="gi" className="input" value={f.inn} onChange={(e) => set('inn', e.target.value)} placeholder="ცეფტრიაქსონი" /></Field>
              <Field label="INN (ლათინურად)" htmlFor="gl"><input id="gl" className="input" value={f.inn_latin} onChange={(e) => set('inn_latin', e.target.value)} placeholder="Ceftriaxone" /></Field>
              <Field label="ATC" htmlFor="ga" hint="7 ნიშანი, მაგ. J01DD04"><input id="ga" className="input mono" value={f.atc_code} maxLength={7} onChange={(e) => set('atc_code', e.target.value.toUpperCase())} /></Field>
              <Field label="ფორმა" htmlFor="gf" required>
                <select id="gf" className="select" value={f.form_code} onChange={(e) => set('form_code', e.target.value)}>
                  <option value="">— აირჩიეთ —</option>{r.forms.filter((x) => x.is_active || x.code === f.form_code).map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}
                </select></Field>
              <Field label="დოზა / კონცენტრაცია" htmlFor="gs" hint="მაგ. 1 გ, 500 მგ/5 მლ"><input id="gs" className="input" value={f.strength} onChange={(e) => set('strength', e.target.value)} /></Field>
              {g && <label className="row" style={{ alignSelf: 'end' }}><input type="checkbox" checked={f.is_active} onChange={(e) => set('is_active', e.target.checked)} /> აქტიური</label>}
            </div>
          </fieldset>

          <h3 style={{ margin: '6px 0 0' }}>კლინიკური პარამეტრები {!clinical && <span className="small muted" style={{ fontWeight: 400 }}>— ცვლის ფარმაცევტი</span>}</h3>
          <fieldset disabled={!clinical} style={{ border: 0, padding: 0, margin: 0 }} className="stack">
            <div style={grid}>
              <Field label="კონტროლის კლასი" htmlFor="gc" hint="ნარკოტიკული / ფსიქოტროპული — სპეციალური აღრიცხვა (0035)">
                <select id="gc" className="select" value={f.controlled_class} onChange={(e) => set('controlled_class', e.target.value)}>
                  <option value="">— არა —</option>{(Object.keys(CONTROLLED_KA) as Controlled[]).map((k) => <option key={k} value={k}>{CONTROLLED_KA[k]}</option>)}
                </select></Field>
              <div className="stack" style={{ gap: 6, gridColumn: 'span 2', alignSelf: 'end' }}>
                <label className="row small"><input type="checkbox" checked={f.high_alert} onChange={(e) => set('high_alert', e.target.checked)} /> მაღალი რისკის (K⁺, ინსულინი, ჰეპარინი…)</label>
                <label className="row small"><input type="checkbox" checked={f.reserve_antibiotic} onChange={(e) => set('reserve_antibiotic', e.target.checked)} /> სარეზერვო ანტიბიოტიკი (დანიშნულება — დამატებითი დამტკიცებით)</label>
                <label className="row small"><input type="checkbox" checked={f.patient_only} onChange={(e) => set('patient_only', e.target.checked)} /> გაიცემა მხოლოდ კონკრეტულ პაციენტზე (არა განყოფილების მარაგად)</label>
              </div>
            </div>
            <div>
              <span className="label">შეყვანის გზები</span>
              <div className="row" style={{ flexWrap: 'wrap', gap: 10, marginTop: 6 }}>
                {r.routes.filter((x) => x.is_active || routes.includes(x.code)).map((x) => (
                  <label key={x.code} className="row small"><input type="checkbox" checked={routes.includes(x.code)} onChange={(e) => setRoutes(e.target.checked ? [...routes, x.code] : routes.filter((y) => y !== x.code))} />{x.name} <span className="mono muted">{x.code}</span></label>))}
              </div>
            </div>
            <div style={grid}>
              <Field label="დოზის ერთეული" htmlFor="gdu" hint="ზღვრებისთვის სავალდებულო">
                <select id="gdu" className="select" value={f.dose_unit} onChange={(e) => set('dose_unit', e.target.value)}>
                  <option value="">—</option>{DOSE_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                </select></Field>
              <Field label="აქტიური ნივთიერება საბაზო ერთეულში" htmlFor="gdp" hint="მაგ. 1 ფლაკონი = 1000 mg"><input id="gdp" className="input mono" inputMode="decimal" value={f.dose_per_unit} onChange={(e) => set('dose_per_unit', e.target.value)} /></Field>
              <Field label="მინ. ასაკი (დღე)" htmlFor="gma" hint="მაგ. 18 წ. = 6570"><input id="gma" className="input mono" inputMode="numeric" value={f.min_age_days} onChange={(e) => set('min_age_days', e.target.value)} /></Field>
              <Field label="მაქს. ერთჯერადი (მოზრდ.)" htmlFor="gms"><input id="gms" className="input mono" inputMode="decimal" value={f.max_single_dose} onChange={(e) => set('max_single_dose', e.target.value)} /></Field>
              <Field label="მაქს. დღიური (მოზრდ.)" htmlFor="gmd"><input id="gmd" className="input mono" inputMode="decimal" value={f.max_daily_dose} onChange={(e) => set('max_daily_dose', e.target.value)} /></Field>
              <span />
              <Field label="ბავშვი: მაქს. ერთჯერადი / კგ" htmlFor="gps"><input id="gps" className="input mono" inputMode="decimal" value={f.ped_max_single_per_kg} onChange={(e) => set('ped_max_single_per_kg', e.target.value)} /></Field>
              <Field label="ბავშვი: მაქს. დღიური / კგ" htmlFor="gpd"><input id="gpd" className="input mono" inputMode="decimal" value={f.ped_max_daily_per_kg} onChange={(e) => set('ped_max_daily_per_kg', e.target.value)} /></Field>
            </div>
            <div>
              <span className="label">ალერგენული ჯგუფები</span>
              <span className="hint" style={{ display: 'block' }}>პაციენტის ალერგიასთან შედარდება დანიშნულებისას (სტაციონარის ეტაპი) — ჯვარედინი რეაქციების ჩათვლით</span>
              <div className="row" style={{ flexWrap: 'wrap', gap: 10, marginTop: 6 }}>
                {r.allergen_groups.map((a) => (
                  <label key={a.code} className="row small"><input type="checkbox" checked={allergens.includes(a.code)} onChange={(e) => setAllergens(e.target.checked ? [...allergens, a.code] : allergens.filter((y) => y !== a.code))} />{a.name}</label>))}
              </div>
            </div>
          </fieldset>
          <Field label="შენიშვნა" htmlFor="gn"><textarea id="gn" className="textarea" rows={2} value={f.notes} disabled={!editable} onChange={(e) => set('notes', e.target.value)} /></Field>
          <ErrorBox error={m.error} />
        </form>
      )}
    </Modal>
  );
}

/** ჯენერიკის არჩევა (ძებნით) + ახლის შექმნა */
export function GenericPicker({ value, label, onChange, allowCreate = true, placeholder = 'INN ან ATC (მინ. 2 სიმბოლო)' }: { value: string | null; label: string | null; onChange: (g: { id: string; label: string } | null) => void; allowCreate?: boolean; placeholder?: string }) {
  const { user } = useAuth();
  const [q, setQ] = useState(''); const [open, setOpen] = useState(false); const [create, setCreate] = useState(false);
  const dq = useDebounced(q.trim(), 250);
  const res = useQuery({ queryKey: ['med-generics', 'pick', dq], queryFn: () => api<MedGeneric[]>('/pharmacy/generics', { query: { search: dq } }), enabled: open && dq.length >= 2 });
  if (value && !open) return (
    <div className="row" style={{ gap: 8 }}>
      <span className="grow" style={{ fontWeight: 600 }}>{label}</span>
      <button className="btn sm" type="button" onClick={() => { setOpen(true); setQ(''); }}>შეცვლა</button>
      <button className="btn sm" type="button" onClick={() => onChange(null)}>მოხსნა</button>
    </div>
  );
  return (
    <div className="stack" style={{ gap: 0 }}>
      <div className="row" style={{ gap: 6 }}>
        <input className="input grow" style={{ height: 38 }} aria-label="ჯენერიკის ძებნა" placeholder={placeholder} value={q} onFocus={() => setOpen(true)} onChange={(e) => { setQ(e.target.value); setOpen(true); }} />
        {res.isFetching && <Spinner />}
        {allowCreate && can(user, ...CATALOG_EDIT) && <button className="btn sm" type="button" onClick={() => setCreate(true)}>+ ახალი</button>}
      </div>
      {open && dq.length >= 2 && (
        <ul className="listbox" role="listbox" aria-label="ჯენერიკები">
          {res.data?.map((g) => <li key={g.id} role="option" aria-selected={false} onMouseDown={(e) => { e.preventDefault(); onChange({ id: g.id, label: genericLabel(g) }); setOpen(false); }}>
            <span className="grow">{genericLabel(g)}</span><span className="mono small muted">{g.atc_code ?? ''}</span></li>)}
          {res.data && !res.data.length && <li aria-disabled="true">{allowCreate ? 'ვერ მოიძებნა — „+ ახალი“' : 'ვერ მოიძებნა'}</li>}
        </ul>)}
      {create && <GenericDialog g={null} initialInn={q.trim()} onClose={() => setCreate(false)} onSaved={(g) => { onChange({ id: g.id, label: genericLabel(g) }); setOpen(false); }} />}
    </div>
  );
}
