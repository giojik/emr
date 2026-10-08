import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { ErrorBox, Field, Loading, Modal, useToast } from '../../components/ui';
import { dateGe, genderShort, hhmm, localISO, money, shiftDay, todayISO } from '../../lib/format';
import { invalOr, ReasonPrompt } from './Dialogs';
import { ANESTHESIA_KA, caseLink, dt, useOrSetup, type CaseDetail } from './types';

/** საოპერაციო ბლოკი, ნაწილი 3 (0050): PACU (ბარათის ჩანართი + დაფა), ბილინგი, სტატისტიკა, ანესთეზიის ტარიფები */

const PDEST_KA: Record<string, string> = { ward: 'განყოფილება', icu: 'რეანიმაცია (ICU)', other: 'სხვა' };
const ALDRETE: [string, string, [string, string, string]][] = [
  ['activity', 'მოძრაობა', ['ვერ ამოძრავებს კიდურებს', '2 კიდური', '4 კიდური (ნებით / ბრძანებით)']],
  ['respiration', 'სუნთქვა', ['აპნოე', 'დისპნოე / შეზღუდული', 'ღრმად სუნთქავს, ახველებს']],
  ['circulation', 'ცირკულაცია (წნევა საწყისთან)', ['± ≥ 50%', '± 20–49%', '± < 20%']],
  ['consciousness', 'ცნობიერება', ['არ რეაგირებს', 'იღვიძებს დაძახებით', 'სრულად ფხიზლად']],
  ['oxygenation', 'SpO₂', ['< 90% ჟანგბადითაც', '> 90% ჟანგბადით', '> 92% ჰაერზე']],
];
const PFLUID_KA: Record<string, string> = { iv: 'ინფუზია', blood: 'სისხლი / კომპონენტები', po: 'პერორალური', other_in: 'სხვა (მიღება)', urine: 'შარდი', drain: 'დრენაჟი', vomit: 'ღებინება',
  blood_loss: 'სისხლდენა', other_out: 'სხვა (გამოყოფა)' };
const nowHM = () => hhmm(new Date().toISOString());

// ================================================================= PACU — ოპერაციის ბარათის ჩანართი
interface PVit { id: string; recorded_at: string; systolic_bp: number | null; diastolic_bp: number | null; map_mmhg: number | null; heart_rate: number | null; spo2: number | null;
  respiratory_rate: number | null; temperature: string | null; pain: number | null; o2_supplement: boolean | null; notes: string | null; voided_at: string | null; void_reason: string | null; by_name: string | null }
interface PScore { id: string; recorded_at: string; activity: number; respiration: number; circulation: number; consciousness: number; oxygenation: number; total: number; pain: number | null;
  ponv: boolean; note: string | null; voided_at: string | null; void_reason: string | null; by_name: string }
interface Pacu {
  case_id: string; case_no: string; status: string; encounter_id: string | null;
  episode: null | { case_id: string; nurse_id: string | null; nurse_name: string | null; bay: string | null; complications: string | null; notes: string | null; discharge_destination: string | null;
    discharge_aldrete: number | null; discharge_note: string | null; to_department_name: string | null; transfer_id: string | null; transfer_status: string | null; discharged_by_name: string | null;
    discharged_at: string | null };
  times: { out_of_room: string | null; out_destination: string | null; pacu_in: string | null; pacu_out: string | null; pacu_destination: string | null };
  vitals: PVit[]; scores: PScore[]; fluids: { id: string; direction: string; category: string; volume_ml: string; recorded_at: string; note: string | null; voided_at: string | null; void_reason: string | null; by_name: string }[];
  balance: { in: number; out: number; net: number }; grid_min: number; aldrete_min: number; last_score: { total: number; pain: number | null; at: string } | null; ready: boolean;
  vitals_overdue: boolean; current_department: { id: string; name: string; care_level: string | null } | null; can: { admit: boolean; edit: boolean; discharge: boolean };
  warnings?: string[];
}
const PVROWS: [keyof PVit, string, string][] = [['systolic_bp', 'სისტ. წნევა', 'mmHg'], ['diastolic_bp', 'დიასტ. წნევა', 'mmHg'], ['heart_rate', 'პულსი', '/წთ'], ['spo2', 'SpO₂', '%'],
  ['respiratory_rate', 'სუნთქვა', '/წთ'], ['temperature', 'ტემპ.', '°C'], ['pain', 'ტკივილი', '0–10']];

export function PacuTab({ c }: { c: CaseDetail }) {
  const q = useQuery({ queryKey: ['or-pacu', c.id], queryFn: () => api<Pacu>(`/or/cases/${c.id}/pacu`), refetchInterval: 30_000 });
  const [dlg, setDlg] = useState<'admit' | 'edit' | 'score' | 'discharge' | null>(null);
  const [slot, setSlot] = useState<string | null>(null);
  const [vd, setVd] = useState<{ path: string; title: string } | null>(null);
  const p = q.data;
  if (q.isLoading) return <Loading />;
  if (!p) return <ErrorBox error={q.error} />;
  const ep = p.episode; const done = !!ep?.discharged_at;
  if (!ep) {
    return (
      <div className="stack">
        {c.status !== 'completed' ? <div className="alert info">PACU — ოპერაციის დასრულების („საოპერაციოდან გავიდა“) შემდეგ.</div>
          : <div className="card card-pad stack">
            <span>ოპერაცია დასრულდა {dt(p.times.out_of_room)}{p.times.out_destination ? ` → ${p.times.out_destination === 'pacu' ? 'PACU' : PDEST_KA[p.times.out_destination] ?? p.times.out_destination}` : ''}.</span>
            {p.times.out_destination && p.times.out_destination !== 'pacu' && <span className="small muted">ოთახიდან პირდაპირ — PACU-ს გარეშე.</span>}
            {p.can.admit ? <button className="btn primary" type="button" style={{ alignSelf: 'flex-start' }} onClick={() => setDlg('admit')}>PACU — შემოსვლა</button>
              : <span className="small muted">PACU-ს აწარმოებს საოპერაციო ექთანი / ანესთეზიოლოგი.</span>}
          </div>}
        {dlg === 'admit' && <AdmitDialog p={p} onClose={() => setDlg(null)} />}
      </div>
    );
  }
  const live = p.scores.filter((s) => !s.voided_at);
  return (
    <div className="stack">
      {done && <div className="alert ok">გამოწერილია {dt(ep.discharged_at)} → {PDEST_KA[ep.discharge_destination!]}{ep.to_department_name ? ` (${ep.to_department_name})` : ''} · Aldrete {ep.discharge_aldrete ?? '—'} · {ep.discharged_by_name}
        {ep.transfer_id && <> · გადაყვანა: <strong>{ep.transfer_status === 'requested' ? 'მოთხოვნილია' : ep.transfer_status === 'accepted' ? 'მიღებულია' : ep.transfer_status}</strong></>}
        {ep.discharge_note && <div className="small">{ep.discharge_note}</div>}</div>}
      {p.warnings?.map((w) => <div key={w} className="alert warn">{w}</div>)}
      {!done && p.vitals_overdue && <div className="alert warn">ვიტალები — {p.grid_min} წუთზე მეტია არ ჩაწერილა.</div>}
      <div className="row" style={{ gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <section className="card" style={{ flex: '1 1 280px', minWidth: 0 }}>
          <div className="card-head"><h2 className="grow">PACU</h2>{done ? <span className="chip">გამოწერილი</span> : <span className="chip accent">PACU-შია</span>}
            {p.can.edit && <button className="btn sm" type="button" onClick={() => setDlg('edit')}>რედაქტირება</button>}</div>
          <div className="card-pad stack" style={{ gap: 6 }}>
            <Row l="შემოსვლა">{dt(p.times.pacu_in)}{!done && p.times.pacu_in && <span className="muted"> · {Math.round((Date.now() - new Date(p.times.pacu_in).getTime()) / 60000)} წთ</span>}</Row>
            <Row l="ექთანი">{ep.nurse_name ?? '—'}</Row>
            <Row l="ადგილი">{ep.bay ?? '—'}</Row>
            <Row l="გართულებები">{ep.complications ?? <span className="muted">—</span>}</Row>
            {ep.notes && <Row l="შენიშვნა">{ep.notes}</Row>}
          </div>
        </section>
        <section className="card" style={{ flex: '1.5 1 420px', minWidth: 0 }}>
          <div className="card-head"><h2 className="grow">Aldrete</h2>
            {p.last_score ? <span className={`chip ${p.ready ? 'ok' : 'warn'}`} style={{ fontSize: 15 }}>{p.last_score.total} / 10</span> : <span className="chip">არ არის</span>}
            {p.can.edit && <button className="btn sm primary" type="button" onClick={() => setDlg('score')}>+ შეფასება</button>}</div>
          <div className="card-pad small muted">გამოწერის ზღვარი — {p.aldrete_min} (განყოფილებაში / სხვაგან); ICU-ში — ზღვრის გარეშე.</div>
          <div style={{ overflowX: 'auto' }}><table className="table"><thead><tr><th>დრო</th><th title="მოძრაობა / სუნთქვა / ცირკულაცია / ცნობიერება / SpO₂">კომპონენტები</th><th>ჯამი</th><th>ტკივილი</th><th style={{ width: 52 }} /></tr></thead>
            <tbody>{p.scores.map((s) => (
              <tr key={s.id} style={s.voided_at ? { opacity: 0.45 } : undefined}>
                <td className="mono">{hhmm(s.recorded_at)}</td><td className="mono small">{s.activity}·{s.respiration}·{s.circulation}·{s.consciousness}·{s.oxygenation}</td>
                <td style={{ whiteSpace: 'nowrap' }}><strong>{s.total}</strong>{s.ponv && <span className="chip warn" style={{ marginLeft: 6 }}>PONV</span>}</td><td className="mono">{s.pain ?? '—'}</td>
                <td>{s.voided_at ? <span className="small muted" title={s.void_reason ?? ''}>გაუქმ.</span>
                  : p.can.edit && <button className="btn sm" type="button" aria-label="გაუქმება" onClick={() => setVd({ path: `/or/pacu/scores/${s.id}/void`, title: `Aldrete ${hhmm(s.recorded_at)} — გაუქმება` })}>×</button>}</td></tr>))}
              {!p.scores.length && <tr><td colSpan={5} className="muted small">—</td></tr>}</tbody></table></div>
        </section>
        <section className="card" style={{ flex: '1 1 280px', minWidth: 0 }}>
          <div className="card-head"><h2 className="grow">გამოწერა</h2></div>
          <div className="card-pad stack" style={{ gap: 8 }}>
            {done ? <span className="small">გამოწერილია — ცვლილება შეუძლებელია (ნიშნულის შესწორება — „ნიშნულები“).</span> : <>
              <span className="small">{p.ready ? <span className="chip ok">კრიტერიუმი შესრულებულია</span> : <span className="chip warn">Aldrete {live.length ? `${p.last_score!.total} < ${p.aldrete_min}` : 'არ არის'}</span>}
                {' '}{p.current_department && <span className="muted">განყოფილება: {p.current_department.name}</span>}</span>
              {p.can.discharge && <button className="btn primary" type="button" style={{ alignSelf: 'flex-start' }} onClick={() => setDlg('discharge')}>PACU-დან გამოწერა</button>}
            </>}
          </div>
        </section>
      </div>
      <section className="card">
        <div className="card-head"><h2 className="grow">ვიტალები — {p.grid_min}-წუთიანი ბადე</h2>
          <span className="chip info">მიღება {p.balance.in} მლ</span><span className="chip warn">გამოყოფა {p.balance.out} მლ</span></div>
        {p.times.pacu_in && <PacuGrid p={p} onSlot={setSlot} onVoid={(v) => setVd({ path: `/or/pacu/vitals/${v.id}/void`, title: `ვიტალები ${hhmm(v.recorded_at)} — გაუქმება` })} />}
      </section>
      <section className="card">
        <div className="card-head"><h2 className="grow">სითხეები</h2><span className={`chip ${p.balance.net >= 0 ? 'ok' : 'danger'}`}>{p.balance.net >= 0 ? '+' : ''}{p.balance.net} მლ</span></div>
        <PacuFluids p={p} onVoid={(id) => setVd({ path: `/or/pacu/fluids/${id}/void`, title: 'სითხის ჩანაწერის გაუქმება' })} />
      </section>
      {dlg === 'edit' && <EditDialog p={p} onClose={() => setDlg(null)} />}
      {dlg === 'score' && <ScoreDialog p={p} onClose={() => setDlg(null)} />}
      {dlg === 'discharge' && <DischargeDialog p={p} onClose={() => setDlg(null)} />}
      {slot && <PVitalsDialog p={p} at={slot} onClose={() => setSlot(null)} />}
      {vd && <ReasonPrompt title={vd.title} label="მიზეზი" path={vd.path} danger onClose={() => setVd(null)} />}
    </div>
  );
}
function Row({ l, children }: { l: string; children: ReactNode }) {
  return <div className="row" style={{ alignItems: 'flex-start' }}><span className="muted" style={{ width: 120, flexShrink: 0 }}>{l}</span><span className="grow">{children}</span></div>;
}
function useNurses() {
  const a = useQuery({ queryKey: ['or-staff', 'or_nurse'], queryFn: () => api<{ id: string; name: string }[]>('/or/staff', { query: { cap: 'or_nurse' } }) });
  const b = useQuery({ queryKey: ['or-staff', 'nurse'], queryFn: () => api<{ id: string; name: string }[]>('/or/staff', { query: { cap: 'nurse' } }) });
  return useMemo(() => { const m = new Map<string, string>(); for (const x of [...(a.data ?? []), ...(b.data ?? [])]) m.set(x.id, x.name); return [...m].map(([id, name]) => ({ id, name })); }, [a.data, b.data]);
}

function AdmitDialog({ p, onClose }: { p: Pacu; onClose: () => void }) {
  const qc = useQueryClient(); const nurses = useNurses();
  const [f, setF] = useState({ date: todayISO(), time: nowHM(), nurse_id: '', bay: '' });
  const m = useMutation({ mutationFn: () => api(`/or/cases/${p.case_id}/pacu/admit`, { body: { at: localISO(f.date, f.time), nurse_id: f.nurse_id || undefined, bay: f.bay.trim() || undefined } }),
    onSuccess: () => { invalOr(qc); onClose(); } });
  return (
    <Modal title="PACU — შემოსვლა" onClose={onClose} footer={<><button className="btn" type="button" onClick={onClose}>დახურვა</button>
      <button className="btn primary" type="button" disabled={m.isPending} onClick={() => m.mutate()}>შენახვა</button></>}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="თარიღი" htmlFor="pa-d"><input id="pa-d" className="input" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label="დრო" htmlFor="pa-t"><input id="pa-t" className="input" type="time" value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} /></Field>
      </div>
      <Field label="პასუხისმგებელი ექთანი" htmlFor="pa-n"><select id="pa-n" className="select" value={f.nurse_id} onChange={(e) => setF({ ...f, nurse_id: e.target.value })}>
        <option value="">—</option>{nurses.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}</select></Field>
      <Field label="ადგილი / საწოლი PACU-ში" htmlFor="pa-b"><input id="pa-b" className="input" maxLength={20} value={f.bay} onChange={(e) => setF({ ...f, bay: e.target.value })} /></Field>
      <ErrorBox error={m.error} />
    </Modal>
  );
}

function EditDialog({ p, onClose }: { p: Pacu; onClose: () => void }) {
  const qc = useQueryClient(); const nurses = useNurses(); const ep = p.episode!;
  const [f, setF] = useState({ nurse_id: ep.nurse_id ?? '', bay: ep.bay ?? '', complications: ep.complications ?? '', notes: ep.notes ?? '' });
  const m = useMutation({ mutationFn: () => api(`/or/cases/${p.case_id}/pacu`, { method: 'PUT', body: { nurse_id: f.nurse_id || null, bay: f.bay.trim() || null,
    complications: f.complications.trim() || null, notes: f.notes.trim() || null } }), onSuccess: () => { invalOr(qc); onClose(); } });
  return (
    <Modal title="PACU — რედაქტირება" onClose={onClose} footer={<><button className="btn" type="button" onClick={onClose}>დახურვა</button>
      <button className="btn primary" type="button" disabled={m.isPending} onClick={() => m.mutate()}>შენახვა</button></>}>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
        <Field label="პასუხისმგებელი ექთანი" htmlFor="pe-n"><select id="pe-n" className="select" value={f.nurse_id} onChange={(e) => setF({ ...f, nurse_id: e.target.value })}>
          <option value="">—</option>{nurses.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}</select></Field>
        <Field label="ადგილი" htmlFor="pe-b"><input id="pe-b" className="input" maxLength={20} value={f.bay} onChange={(e) => setF({ ...f, bay: e.target.value })} /></Field>
      </div>
      <Field label="გართულებები (PACU)" htmlFor="pe-c" hint="სტატისტიკაში ითვლება"><textarea id="pe-c" className="textarea" rows={2} value={f.complications} onChange={(e) => setF({ ...f, complications: e.target.value })} /></Field>
      <Field label="შენიშვნა" htmlFor="pe-o"><textarea id="pe-o" className="textarea" rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      <ErrorBox error={m.error} />
    </Modal>
  );
}

function ScoreDialog({ p, onClose }: { p: Pacu; onClose: () => void }) {
  const qc = useQueryClient();
  const [s, setS] = useState<Record<string, number | null>>({ activity: null, respiration: null, circulation: null, consciousness: null, oxygenation: null });
  const [pain, setPain] = useState(''); const [ponv, setPonv] = useState(false); const [note, setNote] = useState(''); const [time, setTime] = useState(nowHM());
  const all = ALDRETE.every(([k]) => s[k] !== null);
  const total = ALDRETE.reduce((a, [k]) => a + (s[k] ?? 0), 0);
  const m = useMutation({ mutationFn: () => api(`/or/cases/${p.case_id}/pacu/scores`, { body: { ...s, at: localISO(todayISO(), time), pain: pain === '' ? undefined : Number(pain), ponv, note: note.trim() || undefined } }),
    onSuccess: () => { invalOr(qc); onClose(); } });
  return (
    <Modal title="Aldrete — შეფასება" width={640} onClose={onClose} footer={<><span className="grow">{all && <span className={`chip ${total >= p.aldrete_min ? 'ok' : 'warn'}`} style={{ fontSize: 15 }}>ჯამი {total} / 10</span>}</span>
      <button className="btn" type="button" onClick={onClose}>დახურვა</button><button className="btn primary" type="button" disabled={!all || m.isPending} onClick={() => m.mutate()}>შენახვა</button></>}>
      <div className="stack" style={{ gap: 10 }}>
        {ALDRETE.map(([k, l, opts]) => (
          <div key={k} className="stack" style={{ gap: 4 }}><span className="label">{l}</span>
            <div className="seg" role="group" aria-label={l} style={{ flexWrap: 'wrap' }}>{opts.map((o, i) => <button key={i} type="button" aria-pressed={s[k] === i} onClick={() => setS({ ...s, [k]: i })}>
              <strong>{i}</strong> · {o}</button>)}</div></div>))}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, alignItems: 'end' }}>
          <Field label="დრო (დღეს)" htmlFor="ps-t"><input id="ps-t" className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} /></Field>
          <Field label="ტკივილი (0–10)" htmlFor="ps-p"><input id="ps-p" className="input mono" type="number" min={0} max={10} value={pain} onChange={(e) => setPain(e.target.value)} /></Field>
          <label className="row" style={{ height: 40 }}><input type="checkbox" checked={ponv} onChange={(e) => setPonv(e.target.checked)} /> გულისრევა / ღებინება (PONV)</label>
        </div>
        <Field label="შენიშვნა" htmlFor="ps-n"><input id="ps-n" className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
      <ErrorBox error={m.error} />
    </Modal>
  );
}

function DischargeDialog({ p, onClose }: { p: Pacu; onClose: () => void }) {
  const qc = useQueryClient(); const toast = useToast();
  const deps = useQuery({ queryKey: ['departments'], queryFn: () => api<{ id: string; name: string; type: string; is_active: boolean; care_level: string | null }[]>('/departments') });
  const curIcu = ['icu', 'intensive'].includes(p.current_department?.care_level ?? '');
  const [f, setF] = useState({ destination: 'ward', to_department_id: '', date: todayISO(), time: nowHM(), note: '' });
  const icuDeps = (deps.data ?? []).filter((d) => d.is_active && d.type === 'inpatient' && ['icu', 'intensive'].includes(d.care_level ?? ''));
  const wardDeps = (deps.data ?? []).filter((d) => d.is_active && d.type === 'inpatient' && !['icu', 'intensive'].includes(d.care_level ?? '') && d.id !== p.current_department?.id);
  const m = useMutation({
    mutationFn: () => api<Pacu>(`/or/cases/${p.case_id}/pacu/discharge`, { body: { destination: f.destination, at: localISO(f.date, f.time), to_department_id: f.to_department_id || undefined, note: f.note.trim() || undefined } }),
    onSuccess: (r) => { invalOr(qc); if (r.warnings?.length) toast.show(r.warnings[0]); onClose(); },
  });
  const low = f.destination !== 'icu' && !p.ready;
  const needDep = f.destination === 'icu' && !curIcu && !f.to_department_id;
  return (
    <Modal title="PACU-დან გამოწერა" onClose={onClose} footer={<><button className="btn" type="button" onClick={onClose}>დახურვა</button>
      <button className="btn primary" type="button" disabled={low || needDep || m.isPending} onClick={() => m.mutate()}>გამოწერა</button></>}>
      {toast.node}
      <div className="seg" role="group" aria-label="მიმართულება">{Object.entries(PDEST_KA).map(([k, l]) =>
        <button key={k} type="button" aria-pressed={f.destination === k} onClick={() => setF({ ...f, destination: k, to_department_id: '' })}>{l}</button>)}</div>
      {low && <div className="alert warn">Aldrete {p.last_score ? `${p.last_score.total} < ${p.aldrete_min}` : '— შეფასება არ არის'} — განყოფილებაში / სხვაგან გამოწერა შეუძლებელია (ICU — ზღვრის გარეშე).</div>}
      {f.destination === 'icu' ? (curIcu ? <span className="small muted">პაციენტი უკვე რეანიმაციის განყოფილებაშია ({p.current_department?.name}).</span>
        : <Field label="რეანიმაციის განყოფილება (გადაყვანის მოთხოვნა)" htmlFor="pd-d" required><select id="pd-d" className="select" value={f.to_department_id} onChange={(e) => setF({ ...f, to_department_id: e.target.value })}>
          <option value="">—</option>{icuDeps.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>)
        : f.destination === 'ward' && <Field label="განყოფილება" htmlFor="pd-w" hint="ცარიელი — საკუთარ განყოფილებაში (გადაყვანის გარეშე)"><select id="pd-w" className="select" value={f.to_department_id}
          onChange={(e) => setF({ ...f, to_department_id: e.target.value })}><option value="">{p.current_department?.name ?? '—'} (საკუთარი)</option>
          {wardDeps.map((d) => <option key={d.id} value={d.id}>{d.name} — გადაყვანის მოთხოვნა</option>)}</select></Field>}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="თარიღი" htmlFor="pd-dt"><input id="pd-dt" className="input" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label="დრო" htmlFor="pd-tm"><input id="pd-tm" className="input" type="time" value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} /></Field>
      </div>
      <Field label="შენიშვნა" htmlFor="pd-n"><textarea id="pd-n" className="textarea" rows={2} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
      <ErrorBox error={m.error} />
    </Modal>
  );
}

function PacuGrid({ p, onSlot, onVoid }: { p: Pacu; onSlot: (iso: string) => void; onVoid: (v: PVit) => void }) {
  const g = p.grid_min * 60_000;
  const live = p.vitals.filter((v) => !v.voided_at);
  const edit = p.can.edit;
  const slots = useMemo(() => {
    const start = Math.floor(new Date(p.times.pacu_in!).getTime() / g) * g;
    const endT = p.times.pacu_out ? new Date(p.times.pacu_out).getTime() : Date.now();
    const xs: number[] = [];
    for (let t = start; t <= endT && xs.length < 96; t += g) xs.push(t);
    for (const v of live) { const t = new Date(v.recorded_at).getTime(); if (!xs.includes(t)) xs.push(t); }
    return xs.sort((a, b) => a - b);
  }, [p.times.pacu_in, p.times.pacu_out, g, live]);
  const byT = new Map(live.map((v) => [new Date(v.recorded_at).getTime(), v]));
  const lbl = (t: number) => hhmm(new Date(t).toISOString());
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="table" style={{ width: 'max-content', minWidth: '100%' }}>
        <thead><tr><th style={{ position: 'sticky', left: 0, background: 'var(--surface)', minWidth: 130 }} />
          {slots.map((t) => { const v = byT.get(t); return (
            <th key={t} className="mono" style={{ minWidth: 52, textAlign: 'center', padding: '4px 2px' }}>
              {v ? (edit ? <button type="button" className="btn sm" style={{ height: 24, padding: '0 4px' }} title="გაუქმება" onClick={() => onVoid(v)}>{lbl(t)}</button> : lbl(t))
                : edit ? <button type="button" className="btn sm" style={{ height: 24, padding: '0 4px' }} aria-label={`ვიტალები ${lbl(t)}`} onClick={() => onSlot(new Date(t).toISOString())}>+{lbl(t)}</button>
                  : <span className="muted">{lbl(t)}</span>}</th>); })}</tr></thead>
        <tbody>{PVROWS.map(([k, l, u]) => (
          <tr key={k}><td style={{ position: 'sticky', left: 0, background: 'var(--surface)' }} className="small"><strong>{l}</strong> <span className="muted">{u}</span></td>
            {slots.map((t) => { const v = byT.get(t)?.[k];
              const warn = (k === 'spo2' && typeof v === 'number' && v < 92) || (k === 'pain' && typeof v === 'number' && v >= 7);
              return <td key={t} className="mono" style={{ textAlign: 'center', padding: '4px 2px', color: warn ? 'var(--danger)' : undefined, fontWeight: warn ? 700 : undefined }}>
                {v === null || v === undefined ? '' : String(Number(v))}</td>; })}</tr>))}
        </tbody>
      </table>
      {p.vitals.some((v) => v.voided_at) && <div className="card-pad small muted">გაუქმებული: {p.vitals.filter((v) => v.voided_at).map((v) => `${hhmm(v.recorded_at)} (${v.void_reason})`).join('; ')}</div>}
    </div>
  );
}

function PVitalsDialog({ p, at, onClose }: { p: Pacu; at: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState<Record<string, string>>({}); const [o2, setO2] = useState(false);
  const m = useMutation({
    mutationFn: () => api(`/or/cases/${p.case_id}/pacu/vitals`, { body: { at, o2_supplement: o2, ...Object.fromEntries(Object.entries(f).filter(([, v]) => v.trim() !== '').map(([k, v]) => [k, k === 'notes' ? v : Number(v)])) } }),
    onSuccess: () => { invalOr(qc); onClose(); },
  });
  return (
    <Modal title={`PACU ვიტალები — ${hhmm(at)}`} onClose={onClose} width={560}
      footer={<><button className="btn" type="button" onClick={onClose}>დახურვა</button><button className="btn primary" type="button" disabled={m.isPending} onClick={() => m.mutate()}>შენახვა</button></>}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
        {PVROWS.map(([k, l, u]) => <Field key={k} label={`${l} (${u})`} htmlFor={`pv-${k}`}><input id={`pv-${k}`} className="input mono" type="number" step={k === 'temperature' ? '0.1' : '1'}
          value={f[k] ?? ''} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>)}
      </div>
      <label className="row"><input type="checkbox" checked={o2} onChange={(e) => setO2(e.target.checked)} /> ჟანგბადზე</label>
      <Field label="შენიშვნა" htmlFor="pv-n"><input id="pv-n" className="input" value={f.notes ?? ''} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      <ErrorBox error={m.error} />
    </Modal>
  );
}

function PacuFluids({ p, onVoid }: { p: Pacu; onVoid: (id: string) => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ category: 'iv', volume_ml: '', time: nowHM(), note: '' });
  const add = useMutation({ mutationFn: () => api(`/or/cases/${p.case_id}/pacu/fluids`, { body: { category: f.category, volume_ml: Number(f.volume_ml), at: localISO(todayISO(), f.time), note: f.note || undefined } }),
    onSuccess: () => { invalOr(qc); setF({ ...f, volume_ml: '', note: '' }); } });
  return (
    <>
      <table className="table"><tbody>
        {p.fluids.map((x) => (
          <tr key={x.id} style={x.voided_at ? { opacity: 0.5 } : undefined}>
            <td className="mono" style={{ width: 60 }}>{hhmm(x.recorded_at)}</td><td>{PFLUID_KA[x.category] ?? x.category}{x.note && <div className="small muted">{x.note}</div>}</td>
            <td className="mono" style={{ textAlign: 'right' }}>{x.direction === 'in' ? '+' : '−'}{Number(x.volume_ml)} მლ</td>
            <td style={{ width: 40 }}>{x.voided_at ? <span className="small muted" title={x.void_reason ?? ''}>გაუქმ.</span>
              : p.can.edit && <button className="btn sm" type="button" aria-label="გაუქმება" onClick={() => onVoid(x.id)}>×</button>}</td></tr>))}
        {!p.fluids.length && <tr><td className="muted small">—</td></tr>}
      </tbody></table>
      {p.can.edit && <div className="card-pad row" style={{ flexWrap: 'wrap', gap: 8, borderTop: '1px solid var(--line-soft)' }}>
        <select className="select" aria-label="კატეგორია" style={{ maxWidth: 220 }} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
          <optgroup label="მიღება">{['iv', 'blood', 'po', 'other_in'].map((k) => <option key={k} value={k}>{PFLUID_KA[k]}</option>)}</optgroup>
          <optgroup label="გამოყოფა">{['urine', 'drain', 'vomit', 'blood_loss', 'other_out'].map((k) => <option key={k} value={k}>{PFLUID_KA[k]}</option>)}</optgroup></select>
        <input className="input mono" aria-label="მოცულობა (მლ)" placeholder="მლ" type="number" style={{ width: 90 }} value={f.volume_ml} onChange={(e) => setF({ ...f, volume_ml: e.target.value })} />
        <input className="input" aria-label="დრო" type="time" style={{ width: 110 }} value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} />
        <input className="input grow" aria-label="შენიშვნა" placeholder="შენიშვნა" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
        <button className="btn sm primary" type="button" disabled={!(Number(f.volume_ml) > 0) || add.isPending} onClick={() => add.mutate()}>დამატება</button>
        <ErrorBox error={add.error} />
      </div>}
    </>
  );
}

// ================================================================= ბილინგი — ოპერაციის ბარათის ჩანართი
interface OrBill {
  case_id: string; status: string; encounter_id: string | null; invoice: { id: string; invoice_number: string; finalized_at: string | null } | null; finalized: boolean;
  lines: { id: string; category: string; description: string; quantity: number; unit_price: string | null; original_price: string | null; line_total: string | null; package_included: boolean;
    discount_reason: string | null; tariff_code: string | null }[];
  total: string | null; missing: string[]; synced_at: string | null; anesthesia: { type: string | null; minutes: number | null; units: number | null } | null;
  settings: { multi_procedure_billing: string; multi_procedure_pct: number; anesthesia_billing: string; anesthesia_round_min: number }; can: { amounts: boolean };
}
export function BillingTab({ c }: { c: CaseDetail }) {
  const q = useQuery({ queryKey: ['or-billing', c.id], queryFn: () => api<OrBill>(`/or/cases/${c.id}/billing`) });
  const b = q.data;
  if (q.isLoading) return <Loading />;
  if (!b) return <ErrorBox error={q.error} />;
  const s = b.settings;
  return (
    <div className="stack">
      {b.status !== 'completed' ? <div className="alert info">ოპერაციის ტარიფი / ანესთეზია ინვოისში ემატება დასრულებისას („საოპერაციოდან გავიდა“).</div> : <>
        {b.missing.length > 0 && <div className="alert danger"><div className="stack" style={{ gap: 2 }}><strong>ტარიფის გარეშე — სტაციონარის ფინანსური დახურვა დაბლოკილია:</strong>
          {b.missing.map((m) => <span key={m}>• {m}</span>)}<span className="small">ტარიფები: <Link to="/admin/or">ადმინისტრირება → საოპერაციო</Link> (კატალოგი / ანესთეზიის ტარიფები).</span></div></div>}
        {b.finalized && <div className="alert info">ინვოისი ფინალიზებულია — ხაზები აღარ იცვლება (გახსნა — ბილინგი).</div>}
        <section className="card">
          <div className="card-head"><h2 className="grow">ინვოისის ხაზები — ოპერაცია {c.case_no}</h2>
            {b.invoice && <span className="mono small">{b.invoice.invoice_number}</span>}
            {b.encounter_id && <Link className="btn sm" to={`/inpatient/stay/${b.encounter_id}#billing`}>ჰოსპიტალიზაციის ბილინგი</Link>}</div>
          <table className="table">
            <thead><tr><th>კატეგორია</th><th>აღწერა</th><th style={{ textAlign: 'right' }}>რაოდ.</th>{b.can.amounts && <><th style={{ textAlign: 'right' }}>ფასი</th><th style={{ textAlign: 'right' }}>ჯამი</th></>}<th /></tr></thead>
            <tbody>{b.lines.map((l) => (
              <tr key={l.id}><td><span className={`chip ${l.category === 'surgery' ? 'info' : ''}`}>{l.category === 'surgery' ? 'ოპერაცია' : 'ანესთეზია'}</span></td>
                <td>{l.description}{l.tariff_code && <span className="small muted mono"> · {l.tariff_code}</span>}{b.can.amounts && l.discount_reason && <div className="small muted">{l.discount_reason}</div>}</td>
                <td className="mono" style={{ textAlign: 'right' }}>{l.quantity}</td>
                {b.can.amounts && <><td className="mono" style={{ textAlign: 'right' }}>{money(l.unit_price)}{l.original_price && Number(l.original_price) !== Number(l.unit_price) && <div className="small muted"><s>{money(l.original_price)}</s></div>}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{money(l.line_total)}</td></>}
                <td>{l.package_included && <span className="chip ok">პაკეტში</span>}</td></tr>))}
              {!b.lines.length && <tr><td colSpan={6} className="muted small">ხაზი არ არის</td></tr>}</tbody>
            {b.can.amounts && b.lines.length > 0 && <tfoot><tr><td colSpan={4} style={{ textAlign: 'right' }}><strong>ჯამი (პაკეტის გარეშე)</strong></td><td className="mono" style={{ textAlign: 'right' }}><strong>{money(b.total)}</strong></td><td /></tr></tfoot>}
          </table>
          <div className="card-pad small muted">
            რამდენიმე პროცედურა: {s.multi_procedure_billing === 'all' ? 'ყველა — სრული ტარიფით' : `ძირითადი — სრული, დანარჩენი — ${s.multi_procedure_pct}%`} (ხელმოწერილი ოქმიდან, თუ არ არის — მოთხოვნიდან).
            {' '}ანესთეზია: {s.anesthesia_billing === 'fixed' ? 'ფიქსირებული (ტიპზე)' : s.anesthesia_billing === 'hourly' ? `საათობრივი, დამრგვალება ${s.anesthesia_round_min} წთ` : 'არ ერიცხება'}
            {b.anesthesia?.type && <> — {ANESTHESIA_KA[b.anesthesia.type] ?? b.anesthesia.type}{b.anesthesia.minutes !== null && <>, {b.anesthesia.minutes} წთ{b.anesthesia.units ? ` → ${b.anesthesia.units} × ${s.anesthesia_round_min} წთ` : ''}</>}</>}.
            {' '}მასალები / იმპლანტები / მედიკამენტები — ჩამოწერისას, კატეგორიის წესით.
          </div>
        </section>
      </>}
    </div>
  );
}

// ================================================================= PACU-ს დაფა (საოპერაციო → PACU)
interface PacuBoardT { aldrete_min: number; grid_min: number; now: string; rows: { id: string; case_no: string; encounter_id: string; anesthesia_type: string; needs_icu: boolean; first_name: string; last_name: string;
  gender: string; age: number; room_code: string | null; bay: string | null; nurse_name: string | null; surgeon_name: string; procedures: string | null; out_of_room: string | null; pacu_in: string | null;
  last_vitals: string | null; last_pain: number | null; aldrete: number | null; admitted: boolean; minutes: number | null; vitals_overdue: boolean; ready: boolean }[] }
export function PacuBoard() {
  const setup = useOrSetup(); const [block, setBlock] = useState('');
  const q = useQuery({ queryKey: ['or-pacu-board', block], queryFn: () => api<PacuBoardT>('/or/pacu', { query: { block_id: block || undefined } }), refetchInterval: 30_000 });
  const d = q.data; const blocks = setup.data?.blocks ?? [];
  const inn = d?.rows.filter((r) => r.admitted) ?? []; const exp = d?.rows.filter((r) => !r.admitted) ?? [];
  return (
    <div className="content">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <span className="hint grow">გამოღვიძების განყოფილება: ვიტალები ყოველ {d?.grid_min ?? 15} წთ, ტკივილი, Aldrete; გამოწერა — Aldrete ≥ {d?.aldrete_min ?? 9} (ICU — ზღვრის გარეშე).</span>
        {blocks.length > 1 && <select className="select" style={{ maxWidth: 240, height: 38 }} aria-label="ბლოკი" value={block} onChange={(e) => setBlock(e.target.value)}>
          <option value="">ყველა ბლოკი</option>{blocks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>}
      </div>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : <>
        <section className="card">
          <div className="card-head"><h2 className="grow">PACU-ში</h2><span className="chip">{inn.length}</span></div>
          <table className="table">
            <thead><tr><th>პაციენტი</th><th>ოპერაცია</th><th>ადგილი / ექთანი</th><th>PACU-ში</th><th>ბოლო ვიტალები</th><th>ტკივილი</th><th>Aldrete</th></tr></thead>
            <tbody>{inn.map((r) => (
              <tr key={r.id}>
                <td><Link to={`${caseLink(r.id)}?tab=pacu`}><strong>{r.last_name} {r.first_name}</strong></Link><div className="small muted">{genderShort(r.gender)} · {r.age} · <span className="mono">{r.case_no}</span></div></td>
                <td className="small">{r.procedures}<div className="muted">{r.surgeon_name} · {ANESTHESIA_KA[r.anesthesia_type]}{r.room_code ? ` · ${r.room_code}` : ''}</div>{r.needs_icu && <span className="chip warn">ICU საწოლი</span>}</td>
                <td className="small">{r.bay ?? '—'}<div className="muted">{r.nurse_name ?? ''}</div></td>
                <td className="mono">{r.pacu_in ? hhmm(r.pacu_in) : '—'}<div className="small muted">{r.minutes ?? ''} წთ</div></td>
                <td className="mono">{r.last_vitals ? hhmm(r.last_vitals) : '—'}{r.vitals_overdue && <div><span className="chip warn">დაგვიანება</span></div>}</td>
                <td className="mono" style={{ color: (r.last_pain ?? 0) >= 7 ? 'var(--danger)' : undefined }}>{r.last_pain ?? '—'}</td>
                <td>{r.aldrete === null ? <span className="chip">—</span> : <span className={`chip ${r.ready ? 'ok' : 'warn'}`}>{r.aldrete}{r.ready ? ' · მზადაა' : ''}</span>}</td>
              </tr>))}
              {!inn.length && <tr><td colSpan={7} className="empty">PACU-ში პაციენტი არ არის</td></tr>}</tbody>
          </table>
        </section>
        {exp.length > 0 && <section className="card">
          <div className="card-head"><h2 className="grow">მოსალოდნელი (ოთახიდან „PACU“)</h2><span className="chip">{exp.length}</span></div>
          <table className="table"><tbody>{exp.map((r) => (
            <tr key={r.id}><td><Link to={`${caseLink(r.id)}?tab=pacu`}><strong>{r.last_name} {r.first_name}</strong></Link> <span className="mono small">{r.case_no}</span></td>
              <td className="small">{r.procedures}</td><td className="small">{r.room_code ?? ''} · გავიდა {r.out_of_room ? hhmm(r.out_of_room) : '—'}</td></tr>))}</tbody></table>
        </section>}
      </>}
    </div>
  );
}

// ================================================================= სტატისტიკა (საოპერაციო → სტატისტიკა)
interface OrStatsT {
  from: string; to: string; days: number; tolerance_min: number; turnover_target_min: number;
  totals: { completed: number; in_progress: number; emergency: number; avg_room_min: number | null; avg_surgery_min: number | null; avg_anesthesia_min: number | null };
  utilization: { rooms: { room_id: string; code: string; name: string; block_name: string; cases: number; available_min: number; used_min: number; utilization_pct: number | null }[];
    available_min: number; used_min: number; utilization_pct: number | null };
  first_case: { total: number; on_time: number; on_time_pct: number | null; avg_delay_late_min: number | null;
    late: { case_id: string; case_no: string; room_code: string; day: string; scheduled_start: string; in_room: string; delay_min: number }[] };
  turnover: { count: number; avg_min: number | null; median_min: number | null; over_target: number; list: { room_code: string; day: string; from_case: string; to_case: string; minutes: number }[] };
  cancellations: { total: number; same_day: number; postponed: number; scheduled: number; cancel_pct: number | null; by_reason: { code: string; name: string; n: number; same_day: number }[] };
  complications: { cases: number; rate_pct: number | null; surgical: number; anesthesia: number; pacu: number;
    list: { case_id: string; case_no: string; day: string; surgeon_name: string; surgical: string | null; anesthesia: string | null; pacu: string | null }[] };
  pacu: { admitted: number; discharged: number; avg_los_min: number | null; avg_discharge_aldrete: number | null; ponv: number; destinations: { ward: number; icu: number; other: number } };
  by_surgeon: { surgeon_id: string; surgeon_name: string; cases: number; avg_room_min: number | null; complications: number }[];
}
const Tile = ({ l, v, sub, tone }: { l: string; v: ReactNode; sub?: ReactNode; tone?: 'ok' | 'warn' | 'danger' }) => (
  <div className="card card-pad" style={{ minWidth: 0, borderTop: tone ? `3px solid var(--${tone}-line, var(--${tone}))` : undefined }}>
    <span className="label">{l}</span><div style={{ fontSize: 24, fontWeight: 700, lineHeight: 1.2 }}>{v}</div>{sub && <span className="small muted">{sub}</span>}</div>);
const Bar = ({ pct }: { pct: number | null }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><div style={{ flex: 1, height: 8, borderRadius: 4, background: 'var(--line-soft)', minWidth: 80 }}>
    <div style={{ width: `${Math.min(100, pct ?? 0)}%`, height: '100%', borderRadius: 4, background: (pct ?? 0) > 85 ? 'var(--warn-line, #d9a400)' : 'var(--info-line, #3b82f6)' }} /></div>
    <span className="mono small" style={{ width: 46, textAlign: 'right' }}>{pct ?? '—'}%</span></div>);
const hm2 = (m: number | null) => (m === null ? '—' : `${Math.floor(m / 60)}:${String(Math.round(m % 60)).padStart(2, '0')}`);

export function OrStats() {
  const setup = useOrSetup();
  const [from, setFrom] = useState(shiftDay(todayISO(), -29)); const [to, setTo] = useState(todayISO()); const [block, setBlock] = useState('');
  const q = useQuery({ queryKey: ['or-stats', from, to, block], queryFn: () => api<OrStatsT>('/or/stats', { query: { from, to, block_id: block || undefined } }) });
  const s = q.data; const blocks = setup.data?.blocks ?? [];
  const C = { textAlign: 'center' } as const;
  return (
    <div className="content">
      <div className="row" style={{ gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <Field label="დან" htmlFor="os-f"><input id="os-f" className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="მდე" htmlFor="os-t"><input id="os-t" className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        {blocks.length > 1 && <Field label="ბლოკი" htmlFor="os-b"><select id="os-b" className="select" value={block} onChange={(e) => setBlock(e.target.value)}>
          <option value="">ყველა</option>{blocks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>}
      </div>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : s && <>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
          <Tile l="დასრულებული ოპერაცია" v={s.totals.completed} sub={`გადაუდებელი ${s.totals.emergency}${s.totals.in_progress ? ` · მიმდინარე ${s.totals.in_progress}` : ''}`} />
          <Tile l="ოთახების დატვირთვა" v={`${s.utilization.utilization_pct ?? '—'}%`} sub={`${hm2(s.utilization.used_min)} / ${hm2(s.utilization.available_min)} სთ`} />
          <Tile l="პირველი ოპერაცია დროულად" v={`${s.first_case.on_time_pct ?? '—'}%`} sub={`${s.first_case.on_time} / ${s.first_case.total} · დაშვება ${s.tolerance_min} წთ`}
            tone={s.first_case.on_time_pct !== null && s.first_case.on_time_pct < 80 ? 'warn' : undefined} />
          <Tile l="მომზადების დრო (turnover)" v={s.turnover.avg_min !== null ? `${s.turnover.avg_min} წთ` : '—'} sub={`მედიანა ${s.turnover.median_min ?? '—'} · > ${s.turnover_target_min} წთ: ${s.turnover.over_target}`} />
          <Tile l="გაუქმება" v={`${s.cancellations.cancel_pct ?? 0}%`} sub={`${s.cancellations.total} (იმავე დღეს ${s.cancellations.same_day}) · გადადება ${s.cancellations.postponed}`} />
          <Tile l="გართულებები" v={`${s.complications.rate_pct ?? 0}%`} sub={`${s.complications.cases} შემთხვევა`} tone={s.complications.cases ? 'danger' : undefined} />
          <Tile l="PACU — საშ. ხანგრძლივობა" v={s.pacu.avg_los_min !== null ? `${s.pacu.avg_los_min} წთ` : '—'} sub={`${s.pacu.admitted} პაც. · PONV ${s.pacu.ponv}`} />
        </div>
        <div className="row" style={{ gap: 14, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <section className="card" style={{ flex: '2 1 480px' }}>
            <div className="card-head"><h2 className="grow">დატვირთვა ოთახებზე</h2><span className="small muted">სამუშაო საათებში</span></div>
            <table className="table"><thead><tr><th>ოთახი</th><th style={C}>ოპ.</th><th style={C}>გამოყენ. / ხელმისაწვ.</th><th style={{ width: 220 }}>დატვირთვა</th></tr></thead>
              <tbody>{s.utilization.rooms.map((r) => <tr key={r.room_id}><td><strong className="mono">{r.code}</strong> {r.name}<div className="small muted">{r.block_name}</div></td>
                <td className="mono" style={C}>{r.cases}</td><td className="mono" style={C}>{hm2(r.used_min)} / {hm2(r.available_min)}</td><td><Bar pct={r.utilization_pct} /></td></tr>)}
                {!s.utilization.rooms.length && <tr><td colSpan={4} className="muted">ოთახი არ არის</td></tr>}</tbody></table>
          </section>
          <section className="card" style={{ flex: '1 1 300px' }}>
            <div className="card-head"><h2 className="grow">საშუალო ხანგრძლივობა</h2></div>
            <table className="table"><tbody>
              <tr><td>ოთახში (შემოვიდა → გავიდა)</td><td className="mono">{s.totals.avg_room_min ?? '—'} წთ</td></tr>
              <tr><td>ოპერაცია (განაკვეთი → ნაკერი)</td><td className="mono">{s.totals.avg_surgery_min ?? '—'} წთ</td></tr>
              <tr><td>ანესთეზია</td><td className="mono">{s.totals.avg_anesthesia_min ?? '—'} წთ</td></tr>
              <tr><td>PACU → განყოფილება / ICU / სხვა</td><td className="mono">{s.pacu.destinations.ward} / {s.pacu.destinations.icu} / {s.pacu.destinations.other}</td></tr>
              <tr><td>PACU — საშ. Aldrete გამოწერისას</td><td className="mono">{s.pacu.avg_discharge_aldrete ?? '—'}</td></tr>
            </tbody></table>
          </section>
        </div>
        <div className="row" style={{ gap: 14, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <section className="card" style={{ flex: '1 1 380px' }}>
            <div className="card-head"><h2 className="grow">პირველი ოპერაცია — დაგვიანებით</h2>{s.first_case.avg_delay_late_min !== null && <span className="small muted">საშ. {s.first_case.avg_delay_late_min} წთ</span>}</div>
            <table className="table"><tbody>{s.first_case.late.map((x) => <tr key={x.case_id}><td className="mono small">{dateGe(x.day)}</td><td className="mono">{x.room_code}</td>
              <td><Link to={caseLink(x.case_id)} className="mono small">{x.case_no}</Link></td><td className="mono small">{hhmm(x.scheduled_start)} → {hhmm(x.in_room)}</td>
              <td><span className="chip warn">+{x.delay_min} წთ</span></td></tr>)}
              {!s.first_case.late.length && <tr><td className="muted small">დაგვიანება არ ყოფილა</td></tr>}</tbody></table>
          </section>
          <section className="card" style={{ flex: '1 1 300px' }}>
            <div className="card-head"><h2 className="grow">გაუქმებები — მიზეზით</h2><span className="chip">{s.cancellations.total}</span></div>
            <table className="table"><tbody>{s.cancellations.by_reason.map((r) => <tr key={r.code}><td>{r.name}</td><td className="mono" style={C}>{r.n}</td>
              <td className="small muted">{r.same_day ? `იმავე დღეს ${r.same_day}` : ''}</td></tr>)}
              {!s.cancellations.by_reason.length && <tr><td className="muted small">—</td></tr>}</tbody></table>
          </section>
          <section className="card" style={{ flex: '1 1 300px' }}>
            <div className="card-head"><h2 className="grow">მომზადების დრო — ყველაზე გრძელი</h2></div>
            <table className="table"><tbody>{s.turnover.list.slice(0, 10).map((t, i) => <tr key={i}><td className="mono small">{dateGe(t.day)}</td><td className="mono">{t.room_code}</td>
              <td className="mono small">{t.from_case} → {t.to_case}</td><td><span className={`chip ${t.minutes > s.turnover_target_min ? 'warn' : ''}`}>{t.minutes} წთ</span></td></tr>)}
              {!s.turnover.list.length && <tr><td className="muted small">—</td></tr>}</tbody></table>
          </section>
        </div>
        <div className="row" style={{ gap: 14, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <section className="card" style={{ flex: '2 1 480px' }}>
            <div className="card-head"><h2 className="grow">გართულებები</h2><span className="small muted">ქირურგიული {s.complications.surgical} · ანესთეზიური {s.complications.anesthesia} · PACU {s.complications.pacu}</span></div>
            <table className="table"><tbody>{s.complications.list.map((x) => <tr key={x.case_id}><td className="mono small">{dateGe(x.day)}</td>
              <td><Link to={caseLink(x.case_id)} className="mono small">{x.case_no}</Link><div className="small muted">{x.surgeon_name}</div></td>
              <td className="small">{[x.surgical && `ქირ.: ${x.surgical}`, x.anesthesia && `ანესთ.: ${x.anesthesia}`, x.pacu && `PACU: ${x.pacu}`].filter(Boolean).map((t) => <div key={t as string}>{t}</div>)}</td></tr>)}
              {!s.complications.list.length && <tr><td className="muted small">გართულება არ დაფიქსირებულა</td></tr>}</tbody></table>
          </section>
          <section className="card" style={{ flex: '1 1 320px' }}>
            <div className="card-head"><h2 className="grow">ქირურგები</h2></div>
            <table className="table"><thead><tr><th>ქირურგი</th><th style={C}>ოპ.</th><th style={C}>საშ. წთ</th><th style={C}>გართ.</th></tr></thead>
              <tbody>{s.by_surgeon.map((x) => <tr key={x.surgeon_id}><td>{x.surgeon_name}</td><td className="mono" style={C}>{x.cases}</td><td className="mono" style={C}>{x.avg_room_min ?? '—'}</td>
                <td className="mono" style={C}>{x.complications || ''}</td></tr>)}
                {!s.by_surgeon.length && <tr><td colSpan={4} className="muted small">—</td></tr>}</tbody></table>
          </section>
        </div>
        <span className="small muted">დატვირთვა — ოთახში ფაქტობრივი დრო სამუშაო საათების ფარგლებში / სამუშაო დღეების საათები. პირველი ოპერაცია — ოთახი × დღე, დაგეგმილი პირველი (გადაუდებლის გარეშე), „შემოვიდა“ ≤ დაგეგმილი + {s.tolerance_min} წთ.
          მომზადების დრო — იმავე ოთახში წინა „გავიდა“ → შემდეგი „შემოვიდა“ (≤ 180 წთ). გართულებები — ხელმოწერილი ოქმი, ანესთეზიის რუკა, PACU.</span>
      </>}
    </div>
  );
}

// ================================================================= ადმინისტრირება → საოპერაციო → ანესთეზიის ტარიფები
interface AT { anesthesia_type: string; mode: 'fixed' | 'hourly'; tariff_id: string; tariff_code: string; tariff_title: string; base_price: string; is_active: boolean }
export function AnesthesiaTariffs() {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['or-anesthesia-tariffs'], queryFn: () => api<AT[]>('/or/anesthesia-tariffs') });
  const tariffs = useQuery({ queryKey: ['tariffs', 'all'], queryFn: () => api<{ id: string; code: string; title: string; base_price: string; is_active: boolean }[]>('/tariffs') });
  const [edit, setEdit] = useState<Record<string, string> | null>(null); const [reason, setReason] = useState('');
  const cur = useMemo(() => Object.fromEntries((q.data ?? []).map((r) => [`${r.anesthesia_type}:${r.mode}`, r.tariff_id])), [q.data]);
  const vals = edit ?? cur;
  const save = useMutation({
    mutationFn: () => api('/or/anesthesia-tariffs', { method: 'PUT', body: { reason: reason.trim(), items: Object.keys(ANESTHESIA_KA).flatMap((t) => (['fixed', 'hourly'] as const).map((m) => ({
      anesthesia_type: t, mode: m, tariff_id: vals[`${t}:${m}`] || null }))) } }),
    onSuccess: () => { toast.show('შენახულია'); setEdit(null); setReason(''); void qc.invalidateQueries({ queryKey: ['or-anesthesia-tariffs'] }); },
  });
  const opts = (tariffs.data ?? []).filter((t) => t.is_active);
  const sel = (k: string) => (
    <select className="select" aria-label={k} value={vals[k] ?? ''} onChange={(e) => setEdit({ ...vals, [k]: e.target.value })}>
      <option value="">—</option>{opts.map((t) => <option key={t.id} value={t.id}>{t.code} — {t.title} ({Number(t.base_price).toFixed(2)} ₾)</option>)}</select>);
  return (
    <section className="card">
      {toast.node}
      <div className="card-head"><h2 className="grow">ანესთეზიის ტარიფები</h2></div>
      <div className="card-pad small muted">ფიქსირებული — ერთი ტარიფი ანესთეზიის ტიპზე; საათობრივი — 1 საათის ფასი (ინვოისში: ბლოკი × ფასი, დამრგვალება ზემოთ). რომელი გამოიყენება — <Link to="/admin/modules">მოდულები → საოპერაციო</Link>.
        ადგილობრივი / „გარეშე“ — ტარიფის გარეშეც დასაშვებია.</div>
      {q.isLoading ? <Loading /> : <table className="table">
        <thead><tr><th>ტიპი</th><th>ფიქსირებული</th><th>საათობრივი (1 სთ)</th></tr></thead>
        <tbody>{Object.entries(ANESTHESIA_KA).map(([t, l]) => <tr key={t}><td><strong>{l}</strong></td><td>{sel(`${t}:fixed`)}</td><td>{sel(`${t}:hourly`)}</td></tr>)}</tbody>
      </table>}
      {edit && <div className="card-pad row" style={{ gap: 8, borderTop: '1px solid var(--line-soft)' }}>
        <input className="input grow" aria-label="ცვლილების მიზეზი" placeholder="ცვლილების მიზეზი (სავალდებულო)" value={reason} onChange={(e) => setReason(e.target.value)} />
        <button className="btn" type="button" onClick={() => { setEdit(null); setReason(''); }}>გაუქმება</button>
        <button className="btn primary" type="button" disabled={reason.trim().length < 3 || save.isPending} onClick={() => save.mutate()}>შენახვა</button></div>}
      <div className="card-pad"><ErrorBox error={save.error ?? q.error} /></div>
    </section>
  );
}
