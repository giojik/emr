import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, can } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Loading, Modal, useToast } from '../../components/ui';
import { dateGe, todayISO, tsDate } from '../../lib/format';
import WitnessFields from './Witness';
import { CONTROLLED_KA, DOC_TYPE_KA, downloadCsv, qtyFmt, WO_REASON_KA, type Controlled, type StockLocation, type Witness } from './types';

interface Summary { rows: { location_id: string; location_name: string; item_id: string; item_name: string; item_code: string; controlled_class: Controlled; base_unit_name: string; qty: string; last_shift: string | null }[]; empties_pending: number }
interface RegRow {
  id: string; created_at: string; move_type: string; qty: string; doc_no: string | null; doc_type: string; writeoff_reason: string | null; reason: string | null; reversal_of_no: string | null;
  lot_no: string | null; serial_no: string | null; dose_given: string | null; dose_wasted: string | null; dose_unit: string | null; user_name: string; witness_name: string | null; party: string | null;
  in: number; out: number; balance: number;
}
interface Register { location: { id: string; name: string }; from: string; to: string; items: { item: { id: string; name: string; code: string; inn: string; strength: string | null; controlled_class: Controlled; base_unit_name: string }; opening: number; closing: number; rows: RegRow[] }[] }
interface Empty { id: string; qty_base: string; lot_no: string | null; dose_given: string | null; dose_wasted: string | null; dose_unit: string | null; doc_no: string; posted_at: string; location_name: string; item_name: string; base_unit_name: string; patient_name: string | null; user_name: string }
interface ShiftRow { id: string; shift_no: string; status: 'ok' | 'discrepancy'; notes: string | null; created_at: string; location_name: string; handed_by_name: string; received_by_name: string; lines: number }
interface Shift extends Omit<ShiftRow, 'lines'> { lines: { id: string; expected_qty: string; counted_qty: string; item_name: string; lot_no: string | null; serial_no: string | null }[] }
interface TplRow { lot_id: string; item_id: string; expected_qty: string; lot_no: string | null; serial_no: string | null; expires_on: string | null; item_name: string; base_unit_name: string; controlled_class: Controlled }

const MOVE_KA: Record<string, string> = { receipt: 'მიღება', transfer: 'გადაადგილება', issue: 'გაცემა', return: 'დაბრუნება', writeoff: 'ჩამოწერა', adjustment: 'კორექტირება', consumption: 'პაციენტზე' };

/** ნარკოტიკული და ფსიქოტროპული: ნაშთი, ჟურნალი (ბეჭდვა / CSV), ცარიელი ამპულები, ცვლის ჩაბარება */
export default function ControlledPage() {
  const [sp] = useSearchParams();
  const [tab, setTab] = useState<'summary' | 'register' | 'empties' | 'shift'>(sp.get('shift') ? 'shift' : 'summary');
  return (
    <div className="content">
      <div className="seg" role="group" aria-label="განყოფილება" style={{ alignSelf: 'flex-start' }}>
        <button type="button" aria-pressed={tab === 'summary'} onClick={() => setTab('summary')}>ნაშთი</button>
        <button type="button" aria-pressed={tab === 'register'} onClick={() => setTab('register')}>ჟურნალი</button>
        <button type="button" aria-pressed={tab === 'empties'} onClick={() => setTab('empties')}>ცარიელი ამპულები</button>
        <button type="button" aria-pressed={tab === 'shift'} onClick={() => setTab('shift')}>ცვლის ჩაბარება</button>
      </div>
      {tab === 'summary' ? <SummaryView /> : tab === 'register' ? <RegisterView /> : tab === 'empties' ? <Empties /> : <ShiftView openId={sp.get('shift')} />}
    </div>
  );
}

function SummaryView() {
  const q = useQuery({ queryKey: ['ctl-summary'], queryFn: () => api<Summary>('/stock/controlled/summary') });
  if (q.isLoading) return <Loading />;
  return (
    <section className="card">
      <div className="card-head row"><h2 className="grow">კონტროლირებადი ნაშთი ლოკაციებზე</h2>{q.data && q.data.empties_pending > 0 && <span className="chip warn">დაუბრუნებელი ცარიელი: {q.data.empties_pending}</span>}</div>
      <table className="table">
        <thead><tr><th>ლოკაცია</th><th>საქონელი</th><th>კლასი</th><th className="num">ნაშთი</th><th>ბოლო ცვლის ჩაბარება</th></tr></thead>
        <tbody>{q.data?.rows.map((r) => <tr key={`${r.location_id}-${r.item_id}`}><td>{r.location_name}</td><td><strong>{r.item_name}</strong> <span className="mono small muted">{r.item_code}</span></td>
          <td><span className="chip danger">{CONTROLLED_KA[r.controlled_class]}</span></td><td className="num"><strong>{qtyFmt(r.qty)}</strong> {r.base_unit_name}</td><td className="small">{r.last_shift ? tsDate(r.last_shift) : '—'}</td></tr>)}
          {!q.data?.rows.length && <tr><td colSpan={5} className="muted">ნაშთი არ არის</td></tr>}</tbody>
      </table>
      <ErrorBox error={q.error} />
    </section>
  );
}

function RegisterView() {
  const locs = useQuery({ queryKey: ['stock-locations', false], queryFn: () => api<StockLocation[]>('/stock/locations') });
  const [f, setF] = useState({ location_id: '', from: `${todayISO().slice(0, 8)}01`, to: todayISO() });
  const q = useQuery({ queryKey: ['ctl-register', f], queryFn: () => api<Register>('/stock/controlled/register', { query: f }), enabled: !!f.location_id });
  const d = q.data;
  const print = () => {
    if (!d) return;
    const esc = (s: unknown) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
    const html = `<!doctype html><html lang="ka"><head><meta charset="utf-8"><title>ჟურნალი — ${esc(d.location.name)}</title>
<style>body{font:12px system-ui,sans-serif;margin:16px}h1{font-size:16px}h2{font-size:14px;margin:18px 0 4px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #999;padding:3px 5px;text-align:left}td.n{text-align:right}.sig{margin-top:24px}</style></head><body>
<h1>ნარკოტიკული და ფსიქოტროპული საშუალებების აღრიცხვის ჟურნალი</h1><div>ლოკაცია: <b>${esc(d.location.name)}</b> · პერიოდი: ${dateGe(d.from)} — ${dateGe(d.to)} · ამობეჭდილია: ${tsDate(new Date().toISOString())}</div>
${d.items.map((it) => `<h2>${esc(it.item.name)} (${esc(it.item.inn)}${it.item.strength ? ` ${esc(it.item.strength)}` : ''}) — ${esc(CONTROLLED_KA[it.item.controlled_class])}, ${esc(it.item.base_unit_name)}</h2>
<table><tr><th>თარიღი</th><th>დოკუმენტი</th><th>ოპერაცია</th><th>ვისგან / ვის</th><th>ლოტი</th><th>შემოსავალი</th><th>გასავალი</th><th>ნაშთი</th><th>დოზა / ნარჩენი</th><th>შეასრულა</th><th>მოწმე</th></tr>
<tr><td colspan="7">საწყისი ნაშთი</td><td class="n">${it.opening}</td><td colspan="3"></td></tr>
${it.rows.map((r) => `<tr><td>${tsDate(r.created_at)}</td><td>${esc(r.doc_no)}</td><td>${esc(MOVE_KA[r.move_type] ?? r.move_type)}${r.reversal_of_no ? ` (შემობრ. ${esc(r.reversal_of_no)})` : ''}${r.writeoff_reason ? ` — ${esc(WO_REASON_KA[r.writeoff_reason])}` : ''}</td><td>${esc(r.party)}</td><td>${esc(r.lot_no)}</td>
<td class="n">${r.in || ''}</td><td class="n">${r.out || ''}</td><td class="n">${r.balance}</td><td>${r.dose_given !== null ? `${Number(r.dose_given)} / ${Number(r.dose_wasted ?? 0)} ${esc(r.dose_unit)}` : ''}</td><td>${esc(r.user_name)}</td><td>${esc(r.witness_name)}</td></tr>`).join('')}
<tr><td colspan="7"><b>საბოლოო ნაშთი</b></td><td class="n"><b>${it.closing}</b></td><td colspan="3"></td></tr></table>`).join('')}
<div class="sig">პასუხისმგებელი პირი: ______________________ &nbsp;&nbsp; ხელმოწერა: ____________ &nbsp;&nbsp; თარიღი: ____________</div></body></html>`;
    const w = window.open('', '_blank'); if (!w) return; w.document.write(html); w.document.close(); w.focus(); setTimeout(() => w.print(), 300);
  };
  return (
    <section className="card">
      <div className="card-head row" style={{ flexWrap: 'wrap' }}>
        <select className="select" style={{ maxWidth: 280, height: 36 }} aria-label="ლოკაცია" value={f.location_id} onChange={(e) => setF({ ...f, location_id: e.target.value })}>
          <option value="">— ლოკაცია —</option>{locs.data?.filter((l) => l.kind !== 'transit').map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
        <input className="input mono" type="date" style={{ maxWidth: 160, height: 36 }} aria-label="დან" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        <input className="input mono" type="date" style={{ maxWidth: 160, height: 36 }} aria-label="მდე" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
        <span className="grow" />
        {d && d.items.length > 0 && <>
          <button className="btn sm" type="button" onClick={() => downloadCsv(`ჟურნალი-${d.location.name}-${d.from}-${d.to}.csv`, ['საქონელი', 'თარიღი', 'დოკუმენტი', 'ოპერაცია', 'ვისგან / ვის', 'ლოტი', 'შემოსავალი', 'გასავალი', 'ნაშთი', 'მიღებული დოზა', 'ნარჩენი', 'ერთეული', 'შეასრულა', 'მოწმე'],
            d.items.flatMap((it) => it.rows.map((r) => [it.item.name, tsDate(r.created_at), r.doc_no, MOVE_KA[r.move_type] ?? r.move_type, r.party, r.lot_no, r.in, r.out, r.balance, r.dose_given, r.dose_wasted, r.dose_unit, r.user_name, r.witness_name])))}>CSV</button>
          <button className="btn sm primary" type="button" onClick={print}>ბეჭდვა</button></>}
      </div>
      {!f.location_id ? <div className="muted" style={{ padding: 16 }}>აირჩიეთ ლოკაცია</div> : q.isLoading ? <Loading /> : (
        <div className="stack" style={{ padding: 12 }}>
          {d?.items.map((it) => (
            <div key={it.item.id} className="stack" style={{ gap: 4 }}>
              <strong>{it.item.name} <span className="small muted">{it.item.inn}{it.item.strength ? ` ${it.item.strength}` : ''} · {CONTROLLED_KA[it.item.controlled_class]}</span></strong>
              <div style={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead><tr><th>დრო</th><th>დოკუმენტი</th><th>ოპერაცია</th><th>ვისგან / ვის</th><th>ლოტი</th><th className="num">+</th><th className="num">−</th><th className="num">ნაშთი</th><th>დოზა / ნარჩენი</th><th>შეასრულა / მოწმე</th></tr></thead>
                  <tbody>
                    <tr><td colSpan={7} className="muted">საწყისი ნაშთი</td><td className="num mono">{it.opening}</td><td colSpan={2} /></tr>
                    {it.rows.map((r) => (
                      <tr key={r.id}><td className="small">{tsDate(r.created_at)}</td><td className="mono small">{r.doc_no}</td>
                        <td className="small">{MOVE_KA[r.move_type] ?? DOC_TYPE_KA[r.doc_type]}{r.reversal_of_no && <span className="muted"> (შემობრ. {r.reversal_of_no})</span>}{r.writeoff_reason && <span className="muted"> — {WO_REASON_KA[r.writeoff_reason]}</span>}</td>
                        <td className="small">{r.party ?? '—'}</td><td className="mono small">{r.lot_no ?? '—'}</td>
                        <td className="num mono">{r.in || ''}</td><td className="num mono">{r.out || ''}</td><td className="num mono"><strong>{r.balance}</strong></td>
                        <td className="small">{r.dose_given !== null ? `${Number(r.dose_given)} / ${Number(r.dose_wasted ?? 0)} ${r.dose_unit ?? ''}` : ''}</td>
                        <td className="small">{r.user_name}{r.witness_name && <div className="muted">მოწმე: {r.witness_name}</div>}</td></tr>))}
                    <tr><td colSpan={7}><strong>საბოლოო ნაშთი</strong></td><td className="num mono"><strong>{it.closing}</strong></td><td colSpan={2} /></tr>
                  </tbody>
                </table>
              </div>
            </div>))}
          {d && !d.items.length && <span className="muted">ამ ლოკაციაზე კონტროლირებადი საშუალება არ მოძრაობდა</span>}
        </div>)}
      <ErrorBox error={q.error} />
    </section>
  );
}

function Empties() {
  const { user } = useAuth(); const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['ctl-empties'], queryFn: () => api<Empty[]>('/stock/controlled/empties') });
  const [sel, setSel] = useState<string[]>([]);
  const m = useMutation({ mutationFn: () => api<{ confirmed: number }>('/stock/controlled/empties/confirm', { body: { line_ids: sel } }),
    onSuccess: (r) => { toast.show(`მიღებულია: ${r.confirmed}`); setSel([]); void qc.invalidateQueries({ queryKey: ['ctl-empties'] }); void qc.invalidateQueries({ queryKey: ['ctl-summary'] }); } });
  const canConfirm = can(user, 'admin', 'pharmacist', 'storekeeper', 'stock_manager');
  return (
    <section className="card">
      {toast.node}
      <div className="card-head row"><h2 className="grow">დაუბრუნებელი ცარიელი ამპულები (ნარკოტიკული)</h2>
        {canConfirm && <button className="btn primary sm" type="button" disabled={!sel.length || m.isPending} onClick={() => m.mutate()}>მიღება აფთიაქში ({sel.length})</button>}</div>
      {q.isLoading ? <Loading /> : (
        <table className="table">
          <thead><tr>{canConfirm && <th />}<th>ხარჯი</th><th>ლოკაცია</th><th>საქონელი</th><th>პაციენტი</th><th className="num">რაოდ.</th><th>დოზა / ნარჩენი</th><th>შეასრულა</th></tr></thead>
          <tbody>{q.data?.map((e) => (
            <tr key={e.id}>{canConfirm && <td><input type="checkbox" aria-label="მონიშვნა" checked={sel.includes(e.id)} onChange={(x) => setSel(x.target.checked ? [...sel, e.id] : sel.filter((y) => y !== e.id))} /></td>}
              <td className="small"><span className="mono">{e.doc_no}</span><div className="muted">{tsDate(e.posted_at)}</div></td><td className="small">{e.location_name}</td><td>{e.item_name} <span className="mono small muted">{e.lot_no}</span></td>
              <td className="small">{e.patient_name}</td><td className="num">{qtyFmt(e.qty_base)} {e.base_unit_name}</td>
              <td className="small">{e.dose_given !== null ? `${Number(e.dose_given)} / ${Number(e.dose_wasted ?? 0)} ${e.dose_unit ?? ''}` : ''}</td><td className="small">{e.user_name}</td></tr>))}
            {!q.data?.length && <tr><td colSpan={8} className="muted">ყველა ცარიელი დაბრუნებულია</td></tr>}</tbody>
        </table>)}
      <ErrorBox error={q.error ?? m.error} />
    </section>
  );
}

function ShiftView({ openId }: { openId: string | null }) {
  const qc = useQueryClient(); const toast = useToast();
  const mine = useQuery({ queryKey: ['stock-my-locations'], queryFn: () => api<StockLocation[]>('/stock/my-locations') });
  const [loc, setLoc] = useState('');
  const tpl = useQuery({ queryKey: ['ctl-shift-tpl', loc], queryFn: () => api<TplRow[]>('/stock/controlled/shift/template', { query: { location_id: loc } }), enabled: !!loc });
  const hist = useQuery({ queryKey: ['ctl-shifts', loc], queryFn: () => api<ShiftRow[]>('/stock/controlled/shifts', { query: { location_id: loc || undefined } }) });
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [wit, setWit] = useState<Witness>({ username: '', password: '' }); const [notes, setNotes] = useState('');
  const [open, setOpen] = useState<string | null>(openId);
  const m = useMutation({
    mutationFn: () => api<Shift>('/stock/controlled/shift', { body: { location_id: loc, notes: notes || null, witness: wit, lines: (tpl.data ?? []).map((t) => ({ lot_id: t.lot_id, counted_qty: Number((counts[t.lot_id] ?? '').replace(',', '.')) })) } }),
    onSuccess: (r) => { toast.show(r.status === 'ok' ? `ჩაბარდა: ${r.shift_no}` : `სხვაობა! ${r.shift_no} — ეცნობა საწყობს`); setCounts({}); setWit({ username: '', password: '' }); setNotes('');
      for (const k of ['ctl-shifts', 'ctl-summary', 'ctl-shift-tpl']) void qc.invalidateQueries({ queryKey: [k] }); setOpen(r.id); },
  });
  const t = tpl.data ?? [];
  const valid = loc && t.length && t.every((x) => (counts[x.lot_id] ?? '').trim() !== '') && wit.username.trim() && wit.password;
  return (
    <>
      {toast.node}
      <section className="card card-pad stack">
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <select className="select" style={{ maxWidth: 300, height: 38 }} aria-label="ლოკაცია" value={loc} onChange={(e) => { setLoc(e.target.value); setCounts({}); }}>
            <option value="">— ლოკაცია —</option>{mine.data?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
          <span className="hint grow">აბარებს შესული მომხმარებელი, იბარებს მეორე (საკუთარი პაროლით). დაითვალეთ ყველა ლოტი; სხვაობისას — სასწრაფო შეტყობინება საწყობის მენეჯერს და ფარმაცევტს.</span>
        </div>
        {loc && (tpl.isLoading ? <Loading /> : (
          <>
            <table className="table">
              <thead><tr><th>საქონელი</th><th>ლოტი</th><th>ვადა</th><th className="num">სისტემაში</th><th className="num">დათვლილი</th></tr></thead>
              <tbody>{t.map((x) => {
                const v = counts[x.lot_id] ?? ''; const diff = v.trim() !== '' && Number(v.replace(',', '.')) !== Number(x.expected_qty);
                return (
                  <tr key={x.lot_id} style={diff ? { background: 'var(--danger-weak)' } : undefined}><td><strong>{x.item_name}</strong> <span className="chip danger" style={{ height: 20, fontSize: 11 }}>{CONTROLLED_KA[x.controlled_class]}</span></td>
                    <td className="mono small">{x.lot_no ?? '—'}{x.serial_no && ` · SN ${x.serial_no}`}</td><td className="mono small">{x.expires_on ? dateGe(x.expires_on) : '—'}</td>
                    <td className="num">{qtyFmt(x.expected_qty)} {x.base_unit_name}</td>
                    <td className="num"><input className="input mono num" style={{ height: 32, width: 90 }} aria-label={`დათვლილი: ${x.item_name}`} inputMode="decimal" value={v} onChange={(e) => setCounts({ ...counts, [x.lot_id]: e.target.value })} /></td></tr>);
              })}
                {!t.length && <tr><td colSpan={5} className="muted">ლოკაციაზე კონტროლირებადი ნაშთი არ არის</td></tr>}</tbody>
            </table>
            {t.length > 0 && <>
              <WitnessFields value={wit} onChange={setWit} note="ცვლის მიმღები" />
              <div className="row"><input className="input grow" aria-label="შენიშვნა" placeholder="შენიშვნა" value={notes} onChange={(e) => setNotes(e.target.value)} />
                <button className="btn primary" type="button" disabled={!valid || m.isPending} onClick={() => m.mutate()}>ცვლის ჩაბარება</button></div></>}
            <ErrorBox error={m.error ?? tpl.error} />
          </>))}
      </section>
      <section className="card">
        <div className="card-head"><h2>ისტორია</h2></div>
        <table className="table">
          <thead><tr><th>№</th><th>დრო</th><th>ლოკაცია</th><th>აბარებს</th><th>იბარებს</th><th className="num">ლოტი</th><th>შედეგი</th></tr></thead>
          <tbody>{hist.data?.map((h) => (
            <tr key={h.id} className="clickable" onClick={() => setOpen(h.id)}><td className="mono">{h.shift_no}</td><td className="small">{tsDate(h.created_at)}</td><td>{h.location_name}</td><td className="small">{h.handed_by_name}</td><td className="small">{h.received_by_name}</td>
              <td className="num">{h.lines}</td><td>{h.status === 'ok' ? <span className="chip ok">სწორია</span> : <span className="chip danger">სხვაობა</span>}</td></tr>))}
            {!hist.data?.length && <tr><td colSpan={7} className="muted">ჩანაწერი არ არის</td></tr>}</tbody>
        </table>
      </section>
      {open && <ShiftDialog id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function ShiftDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['ctl-shift', id], queryFn: () => api<Shift>(`/stock/controlled/shifts/${id}`) });
  const s = q.data;
  return (
    <Modal title={s ? `ცვლის ჩაბარება ${s.shift_no} — ${s.location_name}` : 'ცვლის ჩაბარება'} onClose={onClose} width={760}>
      {!s ? <Loading /> : (
        <div className="stack">
          <div className="row small" style={{ flexWrap: 'wrap', gap: 16 }}><span>{tsDate(s.created_at)}</span><span>აბარებს: <strong>{s.handed_by_name}</strong></span><span>იბარებს: <strong>{s.received_by_name}</strong></span>
            {s.status === 'ok' ? <span className="chip ok">სწორია</span> : <span className="chip danger">სხვაობა</span>}</div>
          {s.notes && <div className="small">{s.notes}</div>}
          <table className="table">
            <thead><tr><th>საქონელი</th><th>ლოტი</th><th className="num">სისტემაში</th><th className="num">დათვლილი</th></tr></thead>
            <tbody>{s.lines.map((l) => <tr key={l.id} style={Number(l.expected_qty) !== Number(l.counted_qty) ? { background: 'var(--danger-weak)' } : undefined}>
              <td>{l.item_name}</td><td className="mono small">{l.lot_no ?? '—'}</td><td className="num">{qtyFmt(l.expected_qty)}</td><td className="num"><strong>{qtyFmt(l.counted_qty)}</strong></td></tr>)}</tbody>
          </table>
        </div>)}
      <ErrorBox error={q.error} />
    </Modal>
  );
}
