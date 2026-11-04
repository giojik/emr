import { IfModule } from '../components/ModuleGate';
import { DX_ANY } from '../lib/moduleRoutes';
import Form100History from '../components/Form100History';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { can, api } from '../api/client';
import type { Doctor, EncounterListItem, Patient } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import AllergyBanner from '../components/AllergyBanner';
import IpcBanner from '../components/IpcBanner';
import AllergyDialog from '../components/AllergyDialog';
import AddressFields, { addressPayload } from '../components/AddressFields';
import AppointmentDialog from '../components/AppointmentDialog';
import ConsentsPanel from '../components/ConsentsPanel';
import { CumulativeModal } from './lab/Cumulative';
import DocumentsPanel from '../components/DocumentsPanel';
import PatientTasks from './worklist/PatientTasks';
import { OrderDialog } from './encounter/DiagnosticsPanel';
import { ImplantsPanel } from './or/Library';
import { ErrorBox, Field, Loading, Modal, StatusChip } from '../components/ui';
import { age, dateGe, initials, money, tsDate } from '../lib/format';
import { IdentifyDialog, MergeDialog, UnknownChip } from '../components/UnknownPatient';
import { ER_REG } from './er/types';

export default function PatientCard() {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const [dlg, setDlg] = useState<'appt' | 'walkin' | 'allergy' | 'edit' | 'lab' | 'identify' | 'merge' | null>(null);
  const [mergeTarget, setMergeTarget] = useState<string | undefined>();
  const [cum, setCum] = useState(false); const [f100, setF100] = useState(false);
  const nav = useNavigate();
  const p = useQuery({ queryKey: ['patient', id], queryFn: () => api<Patient>(`/patients/${id}`) });
  const visits = useQuery({ queryKey: ['encounters', 'patient', id], queryFn: () => api<EncounterListItem[]>('/encounters', { query: { patient_id: id } }) });
  const front = can(user, 'admin') || can(user, 'receptionist');
  const clinical = can(user, 'doctor') || can(user, 'nurse') || can(user, 'admin');
  const mgrOnly = can(user, 'manager') && !front && !clinical && !can(user, 'billing');   // მენეჯერი: დემოგრაფია + ვიზიტები

  if (p.isLoading) return <Loading />;
  if (p.error || !p.data) return <div className="content"><ErrorBox error={p.error ?? 'პაციენტი ვერ მოიძებნა'} /></div>;
  const x = p.data;
  const name = `${x.first_name} ${x.last_name}`;

  return (
    <>
      <header className="topbar">
        <div className="avatar" style={{ width: 48, height: 48, fontSize: 16, background: 'var(--ink)', color: '#fff' }} aria-hidden="true">{initials(name)}</div>
        <div className="stack grow" style={{ gap: 2 }}>
          <h1 className="row" style={{ gap: 8 }}>{name} <UnknownChip p={x} /></h1>
          <span className="muted">{x.gender === 'male' ? 'მამრობითი' : x.gender === 'female' ? 'მდედრობითი' : '—'} · {x.birth_date_estimated ? '~' : ''}{age(x.birth_date)} წლის · <span className="mono">{x.personal_number ?? (x.passport_number ? `პასპ. ${x.passport_number}` : 'საბუთი —')}</span>{x.blood_group ? ` · ${x.blood_group}` : ''}</span>
        </div>
        {x.is_unknown && !x.merged_into_id && can(user, 'admin', 'receptionist', 'er_triage', 'er_manage') && <button className="btn" type="button" onClick={() => setDlg('identify')}>იდენტიფიკაცია</button>}
        {x.is_unknown && !x.merged_into_id && can(user, 'admin', 'er_manage') && <button className="btn" type="button" onClick={() => { setMergeTarget(undefined); setDlg('merge'); }}>გაერთიანება…</button>}
        {!x.merged_into_id && !x.is_deceased && can(user, ...ER_REG) && <IfModule code="er" write><button className="btn" type="button" onClick={() => nav(`/er?register=${x.id}`)}>ER-ში მიღება</button></IfModule>}
        {front && <>
          <button className="btn" type="button" onClick={() => setDlg('edit')}>რედაქტირება</button>
          <IfModule code={DX_ANY} write><button className="btn" type="button" onClick={() => setDlg('lab')}>ანალიზები / რადიოლოგია</button></IfModule>
          {can(user, 'admin', 'doctor', 'nurse', 'diagnostic', 'lab_doctor', 'lab_manager') && <IfModule code="lab"><button className="btn" type="button" onClick={() => setCum(true)}>ლაბ. დინამიკა</button></IfModule>}
          {can(user, 'admin', 'doctor', 'receptionist') && <button className="btn" type="button" onClick={() => setF100(true)}>ფ.№100 — ისტორია</button>}
          <IfModule code="outpatient" write><button className="btn" type="button" onClick={() => setDlg('walkin')}>Walk-in ვიზიტი</button></IfModule>
          <button className="btn primary" type="button" onClick={() => setDlg('appt')}>+ ჩაწერა</button>
        </>}
      </header>
      <div className="content">
        {x.is_deceased && <div className="alert danger">პაციენტი გარდაცვლილად არის მონიშნული.</div>}
        {x.merged_into_id && <div className="alert info">ეს დროებითი (უცნობი #{x.unknown_no}) ჩანაწერი გაერთიანებულია ნამდვილ ბარათთან — <Link to={`/patients/${x.merged_into_id}`}>ნამდვილი ბარათი →</Link></div>}
        {x.is_unknown && !x.merged_into_id && <div className="alert warn">იდენტობა დაუდასტურებელია (უცნობი #{x.unknown_no}){x.birth_date_estimated ? ', დაბადების თარიღი შეფასებულია' : ''} — საჭიროა იდენტიფიკაცია ან გაერთიანება ნამდვილ ჩანაწერთან.</div>}
        <AllergyBanner allergies={x.allergies} chronic={x.chronic_conditions} onAdd={front || clinical ? () => setDlg('allergy') : undefined} />
        <IpcBanner patientId={id} />

        <section className="card card-pad" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: '14px 20px' }}>
          <Info k="ტელეფონი" v={<span className="mono">{x.phone_number}</span>} />
          <Info k="დაბადების თარიღი" v={<span className="mono">{dateGe(x.birth_date)}</span>} />
          <Info k="მოქალაქეობა" v={x.citizenship} />
          <Info k="საგანგებო კონტაქტი" v={x.emergency_contact_name ? `${x.emergency_contact_name}${x.emergency_contact_phone ? `, ${x.emergency_contact_phone}` : ''}` : '—'} />
          <div style={{ gridColumn: '1 / -1' }}><Info k="მისამართი" v={x.address ?? '—'} /></div>
        </section>

        {!mgrOnly && <ImplantsPanel patientId={x.id} />}
        {!mgrOnly && <ConsentsPanel patientId={x.id} scope="patient" canSign={front || clinical} />}
        {!mgrOnly && <DocumentsPanel patientId={x.id} canUpload={front || clinical} canDeactivate={front} />}
        {!mgrOnly && (front || clinical) && <PatientTasks patientId={x.id} patientName={name} />}

        <section className="card">
          <div className="card-head"><h2>ვიზიტების ისტორია</h2><span className="small muted">{visits.data?.length ?? 0}</span></div>
          <ErrorBox error={visits.error} />
          {visits.data?.length === 0 && <div className="empty">ვიზიტები ჯერ არ არის.</div>}
          {visits.data && visits.data.length > 0 && (
            <table className="table">
              <thead><tr><th>თარიღი</th><th>ექიმი</th><th>ძირითადი დიაგნოზი</th><th className="num">ინვოისი</th><th>სტატუსი</th></tr></thead>
              <tbody>
                {visits.data.map((v) => (
                  <tr key={v.id}>
                    <td className="mono">{tsDate(v.start_time)}</td>
                    <td>{v.type === 'emergency' ? <Link to={`/er?visit=${v.id}`}>გადაუდებელი (ER){v.doctor_name ? ` · ${v.doctor_name}` : ''}</Link> : v.type === 'inpatient' ? <Link to={`/inpatient/stay/${v.id}`}>სტაციონარი · {v.doctor_name}</Link> : v.visit_kind === 'lab' ? <span className="muted">დიაგნოსტიკური ვიზიტი (ექიმის გარეშე)</span> : clinical ? <Link to={`/encounters/${v.id}`}>{v.doctor_name}</Link> : v.doctor_name}</td>
                    <td>{v.primary_diagnosis ?? <span className="muted">—</span>}</td>
                    <td className="num">{v.total_amount ? money(v.total_amount) : '—'}</td>
                    <td><StatusChip status={v.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
      {dlg === 'appt' && <AppointmentDialog patient={x} onClose={() => setDlg(null)} />}
      {dlg === 'walkin' && <WalkInDialog patient={x} onClose={() => setDlg(null)} />}
      {dlg === 'allergy' && <AllergyDialog patientId={x.id} onClose={() => setDlg(null)} />}
      {dlg === 'identify' && <IdentifyDialog patient={x} onClose={() => setDlg(null)} onMerge={can(user, 'admin', 'er_manage') ? (t) => { setMergeTarget(t.id); setDlg('merge'); } : undefined} />}
      {dlg === 'merge' && <MergeDialog source={x} initialTarget={mergeTarget} onClose={() => setDlg(null)} onDone={(t) => nav(`/patients/${t}`)} />}
      {dlg === 'edit' && <EditPatientDialog patient={x} onClose={() => setDlg(null)} />}
      {f100 && <Form100History patientId={x.id} onClose={() => setF100(false)} />}
      {cum && <CumulativeModal patientId={x.id} title={`${x.first_name} ${x.last_name} — ლაბორატორიული დინამიკა`} onClose={() => setCum(false)} />}
      {dlg === 'lab' && <OrderDialog patientId={x.id} onClose={() => setDlg(null)} onLabVisit={(eid) => nav(`/cashier/${eid}`)} />}
    </>
  );
}

function EditPatientDialog({ patient: p, onClose }: { patient: Patient; onClose: () => void }) {
  const qc = useQueryClient();
  const foreign = !p.personal_number;
  const [f, setF] = useState({ first_name: p.first_name, last_name: p.last_name, birth_date: p.birth_date, phone_number: p.phone_number, blood_group: p.blood_group ?? '', emergency_contact_name: p.emergency_contact_name ?? '', emergency_contact_phone: p.emergency_contact_phone ?? '',
    email: p.email ?? '', result_email: !!p.result_email, result_sms: !!p.result_sms });
  const [addr, setAddr] = useState({ address_unit_code: p.address_unit_code ?? '', address_district_code: p.address_district_code ?? '', address_village: p.address_village ?? '', address_line: p.address_line ?? (p.address_unit_code ? '' : p.address ?? ''), address_country: p.address_country ?? '' });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const m = useMutation({
    mutationFn: () => api(`/patients/${p.id}`, { method: 'PATCH', body: { ...f, blood_group: f.blood_group || null, emergency_contact_name: f.emergency_contact_name || null, emergency_contact_phone: f.emergency_contact_phone || null, email: f.email.trim() || null, ...addressPayload(addr, foreign) } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['patient', p.id] }); onClose(); },
  });
  return (
    <Modal title="პაციენტის მონაცემები" onClose={onClose} width={760}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="submit" form="ep" disabled={m.isPending}>შენახვა</button></>}>
      <form id="ep" onSubmit={(e) => { e.preventDefault(); m.mutate(); }} style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 14 }}>
        <Field label="სახელი" htmlFor="efn"><input id="efn" className="input" value={f.first_name} onChange={set('first_name')} required /></Field>
        <Field label="გვარი" htmlFor="eln"><input id="eln" className="input" value={f.last_name} onChange={set('last_name')} required /></Field>
        <Field label="დაბადების თარიღი" htmlFor="ebd"><input id="ebd" className="input" type="date" value={f.birth_date} onChange={set('birth_date')} required /></Field>
        <Field label="ტელეფონი" htmlFor="eph"><input id="eph" className="input mono" value={f.phone_number} onChange={set('phone_number')} required /></Field>
        <Field label="საგანგებო კონტაქტი" htmlFor="eec"><input id="eec" className="input" value={f.emergency_contact_name} onChange={set('emergency_contact_name')} /></Field>
        <Field label="მისი ტელეფონი" htmlFor="eecp"><input id="eecp" className="input mono" value={f.emergency_contact_phone} onChange={set('emergency_contact_phone')} /></Field>
        <div style={{ gridColumn: '1 / -1' }} className="stack">
          <Field label="ელ-ფოსტა" htmlFor="eem" hint="ლაბ. პასუხის მიწოდებისთვის (დაშიფრული PDF)"><input id="eem" className="input" type="email" value={f.email} onChange={set('email')} placeholder="name@example.com" /></Field>
          <div className="row small" style={{ gap: 14 }}><span className="muted">პასუხის მიწოდება (თანხმობა):</span>
            <label className="row"><input type="checkbox" checked={f.result_email} onChange={(e) => setF({ ...f, result_email: e.target.checked })} /> ელ-ფოსტით (PDF)</label>
            <label className="row"><input type="checkbox" checked={f.result_sms} onChange={(e) => setF({ ...f, result_sms: e.target.checked })} /> SMS შეტყობინება</label></div>
        </div>
        <div style={{ gridColumn: '1 / -1' }}><h3>მისამართი</h3></div>
        <AddressFields value={addr} onChange={setAddr} foreign={foreign} />
        <div style={{ gridColumn: '1 / -1' }}><span className="hint">ცვლილება აუდიტში იწერება ძველი და ახალი მნიშვნელობით.</span><ErrorBox error={m.error} /></div>
      </form>
    </Modal>
  );
}

const Info = ({ k, v }: { k: string; v: React.ReactNode }) => (
  <div className="stack" style={{ gap: 2 }}><span className="small muted">{k}</span><span style={{ fontWeight: 500 }}>{v}</span></div>
);

function WalkInDialog({ patient, onClose }: { patient: Patient; onClose: () => void }) {
  const qc = useQueryClient(); const nav = useNavigate();
  const doctors = useQuery({ queryKey: ['doctors'], queryFn: () => api<Doctor[]>('/doctors') });
  const [doc, setDoc] = useState(''); const [cc, setCc] = useState('');
  const m = useMutation({
    mutationFn: () => api<{ encounter_id: string }>('/encounters/walk-in', { body: { patient_id: patient.id, doctor_id: doc, chief_complaint: cc || undefined } }),
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ['encounters'] }); nav(`/cashier/${r.encounter_id}`); },
  });
  return (
    <Modal title="ვიზიტი ჩაწერის გარეშე" onClose={onClose} width={520}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={!doc || m.isPending} onClick={() => m.mutate()}>ვიზიტის გახსნა და სალარო</button></>}>
      <Field label="ექიმი" htmlFor="wd" required>
        <select id="wd" className="select" value={doc} onChange={(e) => setDoc(e.target.value)}>
          <option value="">— აირჩიეთ —</option>
          {doctors.data?.map((d) => <option key={d.id} value={d.id}>{d.last_name} {d.first_name}{d.specialty ? ` — ${d.specialty}` : ''} · {money(d.consultation_price)}</option>)}
        </select>
      </Field>
      <Field label="ჩივილი" htmlFor="wc"><input id="wc" className="input" value={cc} onChange={(e) => setCc(e.target.value)} /></Field>
      <ErrorBox error={m.error} />
    </Modal>
  );
}
