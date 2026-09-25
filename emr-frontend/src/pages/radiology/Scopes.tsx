import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import type { EndoScope } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Field, Loading, Modal, useToast } from '../../components/ui';
import { hhmm, SCOPE_STATE, SCOPE_TYPE_KA, tsDate } from '../../lib/format';

interface HistoryEvent { kind: 'use' | 'reprocess'; at: string; first_name?: string; last_name?: string; personal_number?: string | null; service_name?: string; accession_number?: string | null;
  method?: string; machine?: string | null; disinfectant?: string | null; leak_test?: boolean; result?: string; note?: string | null; performed_by_name?: string }

/** ენდოსკოპები: მზადყოფნა, დეზინფექციის ჩაწერა, მიკვლევადობა */
export default function Scopes() {
  const { user } = useAuth();
  const canManage = user?.role === 'admin' || user?.role === 'endoscopy_nurse';
  const [all, setAll] = useState(false);
  const [edit, setEdit] = useState<EndoScope | 'new' | null>(null);
  const [reproc, setReproc] = useState<EndoScope | null>(null);
  const [hist, setHist] = useState<EndoScope | null>(null);
  const q = useQuery({ queryKey: ['endo-scopes', all], queryFn: () => api<EndoScope[]>('/endo/scopes', { query: { include_inactive: all } }), refetchInterval: 30_000 });
  const rows = q.data ?? [];
  return (
    <div className="content grow" style={{ minWidth: 0 }}>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <span className="muted grow">{rows.filter((r) => r.state === 'ready').length} მზადაა · {rows.filter((r) => r.state !== 'ready').length} საჭიროებს დეზინფექციას. პროცედურაზე მხოლოდ დეზინფიცირებული ენდოსკოპი ჩაიწერება.</span>
        <label className="row small"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> გათიშულებიც</label>
        {canManage && <button className="btn primary" type="button" onClick={() => setEdit('new')}>+ ენდოსკოპი</button>}
      </div>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : !rows.length ? <div className="card empty">ენდოსკოპები არ არის — დაამატეთ რეესტრში (სერიული ნომრით).</div> : (
        <div className="card">
          <table className="table">
            <thead><tr><th>ენდოსკოპი</th><th>ტიპი</th><th>S/N</th><th>სტატუსი</th><th>ბოლო გამოყენება</th><th>ბოლო დეზინფექცია</th><th /></tr></thead>
            <tbody>{rows.map((s) => {
              const [cls, label] = SCOPE_STATE[s.state];
              return (
                <tr key={s.id} style={s.is_active ? undefined : { opacity: 0.5 }}>
                  <td><strong>{s.name}</strong>{s.note && <div className="small muted">{s.note}</div>}</td>
                  <td>{SCOPE_TYPE_KA[s.scope_type] ?? s.scope_type}</td>
                  <td className="mono small">{s.serial_number}</td>
                  <td><span className={`chip ${cls}`}>{label}</span></td>
                  <td className="small">{s.last_used_at ? `${tsDate(s.last_used_at)} ${hhmm(s.last_used_at)}` : '—'}</td>
                  <td className="small">{s.last_reproc_at ? `${tsDate(s.last_reproc_at)} ${hhmm(s.last_reproc_at)}` : '—'}</td>
                  <td className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                    {s.is_active && <button className={`btn sm${s.state !== 'ready' ? ' primary' : ''}`} type="button" onClick={() => setReproc(s)}>დეზინფექცია</button>}
                    <button className="btn sm" type="button" onClick={() => setHist(s)}>ისტორია</button>
                    {canManage && <button className="btn sm" type="button" onClick={() => setEdit(s)}>რედაქტირება</button>}
                  </td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      )}
      {edit && <ScopeDialog s={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
      {reproc && <ReprocessDialog s={reproc} onClose={() => setReproc(null)} />}
      {hist && <HistoryDialog s={hist} onClose={() => setHist(null)} />}
    </div>
  );
}

function ScopeDialog({ s, onClose }: { s: EndoScope | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ name: s?.name ?? '', scope_type: s?.scope_type ?? 'gastroscope', serial_number: s?.serial_number ?? '', note: s?.note ?? '', is_active: s?.is_active ?? true });
  const m = useMutation({
    mutationFn: () => s ? api(`/endo/scopes/${s.id}`, { method: 'PATCH', body: { ...f, note: f.note || null } }) : api('/endo/scopes', { body: { name: f.name, scope_type: f.scope_type, serial_number: f.serial_number, note: f.note || null } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['endo-scopes'] }); onClose(); },
  });
  return (
    <Modal title={s ? s.name : 'ახალი ენდოსკოპი'} onClose={onClose} width={560}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="submit" form="scf" disabled={m.isPending || f.name.trim().length < 2 || f.serial_number.trim().length < 2}>შენახვა</button></>}>
      <form id="scf" className="stack" style={{ gap: 12 }} onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <Field label="დასახელება" htmlFor="scn" required><input id="scn" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="მაგ. Olympus GIF-H190 #1" /></Field>
        <Field label="ტიპი" htmlFor="sct"><select id="sct" className="select" value={f.scope_type} onChange={(e) => setF({ ...f, scope_type: e.target.value })}>{Object.entries(SCOPE_TYPE_KA).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="სერიული ნომერი" htmlFor="scs" required><input id="scs" className="input mono" value={f.serial_number} onChange={(e) => setF({ ...f, serial_number: e.target.value })} /></Field>
        <Field label="შენიშვნა" htmlFor="sco"><input id="sco" className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
        {s && <label className="row"><input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> აქტიური</label>}
        <ErrorBox error={m.error} />
      </form>
    </Modal>
  );
}

function ReprocessDialog({ s, onClose }: { s: EndoScope; onClose: () => void }) {
  const qc = useQueryClient(); const toast = useToast();
  const last = (() => { try { return JSON.parse(localStorage.getItem('emr.reproc') ?? '{}') as { machine?: string; disinfectant?: string }; } catch { return {}; } })();
  const [f, setF] = useState({ method: 'aer' as 'aer' | 'manual', machine: last.machine ?? '', disinfectant: last.disinfectant ?? '', leak_test: false, result: 'passed' as 'passed' | 'failed', note: '' });
  const m = useMutation({
    mutationFn: () => { try { localStorage.setItem('emr.reproc', JSON.stringify({ machine: f.machine, disinfectant: f.disinfectant })); } catch { /* */ } return api(`/endo/scopes/${s.id}/reprocess`, { body: { ...f, machine: f.machine || null, disinfectant: f.disinfectant || null, note: f.note || null } }); },
    onSuccess: () => { toast.show('ჩაიწერა'); void qc.invalidateQueries({ queryKey: ['endo-scopes'] }); onClose(); },
  });
  return (
    <Modal title={`დეზინფექცია — ${s.name}`} onClose={onClose} width={560}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={m.isPending || (f.result === 'passed' && !f.leak_test) || (f.result === 'failed' && !f.note.trim())} onClick={() => m.mutate()}>ჩაწერა</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <span className="small muted">S/N {s.serial_number} · ბოლო გამოყენება: {s.last_used_at ? `${tsDate(s.last_used_at)} ${hhmm(s.last_used_at)}` : '—'}</span>
        <div className="seg" role="group" aria-label="მეთოდი" style={{ width: 'max-content' }}>
          <button type="button" aria-pressed={f.method === 'aer'} onClick={() => setF({ ...f, method: 'aer' })}>სარეცხი მანქანა (AER)</button>
          <button type="button" aria-pressed={f.method === 'manual'} onClick={() => setF({ ...f, method: 'manual' })}>ხელით</button>
        </div>
        <Field label={f.method === 'aer' ? 'მანქანა / ციკლის №' : 'შენიშვნა (აბაზანა, დრო)'} htmlFor="rpm"><input id="rpm" className="input" value={f.machine} onChange={(e) => setF({ ...f, machine: e.target.value })} /></Field>
        <Field label="სადეზინფექციო საშუალება / სერია" htmlFor="rpd"><input id="rpd" className="input" value={f.disinfectant} onChange={(e) => setF({ ...f, disinfectant: e.target.value })} /></Field>
        <label className="row"><input type="checkbox" checked={f.leak_test} onChange={(e) => setF({ ...f, leak_test: e.target.checked })} /> გაჟონვის ტესტი ჩატარდა და გავიდა</label>
        <div className="row">
          <label className="row"><input type="radio" name="rr" checked={f.result === 'passed'} onChange={() => setF({ ...f, result: 'passed' })} /> ციკლი წარმატებულია</label>
          <label className="row"><input type="radio" name="rr" checked={f.result === 'failed'} onChange={() => setF({ ...f, result: 'failed' })} /> ჩავარდა</label>
        </div>
        {f.result === 'failed' && <input aria-label="მიზეზი" className="input" style={{ height: 36 }} placeholder="მიზეზი *" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />}
        <ErrorBox error={m.error} />
      </div>
      {toast.node}
    </Modal>
  );
}

function HistoryDialog({ s, onClose }: { s: EndoScope; onClose: () => void }) {
  const q = useQuery({ queryKey: ['scope-history', s.id], queryFn: () => api<{ events: HistoryEvent[] }>(`/endo/scopes/${s.id}/history`) });
  return (
    <Modal title={`მიკვლევადობა — ${s.name} (S/N ${s.serial_number})`} onClose={onClose} width={820} footer={<button className="btn" type="button" onClick={onClose}>დახურვა</button>}>
      <span className="hint">ქრონოლოგია (ახლიდან ძველისკენ): რომელ პაციენტებზე გამოიყენეს ენდოსკოპი და დეზინფექციის ციკლები მათ შორის.</span>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : (
        <table className="table small">
          <tbody>{(q.data?.events ?? []).map((e, i) => (
            <tr key={i} style={e.kind === 'reprocess' ? { background: e.result === 'failed' ? 'var(--danger-weak)' : 'var(--ok-weak)' } : undefined}>
              <td className="mono" style={{ whiteSpace: 'nowrap' }}>{tsDate(e.at)} {hhmm(e.at)}</td>
              {e.kind === 'use'
                ? <><td><strong>პროცედურა</strong></td><td>{e.last_name} {e.first_name} {e.personal_number && <span className="mono muted">{e.personal_number}</span>}</td><td>{e.service_name} <span className="mono muted">{e.accession_number}</span></td></>
                : <><td><strong>დეზინფექცია</strong></td><td>{e.method === 'aer' ? 'AER' : 'ხელით'}{e.machine ? ` · ${e.machine}` : ''}{e.disinfectant ? ` · ${e.disinfectant}` : ''} · გაჟონვის ტესტი: {e.leak_test ? 'კი' : 'არა'}</td>
                  <td>{e.result === 'passed' ? 'წარმატებული' : `ჩავარდა${e.note ? `: ${e.note}` : ''}`} · {e.performed_by_name}</td></>}
            </tr>))}</tbody>
        </table>
      )}
    </Modal>
  );
}
