import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { ErrorBox, Field, Loading, useToast } from '../../components/ui';
import { tsDate } from '../../lib/format';
import { useModules, type SystemModule } from '../../lib/modules';
import { ALL_FEATURES, FEATURE_KA, type IcuFeature } from '../inpatient/Icu';

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
      {m.code === 'icu' && <IcuSettings s={s} set={setS} />}
      {m.code === 'or' && <OrSettingsCard s={s} set={setS} />}
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
      <h3 style={{ margin: '6px 0 0' }}>გადაყვანა, ეპიკრიზი, გაწერა</h3>
      <div style={grid}>
        {num('transfer_wait_hours', 'გადაყვანის პასუხის ვადა (სთ)', 1, 72, 'გადაცილებისას — შეტყობინება ორივე განყოფილებას')}
        {num('discharge_cancel_hours', 'გაწერის გაუქმების ვადა (სთ)', 0, 168, 'შეცდომით გაწერა; გარდაცვალება — მხოლოდ admin')}
        {num('docs_pending_alert_hours', 'დაუხურავი დოკუმენტაცია (სთ)', 1, 720, 'თვითნებური / გარდაცვალება — შეხსენება მკურნალ ექიმს')}
        {num('leave_max_hours', 'დროებითი გასვლა — მაქს. (სთ)', 1, 336)}
        {chk('leave_counts_bed_day', 'დროებითი გასვლის ღამე — საწოლდღე', 'გამორთულისას საწოლდღეებს აკლდება გასვლაზე გატარებული ღამეები')}
        {chk('epicrisis_cosign', 'ეპიკრიზის თანახელმოწერა', 'მკურნალი ექიმის შემდეგ — განყოფილების ხელმძღვანელი; № და PDF — თანახელმოწერისას')}
      </div>
      <h3 style={{ margin: '6px 0 0' }}>დანიშნულებები</h3>
      <div style={grid}>
        <Field label="ვინ ადასტურებს დანიშნულებას" htmlFor="ip-mvr" hint="მთავარი ექთანი = ექთანი + „განყოფილების ხელმძღვანელი“ (მომხმარებლები)"><select id="ip-mvr" className="select" value={v<string>('med_verifier') ?? 'both'} onChange={(e) => upd('med_verifier', e.target.value)}>
          <option value="both">მთავარი ექთანი ან ფარმაცევტი</option><option value="head_nurse">მხოლოდ მთავარი ექთანი</option><option value="pharmacist">მხოლოდ ფარმაცევტი</option></select></Field>
        <Field label="რა საჭიროებს დადასტურებას" htmlFor="ip-mv" hint="მაღალი რისკი: high-alert, კონტროლირებადი, სარეზერვო, კატალოგის გარეშე, აფთიაქიდან"><select id="ip-mv" className="select" value={v<string>('med_verification')} onChange={(e) => upd('med_verification', e.target.value)}>
          <option value="high_risk">მხოლოდ მაღალი რისკის</option><option value="all">ყველა მედიკამენტი</option><option value="off">გამორთული</option></select></Field>
        <Field label="დოზის ზღვრის გადაჭარბება" htmlFor="ip-dr"><select id="ip-dr" className="select" value={v<string>('dose_rule')} onChange={(e) => upd('dose_rule', e.target.value)}>
          <option value="warn">გაფრთხილება (დასაბუთებით)</option><option value="block">აკრძალულია</option></select></Field>
        <Field label="მძიმე ურთიერთქმედება" htmlFor="ip-ir"><select id="ip-ir" className="select" value={v<string>('interaction_rule')} onChange={(e) => upd('interaction_rule', e.target.value)}>
          <option value="warn">გაფრთხილება (დასაბუთებით)</option><option value="block">აკრძალულია</option></select></Field>
        {num('antibiotic_default_days', 'ანტიბიოტიკი — ნაგულისხმევი დღეები', 1, 60, 'ხანგრძლივობა სავალდებულოა; დასრულებამდე 24 სთ — შეხსენება')}
        {num('weight_max_age_days', 'წონის აქტუალობა (დღე)', 1, 90, 'ძველ წონაზე — გაფრთხილება')}
        {num('verbal_confirm_hours', 'ზეპირის დადასტურების ვადა (სთ)', 1, 168)}
        {chk('verbal_orders', 'ზეპირი / სატელეფონო დანიშნულება', 'ექთანი შეიყვანს ექიმის სახელით, ექიმი ადასტურებს')}
      </div>
      <h3 style={{ margin: '6px 0 0' }}>მედიკამენტების მიღების ფურცელი (MAR)</h3>
      <div style={grid}>
        {num('mar_window_min', 'დროის ფანჯარა (± წთ)', 15, 240, 'ფანჯრის გარეთ — ადრე / დაგვიანებით, მიზეზით')}
        {num('mar_missed_hours', 'გამოტოვებულად ჩათვლა (სთ)', 1, 24, 'ფანჯრის შემდეგ — შეტყობინება ექთნებს და მკურნალ ექიმს')}
        {num('mar_horizon_hours', 'განრიგი წინასწარ (სთ)', 12, 96)}
        <Field label="შტრიხკოდის სკანირება" htmlFor="ip-mb" hint="სამაჯური (ჰოსპ. №) + მედიკამენტის შეფუთვა (GS1)"><select id="ip-mb" className="select" value={v<string>('mar_barcode')} onChange={(e) => upd('mar_barcode', e.target.value)}>
          <option value="optional">არასავალდებულო</option><option value="required">სავალდებულო</option><option value="off">გამორთული</option></select></Field>
        {chk('mar_stock_deduct', 'მიცემისას მარაგის ჩამოწერა', 'განყოფილების ქვესაწყობიდან პაციენტზე (FEFO), ინვოისი — საწყობის პარამეტრით')}
        {chk('mar_allow_no_stock', 'მიცემა ნაშთის გარეშე (მიზეზით)', 'გამორთულისას — ნაშთი სავალდებულოა')}
        {chk('mar_double_check', 'მაღალი რისკი — მეორე ექთანი', 'high-alert მედიკამენტზე მეორე თანამშრომლის პაროლით დადასტურება')}
      </div>
      <h3 style={{ margin: '6px 0 0' }}>საექთნო დოკუმენტაცია</h3>
      <div style={grid}>
        {chk('news2_enabled', 'NEWS2 (16 წლიდან)', 'ადრეული გაფრთხილების ქულა ვიტალებიდან — მხოლოდ მინიშნება')}
        {num('news2_alert', 'NEWS2 შეტყობინება ≥', 1, 20, 'მკურნალ ექიმს და მთავარ ექთანს; ერთ პარამეტრზე 3 — ასევე')}
        {num('news2_urgent', 'NEWS2 სასწრაფო ≥', 1, 20)}
        <Field label="გლუკოზა — ნორმა (მმოლ/ლ)" htmlFor="ip-gl"><div className="row" style={{ gap: 6 }}>
          <input id="ip-gl" className="input mono" type="number" step="0.1" value={v<number>('glucose_low') ?? ''} onChange={(e) => upd('glucose_low', Number(e.target.value))} />
          <span>–</span><input aria-label="გლუკოზა ზედა" className="input mono" type="number" step="0.1" value={v<number>('glucose_high') ?? ''} onChange={(e) => upd('glucose_high', Number(e.target.value))} /></div></Field>
        <Field label="ბალანსის დღის დასაწყისი" htmlFor="ip-fd"><input id="ip-fd" className="input" type="time" value={v<string>('fluid_day_start') ?? '08:00'} onChange={(e) => upd('fluid_day_start', e.target.value)} /></Field>
        <Field label="ცვლების დასაწყისი" htmlFor="ip-sh" hint="მძიმით, მაგ. 08:00, 20:00"><input id="ip-sh" className="input mono" value={(v<string[]>('shift_times') ?? []).join(', ')}
          onChange={(e) => upd('shift_times', e.target.value.split(',').map((x) => x.trim()).filter(Boolean))} /></Field>
        {chk('scale_reminders', 'შკალების შეხსენება', 'Morse / Braden — 24 სთ-ში და პერიოდულად; ვადის გასვლაზე — ექთნებს')}
        <Field label="პერიფ. კათეტერი — შეხსენება (სთ)" htmlFor="ip-pvc" hint="0 — გამორთული"><input id="ip-pvc" className="input mono" type="number" min={0} value={v<Record<string, number>>('line_alert_hours')?.pvc ?? 0}
          onChange={(e) => upd('line_alert_hours', { ...(v<Record<string, number>>('line_alert_hours') ?? {}), pvc: Number(e.target.value) || 0 })} /></Field>
        <Field label="შარდის კათეტერი — შეხსენება (სთ)" htmlFor="ip-uc" hint="0 — გამორთული"><input id="ip-uc" className="input mono" type="number" min={0} value={v<Record<string, number>>('line_alert_hours')?.urinary ?? 0}
          onChange={(e) => upd('line_alert_hours', { ...(v<Record<string, number>>('line_alert_hours') ?? {}), urinary: Number(e.target.value) || 0 })} /></Field>
      </div>
      <h3 style={{ margin: '6px 0 0' }}>ექიმის ჩანაწერები, კონსულტაციები, ფორმა 100</h3>
      <div style={grid}>
        {num('admission_note_hours', 'მიმღები გასინჯვა — ვადა (სთ)', 1, 72, 'ვადის გასვლაზე — მკურნალ ექიმს')}
        {chk('progress_note_daily', 'დღიური ყოველდღე', 'აკლია — გაფრთხილება ჰოსპიტალიზაციაზე და გაწერისას')}
        <Field label="დღიურის შეხსენება (გუშინდელი)" htmlFor="ip-pr"><input id="ip-pr" className="input" type="time" value={v<string>('progress_reminder_time') ?? '12:00'} onChange={(e) => upd('progress_reminder_time', e.target.value)} /></Field>
        {(['routine', 'urgent', 'emergency'] as const).map((k) => <Field key={k} label={`კონსულტაციის ვადა — ${k === 'routine' ? 'გეგმიური' : k === 'urgent' ? 'სასწრაფო' : 'გადაუდებელი'} (სთ)`} htmlFor={`ip-cd-${k}`}>
          <input id={`ip-cd-${k}`} className="input mono" type="number" min={0.25} step={0.25} value={v<Record<string, number>>('consult_due_hours')?.[k] ?? ''}
            onChange={(e) => upd('consult_due_hours', { routine: 24, urgent: 2, emergency: 1, ...(v<Record<string, number>>('consult_due_hours') ?? {}), [k]: Number(e.target.value) })} /></Field>)}
        {chk('consult_billing', 'კონსულტაციის ინვოისში დამატება', 'კონსულტანტის კონსულტაციის ტარიფით (მომხმარებლის პროფილი)')}
        <Field label="ფორმა 100 გაწერისას" htmlFor="ip-f1"><select id="ip-f1" className="select" value={v<string>('form100_on_discharge') ?? 'warn'} onChange={(e) => upd('form100_on_discharge', e.target.value)}>
          <option value="warn">გაფრთხილება, თუ არ არის გაცემული</option><option value="off">გამორთული</option></select></Field>
      </div>
      <h3 style={{ margin: '6px 0 0' }}>ბილინგი</h3>
      <div style={grid}>
        <Field label="დავალიანება გაწერისას" htmlFor="ip-db"><select id="ip-db" className="select" value={v<string>('discharge_balance') ?? 'warn'} onChange={(e) => upd('discharge_balance', e.target.value)}>
          <option value="warn">შეხსენება (დასაბუთების გარეშე)</option><option value="block">დასაბუთებით</option><option value="off">გამორთული</option></select></Field>
        {num('deposit_alert_amount', 'ავანსის გადაჭარბების შეხსენება (₾)', 0, 1000000, '0 — გამორთული; ბილინგს, დღეში ერთხელ')}
        <Field label="თანხებს ხედავს (ექიმი / ექთანი)" htmlFor="ip-av"><select id="ip-av" className="select" value={v<string>('billing_amounts_visible') ?? 'heads'} onChange={(e) => upd('billing_amounts_visible', e.target.value)}>
          <option value="heads">მხოლოდ განყოფილების ხელმძღვანელი</option><option value="all">ყველა</option><option value="billing_only">არავინ (მხოლოდ ბილინგი / სალარო)</option></select></Field>
        {chk('staff_add_services', 'მომსახურებას ამატებს ექიმი / ექთანი', 'განყოფილების თანამშრომელი, ტარიფების ცნობარიდან')}
      </div>
      <span className="small">საწოლდღის ტარიფები, პაკეტები, გადამხდელები, DRG — <Link to="/admin/billing">ადმინისტრირება → სტაციონარის ბილინგი</Link>.</span>
      <span className="small">სიხშირეები (საათები) — <Link to="/admin/frequencies">ადმინისტრირება → სიხშირეები</Link>.</span>
      <span className="small">საწოლფონდი — <Link to="/admin/beds">ადმინისტრირება → საწოლფონდი</Link>; პრინტერები — <Link to="/admin/printers">პრინტერები</Link>; ეპიკრიზის, თანხმობების და ხელწერილის ტექსტები — <Link to="/admin/templates">დოკუმენტების შაბლონები</Link>; სხვა კლინიკები — <Link to="/admin/institutions">ცნობარი</Link>.</span>
    </div>
  );
}

/** რეანიმაცია / ინტენსიური (0047) */
const LAB_KEYS: [string, string][] = [['platelets', 'თრომბოციტები'], ['wbc', 'ლეიკოციტები'], ['hct', 'ჰემატოკრიტი'], ['bilirubin', 'ბილირუბინი'], ['creatinine', 'კრეატინინი'], ['sodium', 'ნატრიუმი'],
  ['potassium', 'კალიუმი'], ['ph', 'pH (ABG)'], ['pao2', 'pO₂ (ABG)'], ['paco2', 'pCO₂ (ABG)'], ['hco3', 'HCO₃⁻'], ['be', 'BE'], ['lactate', 'ლაქტატი'], ['sao2', 'SO₂'], ['fio2', 'FiO₂']];
const VASO: [string, string][] = [['norepinephrine', 'ნორეპინეფრინი'], ['epinephrine', 'ეპინეფრინი'], ['dopamine', 'დოფამინი'], ['dobutamine', 'დობუტამინი'], ['vasopressin', 'ვაზოპრესინი']];
function IcuSettings({ s, set }: { s: Record<string, unknown>; set: (v: Record<string, unknown>) => void }) {
  const v = <T,>(k: string) => s[k] as T;
  const upd = (k: string, val: unknown) => set({ ...s, [k]: val });
  const tariffs = useQuery({ queryKey: ['tariffs', 'all'], queryFn: () => api<{ id: string; code: string; title: string; base_price: string; is_active: boolean }[]>('/tariffs') });
  const chk = (k: string, label: string, hint?: string) => <label className="row" style={{ alignItems: 'flex-start' }}><input type="checkbox" checked={!!v<boolean>(k)} onChange={(e) => upd(k, e.target.checked)} />
    <span>{label}{hint && <div className="small muted">{hint}</div>}</span></label>;
  const num = (k: string, label: string, min: number, max: number, hint?: string) => <Field label={label} htmlFor={`icu-${k}`} hint={hint}>
    <input id={`icu-${k}`} className="input mono" type="number" min={min} max={max} value={v<number>(k) ?? ''} onChange={(e) => upd(k, Number(e.target.value))} /></Field>;
  const time = (k: string, label: string, hint?: string) => <Field label={label} htmlFor={`icu-${k}`} hint={hint}><input id={`icu-${k}`} className="input" type="time" value={v<string>(k) ?? ''} onChange={(e) => upd(k, e.target.value)} /></Field>;
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 14 } as const;
  const feats = v<IcuFeature[]>('intensive_features') ?? [];
  const lab = v<Record<string, string>>('lab_map') ?? {}; const vaso = v<Record<string, string[]>>('vasoactive') ?? {};
  return (
    <div className="stack">
      <div style={grid}>
        <Field label="მონიტორინგის ფურცლის ინტერვალი" htmlFor="icu-mi" hint="განყოფილებაზე შეიძლება საკუთარი; პაციენტზე — დროებით (ექიმი)"><select id="icu-mi" className="select" value={v<number>('monitor_interval_min')} onChange={(e) => upd('monitor_interval_min', Number(e.target.value))}>
          <option value={15}>15 წთ</option><option value={30}>30 წთ</option><option value={60}>60 წთ</option></select></Field>
        {num('fast_interval_max_hours', 'ხშირი რეჟიმი პაციენტზე — მაქს. (სთ)', 1, 72)}
        {num('monitor_gap_hours', 'შეხსენება: ფურცელი შეუვსებელია (სთ)', 1, 24, 'განყოფილების ექთნებს')}
        {time('bundle_reminder_time', 'bundle-ის შეხსენება (დრო)', 'VAP / CLABSI — დღეს არ შემოწმებულა')}{time('sofa_reminder_time', 'SOFA-ს შეხსენება (დრო)', 'ექიმებს — დღეს არ დადასტურებულა')}
        {num('readmit_hours', 'ხელახლა შემოსვლა (სთ)', 1, 720, 'სტატისტიკა')}
      </div>
      <div style={grid}>
        {chk('infusion_to_balance', 'ინფუზიების მოცულობა → ბალანსი', 'უწყვეტი ინფუზია — საათობრივად, ავტომატურად')}
        {chk('titration_reason', 'ტიტრაციისას მიზეზი სავალდებულოა', 'MAR: სიჩქარის ცვლილება')}
        {chk('news2_alerts', 'NEWS2 შეტყობინებები რეანიმაციაშიც', 'ნაგულისხმევად გამორთული — მუდმივი მონიტორინგი')}
      </div>
      <div className="stack" style={{ gap: 6 }}>
        <span className="label">ინტენსიური პალატის ფუნქციები (ნაგულისხმევი; რეანიმაციაში — ყველა)</span>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>{ALL_FEATURES.map((f) => <label key={f} className="row small"><input type="checkbox" checked={feats.includes(f)}
          onChange={(e) => upd('intensive_features', e.target.checked ? [...feats, f] : feats.filter((x) => x !== f))} /> {FEATURE_KA[f]}</label>)}</div>
      </div>
      <div style={grid}>
        {chk('vent_billing', 'ვენტილაციის დღის ბილინგი', 'ინვაზიური, შუაღამის წესით; ტარიფის გარეშე — ფინალიზაცია იბლოკება')}
        <Field label="ვენტილაციის დღის ტარიფი" htmlFor="icu-vt"><select id="icu-vt" className="select" value={v<string | null>('vent_day_tariff_id') ?? ''} onChange={(e) => upd('vent_day_tariff_id', e.target.value || null)}>
          <option value="">— არ არის —</option>{(tariffs.data ?? []).filter((t) => t.is_active || t.id === v<string | null>('vent_day_tariff_id')).map((t) => <option key={t.id} value={t.id}>{t.code} — {t.title} ({Number(t.base_price).toFixed(2)} ₾)</option>)}</select></Field>
      </div>
      <details><summary className="label">SOFA / APACHE: ლაბ. ანალიტები (სერვისის კოდი:ანალიტის კოდი) და ვაზოპრესორების სახელები</summary>
        <div style={{ ...grid, gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', marginTop: 10 }}>
          {LAB_KEYS.map(([k, l]) => <Field key={k} label={l} htmlFor={`icu-lab-${k}`}><input id={`icu-lab-${k}`} className="input mono" value={lab[k] ?? ''} placeholder="LAB_X:CODE"
            onChange={(e) => upd('lab_map', { ...lab, [k]: e.target.value.trim() })} /></Field>)}
        </div>
        <div style={{ ...grid, gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', marginTop: 10 }}>
          {VASO.map(([k, l]) => <Field key={k} label={l} htmlFor={`icu-va-${k}`} hint="მძიმით — INN / სავაჭრო"><input id={`icu-va-${k}`} className="input" defaultValue={(vaso[k] ?? []).join(', ')}
            onBlur={(e) => upd('vasoactive', { ...vaso, [k]: e.target.value.split(',').map((x) => x.trim()).filter((x) => x.length >= 3) })} /></Field>)}
        </div>
      </details>
      <span className="small">bundle-ის პუნქტები და APACHE II-ის კატეგორიები — <Link to="/admin/icu">ადმინისტრირება → რეანიმაცია</Link>.</span>
    </div>
  );
}

// 0048: საოპერაციო ბლოკი — კლინიკის არჩევანი
function OrSettingsCard({ s, set }: { s: Record<string, unknown>; set: (v: Record<string, unknown>) => void }) {
  const v = <T,>(k: string) => s[k] as T;
  const upd = (k: string, val: unknown) => set({ ...s, [k]: val });
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 14 } as const;
  const radio = (k: string, label: string, opts: [string, string, string][]) => (
    <div className="stack" style={{ gap: 6 }}><span className="label">{label}</span>
      {opts.map(([val, l, hint]) => <label key={val} className="row" style={{ alignItems: 'flex-start' }}><input type="radio" name={`or-${k}`} checked={v<string>(k) === val} onChange={() => upd(k, val)} />
        <span>{l}<div className="small muted">{hint}</div></span></label>)}</div>);
  const num = (k: string, label: string, min: number, max: number, hint?: string) => <Field label={label} htmlFor={`or-${k}`} hint={hint}>
    <input id={`or-${k}`} className="input mono" type="number" min={min} max={max} value={v<number>(k) ?? ''} onChange={(e) => upd(k, Number(e.target.value))} /></Field>;
  return (
    <div className="stack">
      <div style={grid}>
        {radio('or_scheduling', 'ვინ გეგმავს', [['coordinator', 'კოორდინატორი', 'ოთახს / დროს ანიჭებს კოორდინატორი; ქირურგი — მოთხოვნა'],
          ['surgeon_self', 'ქირურგი — თავისუფალ სლოტზე', 'დაშვებულ ოთახებში (სპეციალობა, საათები, გადაფარვა — მკაცრად)'],
          ['both', 'ორივე', 'ქირურგი — წინასწარი ჯავშანი („დასადასტურებელი“), კოორდინატორი ადასტურებს / გადაიტანს']])}
        {radio('anesthesia_team_by', 'ანესთეზიის გუნდს ნიშნავს', [['anesthesia_head', 'ანესთეზიოლოგიის ხელმძღვანელი', 'ქირურგი — სასურველ ანესთეზიოლოგს მიუთითებს'],
          ['surgeon', 'ქირურგი / განყოფილების ხელმძღვანელი', '']])}
        {radio('preop_readiness', 'წინასაოპერაციო მზადყოფნა', [['warn', 'გაფრთხილება', 'არასრულზე — ოპერაცია დაიწყება დასაბუთებით'], ['block', 'ბლოკი', 'არასრულზე ოპერაცია ვერ დაიწყება']])}
      </div>
      <div style={grid}>
        {num('turnover_min', 'მომზადების დრო ოპერაციებს შორის (წთ)', 0, 180, 'ოთახის გადაფარვის შემოწმებისას')}
        {num('default_duration_min', 'ნაგულისხმევი ხანგრძლივობა (წთ)', 5, 1440, 'თუ პროცედურას არ აქვს')}
        {num('self_booking_days', 'ქირურგის ჯავშანი — მაქს. დღით ადრე', 1, 365)}
      </div>
      <label className="row"><input type="checkbox" checked={!!v<boolean>('notify_requests')} onChange={(e) => upd('notify_requests', e.target.checked)} /> ახალი მოთხოვნა — შეტყობინება კოორდინატორებს (გადაუდებელი — სასწრაფო)</label>
      <h3 style={{ margin: '6px 0 0' }}>ოპერაციის მსვლელობა</h3>
      <div style={grid}>
        {radio('nursing_team_by', 'საექთნო გუნდს ნიშნავს', [['surgeon', 'ქირურგი / განყოფილების ხელმძღვანელი', ''],
          ['or_head_nurse', 'ბლოკის მთავარი ექთანი', 'საოპერაციო ექთანი + განყოფილების ხელმძღვანელი'], ['both', 'ორივე', '']])}
        {radio('anesthesia_meds', 'ანესთეზიის მედიკამენტები', [['direct', 'პირდაპირ ჟურნალში', 'ჩამოწერა ბლოკის საწყობიდან'],
          ['orders', 'დანიშნულებით', 'CPOE → ვერიფიკაცია → MAR'], ['both', 'ორივე', '']])}
        {radio('preference_cards', 'Preference card', [['off', 'გამორთული', ''], ['procedure', 'პროცედურაზე', 'ერთი ბარათი პროცედურას'],
          ['procedure_surgeon', 'პროცედურა + ქირურგი', 'ქირურგის ბარათი, თუ არ აქვს — ზოგადი']])}
        {radio('count_mode', 'დათვლა (საფენები / ნემსები / ინსტრუმენტები)', [['off', 'გამორთული', ''], ['warn', 'გაფრთხილება', 'შეუსაბამობა — ახსნით'],
          ['block', 'ბლოკი', 'ახსნა + ხელახლა დათვლა / რენტგენი']])}
        <div className="stack" style={{ gap: 6 }}><span className="label">ოქმის სავალდებულო ველები</span>
          {([['preop_dx', 'წინასაოპ. დიაგნოზი'], ['postop_dx', 'პოსტოპ. დიაგნოზი'], ['procedures', 'პროცედურები'], ['description', 'აღწერა'],
            ['findings', 'აღმოჩენები'], ['complications', 'გართულებები'], ['blood_loss', 'სისხლის დაკარგვა']] as const).map(([k, l]) => {
            const cur = v<string[]>('note_required') ?? [];
            return <label key={k} className="row"><input type="checkbox" checked={cur.includes(k)}
              onChange={(e) => upd('note_required', e.target.checked ? [...cur, k] : cur.filter((x) => x !== k))} /> {l}</label>; })}
          <span className="small muted">შეუვსებელი — ოქმი ვერ მოიწერება, ოპერაცია ვერ დასრულდება</span></div>
        <div className="stack" style={{ gap: 6 }}><span className="label">ოთახის გუნდი</span>
          <label className="row"><input type="checkbox" checked={!!v<boolean>('room_teams')} onChange={(e) => upd('room_teams', e.target.checked)} /> დაგეგმვისას ოთახის დღის გუნდი ემატება ოპერაციას ავტომატურად</label>
          <span className="small muted">მუდმივი გუნდი + დღის ცვლილებები — „საოპერაციო → ოთახის გუნდი“</span></div>
      </div>
      <h3 style={{ margin: '6px 0 0' }}>PACU, ბილინგი, სტატისტიკა</h3>
      <div style={grid}>
        <div className="stack" style={{ gap: 6 }}>
          {num('pacu_aldrete_min', 'PACU — გამოწერის Aldrete ზღვარი (0–10)', 1, 10, 'განყოფილებაში / სხვაგან — ბოლო შეფასება ≥ ზღვარი; ICU-ში — ზღვრის გარეშე')}
          {num('first_case_tolerance_min', 'პირველი ოპერაცია — დასაშვები დაგვიანება (წთ)', 0, 120, 'სტატისტიკა: „დროული დაწყება“')}
        </div>
        <div className="stack" style={{ gap: 6 }}>
          {radio('multi_procedure_billing', 'რამდენიმე პროცედურა', [['all', 'ყველა — სრული ტარიფით', ''],
            ['primary_plus_pct', 'ძირითადი + %', 'ძირითადი — სრული, დანარჩენი — მითითებული %']])}
          {v<string>('multi_procedure_billing') === 'primary_plus_pct' && num('multi_procedure_pct', 'დამატებითი პროცედურა — % ტარიფიდან', 0, 100)}
        </div>
        <div className="stack" style={{ gap: 6 }}>
          {radio('anesthesia_billing', 'ანესთეზიის ბილინგი', [['fixed', 'ფიქსირებული (ტიპზე)', 'ერთი ტარიფი ანესთეზიის ტიპზე'],
            ['hourly', 'საათობრივი', 'დაწყება → დასრულება, დამრგვალება ზემოთ'], ['off', 'არ ერიცხება', '']])}
          {v<string>('anesthesia_billing') === 'hourly' && <Field label="დამრგვალება (წთ)" htmlFor="or-arm"><select id="or-arm" className="select" value={v<number>('anesthesia_round_min') ?? 15}
            onChange={(e) => upd('anesthesia_round_min', Number(e.target.value))}>{[15, 30, 60].map((n) => <option key={n} value={n}>{n}</option>)}</select></Field>}
        </div>
      </div>
      <span className="small muted">ტარიფები: პროცედურები — კატალოგში, ანესთეზია — <Link to="/admin/or">ადმინისტრირება → საოპერაციო → ანესთეზიის ტარიფები</Link>. ტარიფის გარეშე ოპერაცია ბლოკავს სტაციონარის ფინანსურ დახურვას. მასალები / იმპლანტები / მედიკამენტები — კატეგორიის წესით; ოთახის დრო და ქირურგის ჰონორარი — არ ერიცხება.</span>
      <span className="small">ოთახები, პროცედურების კატალოგი, ჩეკლისტები — <Link to="/admin/or">ადმინისტრირება → საოპერაციო</Link>; ოქმის შაბლონები, preference card-ები — <Link to="/or?tab=library">საოპერაციო → შაბლონები / ბარათები</Link>. WHO Time out „განაკვეთამდე“ და Sign out „დასრულებამდე“, არასტერილური ნაკრების ბლოკი, ნარკოტიკულზე მოწმე — სავალდებულოა (არაარჩევადი).</span>
    </div>
  );
}
