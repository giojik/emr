import { Field } from '../../components/ui';
import { useErMeta } from './Er';
import { ErFeeRules } from './ErFeeRules';

const SECTIONS: [string, string][] = [['arrival', 'შემოსვლა'], ['triage', 'ტრიაჟი'], ['notes', 'ჩანაწერები'], ['diagnoses', 'დიაგნოზი'], ['lab', 'ლაბორატორია'],
  ['dx', 'ინსტრუმენტული'], ['consults', 'კონსულტაციები'], ['orders', 'მკურნალობა'], ['disposition', 'გამოსავალი'], ['recommendations', 'რეკომენდაციები']];

/** ადმინისტრირება → მოდულები → გადაუდებელი დახმარება (0087): პარამეტრები */
export function ErSettings({ s, set }: { s: Record<string, unknown>; set: (v: Record<string, unknown>) => void }) {
  const meta = useErMeta();
  const upd = (k: string, v: unknown) => set({ ...s, [k]: v });
  const int = (k: string, d: number, min: number, max: number) => (
    <input id={`er-${k}`} className="input mono" type="number" min={min} max={max} value={Number(s[k] ?? d)} onChange={(e) => upd(k, Math.max(min, Math.min(max, Math.round(Number(e.target.value) || min))))} />);
  const sel = (k: string, label: string, d: string, opts: [string, string][], hint?: string) => (
    <Field label={label} htmlFor={`er-${k}`} hint={hint}><select id={`er-${k}`} className="select" value={String(s[k] ?? d)} onChange={(e) => upd(k, e.target.value)}>
      {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>);
  const chk = (k: string, label: string, hint?: string) => <label className="row small" title={hint}><input type="checkbox" checked={!!s[k]} onChange={(e) => upd(k, e.target.checked)} /> {label}</label>;
  return (
    <div className="stack">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 14 }}>
        <Field label="ტრიაჟის შკალა (ნაგულისხმევი)" htmlFor="er-ts" hint="დონეები / ფერები / სამიზნე დრო — ადმინისტრირება → გადაუდებელი (ER)">
          <select id="er-ts" className="select" value={String(s.triage_scale ?? 'ESI')} onChange={(e) => upd('triage_scale', e.target.value)}>
            {(meta.data?.scales ?? [{ code: String(s.triage_scale ?? 'ESI'), name: String(s.triage_scale ?? 'ESI'), is_active: true }]).filter((x) => x.is_active).map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}</select></Field>
        <Field label="სამიზნე: კარი → ტრიაჟი (წთ)" htmlFor="er-triage_target_min" hint="1–120">{int('triage_target_min', 10, 1, 120)}</Field>
        <Field label="ექიმის აყვანა ტრიაჟამდე" htmlFor="er-dbt"><select id="er-dbt" className="select" value={String(s.doctor_before_triage ?? 'allow')} onChange={(e) => upd('doctor_before_triage', e.target.value)}>
          <option value="allow">დაშვებულია (რეანიმაციული)</option><option value="block">აკრძალულია — ჯერ ტრიაჟი</option></select></Field>
        <Field label="სასწრაფოს ველები (ბრიგადა)" htmlFor="er-af"><select id="er-af" className="select" value={String(s.ambulance_fields ?? 'optional')} onChange={(e) => upd('ambulance_fields', e.target.value)}>
          <option value="optional">არასავალდებულო</option><option value="required">ბრიგადის № სავალდებულო</option></select></Field>
        <Field label="დაფის განახლება (წმ)" htmlFor="er-board_refresh_sec" hint="10–300">{int('board_refresh_sec', 30, 10, 300)}</Field>
        <Field label="TV ეკრანზე პაციენტი" htmlFor="er-tvn" hint="კედლის ეკრანი — პერსონალური მონაცემი"><select id="er-tvn" className="select" value={String(s.tv_patient_names ?? 'initials')} onChange={(e) => upd('tv_patient_names', e.target.value)}>
          <option value="initials">ინიციალები</option><option value="full">სრული სახელი</option></select></Field>
        <h3 style={{ gridColumn: '1 / -1', margin: '6px 0 0' }}>კლინიკური ნაწილი (0088)</h3>
        <Field label="პირველადი ჩანაწერი — აყვანიდან (წთ)" htmlFor="er-initial_note_min" hint="10–720; ვადის გადაცილება — ნიშანი დაფაზე">{int('initial_note_min', 60, 10, 720)}</Field>
        <Field label="ვინ წერს ER-ის შემთხვევაში" htmlFor="er-dw" hint="ჩანაწერი, ICD-10, დიაგნოსტიკა, კონსულტაცია">
          <select id="er-dw" className="select" value={String(s.doctor_write ?? 'team')} onChange={(e) => upd('doctor_write', e.target.value)}>
            <option value="team">ნებისმიერი ER-ის ექიმი (გუნდი)</option><option value="attending">მხოლოდ მკურნალი (აყვანილი) ექიმი</option></select></Field>
        <Field label="დიაგნოსტიკა — გადაუხდელობა" htmlFor="er-up" hint="ნიმუშის აღება / მისვლა / პროცედურა ER-ის პაციენტზე">
          <select id="er-up" className="select" value={String(s.dx_unpaid_check ?? 'skip')} onChange={(e) => upd('dx_unpaid_check', e.target.value)}>
            <option value="skip">არ მოწმდება (ER — გადახდა შემდეგ)</option><option value="ack">დადასტურებით (როგორც სხვა ვიზიტზე)</option></select></Field>
        <Field label="კვლევის ნაგულისხმევი პრიორიტეტი" htmlFor="er-dp"><select id="er-dp" className="select" value={String(s.dx_default_priority ?? 'urgent')} onChange={(e) => upd('dx_default_priority', e.target.value)}>
          <option value="urgent">სასწრაფო (cito)</option><option value="routine">ჩვეულებრივი</option></select></Field>
        {(['emergency', 'urgent', 'routine'] as const).map((k) => {
          const cur = (s.consult_due_min as Record<string, number> | undefined) ?? { routine: 240, urgent: 60, emergency: 30 };
          const label = { emergency: 'გადაუდებელი', urgent: 'სასწრაფო', routine: 'გეგმიური' }[k];
          return <Field key={k} label={`კონსულტაციის ვადა — ${label} (წთ)`} htmlFor={`er-cd-${k}`} hint="5–2880">
            <input id={`er-cd-${k}`} className="input mono" type="number" min={5} max={2880} value={Number(cur[k] ?? 60)}
              onChange={(e) => upd('consult_due_min', { ...cur, [k]: Math.max(5, Math.min(2880, Math.round(Number(e.target.value) || 5))) })} /></Field>;
        })}
        <div className="stack" style={{ gap: 6, gridColumn: '1 / -1' }}>
          {chk('retriage_alert', 'განმეორებითი ტრიაჟის ვადა დაფაზე', 'დონის ინტერვალით, ექიმის აყვანამდე')}
          {chk('news2_hint', 'NEWS2 — მინიშნება ტრიაჟისას (16 წლიდან)', 'დონეს ირჩევს ადამიანი; სისტემა ავტომატურად არ ანიჭებს')}
          {chk('show_on_duty', 'დაფაზე „მორიგე ექიმი ახლა“', 'საჭიროებს მოდულს „ცვლები და მორიგეობა“ (გამორთულზე — არ ჩანს)')}
          {chk('consult_billing', 'კონსულტაცია ინვოისში (კონსულტანტის ტარიფით)', 'პასუხის ხელმოწერისას — ER-ის ინვოისში (ბილინგი — 0090)')}
        </div>
        <h3 style={{ gridColumn: '1 / -1', margin: '6px 0 0' }}>დანიშვნა / მიცემა / ჩამოწერა (0089)</h3>
        <Field label="PRN დანიშნულების ვადა (სთ)" htmlFor="er-prn_max_h" hint="1–24; შემდეგ — ვადაგასული (ახალი დანიშნულება)">{int('prn_max_h', 12, 1, 24)}</Field>
        <Field label="STAT — შესრულების ვადა (წთ)" htmlFor="er-stat_due_min" hint="5–120; გადაცილება — ნიშანი დაფაზე">{int('stat_due_min', 15, 5, 120)}</Field>
        <Field label="ზეპირის დადასტურება (სთ)" htmlFor="er-verbal_confirm_h" hint="1–24; ექიმი ადასტურებს">{int('verbal_confirm_h', 4, 1, 24)}</Field>
        <Field label="დოზის ზღვრის გადაჭარბება" htmlFor="er-dr" hint="აფთიაქის მოდულით (ჯენერიკის ზღვრები)"><select id="er-dr" className="select" value={String(s.dose_rule ?? 'warn')} onChange={(e) => upd('dose_rule', e.target.value)}>
          <option value="warn">გაფრთხილება (დადასტურება)</option><option value="reason">დასაბუთებით</option></select></Field>
        <Field label="ორმაგი შემოწმება მიცემისას" htmlFor="er-dc" hint="მეორე თანამშრომელი — მომხმარებელი / პაროლი"><select id="er-dc" className="select" value={String(s.double_check ?? 'off')} onChange={(e) => upd('double_check', e.target.value)}>
          <option value="off">გამორთული</option><option value="high_alert">მაღალი რისკის მედიკამენტზე</option><option value="high_alert_controlled">მაღალი რისკი + კონტროლირებადი</option></select></Field>
        <div className="stack" style={{ gap: 6, gridColumn: '1 / -1' }}>
          {chk('verbal_orders', 'ზეპირი დანიშნულება (ექთანი — ექიმის სახელით)', 'ექიმი იღებს შეტყობინებას და ადასტურებს')}
          {chk('stock_deduct', 'მიცემისას ჩამოწერა ER-ის ქვესაწყობიდან', 'საჭიროებს მოდულს „საწყობი“ (გამორთულზე — მიცემა იწერება ჩამოწერის გარეშე)')}
          {chk('allow_no_stock', 'ნაშთის გარეშე მიცემა დაშვებულია (დასაბუთებით)', 'გამორთულზე — ნაშთის / ქვესაწყობის გარეშე მიცემა იბლოკება')}
        </div>
        <h3 style={{ gridColumn: '1 / -1', margin: '6px 0 0' }}>გამოსავალი (0090)</h3>
        {sel('admit_mode', 'ჰოსპიტალიზაცია', 'direct', [['direct', 'ER-ის ექიმი აფორმებს პირდაპირ'], ['request', 'მოთხოვნა → განყოფილება იღებს']], 'საჭიროებს მოდულს „სტაციონარი“')}
        {sel('transfer_orders', 'აქტიური დანიშნულებები ჰოსპიტალიზაციისას', 'reconcile', [['reconcile', 'გაგრძელება / შეწყვეტა (არჩევით)'], ['stop_all', 'ყველა წყდება']], 'გაგრძელება — მოდულით „დანიშნულებები“')}
        {sel('require_initial_note', 'ხელმოწერილი პირველადი გასინჯვა', 'block', [['block', 'სავალდებულო'], ['warn', 'გაფრთხილება (დასაბუთებით)'], ['off', 'არ მოწმდება']], 'LWBS — არ მოწმდება; გარდაცვალება — გაფრთხილება')}
        {sel('require_diagnosis', 'ძირითადი დიაგნოზი (ICD-10)', 'block', [['block', 'სავალდებულო'], ['warn', 'გაფრთხილება (დასაბუთებით)'], ['off', 'არ მოწმდება']])}
        {sel('verbal_unconfirmed', 'დაუდასტურებელი ზეპირი დანიშნულება', 'block', [['block', 'ბლოკავს'], ['warn', 'გაფრთხილება (დასაბუთებით)']])}
        {sel('open_items_check', 'ღია კვლევა / კონსულტაცია / ინფუზია', 'warn', [['warn', 'გაფრთხილება (დასაბუთებით)'], ['off', 'არ მოწმდება']])}
        {sel('ama_proof', 'AMA — დადასტურება', 'consent_or_witnesses', [['consent_or_witnesses', 'ხელწერილი ან 2 მოწმე'], ['reason', 'მხოლოდ მიზეზი']], 'ხელწერილის ტექსტი — დოკუმენტების შაბლონები → ER_SELF_DISCHARGE')}
        <Field label="დოკუმენტაციის ფანჯარა (სთ)" htmlFor="er-doc_window_h" hint="0–168; გამოსავლის შემდეგ — ჩანაწერი, ICD-10, ფურცლის განახლება (0 — მაშინვე იხურება)">{int('doc_window_h', 24, 0, 168)}</Field>
        <Field label="გამოსავლის გაუქმება (სთ)" htmlFor="er-reopen_h" hint="0–72; შეცდომის გასწორება — ER-ის მენეჯერი (გარდაცვალება — admin); 0 — გამორთულია">{int('reopen_h', 4, 0, 72)}</Field>
        {sel('summary_mode', 'ER-ის ფურცელი', 'builtin', [['builtin', 'სტანდარტული (სექციების არჩევით)'], ['template', 'შაბლონით (ER_SUMMARY)']], 'შაბლონი — ადმინისტრირება → დოკუმენტების შაბლონები → ER-ის ფურცელი')}
        {String(s.summary_mode ?? 'builtin') === 'builtin' && <div className="stack" style={{ gap: 6, gridColumn: '1 / -1' }}>
          <span className="small muted">ფურცლის სექციები (რიგით):</span>
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>{SECTIONS.map(([k, l]) => {
            const cur = (s.summary_sections as string[] | undefined) ?? SECTIONS.map((x) => x[0]);
            return <label key={k} className="row small"><input type="checkbox" checked={cur.includes(k)} disabled={cur.length === 1 && cur.includes(k)}
              onChange={(e) => upd('summary_sections', e.target.checked ? SECTIONS.map((x) => x[0]).filter((x) => x === k || cur.includes(x)) : cur.filter((x) => x !== k))} /> {l}</label>; })}</div>
        </div>}
        <div className="stack" style={{ gap: 6, gridColumn: '1 / -1' }}>
          {chk('recommendations_required', 'რეკომენდაციები სავალდებულოა (სახლში / გადაყვანა / AMA)')}
        </div>
        <h3 style={{ gridColumn: '1 / -1', margin: '6px 0 0' }}>ბილინგი (0091)</h3>
        {sel('fee_mode', 'ER-ის მომსახურების ტარიფი', 'visit', [['none', 'არ ერიცხება'], ['visit', 'ვიზიტზე (ერთი ტარიფი)'], ['level', 'ტრიაჟის დონით'], ['time', 'ხანგრძლივობით (ზოლები / საათი)']], 'წესები — ქვემოთ, ფასი — ტარიფებში')}
        {sel('fee_at', 'ტარიფი ერიცხება', 'departure', [['departure', 'გამოსავლისას'], ['doctor', 'ექიმის აყვანისას (ხანგრძლივობით — გამოსავლისას)']])}
        {sel('fee_level_basis', 'ტრიაჟის დონე ტარიფისთვის', 'last', [['last', 'ბოლო დონე'], ['highest', 'ყველაზე სასწრაფო დონე']])}
        {sel('admit_invoice', 'ინვოისი ჰოსპიტალიზაციისას', 'merge', [['merge', 'გაერთიანება სტაციონარისაში'], ['separate', 'ცალკე რჩება'], ['ask', 'არჩევით (ვინც აფორმებს)']], 'გადახდილი / ქლეიმში შემავალი ER-ის ინვოისი — ცალკე რჩება')}
        {sel('admit_fee', 'ER-ის ტარიფი ჰოსპიტალიზაციისას', 'charge', [['charge', 'ერიცხება'], ['exempt', 'არ ერიცხება']])}
        {sel('invoice_close', 'ER-ის ინვოისის დახურვა', 'departure', [['departure', 'გამოსავლისას'], ['doc_close', 'დოკუმენტაციის ფანჯრის ბოლოს'], ['manual', 'ხელით (ბილინგი)']])}
        {sel('unpaid_check', 'გადაუხდელი ნაშთი გამოსავლისას', 'info', [['info', 'ინფორმაცია'], ['warn', 'გაფრთხილება (დასაბუთებით)'], ['off', 'არ ჩანს']], 'გამოსავალს არასდროს ბლოკავს')}
        {sel('payer_at_registration', 'გადამხდელი რეგისტრაციისას', 'optional', [['off', 'არ ჩანს'], ['optional', 'არასავალდებულო'], ['required', 'სავალდებულო (ან თვითდაფინანსება)']])}
        <div className="stack" style={{ gap: 6, gridColumn: '1 / -1' }}>
          <span className="small muted">ტარიფი არ ერიცხება გამოსავლისას:</span>
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>{DISP.map(([k, l]) => {
            const cur = (s.fee_exempt as string[] | undefined) ?? ['lwbs'];
            return <label key={k} className="row small"><input type="checkbox" checked={cur.includes(k)} onChange={(e) => upd('fee_exempt', e.target.checked ? [...cur, k] : cur.filter((x) => x !== k))} /> {l}</label>; })}</div>
        </div>
        <div style={{ gridColumn: '1 / -1' }}><ErFeeRules /></div>
        <h3 style={{ gridColumn: '1 / -1', margin: '6px 0 0' }}>სამუშაო სიები / შეხსენებები (0091)</h3>
        {WL.map(([k, l, opts]) => {
          const cur = (s.wl_to as Record<string, string> | undefined) ?? {};
          return <Field key={k} label={l} htmlFor={`er-wl-${k}`}><select id={`er-wl-${k}`} className="select" value={cur[k] ?? opts[0][0]} onChange={(e) => upd('wl_to', { ...cur, [k]: e.target.value })}>
            {opts.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></Field>;
        })}
        <Field label="შეხსენების გამეორება (წთ)" htmlFor="er-remind_repeat_min" hint="0 — ერთხელ; 15–720 — ვადაგადაცილებულზე ყოველ N წთ-ში">
          <input id="er-remind_repeat_min" className="input mono" type="number" min={0} max={720} value={Number(s.remind_repeat_min ?? 0)}
            onChange={(e) => { const v = Math.round(Number(e.target.value) || 0); upd('remind_repeat_min', v <= 0 ? 0 : Math.max(15, Math.min(720, v))); }} /></Field>
        <Field label="ჰოსპიტალიზაციის მოთხოვნა — ესკალაცია (წთ)" htmlFor="er-admit_wait_min" hint="10–1440; → განყოფილების ხელმძღვანელი + ER-ის მენეჯერი">{int('admit_wait_min', 60, 10, 1440)}</Field>
        <Field label="ფანჯრის დახურვამდე შეხსენება (სთ)" htmlFor="er-doc_close_warn_h" hint="0–48; 0 — გამორთულია">{int('doc_close_warn_h', 2, 0, 48)}</Field>
        <div className="stack" style={{ gap: 6, gridColumn: '1 / -1' }}>
          <span className="small muted">შეხსენებები (ზარი):</span>
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>{REM.map(([k, l]) => {
            const cur = (s.reminders as Record<string, boolean> | undefined) ?? {};
            return <label key={k} className="row small"><input type="checkbox" checked={cur[k] !== false} onChange={(e) => upd('reminders', { ...cur, [k]: e.target.checked })} /> {l}</label>; })}</div>
        </div>
      </div>
    </div>
  );
}

const DISP: [string, string][] = [['home', 'სახლში'], ['admitted', 'ჰოსპიტალიზაცია'], ['transfer', 'გადაყვანა'], ['ama', 'AMA'], ['lwbs', 'LWBS'], ['death', 'გარდაცვალება']];
const REM: [string, string][] = [['verbal', 'ზეპირი დანიშნულება'], ['stat', 'STAT-ის ვადა'], ['consult', 'კონსულტაციის ვადა'], ['admit_wait', 'ჰოსპიტალიზაციის მოთხოვნა'],
  ['retriage', 'განმეორებითი ტრიაჟი'], ['doc_close', 'დოკუმენტაციის ფანჯარა']];
const WL: [string, string, [string, string][]][] = [
  ['er_verbal', 'სია „ზეპირი — დადასტურება“', [['ordering', 'დამნიშნავი ექიმი'], ['ordering_team', '+ ER-ის ყველა ექიმი (გუნდი)']]],
  ['er_stat', 'სია „STAT — შესასრულებელი“', [['nurses', 'ER-ის ექთნები'], ['nurses_doctor', 'ექთნები + მკურნალი ექიმი']]],
  ['er_admit_req', 'სია „ჰოსპიტალიზაციის მოთხოვნა“', [['doctors', 'განყოფილების ექიმები'], ['head', 'განყოფილების ხელმძღვანელი']]],
  ['er_retriage', 'სია „განმეორებითი ტრიაჟი“', [['triage', 'ტრიაჟის ექთანი'], ['triage_nurses', '+ ER-ის ექთნები']]],
  ['er_doc_open', 'სია „დოკუმენტაციის ფანჯარა“', [['attending', 'მკურნალი ექიმი'], ['attending_author', '+ მონახაზის ავტორი']]],
  ['er_unpaid', 'სია „ER — გადაუხდელი“', [['billing', 'ბილინგი'], ['billing_reception', 'ბილინგი + რეგისტრატურა']]],
];
