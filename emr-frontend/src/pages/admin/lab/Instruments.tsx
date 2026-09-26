import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useMemo, useState } from 'react';
import { api } from '../../../api/client';
import type { DxService } from '../../../api/types';
import { ErrorBox, Field, Loading, Modal, useToast } from '../../../components/ui';
import { time, tsDate, unitFmt } from '../../../lib/format';

// ============================================================ ტიპები
export interface GatewayState { alive: boolean; heartbeat_at: string | null; listen_ports: [number, number] }
export interface InstrumentRow {
  method_id: string; name: string; is_active: boolean; id: string | null; protocol: 'astm' | 'hl7' | null; conn_mode: 'client' | 'server' | null; host: string | null; port: number | null;
  is_enabled: boolean | null; order_mode: string | null; status: string | null; status_at: string | null; peer: string | null; last_message_at: string | null; last_error: string | null;
  codes: number | string | null; unmatched: number | string | null;
}
interface Instrument { id: string; protocol: 'astm' | 'hl7'; conn_mode: 'client' | 'server'; host: string | null; port: number; is_enabled: boolean; order_mode: 'none' | 'query' | 'push';
  settings: Record<string, unknown>; status: string; peer: string | null; last_error: string | null; last_message_at: string | null }
interface CodeRow { code: string; analyte_id: string | null; service_id: string | null; factor: string | number; send_order: boolean; analyte_name?: string | null; unit?: string | null; service_name?: string | null }
interface Detail { method: { id: string; name: string; is_active: boolean }; instrument: Instrument | null; codes: CodeRow[] }
interface Msg { id: string; direction: 'in' | 'out'; kind: string; summary: string | null; raw: string; error: string | null; created_at: string }
interface InboxRow { id: string; barcode: string | null; code: string; value: string | null; unit: string | null; flags: string | null; status: string; reason: string | null; rerun: boolean;
  created_at: string; instrument: string; analyte_name: string | null; patient_name: string | null; order_item_id: string | null }
interface Analyte { id: string; code: string; name: string; unit: string; is_active: boolean }

export const useGateway = () => useQuery({ queryKey: ['lab-gateway'], queryFn: () => api<GatewayState>('/lab/gateway'), refetchInterval: 30_000 });
export const useInstruments = () => useQuery({ queryKey: ['lab-instruments'], queryFn: () => api<InstrumentRow[]>('/lab/instruments'), refetchInterval: 10_000 });

const STATUS: Record<string, [string, string]> = {
  connected: ['ok', 'დაკავშირებული'], listening: ['info', 'ელოდება ანალიზატორს'], connecting: ['warn', 'კავშირი…'], error: ['danger', 'შეცდომა'], offline: ['', 'გათიშული'],
};
export function ConnChip({ r }: { r: Pick<InstrumentRow, 'id' | 'is_enabled' | 'status' | 'last_error'> }) {
  if (!r.id) return <span className="small muted">კავშირი არ არის</span>;
  if (!r.is_enabled) return <span className="chip">გამორთული</span>;
  const [cls, l] = STATUS[r.status ?? 'offline'] ?? STATUS.offline;
  return <span className={`chip ${cls}`} title={r.last_error ?? undefined}>{l}</span>;
}

export function GatewayBanner() {
  const g = useGateway();
  if (!g.data || g.data.alive) return null;
  return <div className="alert warn">emr-lab-gateway არ მუშაობს{g.data.heartbeat_at ? ` (ბოლო სიგნალი ${tsDate(g.data.heartbeat_at)} ${time(g.data.heartbeat_at)})` : ''} — ანალიზატორები არ უკავშირდება. სერვერზე: <span className="mono">docker compose … up -d emr-lab-gateway</span></div>;
}

// ============================================================ ანალიზატორის კავშირი: პარამეტრები | კოდები | ჟურნალი
export function InstrumentPanel({ methodId, canEdit }: { methodId: string; canEdit: boolean }) {
  const [tab, setTab] = useState<'conn' | 'codes' | 'log'>('conn');
  const d = useQuery({ queryKey: ['lab-instrument', methodId], queryFn: () => api<Detail>(`/lab/instruments/${methodId}`) });
  if (d.isLoading || !d.data) return <Loading />;
  return (
    <div className="stack">
      <div className="seg" role="group" aria-label="ანალიზატორის კავშირი">
        <button type="button" aria-pressed={tab === 'conn'} onClick={() => setTab('conn')}>კავშირი</button>
        <button type="button" aria-pressed={tab === 'codes'} disabled={!d.data.instrument} onClick={() => setTab('codes')}>კოდები ({d.data.codes.length})</button>
        <button type="button" aria-pressed={tab === 'log'} disabled={!d.data.instrument} onClick={() => setTab('log')}>ჟურნალი</button>
      </div>
      {tab === 'conn' && <Conn d={d.data} canEdit={canEdit} />}
      {tab === 'codes' && <Codes d={d.data} canEdit={canEdit} />}
      {tab === 'log' && <Log methodId={methodId} />}
    </div>
  );
}

function Conn({ d, canEdit }: { d: Detail; canEdit: boolean }) {
  const qc = useQueryClient(); const toast = useToast(); const g = useGateway();
  const i = d.instrument;
  const [f, setF] = useState({ protocol: i?.protocol ?? 'astm', conn_mode: i?.conn_mode ?? 'client', host: i?.host ?? '', port: String(i?.port ?? 4001), is_enabled: i?.is_enabled ?? false,
    order_mode: i?.order_mode ?? 'query', settings: (i?.settings ?? {}) as Record<string, unknown> });
  const set = (k: string, v: unknown) => setF({ ...f, settings: { ...f.settings, [k]: v } });
  const save = useMutation({
    mutationFn: () => api<Detail>(`/lab/instruments/${d.method.id}`, { method: 'PUT', body: { ...f, port: Number(f.port), host: f.conn_mode === 'client' ? f.host.trim() : null } }),
    onSuccess: (r) => { qc.setQueryData(['lab-instrument', d.method.id], r); void qc.invalidateQueries({ queryKey: ['lab-instruments'] }); toast.show('შენახულია — gateway 5 წამში გამოიყენებს'); },
  });
  const [p0, p1] = g.data?.listen_ports ?? [4100, 4109];
  return (
    <fieldset disabled={!canEdit} className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
      {i && <div className="row small" style={{ flexWrap: 'wrap', gap: 10 }}>
        <ConnChip r={{ id: i.id, is_enabled: i.is_enabled, status: i.status, last_error: i.last_error }} />
        {i.peer && <span className="mono muted">{i.peer}</span>}
        {i.last_message_at && <span className="muted">ბოლო შეტყობინება: {tsDate(i.last_message_at)} {time(i.last_message_at)}</span>}
        {i.last_error && i.status === 'error' && <span style={{ color: 'var(--danger-ink)' }}>{i.last_error}</span>}
      </div>}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="პროტოკოლი" htmlFor="ip"><select id="ip" className="select" value={f.protocol} onChange={(e) => setF({ ...f, protocol: e.target.value as 'astm' | 'hl7' })}>
          <option value="astm">ASTM E1381/E1394</option><option value="hl7">HL7 v2 (MLLP)</option></select></Field>
        <Field label="ვინ უკავშირდება" htmlFor="im" hint={f.conn_mode === 'client' ? 'EMR უკავშირდება ანალიზატორს / Moxa-ს (TCP Server რეჟიმი)' : 'ანალიზატორი უკავშირდება EMR-ს (სერვერის IP-ზე)'}>
          <select id="im" className="select" value={f.conn_mode} onChange={(e) => setF({ ...f, conn_mode: e.target.value as 'client' | 'server', port: e.target.value === 'server' ? String(p0) : f.port })}>
            <option value="client">EMR → ანალიზატორი (კლიენტი)</option><option value="server">ანალიზატორი → EMR (სერვერი)</option></select></Field>
        {f.conn_mode === 'client' && <Field label="IP / მისამართი" htmlFor="ih" hint="მაგ. Moxa 10.10.5.220"><input id="ih" className="input mono" value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} /></Field>}
        <Field label="პორტი" htmlFor="ipt" hint={f.conn_mode === 'server' ? `${p0}–${p1} (სერვერზე გახსნილი დიაპაზონი)` : 'Moxa: 4001–4004 (პორტი 1–4)'}>
          <input id="ipt" className="input mono" inputMode="numeric" value={f.port} onChange={(e) => setF({ ...f, port: e.target.value.replace(/\D/g, '') })} /></Field>
        <Field label="შეკვეთები ანალიზატორზე" htmlFor="io"><select id="io" className="select" value={f.order_mode} onChange={(e) => setF({ ...f, order_mode: e.target.value as 'none' | 'query' | 'push' })}>
          <option value="query">ანალიზატორი კითხულობს შტრიხკოდით (host query)</option><option value="push">EMR აგზავნის სინჯარის მიღებისას (worklist)</option><option value="none">არა — მხოლოდ შედეგები</option></select></Field>
      </div>
      <details>
        <summary className="small" style={{ cursor: 'pointer' }}>დამატებითი (ანალიზატორის დოკუმენტაციის მიხედვით)</summary>
        <div className="row" style={{ flexWrap: 'wrap', gap: 12, marginTop: 8 }}>
          {f.protocol === 'astm' ? <>
            <label className="row small">შტრიხკოდი O-ს ველში <input className="input mono" style={{ width: 56, height: 32 }} value={String(f.settings.specimen_field ?? 3)} onChange={(e) => set('specimen_field', Number(e.target.value) || 3)} /></label>
            <label className="row small">ტესტის კოდი კომპონენტში <input className="input mono" style={{ width: 56, height: 32 }} value={String(f.settings.code_component ?? 4)} onChange={(e) => set('code_component', Number(e.target.value) || 4)} /></label>
            <label className="row small">ქვერის შტრიხკოდი კომპონენტში <input className="input mono" style={{ width: 56, height: 32 }} placeholder="ავტო" value={String(f.settings.query_component ?? '')} onChange={(e) => set('query_component', Number(e.target.value) || undefined)} /></label>
          </> : <>
            <label className="row small">შტრიხკოდი <select className="select" style={{ height: 32 }} value={String(f.settings.barcode_field ?? 'OBR-3')} onChange={(e) => set('barcode_field', e.target.value)}>{['OBR-3', 'OBR-2', 'SPM-2', 'ORC-3'].map((x) => <option key={x}>{x}</option>)}</select></label>
            <label className="row small">OBX-3 კომპონენტი <input className="input mono" style={{ width: 56, height: 32 }} value={String(f.settings.code_component ?? 1)} onChange={(e) => set('code_component', Number(e.target.value) || 1)} /></label>
            <label className="row small">HL7 ვერსია <select className="select" style={{ height: 32 }} value={String(f.settings.hl7_version ?? '2.3.1')} onChange={(e) => set('hl7_version', e.target.value)}>{['2.3.1', '2.4', '2.5', '2.5.1'].map((x) => <option key={x}>{x}</option>)}</select></label>
          </>}
          <label className="row small"><input type="checkbox" checked={f.settings.send_patient_name === true} onChange={(e) => set('send_patient_name', e.target.checked)} /> პაციენტის სახელის გაგზავნა (ნაგულისხმევად — მხოლოდ ID)</label>
        </div>
      </details>
      <label className="row"><input type="checkbox" checked={f.is_enabled} onChange={(e) => setF({ ...f, is_enabled: e.target.checked })} /> <strong>ჩართული</strong> <span className="small muted">— gateway დაუკავშირდება / დაელოდება ანალიზატორს</span></label>
      <ErrorBox error={save.error} />
      {canEdit && <div className="row"><button className="btn primary" type="button" style={{ marginLeft: 'auto' }} disabled={!f.port || (f.conn_mode === 'client' && !f.host.trim()) || save.isPending} onClick={() => save.mutate()}>შენახვა</button></div>}
      {toast.node}
    </fieldset>
  );
}

// ---------------------------------------------------------------- კოდების რუკა
function Codes({ d, canEdit }: { d: Detail; canEdit: boolean }) {
  const qc = useQueryClient(); const toast = useToast();
  const services = useQuery({ queryKey: ['dx-catalog', 'lab'], queryFn: () => api<DxService[]>('/dx/catalog', { query: { section: 'lab' } }) });
  const analytes = useQuery({ queryKey: ['lab-all-analytes'], queryFn: () => api<(Analyte & { service_id: string; service_name: string })[]>('/lab/norms').then((rows) =>
    (rows as unknown as { id: string; code: string; name: string; unit: string; service_id: string; service_name: string }[]).map((r) => ({ ...r, is_active: true }))) });
  const [rows, setRows] = useState<CodeRow[]>(d.codes.map((c) => ({ ...c, factor: String(Number(c.factor)) })));
  const [paste, setPaste] = useState(''); const [filter, setFilter] = useState('');
  const aList = analytes.data ?? [];
  const save = useMutation({
    mutationFn: () => api<Detail>(`/lab/instruments/${d.method.id}/codes`, { method: 'PUT', body: { codes: rows.map((r) => ({ code: r.code.trim(), analyte_id: r.analyte_id || null, service_id: r.service_id || null,
      factor: Number(String(r.factor).replace(',', '.')) || 1, send_order: r.send_order })) } }),
    onSuccess: (r) => { qc.setQueryData(['lab-instrument', d.method.id], r); setRows(r.codes.map((c) => ({ ...c, factor: String(Number(c.factor)) }))); void qc.invalidateQueries({ queryKey: ['lab-instruments'] }); toast.show('კოდები შენახულია'); },
  });
  /** ჩასმა: „ანალიზატორის_კოდი TAB/;/= EMR_კოდი“ ხაზებით; EMR-ის კოდი — კომპონენტის (ან კვლევის) კოდი */
  const applyPaste = () => {
    const add: CodeRow[] = []; const miss: string[] = [];
    for (const line of paste.split(/\r?\n/)) {
      const [ic, ec] = line.split(/\t|;|=|,/).map((x) => x?.trim());
      if (!ic) continue;
      const target = (ec || ic).toUpperCase();
      const a = aList.find((x) => x.code.toUpperCase() === target);
      const s = !a ? services.data?.find((x) => x.code.toUpperCase() === target) : undefined;
      if (a) add.push({ code: ic, analyte_id: a.id, service_id: null, factor: '1', send_order: true, analyte_name: a.name, unit: a.unit });
      else if (s) add.push({ code: ic, analyte_id: null, service_id: s.id, factor: '1', send_order: true, service_name: s.name });
      else miss.push(ic);
    }
    const codes = new Set(add.map((x) => x.code.toUpperCase()));
    setRows([...rows.filter((r) => !codes.has(r.code.toUpperCase())), ...add]); setPaste('');
    toast.show(`დაემატა ${add.length}${miss.length ? `; ვერ მოიძებნა: ${miss.slice(0, 10).join(', ')}${miss.length > 10 ? '…' : ''}` : ''}`);
  };
  const shown = rows.map((r, i) => ({ r, i })).filter(({ r }) => !filter.trim() || `${r.code} ${aList.find((a) => a.id === r.analyte_id)?.name ?? ''}`.toLowerCase().includes(filter.trim().toLowerCase()));
  const upd = (i: number, patch: Partial<CodeRow>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const grouped = useMemo(() => {
    const m = new Map<string, typeof aList>(); for (const a of aList) m.set(a.service_name, [...(m.get(a.service_name) ?? []), a]); return [...m.entries()];
  }, [aList]);
  return (
    <fieldset disabled={!canEdit} className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
      <span className="hint">ანალიზატორის კოდი → EMR-ის <strong>კომპონენტი</strong> (შედეგი და შეკვეთა) ან <strong>კვლევა</strong> (მხოლოდ შეკვეთა — პანელი, მაგ. სისხლის საერთო ერთი კოდით). კოეფიციენტი — ერთეულის გადაყვანა: EMR = ანალიზატორი × კოეფ. (მაგ. კრეატინინი mg/dL → µmol/L = 88.42). ერთეულის შეუსაბამობისას შედეგი „დასამუშავებელში“ ხვდება.</span>
      <div className="row"><input aria-label="ფილტრი" className="input" style={{ maxWidth: 220, height: 34 }} placeholder="ფილტრი" value={filter} onChange={(e) => setFilter(e.target.value)} /><span className="grow" />
        {canEdit && <button className="btn sm" type="button" onClick={() => setRows([...rows, { code: '', analyte_id: null, service_id: null, factor: '1', send_order: true }])}>+ კოდი</button>}</div>
      <div style={{ maxHeight: 380, overflowY: 'auto' }}>
        <table className="table">
          <thead><tr><th>ანალიზატორის კოდი</th><th>EMR</th><th>კოეფ.</th><th>შეკვეთაში</th><th /></tr></thead>
          <tbody>{shown.map(({ r, i }) => (
            <tr key={i}>
              <td><input aria-label="კოდი" className="input mono" style={{ height: 32, width: 120 }} value={r.code} onChange={(e) => upd(i, { code: e.target.value })} /></td>
              <td><select aria-label="EMR" className="select" style={{ height: 32, fontSize: 13, maxWidth: 360 }} value={r.analyte_id ? `a:${r.analyte_id}` : r.service_id ? `s:${r.service_id}` : ''}
                onChange={(e) => { const [k, id] = e.target.value.split(':'); upd(i, { analyte_id: k === 'a' ? id : null, service_id: k === 's' ? id : null }); }}>
                <option value="">— აირჩიეთ</option>
                {grouped.map(([svc, as]) => <optgroup key={svc} label={svc}>{as.map((a) => <option key={a.id} value={`a:${a.id}`}>{a.name} ({a.code}{a.unit ? `, ${unitFmt(a.unit)}` : ''})</option>)}</optgroup>)}
                <optgroup label="კვლევა (პანელი — მხოლოდ შეკვეთა)">{services.data?.map((s) => <option key={s.id} value={`s:${s.id}`}>{s.name}</option>)}</optgroup>
              </select></td>
              <td><input aria-label="კოეფიციენტი" className="input mono" style={{ height: 32, width: 72 }} disabled={!!r.service_id} value={String(r.factor)} onChange={(e) => upd(i, { factor: e.target.value })} /></td>
              <td><input type="checkbox" aria-label="შეკვეთაში" checked={r.send_order} onChange={(e) => upd(i, { send_order: e.target.checked })} /></td>
              <td><button className="icon-btn" type="button" aria-label="წაშლა" onClick={() => setRows(rows.filter((_, j) => j !== i))}>×</button></td>
            </tr>))}</tbody>
        </table>
      </div>
      {canEdit && <details>
        <summary className="small" style={{ cursor: 'pointer' }}>სიის ჩასმა (Excel-იდან / ანალიზატორის დოკუმენტაციიდან)</summary>
        <div className="stack" style={{ marginTop: 6 }}>
          <textarea className="textarea mono" rows={5} placeholder={'ANALYZER_CODE<TAB>EMR_კოდი\nGLUC3\tGLU\nCREJ2\tCREA\nHGB   (თუ ერთნაირია — მარტო ერთი)'} value={paste} onChange={(e) => setPaste(e.target.value)} />
          <div className="row"><button className="btn sm" type="button" disabled={!paste.trim()} onClick={applyPaste}>დამატება სიაში</button><span className="hint">EMR-ის კოდი — კომპონენტის ან კვლევის კოდი კატალოგიდან</span></div>
        </div>
      </details>}
      <ErrorBox error={save.error} />
      {canEdit && <div className="row"><span className="small muted grow">{rows.length} კოდი</span><button className="btn primary" type="button" disabled={save.isPending || rows.some((r) => !r.code.trim() || (!r.analyte_id && !r.service_id))} onClick={() => save.mutate()}>კოდების შენახვა</button></div>}
      {toast.node}
    </fieldset>
  );
}

// ---------------------------------------------------------------- ჟურნალი
function Log({ methodId }: { methodId: string }) {
  const q = useQuery({ queryKey: ['lab-instrument-log', methodId], queryFn: () => api<Msg[]>(`/lab/instruments/${methodId}/messages`, { query: { limit: 100 } }), refetchInterval: 5000 });
  const [open, setOpen] = useState<string | null>(null);
  if (q.isLoading) return <Loading />;
  if (!q.data?.length) return <div className="empty small">შეტყობინებები ჯერ არ არის (ინახება 30 დღე).</div>;
  const KIND: Record<string, string> = { results: 'შედეგები', query: 'ქვერი', orders: 'შეკვეთა', ack: 'ACK', other: 'სხვა' };
  return (
    <div style={{ maxHeight: 420, overflowY: 'auto' }}>
      <table className="table"><tbody>{q.data.map((m) => (<Fragment key={m.id}>
        <tr className="clickable" onClick={() => setOpen(open === m.id ? null : m.id)}>
          <td className="small mono" style={{ whiteSpace: 'nowrap' }}>{tsDate(m.created_at)} {time(m.created_at)}</td>
          <td>{m.direction === 'in' ? <span className="chip info">← შემოვიდა</span> : <span className="chip">→ გაიგზავნა</span>}</td>
          <td className="small">{KIND[m.kind] ?? m.kind}</td>
          <td className="small">{m.summary}{m.error && <div style={{ color: 'var(--danger-ink)' }}>{m.error}</div>}</td>
        </tr>
        {open === m.id && <tr><td colSpan={4}><pre className="mono small" style={{ whiteSpace: 'pre-wrap', margin: 0, background: 'var(--bg)', padding: 8, borderRadius: 6, maxHeight: 260, overflow: 'auto' }}>{m.raw}</pre></td></tr>}
      </Fragment>))}</tbody></table>
    </div>
  );
}

// ============================================================ დასამუშავებელი შედეგები (ლაბორატორიისთვის)
export function useInboxCount() {
  return useQuery({ queryKey: ['lab-inbox-count'], queryFn: () => api<{ unmatched: number }>('/lab/instrument-results/count'), refetchInterval: 20_000 });
}
export function InstrumentInbox({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState('unmatched');
  const q = useQuery({ queryKey: ['lab-inbox', status], queryFn: () => api<InboxRow[]>('/lab/instrument-results', { query: { status } }), refetchInterval: 10_000 });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['lab-inbox'] }); void qc.invalidateQueries({ queryKey: ['lab-inbox-count'] }); void qc.invalidateQueries({ queryKey: ['lab-worklist'] }); };
  const retry = useMutation({ mutationFn: (id: string) => api<{ status: string; reason: string | null }>(`/lab/instrument-results/${id}/retry`, { method: 'POST' }), onSuccess: refresh });
  const dismiss = useMutation({ mutationFn: ({ id, reason }: { id: string; reason: string }) => api(`/lab/instrument-results/${id}/dismiss`, { body: { reason } }), onSuccess: refresh });
  const S: Record<string, [string, string]> = { unmatched: ['warn', 'დასამუშავებელი'], applied: ['ok', 'მიბმული'], dismissed: ['', 'უარყოფილი'], pending: ['info', 'მუშავდება'] };
  return (
    <Modal title="ანალიზატორების შედეგები" onClose={onClose} width={1100}>
      <div className="row">
        <div className="seg" role="group" aria-label="სტატუსი">{[['unmatched', 'დასამუშავებელი'], ['applied', 'მიბმული'], ['dismissed', 'უარყოფილი'], ['all', 'ყველა']].map(([k, l]) =>
          <button key={k} type="button" aria-pressed={status === k} onClick={() => setStatus(k)}>{l}</button>)}</div>
        <span className="hint grow">დასამუშავებელი: შედეგი ვერ მიება შეკვეთას. გაასწორეთ მიზეზი (კოდების რუკა, სინჯარის მიღება) და დააჭირეთ „ხელახლა“, ან შეიყვანეთ ხელით და უარყავით.</span>
      </div>
      <ErrorBox error={retry.error ?? dismiss.error} />
      {q.isLoading ? <Loading /> : !q.data?.length ? <div className="empty">სია ცარიელია.</div> : (
        <div style={{ maxHeight: 520, overflowY: 'auto' }}>
          <table className="table">
            <thead><tr><th>დრო</th><th>ანალიზატორი</th><th>შტრიხკოდი / პაციენტი</th><th>კოდი → კომპონენტი</th><th>მნიშვნელობა</th><th>სტატუსი / მიზეზი</th><th /></tr></thead>
            <tbody>{q.data.map((r) => (
              <tr key={r.id}>
                <td className="small mono" style={{ whiteSpace: 'nowrap' }}>{tsDate(r.created_at)} {time(r.created_at)}</td>
                <td className="small">{r.instrument}</td>
                <td><span className="mono">{r.barcode ?? '—'}</span>{r.patient_name && <div className="small muted">{r.patient_name}</div>}</td>
                <td className="small"><span className="mono">{r.code}</span>{r.analyte_name && <> → {r.analyte_name}</>}</td>
                <td className="mono">{r.value}{r.unit ? ` ${unitFmt(r.unit)}` : ''}{r.flags && <span className="small muted"> {r.flags}</span>}{r.rerun && <div className="small muted">განმეორებითი</div>}</td>
                <td className="small"><span className={`chip ${S[r.status]?.[0] ?? ''}`}>{S[r.status]?.[1] ?? r.status}</span>{r.reason && <div>{r.reason}</div>}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{r.status === 'unmatched' && <>
                  <button className="btn sm" type="button" disabled={retry.isPending} onClick={() => retry.mutate(r.id)}>ხელახლა</button>{' '}
                  <button className="btn sm" type="button" onClick={() => { const reason = prompt('უარყოფის მიზეზი (მაგ. „შეყვანილია ხელით“, „სატესტო სინჯარა“)'); if (reason && reason.trim().length >= 3) dismiss.mutate({ id: r.id, reason: reason.trim() }); }}>უარყოფა</button>
                </>}</td>
              </tr>))}</tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
