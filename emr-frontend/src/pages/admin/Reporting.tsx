import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, can } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Field, Loading, Modal, useToast } from '../../components/ui';
import { useModuleEnabled } from '../../lib/modules';
import { CATEGORY_KA, DIR_KA, fmtTime, fmtVal, shiftDays, UNIT_FULL } from '../reporting/types';

interface Target { department_id: string | null; department_name: string | null; target: number; warn: number | null; note: string | null }
interface KpiCfg { code: string; category: string; name: string; unit: string; unit_ka: string; direction: 'up' | 'down' | 'none'; definition: string; formula: string; source: string;
  finance: boolean; snapshot: boolean; drill: string | null; is_active: boolean; sort_order: number; targets: Target[] }
interface ScopeUser { id: string; name: string; email: string; all: boolean; phi: boolean; primary_department: { id: string; name: string } | null; departments: { id: string; name: string }[];
  effective: { id: string; name: string }[] | null }
interface Run { id: string; kind: string; date_from: string; date_to: string; status: string; facts: Record<string, number> | null; error: string | null; source: string; started_at: string;
  finished_at: string | null; duration_ms: number | null; requested_by: string | null }
interface Dept { id: string; name: string; is_active: boolean }

type Tab = 'kpis' | 'dash' | 'scopes' | 'runs';
const KIND_KA: Record<string, string> = { today: 'დღევანდელი', nightly: 'ღამის', manual: 'ხელით' };
const RUN_STATUS: Record<string, [string, string]> = { ok: ['ok', 'შესრულდა'], running: ['warn', 'მიმდინარე'], error: ['danger', 'შეცდომა'], skipped: ['', 'გამოტოვდა'] };

/** ადმინისტრირება → რეპორტინგი (0060): KPI ცნობარი და სამიზნეები, ხედვის არე, გადათვლა */
export default function ReportingAdmin() {
  const { user } = useAuth();
  const enabled = useModuleEnabled('reporting');
  const isAdmin = can(user, 'admin');
  const [tab, setTab] = useState<Tab>('kpis');
  const tabs: [Tab, string][] = [['kpis', 'KPI ცნობარი და სამიზნეები'], ['dash', 'დაფები'], ...(isAdmin ? [['scopes', 'ხედვის არე'] as [Tab, string]] : []), ['runs', 'გადათვლა']];
  const st = { background: 'none', borderTop: 0, borderLeft: 0, borderRight: 0, font: 'inherit', cursor: 'pointer' } as const;
  return (
    <div className="content">
      {!enabled && <div className="alert warn">მოდული „მენეჯერული რეპორტინგი“ გამორთულია (ადმინისტრირება → მოდულები) — პარამეტრები შეინახება, მაგრამ დაფა და გადათვლა არ მუშაობს.</div>}
      <nav className="row" style={{ gap: 2 }} aria-label="რეპორტინგი">
        {tabs.map(([k, l]) => <button key={k} type="button" className={`admin-tab${tab === k ? ' active' : ''}`} style={st} onClick={() => setTab(k)}>{l}</button>)}
      </nav>
      {tab === 'kpis' ? <Kpis /> : tab === 'dash' ? <Dashboards /> : tab === 'scopes' ? <Scopes /> : <Runs canRefresh={isAdmin} />}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- KPI
function Kpis() {
  const q = useQuery({ queryKey: ['rpt-kpis'], queryFn: () => api<KpiCfg[]>('/reporting/kpis') });
  const [edit, setEdit] = useState<KpiCfg | null>(null); const [tgt, setTgt] = useState<KpiCfg | null>(null);
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data) return <Loading />;
  const cats = [...new Set(q.data.map((k) => k.category))];
  return (
    <>
      <p className="hint" style={{ margin: 0 }}>გამოთვლის წესი კოდშია და არ იცვლება; აქ იცვლება სახელი, განმარტება, ჩვენება, რიგი და სამიზნეები (კლინიკის ან განყოფილების). სამიზნე: მწვანე — შესრულებულია,
        ყვითელი — გაფრთხილების ზღვრამდე, წითელი — ზღვარს მიღმა.</p>
      {cats.map((c) => (
        <section key={c} className="card" style={{ overflowX: 'auto', flexShrink: 0 }}>
          <div className="card-pad" style={{ paddingBottom: 0 }}><strong>{CATEGORY_KA[c] ?? c}</strong></div>
          <table className="table">
            <thead><tr><th>კოდი</th><th>მაჩვენებელი</th><th>ერთეული</th><th>მიმართულება</th><th>სამიზნე (კლინიკა)</th><th>განყოფილებები</th><th>ჩანს</th><th /></tr></thead>
            <tbody>{q.data.filter((k) => k.category === c).map((k) => {
              const clinic = k.targets.find((t) => !t.department_id); const deps = k.targets.filter((t) => t.department_id);
              return (
                <tr key={k.code} style={{ opacity: k.is_active ? 1 : 0.55 }}>
                  <td className="mono small">{k.code}</td>
                  <td><strong>{k.name}</strong>{k.finance && <span className="chip" style={{ marginLeft: 6, height: 18 }}>ფინანსური</span>}{k.snapshot && <span className="chip" style={{ marginLeft: 6, height: 18 }}>მომენტალური</span>}
                    <div className="small muted" style={{ maxWidth: 420 }}>{k.formula}</div></td>
                  <td className="small">{UNIT_FULL[k.unit]}</td><td className="small">{DIR_KA[k.direction]}</td>
                  <td className="mono small">{clinic ? <>{fmtVal(clinic.target, k.unit)}{clinic.warn !== null && <span className="muted"> / {fmtVal(clinic.warn, k.unit)}</span>}</> : '—'}</td>
                  <td className="small">{deps.length ? `${deps.length} განყ.` : '—'}</td>
                  <td>{k.is_active ? 'კი' : 'არა'}</td>
                  <td className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                    <button className="btn sm" type="button" onClick={() => setEdit(k)}>რედაქტირება</button>
                    <button className="btn sm" type="button" disabled={k.direction === 'none'} title={k.direction === 'none' ? 'მიმართულების გარეშე მაჩვენებელს სამიზნე არ აქვს' : undefined} onClick={() => setTgt(k)}>სამიზნე</button>
                  </td>
                </tr>);
            })}</tbody>
          </table>
        </section>))}
      {edit && <KpiEdit k={edit} onClose={() => setEdit(null)} />}
      {tgt && <TargetsEdit k={tgt} onClose={() => setTgt(null)} />}
    </>
  );
}

function KpiEdit({ k, onClose }: { k: KpiCfg; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(k.name); const [def, setDef] = useState(k.definition); const [active, setActive] = useState(k.is_active);
  const [sort, setSort] = useState(k.sort_order); const [reason, setReason] = useState('');
  const m = useMutation({
    mutationFn: () => api(`/reporting/kpis/${k.code}`, { method: 'PATCH', body: { name, definition: def, is_active: active, sort_order: sort, reason } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['rpt-kpis'] }); void qc.invalidateQueries({ queryKey: ['rpt-meta'] }); onClose(); },
  });
  return (
    <Modal title={`KPI: ${k.code}`} onClose={onClose} width={640}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={m.isPending || reason.trim().length < 3} onClick={() => m.mutate()}>შენახვა</button></>}>
      <div className="stack">
        <Field label="სახელი" htmlFor="k-name" required><input id="k-name" className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="განმარტება" htmlFor="k-def" required><textarea id="k-def" className="input" rows={3} value={def} onChange={(e) => setDef(e.target.value)} /></Field>
        <div className="small"><span className="muted">გამოთვლა: </span>{k.formula}<br /><span className="muted">წყარო: </span><span className="mono">{k.source}</span></div>
        <div className="row" style={{ gap: 16 }}>
          <label className="row small"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> ჩანს დაფაზე</label>
          <label className="row small">რიგი <input className="input mono" type="number" style={{ width: 90, height: 34 }} value={sort} onChange={(e) => setSort(Number(e.target.value))} /></label>
        </div>
        <Field label="მიზეზი" htmlFor="k-reason" required hint="აუდიტში ჩაიწერება"><input id="k-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}

function TargetsEdit({ k, onClose }: { k: KpiCfg; onClose: () => void }) {
  const qc = useQueryClient();
  const deps = useQuery({ queryKey: ['departments'], queryFn: () => api<Dept[]>('/departments') });
  type Row = { department_id: string; target: string; warn: string; note: string };
  const [rows, setRows] = useState<Row[]>(k.targets.map((t) => ({ department_id: t.department_id ?? '', target: String(t.target), warn: t.warn === null ? '' : String(t.warn), note: t.note ?? '' })));
  const [reason, setReason] = useState('');
  const set = (i: number, p: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const m = useMutation({
    mutationFn: () => api(`/reporting/kpis/${k.code}/targets`, { method: 'PUT', body: { reason,
      targets: rows.filter((r) => r.target !== '').map((r) => ({ department_id: r.department_id || null, target: Number(r.target), warn: r.warn === '' ? null : Number(r.warn), note: r.note || null })) } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['rpt-kpis'] }); void qc.invalidateQueries({ queryKey: ['rpt-overview'] }); onClose(); },
  });
  return (
    <Modal title={`სამიზნე: ${k.name}`} onClose={onClose} width={760}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={m.isPending || reason.trim().length < 3} onClick={() => m.mutate()}>შენახვა</button></>}>
      <div className="stack">
        <p className="hint" style={{ margin: 0 }}>{DIR_KA[k.direction]} · ერთეული: {UNIT_FULL[k.unit]}. გაფრთხილების ზღვარი {k.direction === 'up' ? 'სამიზნეზე ნაკლები' : 'სამიზნეზე მეტი'} უნდა იყოს.
          განყოფილების სამიზნე ცვლის კლინიკისას, როცა დაფაზე ერთი განყოფილებაა არჩეული.</p>
        <table className="table">
          <thead><tr><th>სად</th><th>სამიზნე</th><th>გაფრთხილება</th><th>შენიშვნა</th><th /></tr></thead>
          <tbody>{rows.map((r, i) => (
            <tr key={i}>
              <td><select className="select" style={{ height: 34 }} value={r.department_id} onChange={(e) => set(i, { department_id: e.target.value })}>
                <option value="">მთელი კლინიკა</option>{deps.data?.filter((d) => d.is_active).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></td>
              <td><input className="input mono" type="number" step="0.01" style={{ width: 110, height: 34 }} value={r.target} onChange={(e) => set(i, { target: e.target.value })} /></td>
              <td><input className="input mono" type="number" step="0.01" style={{ width: 110, height: 34 }} value={r.warn} onChange={(e) => set(i, { warn: e.target.value })} /></td>
              <td><input className="input" style={{ height: 34 }} value={r.note} onChange={(e) => set(i, { note: e.target.value })} /></td>
              <td><button className="btn sm" type="button" onClick={() => setRows(rows.filter((_, j) => j !== i))}>წაშლა</button></td>
            </tr>))}
            {!rows.length && <tr><td colSpan={5} className="muted">სამიზნე არ არის</td></tr>}</tbody>
        </table>
        <div><button className="btn sm" type="button" onClick={() => setRows([...rows, { department_id: rows.some((r) => !r.department_id) ? (deps.data?.[0]?.id ?? '') : '', target: '', warn: '', note: '' }])}>+ სამიზნე</button></div>
        <Field label="მიზეზი" htmlFor="t-reason" required><input id="t-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------- დაფები (0061)
const DASH_KA: Record<string, string> = { executive: 'ხელმძღვანელობა', department: 'განყოფილება' };
function Dashboards() {
  const q = useQuery({ queryKey: ['rpt-dashboards'], queryFn: () => api<Record<string, { code: string; name: string; finance: boolean; is_active: boolean }[]>>('/reporting/dashboards') });
  const kpis = useQuery({ queryKey: ['rpt-kpis'], queryFn: () => api<KpiCfg[]>('/reporting/kpis') });
  if (q.error || kpis.error) return <ErrorBox error={q.error ?? kpis.error} />;
  if (!q.data || !kpis.data) return <Loading />;
  return (
    <>
      <p className="hint" style={{ margin: 0 }}>ზედა ზოლის ძირითადი KPI-ები (მაქს. 8, რიგით). ფინანსური მაჩვენებელი ჩანს მხოლოდ მათ, ვისაც ფინანსების ხედვა აქვს; დამალული KPI დაფაზე არ ჩანს.</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: 12, alignItems: 'start' }}>
        {Object.keys(DASH_KA).map((d) => <DashEdit key={`${d}-${q.dataUpdatedAt}`} dash={d} cur={q.data[d] ?? []} all={kpis.data} />)}
      </div>
    </>
  );
}
function DashEdit({ dash, cur, all }: { dash: string; cur: { code: string }[]; all: KpiCfg[] }) {
  const qc = useQueryClient(); const toast = useToast();
  const [list, setList] = useState(cur.map((x) => x.code)); const [reason, setReason] = useState(''); const [add, setAdd] = useState('');
  const dirty = list.join() !== cur.map((x) => x.code).join();
  const m = useMutation({
    mutationFn: () => api(`/reporting/dashboards/${dash}`, { method: 'PUT', body: { kpi_codes: list, reason } }),
    onSuccess: () => { setReason(''); toast.show('შენახულია'); void qc.invalidateQueries({ queryKey: ['rpt-dashboards'] }); void qc.invalidateQueries({ queryKey: ['rpt-headline'] }); },
  });
  const k = (c: string) => all.find((x) => x.code === c);
  const move = (i: number, d: number) => { const a = [...list]; [a[i], a[i + d]] = [a[i + d], a[i]]; setList(a); };
  return (
    <section className="card card-pad stack" style={{ gap: 8 }}>
      {toast.node}
      <strong>{DASH_KA[dash]}</strong>
      <ol className="stack" style={{ gap: 4, margin: 0, paddingLeft: 20 }}>
        {list.map((c, i) => (
          <li key={c}><span className="row" style={{ gap: 6 }}>
            <span className="grow">{k(c)?.name ?? c}{k(c)?.finance && <span className="chip" style={{ marginLeft: 6, height: 18 }}>ფინანსური</span>}{k(c) && !k(c)!.is_active && <span className="chip warn" style={{ marginLeft: 6, height: 18 }}>დამალული</span>}</span>
            <button className="btn sm" type="button" disabled={i === 0} aria-label="ზემოთ" onClick={() => move(i, -1)}>↑</button>
            <button className="btn sm" type="button" disabled={i === list.length - 1} aria-label="ქვემოთ" onClick={() => move(i, 1)}>↓</button>
            <button className="btn sm" type="button" disabled={list.length <= 1} onClick={() => setList(list.filter((x) => x !== c))}>წაშლა</button>
          </span></li>))}
      </ol>
      {list.length < 8 && (
        <div className="row" style={{ gap: 6 }}>
          <select className="select grow" style={{ height: 34 }} value={add} onChange={(e) => setAdd(e.target.value)} aria-label="KPI-ის დამატება">
            <option value="">+ KPI-ის დამატება…</option>
            {all.filter((x) => !list.includes(x.code)).map((x) => <option key={x.code} value={x.code}>{CATEGORY_KA[x.category] ?? x.category} · {x.name}</option>)}
          </select>
          <button className="btn sm" type="button" disabled={!add} onClick={() => { setList([...list, add]); setAdd(''); }}>დამატება</button>
        </div>)}
      {dirty && <div className="row" style={{ gap: 6 }}>
        <input className="input grow" style={{ height: 34 }} placeholder="მიზეზი (სავალდებულო)" aria-label="მიზეზი" value={reason} onChange={(e) => setReason(e.target.value)} />
        <button className="btn" type="button" onClick={() => setList(cur.map((x) => x.code))}>გაუქმება</button>
        <button className="btn primary" type="button" disabled={m.isPending || reason.trim().length < 3} onClick={() => m.mutate()}>შენახვა</button></div>}
      <ErrorBox error={m.error} />
    </section>
  );
}

// ---------------------------------------------------------------------------------------------- ხედვის არე
function Scopes() {
  const q = useQuery({ queryKey: ['rpt-scopes'], queryFn: () => api<ScopeUser[]>('/reporting/scopes') });
  const [edit, setEdit] = useState<ScopeUser | null>(null);
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data) return <Loading />;
  return (
    <>
      <p className="hint" style={{ margin: 0 }}>„მენეჯერული დაფა (განყოფილება)“ და მენეჯერი ხედავს თავის განყოფილებას (მომხმარებლის ბარათიდან) და აქ დამატებულ განყოფილებებს.
        „მთელი კლინიკა“, ხელმძღვანელობა და ადმინისტრატორი — ყველაფერს. პაციენტის მონაცემი ჩაღრმავებაში — „რეპორტების პერსონალური მონაცემები“, ექიმი ან ექთანი.</p>
      <section className="card" style={{ overflowX: 'auto' }}>
        <table className="table">
          <thead><tr><th>მომხმარებელი</th><th>ხედვა</th><th>ძირითადი განყოფილება</th><th>დამატებითი</th><th>პაციენტის მონაცემი</th><th /></tr></thead>
          <tbody>{q.data.map((u) => (
            <tr key={u.id}>
              <td><strong>{u.name}</strong><div className="small muted">{u.email}</div></td>
              <td>{u.all ? <span className="chip ok">მთელი კლინიკა</span> : u.effective?.length ? <span className="chip">{u.effective.length} განყ.</span> : <span className="chip warn">განყოფილება არ აქვს</span>}</td>
              <td className="small">{u.primary_department?.name ?? '—'}</td>
              <td className="small">{u.departments.map((d) => d.name).join(', ') || '—'}</td>
              <td className="small">{u.phi ? 'სრული' : 'ინიციალები'}</td>
              <td>{!u.all && <button className="btn sm" type="button" onClick={() => setEdit(u)}>განყოფილებები</button>}</td>
            </tr>))}
            {!q.data.length && <tr><td colSpan={6} className="muted">დაფის უფლების მქონე მომხმარებელი არ არის</td></tr>}</tbody>
        </table>
      </section>
      {edit && <ScopeEdit u={edit} onClose={() => setEdit(null)} />}
    </>
  );
}

function ScopeEdit({ u, onClose }: { u: ScopeUser; onClose: () => void }) {
  const qc = useQueryClient();
  const deps = useQuery({ queryKey: ['departments'], queryFn: () => api<Dept[]>('/departments') });
  const [sel, setSel] = useState<string[]>(u.departments.map((d) => d.id)); const [reason, setReason] = useState('');
  const m = useMutation({
    mutationFn: () => api(`/reporting/scopes/${u.id}`, { method: 'PUT', body: { department_ids: sel, reason } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['rpt-scopes'] }); onClose(); },
  });
  return (
    <Modal title={`ხედვის არე: ${u.name}`} onClose={onClose} width={560}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={m.isPending || reason.trim().length < 3} onClick={() => m.mutate()}>შენახვა</button></>}>
      <div className="stack">
        {u.primary_department && <p className="small" style={{ margin: 0 }}>ძირითადი: <strong>{u.primary_department.name}</strong> (ყოველთვის შედის)</p>}
        {!deps.data ? <Loading /> : (
          <div className="stack" style={{ gap: 4, maxHeight: 320, overflowY: 'auto' }}>
            {deps.data.filter((d) => d.is_active && d.id !== u.primary_department?.id).map((d) => (
              <label key={d.id} className="row small"><input type="checkbox" checked={sel.includes(d.id)} onChange={(e) => setSel(e.target.checked ? [...sel, d.id] : sel.filter((x) => x !== d.id))} /> {d.name}</label>))}
          </div>)}
        <Field label="მიზეზი" htmlFor="s-reason" required><input id="s-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------- გადათვლა
function Runs({ canRefresh }: { canRefresh: boolean }) {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['rpt-runs'], queryFn: () => api<{ running: { id: string } | null; rows: Run[] }>('/reporting/runs', { query: { limit: 50 } }),
    refetchInterval: (x) => (x.state.data?.running ? 2000 : 30_000) });
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(shiftDays(today, -90)); const [to, setTo] = useState(today);
  const m = useMutation({
    mutationFn: () => api<{ run_id: number }>('/reporting/refresh', { body: { from, to } }),
    onSuccess: (r) => { toast.show(`გადათვლა #${r.run_id} დაიწყო`); void qc.invalidateQueries({ queryKey: ['rpt-runs'] }); },
  });
  return (
    <>
      {canRefresh && (
        <section className="card card-pad row" style={{ flexWrap: 'wrap', gap: 10 }}>
          <strong className="grow">ხელით გადათვლა</strong>
          <span className="small muted">მაგ. ძველი ისტორიის პირველად შევსება ან წყაროში შესწორების შემდეგ (მაქს. 400 დღე ერთ ჯერზე)</span>
          <input className="input mono" type="date" style={{ height: 34, width: 150 }} aria-label="დან" value={from} max={to} onChange={(e) => setFrom(e.target.value || from)} />
          <input className="input mono" type="date" style={{ height: 34, width: 150 }} aria-label="მდე" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value || to)} />
          <button className="btn primary" type="button" disabled={m.isPending || !!q.data?.running} onClick={() => m.mutate()}>გადათვლა</button>
        </section>)}
      <ErrorBox error={m.error ?? q.error} />
      {!q.data ? <Loading /> : (
        <section className="card" style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead><tr><th>#</th><th>სახე</th><th>პერიოდი</th><th>სტატუსი</th><th>დაიწყო</th><th className="num">ხანგრძლ.</th><th>ხაზები</th><th>ვინ</th></tr></thead>
            <tbody>{q.data.rows.map((r) => {
              const [tone, label] = RUN_STATUS[r.status] ?? ['', r.status];
              return (
                <tr key={r.id}>
                  <td className="mono small">{r.id}</td><td className="small">{KIND_KA[r.kind] ?? r.kind}{r.source === 'replica' && <span className="chip" style={{ marginLeft: 6, height: 18 }}>რეპლიკა</span>}</td>
                  <td className="mono small">{String(r.date_from).slice(0, 10)} — {String(r.date_to).slice(0, 10)}</td>
                  <td><span className={`chip ${tone}`}>{label}</span>{r.error && <div className="small" style={{ color: 'var(--danger-ink)', maxWidth: 360 }}>{r.error}</div>}</td>
                  <td className="small">{fmtTime(r.started_at)}</td><td className="num mono small">{r.duration_ms !== null ? `${(r.duration_ms / 1000).toFixed(1)} წმ` : '—'}</td>
                  <td className="small mono">{r.facts ? Object.entries(r.facts).filter(([, v]) => v).map(([k2, v]) => `${k2}: ${v}`).join(' · ') : '—'}</td>
                  <td className="small">{r.requested_by ?? 'worker'}</td>
                </tr>);
            })}
              {!q.data.rows.length && <tr><td colSpan={8} className="muted">გადათვლა ჯერ არ ყოფილა</td></tr>}</tbody>
          </table>
        </section>)}
      {toast.node}
    </>
  );
}
