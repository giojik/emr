import { Field } from '../../components/ui';

/** ცვლები / მორიგეობა (0077): სამუშაო დროის წესები (warn / block), ნორმა, სხვა განყოფილება, შეტყობინებები, მორიგის ტელეფონი, კოპირება */
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
      <span className="hint">შეტყობინება მხოლოდ EMR-ის ანგარიშიან თანამშრომლებს მიდის. ცვლის შაბლონები, მორიგის როლები, როტაცია, დღესასწაულები, პოზიციები — „ცვლები და მორიგეობა → ცნობარები“.</span>
    </div>
  );
}
