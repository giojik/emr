import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ComponentType, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, can } from '../../../api/client';
import { useAuth } from '../../../auth/AuthContext';
import { ErrorBox, Field, Loading, Modal, useToast } from '../../../components/ui';
import { todayISO, tsDate } from '../../../lib/format';
import { useModuleEnabled } from '../../../lib/modules';
import { CcTab, GroupsTab, ListsTab } from './DrgTables';
import { RulesTab, TestTab } from './DrgRules';
import { type CheckResult, DRG_ADMIN, download, type Scheme, STATUS_CHIP, STATUS_KA, type VersionDetail, type VersionRow, type VersionSettings } from './types';

/**
 * ადმინისტრირება → DRG (0055): სქემა → ვერსიები (მონახაზი → აქტიური → გაუქმებული) → შემადგენლობა:
 * ჯგუფები, კოდების სიები, CC / MCC, დაჯგუფების წესები, პარამეტრები; ტესტ-შემთხვევა; CSV / JSON იმპორტი-ექსპორტი.
 * შემადგენლობა იცვლება მხოლოდ მონახაზში — აქტიურის შესაცვლელად: „ასლი → ახალი ვერსია“.
 */
export default function Drg() {
  const { user } = useAuth(); const admin = can(user, ...DRG_ADMIN);
  const on = useModuleEnabled('drg');
  const [sp, setSp] = useSearchParams();
  const schemes = useQuery({ queryKey: ['drg-schemes'], queryFn: () => api<Scheme[]>('/drg/schemes') });
  const sid = sp.get('s') ?? schemes.data?.find((s) => s.is_default)?.id ?? schemes.data?.[0]?.id ?? '';
  const vid = sp.get('v');
  const versions = useQuery({ queryKey: ['drg-versions', sid], enabled: !!sid, queryFn: () => api<VersionRow[]>(`/drg/schemes/${sid}/versions`) });
  const [dlg, setDlg] = useState<null | 'new' | 'schemes'>(null);
  const scheme = schemes.data?.find((s) => s.id === sid);
  const go = (p: Record<string, string>) => setSp(Object.fromEntries(Object.entries({ s: sid, ...p }).filter(([, x]) => x)));
  if (schemes.isLoading) return <div className="content"><Loading /></div>;
  return (
    <div className="content stack" style={{ gap: 14 }}>
      {!on && <div className="chip warn" style={{ height: 'auto', padding: '8px 12px' }}>მოდული „DRG“ გამორთულია — კონფიგურაცია შეიძლება, მაგრამ შემთხვევებზე არ გამოიყენება (ადმინისტრირება → მოდულები).</div>}
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <select className="select" aria-label="სქემა" style={{ maxWidth: 380 }} value={sid} onChange={(e) => setSp({ s: e.target.value })}>
          {schemes.data?.map((s) => <option key={s.id} value={s.id}>{s.name}{s.is_default ? ' (ნაგულისხმევი)' : ''}{s.is_active ? '' : ' (გათიშული)'}</option>)}</select>
        {scheme?.current_version ? <span className="chip ok">მოქმედებს: {scheme.current_version.label}</span> : <span className="chip warn">დღეს მოქმედი ვერსია არ არის</span>}
        <span className="grow" />
        <button className="btn" type="button" onClick={() => setDlg('schemes')}>სქემები და გადამხდელები</button>
        {admin && sid && <button className="btn primary" type="button" onClick={() => setDlg('new')}>+ ახალი ვერსია</button>}
      </div>
      <span className="hint">სქემა — სახელმწიფო / პროგრამის სტანდარტი (მაგ. საყოველთაო ჯანდაცვა). ვერსია მოქმედებს თარიღიდან; შემთხვევაზე მოქმედებს ვერსია, რომლის თარიღი ≤ გაწერის (ან მიღების — მოდულის პარამეტრი) დღე.
        ახალი სტანდარტისთვის: „ახალი ვერსია“ → ასლი მიმდინარედან ან ცარიელი / პაკეტი → შეცვლა → შემოწმება → გააქტიურება.</span>
      <ErrorBox error={schemes.error ?? versions.error} />
      <section className="card">
        <div className="card-head"><strong>ვერსიები</strong></div>
        {versions.data?.length === 0 ? <div className="empty">ვერსია ჯერ არ არის. დაიწყეთ „+ ახალი ვერსია“ — ცარიელი, სადემონსტრაციო ან ფაილიდან.</div> : (
          <table className="table">
            <thead><tr><th>#</th><th>დასახელება</th><th>მოქმედებს</th><th>სტატუსი</th><th className="num">ჯგუფი</th><th className="num">სია</th><th className="num">CC</th><th className="num">წესი</th><th className="num">შემთხვევა</th><th>ბოლო ცვლილება</th></tr></thead>
            <tbody>{versions.data?.map((v) => (
              <tr key={v.id} onClick={() => go({ v: v.id })} style={{ cursor: 'pointer', background: v.id === vid ? 'var(--accent-soft, #eef4ff)' : undefined }}>
                <td className="mono">{v.version_no}</td><td><strong>{v.label}</strong>{v.current && <span className="chip ok" style={{ marginLeft: 6 }}>მიმდინარე</span>}</td>
                <td className="mono" style={{ whiteSpace: 'nowrap' }}>{v.valid_from}</td><td><span className={`chip ${STATUS_CHIP[v.status]}`}>{STATUS_KA[v.status]}</span></td>
                <td className="num">{v.n_groups}</td><td className="num">{v.n_lists}</td><td className="num">{v.n_cc}</td><td className="num">{v.n_rules}</td><td className="num">{v.n_stays}</td>
                <td className="small muted">{tsDate(v.updated_at)}</td></tr>))}</tbody>
          </table>)}
      </section>
      {vid && <VersionView key={vid} id={vid} admin={admin} onDeleted={() => go({})} />}
      {dlg === 'new' && scheme && <NewVersionDialog scheme={scheme} versions={versions.data ?? []} onClose={() => setDlg(null)} onDone={(id) => go({ v: id })} />}
      {dlg === 'schemes' && <SchemesDialog admin={admin} onClose={() => setDlg(null)} />}
    </div>
  );
}

const TABS: { key: string; label: string; el: ComponentType<{ v: VersionDetail; edit: boolean }> }[] = [
  { key: 'overview', label: 'მიმოხილვა და პარამეტრები', el: Overview },
  { key: 'groups', label: 'ჯგუფები და წონები', el: GroupsTab },
  { key: 'lists', label: 'კოდების სიები', el: ListsTab },
  { key: 'cc', label: 'CC / MCC', el: CcTab },
  { key: 'rules', label: 'დაჯგუფების წესები', el: RulesTab },
  { key: 'test', label: 'ტესტი', el: TestTab },
];

function VersionView({ id, admin, onDeleted }: { id: string; admin: boolean; onDeleted: () => void }) {
  const [sp, setSp] = useSearchParams();
  const q = useQuery({ queryKey: ['drg-version', id], queryFn: () => api<VersionDetail>(`/drg/versions/${id}`) });
  const tab = TABS.find((t) => t.key === sp.get('t')) ?? TABS[0];
  if (q.isLoading) return <Loading />;
  if (!q.data) return <ErrorBox error={q.error} />;
  const v = q.data; const edit = admin && v.status === 'draft';
  const El = tab.key === 'overview' ? null : tab.el;
  return (
    <section className="card">
      <div className="card-head stack" style={{ gap: 8 }}>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0 }} className="grow">{v.label} <span className="small muted" style={{ fontWeight: 400 }}>· ვერსია {v.version_no} · მოქმედებს {v.valid_from}</span></h2>
          <span className={`chip ${STATUS_CHIP[v.status]}`}>{STATUS_KA[v.status]}</span>
          {!edit && v.status !== 'draft' && <span className="small muted">ცვლილება — მხოლოდ ახალ ვერსიაში (ასლი)</span>}
        </div>
        <div className="seg" role="tablist" aria-label="ვერსია">
          {TABS.map((t) => <button key={t.key} type="button" role="tab" aria-pressed={t.key === tab.key} onClick={() => setSp({ ...Object.fromEntries(sp), t: t.key })}>{t.label}</button>)}
        </div>
      </div>
      <div className="card-pad">
        {El ? <El v={v} edit={edit} /> : <Overview v={v} edit={edit} admin={admin} onDeleted={onDeleted} />}
      </div>
    </section>
  );
}

function Overview({ v, edit, admin, onDeleted }: { v: VersionDetail; edit: boolean; admin?: boolean; onDeleted?: () => void }) {
  const qc = useQueryClient(); const toast = useToast();
  const chk = useQuery({ queryKey: ['drg-check', v.id, v.updated_at], queryFn: () => api<CheckResult>(`/drg/versions/${v.id}/check`) });
  const [f, setF] = useState({ label: v.label, valid_from: v.valid_from, notes: v.notes ?? '', ...v.settings, cc_count: v.settings.cc_count_to_mcc === null ? '' : String(v.settings.cc_count_to_mcc), fallback: v.settings.fallback_code ?? '' });
  useEffect(() => { setF({ label: v.label, valid_from: v.valid_from, notes: v.notes ?? '', ...v.settings, cc_count: v.settings.cc_count_to_mcc === null ? '' : String(v.settings.cc_count_to_mcc), fallback: v.settings.fallback_code ?? '' }); }, [v]);
  const [dlg, setDlg] = useState<null | 'retire' | 'delete'>(null);
  const inval = () => { void qc.invalidateQueries({ queryKey: ['drg-version', v.id] }); void qc.invalidateQueries({ queryKey: ['drg-versions'] }); void qc.invalidateQueries({ queryKey: ['drg-schemes'] }); };
  const save = useMutation({
    mutationFn: () => api(`/drg/versions/${v.id}`, { method: 'PATCH', body: { label: f.label.trim(), valid_from: f.valid_from, notes: f.notes, settings: {
      los_basis: f.los_basis, age_basis: f.age_basis, pdx_source: f.pdx_source, cc_sources: f.cc_sources, cc_exclude_same_category: f.cc_exclude_same_category,
      cc_count_to_mcc: f.cc_count === '' ? null : Number(f.cc_count), proc_sources: f.proc_sources, vent_kinds: f.vent_kinds, fallback_code: f.fallback.trim().toUpperCase() || null } } }),
    onSuccess: () => { toast.show('შენახულია'); inval(); },
  });
  const activate = useMutation({ mutationFn: () => api<{ warnings: string[] }>(`/drg/versions/${v.id}/activate`, { body: {} }), onSuccess: () => { toast.show('ვერსია გააქტიურდა'); inval(); } });
  const toggle = (k: 'cc_sources' | 'proc_sources' | 'vent_kinds', x: string) => setF({ ...f, [k]: (f[k] as string[]).includes(x) ? (f[k] as string[]).filter((y) => y !== x) : [...(f[k] as string[]), x] });
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 } as const;
  const dis = !edit;
  return (
    <div className="stack" style={{ gap: 14 }}>
      {toast.node}
      <div className="row small muted" style={{ flexWrap: 'wrap', gap: 14 }}>
        <span>შექმნა: {v.created_by_name} · {tsDate(v.created_at)}{v.source_label && ` (ასლი: ${v.source_label})`}</span>
        {v.updated_by_name && <span>ბოლო ცვლილება: {v.updated_by_name} · {tsDate(v.updated_at)}</span>}
        {v.activated_at && <span>გააქტიურა: {v.activated_by_name} · {tsDate(v.activated_at)}</span>}
        {v.retired_at && <span>გაუქმდა: {tsDate(v.retired_at)} — {v.retire_reason}</span>}
      </div>
      <div style={grid}>
        <Field label="დასახელება" htmlFor="dv-l"><input id="dv-l" className="input" disabled={dis} value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} /></Field>
        <Field label="მოქმედებს (თარიღიდან)" htmlFor="dv-f"><input id="dv-f" className="input mono" type="date" disabled={dis} value={f.valid_from} onChange={(e) => setF({ ...f, valid_from: e.target.value })} /></Field>
        <Field label="ნაგულისხმევი ჯგუფი (არცერთი წესი)" htmlFor="dv-fb" hint="ცარიელი — „ვერ დაჯგუფდა“, ბილინგი ირჩევს ხელით"><input id="dv-fb" className="input mono" disabled={dis} value={f.fallback} onChange={(e) => setF({ ...f, fallback: e.target.value })} /></Field>
        <Field label="ხანგრძლივობა (los)" htmlFor="dv-los"><select id="dv-los" className="select" disabled={dis} value={f.los_basis} onChange={(e) => setF({ ...f, los_basis: e.target.value as VersionSettings['los_basis'] })}>
          <option value="bed_days">საწოლდღეები (შუაღამის წესი)</option><option value="calendar_days">კალენდარული (გაწერა − მიღება)</option></select></Field>
        <Field label="ასაკი" htmlFor="dv-age"><select id="dv-age" className="select" disabled={dis} value={f.age_basis} onChange={(e) => setF({ ...f, age_basis: e.target.value as VersionSettings['age_basis'] })}>
          <option value="admission">მიღების დღეს</option><option value="discharge">გაწერის დღეს</option></select></Field>
        <Field label="ძირითადი დიაგნოზი (PDX)" htmlFor="dv-pdx"><select id="dv-pdx" className="select" disabled={dis} value={f.pdx_source} onChange={(e) => setF({ ...f, pdx_source: e.target.value as VersionSettings['pdx_source'] })}>
          <option value="primary">მხოლოდ „ძირითადი“</option><option value="primary_or_admission">„ძირითადი“, თუ არ არის — მიღების</option></select></Field>
        <div className="stack" style={{ gap: 4 }}><span className="small muted">თანმხლები დიაგნოზები (CC)</span>
          {[['secondary', 'თანმხლები'], ['complication', 'გართულება'], ['admission', 'მიღების']].map(([k, l]) => <label key={k} className="row small"><input type="checkbox" disabled={dis} checked={f.cc_sources.includes(k)} onChange={() => toggle('cc_sources', k)} /> {l}</label>)}</div>
        <div className="stack" style={{ gap: 4 }}><span className="small muted">პროცედურის კოდები</span>
          {[['or_ncsp', 'ოპერაციის NCSP კოდი'], ['or_code', 'ოპერაციის კლინიკის კოდი'], ['service_code', 'ინვოისის მომსახურების კოდი']].map(([k, l]) => <label key={k} className="row small"><input type="checkbox" disabled={dis} checked={f.proc_sources.includes(k)} onChange={() => toggle('proc_sources', k)} /> {l}</label>)}</div>
        <div className="stack" style={{ gap: 4 }}><span className="small muted">ვენტილაციის საათები</span>
          {[['invasive', 'ინვაზიური'], ['niv', 'არაინვაზიური (NIV)'], ['hfnc', 'HFNC']].map(([k, l]) => <label key={k} className="row small"><input type="checkbox" disabled={dis} checked={f.vent_kinds.includes(k)} onChange={() => toggle('vent_kinds', k)} /> {l}</label>)}</div>
        <label className="row small"><input type="checkbox" disabled={dis} checked={f.cc_exclude_same_category} onChange={(e) => setF({ ...f, cc_exclude_same_category: e.target.checked })} /> CC არ ითვლება, თუ ძირითადის იგივე კატეგორიაა (3 სიმბოლო)</label>
        <Field label="N ცალი CC = MCC" htmlFor="dv-ccn" hint="ცარიელი — გამორთული; 2–10"><input id="dv-ccn" className="input mono" inputMode="numeric" disabled={dis} value={f.cc_count} onChange={(e) => setF({ ...f, cc_count: e.target.value })} /></Field>
        <Field label="შენიშვნა" htmlFor="dv-n"><textarea id="dv-n" className="textarea" rows={2} disabled={dis} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      </div>
      {edit && <div className="row"><button className="btn primary" type="button" disabled={save.isPending} onClick={() => save.mutate()}>პარამეტრების შენახვა</button></div>}
      <ErrorBox error={save.error} />

      <div className="stack" style={{ gap: 6 }}>
        <h3 style={{ margin: 0 }}>შემოწმება</h3>
        {chk.data && (chk.data.errors.length === 0 && chk.data.warnings.length === 0 ? <span className="small" style={{ color: 'var(--ok-ink, #1a7f37)' }}>✓ შეცდომა არ არის</span> : <>
          {chk.data.errors.map((e, i) => <span key={`e${i}`} className="small" style={{ color: 'var(--danger, #b00020)' }}>✗ {e}</span>)}
          {chk.data.warnings.map((w, i) => <span key={`w${i}`} className="small muted">⚠ {w}</span>)}</>)}
        <ErrorBox error={chk.error} />
      </div>

      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        {admin && v.status === 'draft' && <button className="btn primary" type="button" disabled={!chk.data?.ok || activate.isPending}
          title={v.version_approval === 'required' ? 'მეორე პირი (არა ბოლო რედაქტორი)' : undefined} onClick={() => activate.mutate()}>გააქტიურება</button>}
        {admin && v.status === 'active' && <button className="btn" type="button" onClick={() => setDlg('retire')}>გაუქმება</button>}
        {admin && v.status === 'draft' && <button className="btn" type="button" onClick={() => setDlg('delete')}>მონახაზის წაშლა</button>}
        <span className="grow" />
        <button className="btn sm" type="button" onClick={() => void download(`/drg/versions/${v.id}/export`, `drg-${v.scheme_code}-${v.valid_from}.json`, api)}>პაკეტი (JSON)</button>
        {(['groups', 'lists', 'cc', 'rules'] as const).map((t) => <button key={t} className="btn sm" type="button" onClick={() => void download(`/drg/versions/${v.id}/csv/${t}`, `drg-${t}-${v.valid_from}.csv`, api)}>
          {t === 'groups' ? 'ჯგუფები' : t === 'lists' ? 'სიები' : t === 'cc' ? 'CC' : 'წესები'} (CSV)</button>)}
      </div>
      {v.version_approval === 'required' && v.status === 'draft' && <span className="small muted">გააქტიურება — მეორე პირი: ბოლო რედაქტორი ({v.updated_by_name ?? v.created_by_name}) ვერ გაააქტიურებს.</span>}
      <ErrorBox error={activate.error} />
      {dlg === 'retire' && <ReasonDialog title="ვერსიის გაუქმება" hint="გაუქმებული ვერსია ახალ შემთხვევებზე აღარ გამოიყენება; უკვე დადასტურებული შემთხვევები უცვლელია. მის ნაცვლად იმოქმედებს წინა აქტიური ვერსია (თუ არის)."
        path={`/drg/versions/${v.id}/retire`} onClose={() => setDlg(null)} onDone={() => { toast.show('ვერსია გაუქმდა'); inval(); }} />}
      {dlg === 'delete' && <Modal title="მონახაზის წაშლა" onClose={() => setDlg(null)}
        footer={<><button className="btn" type="button" onClick={() => setDlg(null)}>დახურვა</button>
          <button className="btn primary" type="button" onClick={() => void api(`/drg/versions/${v.id}`, { method: 'DELETE' }).then(() => { inval(); onDeleted?.(); })}>წაშლა</button></>}>
        <span>„{v.label}“ — მონახაზი და მისი მთელი შემადგენლობა წაიშლება.</span></Modal>}
    </div>
  );
}

export function ReasonDialog({ title, hint, path, onClose, onDone }: { title: string; hint?: string; path: string; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const m = useMutation({ mutationFn: () => api(path, { body: { reason: reason.trim() } }), onSuccess: () => { onDone(); onClose(); } });
  return (
    <Modal title={title} onClose={onClose} footer={<><button className="btn" type="button" onClick={onClose}>დახურვა</button>
      <button className="btn primary" type="button" disabled={reason.trim().length < 5 || m.isPending} onClick={() => m.mutate()}>დადასტურება</button></>}>
      <div className="stack" style={{ gap: 10 }}>
        {hint && <span className="small muted">{hint}</span>}
        <Field label="მიზეზი" htmlFor="rd-r" required hint="მინ. 5 სიმბოლო"><input id="rd-r" className="input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} /></Field>
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}

function NewVersionDialog({ scheme, versions, onClose, onDone }: { scheme: Scheme; versions: VersionRow[]; onClose: () => void; onDone: (id: string) => void }) {
  const qc = useQueryClient();
  const base = versions.find((v) => v.current) ?? versions.find((v) => v.status === 'active') ?? versions[0];
  const [src, setSrc] = useState<'copy' | 'empty' | 'demo' | 'file'>(base ? 'copy' : 'demo');
  const [f, setF] = useState({ label: '', valid_from: todayISO(), copy_from: base?.id ?? '' });
  const [pkg, setPkg] = useState<Record<string, unknown> | null>(null); const [pkgErr, setPkgErr] = useState('');
  const m = useMutation({
    mutationFn: () => src === 'demo' ? api<{ id: string }>(`/drg/schemes/${scheme.id}/versions/demo`, { body: { valid_from: f.valid_from } })
      : src === 'file' ? api<{ id: string }>(`/drg/schemes/${scheme.id}/versions/import`, { body: { package: pkg, label: f.label.trim() || undefined, valid_from: f.valid_from } })
      : api<{ id: string }>(`/drg/schemes/${scheme.id}/versions`, { body: { label: f.label.trim(), valid_from: f.valid_from, copy_from: src === 'copy' ? f.copy_from || undefined : undefined } }),
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ['drg-versions'] }); void qc.invalidateQueries({ queryKey: ['drg-schemes'] }); onDone(r.id); onClose(); },
  });
  const readFile = (file: File | undefined) => {
    setPkg(null); setPkgErr('');
    if (!file) return;
    void file.text().then((t) => { try { const j = JSON.parse(t) as Record<string, unknown>; setPkg(j); if (!f.label && typeof j.label === 'string') setF({ ...f, label: j.label }); } catch { setPkgErr('ფაილი JSON არ არის'); } });
  };
  const ok = src === 'demo' || (src === 'file' ? !!pkg : f.label.trim().length >= 2 && (src !== 'copy' || !!f.copy_from));
  return (
    <Modal title={`ახალი ვერსია — ${scheme.name}`} onClose={onClose} width={640}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={!ok || m.isPending} onClick={() => m.mutate()}>შექმნა (მონახაზი)</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <div className="stack" style={{ gap: 6 }}>
          {base && <label className="row"><input type="radio" checked={src === 'copy'} onChange={() => setSrc('copy')} /> ასლი არსებული ვერსიიდან (შემდეგ შეცვლით)</label>}
          <label className="row"><input type="radio" checked={src === 'empty'} onChange={() => setSrc('empty')} /> ცარიელი (CSV-ით შევსება)</label>
          <label className="row"><input type="radio" checked={src === 'file'} onChange={() => setSrc('file')} /> პაკეტიდან (JSON — სხვა ინსტალაციიდან / ექსპორტიდან)</label>
          <label className="row"><input type="radio" checked={src === 'demo'} onChange={() => setSrc('demo')} /> სადემონსტრაციო კონფიგურაცია (ნიმუში — არ არის SSA სტანდარტი)</label>
        </div>
        {src === 'copy' && <Field label="წყარო" htmlFor="nv-src"><select id="nv-src" className="select" value={f.copy_from} onChange={(e) => setF({ ...f, copy_from: e.target.value })}>
          {versions.map((v) => <option key={v.id} value={v.id}>{v.version_no}. {v.label} — {STATUS_KA[v.status]}, {v.valid_from}</option>)}</select></Field>}
        {src === 'file' && <Field label="ფაილი" htmlFor="nv-file" error={pkgErr || undefined}><input id="nv-file" className="input" style={{ padding: 8, height: 'auto' }} type="file" accept="application/json,.json" onChange={(e) => readFile(e.target.files?.[0])} /></Field>}
        {src !== 'demo' && <Field label="დასახელება" htmlFor="nv-l" required={src !== 'file'}><input id="nv-l" className="input" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder="მაგ. SSA 2027" /></Field>}
        <Field label="მოქმედებს (თარიღიდან)" htmlFor="nv-f" required><input id="nv-f" className="input mono" type="date" value={f.valid_from} onChange={(e) => setF({ ...f, valid_from: e.target.value })} /></Field>
        <ErrorBox error={m.error} />
        {m.error && (m.error as { body?: { errors?: string[] } }).body?.errors && <div className="small stack" style={{ gap: 2, maxHeight: 160, overflow: 'auto' }}>
          {((m.error as { body?: { errors?: string[] } }).body!.errors!).map((e, i) => <span key={i}>✗ {e}</span>)}</div>}
      </div>
    </Modal>
  );
}

interface PayerRow { id: string; code: string; name: string; kind: string; default_mode: string; is_active: boolean; drg_scheme_id: string | null; scheme_name: string | null }
function SchemesDialog({ admin, onClose }: { admin: boolean; onClose: () => void }) {
  const qc = useQueryClient(); const toast = useToast();
  const schemes = useQuery({ queryKey: ['drg-schemes'], queryFn: () => api<Scheme[]>('/drg/schemes') });
  const payers = useQuery({ queryKey: ['drg-payers'], queryFn: () => api<PayerRow[]>('/drg/payers') });
  const [nf, setNf] = useState({ code: '', name: '' });
  const inval = () => { void qc.invalidateQueries({ queryKey: ['drg-schemes'] }); void qc.invalidateQueries({ queryKey: ['drg-payers'] }); };
  const add = useMutation({ mutationFn: () => api('/drg/schemes', { body: { code: nf.code.trim().toUpperCase(), name: nf.name.trim() } }), onSuccess: () => { setNf({ code: '', name: '' }); toast.show('სქემა დაემატა'); inval(); } });
  const upd = useMutation({ mutationFn: (x: { id: string; body: Record<string, unknown> }) => api(`/drg/schemes/${x.id}`, { method: 'PATCH', body: x.body }), onSuccess: () => { toast.show('შენახულია'); inval(); } });
  const setScheme = useMutation({ mutationFn: (x: { id: string; scheme: string }) => api(`/drg/payers/${x.id}/scheme`, { method: 'PUT', body: { drg_scheme_id: x.scheme || null } }), onSuccess: () => { toast.show('შენახულია'); inval(); } });
  return (
    <Modal title="DRG სქემები და გადამხდელები" onClose={onClose} width={900}>
      {toast.node}
      <div className="stack" style={{ gap: 14 }}>
        <table className="table">
          <thead><tr><th>კოდი</th><th>დასახელება</th><th>მიმდინარე ვერსია</th><th className="num">გადამხდელი</th><th /></tr></thead>
          <tbody>{schemes.data?.map((s) => <tr key={s.id} style={s.is_active ? undefined : { opacity: 0.55 }}>
            <td className="mono">{s.code}</td><td>{s.name}{s.is_default && <span className="chip ok" style={{ marginLeft: 6 }}>ნაგულისხმევი</span>}</td>
            <td className="small">{s.current_version?.label ?? '—'}</td><td className="num">{s.payers}</td>
            <td className="num">{admin && !s.is_default && s.is_active && <button className="btn sm" type="button" onClick={() => upd.mutate({ id: s.id, body: { is_default: true } })}>ნაგულისხმევად</button>}{' '}
              {admin && !s.is_default && <button className="btn sm" type="button" onClick={() => upd.mutate({ id: s.id, body: { is_active: !s.is_active } })}>{s.is_active ? 'გათიშვა' : 'ჩართვა'}</button>}</td></tr>)}</tbody>
        </table>
        {admin && <form className="row" style={{ gap: 8, alignItems: 'flex-end' }} onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
          <Field label="კოდი" htmlFor="sc-c"><input id="sc-c" className="input mono" style={{ width: 140 }} value={nf.code} onChange={(e) => setNf({ ...nf, code: e.target.value })} /></Field>
          <Field label="დასახელება" htmlFor="sc-n"><input id="sc-n" className="input" style={{ width: 320 }} value={nf.name} onChange={(e) => setNf({ ...nf, name: e.target.value })} /></Field>
          <button className="btn" type="submit" disabled={nf.code.trim().length < 2 || nf.name.trim().length < 2 || add.isPending}>+ სქემა</button></form>}
        <ErrorBox error={add.error ?? upd.error ?? setScheme.error} />
        <h3 style={{ margin: 0 }}>გადამხდელები</h3>
        <span className="small muted">რომელი სქემით ჯგუფდება გადამხდელის (DRG რეჟიმის) შემთხვევა. „ნაგულისხმევი“ — ნაგულისხმევი სქემით. გადამხდელის პირობები (რეჟიმი, საბაზისო განაკვეთი) — <Link to="/admin/tariffs?tab=rules">ტარიფები → გადამხდელის წესები</Link>.</span>
        <table className="table">
          <thead><tr><th>გადამხდელი</th><th>რეჟიმი</th><th>DRG სქემა</th></tr></thead>
          <tbody>{payers.data?.map((p) => <tr key={p.id} style={p.is_active ? undefined : { opacity: 0.55 }}>
            <td>{p.name} <span className="small muted mono">{p.code}</span></td><td className="small">{p.default_mode === 'drg' ? <strong>DRG</strong> : p.default_mode === 'fixed' ? 'ფიქსირებული' : 'პროცენტი'}</td>
            <td>{admin ? <select className="select" style={{ maxWidth: 320 }} aria-label={`სქემა — ${p.name}`} value={p.drg_scheme_id ?? ''} onChange={(e) => setScheme.mutate({ id: p.id, scheme: e.target.value })}>
              <option value="">ნაგულისხმევი</option>{schemes.data?.filter((s) => s.is_active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select> : p.scheme_name ?? 'ნაგულისხმევი'}</td></tr>)}</tbody>
        </table>
      </div>
    </Modal>
  );
}
