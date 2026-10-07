import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError, openBlob } from '../../api/client';
import { SignDialog } from '../../components/ConsentsPanel';
import { ErrorBox, Field, Loading, Modal } from '../../components/ui';
import { localISO, todayISO } from '../../lib/format';
import IcdPicker from '../encounter/IcdPicker';
import { invalIpd } from './Inpatient';
import { DISCHARGE_KA, TRANSPORT_KA, useCensus } from './types';

const refresh = (qc: ReturnType<typeof useQueryClient>, encounterId: string) => {
  invalIpd(qc); void qc.invalidateQueries({ queryKey: ['ipd-epicrisis', encounterId] }); void qc.invalidateQueries({ queryKey: ['ipd-discharge-check', encounterId] });
};
const hhmmNow = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tbilisi', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());

// ---------------------------------------------------------------- გადაყვანა (მოთხოვნა)
export function TransferDialog({ encounterId, currentDepartmentId, onClose }: { encounterId: string; currentDepartmentId: string; onClose: () => void }) {
  const qc = useQueryClient(); const census = useCensus();
  const [to, setTo] = useState(''); const [reason, setReason] = useState('');
  const m = useMutation({ mutationFn: () => api(`/inpatient/stays/${encounterId}/transfer`, { body: { to_department_id: to, reason } }), onSuccess: () => { refresh(qc, encounterId); onClose(); } });
  const deps = (census.data?.departments ?? []).filter((d) => d.id !== currentDepartmentId);
  return (
    <Modal title="გადაყვანა სხვა განყოფილებაში" onClose={onClose} width={520}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={m.isPending || !to || reason.trim().length < 3} onClick={() => m.mutate()}>მოთხოვნის გაგზავნა</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <Field label="განყოფილება" htmlFor="tr-to" required><select id="tr-to" className="select" value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="">— აირჩიეთ —</option>{deps.map((d) => <option key={d.id} value={d.id}>{d.name} · თავისუფალი {d.free}</option>)}</select></Field>
        <Field label="მიზეზი" htmlFor="tr-r" required><input id="tr-r" className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <span className="small muted">პაციენტი მიმღების დადასტურებამდე რჩება ამჟამინდელ საწოლზე; მიმღები ირჩევს საწოლს და მკურნალ ექიმს.</span>
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- დროებითი გასვლა
export function LeaveDialog({ encounterId, maxHours, onClose }: { encounterId: string; maxHours: number; onClose: () => void }) {
  const qc = useQueryClient();
  const doctors = useQuery({ queryKey: ['doctors'], queryFn: () => api<{ id: string; first_name: string; last_name: string }[]>('/doctors') });
  const [date, setDate] = useState(todayISO()); const [time, setTime] = useState('20:00'); const [reason, setReason] = useState(''); const [doc, setDoc] = useState('');
  const m = useMutation({ mutationFn: () => api(`/inpatient/stays/${encounterId}/leave`, { body: { expected_return_at: localISO(date, time), reason, permitted_by: doc || undefined } }),
    onSuccess: () => { refresh(qc, encounterId); onClose(); } });
  return (
    <Modal title="დროებითი გასვლა" onClose={onClose} width={520}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={m.isPending || reason.trim().length < 3} onClick={() => m.mutate()}>გაფორმება</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <div className="row" style={{ gap: 12 }}>
          <Field label="დაბრუნება — თარიღი" htmlFor="lv-d" required><input id="lv-d" type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="დრო" htmlFor="lv-t" required><input id="lv-t" type="time" className="input" value={time} onChange={(e) => setTime(e.target.value)} /></Field>
        </div>
        <Field label="მიზეზი" htmlFor="lv-r" required><input id="lv-r" className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <Field label="ნებართვა — ექიმი" htmlFor="lv-doc" hint="ცარიელი — თქვენ (თუ ექიმი ხართ)"><select id="lv-doc" className="select" value={doc} onChange={(e) => setDoc(e.target.value)}>
          <option value="">—</option>{doctors.data?.map((d) => <option key={d.id} value={d.id}>{d.last_name} {d.first_name}</option>)}</select></Field>
        <span className="small muted">საწოლი დაკავებული რჩება. მაქსიმუმ {maxHours} სთ; ვადის გადაცილებისას განყოფილება მიიღებს შეტყობინებას.</span>
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- გაწერა
interface Check {
  status: string; warnings: { code: string; message: string }[]; closure_missing: string[]; epicrisis_status: string | null; on_leave: boolean; transfer_pending: boolean;
  can_sign_with_discharge: boolean; can_discharge: boolean;
}
type DType = 'home' | 'other_clinic' | 'against_advice' | 'death';

export function DischargeDialog({ encounterId, patientId, departmentId, onClose }: { encounterId: string; patientId: string; departmentId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const chk = useQuery({ queryKey: ['ipd-discharge-check', encounterId], queryFn: () => api<Check>(`/inpatient/stays/${encounterId}/discharge/check`) });
  const inst = useQuery({ queryKey: ['ipd-institutions'], queryFn: () => api<{ id: string; name: string }[]>('/inpatient/institutions') });
  const staff = useQuery({ queryKey: ['ipd-staff', departmentId], queryFn: () => api<{ id: string; first_name: string; last_name: string }[]>(`/inpatient/departments/${departmentId}/staff`) });
  const [type, setType] = useState<DType>('home');
  const [sign, setSign] = useState(true);
  const [destId, setDestId] = useState(''); const [destText, setDestText] = useState(''); const [transport, setTransport] = useState('');
  const [refusalId, setRefusalId] = useState<string | null>(null); const [refusalMode, setRefusalMode] = useState<'sign' | 'witness'>('sign'); const [witnesses, setWitnesses] = useState<string[]>([]);
  const [signDlg, setSignDlg] = useState(false);
  const [dDate, setDDate] = useState(todayISO()); const [dTime, setDTime] = useState(hhmmNow()); const [icd, setIcd] = useState<{ code: string; title: string } | null>(null); const [autopsy, setAutopsy] = useState<boolean | null>(null);
  const [note, setNote] = useState(''); const [override, setOverride] = useState('');
  const m = useMutation({
    mutationFn: () => api(`/inpatient/stays/${encounterId}/discharge`, { body: {
      type, note: note.trim() || undefined, override_reason: override.trim() || undefined,
      sign_epicrisis: (type === 'home' || type === 'other_clinic') && sign ? true : undefined,
      destination_id: type === 'other_clinic' ? destId || undefined : undefined, destination_text: type === 'other_clinic' && !destId ? destText : undefined,
      transport: (type === 'other_clinic' || type === 'against_advice') && transport ? transport : undefined,
      refusal_consent_id: type === 'against_advice' && refusalMode === 'sign' ? refusalId ?? undefined : undefined,
      refusal_witnesses: type === 'against_advice' && refusalMode === 'witness' ? witnesses : undefined,
      death_at: type === 'death' ? localISO(dDate, dTime) : undefined, death_icd10_code: type === 'death' ? icd?.code : undefined,
      autopsy_required: type === 'death' ? autopsy ?? undefined : undefined,
    } }),
    onSuccess: () => { refresh(qc, encounterId); onClose(); },
  });
  const c = chk.data;
  const regular = type === 'home' || type === 'other_clinic';
  const signable = regular && c?.can_sign_with_discharge;
  const blocked = regular && !!c && c.closure_missing.length > 0 && !(signable && sign);
  const needOverride = (c?.warnings.length ?? 0) > 0;
  const ready = !!c && c.can_discharge && !blocked && (!needOverride || override.trim().length >= 5) && (
    type === 'home' ? true
    : type === 'other_clinic' ? !!destId || destText.trim().length >= 3
    : type === 'against_advice' ? (refusalMode === 'sign' ? !!refusalId : witnesses.length >= 2)
    : !!icd && autopsy !== null);
  const errBody = m.error instanceof ApiError ? m.error : null;

  return (
    <Modal title="გაწერა" onClose={onClose} width={680}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button>
        <button className={`btn ${type === 'death' ? 'danger' : 'primary'}`} type="button" disabled={!ready || m.isPending} onClick={() => m.mutate()}>
          {regular && signable && sign ? 'ხელმოწერა და გაწერა' : type === 'death' ? 'გარდაცვალების დაფიქსირება' : 'გაწერა'}</button></>}>
      {chk.isLoading ? <Loading /> : !c ? <ErrorBox error={chk.error} /> : <div className="stack" style={{ gap: 14 }}>
        {!c.can_discharge && <div className="alert warn">გაწერას აფორმებს მკურნალი ექიმი ან განყოფილების ექიმი.</div>}
        <div className="seg" role="group" aria-label="გაწერის ტიპი" style={{ width: 'max-content', flexWrap: 'wrap' }}>
          {(Object.keys(DISCHARGE_KA) as DType[]).map((k) => <button key={k} type="button" aria-pressed={type === k} onClick={() => setType(k)}>{DISCHARGE_KA[k]}</button>)}
        </div>
        {c.on_leave && <div className="alert warn">პაციენტი დროებით გასულია{regular ? ' — ბინაზე / სხვა კლინიკაში გაწერამდე დააფიქსირეთ დაბრუნება' : ' — გასვლა დაიხურება'}.</div>}
        {c.transfer_pending && <div className="alert info">ღია გადაყვანის მოთხოვნა გაწერისას გაუქმდება.</div>}

        {regular && (c.closure_missing.length > 0 ? (
          signable ? <label className="row"><input type="checkbox" checked={sign} onChange={(e) => setSign(e.target.checked)} />
            <span>ეპიკრიზის ხელმოწერა გაწერასთან ერთად <span className="small muted">(გაწერის თარიღი მოხვდება PDF-ში)</span></span></label>
            : <div className="alert danger">გაწერამდე: {c.closure_missing.join('; ')}</div>
        ) : <div className="alert ok">საბოლოო დიაგნოზი და ხელმოწერილი ეპიკრიზი — მზადაა.</div>)}
        {!regular && c.closure_missing.length > 0 && <div className="small muted">დოკუმენტაცია (ეპიკრიზი, საბოლოო დიაგნოზი) შეიძლება დასრულდეს მოგვიანებით — „შემთხვევის დახურვით“.</div>}

        {type === 'other_clinic' && <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Field label="დაწესებულება" htmlFor="dc-i"><select id="dc-i" className="select" value={destId} onChange={(e) => setDestId(e.target.value)}>
            <option value="">— ცნობარში არ არის —</option>{inst.data?.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></Field>
          {!destId && <Field label="დასახელება" htmlFor="dc-it" required><input id="dc-it" className="input" value={destText} onChange={(e) => setDestText(e.target.value)} /></Field>}
        </div>}
        {(type === 'other_clinic' || type === 'against_advice') && <Field label="ტრანსპორტი" htmlFor="dc-t"><select id="dc-t" className="select" value={transport} onChange={(e) => setTransport(e.target.value)}>
          <option value="">—</option>{Object.entries(TRANSPORT_KA).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>}

        {type === 'against_advice' && <div className="stack" style={{ gap: 8 }}>
          <div className="seg" role="group" aria-label="ხელწერილი" style={{ width: 'max-content' }}>
            <button type="button" aria-pressed={refusalMode === 'sign'} onClick={() => setRefusalMode('sign')}>ხელწერილი</button>
            <button type="button" aria-pressed={refusalMode === 'witness'} onClick={() => setRefusalMode('witness')}>ხელმოწერაზე უარი — მოწმეები</button>
          </div>
          {refusalMode === 'sign' ? <div className="row" style={{ gap: 8 }}>
            {refusalId ? <span className="chip ok">ხელწერილი ხელმოწერილია</span> : <button className="btn" type="button" onClick={() => setSignDlg(true)}>ხელწერილის ხელმოწერა</button>}
            <button className="btn sm" type="button" onClick={() => openBlob(`/patients/${patientId}/consents/SELF_DISCHARGE/form?encounter_id=${encounterId}`).catch(() => undefined)}>ბლანკი (PDF)</button>
          </div> : <Field label="მოწმეები (2 თანამშრომელი)" htmlFor="dc-w">
            <select id="dc-w" className="select" multiple size={5} value={witnesses} onChange={(e) => setWitnesses([...e.target.selectedOptions].map((o) => o.value).slice(0, 3))}>
              {staff.data?.map((u) => <option key={u.id} value={u.id}>{u.last_name} {u.first_name}</option>)}</select></Field>}
        </div>}

        {type === 'death' && <div className="stack" style={{ gap: 10 }}>
          <div className="row" style={{ gap: 12 }}>
            <Field label="თარიღი" htmlFor="dd-d" required><input id="dd-d" type="date" className="input" value={dDate} onChange={(e) => setDDate(e.target.value)} /></Field>
            <Field label="დრო" htmlFor="dd-t" required><input id="dd-t" type="time" className="input" value={dTime} onChange={(e) => setDTime(e.target.value)} /></Field>
          </div>
          <span className="label">გარდაცვალების მიზეზი (ICD-10)</span>
          {icd ? <div className="row"><span className="mono">{icd.code}</span> {icd.title}<button className="btn sm" type="button" onClick={() => setIcd(null)}>შეცვლა</button></div>
            : <IcdPicker primary onPick={(x) => setIcd({ code: x.code, title: x.title })} />}
          <div className="seg" role="group" aria-label="აუტოფსია" style={{ width: 'max-content' }}>
            <button type="button" aria-pressed={autopsy === true} onClick={() => setAutopsy(true)}>აუტოფსია საჭიროა</button>
            <button type="button" aria-pressed={autopsy === false} onClick={() => setAutopsy(false)}>არ არის საჭირო</button>
          </div>
          <span className="small muted">საწოლი დაიბლოკება გვამის გატანამდე. ჩანაწერს აუქმებს მხოლოდ admin.</span>
        </div>}

        {needOverride && <div className="stack" style={{ gap: 6 }}>
          <div className="alert warn">{c.warnings.map((w) => <div key={w.code}>{w.message}</div>)}</div>
          <Field label="გაგრძელების მიზეზი" htmlFor="dc-o" required><input id="dc-o" className="input" value={override} onChange={(e) => setOverride(e.target.value)} placeholder="მაგ. ანალიზი — ამბულატორიულად" /></Field>
        </div>}
        <Field label="შენიშვნა" htmlFor="dc-n"><input id="dc-n" className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        {errBody?.code === 'EPICRISIS_INCOMPLETE' || errBody?.code === 'DISCHARGE_BLOCKED' ? <div className="alert danger">{errBody.message}</div> : <ErrorBox error={m.error} />}
      </div>}
      {signDlg && <SignDialog patientId={patientId} encounterId={encounterId} consent={{ code: 'SELF_DISCHARGE', name: 'ხელწერილი — სტაციონარის თვითნებური დატოვება', text_approved: true }}
        onClose={() => setSignDlg(false)} onSigned={(id) => setRefusalId(id)} />}
    </Modal>
  );
}
