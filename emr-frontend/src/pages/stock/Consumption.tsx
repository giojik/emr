import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, can } from '../../api/client';
import type { EncounterListItem, PatientListItem } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import PatientSearch from '../../components/PatientSearch';
import { ErrorBox, Loading, useToast } from '../../components/ui';
import { tsDate } from '../../lib/format';
import ItemSearch from './ItemSearch';
import { money2, qtyFmt, REVERSE_ROLES, type OpsDoc, type OpsRow, type StockItem, type StockLocation } from './types';

interface Line { key: string; item: Pick<StockItem, 'id' | 'name' | 'code' | 'base_unit_name' | 'serial_tracked'>; qty: string; lot_id: string | null; lot_label: string | null }
let seq = 0;

/** ხარჯი პაციენტზე: ლოკაცია → პაციენტი → ვიზიტი → საქონელი (სკანირებით — ზუსტი ლოტი/სერიული, ან FEFO) */
export default function Consumption() {
  const { user } = useAuth(); const qc = useQueryClient(); const toast = useToast();
  const mine = useQuery({ queryKey: ['stock-my-locations'], queryFn: () => api<StockLocation[]>('/stock/my-locations') });
  const [loc, setLoc] = useState('');
  const [pat, setPat] = useState<PatientListItem | null>(null);
  const encs = useQuery({ queryKey: ['encounters', 'patient', pat?.id], queryFn: () => api<EncounterListItem[]>('/encounters', { query: { patient_id: pat!.id } }), enabled: !!pat });
  const open = (encs.data ?? []).filter((e) => e.status !== 'cancelled');
  const [enc, setEnc] = useState<string | null>(null);
  const encId = enc ?? open.find((e) => e.status === 'active')?.id ?? open[0]?.id ?? '';
  const [lines, setLines] = useState<Line[]>([]);
  const [notes, setNotes] = useState('');
  const [last, setLast] = useState<OpsDoc | null>(null);
  const resolveLot = async (itemId: string, lotNo: string | null, serial: string | null) => {
    if (!lotNo && !serial) return null;
    const lots = await api<{ id: string; lot_no: string | null; serial_no: string | null; expires_on: string | null }[]>(`/stock/items/${itemId}/lots`);
    return lots.find((l) => (l.lot_no ?? '') === (lotNo ?? '') && (l.serial_no ?? '') === (serial ?? '')) ?? null;
  };
  const save = useMutation({
    mutationFn: () => api<OpsDoc>('/stock/consumptions', { body: { location_id: loc, patient_id: pat!.id, encounter_id: encId || null, notes: notes || null,
      lines: lines.map((l) => ({ item_id: l.item.id, qty_base: Number(l.qty.replace(',', '.')), lot_id: l.lot_id })) } }),
    onSuccess: (r) => { setLast(r); setLines([]); setNotes(''); toast.show(`გატარდა: ${r.doc_no}`); for (const k of ['stock-balances', 'stock-consumptions']) void qc.invalidateQueries({ queryKey: [k] }); },
  });
  const valid = loc && pat && lines.length && lines.every((l) => Number(l.qty.replace(',', '.')) > 0 && (!l.item.serial_tracked || l.lot_id));
  return (
    <div className="content">
      {toast.node}
      <section className="card card-pad" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
        <div className="field"><label htmlFor="cl">ლოკაცია <span className="req">*</span></label>
          <select id="cl" className="select" value={loc} onChange={(e) => setLoc(e.target.value)}>
            <option value="">— აირჩიეთ —</option>{mine.data?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>
        <div className="field"><span className="label">პაციენტი <span className="req">*</span></span>
          {pat ? <div className="row" style={{ height: 44 }}><strong className="grow">{pat.first_name} {pat.last_name} <span className="mono small muted">{pat.personal_number}</span></strong>
            <button className="btn sm" type="button" onClick={() => { setPat(null); setEnc(null); }}>შეცვლა</button></div>
            : <PatientSearch onSelect={(p) => { setPat(p); setEnc(null); }} />}</div>
        <div className="field"><label htmlFor="ce">ვიზიტი (ინვოისისთვის)</label>
          <select id="ce" className="select" disabled={!pat} value={encId} onChange={(e) => setEnc(e.target.value)}>
            <option value="">— ვიზიტის გარეშე (მხოლოდ აღრიცხვა) —</option>
            {open.map((e) => <option key={e.id} value={e.id}>{tsDate(e.start_time)} · {e.doctor_name ?? ''}{e.invoice_number ? ` · ${e.invoice_number}` : ''} · {e.status === 'active' ? 'აქტიური' : e.status === 'planned' ? 'დაგეგმილი' : 'დასრულებული'}</option>)}</select></div>
      </section>
      <section className="card card-pad stack">
        <ItemSearch disabled={!loc} placeholder={loc ? 'დაასკანერეთ შეფუთვა (ლოტი/სერიული ავტომატურად) ან მოძებნეთ' : 'ჯერ აირჩიეთ ლოკაცია'}
          onPick={(i) => setLines((ls) => [...ls, { key: `c${++seq}`, item: i, qty: '1', lot_id: null, lot_label: null }])}
          onScan={async (h) => {
            const lot = await resolveLot(h.item.id, h.lot, h.serial);
            setLines((ls) => {
              const same = !h.item.serial_tracked && ls.find((l) => l.item.id === h.item.id && l.lot_id === (lot?.id ?? null));
              if (same) return ls.map((l) => (l === same ? { ...l, qty: String(Number(l.qty) + 1) } : l));
              if (lot && ls.some((l) => l.lot_id === lot.id && h.item.serial_tracked)) return ls;
              return [...ls, { key: `c${++seq}`, item: h.item, qty: '1', lot_id: lot?.id ?? null, lot_label: lot ? `${lot.lot_no ?? ''}${lot.serial_no ? ` · SN ${lot.serial_no}` : ''}` : null }];
            });
          }} />
        <table className="table">
          <thead><tr><th>საქონელი</th><th>ლოტი</th><th className="num">რაოდენობა</th><th /></tr></thead>
          <tbody>{lines.map((l) => (
            <tr key={l.key}>
              <td><strong>{l.item.name}</strong> <span className="mono small muted">{l.item.code}</span>
                {l.item.serial_tracked && !l.lot_id && <div className="small" style={{ color: 'var(--danger-ink)' }}>სერიული საქონელი — დაასკანერეთ კონკრეტული ერთეული</div>}</td>
              <td className="mono small">{l.lot_label ?? <span className="muted">FEFO (ავტომატურად)</span>}</td>
              <td><input className="input mono num" style={{ height: 34, width: 90 }} aria-label="რაოდენობა" inputMode="decimal" disabled={l.item.serial_tracked} value={l.qty}
                onChange={(e) => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, qty: e.target.value } : x)))} /> <span className="small muted">{l.item.base_unit_name}</span></td>
              <td><button className="icon-btn" type="button" aria-label="წაშლა" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>×</button></td>
            </tr>))}
            {!lines.length && <tr><td colSpan={4} className="muted">დაამატეთ საქონელი</td></tr>}
          </tbody>
        </table>
        <div className="row"><input className="input grow" aria-label="შენიშვნა" placeholder="შენიშვნა (არასავალდებულო)" value={notes} onChange={(e) => setNotes(e.target.value)} />
          <button className="btn primary" type="button" disabled={!valid || save.isPending} onClick={() => save.mutate()}>ჩამოწერა პაციენტზე</button></div>
        <ErrorBox error={save.error} />
      </section>
      {last && (
        <section className="card card-pad stack" style={{ gap: 6 }}>
          <strong>{last.doc_no} — {last.patient_name}</strong>
          {last.lines.map((l) => <div key={l.id} className="small">{l.item_name} · {l.lot_no ?? ''}{l.serial_no ? ` SN ${l.serial_no}` : ''} · {qtyFmt(l.qty_base)} {l.base_unit_name}
            {l.invoiced ? <span className="chip ok" style={{ marginLeft: 6 }}>ინვოისში {money2(l.sale_price)}</span> : <span className="chip" style={{ marginLeft: 6 }}>მხოლოდ აღრიცხვა</span>}</div>)}
          {last.warnings?.map((w) => <div key={w} className="alert warn">{w}</div>)}
        </section>)}
      <History canReverse={can(user, ...(REVERSE_ROLES as unknown as Parameters<typeof can>[1][]))} patientId={pat?.id} />
    </div>
  );
}

function History({ canReverse, patientId }: { canReverse: boolean; patientId?: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['stock-consumptions', patientId], queryFn: () => api<OpsRow[]>('/stock/consumptions', { query: { patient_id: patientId } }) });
  const rev = useMutation({ mutationFn: (a: { id: string; reason: string }) => api(`/stock/docs/${a.id}/reverse`, { body: { reason: a.reason } }),
    onSuccess: () => { for (const k of ['stock-consumptions', 'stock-balances']) void qc.invalidateQueries({ queryKey: [k] }); } });
  return (
    <section className="card">
      <div className="card-head"><h2>{patientId ? 'პაციენტის ხარჯები' : 'ბოლო ხარჯები'}</h2></div>
      {q.isLoading ? <Loading /> : (
        <table className="table">
          <thead><tr><th>№</th><th>დრო</th><th>პაციენტი</th><th>ლოკაცია</th><th className="num">ხაზი</th><th className="num">თვითღირ.</th><th>ავტორი</th><th /></tr></thead>
          <tbody>{q.data?.slice(0, 100).map((d) => (
            <tr key={d.id} style={d.reversed_by ? { opacity: 0.55 } : undefined}>
              <td className="mono">{d.doc_no}</td><td className="small">{tsDate(d.created_at)}</td><td>{d.patient_name}</td><td className="small">{d.location_name}</td>
              <td className="num">{d.lines}</td><td className="num mono">{Number(d.total_net).toFixed(2)}</td><td className="small">{d.created_by_name}</td>
              <td>{d.reversed_by ? <span className="chip">შემობრუნდა {d.reversed_by_no}</span> : canReverse && <button className="btn sm" type="button" disabled={rev.isPending}
                onClick={() => { const r = prompt('შემობრუნების მიზეზი (მარაგი დაბრუნდება, ინვოისის ხაზი მოიხსნება)'); if (r && r.trim().length >= 3) rev.mutate({ id: d.id, reason: r.trim() }); }}>შემობრუნება</button>}</td>
            </tr>))}
            {!q.data?.length && <tr><td colSpan={8} className="muted">ჩანაწერი არ არის</td></tr>}
          </tbody>
        </table>)}
      <ErrorBox error={q.error ?? rev.error} />
    </section>
  );
}
