import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../../api/client';
import type { Allergy, DxItem, EndoProcedure, EndoScope } from '../../api/types';
import AllergyBanner from '../../components/AllergyBanner';
import { DxStatusChip } from '../../components/DxStatusChip';
import { ErrorBox, Loading, useToast } from '../../components/ui';
import { hhmm, localISO, SCOPE_STATE, SCOPE_TYPE_KA, SEDATION_KA, todayISO } from '../../lib/format';
import { errCode, PatientLine, StudyMeta } from './common';

type Drug = { drug: string; dose: string; unit: string; time: string };
type Vital = { time: string; hr: string; spo2: string; sys: string; dia: string };
const nowHM = () => hhmm(new Date().toISOString());
const num = (v: string) => (v.trim() === '' ? undefined : Number(v.replace(',', '.')));
const COLON = /COLON|SIGM/;

/** ექთანი: მიღება → ჩეკლისტი → სედაცია/მონიტორინგი → ენდოსკოპი → „პროცედურა დასრულდა“ (+ გაღვიძება) */
export default function EndoProcedurePanel({ it, onClose }: { it: DxItem; onClose: () => void }) {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['endo-proc', it.id], queryFn: () => api<EndoProcedure | null>(`/dx-orders/${it.id}/endo`) });
  const scopes = useQuery({ queryKey: ['endo-scopes'], queryFn: () => api<EndoScope[]>('/endo/scopes'), refetchInterval: 30_000 });
  const allergies = useQuery({ queryKey: ['allergies', it.patient_id], queryFn: () => api<Allergy[]>(`/patients/${it.patient_id}/allergies`) });
  const day = it.scheduled_start ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tbilisi' }).format(new Date(it.scheduled_start)) : todayISO();

  const [f, setF] = useState({
    consent_confirmed: false, fasting_hours: '', anticoagulants: '' as '' | 'none' | 'stopped' | 'continued', anticoag_note: '', allergies_reviewed: false,
    asa_class: '', bowel_prep: '', checklist_note: '', sedation_type: '', sedation_by: '', scope_id: '', start: '', end: '', recovery_score: '',
    complications: 'none' as 'none' | 'minor' | 'major', complication_note: '',
  });
  const [drugs, setDrugs] = useState<Drug[]>([]);
  const [vitals, setVitals] = useState<Vital[]>([]);
  const [identity, setIdentity] = useState(false);
  useEffect(() => {
    const p = q.data; if (q.isLoading) return;
    setF({
      consent_confirmed: !!p?.consent_confirmed, fasting_hours: p?.fasting_hours ? String(Number(p.fasting_hours)) : '', anticoagulants: p?.anticoagulants ?? '', anticoag_note: p?.anticoag_note ?? '',
      allergies_reviewed: !!p?.allergies_reviewed, asa_class: p?.asa_class ? String(p.asa_class) : '', bowel_prep: p?.bowel_prep ?? '', checklist_note: p?.checklist_note ?? '',
      sedation_type: p?.sedation_type ?? '', sedation_by: p?.sedation_by ?? '', scope_id: p?.scope_id ?? '', start: p?.started_at ? hhmm(p.started_at) : '', end: p?.ended_at ? hhmm(p.ended_at) : '',
      recovery_score: p?.recovery_score != null ? String(p.recovery_score) : '', complications: p?.complications ?? 'none', complication_note: p?.complication_note ?? '',
    });
    setDrugs((p?.sedation_drugs ?? []).map((d) => ({ drug: d.drug, dose: String(d.dose), unit: d.unit, time: d.time ?? '' })));
    setVitals((p?.monitoring ?? []).map((v) => ({ time: v.time, hr: v.hr?.toString() ?? '', spo2: v.spo2?.toString() ?? '', sys: v.sys?.toString() ?? '', dia: v.dia?.toString() ?? '' })));
  }, [q.data, q.isLoading]);

  const done = !['ordered', 'scheduled', 'arrived'].includes(it.status);
  const locked = it.status === 'validated' || it.status === 'cancelled';
  const body = () => ({
    consent_confirmed: f.consent_confirmed, fasting_hours: num(f.fasting_hours) ?? null, anticoagulants: f.anticoagulants || null, anticoag_note: f.anticoag_note || null,
    allergies_reviewed: f.allergies_reviewed, asa_class: num(f.asa_class) ?? null, bowel_prep: f.bowel_prep || null, checklist_note: f.checklist_note || null,
    sedation_type: f.sedation_type || null, sedation_by: f.sedation_by || null,
    sedation_drugs: drugs.filter((d) => d.drug.trim() && d.dose).map((d) => ({ drug: d.drug.trim(), dose: Number(d.dose.replace(',', '.')), unit: d.unit || 'მგ', time: d.time || undefined })),
    monitoring: vitals.filter((v) => v.time).map((v) => ({ time: v.time, hr: num(v.hr), spo2: num(v.spo2), sys: num(v.sys), dia: num(v.dia) })),
    ...(done ? {} : { scope_id: f.scope_id || null }),
    started_at: f.start ? localISO(day, f.start) : null, ended_at: f.end ? localISO(day, f.end) : null,
    recovery_score: num(f.recovery_score) ?? null, complications: f.complications, complication_note: f.complications === 'none' ? null : f.complication_note || null,
  });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['endo-proc', it.id] }); void qc.invalidateQueries({ queryKey: ['rad-queue'] }); void qc.invalidateQueries({ queryKey: ['endo-scopes'] }); void qc.invalidateQueries({ queryKey: ['rad-board'] }); };
  const withAck = async (path: string, b: Record<string, unknown>) => {
    try { return await api(path, { body: b }); } catch (e) {
      if (errCode(e) === 'UNPAID' && confirm('პროცედურა გადახდილი არ არის. მაინც გავაგრძელოთ?')) return api(path, { body: { ...b, unpaid_ack: true } });
      throw e;
    }
  };
  const arrive = useMutation({ mutationFn: () => withAck(`/dx-orders/${it.id}/arrive`, {}), onSuccess: (r) => { if (r) { toast.show('პაციენტი მიღებულია'); refresh(); } } });
  const save = useMutation({ mutationFn: () => api(`/dx-orders/${it.id}/endo`, { method: 'PUT', body: body() }), onSuccess: () => { toast.show('შენახულია'); refresh(); } });
  const complete = useMutation({
    mutationFn: () => withAck(`/dx-orders/${it.id}/endo/complete`, { ...body(), identity_confirmed: identity }),
    onSuccess: (r) => { if (r) { toast.show('პროცედურა დასრულდა — გადაეცა ენდოსკოპისტს'); refresh(); } },
  });
  const issue = useMutation({ mutationFn: (reason: string) => api(`/dx-orders/${it.id}/exam-issue`, { body: { reason } }), onSuccess: refresh });
  const incomplete = complete.error instanceof ApiError && complete.error.code === 'INCOMPLETE';

  if (q.isLoading) return <aside style={{ width: 620, borderLeft: '1px solid var(--line)', background: 'var(--surface)' }}><Loading /></aside>;
  const act = (allergies.data ?? []).filter((a) => a.is_active !== false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF({ ...f, [k]: v });
  const sedated = ['moderate', 'deep', 'general'].includes(f.sedation_type);

  return (
    <aside style={{ width: 'min(640px, 52vw)', flexShrink: 0, background: 'var(--surface)', borderLeft: '1px solid var(--line)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div className="stack" style={{ padding: '16px 20px 10px', gap: 4, borderBottom: '1px solid var(--line)' }}>
        <div className="row"><h2 className="grow" style={{ fontSize: 17 }}>{it.service_name}</h2><DxStatusChip status={it.status} /><button className="icon-btn" type="button" aria-label="დახურვა" onClick={onClose}>×</button></div>
        <PatientLine it={it} />
        <StudyMeta it={it} />
        <span className="small muted">{it.visit_kind === 'lab' ? (it.external_referral ? `გარე მიმართვა: ${it.external_referral}` : 'ექიმის გარეშე') : `ექიმი: ${it.ordered_by_name}`}{it.clinical_note ? ` · „${it.clinical_note}“` : ''}</span>
        {act.length > 0 && <AllergyBanner allergies={act} />}
        {it.prep_instructions && !done && <div className="alert info small">მომზადება: {it.prep_instructions}</div>}
      </div>

      <form style={{ flex: 1, overflow: 'auto', padding: '12px 20px', display: 'flex', flexDirection: 'column', gap: 14 }} onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        {!done && it.status !== 'arrived' && <button className="btn" type="button" disabled={arrive.isPending} onClick={() => arrive.mutate()}>პაციენტი მოვიდა</button>}

        <fieldset disabled={locked} className="stack" style={{ gap: 8, border: '1px solid var(--line-soft)', borderRadius: 10, padding: 12, margin: 0 }}>
          <legend className="label" style={{ padding: '0 4px' }}>ჩეკლისტი (პროცედურამდე)</legend>
          <label className="row"><input type="checkbox" checked={f.consent_confirmed} onChange={(e) => set('consent_confirmed', e.target.checked)} /> ინფორმირებული თანხმობა ხელმოწერილია</label>
          <label className="row"><input type="checkbox" checked={f.allergies_reviewed} onChange={(e) => set('allergies_reviewed', e.target.checked)} /> ალერგიები გადამოწმებულია პაციენტთან</label>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <label className="row small">უზმოზე (სთ) <input className="input mono" style={{ width: 70, height: 32 }} inputMode="decimal" value={f.fasting_hours} onChange={(e) => set('fasting_hours', e.target.value)} /></label>
            <label className="row small">ASA <select className="select" style={{ width: 80, height: 32 }} value={f.asa_class} onChange={(e) => set('asa_class', e.target.value)}><option value="">—</option>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{['I', 'II', 'III', 'IV', 'V'][n - 1]}</option>)}</select></label>
            {COLON.test(it.service_code) && <label className="row small">ნაწლავის მომზადება <select className="select" style={{ width: 170, height: 32 }} value={f.bowel_prep} onChange={(e) => set('bowel_prep', e.target.value)}>
              <option value="">—</option><option value="excellent">შესანიშნავი</option><option value="good">კარგი</option><option value="fair">დამაკმაყოფილებელი</option><option value="poor">ცუდი</option></select></label>}
          </div>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <span className="small">ანტიკოაგულანტები / ანტიაგრეგანტები:</span>
            {([['none', 'არ იღებს'], ['stopped', 'შეწყვეტილია'], ['continued', 'იღებს']] as const).map(([k, l]) => <label key={k} className="row small"><input type="radio" name="ac" checked={f.anticoagulants === k} onChange={() => set('anticoagulants', k)} /> {l}</label>)}
          </div>
          {f.anticoagulants && f.anticoagulants !== 'none' && <input aria-label="პრეპარატი / როდის შეწყდა" className="input" style={{ height: 34 }} placeholder="პრეპარატი, როდის შეწყდა" value={f.anticoag_note} onChange={(e) => set('anticoag_note', e.target.value)} />}
        </fieldset>

        <fieldset disabled={locked} className="stack" style={{ gap: 8, border: '1px solid var(--line-soft)', borderRadius: 10, padding: 12, margin: 0 }}>
          <legend className="label" style={{ padding: '0 4px' }}>სედაცია / მონიტორინგი</legend>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <select aria-label="სედაცია" className="select" style={{ width: 220, height: 34 }} value={f.sedation_type} onChange={(e) => set('sedation_type', e.target.value)}>
              <option value="">სედაცია —</option>{Object.entries(SEDATION_KA).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            {f.sedation_type && f.sedation_type !== 'none' && <input aria-label="ვინ ჩაატარა" className="input grow" style={{ height: 34 }} placeholder="ვინ ჩაატარა (ანესთეზიოლოგი / ექიმი)" value={f.sedation_by} onChange={(e) => set('sedation_by', e.target.value)} />}
          </div>
          {f.sedation_type && f.sedation_type !== 'none' && <>
            {drugs.map((d, i) => (
              <div key={i} className="row">
                <input aria-label="პრეპარატი" className="input grow" style={{ height: 32 }} placeholder="პრეპარატი" value={d.drug} onChange={(e) => setDrugs(drugs.map((x, j) => (j === i ? { ...x, drug: e.target.value } : x)))} />
                <input aria-label="დოზა" className="input mono" style={{ width: 70, height: 32 }} inputMode="decimal" placeholder="დოზა" value={d.dose} onChange={(e) => setDrugs(drugs.map((x, j) => (j === i ? { ...x, dose: e.target.value } : x)))} />
                <select aria-label="ერთეული" className="select" style={{ width: 70, height: 32 }} value={d.unit} onChange={(e) => setDrugs(drugs.map((x, j) => (j === i ? { ...x, unit: e.target.value } : x)))}>{['მგ', 'მკგ', 'მლ'].map((u) => <option key={u}>{u}</option>)}</select>
                <input aria-label="დრო" type="time" className="input mono" style={{ width: 100, height: 32 }} value={d.time} onChange={(e) => setDrugs(drugs.map((x, j) => (j === i ? { ...x, time: e.target.value } : x)))} />
                <button className="icon-btn" type="button" aria-label="წაშლა" onClick={() => setDrugs(drugs.filter((_, j) => j !== i))}>×</button>
              </div>))}
            <button className="btn sm" type="button" style={{ width: 'max-content' }} onClick={() => setDrugs([...drugs, { drug: drugs[0]?.drug ?? '', dose: '', unit: drugs[0]?.unit ?? 'მგ', time: nowHM() }])}>+ პრეპარატი{sedated && !drugs.length ? ' *' : ''}</button>
          </>}
          {vitals.length > 0 && <table className="table small"><thead><tr><th>დრო</th><th>HR</th><th>SpO₂</th><th>წნევა</th><th /></tr></thead>
            <tbody>{vitals.map((v, i) => {
              const upd = (k: keyof Vital) => (e: React.ChangeEvent<HTMLInputElement>) => setVitals(vitals.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x)));
              const low = v.spo2 && Number(v.spo2) < 92;
              return (<tr key={i}>
                <td><input aria-label="დრო" type="time" className="input mono" style={{ width: 96, height: 30 }} value={v.time} onChange={upd('time')} /></td>
                <td><input aria-label="HR" className="input mono" style={{ width: 60, height: 30 }} inputMode="numeric" value={v.hr} onChange={upd('hr')} /></td>
                <td><input aria-label="SpO2" className={`input mono${low ? ' invalid' : ''}`} style={{ width: 60, height: 30 }} inputMode="numeric" value={v.spo2} onChange={upd('spo2')} /></td>
                <td className="row" style={{ gap: 4 }}><input aria-label="სისტოლური" className="input mono" style={{ width: 56, height: 30 }} inputMode="numeric" value={v.sys} onChange={upd('sys')} />/<input aria-label="დიასტოლური" className="input mono" style={{ width: 56, height: 30 }} inputMode="numeric" value={v.dia} onChange={upd('dia')} /></td>
                <td><button className="icon-btn" type="button" aria-label="წაშლა" onClick={() => setVitals(vitals.filter((_, j) => j !== i))}>×</button></td>
              </tr>);
            })}</tbody></table>}
          <button className="btn sm" type="button" style={{ width: 'max-content' }} onClick={() => setVitals([...vitals, { time: nowHM(), hr: '', spo2: '', sys: '', dia: '' }])}>+ ვიტალები</button>
        </fieldset>

        <fieldset disabled={locked} className="stack" style={{ gap: 8, border: '1px solid var(--line-soft)', borderRadius: 10, padding: 12, margin: 0 }}>
          <legend className="label" style={{ padding: '0 4px' }}>პროცედურა</legend>
          <select aria-label="ენდოსკოპი" className="select" style={{ height: 36 }} value={f.scope_id} disabled={done} onChange={(e) => set('scope_id', e.target.value)}>
            <option value="">ენდოსკოპი —</option>
            {(scopes.data ?? []).map((s) => <option key={s.id} value={s.id} disabled={s.state !== 'ready' && s.id !== f.scope_id}>{s.name} · {SCOPE_TYPE_KA[s.scope_type]} · S/N {s.serial_number} — {SCOPE_STATE[s.state][1]}</option>)}
          </select>
          {done && q.data?.scope_used_at && <span className="hint">ენდოსკოპი ჩაიწერა {hhmm(q.data.scope_used_at)} — შეცვლა შეუძლებელია (მიკვლევადობა). საჭიროებს დეზინფექციას.</span>}
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <label className="row small">დაწყება <input type="time" className="input mono" style={{ width: 110, height: 34 }} value={f.start} onChange={(e) => set('start', e.target.value)} /></label>
            <button className="btn sm" type="button" onClick={() => set('start', nowHM())}>ახლა</button>
            <label className="row small">დასრულება <input type="time" className="input mono" style={{ width: 110, height: 34 }} value={f.end} onChange={(e) => set('end', e.target.value)} /></label>
            <button className="btn sm" type="button" onClick={() => set('end', nowHM())}>ახლა</button>
          </div>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <span className="small">გართულება:</span>
            {([['none', 'არა'], ['minor', 'მსუბუქი'], ['major', 'მძიმე']] as const).map(([k, l]) => <label key={k} className="row small"><input type="radio" name="cx" checked={f.complications === k} onChange={() => set('complications', k)} /> {l}</label>)}
          </div>
          {f.complications !== 'none' && <input aria-label="გართულების აღწერა" className="input" style={{ height: 34 }} placeholder="აღწერა (სისხლდენა, დესატურაცია, ჰიპოტენზია…) *" value={f.complication_note} onChange={(e) => set('complication_note', e.target.value)} />}
          <label className="row small">გაღვიძება (Aldrete, 0–10) <input className="input mono" style={{ width: 60, height: 32 }} inputMode="numeric" value={f.recovery_score} onChange={(e) => set('recovery_score', e.target.value)} /></label>
        </fieldset>

        {!done && <label className="row" style={{ alignItems: 'flex-start' }}><input type="checkbox" checked={identity} onChange={(e) => setIdentity(e.target.checked)} />
          <span>იდენტიფიკაცია დადასტურებულია — პაციენტმა თავად დაასახელა სახელი, გვარი და დაბადების თარიღი</span></label>}
        <ErrorBox error={complete.error ?? save.error ?? arrive.error ?? issue.error} />
        {incomplete && <span className="hint">შეავსეთ მითითებული ველები და ცადეთ ხელახლა.</span>}
      </form>

      {!locked && <div className="row" style={{ padding: '12px 20px', borderTop: '1px solid var(--line)', flexWrap: 'wrap' }}>
        {!done && <button className="btn" type="button" onClick={() => { const r = prompt('რატომ ვერ ჩატარდა? (არ გამოცხადდა, არ არის მომზადებული, უკუჩვენება…)'); if (r && r.trim().length >= 5) issue.mutate(r.trim()); }}>ვერ ჩატარდა</button>}
        <button className="btn grow" type="button" disabled={save.isPending} onClick={() => save.mutate()}>შენახვა</button>
        {!done && <button className="btn primary grow" type="button" disabled={complete.isPending || !identity} onClick={() => complete.mutate()}>პროცედურა დასრულდა</button>}
      </div>}
      {toast.node}
    </aside>
  );
}
