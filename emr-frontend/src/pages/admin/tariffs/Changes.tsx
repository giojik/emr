import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, can } from '../../../api/client';
import { useAuth } from '../../../auth/AuthContext';
import { ErrorBox, Loading, Modal } from '../../../components/ui';
import { tsDate } from '../../../lib/format';
import { type Change, type ChangeItemRow, dg, MODE_KA, n2, type RuleVersion, SCOPE_KA, STATUS_UI, TARIFF_APPROVE, TARIFF_EDIT } from './types';

/** ცვლილებები: მოთხოვნები (ფასი / წესი), დამტკიცება / უარყოფა (მეორე პირი), გაუქმება (ავტორი) */
export default function Changes() {
  const [status, setStatus] = useState('pending'); const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['tariff-changes', status], queryFn: () => api<Change[]>('/tariff-changes', { query: { status } }) });
  return (
    <div className="content">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <div className="seg" role="group" aria-label="სტატუსი">
          {[['pending', 'დასამტკიცებელი'], ['applied', 'გატარებული'], ['rejected', 'უარყოფილი'], ['cancelled', 'გაუქმებული'], ['', 'ყველა']].map(([k, l]) =>
            <button key={k} type="button" aria-pressed={status === k} onClick={() => setStatus(k)}>{l}</button>)}
        </div>
        <span className="hint grow">დამტკიცების რეჟიმი იცვლება: ადმინისტრირება → მოდულები → ტარიფები.</span>
      </div>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : (
        <div className="card">
          {!q.data?.length ? <div className="empty">ცვლილება არ არის.</div> : (
            <table className="table">
              <thead><tr><th>№</th><th>სათაური</th><th>ტიპი</th><th className="num">ჩან.</th><th>ავტორი</th><th>თარიღი</th><th>სტატუსი</th></tr></thead>
              <tbody>{q.data.map((c) => (
                <tr key={c.id} className="clickable" onClick={() => setOpen(c.id)}>
                  <td className="mono small">{c.change_no}</td>
                  <td>{c.title}<div className="small muted">{c.reason}</div></td>
                  <td className="small">{c.kind === 'rules' ? `წესები${c.payers ? ` · ${c.payers}` : ''}` : c.source === 'csv' ? 'ფასები (CSV)' : 'ფასები'}</td>
                  <td className="num">{c.kind === 'prices' ? c.items : '—'}</td>
                  <td className="small">{c.created_by_name ?? '—'}</td><td className="small">{tsDate(c.created_at)}</td>
                  <td><span className={`chip ${STATUS_UI[c.status]?.[0] ?? ''}`}>{STATUS_UI[c.status]?.[1] ?? c.status}</span>
                    {c.approval === 'off' && c.status === 'applied' && <div className="small muted">დამტკიცების გარეშე</div>}</td>
                </tr>))}</tbody>
            </table>)}
        </div>)}
      {open && <ChangeModal id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function ChangeModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { user } = useAuth(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['tariff-change', id], queryFn: () => api<Change & { items: ChangeItemRow[]; versions: RuleVersion[] }>(`/tariff-changes/${id}`) });
  const [note, setNote] = useState('');
  const act = useMutation({
    mutationFn: (a: 'approve' | 'reject' | 'cancel') => api(`/tariff-changes/${id}/${a}`, { body: a === 'approve' ? { note: note.trim() || undefined } : { note: note.trim() } }),
    onSuccess: () => { for (const k of ['tariff-changes', 'tariff-change', 'tariff-items', 'tariff-lists', 'payer-rules']) void qc.invalidateQueries({ queryKey: [k] }); onClose(); },
  });
  const c = q.data;
  const mine = c?.created_by === user?.id;
  const canDecide = c?.status === 'pending' && can(user, ...TARIFF_APPROVE) && !mine;
  const canCancel = c?.status === 'pending' && (mine || can(user, 'admin')) && can(user, ...TARIFF_EDIT);
  return (
    <Modal title={c ? `${c.change_no} — ${c.title}` : 'ცვლილება'} onClose={onClose} width={860}
      footer={c?.status === 'pending' ? <>
        <input className="input" style={{ maxWidth: 340, height: 38 }} aria-label="შენიშვნა / მიზეზი" placeholder={canDecide ? 'შენიშვნა (უარყოფისას — სავალდებულო)' : 'მიზეზი'} value={note} onChange={(e) => setNote(e.target.value)} />
        {canCancel && <button className="btn" type="button" disabled={act.isPending || note.trim().length < 3} onClick={() => act.mutate('cancel')}>გაუქმება</button>}
        {canDecide && <button className="btn danger" type="button" disabled={act.isPending || note.trim().length < 3} onClick={() => act.mutate('reject')}>უარყოფა</button>}
        {canDecide && <button className="btn primary" type="button" disabled={act.isPending} onClick={() => act.mutate('approve')}>დამტკიცება</button>}
      </> : undefined}>
      <ErrorBox error={q.error} />
      {!c ? <Loading /> : (
        <div className="stack" style={{ gap: 12 }}>
          <div className="row small" style={{ flexWrap: 'wrap', gap: 12 }}>
            <span className={`chip ${STATUS_UI[c.status]?.[0] ?? ''}`}>{STATUS_UI[c.status]?.[1]}</span>
            <span>ავტორი: <strong>{c.created_by_name ?? '—'}</strong>, {tsDate(c.created_at)}</span>
            {c.decided_at && <span>{c.status === 'cancelled' ? 'გააუქმა' : 'გადაწყვიტა'}: <strong>{c.decided_by_name ?? '—'}</strong>, {tsDate(c.decided_at)}</span>}
          </div>
          <div className="small"><span className="muted">მიზეზი:</span> {c.reason}</div>
          {c.decision_note && c.decision_note !== 'auto' && <div className="alert info small">{c.decision_note}</div>}
          {c.status === 'pending' && mine && <div className="alert warn small">საკუთარ ცვლილებას ვერ დაამტკიცებთ — საჭიროა მეორე პირი (ტარიფების დამტკიცება).</div>}
          {c.kind === 'prices' ? (
            <table className="table">
              <thead><tr><th>ნუსხა</th><th>კოდი</th><th>დასახელება</th><th>დან</th><th className="num">იყო</th><th className="num">ხდება</th><th className="num">Δ</th></tr></thead>
              <tbody>{c.items.map((i) => {
                const pct = i.kind === 'stock_category'; const was = pct ? i.prev_markup : i.prev_price; const now = pct ? i.markup_pct : i.price;
                const d = was !== null && now !== null ? Number(now) - Number(was) : null;
                return (
                  <tr key={i.id}><td className="small">{i.list_name} <span className="muted">({SCOPE_KA[i.scope]})</span></td><td className="mono small">{i.code}</td><td>{i.name}</td><td className="small">{dg(i.valid_from)}</td>
                    <td className="num mono muted">{was === null ? '—' : pct ? `${Number(was)}%` : n2(was)}</td>
                    <td className="num mono">{i.action === 'end' ? 'ამოღება' : pct ? `${Number(now)}%` : n2(now)}</td>
                    <td className="num mono" style={{ color: d === null ? undefined : d > 0 ? 'var(--danger-ink)' : 'var(--ok-ink)' }}>{d === null ? '' : `${d > 0 ? '+' : ''}${pct ? d : d.toFixed(2)}`}</td></tr>);
              })}</tbody>
            </table>) : c.versions.map((v) => <VersionCard key={v.id} v={v} />)}
          <ErrorBox error={act.error} />
        </div>)}
    </Modal>
  );
}

export function VersionCard({ v, current }: { v: RuleVersion; current?: boolean }) {
  return (
    <div className="card card-pad stack" style={{ gap: 8, borderColor: current ? 'var(--accent)' : undefined }}>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <strong>ვერსია {v.version_no}</strong>
        <span className={`chip ${STATUS_UI[v.status]?.[0] ?? ''}`}>{v.status === 'rejected' ? 'არ მოქმედებს' : STATUS_UI[v.status]?.[1] ?? v.status}</span>
        {current && <span className="chip accent">დღეს მოქმედი</span>}
        <span className="small muted grow">მოქმედებს: {v.valid_from ? dg(v.valid_from) : 'თავიდან (მიგრაცია)'} · {({ all: 'ამბ. + სტაც.', opd: 'ამბულატორია', ipd: 'სტაციონარი' } as Record<string, string>)[v.applies_to]}{v.change_no ? ` · ${v.change_no}` : ''}{v.stays ? ` · ჰოსპიტალიზაცია: ${v.stays}` : ''}</span>
      </div>
      <div className="row small" style={{ flexWrap: 'wrap', gap: 14 }}>
        <span>{MODE_KA[v.mode]}: <strong>{Number(v.coverage_pct)}%</strong></span>
        {v.mode === 'fixed' && <span>თანხა: <strong>{n2(v.fixed_amount)}</strong></span>}
        {v.mode === 'drg' && <span>საბაზისო განაკვეთი: <strong>{n2(v.drg_base_rate)}</strong></span>}
        <span>ლიმიტი: <strong>{v.limit_amount === null ? '—' : n2(v.limit_amount)}</strong></span>
        <span>ფრანშიზა: <strong>{n2(v.deductible)}</strong></span>
        <span>თანაგადახდა: <strong>{n2(v.copay_amount)}</strong></span>
        {v.writeoff_excess && <span className="chip">ტარიფს ზემოთ — ჩამოწერა</span>}
      </div>
      {(v.excluded_categories.length > 0 || v.excluded_codes.length > 0) && <div className="small"><span className="muted">არ ფარავს:</span> {[...v.excluded_categories, ...v.excluded_codes.map((c) => `კოდი ${c}`)].join(', ')}</div>}
      {v.clauses.length > 0 && (
        <table className="table small">
          <thead><tr><th>#</th><th>პირობა</th><th>შედეგი</th></tr></thead>
          <tbody>{v.clauses.map((c) => (
            <tr key={c.seq}><td className="mono">{c.seq}</td>
              <td>{c.label && <strong>{c.label}<br /></strong>}{[c.categories.length ? `კატეგორია: ${c.categories.join(', ')}` : '', c.codes.length ? `კოდი: ${c.codes.join(', ')}` : '',
                c.age_min !== null || c.age_max !== null ? `ასაკი: ${c.age_min ?? 0}–${c.age_max ?? '∞'}` : '', c.sex ? (c.sex === 'male' ? 'მამრ.' : 'მდედრ.') : '', c.dx_prefixes.length ? `ICD-10: ${c.dx_prefixes.join(', ')}` : '']
                .filter(Boolean).join(' · ') || 'ყველა ხაზი'}</td>
              <td>{c.effect === 'exclude' ? <span className="chip danger">არ ფარავს</span> : <span className="chip ok">{c.coverage_pct !== null ? `${Number(c.coverage_pct)}%` : 'ვერსიის %'}{c.line_limit !== null ? ` · ხაზზე ≤ ${n2(c.line_limit)}` : ''}</span>}</td></tr>))}</tbody>
        </table>)}
      {v.notes && <div className="small muted">{v.notes}</div>}
    </div>
  );
}
