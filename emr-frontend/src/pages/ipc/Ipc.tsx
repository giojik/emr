import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, can } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import PatientSearch from '../../components/PatientSearch';
import { ErrorBox, Field, Loading, Modal, useDebounced } from '../../components/ui';
import { age, genderShort, tsDate } from '../../lib/format';
import { useModuleEnabled, useModules } from '../../lib/modules';
import IpcCatalogTab from './Catalog';
import { DeviceDays, HaiList, Signals } from './Surveillance';
import SsiTab from './Ssi';
import { FLAG_ST, IPC_ANY, IPC_FULL, ISO_KA, ONSET_KA, SOURCE_KA, useIpcCatalog, type FlagRow, type IpcPatientRow } from './types';
import type { PatientListItem } from '../../api/types';

type Tab = 'patients' | 'flags' | 'signals' | 'hai' | 'ssi' | 'rates' | 'catalog';

/** ინფექციის კონტროლი (0067): პაციენტები (იზოლაცია / MDRO), MDRO ფლაგები, ცნობარები; 0068: სიგნალები, HAI შემთხვევები, device-days მაჩვენებლები */
export default function Ipc() {
  const { user } = useAuth();
  const [sp] = useSearchParams();
  const mods = useModules(); const enabled = useModuleEnabled('ipc');
  const ipcSet = mods.data?.find((m) => m.code === 'ipc')?.settings as { ssi_surveillance?: boolean } | undefined;
  const full = can(user, ...IPC_FULL);
  const pending = useQuery({ queryKey: ['ipc-flags', 'pending'], queryFn: () => api<FlagRow[]>('/ipc/flags', { query: { review: 'pending' } }), enabled: enabled && full, refetchInterval: 60_000 });
  const openSig = useQuery({ queryKey: ['ipc-signals', 'open', ''], queryFn: () => api<unknown[]>('/ipc/signals', { query: { status: 'open', kind: '' } }), enabled: enabled && can(user, ...IPC_ANY), refetchInterval: 60_000 });
  if (mods.isLoading) return <div className="content"><Loading /></div>;
  if (!enabled) return <div className="content"><div className="alert warn">მოდული „ინფექციის კონტროლი“ გამორთულია (ადმინისტრირება → მოდულები).</div></div>;
  if (!can(user, ...IPC_ANY)) return <div className="content"><div className="alert warn">ინფექციის კონტროლის გვერდზე წვდომა არ გაქვთ.</div></div>;
  const tabs: [Tab, string, boolean, number][] = [
    ['patients', 'პაციენტები', true, 0],
    ['flags', 'MDRO ფლაგები', true, pending.data?.length ?? 0],
    ['signals', 'სიგნალები', true, openSig.data?.length ?? 0],
    ['hai', 'HAI შემთხვევები', true, 0],
    ['ssi', 'SSI', !!ipcSet?.ssi_surveillance, 0],
    ['rates', 'მაჩვენებლები', true, 0],
    ['catalog', 'ცნობარები', full, 0],
  ];
  const allowed = tabs.filter((t) => t[2]);
  const cur = (allowed.find((t) => t[0] === sp.get('tab'))?.[0] ?? 'patients') as Tab;
  return (
    <>
      <header className="topbar" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8, paddingBottom: 0 }}>
        <div className="row"><h1 className="grow">ინფექციის კონტროლი</h1></div>
        <nav aria-label="ინფექციის კონტროლი" className="row" style={{ gap: 2, flexWrap: 'wrap' }}>
          {allowed.map(([k, l, , n]) => <Link key={k} to={`/ipc?tab=${k}`} className={`admin-tab${cur === k ? ' active' : ''}`} aria-current={cur === k ? 'page' : undefined}>
            {l}{n > 0 && <span className="chip danger" style={{ marginLeft: 6, height: 20 }} title="დასადასტურებელი / გადასახედი">{n}</span>}</Link>)}
        </nav>
      </header>
      {cur === 'patients' && <Patients />}
      {cur === 'flags' && <Flags />}
      {cur === 'signals' && <Signals />}
      {cur === 'hai' && <HaiList />}
      {cur === 'ssi' && <SsiTab />}
      {cur === 'rates' && <DeviceDays />}
      {cur === 'catalog' && <IpcCatalogTab />}
    </>
  );
}

function IsoChip({ type }: { type: string }) {
  const cat = useIpcCatalog();
  const t = cat.data?.isolation_types.find((x) => x.code === type);
  return <span className="chip" style={t ? { background: t.color, color: '#fff', borderColor: t.color } : undefined} title={ISO_KA[type]}>{t?.short_name ?? ISO_KA[type]}</span>;
}

function Patients() {
  const nav = useNavigate();
  const [dept, setDept] = useState('');
  const [only, setOnly] = useState<'all' | 'missing' | 'shared'>('all');
  const depts = useQuery({ queryKey: ['departments'], queryFn: () => api<{ id: string; name: string; type: string }[]>('/departments'), staleTime: 5 * 60_000 });
  const q = useQuery({ queryKey: ['ipc-patients', dept], queryFn: () => api<IpcPatientRow[]>('/ipc/patients', { query: { department_id: dept } }), refetchInterval: 60_000 });
  const rows = (q.data ?? []).filter((r) => only === 'all' || (only === 'missing' ? r.missing_isolation.length > 0 : r.shared_ward));
  const n = (f: (r: IpcPatientRow) => boolean) => (q.data ?? []).filter(f).length;
  return (
    <div className="content">
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <Kpi label="იზოლაციაში" v={n((r) => r.isolations.length > 0)} />
        <Kpi label="MDRO ფლაგით (სტაციონარი)" v={n((r) => r.flags.some((f) => f.status === 'active'))} />
        <Kpi label="ფლაგი — იზოლაციის გარეშე" v={n((r) => r.missing_isolation.length > 0)} tone="danger" />
        <Kpi label="საერთო პალატაში" v={n((r) => r.shared_ward)} tone="warn" />
      </div>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <div className="seg" role="group" aria-label="ფილტრი">{([['all', 'ყველა'], ['missing', 'იზოლაცია აკლია'], ['shared', 'საერთო პალატა']] as const).map(([k, l]) =>
          <button key={k} type="button" aria-pressed={only === k} onClick={() => setOnly(k)}>{l}</button>)}</div>
        <select className="select" style={{ maxWidth: 240, height: 38 }} aria-label="განყოფილება" value={dept} onChange={(e) => setDept(e.target.value)}>
          <option value="">ყველა განყოფილება</option>{depts.data?.filter((d) => d.type === 'inpatient').map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
      </div>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead><tr><th>პაციენტი</th><th>განყოფილება / საწოლი</th><th>დღე</th><th>იზოლაცია</th><th>MDRO</th><th>შენიშვნა</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.encounter_id} className="clickable" onClick={() => nav(`/inpatient/stay/${r.encounter_id}#isolation`)}>
                <td><strong>{r.last_name} {r.first_name}</strong><div className="small muted">{genderShort(r.gender)} · {age(r.birth_date)} · <span className="mono">{r.adm_no}</span></div></td>
                <td className="small">{r.department}<div className="mono">{r.bed_code ?? 'საწოლის გარეშე'}{r.ward_code ? ` (პალ. ${r.ward_code}${r.isolation_capable ? ', იზოლატორი' : ''})` : ''}</div></td>
                <td className="mono">{r.day}</td>
                <td><div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>{r.isolations.map((i) => <IsoChip key={i.id} type={i.type} />)}{!r.isolations.length && <span className="muted">—</span>}</div></td>
                <td><div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>{r.flags.map((f) => <span key={f.id} className={`chip ${f.status === 'active' ? 'danger' : 'warn'}`}
                  title={`${FLAG_ST[f.status][1]}${f.onset ? ` · ${ONSET_KA[f.onset]}` : ''}`}>{f.mdro_code.toUpperCase()}{f.status === 'suggested' ? ' ?' : ''}{f.onset === 'hospital' ? ' (ჰოსპ.)' : ''}</span>)}</div></td>
                <td className="small">{r.missing_isolation.length > 0 && <span className="chip danger">აკლია: {r.missing_isolation.map((t) => ISO_KA[t]).join(', ')}</span>}
                  {r.shared_ward && <span className="chip warn" title={`პალატაში კიდევ ${r.ward_others}`}>საერთო პალატა (+{r.ward_others})</span>}</td>
              </tr>))}
              {!rows.length && <tr><td colSpan={6} className="muted">პაციენტი არ არის</td></tr>}
            </tbody>
          </table>
        </div>)}
    </div>
  );
}

function Flags() {
  const { user } = useAuth(); const nav = useNavigate();
  const full = can(user, ...IPC_FULL);
  const cat = useIpcCatalog();
  const [preset, setPreset] = useState<'pending' | 'open' | 'closed' | 'all'>(full ? 'pending' : 'open');
  const [code, setCode] = useState(''); const [search, setSearch] = useState(''); const ds = useDebounced(search.trim(), 300);
  const [add, setAdd] = useState(false);
  const query = { mdro_code: code, q: ds, ...(preset === 'pending' && { review: 'pending' }), ...(preset === 'closed' && { status: 'cleared,dismissed' }), ...(preset === 'all' && { status: 'all' }) };
  const q = useQuery({ queryKey: ['ipc-flags', query], queryFn: () => api<FlagRow[]>('/ipc/flags', { query }) });
  return (
    <div className="content">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <div className="seg" role="group" aria-label="სტატუსი">{([['pending', 'გადასახედი', full], ['open', 'აქტიური', true], ['closed', 'მოხსნილი / გაუქმებული', true], ['all', 'ყველა', true]] as const)
          .filter((x) => x[2]).map(([k, l]) => <button key={k} type="button" aria-pressed={preset === k} onClick={() => setPreset(k)}>{l}</button>)}</div>
        <select className="select" style={{ maxWidth: 260, height: 38 }} aria-label="MDRO" value={code} onChange={(e) => setCode(e.target.value)}>
          <option value="">ყველა MDRO</option>{cat.data?.mdro_types.map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}</select>
        <input className="input" style={{ maxWidth: 220, height: 38 }} aria-label="ძებნა" placeholder="პაციენტი, პირადი №" value={search} onChange={(e) => setSearch(e.target.value)} />
        <span className="grow" />
        {full && <button className="btn primary" type="button" onClick={() => setAdd(true)}>+ ფლაგი (ხელით / გარე პასუხი)</button>}
      </div>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead><tr><th>პაციენტი</th><th>MDRO</th><th>აღმოჩენა</th><th>წყარო / შეძენა</th><th>ახლა</th><th>სტატუსი</th></tr></thead>
            <tbody>{q.data?.map((r) => (
              <tr key={r.id} className="clickable" onClick={() => nav(`/ipc/flags/${r.id}`)}>
                <td><strong>{r.last_name} {r.first_name}</strong><div className="small muted mono">{r.personal_number}</div></td>
                <td><span className="chip danger">{r.mdro_code.toUpperCase()}</span><div className="small muted">{r.mdro_name}</div></td>
                <td className="small"><span className="mono">{tsDate(r.specimen_at ?? r.detected_at)}</span>{r.detections > 1 && <div className="muted">განმეორებით: {r.detections}</div>}</td>
                <td className="small">{SOURCE_KA[r.source]}<div className="muted">{r.onset ? ONSET_KA[r.onset] : '—'}</div></td>
                <td className="small">{r.adm_no ? <>{r.department} · <span className="mono">{r.bed_code ?? '—'}</span>{!r.isolated && r.status === 'active' && <div><span className="chip danger">იზოლაციის გარეშე</span></div>}</> : <span className="muted">არ წევს</span>}</td>
                <td><span className={`chip ${FLAG_ST[r.status][0]}`}>{FLAG_ST[r.status][1]}</span>{!r.reviewed_at && r.status === 'active' && <span className="chip warn" style={{ marginLeft: 4 }}>გადასახედი</span>}</td>
              </tr>))}
              {!q.data?.length && <tr><td colSpan={6} className="muted">ფლაგი არ არის</td></tr>}
            </tbody>
          </table>
        </div>)}
      {add && <AddFlag onClose={() => setAdd(false)} onDone={(id) => nav(`/ipc/flags/${id}`)} />}
    </div>
  );
}

function AddFlag({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const qc = useQueryClient();
  const cat = useIpcCatalog();
  const [p, setP] = useState<PatientListItem | null>(null);
  const [f, setF] = useState({ mdro_code: '', source: 'external', specimen_at: '', onset: 'unknown', note: '' });
  const m = useMutation({ mutationFn: () => api<{ id: string }>('/ipc/flags', { body: { patient_id: p!.id, mdro_code: f.mdro_code, source: f.source,
    specimen_at: f.specimen_at ? new Date(f.specimen_at).toISOString() : undefined, onset: f.onset, note: f.note.trim() || undefined } }),
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ['ipc-flags'] }); onDone(r.id); } });
  return (
    <Modal title="MDRO ფლაგი — ხელით / გარე ლაბორატორიის პასუხით" onClose={onClose} width={620} footer={<>
      <button className="btn" type="button" onClick={onClose}>გაუქმება</button>
      <button className="btn primary" type="button" disabled={!p || !f.mdro_code || m.isPending} onClick={() => m.mutate()}>დამატება</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <ErrorBox error={m.error} />
        {!p ? <Field label="პაციენტი" htmlFor="fp" required><PatientSearch onSelect={setP} autoFocus /></Field>
          : <div className="row card card-pad" style={{ padding: 10 }}><strong className="grow">{p.last_name} {p.first_name} <span className="small muted">{p.personal_number}</span></strong>
            <button className="btn sm" type="button" onClick={() => setP(null)}>შეცვლა</button></div>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
          <Field label="MDRO" htmlFor="fm" required><select id="fm" className="select" value={f.mdro_code} onChange={(e) => setF({ ...f, mdro_code: e.target.value })}>
            <option value="">— აირჩიეთ —</option>{cat.data?.mdro_types.filter((t) => t.is_active).map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}</select></Field>
          <Field label="წყარო" htmlFor="fs"><select id="fs" className="select" value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}>
            <option value="external">გარე ლაბორატორია</option><option value="manual">ხელით (სხვა)</option></select></Field>
          <Field label="ნიმუშის / პასუხის თარიღი" htmlFor="fd"><input id="fd" type="datetime-local" className="input" value={f.specimen_at} onChange={(e) => setF({ ...f, specimen_at: e.target.value })} /></Field>
          <Field label="შეძენის ადგილი" htmlFor="fo"><select id="fo" className="select" value={f.onset} onChange={(e) => setF({ ...f, onset: e.target.value })}>
            {Object.entries(ONSET_KA).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        </div>
        <Field label="შენიშვნა" htmlFor="fn"><textarea id="fn" className="textarea" rows={2} value={f.note} maxLength={1000} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

function Kpi({ label, v, tone = '' }: { label: string; v: number; tone?: string }) {
  return (
    <div className="card card-pad stack" style={{ gap: 2, minWidth: 170 }}>
      <span className="small muted">{label}</span>
      <strong style={{ fontSize: 22, color: v && tone === 'danger' ? 'var(--danger)' : v && tone === 'warn' ? 'var(--warn-ink)' : undefined }}>{v}</strong>
    </div>
  );
}
