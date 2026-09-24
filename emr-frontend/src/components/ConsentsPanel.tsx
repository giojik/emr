import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api, openBlob } from '../api/client';
import type { ClinicSettings, ConsentType, PatientConsent } from '../api/types';
import { tsDate } from '../lib/format';
import { UploadDialog } from './DocumentsPanel';
import SignaturePad, { type SignaturePadHandle } from './SignaturePad';
import { ErrorBox, Field, Modal } from './ui';

const STATUS: Record<string, [string, string]> = {
  granted: ['ok', 'გაცემულია'], refused: ['danger', 'უარი'], revoked: ['', 'გაუქმებულია'], missing: ['warn', 'არ არის'],
};

/** თანხმობები: patient scope — პაციენტის ბარათზე; encounter scope — ვიზიტზე (encounterId) */
export default function ConsentsPanel({ patientId, encounterId, scope, canSign }: { patientId: string; encounterId?: string; scope: 'patient' | 'encounter'; canSign: boolean }) {
  const q = useQuery({ queryKey: ['consents', patientId, encounterId ?? null], queryFn: () => api<PatientConsent[]>(`/patients/${patientId}/consents`, { query: { encounter_id: encounterId } }) });
  const [signing, setSigning] = useState<PatientConsent | null>(null);
  const [history, setHistory] = useState<PatientConsent | null>(null);
  const qc = useQueryClient();
  const print = useMutation({ mutationFn: (code: string) => openBlob(`/patients/${patientId}/consents/${code}/form${encounterId ? `?encounter_id=${encounterId}` : ''}`) });
  const view = useMutation({ mutationFn: (fileId: string) => openBlob(`/patient-files/${fileId}/content`) });
  const revoke = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => api(`/consents/${id}/revoke`, { body: { reason } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['consents', patientId] }),
  });
  const items = (q.data ?? []).filter((c) => c.scope === scope);
  const missing = items.filter((c) => c.status === 'missing' || c.outdated).length;
  const unapproved = items.some((c) => !c.text_approved);

  return (
    <section className="card">
      <div className="card-head"><h2 className="grow">თანხმობები</h2>{missing > 0 && <span className="chip warn">{missing} მოსაწესრიგებელი</span>}</div>
      {unapproved && <div className="alert warn" style={{ margin: '12px 16px 0' }}>ზოგი თანხმობის ტექსტი ჯერ დამტკიცებული არ არის — დოკუმენტზე ჩანს შესაბამისი ნიშანი.</div>}
      <ErrorBox error={q.error ?? print.error ?? view.error ?? revoke.error} />
      <div>
        {items.map((c) => {
          const [cls, label] = STATUS[c.status];
          const l = c.latest;
          return (
            <div key={c.code} className="consent-row">
              <div className="stack grow" style={{ gap: 4, minWidth: 240 }}>
                <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
                  <strong>{c.name}</strong>
                  <span className={`chip ${cls}`}>{label}</span>
                  {c.outdated && <span className="chip warn">ძველი ვერსია</span>}
                </div>
                {l && (
                  <span className="small muted">
                    {tsDate(l.signed_at)} · v{l.version} · {l.method === 'electronic' ? 'ელექტრონული' : 'ქაღალდი'}
                    {l.signer_type === 'representative' && <> · {l.representative_name} ({l.representative_relation})</>}
                    {l.revoked_at && <> · გაუქმდა {tsDate(l.revoked_at)}: {l.revoke_reason}</>}
                  </span>
                )}
              </div>
              <div className="consent-actions">
                {l && <button className="btn sm" type="button" onClick={() => view.mutate(l.file_id)}>დოკუმენტი</button>}
                {c.history.length > 1 && <button className="btn sm" type="button" onClick={() => setHistory(c)}>ისტორია</button>}
                {canSign && <>
                  <button className="btn sm" type="button" onClick={() => print.mutate(c.code)}>ფორმის ბეჭდვა</button>
                  {c.status === 'granted' && l && <button className="btn sm" type="button"
                    onClick={() => { const r = prompt('გაუქმების მიზეზი (მაგ. პაციენტის წერილობითი მოთხოვნა):'); if (r && r.trim().length >= 5) revoke.mutate({ id: l.id, reason: r.trim() }); }}>გაუქმება</button>}
                  <button className="btn sm primary" type="button" onClick={() => setSigning(c)}>{c.status === 'missing' || c.outdated ? 'ხელმოწერა' : 'ხელახლა'}</button>
                </>}
              </div>
            </div>
          );
        })}
      </div>
      {signing && <SignDialog patientId={patientId} encounterId={encounterId} consent={signing} onClose={() => setSigning(null)} />}
      {history && (
        <Modal title={history.name} onClose={() => setHistory(null)} width={640}>
          <table className="table"><tbody>{history.history.map((h) => (
            <tr key={h.id}><td className="small">{tsDate(h.signed_at)}</td><td><span className={`chip ${STATUS[h.revoked_at ? 'revoked' : h.decision][0]}`}>{STATUS[h.revoked_at ? 'revoked' : h.decision][1]}</span></td>
              <td className="small muted">v{h.version} · {h.method === 'electronic' ? 'ელექტრონული' : 'ქაღალდი'} · {h.recorded_by_name}</td>
              <td><button className="btn sm" type="button" onClick={() => view.mutate(h.file_id)}>დოკუმენტი</button></td></tr>
          ))}</tbody></table>
        </Modal>
      )}
    </section>
  );
}

function SignDialog({ patientId, encounterId, consent, onClose }: { patientId: string; encounterId?: string; consent: PatientConsent; onClose: () => void }) {
  const qc = useQueryClient();
  const clinic = useQuery({ queryKey: ['clinic'], queryFn: () => api<ClinicSettings>('/settings/clinic'), retry: false });
  const types = useQuery({ queryKey: ['consent-types'], queryFn: () => api<ConsentType[]>('/consent-types') });
  const methods = clinic.data?.consent_methods ?? ['paper', 'electronic'];
  const [method, setMethod] = useState<'paper' | 'electronic'>(methods.includes('electronic') ? 'electronic' : 'paper');
  const [decision, setDecision] = useState<'granted' | 'refused'>('granted');
  const [signer, setSigner] = useState<'patient' | 'representative'>('patient');
  const [rep, setRep] = useState({ name: '', relation: '', id: '' });
  const [sigEmpty, setSigEmpty] = useState(true);
  const [scanId, setScanId] = useState<string | null>(null);
  const [upload, setUpload] = useState(false);
  const pad = useRef<SignaturePadHandle>(null);
  const text = types.data?.find((t) => t.code === consent.code)?.body_text;

  const m = useMutation({
    mutationFn: () => api(`/patients/${patientId}/consents`, { body: {
      type_code: consent.code, decision, method, signer_type: signer, encounter_id: encounterId,
      representative_name: signer === 'representative' ? rep.name : undefined, representative_relation: signer === 'representative' ? rep.relation : undefined,
      representative_id_number: signer === 'representative' ? rep.id || undefined : undefined,
      signature_png: method === 'electronic' ? pad.current?.toDataURL() ?? undefined : undefined,
      file_id: method === 'paper' ? scanId ?? undefined : undefined,
    } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['consents', patientId] }); void qc.invalidateQueries({ queryKey: ['patient-files', patientId] }); onClose(); },
  });
  const repOk = signer === 'patient' || (rep.name.trim() && rep.relation.trim());
  const ready = repOk && (method === 'electronic' ? !sigEmpty : !!scanId);

  return (
    <Modal title={consent.name} onClose={onClose} width={760}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={!ready || m.isPending} onClick={() => m.mutate()}>შენახვა</button></>}>
      {!consent.text_approved && <div className="alert warn">თანხმობის ტექსტი ჯერ დამტკიცებული არ არის — დოკუმენტზე ჩანს შესაბამისი ნიშანი.</div>}
      {methods.length > 1 && (
        <div className="seg" role="group" aria-label="ხელმოწერის მეთოდი" style={{ width: 'max-content' }}>
          <button type="button" aria-pressed={method === 'electronic'} onClick={() => setMethod('electronic')}>ელექტრონული ხელმოწერა</button>
          <button type="button" aria-pressed={method === 'paper'} onClick={() => setMethod('paper')}>ქაღალდი → სკანი</button>
        </div>
      )}
      <div className="row" style={{ gap: 20, flexWrap: 'wrap' }}>
        <div className="seg" role="group" aria-label="გადაწყვეტილება">
          <button type="button" aria-pressed={decision === 'granted'} onClick={() => setDecision('granted')}>ვეთანხმები</button>
          <button type="button" aria-pressed={decision === 'refused'} onClick={() => setDecision('refused')}>არ ვეთანხმები</button>
        </div>
        <div className="seg" role="group" aria-label="ხელმომწერი">
          <button type="button" aria-pressed={signer === 'patient'} onClick={() => setSigner('patient')}>პაციენტი</button>
          <button type="button" aria-pressed={signer === 'representative'} onClick={() => setSigner('representative')}>კანონიერი წარმომადგენელი</button>
        </div>
      </div>
      {signer === 'representative' && (
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 12 }}>
          <Field label="სახელი, გვარი" htmlFor="rn" required><input id="rn" className="input" value={rep.name} onChange={(e) => setRep({ ...rep, name: e.target.value })} /></Field>
          <Field label="კავშირი" htmlFor="rr" required><input id="rr" className="input" value={rep.relation} onChange={(e) => setRep({ ...rep, relation: e.target.value })} placeholder="მაგ. დედა" /></Field>
          <Field label="პირადი №" htmlFor="ri"><input id="ri" className="input mono" value={rep.id} onChange={(e) => setRep({ ...rep, id: e.target.value })} /></Field>
        </div>
      )}
      {method === 'electronic' ? (
        <>
          <div className="card card-pad" style={{ maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.6, background: 'var(--surface-2)' }}>{text ?? '…'}</div>
          <span className="label">{signer === 'patient' ? 'პაციენტის' : 'წარმომადგენლის'} ხელმოწერა</span>
          <SignaturePad ref={pad} onChange={setSigEmpty} />
        </>
      ) : (
        <div className="stack">
          <span className="hint">1. დაბეჭდეთ ფორმა („ფორმის ბეჭდვა“)  2. პაციენტი მოაწერს ხელს  3. ატვირთეთ სკანი ან ფოტო</span>
          {scanId ? <div className="alert ok">სკანი ატვირთულია.</div> : <button className="btn" type="button" style={{ alignSelf: 'flex-start' }} onClick={() => setUpload(true)}>ხელმოწერილი ფურცლის ატვირთვა</button>}
        </div>
      )}
      <ErrorBox error={m.error} />
      {upload && <UploadDialog patientId={patientId} docType="consent_scan" onClose={() => setUpload(false)} onUploaded={setScanId} />}
    </Modal>
  );
}
