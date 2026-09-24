import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../../api/client';
import type { ClinicSettings } from '../../api/types';
import { ErrorBox, Field, Loading, useToast } from '../../components/ui';

const EMPTY: ClinicSettings = { name: '', address: '', phone: '', email: '', director_name: '', director_title: 'დირექტორი', consent_methods: ['paper', 'electronic'] };

export default function Clinic() {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['clinic'], queryFn: () => api<ClinicSettings>('/settings/clinic'), retry: false });
  const [f, setF] = useState<ClinicSettings>(EMPTY);
  useEffect(() => { if (q.data) setF({ ...EMPTY, ...q.data, phone: q.data.phone ?? '', email: q.data.email ?? '' }); }, [q.data]);
  const missing = q.error instanceof ApiError && q.error.status === 404;
  const set = (k: keyof ClinicSettings) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const m = useMutation({
    mutationFn: () => api('/settings/clinic', { method: 'PUT', body: { ...f, phone: f.phone || undefined, email: f.email || undefined } }),
    onSuccess: () => { toast.show('შენახულია'); void qc.invalidateQueries({ queryKey: ['clinic'] }); },
  });
  if (q.isLoading) return <Loading />;
  return (
    <div className="content">
      <form className="card card-pad" style={{ maxWidth: 760, display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 14 }} onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <div style={{ gridColumn: '1 / -1' }} className="stack">
          <h2>კლინიკის რეკვიზიტები</h2>
          <span className="hint">იბეჭდება ფორმა №IV-100/ა-ზე (პუნქტები 1 და 19).</span>
          {missing && <div className="alert warn">რეკვიზიტები ჯერ შევსებული არ არის — ფორმა 100 ვერ გაიცემა.</div>}
        </div>
        <div style={{ gridColumn: '1 / -1' }}><Field label="დაწესებულების დასახელება" htmlFor="cn" required><input id="cn" className="input" value={f.name} onChange={set('name')} required /></Field></div>
        <div style={{ gridColumn: '1 / -1' }}><Field label="მისამართი" htmlFor="ca" required><input id="ca" className="input" value={f.address} onChange={set('address')} required /></Field></div>
        <Field label="ტელეფონი" htmlFor="cp"><input id="cp" className="input mono" value={f.phone ?? ''} onChange={set('phone')} /></Field>
        <Field label="ელ-ფოსტა" htmlFor="ce"><input id="ce" className="input" type="email" value={f.email ?? ''} onChange={set('email')} /></Field>
        <Field label="ხელმძღვანელი (სახელი, გვარი)" htmlFor="cd" required><input id="cd" className="input" value={f.director_name} onChange={set('director_name')} required /></Field>
        <Field label="თანამდებობა" htmlFor="ct"><input id="ct" className="input" value={f.director_title} onChange={set('director_title')} /></Field>
        <div style={{ gridColumn: '1 / -1' }} className="stack">
          <h2 style={{ marginTop: 10 }}>თანხმობის ხელმოწერის მეთოდები</h2>
          {(['electronic', 'paper'] as const).map((mth) => (
            <label key={mth} className="row"><input type="checkbox" checked={f.consent_methods?.includes(mth) ?? false}
              onChange={(e) => { const cur = f.consent_methods ?? []; const next = e.target.checked ? [...cur, mth] : cur.filter((x) => x !== mth); if (next.length) setF({ ...f, consent_methods: next }); }} />
              {mth === 'electronic' ? 'ელექტრონული — ხელმოწერა ტაბლეტზე / ხელმოწერის პადზე' : 'ქაღალდი — დაბეჭდილი ფორმა, ხელმოწერა, სკანის ატვირთვა'}</label>
          ))}
        </div>
        <div style={{ gridColumn: '1 / -1' }}><ErrorBox error={m.error ?? (missing ? null : q.error)} /></div>
        <div style={{ gridColumn: '1 / -1' }} className="row"><button className="btn primary" type="submit" disabled={m.isPending} style={{ marginLeft: 'auto' }}>შენახვა</button></div>
      </form>
      {toast.node}
    </div>
  );
}
