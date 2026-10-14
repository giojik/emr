import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../../api/client';
import { ErrorBox, Field, Loading, Modal } from '../../../components/ui';
import { CsvImport } from './DrgTables';
import { PriceView } from './DrgFormula';
import { type CodeList, type Cond, type FieldDef, type Group, type Meta, type Price, type Rule, type VersionDetail } from './types';

/** დაჯგუფების წესები (0055): რიგით, პირველი შესაბამისი → ჯგუფი; პირობები — კონსტრუქტორით ან ტექსტით. ტესტ-შემთხვევა. */
const useMeta = () => useQuery({ queryKey: ['drg-meta'], queryFn: () => api<Meta>('/drg/meta'), staleTime: Infinity });

export function RulesTab({ v, edit }: { v: VersionDetail; edit: boolean }) {
  const qc = useQueryClient();
  const rules = useQuery({ queryKey: ['drg-rules', v.id], queryFn: () => api<Rule[]>(`/drg/versions/${v.id}/rules`) });
  const [dlg, setDlg] = useState<null | 'csv' | 'new' | Rule>(null);
  const inval = () => { for (const k of ['drg-rules', 'drg-version', 'drg-versions', 'drg-check', 'drg-groups', 'drg-lists']) void qc.invalidateQueries({ queryKey: [k] }); };
  const move = useMutation({
    mutationFn: (x: { i: number; d: -1 | 1 }) => {
      const ids = (rules.data ?? []).map((r) => r.id); const j = x.i + x.d;
      [ids[x.i], ids[j]] = [ids[j], ids[x.i]];
      return api(`/drg/versions/${v.id}/rules-reorder`, { body: { ids } });
    },
    onSuccess: inval,
  });
  const toggle = useMutation({ mutationFn: (r: Rule) => api(`/drg/rules/${r.id}`, { method: 'PATCH', body: { is_active: !r.is_active } }), onSuccess: inval });
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="row" style={{ gap: 8 }}>
        <span className="hint grow">წესები მოწმდება რიგით (ზემოდან ქვემოთ); პირველი, რომლის <strong>ყველა</strong> პირობა სრულდება, იძლევა ჯგუფს. „ან“ — ცალკე წესით იმავე ჯგუფზე.
          სპეციფიკური (მაგ. „CC / MCC“) ზოგადზე მაღლა უნდა იყოს.</span>
        {edit && <><button className="btn sm" type="button" onClick={() => setDlg('csv')}>CSV იმპორტი</button><button className="btn sm primary" type="button" onClick={() => setDlg('new')}>+ წესი</button></>}
      </div>
      <ErrorBox error={rules.error ?? move.error ?? toggle.error} />
      {rules.isLoading ? <Loading /> : <table className="table">
        <thead><tr><th className="num">#</th><th>ჯგუფი</th><th>პირობები</th><th>აღწერა</th><th />{edit && <th />}</tr></thead>
        <tbody>{rules.data?.map((r, i) => <tr key={r.id} style={r.is_active ? undefined : { opacity: 0.5 }}>
          <td className="num mono">{r.seq}</td>
          <td><strong className="mono">{r.drg_code}</strong><div className="small muted">{r.drg_title}{r.drg_weight && ` · ${Number(r.drg_weight)}`}</div></td>
          <td className="mono small" style={{ maxWidth: 520 }}>{r.conditions_text || <span className="muted">(პირობების გარეშე — ყველა შემთხვევა)</span>}</td>
          <td className="small">{r.label}</td>
          <td className="num" style={{ whiteSpace: 'nowrap' }}><button className="btn sm" type="button" onClick={() => setDlg(r)}>{edit ? 'შეცვლა' : 'ნახვა'}</button></td>
          {edit && <td className="num" style={{ whiteSpace: 'nowrap' }}>
            <button className="btn sm" type="button" aria-label="ზემოთ" disabled={i === 0 || move.isPending} onClick={() => move.mutate({ i, d: -1 })}>↑</button>{' '}
            <button className="btn sm" type="button" aria-label="ქვემოთ" disabled={i === (rules.data?.length ?? 0) - 1 || move.isPending} onClick={() => move.mutate({ i, d: 1 })}>↓</button>{' '}
            <button className="btn sm" type="button" onClick={() => toggle.mutate(r)}>{r.is_active ? 'გათიშვა' : 'ჩართვა'}</button></td>}
        </tr>)}
          {rules.data?.length === 0 && <tr><td colSpan={6}><div className="empty">წესი არ არის.</div></td></tr>}</tbody>
      </table>}
      {dlg === 'csv' && <CsvImport title="წესები — CSV იმპორტი" path={`/drg/versions/${v.id}/rules-import`} columns="seq;drg_code;conditions[;label[;active]]"
        example="20;G01A;pdx in @APPENDICITIS & proc any @APPENDECTOMY & cc >= cc;აპენდექტომია CC" replaceLabel="ვერსიის ყველა წესის ჩანაცვლება ფაილით" onClose={() => setDlg(null)} onDone={inval} />}
      {dlg && dlg !== 'csv' && <RuleDialog v={v} r={dlg === 'new' ? null : dlg} edit={edit} onClose={() => setDlg(null)} onDone={inval} />}
    </div>
  );
}

// ---------------------------------------------------------------- პირობის კონსტრუქტორი
interface Row { f: string; op: string; text: string; a: string; b: string; vals: string[] }
const toRow = (c: Cond, fd: FieldDef | undefined): Row => {
  const r: Row = { f: c.f, op: c.op, text: '', a: '', b: '', vals: [] };
  if (!fd) return r;
  if (fd.type === 'codes') r.text = (c.v as string[]).join(', ');
  else if (fd.type === 'num') { if (Array.isArray(c.v)) { r.a = String(c.v[0]); r.b = String(c.v[1]); } else r.a = String(c.v); }
  else if (fd.type === 'enum') r.vals = Array.isArray(c.v) ? (c.v as string[]) : [String(c.v)];
  else if (fd.type === 'level') r.vals = [String(c.v)];
  else if (fd.type === 'bool') r.vals = [c.v ? 'yes' : 'no'];
  return r;
};
const fromRow = (r: Row, fd: FieldDef): Cond => {
  if (fd.type === 'codes') return { f: r.f, op: r.op, v: r.text.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean) };
  if (fd.type === 'num') return { f: r.f, op: r.op, v: r.op === 'between' ? [Number(r.a.replace(',', '.')), Number(r.b.replace(',', '.'))] : Number(r.a.replace(',', '.')) };
  if (fd.type === 'enum') return { f: r.f, op: r.op, v: r.op === 'eq' ? r.vals[0] : r.vals };
  if (fd.type === 'level') return { f: r.f, op: r.op, v: r.vals[0] ?? 'none' };
  return { f: r.f, op: r.op, v: r.vals[0] === 'yes' };
};
const blank = (f: string, fd: FieldDef): Row => ({ f, op: fd.ops[0], text: '', a: '', b: '', vals: fd.type === 'level' ? ['cc'] : fd.type === 'bool' ? ['yes'] : fd.values ? [fd.values[0].v] : [] });

/** პირობების რედაქტორი (კონსტრუქტორი / ტექსტი) — წესებში და ფორმულის კომპონენტებში */
export function useCondEditor(v: VersionDetail, initial: Cond[] | null, initialText: string, edit: boolean) {
  const meta = useMeta();
  const lists = useQuery({ queryKey: ['drg-lists', v.id], queryFn: () => api<CodeList[]>(`/drg/versions/${v.id}/lists`) });
  const [mode, setMode] = useState<'builder' | 'text'>('builder');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [text, setText] = useState(initialText);
  const F = meta.data?.fields;
  const cur = rows ?? (F && initial ? initial.map((c) => toRow(c, F[c.f])) : F ? [] : null);
  const setRow = (i: number, p: Partial<Row>) => setRows((cur ?? []).map((x, j) => (j === i ? { ...x, ...p } : x)));
  const value = (): { conditions: Cond[] } | { conditions_text: string } => (mode === 'text' ? { conditions_text: text } : { conditions: (cur ?? []).map((x) => fromRow(x, F![x.f])) });
  const node = !F || !cur ? <Loading /> : (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 8 }}>
        <strong className="grow">პირობები (ყველა უნდა სრულდებოდეს)</strong>
        <div className="seg" role="tablist" aria-label="რედაქტორი">
          <button type="button" role="tab" aria-pressed={mode === 'builder'} onClick={() => setMode('builder')}>კონსტრუქტორი</button>
          <button type="button" role="tab" aria-pressed={mode === 'text'} onClick={() => { setText(cur.map((x) => condPreview(fromRow(x, F[x.f]), F[x.f])).join(' & ') || text); setMode('text'); }}>ტექსტი</button>
        </div>
      </div>
      {mode === 'builder' ? <div className="stack" style={{ gap: 6 }}>
        {cur.length === 0 && <span className="small muted">პირობა არ არის — ყველა შემთხვევაზე მოქმედებს.</span>}
        {cur.map((x, i) => { const fd = F[x.f]; return (
          <div key={i} className="row" style={{ gap: 6, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <select className="select" style={{ width: 220 }} aria-label="ველი" disabled={!edit} value={x.f} onChange={(e) => setRow(i, blank(e.target.value, F[e.target.value]))}>
              {Object.entries(F).map(([k, d]) => <option key={k} value={k}>{d.label}</option>)}</select>
            <select className="select" style={{ width: 150 }} aria-label="ოპერატორი" disabled={!edit} value={x.op} onChange={(e) => setRow(i, { op: e.target.value })}>
              {fd.ops.map((o) => <option key={o} value={o}>{meta.data!.ops[o]}</option>)}</select>
            <div className="grow" style={{ minWidth: 260 }}><ValueInput fd={fd} x={x} lists={lists.data ?? []} edit={edit} set={(p) => setRow(i, p)} /></div>
            {edit && <button className="btn sm" type="button" aria-label="პირობის წაშლა" onClick={() => setRows(cur.filter((_, j) => j !== i))}>✕</button>}
          </div>); })}
        {edit && <div><button className="btn sm" type="button" onClick={() => setRows([...cur, blank('pdx', F.pdx)])}>+ პირობა</button></div>}
      </div> : <div className="stack" style={{ gap: 6 }}>
        <textarea className="textarea mono" rows={4} disabled={!edit} value={text} onChange={(e) => setText(e.target.value)} aria-label="პირობები ტექსტით" />
        <span className="small muted">ფორმატი: <span className="mono">ველი ოპერატორი მნიშვნელობა</span>, პირობებს შორის <span className="mono">&amp;</span>. მაგ.: {meta.data!.examples.map((e) => <span key={e} className="mono" style={{ marginRight: 10 }}>{e}</span>)}</span>
        <span className="small muted">ველები: {Object.entries(F).map(([k, d]) => `${k} (${d.label})`).join(', ')}</span>
      </div>}
    </div>);
  return { node, value, ready: !!F && !!cur };
}

function RuleDialog({ v, r, edit, onClose, onDone }: { v: VersionDetail; r: Rule | null; edit: boolean; onClose: () => void; onDone: () => void }) {
  const groups = useQuery({ queryKey: ['drg-groups', v.id, ''], queryFn: () => api<{ total: number; rows: Group[] }>(`/drg/versions/${v.id}/groups`, { query: { limit: 5000 } }) });
  const [f, setF] = useState({ seq: r ? String(r.seq) : '', drg_code: r?.drg_code ?? '', label: r?.label ?? '', notes: r?.notes ?? '', is_active: r?.is_active ?? true });
  const ce = useCondEditor(v, r?.conditions ?? null, r?.conditions_text ?? '', edit);
  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { seq: f.seq ? Number(f.seq) : undefined, drg_code: f.drg_code, label: f.label.trim() || null, notes: f.notes.trim() || null, is_active: f.is_active, ...ce.value() };
      return r ? api(`/drg/rules/${r.id}`, { method: 'PATCH', body }) : api(`/drg/versions/${v.id}/rules`, { body });
    },
    onSuccess: () => { onDone(); onClose(); },
  });
  const del = useMutation({ mutationFn: () => api(`/drg/rules/${r!.id}`, { method: 'DELETE' }), onSuccess: () => { onDone(); onClose(); } });
  if (!ce.ready) return <Modal title="წესი" onClose={onClose}><Loading /></Modal>;
  return (
    <Modal title={r ? `წესი #${r.seq}` : 'ახალი წესი'} onClose={onClose} width={980}
      footer={<>{edit && r && <button className="btn" type="button" disabled={del.isPending} onClick={() => del.mutate()}>წაშლა</button>}<span className="grow" />
        <button className="btn" type="button" onClick={onClose}>დახურვა</button>{edit && <button className="btn primary" type="button" disabled={!f.drg_code || save.isPending} onClick={() => save.mutate()}>შენახვა</button>}</>}>
      <div className="stack" style={{ gap: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '110px minmax(0, 1fr) minmax(0, 1fr)', gap: 10 }}>
          <Field label="რიგი (seq)" htmlFor="rd-s" hint="ცარიელი — ბოლოში"><input id="rd-s" className="input mono" inputMode="numeric" disabled={!edit} value={f.seq} onChange={(e) => setF({ ...f, seq: e.target.value })} /></Field>
          <Field label="ჯგუფი" htmlFor="rd-g" required><select id="rd-g" className="select" disabled={!edit} value={f.drg_code} onChange={(e) => setF({ ...f, drg_code: e.target.value })}>
            <option value="">—</option>{groups.data?.rows.map((g) => <option key={g.code} value={g.code}>{g.code} — {g.title} ({Number(g.weight)})</option>)}</select></Field>
          <Field label="აღწერა" htmlFor="rd-l"><input id="rd-l" className="input" disabled={!edit} value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} /></Field>
        </div>
        {ce.node}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 160px', gap: 10 }}>
          <Field label="შენიშვნა" htmlFor="rd-n"><input id="rd-n" className="input" disabled={!edit} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
          <label className="row small" style={{ alignSelf: 'end' }}><input type="checkbox" disabled={!edit} checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> აქტიური</label>
        </div>
        <ErrorBox error={save.error ?? del.error} />
      </div>
    </Modal>
  );
}

function condPreview(c: Cond, fd: FieldDef) {
  const sym: Record<string, string> = { eq: '=', ne: '!=', gte: '>=', lte: '<=', gt: '>', lt: '<' };
  if (c.op === 'between') return `${c.f} between ${(c.v as number[])[0]}..${(c.v as number[])[1]}`;
  if (fd.type === 'bool') return `${c.f} is ${c.v ? 'yes' : 'no'}`;
  return `${c.f} ${sym[c.op] ?? c.op} ${Array.isArray(c.v) ? (c.v as string[]).join(',') : String(c.v)}`;
}

function ValueInput({ fd, x, lists, edit, set }: { fd: FieldDef; x: Row; lists: CodeList[]; edit: boolean; set: (p: Partial<Row>) => void }) {
  if (fd.type === 'codes') {
    const mine = lists.filter((l) => l.kind === fd.list);
    return <div className="stack" style={{ gap: 4 }}>
      <input className="input mono" disabled={!edit} aria-label="კოდები" value={x.text} onChange={(e) => set({ text: e.target.value })} placeholder={`@სია ან კოდები: ${fd.list === 'dx' ? 'K35, K35-K37' : fd.list === 'proc' ? 'JEA00, JEA' : 'SRV01'}`} />
      {edit && mine.length > 0 && <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>{mine.map((l) => <button key={l.code} type="button" className="chip" style={{ cursor: 'pointer', border: 0 }}
        title={l.title} onClick={() => set({ text: [...x.text.split(/[\s,;]+/).filter(Boolean), `@${l.code}`].filter((y, i, a) => a.indexOf(y) === i).join(', ') })}>@{l.code}</button>)}</div>}
    </div>;
  }
  if (fd.type === 'num') return <div className="row" style={{ gap: 6 }}>
    <input className="input mono" style={{ width: 120 }} inputMode="decimal" aria-label="მნიშვნელობა" disabled={!edit} value={x.a} onChange={(e) => set({ a: e.target.value })} />
    {x.op === 'between' && <><span>–</span><input className="input mono" style={{ width: 120 }} inputMode="decimal" aria-label="მდე" disabled={!edit} value={x.b} onChange={(e) => set({ b: e.target.value })} /></>}
    {fd.unit && <span className="small muted">{fd.unit}</span>}</div>;
  if (fd.type === 'bool') return <select className="select" style={{ width: 120 }} aria-label="მნიშვნელობა" disabled={!edit} value={x.vals[0] ?? 'yes'} onChange={(e) => set({ vals: [e.target.value] })}>
    <option value="yes">კი</option><option value="no">არა</option></select>;
  if (fd.type === 'level' || (fd.type === 'enum' && x.op === 'eq')) return <select className="select" style={{ width: 200 }} aria-label="მნიშვნელობა" disabled={!edit} value={x.vals[0] ?? ''} onChange={(e) => set({ vals: [e.target.value] })}>
    {fd.values?.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}</select>;
  return <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>{fd.values?.map((o) => <label key={o.v} className="row small"><input type="checkbox" disabled={!edit} checked={x.vals.includes(o.v)}
    onChange={(e) => set({ vals: e.target.checked ? [...x.vals, o.v] : x.vals.filter((y) => y !== o.v) })} /> {o.label}</label>)}</div>;
}

// ---------------------------------------------------------------- ტესტი
interface TestResult {
  inputs: Record<string, unknown>;
  result: { code: string | null; title: string | null; weight: number | null; rule_seq: number | null; rule_label: string | null; fallback: boolean; cc_level: string; issues: { code: string; message: string }[];
    trace: { cc: { code: string; level: string; counted: boolean; why?: string }[]; matched?: { seq: number; label: string | null; conds: { text: string; why: string }[] };
      skipped: { seq: number; drg_code: string; label: string | null; failed: string; why: string }[]; skipped_total: number } };
  pricing: Price | null;
}
export function TestTab({ v }: { v: VersionDetail; edit: boolean }) {
  const [f, setF] = useState({ pdx: '', sdx: '', procs: '', services: '', age: '', sex: '', los: '3', icu_hours: '0', vent_hours: '0', discharge: 'home', source: 'emergency',
    dept: '', base_rate: '', drg_code: '', charges: '' });
  const list = (s: string) => s.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
  const num = (s: string) => (s.trim() === '' ? undefined : Number(s.replace(',', '.')));
  const m = useMutation({ mutationFn: () => api<TestResult>(`/drg/versions/${v.id}/test`, { body: {
    pdx: f.pdx || null, sdx: list(f.sdx), procs: list(f.procs), services: list(f.services), age: num(f.age) ?? null, sex: f.sex || null, los: num(f.los) ?? 1,
    icu_hours: num(f.icu_hours) ?? 0, vent_hours: num(f.vent_hours) ?? 0, discharge: f.discharge || null, source: f.source || null,
    dept: f.dept || null, base_rate: num(f.base_rate) ?? null, drg_code: f.drg_code.trim() || null, charges: num(f.charges) ?? null } }) });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const r = m.data?.result;
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 } as const;
  return (
    <div className="stack" style={{ gap: 12 }}>
      <span className="hint">შეიყვანეთ შემთხვევის მონაცემები და ნახეთ, რომელ ჯგუფში მოხვდება ამ ვერსიით და რატომ — მონახაზის შემოწმება გააქტიურებამდე.</span>
      <form style={grid} onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <Field label="ძირითადი დიაგნოზი" htmlFor="t-p"><input id="t-p" className="input mono" value={f.pdx} onChange={set('pdx')} placeholder="K35.8" /></Field>
        <div style={{ gridColumn: 'span 3' }}><Field label="თანმხლები დიაგნოზები" htmlFor="t-s"><input id="t-s" className="input mono" value={f.sdx} onChange={set('sdx')} placeholder="E11.9, N18.3" /></Field></div>
        <div style={{ gridColumn: 'span 2' }}><Field label="პროცედურები (კოდები)" htmlFor="t-pr"><input id="t-pr" className="input mono" value={f.procs} onChange={set('procs')} placeholder="JEA01" /></Field></div>
        <div style={{ gridColumn: 'span 2' }}><Field label="მომსახურების კოდები" htmlFor="t-sv"><input id="t-sv" className="input mono" value={f.services} onChange={set('services')} /></Field></div>
        <Field label="ასაკი (წელი)" htmlFor="t-a"><input id="t-a" className="input mono" inputMode="decimal" value={f.age} onChange={set('age')} /></Field>
        <Field label="სქესი" htmlFor="t-x"><select id="t-x" className="select" value={f.sex} onChange={set('sex')}><option value="">—</option><option value="M">მამრ.</option><option value="F">მდედრ.</option></select></Field>
        <Field label="დღეები" htmlFor="t-l"><input id="t-l" className="input mono" inputMode="numeric" value={f.los} onChange={set('los')} /></Field>
        <Field label="ICU / ვენტილაცია (სთ)" htmlFor="t-i"><div className="row" style={{ gap: 6 }}><input id="t-i" className="input mono" inputMode="decimal" value={f.icu_hours} onChange={set('icu_hours')} aria-label="ICU საათი" />
          <input className="input mono" inputMode="decimal" value={f.vent_hours} onChange={set('vent_hours')} aria-label="ვენტილაციის საათი" /></div></Field>
        <Field label="გაწერა" htmlFor="t-d"><select id="t-d" className="select" value={f.discharge} onChange={set('discharge')}>
          <option value="home">სახლში</option><option value="other_clinic">სხვა კლინიკაში</option><option value="against_advice">თვითნებურად</option><option value="death">გარდაცვალება</option></select></Field>
        <Field label="მიღების წყარო" htmlFor="t-so"><select id="t-so" className="select" value={f.source} onChange={set('source')}>
          <option value="emergency">გადაუდებელი</option><option value="planned">გეგმიური</option><option value="outpatient">ამბულატორიიდან</option><option value="transfer_in">სხვა კლინიკიდან</option><option value="direct">პირდაპირ</option></select></Field>
        <Field label="განყოფილების კოდი" htmlFor="t-dp"><input id="t-dp" className="input mono" value={f.dept} onChange={set('dept')} /></Field>
        <Field label="საბაზისო განაკვეთი (თანხისთვის)" htmlFor="t-br" hint="ცარიელი — მხოლოდ ჯგუფი"><input id="t-br" className="input mono" inputMode="decimal" value={f.base_rate} onChange={set('base_rate')} /></Field>
        <Field label="ჯგუფი (თანხისთვის)" htmlFor="t-gc" hint="ცარიელი — შედეგი"><input id="t-gc" className="input mono" value={f.drg_code} onChange={set('drg_code')} /></Field>
        <Field label="ფაქტობრივი ხარჯი" htmlFor="t-ch" hint="ძვირი შემთხვევისთვის"><input id="t-ch" className="input mono" inputMode="decimal" value={f.charges} onChange={set('charges')} /></Field>
        <div style={{ alignSelf: 'end' }}><button className="btn primary" type="submit" disabled={m.isPending}>დაჯგუფება</button></div>
      </form>
      <ErrorBox error={m.error} />
      {r && <section className="card-pad stack" style={{ gap: 6, border: '1px solid var(--line)', borderRadius: 10 }}>
        <div>{r.code ? <><strong className="mono" style={{ fontSize: 20 }}>{r.code}</strong> {r.title} <span className="muted">· წონა {r.weight}</span>{r.fallback && <span className="chip warn" style={{ marginLeft: 6 }}>ნაგულისხმევი</span>}</>
          : <strong>ვერ დაჯგუფდა</strong>}</div>
        {r.issues.map((i) => <span key={i.code} className="small">⚠ {i.message}</span>)}
        <span className="small">სიმძიმე: <strong>{r.cc_level.toUpperCase()}</strong>{r.trace.cc.length > 0 && <span className="muted"> — {r.trace.cc.map((c) => `${c.code} ${c.level.toUpperCase()}${c.counted ? '' : ` (არ ითვლება: ${c.why})`}`).join('; ')}</span>}</span>
        {r.trace.matched && <div className="small stack" style={{ gap: 2 }}><span className="muted">წესი #{r.trace.matched.seq}{r.trace.matched.label && ` — ${r.trace.matched.label}`}</span>
          {r.trace.matched.conds.map((c, i) => <span key={i}>✓ <span className="mono">{c.text}</span> <span className="muted">({c.why})</span></span>)}</div>}
        {r.trace.skipped.length > 0 && <details className="small"><summary className="muted">გამოტოვებული წესები ({r.trace.skipped_total})</summary>
          {r.trace.skipped.map((x) => <div key={x.seq}>#{x.seq} <span className="mono">{x.drg_code}</span> — ✗ <span className="mono">{x.failed}</span> <span className="muted">({x.why})</span></div>)}</details>}
        {m.data?.pricing && <div style={{ borderTop: '1px solid var(--line)', paddingTop: 8, marginTop: 4 }}><PriceView p={m.data.pricing} /></div>}
      </section>}
    </div>
  );
}
