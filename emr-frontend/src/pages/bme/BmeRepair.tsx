import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApiError, api, apiUpload, can, openBlob, type Role } from '../../api/client';
import type { Department } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { ReportIncidentButton, openIncidentReport } from '../../components/IncidentReport';
import { ErrorBox, Field, Loading, Modal, useDebounced, useToast } from '../../components/ui';
import { dateGe, hhmm, money, todayISO, tsDate } from '../../lib/format';

// ---------------------------------------------------------------- ტიპები (0075)
type RStatus = 'requested' | 'triaged' | 'in_progress' | 'waiting_parts' | 'waiting_vendor' | 'done' | 'closed' | 'rejected' | 'duplicate';
type Cond = 'not_working' | 'limited' | 'issue';
type Urg = 'safety' | 'urgent' | 'normal';
type Sla = 'met' | 'breached' | 'warn' | 'ok' | null;
interface Code { id: string; kind: 'cause' | 'action'; code: string; name: string; is_active: boolean; sort_order: number }
interface Refs {
  settings: { rep_who: string; rep_close_mode: 'confirm' | 'engineer'; rep_close_auto_days: number; rep_post_check: 'suggest' | 'required_life_support' | 'off'; rep_pm_fail: string;
    rep_sla_response: number[]; rep_sla_restore: number[]; rep_labor_rate: number; rep_parts_location_id: string | null; rep_sets_down: boolean };
  codes: Code[]; suppliers: { id: string; name: string }[]; engineers: { id: string; name: string }[]; locations: { id: string; name: string; code: string }[];
  kinds: { id: string; code: string; name: string; short_name: string }[];
}
interface Coverage { coverage: 'warranty' | 'contract' | null; contract_id: string | null; contract_no: string | null; contract_kind: string | null; supplier_id: string | null; supplier_name: string | null;
  until: string | null; response_hours: number[] | null; restore_hours: number[] | null }
export interface Repair {
  id: string; repair_no: string; device_id: string; source: 'request' | 'pm_work' | 'engineer'; status: RStatus; condition: Cond; urgency: Urg; description: string; patient_involved: boolean;
  reported_by: string; reported_at: string; reported_by_name: string | null; contact_phone: string | null; priority: number | null; suggested_priority: number; triage_note: string | null;
  performer_kind: 'internal' | 'external'; assignee_id: string | null; assignee_name: string | null; supplier_id: string | null; supplier_name: string | null; external_person: string | null;
  coverage: 'warranty' | 'contract' | null; contract_no: string | null; vendor_called_at: string | null; vendor_ref: string | null; vendor_arrived_at: string | null; started_at: string | null; wait_reason: string | null;
  sla_response_hours: number | null; sla_restore_hours: number | null; sla_response_due: string | null; sla_restore_due: string | null; sla_response: Sla; sla_restore: Sla;
  done_at: string | null; outcome: string | null; resolution: string | null; labor_hours: string | null; labor_cost: string; parts_cost: string; external_cost: string; total_cost: string; invoice_no: string | null;
  suggested_status: 'operational' | 'retired' | null; status_applied: boolean; post_check_required: boolean; post_check_work_id: string | null; closed_at: string | null; close_kind: string | null;
  reopen_count: number; hold: boolean; hold_note: string | null; reject_reason: string | null; reject_note: string | null; loaner_device_id: string | null; loaner_text: string | null;
  inv_no: string; device_name: string; device_status: string; criticality: string; department_id: string | null; department_name: string | null; room: string | null; type_name: string; age_hours: number;
}
interface RepairFull extends Repair {
  manufacturer: string | null; model: string | null; serial_no: string | null; triaged_by_name: string | null; done_by_name: string | null; closed_by_name: string | null; cause_name: string | null; action_name: string | null;
  loaner_inv_no: string | null; duplicate_of_no: string | null; pm_work_no: string | null; pm_work_id: string | null; post_check_work_no: string | null; post_check_status: string | null; post_check_result: string | null;
  incident_id: string | null; incident_no: string | null; incident_status: string | null; ap_invoice_no: string | null; post_check_pending: boolean;
  events: { id: string; kind: string; data: Record<string, unknown>; created_at: string; user_name: string | null }[];
  parts: { doc_id: string; doc_no: string; doc_date: string; location_name: string; item_name: string; qty: string; lot_no: string | null; line_net: string }[];
  purchases: { id: string; pr_no: string | null; status: string; est_total: string; created_at: string }[];
  documents: { id: string; kind: string; title: string; created_at: string }[];
  incidents: { id: string; inc_no: string; status: string; reported_at: string }[];
  duplicates: { id: string; repair_no: string; status: string }[];
  periods: { id: string; status: string; started_at: string; ended_at: string | null; hours: number }[];
  coverage_info: Coverage | null; open_others: { id: string; repair_no: string; status: string }[];
  can: { manage: boolean; confirm: boolean; reopen: boolean; hold: boolean; release: boolean; close: boolean };
}
interface Contract {
  id: string; contract_no: string; title: string; supplier_id: string; supplier_name: string; kind: string; start_date: string; end_date: string; cost: string | null; cost_period: string | null;
  response_hours: number[] | null; restore_hours: number[] | null; uptime_pct: string | null; pm_visits_per_year: number | null; covers_kinds: string[]; covers_parts: boolean; contact: string | null; notes: string | null;
  status: 'active' | 'cancelled'; cancel_reason: string | null; devices: number | DevRow[]; days_left: number; in_force: boolean; annual_cost: string | null;
}
interface DevRow { id: string; inv_no: string; name: string; status: string; serial_no: string | null; type_name: string; department_name: string | null }
interface ContractFull extends Omit<Contract, 'devices'> {
  devices: DevRow[]; files: { id: string; title: string; created_at: string }[]; covers: { id: string; code: string; short_name: string }[];
  repairs: { id: string; repair_no: string; status: RStatus; priority: number | null; reported_at: string; inv_no: string; device_name: string; response_ok: boolean | null; restore_ok: boolean | null }[];
}

const FULL: Role[] = ['admin', 'med_engineer'];
const CT_VIEW: Role[] = ['admin', 'med_engineer', 'bme_view', 'manager', 'viewer', 'procurement', 'procurement_approve', 'accountant'];
export const REP_STATUS_KA: Record<RStatus, string> = { requested: 'ტრიაჟს ელოდება', triaged: 'ტრიაჟი გავლილია', in_progress: 'მიმდინარეობს', waiting_parts: 'ელოდება ნაწილებს',
  waiting_vendor: 'ელოდება მომწოდებელს', done: 'შესრულდა — დასადასტურებელი', closed: 'დახურულია', rejected: 'უარყოფილია', duplicate: 'დუბლიკატი' };
const REP_CHIP: Record<RStatus, string> = { requested: 'danger', triaged: 'warn', in_progress: 'info', waiting_parts: 'warn', waiting_vendor: 'warn', done: 'ok', closed: '', rejected: '', duplicate: '' };
const COND_KA: Record<Cond, string> = { not_working: 'არ მუშაობს', limited: 'შეზღუდულად მუშაობს', issue: 'მუშაობს, მაგრამ პრობლემაა' };
const URG_KA: Record<Urg, string> = { safety: 'პაციენტის უსაფრთხოება', urgent: 'სასწრაფო', normal: 'ჩვეულებრივი' };
const OUT_KA: Record<string, string> = { repaired: 'შეკეთებულია', not_repairable: 'შეუკეთებელია / ჩამოსაწერი', no_fault: 'დაზიანება არ დადასტურდა' };
const REJ_KA: Record<string, string> = { no_fault: 'გაუმართაობა არ არის', user_error: 'მომხმარებლის შეცდომა (ინსტრუქტაჟი)', duplicate: 'დუბლიკატი', other: 'სხვა' };
const SRC_KA: Record<string, string> = { request: 'განყოფილება', pm_work: 'PM / კალიბრაცია', engineer: 'ინჟინერი' };
export const CT_KA: Record<string, string> = { full_service: 'სრული სერვისი', pm_only: 'მხოლოდ გეგმიური (PM)', parts: 'ნაწილები', on_call: 'გამოძახებით', ext_warranty: 'გაგრძელებული გარანტია' };
const PERIOD_KA: Record<string, string> = { once: 'ერთჯერადი', month: 'თვეში', quarter: 'კვარტალში', year: 'წელიწადში' };
const DEV_ST_KA: Record<string, string> = { operational: 'მუშა', restricted: 'შეზღუდულად მუშა', down: 'გაუმართავი / შეკეთებაში', standby: 'რეზერვი', retired: 'გამოყვანილი' };
const EVK: Record<string, string> = { requested: 'მოთხოვნა', triaged: 'ტრიაჟი', assigned: 'მინიჭება / ცვლილება', vendor_called: 'მომწოდებელი გამოძახებულია', vendor_arrived: 'მომწოდებელი მოვიდა',
  started: 'სამუშაო დაიწყო', waiting: 'ლოდინი', resumed: 'გაგრძელდა', parts_issued: 'ნაწილი ჩამოიწერა', purchase: 'შესყიდვის მოთხოვნა', cost: 'ხარჯი', done: 'შესრულდა',
  status_applied: 'აპარატის სტატუსი', confirmed: 'განყოფილებამ დაადასტურა', closed: 'დაიხურა', reopened: 'ხელახლა გაიხსნა', rejected: 'უარყოფილია', duplicate: 'დუბლიკატი',
  hold: 'შენახულია გამოძიებისთვის', hold_released: 'შენახვა მოიხსნა', incident: 'ინციდენტი', post_check: 'შემოწმება შეკეთების შემდეგ', file: 'ფაილი', note: 'შენიშვნა',
  sla_warn: 'SLA — ვადა ახლოვდება', sla_breach: 'SLA დარღვეულია' };
const SLA_CHIP: Record<string, [string, string]> = { met: ['ok', 'შესრულდა'], breached: ['danger', 'დარღვეულია'], warn: ['warn', 'ახლოვდება'], ok: ['info', 'ვადაშია'] };
const OPEN: RStatus[] = ['requested', 'triaged', 'in_progress', 'waiting_parts', 'waiting_vendor'];
const useRefs = () => useQuery({ queryKey: ['bme-rep-refs'], queryFn: () => api<Refs>('/bme/repairs/refs'), staleTime: 60_000 });
const dt = (ts: string | null) => (ts ? `${tsDate(ts)} ${hhmm(ts)}` : '—');
const nn = (x: string) => (x.trim() ? x.trim() : null);
const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 } as const;

export const PriorityChip = ({ p, suggested }: { p: number | null; suggested?: number }) => {
  const v = p ?? suggested ?? 4;
  return <span className={`chip ${v === 1 ? 'danger' : v === 2 ? 'warn' : v === 3 ? 'info' : ''}`} title={p ? 'პრიორიტეტი' : 'შეთავაზებული (ტრიაჟამდე)'}>P{v}{p ? '' : '?'}</span>;
};
export const RepStatusChip = ({ s }: { s: RStatus }) => <span className={`chip ${REP_CHIP[s]}`}>{REP_STATUS_KA[s]}</span>;
const SlaChip = ({ s, label }: { s: Sla; label: string }) => (s ? <span className={`chip ${SLA_CHIP[s][0]}`} style={{ height: 20, fontSize: 11 }} title={label}>{label}: {SLA_CHIP[s][1]}</span> : null);

function invalidate(qc: ReturnType<typeof useQueryClient>) {
  for (const k of ['bme-repairs', 'bme-repair', 'bme-rep-counts', 'bme-device-repairs', 'bme-device', 'bme-devices', 'bme-alerts', 'bme-works', 'bme-work']) void qc.invalidateQueries({ queryKey: [k] });
}

// ---------------------------------------------------------------- სია „შეკეთება“
const VIEWS: [string, string, string?][] = [['open', 'აქტიური', 'open'], ['requested', 'ტრიაჟს ელოდება', 'requested'], ['mine', 'ჩემი', 'mine'], ['waiting', 'ლოდინში', 'waiting'],
  ['sla', 'SLA რისკი', 'sla_breached'], ['done', 'დასადასტურებელი', 'done'], ['closed', 'დახურული (180 დღე)'], ['all', 'ყველა']];
export function RepairsPage() {
  const { user } = useAuth(); const [sp, setSp] = useSearchParams(); const full = can(user, ...FULL);
  const deps = useQuery({ queryKey: ['departments'], queryFn: () => api<Department[]>('/departments') });
  const [f, setF] = useState({ view: sp.get('view') ?? 'open', department_id: '', priority: '', search: '' });
  const ds = useDebounced(f.search.trim(), 300);
  const q = useQuery({ queryKey: ['bme-repairs', { ...f, search: ds }], queryFn: () => api<Repair[]>('/bme/repairs', { query: { ...f, search: ds } }) });
  const counts = useQuery({ queryKey: ['bme-rep-counts'], queryFn: () => api<Record<string, number>>('/bme/repairs/counts') });
  const [req, setReq] = useState(false);
  const open = (id: string) => { sp.set('repair', id); setSp(sp); };
  const rows = q.data ?? [];
  return (
    <div className="content">
      <div className="seg" role="group" aria-label="ხედი" style={{ flexWrap: 'wrap' }}>
        {VIEWS.filter(([k]) => k !== 'mine' || full).map(([k, l, c]) => <button key={k} type="button" aria-pressed={f.view === k} onClick={() => setF({ ...f, view: k })}>
          {l}{c && counts.data?.[c] ? <span className={`chip ${c === 'sla_breached' || c === 'requested' ? 'danger' : ''}`} style={{ height: 18, marginLeft: 6, fontSize: 11 }}>{counts.data[c]}</span> : null}</button>)}
      </div>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <input className="input" style={{ maxWidth: 300, height: 38 }} aria-label="ძებნა" placeholder="№, აპარატი, აღწერა" value={f.search} onChange={(e) => setF({ ...f, search: e.target.value })} />
        <select className="select" style={{ maxWidth: 220, height: 38 }} aria-label="განყოფილება" value={f.department_id} onChange={(e) => setF({ ...f, department_id: e.target.value })}>
          <option value="">ყველა განყოფილება</option>{deps.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
        <select className="select" style={{ maxWidth: 140, height: 38 }} aria-label="პრიორიტეტი" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>
          <option value="">ყველა P</option>{[1, 2, 3, 4].map((p) => <option key={p} value={p}>P{p}</option>)}</select>
        <span className="grow" />
        <button className="btn primary" type="button" onClick={() => setReq(true)}>+ გაუმართაობის შეტყობინება</button>
      </div>
      {!can(user, 'admin', 'med_engineer', 'bme_view', 'manager', 'viewer', 'quality') && <span className="hint">ჩანს თქვენი მოთხოვნები{can(user, 'bme_dept') ? ' და თქვენი განყოფილებ(ებ)ის აპარატების ორდერები' : ''}.</span>}
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead><tr><th>№</th><th>P</th><th>აპარატი</th><th>მოთხოვნა</th><th>სტატუსი</th><th>შემსრულებელი</th><th>SLA</th><th className="num">საათი</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id} className="clickable" onClick={() => open(r.id)}>
                <td className="mono small" style={{ whiteSpace: 'nowrap' }}>{r.repair_no}<div className="muted">{tsDate(r.reported_at)}</div></td>
                <td><PriorityChip p={r.priority} suggested={r.suggested_priority} /></td>
                <td><strong className="small">{r.inv_no}</strong> <span className="small">{r.device_name}</span><div className="small muted">{r.department_name ?? ''}{r.room ? ` · ოთახი ${r.room}` : ''}</div></td>
                <td className="small" style={{ maxWidth: 320 }}><span className={`chip ${r.condition === 'not_working' ? 'danger' : r.condition === 'limited' ? 'warn' : ''}`} style={{ height: 20, fontSize: 11 }}>{COND_KA[r.condition]}</span>
                  {r.urgency !== 'normal' && <span className="chip danger" style={{ height: 20, fontSize: 11, marginLeft: 4 }}>{URG_KA[r.urgency]}</span>}
                  {r.hold && <span className="chip danger" style={{ height: 20, fontSize: 11, marginLeft: 4 }}>შენახულია</span>}
                  <div className="muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.description}</div></td>
                <td><RepStatusChip s={r.status} />{r.wait_reason && <div className="small muted">{r.wait_reason}</div>}</td>
                <td className="small">{r.performer_kind === 'external' ? <>{r.supplier_name ?? r.external_person}{r.coverage && <div><span className="chip ok" style={{ height: 18, fontSize: 10 }}>{r.coverage === 'warranty' ? 'გარანტია' : 'კონტრაქტი'}</span></div>}</> : r.assignee_name ?? <span className="muted">—</span>}</td>
                <td><div className="stack" style={{ gap: 2 }}><SlaChip s={r.sla_response} label="რეაგ." /><SlaChip s={r.sla_restore} label="აღდგ." /></div></td>
                <td className="num mono small">{r.age_hours}</td>
              </tr>))}
              {!rows.length && <tr><td colSpan={8} className="muted">ორდერი არ არის</td></tr>}</tbody>
          </table>
        </div>)}
      {req && <RequestDialog onClose={() => setReq(false)} onDone={(id) => { setReq(false); open(id); }} />}
    </div>
  );
}

// ---------------------------------------------------------------- მოთხოვნა
interface DevHit { id: string; inv_no: string; name: string; department_name: string | null; status: string; criticality: string }
export function RequestDialog({ device, onClose, onDone }: { device?: { id: string; inv_no: string; name: string; department_id: string | null } | null; onClose: () => void; onDone: (id: string) => void }) {
  const { user } = useAuth(); const qc = useQueryClient();
  const [dev, setDev] = useState<{ id: string; inv_no: string; name: string; department_id?: string | null } | null>(device ?? null);
  const [s, setS] = useState(''); const ds = useDebounced(s.trim(), 300);
  const hits = useQuery({ queryKey: ['bme-devices', { search: ds, status: 'active' }], queryFn: () => api<DevHit[]>('/bme/devices', { query: { search: ds, status: 'active' } }), enabled: !dev && ds.length >= 2 });
  const [f, setF] = useState({ condition: 'not_working' as Cond, urgency: 'normal' as Urg, description: '', patient_involved: false, contact_phone: '' });
  const [openList, setOpenList] = useState<{ id: string; repair_no: string; status: string; description: string }[] | null>(null);
  const body = (force: boolean) => ({ device_id: dev!.id, ...f, description: f.description.trim(), contact_phone: nn(f.contact_phone), force, ...(can(user, ...FULL) && { as_engineer: true }) });
  const m = useMutation({
    mutationFn: (force: boolean) => api<RepairFull & { suggest_incident: boolean }>('/bme/repairs', { body: body(force) }),
    onSuccess: (r) => {
      invalidate(qc);
      if (r.suggest_incident) openIncidentReport({ source: { type: 'bme_device', id: r.device_id, label: `აპარატი ${r.inv_no} · ${r.device_name}` }, department_id: r.department_id });
      onDone(r.id);
    },
    onError: (e) => { if (e instanceof ApiError && e.code === 'REPAIR_OPEN') setOpenList((e.body?.repairs as typeof openList) ?? []); },
  });
  const note = useMutation({ mutationFn: (rid: string) => api(`/bme/repairs/${rid}/note`, { body: { text: `იგივე / დამატებით (${COND_KA[f.condition]}): ${f.description.trim()}` } }), onSuccess: (_r, rid) => { invalidate(qc); onDone(rid); } });
  const ok = !!dev && f.description.trim().length >= 5;
  return (
    <Modal title="გაუმართაობის შეტყობინება" onClose={onClose} width={700}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button>
        <button className="btn primary" type="button" disabled={!ok || m.isPending || !!openList} onClick={() => m.mutate(false)}>გაგზავნა</button></>}>
      <div className="stack">
        {dev ? <div className="row"><strong className="grow"><span className="mono">{dev.inv_no}</span> {dev.name}</strong>{!device && <button className="btn sm" type="button" onClick={() => { setDev(null); setOpenList(null); }}>შეცვლა</button>}</div>
          : <div style={{ position: 'relative' }}>
            <Field label="აპარატი" htmlFor="rqd" required hint="№ / QR სკანი, დასახელება, სერიული"><input id="rqd" className="input" autoFocus value={s} onChange={(e) => setS(e.target.value)} /></Field>
            {(hits.data?.length ?? 0) > 0 && <ul className="listbox" role="listbox" aria-label="აპარატები" style={{ position: 'absolute', left: 0, right: 0, zIndex: 6 }}>
              {hits.data!.slice(0, 15).map((h) => <li key={h.id} role="option" aria-selected={false} onMouseDown={(e) => { e.preventDefault(); setDev(h); }}>
                <span className="mono small">{h.inv_no}</span>&nbsp;<span className="grow">{h.name}</span><span className="small muted">{h.department_name ?? ''}</span></li>)}</ul>}
          </div>}
        <Field label="მდგომარეობა" htmlFor="rqc" required><div className="seg" role="group" id="rqc">{(Object.keys(COND_KA) as Cond[]).map((c) =>
          <button key={c} type="button" aria-pressed={f.condition === c} onClick={() => setF({ ...f, condition: c })}>{COND_KA[c]}</button>)}</div></Field>
        <Field label="სასწრაფოობა" htmlFor="rqu"><div className="seg" role="group" id="rqu">{(Object.keys(URG_KA) as Urg[]).map((c) =>
          <button key={c} type="button" aria-pressed={f.urgency === c} onClick={() => setF({ ...f, urgency: c })}>{URG_KA[c]}</button>)}</div></Field>
        <Field label="რა ხდება" htmlFor="rqt" required><textarea id="rqt" className="input" rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })}
          placeholder="მაგ. არ ირთვება / შეცდომის კოდი E-12 / განგაში არ წყდება" /></Field>
        <div style={grid}>
          <Field label="საკონტაქტო ტელეფონი" htmlFor="rqp"><input id="rqp" className="input" value={f.contact_phone} onChange={(e) => setF({ ...f, contact_phone: e.target.value })} /></Field>
          <label className="row" style={{ marginTop: 26 }}><input type="checkbox" checked={f.patient_involved} onChange={(e) => setF({ ...f, patient_involved: e.target.checked })} /> შეეხო პაციენტს / თანამშრომელს</label>
        </div>
        {f.condition === 'not_working' && <span className="hint">„არ მუშაობს“ — აპარატი მაშინვე მოინიშნება „გაუმართავად“ (ჩაწერა / გამოყენება შეიზღუდება პარამეტრების მიხედვით).</span>}
        {f.patient_involved && <span className="hint">გაგზავნის შემდეგ გაიხსნება ინციდენტის ფორმა (ავტორის რეჟიმს თქვენ ირჩევთ).</span>}
        {openList && <div className="alert warn stack" style={{ gap: 6 }}>
          <strong>ამ აპარატზე უკვე ღია ორდერია:</strong>
          {openList.map((o) => <div key={o.id} className="row" style={{ gap: 8 }}><span className="mono small">{o.repair_no}</span><span className="small grow">{o.description}</span>
            <button className="btn sm" type="button" disabled={note.isPending || !ok} onClick={() => note.mutate(o.id)}>შენიშვნის დამატება</button></div>)}
          <div><button className="btn sm" type="button" disabled={m.isPending || !ok} onClick={() => m.mutate(true)}>მაინც ახალი ორდერი (სხვა დეფექტი)</button></div>
        </div>}
        <ErrorBox error={m.error && !(m.error instanceof ApiError && m.error.code === 'REPAIR_OPEN') ? m.error : note.error} />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- ორდერის ბარათი
export function RepairDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient(); const toast = useToast(); const refs = useRefs(); const [sp, setSp] = useSearchParams();
  const q = useQuery({ queryKey: ['bme-repair', id], queryFn: () => api<RepairFull>(`/bme/repairs/${id}`) });
  const r = q.data;
  const done = (x?: unknown) => { if (x && typeof x === 'object' && 'repair_no' in (x as object)) qc.setQueryData(['bme-repair', id], x); invalidate(qc); };
  const post = (path: string, body?: unknown) => api<RepairFull>(`/bme/repairs/${id}/${path}`, { body: body ?? {} });
  const act = useMutation({ mutationFn: (b: { action: string; note?: string | null; vendor_ref?: string | null }) => post('act', b), onSuccess: done });
  const simple = useMutation({ mutationFn: ({ path, body }: { path: string; body?: unknown }) => post(path, body), onSuccess: (x) => { done(x); toast.show('შენახულია'); } });
  const [noteText, setNoteText] = useState(''); const [file, setFile] = useState<File | null>(null); const [fkind, setFkind] = useState('act');
  const upload = useMutation({ mutationFn: () => { const fd = new FormData(); fd.append('file', file!); fd.append('kind', fkind); return apiUpload<RepairFull>(`/bme/repairs/${id}/files`, fd); }, onSuccess: (x) => { setFile(null); done(x); } });
  if (!r) return <Modal title="შეკეთების ორდერი" onClose={onClose} width={1050}>{q.error ? <ErrorBox error={q.error} /> : <Loading />}</Modal>;
  const isOpen = OPEN.includes(r.status); const m = r.can.manage;
  const ask = (msg: string, min = 3) => { const v = prompt(msg); return v && v.trim().length >= min ? v.trim() : null; };
  return (
    <Modal title={`${r.repair_no} — ${r.inv_no} ${r.device_name}`} onClose={onClose} width={1050}
      footer={<>
        <button className="btn" type="button" onClick={() => { sp.delete('repair'); sp.set('device', r.device_id); setSp(sp); }}>აპარატის პასპორტი</button>
        {r.can.reopen && <button className="btn" type="button" onClick={() => { const v = ask('ხელახლა გახსნის მიზეზი'); if (v) simple.mutate({ path: 'reopen', body: { reason: v, not_working: confirm('აპარატი ისევ არ მუშაობს? (OK — „გაუმართავი“)') } }); }}>ხელახლა გახსნა</button>}
        <span className="grow" />
        <button className="btn" type="button" onClick={onClose}>დახურვა</button>
        {r.can.close && <button className="btn" type="button" onClick={() => simple.mutate({ path: 'close', body: {} })}>ორდერის დახურვა</button>}
        {r.can.confirm && <button className="btn primary" type="button" onClick={() => simple.mutate({ path: 'confirm', body: {} })}>მიღება დადასტურებულია</button>}
      </>}>
      {toast.node}
      <div className="stack">
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <RepStatusChip s={r.status} /><PriorityChip p={r.priority} suggested={r.suggested_priority} />
          <span className={`chip ${r.condition === 'not_working' ? 'danger' : r.condition === 'limited' ? 'warn' : ''}`}>{COND_KA[r.condition]}</span>
          {r.urgency !== 'normal' && <span className="chip danger">{URG_KA[r.urgency]}</span>}
          <span className="chip">{SRC_KA[r.source]}{r.pm_work_no ? ` · ${r.pm_work_no}` : ''}</span>
          {r.coverage && <span className="chip ok">{r.coverage === 'warranty' ? 'გარანტია' : `კონტრაქტი ${r.contract_no}`}</span>}
          {r.reopen_count > 0 && <span className="chip warn">ხელახლა გახსნილი ×{r.reopen_count}</span>}
          <span className="grow" />
          <SlaChip s={r.sla_response} label={`რეაგ. ${r.sla_response_hours ?? '—'} სთ`} /><SlaChip s={r.sla_restore} label={`აღდგ. ${r.sla_restore_hours ?? '—'} სთ`} />
        </div>
        {r.hold && <div className="alert danger">შენახულია გამოძიებისთვის (ინციდენტი){r.hold_note ? `: ${r.hold_note}` : ''} — არ გამოიყენოთ, არ შეაკეთოთ, სანამ ხარისხის მენეჯერი არ მოხსნის.</div>}
        <div className="small row" style={{ flexWrap: 'wrap', gap: 16 }}>
          <span>აპარატი: <strong>{DEV_ST_KA[r.device_status] ?? r.device_status}</strong>{r.manufacturer || r.model ? ` · ${[r.manufacturer, r.model].filter(Boolean).join(' ')}` : ''}{r.serial_no ? ` · SN ${r.serial_no}` : ''}</span>
          <span>{r.department_name ?? ''}{r.room ? ` · ოთახი ${r.room}` : ''}</span>
          <span>განაცხადა: <strong>{r.reported_by_name}</strong> {dt(r.reported_at)}{r.contact_phone ? ` · ☎ ${r.contact_phone}` : ''}</span>
        </div>
        <div className="card card-pad small" style={{ whiteSpace: 'pre-wrap' }}>{r.description}</div>
        {r.triage_note && <div className="small">ტრიაჟი ({r.triaged_by_name}): {r.triage_note}</div>}
        {r.status === 'rejected' || r.status === 'duplicate' ? <div className="alert">{REJ_KA[r.reject_reason ?? 'other']}{r.reject_note ? ` — ${r.reject_note}` : ''}{r.duplicate_of_no ? ` · ძირითადი: ${r.duplicate_of_no}` : ''}</div> : null}

        {m && isOpen && refs.data && <TriagePanel r={r} refs={refs.data} onDone={done} />}
        {m && isOpen && r.status !== 'requested' && (
          <section className="card card-pad stack" style={{ gap: 8 }}>
            <strong className="small">სამუშაო</strong>
            <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
              {['triaged', 'waiting_parts', 'waiting_vendor'].includes(r.status) && r.performer_kind === 'internal' && <button className="btn sm primary" type="button" disabled={act.isPending} onClick={() => act.mutate({ action: r.status === 'triaged' ? 'start' : 'resume' })}>{r.status === 'triaged' ? 'სამუშაოს დაწყება' : 'გაგრძელება'}</button>}
              {r.performer_kind === 'external' && !r.vendor_called_at && <button className="btn sm" type="button" onClick={() => act.mutate({ action: 'vendor_called', vendor_ref: prompt('მომწოდებლის ბილეთის № (არასავალდ.)') || null })}>მომწოდებელი გამოძახებულია</button>}
              {r.performer_kind === 'external' && r.vendor_called_at && !r.vendor_arrived_at && <button className="btn sm primary" type="button" onClick={() => act.mutate({ action: 'vendor_arrived' })}>მომწოდებელი მოვიდა</button>}
              {r.performer_kind === 'external' && r.vendor_arrived_at && ['waiting_parts', 'waiting_vendor'].includes(r.status) && <button className="btn sm" type="button" onClick={() => act.mutate({ action: 'resume' })}>გაგრძელება</button>}
              {['triaged', 'in_progress'].includes(r.status) && <button className="btn sm" type="button" onClick={() => { const v = ask('რას ელოდება (ნაწილი)?'); if (v) act.mutate({ action: 'wait_parts', note: v }); }}>ელოდება ნაწილს</button>}
              {['triaged', 'in_progress'].includes(r.status) && <button className="btn sm" type="button" onClick={() => { const v = ask('ლოდინის მიზეზი (მომწოდებელი)'); if (v) act.mutate({ action: 'wait_vendor', note: v }); }}>ელოდება მომწოდებელს</button>}
            </div>
            <div className="small muted">{r.vendor_called_at && <>გამოძახება: {dt(r.vendor_called_at)}{r.vendor_ref ? ` (${r.vendor_ref})` : ''} · </>}{r.vendor_arrived_at && <>ჩამოვიდა: {dt(r.vendor_arrived_at)} · </>}{r.started_at && <>დაიწყო: {dt(r.started_at)}</>}</div>
            <ErrorBox error={act.error} />
          </section>)}
        {m && isOpen && r.status !== 'requested' && refs.data && <PartsPanel r={r} refs={refs.data} onDone={done} />}
        {m && isOpen && r.status !== 'requested' && refs.data && <CompletePanel r={r} refs={refs.data} onDone={(x) => { done(x); toast.show('ორდერი დასრულდა'); }} />}

        {(r.status === 'done' || r.status === 'closed') && (
          <section className={`alert ${r.outcome === 'not_repairable' ? 'danger' : 'ok'}`} style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
            <strong>{OUT_KA[r.outcome ?? '']}</strong><span>{r.resolution}</span>
            {r.cause_name && <span className="small">· მიზეზი: {r.cause_name}</span>}{r.action_name && <span className="small">· ქმედება: {r.action_name}</span>}
            <span className="small">· {dt(r.done_at)} ({r.done_by_name})</span>
            <span className="grow" />
            {r.suggested_status && !r.status_applied && m && <button className="btn sm primary" type="button" disabled={simple.isPending || r.post_check_pending}
              title={r.post_check_pending ? 'ჯერ — შემოწმება' : undefined} onClick={() => { if (confirm(`აპარატის სტატუსი → „${DEV_ST_KA[r.suggested_status!]}“?`)) simple.mutate({ path: 'apply-status' }); }}>სტატუსი: {DEV_ST_KA[r.suggested_status]}</button>}
            {r.status_applied && <span className="chip">სტატუსი შეიცვალა</span>}
          </section>)}
        {r.post_check_work_id && <div className="row small" style={{ gap: 8 }}>შემოწმება შეკეთების შემდეგ: <button className="link" type="button" onClick={() => { sp.set('work', r.post_check_work_id!); setSp(sp); }}>{r.post_check_work_no}</button>
          <span className={`chip ${r.post_check_pending ? 'warn' : 'ok'}`}>{r.post_check_pending ? (r.post_check_required ? 'სავალდებულო — ელოდება' : 'ელოდება') : 'შესრულდა'}</span></div>}
        {r.status === 'done' && !r.can.confirm && r.post_check_pending && <span className="hint">დადასტურება / დახურვა — შემოწმების (სამუშაოს) შესრულების შემდეგ.</span>}
        {r.status === 'closed' && <div className="small muted">დაიხურა {dt(r.closed_at)} · {r.close_kind === 'confirmed' ? 'განყოფილებამ დაადასტურა' : r.close_kind === 'auto' ? 'ავტომატურად (დადასტურების გარეშე)' : 'ინჟინერმა'}{r.closed_by_name ? ` (${r.closed_by_name})` : ''}</div>}

        <section className="row" style={{ flexWrap: 'wrap', gap: 16 }}>
          <div className="stack" style={{ gap: 4, minWidth: 260 }}>
            <strong className="small">ხარჯი</strong>
            <span className="small">ნაწილები: {money(r.parts_cost)} · შრომა: {money(r.labor_cost)}{r.labor_hours ? ` (${Number(r.labor_hours)} სთ)` : ''} · გარე: {money(r.external_cost)}</span>
            <strong className="small">ჯამი: {money(r.total_cost)}{r.invoice_no ? ` · ინვოისი ${r.invoice_no}` : ''}{r.ap_invoice_no ? ` (AP ${r.ap_invoice_no})` : ''}</strong>
          </div>
          <div className="stack grow" style={{ gap: 4 }}>
            <strong className="small">ინციდენტი / შენახვა გამოძიებისთვის</strong>
            <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
              {r.incidents.map((i) => <span key={i.id} className={`chip ${r.incident_id === i.id ? 'info' : ''}`}>{i.inc_no} · {i.status}</span>)}
              {!r.incidents.length && <span className="small muted">—</span>}
              <ReportIncidentButton source={{ type: 'bme_device', id: r.device_id, label: `აპარატი ${r.inv_no} · ${r.device_name}` }} department_id={r.department_id} />
              {r.can.hold && !r.hold && OPEN.concat('done').includes(r.status) && <button className="btn sm" type="button" onClick={() => { const v = ask('შენახვის მიზეზი (ინციდენტის გამოძიება)'); if (v) simple.mutate({ path: 'hold', body: { on: true, note: v } }); }}>შენახვა გამოძიებისთვის</button>}
              {r.can.release && r.hold && <button className="btn sm" type="button" onClick={() => simple.mutate({ path: 'hold', body: { on: false } })}>შენახვის მოხსნა</button>}
              {r.can.hold && r.incidents.length > 0 && <select className="select" style={{ height: 32, maxWidth: 200 }} aria-label="ინციდენტის ბმა" value={r.incident_id ?? ''} onChange={(e) => simple.mutate({ path: 'incident', body: { incident_id: e.target.value || null } })}>
                <option value="">— ბმის გარეშე —</option>{r.incidents.map((i) => <option key={i.id} value={i.id}>{i.inc_no}</option>)}</select>}
            </div>
          </div>
        </section>

        {(r.parts.length > 0 || r.purchases.length > 0) && <section className="stack" style={{ gap: 4 }}>
          <strong className="small">ნაწილები / შესყიდვა</strong>
          <table className="table"><tbody>{r.parts.map((p, i) => <tr key={i}><td className="mono small">{p.doc_no}</td><td className="small">{p.item_name}{p.lot_no ? ` · ${p.lot_no}` : ''}</td><td className="num mono">{Number(p.qty)}</td><td className="small">{p.location_name}</td><td className="num">{money(p.line_net)}</td></tr>)}
            {r.purchases.map((p) => <tr key={p.id}><td className="mono small">{p.pr_no ?? 'მონახაზი'}</td><td className="small">შესყიდვის მოთხოვნა</td><td /><td className="small">{p.status}</td><td className="num">{money(p.est_total)}</td></tr>)}</tbody></table>
        </section>}
        {r.periods.length > 0 && <div className="small muted">downtime (ამ ორდერით): {r.periods.map((p) => `${DEV_ST_KA[p.status] ?? p.status} ${p.hours} სთ${p.ended_at ? '' : ' (მიმდინარე)'}`).join(' · ')}</div>}
        {r.duplicates.length > 0 && <div className="small muted">დუბლიკატები: {r.duplicates.map((d) => d.repair_no).join(', ')}</div>}

        <section className="stack" style={{ gap: 6 }}>
          <strong className="small">ფაილები</strong>
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>{r.documents.map((d) => <button key={d.id} className="btn sm" type="button" onClick={() => void openBlob(`/bme/devices/${r.device_id}/documents/${d.id}`)}>{d.title}</button>)}
            {!r.documents.length && <span className="small muted">—</span>}</div>
          {(m || r.status === 'requested') && <div className="row" style={{ gap: 6 }}>
            <select className="select" style={{ height: 32, maxWidth: 160 }} aria-label="ფაილის სახე" value={fkind} onChange={(e) => setFkind(e.target.value)}><option value="act">სერვისის აქტი</option><option value="photo">ფოტო</option><option value="other">სხვა</option></select>
            <input type="file" aria-label="ფაილი" accept="application/pdf,image/jpeg,image/png" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <button className="btn sm" type="button" disabled={!file || upload.isPending} onClick={() => upload.mutate()}>ატვირთვა</button></div>}
        </section>

        <section className="stack" style={{ gap: 6 }}>
          <strong className="small">ქრონოლოგია</strong>
          <table className="table"><tbody>{r.events.map((e) => <tr key={e.id}><td className="small" style={{ whiteSpace: 'nowrap' }}>{dt(e.created_at)}</td><td className="small">{EVK[e.kind] ?? e.kind}</td>
            <td className="small muted">{evText(e)}</td><td className="small">{e.user_name ?? 'სისტემა'}</td></tr>)}</tbody></table>
          {!['closed', 'rejected', 'duplicate'].includes(r.status) && <div className="row" style={{ gap: 6 }}>
            <input className="input" style={{ height: 34 }} aria-label="შენიშვნა" placeholder="შენიშვნა / დამატებითი ინფორმაცია" value={noteText} onChange={(e) => setNoteText(e.target.value)} />
            <button className="btn sm" type="button" disabled={noteText.trim().length < 2 || simple.isPending} onClick={() => { simple.mutate({ path: 'note', body: { text: noteText.trim() } }); setNoteText(''); }}>დამატება</button></div>}
        </section>
        <ErrorBox error={simple.error ?? upload.error} />
      </div>
    </Modal>
  );
}
function evText(e: { kind: string; data: Record<string, unknown> }) {
  const d = e.data;
  switch (e.kind) {
    case 'requested': return `${COND_KA[d.condition as Cond] ?? ''} · შეთავაზება P${d.suggested_priority}${d.status_down ? ' · აპარატი → გაუმართავი' : ''}`;
    case 'triaged': case 'assigned': return `P${d.priority} · ${d.performer_kind === 'external' ? 'გარე' : 'შიდა'}${d.coverage ? ` · ${d.coverage === 'warranty' ? 'გარანტია' : 'კონტრაქტი'}` : ''} · SLA ${d.response_h ?? '—'}/${d.restore_h ?? '—'} სთ${d.note ? ` · ${d.note}` : ''}`;
    case 'parts_issued': return `${d.doc_no} · ${d.location} · ${money(d.total as number)}`;
    case 'purchase': return `${d.lines} ხაზი · ~${money(d.est_total as number)}`;
    case 'done': return `${OUT_KA[d.outcome as string] ?? ''}${d.labor_hours ? ` · ${d.labor_hours} სთ` : ''}`;
    case 'rejected': case 'duplicate': return `${REJ_KA[d.reason as string] ?? ''}${d.note ? ` — ${d.note}` : ''}`;
    case 'post_check': return `${d.work_no}${d.result ? ` · ${d.result}` : ''}${d.required ? ' (სავალდებულო)' : ''}`;
    case 'closed': return d.kind === 'auto' ? `ავტომატურად (${d.days} დღე)` : 'ინჟინერი';
    case 'status_applied': return DEV_ST_KA[d.status as string] ?? '';
    case 'reopened': return String(d.reason ?? '');
    case 'sla_warn': case 'sla_breach': return String(d.what ?? '').startsWith('response') ? 'რეაგირება' : 'აღდგენა';
    default: return typeof d.note === 'string' ? d.note : typeof d.text === 'string' ? d.text : typeof d.reason === 'string' ? d.reason : typeof d.title === 'string' ? d.title : typeof d.inc_no === 'string' ? d.inc_no : '';
  }
}

function TriagePanel({ r, refs, onDone }: { r: RepairFull; refs: Refs; onDone: (x: RepairFull) => void }) {
  const first = r.status === 'requested';
  const cov = r.coverage_info;
  const [f, setF] = useState({ priority: String(r.priority ?? r.suggested_priority), performer_kind: r.performer_kind, assignee_id: r.assignee_id ?? '', supplier_id: r.supplier_id ?? (first && cov?.supplier_id ? cov.supplier_id : ''),
    external_person: r.external_person ?? '', triage_note: r.triage_note ?? '', use_coverage: true, vendor_called: false, device_status: '', loaner_text: r.loaner_text ?? '' });
  // დაფარვა + ცნობილი მომწოდებელი → გარე შემსრულებლის შეთავაზება
  useEffect(() => { if (first && cov?.coverage && cov.supplier_id) setF((x) => ({ ...x, performer_kind: 'external', supplier_id: cov.supplier_id ?? '' })); }, [cov?.coverage]); // eslint-disable-line react-hooks/exhaustive-deps
  const [rej, setRej] = useState({ open: false, reason: 'no_fault', note: '', duplicate_of: '' });
  const save = useMutation({ mutationFn: () => api<RepairFull>(`/bme/repairs/${r.id}/triage`, { body: {
    priority: Number(f.priority), performer_kind: f.performer_kind, assignee_id: f.assignee_id || null,
    ...(f.performer_kind === 'external' ? { supplier_id: f.supplier_id || null, external_person: nn(f.external_person), use_coverage: f.use_coverage, vendor_called: f.vendor_called } : {}),
    triage_note: nn(f.triage_note), loaner_text: nn(f.loaner_text), ...(f.device_status && { device_status: f.device_status }) } }), onSuccess: onDone });
  const reject = useMutation({ mutationFn: () => api<RepairFull>(`/bme/repairs/${r.id}/reject`, { body: { reason: rej.reason, note: nn(rej.note), ...(rej.reason === 'duplicate' && { duplicate_of: rej.duplicate_of }) } }), onSuccess: onDone });
  const extOk = f.performer_kind === 'internal' || !!f.supplier_id || f.external_person.trim().length > 1;
  return (
    <section className="card card-pad stack" style={{ gap: 8, borderLeft: first ? '3px solid var(--danger, #c00)' : undefined }}>
      <div className="row"><strong className="small grow">{first ? 'ტრიაჟი' : 'მინიჭება / პრიორიტეტი'}</strong>
        {cov?.coverage && <span className="chip ok">{cov.coverage === 'warranty' ? `გარანტია ${dateGe(cov.until!)}-მდე` : `კონტრაქტი ${cov.contract_no} (${CT_KA[cov.contract_kind ?? ''] ?? ''})`} · {cov.supplier_name}</span>}</div>
      <div style={grid}>
        <Field label="პრიორიტეტი" htmlFor="tp" hint={`შეთავაზება: P${r.suggested_priority}; SLA (შიდა): ${refs.settings.rep_sla_response[Number(f.priority) - 1]} / ${refs.settings.rep_sla_restore[Number(f.priority) - 1]} სთ`}>
          <select id="tp" className="select" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>{[1, 2, 3, 4].map((p) => <option key={p} value={p}>P{p}{p === r.suggested_priority ? ' (შეთავაზება)' : ''}</option>)}</select></Field>
        <Field label="შემსრულებელი" htmlFor="tk"><div className="seg" role="group" id="tk">
          <button type="button" aria-pressed={f.performer_kind === 'internal'} onClick={() => setF({ ...f, performer_kind: 'internal' })}>შიდა</button>
          <button type="button" aria-pressed={f.performer_kind === 'external'} onClick={() => setF({ ...f, performer_kind: 'external' })}>გარე (სერვისი)</button></div></Field>
        <Field label={f.performer_kind === 'internal' ? 'ინჟინერი' : 'კოორდინატორი (ინჟინერი)'} htmlFor="ta"><select id="ta" className="select" value={f.assignee_id} onChange={(e) => setF({ ...f, assignee_id: e.target.value })}>
          <option value="">— არ არის —</option>{refs.engineers.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
        {f.performer_kind === 'external' && <>
          <Field label="მომწოდებელი / სერვისი" htmlFor="ts"><select id="ts" className="select" value={f.supplier_id} onChange={(e) => setF({ ...f, supplier_id: e.target.value })}>
            <option value="">—</option>{refs.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
          <Field label="კონტაქტი" htmlFor="te"><input id="te" className="input" value={f.external_person} onChange={(e) => setF({ ...f, external_person: e.target.value })} /></Field>
        </>}
        <Field label="აპარატის სტატუსი" htmlFor="tds" hint={`ახლა: ${DEV_ST_KA[r.device_status] ?? r.device_status}`}><select id="tds" className="select" value={f.device_status} onChange={(e) => setF({ ...f, device_status: e.target.value })}>
          <option value="">— უცვლელი —</option><option value="down">გაუმართავი</option><option value="restricted">შეზღუდულად მუშა</option><option value="operational">მუშა</option></select></Field>
        <Field label="შემცვლელი აპარატი" htmlFor="tl"><input id="tl" className="input" value={f.loaner_text} onChange={(e) => setF({ ...f, loaner_text: e.target.value })} placeholder="მაგ. BME-00042 / მომწოდებლის დროებითი" /></Field>
      </div>
      {f.performer_kind === 'external' && <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
        {cov?.coverage && <label className="row"><input type="checkbox" checked={f.use_coverage} onChange={(e) => setF({ ...f, use_coverage: e.target.checked })} /> დაფარულია ({cov.coverage === 'warranty' ? 'გარანტია' : 'კონტრაქტი'}) — SLA {cov.response_hours ? 'კონტრაქტიდან' : 'პარამეტრებიდან'}</label>}
        {!r.vendor_called_at && <label className="row"><input type="checkbox" checked={f.vendor_called} onChange={(e) => setF({ ...f, vendor_called: e.target.checked })} /> მომწოდებელი უკვე გამოძახებულია</label>}
      </div>}
      <Field label="კომენტარი" htmlFor="tn"><input id="tn" className="input" value={f.triage_note} onChange={(e) => setF({ ...f, triage_note: e.target.value })} /></Field>
      <div className="row" style={{ gap: 6 }}>
        <button className="btn sm primary" type="button" disabled={save.isPending || !extOk} onClick={() => save.mutate()}>{first ? 'ტრიაჟი' : 'შენახვა'}</button>
        {['requested', 'triaged'].includes(r.status) && <button className="btn sm" type="button" onClick={() => setRej({ ...rej, open: !rej.open })}>უარყოფა / დუბლიკატი</button>}
      </div>
      {rej.open && <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="მიზეზი" htmlFor="rr"><select id="rr" className="select" value={rej.reason} onChange={(e) => setRej({ ...rej, reason: e.target.value })}>{Object.entries(REJ_KA).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        {rej.reason === 'duplicate' ? <Field label="ძირითადი ორდერი" htmlFor="rd"><select id="rd" className="select" value={rej.duplicate_of} onChange={(e) => setRej({ ...rej, duplicate_of: e.target.value })}>
          <option value="">—</option>{r.open_others.map((o) => <option key={o.id} value={o.id}>{o.repair_no}</option>)}</select></Field> : null}
        <div className="grow"><Field label="კომენტარი" htmlFor="rn" required={rej.reason === 'other'}><input id="rn" className="input" value={rej.note} onChange={(e) => setRej({ ...rej, note: e.target.value })} /></Field></div>
        <button className="btn sm danger" type="button" disabled={reject.isPending || (rej.reason === 'duplicate' && !rej.duplicate_of) || (rej.reason === 'other' && rej.note.trim().length < 3)} onClick={() => reject.mutate()}>დადასტურება</button>
      </div>}
      <ErrorBox error={save.error ?? reject.error} />
    </section>
  );
}

interface StockHit { id: string; name: string; code: string | null; qty: string | null }
function PartsPanel({ r, refs, onDone }: { r: RepairFull; refs: Refs; onDone: (x: RepairFull) => void }) {
  const [open, setOpen] = useState<'parts' | 'buy' | null>(null);
  const [loc, setLoc] = useState(refs.settings.rep_parts_location_id ?? '');
  const [s, setS] = useState(''); const ds = useDebounced(s.trim(), 250);
  const items = useQuery({ queryKey: ['bme-rep-stock', loc, ds, open], queryFn: () => api<StockHit[]>('/bme/repairs/stock-items', { query: { location_id: open === 'parts' ? loc : undefined, search: ds } }),
    enabled: (open === 'parts' && !!loc) || (open === 'buy' && ds.length >= 2) });
  const [lines, setLines] = useState<{ item_id?: string; name: string; qty: string; est_price: string; max?: number }[]>([]);
  const [free, setFree] = useState('');
  const issue = useMutation({ mutationFn: () => api<{ repair: RepairFull }>(`/bme/repairs/${r.id}/parts`, { body: { location_id: loc, lines: lines.map((l) => ({ item_id: l.item_id, qty: Number(l.qty.replace(',', '.')) })) } }),
    onSuccess: (x) => { setLines([]); setOpen(null); onDone(x.repair); } });
  const buy = useMutation({ mutationFn: () => api<{ repair: RepairFull }>(`/bme/repairs/${r.id}/purchase`, { body: { location_id: loc || undefined,
    lines: lines.map((l) => ({ ...(l.item_id ? { item_id: l.item_id } : { free_name: l.name }), qty: Number(l.qty.replace(',', '.')), est_price: l.est_price.trim() ? Number(l.est_price.replace(',', '.')) : null })) } }),
    onSuccess: (x) => { setLines([]); setOpen(null); onDone(x.repair); } });
  const add = (h: { id?: string; name: string; qty?: string | null }) => { setLines([...lines, { item_id: h.id, name: h.name, qty: '1', est_price: '', max: h.qty ? Number(h.qty) : undefined }]); setS(''); setFree(''); };
  const valid = lines.length > 0 && lines.every((l) => Number(l.qty.replace(',', '.')) > 0 && (open === 'buy' || (l.max === undefined || Number(l.qty) <= l.max)));
  return (
    <section className="card card-pad stack" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 6 }}><strong className="small grow">ნაწილები</strong>
        <button className="btn sm" type="button" aria-pressed={open === 'parts'} onClick={() => { setOpen(open === 'parts' ? null : 'parts'); setLines([]); }}>ჩამოწერა საწყობიდან</button>
        <button className="btn sm" type="button" aria-pressed={open === 'buy'} onClick={() => { setOpen(open === 'buy' ? null : 'buy'); setLines([]); }}>შესყიდვის მოთხოვნა</button></div>
      {open && <>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <select className="select" style={{ maxWidth: 260, height: 36 }} aria-label="ლოკაცია" value={loc} onChange={(e) => setLoc(e.target.value)}>
            <option value="">{open === 'parts' ? '— საწყობი —' : '— მიწოდების ლოკაცია —'}</option>{refs.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
          <input className="input" style={{ maxWidth: 280, height: 36 }} aria-label="საქონლის ძებნა" placeholder={open === 'parts' ? 'ძებნა (ნაშთიანი)' : 'კატალოგში ძებნა (მინ. 2)'} value={s} onChange={(e) => setS(e.target.value)} />
          {open === 'buy' && <><input className="input" style={{ maxWidth: 240, height: 36 }} aria-label="თავისუფალი დასახელება" placeholder="ან — დასახელება (კატალოგის გარეშე)" value={free} onChange={(e) => setFree(e.target.value)} />
            <button className="btn sm" type="button" disabled={free.trim().length < 2} onClick={() => add({ name: free.trim() })}>+</button></>}
        </div>
        {(items.data?.length ?? 0) > 0 && <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>{items.data!.filter((h) => !lines.some((l) => l.item_id === h.id)).slice(0, 20).map((h) =>
          <button key={h.id} className="btn sm" type="button" onClick={() => add(h)}>{h.name}{h.qty ? ` (${Number(h.qty)})` : ''}</button>)}</div>}
        {lines.length > 0 && <table className="table"><tbody>{lines.map((l, i) => <tr key={i}><td className="small">{l.name}{!l.item_id && <span className="chip" style={{ height: 18, fontSize: 10, marginLeft: 6 }}>კატალოგის გარეშე</span>}</td>
          <td><input className="input mono" style={{ width: 90, height: 32 }} aria-label="რაოდენობა" value={l.qty} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} />{l.max !== undefined && <span className="small muted"> / {l.max}</span>}</td>
          {open === 'buy' && <td><input className="input mono" style={{ width: 110, height: 32 }} aria-label="სავარაუდო ფასი" placeholder="ფასი ₾" value={l.est_price} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, est_price: e.target.value } : x)))} /></td>}
          <td><button className="btn sm" type="button" onClick={() => setLines(lines.filter((_, j) => j !== i))}>✕</button></td></tr>)}</tbody></table>}
        <div className="row" style={{ gap: 6 }}>
          {open === 'parts' ? <button className="btn sm primary" type="button" disabled={!valid || !loc || issue.isPending} onClick={() => issue.mutate()}>ჩამოწერა (bme_use)</button>
            : <button className="btn sm primary" type="button" disabled={!valid || buy.isPending} onClick={() => buy.mutate()}>მონახაზის შექმნა → „ელოდება ნაწილებს“</button>}
          {open === 'buy' && <span className="hint">მოთხოვნა იქმნება მონახაზად — საწყობის მენეჯერი / შესყიდვები ავსებს ფასს / მომწოდებელს და აგზავნის.</span>}
        </div>
        <ErrorBox error={issue.error ?? buy.error} />
      </>}
    </section>
  );
}

function CompletePanel({ r, refs, onDone }: { r: RepairFull; refs: Refs; onDone: (x: RepairFull) => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ outcome: 'repaired', cause_id: '', action_id: '', resolution: '', labor_hours: '', external_cost: '', invoice_no: '', post_check_kind_id: '' });
  const pc = refs.settings.rep_post_check;
  const critical = ['life_support', 'high'].includes(r.criticality);
  const required = pc === 'required_life_support' && r.criticality === 'life_support' && f.outcome === 'repaired';
  const showPc = pc !== 'off' && critical && f.outcome === 'repaired';
  useEffect(() => { if (showPc && !f.post_check_kind_id) setF((x) => ({ ...x, post_check_kind_id: refs.kinds.find((k) => k.code === 'SAFETY')?.id ?? '' })); }, [showPc]); // eslint-disable-line react-hooks/exhaustive-deps
  const num = (x: string) => (x.trim() ? Number(x.replace(',', '.')) : null);
  const m = useMutation({ mutationFn: () => api<RepairFull>(`/bme/repairs/${r.id}/complete`, { body: { outcome: f.outcome, resolution: f.resolution.trim(), cause_id: f.cause_id || null, action_id: f.action_id || null,
    labor_hours: num(f.labor_hours), external_cost: num(f.external_cost) ?? 0, invoice_no: nn(f.invoice_no), ...(showPc && f.post_check_kind_id && { post_check_kind_id: f.post_check_kind_id }) } }), onSuccess: onDone });
  if (!open) return <div><button className="btn primary" type="button" disabled={r.hold} title={r.hold ? 'შენახულია გამოძიებისთვის' : undefined} onClick={() => setOpen(true)}>დასრულება…</button></div>;
  const ok = f.resolution.trim().length >= 3 && (f.outcome === 'no_fault' || !!f.cause_id) && (!required || !!f.post_check_kind_id);
  return (
    <section className="card card-pad stack" style={{ gap: 8 }}>
      <strong className="small">დასრულება</strong>
      <div style={grid}>
        <Field label="შედეგი" htmlFor="co"><select id="co" className="select" value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value })}>{Object.entries(OUT_KA).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="მიზეზი" htmlFor="cc" required={f.outcome !== 'no_fault'}><select id="cc" className="select" value={f.cause_id} onChange={(e) => setF({ ...f, cause_id: e.target.value })}>
          <option value="">—</option>{refs.codes.filter((c) => c.kind === 'cause' && c.is_active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        <Field label="ქმედება" htmlFor="ca"><select id="ca" className="select" value={f.action_id} onChange={(e) => setF({ ...f, action_id: e.target.value })}>
          <option value="">—</option>{refs.codes.filter((c) => c.kind === 'action' && c.is_active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        <Field label="შრომა (საათი)" htmlFor="cl" hint={refs.settings.rep_labor_rate ? `× ${refs.settings.rep_labor_rate} ₾/სთ` : 'ფულადი შეფასება გამორთულია'}><input id="cl" className="input mono" inputMode="decimal" value={f.labor_hours} onChange={(e) => setF({ ...f, labor_hours: e.target.value })} /></Field>
        <Field label="გარე ხარჯი (₾)" htmlFor="cx" hint={r.coverage ? 'დაფარულია — ჩვეულებრივ 0' : 'ხარჯის ჟურნალში — AP ინვოისით'}><input id="cx" className="input mono" inputMode="decimal" value={f.external_cost} onChange={(e) => setF({ ...f, external_cost: e.target.value })} /></Field>
        <Field label="ინვოისის №" htmlFor="ci"><input id="ci" className="input mono" value={f.invoice_no} onChange={(e) => setF({ ...f, invoice_no: e.target.value })} /></Field>
        {showPc && <Field label="შემოწმება შეკეთების შემდეგ" htmlFor="cp" required={required} hint={required ? 'სიცოცხლის შემანარჩუნებელი — სავალდებულო' : 'მაღალი კრიტიკულობა — რეკომენდებული'}>
          <select id="cp" className="select" value={f.post_check_kind_id} onChange={(e) => setF({ ...f, post_check_kind_id: e.target.value })}>
            {!required && <option value="">— არა —</option>}{refs.kinds.map((k) => <option key={k.id} value={k.id}>{k.short_name}</option>)}</select></Field>}
      </div>
      <Field label="რა გაკეთდა" htmlFor="cr" required><textarea id="cr" className="input" rows={2} value={f.resolution} onChange={(e) => setF({ ...f, resolution: e.target.value })} /></Field>
      <div className="row" style={{ gap: 6 }}><button className="btn sm primary" type="button" disabled={!ok || m.isPending} onClick={() => m.mutate()}>დასრულება</button>
        <button className="btn sm" type="button" onClick={() => setOpen(false)}>გაუქმება</button>
        <span className="hint">{refs.settings.rep_close_mode === 'confirm' ? `შემდეგ — განყოფილების დადასტურება (ავტომატურად ${refs.settings.rep_close_auto_days || '—'} დღეში)` : 'ორდერი დაიხურება (შემოწმების შემდეგ, თუ სავალდებულოა)'}</span></div>
      <ErrorBox error={m.error} />
    </section>
  );
}

// ---------------------------------------------------------------- აპარატის ჩანართი „შეკეთება / კონტრაქტები“
export function DeviceRepairs({ device, retired }: { device: { id: string; inv_no: string; name: string; department_id: string | null }; retired: boolean }) {
  const [sp, setSp] = useSearchParams();
  const q = useQuery({ queryKey: ['bme-device-repairs', device.id], queryFn: () => api<{ repairs: Repair[]; coverage: Coverage; contracts: (Contract & { in_force: boolean })[]; can_request: boolean }>(`/bme/devices/${device.id}/repairs`) });
  const [req, setReq] = useState(false);
  if (q.isLoading) return <Loading />;
  const d = q.data; if (!d) return <ErrorBox error={q.error} />;
  return (
    <div className="stack">
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {d.coverage.coverage ? <span className="chip ok">{d.coverage.coverage === 'warranty' ? `ქარხნული გარანტია ${dateGe(d.coverage.until!)}-მდე` : `კონტრაქტი ${d.coverage.contract_no} — ${dateGe(d.coverage.until!)}-მდე`} · {d.coverage.supplier_name}</span>
          : <span className="chip">გარანტია / კონტრაქტი — არა</span>}
        <span className="grow" />
        {d.can_request && !retired && <button className="btn sm primary" type="button" onClick={() => setReq(true)}>+ გაუმართაობის შეტყობინება</button>}
      </div>
      <table className="table">
        <thead><tr><th>№</th><th>P</th><th>მოთხოვნა</th><th>სტატუსი</th><th>შედეგი</th><th className="num">ჯამი</th></tr></thead>
        <tbody>{d.repairs.map((r) => <tr key={r.id} className="clickable" onClick={() => { sp.set('repair', r.id); setSp(sp); }}>
          <td className="mono small">{r.repair_no}<div className="muted">{tsDate(r.reported_at)}</div></td><td><PriorityChip p={r.priority} suggested={r.suggested_priority} /></td>
          <td className="small">{COND_KA[r.condition]}<div className="muted">{r.description.slice(0, 80)}</div></td><td><RepStatusChip s={r.status} /></td>
          <td className="small">{r.outcome ? OUT_KA[r.outcome] : '—'}</td><td className="num small">{money(r.total_cost)}</td></tr>)}
          {!d.repairs.length && <tr><td colSpan={6} className="muted">შეკეთება არ ყოფილა</td></tr>}</tbody>
      </table>
      {d.contracts.length > 0 && <><strong className="small">სერვისის კონტრაქტები</strong>
        <table className="table"><tbody>{d.contracts.map((c) => <tr key={c.id} className="clickable" onClick={() => { sp.set('contract', c.id); setSp(sp); }}>
          <td className="mono small">{c.contract_no}</td><td className="small">{c.title}<div className="muted">{c.supplier_name} · {CT_KA[c.kind]}</div></td>
          <td className="small">{dateGe(c.start_date)} – {dateGe(c.end_date)}</td><td>{c.in_force ? <span className="chip ok">მოქმედი</span> : <span className="chip">{c.status === 'cancelled' ? 'გაუქმებული' : 'არამოქმედი'}</span>}</td></tr>)}</tbody></table></>}
      {req && <RequestDialog device={device} onClose={() => setReq(false)} onDone={(id) => { setReq(false); sp.set('repair', id); setSp(sp); }} />}
    </div>
  );
}

// ---------------------------------------------------------------- კონტრაქტები
const CVIEWS: [string, string][] = [['active', 'მოქმედი'], ['expiring', 'ვადა ≤ 90 დღე'], ['expired', 'ვადაგასული'], ['cancelled', 'გაუქმებული'], ['all', 'ყველა']];
export function ContractsPage() {
  const { user } = useAuth(); const [sp, setSp] = useSearchParams();
  const [f, setF] = useState({ view: 'active', search: '' }); const ds = useDebounced(f.search.trim(), 300);
  const q = useQuery({ queryKey: ['bme-contracts', { ...f, search: ds }], queryFn: () => api<Contract[]>('/bme/contracts', { query: { view: f.view, search: ds } }), enabled: can(user, ...CT_VIEW) });
  const full = can(user, ...FULL);
  return (
    <div className="content">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <div className="seg" role="group" aria-label="ხედი">{CVIEWS.map(([k, l]) => <button key={k} type="button" aria-pressed={f.view === k} onClick={() => setF({ ...f, view: k })}>{l}</button>)}</div>
        <input className="input" style={{ maxWidth: 280, height: 38 }} aria-label="ძებნა" placeholder="№, დასახელება, მომწოდებელი" value={f.search} onChange={(e) => setF({ ...f, search: e.target.value })} />
        <span className="grow" />{full && <button className="btn primary" type="button" onClick={() => { sp.set('contract', 'new'); setSp(sp); }}>+ კონტრაქტი</button>}
      </div>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : <div className="card" style={{ overflowX: 'auto' }}><table className="table">
        <thead><tr><th>№</th><th>კონტრაქტი</th><th>სახე</th><th>პერიოდი</th><th className="num">აპარატები</th><th className="num">წელიწადში</th><th>SLA (P1)</th></tr></thead>
        <tbody>{(q.data ?? []).map((c) => <tr key={c.id} className="clickable" onClick={() => { sp.set('contract', c.id); setSp(sp); }}>
          <td className="mono small">{c.contract_no}</td><td><strong className="small">{c.title}</strong><div className="small muted">{c.supplier_name}</div></td><td className="small">{CT_KA[c.kind]}</td>
          <td className="small" style={{ whiteSpace: 'nowrap' }}>{dateGe(c.start_date)} – {dateGe(c.end_date)}<div>{c.status === 'cancelled' ? <span className="chip">გაუქმებული</span>
            : c.days_left < 0 ? <span className="chip danger">ვადაგასული</span> : c.days_left <= 90 ? <span className="chip warn">{c.days_left} დღე</span> : null}</div></td>
          <td className="num">{c.devices as number}</td><td className="num small">{c.annual_cost ? money(c.annual_cost) : '—'}</td>
          <td className="small">{c.response_hours ? `${c.response_hours[0]} / ${c.restore_hours?.[0] ?? '—'} სთ` : '—'}</td></tr>)}
          {!q.data?.length && <tr><td colSpan={7} className="muted">კონტრაქტი არ არის</td></tr>}</tbody></table></div>}
    </div>
  );
}

const hrs = (a: number[] | null) => (a ? a.join(', ') : '');
const parseHrs = (s: string) => { const a = s.split(/[,\s]+/).filter(Boolean).map(Number); return a.length === 4 && a.every((x) => Number.isInteger(x) && x > 0) ? a : null; };
export function ContractDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { user } = useAuth(); const qc = useQueryClient(); const toast = useToast(); const refs = useRefs(); const [sp, setSp] = useSearchParams();
  const isNew = id === 'new'; const full = can(user, ...FULL);
  const q = useQuery({ queryKey: ['bme-contract', id], queryFn: () => api<ContractFull>(`/bme/contracts/${id}`), enabled: !isNew });
  const c = q.data;
  const blank = { contract_no: '', title: '', supplier_id: '', kind: 'full_service', start_date: todayISO(), end_date: '', cost: '', cost_period: '', response_hours: '', restore_hours: '', uptime_pct: '', pm_visits_per_year: '', covers_kinds: [] as string[], covers_parts: false, contact: '', notes: '' };
  const [f, setF] = useState(blank);
  useEffect(() => { if (c) setF({ contract_no: c.contract_no, title: c.title, supplier_id: c.supplier_id, kind: c.kind, start_date: c.start_date, end_date: c.end_date, cost: c.cost ? String(Number(c.cost)) : '',
    cost_period: c.cost_period ?? '', response_hours: hrs(c.response_hours), restore_hours: hrs(c.restore_hours), uptime_pct: c.uptime_pct ? String(Number(c.uptime_pct)) : '',
    pm_visits_per_year: c.pm_visits_per_year != null ? String(c.pm_visits_per_year) : '', covers_kinds: c.covers_kinds, covers_parts: c.covers_parts, contact: c.contact ?? '', notes: c.notes ?? '' }); }, [c?.id, c?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  const body = () => ({ contract_no: f.contract_no.trim(), title: f.title.trim(), supplier_id: f.supplier_id, kind: f.kind, start_date: f.start_date, end_date: f.end_date,
    cost: f.cost.trim() ? Number(f.cost.replace(',', '.')) : null, cost_period: f.cost.trim() ? f.cost_period || null : null,
    response_hours: f.response_hours.trim() ? parseHrs(f.response_hours) : null, restore_hours: f.restore_hours.trim() ? parseHrs(f.restore_hours) : null,
    uptime_pct: f.uptime_pct.trim() ? Number(f.uptime_pct.replace(',', '.')) : null, pm_visits_per_year: f.pm_visits_per_year.trim() ? Number(f.pm_visits_per_year) : null,
    covers_kinds: f.covers_kinds, covers_parts: f.covers_parts, contact: nn(f.contact), notes: nn(f.notes) });
  const done = (x: ContractFull) => { qc.setQueryData(['bme-contract', x.id], x); void qc.invalidateQueries({ queryKey: ['bme-contracts'] }); void qc.invalidateQueries({ queryKey: ['bme-device-repairs'] }); };
  const save = useMutation({ mutationFn: () => (isNew ? api<ContractFull>('/bme/contracts', { body: body() }) : api<ContractFull>(`/bme/contracts/${id}`, { method: 'PATCH', body: body() })),
    onSuccess: (x) => { done(x); toast.show('შენახულია'); if (isNew) { sp.set('contract', x.id); setSp(sp, { replace: true }); } } });
  const cancel = useMutation({ mutationFn: (reason: string) => api<ContractFull>(`/bme/contracts/${id}/cancel`, { body: { reason } }), onSuccess: done });
  const [ds, setDs] = useState(''); const dds = useDebounced(ds.trim(), 300);
  const hits = useQuery({ queryKey: ['bme-devices', { search: dds, status: 'active' }], queryFn: () => api<DevHit[]>('/bme/devices', { query: { search: dds, status: 'active' } }), enabled: dds.length >= 2 && !isNew });
  const addDev = useMutation({ mutationFn: (dev: string) => api<ContractFull>(`/bme/contracts/${id}/devices`, { body: { device_ids: [dev] } }), onSuccess: (x) => { setDs(''); done(x); } });
  const rmDev = useMutation({ mutationFn: (dev: string) => api<ContractFull>(`/bme/contracts/${id}/devices/${dev}/remove`, { body: {} }), onSuccess: done });
  const [file, setFile] = useState<File | null>(null);
  const upload = useMutation({ mutationFn: () => { const fd = new FormData(); fd.append('file', file!); return apiUpload<ContractFull>(`/bme/contracts/${id}/files`, fd); }, onSuccess: (x) => { setFile(null); done(x); } });
  const editable = full && (isNew || c?.status === 'active');
  const hrsOk = (!f.response_hours.trim() || !!parseHrs(f.response_hours)) && (!f.restore_hours.trim() || !!parseHrs(f.restore_hours));
  const ok = f.contract_no.trim() && f.title.trim().length >= 2 && f.supplier_id && f.start_date && f.end_date && f.end_date >= f.start_date && hrsOk && (!f.cost.trim() || !!f.cost_period);
  return (
    <Modal title={isNew ? 'ახალი სერვისის კონტრაქტი' : c ? `კონტრაქტი ${c.contract_no}` : 'კონტრაქტი'} onClose={onClose} width={1000}
      footer={<>{!isNew && full && c?.status === 'active' && <button className="btn" type="button" onClick={() => { const r = prompt('გაუქმების მიზეზი'); if (r && r.trim().length >= 3) cancel.mutate(r.trim()); }}>გაუქმება</button>}
        <span className="grow" /><button className="btn" type="button" onClick={onClose}>დახურვა</button>
        {editable && <button className="btn primary" type="button" disabled={!ok || save.isPending} onClick={() => save.mutate()}>შენახვა</button>}</>}>
      {toast.node}
      {!isNew && !c ? (q.error ? <ErrorBox error={q.error} /> : <Loading />) : (
        <div className="stack">
          {c?.status === 'cancelled' && <div className="alert">გაუქმებულია: {c.cancel_reason}</div>}
          <fieldset disabled={!editable} style={{ border: 0, padding: 0, margin: 0 }}><div style={grid}>
            <Field label="№" htmlFor="kn" required><input id="kn" className="input mono" value={f.contract_no} onChange={(e) => setF({ ...f, contract_no: e.target.value })} /></Field>
            <div style={{ gridColumn: 'span 2' }}><Field label="დასახელება" htmlFor="kt" required><input id="kt" className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field></div>
            <Field label="მომწოდებელი" htmlFor="ks" required><select id="ks" className="select" value={f.supplier_id} onChange={(e) => setF({ ...f, supplier_id: e.target.value })}>
              <option value="">—</option>{refs.data?.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
            <Field label="სახე" htmlFor="kk"><select id="kk" className="select" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{Object.entries(CT_KA).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
            <Field label="დასაწყისი" htmlFor="ksd" required><input id="ksd" className="input mono" type="date" value={f.start_date} onChange={(e) => setF({ ...f, start_date: e.target.value })} /></Field>
            <Field label="დასასრული" htmlFor="ked" required><input id="ked" className="input mono" type="date" value={f.end_date} onChange={(e) => setF({ ...f, end_date: e.target.value })} /></Field>
            <Field label="ღირებულება (₾)" htmlFor="kc"><div className="row" style={{ gap: 6 }}><input id="kc" className="input mono" inputMode="decimal" value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value })} />
              <select className="select" aria-label="პერიოდულობა" value={f.cost_period} onChange={(e) => setF({ ...f, cost_period: e.target.value })}><option value="">—</option>{Object.entries(PERIOD_KA).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div></Field>
            <Field label="რეაგირება, სთ (P1, P2, P3, P4)" htmlFor="krh" hint="მაგ. 2, 6, 24, 48; ცარიელი — პარამეტრებიდან"><input id="krh" className="input mono" value={f.response_hours} onChange={(e) => setF({ ...f, response_hours: e.target.value })} /></Field>
            <Field label="აღდგენა, სთ (P1–P4)" htmlFor="krs" hint="მაგ. 8, 24, 72, 120"><input id="krs" className="input mono" value={f.restore_hours} onChange={(e) => setF({ ...f, restore_hours: e.target.value })} /></Field>
            <Field label="uptime %" htmlFor="ku"><input id="ku" className="input mono" inputMode="decimal" value={f.uptime_pct} onChange={(e) => setF({ ...f, uptime_pct: e.target.value })} /></Field>
            <Field label="PM ვიზიტები წელიწადში" htmlFor="kv"><input id="kv" className="input mono" type="number" min={0} max={52} value={f.pm_visits_per_year} onChange={(e) => setF({ ...f, pm_visits_per_year: e.target.value })} /></Field>
            <Field label="კონტაქტი" htmlFor="kco"><input id="kco" className="input" value={f.contact} onChange={(e) => setF({ ...f, contact: e.target.value })} /></Field>
          </div>
          <div className="row" style={{ gap: 12, flexWrap: 'wrap', margin: '8px 0 10px' }}><span className="small">ფარავს (გარე შემსრულებლის შეთავაზება):</span>
            {refs.data?.kinds.map((k) => <label key={k.id} className="row small"><input type="checkbox" checked={f.covers_kinds.includes(k.id)} onChange={(e) => setF({ ...f, covers_kinds: e.target.checked ? [...f.covers_kinds, k.id] : f.covers_kinds.filter((x) => x !== k.id) })} /> {k.short_name}</label>)}
            <label className="row small"><input type="checkbox" checked={f.covers_parts} onChange={(e) => setF({ ...f, covers_parts: e.target.checked })} /> ნაწილები</label></div>
          <Field label="შენიშვნა" htmlFor="kno"><input id="kno" className="input" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field></fieldset>
          {!hrsOk && <span className="hint">საათები — ზუსტად 4 მთელი რიცხვი, მძიმით.</span>}
          {c && <>
            <strong className="small">აპარატები ({c.devices.length})</strong>
            {editable && <div style={{ position: 'relative', maxWidth: 420 }}><input className="input" aria-label="აპარატის დამატება" placeholder="+ აპარატი (№, დასახელება)" value={ds} onChange={(e) => setDs(e.target.value)} />
              {(hits.data?.length ?? 0) > 0 && <ul className="listbox" role="listbox" aria-label="აპარატები" style={{ position: 'absolute', left: 0, right: 0, zIndex: 6 }}>
                {hits.data!.filter((h) => !c.devices.some((x) => x.id === h.id)).slice(0, 12).map((h) => <li key={h.id} role="option" aria-selected={false} onMouseDown={(e) => { e.preventDefault(); addDev.mutate(h.id); }}>
                  <span className="mono small">{h.inv_no}</span>&nbsp;<span className="grow">{h.name}</span></li>)}</ul>}</div>}
            <table className="table"><tbody>{c.devices.map((d) => <tr key={d.id}><td className="mono small">{d.inv_no}</td><td className="small">{d.name}<div className="muted">{d.type_name}{d.serial_no ? ` · SN ${d.serial_no}` : ''}</div></td>
              <td className="small">{d.department_name ?? ''}</td><td className="small">{DEV_ST_KA[d.status] ?? d.status}</td>
              <td className="num">{editable && <button className="btn sm" type="button" onClick={() => { if (confirm(`ამოვიღოთ ${d.inv_no}?`)) rmDev.mutate(d.id); }}>ამოღება</button>}</td></tr>)}</tbody></table>
            <strong className="small">ფაილები</strong>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>{c.files.map((x) => <button key={x.id} className="btn sm" type="button" onClick={() => void openBlob(`/bme/contracts/${c.id}/files/${x.id}`)}>{x.title}</button>)}
              {editable && <><input type="file" aria-label="კონტრაქტის ფაილი" accept="application/pdf,image/jpeg,image/png" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                <button className="btn sm" type="button" disabled={!file || upload.isPending} onClick={() => upload.mutate()}>ატვირთვა</button></>}</div>
            {c.repairs.length > 0 && <><strong className="small">ორდერები კონტრაქტით (SLA)</strong>
              <table className="table"><tbody>{c.repairs.map((r) => <tr key={r.id} className="clickable" onClick={() => { sp.delete('contract'); sp.set('repair', r.id); setSp(sp); }}>
                <td className="mono small">{r.repair_no}</td><td className="small">{r.inv_no} {r.device_name}</td><td><PriorityChip p={r.priority} /></td><td><RepStatusChip s={r.status} /></td>
                <td className="small">რეაგ.: {r.response_ok === null ? '—' : r.response_ok ? '✓' : '✗'} · აღდგ.: {r.restore_ok === null ? '—' : r.restore_ok ? '✓' : '✗'}</td></tr>)}</tbody></table></>}
          </>}
          <ErrorBox error={save.error ?? cancel.error ?? addDev.error ?? rmDev.error ?? upload.error} />
        </div>)}
    </Modal>
  );
}
