import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../api/client';
import type { Doctor } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Field, Loading, Modal, useDebounced, useToast } from '../../components/ui';
import { localISO, todayISO, tsDate } from '../../lib/format';
import Verification from '../stock/Verification';
import { DOSE_RATE_UNITS, doseToMlH, UNIT_KA as RATE_KA } from './Icu';

// ---------------------------------------------------------------- ტიპები
export interface OrderCheck { code: string; level: 'info' | 'warn' | 'reason' | 'block'; message: string; severe?: boolean }
export interface Order {
  id: string; encounter_id: string; category: Category; generic_id: string | null; drug_text: string | null; order_type: OType | null;
  dose: string | null; dose_unit: string | null; dose_per_kg: string | null; weight_kg: string | null; route_code: string | null; route_name: string | null;
  frequency_code: string | null; frequency_name: string | null; prn_reason: string | null; prn_max_per_day: number | null; prn_min_interval_h: string | null;
  diluent: string | null; volume_ml: string | null; rate_ml_h: string | null; duration_min: number | null; text: string | null; instructions: string | null;
  start_at: string; duration_days: number | null; end_at: string | null; status: 'active' | 'on_hold' | 'stopped' | 'completed'; hold_reason: string | null;
  stopped_at: string | null; stop_reason: string | null; replaces_id: string | null; ordered_by: string; ordered_by_name: string; entered_by_name: string;
  is_verbal: boolean; verbal_confirmed_at: string | null; checks: OrderCheck[]; override_reason: string | null;
  verify_status: 'not_required' | 'pending' | 'verified' | 'rejected'; verify_note: string | null; verified_by_name: string | null;
  approval_status: 'not_required' | 'pending' | 'approved' | 'rejected'; approval_note: string | null; approved_by_name: string | null;
  supply_mode: 'ward' | 'pharmacy' | null; req_no: string | null; request_status: string | null; stock_request_id: string | null;
  title: string; inn: string | null; strength: string | null; high_alert: boolean | null; controlled_class: string | null; reserve_antibiotic: boolean | null; created_at: string;
  // 0047: ტიტრაცია
  titratable?: boolean; dose_rate?: string | null; dose_rate_unit?: string | null; conc_amount?: string | null; conc_unit?: string | null; conc_volume_ml?: string | null;
  titrate_min?: string | null; titrate_max?: string | null; titrate_goal?: string | null;
  // განყოფილების / ვერიფიკაციის სიებში
  adm_no?: string; first_name?: string; last_name?: string; bed_code?: string | null; department_name?: string | null; allergies?: number;
}
interface OrdersResp {
  orders: Order[]; weight: { kg: number; at: string } | null; age_days: number;
  settings: { antibiotic_default_days: number; verbal_orders: boolean; med_verification: string };
  can: { order: boolean; verbal: boolean; approve: boolean };
}
type Category = 'medication' | 'diet' | 'nursing' | 'activity';
type OType = 'scheduled' | 'once' | 'prn' | 'continuous';
interface GenericRow { id: string; inn: string; inn_latin: string | null; strength: string | null; form_name: string; atc_code: string | null; dose_unit: string | null; routes: string[];
  high_alert: boolean; controlled_class: string | null; reserve_antibiotic: boolean; patient_only: boolean; is_active: boolean }
interface Frequency { code: string; name: string; times_of_day: string[] | null; interval_hours: number | null; per_day: string; is_active: boolean; sort_order: number }
interface OrderSet { id: string; name: string; department_id: string | null; owner_id: string | null; items: Partial<OrderBody>[]; department_name: string | null }
export type OrderBody = {
  category: Category; generic_id?: string; drug_text?: string; order_type?: OType; dose?: number; dose_unit?: string; dose_per_kg?: number; weight_kg?: number;
  route_code?: string; frequency_code?: string; prn_reason?: string; prn_max_per_day?: number; prn_min_interval_h?: number; diluent?: string; volume_ml?: number;
  rate_ml_h?: number; duration_min?: number; text?: string; instructions?: string; start_at?: string; duration_days?: number; supply_mode?: 'ward' | 'pharmacy';
  titratable?: boolean; dose_rate?: number; dose_rate_unit?: string; conc_amount?: number; conc_unit?: string; conc_volume_ml?: number; titrate_min?: number; titrate_max?: number; titrate_goal?: string;
  verbal_doctor_id?: string; set_id?: string; nursing_task?: 'vitals' | 'fluid' | 'scale' | 'other'; task_scale_code?: string; ack?: boolean; override_reason?: string; confirm_severe?: boolean; reason?: string;
};

export const CATEGORY_KA: Record<Category, string> = { medication: 'მედიკამენტი', diet: 'კვება / დიეტა', nursing: 'მოვლა / პროცედურა', activity: 'რეჟიმი' };
const TYPE_KA: Record<OType, string> = { scheduled: 'გეგმიური', once: 'ერთჯერადი', prn: 'საჭიროებისამებრ (PRN)', continuous: 'უწყვეტი ინფუზია' };
const STATUS: Record<Order['status'], [string, string]> = { active: ['ok', 'აქტიური'], on_hold: ['warn', 'შეჩერებული'], stopped: ['', 'შეწყვეტილი'], completed: ['', 'დასრულებული'] };
const UNIT_KA: Record<string, string> = { mg: 'მგ', mcg: 'მკგ', g: 'გ', IU: 'სე', ml: 'მლ', mmol: 'მმოლ', mEq: 'mEq', tab: 'ტაბ.', cap: 'კაფს.', amp: 'ამპ.', vial: 'ფლაკ.', drop: 'წვეთი', puff: 'შესხურება', sachet: 'პაკ.', supp: 'სუპ.', appl: 'აპლიკაცია' };
const LEVEL: Record<OrderCheck['level'], string> = { info: 'info', warn: 'warn', reason: 'danger', block: 'danger' };
const num = (v: string | number | null | undefined) => (v === null || v === undefined || v === '' ? null : Number(v));
const fmt = (v: string | number | null | undefined) => { const n = num(v); return n === null ? '' : String(Math.round(n * 1000) / 1000); };
const dt = (iso: string) => `${tsDate(iso)} ${new Date(iso).toLocaleTimeString('ka-GE', { timeZone: 'Asia/Tbilisi', hour: '2-digit', minute: '2-digit', hour12: false })}`;

/** დანიშნულების მოკლე აღწერა: დოზა · გზა · სიხშირე · ხანგრძლივობა */
export function orderSummary(o: Order) {
  if (o.category !== 'medication') return [o.frequency_name, o.duration_days ? `${o.duration_days} დღე` : null].filter(Boolean).join(' · ');
  const u = UNIT_KA[o.dose_unit ?? ''] ?? o.dose_unit ?? '';
  const dose = o.dose ? `${fmt(o.dose)} ${u}${o.dose_per_kg ? ` (${fmt(o.dose_per_kg)} ${u}/კგ × ${fmt(o.weight_kg)} კგ)` : ''}` : null;
  const how = o.order_type === 'scheduled' ? o.frequency_name : o.order_type === 'once' ? 'ერთჯერადად'
    : o.order_type === 'prn' ? `საჭიროებისამებრ: ${o.prn_reason}${o.prn_max_per_day ? ` (მაქს. ${o.prn_max_per_day}/დღე)` : ''}${o.prn_min_interval_h ? `, ინტერვალი ≥ ${fmt(o.prn_min_interval_h)} სთ` : ''}`
    : o.dose_rate ? `${fmt(o.dose_rate)} ${RATE_KA[o.dose_rate_unit ?? ''] ?? o.dose_rate_unit} (≈ ${fmt(o.rate_ml_h)} მლ/სთ; ${fmt(o.conc_amount)} ${RATE_KA[o.conc_unit ?? ''] ?? ''}/${fmt(o.conc_volume_ml)} მლ${o.weight_kg ? `, ${fmt(o.weight_kg)} კგ` : ''})${o.titratable ? ` · ტიტრაცია ${fmt(o.titrate_min) || '…'}–${fmt(o.titrate_max) || '…'}${o.titrate_goal ? `, ${o.titrate_goal}` : ''}` : ''}`
    : `${fmt(o.rate_ml_h)} მლ/სთ`;
  const inf = [o.diluent, o.volume_ml ? `${fmt(o.volume_ml)} მლ` : null, o.duration_min ? `${o.duration_min} წთ` : null].filter(Boolean).join(', ');
  return [dose, o.route_name ?? o.route_code, how, inf || null, o.duration_days ? `${o.duration_days} დღე` : o.order_type === 'once' ? null : 'გაუქმებამდე'].filter(Boolean).join(' · ');
}
export function OrderBadges({ o }: { o: Order }) {
  return <>
    {o.high_alert && <span className="chip danger" title="მაღალი რისკის მედიკამენტი">მაღ. რისკი</span>}
    {o.controlled_class && <span className="chip danger">კონტროლირებადი</span>}
    {o.verify_status === 'pending' && <span className="chip warn" title="დადასტურების მოლოდინში (მთავარი ექთანი / ფარმაცევტი)">დასადასტურებელი</span>}
    {o.verify_status === 'verified' && o.verify_note && <span className="chip info" title={o.verify_note}>შენიშვნა</span>}
    {o.verify_status === 'rejected' && <span className="chip danger" title={o.verify_note ?? ''}>უარყოფილია</span>}
    {o.approval_status === 'pending' && <span className="chip warn" title="სარეზერვო ანტიბიოტიკი — დამტკიცების მოლოდინში">დასამტკიცებელი</span>}
    {o.approval_status === 'approved' && <span className="chip ok" title={o.approval_note ?? ''}>დამტკიცებული</span>}
    {o.is_verbal && !o.verbal_confirmed_at && <span className="chip warn" title="ზეპირი დანიშნულება — ექიმის დადასტურების მოლოდინში">ზეპირი</span>}
    {o.supply_mode === 'pharmacy' && <span className="chip" title={o.req_no ? `მოთხოვნა ${o.req_no}` : 'აფთიაქიდან პაციენტზე'}>აფთიაქიდან{o.req_no ? ` · ${o.req_no}` : ''}</span>}
    {o.checks?.some((c) => c.level !== 'info') && <span className="chip" title={o.checks.filter((c) => c.level !== 'info').map((c) => c.message).join('\n') + (o.override_reason ? `\n\nმიზეზი: ${o.override_reason}` : '')}>⚠ {o.checks.filter((c) => c.level !== 'info').length}</span>}
  </>;
}

/** სარეზერვო ანტიბიოტიკი / ვერიფიკაცია — დასადასტურებელი ბლოკი */
function useInvalidate(encounterId?: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['ipd-orders'] }); void qc.invalidateQueries({ queryKey: ['ipd-dep-orders'] });
    void qc.invalidateQueries({ queryKey: ['pharm-verify'] }); if (encounterId) void qc.invalidateQueries({ queryKey: ['ipd-stay', encounterId] });
  };
}

// ================================================================= პანელი (ჰოსპიტალიზაციის გვერდი)
export default function OrdersPanel({ encounterId, departmentId }: { encounterId: string; departmentId: string }) {
  const { user } = useAuth(); const toast = useToast(); const inval = useInvalidate(encounterId);
  const q = useQuery({ queryKey: ['ipd-orders', encounterId], queryFn: () => api<OrdersResp>(`/inpatient/stays/${encounterId}/orders`) });
  const [all, setAll] = useState(false);
  const [dlg, setDlg] = useState<null | { mode: 'new' | 'verbal' | 'modify'; initial?: Partial<OrderBody>; replaces?: Order; setId?: string }>(null);
  const [sets, setSets] = useState(false);
  const [detail, setDetail] = useState<Order | null>(null);
  const [reasonFor, setReasonFor] = useState<null | { o: Order; action: 'hold' | 'stop' | 'approve-reject' }>(null);
  const act = useMutation({ mutationFn: (a: { path: string; body?: unknown; msg: string }) => api(a.path, { body: a.body ?? {} }).then(() => a.msg),
    onSuccess: (m) => { toast.show(m); inval(); } });
  useEffect(() => { if (new URLSearchParams(window.location.search).get('tab') === 'orders') document.getElementById('orders')?.scrollIntoView({ behavior: 'smooth' }); }, [q.isSuccess]);
  if (q.isLoading) return <section className="card card-pad" id="orders"><Loading /></section>;
  if (!q.data) return <section className="card card-pad" id="orders"><ErrorBox error={q.error} /></section>;
  const d = q.data;
  const rows = d.orders.filter((o) => all || o.status === 'active' || o.status === 'on_hold');
  const groups = (['medication', 'diet', 'nursing', 'activity'] as Category[]).map((c) => [c, rows.filter((o) => o.category === c)] as const).filter(([, xs]) => xs.length);
  const pendingVerbal = d.orders.filter((o) => o.is_verbal && !o.verbal_confirmed_at && o.ordered_by === user?.id && (o.status === 'active' || o.status === 'on_hold'));
  return (
    <section className="card" id="orders">
      {toast.node}
      <div className="card-head" style={{ flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0 }}>დანიშნულებები</h2>
        <span className="small muted">{d.weight ? `წონა ${fmt(d.weight.kg)} კგ (${tsDate(d.weight.at)})` : 'წონა არ არის'}</span>
        <span className="grow" />
        <label className="row small"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> შეწყვეტილიც</label>
        {d.can.order && <button className="btn sm" type="button" onClick={() => setSets(true)}>შაბლონები</button>}
        {d.can.verbal && <button className="btn sm" type="button" onClick={() => setDlg({ mode: 'verbal' })}>ზეპირი დანიშნულება</button>}
        {d.can.order && <button className="btn sm primary" type="button" onClick={() => setDlg({ mode: 'new' })}>+ დანიშნულება</button>}
      </div>
      <div className="card-pad stack" style={{ gap: 10 }}>
        <ErrorBox error={act.error} />
        {pendingVerbal.length > 0 && <div className="alert warn">ზეპირი დანიშნულება თქვენი სახელით — დაადასტურეთ: {pendingVerbal.map((o) => <button key={o.id} className="btn sm" type="button" style={{ marginLeft: 6 }}
          onClick={() => act.mutate({ path: `/inpatient/orders/${o.id}/confirm`, msg: 'დადასტურდა' })}>{o.title} ✓</button>)}</div>}
        {!rows.length && <span className="muted">{all ? 'დანიშნულება არ არის.' : 'აქტიური დანიშნულება არ არის.'}</span>}
        {groups.map(([c, xs]) => (
          <div key={c} className="stack" style={{ gap: 4 }}>
            <span className="label">{CATEGORY_KA[c]}</span>
            <table className="table"><tbody>{xs.map((o) => (
              <tr key={o.id} style={{ opacity: o.status === 'stopped' || o.status === 'completed' ? 0.55 : 1 }}>
                <td style={{ width: '45%' }}>
                  <button type="button" className="linklike" style={{ background: 'none', border: 0, padding: 0, textAlign: 'left', cursor: 'pointer', font: 'inherit' }} onClick={() => setDetail(o)}>
                    <strong>{o.title}</strong></button>
                  <div className="small">{orderSummary(o)}</div>
                  {o.instructions && <div className="small muted">{o.instructions}</div>}
                  {o.hold_reason && o.status === 'on_hold' && <div className="small" style={{ color: 'var(--warn-ink)' }}>შეჩერებულია: {o.hold_reason}</div>}
                  {o.stop_reason && <div className="small muted">{o.stop_reason}</div>}
                </td>
                <td><div className="row" style={{ gap: 4, flexWrap: 'wrap' }}><span className={`chip ${STATUS[o.status][0]}`}>{STATUS[o.status][1]}</span><OrderBadges o={o} /></div></td>
                <td className="small">{dt(o.start_at)}{o.end_at && <div className="muted">→ {dt(o.end_at)}</div>}<div className="muted">{o.ordered_by_name}{o.is_verbal ? ` (ზეპ., ${o.entered_by_name})` : ''}</div></td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {d.can.approve && o.approval_status === 'pending' && o.ordered_by !== user?.id && (o.status === 'active' || o.status === 'on_hold') && <>
                    <button className="btn sm primary" type="button" onClick={() => act.mutate({ path: `/inpatient/orders/${o.id}/approve`, msg: 'დამტკიცდა' })}>დამტკიცება</button>{' '}
                    <button className="btn sm" type="button" onClick={() => setReasonFor({ o, action: 'approve-reject' })}>უარი</button>{' '}</>}
                  {d.can.order && (o.status === 'active' || o.status === 'on_hold') && <>
                    <button className="btn sm" type="button" onClick={() => setDlg({ mode: 'modify', replaces: o, initial: fromOrder(o) })}>შეცვლა</button>{' '}
                    {o.status === 'active' ? <button className="btn sm" type="button" onClick={() => setReasonFor({ o, action: 'hold' })}>შეჩერება</button>
                      : <button className="btn sm" type="button" onClick={() => act.mutate({ path: `/inpatient/orders/${o.id}/resume`, msg: 'განახლდა' })}>განახლება</button>}{' '}
                    <button className="btn sm danger" type="button" onClick={() => setReasonFor({ o, action: 'stop' })}>შეწყვეტა</button></>}
                </td>
              </tr>))}</tbody></table>
          </div>))}
      </div>
      {dlg && <OrderDialog encounterId={encounterId} mode={dlg.mode} initial={dlg.initial} replaces={dlg.replaces} setId={dlg.setId} ctx={d} onClose={() => setDlg(null)} onDone={(m) => { toast.show(m); inval(); }} />}
      {sets && <SetsDialog departmentId={departmentId} active={d.orders.filter((o) => o.status === 'active' || o.status === 'on_hold')} onClose={() => setSets(false)}
        onPick={(it, setId) => { setSets(false); setDlg({ mode: 'new', initial: it, setId }); }} />}
      {detail && <OrderDetail id={detail.id} onClose={() => setDetail(null)} />}
      {reasonFor && <ReasonModal title={{ hold: 'შეჩერება', stop: 'შეწყვეტა', 'approve-reject': 'სარეზერვო ანტიბიოტიკი — უარი' }[reasonFor.action] + ` — ${reasonFor.o.title}`}
        onClose={() => setReasonFor(null)} onSubmit={(r) => act.mutateAsync({ path: `/inpatient/orders/${reasonFor.o.id}/${reasonFor.action}`,
          body: reasonFor.action === 'approve-reject' ? { note: r } : { reason: r }, msg: 'შესრულდა' }).then(() => setReasonFor(null))} />}
    </section>
  );
}

/** არსებული დანიშნულება → ფორმის საწყისი მნიშვნელობები (შეცვლა / შაბლონი) */
function fromOrder(o: Order): Partial<OrderBody> {
  const n = (v: string | null) => (v === null ? undefined : Number(v));
  return {
    category: o.category, generic_id: o.generic_id ?? undefined, drug_text: o.drug_text ?? undefined, order_type: o.order_type ?? undefined,
    dose: o.dose_per_kg ? undefined : n(o.dose), dose_per_kg: n(o.dose_per_kg), dose_unit: o.dose_unit ?? undefined, route_code: o.route_code ?? undefined,
    frequency_code: o.frequency_code ?? undefined, prn_reason: o.prn_reason ?? undefined, prn_max_per_day: o.prn_max_per_day ?? undefined, prn_min_interval_h: n(o.prn_min_interval_h),
    diluent: o.diluent ?? undefined, volume_ml: n(o.volume_ml), rate_ml_h: n(o.rate_ml_h), duration_min: o.duration_min ?? undefined, text: o.text ?? undefined,
    instructions: o.instructions ?? undefined, duration_days: o.duration_days ?? undefined, supply_mode: o.supply_mode ?? undefined,
    ...(o.dose_rate && { titratable: !!o.titratable, dose_rate: n(o.dose_rate), dose_rate_unit: o.dose_rate_unit ?? undefined, conc_amount: n(o.conc_amount ?? null), conc_unit: o.conc_unit ?? undefined,
      conc_volume_ml: n(o.conc_volume_ml ?? null), titrate_min: n(o.titrate_min ?? null), titrate_max: n(o.titrate_max ?? null), titrate_goal: o.titrate_goal ?? undefined, rate_ml_h: undefined }),
  };
}

function ReasonModal({ title, onClose, onSubmit }: { title: string; onClose: () => void; onSubmit: (r: string) => Promise<unknown> }) {
  const [r, setR] = useState(''); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onClose} width={480}
      footer={<><button className="btn" type="button" onClick={onClose}>დახურვა</button><button className="btn primary" type="button" disabled={busy || r.trim().length < 3}
        onClick={() => { setBusy(true); onSubmit(r.trim()).catch(setErr).finally(() => setBusy(false)); }}>დადასტურება</button></>}>
      <Field label="მიზეზი" htmlFor="or-r" required><input id="or-r" className="input" value={r} onChange={(e) => setR(e.target.value)} /></Field>
      <ErrorBox error={err} />
    </Modal>
  );
}

// ================================================================= ახალი / შეცვლა / ზეპირი
function OrderDialog({ encounterId, mode, initial, replaces, setId, ctx, onClose, onDone }: {
  encounterId: string; mode: 'new' | 'verbal' | 'modify'; initial?: Partial<OrderBody>; replaces?: Order; setId?: string; ctx: OrdersResp; onClose: () => void; onDone: (m: string) => void;
}) {
  const refs = useQuery({ queryKey: ['stock-refs'], queryFn: () => api<{ routes: { code: string; name: string; is_active: boolean }[] }>('/stock/refs'), staleTime: 300_000 });
  const freqs = useQuery({ queryKey: ['med-freqs'], queryFn: () => api<Frequency[]>('/inpatient/orders/frequencies'), staleTime: 300_000 });
  const doctors = useQuery({ queryKey: ['doctors'], queryFn: () => api<Doctor[]>('/doctors'), enabled: mode === 'verbal' });
  const [f, setF] = useState<OrderBody>(() => ({ category: 'medication', order_type: 'scheduled', ...initial }));
  const scales = useQuery({ queryKey: ['nursing-scales'], queryFn: () => api<{ code: string; name: string }[]>('/inpatient/nursing/scales'), staleTime: 300_000 });
  const [free, setFree] = useState(!!initial?.drug_text);
  const [perKg, setPerKg] = useState(!!initial?.dose_per_kg);
  const [titr, setTitr] = useState(!!initial?.dose_rate);   // 0047: დოზა სიჩქარით (ვაზოპრესორი / ტიტრაცია)
  const [gen, setGen] = useState<GenericRow | null>(null);
  const [search, setSearch] = useState('');
  const ds = useDebounced(search.trim(), 250);
  const found = useQuery({ queryKey: ['generics-search', ds], queryFn: () => api<GenericRow[]>('/pharmacy/generics', { query: { search: ds } }), enabled: ds.length >= 2 && !gen });
  const genInit = useQuery({ queryKey: ['generic', initial?.generic_id], queryFn: () => api<GenericRow>(`/pharmacy/generics/${initial!.generic_id}`), enabled: !!initial?.generic_id });
  useEffect(() => { if (genInit.data && !gen) setGen(genInit.data); }, [genInit.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const [date, setDate] = useState(todayISO()); const [time, setTime] = useState(() => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tbilisi', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()));
  const [reason, setReason] = useState('');
  const [checks, setChecks] = useState<null | { checks: OrderCheck[]; requires: { ack: boolean; reason: boolean; severe: boolean } }>(null);
  const [ack, setAck] = useState(false); const [ovr, setOvr] = useState(''); const [severe, setSevere] = useState(false);
  const set = <K extends keyof OrderBody>(k: K, v: OrderBody[K]) => { setF((x) => ({ ...x, [k]: v })); setChecks(null); };
  const pickGen = (g: GenericRow) => {
    setGen(g); setSearch('');
    setF((x) => ({ ...x, generic_id: g.id, dose_unit: g.dose_unit ?? x.dose_unit, route_code: g.routes[0] ?? x.route_code,
      duration_days: x.duration_days ?? (g.atc_code?.startsWith('J01') ? ctx.settings.antibiotic_default_days : undefined) }));
    setChecks(null);
  };
  const med = f.category === 'medication';
  const child = ctx.age_days < 18 * 365;
  const routes = useMemo(() => {
    const all = (refs.data?.routes ?? []).filter((r) => r.is_active);
    return gen?.routes.length ? [...all.filter((r) => gen.routes.includes(r.code)), ...all.filter((r) => !gen.routes.includes(r.code))] : all;
  }, [refs.data, gen]);
  const body = (): OrderBody => {
    const b: OrderBody = { ...f, start_at: localISO(date, time), set_id: setId };
    if (!med) return { category: f.category, text: f.text, frequency_code: f.frequency_code || undefined, duration_days: f.duration_days, instructions: f.instructions, start_at: b.start_at, set_id: setId,
      ...(mode === 'verbal' && { verbal_doctor_id: f.verbal_doctor_id }),
      ...(f.category === 'nursing' && f.nursing_task && f.nursing_task !== 'other' && { nursing_task: f.nursing_task, ...(f.nursing_task === 'scale' && { task_scale_code: f.task_scale_code }) }) };
    delete b.nursing_task; delete b.task_scale_code;
    if (free) { delete b.generic_id; } else { delete b.drug_text; b.generic_id = gen?.id; }
    if (perKg) delete b.dose; else delete b.dose_per_kg;
    if (b.order_type !== 'scheduled') delete b.frequency_code;
    if (b.order_type !== 'prn') { delete b.prn_reason; delete b.prn_max_per_day; delete b.prn_min_interval_h; }
    if (b.order_type === 'continuous') { delete b.dose; delete b.dose_per_kg; } else delete b.rate_ml_h;
    if (b.order_type === 'continuous' && titr) delete b.rate_ml_h;
    else { delete b.titratable; delete b.dose_rate; delete b.dose_rate_unit; delete b.conc_amount; delete b.conc_unit; delete b.conc_volume_ml; delete b.titrate_min; delete b.titrate_max; delete b.titrate_goal; }
    if (mode !== 'verbal') delete b.verbal_doctor_id;
    for (const k of Object.keys(b) as (keyof OrderBody)[]) if (b[k] === '' || b[k] === undefined || (typeof b[k] === 'number' && Number.isNaN(b[k]))) delete b[k];
    return b;
  };
  const m = useMutation({
    mutationFn: () => {
      const b: OrderBody = { ...body(), ...(checks && { ack: ack || undefined, override_reason: ovr.trim() || undefined, confirm_severe: severe || undefined }) };
      return mode === 'modify' ? api(`/inpatient/orders/${replaces!.id}/modify`, { body: { ...b, reason } }) : api(`/inpatient/stays/${encounterId}/orders`, { body: b });
    },
    onSuccess: () => { onDone(mode === 'modify' ? 'დანიშნულება შეიცვალა' : 'დანიშნულება შეიქმნა'); onClose(); },
    onError: (e) => { if (e instanceof ApiError && e.code === 'ORDER_CHECKS') setChecks({ checks: e.body?.checks as OrderCheck[], requires: e.body?.requires as { ack: boolean; reason: boolean; severe: boolean } }); },
  });
  const checksOk = !checks || ((!checks.requires.ack || ack || ovr.trim().length >= 5) && (!checks.requires.reason || ovr.trim().length >= 5) && (!checks.requires.severe || severe));
  const rateKg = titr && !!f.dose_rate_unit?.includes('/kg/');
  const calcMl = titr && f.dose_rate && f.dose_rate_unit && f.conc_amount && f.conc_unit && f.conc_volume_ml
    ? doseToMlH(f.dose_rate, f.dose_rate_unit, { amount: f.conc_amount, unit: f.conc_unit, volume_ml: f.conc_volume_ml }, f.weight_kg ?? ctx.weight?.kg ?? null) : null;
  const doseOk = f.order_type === 'continuous' ? (titr ? !!(f.dose_rate && f.dose_rate_unit && f.conc_amount && f.conc_unit && f.conc_volume_ml) : !!f.rate_ml_h) : !!(perKg ? f.dose_per_kg : f.dose) && !!f.dose_unit;
  const typeOk = f.order_type === 'scheduled' ? !!f.frequency_code : f.order_type === 'prn' ? (f.prn_reason?.trim().length ?? 0) >= 2 : true;
  const ready = (med ? ((free ? (f.drug_text?.trim().length ?? 0) >= 2 : !!gen) && !!f.route_code && !!f.order_type && doseOk && typeOk)
    : (f.text?.trim().length ?? 0) >= 2 && (f.category !== 'nursing' || f.nursing_task !== 'scale' || !!f.task_scale_code))
    && (mode !== 'verbal' || !!f.verbal_doctor_id) && (mode !== 'modify' || reason.trim().length >= 3) && checksOk;
  const errShown = m.error instanceof ApiError && m.error.code === 'ORDER_CHECKS' ? null : m.error;

  return (
    <Modal title={mode === 'modify' ? `დანიშნულების შეცვლა — ${replaces!.title}` : mode === 'verbal' ? 'ზეპირი / სატელეფონო დანიშნულება' : 'ახალი დანიშნულება'} onClose={onClose} width={760}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button>
        <button className="btn primary" type="button" disabled={!ready || m.isPending} onClick={() => m.mutate()}>{checks ? 'დადასტურება და შენახვა' : 'შენახვა'}</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        {mode === 'verbal' && <div className="row" style={{ gap: 12, alignItems: 'flex-end' }}>
          <Field label="ექიმი (ვისი სიტყვით)" htmlFor="od-vd" required><select id="od-vd" className="select" value={f.verbal_doctor_id ?? ''} onChange={(e) => set('verbal_doctor_id', e.target.value)}>
            <option value="">— აირჩიეთ —</option>{doctors.data?.map((x) => <option key={x.id} value={x.id}>{x.last_name} {x.first_name}{x.department_name ? ` · ${x.department_name}` : ''}</option>)}</select></Field>
          <span className="small muted">ექიმი მიიღებს შეტყობინებას და უნდა დაადასტუროს.</span></div>}
        {mode !== 'modify' && <div className="seg" role="group" aria-label="კატეგორია" style={{ width: 'max-content', flexWrap: 'wrap' }}>
          {(Object.keys(CATEGORY_KA) as Category[]).map((c) => <button key={c} type="button" aria-pressed={f.category === c} onClick={() => set('category', c)}>{CATEGORY_KA[c]}</button>)}</div>}

        {!med ? <>
          <Field label="დანიშნულება" htmlFor="od-t" required><textarea id="od-t" className="textarea" rows={3} value={f.text ?? ''} onChange={(e) => set('text', e.target.value)}
            placeholder={f.category === 'diet' ? 'მაგ. დიეტა №10, მარილის შეზღუდვა' : f.category === 'activity' ? 'მაგ. წოლითი რეჟიმი' : 'მაგ. ჭრილობის დამუშავება და გადახვევა'} /></Field>
          <div className="row" style={{ gap: 12 }}>
            <Field label="სიხშირე" htmlFor="od-tf"><select id="od-tf" className="select" value={f.frequency_code ?? ''} onChange={(e) => set('frequency_code', e.target.value || undefined)}>
              <option value="">—</option>{freqs.data?.map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}</select></Field>
            <Field label="ხანგრძლივობა (დღე)" htmlFor="od-td"><input id="od-td" className="input" type="number" min={1} max={365} value={f.duration_days ?? ''} onChange={(e) => set('duration_days', e.target.value ? Number(e.target.value) : undefined)} /></Field>
          </div>
          {f.category === 'nursing' && <div className="row" style={{ gap: 12 }}>
            <Field label="დავალების ტიპი" htmlFor="od-nt" hint="MAR-ში ჩაწერა გახსნის შესაბამის ფორმას"><select id="od-nt" className="select" value={f.nursing_task ?? 'other'}
              onChange={(e) => setF((x) => ({ ...x, nursing_task: e.target.value as OrderBody['nursing_task'], task_scale_code: e.target.value === 'scale' ? x.task_scale_code : undefined }))}>
              <option value="other">სხვა (შესრულდა / არა)</option><option value="vitals">ვიტალური ნიშნები</option><option value="fluid">სითხის ბალანსი</option><option value="scale">შკალით შეფასება</option></select></Field>
            {f.nursing_task === 'scale' && <Field label="შკალა" htmlFor="od-sc" required><select id="od-sc" className="select" value={f.task_scale_code ?? ''} onChange={(e) => set('task_scale_code', e.target.value || undefined)}>
              <option value="">—</option>{scales.data?.map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}</select></Field>}
          </div>}
        </> : <>
          {/* მედიკამენტი */}
          <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
            <div className="grow stack" style={{ gap: 6, position: 'relative' }}>
              <span className="label">მედიკამენტი (ჯენერიკი)</span>
              {free ? <input className="input" aria-label="მედიკამენტი ტექსტით" value={f.drug_text ?? ''} onChange={(e) => set('drug_text', e.target.value)} placeholder="დასახელება, ფორმა, დოზა" />
                : gen ? <div className="row" style={{ gap: 8 }}><strong>{gen.inn}{gen.strength ? ` ${gen.strength}` : ''}</strong><span className="small muted">{gen.form_name}{gen.atc_code ? ` · ${gen.atc_code}` : ''}</span>
                    {gen.high_alert && <span className="chip danger">მაღ. რისკი</span>}{gen.reserve_antibiotic && <span className="chip warn">სარეზერვო</span>}
                    {mode !== 'modify' && <button className="btn sm" type="button" onClick={() => { setGen(null); set('generic_id', undefined); }}>შეცვლა</button>}</div>
                : <>
                  <input id="od-g" className="input" aria-label="ჯენერიკის ძებნა" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="INN, ლათინური ან ATC (მინ. 2 სიმბოლო)" />
                  {ds.length >= 2 && <div className="card" style={{ position: 'absolute', top: 64, left: 0, right: 0, zIndex: 5, maxHeight: 260, overflow: 'auto' }}>
                    {(found.data ?? []).slice(0, 30).map((g) => <button key={g.id} type="button" className="row" onClick={() => pickGen(g)}
                      style={{ width: '100%', textAlign: 'left', padding: '6px 10px', border: 0, background: 'transparent', cursor: 'pointer', gap: 8 }}>
                      <strong>{g.inn}</strong><span className="small">{g.strength}</span><span className="small muted grow">{g.form_name}</span>{g.atc_code && <span className="small mono">{g.atc_code}</span>}</button>)}
                    {found.data && !found.data.length && <div className="small muted" style={{ padding: 10 }}>ვერ მოიძებნა</div>}
                  </div>}
                </>}
            </div>
            {mode !== 'modify' && <label className="row small" style={{ marginTop: 34, whiteSpace: 'nowrap', flexShrink: 0 }}><input type="checkbox" checked={free} onChange={(e) => { setFree(e.target.checked); setGen(null); setF((x) => ({ ...x, generic_id: undefined, drug_text: undefined })); }} /> კატალოგის გარეშე</label>}
          </div>
          <div className="seg" role="group" aria-label="ტიპი" style={{ width: 'max-content', flexWrap: 'wrap' }}>
            {(Object.keys(TYPE_KA) as OType[]).map((t) => <button key={t} type="button" aria-pressed={f.order_type === t} onClick={() => set('order_type', t)}>{TYPE_KA[t]}</button>)}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12 }}>
            {f.order_type !== 'continuous' && <>
              <Field label={perKg ? 'დოზა / კგ' : 'დოზა'} htmlFor="od-d" required>
                <input id="od-d" className="input mono" type="number" min={0} step="any" value={(perKg ? f.dose_per_kg : f.dose) ?? ''}
                  onChange={(e) => set(perKg ? 'dose_per_kg' : 'dose', e.target.value ? Number(e.target.value) : undefined)} /></Field>
              <Field label="ერთეული" htmlFor="od-u" required><select id="od-u" className="select" value={f.dose_unit ?? ''} disabled={!!gen?.dose_unit} onChange={(e) => set('dose_unit', e.target.value)}>
                <option value="">—</option>{Object.entries(UNIT_KA).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
            </>}
            {f.order_type === 'continuous' && !titr && <Field label="სიჩქარე (მლ/სთ)" htmlFor="od-rt" required>
              <input id="od-rt" className="input mono" type="number" min={0} step="any" value={f.rate_ml_h ?? ''} onChange={(e) => set('rate_ml_h', e.target.value ? Number(e.target.value) : undefined)} /></Field>}
            {f.order_type === 'continuous' && titr && <>
              <Field label="დოზა" htmlFor="od-dr" required><input id="od-dr" className="input mono" type="number" min={0} step="any" value={f.dose_rate ?? ''} onChange={(e) => set('dose_rate', e.target.value ? Number(e.target.value) : undefined)} /></Field>
              <Field label="ერთეული" htmlFor="od-dru" required><select id="od-dru" className="select" value={f.dose_rate_unit ?? ''} onChange={(e) => set('dose_rate_unit', e.target.value || undefined)}>
                <option value="">—</option>{DOSE_RATE_UNITS.map((u) => <option key={u} value={u}>{RATE_KA[u]}</option>)}</select></Field>
            </>}
            <Field label="გზა" htmlFor="od-r" required><select id="od-r" className="select" value={f.route_code ?? ''} onChange={(e) => set('route_code', e.target.value)}>
              <option value="">—</option>{routes.map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}</select></Field>
            {f.order_type === 'scheduled' && <Field label="სიხშირე" htmlFor="od-f" required><select id="od-f" className="select" value={f.frequency_code ?? ''} onChange={(e) => set('frequency_code', e.target.value)}>
              <option value="">—</option>{freqs.data?.map((x) => <option key={x.code} value={x.code}>{x.name}{x.times_of_day ? ` (${x.times_of_day.join(', ')})` : ''}</option>)}</select></Field>}
          </div>
          {f.order_type === 'continuous' && <label className="row small"><input type="checkbox" checked={titr} onChange={(e) => { setTitr(e.target.checked); setChecks(null);
            if (e.target.checked) setF((x) => ({ ...x, dose_rate_unit: x.dose_rate_unit ?? 'mcg/kg/min', conc_unit: x.conc_unit ?? 'mg', titratable: x.titratable ?? true })); }} />
            დოზა სიჩქარით — ვაზოპრესორი / ტიტრაცია (მლ/სთ ითვლება ავტომატურად)</label>}
          {f.order_type === 'continuous' && titr && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12 }}>
            <Field label="კონცენტრაცია: რაოდენობა" htmlFor="od-ca" required><input id="od-ca" className="input mono" type="number" min={0} step="any" value={f.conc_amount ?? ''} onChange={(e) => set('conc_amount', e.target.value ? Number(e.target.value) : undefined)} placeholder="4" /></Field>
            <Field label="ერთეული" htmlFor="od-cu" required><select id="od-cu" className="select" value={f.conc_unit ?? ''} onChange={(e) => set('conc_unit', e.target.value || undefined)}>
              <option value="mg">მგ</option><option value="mcg">მკგ</option><option value="units">ერთ.</option></select></Field>
            <Field label="მოცულობა (მლ)" htmlFor="od-cv" required><input id="od-cv" className="input mono" type="number" min={1} step="any" value={f.conc_volume_ml ?? ''} onChange={(e) => set('conc_volume_ml', e.target.value ? Number(e.target.value) : undefined)} placeholder="50" /></Field>
            <Field label="სიჩქარე" htmlFor="od-cml"><input id="od-cml" className="input mono" disabled value={calcMl !== null ? `${calcMl} მლ/სთ` : rateKg && !f.weight_kg && !ctx.weight ? 'წონა?' : '—'} /></Field>
            <Field label="ტიტრაცია: მინ." htmlFor="od-tmn"><input id="od-tmn" className="input mono" type="number" min={0} step="any" value={f.titrate_min ?? ''} onChange={(e) => set('titrate_min', e.target.value ? Number(e.target.value) : undefined)} /></Field>
            <Field label="მაქს." htmlFor="od-tmx"><input id="od-tmx" className="input mono" type="number" min={0} step="any" value={f.titrate_max ?? ''} onChange={(e) => set('titrate_max', e.target.value ? Number(e.target.value) : undefined)} /></Field>
            <Field label="მიზანი" htmlFor="od-tg"><input id="od-tg" className="input" value={f.titrate_goal ?? ''} onChange={(e) => set('titrate_goal', e.target.value)} placeholder="MAP ≥ 65" /></Field>
            <Field label="ექთანი ტიტრავს" htmlFor="od-tt"><label className="row" style={{ height: 40 }}><input id="od-tt" type="checkbox" checked={!!f.titratable} onChange={(e) => set('titratable', e.target.checked)} /> დიაპაზონში</label></Field>
          </div>}
          {f.order_type !== 'continuous' && <label className="row small"><input type="checkbox" checked={perKg} onChange={(e) => { setPerKg(e.target.checked); setChecks(null); }} />
            დოზა წონაზე (მგ/კგ){perKg && ctx.weight && <span className="muted"> — {fmt(ctx.weight.kg)} კგ → {f.dose_per_kg ? fmt(f.dose_per_kg * ctx.weight.kg) : '…'} {UNIT_KA[f.dose_unit ?? ''] ?? ''}</span>}</label>}
          {(perKg || child || rateKg) && <Field label={`წონა (კგ)${ctx.weight ? ` — ბოლო: ${fmt(ctx.weight.kg)} (${tsDate(ctx.weight.at)})` : ''}`} htmlFor="od-w" hint={child ? 'ბავშვის დანიშნულებას წონა სჭირდება' : undefined}>
            <input id="od-w" className="input mono" style={{ maxWidth: 160 }} type="number" min={0.2} max={400} step="any" value={f.weight_kg ?? ''} placeholder={ctx.weight ? fmt(ctx.weight.kg) : ''}
              onChange={(e) => set('weight_kg', e.target.value ? Number(e.target.value) : undefined)} /></Field>}
          {f.order_type === 'prn' && <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 12 }}>
            <Field label="ჩვენება" htmlFor="od-pr" required><input id="od-pr" className="input" value={f.prn_reason ?? ''} onChange={(e) => set('prn_reason', e.target.value)} placeholder="მაგ. ტკივილი > 5 ქულა; ტ° > 38.5" /></Field>
            <Field label="მაქს. დღეში" htmlFor="od-pm"><input id="od-pm" className="input mono" type="number" min={1} max={48} value={f.prn_max_per_day ?? ''} onChange={(e) => set('prn_max_per_day', e.target.value ? Number(e.target.value) : undefined)} /></Field>
            <Field label="ინტერვალი ≥ (სთ)" htmlFor="od-pi"><input id="od-pi" className="input mono" type="number" min={0.5} step="0.5" value={f.prn_min_interval_h ?? ''} onChange={(e) => set('prn_min_interval_h', e.target.value ? Number(e.target.value) : undefined)} /></Field>
          </div>}
          {(f.route_code === 'IV' || f.order_type === 'continuous') && <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 12 }}>
            <Field label="გამხსნელი" htmlFor="od-dl"><input id="od-dl" className="input" value={f.diluent ?? ''} onChange={(e) => set('diluent', e.target.value)} placeholder="მაგ. NaCl 0.9%" /></Field>
            <Field label="მოცულობა (მლ)" htmlFor="od-v"><input id="od-v" className="input mono" type="number" min={1} value={f.volume_ml ?? ''} onChange={(e) => set('volume_ml', e.target.value ? Number(e.target.value) : undefined)} /></Field>
            {f.order_type !== 'continuous' && <Field label="ხანგრძლ. (წთ)" htmlFor="od-dm"><input id="od-dm" className="input mono" type="number" min={1} value={f.duration_min ?? ''} onChange={(e) => set('duration_min', e.target.value ? Number(e.target.value) : undefined)} /></Field>}
          </div>}
        </>}

        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <Field label="დაწყება" htmlFor="od-sd"><input id="od-sd" className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="დრო" htmlFor="od-st"><input id="od-st" className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} /></Field>
          {med && f.order_type !== 'once' && <Field label="ხანგრძლივობა (დღე)" htmlFor="od-dd" hint={gen?.atc_code?.startsWith('J01') ? 'ანტიბიოტიკი — სავალდებულო' : 'ცარიელი — გაუქმებამდე'}>
            <input id="od-dd" className="input mono" type="number" min={1} max={365} value={f.duration_days ?? ''} onChange={(e) => set('duration_days', e.target.value ? Number(e.target.value) : undefined)} /></Field>}
          {med && <Field label="მომარაგება" htmlFor="od-sp"><select id="od-sp" className="select" value={f.supply_mode ?? ''} onChange={(e) => set('supply_mode', (e.target.value || undefined) as OrderBody['supply_mode'])}>
            <option value="">ავტომატურად{gen?.patient_only ? ' (აფთიაქიდან)' : ''}</option><option value="ward">განყოფილების მარაგიდან</option><option value="pharmacy">აფთიაქიდან პაციენტზე</option></select></Field>}
        </div>
        <Field label="ინსტრუქცია" htmlFor="od-in"><input id="od-in" className="input" value={f.instructions ?? ''} onChange={(e) => set('instructions', e.target.value)} placeholder="მაგ. ჭამის შემდეგ; ნელა, 3–5 წთ-ში" /></Field>
        {mode === 'modify' && <Field label="შეცვლის მიზეზი" htmlFor="od-mr" required><input id="od-mr" className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>}
        {mode === 'modify' && <span className="small muted">ძველი დანიშნულება შეწყდება, ახალი შეიქმნება (ისტორია ინახება).</span>}

        {checks && <div className="stack" style={{ gap: 6 }}>
          {checks.checks.map((c, i) => <div key={i} className={`alert ${LEVEL[c.level]}`} style={{ padding: '6px 10px' }}>{c.message}</div>)}
          {checks.requires.ack && !checks.requires.reason && <label className="row"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> გავეცანი გაფრთხილებებს</label>}
          {checks.requires.reason && <Field label="დასაბუთება (სავალდებულო)" htmlFor="od-ov" required><input id="od-ov" className="input" value={ovr} onChange={(e) => setOvr(e.target.value)} /></Field>}
          {checks.requires.severe && <label className="row" style={{ color: 'var(--danger)' }}><input type="checkbox" checked={severe} onChange={(e) => setSevere(e.target.checked)} /> ვადასტურებ მძიმე ალერგიის რისკს</label>}
        </div>}
        <ErrorBox error={errShown} />
      </div>
    </Modal>
  );
}

// ================================================================= დეტალები
const EV_KA: Record<string, string> = { created: 'შეიქმნა', held: 'შეჩერდა', resumed: 'განახლდა', stopped: 'შეწყდა', modified: 'შეიცვალა', completed: 'დასრულდა (ვადა)',
  verified: 'დადასტურდა', verify_rejected: 'უარყოფილია (დადასტურებისას)', approved: 'დამტკიცდა', approval_rejected: 'დამტკიცებაზე უარი', verbal_confirmed: 'ზეპირი დადასტურდა',
  supply_requested: 'აფთიაქის მოთხოვნა', end_reminder: 'შეხსენება: სრულდება', discharge_stop: 'შეწყდა გაწერისას' };
function OrderDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['ipd-order', id], queryFn: () => api<Order & { events: { id: string; kind: string; data: Record<string, unknown>; at: string; user_name: string | null }[] }>(`/inpatient/orders/${id}`) });
  const o = q.data;
  return (
    <Modal title={o?.title ?? 'დანიშნულება'} onClose={onClose} width={640}>
      {!o ? <Loading /> : <div className="stack" style={{ gap: 10 }}>
        <div>{orderSummary(o)}</div>
        <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}><span className={`chip ${STATUS[o.status][0]}`}>{STATUS[o.status][1]}</span><OrderBadges o={o} /></div>
        {o.instructions && <div className="small">ინსტრუქცია: {o.instructions}</div>}
        <div className="small">დანიშნა: <strong>{o.ordered_by_name}</strong>{o.is_verbal ? ` (ზეპირად; შეიყვანა ${o.entered_by_name}${o.verbal_confirmed_at ? `, დადასტურდა ${dt(o.verbal_confirmed_at)}` : ', დაუდასტურებელი'})` : ''} · {dt(o.created_at)}</div>
        {o.verified_by_name && <div className="small">დაადასტურა: {o.verified_by_name}{o.verify_note ? ` — ${o.verify_note}` : ''}</div>}
        {o.approved_by_name && <div className="small">დამტკიცება: {o.approved_by_name}{o.approval_note ? ` — ${o.approval_note}` : ''}</div>}
        {o.checks.length > 0 && <div className="stack" style={{ gap: 4 }}><span className="label">შემოწმებები</span>
          {o.checks.map((c, i) => <div key={i} className={`alert ${LEVEL[c.level]}`} style={{ padding: '4px 10px' }}>{c.message}</div>)}
          {o.override_reason && <div className="small">დასაბუთება: <strong>{o.override_reason}</strong></div>}</div>}
        <table className="table"><tbody>{o.events.map((e) => <tr key={e.id}><td className="small mono">{dt(e.at)}</td><td><strong>{EV_KA[e.kind] ?? e.kind}</strong></td>
          <td className="small">{[e.data.reason, e.data.note, e.data.req_no].filter(Boolean).join(' · ') as string}</td><td className="small muted">{e.user_name ?? 'სისტემა'}</td></tr>)}</tbody></table>
        {o.replaces_id && <span className="small muted">ცვლის წინა დანიშნულებას.</span>}
      </div>}
    </Modal>
  );
}

// ================================================================= შაბლონები
function SetsDialog({ departmentId, active, onClose, onPick }: { departmentId: string; active: Order[]; onClose: () => void; onPick: (it: Partial<OrderBody>, setId: string) => void }) {
  const qc = useQueryClient(); const { user } = useAuth();
  const q = useQuery({ queryKey: ['order-sets', departmentId], queryFn: () => api<OrderSet[]>('/inpatient/orders/sets', { query: { department_id: departmentId } }) });
  const [sel, setSel] = useState<string | null>(null); const [name, setName] = useState(''); const [dep, setDep] = useState(false);
  const save = useMutation({ mutationFn: () => api('/inpatient/orders/sets', { body: { name, department_id: dep ? departmentId : undefined, items: active.map(fromOrder) } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['order-sets'] }); setName(''); } });
  const s = q.data?.find((x) => x.id === sel);
  return (
    <Modal title="დანიშნულებების შაბლონები" onClose={onClose} width={720}>
      <div className="stack" style={{ gap: 12 }}>
        {q.isLoading ? <Loading /> : !q.data?.length ? <span className="muted">შაბლონი ჯერ არ არის.</span> : (
          <div style={{ display: 'grid', gridTemplateColumns: '240px minmax(0, 1fr)', gap: 12 }}>
            <div className="stack" style={{ gap: 4 }}>{q.data.map((x) => <button key={x.id} type="button" className={`btn sm${sel === x.id ? ' primary' : ''}`} style={{ justifyContent: 'flex-start' }} onClick={() => setSel(x.id)}>
              {x.name} <span className="small muted">{x.owner_id === user?.id ? '· პირადი' : `· ${x.department_name ?? ''}`}</span></button>)}</div>
            <div className="stack" style={{ gap: 6 }}>{s ? s.items.map((it, i) => <div key={i} className="row card" style={{ padding: 8, gap: 8 }}>
              <span className="grow small"><span className="chip">{CATEGORY_KA[it.category as Category]}</span> {it.text ?? it.drug_text ?? (it.generic_id ? 'კატალოგიდან' : '')}{it.dose ? ` · ${it.dose} ${UNIT_KA[it.dose_unit ?? ''] ?? ''}` : ''}{it.frequency_code ? ` · ${it.frequency_code}` : ''}</span>
              <button className="btn sm primary" type="button" onClick={() => onPick(it, s.id)}>დანიშვნა…</button></div>) : <span className="small muted">აირჩიეთ შაბლონი — თითო დანიშნულება ცალკე იხსნება და მოწმდება.</span>}</div>
          </div>)}
        {active.length > 0 && <div className="card card-pad stack" style={{ gap: 8 }}>
          <span className="label">აქტიური დანიშნულებებიდან ({active.length}) შაბლონის შექმნა</span>
          <div className="row" style={{ gap: 8 }}><input className="input grow" aria-label="შაბლონის სახელი" value={name} onChange={(e) => setName(e.target.value)} placeholder="მაგ. პნევმონია — საწყისი" />
            <label className="row small"><input type="checkbox" checked={dep} onChange={(e) => setDep(e.target.checked)} /> განყოფილების (ხელმძღვანელი)</label>
            <button className="btn" type="button" disabled={name.trim().length < 2 || save.isPending} onClick={() => save.mutate()}>შენახვა</button></div>
          <ErrorBox error={save.error} />
        </div>}
      </div>
    </Modal>
  );
}

// ================================================================= განყოფილების ხედი (სტაციონარი → დანიშნულებები)
export function DepartmentOrders({ departmentId }: { departmentId: string }) {
  const toast = useToast(); const inval = useInvalidate(); const { user } = useAuth();
  const q = useQuery({ queryKey: ['ipd-dep-orders', departmentId], queryFn: () => api<{ orders: Order[]; can_approve: boolean; can_verify: boolean }>(`/inpatient/departments/${departmentId}/orders`), enabled: !!departmentId, refetchInterval: 60_000 });
  const [attention, setAttention] = useState(true);
  const [rej, setRej] = useState<Order | null>(null);
  const act = useMutation({ mutationFn: (a: { path: string; body?: unknown }) => api(a.path, { body: a.body ?? {} }), onSuccess: () => { toast.show('შესრულდა'); inval(); } });
  if (q.isLoading) return <Loading />;
  if (!q.data) return <ErrorBox error={q.error} />;
  const need = (o: Order) => o.approval_status === 'pending' || o.verify_status === 'pending' || o.verify_status === 'rejected' || (o.is_verbal && !o.verbal_confirmed_at) || o.status === 'on_hold';
  const rows = q.data.orders.filter((o) => !attention || need(o));
  const byPatient = new Map<string, Order[]>();
  for (const o of rows) byPatient.set(o.encounter_id, [...(byPatient.get(o.encounter_id) ?? []), o]);
  return (
    <div className="stack">
      {toast.node}
      {q.data.can_verify && <section className="stack" style={{ gap: 8 }}>
        <h3 style={{ margin: 0 }}>დასადასტურებელი დანიშნულებები</h3>
        <Verification departmentId={departmentId} />
      </section>}
      <div className="row"><label className="row"><input type="checkbox" checked={attention} onChange={(e) => setAttention(e.target.checked)} /> მხოლოდ ყურადღების მოთხოვნით
        <span className="small muted">(დასამტკიცებელი, დასადასტურებელი, ზეპირი, შეჩერებული)</span></label>
        <span className="grow" /><span className="small muted">აქტიური: {q.data.orders.length}</span></div>
      <ErrorBox error={act.error} />
      {!rows.length && <div className="card empty">{attention ? 'ყურადღების მოთხოვნით დანიშნულება არ არის.' : 'აქტიური დანიშნულება არ არის.'}</div>}
      {[...byPatient.values()].map((xs) => (
        <section key={xs[0].encounter_id} className="card">
          <div className="card-head"><Link to={`/inpatient/stay/${xs[0].encounter_id}?tab=orders`}><strong>{xs[0].last_name} {xs[0].first_name}</strong></Link>
            <span className="mono small">{xs[0].adm_no}</span>{xs[0].bed_code && <span className="small muted">საწოლი {xs[0].bed_code}</span>}</div>
          <table className="table"><tbody>{xs.map((o) => <tr key={o.id}>
            <td style={{ width: '45%' }}><strong>{o.title}</strong><div className="small">{orderSummary(o)}</div></td>
            <td><div className="row" style={{ gap: 4, flexWrap: 'wrap' }}><span className={`chip ${STATUS[o.status][0]}`}>{STATUS[o.status][1]}</span><OrderBadges o={o} /></div></td>
            <td className="small muted">{o.ordered_by_name}</td>
            <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{q.data.can_approve && o.approval_status === 'pending' && o.ordered_by !== user?.id && <>
              <button className="btn sm primary" type="button" onClick={() => act.mutate({ path: `/inpatient/orders/${o.id}/approve` })}>დამტკიცება</button>{' '}
              <button className="btn sm" type="button" onClick={() => setRej(o)}>უარი</button></>}
              {o.is_verbal && !o.verbal_confirmed_at && o.ordered_by === user?.id && <button className="btn sm primary" type="button" onClick={() => act.mutate({ path: `/inpatient/orders/${o.id}/confirm` })}>დადასტურება</button>}</td>
          </tr>)}</tbody></table>
        </section>))}
      {rej && <ReasonModal title={`სარეზერვო ანტიბიოტიკი — უარი: ${rej.title}`} onClose={() => setRej(null)}
        onSubmit={(r) => act.mutateAsync({ path: `/inpatient/orders/${rej.id}/approve-reject`, body: { note: r } }).then(() => setRej(null))} />}
    </div>
  );
}

export { dt as orderDateTime };
export const ORDER_START_DEFAULT = () => localISO(todayISO(), '08:00');
