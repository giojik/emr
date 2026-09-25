import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { Appointment, Doctor, EncounterListItem } from '../api/types';
import AppointmentDialog from '../components/AppointmentDialog';
import PatientSearch from '../components/PatientSearch';
import { ErrorBox, Loading, Modal, StatusChip } from '../components/ui';
import { dayTitle, hhmm, money, shiftDay, todayISO } from '../lib/format';

const SLOT_MIN = 20;
const DAY_START = 9 * 60;
const DAY_END = 19 * 60;
const SLOTS = Array.from({ length: (DAY_END - DAY_START) / SLOT_MIN }, (_, i) => {
  const m = DAY_START + i * SLOT_MIN;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
});
const ACTIVE = ['scheduled', 'confirmed', 'checked_in', 'completed', 'no_show'];
const BOX: Record<string, { bg: string; line: string; ink: string }> = {
  scheduled: { bg: '#FFFFFF', line: '1px solid var(--info-line)', ink: 'var(--info-ink)' },
  confirmed: { bg: '#FFFFFF', line: '1px solid var(--info-line)', ink: 'var(--info-ink)' },
  checked_in: { bg: 'var(--warn-weak)', line: '1px solid var(--warn-line)', ink: 'var(--warn-ink)' },
  completed: { bg: 'var(--line-soft)', line: '1px solid #D6D3C9', ink: 'var(--ink-2)' },
  no_show: { bg: 'var(--bg)', line: '1px dashed #B8B4A8', ink: 'var(--muted)' },
};

const pref = (k: string, d: string) => { try { return localStorage.getItem(`emr.reception.${k}`) ?? d; } catch { return d; } };
const savePref = (k: string, v: string) => { try { localStorage.setItem(`emr.reception.${k}`, v); } catch { /* private mode */ } };

export default function Reception() {
  const nav = useNavigate();
  const [date, setDate] = useState(todayISO());
  const [view, setViewState] = useState<'cols' | 'list'>(pref('view', 'cols') as 'cols' | 'list');
  const [dept, setDeptState] = useState(pref('dept', 'all'));
  const [newAppt, setNewAppt] = useState<{ doctorId?: string; time?: string } | null>(null);
  const [selected, setSelected] = useState<Appointment | null>(null);
  const setView = (v: 'cols' | 'list') => { setViewState(v); savePref('view', v); };
  const setDept = (v: string) => { setDeptState(v); savePref('dept', v); };

  const doctors = useQuery({ queryKey: ['doctors'], queryFn: () => api<Doctor[]>('/doctors') });
  const appts = useQuery({ queryKey: ['appointments', date], queryFn: () => api<Appointment[]>('/appointments', { query: { date } }), refetchInterval: 30_000 });
  const open = useQuery({ queryKey: ['encounters', 'open', todayISO()], queryFn: () => api<EncounterListItem[]>('/encounters', { query: { status: 'planned,active', date: todayISO() } }), refetchInterval: 30_000 });

  const depts = useMemo(() => {
    const m = new Map<string, string>();
    doctors.data?.forEach((d) => d.department_id && m.set(d.department_id, d.department_name ?? '—'));
    return [...m.entries()];
  }, [doctors.data]);
  const shownDoctors = (doctors.data ?? []).filter((d) => dept === 'all' || d.department_id === dept);
  const dayAppts = (appts.data ?? []).filter((a) => ACTIVE.includes(a.status) && shownDoctors.some((d) => d.id === a.doctor_id));

  return (
    <>
      <header className="topbar">
        <div className="grow" style={{ maxWidth: 560 }}>
          <PatientSearch onSelect={(p) => nav(`/patients/${p.id}`)} />
        </div>
        <div className="row" style={{ marginLeft: 'auto' }}>
          <Link className="btn" to="/patients/new">+ ახალი პაციენტი</Link>
          <button className="btn primary" type="button" onClick={() => setNewAppt({})}>+ ჩაწერა</button>
        </div>
      </header>

      <div className="content" style={{ flexDirection: 'row', gap: 20, overflow: 'hidden' }}>
        <section className="grow stack" style={{ gap: 12, minHeight: 0 }}>
          <div className="row" style={{ alignItems: 'baseline', gap: 14 }}>
            <h1>დღის განრიგი</h1>
            <span className="muted">{dayTitle(date)}</span>
            <div className="row" style={{ marginLeft: 'auto', gap: 6 }}>
              <button className="btn sm" type="button" aria-label="წინა დღე" onClick={() => setDate(shiftDay(date, -1))}>‹</button>
              <button className="btn sm" type="button" onClick={() => setDate(todayISO())}>დღეს</button>
              <button className="btn sm" type="button" aria-label="შემდეგი დღე" onClick={() => setDate(shiftDay(date, 1))}>›</button>
            </div>
          </div>

          <div className="row" style={{ flexWrap: 'wrap' }}>
            <div className="seg" role="group" aria-label="ხედი">
              <button type="button" aria-pressed={view === 'cols'} onClick={() => setView('cols')}>სვეტები · ექიმები</button>
              <button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')}>სია · დროით</button>
            </div>
            <div className="row" role="group" aria-label="განყოფილება" style={{ gap: 6, flexWrap: 'wrap' }}>
              <button type="button" className={`btn sm${dept === 'all' ? ' dark' : ''}`} onClick={() => setDept('all')}>ყველა · {doctors.data?.length ?? 0}</button>
              {depts.map(([id, name]) => <button key={id} type="button" className={`btn sm${dept === id ? ' dark' : ''}`} onClick={() => setDept(id)}>{name}</button>)}
            </div>
          </div>

          <ErrorBox error={appts.error ?? doctors.error} />
          {(appts.isLoading || doctors.isLoading) ? <Loading /> : view === 'cols' ? (
            <div className="card" style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
              {shownDoctors.length === 0 ? <div className="empty">ამ განყოფილებაში აქტიური ექიმი არ არის.</div> : (
                <div style={{ display: 'grid', gridTemplateColumns: `64px repeat(${shownDoctors.length}, 220px)`, gridTemplateRows: `56px repeat(${SLOTS.length}, 56px)`, width: 'max-content', minWidth: '100%' }}>
                  <div style={{ position: 'sticky', top: 0, left: 0, zIndex: 3, background: 'var(--surface-2)', borderBottom: '1px solid var(--line)' }} />
                  {shownDoctors.map((d, i) => (
                    <div key={d.id} style={{ gridRow: 1, gridColumn: i + 2, position: 'sticky', top: 0, zIndex: 2, background: 'var(--surface-2)', borderLeft: '1px solid var(--line-soft)', borderBottom: '1px solid var(--line)', padding: '8px 12px' }}>
                      <div style={{ fontWeight: 600 }}>{d.first_name[0]}. {d.last_name}</div>
                      <div className="small muted">{d.specialty ?? '—'} · {money(d.consultation_price)}</div>
                    </div>
                  ))}
                  {SLOTS.map((s, r) => (
                    <div key={s} className="mono small muted" style={{ gridRow: r + 2, gridColumn: 1, position: 'sticky', left: 0, zIndex: 1, background: 'var(--surface)', padding: 8, borderBottom: '1px solid #F0EEE8', borderRight: '1px solid var(--line-soft)' }}>{s}</div>
                  ))}
                  {SLOTS.flatMap((s, r) => shownDoctors.map((d, c) => (
                    <button key={`${s}-${d.id}`} type="button" aria-label={`ჩაწერა: ${d.last_name}, ${s}`} onClick={() => setNewAppt({ doctorId: d.id, time: s })}
                      style={{ gridRow: r + 2, gridColumn: c + 2, border: 0, borderLeft: '1px solid var(--line-soft)', borderBottom: '1px solid #F0EEE8', background: 'transparent', cursor: 'pointer' }} />
                  )))}
                  {dayAppts.map((a) => {
                    const col = shownDoctors.findIndex((d) => d.id === a.doctor_id);
                    const [h, m] = hhmm(a.scheduled_start).split(':').map(Number);
                    const start = Math.floor((h * 60 + m - DAY_START) / SLOT_MIN);
                    const span = Math.max(1, Math.round((new Date(a.scheduled_end).getTime() - new Date(a.scheduled_start).getTime()) / 60000 / SLOT_MIN));
                    if (col < 0 || start < 0 || start >= SLOTS.length) return null;
                    const st = BOX[a.status];
                    return (
                      <button key={a.id} type="button" onClick={() => setSelected(a)}
                        style={{ gridColumn: col + 2, gridRow: `${start + 2} / span ${span}`, zIndex: 1, margin: 4, borderRadius: 8, background: st.bg, border: st.line, padding: '6px 10px', textAlign: 'left', font: 'inherit', cursor: 'pointer', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 2, overflow: 'hidden' }}>
                        <span style={{ fontSize: 13, fontWeight: 600, textDecoration: a.status === 'no_show' ? 'line-through' : undefined, color: a.status === 'no_show' ? 'var(--muted)' : undefined }}>{a.patient_first_name} {a.patient_last_name}</span>
                        <span style={{ fontSize: 12, color: st.ink }}>{hhmm(a.scheduled_start)} · <StatusText s={a.status} /></span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <div className="card" style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
              {dayAppts.length === 0 ? <div className="empty">ამ დღეს ჩაწერა არ არის. <button className="btn sm" type="button" onClick={() => setNewAppt({})}>+ ჩაწერა</button></div> : (
                <table className="table">
                  <thead><tr><th>დრო</th><th>პაციენტი</th><th>ექიმი</th><th>სტატუსი</th><th /></tr></thead>
                  <tbody>
                    {[...dayAppts].sort((a, b) => a.scheduled_start.localeCompare(b.scheduled_start)).map((a) => (
                      <tr key={a.id} className="clickable" onClick={() => setSelected(a)}>
                        <td className="mono">{hhmm(a.scheduled_start)}</td>
                        <td><strong>{a.patient_first_name} {a.patient_last_name}</strong><div className="small muted mono">{a.personal_number}</div></td>
                        <td>{a.doctor_name}</td>
                        <td><StatusChip status={a.status} /></td>
                        <td style={{ textAlign: 'right' }}>{['scheduled', 'confirmed'].includes(a.status) && <CheckInButton a={a} />}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </section>

        <aside className="stack" style={{ width: 400, flexShrink: 0, minHeight: 0 }}>
          <div className="row" style={{ alignItems: 'baseline' }}><h2>ღია ვიზიტები</h2><span className="small muted">დღეს · {open.data?.length ?? 0}</span></div>
          <div className="card" style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
            <ErrorBox error={open.error} />
            {open.data?.length === 0 && <div className="empty">ღია ვიზიტი არ არის.</div>}
            {open.data && open.data.length > 0 && (
              <table className="table">
                <thead><tr><th>პაციენტი</th><th className="num">ნაშთი</th><th /></tr></thead>
                <tbody>
                  {open.data.map((e) => {
                    const due = Number(e.patient_share ?? 0) - Number(e.paid_amount ?? 0);
                    return (
                      <tr key={e.id}>
                        <td><strong>{e.patient_first_name} {e.patient_last_name}</strong><div className="small muted">{e.visit_kind === 'lab' ? 'ლაბორატორია' : e.doctor_name} · {hhmm(e.start_time)}</div></td>
                        <td className="num">{money(due)}</td>
                        <td style={{ textAlign: 'right' }}>
                          {e.status === 'planned' || due > 0
                            ? <Link className="btn sm primary" to={`/cashier/${e.id}`}>გადახდა</Link>
                            : <StatusChip status={e.status} />}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </aside>
      </div>

      {newAppt && <AppointmentDialog date={date} doctorId={newAppt.doctorId} time={newAppt.time} onClose={() => setNewAppt(null)} />}
      {selected && <AppointmentActions a={selected} onClose={() => setSelected(null)} />}
    </>
  );
}

const StatusText = ({ s }: { s: string }) => <>{({ scheduled: 'დაჯავშნილი', confirmed: 'დადასტურებული', checked_in: 'მოსულია', completed: 'დასრულებული', no_show: 'არ გამოცხადდა' } as Record<string, string>)[s] ?? s}</>;

function CheckInButton({ a }: { a: Appointment }) {
  const qc = useQueryClient(); const nav = useNavigate();
  const m = useMutation({
    mutationFn: () => api<{ encounter_id: string }>(`/appointments/${a.id}/check-in`, { method: 'POST' }),
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ['appointments'] }); void qc.invalidateQueries({ queryKey: ['encounters'] }); nav(`/cashier/${r.encounter_id}`); },
  });
  return <button className="btn sm" type="button" disabled={m.isPending} title={m.error instanceof Error ? m.error.message : undefined}
    onClick={(e) => { e.stopPropagation(); m.mutate(); }}>Check-in</button>;
}

function AppointmentActions({ a, onClose }: { a: Appointment; onClose: () => void }) {
  const qc = useQueryClient(); const nav = useNavigate();
  const done = () => { void qc.invalidateQueries({ queryKey: ['appointments'] }); void qc.invalidateQueries({ queryKey: ['encounters'] }); };
  const status = useMutation({ mutationFn: (s: string) => api(`/appointments/${a.id}`, { method: 'PATCH', body: { status: s } }), onSuccess: () => { done(); onClose(); } });
  const checkIn = useMutation({
    mutationFn: () => api<{ encounter_id: string }>(`/appointments/${a.id}/check-in`, { method: 'POST' }),
    onSuccess: (r) => { done(); nav(`/cashier/${r.encounter_id}`); },
  });
  const canEdit = ['scheduled', 'confirmed'].includes(a.status);
  return (
    <Modal title={`${a.patient_first_name} ${a.patient_last_name}`} onClose={onClose} width={480}
      footer={canEdit ? <>
        <button className="btn" type="button" onClick={() => status.mutate('no_show')}>არ გამოცხადდა</button>
        <button className="btn" type="button" onClick={() => status.mutate('cancelled')}>გაუქმება</button>
        <button className="btn primary" type="button" disabled={checkIn.isPending} onClick={() => checkIn.mutate()}>Check-in</button>
      </> : a.encounter_id ? <Link className="btn primary" to={`/cashier/${a.encounter_id}`}>სალარო</Link> : undefined}>
      <div className="stack">
        <div className="row"><span className="muted" style={{ width: 90 }}>დრო</span><span className="mono">{hhmm(a.scheduled_start)}–{hhmm(a.scheduled_end)}</span></div>
        <div className="row"><span className="muted" style={{ width: 90 }}>ექიმი</span><span>{a.doctor_name}</span></div>
        <div className="row"><span className="muted" style={{ width: 90 }}>სტატუსი</span><StatusChip status={a.status} /></div>
        {a.reason && <div className="row"><span className="muted" style={{ width: 90 }}>მიზეზი</span><span>{a.reason}</span></div>}
        <div className="row"><span className="muted" style={{ width: 90 }}>ტელეფონი</span><span className="mono">{a.phone_number}</span></div>
        <Link to={`/patients/${a.patient_id}`}>პაციენტის ბარათი</Link>
        {a.status === 'scheduled' && <button className="btn sm" type="button" style={{ alignSelf: 'flex-start' }} onClick={() => status.mutate('confirmed')}>დადასტურება</button>}
        <ErrorBox error={status.error ?? checkIn.error} />
      </div>
    </Modal>
  );
}
