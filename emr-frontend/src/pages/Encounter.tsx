import Form100Dialog from '../components/Form100Dialog';
import Form100History from '../components/Form100History';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { can, api, ApiError } from '../api/client';
import type { EncounterDetail, EncounterListItem } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import AllergyBanner from '../components/AllergyBanner';
import AllergyDialog from '../components/AllergyDialog';
import ConsentsPanel from '../components/ConsentsPanel';
import { CloseButton, ErrorBox, Loading, Modal, StatusChip } from '../components/ui';
import { age, genderShort, hhmm, money, tsDate } from '../lib/format';
import { Diagnoses, Notes, Referrals, VitalsStrip } from './encounter/Clinical';
import DiagnosticsPanel from './encounter/DiagnosticsPanel';
import Prescriptions from './encounter/Prescriptions';

export default function Encounter() {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const q = useQuery({ queryKey: ['encounter', id], queryFn: () => api<EncounterDetail>(`/encounters/${id}`) });
  const [dlg, setDlg] = useState<'discharge' | 'form100' | 'history' | 'allergy' | 'consent' | 'f100hist' | null>(null);

  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <div className="content"><ErrorBox error={q.error ?? 'ვიზიტი ვერ მოიძებნა'} /></div>;
  const e = q.data;
  const active = e.status === 'active';
  const isAttending = can(user, 'admin') || (can(user, 'doctor') && user!.id === e.attending_doctor_id);
  const canWrite = active && isAttending;
  const canVitals = active && (isAttending || can(user, 'nurse'));
  const openRefs = e.referrals.filter((r) => r.status === 'requested' || r.status === 'in_progress');
  const primary = e.diagnoses.find((d) => d.diagnosis_type === 'primary');
  const due = e.invoice ? Number(e.invoice.patient_share) - e.invoice.payments.reduce((s, p) => s + Number(p.amount), 0) : 0;

  return (
    <>
      <header className="topbar" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <h1>{e.patient.first_name} {e.patient.last_name}</h1>
          <span className="muted">{genderShort(e.patient.gender)} · {age(e.patient.birth_date)} წ · <span className="mono">{e.patient.personal_number ?? '—'}</span>{e.patient.blood_group ? ` · ${e.patient.blood_group}` : ''}</span>
          <StatusChip status={e.status} />
          {active && <span className="small muted">{hhmm(e.start_time)}-დან</span>}
          <div className="row" style={{ marginLeft: 'auto' }}>
            <button className="btn" type="button" onClick={() => setDlg('history')}>წინა ვიზიტები</button>
            <button className="btn" type="button" onClick={() => setDlg('consent')}>ინფორმირებული თანხმობა</button>
            {(isAttending && (active || e.status === 'discharged')) && <button className="btn" type="button" onClick={() => setDlg('form100')}>ფორმა №100/ა</button>}
            {can(user, 'admin', 'doctor', 'receptionist') && <button className="btn" type="button" onClick={() => setDlg('f100hist')}>ფ.№100 — ისტორია</button>}
            {canWrite && <button className="btn primary" type="button" onClick={() => setDlg('discharge')}>ვიზიტის დასრულება</button>}
          </div>
        </div>
        <AllergyBanner allergies={e.patient.allergies} chronic={e.patient.chronic_conditions} onAdd={active ? () => setDlg('allergy') : undefined} />
      </header>

      <div className="content" style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 16 }}>
        <div className="grow stack" style={{ gap: 14 }}>
          {!active && <div className="alert info">ვიზიტი {e.status === 'discharged' ? `დასრულებულია ${e.end_time ? tsDate(e.end_time) : ''}` : e.status === 'planned' ? 'გადახდას ელოდება' : 'გაუქმებულია'} — ჩანაწერები მხოლოდ სანახავად.</div>}
          {active && !isAttending && can(user, 'doctor') && <div className="alert info">თქვენ არ ხართ ამ ვიზიტის მკურნალი ექიმი — ჩანაწერები მხოლოდ სანახავად.</div>}
          <VitalsStrip e={e} canAdd={canVitals} />
          <Notes key={e.id} e={e} canWrite={canWrite} />
          <Prescriptions e={e} canWrite={canWrite} />
        </div>
        <aside className="stack" style={{ width: 420, flexShrink: 0, gap: 14 }}>
          <Diagnoses e={e} canWrite={canWrite} />
          <DiagnosticsPanel encounterId={e.id} canWrite={canWrite} />
          <Referrals e={e} canWrite={canWrite} />
          {active && (
            <section className="card card-pad stack" aria-label="დასრულებისთვის">
              <h2>დასრულებისთვის</h2>
              <Check ok={!!primary} text={primary ? `ძირითადი დიაგნოზი: ${primary.icd10_code}` : 'ძირითადი დიაგნოზი არ არის მითითებული'} />
              <Check ok={openRefs.length === 0} warn text={openRefs.length ? `${openRefs.length} მიმართვა დაუსრულებელია` : 'ღია მიმართვა არ არის'} />
              <Check ok={due <= 0} info text={due > 0 ? `ნაშთი ${money(due)} — დასრულებას არ ბლოკავს` : 'ინვოისი გადახდილია'} />
            </section>
          )}
        </aside>
      </div>

      {dlg === 'discharge' && <DischargeDialog e={e} onClose={() => setDlg(null)} />}
      {dlg === 'form100' && <Form100Dialog encounterId={e.id} onClose={() => setDlg(null)} />}
      {dlg === 'f100hist' && <Form100History patientId={e.patient.id} currentEncounterId={e.id} onClose={() => setDlg(null)} />}
      {dlg === 'history' && <HistoryDrawer patientId={e.patient.id} currentId={e.id} onClose={() => setDlg(null)} />}
      {dlg === 'allergy' && <AllergyDialog patientId={e.patient.id} onClose={() => setDlg(null)} />}
      {dlg === 'consent' && (
        <Modal title="თანხმობები ამ ვიზიტზე" onClose={() => setDlg(null)} width={980}>
          <ConsentsPanel patientId={e.patient.id} encounterId={e.id} scope="encounter" canSign={active && (isAttending || can(user, 'nurse'))} />
        </Modal>
      )}
    </>
  );
}

function Check({ ok, text, warn, info }: { ok: boolean; text: string; warn?: boolean; info?: boolean }) {
  const color = ok ? 'var(--ok-ink)' : info ? 'var(--muted)' : warn ? 'var(--warn-ink)' : 'var(--danger)';
  return (
    <div className="row small" style={{ color }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">{ok ? <path d="M5 12l5 5 9-10" /> : <><circle cx="12" cy="12" r="9" /><path d="M12 8v5" /></>}</svg>
      <span>{text}</span>
    </div>
  );
}

function DischargeDialog({ e, onClose }: { e: EncounterDetail; onClose: () => void }) {
  const qc = useQueryClient(); const { user } = useAuth();
  const [force, setForce] = useState(false);
  const m = useMutation({
    mutationFn: () => api<{ balance_due: string }>(`/encounters/${e.id}/discharge`, { method: 'POST', query: { force: force || undefined } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['encounter', e.id] }); void qc.invalidateQueries({ queryKey: ['encounters'] }); onClose(); },
  });
  const openRefs = m.error instanceof ApiError && m.error.code === 'OPEN_REFERRALS_EXIST';
  return (
    <Modal title="ვიზიტის დასრულება" onClose={onClose} width={520}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={m.isPending} onClick={() => m.mutate()}>დასრულება</button></>}>
      <p style={{ margin: 0 }}>დასრულების შემდეგ ჩანაწერების შეცვლა აღარ იქნება შესაძლებელი. ფორმა №100/ა შეგიძლიათ გასცეთ დასრულების შემდეგაც.</p>
      <ErrorBox error={m.error} />
      {openRefs && can(user, 'admin') && <label className="row"><input type="checkbox" checked={force} onChange={(x) => setForce(x.target.checked)} /> მაინც დასრულება (ადმინისტრატორი)</label>}
    </Modal>
  );
}

function HistoryDrawer({ patientId, currentId, onClose }: { patientId: string; currentId: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['encounters', 'patient', patientId], queryFn: () => api<EncounterListItem[]>('/encounters', { query: { patient_id: patientId } }) });
  const rows = (q.data ?? []).filter((x) => x.id !== currentId && x.status !== 'cancelled');
  return (
    <div className="overlay" style={{ placeItems: 'stretch end', padding: 0 }} onMouseDown={(x) => { if (x.target === x.currentTarget) onClose(); }}>
      <aside role="dialog" aria-modal="true" aria-label="წინა ვიზიტები" style={{ width: 'min(520px, 100%)', background: 'var(--surface)', height: '100%', display: 'flex', flexDirection: 'column' }}>
        <div className="modal-head"><h2 className="grow">წინა ვიზიტები</h2><CloseButton onClick={onClose} /></div>
        <div className="modal-body">
          {q.isLoading && <Loading />}
          {q.data && rows.length === 0 && <div className="empty">წინა ვიზიტი არ არის.</div>}
          {rows.map((v) => (
            <article key={v.id} className="card card-pad stack" style={{ gap: 6 }}>
              <div className="row"><strong className="mono">{tsDate(v.start_time)}</strong><span className="small muted grow">{v.doctor_name}</span><StatusChip status={v.status} /></div>
              <div className="small">{v.primary_diagnosis ?? <span className="muted">დიაგნოზი არ არის</span>}</div>
              {v.chief_complaint && <div className="small muted">{v.chief_complaint}</div>}
              <Link className="btn sm" style={{ alignSelf: 'flex-start' }} to={`/encounters/${v.id}`} onClick={onClose}>სრულად ნახვა</Link>
            </article>
          ))}
        </div>
      </aside>
    </div>
  );
}
