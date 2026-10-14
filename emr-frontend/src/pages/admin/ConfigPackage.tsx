import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, apiUpload, can } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Field, Loading } from '../../components/ui';
import { tsDate } from '../../lib/format';
import { downloadFile } from '../finance/claimExport';
import type { Scheme, VersionRow } from './drg/types';

interface Line { part: string; key: string; action: 'create' | 'update' | 'unchanged' | 'skip' | 'error'; detail?: string }
interface Plan { source: string | null; exported_at: string; sha256: string; parts: string[]; totals: Record<Line['action'], number>; lines: Line[]; applied?: boolean;
  drg_versions?: { key: string; id: string; version_no: number }[] }
const ACT: Record<Line['action'], [string, string]> = { create: ['ok', 'შეიქმნება'], update: ['warn', 'შეიცვლება'], unchanged: ['', 'უცვლელი'], skip: ['', 'გამოტოვდება'], error: ['danger', 'შეცდომა'] };
const ACT_DONE: Partial<Record<Line['action'], string>> = { create: 'შეიქმნა', update: 'შეიცვალა' };

/**
 * ადმინისტრირება → კონფიგურაციის პაკეტი (0059): DRG სქემები / ვერსიები, შემოწმების წესები, ფაილის შაბლონები, უარის მიზეზები, მოდულების პარამეტრები,
 * გადამხდელის მიბმა — ერთ JSON ფაილში. გადატანა (სატესტო → სამუშაო) და სარეზერვო ასლი. იმპორტი: გეგმა → ჩაწერა (მხოლოდ admin).
 */
export default function ConfigPackage() {
  const { user } = useAuth(); const admin = can(user, 'admin');
  const meta = useQuery({ queryKey: ['cfgpkg-meta'], queryFn: () => api<{ parts: { code: string; title: string }[] }>('/config-package/meta'), staleTime: Infinity });
  const schemes = useQuery({ queryKey: ['drg-schemes'], queryFn: () => api<Scheme[]>('/drg/schemes') });
  const [parts, setParts] = useState<string[] | null>(null);
  const sel = parts ?? meta.data?.parts.map((p) => p.code) ?? [];
  const [vids, setVids] = useState<string[]>([]);
  const exp = useMutation({ mutationFn: () => downloadFile(`/config-package?parts=${sel.join(',')}${vids.length ? `&drg_version_ids=${vids.join(',')}` : ''}`, `emr-config-${new Date().toISOString().slice(0, 10)}.json`) });
  const [file, setFile] = useState<File | null>(null);
  const [ip, setIp] = useState<string[] | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const run = useMutation({
    mutationFn: (commit: boolean) => { const fd = new FormData(); fd.append('file', file!); return apiUpload<Plan>(`/config-package/${commit ? 'import' : 'preview'}${ip ? `?parts=${ip.join(',')}` : ''}`, fd); },
    onSuccess: setPlan,
  });
  const errLines = (run.error as { body?: { lines?: Line[] } } | null)?.body?.lines;
  const tog = (a: string[], v: string) => (a.includes(v) ? a.filter((x) => x !== v) : [...a, v]);
  if (meta.isLoading) return <div className="content"><Loading /></div>;
  return (
    <div className="content stack" style={{ gap: 14 }}>
      <span className="hint">ერთი ფაილი — DRG ვერსიები, შემოწმების წესები, ფაილის შაბლონები, უარის მიზეზები, მოდულების პარამეტრები და გადამხდელის მიბმა. გამოიყენება სატესტო სერვერიდან სამუშაოზე
        გადასატანად და სარეზერვო ასლად. იმპორტისას ჯერ ჩანს გეგმა; DRG ვერსია იქმნება მონახაზად (გააქტიურება — ჩვეულებრივი წესით); პაციენტის მონაცემი ფაილში არ შედის.</span>
      <ErrorBox error={meta.error} />
      <section className="card card-pad stack" style={{ gap: 10 }}>
        <strong>ექსპორტი</strong>
        <div className="row" style={{ flexWrap: 'wrap', gap: 14 }}>{meta.data?.parts.map((p) =>
          <label key={p.code} className="row small"><input type="checkbox" checked={sel.includes(p.code)} onChange={() => setParts(tog(sel, p.code))} /> {p.title}</label>)}</div>
        {sel.includes('drg') && (
          <div className="stack" style={{ gap: 6 }}>
            <span className="small muted">DRG ვერსიები (არაფერი მონიშნული — თითო სქემის დღეს მოქმედი)</span>
            {schemes.data?.filter((s) => s.is_active).map((s) => <SchemeVersions key={s.id} s={s} vids={vids} onToggle={(id) => setVids(tog(vids, id))} />)}
          </div>)}
        <div className="row"><span className="grow" /><button className="btn primary" type="button" disabled={!sel.length || exp.isPending} onClick={() => exp.mutate()}>ფაილის ჩამოტვირთვა (JSON)</button></div>
        <ErrorBox error={exp.error} />
      </section>
      {admin ? (
        <section className="card card-pad stack" style={{ gap: 10 }}>
          <strong>იმპორტი</strong>
          <div className="row" style={{ flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
            <Field label="ფაილი (emr-config JSON)" htmlFor="cp-f"><input id="cp-f" className="input" type="file" accept=".json,application/json" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPlan(null); }} /></Field>
            <button className="btn" type="button" disabled={!file || run.isPending} onClick={() => run.mutate(false)}>გეგმა (შემოწმება)</button>
            <button className="btn primary" type="button" disabled={!file || !plan || plan.applied || plan.totals.error > 0 || !(plan.totals.create + plan.totals.update) || run.isPending}
              onClick={() => run.mutate(true)}>ჩაწერა ({plan && !plan.applied ? plan.totals.create + plan.totals.update : 0})</button>
          </div>
          {plan && <div className="row" style={{ flexWrap: 'wrap', gap: 14 }}>{meta.data?.parts.filter((p) => plan.parts.includes(p.code)).map((p) =>
            <label key={p.code} className="row small"><input type="checkbox" checked={(ip ?? plan.parts).includes(p.code)} onChange={() => { setIp(tog(ip ?? plan.parts, p.code)); setPlan(null); }} /> {p.title}</label>)}</div>}
          <ErrorBox error={run.error} />
          {errLines && <ul className="small" style={{ color: 'var(--danger-ink)', margin: 0 }}>{errLines.map((l, i) => <li key={i}>{l.key}: {l.detail}</li>)}</ul>}
          {plan && (
            <div className="stack" style={{ gap: 8 }}>
              <div className={`alert ${plan.applied ? 'ok' : plan.totals.error ? 'danger' : 'info'}`}>
                {plan.applied ? 'ჩაიწერა' : 'გეგმა (ჯერ არაფერი ჩაწერილა)'}: {plan.source ? `წყარო — ${plan.source}, ` : ''}{tsDate(plan.exported_at)} ·
                {' '}შეიქმნება {plan.totals.create} · შეიცვლება {plan.totals.update} · უცვლელი {plan.totals.unchanged}{plan.totals.skip ? ` · გამოტოვდება ${plan.totals.skip}` : ''}{plan.totals.error ? ` · შეცდომა ${plan.totals.error}` : ''}
                {plan.drg_versions?.length ? ` · DRG მონახაზი: ${plan.drg_versions.map((v) => `v${v.version_no}`).join(', ')}` : ''}
              </div>
              <div style={{ maxHeight: 420, overflow: 'auto' }}>
                <table className="table">
                  <thead><tr><th>ნაწილი</th><th>ელემენტი</th><th>ქმედება</th><th>დეტალი</th></tr></thead>
                  <tbody>{[...plan.lines].sort((a, b) => Number(a.action === 'unchanged') - Number(b.action === 'unchanged')).map((l, i) => (
                    <tr key={i} style={l.action === 'unchanged' ? { opacity: 0.55 } : undefined}>
                      <td className="small">{meta.data?.parts.find((p) => p.code === l.part)?.title ?? l.part}</td><td className="mono small">{l.key}</td>
                      <td><span className={`chip ${ACT[l.action][0]}`}>{plan.applied ? ACT_DONE[l.action] ?? ACT[l.action][1] : ACT[l.action][1]}</span></td><td className="small">{l.detail ?? ''}</td></tr>))}</tbody>
                </table>
              </div>
            </div>)}
        </section>
      ) : <span className="small muted">იმპორტი — მხოლოდ ადმინისტრატორი.</span>}
    </div>
  );
}

function SchemeVersions({ s, vids, onToggle }: { s: Scheme; vids: string[]; onToggle: (id: string) => void }) {
  const q = useQuery({ queryKey: ['drg-versions', s.id], queryFn: () => api<VersionRow[]>(`/drg/schemes/${s.id}/versions`) });
  return (
    <div className="row small" style={{ flexWrap: 'wrap', gap: 12 }}>
      <strong style={{ minWidth: 180 }}>{s.name}</strong>
      {q.data?.filter((v) => v.status !== 'retired').map((v) => <label key={v.id} className="row small"><input type="checkbox" checked={vids.includes(v.id)} onChange={() => onToggle(v.id)} />
        v{v.version_no} {v.label} <span className="muted">({v.status === 'draft' ? 'მონახაზი' : v.current ? 'მოქმედი' : 'აქტიური'})</span></label>)}
    </div>
  );
}
