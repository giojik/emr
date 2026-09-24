import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { EncounterListItem } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { ErrorBox, Loading, StatusChip } from '../components/ui';
import { dayTitle, hhmm, shiftDay, todayISO } from '../lib/format';

/** ექიმის რიგი (mine) ან ყველა აქტიური ვიზიტი (ექთანი/ადმინი) */
export default function DoctorQueue({ mine }: { mine?: boolean }) {
  const { user } = useAuth(); const nav = useNavigate();
  const [date, setDate] = useState(todayISO());
  const q = useQuery({
    queryKey: ['encounters', 'queue', mine ? user?.id : 'all', date],
    queryFn: () => api<EncounterListItem[]>('/encounters', { query: { date, doctor_id: mine ? user?.id : undefined, status: mine ? 'planned,active,discharged' : 'active,discharged' } }),
    refetchInterval: 20_000,
  });
  const order: Record<string, number> = { active: 0, planned: 1, discharged: 2 };
  const rows = [...(q.data ?? [])].sort((a, b) => order[a.status] - order[b.status] || a.start_time.localeCompare(b.start_time));
  return (
    <>
      <header className="topbar">
        <h1>{mine ? 'ჩემი ვიზიტები' : 'ვიზიტები'}</h1><span className="muted">{dayTitle(date)}</span>
        <div className="row" style={{ marginLeft: 'auto', gap: 6 }}>
          <button className="btn sm" type="button" aria-label="წინა დღე" onClick={() => setDate(shiftDay(date, -1))}>‹</button>
          <button className="btn sm" type="button" onClick={() => setDate(todayISO())}>დღეს</button>
          <button className="btn sm" type="button" aria-label="შემდეგი დღე" onClick={() => setDate(shiftDay(date, 1))}>›</button>
        </div>
      </header>
      <div className="content">
        <ErrorBox error={q.error} />
        {q.isLoading ? <Loading /> : rows.length === 0 ? <div className="card empty">ამ დღეს ვიზიტი არ არის.</div> : (
          <div className="card">
            <table className="table">
              <thead><tr><th>დრო</th><th>პაციენტი</th>{!mine && <th>ექიმი</th>}<th>ჩივილი</th><th>ძირითადი დიაგნოზი</th><th>სტატუსი</th></tr></thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id} className={e.status === 'planned' ? undefined : 'clickable'} onClick={() => e.status !== 'planned' && nav(`/encounters/${e.id}`)}>
                    <td className="mono">{hhmm(e.start_time)}</td>
                    <td><strong>{e.patient_first_name} {e.patient_last_name}</strong><div className="small muted mono">{e.personal_number}</div></td>
                    {!mine && <td>{e.doctor_name}</td>}
                    <td className="muted">{e.chief_complaint ?? '—'}</td>
                    <td>{e.primary_diagnosis ?? <span className="muted">—</span>}</td>
                    <td>{e.status === 'planned' ? <span className="chip warn">გადახდას ელოდება</span> : <StatusChip status={e.status} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
