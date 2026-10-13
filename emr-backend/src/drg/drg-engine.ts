/**
 * DRG grouper — ძრავა (0055). სუფთა ფუნქციები: ბაზას არ ეხება.
 *
 *   კოდის შედარება: ნორმალიზაცია — დიდი ასოები, წერტილის / ინტერვალის გარეშე („K35.8“ → „K358“).
 *     ნიმუში „K35“ — დასაწყისი (K35, K35.0, K35.8 …); „K35-K37“ — დიაპაზონი (კოდის პირველი სიმბოლოები ზღვრებს შორის); „@სია“ — კოდების სია.
 *   CC დონე: თანმხლები დიაგნოზებიდან (cc_sources) — ყველაზე მაღალი (none < cc < mcc); გამონაკლისი: excl_pdx, იგივე კატეგორია (3 სიმბოლო),
 *     cc_count_to_mcc — N ცალი CC = MCC.
 *   წესები: seq-ის რიგით, აქტიური; პირველი, რომლის ყველა პირობა სრულდება → ჯგუფი; არცერთი → fallback_code (ან ვერ დაჯგუფდა).
 *   პირობის ტექსტური ჩანაწერი (DSL; იმპორტი / ექსპორტი / ჩვენება): „pdx in @APPEND & age >= 18 & cc >= cc“.
 */

// ---------------------------------------------------------------- ტიპები
export type Level = 'none' | 'cc' | 'mcc';
export const LEVELS: Level[] = ['none', 'cc', 'mcc'];
export type ListKind = 'dx' | 'proc' | 'service';

export interface VersionSettings {
  /** დღეები: bed_days — საწოლდღეები (შუაღამის წესი); calendar_days — გაწერა − მიღება (მინ. 1) */
  los_basis: 'bed_days' | 'calendar_days';
  /** ასაკი: მიღების ან გაწერის დღეს */
  age_basis: 'admission' | 'discharge';
  /** ძირითადი დიაგნოზი: primary — მხოლოდ „ძირითადი“; primary_or_admission — თუ არ არის, მიღების დიაგნოზი */
  pdx_source: 'primary' | 'primary_or_admission';
  /** თანმხლები დიაგნოზების წყარო (CC / sdx) */
  cc_sources: ('secondary' | 'complication' | 'admission')[];
  /** CC არ ითვლება, თუ ძირითადი დიაგნოზის იგივე კატეგორიაა (პირველი 3 სიმბოლო) */
  cc_exclude_same_category: boolean;
  /** N ცალი CC (სხვადასხვა) = MCC; null — გამორთული */
  cc_count_to_mcc: number | null;
  /** პროცედურის კოდები: or_ncsp — ოპერაციის NCSP; or_code — კლინიკის კოდი; service_code — ინვოისის ტარიფის კოდი */
  proc_sources: ('or_ncsp' | 'or_code' | 'service_code')[];
  /** ვენტილაციის საათები — რომელი სახეობა ითვლება */
  vent_kinds: ('invasive' | 'niv' | 'hfnc')[];
  /** არცერთი წესი არ დაემთხვა → ეს ჯგუფი (მაგ. „ვერ დაჯგუფდა“); null — შედეგის გარეშე */
  fallback_code: string | null;
}
export const VERSION_SETTINGS_DEFAULT: VersionSettings = {
  los_basis: 'bed_days', age_basis: 'admission', pdx_source: 'primary', cc_sources: ['secondary', 'complication'], cc_exclude_same_category: true,
  cc_count_to_mcc: null, proc_sources: ['or_ncsp', 'or_code'], vent_kinds: ['invasive'], fallback_code: null,
};
/** ვერსიის პარამეტრების ვალიდაცია: შეცდომის ტექსტი ან null */
export function validateVersionSettings(s: Record<string, unknown>): string | null {
  const sub = (v: unknown, all: string[]) => Array.isArray(v) && v.every((x) => all.includes(x as string)) && new Set(v).size === v.length;
  const checks: Record<string, (v: unknown) => boolean> = {
    los_basis: (v) => v === 'bed_days' || v === 'calendar_days',
    age_basis: (v) => v === 'admission' || v === 'discharge',
    pdx_source: (v) => v === 'primary' || v === 'primary_or_admission',
    cc_sources: (v) => sub(v, ['secondary', 'complication', 'admission']),
    cc_exclude_same_category: (v) => typeof v === 'boolean',
    cc_count_to_mcc: (v) => v === null || (Number.isInteger(v) && (v as number) >= 2 && (v as number) <= 10),
    proc_sources: (v) => sub(v, ['or_ncsp', 'or_code', 'service_code']) && (v as unknown[]).length > 0,
    vent_kinds: (v) => sub(v, ['invasive', 'niv', 'hfnc']),
    fallback_code: (v) => v === null || (typeof v === 'string' && /^[A-Z0-9][A-Z0-9_.-]{0,19}$/.test(v)),
  };
  for (const [k, v] of Object.entries(s)) {
    if (!checks[k]) return `უცნობი პარამეტრი: ${k}`;
    if (!checks[k](v)) return `არასწორი მნიშვნელობა: ${k}`;
  }
  return null;
}
export const versionSettings = (s: unknown): VersionSettings => ({ ...VERSION_SETTINGS_DEFAULT, ...((s ?? {}) as Partial<VersionSettings>) });

/** შემთხვევის მონაცემები, რომლითაც ჯგუფდება (ჰეში ითვლება ამაზე) */
export interface GroupInputs {
  pdx: string | null;                 // ნორმალიზებული
  sdx: string[];                      // ნორმალიზებული, უნიკალური
  procs: string[];                    // ნორმალიზებული კოდები (proc_sources)
  services: string[];                 // ტარიფების კოდები (ნორმალიზებული)
  surgery: boolean;
  age: number | null;                 // წელი
  age_days: number | null;
  sex: 'M' | 'F' | null;
  los: number;
  icu_hours: number;
  vent_hours: number;
  discharge: string | null;           // home / other_clinic / against_advice / death
  source: string | null;              // emergency / outpatient / planned / transfer_in / direct
}

export interface GroupRow { code: string; title: string; weight: string | number; kind?: string; mdc?: string | null }
export interface CcRow { pattern: string; level: 'cc' | 'mcc'; excl_pdx: string[] }
export interface RuleRow { id: string; seq: number; drg_code: string; label: string | null; conditions: Cond[]; is_active: boolean }
export interface VersionData {
  settings: VersionSettings;
  groups: Map<string, GroupRow>;
  lists: Map<string, { kind: ListKind; patterns: string[] }>;
  cc: CcRow[];
  rules: RuleRow[];
}

// ---------------------------------------------------------------- კოდები
export const norm = (c: string) => c.toUpperCase().replace(/[.\s]/g, '');
/** ნიმუშის ნორმალიზაცია: დიდი ასოები, წერტილის გარეშე; დიაპაზონი „A-B“ */
export const normPattern = (p: string) => p.trim().toUpperCase().replace(/[.\s]/g, '').replace(/[–—]/g, '-');
export const PATTERN_RE = /^[A-Z0-9_]+(-[A-Z0-9_]+)?$/;
export function matchPattern(pattern: string, code: string): boolean {
  const n = norm(code);
  const i = pattern.indexOf('-');
  if (i < 0) return n.startsWith(pattern);
  const a = pattern.slice(0, i); const b = pattern.slice(i + 1);
  return n.slice(0, a.length) >= a && n.slice(0, b.length) <= b;
}
/** მნიშვნელობების სია (ნიმუშები და @სიები) → ნიმუშები; უცნობი სია → შეცდომა */
export function expand(values: string[], lists: VersionData['lists']): string[] {
  const out: string[] = [];
  for (const v of values) {
    if (v.startsWith('@')) {
      const l = lists.get(v.slice(1));
      if (l) out.push(...l.patterns);
    } else out.push(v);
  }
  return out;
}
const anyMatch = (patterns: string[], code: string) => patterns.some((p) => matchPattern(p, code));

// ---------------------------------------------------------------- პირობები
export type Op = 'in' | 'not_in' | 'any' | 'none' | 'eq' | 'ne' | 'gte' | 'lte' | 'gt' | 'lt' | 'between' | 'is';
export interface Cond { f: string; op: Op; v: unknown }
type FieldType = 'codes' | 'num' | 'enum' | 'bool' | 'level';
export interface FieldDef { label: string; type: FieldType; ops: Op[]; list?: ListKind; values?: { v: string; label: string }[]; unit?: string }
const NUM_OPS: Op[] = ['eq', 'ne', 'gte', 'lte', 'gt', 'lt', 'between'];
export const DISCHARGE_KA: Record<string, string> = { home: 'სახლში', other_clinic: 'სხვა კლინიკაში', against_advice: 'თვითნებურად / წინააღმდეგ', death: 'გარდაცვალება' };
export const SOURCE_KA: Record<string, string> = { emergency: 'გადაუდებელი', outpatient: 'ამბულატორიიდან', planned: 'გეგმიური', transfer_in: 'სხვა კლინიკიდან', direct: 'პირდაპირ' };
export const FIELDS: Record<string, FieldDef> = {
  pdx: { label: 'ძირითადი დიაგნოზი', type: 'codes', ops: ['in', 'not_in'], list: 'dx' },
  sdx: { label: 'თანმხლები დიაგნოზი', type: 'codes', ops: ['any', 'none'], list: 'dx' },
  dx: { label: 'ნებისმიერი დიაგნოზი', type: 'codes', ops: ['any', 'none'], list: 'dx' },
  proc: { label: 'პროცედურა / ოპერაცია', type: 'codes', ops: ['any', 'none'], list: 'proc' },
  service: { label: 'მომსახურება (ინვოისის კოდი)', type: 'codes', ops: ['any', 'none'], list: 'service' },
  proc_count: { label: 'პროცედურების რაოდენობა', type: 'num', ops: NUM_OPS },
  surgery: { label: 'ოპერაცია ჩატარდა', type: 'bool', ops: ['is'] },
  cc: { label: 'სიმძიმე (CC / MCC)', type: 'level', ops: ['eq', 'ne', 'gte', 'lte'], values: [{ v: 'none', label: 'არა' }, { v: 'cc', label: 'CC' }, { v: 'mcc', label: 'MCC' }] },
  age: { label: 'ასაკი (წელი)', type: 'num', ops: NUM_OPS, unit: 'წ' },
  age_days: { label: 'ასაკი (დღე)', type: 'num', ops: NUM_OPS, unit: 'დ' },
  sex: { label: 'სქესი', type: 'enum', ops: ['eq'], values: [{ v: 'M', label: 'მამრ.' }, { v: 'F', label: 'მდედრ.' }] },
  los: { label: 'ხანგრძლივობა (დღე)', type: 'num', ops: NUM_OPS, unit: 'დ' },
  icu_hours: { label: 'ICU (საათი)', type: 'num', ops: NUM_OPS, unit: 'სთ' },
  vent_hours: { label: 'ვენტილაცია (საათი)', type: 'num', ops: NUM_OPS, unit: 'სთ' },
  discharge: { label: 'გაწერის ტიპი', type: 'enum', ops: ['in', 'not_in'], values: Object.entries(DISCHARGE_KA).map(([v, label]) => ({ v, label })) },
  source: { label: 'მიღების წყარო', type: 'enum', ops: ['in', 'not_in'], values: Object.entries(SOURCE_KA).map(([v, label]) => ({ v, label })) },
};
export const OP_KA: Record<Op, string> = { in: 'არის', not_in: 'არ არის', any: 'ერთ-ერთი მაინც', none: 'არცერთი', eq: '=', ne: '≠', gte: '≥', lte: '≤', gt: '>', lt: '<', between: 'შუალედი', is: 'არის' };

/** პირობის ვალიდაცია (lists — ვერსიის სიები: სახელი → სახეობა). შეცდომის ტექსტი ან null; v ნორმალიზდება ადგილზე */
export function validateCond(c: Cond, lists: Map<string, ListKind>): string | null {
  const d = FIELDS[c?.f];
  if (!d) return `უცნობი ველი: ${String(c?.f)}`;
  if (!d.ops.includes(c.op)) return `${d.label}: ოპერატორი „${String(c.op)}“ დაუშვებელია`;
  if (d.type === 'codes') {
    if (!Array.isArray(c.v) || !c.v.length || c.v.length > 500) return `${d.label}: მიუთითეთ კოდები ან სია`;
    const out: string[] = [];
    for (const x of c.v as unknown[]) {
      if (typeof x !== 'string') return `${d.label}: არასწორი მნიშვნელობა`;
      const t = x.trim();
      if (t.startsWith('@')) {
        const name = t.slice(1).toUpperCase();
        const k = lists.get(name);
        if (!k) return `${d.label}: სია @${name} ვერსიაში არ არის`;
        if (k !== d.list) return `${d.label}: სია @${name} სხვა სახეობისაა (${k})`;
        out.push(`@${name}`);
      } else {
        const p = normPattern(t);
        if (!PATTERN_RE.test(p)) return `${d.label}: კოდი „${t}“ არასწორია`;
        out.push(p);
      }
    }
    c.v = [...new Set(out)];
  } else if (d.type === 'num') {
    if (c.op === 'between') {
      if (!Array.isArray(c.v) || c.v.length !== 2 || !c.v.every((x) => typeof x === 'number' && Number.isFinite(x)) || (c.v[0] as number) > (c.v[1] as number)) return `${d.label}: შუალედი [დან, მდე]`;
    } else if (typeof c.v !== 'number' || !Number.isFinite(c.v)) return `${d.label}: რიცხვი`;
  } else if (d.type === 'enum') {
    const vals = Array.isArray(c.v) ? c.v : [c.v];
    if (!vals.length || !vals.every((x) => d.values!.some((y) => y.v === x))) return `${d.label}: არასწორი მნიშვნელობა`;
    c.v = c.op === 'eq' ? vals[0] : [...new Set(vals)];
  } else if (d.type === 'level') {
    if (!LEVELS.includes(c.v as Level)) return `${d.label}: none / cc / mcc`;
  } else if (d.type === 'bool') {
    if (typeof c.v !== 'boolean') return `${d.label}: კი / არა`;
  }
  return null;
}

function numCmp(op: Op, x: number, v: unknown) {
  switch (op) {
    case 'eq': return x === v; case 'ne': return x !== v; case 'gte': return x >= (v as number); case 'lte': return x <= (v as number);
    case 'gt': return x > (v as number); case 'lt': return x < (v as number);
    case 'between': return x >= (v as number[])[0] && x <= (v as number[])[1];
    default: return false;
  }
}

/** პირობის შეფასება: { ok, why } — why: რა ემთხვა / რა იყო მნიშვნელობა (trace-ისთვის) */
export function evalCond(c: Cond, x: GroupInputs, lists: VersionData['lists'], ccLevel: Level): { ok: boolean; why: string } {
  const d = FIELDS[c.f];
  if (d.type === 'codes') {
    const pats = expand(c.v as string[], lists);
    const codes = c.f === 'pdx' ? (x.pdx ? [x.pdx] : []) : c.f === 'sdx' ? x.sdx : c.f === 'dx' ? [...(x.pdx ? [x.pdx] : []), ...x.sdx] : c.f === 'proc' ? x.procs : x.services;
    const hit = codes.filter((k) => anyMatch(pats, k));
    const pos = c.op === 'in' || c.op === 'any';
    return { ok: pos ? hit.length > 0 : hit.length === 0, why: hit.length ? `დაემთხვა: ${hit.slice(0, 5).join(', ')}` : codes.length ? 'არ დაემთხვა' : 'მონაცემი არ არის' };
  }
  if (d.type === 'num') {
    const val = c.f === 'proc_count' ? x.procs.length : (x as unknown as Record<string, number | null>)[c.f];
    if (val === null || val === undefined) return { ok: false, why: 'მონაცემი არ არის' };
    return { ok: numCmp(c.op, val, c.v), why: `მნიშვნელობა: ${Math.round(val * 10) / 10}` };
  }
  if (d.type === 'enum') {
    const val = (x as unknown as Record<string, string | null>)[c.f];
    const set = Array.isArray(c.v) ? (c.v as string[]) : [c.v as string];
    const inSet = val !== null && set.includes(val);
    return { ok: c.op === 'not_in' ? !inSet : inSet, why: `მნიშვნელობა: ${val ?? '—'}` };
  }
  if (d.type === 'level') {
    const a = LEVELS.indexOf(ccLevel); const b = LEVELS.indexOf(c.v as Level);
    const ok = c.op === 'eq' ? a === b : c.op === 'ne' ? a !== b : c.op === 'gte' ? a >= b : a <= b;
    return { ok, why: `დონე: ${ccLevel}` };
  }
  return { ok: x.surgery === c.v, why: `ოპერაცია: ${x.surgery ? 'კი' : 'არა'}` };
}

// ---------------------------------------------------------------- CC დონე
export function ccLevel(x: GroupInputs, v: VersionData): { level: Level; items: { code: string; level: Level; counted: boolean; why?: string }[] } {
  const items: { code: string; level: Level; counted: boolean; why?: string }[] = [];
  let level: Level = 'none'; let ccCount = 0;
  for (const code of x.sdx) {
    if (x.pdx && code === x.pdx) continue;
    let best: CcRow | null = null;
    for (const r of v.cc) if (matchPattern(r.pattern, code) && (!best || (r.level === 'mcc' && best.level === 'cc') || (r.level === best.level && r.pattern.length > best.pattern.length))) best = r;
    if (!best) continue;
    let why: string | undefined;
    if (x.pdx && v.settings.cc_exclude_same_category && code.slice(0, 3) === x.pdx.slice(0, 3)) why = 'იგივე კატეგორია, რაც ძირითადი';
    else if (x.pdx && best.excl_pdx.length && anyMatch(expand(best.excl_pdx, v.lists), x.pdx)) why = 'გამონაკლისი ამ ძირითად დიაგნოზთან';
    items.push({ code, level: best.level, counted: !why, why });
    if (why) continue;
    if (best.level === 'mcc') level = 'mcc';
    else { ccCount++; if (level === 'none') level = 'cc'; }
  }
  if (level === 'cc' && v.settings.cc_count_to_mcc && ccCount >= v.settings.cc_count_to_mcc) level = 'mcc';
  return { level, items };
}

// ---------------------------------------------------------------- დაჯგუფება
export interface GroupResult {
  code: string | null;
  title: string | null;
  weight: number | null;
  rule_id: string | null;
  rule_seq: number | null;
  rule_label: string | null;
  fallback: boolean;
  cc_level: Level;
  issues: { code: string; message: string }[];
  trace: {
    cc: ReturnType<typeof ccLevel>['items'];
    matched?: { seq: number; label: string | null; conds: { text: string; ok: boolean; why: string }[] };
    skipped: { seq: number; drg_code: string; label: string | null; failed: string; why: string }[];
    skipped_total: number;
  };
}
export function group(x: GroupInputs, v: VersionData): GroupResult {
  const cc = ccLevel(x, v);
  const res: GroupResult = { code: null, title: null, weight: null, rule_id: null, rule_seq: null, rule_label: null, fallback: false, cc_level: cc.level, issues: [],
    trace: { cc: cc.items, skipped: [], skipped_total: 0 } };
  const fin = (code: string | null) => {
    const g = code ? v.groups.get(code) : undefined;
    if (code && !g) res.issues.push({ code: 'GROUP_MISSING', message: `ჯგუფი ${code} ვერსიის ცნობარში არ არის` });
    res.code = g ? g.code : null; res.title = g?.title ?? null; res.weight = g ? Number(g.weight) : null;
    return res;
  };
  if (!x.pdx) {
    res.issues.push({ code: 'NO_PDX', message: 'ძირითადი დიაგნოზი არ არის მითითებული' });
    return res;
  }
  for (const r of [...v.rules].filter((q) => q.is_active).sort((a, b) => a.seq - b.seq)) {
    const conds = r.conditions.map((c) => ({ c, r: evalCond(c, x, v.lists, cc.level) }));
    const bad = conds.find((q) => !q.r.ok);
    if (!bad) {
      res.rule_id = r.id; res.rule_seq = r.seq; res.rule_label = r.label;
      res.trace.matched = { seq: r.seq, label: r.label, conds: conds.map((q) => ({ text: condText(q.c), ok: true, why: q.r.why })) };
      return fin(r.drg_code);
    }
    res.trace.skipped_total++;
    if (res.trace.skipped.length < 30) res.trace.skipped.push({ seq: r.seq, drg_code: r.drg_code, label: r.label, failed: condText(bad.c), why: bad.r.why });
  }
  if (v.settings.fallback_code) {
    res.fallback = true;
    res.issues.push({ code: 'NO_RULE', message: `არცერთი წესი არ დაემთხვა — ნაგულისხმევი ჯგუფი ${v.settings.fallback_code}` });
    return fin(v.settings.fallback_code);
  }
  res.issues.push({ code: 'NO_RULE', message: 'არცერთი წესი არ დაემთხვა — ჯგუფი ხელით უნდა აირჩიოთ' });
  return res;
}

// ---------------------------------------------------------------- ტექსტური ჩანაწერი (DSL)
const SYM: Partial<Record<Op, string>> = { eq: '=', ne: '!=', gte: '>=', lte: '<=', gt: '>', lt: '<' };
export function condText(c: Cond): string {
  const d = FIELDS[c.f];
  const op = SYM[c.op] ?? c.op;
  if (c.op === 'between') return `${c.f} between ${(c.v as number[])[0]}..${(c.v as number[])[1]}`;
  if (d?.type === 'bool') return `${c.f} is ${c.v ? 'yes' : 'no'}`;
  const val = Array.isArray(c.v) ? (c.v as unknown[]).join(',') : String(c.v);
  return `${c.f} ${op} ${val}`;
}
export const condsText = (cs: Cond[]) => cs.map(condText).join(' & ');

const OPS_IN: Record<string, Op> = { in: 'in', not_in: 'not_in', 'not in': 'not_in', any: 'any', none: 'none', '=': 'eq', '==': 'eq', '!=': 'ne', '<>': 'ne',
  '>=': 'gte', '<=': 'lte', '>': 'gt', '<': 'lt', between: 'between', is: 'is' };
/** „pdx in @APPEND & age >= 18“ → პირობები (ვალიდაციით). შეცდომისას — { error } */
export function parseConds(text: string, lists: Map<string, ListKind>): { conds: Cond[] } | { error: string } {
  const parts = text.split(/\s*&\s*|\r?\n/).map((s) => s.trim()).filter(Boolean);
  const conds: Cond[] = [];
  for (const p of parts) {
    const m = /^([a-z_]+)\s+(not in|not_in|in|any|none|between|is|==|=|!=|<>|>=|<=|>|<)\s+(.+)$/i.exec(p);
    if (!m) return { error: `ვერ გაირჩა: „${p}“ (ფორმატი: ველი ოპერატორი მნიშვნელობა)` };
    const f = m[1].toLowerCase(); const op = OPS_IN[m[2].toLowerCase()]; const raw = m[3].trim();
    const d = FIELDS[f];
    if (!d) return { error: `უცნობი ველი: ${f}` };
    let v: unknown;
    if (op === 'between') {
      const r = /^(-?\d+(?:[.,]\d+)?)\s*(?:\.\.|–|—)\s*(-?\d+(?:[.,]\d+)?)$/.exec(raw);
      if (!r) return { error: `${f}: შუალედი ფორმატით a..b` };
      v = [Number(r[1].replace(',', '.')), Number(r[2].replace(',', '.'))];
    } else if (d.type === 'num') v = Number(raw.replace(',', '.'));
    else if (d.type === 'bool') v = /^(yes|true|1|კი)$/i.test(raw) ? true : /^(no|false|0|არა)$/i.test(raw) ? false : raw;
    else if (d.type === 'level') v = raw.toLowerCase();
    else if (d.type === 'enum') { const xs = raw.split(/\s*,\s*/).map((s) => (f === 'sex' ? s.toUpperCase() : s.toLowerCase())); v = op === 'eq' ? xs[0] : xs; }
    else v = raw.split(/\s*,\s*/).filter(Boolean);
    const c: Cond = { f, op, v };
    const err = validateCond(c, lists);
    if (err) return { error: err };
    conds.push(c);
  }
  return { conds };
}

/** ჰეში (შემავალი მონაცემების შეცვლის აღმოსაჩენად) — სტაბილური JSON */
export function stableJson(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(stableJson).join(',')}]`;
  if (x && typeof x === 'object') return `{${Object.keys(x as object).sort().map((k) => `${JSON.stringify(k)}:${stableJson((x as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(x ?? null);
}
