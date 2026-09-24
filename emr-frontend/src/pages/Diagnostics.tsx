import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Allergy, WorklistItem } from '../api/types';
import AllergyBanner from '../components/AllergyBanner';
import { ErrorBox, Loading, StatusChip, useToast } from '../components/ui';
import { age, genderShort, hhmm, REFERRAL_KA, todayISO, tsDate } from '../lib/format';

const TYPES = ['lab', 'imaging', 'specialist_consult'] as const;

/** დიაგნოსტიკის სამუშაო სია: ლაბორანტი / რადიოლოგი — მიმართვის მიღება, შედეგის შეტანა */
export default function Diagnostics() {
  const [tab, setTab] = useState<'open' | 'done'>('open');
  const [type, setType] = useState<string>('');
  const [selId, setSelId] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['worklist', tab, type],
    queryFn: () => api<WorklistItem[]>('/referrals', { query: tab === 'open' ? { status: 'requested,in_progress', type } : { status: 'completed', type, completed_date: todayISO() } }),
    refetchInterval: 20_000,
  });
  const items = q.data ?? [];
  const sel = items.find((x) => x.id === selId) ?? null;
  const counts = (t: string) => items.filter((x) => x.type === t).length;

  return (
    <>
      <header className="topbar">
        <h1>დიაგნოსტიკის სამუშაო სია</h1>
        <div className="seg" role="group" aria-label="სია" style={{ marginLeft: 'auto' }}>
          <button type="button" aria-pressed={tab === 'open'} onClick={() => { setTab('open'); setSelId(null); }}>ღია</button>
          <button type="button" aria-pressed={tab === 'done'} onClick={() => { setTab('done'); setSelId(null); }}>დასრულებული დღეს</button>
        </div>
      </header>
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <div className="content grow">
          <div className="row" role="group" aria-label="ტიპი" style={{ flexWrap: 'wrap', gap: 6 }}>
            <button type="button" className={`btn sm${type === '' ? ' dark' : ''}`} onClick={() => setType('')}>ყველა{type === '' ? ` · ${items.length}` : ''}</button>
            {TYPES.map((t) => <button key={t} type="button" className={`btn sm${type === t ? ' dark' : ''}`} onClick={() => setType(t)}>{REFERRAL_KA[t]}{type === '' ? ` · ${counts(t)}` : ''}</button>)}
          </div>
          <ErrorBox error={q.error} />
          {q.isLoading ? <Loading /> : items.length === 0 ? <div className="card empty">{tab === 'open' ? 'ღია მიმართვა არ არის.' : 'დღეს დასრულებული მიმართვა არ არის.'}</div> : (
            <div className="card">
              <table className="table">
                <thead><tr><th>{tab === 'open' ? 'მოთხოვნილია' : 'დასრულდა'}</th><th>პაციენტი</th><th>ტიპი</th><th>კვლევა / მიზეზი</th><th>ექიმი</th><th>სტატუსი</th></tr></thead>
                <tbody>{items.map((r) => (
                  <tr key={r.id} className="clickable" onClick={() => setSelId(r.id)} style={r.id === selId ? { background: 'var(--accent-weak)' } : undefined}>
                    <td className="mono">{hhmm(tab === 'open' ? r.created_at : r.completed_at ?? r.created_at)}{tab === 'open' && tsDate(r.created_at) !== tsDate(new Date().toISOString()) && <div className="small muted">{tsDate(r.created_at)}</div>}</td>
                    <td><strong>{r.patient_first_name} {r.patient_last_name}</strong><div className="small muted mono">{r.personal_number} · {genderShort(r.gender)} · {age(r.birth_date)} წ</div></td>
                    <td>{REFERRAL_KA[r.type]}</td>
                    <td>{r.reason}</td>
                    <td className="small">{r.requested_by_name}</td>
                    <td><StatusChip status={r.status} /></td>
                  </tr>))}</tbody>
              </table>
            </div>
          )}
        </div>
        {sel && <ResultPanel key={sel.id} r={sel} onDone={() => setSelId(null)} />}
      </div>
    </>
  );
}

function ResultPanel({ r, onDone }: { r: WorklistItem; onDone: () => void }) {
  const qc = useQueryClient(); const toast = useToast();
  const [text, setText] = useState(r.result_text ?? '');
  useEffect(() => { setText(r.result_text ?? ''); }, [r.id, r.result_text]);
  const allergies = useQuery({ queryKey: ['allergies', r.patient_id], queryFn: () => api<Allergy[]>(`/patients/${r.patient_id}/allergies`) });
  const m = useMutation({
    mutationFn: (status: 'in_progress' | 'completed') => api(`/referrals/${r.id}`, { method: 'PATCH', body: { status, result_text: text.trim() || undefined } }),
    onSuccess: (_d, status) => {
      void qc.invalidateQueries({ queryKey: ['worklist'] });
      if (status === 'completed') { toast.show('შედეგი გაიგზავნა ექიმთან'); onDone(); } else toast.show('შენახულია');
    },
  });
  const done = r.status === 'completed';
  const active = (allergies.data ?? []).filter((a) => a.is_active !== false);
  return (
    <aside style={{ width: 460, flexShrink: 0, background: 'var(--surface)', borderLeft: '1px solid var(--line)', padding: 22, display: 'flex', flexDirection: 'column', gap: 14, overflow: 'auto' }}>
      <div className="stack" style={{ gap: 4 }}>
        <span className="small muted">{REFERRAL_KA[r.type]} · მოთხოვნილია {tsDate(r.created_at)} {hhmm(r.created_at)}</span>
        <h2 style={{ fontSize: 18 }}>{r.reason}</h2>
        <span>{r.patient_first_name} {r.patient_last_name} · {genderShort(r.gender)} · {age(r.birth_date)} წ</span>
        <span className="small muted">ექიმი: {r.requested_by_name}</span>
      </div>
      {allergies.data && <AllergyBanner allergies={active} />}
      {r.type === 'imaging' && active.some((a) => /კონტრასტ|იოდ|contrast/i.test(a.substance)) &&
        <div className="alert danger"><strong>ყურადღება: კონტრასტის ალერგია.</strong> კონტრასტიანი კვლევისას გადაამოწმეთ ექიმთან.</div>}
      <label className="stack grow" style={{ gap: 6, minHeight: 240 }}>
        <span className="label">შედეგი / დასკვნა {!done && <span className="req">*</span>}</span>
        <textarea className="textarea mono" style={{ flex: 1, minHeight: 220, fontSize: 14 }} readOnly={done} value={text} onChange={(e) => setText(e.target.value)}
          placeholder={r.type === 'lab' ? 'პარამეტრი   მნიშვნელობა   ერთეული   (ნორმა)' : 'აღწერა და დასკვნა'} />
        {!done && <span className="hint">დასრულების შემდეგ შედეგი ექიმის ეკრანზე და ფორმა №100/ა-ში გამოჩნდება.</span>}
      </label>
      <ErrorBox error={m.error} />
      {!done && (
        <div className="row">
          <button className="btn grow" type="button" disabled={m.isPending} onClick={() => m.mutate('in_progress')}>{r.status === 'requested' ? 'დაწყება' : 'შენახვა'}</button>
          <button className="btn primary grow" type="button" disabled={m.isPending || !text.trim()} onClick={() => m.mutate('completed')}>დასრულება</button>
        </div>
      )}
      {done && r.completed_at && <div className="alert ok">დასრულდა {tsDate(r.completed_at)} {hhmm(r.completed_at)}</div>}
      {toast.node}
    </aside>
  );
}
