import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api, ApiError, openBlob } from '../../api/client';
import type { AllergyCheck, DxItem, DxSection, DxService } from '../../api/types';
import { DxStatusChip, FlagBadge } from '../../components/DxStatusChip';
import { ErrorBox, Modal, useDebounced } from '../../components/ui';
import { hhmm, money, refRange, SECTION_KA, tsDate, unitFmt } from '../../lib/format';

/** ვიზიტის დიაგნოსტიკა: შეკვეთა + სტატუსები + შედეგები (ლაბ. — მხოლოდ ვალიდაციის შემდეგ) */
export default function DiagnosticsPanel({ encounterId, canWrite }: { encounterId: string; canWrite: boolean }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['dx-items', encounterId], queryFn: () => api<DxItem[]>(`/encounters/${encounterId}/dx-orders`), refetchInterval: 30_000 });
  const cancel = useMutation({
    mutationFn: (id: string) => api(`/dx-orders/${id}/cancel`, { body: { reason: 'ექიმის გადაწყვეტილებით' } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['dx-items', encounterId] }); void qc.invalidateQueries({ queryKey: ['encounter', encounterId] }); },
  });
  const report = useMutation({ mutationFn: () => openBlob(`/encounters/${encounterId}/lab-report`) });
  const items = (q.data ?? []).filter((i) => i.status !== 'cancelled');
  const hasValidatedLab = items.some((i) => i.section === 'lab' && i.status === 'validated');

  return (
    <section className="card card-pad stack">
      <div className="row">
        <h2 className="grow">დიაგნოსტიკა</h2>
        {hasValidatedLab && <button className="btn sm" type="button" onClick={() => report.mutate()}>ლაბ. ბლანკი</button>}
        {canWrite && <button className="btn sm primary" type="button" onClick={() => setOpen(true)}>+ კვლევა</button>}
      </div>
      {!items.length && <span className="muted small">კვლევა არ არის შეკვეთილი.</span>}
      {(['lab', 'radiology', 'endoscopy'] as DxSection[]).map((sec) => {
        const list = items.filter((i) => i.section === sec);
        if (!list.length) return null;
        return (
          <div key={sec} className="stack" style={{ gap: 6 }}>
            <span className="small muted" style={{ fontWeight: 600 }}>{SECTION_KA[sec]}</span>
            {list.map((i) => {
              const abnormal = i.results.filter((r) => r.flag && r.flag !== 'N').length;
              const done = i.status === 'validated';
              return (
                <div key={i.id} style={{ border: '1px solid var(--line-soft)', borderRadius: 8, padding: '8px 10px' }}>
                  <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
                    <button type="button" onClick={() => setExpanded(expanded === i.id ? null : i.id)} disabled={!done}
                      style={{ border: 0, background: 'none', padding: 0, font: 'inherit', fontWeight: 600, fontSize: 13, textAlign: 'left', cursor: done ? 'pointer' : 'default', color: 'var(--ink)', flex: 1, minWidth: 160 }}>
                      {done ? (expanded === i.id ? '▾ ' : '▸ ') : ''}{i.service_name}
                    </button>
                    {i.priority === 'urgent' && <span className="chip danger">სასწრაფო</span>}
                    {done && sec === 'lab' && (abnormal ? <span className="chip warn">{abnormal} გადახრა</span> : <span className="chip ok">ნორმა</span>)}
                    {done && sec !== 'lab' && i.is_critical && <span className="chip danger">კრიტიკული</span>}
                    {done && sec !== 'lab' && (i.report_version ?? 1) > 1 && <span className="chip warn">შესწორებული</span>}
                    <DxStatusChip status={i.status} />
                    {canWrite && (i.status === 'ordered' || i.status === 'scheduled') && <button className="icon-btn" type="button" aria-label={`გაუქმება: ${i.service_name}`} onClick={() => cancel.mutate(i.id)}>×</button>}
                  </div>
                  {i.performed_by === 'external' && <div className="small muted">გარე ლაბორატორია{i.external_lab ? `: ${i.external_lab}` : ''}</div>}
                  {sec === 'radiology' && i.status === 'scheduled' && i.scheduled_start && <div className="small muted">ჩაწერილია: {tsDate(i.scheduled_start)} {hhmm(i.scheduled_start)} · {i.device_name}</div>}
                  {sec !== 'lab' && !done && i.collection_issue && <div className="small" style={{ color: 'var(--warn-ink)' }}>⚠ {i.collection_issue}</div>}
                  {expanded === i.id && done && sec === 'lab' && (
                    <table className="table" style={{ marginTop: 6 }}>
                      <tbody>{i.results.map((r) => (
                        <tr key={r.analyte_id}>
                          <td className="small">{r.name}</td>
                          <td className="mono small" style={{ fontWeight: r.flag && r.flag !== 'N' ? 700 : 400, color: r.flag === 'LL' || r.flag === 'HH' ? 'var(--danger)' : undefined }}>
                            {r.value_num !== null ? Number(r.value_num) : r.value_text} <span className="muted">{unitFmt(r.unit)}</span></td>
                          <td className="small muted">{refRange(r)}</td>
                          <td><FlagBadge flag={r.flag} /></td>
                        </tr>))}</tbody>
                    </table>
                  )}
                  {expanded === i.id && done && sec !== 'lab' && <>
                    <div className="small" style={{ whiteSpace: 'pre-wrap', marginTop: 6 }}>{i.report_text}</div>
                    {i.report_version && <button className="btn sm" type="button" style={{ marginTop: 6 }} onClick={() => void openBlob(`/dx-orders/${i.id}/report.pdf`)}>ბლანკი (PDF)</button>}
                  </>}
                  {done && i.validated_at && expanded === i.id && <div className="small muted" style={{ marginTop: 4 }}>{tsDate(i.validated_at)} · {i.validated_by_name}</div>}
                </div>
              );
            })}
          </div>
        );
      })}
      <ErrorBox error={q.error ?? cancel.error ?? report.error} />
      {open && <OrderDialog encounterId={encounterId} onClose={() => setOpen(false)} />}
    </section>
  );
}

/**
 * კვლევის შეკვეთა: ექიმის ვიზიტიდან (encounterId) ან ლაბორატორიული ვიზიტი რეგისტრატურიდან (patientId, ექიმის გარეშე).
 */
export function OrderDialog({ encounterId, patientId, onClose, onLabVisit }: { encounterId?: string; patientId?: string; onClose: () => void; onLabVisit?: (encounterId: string) => void }) {
  const qc = useQueryClient();
  const labVisit = !!patientId && !encounterId;
  const [referral, setReferral] = useState('');
  const [section, setSection] = useState<DxSection>('lab');
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<Record<string, DxService>>({});
  const [urgent, setUrgent] = useState(false);
  const [note, setNote] = useState('');
  const [conflict, setConflict] = useState<AllergyCheck | null>(null);
  const [reason, setReason] = useState('');
  const ds = useDebounced(search.trim(), 200);
  const cat = useQuery({ queryKey: ['dx-catalog', section], queryFn: () => api<DxService[]>('/dx/catalog', { query: { section } }), staleTime: 60_000 });
  const groups = useMemo(() => {
    const list = (cat.data ?? []).filter((s) => !ds || s.name.toLowerCase().includes(ds.toLowerCase()) || s.code.toLowerCase().includes(ds.toLowerCase()));
    const m = new Map<string, DxService[]>(); list.forEach((s) => m.set(s.group_name, [...(m.get(s.group_name) ?? []), s]));
    return [...m.entries()];
  }, [cat.data, ds]);
  const sel = Object.values(picked);
  const total = sel.reduce((s, x) => s + Number(x.base_price), 0);
  const m = useMutation({
    mutationFn: () => {
      const items = sel.map((s) => ({ service_id: s.id, priority: urgent ? 'urgent' : 'routine', note: note || undefined }));
      return labVisit
        ? api<{ encounter_id: string }>('/lab-visits', { body: { patient_id: patientId, items, external_referral: referral.trim() || undefined, allergy_override_reason: reason.trim() || undefined } })
        : api<{ encounter_id?: string }>(`/encounters/${encounterId}/dx-orders`, { body: { items, allergy_override_reason: reason.trim() || undefined } });
    },
    onSuccess: (r) => {
      if (labVisit) { void qc.invalidateQueries({ queryKey: ['encounters'] }); onLabVisit?.((r as { encounter_id: string }).encounter_id); return; }
      void qc.invalidateQueries({ queryKey: ['dx-items', encounterId] }); void qc.invalidateQueries({ queryKey: ['encounter', encounterId] }); onClose();
    },
    onError: (e) => { if (e instanceof ApiError && e.code === 'ALLERGY_CONFLICT') setConflict(e.body?.check as AllergyCheck); },
  });
  const toggle = (s: DxService) => setPicked((p) => { const n = { ...p }; if (n[s.id]) delete n[s.id]; else n[s.id] = s; return n; });

  return (
    <Modal title={labVisit ? 'დიაგნოსტიკური ვიზიტი (ექიმის გარეშე) — ლაბორატორია / რადიოლოგია' : 'კვლევის შეკვეთა'} onClose={onClose} width={900}
      footer={<>
        <span className="grow small muted">{sel.length ? `${sel.length} კვლევა · ${money(total)}` : 'აირჩიეთ კვლევები'}</span>
        <button className="btn" type="button" onClick={onClose}>გაუქმება</button>
        <button className="btn primary" type="button" disabled={!sel.length || m.isPending || (!!conflict && reason.trim().length < 10)} onClick={() => m.mutate()}>{labVisit ? 'გახსნა და სალარო' : 'შეკვეთა'}</button>
      </>}>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <div className="seg" role="group" aria-label="განყოფილება">
          {(labVisit ? ['lab', 'radiology'] as DxSection[] : ['lab', 'radiology', 'endoscopy'] as DxSection[]).map((s) => <button key={s} type="button" aria-pressed={section === s} onClick={() => setSection(s)}>{SECTION_KA[s]}</button>)}
        </div>
        <input aria-label="ძებნა" className="input grow" style={{ height: 38 }} placeholder="ძებნა კატალოგში" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: 16, minHeight: 300 }}>
        <div style={{ maxHeight: 420, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 10 }}>
          {groups.map(([g, list]) => (
            <div key={g}>
              <div className="small muted" style={{ padding: '8px 12px', background: 'var(--surface-2)', fontWeight: 600, position: 'sticky', top: 0 }}>{g}</div>
              {list.map((s) => (
                <label key={s.id} className="row" style={{ padding: '8px 12px', borderBottom: '1px solid var(--line-soft)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={!!picked[s.id]} onChange={() => toggle(s)} />
                  <span className="grow">{s.name}{s.contrast && <span className="chip warn" style={{ marginLeft: 6, height: 20 }}>კონტრასტი</span>}{s.performed_by === 'external' && <span className="chip" style={{ marginLeft: 6, height: 20 }}>გარე</span>}</span>
                  <span className="mono small muted">{Number(s.base_price) > 0 ? money(s.base_price) : 'ფასი —'}</span>
                </label>
              ))}
            </div>
          ))}
          {cat.data && !groups.length && <div className="empty">ვერ მოიძებნა.</div>}
        </div>
        <div className="stack">
          <span className="label">არჩეული</span>
          {sel.map((s) => <div key={s.id} className="row small"><span className="grow">{s.name}</span><button className="icon-btn" type="button" aria-label="მოხსნა" onClick={() => toggle(s)}>×</button></div>)}
          <label className="row"><input type="checkbox" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} /> სასწრაფო (cito)</label>
          <textarea aria-label="კლინიკური შენიშვნა" className="textarea" rows={3} placeholder="შენიშვნა (მაგ. უზმოზე, საეჭვო დიაგნოზი)" value={note} onChange={(e) => setNote(e.target.value)} />
          {labVisit && <input aria-label="გარე მიმართვა" className="input" style={{ height: 38 }} placeholder="მიმართვა: ექიმი / დაწესებულება (თუ აქვს)" value={referral} onChange={(e) => setReferral(e.target.value)} />}
        </div>
      </div>
      {conflict && (
        <div className="alert danger stack" role="alert" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          <strong>ალერგია კონტრასტზე: {conflict.matches.map((x) => `${x.substance}`).join(', ')}</strong>
          <textarea className="textarea" rows={2} placeholder="დასაბუთება (მინ. 10 სიმბოლო) — მაგ. პრემედიკაცია, რადიოლოგთან შეთანხმებით" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      )}
      {m.error && !(m.error instanceof ApiError && m.error.code === 'ALLERGY_CONFLICT') && <ErrorBox error={m.error} />}
    </Modal>
  );
}
