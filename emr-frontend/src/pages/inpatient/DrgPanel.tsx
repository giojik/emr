import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, can, type Role } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Field, Modal, useDebounced, useToast } from '../../components/ui';
import { tsDate } from '../../lib/format';
import { useModuleEnabled } from '../../lib/modules';
import { PriceView } from '../admin/drg/DrgFormula';
import type { Price } from '../admin/drg/types';

/** DRG შემთხვევაზე (0055): შეთავაზება და „რატომ“, დადასტურება / შეცვლა მიზეზით / გაუქმება */
export const DRG_STAY_READ: Role[] = ['admin', 'billing', 'drg', 'drg_admin', 'receptionist', 'manager', 'doctor', 'viewer', 'accountant'];
const LEVEL_KA: Record<string, string> = { none: 'არა', cc: 'CC', mcc: 'MCC' };
const DX_KA: Record<string, string> = { primary: 'ძირითადი', secondary: 'თანმხლები', complication: 'გართულება', admission: 'მიღების' };

interface Cond { text: string; ok: boolean; why: string }
interface Scheme {
  scheme: { id: string; code: string; name: string };
  version: { id: string; label: string; valid_from: string; status: string; version_no: number } | null;
  version_date: string; stale: boolean; stale_reason: string | null;
  current: { id: string; status: string; final_code: string; final_weight: string; suggested_code: string | null; reason: string | null; confirmed_at: string; confirmed_by_name: string; title: string | null } | null;
  result: { code: string | null; title: string | null; weight: number | null; rule_seq: number | null; rule_label: string | null; fallback: boolean; cc_level: string;
    issues: { code: string; message: string }[];
    trace: { cc: { code: string; level: string; counted: boolean; why?: string }[]; matched?: { seq: number; label: string | null; conds: Cond[] };
      skipped: { seq: number; drg_code: string; label: string | null; failed: string; why: string }[]; skipped_total: number } } | null;
  inputs: { pdx: string | null; sdx: string[]; procs: string[]; services: string[]; surgery: boolean; age: number | null; age_days: number | null; sex: string | null; los: number;
    icu_hours: number; vent_hours: number; discharge_ka: string | null; source_ka: string | null; los_bed_days: number; los_calendar: number;
    dx: { code: string; title: string; type: string; role: string }[]; proc_list: { case_no: string; code: string; ncsp: string | null; name: string; primary: boolean; from: string }[];
    service_list: { code: string; title: string }[] } | null;
  payers: { id: string; payer_name: string; drg_code: string | null; drg_weight: string | null; drg_source: string | null; drg_base_rate?: string | null; price: (Price & { version_label?: string }) | null }[];
}
interface DrgView {
  enabled: boolean; finalized: boolean; no_drg_payer: boolean; test_version: boolean;
  settings: { confirm_required: boolean; recheck_on_finalize: string; manual_payer_drg: string };
  can: { confirm: boolean; admin: boolean; money?: boolean }; schemes: Scheme[];
}
interface HistoryRow { id: string; scheme_code: string; version_label: string; status: string; final_code: string; final_weight: string; suggested_code: string | null; reason: string | null;
  confirmed_at: string; confirmed_by_name: string; superseded_at: string | null; supersede_reason: string | null; superseded_by_name: string | null; rule_text: string | null }

export default function DrgPanel({ encounterId, onChanged }: { encounterId: string; onChanged: () => void }) {
  const { user } = useAuth();
  const on = useModuleEnabled('drg');
  const visible = on && can(user, ...DRG_STAY_READ);
  const q = useQuery({ queryKey: ['drg-stay', encounterId], queryFn: () => api<DrgView>(`/drg/stays/${encounterId}`), enabled: visible });
  if (!visible || !q.data) return q.error ? <ErrorBox error={q.error} /> : null;
  return (
    <div id="drg" className="stack" style={{ gap: 10 }}>
      {q.data.schemes.map((s) => <SchemeBlock key={s.scheme.id} eid={encounterId} v={q.data} s={s} onChanged={onChanged} />)}
    </div>
  );
}

function SchemeBlock({ eid, v, s, onChanged }: { eid: string; v: DrgView; s: Scheme; onChanged: () => void }) {
  const qc = useQueryClient(); const toast = useToast();
  const [dlg, setDlg] = useState<null | 'override' | 'reset' | 'history'>(null);
  const inval = () => { void qc.invalidateQueries({ queryKey: ['drg-stay', eid] }); void qc.invalidateQueries({ queryKey: ['drg-stay-history', eid] }); onChanged(); };
  const confirm = useMutation({
    mutationFn: () => api<{ code: string; payers_updated: number }>(`/drg/stays/${eid}/confirm`, { body: { scheme_id: s.scheme.id } }),
    onSuccess: (r) => { toast.show(`DRG ${r.code} დადასტურდა${r.payers_updated ? ` · გადამხდელი: ${r.payers_updated}` : ''}`); inval(); },
  });
  const r = s.result; const cur = s.current;
  const sameAsCurrent = !!cur && !!r?.code && cur.final_code === r.code && !s.stale;
  const status = !s.version ? <span className="chip">ვერსია არ არის</span>
    : cur ? (s.stale ? <span className="chip warn">შეიცვალა — დაადასტურეთ ხელახლა</span> : cur.status === 'overridden' ? <span className="chip warn">დადასტურებულია (შეცვლილი)</span> : <span className="chip ok">დადასტურებულია</span>)
    : <span className="chip info">დასადასტურებელი</span>;
  return (
    <section className="card-pad stack" style={{ gap: 10, border: '1px solid var(--line)', borderRadius: 10 }}>
      {toast.node}
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ margin: 0 }} className="grow">DRG <span className="small muted" style={{ fontWeight: 400 }}>· {s.scheme.name}{s.version && <> · {s.version.label} (მოქმ. {s.version.valid_from})</>}</span></h3>
        {status}
        <button className="btn sm" type="button" onClick={() => setDlg('history')}>ისტორია</button>
      </div>
      {!s.version && <span className="small muted">სქემას {s.version_date}-ზე მოქმედი ვერსია არ აქვს — DRG ჯგუფი ირჩევა ხელით (გადამხდელის ფორმაში). ვერსიები: ადმინისტრირება → DRG.</span>}
      {v.no_drg_payer && s.version && <span className="small muted">DRG რეჟიმის გადამხდელი არ არის — შეთავაზება საინფორმაციოა.</span>}
      {s.stale && <div className="chip warn" style={{ height: 'auto', padding: '6px 10px', whiteSpace: 'normal' }}>{s.stale_reason}{r?.code && cur && r.code !== cur.final_code && <> — ახალი შეთავაზება <strong className="mono">{r.code}</strong>, დადასტურებულია <strong className="mono">{cur.final_code}</strong></>}</div>}

      {s.version && r && <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 14 }}>
        <div className="stack" style={{ gap: 6 }}>
          <span className="small muted">შეთავაზება</span>
          {r.code ? <div><strong className="mono" style={{ fontSize: 18 }}>{r.code}</strong> {r.title} <span className="small muted">· წონა {r.weight}</span>
            {r.fallback && <span className="chip warn" style={{ marginLeft: 6 }}>ნაგულისხმევი</span>}</div>
            : <strong>ვერ დაჯგუფდა</strong>}
          {r.issues.map((i) => <span key={i.code} className="small" style={{ color: 'var(--warn-ink, #8a5a00)' }}>⚠ {i.message}</span>)}
          {r.trace.matched && <div className="small stack" style={{ gap: 2 }}>
            <span className="muted">წესი #{r.trace.matched.seq}{r.trace.matched.label && ` — ${r.trace.matched.label}`}</span>
            {r.trace.matched.conds.length === 0 ? <span className="muted">პირობების გარეშე</span> : r.trace.matched.conds.map((c, i) => <span key={i}>✓ <span className="mono">{c.text}</span> <span className="muted">({c.why})</span></span>)}
          </div>}
          <span className="small">სიმძიმე: <strong>{LEVEL_KA[r.cc_level]}</strong>{r.trace.cc.length > 0 && <span className="muted"> — {r.trace.cc.map((c) => `${c.code} ${c.level.toUpperCase()}${c.counted ? '' : ` (არ ითვლება: ${c.why})`}`).join('; ')}</span>}</span>
          {r.trace.skipped_total > 0 && <details className="small"><summary className="muted">გამოტოვებული წესები ({r.trace.skipped_total})</summary>
            <div className="stack" style={{ gap: 2, marginTop: 4 }}>{r.trace.skipped.map((x) => <span key={x.seq}>#{x.seq} <span className="mono">{x.drg_code}</span> — ✗ <span className="mono">{x.failed}</span> <span className="muted">({x.why})</span></span>)}
              {r.trace.skipped_total > r.trace.skipped.length && <span className="muted">… და კიდევ {r.trace.skipped_total - r.trace.skipped.length}</span>}</div></details>}
        </div>
        <div className="stack" style={{ gap: 6 }}>
          <span className="small muted">დადასტურებული</span>
          {cur ? <div><strong className="mono" style={{ fontSize: 18 }}>{cur.final_code}</strong> {cur.title} <span className="small muted">· წონა {Number(cur.final_weight)}</span>
            <div className="small muted">{cur.confirmed_by_name} · {tsDate(cur.confirmed_at)}{cur.status === 'overridden' && <> · შეთავაზება იყო {cur.suggested_code ?? '—'}</>}</div>
            {cur.reason && <div className="small">მიზეზი: {cur.reason}</div>}</div> : <span className="small muted">—</span>}
          {s.payers.length > 0 && <span className="small">გადამხდელი: {s.payers.map((p) => `${p.payer_name} — ${p.drg_code ?? '—'}${p.drg_weight ? ` (${Number(p.drg_weight)})` : ''}`).join('; ')}</span>}
          {s.payers.filter((p) => p.price).map((p) => <div key={p.id} className="stack" style={{ gap: 2, marginTop: 4 }}>
            <span className="small muted">DRG თანხა{s.payers.length > 1 ? ` — ${p.payer_name}` : ''}{v.finalized ? ' (დაფიქსირებული)' : ' (მიმდინარე)'}</span><PriceView p={p.price!} compact /></div>)}
          {v.can.confirm && <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
            {r.code && !sameAsCurrent && <button className="btn sm primary" type="button" disabled={confirm.isPending} onClick={() => confirm.mutate()}>დადასტურება: {r.code}</button>}
            <button className="btn sm" type="button" onClick={() => setDlg('override')}>სხვა ჯგუფი…</button>
            {cur && <button className="btn sm" type="button" onClick={() => setDlg('reset')}>დადასტურების გაუქმება</button>}
          </div>}
          <ErrorBox error={confirm.error} />
        </div>
      </div>}

      {s.inputs && <details className="small"><summary className="muted">მონაცემები, რომლითაც დაჯგუფდა</summary>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10, marginTop: 6 }}>
          <div className="stack" style={{ gap: 2 }}>
            <strong>დიაგნოზები</strong>
            {s.inputs.dx.length === 0 ? <span className="muted">—</span> : s.inputs.dx.map((d, i) => <span key={i} style={d.role === 'other' ? { opacity: 0.6 } : undefined}>
              <span className="mono">{d.code}</span> {d.title} <span className="muted">· {DX_KA[d.type] ?? d.type}{d.role === 'pdx' ? ' → ძირითადი (PDX)' : d.role === 'sdx' ? ' → თანმხლები' : ' → არ ითვლება'}</span></span>)}
            <strong style={{ marginTop: 6 }}>პროცედურები / ოპერაციები</strong>
            {s.inputs.proc_list.length === 0 ? <span className="muted">—</span> : s.inputs.proc_list.map((p, i) => <span key={i}>{p.case_no}: <span className="mono">{p.ncsp ?? '—'}</span> / <span className="mono">{p.code}</span> {p.name}
              <span className="muted">{p.from === 'plan' ? ' (გეგმიდან — ოქმი ხელმოუწერელია)' : ''}</span></span>)}
            <span className="muted">შედარების კოდები: {s.inputs.procs.join(', ') || '—'}</span>
          </div>
          <div className="stack" style={{ gap: 2 }}>
            <span>ასაკი: {s.inputs.age ?? '—'} წ ({s.inputs.age_days ?? '—'} დ) · სქესი: {s.inputs.sex === 'M' ? 'მამრ.' : s.inputs.sex === 'F' ? 'მდედრ.' : '—'}</span>
            <span>ხანგრძლივობა: <strong>{s.inputs.los}</strong> დ <span className="muted">(საწოლდღე {s.inputs.los_bed_days}, კალენდარული {s.inputs.los_calendar})</span></span>
            <span>ICU: {s.inputs.icu_hours} სთ · ვენტილაცია: {s.inputs.vent_hours} სთ · ოპერაცია: {s.inputs.surgery ? 'კი' : 'არა'}</span>
            <span>მიღება: {s.inputs.source_ka ?? '—'} · გაწერა: {s.inputs.discharge_ka ?? '— (არ არის გაწერილი)'}</span>
            <span className="muted">მომსახურების კოდები ინვოისში: {s.inputs.service_list.length}</span>
          </div>
        </div></details>}

      {dlg === 'override' && s.version && <OverrideDialog eid={eid} s={s} onClose={() => setDlg(null)} onDone={() => { toast.show('DRG შეიცვალა'); inval(); }} />}
      {dlg === 'reset' && <ResetDialog eid={eid} schemeId={s.scheme.id} onClose={() => setDlg(null)} onDone={() => { toast.show('დადასტურება გაუქმდა'); inval(); }} />}
      {dlg === 'history' && <HistoryDialog eid={eid} onClose={() => setDlg(null)} />}
    </section>
  );
}

function OverrideDialog({ eid, s, onClose, onDone }: { eid: string; s: Scheme; onClose: () => void; onDone: () => void }) {
  const [q, setQ] = useState(''); const dq = useDebounced(q.trim(), 250);
  const [code, setCode] = useState(''); const [reason, setReason] = useState('');
  const groups = useQuery({ queryKey: ['drg-v-groups', s.version!.id, dq], queryFn: () => api<{ rows: { code: string; title: string; weight: string; kind: string }[] }>(`/drg/versions/${s.version!.id}/groups`, { query: { q: dq, limit: 40 } }) });
  const differs = !!code && code !== s.result?.code;
  const m = useMutation({ mutationFn: () => api(`/drg/stays/${eid}/confirm`, { body: { scheme_id: s.scheme.id, code, reason: reason.trim() || undefined } }), onSuccess: () => { onDone(); onClose(); } });
  return (
    <Modal title="DRG ჯგუფის არჩევა" onClose={onClose} width={680}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button>
        <button className="btn primary" type="button" disabled={!code || (differs && reason.trim().length < 5) || m.isPending} onClick={() => m.mutate()}>დადასტურება</button></>}>
      <div className="stack" style={{ gap: 10 }}>
        <span className="small muted">შეთავაზება: <strong className="mono">{s.result?.code ?? '—'}</strong>. სხვა ჯგუფს სჭირდება მიზეზი (აუდიტში ინახება).</span>
        <input className="input" placeholder="კოდი ან დასახელება" value={q} onChange={(e) => setQ(e.target.value)} aria-label="ძებნა" />
        <div style={{ maxHeight: 260, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 8 }}>
          {groups.data?.rows.map((g) => <button key={g.code} type="button" onClick={() => setCode(g.code)} aria-pressed={code === g.code}
            style={{ display: 'flex', width: '100%', justifyContent: 'space-between', gap: 8, padding: '6px 12px', border: 0, borderBottom: '1px solid var(--line-soft)', font: 'inherit', textAlign: 'left', cursor: 'pointer',
              background: code === g.code ? 'var(--accent-soft, #e8f0ff)' : 'transparent', color: 'var(--ink)' }}>
            <span><span className="mono">{g.code}</span> {g.title}{g.code === s.result?.code && <span className="chip info" style={{ marginLeft: 6 }}>შეთავაზება</span>}</span><span className="mono small">{Number(g.weight).toFixed(4)}</span></button>)}
          {groups.data?.rows.length === 0 && <div className="empty">ვერ მოიძებნა.</div>}
        </div>
        <Field label="მიზეზი" htmlFor="drg-or" required={differs} hint={differs ? 'მინ. 5 სიმბოლო' : undefined}>
          <input id="drg-or" className="input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} /></Field>
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}

function ResetDialog({ eid, schemeId, onClose, onDone }: { eid: string; schemeId: string; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const m = useMutation({ mutationFn: () => api(`/drg/stays/${eid}/reset`, { body: { scheme_id: schemeId, reason: reason.trim() } }), onSuccess: () => { onDone(); onClose(); } });
  return (
    <Modal title="DRG დადასტურების გაუქმება" onClose={onClose}
      footer={<><button className="btn" type="button" onClick={onClose}>დახურვა</button><button className="btn primary" type="button" disabled={reason.trim().length < 5 || m.isPending} onClick={() => m.mutate()}>გაუქმება</button></>}>
      <div className="stack" style={{ gap: 10 }}>
        <span className="small muted">გადამხდელის DRG კოდი რჩება; ფინალიზაციისას საჭირო იქნება ხელახლა დადასტურება (თუ სავალდებულოა).</span>
        <Field label="მიზეზი" htmlFor="drg-rs" required><input id="drg-rs" className="input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} /></Field>
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}

function HistoryDialog({ eid, onClose }: { eid: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['drg-stay-history', eid], queryFn: () => api<HistoryRow[]>(`/drg/stays/${eid}/history`) });
  return (
    <Modal title="DRG — ისტორია" onClose={onClose} width={860}>
      <ErrorBox error={q.error} />
      {q.data?.length === 0 ? <div className="empty">დადასტურება ჯერ არ ყოფილა.</div> : (
        <table className="table">
          <thead><tr><th>როდის / ვინ</th><th>ჯგუფი</th><th>შეთავაზება / წესი</th><th>სტატუსი</th></tr></thead>
          <tbody>{q.data?.map((h) => <tr key={h.id} style={h.superseded_at ? { opacity: 0.6 } : undefined}>
            <td className="small">{tsDate(h.confirmed_at)}<div className="muted">{h.confirmed_by_name}</div></td>
            <td><strong className="mono">{h.final_code}</strong> <span className="small muted">· {Number(h.final_weight)}</span><div className="small muted">{h.scheme_code} · {h.version_label}</div></td>
            <td className="small"><span className="mono">{h.suggested_code ?? '—'}</span>{h.rule_text && <div className="muted mono">{h.rule_text}</div>}{h.reason && <div>მიზეზი: {h.reason}</div>}</td>
            <td className="small">{h.status === 'overridden' ? 'შეცვლილი' : 'დადასტურებული'}{h.superseded_at && <div className="muted">ჩანაცვლდა {tsDate(h.superseded_at)}{h.superseded_by_name && ` · ${h.superseded_by_name}`}{h.supersede_reason && ` — ${h.supersede_reason}`}</div>}</td>
          </tr>)}</tbody>
        </table>)}
    </Modal>
  );
}
