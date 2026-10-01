import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import { ErrorBox, Field, Loading, Modal } from '../../components/ui';
import { tsDate } from '../../lib/format';
import { COSTING_KA, KIND_KA, useStockRefs, type CategoryKind, type StockCategory, type StockSettings, type StockUnit } from './types';

/** კატეგორიები, ერთეულები, პარამეტრები (თვითღირებულების მეთოდი — კლინიკის არჩევანი) */
export default function Setup() {
  const refs = useStockRefs();
  const [cat, setCat] = useState<StockCategory | 'new' | null>(null);
  if (refs.isLoading) return <div className="content"><Loading /></div>;
  const r = refs.data;
  return (
    <div className="content">
      <ErrorBox error={refs.error} />
      {r && <SettingsCard s={r.settings} />}
      {r && (
        <section className="card">
          <div className="card-head row"><h2 className="grow">კატეგორიები</h2><button className="btn sm primary" type="button" onClick={() => setCat('new')}>+ კატეგორია</button></div>
          <table className="table">
            <thead><tr><th>კოდი</th><th>დასახელება</th><th>ტიპი</th><th>ნაგულისხმევი აღრიცხვა</th><th className="num">ვადის გაფრთხ.</th><th>პაციენტზე ხარჯი</th><th>სტატუსი</th></tr></thead>
            <tbody>{r.categories.map((c) => (
              <tr key={c.id} className="clickable" onClick={() => setCat(c)}>
                <td className="mono">{c.code}</td><td><strong>{c.name}</strong>{c.parent_id && <span className="small muted"> · {r.categories.find((p) => p.id === c.parent_id)?.name}</span>}</td>
                <td>{KIND_KA[c.kind]}</td>
                <td className="small">{[c.requires_lot && 'ლოტი', c.requires_expiry && 'ვადა', c.serial_tracked && 'სერიული'].filter(Boolean).join(', ') || '—'}</td>
                <td className="num">{c.expiry_warn_days !== null ? `${c.expiry_warn_days} დღე` : '—'}</td>
                <td className="small">{c.billing_mode === 'invoice' ? `ინვოისში${c.markup_pct !== null ? ` · +${Number(c.markup_pct)}%` : ''}` : 'მხოლოდ აღრიცხვა'}</td>
                <td>{c.is_active ? <span className="chip ok">აქტიური</span> : <span className="chip">გათიშული</span>}</td>
              </tr>))}</tbody>
          </table>
        </section>)}
      {r && <Units units={r.units} />}
      {cat && r && <CategoryDialog c={cat === 'new' ? null : cat} all={r.categories} onClose={() => setCat(null)} />}
    </div>
  );
}

function SettingsCard({ s }: { s: StockSettings }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ costing_method: s.costing_method, short_expiry_months: s.short_expiry_months, reason: '' });
  const m = useMutation({
    mutationFn: () => api('/stock/settings', { method: 'PUT', body: { costing_method: f.costing_method, short_expiry_months: f.short_expiry_months, reason: f.reason.trim() } }),
    onSuccess: () => { setF((p) => ({ ...p, reason: '' })); void qc.invalidateQueries({ queryKey: ['stock-refs'] }); },
  });
  const changed = f.costing_method !== s.costing_method || f.short_expiry_months !== s.short_expiry_months;
  return (
    <section className="card card-pad stack">
      <h2>პარამეტრები</h2>
      <div className="stack" style={{ gap: 6 }}>
        <span className="label">თვითღირებულების მეთოდი</span>
        <div className="seg" role="group" aria-label="თვითღირებულების მეთოდი" style={{ alignSelf: 'flex-start' }}>
          {(Object.keys(COSTING_KA) as StockSettings['costing_method'][]).map((k) => <button key={k} type="button" aria-pressed={f.costing_method === k} onClick={() => setF({ ...f, costing_method: k })}>{COSTING_KA[k]}</button>)}
        </div>
        <span className="hint">ჟურნალის ყოველ მოძრაობაზე ინახება ორივე ღირებულება (ლოტის ფასი და საშუალო შეწონილი) — პარამეტრი მხოლოდ ირჩევს, რომელი აისახოს რეპორტებში, ხარჯში და ინვოისში. ცვლილება ისტორიას არ არღვევს.</span>
      </div>
      <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ maxWidth: 260 }}><Field label="მოკლევადიანის ზღვარი მიღებისას (თვე)" htmlFor="sem" hint="ნარჩენი ვადა ნაკლებია → გაფრთხილება და მიზეზი">
          <input id="sem" className="input mono" type="number" min={0} max={60} value={f.short_expiry_months} onChange={(e) => setF({ ...f, short_expiry_months: Number(e.target.value) })} /></Field></div>
        {changed && <div className="grow" style={{ minWidth: 260 }}><Field label="ცვლილების მიზეზი" htmlFor="sr" required><input id="sr" className="input" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field></div>}
        {changed && <button className="btn primary" type="button" disabled={m.isPending || f.reason.trim().length < 3} onClick={() => m.mutate()}>შენახვა</button>}
      </div>
      <span className="small muted">ბოლო ცვლილება: {tsDate(s.updated_at)}</span>
      <ErrorBox error={m.error} />
    </section>
  );
}

function CategoryDialog({ c, all, onClose }: { c: StockCategory | null; all: StockCategory[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ code: c?.code ?? '', name: c?.name ?? '', kind: (c?.kind ?? 'medical_supply') as CategoryKind, parent_id: c?.parent_id ?? '',
    requires_lot: c?.requires_lot ?? true, requires_expiry: c?.requires_expiry ?? true, serial_tracked: c?.serial_tracked ?? false,
    expiry_warn_days: c?.expiry_warn_days?.toString() ?? '', billing_mode: c?.billing_mode ?? 'none', markup_pct: c?.markup_pct !== null && c?.markup_pct !== undefined ? String(Number(c.markup_pct)) : '',
    is_active: c?.is_active ?? true, sort_order: c?.sort_order ?? 100 });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));
  const m = useMutation({
    mutationFn: () => {
      const body = { name: f.name.trim(), kind: f.kind, parent_id: f.parent_id || null, requires_lot: f.requires_lot, requires_expiry: f.requires_lot && f.requires_expiry, serial_tracked: f.requires_lot && f.serial_tracked,
        expiry_warn_days: f.expiry_warn_days.trim() ? Number(f.expiry_warn_days) : null, billing_mode: f.billing_mode, markup_pct: f.markup_pct.trim() ? Number(f.markup_pct.replace(',', '.')) : null,
        sort_order: f.sort_order, ...(c ? { is_active: f.is_active } : { code: f.code.trim() }) };
      return c ? api(`/stock/categories/${c.id}`, { method: 'PATCH', body }) : api('/stock/categories', { body });
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['stock-refs'] }); onClose(); },
  });
  return (
    <Modal title={c ? c.name : 'ახალი კატეგორია'} onClose={onClose} width={680}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button>
        <button className="btn primary" type="submit" form="catf" disabled={m.isPending || f.name.trim().length < 2 || (!c && !/^[A-Z][A-Z0-9_]{1,29}$/.test(f.code))}>შენახვა</button></>}>
      <form id="catf" onSubmit={(e) => { e.preventDefault(); m.mutate(); }} style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
        <Field label="კოდი" htmlFor="cc" required hint="მაგ. SUTURE"><input id="cc" className="input mono" disabled={!!c} value={f.code} onChange={(e) => set('code', e.target.value.toUpperCase())} /></Field>
        <Field label="დასახელება" htmlFor="cn" required><input id="cn" className="input" value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
        <Field label="ტიპი" htmlFor="ck" required hint="მედიკამენტს ჯენერიკი სჭირდება">
          <select id="ck" className="select" value={f.kind} onChange={(e) => set('kind', e.target.value as CategoryKind)}>
            {(Object.keys(KIND_KA) as CategoryKind[]).map((k) => <option key={k} value={k}>{KIND_KA[k]}</option>)}
          </select></Field>
        <Field label="ზედა კატეგორია" htmlFor="cp">
          <select id="cp" className="select" value={f.parent_id} onChange={(e) => set('parent_id', e.target.value)}>
            <option value="">—</option>{all.filter((x) => x.id !== c?.id && !x.parent_id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select></Field>
        <div className="stack" style={{ gap: 6, gridColumn: '1 / -1' }}>
          <span className="label">ახალი საქონლის ნაგულისხმევი აღრიცხვა</span>
          <label className="row small"><input type="checkbox" checked={f.requires_lot} onChange={(e) => set('requires_lot', e.target.checked)} /> ლოტი / სერია</label>
          <label className="row small"><input type="checkbox" checked={f.requires_lot && f.requires_expiry} disabled={!f.requires_lot} onChange={(e) => set('requires_expiry', e.target.checked)} /> ვადა (FEFO)</label>
          <label className="row small"><input type="checkbox" checked={f.requires_lot && f.serial_tracked} disabled={!f.requires_lot} onChange={(e) => set('serial_tracked', e.target.checked)} /> სერიული ნომერი</label>
        </div>
        <Field label="ვადის გაფრთხილება (დღე)" htmlFor="cw"><input id="cw" className="input mono" inputMode="numeric" value={f.expiry_warn_days} onChange={(e) => set('expiry_warn_days', e.target.value)} /></Field>
        <Field label="რიგი" htmlFor="co"><input id="co" className="input mono" type="number" value={f.sort_order} onChange={(e) => set('sort_order', Number(e.target.value))} /></Field>
        <Field label="პაციენტზე ხარჯი" htmlFor="cb" hint="კლინიკის არჩევანი; საქონელზე შეიძლება გადაიფაროს">
          <select id="cb" className="select" value={f.billing_mode} onChange={(e) => set('billing_mode', e.target.value as 'none' | 'invoice')}>
            <option value="none">მხოლოდ აღრიცხვა</option><option value="invoice">ინვოისში — გასაყიდი ფასით</option>
          </select></Field>
        <Field label="ფასნამატი (%)" htmlFor="cm" hint="საქონელს ფიქსირებული ფასი თუ არ აქვს"><input id="cm" className="input mono" inputMode="decimal" disabled={f.billing_mode !== 'invoice'} value={f.markup_pct} onChange={(e) => set('markup_pct', e.target.value)} /></Field>
        {c && <label className="row"><input type="checkbox" checked={f.is_active} onChange={(e) => set('is_active', e.target.checked)} /> აქტიური</label>}
        <div style={{ gridColumn: '1 / -1' }}><ErrorBox error={m.error} /></div>
      </form>
    </Modal>
  );
}

function Units({ units }: { units: StockUnit[] }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ code: '', name: '' });
  const done = () => void qc.invalidateQueries({ queryKey: ['stock-refs'] });
  const add = useMutation({ mutationFn: () => api('/stock/units', { body: { code: f.code.trim(), name: f.name.trim() } }), onSuccess: () => { setF({ code: '', name: '' }); done(); } });
  const toggle = useMutation({ mutationFn: (u: StockUnit) => api(`/stock/units/${u.code}`, { method: 'PATCH', body: { is_active: !u.is_active } }), onSuccess: done });
  return (
    <section className="card card-pad stack">
      <h2>ერთეულები</h2>
      <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
        {units.map((u) => <button key={u.code} type="button" className={`chip${u.is_active ? '' : ' warn'}`} title={u.is_active ? 'დაჭერით — გათიშვა' : 'გათიშულია — დაჭერით ჩართვა'}
          onClick={() => { if (confirm(`${u.is_active ? 'გავთიშოთ' : 'ჩავრთოთ'} „${u.name}“?`)) toggle.mutate(u); }}>{u.name} <span className="mono muted">{u.code}</span></button>)}
      </div>
      <form className="row" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
        <input className="input mono" style={{ maxWidth: 160, height: 36 }} aria-label="კოდი" placeholder="კოდი (ლათ.)" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toLowerCase() })} />
        <input className="input" style={{ maxWidth: 240, height: 36 }} aria-label="დასახელება" placeholder="დასახელება" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <button className="btn sm" type="submit" disabled={!/^[a-z][a-z0-9_]{0,19}$/.test(f.code) || !f.name.trim() || add.isPending}>დამატება</button>
      </form>
      <ErrorBox error={add.error ?? toggle.error} />
    </section>
  );
}
