/**
 * რეანიმაცია (0047) — სუფთა გამოთვლები (DB-ის გარეშე; ტესტირებადი):
 *   ვაზოაქტიური ინფუზია: დოზის სიჩქარე ⇄ მლ/სთ (კონცენტრაცია, წონა);
 *   უწყვეტი ინფუზიის მოცულობა პერიოდში (MAR-ის მოქმედებებიდან);
 *   SOFA და APACHE II ქულები — „ყველაზე ცუდი“ მნიშვნელობით; დაუდგენელი კომპონენტი ნორმად არ ითვლება (missing).
 */

// ================================================================= ტიტრაცია
export const DOSE_RATE_UNITS = ['mcg/kg/min', 'mcg/min', 'mg/h', 'mg/kg/h', 'mcg/kg/h', 'units/h', 'units/min'] as const;
export type DoseRateUnit = (typeof DOSE_RATE_UNITS)[number];
export const CONC_UNITS = ['mg', 'mcg', 'units'] as const;
export type ConcUnit = (typeof CONC_UNITS)[number];

export interface Concentration { amount: number; unit: ConcUnit; volume_ml: number }

const perKg = (u: DoseRateUnit) => u.includes('/kg/');
const isUnits = (u: DoseRateUnit | ConcUnit) => u.startsWith('units');
/** ერთეულების თავსებადობა: მასა (მგ / მკგ) ↔ მასა; ერთეულები ↔ ერთეულები */
export function compatible(rate: DoseRateUnit, conc: ConcUnit) { return isUnits(rate) === isUnits(conc); }
/** კონცენტრაცია ბაზისურ ერთეულში (მკგ ან ერთეული) 1 მლ-ზე */
function concPerMl(c: Concentration) { return (c.unit === 'mg' ? c.amount * 1000 : c.amount) / c.volume_ml; }
/** დოზის სიჩქარე → ბაზისური რაოდენობა წუთში (მკგ/წთ ან ერთ./წთ) */
function perMinute(rate: number, unit: DoseRateUnit, weightKg: number | null) {
  const w = perKg(unit) ? (weightKg ?? NaN) : 1;
  switch (unit) {
    case 'mcg/kg/min': case 'mcg/min': case 'units/min': return rate * w;
    case 'mg/h': case 'mg/kg/h': return (rate * w * 1000) / 60;
    case 'mcg/kg/h': case 'units/h': return (rate * w) / 60;
  }
}
const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;

/** დოზის სიჩქარე → მლ/სთ */
export function doseRateToMlH(rate: number, unit: DoseRateUnit, c: Concentration, weightKg: number | null): number {
  if (!compatible(unit, c.unit)) throw new Error('ერთეულები შეუთავსებელია (მასა / ერთეული)');
  if (perKg(unit) && !weightKg) throw new Error('წონაზე დოზას წონა სჭირდება');
  return round((perMinute(rate, unit, weightKg) * 60) / concPerMl(c), 2);
}
/** მლ/სთ → დოზის სიჩქარე (unit-ში) */
export function mlHToDoseRate(mlH: number, unit: DoseRateUnit, c: Concentration, weightKg: number | null): number {
  if (!compatible(unit, c.unit)) throw new Error('ერთეულები შეუთავსებელია (მასა / ერთეული)');
  if (perKg(unit) && !weightKg) throw new Error('წონაზე დოზას წონა სჭირდება');
  const minute = (mlH * concPerMl(c)) / 60;           // ბაზისური ერთ./წთ
  const w = perKg(unit) ? weightKg! : 1;
  switch (unit) {
    case 'mcg/kg/min': case 'mcg/min': case 'units/min': return round(minute / w, 4);
    case 'mg/h': case 'mg/kg/h': return round((minute * 60) / 1000 / w, 4);
    case 'mcg/kg/h': case 'units/h': return round((minute * 60) / w, 4);
  }
}
/** SOFA-სთვის: ნებისმიერი მასური ერთეული → მკგ/კგ/წთ */
export function toMcgKgMin(rate: number, unit: DoseRateUnit, weightKg: number | null): number | null {
  if (isUnits(unit) || !weightKg) return null;
  return round(perMinute(rate, unit, weightKg) / weightKg, 4);
}

// ================================================================= ინფუზიის მოცულობა
export interface InfusionEvent { at: Date; action: 'start' | 'rate' | 'bag' | 'pause' | 'stop'; rate_ml_h: number | null; dose_rate?: number | null }
/** სიჩქარე დროში: [{from, rate}] (rate = 0 — შეჩერებული / დასრულებული) */
export function rateTimeline(events: InfusionEvent[]) {
  const ev = [...events].sort((a, b) => a.at.getTime() - b.at.getTime());
  const out: { from: Date; rate: number; dose_rate: number | null }[] = [];
  let cur = 0; let dose: number | null = null;
  for (const e of ev) {
    if (e.action === 'pause' || e.action === 'stop') { cur = 0; dose = null; }
    else { cur = e.rate_ml_h ?? cur; dose = e.dose_rate ?? (e.action === 'bag' ? dose : null); }
    out.push({ from: e.at, rate: cur, dose_rate: dose });
  }
  return out;
}
/** მოცულობა (მლ) პერიოდში [from, to) */
export function infusedVolume(events: InfusionEvent[], from: Date, to: Date): number {
  const tl = rateTimeline(events);
  let ml = 0;
  for (let i = 0; i < tl.length; i++) {
    const a = Math.max(tl[i].from.getTime(), from.getTime());
    const b = Math.min(i + 1 < tl.length ? tl[i + 1].from.getTime() : to.getTime(), to.getTime());
    if (b > a && tl[i].rate > 0) ml += (tl[i].rate * (b - a)) / 3_600_000;
  }
  return round(ml, 1);
}
/** სიჩქარე მომენტში (მლ/სთ) */
export function rateAt(events: InfusionEvent[], at: Date) {
  const tl = rateTimeline(events).filter((x) => x.from.getTime() <= at.getTime());
  return tl.length ? tl[tl.length - 1] : { from: at, rate: 0, dose_rate: null };
}

// ================================================================= ქულები: საერთო
export type Source = 'auto' | 'manual' | 'missing';
export interface Obs { value: number; at?: string | Date | null; detail?: string }
export interface Component { key: string; label: string; value: number | null; unit?: string; points: number | null; source: Source; at?: string | null; detail?: string }
const ts = (x: Obs['at']) => (x ? new Date(x).toISOString() : null);

/** ყველაზე ცუდი (მაქს. ქულა) დაკვირვებებიდან; override → ხელით */
function worst(key: string, label: string, unit: string, obs: Obs[], pts: (v: number) => number, override?: number | null): Component {
  if (override !== undefined && override !== null) return { key, label, unit, value: override, points: pts(override), source: 'manual' };
  if (!obs.length) return { key, label, unit, value: null, points: null, source: 'missing' };
  let best = obs[0]; let bp = pts(obs[0].value);
  for (const o of obs.slice(1)) { const p = pts(o.value); if (p > bp) { best = o; bp = p; } }
  return { key, label, unit, value: best.value, points: bp, source: 'auto', at: ts(best.at), detail: best.detail };
}
export function summarize(components: Component[]) {
  return { components, total: components.reduce((s, c) => s + (c.points ?? 0), 0), missing: components.filter((c) => c.points === null).map((c) => c.key) };
}

// ================================================================= SOFA
export interface SofaInput {
  pf: { value: number; support: boolean; at?: string | Date | null; detail?: string }[];   // PaO₂/FiO₂ (mmHg)
  platelets: Obs[];          // ×10³/µL
  bilirubin: Obs[];          // mg/dL
  map: Obs[];                // mmHg
  vaso: { dopamine: number; dobutamine: number; epinephrine: number; norepinephrine: number; detail?: string } | null;   // მაქს. მკგ/კგ/წთ (null — ვაზოპრესორი არ არის)
  vaso_unknown?: string[];   // ვაზოპრესორი, რომლის დოზა მკგ/კგ/წთ-ში ვერ გადაითვალა (წონა / ერთეული)
  gcs: Obs[];
  creatinine: Obs[];         // mg/dL
  urine_24h: number | null;  // მლ (null — შარდის აღრიცხვა არ არის)
}
export type SofaOverrides = Partial<Record<'pf' | 'platelets' | 'bilirubin' | 'map' | 'gcs' | 'creatinine' | 'urine_24h' | 'cv_points', number | null>> & { resp_support?: boolean };

export const sofaPf = (v: number, support: boolean) => (v < 100 && support ? 4 : v < 200 && support ? 3 : v < 300 ? 2 : v < 400 ? 1 : 0);
export const sofaPlt = (v: number) => (v < 20 ? 4 : v < 50 ? 3 : v < 100 ? 2 : v < 150 ? 1 : 0);
export const sofaBili = (v: number) => (v >= 12 ? 4 : v >= 6 ? 3 : v >= 2 ? 2 : v >= 1.2 ? 1 : 0);
export const sofaGcs = (v: number) => (v < 6 ? 4 : v <= 9 ? 3 : v <= 12 ? 2 : v <= 14 ? 1 : 0);
export const sofaCrea = (v: number) => (v >= 5 ? 4 : v >= 3.5 ? 3 : v >= 2 ? 2 : v >= 1.2 ? 1 : 0);
export const sofaUrine = (ml: number) => (ml < 200 ? 4 : ml < 500 ? 3 : 0);
export function sofaCv(mapMin: number | null, v: SofaInput['vaso']): number | null {
  if (v) {
    if (v.dopamine > 15 || v.epinephrine > 0.1 || v.norepinephrine > 0.1) return 4;
    if (v.dopamine > 5 || v.epinephrine > 0 || v.norepinephrine > 0) return 3;
    if (v.dopamine > 0 || v.dobutamine > 0) return 2;
  }
  if (mapMin === null) return null;
  return mapMin < 70 ? 1 : 0;
}

export function sofa(input: SofaInput, o: SofaOverrides = {}) {
  const support = o.resp_support;
  const pfObs = input.pf.map((p) => ({ value: p.value, at: p.at, detail: `${p.detail ?? ''}${(support ?? p.support) ? ' · სუნთქვის მხარდაჭერით' : ''}`.trim(), support: support ?? p.support }));
  let resp: Component;
  if (o.pf !== undefined && o.pf !== null) resp = { key: 'resp', label: 'სუნთქვა — PaO₂/FiO₂', unit: 'mmHg', value: o.pf, points: sofaPf(o.pf, !!support), source: 'manual' };
  else if (!pfObs.length) resp = { key: 'resp', label: 'სუნთქვა — PaO₂/FiO₂', unit: 'mmHg', value: null, points: null, source: 'missing' };
  else {
    let best = pfObs[0]; let bp = sofaPf(best.value, best.support);
    for (const p of pfObs.slice(1)) { const x = sofaPf(p.value, p.support); if (x > bp) { best = p; bp = x; } }
    resp = { key: 'resp', label: 'სუნთქვა — PaO₂/FiO₂', unit: 'mmHg', value: Math.round(best.value), points: bp, source: 'auto', at: ts(best.at), detail: best.detail };
  }
  const mapMin = o.map ?? (input.map.length ? Math.min(...input.map.map((m) => m.value)) : null);
  let cv: Component;
  if (o.cv_points !== undefined && o.cv_points !== null) cv = { key: 'cv', label: 'ცირკულაცია — MAP / ვაზოპრესორები', value: mapMin, unit: 'mmHg', points: Math.max(0, Math.min(4, Math.round(o.cv_points))), source: 'manual' };
  else {
    const p = input.vaso_unknown?.length && !input.vaso ? null : sofaCv(mapMin, input.vaso);
    const mapAt = input.map.find((m) => m.value === mapMin)?.at;
    const detail = [input.vaso?.detail, input.vaso_unknown?.length ? `დოზა ვერ გადაითვალა: ${input.vaso_unknown.join(', ')}` : ''].filter(Boolean).join(' · ') || undefined;
    cv = { key: 'cv', label: 'ცირკულაცია — MAP / ვაზოპრესორები', value: mapMin, unit: 'mmHg', points: p, source: p === null ? 'missing' : o.map !== undefined && o.map !== null ? 'manual' : 'auto', at: ts(mapAt), detail };
  }
  const renalCrea = worst('renal_crea', 'კრეატინინი', 'mg/dL', input.creatinine, sofaCrea, o.creatinine);
  const urine = o.urine_24h ?? input.urine_24h;
  const up = urine === null || urine === undefined ? null : sofaUrine(urine);
  const renalPts = renalCrea.points === null && up === null ? null : Math.max(renalCrea.points ?? 0, up ?? 0);
  const renal: Component = { key: 'renal', label: 'თირკმელი — კრეატინინი / შარდი 24 სთ', unit: 'mg/dL', value: renalCrea.value, points: renalPts,
    source: renalPts === null ? 'missing' : renalCrea.source === 'manual' || (o.urine_24h !== undefined && o.urine_24h !== null) ? 'manual' : 'auto', at: renalCrea.at,
    detail: [renalCrea.value !== null ? `კრეატინინი ${renalCrea.value}` : 'კრეატინინი —', urine !== null && urine !== undefined ? `შარდი ${Math.round(urine)} მლ/24 სთ` : 'შარდი —'].join(' · ') };
  return summarize([
    resp,
    worst('coag', 'კოაგულაცია — თრომბოციტები', '×10³/µL', input.platelets, sofaPlt, o.platelets),
    worst('liver', 'ღვიძლი — ბილირუბინი', 'mg/dL', input.bilirubin, sofaBili, o.bilirubin),
    cv,
    worst('cns', 'ცნს — GCS', '', input.gcs, sofaGcs, o.gcs),
    renal,
  ]);
}

// ================================================================= APACHE II
const band = (v: number, rules: [number, number][]) => { for (const [lim, p] of rules) if (v >= lim) return p; return rules[rules.length - 1][1]; };
export const apTemp = (t: number) => (t >= 41 ? 4 : t >= 39 ? 3 : t >= 38.5 ? 1 : t >= 36 ? 0 : t >= 34 ? 1 : t >= 32 ? 2 : t >= 30 ? 3 : 4);
export const apMap = (m: number) => (m >= 160 ? 4 : m >= 130 ? 3 : m >= 110 ? 2 : m >= 70 ? 0 : m >= 50 ? 2 : 4);
export const apHr = (h: number) => (h >= 180 ? 4 : h >= 140 ? 3 : h >= 110 ? 2 : h >= 70 ? 0 : h >= 55 ? 2 : h >= 40 ? 3 : 4);
export const apRr = (r: number) => (r >= 50 ? 4 : r >= 35 ? 3 : r >= 25 ? 1 : r >= 12 ? 0 : r >= 10 ? 1 : r >= 6 ? 2 : 4);
export const apAaDo2 = (a: number) => band(a, [[500, 4], [350, 3], [200, 2], [-1e9, 0]]);
export const apPao2 = (p: number) => (p > 70 ? 0 : p >= 61 ? 1 : p >= 55 ? 3 : 4);
export const apPh = (p: number) => (p >= 7.7 ? 4 : p >= 7.6 ? 3 : p >= 7.5 ? 1 : p >= 7.33 ? 0 : p >= 7.25 ? 2 : p >= 7.15 ? 3 : 4);
export const apHco3 = (h: number) => (h >= 52 ? 4 : h >= 41 ? 3 : h >= 32 ? 1 : h >= 22 ? 0 : h >= 18 ? 2 : h >= 15 ? 3 : 4);
export const apNa = (n: number) => (n >= 180 ? 4 : n >= 160 ? 3 : n >= 155 ? 2 : n >= 150 ? 1 : n >= 130 ? 0 : n >= 120 ? 2 : n >= 111 ? 3 : 4);
export const apK = (k: number) => (k >= 7 ? 4 : k >= 6 ? 3 : k >= 5.5 ? 1 : k >= 3.5 ? 0 : k >= 3 ? 1 : k >= 2.5 ? 2 : 4);
export const apCrea = (c: number) => (c >= 3.5 ? 4 : c >= 2 ? 3 : c >= 1.5 ? 2 : c >= 0.6 ? 0 : 2);
export const apHct = (h: number) => (h >= 60 ? 4 : h >= 50 ? 2 : h >= 46 ? 1 : h >= 30 ? 0 : h >= 20 ? 2 : 4);
export const apWbc = (w: number) => (w >= 40 ? 4 : w >= 20 ? 2 : w >= 15 ? 1 : w >= 3 ? 0 : w >= 1 ? 2 : 4);
export const apAge = (a: number) => (a >= 75 ? 6 : a >= 65 ? 5 : a >= 55 ? 3 : a >= 45 ? 2 : 0);
/** A-aDO₂ = FiO₂ × (760 − 47) − PaCO₂ / 0.8 − PaO₂ */
export const aado2 = (fio2Pct: number, paco2: number, pao2: number) => Math.round((fio2Pct / 100) * 713 - paco2 / 0.8 - pao2);

export interface ApacheInput {
  temp: Obs[]; map: Obs[]; hr: Obs[]; rr: Obs[];
  oxy: { pao2: number; paco2: number | null; fio2: number | null; at?: string | Date | null; detail?: string }[];
  ph: Obs[]; hco3: Obs[]; na: Obs[]; k: Obs[]; creatinine: Obs[]; hct: Obs[]; wbc: Obs[]; gcs: Obs[];
  age: number;
}
export type ApacheAdmission = 'nonoperative' | 'emergency_postop' | 'elective_postop';
export interface ApacheOpts { chronic_health?: boolean; admission_type?: ApacheAdmission; arf?: boolean; category_weight?: number | null; emergency_surgery?: boolean }
export type ApacheOverrides = Partial<Record<'temp' | 'map' | 'hr' | 'rr' | 'oxy' | 'ph' | 'na' | 'k' | 'creatinine' | 'hct' | 'wbc' | 'gcs', number | null>>;

export function apache2(input: ApacheInput, opts: ApacheOpts, o: ApacheOverrides = {}) {
  // ჟანგბადი: FiO₂ ≥ 50% → A-aDO₂ (საჭიროა PaCO₂); < 50% → PaO₂
  let oxy: Component;
  if (o.oxy !== undefined && o.oxy !== null) oxy = { key: 'oxy', label: 'ოქსიგენაცია (PaO₂ ან A-aDO₂)', unit: 'mmHg', value: o.oxy, points: apPao2(o.oxy), source: 'manual', detail: 'PaO₂ (ხელით)' };
  else {
    const scored = input.oxy.map((x) => {
      const f = x.fio2 ?? 21;
      if (f >= 50) {
        if (x.paco2 === null) return null;
        const a = aado2(f, x.paco2, x.pao2);
        return { value: a, points: apAaDo2(a), at: x.at, detail: `A-aDO₂ (FiO₂ ${f}%)` };
      }
      return { value: x.pao2, points: apPao2(x.pao2), at: x.at, detail: `PaO₂ (FiO₂ ${f}%${x.fio2 === null ? ', დაშვებით' : ''})` };
    }).filter((x): x is NonNullable<typeof x> => !!x);
    if (!scored.length) oxy = { key: 'oxy', label: 'ოქსიგენაცია (PaO₂ ან A-aDO₂)', unit: 'mmHg', value: null, points: null, source: 'missing' };
    else { const b = scored.reduce((m, x) => (x.points > m.points ? x : m)); oxy = { key: 'oxy', label: 'ოქსიგენაცია (PaO₂ ან A-aDO₂)', unit: 'mmHg', value: b.value, points: b.points, source: 'auto', at: ts(b.at), detail: b.detail }; }
  }
  // pH; ABG არ არის → HCO₃⁻
  let acid = worst('ph', 'არტერიული pH', '', input.ph, apPh, o.ph);
  if (acid.points === null && input.hco3.length) acid = { ...worst('ph', 'HCO₃⁻ (ABG-ის გარეშე)', 'mmol/L', input.hco3, apHco3), key: 'ph' };
  const crea = worst('creatinine', 'კრეატინინი', 'mg/dL', input.creatinine, apCrea, o.creatinine);
  if (crea.points !== null && opts.arf) { crea.points *= 2; crea.detail = 'მწვავე თირკმლის დაზიანება — ორმაგი'; }
  const gcs = worst('gcs', 'GCS (15 − GCS)', '', input.gcs, (v) => 15 - v, o.gcs);
  const phys = [
    worst('temp', 'ტემპერატურა', '°C', input.temp, apTemp, o.temp), worst('map', 'MAP', 'mmHg', input.map, apMap, o.map),
    worst('hr', 'გულისცემა', '/წთ', input.hr, apHr, o.hr), worst('rr', 'სუნთქვის სიხშირე', '/წთ', input.rr, apRr, o.rr),
    oxy, acid, worst('na', 'ნატრიუმი', 'mmol/L', input.na, apNa, o.na), worst('k', 'კალიუმი', 'mmol/L', input.k, apK, o.k),
    crea, worst('hct', 'ჰემატოკრიტი', '%', input.hct, apHct, o.hct), worst('wbc', 'ლეიკოციტები', '×10³/µL', input.wbc, apWbc, o.wbc), gcs,
  ];
  const agePts: Component = { key: 'age', label: 'ასაკი', unit: 'წ', value: input.age, points: apAge(input.age), source: 'auto' };
  const chronic: Component = { key: 'chronic', label: 'ქრონიკული დაავადება', value: opts.chronic_health ? 1 : 0, source: 'manual',
    points: opts.chronic_health ? (opts.admission_type === 'elective_postop' ? 2 : 5) : 0,
    detail: opts.chronic_health ? (opts.admission_type === 'elective_postop' ? 'გეგმიური ოპერაციის შემდეგ' : 'არაოპერაციული / გადაუდებელი ოპერაციის შემდეგ') : 'არა' };
  const r = summarize([...phys, agePts, chronic]);
  let mortality: number | null = null;
  if (opts.category_weight !== null && opts.category_weight !== undefined && !r.missing.length) {
    const logit = -3.517 + 0.146 * r.total + (opts.emergency_surgery ? 0.603 : 0) + opts.category_weight;
    mortality = round(100 / (1 + Math.exp(-logit)), 1);
  }
  return { ...r, predicted_mortality: mortality };
}

// ================================================================= ლაბ. ერთეულები → კანონიკური
export function labCanonical(key: string, value: number, unit: string): number {
  const u = (unit ?? '').toLowerCase();
  const mol = /(µ|μ|u|мк)mol/.test(u);
  switch (key) {
    case 'bilirubin': return mol ? round(value / 17.1, 2) : value;
    case 'creatinine': return mol ? round(value / 88.4, 2) : value;
    case 'hct': return value <= 1 ? round(value * 100, 1) : value;
    case 'fio2': return value <= 1 ? Math.round(value * 100) : value;
    case 'pao2': case 'paco2': return /kpa/.test(u) ? round(value * 7.50062, 1) : value;
    default: return value;
  }
}
