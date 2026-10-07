import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Field, Loading, Modal, useToast } from '../../components/ui';
import { hhmm, localISO, shiftDay, todayISO, tsDate } from '../../lib/format';

// ================================================================= ტიპები (0044)
type Level = 'low' | 'low_red' | 'medium' | 'high';
export interface Vitals {
  id: string; recorded_at: string; systolic_bp: number | null; diastolic_bp: number | null; heart_rate: number | null; respiratory_rate: number | null; temperature: string | null;
  spo2: number | null; spo2_scale: number; o2_supplement: boolean | null; o2_flow: string | null; consciousness: string | null; pain: number | null; glucose: string | null;
  weight_kg: string | null; notes: string | null; news2: number | null; news2_level: Level | null; news2_parts: Record<string, number> | null; taken_by_name: string | null;
  voided_at: string | null; voided_by_name: string | null; void_reason: string | null;
}
interface FluidEntry { id: string; direction: 'in' | 'out'; category: string; volume_ml: string; recorded_at: string; note: string | null; created_by_name: string; day: string; voided_at: string | null; void_reason: string | null }
interface FluidData { day_start: string; totals: { day: string; in: number; out: number; balance: number; by: Record<string, number> }[]; entries: FluidEntry[];
  infusions: { id: string; order_id: string; infusion_action: string; rate_ml_h: string | null; documented_at: string; volume_ml: string | null; title: string }[] }
export interface ScaleDef { code: string; name: string; description: string | null; items: { key: string; label: string; options: { label: string; points: number }[] }[];
  bands: { min: number; max: number; label: string; level: string }[]; required: boolean; reassess_hours: number | null; risk_label: string | null }
interface Assessment { id: string; scale_code: string; scale_name: string; answers: Record<string, number>; score: number; band_label: string | null; level: string | null; note: string | null;
  assessed_at: string; assessed_by_name: string; voided_at: string | null; void_reason: string | null }
interface Line { id: string; kind: string; kind_ka: string; site: string | null; size: string | null; details: string | null; inserted_at: string; inserted_by_name: string | null; inserted_where: string | null;
  removed_at: string | null; removed_by_name: string | null; removal_reason: string | null; hours: number; alert_hours: number; voided_at: string | null }
interface Sbar { s?: string; b?: string; a?: string; r?: string }
export interface Summary {
  shift_start: string; vitals: Partial<Vitals> | null; mar: { missed: number; given: number; due_next: number; refused: number };
  fluid: { in: number; out: number; balance: number }; lines: { kind: string; kind_ka: string; site: string | null; days: number }[]; risks: { code: string; label: string; level: string; score: number }[];
}
interface Note { id: string; kind: 'note' | 'handover'; text: string | null; sbar: Sbar | null; summary: Summary | null; shift_start: string | null; author_id: string; author_name: string; created_at: string;
  ack_at: string | null; ack_by_name: string | null; voided_at: string | null; void_reason: string | null }
interface NursingData {
  can_write: boolean; age: number; news2_applicable: boolean; settings: { news2_alert: number; news2_urgent: number; glucose_low: number; glucose_high: number; line_alert_hours: Record<string, number> };
  vitals: Vitals[]; fluid: FluidData; scale_defs: ScaleDef[]; scales: Assessment[]; scales_due: { code: string; name: string; due_at: string; overdue: boolean; last_at: string | null }[];
  lines: Line[]; notes: Note[]; shift_start: string;
}

export const NEWS2_KA: Record<Level, [string, string]> = { low: ['ok', 'დაბალი'], low_red: ['warn', 'დაბალი — ერთი პარამეტრი 3'], medium: ['warn', 'საშუალო'], high: ['danger', 'მაღალი'] };
const ACVPU: Record<string, string> = { A: 'A — ფხიზელი', C: 'C — ახალი დაბნეულობა', V: 'V — რეაგირებს ხმაზე', P: 'P — რეაგირებს ტკივილზე', U: 'U — არ რეაგირებს' };
const FLUID_KA: Record<string, string> = { po: 'პერორალური', iv: 'ინტრავენური', tube: 'ზონდით', blood: 'სისხლი / პრეპარატები', other_in: 'სხვა (მიღება)',
  urine: 'შარდი', drain: 'დრენაჟი', vomit: 'ღებინება', stool: 'განავალი', other_out: 'სხვა (გამოყოფა)' };
const IN_CATS = ['po', 'iv', 'tube', 'blood', 'other_in']; const OUT_CATS = ['urine', 'drain', 'vomit', 'stool', 'other_out'];
const LINE_KINDS: Record<string, string> = { pvc: 'პერიფერიული ვენური კათეტერი', cvc: 'ცენტრალური ვენური კათეტერი', picc: 'PICC', arterial: 'არტერიული კათეტერი', urinary: 'შარდის კათეტერი',
  ng_tube: 'ნაზოგასტრული ზონდი', drain: 'დრენაჟი', trach: 'ტრაქეოსტომა', other: 'სხვა' };
const LEVEL_CHIP: Record<string, string> = { none: 'ok', low: 'ok', medium: 'warn', high: 'danger' };
const dt = (iso: string) => `${tsDate(iso)} ${hhmm(iso)}`;
const n1 = (v: string | number | null | undefined) => (v === null || v === undefined || v === '' ? '' : String(Math.round(Number(v) * 10) / 10));
const ml = (v: number) => `${v > 0 ? '+' : ''}${Math.round(v)}`;

/** NEWS2 — იგივე წესები, რაც სერვერზე (ფორმაში წინასწარი ჩვენებისთვის) */
export function news2(v: { respiratory_rate?: number; spo2?: number; spo2_scale?: number; o2_supplement?: boolean; systolic_bp?: number; heart_rate?: number; consciousness?: string; temperature?: number }) {
  const { respiratory_rate: rr, spo2, systolic_bp: sbp, heart_rate: hr, consciousness: c, temperature: t } = v;
  if (rr == null || spo2 == null || v.o2_supplement == null || sbp == null || hr == null || !c || t == null) return null;
  const band = (x: number, rules: [number, number][]) => { for (const [mx, p] of rules) if (x <= mx) return p; return 0; };
  const o2 = !!v.o2_supplement;
  const parts: Record<string, number> = {
    rr: band(rr, [[8, 3], [11, 1], [20, 0], [24, 2], [Infinity, 3]]),
    spo2: (v.spo2_scale ?? 1) === 2 ? (spo2 <= 83 ? 3 : spo2 <= 85 ? 2 : spo2 <= 87 ? 1 : spo2 <= 92 ? 0 : !o2 ? 0 : spo2 <= 94 ? 1 : spo2 <= 96 ? 2 : 3) : band(spo2, [[91, 3], [93, 2], [95, 1], [Infinity, 0]]),
    o2: o2 ? 2 : 0, sbp: band(sbp, [[90, 3], [100, 2], [110, 1], [219, 0], [Infinity, 3]]), hr: band(hr, [[40, 3], [50, 1], [90, 0], [110, 1], [130, 2], [Infinity, 3]]),
    acvpu: c === 'A' ? 0 : 3, temp: band(Math.round(t * 10) / 10, [[35.0, 3], [36.0, 1], [38.0, 0], [39.0, 1], [Infinity, 2]]),
  };
  const score = Object.values(parts).reduce((a, b) => a + b, 0);
  const level: Level = score >= 7 ? 'high' : score >= 5 ? 'medium' : Object.values(parts).some((p) => p === 3) ? 'low_red' : 'low';
  return { score, level, parts };
}
export const News2Chip = ({ score, level }: { score: number | null | undefined; level: Level | null | undefined }) =>
  score == null || !level ? null : <span className={`chip ${NEWS2_KA[level][0]}`} title={`NEWS2: ${NEWS2_KA[level][1]}`}>{level === 'high' || level === 'medium' || level === 'low_red' ? '⚠ ' : ''}NEWS2 {score}</span>;

function useInval(encounterId?: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['ipd-nursing'] }); void qc.invalidateQueries({ queryKey: ['ipd-mar'] }); void qc.invalidateQueries({ queryKey: ['ipd-dep-mar'] });
    void qc.invalidateQueries({ queryKey: ['ipd-handover'] }); if (encounterId) void qc.invalidateQueries({ queryKey: ['ipd-stay', encounterId] });
  };
}
const nowHM = () => hhmm(new Date().toISOString());
/** HH:MM დღეს (ან გუშინ, თუ მომავალშია) → ISO */
const atISO = (t: string) => { const today = todayISO(); const iso = new Date(localISO(today, t)); return (iso.getTime() > Date.now() + 5 * 60_000 ? new Date(localISO(shiftDay(today, -1), t)) : iso).toISOString(); };

// ================================================================= პანელი (ჰოსპიტალიზაციის გვერდი)
type Tab = 'vitals' | 'fluid' | 'scales' | 'lines' | 'notes';
export default function NursingPanel({ encounterId }: { encounterId: string }) {
  const [tab, setTab] = useState<Tab>('vitals'); const [days, setDays] = useState(3);
  const q = useQuery({ queryKey: ['ipd-nursing', encounterId, days], queryFn: () => api<NursingData>(`/inpatient/stays/${encounterId}/nursing`, { query: { days } }), refetchInterval: 120_000 });
  const toast = useToast();
  const d = q.data;
  const overdue = d?.scales_due.filter((x) => x.overdue).length ?? 0;
  const openLines = d?.lines.filter((l) => !l.removed_at && !l.voided_at) ?? [];
  const lastV = d?.vitals.find((v) => !v.voided_at && v.news2 != null);
  const tabs: [Tab, ReactNode][] = [['vitals', <>ვიტალური ნიშნები {lastV && <News2Chip score={lastV.news2} level={lastV.news2_level} />}</>], ['fluid', 'სითხის ბალანსი'],
    ['scales', <>შკალები {overdue > 0 && <span className="chip danger">{overdue}</span>}</>], ['lines', <>ხაზები / დრენაჟები {openLines.length > 0 && <span className="chip">{openLines.length}</span>}</>],
    ['notes', 'ჩანაწერები / ცვლა']];
  return (
    <section className="card" id="nursing">
      {toast.node}
      <div className="card-head" style={{ flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0 }}>საექთნო დოკუმენტაცია</h2>
        <span className="grow" />
        <select className="select" style={{ width: 'auto', height: 34 }} aria-label="პერიოდი" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {[1, 3, 7, 14].map((x) => <option key={x} value={x}>{x} დღე</option>)}</select>
      </div>
      <div className="row" style={{ gap: 0, borderBottom: '1px solid var(--line)', padding: '0 12px', flexWrap: 'wrap' }}>
        {tabs.map(([k, l]) => <button key={k} type="button" className={`admin-tab${tab === k ? ' active' : ''}`} style={{ background: 'none', border: 0, cursor: 'pointer' }} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      <div className="card-pad">
        {q.isLoading ? <Loading /> : !d ? <ErrorBox error={q.error} /> : tab === 'vitals' ? <VitalsTab d={d} encounterId={encounterId} toast={toast.show} />
          : tab === 'fluid' ? <FluidTab d={d} encounterId={encounterId} toast={toast.show} />
          : tab === 'scales' ? <ScalesTab d={d} encounterId={encounterId} toast={toast.show} />
          : tab === 'lines' ? <LinesTab d={d} encounterId={encounterId} toast={toast.show} />
          : <NotesTab d={d} encounterId={encounterId} toast={toast.show} />}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- ვიტალები
function flag(v: Vitals, k: string, d: NursingData): string {
  const p = v.news2_parts?.[k];
  if (p === undefined) {
    if (k === 'glucose' && v.glucose) { const g = Number(v.glucose); return g < d.settings.glucose_low || g > d.settings.glucose_high ? 'danger' : ''; }
    if (k === 'pain' && v.pain != null) return v.pain >= 7 ? 'danger' : v.pain >= 4 ? 'warn' : '';
    return '';
  }
  return p >= 3 ? 'danger' : p >= 1 ? 'warn' : '';
}
const Cell = ({ c, children }: { c: string; children: ReactNode }) => <td className="mono" style={{ textAlign: 'center', color: c === 'danger' ? 'var(--danger)' : c === 'warn' ? 'var(--warn-ink)' : undefined, fontWeight: c ? 600 : undefined,
  background: c === 'danger' ? 'var(--danger-weak)' : c === 'warn' ? 'var(--warn-weak)' : undefined }}>{children}</td>;

function VitalsTab({ d, encounterId, toast }: { d: NursingData; encounterId: string; toast: (m: string) => void }) {
  const [add, setAdd] = useState(false); const [voidV, setVoidV] = useState<Vitals | null>(null); const [showVoid, setShowVoid] = useState(false);
  const rows = d.vitals.filter((v) => showVoid || !v.voided_at);
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="row" style={{ gap: 8 }}>
        {d.can_write && <button className="btn primary sm" type="button" onClick={() => setAdd(true)}>+ ვიტალები</button>}
        {!d.news2_applicable && <span className="small muted">NEWS2 — {d.age < 16 ? '16 წლამდე არ ითვლება' : 'გამორთულია'}</span>}
        <span className="grow" /><label className="row small"><input type="checkbox" checked={showVoid} onChange={(e) => setShowVoid(e.target.checked)} /> გაუქმებულიც</label>
      </div>
      <VitalsChart rows={d.vitals.filter((v) => !v.voided_at)} />
      {!rows.length ? <span className="muted">ჩანაწერი არ არის.</span> : (
        <div style={{ overflowX: 'auto' }}><table className="table" style={{ minWidth: 900 }}>
          <thead><tr><th>დრო</th><th style={{ textAlign: 'center' }}>წნევა</th><th style={{ textAlign: 'center' }}>პულსი</th><th style={{ textAlign: 'center' }}>სუნთქვა</th><th style={{ textAlign: 'center' }}>SpO₂</th>
            <th style={{ textAlign: 'center' }}>O₂</th><th style={{ textAlign: 'center' }}>ტ°</th><th style={{ textAlign: 'center' }}>ცნობ.</th><th style={{ textAlign: 'center' }}>ტკივ.</th><th style={{ textAlign: 'center' }}>გლუკ.</th><th>NEWS2</th><th>ჩაწერა</th><th /></tr></thead>
          <tbody>{rows.map((v) => (
            <tr key={v.id} style={{ opacity: v.voided_at ? 0.5 : 1, textDecoration: v.voided_at ? 'line-through' : undefined }} title={v.void_reason ? `გაუქმდა: ${v.void_reason}` : v.notes ?? ''}>
              <td className="small">{dt(v.recorded_at)}</td>
              <Cell c={flag(v, 'sbp', d)}>{v.systolic_bp ? `${v.systolic_bp}/${v.diastolic_bp ?? '–'}` : ''}</Cell>
              <Cell c={flag(v, 'hr', d)}>{v.heart_rate ?? ''}</Cell><Cell c={flag(v, 'rr', d)}>{v.respiratory_rate ?? ''}</Cell>
              <Cell c={flag(v, 'spo2', d)}>{v.spo2 ?? ''}{v.spo2 && v.spo2_scale === 2 ? <sup>2</sup> : ''}</Cell>
              <Cell c={flag(v, 'o2', d)}>{v.o2_supplement == null ? '' : v.o2_supplement ? `O₂${v.o2_flow ? ` ${n1(v.o2_flow)}ლ` : ''}` : 'ჰაერი'}</Cell>
              <Cell c={flag(v, 'temp', d)}>{n1(v.temperature)}</Cell><Cell c={flag(v, 'acvpu', d)}>{v.consciousness ?? ''}</Cell>
              <Cell c={flag(v, 'pain', d)}>{v.pain ?? ''}</Cell><Cell c={flag(v, 'glucose', d)}>{n1(v.glucose)}</Cell>
              <td><News2Chip score={v.news2} level={v.news2_level} /></td>
              <td className="small muted">{v.taken_by_name}{v.notes ? <div title={v.notes}>📝</div> : null}</td>
              <td>{d.can_write && !v.voided_at && <button className="btn sm" type="button" onClick={() => setVoidV(v)}>გაუქმება</button>}</td>
            </tr>))}</tbody></table></div>)}
      <div className="small muted">ფერი — NEWS2-ის კომპონენტის ქულა (ყვითელი 1–2, წითელი 3); გლუკოზა — {d.settings.glucose_low}–{d.settings.glucose_high} მმოლ/ლ-ის გარეთ. NEWS2 მხოლოდ მინიშნებაა — კლინიკური შეფასება ექიმისაა.</div>
      {add && <VitalsDialog encounterId={encounterId} adult={d.news2_applicable} onClose={() => setAdd(false)} onDone={toast} />}
      {voidV && <VoidDialog kind="vitals" id={voidV.id} title={`ვიტალები — ${dt(voidV.recorded_at)}`} onClose={() => setVoidV(null)} onDone={toast} />}
    </div>
  );
}

/** ვიტალების გრაფიკი — small multiples (თითო პარამეტრი ცალკე, საერთო დროის ღერძი; ერთი y-ღერძი თითოეულზე); წნევა — სისტ.–დიასტ. ზოლი */
function VitalsChart({ rows }: { rows: Vitals[] }) {
  const pts = useMemo(() => [...rows].sort((a, b) => a.recorded_at.localeCompare(b.recorded_at)), [rows]);
  const [hover, setHover] = useState<number | null>(null);
  if (pts.length < 2) return null;
  const W = 900; const H = 70; const L = 120; const R = 12;
  const t0 = new Date(pts[0].recorded_at).getTime(); const t1 = new Date(pts[pts.length - 1].recorded_at).getTime();
  const x = (iso: string) => L + ((new Date(iso).getTime() - t0) / Math.max(1, t1 - t0)) * (W - L - R);
  const panels: { key: string; label: string; unit: string; get: (v: Vitals) => number | null; lo?: (v: Vitals) => number | null; part: string; ref?: [number, number] }[] = [
    { key: 'temp', label: 'ტემპერატურა', unit: '°C', get: (v) => (v.temperature ? Number(v.temperature) : null), part: 'temp', ref: [36.1, 38.0] },
    { key: 'hr', label: 'პულსი', unit: '/წთ', get: (v) => v.heart_rate, part: 'hr', ref: [51, 90] },
    { key: 'bp', label: 'წნევა', unit: 'მმ', get: (v) => v.systolic_bp, lo: (v) => v.diastolic_bp, part: 'sbp', ref: [111, 219] },
    { key: 'rr', label: 'სუნთქვა', unit: '/წთ', get: (v) => v.respiratory_rate, part: 'rr', ref: [12, 20] },
    { key: 'spo2', label: 'SpO₂', unit: '%', get: (v) => v.spo2, part: 'spo2', ref: [96, 100] },
  ];
  const hv = hover !== null ? pts[hover] : null;
  return (
    <div style={{ position: 'relative', border: '1px solid var(--line-soft)', borderRadius: 8, padding: '6px 0' }} onMouseLeave={() => setHover(null)}>
      {panels.map((p) => {
        const vals = pts.flatMap((v) => [p.get(v), p.lo?.(v) ?? null]).filter((z): z is number => z != null);
        if (!vals.length) return null;
        const mn = Math.min(...vals, p.ref?.[0] ?? Infinity); const mx = Math.max(...vals, p.key === 'bp' ? 0 : p.ref?.[1] ?? -Infinity);
        const pad = (mx - mn) * 0.15 || 1; const lo = mn - pad; const hi = mx + pad;
        const y = (val: number) => 6 + (1 - (val - lo) / (hi - lo)) * (H - 12);
        const line = pts.filter((v) => p.get(v) != null).map((v, i) => `${i ? 'L' : 'M'}${x(v.recorded_at).toFixed(1)},${y(p.get(v)!).toFixed(1)}`).join(' ');
        return (
          <svg key={p.key} viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label={`${p.label} — ${pts.length} გაზომვა`} style={{ display: 'block' }}
            onMouseMove={(e) => { const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect(); const px = ((e.clientX - r.left) / r.width) * W;
              let best = 0; let bd = Infinity; pts.forEach((v, i) => { const dd = Math.abs(x(v.recorded_at) - px); if (dd < bd) { bd = dd; best = i; } }); setHover(best); }}>
            {p.ref && p.key !== 'bp' && <rect x={L} width={W - L - R} y={y(Math.min(p.ref[1], hi))} height={Math.max(0, y(Math.max(p.ref[0], lo)) - y(Math.min(p.ref[1], hi)))} fill="var(--ok-weak)" opacity={0.6} />}
            <line x1={L} x2={W - R} y1={H - 1} y2={H - 1} stroke="var(--line-soft)" />
            <text x={4} y={16} fontSize={11} fill="var(--ink-2)">{p.label}</text>
            <text x={4} y={30} fontSize={10} fill="var(--muted)">{p.unit}</text>
            <text x={L - 4} y={y(hi - pad) + 4} fontSize={9} fill="var(--muted)" textAnchor="end">{Math.round(hi - pad)}</text>
            <text x={L - 4} y={y(lo + pad) + 4} fontSize={9} fill="var(--muted)" textAnchor="end">{Math.round(lo + pad)}</text>
            {p.key === 'bp' ? pts.filter((v) => v.systolic_bp != null).map((v) => {
              const c = (v.news2_parts?.sbp ?? 0) >= 3 ? 'var(--danger)' : (v.news2_parts?.sbp ?? 0) >= 1 ? 'var(--warn-ink)' : 'var(--accent)';
              return <g key={v.id}><line x1={x(v.recorded_at)} x2={x(v.recorded_at)} y1={y(v.systolic_bp!)} y2={y(v.diastolic_bp ?? v.systolic_bp!)} stroke={c} strokeWidth={4} strokeLinecap="round" /></g>;
            }) : <>
              <path d={line} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" />
              {pts.filter((v) => p.get(v) != null).map((v) => {
                const sc = v.news2_parts?.[p.part] ?? 0;
                return <circle key={v.id} cx={x(v.recorded_at)} cy={y(p.get(v)!)} r={sc ? 4.5 : 3.5} fill={sc >= 3 ? 'var(--danger)' : sc >= 1 ? 'var(--warn-ink)' : 'var(--accent)'} stroke="var(--surface)" strokeWidth={2} />;
              })}
            </>}
            {hv && <line x1={x(hv.recorded_at)} x2={x(hv.recorded_at)} y1={0} y2={H} stroke="var(--muted)" strokeDasharray="3 3" />}
          </svg>);
      })}
      {hv && <div className="small" style={{ position: 'absolute', top: 4, right: 8, background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 6, padding: '4px 8px', pointerEvents: 'none', boxShadow: '0 2px 6px rgba(0,0,0,.08)' }}>
        <strong>{dt(hv.recorded_at)}</strong> · წნ. {hv.systolic_bp ?? '–'}/{hv.diastolic_bp ?? '–'} · პ. {hv.heart_rate ?? '–'} · სუნთ. {hv.respiratory_rate ?? '–'} · SpO₂ {hv.spo2 ?? '–'} · ტ° {n1(hv.temperature) || '–'}{hv.news2 != null ? ` · NEWS2 ${hv.news2}` : ''}</div>}
    </div>
  );
}

export function VitalsDialog({ encounterId, adult, marEntryId, onClose, onDone }: { encounterId: string; adult: boolean; marEntryId?: string; onClose: () => void; onDone: (m: string) => void }) {
  const inval = useInval(encounterId);
  const [f, setF] = useState<Record<string, string>>({ time: nowHM(), consciousness: 'A', o2: 'air', spo2_scale: '1' });
  const set = (k: string) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const nv = (k: string) => (f[k] ? Number(f[k]) : undefined);
  const body = () => {
    const b: Record<string, unknown> = { recorded_at: atISO(f.time), consciousness: f.consciousness || undefined, o2_supplement: f.o2 === '' ? undefined : f.o2 === 'o2',
      spo2_scale: Number(f.spo2_scale), notes: f.notes?.trim() || undefined, mar_entry_id: marEntryId };
    for (const k of ['systolic_bp', 'diastolic_bp', 'heart_rate', 'respiratory_rate', 'temperature', 'spo2', 'o2_flow', 'pain', 'glucose', 'weight_kg']) if (nv(k) !== undefined) b[k] = nv(k);
    return b;
  };
  const pre = adult ? news2({ respiratory_rate: nv('respiratory_rate'), spo2: nv('spo2'), spo2_scale: Number(f.spo2_scale), o2_supplement: f.o2 === 'o2', systolic_bp: nv('systolic_bp'),
    heart_rate: nv('heart_rate'), consciousness: f.consciousness, temperature: nv('temperature') }) : null;
  const m = useMutation({ mutationFn: () => api<Vitals>(`/inpatient/stays/${encounterId}/vitals`, { body: body() }),
    onSuccess: (v) => { onDone(v.news2 != null ? `ვიტალები ჩაიწერა · NEWS2 ${v.news2}` : 'ვიტალები ჩაიწერა'); inval(); onClose(); } });
  const inp = (k: string, label: string, ph = '', step = '1') => <Field label={label} htmlFor={`vd-${k}`}><input id={`vd-${k}`} className="input mono" type="number" step={step} inputMode="decimal" value={f[k] ?? ''} onChange={set(k)} placeholder={ph} /></Field>;
  return (
    <Modal title={marEntryId ? 'ვიტალები (MAR დავალება)' : 'ვიტალური ნიშნები'} onClose={onClose} width={760}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={m.isPending} onClick={() => m.mutate()}>შენახვა</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12 }}>
          <Field label="დრო" htmlFor="vd-t"><input id="vd-t" className="input" type="time" value={f.time} onChange={set('time')} /></Field>
          {inp('systolic_bp', 'სისტოლური', '120')}{inp('diastolic_bp', 'დიასტოლური', '80')}{inp('heart_rate', 'პულსი', '72')}
          {inp('respiratory_rate', 'სუნთქვა / წთ', '16')}{inp('temperature', 'ტემპერატურა', '36.6', '0.1')}{inp('spo2', 'SpO₂ %', '97')}
          <Field label="SpO₂ შკალა" htmlFor="vd-ss" hint="2 — ჰიპერკაპნია (ექიმის მითითებით)"><select id="vd-ss" className="select" value={f.spo2_scale} onChange={set('spo2_scale')}><option value="1">1</option><option value="2">2</option></select></Field>
          <Field label="სუნთქვის ჰაერი" htmlFor="vd-o2"><select id="vd-o2" className="select" value={f.o2} onChange={set('o2')}><option value="air">ოთახის ჰაერი</option><option value="o2">ჟანგბადი</option><option value="">—</option></select></Field>
          {f.o2 === 'o2' && inp('o2_flow', 'O₂ ლ/წთ', '2', '0.5')}
          <Field label="ცნობიერება (ACVPU)" htmlFor="vd-c"><select id="vd-c" className="select" value={f.consciousness} onChange={set('consciousness')}>
            <option value="">—</option>{Object.entries(ACVPU).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          {inp('pain', 'ტკივილი 0–10', '0')}{inp('glucose', 'გლუკოზა მმოლ/ლ', '5.5', '0.1')}{inp('weight_kg', 'წონა კგ', '', '0.1')}
        </div>
        <Field label="შენიშვნა" htmlFor="vd-n"><textarea id="vd-n" className="textarea" rows={2} value={f.notes ?? ''} onChange={set('notes')} /></Field>
        {adult && <div className={`alert ${pre ? (pre.level === 'high' ? 'danger' : pre.level === 'low' ? 'info' : 'warn') : 'info'}`}>
          {pre ? <><strong>NEWS2: {pre.score}</strong> — {NEWS2_KA[pre.level][1]}{pre.level !== 'low' && ' · შენახვისას შეტყობინება მიუვა მკურნალ ექიმს და მთავარ ექთანს'}</>
            : 'NEWS2 ითვლება სრულ ნაკრებზე: სუნთქვა, SpO₂, ჟანგბადი, სისტოლური წნევა, პულსი, ცნობიერება, ტემპერატურა.'}</div>}
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- სითხის ბალანსი
function FluidTab({ d, encounterId, toast }: { d: NursingData; encounterId: string; toast: (m: string) => void }) {
  const [add, setAdd] = useState<'in' | 'out' | null>(null); const [vo, setVo] = useState<FluidEntry | null>(null);
  const f = d.fluid;
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="row" style={{ gap: 8 }}>
        {d.can_write && <><button className="btn primary sm" type="button" onClick={() => setAdd('in')}>+ მიღება</button><button className="btn sm" type="button" onClick={() => setAdd('out')}>+ გამოყოფა</button></>}
        <span className="grow" /><span className="small muted">ბალანსის დღე იწყება {f.day_start}-ზე</span>
      </div>
      {f.totals.length > 0 && <table className="table"><thead><tr><th>დღე</th><th style={{ textAlign: 'right' }}>მიღება, მლ</th><th style={{ textAlign: 'right' }}>გამოყოფა, მლ</th><th style={{ textAlign: 'right' }}>ბალანსი</th><th>შემადგენლობა</th></tr></thead>
        <tbody>{f.totals.map((t) => <tr key={t.day}><td>{t.day.split('-').reverse().join('/')} {f.day_start}</td><td className="mono" style={{ textAlign: 'right' }}>{Math.round(t.in)}</td>
          <td className="mono" style={{ textAlign: 'right' }}>{Math.round(t.out)}</td><td className="mono" style={{ textAlign: 'right', fontWeight: 600 }}>{ml(t.balance)}</td>
          <td className="small muted">{Object.entries(t.by).map(([k, v]) => `${FLUID_KA[k] ?? k} ${Math.round(v)}`).join(' · ')}</td></tr>)}</tbody></table>}
      {f.infusions.length > 0 && <div className="small"><span className="label">ინფუზიები (MAR, 24 სთ):</span> {f.infusions.map((i) => `${hhmm(i.documented_at)} ${i.title} — ${i.infusion_action}${i.rate_ml_h ? ` ${n1(i.rate_ml_h)} მლ/სთ` : ''}`).join(' · ')}</div>}
      {!f.entries.length ? <span className="muted">ჩანაწერი არ არის.</span> : <table className="table"><tbody>{f.entries.map((e) => (
        <tr key={e.id} style={{ opacity: e.voided_at ? 0.5 : 1, textDecoration: e.voided_at ? 'line-through' : undefined }} title={e.void_reason ?? ''}>
          <td className="small">{dt(e.recorded_at)}</td><td><span className={`chip ${e.direction === 'in' ? 'info' : ''}`}>{e.direction === 'in' ? 'მიღება' : 'გამოყოფა'}</span> {FLUID_KA[e.category] ?? e.category}</td>
          <td className="mono" style={{ textAlign: 'right' }}>{n1(e.volume_ml)} მლ</td><td className="small muted">{e.note}</td><td className="small muted">{e.created_by_name}</td>
          <td>{d.can_write && !e.voided_at && <button className="btn sm" type="button" onClick={() => setVo(e)}>გაუქმება</button>}</td></tr>))}</tbody></table>}
      {add && <FluidDialog encounterId={encounterId} dir={add} infusions={f.infusions} onClose={() => setAdd(null)} onDone={toast} />}
      {vo && <VoidDialog kind="fluid" id={vo.id} title={`${FLUID_KA[vo.category]} ${n1(vo.volume_ml)} მლ`} onClose={() => setVo(null)} onDone={toast} />}
    </div>
  );
}
export function FluidDialog({ encounterId, dir, infusions = [], marEntryId, onClose, onDone }: { encounterId: string; dir: 'in' | 'out'; infusions?: FluidData['infusions']; marEntryId?: string; onClose: () => void; onDone: (m: string) => void }) {
  const inval = useInval(encounterId);
  const [d, setD] = useState(dir); const [cat, setCat] = useState(dir === 'in' ? 'po' : 'urine'); const [vol, setVol] = useState(''); const [time, setTime] = useState(nowHM());
  const [note, setNote] = useState(''); const [order, setOrder] = useState('');
  const m = useMutation({ mutationFn: () => api(`/inpatient/stays/${encounterId}/fluid`, { body: { category: cat, volume_ml: Number(vol), recorded_at: atISO(time), note: note.trim() || undefined,
    order_id: order || undefined, mar_entry_id: marEntryId } }), onSuccess: () => { onDone(`${FLUID_KA[cat]}: ${vol} მლ`); inval(); onClose(); } });
  const orders = [...new Map(infusions.map((i) => [i.order_id, i])).values()];
  return (
    <Modal title={marEntryId ? 'სითხის ბალანსი (MAR დავალება)' : 'სითხის ბალანსი'} onClose={onClose} width={560}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={!(Number(vol) > 0) || m.isPending} onClick={() => m.mutate()}>შენახვა</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <div className="seg" role="group" aria-label="მიმართულება" style={{ width: 'max-content' }}>
          <button type="button" aria-pressed={d === 'in'} onClick={() => { setD('in'); setCat('po'); }}>მიღება</button><button type="button" aria-pressed={d === 'out'} onClick={() => { setD('out'); setCat('urine'); }}>გამოყოფა</button></div>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 12 }}>
          <Field label="სახე" htmlFor="fd-c"><select id="fd-c" className="select" value={cat} onChange={(e) => setCat(e.target.value)}>{(d === 'in' ? IN_CATS : OUT_CATS).map((c) => <option key={c} value={c}>{FLUID_KA[c]}</option>)}</select></Field>
          <Field label="მოცულობა, მლ" htmlFor="fd-v" required><input id="fd-v" className="input mono" type="number" min={1} value={vol} onChange={(e) => setVol(e.target.value)} /></Field>
          <Field label="დრო" htmlFor="fd-t"><input id="fd-t" className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} /></Field>
        </div>
        {d === 'in' && cat === 'iv' && orders.length > 0 && <Field label="ინფუზია (MAR)" htmlFor="fd-o" hint="სიჩქარე × დრო — მინიშნებისთვის; მოცულობა შეიყვანეთ ფაქტობრივი">
          <select id="fd-o" className="select" value={order} onChange={(e) => { setOrder(e.target.value); const o = orders.find((x) => x.order_id === e.target.value); if (o?.volume_ml && !vol) setVol(n1(o.volume_ml)); }}>
            <option value="">—</option>{orders.map((o) => <option key={o.order_id} value={o.order_id}>{o.title}{o.rate_ml_h ? ` · ${n1(o.rate_ml_h)} მლ/სთ` : ''}{o.volume_ml ? ` · ${n1(o.volume_ml)} მლ` : ''}</option>)}</select></Field>}
        <Field label="შენიშვნა" htmlFor="fd-n"><input id="fd-n" className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- შკალები
function ScalesTab({ d, encounterId, toast }: { d: NursingData; encounterId: string; toast: (m: string) => void }) {
  const [def, setDef] = useState<ScaleDef | null>(null); const [vo, setVo] = useState<Assessment | null>(null);
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10 }}>
        {d.scale_defs.map((s) => {
          const last = d.scales.find((a) => a.scale_code === s.code && !a.voided_at); const due = d.scales_due.find((x) => x.code === s.code);
          return (
            <div key={s.code} className="card card-pad stack" style={{ gap: 6 }}>
              <strong>{s.name}</strong>
              {last ? <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}><span className={`chip ${LEVEL_CHIP[last.level ?? ''] ?? ''}`}>{last.score} · {last.band_label}</span><span className="small muted">{dt(last.assessed_at)}</span></div>
                : <span className="small muted">არ შეფასებულა</span>}
              {due && <span className={`small ${due.overdue ? '' : 'muted'}`} style={{ color: due.overdue ? 'var(--danger)' : undefined }}>{due.overdue ? '⚠ ვადაგადაცილებულია' : 'შემდეგი'}: {dt(due.due_at)}</span>}
              {d.can_write && <button className="btn sm" type="button" onClick={() => setDef(s)}>შეფასება</button>}
            </div>);
        })}
      </div>
      {d.scales.length > 0 && <table className="table"><tbody>{d.scales.map((a) => (
        <tr key={a.id} style={{ opacity: a.voided_at ? 0.5 : 1, textDecoration: a.voided_at ? 'line-through' : undefined }} title={a.void_reason ?? a.note ?? ''}>
          <td className="small">{dt(a.assessed_at)}</td><td>{a.scale_name}</td><td><span className={`chip ${LEVEL_CHIP[a.level ?? ''] ?? ''}`}>{a.score} · {a.band_label}</span></td>
          <td className="small muted">{a.assessed_by_name}</td><td>{d.can_write && !a.voided_at && <button className="btn sm" type="button" onClick={() => setVo(a)}>გაუქმება</button>}</td></tr>))}</tbody></table>}
      {def && <ScaleDialog encounterId={encounterId} def={def} onClose={() => setDef(null)} onDone={toast} />}
      {vo && <VoidDialog kind="scale" id={vo.id} title={`${vo.scale_name} — ${vo.score}`} onClose={() => setVo(null)} onDone={toast} />}
    </div>
  );
}
export function ScaleDialog({ encounterId, def, marEntryId, onClose, onDone }: { encounterId: string; def: ScaleDef; marEntryId?: string; onClose: () => void; onDone: (m: string) => void }) {
  const inval = useInval(encounterId);
  const [ans, setAns] = useState<Record<string, number>>({}); const [note, setNote] = useState(''); const [time, setTime] = useState(nowHM());
  const done = def.items.every((it) => ans[it.key] !== undefined);
  const score = def.items.reduce((a, it) => a + (ans[it.key] !== undefined ? it.options[ans[it.key]].points : 0), 0);
  const band = done ? def.bands.find((b) => score >= b.min && score <= b.max) : null;
  const m = useMutation({ mutationFn: () => api(`/inpatient/stays/${encounterId}/scales`, { body: { scale_code: def.code, answers: ans, note: note.trim() || undefined, assessed_at: atISO(time), mar_entry_id: marEntryId } }),
    onSuccess: () => { onDone(`${def.name}: ${score}${band ? ` — ${band.label}` : ''}`); inval(); onClose(); } });
  return (
    <Modal title={def.name} onClose={onClose} width={680}
      footer={<><span className="grow" style={{ textAlign: 'left' }}>{band ? <span className={`chip ${LEVEL_CHIP[band.level]}`}>{score} — {band.label}</span> : <span className="small muted">ქულა: {score}</span>}</span>
        <button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={!done || m.isPending} onClick={() => m.mutate()}>შენახვა</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        {def.items.map((it) => (
          <fieldset key={it.key} style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="label" style={{ marginBottom: 4 }}>{it.label}</legend>
            <div className="stack" style={{ gap: 2 }}>{it.options.map((o, i) => (
              <label key={i} className="row small" style={{ gap: 8 }}><input type="radio" name={`sc-${it.key}`} checked={ans[it.key] === i} onChange={() => setAns((x) => ({ ...x, [it.key]: i }))} />
                <span className="grow">{o.label}</span><span className="mono muted">{o.points}</span></label>))}</div>
          </fieldset>))}
        <div className="row" style={{ gap: 12 }}>
          <Field label="დრო" htmlFor="sd-t"><input id="sd-t" className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} /></Field>
          <div className="grow"><Field label="შენიშვნა" htmlFor="sd-n"><input id="sd-n" className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field></div>
        </div>
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- ხაზები / დრენაჟები
const age = (h: number) => (h >= 48 ? `${Math.floor(h / 24)} დღე ${h % 24} სთ` : `${h} სთ`);
function LinesTab({ d, encounterId, toast }: { d: NursingData; encounterId: string; toast: (m: string) => void }) {
  const [add, setAdd] = useState(false); const [rm, setRm] = useState<Line | null>(null); const [vo, setVo] = useState<Line | null>(null);
  const open = d.lines.filter((l) => !l.removed_at && !l.voided_at); const past = d.lines.filter((l) => l.removed_at || l.voided_at);
  return (
    <div className="stack" style={{ gap: 12 }}>
      {d.can_write && <div><button className="btn primary sm" type="button" onClick={() => setAdd(true)}>+ ჩადგმა</button></div>}
      {!open.length ? <span className="muted">აქტიური კათეტერი / დრენაჟი არ არის.</span> : <table className="table"><tbody>{open.map((l) => {
        const over = l.alert_hours > 0 && l.hours >= l.alert_hours;
        return (
          <tr key={l.id}>
            <td><strong>{l.kind_ka}</strong>{l.size && <span className="small muted"> · {l.size}</span>}<div className="small muted">{l.site}{l.details ? ` · ${l.details}` : ''}</div></td>
            <td className="small">{dt(l.inserted_at)}<div className="muted">{l.inserted_where ?? l.inserted_by_name}</div></td>
            <td><span className={`chip ${over ? 'danger' : ''}`} title={l.alert_hours ? `შეხსენების ზღვარი: ${l.alert_hours} სთ` : ''}>{over ? '⚠ ' : ''}{age(l.hours)}</span></td>
            <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{d.can_write && <><button className="btn sm" type="button" onClick={() => setRm(l)}>ამოღება</button>{' '}
              <button className="btn sm" type="button" onClick={() => setVo(l)}>გაუქმება</button></>}</td>
          </tr>);
      })}</tbody></table>}
      {past.length > 0 && <details><summary className="small muted">ამოღებული / გაუქმებული ({past.length})</summary><table className="table"><tbody>{past.map((l) => (
        <tr key={l.id} style={{ opacity: 0.7, textDecoration: l.voided_at ? 'line-through' : undefined }}><td>{l.kind_ka} <span className="small muted">{l.site}</span></td>
          <td className="small">{dt(l.inserted_at)} → {l.removed_at ? dt(l.removed_at) : '—'}</td><td className="small">{age(l.hours)}</td><td className="small muted">{l.removal_reason}</td></tr>))}</tbody></table></details>}
      {add && <LineDialog encounterId={encounterId} onClose={() => setAdd(false)} onDone={toast} />}
      {rm && <RemoveLineDialog line={rm} encounterId={encounterId} onClose={() => setRm(null)} onDone={toast} />}
      {vo && <VoidDialog kind="line" id={vo.id} title={vo.kind_ka} onClose={() => setVo(null)} onDone={toast} />}
    </div>
  );
}
function LineDialog({ encounterId, onClose, onDone }: { encounterId: string; onClose: () => void; onDone: (m: string) => void }) {
  const inval = useInval(encounterId);
  const [f, setF] = useState({ kind: 'pvc', site: '', size: '', details: '', date: todayISO(), time: nowHM(), elsewhere: false, where: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const m = useMutation({ mutationFn: () => api(`/inpatient/stays/${encounterId}/lines`, { body: { kind: f.kind, site: f.site.trim() || undefined, size: f.size.trim() || undefined, details: f.details.trim() || undefined,
    inserted_at: new Date(localISO(f.date, f.time)).toISOString(), inserted_where: f.elsewhere ? f.where.trim() || 'სხვა დაწესებულებაში' : undefined } }),
    onSuccess: () => { onDone(`${LINE_KINDS[f.kind]} — ჩაიწერა`); inval(); onClose(); } });
  return (
    <Modal title="კათეტერი / დრენაჟი / ზონდი" onClose={onClose} width={620}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={m.isPending} onClick={() => m.mutate()}>შენახვა</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
          <Field label="სახე" htmlFor="ln-k"><select id="ln-k" className="select" value={f.kind} onChange={set('kind')}>{Object.entries(LINE_KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          <Field label="ზომა" htmlFor="ln-s"><input id="ln-s" className="input" value={f.size} onChange={set('size')} placeholder="მაგ. 20G, Ch 16" /></Field>
        </div>
        <Field label="ადგილი" htmlFor="ln-p"><input id="ln-p" className="input" value={f.site} onChange={set('site')} placeholder="მაგ. მარცხენა მაჯა" /></Field>
        <div className="row" style={{ gap: 12, alignItems: 'flex-end' }}>
          <Field label="ჩადგმის თარიღი" htmlFor="ln-d"><input id="ln-d" className="input" type="date" value={f.date} onChange={set('date')} /></Field>
          <Field label="დრო" htmlFor="ln-t"><input id="ln-t" className="input" type="time" value={f.time} onChange={set('time')} /></Field>
          <label className="row small"><input type="checkbox" checked={f.elsewhere} onChange={(e) => setF((x) => ({ ...x, elsewhere: e.target.checked }))} /> ჩადგმულია სხვაგან</label>
        </div>
        {f.elsewhere && <Field label="სად" htmlFor="ln-w"><input id="ln-w" className="input" value={f.where} onChange={set('where')} placeholder="მიმღები / სასწრაფო / სხვა კლინიკა" /></Field>}
        <Field label="დეტალები" htmlFor="ln-x"><input id="ln-x" className="input" value={f.details} onChange={set('details')} /></Field>
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}
function RemoveLineDialog({ line, encounterId, onClose, onDone }: { line: Line; encounterId: string; onClose: () => void; onDone: (m: string) => void }) {
  const inval = useInval(encounterId); const [time, setTime] = useState(nowHM()); const [reason, setReason] = useState('');
  const m = useMutation({ mutationFn: () => api(`/inpatient/lines/${line.id}/remove`, { body: { removed_at: atISO(time), reason: reason.trim() || undefined } }), onSuccess: () => { onDone(`${line.kind_ka} — ამოღებულია`); inval(); onClose(); } });
  return (
    <Modal title={`ამოღება — ${line.kind_ka}`} onClose={onClose} width={480}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={m.isPending} onClick={() => m.mutate()}>ამოღება</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <Field label="დრო" htmlFor="rl-t"><input id="rl-t" className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} /></Field>
        <Field label="მიზეზი" htmlFor="rl-r"><input id="rl-r" className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="დაგეგმილი შეცვლა / ფლებიტი / აღარ სჭირდება" /></Field>
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- ჩანაწერები / ცვლა
function NotesTab({ d, encounterId, toast }: { d: NursingData; encounterId: string; toast: (m: string) => void }) {
  const inval = useInval(encounterId);
  const [text, setText] = useState(''); const [ho, setHo] = useState(false); const [vo, setVo] = useState<Note | null>(null);
  const { user } = useAuth();
  const add = useMutation({ mutationFn: () => api(`/inpatient/stays/${encounterId}/nursing-notes`, { body: { kind: 'note', text: text.trim() } }), onSuccess: () => { setText(''); toast('ჩანაწერი დაემატა'); inval(); } });
  const ack = useMutation({ mutationFn: (id: string) => api(`/inpatient/nursing-notes/${id}/ack`, { body: {} }), onSuccess: () => { toast('ცვლა მიღებულია'); inval(); } });
  const cur = d.notes.find((x) => x.kind === 'handover' && !x.voided_at && x.shift_start && new Date(x.shift_start).getTime() === new Date(d.shift_start).getTime());
  return (
    <div className="stack" style={{ gap: 12 }}>
      {d.can_write && <div className="stack" style={{ gap: 6 }}>
        <textarea className="textarea" rows={2} aria-label="ექთნის ჩანაწერი" placeholder="ექთნის ჩანაწერი…" value={text} onChange={(e) => setText(e.target.value)} />
        <div className="row" style={{ gap: 8 }}><button className="btn sm primary" type="button" disabled={text.trim().length < 2 || add.isPending} onClick={() => add.mutate()}>დამატება</button>
          <span className="grow" /><span className="small muted">მიმდინარე ცვლა: {dt(d.shift_start)}</span>
          {cur ? <span className="chip ok">გადაბარება ჩაწერილია</span> : <button className="btn sm" type="button" onClick={() => setHo(true)}>ცვლის გადაბარება (SBAR)</button>}</div>
        <ErrorBox error={add.error ?? ack.error} />
      </div>}
      {!d.notes.length && <span className="muted">ჩანაწერი არ არის.</span>}
      {d.notes.map((x) => (
        <div key={x.id} className="card card-pad stack" style={{ gap: 6, opacity: x.voided_at ? 0.5 : 1 }}>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {x.kind === 'handover' ? <span className="chip info">ცვლის გადაბარება</span> : <span className="chip">ჩანაწერი</span>}
            <span className="small">{dt(x.created_at)} · {x.author_name}</span><span className="grow" />
            {x.kind === 'handover' && (x.ack_at ? <span className="chip ok">მიიღო: {x.ack_by_name} · {hhmm(x.ack_at)}</span>
              : d.can_write && !x.voided_at && x.author_id !== user?.id && <button className="btn sm primary" type="button" disabled={ack.isPending} onClick={() => ack.mutate(x.id)}>ცვლის მიღება</button>)}
            {d.can_write && !x.voided_at && <button className="btn sm" type="button" onClick={() => setVo(x)}>გაუქმება</button>}
          </div>
          {x.voided_at && <span className="small muted">გაუქმდა: {x.void_reason}</span>}
          {x.text && <div style={{ whiteSpace: 'pre-wrap', textDecoration: x.voided_at ? 'line-through' : undefined }}>{x.text}</div>}
          {x.sbar && <SbarView sbar={x.sbar} />}
          {x.summary && <SummaryChips s={x.summary} />}
        </div>))}
      {ho && <HandoverDialog encounterId={encounterId} onClose={() => setHo(false)} onDone={toast} />}
      {vo && <VoidDialog kind="note" id={vo.id} title={vo.kind === 'handover' ? 'ცვლის გადაბარება' : 'ჩანაწერი'} onClose={() => setVo(null)} onDone={toast} />}
    </div>
  );
}
const SBAR_KA: [keyof Sbar, string, string][] = [['s', 'S — სიტუაცია', 'რა ხდება ახლა'], ['b', 'B — ფონი', 'დიაგნოზი, მნიშვნელოვანი ისტორია'], ['a', 'A — შეფასება', 'მდგომარეობა, ცვლილებები ცვლაში'], ['r', 'R — რეკომენდაცია', 'რას მოითხოვს მომდევნო ცვლა']];
const SbarView = ({ sbar }: { sbar: Sbar }) => <div className="stack" style={{ gap: 2 }}>{SBAR_KA.filter(([k]) => sbar[k]).map(([k, l]) => <div key={k} className="small"><strong>{l}:</strong> {sbar[k]}</div>)}</div>;
export function SummaryChips({ s }: { s: Summary }) {
  const v = s.vitals;
  return (
    <div className="row small" style={{ gap: 6, flexWrap: 'wrap' }}>
      {v ? <span className="chip" title={v.recorded_at ? dt(v.recorded_at) : ''}>ბოლო: {v.systolic_bp ? `${v.systolic_bp}/${v.diastolic_bp ?? '–'}` : ''}{v.heart_rate ? ` · პ ${v.heart_rate}` : ''}{v.temperature ? ` · ${n1(v.temperature)}°` : ''}{v.spo2 ? ` · ${v.spo2}%` : ''}</span> : <span className="chip">ვიტალები არ არის</span>}
      <News2Chip score={v?.news2 ?? null} level={(v?.news2_level as Level) ?? null} />
      {s.mar.missed > 0 && <span className="chip danger">მიუცემელი დოზა: {s.mar.missed}</span>}
      {s.mar.refused > 0 && <span className="chip warn">უარი / გადადება: {s.mar.refused}</span>}
      <span className="chip">მიცემული: {s.mar.given} · შემდეგი 12 სთ: {s.mar.due_next}</span>
      {(s.fluid.in > 0 || s.fluid.out > 0) && <span className="chip">ბალანსი: {Math.round(s.fluid.in)}/{Math.round(s.fluid.out)} ({ml(s.fluid.balance)})</span>}
      {s.lines.map((l, i) => <span key={i} className="chip">{l.kind_ka}{l.site ? ` (${l.site})` : ''} · {l.days} დღე</span>)}
      {s.risks.map((r) => <span key={r.code} className={`chip ${r.level === 'high' ? 'danger' : 'warn'}`}>{r.label}</span>)}
    </div>
  );
}
export function HandoverDialog({ encounterId, title, onClose, onDone }: { encounterId: string; title?: string; onClose: () => void; onDone: (m: string) => void }) {
  const inval = useInval(encounterId);
  const sum = useQuery({ queryKey: ['ipd-nursing-summary', encounterId], queryFn: () => api<Summary>(`/inpatient/stays/${encounterId}/nursing/summary`) });
  const [f, setF] = useState<Sbar>({});
  const m = useMutation({ mutationFn: () => api(`/inpatient/stays/${encounterId}/nursing-notes`, { body: { kind: 'handover', sbar: f } }), onSuccess: () => { onDone('ცვლის გადაბარება ჩაიწერა'); inval(); onClose(); } });
  return (
    <Modal title={title ?? 'ცვლის გადაბარება (SBAR)'} onClose={onClose} width={720}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={!Object.values(f).some((x) => (x ?? '').trim().length >= 2) || m.isPending} onClick={() => m.mutate()}>შენახვა</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <div className="stack" style={{ gap: 4 }}><span className="label">ავტომატური შეჯამება (ცვლის დასაწყისიდან)</span>{sum.data ? <SummaryChips s={sum.data} /> : <Loading />}</div>
        {SBAR_KA.map(([k, l, ph]) => <Field key={k} label={l} htmlFor={`sb-${k}`}><textarea id={`sb-${k}`} className="textarea" rows={2} placeholder={ph} value={f[k] ?? ''} onChange={(e) => setF((x) => ({ ...x, [k]: e.target.value }))} /></Field>)}
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- გაუქმება
function VoidDialog({ kind, id, title, onClose, onDone }: { kind: 'vitals' | 'fluid' | 'scale' | 'line' | 'note'; id: string; title: string; onClose: () => void; onDone: (m: string) => void }) {
  const inval = useInval(); const [reason, setReason] = useState('');
  const m = useMutation({ mutationFn: () => api(`/inpatient/nursing/${kind}/${id}/void`, { body: { reason: reason.trim() } }), onSuccess: () => { onDone('გაუქმდა'); inval(); onClose(); } });
  return (
    <Modal title={`გაუქმება — ${title}`} onClose={onClose} width={480}
      footer={<><button className="btn" type="button" onClick={onClose}>დახურვა</button><button className="btn danger" type="button" disabled={reason.trim().length < 3 || m.isPending} onClick={() => m.mutate()}>გაუქმება</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <Field label="მიზეზი" htmlFor="nv-r" required hint="ჩანაწერი არ იშლება — ჩანს გადახაზულად; MAR-ის დავალება თავიდან გაიხსნება"><textarea id="nv-r" className="textarea" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}

// ================================================================= MAR → ფორმა (მოვლის დავალება)
export function TaskDialog({ encounterId, task, scaleCode, marEntryId, onClose, onDone }: { encounterId: string; task: 'vitals' | 'fluid' | 'scale'; scaleCode?: string | null; marEntryId: string;
  onClose: () => void; onDone: (m: string) => void }) {
  const q = useQuery({ queryKey: ['ipd-nursing', encounterId, 1], queryFn: () => api<NursingData>(`/inpatient/stays/${encounterId}/nursing`, { query: { days: 1 } }) });
  if (q.isLoading) return <Modal title="დავალება" onClose={onClose}><Loading /></Modal>;
  if (!q.data) return <Modal title="დავალება" onClose={onClose}><ErrorBox error={q.error} /></Modal>;
  if (task === 'vitals') return <VitalsDialog encounterId={encounterId} adult={q.data.news2_applicable} marEntryId={marEntryId} onClose={onClose} onDone={onDone} />;
  if (task === 'fluid') return <FluidDialog encounterId={encounterId} dir="out" infusions={q.data.fluid.infusions} marEntryId={marEntryId} onClose={onClose} onDone={onDone} />;
  const def = q.data.scale_defs.find((x) => x.code === scaleCode);
  return def ? <ScaleDialog encounterId={encounterId} def={def} marEntryId={marEntryId} onClose={onClose} onDone={onDone} /> : <Modal title="დავალება" onClose={onClose}>შკალა ვერ მოიძებნა</Modal>;
}

// ================================================================= განყოფილება: ცვლის გადაბარება
interface HandoverPatient { encounter_id: string; adm_no: string; severity: string | null; isolation: string | null; first_name: string; last_name: string; birth_date: string; gender: string; bed_code: string | null;
  doctor_name: string | null; diagnosis: string | null; allergies: number; summary: Summary; current: Note | null; previous: Note | null }
export function DepartmentHandover({ departmentId }: { departmentId: string }) {
  const q = useQuery({ queryKey: ['ipd-handover', departmentId], queryFn: () => api<{ shift_start: string; can_write: boolean; me: string; patients: HandoverPatient[] }>(`/inpatient/departments/${departmentId}/handover`), refetchInterval: 120_000 });
  const toast = useToast(); const inval = useInval(); const [dlg, setDlg] = useState<HandoverPatient | null>(null);
  const ack = useMutation({ mutationFn: (id: string) => api(`/inpatient/nursing-notes/${id}/ack`, { body: {} }), onSuccess: () => { toast.show('ცვლა მიღებულია'); inval(); } });
  if (q.isLoading) return <Loading />;
  if (!q.data) return <ErrorBox error={q.error} />;
  const d = q.data;
  const done = d.patients.filter((p) => p.current).length;
  return (
    <div className="stack" style={{ gap: 12 }}>
      {toast.node}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <span>მიმდინარე ცვლა: <strong>{dt(d.shift_start)}</strong></span>
        <span className={`chip ${done === d.patients.length && done > 0 ? 'ok' : 'warn'}`}>გადაბარებულია: {done} / {d.patients.length}</span>
      </div>
      <ErrorBox error={ack.error} />
      {!d.patients.length && <div className="card empty">განყოფილებაში აქტიური პაციენტი არ არის.</div>}
      {d.patients.map((p) => {
        const prev = p.previous;
        return (
          <section key={p.encounter_id} className="card">
            <div className="card-head" style={{ gap: 8, flexWrap: 'wrap' }}>
              {p.bed_code && <span className="chip mono">{p.bed_code}</span>}
              <Link to={`/inpatient/stay/${p.encounter_id}#nursing`} style={{ fontWeight: 600 }}>{p.last_name} {p.first_name}</Link>
              <span className="small muted mono">{p.adm_no}</span>{p.allergies > 0 && <span className="chip danger">ალერგია ({p.allergies})</span>}
              <span className="small muted">{p.diagnosis}{p.doctor_name ? ` · ${p.doctor_name}` : ''}</span><span className="grow" />
              {p.current ? <span className="chip ok">გადაბარებულია · {p.current.author_name}{p.current.ack_at ? ` → ${p.current.ack_by_name}` : ''}</span>
                : d.can_write && <button className="btn sm primary" type="button" onClick={() => setDlg(p)}>გადაბარება</button>}
            </div>
            <div className="card-pad stack" style={{ gap: 8 }}>
              <SummaryChips s={p.summary} />
              {prev && <div className="stack" style={{ gap: 4, borderLeft: '3px solid var(--info-line)', paddingLeft: 10 }}>
                <div className="row small" style={{ gap: 8 }}><span className="muted">წინა ცვლა ({dt(prev.shift_start!)}) — {prev.author_name}</span><span className="grow" />
                  {prev.ack_at ? <span className="chip ok">მიიღო: {prev.ack_by_name}</span>
                    : d.can_write && prev.author_id !== d.me && <button className="btn sm" type="button" disabled={ack.isPending} onClick={() => ack.mutate(prev.id)}>ცვლის მიღება</button>}</div>
                {prev.sbar && <SbarView sbar={prev.sbar} />}
              </div>}
              {p.current?.sbar && <div className="stack" style={{ gap: 4, borderLeft: '3px solid var(--ok-line)', paddingLeft: 10 }}><SbarView sbar={p.current.sbar} /></div>}
            </div>
          </section>);
      })}
      {dlg && <HandoverDialog encounterId={dlg.encounter_id} title={`ცვლის გადაბარება — ${dlg.last_name} ${dlg.first_name}`} onClose={() => setDlg(null)} onDone={toast.show} />}
    </div>
  );
}
