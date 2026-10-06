import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { ErrorBox, Field, Loading, useToast } from '../../components/ui';
import { tsDate } from '../../lib/format';
import { useModules, type SystemModule } from '../../lib/modules';

/** მოდულები და პარამეტრები: სხვა კლინიკაში — ადგილობრივი წესებით; ნაგულისხმევი = მიმდინარე ქცევა */
export default function Modules() {
  const q = useModules();
  if (q.isLoading) return <div className="content"><Loading /></div>;
  return (
    <div className="content">
      <span className="hint">ჩართეთ / გამორთეთ მოდულები და შეცვალეთ მათი პარამეტრები კლინიკის წესების მიხედვით. გამორთული მოდული ქრება მენიუდან. ყოველი ცვლილება აუდიტშია (მიზეზით).</span>
      <ErrorBox error={q.error} />
      {q.data?.map((m) => <ModuleCard key={m.code} m={m} />)}
    </div>
  );
}

function ModuleCard({ m }: { m: SystemModule }) {
  const qc = useQueryClient(); const toast = useToast();
  const [s, setS] = useState<Record<string, unknown>>(m.settings);
  const [enabled, setEnabled] = useState(m.enabled);
  const [reason, setReason] = useState('');
  const dirty = enabled !== m.enabled || JSON.stringify(s) !== JSON.stringify(m.settings);
  const save = useMutation({
    mutationFn: () => api<SystemModule>(`/modules/${m.code}`, { method: 'PUT', body: { enabled, settings: s, reason: reason.trim() } }),
    onSuccess: () => { setReason(''); toast.show('შენახულია'); void qc.invalidateQueries({ queryKey: ['modules'] }); },
  });
  return (
    <section className="card card-pad stack">
      {toast.node}
      <div className="row"><h2 className="grow" style={{ margin: 0 }}>{m.name}</h2>
        {m.can_disable === false ? <span className="chip ok">ძირითადი მოდული — არ ითიშება</span>
          : <label className="row"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> <strong>{enabled ? 'ჩართულია' : 'გამორთულია'}</strong></label>}</div>
      {m.description && <span className="small muted">{m.description}</span>}
      {m.code === 'asset_register' && <AssetSettings s={s} set={setS} />}
      {m.code === 'stock' && <StockSettings s={s} set={setS} />}
      {m.code === 'cssd' && <CssdSettings s={s} set={setS} />}
      {m.code === 'inpatient' && <InpatientSettings s={s} set={setS} />}
      <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <span className="small muted grow">ბოლო ცვლილება: {tsDate(m.updated_at)}</span>
        {dirty && <><input className="input" style={{ maxWidth: 360, height: 38 }} aria-label="ცვლილების მიზეზი" placeholder="ცვლილების მიზეზი (სავალდებულო)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <button className="btn" type="button" onClick={() => { setS(m.settings); setEnabled(m.enabled); }}>გაუქმება</button>
          <button className="btn primary" type="button" disabled={save.isPending || reason.trim().length < 3} onClick={() => save.mutate()}>შენახვა</button></>}
      </div>
      <ErrorBox error={save.error} />
    </section>
  );
}

interface Person { id: string; name: string; department_name: string | null }
function AssetSettings({ s, set }: { s: Record<string, unknown>; set: (v: Record<string, unknown>) => void }) {
  const v = <T,>(k: string) => s[k] as T;
  const upd = (k: string, val: unknown) => set({ ...s, [k]: val });
  const [q, setQ] = useState('');
  const people = useQuery({ queryKey: ['asset-people', q], queryFn: () => api<Person[]>('/assets/people', { query: { search: q } }).catch(() => [] as Person[]), enabled: v<string>('writeoff_mode') === 'committee' });
  const committee = v<string[]>('writeoff_committee') ?? [];
  const known = useQuery({ queryKey: ['asset-people', ''], queryFn: () => api<Person[]>('/assets/people').catch(() => [] as Person[]) });
  const example = [v<string>('inv_prefix'), v<boolean>('inv_year') ? String(new Date().getFullYear()).slice(2) : '', '1'.padStart(v<number>('inv_digits') ?? 5, '0')].filter(Boolean).join('-');
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 } as const;
  return (
    <div className="stack">
      <div style={grid}>
        <Field label="ნომრის პრეფიქსი" htmlFor="ip" hint="დიდი ლათ. ასოები / ციფრები, ≤ 8; ცარიელი — პრეფიქსის გარეშე"><input id="ip" className="input mono" maxLength={8} value={v<string>('inv_prefix') ?? ''} onChange={(e) => upd('inv_prefix', e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} /></Field>
        <Field label="ციფრების რაოდენობა" htmlFor="id"><input id="id" className="input mono" type="number" min={3} max={9} value={v<number>('inv_digits') ?? 5} onChange={(e) => upd('inv_digits', Number(e.target.value))} /></Field>
        <div className="stack" style={{ gap: 4 }}><label className="row" style={{ marginTop: 26 }}><input type="checkbox" checked={!!v<boolean>('inv_year')} onChange={(e) => upd('inv_year', e.target.checked)} /> წელი ნომერში</label>
          <span className="small">მაგალითი: <strong className="mono">{example}</strong></span></div>
        <label className="row"><input type="checkbox" checked={!!v<boolean>('require_room')} onChange={(e) => upd('require_room', e.target.checked)} /> ოთახი სავალდებულოა</label>
        <label className="row"><input type="checkbox" checked={!!v<boolean>('require_responsible')} onChange={(e) => upd('require_responsible', e.target.checked)} /> პასუხისმგებელი სავალდებულოა</label>
        <label className="row"><input type="checkbox" checked={!!v<boolean>('track_value')} onChange={(e) => upd('track_value', e.target.checked)} /> შეძენის ღირებულება / მომწოდებელი</label>
        <Field label="გადაადგილება" htmlFor="mm"><select id="mm" className="select" value={v<string>('move_mode')} onChange={(e) => upd('move_mode', e.target.value)}>
          <option value="confirm">მიმღების დადასტურებით</option><option value="direct">პირდაპირ (დადასტურების გარეშე)</option></select></Field>
        <Field label="ჩამოწერის აქტი" htmlFor="wm"><select id="wm" className="select" value={v<string>('writeoff_mode')} onChange={(e) => upd('writeoff_mode', e.target.value)}>
          <option value="single">ერთი დამმტკიცებელი (საწყობის მენეჯერი)</option><option value="committee">კომისია (კვორუმით)</option><option value="direct">პირდაპირ (დამტკიცების გარეშე)</option></select></Field>
        <Field label="ეტიკეტი" htmlFor="lb"><div className="row" style={{ gap: 6 }}>
          <select id="lb" className="select" value={v<string>('label_size')} onChange={(e) => upd('label_size', e.target.value)}><option value="50x25">50×25 მმ</option><option value="40x20">40×20 მმ</option><option value="70x35">70×35 მმ</option></select>
          <select className="select" aria-label="კოდის ტიპი" value={v<string>('label_code')} onChange={(e) => upd('label_code', e.target.value)}><option value="qr">QR</option><option value="code128">შტრიხკოდი (Code128)</option></select></div></Field>
      </div>
      {v<string>('writeoff_mode') === 'committee' && (
        <div className="card card-pad stack" style={{ gap: 8 }}>
          <div className="row"><strong className="grow">კომისიის წევრები</strong>
            <label className="row small">კვორუმი (დამტკიცებისთვის საჭირო ხმა) <input className="input mono" style={{ width: 70, height: 34 }} type="number" min={1} max={15} value={v<number>('committee_quorum') ?? 2} onChange={(e) => upd('committee_quorum', Number(e.target.value))} /></label></div>
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>{committee.map((id) => { const p = known.data?.find((x) => x.id === id);
            return <span key={id} className="term">{p?.name ?? id.slice(0, 8)}<button type="button" aria-label="მოხსნა" onClick={() => upd('writeoff_committee', committee.filter((x) => x !== id))}>×</button></span>; })}
            {!committee.length && <span className="small muted">წევრები არ არის</span>}</div>
          <input className="input" style={{ maxWidth: 360, height: 36 }} aria-label="თანამშრომლის ძებნა" placeholder="დაამატეთ: სახელი, გვარი" value={q} onChange={(e) => setQ(e.target.value)} />
          {q.trim().length >= 2 && <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>{people.data?.filter((p) => !committee.includes(p.id)).slice(0, 10).map((p) =>
            <button key={p.id} className="btn sm" type="button" onClick={() => { upd('writeoff_committee', [...committee, p.id]); setQ(''); }}>+ {p.name}{p.department_name ? ` · ${p.department_name}` : ''}</button>)}</div>}
        </div>)}
    </div>
  );
}

const CLASSES: [string, string][] = [['narcotic', 'ნარკოტიკული'], ['psychotropic', 'ფსიქოტროპული'], ['precursor', 'პრეკურსორი'], ['potent', 'ძლიერმოქმედი']];
/** საწყობის წესები (0038); თვითღირებულება / ზღვრები / შემოწმების საათი — საწყობი → პარამეტრები */
function StockSettings({ s, set }: { s: Record<string, unknown>; set: (v: Record<string, unknown>) => void }) {
  const v = <T,>(k: string) => s[k] as T;
  const upd = (k: string, val: unknown) => set({ ...s, [k]: val });
  const toggleIn = (k: string, c: string) => { const cur = v<string[]>(k) ?? []; upd(k, cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c]); };
  const chk = (k: string, label: string, hint?: string) => <label className="row" style={{ alignItems: 'flex-start' }}><input type="checkbox" checked={!!v<boolean>(k)} onChange={(e) => upd(k, e.target.checked)} />
    <span>{label}{hint && <div className="small muted">{hint}</div>}</span></label>;
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 14 } as const;
  return (
    <div className="stack">
      <div style={grid}>
        <Field label="გაცემა" htmlFor="sim" hint="ორმხრივი: მარაგი „გზაშია“ მიმღების დადასტურებამდე; ცალმხრივი: გაცემისთანავე ჩაირიცხება">
          <select id="sim" className="select" value={v<string>('issue_mode')} onChange={(e) => upd('issue_mode', e.target.value)}>
            <option value="two_step">ორმხრივი — მიმღები ადასტურებს</option><option value="one_step">ცალმხრივი — დადასტურების გარეშე</option></select></Field>
        <Field label="ფარმაცევტი" htmlFor="sps" hint="მიღება მომწოდებლისგან, გაცემა, ხარჯი">
          <select id="sps" className="select" value={v<string>('pharmacist_scope')} onChange={(e) => upd('pharmacist_scope', e.target.value)}>
            <option value="pharmacy">მხოლოდ აფთიაქის ლოკაციებზე</option><option value="any">ნებისმიერ ლოკაციაზე</option></select></Field>
      </div>
      <div style={grid}>
        <div className="stack" style={{ gap: 6 }}><span className="label">მოწმე სავალდებულოა (ხარჯი, ჩამოწერა; ჟურნალი, ცვლის ჩაბარება)</span>
          <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>{CLASSES.map(([c, l]) => <label key={c} className="row"><input type="checkbox" checked={(v<string[]>('witness_classes') ?? []).includes(c)} onChange={() => toggleIn('witness_classes', c)} /> {l}</label>)}</div>
          {!(v<string[]>('witness_classes') ?? []).length && <span className="small" style={{ color: 'var(--danger-ink)' }}>არცერთი — მოწმე და ჟურნალი გამორთულია</span>}</div>
        <div className="stack" style={{ gap: 6 }}><span className="label">ცარიელი ამპულის დაბრუნება აფთიაქში</span>
          <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>{CLASSES.map(([c, l]) => <label key={c} className="row"><input type="checkbox" checked={(v<string[]>('empty_return_classes') ?? []).includes(c)} onChange={() => toggleIn('empty_return_classes', c)} /> {l}</label>)}</div></div>
      </div>
      <div style={grid}>
        {chk('dose_required', 'მოწმის კლასებზე — მიღებული დოზა სავალდებულო', 'გამორთვისას დოზა / ნარჩენი სურვილისამებრ')}
        {chk('lost_requires_approval', '„დაკარგულის“ ჩამოწერა — ყოველთვის დამტკიცებით', 'გამორთვისას — ზღვრით, როგორც სხვა მიზეზები')}
        {chk('count_lock', 'ინვენტარიზაციისას ლოკაციის ბლოკი', 'დაწყებიდან დამტკიცებამდე მოძრაობა აკრძალულია')}
        {chk('count_blind_default', 'ინვენტარიზაცია — ნაგულისხმევად ბრმა', 'მთვლელი სისტემურ რაოდენობას ვერ ხედავს')}
      </div>
      <div className="stack" style={{ gap: 6 }}><span className="label">დილის შემოწმება (შეტყობინებები)</span>
        <div className="row" style={{ flexWrap: 'wrap', gap: 18 }}>{chk('alert_expiry', 'ვადები')}{chk('alert_minmax', 'მინიმუმზე ქვემოთ')}{chk('alert_lab', 'ლაბორატორია: on-board ვადა')}</div></div>
      <span className="small">თვითღირებულების მეთოდი, მოკლე ვადა, ჩამოწერის დამტკიცების ზღვარი, შემოწმების საათი — <Link to="/stock/setup">საწყობი → პარამეტრები</Link>.</span>
    </div>
  );
}

/** CSSD (0039) */
function CssdSettings({ s, set }: { s: Record<string, unknown>; set: (v: Record<string, unknown>) => void }) {
  const v = <T,>(k: string) => s[k] as T;
  const upd = (k: string, val: unknown) => set({ ...s, [k]: val });
  const chk = (k: string, label: string, hint?: string) => <label className="row" style={{ alignItems: 'flex-start' }}><input type="checkbox" checked={!!v<boolean>(k)} onChange={(e) => upd(k, e.target.checked)} />
    <span>{label}{hint && <div className="small muted">{hint}</div>}</span></label>;
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 14 } as const;
  return (
    <div className="stack">
      <div style={grid}>
        <Field label="ბიოლოგიური ინდიკატორი (BI)" htmlFor="cbf"><select id="cbf" className="select" value={v<string>('bi_frequency')} onChange={(e) => upd('bi_frequency', e.target.value)}>
          <option value="each">ყოველ ციკლზე</option><option value="daily">დღის პირველ ციკლზე</option><option value="weekly">კვირის პირველ ციკლზე</option><option value="off">გამორთული (მხოლოდ იმპლანტზე — თუ მოლოდინი ჩართულია)</option></select></Field>
        <Field label="გაშვება BI-ს პასუხამდე" htmlFor="cbh"><select id="cbh" className="select" value={v<string>('bi_hold')} onChange={(e) => upd('bi_hold', e.target.value)}>
          <option value="implant">იმპლანტი — ელოდება; დანარჩენი — ქიმიურით</option><option value="all">ყველა BI-იანი ჩატვირთვა ელოდება</option><option value="none">არ ელოდება (ქიმიური ინდიკატორით)</option></select></Field>
        <Field label="სტერილობის ვადა" htmlFor="csl"><select id="csl" className="select" value={v<string>('shelf_life_mode')} onChange={(e) => upd('shelf_life_mode', e.target.value)}>
          <option value="time">დროზე დამოკიდებული (შეფუთვის ტიპით)</option><option value="event">მოვლენაზე დამოკიდებული (ვადის გარეშე)</option></select></Field>
      </div>
      <div style={grid}>
        {chk('bd_required', 'Bowie-Dick ყოველდღე', 'ორთქლის აპარატი — დღის პირველ ციკლამდე; ჩავარდნისას იბლოკება')}
        {chk('wash_record', 'რეცხვის ციკლის აღრიცხვა', 'სარეცხი აპარატი + შედეგი; გამორთვისას — მიღებიდან პირდაპირ შეფუთვა')}
        {chk('patient_trace', 'პაციენტზე მიკვლევა', 'განყოფილებაში გამოყენებისას პაციენტი სავალდებულოა')}
        {chk('auto_consume', 'შეფუთვის მასალის ავტომატური ჩამოწერა', 'CSSD-ის ქვესაწყობიდან, შეფუთვის ტიპის მიხედვით')}
        {chk('instrument_tracking', 'ინსტრუმენტების ცალკე აღრიცხვა', 'კოდი, ციკლების რაოდენობა, ზღვარი')}
        <Field label="ეტიკეტი" htmlFor="clb"><div className="row" style={{ gap: 6 }}>
          <select id="clb" className="select" value={v<string>('label_size')} onChange={(e) => upd('label_size', e.target.value)}><option value="50x25">50×25 მმ</option><option value="40x20">40×20 მმ</option><option value="70x35">70×35 მმ</option></select>
          <select className="select" aria-label="კოდი" value={v<string>('label_code')} onChange={(e) => upd('label_code', e.target.value)}><option value="qr">QR</option><option value="code128">Code128</option></select></div></Field>
      </div>
      <span className="small">CSSD ერთეული = ლოკაცია ტიპით „სტერილიზაცია (CSSD)“, განყოფილებაზე მიბმული (საწყობი → ლოკაციები). ცენტრალური CSSD — ერთი ერთეული; დეცენტრალიზებული — თითო განყოფილებას თავისი.</span>
    </div>
  );
}

/** სტაციონარი (0040) */
function InpatientSettings({ s, set }: { s: Record<string, unknown>; set: (v: Record<string, unknown>) => void }) {
  const v = <T,>(k: string) => s[k] as T;
  const upd = (k: string, val: unknown) => set({ ...s, [k]: val });
  const chk = (k: string, label: string, hint?: string) => <label className="row" style={{ alignItems: 'flex-start' }}><input type="checkbox" checked={!!v<boolean>(k)} onChange={(e) => upd(k, e.target.checked)} />
    <span>{label}{hint && <div className="small muted">{hint}</div>}</span></label>;
  const num = (k: string, label: string, min: number, max: number, hint?: string) => <Field label={label} htmlFor={`ip-${k}`} hint={hint}>
    <input id={`ip-${k}`} className="input mono" type="number" min={min} max={max} value={v<number>(k) ?? ''} onChange={(e) => upd(k, Number(e.target.value))} /></Field>;
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 14 } as const;
  return (
    <div className="stack">
      <div style={grid}>
        <Field label="საწოლის მინიჭება" htmlFor="ipm" hint="ორეტაპიანი: მიმღები → განყოფილება, განყოფილება → საწოლი"><select id="ipm" className="select" value={v<string>('bed_assign_mode')} onChange={(e) => upd('bed_assign_mode', e.target.value)}>
          <option value="two_step">ორეტაპიანი (განყოფილება ანიჭებს)</option><option value="direct">პირდაპირ (მიმღები ანიჭებს)</option></select></Field>
        <Field label="სქესის წესი პალატაში" htmlFor="ips"><select id="ips" className="select" value={v<string>('sex_rule')} onChange={(e) => upd('sex_rule', e.target.value)}>
          <option value="warn">გაფრთხილება (დადასტურებით)</option><option value="block">აკრძალულია</option><option value="off">გამორთული</option></select></Field>
        {num('cancel_hours', 'გაუქმების ვადა (სთ)', 0, 168, 'შეცდომით გაფორმებული ჰოსპიტალიზაცია; admin — ნებისმიერ დროს')}
      </div>
      <div style={grid}>
        {chk('cleaning_required', 'დალაგება სავალდებულოა', 'გათავისუფლებული საწოლი → „დასალაგებელი“, სანამ თანამშრომელი არ დაადასტურებს')}
        {chk('overflow_beds', 'დამატებითი საწოლები', 'დერეფანი და სხვ. — სტატისტიკაში ცალკე')}
        {chk('planned_queue', 'გეგმიური ჰოსპიტალიზაციის რიგი', 'თარიღი, საწოლის დაჯავშნა')}
        {chk('planned_sms', 'SMS შეხსენება წინა დღეს', 'მხოლოდ პაციენტის SMS თანხმობით; 10:00-დან')}
        {chk('wristband', 'პაციენტის სამაჯური')}
        <Field label="სამაჯურის ბეჭდვა" htmlFor="ipw"><select id="ipw" className="select" value={v<string>('wristband_print')} onChange={(e) => upd('wristband_print', e.target.value)}>
          <option value="zpl">Zebra (ქსელით, ZPL)</option><option value="pdf">PDF (ნებისმიერი პრინტერი)</option></select></Field>
      </div>
      {v<boolean>('wristband') && <div style={grid}>
        {num('wristband_width_mm', 'სამაჯურის სიგანე (მმ)', 15, 40, 'მოზრდილი — 25')}
        {num('wristband_length_mm', 'სამაჯურის სიგრძე (მმ)', 80, 400, 'მოზრდილი — 279, ბავშვის — 152')}
        {num('wristband_offset_mm', 'საკეტის ზონა (მმ)', 0, 200, 'დასაწყისიდან — ბეჭდვის გარეშე')}
      </div>}
      <span className="small">საწოლფონდი — <Link to="/admin/beds">ადმინისტრირება → საწოლფონდი</Link>; პრინტერები — <Link to="/admin/printers">პრინტერები</Link>; ჰოსპიტალიზაციის თანხმობის ტექსტი — <Link to="/admin/consents">თანხმობები</Link>.</span>
    </div>
  );
}
