import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, openBlob } from '../../api/client';
import type { Allergy, DxItem, ReportDetail, ReportSections, ReportTemplate } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import AllergyBanner from '../../components/AllergyBanner';
import { DxStatusChip } from '../../components/DxStatusChip';
import { ErrorBox, Loading, useDebounced, useToast } from '../../components/ui';
import { age, genderShort, hhmm, REPORT_FIELDS, type ReportField, todayISO, tsDate } from '../../lib/format';
import { BLANK, ContrastChip, fillPlaceholders, PatientLine, PREGNANCY_KA, RENAL_KA, StudyMeta, Urgent } from './common';

type Section = 'radiology' | 'endoscopy';
const EMPTY: Record<ReportField, string> = { technique: '', findings: '', impression: '', recommendation: '' };
const ROWS: Record<ReportField, number> = { technique: 2, findings: 10, impression: 3, recommendation: 2 };

/** დასკვნების სამუშაო სია (რადიოლოგი / ენდოსკოპისტი) */
export default function Reporting({ section }: { section: Section }) {
  const [tab, setTab] = useState<'todo' | 'done'>('todo');
  const [date, setDate] = useState(todayISO());
  const [search, setSearch] = useState('');
  const ds = useDebounced(search.trim(), 300);
  const [selId, setSelId] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['report-worklist', section, tab, date, ds], queryFn: () => api<DxItem[]>('/dx/report-worklist', { query: { section, tab, date: tab === 'done' && !ds ? date : '', search: ds } }), refetchInterval: 20_000 });
  const items = q.data ?? [];
  return (
    <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex' }}>
      <div className="content grow" style={{ minWidth: 0, overflow: 'auto' }}>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <div className="seg" role="group" aria-label="სია">
            <button type="button" aria-pressed={tab === 'todo'} onClick={() => { setTab('todo'); setSelId(null); }}>{section === 'radiology' ? 'აღსაწერი' : 'შესასრულებელი'}</button>
            <button type="button" aria-pressed={tab === 'done'} onClick={() => { setTab('done'); setSelId(null); }}>ხელმოწერილი</button>
          </div>
          {tab === 'done' && <input type="date" className="input" style={{ width: 170, height: 38 }} value={date} onChange={(e) => e.target.value && setDate(e.target.value)} aria-label="თარიღი" />}
          <input aria-label="ძებნა" className="input" style={{ maxWidth: 260, height: 38 }} placeholder="Accession, პირადი №, გვარი" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <ErrorBox error={q.error} />
        {q.isLoading ? <Loading /> : !items.length ? <div className="card empty">სია ცარიელია.</div> : (
          <div className="card">
            <table className="table">
              <thead><tr><th>{tab === 'todo' ? (section === 'radiology' ? 'შესრულდა' : 'შეკვეთა') : 'ხელმოწერა'}</th><th>პაციენტი</th><th>კვლევა</th>{section === 'radiology' && <th>Accession</th>}<th>სტატუსი</th></tr></thead>
              <tbody>{items.map((i) => {
                const ts = tab === 'done' ? i.validated_at : i.performed_at ?? i.ordered_at;
                return (
                  <tr key={i.id} className="clickable" onClick={() => setSelId(i.id)} style={i.id === selId ? { background: 'var(--accent-weak)' } : undefined}>
                    <td className="mono small">{ts && `${tsDate(ts)} ${hhmm(ts)}`}</td>
                    <td><strong>{i.last_name} {i.first_name}</strong><div className="small muted">{genderShort(i.gender)} · {age(i.birth_date)} წ</div></td>
                    <td>{i.service_name}<Urgent it={i} /><ContrastChip it={i} />
                      {i.is_critical && <span className="chip danger" style={{ marginLeft: 6 }}>კრიტიკული</span>}
                      {(i.report_version ?? 1) > 1 && <span className="chip warn" style={{ marginLeft: 6 }}>ვერსია {i.report_version}</span>}</td>
                    {section === 'radiology' && <td className="mono small">{i.accession_number}</td>}
                    <td>{i.report_status === 'draft' && i.status === 'in_progress' ? <span className="chip warn">draft</span> : <DxStatusChip status={i.status} />}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        )}
      </div>
      {selId && <ReportEditor key={selId} id={selId} section={section} onClose={() => setSelId(null)} />}
    </div>
  );
}

// ======================================================================= რედაქტორი
function ReportEditor({ id, section, onClose }: { id: string; section: Section; onClose: () => void }) {
  const qc = useQueryClient(); const toast = useToast(); const { user } = useAuth();
  const q = useQuery({ queryKey: ['rad-report', id], queryFn: () => api<ReportDetail>(`/dx-orders/${id}/report`) });
  const it = q.data;
  const isReporter = user?.role === 'admin' || (section === 'radiology' ? user?.role === 'radiologist' : user?.role === 'diagnostic');
  const signed = it?.report?.status === 'signed';
  const reportable = !!it && (section === 'radiology' ? ['performed', 'in_progress'] : ['ordered', 'in_progress']).includes(it.status);
  const editable = isReporter && reportable && !signed;

  const [f, setF] = useState<Record<ReportField, string>>(EMPTY);
  const [critical, setCritical] = useState(false);
  const [notified, setNotified] = useState('');
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [saved, setSaved] = useState<string>('');           // ბოლო შენახული მდგომარეობა (dirty-სთვის)
  const [showPriors, setShowPriors] = useState(false);
  const refs = useRef<Record<ReportField, HTMLTextAreaElement | null>>({ technique: null, findings: null, impression: null, recommendation: null });
  const lastFocus = useRef<ReportField>('findings');

  useEffect(() => {
    if (!it) return;
    const r = it.report;
    const next = { technique: r?.technique ?? '', findings: r?.findings ?? '', impression: r?.impression ?? '', recommendation: r?.recommendation ?? '' };
    setF(next); setCritical(!!r?.is_critical); setNotified(r?.critical_notified_to ?? ''); setTemplateId(r?.template_id ?? null);
    setSaved(JSON.stringify([next, !!r?.is_critical, r?.critical_notified_to ?? '']));
  }, [it?.report?.updated_at, it?.id]);   // eslint-disable-line react-hooks/exhaustive-deps

  const snapshot = JSON.stringify([f, critical, notified]);
  const dirty = editable && snapshot !== saved;
  const body = (): Partial<ReportSections> & Record<string, unknown> => ({ ...f, is_critical: critical, critical_notified_to: critical ? notified : null, template_id: templateId });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['report-worklist'] }); };

  const draft = useMutation({
    mutationFn: (snap: string) => api(`/dx-orders/${id}/report`, { method: 'PUT', body: body() }).then(() => snap),
    onSuccess: (snap) => { setSaved(snap); refresh(); },
  });
  // ავტომატური შენახვა: 4 წმ უმოქმედობის შემდეგ
  const debounced = useDebounced(snapshot, 4000);
  useEffect(() => { if (editable && debounced === snapshot && snapshot !== saved && !draft.isPending) draft.mutate(snapshot); }, [debounced]);   // eslint-disable-line react-hooks/exhaustive-deps

  const [blankFields, setBlankFields] = useState<string[]>([]);
  const sign = useMutation({
    mutationFn: () => api(`/dx-orders/${id}/report/sign`, { body: body() }),
    onSuccess: () => { toast.show('ხელმოწერილია — დასკვნა ექიმს გაეგზავნა'); refresh(); void qc.invalidateQueries({ queryKey: ['rad-report', id] }); },
    onError: (e) => { if (e instanceof ApiError && e.code === 'BLANKS') setBlankFields((e.body?.fields as string[]) ?? []); },
  });
  const reopen = useMutation({
    mutationFn: (reason: string) => api(`/dx-orders/${id}/report/reopen`, { body: { reason } }),
    onSuccess: () => { toast.show('გაიხსნა — ახალი ვერსია'); refresh(); void qc.invalidateQueries({ queryKey: ['rad-report', id] }); },
  });
  const saveTpl = useMutation({
    mutationFn: (name: string) => api('/dx/report-templates', { body: { section, kind: 'template', name, modality: section === 'radiology' ? it?.modality : null, ...f } }),
    onSuccess: () => { toast.show('პირადი შაბლონი შენახულია'); void qc.invalidateQueries({ queryKey: ['report-templates'] }); },
  });
  const pdf = useMutation({ mutationFn: (v?: number) => openBlob(`/dx-orders/${id}/report.pdf${v ? `?version=${v}` : ''}`) });

  const tpls = useQuery({
    queryKey: ['report-templates', section, it?.modality, it?.service_id],
    queryFn: () => api<{ can_manage_shared: boolean; items: ReportTemplate[] }>('/dx/report-templates', { query: { section, modality: section === 'radiology' ? it?.modality ?? '' : '', service_id: it?.service_id ?? '' } }),
    enabled: !!it && isReporter,
  });
  const templates = (tpls.data?.items ?? []).filter((t) => t.kind === 'template');
  const phrases = (tpls.data?.items ?? []).filter((t) => t.kind === 'phrase');
  const allergies = useQuery({ queryKey: ['allergies', it?.patient_id], queryFn: () => api<Allergy[]>(`/patients/${it!.patient_id}/allergies`), enabled: !!it });

  const applyTemplate = (t: ReportTemplate) => {
    if (!it) return;
    if (Object.values(f).some((v) => v.trim()) && !confirm('შაბლონი ჩაანაცვლებს უკვე აკრეფილ ტექსტს. გავაგრძელოთ?')) return;
    setF({ technique: fillPlaceholders(t.technique, it), findings: fillPlaceholders(t.findings, it), impression: fillPlaceholders(t.impression, it), recommendation: fillPlaceholders(t.recommendation, it) });
    setTemplateId(t.id); setBlankFields([]);
    setTimeout(() => nextBlank(), 0);
  };
  const insertPhrase = (p: ReportTemplate) => {
    if (!it || !p.target) return;
    const field = p.target; const el = refs.current[field];
    const text = fillPlaceholders(p.body, it);
    const cur = f[field]; const pos = el && lastFocus.current === field ? el.selectionStart : cur.length;
    const before = cur.slice(0, pos); const after = cur.slice(pos);
    const sep = before && !before.endsWith('\n') && !before.endsWith(' ') ? (field === 'findings' ? '\n' : ' ') : '';
    setF({ ...f, [field]: before + sep + text + after });
    setTimeout(() => { el?.focus(); const p2 = (before + sep + text).length; el?.setSelectionRange(p2, p2); }, 0);
  };
  /** შემდეგი „___“ — მიმდინარე კურსორიდან, ველების რიგით */
  const nextBlank = () => {
    const order = REPORT_FIELDS.map(([k]) => k);
    const start = order.indexOf(lastFocus.current);
    for (let n = 0; n < order.length + 1; n++) {
      const k = order[(start + n) % order.length]; const el = refs.current[k]; if (!el) continue;
      const from = n === 0 && document.activeElement === el ? el.selectionEnd : 0;
      const i = f[k].indexOf(BLANK, from);
      if (i >= 0) { el.focus(); el.setSelectionRange(i, i + BLANK.length); lastFocus.current = k; return; }
    }
    toast.show('შესავსები ადგილი (___) აღარ არის');
  };
  const blanks = useMemo(() => Object.values(f).reduce((n, v) => n + (v.split(BLANK).length - 1), 0), [f]);

  if (q.isLoading || !it) return <aside style={{ width: 'min(760px, 56vw)', borderLeft: '1px solid var(--line)', background: 'var(--surface)' }}>{q.error ? <ErrorBox error={q.error} /> : <Loading />}</aside>;
  const act = (allergies.data ?? []).filter((a) => a.is_active !== false);
  const r = it.report;

  return (
    <aside style={{ width: 'min(760px, 56vw)', flexShrink: 0, background: 'var(--surface)', borderLeft: '1px solid var(--line)', display: 'flex', flexDirection: 'column', minHeight: 0 }}
      onKeyDown={(e) => { if (e.key === 'F2') { e.preventDefault(); nextBlank(); } if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); if (dirty) draft.mutate(snapshot); } }}>
      <div className="stack" style={{ padding: '16px 20px 10px', gap: 4, borderBottom: '1px solid var(--line)' }}>
        <div className="row"><h2 className="grow" style={{ fontSize: 17 }}>{it.service_name}<Urgent it={it} /><ContrastChip it={it} /></h2>
          {signed ? <span className="chip ok">ხელმოწერილი · v{r!.version}</span> : r ? <span className="chip warn">draft · v{r.version}</span> : <DxStatusChip status={it.status} />}
          <button className="icon-btn" type="button" aria-label="დახურვა" onClick={onClose}>×</button></div>
        <PatientLine it={it} />
        <StudyMeta it={it} />
        <span className="small muted">{it.visit_kind === 'lab' ? (it.external_referral ? `გარე მიმართვა: ${it.external_referral}` : 'ექიმის გარეშე') : `ექიმი: ${it.ordered_by_name}`}{it.clinical_note ? ` · „${it.clinical_note}“` : ''}</span>
        {(it.technician_name || it.contrast_agent || it.dose_text || it.tech_note || it.safety) && (
          <div className="small" style={{ background: 'var(--surface-2)', border: '1px solid var(--line-soft)', borderRadius: 8, padding: '6px 10px', marginTop: 4 }}>
            {it.technician_name && <div>ტექნიკოსი: {it.technician_name}</div>}
            {it.contrast_agent && <div>კონტრასტი: {it.contrast_agent}{it.contrast_volume_ml ? `, ${Number(it.contrast_volume_ml)} მლ` : ''}</div>}
            {it.dose_text && <div>დოზა: {it.dose_text}</div>}
            {it.safety?.pregnancy && <div>{PREGNANCY_KA[it.safety.pregnancy]}</div>}
            {it.safety?.renal && <div>{RENAL_KA[it.safety.renal]}</div>}
            {it.tech_note && <div><strong>შენიშვნა:</strong> {it.tech_note}</div>}
          </div>)}
        {act.length > 0 && <AllergyBanner allergies={act} />}
        {r?.amend_reason && !signed && <div className="alert warn small">შესწორება (v{r.version}) — მიზეზი: {r.amend_reason}{r.amended_by_name ? ` · ${r.amended_by_name}` : ''}</div>}
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '10px 20px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {it.priors.length > 0 && (
          <div>
            <button type="button" className="btn sm" onClick={() => setShowPriors(!showPriors)}>{showPriors ? '▾' : '▸'} წინა კვლევები · {it.priors.length}</button>
            {showPriors && <div className="stack" style={{ gap: 6, marginTop: 6 }}>{it.priors.map((p) => (
              <div key={p.id} className="small" style={{ border: '1px solid var(--line-soft)', borderRadius: 8, padding: '6px 10px' }}>
                <strong>{tsDate(p.validated_at)} · {p.service_name}</strong> <span className="mono muted">{p.accession_number}</span>
                <div style={{ whiteSpace: 'pre-wrap' }}>{p.impression ?? p.report_text}</div>
              </div>))}</div>}
          </div>
        )}

        {editable && (
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
            <select aria-label="შაბლონი" className="select" style={{ height: 34, maxWidth: 360 }} value="" onChange={(e) => { const t = templates.find((x) => x.id === e.target.value); if (t) applyTemplate(t); }}>
              <option value="">შაბლონი… ({templates.length})</option>
              {templates.some((t) => !t.owner_id) && <optgroup label="საერთო">{templates.filter((t) => !t.owner_id).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</optgroup>}
              {templates.some((t) => t.owner_id) && <optgroup label="ჩემი">{templates.filter((t) => t.owner_id).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</optgroup>}
            </select>
            <button className="btn sm" type="button" onClick={nextBlank} title="F2">შემდეგი ___ {blanks ? `(${blanks})` : ''}</button>
            <button className="btn sm" type="button" disabled={!Object.values(f).some((v) => v.trim())} onClick={() => { const n = prompt('პირადი შაბლონის დასახელება:'); if (n && n.trim().length >= 2) saveTpl.mutate(n.trim()); }}>შაბლონად შენახვა</button>
            <span className="small muted" style={{ marginLeft: 'auto' }}>{draft.isPending ? 'ინახება…' : dirty ? 'შეუნახავი ცვლილებები' : r ? `შენახულია ${hhmm(r.updated_at)}` : ''}</span>
          </div>
        )}

        {REPORT_FIELDS.map(([k, label]) => {
          const ph = phrases.filter((p) => p.target === k);
          const val = f[k];
          if (!editable && !val.trim()) return null;
          const bad = blankFields.includes(k);
          return (
            <div key={k} className="stack" style={{ gap: 4 }}>
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                <label className="label" htmlFor={`rf-${k}`}>{label}{k === 'impression' && editable && <span className="req"> *</span>}</label>
                {editable && ph.map((p) => <button key={p.id} type="button" className="btn sm" style={{ height: 24, fontSize: 12 }} title={p.body ?? ''} onClick={() => insertPhrase(p)}>+ {p.name}</button>)}
              </div>
              {editable ? (
                <textarea id={`rf-${k}`} ref={(el) => { refs.current[k] = el; }} className={`textarea${bad ? ' invalid' : ''}`} rows={ROWS[k]}
                  style={{ fontSize: 15, lineHeight: 1.5, fontWeight: k === 'impression' ? 600 : 400, resize: 'vertical', minHeight: k === 'findings' ? 200 : undefined }}
                  value={val} onFocus={() => { lastFocus.current = k; }} onChange={(e) => { setF({ ...f, [k]: e.target.value }); if (bad) setBlankFields(blankFields.filter((x) => x !== k)); }} />
              ) : (
                <div style={{ whiteSpace: 'pre-wrap', fontSize: 15, lineHeight: 1.5, fontWeight: k === 'impression' ? 600 : 400 }}>{val}</div>
              )}
            </div>
          );
        })}
        {!editable && !r && <div className="empty small">{section === 'radiology' && ['ordered', 'scheduled', 'arrived'].includes(it.status) ? 'კვლევა ჯერ არ არის შესრულებული.' : 'დასკვნა ჯერ არ დაწერილა.'}</div>}

        {(editable || critical) && (
          <div className="stack" style={{ gap: 6, padding: 10, borderRadius: 10, border: `1px solid ${critical ? 'var(--danger-line)' : 'var(--line-soft)'}`, background: critical ? 'var(--danger-weak)' : undefined }}>
            <label className="row"><input type="checkbox" disabled={!editable} checked={critical} onChange={(e) => setCritical(e.target.checked)} /> <strong>კრიტიკული მიგნება</strong> <span className="small muted">— მკურნალ ექიმს დაუყოვნებლივ უნდა ეცნობოს</span></label>
            {critical && (editable
              ? <input aria-label="ვის ეცნობა" className="input" style={{ height: 36 }} placeholder="ვის ეცნობა: ექიმი, დრო, საშუალება (მაგ. დ. გელაშვილი, ტელ., 11:05) *" value={notified} onChange={(e) => setNotified(e.target.value)} />
              : <span className="small">ეცნობა: {notified}</span>)}
          </div>
        )}

        {signed && it.versions.length > 0 && (
          <div className="small muted stack" style={{ gap: 2 }}>
            {it.versions.map((v) => (
              <span key={v.id}>v{v.version} · {v.signed_by_name} · {tsDate(v.signed_at)} {hhmm(v.signed_at)}{v.amend_reason ? ` · შესწორება: ${v.amend_reason}` : ''}
                {' '}<button type="button" className="btn sm" style={{ height: 22, fontSize: 11 }} onClick={() => pdf.mutate(v.version)}>PDF</button></span>))}
          </div>
        )}
      </div>

      <div className="stack" style={{ padding: '12px 20px', borderTop: '1px solid var(--line)' }}>
        <ErrorBox error={sign.error ?? draft.error ?? reopen.error ?? saveTpl.error ?? pdf.error} />
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {editable && <>
            <button className="btn" type="button" disabled={!dirty || draft.isPending} onClick={() => draft.mutate(snapshot)}>შენახვა</button>
            <span className="small muted grow">F2 — შემდეგი ___ · Ctrl+S — შენახვა</span>
            <button className="btn primary" type="button" disabled={sign.isPending || !f.impression.trim() || (critical && !notified.trim())}
              onClick={() => { if (blanks && !confirm(`დარჩენილია ${blanks} შეუვსებელი ადგილი (___) — ხელმოწერა ვერ მოხერხდება. შევამოწმოთ?`)) return; if (!blanks) sign.mutate(); else nextBlank(); }}>ხელმოწერა</button>
          </>}
          {signed && <>
            <button className="btn" type="button" onClick={() => pdf.mutate(undefined)}>ბლანკი (PDF)</button>
            <span className="small muted grow">{r!.signed_by_name} · {r!.signed_at && `${tsDate(r!.signed_at)} ${hhmm(r!.signed_at)}`}</span>
            {isReporter && <button className="btn" type="button" onClick={() => { const x = prompt('ხელახლა გახსნის მიზეზი (ძველი ვერსია არქივში დარჩება):'); if (x && x.trim().length >= 5) reopen.mutate(x.trim()); }}>ხელახლა გახსნა</button>}
          </>}
        </div>
      </div>
      {toast.node}
    </aside>
  );
}
