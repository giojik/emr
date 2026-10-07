import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, openBlob } from '../api/client';
import type { Form100Draft } from '../api/types';
import { dateGe, tsDate } from '../lib/format';
import { ErrorBox, Field, Loading, Modal, StatusChip } from './ui';

type Doc = { id: string; document_number: string; status: string; generated_at: string; revoke_reason?: string | null };
const TEXT_KEYS = ['recipient', 'workplace', 'anamnesis', 'investigations', 'treatment', 'past_diseases', 'recommendations', 'state_on_referral', 'state_on_discharge'] as const;

/**
 * ფორმა №IV-100/ა — ამბულატორია და სტაციონარი (0045).
 *   მონახაზი EMR-დან ავტომატურად (სტაციონარი: ეპიკრიზი → მიმღები გასინჯვა / დღიურები → დანიშნულებები / კვლევები); ექიმი ასწორებს და გასცემს.
 *   გაცემულის ჩასწორება: გაუქმება (მიზეზით) → ფორმა ივსება წინა ცნობის მონაცემებით → ხელახლა გაცემა (ახალი ნომერი).
 */
export default function Form100Dialog({ encounterId, onClose }: { encounterId: string; onClose: () => void }) {
  const draft = useQuery({ queryKey: ['form100-draft', encounterId], queryFn: () => api<Form100Draft>(`/encounters/${encounterId}/form100/draft`) });
  const docs = useQuery({ queryKey: ['documents', encounterId], queryFn: () => api<Doc[]>('/documents', { query: { encounter_id: encounterId, type: 'form_100' } }) });
  const [f, setF] = useState<Record<string, string>>({});
  const [revoke, setRevoke] = useState<Doc | null>(null); const [reason, setReason] = useState('');
  const val = (k: (typeof TEXT_KEYS)[number]) => f[k] ?? (draft.data?.[k] as string | null) ?? '';
  const set = (k: string) => (x: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF({ ...f, [k]: x.target.value });
  const [conclusion, setConclusion] = useState('');
  const d = draft.data;
  const m = useMutation({
    mutationFn: () => api<{ id: string }>(`/encounters/${encounterId}/form100`, { body: {
      recipient: val('recipient') || undefined, workplace: val('workplace') || undefined, conclusion: conclusion || undefined,
      course: f.course || undefined, anamnesis: val('anamnesis'), investigations: val('investigations'), treatment: val('treatment'),
      past_diseases: val('past_diseases'), recommendations: val('recommendations') || undefined,
      ...(d?.inpatient && { state_on_referral: val('state_on_referral'), state_on_discharge: val('state_on_discharge') }),
    } }),
    onSuccess: async (r) => { await openBlob(`/documents/${r.id}/pdf`); void docs.refetch(); void draft.refetch(); setF({}); },
  });
  const rv = useMutation({
    mutationFn: (id: string) => api(`/documents/${id}/revoke`, { body: { reason: reason.trim() } }),
    onSuccess: () => {
      // ჩასწორება: ფორმა ივსება გაუქმებული ცნობის მონაცემებით
      const p = d?.last_issued?.payload as Record<string, unknown> | undefined;
      if (p) {
        const next: Record<string, string> = {};
        for (const k of TEXT_KEYS) if (typeof p[k] === 'string') next[k] = p[k] as string;
        if (typeof p.course === 'string') next.course = p.course;
        setF(next); if (typeof p.conclusion === 'string') setConclusion(p.conclusion);
      }
      setRevoke(null); setReason(''); void docs.refetch(); void draft.refetch();
    },
  });
  const issued = (docs.data ?? []).filter((x) => x.status === 'issued');
  const noDx = d && d.diagnosis.primary.length === 0 && !conclusion;
  const ta = (k: (typeof TEXT_KEYS)[number], label: string, rows = 3, full = false) => (
    <div style={full ? { gridColumn: '1 / -1' } : undefined}><Field label={label} htmlFor={`f1-${k}`}><textarea id={`f1-${k}`} className="textarea" rows={rows} value={val(k)} onChange={set(k)} /></Field></div>);
  return (
    <Modal title={`ფორმა №IV-100/ა — ცნობა ჯანმრთელობის მდგომარეობის შესახებ${d?.inpatient ? ' (სტაციონარი)' : ''}`} onClose={onClose} width={900}
      footer={<><button className="btn" type="button" onClick={onClose}>დახურვა</button>
        <button className="btn primary" type="button" disabled={!d || !!noDx || m.isPending} onClick={() => m.mutate()}>{issued.length ? 'კიდევ ერთის გაცემა' : 'გაცემა და ბეჭდვა'}</button></>}>
      {draft.isLoading ? <Loading /> : d && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 14 }}>
          {issued.length > 0 && <div className="alert warn" style={{ gridColumn: '1 / -1' }}>
            ამ შემთხვევაზე უკვე გაცემულია: {issued.map((x) => x.document_number).join(', ')}. ჩასწორებისთვის — გააუქმეთ (ქვემოთ), ფორმა შეივსება წინა ცნობით და გასცემთ ხელახლა.</div>}
          {d.sources.length > 0 && <div className="small muted" style={{ gridColumn: '1 / -1' }}>ავტომატურად შევსებულია: {d.sources.join(' · ')}. ყველა ველი რედაქტირებადია.</div>}
          <div style={{ gridColumn: '1 / -1' }}><Field label="2. დაწესებულება, სადაც იგზავნება ცნობა" htmlFor="rc"><input id="rc" className="input" value={val('recipient')} onChange={set('recipient')} /></Field></div>
          <Field label="7. სამუშაო ადგილი და თანამდებობა" htmlFor="wp"><input id="wp" className="input" value={val('workplace')} onChange={set('workplace')} /></Field>
          <Field label="13. მიმდინარეობა" htmlFor="cs">
            <select id="cs" className="select" value={f.course ?? ''} onChange={set('course')}><option value="">—</option><option value="acute">მწვავე</option><option value="subacute">ქვემწვავე</option><option value="chronic">ქრონიკული</option><option value="recurrent">მორეციდივე</option></select>
          </Field>
          {d.inpatient && d.dates && <div className="small" style={{ gridColumn: '1 / -1' }}>
            <span className="label">8. თარიღები</span> სტაციონარში გაგზავნის: {d.dates.sent_to_hospital ? dateGe(d.dates.sent_to_hospital) : '—'} · მოთავსების: {d.dates.admitted ? dateGe(d.dates.admitted) : '—'} · გაწერის: {d.dates.discharged ? dateGe(d.dates.discharged) : '—'}</div>}
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <span className="label">9. დასკვნა / დიაგნოზი</span>
            <div className="seg" role="group" aria-label="დასკვნა" style={{ width: 'max-content' }}>
              <button type="button" aria-pressed={conclusion === ''} onClick={() => setConclusion('')}>დიაგნოზი</button>
              <button type="button" aria-pressed={conclusion === 'healthy'} onClick={() => setConclusion('healthy')}>ჯანმრთელი</button>
              <button type="button" aria-pressed={conclusion === 'practically_healthy'} onClick={() => setConclusion('practically_healthy')}>პრაქტიკულად ჯანმრთელი</button>
            </div>
            {d.diagnosis.primary.map((x) => <span key={x.code}><span className="muted">ძირითადი:</span> {x.title} <span className="mono">({x.code})</span></span>)}
            {d.diagnosis.secondary.map((x) => <span key={x.code}><span className="muted">თანმხლები:</span> {x.title} <span className="mono">({x.code})</span></span>)}
            {d.diagnosis.complications.map((x) => <span key={x.code}><span className="muted">გართულება:</span> {x.title} <span className="mono">({x.code})</span></span>)}
            {noDx && <span className="hint err">ძირითადი დიაგნოზი არ არის — აირჩიეთ დასკვნა ან დაამატეთ დიაგნოზი.</span>}
          </div>
          {ta('past_diseases', '10. გადატანილი დაავადებები')}{ta('anamnesis', '11. მოკლე ანამნეზი')}
          {ta('investigations', '12. ჩატარებული დიაგნოსტიკური გამოკვლევები და კონსულტაციები', 4, true)}
          {ta('treatment', '14. ჩატარებული მკურნალობა', 3, true)}
          {d.inpatient && <>{ta('state_on_referral', '15. მდგომარეობა სტაციონარში გაგზავნისას')}{ta('state_on_discharge', '16. მდგომარეობა სტაციონარიდან გაწერისას')}</>}
          {ta('recommendations', '17. სამკურნალო და შრომითი რეკომენდაციები', 2, true)}
          <div style={{ gridColumn: '1 / -1' }}><ErrorBox error={m.error ?? rv.error} /></div>
          {docs.data && docs.data.length > 0 && (
            <div style={{ gridColumn: '1 / -1' }} className="stack">
              <span className="label">ამ შემთხვევაზე გაცემული</span>
              {docs.data.map((doc) => (
                <div key={doc.id} className="row" style={{ gap: 8 }}><span className="mono">{doc.document_number}</span><span className="small muted grow">{tsDate(doc.generated_at)}{doc.revoke_reason ? ` · გაუქმდა: ${doc.revoke_reason}` : ''}</span>
                  <StatusChip status={doc.status === 'issued' ? 'paid' : 'cancelled'} />
                  <button className="btn sm" type="button" onClick={() => void openBlob(`/documents/${doc.id}/pdf`)}>PDF</button>
                  {doc.status === 'issued' && <button className="btn sm" type="button" onClick={() => setRevoke(doc)}>ჩასწორება (გაუქმება)</button>}</div>
              ))}
            </div>
          )}
          {revoke && <div className="card card-pad stack" style={{ gridColumn: '1 / -1', gap: 8 }}>
            <strong>გაუქმება — {revoke.document_number}</strong>
            <span className="small muted">QR ვერიფიკაცია აჩვენებს „გაუქმებულს“. ფორმა შეივსება ამ ცნობის მონაცემებით — ჩაასწორეთ და გასცემთ ახალი ნომრით.</span>
            <textarea className="textarea" rows={2} aria-label="გაუქმების მიზეზი" placeholder="მიზეზი (მინ. 5 სიმბოლო)" value={reason} onChange={(e) => setReason(e.target.value)} />
            <div className="row" style={{ gap: 8 }}><button className="btn" type="button" onClick={() => setRevoke(null)}>არა</button>
              <button className="btn danger" type="button" disabled={reason.trim().length < 5 || rv.isPending} onClick={() => rv.mutate(revoke.id)}>გაუქმება და ჩასწორება</button></div>
          </div>}
        </div>
      )}
    </Modal>
  );
}
