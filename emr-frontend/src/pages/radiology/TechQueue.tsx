import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import type { Allergy, DxDevice, DxItem } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import AllergyBanner from '../../components/AllergyBanner';
import { DxStatusChip } from '../../components/DxStatusChip';
import { ErrorBox, Loading, useToast } from '../../components/ui';
import { age, dayTitle, genderShort, hhmm, shiftDay, todayISO } from '../../lib/format';
import EndoProcedurePanel from './EndoProcedure';
import { CONTRAST_KA, ContrastChip, errCode, needsPregnancy, PatientLine, StudyMeta, Urgent } from './common';

const GROUPS: { key: string; title: string; match: (i: DxItem) => boolean }[] = [
  { key: 'arrived', title: 'მოსულები — ელოდებიან კვლევას', match: (i) => i.status === 'arrived' },
  { key: 'scheduled', title: 'ჩაწერილები', match: (i) => i.status === 'scheduled' },
  { key: 'walkin', title: 'ცოცხალი რიგი (ჩაწერის გარეშე)', match: (i) => i.status === 'ordered' },
  { key: 'done', title: 'შესრულებული', match: (i) => ['performed', 'in_progress', 'validated'].includes(i.status) },
];

/** ტექნიკოსი: პაციენტის მიღება → იდენტიფიკაცია, უსაფრთხოება, კონტრასტი/დოზა → „შესრულდა“ (რადიოლოგის სიაში გადადის) */
export default function TechQueue({ section = 'radiology' }: { section?: 'radiology' | 'endoscopy' }) {
  const [date, setDate] = useState(todayISO());
  const [device, setDevice] = useState('');
  const [selId, setSelId] = useState<string | null>(null);
  const devices = useQuery({ queryKey: ['dx-devices', section], queryFn: () => api<DxDevice[]>('/dx/devices', { query: { section } }), staleTime: 60_000 });
  const q = useQuery({ queryKey: ['rad-queue', section, date, device], queryFn: () => api<DxItem[]>('/radiology/queue', { query: { date, device_id: device, section } }), refetchInterval: 15_000 });
  const items = q.data ?? [];
  const sel = items.find((i) => i.id === selId) ?? null;
  return (
    <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex' }}>
      <div className="content grow" style={{ minWidth: 0, overflow: 'auto' }}>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button className="btn sm" type="button" onClick={() => setDate(shiftDay(date, -1))} aria-label="წინა დღე">‹</button>
          <input type="date" className="input" style={{ width: 170, height: 34 }} value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
          <button className="btn sm" type="button" onClick={() => setDate(shiftDay(date, 1))} aria-label="შემდეგი დღე">›</button>
          <strong style={{ marginLeft: 8 }}>{dayTitle(date)}</strong>
          <select aria-label="აპარატი" className="select" style={{ width: 200, height: 34, marginLeft: 'auto' }} value={device} onChange={(e) => setDevice(e.target.value)}>
            <option value="">ყველა აპარატი</option>{devices.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
        <ErrorBox error={q.error} />
        {q.isLoading ? <Loading /> : !items.length ? <div className="card empty">რიგი ცარიელია.</div> : GROUPS.map((g) => {
          const list = items.filter(g.match);
          if (!list.length) return null;
          return (
            <div key={g.key} className="card">
              <div className="card-head"><strong className="grow">{g.title}</strong><span className="muted small">{list.length}</span></div>
              <table className="table">
                <tbody>{list.map((i) => (
                  <tr key={i.id} className="clickable" onClick={() => setSelId(i.id)} style={i.id === selId ? { background: 'var(--accent-weak)' } : undefined}>
                    <td className="mono" style={{ width: 70 }}>{i.scheduled_start ? hhmm(i.scheduled_start) : i.arrived_at ? hhmm(i.arrived_at) : '—'}</td>
                    <td><strong>{i.last_name} {i.first_name}</strong><div className="small muted">{genderShort(i.gender)} · {age(i.birth_date)} წ</div></td>
                    <td>{i.service_name}<Urgent it={i} /><ContrastChip it={i} />{i.collection_issue && <div className="small" style={{ color: 'var(--warn-ink)' }}>⚠ {i.collection_issue}</div>}</td>
                    <td className="small muted">{i.device_name ?? ''}</td>
                    <td><DxStatusChip status={i.status} /></td>
                  </tr>))}</tbody>
              </table>
            </div>
          );
        })}
      </div>
      {sel && (section === 'endoscopy' ? <EndoProcedurePanel key={sel.id} it={sel} onClose={() => setSelId(null)} /> : <PerformPanel key={sel.id} it={sel} onClose={() => setSelId(null)} />)}
    </div>
  );
}

function PerformPanel({ it, onClose }: { it: DxItem; onClose: () => void }) {
  const qc = useQueryClient(); const toast = useToast(); const { user } = useAuth();
  const canPerform = user?.role === 'admin' || user?.role === 'radiographer';
  const canArrive = canPerform || user?.role === 'receptionist';
  const [identity, setIdentity] = useState(false);
  const [mr, setMr] = useState(false);
  const [preg, setPreg] = useState('');
  const [renal, setRenal] = useState('');
  const [agent, setAgent] = useState(''); const [vol, setVol] = useState('');
  const [dose, setDose] = useState(''); const [note, setNote] = useState('');
  const allergies = useQuery({ queryKey: ['allergies', it.patient_id], queryFn: () => api<Allergy[]>(`/patients/${it.patient_id}/allergies`) });
  const active = (allergies.data ?? []).filter((a) => a.is_active !== false);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['rad-queue'] }); void qc.invalidateQueries({ queryKey: ['rad-board'] }); };
  const withAck = async (path: string, body: Record<string, unknown>) => {
    try { return await api(path, { body }); } catch (e) {
      if (errCode(e) === 'UNPAID' && confirm('კვლევა გადახდილი არ არის. მაინც გავაგრძელოთ?')) return api(path, { body: { ...body, unpaid_ack: true } });
      throw e;
    }
  };
  const arrive = useMutation({ mutationFn: () => withAck(`/dx-orders/${it.id}/arrive`, {}), onSuccess: (r) => { if (r) { toast.show('პაციენტი მიღებულია'); refresh(); } } });
  const perform = useMutation({
    mutationFn: () => withAck(`/dx-orders/${it.id}/perform`, {
      identity_confirmed: identity, contrast_agent: agent || null, contrast_volume_ml: vol ? Number(vol.replace(',', '.')) : null, dose_text: dose || null, tech_note: note || null,
      safety: { ...(it.modality === 'MR' ? { mr_screening: mr } : {}), ...(preg ? { pregnancy: preg } : {}), ...(renal ? { renal } : {}) },
    }),
    onSuccess: (r) => { if (r) { toast.show('შესრულდა — გადაეცა რადიოლოგს'); refresh(); onClose(); } },
  });
  const issue = useMutation({ mutationFn: (reason: string) => api(`/dx-orders/${it.id}/exam-issue`, { body: { reason } }), onSuccess: () => { toast.show('მიზეზი შენახულია'); refresh(); } });
  const open = ['ordered', 'scheduled', 'arrived'].includes(it.status);
  const preg12 = needsPregnancy(it);
  const needContrast = !!it.contrast; const needVol = it.contrast === 'iodinated' || it.contrast === 'gadolinium';
  const ready = identity && (it.modality !== 'MR' || mr) && (!preg12 || !!preg) && (!needContrast || !!agent.trim()) && (!needVol || !!vol);

  return (
    <aside style={{ width: 520, flexShrink: 0, background: 'var(--surface)', borderLeft: '1px solid var(--line)', padding: 20, display: 'flex', flexDirection: 'column', gap: 12, overflow: 'auto' }}>
      <div className="row"><h2 className="grow" style={{ fontSize: 17 }}>{it.service_name}</h2><DxStatusChip status={it.status} /><button className="icon-btn" type="button" aria-label="დახურვა" onClick={onClose}>×</button></div>
      <PatientLine it={it} />
      <StudyMeta it={it} />
      <span className="small muted">{it.visit_kind === 'lab' ? (it.external_referral ? `გარე მიმართვა: ${it.external_referral}` : 'ექიმის გარეშე') : `ექიმი: ${it.ordered_by_name}`}{it.clinical_note ? ` · „${it.clinical_note}“` : ''}</span>
      {active.length > 0 && <AllergyBanner allergies={active} />}
      {it.contrast === 'iodinated' && it.allergy_override_reason && <div className="alert danger">კონტრასტი ალერგიის მიუხედავად — ექიმის დასაბუთება: {it.allergy_override_reason}</div>}
      {it.prep_instructions && <div className="alert info small">მომზადება: {it.prep_instructions}</div>}

      {open && canArrive && it.status !== 'arrived' && <button className="btn" type="button" disabled={arrive.isPending} onClick={() => arrive.mutate()}>პაციენტი მოვიდა</button>}

      {open && canPerform && <form className="stack" style={{ gap: 12 }} onSubmit={(e) => { e.preventDefault(); perform.mutate(); }}>
        <label className="row" style={{ alignItems: 'flex-start' }}><input type="checkbox" checked={identity} onChange={(e) => setIdentity(e.target.checked)} />
          <span>იდენტიფიკაცია დადასტურებულია — პაციენტმა თავად დაასახელა სახელი, გვარი და დაბადების თარიღი</span></label>
        {it.modality === 'MR' && <label className="row" style={{ alignItems: 'flex-start' }}><input type="checkbox" checked={mr} onChange={(e) => setMr(e.target.checked)} />
          <span>MRI უსაფრთხოების კითხვარი შევსებულია: კარდიოსტიმულატორი, მეტალის იმპლანტი/უცხო სხეული, კოხლეარული იმპლანტი, კლაუსტროფობია — უკუჩვენება არ არის</span></label>}
        {preg12 && <fieldset className="stack" style={{ gap: 6, border: 0, padding: 0, margin: 0 }}>
          <legend className="label">ორსულობა <span className="req">*</span></legend>
          <label className="row"><input type="radio" name="preg" checked={preg === 'not_pregnant'} onChange={() => setPreg('not_pregnant')} /> გამორიცხულია</label>
          <label className="row"><input type="radio" name="preg" checked={preg === 'pregnant_approved'} onChange={() => setPreg('pregnant_approved')} /> ორსულია — კვლევა რადიოლოგთან შეთანხმებით</label>
        </fieldset>}
        {needContrast && <div className="stack" style={{ gap: 8, padding: 12, border: '1px solid var(--warn-line)', borderRadius: 10, background: 'var(--warn-weak)' }}>
          <strong className="small">კონტრასტი: {CONTRAST_KA[it.contrast!]}</strong>
          <div className="row">
            <input aria-label="პრეპარატი" className="input grow" style={{ height: 36 }} placeholder="პრეპარატი *" value={agent} onChange={(e) => setAgent(e.target.value)} />
            {needVol && <input aria-label="მოცულობა, მლ" className="input mono" style={{ width: 110, height: 36 }} inputMode="decimal" placeholder="მლ *" value={vol} onChange={(e) => setVol(e.target.value)} />}
          </div>
          {needVol && <select aria-label="თირკმლის ფუნქცია" className="select" style={{ height: 36 }} value={renal} onChange={(e) => setRenal(e.target.value)}>
            <option value="">თირკმლის ფუნქცია (კრეატინინი / eGFR) —</option>
            <option value="ok">შემოწმებულია, ნორმაშია</option><option value="not_checked_approved">არ შემოწმებულა — ექიმის/რადიოლოგის თანხმობით</option>
          </select>}
        </div>}
        {it.modality !== 'US' && <input aria-label="დოზა" className="input" style={{ height: 36 }} placeholder={it.modality === 'CT' ? 'დოზა: DLP (mGy·cm), CTDIvol' : 'დოზა (DAP / სხვა)'} value={dose} onChange={(e) => setDose(e.target.value)} />}
        <textarea aria-label="შენიშვნა რადიოლოგისთვის" className="textarea" rows={3} placeholder="შენიშვნა რადიოლოგისთვის (არტეფაქტი, პოზიცია, პაციენტის მდგომარეობა…)" value={note} onChange={(e) => setNote(e.target.value)} />
        <ErrorBox error={perform.error ?? arrive.error ?? issue.error} />
        <div className="row">
          <button className="btn" type="button" onClick={() => { const r = prompt('რატომ ვერ შესრულდა? (მაგ. არ გამოცხადდა, უკუჩვენება, არ არის მომზადებული)'); if (r && r.trim().length >= 5) issue.mutate(r.trim()); }}>ვერ შესრულდა</button>
          <button className="btn primary grow" type="submit" disabled={!ready || perform.isPending}>კვლევა შესრულდა</button>
        </div>
      </form>}

      {!open && <div className="stack small" style={{ gap: 4 }}>
        {it.contrast_agent && <span>კონტრასტი: {it.contrast_agent}{it.contrast_volume_ml ? `, ${Number(it.contrast_volume_ml)} მლ` : ''}</span>}
        {it.dose_text && <span>დოზა: {it.dose_text}</span>}
        {it.tech_note && <span>შენიშვნა: {it.tech_note}</span>}
      </div>}
      {toast.node}
    </aside>
  );
}
