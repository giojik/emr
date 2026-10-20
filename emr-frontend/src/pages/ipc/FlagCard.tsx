import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api/client';
import { ErrorBox, Field, Loading, Modal } from '../../components/ui';
import { age, genderShort, tsDate } from '../../lib/format';
import { FLAG_ST, ISO_KA, ONSET_KA, REASON_KA, SOURCE_KA, type FlagDetail } from './types';

const t = (v: string | null | undefined) => (v ? `${tsDate(v)} ${new Date(v).toLocaleTimeString('ka-GE', { timeZone: 'Asia/Tbilisi', hour: '2-digit', minute: '2-digit', hour12: false })}` : '—');

/** MDRO ფლაგის ბარათი (0067): აღმოჩენები, იზოლაციები, პაციენტის სხვა ფლაგები; დადასტურება / მოხსნა / გაუქმება (infection) */
export default function FlagCard() {
  const { id = '' } = useParams(); const nav = useNavigate(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['ipc-flag', id], queryFn: () => api<FlagDetail>(`/ipc/flags/${id}`) });
  const [dlg, setDlg] = useState<'clear' | 'dismiss' | null>(null);
  const inval = () => { void qc.invalidateQueries({ queryKey: ['ipc-flag', id] }); void qc.invalidateQueries({ queryKey: ['ipc-flags'] }); void qc.invalidateQueries({ queryKey: ['ipc-status'] }); };
  const confirm = useMutation({ mutationFn: () => api(`/ipc/flags/${id}/confirm`, { body: {} }), onSuccess: inval });
  if (q.isLoading) return <div className="content"><Loading /></div>;
  const f = q.data;
  if (!f) return <div className="content"><ErrorBox error={q.error} /></div>;
  const open = ['suggested', 'active'].includes(f.status);
  return (
    <>
      <header className="topbar" style={{ flexWrap: 'wrap', gap: 10 }}>
        <button className="btn sm" type="button" onClick={() => nav(-1)}>←</button>
        <h1 style={{ margin: 0 }}>MDRO: {f.mdro_code.toUpperCase()}</h1>
        <span className={`chip ${FLAG_ST[f.status][0]}`}>{FLAG_ST[f.status][1]}</span>{f.urgent && <span className="chip danger">სასწრაფო</span>}
        <span className="grow" />
        {f.can.manage && open && (f.status === 'suggested' || !f.reviewed_at) && <button className="btn primary" type="button" disabled={confirm.isPending} onClick={() => confirm.mutate()}>
          {f.status === 'suggested' ? 'დადასტურება' : 'გადახედილია'}</button>}
        {f.can.manage && f.status === 'active' && <button className="btn" type="button" onClick={() => setDlg('clear')}>მოხსნა</button>}
        {f.can.manage && open && <button className="btn" type="button" onClick={() => setDlg('dismiss')}>გაუქმება (შეცდომა)</button>}
      </header>
      <div className="content">
        <ErrorBox error={confirm.error} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14 }}>
          <section className="card card-pad stack" style={{ gap: 8 }}>
            <h2 style={{ margin: 0 }}>პაციენტი</h2>
            <div><Link to={`/patients/${f.patient_id}`}><strong>{f.last_name} {f.first_name}</strong></Link> <span className="small muted">{genderShort(f.gender)} · {age(f.birth_date)} · {f.personal_number}</span></div>
            {f.stay ? <div className="small">სტაციონარშია: <Link to={`/inpatient/stay/${f.stay.encounter_id}#isolation`}>{f.stay.adm_no}</Link> · {f.stay.department ?? ''} · საწოლი {f.stay.bed_code ?? '—'}</div>
              : <div className="small muted">ამჟამად არ წევს</div>}
            {f.history.length > 0 && <div className="small">სხვა ფლაგები: {f.history.map((h) => <Link key={h.id} to={`/ipc/flags/${h.id}`} style={{ marginRight: 8 }}>{h.mdro_code.toUpperCase()} ({FLAG_ST[h.status][1]})</Link>)}</div>}
          </section>
          <section className="card card-pad stack" style={{ gap: 6 }}>
            <h2 style={{ margin: 0 }}>ფლაგი</h2>
            <Kv k="ტიპი" v={f.mdro_name} /><Kv k="მიკროორგანიზმი" v={f.organism} /><Kv k="წყარო" v={SOURCE_KA[f.source]} />
            <Kv k="შეძენის ადგილი" v={f.onset ? ONSET_KA[f.onset] : '—'} /><Kv k="ნიმუში" v={t(f.specimen_at)} /><Kv k="აღმოჩენა" v={t(f.detected_at)} />
            <Kv k="შეთავაზებული იზოლაცია" v={ISO_KA[f.isolation_type]} />
            <Kv k="გადახედა" v={f.reviewed_at ? `${f.reviewed_by_name ?? '—'} · ${t(f.reviewed_at)}` : 'ჯერ არა'} />
            {f.expires_at && <Kv k="ვადა" v={tsDate(f.expires_at)} />}
            {f.created_by_name && <Kv k="დაამატა" v={f.created_by_name} />}
            {f.note && <Kv k="შენიშვნა" v={f.note} />}
            {f.cleared_at && <Kv k={f.status === 'cleared' ? 'მოიხსნა' : 'გაუქმდა'} v={`${t(f.cleared_at)} · ${f.cleared_by_name ?? 'ავტომატურად'} — ${f.clear_reason}${f.clear_negatives != null ? ` (უარყოფითი სკრინინგი: ${f.clear_negatives})` : ''}`} />}
          </section>
        </div>
        <section className="card card-pad stack" style={{ gap: 8 }}>
          <h2 style={{ margin: 0 }}>აღმოჩენები (მიკრობიოლოგია)</h2>
          {!f.detections.length ? <span className="muted">ხელით / გარე პასუხით დამატებული</span> : (
            <table className="table"><thead><tr><th>ნიმუში</th><th>ანალიზი</th><th>მიკროორგანიზმი</th><th>წესი</th></tr></thead>
              <tbody>{f.detections.map((d) => <tr key={d.id}><td className="mono small">{t(d.specimen_at ?? d.detected_at)}</td><td className="small">{d.service}{d.specimen_type ? ` · ${d.specimen_type}` : ''}</td>
                <td className="small"><i>{d.organism}</i></td><td className="small muted">{d.rule}</td></tr>)}</tbody></table>)}
        </section>
        <section className="card card-pad stack" style={{ gap: 8 }}>
          <h2 style={{ margin: 0 }}>იზოლაციები ამ ფლაგით</h2>
          {!f.isolations.length ? <span className="muted">არ არის</span> : (
            <table className="table"><thead><tr><th>ჰოსპიტალიზაცია</th><th>ტიპი</th><th>დაწყება</th><th>დასრულება</th></tr></thead>
              <tbody>{f.isolations.map((i) => <tr key={i.id}><td><Link to={`/inpatient/stay/${i.encounter_id}#isolation`} className="mono">{i.adm_no}</Link></td>
                <td>{ISO_KA[i.type]} <span className="small muted">({REASON_KA[i.reason]})</span></td><td className="mono small">{t(i.started_at)}</td>
                <td className="small">{i.ended_at ? <>{t(i.ended_at)}<div className="muted">{i.end_reason}</div></> : <span className="chip warn">აქტიური</span>}</td></tr>)}</tbody></table>)}
        </section>
      </div>
      {dlg && <CloseDialog kind={dlg} id={id} required={f.clear_negatives_required} hasIso={f.isolations.some((i) => !i.ended_at)} onClose={() => setDlg(null)} onDone={() => { setDlg(null); inval(); }} />}
    </>
  );
}

function Kv({ k, v }: { k: string; v: string | null | undefined }) {
  return <div className="row" style={{ alignItems: 'flex-start' }}><span className="muted small" style={{ width: 170, flexShrink: 0 }}>{k}</span><span className="small">{v || '—'}</span></div>;
}

function CloseDialog({ kind, id, required, hasIso, onClose, onDone }: { kind: 'clear' | 'dismiss'; id: string; required: number; hasIso: boolean; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState(''); const [neg, setNeg] = useState(String(required)); const [endIso, setEndIso] = useState(true);
  const m = useMutation({ mutationFn: () => api(`/ipc/flags/${id}/${kind}`, { body: kind === 'clear' ? { reason: reason.trim(), negatives: Number(neg || 0), end_isolation: endIso } : { reason: reason.trim() } }), onSuccess: onDone });
  return (
    <Modal title={kind === 'clear' ? 'ფლაგის მოხსნა' : 'ფლაგის გაუქმება (შეცდომა)'} onClose={onClose} footer={<>
      <button className="btn" type="button" onClick={onClose}>გაუქმება</button>
      <button className="btn primary" type="button" disabled={m.isPending || reason.trim().length < 3} onClick={() => m.mutate()}>{kind === 'clear' ? 'მოხსნა' : 'გაუქმება'}</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <ErrorBox error={m.error} />
        {kind === 'clear' && <Field label="უარყოფითი სკრინინგები" htmlFor="cl-n" hint={`მინიმუმ ${required} (პარამეტრი)`}><input id="cl-n" className="input" inputMode="numeric" value={neg} onChange={(e) => setNeg(e.target.value.replace(/\D/g, ''))} /></Field>}
        <Field label="მიზეზი" htmlFor="cl-r" required><input id="cl-r" className="input" value={reason} maxLength={500} placeholder={kind === 'clear' ? 'მაგ. 3 უარყოფითი სკრინინგი' : 'მაგ. კონტამინაცია, არასწორი პაციენტი'} onChange={(e) => setReason(e.target.value)} /></Field>
        {kind === 'clear' && hasIso && <label className="row"><input type="checkbox" checked={endIso} onChange={(e) => setEndIso(e.target.checked)} /> ამ ფლაგით დადებული იზოლაციაც მოიხსნას</label>}
        {kind === 'dismiss' && hasIso && <span className="hint">ამ ფლაგით დადებული აქტიური იზოლაცია ავტომატურად მოიხსნება.</span>}
      </div>
    </Modal>
  );
}
