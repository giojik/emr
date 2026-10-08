import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError, can } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Field, Loading, Modal, useDebounced, useToast } from '../../components/ui';
import { hhmm, localISO, shiftDay, todayISO, tsDate } from '../../lib/format';
import { useModuleEnabled } from '../../lib/modules';

// ================================================================= ტიპები (0047)
export type IcuFeature = 'sheet' | 'ventilation' | 'infusions' | 'sofa' | 'apache' | 'abg' | 'bundles' | 'icu_note' | 'board';
export const FEATURE_KA: Record<IcuFeature, string> = {
  sheet: 'მონიტორინგის ფურცელი', ventilation: 'ხელოვნური ვენტილაცია', infusions: 'ვაზოპრესორები / ტიტრაცია', sofa: 'SOFA', apache: 'APACHE II', abg: 'სისხლის აირები',
  bundles: 'bundle-ები (VAP / CLABSI)', icu_note: 'ICU დღიური / გაყვანის შეჯამება', board: 'რეანიმაციის დაფა',
};
export const ALL_FEATURES = Object.keys(FEATURE_KA) as IcuFeature[];
export const LEVEL_KA: Record<string, string> = { ward: 'ჩვეულებრივი', intensive: 'ინტენსიური პალატა', icu: 'რეანიმაცია (ICU)' };
const ORIGIN_KA: Record<string, string> = { er: 'მიმღები / სასწრაფო', or: 'საოპერაციო', ward: 'განყოფილება', other_clinic: 'სხვა კლინიკა', direct: 'პირდაპირ' };
const EXIT_KA: Record<string, string> = { improved: 'გაუმჯობესებით', stable: 'სტაბილური', worse: 'გაუარესებით', died: 'გარდაიცვალა' };
const EXIT_KIND_KA: Record<string, string> = { transfer: 'გადაყვანა', discharge: 'გაწერა', cancel: 'გაუქმება' };
const VENT_KA: Record<string, string> = { invasive: 'ინვაზიური', niv: 'არაინვაზიური (NIV)', hfnc: 'მაღალი ნაკადი (HFNC)' };
const AIRWAY_KA: Record<string, string> = { ett: 'ენდოტრაქეული მილი', trach: 'ტრაქეოსტომა', mask: 'ნიღაბი', nasal: 'ცხვირის (კანულა / ნიღაბი)', helmet: 'ჩაფხუტი' };
const AIRWAYS: Record<string, string[]> = { invasive: ['ett', 'trach'], niv: ['mask', 'nasal', 'helmet'], hfnc: ['nasal'] };
const VEND_KA: Record<string, string> = { extubated: 'ექსტუბაცია (გეგმიური)', self_extub: 'თვითექსტუბაცია', accidental: 'შემთხვევითი', switch: 'სხვა რეჟიმზე გადასვლა', trach: 'ტრაქეოსტომა', death: 'გარდაცვალება', transfer: 'გადაყვანა' };
const PUPIL_KA: Record<string, string> = { brisk: 'ცოცხალი', sluggish: 'დუნე', fixed: 'არ რეაგირებს' };
const SOURCE_KA: Record<string, [string, string]> = { auto: ['info', 'ავტომატურად'], manual: ['warn', 'ხელით'], missing: ['danger', 'დაუდგენელი'] };
const FIO2_SRC: Record<string, string> = { abg: 'ABG', vent: 'ვენტილატორი', room_air: 'ოთახის ჰაერი', unknown: 'უცნობი' };

interface Episode {
  id: string; encounter_id: string; department_id: string; department_name: string; care_level: string; started_at: string; origin: string; from_department_name: string | null;
  reason: string | null; admission_weight_kg: string | null; readmission: boolean; monitor_interval_min: number | null; monitor_interval_until: string | null;
  ended_at: string | null; exit_kind: string | null; exit_department_name: string | null; exit_condition: string | null; exit_note: string | null; hours: number;
}
interface Vent {
  id: string; kind: string; airway: string; started_at: string; performed_by_name: string | null; performed_where: string | null; ett_size: string | null; ett_depth_cm: string | null;
  attempts: number | null; difficult: boolean; notes: string | null; ended_at: string | null; end_reason: string | null; end_note: string | null; ended_by_name: string | null; created_by_name: string;
  voided_at: string | null; void_reason: string | null; days: number;
}
interface VentSettings { id: string; ventilation_id: string; recorded_at: string; mode: string; fio2: number | null; peep: string | null; vt_ml: number | null; rate_set: number | null; rate_total: number | null;
  ppeak: number | null; pplat: number | null; ps: string | null; ipap: string | null; epap: string | null; flow_lpm: number | null; mv_l: string | null; note: string | null; recorded_by_name?: string; kind?: string; voided_at?: string | null }
export interface Infusion {
  id: string; status: string; titratable: boolean; title: string; dose_rate: string | null; unit: string | null; conc_amount: string | null; conc_unit: string | null; conc_volume_ml: string | null;
  titrate_min: string | null; titrate_max: string | null; titrate_goal: string | null; weight_used: number | null; rate_ml_h: string | null; current_rate_ml_h: number; current_dose_rate: number | null;
  events: { id: string; infusion_action: string; rate_ml_h: string | null; dose_rate: string | null; documented_at: string; reason: string | null; by_name: string | null }[];
  hours?: { at: string; rate_ml_h: number; dose_rate: number | null; volume_ml: number }[];
}
interface Score {
  id: string; kind: 'sofa' | 'apache2'; total: number; missing: string[]; components: Record<string, Component>; day: string; window_from: string; window_to: string; predicted_mortality: string | null;
  category_name: string | null; confirmed_by_name: string; confirmed_at: string; note: string | null; voided_at: string | null; void_reason: string | null; episode_id: string;
}
interface Component { key: string; label: string; value: number | null; unit?: string; points: number | null; source: 'auto' | 'manual' | 'missing'; at?: string | null; detail?: string }
interface Abg { source: 'lab' | 'poc'; id: string; sampled_at: string; sample?: string; ph?: number | null; pco2?: number | null; po2?: number | null; hco3?: number | null; be?: number | null; lactate?: number | null;
  sao2?: number | null; fio2: number | null; fio2_source?: string; pf?: number; validated?: boolean; na?: number | null; k?: number | null; created_by_name?: string; note?: string | null }
interface BundleItem { id: string; bundle: 'vap' | 'clabsi'; label: string; sort_order: number; is_active: boolean }
interface BundleCheck { id: string; bundle: 'vap' | 'clabsi'; day: string; answers: { item_id: string; label: string; answer: 'yes' | 'no' | 'na' }[]; compliant: boolean; note: string | null;
  checked_by_name: string; checked_at: string; voided_at: string | null; void_reason: string | null }
interface ApacheCat { code: string; name: string; operative: boolean; weight: string; is_active: boolean; sort_order: number }
export interface IcuStay {
  episode: Episode | null; episodes: Episode[]; features: IcuFeature[]; care_level: string; department_id?: string; weight?: number | null; interval_min?: number; default_interval?: number;
  fast_max_hours?: number; ventilation?: Vent[]; current_vent?: Vent | null; last_settings?: VentSettings | null; vent_days?: number; vasoactive?: Infusion[]; scores?: Score[];
  bundles?: BundleCheck[]; bundle_items?: BundleItem[]; applicable?: { vap: boolean; clabsi: boolean }; today?: string; bundle_due?: { vap: boolean; clabsi: boolean };
  sofa_today?: boolean; apache_done?: boolean; abg?: Abg[]; can_write?: boolean; can_doctor?: boolean; vent_modes?: string[]; doctors?: { id: string; name: string }[]; apache_categories?: ApacheCat[];
}
interface Obs {
  id: string; recorded_at: string; systolic_bp: number | null; diastolic_bp: number | null; map_mmhg: number | null; map_invasive: boolean; heart_rate: number | null; respiratory_rate: number | null;
  spo2: number | null; temperature: string | null; cvp: number | null; etco2: number | null; pupil_l: string | null; pupil_r: string | null; pupil_l_react: string | null; pupil_r_react: string | null;
  gcs_e: number | null; gcs_v: number | null; gcs_m: number | null; gcs_intubated: boolean; gcs_total: number | null; rass: number | null; icu_sheet: boolean; taken_by_name: string | null; notes: string | null;
}
interface Sheet {
  day: string; today: string; start: string; end: string; day_start: string; interval_min: number; slots: string[]; gaps: string[]; can_write: boolean;
  vitals: Obs[]; vent: VentSettings[]; infusions: Infusion[]; abg: Abg[];
  balance: { at: string; in: number; out: number; net: number; cumulative: number; by: Record<string, number> }[]; totals: { in: number; out: number; net: number };
}

// ================================================================= საერთო
const n = (v: string | number | null | undefined) => (v === null || v === undefined || v === '' ? null : Number(v));
const f1 = (v: string | number | null | undefined) => { const x = n(v); return x === null ? '' : String(Math.round(x * 10) / 10); };
const f3 = (v: string | number | null | undefined) => { const x = n(v); return x === null ? '' : String(Math.round(x * 1000) / 1000); };
const dt = (iso: string) => `${tsDate(iso)} ${hhmm(iso)}`;
const nowHM = () => hhmm(new Date().toISOString());
const atISO = (t: string) => { const today = todayISO(); const iso = new Date(localISO(today, t)); return (iso.getTime() > Date.now() + 5 * 60_000 ? new Date(localISO(shiftDay(today, -1), t)) : iso).toISOString(); };
const days = (h: number) => (h < 24 ? `${Math.round(h)} სთ` : `${Math.round((h / 24) * 10) / 10} დღე`);
const sgn = (v: number) => `${v > 0 ? '+' : ''}${Math.round(v)}`;
const Th = ({ children }: { children?: ReactNode }) => <th style={{ textAlign: 'center', whiteSpace: 'nowrap' }}>{children}</th>;

/** ვაზოაქტიური: დოზის სიჩქარე → მლ/სთ (იგივე ფორმულა, რაც სერვერზე — წინასწარი ჩვენებისთვის) */
export const DOSE_RATE_UNITS = ['mcg/kg/min', 'mcg/min', 'mg/h', 'mg/kg/h', 'mcg/kg/h', 'units/h', 'units/min'] as const;
export const UNIT_KA: Record<string, string> = { 'mcg/kg/min': 'მკგ/კგ/წთ', 'mcg/min': 'მკგ/წთ', 'mg/h': 'მგ/სთ', 'mg/kg/h': 'მგ/კგ/სთ', 'mcg/kg/h': 'მკგ/კგ/სთ', 'units/h': 'ერთ./სთ',
  'units/min': 'ერთ./წთ', mg: 'მგ', mcg: 'მკგ', units: 'ერთ.' };
export function doseToMlH(rate: number, unit: string, conc: { amount: number; unit: string; volume_ml: number }, w: number | null): number | null {
  if (!rate || !conc.amount || !conc.volume_ml) return null;
  if (unit.startsWith('units') !== (conc.unit === 'units')) return null;
  const kg = unit.includes('/kg/') ? w : 1; if (!kg) return null;
  const perMin = unit.endsWith('/min') ? rate * kg : unit.startsWith('mg') ? (rate * kg * 1000) / 60 : (rate * kg) / 60;
  const perMl = (conc.unit === 'mg' ? conc.amount * 1000 : conc.amount) / conc.volume_ml;
  return Math.round(((perMin * 60) / perMl) * 100) / 100;
}

function useInval(encounterId: string) {
  const qc = useQueryClient();
  return () => { for (const k of ['ipd-icu', 'ipd-icu-sheet', 'ipd-icu-board', 'ipd-nursing', 'ipd-mar', 'ipd-notes']) void qc.invalidateQueries({ queryKey: [k] }); void qc.invalidateQueries({ queryKey: ['ipd-stay', encounterId] }); };
}
export const useIcu = (encounterId: string, enabled = true) => {
  const on = useModuleEnabled('icu');
  return useQuery({ queryKey: ['ipd-icu', encounterId], queryFn: () => api<IcuStay>(`/inpatient/stays/${encounterId}/icu`), enabled: enabled && on, refetchInterval: 120_000 });
};

function VoidDialog({ kind, id, title, onClose, onDone, inval }: { kind: string; id: string; title: string; onClose: () => void; onDone: (m: string) => void; inval: () => void }) {
  const [reason, setReason] = useState('');
  const m = useMutation({ mutationFn: () => api(kind === 'vitals' ? `/inpatient/nursing/vitals/${id}/void` : `/inpatient/icu/${kind}/${id}/void`, { body: { reason: reason.trim() } }),
    onSuccess: () => { onDone('გაუქმდა'); inval(); onClose(); } });
  return (
    <Modal title={`გაუქმება — ${title}`} onClose={onClose} width={480}
      footer={<><button className="btn" type="button" onClick={onClose}>დახურვა</button><button className="btn danger" type="button" disabled={reason.trim().length < 3 || m.isPending} onClick={() => m.mutate()}>გაუქმება</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <Field label="მიზეზი" htmlFor="iv-r" required hint="ჩანაწერი არ იშლება — ჩანს გადახაზულად"><textarea id="iv-r" className="textarea" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}

// ================================================================= პანელი (ჰოსპიტალიზაციის გვერდი)
type Tab = 'sheet' | 'vent' | 'inf' | 'scores' | 'abg' | 'bundles' | 'episodes';
export default function IcuPanel({ encounterId }: { encounterId: string }) {
  const q = useIcu(encounterId);
  const toast = useToast(); const inval = useInval(encounterId);
  const [tab, setTab] = useState<Tab>('sheet');
  const [dlg, setDlg] = useState<'episode' | 'interval' | null>(null);
  const d = q.data;
  if (!d || !d.episodes.length) return null;
  const ep = d.episode; const f = d.features;
  const show = (x: IcuFeature) => !ep || f.includes(x);
  const tabs: [Tab, ReactNode, boolean][] = [
    ['sheet', 'მონიტორინგის ფურცელი', !!ep && f.includes('sheet')],
    ['vent', <>ვენტილაცია {d.current_vent && <span className="chip info">{VENT_KA[d.current_vent.kind]}</span>}</>, (d.ventilation?.length ?? 0) > 0 || (!!ep && f.includes('ventilation'))],
    ['inf', <>ინფუზიები {(d.vasoactive ?? []).filter((x) => x.current_rate_ml_h > 0).length > 0 && <span className="chip">{(d.vasoactive ?? []).filter((x) => x.current_rate_ml_h > 0).length}</span>}</>, !!ep && f.includes('infusions')],
    ['scores', <>SOFA / APACHE {ep && f.includes('sofa') && !d.sofa_today && <span className="chip warn">დღეს არა</span>}</>, (d.scores?.length ?? 0) > 0 || (!!ep && (f.includes('sofa') || f.includes('apache')))],
    ['abg', 'სისხლის აირები', show('abg')],
    ['bundles', <>bundle {ep && (d.bundle_due?.vap || d.bundle_due?.clabsi) && <span className="chip warn">!</span>}</>, (d.bundles?.length ?? 0) > 0 || (!!ep && f.includes('bundles'))],
    ['episodes', `ეპიზოდები (${d.episodes.length})`, true],
  ];
  const vis = tabs.filter((t) => t[2]);
  const cur = vis.some((t) => t[0] === tab) ? tab : vis[0]?.[0];
  return (
    <section className="card" id="icu">
      {toast.node}
      <div className="card-head" style={{ flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0 }}>{ep ? LEVEL_KA[ep.care_level] : 'რეანიმაცია / ინტენსიური'}</h2>
        {ep ? <>
          <span className="chip ok">{ep.department_name} · {days(ep.hours)}</span>
          {ep.readmission && <span className="chip warn" title="წინა ეპიზოდიდან 48 სთ-ში">ხელახლა შემოსვლა</span>}
          <span className="small muted">{ORIGIN_KA[ep.origin]}{ep.from_department_name ? ` (${ep.from_department_name})` : ''} · {dt(ep.started_at)}</span>
          {d.weight ? <span className="chip">{f1(d.weight)} კგ</span> : <span className="chip danger">წონა არ არის</span>}
          {f.includes('sheet') && <span className={`chip ${d.interval_min !== d.default_interval ? 'warn' : ''}`} title="ფურცლის ინტერვალი">ფურცელი: {d.interval_min} წთ{ep.monitor_interval_until && d.interval_min !== d.default_interval ? ` ${hhmm(ep.monitor_interval_until)}-მდე` : ''}</span>}
        </> : <span className="chip">დასრულებულია</span>}
        <span className="grow" />
        {ep && d.can_write && <button className="btn sm" type="button" onClick={() => setDlg('episode')}>წონა / წყარო</button>}
        {ep && d.can_doctor && f.includes('sheet') && <button className="btn sm" type="button" onClick={() => setDlg('interval')}>ინტერვალი</button>}
      </div>
      {ep?.reason && <div className="card-pad small" style={{ paddingBottom: 0 }}><span className="muted">მიზეზი: </span>{ep.reason}</div>}
      <div className="row" style={{ gap: 0, borderBottom: '1px solid var(--line)', padding: '0 12px', flexWrap: 'wrap' }}>
        {vis.map(([k, l]) => <button key={k} type="button" className={`admin-tab${cur === k ? ' active' : ''}`} style={{ background: 'none', border: 0, cursor: 'pointer' }} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      <div className="card-pad">
        {cur === 'sheet' ? <SheetTab encounterId={encounterId} d={d} toast={toast.show} inval={inval} />
          : cur === 'vent' ? <VentTab encounterId={encounterId} d={d} toast={toast.show} inval={inval} />
          : cur === 'inf' ? <InfusionsTab d={d} toast={toast.show} inval={inval} />
          : cur === 'scores' ? <ScoresTab encounterId={encounterId} d={d} toast={toast.show} inval={inval} />
          : cur === 'abg' ? <AbgTab encounterId={encounterId} d={d} toast={toast.show} inval={inval} />
          : cur === 'bundles' ? <BundlesTab encounterId={encounterId} d={d} toast={toast.show} inval={inval} />
          : <EpisodesTab d={d} toast={toast.show} inval={inval} />}
      </div>
      {dlg === 'episode' && ep && <EpisodeDialog ep={ep} onClose={() => setDlg(null)} onDone={toast.show} inval={inval} />}
      {dlg === 'interval' && ep && <IntervalDialog ep={ep} d={d} onClose={() => setDlg(null)} onDone={toast.show} inval={inval} />}
    </section>
  );
}

function EpisodeDialog({ ep, onClose, onDone, inval }: { ep: Episode; onClose: () => void; onDone: (m: string) => void; inval: () => void }) {
  const [w, setW] = useState(ep.admission_weight_kg ? f1(ep.admission_weight_kg) : ''); const [origin, setOrigin] = useState(ep.origin); const [reason, setReason] = useState(ep.reason ?? '');
  const m = useMutation({ mutationFn: () => api(`/inpatient/icu/episodes/${ep.id}`, { method: 'PATCH', body: { origin, reason, ...(w && { admission_weight_kg: Number(w) }) } }),
    onSuccess: () => { onDone('შენახულია'); inval(); onClose(); } });
  return (
    <Modal title="ეპიზოდი — წონა, წყარო, მიზეზი" onClose={onClose} width={560}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={m.isPending} onClick={() => m.mutate()}>შენახვა</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="წონა შემოსვლისას (კგ)" htmlFor="ie-w" hint="ვაზოპრესორების დოზა წონაზე — ამ წონით"><input id="ie-w" className="input mono" type="number" min={0.3} max={400} step="0.1" value={w} onChange={(e) => setW(e.target.value)} /></Field>
          <Field label="საიდან" htmlFor="ie-o"><select id="ie-o" className="select" value={origin} onChange={(e) => setOrigin(e.target.value)}>
            {Object.entries(ORIGIN_KA).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        </div>
        <Field label="შემოსვლის მიზეზი" htmlFor="ie-r"><textarea id="ie-r" className="textarea" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="მაგ. სეპტიკური შოკი, სუნთქვის უკმარისობა" /></Field>
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}
function IntervalDialog({ ep, d, onClose, onDone, inval }: { ep: Episode; d: IcuStay; onClose: () => void; onDone: (m: string) => void; inval: () => void }) {
  const [min, setMin] = useState<number | null>(ep.monitor_interval_min ?? 15); const [hours, setHours] = useState(Math.min(6, d.fast_max_hours ?? 12)); const [reason, setReason] = useState('');
  const m = useMutation({ mutationFn: (x: number | null) => api(`/inpatient/icu/episodes/${ep.id}/interval`, { body: { interval_min: x, hours, reason: reason.trim() || undefined } }),
    onSuccess: (_r, x) => { onDone(x ? `ფურცელი: ყოველ ${x} წთ, ${hours} სთ` : `ფურცელი: ნაგულისხმევი (${d.default_interval} წთ)`); inval(); onClose(); } });
  return (
    <Modal title="ფურცლის ინტერვალი — ამ პაციენტზე" onClose={onClose} width={520}
      footer={<>{ep.monitor_interval_min && <button className="btn" type="button" style={{ marginRight: 'auto' }} disabled={m.isPending} onClick={() => m.mutate(null)}>ნაგულისხმევზე დაბრუნება</button>}
        <button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={m.isPending || !min} onClick={() => m.mutate(min)}>ჩართვა</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <span className="small muted">განყოფილების ინტერვალი: {d.default_interval} წთ. არასტაბილურ პერიოდში — უფრო ხშირი, დროებით (ვინ / როდის — ისტორიაში).</span>
        <div className="seg" role="group" aria-label="ინტერვალი" style={{ width: 'max-content' }}>
          {[15, 30, 60].map((x) => <button key={x} type="button" aria-pressed={min === x} onClick={() => setMin(x)}>{x} წთ</button>)}</div>
        <Field label={`ხანგრძლივობა (სთ, მაქს. ${d.fast_max_hours})`} htmlFor="ii-h"><input id="ii-h" className="input mono" style={{ maxWidth: 140 }} type="number" min={1} max={d.fast_max_hours} value={hours} onChange={(e) => setHours(Number(e.target.value))} /></Field>
        <Field label="მიზეზი" htmlFor="ii-r"><input id="ii-r" className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="მაგ. ვაზოპრესორის ტიტრაცია" /></Field>
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- მონიტორინგის ფურცელი
const OBS_GROUPS: string[][] = [['systolic_bp', 'diastolic_bp'], ['map_mmhg', 'map_invasive'], ['gcs_e', 'gcs_v', 'gcs_m', 'gcs_intubated', 'gcs_total'],
  ['pupil_l', 'pupil_r', 'pupil_l_react', 'pupil_r_react']];
function SheetTab({ encounterId, d, toast, inval }: { encounterId: string; d: IcuStay; toast: (m: string) => void; inval: () => void }) {
  const [day, setDay] = useState<string | undefined>(undefined);
  const q = useQuery({ queryKey: ['ipd-icu-sheet', encounterId, day ?? ''], queryFn: () => api<Sheet>(`/inpatient/stays/${encounterId}/icu/sheet`, { query: day ? { day } : {} }), refetchInterval: 60_000 });
  const [add, setAdd] = useState(false); const [vo, setVo] = useState<Obs | null>(null);
  const s = q.data;
  const grid = useMemo(() => {
    if (!s) return null;
    const slotT = s.slots.map((x) => new Date(x).getTime()); const endT = new Date(s.end).getTime();
    const idx = (iso: string) => { const t = new Date(iso).getTime(); for (let i = slotT.length - 1; i >= 0; i--) if (t >= slotT[i]) return t < (slotT[i + 1] ?? endT) ? i : -1; return -1; };
    const obs: (Obs | null)[] = s.slots.map(() => null); const vs: (VentSettings | null)[] = s.slots.map(() => null);
    // ერთ სლოტში რამდენიმე ჩანაწერი ერწყმის (გვიანდელი იმარჯვებს), მაგრამ ერთი გაზომვის ველები — მხოლოდ ჯგუფად:
    // წნევა (სისტ. / დიასტ.), MAP (+ ინვაზიური), GCS (E / V / M / T), გუგები — სხვადასხვა ჩანაწერიდან არ ერევა ერთმანეთს
    for (const v of s.vitals) {
      const i = idx(v.recorded_at); if (i < 0) continue;
      const cur: Record<string, unknown> = { ...(obs[i] ?? {}) }; const row = v as unknown as Record<string, unknown>; const done = new Set<string>();
      for (const g of OBS_GROUPS) {
        g.forEach((k) => done.add(k));
        if (g.some((k) => row[k] !== null && row[k] !== undefined && row[k] !== false)) for (const k of g) cur[k] = row[k];
      }
      for (const [k, x] of Object.entries(row)) if (!done.has(k) && x !== null) cur[k] = x;
      obs[i] = cur as unknown as Obs;
    }
    for (const v of s.vent) { const i = idx(v.recorded_at); if (i >= 0) vs[i] = v; }
    const hourOf = (i: number) => Math.min(23, Math.floor((slotT[i] - new Date(s.start).getTime()) / 3_600_000));
    return { obs, vs, hourOf, gap: new Set(s.gaps) };
  }, [s]);
  // ფურცელი იხსნება მიმდინარე საათზე (დღეს) ან ბოლო შევსებულ სვეტზე (წინა დღე) — 24-სვეტიანი ბადე ეკრანზე არ ეტევა
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scroller.current; if (!s || !grid || !el) return;
    const now = Date.now(); let i = -1;
    if (s.day === s.today) { for (let k = s.slots.length - 1; k >= 0; k--) if (new Date(s.slots[k]).getTime() <= now) { i = k; break; } }
    else for (let k = grid.obs.length - 1; k >= 0; k--) if (grid.obs[k] || grid.vs[k]) { i = k; break; }
    const th = el.querySelectorAll('thead th')[i + 1] as HTMLElement | undefined;
    if (th) el.scrollLeft = Math.max(0, th.offsetLeft + th.offsetWidth - el.clientWidth + 92);
  }, [s?.day, !!grid]);   // eslint-disable-line react-hooks/exhaustive-deps
  if (q.isLoading) return <Loading />;
  if (!s || !grid) return <ErrorBox error={q.error} />;
  const cols = s.slots;
  const row = (label: string, get: (i: number) => ReactNode, cls?: (i: number) => string, unit?: string) => (
    <tr><th style={{ position: 'sticky', left: 0, background: 'var(--surface)', whiteSpace: 'nowrap', fontWeight: 600 }}>{label}{unit && <span className="small muted"> {unit}</span>}</th>
      {cols.map((c, i) => { const x = cls?.(i) ?? ''; return <td key={c} className="mono" style={{ textAlign: 'center', padding: '4px 6px', fontSize: 12,
        background: x === 'danger' ? 'var(--danger-weak)' : x === 'warn' ? 'var(--warn-weak)' : grid.gap.has(c) ? 'var(--warn-weak)' : undefined,
        color: x === 'danger' ? 'var(--danger-ink)' : undefined, fontWeight: x ? 600 : undefined }}>{get(i)}</td>; })}</tr>);
  const o = (i: number) => grid.obs[i];
  const range = (v: number | null | undefined, lo: number, hi: number) => (v === null || v === undefined ? '' : v < lo || v > hi ? 'danger' : '');
  const hourCell = (i: number) => (i === 0 || grid.hourOf(i) !== grid.hourOf(i - 1));
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {s.can_write && <button className="btn primary sm" type="button" onClick={() => setAdd(true)}>+ დაკვირვება</button>}
        <button className="btn sm" type="button" aria-label="წინა დღე" onClick={() => setDay(shiftDay(s.day, -1))}>←</button>
        <strong>{s.day.split('-').reverse().join('/')} {s.day_start} — 24 სთ</strong>
        <button className="btn sm" type="button" aria-label="შემდეგი დღე" disabled={s.day >= s.today} onClick={() => setDay(shiftDay(s.day, 1))}>→</button>
        {s.day !== s.today && <button className="btn sm" type="button" onClick={() => setDay(undefined)}>დღეს</button>}
        <span className="chip">ინტერვალი {s.interval_min} წთ</span>
        {s.gaps.length > 0 && <span className="chip warn">შეუვსებელი სლოტი: {s.gaps.length}</span>}
        <span className="grow" />
        <span className="small">ბალანსი: <strong className="mono">+{Math.round(s.totals.in)} / −{Math.round(s.totals.out)} = {sgn(s.totals.net)} მლ</strong></span>
      </div>
      <div ref={scroller} style={{ overflowX: 'auto', border: '1px solid var(--line-soft)', borderRadius: 8 }}>
        <table className="table" style={{ minWidth: 120 + cols.length * 46 }}>
          <thead><tr><th style={{ position: 'sticky', left: 0, background: 'var(--surface)' }}>დრო</th>{cols.map((c) => <Th key={c}>{hhmm(c)}</Th>)}</tr></thead>
          <tbody>
            {row('პულსი', (i) => o(i)?.heart_rate ?? '', (i) => range(o(i)?.heart_rate, 50, 120), '/წთ')}
            {row('წნევა', (i) => (o(i)?.systolic_bp ? `${o(i)!.systolic_bp}/${o(i)!.diastolic_bp ?? '–'}` : ''), (i) => range(o(i)?.systolic_bp, 90, 180))}
            {row('MAP', (i) => (o(i)?.map_mmhg ? `${o(i)!.map_mmhg}${o(i)!.map_invasive ? 'ᵃ' : ''}` : ''), (i) => range(o(i)?.map_mmhg, 65, 110), 'მმ')}
            {row('სუნთქვა', (i) => o(i)?.respiratory_rate ?? '', (i) => range(o(i)?.respiratory_rate, 8, 30), '/წთ')}
            {row('SpO₂', (i) => o(i)?.spo2 ?? '', (i) => range(o(i)?.spo2, 92, 100), '%')}
            {row('ტ°', (i) => f1(o(i)?.temperature), (i) => range(n(o(i)?.temperature), 35.5, 38.4))}
            {row('CVP', (i) => o(i)?.cvp ?? '', undefined, 'მმ')}
            {row('EtCO₂', (i) => o(i)?.etco2 ?? '', (i) => range(o(i)?.etco2, 30, 50), 'მმ')}
            {row('GCS', (i) => (o(i)?.gcs_total ? `${o(i)!.gcs_total} (E${o(i)!.gcs_e ?? '–'} V${o(i)!.gcs_intubated ? 'T' : o(i)!.gcs_v ?? '–'} M${o(i)!.gcs_m ?? '–'})` : ''), (i) => (o(i)?.gcs_total && o(i)!.gcs_total! <= 8 ? 'warn' : ''))}
            {row('RASS', (i) => (o(i)?.rass ?? '') === '' ? '' : `${o(i)!.rass! > 0 ? '+' : ''}${o(i)!.rass}`, (i) => (o(i)?.rass !== null && o(i)?.rass !== undefined && (o(i)!.rass! > 1 || o(i)!.rass! < -3) ? 'warn' : ''))}
            {row('გუგები', (i) => (o(i)?.pupil_l ? `${f1(o(i)!.pupil_l)}/${f1(o(i)!.pupil_r)}` : ''), (i) => (o(i)?.pupil_l_react === 'fixed' || o(i)?.pupil_r_react === 'fixed' ? 'danger' : ''), 'მმ')}
            {s.vent.length > 0 && <>
              <tr><th colSpan={cols.length + 1} className="small muted" style={{ background: 'var(--line-soft)' }}><span style={{ position: 'sticky', left: 12 }}>ვენტილაცია</span></th></tr>
              {row('რეჟიმი', (i) => grid.vs[i]?.mode ?? '')}
              {row('FiO₂', (i) => grid.vs[i]?.fio2 ?? '', (i) => (grid.vs[i]?.fio2 && grid.vs[i]!.fio2! >= 60 ? 'warn' : ''), '%')}
              {row('PEEP', (i) => f1(grid.vs[i]?.peep))}
              {row('Vt', (i) => grid.vs[i]?.vt_ml ?? '', undefined, 'მლ')}
              {row('f', (i) => grid.vs[i]?.rate_set ?? grid.vs[i]?.rate_total ?? '')}
              {row('Ppeak / Pplat', (i) => (grid.vs[i]?.ppeak ? `${grid.vs[i]!.ppeak}/${grid.vs[i]!.pplat ?? '–'}` : ''), (i) => (grid.vs[i]?.pplat && grid.vs[i]!.pplat! > 30 ? 'danger' : ''))}
            </>}
            {s.infusions.length > 0 && <>
              <tr><th colSpan={cols.length + 1} className="small muted" style={{ background: 'var(--line-soft)' }}><span style={{ position: 'sticky', left: 12 }}>ინფუზიები (საათის დასაწყისში: მლ/სთ{s.infusions.some((x) => x.unit) ? ' · დოზა' : ''})</span></th></tr>
              {s.infusions.map((inf) => row(inf.title.length > 22 ? `${inf.title.slice(0, 21)}…` : inf.title, (i) => {
                if (!hourCell(i)) return '';
                const h = inf.hours?.[grid.hourOf(i)]; if (!h || !h.rate_ml_h) return '';
                return <span title={`${h.volume_ml} მლ ამ საათში`}>{f1(h.rate_ml_h)}{h.dose_rate !== null && inf.unit ? <div className="small muted">{f3(h.dose_rate)}</div> : null}</span>;
              }))}
            </>}
            <tr><th colSpan={cols.length + 1} className="small muted" style={{ background: 'var(--line-soft)' }}><span style={{ position: 'sticky', left: 12 }}>ბალანსი (საათობრივად, მლ)</span></th></tr>
            {row('მიღება', (i) => (hourCell(i) && s.balance[grid.hourOf(i)]?.in ? Math.round(s.balance[grid.hourOf(i)].in) : ''))}
            {row('გამოყოფა', (i) => (hourCell(i) && s.balance[grid.hourOf(i)]?.out ? Math.round(s.balance[grid.hourOf(i)].out) : ''))}
            {row('შარდი', (i) => (hourCell(i) && s.balance[grid.hourOf(i)]?.by.urine ? Math.round(s.balance[grid.hourOf(i)].by.urine) : ''), (i) => (hourCell(i) && d.weight && s.balance[grid.hourOf(i)]
              && new Date(s.balance[grid.hourOf(i)].at).getTime() + 3_600_000 < Date.now() && (s.balance[grid.hourOf(i)].by.urine ?? 0) < 0.5 * d.weight ? 'warn' : ''))}
            {row('ჯამური', (i) => (hourCell(i) && (s.balance[grid.hourOf(i)]?.in || s.balance[grid.hourOf(i)]?.out) ? sgn(s.balance[grid.hourOf(i)].cumulative) : ''))}
          </tbody>
        </table>
      </div>
      <div className="small muted">ყვითელი სვეტი — სლოტი გავიდა, ჩანაწერი არ არის. ᵃ — არტერიული (ინვაზიური) MAP. შარდი ყვითლად — &lt; 0.5 მლ/კგ/სთ. ინფუზიების მოცულობა ბალანსში ემატება ავტომატურად (დასრულებული საათები).</div>
      {s.abg.length > 0 && <div className="small"><span className="label">ABG ამ დღეს: </span>{s.abg.map((a) => `${hhmm(a.sampled_at)} pH ${a.ph ?? '–'} pO₂ ${a.po2 ?? '–'} pCO₂ ${a.pco2 ?? '–'}${a.pf ? ` P/F ${a.pf}` : ''}`).join(' · ')}</div>}
      {s.vitals.filter((v) => v.icu_sheet).length > 0 && <details><summary className="small">ჩანაწერები ({s.vitals.filter((v) => v.icu_sheet).length}) — გაუქმება</summary>
        <table className="table"><tbody>{s.vitals.filter((v) => v.icu_sheet).map((v) => <tr key={v.id}><td className="small">{dt(v.recorded_at)}</td><td className="small">{v.taken_by_name}</td><td className="small muted">{v.notes}</td>
          <td>{s.can_write && <button className="btn sm" type="button" onClick={() => setVo(v)}>გაუქმება</button>}</td></tr>)}</tbody></table></details>}
      {add && <ObservationDialog encounterId={encounterId} intubated={d.current_vent?.kind === 'invasive'} onClose={() => setAdd(false)} onDone={toast} inval={inval} />}
      {vo && <VoidDialog kind="vitals" id={vo.id} title={`დაკვირვება ${dt(vo.recorded_at)}`} onClose={() => setVo(null)} onDone={toast} inval={inval} />}
    </div>
  );
}

function ObservationDialog({ encounterId, intubated, onClose, onDone, inval }: { encounterId: string; intubated: boolean; onClose: () => void; onDone: (m: string) => void; inval: () => void }) {
  const [f, setF] = useState<Record<string, string>>({ time: nowHM(), intub: intubated ? '1' : '' });
  const set = (k: string) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const nv = (k: string) => (f[k] !== undefined && f[k] !== '' ? Number(f[k]) : undefined);
  const mapCalc = nv('map_mmhg') ?? (nv('systolic_bp') && nv('diastolic_bp') ? Math.round((nv('systolic_bp')! + 2 * nv('diastolic_bp')!) / 3) : undefined);
  const gcs = nv('gcs_e') && nv('gcs_m') && (f.intub || nv('gcs_v')) ? nv('gcs_e')! + nv('gcs_m')! + (f.intub ? 1 : nv('gcs_v')!) : undefined;
  const m = useMutation({
    mutationFn: () => {
      const b: Record<string, unknown> = { recorded_at: atISO(f.time), notes: f.notes?.trim() || undefined };
      for (const k of ['systolic_bp', 'diastolic_bp', 'map_mmhg', 'heart_rate', 'respiratory_rate', 'spo2', 'temperature', 'cvp', 'etco2', 'pupil_l', 'pupil_r', 'gcs_e', 'gcs_m', 'rass', 'urine_ml', 'glucose'])
        if (nv(k) !== undefined) b[k] = nv(k);
      if (!f.intub && nv('gcs_v') !== undefined) b.gcs_v = nv('gcs_v');
      if (f.intub && (nv('gcs_e') || nv('gcs_m'))) b.gcs_intubated = true;
      if (nv('map_mmhg') !== undefined) b.map_invasive = !!f.art;
      if (f.pupil_l_react && nv('pupil_l')) b.pupil_l_react = f.pupil_l_react;
      if (f.pupil_r_react && nv('pupil_r')) b.pupil_r_react = f.pupil_r_react;
      return api(`/inpatient/stays/${encounterId}/icu/observations`, { body: b });
    },
    onSuccess: () => { onDone('დაკვირვება ჩაიწერა'); inval(); onClose(); },
  });
  const inp = (k: string, label: string, ph = '', step = '1') => <Field label={label} htmlFor={`io-${k}`}><input id={`io-${k}`} className="input mono" type="number" step={step} inputMode="decimal" value={f[k] ?? ''} onChange={set(k)} placeholder={ph} /></Field>;
  const sel = (k: string, label: string, opts: [string, string][]) => <Field label={label} htmlFor={`io-${k}`}><select id={`io-${k}`} className="select" value={f[k] ?? ''} onChange={set(k)}>
    <option value="">—</option>{opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>;
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: 10 } as const;
  return (
    <Modal title="მონიტორინგი — დაკვირვება" onClose={onClose} width={900}
      footer={<><span className="small muted" style={{ marginRight: 'auto' }}>{mapCalc ? `MAP ${mapCalc}` : ''}{gcs ? ` · GCS ${gcs}` : ''}</span>
        <button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={m.isPending} onClick={() => m.mutate()}>შენახვა</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <div style={grid}>
          <Field label="დრო" htmlFor="io-t"><input id="io-t" className="input" type="time" value={f.time} onChange={set('time')} /></Field>
          {inp('heart_rate', 'პულსი', '90')}{inp('systolic_bp', 'სისტოლური', '110')}{inp('diastolic_bp', 'დიასტოლური', '60')}
          <Field label="MAP (არტერიული)" htmlFor="io-map" hint={!f.map_mmhg && mapCalc ? `გამოთვლით ${mapCalc}` : undefined}>
            <div className="row" style={{ gap: 6 }}><input id="io-map" className="input mono" type="number" value={f.map_mmhg ?? ''} onChange={set('map_mmhg')} />
              <label className="row small" title="არტერიული ხაზიდან"><input type="checkbox" checked={!!f.art} onChange={(e) => setF((x) => ({ ...x, art: e.target.checked ? '1' : '' }))} />ა</label></div></Field>
          {inp('respiratory_rate', 'სუნთქვა', '16')}{inp('spo2', 'SpO₂ %', '96')}{inp('temperature', 'ტემპერატურა', '37.0', '0.1')}{inp('cvp', 'CVP მმ', '8')}{inp('etco2', 'EtCO₂ მმ', '38')}
        </div>
        <div style={grid}>
          {sel('gcs_e', 'GCS — E', [['4', '4 სპონტ.'], ['3', '3 ხმაზე'], ['2', '2 ტკივილზე'], ['1', '1 არა']])}
          {f.intub ? <Field label="GCS — V" htmlFor="io-gv"><input id="io-gv" className="input" disabled value="T (ინტუბირებული)" /></Field>
            : sel('gcs_v', 'GCS — V', [['5', '5 ორიენტ.'], ['4', '4 დაბნეული'], ['3', '3 სიტყვები'], ['2', '2 ბგერები'], ['1', '1 არა']])}
          {sel('gcs_m', 'GCS — M', [['6', '6 ბრძანება'], ['5', '5 ლოკალიზ.'], ['4', '4 უკუწევა'], ['3', '3 ფლექსია'], ['2', '2 ექსტენზია'], ['1', '1 არა']])}
          <Field label="ინტუბირებული" htmlFor="io-in"><label className="row" style={{ height: 40 }}><input id="io-in" type="checkbox" checked={!!f.intub} onChange={(e) => setF((x) => ({ ...x, intub: e.target.checked ? '1' : '', gcs_v: '' }))} /> V = T</label></Field>
          {sel('rass', 'RASS', [['4', '+4'], ['3', '+3'], ['2', '+2'], ['1', '+1'], ['0', '0'], ['-1', '−1'], ['-2', '−2'], ['-3', '−3'], ['-4', '−4'], ['-5', '−5']])}
          {inp('pupil_l', 'გუგა მარცხ. მმ', '3', '0.5')}{sel('pupil_l_react', 'რეაქცია (მ)', Object.entries(PUPIL_KA))}{inp('pupil_r', 'გუგა მარჯვ. მმ', '3', '0.5')}{sel('pupil_r_react', 'რეაქცია (მრ)', Object.entries(PUPIL_KA))}
          {inp('urine_ml', 'შარდი მლ', '', '1')}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 4fr', gap: 10 }}>
          {inp('glucose', 'გლუკოზა', '', '0.1')}
          <Field label="შენიშვნა" htmlFor="io-n"><input id="io-n" className="input" value={f.notes ?? ''} onChange={set('notes')} /></Field>
        </div>
        <span className="small muted">შარდი ავტომატურად ჩაიწერება სითხის ბალანსში (გამოყოფა). ცარიელი ველები არ ინახება.</span>
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- ვენტილაცია
function VentTab({ encounterId, d, toast, inval }: { encounterId: string; d: IcuStay; toast: (m: string) => void; inval: () => void }) {
  const [dlg, setDlg] = useState<'start' | 'settings' | 'end' | null>(null); const [vo, setVo] = useState<{ kind: string; id: string; title: string } | null>(null);
  const sheet = useQuery({ queryKey: ['ipd-icu-sheet', encounterId, ''], queryFn: () => api<Sheet>(`/inpatient/stays/${encounterId}/icu/sheet`) });
  const cv = d.current_vent; const can = !!d.can_write && !!d.episode && d.features.includes('ventilation');
  const hist = (d.ventilation ?? []);
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {can && !cv && <button className="btn primary sm" type="button" onClick={() => setDlg('start')}>+ ვენტილაციის დაწყება / ინტუბაცია</button>}
        {can && cv && <><button className="btn primary sm" type="button" onClick={() => setDlg('settings')}>+ პარამეტრები</button><button className="btn sm" type="button" onClick={() => setDlg('end')}>დასრულება / ექსტუბაცია</button></>}
        <span className="grow" /><span className="small muted">ინვაზიური ვენტილაციის დღე (ბილინგი): {d.vent_days ?? 0}</span>
      </div>
      {cv && <div className="alert info row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <strong>{VENT_KA[cv.kind]}</strong><span>{AIRWAY_KA[cv.airway]}{cv.ett_size ? ` №${f1(cv.ett_size)}` : ''}{cv.ett_depth_cm ? `, ${f1(cv.ett_depth_cm)} სმ` : ''}</span>
        <span>{dt(cv.started_at)}-დან · {cv.days} დღე</span>{cv.performed_by_name && <span className="small">ინტუბაცია: {cv.performed_by_name}</span>}{cv.performed_where && <span className="small">({cv.performed_where})</span>}
        {cv.difficult && <span className="chip danger">რთული სასუნთქი გზები</span>}
        {d.last_settings && <span className="mono">{d.last_settings.mode}{d.last_settings.fio2 ? ` · FiO₂ ${d.last_settings.fio2}%` : ''}{d.last_settings.peep ? ` · PEEP ${f1(d.last_settings.peep)}` : ''}{d.last_settings.vt_ml ? ` · Vt ${d.last_settings.vt_ml}` : ''}</span>}
      </div>}
      {(sheet.data?.vent.length ?? 0) > 0 && <div style={{ overflowX: 'auto' }}><table className="table" style={{ minWidth: 900 }}>
        <thead><tr><th>დრო</th><th>რეჟიმი</th><Th>FiO₂</Th><Th>PEEP</Th><Th>Vt</Th><Th>f (დაყ./სულ)</Th><Th>Ppeak</Th><Th>Pplat</Th><Th>PS</Th><Th>IPAP/EPAP</Th><Th>ნაკადი</Th><Th>MV</Th><th>ვინ</th><th /></tr></thead>
        <tbody>{sheet.data!.vent.map((s) => <tr key={s.id}><td className="small">{dt(s.recorded_at)}</td><td><strong>{s.mode}</strong></td><td className="mono" style={{ textAlign: 'center' }}>{s.fio2 ?? ''}</td>
          <td className="mono" style={{ textAlign: 'center' }}>{f1(s.peep)}</td><td className="mono" style={{ textAlign: 'center' }}>{s.vt_ml ?? ''}</td><td className="mono" style={{ textAlign: 'center' }}>{s.rate_set ?? ''}{s.rate_total ? `/${s.rate_total}` : ''}</td>
          <td className="mono" style={{ textAlign: 'center' }}>{s.ppeak ?? ''}</td><td className="mono" style={{ textAlign: 'center' }}>{s.pplat ?? ''}</td><td className="mono" style={{ textAlign: 'center' }}>{f1(s.ps)}</td>
          <td className="mono" style={{ textAlign: 'center' }}>{s.ipap ? `${f1(s.ipap)}/${f1(s.epap)}` : ''}</td><td className="mono" style={{ textAlign: 'center' }}>{s.flow_lpm ?? ''}</td><td className="mono" style={{ textAlign: 'center' }}>{f1(s.mv_l)}</td>
          <td className="small muted">{s.recorded_by_name}</td><td>{can && <button className="btn sm" type="button" onClick={() => setVo({ kind: 'vent_settings', id: s.id, title: `${s.mode} ${dt(s.recorded_at)}` })}>გაუქმება</button>}</td></tr>)}</tbody></table></div>}
      {hist.length > 0 && <table className="table"><thead><tr><th>ტიპი</th><th>დაწყება</th><th>დასრულება</th><th>ხანგრძლ.</th><th>ვინ</th><th /></tr></thead>
        <tbody>{hist.map((v) => <tr key={v.id} style={{ opacity: v.voided_at ? 0.5 : 1, textDecoration: v.voided_at ? 'line-through' : undefined }} title={v.void_reason ?? v.notes ?? ''}>
          <td>{VENT_KA[v.kind]} <span className="small muted">{AIRWAY_KA[v.airway]}{v.ett_size ? ` №${f1(v.ett_size)}` : ''}</span></td><td className="small">{dt(v.started_at)}</td>
          <td className="small">{v.ended_at ? `${dt(v.ended_at)} · ${VEND_KA[v.end_reason ?? ''] ?? v.end_reason}` : <span className="chip ok">მიმდინარე</span>}</td><td className="mono">{v.days} დღე</td>
          <td className="small muted">{v.performed_by_name ?? v.created_by_name}</td>
          <td>{can && !v.voided_at && <button className="btn sm" type="button" onClick={() => setVo({ kind: 'ventilation', id: v.id, title: `${VENT_KA[v.kind]} ${dt(v.started_at)}` })}>გაუქმება</button>}</td></tr>)}</tbody></table>}
      {!hist.length && <span className="muted">ვენტილაცია არ ყოფილა.</span>}
      {dlg === 'start' && <VentStartDialog encounterId={encounterId} d={d} onClose={() => setDlg(null)} onDone={toast} inval={inval} />}
      {dlg === 'settings' && cv && <VentSettingsDialog vent={cv} d={d} onClose={() => setDlg(null)} onDone={toast} inval={inval} />}
      {dlg === 'end' && cv && <VentEndDialog vent={cv} onClose={() => setDlg(null)} onDone={toast} inval={inval} />}
      {vo && <VoidDialog kind={vo.kind} id={vo.id} title={vo.title} onClose={() => setVo(null)} onDone={toast} inval={inval} />}
    </div>
  );
}
function SettingsFields({ f, set, kind, modes }: { f: Record<string, string>; set: (k: string) => (e: { target: { value: string } }) => void; kind: string; modes: string[] }) {
  const inp = (k: string, label: string, step = '1') => <Field label={label} htmlFor={`vs-${k}`}><input id={`vs-${k}`} className="input mono" type="number" step={step} value={f[k] ?? ''} onChange={set(k)} /></Field>;
  return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: 10 }}>
    <Field label="რეჟიმი" htmlFor="vs-mode" required><input id="vs-mode" className="input" list="vs-modes" value={f.mode ?? ''} onChange={set('mode')} /><datalist id="vs-modes">{modes.map((m) => <option key={m} value={m} />)}</datalist></Field>
    {inp('fio2', 'FiO₂ %')}{kind !== 'hfnc' && inp('peep', kind === 'niv' ? 'EPAP / PEEP' : 'PEEP', '0.5')}
    {kind === 'invasive' && <>{inp('vt_ml', 'Vt მლ')}{inp('rate_set', 'f დაყენებული')}{inp('rate_total', 'f სულ')}{inp('ppeak', 'Ppeak')}{inp('pplat', 'Pplat')}{inp('ps', 'PS', '0.5')}{inp('mv_l', 'MV ლ/წთ', '0.1')}</>}
    {kind === 'niv' && <>{inp('ipap', 'IPAP', '0.5')}{inp('epap', 'EPAP', '0.5')}{inp('rate_set', 'f')}{inp('vt_ml', 'Vt მლ')}</>}
    {kind === 'hfnc' && inp('flow_lpm', 'ნაკადი ლ/წთ')}
  </div>;
}
const settingsBody = (f: Record<string, string>) => {
  const b: Record<string, unknown> = { mode: f.mode?.trim() };
  for (const k of ['fio2', 'peep', 'vt_ml', 'rate_set', 'rate_total', 'ppeak', 'pplat', 'ps', 'ipap', 'epap', 'flow_lpm', 'mv_l']) if (f[k]) b[k] = Number(f[k]);
  return b;
};
function VentStartDialog({ encounterId, d, onClose, onDone, inval }: { encounterId: string; d: IcuStay; onClose: () => void; onDone: (m: string) => void; inval: () => void }) {
  const [f, setF] = useState<Record<string, string>>({ kind: 'invasive', airway: 'ett', time: nowHM(), mode: 'VC-AC', fio2: '60', peep: '5' });
  const set = (k: string) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const m = useMutation({ mutationFn: () => api(`/inpatient/stays/${encounterId}/icu/ventilation`, { body: {
    kind: f.kind, airway: f.airway, started_at: atISO(f.time), performed_by: f.by || undefined, performed_where: f.where?.trim() || undefined,
    ...(f.kind === 'invasive' && f.ett_size && { ett_size: Number(f.ett_size) }), ...(f.kind === 'invasive' && f.ett_depth && { ett_depth_cm: Number(f.ett_depth) }),
    ...(f.attempts && { attempts: Number(f.attempts) }), difficult: !!f.difficult, notes: f.notes?.trim() || undefined,
    ...(f.mode?.trim() && { settings: { ...settingsBody(f), recorded_at: atISO(f.time) } }) } }),
    onSuccess: () => { onDone('ვენტილაცია დაიწყო'); inval(); onClose(); } });
  return (
    <Modal title="ვენტილაციის დაწყება" onClose={onClose} width={860}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={m.isPending} onClick={() => m.mutate()}>შენახვა</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <div className="seg" role="group" aria-label="ტიპი" style={{ width: 'max-content' }}>
          {Object.entries(VENT_KA).map(([k, l]) => <button key={k} type="button" aria-pressed={f.kind === k} onClick={() => setF((x) => ({ ...x, kind: k, airway: AIRWAYS[k][0], mode: k === 'hfnc' ? 'HFNC' : k === 'niv' ? 'BiPAP' : 'VC-AC' }))}>{l}</button>)}</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
          <Field label="დრო" htmlFor="vd-t"><input id="vd-t" className="input" type="time" value={f.time} onChange={set('time')} /></Field>
          <Field label="სასუნთქი გზა" htmlFor="vd-a"><select id="vd-a" className="select" value={f.airway} onChange={set('airway')}>{AIRWAYS[f.kind].map((a) => <option key={a} value={a}>{AIRWAY_KA[a]}</option>)}</select></Field>
          {f.kind === 'invasive' && <>
            <Field label="ტუბის ზომა (№)" htmlFor="vd-s"><input id="vd-s" className="input mono" type="number" step="0.5" value={f.ett_size ?? ''} onChange={set('ett_size')} placeholder="7.5" /></Field>
            <Field label="სიღრმე (სმ, კბილებთან)" htmlFor="vd-dp"><input id="vd-dp" className="input mono" type="number" step="0.5" value={f.ett_depth ?? ''} onChange={set('ett_depth')} placeholder="22" /></Field>
            <Field label="ვინ ინტუბირა" htmlFor="vd-by"><select id="vd-by" className="select" value={f.by ?? ''} onChange={set('by')}><option value="">მე / —</option>{(d.doctors ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
            <Field label="ან სად (სხვაგან)" htmlFor="vd-w"><input id="vd-w" className="input" value={f.where ?? ''} onChange={set('where')} placeholder="მაგ. სასწრაფო, სხვა კლინიკა" /></Field>
            <Field label="მცდელობები" htmlFor="vd-at"><input id="vd-at" className="input mono" type="number" min={1} max={10} value={f.attempts ?? ''} onChange={set('attempts')} /></Field>
            <Field label="რთული სასუნთქი გზები" htmlFor="vd-df"><label className="row" style={{ height: 40 }}><input id="vd-df" type="checkbox" checked={!!f.difficult} onChange={(e) => setF((x) => ({ ...x, difficult: e.target.checked ? '1' : '' }))} /> კი</label></Field>
          </>}
        </div>
        <span className="label">საწყისი პარამეტრები</span>
        <SettingsFields f={f} set={set} kind={f.kind} modes={d.vent_modes ?? []} />
        <Field label="შენიშვნა" htmlFor="vd-n"><input id="vd-n" className="input" value={f.notes ?? ''} onChange={set('notes')} /></Field>
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}
function VentSettingsDialog({ vent, d, onClose, onDone, inval }: { vent: Vent; d: IcuStay; onClose: () => void; onDone: (m: string) => void; inval: () => void }) {
  const ls = d.last_settings;
  const [f, setF] = useState<Record<string, string>>({ time: nowHM(), mode: ls?.mode ?? '', ...Object.fromEntries(Object.entries(ls ?? {}).filter(([k, v]) => v !== null && ['fio2', 'peep', 'vt_ml', 'rate_set', 'ppeak', 'pplat', 'ps', 'ipap', 'epap', 'flow_lpm'].includes(k)).map(([k, v]) => [k, f1(v as string)])) });
  const set = (k: string) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const m = useMutation({ mutationFn: () => api(`/inpatient/icu/ventilation/${vent.id}/settings`, { body: { ...settingsBody(f), recorded_at: atISO(f.time), note: f.note?.trim() || undefined } }),
    onSuccess: () => { onDone('პარამეტრები ჩაიწერა'); inval(); onClose(); } });
  return (
    <Modal title={`ვენტილაციის პარამეტრები — ${VENT_KA[vent.kind]}`} onClose={onClose} width={860}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={m.isPending || (f.mode?.trim().length ?? 0) < 2} onClick={() => m.mutate()}>შენახვა</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <Field label="დრო" htmlFor="vs-t"><input id="vs-t" className="input" style={{ maxWidth: 140 }} type="time" value={f.time} onChange={set('time')} /></Field>
        <SettingsFields f={f} set={set} kind={vent.kind} modes={d.vent_modes ?? []} />
        <Field label="შენიშვნა" htmlFor="vs-n"><input id="vs-n" className="input" value={f.note ?? ''} onChange={set('note')} /></Field>
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}
function VentEndDialog({ vent, onClose, onDone, inval }: { vent: Vent; onClose: () => void; onDone: (m: string) => void; inval: () => void }) {
  const [time, setTime] = useState(nowHM()); const [reason, setReason] = useState(vent.kind === 'invasive' ? 'extubated' : 'switch'); const [note, setNote] = useState('');
  const m = useMutation({ mutationFn: () => api(`/inpatient/icu/ventilation/${vent.id}/end`, { body: { ended_at: atISO(time), reason, note: note.trim() || undefined } }),
    onSuccess: () => { onDone('ვენტილაცია დასრულდა'); inval(); onClose(); } });
  return (
    <Modal title={`დასრულება — ${VENT_KA[vent.kind]}`} onClose={onClose} width={520}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={m.isPending} onClick={() => m.mutate()}>შენახვა</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 12 }}>
          <Field label="დრო" htmlFor="ve-t"><input id="ve-t" className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} /></Field>
          <Field label="მიზეზი" htmlFor="ve-r"><select id="ve-r" className="select" value={reason} onChange={(e) => setReason(e.target.value)}>{Object.entries(VEND_KA).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        </div>
        <Field label="შენიშვნა" htmlFor="ve-n" hint={reason === 'switch' ? 'შემდეგ დაიწყეთ ახალი (მაგ. NIV / HFNC)' : undefined}><input id="ve-n" className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="მაგ. SBT წარმატებული" /></Field>
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- ინფუზიები / ტიტრაცია
function InfusionsTab({ d, toast, inval }: { d: IcuStay; toast: (m: string) => void; inval: () => void }) {
  const [dlg, setDlg] = useState<Infusion | null>(null);
  const list = d.vasoactive ?? [];
  if (!list.length) return <span className="muted">უწყვეტი ინფუზია არ არის. ვაზოპრესორი ინიშნება „დანიშნულებებში“ — უწყვეტი ინფუზია, „დოზა სიჩქარით (ტიტრაცია)“.</span>;
  return (
    <div className="stack" style={{ gap: 12 }}>
      <table className="table"><thead><tr><th>პრეპარატი</th><th>კონცენტრაცია</th><Th>ახლა</Th><Th>დიაპაზონი</Th><th>მიზანი</th><th>ბოლო ცვლილებები</th><th /></tr></thead>
        <tbody>{list.map((o) => {
          const out = o.current_dose_rate !== null && ((o.titrate_min && o.current_dose_rate < Number(o.titrate_min)) || (o.titrate_max && o.current_dose_rate > Number(o.titrate_max)));
          return <tr key={o.id}><td><strong>{o.title}</strong>{o.titratable && <span className="chip info" style={{ marginLeft: 6 }}>ტიტრაცია</span>}{o.status !== 'active' && <span className="chip" style={{ marginLeft: 6 }}>{o.status}</span>}</td>
            <td className="small">{o.conc_amount ? `${f3(o.conc_amount)} ${UNIT_KA[o.conc_unit ?? ''] ?? ''} / ${f1(o.conc_volume_ml)} მლ` : '—'}{o.weight_used && o.unit?.includes('/kg/') ? <div className="muted">{f1(o.weight_used)} კგ</div> : null}</td>
            <td className="mono" style={{ textAlign: 'center', color: out ? 'var(--danger)' : undefined }}>{o.current_rate_ml_h > 0 ? <><strong>{f1(o.current_rate_ml_h)}</strong> მლ/სთ{o.current_dose_rate !== null && o.unit && <div>{f3(o.current_dose_rate)} {UNIT_KA[o.unit]}</div>}</> : <span className="muted">შეჩერებული</span>}</td>
            <td className="mono small" style={{ textAlign: 'center' }}>{o.titrate_min || o.titrate_max ? `${f3(o.titrate_min) || '…'}–${f3(o.titrate_max) || '…'}` : ''}</td>
            <td className="small">{o.titrate_goal}</td>
            <td className="small muted">{o.events.slice(-3).reverse().map((e) => <div key={e.id}>{hhmm(e.documented_at)} {e.infusion_action === 'rate' ? '→' : e.infusion_action} {e.dose_rate ? f3(e.dose_rate) : f1(e.rate_ml_h)}{e.reason ? ` (${e.reason})` : ''} · {e.by_name}</div>)}</td>
            <td>{d.can_write && o.status === 'active' && <button className="btn sm primary" type="button" onClick={() => setDlg(o)}>{o.current_rate_ml_h > 0 ? 'ტიტრაცია' : 'დაწყება'}</button>}</td></tr>;
        })}</tbody></table>
      <span className="small muted">ყოველი ცვლილება — MAR-ში (ვინ / როდის / მიზეზი); დიაპაზონის გარეთ — დასაბუთებით. მოცულობა ავტომატურად ემატება სითხის ბალანსს.</span>
      {dlg && <TitrateDialog o={dlg} onClose={() => setDlg(null)} onDone={toast} inval={inval} />}
    </div>
  );
}
export function TitrateDialog({ o, onClose, onDone, inval }: { o: Infusion; onClose: () => void; onDone: (m: string) => void; inval: () => void }) {
  const running = o.current_rate_ml_h > 0;
  const [action, setAction] = useState<'start' | 'rate' | 'pause' | 'stop'>(running ? 'rate' : 'start');
  const [dose, setDose] = useState(o.current_dose_rate !== null ? f3(o.current_dose_rate) : f3(o.dose_rate)); const [time, setTime] = useState(nowHM());
  const [reason, setReason] = useState(''); const [checks, setChecks] = useState<{ code: string; message: string }[] | null>(null); const [ovr, setOvr] = useState('');
  const conc = { amount: Number(o.conc_amount ?? 0), unit: o.conc_unit ?? '', volume_ml: Number(o.conc_volume_ml ?? 0) };
  const ml = o.unit && dose ? doseToMlH(Number(dose), o.unit, conc, o.weight_used) : null;
  const flowing = action === 'start' || action === 'rate';
  const m = useMutation({
    mutationFn: () => api(`/inpatient/orders/${o.id}/administer`, { body: { outcome: 'given', infusion_action: action, documented_at: atISO(time), ...(flowing && o.unit && dose && { dose_rate: Number(dose) }),
      ...(reason.trim() && { reason: reason.trim() }), ...(checks && ovr.trim() && { override_reason: ovr.trim() }) } }),
    onSuccess: () => { onDone(`${o.title}: ${action === 'rate' ? `${dose} ${UNIT_KA[o.unit ?? ''] ?? ''}` : action === 'start' ? 'დაიწყო' : action === 'pause' ? 'შეჩერდა' : 'დასრულდა'}`); inval(); onClose(); },
    onError: (e) => { if (e instanceof ApiError && e.code === 'MAR_CHECKS') setChecks(e.body?.checks as { code: string; message: string }[]); },
  });
  const out = flowing && dose && ((o.titrate_min && Number(dose) < Number(o.titrate_min)) || (o.titrate_max && Number(dose) > Number(o.titrate_max)));
  const ready = (!flowing || !!dose) && (action !== 'rate' || reason.trim().length >= 2) && (!checks || ovr.trim().length >= 5);
  return (
    <Modal title={`${o.title} — ტიტრაცია`} onClose={onClose} width={560}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={!ready || m.isPending} onClick={() => m.mutate()}>{checks ? 'დასაბუთებით შენახვა' : 'შენახვა'}</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <div className="seg" role="group" aria-label="მოქმედება" style={{ width: 'max-content' }}>
          {(running ? (['rate', 'pause', 'stop'] as const) : (['start', 'stop'] as const)).map((a) => <button key={a} type="button" aria-pressed={action === a} onClick={() => { setAction(a); setChecks(null); }}>
            {a === 'rate' ? 'სიჩქარის ცვლილება' : a === 'start' ? 'დაწყება / განახლება' : a === 'pause' ? 'შეჩერება' : 'დასრულება'}</button>)}</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
          <Field label="დრო" htmlFor="ti-t"><input id="ti-t" className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} /></Field>
          {flowing && o.unit && <Field label={`დოზა (${UNIT_KA[o.unit]})`} htmlFor="ti-d" required><input id="ti-d" className="input mono" type="number" min={0} step="any" value={dose} onChange={(e) => { setDose(e.target.value); setChecks(null); }} /></Field>}
          {flowing && <Field label="სიჩქარე" htmlFor="ti-ml"><input id="ti-ml" className="input mono" disabled value={ml !== null ? `${ml} მლ/სთ` : '—'} /></Field>}
        </div>
        {(o.titrate_min || o.titrate_max) && <span className={`small ${out ? '' : 'muted'}`} style={out ? { color: 'var(--danger)' } : undefined}>დიაპაზონი: {f3(o.titrate_min) || '…'}–{f3(o.titrate_max) || '…'} {UNIT_KA[o.unit ?? '']}{o.titrate_goal ? ` · მიზანი: ${o.titrate_goal}` : ''}{out ? ' — დიაპაზონის გარეთაა (საჭიროა დასაბუთება)' : ''}</span>}
        <Field label="მიზეზი" htmlFor="ti-r" required={action === 'rate'}><input id="ti-r" className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="მაგ. MAP 58; MAP 72 — შემცირება" /></Field>
        {checks && <div className="alert warn stack" style={{ gap: 6 }}><strong>საჭიროა დასაბუთება</strong>
          <ul style={{ margin: 0, paddingLeft: 18 }}>{checks.map((c) => <li key={c.code}>{c.message}</li>)}</ul>
          <textarea className="textarea" rows={2} aria-label="დასაბუთება" value={ovr} onChange={(e) => setOvr(e.target.value)} placeholder="მაგ. ექიმის ზეპირი მითითება (მინ. 5 სიმბოლო)" /></div>}
        <ErrorBox error={m.error instanceof ApiError && m.error.code === 'MAR_CHECKS' ? null : m.error} />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- SOFA / APACHE II
function ScoresTab({ encounterId, d, toast, inval }: { encounterId: string; d: IcuStay; toast: (m: string) => void; inval: () => void }) {
  const [dlg, setDlg] = useState<'sofa' | 'apache2' | null>(null); const [vo, setVo] = useState<Score | null>(null); const [open, setOpen] = useState<string | null>(null);
  const list = d.scores ?? []; const sofa = list.filter((x) => x.kind === 'sofa' && !x.voided_at).sort((a, b) => a.day.localeCompare(b.day));
  const ep = d.episode;
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {d.can_doctor && ep && d.features.includes('sofa') && <button className="btn primary sm" type="button" onClick={() => setDlg('sofa')}>SOFA — {d.sofa_today ? 'ხელახლა (გაუქმების შემდეგ)' : 'დღევანდელი'}</button>}
        {d.can_doctor && ep && d.features.includes('apache') && !d.apache_done && <button className="btn sm" type="button" onClick={() => setDlg('apache2')}>APACHE II (პირველი 24 სთ)</button>}
        {ep && d.features.includes('sofa') && !d.sofa_today && <span className="chip warn">SOFA დღეს არ დადასტურებულა</span>}
        <span className="grow" /><span className="small muted">შევსება ნახევრად ავტომატურია — ექიმი ადასტურებს. დაუდგენელი კომპონენტი ნორმად არ ითვლება.</span>
      </div>
      {sofa.length > 1 && <div className="row" style={{ gap: 4, alignItems: 'flex-end', height: 60 }} aria-label="SOFA დინამიკა">
        {sofa.map((s) => <div key={s.id} className="stack" style={{ gap: 2, alignItems: 'center' }} title={`${s.day}: ${s.total}`}>
          <div style={{ width: 22, height: Math.max(4, s.total * 2.2), background: s.total >= 12 ? 'var(--danger)' : s.total >= 7 ? 'var(--warn-ink)' : 'var(--ok-ink)', borderRadius: 3 }} />
          <span className="small mono">{s.total}</span></div>)}</div>}
      {!list.length ? <span className="muted">შეფასება არ არის.</span> : <table className="table"><thead><tr><th>შკალა</th><th>დღე / ფანჯარა</th><Th>ჯამი</Th><th>დაუდგენელი</th><th>სიკვდ. რისკი</th><th>ვინ</th><th /></tr></thead>
        <tbody>{list.map((s) => <Fragment key={s.id}><tr style={{ opacity: s.voided_at ? 0.5 : 1, textDecoration: s.voided_at ? 'line-through' : undefined, cursor: 'pointer' }} title={s.void_reason ?? ''} onClick={() => setOpen(open === s.id ? null : s.id)}>
          <td><strong>{s.kind === 'sofa' ? 'SOFA' : 'APACHE II'}</strong></td><td className="small">{s.day.split('-').reverse().join('/')} <span className="muted">{hhmm(s.window_from)}–{hhmm(s.window_to)}</span></td>
          <td className="mono" style={{ textAlign: 'center', fontWeight: 700 }}>{s.total}</td>
          <td className="small">{s.missing.length ? <span className="chip danger">{s.missing.length}</span> : ''}</td>
          <td className="small">{s.predicted_mortality ? `${f1(s.predicted_mortality)}%${s.category_name ? ` · ${s.category_name}` : ''}` : ''}</td>
          <td className="small muted">{s.confirmed_by_name}</td>
          <td>{d.can_doctor && !s.voided_at && <button className="btn sm" type="button" onClick={(e) => { e.stopPropagation(); setVo(s); }}>გაუქმება</button>}</td></tr>
          {open === s.id && <tr><td colSpan={7}><ComponentsTable comps={Object.values(s.components)} /></td></tr>}</Fragment>)}</tbody></table>}
      {dlg && <ScoreDialog encounterId={encounterId} kind={dlg} d={d} onClose={() => setDlg(null)} onDone={toast} inval={inval} />}
      {vo && <VoidDialog kind="score" id={vo.id} title={`${vo.kind === 'sofa' ? 'SOFA' : 'APACHE II'} ${vo.total}`} onClose={() => setVo(null)} onDone={toast} inval={inval} />}
    </div>
  );
}
function ComponentsTable({ comps, edit, setEdit }: { comps: Component[]; edit?: Record<string, string>; setEdit?: (k: string, v: string) => void }) {
  return <table className="table"><thead><tr><th>კომპონენტი</th><Th>მნიშვნელობა</Th><Th>ქულა</Th><th>წყარო</th><th>დეტალი</th>{setEdit && <th>ხელით</th>}</tr></thead>
    <tbody>{comps.map((c) => <tr key={c.key} style={c.points === null ? { background: 'var(--danger-weak)' } : undefined}>
      <td>{c.label}</td><td className="mono" style={{ textAlign: 'center' }}>{c.value ?? '—'} <span className="small muted">{c.unit}</span></td>
      <td className="mono" style={{ textAlign: 'center', fontWeight: 700 }}>{c.points ?? '?'}</td>
      <td><span className={`chip ${SOURCE_KA[c.source][0]}`}>{SOURCE_KA[c.source][1]}</span></td>
      <td className="small muted">{c.detail}{c.at ? ` · ${dt(c.at)}` : ''}</td>
      {setEdit && <td>{!['age', 'chronic'].includes(c.key) && <input className="input mono" style={{ width: 90, height: 32 }} aria-label={`${c.label} — ხელით`} type="number" step="any" value={edit?.[c.key] ?? ''} onChange={(e) => setEdit(c.key, e.target.value)} />}</td>}
    </tr>)}</tbody></table>;
}
// კომპონენტის გასაღები → overrides-ის გასაღები (SOFA)
const SOFA_OVR: Record<string, string> = { resp: 'pf', coag: 'platelets', liver: 'bilirubin', cv: 'cv_points', cns: 'gcs', renal: 'creatinine' };
function ScoreDialog({ encounterId, kind, d, onClose, onDone, inval }: { encounterId: string; kind: 'sofa' | 'apache2'; d: IcuStay; onClose: () => void; onDone: (m: string) => void; inval: () => void }) {
  const [edit, setEdit] = useState<Record<string, string>>({}); const [urine, setUrine] = useState('');
  const [ap, setAp] = useState<{ category: string; chronic_health: boolean; emergency_surgery: boolean; arf: boolean }>({ category: '', chronic_health: false, emergency_surgery: false, arf: false });
  const [accept, setAccept] = useState(false); const [note, setNote] = useState('');
  const overrides = useMemo(() => {
    const o: Record<string, number> = {};
    for (const [k, v] of Object.entries(edit)) if (v !== '' && !Number.isNaN(Number(v))) o[kind === 'sofa' ? SOFA_OVR[k] ?? k : k] = Number(v);
    if (kind === 'sofa' && urine !== '') o.urine_24h = Number(urine);
    return o;
  }, [edit, urine, kind]);
  const body = { kind, overrides, ...(kind === 'apache2' && { apache: { category: ap.category || undefined, chronic_health: ap.chronic_health, emergency_surgery: ap.emergency_surgery, arf: ap.arf } }) };
  const key = useDebounced(JSON.stringify(body), 300);
  const draft = useQuery({ queryKey: ['icu-draft', encounterId, key], queryFn: () => api<{ components: Component[]; total: number; missing: string[]; predicted_mortality: number | null; incomplete: boolean; window_from: string; window_to: string }>(
    `/inpatient/stays/${encounterId}/icu/scores/draft`, { body: JSON.parse(key) }) });
  const m = useMutation({ mutationFn: () => api(`/inpatient/stays/${encounterId}/icu/scores`, { body: { ...body, accept_missing: accept || undefined, note: note.trim() || undefined } }),
    onSuccess: () => { onDone(`${kind === 'sofa' ? 'SOFA' : 'APACHE II'} დადასტურდა`); inval(); onClose(); } });
  const r = draft.data; const cats = d.apache_categories ?? [];
  const needAccept = !!r && (r.missing.length > 0 || (kind === 'apache2' && r.incomplete));
  return (
    <Modal title={kind === 'sofa' ? 'SOFA — ბოლო 24 სთ (ყველაზე ცუდი მნიშვნელობები)' : 'APACHE II — ICU-ს პირველი 24 სთ'} onClose={onClose} width={980}
      footer={<><span className="small muted" style={{ marginRight: 'auto' }}>{r ? <>ჯამი: <strong style={{ fontSize: 18 }}>{r.total}</strong>{r.missing.length ? ` · დაუდგენელი: ${r.missing.length}` : ''}{r.predicted_mortality !== null ? ` · სიკვდილობის რისკი ${r.predicted_mortality}%` : ''}</> : ''}</span>
        <button className="btn" type="button" onClick={onClose}>გაუქმება</button>
        <button className="btn primary" type="button" disabled={!r || m.isPending || (needAccept && !accept)} onClick={() => m.mutate()}>დადასტურება</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        {kind === 'apache2' && <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Field label="დიაგნოსტიკური კატეგორია (სიკვდილობის რისკისთვის)" htmlFor="sd-c"><select id="sd-c" className="select" style={{ minWidth: 360 }} value={ap.category} onChange={(e) => setAp({ ...ap, category: e.target.value })}>
            <option value="">— არ არის არჩეული —</option>
            <optgroup label="არაოპერაციული">{cats.filter((c) => !c.operative).map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</optgroup>
            <optgroup label="ოპერაციის შემდეგ">{cats.filter((c) => c.operative).map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</optgroup></select></Field>
          <label className="row"><input type="checkbox" checked={ap.chronic_health} onChange={(e) => setAp({ ...ap, chronic_health: e.target.checked })} /> ქრონიკული ორგანოს უკმარისობა / იმუნოსუპრესია</label>
          <label className="row"><input type="checkbox" checked={ap.emergency_surgery} onChange={(e) => setAp({ ...ap, emergency_surgery: e.target.checked })} /> გადაუდებელი ოპერაცია</label>
          <label className="row"><input type="checkbox" checked={ap.arf} onChange={(e) => setAp({ ...ap, arf: e.target.checked })} /> მწვავე თირკმლის დაზიანება (კრეატ. × 2)</label>
        </div>}
        {r && <span className="small muted">ფანჯარა: {dt(r.window_from)} — {dt(r.window_to)}{kind === 'apache2' && r.incomplete ? ' (პირველი 24 სთ ჯერ არ გასულა)' : ''}</span>}
        {draft.isLoading && !r ? <Loading /> : r ? <ComponentsTable comps={r.components} edit={edit} setEdit={(k, v) => setEdit((x) => ({ ...x, [k]: v }))} /> : <ErrorBox error={draft.error} />}
        {kind === 'sofa' && <div className="row" style={{ gap: 12, alignItems: 'flex-end' }}>
          <Field label="შარდი 24 სთ (მლ) — ხელით" htmlFor="sd-u" hint="ცარიელი — ბალანსიდან"><input id="sd-u" className="input mono" style={{ maxWidth: 160 }} type="number" min={0} value={urine} onChange={(e) => setUrine(e.target.value)} /></Field>
          <span className="small muted">„ხელით“ სვეტში: სუნთქვა — P/F, ცირკულაცია — ქულა (0–4), ცნს — GCS, თირკმელი — კრეატინინი (mg/dL).</span></div>}
        {needAccept && <label className="row alert warn" style={{ gap: 8 }}><input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} />
          დადასტურება ასე: {r!.missing.length ? `დაუდგენელი (${r!.components.filter((c) => c.points === null).map((c) => c.label).join(', ')}) — ქულაში არ ჩაითვლება` : 'პირველი 24 სთ ჯერ არ გასულა'}</label>}
        <Field label="შენიშვნა" htmlFor="sd-n"><input id="sd-n" className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- ABG
function AbgTab({ encounterId, d, toast, inval }: { encounterId: string; d: IcuStay; toast: (m: string) => void; inval: () => void }) {
  const [add, setAdd] = useState(false); const [vo, setVo] = useState<Abg | null>(null);
  const list = [...(d.abg ?? [])].reverse();
  const can = !!d.can_write && !!d.episode && d.features.includes('abg');
  const c = (v: number | null | undefined, lo: number, hi: number) => (v === null || v === undefined ? undefined : v < lo || v > hi ? 'var(--danger)' : undefined);
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="row" style={{ gap: 8 }}>{can && <button className="btn primary sm" type="button" onClick={() => setAdd(true)}>+ ABG (საწოლთან / POC)</button>}
        <span className="grow" /><span className="small muted">ბოლო 72 სთ · ლაბორატორიული (სისხლის აირები) და საწოლთან ხელით შეყვანილი</span></div>
      {!list.length ? <span className="muted">ჩანაწერი არ არის.</span> : <div style={{ overflowX: 'auto' }}><table className="table" style={{ minWidth: 860 }}>
        <thead><tr><th>დრო</th><th>წყარო</th><Th>pH</Th><Th>pCO₂</Th><Th>pO₂</Th><Th>HCO₃⁻</Th><Th>BE</Th><Th>ლაქტატი</Th><Th>SO₂</Th><Th>FiO₂</Th><Th>P/F</Th><th /></tr></thead>
        <tbody>{list.map((a) => <tr key={`${a.source}-${a.id}`}>
          <td className="small">{dt(a.sampled_at)}</td>
          <td>{a.source === 'poc' ? <span className="chip warn" title={a.created_by_name}>POC</span> : <span className={`chip ${a.validated ? 'info' : ''}`}>{a.validated ? 'ლაბ.' : 'ლაბ. (დაუდასტ.)'}</span>}</td>
          <td className="mono" style={{ textAlign: 'center', color: c(a.ph, 7.35, 7.45) }}>{a.ph ?? ''}</td><td className="mono" style={{ textAlign: 'center', color: c(a.pco2, 35, 45) }}>{a.pco2 ?? ''}</td>
          <td className="mono" style={{ textAlign: 'center', color: c(a.po2, 60, 200) }}>{a.po2 ?? ''}</td><td className="mono" style={{ textAlign: 'center', color: c(a.hco3, 22, 26) }}>{a.hco3 ?? ''}</td>
          <td className="mono" style={{ textAlign: 'center' }}>{a.be ?? ''}</td><td className="mono" style={{ textAlign: 'center', color: c(a.lactate, 0, 2) }}>{a.lactate ?? ''}</td>
          <td className="mono" style={{ textAlign: 'center' }}>{a.sao2 ?? ''}</td>
          <td className="mono" style={{ textAlign: 'center' }} title={FIO2_SRC[a.fio2_source ?? ''] ?? ''}>{a.fio2 ?? '?'}{a.fio2_source && a.fio2_source !== 'abg' ? <sup>{a.fio2_source === 'vent' ? 'v' : a.fio2_source === 'room_air' ? 'r' : ''}</sup> : null}</td>
          <td className="mono" style={{ textAlign: 'center', fontWeight: 600, color: a.pf && a.pf < 200 ? 'var(--danger)' : undefined }}>{a.pf ?? ''}</td>
          <td>{can && a.source === 'poc' && <button className="btn sm" type="button" onClick={() => setVo(a)}>გაუქმება</button>}</td></tr>)}</tbody></table></div>}
      <span className="small muted">FiO₂: <sup>v</sup> — ვენტილატორის პარამეტრებიდან, <sup>r</sup> — ოთახის ჰაერი (21%). ლაბ. ანალიტების შესაბამისობა — მოდულები → რეანიმაცია (lab_map).</span>
      {add && <AbgDialog encounterId={encounterId} onClose={() => setAdd(false)} onDone={toast} inval={inval} />}
      {vo && <VoidDialog kind="abg" id={vo.id} title={`ABG ${dt(vo.sampled_at)}`} onClose={() => setVo(null)} onDone={toast} inval={inval} />}
    </div>
  );
}
function AbgDialog({ encounterId, onClose, onDone, inval }: { encounterId: string; onClose: () => void; onDone: (m: string) => void; inval: () => void }) {
  const [f, setF] = useState<Record<string, string>>({ time: nowHM(), sample: 'arterial' });
  const set = (k: string) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const m = useMutation({ mutationFn: () => {
    const b: Record<string, unknown> = { sampled_at: atISO(f.time), sample: f.sample, note: f.note?.trim() || undefined };
    for (const k of ['ph', 'pco2', 'po2', 'hco3', 'be', 'lactate', 'sao2', 'fio2', 'na', 'k', 'glucose']) if (f[k]) b[k] = Number(f[k]);
    return api(`/inpatient/stays/${encounterId}/icu/abg`, { body: b });
  }, onSuccess: () => { onDone('ABG ჩაიწერა'); inval(); onClose(); } });
  const inp = (k: string, label: string, step = '0.1') => <Field label={label} htmlFor={`ab-${k}`}><input id={`ab-${k}`} className="input mono" type="number" step={step} value={f[k] ?? ''} onChange={set(k)} /></Field>;
  return (
    <Modal title="სისხლის აირები — საწოლთან (POC)" onClose={onClose} width={760}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={m.isPending} onClick={() => m.mutate()}>შენახვა</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
          <Field label="დრო" htmlFor="ab-t"><input id="ab-t" className="input" type="time" value={f.time} onChange={set('time')} /></Field>
          <Field label="სინჯი" htmlFor="ab-s"><select id="ab-s" className="select" value={f.sample} onChange={set('sample')}><option value="arterial">არტერიული</option><option value="venous">ვენური</option><option value="capillary">კაპილარული</option></select></Field>
          {inp('ph', 'pH', '0.01')}{inp('pco2', 'pCO₂ mmHg')}{inp('po2', 'pO₂ mmHg')}{inp('hco3', 'HCO₃⁻')}{inp('be', 'BE')}{inp('lactate', 'ლაქტატი')}{inp('sao2', 'SO₂ %')}
          {inp('fio2', 'FiO₂ % (ცარიელი — ვენტ.)', '1')}{inp('na', 'Na')}{inp('k', 'K')}{inp('glucose', 'გლუკოზა')}
        </div>
        <Field label="შენიშვნა" htmlFor="ab-n"><input id="ab-n" className="input" value={f.note ?? ''} onChange={set('note')} /></Field>
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- bundle-ები
function BundlesTab({ encounterId, d, toast, inval }: { encounterId: string; d: IcuStay; toast: (m: string) => void; inval: () => void }) {
  const [dlg, setDlg] = useState<'vap' | 'clabsi' | null>(null); const [vo, setVo] = useState<BundleCheck | null>(null);
  const can = !!d.can_write && !!d.episode && d.features.includes('bundles');
  const label = { vap: 'VAP (ვენტილაციასთან ასოცირებული პნევმონია)', clabsi: 'CLABSI (ცენტრალური ხაზის ინფექცია)' };
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {(['vap', 'clabsi'] as const).map((b) => <div key={b} className="card card-pad stack" style={{ gap: 6 }}>
          <strong>{label[b]}</strong>
          {!d.applicable?.[b] ? <span className="small muted">ახლა არ ეხება ({b === 'vap' ? 'ინვაზიური ვენტილაცია არ არის' : 'ცენტრალური ვენური ხაზი არ არის'})</span>
            : d.bundle_due?.[b] ? <div className="row" style={{ gap: 8 }}><span className="chip warn">დღეს არ შემოწმებულა</span>{can && <button className="btn sm primary" type="button" onClick={() => setDlg(b)}>შემოწმება</button>}</div>
            : <span className="chip ok">დღეს შემოწმებულია</span>}
        </div>)}
      </div>
      {(d.bundles ?? []).length > 0 && <table className="table"><thead><tr><th>დღე</th><th>bundle</th><th>შესაბამისობა</th><th>შენიშვნა</th><th>ვინ</th><th /></tr></thead>
        <tbody>{(d.bundles ?? []).map((b) => <tr key={b.id} style={{ opacity: b.voided_at ? 0.5 : 1, textDecoration: b.voided_at ? 'line-through' : undefined }} title={b.answers.map((a) => `${a.answer === 'yes' ? '✓' : a.answer === 'no' ? '✗' : '—'} ${a.label}`).join('\n')}>
          <td className="small">{b.day.split('-').reverse().join('/')} {hhmm(b.checked_at)}</td><td>{b.bundle.toUpperCase()}</td>
          <td>{b.compliant ? <span className="chip ok">სრული</span> : <span className="chip danger">{b.answers.filter((a) => a.answer === 'no').length} — არა</span>}</td>
          <td className="small">{b.note}</td><td className="small muted">{b.checked_by_name}</td>
          <td>{can && !b.voided_at && <button className="btn sm" type="button" onClick={() => setVo(b)}>გაუქმება</button>}</td></tr>)}</tbody></table>}
      {dlg && <BundleDialog encounterId={encounterId} bundle={dlg} items={(d.bundle_items ?? []).filter((i) => i.bundle === dlg)} onClose={() => setDlg(null)} onDone={toast} inval={inval} />}
      {vo && <VoidDialog kind="bundle" id={vo.id} title={`${vo.bundle.toUpperCase()} ${vo.day}`} onClose={() => setVo(null)} onDone={toast} inval={inval} />}
    </div>
  );
}
function BundleDialog({ encounterId, bundle, items, onClose, onDone, inval }: { encounterId: string; bundle: 'vap' | 'clabsi'; items: BundleItem[]; onClose: () => void; onDone: (m: string) => void; inval: () => void }) {
  const [ans, setAns] = useState<Record<string, 'yes' | 'no' | 'na'>>({}); const [note, setNote] = useState('');
  const anyNo = Object.values(ans).includes('no'); const all = items.every((i) => ans[i.id]);
  const m = useMutation({ mutationFn: () => api(`/inpatient/stays/${encounterId}/icu/bundles`, { body: { bundle, answers: ans, note: note.trim() || undefined } }),
    onSuccess: () => { onDone(`${bundle.toUpperCase()} შემოწმდა`); inval(); onClose(); } });
  return (
    <Modal title={`${bundle.toUpperCase()} bundle — დღევანდელი შემოწმება`} onClose={onClose} width={680}
      footer={<><button className="btn" type="button" style={{ marginRight: 'auto' }} onClick={() => setAns(Object.fromEntries(items.map((i) => [i.id, 'yes'])))}>ყველა „კი“</button>
        <button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={!all || (anyNo && note.trim().length < 3) || m.isPending} onClick={() => m.mutate()}>შენახვა</button></>}>
      <div className="stack" style={{ gap: 8 }}>
        {items.map((i) => <div key={i.id} className="row" style={{ gap: 10, justifyContent: 'space-between', borderBottom: '1px solid var(--line-soft)', paddingBottom: 6 }}>
          <span>{i.label}</span>
          <div className="seg" role="group" aria-label={i.label}>{([['yes', 'კი'], ['no', 'არა'], ['na', 'არ ეხება']] as const).map(([k, l]) =>
            <button key={k} type="button" aria-pressed={ans[i.id] === k} onClick={() => setAns((x) => ({ ...x, [i.id]: k }))}>{l}</button>)}</div></div>)}
        <Field label="შენიშვნა" htmlFor="bd-n" required={anyNo} hint={anyNo ? '„არა“ პასუხზე — რა და რატომ' : undefined}><textarea id="bd-n" className="textarea" rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- ეპიზოდები
function EpisodesTab({ d, toast, inval }: { d: IcuStay; toast: (m: string) => void; inval: () => void }) {
  const [ed, setEd] = useState<Episode | null>(null);
  const { user } = useAuth();
  return (
    <div className="stack" style={{ gap: 12 }}>
      <table className="table"><thead><tr><th>განყოფილება</th><th>საიდან</th><th>შემოსვლა</th><th>გასვლა</th><th>ხანგრძლ.</th><th>მდგომარეობა</th><th /></tr></thead>
        <tbody>{d.episodes.map((e) => <tr key={e.id}>
          <td><strong>{e.department_name}</strong> <span className="small muted">{LEVEL_KA[e.care_level]}</span>{e.readmission && <span className="chip warn" style={{ marginLeft: 6 }}>ხელახლა</span>}</td>
          <td className="small">{ORIGIN_KA[e.origin]}{e.from_department_name ? ` (${e.from_department_name})` : ''}{e.reason ? <div className="muted">{e.reason}</div> : null}</td>
          <td className="small">{dt(e.started_at)}</td>
          <td className="small">{e.ended_at ? `${dt(e.ended_at)} · ${EXIT_KIND_KA[e.exit_kind ?? ''] ?? ''}${e.exit_department_name ? ` → ${e.exit_department_name}` : ''}` : <span className="chip ok">მიმდინარე</span>}</td>
          <td className="mono">{days(e.hours)}</td>
          <td className="small">{e.exit_condition ? <span className={`chip ${e.exit_condition === 'died' ? 'danger' : e.exit_condition === 'worse' ? 'warn' : 'ok'}`}>{EXIT_KA[e.exit_condition]}</span> : ''}{e.exit_note ? <div className="muted">{e.exit_note}</div> : null}</td>
          <td>{e.ended_at && can(user, 'doctor', 'admin') && <button className="btn sm" type="button" onClick={() => setEd(e)}>მდგომარეობა</button>}</td></tr>)}</tbody></table>
      {ed && <ExitDialog ep={ed} onClose={() => setEd(null)} onDone={toast} inval={inval} />}
    </div>
  );
}
function ExitDialog({ ep, onClose, onDone, inval }: { ep: Episode; onClose: () => void; onDone: (m: string) => void; inval: () => void }) {
  const [cond, setCond] = useState(ep.exit_condition ?? 'improved'); const [note, setNote] = useState(ep.exit_note ?? '');
  const m = useMutation({ mutationFn: () => api(`/inpatient/icu/episodes/${ep.id}`, { method: 'PATCH', body: { exit_condition: cond, exit_note: note } }),
    onSuccess: () => { onDone('შენახულია'); inval(); onClose(); } });
  return (
    <Modal title="გასვლის მდგომარეობა" onClose={onClose} width={480}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={m.isPending} onClick={() => m.mutate()}>შენახვა</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <div className="seg" role="group" aria-label="მდგომარეობა" style={{ width: 'max-content', flexWrap: 'wrap' }}>
          {Object.entries(EXIT_KA).map(([k, l]) => <button key={k} type="button" aria-pressed={cond === k} onClick={() => setCond(k)}>{l}</button>)}</div>
        <Field label="შენიშვნა" htmlFor="ex-n"><input id="ex-n" className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}

// ================================================================= რეანიმაციის დაფა (სტაციონარი → რეანიმაცია)
interface IcuDep { id: string; name: string; care_level: string; features: IcuFeature[]; patients: number }
interface BoardPatient {
  episode_id: string; encounter_id: string; adm_no: string; first_name: string; last_name: string; gender: string; age: number; bed_code: string | null; doctor_name: string | null; diagnosis: string | null;
  allergies: number; started_at: string; readmission: boolean; days: number; interval_min: number; admission_weight_kg: string | null; isolation: string | null;
  vitals: { recorded_at: string; hr: number | null; sbp: number | null; dbp: number | null; map: number | null; spo2: number | null; rr: number | null; temp: number | null; cvp: number | null; gcs: number | null; rass: number | null } | null;
  last_sheet_at: string | null; vent: { kind: string; airway: string; started_at: string; days: number; mode: string | null; fio2: number | null; peep: number | null } | null;
  infusions: { id: string; title: string; titratable: boolean; rate_ml_h: number; dose_rate: number | null; unit: string | null }[];
  sofa: { total: number; day: string; prev: number | null; missing: string[] } | null; balance: { in: number; out: number; net: number; hour_net: number };
  alerts: { level: 'danger' | 'warn' | 'info'; text: string }[];
}
interface Stats {
  from: string; to: string; readmit_hours: number;
  departments: { department_id: string; department_name: string; episodes: number; active: number; los_days: number | null; los_median_days: number | null; readmissions: number; readmit_pct: number | null;
    deaths: number; mortality_pct: number | null; ventilated: number; vent_days: number }[];
  bundles: { bundle: string; checks: number; compliant: number; pct: number | null }[]; admission_scores: { kind: string; n: number; avg: number | null }[];
}
export function IcuBoardTab() {
  const deps = useQuery({ queryKey: ['icu-deps'], queryFn: () => api<IcuDep[]>('/inpatient/icu/departments') });
  const [sp, setSp] = useSearchParams(); const nav = useNavigate();
  const list = deps.data ?? [];
  const id = sp.get('icu_dep') ?? list[0]?.id ?? '';
  const view = sp.get('view') ?? 'board';
  const board = useQuery({ queryKey: ['ipd-icu-board', id], queryFn: () => api<{ department: IcuDep; can_write: boolean; patients: BoardPatient[] }>('/inpatient/icu/board', { query: { department_id: id } }),
    enabled: !!id && view === 'board', refetchInterval: 60_000 });
  useEffect(() => { if (!sp.get('icu_dep') && list[0]) { sp.set('icu_dep', list[0].id); setSp(sp, { replace: true }); } }, [list.length]);   // eslint-disable-line react-hooks/exhaustive-deps
  if (deps.isLoading) return <div className="content"><Loading /></div>;
  if (!list.length) return <div className="content"><div className="card empty">რეანიმაციის / ინტენსიური განყოფილება არ არის. ადმინისტრირება → განყოფილებები → „დონე“.</div></div>;
  const b = board.data;
  return (
    <div className="content">
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <select className="select" style={{ maxWidth: 320, height: 40 }} aria-label="განყოფილება" value={id} onChange={(e) => { sp.set('icu_dep', e.target.value); setSp(sp, { replace: true }); }}>
          {list.map((d) => <option key={d.id} value={d.id}>{d.name} — {LEVEL_KA[d.care_level]} ({d.patients})</option>)}</select>
        <div className="seg" role="group" aria-label="ხედი">
          <button type="button" aria-pressed={view === 'board'} onClick={() => { sp.set('view', 'board'); setSp(sp, { replace: true }); }}>დაფა</button>
          <button type="button" aria-pressed={view === 'stats'} onClick={() => { sp.set('view', 'stats'); setSp(sp, { replace: true }); }}>სტატისტიკა</button></div>
        <span className="grow" />{b && view === 'board' && <span className="small muted">განახლდა {hhmm(new Date().toISOString())} · ყოველ წუთში</span>}
      </div>
      {view === 'stats' ? <IcuStats departmentId={id} /> : board.isLoading ? <Loading /> : !b ? <ErrorBox error={board.error} /> : !b.patients.length ? <div className="card empty">პაციენტი არ არის.</div> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 12 }}>
          {b.patients.map((p) => <BoardCard key={p.episode_id} p={p} features={b.department.features} onOpen={() => nav(`/inpatient/stay/${p.encounter_id}#icu`)} />)}
        </div>)}
    </div>
  );
}
function BoardCard({ p, features, onOpen }: { p: BoardPatient; features: IcuFeature[]; onOpen: () => void }) {
  const v = p.vitals; const danger = p.alerts.some((a) => a.level === 'danger');
  const ago = p.last_sheet_at ? Math.round((Date.now() - new Date(p.last_sheet_at).getTime()) / 60_000) : null;
  return (
    <div className="card" role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }}
      style={{ cursor: 'pointer', borderLeft: `4px solid ${danger ? 'var(--danger)' : p.alerts.some((a) => a.level === 'warn') ? 'var(--warn-ink)' : 'var(--ok-ink)'}` }}>
      <div className="card-pad stack" style={{ gap: 8 }}>
        <div className="row" style={{ gap: 8 }}>
          <span className="chip accent mono">{p.bed_code ?? '—'}</span><strong className="grow">{p.last_name} {p.first_name}</strong>
          <span className="small muted">{p.gender === 'male' ? 'მ' : 'მდ'} · {p.age} წ · {p.days} დღე</span>
        </div>
        <div className="small" style={{ minHeight: 18 }}>{p.diagnosis ?? <span className="muted">დიაგნოზი —</span>}{p.allergies > 0 && <span className="chip danger" style={{ marginLeft: 6 }}>ალერგია</span>}{p.readmission && <span className="chip warn" style={{ marginLeft: 6 }}>ხელახლა</span>}</div>
        {v ? <div className="row mono" style={{ gap: 10, flexWrap: 'wrap', fontSize: 13 }}>
          <span title="პულსი">♥ {v.hr ?? '–'}</span><span title="წნევა / MAP" style={{ color: v.map !== null && v.map < 65 ? 'var(--danger)' : undefined, fontWeight: v.map !== null && v.map < 65 ? 700 : undefined }}>{v.sbp ?? '–'}/{v.dbp ?? '–'} ({v.map ?? '–'})</span>
          <span title="SpO₂" style={{ color: v.spo2 && v.spo2 < 90 ? 'var(--danger)' : undefined }}>SpO₂ {v.spo2 ?? '–'}</span><span>RR {v.rr ?? '–'}</span><span>{v.temp ?? '–'}°</span>
          {v.gcs && <span>GCS {v.gcs}</span>}{v.rass !== null && <span>RASS {v.rass}</span>}
        </div> : <span className="small muted">ვიტალები არ არის</span>}
        {features.includes('sheet') && <span className={ago === null || ago > p.interval_min ? 'chip warn' : 'small muted'} title="ბოლო ჩანაწერი ინტერვალზე ძველია — ყვითლად">ფურცელი: {ago === null ? 'ჩანაწერი არ არის' : `${ago} წთ-ის წინ`} · ყოველ {p.interval_min} წთ</span>}
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {p.vent ? <span className="chip info" title={dt(p.vent.started_at)}>{VENT_KA[p.vent.kind]} · დღე {Math.ceil(p.vent.days || 0.01)}{p.vent.mode ? ` · ${p.vent.mode}` : ''}{p.vent.fio2 ? ` FiO₂ ${p.vent.fio2}` : ''}{p.vent.peep ? ` PEEP ${p.vent.peep}` : ''}</span>
            : features.includes('ventilation') ? <span className="chip">სპონტ. სუნთქვა</span> : null}
          {p.infusions.map((i) => <span key={i.id} className="chip warn" title={i.title}>{i.title.split(' ')[0]} {i.dose_rate !== null && i.unit ? `${f3(i.dose_rate)} ${UNIT_KA[i.unit]}` : `${f1(i.rate_ml_h)} მლ/სთ`}</span>)}
        </div>
        <div className="row small" style={{ gap: 12, flexWrap: 'wrap' }}>
          {features.includes('sofa') && <span>SOFA: {p.sofa ? <strong>{p.sofa.total}{p.sofa.prev !== null && <span style={{ color: p.sofa.total > p.sofa.prev ? 'var(--danger)' : p.sofa.total < p.sofa.prev ? 'var(--ok-ink)' : undefined }}> {p.sofa.total > p.sofa.prev ? '↑' : p.sofa.total < p.sofa.prev ? '↓' : '→'}</span>}</strong> : '—'}</span>}
          <span>ბალანსი დღეს: <strong className="mono">{sgn(p.balance.net)}</strong> მლ <span className="muted">(ბოლო სთ {sgn(p.balance.hour_net)})</span></span>
        </div>
        {p.alerts.length > 0 && <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>{p.alerts.map((a, i) => <span key={i} className={`chip ${a.level === 'info' ? '' : a.level}`}>{a.text}</span>)}</div>}
        <div className="row small muted" style={{ gap: 8 }}><span className="mono">{p.adm_no}</span><span className="grow" />{p.doctor_name}<Link to={`/inpatient/stay/${p.encounter_id}#icu`} onClick={(e) => e.stopPropagation()}>გახსნა →</Link></div>
      </div>
    </div>
  );
}
function IcuStats({ departmentId }: { departmentId: string }) {
  const [from, setFrom] = useState(shiftDay(todayISO(), -29)); const [to, setTo] = useState(todayISO()); const [all, setAll] = useState(false);
  const q = useQuery({ queryKey: ['icu-stats', from, to, all ? '' : departmentId], queryFn: () => api<Stats>('/inpatient/icu/stats', { query: { from, to, ...(all ? {} : { department_id: departmentId }) } }) });
  const s = q.data;
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="row" style={{ gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <Field label="დან" htmlFor="is-f"><input id="is-f" className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="მდე" htmlFor="is-t"><input id="is-t" className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <label className="row" style={{ height: 40 }}><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> ყველა განყოფილება</label>
      </div>
      {q.isLoading ? <Loading /> : !s ? <ErrorBox error={q.error} /> : <>
        <div className="card"><table className="table"><thead><tr><th>განყოფილება</th><Th>ეპიზოდი</Th><Th>ახლა</Th><Th>LOS (საშ. / მედიანა), დღე</Th><Th>ხელახლა {s.readmit_hours} სთ-ში</Th><Th>სიკვდილობა</Th><Th>ვენტილირებული</Th><Th>ვენტ. დღე</Th></tr></thead>
          <tbody>{s.departments.map((d) => <tr key={d.department_id}><td><strong>{d.department_name}</strong></td><td className="mono" style={{ textAlign: 'center' }}>{d.episodes}</td><td className="mono" style={{ textAlign: 'center' }}>{d.active}</td>
            <td className="mono" style={{ textAlign: 'center' }}>{d.los_days ?? '—'} / {d.los_median_days ?? '—'}</td><td className="mono" style={{ textAlign: 'center' }}>{d.readmissions} ({d.readmit_pct ?? 0}%)</td>
            <td className="mono" style={{ textAlign: 'center' }}>{d.deaths} ({d.mortality_pct ?? 0}%)</td><td className="mono" style={{ textAlign: 'center' }}>{d.ventilated}</td><td className="mono" style={{ textAlign: 'center' }}>{d.vent_days}</td></tr>)}
            {!s.departments.length && <tr><td colSpan={8} className="muted">ამ პერიოდში ეპიზოდი არ არის.</td></tr>}</tbody></table></div>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          {s.bundles.map((b) => <div key={b.bundle} className="card card-pad"><span className="label">{b.bundle.toUpperCase()} — შესაბამისობა</span><div style={{ fontSize: 22, fontWeight: 700 }}>{b.pct ?? '—'}%</div><span className="small muted">{b.compliant} / {b.checks} შემოწმება</span></div>)}
          {s.admission_scores.map((x) => <div key={x.kind} className="card card-pad"><span className="label">{x.kind === 'sofa' ? 'SOFA შემოსვლისას' : 'APACHE II'} — საშუალო</span><div style={{ fontSize: 22, fontWeight: 700 }}>{x.avg ?? '—'}</div><span className="small muted">{x.n} შეფასება</span></div>)}
        </div>
        <span className="small muted">LOS — დასრულებული ეპიზოდებით. სიკვდილობა — ეპიზოდის ბოლოს „გარდაიცვალა“. ხელახლა შემოსვლა — {s.readmit_hours} სთ-ში განყოფილებაში გადაყვანის შემდეგ (პირდაპირი ICU → ICU არ ითვლება).</span>
      </>}
    </div>
  );
}

// ================================================================= ადმინისტრირება: bundle-ის პუნქტები, APACHE კატეგორიები
export function IcuSetup() {
  const qc = useQueryClient(); const toast = useToast();
  const items = useQuery({ queryKey: ['icu-bundle-items', 'all'], queryFn: () => api<BundleItem[]>('/inpatient/icu/bundle-items', { query: { all: 'true' } }) });
  const cats = useQuery({ queryKey: ['icu-apache-cats', 'all'], queryFn: () => api<ApacheCat[]>('/inpatient/icu/apache-categories', { query: { all: 'true' } }) });
  const [nb, setNb] = useState<{ bundle: 'vap' | 'clabsi'; label: string }>({ bundle: 'vap', label: '' });
  const inv = () => { void qc.invalidateQueries({ queryKey: ['icu-bundle-items'] }); void qc.invalidateQueries({ queryKey: ['icu-apache-cats'] }); void qc.invalidateQueries({ queryKey: ['ipd-icu'] }); };
  const add = useMutation({ mutationFn: () => api('/inpatient/icu/bundle-items', { body: { ...nb, label: nb.label.trim() } }), onSuccess: () => { setNb({ ...nb, label: '' }); toast.show('დაემატა'); inv(); } });
  const upd = useMutation({ mutationFn: (x: { id: string; body: Record<string, unknown> }) => api(`/inpatient/icu/bundle-items/${x.id}`, { method: 'PATCH', body: x.body }), onSuccess: () => { toast.show('შენახულია'); inv(); } });
  const cat = useMutation({ mutationFn: (x: { code: string; body: Record<string, unknown> }) => api(`/inpatient/icu/apache-categories/${x.code}`, { method: 'PATCH', body: x.body }), onSuccess: () => { toast.show('შენახულია'); inv(); } });
  return (
    <div className="content">
      {toast.node}
      <span className="hint">რეანიმაციის ცნობარები. პარამეტრები (ინტერვალი, ფუნქციები ინტენსიურისთვის, ვენტილაციის დღის ტარიფი, ლაბ. ანალიტები) — <Link to="/admin/modules">მოდულები → რეანიმაცია</Link>; განყოფილების დონე — <Link to="/admin/departments">განყოფილებები</Link>.</span>
      <ErrorBox error={add.error ?? upd.error ?? cat.error} />
      <section className="card">
        <div className="card-head"><h2 style={{ margin: 0 }}>bundle-ის პუნქტები (VAP / CLABSI)</h2></div>
        <div className="card-pad stack" style={{ gap: 10 }}>
          <div className="row" style={{ gap: 8 }}>
            <select className="select" style={{ maxWidth: 140 }} aria-label="bundle" value={nb.bundle} onChange={(e) => setNb({ ...nb, bundle: e.target.value as 'vap' })}><option value="vap">VAP</option><option value="clabsi">CLABSI</option></select>
            <input className="input grow" aria-label="ახალი პუნქტი" placeholder="ახალი პუნქტი" value={nb.label} onChange={(e) => setNb({ ...nb, label: e.target.value })} />
            <button className="btn primary" type="button" disabled={nb.label.trim().length < 3 || add.isPending} onClick={() => add.mutate()}>დამატება</button></div>
          {items.isLoading ? <Loading /> : <table className="table"><tbody>{(items.data ?? []).map((i) => <tr key={i.id} style={{ opacity: i.is_active ? 1 : 0.5 }}>
            <td style={{ width: 80 }}><span className="chip">{i.bundle.toUpperCase()}</span></td>
            <td><input className="input" aria-label="პუნქტი" defaultValue={i.label} onBlur={(e) => { if (e.target.value.trim() !== i.label && e.target.value.trim().length >= 3) upd.mutate({ id: i.id, body: { label: e.target.value.trim() } }); }} /></td>
            <td style={{ width: 90 }}><input className="input mono" aria-label="რიგი" type="number" defaultValue={i.sort_order} onBlur={(e) => { if (Number(e.target.value) !== i.sort_order) upd.mutate({ id: i.id, body: { sort_order: Number(e.target.value) } }); }} /></td>
            <td style={{ width: 120 }}><label className="row small"><input type="checkbox" checked={i.is_active} onChange={(e) => upd.mutate({ id: i.id, body: { is_active: e.target.checked } })} /> აქტიური</label></td></tr>)}</tbody></table>}
        </div>
      </section>
      <section className="card">
        <div className="card-head"><h2 style={{ margin: 0 }}>APACHE II — დიაგნოსტიკური კატეგორიები</h2></div>
        <div className="card-pad stack" style={{ gap: 10 }}>
          <span className="small muted">წონა სიკვდილობის რისკის ფორმულაში (Knaus და სხვ., 1985). შაბლონი — კლინიკამ გადაამოწმოს. რისკი მხოლოდ საინფორმაციოა.</span>
          {cats.isLoading ? <Loading /> : <table className="table"><tbody>{(cats.data ?? []).map((c) => <tr key={c.code} style={{ opacity: c.is_active ? 1 : 0.5 }}>
            <td style={{ width: 130 }}><span className="chip">{c.operative ? 'ოპერაციის შემდეგ' : 'არაოპერაციული'}</span></td><td>{c.name}</td>
            <td style={{ width: 110 }}><input className="input mono" aria-label="წონა" type="number" step="0.001" defaultValue={Number(c.weight)} onBlur={(e) => { if (Number(e.target.value) !== Number(c.weight)) cat.mutate({ code: c.code, body: { weight: Number(e.target.value) } }); }} /></td>
            <td style={{ width: 120 }}><label className="row small"><input type="checkbox" checked={c.is_active} onChange={(e) => cat.mutate({ code: c.code, body: { is_active: e.target.checked } })} /> აქტიური</label></td></tr>)}</tbody></table>}
        </div>
      </section>
    </div>
  );
}
