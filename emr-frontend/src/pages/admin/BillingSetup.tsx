import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import type { Tariff } from '../../api/types';
import { ErrorBox, Field, Loading, Modal, useDebounced, useToast } from '../../components/ui';
import { money } from '../../lib/format';

/** ადმინისტრირება → სტაციონარის ბილინგი (0046): საწოლდღის ტარიფები, პაკეტები, გადამხდელები, DRG */
export const CAT_KA: Record<string, string> = {
  bed: 'საწოლდღე', ventilation: 'ხელოვნური ვენტილაცია', surgery: 'ოპერაცია', anesthesia: 'ანესთეზია', service: 'მომსახურება', consult: 'კონსულტაცია', lab: 'ლაბორატორია', radiology: 'რადიოლოგია', endoscopy: 'ენდოსკოპია',
  medication: 'მედიკამენტები', supply: 'სამედიცინო მასალა', implant: 'იმპლანტები', package: 'პაკეტი', other: 'სხვა',
};
const PKG_CATS = ['service', 'ventilation', 'surgery', 'anesthesia', 'consult', 'lab', 'radiology', 'endoscopy', 'medication', 'supply', 'implant'];
export const PAYER_KIND_KA: Record<string, string> = { insurance: 'სადაზღვევო კომპანია', state: 'სახელმწიფო პროგრამა', other: 'სხვა' };
export const MODE_KA: Record<string, string> = { percent: 'პროცენტი (+ ლიმიტი, ფრანშიზა)', fixed: 'ფიქსირებული თანხა', drg: 'DRG (წონა × განაკვეთი)' };

export interface Payer {
  id: string; code: string; name: string; kind: string; tax_id: string | null; contract_no: string | null; phone: string | null; email: string | null; address: string | null;
  default_mode: string; default_coverage_pct: string; default_limit: string | null; default_deductible: string; drg_base_rate: string | null; writeoff_excess: boolean;
  excluded_categories: string[]; notes: string | null; is_active: boolean; used: number;
}
export interface Package {
  id: string; code: string; name: string; price: string; includes_bed: boolean; included_days: number | null; extra_day_tariff_id: string | null; extra_day_tariff_title: string | null;
  extra_day_price: string | null; department_id: string | null; department_name: string | null; notes: string | null; is_active: boolean; used: number;
  items: { kind: 'category' | 'tariff'; category: string | null; tariff_id: string | null; tariff_code: string | null; tariff_title: string | null }[];
}
export interface Drg { code: string; title: string; relative_weight: string; alos: string | null; mdc: string | null; is_active: boolean }
interface BedTariff { id: string; bed_type_code: string; bed_type_name: string; department_id: string | null; department_name: string | null; tariff_id: string; tariff_code: string; tariff_title: string; base_price: string; tariff_active: boolean }
interface Structure { types: { code: string; name: string; is_active: boolean }[]; departments: { id: string; name: string }[] }

const useTariffs = () => useQuery({ queryKey: ['tariffs', '', false], queryFn: () => api<Tariff[]>('/tariffs') });
const useStructure = () => useQuery({ queryKey: ['ipd-structure'], queryFn: () => api<Structure>('/inpatient/structure') });

export default function BillingSetup() {
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('t') ?? 'beds';
  const tabs: [string, string][] = [['beds', 'საწოლდღის ტარიფები'], ['packages', 'პაკეტები'], ['payers', 'სადაზღვევო კომპანიები / პროგრამები'], ['drg', 'DRG']];
  return (
    <div className="content">
      <div className="row" role="tablist" style={{ gap: 4 }}>
        {tabs.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={`btn sm${tab === k ? ' primary' : ''}`} onClick={() => setSp({ t: k })}>{l}</button>)}
      </div>
      {tab === 'packages' ? <Packages /> : tab === 'payers' ? <Payers /> : tab === 'drg' ? <DrgTab /> : <BedTariffs />}
    </div>
  );
}

// ---------------------------------------------------------------- საწოლდღე
function BedTariffs() {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['bed-tariffs'], queryFn: () => api<BedTariff[]>('/billing/bed-tariffs') });
  const st = useStructure(); const tf = useTariffs();
  const [n, setN] = useState({ bed_type_code: '', department_id: '', tariff_id: '' });
  const save = useMutation({
    mutationFn: (b: { bed_type_code: string; department_id: string | null; tariff_id: string }) => api('/billing/bed-tariffs', { method: 'PUT', body: b }),
    onSuccess: () => { toast.show('შენახულია'); setN({ bed_type_code: '', department_id: '', tariff_id: '' }); void qc.invalidateQueries({ queryKey: ['bed-tariffs'] }); },
  });
  const del = useMutation({ mutationFn: (id: string) => api(`/billing/bed-tariffs/${id}`, { method: 'DELETE' }), onSuccess: () => void qc.invalidateQueries({ queryKey: ['bed-tariffs'] }) });
  const types = (st.data?.types ?? []).filter((t) => t.is_active);
  const missing = types.filter((t) => !q.data?.some((b) => b.bed_type_code === t.code && !b.department_id));
  return (
    <>
      <section className="card card-pad stack">
        <h2 style={{ margin: 0 }}>საწოლდღის ტარიფები</h2>
        <span className="hint">დღე ითვლება შუაღამით: თუ 00:00-ზე პაციენტი საწოლზეა, ეს ერთი საწოლდღეა, საწოლის ტიპის ტარიფით. გაწერის დღე არ ითვლება; შუაღამემდე გაწერილი — მინიმუმ 1 დღე.
          განყოფილების ტარიფი ზოგადს ცვლის. ტარიფების ფასები — <Link to="/admin/tariffs">ტარიფები</Link>.</span>
        {missing.length > 0 && <div className="alert warn">ზოგადი ტარიფი არ აქვს: {missing.map((t) => t.name).join(', ')} — ასეთ საწოლზე დღე ტარიფის გარეშე დარჩება (ფინალიზაცია დაიბლოკება).</div>}
        <ErrorBox error={q.error ?? del.error} />
        {q.isLoading ? <Loading /> : (
          <table className="table">
            <thead><tr><th>საწოლის ტიპი</th><th>განყოფილება</th><th>ტარიფი</th><th className="num">ფასი</th><th /></tr></thead>
            <tbody>{q.data?.map((b) => (
              <tr key={b.id}><td>{b.bed_type_name}</td><td>{b.department_name ?? <span className="muted">ყველა</span>}</td>
                <td><span className="mono small">{b.tariff_code}</span> {b.tariff_title}{!b.tariff_active && <span className="chip warn" style={{ marginLeft: 6 }}>ტარიფი გათიშულია</span>}</td>
                <td className="num">{money(b.base_price)}</td>
                <td className="num"><button className="btn sm" type="button" onClick={() => del.mutate(b.id)}>წაშლა</button></td></tr>))}
              {q.data?.length === 0 && <tr><td colSpan={5} className="empty">ტარიფი არ არის მინიჭებული.</td></tr>}</tbody>
          </table>
        )}
      </section>
      <section className="card card-pad stack">
        <h3 style={{ margin: 0 }}>მინიჭება / შეცვლა</h3>
        <form className="row" style={{ gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }} onSubmit={(e) => { e.preventDefault(); save.mutate({ ...n, department_id: n.department_id || null }); }}>
          <Field label="საწოლის ტიპი" htmlFor="bt-t" required><select id="bt-t" className="select" value={n.bed_type_code} onChange={(e) => setN({ ...n, bed_type_code: e.target.value })} required>
            <option value="">—</option>{types.map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}</select></Field>
          <Field label="განყოფილება" htmlFor="bt-d" hint="ცარიელი — ყველა"><select id="bt-d" className="select" value={n.department_id} onChange={(e) => setN({ ...n, department_id: e.target.value })}>
            <option value="">ყველა</option>{st.data?.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
          <Field label="ტარიფი" htmlFor="bt-tf" required><select id="bt-tf" className="select" value={n.tariff_id} onChange={(e) => setN({ ...n, tariff_id: e.target.value })} required style={{ minWidth: 260 }}>
            <option value="">—</option>{tf.data?.map((t) => <option key={t.id} value={t.id}>{t.code} — {t.title} ({money(t.base_price)})</option>)}</select></Field>
          <button className="btn primary" type="submit" disabled={save.isPending}>შენახვა</button>
        </form>
        <ErrorBox error={save.error} />
      </section>
    </>
  );
}

// ---------------------------------------------------------------- პაკეტები
function Packages() {
  const [inactive, setInactive] = useState(false); const [edit, setEdit] = useState<Package | 'new' | null>(null);
  const q = useQuery({ queryKey: ['billing-packages', inactive], queryFn: () => api<Package[]>('/billing/packages', { query: { include_inactive: inactive } }) });
  return (
    <section className="card card-pad stack">
      <div className="row"><h2 style={{ margin: 0 }} className="grow">პაკეტები</h2>
        <label className="row small"><input type="checkbox" checked={inactive} onChange={(e) => setInactive(e.target.checked)} /> გათიშულებიც</label>
        <button className="btn primary" type="button" onClick={() => setEdit('new')}>+ პაკეტი</button></div>
      <span className="hint">პაკეტი — ფიქსირებული ფასი. შემავალი ხაზები ინვოისში რჩება („პაკეტშია“, ჯამში არ ითვლება); დანარჩენი ცალკე ემატება. დღეების ლიმიტს ზემოთ — ზედმეტი დღის ტარიფი.</span>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : (
        <table className="table">
          <thead><tr><th>კოდი</th><th>დასახელება</th><th className="num">ფასი</th><th>საწოლდღე</th><th>შემადგენლობა</th><th>განყოფილება</th><th className="num">გამოყენება</th><th /></tr></thead>
          <tbody>{q.data?.map((p) => (
            <tr key={p.id} className="clickable" onClick={() => setEdit(p)}>
              <td className="mono">{p.code}</td><td>{p.name}</td><td className="num">{money(p.price)}</td>
              <td className="small">{p.includes_bed ? (p.included_days ? `${p.included_days} დღე${p.extra_day_tariff_title ? `; ზედმეტი — ${money(p.extra_day_price)}` : ''}` : 'შეუზღუდავი') : 'არ შედის'}</td>
              <td className="small">{p.items.map((i) => i.kind === 'category' ? CAT_KA[i.category!] : i.tariff_title).join(', ') || '—'}</td>
              <td className="small">{p.department_name ?? 'ყველა'}</td><td className="num">{p.used}</td>
              <td>{p.is_active ? <span className="chip ok">აქტიური</span> : <span className="chip">გათიშული</span>}</td>
            </tr>))}
            {q.data?.length === 0 && <tr><td colSpan={8} className="empty">პაკეტი არ არის.</td></tr>}</tbody>
        </table>
      )}
      {edit && <PackageDialog p={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </section>
  );
}

function PackageDialog({ p, onClose }: { p: Package | null; onClose: () => void }) {
  const qc = useQueryClient(); const tf = useTariffs(); const st = useStructure();
  const [f, setF] = useState({ code: p?.code ?? '', name: p?.name ?? '', price: p?.price ?? '', includes_bed: p?.includes_bed ?? true, included_days: p?.included_days ? String(p.included_days) : '',
    extra_day_tariff_id: p?.extra_day_tariff_id ?? '', department_id: p?.department_id ?? '', notes: p?.notes ?? '', is_active: p?.is_active ?? true });
  const [cats, setCats] = useState<string[]>(p?.items.filter((i) => i.kind === 'category').map((i) => i.category!) ?? []);
  const [tars, setTars] = useState<string[]>(p?.items.filter((i) => i.kind === 'tariff').map((i) => i.tariff_id!) ?? []);
  const [addT, setAddT] = useState('');
  const m = useMutation({
    mutationFn: () => {
      const body = { name: f.name, price: Number(f.price), includes_bed: f.includes_bed, included_days: f.includes_bed && f.included_days ? Number(f.included_days) : null,
        extra_day_tariff_id: f.extra_day_tariff_id || null, department_id: f.department_id || null, notes: f.notes || null,
        items: [...cats.map((c) => ({ kind: 'category', category: c })), ...tars.map((t) => ({ kind: 'tariff', tariff_id: t }))] };
      return p ? api(`/billing/packages/${p.id}`, { method: 'PATCH', body: { ...body, is_active: f.is_active } }) : api('/billing/packages', { body: { ...body, code: f.code } });
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['billing-packages'] }); onClose(); },
  });
  const tname = (id: string) => tf.data?.find((t) => t.id === id);
  return (
    <Modal title={p ? `პაკეტი ${p.code}` : 'ახალი პაკეტი'} onClose={onClose} width={680}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="submit" form="pkf" disabled={m.isPending}>შენახვა</button></>}>
      <form id="pkf" className="stack" style={{ gap: 12 }} onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr 140px', gap: 12 }}>
          <Field label="კოდი" htmlFor="pk-c" required hint={p ? 'არ იცვლება' : undefined}><input id="pk-c" className="input mono" value={f.code} disabled={!!p} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} required /></Field>
          <Field label="დასახელება" htmlFor="pk-n" required><input id="pk-n" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></Field>
          <Field label="ფასი (₾)" htmlFor="pk-p" required><input id="pk-p" className="input mono" inputMode="decimal" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} required /></Field>
        </div>
        <fieldset className="stack" style={{ gap: 8, border: '1px solid var(--line)', borderRadius: 8, padding: 12 }}>
          <legend className="small">საწოლდღე</legend>
          <label className="row"><input type="checkbox" checked={f.includes_bed} onChange={(e) => setF({ ...f, includes_bed: e.target.checked })} /> საწოლდღეები შედის პაკეტში</label>
          {f.includes_bed && <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 12 }}>
            <Field label="დღეების რაოდენობა" htmlFor="pk-d" hint="ცარიელი — შეუზღუდავი"><input id="pk-d" className="input mono" type="number" min={1} value={f.included_days} onChange={(e) => setF({ ...f, included_days: e.target.value })} /></Field>
            <Field label="ზედმეტი დღის ტარიფი" htmlFor="pk-x" hint="ცარიელი — ჩვეულებრივი საწოლდღის ტარიფი"><select id="pk-x" className="select" value={f.extra_day_tariff_id} onChange={(e) => setF({ ...f, extra_day_tariff_id: e.target.value })}>
              <option value="">ჩვეულებრივი</option>{tf.data?.map((t) => <option key={t.id} value={t.id}>{t.code} — {t.title} ({money(t.base_price)})</option>)}</select></Field>
          </div>}
        </fieldset>
        <fieldset className="stack" style={{ gap: 8, border: '1px solid var(--line)', borderRadius: 8, padding: 12 }}>
          <legend className="small">რა შედის პაკეტში</legend>
          <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>{PKG_CATS.map((c) => (
            <label key={c} className="row small"><input type="checkbox" checked={cats.includes(c)} onChange={(e) => setCats(e.target.checked ? [...cats, c] : cats.filter((x) => x !== c))} /> {CAT_KA[c]} (ყველა)</label>))}</div>
          <div className="row" style={{ gap: 8 }}>
            <select aria-label="კონკრეტული ტარიფი" className="select grow" value={addT} onChange={(e) => setAddT(e.target.value)}>
              <option value="">+ კონკრეტული ტარიფი…</option>{tf.data?.filter((t) => !tars.includes(t.id)).map((t) => <option key={t.id} value={t.id}>{t.code} — {t.title}</option>)}</select>
            <button className="btn sm" type="button" disabled={!addT} onClick={() => { setTars([...tars, addT]); setAddT(''); }}>დამატება</button>
          </div>
          {tars.length > 0 && <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>{tars.map((t) => (
            <span key={t} className="chip">{tname(t)?.title ?? p?.items.find((i) => i.tariff_id === t)?.tariff_title ?? t}
              <button type="button" aria-label="მოხსნა" onClick={() => setTars(tars.filter((x) => x !== t))} style={{ border: 0, background: "none", cursor: "pointer", padding: "0 0 0 6px", font: "inherit" }}>×</button></span>))}</div>}
        </fieldset>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="განყოფილება" htmlFor="pk-dep" hint="ცარიელი — ყველა"><select id="pk-dep" className="select" value={f.department_id} onChange={(e) => setF({ ...f, department_id: e.target.value })}>
            <option value="">ყველა</option>{st.data?.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
          <Field label="შენიშვნა" htmlFor="pk-nt"><input id="pk-nt" className="input" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
        </div>
        {p && <label className="row"><input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> აქტიური</label>}
        {p && p.used > 0 && <span className="hint">პაკეტი მინიჭებულია {p.used} ჰოსპიტალიზაციაზე — ფასის ცვლილება აისახება მხოლოდ ხელახლა მინიჭებისას.</span>}
        <ErrorBox error={m.error} />
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- გადამხდელები
function Payers() {
  const [inactive, setInactive] = useState(false); const [edit, setEdit] = useState<Payer | 'new' | null>(null);
  const q = useQuery({ queryKey: ['payers', inactive], queryFn: () => api<Payer[]>('/billing/payers', { query: { include_inactive: inactive } }) });
  const terms = (p: Payer) => p.default_mode === 'drg' ? `DRG · განაკვეთი ${money(p.drg_base_rate)} · ${Number(p.default_coverage_pct)}%`
    : p.default_mode === 'fixed' ? `ფიქსირებული · ${Number(p.default_coverage_pct)}%`
    : `${Number(p.default_coverage_pct)}%${p.default_limit ? ` · ლიმიტი ${money(p.default_limit)}` : ''}${Number(p.default_deductible) ? ` · ფრანშიზა ${money(p.default_deductible)}` : ''}`;
  return (
    <section className="card card-pad stack">
      <div className="row"><h2 style={{ margin: 0 }} className="grow">სადაზღვევო კომპანიები / სახელმწიფო პროგრამები</h2>
        <label className="row small"><input type="checkbox" checked={inactive} onChange={(e) => setInactive(e.target.checked)} /> გათიშულებიც</label>
        <button className="btn primary" type="button" onClick={() => setEdit('new')}>+ გადამხდელი</button></div>
      <span className="hint">აქ — ნაგულისხმევი პირობები. ჰოსპიტალიზაციაზე გადამხდელის დამატებისას (საგარანტიო წერილი) პირობები ივსება აქედან და შეიძლება შეიცვალოს.</span>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : (
        <table className="table">
          <thead><tr><th>კოდი</th><th>დასახელება</th><th>ტიპი</th><th>პირობები</th><th>არ ფარავს</th><th>ს/კ · ხელშეკრულება</th><th className="num">აქტიური შემთხვ.</th><th /></tr></thead>
          <tbody>{q.data?.map((p) => (
            <tr key={p.id} className="clickable" onClick={() => setEdit(p)}>
              <td className="mono">{p.code}</td><td>{p.name}</td><td className="small">{PAYER_KIND_KA[p.kind]}</td><td className="small">{terms(p)}{p.writeoff_excess && ' · ზედმეტი ჩამოიწერება'}</td>
              <td className="small">{p.excluded_categories.map((c) => CAT_KA[c]).join(', ') || '—'}</td><td className="small mono">{[p.tax_id, p.contract_no].filter(Boolean).join(' · ') || '—'}</td>
              <td className="num">{p.used}</td><td>{p.is_active ? <span className="chip ok">აქტიური</span> : <span className="chip">გათიშული</span>}</td>
            </tr>))}
            {q.data?.length === 0 && <tr><td colSpan={8} className="empty">გადამხდელი არ არის.</td></tr>}</tbody>
        </table>
      )}
      {edit && <PayerDialog p={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </section>
  );
}

function PayerDialog({ p, onClose }: { p: Payer | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ code: p?.code ?? '', name: p?.name ?? '', kind: p?.kind ?? 'insurance', tax_id: p?.tax_id ?? '', contract_no: p?.contract_no ?? '', phone: p?.phone ?? '', email: p?.email ?? '',
    address: p?.address ?? '', default_mode: p?.default_mode ?? 'percent', default_coverage_pct: p ? String(Number(p.default_coverage_pct)) : '100', default_limit: p?.default_limit ?? '',
    default_deductible: p ? String(Number(p.default_deductible)) : '0', drg_base_rate: p?.drg_base_rate ?? '', writeoff_excess: p?.writeoff_excess ?? false, notes: p?.notes ?? '', is_active: p?.is_active ?? true });
  const [excl, setExcl] = useState<string[]>(p?.excluded_categories ?? []);
  const m = useMutation({
    mutationFn: () => {
      const body = { name: f.name, kind: f.kind, tax_id: f.tax_id || null, contract_no: f.contract_no || null, phone: f.phone || null, email: f.email || null, address: f.address || null,
        default_mode: f.default_mode, default_coverage_pct: Number(f.default_coverage_pct), default_limit: f.default_limit === '' ? null : Number(f.default_limit),
        default_deductible: Number(f.default_deductible || 0), drg_base_rate: f.drg_base_rate === '' ? null : Number(f.drg_base_rate), writeoff_excess: f.writeoff_excess,
        excluded_categories: excl, notes: f.notes || null };
      return p ? api(`/billing/payers/${p.id}`, { method: 'PATCH', body: { ...body, is_active: f.is_active } }) : api('/billing/payers', { body: { ...body, code: f.code } });
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['payers'] }); onClose(); },
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const g3 = { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 } as const;
  return (
    <Modal title={p ? p.name : 'ახალი გადამხდელი'} onClose={onClose} width={720}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="submit" form="pyf" disabled={m.isPending}>შენახვა</button></>}>
      <form id="pyf" className="stack" style={{ gap: 12 }} onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <div style={{ display: 'grid', gridTemplateColumns: '150px 1fr 200px', gap: 12 }}>
          <Field label="კოდი" htmlFor="py-c" required><input id="py-c" className="input mono" value={f.code} disabled={!!p} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} required /></Field>
          <Field label="დასახელება" htmlFor="py-n" required><input id="py-n" className="input" value={f.name} onChange={set('name')} required /></Field>
          <Field label="ტიპი" htmlFor="py-k"><select id="py-k" className="select" value={f.kind} onChange={set('kind')}>{Object.entries(PAYER_KIND_KA).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        </div>
        <div style={g3}>
          <Field label="საიდენტიფიკაციო კოდი" htmlFor="py-t"><input id="py-t" className="input mono" value={f.tax_id} onChange={set('tax_id')} /></Field>
          <Field label="ხელშეკრულების №" htmlFor="py-cn"><input id="py-cn" className="input" value={f.contract_no} onChange={set('contract_no')} /></Field>
          <Field label="ტელეფონი" htmlFor="py-ph"><input id="py-ph" className="input" value={f.phone} onChange={set('phone')} /></Field>
          <Field label="ელ-ფოსტა" htmlFor="py-em"><input id="py-em" className="input" type="email" value={f.email} onChange={set('email')} /></Field>
          <div style={{ gridColumn: 'span 2' }}><Field label="მისამართი" htmlFor="py-ad"><input id="py-ad" className="input" value={f.address} onChange={set('address')} /></Field></div>
        </div>
        <fieldset className="stack" style={{ gap: 10, border: '1px solid var(--line)', borderRadius: 8, padding: 12 }}>
          <legend className="small">ნაგულისხმევი დაფარვის წესი</legend>
          <div style={g3}>
            <Field label="რეჟიმი" htmlFor="py-m"><select id="py-m" className="select" value={f.default_mode} onChange={set('default_mode')}>{Object.entries(MODE_KA).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
            <Field label="დაფარვა (%)" htmlFor="py-pct"><input id="py-pct" className="input mono" type="number" min={0} max={100} step="0.01" value={f.default_coverage_pct} onChange={set('default_coverage_pct')} /></Field>
            {f.default_mode === 'percent' && <Field label="ლიმიტი (₾)" htmlFor="py-l" hint="ცარიელი — შეუზღუდავი"><input id="py-l" className="input mono" inputMode="decimal" value={f.default_limit} onChange={set('default_limit')} /></Field>}
            {f.default_mode === 'percent' && <Field label="ფრანშიზა (₾)" htmlFor="py-dd"><input id="py-dd" className="input mono" inputMode="decimal" value={f.default_deductible} onChange={set('default_deductible')} /></Field>}
            {f.default_mode !== 'percent' && <Field label="DRG საბაზისო განაკვეთი (₾)" htmlFor="py-r" required={f.default_mode === 'drg'} hint="თანხა = ფარდობითი წონა × განაკვეთი">
              <input id="py-r" className="input mono" inputMode="decimal" value={f.drg_base_rate} onChange={set('drg_base_rate')} required={f.default_mode === 'drg'} /></Field>}
          </div>
          {f.default_mode !== 'percent' && <label className="row small"><input type="checkbox" checked={f.writeoff_excess} onChange={(e) => setF({ ...f, writeoff_excess: e.target.checked })} />
            ფაქტობრივი ხარჯის ტარიფს ზემოთ ნაწილი ჩამოიწერება (პაციენტი იხდის მხოლოდ თანაგადახდას)</label>}
          <div className="stack" style={{ gap: 6 }}><span className="small muted">არ ფარავს:</span>
            <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>{Object.keys(CAT_KA).map((c) => (
              <label key={c} className="row small"><input type="checkbox" checked={excl.includes(c)} onChange={(e) => setExcl(e.target.checked ? [...excl, c] : excl.filter((x) => x !== c))} /> {CAT_KA[c]}</label>))}</div></div>
        </fieldset>
        <Field label="შენიშვნა" htmlFor="py-nt"><textarea id="py-nt" className="textarea" rows={2} value={f.notes} onChange={set('notes')} /></Field>
        {p && <label className="row"><input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> აქტიური</label>}
        <ErrorBox error={m.error} />
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- DRG
function DrgTab() {
  const qc = useQueryClient(); const toast = useToast();
  const [search, setSearch] = useState(''); const [inactive, setInactive] = useState(false); const [edit, setEdit] = useState<Drg | 'new' | null>(null);
  const dq = useDebounced(search.trim(), 250);
  const q = useQuery({ queryKey: ['drg', dq, inactive], queryFn: () => api<{ rows: Drg[]; total: number; active: number }>('/billing/drg', { query: { search: dq, include_inactive: inactive } }) });
  const file = useRef<HTMLInputElement>(null);
  const [csv, setCsv] = useState<{ name: string; text: string } | null>(null); const [deact, setDeact] = useState(false);
  const [preview, setPreview] = useState<{ rows: number; added: number; changed: number; missing: number; deactivated: number; errors: string[]; applied: boolean } | null>(null);
  const imp = useMutation({
    mutationFn: (dry: boolean) => api<NonNullable<typeof preview>>('/billing/drg/import', { body: { csv: csv!.text, deactivate_missing: deact, dry_run: dry } }),
    onSuccess: (r) => { setPreview(r); if (r.applied) { toast.show(`იმპორტი: ${r.added} ახალი, ${r.changed} განახლდა`); setCsv(null); void qc.invalidateQueries({ queryKey: ['drg'] }); } },
  });
  const pick = async (f: File | undefined) => { if (!f) return; const text = await f.text(); setCsv({ name: f.name, text }); setPreview(null); };
  return (
    <>
      <section className="card card-pad stack">
        <div className="row"><h2 style={{ margin: 0 }} className="grow">DRG ჯგუფები</h2>
          <span className="small muted">{q.data ? `${q.data.active} აქტიური / ${q.data.total}` : ''}</span>
          <button className="btn primary" type="button" onClick={() => setEdit('new')}>+ ჯგუფი</button></div>
        <span className="hint">თანხა = ფარდობითი წონა × გადამხდელის საბაზისო განაკვეთი. ჰოსპიტალიზაციაზე DRG-ს ირჩევს ბილინგი / მიმღები (გადამხდელის დამატებისას); წონა ფიქსირდება მინიჭების მომენტში.</span>
        <div className="row">
          <input aria-label="ძებნა" className="input" style={{ maxWidth: 320 }} placeholder="კოდი ან დასახელება" value={search} onChange={(e) => setSearch(e.target.value)} />
          <label className="row small"><input type="checkbox" checked={inactive} onChange={(e) => setInactive(e.target.checked)} /> გათიშულებიც</label>
        </div>
        <ErrorBox error={q.error} />
        {q.isLoading ? <Loading /> : (
          <table className="table">
            <thead><tr><th>კოდი</th><th>დასახელება</th><th className="num">წონა</th><th className="num">საშ. ხანგრძლ.</th><th>MDC</th><th /></tr></thead>
            <tbody>{q.data?.rows.map((d) => (
              <tr key={d.code} className="clickable" onClick={() => setEdit(d)}>
                <td className="mono">{d.code}</td><td>{d.title}</td><td className="num mono">{Number(d.relative_weight).toFixed(4)}</td><td className="num">{d.alos ? `${Number(d.alos)} დ.` : '—'}</td>
                <td className="small">{d.mdc ?? ''}</td><td>{d.is_active ? <span className="chip ok">აქტიური</span> : <span className="chip">გათიშული</span>}</td></tr>))}
              {q.data?.rows.length === 0 && <tr><td colSpan={6} className="empty">DRG ჯგუფი არ არის — შემოიტანეთ CSV-ით.</td></tr>}</tbody>
          </table>
        )}
      </section>
      <section className="card card-pad stack">
        <h3 style={{ margin: 0 }}>იმპორტი (CSV)</h3>
        <span className="hint">სვეტები: <span className="mono">კოდი; დასახელება; წონა[; საშ. ხანგრძლივობა[; MDC]]</span> — გამყოფი „;“, „,“ ან TAB; პირველი სტრიქონი შეიძლება სათაური იყოს; ათწილადი — წერტილით ან მძიმით.
          არსებული კოდი განახლდება, ახალი დაემატება. უკვე მინიჭებულ ჰოსპიტალიზაციებს არ ეხება.</span>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <input ref={file} type="file" accept=".csv,.txt,text/csv" hidden onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
          <button className="btn" type="button" onClick={() => file.current?.click()}>ფაილის არჩევა</button>
          {csv && <span className="small mono">{csv.name}</span>}
          <label className="row small"><input type="checkbox" checked={deact} onChange={(e) => setDeact(e.target.checked)} /> ფაილში არმყოფი ჯგუფები გაითიშოს</label>
          <button className="btn" type="button" disabled={!csv || imp.isPending} onClick={() => imp.mutate(true)}>შემოწმება</button>
          <button className="btn primary" type="button" disabled={!csv || imp.isPending || !preview || preview.errors.length > 0} onClick={() => imp.mutate(false)}>იმპორტი</button>
        </div>
        {preview && <div className={`alert ${preview.errors.length ? 'danger' : 'info'}`}>
          {preview.rows} სტრიქონი · ახალი {preview.added} · შეიცვლება {preview.changed} · ცნობარში, ფაილში არ არის: {preview.missing}{deact ? ' (გაითიშება)' : ''}
          {preview.errors.length > 0 && <ul style={{ margin: '6px 0 0' }}>{preview.errors.map((e) => <li key={e}>{e}</li>)}</ul>}</div>}
        <ErrorBox error={imp.error} />
      </section>
      {edit && <DrgDialog d={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </>
  );
}

function DrgDialog({ d, onClose }: { d: Drg | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ code: d?.code ?? '', title: d?.title ?? '', relative_weight: d ? String(Number(d.relative_weight)) : '', alos: d?.alos ? String(Number(d.alos)) : '', mdc: d?.mdc ?? '', is_active: d?.is_active ?? true });
  const m = useMutation({
    mutationFn: () => {
      const body = { title: f.title, relative_weight: Number(f.relative_weight.replace(',', '.')), alos: f.alos ? Number(f.alos.replace(',', '.')) : null, mdc: f.mdc || null };
      return d ? api(`/billing/drg/${d.code}`, { method: 'PATCH', body: { ...body, is_active: f.is_active } }) : api('/billing/drg', { body: { ...body, code: f.code } });
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['drg'] }); onClose(); },
  });
  return (
    <Modal title={d ? `DRG ${d.code}` : 'ახალი DRG ჯგუფი'} onClose={onClose} width={560}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="submit" form="drgf" disabled={m.isPending}>შენახვა</button></>}>
      <form id="drgf" className="stack" style={{ gap: 12 }} onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <Field label="კოდი" htmlFor="dg-c" required><input id="dg-c" className="input mono" value={f.code} disabled={!!d} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} required /></Field>
        <Field label="დასახელება" htmlFor="dg-t" required><input id="dg-t" className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required /></Field>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
          <Field label="ფარდობითი წონა" htmlFor="dg-w" required><input id="dg-w" className="input mono" inputMode="decimal" value={f.relative_weight} onChange={(e) => setF({ ...f, relative_weight: e.target.value })} required /></Field>
          <Field label="საშ. ხანგრძლ. (დღე)" htmlFor="dg-a"><input id="dg-a" className="input mono" inputMode="decimal" value={f.alos} onChange={(e) => setF({ ...f, alos: e.target.value })} /></Field>
          <Field label="MDC" htmlFor="dg-m"><input id="dg-m" className="input mono" value={f.mdc} onChange={(e) => setF({ ...f, mdc: e.target.value })} /></Field>
        </div>
        {d && <label className="row"><input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> აქტიური</label>}
        <ErrorBox error={m.error} />
      </form>
    </Modal>
  );
}
