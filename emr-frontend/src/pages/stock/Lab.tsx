import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, can } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Loading, Modal, useToast } from '../../components/ui';
import { dateGe, todayISO, tsDate } from '../../lib/format';
import { downloadCsv, money2, qtyFmt, type LabCostRow, type LabKit, type LabMethod, type LabStockRow, type StockLocation } from './types';

/** ლაბორატორია ↔ საწყობი (7A): ნაკრების / ფლაკონის გახსნა, on-board ვადა, გამოყენებაში მყოფი, ტესტის თვითღირებულება */
export default function Lab() {
  const { user } = useAuth();
  const mine = useQuery({ queryKey: ['stock-my-locations'], queryFn: () => api<StockLocation[]>('/stock/my-locations') });
  const labs = (mine.data ?? []).filter((l) => l.kind === 'lab');
  const [loc, setLoc] = useState('');
  const cur = loc || labs[0]?.id || '';
  const [tab, setTab] = useState<'kits' | 'open' | 'history' | 'cost'>('kits');
  const canCost = can(user, 'admin', 'lab_doctor', 'lab_manager', 'stock_manager', 'manager', 'viewer', 'accountant');
  return (
    <div className="content">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        {labs.length > 1 && <select className="select" style={{ maxWidth: 280, height: 38 }} aria-label="ლაბორატორია" value={cur} onChange={(e) => setLoc(e.target.value)}>
          {labs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>}
        <div className="seg" role="group" aria-label="განყოფილება">
          <button type="button" aria-pressed={tab === 'kits'} onClick={() => setTab('kits')}>გამოყენებაში</button>
          <button type="button" aria-pressed={tab === 'open'} onClick={() => setTab('open')}>გახსნა</button>
          <button type="button" aria-pressed={tab === 'history'} onClick={() => setTab('history')}>ისტორია</button>
          {canCost && <button type="button" aria-pressed={tab === 'cost'} onClick={() => setTab('cost')}>ტესტის თვითღირებულება</button>}
        </div>
        <span className="hint grow">გახსნისას ნაკრები ჩამოიწერება ლაბორატორიის ნაშთიდან (ლაბ. ხარჯი). on-board ვადა = გახსნა + სტაბილურობა, მაგრამ არა ლოტის ვადაზე გვიან.</span>
      </div>
      {tab === 'cost' ? <Cost /> : mine.isLoading ? <Loading /> : !cur ? <div className="card empty">ლაბორატორიის ქვესაწყობი არ გაქვთ (ლოკაციები → ტიპი „ლაბორატორია“).</div>
        : tab === 'open' ? <OpenList loc={cur} onOpened={() => setTab('kits')} /> : <Kits loc={cur} status={tab === 'kits' ? 'in_use' : 'finished,discarded'} />}
    </div>
  );
}

function Kits({ loc, status }: { loc: string; status: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['lab-kits', loc, status], queryFn: () => api<LabKit[]>('/stock/lab/kits', { query: { location_id: loc, status } }) });
  const close = useMutation({ mutationFn: (a: { id: string; discarded: boolean; reason?: string }) => api(`/stock/lab/kits/${a.id}/close`, { body: { discarded: a.discarded, reason: a.reason } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['lab-kits'] }) });
  const active = status === 'in_use';
  if (q.isLoading) return <Loading />;
  return (
    <div className="card" style={{ overflowX: 'auto' }}>
      <table className="table">
        <thead><tr><th>რეაგენტი / მასალა</th><th>ლოტი</th><th>ანალიზატორი</th><th>გაიხსნა</th><th>on-board ვადა</th><th className="num">ტესტები</th><th className="num">ღირებულება</th>{active ? <th /> : <th>დაიხურა</th>}</tr></thead>
        <tbody>{q.data?.map((k) => {
          const exp = k.days_left !== null && k.days_left < 0; const soon = k.days_left !== null && k.days_left <= 1;
          return (
            <tr key={k.id}>
              <td><strong>{k.item_name}</strong>{Number(k.qty_base) !== 1 && <span className="small muted"> × {qtyFmt(k.qty_base)}</span>}{k.notes && <div className="small muted">{k.notes}</div>}</td>
              <td className="mono small">{k.lot_no ?? '—'}<div className="muted">{k.expires_on ? dateGe(k.expires_on) : ''}</div></td>
              <td className="small">{k.method_name ?? '—'}{k.analyte_name && <div className="muted">{k.analyte_name}</div>}</td>
              <td className="small">{tsDate(k.opened_at)}<div className="muted">{k.opened_by_name}</div></td>
              <td>{k.onboard_expires_on ? <span className={`chip ${active && exp ? 'danger' : active && soon ? 'warn' : ''}`}>{dateGe(k.onboard_expires_on)}{active && k.days_left !== null ? (exp ? ' · გასულია' : ` · ${k.days_left} დღე`) : ''}</span> : '—'}</td>
              <td className="num">{k.tests_done ?? '—'}{k.tests_planned ? <span className="muted"> / {k.tests_planned}</span> : ''}</td>
              <td className="num mono">{Number(k.cost).toFixed(2)}</td>
              {active ? <td style={{ whiteSpace: 'nowrap' }}>
                <button className="btn sm" type="button" disabled={close.isPending} onClick={() => { if (confirm('დასრულდა (გამოყენებულია)?')) close.mutate({ id: k.id, discarded: false }); }}>დასრულდა</button>{' '}
                <button className="btn sm" type="button" disabled={close.isPending} onClick={() => { const r = prompt('გადაყრის მიზეზი (მაგ. on-board ვადა, დაბინძურება)'); if (r && r.trim().length >= 3) close.mutate({ id: k.id, discarded: true, reason: r.trim() }); }}>გადაყრა</button></td>
                : <td className="small">{k.status === 'discarded' ? <span className="chip warn">გადაიყარა</span> : <span className="chip ok">დასრულდა</span>}<div className="muted">{k.closed_at ? tsDate(k.closed_at) : ''}{k.close_reason ? ` · ${k.close_reason}` : ''}</div></td>}
            </tr>);
        })}
          {!q.data?.length && <tr><td colSpan={8} className="muted">{active ? 'გახსნილი ნაკრები არ არის' : 'ისტორია ცარიელია'}</td></tr>}
        </tbody>
      </table>
      <ErrorBox error={q.error ?? close.error} />
    </div>
  );
}

function OpenList({ loc, onOpened }: { loc: string; onOpened: () => void }) {
  const q = useQuery({ queryKey: ['lab-stock', loc], queryFn: () => api<LabStockRow[]>('/stock/lab/stock', { query: { location_id: loc } }) });
  const [open, setOpen] = useState<LabStockRow | null>(null);
  if (q.isLoading) return <Loading />;
  return (
    <div className="card">
      <table className="table">
        <thead><tr><th>საქონელი</th><th>ლოტი / ვადა</th><th className="num">ნაშთი</th><th>ანალიზატორი</th><th className="num">on-board</th><th /></tr></thead>
        <tbody>{q.data?.map((r) => (
          <tr key={r.lot_id} style={r.usable ? undefined : { opacity: 0.55 }}>
            <td><strong>{r.item_name}</strong> <span className="mono small muted">{r.item_code}</span></td>
            <td className="mono small">{r.lot_no ?? '—'} · {r.expires_on ? dateGe(r.expires_on) : '—'}{!r.usable && <span className="chip danger" style={{ marginLeft: 6 }}>{r.status !== 'active' ? 'დაბლოკილი' : 'ვადაგასული'}</span>}</td>
            <td className="num">{qtyFmt(r.qty)} {r.base_unit_name}</td><td className="small">{r.method_name ?? '—'}{r.analyte_name && <div className="muted">{r.analyte_name}</div>}</td>
            <td className="num">{r.lab_onboard_days ? `${r.lab_onboard_days} დღე` : '—'}</td>
            <td>{r.usable && <button className="btn sm primary" type="button" onClick={() => setOpen(r)}>გახსნა</button>}</td>
          </tr>))}
          {!q.data?.length && <tr><td colSpan={6} className="muted">ლაბორატორიაში ნაშთი არ არის — მოითხოვეთ საწყობიდან (მოთხოვნები)</td></tr>}
        </tbody>
      </table>
      <ErrorBox error={q.error} />
      {open && <OpenDialog row={open} loc={loc} onClose={() => setOpen(null)} onDone={() => { setOpen(null); onOpened(); }} />}
    </div>
  );
}

function OpenDialog({ row, loc, onClose, onDone }: { row: LabStockRow; loc: string; onClose: () => void; onDone: () => void }) {
  const qc = useQueryClient(); const toast = useToast();
  const methods = useQuery({ queryKey: ['lab-methods-stock'], queryFn: () => api<LabMethod[]>('/lab/methods').catch(() => [] as LabMethod[]) });
  const [f, setF] = useState({ qty: '1', method_id: row.lab_method_id ?? '', onboard: row.lab_onboard_days ? String(row.lab_onboard_days) : '', notes: '' });
  const m = useMutation({
    mutationFn: () => api<LabKit>('/stock/lab/kits', { body: { location_id: loc, lot_id: row.lot_id, qty_base: Number(f.qty.replace(',', '.')), method_id: f.method_id || null,
      onboard_days: f.onboard.trim() ? Number(f.onboard) : null, notes: f.notes.trim() || null } }),
    onSuccess: (k) => { toast.show(`გაიხსნა · ${k.doc_no}`); for (const x of ['lab-kits', 'lab-stock', 'stock-balances']) void qc.invalidateQueries({ queryKey: [x] }); onDone(); },
  });
  return (
    <Modal title={`გახსნა: ${row.item_name} · ${row.lot_no ?? ''}`} onClose={onClose} width={600}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={m.isPending || !(Number(f.qty) > 0)} onClick={() => m.mutate()}>გახსნა და ჩამოწერა</button></>}>
      {toast.node}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div className="field"><label htmlFor="oq">რაოდენობა ({row.base_unit_name})</label><input id="oq" className="input mono" inputMode="decimal" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} /></div>
        <div className="field"><label htmlFor="oo">on-board სტაბილურობა (დღე)</label><input id="oo" className="input mono" inputMode="numeric" value={f.onboard} placeholder="ცარიელი — ლოტის ვადა" onChange={(e) => setF({ ...f, onboard: e.target.value })} /></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label htmlFor="om">ანალიზატორი</label>
          <select id="om" className="select" value={f.method_id} onChange={(e) => setF({ ...f, method_id: e.target.value })}>
            <option value="">— (ტესტების დათვლის გარეშე) —</option>{methods.data?.filter((x) => x.is_active).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label htmlFor="on">შენიშვნა</label><input id="on" className="input" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="მაგ. რეაგენტის პოზიცია R1-3" /></div>
      </div>
      <ErrorBox error={m.error} />
    </Modal>
  );
}

function Cost() {
  const [f, setF] = useState({ from: `${todayISO().slice(0, 8)}01`, to: todayISO() });
  const q = useQuery({ queryKey: ['lab-cost', f], queryFn: () => api<{ rows: LabCostRow[]; total_cost: number }>('/stock/lab/cost', { query: f }) });
  const d = q.data;
  return (
    <section className="card">
      <div className="card-head row" style={{ flexWrap: 'wrap' }}>
        <input className="input mono" type="date" style={{ maxWidth: 160, height: 36 }} aria-label="დან" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        <input className="input mono" type="date" style={{ maxWidth: 160, height: 36 }} aria-label="მდე" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
        <span className="hint grow">გახსნილი ნაკრებების ღირებულება ÷ შესრულებული ტესტები (პაციენტი + QC) ამავე ანალიზატორზე / ანალიტზე. ეფექტიანობა = შესრულებული ÷ ნომინალი.</span>
        {d && <button className="btn sm" type="button" onClick={() => downloadCsv(`ტესტის-ღირებულება-${f.from}-${f.to}.csv`, ['ანალიზატორი', 'ანალიტი', 'ნაკრები', 'ღირებულება', 'პაციენტის ტესტი', 'QC', '₾ / ტესტი', '₾ / პაციენტის ტესტი', 'ნომინალი', 'ეფექტიანობა %'],
          d.rows.map((r) => [r.method_name ?? '—', r.analyte_name ?? 'ყველა', r.kits, r.cost, r.patient_tests, r.qc_tests, r.cost_per_test, r.cost_per_patient_test, r.planned, r.efficiency]))}>CSV</button>}
      </div>
      {q.isLoading ? <Loading /> : (
        <table className="table">
          <thead><tr><th>ანალიზატორი</th><th>ანალიტი</th><th className="num">ნაკრები</th><th className="num">ღირებულება</th><th className="num">პაციენტი</th><th className="num">QC</th><th className="num">₾ / ტესტი</th><th className="num">₾ / პაც. ტესტი</th><th className="num">ეფექტიანობა</th></tr></thead>
          <tbody>{d?.rows.map((r, i) => (
            <tr key={i}><td>{r.method_name ?? <span className="muted">ანალიზატორის გარეშე</span>}</td><td className="small">{r.analyte_name ?? 'ყველა'}</td><td className="num">{r.kits}</td><td className="num mono">{r.cost.toFixed(2)}</td>
              <td className="num">{r.patient_tests}</td><td className="num">{r.qc_tests}</td><td className="num mono">{r.cost_per_test?.toFixed(2) ?? '—'}</td><td className="num mono">{r.cost_per_patient_test?.toFixed(2) ?? '—'}</td>
              <td className="num">{r.efficiency !== null ? <span className={`chip ${r.efficiency < 60 ? 'warn' : 'ok'}`}>{r.efficiency}%</span> : '—'}</td></tr>))}
            {d && <tr><td colSpan={3}><strong>სულ</strong></td><td className="num mono"><strong>{money2(d.total_cost)}</strong></td><td colSpan={5} /></tr>}
            {d && !d.rows.length && <tr><td colSpan={9} className="muted">პერიოდში ნაკრები არ გახსნილა</td></tr>}
          </tbody>
        </table>)}
      <ErrorBox error={q.error} />
    </section>
  );
}
