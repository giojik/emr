import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../../api/client';
import { ErrorBox, Field, Loading, Modal } from '../../../components/ui';
import { useCondEditor } from './DrgRules';
import { type Meta, type Price, type PriceComponent, type VersionDetail } from './types';

/**
 * თანხის ფორმულა (0056): საბაზისო = განაკვეთი × წონა × კოეფიციენტები, შემდეგ კომპონენტები რიგით.
 * კომპონენტი — სახეობა, პარამეტრები, პირობა (როგორც წესებში), ექსკლუზიური ჯგუფი (ჯგუფში მხოლოდ პირველი შესაბამისი).
 */
const useMeta = () => useQuery({ queryKey: ['drg-meta'], queryFn: () => api<Meta>('/drg/meta'), staleTime: Infinity });

export function FormulaTab({ v, edit }: { v: VersionDetail; edit: boolean }) {
  const qc = useQueryClient();
  const meta = useMeta();
  const rows = useQuery({ queryKey: ['drg-components', v.id], queryFn: () => api<PriceComponent[]>(`/drg/versions/${v.id}/components`) });
  const [dlg, setDlg] = useState<null | 'new' | PriceComponent>(null);
  const inval = () => { for (const k of ['drg-components', 'drg-version', 'drg-versions', 'drg-check']) void qc.invalidateQueries({ queryKey: [k] }); };
  const move = useMutation({
    mutationFn: (x: { i: number; d: -1 | 1 }) => { const ids = (rows.data ?? []).map((r) => r.id); const j = x.i + x.d; [ids[x.i], ids[j]] = [ids[j], ids[x.i]]; return api(`/drg/versions/${v.id}/components-reorder`, { body: { ids } }); },
    onSuccess: inval,
  });
  const toggle = useMutation({ mutationFn: (c: PriceComponent) => api(`/drg/components/${c.id}`, { method: 'PATCH', body: { is_active: !c.is_active } }), onSuccess: inval });
  const fmt = (c: PriceComponent) => (meta.data?.price_kinds[c.kind]?.params ?? []).filter((p) => c.params[p.key] !== undefined)
    .map((p) => `${p.label}: ${p.type === 'enum' ? p.values?.find((x) => x.v === c.params[p.key])?.label ?? String(c.params[p.key]) : String(c.params[p.key])}`).join(' · ');
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="row" style={{ gap: 8 }}>
        <span className="hint grow">თანხა = საბაზისო განაკვეთი (გადამხდელის წესიდან) × წონა × კოეფიციენტები, შემდეგ კომპონენტები ზემოდან ქვემოთ (± თანხა). ერთ „ექსკლუზიურ ჯგუფში“ მოქმედებს მხოლოდ პირველი შესაბამისი
          (მაგ. გადაყვანა / მოკლე / ხანგრძლივი — ჯგუფი „los“). დამრგვალება — პარამეტრებში. ფორმულის გარეშე: განაკვეთი × წონა.</span>
        {edit && <button className="btn sm primary" type="button" onClick={() => setDlg('new')}>+ კომპონენტი</button>}
      </div>
      <ErrorBox error={rows.error ?? move.error ?? toggle.error} />
      {rows.isLoading ? <Loading /> : <table className="table">
        <thead><tr><th className="num">#</th><th>კომპონენტი</th><th>პარამეტრები</th><th>პირობა</th><th>ჯგუფი</th><th />{edit && <th />}</tr></thead>
        <tbody>{rows.data?.map((c, i) => <tr key={c.id} style={c.is_active ? undefined : { opacity: 0.5 }}>
          <td className="num mono">{c.seq}</td>
          <td><strong>{c.label}</strong><div className="small muted">{c.kind_ka}</div></td>
          <td className="small">{fmt(c)}</td>
          <td className="mono small" style={{ maxWidth: 360 }}>{c.conditions_text || <span className="muted">—</span>}</td>
          <td className="mono small">{c.exclusive_group ?? ''}</td>
          <td className="num"><button className="btn sm" type="button" onClick={() => setDlg(c)}>{edit ? 'შეცვლა' : 'ნახვა'}</button></td>
          {edit && <td className="num" style={{ whiteSpace: 'nowrap' }}>
            <button className="btn sm" type="button" aria-label="ზემოთ" disabled={i === 0 || move.isPending} onClick={() => move.mutate({ i, d: -1 })}>↑</button>{' '}
            <button className="btn sm" type="button" aria-label="ქვემოთ" disabled={i === (rows.data?.length ?? 0) - 1 || move.isPending} onClick={() => move.mutate({ i, d: 1 })}>↓</button>{' '}
            <button className="btn sm" type="button" onClick={() => toggle.mutate(c)}>{c.is_active ? 'გათიშვა' : 'ჩართვა'}</button></td>}
        </tr>)}
          {rows.data?.length === 0 && <tr><td colSpan={7}><div className="empty">კომპონენტი არ არის — თანხა = განაკვეთი × წონა.</div></td></tr>}</tbody>
      </table>}
      {dlg && meta.data && <ComponentDialog v={v} c={dlg === 'new' ? null : dlg} meta={meta.data} edit={edit} onClose={() => setDlg(null)} onDone={inval} />}
    </div>
  );
}

function ComponentDialog({ v, c, meta, edit, onClose, onDone }: { v: VersionDetail; c: PriceComponent | null; meta: Meta; edit: boolean; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ kind: c?.kind ?? 'percent', label: c?.label ?? '', seq: c ? String(c.seq) : '', group: c?.exclusive_group ?? '', notes: c?.notes ?? '', is_active: c?.is_active ?? true });
  const [params, setParams] = useState<Record<string, string>>(Object.fromEntries(Object.entries(c?.params ?? {}).map(([k, x]) => [k, String(x)])));
  const ce = useCondEditor(v, c?.conditions ?? null, c?.conditions_text ?? '', edit);
  const K = meta.price_kinds[f.kind];
  const save = useMutation({
    mutationFn: () => {
      const pr: Record<string, unknown> = {};
      for (const p of K.params) { const x = (params[p.key] ?? '').trim(); if (x !== '') pr[p.key] = p.type === 'num' ? Number(x.replace(',', '.')) : x; }
      const body = { kind: f.kind, label: f.label.trim(), seq: f.seq ? Number(f.seq) : undefined, exclusive_group: f.group.trim() || null, notes: f.notes.trim() || null, is_active: f.is_active, params: pr, ...ce.value() };
      return c ? api(`/drg/components/${c.id}`, { method: 'PATCH', body }) : api(`/drg/versions/${v.id}/components`, { body });
    },
    onSuccess: () => { onDone(); onClose(); },
  });
  const del = useMutation({ mutationFn: () => api(`/drg/components/${c!.id}`, { method: 'DELETE' }), onSuccess: () => { onDone(); onClose(); } });
  return (
    <Modal title={c ? `კომპონენტი #${c.seq}` : 'ახალი კომპონენტი'} onClose={onClose} width={980}
      footer={<>{edit && c && <button className="btn" type="button" disabled={del.isPending} onClick={() => del.mutate()}>წაშლა</button>}<span className="grow" />
        <button className="btn" type="button" onClick={onClose}>დახურვა</button>
        {edit && <button className="btn primary" type="button" disabled={f.label.trim().length < 2 || save.isPending || !ce.ready} onClick={() => save.mutate()}>შენახვა</button>}</>}>
      <div className="stack" style={{ gap: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '240px minmax(0, 1fr) 110px 160px', gap: 10 }}>
          <Field label="სახეობა" htmlFor="pc-k"><select id="pc-k" className="select" disabled={!edit} value={f.kind} onChange={(e) => { setF({ ...f, kind: e.target.value }); setParams({}); }}>
            {Object.entries(meta.price_kinds).map(([k, x]) => <option key={k} value={k}>{x.label}</option>)}</select></Field>
          <Field label="დასახელება" htmlFor="pc-l" required><input id="pc-l" className="input" disabled={!edit} value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} /></Field>
          <Field label="რიგი" htmlFor="pc-s"><input id="pc-s" className="input mono" inputMode="numeric" disabled={!edit} value={f.seq} onChange={(e) => setF({ ...f, seq: e.target.value })} /></Field>
          <Field label="ექსკლუზიური ჯგუფი" htmlFor="pc-g" hint="მაგ. los"><input id="pc-g" className="input mono" disabled={!edit} value={f.group} onChange={(e) => setF({ ...f, group: e.target.value.toLowerCase() })} /></Field>
        </div>
        <span className="small muted">{K.hint}</span>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
          {K.params.map((p) => <Field key={p.key} label={p.label} htmlFor={`pc-p-${p.key}`} required={p.required} hint={p.hint}>
            {p.type === 'enum' ? <select id={`pc-p-${p.key}`} className="select" disabled={!edit} value={params[p.key] ?? ''} onChange={(e) => setParams({ ...params, [p.key]: e.target.value })}>
              <option value="">—</option>{p.values!.map((x) => <option key={x.v} value={x.v}>{x.label}</option>)}</select>
              : <input id={`pc-p-${p.key}`} className="input mono" inputMode="decimal" disabled={!edit} value={params[p.key] ?? ''} onChange={(e) => setParams({ ...params, [p.key]: e.target.value })} />}</Field>)}
        </div>
        {ce.node}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 160px', gap: 10 }}>
          <Field label="შენიშვნა" htmlFor="pc-n"><input id="pc-n" className="input" disabled={!edit} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
          <label className="row small" style={{ alignSelf: 'end' }}><input type="checkbox" disabled={!edit} checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> აქტიური</label>
        </div>
        <ErrorBox error={save.error ?? del.error} />
      </div>
    </Modal>
  );
}

/** თანხის დაშლა (ტესტი, DRG ბლოკი) */
export function PriceView({ p, compact }: { p: Price; compact?: boolean }) {
  const m = (n: number) => n.toLocaleString('ka-GE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (
    <div className="stack small" style={{ gap: 2 }}>
      <span>საბაზისო: <span className="mono">{m(p.base_rate)} × {p.weight}{p.factor !== 1 ? ` × ${p.factor}` : ''} = {m(p.base)}</span></span>
      {p.items.filter((i) => i.kind === 'coef').map((i, k) => <span key={`c${k}`} className="muted">კოეფ.: {i.label} ({i.note})</span>)}
      {p.items.filter((i) => i.kind !== 'coef').map((i, k) => <span key={k}>{i.amount > 0 ? '+' : '−'} {i.label}: <span className="mono">{m(Math.abs(i.amount))}</span>{i.note && !compact && <span className="muted"> ({i.note})</span>}</span>)}
      <strong>ჯამი: <span className="mono">{m(p.total)} ₾</span></strong>
    </div>
  );
}
