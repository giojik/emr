import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, apiUpload, openBlob } from '../api/client';
import type { DocType, PatientFile } from '../api/types';
import { tsDate } from '../lib/format';
import { ErrorBox, Field, Modal } from './ui';

export const DOC_KA: Record<DocType, string> = {
  id_card: 'პირადობის მოწმობა', passport: 'პასპორტი', birth_certificate: 'დაბადების მოწმობა', residence_permit: 'ბინადრობის მოწმობა',
  consent_scan: 'თანხმობა (სკანი)', consent_signed: 'თანხმობა (ელექტრონული)', other: 'სხვა',
};
const MAX = 10 * 1024 * 1024;

export function uploadPatientFile(patientId: string, file: File, docType: DocType, note?: string) {
  const fd = new FormData(); fd.append('doc_type', docType); if (note) fd.append('note', note); fd.append('file', file);
  return apiUpload<{ id: string }>(`/patients/${patientId}/files`, fd);
}

export default function DocumentsPanel({ patientId, canUpload, canDeactivate }: { patientId: string; canUpload: boolean; canDeactivate: boolean }) {
  const qc = useQueryClient(); const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: ['patient-files', patientId], queryFn: () => api<PatientFile[]>(`/patients/${patientId}/files`) });
  const deact = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => api(`/patient-files/${id}`, { method: 'PATCH', body: { reason } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['patient-files', patientId] }),
  });
  const view = useMutation({ mutationFn: (id: string) => openBlob(`/patient-files/${id}/content`) });
  const idDocs = q.data?.filter((f) => ['id_card', 'passport', 'birth_certificate', 'residence_permit'].includes(f.doc_type)) ?? [];
  return (
    <section className="card">
      <div className="card-head"><h2 className="grow">დოკუმენტები</h2>{canUpload && <button className="btn sm" type="button" onClick={() => setOpen(true)}>+ ატვირთვა</button>}</div>
      {q.data && idDocs.length === 0 && <div className="alert warn" style={{ margin: 12 }}>პირადობის დამადასტურებელი დოკუმენტის სკანი არ არის ატვირთული.</div>}
      {q.data?.length === 0 ? null : (
        <table className="table">
          <tbody>{q.data?.map((f) => (
            <tr key={f.id}>
              <td><strong>{DOC_KA[f.doc_type]}</strong>{f.note && <div className="small muted">{f.note}</div>}</td>
              <td className="small muted">{tsDate(f.created_at)} · {f.uploaded_by_first} {f.uploaded_by_last}</td>
              <td className="small muted">{f.mime_type === 'application/pdf' ? 'PDF' : 'სურათი'} · {Math.max(1, Math.round(f.size_bytes / 1024))} KB</td>
              <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                <button className="btn sm" type="button" onClick={() => view.mutate(f.id)}>ნახვა</button>
                {canDeactivate && !f.doc_type.startsWith('consent') && <button className="btn sm" type="button" style={{ marginLeft: 6 }}
                  onClick={() => { const r = prompt('დეაქტივაციის მიზეზი (მაგ. ვადაგასული დოკუმენტი):'); if (r && r.trim().length >= 5) deact.mutate({ id: f.id, reason: r.trim() }); }}>დეაქტივაცია</button>}
              </td>
            </tr>))}</tbody>
        </table>
      )}
      <div style={{ padding: '0 12px' }}><ErrorBox error={q.error ?? deact.error ?? view.error} /></div>
      {open && <UploadDialog patientId={patientId} onClose={() => setOpen(false)} />}
    </section>
  );
}

export function UploadDialog({ patientId, onClose, docType: fixedType, onUploaded }: { patientId: string; onClose: () => void; docType?: DocType; onUploaded?: (id: string) => void }) {
  const qc = useQueryClient();
  const [type, setType] = useState<DocType>(fixedType ?? 'id_card'); const [file, setFile] = useState<File | null>(null); const [note, setNote] = useState('');
  const preview = file && file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
  const tooBig = !!file && file.size > MAX;
  const m = useMutation({
    mutationFn: () => uploadPatientFile(patientId, file!, type, note || undefined),
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ['patient-files', patientId] }); onUploaded?.(r.id); onClose(); },
  });
  return (
    <Modal title="დოკუმენტის ატვირთვა" onClose={onClose} width={560}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={!file || tooBig || m.isPending} onClick={() => m.mutate()}>ატვირთვა</button></>}>
      {!fixedType && (
        <Field label="დოკუმენტის ტიპი" htmlFor="dt">
          <select id="dt" className="select" value={type} onChange={(e) => setType(e.target.value as DocType)}>
            {(['id_card', 'passport', 'birth_certificate', 'residence_permit', 'other'] as DocType[]).map((t) => <option key={t} value={t}>{DOC_KA[t]}</option>)}
          </select>
        </Field>
      )}
      <Field label="ფაილი" htmlFor="df" hint="JPG, PNG ან PDF, მაქს. 10 MB. ტაბლეტზე შეგიძლიათ პირდაპირ გადაიღოთ კამერით." error={tooBig ? 'ფაილი 10 MB-ზე დიდია' : undefined}>
        <input id="df" className="input" style={{ padding: 8, height: 'auto' }} type="file" accept="image/jpeg,image/png,application/pdf" capture="environment" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </Field>
      {preview && <img src={preview} alt="წინასწარი ხედი" style={{ maxWidth: '100%', maxHeight: 260, objectFit: 'contain', border: '1px solid var(--line)', borderRadius: 8 }} />}
      <Field label="შენიშვნა" htmlFor="dn"><input id="dn" className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="მაგ. ვადა 2031 წლამდე" /></Field>
      <ErrorBox error={m.error} />
    </Modal>
  );
}
