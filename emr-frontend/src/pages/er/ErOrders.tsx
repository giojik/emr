import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { ApiError, api } from '../../api/client';
import { ErrorBox, Field, Loading, Modal, useDebounced, useToast } from '../../components/ui';
import { tsDate } from '../../lib/format';
import { hm } from './types';

/**
 * 0089 — ER: დანიშვნა / მიცემა / ჩამოწერა (ბარათის ჩანართი „დანიშნულებები“).
 *  • ექიმი ნიშნავს (STAT / ერთჯერადი / PRN; მედიკამენტი / ინფუზია / პროცედურა); ექთანი — ზეპირი დანიშნულება ექიმის სახელით (ექიმი ადასტურებს);
 *  • შემოწმებები (ალერგია; აფთიაქის მოდულით — დოზა / ურთიერთქმედება) → დადასტურება / დასაბუთება;
 *  • მიცემა: დოზა / გზა / დრო, უარი / გადადება მიზეზით; საწყობის მოდულით — ჩამოწერა ER-ის ქვესაწყობიდან (FEFO), ნარკოტიკული — მოწმე.
 */
type Kind = 'medication' | 'infusion' | 'procedure';
type OType = 'stat' | 'once' | 'prn';
interface Check { code: string; level: 'info' | 'warn' | 'reason'; message: string; severe?: boolean }
interface Adm {
  id: string; order_id: string; outcome: 'given' | 'partial' | 'held' | 'refused'; infusion_action: 'start' | 'stop' | null; administered_at: string; documented_by_name: string;
  dose: string | null; dose_unit: string | null; route_code: string | null; rate_ml_h: string | null; site: string | null; reason: string | null; no_stock: boolean;
  stock_doc_no: string | null; stock_item_name: string | null; qty_base: string | null; lot_no: string | null; witness_name: string | null; double_check_name: string | null;
  override_reason: string | null; voided_at: string | null; void_reason: string | null; voided_by_name: string | null;
}
export interface ErOrder {
  id: string; kind: Kind; order_type: OType; name: string | null; generic_id: string | null; drug_text: string | null; dose: string | null; dose_unit: string | null;
  route_code: string | null; route_name: string | null; volume_ml: string | null; rate_ml_h: string | null; diluent: string | null; prn_reason: string | null;
  prn_min_interval_h: string | null; prn_max_doses: number | null; expires_at: string | null; text: string | null; instructions: string | null;
  high_alert: boolean; controlled_class: string | null; status: 'active' | 'completed' | 'stopped' | 'expired'; is_verbal: boolean; verbal_due_at: string | null;
  verbal_confirmed_at: string | null; verbal_confirmed_by_name: string | null; ordered_by: string; ordered_by_name: string; entered_by_name: string; created_at: string;
  stopped_at: string | null; stopped_by_name: string | null; stop_reason: string | null; checks: Check[]; override_reason: string | null;
  administrations: Adm[]; given_count: number; last_given_at: string | null; stat_overdue: boolean; verbal_overdue: boolean;
}
interface OrdersResp {
  orders: ErOrder[]; routes: { code: string; name: string }[]; units: string[];
  settings: { prn_max_h: number; verbal_orders: boolean; verbal_confirm_h: number; double_check: 'off' | 'high_alert' | 'high_alert_controlled'; dose_rule: string;
    allow_no_stock: boolean; stock_deduct: boolean; stat_due_min: number };
  modules: { catalog: boolean; stock: boolean; pharmacy: boolean };
  can: { order: boolean; administer: boolean; verbal: boolean; confirm: boolean };
}
interface Gen { id: string; inn: string; inn_latin: string | null; strength: string | null; atc_code: string | null; form_name: string; dose_unit: string | null; routes: string[];
  high_alert: boolean; controlled_class: string | null; available: number | null }

export const KIND_KA: Record<Kind, string> = { medication: 'მედიკამენტი', infusion: 'ინფუზია', procedure: 'პროცედურა' };
export const TYPE_KA: Record<OType, string> = { stat: 'STAT', once: 'ერთჯერადი', prn: 'PRN' };
const STATUS_KA: Record<ErOrder['status'], string> = { active: 'აქტიური', completed: 'შესრულებული', stopped: 'შეწყვეტილი', expired: 'ვადაგასული' };
const OUT_KA: Record<Adm['outcome'], string> = { given: 'მიცემულია', partial: 'ნაწილობრივ', held: 'გადაიდო', refused: 'უარი' };
const UNIT_KA: Record<string, string> = { mg: 'მგ', mcg: 'მკგ', g: 'გ', IU: 'სე', ml: 'მლ', mmol: 'მმოლ', mEq: 'მეკვ', tab: 'ტაბ.', cap: 'კაპს.', amp: 'ამპ.', vial: 'ფლაკ.',
  drop: 'წვეთი', puff: 'შესხურება', sachet: 'პაკეტი', supp: 'სანთ.', appl: 'აპლიკ.' };
const num = (v: string | null) => (v === null ? '' : String(Number(v)));
const doseText = (o: ErOrder) => o.kind === 'procedure' ? '' : [o.dose && `${num(o.dose)} ${UNIT_KA[o.dose_unit ?? ''] ?? o.dose_unit ?? ''}`, o.route_name ?? o.route_code,
  o.volume_ml && `${num(o.volume_ml)} მლ`, o.rate_ml_h && `${num(o.rate_ml_h)} მლ/სთ`, o.diluent].filter(Boolean).join(' · ');

export default function ErOrdersPanel({ encounterId, departmentId }: { encounterId: string; departmentId: string }) {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['er-orders', encounterId], queryFn: () => api<OrdersResp>(`/er/visits/${encounterId}/orders`) });
  const [dlg, setDlg] = useState<{ t: 'order'; verbal: boolean } | { t: 'give'; o: ErOrder } | { t: 'stop'; o: ErOrder } | { t: 'void'; a: Adm } | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const inv = (msg?: string) => { if (msg) toast.show(msg); void qc.invalidateQueries({ queryKey: ['er-orders', encounterId] }); void qc.invalidateQueries({ queryKey: ['er-board'] }); void qc.invalidateQueries({ queryKey: ['er-visit', encounterId] }); };
  const confirm = useMutation({ mutationFn: (id: string) => api(`/er/orders/${id}/confirm`, { method: 'POST' }), onSuccess: () => inv('ზეპირი დანიშნულება დადასტურდა') });
  if (!q.data) return q.error ? <ErrorBox error={q.error} /> : <Loading />;
  const d = q.data;
  const active = d.orders.filter((o) => o.status === 'active');
  const rest = d.orders.filter((o) => o.status !== 'active');
  const row = (o: ErOrder) => (
    <Fragment key={o.id}>
      <tr data-testid="er-order-row" className={o.status !== 'active' ? 'muted' : undefined}>
        <td><span className={`chip ${o.order_type === 'stat' ? 'danger' : o.order_type === 'prn' ? 'info' : ''}`}>{TYPE_KA[o.order_type]}</span>
          <div className="small muted">{KIND_KA[o.kind]}</div></td>
        <td><strong>{o.name}</strong>{o.high_alert && <span className="chip danger" style={{ marginLeft: 6 }}>მაღ. რისკი</span>}{o.controlled_class && <span className="chip warn" style={{ marginLeft: 6 }}>კონტროლ.</span>}
          {!o.generic_id && o.kind !== 'procedure' && <span className="chip" style={{ marginLeft: 6 }} title="კატალოგის გარეშე — დოზა / ურთიერთქმედება არ შემოწმდა">ტექსტით</span>}
          <div className="small">{doseText(o)}</div>
          {o.prn_reason && <div className="small muted">PRN: {o.prn_reason}{o.prn_min_interval_h ? ` · ≥ ${num(o.prn_min_interval_h)} სთ` : ''}{o.prn_max_doses ? ` · მაქს. ${o.prn_max_doses}` : ''}{o.expires_at ? ` · ვადა ${hm(o.expires_at)}` : ''}</div>}
          {o.instructions && <div className="small muted">{o.instructions}</div>}</td>
        <td className="small">{o.ordered_by_name}<div className="muted">{tsDate(o.created_at)} {hm(o.created_at)}</div>
          {o.is_verbal && <div>{o.verbal_confirmed_at ? <span className="chip ok" title={`დაადასტურა ${o.verbal_confirmed_by_name ?? ''}`}>ზეპირი ✓</span>
            : <span className={`chip ${o.verbal_overdue ? 'danger' : 'warn'}`} data-testid="er-verbal-pending">ზეპირი — დაუდასტ.{o.verbal_due_at ? ` (${hm(o.verbal_due_at)}-მდე)` : ''}</span>}
            <span className="muted"> · შეიყვანა {o.entered_by_name}</span></div>}</td>
        <td><span className="small">{STATUS_KA[o.status]}</span>{o.stat_overdue && <div><span className="chip danger" data-testid="er-stat-overdue">STAT — {d.settings.stat_due_min} წთ+</span></div>}
          {o.stop_reason && <div className="small muted">{o.stop_reason}</div>}</td>
        <td className="small">{o.given_count > 0 ? <button type="button" className="btn sm ro-ok" onClick={() => setOpen({ ...open, [o.id]: !open[o.id] })}>{o.given_count}× · {hm(o.last_given_at)}</button>
          : o.administrations.length ? <button type="button" className="btn sm ro-ok" onClick={() => setOpen({ ...open, [o.id]: !open[o.id] })}>ჩანაწერი ({o.administrations.length})</button> : '—'}</td>
        <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
          {o.status === 'active' && d.can.administer && <button className="btn sm primary" type="button" onClick={() => setDlg({ t: 'give', o })}>{o.kind === 'procedure' ? 'შესრულება' : o.kind === 'infusion' ? 'ინფუზია' : 'მიცემა'}</button>}{' '}
          {o.is_verbal && !o.verbal_confirmed_at && o.status !== 'stopped' && d.can.confirm && <button className="btn sm" type="button" disabled={confirm.isPending} onClick={() => confirm.mutate(o.id)}>დადასტურება</button>}{' '}
          {o.status === 'active' && (d.can.order || (o.is_verbal && !o.verbal_confirmed_at && d.can.verbal)) && <button className="btn sm" type="button" onClick={() => setDlg({ t: 'stop', o })}>შეწყვეტა</button>}
        </td>
      </tr>
      {open[o.id] && <tr><td colSpan={6} style={{ background: 'var(--surface-2, #fafafa)' }}>
        <table className="table" data-testid="er-adm-list"><thead><tr><th>დრო</th><th>შედეგი</th><th>დოზა / გზა</th><th>საწყობი</th><th>ვინ</th><th /></tr></thead>
          <tbody>{o.administrations.map((a) => <tr key={a.id} style={a.voided_at ? { textDecoration: 'line-through', opacity: 0.6 } : undefined}>
            <td className="mono">{tsDate(a.administered_at)} {hm(a.administered_at)}</td>
            <td>{OUT_KA[a.outcome]}{a.infusion_action ? ` (${a.infusion_action === 'start' ? 'დაწყება' : 'დასრულება'})` : ''}{a.reason && <div className="small muted">{a.reason}</div>}
              {a.voided_at && <div className="small">გაუქმდა: {a.void_reason}</div>}</td>
            <td className="small">{[a.dose && `${num(a.dose)} ${UNIT_KA[a.dose_unit ?? ''] ?? a.dose_unit ?? ''}`, a.route_code, a.rate_ml_h && `${num(a.rate_ml_h)} მლ/სთ`, a.site].filter(Boolean).join(' · ') || '—'}</td>
            <td className="small">{a.stock_doc_no ? <>{a.stock_item_name} × {num(a.qty_base)}{a.lot_no ? ` · ლოტი ${a.lot_no}` : ''}<div className="muted mono">{a.stock_doc_no}</div></>
              : a.no_stock ? <span className="chip warn">ჩამოწერის გარეშე</span> : '—'}{a.override_reason && <div className="muted">დასაბუთება: {a.override_reason}</div>}</td>
            <td className="small">{a.documented_by_name}{a.witness_name && <div className="muted">მოწმე: {a.witness_name}</div>}{a.double_check_name && <div className="muted">შემოწმება: {a.double_check_name}</div>}</td>
            <td>{!a.voided_at && d.can.administer && <button className="btn sm" type="button" onClick={() => setDlg({ t: 'void', a })}>გაუქმება</button>}</td></tr>)}</tbody></table>
      </td></tr>}
    </Fragment>
  );
  return (
    <div className="stack" style={{ gap: 12 }} data-testid="er-orders">
      {toast.node}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {d.can.order && <button className="btn primary sm" type="button" onClick={() => setDlg({ t: 'order', verbal: false })}>+ დანიშვნა</button>}
        {d.can.verbal && <button className="btn sm" type="button" onClick={() => setDlg({ t: 'order', verbal: true })}>+ ზეპირი დანიშნულება</button>}
        <span className="grow" />
        {!d.modules.stock && <span className="chip" title="საწყობის მოდული არააქტიურია ან ჩამოწერა გამორთულია">ჩამოწერის გარეშე</span>}
        {!d.modules.pharmacy && <span className="chip" title="აფთიაქის მოდული არააქტიურია — მოწმდება მხოლოდ ალერგია">დოზის / ურთიერთქმედების შემოწმება — არა</span>}
      </div>
      <ErrorBox error={confirm.error} />
      <section className="card">
        <div className="card-head"><h2>დანიშნულებები</h2><span className="small muted">აქტიური {active.length}</span></div>
        {d.orders.length === 0 ? <div className="empty">დანიშნულება არ არის.</div> : (
          <table className="table" data-testid="er-orders-table"><thead><tr><th>ტიპი</th><th>დანიშნულება</th><th>ექიმი</th><th>სტატუსი</th><th>მიცემა</th><th /></tr></thead>
            <tbody>{[...active, ...rest].map(row)}</tbody></table>)}
      </section>
      {dlg?.t === 'order' && <OrderDialog encounterId={encounterId} departmentId={departmentId} ctx={d} verbal={dlg.verbal} onClose={() => setDlg(null)} onDone={(m) => inv(m)} />}
      {dlg?.t === 'give' && <AdministerDialog o={dlg.o} ctx={d} onClose={() => setDlg(null)} onDone={(m) => inv(m)} />}
      {dlg?.t === 'stop' && <ReasonDialog title={`შეწყვეტა — ${dlg.o.name}`} url={`/er/orders/${dlg.o.id}/stop`} onClose={() => setDlg(null)} onDone={() => inv('დანიშნულება შეწყდა')} />}
      {dlg?.t === 'void' && <ReasonDialog title="მიცემის ჩანაწერის გაუქმება" hint={dlg.a.stock_doc_no ? 'ჩამოწერა შემობრუნდება (ნაშთი დაბრუნდება ქვესაწყობში)' : undefined}
        url={`/er/administrations/${dlg.a.id}/void`} onClose={() => setDlg(null)} onDone={() => inv('ჩანაწერი გაუქმდა')} />}
    </div>
  );
}

function ReasonDialog({ title, url, hint, onClose, onDone }: { title: string; url: string; hint?: string; onClose: () => void; onDone: () => void }) {
  const [r, setR] = useState('');
  const m = useMutation({ mutationFn: () => api(url, { body: { reason: r.trim() } }), onSuccess: () => { onDone(); onClose(); } });
  return <Modal title={title} onClose={onClose} width={480} footer={<><button className="btn" type="button" onClick={onClose}>დახურვა</button>
    <button className="btn primary" type="button" disabled={r.trim().length < 3 || m.isPending} onClick={() => m.mutate()}>შენახვა</button></>}>
    {hint && <span className="small muted">{hint}</span>}
    <Field label="მიზეზი" htmlFor="er-rs" required><input id="er-rs" className="input" value={r} onChange={(e) => setR(e.target.value)} /></Field>
    <ErrorBox error={m.error} />
  </Modal>;
}

function ChecksBox({ checks }: { checks: Check[] }) {
  return <div className="alert warn stack" style={{ gap: 4 }} data-testid="er-checks">
    {checks.map((c, i) => <div key={i} className="small" style={c.level === 'reason' || c.severe ? { fontWeight: 600 } : undefined}>
      {c.severe ? '⛔ ' : c.level === 'reason' ? '⚠ ' : c.level === 'warn' ? '• ' : 'ℹ '}{c.message}</div>)}</div>;
}

interface OrderBody {
  kind: Kind; order_type: OType; generic_id?: string; drug_text?: string; dose?: number; dose_unit?: string; route_code?: string; weight_kg?: number; volume_ml?: number; rate_ml_h?: number;
  diluent?: string; prn_reason?: string; prn_min_interval_h?: number; prn_max_doses?: number; text?: string; instructions?: string; verbal_doctor_id?: string;
}
function OrderDialog({ encounterId, departmentId, ctx, verbal, onClose, onDone }: { encounterId: string; departmentId: string; ctx: OrdersResp; verbal: boolean; onClose: () => void; onDone: (m: string) => void }) {
  const [f, setF] = useState<OrderBody>({ kind: 'medication', order_type: 'stat' });
  const [free, setFree] = useState(!ctx.modules.catalog);
  const [gen, setGen] = useState<Gen | null>(null);
  const [search, setSearch] = useState(''); const ds = useDebounced(search, 300);
  const [checks, setChecks] = useState<{ checks: Check[]; requires: { ack: boolean; reason: boolean; severe: boolean } } | null>(null);
  const [ack, setAck] = useState(false); const [ovr, setOvr] = useState(''); const [severe, setSevere] = useState(false);
  const set = <K extends keyof OrderBody>(k: K, v: OrderBody[K]) => { setF((x) => ({ ...x, [k]: v })); setChecks(null); setAck(false); setSevere(false); };
  const found = useQuery({ queryKey: ['er-meds', ds, departmentId], enabled: !free && ds.trim().length >= 2,
    queryFn: () => api<{ enabled: boolean; items: Gen[] }>(`/er/meds?search=${encodeURIComponent(ds.trim())}&department_id=${departmentId}`) });
  const doctors = useQuery({ queryKey: ['er-staff'], enabled: verbal, queryFn: () => api<{ doctors: { id: string; name: string }[] }>('/er/staff') });
  const proc = f.kind === 'procedure';
  const body = () => {
    const b: Record<string, unknown> = { ...f };
    if (proc) { for (const k of ['generic_id', 'drug_text', 'dose', 'dose_unit', 'route_code', 'volume_ml', 'rate_ml_h', 'diluent', 'weight_kg']) delete b[k]; }
    else { delete b.text; if (free) delete b.generic_id; else delete b.drug_text; }
    if (f.kind !== 'infusion') { delete b.volume_ml; delete b.rate_ml_h; delete b.diluent; }
    if (f.order_type !== 'prn') { delete b.prn_reason; delete b.prn_min_interval_h; delete b.prn_max_doses; }
    if (!verbal) delete b.verbal_doctor_id;
    for (const k of Object.keys(b)) if (b[k] === '' || b[k] === undefined || (typeof b[k] === 'number' && Number.isNaN(b[k]))) delete b[k];
    return b;
  };
  const m = useMutation({
    mutationFn: () => api(`/er/visits/${encounterId}/orders`, { body: { ...body(), ...(checks && { ack: ack || undefined, override_reason: ovr.trim() || undefined, confirm_severe: severe || undefined }) } }),
    onSuccess: () => { onDone(verbal ? 'ზეპირი დანიშნულება შეიქმნა — ექიმი მიიღებს შეტყობინებას' : 'დანიშნულება შეიქმნა'); onClose(); },
    onError: (e) => { if (e instanceof ApiError && e.code === 'ER_ORDER_CHECKS') setChecks({ checks: e.body?.checks as Check[], requires: e.body?.requires as { ack: boolean; reason: boolean; severe: boolean } }); },
  });
  const checksOk = !checks || ((!checks.requires.ack || ack || ovr.trim().length >= 5) && (!checks.requires.reason || ovr.trim().length >= 5) && (!checks.requires.severe || severe));
  const drugOk = proc ? (f.text?.trim().length ?? 0) >= 2 : (free ? (f.drug_text?.trim().length ?? 0) >= 2 : !!f.generic_id) && !!f.route_code
    && (f.kind === 'infusion' ? !!(f.volume_ml || f.rate_ml_h) : !!f.dose && !!f.dose_unit);
  const ready = drugOk && (f.order_type !== 'prn' || (f.prn_reason?.trim().length ?? 0) >= 2) && (!verbal || !!f.verbal_doctor_id) && checksOk;
  const errShown = m.error instanceof ApiError && m.error.code === 'ER_ORDER_CHECKS' ? null : m.error;
  return (
    <Modal title={verbal ? 'ზეპირი დანიშნულება (ექიმის სიტყვით)' : 'ახალი დანიშნულება (ER)'} onClose={onClose} width={760}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button>
        <button className="btn primary" type="button" disabled={!ready || m.isPending} onClick={() => m.mutate()} data-testid="er-order-save">{checks ? 'დადასტურება და შენახვა' : 'შენახვა'}</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        {verbal && <Field label="ექიმი (ვისი სიტყვით)" htmlFor="eo-vd" required hint={`ექიმი ადასტურებს ${ctx.settings.verbal_confirm_h} სთ-ში`}>
          <select id="eo-vd" className="select" value={f.verbal_doctor_id ?? ''} onChange={(e) => set('verbal_doctor_id', e.target.value || undefined)}>
            <option value="">— აირჩიეთ —</option>{doctors.data?.doctors.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>}
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <div className="seg" role="group" aria-label="სახე">{(Object.keys(KIND_KA) as Kind[]).map((k) => <button key={k} type="button" aria-pressed={f.kind === k}
            onClick={() => { set('kind', k); if (k === 'infusion' && f.order_type === 'prn') set('order_type', 'stat'); }}>{KIND_KA[k]}</button>)}</div>
          <div className="seg" role="group" aria-label="ტიპი">{(Object.keys(TYPE_KA) as OType[]).filter((t) => f.kind !== 'infusion' || t !== 'prn').map((t) =>
            <button key={t} type="button" aria-pressed={f.order_type === t} onClick={() => set('order_type', t)}>{TYPE_KA[t]}</button>)}</div>
        </div>
        {proc ? <Field label="პროცედურა" htmlFor="eo-t" required><textarea id="eo-t" className="textarea" rows={2} value={f.text ?? ''} onChange={(e) => set('text', e.target.value)} placeholder="მაგ. ეკგ 12 განხრით; შარდის კათეტერი; ჭრილობის დამუშავება" /></Field> : <>
          <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
            <div className="grow stack" style={{ gap: 6, position: 'relative' }}>
              <span className="label">მედიკამენტი</span>
              {free ? <input className="input" aria-label="მედიკამენტი ტექსტით" value={f.drug_text ?? ''} onChange={(e) => set('drug_text', e.target.value)} placeholder="დასახელება, ფორმა, დოზა" />
                : gen ? <div className="row" style={{ gap: 8 }}><strong>{gen.inn}{gen.strength ? ` ${gen.strength}` : ''}</strong><span className="small muted">{gen.form_name}</span>
                  {gen.high_alert && <span className="chip danger">მაღ. რისკი</span>}{gen.controlled_class && <span className="chip warn">კონტროლ.</span>}
                  {gen.available !== null && <span className={`chip ${gen.available > 0 ? 'ok' : 'warn'}`}>ნაშთი: {gen.available}</span>}
                  <button className="btn sm" type="button" onClick={() => { setGen(null); set('generic_id', undefined); }}>შეცვლა</button></div>
                : <>
                  <input className="input" aria-label="ჯენერიკის ძებნა" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="INN, ლათინური ან ATC (მინ. 2 სიმბოლო)" />
                  {ds.trim().length >= 2 && <div className="card" style={{ position: 'absolute', top: 64, left: 0, right: 0, zIndex: 5, maxHeight: 260, overflow: 'auto' }}>
                    {(found.data?.items ?? []).map((g) => <button key={g.id} type="button" className="row" data-testid="er-med-option"
                      onClick={() => { setGen(g); setF((x) => ({ ...x, generic_id: g.id, dose_unit: g.dose_unit ?? x.dose_unit, route_code: x.route_code ?? g.routes[0] })); setChecks(null); }}
                      style={{ width: '100%', textAlign: 'left', padding: '6px 10px', border: 0, background: 'transparent', cursor: 'pointer', gap: 8 }}>
                      <strong>{g.inn}</strong><span className="small">{g.strength}</span><span className="small muted grow">{g.form_name}</span>
                      {g.available !== null && <span className="small mono">{g.available}</span>}</button>)}
                    {found.data && !found.data.items.length && <div className="small muted" style={{ padding: 10 }}>ვერ მოიძებნა — მონიშნეთ „კატალოგის გარეშე“</div>}
                  </div>}
                </>}
            </div>
            {ctx.modules.catalog && <label className="row small" style={{ marginTop: 34, whiteSpace: 'nowrap', flexShrink: 0 }}><input type="checkbox" checked={free}
              onChange={(e) => { setFree(e.target.checked); setGen(null); setF((x) => ({ ...x, generic_id: undefined, drug_text: undefined })); }} /> კატალოგის გარეშე</label>}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12 }}>
            <Field label="დოზა" htmlFor="eo-d" required={f.kind === 'medication'}><input id="eo-d" className="input mono" type="number" min={0} step="any" value={f.dose ?? ''}
              onChange={(e) => set('dose', e.target.value ? Number(e.target.value) : undefined)} /></Field>
            <Field label="ერთეული" htmlFor="eo-u" required={f.kind === 'medication'}><select id="eo-u" className="select" value={f.dose_unit ?? ''} onChange={(e) => set('dose_unit', e.target.value || undefined)}>
              <option value="">—</option>{ctx.units.map((u) => <option key={u} value={u}>{UNIT_KA[u] ?? u}</option>)}</select></Field>
            <Field label="გზა" htmlFor="eo-r" required><select id="eo-r" className="select" value={f.route_code ?? ''} onChange={(e) => set('route_code', e.target.value || undefined)}>
              <option value="">—</option>{ctx.routes.map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}</select></Field>
            <Field label="წონა (კგ)" htmlFor="eo-w" hint="ბავშვი — ტრიაჟის წონა, თუ ცარიელია"><input id="eo-w" className="input mono" type="number" min={0.2} max={400} step="any" value={f.weight_kg ?? ''}
              onChange={(e) => set('weight_kg', e.target.value ? Number(e.target.value) : undefined)} /></Field>
          </div>
          {f.kind === 'infusion' && <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 12 }}>
            <Field label="გამხსნელი" htmlFor="eo-dl"><input id="eo-dl" className="input" value={f.diluent ?? ''} onChange={(e) => set('diluent', e.target.value)} placeholder="მაგ. NaCl 0.9%" /></Field>
            <Field label="მოცულობა (მლ)" htmlFor="eo-v"><input id="eo-v" className="input mono" type="number" min={1} value={f.volume_ml ?? ''} onChange={(e) => set('volume_ml', e.target.value ? Number(e.target.value) : undefined)} /></Field>
            <Field label="სიჩქარე (მლ/სთ)" htmlFor="eo-rt"><input id="eo-rt" className="input mono" type="number" min={0.1} step="any" value={f.rate_ml_h ?? ''} onChange={(e) => set('rate_ml_h', e.target.value ? Number(e.target.value) : undefined)} /></Field>
          </div>}
        </>}
        {f.order_type === 'prn' && <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 12 }}>
          <Field label="ჩვენება" htmlFor="eo-pr" required hint={`მოქმედებს ${ctx.settings.prn_max_h} სთ`}><input id="eo-pr" className="input" value={f.prn_reason ?? ''} onChange={(e) => set('prn_reason', e.target.value)} placeholder="მაგ. ტკივილი > 5" /></Field>
          <Field label="ინტერვალი ≥ (სთ)" htmlFor="eo-pi"><input id="eo-pi" className="input mono" type="number" min={0.5} step="0.5" value={f.prn_min_interval_h ?? ''} onChange={(e) => set('prn_min_interval_h', e.target.value ? Number(e.target.value) : undefined)} /></Field>
          <Field label="მაქს. დოზა" htmlFor="eo-pm"><input id="eo-pm" className="input mono" type="number" min={1} max={48} value={f.prn_max_doses ?? ''} onChange={(e) => set('prn_max_doses', e.target.value ? Number(e.target.value) : undefined)} /></Field>
        </div>}
        <Field label="მითითება" htmlFor="eo-in"><input id="eo-in" className="input" value={f.instructions ?? ''} onChange={(e) => set('instructions', e.target.value)} placeholder="მაგ. ნელა, 5 წთ-ში" /></Field>
        {!ctx.modules.pharmacy && !proc && <span className="small muted">აფთიაქის მოდული არააქტიურია — მოწმდება მხოლოდ ალერგია.</span>}
        {checks && <>
          <ChecksBox checks={checks.checks} />
          {checks.requires.ack && !checks.requires.reason && <label className="row small"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> გავეცანი — ვაგრძელებ</label>}
          {checks.requires.reason && <Field label="დასაბუთება (მინ. 5 სიმბოლო)" htmlFor="eo-ov" required><input id="eo-ov" className="input" value={ovr} onChange={(e) => setOvr(e.target.value)} /></Field>}
          {checks.requires.severe && <label className="row small" style={{ color: 'var(--danger)' }}><input type="checkbox" checked={severe} onChange={(e) => setSevere(e.target.checked)} /> ვადასტურებ: მძიმე ალერგიის მიუხედავად</label>}
        </>}
        <ErrorBox error={errShown} />
      </div>
    </Modal>
  );
}

interface StockResp { deduct: boolean; location: { id: string; name: string } | null; items: { id: string; name: string; code: string | null; unit_name: string; available: number }[]; qty_suggest: number | null }
function AdministerDialog({ o, ctx, onClose, onDone }: { o: ErOrder; ctx: OrdersResp; onClose: () => void; onDone: (m: string) => void }) {
  const proc = o.kind === 'procedure'; const inf = o.kind === 'infusion';
  const started = o.administrations.some((a) => !a.voided_at && a.infusion_action === 'start');
  const [outcome, setOutcome] = useState<Adm['outcome']>('given');
  const [action, setAction] = useState<'start' | 'stop'>(started ? 'stop' : 'start');
  const [dose, setDose] = useState(o.dose ? String(Number(o.dose)) : '');
  const [route, setRoute] = useState(o.route_code ?? '');
  const [site, setSite] = useState(''); const [reason, setReason] = useState(''); const [at, setAt] = useState('');
  const [item, setItem] = useState(''); const [qty, setQty] = useState('');
  const [wit, setWit] = useState({ username: '', password: '' }); const [dc, setDc] = useState({ username: '', password: '' });
  const [checks, setChecks] = useState<Check[] | null>(null); const [ovr, setOvr] = useState('');
  const given = outcome === 'given' || outcome === 'partial';
  const wantStock = given && !proc && !!o.generic_id && (!inf || action === 'start') && ctx.modules.stock;
  const stock = useQuery({ queryKey: ['er-order-stock', o.id], enabled: wantStock, queryFn: () => api<StockResp>(`/er/orders/${o.id}/stock`) });
  const needWit = wantStock && !!o.controlled_class && (o.controlled_class === 'narcotic' || o.controlled_class === 'psychotropic');
  const needDc = given && !proc && (ctx.settings.double_check === 'high_alert' ? o.high_alert : ctx.settings.double_check === 'high_alert_controlled' ? o.high_alert || !!o.controlled_class : false) && !(inf && action === 'stop');
  const m = useMutation({
    mutationFn: () => {
      const b: Record<string, unknown> = { outcome };
      if (inf && given) b.infusion_action = action;
      if (given && !proc && !(inf && action === 'stop') && dose) b.dose = Number(dose);
      if (given && !proc && route && route !== o.route_code) b.route_code = route;
      if (site.trim()) b.site = site.trim();
      if (reason.trim()) b.reason = reason.trim();
      if (at) b.administered_at = new Date(at).toISOString();
      if (wantStock && item) b.item_id = item;
      if (wantStock && qty) b.qty_base = Number(qty);
      if (needWit && wit.username) b.witness = wit;
      if (needDc) b.double_check = dc;
      if (ovr.trim()) b.override_reason = ovr.trim();
      return api(`/er/orders/${o.id}/administer`, { body: b });
    },
    onSuccess: () => { onDone(proc ? 'შესრულება ჩაიწერა' : given ? 'მიცემა ჩაიწერა' : 'ჩაიწერა'); onClose(); },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'ER_ADMIN_CHECKS') setChecks(e.body?.checks as Check[]);
      if (e instanceof ApiError && e.code === 'ER_ITEM_REQUIRED') void stock.refetch();
    },
  });
  const ok = (given || reason.trim().length >= 2) && (!checks || ovr.trim().length >= 3) && (!needDc || (dc.username && dc.password)) && (!needWit || (wit.username && wit.password))
    && (!given || proc || inf || !!dose);
  const err = m.error instanceof ApiError && m.error.code === 'ER_ADMIN_CHECKS' ? null : m.error;
  return (
    <Modal title={`${proc ? 'შესრულება' : inf ? 'ინფუზია' : 'მიცემა'} — ${o.name}`} onClose={onClose} width={680}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button>
        <button className="btn primary" type="button" disabled={!ok || m.isPending} onClick={() => m.mutate()} data-testid="er-adm-save">შენახვა</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <div className="small muted">{TYPE_KA[o.order_type]} · {doseText(o) || o.text}{o.instructions ? ` · ${o.instructions}` : ''}</div>
        <div className="seg" role="group" aria-label="შედეგი" style={{ width: 'max-content' }}>
          {(['given', ...(proc || inf ? [] : ['partial']), 'held', 'refused'] as Adm['outcome'][]).map((x) => <button key={x} type="button" aria-pressed={outcome === x}
            onClick={() => { setOutcome(x); setChecks(null); }}>{proc && x === 'given' ? 'შესრულდა' : OUT_KA[x]}</button>)}</div>
        {inf && given && <div className="seg" role="group" aria-label="ინფუზია" style={{ width: 'max-content' }}>
          <button type="button" aria-pressed={action === 'start'} disabled={started} onClick={() => setAction('start')}>დაწყება</button>
          <button type="button" aria-pressed={action === 'stop'} disabled={!started} onClick={() => setAction('stop')}>დასრულება</button></div>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
          {given && !proc && !(inf && action === 'stop') && <>
            <Field label={`დოზა${o.dose_unit ? ` (${UNIT_KA[o.dose_unit] ?? o.dose_unit})` : ''}`} htmlFor="ea-d" required={!inf}><input id="ea-d" className="input mono" type="number" min={0} step="any" value={dose} onChange={(e) => { setDose(e.target.value); setChecks(null); }} /></Field>
            <Field label="გზა" htmlFor="ea-r"><select id="ea-r" className="select" value={route} onChange={(e) => setRoute(e.target.value)}>{ctx.routes.map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}</select></Field>
            <Field label="ადგილი" htmlFor="ea-s"><input id="ea-s" className="input" value={site} onChange={(e) => setSite(e.target.value)} placeholder="მაგ. მარცხ. მხარი" /></Field>
          </>}
          <Field label="დრო" htmlFor="ea-at" hint="ცარიელი — ახლა"><input id="ea-at" className="input" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} /></Field>
        </div>
        {(!given || inf) && <Field label={given ? 'შენიშვნა' : outcome === 'refused' ? 'უარის მიზეზი' : 'გადადების მიზეზი'} htmlFor="ea-rs" required={!given}>
          <input id="ea-rs" className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
        {wantStock && <section className="card card-pad stack" style={{ gap: 8 }}>
          <strong className="small">ჩამოწერა{stock.data?.location ? ` — ${stock.data.location.name}` : ''}</strong>
          {stock.data && !stock.data.location && <span className="small" style={{ color: 'var(--danger)' }}>ER-ის განყოფილებას ქვესაწყობი არ აქვს{ctx.settings.allow_no_stock ? ' — მიცემა ჩამოწერის გარეშე (დასაბუთებით)' : ''}</span>}
          {stock.data?.location && <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
            <Field label="საქონელი" htmlFor="ea-it" hint="ცარიელი — ავტომატურად (ერთი SKU ნაშთით)"><select id="ea-it" className="select" value={item} onChange={(e) => setItem(e.target.value)}>
              <option value="">— ავტომატურად —</option>{stock.data.items.map((i) => <option key={i.id} value={i.id}>{i.name} · ნაშთი {i.available} {i.unit_name}</option>)}</select></Field>
            <Field label="რაოდენობა (საბაზო)" htmlFor="ea-q"><input id="ea-q" className="input mono" type="number" min={0.001} step="any" value={qty} placeholder={String(stock.data.qty_suggest ?? 1)} onChange={(e) => setQty(e.target.value)} /></Field>
          </div>}
          {needWit && <div className="row" style={{ gap: 12 }}><span className="small muted">მოწმე (ნარკოტიკული / ფსიქოტროპული):</span>
            <input className="input" aria-label="მოწმის მომხმარებელი" placeholder="მომხმარებელი" value={wit.username} onChange={(e) => setWit({ ...wit, username: e.target.value })} />
            <input className="input" aria-label="მოწმის პაროლი" type="password" placeholder="პაროლი" value={wit.password} onChange={(e) => setWit({ ...wit, password: e.target.value })} /></div>}
          <ErrorBox error={stock.error} />
        </section>}
        {needDc && <div className="row" style={{ gap: 12 }}><span className="small muted">მეორე თანამშრომლის შემოწმება (მაღალი რისკი):</span>
          <input className="input" aria-label="შემმოწმებლის მომხმარებელი" placeholder="მომხმარებელი" value={dc.username} onChange={(e) => setDc({ ...dc, username: e.target.value })} />
          <input className="input" aria-label="შემმოწმებლის პაროლი" type="password" placeholder="პაროლი" value={dc.password} onChange={(e) => setDc({ ...dc, password: e.target.value })} /></div>}
        {checks && <><ChecksBox checks={checks} />
          <Field label="დასაბუთება" htmlFor="ea-ov" required><input id="ea-ov" className="input" value={ovr} onChange={(e) => setOvr(e.target.value)} /></Field></>}
        <ErrorBox error={err} />
      </div>
    </Modal>
  );
}
