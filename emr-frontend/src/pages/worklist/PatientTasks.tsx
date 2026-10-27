import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import { ErrorBox } from '../../components/ui';
import { NewTaskDialog, TaskDialog, dueLabel } from './TaskDialogs';
import { PRIORITY_CHIP, PRIORITY_KA, STATUS_CHIP, STATUS_KA, useWorklistEnabled, type Task } from './types';

/** 0081 (I1): პაციენტთან მიბმული ხელით დავალებები (ხილვადი — შემქმნელს / შემსრულებელს / ჯგუფს / ხელმძღვანელს); „არ არის დანიშნულება“ */
export default function PatientTasks({ patientId, patientName, encounterId }: { patientId: string; patientName: string; encounterId?: string | null }) {
  const wl = useWorklistEnabled();
  const [creating, setCreating] = useState(false); const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['wl-patient', patientId], queryFn: () => api<Task[]>('/worklist/tasks', { query: { box: 'patient', patient_id: patientId, status: 'active' } }), enabled: wl.enabled });
  if (!wl.enabled) return null;
  return (
    <section className="card">
      <div className="card-pad row"><strong className="grow">დავალებები (ღია)</strong>
        <span className="small muted">არ არის დანიშნულება</span>
        <button type="button" className="btn sm" onClick={() => setCreating(true)}>+ დავალება</button></div>
      <ErrorBox error={q.error} />
      {!q.data?.length ? <div className="empty small">ღია დავალება არ არის.</div> : <table className="table small"><tbody>
        {q.data.map((t) => <tr key={t.id} className="clickable" onClick={() => setOpen(t.id)}>
          <td className="mono">{t.task_no}</td>
          <td><strong>{t.title}</strong> {t.priority !== 'normal' && <span className={`chip ${PRIORITY_CHIP[t.priority]}`}>{PRIORITY_KA[t.priority]}</span>}</td>
          <td>{t.target_label}</td><td><span className={`chip ${STATUS_CHIP[t.status] ?? ''}`}>{STATUS_KA[t.status]}</span></td>
          <td className="mono" style={{ color: t.overdue ? 'var(--danger-ink)' : undefined }}>{dueLabel(t.due_at)}</td></tr>)}
      </tbody></table>}
      {creating && <NewTaskDialog onClose={() => setCreating(false)} patient={{ id: patientId, name: patientName }} encounterId={encounterId} />}
      {open && <TaskDialog id={open} onClose={() => setOpen(null)} />}
    </section>
  );
}
