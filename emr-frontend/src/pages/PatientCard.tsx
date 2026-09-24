import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { Doctor, EncounterListItem, Patient } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import AllergyBanner from '../components/AllergyBanner';
import AllergyDialog from '../components/AllergyDialog';
import AppointmentDialog from '../components/AppointmentDialog';
import { ErrorBox, Field, Loading, Modal, StatusChip } from '../components/ui';
import { age, dateGe, initials, money, tsDate } from '../lib/format';

export default function PatientCard() {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const [dlg, setDlg] = useState<'appt' | 'walkin' | 'allergy' | null>(null);
  const p = useQuery({ queryKey: ['patient', id], queryFn: () => api<Patient>(`/patients/${id}`) });
  const visits = useQuery({ queryKey: ['encounters', 'patient', id], queryFn: () => api<EncounterListItem[]>('/encounters', { query: { patient_id: id } }) });
  const front = user?.role === 'admin' || user?.role === 'receptionist';
  const clinical = user?.role === 'doctor' || user?.role === 'nurse' || user?.role === 'admin';

  if (p.isLoading) return <Loading />;
  if (p.error || !p.data) return <div className="content"><ErrorBox error={p.error ?? 'პაციენტი ვერ მოიძებნა'} /></div>;
  const x = p.data;
  const name = `${x.first_name} ${x.last_name}`;

  return (
    <>
      <header className="topbar">
        <div className="avatar" style={{ width: 48, height: 48, fontSize: 16, background: 'var(--ink)', color: '#fff' }} aria-hidden="true">{initials(name)}</div>
        <div className="stack grow" style={{ gap: 2 }}>
          <h1>{name}</h1>
          <span className="muted">{x.gender === 'male' ? 'მამრობითი' : x.gender === 'female' ? 'მდედრობითი' : '—'} · {age(x.birth_date)} წლის · <span className="mono">{x.personal_number ?? `პასპ. ${x.passport_number}`}</span>{x.blood_group ? ` · ${x.blood_group}` : ''}</span>
        </div>
        {front && <>
          <button className="btn" type="button" onClick={() => setDlg('walkin')}>Walk-in ვიზიტი</button>
          <button className="btn primary" type="button" onClick={() => setDlg('appt')}>+ ჩაწერა</button>
        </>}
      </header>
      <div className="content">
        {x.is_deceased && <div className="alert danger">პაციენტი გარდაცვლილად არის მონიშნული.</div>}
        <AllergyBanner allergies={x.allergies} chronic={x.chronic_conditions} onAdd={front || clinical ? () => setDlg('allergy') : undefined} />

        <section className="card card-pad" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: '14px 20px' }}>
          <Info k="ტელეფონი" v={<span className="mono">{x.phone_number}</span>} />
          <Info k="დაბადების თარიღი" v={<span className="mono">{dateGe(x.birth_date)}</span>} />
          <Info k="მოქალაქეობა" v={x.citizenship} />
          <Info k="საგანგებო კონტაქტი" v={x.emergency_contact_name ? `${x.emergency_contact_name}${x.emergency_contact_phone ? `, ${x.emergency_contact_phone}` : ''}` : '—'} />
          <div style={{ gridColumn: '1 / -1' }}><Info k="მისამართი" v={x.address ?? '—'} /></div>
        </section>

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
                    <td>{clinical ? <Link to={`/encounters/${v.id}`}>{v.doctor_name}</Link> : v.doctor_name}</td>
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
    </>
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
