/**
 * გადამხდელის წილის ძრავა (0054) — საერთო სტაციონარისა და ამბულატორიისთვის (ipd-billing-calc.split → აქ).
 *
 * გადამხდელები რიგით (seq), თითოეულს — თავისი „დასაფარი“ ხაზები დარჩენილი ნაშთიდან:
 *   ხაზის წესი: პირველი შესაბამისი პუნქტი (კატეგორია / კოდი, ასაკი, სქესი, ICD-10 პრეფიქსი) → გამორიცხვა ან სხვა % / ხაზის ლიმიტი;
 *               პუნქტის გარეშე — ნაგულისხმევი (გამორიცხული კატეგორიები / კოდები, ვერსიის %);
 *   percent — Σ (ხაზის ნაშთი − ფრანშიზის წილი) × % (ხაზის ლიმიტამდე), შემთხვევის ლიმიტამდე;
 *   fixed / drg — ტარიფი × %, დასაფარამდე; writeoff_excess: (დასაფარი − ტარიფი) ჩამოიწერება;
 *   თანაგადახდა (copay_amount) — გადამხდელის წილს აკლდება (პაციენტი იხდის);
 *   override_amount — ბილინგის ხელით, დასაფარამდე.
 * პუნქტების, კოდების და თანაგადახდის გარეშე შედეგი ზუსტად ემთხვევა 0046-ის split-ს (იგივე დამრგვალება).
 * ხაზობრივი წილი: გადამხდელის თანხა ნაწილდება დასაფარ ხაზებზე წონით (percent — ხაზის თანხა, სხვა — ნაშთი).
 */
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const r4 = (n: number) => Math.round((n + Number.EPSILON) * 10000) / 10000;

export interface CalcLine { id: string; category: string; line_total: number; package_included: boolean; code?: string | null }
export interface RuleClause {
  seq: number; categories: string[]; codes: string[]; age_min: number | null; age_max: number | null; sex: string | null; dx_prefixes: string[];
  effect: 'exclude' | 'cover'; coverage_pct: number | null; line_limit: number | null; label?: string | null;
}
export interface CalcPayer {
  id: string; payer_id: string; kind: string; mode: string; coverage_pct: number; limit_amount: number | null; deductible: number; fixed_amount: number | null;
  drg_weight: number | null; drg_base_rate: number | null; writeoff_excess: boolean; excluded_categories: string[]; override_amount: number | null;
  excluded_codes?: string[]; clauses?: RuleClause[]; copay_amount?: number;
  /** 0056: DRG თანხა ფორმულით (ნაცვლად წონა × განაკვეთი) */
  drg_amount?: number | null;
}
export interface PatientCtx { age: number | null; sex: string | null; dx: string[] }
export interface PayerResult { id: string; payer_id: string; kind: string; tariff: number | null; eligible: number; amount: number; writeoff: number; copay?: number }
export interface LineShare { line_id: string; payers: { payer_id: string; kind: string; amount: number }[]; writeoff: number; patient: number; total: number }
export interface SplitResult { total: number; payers: PayerResult[]; writeoff: number; insurance: number; state: number; patient: number; lines?: LineShare[] }

const NO_CTX: PatientCtx = { age: null, sex: null, dx: [] };
const norm = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** პუნქტის პირობა: ცარიელი ველი = ნებისმიერი; ასაკის / სქესის / დიაგნოზის პირობა უცნობ მონაცემზე არ სრულდება */
export function clauseMatches(c: RuleClause, line: CalcLine, ctx: PatientCtx): boolean {
  if (c.categories.length && !c.categories.includes(line.category)) return false;
  if (c.codes.length && !(line.code && c.codes.includes(line.code))) return false;
  if (c.age_min !== null && (ctx.age === null || ctx.age < c.age_min)) return false;
  if (c.age_max !== null && (ctx.age === null || ctx.age > c.age_max)) return false;
  if (c.sex && ctx.sex !== c.sex) return false;
  if (c.dx_prefixes.length && !ctx.dx.some((d) => c.dx_prefixes.some((p) => norm(d).startsWith(norm(p))))) return false;
  return true;
}

/** ხაზის წესი გადამხდელისთვის: null — არ ფარავს; სხვა შემთხვევაში % (null — ვერსიის), ხაზის ლიმიტი, პუნქტის № */
export function lineRule(p: CalcPayer, line: CalcLine, ctx: PatientCtx): { pct: number | null; limit: number | null; clause: number | null } | null {
  for (const c of [...(p.clauses ?? [])].sort((a, b) => a.seq - b.seq)) {
    if (!clauseMatches(c, line, ctx)) continue;
    return c.effect === 'exclude' ? null : { pct: c.coverage_pct, limit: c.line_limit, clause: c.seq };
  }
  if (p.excluded_categories.includes(line.category)) return null;
  if (line.code && (p.excluded_codes ?? []).includes(line.code)) return null;
  return { pct: null, limit: null, clause: null };
}

export function split(lines: CalcLine[], payers: CalcPayer[], ctx: PatientCtx = NO_CTX): SplitResult {
  const rem = new Map<string, number>();
  const byId = new Map<string, CalcLine>();
  for (const l of lines) if (!l.package_included) { rem.set(l.id, l.line_total); byId.set(l.id, l); }
  const total = r2([...rem.values()].reduce((s, v) => s + v, 0));
  // ხაზობრივი აღრიცხვა
  const lp = new Map<string, Map<string, { payer_id: string; kind: string; amount: number }>>();
  const lw = new Map<string, number>();
  /** ნაშთის შემცირება წონით (ნაგულისხმევად — ნაშთის პროპორციულად, როგორც 0046-ში); აბრუნებს ხაზების ნაწილებს */
  const take = (ids: string[], amount: number, weight?: Map<string, number>) => {
    const parts = new Map<string, number>();
    const w = (id: string) => (weight ? weight.get(id) ?? 0 : rem.get(id)!);
    const base = ids.reduce((s, id) => s + w(id), 0);
    if (base <= 0 || amount <= 0) return parts;
    let left = amount;
    ids.forEach((id, i) => {
      const v = rem.get(id)!;
      const part = i === ids.length - 1 ? Math.min(v, left) : Math.min(v, r2((w(id) / base) * amount));
      rem.set(id, r2(v - part)); left = r2(left - part); parts.set(id, part);
    });
    return parts;
  };
  const out: PayerResult[] = [];
  let writeoff = 0;
  for (const p of payers) {
    const rules = new Map<string, { pct: number; limit: number | null; clause: number | null }>();
    for (const [id, v] of rem) {
      if (v <= 0) continue;
      const r = lineRule(p, byId.get(id)!, ctx);
      if (r) rules.set(id, { pct: r.pct ?? p.coverage_pct, limit: r.limit, clause: r.clause });
    }
    const ids = [...rules.keys()];
    const eligible = r2(ids.reduce((s, id) => s + rem.get(id)!, 0));
    let amount = 0; let wo = 0; let tariff: number | null = null; let weight: Map<string, number> | undefined;
    if (p.mode === 'fixed' || p.mode === 'drg') {
      tariff = r2(p.mode === 'drg' ? (p.drg_amount ?? (p.drg_weight ?? 0) * (p.drg_base_rate ?? 0)) : (p.fixed_amount ?? 0));
      amount = Math.min(r2(tariff * p.coverage_pct / 100), eligible);
      if (p.writeoff_excess && eligible > tariff) wo = r2(eligible - tariff);
    } else {
      const uniform = ids.every((id) => rules.get(id)!.clause === null && rules.get(id)!.limit === null);
      if (uniform) {
        amount = r2(Math.max(eligible - p.deductible, 0) * p.coverage_pct / 100);
      } else {
        const k = eligible > 0 ? Math.max(eligible - p.deductible, 0) / eligible : 0;
        weight = new Map();
        let sum = 0;
        for (const id of ids) {
          const r = rules.get(id)!;
          let a = rem.get(id)! * k * r.pct / 100;
          if (r.limit !== null) a = Math.min(a, r.limit);
          weight.set(id, a); sum += a;
        }
        amount = r2(sum);
        if (!(sum > 0)) weight = undefined;
      }
      if (p.limit_amount !== null) amount = Math.min(amount, p.limit_amount);
    }
    const copay = r2(Math.min(p.copay_amount ?? 0, amount));
    if (copay > 0) amount = r2(amount - copay);
    if (p.override_amount !== null) amount = Math.min(p.override_amount, eligible);
    amount = r2(amount);
    wo = r2(Math.min(wo, eligible - amount));
    const parts = take(ids, r2(amount + wo), weight);
    // ხაზის ნაწილი: გადამხდელი / ჩამოწერა — პროპორციულად
    const tot = amount + wo;
    for (const [id, part] of parts) {
      const pa = tot > 0 ? part * amount / tot : 0;
      if (pa) {
        const m = lp.get(id) ?? new Map(); const cur = m.get(p.payer_id);
        m.set(p.payer_id, { payer_id: p.payer_id, kind: p.kind, amount: (cur?.amount ?? 0) + pa }); lp.set(id, m);
      }
      if (part - pa) lw.set(id, (lw.get(id) ?? 0) + (part - pa));
    }
    writeoff = r2(writeoff + wo);
    out.push({ id: p.id, payer_id: p.payer_id, kind: p.kind, tariff, eligible, amount, writeoff: wo, ...(copay > 0 && { copay }) });
  }
  const insurance = r2(out.filter((x) => x.kind !== 'state').reduce((s, x) => s + x.amount, 0));
  const state = r2(out.filter((x) => x.kind === 'state').reduce((s, x) => s + x.amount, 0));
  const shares: LineShare[] = [...byId.values()].map((l) => {
    const ps = [...(lp.get(l.id)?.values() ?? [])].map((x) => ({ ...x, amount: r4(x.amount) }));
    const w = r4(lw.get(l.id) ?? 0);
    return { line_id: l.id, payers: ps, writeoff: w, patient: r4(l.line_total - ps.reduce((s, x) => s + x.amount, 0) - w), total: l.line_total };
  });
  return { total, payers: out, writeoff, insurance, state, patient: r2(Math.max(total - insurance - state - writeoff, 0)), lines: shares };
}

/** ასაკი (სრული წლები) თარიღზე */
export function ageAt(birth: string | Date | null | undefined, on: string | Date): number | null {
  if (!birth) return null;
  const b = new Date(birth); const d = new Date(on);
  if (Number.isNaN(b.getTime()) || Number.isNaN(d.getTime())) return null;
  let a = d.getUTCFullYear() - b.getUTCFullYear();
  if (d.getUTCMonth() < b.getUTCMonth() || (d.getUTCMonth() === b.getUTCMonth() && d.getUTCDate() < b.getUTCDate())) a--;
  return a;
}
