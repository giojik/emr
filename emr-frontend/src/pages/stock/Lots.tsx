import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, can } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Loading, Modal, useDebounced } from '../../components/ui';
import { dateGe, tsDate } from '../../lib/format';
import { CONTROLLED_KA, DOC_TYPE_KA, downloadCsv, LOT_STATUS_KA, qtyFmt, type LotRow, type LotStatus, type LotTrace } from './types';

/** ლოტები: ქარანტინი / გაწვევა (recall) და მიკვლევა — სად არის ნაშთი, რომელ პაციენტებს მოხმარდა */
export default function Lots() {
  const [sp, setSp] = useSearchParams();
  const id = sp.get('lot');
  const [search, setSearch] = useState(''); const ds = useDebounced(search.trim(), 300);
  const q = useQuery({ queryKey: ['stock-lots', ds], queryFn: () => api<LotRow[]>('/stock/lots', { query: { search: ds || undefined, status: ds ? undefined : 'blocked' } }) });
  return (
    <div className="content">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <input className="input" style={{ maxWidth: 360, height: 38 }} aria-label="ძებნა" placeholder="ლოტის / სერიული №, დასახელება, INN" value={search} onChange={(e) => setSearch(e.target.value)} />
        <span className="hint grow">{ds ? 'ძებნის შედეგი' : 'დაბლოკილი ლოტები (ქარანტინი / გაწვეული). გაწვევის შეტყობინებისას მოძებნეთ ლოტის ნომრით.'}</span>
      </div>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : (
        <div className="card">
          <table className="table">
            <thead><tr><th>საქონელი</th><th>ლოტი / სერიული</th><th>ვადა</th><th className="num">ნაშთი</th><th className="num">პაციენტი</th><th>სტატუსი</th></tr></thead>
            <tbody>{q.data?.map((l) => (
              <tr key={l.id} className="clickable" onClick={() => setSp({ lot: l.id })}>
                <td><strong>{l.item_name}</strong> <span className="mono small muted">{l.item_code}</span>{l.inn && <div className="small muted">{l.inn}</div>}</td>
                <td className="mono">{l.lot_no ?? '—'}{l.serial_no && ` · SN ${l.serial_no}`}</td><td className="mono small">{l.expires_on ? dateGe(l.expires_on) : '—'}</td>
                <td className="num">{qtyFmt(l.qty)}</td><td className="num">{l.patients}</td>
                <td><span className={`chip ${LOT_STATUS_KA[l.status][0]}`}>{LOT_STATUS_KA[l.status][1]}</span>{l.status_reason && <div className="small muted">{l.status_reason}</div>}</td>
              </tr>))}
              {!q.data?.length && <tr><td colSpan={6} className="muted">{ds ? 'ვერ მოიძებნა' : 'დაბლოკილი ლოტი არ არის'}</td></tr>}
            </tbody>
          </table>
        </div>)}
      {id && <LotDialog id={id} onClose={() => setSp({})} />}
    </div>
  );
}

export function LotDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { user } = useAuth(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['stock-lot', id], queryFn: () => api<LotTrace>(`/stock/lots/${id}/trace`) });
  const [to, setTo] = useState<LotStatus | null>(null); const [f, setF] = useState({ reason: '', reference: '' });
  const m = useMutation({
    mutationFn: () => api<LotTrace>(`/stock/lots/${id}/status`, { body: { status: to, reason: f.reason.trim(), reference: f.reference.trim() || null } }),
    onSuccess: (r) => { qc.setQueryData(['stock-lot', id], r); for (const k of ['stock-lots', 'stock-balances']) void qc.invalidateQueries({ queryKey: [k] }); setTo(null); setF({ reason: '', reference: '' }); },
  });
  const t = q.data; const lot = t?.lot;
  const canEdit = can(user, 'admin', 'stock_manager', 'pharmacist');
  return (
    <Modal title={lot ? `${lot.item_name} — ლოტი ${lot.lot_no ?? '—'}${lot.serial_no ? ` · SN ${lot.serial_no}` : ''}` : 'ლოტი'} onClose={onClose} width={980}
      footer={<>{canEdit && lot && !to && (['quarantine', 'recalled', 'active'] as LotStatus[]).filter((s) => s !== lot.status).map((s) =>
        <button key={s} className={`btn${s === 'recalled' ? ' danger' : ''}`} type="button" onClick={() => setTo(s)}>{s === 'active' ? 'აღდგენა (აქტიური)' : s === 'quarantine' ? 'ქარანტინი' : 'გაწვევა (recall)'}</button>)}
        {to && <><button className="btn" type="button" onClick={() => setTo(null)}>უკან</button>
          <button className="btn primary" type="button" disabled={m.isPending || f.reason.trim().length < 3} onClick={() => m.mutate()}>დადასტურება: {LOT_STATUS_KA[to][1]}</button></>}
        <button className="btn" type="button" onClick={onClose}>დახურვა</button></>}>
      {!t || !lot ? <Loading /> : (
        <div className="stack">
          <div className="row small" style={{ flexWrap: 'wrap', gap: 16 }}>
            <span className={`chip ${LOT_STATUS_KA[lot.status][0]}`}>{LOT_STATUS_KA[lot.status][1]}</span>
            <span>ვადა: <strong className="mono">{lot.expires_on ? dateGe(lot.expires_on) : '—'}</strong></span>
            <span>მიღებული: {qtyFmt(lot.received_qty)} {lot.base_unit_name}</span><span>მომწოდებელი: {lot.supplier_name ?? '—'}</span>
            {lot.controlled_class && <span className="chip danger">{CONTROLLED_KA[lot.controlled_class]}</span>}
            {lot.status_reason && <span className="chip warn">{lot.status_reason}</span>}
          </div>
          {to && (
            <div className="alert warn stack" style={{ gap: 8 }}>
              <strong>{to === 'recalled' ? 'გაწვევა: ლოტი დაიბლოკება ყველგან; პასუხისმგებლებს გაეგზავნებათ სასწრაფო შეტყობინება. ნაშთი დააბრუნეთ საწყობში და ჩამოწერეთ (მიზეზი „გაწვევა“).'
                : to === 'quarantine' ? 'ქარანტინი: გაცემა და ხარჯი დაიბლოკება გადაწყვეტილებამდე.' : 'აღდგენა: ლოტი ისევ გაიცემა / დაიხარჯება.'}</strong>
              <div className="row" style={{ flexWrap: 'wrap' }}>
                <input className="input grow" aria-label="მიზეზი" placeholder="მიზეზი (სავალდებულო)" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
                <input className="input" style={{ maxWidth: 260 }} aria-label="შეტყობინების №" placeholder="მწარმოებლის / სააგენტოს შეტყობინების №" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />
              </div>
            </div>)}
          <ErrorBox error={m.error} />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
            <section className="card">
              <div className="card-head"><h2>სად არის ნაშთი</h2></div>
              <table className="table"><tbody>{t.locations.map((l) => <tr key={l.id}><td>{l.name}{l.kind === 'transit' && <span className="chip warn" style={{ marginLeft: 6 }}>გზაში</span>}</td><td className="num"><strong>{qtyFmt(l.qty)}</strong> {lot.base_unit_name}</td></tr>)}
                {!t.locations.length && <tr><td className="muted">ნაშთი არსად არის</td></tr>}</tbody></table>
            </section>
            <section className="card">
              <div className="card-head row"><h2 className="grow">პაციენტები ({t.patients.length})</h2>
                {t.patients.length > 0 && <button className="btn sm" type="button" onClick={() => downloadCsv(`ლოტი-${lot.lot_no ?? id}-პაციენტები.csv`, ['პაციენტი', 'პირადი №', 'ტელეფონი', 'რაოდენობა', 'ბოლო', 'ლოკაცია'],
                  t.patients.map((p) => [p.patient_name, p.personal_number, p.phone_number, Number(p.qty), tsDate(p.last_at), p.locations]))}>CSV</button>}</div>
              <table className="table"><tbody>{t.patients.map((p) => <tr key={p.patient_id}><td><Link to={`/patients/${p.patient_id}`}>{p.patient_name}</Link> <span className="mono small muted">{p.personal_number}</span>
                <div className="small muted">{p.phone_number ?? ''} · {p.locations}</div></td><td className="num">{qtyFmt(p.qty)}</td><td className="small">{tsDate(p.last_at)}</td></tr>)}
                {!t.patients.length && <tr><td className="muted">პაციენტზე არ დახარჯულა</td></tr>}</tbody></table>
            </section>
          </div>
          {t.events.length > 0 && (
            <section className="card">
              <div className="card-head"><h2>სტატუსის ისტორია</h2></div>
              <table className="table"><tbody>{t.events.map((e) => <tr key={e.id}><td className="small">{tsDate(e.created_at)}</td>
                <td><span className={`chip ${LOT_STATUS_KA[e.to_status][0]}`}>{LOT_STATUS_KA[e.to_status][1]}</span></td><td className="small">{e.reason}{e.reference && <span className="mono"> · {e.reference}</span>}</td><td className="small">{e.user_name}</td></tr>)}</tbody></table>
            </section>)}
          <details>
            <summary className="small">მოძრაობები ({t.moves.length})</summary>
            <table className="table"><tbody>{t.moves.map((mv) => <tr key={mv.id}><td className="small">{tsDate(mv.created_at)}</td><td className="mono small">{mv.doc_no}</td><td className="small">{DOC_TYPE_KA[mv.doc_type] ?? mv.doc_type}</td>
              <td className="small">{mv.location_name}</td><td className="num mono" style={{ color: Number(mv.qty) < 0 ? 'var(--danger-ink)' : 'var(--ok-ink)' }}>{Number(mv.qty) > 0 ? '+' : ''}{qtyFmt(mv.qty)}</td></tr>)}</tbody></table>
          </details>
          <ErrorBox error={q.error} />
        </div>)}
    </Modal>
  );
}
