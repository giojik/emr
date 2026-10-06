import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, can, openBlob } from '../../api/client';
import type { Doctor, IcdCode, PatientListItem } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import PatientSearch from '../../components/PatientSearch';
import { ErrorBox, Field, Loading, Modal, useDebounced, useToast } from '../../components/ui';
import { age, dateGe, genderShort, shiftDay, todayISO, tsDate } from '../../lib/format';
import { useModules } from '../../lib/modules';
import IcdPicker from '../encounter/IcdPicker';
import { BED_ST, chipOf, ISOLATION_KA, SEVERITY_KA, SOURCE_KA, STAY_ST, useCensus, withConfirm, type Board, type BoardBed, type Occupant, type Planned, type StayListItem } from './types';

const ADMITTERS = ['admin', 'receptionist', 'doctor'] as const;
const inval = (qc: ReturnType<typeof useQueryClient>) => { for (const k of ['ipd-board', 'ipd-census', 'ipd-stays', 'ipd-planned', 'ipd-stay', 'ipd-structure']) void qc.invalidateQueries({ queryKey: [k] }); };
export const invalIpd = inval;

/** სტაციონარი (0040): დაფა, პაციენტები, ჰოსპიტალიზაცია, გეგმიური რიგი, საწოლფონდი */
export default function Inpatient() {
  const mods = useModules(); const { user } = useAuth();
  const [sp] = useSearchParams();
  const m = mods.data?.find((x) => x.code === 'inpatient');
  const planned = !!(m?.settings as { planned_queue?: boolean } | undefined)?.planned_queue;
  const tabs: [string, string, boolean][] = [['board', 'განყოფილების დაფა', true], ['list', 'პაციენტები', true], ['admit', 'ჰოსპიტალიზაცია', can(user, ...ADMITTERS)],
    ['planned', 'გეგმიური რიგი', planned], ['census', 'საწოლფონდი', true]];
  const visible = tabs.filter((t) => t[2]);
  const tab = sp.get('tab') ?? 'board';
  if (mods.isLoading) return <div className="content"><Loading /></div>;
  return (
    <>
      <header className="topbar" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8, paddingBottom: 0 }}>
        <h1>სტაციონარი</h1>
        <nav aria-label="სტაციონარი" className="row" style={{ gap: 2, flexWrap: 'wrap' }}>
          {visible.map(([k, l]) => <Link key={k} to={`/inpatient?tab=${k}`} className={`admin-tab${tab === k ? ' active' : ''}`}>{l}</Link>)}
        </nav>
      </header>
      {!m?.enabled ? <div className="content"><div className="card empty">მოდული „სტაციონარი“ გამორთულია (ადმინისტრირება → მოდულები).</div></div>
        : tab === 'list' ? <Stays /> : tab === 'admit' ? <Admit /> : tab === 'planned' ? <PlannedQueue /> : tab === 'census' ? <Census /> : <BoardView />}
    </>
  );
}

// ---------------------------------------------------------------- განყოფილების არჩევა (ჩემი განყოფილება — ნაგულისხმევად)
function useDepartment() {
  const census = useCensus(); const [sp, setSp] = useSearchParams();
  const deps = census.data?.departments ?? [];
  const id = sp.get('department_id') ?? (deps.find((d) => d.id === census.data?.my_department_id)?.id ?? deps[0]?.id ?? '');
  const picker = (
    <select className="select" style={{ maxWidth: 320, height: 40 }} aria-label="განყოფილება" value={id} onChange={(e) => { sp.set('department_id', e.target.value); setSp(sp, { replace: true }); }}>
      {deps.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
    </select>);
  return { id, picker, loading: census.isLoading, empty: !census.isLoading && !deps.length };
}

// ---------------------------------------------------------------- დაფა
function BoardView() {
  const { id, picker, loading, empty } = useDepartment(); const qc = useQueryClient(); const toast = useToast(); const nav = useNavigate();
  const b = useQuery({ queryKey: ['ipd-board', id], queryFn: () => api<Board>('/inpatient/board', { query: { department_id: id } }), enabled: !!id, refetchInterval: 30_000 });
  const [assign, setAssign] = useState<Occupant | null>(null);
  const [blockBed, setBlockBed] = useState<BoardBed | null>(null);
  const act = useMutation({ mutationFn: (a: { id: string; action: 'clean' | 'unblock' }) => api(`/inpatient/beds/${a.id}/${a.action}`, { body: {} }), onSuccess: () => { toast.show('შესრულდა'); inval(qc); } });
  if (loading) return <div className="content"><Loading /></div>;
  if (empty) return <div className="content"><div className="card empty">საწოლფონდი ჯერ არ არის შექმნილი (ადმინისტრირება → საწოლფონდი).</div></div>;
  const all = b.data?.wards.flatMap((w) => w.beds) ?? [];
  const cnt = (s: string) => all.filter((x) => x.status === s && (s !== 'free' || !x.is_overflow)).length;   // თავისუფალი — ძირითადი საწოლები (როგორც საწოლფონდში)
  return (
    <div className="content">
      {toast.node}
      <div className="row" style={{ flexWrap: 'wrap' }}>
        {picker}
        <span className="grow" />
        {(['free', 'occupied', 'reserved', 'cleaning', 'blocked'] as const).map((s) => <span key={s} className={`chip ${BED_ST[s][0]}`}>{BED_ST[s][1]}: {cnt(s)}</span>)}
      </div>
      <ErrorBox error={b.error ?? act.error} />
      {b.data && b.data.awaiting.length > 0 && (
        <section className="card" style={{ borderColor: 'var(--warn)' }}>
          <div className="card-head"><h2 style={{ margin: 0 }}>ელოდება საწოლს</h2><span className="chip warn">{b.data.awaiting.length}</span></div>
          <table className="table"><tbody>{b.data.awaiting.map((o) => (
            <tr key={o.encounter_id}>
              <td><Link to={`/inpatient/stay/${o.encounter_id}`}><strong>{o.last_name} {o.first_name}</strong></Link> <span className="small muted">{genderShort(o.gender)} · {age(o.birth_date)}</span></td>
              <td className="mono small">{o.adm_no}</td><td className="small">{o.diagnosis}</td><td className="small">{o.doctor_name}</td>
              <td>{chipOf(SEVERITY_KA, o.severity)} {o.isolation && <span className="chip warn">{ISOLATION_KA[o.isolation]}</span>}</td>
              <td className="small muted">{tsDate(o.started_at)}</td>
              <td style={{ textAlign: 'right' }}>{b.data.can_assign && <button className="btn sm primary" type="button" onClick={() => setAssign(o)}>საწოლის მინიჭება</button>}</td>
            </tr>))}</tbody></table>
        </section>)}
      {b.isLoading ? <Loading /> : b.data?.wards.map((w) => (
        <section key={w.id} className="card">
          <div className="card-head"><h2 style={{ margin: 0 }}>პალატა {w.code}</h2>{w.name && <span className="muted">{w.name}</span>}
            {w.sex !== 'mixed' && <span className="chip info">{w.sex === 'male' ? 'მამაკაცის' : 'ქალის'}</span>}{w.isolation_capable && <span className="chip warn">იზოლაცია</span>}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 10, padding: 12 }}>
            {w.beds.map((x) => <BedTile key={x.id} b={x} board={b.data!} onOpen={(e) => nav(`/inpatient/stay/${e}`)} onClean={() => act.mutate({ id: x.id, action: 'clean' })}
              onBlock={() => setBlockBed(x)} onUnblock={() => act.mutate({ id: x.id, action: 'unblock' })} />)}
            {!w.beds.length && <span className="small muted">საწოლი არ არის</span>}
          </div>
        </section>))}
      {assign && b.data && <AssignDialog encounterId={assign.encounter_id} title={`${assign.last_name} ${assign.first_name}`} board={b.data} onClose={() => setAssign(null)} />}
      {blockBed && <BlockDialog bed={blockBed} onClose={() => setBlockBed(null)} />}
    </div>
  );
}

function BedTile({ b, board, onOpen, onClean, onBlock, onUnblock }: { b: BoardBed; board: Board; onOpen: (encounterId: string) => void; onClean: () => void; onBlock: () => void; onUnblock: () => void }) {
  const o = b.occupant;
  const border = { free: 'var(--ok)', occupied: 'var(--line)', reserved: 'var(--info)', cleaning: 'var(--warn)', blocked: 'var(--danger)' }[b.status];
  return (
    <div className="card" style={{ padding: 10, borderLeft: `4px solid ${border}`, cursor: o ? 'pointer' : 'default', minHeight: 92 }} onClick={() => o && onOpen(o.encounter_id)}
      role={o ? 'button' : undefined} tabIndex={o ? 0 : undefined} onKeyDown={(e) => { if (o && e.key === 'Enter') onOpen(o.encounter_id); }}>
      <div className="row" style={{ gap: 6 }}><strong className="grow">{b.code}{b.is_overflow && <span className="small muted"> · დამატ.</span>}</strong>
        <span className="small muted">{b.type_name}</span></div>
      {o ? (
        <div className="stack" style={{ gap: 3, marginTop: 4 }}>
          <span><strong>{o.last_name} {o.first_name}</strong> <span className="small muted">{genderShort(o.gender)} · {age(o.birth_date)}</span></span>
          <span className="small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={o.diagnosis ?? ''}>{o.diagnosis ?? '—'}</span>
          <span className="small muted">{o.doctor_name ?? '—'} · დღე {o.day + 1}</span>
          <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>{chipOf(SEVERITY_KA, o.severity)}
            {o.isolation && <span className="chip warn">{ISOLATION_KA[o.isolation]}</span>}
            {o.allergies > 0 && <span className="chip danger">ალერგია</span>}
            {!o.consent && <span className="chip" title="ჰოსპიტალიზაციის თანხმობა არ არის">თანხმობა —</span>}</div>
        </div>
      ) : (
        <div className="stack" style={{ gap: 6, marginTop: 6 }}>
          {chipOf(BED_ST, b.status)}
          {b.reservation && <span className="small">{b.reservation.patient_name} · {dateGe(b.reservation.planned_date)}</span>}
          {b.status === 'blocked' && b.status_reason && <span className="small muted">{b.status_reason}</span>}
          <div className="row" style={{ gap: 6 }}>
            {b.status === 'cleaning' && board.can_assign && <button className="btn sm" type="button" onClick={onClean}>დალაგებულია</button>}
            {['free', 'cleaning'].includes(b.status) && board.can_manage && <button className="btn sm" type="button" onClick={onBlock}>ბლოკი</button>}
            {b.status === 'blocked' && board.can_manage && <button className="btn sm" type="button" onClick={onUnblock}>ბლოკის მოხსნა</button>}
          </div>
        </div>)}
    </div>
  );
}

function BlockDialog({ bed, onClose }: { bed: BoardBed; onClose: () => void }) {
  const qc = useQueryClient(); const [reason, setReason] = useState('');
  const m = useMutation({ mutationFn: () => api(`/inpatient/beds/${bed.id}/block`, { body: { reason } }), onSuccess: () => { inval(qc); onClose(); } });
  return (
    <Modal title={`საწოლის დაბლოკვა — ${bed.code}`} onClose={onClose} width={460}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn danger" type="button" disabled={m.isPending || reason.trim().length < 3} onClick={() => m.mutate()}>დაბლოკვა</button></>}>
      <Field label="მიზეზი" htmlFor="br" required><input id="br" className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="რემონტი, იზოლაცია, დეზინფექცია…" /></Field>
      <ErrorBox error={m.error} />
    </Modal>
  );
}

/** საწოლის არჩევა (თავისუფალი) — მინიჭება / შეცვლა / დაჯავშნა */
export function AssignDialog({ encounterId, plannedId, title, board, change, onClose }: { encounterId?: string; plannedId?: string; title: string; board: Board; change?: boolean; onClose: () => void }) {
  const qc = useQueryClient(); const [bed, setBed] = useState(''); const [reason, setReason] = useState('');
  const m = useMutation({
    mutationFn: () => withConfirm((confirm) => plannedId ? api(`/inpatient/planned/${plannedId}/reserve`, { body: { bed_id: bed, confirm } })
      : api(`/inpatient/stays/${encounterId}/bed`, { body: { bed_id: bed, reason: reason.trim() || undefined, confirm } })),
    onSuccess: (r) => { if (r) { inval(qc); onClose(); } },
  });
  const free = board.wards.flatMap((w) => w.beds.filter((b) => b.status === 'free' && (!b.is_overflow || board.settings.overflow_beds)).map((b) => ({ ...b, ward: w })));
  return (
    <Modal title={`${plannedId ? 'საწოლის დაჯავშნა' : change ? 'საწოლის შეცვლა' : 'საწოლის მინიჭება'} — ${title}`} onClose={onClose} width={560}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={m.isPending || !bed || (change && reason.trim().length < 3)} onClick={() => m.mutate()}>შენახვა</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        {!free.length ? <div className="alert warn">თავისუფალი საწოლი არ არის.</div> : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8 }}>
            {free.map((b) => (
              <label key={b.id} className="card" style={{ padding: 8, cursor: 'pointer', borderColor: bed === b.id ? 'var(--accent)' : undefined, borderWidth: bed === b.id ? 2 : 1 }}>
                <input type="radio" name="bed" className="sr-only" checked={bed === b.id} onChange={() => setBed(b.id)} />
                <strong>{b.code}</strong>{b.is_overflow && <span className="small muted"> · დამატ.</span>}
                <div className="small muted">{b.type_name}{b.ward.sex !== 'mixed' ? ` · ${b.ward.sex === 'male' ? 'მამ.' : 'ქალ.'}` : ''}{b.ward.isolation_capable ? ' · იზოლ.' : ''}</div>
              </label>))}
          </div>)}
        {change && <Field label="მიზეზი" htmlFor="ar" required><input id="ar" className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- პაციენტები (სია)
function Stays() {
  const census = useCensus(); const [dep, setDep] = useState(''); const [status, setStatus] = useState('active'); const [search, setSearch] = useState('');
  const ds = useDebounced(search.trim(), 300);
  const q = useQuery({ queryKey: ['ipd-stays', dep, status, ds], queryFn: () => api<StayListItem[]>('/inpatient/stays', { query: { department_id: dep, status, search: ds } }) });
  return (
    <div className="content">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <input className="input" style={{ maxWidth: 320, height: 40 }} aria-label="ძებნა" placeholder="IP-ნომერი (სკანერი), პირადი №, გვარი" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
        <select className="select" style={{ maxWidth: 260, height: 40 }} aria-label="განყოფილება" value={dep} onChange={(e) => setDep(e.target.value)}>
          <option value="">ყველა განყოფილება</option>{census.data?.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
        <select className="select" style={{ maxWidth: 200, height: 40 }} aria-label="სტატუსი" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="active">სტაციონარში</option><option value="discharged">გაწერილი</option><option value="cancelled">გაუქმებული</option><option value="active,discharged,cancelled">ყველა</option></select>
        <span className="muted">{q.data?.length ?? 0}</span>
      </div>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : (
        <div className="card"><table className="table">
          <thead><tr><th>№</th><th>პაციენტი</th><th>განყოფილება / საწოლი</th><th>მკურნალი ექიმი</th><th>მიღება</th><th>მდგომარეობა</th><th>სტატუსი</th></tr></thead>
          <tbody>{q.data?.map((s) => (
            <tr key={s.encounter_id}>
              <td className="mono"><Link to={`/inpatient/stay/${s.encounter_id}`}>{s.adm_no}</Link></td>
              <td><strong>{s.last_name} {s.first_name}</strong> <span className="small muted">{genderShort(s.gender)} · {age(s.birth_date)} · {s.personal_number ?? ''}</span></td>
              <td>{s.department_name}{s.bed_code ? <span className="mono"> · {s.bed_code}</span> : s.status === 'active' ? <span className="chip warn" style={{ marginLeft: 6 }}>ელოდება საწოლს</span> : null}</td>
              <td className="small">{s.doctor_name}</td><td className="small">{tsDate(s.admitted_at)} · {SOURCE_KA[s.source]}</td>
              <td>{chipOf(SEVERITY_KA, s.severity)}</td><td>{chipOf(STAY_ST, s.status)}</td>
            </tr>))}
            {!q.data?.length && <tr><td colSpan={7} className="empty">ჩანაწერი არ არის</td></tr>}</tbody>
        </table></div>)}
    </div>
  );
}

// ---------------------------------------------------------------- ჰოსპიტალიზაცია
function Admit({ planned, onDone }: { planned?: Planned; onDone?: () => void } = {}) {
  const { user } = useAuth(); const qc = useQueryClient(); const nav = useNavigate(); const census = useCensus();
  const [sp] = useSearchParams();
  const [patient, setPatient] = useState<PatientListItem | null>(planned ? { id: planned.patient_id, first_name: planned.first_name, last_name: planned.last_name, personal_number: planned.personal_number,
    birth_date: planned.birth_date, gender: planned.gender as PatientListItem['gender'], phone_number: planned.phone_number, passport_number: null } : null);
  const [f, setF] = useState({ department_id: planned?.department_id ?? sp.get('department_id') ?? '', attending_doctor_id: planned?.doctor_id ?? (can(user, 'doctor') ? user!.id : ''),
    source: planned ? 'planned' : 'emergency', referring_institution: '', chief_complaint: '', severity: '', isolation: '', bed_id: '' });
  const [icd, setIcd] = useState<IcdCode | null>(planned?.icd10_code ? { code: planned.icd10_code, title: planned.icd10_title ?? '' } as IcdCode : null);
  const [srcEnc, setSrcEnc] = useState(''); const [referral, setReferral] = useState('');
  const doctors = useQuery({ queryKey: ['doctors'], queryFn: () => api<Doctor[]>('/doctors') });
  const dep = f.department_id || census.data?.departments[0]?.id || '';
  const direct = census.data?.settings.bed_assign_mode === 'direct';
  const board = useQuery({ queryKey: ['ipd-board', dep], queryFn: () => api<Board>('/inpatient/board', { query: { department_id: dep } }), enabled: !!dep });
  // წყარო: პაციენტის ბოლო ღია ვიზიტები და ჰოსპიტალიზაციის მიმართვები
  const encs = useQuery({ queryKey: ['encounters', 'patient', patient?.id], queryFn: () => api<{ id: string; type: string; status: string; start_time: string; doctor_name: string | null }[]>('/encounters', { query: { patient_id: patient!.id } }), enabled: !!patient });
  const srcList = (encs.data ?? []).filter((e) => e.type !== 'inpatient' && e.status !== 'cancelled').slice(0, 10);
  const refs = useQuery({ queryKey: ['ipd-refs', srcEnc], queryFn: () => api<{ referrals: { id: string; type: string; status: string; reason: string }[] }>(`/encounters/${srcEnc}`), enabled: !!srcEnc });
  const hospRefs = (refs.data?.referrals ?? []).filter((r) => r.type === 'hospitalization' && ['requested', 'in_progress'].includes(r.status));
  const canBed = board.data?.can_assign || !!planned?.bed_id;
  const m = useMutation({
    mutationFn: () => withConfirm((confirm) => api<{ encounter_id: string; adm_no: string; bed: string | null }>('/inpatient/admissions', { body: {
      patient_id: patient!.id, department_id: dep, attending_doctor_id: f.attending_doctor_id, source: f.source, icd10_code: icd!.code,
      source_encounter_id: srcEnc || undefined, referral_id: referral || undefined, planned_id: planned?.id, referring_institution: f.referring_institution || undefined,
      chief_complaint: f.chief_complaint || undefined, severity: f.severity || undefined, isolation: f.isolation || undefined, bed_id: f.bed_id || undefined, confirm } })),
    onSuccess: (r) => { if (!r) return; inval(qc); onDone?.(); nav(`/inpatient/stay/${r.encounter_id}?new=1`); },
  });
  const freeBeds = (board.data?.wards ?? []).flatMap((w) => w.beds.filter((b) => b.status === 'free' && (!b.is_overflow || board.data!.settings.overflow_beds)).map((b) => ({ ...b, ward: w })));
  const body = (
    <div className="stack" style={{ gap: 14 }}>
      {!patient ? <Field label="პაციენტი" htmlFor="psearch" required><PatientSearch onSelect={setPatient} autoFocus /></Field> : (
        <div className="row card card-pad" style={{ padding: 10 }}>
          <strong className="grow">{patient.last_name} {patient.first_name} <span className="small muted">{genderShort(patient.gender)} · {age(patient.birth_date)} · {patient.personal_number}</span></strong>
          {!planned && <button className="btn sm" type="button" onClick={() => { setPatient(null); setSrcEnc(''); setReferral(''); }}>შეცვლა</button>}
        </div>)}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
        <Field label="განყოფილება" htmlFor="ad" required><select id="ad" className="select" value={dep} disabled={!!planned?.bed_id} onChange={(e) => setF({ ...f, department_id: e.target.value, bed_id: '' })}>
          {census.data?.departments.map((d) => <option key={d.id} value={d.id}>{d.name} — თავისუფალი {d.free}</option>)}</select></Field>
        <Field label="მკურნალი ექიმი" htmlFor="adr" required><select id="adr" className="select" value={f.attending_doctor_id} onChange={(e) => setF({ ...f, attending_doctor_id: e.target.value })}>
          <option value="">— აირჩიეთ —</option>{doctors.data?.map((d) => <option key={d.id} value={d.id}>{d.last_name} {d.first_name}{d.department_name ? ` · ${d.department_name}` : ''}</option>)}</select></Field>
        {!planned && <Field label="წყარო" htmlFor="as"><select id="as" className="select" value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}>
          {Object.entries(SOURCE_KA).filter(([k]) => k !== 'planned').map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>}
        {f.source === 'transfer_in' && <Field label="დაწესებულება (საიდან)" htmlFor="ari" required><input id="ari" className="input" value={f.referring_institution} onChange={(e) => setF({ ...f, referring_institution: e.target.value })} /></Field>}
        {patient && !planned && srcList.length > 0 && ['emergency', 'outpatient'].includes(f.source) && (
          <Field label="წყარო ვიზიტი" htmlFor="ase" hint="ER / ამბულატორიული ვიზიტი, საიდანაც ხდება ჰოსპიტალიზაცია"><select id="ase" className="select" value={srcEnc} onChange={(e) => { setSrcEnc(e.target.value); setReferral(''); }}>
            <option value="">— არ არის —</option>{srcList.map((e) => <option key={e.id} value={e.id}>{tsDate(e.start_time)} · {e.doctor_name ?? '—'}</option>)}</select></Field>)}
        {hospRefs.length > 0 && <Field label="ჰოსპიტალიზაციის მიმართვა" htmlFor="arf" hint="ავტომატურად დაიხურება"><select id="arf" className="select" value={referral} onChange={(e) => setReferral(e.target.value)}>
          <option value="">— არ არის —</option>{hospRefs.map((r) => <option key={r.id} value={r.id}>{r.reason.slice(0, 60)}</option>)}</select></Field>}
      </div>
      <Field label="მიმღები დიაგნოზი (ICD-10)" htmlFor="icd" required>
        {icd ? <div className="row"><span className="mono" style={{ fontWeight: 600 }}>{icd.code}</span><span className="grow">{icd.title}</span><button className="btn sm" type="button" onClick={() => setIcd(null)}>შეცვლა</button></div>
          : <IcdPicker primary={false} onPick={setIcd} />}</Field>
      <Field label="ჩივილები / მიზეზი" htmlFor="acc"><textarea id="acc" className="input" rows={2} value={f.chief_complaint} onChange={(e) => setF({ ...f, chief_complaint: e.target.value })} /></Field>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
        <Field label="მდგომარეობა" htmlFor="asv"><select id="asv" className="select" value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })}>
          <option value="">—</option>{Object.entries(SEVERITY_KA).map(([k, [, l]]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="იზოლაცია" htmlFor="ais"><select id="ais" className="select" value={f.isolation} onChange={(e) => setF({ ...f, isolation: e.target.value })}>
          <option value="">არ სჭირდება</option>{Object.entries(ISOLATION_KA).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        {planned?.bed_id ? <Field label="საწოლი" htmlFor="ab"><input id="ab" className="input mono" disabled value={`${planned.bed_code} (დაჯავშნილი)`} /></Field>
          : canBed ? <Field label="საწოლი" htmlFor="ab" hint={direct ? undefined : 'შეგიძლიათ ახლავე, ან მოგვიანებით დაფიდან'}><select id="ab" className="select" value={f.bed_id} onChange={(e) => setF({ ...f, bed_id: e.target.value })}>
            <option value="">— მოგვიანებით —</option>{freeBeds.map((b) => <option key={b.id} value={b.id}>{b.code} · {b.type_name}{b.ward.sex !== 'mixed' ? (b.ward.sex === 'male' ? ' · მამ.' : ' · ქალ.') : ''}</option>)}</select></Field>
            : <div className="small muted" style={{ alignSelf: 'end' }}>საწოლს მიანიჭებს განყოფილება (შეტყობინება მიუვა).</div>}
      </div>
      <ErrorBox error={m.error} />
      {!planned && <div className="row"><span className="grow" /><button className="btn primary lg" type="button" disabled={m.isPending || !patient || !icd || !f.attending_doctor_id || !dep || (f.source === 'transfer_in' && !f.referring_institution.trim())} onClick={() => m.mutate()}>ჰოსპიტალიზაცია</button></div>}
    </div>);
  if (planned) return (
    <Modal title={`ჰოსპიტალიზაცია — ${planned.plan_no}`} onClose={onDone!} width={720}
      footer={<><button className="btn" type="button" onClick={onDone}>გაუქმება</button><button className="btn primary" type="button" disabled={m.isPending || !icd || !f.attending_doctor_id} onClick={() => m.mutate()}>ჰოსპიტალიზაცია</button></>}>{body}</Modal>);
  return <div className="content"><section className="card card-pad" style={{ maxWidth: 900 }}>{body}</section></div>;
}

// ---------------------------------------------------------------- გეგმიური რიგი
function PlannedQueue() {
  const { user } = useAuth(); const census = useCensus(); const qc = useQueryClient(); const toast = useToast();
  const [dep, setDep] = useState(''); const [from, setFrom] = useState(''); const [to, setTo] = useState(shiftDay(todayISO(), 30));
  const q = useQuery({ queryKey: ['ipd-planned', dep, from, to], queryFn: () => api<Planned[]>('/inpatient/planned', { query: { department_id: dep, from, to } }) });
  const [add, setAdd] = useState(false); const [reserve, setReserve] = useState<Planned | null>(null); const [admit, setAdmit] = useState<Planned | null>(null); const [cancel, setCancel] = useState<Planned | null>(null);
  const release = useMutation({ mutationFn: (id: string) => api(`/inpatient/planned/${id}/release`, { body: {} }), onSuccess: () => { toast.show('დაჯავშნა მოხსნილია'); inval(qc); } });
  const rb = useQuery({ queryKey: ['ipd-board', reserve?.department_id], queryFn: () => api<Board>('/inpatient/board', { query: { department_id: reserve!.department_id } }), enabled: !!reserve });
  return (
    <div className="content">
      {toast.node}
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <select className="select" style={{ maxWidth: 260, height: 40 }} aria-label="განყოფილება" value={dep} onChange={(e) => setDep(e.target.value)}>
          <option value="">ყველა განყოფილება</option>{census.data?.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
        <label className="row small">დან <input className="input" type="date" style={{ height: 38 }} value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="row small">მდე <input className="input" type="date" style={{ height: 38 }} value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <span className="grow" />
        {can(user, ...ADMITTERS) && <button className="btn primary" type="button" onClick={() => setAdd(true)}>+ გეგმიური ჰოსპიტალიზაცია</button>}
      </div>
      <ErrorBox error={q.error ?? release.error} />
      {q.isLoading ? <Loading /> : (
        <div className="card"><table className="table">
          <thead><tr><th>თარიღი</th><th>პაციენტი</th><th>განყოფილება / ექიმი</th><th>მიზეზი</th><th>საწოლი</th><th>SMS</th><th /></tr></thead>
          <tbody>{q.data?.map((p) => (
            <tr key={p.id}>
              <td className="mono">{dateGe(p.planned_date)} {p.overdue && <span className="chip danger">ვადაგასული</span>}<div className="small muted">{p.plan_no}</div></td>
              <td><strong>{p.last_name} {p.first_name}</strong><div className="small muted">{p.personal_number} · {p.phone_number}</div></td>
              <td>{p.department_name}<div className="small muted">{p.doctor_name ?? '—'}</div></td>
              <td className="small">{p.icd10_code && <span className="mono">{p.icd10_code} </span>}{p.reason}{p.notes && <div className="muted">{p.notes}</div>}</td>
              <td>{p.bed_code ? <span className="chip info">{p.bed_code}</span> : <span className="muted">—</span>}</td>
              <td className="small">{p.sms_sent_at ? tsDate(p.sms_sent_at) : '—'}</td>
              <td className="row" style={{ gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                {!p.bed_id && <button className="btn sm" type="button" onClick={() => setReserve(p)}>დაჯავშნა</button>}
                {p.bed_id && <button className="btn sm" type="button" onClick={() => release.mutate(p.id)}>მოხსნა</button>}
                {can(user, ...ADMITTERS) && <button className="btn sm primary" type="button" onClick={() => setAdmit(p)}>მიღება</button>}
                {can(user, ...ADMITTERS) && <button className="btn sm" type="button" onClick={() => setCancel(p)}>გაუქმება</button>}
              </td>
            </tr>))}
            {!q.data?.length && <tr><td colSpan={7} className="empty">რიგი ცარიელია</td></tr>}</tbody>
        </table></div>)}
      {add && <PlannedDialog onClose={() => setAdd(false)} />}
      {reserve && rb.data && <AssignDialog plannedId={reserve.id} title={`${reserve.last_name} ${reserve.first_name}`} board={rb.data} onClose={() => setReserve(null)} />}
      {admit && <Admit planned={admit} onDone={() => setAdmit(null)} />}
      {cancel && <ReasonDialog title={`გაუქმება — ${cancel.plan_no}`} path={`/inpatient/planned/${cancel.id}/cancel`} onClose={() => setCancel(null)} />}
    </div>
  );
}

function PlannedDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient(); const census = useCensus();
  const doctors = useQuery({ queryKey: ['doctors'], queryFn: () => api<Doctor[]>('/doctors') });
  const [patient, setPatient] = useState<PatientListItem | null>(null); const [icd, setIcd] = useState<IcdCode | null>(null);
  const [f, setF] = useState({ department_id: '', doctor_id: '', planned_date: shiftDay(todayISO(), 1), reason: '', notes: '' });
  const dep = f.department_id || census.data?.departments[0]?.id || '';
  const m = useMutation({ mutationFn: () => api('/inpatient/planned', { body: { patient_id: patient!.id, department_id: dep, doctor_id: f.doctor_id || undefined, planned_date: f.planned_date,
    icd10_code: icd?.code, reason: f.reason, notes: f.notes || undefined } }), onSuccess: () => { inval(qc); onClose(); } });
  return (
    <Modal title="გეგმიური ჰოსპიტალიზაცია" onClose={onClose} width={640}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={m.isPending || !patient || f.reason.trim().length < 3 || !f.planned_date} onClick={() => m.mutate()}>რიგში ჩაწერა</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        {!patient ? <Field label="პაციენტი" htmlFor="psearch" required><PatientSearch onSelect={setPatient} autoFocus /></Field>
          : <div className="row"><strong className="grow">{patient.last_name} {patient.first_name} <span className="small muted">{patient.personal_number}</span></strong><button className="btn sm" type="button" onClick={() => setPatient(null)}>შეცვლა</button></div>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
          <Field label="თარიღი" htmlFor="pd" required><input id="pd" className="input" type="date" min={todayISO()} value={f.planned_date} onChange={(e) => setF({ ...f, planned_date: e.target.value })} /></Field>
          <Field label="განყოფილება" htmlFor="pdp" required><select id="pdp" className="select" value={dep} onChange={(e) => setF({ ...f, department_id: e.target.value })}>
            {census.data?.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
          <Field label="ექიმი" htmlFor="pdr"><select id="pdr" className="select" value={f.doctor_id} onChange={(e) => setF({ ...f, doctor_id: e.target.value })}>
            <option value="">—</option>{doctors.data?.map((d) => <option key={d.id} value={d.id}>{d.last_name} {d.first_name}</option>)}</select></Field>
        </div>
        <Field label="დიაგნოზი (ICD-10)" htmlFor="icd">{icd ? <div className="row"><span className="mono">{icd.code}</span><span className="grow">{icd.title}</span><button className="btn sm" type="button" onClick={() => setIcd(null)}>×</button></div> : <IcdPicker primary={false} onPick={setIcd} />}</Field>
        <Field label="მიზეზი / ჩარევა" htmlFor="pr" required><input id="pr" className="input" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
        <Field label="შენიშვნა" htmlFor="pn"><input id="pn" className="input" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="მაგ. უზმოზე, ანალიზები თან" /></Field>
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}

export function ReasonDialog({ title, path, danger = true, onClose, onDone }: { title: string; path: string; danger?: boolean; onClose: () => void; onDone?: () => void }) {
  const qc = useQueryClient(); const [reason, setReason] = useState('');
  const m = useMutation({ mutationFn: () => api(path, { body: { reason } }), onSuccess: () => { inval(qc); onDone?.(); onClose(); } });
  return (
    <Modal title={title} onClose={onClose} width={480}
      footer={<><button className="btn" type="button" onClick={onClose}>დახურვა</button><button className={`btn ${danger ? 'danger' : 'primary'}`} type="button" disabled={m.isPending || reason.trim().length < 3} onClick={() => m.mutate()}>დადასტურება</button></>}>
      <Field label="მიზეზი" htmlFor="rr" required><input id="rr" className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <ErrorBox error={m.error} />
    </Modal>
  );
}

// ---------------------------------------------------------------- საწოლფონდის მდგომარეობა
function Census() {
  const q = useCensus();
  const tot = (k: 'beds' | 'free' | 'occupied' | 'reserved' | 'cleaning' | 'blocked' | 'awaiting' | 'planned_today' | 'overflow' | 'occupied_overflow') => (q.data?.departments ?? []).reduce((s, d) => s + d[k], 0);
  const pct = (o: number, b: number) => (b ? `${Math.round((o / b) * 100)}%` : '—');
  return (
    <div className="content">
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : (
        <div className="card"><table className="table">
          <thead><tr><th>განყოფილება</th><th className="num">საწოლი</th><th className="num">დაკავებული</th><th className="num">დატვირთვა</th><th className="num">თავისუფალი</th><th className="num">დაჯავშნილი</th>
            <th className="num">დასალაგებელი</th><th className="num">დაბლოკილი</th><th className="num">ელოდება საწოლს</th><th className="num">გეგმიური დღეს</th></tr></thead>
          <tbody>{q.data?.departments.map((d) => (
            <tr key={d.id}><td><Link to={`/inpatient?tab=board&department_id=${d.id}`}><strong>{d.name}</strong></Link></td>
              <td className="num">{d.beds}{d.overflow ? <span className="small muted"> +{d.overflow}</span> : ''}</td>
              <td className="num">{d.occupied}{d.occupied_overflow ? <span className="small muted"> ({d.occupied_overflow} დამატ.)</span> : ''}</td>
              <td className="num">{pct(d.occupied - d.occupied_overflow, d.beds)}</td><td className="num">{d.free}</td><td className="num">{d.reserved}</td>
              <td className="num">{d.cleaning}</td><td className="num">{d.blocked}</td>
              <td className="num">{d.awaiting ? <span className="chip warn">{d.awaiting}</span> : 0}</td><td className="num">{d.planned_today}</td></tr>))}
            <tr><td><strong>სულ</strong></td><td className="num"><strong>{tot('beds')}</strong></td><td className="num"><strong>{tot('occupied')}</strong></td><td className="num"><strong>{pct(tot('occupied') - tot('occupied_overflow'), tot('beds'))}</strong></td>
              <td className="num">{tot('free')}</td><td className="num">{tot('reserved')}</td><td className="num">{tot('cleaning')}</td><td className="num">{tot('blocked')}</td><td className="num">{tot('awaiting')}</td><td className="num">{tot('planned_today')}</td></tr>
          </tbody>
        </table></div>)}
      <span className="small muted">დატვირთვა — ძირითადი საწოლების მიხედვით (დამატებითი საწოლები ცალკე).</span>
    </div>
  );
}

export const openWristband = (encounterId: string) => openBlob(`/inpatient/stays/${encounterId}/wristband.pdf`);
