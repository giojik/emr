import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api } from '../../api/client';
import { ErrorBox, Loading, Modal } from '../../components/ui';
import { tsDate, unitFmt } from '../../lib/format';

interface Point {
  analyte_id: string; code: string; name: string; unit: string; result_type: string; sort_order: number; service_id: string; service_name: string; group_name: string;
  item_id: string; at: string; value_num: string | null; value_text: string | null; flag: string | null; ref_low: string | null; ref_high: string | null; ref_text: string | null;
}
const FLAG_COLOR: Record<string, string> = { H: 'var(--warn-ink)', L: 'var(--warn-ink)', A: 'var(--warn-ink)', HH: 'var(--danger-ink)', LL: 'var(--danger-ink)' };
const ARROW: Record<string, string> = { H: '↑', L: '↓', HH: '↑↑', LL: '↓↓', A: '*' };
const val = (p: Pick<Point, 'value_num' | 'value_text'>) => (p.value_num !== null ? String(Number(p.value_num)) : p.value_text ?? '');
const ref = (p: Point) => p.ref_text ?? (p.ref_low !== null && p.ref_high !== null ? `${Number(p.ref_low)}–${Number(p.ref_high)}` : p.ref_low !== null ? `> ${Number(p.ref_low)}` : p.ref_high !== null ? `< ${Number(p.ref_high)}` : '');

/**
 * კუმულაციური შედეგები: პაციენტის ვალიდირებული ლაბ. შედეგები ცხრილად (სტრიქონი — კომპონენტი, სვეტი — გაზომვა, ახლიდან)
 * და რიცხვითი კომპონენტის გრაფიკი ნორმის ზოლით. ფილტრი: ჯგუფი / ანალიზი.
 */
export function Cumulative({ patientId, serviceId, compact }: { patientId: string; serviceId?: string; compact?: boolean }) {
  const q = useQuery({ queryKey: ['lab-cumulative', patientId, serviceId ?? ''], queryFn: () => api<Point[]>(`/patients/${patientId}/lab-cumulative`, { query: { service_id: serviceId } }) });
  const [group, setGroup] = useState(''); const [chart, setChart] = useState<string | null>(null);
  const data = useMemo(() => (q.data ?? []).filter((p) => !group || p.group_name === group), [q.data, group]);
  const groups = useMemo(() => [...new Set((q.data ?? []).map((p) => p.group_name))].sort(), [q.data]);
  // სვეტები — გაზომვის თარიღით (ერთ დღეს რამდენიმე — ცალ-ცალკე), ბოლო 12
  const cols = useMemo(() => {
    const m = new Map<string, string>(); for (const p of data) if (!m.has(p.item_id)) m.set(p.item_id, p.at);
    return [...m.entries()].sort((a, b) => b[1].localeCompare(a[1])).slice(0, compact ? 6 : 12);
  }, [data, compact]);
  const rows = useMemo(() => {
    const m = new Map<string, { a: Point; cells: Map<string, Point> }>();
    for (const p of data) { const r = m.get(p.analyte_id) ?? { a: p, cells: new Map() }; r.cells.set(p.item_id, p); m.set(p.analyte_id, r); }
    return [...m.values()].sort((x, y) => x.a.service_name.localeCompare(y.a.service_name, 'ka') || x.a.sort_order - y.a.sort_order);
  }, [data]);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data?.length) return <div className="empty small">დადასტურებული ლაბორატორიული შედეგები ჯერ არ არის.</div>;
  let lastSvc = '';
  return (
    <div className="stack">
      {!serviceId && groups.length > 1 && <div className="seg" role="group" aria-label="ჯგუფი">
        <button type="button" aria-pressed={!group} onClick={() => setGroup('')}>ყველა</button>
        {groups.map((g) => <button key={g} type="button" aria-pressed={group === g} onClick={() => setGroup(g)}>{g}</button>)}</div>}
      <div style={{ overflowX: 'auto' }}>
        <table className="table">
          <thead><tr><th>კომპონენტი</th>{cols.map(([id, at]) => <th key={id} className="num small" style={{ whiteSpace: 'nowrap' }}>{tsDate(at)}</th>)}<th className="small">ნორმა (ბოლო)</th></tr></thead>
          <tbody>{rows.map(({ a, cells }) => {
            const head = a.service_id !== lastSvc; lastSvc = a.service_id;
            const last = cells.get(cols.find(([id]) => cells.has(id))?.[0] ?? '') ?? a;
            const numeric = a.result_type === 'numeric' && [...cells.values()].filter((p) => p.value_num !== null).length >= 2;
            return [
              head && <tr key={`s${a.service_id}`}><td colSpan={cols.length + 2} className="small" style={{ background: 'var(--bg)', fontWeight: 600 }}>{a.service_name}</td></tr>,
              <tr key={a.analyte_id}>
                <td>{numeric ? <button type="button" className="linklike" style={{ border: 0, background: 'none', padding: 0, font: 'inherit', color: 'var(--accent)', cursor: 'pointer' }}
                  onClick={() => setChart(chart === a.analyte_id ? null : a.analyte_id)} title="გრაფიკი">{a.name}</button> : a.name}
                  {a.unit && <span className="small muted"> {unitFmt(a.unit)}</span>}</td>
                {cols.map(([id]) => { const p = cells.get(id); return <td key={id} className="num mono" style={p?.flag && p.flag !== 'N' ? { color: FLAG_COLOR[p.flag], fontWeight: 600 } : undefined}>
                  {p ? `${val(p)}${p.flag && p.flag !== 'N' ? ` ${ARROW[p.flag] ?? ''}` : ''}` : ''}</td>; })}
                <td className="small muted">{ref(last)}</td>
              </tr>,
              chart === a.analyte_id && <tr key={`c${a.analyte_id}`}><td colSpan={cols.length + 2}><TrendChart points={[...cells.values()]} unit={a.unit} /></td></tr>,
            ];
          })}</tbody>
        </table>
      </div>
      <span className="hint">დაჭერით კომპონენტის სახელზე — დინამიკის გრაფიკი. ნაჩვენებია ბოლო {compact ? 6 : 12} გაზომვა.</span>
    </div>
  );
}

/** ხაზოვანი გრაფიკი (SVG): მნიშვნელობები დროში + ნორმის ზოლი (ბოლო გაზომვის ნორმით) */
function TrendChart({ points, unit }: { points: Point[]; unit: string }) {
  const pts = points.filter((p) => p.value_num !== null).sort((a, b) => a.at.localeCompare(b.at));
  const W = 640; const H = 180; const P = { l: 44, r: 12, t: 10, b: 26 };
  const last = pts[pts.length - 1];
  const lo = last?.ref_low !== null && last?.ref_low !== undefined ? Number(last.ref_low) : null; const hi = last?.ref_high !== null && last?.ref_high !== undefined ? Number(last.ref_high) : null;
  const vals = pts.map((p) => Number(p.value_num)); const all = [...vals, ...(lo !== null ? [lo] : []), ...(hi !== null ? [hi] : [])];
  let min = Math.min(...all); let max = Math.max(...all); const pad = (max - min || Math.abs(max) || 1) * 0.12; min -= pad; max += pad;
  const t0 = new Date(pts[0].at).getTime(); const t1 = new Date(last.at).getTime(); const span = t1 - t0 || 1;
  const x = (p: Point) => P.l + ((new Date(p.at).getTime() - t0) / span) * (W - P.l - P.r) || P.l + (W - P.l - P.r) / 2;
  const y = (v: number) => P.t + (1 - (v - min) / (max - min)) * (H - P.t - P.b);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxWidth: W, display: 'block' }} role="img" aria-label="დინამიკის გრაფიკი">
      {lo !== null && hi !== null && <rect x={P.l} y={y(hi)} width={W - P.l - P.r} height={Math.max(y(lo) - y(hi), 1)} fill="var(--ok-weak, #e7f6ec)" />}
      {[min + pad, (min + max) / 2, max - pad].map((v) => <g key={v}><line x1={P.l} x2={W - P.r} y1={y(v)} y2={y(v)} stroke="var(--line-soft, #eee)" />
        <text x={P.l - 6} y={y(v) + 4} fontSize="10" textAnchor="end" fill="var(--muted, #777)">{Number(v.toPrecision(3))}</text></g>)}
      <polyline fill="none" stroke="var(--accent, #1F4E79)" strokeWidth="2" points={pts.map((p) => `${x(p)},${y(Number(p.value_num))}`).join(' ')} />
      {pts.map((p) => <g key={p.item_id}><circle cx={x(p)} cy={y(Number(p.value_num))} r="4" fill={p.flag && p.flag !== 'N' ? (p.flag.length === 2 ? '#B42318' : '#B26B00') : 'var(--accent, #1F4E79)'} />
        <text x={x(p)} y={H - 8} fontSize="10" textAnchor="middle" fill="var(--muted, #777)">{tsDate(p.at).slice(0, 5)}</text>
        <title>{`${tsDate(p.at)}: ${val(p)} ${unit}`}</title></g>)}
    </svg>
  );
}

export function CumulativeModal({ patientId, serviceId, title, onClose }: { patientId: string; serviceId?: string; title: string; onClose: () => void }) {
  return (
    <Modal title={title} onClose={onClose} width={1000} footer={<button className="btn" type="button" onClick={onClose}>დახურვა</button>}>
      <Cumulative patientId={patientId} serviceId={serviceId} />
    </Modal>
  );
}
