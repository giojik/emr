import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { ErrorBox, Field, Loading, Modal, useToast } from '../../components/ui';
import { time, tsDate } from '../../lib/format';

interface Settings { enabled: boolean; auto_send: boolean; encrypt_pdf: boolean; email_subject: string; email_body: string; sms_email_sent: string; sms_ready: string; configured: { email: boolean; sms: boolean } }
interface LogRow { id: string; channel: 'email' | 'sms'; recipient: string; status: 'sent' | 'failed'; error: string | null; trigger: 'auto' | 'manual'; attachments: number; created_at: string; sent_by_name: string | null }

/** ვიზიტზე: პასუხის გაგზავნა პაციენტს (ხელით) + ჟურნალი */
export function DeliveryDialog({ encounterId, email, phone, onClose }: { encounterId: string; email?: string | null; phone?: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const s = useQuery({ queryKey: ['lab-delivery-settings'], queryFn: () => api<Settings>('/lab/delivery/settings') });
  const log = useQuery({ queryKey: ['lab-deliveries', encounterId], queryFn: () => api<LogRow[]>(`/encounters/${encounterId}/lab-deliveries`) });
  const [f, setF] = useState({ email: true, sms: true, email_to: email ?? '', phone_to: phone ?? '' });
  const m = useMutation({ mutationFn: () => api<{ results: { channel: string; status: string; error: string | null }[] }>(`/encounters/${encounterId}/lab-deliveries`,
    { body: { email: f.email, sms: f.sms, email_to: f.email && f.email_to.trim() ? f.email_to.trim() : null, phone_to: f.sms && f.phone_to.trim() ? f.phone_to.replace(/\s/g, '') : null } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['lab-deliveries', encounterId] }) });
  return (
    <Modal title="პასუხის გაგზავნა პაციენტს" onClose={onClose} width={680}
      footer={<><button className="btn" type="button" onClick={onClose}>დახურვა</button>
        <button className="btn primary" type="button" disabled={!s.data?.enabled || (!f.email && !f.sms) || m.isPending} onClick={() => m.mutate()}>გაგზავნა</button></>}>
      {s.data && !s.data.enabled && <div className="alert warn small">პასუხის მიწოდება გამორთულია (ადმინისტრირება → „პასუხის მიწოდება“).</div>}
      <label className="row"><input type="checkbox" checked={f.email} onChange={(e) => setF({ ...f, email: e.target.checked })} /> ელ-ფოსტით — PDF{s.data?.encrypt_pdf ? ' (პაროლით: პ/ნ-ის ბოლო 4 ციფრი)' : ''}</label>
      {f.email && <Field label="ელ-ფოსტა" htmlFor="dem"><input id="dem" className="input" type="email" value={f.email_to} onChange={(e) => setF({ ...f, email_to: e.target.value })} /></Field>}
      <label className="row"><input type="checkbox" checked={f.sms} onChange={(e) => setF({ ...f, sms: e.target.checked })} /> SMS შეტყობინება</label>
      {f.sms && <Field label="ტელეფონი" htmlFor="dph"><input id="dph" className="input mono" value={f.phone_to} onChange={(e) => setF({ ...f, phone_to: e.target.value })} /></Field>}
      {m.data && <div className="stack small" style={{ gap: 2 }}>{m.data.results.map((r, i) => <span key={i} className={`chip ${r.status === 'sent' ? 'ok' : 'danger'}`}>{r.channel === 'email' ? 'ელ-ფოსტა' : 'SMS'}: {r.status === 'sent' ? 'გაიგზავნა' : r.error}</span>)}</div>}
      <ErrorBox error={m.error} />
      <strong className="small">ჟურნალი</strong>
      {log.isLoading ? <Loading /> : !log.data?.length ? <span className="small muted">ჯერ არაფერი გაგზავნილა.</span> : <table className="table"><tbody>{log.data.map((r) => (
        <tr key={r.id}><td className="small mono" style={{ whiteSpace: 'nowrap' }}>{tsDate(r.created_at)} {time(r.created_at)}</td>
          <td className="small">{r.channel === 'email' ? 'ელ-ფოსტა' : 'SMS'}{r.attachments ? ` · ${r.attachments} PDF` : ''}</td><td className="small mono">{r.recipient}</td>
          <td>{r.status === 'sent' ? <span className="chip ok">გაიგზავნა</span> : <span className="chip danger" title={r.error ?? ''}>ვერ გაიგზავნა</span>}{r.error && <div className="small muted">{r.error}</div>}</td>
          <td className="small muted">{r.trigger === 'auto' ? 'ავტომატური' : r.sent_by_name}</td></tr>))}</tbody></table>}
    </Modal>
  );
}

/** ადმინისტრირება → „პასუხის მიწოდება“ */
export default function DeliverySettings() {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['lab-delivery-settings'], queryFn: () => api<Settings>('/lab/delivery/settings') });
  const [f, setF] = useState<Settings | null>(null);
  useEffect(() => { if (q.data && !f) setF(q.data); }, [q.data, f]);
  const save = useMutation({ mutationFn: () => { const { configured: _c, ...rest } = f!; void _c; return api<Settings>('/lab/delivery/settings', { method: 'PUT', body: { enabled: rest.enabled, auto_send: rest.auto_send, encrypt_pdf: rest.encrypt_pdf,
    email_subject: rest.email_subject, email_body: rest.email_body, sms_email_sent: rest.sms_email_sent, sms_ready: rest.sms_ready } }); },
    onSuccess: (r) => { setF(r); void qc.invalidateQueries({ queryKey: ['lab-delivery-settings'] }); toast.show('შენახულია'); } });
  if (!f) return <div className="content"><Loading /></div>;
  return (
    <div className="content stack" style={{ maxWidth: 820 }}>
      <div className={`alert ${f.enabled ? 'ok' : 'warn'}`}><strong>{f.enabled ? 'ჩართულია' : 'გამორთულია'}</strong> — ლაბორატორიული პასუხის მიწოდება პაციენტს: ელ-ფოსტით დაშიფრული PDF, SMS-ით შეტყობინება (ბმულისა და საჯარო გვერდის გარეშე).
        მხოლოდ პაციენტებზე, ვისაც ბარათში თანხმობა აქვს.</div>
      <div className="row small" style={{ gap: 14 }}>SMTP: {f.configured.email ? <span className="chip ok">კონფიგურირებულია</span> : <span className="chip danger">არა</span>} SMS: {f.configured.sms ? <span className="chip ok">კონფიგურირებულია</span> : <span className="chip danger">არა</span>}</div>
      <section className="card card-pad stack">
        <label className="row"><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> <strong>მიწოდება ჩართულია</strong></label>
        <label className="row"><input type="checkbox" checked={f.auto_send} onChange={(e) => setF({ ...f, auto_send: e.target.checked })} /> ავტომატურად — როცა ვიზიტის ყველა ლაბ. ანალიზი დადასტურდება (ერთხელ)</label>
        <label className="row"><input type="checkbox" checked={f.encrypt_pdf} onChange={(e) => setF({ ...f, encrypt_pdf: e.target.checked })} /> PDF-ის დაშიფვრა (პაროლი — პირადი ნომრის ბოლო 4 ციფრი) — რეკომენდებული</label>
        <Field label="ელ-ფოსტის თემა" htmlFor="ds"><input id="ds" className="input" value={f.email_subject} onChange={(e) => setF({ ...f, email_subject: e.target.value })} /></Field>
        <Field label="ელ-ფოსტის ტექსტი" htmlFor="db" hint="ცვლადები: {name}, {date}, {clinic}, {phone}, {password_hint}"><textarea id="db" className="textarea" rows={7} value={f.email_body} onChange={(e) => setF({ ...f, email_body: e.target.value })} /></Field>
        <Field label="SMS — როცა ელ-ფოსტაც გაიგზავნა" htmlFor="dse"><input id="dse" className="input" value={f.sms_email_sent} onChange={(e) => setF({ ...f, sms_email_sent: e.target.value })} /></Field>
        <Field label="SMS — მხოლოდ შეტყობინება (ელ-ფოსტის გარეშე)" htmlFor="dsr"><input id="dsr" className="input" value={f.sms_ready} onChange={(e) => setF({ ...f, sms_ready: e.target.value })} /></Field>
        <ErrorBox error={save.error} />
        <div className="row"><button className="btn primary" type="button" disabled={save.isPending} onClick={() => save.mutate()}>შენახვა</button></div>
      </section>
      {toast.node}
    </div>
  );
}
