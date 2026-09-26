import { useQuery } from '@tanstack/react-query';
import { api } from '../../../api/client';

// ============================================================ ტიპები
export type Pregnancy = 'P' | 'T1' | 'T2' | 'T3';
export interface NormRange {
  sex: 'male' | 'female' | null; age_min_days: number; age_max_days: number;
  pregnancy: Pregnancy | null; method_id: string | null;
  low: string | null; high: string | null; normal_text: string | null;
}
export interface LabMethod { id: string; name: string; kind: 'analyzer' | 'manual' | 'method'; manufacturer: string | null; serial_number: string | null; note: string | null; is_active: boolean; services: number }
export interface LabPermissions { lab_head: boolean; norms: boolean; blanks: boolean; methods: boolean }

export const useLabPermissions = () => useQuery({ queryKey: ['lab-permissions'], queryFn: () => api<LabPermissions>('/lab/config/permissions'), staleTime: 60_000 });
export const useLabMethods = (includeInactive = false) =>
  useQuery({ queryKey: ['lab-methods', includeInactive], queryFn: () => api<LabMethod[]>('/lab/methods', { query: { include_inactive: includeInactive } }) });

export const PREG_KA: Record<Pregnancy, string> = { P: 'ორსული (ნებისმიერი)', T1: 'I ტრიმესტრი', T2: 'II ტრიმესტრი', T3: 'III ტრიმესტრი' };
export const SEX_KA: Record<string, string> = { male: 'მამრ.', female: 'მდედრ.' };
export const METHOD_KIND_KA: Record<string, string> = { analyzer: 'ანალიზატორი', manual: 'ხელით', method: 'მეთოდი' };

// ============================================================ ასაკი: დღეები ↔ დღე/კვირა/თვე/წელი
// ბაზაში ინახება დღეებში, ორივე ზღვარი ჩათვლით. ეკრანზე „დან (ჩათვლით) — მდე (არ ჩათვლით)“: 0–18 წ = 0..6569 დღე.
export const AGE_MAX = 54750;
export type AgeUnit = 'd' | 'w' | 'm' | 'y';
export const UNIT_DAYS: Record<AgeUnit, number> = { d: 1, w: 7, m: 30, y: 365 };
export const UNIT_KA: Record<AgeUnit, string> = { d: 'დღე', w: 'კვირა', m: 'თვე', y: 'წელი' };
/** დღეები → ყველაზე „მრგვალი“ ერთეული */
export function toUnit(days: number): { v: number; u: AgeUnit } {
  if (days === 0) return { v: 0, u: 'y' };
  for (const u of ['y', 'm', 'w'] as AgeUnit[]) if (days % UNIT_DAYS[u] === 0) return { v: days / UNIT_DAYS[u], u };
  return { v: days, u: 'd' };
}
/** ზედა ზღვარი ეკრანზე (არ ჩათვლით); null = „ზღვრის გარეშე“ */
export const upperShown = (maxDays: number) => (maxDays >= AGE_MAX - 1 ? null : toUnit(maxDays + 1));
export const ageText = (days: number) => { const { v, u } = toUnit(days); return v === 0 ? '0' : `${v} ${UNIT_KA[u]}`; };
export function rangeAgeText(r: Pick<NormRange, 'age_min_days' | 'age_max_days'>) {
  const up = upperShown(r.age_max_days);
  if (r.age_min_days === 0 && !up) return 'ყველა ასაკი';
  return `${ageText(r.age_min_days)} – ${up ? `${up.v} ${UNIT_KA[up.u]}` : '∞'}`;
}
export const criteria = (r: NormRange, methodName: (id: string) => string) =>
  [r.sex ? SEX_KA[r.sex] : 'ორივე', r.pregnancy ? PREG_KA[r.pregnancy] : null, r.method_id ? methodName(r.method_id) : null].filter(Boolean).join(' · ');
export const valueText = (r: Pick<NormRange, 'low' | 'high' | 'normal_text'>) =>
  r.normal_text ?? (r.low !== null && r.high !== null ? `${Number(r.low)} – ${Number(r.high)}` : r.low !== null ? `> ${Number(r.low)}` : r.high !== null ? `< ${Number(r.high)}` : '—');

// ============================================================ ნორმების რედაქტორი (ხაზები)
/** რედაქტირების მდგომარეობა: ასაკი ერთეულებით */
export interface RangeRow {
  sex: '' | 'male' | 'female'; pregnancy: '' | Pregnancy; method_id: string;
  fromV: string; fromU: AgeUnit; toV: string; toU: AgeUnit; low: string; high: string; normal_text: string;
}
export function toRow(r: NormRange): RangeRow {
  const f = toUnit(r.age_min_days); const t = upperShown(r.age_max_days);
  return { sex: r.sex ?? '', pregnancy: r.pregnancy ?? '', method_id: r.method_id ?? '', fromV: String(f.v), fromU: f.u,
    toV: t ? String(t.v) : '', toU: t?.u ?? 'y', low: r.low === null ? '' : String(Number(r.low)), high: r.high === null ? '' : String(Number(r.high)), normal_text: r.normal_text ?? '' };
}
export const emptyRow = (): RangeRow => ({ sex: '', pregnancy: '', method_id: '', fromV: '0', fromU: 'y', toV: '', toU: 'y', low: '', high: '', normal_text: '' });
const num = (v: string) => (v.trim() === '' ? null : Number(v.replace(',', '.')));
/** API-ს ფორმატი; ცარიელი „მდე“ = ზღვრის გარეშე */
export function fromRow(r: RangeRow, numeric: boolean) {
  const min = Math.round(Number(r.fromV || 0) * UNIT_DAYS[r.fromU]);
  const max = r.toV.trim() === '' ? AGE_MAX : Math.round(Number(r.toV) * UNIT_DAYS[r.toU]) - 1;
  return {
    sex: r.sex || null, pregnancy: r.pregnancy || null, method_id: r.method_id || null, age_min_days: min, age_max_days: Math.min(max, AGE_MAX),
    ...(numeric ? { low: num(r.low), high: num(r.high) } : { normal_text: r.normal_text.trim() || null }),
  };
}
/** კლიენტის მხარეს წინასწარი შემოწმება (საბოლოოს სერვერი ამოწმებს) */
export function rowErrors(rows: RangeRow[], numeric: boolean): string[] {
  const errs: string[] = [];
  const conv = rows.map((r) => fromRow(r, numeric));
  conv.forEach((r, i) => {
    const n = `ხაზი ${i + 1}`;
    if (!Number.isFinite(r.age_min_days) || !Number.isFinite(r.age_max_days) || r.age_min_days > r.age_max_days) errs.push(`${n}: ასაკი`);
    if (r.pregnancy && r.sex === 'male') errs.push(`${n}: ორსულობა მამრობით სქესზე`);
    if (numeric) {
      const lo = (r as { low: number | null }).low; const hi = (r as { high: number | null }).high;
      if ((lo !== null && !Number.isFinite(lo)) || (hi !== null && !Number.isFinite(hi))) errs.push(`${n}: რიცხვი`);
      else if (lo === null && hi === null) errs.push(`${n}: ქვედა ან ზედა ზღვარი`);
      else if (lo !== null && hi !== null && lo > hi) errs.push(`${n}: ქვედა > ზედა`);
    } else if (!(r as { normal_text: string | null }).normal_text) errs.push(`${n}: ნორმალური მნიშვნელობა`);
  });
  for (let i = 0; i < conv.length; i++) for (let j = i + 1; j < conv.length; j++) {
    const a = conv[i]; const b = conv[j];
    if (a.sex === b.sex && a.pregnancy === b.pregnancy && a.method_id === b.method_id && a.age_min_days <= b.age_max_days && b.age_min_days <= a.age_max_days) {
      errs.push(`ხაზები ${i + 1} და ${j + 1} ერთმანეთს ფარავს`);
    }
  }
  return errs;
}

export function RangesEditor({ rows, onChange, numeric, methods }: { rows: RangeRow[]; onChange: (r: RangeRow[]) => void; numeric: boolean; methods: LabMethod[] }) {
  const set = (i: number, patch: Partial<RangeRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const h = { height: 34, fontSize: 13 };
  const unitSel = (v: AgeUnit, on: (u: AgeUnit) => void, label: string) => (
    <select aria-label={label} className="select" style={{ ...h, width: 78 }} value={v} onChange={(e) => on(e.target.value as AgeUnit)}>
      {(['y', 'm', 'w', 'd'] as AgeUnit[]).map((u) => <option key={u} value={u}>{UNIT_KA[u]}</option>)}
    </select>
  );
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div style={{ overflowX: 'auto' }}>
        <table className="table" style={{ minWidth: 860 }}>
          <thead><tr><th>სქესი</th><th>ორსულობა</th><th>ანალიზატორი</th><th>ასაკი დან (ჩათვლით)</th><th>მდე (არ ჩათვლით)</th>
            {numeric ? <><th>ქვედა</th><th>ზედა</th></> : <th>ნორმალური მნიშვნელობა</th>}<th /></tr></thead>
          <tbody>{rows.map((r, i) => (
            <tr key={i}>
              <td><select aria-label="სქესი" className="select" style={{ ...h, width: 92 }} value={r.sex} onChange={(e) => set(i, { sex: e.target.value as RangeRow['sex'], ...(e.target.value === 'male' ? { pregnancy: '' } : {}) })}>
                <option value="">ორივე</option><option value="male">მამრ.</option><option value="female">მდედრ.</option></select></td>
              <td><select aria-label="ორსულობა" className="select" style={{ ...h, width: 140 }} value={r.pregnancy} disabled={r.sex === 'male'} onChange={(e) => set(i, { pregnancy: e.target.value as RangeRow['pregnancy'] })}>
                <option value="">—</option>{(Object.keys(PREG_KA) as Pregnancy[]).map((k) => <option key={k} value={k}>{PREG_KA[k]}</option>)}</select></td>
              <td><select aria-label="ანალიზატორი" className="select" style={{ ...h, width: 150 }} value={r.method_id} onChange={(e) => set(i, { method_id: e.target.value })}>
                <option value="">ნებისმიერი</option>{methods.filter((m) => m.is_active || m.id === r.method_id).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></td>
              <td><div className="row" style={{ gap: 4 }}><input aria-label="ასაკი დან" className="input mono" style={{ ...h, width: 56 }} inputMode="numeric" value={r.fromV} onChange={(e) => set(i, { fromV: e.target.value.replace(/[^\d]/g, '') })} />{unitSel(r.fromU, (u) => set(i, { fromU: u }), 'ერთეული დან')}</div></td>
              <td><div className="row" style={{ gap: 4 }}><input aria-label="ასაკი მდე" className="input mono" style={{ ...h, width: 56 }} inputMode="numeric" placeholder="∞" value={r.toV} onChange={(e) => set(i, { toV: e.target.value.replace(/[^\d]/g, '') })} />{unitSel(r.toU, (u) => set(i, { toU: u }), 'ერთეული მდე')}</div></td>
              {numeric ? <>
                <td><input aria-label="ქვედა" className="input mono" style={{ ...h, width: 76 }} inputMode="decimal" value={r.low} onChange={(e) => set(i, { low: e.target.value })} /></td>
                <td><input aria-label="ზედა" className="input mono" style={{ ...h, width: 76 }} inputMode="decimal" value={r.high} onChange={(e) => set(i, { high: e.target.value })} /></td>
              </> : <td><input aria-label="ნორმა" className="input" style={h} value={r.normal_text} onChange={(e) => set(i, { normal_text: e.target.value })} placeholder="უარყოფითი" /></td>}
              <td><button className="icon-btn" type="button" aria-label="ხაზის წაშლა" onClick={() => onChange(rows.filter((_, j) => j !== i))}>×</button></td>
            </tr>))}</tbody>
        </table>
      </div>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button className="btn sm" type="button" onClick={() => onChange([...rows, emptyRow()])}>+ ხაზი</button>
        <button className="btn sm" type="button" onClick={() => onChange([...rows, { ...emptyRow(), toV: '18' }])}>+ ბავშვთა (0–18 წ)</button>
        <button className="btn sm" type="button" onClick={() => onChange([...rows, { ...emptyRow(), sex: 'female', pregnancy: 'T1' }, { ...emptyRow(), sex: 'female', pregnancy: 'T2' }, { ...emptyRow(), sex: 'female', pregnancy: 'T3' }])}>+ ტრიმესტრები</button>
        <span className="hint grow">„მდე“ ცარიელი = ზედა ზღვრის გარეშე. ყველაზე ზუსტი ნორმა შეირჩევა: ტრიმესტრი → ორსული → ანალიზატორი → სქესი → ასაკი.</span>
      </div>
    </div>
  );
}
