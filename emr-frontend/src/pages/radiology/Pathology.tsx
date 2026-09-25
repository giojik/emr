import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, apiUpload, openBlob } from '../../api/client';
import type { PathListRow, PathRequest } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Loading, useDebounced, useToast } from '../../components/ui';
import { age, dateGe, genderShort, hhmm, tsDate } from '../../lib/format';

const OVERDUE = 10;   // დღე — ვადაგადაცილებული პასუხი
type Tab = 'draft' | 'sent' | 'resulted';

/** ბიოფსიები: გასაგზავნი → პასუხს ელოდება (ვადაგადაცილება) → პასუხი (გასაცნობი) */
export default function Pathology() {
  const [tab, setTab] = useState<Tab>('sent');
  const [only, setOnly] = useState(false);
  const [search, setSearch] = useState(''); const ds = useDebounced(search.trim(), 300);
  const [selId, setSelId] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['pathology', tab, only, ds],
    queryFn: () => api<PathListRow[]>('/pathology', { query: { tab, search: ds, ...(tab === 'sent' && only ? { overdue_days: OVERDUE } : {}), ...(tab === 'resulted' && only ? { unreviewed: true } : {}) } }),
    refetchInterval: 30_000,
  });
  const rows = q.data ?? [];
  return (
    <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex' }}>
      <div className="content grow" style={{ minWidth: 0, overflow: 'auto' }}>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <div className="seg" role="group" aria-label="სტატუსი">
            {([['draft', 'გასაგზავნი'], ['sent', 'პასუხს ელოდება'], ['resulted', 'პასუხი მიღებულია']] as const).map(([k, l]) => <button key={k} type="button" aria-pressed={tab === k} onClick={() => { setTab(k); setSelId(null); setOnly(false); }}>{l}</button>)}
          </div>
          {tab === 'sent' && <label className="row small"><input type="checkbox" checked={only} onChange={(e) => setOnly(e.target.checked)} /> მხოლოდ ვადაგადაცილებული (&gt; {OVERDUE} დღე)</label>}
          {tab === 'resulted' && <label className="row small"><input type="checkbox" checked={only} onChange={(e) => setOnly(e.target.checked)} /> მხოლოდ გასაცნობი</label>}
          <input aria-label="ძებნა" className="input" style={{ maxWidth: 260, height: 38, marginLeft: 'auto' }} placeholder="P26-…, პირადი №, გვარი" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <ErrorBox error={q.error} />
        {q.isLoading ? <Loading /> : !rows.length ? <div className="card empty">სია ცარიელია.</div> : (
          <div className="card">
            <table className="table">
              <thead><tr><th>მიმართვა</th><th>პაციენტი</th><th>პროცედურა</th><th className="num">ქილა</th><th>ლაბორატორია</th><th>{tab === 'draft' ? 'შექმნა' : tab === 'sent' ? 'გაიგზავნა' : 'პასუხი'}</th></tr></thead>
              <tbody>{rows.map((r) => {
                const late = tab === 'sent' && (r.days_waiting ?? 0) > OVERDUE;
                const ts = tab === 'draft' ? r.created_at : tab === 'sent' ? r.sent_at : r.result_received_at;
                return (
                  <tr key={r.id} className="clickable" onClick={() => setSelId(r.id)} style={r.id === selId ? { background: 'var(--accent-weak)' } : undefined}>
                    <td className="mono">{r.request_no}</td>
                    <td><strong>{r.last_name} {r.first_name}</strong><div className="small muted">{genderShort(r.gender)} · {age(r.birth_date)} წ</div></td>
                    <td>{r.service_name}<div className="small muted">{r.performed_at && tsDate(r.performed_at)}</div></td>
                    <td className="num">{r.jars}</td>
                    <td>{r.external_lab ?? '—'}</td>
                    <td className="small">{ts && `${tsDate(ts)} ${hhmm(ts)}`}
                      {tab === 'sent' && <div><span className={`chip ${late ? 'danger' : ''}`}>{r.days_waiting} დღე</span></div>}
                      {tab === 'resulted' && !r.reviewed_at && <div><span className="chip warn">გასაცნობი</span></div>}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        )}
      </div>
      {selId && <PathPanel key={selId} id={selId} onClose={() => setSelId(null)} />}
    </div>
  );
}

function PathPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient(); const toast = useToast(); const { user } = useAuth();
  const q = useQuery({ queryKey: ['path-request', id], queryFn: () => api<PathRequest>(`/pathology/${id}`) });
  const [lab, setLab] = useState('');
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['pathology'] }); void qc.invalidateQueries({ queryKey: ['path-request', id] }); void qc.invalidateQueries({ queryKey: ['rad-report'] }); };
  const send = useMutation({ mutationFn: () => api(`/pathology/${id}/send`, { body: { external_lab: lab || undefined } }), onSuccess: () => { toast.show('გაიგზავნა'); refresh(); } });
  const result = useMutation({
    mutationFn: () => { const fd = new FormData(); if (text.trim()) fd.append('result_text', text.trim()); if (file) fd.append('file', file); return apiUpload(`/pathology/${id}/result`, fd); },
    onSuccess: () => { toast.show('პასუხი შენახულია — ენდოსკოპისტს გაეგზავნა'); refresh(); },
  });
  const review = useMutation({ mutationFn: () => api(`/pathology/${id}/review`, { method: 'POST' }), onSuccess: () => { toast.show('გაცნობილია'); refresh(); } });
  const cancel = useMutation({ mutationFn: (reason: string) => api(`/pathology/${id}/cancel`, { body: { reason } }), onSuccess: () => { refresh(); onClose(); } });
  const r = q.data;
  if (!r) return <aside style={{ width: 560, borderLeft: '1px solid var(--line)', background: 'var(--surface)' }}>{q.error ? <ErrorBox error={q.error} /> : <Loading />}</aside>;
  const canSend = !!user && ['admin', 'endoscopist', 'endoscopy_nurse'].includes(user.role);
  return (
    <aside style={{ width: 'min(580px, 50vw)', flexShrink: 0, background: 'var(--surface)', borderLeft: '1px solid var(--line)', padding: 20, display: 'flex', flexDirection: 'column', gap: 12, overflow: 'auto' }}>
      <div className="row"><h2 className="grow" style={{ fontSize: 17 }}>მიმართვა <span className="mono">{r.request_no}</span></h2><button className="icon-btn" type="button" aria-label="დახურვა" onClick={onClose}>×</button></div>
      <span><strong>{r.first_name} {r.last_name}</strong> · {r.gender && genderShort(r.gender)} · დაბ. {r.birth_date && dateGe(r.birth_date)}{r.personal_number && <> · <span className="mono">{r.personal_number}</span></>}</span>
      <span className="small muted">{r.service_name}{r.performed_at ? ` · ${tsDate(r.performed_at)}` : ''}{r.ordered_by_name ? ` · შეკვეთა: ${r.ordered_by_name}` : ''}{r.external_referral ? ` · მიმართვა: ${r.external_referral}` : ''}</span>
      {r.clinical_info && <span className="small">კლინიკური მონაცემი: {r.clinical_info}</span>}
      <table className="table small">
        <thead><tr><th>ქილა</th><th>ლოკალიზაცია</th><th>ფრაგმ.</th><th>აღწერა</th></tr></thead>
        <tbody>{r.specimens.map((s) => <tr key={s.jar_no}><td className="mono">{s.jar_no}</td><td>{s.site}</td><td>{s.pieces}</td><td>{s.description}</td></tr>)}</tbody>
      </table>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button className="btn sm" type="button" onClick={() => void openBlob(`/pathology/${id}/labels`)}>ეტიკეტები (ქილები)</button>
        <button className="btn sm" type="button" onClick={() => void openBlob(`/pathology/${id}/requisition`)}>მიმართვის ფორმა</button>
      </div>

      {r.status === 'draft' && canSend && <div className="stack" style={{ gap: 8, padding: 12, border: '1px solid var(--line-soft)', borderRadius: 10 }}>
        <strong className="small">გაგზავნა</strong>
        <input aria-label="ლაბორატორია" className="input" style={{ height: 36 }} placeholder={r.external_lab ?? 'ლაბორატორია *'} value={lab} onChange={(e) => setLab(e.target.value)} />
        <div className="row">
          <button className="btn" type="button" onClick={() => { const x = prompt('გაუქმების მიზეზი:'); if (x && x.trim().length >= 5) cancel.mutate(x.trim()); }}>გაუქმება</button>
          <button className="btn primary grow" type="button" disabled={send.isPending || (!lab.trim() && !r.external_lab)} onClick={() => send.mutate()}>გაიგზავნა ლაბორატორიაში</button>
        </div>
      </div>}

      {r.status === 'sent' && <div className="stack" style={{ gap: 8, padding: 12, border: '1px solid var(--line-soft)', borderRadius: 10 }}>
        <span className="small muted">გაიგზავნა {r.sent_at && `${tsDate(r.sent_at)} ${hhmm(r.sent_at)}`} → {r.external_lab}{r.sent_by_name ? ` · ${r.sent_by_name}` : ''} · {r.days_waiting} დღე</span>
        <strong className="small">პასუხის შეტანა</strong>
        <textarea aria-label="პასუხის ტექსტი" className="textarea" rows={6} placeholder="ჰისტოლოგიური დასკვნა (ქილების მიხედვით)" value={text} onChange={(e) => setText(e.target.value)} />
        <label className="row small"><input type="file" accept="application/pdf,image/jpeg,image/png" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /> სკანი (PDF / JPG)</label>
        <button className="btn primary" type="button" disabled={result.isPending || (!text.trim() && !file)} onClick={() => result.mutate()}>პასუხის შენახვა</button>
      </div>}

      {r.status === 'resulted' && <div className="stack" style={{ gap: 6 }}>
        <strong>ჰისტოლოგიური პასუხი · {r.result_received_at && tsDate(r.result_received_at)}</strong>
        {r.result_text && <div style={{ whiteSpace: 'pre-wrap' }}>{r.result_text}</div>}
        {r.result_file_path && <button className="btn sm" type="button" style={{ width: 'max-content' }} onClick={() => void openBlob(`/pathology/${id}/file`)}>სკანი</button>}
        {r.reviewed_at ? <span className="small muted">გაეცნო: {r.reviewed_by_name} · {tsDate(r.reviewed_at)}</span>
          : (user?.role === 'endoscopist' || user?.role === 'admin') ? <button className="btn primary" type="button" disabled={review.isPending} onClick={() => review.mutate()}>გავეცანი</button>
          : <span className="chip warn" style={{ width: 'max-content' }}>ენდოსკოპისტი ჯერ არ გაცნობია</span>}
      </div>}
      <ErrorBox error={send.error ?? result.error ?? review.error ?? cancel.error} />
      {toast.node}
    </aside>
  );
}
