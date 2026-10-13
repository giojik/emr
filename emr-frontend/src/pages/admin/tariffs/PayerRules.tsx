import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, can } from '../../../api/client';
import { useAuth } from '../../../auth/AuthContext';
import { ErrorBox, Field, Loading, Modal, useToast } from '../../../components/ui';
import { todayISO } from '../../../lib/format';
import { CAT_KA, type Payer } from '../BillingSetup';
import { VersionCard } from './Changes';
import { type Clause, LINE_CATS, type PayerRules, type RuleVersion, TARIFF_EDIT } from './types';

/** გადამხდელის წესები (0054a): ვერსიები მოქმედების თარიღით, პუნქტები (პირველი შესაბამისი), თანაგადახდა */
export default function PayerRulesView() {
  const { user } = useAuth(); const edit = can(user, ...TARIFF_EDIT);
  const payers = useQuery({ queryKey: ['billing-payers'], queryFn: () => api<Payer[]>('/billing/payers') });
  const [sel, setSel] = useState('');
  useEffect(() => { if (!sel && payers.data?.length) setSel(payers.data.find((p) => p.is_active)?.id ?? payers.data[0].id); }, [payers.data, sel]);
  const r = useQuery({ queryKey: ['payer-rules', sel], enabled: !!sel, queryFn: () => api<PayerRules>(`/payer-rules/${sel}`) });
  const [form, setForm] = useState<RuleVersion | 'new' | null>(null);
  return (
    <div className="content">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <select className="select" aria-label="გადამხდელი" style={{ maxWidth: 380 }} value={sel} onChange={(e) => setSel(e.target.value)}>
          {payers.data?.map((p) => <option key={p.id} value={p.id}>{p.name}{p.is_active ? '' : ' (გათიშული)'}</option>)}</select>
        {r.data?.price_list && <span className="chip info">ფასთა ნუსხა: {r.data.price_list.name}</span>}
        <span className="grow" />
        {edit && r.data && <button className="btn primary" type="button" onClick={() => setForm(r.data.versions.find((v) => v.id === r.data.current_version_id) ?? 'new')}>+ ახალი ვერსია</button>}
      </div>
      <span className="hint">ვერსია მოქმედებს თარიღიდან; ჰოსპიტალიზაცია იღებს მიღების დღის ვერსიას, ამბულატორია — ვიზიტის დღისას. პუნქტები მოწმდება რიგით — მოქმედებს პირველი შესაბამისი; შესაბამისის გარეშე — ნაგულისხმევი პირობები.</span>
      <ErrorBox error={payers.error ?? r.error} />
      {r.isLoading ? <Loading /> : r.data?.versions.map((v) => <VersionCard key={v.id} v={v} current={v.id === r.data.current_version_id} />)}
      {form && r.data && <VersionForm payer={r.data.payer} base={form === 'new' ? null : form} onClose={() => setForm(null)} />}
    </div>
  );
}

const emptyClause = (seq: number): Clause => ({ seq, label: '', categories: [], codes: [], age_min: null, age_max: null, sex: null, dx_prefixes: [], effect: 'exclude', coverage_pct: null, line_limit: null });
const list = (s: string) => s.split(/[\s,;]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);
const numOrNull = (s: string) => (s.trim() === '' ? null : Number(s.replace(',', '.')));

function VersionForm({ payer, base, onClose }: { payer: PayerRules['payer']; base: RuleVersion | null; onClose: () => void }) {
  const qc = useQueryClient(); const toast = useToast();
  const [f, setF] = useState({
    valid_from: todayISO(), applies_to: base?.applies_to ?? 'all', mode: base?.mode ?? 'percent', coverage_pct: base ? String(Number(base.coverage_pct)) : '100',
    limit_amount: base?.limit_amount ?? '', deductible: base ? String(Number(base.deductible)) : '0', fixed_amount: base?.fixed_amount ?? '', drg_base_rate: base?.drg_base_rate ?? '',
    writeoff_excess: base?.writeoff_excess ?? false, copay_amount: base ? String(Number(base.copay_amount)) : '0', excluded_categories: base?.excluded_categories ?? [],
    excluded_codes: (base?.excluded_codes ?? []).join(', '), notes: base?.notes ?? '', reason: '',
  });
  const [cls, setCls] = useState<(Clause & { codesTxt: string; dxTxt: string })[]>((base?.clauses ?? []).map((c) => ({ ...c, codesTxt: c.codes.join(', '), dxTxt: c.dx_prefixes.join(', ') })));
  const set = (k: keyof typeof f, v: unknown) => setF({ ...f, [k]: v });
  const setC = (i: number, patch: Partial<(typeof cls)[number]>) => setCls(cls.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const m = useMutation({
    mutationFn: () => api<{ status: string; change_no: string }>(`/payer-rules/${payer.id}/versions`, { body: {
      valid_from: f.valid_from, applies_to: f.applies_to, mode: f.mode, coverage_pct: Number(f.coverage_pct), limit_amount: numOrNull(String(f.limit_amount ?? '')),
      deductible: Number(f.deductible || 0), fixed_amount: numOrNull(String(f.fixed_amount ?? '')), drg_base_rate: numOrNull(String(f.drg_base_rate ?? '')), writeoff_excess: f.writeoff_excess,
      copay_amount: Number(f.copay_amount || 0), excluded_categories: f.excluded_categories, excluded_codes: list(f.excluded_codes), notes: f.notes.trim() || null, reason: f.reason.trim(),
      clauses: cls.map((c, i) => ({ seq: i + 1, label: c.label?.trim() || null, categories: c.categories, codes: list(c.codesTxt), age_min: c.age_min, age_max: c.age_max, sex: c.sex,
        dx_prefixes: list(c.dxTxt), effect: c.effect, coverage_pct: c.effect === 'cover' ? numOrNull(String(c.coverage_pct ?? '')) : null, line_limit: c.effect === 'cover' ? numOrNull(String(c.line_limit ?? '')) : null })) } }),
    onSuccess: (r) => { toast.show(`${r.change_no} — ${r.status === 'active' ? 'მოქმედებს' : 'დასამტკიცებელი'}`); void qc.invalidateQueries({ queryKey: ['payer-rules'] }); void qc.invalidateQueries({ queryKey: ['tariff-changes'] }); setTimeout(onClose, 500); },
  });
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 } as const;
  return (
    <Modal title={`${payer.name} — ახალი ვერსია`} onClose={onClose} width={980}
      footer={<><button className="btn" type="button" onClick={onClose}>დახურვა</button><button className="btn primary" type="submit" form="prv" disabled={m.isPending || f.reason.trim().length < 3}>შენახვა</button></>}>
      {toast.node}
      <form id="prv" className="stack" style={{ gap: 12 }} onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <div style={grid}>
          <Field label="მოქმედებს" htmlFor="pvf" required><input id="pvf" className="input mono" type="date" min={todayISO()} value={f.valid_from} onChange={(e) => set('valid_from', e.target.value)} /></Field>
          <Field label="ვრცელდება" htmlFor="pva"><select id="pva" className="select" value={f.applies_to} onChange={(e) => set('applies_to', e.target.value)}>
            <option value="all">ამბულატორია + სტაციონარი</option><option value="opd">ამბულატორია</option><option value="ipd">სტაციონარი</option></select></Field>
          <Field label="რეჟიმი" htmlFor="pvm"><select id="pvm" className="select" value={f.mode} onChange={(e) => set('mode', e.target.value)}>
            <option value="percent">პროცენტი</option><option value="fixed">ფიქსირებული</option><option value="drg">DRG</option></select></Field>
          <Field label="დაფარვა %" htmlFor="pvp"><input id="pvp" className="input mono" inputMode="decimal" value={f.coverage_pct} onChange={(e) => set('coverage_pct', e.target.value)} /></Field>
          {f.mode === 'percent' && <Field label="ლიმიტი (შემთხვევაზე)" htmlFor="pvl"><input id="pvl" className="input mono" inputMode="decimal" value={f.limit_amount ?? ''} onChange={(e) => set('limit_amount', e.target.value)} placeholder="—" /></Field>}
          {f.mode === 'percent' && <Field label="ფრანშიზა" htmlFor="pvd"><input id="pvd" className="input mono" inputMode="decimal" value={f.deductible} onChange={(e) => set('deductible', e.target.value)} /></Field>}
          {f.mode === 'fixed' && <Field label="ფიქსირებული თანხა" htmlFor="pvx"><input id="pvx" className="input mono" inputMode="decimal" value={f.fixed_amount ?? ''} onChange={(e) => set('fixed_amount', e.target.value)} /></Field>}
          {f.mode === 'drg' && <Field label="DRG საბაზისო განაკვეთი" htmlFor="pvr"><input id="pvr" className="input mono" inputMode="decimal" value={f.drg_base_rate ?? ''} onChange={(e) => set('drg_base_rate', e.target.value)} /></Field>}
          <Field label="თანაგადახდა (შემთხვევაზე)" htmlFor="pvc" hint="პაციენტი იხდის — გადამხდელის წილს აკლდება"><input id="pvc" className="input mono" inputMode="decimal" value={f.copay_amount} onChange={(e) => set('copay_amount', e.target.value)} /></Field>
          {f.mode !== 'percent' && <label className="row small" style={{ alignSelf: 'end' }}><input type="checkbox" checked={f.writeoff_excess} onChange={(e) => set('writeoff_excess', e.target.checked)} /> ტარიფს ზემოთ — ჩამოწერა</label>}
        </div>
        <div className="stack" style={{ gap: 6 }}>
          <span className="label">არ ფარავს (ნაგულისხმევად)</span>
          <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>{LINE_CATS.filter((c) => c !== 'package').map((c) => <label key={c} className="row small">
            <input type="checkbox" checked={f.excluded_categories.includes(c)} onChange={(e) => set('excluded_categories', e.target.checked ? [...f.excluded_categories, c] : f.excluded_categories.filter((x) => x !== c))} /> {CAT_KA[c]}</label>)}</div>
          <input className="input mono" aria-label="გამორიცხული კოდები" placeholder="ტარიფის კოდები, მძიმით: CONS_COSM, US_3D …" value={f.excluded_codes} onChange={(e) => set('excluded_codes', e.target.value)} />
        </div>
        <div className="stack" style={{ gap: 8 }}>
          <div className="row"><span className="label grow">პუნქტები — მოწმდება რიგით, მოქმედებს პირველი შესაბამისი</span><button className="btn sm" type="button" onClick={() => setCls([...cls, { ...emptyClause(cls.length + 1), codesTxt: '', dxTxt: '' }])}>+ პუნქტი</button></div>
          {cls.map((c, i) => (
            <div key={i} className="card card-pad" style={{ display: 'grid', gridTemplateColumns: '28px 1.4fr 1.2fr 1fr 1fr 1.6fr auto', gap: 8, alignItems: 'end' }}>
              <span className="mono" style={{ alignSelf: 'center' }}>{i + 1}</span>
              <Field label="სახელი" htmlFor={`cl${i}`}><input id={`cl${i}`} className="input" value={c.label ?? ''} onChange={(e) => setC(i, { label: e.target.value })} /></Field>
              <Field label="კატეგორია" htmlFor={`cc${i}`}><select id={`cc${i}`} className="select" value={c.categories[0] ?? ''} onChange={(e) => setC(i, { categories: e.target.value ? [e.target.value] : [] })}>
                <option value="">ნებისმიერი</option>{LINE_CATS.map((x) => <option key={x} value={x}>{CAT_KA[x]}</option>)}</select></Field>
              <Field label="კოდები" htmlFor={`ck${i}`}><input id={`ck${i}`} className="input mono" value={c.codesTxt} onChange={(e) => setC(i, { codesTxt: e.target.value })} /></Field>
              <Field label="ICD-10" htmlFor={`cd${i}`}><input id={`cd${i}`} className="input mono" placeholder="J18, O" value={c.dxTxt} onChange={(e) => setC(i, { dxTxt: e.target.value })} /></Field>
              <div className="row" style={{ gap: 4 }}>
                <input className="input mono" style={{ width: 54 }} aria-label="ასაკი დან" placeholder="დან" value={c.age_min ?? ''} onChange={(e) => setC(i, { age_min: numOrNull(e.target.value) })} />
                <input className="input mono" style={{ width: 54 }} aria-label="ასაკი მდე" placeholder="მდე" value={c.age_max ?? ''} onChange={(e) => setC(i, { age_max: numOrNull(e.target.value) })} />
                <select className="select" style={{ width: 80 }} aria-label="სქესი" value={c.sex ?? ''} onChange={(e) => setC(i, { sex: (e.target.value || null) as Clause['sex'] })}><option value="">სქესი</option><option value="male">მამრ.</option><option value="female">მდედრ.</option></select>
              </div>
              <button className="btn sm" type="button" aria-label="წაშლა" onClick={() => setCls(cls.filter((_, j) => j !== i))}>×</button>
              <span />
              <div className="row" style={{ gridColumn: '2 / -1', gap: 8 }}>
                <div className="seg" role="group" aria-label="შედეგი"><button type="button" aria-pressed={c.effect === 'exclude'} onClick={() => setC(i, { effect: 'exclude' })}>არ ფარავს</button>
                  <button type="button" aria-pressed={c.effect === 'cover'} onClick={() => setC(i, { effect: 'cover' })}>ფარავს</button></div>
                {c.effect === 'cover' && <><input className="input mono" style={{ width: 90 }} aria-label="%" placeholder="%" value={c.coverage_pct ?? ''} onChange={(e) => setC(i, { coverage_pct: e.target.value })} />
                  <input className="input mono" style={{ width: 130 }} aria-label="ხაზის ლიმიტი" placeholder="ხაზის ლიმიტი" value={c.line_limit ?? ''} onChange={(e) => setC(i, { line_limit: e.target.value })} /></>}
                <span className="small muted">{i > 0 && <button className="btn sm" type="button" onClick={() => { const x = [...cls]; [x[i - 1], x[i]] = [x[i], x[i - 1]]; setCls(x); }}>↑ ზემოთ</button>}</span>
              </div>
            </div>))}
        </div>
        <Field label="მიზეზი / საფუძველი" htmlFor="pvn" required><input id="pvn" className="input" value={f.reason} onChange={(e) => set('reason', e.target.value)} placeholder="ხელშეკრულება / დანართი №" /></Field>
        <span className="hint">უკვე გახსნილ ჰოსპიტალიზაციას პირობები არ ეცვლება (ჩანაწერი ინახავს თავის ვერსიას); ამბულატორიაში ახალი ვერსია ეხება ვიზიტებს მოქმედების თარიღიდან.</span>
        <ErrorBox error={m.error} />
      </form>
    </Modal>
  );
}
