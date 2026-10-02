import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, can } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Field, Loading, Modal, useDebounced } from '../../components/ui';
import { dateGe } from '../../lib/format';
import { GenericPicker } from './Generics';
import { CATALOG_EDIT } from './Stock';
import { CONTROLLED_KA, type LabMethod, nul, qtyFmt, STORAGE_KA, useStockRefs, type CategoryKind, type StockItem, type StorageKind } from './types';

const PHARM_KINDS: CategoryKind[] = ['medication', 'medical_supply', 'implant'];

interface ScanResult {
  parsed: { format: 'gs1' | 'gtin' | 'other'; gtin: string | null; lot: string | null; serial: string | null; expiry: string | null; normalized: string };
  item: StockItem | null; pack: { id: string; name: string; qty_base: string } | null; warnings: string[];
}

/** საქონელი (SKU): სავაჭრო დასახელება, შეფუთვები, შტრიხკოდები; მედიკამენტი — ჯენერიკზე მიბმით */
export default function Items() {
  const { user } = useAuth(); const refs = useStockRefs();
  const [search, setSearch] = useState(''); const [cat, setCat] = useState(''); const [all, setAll] = useState(false);
  const ds = useDebounced(search.trim(), 250);
  const q = useQuery({ queryKey: ['stock-items', ds, cat, all], queryFn: () => api<StockItem[]>('/stock/items', { query: { search: ds, category_id: cat, all } }) });
  const [edit, setEdit] = useState<StockItem | 'new' | null>(null);
  return (
    <div className="content">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <input className="input" style={{ maxWidth: 360, height: 38 }} aria-label="ძებნა" placeholder="დასახელება, INN, კოდი, ATC, შტრიხკოდი" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className="select" style={{ maxWidth: 240, height: 38 }} aria-label="კატეგორია" value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="">ყველა კატეგორია</option>{refs.data?.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <label className="row small"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> გათიშულიც</label>
        <span className="grow" />
        {can(user, ...CATALOG_EDIT) && <button className="btn primary" type="button" onClick={() => setEdit('new')}>+ საქონელი</button>}
      </div>
      <ScanBox onOpen={(it) => setEdit(it)} />
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : (
        <div className="card">
          <table className="table">
            <thead><tr><th>კოდი</th><th>დასახელება</th><th>კატეგორია</th><th>ერთეული / შეფუთვა</th><th>შენახვა</th><th>აღრიცხვა</th><th>სტატუსი</th></tr></thead>
            <tbody>{q.data?.map((i) => (
              <tr key={i.id} className="clickable" onClick={() => setEdit(i)}>
                <td className="mono small">{i.code}</td>
                <td><strong>{i.name}</strong>{i.manufacturer && <span className="small muted"> · {i.manufacturer}</span>}
                  {i.inn && <div className="small muted">{i.inn}{i.strength ? ` ${i.strength}` : ''} — {i.form_name}{i.atc_code ? ` · ${i.atc_code}` : ''}</div>}</td>
                <td>{i.category_name}</td>
                <td>{i.base_unit_name}{i.packs.length > 0 && <div className="small muted">{i.packs.map((p) => `${p.name} = ${qtyFmt(p.qty_base)}`).join(', ')}</div>}</td>
                <td className="small">{STORAGE_KA[i.storage]}</td>
                <td><div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
                  {i.requires_lot && <span className="chip" style={{ height: 20, fontSize: 11 }}>ლოტი</span>}
                  {i.requires_expiry && <span className="chip" style={{ height: 20, fontSize: 11 }}>ვადა</span>}
                  {i.serial_tracked && <span className="chip info" style={{ height: 20, fontSize: 11 }}>სერიული</span>}
                  {i.controlled_class && <span className="chip danger" style={{ height: 20, fontSize: 11 }}>{CONTROLLED_KA[i.controlled_class]}</span>}
                  {i.barcodes.length > 0 && <span className="chip" style={{ height: 20, fontSize: 11 }} title={i.barcodes.map((b) => b.barcode).join(', ')}>▥ {i.barcodes.length}</span>}
                </div></td>
                <td>{i.is_active ? <span className="chip ok">აქტიური</span> : <span className="chip">გათიშული</span>}</td>
              </tr>))}
              {!q.data?.length && <tr><td colSpan={7} className="muted">საქონელი არ მოიძებნა</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {edit && <ItemDialog it={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

/** სკანერის ველი: GS1 DataMatrix / EAN — საქონელი, ლოტი, ვადა, სერიული */
function ScanBox({ onOpen }: { onOpen: (it: StockItem) => void }) {
  const [code, setCode] = useState('');
  const m = useMutation({ mutationFn: (c: string) => api<ScanResult>('/stock/scan', { body: { code: c } }) });
  const r = m.data;
  return (
    <div className="card card-pad stack" style={{ gap: 6 }}>
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (code.trim()) m.mutate(code); setCode(''); }}>
        <label htmlFor="scan" className="label" style={{ whiteSpace: 'nowrap' }}>სკანირება</label>
        <input id="scan" className="input mono" style={{ height: 36 }} autoComplete="off" placeholder="დაასკანერეთ შტრიხკოდი / DataMatrix და Enter" value={code} onChange={(e) => setCode(e.target.value)} />
      </form>
      <ErrorBox error={m.error} />
      {r && (
        <div className="row small" style={{ flexWrap: 'wrap', gap: 10 }}>
          {r.item ? <button className="btn sm" type="button" onClick={() => onOpen(r.item!)}>{r.item.name}{r.pack ? ` — ${r.pack.name} (${qtyFmt(r.pack.qty_base)})` : ''}</button> : <span className="chip warn">კატალოგში ვერ მოიძებნა</span>}
          <span className="mono">{r.parsed.gtin ? `GTIN ${r.parsed.gtin}` : r.parsed.normalized}</span>
          {r.parsed.lot && <span>ლოტი <strong className="mono">{r.parsed.lot}</strong></span>}
          {r.parsed.expiry && <span>ვადა <strong className="mono">{dateGe(r.parsed.expiry)}</strong></span>}
          {r.parsed.serial && <span>სერიული <strong className="mono">{r.parsed.serial}</strong></span>}
          {r.warnings.map((w) => <span key={w} className="chip warn">{w}</span>)}
        </div>)}
    </div>
  );
}

interface PackRow { id?: string; name: string; qty_base: string; is_receipt_default: boolean }

function ItemDialog({ it, onClose }: { it: StockItem | null; onClose: () => void }) {
  const { user } = useAuth(); const refs = useStockRefs(); const qc = useQueryClient();
  const isMgr = can(user, 'admin', 'stock_manager');
  const [cur, setCur] = useState<StockItem | null>(it);
  const [f, setF] = useState({
    name: it?.name ?? '', code: it?.code ?? '', category_id: it?.category_id ?? '', manufacturer: it?.manufacturer ?? '', country: it?.country ?? '',
    base_unit: it?.base_unit ?? '', storage: (it?.storage ?? 'room') as StorageKind, requires_lot: it?.requires_lot ?? true, requires_expiry: it?.requires_expiry ?? true,
    serial_tracked: it?.serial_tracked ?? false, expiry_warn_days: it?.expiry_warn_days?.toString() ?? '', billing_mode: (it?.billing_mode ?? '') as '' | 'none' | 'invoice',
    sale_price: it?.sale_price ? String(Number(it.sale_price)) : '', notes: it?.notes ?? '', is_active: it?.is_active ?? true,
    lab_tests_per_unit: it?.lab_tests_per_unit?.toString() ?? '', lab_onboard_days: it?.lab_onboard_days?.toString() ?? '', lab_method_id: it?.lab_method_id ?? '',
  });
  const [gen, setGen] = useState<{ id: string; label: string } | null>(it?.generic_id ? { id: it.generic_id, label: `${it.inn}${it.strength ? ` ${it.strength}` : ''} — ${it.form_name}` } : null);
  const [packs, setPacks] = useState<PackRow[]>(it?.packs.map((p) => ({ id: p.id, name: p.name, qty_base: qtyFmt(p.qty_base), is_receipt_default: p.is_receipt_default })) ?? []);
  const [newCodes, setNewCodes] = useState<{ barcode: string; pack: string }[]>([]);
  const [bc, setBc] = useState({ barcode: '', pack: '' });
  const cats = refs.data?.categories ?? [];
  const category = cats.find((c) => c.id === f.category_id);
  const canEdit = can(user, ...CATALOG_EDIT) && (isMgr || !category || PHARM_KINDS.includes(category.kind));
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));
  const pickCategory = (id: string) => {
    const c = cats.find((x) => x.id === id);
    setF((p) => ({ ...p, category_id: id, ...(!it && c ? { requires_lot: c.requires_lot, requires_expiry: c.requires_expiry, serial_tracked: c.serial_tracked } : {}) }));
  };
  const packsBody = () => packs.filter((p) => p.name.trim()).map((p) => ({ ...(p.id && { id: p.id }), name: p.name.trim(), qty_base: Number(p.qty_base.replace(',', '.')), is_receipt_default: p.is_receipt_default }));
  const packsChanged = () => JSON.stringify(packsBody()) !== JSON.stringify((it?.packs ?? []).map((p) => ({ id: p.id, name: p.name, qty_base: Number(p.qty_base), is_receipt_default: p.is_receipt_default })));
  const done = () => { void qc.invalidateQueries({ queryKey: ['stock-items'] }); void qc.invalidateQueries({ queryKey: ['med-generics'] }); };
  const save = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        name: f.name.trim(), category_id: f.category_id, generic_id: gen?.id ?? null, manufacturer: nul(f.manufacturer), country: nul(f.country), base_unit: f.base_unit,
        storage: f.storage, requires_lot: f.requires_lot, requires_expiry: f.requires_lot && f.requires_expiry, serial_tracked: f.requires_lot && f.serial_tracked,
        expiry_warn_days: f.expiry_warn_days.trim() ? Number(f.expiry_warn_days) : null, billing_mode: f.billing_mode || null,
        sale_price: f.sale_price.trim() ? Number(f.sale_price.replace(',', '.')) : null, notes: nul(f.notes),
        ...(isLab && { lab_tests_per_unit: f.lab_tests_per_unit.trim() ? Number(f.lab_tests_per_unit) : null, lab_onboard_days: f.lab_onboard_days.trim() ? Number(f.lab_onboard_days) : null, lab_method_id: f.lab_method_id || null }),
      };
      if (f.code.trim()) body.code = f.code.trim();
      if (it) {
        body.is_active = f.is_active;
        let r = await api<StockItem>(`/stock/items/${it.id}`, { method: 'PATCH', body });
        if (packsChanged()) r = await api<StockItem>(`/stock/items/${it.id}/packs`, { method: 'PUT', body: { packs: packsBody() } });
        return r;
      }
      const pb = packsBody();
      return api<StockItem>('/stock/items', { body: { ...body, packs: pb, barcodes: newCodes.map((b) => ({ barcode: b.barcode, ...(b.pack !== '' && { pack_index: Number(b.pack) }) })) } });
    },
    onSuccess: () => { done(); onClose(); },
  });
  const addCode = useMutation({
    mutationFn: () => api<StockItem>(`/stock/items/${it!.id}/barcodes`, { body: { barcode: bc.barcode.trim(), pack_id: bc.pack || null } }),
    onSuccess: (r) => { setCur(r); setBc({ barcode: '', pack: '' }); done(); },
  });
  const delCode = useMutation({ mutationFn: (id: string) => api<StockItem>(`/stock/items/${it!.id}/barcodes/${id}`, { method: 'DELETE' }), onSuccess: (r) => { setCur(r); done(); } });
  const r = refs.data;
  const needGen = category?.kind === 'medication';
  const isLab = category?.kind === 'reagent' || category?.kind === 'qc_material';
  const methods = useQuery({ queryKey: ['lab-methods-stock'], queryFn: () => api<LabMethod[]>('/lab/methods').catch(() => [] as LabMethod[]), enabled: isLab });
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 } as const;
  const valid = f.name.trim().length >= 2 && f.category_id && f.base_unit && (!needGen || gen) && packs.every((p) => !p.name.trim() || Number(p.qty_base.replace(',', '.')) > 1);
  return (
    <Modal title={it ? `${it.name} · ${it.code}` : 'ახალი საქონელი'} onClose={onClose} width={900}
      footer={<><button className="btn" type="button" onClick={onClose}>{canEdit ? 'გაუქმება' : 'დახურვა'}</button>
        {canEdit && <button className="btn primary" type="submit" form="itf" disabled={save.isPending || !valid}>შენახვა</button>}</>}>
      {!r ? <Loading /> : (
        <form id="itf" className="stack" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <fieldset disabled={!canEdit} style={{ border: 0, padding: 0, margin: 0 }} className="stack">
            <div style={grid}>
              <Field label="კატეგორია" htmlFor="ic" required>
                <select id="ic" className="select" value={f.category_id} onChange={(e) => pickCategory(e.target.value)}>
                  <option value="">— აირჩიეთ —</option>
                  {cats.filter((c) => (c.is_active || c.id === f.category_id) && (isMgr || PHARM_KINDS.includes(c.kind))).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select></Field>
              <Field label="სავაჭრო დასახელება" htmlFor="in" required><input id="in" className="input" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="მაგ. Rocephin" /></Field>
              <Field label="შიდა კოდი" htmlFor="ico" hint="ცარიელი — ავტომატურად (I000001…)"><input id="ico" className="input mono" value={f.code} onChange={(e) => set('code', e.target.value)} /></Field>
            </div>
            {(needGen || gen) && (
              <div className="stack" style={{ gap: 4 }}>
                <span className="label">ჯენერიკი (INN + ფორმა + დოზა){needGen && <span className="req"> *</span>}</span>
                <GenericPicker value={gen?.id ?? null} label={gen?.label ?? null} onChange={setGen} />
                <span className="hint">ერთ ჯენერიკზე შეიძლება რამდენიმე სავაჭრო დასახელება იყოს — ექიმი ჯენერიკს ნიშნავს, აფთიაქი გასცემს იმას, რაც მარაგშია.</span>
              </div>)}
            <div style={grid}>
              <Field label="მწარმოებელი" htmlFor="im"><input id="im" className="input" value={f.manufacturer} onChange={(e) => set('manufacturer', e.target.value)} /></Field>
              <Field label="ქვეყანა" htmlFor="ict"><input id="ict" className="input" value={f.country} onChange={(e) => set('country', e.target.value)} /></Field>
              <Field label="საბაზო ერთეული" htmlFor="iu" required hint={it ? 'მოძრაობების შემდეგ აღარ შეიცვლება' : 'ყველაზე მცირე გასაცემი ერთეული'}>
                <select id="iu" className="select" value={f.base_unit} onChange={(e) => set('base_unit', e.target.value)}>
                  <option value="">— აირჩიეთ —</option>{r.units.filter((u) => u.is_active || u.code === f.base_unit).map((u) => <option key={u.code} value={u.code}>{u.name}</option>)}
                </select></Field>
              <Field label="შენახვის პირობა" htmlFor="ist">
                <select id="ist" className="select" value={f.storage} onChange={(e) => set('storage', e.target.value as StorageKind)}>
                  {(Object.keys(STORAGE_KA) as StorageKind[]).map((k) => <option key={k} value={k}>{STORAGE_KA[k]}</option>)}
                </select></Field>
              <Field label="ვადის გაფრთხილება (დღე)" htmlFor="iw" hint={`ცარიელი — კატეგორიის (${category?.expiry_warn_days ?? '—'})`}><input id="iw" className="input mono" inputMode="numeric" value={f.expiry_warn_days} onChange={(e) => set('expiry_warn_days', e.target.value)} /></Field>
              <div className="stack" style={{ gap: 6, alignSelf: 'end' }}>
                <label className="row small"><input type="checkbox" checked={f.requires_lot} onChange={(e) => set('requires_lot', e.target.checked)} /> ლოტის / სერიის აღრიცხვა</label>
                <label className="row small"><input type="checkbox" checked={f.requires_lot && f.requires_expiry} disabled={!f.requires_lot} onChange={(e) => set('requires_expiry', e.target.checked)} /> ვადის აღრიცხვა (FEFO)</label>
                <label className="row small"><input type="checkbox" checked={f.requires_lot && f.serial_tracked} disabled={!f.requires_lot} onChange={(e) => set('serial_tracked', e.target.checked)} /> სერიული ნომერი (იმპლანტი → პაციენტი)</label>
              </div>
              <Field label="პაციენტზე ხარჯის ბილინგი" htmlFor="ib" hint={`კატეგორიის: ${category?.billing_mode === 'invoice' ? 'ინვოისში' : 'მხოლოდ აღრიცხვა'}`}>
                <select id="ib" className="select" value={f.billing_mode} onChange={(e) => set('billing_mode', e.target.value as typeof f.billing_mode)}>
                  <option value="">კატეგორიის მიხედვით</option><option value="none">მხოლოდ აღრიცხვა</option><option value="invoice">ინვოისში — გასაყიდი ფასით</option>
                </select></Field>
              <Field label="გასაყიდი ფასი (საბაზო ერთეულზე, ₾)" htmlFor="isp" hint="ცარიელი — თვითღირებულება + კატეგორიის ფასნამატი"><input id="isp" className="input mono" inputMode="decimal" value={f.sale_price} onChange={(e) => set('sale_price', e.target.value)} /></Field>
              {it && <label className="row" style={{ alignSelf: 'end' }}><input type="checkbox" checked={f.is_active} onChange={(e) => set('is_active', e.target.checked)} /> აქტიური</label>}
            </div>

            {isLab && (
              <div style={grid}>
                <Field label="ტესტები ერთეულზე (ნომინალი)" htmlFor="ilt" hint="ეფექტიანობის რეპორტისთვის"><input id="ilt" className="input mono" inputMode="numeric" value={f.lab_tests_per_unit} onChange={(e) => set('lab_tests_per_unit', e.target.value)} /></Field>
                <Field label="გახსნის შემდეგ სტაბილურობა (დღე)" htmlFor="ilo" hint="on-board ვადა"><input id="ilo" className="input mono" inputMode="numeric" value={f.lab_onboard_days} onChange={(e) => set('lab_onboard_days', e.target.value)} /></Field>
                <Field label="ნაგულისხმევი ანალიზატორი" htmlFor="ilm">
                  <select id="ilm" className="select" value={f.lab_method_id} onChange={(e) => set('lab_method_id', e.target.value)}>
                    <option value="">—</option>{methods.data?.filter((m) => m.is_active || m.id === f.lab_method_id).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select></Field>
              </div>)}
            <div className="stack" style={{ gap: 6 }}>
              <div className="row"><span className="label grow">შეფუთვები <span className="small muted" style={{ fontWeight: 400 }}>— რაოდენობა საბაზო ერთეულებში (კოლოფი = 100 ტაბლეტი)</span></span>
                {packs.length < 5 && <button className="btn sm" type="button" onClick={() => setPacks([...packs, { name: '', qty_base: '', is_receipt_default: !packs.length }])}>+ შეფუთვა</button>}</div>
              {packs.map((p, i) => (
                <div key={p.id ?? `n${i}`} className="row" style={{ gap: 8 }}>
                  <input className="input" style={{ height: 36, maxWidth: 220 }} aria-label="შეფუთვის დასახელება" placeholder="კოლოფი" value={p.name} onChange={(e) => setPacks(packs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                  <span className="small">=</span>
                  <input className="input mono" style={{ height: 36, maxWidth: 110 }} aria-label="რაოდენობა" inputMode="decimal" value={p.qty_base} onChange={(e) => setPacks(packs.map((x, j) => (j === i ? { ...x, qty_base: e.target.value } : x)))} />
                  <span className="small muted">{r.units.find((u) => u.code === f.base_unit)?.name ?? ''}</span>
                  <label className="row small"><input type="radio" name="packdef" checked={p.is_receipt_default} onChange={() => setPacks(packs.map((x, j) => ({ ...x, is_receipt_default: j === i })))} /> მიღებისას ნაგულისხმევი</label>
                  <span className="grow" />
                  <button className="icon-btn" type="button" aria-label="შეფუთვის წაშლა" onClick={() => setPacks(packs.filter((_, j) => j !== i))}>×</button>
                </div>))}
            </div>
          </fieldset>

          <div className="stack" style={{ gap: 6 }}>
            <span className="label">შტრიხკოდები <span className="small muted" style={{ fontWeight: 400 }}>— EAN/GTIN ინახება GTIN-14-ად; DataMatrix-იდან GTIN ამოიჭრება</span></span>
            {(it ? cur?.barcodes ?? [] : []).map((b) => (
              <div key={b.id} className="row small" style={{ gap: 8 }}>
                <span className="mono">{b.barcode}</span><span className="muted">{b.pack_id ? cur?.packs.find((p) => p.id === b.pack_id)?.name ?? 'შეფუთვა' : 'საბაზო ერთეული'}</span>
                {canEdit && <button className="icon-btn" type="button" aria-label={`შტრიხკოდის მოხსნა ${b.barcode}`} onClick={() => { if (confirm(`მოვხსნათ ${b.barcode}?`)) delCode.mutate(b.id); }}>×</button>}
              </div>))}
            {!it && newCodes.map((b, i) => (
              <div key={b.barcode} className="row small" style={{ gap: 8 }}>
                <span className="mono">{b.barcode}</span><span className="muted">{b.pack !== '' ? packs[Number(b.pack)]?.name || 'შეფუთვა' : 'საბაზო ერთეული'}</span>
                <button className="icon-btn" type="button" aria-label="მოხსნა" onClick={() => setNewCodes(newCodes.filter((_, j) => j !== i))}>×</button>
              </div>))}
            {canEdit && (
              <div className="row" style={{ gap: 8 }}>
                <input className="input mono" style={{ height: 36, maxWidth: 280 }} aria-label="ახალი შტრიხკოდი" placeholder="დაასკანერეთ ან ჩაწერეთ" value={bc.barcode}
                  onChange={(e) => setBc({ ...bc, barcode: e.target.value })}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.currentTarget.nextElementSibling?.nextElementSibling as HTMLButtonElement | null)?.click(); } }} />
                <select className="select" style={{ height: 36, maxWidth: 220 }} aria-label="რომელ ერთეულს ეკუთვნის" value={bc.pack} onChange={(e) => setBc({ ...bc, pack: e.target.value })}>
                  <option value="">საბაზო ერთეული</option>
                  {it ? (cur?.packs ?? []).map((p) => <option key={p.id} value={p.id}>{p.name} ({qtyFmt(p.qty_base)})</option>)
                    : packs.map((p, i) => p.name.trim() && <option key={i} value={String(i)}>{p.name}</option>)}
                </select>
                <button className="btn sm" type="button" disabled={bc.barcode.trim().length < 4 || addCode.isPending}
                  onClick={() => { if (it) addCode.mutate(); else { setNewCodes([...newCodes, { barcode: bc.barcode.trim(), pack: bc.pack }]); setBc({ barcode: '', pack: '' }); } }}>დამატება</button>
              </div>)}
            <ErrorBox error={addCode.error ?? delCode.error} />
          </div>
          <Field label="შენიშვნა" htmlFor="ino"><textarea id="ino" className="textarea" rows={2} disabled={!canEdit} value={f.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
          <ErrorBox error={save.error} />
        </form>
      )}
    </Modal>
  );
}
