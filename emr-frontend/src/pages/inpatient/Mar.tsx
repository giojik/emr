import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../api/client';
import { ErrorBox, Field, Loading, Modal, useToast } from '../../components/ui';
import { dayTitle, hhmm, localISO, shiftDay, todayISO, tsDate } from '../../lib/format';
import { TaskDialog } from './Nursing';

// ================================================================= ტიპები (0043 MAR)
type MStatus = 'due' | 'given' | 'partial' | 'held' | 'refused' | 'not_given' | 'missed' | 'cancelled';
type Outcome = 'given' | 'partial' | 'held' | 'refused' | 'not_given';
type InfAction = 'start' | 'rate' | 'bag' | 'pause' | 'stop';
export interface MarEntry {
  id: string; order_id: string; encounter_id: string; scheduled_at: string | null; source: 'schedule' | 'postponed' | 'prn' | 'infusion'; status: MStatus;
  documented_at: string | null; documented_by_name: string | null; dose_given: string | null; dose_unit: string | null; route_code: string | null; site: string | null;
  timing: 'on_time' | 'early' | 'late' | null; reason: string | null; postponed_to: string | null; infusion_action: InfAction | null; rate_ml_h: string | null;
  stock_doc_id: string | null; stock_doc_no: string | null; stock_item_name: string | null; qty_base: string | null; no_stock: boolean;
  witness_name: string | null; double_check_name: string | null; scanned_patient: boolean; scanned_med: boolean; override_reason: string | null;
  warnings: { code: string; message: string }[]; voided_at: string | null; voided_by_name: string | null; void_reason: string | null;
}
export interface MarOrder {
  id: string; encounter_id: string; category: 'medication' | 'diet' | 'nursing' | 'activity'; order_type: 'scheduled' | 'once' | 'prn' | 'continuous' | null;
  dose: string | null; dose_unit: string | null; route_code: string | null; route_name: string | null; frequency_name: string | null; status: string;
  verify_status: string; approval_status: string; prn_reason: string | null; prn_max_per_day: number | null; prn_min_interval_h: string | null; rate_ml_h: string | null;
  instructions: string | null; high_alert: boolean | null; controlled_class: string | null; generic_id: string | null; title: string;
  last_given_at: string | null; infusion_state: InfAction | null;
  nursing_task?: 'vitals' | 'fluid' | 'scale' | null; task_scale_code?: string | null;
}
interface Common { window_min: number; can_document: boolean; barcode: 'off' | 'optional' | 'required'; double_check: boolean }
interface StayMar extends Common { day: string; orders: MarOrder[]; entries: MarEntry[] }
interface DepPatient { encounter_id: string; adm_no: string; first_name: string; last_name: string; bed_code: string | null; allergies: number; on_leave: boolean; next_due_at: string | null; active_orders: number;
  entries: MarEntry[]; prn: MarOrder[]; infusions: MarOrder[] }
interface DepMar extends Common { patients: DepPatient[]; orders: MarOrder[] }
interface StockInfo { location: { id: string; name: string } | null; items: { id: string; name: string; code: string; unit_name: string; available: number }[]; qty_suggest: number | null }
interface Check { code: string; message: string }
type Ctx = Common & { adm_no?: string };

const UNIT_KA: Record<string, string> = { mg: 'მგ', mcg: 'მკგ', g: 'გ', IU: 'სე', ml: 'მლ', mmol: 'მმოლ', tab: 'ტაბ.', cap: 'კაფს.', amp: 'ამპ.', vial: 'ფლაკ.', drop: 'წვეთი' };
const OUT_KA: Record<Outcome, string> = { given: 'მიცემულია', partial: 'ნაწილობრივ', held: 'გადადებულია', refused: 'პაციენტმა უარი თქვა', not_given: 'არ მიეცა' };
const NUR_KA: Partial<Record<Outcome, string>> = { given: 'შესრულდა', not_given: 'არ შესრულდა' };
const INF_KA: Record<InfAction, string> = { start: 'დაწყება', rate: 'სიჩქარის შეცვლა', bag: 'ახალი ფლაკონი / პარკი', pause: 'შეჩერება', stop: 'დასრულება' };
const ST: Record<MStatus, [string, string]> = {
  due: ['', 'დაგეგმილი'], given: ['ok', 'მიცემულია'], partial: ['warn', 'ნაწილობრივ'], held: ['warn', 'გადადებულია'], refused: ['danger', 'უარი'],
  not_given: ['danger', 'არ მიეცა'], missed: ['danger', 'გამოტოვებული'], cancelled: ['', 'გაუქმდა'],
};
const n = (v: string | number | null | undefined) => (v === null || v === undefined || v === '' ? '' : String(Math.round(Number(v) * 1000) / 1000));
const unit = (u: string | null) => UNIT_KA[u ?? ''] ?? u ?? '';
const nowHM = () => hhmm(new Date().toISOString());

/** სლოტის მდგომარეობა ახლა: ვადაგადაცილებული / ახლა / მომავალი */
function slotState(e: MarEntry, win: number): 'overdue' | 'now' | 'later' | null {
  if (e.status !== 'due' || !e.scheduled_at) return null;
  const d = (Date.now() - new Date(e.scheduled_at).getTime()) / 60_000;
  return d > win ? 'overdue' : d >= -win ? 'now' : 'later';
}
function EntryChip({ e, win, onClick, showTime = true }: { e: MarEntry; win: number; onClick?: () => void; showTime?: boolean }) {
  const s = slotState(e, win);
  const [cls, label] = e.voided_at ? ['', 'გაუქმებული'] : s === 'overdue' ? ['danger', 'ვადაგადაცილ.'] : s === 'now' ? ['info', 'ახლა'] : ST[e.status];
  const t = e.scheduled_at ?? e.documented_at;
  const what = e.infusion_action ? INF_KA[e.infusion_action] : label;
  const title = [e.documented_at && `ჩაწერა: ${hhmm(e.documented_at)} — ${e.documented_by_name ?? ''}`, e.dose_given && `დოზა: ${n(e.dose_given)} ${unit(e.dose_unit)}`,
    e.reason && `მიზეზი: ${e.reason}`, e.void_reason && `გაუქმების მიზეზი: ${e.void_reason}`].filter(Boolean).join('\n');
  return (
    <button type="button" className={`chip ${cls}`} title={title} onClick={onClick} disabled={!onClick}
      style={{ cursor: onClick ? 'pointer' : 'default', textDecoration: e.voided_at || e.status === 'cancelled' ? 'line-through' : undefined, opacity: e.voided_at || e.status === 'cancelled' ? 0.6 : 1, border: s === 'now' ? '1px solid currentColor' : undefined }}>
      {showTime && t && <strong className="mono" style={{ marginRight: 4 }}>{hhmm(t)}</strong>}{what}
      {e.timing && e.timing !== 'on_time' && !e.voided_at && <span style={{ marginLeft: 4 }}>{e.timing === 'early' ? '↑' : '↓'}</span>}
    </button>
  );
}

function useInval() {
  const qc = useQueryClient();
  return () => { void qc.invalidateQueries({ queryKey: ['ipd-mar'] }); void qc.invalidateQueries({ queryKey: ['ipd-dep-mar'] }); void qc.invalidateQueries({ queryKey: ['ipd-orders'] }); };
}
type Dlg = null | { kind: 'doc'; order: MarOrder; entry: MarEntry | null } | { kind: 'view'; order: MarOrder | null; entry: MarEntry } | { kind: 'task'; order: MarOrder; entry: MarEntry };

// ================================================================= ჰოსპიტალიზაციის გვერდი: 24 სთ-ის ბადე
export default function MarPanel({ encounterId, admNo }: { encounterId: string; admNo?: string }) {
  const [day, setDay] = useState(todayISO());
  const q = useQuery({ queryKey: ['ipd-mar', encounterId, day], queryFn: () => api<StayMar>(`/inpatient/stays/${encounterId}/mar?day=${day}`), refetchInterval: 60_000 });
  const [dlg, setDlg] = useState<Dlg>(null); const toast = useToast();
  const d = q.data;
  const bands = [[0, 6], [6, 12], [12, 18], [18, 24]] as const;
  const hourOf = (iso: string) => Number(hhmm(iso).slice(0, 2));
  const isToday = day === todayISO();
  return (
    <section className="card" id="mar">
      {toast.node}
      <div className="card-head" style={{ flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0 }}>მედიკამენტების მიღების ფურცელი (MAR)</h2>
        <span className="grow" />
        <button className="btn sm" type="button" onClick={() => setDay(shiftDay(day, -1))} aria-label="წინა დღე">‹</button>
        <span className="small" style={{ minWidth: 150, textAlign: 'center' }}>{dayTitle(day)}</span>
        <button className="btn sm" type="button" onClick={() => setDay(shiftDay(day, 1))} aria-label="შემდეგი დღე">›</button>
        {!isToday && <button className="btn sm" type="button" onClick={() => setDay(todayISO())}>დღეს</button>}
      </div>
      {q.isLoading ? <div className="card-pad"><Loading /></div> : !d ? <div className="card-pad"><ErrorBox error={q.error} /></div> : (
        <div style={{ overflowX: 'auto' }}>
          {!d.orders.length ? <div className="card-pad muted">ამ დღეს მედიკამენტი / დავალება არ არის.</div> : (
            <table className="table" style={{ minWidth: 760 }}>
              <thead><tr><th style={{ width: '34%' }}>დანიშნულება</th>{bands.map(([a, b]) => <th key={a} className="small">{String(a).padStart(2, '0')}:00–{String(b).padStart(2, '0')}:00</th>)}</tr></thead>
              <tbody>{d.orders.map((o) => {
                const es = d.entries.filter((e) => e.order_id === o.id);
                const prnLike = o.order_type === 'prn' || o.order_type === 'continuous';
                return (
                  <tr key={o.id} style={{ opacity: o.status === 'active' ? 1 : 0.6 }}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{o.title}</div>
                      <div className="small muted">{orderLine(o)}</div>
                      <div className="row" style={{ gap: 4, flexWrap: 'wrap', marginTop: 2 }}>
                        {o.status === 'on_hold' && <span className="chip warn">შეჩერებული</span>}
                        {o.status !== 'active' && o.status !== 'on_hold' && <span className="chip">{o.status === 'completed' ? 'დასრულებული' : 'შეწყვეტილი'}</span>}
                        {o.high_alert && <span className="chip danger">მაღ. რისკი</span>}{o.controlled_class && <span className="chip danger">კონტროლირებადი</span>}
                        {o.verify_status === 'pending' && <span className="chip warn">დასადასტურებელი</span>}{o.verify_status === 'rejected' && <span className="chip danger">უარყოფილია</span>}
                        {o.infusion_state && <span className="chip info">ინფუზია: {INF_KA[o.infusion_state]}</span>}
                        {prnLike && d.can_document && o.status === 'active' && isToday && <button className="btn sm" type="button" onClick={() => setDlg({ kind: 'doc', order: o, entry: null })}>
                          {o.order_type === 'prn' ? '+ მიცემა' : '+ ჩანაწერი'}</button>}
                      </div>
                    </td>
                    {bands.map(([a, b]) => <td key={a} style={{ verticalAlign: 'top' }}><div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                      {es.filter((e) => { const h = hourOf(e.scheduled_at ?? e.documented_at!); return h >= a && h < b; }).map((e) =>
                        <EntryChip key={e.id} e={e} win={d.window_min}
                          onClick={(e.status === 'due' || e.status === 'missed') && !e.voided_at ? (d.can_document ? () => setDlg({ kind: 'doc', order: o, entry: e }) : undefined) : () => setDlg({ kind: 'view', order: o, entry: e })} />)}
                    </div></td>)}
                  </tr>);
              })}</tbody>
            </table>)}
          <div className="card-pad small muted" style={{ paddingTop: 0 }}>ფანჯარა ±{d.window_min} წთ · ↑ ადრე · ↓ დაგვიანებით · დააჭირეთ დოზას ჩასაწერად / დეტალებისთვის.</div>
        </div>)}
      {dlg?.kind === 'doc' && d && <DocumentDialog order={dlg.order} entry={dlg.entry} ctx={{ ...d, adm_no: admNo }} onClose={() => setDlg(null)} onDone={(m) => toast.show(m)}
        onTask={dlg.entry ? () => setDlg({ kind: 'task', order: dlg.order, entry: dlg.entry! }) : undefined} />}
      {dlg?.kind === 'task' && <TaskDialog encounterId={encounterId} task={dlg.order.nursing_task!} scaleCode={dlg.order.task_scale_code} marEntryId={dlg.entry.id} onClose={() => setDlg(null)} onDone={(m) => toast.show(m)} />}
      {dlg?.kind === 'view' && d && <EntryDialog order={dlg.order} entry={dlg.entry} canVoid={d.can_document} onClose={() => setDlg(null)} onDone={(m) => toast.show(m)} />}
    </section>
  );
}

function orderLine(o: MarOrder) {
  if (o.category !== 'medication') return o.frequency_name ?? '';
  const dose = o.dose ? `${n(o.dose)} ${unit(o.dose_unit)}` : null;
  const how = o.order_type === 'scheduled' ? o.frequency_name : o.order_type === 'once' ? 'ერთჯერადად' : o.order_type === 'prn' ? `PRN: ${o.prn_reason ?? ''}` : `${n(o.rate_ml_h)} მლ/სთ`;
  return [dose, o.route_name ?? o.route_code, how].filter(Boolean).join(' · ');
}

// ================================================================= ჩაწერის ფორმა
function DocumentDialog({ order: o, entry, ctx, onClose, onDone, onTask }: { order: MarOrder; entry: MarEntry | null; ctx: Ctx; onClose: () => void; onDone: (m: string) => void; onTask?: () => void }) {
  const inval = useInval();
  const med = o.category === 'medication'; const inf = o.order_type === 'continuous';
  const [outcome, setOutcome] = useState<Outcome>('given');
  const [at, setAt] = useState(nowHM());
  const [dose, setDose] = useState(o.dose ? n(o.dose) : '');
  const [site, setSite] = useState(''); const [reason, setReason] = useState(''); const [postpone, setPostpone] = useState('');
  const [action, setAction] = useState<InfAction>(o.infusion_state && o.infusion_state !== 'stop' ? 'bag' : 'start');
  const [rate, setRate] = useState(o.rate_ml_h ? n(o.rate_ml_h) : '');
  const [item, setItem] = useState(''); const [qty, setQty] = useState('');
  const [scanP, setScanP] = useState(''); const [scanM, setScanM] = useState('');
  const [dc, setDc] = useState({ username: '', password: '' }); const [wit, setWit] = useState({ username: '', password: '' });
  const [checks, setChecks] = useState<Check[] | null>(null); const [ovr, setOvr] = useState('');
  const given = outcome === 'given' || outcome === 'partial';
  const stockNeeded = med && !!o.generic_id && given && (!inf || action === 'start' || action === 'bag');
  const stock = useQuery({ queryKey: ['ipd-mar-stock', o.id], queryFn: () => api<StockInfo>(`/inpatient/orders/${o.id}/stock`), enabled: stockNeeded });
  const needDc = med && given && !!o.high_alert && ctx.double_check;
  const needWit = stockNeeded && !!o.controlled_class;
  const showScan = med && !!o.generic_id && ctx.barcode !== 'off';
  const today = todayISO();
  const m = useMutation({
    mutationFn: () => {
      const b: Record<string, unknown> = { outcome, documented_at: new Date(localISO(today, at)).toISOString() };
      if (given && med && !inf && dose) b.dose = Number(dose);
      if (site.trim()) b.site = site.trim();
      if (reason.trim()) b.reason = reason.trim();
      if (outcome === 'held' && postpone) b.postponed_to = new Date(localISO(postpone < at ? shiftDay(today, 1) : today, postpone)).toISOString();
      if (inf) { b.infusion_action = action; if (rate) b.rate_ml_h = Number(rate); }
      if (stockNeeded && item) b.item_id = item;
      if (stockNeeded && qty) b.qty_base = Number(qty);
      if (showScan && scanP.trim()) b.scanned_patient = scanP.trim();
      if (showScan && scanM.trim()) b.scanned_barcode = scanM.trim();
      if (needDc) b.double_check = dc;
      if (needWit) b.witness = wit;
      if (checks && ovr.trim()) b.override_reason = ovr.trim();
      return entry ? api<MarEntry>(`/inpatient/mar/${entry.id}/document`, { body: b }) : api<MarEntry>(`/inpatient/orders/${o.id}/administer`, { body: b });
    },
    onSuccess: (r) => { onDone(`${o.title}: ${inf ? INF_KA[action] : (med ? OUT_KA : NUR_KA)[r.status as Outcome] ?? r.status}`); inval(); onClose(); },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'MAR_CHECKS') setChecks(e.body?.checks as Check[]);
      if (e instanceof ApiError && e.code === 'MAR_ITEM_REQUIRED') void stock.refetch();
    },
  });
  const err = m.error instanceof ApiError && m.error.code === 'MAR_CHECKS' ? null : m.error;
  const outs = (med ? (Object.keys(OUT_KA) as Outcome[]) : (['given', 'not_given'] as Outcome[]));
  const st = stock.data;
  const ready = (given || reason.trim().length >= 2) && (outcome !== 'partial' || (!!dose && reason.trim().length >= 2)) && (!given || !med || inf || !!dose)
    && (!needDc || (dc.username && dc.password)) && (!needWit || (wit.username && wit.password)) && (!checks || ovr.trim().length >= 5)
    && (ctx.barcode !== 'required' || !showScan || !given || (scanP.trim() && scanM.trim())) && (!inf || action !== 'rate' || !!rate);
  const sched = entry?.scheduled_at;
  return (
    <Modal title={`${o.title}${sched ? ` — ${hhmm(sched)}` : ''}`} onClose={onClose} width={680}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button>
        {o.nursing_task && outcome === 'given' && onTask ? <button className="btn primary" type="button" onClick={onTask}>ფორმის გახსნა</button>
          : <button className="btn primary" type="button" disabled={!ready || m.isPending} onClick={() => m.mutate()}>{checks ? 'დასაბუთებით შენახვა' : 'შენახვა'}</button>}</>}>
      <div className="stack" style={{ gap: 12 }}>
        {o.nursing_task && outcome === 'given' && <div className="alert info">დავალება სრულდება {o.nursing_task === 'vitals' ? 'ვიტალების' : o.nursing_task === 'fluid' ? 'სითხის ბალანსის' : 'შკალის'} ფორმის შევსებით — „ფორმის გახსნა“.</div>}
        <div className="small muted">{orderLine(o)}{o.instructions ? ` · ${o.instructions}` : ''}{o.last_given_at ? ` · ბოლო: ${tsDate(o.last_given_at)} ${hhmm(o.last_given_at)}` : ''}</div>
        <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
          {o.high_alert && <span className="chip danger">მაღალი რისკი — მეორე ექთნის დადასტურება</span>}
          {o.controlled_class && <span className="chip danger">კონტროლირებადი — მოწმე</span>}
          {o.verify_status === 'pending' && <span className="chip warn">დანიშნულება ჯერ დადასტურებული არ არის</span>}
        </div>
        {inf ? <div className="seg" role="group" aria-label="მოქმედება" style={{ width: 'max-content', flexWrap: 'wrap' }}>
          {(Object.keys(INF_KA) as InfAction[]).map((a) => <button key={a} type="button" aria-pressed={action === a} onClick={() => setAction(a)}>{INF_KA[a]}</button>)}</div>
          : <div className="seg" role="group" aria-label="შედეგი" style={{ width: 'max-content', flexWrap: 'wrap' }}>
            {outs.map((k) => <button key={k} type="button" aria-pressed={outcome === k} onClick={() => { setOutcome(k); setChecks(null); }}>{(med ? OUT_KA : NUR_KA)[k]}</button>)}</div>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
          <Field label="დრო" htmlFor="mar-at" hint={sched ? `დაგეგმილი ${hhmm(sched)}, ±${ctx.window_min} წთ` : undefined}>
            <input id="mar-at" className="input" type="time" value={at} onChange={(e) => { setAt(e.target.value); setChecks(null); }} /></Field>
          {med && !inf && given && <Field label={`დოზა (${unit(o.dose_unit)})`} htmlFor="mar-d" required><input id="mar-d" className="input mono" type="number" min={0} step="any" value={dose} onChange={(e) => setDose(e.target.value)} /></Field>}
          {inf && (action === 'start' || action === 'rate') && <Field label="სიჩქარე (მლ/სთ)" htmlFor="mar-r" required={action === 'rate'}><input id="mar-r" className="input mono" type="number" min={0.1} step="any" value={rate} onChange={(e) => setRate(e.target.value)} /></Field>}
          {med && given && <Field label="ადგილი" htmlFor="mar-s"><input id="mar-s" className="input" value={site} onChange={(e) => setSite(e.target.value)} placeholder={o.route_code === 'IM' || o.route_code === 'SC' ? 'მაგ. მარცხენა მხარი' : ''} /></Field>}
          {outcome === 'held' && <Field label="გადადება (დრო)" htmlFor="mar-p" hint="ახალი სლოტი; ცარიელი — გარეშე"><input id="mar-p" className="input" type="time" value={postpone} onChange={(e) => setPostpone(e.target.value)} /></Field>}
        </div>
        {(!given || outcome === 'partial') && <Field label="მიზეზი" htmlFor="mar-re" required>
          <textarea id="mar-re" className="textarea" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={outcome === 'refused' ? 'რა თქვა პაციენტმა' : 'მაგ. NPO, გამოკვლევაზეა, წნევა დაბალია'} /></Field>}

        {showScan && given && <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="სამაჯური (სკანირება)" htmlFor="mar-sp" required={ctx.barcode === 'required'} hint={ctx.adm_no ? `მოსალოდნელი: ${ctx.adm_no}` : undefined}>
            <input id="mar-sp" className="input mono" value={scanP} onChange={(e) => setScanP(e.target.value)} autoComplete="off" /></Field>
          <Field label="მედიკამენტის შტრიხკოდი" htmlFor="mar-sm" required={ctx.barcode === 'required'} hint="EAN / GS1 DataMatrix — SKU და ლოტი ავტომატურად">
            <input id="mar-sm" className="input mono" value={scanM} onChange={(e) => setScanM(e.target.value)} autoComplete="off" /></Field>
        </div>}

        {stockNeeded && <div className="stack" style={{ gap: 6 }}>
          <span className="label">ჩამოწერა {st?.location ? `— ${st.location.name}` : ''}</span>
          {stock.isLoading ? <Loading /> : !st?.location ? <span className="small muted">განყოფილებას ქვესაწყობი არ აქვს.</span> : !st.items.length ? <span className="small muted">ამ ჯენერიკის SKU კატალოგში არ არის.</span> : (
            <div className="row" style={{ gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <Field label="საქონელი" htmlFor="mar-it"><select id="mar-it" className="select" value={item} onChange={(e) => setItem(e.target.value)} disabled={!!scanM.trim()}>
                <option value="">{st.items.filter((i) => i.available > 0).length === 1 ? 'ავტომატურად (ერთადერთი ნაშთით)' : '— აირჩიეთ —'}</option>
                {st.items.map((i) => <option key={i.id} value={i.id} disabled={i.available <= 0}>{i.name} — ნაშთი {i.available} {i.unit_name}</option>)}</select></Field>
              <Field label="რაოდენობა" htmlFor="mar-q" hint={st.qty_suggest ? `დოზით: ${st.qty_suggest}` : undefined}><input id="mar-q" className="input mono" style={{ maxWidth: 110 }} type="number" min={0.001} step="any" value={qty} placeholder={st.qty_suggest ? String(st.qty_suggest) : ''} onChange={(e) => setQty(e.target.value)} /></Field>
            </div>)}
        </div>}

        {needDc && <Creds label="მეორე ექთანი (high-alert)" v={dc} set={setDc} id="dc" />}
        {needWit && <Creds label="მოწმე (კონტროლირებადი)" v={wit} set={setWit} id="wt" />}

        {checks && <div className="alert warn stack" style={{ gap: 6 }}>
          <strong>საჭიროა დასაბუთება</strong>
          <ul style={{ margin: 0, paddingLeft: 18 }}>{checks.map((c) => <li key={c.code}>{c.message}</li>)}</ul>
          <textarea className="textarea" rows={2} aria-label="დასაბუთება" value={ovr} onChange={(e) => setOvr(e.target.value)} placeholder="მიზეზი (მინ. 5 სიმბოლო)" />
        </div>}
        <ErrorBox error={err} />
      </div>
    </Modal>
  );
}
function Creds({ label, v, set, id }: { label: string; v: { username: string; password: string }; set: (x: { username: string; password: string }) => void; id: string }) {
  return <div className="stack" style={{ gap: 6 }}><span className="label">{label}</span>
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
      <Field label="მომხმარებელი" htmlFor={`${id}-u`}><input id={`${id}-u`} className="input" autoComplete="off" value={v.username} onChange={(e) => set({ ...v, username: e.target.value })} /></Field>
      <Field label="პაროლი" htmlFor={`${id}-p`}><input id={`${id}-p`} className="input" type="password" autoComplete="new-password" value={v.password} onChange={(e) => set({ ...v, password: e.target.value })} /></Field>
    </div></div>;
}

// ================================================================= ჩანაწერის დეტალები / გაუქმება
function EntryDialog({ order, entry: e, canVoid, onClose, onDone }: { order: MarOrder | null; entry: MarEntry; canVoid: boolean; onClose: () => void; onDone: (m: string) => void }) {
  const inval = useInval(); const [reason, setReason] = useState(''); const [voiding, setVoiding] = useState(false);
  const m = useMutation({ mutationFn: () => api(`/inpatient/mar/${e.id}/void`, { body: { reason: reason.trim() } }), onSuccess: () => { onDone('ჩანაწერი გაუქმდა'); inval(); onClose(); } });
  const rows: [string, string | null | false][] = [
    ['დაგეგმილი', e.scheduled_at && `${tsDate(e.scheduled_at)} ${hhmm(e.scheduled_at)}`],
    ['სტატუსი', e.infusion_action ? INF_KA[e.infusion_action] : ST[e.status][1]],
    ['დრო', e.documented_at && `${tsDate(e.documented_at)} ${hhmm(e.documented_at)}${e.timing === 'early' ? ' (ადრე)' : e.timing === 'late' ? ' (დაგვიანებით)' : ''}`],
    ['ჩაწერა', e.documented_by_name], ['დოზა', e.dose_given && `${n(e.dose_given)} ${unit(e.dose_unit)}${e.route_code ? ` · ${e.route_code}` : ''}${e.site ? ` · ${e.site}` : ''}`],
    ['სიჩქარე', e.rate_ml_h && `${n(e.rate_ml_h)} მლ/სთ`], ['მიზეზი', e.reason], ['გადადებულია', e.postponed_to && hhmm(e.postponed_to)],
    ['ჩამოწერა', e.stock_doc_no ? `${e.stock_doc_no} · ${e.stock_item_name ?? ''} × ${n(e.qty_base)}` : e.no_stock ? 'ნაშთის გარეშე (მიზეზით)' : null],
    ['მოწმე', e.witness_name], ['მეორე ექთანი', e.double_check_name],
    ['სკანირება', (e.scanned_patient || e.scanned_med) && [e.scanned_patient && 'სამაჯური', e.scanned_med && 'მედიკამენტი'].filter(Boolean).join(', ')],
    ['გაფრთხილებები', e.warnings?.length ? e.warnings.map((w) => w.message).join('; ') : null], ['დასაბუთება', e.override_reason],
    ['გაუქმდა', e.voided_at && `${tsDate(e.voided_at)} ${hhmm(e.voided_at)} — ${e.voided_by_name ?? ''}: ${e.void_reason ?? ''}`],
  ];
  const can = canVoid && !e.voided_at && !['due', 'missed', 'cancelled'].includes(e.status);
  return (
    <Modal title={order?.title ?? 'MAR ჩანაწერი'} onClose={onClose} width={560}
      footer={<><button className="btn" type="button" onClick={onClose}>დახურვა</button>
        {can && !voiding && <button className="btn danger" type="button" onClick={() => setVoiding(true)}>გაუქმება (შეცდომა)</button>}
        {voiding && <button className="btn danger" type="button" disabled={reason.trim().length < 3 || m.isPending} onClick={() => m.mutate()}>გაუქმების დადასტურება</button>}</>}>
      <div className="stack" style={{ gap: 8 }}>
        <table className="table"><tbody>{rows.filter(([, v]) => v).map(([k, v]) => <tr key={k}><td className="muted" style={{ width: 140 }}>{k}</td><td>{v}</td></tr>)}</tbody></table>
        {voiding && <Field label="გაუქმების მიზეზი" htmlFor="mar-vr" required hint="ჩამოწერილი მარაგი დაბრუნდება; დაგეგმილი დოზა თავიდან გაიხსნება">
          <textarea id="mar-vr" className="textarea" rows={2} value={reason} onChange={(ev) => setReason(ev.target.value)} /></Field>}
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}

// ================================================================= განყოფილება: ექთნის ეკრანი
export function DepartmentMar({ departmentId }: { departmentId: string }) {
  const [hours, setHours] = useState(4);
  const q = useQuery({ queryKey: ['ipd-dep-mar', departmentId, hours], queryFn: () => api<DepMar>(`/inpatient/departments/${departmentId}/mar?hours=${hours}`), refetchInterval: 60_000 });
  const [dlg, setDlg] = useState<(Dlg & { adm?: string }) | null>(null); const toast = useToast();
  const [onlyDue, setOnlyDue] = useState(false);
  if (q.isLoading) return <Loading />;
  if (!q.data) return <ErrorBox error={q.error} />;
  const d = q.data; const byId = new Map(d.orders.map((o) => [o.id, o]));
  const counts = d.patients.flatMap((p) => p.entries).reduce((a, e) => { const s = e.status === 'missed' ? 'overdue' : slotState(e, d.window_min); if (s) a[s] = (a[s] ?? 0) + 1; return a; }, {} as Record<string, number>);
  const pts = d.patients.filter((p) => !onlyDue || p.entries.some((e) => e.status === 'missed' || slotState(e, d.window_min) !== 'later'));
  return (
    <div className="stack" style={{ gap: 12 }}>
      {toast.node}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <span className="chip danger">ვადაგადაცილებული / გამოტოვებული: {counts.overdue ?? 0}</span>
        <span className="chip info">ახლა: {counts.now ?? 0}</span>
        <span className="chip">მომდევნო: {counts.later ?? 0}</span>
        <span className="grow" />
        <label className="row small"><input type="checkbox" checked={onlyDue} onChange={(e) => setOnlyDue(e.target.checked)} /> მხოლოდ ახლა / ვადაგადაცილებული</label>
        <select className="select" style={{ width: 'auto', height: 36 }} aria-label="პერიოდი" value={hours} onChange={(e) => setHours(Number(e.target.value))}>
          {[2, 4, 8, 12, 24].map((h) => <option key={h} value={h}>მომდევნო {h} სთ</option>)}</select>
      </div>
      {!d.can_document && <div className="alert info">ნახვის რეჟიმი — ჩაწერს ამ განყოფილების ექთანი / ექიმი.</div>}
      {!pts.length && <div className="card card-pad muted">{d.patients.length ? 'ამ პერიოდში დოზა არ არის.' : 'განყოფილებაში აქტიური პაციენტი არ არის.'}</div>}
      {pts.map((p) => (
        <section key={p.encounter_id} className="card">
          <div className="card-head" style={{ gap: 8, flexWrap: 'wrap' }}>
            {p.bed_code && <span className="chip mono">{p.bed_code}</span>}
            <Link to={`/inpatient/stay/${p.encounter_id}#mar`} style={{ fontWeight: 600 }}>{p.last_name} {p.first_name}</Link>
            <span className="small muted mono">{p.adm_no}</span>
            {p.allergies > 0 && <span className="chip danger">ალერგია ({p.allergies})</span>}
            {p.on_leave && <span className="chip warn">დროებით გასულია</span>}
          </div>
          {!p.entries.length && !p.prn.length && !p.infusions.length ? (
            <div className="card-pad small muted">
              {!p.active_orders ? 'აქტიური დანიშნულება არ არის.'
                : p.next_due_at ? `მომდევნო ${hours} სთ-ში დოზა / დავალება არ არის — შემდეგი: ${tsDate(p.next_due_at)} ${hhmm(p.next_due_at)}.`
                : `მომდევნო ${hours} სთ-ში დოზა / დავალება არ არის (დიეტა / რეჟიმი ან სიხშირის გარეშე დავალება).`}
              {' '}<Link to={`/inpatient/stay/${p.encounter_id}#mar`}>MAR ბადე</Link>
            </div>) : <table className="table"><tbody>
            {p.entries.map((e) => { const o = byId.get(e.order_id) ?? null; return (
              <tr key={e.id}>
                <td style={{ width: 70 }} className="mono">{e.scheduled_at && hhmm(e.scheduled_at)}</td>
                <td>{o?.title ?? '—'}<div className="small muted">{o ? orderLine(o) : ''}</div></td>
                <td style={{ width: 140 }}><EntryChip e={e} win={d.window_min} showTime={false} /></td>
                <td style={{ width: 110, textAlign: 'right' }}>{d.can_document && o && o.status === 'active' &&
                  <button className="btn sm primary" type="button" onClick={() => setDlg({ kind: 'doc', order: o, entry: e, adm: p.adm_no })}>ჩაწერა</button>}</td>
              </tr>); })}
            {[...p.prn, ...p.infusions].map((o) => (
              <tr key={o.id}>
                <td className="small muted">{o.order_type === 'prn' ? 'PRN' : 'ინფ.'}</td>
                <td>{o.title}<div className="small muted">{orderLine(o)}{o.last_given_at ? ` · ბოლო ${hhmm(o.last_given_at)}` : ''}</div></td>
                <td>{o.infusion_state && <span className="chip info">{INF_KA[o.infusion_state]}</span>}</td>
                <td style={{ textAlign: 'right' }}>{d.can_document && <button className="btn sm" type="button" onClick={() => setDlg({ kind: 'doc', order: o, entry: null, adm: p.adm_no })}>{o.order_type === 'prn' ? 'მიცემა' : 'ჩანაწერი'}</button>}</td>
              </tr>))}
          </tbody></table>}
        </section>))}
      {dlg?.kind === 'doc' && <DocumentDialog order={dlg.order} entry={dlg.entry} ctx={{ ...d, adm_no: dlg.adm }} onClose={() => setDlg(null)} onDone={(m) => toast.show(m)}
        onTask={dlg.entry ? () => setDlg({ kind: 'task', order: dlg.order, entry: dlg.entry!, adm: dlg.adm }) : undefined} />}
      {dlg?.kind === 'task' && <TaskDialog encounterId={dlg.order.encounter_id} task={dlg.order.nursing_task!} scaleCode={dlg.order.task_scale_code} marEntryId={dlg.entry.id} onClose={() => setDlg(null)} onDone={(m) => toast.show(m)} />}
    </div>
  );
}
