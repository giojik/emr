import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import type { OverrideRow } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Loading } from '../../components/ui';
import { hhmm, localISO, shiftDay, todayISO, tsDate } from '../../lib/format';

const LEVEL: Record<string, [string, string]> = { block: ['danger', 'მძიმე — დაბლოკილი'], warning_reason: ['danger', 'დასაბუთებით'], warning: ['warn', 'გაფრთხილება'] };

export default function Overrides() {
  const { user } = useAuth();
  const [from, setFrom] = useState(shiftDay(todayISO(), -30)); const [to, setTo] = useState(todayISO());
  const q = useQuery({ queryKey: ['overrides', from, to], queryFn: () => api<OverrideRow[]>('/reports/allergy-overrides', { query: { from: localISO(from, '00:00'), to: localISO(shiftDay(to, 1), '00:00') } }) });
  const byDoctor = Object.entries((q.data ?? []).reduce<Record<string, number>>((m, r) => { const k = r.doctor_name ?? '—'; m[k] = (m[k] ?? 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]);
  return (
    <div className="content">
      <div className="row">
        <label className="row small">დან <input className="input" type="date" style={{ width: 170 }} value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="row small">მდე <input className="input" type="date" style={{ width: 170 }} value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <span className="muted" style={{ marginLeft: 'auto' }}>{q.data?.length ?? 0} შემთხვევა</span>
      </div>
      {byDoctor.length > 0 && <div className="row small" style={{ flexWrap: 'wrap' }}><span className="muted">ექიმების მიხედვით:</span>{byDoctor.map(([d, n]) => <span key={d} className="chip">{d}: {n}</span>)}</div>}
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : (
        <div className="card">
          {q.data?.length === 0 ? <div className="empty">ამ პერიოდში გაფრთხილების გადალახვა არ ყოფილა.</div> : (
            <table className="table">
              <thead><tr><th>დრო</th><th>ექიმი</th><th>პაციენტი</th><th>მედიკამენტი</th><th>დონე</th><th>ალერგია</th><th>დასაბუთება</th></tr></thead>
              <tbody>{q.data?.map((r) => {
                const [cls, label] = LEVEL[r.allergy_alert_level] ?? ['', r.allergy_alert_level];
                return (
                  <tr key={r.id}>
                    <td className="mono small">{tsDate(r.created_at)} {hhmm(r.created_at)}</td>
                    <td>{r.doctor_name}</td>
                    <td>{user?.role === 'admin' ? <Link to={`/encounters/${r.encounter_id}`}>{r.patient_first_name} {r.patient_last_name}</Link> : `${r.patient_first_name} ${r.patient_last_name}`}</td>
                    <td><strong>{r.medication_name}</strong> <span className="small muted">{r.dosage}</span></td>
                    <td><span className={`chip ${cls}`}>{label}</span></td>
                    <td className="small">{r.allergy_matches?.map((m) => `${m.substance}${m.group ? ` (${m.group})` : ''}`).join('; ')}</td>
                    <td className="small" style={{ maxWidth: 280 }}>{r.allergy_override_reason ?? <span className="muted">— (მხოლოდ დადასტურება)</span>}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
