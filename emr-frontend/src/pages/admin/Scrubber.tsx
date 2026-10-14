import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, can } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Field, Loading, Modal, useToast } from '../../components/ui';
import { tsDate } from '../../lib/format';
import { useModules } from '../../lib/modules';
import type { Payer } from './BillingSetup';

/**
 * ადმინისტრირება → ქლეიმის შემოწმება (0057): მზა წესები (ჩართვა, სიმძიმე, გავრცელება, პარამეტრები, ტექსტი, გამონაკლისი)
 * და საკუთარი წესები (პირობები ტექსტით — DRG-ის ველები). ცვლილება — მაშინვე, აუდიტით.
 */
interface Rule {
  code: string; builtin: boolean; grp: string; group_ka: string; title: string; message: string | null; severity: 'error' | 'warn'; is_active: boolean; applies_kind: string;
  payer_kinds: string[]; payer_ids: string[]; params: Record<string, unknown>; conditions_text: string | null; allow_override: boolean; payer_scoped: boolean;
  updated_at: string; updated_by_name: string | null;
}
interface Meta { groups: Record<string, string>; builtin_params: Record<string, { key: string; label: string; type: 'int' | 'patterns' }[]>; fields: Record<string, { label: string }>; examples: string[] }
const KIND_KA: Record<string, string> = { insurance: 'დაზღვევა', state: 'სახელმწიფო', other: 'სხვა' };
const APPLIES_KA: Record<string, string> = { ipd: 'სტაციონარი', opd: 'ამბულატორია', all: 'ორივე' };
const MODE_KA: Record<string, string> = { off: 'არ მოწმდება', warn: 'მხოლოდ გაფრთხილება', block: 'შეცდომა ბლოკავს' };

export default function Scrubber() {
  const { user } = useAuth(); const edit = can(user, 'admin', 'drg_admin');
  const qc = useQueryClient(); const toast = useToast();
  const rules = useQuery({ queryKey: ['scrub-rules'], queryFn: () => api<Rule[]>('/scrub/rules') });
  const meta = useQuery({ queryKey: ['scrub-meta'], queryFn: () => api<Meta>('/scrub/meta'), staleTime: Infinity });
  const payers = useQuery({ queryKey: ['payers', false], queryFn: () => api<Payer[]>('/billing/payers') });
  const mods = useModules(); const mod = mods.data?.find((m) => m.code === 'scrubber');
  const [dlg, setDlg] = useState<Rule | 'new' | null>(null);
  const patch = useMutation({ mutationFn: (x: { code: string; body: Record<string, unknown> }) => api(`/scrub/rules/${x.code}`, { method: 'PATCH', body: x.body }),
    onSuccess: () => { toast.show('შენახულია'); void qc.invalidateQueries({ queryKey: ['scrub-rules'] }); } });
  if (rules.isLoading) return <div className="content"><Loading /></div>;
  const groups = [...new Set((rules.data ?? []).map((r) => r.grp))];
  const pname = (id: string) => payers.data?.find((p) => p.id === id)?.name ?? id.slice(0, 8);
  return (
    <div className="content stack" style={{ gap: 14 }}>
      {toast.node}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <span className="hint grow">შემთხვევა მოწმდება გადამხდელთან გაგზავნამდე: სტაციონარის ფინანსური დახურვისას და ქლეიმში დამატება / გაგზავნისას. „შეცდომა“ ბლოკავს (თუ რეჟიმი „ბლოკავს“),
          „გაფრთხილება“ — მხოლოდ ჩანს. შეცდომაზე ბილინგს შეუძლია გამონაკლისის დაშვება მიზეზით (თუ წესი უშვებს).</span>
        {mod && <span className={`chip ${mod.enabled ? 'ok' : ''}`}>{mod.enabled ? `ფინალიზაცია: ${MODE_KA[String(mod.settings.finalize_check)]} · ქლეიმი: ${MODE_KA[String(mod.settings.claim_check)]}` : 'მოდული გამორთულია'}</span>}
        {can(user, 'admin') && <Link className="btn sm" to="/admin/modules">რეჟიმი (მოდულები)</Link>}
        {edit && <button className="btn primary" type="button" onClick={() => setDlg('new')}>+ საკუთარი წესი</button>}
      </div>
      <ErrorBox error={rules.error ?? patch.error} />
      {groups.map((g) => (
        <section key={g} className="card">
          <div className="card-head"><strong>{meta.data?.groups[g] ?? g}</strong></div>
          <table className="table">
            <thead><tr><th style={{ width: 70 }}>ჩართ.</th><th>წესი</th><th style={{ width: 170 }}>სიმძიმე</th><th>გავრცელება</th><th>პარამეტრები</th><th style={{ width: 110 }}>გამონაკლისი</th><th /></tr></thead>
            <tbody>{rules.data!.filter((r) => r.grp === g).map((r) => (
              <tr key={r.code} style={r.is_active ? undefined : { opacity: 0.55 }}>
                <td><input type="checkbox" aria-label={`ჩართვა — ${r.title}`} disabled={!edit} checked={r.is_active} onChange={(e) => patch.mutate({ code: r.code, body: { is_active: e.target.checked } })} /></td>
                <td><strong>{r.title}</strong>{r.message && <div className="small">ტექსტი: {r.message}</div>}
                  <div className="small muted mono">{r.code} · {APPLIES_KA[r.applies_kind]}{r.payer_scoped ? ' · გადამხდელზე' : ''}{r.conditions_text ? ` · ${r.conditions_text}` : ''}</div></td>
                <td><select className="select" style={{ minWidth: 175 }} aria-label={`სიმძიმე — ${r.title}`} disabled={!edit} value={r.severity} onChange={(e) => patch.mutate({ code: r.code, body: { severity: e.target.value } })}>
                  <option value="error">✗ შეცდომა</option><option value="warn">⚠ გაფრთხილება</option></select></td>
                <td className="small">{!r.payer_kinds.length && !r.payer_ids.length ? <span className="muted">ყველა გადამხდელი</span>
                  : [...r.payer_kinds.map((k) => KIND_KA[k]), ...r.payer_ids.map(pname)].join(', ')}</td>
                <td className="small">{Object.entries(r.params ?? {}).map(([k, v]) => `${meta.data?.builtin_params[r.code]?.find((p) => p.key === k)?.label ?? k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`).join(' · ') || '—'}</td>
                <td className="small">{r.allow_override ? 'დაშვებულია' : <span className="muted">არა</span>}</td>
                <td className="num"><button className="btn sm" type="button" onClick={() => setDlg(r)}>{edit ? 'შეცვლა' : 'ნახვა'}</button></td>
              </tr>))}</tbody>
          </table>
        </section>))}
      {dlg && meta.data && <RuleDialog r={dlg === 'new' ? null : dlg} meta={meta.data} payers={payers.data ?? []} edit={edit} onClose={() => setDlg(null)}
        onDone={() => { toast.show('შენახულია'); void qc.invalidateQueries({ queryKey: ['scrub-rules'] }); }} />}
    </div>
  );
}

function RuleDialog({ r, meta, payers, edit, onClose, onDone }: { r: Rule | null; meta: Meta; payers: Payer[]; edit: boolean; onClose: () => void; onDone: () => void }) {
  const custom = !r || !r.builtin;
  const [f, setF] = useState({ code: r?.code ?? 'X_', title: r?.title ?? '', message: r?.message ?? '', severity: r?.severity ?? 'warn', is_active: r?.is_active ?? true,
    allow_override: r?.allow_override ?? true, kinds: r?.payer_kinds ?? [], ids: r?.payer_ids ?? [], cond: r?.conditions_text ?? '' });
  const pdefs = r ? meta.builtin_params[r.code] ?? [] : [];
  const [params, setParams] = useState<Record<string, string>>(Object.fromEntries(pdefs.map((p) => [p.key, Array.isArray(r?.params?.[p.key]) ? (r!.params[p.key] as string[]).join(', ') : String(r?.params?.[p.key] ?? '')])));
  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { message: f.message.trim() || null, severity: f.severity, is_active: f.is_active, allow_override: f.allow_override, payer_kinds: f.kinds, payer_ids: f.ids };
      if (custom) { body.title = f.title.trim(); body.conditions_text = f.cond; }
      if (pdefs.length) body.params = Object.fromEntries(pdefs.filter((p) => params[p.key]?.trim()).map((p) => [p.key, p.type === 'int' ? Number(params[p.key]) : params[p.key].split(/[\s,;]+/).filter(Boolean)]));
      return r ? api(`/scrub/rules/${r.code}`, { method: 'PATCH', body }) : api('/scrub/rules', { body: { ...body, code: f.code.trim().toUpperCase() } });
    },
    onSuccess: () => { onDone(); onClose(); },
  });
  const del = useMutation({ mutationFn: () => api(`/scrub/rules/${r!.code}`, { method: 'DELETE' }), onSuccess: () => { onDone(); onClose(); } });
  const tog = (k: 'kinds' | 'ids', v: string) => setF({ ...f, [k]: f[k].includes(v) ? f[k].filter((x) => x !== v) : [...f[k], v] });
  return (
    <Modal title={r ? r.title : 'საკუთარი წესი'} onClose={onClose} width={860}
      footer={<>{edit && r && !r.builtin && <button className="btn" type="button" disabled={del.isPending} onClick={() => del.mutate()}>წაშლა</button>}<span className="grow" />
        <button className="btn" type="button" onClick={onClose}>დახურვა</button>{edit && <button className="btn primary" type="button" disabled={save.isPending} onClick={() => save.mutate()}>შენახვა</button>}</>}>
      <div className="stack" style={{ gap: 12 }}>
        {custom && <div style={{ display: 'grid', gridTemplateColumns: '220px minmax(0, 1fr)', gap: 10 }}>
          <Field label="კოდი" htmlFor="sr-c" required hint="იწყება X_-ით"><input id="sr-c" className="input mono" disabled={!!r || !edit} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
          <Field label="დასახელება" htmlFor="sr-t" required><input id="sr-t" className="input" disabled={!edit} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        </div>}
        <Field label="ტექსტი ბილინგისთვის" htmlFor="sr-m" hint="ცარიელი — დასახელება"><input id="sr-m" className="input" disabled={!edit} value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} /></Field>
        <div className="row" style={{ gap: 18, flexWrap: 'wrap' }}>
          <Field label="სიმძიმე" htmlFor="sr-s"><select id="sr-s" className="select" disabled={!edit} value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value as 'error' | 'warn' })}>
            <option value="error">✗ შეცდომა (ბლოკავს)</option><option value="warn">⚠ გაფრთხილება</option></select></Field>
          <label className="row small"><input type="checkbox" disabled={!edit} checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> ჩართულია</label>
          <label className="row small"><input type="checkbox" disabled={!edit} checked={f.allow_override} onChange={(e) => setF({ ...f, allow_override: e.target.checked })} /> გამონაკლისი დაშვებულია (მიზეზით)</label>
        </div>
        <div className="stack" style={{ gap: 4 }}><span className="small muted">გავრცელება (ცარიელი — ყველა გადამხდელი)</span>
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>{Object.entries(KIND_KA).map(([k, l]) => <label key={k} className="row small"><input type="checkbox" disabled={!edit} checked={f.kinds.includes(k)} onChange={() => tog('kinds', k)} /> {l}</label>)}</div>
          <div className="row" style={{ gap: 12, flexWrap: 'wrap', maxHeight: 120, overflow: 'auto' }}>{payers.filter((p) => p.is_active || f.ids.includes(p.id)).map((p) => <label key={p.id} className="row small">
            <input type="checkbox" disabled={!edit} checked={f.ids.includes(p.id)} onChange={() => tog('ids', p.id)} /> {p.name}</label>)}</div>
        </div>
        {pdefs.map((p) => <Field key={p.key} label={p.label} htmlFor={`sr-p-${p.key}`} hint={p.type === 'patterns' ? 'კოდი ან დიაპაზონი, მძიმით: O00-O99, N70-N98' : undefined}>
          <input id={`sr-p-${p.key}`} className="input mono" disabled={!edit} value={params[p.key] ?? ''} onChange={(e) => setParams({ ...params, [p.key]: e.target.value })} /></Field>)}
        {custom && <div className="stack" style={{ gap: 4 }}>
          <Field label="პირობები (ყველა სრულდება → პრობლემა)" htmlFor="sr-cd" required><textarea id="sr-cd" className="textarea mono" rows={3} disabled={!edit} value={f.cond} onChange={(e) => setF({ ...f, cond: e.target.value })} /></Field>
          <span className="small muted">მაგ.: {meta.examples.map((e) => <span key={e} className="mono" style={{ marginRight: 10 }}>{e}</span>)}</span>
          <span className="small muted">ველები: {Object.entries(meta.fields).map(([k, d]) => `${k} (${d.label})`).join(', ')}. სიები (@) აქ არ გამოიყენება — კოდები / დიაპაზონები.</span>
        </div>}
        {r?.updated_by_name && <span className="small muted">ბოლო ცვლილება: {r.updated_by_name} · {tsDate(r.updated_at)}</span>}
        <ErrorBox error={save.error ?? del.error} />
      </div>
    </Modal>
  );
}
