import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../../api/client';
import { ErrorBox, Field, Loading, Modal, useDebounced } from '../../../components/ui';
import { type CcRow, type CodeList, GKIND_KA, type Group, LKIND_KA, type VersionDetail } from './types';

/** ვერსიის შემადგენლობა (0055): ჯგუფები, კოდების სიები, CC / MCC — რედაქტირება მხოლოდ მონახაზში */
const useInval = (v: VersionDetail) => {
  const qc = useQueryClient();
  return () => { for (const k of ['drg-groups', 'drg-lists', 'drg-list', 'drg-cc', 'drg-rules', 'drg-version', 'drg-versions', 'drg-check']) void qc.invalidateQueries({ queryKey: [k] }); void v; };
};

// ================================================================= CSV იმპორტი (საერთო)
export function CsvImport({ title, path, columns, example, replaceLabel, onClose, onDone }: {
  title: string; path: string; columns: string; example: string; replaceLabel?: string; onClose: () => void; onDone: () => void;
}) {
  const [csv, setCsv] = useState(''); const [replace, setReplace] = useState(false);
  const [res, setRes] = useState<{ applied: boolean; errors: string[]; [k: string]: unknown } | null>(null);
  const m = useMutation({
    mutationFn: (dry: boolean) => api<{ applied: boolean; errors: string[] }>(path, { body: { csv, dry_run: dry, replace } }),
    onSuccess: (r, dry) => { setRes(r); if (!dry && r.applied) { onDone(); } },
  });
  const summary = res && Object.entries(res).filter(([k]) => !['errors', 'applied', 'replace'].includes(k)).map(([k, x]) => `${k}: ${String(x)}`).join(' · ');
  return (
    <Modal title={title} onClose={onClose} width={760}
      footer={<><button className="btn" type="button" onClick={onClose}>დახურვა</button>
        <button className="btn" type="button" disabled={!csv.trim() || m.isPending} onClick={() => m.mutate(true)}>შემოწმება</button>
        <button className="btn primary" type="button" disabled={!csv.trim() || m.isPending || !res || res.errors.length > 0 || res.applied} onClick={() => m.mutate(false)}>იმპორტი</button></>}>
      <div className="stack" style={{ gap: 10 }}>
        <span className="small muted">სვეტები: <span className="mono">{columns}</span>. გამყოფი — ; ან TAB ან , (Excel → „CSV UTF-8“); პირველი სტრიქონი შეიძლება სათაური იყოს. ჯერ „შემოწმება“, მერე „იმპორტი“.</span>
        <span className="small muted">მაგალითი: <span className="mono">{example}</span></span>
        <input className="input" style={{ padding: 8, height: 'auto' }} type="file" accept=".csv,.txt,text/csv" aria-label="CSV ფაილი"
          onChange={(e) => { const f = e.target.files?.[0]; setRes(null); if (f) void f.text().then(setCsv); }} />
        <textarea className="textarea mono" rows={8} aria-label="CSV ტექსტი" value={csv} onChange={(e) => { setCsv(e.target.value); setRes(null); }} placeholder="ან ჩასვით ტექსტი" />
        {replaceLabel && <label className="row small"><input type="checkbox" checked={replace} onChange={(e) => { setReplace(e.target.checked); setRes(null); }} /> {replaceLabel}</label>}
        {res && <div className="stack small" style={{ gap: 2 }}>
          <span>{res.applied ? '✓ იმპორტირებულია' : res.errors.length ? '✗ შეცდომები — იმპორტი არ შესრულდება' : '✓ შემოწმება გავლილია'} — {summary}</span>
          <div style={{ maxHeight: 160, overflow: 'auto' }}>{res.errors.map((e, i) => <div key={i} style={{ color: 'var(--danger, #b00020)' }}>{e}</div>)}</div>
        </div>}
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}

// ================================================================= ჯგუფები
export function GroupsTab({ v, edit }: { v: VersionDetail; edit: boolean }) {
  const [q, setQ] = useState(''); const dq = useDebounced(q.trim(), 250);
  const rows = useQuery({ queryKey: ['drg-groups', v.id, dq], queryFn: () => api<{ total: number; rows: Group[] }>(`/drg/versions/${v.id}/groups`, { query: { q: dq, limit: 1000 } }) });
  const [dlg, setDlg] = useState<null | 'csv' | Group | 'new'>(null);
  const inval = useInval(v);
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <input className="input" style={{ maxWidth: 320 }} placeholder="ძებნა: კოდი / დასახელება" aria-label="ძებნა" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="small muted grow">სულ: {rows.data?.total ?? '…'}</span>
        {edit && <><button className="btn sm" type="button" onClick={() => setDlg('csv')}>CSV იმპორტი</button><button className="btn sm primary" type="button" onClick={() => setDlg('new')}>+ ჯგუფი</button></>}
      </div>
      <span className="hint">წონა — ფარდობითი (1.0 = საშუალო შემთხვევა); თანხა = საბაზისო განაკვეთი × წონა. დღეების ზღვრები (ქვედა / ზედა) — ხანგრძლივი / მოკლე შემთხვევის კორექციისთვის (შემდეგი ეტაპი).</span>
      <ErrorBox error={rows.error} />
      {rows.isLoading ? <Loading /> : <table className="table">
        <thead><tr><th>კოდი</th><th>დასახელება</th><th className="num">წონა</th><th className="num">საშ. დღე</th><th className="num">ზღვრები</th><th>MDC</th><th>ტიპი</th><th className="num">წესი</th></tr></thead>
        <tbody>{rows.data?.rows.map((g) => <tr key={g.code} onClick={() => setDlg(g)} style={{ cursor: 'pointer' }}>
          <td className="mono"><strong>{g.code}</strong></td><td>{g.title}</td><td className="num mono">{Number(g.weight).toFixed(4)}</td><td className="num">{g.alos ? Number(g.alos) : '—'}</td>
          <td className="num small">{g.los_low ?? '—'} – {g.los_high ?? '—'}</td><td className="mono small">{g.mdc ?? ''}</td><td className="small">{GKIND_KA[g.kind]}</td>
          <td className="num">{g.n_rules || <span className="muted">0</span>}</td></tr>)}
          {rows.data?.rows.length === 0 && <tr><td colSpan={8}><div className="empty">ჯგუფი არ არის.</div></td></tr>}</tbody>
      </table>}
      {dlg === 'csv' && <CsvImport title="ჯგუფები — CSV იმპორტი" path={`/drg/versions/${v.id}/groups/import`} columns="code;title;weight[;alos[;los_low[;los_high[;mdc[;kind]]]]]"
        example="G01B;აპენდექტომია;0,95;3;1;8;06;surgical" replaceLabel="ფაილში არმყოფი ჯგუფების წაშლა (ვერსიის ჯგუფები = ფაილი)" onClose={() => setDlg(null)} onDone={inval} />}
      {dlg && dlg !== 'csv' && <GroupDialog v={v} g={dlg === 'new' ? null : dlg} edit={edit} onClose={() => setDlg(null)} onDone={inval} />}
    </div>
  );
}

function GroupDialog({ v, g, edit, onClose, onDone }: { v: VersionDetail; g: Group | null; edit: boolean; onClose: () => void; onDone: () => void }) {
  const s = (x: unknown) => (x === null || x === undefined ? '' : String(x));
  const [f, setF] = useState({ code: g?.code ?? '', title: g?.title ?? '', weight: g ? String(Number(g.weight)) : '', alos: g?.alos ? String(Number(g.alos)) : '', los_low: s(g?.los_low), los_high: s(g?.los_high),
    mdc: g?.mdc ?? '', kind: g?.kind ?? 'medical', notes: g?.notes ?? '' });
  const num = (x: string) => (x.trim() === '' ? null : Number(x.replace(',', '.')));
  const save = useMutation({
    mutationFn: () => api(`/drg/versions/${v.id}/groups/${encodeURIComponent(f.code.trim().toUpperCase())}`, { method: 'PUT', body: {
      title: f.title.trim(), weight: num(f.weight), alos: num(f.alos), los_low: num(f.los_low), los_high: num(f.los_high), mdc: f.mdc.trim() || null, kind: f.kind, notes: f.notes.trim() || null } }),
    onSuccess: () => { onDone(); onClose(); },
  });
  const del = useMutation({ mutationFn: () => api(`/drg/versions/${v.id}/groups/${encodeURIComponent(g!.code)}`, { method: 'DELETE' }), onSuccess: () => { onDone(); onClose(); } });
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 } as const;
  return (
    <Modal title={g ? `ჯგუფი ${g.code}` : 'ახალი ჯგუფი'} onClose={onClose} width={720}
      footer={<>{edit && g && <button className="btn" type="button" disabled={del.isPending} onClick={() => del.mutate()}>წაშლა</button>}<span className="grow" />
        <button className="btn" type="button" onClick={onClose}>დახურვა</button>{edit && <button className="btn primary" type="button" disabled={!f.code || f.title.trim().length < 2 || !f.weight || save.isPending} onClick={() => save.mutate()}>შენახვა</button>}</>}>
      <div className="stack" style={{ gap: 10 }}>
        <div style={grid}>
          <Field label="კოდი" htmlFor="gd-c" required><input id="gd-c" className="input mono" disabled={!!g || !edit} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
          <div style={{ gridColumn: 'span 2' }}><Field label="დასახელება" htmlFor="gd-t" required><input id="gd-t" className="input" disabled={!edit} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field></div>
          <Field label="ფარდობითი წონა" htmlFor="gd-w" required><input id="gd-w" className="input mono" inputMode="decimal" disabled={!edit} value={f.weight} onChange={(e) => setF({ ...f, weight: e.target.value })} /></Field>
          <Field label="საშუალო ხანგრძლივობა (დღე)" htmlFor="gd-a"><input id="gd-a" className="input mono" inputMode="decimal" disabled={!edit} value={f.alos} onChange={(e) => setF({ ...f, alos: e.target.value })} /></Field>
          <Field label="ტიპი" htmlFor="gd-k"><select id="gd-k" className="select" disabled={!edit} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            {Object.entries(GKIND_KA).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          <Field label="ქვედა ზღვარი (დღე)" htmlFor="gd-lo"><input id="gd-lo" className="input mono" inputMode="numeric" disabled={!edit} value={f.los_low} onChange={(e) => setF({ ...f, los_low: e.target.value })} /></Field>
          <Field label="ზედა ზღვარი (დღე)" htmlFor="gd-hi"><input id="gd-hi" className="input mono" inputMode="numeric" disabled={!edit} value={f.los_high} onChange={(e) => setF({ ...f, los_high: e.target.value })} /></Field>
          <Field label="MDC" htmlFor="gd-m"><input id="gd-m" className="input mono" disabled={!edit} value={f.mdc} onChange={(e) => setF({ ...f, mdc: e.target.value })} /></Field>
        </div>
        <Field label="შენიშვნა" htmlFor="gd-n"><textarea id="gd-n" className="textarea" rows={2} disabled={!edit} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
        <ErrorBox error={save.error ?? del.error} />
      </div>
    </Modal>
  );
}

// ================================================================= სიები
export function ListsTab({ v, edit }: { v: VersionDetail; edit: boolean }) {
  const rows = useQuery({ queryKey: ['drg-lists', v.id], queryFn: () => api<CodeList[]>(`/drg/versions/${v.id}/lists`) });
  const [dlg, setDlg] = useState<null | 'csv' | 'new' | string>(null);
  const inval = useInval(v);
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="row" style={{ gap: 8 }}>
        <span className="hint grow">სია — კოდების დასახელებული ნაკრები, რომელსაც წესები იყენებენ (<span className="mono">@APPENDICITIS</span>). ჩანაწერი: კოდის დასაწყისი (<span className="mono">K35</span> ფარავს K35, K35.0, K35.8 …) ან დიაპაზონი (<span className="mono">K35-K37</span>); წერტილი არ ითვლება.</span>
        {edit && <><button className="btn sm" type="button" onClick={() => setDlg('csv')}>CSV იმპორტი</button><button className="btn sm primary" type="button" onClick={() => setDlg('new')}>+ სია</button></>}
      </div>
      <ErrorBox error={rows.error} />
      {rows.isLoading ? <Loading /> : <table className="table">
        <thead><tr><th>კოდი</th><th>დასახელება</th><th>სახეობა</th><th className="num">ჩანაწერი</th><th className="num">გამოიყენება</th></tr></thead>
        <tbody>{rows.data?.map((l) => <tr key={l.code} onClick={() => setDlg(l.code)} style={{ cursor: 'pointer' }}>
          <td className="mono"><strong>@{l.code}</strong></td><td>{l.title}</td><td className="small">{LKIND_KA[l.kind]}</td><td className="num">{l.n_items}</td>
          <td className="num">{l.n_used || <span className="chip warn" style={{ height: 18, fontSize: 11 }}>არა</span>}</td></tr>)}
          {rows.data?.length === 0 && <tr><td colSpan={5}><div className="empty">სია არ არის.</div></td></tr>}</tbody>
      </table>}
      {dlg === 'csv' && <CsvImport title="კოდების სიები — CSV იმპორტი" path={`/drg/versions/${v.id}/lists-import`} columns="list;kind;pattern[;title]   (kind: dx / proc / service)"
        example="APPENDICITIS;dx;K35-K37;აპენდიციტი" replaceLabel="ფაილში მოხსენიებული სიების შემადგენლობა = ფაილი (ძველი ჩანაწერები წაიშლება)" onClose={() => setDlg(null)} onDone={inval} />}
      {dlg && dlg !== 'csv' && <ListDialog v={v} code={dlg === 'new' ? null : dlg} edit={edit} onClose={() => setDlg(null)} onDone={inval} />}
    </div>
  );
}

function ListDialog({ v, code, edit, onClose, onDone }: { v: VersionDetail; code: string | null; edit: boolean; onClose: () => void; onDone: () => void }) {
  const q = useQuery({ queryKey: ['drg-list', v.id, code], enabled: !!code,
    queryFn: () => api<CodeList & { items: { pattern: string; title: string | null }[] }>(`/drg/versions/${v.id}/lists/${code}`) });
  const [f, setF] = useState<{ code: string; title: string; kind: string; notes: string; items: string } | null>(code ? null : { code: '', title: '', kind: 'dx', notes: '', items: '' });
  const cur = f ?? (q.data ? { code: q.data.code, title: q.data.title, kind: q.data.kind, notes: q.data.notes ?? '', items: q.data.items.map((i) => i.pattern).join('\n') } : null);
  const save = useMutation({
    mutationFn: () => api(`/drg/versions/${v.id}/lists/${encodeURIComponent(cur!.code.trim().toUpperCase())}`, { method: 'PUT', body: {
      title: cur!.title.trim(), kind: cur!.kind, notes: cur!.notes.trim() || null, items: cur!.items.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean) } }),
    onSuccess: () => { onDone(); onClose(); },
  });
  const del = useMutation({ mutationFn: () => api(`/drg/versions/${v.id}/lists/${code}`, { method: 'DELETE' }), onSuccess: () => { onDone(); onClose(); } });
  const set = (k: 'code' | 'title' | 'kind' | 'notes' | 'items', x: string) => setF({ ...cur!, [k]: x });
  return (
    <Modal title={code ? `სია @${code}` : 'ახალი სია'} onClose={onClose} width={760}
      footer={<>{edit && code && <button className="btn" type="button" disabled={del.isPending || (q.data?.n_used ?? 0) > 0} title={(q.data?.n_used ?? 0) > 0 ? 'სიას წესები / CC იყენებს' : undefined} onClick={() => del.mutate()}>წაშლა</button>}
        <span className="grow" /><button className="btn" type="button" onClick={onClose}>დახურვა</button>
        {edit && <button className="btn primary" type="button" disabled={!cur || cur.code.trim().length < 2 || cur.title.trim().length < 2 || save.isPending} onClick={() => save.mutate()}>შენახვა</button>}</>}>
      {!cur ? <Loading /> : <div className="stack" style={{ gap: 10 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '200px minmax(0, 1fr) 240px', gap: 10 }}>
          <Field label="კოდი" htmlFor="ld-c" required hint="ლათ. დიდი ასოები, _"><input id="ld-c" className="input mono" disabled={!!code || !edit} value={cur.code} onChange={(e) => set('code', e.target.value.toUpperCase())} /></Field>
          <Field label="დასახელება" htmlFor="ld-t" required><input id="ld-t" className="input" disabled={!edit} value={cur.title} onChange={(e) => set('title', e.target.value)} /></Field>
          <Field label="სახეობა" htmlFor="ld-k"><select id="ld-k" className="select" disabled={!edit} value={cur.kind} onChange={(e) => set('kind', e.target.value)}>
            {Object.entries(LKIND_KA).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        </div>
        <Field label="კოდები (თითო ხაზზე ან მძიმით)" htmlFor="ld-i" hint="K35 — დასაწყისი; K35-K37 — დიაპაზონი; K35.8 — კონკრეტული (და მისი ქვეკოდები)">
          <textarea id="ld-i" className="textarea mono" rows={8} disabled={!edit} value={cur.items} onChange={(e) => set('items', e.target.value)} /></Field>
        {code && q.data && q.data.items.some((i) => i.title) && <details className="small"><summary className="muted">დასახელებები</summary>
          <div style={{ maxHeight: 200, overflow: 'auto' }}>{q.data.items.map((i) => <div key={i.pattern}><span className="mono">{i.pattern}</span> {i.title ?? ''}</div>)}</div></details>}
        <Field label="შენიშვნა" htmlFor="ld-n"><input id="ld-n" className="input" disabled={!edit} value={cur.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
        <ErrorBox error={q.error ?? save.error ?? del.error} />
      </div>}
    </Modal>
  );
}

// ================================================================= CC / MCC
export function CcTab({ v, edit }: { v: VersionDetail; edit: boolean }) {
  const [q, setQ] = useState(''); const dq = useDebounced(q.trim(), 250);
  const rows = useQuery({ queryKey: ['drg-cc', v.id, dq], queryFn: () => api<CcRow[]>(`/drg/versions/${v.id}/cc`, { query: { q: dq } }) });
  const [dlg, setDlg] = useState<null | 'csv' | 'new' | CcRow>(null);
  const inval = useInval(v);
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <input className="input" style={{ maxWidth: 240 }} placeholder="კოდის დასაწყისი" aria-label="ძებნა" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="small muted grow">{rows.data?.length ?? '…'} ჩანაწერი</span>
        {edit && <><button className="btn sm" type="button" onClick={() => setDlg('csv')}>CSV იმპორტი</button><button className="btn sm primary" type="button" onClick={() => setDlg('new')}>+ ჩანაწერი</button></>}
      </div>
      <span className="hint">თანმხლები დიაგნოზის სიმძიმე: CC (გართულება / თანმხლები) ან MCC (მძიმე). შემთხვევის დონე = ყველაზე მაღალი ჩათვლილი. „გამონაკლისი“ — ამ ძირითადი დიაგნოზით CC არ ითვლება (კოდი / დიაპაზონი / @სია).</span>
      <ErrorBox error={rows.error} />
      {rows.isLoading ? <Loading /> : <table className="table">
        <thead><tr><th>კოდი</th><th>დონე</th><th>გამონაკლისი ძირითადი</th><th>შენიშვნა</th></tr></thead>
        <tbody>{rows.data?.map((c) => <tr key={c.pattern} onClick={() => setDlg(c)} style={{ cursor: 'pointer' }}>
          <td className="mono"><strong>{c.pattern}</strong></td><td><span className={`chip ${c.level === 'mcc' ? 'warn' : 'info'}`}>{c.level.toUpperCase()}</span></td>
          <td className="mono small">{c.excl_pdx.join(', ')}</td><td className="small muted">{c.notes}</td></tr>)}
          {rows.data?.length === 0 && <tr><td colSpan={4}><div className="empty">ჩანაწერი არ არის.</div></td></tr>}</tbody>
      </table>}
      {dlg === 'csv' && <CsvImport title="CC / MCC — CSV იმპორტი" path={`/drg/versions/${v.id}/cc-import`} columns="pattern;level[;excl_pdx]   (level: cc / mcc; excl_pdx — მძიმით)"
        example="J44;cc;@PNEUMONIA,J18" replaceLabel="ფაილში არმყოფი ჩანაწერების წაშლა" onClose={() => setDlg(null)} onDone={inval} />}
      {dlg && dlg !== 'csv' && <CcDialog v={v} c={dlg === 'new' ? null : dlg} edit={edit} onClose={() => setDlg(null)} onDone={inval} />}
    </div>
  );
}

function CcDialog({ v, c, edit, onClose, onDone }: { v: VersionDetail; c: CcRow | null; edit: boolean; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ pattern: c?.pattern ?? '', level: c?.level ?? 'cc', excl: (c?.excl_pdx ?? []).join(', '), notes: c?.notes ?? '' });
  const save = useMutation({ mutationFn: () => api(`/drg/versions/${v.id}/cc`, { method: 'PUT', body: { pattern: f.pattern, level: f.level, excl_pdx: f.excl.split(/[\s,;]+/).filter(Boolean), notes: f.notes.trim() || null } }),
    onSuccess: () => { onDone(); onClose(); } });
  const del = useMutation({ mutationFn: () => api(`/drg/versions/${v.id}/cc/${encodeURIComponent(c!.pattern)}`, { method: 'DELETE' }), onSuccess: () => { onDone(); onClose(); } });
  return (
    <Modal title={c ? `CC ${c.pattern}` : 'ახალი CC / MCC'} onClose={onClose} width={620}
      footer={<>{edit && c && <button className="btn" type="button" onClick={() => del.mutate()}>წაშლა</button>}<span className="grow" />
        <button className="btn" type="button" onClick={onClose}>დახურვა</button>{edit && <button className="btn primary" type="button" disabled={!f.pattern.trim() || save.isPending} onClick={() => save.mutate()}>შენახვა</button>}</>}>
      <div className="stack" style={{ gap: 10 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 160px', gap: 10 }}>
          <Field label="ICD-10 კოდი / დიაპაზონი" htmlFor="cc-p" required><input id="cc-p" className="input mono" disabled={!!c || !edit} value={f.pattern} onChange={(e) => setF({ ...f, pattern: e.target.value.toUpperCase() })} placeholder="N17 ან E10-E11" /></Field>
          <Field label="დონე" htmlFor="cc-l"><select id="cc-l" className="select" disabled={!edit} value={f.level} onChange={(e) => setF({ ...f, level: e.target.value as 'cc' | 'mcc' })}><option value="cc">CC</option><option value="mcc">MCC</option></select></Field>
        </div>
        <Field label="გამონაკლისი ძირითადი დიაგნოზები" htmlFor="cc-x" hint="კოდი, დიაპაზონი ან @სია — მძიმით"><input id="cc-x" className="input mono" disabled={!edit} value={f.excl} onChange={(e) => setF({ ...f, excl: e.target.value })} /></Field>
        <Field label="შენიშვნა" htmlFor="cc-n"><input id="cc-n" className="input" disabled={!edit} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
        <ErrorBox error={save.error ?? del.error} />
      </div>
    </Modal>
  );
}
