/**
 * DRG თანხის ფორმულა (0056) — სუფთა ფუნქციები.
 *
 *   საბაზისო = განაკვეთი × წონა × Π კოეფიციენტი (coef, პირობით)
 *   შემდეგ კომპონენტები seq-ის რიგით (აქტიური, პირობა სრულდება, exclusive_group-ში — პირველი შესაბამისი):
 *     high_los / low_los / transfer — დღეების მიხედვით (ჯგუფის საშ. ხანგრძლივობა და ზღვრები);
 *     percent / fixed — ± საბაზისოს % / თანხა;  per_unit — ICU / ვენტილაცია / დღეები ზღვარს ზემოთ;
 *     cost_outlier — ფაქტობრივი ხარჯი ზღვარს ზემოთ;  cap — ზედა ლიმიტი (მიმდინარე ჯამზე).
 *   ჯამი ≥ 0; დამრგვალება — ვერსიის rounding (total / component).
 */
import { type Cond, evalCond, type GroupInputs, type Level, type VersionData, validateCond, type ListKind } from './drg-engine';

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export type Kind = 'coef' | 'high_los' | 'low_los' | 'transfer' | 'percent' | 'fixed' | 'per_unit' | 'cost_outlier' | 'cap';
export interface Component { id: string; seq: number; kind: Kind; label: string; conditions: Cond[]; params: Record<string, unknown>; exclusive_group: string | null; is_active: boolean }

/** კომპონენტის სახეობები: დასახელება და პარამეტრები (ტიპი, აუცილებელი, ზღვრები) — UI-სთვისაც */
export interface ParamDef { key: string; label: string; type: 'num' | 'enum'; required?: boolean; min?: number; max?: number; values?: { v: string; label: string }[]; hint?: string }
export const KINDS: Record<Kind, { label: string; hint: string; params: ParamDef[] }> = {
  coef: { label: 'კოეფიციენტი', hint: 'საბაზისო × კოეფიციენტი (კლინიკის კატეგორია, პროფილი, განყოფილება — პირობით)',
    params: [{ key: 'factor', label: 'კოეფიციენტი', type: 'num', required: true, min: 0, max: 100 }] },
  high_los: { label: 'ხანგრძლივი დაყოვნება', hint: '(დღეები − ზედა ზღვარი) × საბაზისო / საშ. ხანგრძლივობა × კოეფ.; ან ფიქსირებული დღიური თანხა',
    params: [{ key: 'factor', label: 'დღიურის კოეფიციენტი', type: 'num', min: 0, max: 10, hint: 'ნაგ. 1' },
      { key: 'per_day', label: 'ფიქს. დღიური თანხა', type: 'num', min: 0, max: 1_000_000, hint: 'მითითებისას — კოეფიციენტის ნაცვლად' },
      { key: 'max_days', label: 'მაქს. დღეები', type: 'num', min: 1, max: 3650 }] },
  low_los: { label: 'მოკლე დაყოვნება', hint: 'დღეები < ქვედა ზღვარი → საბაზისო × max(მინ. %, დღეები / ქვედა ზღვარი)',
    params: [{ key: 'floor_pct', label: 'მინიმუმი (% საბაზისოდან)', type: 'num', required: true, min: 0, max: 100 }] },
  transfer: { label: 'გადაყვანა სხვა კლინიკაში', hint: 'გაწერა სხვა კლინიკაში და დღეები < საშ. ხანგრძლივობა → min(საბაზისო, საბაზისო / საშ. × (დღეები + დამატებითი))',
    params: [{ key: 'extra_days', label: 'დამატებითი დღე', type: 'num', min: 0, max: 30, hint: 'ნაგ. 1' }] },
  percent: { label: '± % საბაზისოდან', hint: 'მაგ. გარდაცვალება 2 დღეში → −50 (პირობით)',
    params: [{ key: 'pct', label: '%', type: 'num', required: true, min: -100, max: 1000 }] },
  fixed: { label: '± ფიქსირებული თანხა', hint: 'პირობით (მაგ. იმპლანტის დანამატი)', params: [{ key: 'amount', label: 'თანხა', type: 'num', required: true, min: -10_000_000, max: 10_000_000 }] },
  per_unit: { label: 'ერთეულის დანამატი', hint: 'ICU / ვენტილაცია / დღეები — ზღვარს ზემოთ × ერთეულის თანხა',
    params: [{ key: 'metric', label: 'რა ითვლება', type: 'enum', required: true, values: [{ v: 'icu_hours', label: 'ICU — საათი' }, { v: 'icu_days', label: 'ICU — დღე (24 სთ, დამრგვ. ზემოთ)' },
      { v: 'vent_hours', label: 'ვენტილაცია — საათი' }, { v: 'vent_days', label: 'ვენტილაცია — დღე' }, { v: 'los', label: 'ხანგრძლივობა — დღე' }] },
      { key: 'unit_amount', label: 'ერთეულის თანხა', type: 'num', required: true, min: 0, max: 1_000_000 },
      { key: 'threshold', label: 'ზღვარი (ერთეული)', type: 'num', min: 0, max: 100_000, hint: 'ზღვრამდე არ ანაზღაურდება; ნაგ. 0' },
      { key: 'max_units', label: 'მაქს. ერთეული', type: 'num', min: 1, max: 100_000 }] },
  cost_outlier: { label: 'ძვირი შემთხვევა', hint: 'ფაქტობრივი ხარჯი > ზღვარი → (ხარჯი − ზღვარი) × %',
    params: [{ key: 'threshold_mode', label: 'ზღვარი', type: 'enum', required: true, values: [{ v: 'amount', label: 'თანხა' }, { v: 'x_base', label: 'საბაზისოს ჯერადი' }] },
      { key: 'threshold', label: 'ზღვრის მნიშვნელობა', type: 'num', required: true, min: 0, max: 100_000_000 },
      { key: 'pct', label: '% ზედმეტიდან', type: 'num', required: true, min: 0, max: 100 }] },
  cap: { label: 'ზედა ლიმიტი', hint: 'მიმდინარე ჯამი > ლიმიტი → ლიმიტამდე',
    params: [{ key: 'mode', label: 'ლიმიტი', type: 'enum', required: true, values: [{ v: 'amount', label: 'თანხა' }, { v: 'x_base', label: 'საბაზისოს ჯერადი' }] },
      { key: 'value', label: 'მნიშვნელობა', type: 'num', required: true, min: 0, max: 100_000_000 }] },
};

/** კომპონენტის ვალიდაცია (პარამეტრები + პირობები); შეცდომა ან null. params ნორმალიზდება (მხოლოდ ცნობილი გასაღებები) */
export function validateComponent(c: { kind: string; params: Record<string, unknown>; conditions: Cond[] }, lists: Map<string, ListKind>): string | null {
  const k = KINDS[c.kind as Kind];
  if (!k) return `უცნობი სახეობა: ${c.kind}`;
  const out: Record<string, unknown> = {};
  for (const p of k.params) {
    const v = c.params?.[p.key];
    if (v === undefined || v === null || v === '') { if (p.required) return `${k.label}: „${p.label}“ სავალდებულოა`; continue; }
    if (p.type === 'num') {
      if (typeof v !== 'number' || !Number.isFinite(v)) return `${k.label}: „${p.label}“ — რიცხვი`;
      if ((p.min !== undefined && v < p.min) || (p.max !== undefined && v > p.max)) return `${k.label}: „${p.label}“ — ${p.min}…${p.max}`;
    } else if (!p.values!.some((x) => x.v === v)) return `${k.label}: „${p.label}“ — არასწორი მნიშვნელობა`;
    out[p.key] = v;
  }
  for (const key of Object.keys(c.params ?? {})) if (!k.params.some((p) => p.key === key)) return `${k.label}: უცნობი პარამეტრი ${key}`;
  if (!Array.isArray(c.conditions) || c.conditions.length > 50) return 'პირობები: სია (მაქს. 50)';
  for (const x of c.conditions) { const e = validateCond(x, lists); if (e) return `პირობა: ${e}`; }
  c.params = out;
  return null;
}

export interface PriceGroup { code: string; weight: number; alos: number | null; los_low: number | null; los_high: number | null }
export interface PriceItem { seq: number | null; kind: Kind | 'base'; label: string; amount: number; note: string }
export interface Price { base_rate: number; weight: number; base0: number; factor: number; base: number; items: PriceItem[]; total: number; charges: number | null; rounding: string }

/**
 * თანხის გაანგარიშება. inputs — დაჯგუფების მონაცემები (dept-ით); ccLevel — შემთხვევის სიმძიმე (პირობებისთვის); charges — ფაქტობრივი ხარჯი (ინვოისი, პაკეტის გარდა).
 */
export function price(comps: Component[], v: Pick<VersionData, 'lists' | 'settings'>, g: PriceGroup, baseRate: number, x: GroupInputs, ccLevel: Level, charges: number | null): Price {
  const round = v.settings.rounding === 'component' ? r2 : (n: number) => n;
  const ok = (c: Component) => c.is_active && c.conditions.every((q) => evalCond(q, x, v.lists, ccLevel).ok);
  const sorted = [...comps].sort((a, b) => a.seq - b.seq);
  const base0 = baseRate * g.weight;
  const items: PriceItem[] = [];
  let factor = 1;
  const used = new Set<string>();
  for (const c of sorted.filter((q) => q.kind === 'coef')) {
    if (!ok(c) || (c.exclusive_group && used.has(c.exclusive_group))) continue;
    factor *= Number(c.params.factor);
    if (c.exclusive_group) used.add(c.exclusive_group);
    items.push({ seq: c.seq, kind: 'coef', label: c.label, amount: 0, note: `× ${Number(c.params.factor)}` });
  }
  const base = round(base0 * factor);
  let running = base;
  const P = (c: Component, k: string, d = 0) => (c.params[k] === undefined ? d : Number(c.params[k]));
  for (const c of sorted.filter((q) => q.kind !== 'coef')) {
    if (!ok(c) || (c.exclusive_group && used.has(c.exclusive_group))) continue;
    let amount = 0; let note = '';
    switch (c.kind) {
      case 'high_los':
        if (g.los_high && x.los > g.los_high && (c.params.per_day !== undefined || g.alos)) {
          let days = x.los - g.los_high;
          if (c.params.max_days !== undefined) days = Math.min(days, P(c, 'max_days'));
          const daily = c.params.per_day !== undefined ? P(c, 'per_day') : (base / g.alos!) * P(c, 'factor', 1);
          amount = days * daily; note = `${days} დღე × ${r2(daily)}`;
        }
        break;
      case 'low_los':
        if (g.los_low && x.los < g.los_low) {
          const k = Math.max(P(c, 'floor_pct') / 100, x.los / g.los_low);
          amount = base * k - base; note = `${x.los} / ${g.los_low} დღე → ${Math.round(k * 1000) / 10}%`;
        }
        break;
      case 'transfer':
        if (x.discharge === 'other_clinic' && g.alos && x.los < g.alos) {
          const t = Math.min(base, (base / g.alos) * (x.los + P(c, 'extra_days', 1)));
          amount = t - base; note = `(${x.los} + ${P(c, 'extra_days', 1)}) / ${g.alos} დღე`;
        }
        break;
      case 'percent': amount = (base * P(c, 'pct')) / 100; note = `${P(c, 'pct')}%`; break;
      case 'fixed': amount = P(c, 'amount'); break;
      case 'per_unit': {
        const m = String(c.params.metric);
        const val = m === 'icu_hours' ? x.icu_hours : m === 'icu_days' ? Math.ceil(x.icu_hours / 24) : m === 'vent_hours' ? x.vent_hours : m === 'vent_days' ? Math.ceil(x.vent_hours / 24) : x.los;
        let units = Math.max(0, val - P(c, 'threshold'));
        if (c.params.max_units !== undefined) units = Math.min(units, P(c, 'max_units'));
        units = Math.floor(units * 10) / 10;
        amount = units * P(c, 'unit_amount'); note = `${units} × ${P(c, 'unit_amount')}`;
        break;
      }
      case 'cost_outlier': {
        if (charges === null) { note = 'ხარჯი უცნობია'; break; }
        const thr = c.params.threshold_mode === 'x_base' ? base * P(c, 'threshold') : P(c, 'threshold');
        if (charges > thr) { amount = ((charges - thr) * P(c, 'pct')) / 100; note = `(${r2(charges)} − ${r2(thr)}) × ${P(c, 'pct')}%`; }
        break;
      }
      case 'cap': {
        const lim = c.params.mode === 'x_base' ? base * P(c, 'value') : P(c, 'value');
        if (running > lim) { amount = lim - running; note = `ლიმიტი ${r2(lim)}`; }
        break;
      }
    }
    amount = round(amount);
    if (amount === 0) continue;
    if (c.exclusive_group) used.add(c.exclusive_group);
    running += amount;
    items.push({ seq: c.seq, kind: c.kind, label: c.label, amount: r2(amount), note });
  }
  return { base_rate: baseRate, weight: g.weight, base0: r2(base0), factor: Math.round(factor * 10000) / 10000, base: r2(base), items, total: r2(Math.max(0, running)), charges, rounding: v.settings.rounding };
}
