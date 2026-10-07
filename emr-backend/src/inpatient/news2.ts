/**
 * NEWS2 (National Early Warning Score 2, RCP 2017) — მხოლოდ მინიშნება (0044).
 *   სუნთქვა, SpO₂ (შკალა 1 ან 2 — ჰიპერკაპნიური სუნთქვის უკმარისობა), ჟანგბადი, სისტოლური წნევა, პულსი, ცნობიერება (ACVPU), ტემპერატურა.
 *   ქულა ითვლება მხოლოდ სრულ ნაკრებზე; 16 წლამდე — არ ითვლება.
 *   დონე: 0–4 low; ერთ პარამეტრზე 3 — low_red; 5–6 medium; ≥7 high.
 */
export interface News2Input {
  respiratory_rate?: number | null; spo2?: number | null; spo2_scale?: 1 | 2 | null; o2_supplement?: boolean | null;
  systolic_bp?: number | null; heart_rate?: number | null; consciousness?: string | null; temperature?: number | null;
}
export type News2Level = 'low' | 'low_red' | 'medium' | 'high';
export interface News2Result { score: number; level: News2Level; parts: Record<string, number> }

const band = (v: number, rules: [number, number][]) => { for (const [max, pts] of rules) if (v <= max) return pts; return 0; };

export function news2(v: News2Input): News2Result | null {
  const { respiratory_rate: rr, spo2, systolic_bp: sbp, heart_rate: hr, consciousness: c, temperature: t } = v;
  if (rr == null || spo2 == null || v.o2_supplement == null || sbp == null || hr == null || !c || t == null) return null;
  const o2 = !!v.o2_supplement;
  const parts: Record<string, number> = {
    rr: band(rr, [[8, 3], [11, 1], [20, 0], [24, 2], [Infinity, 3]]),
    spo2: (v.spo2_scale ?? 1) === 2
      ? (spo2 <= 83 ? 3 : spo2 <= 85 ? 2 : spo2 <= 87 ? 1 : spo2 <= 92 ? 0 : !o2 ? 0 : spo2 <= 94 ? 1 : spo2 <= 96 ? 2 : 3)
      : band(spo2, [[91, 3], [93, 2], [95, 1], [Infinity, 0]]),
    o2: o2 ? 2 : 0,
    sbp: band(sbp, [[90, 3], [100, 2], [110, 1], [219, 0], [Infinity, 3]]),
    hr: band(hr, [[40, 3], [50, 1], [90, 0], [110, 1], [130, 2], [Infinity, 3]]),
    acvpu: c === 'A' ? 0 : 3,
    temp: band(Math.round(t * 10) / 10, [[35.0, 3], [36.0, 1], [38.0, 0], [39.0, 1], [Infinity, 2]]),
  };
  const score = Object.values(parts).reduce((a, b) => a + b, 0);
  const level: News2Level = score >= 7 ? 'high' : score >= 5 ? 'medium' : Object.values(parts).some((p) => p === 3) ? 'low_red' : 'low';
  return { score, level, parts };
}
export const NEWS2_RANK: Record<News2Level, number> = { low: 0, low_red: 1, medium: 2, high: 3 };
export const NEWS2_KA: Record<News2Level, string> = { low: 'დაბალი', low_red: 'დაბალი (ერთი პარამეტრი — 3)', medium: 'საშუალო', high: 'მაღალი' };
