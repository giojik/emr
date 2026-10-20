import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, openBlob } from '../../api/client';
import { ErrorBox, Field, Loading, Modal } from '../../components/ui';
import { tsDate } from '../../lib/format';
import { ISO_KA, ISO_TYPES, REASON_KA, usePatientIpc, type StayIsolations } from './types';

const hhmmTs = (v: string) => new Date(v).toLocaleTimeString('ka-GE', { timeZone: 'Asia/Tbilisi', hour: '2-digit', minute: '2-digit', hour12: false });

/** ჰოსპიტალიზაციის იზოლაცია (0067): აქტიური ეპიზოდები, დაყენება / მოხსნა, შეთავაზება MDRO ფლაგიდან, კარის ნიშანი, ისტორია */
export default function IsolationPanel({ encounterId, patientId }: { encounterId: string; patientId: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['ipc-stay', encounterId], queryFn: () => api<StayIsolations>(`/ipc/stays/${encounterId}/isolations`) });
  const st = usePatientIpc(patientId);
  const [dlg, setDlg] = useState<null | { type?: string; reason?: string; flag_id?: string }>(null);
  const [endId, setEndId] = useState<string | null>(null);
  const [hist, setHist] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [warn, setWarn] = useState<string[]>([]);
  const inval = () => { void qc.invalidateQueries({ queryKey: ['ipc-stay', encounterId] }); void qc.invalidateQueries({ queryKey: ['ipc-status', patientId] });
    void qc.invalidateQueries({ queryKey: ['ipd-stay'] }); void qc.invalidateQueries({ queryKey: ['ipd-board'] }); };
  if (q.isLoading) return <section className="card card-pad"><Loading /></section>;
  const x = q.data;
  if (!x) return <section className="card card-pad"><ErrorBox error={q.error} /></section>;
  const active = x.status === 'active';
  const sugg = st.data?.suggestions ?? [];
  return (
    <section className="card card-pad stack" style={{ gap: 10 }} id="isolation">
      <h2 style={{ margin: 0 }}>იზოლაცია</h2>
      {((x.active.length > 0 && x.door_sign) || (active && x.can.edit)) && <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {active && x.can.edit && <button className="btn sm primary" type="button" onClick={() => { setErr(null); setWarn([]); setDlg({}); }}>+ იზოლაცია</button>}
        {x.active.length > 0 && x.door_sign && <button className="btn sm" type="button" onClick={() => openBlob(`/ipc/stays/${encounterId}/door-sign`).catch(setErr)}>კარის ნიშანი (PDF)</button>}</div>}
      <ErrorBox error={err} />
      {warn.length > 0 && <div className="alert warn" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>{warn.map((w) => <span key={w}>{w}</span>)}</div>}
      {sugg.length > 0 && active && (
        <div className="alert danger" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <span className="grow">MDRO ფლაგი — შესაბამისი იზოლაცია არ არის: {sugg.map((s) => `${s.mdro_code.toUpperCase()} → ${ISO_KA[s.isolation_type]}`).join('; ')}</span>
          {x.can.edit && sugg.map((s) => <button key={s.flag_id} className="btn sm" style={{ background: '#fff' }} type="button"
            onClick={() => { setErr(null); setWarn([]); setDlg({ type: s.isolation_type, reason: 'mdro', flag_id: s.flag_id }); }}>{ISO_KA[s.isolation_type]} ({s.mdro_code.toUpperCase()})</button>)}
        </div>)}
      {!x.active.length ? <span className="muted">აქტიური იზოლაცია არ არის</span> : (
        <div className="stack" style={{ gap: 6 }}>
          {x.active.map((i) => (
            <div key={i.id} className="row" style={{ gap: 8, flexWrap: 'wrap', borderLeft: `6px solid ${i.color}`, paddingLeft: 10 }}>
              <strong>{i.name}</strong>
              <span className="small">{REASON_KA[i.reason]}{i.mdro_code ? ` ${i.mdro_code.toUpperCase()}` : ''}{i.reason_text ? ` — ${i.reason_text}` : ''}</span>
              <span className="small muted">{tsDate(i.started_at)} {hhmmTs(i.started_at)} · დღე {i.days}{i.started_by_name ? ` · ${i.started_by_name}` : ''}</span>
              <span className="grow" />
              {active && x.can.edit && (i.reason !== 'mdro' || x.can.end_mdro)
                ? <button className="btn sm" type="button" onClick={() => { setErr(null); setEndId(i.id); }}>მოხსნა</button>
                : i.reason === 'mdro' && active && <span className="small muted" title="MDRO-ს გამო დადებულ იზოლაციას ხსნის ინფექციის კონტროლი">ხსნის IPC</span>}
            </div>))}
        </div>)}
      {x.history.length > 0 && <button type="button" className="linklike small" style={{ alignSelf: 'flex-start' }} onClick={() => setHist(!hist)}>{hist ? 'ისტორიის დამალვა' : `ისტორია (${x.history.length})`}</button>}
      {hist && (
        <table className="table small">
          <thead><tr><th>ტიპი</th><th>მიზეზი</th><th>დაწყება</th><th>დასრულება</th></tr></thead>
          <tbody>{x.history.map((i) => (
            <tr key={i.id}><td>{i.name}</td><td>{REASON_KA[i.reason]}{i.mdro_code ? ` ${i.mdro_code.toUpperCase()}` : ''}{i.reason_text ? ` — ${i.reason_text}` : ''}</td>
              <td className="mono">{tsDate(i.started_at)} {hhmmTs(i.started_at)}</td>
              <td><span className="mono">{i.ended_at ? `${tsDate(i.ended_at)} ${hhmmTs(i.ended_at)}` : ''}</span> {i.auto_ended ? <span className="chip">ავტომატურად</span> : i.ended_by_name}
                {i.end_reason && <div className="muted">{i.end_reason}</div>}</td></tr>))}</tbody>
        </table>)}
      {dlg && <StartDialog encounterId={encounterId} preset={dlg} flags={(st.data?.flags ?? []).filter((f) => f.status === 'active')} onClose={() => setDlg(null)}
        onDone={(w) => { setDlg(null); setWarn(w); inval(); }} />}
      {endId && <EndDialog id={endId} onClose={() => setEndId(null)} onDone={() => { setEndId(null); inval(); }} />}
    </section>
  );
}

function StartDialog({ encounterId, preset, flags, onClose, onDone }: { encounterId: string; preset: { type?: string; reason?: string; flag_id?: string };
  flags: { id: string; mdro_code: string; isolation_type: string }[]; onClose: () => void; onDone: (warnings: string[]) => void }) {
  const [f, setF] = useState({ type: preset.type ?? 'contact', reason: preset.reason ?? (flags.length ? 'mdro' : 'suspected'), reason_text: '', flag_id: preset.flag_id ?? flags[0]?.id ?? '' });
  const m = useMutation({ mutationFn: () => api<StayIsolations>(`/ipc/stays/${encounterId}/isolations`, { body: { type: f.type, reason: f.reason, reason_text: f.reason_text.trim() || undefined,
    flag_id: f.reason === 'mdro' ? f.flag_id || undefined : undefined } }), onSuccess: (r) => onDone(r.warnings ?? []) });
  const needText = ['other', 'suspected', 'confirmed'].includes(f.reason);
  return (
    <Modal title="იზოლაციის დაყენება" onClose={onClose} footer={<>
      <button className="btn" type="button" onClick={onClose}>გაუქმება</button>
      <button className="btn primary" type="button" disabled={m.isPending || (needText && f.reason_text.trim().length < 2) || (f.reason === 'mdro' && !f.flag_id)} onClick={() => m.mutate()}>დაყენება</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <ErrorBox error={m.error} />
        <Field label="ტიპი" htmlFor="iso-type"><select id="iso-type" className="select" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
          {ISO_TYPES.map((t) => <option key={t} value={t}>{ISO_KA[t]}</option>)}</select></Field>
        <Field label="მიზეზი" htmlFor="iso-reason"><select id="iso-reason" className="select" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })}>
          {Object.entries(REASON_KA).filter(([k]) => k !== 'mdro' || flags.length > 0).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        {f.reason === 'mdro' && <Field label="MDRO ფლაგი" htmlFor="iso-flag"><select id="iso-flag" className="select" value={f.flag_id}
          onChange={(e) => { const fl = flags.find((x) => x.id === e.target.value); setF({ ...f, flag_id: e.target.value, ...(fl && { type: fl.isolation_type }) }); }}>
          {flags.map((x) => <option key={x.id} value={x.id}>{x.mdro_code.toUpperCase()} → {ISO_KA[x.isolation_type]}</option>)}</select></Field>}
        <Field label={needText ? 'ინფექცია / მიზეზი' : 'შენიშვნა'} htmlFor="iso-text" required={needText}>
          <input id="iso-text" className="input" value={f.reason_text} maxLength={500} placeholder={f.reason === 'suspected' ? 'მაგ. გრიპი?, ტუბერკულოზი?' : ''} onChange={(e) => setF({ ...f, reason_text: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

function EndDialog({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const m = useMutation({ mutationFn: () => api(`/ipc/isolations/${id}/end`, { body: { reason: reason.trim() } }), onSuccess: onDone });
  return (
    <Modal title="იზოლაციის მოხსნა" onClose={onClose} footer={<>
      <button className="btn" type="button" onClick={onClose}>გაუქმება</button>
      <button className="btn primary" type="button" disabled={m.isPending || reason.trim().length < 3} onClick={() => m.mutate()}>მოხსნა</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <ErrorBox error={m.error} />
        <Field label="მიზეზი" htmlFor="iso-end" required><input id="iso-end" className="input" value={reason} maxLength={500} placeholder="მაგ. PCR უარყოფითი, სიმპტომები გაქრა"
          onChange={(e) => setReason(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}
