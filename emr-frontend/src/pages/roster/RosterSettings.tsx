import { Field } from '../../components/ui';

/** ცვლები / მორიგეობა (0077–0080): სამუშაო დროის წესები (warn / block), ნორმა, სხვა განყოფილება, შეტყობინებები, მორიგის ტელეფონი, კოპირება */
const MODES: [string, string][] = [['warn', 'გაფრთხილება'], ['block', 'დაბლოკვა'], ['off', 'გამორთული']];
export function RosterSettings({ s, set }: { s: Record<string, unknown>; set: (v: Record<string, unknown>) => void }) {
  const v = <T,>(k: string) => s[k] as T;
  const upd = (k: string, val: unknown) => set({ ...s, [k]: val });
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 } as const;
  const rule = (num: string, mode: string, label: string, hint: string, min: number, max: number) => (
    <Field label={label} htmlFor={`rs-${num}`} hint={hint}>
      <div className="row" style={{ gap: 6 }}>
        <input id={`rs-${num}`} className="input mono" style={{ maxWidth: 90 }} type="number" min={min} max={max} value={v<number>(num) ?? 0} onChange={(e) => upd(num, Number(e.target.value))} />
        <select className="select" aria-label={`${label} — რეჟიმი`} value={v<string>(mode)} onChange={(e) => upd(mode, e.target.value)}>{MODES.map(([m, l]) => <option key={m} value={m}>{l}</option>)}</select>
      </div>
    </Field>);
  return (
    <div className="stack">
      <strong className="small">სამუშაო დროის წესები</strong>
      <div style={grid}>
        {rule('rest_min_hours', 'rest_mode', 'მინ. დასვენება ცვლებს შორის (სთ)', 'ერთმანეთზე მიბმული ცვლები — „ზედიზედ“-ში ითვლება', 0, 48)}
        {rule('max_continuous_hours', 'continuous_mode', 'მაქს. ზედიზედ საათები', 'მაგ. დღე + ღამე უწყვეტად = 24 სთ', 8, 48)}
        {rule('max_week_hours', 'week_mode', 'მაქს. საათები კვირაში', 'ISO კვირა (ორშ.–კვ.), ჩასათვლელი საათებით', 20, 120)}
        {rule('max_consecutive_nights', 'nights_mode', 'მაქს. ზედიზედ ღამის ცვლა', 'მხოლოდ „ღამის“ სახის ცვლები', 1, 14)}
      </div>
      <span className="hint">„მორიგეობა სახლიდან“ სამუშაო დროდ არ ითვლება. ერთდროულად ორ ადგილას ყოფნა ყოველთვის იბლოკება. ზღვრების ზუსტი მნიშვნელობები — HR / იურისტის დადასტურებით (შრომის კოდექსი, სამედიცინო რეჟიმი).
        „დაბლოკვა“ ჩანაწერს არ დაამატებს; „გაფრთხილება“ ჩანს ბადეში და გამოქვეყნებისას დასადასტურებელია.</span>
      <div style={grid}>
        <Field label="შევსების ნორმის ხარვეზი" htmlFor="rs-norm"><select id="rs-norm" className="select" value={v<string>('norm_mode')} onChange={(e) => upd('norm_mode', e.target.value)}>
          <option value="warn">გაფრთხილება (ბადეში + გამოქვეყნებისას)</option><option value="off">გამორთული</option></select></Field>
        <Field label="სხვა განყოფილების თანამშრომელი" htmlFor="rs-cross" hint="ძირითადი / დამატებითი განყოფილების გარეშე"><select id="rs-cross" className="select" value={v<string>('cross_department')} onChange={(e) => upd('cross_department', e.target.value)}>
          <option value="warn">დაშვებული, გაფრთხილებით</option><option value="allow">დაშვებული</option><option value="block">აკრძალული</option></select></Field>
        <Field label="მორიგის პირადი ტელეფონი „მორიგეებში“" htmlFor="rs-phone" hint="მორიგის როლის საერთო ტელეფონი ყოველთვის ჩანს"><select id="rs-phone" className="select" value={v<string>('duty_phone')} onChange={(e) => upd('duty_phone', e.target.value)}>
          <option value="all">ყველა თანამშრომელს</option><option value="staff">მხოლოდ განრიგის უფლებით</option><option value="off">არ ჩანს</option></select></Field>
        <Field label="წინა თვიდან კოპირება" htmlFor="rs-copy"><select id="rs-copy" className="select" value={v<string>('copy_mode')} onChange={(e) => upd('copy_mode', e.target.value)}>
          <option value="weekday">კვირის დღეებით (4-კვირიანი ციკლი)</option><option value="date">იგივე რიცხვით</option></select></Field>
        <div className="stack" style={{ gap: 6, marginTop: 24 }}>
          <label className="row"><input type="checkbox" checked={v<boolean>('publish_notify') !== false} onChange={(e) => upd('publish_notify', e.target.checked)} /> გამოქვეყნება — შეტყობინება თანამშრომლებს</label>
          <label className="row"><input type="checkbox" checked={v<boolean>('change_notify') !== false} onChange={(e) => upd('change_notify', e.target.checked)} /> ცვლილება გამოქვეყნების შემდეგ — შეტყობინება</label>
        </div>
      </div>
      <strong className="small">შვებულება / არყოფნა, გაცვლა, დასაფარი, სურვილები (0078)</strong>
      <div style={grid}>
        <Field label="სამუშაო დღის დათვლა" htmlFor="rs-unit" hint="„სამუშაო დღე“ ერთეულის ტიპებზე"><select id="rs-unit" className="select" value={v<string>('absence_unit_mode') ?? 'weekdays'} onChange={(e) => upd('absence_unit_mode', e.target.value)}>
          <option value="weekdays">ორშ.–პარ., დღესასწაულების გარეშე</option><option value="roster">დაგეგმილი ცვლებით (განრიგის თვეებში)</option></select></Field>
        <Field label="ბალანსის დარიცხვა" htmlFor="rs-acc" hint="მიღების / წასვლის წელს — პროპორციულად"><select id="rs-acc" className="select" value={v<string>('accrual') ?? 'annual'} onChange={(e) => upd('accrual', e.target.value)}>
          <option value="annual">წლის დასაწყისში — მთლიანად</option><option value="monthly">ყოველთვიურად (1/12)</option></select></Field>
        <Field label="ნაშთის გადაჭარბება" htmlFor="rs-over"><select id="rs-over" className="select" value={v<string>('balance_overdraw') ?? 'block'} onChange={(e) => upd('balance_overdraw', e.target.value)}>
          <option value="block">დაბლოკვა (HR — მიზეზით)</option><option value="warn">გაფრთხილება</option></select></Field>
        <Field label="გაცვლის დადასტურება" htmlFor="rs-swap"><select id="rs-swap" className="select" value={v<string>('swap_approval') ?? 'head'} onChange={(e) => upd('swap_approval', e.target.value)}>
          <option value="head">კოლეგა → განრიგის შემდგენი</option><option value="none">მხოლოდ კოლეგის თანხმობა</option></select></Field>
        <Field label="გაცვლა — მინ. წინასწარ (სთ)" htmlFor="rs-notice"><input id="rs-notice" className="input mono" type="number" min={0} max={168} value={v<number>('swap_min_notice_hours') ?? 12} onChange={(e) => upd('swap_min_notice_hours', Number(e.target.value))} /></Field>
        <Field label="„არ შემიძლია“ — გაფრთხილება ბადეში" htmlFor="rs-pm"><select id="rs-pm" className="select" value={v<string>('prefs_mode') ?? 'warn'} onChange={(e) => upd('prefs_mode', e.target.value)}>
          <option value="warn">გაფრთხილება</option><option value="off">გამორთული</option></select></Field>
        <Field label="სურვილების ვადა (წინა თვის რიცხვი)" htmlFor="rs-dl" hint="0 — ვადის გარეშე; შემდგენს არ ეხება"><input id="rs-dl" className="input mono" type="number" min={0} max={28} value={v<number>('prefs_deadline_day') ?? 0} onChange={(e) => upd('prefs_deadline_day', Number(e.target.value))} /></Field>
        <Field label="„არ შემიძლია“ — მაქს. დღე თვეში" htmlFor="rs-lim" hint="0 — შეუზღუდავი; შემდგენს არ ეხება"><input id="rs-lim" className="input mono" type="number" min={0} max={31} value={v<number>('unavailable_max_per_month') ?? 4} onChange={(e) => upd('unavailable_max_per_month', Number(e.target.value))} /></Field>
        <div className="stack" style={{ gap: 6, marginTop: 24 }}>
          <label className="row"><input type="checkbox" checked={v<boolean>('open_shift_volunteer') !== false} onChange={(e) => upd('open_shift_volunteer', e.target.checked)} /> დასაფარი — „ავიღებ“ (მოხალისე)</label>
          <label className="row"><input type="checkbox" checked={v<boolean>('open_shift_notify') !== false} onChange={(e) => upd('open_shift_notify', e.target.checked)} /> დასაფარი — შეტყობინება კოლეგებს</label>
        </div>
      </div>
      <strong className="small">საათები / ტაბელი, თვის დახურვა, კავშირები (0079)</strong>
      <div style={grid}>
        <Field label="კვირის ნორმა (სთ, FTE 1.0)" htmlFor="rs-wn" hint="დღის ნორმა = კვირის / 5 × FTE"><input id="rs-wn" className="input mono" type="number" min={20} max={60} value={v<number>('week_norm_hours') ?? 40} onChange={(e) => upd('week_norm_hours', Number(e.target.value))} /></Field>
        <Field label="ზეგანაკვეთი" htmlFor="rs-ob" hint="ფაქტი + ჩათვლილი არყოფნა − თვის ნორმა"><select id="rs-ob" className="select" value={v<string>('overtime_basis') ?? 'month'} onChange={(e) => upd('overtime_basis', e.target.value)}>
          <option value="month">თვის ნორმაზე მეტი</option><option value="off">არ ითვლება (მხოლოდ საათები)</option></select></Field>
        <Field label="ზეგანაკვეთი დახურვისას (ნაგულისხმევი)" htmlFor="rs-od" hint="HR ცვლის თითოეულ თანამშრომელზე"><select id="rs-od" className="select" value={v<string>('overtime_default') ?? 'pay'} onChange={(e) => upd('overtime_default', e.target.value)}>
          <option value="pay">ანაზღაურება</option><option value="comp">ნაცვლად დასვენება (COMP)</option></select></Field>
        <Field label="COMP — არყოფნის ტიპის კოდი" htmlFor="rs-ct" hint="ბალანსიანი ტიპი (ნაგულისხმევი COMP)"><input id="rs-ct" className="input mono" value={v<string>('comp_absence_type') ?? 'COMP'} onChange={(e) => upd('comp_absence_type', e.target.value.toUpperCase())} /></Field>
        <Field label="ღამის საათები" htmlFor="rs-nf" hint="შრომის კოდექსი: 22:00–06:00"><div className="row" style={{ gap: 6 }}>
          <input id="rs-nf" className="input mono" type="time" value={v<string>('night_from') ?? '22:00'} onChange={(e) => upd('night_from', e.target.value)} />
          <input className="input mono" type="time" aria-label="ღამის საათების დასასრული" value={v<string>('night_to') ?? '06:00'} onChange={(e) => upd('night_to', e.target.value)} /></div></Field>
        <div className="stack" style={{ gap: 6, marginTop: 24 }}>
          <label className="row"><input type="checkbox" checked={v<boolean>('close_requires_submit') !== false} onChange={(e) => upd('close_requires_submit', e.target.checked)} /> დახურვამდე — შემდგენის წარდგენა</label>
        </div>
        <Field label="კონსულტაცია — მორიგე ექიმი" htmlFor="rs-lc"><select id="rs-lc" className="select" value={v<string>('link_consult') ?? 'hint'} onChange={(e) => upd('link_consult', e.target.value)}>
          <option value="hint">მოთხოვნისას ჩანს</option><option value="duty">ჩანს + სასწრაფო — მხოლოდ მორიგეს</option><option value="off">გამორთული</option></select></Field>
        <Field label="ბიომედი — მორიგე ინჟინერი" htmlFor="rs-lb"><select id="rs-lb" className="select" value={v<string>('link_bme') ?? 'hint'} onChange={(e) => upd('link_bme', e.target.value)}>
          <option value="hint">შეკეთებაზე ჩანს</option><option value="duty">ჩანს + P1 / უსაფრთხოება: SMS / ელფოსტა — მხოლოდ მორიგეს</option><option value="off">გამორთული</option></select></Field>
        <Field label="საოპერაციოს გუნდი" htmlFor="rs-lo" hint="გუნდში დამატებისას — დასადასტურებელი გაფრთხილება"><select id="rs-lo" className="select" value={v<string>('link_or') ?? 'absence'} onChange={(e) => upd('link_or', e.target.value)}>
          <option value="absence">არყოფნა (+ დღის გუნდში ავტომატურად არ ემატება)</option><option value="absence_shift">არყოფნა + „განრიგში ცვლა არ აქვს“</option><option value="off">გამორთული</option></select></Field>
        <Field label="პაციენტი / ექთანი — ზღვარი" htmlFor="rs-nr" hint="პალატა / ინტენსიური / რეანიმაცია; ინფორმაციული"><div className="row" style={{ gap: 6 }}>
          {(['ward', 'intensive', 'icu'] as const).map((k, i) => { const r = (v<Record<string, number>>('nurse_ratio') ?? { ward: 8, intensive: 4, icu: 2 }); return (
            <input key={k} id={i === 0 ? 'rs-nr' : undefined} className="input mono" type="number" min={1} max={50} style={{ maxWidth: 70 }} aria-label={`ზღვარი — ${k}`} value={r[k] ?? 8}
              onChange={(e) => upd('nurse_ratio', { ...r, [k]: Number(e.target.value) })} />); })}</div></Field>
      </div>
      <span className="hint">ნორმა / ზეგანაკვეთის განმარტება — HR / იურისტის დადასტურებით (შრომის კოდექსი; სპეციფიკური რეჟიმი — 48 სთ). კავშირები მხოლოდ გამოქვეყნებულ განრიგს ეყრდნობა და ინფორმაციულია — გადაწყვეტილებას იღებს მომხმარებელი.</span>
      <strong className="small">ანგარიშები / KPI (0080)</strong>
      <div style={grid}>
        <Field label="ნორმის შესრულება — „ნაკლები“ (%)" htmlFor="rs-low" hint="ამაზე დაბალი — ჩანს სიაში"><input id="rs-low" className="input mono" type="number" min={50} max={100} value={v<number>('rpt_norm_low_pct') ?? 90} onChange={(e) => upd('rpt_norm_low_pct', Number(e.target.value))} /></Field>
        <Field label="ქრონიკული ზეგანაკვეთი — თვე (6-დან)" htmlFor="rs-chr" hint="ბოლო 6 დახურული თვიდან ≥ N-ში"><input id="rs-chr" className="input mono" type="number" min={1} max={6} value={v<number>('rpt_chronic_ot_months') ?? 3} onChange={(e) => upd('rpt_chronic_ot_months', Number(e.target.value))} /></Field>
        <Field label="დასაფარი — „მალე იწყება“ (სთ)" htmlFor="rs-urg" hint="„ყურადღება“ — ღიაა და ამ საათებში იწყება"><input id="rs-urg" className="input mono" type="number" min={1} max={168} value={v<number>('rpt_open_urgent_hours') ?? 24} onChange={(e) => upd('rpt_open_urgent_hours', Number(e.target.value))} /></Field>
        <Field label="ტაბელი დაუხურავია — დღე თვის შემდეგ" htmlFor="rs-late" hint="„ყურადღება“"><input id="rs-late" className="input mono" type="number" min={0} max={60} value={v<number>('rpt_close_late_days') ?? 5} onChange={(e) => upd('rpt_close_late_days', Number(e.target.value))} /></Field>
        <Field label="მინ. ჯგუფი (ადამიანი)" htmlFor="rs-mg" hint="აგრეგატულ ხედვაში ამაზე მცირე ჯგუფის ბიულეტენი ცალკე არ ჩანს"><input id="rs-mg" className="input mono" type="number" min={1} max={20} value={v<number>('rpt_min_group') ?? 3} onChange={(e) => upd('rpt_min_group', Number(e.target.value))} /></Field>
        <Field label="ბიულეტენის ტიპ(ებ)ის კოდი" htmlFor="rs-sick" hint="მძიმით, მაგ. SICK"><input id="rs-sick" className="input mono" value={(v<string[]>('rpt_sick_types') ?? ['SICK']).join(', ')}
          onChange={(e) => upd('rpt_sick_types', e.target.value.toUpperCase().split(/[,\s]+/).filter(Boolean))} /></Field>
        <Field label="მენეჯერული დაფა — KPI / „ყურადღება“" htmlFor="rs-dv"><select id="rs-dv" className="select" value={v<string>('dashboard_visibility') ?? 'report_users'} onChange={(e) => upd('dashboard_visibility', e.target.value)}>
          <option value="report_users">დაფის ყველა მომხმარებელს</option><option value="roster_only">მხოლოდ განრიგის / HR უფლებით</option></select></Field>
        <div className="stack" style={{ gap: 6, marginTop: 24 }}>
          <label className="row"><input type="checkbox" checked={v<boolean>('monthly_section') !== false} onChange={(e) => upd('monthly_section', e.target.checked)} /> თვიურ ანგარიშში — სექცია „პერსონალი / ცვლები“</label>
          <label className="row"><input type="checkbox" checked={v<boolean>('rpt_bradford') === true} onChange={(e) => upd('rpt_bradford', e.target.checked)} /> Bradford factor (ბიულეტენი, S² × D) — HR-ის გადაწყვეტილებით</label>
        </div>
      </div>
      <span className="hint">შეტყობინება მხოლოდ EMR-ის ანგარიშიან თანამშრომლებს მიდის. ცვლის შაბლონები, მორიგის როლები, როტაცია, დღესასწაულები, პოზიციები — „ცვლები და მორიგეობა → ცნობარები“.</span>
    </div>
  );
}
