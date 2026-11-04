import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import { ErrorBox, Loading } from '../../components/ui';
import { useNow } from './Er';
import { type Board, dur, hm, minsSince, minsUntil, onColor, SPOT_KA, STATUS_KA, WAIT_KA } from './types';

/**
 * ER-ის TV ეკრანი (0087): კედლის ეკრანისთვის — მენიუს გარეშე, დიდი შრიფტი, ავტომატური განახლება (board_refresh_sec).
 * პაციენტის სახელი — მოდულის პარამეტრით (tv_patient_names: ინიციალები / სრული); ჩივილი / პირადი ნომერი / ტელეფონი არ ჩანს.
 */
export default function ErTv() {
  const [sp] = useSearchParams();
  const dep = sp.get('department_id') ?? '';
  const q = useQuery({ queryKey: ['er-board-tv', dep], queryFn: () => api<Board>('/er/board', { query: { department_id: dep, tv: 1 } }),
    refetchInterval: (x) => ((x.state.data?.settings.board_refresh_sec ?? 30) * 1000) });
  const now = useNow(15_000);
  const t = now + (q.data ? new Date(q.data.now).getTime() - q.dataUpdatedAt : 0);
  const c = q.data?.counts;
  const full = () => { void document.documentElement.requestFullscreen?.().catch(() => undefined); };
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }} data-testid="er-tv">
      <header className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
        <h1 className="grow" style={{ margin: 0, fontSize: 30 }}>გადაუდებელი დახმარება</h1>
        {c && <span style={{ fontSize: 20 }}>ER-ში <strong>{c.total}</strong> · ტრიაჟის მოლოდინში <strong>{c.waiting_triage}</strong> · ექიმის მოლოდინში <strong>{c.waiting_doctor}</strong>
          {c.overdue > 0 && <> · <strong style={{ color: 'var(--danger)' }}>ვადაგადაცილებული {c.overdue}</strong></>}</span>}
        <span className="mono" style={{ fontSize: 26 }}>{new Date(t).toLocaleTimeString('ka-GE', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Tbilisi' })}</span>
        {!document.fullscreenElement && <button className="btn sm" type="button" onClick={full}>სრული ეკრანი</button>}
      </header>
      <ErrorBox error={q.error} />
      {!q.data ? <Loading /> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
          {q.data.items.length === 0 && <div className="empty" style={{ fontSize: 22 }}>ER-ში პაციენტი არ არის</div>}
          {q.data.items.map((i) => {
            const late = i.timers.triage_overdue || i.timers.doctor_overdue || i.timers.retriage_overdue;
            const due = !i.first_triage_at ? i.timers.triage_due_at : !i.doctor_at ? i.timers.doctor_due_at : null;
            const left = minsUntil(due, t);
            return (
              <div key={i.encounter_id} className="card" style={{ display: 'flex', overflow: 'hidden', borderColor: late ? 'var(--danger)' : undefined, borderWidth: late ? 3 : 1 }}>
                <div style={{ width: 56, background: i.triage?.color ?? 'var(--line-soft)', color: i.triage ? onColor(i.triage.color) : 'var(--ink)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28, fontWeight: 700 }}>
                  {i.triage?.level ?? '?'}</div>
                <div className="stack grow" style={{ gap: 2, padding: '10px 14px' }}>
                  <div className="row"><strong className="grow" style={{ fontSize: 22 }}>{i.spot?.name ?? '—'}</strong><span style={{ fontSize: 20 }}>{i.patient.name}</span></div>
                  <span style={{ fontSize: 15 }}>{STATUS_KA[i.status]}{i.spot ? ` · ${SPOT_KA[i.spot.kind]}` : ''} · {i.patient.age_estimated ? '~' : ''}{i.patient.age} წ.</span>
                  <span style={{ fontSize: 15 }}>ER-ში {dur(minsSince(i.arrived_at, t))} · შემოვიდა {hm(i.arrived_at)}{i.doctor ? ` · ${i.doctor.name}` : ''}</span>
                  {left !== null && <span style={{ fontSize: 16, fontWeight: 600, color: left < 0 ? 'var(--danger)' : 'var(--ink-2)' }}>
                    {!i.first_triage_at ? 'ტრიაჟამდე' : 'ექიმამდე'}: {left < 0 ? `გადაცილება ${dur(-left)}` : `დარჩა ${dur(left)}`}</span>}
                  {i.waiting_for.length > 0 && <span style={{ fontSize: 15 }}>მოლოდინი: {i.waiting_for.map((w) => WAIT_KA[w] ?? w).join(', ')}</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {q.data && q.data.on_duty.length > 0 && <div style={{ fontSize: 18 }}>მორიგე ექიმი: {q.data.on_duty.map((d) => d.name).join(', ')}</div>}
    </div>
  );
}
