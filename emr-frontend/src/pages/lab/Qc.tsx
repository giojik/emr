import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api } from '../../api/client';
import { ErrorBox, Field, Loading, Modal, useToast } from '../../components/ui';
import { time, tsDate, unitFmt } from '../../lib/format';
import { useLabMethods, useLabPermissions } from '../admin/lab/common';

// ============================================================ ტიპები
interface Target { id: string; analyte_id: string; analyte_name: string; analyte_code: string; unit: string; method_id: string; method_name: string; mean: string; sd: string; is_active: boolean }
interface Material { id: string; name: string; manufacturer: string | null; level: string; lot: string; expires_on: string | null; barcode: string | null; is_active: boolean; targets: number | string; stock_lot_id?: string | null }
interface QcLot { id: string; lot_no: string; expires_on: string | null; status: string; item_name: string; manufacturer: string | null; qty: string; materials: number }
interface Summary { id: string; material: string; level: string; lot: string; analyte: string; unit: string; method: string; mean: string; sd: string; n: string; mean_obs: string | null; sd_obs: string | null; rejects: string; warns: string; cv: number | null; bias: number | null }
interface Violation { id: string; analyte: string; analyte_id: string; method: string; method_id: string; level: string; lot: string; value: string; z: string; rules: string[]; action: 'block' | 'warn'; status: string; opened_at: string; resolved_at: string | null; resolved_by_name: string | null; cause: string | null; corrective_action: string | null }
interface Point { id: string; value: string; z: string; measured_at: string; status: 'accept' | 'warn' | 'reject'; violations: string[]; source: string; excluded_at: string | null; exclude_reason: string | null; entered_by_name: string | null }
interface Chart { target: { id: string; material: string; level: string; lot: string; analyte: string; unit: string; method: string; mean: string; sd: string }; points: Point[] }
interface RulesCfg { all_rules: { key: string; label: string }[]; analytes: { id: string; name: string; code: string; service_name: string; rules: string[]; action: 'block' | 'warn'; is_default: boolean; updated_at: string | null }[] }

const RULE_SHORT: Record<string, string> = { '1_2s': '1-2s', '1_3s': '1-3s', '2_2s': '2-2s', R_4s: 'R-4s', '4_1s': '4-1s', '10x': '10x' };
const ST: Record<string, [string, string]> = { accept: ['ok', 'მისაღები'], warn: ['warn', 'გაფრთხ.'], reject: ['danger', 'უარყოფა'] };
const today = () => new Date(Date.now() + 4 * 3600_000).toISOString().slice(0, 10);
const monthAgo = () => new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);

/** ლაბორატორია → „ხარისხის კონტროლი“ */
export function Qc() {
  const [tab, setTab] = useState<'overview' | 'chart' | 'materials' | 'rules' | 'violations'>('overview');
  const [chartTarget, setChartTarget] = useState<string | null>(null);
  const open = useQuery({ queryKey: ['qc-violations', 'open'], queryFn: () => api<Violation[]>('/lab/qc/violations'), refetchInterval: 20_000 });
  const T: [typeof tab, string][] = [['overview', 'მიმოხილვა'], ['chart', 'Levey-Jennings'], ['materials', 'მასალები და სამიზნეები'], ['rules', 'წესები'],
    ['violations', `დარღვევები${open.data?.length ? ` (${open.data.length})` : ''}`]];
  return (
    <div className="stack">
      <div className="seg" role="tablist" aria-label="ხარისხის კონტროლი">{T.map(([k, l]) =>
        <button key={k} type="button" role="tab" aria-selected={tab === k} aria-pressed={tab === k} onClick={() => setTab(k)}>{l}</button>)}</div>
      {open.data?.length ? <OpenViolations list={open.data} /> : null}
      {tab === 'overview' && <Overview onChart={(id) => { setChartTarget(id); setTab('chart'); }} />}
      {tab === 'chart' && <LeveyJennings targetId={chartTarget} onTarget={setChartTarget} />}
      {tab === 'materials' && <Materials />}
      {tab === 'rules' && <Rules />}
      {tab === 'violations' && <Violations />}
    </div>
  );
}

// ---------------------------------------------------------------- ღია დარღვევები + განხილვა
function OpenViolations({ list }: { list: Violation[] }) {
  const qc = useQueryClient(); const perm = useLabPermissions();
  const [res, setRes] = useState<Violation | null>(null); const [f, setF] = useState({ cause: '', action: '' });
  const m = useMutation({ mutationFn: () => api(`/lab/qc/violations/${res!.id}/resolve`, { body: { cause: f.cause, corrective_action: f.action } }),
    onSuccess: () => { setRes(null); setF({ cause: '', action: '' }); for (const k of ['qc-violations', 'qc-summary', 'lab-item']) void qc.invalidateQueries({ queryKey: [k] }); } });
  return (
    <div className="alert danger stack" style={{ gap: 4 }}>
      <strong>QC დარღვეულია ({list.length})</strong>
      {list.map((v) => <div key={v.id} className="row small" style={{ flexWrap: 'wrap', gap: 8 }}>
        <span className={`chip ${v.action === 'block' ? 'danger' : 'warn'}`}>{v.action === 'block' ? 'დაბლოკილია' : 'გაფრთხილება'}</span>
        <strong>{v.method} / {v.analyte}</strong><span>{v.level} · {Number(v.value)} (z {Number(v.z).toFixed(2)}) · {v.rules.map((r) => RULE_SHORT[r] ?? r).join(', ')} · {tsDate(v.opened_at)} {time(v.opened_at)}</span>
        {perm.data?.lab_head || perm.data?.norms ? <button className="btn sm" type="button" style={{ marginLeft: 'auto' }} onClick={() => setRes(v)}>განხილვა…</button> : null}
      </div>)}
      <span className="small">{list.some((v) => v.action === 'block') ? 'დაბლოკილ კომპონენტზე ამ ანალიზატორის პაციენტის შედეგები ვერ დადასტურდება, სანამ დარღვევა არ განიხილება. ' : ''}განიხილავს ლაბორატორიის ექიმი / ხელმძღვანელი.</span>
      {res && <Modal title={`განხილვა: ${res.method} / ${res.analyte}`} onClose={() => setRes(null)} width={560}
        footer={<><button className="btn" type="button" onClick={() => setRes(null)}>გაუქმება</button><button className="btn primary" type="button" disabled={f.cause.trim().length < 3 || f.action.trim().length < 3 || m.isPending} onClick={() => m.mutate()}>დახურვა</button></>}>
        <Field label="მიზეზი" htmlFor="vc" required hint="მაგ. „რეაგენტის ლოტი შეიცვალა“, „კალიბრაციის წანაცვლება“"><textarea id="vc" className="textarea" rows={2} value={f.cause} onChange={(e) => setF({ ...f, cause: e.target.value })} /></Field>
        <Field label="მაკორექტირებელი ქმედება" htmlFor="va" required hint="მაგ. „რეკალიბრაცია, QC ხელახლა — მისაღები; ბოლო 2 სთ-ის პაციენტები გადამოწმდა“"><textarea id="va" className="textarea" rows={2} value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })} /></Field>
        <ErrorBox error={m.error} /></Modal>}
    </div>
  );
}

// ---------------------------------------------------------------- მიმოხილვა + ხელით შეყვანა
function Overview({ onChart }: { onChart: (id: string) => void }) {
  const [from, setFrom] = useState(monthAgo()); const [to, setTo] = useState(today());
  const q = useQuery({ queryKey: ['qc-summary', from, to], queryFn: () => api<Summary[]>('/lab/qc/summary', { query: { from, to } }) });
  const [entry, setEntry] = useState<Summary | null>(null);
  return (
    <div className="stack">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <Field label="დან" htmlFor="qf"><input id="qf" type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="მდე" htmlFor="qt"><input id="qt" type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <span className="hint grow" style={{ textAlign: 'right' }}>CV % — გაბნევა; bias % — საშუალოს გადახრა სამიზნიდან. QC ანალიზატორიდან შემოდის ავტომატურად (მასალის შტრიხკოდით), ან — „შეყვანა“.</span>
      </div>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : !q.data?.length ? <div className="card empty">სამიზნეები ჯერ არ არის — „მასალები და სამიზნეები“.</div> : (
        <div className="card" style={{ overflowX: 'auto' }}><table className="table">
          <thead><tr><th>ანალიზატორი / კომპონენტი</th><th>მასალა</th><th className="num">სამიზნე</th><th className="num">n</th><th className="num">საშუალო</th><th className="num">CV %</th><th className="num">bias %</th><th className="num">გაფრთხ. / უარყ.</th><th /></tr></thead>
          <tbody>{q.data.map((s) => (
            <tr key={s.id}>
              <td><strong>{s.analyte}</strong> <span className="small muted">{unitFmt(s.unit)}</span><div className="small muted">{s.method}</div></td>
              <td className="small">{s.level} · {s.lot}</td>
              <td className="num mono small">{Number(s.mean)} ± {Number(s.sd)}</td>
              <td className="num">{s.n}</td>
              <td className="num mono small">{s.mean_obs !== null ? Number(Number(s.mean_obs).toPrecision(4)) : '—'}</td>
              <td className="num">{s.cv ?? '—'}</td>
              <td className="num" style={s.bias !== null && Math.abs(s.bias) > 5 ? { color: 'var(--warn-ink)', fontWeight: 600 } : undefined}>{s.bias ?? '—'}</td>
              <td className="num">{Number(s.warns) || 0} / <span style={Number(s.rejects) ? { color: 'var(--danger-ink)', fontWeight: 600 } : undefined}>{Number(s.rejects) || 0}</span></td>
              <td style={{ whiteSpace: 'nowrap' }}><button className="btn sm" type="button" onClick={() => setEntry(s)}>შეყვანა</button>{' '}<button className="btn sm" type="button" onClick={() => onChart(s.id)}>გრაფიკი</button></td>
            </tr>))}</tbody>
        </table></div>)}
      {entry && <ManualEntry s={entry} onClose={() => setEntry(null)} />}
    </div>
  );
}
function ManualEntry({ s, onClose }: { s: Summary; onClose: () => void }) {
  const qc = useQueryClient(); const [v, setV] = useState('');
  const m = useMutation({ mutationFn: () => api<{ status: string; z: number; violations: string[]; action: string | null; expired: boolean }>('/lab/qc/results', { body: { target_id: s.id, value: Number(v.replace(',', '.')) } }),
    onSuccess: () => { for (const k of ['qc-summary', 'qc-violations', 'qc-chart']) void qc.invalidateQueries({ queryKey: [k] }); } });
  return (
    <Modal title={`QC: ${s.analyte} — ${s.method}`} onClose={onClose} width={480}
      footer={<><button className="btn" type="button" onClick={onClose}>დახურვა</button><button className="btn primary" type="button" disabled={!v.trim() || !Number.isFinite(Number(v.replace(',', '.'))) || m.isPending} onClick={() => m.mutate()}>შენახვა</button></>}>
      <span className="small muted">{s.level} · ლოტი {s.lot} · სამიზნე {Number(s.mean)} ± {Number(s.sd)} {unitFmt(s.unit)}</span>
      <Field label="შედეგი" htmlFor="qv"><input id="qv" className="input mono" inputMode="decimal" autoFocus value={v} onChange={(e) => { setV(e.target.value); m.reset(); }} /></Field>
      {m.data && <div className={`alert ${m.data.status === 'accept' ? 'ok' : m.data.status === 'warn' ? 'warn' : 'danger'}`}>
        <strong>{ST[m.data.status][1]}</strong> · z = {m.data.z}{m.data.violations.length ? ` · ${m.data.violations.map((r) => RULE_SHORT[r]).join(', ')}` : ''}
        {m.data.action === 'block' && <div>პაციენტის შედეგები ამ კომპონენტზე დაბლოკილია განხილვამდე.</div>}
        {m.data.action === 'warn' && <div>პაციენტის შედეგის დადასტურება — მხოლოდ მიზეზით.</div>}
        {m.data.expired && <div>⚠️ მასალის ვადა გასულია.</div>}</div>}
      <ErrorBox error={m.error} />
    </Modal>
  );
}

// ---------------------------------------------------------------- Levey-Jennings
function LeveyJennings({ targetId, onTarget }: { targetId: string | null; onTarget: (id: string) => void }) {
  const qcx = useQueryClient(); const perm = useLabPermissions();
  const [from, setFrom] = useState(monthAgo()); const [to, setTo] = useState(today());
  const list = useQuery({ queryKey: ['qc-summary', from, to], queryFn: () => api<Summary[]>('/lab/qc/summary', { query: { from, to } }) });
  const q = useQuery({ queryKey: ['qc-chart', targetId, from, to], enabled: !!targetId, queryFn: () => api<Chart>('/lab/qc/chart', { query: { target_id: targetId!, from, to } }) });
  const excl = useMutation({ mutationFn: ({ id, reason }: { id: string; reason: string }) => api(`/lab/qc/results/${id}/exclude`, { body: { reason } }),
    onSuccess: () => { void qcx.invalidateQueries({ queryKey: ['qc-chart'] }); void qcx.invalidateQueries({ queryKey: ['qc-summary'] }); } });
  const W = 900; const H = 300; const P = { l: 56, r: 16, t: 12, b: 28 };
  const svg = useMemo(() => {
    if (!q.data?.points.length) return null;
    const mean = Number(q.data.target.mean); const sd = Number(q.data.target.sd);
    const pts = q.data.points; const n = pts.length;
    const zs = pts.map((p) => Number(p.z)); const lim = Math.max(3.5, ...zs.map((z) => Math.abs(z) + 0.3));
    const x = (i: number) => P.l + (n === 1 ? (W - P.l - P.r) / 2 : (i / (n - 1)) * (W - P.l - P.r));
    const y = (z: number) => P.t + (1 - (z + lim) / (2 * lim)) * (H - P.t - P.b);
    return { mean, sd, pts, x, y, lim };
  }, [q.data]);
  return (
    <div className="stack">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <select aria-label="სამიზნე" className="select" style={{ maxWidth: 420, height: 38 }} value={targetId ?? ''} onChange={(e) => onTarget(e.target.value)}>
          <option value="">— აირჩიეთ (კომპონენტი / ანალიზატორი / დონე)</option>
          {list.data?.map((s) => <option key={s.id} value={s.id}>{s.analyte} · {s.method} · {s.level} ({s.lot})</option>)}</select>
        <Field label="დან" htmlFor="lf"><input id="lf" type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="მდე" htmlFor="lt"><input id="lt" type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      {!targetId ? <div className="card empty">აირჩიეთ სამიზნე.</div> : q.isLoading ? <Loading /> : !svg ? <div className="card empty">ამ პერიოდში QC შედეგი არ არის.</div> : <>
        <div className="card card-pad">
          <div className="small muted">{q.data!.target.analyte} · {q.data!.target.method} · {q.data!.target.material} {q.data!.target.level} ({q.data!.target.lot}) · სამიზნე {svg.mean} ± {svg.sd} {unitFmt(q.data!.target.unit)}</div>
          <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Levey-Jennings გრაფიკი">
            {[3, 2, 1, 0, -1, -2, -3].map((k) => <g key={k}>
              <line x1={P.l} x2={W - P.r} y1={svg.y(k)} y2={svg.y(k)} stroke={k === 0 ? 'var(--accent)' : Math.abs(k) === 3 ? '#B42318' : Math.abs(k) === 2 ? '#B26B00' : 'var(--line)'} strokeDasharray={k === 0 ? undefined : '4 3'} strokeWidth={k === 0 ? 1.4 : 1} />
              <text x={P.l - 6} y={svg.y(k) + 4} fontSize="11" textAnchor="end" fill="var(--muted, #777)">{k === 0 ? 'x̄' : `${k > 0 ? '+' : ''}${k}s`}</text>
              <text x={W - P.r} y={svg.y(k) - 3} fontSize="9" textAnchor="end" fill="var(--muted, #999)">{Number((svg.mean + k * svg.sd).toPrecision(4))}</text></g>)}
            <polyline fill="none" stroke="var(--accent)" strokeWidth="1.2" points={svg.pts.map((p, i) => p.excluded_at ? '' : `${svg.x(i)},${svg.y(Number(p.z))}`).filter(Boolean).join(' ')} />
            {svg.pts.map((p, i) => <g key={p.id}>
              <circle cx={svg.x(i)} cy={svg.y(Number(p.z))} r={p.status === 'accept' ? 3.5 : 5} fill={p.excluded_at ? '#fff' : p.status === 'reject' ? '#B42318' : p.status === 'warn' ? '#B26B00' : 'var(--accent)'} stroke={p.excluded_at ? '#999' : 'none'} />
              <title>{`${tsDate(p.measured_at)} ${time(p.measured_at)} — ${Number(p.value)} (z ${Number(p.z).toFixed(2)})${p.violations.length ? ` · ${p.violations.map((r) => RULE_SHORT[r]).join(', ')}` : ''}${p.excluded_at ? ' · გამორიცხულია' : ''}`}</title></g>)}
          </svg>
        </div>
        <div className="card" style={{ maxHeight: 360, overflowY: 'auto' }}><table className="table"><tbody>{[...q.data!.points].reverse().map((p) => (
          <tr key={p.id} style={p.excluded_at ? { opacity: 0.5, textDecoration: 'line-through' } : undefined}>
            <td className="small mono" style={{ whiteSpace: 'nowrap' }}>{tsDate(p.measured_at)} {time(p.measured_at)}</td>
            <td className="mono">{Number(p.value)}</td><td className="small mono">z {Number(p.z).toFixed(2)}</td>
            <td><span className={`chip ${ST[p.status][0]}`}>{ST[p.status][1]}</span> <span className="small">{p.violations.map((r) => RULE_SHORT[r]).join(', ')}</span></td>
            <td className="small muted">{p.source === 'instrument' ? 'ანალიზატორი' : p.entered_by_name ?? 'ხელით'}{p.exclude_reason ? ` · ${p.exclude_reason}` : ''}</td>
            <td>{!p.excluded_at && perm.data?.lab_head && <button className="btn sm" type="button" onClick={() => { const r = prompt('გამორიცხვის მიზეზი (მაგ. „ბუშტი კიუვეტაში“, „ნიმუში არასწორად მომზადდა“)'); if (r && r.trim().length >= 3) excl.mutate({ id: p.id, reason: r.trim() }); }}>გამორიცხვა</button>}</td>
          </tr>))}</tbody></table></div>
        <ErrorBox error={excl.error} />
      </>}
    </div>
  );
}

// ---------------------------------------------------------------- მასალები და სამიზნეები
function Materials() {
  const qc = useQueryClient(); const perm = useLabPermissions();
  const canEdit = !!perm.data?.methods;   // ხელმძღვანელი / მენეჯერი
  const q = useQuery({ queryKey: ['qc-materials'], queryFn: () => api<Material[]>('/lab/qc/materials', { query: { all: true } }) });
  const [edit, setEdit] = useState<Partial<Material> | null>(null); const [targets, setTargets] = useState<Material | null>(null);
  // საწყობის ლოტი (0036): ლოტი და ვადა — საწყობიდან, ხელახლა აღარ იწერება
  const lots = useQuery({ queryKey: ['qc-stock-lots'], queryFn: () => api<QcLot[]>('/stock/lab/qc-lots'), enabled: !!edit });
  const save = useMutation({ mutationFn: () => api(edit!.id ? `/lab/qc/materials/${edit!.id}` : '/lab/qc/materials', { method: edit!.id ? 'PATCH' : 'POST',
    body: { name: edit!.name, manufacturer: edit!.manufacturer || null, level: edit!.level, lot: edit!.lot, expires_on: edit!.expires_on || null, barcode: edit!.barcode?.trim() || null, stock_lot_id: edit!.stock_lot_id || undefined, ...(edit!.id ? { is_active: edit!.is_active } : {}) } }),
    onSuccess: () => { setEdit(null); void qc.invalidateQueries({ queryKey: ['qc-materials'] }); } });
  const set = (k: keyof Material) => (e: React.ChangeEvent<HTMLInputElement>) => setEdit({ ...edit, [k]: e.target.value });
  return (
    <div className="stack">
      <div className="row"><span className="hint grow">„შტრიხკოდი“ — რა ID-ით ატარებს ლაბორანტი QC-ს ანალიზატორზე (მაგ. QC-L1-2604): ასე ანალიზატორიდან მოსული QC ავტომატურად აქ მოხვდება.</span>
        {canEdit && <button className="btn primary" type="button" onClick={() => setEdit({ is_active: true })}>+ მასალა / ლოტი</button>}</div>
      {q.isLoading ? <Loading /> : !q.data?.length ? <div className="card empty">მასალები ჯერ არ არის.</div> : (
        <div className="card"><table className="table">
          <thead><tr><th>მასალა</th><th>დონე</th><th>ლოტი</th><th>ვადა</th><th>შტრიხკოდი</th><th className="num">სამიზნე</th><th /></tr></thead>
          <tbody>{q.data.map((m) => {
            const expired = !!m.expires_on && m.expires_on < today();
            return <tr key={m.id} style={m.is_active ? undefined : { opacity: 0.55 }}>
              <td><strong>{m.name}</strong>{m.manufacturer && <div className="small muted">{m.manufacturer}</div>}</td><td>{m.level}</td><td className="mono small">{m.lot}</td>
              <td className="small" style={expired ? { color: 'var(--danger-ink)', fontWeight: 600 } : undefined}>{m.expires_on ? tsDate(m.expires_on) : '—'}{expired && ' (ვადაგასული)'}</td>
              <td className="mono small">{m.barcode ?? '—'}</td><td className="num">{m.targets}</td>
              <td style={{ whiteSpace: 'nowrap' }}><button className="btn sm" type="button" onClick={() => setTargets(m)}>სამიზნეები</button>{' '}
                {canEdit && <button className="btn sm" type="button" onClick={() => setEdit(m)}>შეცვლა</button>}</td></tr>;
          })}</tbody></table></div>)}
      {edit && <Modal title={edit.id ? `${edit.name} ${edit.level}` : 'ახალი საკონტროლო მასალა'} onClose={() => setEdit(null)} width={600}
        footer={<><button className="btn" type="button" onClick={() => setEdit(null)}>გაუქმება</button><button className="btn primary" type="button" disabled={!edit.name?.trim() || !edit.level?.trim() || !edit.lot?.trim() || save.isPending} onClick={() => save.mutate()}>შენახვა</button></>}>
        {(lots.data?.length ?? 0) > 0 && <Field label="საწყობის ლოტიდან" htmlFor="msl" hint="ლოტი, ვადა, დასახელება — საწყობიდან">
          <select id="msl" className="select" value={edit.stock_lot_id ?? ''} onChange={(e) => { const l = lots.data?.find((x) => x.id === e.target.value);
            setEdit(l ? { ...edit, stock_lot_id: l.id, lot: l.lot_no, expires_on: l.expires_on, name: edit.name || l.item_name, manufacturer: edit.manufacturer || l.manufacturer } : { ...edit, stock_lot_id: null }); }}>
            <option value="">— ხელით —</option>{lots.data!.map((l) => <option key={l.id} value={l.id}>{l.item_name} · {l.lot_no}{l.expires_on ? ` · ${tsDate(l.expires_on)}` : ''} (ნაშთი {Number(l.qty)}){l.materials ? ' · უკვე მიბმულია' : ''}</option>)}
          </select></Field>}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label="დასახელება" htmlFor="mn" required><input id="mn" className="input" value={edit.name ?? ''} onChange={set('name')} placeholder="Liquichek Unassayed Chemistry" /></Field>
          <Field label="მწარმოებელი" htmlFor="mm"><input id="mm" className="input" value={edit.manufacturer ?? ''} onChange={set('manufacturer')} /></Field>
          <Field label="დონე" htmlFor="ml" required><input id="ml" className="input" value={edit.level ?? ''} onChange={set('level')} placeholder="L1 / L2 / ნორმა / პათოლოგია" /></Field>
          <Field label="ლოტი" htmlFor="mlot" required><input id="mlot" className="input mono" value={edit.lot ?? ''} disabled={!!edit.stock_lot_id} onChange={set('lot')} /></Field>
          <Field label="ვადა" htmlFor="me"><input id="me" type="date" className="input" value={edit.expires_on?.slice(0, 10) ?? ''} disabled={!!edit.stock_lot_id} onChange={set('expires_on')} /></Field>
          <Field label="შტრიხკოდი (ანალიზატორზე)" htmlFor="mb"><input id="mb" className="input mono" value={edit.barcode ?? ''} onChange={set('barcode')} placeholder="QC-L1-2604" /></Field>
        </div>
        {edit.id && <label className="row"><input type="checkbox" checked={!!edit.is_active} onChange={(e) => setEdit({ ...edit, is_active: e.target.checked })} /> აქტიური (ახალ ლოტზე გადასვლისას ძველი გათიშეთ)</label>}
        <ErrorBox error={save.error} /></Modal>}
      {targets && <TargetsDialog m={targets} canEdit={canEdit} onClose={() => setTargets(null)} />}
    </div>
  );
}
function TargetsDialog({ m, canEdit, onClose }: { m: Material; canEdit: boolean; onClose: () => void }) {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['qc-targets', m.id], queryFn: () => api<Target[]>(`/lab/qc/materials/${m.id}/targets`) });
  const analytes = useQuery({ queryKey: ['lab-all-analytes-qc'], queryFn: () => api<{ id: string; code: string; name: string; unit: string; service_name: string; result_type: string }[]>('/lab/norms') });
  const methods = useLabMethods();
  const [rows, setRows] = useState<{ analyte_id: string; method_id: string; mean: string; sd: string }[] | null>(null);
  if (q.data && rows === null) setRows(q.data.map((t) => ({ analyte_id: t.analyte_id, method_id: t.method_id, mean: String(Number(t.mean)), sd: String(Number(t.sd)) })));
  const save = useMutation({ mutationFn: () => api(`/lab/qc/materials/${m.id}/targets`, { method: 'PUT', body: { targets: (rows ?? []).map((r) => ({ analyte_id: r.analyte_id, method_id: r.method_id, mean: Number(r.mean.replace(',', '.')), sd: Number(r.sd.replace(',', '.')) })) } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['qc-targets', m.id] }); void qc.invalidateQueries({ queryKey: ['qc-materials'] }); void qc.invalidateQueries({ queryKey: ['qc-summary'] }); toast.show('შენახულია'); } });
  const upd = (i: number, p: Partial<{ analyte_id: string; method_id: string; mean: string; sd: string }>) => setRows((rows ?? []).map((r, j) => (j === i ? { ...r, ...p } : r)));
  const valid = (rows ?? []).every((r) => r.analyte_id && r.method_id && Number.isFinite(Number(r.mean.replace(',', '.'))) && Number(r.sd.replace(',', '.')) > 0);
  const numeric = (analytes.data ?? []).filter((a) => a.result_type === 'numeric');
  return (
    <Modal title={`სამიზნეები: ${m.name} ${m.level} (${m.lot})`} onClose={onClose} width={900}
      footer={<><button className="btn" type="button" onClick={onClose}>დახურვა</button>{canEdit && <button className="btn primary" type="button" disabled={!valid || save.isPending} onClick={() => save.mutate()}>შენახვა</button>}</>}>
      <span className="hint">mean და SD — მასალის ინსტრუქციიდან (assayed) ან ლაბორატორიის 20 გაზომვით (unassayed). თითო ანალიზატორზე ცალკე.</span>
      {!rows ? <Loading /> : <fieldset disabled={!canEdit} style={{ border: 0, padding: 0, margin: 0 }}>
        <table className="table"><thead><tr><th>კომპონენტი</th><th>ანალიზატორი</th><th>mean</th><th>SD</th><th className="num">CV %</th><th /></tr></thead>
          <tbody>{rows.map((r, i) => <tr key={i}>
            <td><select aria-label="კომპონენტი" className="select" style={{ height: 32, maxWidth: 280 }} value={r.analyte_id} onChange={(e) => upd(i, { analyte_id: e.target.value })}>
              <option value="">—</option>{numeric.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.code}) · {a.service_name}</option>)}</select></td>
            <td><select aria-label="ანალიზატორი" className="select" style={{ height: 32, maxWidth: 200 }} value={r.method_id} onChange={(e) => upd(i, { method_id: e.target.value })}>
              <option value="">—</option>{methods.data?.map((me) => <option key={me.id} value={me.id}>{me.name}</option>)}</select></td>
            <td><input aria-label="mean" className="input mono" style={{ width: 90, height: 32 }} value={r.mean} onChange={(e) => upd(i, { mean: e.target.value })} /></td>
            <td><input aria-label="SD" className="input mono" style={{ width: 80, height: 32 }} value={r.sd} onChange={(e) => upd(i, { sd: e.target.value })} /></td>
            <td className="num small">{Number(r.mean) ? Math.round((Number(r.sd) / Number(r.mean)) * 1000) / 10 : '—'}</td>
            <td><button className="icon-btn" type="button" aria-label="წაშლა" onClick={() => setRows(rows.filter((_, j) => j !== i))}>×</button></td></tr>)}</tbody></table>
        <button className="btn sm" type="button" onClick={() => setRows([...rows, { analyte_id: '', method_id: '', mean: '', sd: '' }])}>+ სამიზნე</button>
      </fieldset>}
      <ErrorBox error={save.error} />{toast.node}
    </Modal>
  );
}

// ---------------------------------------------------------------- წესები (ხელმძღვანელი)
function Rules() {
  const qc = useQueryClient(); const perm = useLabPermissions(); const canEdit = !!perm.data?.lab_head;
  const q = useQuery({ queryKey: ['qc-rules'], queryFn: () => api<RulesCfg>('/lab/qc/rules') });
  const [search, setSearch] = useState('');
  const save = useMutation({ mutationFn: ({ id, rules, action }: { id: string; rules: string[]; action: string }) => api(`/lab/qc/rules/${id}`, { method: 'PUT', body: { rules, action } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['qc-rules'] }) });
  if (q.isLoading || !q.data) return <Loading />;
  const t = search.trim().toLowerCase();
  const list = q.data.analytes.filter((a) => !t || `${a.name} ${a.code} ${a.service_name}`.toLowerCase().includes(t));
  return (
    <div className="stack">
      <div className="card card-pad small stack" style={{ gap: 4 }}>
        {q.data.all_rules.map((r) => <div key={r.key}><strong className="mono">{RULE_SHORT[r.key]}</strong> — {r.label.split(' — ')[1] ?? r.label}</div>)}
        <span className="hint">ნაგულისხმევი: ყველა წესი + დაბლოკვა. „დაბლოკვა“ — დარღვევისას ამ ანალიზატორის ამ კომპონენტის პაციენტის შედეგები ვერ დადასტურდება განხილვამდე; „გაფრთხილება“ — დადასტურება მიზეზით (აუდიტში). {canEdit ? '' : 'ცვლის ლაბორატორიის ხელმძღვანელი.'}</span>
      </div>
      <input aria-label="ძებნა" className="input" style={{ maxWidth: 300, height: 36 }} placeholder="კომპონენტი" value={search} onChange={(e) => setSearch(e.target.value)} />
      <ErrorBox error={save.error} />
      <div className="card" style={{ overflowX: 'auto' }}><table className="table">
        <thead><tr><th>კომპონენტი</th>{q.data.all_rules.map((r) => <th key={r.key} className="small mono" style={{ textAlign: 'center' }}>{RULE_SHORT[r.key]}</th>)}<th>დარღვევისას</th></tr></thead>
        <tbody>{list.map((a) => (
          <tr key={a.id}>
            <td><strong>{a.name}</strong> <span className="small muted mono">{a.code}</span><div className="small muted">{a.service_name}{a.is_default ? ' · ნაგულისხმევი' : ''}</div></td>
            {q.data!.all_rules.map((r) => <td key={r.key} style={{ textAlign: 'center' }}><input type="checkbox" aria-label={`${a.name} ${RULE_SHORT[r.key]}`} disabled={!canEdit || save.isPending} checked={a.rules.includes(r.key)}
              onChange={(e) => save.mutate({ id: a.id, rules: e.target.checked ? [...a.rules, r.key] : a.rules.filter((x) => x !== r.key), action: a.action })} /></td>)}
            <td><select aria-label="მოქმედება" className="select" style={{ height: 32 }} disabled={!canEdit || save.isPending} value={a.action} onChange={(e) => save.mutate({ id: a.id, rules: a.rules, action: e.target.value })}>
              <option value="block">დაბლოკვა</option><option value="warn">გაფრთხილება</option></select></td>
          </tr>))}</tbody></table></div>
    </div>
  );
}

// ---------------------------------------------------------------- დარღვევების ისტორია
function Violations() {
  const q = useQuery({ queryKey: ['qc-violations', 'all'], queryFn: () => api<Violation[]>('/lab/qc/violations', { query: { status: 'all' } }) });
  if (q.isLoading) return <Loading />;
  if (!q.data?.length) return <div className="card empty">დარღვევები არ ყოფილა.</div>;
  return (
    <div className="card" style={{ overflowX: 'auto' }}><table className="table">
      <thead><tr><th>დრო</th><th>ანალიზატორი / კომპონენტი</th><th>შედეგი</th><th>წესი</th><th>სტატუსი</th><th>მიზეზი / ქმედება</th></tr></thead>
      <tbody>{q.data.map((v) => <tr key={v.id}>
        <td className="small mono" style={{ whiteSpace: 'nowrap' }}>{tsDate(v.opened_at)} {time(v.opened_at)}</td>
        <td><strong>{v.analyte}</strong><div className="small muted">{v.method} · {v.level}</div></td>
        <td className="mono small">{Number(v.value)} (z {Number(v.z).toFixed(2)})</td>
        <td className="small">{v.rules.map((r) => RULE_SHORT[r] ?? r).join(', ')} <span className={`chip ${v.action === 'block' ? 'danger' : 'warn'}`}>{v.action === 'block' ? 'დაბლ.' : 'გაფრთხ.'}</span></td>
        <td>{v.status === 'open' ? <span className="chip danger">ღიაა</span> : <span className="chip ok">განხილულია</span>}{v.resolved_at && <div className="small muted">{tsDate(v.resolved_at)} · {v.resolved_by_name}</div>}</td>
        <td className="small">{v.cause}{v.corrective_action && <div className="muted">→ {v.corrective_action}</div>}</td>
      </tr>)}</tbody></table></div>
  );
}
