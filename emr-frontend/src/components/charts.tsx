/**
 * მსუბუქი SVG დიაგრამები (0061) — ბიბლიოთეკის გარეშე. ფერები — CSS ცვლადებიდან (თემასთან თავსებადი).
 *  BarChart — სვეტები (დროის მწკრივი); LineChart — ხაზი + შედარების ხაზი (შარშან); Sparkline — ფილაზე; StackBar — ნაწილების ზოლი.
 */
export interface Point { label: string; value: number | null; hint?: string }

const fmtNum = (v: number) => (Math.abs(v) >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 0 }) : String(Math.round(v * 10) / 10));

export function BarChart({ points, format = fmtNum, height = 180, color = 'var(--accent)' }: { points: Point[]; format?: (v: number) => string; height?: number; color?: string }) {
  const W = 820, H = height, P = 28;
  if (!points.length) return <div className="muted small">მონაცემი არ არის</div>;
  const vals = points.map((p) => p.value ?? 0);
  const max = Math.max(0, ...vals); const min = Math.min(0, ...vals); const span = max - min || 1;
  const bw = (W - P * 2) / points.length;
  const y = (v: number) => P / 2 + (H - P * 1.5) * (1 - (v - min) / span);
  const step = Math.ceil(points.length / 12);
  return (
    <svg viewBox={`0 0 ${W} ${H + 18}`} width="100%" role="img" aria-label="დიაგრამა" style={{ maxHeight: H + 60 }}>
      <line x1={P} x2={W - P} y1={y(0)} y2={y(0)} stroke="var(--line)" />
      <text x={2} y={y(max) + 4} fontSize="10" fill="var(--muted)">{format(max)}</text>
      {points.map((p, i) => {
        const x = P + i * bw + bw * 0.12; const w = Math.max(1, bw * 0.76);
        return (
          <g key={`${p.label}-${i}`}>
            {p.value !== null && <rect x={x} width={w} y={Math.min(y(p.value), y(0))} height={Math.max(1, Math.abs(y(p.value) - y(0)))} rx={2} fill={p.value < 0 ? 'var(--danger-ink)' : color}>
              <title>{p.hint ?? `${p.label}: ${format(p.value)}`}</title></rect>}
            {i % step === 0 && <text x={x + w / 2} y={H + 12} fontSize="10" textAnchor="middle" fill="var(--muted)">{p.label}</text>}
          </g>);
      })}
    </svg>
  );
}

/** ხაზოვანი: მთავარი სერია + შედარების სერია (წყვეტილი); null — წყვეტა */
export function LineChart({ labels, series, format = fmtNum, height = 200 }: {
  labels: string[]; series: { name: string; values: (number | null)[]; color: string; dashed?: boolean }[]; format?: (v: number) => string; height?: number;
}) {
  const W = 820, H = height, PL = 44, PR = 12, PT = 10, PB = 24;
  const all = series.flatMap((s) => s.values).filter((v): v is number => v !== null);
  if (!labels.length || !all.length) return <div className="muted small">მონაცემი არ არის</div>;
  const max = Math.max(0, ...all); const min = Math.min(0, ...all); const span = max - min || 1;
  const x = (i: number) => PL + (labels.length === 1 ? (W - PL - PR) / 2 : (i * (W - PL - PR)) / (labels.length - 1));
  const y = (v: number) => PT + (H - PT - PB) * (1 - (v - min) / span);
  const path = (vals: (number | null)[]) => {
    let d = ''; let pen = false;
    vals.forEach((v, i) => { if (v === null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)} `; pen = true; });
    return d.trim();
  };
  return (
    <div className="stack" style={{ gap: 4 }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="ტრენდი" style={{ maxHeight: H + 40 }}>
        {[0, 0.5, 1].map((f) => min + span * f).filter((v, i, arr) => arr.findIndex((w) => format(w) === format(v)) === i).map((v) => <g key={v}>
          <line x1={PL} x2={W - PR} y1={y(v)} y2={y(v)} stroke="var(--line-soft)" />
          <text x={PL - 6} y={y(v) + 3} fontSize="10" textAnchor="end" fill="var(--muted)">{format(v)}</text></g>)}
        {series.map((s) => <path key={s.name} d={path(s.values)} fill="none" stroke={s.color} strokeWidth={s.dashed ? 1.5 : 2.2} strokeDasharray={s.dashed ? '5 4' : undefined} />)}
        {series.map((s) => s.values.map((v, i) => v === null ? null : <circle key={`${s.name}-${i}`} cx={x(i)} cy={y(v)} r={s.dashed ? 2 : 3} fill={s.color}><title>{`${labels[i]} · ${s.name}: ${format(v)}`}</title></circle>))}
        {labels.map((l, i) => <text key={l + i} x={x(i)} y={H - 6} fontSize="10" textAnchor="middle" fill="var(--muted)">{l}</text>)}
      </svg>
      <div className="row small" style={{ gap: 14 }}>
        {series.map((s) => <span key={s.name} className="row" style={{ gap: 6 }}><svg width="18" height="6" aria-hidden="true"><line x1="0" x2="18" y1="3" y2="3" stroke={s.color} strokeWidth="2" strokeDasharray={s.dashed ? '4 3' : undefined} /></svg>{s.name}</span>)}
      </div>
    </div>
  );
}

/** პატარა ხაზი ფილაზე (null — გამოტოვება) */
export function Sparkline({ values, width = 120, height = 28, color = 'var(--accent)' }: { values: (number | null)[]; width?: number; height?: number; color?: string }) {
  const v = values.filter((x): x is number => x !== null);
  if (v.length < 2) return null;
  const max = Math.max(...v); const min = Math.min(...v); const span = max - min || 1;
  let d = ''; let pen = false;
  values.forEach((val, i) => {
    if (val === null) { pen = false; return; }
    const px = (i * (width - 4)) / Math.max(1, values.length - 1) + 2; const py = 2 + (height - 4) * (1 - (val - min) / span);
    d += `${pen ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)} `; pen = true;
  });
  const lastI = values.length - 1 - [...values].reverse().findIndex((x) => x !== null);
  const lv = values[lastI] as number;
  return (
    <svg width={width} height={height} aria-hidden="true" style={{ display: 'block' }}>
      <path d={d.trim()} fill="none" stroke={color} strokeWidth="1.6" />
      <circle cx={(lastI * (width - 4)) / Math.max(1, values.length - 1) + 2} cy={2 + (height - 4) * (1 - (lv - min) / span)} r="2.2" fill={color} />
    </svg>
  );
}

/** ნაწილების ზოლი (მაგ. საწოლები: დაკავებული / თავისუფალი / დასალაგებელი / დაბლოკილი) */
export function StackBar({ parts, height = 14 }: { parts: { label: string; value: number; color: string }[]; height?: number }) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div style={{ display: 'flex', height, borderRadius: height / 2, overflow: 'hidden', background: 'var(--line-soft)' }} aria-hidden="true">
        {total > 0 && parts.filter((p) => p.value > 0).map((p) => <div key={p.label} title={`${p.label}: ${p.value}`} style={{ width: `${(p.value / total) * 100}%`, background: p.color }} />)}
      </div>
      <div className="row small" style={{ flexWrap: 'wrap', gap: 12 }}>
        {parts.map((p) => <span key={p.label} className="row" style={{ gap: 5 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: p.color, display: 'inline-block' }} />{p.label} <strong className="mono">{p.value}</strong></span>)}
      </div>
    </div>
  );
}
