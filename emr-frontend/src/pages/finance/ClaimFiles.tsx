import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api, apiUpload, can } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Field, Loading, Modal } from '../../components/ui';
import { tsDate } from '../../lib/format';
import { ACTION_KA, type DenialReason, downloadFile, type ExportRow, type ImportResult, kb, type Preview, RESP_CHIP, RESP_KA, type RespStatus, type TemplateRow, TPL_EDIT } from './claimExport';
import { type Claim, type ClaimItem, CLAIM_RESOLVE, fmt } from './types';

/** 0058: ქლეიმის ფაილი (შაბლონით) — გადახედვა, ექსპორტი, ჟურნალი */
export function ExportDialog({ claim, onClose }: { claim: Claim; onClose: () => void }) {
  const { user } = useAuth(); const qc = useQueryClient();
  const tpls = useQuery({ queryKey: ['ctpl', 'export'], queryFn: () => api<TemplateRow[]>('/claim-templates', { query: { kind: 'export' } }) });
  const [tid, setTid] = useState<string | undefined>(undefined);
  const pv = useQuery({ queryKey: ['claim-export-pv', claim.id, tid], queryFn: () => api<Preview>(`/finance/claims/${claim.id}/export-preview`, { query: { template_id: tid } }), retry: false });
  const hist = useQuery({ queryKey: ['claim-exports', claim.id], queryFn: () => api<ExportRow[]>(`/finance/claims/${claim.id}/exports`) });
  const [note, setNote] = useState('');
  const sel = tid ?? pv.data?.template.id ?? '';
  const exp = useMutation({
    mutationFn: () => api<{ id: string; file_name: string }>(`/finance/claims/${claim.id}/exports`, { body: { template_id: sel || undefined, note: note.trim() || null } }),
    onSuccess: async (r) => { setNote(''); void qc.invalidateQueries({ queryKey: ['claim-exports', claim.id] }); await downloadFile(`/finance/claim-exports/${r.id}/file`, r.file_name); },
  });
  const dl = useMutation({ mutationFn: (x: ExportRow) => downloadFile(`/finance/claim-exports/${x.id}/file`, x.file_name) });
  const edit = can(user, ...TPL_EDIT);
  return (
    <Modal title={`ფაილი გადამხდელისთვის — ${claim.claim_no ?? 'მონახაზი'} · ${claim.payer_name}`} onClose={onClose} width={1200}>
      <div className="stack" style={{ gap: 12 }}>
        <div className="row" style={{ flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
          <Field label="შაბლონი" htmlFor="ex-t"><select id="ex-t" className="select" style={{ minWidth: 320 }} value={sel} onChange={(e) => setTid(e.target.value)}>
            {!sel && <option value="">— აირჩიეთ —</option>}
            {tpls.data?.filter((t) => t.is_active || t.id === sel).map((t) => <option key={t.id} value={t.id}>{t.name} · {t.format} · v{t.revision}</option>)}</select></Field>
          {pv.data && <span className="small">ფაილი: <span className="mono">{pv.data.file_name}</span> · {pv.data.rows} ხაზი · {fmt(pv.data.total)} ₾</span>}
          <span className="grow" />
          {edit && <Field label="შენიშვნა (ჟურნალში)" htmlFor="ex-n"><input id="ex-n" className="input" style={{ minWidth: 220 }} value={note} onChange={(e) => setNote(e.target.value)} /></Field>}
          {edit && <button className="btn primary" type="button" disabled={!pv.data?.can_export || exp.isPending} onClick={() => exp.mutate()}>ექსპორტი და ჩამოტვირთვა</button>}
        </div>
        {claim.status === 'draft' && <div className="alert warn">მონახაზი — მხოლოდ გადახედვა. ფაილი იქმნება გაგზავნის შემდეგ (ქლეიმს ენიჭება №).</div>}
        {pv.data?.scrub.errors.length ? <div className="alert danger">შემოწმება: {pv.data.scrub.errors.length} შემთხვევას აქვს შეცდომა — ექსპორტი დაბლოკილია ({pv.data.scrub.errors.slice(0, 3).map((x) => x.invoice_number).join(', ')}…)</div>
          : pv.data?.scrub.warnings ? <span className="small muted">შემოწმება: გაფრთხილება — {pv.data.scrub.warnings} შემთხვევაზე (ფაილში ჩაიწერება ჟურნალში)</span> : null}
        <ErrorBox error={pv.error ?? exp.error ?? dl.error} />
        {pv.isFetching ? <Loading /> : pv.data && (
          <div style={{ overflow: 'auto', maxHeight: 340 }}>
            <table className="table">
              <thead><tr>{pv.data.header.map((h, i) => <th key={i} className="small" style={{ whiteSpace: 'nowrap' }}>{h || <span className="muted">#{i + 1}</span>}</th>)}</tr></thead>
              <tbody>{pv.data.preview.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className="mono small" style={{ whiteSpace: 'nowrap' }}>{c}</td>)}</tr>)}</tbody>
            </table>
            {pv.data.rows > pv.data.preview.length && <span className="small muted">ნაჩვენებია {pv.data.preview.length} / {pv.data.rows}</span>}
          </div>)}
        <section className="stack" style={{ gap: 6 }}>
          <strong>ექსპორტის ჟურნალი</strong>
          {hist.data?.length ? (
            <table className="table">
              <thead><tr><th>დრო</th><th>ფაილი</th><th>შაბლონი</th><th className="num">ხაზი</th><th className="num">ჯამი</th><th>sha256</th><th>ავტორი</th><th /></tr></thead>
              <tbody>{hist.data.map((x) => (
                <tr key={x.id}><td className="small mono">{tsDate(x.created_at)} {new Date(x.created_at).toLocaleTimeString('ka-GE', { hour: '2-digit', minute: '2-digit' })}</td>
                  <td className="mono small">{x.file_name} <span className="muted">({kb(x.size)})</span>{x.note && <div className="muted">{x.note}</div>}</td>
                  <td className="small">{x.template_name} v{x.template_revision}</td><td className="num">{x.rows}</td><td className="num mono">{fmt(x.total)}</td>
                  <td className="mono small" title={x.sha256}>{x.sha256.slice(0, 12)}…{x.scrub_warnings > 0 && <span className="chip warn" style={{ marginLeft: 4 }}>⚠ {x.scrub_warnings}</span>}</td>
                  <td className="small">{x.created_by_name}</td>
                  <td><button className="btn sm" type="button" onClick={() => dl.mutate(x)}>ჩამოტვირთვა</button></td></tr>))}</tbody>
            </table>) : <span className="small muted">ექსპორტი ჯერ არ ყოფილა</span>}
        </section>
      </div>
    </Modal>
  );
}

/** პასუხის ჩიპი შემთხვევის ხაზზე */
export function RespChip({ x }: { x: ClaimItem }) {
  if (!x.resp_status) return <span className="muted">—</span>;
  const t = [x.resp_reason_title && `მიზეზი: ${x.resp_reason} — ${x.resp_reason_title}`, x.resp_note, x.resp_ref && `№ ${x.resp_ref}`].filter(Boolean).join('\n');
  return <span className={`chip ${RESP_CHIP[x.resp_status]}`} title={t || undefined}>{RESP_KA[x.resp_status]}{x.resp_status === 'partial' && x.resp_amount ? ` ${fmt(x.resp_amount)}` : ''}
    {x.resp_reason && x.resp_status !== 'accepted' ? ` · ${x.resp_reason}` : ''}</span>;
}

/** პასუხის ჩაწერა / შეცვლა ხელით */
export function ResponseForm({ item, onClose, onDone }: { item: ClaimItem; onClose: () => void; onDone: (c: Claim) => void }) {
  const reasons = useQuery({ queryKey: ['denial-reasons', 'active'], queryFn: () => api<DenialReason[]>('/denial-reasons', { query: { active: 1 } }) });
  const [st, setSt] = useState<RespStatus>(item.resp_status ?? 'accepted');
  const [amount, setAmount] = useState(item.resp_amount ?? ''); const [reason, setReason] = useState(item.resp_reason ?? '');
  const [note, setNote] = useState(item.resp_note ?? ''); const [ref, setRef] = useState(item.resp_ref ?? '');
  const m = useMutation({
    mutationFn: (clear?: boolean) => api<Claim>(`/finance/claim-items/${item.id}/response`, { method: 'PUT', body: clear ? { status: null }
      : { status: st, amount: st === 'partial' ? Number(amount) : undefined, reason: reason || null, note: note.trim() || null, ref: ref.trim() || null } }),
    onSuccess: onDone,
  });
  const need = st === 'partial' || st === 'rejected';
  return (
    <form className="stack card-pad" style={{ background: 'var(--surface-2)' }} onSubmit={(e) => { e.preventDefault(); m.mutate(false); }}>
      <strong>გადამხდელის პასუხი — {item.patient} ({item.invoice_number}), მოთხოვნილი {fmt(item.claimed)} ₾</strong>
      <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end', gap: 10 }}>
        <div className="seg" role="group" aria-label="პასუხი">{(['accepted', 'partial', 'rejected', 'pending'] as RespStatus[]).map((s) =>
          <button key={s} type="button" aria-pressed={st === s} onClick={() => setSt(s)}>{RESP_KA[s]}</button>)}</div>
        {st === 'partial' && <Field label="დამტკიცებული (₾)" htmlFor="rp-a"><input id="rp-a" className="input mono" inputMode="decimal" style={{ width: 130 }} value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>}
        <Field label="უარის მიზეზი" htmlFor="rp-r" required={need}><select id="rp-r" className="select" style={{ minWidth: 260 }} value={reason} onChange={(e) => setReason(e.target.value)}>
          <option value="">—</option>{reasons.data?.map((r) => <option key={r.code} value={r.code}>{r.code} — {r.title}{r.default_action ? ` (${ACTION_KA[r.default_action]})` : ''}</option>)}</select></Field>
        <Field label="გადამხდელის №" htmlFor="rp-f"><input id="rp-f" className="input mono" style={{ width: 140 }} value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
        <Field label="შენიშვნა" htmlFor="rp-n"><input id="rp-n" className="input" style={{ minWidth: 200 }} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <button className="btn" type="button" onClick={onClose}>გაუქმება</button>
        {item.resp_status && <button className="btn" type="button" disabled={m.isPending} onClick={() => m.mutate(true)}>პასუხის მოხსნა</button>}
        <button className="btn primary" type="submit" disabled={m.isPending || (need && !reason) || (st === 'partial' && !(Number(amount) > 0))}>შენახვა</button>
      </div>
      <span className="hint">პასუხი თანხას არ ცვლის: ფული — „ანაზღაურება“, უარის თანხა — „გადაწყვეტა“ (ან „უარების გადაწყვეტა“ მიზეზის ნაგულისხმევი ქმედებით).</span>
      <ErrorBox error={m.error} />
    </form>
  );
}

/** პასუხის ფაილის იმპორტი: შემოწმება (dry-run) → ჩაწერა */
export function ImportDialog({ claim, onClose, onDone }: { claim: Claim; onClose: () => void; onDone: () => void }) {
  const tpls = useQuery({ queryKey: ['ctpl', 'response'], queryFn: () => api<TemplateRow[]>('/claim-templates', { query: { kind: 'response' } }) });
  const hist = useQuery({ queryKey: ['claim-resp-imports', claim.id], queryFn: () => api<{ id: string; file_name: string; rows: number; applied: number; problems: unknown[]; created_at: string; created_by_name: string; template_name: string | null }[]>(`/finance/claims/${claim.id}/response-imports`) });
  const [tid, setTid] = useState(''); const [file, setFile] = useState<File | null>(null);
  const [res, setRes] = useState<ImportResult | null>(null);
  const inp = useRef<HTMLInputElement>(null);
  const run = useMutation({
    mutationFn: (commit: boolean) => { const fd = new FormData(); fd.append('file', file!); return apiUpload<ImportResult>(`/finance/claims/${claim.id}/responses/import?commit=${commit}${tid ? `&template_id=${tid}` : ''}`, fd); },
    onSuccess: (r) => { setRes(r); if (!r.dry_run) onDone(); },
  });
  return (
    <Modal title={`პასუხის იმპორტი — ${claim.claim_no} · ${claim.payer_name}`} onClose={onClose} width={1080}>
      <div className="stack" style={{ gap: 12 }}>
        <div className="row" style={{ flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
          <Field label="შაბლონი" htmlFor="im-t" hint="ცარიელი — გადამხდელის ნაგულისხმევი"><select id="im-t" className="select" style={{ minWidth: 280 }} value={tid} onChange={(e) => { setTid(e.target.value); setRes(null); }}>
            <option value="">ნაგულისხმევი</option>{tpls.data?.filter((t) => t.is_active).map((t) => <option key={t.id} value={t.id}>{t.name} · {t.format}</option>)}</select></Field>
          <Field label="ფაილი (csv / xlsx)" htmlFor="im-f"><input id="im-f" ref={inp} className="input" type="file" accept=".csv,.txt,.xlsx" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setRes(null); }} /></Field>
          <button className="btn" type="button" disabled={!file || run.isPending} onClick={() => run.mutate(false)}>შემოწმება</button>
          <button className="btn primary" type="button" disabled={!file || !res?.dry_run || !res.matched || run.isPending} onClick={() => run.mutate(true)}>ჩაწერა ({res?.dry_run ? res.matched : 0})</button>
        </div>
        <ErrorBox error={run.error} />
        {res && (
          <div className="stack" style={{ gap: 8 }}>
            <div className={`alert ${res.dry_run ? 'info' : 'ok'}`}>{res.dry_run ? 'შემოწმება (ჯერ არ ჩაწერილა)' : 'ჩაიწერა'}: ხაზი {res.rows} · დაემთხვა {res.matched} · პრობლემა {res.problems} ·
              {' '}{(Object.keys(res.by_status) as RespStatus[]).filter((s) => res.by_status[s]).map((s) => `${RESP_KA[s]} ${res.by_status[s]}`).join(', ') || '—'}
              {res.not_in_file > 0 && ` · ფაილში არ არის: ${res.not_in_file} შემთხვევა`}</div>
            <div style={{ maxHeight: 320, overflow: 'auto' }}>
              <table className="table">
                <thead><tr><th className="num">ხაზი</th><th>გასაღები</th><th>შემთხვევა</th><th>პასუხი</th><th className="num">თანხა</th><th>მიზეზი</th><th>შენიშვნა / პრობლემა</th></tr></thead>
                <tbody>{res.lines.map((l) => (
                  <tr key={l.row} style={l.problem ? { background: 'var(--danger-soft, #fdecec)' } : undefined}>
                    <td className="num mono">{l.row}</td><td className="mono small">{l.key}</td><td className="small">{l.patient ?? '—'}{l.invoice_number && <div className="muted mono">{l.invoice_number}</div>}</td>
                    <td>{l.status ? <span className={`chip ${RESP_CHIP[l.status]}`}>{RESP_KA[l.status]}</span> : '—'}</td><td className="num mono">{l.amount === null || l.amount === undefined ? '—' : fmt(l.amount)}</td>
                    <td className="mono small">{l.reason ?? '—'}</td><td className="small">{l.problem ? <strong style={{ color: 'var(--danger-ink)' }}>{l.problem}</strong> : l.warn ? <span style={{ color: 'var(--warn-ink, #8a5a00)' }}>{l.warn}</span> : l.note ?? ''}</td>
                  </tr>))}</tbody>
              </table>
            </div>
          </div>)}
        {!!hist.data?.length && (
          <section className="stack" style={{ gap: 6 }}>
            <strong>იმპორტის ჟურნალი</strong>
            <table className="table"><tbody>{hist.data.map((h) => <tr key={h.id}><td className="small mono">{tsDate(h.created_at)}</td><td className="mono small">{h.file_name}</td><td className="small">{h.template_name ?? '—'}</td>
              <td className="small">ხაზი {h.rows} · ჩაიწერა {h.applied} · პრობლემა {h.problems.length}</td><td className="small">{h.created_by_name}</td></tr>)}</tbody></table>
          </section>)}
        <span className="hint">ფაილის სვეტები და სტატუსები — შაბლონში (ადმინისტრირება → ქლეიმის ფაილები → პასუხის შაბლონები). ჩაწერა ცვლის მხოლოდ ფაილში არსებული შემთხვევების პასუხს.</span>
      </div>
    </Modal>
  );
}

/** პასუხის შეჯამება ქლეიმის თავში */
export function RespSummary({ c, onApply, applying }: { c: Claim; onApply: () => void; applying: boolean }) {
  const { user } = useAuth();
  const r = c.responses;
  if (!r || r.none === c.items.length) return null;
  const open = c.items.filter((x) => (x.resp_status === 'rejected' || x.resp_status === 'partial') && !x.resolution);
  const auto = open.filter((x) => x.resp_default_action).length;
  return (
    <div className="row small" style={{ flexWrap: 'wrap', gap: 10 }}>
      <strong>პასუხი:</strong>
      {(['accepted', 'partial', 'rejected', 'pending'] as RespStatus[]).filter((s) => r[s]).map((s) => <span key={s} className={`chip ${RESP_CHIP[s]}`}>{RESP_KA[s]} {r[s]}</span>)}
      {r.none > 0 && <span className="chip">უპასუხო {r.none}</span>}
      <span>დამტკიცებული <strong className="mono">{fmt(r.approved)}</strong> · უარი <strong className="mono" style={r.denied ? { color: 'var(--danger-ink)' } : undefined}>{fmt(r.denied)}</strong></span>
      {open.length > 0 && <span className="muted">გადასაწყვეტი უარი: {open.length}</span>}
      {can(user, ...CLAIM_RESOLVE) && auto > 0 && ['sent', 'partial'].includes(c.status) &&
        <button className="btn sm" type="button" disabled={applying} title="მიზეზის ნაგულისხმევი ქმედებით (პაციენტზე / ჩამოწერა)" onClick={onApply}>უარების გადაწყვეტა ({auto})</button>}
    </div>
  );
}
