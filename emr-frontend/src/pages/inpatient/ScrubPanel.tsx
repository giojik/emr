import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, can, type Role } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Field, Modal, useToast } from '../../components/ui';
import { tsDate } from '../../lib/format';
import { useModuleEnabled } from '../../lib/modules';

/** ქლეიმის შემოწმება (0057): ჰოსპიტალიზაციის ბილინგში — პრობლემების სია, გამონაკლისი (მიზეზით), გაუქმება */
export const SCRUB_READ: Role[] = ['admin', 'billing', 'drg', 'drg_admin', 'accountant', 'viewer', 'receptionist', 'manager'];
const OVERRIDE: Role[] = ['admin', 'billing', 'drg'];
export interface Issue {
  code: string; group: string; title: string; message: string; severity: 'error' | 'warn'; payer_id: string | null; payer_name: string | null; detail: string | null;
  allow_override: boolean; overridden: { id: string; reason: string; by: string; at: string } | null;
}
interface ScrubView { enabled: boolean; settings: { finalize_check: string; claim_check: string }; invoice_id: string; checked: boolean; issues: Issue[]; errors: number; warnings: number; overridden: number }
const MODE_KA: Record<string, string> = { off: 'არ მოწმდება', warn: 'გაფრთხილება', block: 'ბლოკავს' };

export default function ScrubPanel({ encounterId, onChanged }: { encounterId: string; onChanged: () => void }) {
  const { user } = useAuth(); const qc = useQueryClient(); const toast = useToast();
  const on = useModuleEnabled('scrubber');
  const visible = on && can(user, ...SCRUB_READ);
  const q = useQuery({ queryKey: ['scrub-stay', encounterId], queryFn: () => api<ScrubView>(`/scrub/stays/${encounterId}`), enabled: visible });
  const [dlg, setDlg] = useState<null | { add: Issue } | { revoke: Issue }>(null);
  if (!visible || !q.data) return q.error ? <ErrorBox error={q.error} /> : null;
  const v = q.data;
  if (!v.checked) return null;
  const inval = () => { void qc.invalidateQueries({ queryKey: ['scrub-stay', encounterId] }); onChanged(); };
  const canOv = can(user, ...OVERRIDE);
  return (
    <section id="scrub" className="card-pad stack" style={{ gap: 8, border: '1px solid var(--line)', borderRadius: 10 }}>
      {toast.node}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }} className="grow">შემოწმება გადამხდელთან გაგზავნამდე</h3>
        {v.errors > 0 ? <span className="chip danger">✗ შეცდომა: {v.errors}</span> : <span className="chip ok">შეცდომა არ არის</span>}
        {v.warnings > 0 && <span className="chip warn">⚠ {v.warnings}</span>}
        {v.overridden > 0 && <span className="chip info">გამონაკლისი: {v.overridden}</span>}
        <span className="small muted">ფინალიზაცია — {MODE_KA[v.settings.finalize_check]}, ქლეიმი — {MODE_KA[v.settings.claim_check]}</span>
      </div>
      {v.issues.length === 0 ? <span className="small muted">პრობლემა არ ფიქსირდება.</span> : (
        <table className="table">
          <tbody>{v.issues.map((i, k) => (
            <tr key={`${i.code}-${i.payer_id ?? ''}-${k}`} style={i.overridden ? { opacity: 0.6 } : undefined}>
              <td style={{ width: 28 }}>{i.overridden ? '↷' : i.severity === 'error' ? <span style={{ color: 'var(--danger, #b00020)' }}>✗</span> : '⚠'}</td>
              <td><strong>{i.message}</strong>{i.detail && <span className="small muted"> — {i.detail}</span>}
                {i.payer_name && <div className="small muted">გადამხდელი: {i.payer_name}</div>}
                {i.overridden && <div className="small">გამონაკლისი: {i.overridden.reason} <span className="muted">({i.overridden.by}, {tsDate(i.overridden.at)})</span></div>}</td>
              <td className="num" style={{ whiteSpace: 'nowrap' }}>
                {canOv && !i.overridden && i.allow_override && <button className="btn sm" type="button" onClick={() => setDlg({ add: i })}>გამონაკლისი…</button>}
                {canOv && i.overridden && <button className="btn sm" type="button" onClick={() => setDlg({ revoke: i })}>გაუქმება</button>}
                {!i.allow_override && !i.overridden && i.severity === 'error' && <span className="small muted">საჭიროა გასწორება</span>}
              </td>
            </tr>))}</tbody>
        </table>)}
      {can(user, 'admin', 'drg_admin') && <span className="small muted">წესები — <Link to="/admin/scrubber">ადმინისტრირება → ქლეიმის შემოწმება</Link></span>}
      {dlg && 'add' in dlg && <ReasonModal title={`გამონაკლისი: ${dlg.add.message}`} hint="შეცდომა აღარ დაბლოკავს ფინალიზაციას / ქლეიმს ამ შემთხვევაზე. მიზეზი და ავტორი ინახება აუდიტში."
        run={(reason) => api('/scrub/overrides', { body: { invoice_id: v.invoice_id, rule_code: dlg.add.code, payer_id: dlg.add.payer_id, reason } })}
        onClose={() => setDlg(null)} onDone={() => { toast.show('გამონაკლისი დაშვებულია'); inval(); }} />}
      {dlg && 'revoke' in dlg && <ReasonModal title={`გამონაკლისის გაუქმება: ${dlg.revoke.message}`}
        run={(reason) => api(`/scrub/overrides/${dlg.revoke.overridden!.id}/revoke`, { body: { reason } })}
        onClose={() => setDlg(null)} onDone={() => { toast.show('გამონაკლისი გაუქმდა'); inval(); }} />}
    </section>
  );
}

function ReasonModal({ title, hint, run, onClose, onDone }: { title: string; hint?: string; run: (reason: string) => Promise<unknown>; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const m = useMutation({ mutationFn: () => run(reason.trim()), onSuccess: () => { onDone(); onClose(); } });
  return (
    <Modal title={title} onClose={onClose} footer={<><button className="btn" type="button" onClick={onClose}>დახურვა</button>
      <button className="btn primary" type="button" disabled={reason.trim().length < 5 || m.isPending} onClick={() => m.mutate()}>შენახვა</button></>}>
      <div className="stack" style={{ gap: 10 }}>
        {hint && <span className="small muted">{hint}</span>}
        <Field label="მიზეზი" htmlFor="sc-r" required hint="მინ. 5 სიმბოლო"><input id="sc-r" className="input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} /></Field>
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}
