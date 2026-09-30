import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { api, can, openBlob } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Field, Loading, Modal, useToast } from '../../components/ui';
import { time, tsDate } from '../../lib/format';

// ============================================================ ტიპები
interface Ast { antibiotic_id: string; code: string; name: string; mic: string | null; zone_mm: string | null; interp: 'S' | 'I' | 'R' | null; reported: boolean; reserve: boolean }
interface Isolate { id: string; seq: number; organism_id: string; organism: string; organism_code: string; quantity: string | null; comment: string | null; ast: Ast[] }
interface Detail {
  item: { id: string; status: string; service_name?: string; first_name?: string; last_name?: string; barcode?: string | null };
  culture: { stage: 'incubating' | 'no_growth' | 'growth' | 'contaminated'; gram_stain: string | null; growth_summary: string | null; comment: string | null };
  isolates: Isolate[]; reports: { id: string; kind: 'prelim' | 'final'; issued_at: string; issued_by_name: string | null }[];
}
interface Refs { organisms: { id: string; code: string; name: string; gram: string; group_code: string; is_active: boolean }[];
  antibiotics: { id: string; code: string; name: string; class: string | null; is_active: boolean }[];
  panels: { id: string; code: string; name: string; group_code: string; is_active: boolean; items: { antibiotic_id: string; code: string; name: string; reserve: boolean; sort_order: number }[] }[] }
interface Snapshot { stage: string; gram_stain: string | null; growth_summary: string | null; comment: string | null;
  isolates: { seq: number; organism: string | null; organism_code: string | null; quantity: string | null; comment: string | null; ast: { code: string; name: string; mic: string | null; zone_mm: string | null; interp: string | null }[] }[] }

export const STAGE: Record<string, string> = { incubating: 'ინკუბაცია — ზრდა ჯერ არ შეფასებულა', no_growth: 'ზრდა არ აღინიშნა', growth: 'ზრდა', contaminated: 'კონტამინაცია (შერეული ფლორა)' };
const INTERP_COLOR: Record<string, string> = { S: 'var(--ok-ink, #067647)', I: 'var(--warn-ink)', R: 'var(--danger-ink)' };
const useRefs = () => useQuery({ queryKey: ['micro-refs'], queryFn: () => api<Refs>('/lab/micro/refs'), staleTime: 5 * 60_000 });

// ============================================================ ლაბორატორია: კულტურა → იზოლატები → ანტიბიოგრამა → წინასწარი / საბოლოო
export function MicroModal({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient(); const { user } = useAuth(); const toast = useToast();
  const isLabDoctor = can(user, 'admin', 'lab_doctor');
  const q = useQuery({ queryKey: ['micro', id], queryFn: () => api<Detail>(`/lab/micro/items/${id}`) });
  const refs = useRefs();
  const [c, setC] = useState<Detail['culture'] | null>(null);
  useEffect(() => { if (q.data) setC(q.data.culture); }, [q.data]);
  const refresh = () => { for (const k of ['micro', 'lab-worklist']) void qc.invalidateQueries({ queryKey: [k] }); };
  const locked = q.data?.item.status === 'validated' || q.data?.item.status === 'cancelled';
  const saveC = useMutation({ mutationFn: () => api(`/lab/micro/items/${id}/culture`, { method: 'PUT', body: c }), onSuccess: () => { refresh(); toast.show('შენახულია'); } });
  const prelim = useMutation({ mutationFn: () => api(`/lab/micro/items/${id}/prelim`, { method: 'POST' }), onSuccess: () => { refresh(); toast.show('წინასწარი პასუხი გაიცა — ექიმს ჩანს'); } });
  const complete = useMutation({ mutationFn: () => api(`/lab/micro/items/${id}/complete`, { method: 'POST' }), onSuccess: () => { refresh(); toast.show('მზადაა — ვალიდაციას ელოდება'); } });
  const final = useMutation({ mutationFn: () => api(`/lab/micro/items/${id}/final`, { method: 'POST' }), onSuccess: () => { refresh(); toast.show('საბოლოო პასუხი დადასტურდა'); } });
  const [addOrg, setAddOrg] = useState(''); const [addQty, setAddQty] = useState('');
  const add = useMutation({ mutationFn: () => api(`/lab/micro/items/${id}/isolates`, { method: 'POST', body: { organism_id: addOrg, quantity: addQty.trim() || null } }),
    onSuccess: () => { setAddOrg(''); setAddQty(''); refresh(); } });
  const dirty = !!c && !!q.data && JSON.stringify(c) !== JSON.stringify(q.data.culture);
  const it = q.data?.item;
  return (
    <Modal title={`მიკრობიოლოგია${it?.service_name ? `: ${it.service_name}` : ''}`} onClose={onClose} width={1100}
      footer={<>
        <button className="btn" type="button" onClick={() => void openBlob(`/lab/micro/items/${id}/report.pdf`)}>PDF</button>
        <span className="grow" />
        {!locked && isLabDoctor && <button className="btn" type="button" disabled={dirty || prelim.isPending} onClick={() => prelim.mutate()} title="ექიმს ჩანს მიმდინარე მდგომარეობა">წინასწარი პასუხი</button>}
        {!locked && it?.status !== 'resulted' && <button className="btn" type="button" disabled={dirty || complete.isPending} onClick={() => complete.mutate()}>მზადაა (ვალიდაციაზე)</button>}
        {isLabDoctor && it?.status === 'resulted' && <button className="btn primary" type="button" disabled={dirty || final.isPending} onClick={() => final.mutate()}>საბოლოო (ვალიდაცია)</button>}
        <button className="btn" type="button" onClick={onClose}>დახურვა</button>
      </>}>
      {q.isLoading || !c || !q.data ? <Loading /> : <div className="stack">
        {it?.first_name && <div className="small muted">{it.last_name} {it.first_name} · <span className="mono">{it.barcode}</span> · სტატუსი: {it.status}</div>}
        {locked && <div className="alert ok small">პასუხი დადასტურებულია — ცვლილება მხოლოდ შესწორებით.</div>}
        <fieldset disabled={locked} style={{ border: 0, padding: 0, margin: 0 }} className="stack">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Field label="კულტურის სტადია" htmlFor="ms"><select id="ms" className="select" value={c.stage} onChange={(e) => setC({ ...c, stage: e.target.value as Detail['culture']['stage'] })}>
              {Object.entries(STAGE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
            <Field label="გრამის შეღებვა / მიკროსკოპია" htmlFor="mg"><input id="mg" className="input" value={c.gram_stain ?? ''} onChange={(e) => setC({ ...c, gram_stain: e.target.value || null })} placeholder="მაგ. გრამ-უარყოფითი ჩხირები" /></Field>
            <Field label="ზრდის შეჯამება" htmlFor="mgs"><input id="mgs" className="input" value={c.growth_summary ?? ''} onChange={(e) => setC({ ...c, growth_summary: e.target.value || null })} placeholder="მაგ. მონოკულტურა" /></Field>
            <Field label="კომენტარი" htmlFor="mc"><input id="mc" className="input" value={c.comment ?? ''} onChange={(e) => setC({ ...c, comment: e.target.value || null })} placeholder="მაგ. 48 სთ ინკუბაცია" /></Field>
          </div>
          {dirty && <div className="row"><button className="btn primary sm" type="button" disabled={saveC.isPending} onClick={() => saveC.mutate()}>კულტურის შენახვა</button></div>}
          {q.data.isolates.map((iso) => <IsolateCard key={iso.id} iso={iso} refs={refs.data} locked={locked} onChanged={refresh} />)}
          {!locked && (c.stage === 'growth' || q.data.culture.stage === 'growth') && <div className="card card-pad row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <strong className="small">+ მიკროორგანიზმი</strong>
            <OrganismSelect refs={refs.data} value={addOrg} onChange={setAddOrg} />
            <input aria-label="რაოდენობა" className="input" style={{ maxWidth: 180, height: 36 }} placeholder="10^5 CFU/mL" value={addQty} onChange={(e) => setAddQty(e.target.value)} />
            <button className="btn sm" type="button" disabled={!addOrg || add.isPending} onClick={() => add.mutate()}>დამატება (პანელით)</button>
          </div>}
        </fieldset>
        {q.data.reports.length > 0 && <div className="small muted">გაცემული: {q.data.reports.map((r) => `${r.kind === 'final' ? 'საბოლოო' : 'წინასწარი'} ${tsDate(r.issued_at)} ${time(r.issued_at)}${r.issued_by_name ? ` (${r.issued_by_name})` : ''}`).join(' · ')}</div>}
        <ErrorBox error={saveC.error ?? prelim.error ?? complete.error ?? final.error ?? add.error} />
      </div>}
      {toast.node}
    </Modal>
  );
}

function OrganismSelect({ refs, value, onChange }: { refs?: Refs; value: string; onChange: (v: string) => void }) {
  const [s, setS] = useState('');
  const list = useMemo(() => (refs?.organisms ?? []).filter((o) => o.is_active && (!s.trim() || `${o.name} ${o.code}`.toLowerCase().includes(s.trim().toLowerCase()))), [refs, s]);
  return <span className="row" style={{ gap: 4 }}>
    <input aria-label="ძებნა" className="input" style={{ width: 150, height: 36 }} placeholder="ძებნა…" value={s} onChange={(e) => setS(e.target.value)} />
    <select aria-label="მიკროორგანიზმი" className="select" style={{ maxWidth: 300, height: 36 }} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">— აირჩიეთ</option>{list.map((o) => <option key={o.id} value={o.id}><i>{o.name}</i> ({o.code})</option>)}</select></span>;
}

function IsolateCard({ iso, refs, locked, onChanged }: { iso: Isolate; refs?: Refs; locked: boolean; onChanged: () => void }) {
  const [rows, setRows] = useState<Ast[]>(iso.ast);
  useEffect(() => setRows(iso.ast), [iso.ast]);
  const [addAb, setAddAb] = useState('');
  const dirty = JSON.stringify(rows) !== JSON.stringify(iso.ast);
  const save = useMutation({ mutationFn: () => api(`/lab/micro/isolates/${iso.id}/ast`, { method: 'PUT', body: { rows: rows.map((r) => ({ antibiotic_id: r.antibiotic_id, mic: r.mic || null,
    zone_mm: r.zone_mm === null || r.zone_mm === '' ? null : Number(r.zone_mm), interp: r.interp, reported: r.reported })) } }), onSuccess: onChanged });
  const del = useMutation({ mutationFn: () => api(`/lab/micro/isolates/${iso.id}`, { method: 'DELETE' }), onSuccess: onChanged });
  const upd = (i: number, p: Partial<Ast>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const firstLineR = rows.some((r) => !r.reserve && r.interp === 'R');
  return (
    <div className="card card-pad stack" style={{ gap: 6 }}>
      <div className="row"><strong className="grow">{iso.seq}. <i>{iso.organism}</i> <span className="small muted">{iso.quantity}</span></strong>
        {!locked && <button className="btn sm" type="button" onClick={() => { if (confirm('მიკროორგანიზმის წაშლა?')) del.mutate(); }}>წაშლა</button>}</div>
      <table className="table">
        <thead><tr><th>ანტიბიოტიკი</th><th>MIC (mg/L)</th><th>ზონა (მმ)</th><th>შეფასება</th><th title="ექიმთან ჩვენება">ექიმთან</th></tr></thead>
        <tbody>{rows.map((r, i) => (
          <tr key={r.antibiotic_id} style={r.reserve ? { background: 'var(--bg)' } : undefined}>
            <td>{r.name} <span className="small muted mono">{r.code}</span>{r.reserve && <span className="chip" style={{ marginLeft: 6 }} title="სარეზერვო: ექიმთან ჩანს, თუ პირველი რიგის რომელიმეზე რეზისტენტულია ან მონიშნულია">სარეზ.</span>}</td>
            <td><input aria-label="MIC" className="input mono" style={{ width: 80, height: 30 }} disabled={locked} value={r.mic ?? ''} onChange={(e) => upd(i, { mic: e.target.value || null })} /></td>
            <td><input aria-label="ზონა" className="input mono" style={{ width: 60, height: 30 }} disabled={locked} value={r.zone_mm ?? ''} onChange={(e) => upd(i, { zone_mm: e.target.value.replace(/[^\d.]/g, '') || null })} /></td>
            <td><div className="seg" role="group" aria-label="შეფასება">{(['S', 'I', 'R'] as const).map((x) =>
              <button key={x} type="button" disabled={locked} aria-pressed={r.interp === x} style={r.interp === x ? { color: INTERP_COLOR[x], fontWeight: 700 } : undefined} onClick={() => upd(i, { interp: r.interp === x ? null : x })}>{x}</button>)}</div></td>
            <td><input type="checkbox" disabled={locked} checked={r.reported} onChange={(e) => upd(i, { reported: e.target.checked })} aria-label="ექიმთან" />
              {r.reserve && !r.reported && firstLineR && r.interp && <span className="small muted"> (ჩანს — რეზისტ.)</span>}</td>
          </tr>))}</tbody>
      </table>
      {!locked && <div className="row" style={{ gap: 8 }}>
        <select aria-label="ანტიბიოტიკის დამატება" className="select" style={{ maxWidth: 280, height: 32 }} value={addAb} onChange={(e) => setAddAb(e.target.value)}>
          <option value="">+ ანტიბიოტიკი პანელის გარეთ</option>
          {(refs?.antibiotics ?? []).filter((a) => a.is_active && !rows.some((r) => r.antibiotic_id === a.id)).map((a) => <option key={a.id} value={a.id}>{a.name} ({a.code})</option>)}</select>
        <button className="btn sm" type="button" disabled={!addAb} onClick={() => { const a = refs!.antibiotics.find((x) => x.id === addAb)!;
          setRows([...rows, { antibiotic_id: a.id, code: a.code, name: a.name, mic: null, zone_mm: null, interp: null, reported: true, reserve: false }]); setAddAb(''); }}>დამატება</button>
        <span className="grow" />
        {dirty && <button className="btn primary sm" type="button" disabled={save.isPending} onClick={() => save.mutate()}>ანტიბიოგრამის შენახვა</button>}
      </div>}
      <ErrorBox error={save.error ?? del.error} />
    </div>
  );
}

// ============================================================ ექიმის ხედი (წინასწარი / საბოლოო)
export function MicroView({ id, title, onClose }: { id: string; title: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['micro-view', id], queryFn: () => api<{ kind: 'final' | 'prelim' | 'draft' | 'none'; issued_at: string | null; report: Snapshot | null }>(`/lab/micro/items/${id}/view`) });
  const r = q.data?.report;
  return (
    <Modal title={title} onClose={onClose} width={820} footer={<>{q.data && q.data.kind !== 'none' && <button className="btn" type="button" onClick={() => void openBlob(`/lab/micro/items/${id}/report.pdf`)}>PDF</button>}<button className="btn" type="button" onClick={onClose}>დახურვა</button></>}>
      {q.isLoading ? <Loading /> : <ErrorBox error={q.error} />}
      {q.data?.kind === 'none' && <div className="empty">კულტურა მიმდინარეობს — პასუხი ჯერ არ გაცემულა.</div>}
      {r && <div className="stack">
        <div>{q.data!.kind === 'final' ? <span className="chip ok">საბოლოო პასუხი</span> : q.data!.kind === 'prelim' ? <span className="chip warn">წინასწარი პასუხი</span> : <span className="chip">მიმდინარე (ლაბორატორია)</span>}
          {q.data!.issued_at && <span className="small muted"> {tsDate(q.data!.issued_at)} {time(q.data!.issued_at)}</span>}</div>
        <div><strong>{STAGE[r.stage] ?? r.stage}</strong>{r.growth_summary ? ` · ${r.growth_summary}` : ''}</div>
        {r.gram_stain && <div className="small">გრამის შეღებვა: {r.gram_stain}</div>}
        {r.isolates.map((i) => <div key={i.seq} className="card card-pad stack" style={{ gap: 4 }}>
          <strong>{i.seq}. <i>{i.organism}</i> <span className="small muted">{i.quantity}</span></strong>
          {i.ast.length ? <table className="table"><thead><tr><th>ანტიბიოტიკი</th><th>MIC</th><th>ზონა</th><th>შეფასება</th></tr></thead>
            <tbody>{i.ast.map((a) => <tr key={a.code}><td>{a.name}</td><td className="mono small">{a.mic ?? ''}</td><td className="mono small">{a.zone_mm ?? ''}</td>
              <td><strong style={{ color: INTERP_COLOR[a.interp ?? ''] }}>{a.interp === 'S' ? 'S — მგრძნობიარე' : a.interp === 'I' ? 'I — შუალედური' : a.interp === 'R' ? 'R — რეზისტენტული' : ''}</strong></td></tr>)}</tbody></table>
            : <span className="small muted">ანტიბიოგრამა მზადდება</span>}
          {i.comment && <span className="small">{i.comment}</span>}
        </div>)}
        {r.comment && <div className="small">{r.comment}</div>}
      </div>}
    </Modal>
  );
}

// ============================================================ ცნობარი (ლაბ. ექიმი / მენეჯერი)
export function MicroRefs() {
  const qc = useQueryClient(); const refs = useRefs(); const { user } = useAuth();
  const canEdit = can(user, 'admin', 'lab_doctor', 'lab_manager');
  const [tab, setTab] = useState<'org' | 'ab' | 'panel'>('org');
  const [panelId, setPanelId] = useState('');
  const [f, setF] = useState({ code: '', name: '', gram: 'neg', group_code: 'ENT', cls: '' });
  const inv = () => void qc.invalidateQueries({ queryKey: ['micro-refs'] });
  const addOrg = useMutation({ mutationFn: () => api('/lab/micro/organisms', { body: { code: f.code.trim(), name: f.name.trim(), gram: f.gram, group_code: f.group_code } }), onSuccess: () => { setF({ ...f, code: '', name: '' }); inv(); } });
  const addAb = useMutation({ mutationFn: () => api('/lab/micro/antibiotics', { body: { code: f.code.trim(), name: f.name.trim(), class: f.cls.trim() || null } }), onSuccess: () => { setF({ ...f, code: '', name: '', cls: '' }); inv(); } });
  const toggle = useMutation({ mutationFn: ({ kind, id, active }: { kind: 'organisms' | 'antibiotics'; id: string; active: boolean }) => api(`/lab/micro/${kind}/${id}`, { method: 'PATCH', body: { is_active: active } }), onSuccess: inv });
  const panel = refs.data?.panels.find((p) => p.id === panelId);
  const setPanel = useMutation({ mutationFn: (items: { antibiotic_id: string; reserve: boolean }[]) => api(`/lab/micro/panels/${panelId}/items`, { method: 'PUT', body: { items } }), onSuccess: inv });
  if (refs.isLoading || !refs.data) return <Loading />;
  const groups = [...new Set(refs.data.organisms.map((o) => o.group_code))].sort();
  return (
    <div className="stack">
      <div className="seg" role="tablist">{[['org', `მიკროორგანიზმები (${refs.data.organisms.length})`], ['ab', `ანტიბიოტიკები (${refs.data.antibiotics.length})`], ['panel', 'პანელები']].map(([k, l]) =>
        <button key={k} type="button" aria-pressed={tab === k} onClick={() => setTab(k as typeof tab)}>{l}</button>)}</div>
      {canEdit && tab !== 'panel' && <div className="card card-pad row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <input aria-label="კოდი" className="input mono" style={{ width: 90, height: 36 }} placeholder="კოდი" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />
        <input aria-label="დასახელება" className="input" style={{ width: 260, height: 36 }} placeholder="დასახელება" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        {tab === 'org' ? <>
          <select aria-label="გრამი" className="select" style={{ height: 36 }} value={f.gram} onChange={(e) => setF({ ...f, gram: e.target.value })}><option value="neg">გრამ (−)</option><option value="pos">გრამ (+)</option><option value="fungus">სოკო</option><option value="other">სხვა</option></select>
          <select aria-label="ჯგუფი (პანელი)" className="select" style={{ height: 36 }} value={f.group_code} onChange={(e) => setF({ ...f, group_code: e.target.value })}>{groups.map((g) => <option key={g}>{g}</option>)}</select>
          <button className="btn sm" type="button" disabled={f.code.trim().length < 2 || f.name.trim().length < 2 || addOrg.isPending} onClick={() => addOrg.mutate()}>დამატება</button></>
          : <><input aria-label="კლასი" className="input" style={{ width: 180, height: 36 }} placeholder="კლასი (მაგ. ცეფალოსპორინი)" value={f.cls} onChange={(e) => setF({ ...f, cls: e.target.value })} />
          <button className="btn sm" type="button" disabled={f.code.trim().length < 2 || f.name.trim().length < 2 || addAb.isPending} onClick={() => addAb.mutate()}>დამატება</button></>}
      </div>}
      <ErrorBox error={addOrg.error ?? addAb.error ?? toggle.error ?? setPanel.error} />
      {tab === 'org' && <div className="card" style={{ maxHeight: 500, overflowY: 'auto' }}><table className="table"><tbody>{refs.data.organisms.map((o) => <tr key={o.id} style={o.is_active ? undefined : { opacity: 0.5 }}>
        <td className="mono small">{o.code}</td><td><i>{o.name}</i></td><td className="small">{o.gram === 'neg' ? 'გრამ (−)' : o.gram === 'pos' ? 'გრამ (+)' : o.gram === 'fungus' ? 'სოკო' : 'სხვა'}</td><td className="small mono">{o.group_code}</td>
        <td>{canEdit && <label className="row small"><input type="checkbox" checked={o.is_active} onChange={(e) => toggle.mutate({ kind: 'organisms', id: o.id, active: e.target.checked })} /> აქტიური</label>}</td></tr>)}</tbody></table></div>}
      {tab === 'ab' && <div className="card" style={{ maxHeight: 500, overflowY: 'auto' }}><table className="table"><tbody>{refs.data.antibiotics.map((a) => <tr key={a.id} style={a.is_active ? undefined : { opacity: 0.5 }}>
        <td className="mono small">{a.code}</td><td>{a.name}</td><td className="small muted">{a.class}</td>
        <td>{canEdit && <label className="row small"><input type="checkbox" checked={a.is_active} onChange={(e) => toggle.mutate({ kind: 'antibiotics', id: a.id, active: e.target.checked })} /> აქტიური</label>}</td></tr>)}</tbody></table></div>}
      {tab === 'panel' && <div className="stack">
        <select aria-label="პანელი" className="select" style={{ maxWidth: 360, height: 38 }} value={panelId} onChange={(e) => setPanelId(e.target.value)}>
          <option value="">— პანელი</option>{refs.data.panels.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.group_code})</option>)}</select>
        <span className="hint">პანელი ავტომატურად ერთვის მიკროორგანიზმს მისი ჯგუფით. „სარეზერვო“ — ექიმთან ჩანს მხოლოდ მაშინ, როცა პირველი რიგის რომელიმეზე რეზისტენტობაა, ან ლაბ. ექიმი ხელით მონიშნავს.</span>
        {panel && <div className="card" style={{ maxHeight: 460, overflowY: 'auto' }}><table className="table"><thead><tr><th>ანტიბიოტიკი</th><th>პანელში</th><th>სარეზერვო</th></tr></thead>
          <tbody>{refs.data.antibiotics.filter((a) => a.is_active).map((a) => { const inP = panel.items.find((x) => x.antibiotic_id === a.id);
            const set = (on: boolean, reserve: boolean) => setPanel.mutate([...panel.items.filter((x) => x.antibiotic_id !== a.id).map((x) => ({ antibiotic_id: x.antibiotic_id, reserve: x.reserve })), ...(on ? [{ antibiotic_id: a.id, reserve }] : [])]);
            return <tr key={a.id}><td>{a.name} <span className="small muted mono">{a.code}</span></td>
              <td><input type="checkbox" disabled={!canEdit || setPanel.isPending} checked={!!inP} onChange={(e) => set(e.target.checked, false)} aria-label="პანელში" /></td>
              <td><input type="checkbox" disabled={!canEdit || !inP || setPanel.isPending} checked={!!inP?.reserve} onChange={(e) => set(true, e.target.checked)} aria-label="სარეზერვო" /></td></tr>; })}</tbody></table></div>}
      </div>}
    </div>
  );
}
