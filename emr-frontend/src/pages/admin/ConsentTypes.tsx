import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import type { ConsentType } from '../../api/types';
import { ErrorBox, Field, Loading, Modal } from '../../components/ui';
import { tsDate } from '../../lib/format';

/** თანხმობის ტიპები: ტექსტი (ვერსიებით) და დამტკიცება */
export default function ConsentTypes() {
  const q = useQuery({ queryKey: ['consent-types', 'all'], queryFn: () => api<ConsentType[]>('/consent-types', { query: { all: true } }) });
  const [edit, setEdit] = useState<ConsentType | null>(null);
  return (
    <div className="content">
      <div className="alert info">თანხმობის ტექსტს ამზადებს კლინიკის იურისტი. ტექსტის ყოველი ცვლილება ქმნის ახალ ვერსიას — ძველ ვერსიაზე მოწერილი თანხმობები უცვლელი რჩება, პაციენტის ბარათზე კი „ძველი ვერსია“ გამოჩნდება.</div>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : (
        <div className="card">
          <table className="table">
            <thead><tr><th>თანხმობა</th><th>მოქმედება</th><th>ვერსია</th><th>ტექსტი</th><th>სტატუსი</th></tr></thead>
            <tbody>{q.data?.map((t) => (
              <tr key={t.code} className="clickable" onClick={() => setEdit(t)}>
                <td><strong>{t.name}</strong><div className="mono small muted">{t.code}</div></td>
                <td>{t.scope === 'patient' ? 'პაციენტზე (ერთხელ)' : 'ყოველ ვიზიტზე'}</td>
                <td className="mono">v{t.version} <span className="small muted">{tsDate(t.version_created_at)}</span></td>
                <td>{t.text_approved ? <span className="chip ok">დამტკიცებული</span> : <span className="chip warn">დასამტკიცებელი</span>}</td>
                <td>{t.is_active ? <span className="chip ok">აქტიური</span> : <span className="chip">გათიშული</span>}</td>
              </tr>))}</tbody>
          </table>
        </div>
      )}
      {edit && <EditType key={edit.code} t={edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function EditType({ t, onClose }: { t: ConsentType; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(t.name); const [text, setText] = useState(t.body_text);
  const [approved, setApproved] = useState(t.text_approved); const [active, setActive] = useState(t.is_active);
  const changed = text.trim() !== t.body_text;
  const m = useMutation({
    mutationFn: () => api(`/consent-types/${t.code}`, { method: 'PUT', body: { name, body_text: changed ? text : undefined, text_approved: approved, is_active: active } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['consent-types'] }); void qc.invalidateQueries({ queryKey: ['consents'] }); onClose(); },
  });
  return (
    <Modal title={t.name} onClose={onClose} width={860}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={m.isPending || text.trim().length < 20} onClick={() => m.mutate()}>{changed || approved !== t.text_approved ? `შენახვა (v${t.version + 1})` : 'შენახვა'}</button></>}>
      <Field label="დასახელება" htmlFor="cn"><input id="cn" className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label={`ტექსტი (მიმდინარე: v${t.version})`} htmlFor="ct" hint="ეს ტექსტი იბეჭდება ფორმაზე და ჩანს ელექტრონული ხელმოწერისას.">
        <textarea id="ct" className="textarea" rows={14} value={text} onChange={(e) => { setText(e.target.value); if (e.target.value.trim() !== t.body_text) setApproved(false); }} />
      </Field>
      <label className="row"><input type="checkbox" checked={approved} onChange={(e) => setApproved(e.target.checked)} /> ტექსტი დამტკიცებულია იურისტის მიერ</label>
      <label className="row"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> აქტიური</label>
      <ErrorBox error={m.error} />
    </Modal>
  );
}
