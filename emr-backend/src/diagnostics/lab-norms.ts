/**
 * ლაბორატორიული ნორმები — სუფთა ფუნქციები (ბაზის გარეშე, ტესტირებადი).
 * კრიტერიუმები: სქესი, ასაკი (დღეებში), ორსულობა/ტრიმესტრი, ანალიზატორი/მეთოდი.
 */
export type Pregnancy = 'P' | 'T1' | 'T2' | 'T3';
export interface RangeRow {
  sex: string | null; age_min_days: number; age_max_days: number;
  pregnancy?: string | null; method_id?: string | null;
  low: string | null; high: string | null; normal_text: string | null;
}
export interface RangeContext { sex: string; ageDays: number; pregnancyWeeks?: number | null; methodId?: string | null }

export const AGE_MAX_DAYS = 54750;   // 150 წელი — „ზედა ზღვრის გარეშე“

/** ორსულობის კვირა → ტრიმესტრი (I: 1–13, II: 14–27, III: 28+) */
export function trimester(weeks: number | null | undefined): 'T1' | 'T2' | 'T3' | null {
  if (!weeks || weeks < 1) return null;
  return weeks <= 13 ? 'T1' : weeks <= 27 ? 'T2' : 'T3';
}

/**
 * შესაბამისი ნორმა. გამოირიცხება: სხვა სქესის, ასაკის გარეთ, სხვა ანალიზატორის, ორსულის ნორმა არაორსულისთვის (და სხვა ტრიმესტრის).
 * დარჩენილთაგან იმარჯვებს ყველაზე სპეციფიკური: ტრიმესტრი (8) > „ორსული“ (6) > ანალიზატორი (4) > სქესი (2); ტოლობისას — ვიწრო ასაკობრივი დიაპაზონი.
 */
export function pickRange<R extends RangeRow>(ranges: R[], c: RangeContext): R | null {
  const tri = c.sex === 'male' ? null : trimester(c.pregnancyWeeks);
  let best: R | null = null; let bestScore = -1; let bestSpan = Infinity;
  for (const r of ranges) {
    if (r.sex !== null && r.sex !== c.sex) continue;
    if (c.ageDays < r.age_min_days || c.ageDays > r.age_max_days) continue;
    if (r.method_id && r.method_id !== c.methodId) continue;
    if (r.pregnancy) {
      if (!tri) continue;
      if (r.pregnancy !== 'P' && r.pregnancy !== tri) continue;
    }
    const score = (r.pregnancy ? (r.pregnancy === 'P' ? 6 : 8) : 0) + (r.method_id ? 4 : 0) + (r.sex ? 2 : 0);
    const span = r.age_max_days - r.age_min_days;
    if (score > bestScore || (score === bestScore && span < bestSpan)) { best = r; bestScore = score; bestSpan = span; }
  }
  return best;
}

// ---------------------------------------------------------------- ასაკის ტექსტი (შეცდომის შეტყობინებებისთვის)
export function ageLabel(days: number): string {
  if (days >= AGE_MAX_DAYS - 1) return '∞';
  if (days % 365 === 0 && days) return `${days / 365} წ`;
  if (days % 30 === 0 && days) return `${days / 30} თვე`;
  if (days % 7 === 0 && days) return `${days / 7} კვ`;
  return `${days} დღე`;
}
const SEX_KA: Record<string, string> = { male: 'მამრ.', female: 'მდედრ.' };
const PREG_KA: Record<string, string> = { P: 'ორსული', T1: 'I ტრიმ.', T2: 'II ტრიმ.', T3: 'III ტრიმ.' };
export const criteriaLabel = (r: Pick<RangeRow, 'sex' | 'pregnancy' | 'method_id'>, methodName?: (id: string) => string) =>
  [r.sex ? SEX_KA[r.sex] : 'ორივე სქესი', r.pregnancy ? PREG_KA[r.pregnancy] : null, r.method_id ? (methodName?.(r.method_id) ?? 'ანალიზატორი') : null].filter(Boolean).join(', ');

/**
 * ნორმების ნაკრების შემოწმება შენახვამდე. აბრუნებს შეცდომების სიას (ცარიელი = სწორია).
 *  • ქვედა ≤ ზედა; რიცხვითს — ერთი ზღვარი მაინც; ხარისხობრივს — ნორმალური მნიშვნელობა
 *  • ერთი და იმავე კრიტერიუმებით (სქესი + ორსულობა + ანალიზატორი) ასაკები არ უნდა გადაიფაროს
 */
export function validateRanges(ranges: RangeRow[], resultType: string, methodName?: (id: string) => string): string[] {
  const errs: string[] = [];
  ranges.forEach((r, i) => {
    const n = `ხაზი ${i + 1}`;
    if (r.age_min_days < 0 || r.age_max_days > AGE_MAX_DAYS || r.age_min_days > r.age_max_days) errs.push(`${n}: ასაკის დიაპაზონი არასწორია`);
    if (r.pregnancy && r.sex === 'male') errs.push(`${n}: ორსულობის ნორმა მამრობითი სქესისთვის`);
    if (resultType === 'numeric') {
      if (r.low === null && r.high === null) errs.push(`${n}: მიუთითეთ ქვედა ან ზედა ზღვარი`);
      if (r.low !== null && r.high !== null && Number(r.low) > Number(r.high)) errs.push(`${n}: ქვედა ზღვარი ზედაზე მეტია`);
    } else if (!r.normal_text?.trim()) errs.push(`${n}: მიუთითეთ ნორმალური მნიშვნელობა`);
  });
  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      const a = ranges[i]; const b = ranges[j];
      if ((a.sex ?? null) !== (b.sex ?? null) || (a.pregnancy ?? null) !== (b.pregnancy ?? null) || (a.method_id ?? null) !== (b.method_id ?? null)) continue;
      if (a.age_min_days <= b.age_max_days && b.age_min_days <= a.age_max_days) {
        errs.push(`ხაზები ${i + 1} და ${j + 1} ერთმანეთს ფარავს (${criteriaLabel(a, methodName)}, ასაკი ${ageLabel(Math.max(a.age_min_days, b.age_min_days))} – ${ageLabel(Math.min(a.age_max_days, b.age_max_days))})`);
      }
    }
  }
  return errs;
}

/**
 * დაუფარავი ასაკები — ძირითადი პოპულაციისთვის (ორსულობისა და ანალიზატორის გარეშე), თითო სქესზე.
 * მაგ. ["0 დღე – 17 წ (ორივე სქესი)"] — ნიშნავს, რომ ბავშვთა ნორმა არ არის.
 */
export function coverageGaps(ranges: RangeRow[]): string[] {
  const base = ranges.filter((r) => !r.pregnancy && !r.method_id);
  if (!ranges.length) return ['ნორმა საერთოდ არ არის'];
  const gapsFor = (sex: 'male' | 'female') => {
    const iv = base.filter((r) => r.sex === null || r.sex === sex).map((r) => [r.age_min_days, r.age_max_days] as const).sort((x, y) => x[0] - y[0]);
    const gaps: [number, number][] = []; let cur = 0;
    for (const [lo, hi] of iv) { if (lo > cur) gaps.push([cur, lo - 1]); cur = Math.max(cur, hi + 1); }
    if (cur < AGE_MAX_DAYS - 1) gaps.push([cur, AGE_MAX_DAYS]);
    return gaps;
  };
  const m = gapsFor('male'); const f = gapsFor('female');
  const key = (g: [number, number][]) => g.map((x) => x.join('-')).join(',');
  const fmt = (g: [number, number][], who: string) => g.map(([lo, hi]) => `${ageLabel(lo)} – ${hi >= AGE_MAX_DAYS - 1 ? '∞' : ageLabel(hi + 1)} (${who})`);
  if (key(m) === key(f)) return fmt(m, 'ორივე სქესი');
  return [...fmt(m, 'მამრ.'), ...fmt(f, 'მდედრ.')];
}

/** ორი ნაკრების შედარება (ცვლილების არარსებობის აღმოსაჩენად) */
export const normalizeRanges = (rs: RangeRow[]) => rs.map((r) => ({
  sex: r.sex ?? null, age_min_days: r.age_min_days, age_max_days: r.age_max_days, pregnancy: r.pregnancy ?? null, method_id: r.method_id ?? null,
  low: r.low === null || r.low === undefined ? null : String(Number(r.low)), high: r.high === null || r.high === undefined ? null : String(Number(r.high)),
  normal_text: r.normal_text?.trim() || null,
})).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
