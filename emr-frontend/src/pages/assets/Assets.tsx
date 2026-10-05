import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, apiUpload, can, type Role } from '../../api/client';
import type { Department } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Field, Loading, Modal, useDebounced, useToast } from '../../components/ui';
import { dateGe, tsDate } from '../../lib/format';
import { useModules } from '../../lib/modules';

// ---------------------------------------------------------------- ტიპები
interface Settings { inv_prefix: string; inv_year: boolean; inv_digits: number; require_room: boolean; require_responsible: boolean; move_mode: 'direct' | 'confirm'; writeoff_mode: 'direct' | 'single' | 'committee';
  writeoff_committee: string[]; committee_quorum: number; track_value: boolean; label_size: string; label_code: string }
interface Category { id: string; code: string; name: string; is_active: boolean; sort_order: number }
interface Condition { code: string; name: string; usable: boolean; is_active: boolean; sort_order: number }
interface Refs { settings: Settings; categories: Category[]; conditions: Condition[] }
interface Asset {
  id: string; inv_no: string; name: string; category_id: string; manufacturer: string | null; model: string | null; serial_no: string | null; department_id: string | null; room: string | null;
  responsible_user_id: string | null; condition_code: string; purchase_date: string | null; purchase_value: string | null; supplier_id: string | null; warranty_until: string | null; status: 'active' | 'written_off';
  notes: string | null; created_at: string; category_name: string; condition_name: string; usable: boolean; department_name: string | null; responsible_name: string | null; supplier_name: string | null;
  pending_move_id: string | null; pending_writeoff: string | null;
  events?: { id: string; kind: string; data: Record<string, unknown>; created_at: string; user_name: string }[];
}
interface Move { id: string; asset_id: string; status: string; reason: string | null; decision_note: string | null; requested_at: string; decided_at: string | null; from_room: string | null; to_room: string | null;
  inv_no: string; asset_name: string; from_department: string | null; to_department: string | null; from_responsible: string | null; to_responsible: string | null; requested_by_name: string }
interface WRow { id: string; act_no: string | null; status: string; mode: string; quorum: number; reason: string; method: string; created_at: string; decided_at: string | null; created_by_name: string; assets: number; yes: number; voted: boolean }
interface WDoc extends Omit<WRow, 'assets' | 'yes' | 'voted'> { created_by: string; assets: { id: string; inv_no: string; name: string; serial_no: string | null; purchase_value: string | null; purchase_date: string | null; category_name: string; department_name: string | null; room: string | null }[];
  votes: { user_id: string; approve: boolean; note: string | null; created_at: string; user_name: string }[] }
interface Person { id: string; name: string; department_id: string | null; department_name: string | null }

const MANAGE: Role[] = ['admin', 'stock_manager'];
const STAFF: Role[] = ['admin', 'stock_manager', 'storekeeper'];
const VIEW_ALL: Role[] = ['admin', 'stock_manager', 'storekeeper', 'manager', 'viewer', 'accountant', 'hr'];
const EV_KA: Record<string, string> = { created: 'რეგისტრაცია', updated: 'რედაქტირება', condition: 'მდგომარეობა', move_requested: 'გადაადგილების მოთხოვნა', moved: 'გადაადგილდა',
  move_rejected: 'მიღებაზე უარი', move_cancelled: 'გადაადგილება გაუქმდა', writeoff_requested: 'ჩამოწერის აქტში', written_off: 'ჩამოიწერა', writeoff_rejected: 'ჩამოწერა უარყოფილია' };
const W_STATUS: Record<string, [string, string]> = { pending: ['warn', 'დასამტკიცებელი'], approved: ['ok', 'დამტკიცებული'], rejected: ['danger', 'უარყოფილი'], cancelled: ['', 'გაუქმებული'] };
const METHOD_KA: Record<string, string> = { disposal: 'განადგურება / უტილიზაცია', sale: 'გაყიდვა', donation: 'ჩუქება', transfer: 'გადაცემა სხვა ორგანიზაციისთვის', other: 'სხვა' };
const useRefs = () => useQuery({ queryKey: ['asset-refs'], queryFn: () => api<Refs>('/assets/refs') });
const useDeps = () => useQuery({ queryKey: ['departments'], queryFn: () => api<Department[]>('/departments') });

/** ინვენტარის რეესტრი (0037): რეესტრი, მისაღები, გადაადგილებები, ჩამოწერის აქტები, იმპორტი, ცნობარები, შემაჯამებელი */
export default function Assets() {
  const { user } = useAuth(); const mods = useModules();
  const [sp] = useSearchParams();
  const enabled = mods.data?.find((m) => m.code === 'asset_register')?.enabled;
  const tabs: [string, string, boolean][] = [['registry', 'რეესტრი', true], ['incoming', 'მისაღები', true], ['moves', 'გადაადგილებები', true], ['writeoffs', 'ჩამოწერის აქტები', true],
    ['summary', 'შემაჯამებელი', can(user, ...VIEW_ALL)], ['import', 'იმპორტი', can(user, ...MANAGE)], ['refs', 'ცნობარები', can(user, ...MANAGE)]];
  const tab = sp.get('tab') ?? 'registry';
  if (mods.isLoading) return <div className="content"><Loading /></div>;
  return (
    <>
      <header className="topbar" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8, paddingBottom: 0 }}>
        <h1>ინვენტარი (ძირითადი საშუალებები)</h1>
        <nav aria-label="ინვენტარი" className="row" style={{ gap: 2, flexWrap: 'wrap' }}>
          {tabs.filter((t) => t[2]).map(([k, l]) => <Link key={k} to={`/assets?tab=${k}`} className={`admin-tab${tab === k ? ' active' : ''}`} aria-current={tab === k ? 'page' : undefined}>{l}</Link>)}
        </nav>
      </header>
      {!enabled ? <div className="content"><div className="card empty">მოდული „ინვენტარის რეესტრი“ გამორთულია (ადმინისტრირება → მოდულები).</div></div>
        : tab === 'incoming' ? <Moves scope="incoming" /> : tab === 'moves' ? <Moves scope="" /> : tab === 'writeoffs' ? <Writeoffs /> : tab === 'summary' ? <Summary />
          : tab === 'import' ? <ImportPage /> : tab === 'refs' ? <RefsPage /> : <Registry />}
    </>
  );
}

// ---------------------------------------------------------------- რეესტრი
function Registry() {
  const { user } = useAuth(); const refs = useRefs(); const deps = useDeps(); const toast = useToast();
  const [f, setF] = useState({ search: '', department_id: '', category_id: '', condition: '', status: 'active' });
  const ds = useDebounced(f.search.trim(), 300);
  const q = useQuery({ queryKey: ['assets', { ...f, search: ds }], queryFn: () => api<Asset[]>('/assets', { query: { ...f, search: ds } }) });
  const [sel, setSel] = useState<string[]>([]);
  const [open, setOpen] = useState<Asset | 'new' | null>(null);
  const [wo, setWo] = useState(false);
  const labels = async () => {
    const blob = await api<Blob>('/assets/labels', { query: { ids: sel.join(',') }, raw: true });
    const url = URL.createObjectURL(blob); window.open(url, '_blank'); setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
  const rows = q.data ?? [];
  const r = refs.data;
  return (
    <div className="content">
      {toast.node}
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <input className="input" style={{ maxWidth: 280, height: 38 }} aria-label="ძებნა" placeholder="№, დასახელება, მოდელი, სერიული" value={f.search} onChange={(e) => setF({ ...f, search: e.target.value })} />
        <select className="select" style={{ maxWidth: 220, height: 38 }} aria-label="განყოფილება" value={f.department_id} onChange={(e) => setF({ ...f, department_id: e.target.value })}>
          <option value="">ყველა განყოფილება</option>{deps.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
        <select className="select" style={{ maxWidth: 200, height: 38 }} aria-label="კატეგორია" value={f.category_id} onChange={(e) => setF({ ...f, category_id: e.target.value })}>
          <option value="">ყველა კატეგორია</option>{r?.categories.filter((c) => c.is_active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <select className="select" style={{ maxWidth: 190, height: 38 }} aria-label="მდგომარეობა" value={f.condition} onChange={(e) => setF({ ...f, condition: e.target.value })}>
          <option value="">ყველა მდგომარეობა</option>{r?.conditions.filter((c) => c.is_active).map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select>
        <select className="select" style={{ maxWidth: 150, height: 38 }} aria-label="სტატუსი" value={f.status} onChange={(e) => { setF({ ...f, status: e.target.value }); setSel([]); }}>
          <option value="active">აქტიური</option><option value="written_off">ჩამოწერილი</option></select>
        <span className="grow" />
        {sel.length > 0 && can(user, ...STAFF) && <button className="btn" type="button" onClick={() => void labels()}>ეტიკეტები ({sel.length})</button>}
        {sel.length > 0 && can(user, ...MANAGE) && f.status === 'active' && <button className="btn" type="button" onClick={() => setWo(true)}>ჩამოწერის აქტი ({sel.length})</button>}
        {can(user, ...STAFF) && <button className="btn primary" type="button" onClick={() => setOpen('new')}>+ რეგისტრაცია</button>}
      </div>
      {!can(user, ...VIEW_ALL) && <span className="hint">ჩანს თქვენზე (და, განყოფილების ხელმძღვანელს — განყოფილებაზე) რიცხული ინვენტარი.</span>}
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead><tr><th><input type="checkbox" aria-label="ყველას მონიშვნა" checked={rows.length > 0 && sel.length === rows.length} onChange={(e) => setSel(e.target.checked ? rows.map((x) => x.id) : [])} /></th>
              <th>№</th><th>დასახელება</th><th>კატეგორია</th><th>ადგილი</th><th>პასუხისმგებელი</th><th>მდგომარეობა</th>{r?.settings.track_value && <th className="num">ღირებულება</th>}</tr></thead>
            <tbody>{rows.map((a) => (
              <tr key={a.id} className="clickable" onClick={() => setOpen(a)}>
                <td onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={`მონიშვნა ${a.inv_no}`} checked={sel.includes(a.id)} onChange={(e) => setSel(e.target.checked ? [...sel, a.id] : sel.filter((x) => x !== a.id))} /></td>
                <td className="mono">{a.inv_no}</td>
                <td><strong>{a.name}</strong>{(a.manufacturer || a.model) && <div className="small muted">{[a.manufacturer, a.model].filter(Boolean).join(' ')}{a.serial_no ? ` · SN ${a.serial_no}` : ''}</div>}
                  {a.pending_move_id && <span className="chip warn" style={{ height: 20, fontSize: 11 }}>გადაადგილება — ელოდება</span>}{a.pending_writeoff !== null && <span className="chip danger" style={{ height: 20, fontSize: 11 }}>ჩამოწერის აქტში</span>}</td>
                <td className="small">{a.category_name}</td><td className="small">{a.department_name ?? '—'}{a.room && <div className="muted">ოთახი {a.room}</div>}</td>
                <td className="small">{a.responsible_name ?? '—'}</td>
                <td><span className={`chip ${a.usable ? (a.condition_code === 'good' ? 'ok' : 'warn') : 'danger'}`}>{a.condition_name}</span></td>
                {r?.settings.track_value && <td className="num mono">{a.purchase_value ? Number(a.purchase_value).toFixed(2) : '—'}</td>}
              </tr>))}
              {!rows.length && <tr><td colSpan={8} className="muted">ინვენტარი არ მოიძებნა</td></tr>}
            </tbody>
          </table>
        </div>)}
      {open && <AssetDialog asset={open === 'new' ? null : open} onClose={() => setOpen(null)} />}
      {wo && <WriteoffCreate ids={sel} onClose={() => setWo(false)} onDone={(no) => { setWo(false); setSel([]); toast.show(no ? `ჩამოიწერა: ${no}` : 'აქტი გაიგზავნა დასამტკიცებლად'); }} />}
    </div>
  );
}

function PersonPicker({ value, label, onChange }: { value: string | null; label: string | null; onChange: (p: Person | null) => void }) {
  const [q, setQ] = useState(''); const dq = useDebounced(q.trim(), 250);
  const r = useQuery({ queryKey: ['asset-people', dq], queryFn: () => api<Person[]>('/assets/people', { query: { search: dq } }), enabled: dq.length >= 2 });
  if (value) return <div className="row" style={{ gap: 6 }}><span className="grow">{label}</span><button className="btn sm" type="button" onClick={() => onChange(null)}>შეცვლა</button></div>;
  return (
    <div style={{ position: 'relative' }}>
      <input className="input" aria-label="თანამშრომლის ძებნა" placeholder="სახელი, გვარი (მინ. 2 სიმბ.)" value={q} onChange={(e) => setQ(e.target.value)} />
      {dq.length >= 2 && (r.data?.length ?? 0) > 0 && <ul className="listbox" role="listbox" aria-label="თანამშრომლები" style={{ position: 'absolute', top: 46, left: 0, right: 0, zIndex: 6 }}>
        {r.data!.map((p) => <li key={p.id} role="option" aria-selected={false} onMouseDown={(e) => { e.preventDefault(); onChange(p); setQ(''); }}><span className="grow">{p.name}</span><span className="small muted">{p.department_name ?? ''}</span></li>)}</ul>}
    </div>
  );
}

function AssetDialog({ asset, onClose }: { asset: Asset | null; onClose: () => void }) {
  const { user } = useAuth(); const qc = useQueryClient(); const refs = useRefs(); const deps = useDeps();
  const full = useQuery({ queryKey: ['asset', asset?.id], queryFn: () => api<Asset>(`/assets/${asset!.id}`), enabled: !!asset });
  const a = full.data ?? asset;
  const staff = can(user, ...STAFF);
  const editable = staff && (!a || a.status === 'active');
  const [f, setF] = useState({ inv_no: asset?.inv_no ?? '', name: asset?.name ?? '', category_id: asset?.category_id ?? '', manufacturer: asset?.manufacturer ?? '', model: asset?.model ?? '', serial_no: asset?.serial_no ?? '',
    department_id: asset?.department_id ?? '', room: asset?.room ?? '', condition_code: asset?.condition_code ?? 'good', purchase_date: asset?.purchase_date ?? '', purchase_value: asset?.purchase_value ? String(Number(asset.purchase_value)) : '',
    warranty_until: asset?.warranty_until ?? '', notes: asset?.notes ?? '' });
  const [resp, setResp] = useState<{ id: string; name: string } | null>(asset?.responsible_user_id ? { id: asset.responsible_user_id, name: asset.responsible_name ?? '' } : null);
  const [move, setMove] = useState(false);
  const set = (k: keyof typeof f, v: string) => setF((p) => ({ ...p, [k]: v }));
  const s = refs.data?.settings;
  const save = useMutation({
    mutationFn: () => {
      const n = (x: string) => (x.trim() ? x.trim() : null);
      const common = { name: f.name.trim(), category_id: f.category_id, manufacturer: n(f.manufacturer), model: n(f.model), serial_no: n(f.serial_no), condition_code: f.condition_code,
        purchase_date: n(f.purchase_date), warranty_until: n(f.warranty_until), notes: n(f.notes), ...(s?.track_value && { purchase_value: f.purchase_value.trim() ? Number(f.purchase_value.replace(',', '.')) : null }) };
      return asset ? api<Asset>(`/assets/${asset.id}`, { method: 'PATCH', body: { ...common, ...(f.inv_no.trim() && f.inv_no.trim().toUpperCase() !== asset.inv_no && { inv_no: f.inv_no.trim() }) } })
        : api<Asset>('/assets', { body: { ...common, inv_no: n(f.inv_no), department_id: f.department_id, room: n(f.room), responsible_user_id: resp?.id ?? null } });
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['assets'] }); void qc.invalidateQueries({ queryKey: ['asset'] }); onClose(); },
  });
  const canMove = a && a.status === 'active' && !a.pending_move_id && (staff || a.responsible_user_id === user?.id);
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 } as const;
  return (
    <Modal title={a ? `${a.inv_no} — ${a.name}` : 'ინვენტარის რეგისტრაცია'} onClose={onClose} width={900}
      footer={<>{canMove && <button className="btn" type="button" onClick={() => setMove(true)}>გადაადგილება</button>}<span className="grow" />
        <button className="btn" type="button" onClick={onClose}>{editable ? 'გაუქმება' : 'დახურვა'}</button>
        {editable && <button className="btn primary" type="button" disabled={save.isPending || f.name.trim().length < 2 || !f.category_id || (!asset && !f.department_id)} onClick={() => save.mutate()}>შენახვა</button>}</>}>
      {!refs.data ? <Loading /> : (
        <div className="stack">
          {a?.status === 'written_off' && <div className="alert danger">ჩამოწერილია</div>}
          <fieldset disabled={!editable} style={{ border: 0, padding: 0, margin: 0 }} className="stack">
            <div style={grid}>
              <Field label="საინვენტარო №" htmlFor="ain" hint={asset ? 'შეცვლა — საჭიროებისას' : 'ცარიელი — ავტომატური'}><input id="ain" className="input mono" value={f.inv_no} onChange={(e) => set('inv_no', e.target.value.toUpperCase())} /></Field>
              <Field label="დასახელება" htmlFor="an" required><input id="an" className="input" value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
              <Field label="კატეგორია" htmlFor="ac" required><select id="ac" className="select" value={f.category_id} onChange={(e) => set('category_id', e.target.value)}>
                <option value="">— აირჩიეთ —</option>{refs.data.categories.filter((c) => c.is_active || c.id === f.category_id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
              <Field label="მწარმოებელი" htmlFor="am"><input id="am" className="input" value={f.manufacturer} onChange={(e) => set('manufacturer', e.target.value)} /></Field>
              <Field label="მოდელი" htmlFor="amo"><input id="amo" className="input" value={f.model} onChange={(e) => set('model', e.target.value)} /></Field>
              <Field label="სერიული №" htmlFor="as"><input id="as" className="input mono" value={f.serial_no} onChange={(e) => set('serial_no', e.target.value)} /></Field>
              {!asset && <>
                <Field label="განყოფილება" htmlFor="ad" required><select id="ad" className="select" value={f.department_id} onChange={(e) => set('department_id', e.target.value)}>
                  <option value="">— აირჩიეთ —</option>{deps.data?.filter((d) => d.is_active).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
                <Field label="ოთახი" htmlFor="ar" required={s?.require_room}><input id="ar" className="input" value={f.room} onChange={(e) => set('room', e.target.value)} /></Field>
                <div className="field"><span className="label">პასუხისმგებელი{s?.require_responsible && <span className="req"> *</span>}</span><PersonPicker value={resp?.id ?? null} label={resp?.name ?? null} onChange={(p) => setResp(p)} /></div></>}
              <Field label="მდგომარეობა" htmlFor="acd"><select id="acd" className="select" value={f.condition_code} onChange={(e) => set('condition_code', e.target.value)}>
                {refs.data.conditions.filter((c) => c.is_active || c.code === f.condition_code).map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></Field>
              <Field label="შეძენის თარიღი" htmlFor="apd"><input id="apd" className="input mono" type="date" value={f.purchase_date} onChange={(e) => set('purchase_date', e.target.value)} /></Field>
              {s?.track_value && <Field label="ღირებულება (₾)" htmlFor="apv"><input id="apv" className="input mono" inputMode="decimal" value={f.purchase_value} onChange={(e) => set('purchase_value', e.target.value)} /></Field>}
              <Field label="გარანტია (მდე)" htmlFor="aw"><input id="aw" className="input mono" type="date" value={f.warranty_until} onChange={(e) => set('warranty_until', e.target.value)} /></Field>
              <div style={{ gridColumn: 'span 2' }}><Field label="შენიშვნა" htmlFor="ano"><input id="ano" className="input" value={f.notes} onChange={(e) => set('notes', e.target.value)} /></Field></div>
            </div>
          </fieldset>
          {a && <div className="row small" style={{ flexWrap: 'wrap', gap: 16 }}><span>ადგილი: <strong>{a.department_name ?? '—'}{a.room ? ` · ოთახი ${a.room}` : ''}</strong></span><span>პასუხისმგებელი: <strong>{a.responsible_name ?? '—'}</strong></span>
            {a.pending_move_id && <span className="chip warn">გადაადგილება ელოდება მიმღებს</span>}</div>}
          {a?.events && a.events.length > 0 && (
            <section className="card"><div className="card-head"><h2>ისტორია</h2></div>
              <table className="table"><tbody>{a.events.map((e) => <tr key={e.id}><td className="small">{tsDate(e.created_at)}</td><td>{EV_KA[e.kind] ?? e.kind}</td>
                <td className="small muted">{typeof e.data.reason === 'string' ? e.data.reason : typeof e.data.note === 'string' ? e.data.note : e.kind === 'condition' ? `${e.data.from} → ${e.data.to}` : typeof e.data.act_no === 'string' ? e.data.act_no : ''}</td><td className="small">{e.user_name}</td></tr>)}</tbody></table></section>)}
          <ErrorBox error={save.error ?? full.error} />
        </div>)}
      {move && a && <MoveDialog asset={a} onClose={() => setMove(false)} onDone={() => { setMove(false); void qc.invalidateQueries({ queryKey: ['asset', a.id] }); void qc.invalidateQueries({ queryKey: ['assets'] }); }} />}
    </Modal>
  );
}

function MoveDialog({ asset, onClose, onDone }: { asset: Asset; onClose: () => void; onDone: () => void }) {
  const refs = useRefs(); const deps = useDeps(); const toast = useToast();
  const [f, setF] = useState({ dep: asset.department_id ?? '', room: '', reason: '' });
  const [resp, setResp] = useState<{ id: string; name: string } | null>(null);
  const s = refs.data?.settings;
  const m = useMutation({
    mutationFn: () => api<{ status: string }>(`/assets/${asset.id}/move`, { body: { to_department_id: f.dep, to_room: f.room.trim() || null, to_responsible_id: resp?.id ?? null, reason: f.reason.trim() || null } }),
    onSuccess: (r) => { toast.show(r.status === 'done' ? 'გადაადგილდა' : 'გაიგზავნა — ელოდება მიმღების დადასტურებას'); onDone(); },
  });
  const valid = f.dep && (!s?.require_room || f.room.trim()) && (!s?.require_responsible || resp);
  return (
    <Modal title={`გადაადგილება: ${asset.inv_no}`} onClose={onClose} width={640}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={!valid || m.isPending} onClick={() => m.mutate()}>{s?.move_mode === 'direct' ? 'გადაადგილება' : 'გაგზავნა მიმღებთან'}</button></>}>
      {toast.node}
      <div className="stack">
        <span className="small muted">ახლა: {asset.department_name ?? '—'}{asset.room ? ` · ოთახი ${asset.room}` : ''} · {asset.responsible_name ?? 'პასუხისმგებლის გარეშე'}</span>
        <Field label="განყოფილება" htmlFor="md" required><select id="md" className="select" value={f.dep} onChange={(e) => setF({ ...f, dep: e.target.value })}>
          <option value="">— აირჩიეთ —</option>{deps.data?.filter((d) => d.is_active).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
        <Field label="ოთახი" htmlFor="mr" required={s?.require_room}><input id="mr" className="input" value={f.room} onChange={(e) => setF({ ...f, room: e.target.value })} /></Field>
        <div className="field"><span className="label">ახალი პასუხისმგებელი{s?.require_responsible && <span className="req"> *</span>}</span><PersonPicker value={resp?.id ?? null} label={resp?.name ?? null} onChange={(p) => setResp(p)} /></div>
        <Field label="მიზეზი" htmlFor="mre"><input id="mre" className="input" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
        {s?.move_mode === 'confirm' && <span className="hint">მიმღები (ან, პასუხისმგებლის გარეშე, განყოფილების ხელმძღვანელი) დაადასტურებს „მისაღებში“.</span>}
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- გადაადგილებები
function Moves({ scope }: { scope: 'incoming' | '' }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['asset-moves', scope], queryFn: () => api<Move[]>('/assets/moves', { query: { scope: scope || undefined } }) });
  const dec = useMutation({ mutationFn: (a: { id: string; accept: boolean; note?: string }) => api(`/assets/moves/${a.id}/decide`, { body: { accept: a.accept, note: a.note } }),
    onSuccess: () => { for (const k of ['asset-moves', 'assets', 'asset']) void qc.invalidateQueries({ queryKey: [k] }); } });
  const cancel = useMutation({ mutationFn: (id: string) => api(`/assets/moves/${id}/cancel`, { method: 'POST' }), onSuccess: () => void qc.invalidateQueries({ queryKey: ['asset-moves'] }) });
  if (q.isLoading) return <div className="content"><Loading /></div>;
  return (
    <div className="content">
      {scope === 'incoming' && <span className="hint">თქვენზე / თქვენს განყოფილებაზე გადმოცემული ინვენტარი — დაადასტურეთ მიღება ან თქვით უარი (მიზეზით).</span>}
      <div className="card" style={{ overflowX: 'auto' }}>
        <table className="table">
          <thead><tr><th>დრო</th><th>ინვენტარი</th><th>საიდან</th><th>სად</th><th>მიზეზი</th><th>ინიციატორი</th><th>სტატუსი</th></tr></thead>
          <tbody>{q.data?.map((m) => (
            <tr key={m.id}>
              <td className="small">{tsDate(m.requested_at)}</td><td><span className="mono">{m.inv_no}</span> {m.asset_name}</td>
              <td className="small">{m.from_department ?? '—'}{m.from_room ? ` · ${m.from_room}` : ''}<div className="muted">{m.from_responsible ?? ''}</div></td>
              <td className="small"><strong>{m.to_department ?? '—'}{m.to_room ? ` · ${m.to_room}` : ''}</strong><div className="muted">{m.to_responsible ?? 'პასუხისმგებლის გარეშე'}</div></td>
              <td className="small">{m.reason ?? ''}{m.decision_note && <div className="muted">→ {m.decision_note}</div>}</td><td className="small">{m.requested_by_name}</td>
              <td style={{ whiteSpace: 'nowrap' }}>{m.status === 'pending' ? (scope === 'incoming' ? <>
                <button className="btn sm primary" type="button" disabled={dec.isPending} onClick={() => dec.mutate({ id: m.id, accept: true })}>მივიღე</button>{' '}
                <button className="btn sm" type="button" disabled={dec.isPending} onClick={() => { const n = prompt('უარის მიზეზი'); if (n && n.trim().length >= 3) dec.mutate({ id: m.id, accept: false, note: n.trim() }); }}>უარი</button></>
                : <><span className="chip warn">ელოდება</span> <button className="btn sm" type="button" onClick={() => { if (confirm('გავაუქმოთ?')) cancel.mutate(m.id); }}>გაუქმება</button></>)
                : <span className={`chip ${m.status === 'done' ? 'ok' : m.status === 'rejected' ? 'danger' : ''}`}>{m.status === 'done' ? 'შესრულდა' : m.status === 'rejected' ? 'უარი' : 'გაუქმდა'}</span>}</td>
            </tr>))}
            {!q.data?.length && <tr><td colSpan={7} className="muted">{scope === 'incoming' ? 'მისაღები არაფერია' : 'გადაადგილება არ ყოფილა'}</td></tr>}
          </tbody>
        </table>
      </div>
      <ErrorBox error={q.error ?? dec.error ?? cancel.error} />
    </div>
  );
}

// ---------------------------------------------------------------- ჩამოწერა
function WriteoffCreate({ ids, onClose, onDone }: { ids: string[]; onClose: () => void; onDone: (actNo: string | null) => void }) {
  const qc = useQueryClient(); const refs = useRefs();
  const [f, setF] = useState({ reason: '', method: 'disposal' });
  const m = useMutation({ mutationFn: () => api<WDoc>('/assets/writeoffs', { body: { asset_ids: ids, reason: f.reason.trim(), method: f.method } }),
    onSuccess: (r) => { for (const k of ['assets', 'asset-writeoffs']) void qc.invalidateQueries({ queryKey: [k] }); onDone(r.status === 'approved' ? r.act_no : null); } });
  const mode = refs.data?.settings.writeoff_mode;
  return (
    <Modal title={`ჩამოწერის აქტი — ${ids.length} ერთეული`} onClose={onClose} width={600}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={f.reason.trim().length < 3 || m.isPending} onClick={() => m.mutate()}>{mode === 'direct' ? 'ჩამოწერა' : 'გაგზავნა დასამტკიცებლად'}</button></>}>
      <div className="stack">
        <Field label="მიზეზი" htmlFor="wr" required><input id="wr" className="input" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="მაგ. ფიზიკური ცვეთა, შეკეთება არ ღირს" /></Field>
        <Field label="განკარგვის წესი" htmlFor="wmt"><select id="wmt" className="select" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>
          {Object.entries(METHOD_KA).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <span className="hint">{mode === 'committee' ? `დამტკიცება — კომისია (კვორუმი ${refs.data?.settings.committee_quorum})` : mode === 'single' ? 'დამტკიცება — საწყობის მენეჯერი (არა აქტის ავტორი)' : 'დამტკიცების გარეშე — მაშინვე ჩამოიწერება'}</span>
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}

function Writeoffs() {
  const [st, setSt] = useState('pending'); const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['asset-writeoffs', st], queryFn: () => api<WRow[]>('/assets/writeoffs', { query: { status: st || undefined } }) });
  return (
    <div className="content">
      <div className="seg" role="group" aria-label="სტატუსი" style={{ alignSelf: 'flex-start' }}>
        {[['pending', 'დასამტკიცებელი'], ['approved', 'დამტკიცებული'], ['rejected', 'უარყოფილი'], ['', 'ყველა']].map(([k, l]) => <button key={k} type="button" aria-pressed={st === k} onClick={() => setSt(k)}>{l}</button>)}
      </div>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : (
        <div className="card">
          <table className="table">
            <thead><tr><th>აქტი</th><th>შექმნა</th><th>მიზეზი</th><th className="num">ერთეული</th><th>დამტკიცება</th><th>სტატუსი</th></tr></thead>
            <tbody>{q.data?.map((w) => (
              <tr key={w.id} className="clickable" onClick={() => setOpen(w.id)}>
                <td className="mono">{w.act_no ?? '—'}</td><td className="small">{tsDate(w.created_at)}<div className="muted">{w.created_by_name}</div></td><td className="small">{w.reason}</td><td className="num">{w.assets}</td>
                <td className="small">{w.mode === 'committee' ? `კომისია: ${w.yes} / ${w.quorum}` : w.mode === 'single' ? 'ერთი დამმტკიცებელი' : 'პირდაპირ'}{w.voted && <span className="muted"> · ხმა მიცემულია</span>}</td>
                <td><span className={`chip ${W_STATUS[w.status][0]}`}>{W_STATUS[w.status][1]}</span></td>
              </tr>))}
              {!q.data?.length && <tr><td colSpan={6} className="muted">აქტი არ არის</td></tr>}
            </tbody>
          </table>
        </div>)}
      {open && <WriteoffView id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function WriteoffView({ id, onClose }: { id: string; onClose: () => void }) {
  const { user } = useAuth(); const qc = useQueryClient(); const refs = useRefs();
  const q = useQuery({ queryKey: ['asset-writeoff', id], queryFn: () => api<WDoc>(`/assets/writeoffs/${id}`) });
  const vote = useMutation({ mutationFn: (b: { approve: boolean; note?: string }) => api<WDoc>(`/assets/writeoffs/${id}/vote`, { body: b }),
    onSuccess: (r) => { qc.setQueryData(['asset-writeoff', id], r); for (const k of ['asset-writeoffs', 'assets']) void qc.invalidateQueries({ queryKey: [k] }); } });
  const w = q.data; const s = refs.data?.settings;
  const canVote = w && w.status === 'pending' && !w.votes.some((v) => v.user_id === user?.id)
    && (w.mode === 'committee' ? !!s?.writeoff_committee.includes(user?.id ?? '') : can(user, ...MANAGE) && (w.created_by !== user?.id || can(user, 'admin')));
  const print = () => {
    if (!w) return;
    const esc = (x: unknown) => String(x ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
    const html = `<!doctype html><html lang="ka"><head><meta charset="utf-8"><title>${esc(w.act_no ?? 'აქტი')}</title><style>body{font:12px system-ui,sans-serif;margin:24px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #999;padding:4px 6px;text-align:left}td.n{text-align:right}.s{margin-top:28px}</style></head><body>
<h2>ძირითადი საშუალებების ჩამოწერის აქტი ${esc(w.act_no ?? '(დაუმტკიცებელი)')}</h2><div>თარიღი: ${tsDate(w.decided_at ?? w.created_at)} · მიზეზი: ${esc(w.reason)} · განკარგვა: ${esc(METHOD_KA[w.method])}</div><br>
<table><tr><th>#</th><th>საინვენტარო №</th><th>დასახელება</th><th>კატეგორია</th><th>სერიული №</th><th>ადგილი</th><th>შეძენა</th><th>ღირებულება</th></tr>
${w.assets.map((a, i) => `<tr><td>${i + 1}</td><td>${esc(a.inv_no)}</td><td>${esc(a.name)}</td><td>${esc(a.category_name)}</td><td>${esc(a.serial_no)}</td><td>${esc([a.department_name, a.room].filter(Boolean).join(' · '))}</td><td>${a.purchase_date ? dateGe(a.purchase_date) : ''}</td><td class="n">${a.purchase_value ? Number(a.purchase_value).toFixed(2) : ''}</td></tr>`).join('')}</table>
<div class="s">შეადგინა: ${esc(w.created_by_name)} ______________</div>${w.votes.map((v) => `<div class="s">${v.approve ? 'დაამტკიცა' : 'უარყო'}: ${esc(v.user_name)} (${tsDate(v.created_at)}) ______________${v.note ? ` — ${esc(v.note)}` : ''}</div>`).join('')}</body></html>`;
    const win = window.open('', '_blank'); if (!win) return; win.document.write(html); win.document.close(); win.focus(); setTimeout(() => win.print(), 300);
  };
  return (
    <Modal title={w ? `ჩამოწერის აქტი ${w.act_no ?? ''}` : 'აქტი'} onClose={onClose} width={860}
      footer={<>{w && <button className="btn" type="button" onClick={print}>ბეჭდვა</button>}<span className="grow" />
        {canVote && <><button className="btn" type="button" disabled={vote.isPending} onClick={() => { const n = prompt('უარის მიზეზი'); if (n && n.trim().length >= 3) vote.mutate({ approve: false, note: n.trim() }); }}>უარყოფა</button>
          <button className="btn primary" type="button" disabled={vote.isPending} onClick={() => vote.mutate({ approve: true })}>დამტკიცება</button></>}
        <button className="btn" type="button" onClick={onClose}>დახურვა</button></>}>
      {!w ? <Loading /> : (
        <div className="stack">
          <div className="row small" style={{ flexWrap: 'wrap', gap: 16 }}><span className={`chip ${W_STATUS[w.status][0]}`}>{W_STATUS[w.status][1]}</span><span>მიზეზი: <strong>{w.reason}</strong></span>
            <span>განკარგვა: {METHOD_KA[w.method]}</span><span>{w.mode === 'committee' ? `კომისია, კვორუმი ${w.quorum}` : w.mode === 'single' ? 'ერთი დამმტკიცებელი' : 'პირდაპირ'}</span><span>ავტორი: {w.created_by_name}</span></div>
          <table className="table"><thead><tr><th>№</th><th>დასახელება</th><th>ადგილი</th><th className="num">ღირებულება</th></tr></thead>
            <tbody>{w.assets.map((a) => <tr key={a.id}><td className="mono">{a.inv_no}</td><td>{a.name}<div className="small muted">{a.category_name}{a.serial_no ? ` · SN ${a.serial_no}` : ''}</div></td>
              <td className="small">{[a.department_name, a.room].filter(Boolean).join(' · ')}</td><td className="num mono">{a.purchase_value ? Number(a.purchase_value).toFixed(2) : '—'}</td></tr>)}</tbody></table>
          {w.votes.length > 0 && <div className="stack" style={{ gap: 4 }}>{w.votes.map((v) => <div key={v.user_id} className="small"><span className={`chip ${v.approve ? 'ok' : 'danger'}`}>{v.approve ? 'დაამტკიცა' : 'უარყო'}</span> {v.user_name} · {tsDate(v.created_at)}{v.note ? ` — ${v.note}` : ''}</div>)}</div>}
          <ErrorBox error={q.error ?? vote.error} />
        </div>)}
    </Modal>
  );
}

// ---------------------------------------------------------------- შემაჯამებელი, იმპორტი, ცნობარები
function Summary() {
  const q = useQuery({ queryKey: ['asset-summary'], queryFn: () => api<{ department_name: string | null; category_name: string; total: number; unusable: number; repair: number; value: string }[]>('/assets/summary') });
  if (q.isLoading) return <div className="content"><Loading /></div>;
  return (
    <div className="content"><div className="card">
      <table className="table"><thead><tr><th>განყოფილება</th><th>კატეგორია</th><th className="num">სულ</th><th className="num">შესაკეთებელი</th><th className="num">გამოუსადეგარი</th><th className="num">ღირებულება</th></tr></thead>
        <tbody>{q.data?.map((r, i) => <tr key={i}><td>{r.department_name ?? '—'}</td><td>{r.category_name}</td><td className="num">{r.total}</td><td className="num">{r.repair || ''}</td><td className="num">{r.unusable || ''}</td><td className="num mono">{Number(r.value).toFixed(2)}</td></tr>)}
          {!q.data?.length && <tr><td colSpan={6} className="muted">ინვენტარი არ არის</td></tr>}</tbody></table>
      <ErrorBox error={q.error} /></div></div>
  );
}

function ImportPage() {
  const qc = useQueryClient(); const [file, setFile] = useState<File | null>(null);
  const [res, setRes] = useState<{ commit: boolean; created: number; skipped: number; errors: number; report: { row: number; status: string; inv_no: string; name: string; message?: string }[] } | null>(null);
  const run = useMutation({ mutationFn: (commit: boolean) => { const fd = new FormData(); fd.append('file', file!); return apiUpload<typeof res>(`/assets/import?commit=${commit}`, fd); },
    onSuccess: (r) => { setRes(r); if (r?.commit) void qc.invalidateQueries({ queryKey: ['assets'] }); } });
  const tpl = async () => { const b = await api<Blob>('/assets/import/template', { raw: true }); const u = URL.createObjectURL(b); const a = document.createElement('a'); a.href = u; a.download = 'ინვენტარის-შაბლონი.xlsx'; a.click(); setTimeout(() => URL.revokeObjectURL(u), 10_000); };
  return (
    <div className="content">
      <section className="card card-pad stack">
        <h2>არსებული ინვენტარის იმპორტი</h2>
        <span className="small">შაბლონი → შევსება (კატეგორიისა და განყოფილების <strong>კოდებით</strong>, პასუხისმგებელი — ელ-ფოსტით) → შემოწმება → იმპორტი. ძველი საინვენტარო ნომერი ინახება; ცარიელი — ავტომატურად. შეცდომის შემთხვევაში არაფერი იმპორტდება.</span>
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

function RefsPage() {
  const qc = useQueryClient(); const refs = useRefs();
  const [cat, setCat] = useState({ code: '', name: '' }); const [cond, setCond] = useState({ code: '', name: '', usable: true });
  const done = () => void qc.invalidateQueries({ queryKey: ['asset-refs'] });
  const addCat = useMutation({ mutationFn: () => api('/assets/categories', { body: cat }), onSuccess: () => { setCat({ code: '', name: '' }); done(); } });
  const addCond = useMutation({ mutationFn: () => api('/assets/conditions', { body: cond }), onSuccess: () => { setCond({ code: '', name: '', usable: true }); done(); } });
  const toggle = useMutation({ mutationFn: (a: { path: string; is_active: boolean }) => api(a.path, { method: 'PATCH', body: { is_active: a.is_active } }), onSuccess: done });
  if (!refs.data) return <div className="content"><Loading /></div>;
  return (
    <div className="content">
      <section className="card card-pad stack">
        <h2>კატეგორიები</h2>
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>{refs.data.categories.map((c) => <button key={c.id} type="button" className={`chip${c.is_active ? '' : ' warn'}`} title={c.is_active ? 'გათიშვა' : 'ჩართვა'}
          onClick={() => { if (confirm(`${c.is_active ? 'გავთიშოთ' : 'ჩავრთოთ'} „${c.name}“?`)) toggle.mutate({ path: `/assets/categories/${c.id}`, is_active: !c.is_active }); }}>{c.name} <span className="mono muted">{c.code}</span></button>)}</div>
        <div className="row"><input className="input mono" style={{ maxWidth: 160, height: 36 }} aria-label="კოდი" placeholder="კოდი (A-Z)" value={cat.code} onChange={(e) => setCat({ ...cat, code: e.target.value.toUpperCase() })} />
          <input className="input" style={{ maxWidth: 280, height: 36 }} aria-label="დასახელება" placeholder="დასახელება" value={cat.name} onChange={(e) => setCat({ ...cat, name: e.target.value })} />
          <button className="btn sm" type="button" disabled={!/^[A-Z][A-Z0-9_]{1,29}$/.test(cat.code) || cat.name.trim().length < 2} onClick={() => addCat.mutate()}>დამატება</button></div>
        <ErrorBox error={addCat.error} />
      </section>
      <section className="card card-pad stack">
        <h2>მდგომარეობები</h2>
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>{refs.data.conditions.map((c) => <button key={c.code} type="button" className={`chip${c.is_active ? (c.usable ? '' : ' danger') : ' warn'}`}
          onClick={() => { if (confirm(`${c.is_active ? 'გავთიშოთ' : 'ჩავრთოთ'} „${c.name}“?`)) toggle.mutate({ path: `/assets/conditions/${c.code}`, is_active: !c.is_active }); }}>{c.name}{!c.usable && ' (გამოუსადეგარი)'}</button>)}</div>
        <div className="row"><input className="input mono" style={{ maxWidth: 160, height: 36 }} aria-label="კოდი" placeholder="კოდი (a-z)" value={cond.code} onChange={(e) => setCond({ ...cond, code: e.target.value.toLowerCase() })} />
          <input className="input" style={{ maxWidth: 240, height: 36 }} aria-label="დასახელება" placeholder="დასახელება" value={cond.name} onChange={(e) => setCond({ ...cond, name: e.target.value })} />
          <label className="row small"><input type="checkbox" checked={cond.usable} onChange={(e) => setCond({ ...cond, usable: e.target.checked })} /> გამოსაყენებელია</label>
          <button className="btn sm" type="button" disabled={!/^[a-z][a-z0-9_]{1,29}$/.test(cond.code) || cond.name.trim().length < 2} onClick={() => addCond.mutate()}>დამატება</button></div>
        <ErrorBox error={addCond.error ?? toggle.error} />
      </section>
    </div>
  );
}
