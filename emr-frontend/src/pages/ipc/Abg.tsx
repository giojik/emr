import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, can } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Field, Loading, Modal } from '../../components/ui';
import { useModuleEnabled, useModules } from '../../lib/modules';
import { tsDate } from '../../lib/format';
import { downloadFile } from '../reporting/types';
import { IPC_FULL } from './types';

type CellV = { n: number; s: number; i: number; r: number; pct: number } | null;
interface Abx { id: string; code: string; name: string; class: string | null }
export interface AbgData {
  from: string; to: string; dedup: string; min_n: number; label: string; excluded_services: string[]; isolates_raw: number; isolates: number; patients: number;
  sections: { gram: string; label: string; antibiotics: Abx[]; rows: { organism_id: string; code: string; name: string; n: number; low: boolean; cells: CellV[] }[] }[];
  mdro: { code: string; name: string; target: string; denominator: number; n: number; pct: number | null; low: boolean }[];
}
interface Published { id: string; title: string; period_from: string; period_to: string; filters_label: string; isolates: number; note: string | null; status: string;
  published_at: string; withdrawn_at: string | null; withdraw_reason: string | null; published_by_name: string }
interface Meta { departments: { id: string; name: string; care_level: string }[]; services: { id: string; code: string; name: string }[]; dedup: string; min_n: number; exclude_services: string[] }

const lastYear = () => { const y = new Date().getFullYear() - 1; return { from: `${y}-01-01`, to: `${y}-12-31` }; };
const tone = (p: number) => (p >= 90 ? 'var(--ok-weak)' : p >= 70 ? 'var(--warn-weak)' : 'var(--danger-weak)');

/** ანტიბიოგრამის ცხრილი (%S) — IPC ჩანართი და გამოქვეყნებული ვერსია */
export function AbgTable({ d }: { d: AbgData }) {
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="small muted">
        {d.from} — {d.to} · {d.label} · იზოლატები: <strong>{d.isolates}</strong>{d.isolates_raw !== d.isolates && <> (დუბლიკატების მოცილებამდე {d.isolates_raw})</>} · პაციენტები: {d.patients} ·{' '}
        {d.dedup === 'first_patient' ? 'პირველი იზოლატი პაციენტზე × მიკროორგანიზმზე (CLSI M39)' : 'ყველა იზოლატი'}.
        <div>%S = მგრძნობიარე / ტესტირებული („I“ არ ითვლება). <span style={{ opacity: 0.6 }}>ნაცრისფერი *</span> — n &lt; {d.min_n}, სტატისტიკურად არასანდო.
          {d.excluded_services.length > 0 && <> გამორიცხულია (სკრინინგი): {d.excluded_services.join(', ')}.</>}</div>
      </div>
      {!d.sections.length && <div className="alert">პერიოდში საბოლოო პასუხით იზოლატი არ არის.</div>}
      {d.sections.map((s) => (
        <section key={s.gram} className="card" style={{ overflowX: 'auto', flexShrink: 0 }}>
          <div className="card-pad" style={{ paddingBottom: 6 }}><strong>{s.label}</strong> <span className="small muted">— %S</span></div>
          <table className="table" style={{ fontSize: 13, width: 'auto', minWidth: '100%' }}>
            <thead><tr><th style={{ position: 'sticky', left: 0, background: 'var(--surface)', minWidth: 220 }}>მიკროორგანიზმი</th><th className="num">n</th>
              {s.antibiotics.map((a) => <th key={a.id} className="mono" title={`${a.name}${a.class ? ` (${a.class})` : ''}`} style={{ textAlign: 'center', padding: '6px 4px' }}>{a.code}</th>)}</tr></thead>
            <tbody>{s.rows.map((r) => (
              <tr key={r.organism_id} style={r.low ? { opacity: 0.55 } : undefined}>
                <td style={{ position: 'sticky', left: 0, background: 'var(--surface)' }}><em>{r.name}</em>{r.low && ' *'}</td>
                <td className="num mono">{r.n}</td>
                {r.cells.map((c, i) => <td key={s.antibiotics[i].id} className="mono" style={{ textAlign: 'center', padding: '6px 4px', background: c ? tone(c.pct) : undefined }}
                  title={c ? `${s.antibiotics[i].name}: S ${c.s} · I ${c.i} · R ${c.r} (n ${c.n})` : 'არ ტესტირებულა'}>{c ? c.pct : ''}</td>)}
              </tr>))}
            </tbody>
          </table>
        </section>))}
      {d.mdro.length > 0 && (
        <section className="card" style={{ overflowX: 'auto', flexShrink: 0 }}>
          <div className="card-pad" style={{ paddingBottom: 6 }}><strong>MDRO წილი</strong> <span className="small muted">— მიზნობრივი მიკროორგანიზმების იზოლატებში</span></div>
          <table className="table">
            <thead><tr><th>MDRO</th><th>მიზნობრივი</th><th className="num">იზოლატები</th><th className="num">MDRO</th><th className="num">%</th></tr></thead>
            <tbody>{d.mdro.map((m) => (
              <tr key={m.code} style={m.low ? { opacity: 0.55 } : undefined}><td>{m.name}{m.low && ' *'}</td><td className="small mono">{m.target}</td>
                <td className="num mono">{m.denominator}</td><td className="num mono">{m.n}</td><td className="num mono"><strong>{m.pct === null ? '—' : `${m.pct}%`}</strong></td></tr>))}
            </tbody>
          </table>
        </section>)}
      {d.sections.length > 0 && <div className="small muted">{[...new Map(d.sections.flatMap((s) => s.antibiotics.map((a) => [a.code, a.name] as const))).entries()].sort()
        .map(([k, v]) => `${k} — ${v}`).join(' · ')}</div>}
    </div>
  );
}

/** IPC → „ანტიბიოგრამა“: მიმდინარე (ფილტრებით), გამოქვეყნება, გამოქვეყნებულების სია */
export default function AbgTab() {
  const { user } = useAuth(); const full = can(user, ...IPC_FULL);
  const [view, setView] = useState<'current' | 'published'>('current');
  const [f, setF] = useState({ ...lastYear(), department_id: '', care: '', setting: '', service_id: '' });
  const [pub, setPub] = useState(false);
  const meta = useQuery({ queryKey: ['ipc-abg-meta'], queryFn: () => api<Meta>('/ipc/abg/meta') });
  const q = useQuery({ queryKey: ['ipc-abg', f], queryFn: () => api<AbgData>('/ipc/abg/current', { query: f }), enabled: view === 'current' && !!f.from && !!f.to && f.from <= f.to });
  const [dl, setDl] = useState<unknown>(null);
  const exp = (format: string) => { setDl(null); downloadFile('/ipc/abg/export', { ...f, format }, `antibiogram_${f.from}_${f.to}.${format}`).catch(setDl); };
  return (
    <div className="content">
      <div className="seg" role="group" aria-label="ანტიბიოგრამა">
        {([['current', 'მიმდინარე'], ['published', 'გამოქვეყნებული']] as const).map(([k, l]) => <button key={k} type="button" aria-pressed={view === k} onClick={() => setView(k)}>{l}</button>)}
      </div>
      {view === 'current' && <>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <input type="date" className="input" style={{ maxWidth: 160, height: 38 }} aria-label="დან" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
          <input type="date" className="input" style={{ maxWidth: 160, height: 38 }} aria-label="მდე" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
          <select className="select" style={{ maxWidth: 220, height: 38 }} aria-label="განყოფილება" value={f.department_id} onChange={(e) => setF({ ...f, department_id: e.target.value })}>
            <option value="">მთელი კლინიკა</option>{meta.data?.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
          <select className="select" style={{ maxWidth: 180, height: 38 }} aria-label="ICU" value={f.care} onChange={(e) => setF({ ...f, care: e.target.value })}>
            <option value="">ICU და სხვა</option><option value="icu">ICU / ინტენსიური</option><option value="non_icu">ICU-ს გარეშე</option></select>
          <select className="select" style={{ maxWidth: 200, height: 38 }} aria-label="სერვისი" value={f.setting} onChange={(e) => setF({ ...f, setting: e.target.value })}>
            <option value="">სტაციონარი და ამბულატორია</option><option value="inpatient">სტაციონარი</option><option value="outpatient">ამბულატორია / გადაუდებელი</option></select>
          <select className="select" style={{ maxWidth: 240, height: 38 }} aria-label="ანალიზი" value={f.service_id} onChange={(e) => setF({ ...f, service_id: e.target.value })}>
            <option value="">ყველა ნიმუში / ანალიზი</option>{meta.data?.services.filter((s) => !meta.data?.exclude_services.includes(s.id)).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
          <span className="grow" />
          <button className="btn" type="button" onClick={() => exp('xlsx')}>xlsx</button>
          <button className="btn" type="button" onClick={() => exp('pdf')}>PDF</button>
          {full && <button className="btn primary" type="button" disabled={!q.data?.isolates} onClick={() => setPub(true)}>გამოქვეყნება…</button>}
        </div>
        <ErrorBox error={q.error ?? dl} />
        {f.from > f.to && <div className="alert warn">პერიოდის დასაწყისი დასასრულზე გვიანაა.</div>}
        {q.isLoading ? <Loading /> : q.data && <AbgTable d={q.data} />}
      </>}
      {view === 'published' && <PublishedList manage={full} />}
      {pub && q.data && <PublishDialog f={f} d={q.data} onClose={() => setPub(false)} onDone={() => { setPub(false); setView('published'); }} />}
    </div>
  );
}

function PublishDialog({ f, d, onClose, onDone }: { f: Record<string, string>; d: AbgData; onClose: () => void; onDone: () => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState(`ანტიბიოგრამა ${d.from.slice(0, 4) === d.to.slice(0, 4) ? d.from.slice(0, 4) : `${d.from} — ${d.to}`} — ${d.label}`);
  const [note, setNote] = useState('');
  const m = useMutation({ mutationFn: () => api('/ipc/abg/publish', { body: { title: title.trim(), from: f.from, to: f.to, note: note.trim() || undefined,
    ...Object.fromEntries(['department_id', 'care', 'setting', 'service_id'].filter((k) => f[k]).map((k) => [k, f[k]])) } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['ipc-abg-published'] }); onDone(); } });
  return (
    <Modal title="ანტიბიოგრამის გამოქვეყნება" onClose={onClose} width={600} footer={<>
      <button className="btn" type="button" onClick={onClose}>გაუქმება</button>
      <button className="btn primary" type="button" disabled={title.trim().length < 3 || m.isPending} onClick={() => m.mutate()}>გამოქვეყნება</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <ErrorBox error={m.error} />
        <div className="alert">ფიქსირდება მიმდინარე გამოთვლა ({d.isolates} იზოლატი, {d.from} — {d.to}, {d.label}). გამოქვეყნებულს ხედავს ყველა კლინიცისტი; ცვლილება შეუძლებელია — მხოლოდ გაუქმება.</div>
        <Field label="სათაური" htmlFor="at" required><input id="at" className="input" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} /></Field>
        <Field label="შენიშვნა (ექიმებისთვის)" htmlFor="an"><textarea id="an" className="textarea" rows={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)}
          placeholder="მაგ. ემპირიული თერაპიის რეკომენდაციები, შეზღუდვები" /></Field>
      </div>
    </Modal>
  );
}

function PublishedList({ manage }: { manage: boolean }) {
  const qc = useQueryClient();
  const [all, setAll] = useState(false); const [open, setOpen] = useState<string | null>(null); const [wd, setWd] = useState<Published | null>(null);
  const q = useQuery({ queryKey: ['ipc-abg-published', all], queryFn: () => api<Published[]>('/ipc/abg/published', { query: { all: all ? '1' : '' } }) });
  const [reason, setReason] = useState('');
  const w = useMutation({ mutationFn: () => api(`/ipc/abg/published/${wd!.id}/withdraw`, { body: { reason: reason.trim() } }),
    onSuccess: () => { setWd(null); setReason(''); void qc.invalidateQueries({ queryKey: ['ipc-abg-published'] }); } });
  return (
    <>
      {manage && <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> გაუქმებულიც</label>}
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : <PubTable rows={q.data ?? []} onOpen={setOpen} onWithdraw={manage ? setWd : undefined} />}
      {open && <PublishedView id={open} onClose={() => setOpen(null)} />}
      {wd && <Modal title="ანტიბიოგრამის გაუქმება" onClose={() => setWd(null)} width={520} footer={<>
        <button className="btn" type="button" onClick={() => setWd(null)}>დახურვა</button>
        <button className="btn danger" type="button" disabled={reason.trim().length < 3 || w.isPending} onClick={() => w.mutate()}>გაუქმება</button></>}>
        <div className="stack" style={{ gap: 12 }}><ErrorBox error={w.error} /><div>{wd.title}</div>
          <Field label="მიზეზი" htmlFor="wr" required><textarea id="wr" className="textarea" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field></div>
      </Modal>}
    </>
  );
}

function PubTable({ rows, onOpen, onWithdraw }: { rows: Published[]; onOpen: (id: string) => void; onWithdraw?: (p: Published) => void }) {
  return (
    <div className="card" style={{ overflowX: 'auto', flexShrink: 0 }}>
      <table className="table">
        <thead><tr><th>სათაური</th><th>პერიოდი</th><th>არე</th><th className="num">იზოლატები</th><th>გამოქვეყნდა</th><th /></tr></thead>
        <tbody>{rows.map((p) => (
          <tr key={p.id} className="clickable" onClick={() => onOpen(p.id)}>
            <td><strong>{p.title}</strong>{p.status === 'withdrawn' && <span className="chip" style={{ marginLeft: 6 }} title={p.withdraw_reason ?? ''}>გაუქმებული</span>}
              {p.note && <div className="small muted" style={{ maxWidth: 420, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.note}</div>}</td>
            <td className="mono small">{p.period_from} — {p.period_to}</td><td className="small">{p.filters_label}</td><td className="num mono">{p.isolates}</td>
            <td className="small"><span className="mono">{tsDate(p.published_at)}</span><div className="muted">{p.published_by_name}</div></td>
            <td>{onWithdraw && p.status === 'published' && <button className="btn sm" type="button" onClick={(e) => { e.stopPropagation(); onWithdraw(p); }}>გაუქმება</button>}</td>
          </tr>))}
          {!rows.length && <tr><td colSpan={6} className="muted">გამოქვეყნებული ანტიბიოგრამა არ არის</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function PublishedView({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['ipc-abg-one', id], queryFn: () => api<Published & { data: AbgData }>(`/ipc/abg/published/${id}`) });
  const [dl, setDl] = useState<unknown>(null);
  const exp = (format: string) => { setDl(null); downloadFile('/ipc/abg/export', { id, format }, `antibiogram.${format}`).catch(setDl); };
  return (
    <Modal title={q.data?.title ?? 'ანტიბიოგრამა'} onClose={onClose} width={1200} footer={<>
      <button className="btn" type="button" onClick={() => exp('xlsx')}>xlsx</button><button className="btn" type="button" onClick={() => exp('pdf')}>PDF</button>
      <button className="btn" type="button" onClick={onClose}>დახურვა</button></>}>
      <ErrorBox error={q.error ?? dl} />
      {q.isLoading ? <Loading /> : q.data && <div className="stack" style={{ gap: 10 }}>
        {q.data.status === 'withdrawn' && <div className="alert warn">გაუქმებულია: {q.data.withdraw_reason}</div>}
        <div className="small muted">გამოქვეყნდა {tsDate(q.data.published_at)} · {q.data.published_by_name}</div>
        {q.data.note && <div className="alert" style={{ whiteSpace: 'pre-wrap' }}>{q.data.note}</div>}
        <AbgTable d={q.data.data} />
      </div>}
    </Modal>
  );
}

/** /antibiogram — გამოქვეყნებული ანტიბიოგრამა კლინიცისტებისთვის (უახლესი — ღიაა) */
export function AntibiogramPage() {
  const mods = useModules(); const enabled = useModuleEnabled('ipc');
  const [sp, setSp] = useSearchParams();
  const list = useQuery({ queryKey: ['ipc-abg-published', false], queryFn: () => api<Published[]>('/ipc/abg/published'), enabled });
  const id = sp.get('id') ?? list.data?.[0]?.id ?? null;
  const q = useQuery({ queryKey: ['ipc-abg-one', id], queryFn: () => api<Published & { data: AbgData }>(`/ipc/abg/published/${id}`), enabled: enabled && !!id });
  const [dl, setDl] = useState<unknown>(null);
  const exp = (format: string) => { if (!id) return; setDl(null); downloadFile('/ipc/abg/export', { id, format }, `antibiogram.${format}`).catch(setDl); };
  if (mods.isLoading) return <div className="content"><Loading /></div>;
  if (!enabled) return <div className="content"><div className="alert warn">მოდული „ინფექციის კონტროლი“ გამორთულია.</div></div>;
  return (
    <>
      <header className="topbar"><h1 className="grow">ანტიბიოგრამა</h1>
        {(list.data?.length ?? 0) > 1 && <select className="select" style={{ maxWidth: 420, height: 38 }} aria-label="ვერსია" value={id ?? ''} onChange={(e) => setSp({ id: e.target.value })}>
          {list.data?.map((p) => <option key={p.id} value={p.id}>{p.title} ({tsDate(p.published_at)})</option>)}</select>}
        {id && <><button className="btn" type="button" onClick={() => exp('xlsx')}>xlsx</button><button className="btn" type="button" onClick={() => exp('pdf')}>PDF</button></>}
      </header>
      <div className="content">
        <ErrorBox error={list.error ?? q.error ?? dl} />
        {list.isLoading || q.isLoading ? <Loading /> : !list.data?.length ? <div className="alert">გამოქვეყნებული ანტიბიოგრამა ჯერ არ არის (აქვეყნებს ინფექციის კონტროლი).</div>
          : q.data && <>
            <div><strong style={{ fontSize: 18 }}>{q.data.title}</strong><div className="small muted">გამოქვეყნდა {tsDate(q.data.published_at)} · {q.data.published_by_name}</div></div>
            {q.data.note && <div className="alert" style={{ whiteSpace: 'pre-wrap', flexShrink: 0 }}>{q.data.note}</div>}
            <AbgTable d={q.data.data} />
          </>}
      </div>
    </>
  );
}
