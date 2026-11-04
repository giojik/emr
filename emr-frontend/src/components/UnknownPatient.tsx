import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, api } from '../api/client';
import type { PatientListItem } from '../api/types';
import { dateGe } from '../lib/format';
import PatientSearch from './PatientSearch';
import { ErrorBox, Field, Loading, Modal } from './ui';

/**
 * 0087: უცნობი / დაუდასტურებელი პაციენტი (ER) — იდენტიფიკაცია (იგივე ჩანაწერი ივსება) და გაერთიანება ნამდვილ ჩანაწერთან.
 * ბირთვის (mpi) ფუნქციაა — ER-ის გამორთვის შემდეგაც მუშაობს.
 */
export interface UnknownLike { id: string; first_name: string; last_name: string; gender: string; birth_date: string; birth_date_estimated?: boolean; is_unknown?: boolean; unknown_no?: number | null }

export const UnknownChip = ({ p }: { p: { is_unknown?: boolean; unknown_no?: number | null } }) =>
  p.is_unknown ? <span className="chip warn" title="იდენტობა დაუდასტურებელია — საჭიროა იდენტიფიკაცია">უცნობი #{p.unknown_no}</span> : null;

export function IdentifyDialog({ patient, onClose, onDone, onMerge }: { patient: UnknownLike; onClose: () => void; onDone?: () => void; onMerge?: (target: { id: string }) => void }) {
  const qc = useQueryClient();
  const placeholder = patient.first_name === 'უცნობი';
  const [f, setF] = useState({ first_name: placeholder ? '' : patient.first_name, last_name: placeholder ? '' : patient.last_name, personal_number: '', passport_number: '', citizenship: 'GEO',
    birth_date: patient.birth_date_estimated ? '' : patient.birth_date, gender: patient.gender, phone_number: '' });
  const [foreign, setForeign] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const m = useMutation({
    mutationFn: () => api(`/patients/${patient.id}/identify`, { body: { first_name: f.first_name.trim(), last_name: f.last_name.trim(), birth_date: f.birth_date, gender: f.gender,
      ...(foreign ? { passport_number: f.passport_number.trim(), citizenship: f.citizenship } : { personal_number: f.personal_number.trim() }), phone_number: f.phone_number.trim() || undefined } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['patient', patient.id] }); void qc.invalidateQueries({ queryKey: ['er-board'] }); void qc.invalidateQueries({ queryKey: ['er-visit'] }); onDone?.(); onClose(); },
  });
  const exists = m.error instanceof ApiError && m.error.code === 'PATIENT_EXISTS' ? (m.error.body?.patient as { id: string; first_name: string; last_name: string } | undefined) : undefined;
  const ok = f.first_name.trim() && f.last_name.trim() && f.birth_date && (foreign ? f.passport_number.trim().length >= 3 : /^\d{11}$/.test(f.personal_number));
  return (
    <Modal title={`იდენტიფიკაცია — უცნობი #${patient.unknown_no ?? ''}`} onClose={onClose} width={620}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={!ok || m.isPending} onClick={() => m.mutate()}>შენახვა</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <span className="small muted">იგივე ჩანაწერი შეივსება ნამდვილი მონაცემით — ყველა ჩანაწერი (ტრიაჟი, ანალიზები…) ადგილზე რჩება. თუ ეს ადამიანი MPI-ში უკვე არის — „გაერთიანება“.</span>
        <div className="seg" role="group" aria-label="საბუთი" style={{ width: 'max-content' }}>
          <button type="button" aria-pressed={!foreign} onClick={() => setForeign(false)}>პირადი ნომერი</button>
          <button type="button" aria-pressed={foreign} onClick={() => setForeign(true)}>პასპორტი (უცხოელი)</button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {foreign ? <>
            <Field label="პასპორტის ნომერი" htmlFor="id-pp" required><input id="id-pp" className="input mono" value={f.passport_number} onChange={set('passport_number')} /></Field>
            <Field label="მოქალაქეობა (ISO-3)" htmlFor="id-ct"><input id="id-ct" className="input mono" value={f.citizenship} maxLength={3} onChange={(e) => setF({ ...f, citizenship: e.target.value.toUpperCase() })} /></Field>
          </> : <Field label="პირადი ნომერი" htmlFor="id-pn" required><input id="id-pn" className="input mono" inputMode="numeric" maxLength={11} value={f.personal_number} onChange={(e) => setF({ ...f, personal_number: e.target.value.replace(/\D/g, '') })} /></Field>}
          <span />
          <Field label="სახელი" htmlFor="id-fn" required><input id="id-fn" className="input" value={f.first_name} onChange={set('first_name')} /></Field>
          <Field label="გვარი" htmlFor="id-ln" required><input id="id-ln" className="input" value={f.last_name} onChange={set('last_name')} /></Field>
          <Field label="დაბადების თარიღი" htmlFor="id-bd" required hint={patient.birth_date_estimated ? `ახლა — შეფასებული (${dateGe(patient.birth_date)})` : undefined}><input id="id-bd" className="input" type="date" value={f.birth_date} onChange={set('birth_date')} /></Field>
          <Field label="სქესი" htmlFor="id-g"><select id="id-g" className="select" value={f.gender} onChange={set('gender')}><option value="male">მამრობითი</option><option value="female">მდედრობითი</option><option value="other">სხვა</option></select></Field>
          <Field label="ტელეფონი" htmlFor="id-ph"><input id="id-ph" className="input mono" value={f.phone_number} onChange={set('phone_number')} /></Field>
        </div>
        <ErrorBox error={m.error} />
        {exists && onMerge && <div className="alert warn row" style={{ flexWrap: 'wrap' }}><span className="grow">MPI-ში უკვე არის: <strong>{exists.first_name} {exists.last_name}</strong></span>
          <button className="btn sm primary" type="button" onClick={() => onMerge(exists)}>გაერთიანება ამ ჩანაწერთან →</button></div>}
      </div>
    </Modal>
  );
}

interface Preview { source: PatientListItem & { unknown_no: number | null }; target: PatientListItem; counts: Record<string, number>; problems: string[] }
const TABLE_KA: Record<string, string> = {
  encounters: 'შემთხვევები / ვიზიტები', er_visits: 'ER-ის შემთხვევები', patient_allergies: 'ალერგიები', patient_chronic_conditions: 'ქრონიკული დაავადებები', patient_files: 'ფაილები',
  patient_consents: 'თანხმობები', lab_specimens: 'ლაბ. ნიმუშები', dx_order_items: 'კვლევის შეკვეთები', appointments: 'ჩაწერები', inpatient_stays: 'ჰოსპიტალიზაციები', wl_tasks: 'დავალებები',
};

export function MergeDialog({ source, initialTarget, onClose, onDone }: { source: UnknownLike; initialTarget?: string; onClose: () => void; onDone?: (targetId: string) => void }) {
  const qc = useQueryClient();
  const [target, setTarget] = useState<string | null>(initialTarget ?? null);
  const [reason, setReason] = useState('');
  const pv = useQuery({ queryKey: ['merge-preview', source.id, target], enabled: !!target, queryFn: () => api<Preview>(`/patients/${source.id}/merge-preview`, { query: { target_id: target } }) });
  const m = useMutation({
    mutationFn: () => api<{ merged_into_id: string }>(`/patients/${source.id}/merge`, { body: { target_id: target, reason: reason.trim() } }),
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ['patient'] }); void qc.invalidateQueries({ queryKey: ['er-board'] }); void qc.invalidateQueries({ queryKey: ['er-visit'] }); onDone?.(r.merged_into_id); onClose(); },
  });
  const p = pv.data;
  return (
    <Modal title={`გაერთიანება — უცნობი #${source.unknown_no ?? ''} → ნამდვილი ჩანაწერი`} onClose={onClose} width={680}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button>
        <button className="btn primary" type="button" disabled={!p || p.problems.length > 0 || reason.trim().length < 3 || m.isPending} onClick={() => m.mutate()}>გაერთიანება</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <span className="small muted">უცნობის ყველა ჩანაწერი გადავა ნამდვილ ბარათზე; უცნობის ჩანაწერი მოინიშნება „გაერთიანებულია“ და ძებნაში აღარ ჩანს (არ იშლება). გარე სისტემაში (მაგ. PACS) უკვე გაგზავნილი სახელი თავისით არ შეიცვლება.</span>
        {!target ? <PatientSearch autoFocus onSelect={(x) => setTarget(x.id)} /> : <button className="btn sm" type="button" style={{ width: 'max-content' }} onClick={() => setTarget(null)}>‹ სხვა ჩანაწერის არჩევა</button>}
        {target && pv.isLoading && <Loading />}
        <ErrorBox error={pv.error ?? m.error} />
        {p && <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div className="card card-pad stack" style={{ gap: 2 }}><span className="small muted">წყარო (უცნობი)</span><strong>{p.source.first_name} {p.source.last_name}</strong><span className="small mono">{dateGe(p.source.birth_date)}</span></div>
            <div className="card card-pad stack" style={{ gap: 2 }}><span className="small muted">სამიზნე (ნამდვილი)</span><strong>{p.target.first_name} {p.target.last_name}</strong>
              <span className="small mono">{p.target.personal_number ?? p.target.passport_number} · {dateGe(p.target.birth_date)}</span></div>
          </div>
          {p.problems.map((x) => <div key={x} className="alert danger">{x}</div>)}
          <div className="stack small" style={{ gap: 2 }} data-testid="merge-counts"><strong>გადავა:</strong>
            {Object.keys(p.counts).length === 0 ? <span className="muted">ჩანაწერები არ არის</span>
              : Object.entries(p.counts).map(([t, n]) => <span key={t}>{TABLE_KA[t] ?? t}: {n}</span>)}</div>
          <Field label="მიზეზი (აუდიტი)" htmlFor="mg-r" required><input id="mg-r" className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="მაგ. იდენტიფიცირდა პირადობის მოწმობით" /></Field>
        </>}
      </div>
    </Modal>
  );
}
