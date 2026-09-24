import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../../api/client';
import type { AllergyCheck, EncounterDetail } from '../../api/types';
import { ErrorBox, useDebounced, WarnIcon } from '../../components/ui';
import { SEVERITY_KA } from '../../lib/format';

const ROUTES: [string, string][] = [['oral', 'პერორალური'], ['iv', 'ვენაში'], ['im', 'კუნთში'], ['sc', 'კანქვეშ'], ['topical', 'ადგილობრივი'], ['inhal', 'ინჰალაცია'], ['rectal', 'რექტალური']];
const ROUTE_KA = Object.fromEntries(ROUTES);

/** დანიშნულება + ალერგიის ცოცხალი შემოწმება (სერვერიც დამოუკიდებლად ამოწმებს) */
export default function Prescriptions({ e, canWrite }: { e: EncounterDetail; canWrite: boolean }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ medication_name: '', dosage: '', route: 'oral', frequency: '', duration_days: '' });
  const [ack, setAck] = useState(false); const [reason, setReason] = useState(''); const [confirm, setConfirm] = useState(false);
  const med = useDebounced(f.medication_name.trim(), 350);
  const check = useQuery({
    queryKey: ['allergy-check', e.patient.id, med],
    queryFn: () => api<AllergyCheck>(`/patients/${e.patient.id}/allergy-check`, { body: { medication_name: med } }),
    enabled: canWrite && med.length >= 3,
  });
  const [serverCheck, setServerCheck] = useState<AllergyCheck | null>(null);
  const chk = serverCheck ?? (med.length >= 3 ? check.data : undefined);

  const reset = () => { setF({ medication_name: '', dosage: '', route: 'oral', frequency: '', duration_days: '' }); setAck(false); setReason(''); setConfirm(false); setServerCheck(null); };
  const add = useMutation({
    mutationFn: () => api(`/encounters/${e.id}/prescriptions`, { body: {
      ...f, duration_days: f.duration_days ? Number(f.duration_days) : undefined,
      allergy_ack: ack || undefined, allergy_override_reason: reason.trim() || undefined, allergy_confirm_severe: confirm || undefined,
    } }),
    onSuccess: () => { reset(); void qc.invalidateQueries({ queryKey: ['encounter', e.id] }); },
    onError: (err) => { if (err instanceof ApiError && err.code === 'ALLERGY_CONFLICT') setServerCheck(err.body?.check as AllergyCheck); },
  });
  const del = useMutation({
    mutationFn: (id: string) => api(`/encounters/${e.id}/prescriptions/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['encounter', e.id] }),
  });

  const needReason = !!chk?.requires_reason; const needConfirm = !!chk?.requires_severe_confirmation; const needAck = !!chk?.requires_ack && !needReason;
  const blocked = (needReason && reason.trim().length < 10) || (needConfirm && !confirm) || (needAck && !ack);
  const submit = (ev: FormEvent) => { ev.preventDefault(); if (!blocked) add.mutate(); };
  const tone = chk?.level === 'block' || chk?.level === 'warning_reason' ? 'danger' : chk?.level === 'warning' ? 'warn' : 'info';

  return (
    <section className="card">
      <div className="card-head"><h2>დანიშნულება</h2></div>
      {e.prescriptions.length > 0 && (
        <table className="table">
          <thead><tr><th>მედიკამენტი</th><th>დოზა</th><th>გზა</th><th>სიხშირე</th><th>ხანგრძლ.</th><th /></tr></thead>
          <tbody>
            {e.prescriptions.map((r) => (
              <tr key={r.id}>
                <td><strong>{r.medication_name}</strong>
                  {r.allergy_alert_level !== 'none' && <div className="small" style={{ color: r.allergy_alert_level === 'info' ? 'var(--muted)' : 'var(--danger-ink)' }}>⚠ ალერგიის {r.allergy_override_reason ? `კონფლიქტი გადალახულია: ${r.allergy_override_reason}` : 'გაფრთხილება'}</div>}
                </td>
                <td>{r.dosage}</td><td>{ROUTE_KA[r.route] ?? r.route}</td><td>{r.frequency}</td><td>{r.duration_days ? `${r.duration_days} დღე` : '—'}</td>
                <td style={{ textAlign: 'right' }}>{canWrite && <button className="btn sm" type="button" aria-label={`წაშლა: ${r.medication_name}`} onClick={() => del.mutate(r.id)}>×</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {e.prescriptions.length === 0 && !canWrite && <div className="empty">დანიშნულება არ არის.</div>}
      {canWrite && (
        <form onSubmit={submit} style={{ padding: 12, borderTop: e.prescriptions.length ? '1px solid var(--line-soft)' : undefined, background: 'var(--surface-2)', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 0.8fr 1.4fr 1.1fr 72px auto', gap: 8 }}>
            <input aria-label="მედიკამენტი" className={`input${chk && chk.level !== 'none' && chk.level !== 'info' ? ' invalid' : ''}`} placeholder="მედიკამენტი" value={f.medication_name} onChange={(x) => { setF({ ...f, medication_name: x.target.value }); setServerCheck(null); }} required />
            <input aria-label="დოზა" className="input" placeholder="დოზა" value={f.dosage} onChange={(x) => setF({ ...f, dosage: x.target.value })} required />
            <select aria-label="გზა" className="select" value={f.route} onChange={(x) => setF({ ...f, route: x.target.value })}>{ROUTES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            <input aria-label="სიხშირე" className="input" placeholder="სიხშირე" value={f.frequency} onChange={(x) => setF({ ...f, frequency: x.target.value })} required />
            <input aria-label="დღე" className="input" placeholder="დღე" inputMode="numeric" value={f.duration_days} onChange={(x) => setF({ ...f, duration_days: x.target.value.replace(/\D/g, '') })} />
            <button className="btn primary" type="submit" disabled={add.isPending || blocked}>დამატება</button>
          </div>
          {chk && chk.level !== 'none' && (
            <div className={`alert ${tone}`} role="alert">
              <WarnIcon color={tone === 'danger' ? 'var(--danger)' : undefined} />
              <div className="stack grow" style={{ gap: 8 }}>
                {chk.matches.map((m) => (
                  <span key={m.allergy_id}>
                    <strong>{m.allergy_type === 'intolerance' ? 'აუტანლობა' : 'ალერგია'}: {m.substance}</strong> ({SEVERITY_KA[m.severity]}) — {m.match === 'direct' ? (m.group ? `იგივე ჯგუფი: ${m.group}` : 'პირდაპირი დამთხვევა') : `ჯვარედინი რეაქციის რისკი: ${m.group}`}
                  </span>
                ))}
                {needReason && (
                  <label className="stack" style={{ gap: 4 }}>
                    <span className="label">დასაბუთება (მინ. 10 სიმბოლო) — ჩაიწერება აუდიტში</span>
                    <textarea className="textarea" rows={2} value={reason} onChange={(x) => setReason(x.target.value)} placeholder="მაგ. დესენსიბილიზაციის პროტოკოლი, ალერგოლოგთან შეთანხმებით" />
                  </label>
                )}
                {needConfirm && <label className="row"><input type="checkbox" checked={confirm} onChange={(x) => setConfirm(x.target.checked)} /> ვადასტურებ, რომ ვიცი მძიმე ალერგიული რეაქციის რისკი</label>}
                {needAck && <label className="row"><input type="checkbox" checked={ack} onChange={(x) => setAck(x.target.checked)} /> გაფრთხილება ვნახე</label>}
                {chk.unreviewed_groups && <span className="small">ალერგენული ჯგუფების სია ჯერ ფარმაკოლოგის მიერ დამტკიცებული არ არის.</span>}
              </div>
            </div>
          )}
          {add.error && !(add.error instanceof ApiError && add.error.code === 'ALLERGY_CONFLICT') && <ErrorBox error={add.error} />}
        </form>
      )}
    </section>
  );
}
