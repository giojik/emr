import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, apiUpload, can } from '../../api/client';
import type { Department, PatientListItem } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import PatientSearch from '../../components/PatientSearch';
import { ErrorBox, Field, Loading, Modal, useToast } from '../../components/ui';
import { dateGe, todayISO, tsDate } from '../../lib/format';
import { useModules } from '../../lib/modules';
import ItemSearch from '../stock/ItemSearch';

// ---------------------------------------------------------------- ტიპები
interface Settings { instrument_tracking: boolean; wash_record: boolean; bd_required: boolean; bi_frequency: string; bi_hold: string; shelf_life_mode: string; patient_trace: boolean; auto_consume: boolean; label_size: string; label_code: string }
interface Unit { id: string; name: string; department_id: string | null; department_name: string | null; can_process: boolean }
interface Packaging { id: string; name: string; shelf_days: number | null; consumables: { item_id: string; qty: number }[]; is_active: boolean }
interface Machine { id: string; name: string; kind: 'steam' | 'plasma' | 'eo' | 'dry_heat' | 'washer'; location_id: string; location_name: string; manufacturer: string | null; model: string | null; serial_no: string | null; programs: { name: string; temp?: number; minutes?: number }[]; is_active: boolean }
interface Template { id: string; code: string; name: string; owner_department_id: string | null; owner_department_name: string | null; packaging_type_id: string | null; packaging_name: string | null; is_implant: boolean; program_hint: string | null; is_active: boolean; items: number; sets: number }
interface Refs { settings: Settings; packaging: Packaging[]; machines: Machine[]; units: Unit[]; templates: Template[] }
interface CSet { id: string; barcode: string; template_id: string; serial: string | null; home_location_id: string; status: string; holder_department_id: string | null; template_name: string; template_code: string; is_implant: boolean;
  home_location_name: string; holder_department_name: string | null; owner_department_name: string | null; pack_id: string | null; pack_no: string | null; pack_status: string | null; expires_on: string | null }
interface Pack { id: string; pack_no: string; set_id: string; location_id: string; status: string; packed_at: string; expires_on: string | null; ci_pass: boolean | null; incomplete: boolean; checklist: { name: string; expected: number; counted: number; note: string | null }[];
  issued_department_id: string | null; issued_at: string | null; used_at: string | null; patient_id: string | null; note: string | null; set_barcode: string; serial: string | null; template_name: string; is_implant: boolean; packaging_name: string;
  cycle_no: string | null; bi_result: string | null; machine_name: string | null; department_name: string | null; patient_name: string | null; personal_number: string | null; packed_by_name: string; days_left: number | null }
interface Cycle { id: string; cycle_no: string; kind: string; program: string | null; temp_c: string | null; minutes: string | null; pressure_bar: string | null; started_at: string; result: string; bi_used: boolean; bi_result: string | null; attachment_key: string | null;
  machine_name: string; machine_kind: string; operator_name: string; packs: number | Pack[]; bi_lot?: string | null; notes?: string | null; bi_read_by_name?: string | null }

const SET_ST: Record<string, [string, string]> = { available: ['', 'ახალი'], received: ['warn', 'მიღებული (ბინძური)'], washed: ['info', 'გარეცხილი'], packed: ['ok', 'შეფუთული'], in_use: ['', 'განყოფილებაში'], retired: ['', 'ჩამოწერილი'] };
const PACK_ST: Record<string, [string, string]> = { packed: ['info', 'შეფუთული'], sterile: ['ok', 'სტერილური'], quarantine: ['warn', 'ქარანტინი (BI)'], failed: ['danger', 'ჩავარდა'], issued: ['', 'გაცემული'],
  used: ['', 'გამოყენებული'], expired: ['danger', 'ვადაგასული'], recalled: ['danger', 'გაწვეული'], reprocess: ['', 'ხელახლა'] };
const KIND_KA: Record<string, string> = { steam: 'ორთქლი (ავტოკლავი)', plasma: 'პლაზმა (H₂O₂)', eo: 'ეთილენ-ოქსიდი', dry_heat: 'მშრალი სითბო', washer: 'სარეცხი / დეზინფექტორი' };
const useRefs = () => useQuery({ queryKey: ['cssd-refs'], queryFn: () => api<Refs>('/cssd/refs') });
const useDeps = () => useQuery({ queryKey: ['departments'], queryFn: () => api<Department[]>('/departments') });
const chip = (m: Record<string, [string, string]>, k: string) => <span className={`chip ${m[k]?.[0] ?? ''}`}>{m[k]?.[1] ?? k}</span>;
const openPdf = async (ids: string[]) => { const b = await api<Blob>('/cssd/labels', { query: { ids: ids.join(',') }, raw: true }); const u = URL.createObjectURL(b); window.open(u, '_blank'); setTimeout(() => URL.revokeObjectURL(u), 60_000); };

/** CSSD (0039): სამუშაო, საწყობი, განყოფილება, ციკლები, ნაკრები, ცნობარები, რეპორტი */
export default function Cssd() {
  const mods = useModules(); const refs = useRefs(); const { user } = useAuth();
  const [sp] = useSearchParams();
  const enabled = mods.data?.find((m) => m.code === 'cssd')?.enabled;
  const proc = (refs.data?.units ?? []).some((u) => u.can_process);
  const manage = can(user, 'admin', 'stock_manager') || proc;
  const tabs: [string, string, boolean][] = [['work', 'სამუშაო', proc], ['storage', 'სტერილური საწყობი', proc], ['dept', 'ჩემი განყოფილება', true], ['cycles', 'ციკლები', proc || can(user, 'admin', 'manager', 'viewer')],
    ['sets', 'ნაკრები', true], ['refs', 'ცნობარები', manage], ['report', 'რეპორტი', proc || can(user, 'admin', 'stock_manager', 'manager', 'viewer')]];
  const visible = tabs.filter((t) => t[2]);
  const tab = sp.get('tab') ?? visible[0]?.[0] ?? 'dept';
  if (mods.isLoading || refs.isLoading) return <div className="content"><Loading /></div>;
  return (
    <>
      <header className="topbar" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8, paddingBottom: 0 }}>
        <h1>სტერილიზაცია (CSSD)</h1>
        <nav aria-label="CSSD" className="row" style={{ gap: 2, flexWrap: 'wrap' }}>
          {visible.map(([k, l]) => <Link key={k} to={`/cssd?tab=${k}`} className={`admin-tab${tab === k ? ' active' : ''}`}>{l}</Link>)}
        </nav>
      </header>
      {!enabled ? <div className="content"><div className="card empty">მოდული „სტერილიზაცია (CSSD)“ გამორთულია (ადმინისტრირება → მოდულები).</div></div>
        : refs.error ? <div className="content"><ErrorBox error={refs.error} /></div>
          : tab === 'work' ? <Work /> : tab === 'storage' ? <Storage /> : tab === 'cycles' ? <Cycles openId={sp.get('cycle')} /> : tab === 'sets' ? <Sets /> : tab === 'refs' ? <RefsPage /> : tab === 'report' ? <Report /> : <Dept />}
    </>
  );
}

function useUnit() {
  const refs = useRefs();
  const mine = (refs.data?.units ?? []).filter((u) => u.can_process);
  const [id, setId] = useState('');
  const cur = id || mine[0]?.id || '';
  const picker = mine.length > 1 ? <select className="select" style={{ maxWidth: 260, height: 38 }} aria-label="CSSD ერთეული" value={cur} onChange={(e) => setId(e.target.value)}>{mine.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select> : null;
  return { unit: cur, picker, mine };
}

// ---------------------------------------------------------------- სამუშაო: მიღება → რეცხვა → შეფუთვა → სტერილიზაცია → BI
function Work() {
  const { unit, picker, mine } = useUnit(); const qc = useQueryClient(); const toast = useToast(); const refs = useRefs();
  const st = refs.data?.settings;
  const sets = useQuery({ queryKey: ['cssd-sets', unit, 'work'], queryFn: () => api<CSet[]>('/cssd/sets', { query: { location_id: unit, status: 'available,received,washed,in_use' } }), enabled: !!unit });
  const packed = useQuery({ queryKey: ['cssd-packs', unit, 'packed'], queryFn: () => api<Pack[]>('/cssd/packs', { query: { location_id: unit, status: 'packed' } }), enabled: !!unit });
  const biPending = useQuery({ queryKey: ['cssd-cycles', unit, 'bi'], queryFn: () => api<Cycle[]>('/cssd/cycles', { query: { location_id: unit, bi_pending: 'true' } }), enabled: !!unit });
  const [scan, setScan] = useState(''); const [packSet, setPackSet] = useState<CSet | null>(null); const [cyc, setCyc] = useState<'sterilize' | 'bowie_dick' | null>(null);
  const [selRecv, setSelRecv] = useState<string[]>([]); const [selWash, setSelWash] = useState<string[]>([]);
  const [wash, setWash] = useState({ machine_id: '', program: '', result: 'pass' });
  const refresh = () => { for (const k of ['cssd-sets', 'cssd-packs', 'cssd-cycles']) void qc.invalidateQueries({ queryKey: [k] }); };
  const recv = useMutation({ mutationFn: (ids: string[]) => api<{ received: number }>('/cssd/receive', { body: { location_id: unit, set_ids: ids } }), onSuccess: (r) => { toast.show(`მიღებულია: ${r.received}`); setSelRecv([]); refresh(); } });
  const doWash = useMutation({ mutationFn: () => api<{ washed: number }>('/cssd/wash', { body: { location_id: unit, set_ids: selWash, machine_id: wash.machine_id || null, program: wash.program || null, result: wash.result } }),
    onSuccess: (r) => { toast.show(`გარეცხილია: ${r.washed}`); setSelWash([]); refresh(); } });
  const bi = useMutation({ mutationFn: (a: { id: string; result: 'pass' | 'fail' }) => api(`/cssd/cycles/${a.id}/bi`, { body: { result: a.result } }), onSuccess: refresh });
  const onScan = async () => {
    const c = scan.trim(); if (!c) return; setScan('');
    try {
      const r = await api<{ set: CSet; pack: Pack | null }>(`/cssd/scan/${encodeURIComponent(c)}`);
      if (['available', 'in_use'].includes(r.set.status)) recv.mutate([r.set.id]);
      else if (r.set.status === 'received' && !st?.wash_record) setPackSet(r.set);
      else if (r.set.status === 'washed') setPackSet(r.set);
      else toast.show(`${r.set.barcode}: ${SET_ST[r.set.status]?.[1] ?? r.set.status}`);
    } catch (e) { toast.show((e as Error).message); }
  };
  if (!mine.length) return <div className="content"><div className="card empty">CSSD ერთეულის თანამშრომელი არ ხართ (ლოკაციები → ტიპი „სტერილიზაცია (CSSD)“, განყოფილებით).</div></div>;
  const rows = sets.data ?? [];
  const dirty = rows.filter((s) => ['available', 'in_use'].includes(s.status)); const received = rows.filter((s) => s.status === 'received'); const washed = rows.filter((s) => s.status === 'washed');
  const washers = (refs.data?.machines ?? []).filter((m) => m.kind === 'washer' && m.location_id === unit && m.is_active);
  return (
    <div className="content">
      {toast.node}
      <div className="row" style={{ flexWrap: 'wrap' }}>
        {picker}
        <form className="row grow" onSubmit={(e) => { e.preventDefault(); void onScan(); }}>
          <input className="input" style={{ maxWidth: 360, height: 40 }} autoFocus aria-label="სკანირება" placeholder="სკანირება: ნაკრები → მიღება / შეფუთვა" value={scan} onChange={(e) => setScan(e.target.value)} /></form>
        {st?.bd_required && <button className="btn" type="button" onClick={() => setCyc('bowie_dick')}>Bowie-Dick ტესტი</button>}
        <button className="btn primary" type="button" disabled={!packed.data?.length} onClick={() => setCyc('sterilize')}>სტერილიზაცია ({packed.data?.length ?? 0})</button>
      </div>
      {(biPending.data?.length ?? 0) > 0 && <section className="card card-pad stack" style={{ gap: 6 }}>
        <strong>ბიოლოგიური ინდიკატორი — პასუხს ელოდება</strong>
        {biPending.data!.map((c) => <div key={c.id} className="row small" style={{ flexWrap: 'wrap' }}><span className="grow">{c.machine_name} · ციკლი {c.cycle_no} · {tsDate(c.started_at)} · {c.packs as number} შეფუთვა</span>
          <button className="btn sm primary" type="button" disabled={bi.isPending} onClick={() => bi.mutate({ id: c.id, result: 'pass' })}>BI — უარყოფითი (სტერილური)</button>
          <button className="btn sm danger" type="button" disabled={bi.isPending} onClick={() => { if (confirm('BI დადებითი → ციკლის ყველა შეფუთვა გაიწვევა. დავადასტუროთ?')) bi.mutate({ id: c.id, result: 'fail' }); }}>BI — ზრდა (გაწვევა)</button></div>)}
      </section>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12, alignItems: 'start' }}>
        <section className="card card-pad stack" style={{ gap: 6 }}>
          <div className="row"><strong className="grow">1. მისაღები ({dirty.length})</strong><button className="btn sm" type="button" disabled={!selRecv.length || recv.isPending} onClick={() => recv.mutate(selRecv)}>მიღება</button></div>
          <span className="small muted">განყოფილებაში / ახალი — ბინძური დაბრუნება</span>
          {dirty.map((s) => <label key={s.id} className="row small"><input type="checkbox" checked={selRecv.includes(s.id)} onChange={(e) => setSelRecv(e.target.checked ? [...selRecv, s.id] : selRecv.filter((x) => x !== s.id))} />
            <span className="grow">{s.template_name} {s.serial} <span className="mono muted">{s.barcode}</span></span><span className="muted">{s.holder_department_name ?? 'ახალი'}</span></label>)}
        </section>
        <section className="card card-pad stack" style={{ gap: 6 }}>
          <div className="row"><strong className="grow">2. რეცხვა ({received.length})</strong></div>
          {received.map((s) => <label key={s.id} className="row small"><input type="checkbox" checked={selWash.includes(s.id)} onChange={(e) => setSelWash(e.target.checked ? [...selWash, s.id] : selWash.filter((x) => x !== s.id))} />
            <span className="grow">{s.template_name} {s.serial} <span className="mono muted">{s.barcode}</span></span>
            {!st?.wash_record && <button className="btn sm" type="button" onClick={() => setPackSet(s)}>შეფუთვა</button>}</label>)}
          {selWash.length > 0 && <div className="stack" style={{ gap: 6 }}>
            {st?.wash_record && <select className="select" style={{ height: 34 }} aria-label="სარეცხი" value={wash.machine_id} onChange={(e) => setWash({ ...wash, machine_id: e.target.value })}>
              <option value="">— სარეცხი აპარატი —</option>{washers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>}
            <div className="row"><input className="input" style={{ height: 34 }} aria-label="პროგრამა" placeholder="პროგრამა" value={wash.program} onChange={(e) => setWash({ ...wash, program: e.target.value })} />
              <select className="select" style={{ height: 34, maxWidth: 130 }} aria-label="შედეგი" value={wash.result} onChange={(e) => setWash({ ...wash, result: e.target.value })}><option value="pass">გავიდა</option><option value="fail">ჩავარდა</option></select></div>
            <button className="btn sm primary" type="button" disabled={doWash.isPending || (st?.wash_record && !wash.machine_id)} onClick={() => doWash.mutate()}>რეცხვა ({selWash.length})</button></div>}
        </section>
        <section className="card card-pad stack" style={{ gap: 6 }}>
          <strong>3. შემოწმება და შეფუთვა ({washed.length})</strong>
          {washed.map((s) => <div key={s.id} className="row small"><span className="grow">{s.template_name} {s.serial} <span className="mono muted">{s.barcode}</span>{s.is_implant && <span className="chip warn" style={{ height: 18, fontSize: 10 }}>იმპლანტი</span>}</span>
            <button className="btn sm" type="button" onClick={() => setPackSet(s)}>შეფუთვა</button></div>)}
          {packed.data && packed.data.length > 0 && <><strong style={{ marginTop: 8 }}>შეფუთული — სტერილიზაციას ელოდება ({packed.data.length})</strong>
            {packed.data.map((p) => <div key={p.id} className="small row"><span className="grow">{p.template_name} {p.serial} <span className="mono">{p.pack_no}</span>{p.incomplete && <span className="chip warn" style={{ height: 18, fontSize: 10 }}>არასრული</span>}</span></div>)}</>}
        </section>
      </div>
      <ErrorBox error={sets.error ?? recv.error ?? doWash.error ?? bi.error} />
      {packSet && <PackDialog set={packSet} onClose={() => setPackSet(null)} onDone={(p) => { setPackSet(null); refresh(); toast.show(`შეფუთულია: ${p.pack_no}`); void openPdf([p.id]); }} />}
      {cyc && <CycleDialog unit={unit} kind={cyc} packs={packed.data ?? []} onClose={() => setCyc(null)} onDone={() => { setCyc(null); refresh(); }} />}
    </div>
  );
}

function PackDialog({ set, onClose, onDone }: { set: CSet; onClose: () => void; onDone: (p: Pack) => void }) {
  const refs = useRefs();
  const t = useQuery({ queryKey: ['cssd-template', set.template_id], queryFn: () => api<{ items: { line_no: number; name: string; qty: number }[]; packaging_type_id: string | null }>(`/cssd/templates/${set.template_id}`) });
  const [cnt, setCnt] = useState<Record<number, string>>({}); const [notes, setNotes] = useState<Record<number, string>>({}); const [pt, setPt] = useState(''); const [note, setNote] = useState('');
  const items = t.data?.items ?? [];
  const m = useMutation({
    mutationFn: () => api<Pack>('/cssd/pack', { body: { set_id: set.id, packaging_type_id: pt || null, note: note || null,
      checklist: items.map((i) => ({ line_no: i.line_no, counted: cnt[i.line_no] === undefined || cnt[i.line_no] === '' ? i.qty : Number(cnt[i.line_no]), note: notes[i.line_no] || null })) } }),
    onSuccess: onDone,
  });
  const short = items.some((i) => cnt[i.line_no] !== undefined && cnt[i.line_no] !== '' && Number(cnt[i.line_no]) !== i.qty);
  return (
    <Modal title={`შეფუთვა: ${set.template_name} ${set.serial ?? ''} (${set.barcode})`} onClose={onClose} width={720}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={m.isPending || (short && !note.trim() && !Object.values(notes).some((x) => x.trim()))} onClick={() => m.mutate()}>შეფუთვა + ეტიკეტი</button></>}>
      {!t.data ? <Loading /> : (
        <div className="stack">
          <span className="hint">შეამოწმეთ შემადგენლობა. სრულია — დატოვეთ როგორც არის; აკლია / დაზიანებულია — შეიყვანეთ რაოდენობა და შენიშვნა.</span>
          <table className="table"><thead><tr><th>ინსტრუმენტი</th><th className="num">უნდა იყოს</th><th className="num">დათვლილი</th><th>შენიშვნა</th></tr></thead>
            <tbody>{items.map((i) => <tr key={i.line_no}><td>{i.name}</td><td className="num">{i.qty}</td>
              <td className="num"><input className="input mono num" style={{ height: 30, width: 70 }} aria-label={`დათვლილი: ${i.name}`} inputMode="numeric" placeholder={String(i.qty)} value={cnt[i.line_no] ?? ''} onChange={(e) => setCnt({ ...cnt, [i.line_no]: e.target.value })} /></td>
              <td><input className="input" style={{ height: 30 }} aria-label="შენიშვნა" value={notes[i.line_no] ?? ''} onChange={(e) => setNotes({ ...notes, [i.line_no]: e.target.value })} /></td></tr>)}</tbody></table>
          <div className="row"><select className="select" style={{ maxWidth: 300, height: 36 }} aria-label="შეფუთვა" value={pt} onChange={(e) => setPt(e.target.value)}>
            <option value="">{refs.data?.packaging.find((p) => p.id === t.data?.packaging_type_id)?.name ?? '— შეფუთვა —'} (ნაგულისხმევი)</option>
            {refs.data?.packaging.filter((p) => p.is_active).map((p) => <option key={p.id} value={p.id}>{p.name}{p.shelf_days ? ` · ${p.shelf_days} დღე` : ''}</option>)}</select>
            <input className="input grow" style={{ height: 36 }} aria-label="შენიშვნა" placeholder={short ? 'შენიშვნა (არასრული — სავალდებულო)' : 'შენიშვნა'} value={note} onChange={(e) => setNote(e.target.value)} /></div>
          <ErrorBox error={m.error ?? t.error} />
        </div>)}
    </Modal>
  );
}

function CycleDialog({ unit, kind, packs, onClose, onDone }: { unit: string; kind: 'sterilize' | 'bowie_dick'; packs: Pack[]; onClose: () => void; onDone: () => void }) {
  const refs = useRefs(); const toast = useToast();
  const machines = (refs.data?.machines ?? []).filter((m) => m.location_id === unit && m.is_active && m.kind !== 'washer' && (kind === 'sterilize' || m.kind === 'steam'));
  const [f, setF] = useState({ machine_id: machines[0]?.id ?? '', program: '', temp: '', minutes: '', pressure: '', result: 'pass', bi: false, bi_lot: '', cycle_no: '', notes: '' });
  const [sel, setSel] = useState<string[]>(packs.map((p) => p.id)); const [ciFail, setCiFail] = useState<string[]>([]);
  const implant = packs.some((p) => sel.includes(p.id) && p.is_implant);
  const req = useQuery({ queryKey: ['cssd-bi-req', f.machine_id, implant], queryFn: () => api<{ required: boolean; why: string | null }>('/cssd/bi-required', { query: { machine_id: f.machine_id, implant: implant ? 'true' : undefined } }), enabled: !!f.machine_id && kind === 'sterilize' });
  const m = useMutation({
    mutationFn: () => api<Cycle>('/cssd/cycles', { body: { machine_id: f.machine_id, kind, cycle_no: f.cycle_no || null, program: f.program || null, temp_c: f.temp ? Number(f.temp) : null, minutes: f.minutes ? Number(f.minutes) : null,
      pressure_bar: f.pressure ? Number(f.pressure.replace(',', '.')) : null, result: f.result, bi_used: kind === 'sterilize' && f.bi, bi_lot: f.bi_lot || null, pack_ids: kind === 'sterilize' ? sel : [], ci_fail_pack_ids: ciFail, notes: f.notes || null } }),
    onSuccess: (c) => { toast.show(`ციკლი ${c.cycle_no}: ${c.result === 'pass' ? 'გავიდა' : 'ჩავარდა'}`); onDone(); },
  });
  const prog = machines.find((x) => x.id === f.machine_id)?.programs ?? [];
  return (
    <Modal title={kind === 'bowie_dick' ? 'Bowie-Dick ტესტი' : 'სტერილიზაციის ციკლი'} onClose={onClose} width={820}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={m.isPending || !f.machine_id || (kind === 'sterilize' && !sel.length) || (!!req.data?.required && !f.bi)} onClick={() => m.mutate()}>შენახვა</button></>}>
      {toast.node}
      <div className="stack">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
          <Field label="აპარატი" htmlFor="cm"><select id="cm" className="select" value={f.machine_id} onChange={(e) => setF({ ...f, machine_id: e.target.value })}>{machines.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
          <Field label="ციკლის №" htmlFor="cn" hint="ცარიელი — ავტომატური"><input id="cn" className="input mono" value={f.cycle_no} onChange={(e) => setF({ ...f, cycle_no: e.target.value })} /></Field>
          <Field label="შედეგი (აპარატის)" htmlFor="cr"><select id="cr" className="select" value={f.result} onChange={(e) => setF({ ...f, result: e.target.value })}><option value="pass">გავიდა</option><option value="fail">ჩავარდა</option></select></Field>
          {kind === 'sterilize' && <>
            <Field label="პროგრამა" htmlFor="cp"><input id="cp" className="input" list="cprog" value={f.program} onChange={(e) => { const p = prog.find((x) => x.name === e.target.value); setF({ ...f, program: e.target.value, ...(p && { temp: String(p.temp ?? ''), minutes: String(p.minutes ?? '') }) }); }} />
              <datalist id="cprog">{prog.map((p) => <option key={p.name} value={p.name} />)}</datalist></Field>
            <Field label="ტემპერატურა °C" htmlFor="ct"><input id="ct" className="input mono" inputMode="decimal" value={f.temp} onChange={(e) => setF({ ...f, temp: e.target.value })} /></Field>
            <Field label="დრო (წთ) / წნევა (ბარი)" htmlFor="cmin"><div className="row" style={{ gap: 6 }}><input id="cmin" className="input mono" inputMode="decimal" value={f.minutes} onChange={(e) => setF({ ...f, minutes: e.target.value })} />
              <input className="input mono" aria-label="წნევა" inputMode="decimal" value={f.pressure} onChange={(e) => setF({ ...f, pressure: e.target.value })} /></div></Field></>}
        </div>
        {kind === 'sterilize' && <>
          <div className={`alert ${req.data?.required ? 'warn' : ''} row`} style={{ flexWrap: 'wrap' }}>
            <label className="row"><input type="checkbox" checked={f.bi} onChange={(e) => setF({ ...f, bi: e.target.checked })} /> ბიოლოგიური ინდიკატორი ჩაიდო</label>
            {f.bi && <input className="input mono" style={{ maxWidth: 160, height: 34 }} aria-label="BI ლოტი" placeholder="BI ლოტი" value={f.bi_lot} onChange={(e) => setF({ ...f, bi_lot: e.target.value })} />}
            <span className="small grow">{req.data?.required ? `სავალდებულოა: ${req.data.why}` : 'ამ ციკლზე სავალდებულო არ არის'}</span></div>
          <table className="table"><thead><tr><th>ჩატვირთვა</th><th>შეფუთვა</th><th>ნაკრები</th><th>ქიმ. ინდიკატორი</th></tr></thead>
            <tbody>{packs.map((p) => <tr key={p.id}><td><input type="checkbox" aria-label={`ჩატვირთვა ${p.pack_no}`} checked={sel.includes(p.id)} onChange={(e) => setSel(e.target.checked ? [...sel, p.id] : sel.filter((x) => x !== p.id))} /></td>
              <td className="mono">{p.pack_no}</td><td>{p.template_name} {p.serial}{p.is_implant && <span className="chip warn" style={{ marginLeft: 4, height: 18, fontSize: 10 }}>იმპლანტი</span>}</td>
              <td><label className="row small"><input type="checkbox" checked={ciFail.includes(p.id)} disabled={!sel.includes(p.id)} onChange={(e) => setCiFail(e.target.checked ? [...ciFail, p.id] : ciFail.filter((x) => x !== p.id))} /> არ შეიცვალა (ჩავარდა)</label></td></tr>)}</tbody></table></>}
        <Field label="შენიშვნა" htmlFor="cno"><input id="cno" className="input" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- სტერილური საწყობი: გაცემა, ხელახლა, ეტიკეტი
function Storage() {
  const { unit, picker } = useUnit(); const qc = useQueryClient(); const toast = useToast(); const deps = useDeps();
  const q = useQuery({ queryKey: ['cssd-packs', unit, 'storage'], queryFn: () => api<Pack[]>('/cssd/packs', { query: { location_id: unit, status: 'sterile,quarantine,expired,failed,recalled' } }), enabled: !!unit });
  const [sel, setSel] = useState<string[]>([]); const [dep, setDep] = useState('');
  const refresh = () => { setSel([]); for (const k of ['cssd-packs', 'cssd-sets']) void qc.invalidateQueries({ queryKey: [k] }); };
  const issue = useMutation({ mutationFn: () => api<{ issued: number }>('/cssd/issue', { body: { location_id: unit, department_id: dep, pack_ids: sel } }), onSuccess: (r) => { toast.show(`გაიცა: ${r.issued}`); refresh(); } });
  const rep = useMutation({ mutationFn: (id: string) => api(`/cssd/packs/${id}/reprocess`, { method: 'POST' }), onSuccess: refresh });
  const rows = q.data ?? [];
  const okSel = sel.every((id) => rows.find((r) => r.id === id)?.status === 'sterile');
  return (
    <div className="content">
      {toast.node}
      <div className="row" style={{ flexWrap: 'wrap' }}>{picker}<span className="grow" />
        {sel.length > 0 && <><button className="btn" type="button" onClick={() => void openPdf(sel)}>ეტიკეტები ({sel.length})</button>
          <select className="select" style={{ maxWidth: 240, height: 38 }} aria-label="განყოფილება" value={dep} onChange={(e) => setDep(e.target.value)}><option value="">— გაცემა განყოფილებაზე —</option>{deps.data?.filter((d) => d.is_active).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
          <button className="btn primary" type="button" disabled={!dep || !okSel || issue.isPending} onClick={() => issue.mutate()}>გაცემა ({sel.length})</button></>}
      </div>
      <ErrorBox error={q.error ?? issue.error ?? rep.error} />
      {q.isLoading ? <Loading /> : (
        <div className="card"><table className="table">
          <thead><tr><th /><th>შეფუთვა</th><th>ნაკრები</th><th>ციკლი</th><th>ვადა</th><th>სტატუსი</th><th /></tr></thead>
          <tbody>{rows.map((p) => <tr key={p.id}><td><input type="checkbox" aria-label={`მონიშვნა ${p.pack_no}`} checked={sel.includes(p.id)} onChange={(e) => setSel(e.target.checked ? [...sel, p.id] : sel.filter((x) => x !== p.id))} /></td>
            <td className="mono">{p.pack_no}{p.incomplete && <span className="chip warn" style={{ marginLeft: 4, height: 18, fontSize: 10 }}>არასრული</span>}</td><td>{p.template_name} {p.serial} <span className="mono small muted">{p.set_barcode}</span></td>
            <td className="small">{p.machine_name ?? ''} {p.cycle_no ? `№${p.cycle_no}` : ''}{p.bi_result ? ` · BI: ${p.bi_result === 'pending' ? 'ელოდება' : p.bi_result === 'pass' ? '✓' : '✗'}` : ''}</td>
            <td>{p.expires_on ? <span className={`chip ${p.days_left !== null && p.days_left < 0 ? 'danger' : p.days_left !== null && p.days_left <= 7 ? 'warn' : ''}`}>{dateGe(p.expires_on)}</span> : '—'}</td><td>{chip(PACK_ST, p.status)}</td>
            <td>{['sterile', 'expired', 'failed'].includes(p.status) && <button className="btn sm" type="button" onClick={() => { if (confirm('ხელახალი დამუშავება? (შეფუთვა გაუქმდება, ნაკრები — მიღებულში)')) rep.mutate(p.id); }}>ხელახლა</button>}</td></tr>)}
            {!rows.length && <tr><td colSpan={7} className="muted">სტერილური საწყობი ცარიელია</td></tr>}</tbody></table></div>)}
    </div>
  );
}

// ---------------------------------------------------------------- განყოფილება: გაცემული, გამოყენება პაციენტზე, დაბრუნება
function Dept() {
  const qc = useQueryClient(); const toast = useToast(); const refs = useRefs();
  const q = useQuery({ queryKey: ['cssd-packs', 'mine'], queryFn: () => api<Pack[]>('/cssd/packs', { query: { mine: 'true', status: 'issued,recalled' } }) });
  const [use, setUse] = useState<Pack | null>(null); const [scan, setScan] = useState('');
  const ret = useMutation({ mutationFn: (id: string) => api<Pack>(`/cssd/packs/${id}/return`, { method: 'POST' }), onSuccess: () => { toast.show('დაბრუნდა CSSD-ში'); void qc.invalidateQueries({ queryKey: ['cssd-packs'] }); } });
  const onScan = async () => {
    const c = scan.trim(); if (!c) return; setScan('');
    try { const r = await api<{ pack: Pack | null }>(`/cssd/scan/${encodeURIComponent(c)}`); const p = q.data?.find((x) => x.id === r.pack?.id);
      if (p?.status === 'recalled') toast.show('გაწვეულია — არ გამოიყენოთ!'); else if (p) setUse(p); else toast.show('შეფუთვა თქვენს განყოფილებაზე გაცემული არ არის'); }
    catch (e) { toast.show((e as Error).message); }
  };
  return (
    <div className="content">
      {toast.node}
      <form className="row" onSubmit={(e) => { e.preventDefault(); void onScan(); }}>
        <input className="input" style={{ maxWidth: 360, height: 40 }} aria-label="სკანირება" placeholder="სკანირება გამოყენებისას (შეფუთვის ეტიკეტი)" value={scan} onChange={(e) => setScan(e.target.value)} />
        <span className="hint grow">{refs.data?.settings.patient_trace ? 'გამოყენებისას — პაციენტი სავალდებულოა (მიკვლევა).' : ''} გამოყენებული ნაკრები დააბრუნეთ CSSD-ში (ბინძური).</span></form>
      <ErrorBox error={q.error ?? ret.error} />
      {q.isLoading ? <Loading /> : (
        <div className="card"><table className="table">
          <thead><tr><th>შეფუთვა</th><th>ნაკრები</th><th>გაიცა</th><th>ვადა</th><th /></tr></thead>
          <tbody>{q.data?.map((p) => <tr key={p.id} style={p.status === 'recalled' ? { background: 'var(--danger-weak)' } : undefined}>
            <td className="mono">{p.pack_no}</td><td>{p.template_name} {p.serial}</td><td className="small">{p.issued_at ? tsDate(p.issued_at) : ''}</td>
            <td>{p.expires_on ? <span className={`chip ${p.days_left !== null && p.days_left < 0 ? 'danger' : ''}`}>{dateGe(p.expires_on)}</span> : '—'}</td>
            <td style={{ whiteSpace: 'nowrap' }}>{p.status === 'recalled' ? <><span className="chip danger">გაწვეული — არ გამოიყენოთ</span> <button className="btn sm" type="button" onClick={() => ret.mutate(p.id)}>დაბრუნება</button></>
              : <><button className="btn sm primary" type="button" onClick={() => setUse(p)}>გამოყენება</button> <button className="btn sm" type="button" onClick={() => { if (confirm('გაუხსნელი — დავაბრუნოთ CSSD-ში?')) ret.mutate(p.id); }}>დაბრუნება (გაუხსნელი)</button></>}</td></tr>)}
            {!q.data?.length && <tr><td colSpan={5} className="muted">თქვენს განყოფილებაზე გაცემული სტერილური ნაკრები არ არის</td></tr>}</tbody></table></div>)}
      {use && <UseDialog pack={use} trace={!!refs.data?.settings.patient_trace} onClose={() => setUse(null)} onDone={() => { setUse(null); toast.show('აღირიცხა'); void qc.invalidateQueries({ queryKey: ['cssd-packs'] }); }} />}
    </div>
  );
}

function UseDialog({ pack, trace, onClose, onDone }: { pack: Pack; trace: boolean; onClose: () => void; onDone: () => void }) {
  const [pat, setPat] = useState<PatientListItem | null>(null); const [note, setNote] = useState('');
  const m = useMutation({ mutationFn: () => api(`/cssd/packs/${pack.id}/use`, { body: { patient_id: pat?.id ?? null, note: note || null } }), onSuccess: onDone });
  return (
    <Modal title={`გამოყენება: ${pack.template_name} ${pack.serial ?? ''} (${pack.pack_no})`} onClose={onClose} width={640}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={m.isPending || (trace && !pat)} onClick={() => m.mutate()}>გამოყენებულია</button></>}>
      <div className="stack">
        {pat ? <div className="row"><strong className="grow">{pat.first_name} {pat.last_name} <span className="mono small muted">{pat.personal_number}</span></strong><button className="btn sm" type="button" onClick={() => setPat(null)}>შეცვლა</button></div>
          : <PatientSearch autoFocus onSelect={setPat} />}
        <input className="input" aria-label="შენიშვნა" placeholder="შენიშვნა (პროცედურა)" value={note} onChange={(e) => setNote(e.target.value)} />
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- ციკლები
function Cycles({ openId }: { openId: string | null }) {
  const [f, setF] = useState({ from: todayISO().slice(0, 8) + '01', to: todayISO(), kind: '' }); const [open, setOpen] = useState<string | null>(openId);
  const q = useQuery({ queryKey: ['cssd-cycles', 'list', f], queryFn: () => api<Cycle[]>('/cssd/cycles', { query: { from: f.from, to: f.to, kind: f.kind || undefined } }) });
  return (
    <div className="content">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <input className="input mono" type="date" style={{ maxWidth: 160, height: 36 }} aria-label="დან" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        <input className="input mono" type="date" style={{ maxWidth: 160, height: 36 }} aria-label="მდე" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
        <select className="select" style={{ maxWidth: 200, height: 36 }} aria-label="ტიპი" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="">ყველა</option><option value="sterilize">სტერილიზაცია</option><option value="bowie_dick">Bowie-Dick</option><option value="wash">რეცხვა</option></select>
      </div>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : <div className="card"><table className="table">
        <thead><tr><th>დრო</th><th>აპარატი</th><th>№</th><th>ტიპი</th><th>პარამეტრები</th><th className="num">შეფუთვა</th><th>შედეგი</th><th>BI</th><th>ოპერატორი</th></tr></thead>
        <tbody>{q.data?.map((c) => <tr key={c.id} className="clickable" onClick={() => setOpen(c.id)}><td className="small">{tsDate(c.started_at)}</td><td>{c.machine_name}</td><td className="mono">{c.cycle_no}</td>
          <td className="small">{c.kind === 'sterilize' ? 'სტერილიზაცია' : c.kind === 'bowie_dick' ? 'Bowie-Dick' : 'რეცხვა'}</td><td className="small">{[c.program, c.temp_c && `${Number(c.temp_c)}°`, c.minutes && `${Number(c.minutes)} წთ`, c.pressure_bar && `${Number(c.pressure_bar)} ბარი`].filter(Boolean).join(' · ')}</td>
          <td className="num">{c.packs as number}</td><td>{c.result === 'pass' ? <span className="chip ok">გავიდა</span> : <span className="chip danger">ჩავარდა</span>}</td>
          <td>{c.bi_used ? (c.bi_result === 'pending' ? <span className="chip warn">ელოდება</span> : c.bi_result === 'pass' ? <span className="chip ok">✓</span> : <span className="chip danger">ზრდა</span>) : '—'}</td><td className="small">{c.operator_name}</td></tr>)}
          {!q.data?.length && <tr><td colSpan={9} className="muted">ციკლი არ არის</td></tr>}</tbody></table></div>}
      {open && <CycleView id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function CycleView({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['cssd-cycle', id], queryFn: () => api<Cycle & { packs: Pack[] }>(`/cssd/cycles/${id}`) });
  const up = useMutation({ mutationFn: (f: File) => { const fd = new FormData(); fd.append('file', f); return apiUpload(`/cssd/cycles/${id}/attachment`, fd); }, onSuccess: () => void qc.invalidateQueries({ queryKey: ['cssd-cycle', id] }) });
  const c = q.data;
  return (
    <Modal title={c ? `${c.machine_name} — ციკლი ${c.cycle_no}` : 'ციკლი'} onClose={onClose} width={900}>
      {!c ? <Loading /> : (
        <div className="stack">
          <div className="row small" style={{ flexWrap: 'wrap', gap: 14 }}><span>{tsDate(c.started_at)}</span><span>{c.operator_name}</span><span>{[c.program, c.temp_c && `${Number(c.temp_c)}°C`, c.minutes && `${Number(c.minutes)} წთ`, c.pressure_bar && `${Number(c.pressure_bar)} ბარი`].filter(Boolean).join(' · ')}</span>
            {c.result === 'pass' ? <span className="chip ok">გავიდა</span> : <span className="chip danger">ჩავარდა</span>}{c.bi_used && <span>BI {c.bi_lot ?? ''}: <strong>{c.bi_result}</strong>{c.bi_read_by_name ? ` (${c.bi_read_by_name})` : ''}</span>}</div>
          {c.notes && <div className="small">{c.notes}</div>}
          <div className="row small"><span className="grow">ამობეჭდილი: {c.attachment_key ? <span className="chip ok">მიმაგრებულია</span> : 'არ არის'}</span>
            <input type="file" aria-label="ამობეჭდილის ფოტო" accept="image/*,application/pdf" onChange={(e) => { const f = e.target.files?.[0]; if (f) up.mutate(f); }} /></div>
          {c.packs.length > 0 && <table className="table"><thead><tr><th>შეფუთვა</th><th>ნაკრები</th><th>ქიმ.</th><th>სტატუსი</th><th>სად / პაციენტი</th></tr></thead>
            <tbody>{c.packs.map((p) => <tr key={p.id}><td className="mono">{p.pack_no}</td><td>{p.template_name} {p.serial}</td><td>{p.ci_pass === null ? '—' : p.ci_pass ? '✓' : '✗'}</td><td>{chip(PACK_ST, p.status)}</td>
              <td className="small">{p.patient_name ? <Link to={`/patients/${p.patient_id}`}>{p.patient_name} ({p.personal_number})</Link> : p.department_name ?? '—'}</td></tr>)}</tbody></table>}
          <ErrorBox error={q.error ?? up.error} />
        </div>)}
    </Modal>
  );
}

// ---------------------------------------------------------------- ნაკრები
function Sets() {
  const refs = useRefs(); const qc = useQueryClient(); const { user } = useAuth();
  const [search, setSearch] = useState(''); const [open, setOpen] = useState<string | null>(null); const [create, setCreate] = useState(false);
  const q = useQuery({ queryKey: ['cssd-sets', 'all', search], queryFn: () => api<CSet[]>('/cssd/sets', { query: { search: search.trim() || undefined } }) });
  const manage = can(user, 'admin', 'stock_manager') || (refs.data?.units ?? []).some((u) => u.can_process);
  return (
    <div className="content">
      <div className="row"><input className="input" style={{ maxWidth: 320, height: 38 }} aria-label="ძებნა" placeholder="შტრიხკოდი, დასახელება, შეფუთვის №" value={search} onChange={(e) => setSearch(e.target.value)} /><span className="grow" />
        {manage && <button className="btn primary" type="button" onClick={() => setCreate(true)}>+ ნაკრები</button>}</div>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : <div className="card"><table className="table">
        <thead><tr><th>შტრიხკოდი</th><th>ნაკრები</th><th>CSSD</th><th>სტატუსი</th><th>შეფუთვა</th><th>სად</th></tr></thead>
        <tbody>{q.data?.map((s) => <tr key={s.id} className="clickable" onClick={() => setOpen(s.id)}><td className="mono">{s.barcode}</td><td><strong>{s.template_name}</strong> {s.serial}{s.is_implant && <span className="chip warn" style={{ marginLeft: 4, height: 18, fontSize: 10 }}>იმპლანტი</span>}</td>
          <td className="small">{s.home_location_name}</td><td>{chip(SET_ST, s.status)}</td><td className="small">{s.pack_no ? <>{s.pack_no} {chip(PACK_ST, s.pack_status ?? '')}</> : '—'}</td><td className="small">{s.holder_department_name ?? '—'}</td></tr>)}
          {!q.data?.length && <tr><td colSpan={6} className="muted">ნაკრები არ არის</td></tr>}</tbody></table></div>}
      {open && <SetView id={open} onClose={() => setOpen(null)} />}
      {create && <SetCreate onClose={() => setCreate(false)} onDone={() => { setCreate(false); void qc.invalidateQueries({ queryKey: ['cssd-sets'] }); }} />}
    </div>
  );
}
function SetCreate({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const refs = useRefs(); const [f, setF] = useState({ template_id: '', home_location_id: '', count: '1', barcode: '' });
  const m = useMutation({ mutationFn: () => api<CSet[]>('/cssd/sets', { body: { template_id: f.template_id, home_location_id: f.home_location_id || refs.data?.units[0]?.id, count: Number(f.count) || 1, barcode: f.barcode || null } }), onSuccess: onDone });
  return (
    <Modal title="ახალი ნაკრები" onClose={onClose} width={560} footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={!f.template_id || m.isPending} onClick={() => m.mutate()}>შექმნა</button></>}>
      <div className="stack">
        <Field label="ნაკრების ტიპი" htmlFor="st"><select id="st" className="select" value={f.template_id} onChange={(e) => setF({ ...f, template_id: e.target.value })}><option value="">— აირჩიეთ —</option>{refs.data?.templates.filter((t) => t.is_active).map((t) => <option key={t.id} value={t.id}>{t.name} ({t.code})</option>)}</select></Field>
        <Field label="CSSD ერთეული" htmlFor="su"><select id="su" className="select" value={f.home_location_id} onChange={(e) => setF({ ...f, home_location_id: e.target.value })}>{refs.data?.units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
        <div className="row"><Field label="რაოდენობა" htmlFor="sc"><input id="sc" className="input mono" type="number" min={1} max={50} value={f.count} onChange={(e) => setF({ ...f, count: e.target.value })} /></Field>
          <Field label="შტრიხკოდი (ერთზე)" htmlFor="sb" hint="ცარიელი — CS-NNNNNN"><input id="sb" className="input mono" value={f.barcode} onChange={(e) => setF({ ...f, barcode: e.target.value.toUpperCase() })} /></Field></div>
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}
function SetView({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['cssd-set', id], queryFn: () => api<CSet & { items: { line_no: number; name: string; qty: number }[]; packs: Pack[]; events: { id: string; kind: string; created_at: string; user_name: string }[]; instruments: { id: string; code: string; name: string; cycles: number; max_cycles: number | null; status: string }[] }>(`/cssd/sets/${id}`) });
  const s = q.data;
  return (
    <Modal title={s ? `${s.template_name} ${s.serial ?? ''} — ${s.barcode}` : 'ნაკრები'} onClose={onClose} width={900}>
      {!s ? <Loading /> : (
        <div className="stack">
          <div className="row small" style={{ gap: 14, flexWrap: 'wrap' }}>{chip(SET_ST, s.status)}<span>CSSD: {s.home_location_name}</span>{s.holder_department_name && <span>სად: {s.holder_department_name}</span>}</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <section className="card"><div className="card-head"><h2>შემადგენლობა</h2></div><table className="table"><tbody>{s.items.map((i) => <tr key={i.line_no}><td>{i.name}</td><td className="num">{i.qty}</td></tr>)}</tbody></table></section>
            <section className="card"><div className="card-head"><h2>ისტორია</h2></div><table className="table"><tbody>{s.events.slice(0, 20).map((e) => <tr key={e.id}><td className="small">{tsDate(e.created_at)}</td><td className="small">{e.kind}</td><td className="small">{e.user_name}</td></tr>)}</tbody></table></section>
          </div>
          {s.instruments.length > 0 && <section className="card"><div className="card-head"><h2>ინსტრუმენტები</h2></div><table className="table"><tbody>{s.instruments.map((i) => <tr key={i.id}><td className="mono">{i.code}</td><td>{i.name}</td><td className="num">{i.cycles}{i.max_cycles ? ` / ${i.max_cycles}` : ''}</td><td>{i.status}</td></tr>)}</tbody></table></section>}
          <section className="card"><div className="card-head"><h2>შეფუთვები</h2></div><table className="table"><tbody>{s.packs.map((p) => <tr key={p.id}><td className="mono">{p.pack_no}</td><td className="small">{tsDate(p.packed_at)}</td><td>{chip(PACK_ST, p.status)}</td>
            <td className="small">{p.machine_name ?? ''} {p.cycle_no ? `№${p.cycle_no}` : ''}</td><td className="small">{p.patient_name ?? p.department_name ?? ''}</td></tr>)}</tbody></table></section>
        </div>)}
      <ErrorBox error={q.error} />
    </Modal>
  );
}

// ---------------------------------------------------------------- ცნობარები: ნაკრების ტიპები, შეფუთვა, აპარატები
function RefsPage() {
  const refs = useRefs(); const qc = useQueryClient(); const deps = useDeps();
  const [tpl, setTpl] = useState<Partial<Template> | null>(null); const [mach, setMach] = useState<Partial<Machine> | null>(null); const [pkg, setPkg] = useState<Partial<Packaging> | null>(null);
  const done = () => { setTpl(null); setMach(null); setPkg(null); void qc.invalidateQueries({ queryKey: ['cssd-refs'] }); };
  const r = refs.data; if (!r) return <div className="content"><Loading /></div>;
  return (
    <div className="content">
      <section className="card"><div className="card-head row"><h2 className="grow">ნაკრების ტიპები</h2><button className="btn sm primary" type="button" onClick={() => setTpl({})}>+ ტიპი</button></div>
        <table className="table"><tbody>{r.templates.map((t) => <tr key={t.id} className="clickable" onClick={() => setTpl(t)} style={t.is_active ? undefined : { opacity: 0.5 }}><td className="mono">{t.code}</td><td><strong>{t.name}</strong>{t.is_implant && <span className="chip warn" style={{ marginLeft: 4, height: 18, fontSize: 10 }}>იმპლანტი</span>}</td>
          <td className="small">{t.owner_department_name ?? '—'}</td><td className="small">{t.packaging_name ?? '—'}</td><td className="num small">{t.items} პოზ. · {t.sets} ნაკრ.</td></tr>)}
          {!r.templates.length && <tr><td className="muted">ტიპი არ არის</td></tr>}</tbody></table></section>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <section className="card"><div className="card-head row"><h2 className="grow">შეფუთვის ტიპები</h2><button className="btn sm" type="button" onClick={() => setPkg({})}>+ ტიპი</button></div>
          <table className="table"><tbody>{r.packaging.map((p) => <tr key={p.id} className="clickable" onClick={() => setPkg(p)} style={p.is_active ? undefined : { opacity: 0.5 }}><td>{p.name}</td><td className="num small">{p.shelf_days ? `${p.shelf_days} დღე` : 'მოვლენაზე'}</td><td className="small">{p.consumables.length ? `${p.consumables.length} მასალა` : ''}</td></tr>)}</tbody></table></section>
        <section className="card"><div className="card-head row"><h2 className="grow">აპარატები</h2><button className="btn sm" type="button" onClick={() => setMach({})}>+ აპარატი</button></div>
          <table className="table"><tbody>{r.machines.map((m) => <tr key={m.id} className="clickable" onClick={() => setMach(m)} style={m.is_active ? undefined : { opacity: 0.5 }}><td><strong>{m.name}</strong><div className="small muted">{[m.manufacturer, m.model].filter(Boolean).join(' ')}</div></td><td className="small">{KIND_KA[m.kind]}</td><td className="small">{m.location_name}</td></tr>)}</tbody></table></section>
      </div>
      {tpl && <TemplateDialog t={tpl} deps={deps.data ?? []} packaging={r.packaging} onClose={() => setTpl(null)} onDone={done} />}
      {mach && <MachineDialog m={mach} units={r.units} onClose={() => setMach(null)} onDone={done} />}
      {pkg && <PackagingDialog p={pkg} onClose={() => setPkg(null)} onDone={done} />}
    </div>
  );
}
function TemplateDialog({ t, deps, packaging, onClose, onDone }: { t: Partial<Template>; deps: Department[]; packaging: Packaging[]; onClose: () => void; onDone: () => void }) {
  const full = useQuery({ queryKey: ['cssd-template', t.id], queryFn: () => api<{ items: { name: string; qty: number }[] }>(`/cssd/templates/${t.id}`), enabled: !!t.id });
  const [f, setF] = useState({ code: t.code ?? '', name: t.name ?? '', owner: t.owner_department_id ?? '', pkg: t.packaging_type_id ?? '', implant: t.is_implant ?? false, hint: t.program_hint ?? '', active: t.is_active ?? true });
  const [items, setItems] = useState<{ name: string; qty: string }[] | null>(null);
  const list = items ?? (full.data?.items ?? []).map((i) => ({ name: i.name, qty: String(i.qty) }));
  const m = useMutation({ mutationFn: () => api(t.id ? `/cssd/templates/${t.id}` : '/cssd/templates', { method: t.id ? 'PATCH' : 'POST', body: { ...(!t.id && { code: f.code }), name: f.name, owner_department_id: f.owner || null,
    packaging_type_id: f.pkg || null, is_implant: f.implant, program_hint: f.hint || null, is_active: f.active, items: list.filter((i) => i.name.trim()).map((i) => ({ name: i.name.trim(), qty: Number(i.qty) || 1 })) } }), onSuccess: onDone });
  return (
    <Modal title={t.id ? `ნაკრების ტიპი: ${t.name}` : 'ახალი ნაკრების ტიპი'} onClose={onClose} width={760} footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={m.isPending || !f.name || (!t.id && !f.code)} onClick={() => m.mutate()}>შენახვა</button></>}>
      <div className="stack">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
          <Field label="კოდი" htmlFor="tc"><input id="tc" className="input mono" disabled={!!t.id} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
          <div style={{ gridColumn: 'span 2' }}><Field label="დასახელება" htmlFor="tn"><input id="tn" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field></div>
          <Field label="განყოფილება (მფლობელი)" htmlFor="to"><select id="to" className="select" value={f.owner} onChange={(e) => setF({ ...f, owner: e.target.value })}><option value="">—</option>{deps.filter((d) => d.is_active).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
          <Field label="შეფუთვა" htmlFor="tp"><select id="tp" className="select" value={f.pkg} onChange={(e) => setF({ ...f, pkg: e.target.value })}><option value="">—</option>{packaging.filter((p) => p.is_active).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
          <Field label="პროგრამა (მინიშნება)" htmlFor="th"><input id="th" className="input" value={f.hint} onChange={(e) => setF({ ...f, hint: e.target.value })} placeholder="134° 5 წთ" /></Field>
        </div>
        <div className="row" style={{ gap: 18 }}><label className="row"><input type="checkbox" checked={f.implant} onChange={(e) => setF({ ...f, implant: e.target.checked })} /> იმპლანტი (BI-ს მოლოდინი)</label>
          {t.id && <label className="row"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> აქტიური</label>}</div>
        <strong>შემადგენლობა</strong>
        {list.map((i, k) => <div key={k} className="row"><input className="input grow" style={{ height: 34 }} aria-label="ინსტრუმენტი" value={i.name} onChange={(e) => setItems(list.map((x, j) => (j === k ? { ...x, name: e.target.value } : x)))} />
          <input className="input mono num" style={{ height: 34, width: 70 }} aria-label="რაოდენობა" value={i.qty} onChange={(e) => setItems(list.map((x, j) => (j === k ? { ...x, qty: e.target.value } : x)))} />
          <button className="icon-btn" type="button" aria-label="წაშლა" onClick={() => setItems(list.filter((_, j) => j !== k))}>×</button></div>)}
        <button className="btn sm" type="button" style={{ alignSelf: 'flex-start' }} onClick={() => setItems([...list, { name: '', qty: '1' }])}>+ პოზიცია</button>
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}
function MachineDialog({ m, units, onClose, onDone }: { m: Partial<Machine>; units: Unit[]; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ name: m.name ?? '', kind: m.kind ?? 'steam', location_id: m.location_id ?? units[0]?.id ?? '', manufacturer: m.manufacturer ?? '', model: m.model ?? '', serial_no: m.serial_no ?? '', active: m.is_active ?? true,
    programs: (m.programs ?? []).map((p) => `${p.name}|${p.temp ?? ''}|${p.minutes ?? ''}`).join('\n') });
  const s = useMutation({ mutationFn: () => api(m.id ? `/cssd/machines/${m.id}` : '/cssd/machines', { method: m.id ? 'PATCH' : 'POST', body: { name: f.name, kind: f.kind, location_id: f.location_id, manufacturer: f.manufacturer || null, model: f.model || null, serial_no: f.serial_no || null, is_active: f.active,
    programs: f.programs.split('\n').map((l) => l.split('|')).filter((x) => x[0]?.trim()).map(([n, t, mi]) => ({ name: n.trim(), ...(t && { temp: Number(t) }), ...(mi && { minutes: Number(mi) }) })) } }), onSuccess: onDone });
  return (
    <Modal title={m.id ? `აპარატი: ${m.name}` : 'ახალი აპარატი'} onClose={onClose} width={640} footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={s.isPending || !f.name || !f.location_id} onClick={() => s.mutate()}>შენახვა</button></>}>
      <div className="stack">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label="დასახელება" htmlFor="mn"><input id="mn" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="ტიპი" htmlFor="mk"><select id="mk" className="select" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as Machine['kind'] })}>{Object.entries(KIND_KA).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="CSSD ერთეული" htmlFor="ml"><select id="ml" className="select" value={f.location_id} onChange={(e) => setF({ ...f, location_id: e.target.value })}>{units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
          <Field label="მწარმოებელი / მოდელი" htmlFor="mm"><div className="row" style={{ gap: 6 }}><input id="mm" className="input" value={f.manufacturer} onChange={(e) => setF({ ...f, manufacturer: e.target.value })} /><input className="input" aria-label="მოდელი" value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} /></div></Field>
          <Field label="სერიული №" htmlFor="ms"><input id="ms" className="input mono" value={f.serial_no} onChange={(e) => setF({ ...f, serial_no: e.target.value })} /></Field>
          {m.id && <label className="row" style={{ marginTop: 26 }}><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> აქტიური</label>}
        </div>
        <Field label="პროგრამები (თითო ხაზზე: დასახელება|°C|წთ)" htmlFor="mp"><textarea id="mp" className="textarea" rows={3} value={f.programs} onChange={(e) => setF({ ...f, programs: e.target.value })} placeholder={'134° სტანდარტი|134|5\n121° რეზინი|121|20'} /></Field>
        <ErrorBox error={s.error} />
      </div>
    </Modal>
  );
}
function PackagingDialog({ p, onClose, onDone }: { p: Partial<Packaging>; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ name: p.name ?? '', shelf: p.shelf_days ? String(p.shelf_days) : '', active: p.is_active ?? true });
  const [cons, setCons] = useState<{ item_id: string; name: string; qty: string }[]>((p.consumables ?? []).map((c) => ({ item_id: c.item_id, name: c.item_id.slice(0, 8), qty: String(c.qty) })));
  const m = useMutation({ mutationFn: () => api(p.id ? `/cssd/packaging/${p.id}` : '/cssd/packaging', { method: p.id ? 'PATCH' : 'POST', body: { name: f.name, shelf_days: f.shelf ? Number(f.shelf) : null, is_active: f.active,
    consumables: cons.map((c) => ({ item_id: c.item_id, qty: Number(c.qty.replace(',', '.')) || 1 })) } }), onSuccess: onDone });
  return (
    <Modal title={p.id ? `შეფუთვა: ${p.name}` : 'ახალი შეფუთვის ტიპი'} onClose={onClose} width={640} footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={m.isPending || !f.name} onClick={() => m.mutate()}>შენახვა</button></>}>
      <div className="stack">
        <div className="row"><Field label="დასახელება" htmlFor="pn"><input id="pn" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="სტერილობის ვადა (დღე)" htmlFor="ps" hint="ცარიელი — მოვლენაზე დამოკიდებული"><input id="ps" className="input mono" inputMode="numeric" value={f.shelf} onChange={(e) => setF({ ...f, shelf: e.target.value })} /></Field></div>
        {p.id && <label className="row"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> აქტიური</label>}
        <strong>შეფუთვაზე ჩამოსაწერი მასალა (CSSD-ის ქვესაწყობიდან)</strong>
        {cons.map((c, k) => <div key={k} className="row"><span className="grow">{c.name}</span><input className="input mono num" style={{ height: 32, width: 70 }} aria-label="რაოდენობა" value={c.qty} onChange={(e) => setCons(cons.map((x, j) => (j === k ? { ...x, qty: e.target.value } : x)))} />
          <button className="icon-btn" type="button" aria-label="წაშლა" onClick={() => setCons(cons.filter((_, j) => j !== k))}>×</button></div>)}
        <ItemSearch placeholder="მასალა: პაკეტი, ინდიკატორი…" onPick={(i) => setCons([...cons, { item_id: i.id, name: i.name, qty: '1' }])} />
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- რეპორტი
function Report() {
  const [f, setF] = useState({ from: todayISO().slice(0, 8) + '01', to: todayISO() });
  const q = useQuery({ queryKey: ['cssd-report', f], queryFn: () => api<{ cycles: { machine_name: string; kind: string; total: number; failed: number; bi: number; bi_failed: number }[]; templates: { template_name: string; packed: number; issued: number; used: number; recalled: number; incomplete: number }[] }>('/cssd/report', { query: f }) });
  return (
    <div className="content">
      <div className="row"><input className="input mono" type="date" style={{ maxWidth: 160, height: 36 }} aria-label="დან" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        <input className="input mono" type="date" style={{ maxWidth: 160, height: 36 }} aria-label="მდე" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></div>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : <>
        <section className="card"><div className="card-head"><h2>ციკლები</h2></div><table className="table">
          <thead><tr><th>აპარატი</th><th>ტიპი</th><th className="num">სულ</th><th className="num">ჩავარდა</th><th className="num">BI</th><th className="num">BI ზრდა</th></tr></thead>
          <tbody>{q.data?.cycles.map((c, i) => <tr key={i}><td>{c.machine_name}</td><td>{c.kind}</td><td className="num">{c.total}</td><td className="num">{c.failed || ''}</td><td className="num">{c.bi || ''}</td><td className="num">{c.bi_failed || ''}</td></tr>)}</tbody></table></section>
        <section className="card"><div className="card-head"><h2>ნაკრებები</h2></div><table className="table">
          <thead><tr><th>ნაკრების ტიპი</th><th className="num">შეფუთული</th><th className="num">გაცემული</th><th className="num">გამოყენებული</th><th className="num">არასრული</th><th className="num">გაწვეული</th></tr></thead>
          <tbody>{q.data?.templates.map((t, i) => <tr key={i}><td>{t.template_name}</td><td className="num">{t.packed}</td><td className="num">{t.issued}</td><td className="num">{t.used}</td><td className="num">{t.incomplete || ''}</td><td className="num">{t.recalled || ''}</td></tr>)}</tbody></table></section>
      </>}
    </div>
  );
}
