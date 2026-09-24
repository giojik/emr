import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { Patient, PatientListItem } from '../api/types';
import AddressFields, { addressPayload, emptyAddress } from '../components/AddressFields';
import { ErrorBox, Field, WarnIcon, useDebounced } from '../components/ui';
import { dateGe } from '../lib/format';

export default function PatientNew() {
  const nav = useNavigate();
  const [foreign, setForeign] = useState(false);
  const [f, setF] = useState({ personal_number: '', passport_number: '', citizenship: 'GEO', first_name: '', last_name: '', birth_date: '', gender: '', phone_number: '', blood_group: '', emergency_contact_name: '', emergency_contact_phone: '' });
  const [addr, setAddr] = useState(emptyAddress());
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  const pnErr = !foreign && f.personal_number && !/^\d{11}$/.test(f.personal_number) ? `11 ციფრი (შეყვანილია ${f.personal_number.replace(/\D/g, '').length})` : undefined;
  // შესაძლო დუბლიკატი: პირადი ნომრით ან ტელეფონით
  const dupKey = useDebounced(!foreign && /^\d{11}$/.test(f.personal_number) ? f.personal_number : f.phone_number.replace(/\s/g, '').length >= 9 ? f.phone_number.replace(/\s/g, '') : '', 400);
  const dup = useQuery({ queryKey: ['patients', 'dup', dupKey], queryFn: () => api<PatientListItem[]>('/patients', { query: { search: dupKey } }), enabled: dupKey.length >= 9 });

  const m = useMutation({
    mutationFn: () => {
      const body: Record<string, string> = {};
      for (const [k, v] of Object.entries(f)) if (v.trim()) body[k] = v.trim();
      if (foreign) delete body.personal_number; else delete body.passport_number;
      const a = Object.fromEntries(Object.entries(addressPayload(addr, foreign)).filter(([, v]) => v));
      return api<Patient>('/patients', { body: { ...body, ...a } });
    },
    onSuccess: (p) => nav(`/patients/${p.id}`, { replace: true }),
  });
  const submit = (e: FormEvent) => { e.preventDefault(); if (!pnErr) m.mutate(); };

  return (
    <>
      <header className="topbar"><h1 className="grow">ახალი პაციენტის რეგისტრაცია</h1></header>
      <div className="content">
        <form onSubmit={submit} className="card card-pad" style={{ maxWidth: 820, display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '16px 20px' }}>
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <span className="label">მოქალაქეობა</span>
            <div className="seg" role="group" aria-label="მოქალაქეობა" style={{ width: 'max-content' }}>
              <button type="button" aria-pressed={!foreign} onClick={() => { setForeign(false); setF({ ...f, citizenship: 'GEO' }); }}>საქართველო</button>
              <button type="button" aria-pressed={foreign} onClick={() => { setForeign(true); setF({ ...f, citizenship: '' }); }}>უცხო ქვეყნის მოქალაქე</button>
            </div>
          </div>
          {!foreign ? (
            <Field label="პირადი ნომერი" htmlFor="pn" required error={pnErr}>
              <input id="pn" className={`input mono${pnErr ? ' invalid' : ''}`} inputMode="numeric" maxLength={11} value={f.personal_number} onChange={set('personal_number')} required autoFocus />
            </Field>
          ) : (<>
            <Field label="პასპორტის ნომერი" htmlFor="pp" required><input id="pp" className="input mono" value={f.passport_number} onChange={set('passport_number')} required autoFocus /></Field>
            <Field label="ქვეყანა (ISO, 3 ასო)" htmlFor="ct" required hint="მაგ. TUR, ARM, AZE, UKR"><input id="ct" className="input mono" maxLength={3} value={f.citizenship} onChange={(e) => setF({ ...f, citizenship: e.target.value.toUpperCase() })} required /></Field>
          </>)}
          {!foreign && <div />}
          <Field label="სახელი" htmlFor="fn" required><input id="fn" className="input" value={f.first_name} onChange={set('first_name')} required /></Field>
          <Field label="გვარი" htmlFor="ln" required><input id="ln" className="input" value={f.last_name} onChange={set('last_name')} required /></Field>
          <Field label="დაბადების თარიღი" htmlFor="bd" required><input id="bd" className="input" type="date" value={f.birth_date} onChange={set('birth_date')} max={new Date().toISOString().slice(0, 10)} required /></Field>
          <div className="field">
            <span className="label">სქესი <span className="req">*</span></span>
            <div className="seg" role="group" aria-label="სქესი" style={{ width: 'max-content' }}>
              <button type="button" aria-pressed={f.gender === 'male'} onClick={() => setF({ ...f, gender: 'male' })}>მამრობითი</button>
              <button type="button" aria-pressed={f.gender === 'female'} onClick={() => setF({ ...f, gender: 'female' })}>მდედრობითი</button>
            </div>
          </div>
          <Field label="ტელეფონი" htmlFor="ph" required><input id="ph" className="input mono" type="tel" value={f.phone_number} onChange={set('phone_number')} required /></Field>
          <Field label="სისხლის ჯგუფი" htmlFor="bg">
            <select id="bg" className="select" value={f.blood_group} onChange={set('blood_group')}>
              <option value="">უცნობი</option>
              {['0(I) Rh+', '0(I) Rh-', 'A(II) Rh+', 'A(II) Rh-', 'B(III) Rh+', 'B(III) Rh-', 'AB(IV) Rh+', 'AB(IV) Rh-'].map((g) => <option key={g} value={g.replace(' ', '')}>{g}</option>)}
            </select>
          </Field>
          <div style={{ gridColumn: '1 / -1' }}><h3 style={{ marginTop: 6 }}>მისამართი</h3></div>
          <AddressFields value={addr} onChange={setAddr} foreign={foreign} />
          <Field label="საგანგებო კონტაქტი" htmlFor="ec" hint="სახელი, კავშირი"><input id="ec" className="input" value={f.emergency_contact_name} onChange={set('emergency_contact_name')} /></Field>
          <Field label="მისი ტელეფონი" htmlFor="ecp"><input id="ecp" className="input mono" type="tel" value={f.emergency_contact_phone} onChange={set('emergency_contact_phone')} /></Field>

          {dup.data && dup.data.length > 0 && (
            <div className="alert warn" style={{ gridColumn: '1 / -1' }}>
              <WarnIcon color="var(--warn-ink)" />
              <div className="stack" style={{ gap: 4 }}>
                <strong>შესაძლო დუბლიკატი</strong>
                {dup.data.slice(0, 3).map((d) => <span key={d.id}>{d.first_name} {d.last_name}, {dateGe(d.birth_date)}, {d.phone_number} — <Link to={`/patients/${d.id}`}>ბარათის გახსნა</Link></span>)}
              </div>
            </div>
          )}
          <div style={{ gridColumn: '1 / -1' }}><ErrorBox error={m.error} /></div>
          <div className="row" style={{ gridColumn: '1 / -1', justifyContent: 'flex-end' }}>
            <Link className="btn" to="/patients">გაუქმება</Link>
            <button className="btn primary" type="submit" disabled={m.isPending || !f.gender}>რეგისტრაცია</button>
          </div>
        </form>
      </div>
    </>
  );
}
