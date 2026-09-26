import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { NavLink, Navigate, useParams, useSearchParams } from 'react-router-dom';
import { can, type Role, api, openBlob } from '../api/client';
import type { Allergy, DxItem, LabAnalyteForm, LabItemDetail } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import AllergyBanner from '../components/AllergyBanner';
import { DxStatusChip, FlagBadge } from '../components/DxStatusChip';
import { ErrorBox, Loading, useToast } from '../components/ui';
import { age, genderShort, hhmm, refRange, tsDate, unitFmt } from '../lib/format';
import ReferralsWorklist from './Diagnostics';
import Reporting from './radiology/Reporting';
import Schedule from './radiology/Schedule';
import TechQueue from './radiology/TechQueue';
import Templates from './radiology/Templates';
import Pathology from './radiology/Pathology';
import Scopes from './radiology/Scopes';
import { PREG_KA, useLabMethods, type Pregnancy } from './admin/lab/common';

/** 0018: ნორმის კრიტერიუმები შეკვეთაზე (ორსულობა, ანალიზატორი) */
type LabItemX = Omit<LabItemDetail, 'analytes'> & {
  pregnancy_weeks: number | null; lab_method_id: string | null; default_method_id: string | null; effective_method_id: string | null; norm_recalculated_at: string | null;
  analytes: (LabAnalyteForm & { range: (LabAnalyteForm['range'] & { pregnancy?: Pregnancy | null; method_id?: string | null }) | null })[];
};

/** დიაგნოსტიკის ჰაბი: /diagnostics/lab | radiology | endoscopy | referrals */
export default function DiagnosticsHub() {
  const { section = '' } = useParams();
  const { user } = useAuth();
  const tabs = [['lab', 'ლაბორატორია'], ['radiology', 'რადიოლოგია'], ['endoscopy', 'ენდოსკოპია'], ['referrals', 'სხვა მიმართვები']] as const;
  const allowed = tabs.filter(([k]) => ({
    lab: ['admin', 'diagnostic', 'lab_doctor', 'lab_manager'], radiology: ['admin', 'radiographer', 'radiologist', 'receptionist', 'manager', 'viewer'],
    endoscopy: ['admin', 'endoscopist', 'endoscopy_nurse', 'receptionist', 'manager', 'viewer', 'med_engineer'], referrals: ['admin', 'diagnostic'],
  } as Record<string, Role[]>)[k].some((c) => can(user, c)));
  if (!allowed.some(([k]) => k === section)) return <Navigate to={`/diagnostics/${allowed[0]?.[0] ?? 'lab'}`} replace />;
  return (
    <>
      <header className="topbar" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8, paddingBottom: 0 }}>
        <h1>{allowed.length === 1 ? allowed[0][1] : 'დიაგნოსტიკა'}</h1>
        <nav aria-label="დიაგნოსტიკა" className="row" style={{ gap: 2 }}>
          {allowed.length > 1 && allowed.map(([k, l]) => <NavLink key={k} to={`/diagnostics/${k}`} className="admin-tab">{l}</NavLink>)}
        </nav>
      </header>
      {section === 'lab' && <LabWorkspace />}
      {(section === 'radiology' || section === 'endoscopy') && <ImagingWorkspace key={section} section={section} />}
      {section === 'referrals' && <ReferralsWorklist embedded />}
    </>
  );
}

// ======================================================================= ლაბორატორია
const LAB_TABS = [['collected,in_progress', 'შესასრულებელი'], ['resulted', 'ვალიდაციას ელოდება'], ['validated', 'დადასტურებული']] as const;

function LabWorkspace() {
  const qc = useQueryClient(); const toast = useToast(); const { user } = useAuth();
  const canReceive = can(user, 'admin', 'diagnostic', 'lab_doctor');
  const [status, setStatus] = useState<string>(LAB_TABS[0][0]);
  const [search, setSearch] = useState('');
  const [selId, setSelId] = useState<string | null>(null);
  const [barcode, setBarcode] = useState('');
  const scan = useRef<HTMLInputElement>(null);
  const q = useQuery({ queryKey: ['lab-worklist', status, search], queryFn: () => api<DxItem[]>('/lab/worklist', { query: { status, search } }), refetchInterval: 15_000 });
  const receive = useMutation({
    mutationFn: (bc: string) => api<{ barcode: string; already_received: boolean }>('/lab/receive', { body: { barcode: bc } }),
    onSuccess: (r) => {
      toast.show(r.already_received ? `${r.barcode} უკვე მიღებულია` : `სინჯარა ${r.barcode} მიღებულია`);
      setBarcode(''); setStatus('collected,in_progress'); setSearch(r.barcode);
      void qc.invalidateQueries({ queryKey: ['lab-worklist'] }); scan.current?.focus();
    },
  });
  const items = q.data ?? [];
  useEffect(() => { if (search && items.length === 1) setSelId(items[0].id); }, [search, items]);

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
      <div className="content grow">
        {canReceive && <form className="card card-pad row" style={{ flexWrap: 'wrap' }} onSubmit={(e) => { e.preventDefault(); if (barcode.trim()) receive.mutate(barcode.trim()); }}>
          <label htmlFor="bc" className="label">სინჯარის მიღება</label>
          <input id="bc" ref={scan} className="input mono" style={{ maxWidth: 260, fontSize: 18 }} autoFocus placeholder="შტრიხკოდი (სკანერი)" value={barcode} onChange={(e) => setBarcode(e.target.value)} />
          <button className="btn primary" type="submit" disabled={!barcode.trim() || receive.isPending}>მიღება</button>
          <span className="hint">სკანერი შტრიხკოდს ავტომატურად აკრეფს და Enter-ს დააჭერს</span>
        </form>}
        <ErrorBox error={receive.error} />
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <div className="seg" role="group" aria-label="სტატუსი">{LAB_TABS.map(([k, l]) => <button key={k} type="button" aria-pressed={status === k} onClick={() => { setStatus(k); setSelId(null); }}>{l}</button>)}</div>
          <input aria-label="ძებნა" className="input" style={{ maxWidth: 280, height: 38 }} placeholder="შტრიხკოდი, პირადი №, გვარი" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <ErrorBox error={q.error} />
        {q.isLoading ? <Loading /> : !items.length ? <div className="card empty">სია ცარიელია.</div> : (
          <div className="card">
            <table className="table">
              <thead><tr><th>შტრიხკოდი</th><th>პაციენტი</th><th>ანალიზი</th><th>შეკვეთა</th><th>სტატუსი</th></tr></thead>
              <tbody>{items.map((i) => (
                <tr key={i.id} className="clickable" onClick={() => setSelId(i.id)} style={i.id === selId ? { background: 'var(--accent-weak)' } : undefined}>
                  <td className="mono">{i.barcode ?? '—'}{i.specimen_status === 'collected' && <div className="small" style={{ color: 'var(--warn-ink)' }}>არ მიღებულა</div>}</td>
                  <td><strong>{i.first_name} {i.last_name}</strong><div className="small muted">{genderShort(i.gender)} · {age(i.birth_date)} წ</div></td>
                  <td>{i.service_name}{i.priority === 'urgent' && <span className="chip danger" style={{ marginLeft: 6 }}>სასწრაფო</span>}</td>
                  <td className="small muted">{hhmm(i.ordered_at)} · {i.ordered_by_name}</td>
                  <td><DxStatusChip status={i.status} /></td>
                </tr>))}</tbody>
            </table>
          </div>
        )}
        {toast.node}
      </div>
      {selId && <ResultEntry key={selId} id={selId} onClose={() => setSelId(null)} />}
    </div>
  );
}

/** კლიენტის მხარეს ნიშნის წინასწარი ჩვენება (საბოლოოს სერვერი ითვლის) */
function previewFlag(a: LabAnalyteForm, raw: string): string | null {
  const v = raw.trim().replace(',', '.'); if (!v) return null;
  if (a.result_type === 'numeric') {
    const n = Number(v); if (!Number.isFinite(n)) return 'ERR';
    if (a.critical_low !== null && n < Number(a.critical_low)) return 'LL';
    if (a.critical_high !== null && n > Number(a.critical_high)) return 'HH';
    if (a.range?.low != null && n < Number(a.range.low)) return 'L';
    if (a.range?.high != null && n > Number(a.range.high)) return 'H';
    return a.range ? 'N' : null;
  }
  return a.range?.normal_text ? (v === a.range.normal_text ? 'N' : 'A') : null;
}

function ResultEntry({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient(); const { user } = useAuth(); const toast = useToast();
  const q = useQuery({ queryKey: ['lab-item', id], queryFn: () => api<LabItemX>(`/lab/items/${id}`) });
  const [vals, setVals] = useState<Record<string, string>>({});
  const [preg, setPreg] = useState(''); const [method, setMethod] = useState('');
  const methods = useLabMethods();
  useEffect(() => {
    if (!q.data) return;
    setPreg(q.data.pregnancy_weeks ? String(q.data.pregnancy_weeks) : ''); setMethod(q.data.lab_method_id ?? q.data.default_method_id ?? '');
    setVals(Object.fromEntries(q.data.analytes.map((a) => { const r = q.data!.results.find((x) => x.analyte_id === a.id); return [a.id, r ? (r.value_num !== null ? String(Number(r.value_num)) : r.value_text ?? '') : '']; })));
  }, [q.data]);
  const allergies = useQuery({ queryKey: ['allergies', q.data?.patient_id], queryFn: () => api<Allergy[]>(`/patients/${q.data!.patient_id}/allergies`), enabled: !!q.data });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['lab-item', id] }); void qc.invalidateQueries({ queryKey: ['lab-worklist'] }); };
  const save = useMutation({
    mutationFn: () => api<{ status: string }>(`/lab/items/${id}/results`, { method: 'PUT', body: {
      values: Object.entries(vals).map(([analyte_id, value]) => ({ analyte_id, value })),
      pregnancy_weeks: preg ? Number(preg) : null, lab_method_id: method || null } }),
    onSuccess: (r) => { toast.show(r.status === 'resulted' ? 'შენახულია — ვალიდაციას ელოდება' : 'შენახულია (შეუვსებელი კომპონენტებით)'); refresh(); },
  });
  const validate = useMutation({ mutationFn: () => api(`/lab/items/${id}/validate`, { method: 'POST' }), onSuccess: () => { toast.show('დადასტურებულია — შედეგი ექიმს გაეგზავნა'); refresh(); } });
  const reopen = useMutation({ mutationFn: (reason: string) => api(`/lab/items/${id}/reopen`, { body: { reason } }), onSuccess: refresh });
  const print = useMutation({ mutationFn: () => openBlob(`/encounters/${q.data!.encounter_id}/lab-report?item=${id}`) });
  if (q.isLoading || !q.data) return <aside style={{ width: 560, borderLeft: '1px solid var(--line)', background: 'var(--surface)' }}><Loading /></aside>;
  const it = q.data;
  const canEnter = can(user, 'admin') || can(user, 'diagnostic') || can(user, 'lab_doctor');
  const locked = !canEnter || it.status === 'validated' || it.status === 'cancelled' || it.specimen_status === 'collected';
  const isLabDoctor = can(user, 'lab_doctor') || can(user, 'admin');
  const metaDirty = (preg ? Number(preg) : null) !== it.pregnancy_weeks || (method || null) !== (it.lab_method_id ?? it.default_method_id ?? null);
  const dirty = metaDirty || it.analytes.some((a) => { const r = it.results.find((x) => x.analyte_id === a.id); const cur = r ? (r.value_num !== null ? String(Number(r.value_num)) : r.value_text ?? '') : ''; return (vals[a.id] ?? '') !== cur; });

  return (
    <aside style={{ width: 560, flexShrink: 0, background: 'var(--surface)', borderLeft: '1px solid var(--line)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div className="stack" style={{ padding: '18px 20px 10px', gap: 4, borderBottom: '1px solid var(--line)' }}>
        <div className="row"><h2 className="grow" style={{ fontSize: 17 }}>{it.service_name}</h2><DxStatusChip status={it.status} /><button className="icon-btn" type="button" aria-label="დახურვა" onClick={onClose}>×</button></div>
        <span>{it.first_name} {it.last_name} · {genderShort(it.gender)} · {age(it.birth_date)} წ · <span className="mono">{it.barcode}</span></span>
        <span className="small muted">შეკვეთა: {it.ordered_by_name} · {tsDate(it.ordered_at)} {hhmm(it.ordered_at)}{it.clinical_note ? ` · „${it.clinical_note}“` : ''}</span>
        {allergies.data && allergies.data.filter((a) => a.is_active !== false).length > 0 && <AllergyBanner allergies={allergies.data.filter((a) => a.is_active !== false)} />}
        {it.specimen_status === 'collected' && <div className="alert warn">სინჯარა ჯერ არ არის მიღებული — დაასკანერეთ შტრიხკოდი.</div>}
        <div className="row small" style={{ flexWrap: 'wrap', gap: 10, marginTop: 4 }}>
          <label className="row" style={{ gap: 6 }}>ანალიზატორი
            <select className="select" style={{ height: 30, fontSize: 13, maxWidth: 200 }} disabled={locked} value={method} onChange={(e) => setMethod(e.target.value)} aria-label="ანალიზატორი">
              <option value="">—</option>{methods.data?.filter((m) => m.is_active || m.id === method).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
          {it.gender === 'female' && <label className="row" style={{ gap: 6 }}>ორსულობა (კვ.)
            <input className="input mono" style={{ height: 30, width: 56, fontSize: 13 }} inputMode="numeric" readOnly={locked} placeholder="—" value={preg} aria-label="ორსულობის კვირა"
              onChange={(e) => setPreg(e.target.value.replace(/\D/g, '').slice(0, 2))} /></label>}
          {metaDirty && <span className="muted">ნორმა შეიცვლება შენახვისას</span>}
        </div>
        {it.norm_recalculated_at && it.status !== 'validated' && <div className="alert info">ნორმა შეიცვალა ({tsDate(it.norm_recalculated_at)}) — ნიშნები ახალი ნორმით გადაითვალა. გადაამოწმეთ ვალიდაციამდე.</div>}
      </div>
      <form style={{ flex: 1, overflow: 'auto', padding: '8px 20px' }} onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <table className="table">
          <thead><tr><th>კომპონენტი</th><th style={{ width: 130 }}>შედეგი</th><th>ერთ.</th><th>ნორმა</th><th /></tr></thead>
          <tbody>{it.analytes.map((a, idx) => {
            const v = vals[a.id] ?? ''; const f = previewFlag(a, v);
            const crit = f === 'LL' || f === 'HH';
            return (
              <tr key={a.id} style={crit ? { background: 'var(--danger-weak)' } : undefined}>
                <td><label htmlFor={`an-${a.id}`}>{a.name}</label></td>
                <td>{a.result_type === 'select' && a.options ? (
                  <select id={`an-${a.id}`} className="select" style={{ height: 34, fontSize: 14 }} disabled={locked} value={v} onChange={(e) => setVals({ ...vals, [a.id]: e.target.value })}>
                    <option value="">—</option>{a.options.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : (
                  <input id={`an-${a.id}`} className={`input mono${f === 'ERR' ? ' invalid' : ''}`} style={{ height: 34, fontSize: 14, fontWeight: f && f !== 'N' ? 700 : 400 }} autoFocus={idx === 0 && !locked}
                    inputMode={a.result_type === 'numeric' ? 'decimal' : 'text'} readOnly={locked} value={v} onChange={(e) => setVals({ ...vals, [a.id]: e.target.value })} />
                )}</td>
                <td className="small muted">{unitFmt(a.unit)}</td>
                <td className="small muted">{refRange(a.range)}{a.range?.pregnancy && <div>{PREG_KA[a.range.pregnancy]}</div>}{a.range?.method_id && <div>{methods.data?.find((m) => m.id === a.range?.method_id)?.name ?? 'ანალიზატორის ნორმა'}</div>}</td>
                <td>{f === 'ERR' ? <span className="chip danger">რიცხვი?</span> : <FlagBadge flag={f} />}</td>
              </tr>
            );
          })}</tbody>
        </table>
        <span className="hint">ნიშნები ავტომატურად ითვლება ნორმით (სქესი, ასაკი, ორსულობა, ანალიზატორი). ↑↑/↓↓ — კრიტიკული მნიშვნელობა: აცნობეთ მკურნალ ექიმს.</span>
      </form>
      <div className="stack" style={{ padding: '12px 20px', borderTop: '1px solid var(--line)' }}>
        <ErrorBox error={save.error ?? validate.error ?? reopen.error ?? print.error} />
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {!locked && <button className="btn" type="button" disabled={save.isPending || !dirty} onClick={() => save.mutate()}>შენახვა</button>}
          {isLabDoctor && it.status === 'resulted' && !dirty && <button className="btn primary" type="button" disabled={validate.isPending} onClick={() => validate.mutate()}>დადასტურება (ვალიდაცია)</button>}
          {!isLabDoctor && canEnter && it.status === 'resulted' && <span className="small muted">ელოდება ლაბორატორიის ექიმის დადასტურებას</span>}
          {it.status === 'validated' && <>
            <button className="btn" type="button" onClick={() => print.mutate()}>ბლანკი</button>
            {isLabDoctor && <button className="btn" type="button" onClick={() => { const r = prompt('შესწორების მიზეზი:'); if (r && r.trim().length >= 5) reopen.mutate(r.trim()); }}>შესწორება</button>}
            <span className="small muted grow" style={{ textAlign: 'right' }}>{it.validated_by_name} · {it.validated_at && tsDate(it.validated_at)}</span>
          </>}
        </div>
      </div>
      {toast.node}
    </aside>
  );
}

// ======================================================================= რადიოლოგია / ენდოსკოპია
const RAD_VIEWS: { key: string; label: string; roles: string[] }[] = [
  { key: 'schedule', label: 'განრიგი', roles: ['admin', 'receptionist', 'radiographer', 'radiologist', 'manager', 'viewer'] },
  { key: 'queue', label: 'ტექნიკოსი — რიგი', roles: ['admin', 'radiographer', 'receptionist'] },
  { key: 'reports', label: 'დასკვნები', roles: ['admin', 'radiologist', 'radiographer'] },
  { key: 'templates', label: 'შაბლონები', roles: ['admin', 'radiologist'] },
];
const ENDO_VIEWS: typeof RAD_VIEWS = [
  { key: 'schedule', label: 'განრიგი', roles: ['admin', 'receptionist', 'endoscopy_nurse', 'endoscopist', 'manager', 'viewer'] },
  { key: 'queue', label: 'ექთანი — პროცედურები', roles: ['admin', 'endoscopy_nurse', 'endoscopist', 'receptionist'] },
  { key: 'reports', label: 'ოქმები', roles: ['admin', 'endoscopist', 'endoscopy_nurse'] },
  { key: 'pathology', label: 'პათოლოგია', roles: ['admin', 'endoscopist', 'endoscopy_nurse', 'receptionist'] },
  { key: 'scopes', label: 'ენდოსკოპები', roles: ['admin', 'endoscopist', 'endoscopy_nurse', 'med_engineer'] },
  { key: 'templates', label: 'შაბლონები', roles: ['admin', 'endoscopist'] },
];
/** როლის მიხედვით ნაგულისხმევი ხედი */
const RAD_DEFAULT: Record<string, string> = { radiographer: 'queue', radiologist: 'reports', receptionist: 'schedule', manager: 'schedule', viewer: 'schedule' };
const ENDO_DEFAULT: Record<string, string> = { endoscopy_nurse: 'queue', endoscopist: 'reports', receptionist: 'schedule', manager: 'schedule', viewer: 'schedule', med_engineer: 'scopes' };

function ImagingWorkspace({ section }: { section: 'radiology' | 'endoscopy' }) {
  const { user } = useAuth();
  const [sp, setSp] = useSearchParams();
  const views = (section === 'radiology' ? RAD_VIEWS : ENDO_VIEWS).filter((v) => can(user, ...(v.roles as Role[])));
  const defaults = section === 'radiology' ? RAD_DEFAULT : ENDO_DEFAULT;
  const byRole = [...(user?.roles[0]?.capabilities ?? []), ...(user?.caps ?? [])].map((c) => defaults[c]).find(Boolean);
  const wanted = sp.get('view') ?? byRole ?? views[0]?.key;
  const view = views.some((v) => v.key === wanted) ? wanted : views[0]?.key;
  if (!view) return <div className="content"><div className="card empty">წვდომა არ გაქვთ.</div></div>;
  return (
    <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      {views.length > 1 && <div className="row" style={{ padding: '10px 28px 0', gap: 6 }}>
        <div className="seg" role="group" aria-label="ხედი">{views.map((v) => <button key={v.key} type="button" aria-pressed={view === v.key} onClick={() => setSp({ view: v.key }, { replace: true })}>{v.label}</button>)}</div>
      </div>}
      <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex' }}>
        {view === 'schedule' && <Schedule key={section} section={section} />}
        {view === 'queue' && <TechQueue key={section} section={section} />}
        {view === 'pathology' && <Pathology />}
        {view === 'scopes' && <Scopes />}
        {view === 'reports' && <Reporting key={section} section={section} />}
        {view === 'templates' && <Templates key={section} section={section} />}
      </div>
    </div>
  );
}
