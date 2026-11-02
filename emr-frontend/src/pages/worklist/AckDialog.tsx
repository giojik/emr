import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { ErrorBox, Field, Loading, Modal } from '../../components/ui';
import { tsDate, time } from '../../lib/format';

/**
 * 0084 — პასუხის გაცნობა (ექიმი): ვიზიტის ვალიდირებული / ხელმოწერილი პასუხები → „გავეცანი“.
 * კრიტიკულზე (ლაბ. HH / LL, რადიოლოგიის კრიტიკული მიგნება) ქმედება სავალდებულოა. ერთი ექიმის გაცნობა პასუხს ყველასთვის ხურავს.
 */
interface AckItem {
  id: string; section: string; name: string; validated_at: string; critical: boolean; abnormal: boolean; acked: boolean; ordered_by_name: string | null; validated_by_name: string | null;
  results: { name: string; value: string | null; unit: string; flag: string | null }[] | null; impression: string | null;
  acked_at: string | null; acked_by_name: string | null; ack_action: string | null; ack_note: string | null; ack_kind: string | null;
}
interface Pending {
  encounter: { id: string; type: string; status: string; patient_id: string; patient_name: string; personal_number: string | null; birth_date: string | null };
  can_ack: boolean; items: AckItem[]; actions: Record<string, string>;
}
const SECTION_KA: Record<string, string> = { lab: 'ლაბორატორია', radiology: 'რადიოლოგია', endoscopy: 'ენდოსკოპია' };
const FLAG_TONE: Record<string, string> = { HH: 'var(--danger-ink)', LL: 'var(--danger-ink)', H: 'var(--warn-ink)', L: 'var(--warn-ink)', A: 'var(--warn-ink)' };

export function AckDialog({ encounterId, onClose }: { encounterId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['dx-acks', encounterId], queryFn: () => api<Pending>('/dx/acks/pending', { query: { encounter_id: encounterId } }) });
  const pending = useMemo(() => (q.data?.items ?? []).filter((x) => !x.acked), [q.data]);
  const done = useMemo(() => (q.data?.items ?? []).filter((x) => x.acked), [q.data]);
  const [sel, setSel] = useState<Set<string> | null>(null);
  const chosen = sel ?? new Set(pending.map((x) => x.id));
  const [action, setAction] = useState('');
  const [note, setNote] = useState('');
  const critSel = pending.some((x) => x.critical && chosen.has(x.id));
  const ack = useMutation({
    mutationFn: () => api<{ acked: number }>('/dx/acks', { body: { item_ids: [...chosen], ...(action && { action }), ...(note.trim() && { note: note.trim() }) } }),
    onSuccess: () => { for (const k of ['dx-acks', 'wl-mine', 'wl-count']) void qc.invalidateQueries({ queryKey: [k] }); setSel(null); setAction(''); setNote(''); },
  });
  const e = q.data?.encounter;
  const toggle = (id: string) => { const n = new Set(chosen); if (n.has(id)) n.delete(id); else n.add(id); setSel(n); };
  const encLink = e ? (e.type === 'inpatient' ? `/inpatient/stay/${e.id}` : `/encounters/${e.id}`) : '#';
  const disabled = !chosen.size || ack.isPending || (critSel && !action) || (action === 'other' && note.trim().length < 3);
  return (
    <Modal title={e ? `პასუხის გაცნობა — ${e.patient_name}` : 'პასუხის გაცნობა'} onClose={onClose} width={820}
      footer={<><Link className="btn" to={encLink} onClick={onClose}>{e?.type === 'inpatient' ? 'ჰოსპიტალიზაცია →' : 'ვიზიტი →'}</Link><span className="grow" />
        <button type="button" className="btn" onClick={onClose}>დახურვა</button>
        {q.data?.can_ack && pending.length > 0 && <button type="button" className="btn primary" disabled={disabled} onClick={() => ack.mutate()}>გავეცანი ({chosen.size})</button>}</>}>
      {q.isLoading ? <Loading /> : q.data && <div className="stack">
        {e && <div className="small muted">{e.personal_number ?? ''}{e.birth_date ? ` · დაბ. ${tsDate(e.birth_date)}` : ''} · {e.type === 'inpatient' ? 'სტაციონარი' : 'ამბულატორია'}</div>}
        {!q.data.can_ack && <div className="alert warn">გაცნობა შეუძლია დამნიშნავ / მკურნალ ექიმს ან ვიზიტის განყოფილების ექიმს.</div>}
        {!pending.length ? <div className="empty">გასაცნობი პასუხი არ არის.</div> : <div className="card">
          <table className="table small"><thead><tr><th style={{ width: 28 }} /><th>კვლევა</th><th>პასუხი</th><th>ვალიდაცია</th></tr></thead>
            <tbody>{pending.map((x) => <tr key={x.id} style={{ background: x.critical ? 'var(--danger-weak)' : undefined }}>
              <td><input type="checkbox" aria-label={`მონიშვნა: ${x.name}`} checked={chosen.has(x.id)} onChange={() => toggle(x.id)} disabled={!q.data.can_ack} /></td>
              <td><strong>{x.name}</strong><div className="muted">{SECTION_KA[x.section] ?? x.section}{x.ordered_by_name ? ` · დანიშნა ${x.ordered_by_name}` : ''}</div>
                {x.critical && <span className="chip danger">⚠ კრიტიკული</span>}</td>
              <td>{x.section === 'lab' ? (x.results ?? []).filter((r) => x.critical || x.abnormal ? r.flag && r.flag !== 'N' : true).slice(0, 8).map((r) => <div key={r.name}>
                {r.name}: <strong style={{ color: r.flag ? FLAG_TONE[r.flag] : undefined }}>{r.value ?? '—'}</strong> {r.unit} {r.flag && r.flag !== 'N' ? <span className="mono">({r.flag})</span> : null}</div>)
                : <span>{x.impression ?? '—'}</span>}
                {x.section === 'lab' && !(x.results ?? []).length && <span className="muted">PDF / კულტურა — იხ. ვიზიტში</span>}</td>
              <td className="mono" style={{ whiteSpace: 'nowrap' }}>{tsDate(x.validated_at)} {time(x.validated_at)}<div className="muted">{x.validated_by_name ?? ''}</div></td>
            </tr>)}</tbody></table></div>}
        {q.data.can_ack && pending.length > 0 && <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Field label={critSel ? 'ქმედება (კრიტიკული — სავალდებულო)' : 'ქმედება (არჩევითი)'} htmlFor="ack-a">
            <select id="ack-a" className="select" value={action} onChange={(ev) => setAction(ev.target.value)}>
              <option value="">—</option>{Object.entries(q.data.actions).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          <div className="grow"><Field label="შენიშვნა" htmlFor="ack-n" hint={action === 'other' ? 'სავალდებულო (მინ. 3 სიმბოლო)' : undefined}>
            <input id="ack-n" className="input" value={note} maxLength={1000} onChange={(ev) => setNote(ev.target.value)} /></Field></div>
        </div>}
        <ErrorBox error={ack.error ?? q.error} />
        {ack.data && <div className="alert ok">დადასტურდა: {ack.data.acked}</div>}
        {done.length > 0 && <details><summary className="small">უკვე გაცნობილი ({done.length})</summary>
          <table className="table small"><tbody>{done.map((x) => <tr key={x.id}><td>{x.name}{x.critical && <span className="chip danger" style={{ marginLeft: 6 }}>კრიტიკული</span>}</td>
            <td>{x.acked_by_name} · {x.acked_at ? `${tsDate(x.acked_at)} ${time(x.acked_at)}` : ''}</td>
            <td>{x.ack_action ? q.data!.actions[x.ack_action] : ''}{x.ack_note ? ` — ${x.ack_note}` : ''}</td></tr>)}</tbody></table></details>}
        <span className="hint">ერთი ექიმის „გავეცანი“ პასუხს ყველასთვის ხურავს (დამნიშნავი, მკურნალი, განყოფილება). შესწორებული (ხელახლა ვალიდირებული) პასუხი თავიდან საჭიროებს გაცნობას.</span>
      </div>}
    </Modal>
  );
}
