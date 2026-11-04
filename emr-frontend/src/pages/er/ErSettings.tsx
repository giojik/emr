import { Field } from '../../components/ui';
import { useErMeta } from './Er';

/** ადმინისტრირება → მოდულები → გადაუდებელი დახმარება (0087): პარამეტრები */
export function ErSettings({ s, set }: { s: Record<string, unknown>; set: (v: Record<string, unknown>) => void }) {
  const meta = useErMeta();
  const upd = (k: string, v: unknown) => set({ ...s, [k]: v });
  const int = (k: string, d: number, min: number, max: number) => (
    <input id={`er-${k}`} className="input mono" type="number" min={min} max={max} value={Number(s[k] ?? d)} onChange={(e) => upd(k, Math.max(min, Math.min(max, Math.round(Number(e.target.value) || min))))} />);
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
      </div>
    </div>
  );
}
