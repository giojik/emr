import { Field } from '../../components/ui';
import { useWlRefs } from './types';

/** სამუშაო სიები (0081): მინიჭების წესი, შესრულება / ხელახლა გახსნა, ვადა / შეხსენება / ესკალაცია, შეტყობინებები, პაციენტი, წყაროები, მთვლელი, საწყისი გვერდი;
 *  0082: ადმინისტრაცია / ლოჯისტიკის წყაროები — განყოფილების მხარე, SLA, ვადები, რეგისტრატურის არე;
 *  0083: კლინიკური წყაროები — ექთნის არე (nurse_scope), MAR, NEWS2 (დაკვირვების სიხშირე / შეფასების ვადა), ხაზები, ჩანაწერები, საოპერაციო */
const SLA: [string, string, number][] = [['stk_approve', 'RQ — დამტკიცება', 24], ['stk_issue', 'RQ — გაცემა', 24], ['stk_receive', 'მიღება („გზაში“)', 24],
  ['stk_urgent', 'სასწრაფო RQ (სამივე ნაბიჯი)', 4], ['proc_approve', 'PR / PO — დამტკიცება', 48], ['asset_move', 'ინვენტარის გადაადგილება', 72],
  ['med_verify', 'დანიშნულების ვერიფიკაცია', 2], ['med_approve', 'ანტიბიოტიკის დამტკიცება', 4], ['doc_cosign', 'ეპიკრიზის თანახელმოწერა', 24], ['or_docs', 'ოქმი / ანესთეზიის რუკა (დასრულებიდან)', 24]];
const OBS: [string, string, number][] = [['zero', 'NEWS2 = 0', 720], ['low', 'NEWS2 1–4', 240], ['low_red', 'ერთ პარამეტრზე 3', 60], ['medium', 'NEWS2 5–6', 60], ['high', 'NEWS2 ≥ 7', 30]];
export function WorklistSettings({ s, set, enabled }: { s: Record<string, unknown>; set: (v: Record<string, unknown>) => void; enabled: boolean }) {
  const v = <T,>(k: string) => s[k] as T;
  const upd = (k: string, val: unknown) => set({ ...s, [k]: val });
  const refs = useWlRefs(enabled);
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 } as const;
  const due = (v<number[]>('due_default_hours') ?? [0, 24, 4]);
  const sources = (v<Record<string, boolean>>('sources') ?? {});
  const sla = (v<Record<string, number>>('sla_hours') ?? {});
  const obs = (v<Record<string, number>>('obs_minutes') ?? {});
  const rev = (v<{ alert?: number; urgent?: number }>('news2_review_min') ?? {});
  const num = (k: string, label: string, def: number, min: number, max: number, hint?: string) => <Field key={k} label={label} htmlFor={`wl-${k}`} hint={hint}>
    <input id={`wl-${k}`} className="input mono" type="number" min={min} max={max} value={v<number>(k) ?? def} onChange={(e) => upd(k, Number(e.target.value))} /></Field>;
  const groups = new Map<string, { code: string; name: string; who: string; module_enabled: boolean }[]>();
  for (const x of refs.data?.sources ?? []) groups.set(x.group, [...(groups.get(x.group) ?? []), x]);
  return (
    <div className="stack">
      <strong className="small">ხელით შექმნილი დავალებები</strong>
      <div style={grid}>
        <Field label="სხვისთვის მინიჭება" htmlFor="wl-as" hint="საკუთარ თავზე, განყოფილების რიგში და მორიგეზე — ყოველთვის"><select id="wl-as" className="select" value={v<string>('assign_scope') ?? 'any'} onChange={(e) => upd('assign_scope', e.target.value)}>
          <option value="any">ნებისმიერს (აუდიტით)</option><option value="department">თავის განყოფილებ(ებ)ში + სხვა განყოფილების რიგში</option><option value="managers">სხვისთვის — მხოლოდ ხელმძღვანელს (worklist_manage)</option></select></Field>
        <Field label="შესრულების კომენტარი" htmlFor="wl-dc"><select id="wl-dc" className="select" value={v<string>('done_comment') ?? 'urgent'} onChange={(e) => upd('done_comment', e.target.value)}>
          <option value="off">არჩევითი</option><option value="urgent">სავალდებულო — სასწრაფოზე</option><option value="all">სავალდებულო — ყველაზე</option></select></Field>
        <Field label="ხელახლა გახსნა (დღე)" htmlFor="wl-rd" hint="შემქმნელი / ხელმძღვანელი; 0 — აკრძალული"><input id="wl-rd" className="input mono" type="number" min={0} max={90} value={v<number>('reopen_days') ?? 7} onChange={(e) => upd('reopen_days', Number(e.target.value))} /></Field>
        {(['ჩვეულებრივი', 'მაღალი', 'სასწრაფო'] as const).map((l, i) => <Field key={l} label={`ნაგულისხმევი ვადა — ${l} (სთ)`} htmlFor={`wl-dd${i}`} hint="0 — ვადის გარეშე; კატეგორიის SLA უპირატესია">
          <input id={`wl-dd${i}`} className="input mono" type="number" min={0} max={2160} value={due[i] ?? 0} onChange={(e) => { const n = [...due]; n[i] = Number(e.target.value); upd('due_default_hours', n); }} /></Field>)}
        <Field label="ესკალაცია ხელმძღვანელზე (სთ ვადის შემდეგ)" htmlFor="wl-eh" hint="0 — გამორთული; მიმღები — worklist_manage (განყოფილება) + შემქმნელი"><input id="wl-eh" className="input mono" type="number" min={0} max={720} value={v<number>('escalate_hours') ?? 0} onChange={(e) => upd('escalate_hours', Number(e.target.value))} /></Field>
        <div className="stack" style={{ gap: 6, marginTop: 24, gridColumn: 'span 2' }}>
          <label className="row"><input type="checkbox" checked={v<boolean>('remind_at_due') !== false} onChange={(e) => upd('remind_at_due', e.target.checked)} /> ვადის დადგომისას — შეხსენება შემსრულებელს</label>
          <label className="row"><input type="checkbox" checked={v<boolean>('notify_assign') !== false} onChange={(e) => upd('notify_assign', e.target.checked)} /> მინიჭება / გადანაწილება — შეტყობინება მიმღებ(ებ)ს</label>
          <label className="row"><input type="checkbox" checked={v<boolean>('notify_done') !== false} onChange={(e) => upd('notify_done', e.target.checked)} /> შესრულება / გაუქმება — შეტყობინება შემქმნელს</label>
          <label className="row"><input type="checkbox" checked={v<boolean>('patient_tasks') !== false} onChange={(e) => upd('patient_tasks', e.target.checked)} /> პაციენტთან მიბმა (დავალება არ არის დანიშნულება)</label>
        </div>
      </div>
      <strong className="small">„ჩემი დავალებები“</strong>
      <div style={grid}>
        <Field label="მთვლელი (მენიუში)" htmlFor="wl-b"><select id="wl-b" className="select" value={v<string>('badge') ?? 'all'} onChange={(e) => upd('badge', e.target.value)}>
          <option value="all">ყველა ღია</option><option value="overdue">მხოლოდ ვადაგადაცილებული</option><option value="off">არ ჩანს</option></select></Field>
        <Field label="ავტომატური განახლება (წმ)" htmlFor="wl-rs"><input id="wl-rs" className="input mono" type="number" min={30} max={600} value={v<number>('refresh_seconds') ?? 60} onChange={(e) => upd('refresh_seconds', Number(e.target.value))} /></Field>
        <label className="row" style={{ marginTop: 24 }}><input type="checkbox" checked={!!v<boolean>('home_tasks')} onChange={(e) => upd('home_tasks', e.target.checked)} /> საწყისი გვერდი ყველასთვის — „ჩემი დავალებები“</label>
      </div>
      <strong className="small">ადმინისტრაცია / ლოჯისტიკის წყაროები</strong>
      <div style={grid}>
        <Field label="განყოფილების მხარე" htmlFor="wl-ds" hint="მიღება, CSSD-ის გაწვევა / ვადა, გეგმიური ჰოსპიტალიზაცია"><select id="wl-ds" className="select" value={v<string>('dept_side') ?? 'heads'} onChange={(e) => upd('dept_side', e.target.value)}>
          <option value="heads">ხელმძღვანელი (უხელმძღვანელო განყოფილებაში — ყველა წევრი)</option><option value="all">განყოფილების ყველა წევრი</option></select></Field>
        <Field label="რეგისტრატურა / სალარო" htmlFor="wl-rsc"><select id="wl-rsc" className="select" value={v<string>('reg_scope') ?? 'all'} onChange={(e) => upd('reg_scope', e.target.value)}>
          <option value="all">მთელი კლინიკა</option><option value="department">საკუთარი განყოფილება(ები) + რეპორტინგის არე</option></select></Field>
        {num('stk_expiry_days', 'მარაგის ვადა — „იწურება“ (დღე)', 30, 0, 365, '0 — მხოლოდ ვადაგასული')}
        {num('period_close_day', 'წინა თვის დახურვის ვადა (რიცხვი)', 10, 1, 28, 'მხოლოდ period_lock = on')}
        {num('claim_build_day', '„ქლეიმის გარეშე“ — თვის N რიცხვიდან', 5, 1, 28)}
        {num('ipd_finalize_days', 'ფინალიზაციის ვადა — გაწერიდან (დღე)', 3, 0, 30)}
        {num('appt_open_days', 'დაუხურავი ჩაწერა — ბოლო N დღე', 2, 0, 14, '0 — მხოლოდ დღეს')}
        {num('debt_days', 'გადახდის ნებართვის ვალი — ბოლო N დღე', 30, 1, 365)}
        {num('bi_due_hours', 'BI-ს პასუხის ვადა (სთ)', 48, 1, 168)}
      </div>
      <strong className="small">კლინიკური წყაროები (ექიმი / ექთანი)</strong>
      <div style={grid}>
        <Field label="ექთნის საქმე (MAR, შკალები, ვიტალები, გადაბარება, ICU)" htmlFor="wl-ns" hint="ცვლაში არავინ / „ცვლები“ გამორთულია → განყოფილების ყველა ექთანი"><select id="wl-ns" className="select" value={v<string>('nurse_scope') ?? 'department'} onChange={(e) => upd('nurse_scope', e.target.value)}>
          <option value="department">განყოფილების ყველა ექთანი</option><option value="on_shift">მხოლოდ ცვლაში მყოფი (D4 განრიგით)</option></select></Field>
        {num('mar_due_ahead_min', 'MAR — „ახლა შესასრულებელი“: წინ (წთ)', 60, 0, 720)}
        {num('line_review_hours', 'ხაზის / კათეტერის გადახედვა — ყოველ (სთ)', 24, 1, 168, 'line_alert_hours-ის შემდეგ; „საჭიროება შეფასდა“')}
        {num('draft_hours', 'ხელმოუწერელი ჩანაწერი — (სთ) შემდეგ', 12, 0, 168, '0 — მაშინვე')}
        {num('amb_open_days', 'დაუხურავი ამბულატორიული ვიზიტი — ბოლო N დღე', 7, 1, 90)}
        {num('or_ahead_hours', 'საოპერაციო: შეფასება / მზადყოფნა — ოპერაციამდე (სთ)', 24, 1, 168)}
        {num('pacu_long_hours', 'PACU — დიდხანს (სთ)', 4, 1, 48)}
        {([['alert', 'NEWS2 — ექიმის შეფასება (წთ)', 60], ['urgent', 'NEWS2 ≥ სასწრაფო ზღვარი — შეფასება (წთ)', 30]] as const).map(([k, l, d]) => <Field key={k} label={l} htmlFor={`wl-nr-${k}`}>
          <input id={`wl-nr-${k}`} className="input mono" type="number" min={5} max={720} value={rev[k] ?? d} onChange={(e) => upd('news2_review_min', { alert: rev.alert ?? 60, urgent: rev.urgent ?? 30, [k]: Number(e.target.value) })} /></Field>)}
      </div>
      <span className="small muted">ვიტალური ნიშნების გაზომვის სიხშირე NEWS2-ის დონით, წუთი (RCP 2017; რეანიმაციაში — მონიტორინგის ფურცელი)</span>
      <div style={grid}>
        {OBS.map(([k, l, d]) => <Field key={k} label={l} htmlFor={`wl-obs-${k}`}><input id={`wl-obs-${k}`} className="input mono" type="number" min={15} max={1440} value={obs[k] ?? d}
          onChange={(e) => upd('obs_minutes', { ...Object.fromEntries(OBS.map(([x, , y]) => [x, obs[x] ?? y])), [k]: Number(e.target.value) })} /></Field>)}
      </div>
      <span className="small muted">ვადა იქ, სადაც წყაროს თავისი არ აქვს — გაგზავნიდან, საათი (0 — ვადის გარეშე)</span>
      <div style={grid}>
        {SLA.map(([k, l, d]) => <Field key={k} label={l} htmlFor={`wl-sla-${k}`}><input id={`wl-sla-${k}`} className="input mono" type="number" min={0} max={720} value={sla[k] ?? d}
          onChange={(e) => upd('sla_hours', { ...Object.fromEntries(SLA.map(([x, , y]) => [x, sla[x] ?? y])), [k]: Number(e.target.value) })} /></Field>)}
      </div>
      <strong className="small">სისტემური წყაროები</strong>
      {!enabled ? <span className="hint">წყაროების სია ჩანს ჩართულ მოდულზე.</span> : <div style={grid}>
        {[...groups.entries()].map(([g, list]) => <div key={g} className="stack" style={{ gap: 4 }}><span className="small muted">{g}</span>
          {list.map((x) => <label key={x.code} className="row small" title={`ვის: ${x.who}`}><input type="checkbox" checked={sources[x.code] !== false} onChange={(e) => {
            const n = { ...sources }; if (e.target.checked) delete n[x.code]; else n[x.code] = false; upd('sources', n); }} /> {x.name}{!x.module_enabled && <span className="muted"> (მოდული გამორთულია)</span>}</label>)}
        </div>)}
      </div>}
      <span className="hint">სისტემური ჩანაწერი პირდაპირ წყაროდან ითვლება, მოდულის არსებული წვდომის წესით (admin-ის უფლება პასუხისმგებლობას არ ქმნის). ლოჯისტიკის წყაროები ჩნდება ლოკაციის / ობიექტის მფლობელთან — ზოგადი უფლება (საწყობის მენეჯერი …) მხოლოდ მფლობელის არარსებობისას. კლინიკური: ექიმის საქმე — მკურნალთან (არ არის — ხელმძღვანელთან / განყოფილების ექიმებთან), ექთნის — განყოფილების ექთნებთან. გამორთული წყარო „ჩემს დავალებებში“ არ ჩანს — თავის მოდულში უცვლელად რჩება.</span>
    </div>
  );
}
