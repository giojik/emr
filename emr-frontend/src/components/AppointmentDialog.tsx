import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../api/client';
import type { Doctor, PatientListItem } from '../api/types';
import { localISO, money, todayISO } from '../lib/format';
import PatientSearch from './PatientSearch';
import { ErrorBox, Field, Modal } from './ui';

export default function AppointmentDialog({ onClose, patient: initialPatient, doctorId, date, time }: {
  onClose: () => void; patient?: PatientListItem; doctorId?: string; date?: string; time?: string;
}) {
  const qc = useQueryClient();
  const doctors = useQuery({ queryKey: ['doctors'], queryFn: () => api<Doctor[]>('/doctors') });
  const [patient, setPatient] = useState<PatientListItem | undefined>(initialPatient);
  const [doc, setDoc] = useState(doctorId ?? '');
  const [day, setDay] = useState(date ?? todayISO());
  const [t, setT] = useState(time ?? '10:00');
  const [dur, setDur] = useState(20);
  const [reason, setReason] = useState('');

  const m = useMutation({
    mutationFn: () => api('/appointments', { body: { patient_id: patient!.id, doctor_id: doc, scheduled_start: localISO(day, t), duration_minutes: dur, reason: reason || undefined } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['appointments'] }); onClose(); },
  });
  const submit = (e: FormEvent) => { e.preventDefault(); if (patient && doc) m.mutate(); };
  const selected = doctors.data?.find((d) => d.id === doc);

  return (
    <Modal title="ჩაწერა ექიმთან" onClose={onClose} width={620}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button>
        <button className="btn primary" type="submit" form="appt-form" disabled={!patient || !doc || m.isPending}>ჩაწერა</button></>}>
      <form id="appt-form" onSubmit={submit} className="stack" style={{ gap: 14 }}>
        <div className="field">
          <span className="label">პაციენტი <span className="req">*</span></span>
          {patient ? (
            <div className="row card" style={{ padding: '10px 12px' }}>
              <strong className="grow">{patient.first_name} {patient.last_name}</strong>
              <span className="mono small muted">{patient.personal_number ?? patient.passport_number}</span>
              {!initialPatient && <button type="button" className="btn sm" onClick={() => setPatient(undefined)}>შეცვლა</button>}
            </div>
          ) : <PatientSearch onSelect={setPatient} autoFocus />}
        </div>
        <Field label="ექიმი" htmlFor="doc" required hint={selected ? `${selected.department_name ?? ''} · კონსულტაცია ${money(selected.consultation_price)}` : undefined}>
          <select id="doc" className="select" value={doc} onChange={(e) => setDoc(e.target.value)} required>
            <option value="">— აირჩიეთ —</option>
            {doctors.data?.map((d) => <option key={d.id} value={d.id}>{d.last_name} {d.first_name}{d.specialty ? ` — ${d.specialty}` : ''}</option>)}
          </select>
        </Field>
        <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
          <Field label="თარიღი" htmlFor="day" required><input id="day" className="input" type="date" value={day} onChange={(e) => setDay(e.target.value)} required /></Field>
          <Field label="დრო" htmlFor="tm" required><input id="tm" className="input" type="time" step={300} value={t} onChange={(e) => setT(e.target.value)} required /></Field>
          <Field label="ხანგრძლივობა" htmlFor="dur">
            <select id="dur" className="select" value={dur} onChange={(e) => setDur(Number(e.target.value))}>
              {[10, 15, 20, 30, 40, 60].map((n) => <option key={n} value={n}>{n} წთ</option>)}
            </select>
          </Field>
        </div>
        <Field label="მიზეზი" htmlFor="rs"><input id="rs" className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="მაგ. გულმკერდის ტკივილი" /></Field>
        <ErrorBox error={m.error} />
      </form>
    </Modal>
  );
}
