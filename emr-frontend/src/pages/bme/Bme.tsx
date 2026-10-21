import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, apiUpload, can, openBlob, type Role } from '../../api/client';
import type { Department } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Field, Loading, Modal, useDebounced, useToast } from '../../components/ui';
import { dateGe, tsDate } from '../../lib/format';
import { useModules } from '../../lib/modules';
import { DevicePm, DueChip, PmRefsPage, WorkDialog, WorksPage } from './BmePm';

// ---------------------------------------------------------------- ტიპები
type Status = 'operational' | 'restricted' | 'down' | 'standby' | 'retired';
type Crit = 'life_support' | 'high' | 'medium' | 'low';
type LinkKind = 'dx_device' | 'lab_method' | 'cssd_machine' | 'endo_scope';
interface Settings { inv_prefix: string; inv_year: boolean; inv_digits: number; require_department: boolean; move_mode: 'direct' | 'confirm'; label_size: string; label_code: string }
interface DType { id: string; code: string; name: string; grp: string; default_criticality: Crit; default_risk_class: string | null; pm_months: number | null; calibration_months: number | null;
  safety_months: number | null; is_active: boolean; sort_order: number; devices: number }
interface OrRoom { id: string; code: string; name: string; department_id: string; department_name: string }
interface Refs { settings: Settings; types: DType[]; or_rooms: OrRoom[] }
interface Device {
  id: string; inv_no: string; name: string; type_id: string; type_code: string; type_name: string; grp: string; manufacturer: string | null; model: string | null; serial_no: string | null;
  gmdn_code: string | null; risk_class: string | null; criticality: Crit; department_id: string | null; department_name: string | null; room: string | null; or_room_id: string | null; or_room_name: string | null;
  responsible_user_id: string | null; responsible_name: string | null; status: Status; status_reason: string | null; status_since: string; manufacture_year: number | null; install_date: string | null;
  purchase_date: string | null; purchase_value: string | null; supplier_id: string | null; supplier_name: string | null; warranty_until: string | null; under_warranty: boolean; asset_id: string | null; asset_inv_no: string | null;
  link_kind: LinkKind | null; link_name: string | null; needs_review: boolean; notes: string | null; pending_move_id: string | null; created_at: string;
  pm_next_due: string | null; pm_overdue: number;
  events?: { id: string; kind: string; data: Record<string, unknown>; created_at: string; user_name: string | null }[];
  periods?: { id: string; status: Status; reason: string | null; started_at: string; ended_at: string | null; started_by_name: string | null; hours: number }[];
  documents?: Doc[];
}
interface Doc { id: string; kind: string; title: string; valid_until: string | null; mime_type: string; size_bytes: number; original_name: string | null; created_at: string; uploaded_by_name: string; expired: boolean }
interface Move { id: string; device_id: string; status: string; reason: string | null; decision_note: string | null; requested_at: string; decided_at: string | null; from_room: string | null; to_room: string | null;
  inv_no: string; device_name: string; from_department: string | null; to_department: string | null; from_or_room: string | null; to_or_room: string | null; to_responsible: string | null; requested_by_name: string }
interface Unlinked { id: string; kind: LinkKind; name: string; sub: string; room: string | null; is_active: boolean; serial_no: string | null; extra: string | null }
interface Person { id: string; name: string; department_id: string | null; department_name: string | null }

const FULL: Role[] = ['admin', 'med_engineer'];
const VIEW_ALL: Role[] = ['admin', 'med_engineer', 'bme_view', 'manager', 'viewer'];
export const STATUS_KA: Record<Status, string> = { operational: 'მუშა', restricted: 'შეზღუდულად მუშა', down: 'გაუმართავი / შეკეთებაში', standby: 'რეზერვი / სესხად', retired: 'გამოყვანილი' };
const STATUS_CHIP: Record<Status, string> = { operational: 'ok', restricted: 'warn', down: 'danger', standby: 'info', retired: '' };
export const CRIT_KA: Record<Crit, string> = { life_support: 'სიცოცხლის შემანარჩუნებელი', high: 'მაღალი', medium: 'საშუალო', low: 'დაბალი' };
const CRIT_CHIP: Record<Crit, string> = { life_support: 'danger', high: 'warn', medium: 'info', low: '' };
const GRP_KA: Record<string, string> = { imaging: 'გამოსახულება', life_support: 'სიცოცხლის შენარჩუნება', monitoring: 'მონიტორინგი', therapy: 'თერაპია', surgical: 'ქირურგია',
  lab: 'ლაბორატორია', sterilization: 'სტერილიზაცია', endoscopy: 'ენდოსკოპია', measuring: 'საზომი (მეტროლოგია)', other: 'სხვა' };
const LINK_KA: Record<LinkKind, string> = { dx_device: 'რადიოლოგია / ენდოსკოპიის ოთახი', lab_method: 'ლაბ. ანალიზატორი', cssd_machine: 'CSSD აპარატი', endo_scope: 'ენდოსკოპი' };
const DOC_KA: Record<string, string> = { manual: 'ინსტრუქცია (მომხმარებლის)', service_manual: 'სერვისის სახელმძღვანელო', certificate: 'სერტიფიკატი / კალიბრაცია', license: 'ლიცენზია / ნებართვა',
  act: 'აქტი', warranty: 'საგარანტიო', photo: 'ფოტო', other: 'სხვა' };
const EV_KA: Record<string, string> = { created: 'რეგისტრაცია', updated: 'რედაქტირება', status: 'სტატუსი', move_requested: 'გადაადგილების მოთხოვნა', moved: 'გადაადგილდა', move_rejected: 'მიღებაზე უარი',
  move_cancelled: 'გადაადგილება გაუქმდა', linked: 'მიება', unlinked: 'ბმა მოიხსნა', document: 'დოკუმენტი', document_removed: 'დოკუმენტი მოიხსნა', reviewed: 'გადამოწმდა',
  plan: 'გეგმა', work_planned: 'სამუშაო დაიგეგმა', work_done: 'სამუშაო შესრულდა', work_cancelled: 'სამუშაო გაუქმდა', meter: 'მთვლელი' };
const RES_KA: Record<string, string> = { pass: 'გავლილი', conditional: 'პირობითად', fail: 'ვერ გაიარა' };
const useRefs = () => useQuery({ queryKey: ['bme-refs'], queryFn: () => api<Refs>('/bme/refs') });
const useDeps = () => useQuery({ queryKey: ['departments'], queryFn: () => api<Department[]>('/departments') });
const n = (x: string) => (x.trim() ? x.trim() : null);
const grid3 = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 } as const;

export const StatusChip = ({ s }: { s: Status }) => <span className={`chip ${STATUS_CHIP[s]}`}>{STATUS_KA[s]}</span>;

/** ბიომედ-აპარატურა (0073): რეესტრი (პასპორტი), მისაღები, გადაადგილებები, მიუბმელები, შემაჯამებელი, იმპორტი, ტიპები; 0074: სამუშაოები (PM / კალიბრაცია / ელ. უსაფრთხოება), ჩეკლისტები / სახეები */
export default function Bme() {
  const { user } = useAuth(); const mods = useModules();
  const [sp, setSp] = useSearchParams();
  const enabled = mods.data?.find((m) => m.code === 'bme')?.enabled;
  const full = can(user, ...FULL);
  const tabs: [string, string, boolean][] = [['registry', 'რეესტრი', true], ['works', 'სამუშაოები', true], ['incoming', 'მისაღები', full || can(user, 'bme_dept')], ['moves', 'გადაადგილებები', true],
    ['unlinked', 'მიუბმელი ჩანაწერები', full], ['summary', 'შემაჯამებელი', can(user, ...VIEW_ALL)], ['import', 'იმპორტი', full], ['types', 'ტიპები', full], ['pmrefs', 'ჩეკლისტები / სახეები', full]];
  const refs = useRefs();
  const tab = sp.get('tab') ?? 'registry';
  // QR / სკანერი: /bme?inv=BME-00012 → პასპორტი
  const inv = sp.get('inv');
  const scan = useQuery({ queryKey: ['bme-scan', inv], queryFn: () => api<{ id: string }>('/bme/scan', { query: { code: inv } }), enabled: !!inv && !!enabled, retry: false });
  useEffect(() => { if (scan.data?.id) { sp.delete('inv'); sp.set('device', scan.data.id); setSp(sp, { replace: true }); } }, [scan.data]); // eslint-disable-line react-hooks/exhaustive-deps
  if (mods.isLoading) return <div className="content"><Loading /></div>;
  return (
    <>
      <header className="topbar" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8, paddingBottom: 0 }}>
        <h1>ბიომედ-აპარატურა</h1>
        <nav aria-label="ბიომედ-აპარატურა" className="row" style={{ gap: 2, flexWrap: 'wrap' }}>
          {tabs.filter((t) => t[2]).map(([k, l]) => <Link key={k} to={`/bme?tab=${k}`} className={`admin-tab${tab === k ? ' active' : ''}`} aria-current={tab === k ? 'page' : undefined}>{l}</Link>)}
        </nav>
      </header>
      {!enabled ? <div className="content"><div className="card empty">მოდული „ბიომედ-აპარატურა“ გამორთულია (ადმინისტრირება → მოდულები).</div></div>
        : <>
          {scan.error && <div className="content" style={{ paddingBottom: 0 }}><ErrorBox error={scan.error} /></div>}
          {tab === 'incoming' ? <Moves scope="incoming" /> : tab === 'moves' ? <Moves scope="" /> : tab === 'unlinked' ? <UnlinkedPage /> : tab === 'summary' ? <Summary />
            : tab === 'import' ? <ImportPage /> : tab === 'types' ? <TypesPage /> : tab === 'works' ? <WorksPage /> : tab === 'pmrefs' ? <PmRefsPage types={refs.data?.types ?? []} /> : <Registry />}
          {sp.get('device') && <DeviceDialog id={sp.get('device')!} onClose={() => { sp.delete('device'); setSp(sp, { replace: true }); }} />}
          {sp.get('work') && <WorkDialog id={sp.get('work')!} onClose={() => { sp.delete('work'); setSp(sp, { replace: true }); }} />}
        </>}
    </>
  );
}

// ---------------------------------------------------------------- რეესტრი
function Registry() {
  const { user } = useAuth(); const refs = useRefs(); const deps = useDeps(); const toast = useToast();
  const [sp, setSp] = useSearchParams();
  const [f, setF] = useState({ search: '', department_id: '', grp: '', type_id: '', status: 'active', criticality: '', needs_review: false });
  const ds = useDebounced(f.search.trim(), 300);
  const q = useQuery({ queryKey: ['bme-devices', { ...f, search: ds }], queryFn: () => api<Device[]>('/bme/devices', { query: { ...f, search: ds, needs_review: f.needs_review ? '1' : undefined } }) });
  const [sel, setSel] = useState<string[]>([]);
  const [create, setCreate] = useState(false);
  const full = can(user, ...FULL);
  const labels = async () => {
    const blob = await api<Blob>('/bme/labels', { query: { ids: sel.join(','), base: window.location.origin }, raw: true });
    const url = URL.createObjectURL(blob); window.open(url, '_blank'); setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
  const open = (id: string) => { sp.set('device', id); setSp(sp); };
  const rows = q.data ?? [];
  const r = refs.data;
  return (
    <div className="content">
      {toast.node}
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <input className="input" style={{ maxWidth: 300, height: 38 }} aria-label="ძებნა" placeholder="№ / QR სკანი, დასახელება, მოდელი, სერიული" value={f.search} onChange={(e) => setF({ ...f, search: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Enter' && rows.length === 1) open(rows[0].id); }} />
        <select className="select" style={{ maxWidth: 220, height: 38 }} aria-label="განყოფილება" value={f.department_id} onChange={(e) => setF({ ...f, department_id: e.target.value })}>
          <option value="">ყველა განყოფილება</option>{deps.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
        <select className="select" style={{ maxWidth: 190, height: 38 }} aria-label="ჯგუფი" value={f.grp} onChange={(e) => setF({ ...f, grp: e.target.value, type_id: '' })}>
          <option value="">ყველა ჯგუფი</option>{Object.entries(GRP_KA).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <select className="select" style={{ maxWidth: 230, height: 38 }} aria-label="ტიპი" value={f.type_id} onChange={(e) => setF({ ...f, type_id: e.target.value })}>
          <option value="">ყველა ტიპი</option>{r?.types.filter((t) => !f.grp || t.grp === f.grp).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
        <select className="select" style={{ maxWidth: 200, height: 38 }} aria-label="სტატუსი" value={f.status} onChange={(e) => { setF({ ...f, status: e.target.value }); setSel([]); }}>
          <option value="active">აქტიური (გამოყვანილის გარეშე)</option><option value="unavailable">არამუშა (შეზღ. / გაუმართავი)</option>
          {(Object.keys(STATUS_KA) as Status[]).map((s) => <option key={s} value={s}>{STATUS_KA[s]}</option>)}<option value="">ყველა</option></select>
        <select className="select" style={{ maxWidth: 200, height: 38 }} aria-label="კრიტიკულობა" value={f.criticality} onChange={(e) => setF({ ...f, criticality: e.target.value })}>
          <option value="">ყველა კრიტიკულობა</option>{(Object.keys(CRIT_KA) as Crit[]).map((c) => <option key={c} value={c}>{CRIT_KA[c]}</option>)}</select>
        {full && <label className="row small"><input type="checkbox" checked={f.needs_review} onChange={(e) => setF({ ...f, needs_review: e.target.checked })} /> შესავსები</label>}
        <span className="grow" />
        {sel.length > 0 && full && <button className="btn" type="button" onClick={() => void labels()}>ეტიკეტები ({sel.length})</button>}
        {full && <button className="btn primary" type="button" onClick={() => setCreate(true)}>+ რეგისტრაცია</button>}
      </div>
      {!can(user, ...VIEW_ALL) && <span className="hint">ჩანს თქვენი განყოფილებ(ებ)ის აპარატურა.</span>}
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead><tr>{full && <th><input type="checkbox" aria-label="ყველას მონიშვნა" checked={rows.length > 0 && sel.length === rows.length} onChange={(e) => setSel(e.target.checked ? rows.map((x) => x.id) : [])} /></th>}
              <th>№</th><th>აპარატი</th><th>ტიპი</th><th>ადგილი</th><th>სტატუსი</th><th>კრიტიკულობა</th><th>შემდ. სამუშაო</th><th>გარანტია</th></tr></thead>
            <tbody>{rows.map((d) => (
              <tr key={d.id} className="clickable" onClick={() => open(d.id)}>
                {full && <td onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={`მონიშვნა ${d.inv_no}`} checked={sel.includes(d.id)} onChange={(e) => setSel(e.target.checked ? [...sel, d.id] : sel.filter((x) => x !== d.id))} /></td>}
                <td className="mono" style={{ whiteSpace: 'nowrap' }}>{d.inv_no}</td>
                <td><strong>{d.name}</strong>{(d.manufacturer || d.model || d.serial_no) && <div className="small muted">{[d.manufacturer, d.model].filter(Boolean).join(' ')}{d.serial_no ? ` · SN ${d.serial_no}` : ''}</div>}
                  <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>{d.needs_review && <span className="chip warn" style={{ height: 20, fontSize: 11 }}>შესავსები</span>}
                    {d.link_kind && <span className="chip info" style={{ height: 20, fontSize: 11 }} title={d.link_name ?? ''}>{LINK_KA[d.link_kind]}</span>}
                    {d.pending_move_id && <span className="chip warn" style={{ height: 20, fontSize: 11 }}>გადაადგილება — ელოდება</span>}</div></td>
                <td className="small">{d.type_name}</td>
                <td className="small">{d.department_name ?? <span className="muted">—</span>}{(d.room || d.or_room_name) && <div className="muted">{[d.or_room_name, d.room && `ოთახი ${d.room}`].filter(Boolean).join(' · ')}</div>}</td>
                <td><StatusChip s={d.status} />{d.status_reason && d.status !== 'operational' && <div className="small muted" style={{ maxWidth: 220 }}>{d.status_reason}</div>}</td>
                <td><span className={`chip ${CRIT_CHIP[d.criticality]}`}>{CRIT_KA[d.criticality]}</span></td>
                <td style={{ whiteSpace: 'nowrap' }}>{d.status === 'retired' ? '—' : d.pm_overdue > 0 ? <span className="chip danger" title={`ვადაგადაცილებული: ${d.pm_overdue}`}>ვადაგადაცილ. {d.pm_overdue}</span>
                  : d.pm_next_due ? <DueChip due={d.pm_next_due} days={Math.round((new Date(d.pm_next_due).getTime() - new Date(new Date().toDateString()).getTime()) / 864e5)} /> : <span className="muted small">—</span>}</td>
                <td className="small">{d.warranty_until ? <span className={d.under_warranty ? '' : 'muted'}>{dateGe(d.warranty_until)}</span> : '—'}</td>
              </tr>))}
              {!rows.length && <tr><td colSpan={9} className="muted">აპარატი არ მოიძებნა</td></tr>}
            </tbody>
          </table>
        </div>)}
      {create && <CreateDialog onClose={() => setCreate(false)} onDone={(id) => { setCreate(false); toast.show('დარეგისტრირდა'); open(id); }} />}
    </div>
  );
}

function PersonPicker({ value, label, onChange }: { value: string | null; label: string | null; onChange: (p: Person | null) => void }) {
  const [q, setQ] = useState(''); const dq = useDebounced(q.trim(), 250);
  const r = useQuery({ queryKey: ['bme-people', dq], queryFn: () => api<Person[]>('/bme/people', { query: { search: dq } }), enabled: dq.length >= 2 });
  if (value) return <div className="row" style={{ gap: 6 }}><span className="grow">{label}</span><button className="btn sm" type="button" onClick={() => onChange(null)}>შეცვლა</button></div>;
  return (
    <div style={{ position: 'relative' }}>
      <input className="input" aria-label="თანამშრომლის ძებნა" placeholder="სახელი, გვარი (მინ. 2 სიმბ.)" value={q} onChange={(e) => setQ(e.target.value)} />
      {dq.length >= 2 && (r.data?.length ?? 0) > 0 && <ul className="listbox" role="listbox" aria-label="თანამშრომლები" style={{ position: 'absolute', top: 46, left: 0, right: 0, zIndex: 6 }}>
        {r.data!.map((p) => <li key={p.id} role="option" aria-selected={false} onMouseDown={(e) => { e.preventDefault(); onChange(p); setQ(''); }}><span className="grow">{p.name}</span><span className="small muted">{p.department_name ?? ''}</span></li>)}</ul>}
    </div>
  );
}

// ---------------------------------------------------------------- პასპორტის ველები (რეგისტრაცია / რედაქტირება)
type Form = { inv_no: string; name: string; type_id: string; manufacturer: string; model: string; serial_no: string; gmdn_code: string; risk_class: string; criticality: string;
  manufacture_year: string; install_date: string; purchase_date: string; purchase_value: string; warranty_until: string; notes: string };
const toForm = (d?: Device | null): Form => ({ inv_no: d?.inv_no ?? '', name: d?.name ?? '', type_id: d?.type_id ?? '', manufacturer: d?.manufacturer ?? '', model: d?.model ?? '', serial_no: d?.serial_no ?? '',
  gmdn_code: d?.gmdn_code ?? '', risk_class: d?.risk_class ?? '', criticality: d?.criticality ?? '', manufacture_year: d?.manufacture_year ? String(d.manufacture_year) : '',
  install_date: d?.install_date ?? '', purchase_date: d?.purchase_date ?? '', purchase_value: d?.purchase_value ? String(Number(d.purchase_value)) : '', warranty_until: d?.warranty_until ?? '', notes: d?.notes ?? '' });
const fromForm = (f: Form) => ({ name: f.name.trim(), type_id: f.type_id, manufacturer: n(f.manufacturer), model: n(f.model), serial_no: n(f.serial_no), gmdn_code: n(f.gmdn_code),
  risk_class: f.risk_class || null, ...(f.criticality && { criticality: f.criticality }), manufacture_year: f.manufacture_year ? Number(f.manufacture_year) : null,
  install_date: n(f.install_date), purchase_date: n(f.purchase_date), purchase_value: f.purchase_value.trim() ? Number(f.purchase_value.replace(',', '.')) : null, warranty_until: n(f.warranty_until), notes: n(f.notes) });

function PassportFields({ f, set, types, isNew }: { f: Form; set: (k: keyof Form, v: string) => void; types: DType[]; isNew: boolean }) {
  const t = types.find((x) => x.id === f.type_id);
  return (
    <div style={grid3}>
      <Field label="საინვენტარო №" htmlFor="bin" hint={isNew ? 'ცარიელი — ავტომატური' : undefined}><input id="bin" className="input mono" value={f.inv_no} onChange={(e) => set('inv_no', e.target.value.toUpperCase())} /></Field>
      <div style={{ gridColumn: 'span 2' }}><Field label="დასახელება" htmlFor="bn" required><input id="bn" className="input" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="მაგ. ვენტილატორი Dräger Evita V500 #2" /></Field></div>
      <Field label="ტიპი" htmlFor="bt" required><select id="bt" className="select" value={f.type_id} onChange={(e) => set('type_id', e.target.value)}>
        <option value="">— აირჩიეთ —</option>{Object.entries(GRP_KA).map(([g, gl]) => { const xs = types.filter((x) => x.grp === g && (x.is_active || x.id === f.type_id)); return xs.length ? <optgroup key={g} label={gl}>{xs.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</optgroup> : null; })}</select></Field>
      <Field label="მწარმოებელი" htmlFor="bm"><input id="bm" className="input" value={f.manufacturer} onChange={(e) => set('manufacturer', e.target.value)} /></Field>
      <Field label="მოდელი" htmlFor="bmo"><input id="bmo" className="input" value={f.model} onChange={(e) => set('model', e.target.value)} /></Field>
      <Field label="სერიული №" htmlFor="bs"><input id="bs" className="input mono" value={f.serial_no} onChange={(e) => set('serial_no', e.target.value.toUpperCase())} /></Field>
      <Field label="კრიტიკულობა" htmlFor="bc" hint={t && !f.criticality ? `ტიპით: ${CRIT_KA[t.default_criticality]}` : undefined}><select id="bc" className="select" value={f.criticality} onChange={(e) => set('criticality', e.target.value)}>
        {isNew && <option value="">ტიპის მიხედვით</option>}{(Object.keys(CRIT_KA) as Crit[]).map((c) => <option key={c} value={c}>{CRIT_KA[c]}</option>)}</select></Field>
      <Field label="რისკის კლასი (EU MDR)" htmlFor="br"><select id="br" className="select" value={f.risk_class} onChange={(e) => set('risk_class', e.target.value)}>
        <option value="">—</option>{['I', 'IIa', 'IIb', 'III'].map((c) => <option key={c} value={c}>{c}</option>)}</select></Field>
      <Field label="GMDN კოდი" htmlFor="bg"><input id="bg" className="input mono" value={f.gmdn_code} onChange={(e) => set('gmdn_code', e.target.value)} /></Field>
      <Field label="გამოშვების წელი" htmlFor="by"><input id="by" className="input mono" inputMode="numeric" value={f.manufacture_year} onChange={(e) => set('manufacture_year', e.target.value.replace(/\D/g, '').slice(0, 4))} /></Field>
      <Field label="ექსპლუატაციაში შეყვანა" htmlFor="bi"><input id="bi" className="input mono" type="date" value={f.install_date} onChange={(e) => set('install_date', e.target.value)} /></Field>
      <Field label="შეძენის თარიღი" htmlFor="bpd"><input id="bpd" className="input mono" type="date" value={f.purchase_date} onChange={(e) => set('purchase_date', e.target.value)} /></Field>
      <Field label="ღირებულება (₾)" htmlFor="bpv"><input id="bpv" className="input mono" inputMode="decimal" value={f.purchase_value} onChange={(e) => set('purchase_value', e.target.value)} /></Field>
      <Field label="გარანტია (მდე)" htmlFor="bw"><input id="bw" className="input mono" type="date" value={f.warranty_until} onChange={(e) => set('warranty_until', e.target.value)} /></Field>
      <div style={{ gridColumn: '1 / -1' }}><Field label="შენიშვნა" htmlFor="bno"><input id="bno" className="input" value={f.notes} onChange={(e) => set('notes', e.target.value)} /></Field></div>
    </div>
  );
}

function CreateDialog({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const qc = useQueryClient(); const refs = useRefs(); const deps = useDeps();
  const [f, setF] = useState<Form>(toForm(null));
  const [loc, setLoc] = useState({ department_id: '', room: '', or_room_id: '' });
  const set = (k: keyof Form, v: string) => setF((p) => ({ ...p, [k]: v }));
  const s = refs.data?.settings;
  const m = useMutation({
    mutationFn: () => api<Device>('/bme/devices', { body: { ...fromForm(f), inv_no: n(f.inv_no), department_id: loc.department_id || null, room: n(loc.room), or_room_id: loc.or_room_id || null } }),
    onSuccess: (d) => { void qc.invalidateQueries({ queryKey: ['bme-devices'] }); onDone(d.id); },
  });
  const rooms = refs.data?.or_rooms.filter((o) => !loc.department_id || o.department_id === loc.department_id) ?? [];
  return (
    <Modal title="აპარატის რეგისტრაცია" onClose={onClose} width={940}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button>
        <button className="btn primary" type="button" disabled={m.isPending || f.name.trim().length < 2 || !f.type_id || (!!s?.require_department && !loc.department_id)} onClick={() => m.mutate()}>რეგისტრაცია</button></>}>
      {!refs.data ? <Loading /> : (
        <div className="stack">
          <PassportFields f={f} set={set} types={refs.data.types} isNew />
          <div style={grid3}>
            <Field label="განყოფილება" htmlFor="bd" required={s?.require_department}><select id="bd" className="select" value={loc.department_id} onChange={(e) => setLoc({ ...loc, department_id: e.target.value, or_room_id: '' })}>
              <option value="">— აირჩიეთ —</option>{deps.data?.filter((d) => d.is_active).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
            <Field label="ოთახი" htmlFor="bro"><input id="bro" className="input" value={loc.room} onChange={(e) => setLoc({ ...loc, room: e.target.value })} /></Field>
            {refs.data.or_rooms.length > 0 && <Field label="საოპერაციო ოთახი" htmlFor="bor"><select id="bor" className="select" value={loc.or_room_id} onChange={(e) => setLoc({ ...loc, or_room_id: e.target.value })}>
              <option value="">—</option>{rooms.map((o) => <option key={o.id} value={o.id}>{o.name} · {o.department_name}</option>)}</select></Field>}
          </div>
          <span className="hint">ოპერაციულ ჩანაწერთან (რადიოლოგიის აპარატი, ანალიზატორი, CSSD, ენდოსკოპი) მიბმა — პასპორტიდან („ბმა“) ან „მიუბმელი ჩანაწერებიდან“.</span>
          <ErrorBox error={m.error} />
        </div>)}
    </Modal>
  );
}

// ---------------------------------------------------------------- პასპორტი
function DeviceDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { user } = useAuth(); const qc = useQueryClient(); const refs = useRefs(); const toast = useToast();
  const q = useQuery({ queryKey: ['bme-device', id], queryFn: () => api<Device>(`/bme/devices/${id}`) });
  const d = q.data; const full = can(user, ...FULL);
  const [f, setF] = useState<Form | null>(null);
  const [sec, setSec] = useState<'passport' | 'pm' | 'documents' | 'status' | 'history' | 'moves'>('passport');
  const [dlg, setDlg] = useState<'status' | 'move' | 'link' | null>(null);
  useEffect(() => { if (d && !f) setF(toForm(d)); }, [d]); // eslint-disable-line react-hooks/exhaustive-deps
  const done = () => { void qc.invalidateQueries({ queryKey: ['bme-device', id] }); void qc.invalidateQueries({ queryKey: ['bme-devices'] }); void qc.invalidateQueries({ queryKey: ['bme-alerts'] }); };
  const save = useMutation({
    mutationFn: () => api<Device>(`/bme/devices/${id}`, { method: 'PATCH', body: { ...fromForm(f!), ...(f!.inv_no.trim() && f!.inv_no.trim().toUpperCase() !== d!.inv_no && { inv_no: f!.inv_no.trim() }) } }),
    onSuccess: (r) => { qc.setQueryData(['bme-device', id], r); setF(toForm(r)); done(); toast.show('შენახულია'); },
  });
  const review = useMutation({ mutationFn: () => api<Device>(`/bme/devices/${id}/review`, { method: 'POST' }), onSuccess: (r) => { qc.setQueryData(['bme-device', id], r); done(); } });
  const unlink = useMutation({ mutationFn: () => api<Device>(`/bme/devices/${id}/unlink`, { method: 'POST' }), onSuccess: (r) => { qc.setQueryData(['bme-device', id], r); done(); } });
  const label = async () => { const blob = await api<Blob>('/bme/labels', { query: { ids: id, base: window.location.origin }, raw: true }); const u = URL.createObjectURL(blob); window.open(u, '_blank'); setTimeout(() => URL.revokeObjectURL(u), 60_000); };
  const dirty = !!(d && f && JSON.stringify(f) !== JSON.stringify(toForm(d)));
  const editable = full && d?.status !== 'retired';
  return (
    <Modal title={d ? `${d.inv_no} — ${d.name}` : 'აპარატი'} onClose={onClose} width={1000}
      footer={<>{full && d && <>
          {d.status !== 'retired' && <button className="btn" type="button" onClick={() => setDlg('status')}>სტატუსი</button>}
          {d.status !== 'retired' && !d.pending_move_id && <button className="btn" type="button" onClick={() => setDlg('move')}>გადაადგილება</button>}
          {d.link_kind ? <button className="btn" type="button" disabled={unlink.isPending} onClick={() => { if (confirm(`მოვხსნათ ბმა: ${d.link_name}?`)) unlink.mutate(); }}>ბმის მოხსნა</button>
            : <button className="btn" type="button" onClick={() => setDlg('link')}>ბმა</button>}
          <button className="btn" type="button" onClick={() => void label()}>ეტიკეტი</button></>}
        <span className="grow" />
        <button className="btn" type="button" onClick={onClose}>დახურვა</button>
        {editable && sec === 'passport' && <button className="btn primary" type="button" disabled={!dirty || save.isPending || !f || f.name.trim().length < 2 || !f.type_id} onClick={() => save.mutate()}>შენახვა</button>}</>}>
      {toast.node}
      {!d || !f || !refs.data ? (q.error ? <ErrorBox error={q.error} /> : <Loading />) : (
        <div className="stack">
          <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
            <StatusChip s={d.status} />{d.status_reason && <span className="small">{d.status_reason}</span>}<span className="small muted">{tsDate(d.status_since)}-დან</span>
            <span className={`chip ${CRIT_CHIP[d.criticality]}`}>{CRIT_KA[d.criticality]}</span>
            {d.link_kind && <span className="chip info" title="ოპერაციული ჩანაწერი — მისი სტატუსი აისახება დაგეგმვაზე">{LINK_KA[d.link_kind]}: {d.link_name}</span>}
            {d.under_warranty && <span className="chip ok">გარანტიაში {dateGe(d.warranty_until!)}-მდე</span>}
            <span className="grow" />
            {d.needs_review && full && <button className="btn sm primary" type="button" disabled={review.isPending} onClick={() => review.mutate()}>გადამოწმებულია</button>}
          </div>
          {d.needs_review && <div className="alert warn">ავტომატურად შექმნილი პასპორტი (არსებული ჩანაწერიდან) — შეავსეთ მწარმოებელი, მოდელი, სერიული, განყოფილება და მონიშნეთ „გადამოწმებულია“.</div>}
          {d.pending_move_id && <div className="alert info">გადაადგილება ელოდება მიმღები განყოფილების დადასტურებას.</div>}
          <div className="row small" style={{ flexWrap: 'wrap', gap: 16 }}>
            <span>ადგილი: <strong>{d.department_name ?? '—'}{d.or_room_name ? ` · ${d.or_room_name}` : ''}{d.room ? ` · ოთახი ${d.room}` : ''}</strong></span>
            <span>პასუხისმგებელი: <strong>{d.responsible_name ?? '—'}</strong></span>
            {d.asset_inv_no && <span>ბუღალტრული ინვენტარი: <strong className="mono">{d.asset_inv_no}</strong></span>}
          </div>
          <div className="seg" role="group" aria-label="განყოფილება" style={{ alignSelf: 'flex-start' }}>
            {([['passport', 'პასპორტი'], ['pm', 'გეგმები / სამუშაოები'], ['documents', `დოკუმენტები (${d.documents?.length ?? 0})`], ['status', 'სტატუსის ისტორია'], ['moves', 'გადაადგილებები'], ['history', 'ქრონოლოგია']] as const)
              .map(([k, l]) => <button key={k} type="button" aria-pressed={sec === k} onClick={() => setSec(k)}>{l}</button>)}
          </div>
          {sec === 'passport' && <fieldset disabled={!editable} style={{ border: 0, padding: 0, margin: 0 }}><PassportFields f={f} set={(k, v) => setF({ ...f, [k]: v })} types={refs.data.types} isNew={false} /></fieldset>}
          {sec === 'pm' && <DevicePm deviceId={d.id} retired={d.status === 'retired'} />}
          {sec === 'documents' && <Documents d={d} full={full} onChange={done} />}
          {sec === 'status' && (
            <table className="table"><thead><tr><th>სტატუსი</th><th>მიზეზი</th><th>დასაწყისი</th><th>დასასრული</th><th className="num">საათი</th><th>ვინ</th></tr></thead>
              <tbody>{d.periods?.map((p) => <tr key={p.id}><td><StatusChip s={p.status} /></td><td className="small">{p.reason ?? ''}</td><td className="small">{tsDate(p.started_at)} {new Date(p.started_at).toTimeString().slice(0, 5)}</td>
                <td className="small">{p.ended_at ? `${tsDate(p.ended_at)} ${new Date(p.ended_at).toTimeString().slice(0, 5)}` : <span className="chip">მიმდინარე</span>}</td><td className="num mono">{p.hours}</td><td className="small">{p.started_by_name ?? 'მიგრაცია'}</td></tr>)}</tbody></table>)}
          {sec === 'moves' && <MovesTable deviceId={d.id} />}
          {sec === 'history' && (
            <table className="table"><tbody>{d.events?.map((e) => <tr key={e.id}><td className="small" style={{ whiteSpace: 'nowrap' }}>{tsDate(e.created_at)}</td><td>{EV_KA[e.kind] ?? e.kind}</td>
              <td className="small muted">{e.kind === 'status' ? `${STATUS_KA[e.data.from as Status] ?? ''} → ${STATUS_KA[e.data.to as Status] ?? ''}${e.data.reason ? ` · ${e.data.reason}` : ''}`
                : e.kind === 'updated' ? (e.data.fields as string[]).join(', ') : e.kind === 'linked' || e.kind === 'created' ? String(e.data.name ?? e.data.link_name ?? e.data.inv_no ?? '')
                  : e.kind === 'work_done' ? `${e.data.work_no} · ${e.data.kind ?? ''} · ${RES_KA[e.data.result as string] ?? ''}${e.data.next_due ? ` · შემდეგი ${dateGe(e.data.next_due as string)}` : ''}`
                  : e.kind === 'work_planned' || e.kind === 'work_cancelled' ? `${e.data.work_no}${e.data.reason ? ` · ${e.data.reason}` : ''}`
                  : e.kind === 'meter' ? `${e.data.value} (${e.data.unit})` : e.kind === 'plan' ? `${e.data.kind ?? ''}${e.data.next_due ? ` · ვადა ${dateGe(e.data.next_due as string)}` : ''}${e.data.interval_months ? ` · ${e.data.interval_months} თვე` : ''}`
                  : typeof e.data.reason === 'string' ? e.data.reason : typeof e.data.note === 'string' ? e.data.note : typeof e.data.title === 'string' ? e.data.title : e.data.backfill ? 'არსებული ჩანაწერიდან (მიგრაცია)' : ''}</td>
              <td className="small">{e.user_name ?? 'სისტემა'}</td></tr>)}</tbody></table>)}
          <ErrorBox error={save.error ?? review.error ?? unlink.error} />
        </div>)}
      {dlg === 'status' && d && <StatusDialog d={d} onClose={() => setDlg(null)} onDone={(r) => { setDlg(null); qc.setQueryData(['bme-device', id], r); done(); }} />}
      {dlg === 'move' && d && <MoveDialog d={d} onClose={() => setDlg(null)} onDone={() => { setDlg(null); done(); void qc.invalidateQueries({ queryKey: ['bme-moves'] }); }} />}
      {dlg === 'link' && d && <LinkDialog d={d} onClose={() => setDlg(null)} onDone={(r) => { setDlg(null); qc.setQueryData(['bme-device', id], r); done(); }} />}
    </Modal>
  );
}

function StatusDialog({ d, onClose, onDone }: { d: Device; onClose: () => void; onDone: (r: Device) => void }) {
  const [s, setS] = useState<Status>(d.status === 'operational' ? 'down' : 'operational'); const [reason, setReason] = useState('');
  const need = ['restricted', 'down', 'retired'].includes(s);
  const m = useMutation({ mutationFn: () => api<Device>(`/bme/devices/${d.id}/status`, { body: { status: s, reason: n(reason) } }), onSuccess: onDone });
  return (
    <Modal title={`სტატუსი: ${d.inv_no}`} onClose={onClose} width={560}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={m.isPending || (need && reason.trim().length < 3)} onClick={() => m.mutate()}>შენახვა</button></>}>
      <div className="stack">
        <span className="small muted">ახლა: {STATUS_KA[d.status]}{d.status_reason ? ` — ${d.status_reason}` : ''}</span>
        <div className="stack" style={{ gap: 6 }}>{(Object.keys(STATUS_KA) as Status[]).map((k) => <label key={k} className="row"><input type="radio" name="bst" checked={s === k} onChange={() => setS(k)} /> <StatusChip s={k} /></label>)}</div>
        <Field label="მიზეზი" htmlFor="bsr" required={need}><input id="bsr" className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={s === 'down' ? 'მაგ. არ ირთვება, ელოდება სერვისს' : s === 'retired' ? 'მაგ. ჩამოწერა — შეკეთება არ ღირს' : ''} /></Field>
        {d.link_kind && ['down', 'retired'].includes(s) && <span className="hint">მიბმულ ჩანაწერზე ({LINK_KA[d.link_kind]}) ჩაწერა / გამოყენება შეიზღუდება (პარამეტრის მიხედვით: დაბლოკვა ან გაფრთხილება).</span>}
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}

function MoveDialog({ d, onClose, onDone }: { d: Device; onClose: () => void; onDone: () => void }) {
  const refs = useRefs(); const deps = useDeps(); const toast = useToast();
  const [f, setF] = useState({ dep: d.department_id ?? '', room: d.room ?? '', or: d.or_room_id ?? '', reason: '' });
  const [resp, setResp] = useState<{ id: string; name: string } | null>(null);
  const s = refs.data?.settings;
  const m = useMutation({
    mutationFn: () => api<{ status: string }>(`/bme/devices/${d.id}/move`, { body: { to_department_id: f.dep, to_room: n(f.room), to_or_room_id: f.or || null, ...(resp && { to_responsible_id: resp.id }), reason: n(f.reason) } }),
    onSuccess: (r) => { toast.show(r.status === 'done' ? 'გადაადგილდა' : 'გაიგზავნა — ელოდება მიმღების დადასტურებას'); onDone(); },
  });
  const rooms = refs.data?.or_rooms.filter((o) => o.department_id === f.dep) ?? [];
  return (
    <Modal title={`გადაადგილება: ${d.inv_no}`} onClose={onClose} width={640}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button>
        <button className="btn primary" type="button" disabled={!f.dep || m.isPending} onClick={() => m.mutate()}>{s?.move_mode === 'confirm' && f.dep !== d.department_id ? 'გაგზავნა მიმღებთან' : 'გადაადგილება'}</button></>}>
      {toast.node}
      <div className="stack">
        <span className="small muted">ახლა: {d.department_name ?? '—'}{d.or_room_name ? ` · ${d.or_room_name}` : ''}{d.room ? ` · ოთახი ${d.room}` : ''}</span>
        <Field label="განყოფილება" htmlFor="md" required><select id="md" className="select" value={f.dep} onChange={(e) => setF({ ...f, dep: e.target.value, or: '' })}>
          <option value="">— აირჩიეთ —</option>{deps.data?.filter((x) => x.is_active).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
        <Field label="ოთახი" htmlFor="mr"><input id="mr" className="input" value={f.room} onChange={(e) => setF({ ...f, room: e.target.value })} /></Field>
        {rooms.length > 0 && <Field label="საოპერაციო ოთახი" htmlFor="mor"><select id="mor" className="select" value={f.or} onChange={(e) => setF({ ...f, or: e.target.value })}>
          <option value="">—</option>{rooms.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></Field>}
        <div className="field"><span className="label">ახალი პასუხისმგებელი (არასავალდებულო)</span><PersonPicker value={resp?.id ?? null} label={resp?.name ?? null} onChange={(p) => setResp(p)} /></div>
        <Field label="მიზეზი" htmlFor="mre"><input id="mre" className="input" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
        {s?.move_mode === 'confirm' && <span className="hint">სხვა განყოფილებაში — მიმღები განყოფილება (ბიომედ-აპარატურა, განყოფილება) დაადასტურებს „მისაღებში“; იმავე განყოფილებაში — პირდაპირ.</span>}
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}

function LinkDialog({ d, onClose, onDone }: { d: Device; onClose: () => void; onDone: (r: Device) => void }) {
  const q = useQuery({ queryKey: ['bme-unlinked'], queryFn: () => api<Unlinked[]>('/bme/unlinked') });
  const [kind, setKind] = useState<LinkKind>(d.grp === 'lab' ? 'lab_method' : d.grp === 'sterilization' ? 'cssd_machine' : d.type_code === 'ENDOSCOPE' ? 'endo_scope' : 'dx_device');
  const m = useMutation({ mutationFn: (target: string) => api<Device>(`/bme/devices/${d.id}/link`, { body: { kind, target_id: target } }), onSuccess: onDone });
  const rows = q.data?.filter((x) => x.kind === kind) ?? [];
  return (
    <Modal title={`ბმა ოპერაციულ ჩანაწერთან: ${d.inv_no}`} onClose={onClose} width={720} footer={<button className="btn" type="button" onClick={onClose}>დახურვა</button>}>
      <div className="stack">
        <span className="hint">მიბმის შემდეგ აპარატის სტატუსი აისახება ჩაწერაზე / გამოყენებაზე (რადიოლოგია, ენდოსკოპია, CSSD, ლაბორატორია).</span>
        <div className="seg" role="group" aria-label="სახეობა">{(Object.keys(LINK_KA) as LinkKind[]).map((k) => <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>{LINK_KA[k]}</button>)}</div>
        {q.isLoading ? <Loading /> : (
          <table className="table"><tbody>{rows.map((r) => <tr key={r.id}><td><strong>{r.name}</strong><div className="small muted">{[r.sub, r.extra, r.serial_no && `SN ${r.serial_no}`, r.room].filter(Boolean).join(' · ')}</div></td>
            <td>{!r.is_active && <span className="chip">გათიშული</span>}</td><td className="num"><button className="btn sm" type="button" disabled={m.isPending} onClick={() => m.mutate(r.id)}>მიბმა</button></td></tr>)}
            {!rows.length && <tr><td className="muted">მიუბმელი ჩანაწერი არ არის</td></tr>}</tbody></table>)}
        <ErrorBox error={q.error ?? m.error} />
      </div>
    </Modal>
  );
}

function Documents({ d, full, onChange }: { d: Device; full: boolean; onChange: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ kind: 'manual', title: '', valid_until: '' }); const [file, setFile] = useState<File | null>(null);
  const up = useMutation({
    mutationFn: () => { const fd = new FormData(); fd.append('files', file!); fd.append('kind', f.kind); if (f.title.trim()) fd.append('title', f.title.trim()); if (f.valid_until) fd.append('valid_until', f.valid_until);
      return apiUpload(`/bme/devices/${d.id}/documents`, fd); },
    onSuccess: () => { setFile(null); setF({ ...f, title: '', valid_until: '' }); void qc.invalidateQueries({ queryKey: ['bme-device', d.id] }); onChange(); },
  });
  const rm = useMutation({ mutationFn: (a: { id: string; reason: string }) => api(`/bme/devices/${d.id}/documents/${a.id}/remove`, { body: { reason: a.reason } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['bme-device', d.id] }); onChange(); } });
  return (
    <div className="stack">
      <table className="table"><thead><tr><th>დოკუმენტი</th><th>სახეობა</th><th>ვადა</th><th>ატვირთა</th><th /></tr></thead>
        <tbody>{d.documents?.map((x) => <tr key={x.id}>
          <td><button className="btn sm" type="button" onClick={() => void openBlob(`/bme/devices/${d.id}/documents/${x.id}`)}>{x.title}</button><div className="small muted">{x.original_name ?? ''} · {(x.size_bytes / 1024).toFixed(0)} KB</div></td>
          <td className="small">{DOC_KA[x.kind] ?? x.kind}</td>
          <td className="small">{x.valid_until ? <span className={`chip ${x.expired ? 'danger' : 'ok'}`}>{dateGe(x.valid_until)}{x.expired ? ' — ვადაგასული' : ''}</span> : '—'}</td>
          <td className="small">{x.uploaded_by_name}<div className="muted">{tsDate(x.created_at)}</div></td>
          <td className="num">{full && <button className="icon-btn" type="button" aria-label="მოხსნა" title="მოხსნა (მიზეზით)" onClick={() => { const r = prompt('მოხსნის მიზეზი'); if (r && r.trim().length >= 3) rm.mutate({ id: x.id, reason: r.trim() }); }}>×</button>}</td>
        </tr>)}{!d.documents?.length && <tr><td colSpan={5} className="muted">დოკუმენტი არ არის</td></tr>}</tbody></table>
      {full && d.status !== 'retired' && (
        <div className="card card-pad stack" style={{ gap: 8 }}>
          <strong className="small">დოკუმენტის დამატება (PDF, JPG, PNG — ≤ 20 MB)</strong>
          <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <select className="select" style={{ maxWidth: 240, height: 36 }} aria-label="სახეობა" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{Object.entries(DOC_KA).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
            <input className="input" style={{ maxWidth: 260, height: 36 }} aria-label="დასახელება" placeholder="დასახელება (არასავალდ.)" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
            <label className="row small">ვადა <input className="input mono" style={{ height: 36 }} type="date" value={f.valid_until} onChange={(e) => setF({ ...f, valid_until: e.target.value })} /></label>
            <input type="file" aria-label="ფაილი" accept="application/pdf,image/jpeg,image/png" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <button className="btn sm primary" type="button" disabled={!file || up.isPending} onClick={() => up.mutate()}>ატვირთვა</button>
          </div>
        </div>)}
      <ErrorBox error={up.error ?? rm.error} />
    </div>
  );
}

// ---------------------------------------------------------------- გადაადგილებები
function MovesTable({ deviceId }: { deviceId: string }) {
  const q = useQuery({ queryKey: ['bme-moves', 'device', deviceId], queryFn: () => api<Move[]>('/bme/moves', { query: { device_id: deviceId } }) });
  if (q.isLoading) return <Loading />;
  return <MoveRows rows={q.data ?? []} scope="device" />;
}
function Moves({ scope }: { scope: 'incoming' | '' }) {
  const q = useQuery({ queryKey: ['bme-moves', scope], queryFn: () => api<Move[]>('/bme/moves', { query: { scope: scope || undefined } }) });
  if (q.isLoading) return <div className="content"><Loading /></div>;
  return (
    <div className="content">
      {scope === 'incoming' && <span className="hint">თქვენს განყოფილებაში გადმოცემული აპარატურა — დაადასტურეთ მიღება ან თქვით უარი (მიზეზით).</span>}
      <div className="card" style={{ overflowX: 'auto' }}><MoveRows rows={q.data ?? []} scope={scope} /></div>
      <ErrorBox error={q.error} />
    </div>
  );
}
function MoveRows({ rows, scope }: { rows: Move[]; scope: 'incoming' | '' | 'device' }) {
  const qc = useQueryClient(); const { user } = useAuth();
  const inv = () => { for (const k of ['bme-moves', 'bme-devices', 'bme-device']) void qc.invalidateQueries({ queryKey: [k] }); };
  const dec = useMutation({ mutationFn: (a: { id: string; accept: boolean; note?: string }) => api(`/bme/moves/${a.id}/decide`, { body: { accept: a.accept, note: a.note } }), onSuccess: inv });
  const cancel = useMutation({ mutationFn: (id: string) => api(`/bme/moves/${id}/cancel`, { method: 'POST' }), onSuccess: inv });
  const place = (dep: string | null, or: string | null, room: string | null) => [dep ?? '—', or, room && `ოთახი ${room}`].filter(Boolean).join(' · ');
  return (
    <>
      <table className="table">
        <thead><tr><th>დრო</th>{scope !== 'device' && <th>აპარატი</th>}<th>საიდან</th><th>სად</th><th>მიზეზი</th><th>ინიციატორი</th><th>სტატუსი</th></tr></thead>
        <tbody>{rows.map((m) => (
          <tr key={m.id}>
            <td className="small">{tsDate(m.requested_at)}</td>{scope !== 'device' && <td><span className="mono">{m.inv_no}</span> {m.device_name}</td>}
            <td className="small">{place(m.from_department, m.from_or_room, m.from_room)}</td>
            <td className="small"><strong>{place(m.to_department, m.to_or_room, m.to_room)}</strong>{m.to_responsible && <div className="muted">{m.to_responsible}</div>}</td>
            <td className="small">{m.reason ?? ''}{m.decision_note && <div className="muted">→ {m.decision_note}</div>}</td><td className="small">{m.requested_by_name}</td>
            <td style={{ whiteSpace: 'nowrap' }}>{m.status === 'pending' ? (scope === 'incoming' ? <>
              <button className="btn sm primary" type="button" disabled={dec.isPending} onClick={() => dec.mutate({ id: m.id, accept: true })}>მივიღე</button>{' '}
              <button className="btn sm" type="button" disabled={dec.isPending} onClick={() => { const x = prompt('უარის მიზეზი'); if (x && x.trim().length >= 3) dec.mutate({ id: m.id, accept: false, note: x.trim() }); }}>უარი</button></>
              : <><span className="chip warn">ელოდება</span> {can(user, ...FULL) && <button className="btn sm" type="button" onClick={() => { if (confirm('გავაუქმოთ?')) cancel.mutate(m.id); }}>გაუქმება</button>}</>)
              : <span className={`chip ${m.status === 'done' ? 'ok' : m.status === 'rejected' ? 'danger' : ''}`}>{m.status === 'done' ? 'შესრულდა' : m.status === 'rejected' ? 'უარი' : 'გაუქმდა'}</span>}</td>
          </tr>))}
          {!rows.length && <tr><td colSpan={7} className="muted">{scope === 'incoming' ? 'მისაღები არაფერია' : 'გადაადგილება არ ყოფილა'}</td></tr>}
        </tbody>
      </table>
      <ErrorBox error={dec.error ?? cancel.error} />
    </>
  );
}

// ---------------------------------------------------------------- მიუბმელი ჩანაწერები
function UnlinkedPage() {
  const qc = useQueryClient(); const [sp, setSp] = useSearchParams();
  const q = useQuery({ queryKey: ['bme-unlinked'], queryFn: () => api<Unlinked[]>('/bme/unlinked') });
  const mk = useMutation({ mutationFn: (r: Unlinked) => api<Device>('/bme/devices/from-link', { body: { kind: r.kind, target_id: r.id } }),
    onSuccess: (d) => { for (const k of ['bme-unlinked', 'bme-devices']) void qc.invalidateQueries({ queryKey: [k] }); sp.set('device', d.id); setSp(sp); } });
  if (q.isLoading) return <div className="content"><Loading /></div>;
  const rows = q.data ?? [];
  return (
    <div className="content">
      <span className="hint">რადიოლოგიის / ენდოსკოპიის აპარატები, ანალიზატორები, CSSD აპარატები და ენდოსკოპები, რომლებსაც ჯერ პასპორტი არ აქვს. „პასპორტი“ — ავტომატურად (ტიპი, დასახელება, სერიული), შემდეგ შეავსეთ.</span>
      <div className="card"><table className="table">
        <thead><tr><th>სახეობა</th><th>ჩანაწერი</th><th>დეტალები</th><th>სტატუსი</th><th /></tr></thead>
        <tbody>{rows.map((r) => <tr key={`${r.kind}-${r.id}`}><td className="small">{LINK_KA[r.kind]}</td><td><strong>{r.name}</strong></td>
          <td className="small muted">{[r.sub, r.extra, r.serial_no && `SN ${r.serial_no}`, r.room].filter(Boolean).join(' · ')}</td>
          <td>{r.is_active ? <span className="chip ok">აქტიური</span> : <span className="chip">გათიშული</span>}</td>
          <td className="num"><button className="btn sm" type="button" disabled={mk.isPending} onClick={() => mk.mutate(r)}>პასპორტი</button></td></tr>)}
          {!rows.length && <tr><td colSpan={5} className="muted">ყველა ოპერაციულ ჩანაწერს პასპორტი აქვს</td></tr>}</tbody></table></div>
      <ErrorBox error={q.error ?? mk.error} />
    </div>
  );
}

// ---------------------------------------------------------------- შემაჯამებელი
interface Sum { by_status: { status: Status; n: number }[]; by_type: { type_name: string; grp: string; total: number; unavailable: number }[];
  by_department: { department_name: string | null; total: number; down: number; restricted: number; life_support: number; value: string }[];
  needs_review: number; warranty_60: number; no_department: number; expired_docs: number }
function Summary() {
  const q = useQuery({ queryKey: ['bme-summary'], queryFn: () => api<Sum>('/bme/summary') });
  if (q.isLoading) return <div className="content"><Loading /></div>;
  const s = q.data;
  if (!s) return <div className="content"><ErrorBox error={q.error} /></div>;
  const st = (k: Status) => s.by_status.find((x) => x.status === k)?.n ?? 0;
  const tiles: [string, number, string, string][] = [['მუშა', st('operational'), 'ok', '/bme?tab=registry'], ['შეზღუდულად', st('restricted'), 'warn', ''], ['გაუმართავი', st('down'), 'danger', ''],
    ['რეზერვი', st('standby'), 'info', ''], ['შესავსები', s.needs_review, 'warn', ''], ['განყოფილების გარეშე', s.no_department, 'warn', ''], ['გარანტია იწურება (60 დღე)', s.warranty_60, 'info', ''], ['ვადაგასული დოკუმენტი', s.expired_docs, 'danger', '']];
  return (
    <div className="content">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
        {tiles.map(([l, v, c]) => <div key={l} className="card card-pad stack" style={{ gap: 4 }}><span className="small muted">{l}</span><strong style={{ fontSize: 26 }} className={v && c !== 'ok' ? '' : 'muted'}>{v}</strong>
          {v > 0 && c !== 'ok' && <span className={`chip ${c}`} style={{ alignSelf: 'flex-start', height: 20, fontSize: 11 }}>ყურადღება</span>}</div>)}
      </div>
      <section className="card"><div className="card-head"><h2>განყოფილებები</h2></div>
        <table className="table"><thead><tr><th>განყოფილება</th><th className="num">სულ</th><th className="num">სიცოცხლის შემანარჩ.</th><th className="num">შეზღუდულად</th><th className="num">გაუმართავი</th><th className="num">ღირებულება</th></tr></thead>
          <tbody>{s.by_department.map((r, i) => <tr key={i}><td>{r.department_name ?? <span className="muted">განყოფილების გარეშე</span>}</td><td className="num">{r.total}</td><td className="num">{r.life_support || ''}</td>
            <td className="num">{r.restricted || ''}</td><td className="num">{r.down ? <span className="chip danger">{r.down}</span> : ''}</td><td className="num mono">{Number(r.value).toFixed(2)}</td></tr>)}</tbody></table></section>
      <section className="card"><div className="card-head"><h2>ტიპები</h2></div>
        <table className="table"><thead><tr><th>ტიპი</th><th>ჯგუფი</th><th className="num">სულ</th><th className="num">არამუშა</th></tr></thead>
          <tbody>{s.by_type.map((r) => <tr key={r.type_name}><td>{r.type_name}</td><td className="small">{GRP_KA[r.grp]}</td><td className="num">{r.total}</td><td className="num">{r.unavailable ? <span className="chip warn">{r.unavailable}</span> : ''}</td></tr>)}</tbody></table></section>
    </div>
  );
}

// ---------------------------------------------------------------- იმპორტი
function ImportPage() {
  const qc = useQueryClient(); const [file, setFile] = useState<File | null>(null);
  const [res, setRes] = useState<{ commit: boolean; created: number; skipped: number; errors: number; report: { row: number; status: string; inv_no: string; name: string; message?: string }[] } | null>(null);
  const run = useMutation({ mutationFn: (commit: boolean) => { const fd = new FormData(); fd.append('file', file!); return apiUpload<typeof res>(`/bme/import?commit=${commit}`, fd); },
    onSuccess: (r) => { setRes(r); if (r?.commit) void qc.invalidateQueries({ queryKey: ['bme-devices'] }); } });
  const tpl = async () => { const b = await api<Blob>('/bme/import/template', { raw: true }); const u = URL.createObjectURL(b); const a = document.createElement('a'); a.href = u; a.download = 'ბიომედ-აპარატურის-შაბლონი.xlsx'; a.click(); setTimeout(() => URL.revokeObjectURL(u), 10_000); };
  return (
    <div className="content">
      <section className="card card-pad stack">
        <h2>არსებული აპარატურის იმპორტი</h2>
        <span className="small">შაბლონი → შევსება (ტიპი და განყოფილება — <strong>კოდებით</strong>; კრიტიკულობა / რისკის კლასი ცარიელი — ტიპის მიხედვით) → შემოწმება → იმპორტი. ძველი საინვენტარო ნომერი ინახება; ცარიელი — ავტომატურად. რეესტრში უკვე არსებული სერიული (იმავე მწარმოებლით) — გამოტოვდება. შეცდომისას არაფერი იმპორტდება.</span>
        <div className="row" style={{ flexWrap: 'wrap' }}><button className="btn" type="button" onClick={() => void tpl()}>შაბლონი</button>
          <input type="file" aria-label="ფაილი" accept=".xlsx,.csv" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setRes(null); }} /><span className="grow" />
          <button className="btn" type="button" disabled={!file || run.isPending} onClick={() => run.mutate(false)}>შემოწმება</button>
          <button className="btn primary" type="button" disabled={!file || !res || res.commit || res.errors > 0 || !res.created || run.isPending} onClick={() => run.mutate(true)}>იმპორტი</button></div>
        <ErrorBox error={run.error} />
      </section>
      {res && <section className="card"><div className={`alert ${res.errors ? 'warn' : 'ok'}`} style={{ margin: 12 }}>{res.commit ? 'იმპორტირებულია' : 'შემოწმება'}: {res.created} ახალი, {res.skipped} გამოტოვებული, {res.errors} შეცდომა</div>
        <table className="table"><tbody>{res.report.map((r) => <tr key={r.row}><td className="num mono">{r.row}</td><td className="mono">{r.inv_no}</td><td>{r.name}</td>
          <td><span className={`chip ${r.status === 'create' ? 'ok' : r.status === 'error' ? 'danger' : ''}`}>{r.status === 'create' ? 'ახალი' : r.status === 'error' ? 'შეცდომა' : 'გამოტოვდა'}</span></td><td className="small">{r.message ?? ''}</td></tr>)}</tbody></table></section>}
    </div>
  );
}

// ---------------------------------------------------------------- ტიპები
function TypesPage() {
  const refs = useRefs();
  const [edit, setEdit] = useState<DType | 'new' | null>(null);
  if (!refs.data) return <div className="content">{refs.error ? <ErrorBox error={refs.error} /> : <Loading />}</div>;
  const iv = (x: number | null) => (x ? `${x} თვე` : '—');
  return (
    <div className="content">
      <div className="row"><span className="hint grow">ინტერვალები — PM / კალიბრაციის / ელ. უსაფრთხოების გეგმების ნაგულისხმევი (ცვლილების შემდეგ — „ჩეკლისტები / სახეები“ → „გეგმების სინქრონიზაცია“ აკლებულ გეგმებს შექმნის); კრიტიკულობა / რისკი — ახალი აპარატის ნაგულისხმევი.</span>
        <button className="btn primary" type="button" onClick={() => setEdit('new')}>+ ტიპი</button></div>
      <div className="card" style={{ overflowX: 'auto' }}><table className="table">
        <thead><tr><th>ტიპი</th><th>ჯგუფი</th><th>კრიტიკულობა</th><th>რისკი</th><th>PM</th><th>კალიბრაცია</th><th>ელ. უსაფრთხ.</th><th className="num">აპარატი</th><th /></tr></thead>
        <tbody>{refs.data.types.map((t) => <tr key={t.id} className="clickable" onClick={() => setEdit(t)} style={t.is_active ? undefined : { opacity: 0.55 }}>
          <td><strong>{t.name}</strong><div className="mono small muted">{t.code}</div></td><td className="small">{GRP_KA[t.grp]}</td><td><span className={`chip ${CRIT_CHIP[t.default_criticality]}`}>{CRIT_KA[t.default_criticality]}</span></td>
          <td className="small">{t.default_risk_class ?? '—'}</td><td className="small">{iv(t.pm_months)}</td><td className="small">{iv(t.calibration_months)}</td><td className="small">{iv(t.safety_months)}</td>
          <td className="num">{t.devices || ''}</td><td>{!t.is_active && <span className="chip">გათიშული</span>}</td></tr>)}</tbody></table></div>
      {edit && <TypeDialog t={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </div>
  );
}
function TypeDialog({ t, onClose }: { t: DType | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ code: t?.code ?? '', name: t?.name ?? '', grp: t?.grp ?? 'other', default_criticality: t?.default_criticality ?? 'medium', default_risk_class: t?.default_risk_class ?? '',
    pm_months: t?.pm_months ? String(t.pm_months) : '', calibration_months: t?.calibration_months ? String(t.calibration_months) : '', safety_months: t?.safety_months ? String(t.safety_months) : '', is_active: t?.is_active ?? true });
  const num = (x: string) => (x.trim() ? Number(x) : null);
  const m = useMutation({
    mutationFn: () => { const body = { name: f.name.trim(), grp: f.grp, default_criticality: f.default_criticality, default_risk_class: f.default_risk_class || null,
      pm_months: num(f.pm_months), calibration_months: num(f.calibration_months), safety_months: num(f.safety_months), is_active: f.is_active };
      return t ? api(`/bme/types/${t.id}`, { method: 'PATCH', body }) : api('/bme/types', { body: { ...body, code: f.code } }); },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['bme-refs'] }); onClose(); },
  });
  const ivOk = (x: string) => !x.trim() || (Number.isInteger(Number(x)) && Number(x) >= 1 && Number(x) <= 120);
  return (
    <Modal title={t ? `ტიპი: ${t.name}` : 'ახალი ტიპი'} onClose={onClose} width={720}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button>
        <button className="btn primary" type="button" disabled={m.isPending || f.name.trim().length < 2 || (!t && !/^[A-Z][A-Z0-9_]{1,29}$/.test(f.code)) || ![f.pm_months, f.calibration_months, f.safety_months].every(ivOk)} onClick={() => m.mutate()}>შენახვა</button></>}>
      <div className="stack">
        <div style={grid3}>
          <Field label="კოდი" htmlFor="tc" required hint={t ? 'არ იცვლება' : 'A-Z, 0-9, _'}><input id="tc" className="input mono" disabled={!!t} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
          <div style={{ gridColumn: 'span 2' }}><Field label="დასახელება" htmlFor="tn" required><input id="tn" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field></div>
          <Field label="ჯგუფი" htmlFor="tg"><select id="tg" className="select" value={f.grp} onChange={(e) => setF({ ...f, grp: e.target.value })}>{Object.entries(GRP_KA).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="კრიტიკულობა" htmlFor="tcr"><select id="tcr" className="select" value={f.default_criticality} onChange={(e) => setF({ ...f, default_criticality: e.target.value as Crit })}>{(Object.keys(CRIT_KA) as Crit[]).map((c) => <option key={c} value={c}>{CRIT_KA[c]}</option>)}</select></Field>
          <Field label="რისკის კლასი" htmlFor="trc"><select id="trc" className="select" value={f.default_risk_class} onChange={(e) => setF({ ...f, default_risk_class: e.target.value })}><option value="">—</option>{['I', 'IIa', 'IIb', 'III'].map((c) => <option key={c} value={c}>{c}</option>)}</select></Field>
          <Field label="PM (თვე)" htmlFor="tpm"><input id="tpm" className="input mono" inputMode="numeric" value={f.pm_months} onChange={(e) => setF({ ...f, pm_months: e.target.value })} /></Field>
          <Field label="კალიბრაცია (თვე)" htmlFor="tcal"><input id="tcal" className="input mono" inputMode="numeric" value={f.calibration_months} onChange={(e) => setF({ ...f, calibration_months: e.target.value })} /></Field>
          <Field label="ელ. უსაფრთხოება (თვე)" htmlFor="tsf"><input id="tsf" className="input mono" inputMode="numeric" value={f.safety_months} onChange={(e) => setF({ ...f, safety_months: e.target.value })} /></Field>
        </div>
        {t && <label className="row"><input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> აქტიური (გათიშული ტიპით ახალი აპარატი არ რეგისტრირდება)</label>}
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}
