import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api, can, openBlob } from '../../api/client';
import type { DxDevice, DxItem, RadBoard } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { DxStatusChip } from '../../components/DxStatusChip';
import { ErrorBox, Loading, Modal, useToast } from '../../components/ui';
import { age, dayTitle, genderShort, hhmm, localISO, MODALITY_KA, shiftDay, todayISO, tsDate } from '../../lib/format';
import { ContrastChip, errCode, PatientLine, Urgent } from './common';

const PX = 1.6;   // პიქსელი წუთზე
const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const hm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const BLOCK: Record<string, [string, string]> = {
  scheduled: ['var(--info-weak)', 'var(--info-line)'], arrived: ['var(--warn-weak)', 'var(--warn-line)'],
  performed: ['var(--ok-weak)', 'var(--ok-line)'], in_progress: ['var(--ok-weak)', 'var(--ok-line)'], validated: ['var(--surface-2)', 'var(--line)'],
};

/** რადიოლოგიის განრიგი: სვეტები = აპარატები; მარცხნივ — დასაგეგმი კვლევები. აირჩიე კვლევა → დააჭირე თავისუფალ დროს */
export default function Schedule({ section = 'radiology' }: { section?: 'radiology' | 'endoscopy' }) {
  const qc = useQueryClient(); const toast = useToast(); const { user } = useAuth();
  const [date, setDate] = useState(todayISO());
  const [picked, setPicked] = useState<DxItem | null>(null);
  const [open, setOpen] = useState<DxItem | null>(null);
  const write = can(user, 'admin', 'receptionist', 'radiographer', 'radiologist', 'endoscopist', 'endoscopy_nurse', 'manager');   // viewer — მხოლოდ ნახვა
  const q = useQuery({ queryKey: ['rad-board', section, date], queryFn: () => api<RadBoard>('/radiology/board', { query: { date, section } }), refetchInterval: 20_000 });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['rad-board'] }); void qc.invalidateQueries({ queryKey: ['rad-queue'] }); };

  const schedule = useMutation({
    mutationFn: async ({ it, dev, time }: { it: DxItem; dev: DxDevice; time: string }) => {
      const body = { device_id: dev.id, start: localISO(date, time) };
      try { return await api(`/dx-orders/${it.id}/schedule`, { method: 'PUT', body }); } catch (e) {
        if (errCode(e) === 'OUTSIDE_HOURS' && confirm(`${(e as Error).message}\n\nმაინც ჩავწეროთ?`)) return api(`/dx-orders/${it.id}/schedule`, { method: 'PUT', body: { ...body, outside_hours: true } });
        throw e;
      }
    },
    onSuccess: (r, v) => { if (r) toast.show(`${v.it.last_name} — ${v.dev.name}, ${v.time}`); setPicked(null); refresh(); },
  });

  const data = q.data;
  const range = useMemo(() => {
    if (!data?.devices.length) return { start: 9 * 60, end: 18 * 60 };
    return { start: Math.min(...data.devices.map((d) => toMin(d.work_start))), end: Math.max(...data.devices.map((d) => toMin(d.work_end))) };
  }, [data]);
  const H = (range.end - range.start) * PX;
  const isToday = date === todayISO();
  const nowMin = toMin(hhmm(new Date().toISOString()));

  const clickColumn = (dev: DxDevice, e: React.MouseEvent<HTMLDivElement>) => {
    if (!picked) return;
    if (!picked.modality || !dev.modalities.includes(picked.modality)) { toast.show(`${dev.name}: ${MODALITY_KA[picked.modality ?? ''] ?? picked.modality} არ სრულდება`); return; }
    const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
    const m = range.start + y / PX; const ws = toMin(dev.work_start);
    const snapped = ws + Math.floor((m - ws) / dev.slot_minutes) * dev.slot_minutes;
    schedule.mutate({ it: picked, dev, time: hm(Math.max(0, snapped)) });
  };

  return (
    <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex' }}>
      {/* დასაგეგმი */}
      <aside style={{ width: 320, flexShrink: 0, borderRight: '1px solid var(--line)', background: 'var(--surface)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div className="stack" style={{ padding: '14px 16px 8px', gap: 4 }}>
          <strong>დასაგეგმი {data ? `· ${data.unscheduled.length}` : ''}</strong>
          <span className="hint">აირჩიეთ კვლევა, შემდეგ დააჭირეთ განრიგში თავისუფალ დროს. ახალი პაციენტი — რეგისტრატურა → „ვიზიტი ექიმის გარეშე“.</span>
        </div>
        <div style={{ overflow: 'auto', flex: 1 }}>
          {data?.unscheduled.map((i) => (
            <button key={i.id} type="button" disabled={!write} onClick={() => setPicked(picked?.id === i.id ? null : i)}
              style={{ display: 'block', width: '100%', textAlign: 'left', border: 0, borderBottom: '1px solid var(--line-soft)', padding: '10px 16px', cursor: 'pointer', font: 'inherit',
                background: picked?.id === i.id ? 'var(--accent-weak)' : 'transparent', color: 'var(--ink)' }}>
              <div><strong>{i.last_name} {i.first_name}</strong> <span className="small muted">{genderShort(i.gender)} · {age(i.birth_date)} წ</span></div>
              <div className="small">{i.service_name}<Urgent it={i} /><ContrastChip it={i} /></div>
              <div className="small muted">{i.visit_kind === 'lab' ? (i.external_referral ? `გარე მიმართვა: ${i.external_referral}` : 'ექიმის გარეშე') : `ექიმი: ${i.ordered_by_name}`} · {tsDate(i.ordered_at)}</div>
              {i.collection_issue && <div className="small" style={{ color: 'var(--warn-ink)' }}>⚠ {i.collection_issue}</div>}
            </button>
          ))}
          {data && !data.unscheduled.length && <div className="empty small">დასაგეგმი კვლევა არ არის.</div>}
        </div>
      </aside>

      {/* განრიგი */}
      <div className="content grow" style={{ minWidth: 0 }}>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button className="btn sm" type="button" onClick={() => setDate(shiftDay(date, -1))} aria-label="წინა დღე">‹</button>
          <input type="date" className="input" style={{ width: 170, height: 34 }} value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
          <button className="btn sm" type="button" onClick={() => setDate(shiftDay(date, 1))} aria-label="შემდეგი დღე">›</button>
          {!isToday && <button className="btn sm" type="button" onClick={() => setDate(todayISO())}>დღეს</button>}
          <strong style={{ marginLeft: 8 }}>{dayTitle(date)}</strong>
          {picked && <span className="chip info" style={{ marginLeft: 'auto' }}>ირჩევთ დროს: {picked.last_name} — {picked.service_name} <button className="icon-btn" type="button" aria-label="გაუქმება" onClick={() => setPicked(null)}>×</button></span>}
        </div>
        <ErrorBox error={q.error ?? schedule.error} />
        {q.isLoading || !data ? <Loading /> : !data.devices.length ? <div className="card empty">{section === 'radiology' ? 'აპარატები' : 'ოთახები'} არ არის — ადმინისტრირება → აპარატები / ოთახები.</div> : (
          <div className="card" style={{ overflow: 'auto' }}>
            <div style={{ display: 'grid', gridTemplateColumns: `56px repeat(${data.devices.length}, minmax(170px, 1fr))`, minWidth: 56 + data.devices.length * 170 }}>
              <div style={{ position: 'sticky', top: 0, background: 'var(--surface)', zIndex: 2, borderBottom: '1px solid var(--line)' }} />
              {data.devices.map((d) => {
                const ok = !picked || (!!picked.modality && d.modalities.includes(picked.modality));
                return (
                  <div key={d.id} style={{ position: 'sticky', top: 0, zIndex: 2, background: 'var(--surface)', borderBottom: '1px solid var(--line)', borderLeft: '1px solid var(--line-soft)', padding: '8px 10px', opacity: ok ? 1 : 0.4 }}>
                    <strong>{d.name}</strong><div className="small muted">{d.modalities.map((m) => MODALITY_KA[m] ?? m).join(', ')}{d.room ? ` · ${d.room}` : ''} · {d.work_start.slice(0, 5)}–{d.work_end.slice(0, 5)}</div>
                  </div>
                );
              })}
              {/* საათების სვეტი */}
              <div style={{ position: 'relative', height: H }}>
                {Array.from({ length: Math.ceil((range.end - range.start) / 60) + 1 }, (_, k) => Math.ceil(range.start / 60) * 60 + k * 60).filter((m) => m <= range.end).map((m) => (
                  <span key={m} className="small muted mono" style={{ position: 'absolute', top: Math.max(2, (m - range.start) * PX - 7), right: 6 }}>{hm(m)}</span>))}
              </div>
              {data.devices.map((d) => {
                const ws = toMin(d.work_start); const we = toMin(d.work_end);
                const ok = !picked || (!!picked.modality && d.modalities.includes(picked.modality));
                const items = data.booked.filter((b) => b.device_id === d.id);
                return (
                  <div key={d.id} onClick={(e) => { if (e.target === e.currentTarget) clickColumn(d, e); }}
                    style={{ position: 'relative', height: H, borderLeft: '1px solid var(--line-soft)', cursor: picked && ok ? 'copy' : 'default', opacity: ok ? 1 : 0.45,
                      backgroundImage: `repeating-linear-gradient(to bottom, transparent 0, transparent ${d.slot_minutes * PX - 1}px, var(--line-soft) ${d.slot_minutes * PX - 1}px, var(--line-soft) ${d.slot_minutes * PX}px)`,
                      backgroundPosition: `0 ${(ws - range.start) * PX}px` }}>
                    {ws > range.start && <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: (ws - range.start) * PX, background: 'var(--surface-2)', pointerEvents: 'none' }} />}
                    {we < range.end && <div style={{ position: 'absolute', top: (we - range.start) * PX, left: 0, right: 0, bottom: 0, background: 'var(--surface-2)', pointerEvents: 'none' }} />}
                    {isToday && nowMin >= range.start && nowMin <= range.end && <div style={{ position: 'absolute', left: 0, right: 0, top: (nowMin - range.start) * PX, borderTop: '2px solid var(--danger)', pointerEvents: 'none', zIndex: 1 }} />}
                    {items.map((b) => {
                      const s = toMin(hhmm(b.scheduled_start!)); const e = toMin(hhmm(b.scheduled_end!));
                      const [bg, line] = BLOCK[b.status] ?? BLOCK.validated;
                      return (
                        <button key={b.id} type="button" onClick={() => setOpen(b)} title={`${b.last_name} ${b.first_name} — ${b.service_name}`}
                          style={{ position: 'absolute', top: (s - range.start) * PX + 1, height: Math.max((e - s) * PX - 2, 18), left: 3, right: 3, overflow: 'hidden', textAlign: 'left',
                            background: bg, border: `1px solid ${line}`, borderLeft: `4px solid ${b.priority === 'urgent' ? 'var(--danger)' : line}`, borderRadius: 6, padding: '2px 6px',
                            font: 'inherit', fontSize: 12, lineHeight: 1.25, cursor: 'pointer', color: 'var(--ink)', zIndex: 1 }}>
                          <span className="mono">{hhmm(b.scheduled_start!)}</span> <strong>{b.last_name} {b.first_name[0]}.</strong>
                          <div className="muted" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{b.service_name}</div>
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {toast.node}
      </div>
      {open && <BookingDialog it={open} write={write} canArrive={can(user, 'admin', 'receptionist', 'radiographer', 'endoscopy_nurse')} onMove={() => { setPicked(open); setOpen(null); }} onClose={() => { setOpen(null); refresh(); }} />}
    </div>
  );
}

function BookingDialog({ it, write, canArrive, onMove, onClose }: { it: DxItem; write: boolean; canArrive: boolean; onMove: () => void; onClose: () => void }) {
  const unschedule = useMutation({ mutationFn: () => api(`/dx-orders/${it.id}/schedule`, { method: 'DELETE' }), onSuccess: onClose });
  const arrive = useMutation({
    mutationFn: async () => {
      try { return await api(`/dx-orders/${it.id}/arrive`, { body: {} }); } catch (e) {
        if (errCode(e) === 'UNPAID' && confirm('კვლევა გადახდილი არ არის. მაინც მივიღოთ?')) return api(`/dx-orders/${it.id}/arrive`, { body: { unpaid_ack: true } });
        throw e;
      }
    },
    onSuccess: onClose,
  });
  const slip = useMutation({ mutationFn: () => openBlob(`/encounters/${it.encounter_id}/imaging-slip`) });
  const pending = it.status === 'scheduled';
  return (
    <Modal title={it.service_name} onClose={onClose} width={560}
      footer={<>
        {pending && <button className="btn" type="button" onClick={() => slip.mutate()}>ჩაწერის ფურცელი</button>}
        {pending && write && <button className="btn" type="button" onClick={onMove}>გადაწერა</button>}
        {pending && write && <button className="btn" type="button" style={{ color: 'var(--danger)' }} onClick={() => { if (confirm('მოვხსნათ ჩაწერა? კვლევა დაბრუნდება „დასაგეგმში“.')) unschedule.mutate(); }}>ჩაწერის მოხსნა</button>}
        <span className="grow" />
        {pending && write && canArrive && <button className="btn primary" type="button" disabled={arrive.isPending} onClick={() => arrive.mutate()}>პაციენტი მოვიდა</button>}
      </>}>
      <div className="stack" style={{ gap: 6 }}>
        <PatientLine it={it} />
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}><DxStatusChip status={it.status} /><Urgent it={it} /><ContrastChip it={it} /></div>
        <span>{it.device_name} · {tsDate(it.scheduled_start!)} {hhmm(it.scheduled_start!)}–{hhmm(it.scheduled_end!)} · <span className="mono">{it.accession_number}</span></span>
        <span className="small muted">{it.visit_kind === 'lab' ? (it.external_referral ? `გარე მიმართვა: ${it.external_referral}` : 'ექიმის გარეშე') : `ექიმი: ${it.ordered_by_name}`}{it.clinical_note ? ` · „${it.clinical_note}“` : ''}</span>
        {it.prep_instructions && <div className="alert info small">მომზადება: {it.prep_instructions}</div>}
        {it.collection_issue && <div className="alert warn small">{it.collection_issue}</div>}
        <ErrorBox error={unschedule.error ?? arrive.error ?? slip.error} />
      </div>
    </Modal>
  );
}
