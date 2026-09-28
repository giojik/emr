import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { ErrorBox, Field, Loading, Modal, useToast } from '../../components/ui';
import { time, tsDate } from '../../lib/format';
import { ConnChip, InstrumentPanel } from './lab/Instruments';

/**
 * ადმინისტრირება → ანალიზატორები (IT): ყველა ანალიზატორი ერთ დაფაზე — კავშირი, მონაცემთა ნაკადი დღეს, შემოწმება,
 * ახალი აპარატის დამატება (მოსმენის რეჟიმით), საერთო ჟურნალი, გაფრთხილებები (ეკრანი + SMS + ელ-ფოსტა).
 */
interface Row {
  method_id: string; name: string; is_active: boolean; id: string; protocol: 'astm' | 'hl7'; conn_mode: 'client' | 'server'; host: string | null; port: number; is_enabled: boolean;
  order_mode: string; listen_only: boolean; alerts_enabled: boolean; silent_minutes: number | null; status: string; status_at: string | null; down_since: string | null; peer: string | null;
  last_message_at: string | null; last_error: string | null; results_today: string; unmatched: string; queries_today: string; orders_today: string; errors_today: string; codes: string; unmapped_codes: string;
}
interface Alert { id: string; kind: string; message: string; started_at: string; resolved_at?: string | null; notified: { sms?: string[]; email?: string[]; errors?: string[] } | null; method_id?: string | null; name: string | null }
interface Dash { gateway: { alive: boolean; heartbeat_at: string | null; started_at: string | null; hostname: string | null }; notify: { email: boolean; sms: boolean }; instruments: Row[]; open_alerts: Alert[] }
interface CmdResult { id: string; status: string; result: Record<string, unknown> | null }

const ago = (iso: string | null) => {
  if (!iso) return '—';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  return m < 1 ? 'ახლახან' : m < 60 ? `${m} წთ წინ` : m < 1440 ? `${Math.round(m / 6) / 10} სთ წინ` : `${tsDate(iso)} ${time(iso)}`;
};

/** ბრძანება gateway-ს → შედეგის მოლოდინი */
async function runCommand(body: Record<string, unknown>): Promise<CmdResult> {
  const { id } = await api<{ id: string }>('/lab/gateway/commands', { body });
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const r = await api<CmdResult>(`/lab/gateway/commands/${id}`);
    if (r.status === 'done' || r.status === 'failed') return r;
  }
  return { id, status: 'failed', result: { ok: false, error: 'gateway არ უპასუხა 20 წამში — შეამოწმეთ, მუშაობს თუ არა' } };
}
export function CmdView({ r }: { r: CmdResult | null }) {
  if (!r?.result) return null;
  const x = r.result as { ok?: boolean; ms?: number; astm?: string | null; error?: string; warning?: string; note?: string; via?: string; peer?: string };
  return (
    <div className={`alert ${x.ok === false ? 'danger' : x.warning ? 'warn' : 'ok'} small`} style={{ margin: 0 }}>
      {x.ok === false ? '✘ ' : '✔ '}{x.error ?? [x.via === 'existing' ? `არსებული კავშირი${x.peer ? ` (${x.peer})` : ''}` : 'TCP კავშირი ხერხდება', x.ms !== undefined ? `${x.ms} მწმ` : null,
        x.astm ? `ASTM: ENQ → ${x.astm}` : null, x.note, x.warning].filter(Boolean).join(' · ')}
    </div>
  );
}

export default function Analyzers() {
  const [tab, setTab] = useState<'dash' | 'log' | 'alerts'>('dash');
  const [wizard, setWizard] = useState(false);
  const d = useQuery({ queryKey: ['gw-dash'], queryFn: () => api<Dash>('/lab/gateway/dashboard'), refetchInterval: 5000 });
  return (
    <div className="content stack">
      <ErrorBox error={d.error} />
      {d.data && <GatewayCard d={d.data} onAdd={() => setWizard(true)} />}
      {d.data?.open_alerts.length ? <div className="alert danger stack" style={{ gap: 4 }}>
        <strong>ღია გაფრთხილებები ({d.data.open_alerts.length})</strong>
        {d.data.open_alerts.map((a) => <span key={a.id} className="small">{time(a.started_at)} — {a.message}
          {a.notified?.errors?.length ? <span className="muted"> (შეტყობინება: {a.notified.errors.join('; ')})</span> : a.notified ? <span className="muted"> (გაიგზავნა: {[...(a.notified.sms ?? []), ...(a.notified.email ?? [])].join(', ') || '—'})</span> : null}</span>)}
      </div> : null}
      <div className="seg" role="tablist" aria-label="ანალიზატორები">
        {[['dash', 'დაფა'], ['log', 'ჟურნალი'], ['alerts', 'გაფრთხილებები']].map(([k, l]) =>
          <button key={k} type="button" role="tab" aria-selected={tab === k} aria-pressed={tab === k} onClick={() => setTab(k as typeof tab)}>{l}</button>)}
      </div>
      {tab === 'dash' && (d.isLoading ? <Loading /> : <Board rows={d.data?.instruments ?? []} />)}
      {tab === 'log' && <GlobalLog rows={d.data?.instruments ?? []} />}
      {tab === 'alerts' && <Alerts notify={d.data?.notify} />}
      {wizard && <Wizard onClose={() => setWizard(false)} />}
    </div>
  );
}

function GatewayCard({ d, onAdd }: { d: Dash; onAdd: () => void }) {
  const g = d.gateway;
  const on = d.instruments.filter((r) => r.is_enabled);
  const ok = on.filter((r) => r.status === 'connected' || (r.conn_mode === 'server' && r.status === 'listening'));
  return (
    <div className="card card-pad row" style={{ flexWrap: 'wrap', gap: 16 }}>
      <div className="stack" style={{ gap: 2 }}>
        <strong>emr-lab-gateway {g.alive ? <span className="chip ok">მუშაობს</span> : <span className="chip danger">არ მუშაობს</span>}</strong>
        <span className="small muted">{g.started_at ? `გაშვებულია ${tsDate(g.started_at)} ${time(g.started_at)}` : 'ჯერ არ გაშვებულა'} · ბოლო სიგნალი {ago(g.heartbeat_at)}{g.hostname ? ` · ${g.hostname}` : ''}</span>
      </div>
      <div className="stack" style={{ gap: 2 }}>
        <strong>{ok.length} / {on.length}</strong><span className="small muted">კავშირზეა (ჩართულებიდან)</span>
      </div>
      <div className="stack" style={{ gap: 2 }}>
        <span className="small">შეტყობინებები: SMS {d.notify.sms ? <span className="chip ok">კონფიგურირებულია</span> : <span className="chip">არა</span>} ელ-ფოსტა {d.notify.email ? <span className="chip ok">კონფიგურირებულია</span> : <span className="chip">არა</span>}</span>
        {(!d.notify.sms || !d.notify.email) && <span className="small muted">სერვერზე `.env`: SMS_API_URL / SMTP_HOST (იხ. „გაფრთხილებები“)</span>}
      </div>
      <button className="btn primary" type="button" style={{ marginLeft: 'auto' }} onClick={onAdd}>+ ახალი აპარატი</button>
    </div>
  );
}

// ============================================================ დაფა
function Board({ rows }: { rows: Row[] }) {
  const qc = useQueryClient();
  const [res, setRes] = useState<Record<string, CmdResult | null>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<Row | null>(null);
  const run = async (r: Row, kind: 'link_test' | 'reconnect') => {
    setBusy(r.method_id + kind);
    try { const x = await runCommand({ kind, method_id: r.method_id }); setRes({ ...res, [r.method_id]: x }); void qc.invalidateQueries({ queryKey: ['gw-dash'] }); }
    catch (e) { setRes({ ...res, [r.method_id]: { id: '', status: 'failed', result: { ok: false, error: (e as Error).message } } }); } finally { setBusy(null); }
  };
  if (!rows.length) return <div className="card empty">ანალიზატორები ჯერ არ არის დაკავშირებული. დააჭირეთ „+ ახალი აპარატი“.</div>;
  return (
    <div className="card" style={{ overflowX: 'auto' }}>
      <table className="table">
        <thead><tr><th>ანალიზატორი</th><th>კავშირი</th><th>ბოლო შეტყობინება</th><th className="num" title="შედეგი / ქვერი / შეკვეთა / შეცდომა">დღეს: შედ. / ქვ. / შეკვ. / შეცდ.</th><th className="num">დასამ.</th><th>კოდები</th><th /></tr></thead>
        <tbody>{rows.map((r) => {
          const since = r.down_since ?? r.status_at;
          const silentWarn = r.is_enabled && r.status === 'connected' && r.last_message_at && Date.now() - new Date(r.last_message_at).getTime() > 2 * 3600_000;
          return (<Fragment key={r.method_id}>
            <tr style={!r.is_enabled || !r.is_active ? { opacity: 0.55 } : undefined}>
              <td><strong>{r.name}</strong>
                <div className="small muted mono">{r.protocol.toUpperCase()} · {r.conn_mode === 'client' ? `→ ${r.host}:${r.port}` : `← :${r.port}`}{r.order_mode !== 'none' ? ` · ${r.order_mode === 'query' ? 'ქვერი' : 'push'}` : ''}</div>
                {r.listen_only && <span className="chip info">მოსმენის რეჟიმი</span>}{!r.alerts_enabled && <span className="chip">გაფრთხ. გამორთული</span>}</td>
              <td><ConnChip r={r} />{r.is_enabled && since && <div className="small muted">{ago(since)}</div>}{r.peer && <div className="small mono muted">{r.peer}</div>}
                {r.last_error && r.status !== 'connected' && <div className="small" style={{ color: 'var(--danger-ink)', maxWidth: 260 }}>{r.last_error}</div>}</td>
              <td className="small">{ago(r.last_message_at)}{silentWarn && <div style={{ color: 'var(--warn-ink)' }}>დიდი ხანია ჩუმადაა</div>}</td>
              <td className="num mono small">{Number(r.results_today)} / {Number(r.queries_today)} / {Number(r.orders_today)} / <span style={Number(r.errors_today) ? { color: 'var(--danger-ink)', fontWeight: 600 } : undefined}>{Number(r.errors_today)}</span></td>
              <td className="num">{Number(r.unmatched) ? <strong style={{ color: 'var(--warn-ink)' }}>{r.unmatched}</strong> : 0}</td>
              <td className="small">{Number(r.codes)}{Number(r.unmapped_codes) > 0 && <div style={{ color: 'var(--warn-ink)' }}>რუკის გარეშე: {r.unmapped_codes}</div>}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                <button className="btn sm" type="button" disabled={!!busy || !r.is_enabled} onClick={() => void run(r, 'link_test')}>{busy === r.method_id + 'link_test' ? '…' : 'შემოწმება'}</button>{' '}
                <button className="btn sm" type="button" disabled={!!busy || !r.is_enabled} onClick={() => void run(r, 'reconnect')}>ხელახლა</button>{' '}
                <button className="btn sm" type="button" onClick={() => setOpen(r)}>გახსნა</button>
              </td>
            </tr>
            {res[r.method_id] && <tr><td colSpan={7} style={{ paddingTop: 0 }}><CmdView r={res[r.method_id]} /></td></tr>}
          </Fragment>);
        })}</tbody>
      </table>
      {open && <InstrumentModal row={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** აპარატის სრული ფანჯარა: კავშირი/კოდები/ჟურნალი + მოსმენის რეჟიმი და გაფრთხილებები */
function InstrumentModal({ row, onClose, initialTab }: { row: Pick<Row, 'method_id' | 'name' | 'listen_only' | 'alerts_enabled' | 'silent_minutes'>; onClose: () => void; initialTab?: 'conn' | 'codes' | 'log' }) {
  return (
    <Modal title={row.name} onClose={onClose} width={1000} footer={<button className="btn" type="button" onClick={onClose}>დახურვა</button>}>
      <Options row={row} />
      <InstrumentPanel methodId={row.method_id} canEdit initialTab={initialTab} />
    </Modal>
  );
}
function Options({ row }: { row: Pick<Row, 'method_id' | 'listen_only' | 'alerts_enabled' | 'silent_minutes'> }) {
  const qc = useQueryClient();
  const [o, setO] = useState({ listen_only: row.listen_only, alerts_enabled: row.alerts_enabled, silent: row.silent_minutes ? String(row.silent_minutes) : '' });
  const save = useMutation({
    mutationFn: (v: typeof o) => api(`/lab/gateway/instruments/${row.method_id}/options`, { method: 'PATCH', body: { listen_only: v.listen_only, alerts_enabled: v.alerts_enabled, silent_minutes: v.silent ? Number(v.silent) : null } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['gw-dash'] }),
  });
  const upd = (p: Partial<typeof o>) => { const v = { ...o, ...p }; setO(v); save.mutate(v); };
  return (
    <div className="card card-pad row" style={{ flexWrap: 'wrap', gap: 14 }}>
      <label className="row small"><input type="checkbox" checked={o.listen_only} onChange={(e) => upd({ listen_only: e.target.checked })} /> <strong>მოსმენის რეჟიმი</strong> <span className="muted">— შეტყობინებები ჩანს, EMR-ში შედეგი არ იწერება, შეკვეთა არ იგზავნება</span></label>
      <label className="row small"><input type="checkbox" checked={o.alerts_enabled} onChange={(e) => upd({ alerts_enabled: e.target.checked })} /> გაფრთხილებები</label>
      <label className="row small">„ჩუმი“ ზღვარი (წთ) <input className="input mono" style={{ width: 70, height: 30 }} placeholder="საერთო" value={o.silent} onChange={(e) => setO({ ...o, silent: e.target.value.replace(/\D/g, '') })}
        onBlur={() => (!o.silent || Number(o.silent) >= 10) && save.mutate(o)} /></label>
      <ErrorBox error={save.error} />
    </div>
  );
}

// ============================================================ ახალი აპარატი (ოსტატი)
function Wizard({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient(); const toast = useToast();
  const [step, setStep] = useState(1);
  const [name, setName] = useState(''); const [kind, setKind] = useState('analyzer');
  const [f, setF] = useState({ protocol: 'astm' as 'astm' | 'hl7', conn_mode: 'client' as 'client' | 'server', host: '', port: '4001', order_mode: 'query' });
  const [methodId, setMethodId] = useState<string | null>(null);
  const [test, setTest] = useState<CmdResult | null>(null); const [testing, setTesting] = useState(false);
  const create = useMutation({
    mutationFn: async () => {
      const m = methodId ? { id: methodId } : await api<{ id: string }>('/lab/methods', { body: { name: name.trim(), kind } });
      setMethodId(m.id);
      await api(`/lab/instruments/${m.id}`, { method: 'PUT', body: { protocol: f.protocol, conn_mode: f.conn_mode, host: f.conn_mode === 'client' ? f.host.trim() : null, port: Number(f.port), is_enabled: true, order_mode: f.order_mode } });
      await api(`/lab/gateway/instruments/${m.id}/options`, { method: 'PATCH', body: { listen_only: true } });
      return m.id;
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['gw-dash'] }); void qc.invalidateQueries({ queryKey: ['lab-methods'] }); setStep(3); },
  });
  const activate = useMutation({
    mutationFn: () => api(`/lab/gateway/instruments/${methodId}/options`, { method: 'PATCH', body: { listen_only: false } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['gw-dash'] }); toast.show('ჩართულია — შედეგები EMR-ში შევა'); onClose(); },
  });
  const doTest = async () => {
    setTesting(true);
    try { setTest(await runCommand({ kind: 'tcp_test', host: f.host.trim(), port: Number(f.port), protocol: f.protocol })); }
    catch (e) { setTest({ id: '', status: 'failed', result: { ok: false, error: (e as Error).message } }); } finally { setTesting(false); }
  };
  const seen = useQuery({ queryKey: ['lab-seen-codes', methodId], queryFn: () => api<{ code: string; last_value: string | null; last_unit: string | null; mapping_id: string | null }[]>(`/lab/instruments/${methodId}/seen-codes`),
    enabled: !!methodId && step >= 3, refetchInterval: 5000 });
  const log = useQuery({ queryKey: ['lab-instrument-log', methodId], queryFn: () => api<{ id: string; direction: string; kind: string; summary: string | null; created_at: string }[]>(`/lab/instruments/${methodId}/messages`, { query: { limit: 10 } }),
    enabled: !!methodId && step === 3, refetchInterval: 3000 });
  const STEPS = ['სახელი', 'კავშირი', 'მოსმენა', 'კოდები', 'ჩართვა'];
  return (
    <Modal title="ახალი აპარატი" onClose={onClose} width={step === 4 ? 1000 : 760}
      footer={<>
        <button className="btn" type="button" onClick={onClose}>{step >= 3 ? 'დახურვა (მოსმენის რეჟიმში რჩება)' : 'გაუქმება'}</button>
        {step === 1 && <button className="btn primary" type="button" disabled={name.trim().length < 2} onClick={() => setStep(2)}>შემდეგი</button>}
        {step === 2 && <button className="btn primary" type="button" disabled={!f.port || (f.conn_mode === 'client' && !f.host.trim()) || create.isPending} onClick={() => create.mutate()}>შენახვა და მოსმენა</button>}
        {step === 3 && <button className="btn primary" type="button" onClick={() => setStep(4)}>კოდების მიბმა</button>}
        {step === 4 && <button className="btn primary" type="button" onClick={() => setStep(5)}>შემდეგი</button>}
        {step === 5 && <button className="btn primary" type="button" disabled={activate.isPending} onClick={() => activate.mutate()}>ჩართვა</button>}
      </>}>
      <div className="row small" style={{ gap: 6, flexWrap: 'wrap' }}>{STEPS.map((s, i) => <span key={s} className={`chip ${i + 1 === step ? 'accent' : i + 1 < step ? 'ok' : ''}`}>{i + 1}. {s}</span>)}</div>
      {step === 1 && <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
        <Field label="დასახელება" htmlFor="wn" required hint="მაგ. cobas c 111, DxH 500"><input id="wn" className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
        <Field label="ტიპი" htmlFor="wk"><select id="wk" className="select" value={kind} onChange={(e) => setKind(e.target.value)}><option value="analyzer">ანალიზატორი</option><option value="method">მეთოდი</option></select></Field>
      </div>}
      {step === 2 && <div className="stack">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="პროტოკოლი" htmlFor="wp" hint="ანალიზატორის LIS-ინტერფეისის დოკუმენტაციიდან"><select id="wp" className="select" value={f.protocol} onChange={(e) => setF({ ...f, protocol: e.target.value as 'astm' | 'hl7' })}>
            <option value="astm">ASTM E1381/E1394</option><option value="hl7">HL7 v2 (MLLP)</option></select></Field>
          <Field label="ვინ უკავშირდება" htmlFor="wm"><select id="wm" className="select" value={f.conn_mode} onChange={(e) => setF({ ...f, conn_mode: e.target.value as 'client' | 'server', port: e.target.value === 'server' ? '4100' : '4001' })}>
            <option value="client">EMR → ანალიზატორი / Moxa (TCP Server)</option><option value="server">ანალიზატორი → EMR (4100–4109)</option></select></Field>
          {f.conn_mode === 'client' && <Field label="IP" htmlFor="wh"><input id="wh" className="input mono" value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} placeholder="10.10.5.220" /></Field>}
          <Field label="პორტი" htmlFor="wpt" hint={f.conn_mode === 'client' ? 'Moxa: 4001–4004' : 'ანალიზატორზე მიუთითეთ EMR სერვერის IP და ეს პორტი'}><input id="wpt" className="input mono" value={f.port} onChange={(e) => setF({ ...f, port: e.target.value.replace(/\D/g, '') })} /></Field>
          <Field label="შეკვეთები" htmlFor="wo"><select id="wo" className="select" value={f.order_mode} onChange={(e) => setF({ ...f, order_mode: e.target.value })}>
            <option value="query">host query (შტრიხკოდით)</option><option value="push">push (მიღებისას)</option><option value="none">მხოლოდ შედეგები</option></select></Field>
        </div>
        {f.conn_mode === 'client' && <div className="row"><button className="btn" type="button" disabled={!f.host.trim() || !f.port || testing} onClick={() => void doTest()}>{testing ? 'მოწმდება…' : 'კავშირის შემოწმება'}</button>
          <span className="hint grow">TCP{f.protocol === 'astm' ? ' + ASTM ENQ → ACK' : ''} — gateway-დან. მონაცემები არ იგზავნება.</span></div>}
        <CmdView r={test} />
        {f.conn_mode === 'client' && <div className="alert warn small">თუ Moxa-ს ეს პორტი სხვა სისტემას (მაგ. არსებულ LIS-ს) ემსახურება, ჯერ ის უნდა გაითიშოს — ერთ პორტზე ერთი კავშირია.</div>}
        <ErrorBox error={create.error} />
      </div>}
      {step === 3 && <div className="stack">
        <div className="alert info">აპარატი <strong>მოსმენის რეჟიმშია</strong>: gateway იღებს შეტყობინებებს და აჩვენებს, მაგრამ EMR-ში არაფერს წერს. გაუშვით ანალიზატორზე სატესტო ნიმუში ან QC, ან გამოიყენეთ „Resend to LIS“.</div>
        <div className="row small" style={{ flexWrap: 'wrap', gap: 6 }}><strong>აღმოჩენილი კოდები:</strong> {seen.data?.length ? seen.data.map((c) => <span key={c.code} className={`chip ${c.mapping_id ? 'ok' : ''}`}><span className="mono">{c.code}</span> {c.last_value}{c.last_unit ? ` ${c.last_unit}` : ''}</span>) : <span className="muted">ჯერ არაფერი…</span>}</div>
        <div className="card" style={{ maxHeight: 260, overflowY: 'auto' }}>{log.data?.length ? <table className="table"><tbody>{log.data.map((m) => <tr key={m.id}><td className="small mono">{time(m.created_at)}</td>
          <td className="small">{m.direction === 'in' ? '← ' : '→ '}{m.kind}</td><td className="small">{m.summary}</td></tr>)}</tbody></table> : <div className="empty small">შეტყობინებები ჯერ არ არის — ელოდება…</div>}</div>
      </div>}
      {step === 4 && methodId && <InstrumentPanel methodId={methodId} canEdit initialTab="codes" />}
      {step === 5 && <div className="stack">
        <div className="alert warn">ჩართვის შემდეგ ანალიზატორის შედეგები EMR-ში „ვალიდაციას ელოდება“ სტატუსით შევა{f.order_mode !== 'none' ? ', შეკვეთებიც გაიგზავნება' : ''}. ვალიდაცია — ადამიანი. რუკის გარეშე კოდები „დასამუშავებელში“ მოხვდება.</div>
      </div>}
      {toast.node}
    </Modal>
  );
}

// ============================================================ საერთო ჟურნალი
function GlobalLog({ rows }: { rows: Row[] }) {
  const [m, setM] = useState(''); const [dir, setDir] = useState(''); const [errs, setErrs] = useState(false); const [search, setSearch] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['gw-log', m, dir, errs, search], refetchInterval: 5000,
    queryFn: () => api<{ id: string; direction: string; kind: string; summary: string | null; raw: string; error: string | null; created_at: string; instrument: string }[]>('/lab/gateway/log',
      { query: { method_id: m || undefined, direction: dir || undefined, errors: errs || undefined, search: search.trim() || undefined, limit: 200 } }) });
  const KIND: Record<string, string> = { results: 'შედეგები', query: 'ქვერი', orders: 'შეკვეთა', ack: 'ACK', other: 'სხვა' };
  return (
    <div className="stack">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <select aria-label="ანალიზატორი" className="select" style={{ maxWidth: 240, height: 36 }} value={m} onChange={(e) => setM(e.target.value)}><option value="">ყველა ანალიზატორი</option>{rows.map((r) => <option key={r.method_id} value={r.method_id}>{r.name}</option>)}</select>
        <select aria-label="მიმართულება" className="select" style={{ maxWidth: 160, height: 36 }} value={dir} onChange={(e) => setDir(e.target.value)}><option value="">ორივე მიმართულება</option><option value="in">← შემოსული</option><option value="out">→ გაგზავნილი</option></select>
        <label className="row small"><input type="checkbox" checked={errs} onChange={(e) => setErrs(e.target.checked)} /> მხოლოდ შეცდომები</label>
        <input aria-label="ძებნა" className="input" style={{ maxWidth: 240, height: 36 }} placeholder="შტრიხკოდი / ტექსტი" value={search} onChange={(e) => setSearch(e.target.value)} />
        <span className="hint grow" style={{ textAlign: 'right' }}>ინახება 30 დღე · ახლდება 5 წმ-ში</span>
      </div>
      {q.isLoading ? <Loading /> : !q.data?.length ? <div className="card empty">შეტყობინებები არ არის.</div> : (
        <div className="card" style={{ maxHeight: 'calc(100vh - 330px)', overflowY: 'auto' }}>
          <table className="table"><tbody>{q.data.map((x) => (<Fragment key={x.id}>
            <tr className="clickable" onClick={() => setOpen(open === x.id ? null : x.id)}>
              <td className="small mono" style={{ whiteSpace: 'nowrap' }}>{tsDate(x.created_at)} {time(x.created_at)}</td>
              <td className="small">{x.instrument}</td>
              <td>{x.direction === 'in' ? <span className="chip info">← შემოვიდა</span> : <span className="chip">→ გაიგზავნა</span>}</td>
              <td className="small">{KIND[x.kind] ?? x.kind}</td>
              <td className="small">{x.summary}{x.error && <div style={{ color: 'var(--danger-ink)' }}>{x.error}</div>}</td>
            </tr>
            {open === x.id && <tr><td colSpan={5}><pre className="mono small" style={{ whiteSpace: 'pre-wrap', margin: 0, background: 'var(--bg)', padding: 8, borderRadius: 6, maxHeight: 300, overflow: 'auto' }}>{x.raw}</pre></td></tr>}
          </Fragment>))}</tbody></table>
        </div>
      )}
    </div>
  );
}

// ============================================================ გაფრთხილებები
interface Settings { enabled: boolean; disconnect_minutes: number; silent_minutes: number; work_start: string; work_end: string; work_days: number[]; sms_phones: string[]; emails: string[]; notify_resolved: boolean }
function Alerts({ notify }: { notify?: { sms: boolean; email: boolean } }) {
  const qc = useQueryClient(); const toast = useToast();
  const s = useQuery({ queryKey: ['gw-alert-settings'], queryFn: () => api<Settings>('/lab/gateway/alert-settings') });
  const h = useQuery({ queryKey: ['gw-alerts'], queryFn: () => api<Alert[]>('/lab/gateway/alerts', { query: { limit: 100 } }), refetchInterval: 15_000 });
  const [f, setF] = useState<(Omit<Settings, 'sms_phones' | 'emails'> & { sms: string; mails: string }) | null>(null);
  useEffect(() => { if (s.data && !f) setF({ ...s.data, work_start: s.data.work_start.slice(0, 5), work_end: s.data.work_end.slice(0, 5), sms: s.data.sms_phones.join('\n'), mails: s.data.emails.join('\n') }); }, [s.data, f]);
  const save = useMutation({
    mutationFn: () => { const { sms, mails, ...rest } = f!; return api<Settings>('/lab/gateway/alert-settings', { method: 'PUT', body: { ...rest, sms_phones: sms.split(/[\s,;]+/).filter(Boolean), emails: mails.split(/[\s,;]+/).filter(Boolean) } }); },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['gw-alert-settings'] }); toast.show('შენახულია'); },
  });
  const test = useMutation({ mutationFn: () => api<{ sms: string[]; email: string[]; errors: string[] }>('/lab/gateway/alerts/test', { method: 'POST' }) });
  if (!f) return <Loading />;
  const DAYS = ['ორშ', 'სამ', 'ოთხ', 'ხუთ', 'პარ', 'შაბ', 'კვი'];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(320px, 440px) 1fr', gap: 16, alignItems: 'start' }}>
      <section className="card card-pad stack">
        <label className="row"><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> <strong>გაფრთხილებები ჩართულია</strong></label>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <Field label="კავშირი არ არის (წთ)" htmlFor="ad"><input id="ad" className="input mono" style={{ width: 90 }} value={f.disconnect_minutes} onChange={(e) => setF({ ...f, disconnect_minutes: Number(e.target.value.replace(/\D/g, '')) || 0 })} /></Field>
          <Field label="„ჩუმი“ (წთ)" htmlFor="as" hint="კავშირი არის, მონაცემები — არა"><input id="as" className="input mono" style={{ width: 90 }} value={f.silent_minutes} onChange={(e) => setF({ ...f, silent_minutes: Number(e.target.value.replace(/\D/g, '')) || 0 })} /></Field>
        </div>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <Field label="სამუშაო საათები" htmlFor="aws"><div className="row" style={{ gap: 4 }}><input id="aws" type="time" className="input" style={{ width: 110 }} value={f.work_start} onChange={(e) => setF({ ...f, work_start: e.target.value })} />–
            <input aria-label="დასასრული" type="time" className="input" style={{ width: 110 }} value={f.work_end} onChange={(e) => setF({ ...f, work_end: e.target.value })} /></div></Field>
        </div>
        <div className="row small" style={{ gap: 8, flexWrap: 'wrap' }}>{DAYS.map((d, i) => <label key={d} className="row" style={{ gap: 4 }}><input type="checkbox" checked={f.work_days.includes(i + 1)}
          onChange={(e) => setF({ ...f, work_days: e.target.checked ? [...f.work_days, i + 1] : f.work_days.filter((x) => x !== i + 1) })} />{d}</label>)}</div>
        <span className="hint">„ჩუმი“ ანალიზატორი მოწმდება მხოლოდ სამუშაო საათებში; კავშირის გაწყვეტა — ყოველთვის.</span>
        <Field label="SMS — ტელეფონები" htmlFor="asm" hint={notify?.sms ? 'თითო ხაზზე' : 'SMS სერვისი არ არის კონფიგურირებული (.env: SMS_API_URL, SMS_API_TOKEN)'}><textarea id="asm" className="textarea mono" rows={2} value={f.sms} onChange={(e) => setF({ ...f, sms: e.target.value })} placeholder="5XXXXXXXX" /></Field>
        <Field label="ელ-ფოსტა" htmlFor="aem" hint={notify?.email ? 'თითო ხაზზე' : 'SMTP არ არის კონფიგურირებული (.env: SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM)'}><textarea id="aem" className="textarea mono" rows={2} value={f.mails} onChange={(e) => setF({ ...f, mails: e.target.value })} placeholder="it@innovamedical.ge" /></Field>
        <label className="row small"><input type="checkbox" checked={f.notify_resolved} onChange={(e) => setF({ ...f, notify_resolved: e.target.checked })} /> შეტყობინება აღდგენისასაც</label>
        <ErrorBox error={save.error ?? test.error} />
        <div className="row"><button className="btn" type="button" disabled={test.isPending} onClick={() => test.mutate()}>სატესტო შეტყობინება</button>
          <button className="btn primary" type="button" style={{ marginLeft: 'auto' }} disabled={save.isPending} onClick={() => save.mutate()}>შენახვა</button></div>
        {test.data && <div className={`alert ${test.data.errors.length ? 'warn' : 'ok'} small`}>გაიგზავნა: {[...test.data.sms, ...test.data.email].join(', ') || '—'}{test.data.errors.length ? ` · ${test.data.errors.join('; ')}` : ''}</div>}
      </section>
      <section className="card">
        <div className="card-pad" style={{ paddingBottom: 0 }}><strong>ისტორია</strong></div>
        {h.isLoading ? <Loading /> : !h.data?.length ? <div className="empty small">გაფრთხილებები არ ყოფილა.</div> : (
          <table className="table"><tbody>{h.data.map((a) => (
            <tr key={a.id}>
              <td className="small mono" style={{ whiteSpace: 'nowrap' }}>{tsDate(a.started_at)} {time(a.started_at)}</td>
              <td className="small">{a.message}{a.notified?.errors?.length ? <div className="muted">{a.notified.errors.join('; ')}</div> : null}</td>
              <td className="small">{a.resolved_at ? <span className="chip ok">დაიხურა {time(a.resolved_at)}</span> : <span className="chip danger">ღიაა</span>}</td>
            </tr>))}</tbody></table>
        )}
      </section>
      {toast.node}
    </div>
  );
}
