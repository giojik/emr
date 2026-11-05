import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, api, openBlob } from '../../api/client';
import { SignDialog } from '../../components/ConsentsPanel';
import Form100Dialog from '../../components/Form100Dialog';
import { ErrorBox, Field, Loading, Modal, useToast } from '../../components/ui';
import { localISO, todayISO, tsDate } from '../../lib/format';
import IcdPicker from '../encounter/IcdPicker';
import { hm } from './types';

/**
 * 0090 — ER: გამოსავალი (ბარათის ჩანართი „გამოსავალი“).
 *  • სახეები: გაწერა სახლში / ჰოსპიტალიზაცია / გადაყვანა სხვა კლინიკაში / AMA / LWBS / გარდაცვალება;
 *  • შემოწმებები (block / warn / info — კლინიკის პარამეტრებით), warn → დასაბუთება;
 *  • ჰოსპიტალიზაცია: direct — ER-ის ექიმი აფორმებს; request — მოთხოვნა განყოფილებას; აქტიური დანიშნულებები — გაგრძელება / შეწყვეტა;
 *  • გამოსავლის შემდეგ: ER-ის ფურცელი (PDF), ფორმა 100, განახლება (დოკუმენტაციის ფანჯარა), გაუქმება (შეცდომა).
 */
export type DKind = 'home' | 'admitted' | 'transfer' | 'ama' | 'lwbs' | 'death';
export const DISP_KA: Record<DKind, string> = {
  home: 'გაწერა სახლში', admitted: 'ჰოსპიტალიზაცია', transfer: 'გადაყვანა სხვა კლინიკაში', ama: 'წავიდა რეკომენდაციის საწინააღმდეგოდ (AMA)',
  lwbs: 'წავიდა ექიმის ნახვამდე (LWBS)', death: 'გარდაცვალება',
};
export const DISP_SHORT: Record<DKind, string> = { home: 'სახლში', admitted: 'ჰოსპიტალიზაცია', transfer: 'გადაყვანა', ama: 'AMA', lwbs: 'LWBS', death: 'გარდაცვალება' };
const TRANSPORT_KA: Record<string, string> = { own: 'საკუთარი', ambulance: 'სასწრაფო', clinic_transport: 'კლინიკის ტრანსპორტი', other: 'სხვა' };
const SEVERITY_KA: Record<string, string> = { stable: 'სტაბილური', moderate: 'საშუალო', severe: 'მძიმე', critical: 'კრიტიკული' };
const ISOLATION_KA: Record<string, string> = { contact: 'კონტაქტური', droplet: 'წვეთოვანი', airborne: 'ჰაერწვეთოვანი', protective: 'დამცავი' };
interface Check { code: string; level: 'block' | 'warn' | 'info'; message: string }
interface OrderRow { id: string; label: string; kind: string; order_type: string; running: boolean; untransferable: string | null; default: 'continue' | 'stop' }
interface Disp {
  id: string; kind: DKind; decided_at: string; departed_at: string; decided_by_name: string | null; recommendations: string | null; note: string | null;
  destination_name: string | null; destination_text: string | null; transport: string | null; transfer_reason: string | null; receiver: string | null;
  death_at: string | null; death_icd10_code: string | null; death_icd10_title: string | null; autopsy_required: boolean | null; dead_on_arrival: boolean;
  inpatient_encounter_id: string | null; adm_no: string | null; admit_department: string | null; summary_number: string | null; summary_status: string | null;
  orders_result: { continued?: { er_order_id: string; med_order_id: string }[]; stopped?: string[] }; overrides: { reason: string; warnings: { message: string }[] } | null;
  reopened_at: string | null; reopen_reason: string | null; refusal_consent_id: string | null; refusal_witnesses: string[] | null; ama_reason: string | null;
}
interface AdmitReq {
  id: string; status: 'requested' | 'accepted' | 'rejected' | 'cancelled'; department_name: string; attending_name: string | null; icd10_code: string; icd10_title: string;
  requested_at: string; requested_by_name: string; decided_at: string | null; decided_by_name: string | null; decision_reason: string | null; note: string | null;
}
export interface DispInfo {
  status: string; open: boolean; doc_open: boolean; doc_closes_at: string | null;
  settings: { admit_mode: 'direct' | 'request'; transfer_orders: 'reconcile' | 'stop_all'; ama_proof: 'consent_or_witnesses' | 'reason'; recommendations_required: boolean;
    doc_window_h: number; reopen_h: number; summary_mode: 'builtin' | 'template'; admit_invoice?: 'merge' | 'separate' | 'ask'; fee_mode?: string; unpaid_check?: string };
  modules: { inpatient: boolean; ipd_orders: boolean };
  checks: Record<DKind, Check[]>; orders: OrderRow[]; disposition: Disp | null; history: Disp[]; requests: AdmitReq[];
  can: { dispose: boolean; lwbs: boolean; request: boolean; regenerate: boolean; reopen: boolean };
}
interface AdmitOptions { departments: { id: string; name: string; doctors: { id: string; name: string; specialty: string | null }[] }[]; institutions: { id: string; name: string }[] }
const hhmmNow = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tbilisi', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());

export default function ErDispositionPanel({ encounterId, patientId, primaryDx, onChanged }: {
  encounterId: string; patientId: string; primaryDx?: { code: string; title: string } | null; onChanged: () => void;
}) {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['er-disp', encounterId], queryFn: () => api<DispInfo>(`/er/visits/${encounterId}/disposition`) });
  const [f100, setF100] = useState(false); const [reopen, setReopen] = useState(false); const [reason, setReason] = useState('');
  const inv = () => { void qc.invalidateQueries({ queryKey: ['er-disp', encounterId] }); onChanged(); };
  const regen = useMutation({ mutationFn: () => api<{ number: string }>(`/er/visits/${encounterId}/summary`, { method: 'POST' }), onSuccess: (r) => { toast.show(`ER-ის ფურცელი განახლდა (${r.number})`); inv(); } });
  const reop = useMutation({ mutationFn: () => api(`/er/visits/${encounterId}/reopen`, { body: { reason: reason.trim() } }), onSuccess: () => { setReopen(false); toast.show('გამოსავალი გაუქმდა'); inv(); } });
  const cancelReq = useMutation({ mutationFn: (rid: string) => api(`/er/admit-requests/${rid}/cancel`, { body: { reason: 'ER-ის ექიმმა გააუქმა' } }), onSuccess: inv });
  if (!q.data) return q.error ? <ErrorBox error={q.error} /> : <Loading />;
  const d = q.data; const x = d.disposition;
  const pending = d.requests.find((r) => r.status === 'requested');
  return (
    <div className="stack" style={{ gap: 12 }} data-testid="er-disposition">
      {toast.node}
      {x ? <section className="card card-pad stack" style={{ gap: 8 }} data-testid="er-disp-done">
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <span className={`chip ${x.kind === 'death' ? 'danger' : x.kind === 'admitted' ? 'info' : 'ok'}`}>{DISP_KA[x.kind]}</span>
          <span className="small muted">{tsDate(x.departed_at)} {hm(x.departed_at)} · {x.decided_by_name}</span>
          <span className="grow" />
          {x.summary_number && <button className="btn sm" type="button" data-ro-ok onClick={() => openBlob(`/er/visits/${encounterId}/summary/pdf`).catch(() => undefined)}>ER-ის ფურცელი ({x.summary_number})</button>}
          {(d.can.regenerate) && <button className="btn sm" type="button" onClick={() => regen.mutate()} disabled={regen.isPending}>ფურცლის განახლება</button>}
          {(d.can.regenerate || d.doc_open) && <button className="btn sm" type="button" onClick={() => setF100(true)}>ფორმა №100/ა</button>}
          {d.can.reopen && <button className="btn sm" type="button" style={{ color: 'var(--danger)' }} onClick={() => setReopen(true)}>გაუქმება (შეცდომა)</button>}
        </div>
        {x.kind === 'admitted' && <div>განყოფილება: <strong>{x.admit_department}</strong>{x.adm_no && <> · <Link to={`/inpatient/stay/${x.inpatient_encounter_id}`}>{x.adm_no}</Link></>}
          {(x.orders_result.continued?.length ?? 0) > 0 && <span className="small muted"> · გადატანილი დანიშნულება: {x.orders_result.continued!.length}</span>}
          {(x.orders_result.stopped?.length ?? 0) > 0 && <span className="small muted"> · შეწყვეტილი: {x.orders_result.stopped!.length}</span>}</div>}
        {x.kind === 'transfer' && <div className="small">{x.destination_name ?? x.destination_text} — {x.transfer_reason}{x.transport ? ` · ${TRANSPORT_KA[x.transport]}` : ''}{x.receiver ? ` · მიმღები: ${x.receiver}` : ''}</div>}
        {x.kind === 'death' && <div className="small">გარდაცვალება: {tsDate(x.death_at!)} {hm(x.death_at)} · {x.death_icd10_code} — {x.death_icd10_title} · აუტოფსია: {x.autopsy_required ? 'საჭიროა' : 'არა'}{x.dead_on_arrival ? ' · შემოყვანილია გარდაცვლილი' : ''}</div>}
        {x.kind === 'ama' && <div className="small">{x.refusal_consent_id ? 'ხელწერილი ხელმოწერილია' : x.refusal_witnesses?.length ? `ხელმოწერაზე უარი — ${x.refusal_witnesses.length} მოწმე` : `მიზეზი: ${x.ama_reason ?? '—'}`}</div>}
        {x.recommendations && <div className="small"><span className="muted">რეკომენდაციები:</span> {x.recommendations}</div>}
        {x.overrides && <div className="small muted">დასაბუთება: {x.overrides.reason} ({x.overrides.warnings.map((w) => w.message).join('; ')})</div>}
        {d.doc_open ? <div className="alert info small">დოკუმენტაციის ფანჯარა ღიაა — {d.doc_closes_at ? `${tsDate(d.doc_closes_at)} ${hm(d.doc_closes_at)}-მდე` : ''}: ჩანაწერის ხელმოწერა / შესწორება, ICD-10, ფურცლის განახლება.</div>
          : <div className="small muted">დოკუმენტაცია დახურულია.</div>}
        <ErrorBox error={regen.error} />
      </section>
      : !d.open ? <div className="card empty">ER-ის შემთხვევა დახურულია.</div>
      : <>
        {pending && <section className="card card-pad stack" style={{ gap: 6, borderColor: 'var(--warn-line)' }} data-testid="er-admit-pending">
          <div className="row" style={{ gap: 8 }}><span className="chip warn">ჰოსპიტალიზაციის მოთხოვნა — მოლოდინში</span><span className="small muted">{tsDate(pending.requested_at)} {hm(pending.requested_at)} · {pending.requested_by_name}</span>
            <span className="grow" />{d.can.request && <button className="btn sm" type="button" onClick={() => cancelReq.mutate(pending.id)} disabled={cancelReq.isPending}>მოთხოვნის გაუქმება</button>}</div>
          <div className="small">{pending.department_name}{pending.attending_name ? ` · ${pending.attending_name}` : ''} · {pending.icd10_code} — {pending.icd10_title}</div>
          <ErrorBox error={cancelReq.error} />
        </section>}
        {(d.can.dispose || d.can.lwbs) ? <DispositionForm info={d} encounterId={encounterId} patientId={patientId} primaryDx={primaryDx ?? null} hasPending={!!pending} onDone={() => { toast.show('გამოსავალი გაფორმდა'); inv(); }} />
          : <div className="card empty">გამოსავალს აფორმებს ER-ის ექიმი{d.checks.lwbs.length === 0 ? ' (LWBS — ER-ის თანამშრომელი)' : ''}.</div>}
      </>}
      {d.requests.filter((r) => r.status !== 'requested').length > 0 && <section className="card"><div className="card-head"><h2>ჰოსპიტალიზაციის მოთხოვნები</h2></div>
        <table className="table"><tbody>{d.requests.filter((r) => r.status !== 'requested').map((r) => <tr key={r.id}><td className="small">{tsDate(r.requested_at)} {hm(r.requested_at)}</td>
          <td>{r.department_name}</td><td className="small">{{ accepted: 'მიღებულია', rejected: 'უარყოფილია', cancelled: 'გაუქმებულია', requested: '' }[r.status]}{r.decision_reason ? ` — ${r.decision_reason}` : ''}</td>
          <td className="small">{r.decided_by_name}</td></tr>)}</tbody></table></section>}
      {d.history.length > 0 && <section className="card"><div className="card-head"><h2>გაუქმებული გამოსავალი</h2></div>
        <table className="table"><tbody>{d.history.map((h) => <tr key={h.id}><td className="small">{tsDate(h.decided_at)} {hm(h.decided_at)}</td><td>{DISP_KA[h.kind]}</td>
          <td className="small">გაუქმდა {tsDate(h.reopened_at!)} {hm(h.reopened_at)} — {h.reopen_reason}</td></tr>)}</tbody></table></section>}
      {f100 && <Form100Dialog encounterId={encounterId} onClose={() => setF100(false)} />}
      {reopen && <Modal title="გამოსავლის გაუქმება (შეცდომა)" onClose={() => setReopen(false)} width={480}
        footer={<><button className="btn" type="button" onClick={() => setReopen(false)}>დახურვა</button><button className="btn primary" type="button" disabled={reason.trim().length < 3 || reop.isPending} onClick={() => reop.mutate()}>გაუქმება</button></>}>
        <span className="small muted">შემთხვევა დაბრუნდება დაფაზე; ER-ის ფურცელი გაუქმდება; შეწყვეტილი დანიშნულებები ავტომატურად არ აღდგება. ვადა — {d.settings.reopen_h} სთ.</span>
        <Field label="მიზეზი" htmlFor="ro-r" required><input id="ro-r" className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <ErrorBox error={reop.error} />
      </Modal>}
    </div>
  );
}

function DispositionForm({ info, encounterId, patientId, primaryDx, hasPending, onDone }: {
  info: DispInfo; encounterId: string; patientId: string; primaryDx: { code: string; title: string } | null; hasPending: boolean; onDone: () => void;
}) {
  const kinds = (Object.keys(DISP_KA) as DKind[]).filter((k) => (k === 'lwbs' ? info.can.lwbs : info.can.dispose) && (k !== 'admitted' || info.modules.inpatient));
  const [kind, setKind] = useState<DKind>(kinds.includes('home') ? 'home' : kinds[0] ?? 'lwbs');
  const opts = useQuery({ queryKey: ['er-admit-options'], queryFn: () => api<AdmitOptions>('/er/admit/options'), enabled: kind === 'admitted' || kind === 'transfer' });
  const staff = useQuery({ queryKey: ['er-staff'], enabled: kind === 'ama', queryFn: () => api<{ doctors: { id: string; name: string }[]; nurses: { id: string; name: string }[] }>('/er/staff') });
  const [rec, setRec] = useState(''); const [note, setNote] = useState(''); const [override, setOverride] = useState('');
  const [dDate, setDDate] = useState(todayISO()); const [dTime, setDTime] = useState(hhmmNow()); const [customTime, setCustomTime] = useState(false);
  // ჰოსპიტალიზაცია
  const [dep, setDep] = useState(''); const [att, setAtt] = useState(''); const [icd, setIcd] = useState<{ code: string; title: string } | null>(primaryDx);
  const [sev, setSev] = useState(''); const [iso, setIso] = useState(''); const [plan, setPlan] = useState<Record<string, 'continue' | 'stop'>>(() => Object.fromEntries(info.orders.map((o) => [o.id, o.default])));
  const [confirm, setConfirm] = useState(false);
  const [merge, setMerge] = useState(true);   // 0091: admit_invoice = ask
  // გადაყვანა
  const [destId, setDestId] = useState(''); const [destText, setDestText] = useState(''); const [transport, setTransport] = useState(''); const [trReason, setTrReason] = useState(''); const [receiver, setReceiver] = useState('');
  // AMA
  const [refusalMode, setRefusalMode] = useState<'sign' | 'witness'>('sign'); const [refusalId, setRefusalId] = useState<string | null>(null); const [witnesses, setWitnesses] = useState<string[]>([]);
  const [amaReason, setAmaReason] = useState(''); const [signDlg, setSignDlg] = useState(false);
  // გარდაცვალება
  const [deathIcd, setDeathIcd] = useState<{ code: string; title: string } | null>(null); const [autopsy, setAutopsy] = useState<boolean | null>(null); const [doa, setDoa] = useState(false);

  const checks = info.checks[kind] ?? [];
  const blocks = checks.filter((c) => c.level === 'block'); const warns = checks.filter((c) => c.level === 'warn'); const infos = checks.filter((c) => c.level === 'info');
  const request = kind === 'admitted' && info.settings.admit_mode === 'request';
  const reconcile = kind === 'admitted' && info.modules.ipd_orders && info.settings.transfer_orders === 'reconcile' && info.orders.length > 0;
  const recRequired = info.settings.recommendations_required && ['home', 'transfer', 'ama'].includes(kind);
  const askMerge = kind === 'admitted' && info.settings.admit_invoice === 'ask' && checks.some((c) => c.code === 'INVOICE_MERGE');
  const depRow = opts.data?.departments.find((x) => x.id === dep);
  const at = customTime ? localISO(dDate, dTime) : undefined;

  const body = () => ({
    kind, departed_at: kind === 'death' ? undefined : at, recommendations: rec.trim() || undefined, note: note.trim() || undefined, override_reason: override.trim() || undefined,
    ...(kind === 'admitted' ? { admit: { department_id: dep, attending_doctor_id: att || undefined, icd10_code: icd?.code, severity: sev || undefined, isolation: iso || undefined, confirm: confirm || undefined },
      orders_plan: reconcile ? plan : undefined, invoice_merge: askMerge ? merge : undefined } : {}),
    ...(kind === 'transfer' ? { destination_id: destId || undefined, destination_text: destId ? undefined : destText.trim(), transport: transport || undefined, transfer_reason: trReason.trim(), receiver: receiver.trim() || undefined } : {}),
    ...(kind === 'ama' ? (info.settings.ama_proof === 'reason' ? { ama_reason: amaReason.trim() } : refusalMode === 'sign' ? { refusal_consent_id: refusalId ?? undefined } : { refusal_witnesses: witnesses }) : {}),
    ...(kind === 'death' ? { death_at: localISO(dDate, dTime), death_icd10_code: deathIcd?.code, autopsy_required: autopsy ?? undefined, dead_on_arrival: doa || undefined } : {}),
  });
  const m = useMutation({
    mutationFn: () => request
      ? api(`/er/visits/${encounterId}/admit-request`, { body: { department_id: dep, attending_doctor_id: att || undefined, icd10_code: icd?.code, severity: sev || undefined, isolation: iso || undefined,
          note: note.trim() || undefined, orders_plan: reconcile ? plan : undefined, override_reason: override.trim() || undefined, invoice_merge: askMerge ? merge : undefined } })
      : api(`/er/visits/${encounterId}/disposition`, { body: body() }),
    onSuccess: onDone,
  });
  const err = m.error instanceof ApiError ? m.error : null;
  const ready = !blocks.length && (!warns.length || override.trim().length >= 5) && (!recRequired || rec.trim().length >= 3) && (
    kind === 'admitted' ? !!dep && !!icd && (request || !!att) && !(request && hasPending)
    : kind === 'transfer' ? (!!destId || destText.trim().length >= 3) && trReason.trim().length >= 3
    : kind === 'ama' ? (info.settings.ama_proof === 'reason' ? amaReason.trim().length >= 3 : refusalMode === 'sign' ? !!refusalId : witnesses.length >= 2)
    : kind === 'death' ? !!deathIcd && autopsy !== null : true);

  return (
    <section className="card card-pad stack" style={{ gap: 12 }} data-testid="er-disp-form">
      <div className="seg" role="group" aria-label="გამოსავალი" style={{ width: 'max-content', flexWrap: 'wrap' }}>
        {kinds.map((k) => <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>{DISP_SHORT[k]}</button>)}
      </div>
      <strong>{DISP_KA[kind]}{request ? ' — მოთხოვნა განყოფილებას' : ''}</strong>
      {blocks.length > 0 && <div className="alert danger" data-testid="er-disp-blocks"><div className="stack" style={{ gap: 4 }}>{blocks.map((c) => <div key={c.code}>⛔ {c.message}</div>)}</div></div>}
      {warns.length > 0 && <div className="stack" style={{ gap: 6 }}>
        <div className="alert warn" data-testid="er-disp-warns"><div className="stack" style={{ gap: 4 }}>{warns.map((c) => <div key={c.code}>• {c.message}</div>)}</div></div>
        <Field label="გაგრძელების დასაბუთება" htmlFor="ds-o" required><input id="ds-o" className="input" value={override} onChange={(e) => setOverride(e.target.value)} /></Field>
      </div>}
      {infos.length > 0 && <div className="alert info small"><div className="stack" style={{ gap: 2 }}>{infos.map((c) => <div key={c.code}>{c.message}</div>)}</div></div>}

      {kind === 'admitted' && <div className="stack" style={{ gap: 10 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
          <Field label="განყოფილება" htmlFor="ds-dep" required><select id="ds-dep" className="select" value={dep} onChange={(e) => { setDep(e.target.value); setAtt(''); }}>
            <option value="">— აირჩიეთ —</option>{opts.data?.departments.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
          <Field label={request ? 'მკურნალი ექიმი (სასურველი)' : 'მკურნალი ექიმი'} htmlFor="ds-att" required={!request}><select id="ds-att" className="select" value={att} onChange={(e) => setAtt(e.target.value)} disabled={!dep}>
            <option value="">—</option>{depRow?.doctors.map((x) => <option key={x.id} value={x.id}>{x.name}{x.specialty ? ` (${x.specialty})` : ''}</option>)}</select></Field>
          <Field label="მდგომარეობა" htmlFor="ds-sev"><select id="ds-sev" className="select" value={sev} onChange={(e) => setSev(e.target.value)}><option value="">—</option>
            {Object.entries(SEVERITY_KA).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          <Field label="იზოლაცია" htmlFor="ds-iso"><select id="ds-iso" className="select" value={iso} onChange={(e) => setIso(e.target.value)}><option value="">—</option>
            {Object.entries(ISOLATION_KA).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        </div>
        {askMerge && <label className="row small" data-testid="ds-merge"><input type="checkbox" checked={merge} onChange={(e) => setMerge(e.target.checked)} /> ER-ის ინვოისის გაერთიანება სტაციონარისაში</label>}
        <span className="label">დიაგნოზი ჰოსპიტალიზაციისას (ICD-10)</span>
        {icd ? <div className="row"><span className="mono">{icd.code}</span> {icd.title}<button className="btn sm" type="button" onClick={() => setIcd(null)}>შეცვლა</button></div>
          : <IcdPicker primary onPick={(x) => setIcd({ code: x.code, title: x.title })} />}
        {reconcile && <div className="stack" style={{ gap: 6 }} data-testid="er-disp-reconcile">
          <span className="label">აქტიური დანიშნულებები — სტაციონარში</span>
          <table className="table"><tbody>{info.orders.map((o) => <tr key={o.id}><td className="small">{o.label}{o.running && <span className="chip info" style={{ marginLeft: 6 }}>მიმდინარე ინფუზია</span>}
            {o.untransferable && <div className="small muted">{o.untransferable} — გადატანა შეუძლებელია</div>}</td>
            <td style={{ width: 220 }}><div className="seg" role="group" aria-label={o.label}>
              <button type="button" aria-pressed={plan[o.id] === 'continue'} disabled={!!o.untransferable} onClick={() => setPlan({ ...plan, [o.id]: 'continue' })}>გაგრძელება</button>
              <button type="button" aria-pressed={plan[o.id] === 'stop'} onClick={() => setPlan({ ...plan, [o.id]: 'stop' })}>შეწყვეტა</button></div></td></tr>)}</tbody></table>
          <span className="small muted">გაგრძელებული — სტაციონარის დანიშნულებად (ვერიფიკაცია — განყოფილების წესით); ER-ის დანიშნულება შეწყდება.</span>
        </div>}
        {!request && <label className="row small"><input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /> გაფრთხილებების დადასტურება (სქესი / იზოლაცია)</label>}
        {!request && <span className="small muted">საწოლს ანიჭებს განყოფილება; პაციენტი განყოფილების დაფაზე „ელოდება საწოლს“.</span>}
        {request && hasPending && <div className="alert warn small">მოთხოვნა უკვე გაგზავნილია.</div>}
      </div>}

      {kind === 'transfer' && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
        <Field label="დაწესებულება" htmlFor="ds-i"><select id="ds-i" className="select" value={destId} onChange={(e) => setDestId(e.target.value)}>
          <option value="">— ცნობარში არ არის —</option>{opts.data?.institutions.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></Field>
        {!destId ? <Field label="დასახელება" htmlFor="ds-it" required><input id="ds-it" className="input" value={destText} onChange={(e) => setDestText(e.target.value)} /></Field> : <span />}
        <Field label="მიზეზი" htmlFor="ds-tr" required><input id="ds-tr" className="input" value={trReason} onChange={(e) => setTrReason(e.target.value)} placeholder="მაგ. კათეტერიზაცია — არ გვაქვს" /></Field>
        <Field label="ტრანსპორტი" htmlFor="ds-tp"><select id="ds-tp" className="select" value={transport} onChange={(e) => setTransport(e.target.value)}>
          <option value="">—</option>{Object.entries(TRANSPORT_KA).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="მიმღები ექიმი / ტელეფონი" htmlFor="ds-rc"><input id="ds-rc" className="input" value={receiver} onChange={(e) => setReceiver(e.target.value)} /></Field>
      </div>}

      {kind === 'ama' && (info.settings.ama_proof === 'reason'
        ? <Field label="მიზეზი" htmlFor="ds-ar" required><input id="ds-ar" className="input" value={amaReason} onChange={(e) => setAmaReason(e.target.value)} /></Field>
        : <div className="stack" style={{ gap: 8 }}>
          <div className="seg" role="group" aria-label="ხელწერილი" style={{ width: 'max-content' }}>
            <button type="button" aria-pressed={refusalMode === 'sign'} onClick={() => setRefusalMode('sign')}>ხელწერილი</button>
            <button type="button" aria-pressed={refusalMode === 'witness'} onClick={() => setRefusalMode('witness')}>ხელმოწერაზე უარი — მოწმეები</button>
          </div>
          {refusalMode === 'sign' ? <div className="row" style={{ gap: 8 }}>
            {refusalId ? <span className="chip ok">ხელწერილი ხელმოწერილია</span> : <button className="btn" type="button" onClick={() => setSignDlg(true)}>ხელწერილის ხელმოწერა</button>}
            <button className="btn sm" type="button" onClick={() => openBlob(`/patients/${patientId}/consents/ER_SELF_DISCHARGE/form?encounter_id=${encounterId}`).catch(() => undefined)}>ბლანკი (PDF)</button>
          </div> : <Field label="მოწმეები (2 თანამშრომელი)" htmlFor="ds-w">
            <select id="ds-w" className="select" multiple size={5} value={witnesses} onChange={(e) => setWitnesses([...e.target.selectedOptions].map((o) => o.value).slice(0, 3))}>
              {[...(staff.data?.doctors ?? []), ...(staff.data?.nurses ?? [])].filter((u, i, a) => a.findIndex((y) => y.id === u.id) === i).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>}
        </div>)}

      {kind === 'death' && <div className="stack" style={{ gap: 10 }}>
        <div className="row" style={{ gap: 12 }}>
          <Field label="თარიღი" htmlFor="dd-d" required><input id="dd-d" type="date" className="input" value={dDate} onChange={(e) => setDDate(e.target.value)} /></Field>
          <Field label="დრო" htmlFor="dd-t" required><input id="dd-t" type="time" className="input" value={dTime} onChange={(e) => setDTime(e.target.value)} /></Field>
        </div>
        <span className="label">გარდაცვალების მიზეზი (ICD-10)</span>
        {deathIcd ? <div className="row"><span className="mono">{deathIcd.code}</span> {deathIcd.title}<button className="btn sm" type="button" onClick={() => setDeathIcd(null)}>შეცვლა</button></div>
          : <IcdPicker primary onPick={(x) => setDeathIcd({ code: x.code, title: x.title })} />}
        <div className="seg" role="group" aria-label="აუტოფსია" style={{ width: 'max-content' }}>
          <button type="button" aria-pressed={autopsy === true} onClick={() => setAutopsy(true)}>აუტოფსია საჭიროა</button>
          <button type="button" aria-pressed={autopsy === false} onClick={() => setAutopsy(false)}>არ არის საჭირო</button>
        </div>
        <label className="row small"><input type="checkbox" checked={doa} onChange={(e) => setDoa(e.target.checked)} /> შემოყვანილია გარდაცვლილი</label>
      </div>}

      {kind !== 'death' && !request && <label className="row small"><input type="checkbox" checked={customTime} onChange={(e) => setCustomTime(e.target.checked)} /> გასვლის დრო — სხვა (ნაგულისხმევი: ახლა)</label>}
      {customTime && kind !== 'death' && !request && <div className="row" style={{ gap: 12 }}>
        <Field label="თარიღი" htmlFor="dp-d"><input id="dp-d" type="date" className="input" value={dDate} onChange={(e) => setDDate(e.target.value)} /></Field>
        <Field label="დრო" htmlFor="dp-t"><input id="dp-t" type="time" className="input" value={dTime} onChange={(e) => setDTime(e.target.value)} /></Field>
      </div>}
      {!request && kind !== 'lwbs' && <Field label="რეკომენდაციები" htmlFor="ds-rec" required={recRequired}>
        <textarea id="ds-rec" className="input" rows={3} value={rec} onChange={(e) => setRec(e.target.value)} placeholder="მკურნალობა, მეთვალყურეობა, განმეორებითი მიმართვის ნიშნები…" /></Field>}
      <Field label="შენიშვნა" htmlFor="ds-n"><input id="ds-n" className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      {err && ['ER_DISPOSITION_BLOCKED', 'ER_DISPOSITION_WARNINGS'].includes(err.code ?? '') ? <div className="alert danger">{err.message}</div> : <ErrorBox error={m.error} />}
      <div className="row" style={{ gap: 8 }}>
        <span className="grow" />
        <button className="btn" type="button" data-ro-ok onClick={() => openBlob(`/er/visits/${encounterId}/summary/preview`).catch(() => undefined)}>ER-ის ფურცელი — პროექტი</button>
        <button className={`btn ${kind === 'death' ? 'danger' : 'primary'}`} type="button" disabled={!ready || m.isPending} onClick={() => m.mutate()} data-testid="er-disp-submit">
          {request ? 'მოთხოვნის გაგზავნა' : kind === 'death' ? 'გარდაცვალების დაფიქსირება' : 'გამოსავლის გაფორმება'}</button>
      </div>
      {signDlg && <SignDialog patientId={patientId} encounterId={encounterId} consent={{ code: 'ER_SELF_DISCHARGE', name: 'ხელწერილი — ER-ის დატოვება რეკომენდაციის საწინააღმდეგოდ', text_approved: true }}
        onClose={() => setSignDlg(false)} onSigned={(id) => setRefusalId(id)} />}
    </section>
  );
}

// ======================================================================= გასულები (24 სთ)
interface DepartedRow {
  encounter_id: string; visit_no: string; arrived_at: string; ended_at: string; disposition: DKind; doc_closes_at: string | null; chief_complaint: string; department_name: string;
  level_name: string | null; color: string | null; patient_id: string; first_name: string; last_name: string; doctor_name: string | null; adm_no: string | null; summary_number: string | null;
}
export function DepartedList({ departmentId, onOpen }: { departmentId: string; onOpen: (id: string) => void }) {
  const [hours, setHours] = useState(24); const [kind, setKind] = useState('');
  const q = useQuery({ queryKey: ['er-departed', departmentId, hours, kind], queryFn: () => api<DepartedRow[]>('/er/departed', { query: { department_id: departmentId, hours, disposition: kind } }) });
  return (
    <div className="card" data-testid="er-departed">
      <div className="card-head row" style={{ gap: 8 }}><h2 className="grow">გასულები</h2>
        <select aria-label="პერიოდი" className="select" style={{ width: 'auto' }} value={hours} onChange={(e) => setHours(Number(e.target.value))}>
          <option value={12}>12 სთ</option><option value={24}>24 სთ</option><option value={72}>3 დღე</option><option value={168}>7 დღე</option></select>
        <select aria-label="გამოსავალი" className="select" style={{ width: 'auto' }} value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">ყველა</option>{(Object.keys(DISP_SHORT) as DKind[]).map((k) => <option key={k} value={k}>{DISP_SHORT[k]}</option>)}</select></div>
      {!q.data ? (q.error ? <ErrorBox error={q.error} /> : <Loading />) : q.data.length === 0 ? <div className="empty">ჩანაწერი არ არის.</div> : (
        <table className="table"><thead><tr><th style={{ width: 8 }} /><th>№</th><th>პაციენტი</th><th>შემოსვლა → გასვლა</th><th>გამოსავალი</th><th>ექიმი</th><th>ფურცელი</th></tr></thead>
          <tbody>{q.data.map((r) => <tr key={r.encounter_id} style={{ cursor: 'pointer' }} onClick={() => onOpen(r.encounter_id)}>
            <td style={{ background: r.color ?? 'transparent' }} /><td className="mono small">{r.visit_no}</td><td>{r.last_name} {r.first_name}<div className="small muted">{r.chief_complaint}</div></td>
            <td className="small">{hm(r.arrived_at)} → {tsDate(r.ended_at)} {hm(r.ended_at)}</td>
            <td><span className={`chip ${r.disposition === 'death' ? 'danger' : r.disposition === 'admitted' ? 'info' : ''}`}>{DISP_SHORT[r.disposition]}</span>{r.adm_no && <div className="small mono">{r.adm_no}</div>}</td>
            <td className="small">{r.doctor_name ?? '—'}</td><td className="small mono">{r.summary_number ?? '—'}</td></tr>)}</tbody></table>)}
    </div>
  );
}
