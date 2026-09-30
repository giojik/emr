/**
 * Westgard-ის წესები (სუფთა ფუნქცია). z = (მნიშვნელობა − mean) / SD.
 *  1_2s — |z| > 2 (გაფრთხილება)       1_3s — |z| > 3 (უარყოფა)
 *  2_2s — ზედიზედ 2, ერთ მხარეს |z| > 2   R_4s — ერთ სერიაში (სხვა დონე ±60 წთ) ერთი > +2, მეორე < −2
 *  4_1s — ზედიზედ 4, ერთ მხარეს |z| > 1   10x — ზედიზედ 10 ერთ მხარეს
 * „ზედიზედ“ — ამ ანალიზატორის ამ კომპონენტის ყველა დონე ერთად (z-ქულებით), დროის რიგით.
 */
export const ALL_RULES = ['1_2s', '1_3s', '2_2s', 'R_4s', '4_1s', '10x'] as const;
export type Rule = (typeof ALL_RULES)[number];
export const RULE_KA: Record<Rule, string> = {
  '1_2s': '1-2s — ერთი გაზომვა ±2 SD-ს გარეთ (გაფრთხილება)',
  '1_3s': '1-3s — ერთი გაზომვა ±3 SD-ს გარეთ',
  '2_2s': '2-2s — ზედიზედ ორი ±2 SD-ს გარეთ, ერთ მხარეს',
  'R_4s': 'R-4s — ერთ სერიაში დონეებს შორის სხვაობა > 4 SD',
  '4_1s': '4-1s — ზედიზედ ოთხი ±1 SD-ს გარეთ, ერთ მხარეს',
  '10x': '10x — ზედიზედ ათი სამიზნის ერთ მხარეს',
};

/** series: ამ ანალიზატორის ამ კომპონენტის წინა შედეგები (ახლიდან ძველისკენ), გამორიცხულების გარეშე */
export function evaluate(z: number, series: { z: number; at: Date; targetId: string }[], now: { at: Date; targetId: string }, rules: readonly string[]) {
  const on = (r: Rule) => rules.includes(r);
  const v: Rule[] = [];
  const seq = [z, ...series.map((s) => s.z)];
  const same = (n: number, pred: (x: number) => boolean) => seq.length >= n && seq.slice(0, n).every(pred);
  if (on('1_3s') && Math.abs(z) > 3) v.push('1_3s');
  if (on('2_2s') && (same(2, (x) => x > 2) || same(2, (x) => x < -2))) v.push('2_2s');
  if (on('R_4s')) {
    const run = series.filter((s) => s.targetId !== now.targetId && Math.abs(s.at.getTime() - now.at.getTime()) <= 60 * 60_000);
    if (run.some((s) => (z > 2 && s.z < -2) || (z < -2 && s.z > 2))) v.push('R_4s');
  }
  if (on('4_1s') && (same(4, (x) => x > 1) || same(4, (x) => x < -1))) v.push('4_1s');
  if (on('10x') && (same(10, (x) => x > 0) || same(10, (x) => x < 0))) v.push('10x');
  const warn = on('1_2s') && Math.abs(z) > 2;
  return { status: v.length ? 'reject' as const : warn ? 'warn' as const : 'accept' as const, violations: v.length ? v : warn ? ['1_2s'] : [] };
}
