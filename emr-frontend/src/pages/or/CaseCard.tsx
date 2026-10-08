import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError, can } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Field, Loading, Modal, useToast } from '../../components/ui';
import { dateGe, genderShort, hhmm, localISO, todayISO } from '../../lib/format';
import { CancelDialog, invalOr, ReasonPrompt, RequestDialog, ScheduleDialog } from './Dialogs';
import { AnesthesiaTab, MaterialsTab, NoteTab } from './IntraOp';
import { ANESTHESIA_KA, CASE_ST, chip, DEST_KA, dt, EVENT_KA, GRP_KA, hm, PHASE_KA, RISK_KA, SIDE_KA, TIME_KA, TIME_KINDS, URGENCY, useOrModule, useOrSetup, WHO_KA,
  type CaseDetail, type CaseRow, type Preop, type TeamMember, type TimeKind } from './types';

const TABS: [string, string][] = [['overview', 'მიმოხილვა'], ['team', 'გუნდი'], ['preop', 'წინასაოპერაციო'], ['who', 'WHO ჩეკლისტი'], ['times', 'ნიშნულები'],
  ['anesthesia', 'ანესთეზია'], ['materials', 'მასალები / დათვლა'], ['note', 'ოქმი'], ['history', 'ისტორია']];
const GRP_RIGHT = (c: CaseDetail, g: string) => (g === 'anesthesia' ? c.can.team_anesthesia : g === 'nursing' ? c.can.team_nursing : c.can.team_surgical);

/** ოპერაციის ბარათი (0048 + 0049: ანესთეზიის რუკა, მასალები / დათვლა / CSSD, ოქმი) */
export default function CaseCard() {
  const { id } = useParams(); const nav = useNavigate(); const [sp, setSp] = useSearchParams();
  const q = useQuery({ queryKey: ['or-case', id], queryFn: () => api<CaseDetail>(`/or/cases/${id}`), refetchInterval: 30_000 });
  const tab = sp.get('tab') ?? 'overview';
  const c = q.data;
  if (q.isLoading) return <div className="content"><Loading /></div>;
  if (!c) return <div className="content"><ErrorBox error={q.error} /></div>;
  const curTimes = c.times.filter((t) => !t.superseded_by);
  const whoDone = (p: string) => c.who.some((w) => w.phase === p && !w.voided_at);
  const badge: Record<string, ReactNode> = {
    preop: c.readiness.ready ? <span className="chip ok" style={{ height: 18 }}>✓</span> : <span className="chip warn" style={{ height: 18 }}>{c.readiness.missing.length}</span>,
    who: <span className="chip" style={{ height: 18 }}>{['sign_in', 'time_out', 'sign_out'].filter(whoDone).length}/3</span>,
    team: <span className="chip" style={{ height: 18 }}>{c.team.filter((t) => !t.removed_at && !t.out_at).length}</span>,
    anesthesia: c.progress.anesthesia === 'signed' ? <span className="chip ok" style={{ height: 18 }}>✓</span> : c.progress.anesthesia ? <span className="chip warn" style={{ height: 18 }}>…</span> : null,
    note: c.progress.note?.status === 'signed' ? <span className="chip ok" style={{ height: 18 }}>v{c.progress.note.version}</span> : c.progress.note ? <span className="chip warn" style={{ height: 18 }}>შავი</span> : null,
    materials: c.progress.items_unposted ? <span className="chip warn" style={{ height: 18 }}>{c.progress.items_unposted}</span> : c.progress.items_total ? <span className="chip ok" style={{ height: 18 }}>✓</span> : null,
  };
  return (
    <>
      <header className="topbar" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8, paddingBottom: 0 }}>
        <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
          <button className="btn sm" type="button" onClick={() => nav(-1)}>←</button>
          <h1 style={{ margin: 0 }}>{c.last_name} {c.first_name}</h1>
          <span className="muted">{genderShort(c.gender)} · {c.age} · {dateGe(c.birth_date)} · {c.personal_number}</span>
          <span className="mono">{c.case_no}</span>
          {c.status === 'in_progress' && c.phase ? <span className="chip accent">{PHASE_KA[c.phase]}</span> : chip(CASE_ST, c.status)}{chip(URGENCY, c.urgency)}
          <span className="grow" />
          {c.encounter_id ? <Link className="btn sm" to={`/inpatient/stay/${c.encounter_id}`}>ჰოსპიტალიზაცია {c.adm_no}</Link> : c.plan_no && <span className="chip info">გეგმიური რიგი {c.plan_no}</span>}
          <Link className="btn sm" to={`/or?tab=board&date=${c.scheduled_start ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tbilisi' }).format(new Date(c.scheduled_start)) : todayISO()}`}>დაფა</Link>
        </div>
        <nav aria-label="ოპერაციის ბარათი" className="row" style={{ gap: 2, flexWrap: 'wrap' }}>
          {TABS.map(([k, l]) => <button key={k} type="button" className={`admin-tab${tab === k ? ' active' : ''}`} style={{ border: 0, background: 'none', font: 'inherit', cursor: 'pointer' }}
            onClick={() => { sp.set('tab', k); setSp(sp, { replace: true }); }}>{l} {badge[k]}</button>)}
        </nav>
      </header>
      <div className="content">
        {c.allergies.length > 0 && <div className="alert danger">ალერგია: {c.allergies.map((a) => a.substance).join(', ')}</div>}
        {c.warnings.map((w) => <div key={w} className="alert warn">{w}</div>)}
        {c.status === 'cancelled' && <div className="alert warn">გაუქმებულია {dt(c.cancelled_at)}: {c.cancel_reason_name}{c.cancel_note ? ` — ${c.cancel_note}` : ''}</div>}
        {c.locked_at && <div className="alert info">ოქმი ხელმოწერილია — გუნდი და ნიშნულები დაბლოკილია (დასაშვებია მხოლოდ: ანესთეზიის დასრულება, ოთახიდან გასვლა, PACU).</div>}
        {c.hints.map((h) => <div key={h} className="alert info small">{h}</div>)}
        {tab === 'team' ? <TeamTab c={c} /> : tab === 'preop' ? <PreopTab c={c} /> : tab === 'who' ? <WhoTab c={c} /> : tab === 'times' ? <TimesTab c={c} cur={curTimes} />
          : tab === 'anesthesia' ? <AnesthesiaTab c={c} /> : tab === 'materials' ? <MaterialsTab c={c} /> : tab === 'note' ? <NoteTab c={c} />
          : tab === 'history' ? <History c={c} /> : <Overview c={c} />}
      </div>
    </>
  );
}

// ================================================================= მიმოხილვა
function Overview({ c }: { c: CaseDetail }) {
  const { user } = useAuth(); const qc = useQueryClient(); const toast = useToast();
  const [dlg, setDlg] = useState<'edit' | 'schedule' | 'cancel' | 'postpone' | 'surgeon' | null>(null);
  const coord = can(user, 'admin', 'or_schedule');
  const confirm = useMutation({ mutationFn: (force: boolean) => api(`/or/cases/${c.id}/confirm`, { body: { confirm: force } }),
    onSuccess: () => { toast.show('დადასტურდა'); invalOr(qc); } });
  const confirmWarn = confirm.error instanceof ApiError && confirm.error.code === 'CONFIRM_REQUIRED' ? (confirm.error.body?.warnings as string[]) : null;
  const row = (l: string, v: ReactNode) => <div className="row" style={{ alignItems: 'flex-start' }}><span className="muted" style={{ width: 190, flexShrink: 0 }}>{l}</span><span className="grow">{v}</span></div>;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: 14 }}>
      {toast.node}
      <section className="card card-pad stack">
        <div className="row"><h2 className="grow">მოთხოვნა</h2>{c.can.edit && <button className="btn sm" type="button" onClick={() => setDlg('edit')}>შეცვლა</button>}</div>
        <table className="table"><tbody>{c.procedures.map((p) => (
          <tr key={p.id}><td><span className="mono small">{p.code}</span>{p.ncsp_code && <span className="small muted"> · NCSP {p.ncsp_code}</span>}<div>{p.name}</div></td>
            <td>{p.side !== 'na' ? <span className="chip warn">{SIDE_KA[p.side]}</span> : null}</td><td>{p.is_primary && <span className="chip info">ძირითადი</span>}</td></tr>))}</tbody></table>
        {row('დიაგნოზი', c.icd10_code ? <><span className="mono">{c.icd10_code}</span> {c.icd10_title}</> : '—')}
        {row('ოპერატორი ქირურგი', <span className="row" style={{ gap: 8 }}>{c.surgeon_name}{c.can.surgeon && <button className="btn sm" type="button" onClick={() => setDlg('surgeon')}>შეცვლა</button>}</span>)}
        {row('განყოფილება', c.department_name)}
        {row('ანესთეზია', ANESTHESIA_KA[c.anesthesia_type])}
        {row('ხანგრძლივობა', `${c.duration_min} წთ`)}
        {row('სასურველი დრო', c.preferred_date ? `${dateGe(c.preferred_date)}${c.preferred_time ? ` ${hm(c.preferred_time)}` : ''}` : '—')}
        {c.preferred_anesthesiologist_name && row('სასურველი ანესთეზიოლოგი', c.preferred_anesthesiologist_name)}
        {row('საჭიროებები', <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {c.needs_implant && <span className="chip">იმპლანტი</span>}{c.needs_blood && <span className="chip danger">სისხლი{c.blood_note ? `: ${c.blood_note}` : ''}</span>}
          {c.needs_icu && <span className="chip warn">ICU საწოლი</span>}{c.needs_equipment && <span className="chip">{c.needs_equipment}</span>}
          {!c.needs_implant && !c.needs_blood && !c.needs_icu && !c.needs_equipment && <span className="muted">—</span>}</div>)}
        {c.notes && row('შენიშვნა', c.notes)}
        {row('მოითხოვა', `${c.requested_by_name} · ${dt(c.requested_at)}`)}
      </section>
      <section className="card card-pad stack">
        <div className="row"><h2 className="grow">დაგეგმვა</h2>
          {c.can.schedule && <button className="btn sm primary" type="button" onClick={() => setDlg('schedule')}>{c.status === 'requested' ? 'დაგეგმვა' : 'გადატანა'}</button>}</div>
        {c.room_code ? <>
          {row('ოთახი', <strong>{c.room_code} — {c.room_name}</strong>)}
          {row('ბლოკი', c.block_name)}
          {row('დრო', <span className="mono">{dateGe(c.scheduled_start!.slice(0, 10))} {hhmm(c.scheduled_start!)}–{hhmm(c.scheduled_end!)}</span>)}
          {row('დაგეგმა', `${c.scheduled_by_name ?? '—'} · ${dt(c.scheduled_at)}`)}
          {c.schedule_warnings?.length ? <div className="alert warn small"><div className="stack" style={{ gap: 2 }}><strong>დადასტურებული გაფრთხილებები:</strong>{c.schedule_warnings.map((w) => <span key={w}>• {w}</span>)}</div></div> : null}
        </> : <span className="muted">{c.status === 'cancelled' ? '—' : `რიგშია${c.settings.or_scheduling === 'coordinator' && c.urgency !== 'emergency' ? ' — ოთახს / დროს ანიჭებს კოორდინატორი' : ''}`}</span>}
        {c.status === 'tentative' && <div className="alert warn">წინასწარი ჯავშანი — დასადასტურებელია (კოორდინატორი / ბლოკის უფროსი).</div>}
        {c.can.confirm && <button className="btn primary" type="button" disabled={confirm.isPending} onClick={() => confirm.mutate(false)}>ჯავშნის დადასტურება</button>}
        {confirmWarn && <div className="alert warn"><div className="stack" style={{ gap: 4 }}>{confirmWarn.map((w) => <span key={w}>• {w}</span>)}
          <button className="btn sm danger" type="button" onClick={() => confirm.mutate(true)}>გაფრთხილებით დადასტურება</button></div></div>}
        {!confirmWarn && <ErrorBox error={confirm.error} />}
        {c.readiness_override && <div className="alert warn small">მზადყოფნა — დასაბუთებით: {c.readiness_override}</div>}
        <div className="row" style={{ flexWrap: 'wrap', marginTop: 'auto' }}>
          {c.can.cancel && ['tentative', 'scheduled'].includes(c.status) && <button className="btn sm" type="button" onClick={() => setDlg('postpone')}>გადადება (რიგში)</button>}
          {c.can.cancel && <button className="btn sm danger" type="button" onClick={() => setDlg('cancel')}>გაუქმება</button>}
          {c.postpone_count > 0 && <span className="chip">გადაიდო ×{c.postpone_count}</span>}
        </div>
      </section>
      {dlg === 'edit' && <RequestDialog edit={c} onClose={() => setDlg(null)} />}
      {dlg === 'schedule' && <ScheduleDialog c={c} coordinator={coord} onClose={() => setDlg(null)} />}
      {dlg === 'cancel' && <CancelDialog id={c.id} title={`გაუქმება — ${c.case_no}`} onClose={() => setDlg(null)} />}
      {dlg === 'postpone' && <ReasonPrompt title={`გადადება — ${c.case_no}`} label="მიზეზი (ოთახი / დრო თავისუფლდება, მოთხოვნა რიგში ბრუნდება)" path={`/or/cases/${c.id}/unschedule`} onClose={() => setDlg(null)} />}
      {dlg === 'surgeon' && <SurgeonDialog c={c} onClose={() => setDlg(null)} />}
    </div>
  );
}

function SurgeonDialog({ c, onClose }: { c: CaseDetail; onClose: () => void }) {
  const qc = useQueryClient(); const [f, setF] = useState({ surgeon_id: '', reason: '' });
  const docs = useQuery({ queryKey: ['or-staff', 'doctor'], queryFn: () => api<{ id: string; name: string; department_name: string | null }[]>('/or/staff', { query: { cap: 'doctor' } }) });
  const m = useMutation({ mutationFn: () => api(`/or/cases/${c.id}/surgeon`, { body: f }), onSuccess: () => { invalOr(qc); onClose(); } });
  return (
    <Modal title="ოპერატორის შეცვლა" onClose={onClose} footer={<><button className="btn" type="button" onClick={onClose}>დახურვა</button>
      <button className="btn primary" type="button" disabled={!f.surgeon_id || f.reason.trim().length < 3 || m.isPending} onClick={() => m.mutate()}>შეცვლა</button></>}>
      <Field label="ახალი ოპერატორი" htmlFor="sg-s" required><select id="sg-s" className="select" value={f.surgeon_id} onChange={(e) => setF({ ...f, surgeon_id: e.target.value })}>
        <option value="">—</option>{docs.data?.filter((d) => d.id !== c.surgeon_id).map((d) => <option key={d.id} value={d.id}>{d.name}{d.department_name ? ` — ${d.department_name}` : ''}</option>)}</select></Field>
      <Field label="მიზეზი" htmlFor="sg-r" required><input id="sg-r" className="input" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
      <ErrorBox error={m.error} />
    </Modal>
  );
}

// ================================================================= გუნდი
function TeamTab({ c }: { c: CaseDetail }) {
  const qc = useQueryClient(); const setup = useOrSetup(); const mod = useOrModule();
  const [add, setAdd] = useState<{ role?: string; replaces?: TeamMember } | null>(null);
  const [rm, setRm] = useState<TeamMember | null>(null);
  const started = ['in_progress', 'completed'].includes(c.status);
  const active = c.team.filter((t) => !t.removed_at && !t.out_at);
  const past = c.team.filter((t) => t.removed_at || t.out_at);
  const canGrp = (g: string) => GRP_RIGHT(c, g);
  void qc;
  return (
    <div className="stack">
      <span className="hint">გუნდს აყალიბებს ოპერატორი ქირურგი, განყოფილების ხელმძღვანელი ან admin. ანესთეზიის ნაწილს — {mod.settings.anesthesia_team_by === 'anesthesia_head' ? 'ანესთეზიოლოგიის ხელმძღვანელი (ქირურგი — სასურველს მიუთითებს მოთხოვნაში)' : 'ქირურგი / განყოფილების ხელმძღვანელი'};
        საექთნოს — {{ surgeon: 'ქირურგი / განყოფილების ხელმძღვანელი', or_head_nurse: 'ბლოკის მთავარი ექთანი', both: 'ქირურგი / ხელმძღვანელი ან ბლოკის მთავარი ექთანი' }[mod.settings.nursing_team_by]}.
        {mod.settings.room_teams ? ' ოთახის დღის გუნდი ემატება ავტომატურად (ხელით დამატებულს / მოხსნილს არ ეხება).' : ''}
        {started ? ' ოპერაცია დაწყებულია — ცვლილება აღირიცხება დროით (შემოვიდა / გავიდა / ვინ შეცვალა).' : ''}</span>
      {(['surgical', 'anesthesia', 'nursing'] as const).map((g) => {
        const roles = (setup.data?.team_roles ?? []).filter((r) => r.grp === g);
        return (
          <section key={g} className="card">
            <div className="card-head"><h2 className="grow">{GRP_KA[g]}</h2>
              {canGrp(g) && roles.some((r) => r.code !== 'surgeon') && <button className="btn sm" type="button" onClick={() => setAdd({ role: roles.find((r) => r.code !== 'surgeon')?.code })}>+ დამატება</button>}</div>
            <table className="table"><tbody>
              {active.filter((t) => t.grp === g).map((t) => (
                <tr key={t.id}><td style={{ width: 220 }} className="muted">{t.role_name}</td><td><strong>{t.name}</strong>{t.auto && <span className="chip info" style={{ marginLeft: 6 }} title="ოთახის დღის გუნდიდან">ოთახის გუნდი</span>}</td>
                  <td className="small muted">{t.in_at ? `შემოვიდა ${hhmm(t.in_at)}` : `დაამატა ${t.added_by_name ?? ''}`}</td>
                  <td><div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                    {canGrp(g) && t.role_code !== 'surgeon' && <><button className="btn sm" type="button" onClick={() => setAdd({ role: t.role_code, replaces: t })}>შეცვლა</button>
                      <button className="btn sm" type="button" onClick={() => setRm(t)}>{started ? 'გავიდა' : 'მოხსნა'}</button></>}</div></td></tr>))}
              {!active.some((t) => t.grp === g) && <tr><td colSpan={4} className="muted small">—</td></tr>}
            </tbody></table>
          </section>);
      })}
      {past.length > 0 && <section className="card"><div className="card-head"><h2>ისტორია</h2></div><table className="table"><tbody>
        {past.map((t) => <tr key={t.id}><td className="muted" style={{ width: 220 }}>{t.role_name}</td><td>{t.name}</td>
          <td className="small">{t.out_at ? `${t.in_at ? `${hhmm(t.in_at)}–` : ''}${hhmm(t.out_at)} გავიდა` : `მოიხსნა ${dt(t.removed_at)}`}{t.replaced_by ? ' · შეიცვალა' : ''}{t.remove_reason ? ` · ${t.remove_reason}` : ''}</td></tr>)}
      </tbody></table></section>}
      {add && <TeamDialog c={c} role={add.role} replaces={add.replaces} started={started} onClose={() => setAdd(null)} />}
      {rm && <TeamRemoveDialog t={rm} started={started} onClose={() => setRm(null)} />}
    </div>
  );
}

function TeamDialog({ c, role: r0, replaces, started, onClose }: { c: CaseDetail; role?: string; replaces?: TeamMember; started: boolean; onClose: () => void }) {
  const qc = useQueryClient(); const setup = useOrSetup();
  const roles = (setup.data?.team_roles ?? []).filter((r) => r.code !== 'surgeon' && GRP_RIGHT(c, r.grp));
  const [role, setRole] = useState(r0 ?? roles[0]?.code ?? '');
  const def = roles.find((r) => r.code === role);
  const [userId, setUserId] = useState(''); const [at, setAt] = useState(hhmm(new Date().toISOString()));
  const [warn, setWarn] = useState<string[] | null>(null);
  const staff = useQuery({ queryKey: ['or-staff', def?.capability], queryFn: () => api<{ id: string; name: string; department_name: string | null; specialty: string | null }[]>('/or/staff', { query: { cap: def!.capability } }), enabled: !!def });
  const m = useMutation({
    mutationFn: (confirm: boolean) => api(`/or/cases/${c.id}/team`, { body: { role_code: role, user_id: userId, confirm, ...(replaces && { replaces_id: replaces.id }),
      ...(started && { at: localISO(todayISO(), at) }) } }),
    onSuccess: () => { invalOr(qc); onClose(); },
    onError: (e) => { if (e instanceof ApiError && e.code === 'CONFIRM_REQUIRED') setWarn(e.body?.warnings as string[]); },
  });
  const taken = c.team.filter((t) => !t.removed_at && !t.out_at && t.role_code === role).map((t) => t.user_id);
  return (
    <Modal title={replaces ? `შეცვლა — ${replaces.role_name}: ${replaces.name}` : 'გუნდის წევრის დამატება'} onClose={onClose}
      footer={<><button className="btn" type="button" onClick={onClose}>დახურვა</button>
        {warn ? <button className="btn danger" type="button" onClick={() => m.mutate(true)}>გაფრთხილებით დამატება</button>
          : <button className="btn primary" type="button" disabled={!role || !userId || m.isPending} onClick={() => m.mutate(false)}>შენახვა</button>}</>}>
      {!replaces && <Field label="როლი" htmlFor="tm-r" required><select id="tm-r" className="select" value={role} onChange={(e) => { setRole(e.target.value); setUserId(''); setWarn(null); }}>
        {roles.map((r) => <option key={r.code} value={r.code}>{r.name} ({GRP_KA[r.grp]})</option>)}</select></Field>}
      <Field label="თანამშრომელი" htmlFor="tm-u" required><select id="tm-u" className="select" value={userId} onChange={(e) => { setUserId(e.target.value); setWarn(null); }}>
        <option value="">—</option>{staff.data?.filter((s) => !taken.includes(s.id)).map((s) => <option key={s.id} value={s.id}>{s.name}{s.department_name ? ` — ${s.department_name}` : ''}{s.specialty ? ` · ${s.specialty}` : ''}</option>)}</select></Field>
      {started && <Field label="შემოსვლის დრო (დღეს)" htmlFor="tm-at"><input id="tm-at" className="input" type="time" value={at} onChange={(e) => setAt(e.target.value)} /></Field>}
      {warn && <div className="alert warn"><div className="stack" style={{ gap: 4 }}>{warn.map((w) => <span key={w}>• {w}</span>)}</div></div>}
      {!warn && <ErrorBox error={m.error} />}
    </Modal>
  );
}

function TeamRemoveDialog({ t, started, onClose }: { t: TeamMember; started: boolean; onClose: () => void }) {
  const qc = useQueryClient(); const [reason, setReason] = useState(''); const [at, setAt] = useState(hhmm(new Date().toISOString()));
  const m = useMutation({ mutationFn: () => api(`/or/team/${t.id}/remove`, { body: { reason: reason.trim() || undefined, ...(started && { at: localISO(todayISO(), at) }) } }),
    onSuccess: () => { invalOr(qc); onClose(); } });
  return (
    <Modal title={`${started ? 'გავიდა' : 'მოხსნა'} — ${t.role_name}: ${t.name}`} onClose={onClose}
      footer={<><button className="btn" type="button" onClick={onClose}>დახურვა</button><button className="btn primary" type="button" disabled={m.isPending} onClick={() => m.mutate()}>დადასტურება</button></>}>
      {started && <Field label="გასვლის დრო (დღეს)" htmlFor="tr-at"><input id="tr-at" className="input" type="time" value={at} onChange={(e) => setAt(e.target.value)} /></Field>}
      <Field label="მიზეზი" htmlFor="tr-r"><input id="tr-r" className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <ErrorBox error={m.error} />
    </Modal>
  );
}

// ================================================================= წინასაოპერაციო
const ANS: [string, string][] = [['yes', 'კი'], ['no', 'არა'], ['na', 'არ ეხება']];
function PreopTab({ c }: { c: CaseDetail }) {
  const qc = useQueryClient();
  const set = useMutation({ mutationFn: (b: { item_id: string; answer: string }) => api(`/or/cases/${c.id}/readiness`, { method: 'PUT', body: b }), onSuccess: () => invalOr(qc) });
  const cur = c.preop.find((p) => !p.voided_at) ?? null;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 14, alignItems: 'start' }}>
      <section className="card">
        <div className="card-head"><h2 className="grow">მზადყოფნის ჩეკლისტი</h2>{c.readiness.ready ? <span className="chip ok">მზადაა</span> : <span className="chip warn">აკლია {c.readiness.missing.length}</span>}</div>
        <table className="table"><tbody>{c.readiness.items.map((i) => (
          <tr key={i.id}>
            <td>{i.label}{i.auto && <div className="small muted">ავტომატურად</div>}{i.checked_by_name && <div className="small muted">{i.checked_by_name} · {dt(i.checked_at)}</div>}</td>
            <td style={{ width: 220 }}>{i.auto || (i.answer === 'na' && !i.checked_by_name)
              ? <span className={`chip ${i.answer === 'yes' ? 'ok' : i.answer === 'na' ? '' : 'danger'}`}>{i.answer === 'yes' ? 'კი' : i.answer === 'na' ? 'არ ეხება' : 'არა'}</span>
              : <div className="seg" role="group" aria-label={i.label}>{ANS.map(([k, l]) => <button key={k} type="button" disabled={!c.can.readiness || set.isPending} aria-pressed={i.answer === k}
                onClick={() => set.mutate({ item_id: i.id, answer: k })}>{l}</button>)}</div>}</td>
          </tr>))}</tbody></table>
        <div className="card-pad small muted">თანხმობები — <Link to={`/patients/${c.patient_id}`}>პაციენტის ბარათი → თანხმობები</Link> (ოპერაციის / ანესთეზიის, ჰოსპიტალიზაციაზე).
          სიმკაცრე: {c.settings.preop_readiness === 'block' ? 'არასრული მზადყოფნით ოპერაცია ვერ დაიწყება' : 'არასრულზე — დასაბუთებით'}.</div>
        <ErrorBox error={set.error} />
      </section>
      <PreopForm c={c} cur={cur} />
    </div>
  );
}

function PreopForm({ c, cur }: { c: CaseDetail; cur: Preop | null }) {
  const qc = useQueryClient(); const toast = useToast();
  const loc = (iso: string | null) => (iso ? `${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tbilisi' }).format(new Date(iso))}T${hhmm(iso)}` : '');
  const [f, setF] = useState({ asa_class: cur?.asa_class ?? null, asa_emergency: cur?.asa_emergency ?? c.urgency === 'emergency', mallampati: cur?.mallampati ?? null,
    weight_kg: cur?.weight_kg ?? '', height_cm: cur?.height_cm ?? '', fasting_solids_at: loc(cur?.fasting_solids_at ?? null), fasting_liquids_at: loc(cur?.fasting_liquids_at ?? null),
    airway_notes: cur?.airway_notes ?? '', comorbidities: cur?.comorbidities ?? '', risks: cur?.risks ?? [], risk_notes: cur?.risk_notes ?? '',
    planned_anesthesia: cur?.planned_anesthesia ?? c.anesthesia_type, plan_notes: cur?.plan_notes ?? '' });
  const signed = cur?.status === 'signed';
  const ro = signed || !c.can.preop;
  const iso = (v: string) => (v ? localISO(v.slice(0, 10), v.slice(11, 16)) : null);
  const save = useMutation({
    mutationFn: async (sign: boolean) => {
      await api(`/or/cases/${c.id}/preop`, { method: 'PUT', body: { ...f, weight_kg: f.weight_kg === '' ? null : Number(f.weight_kg), height_cm: f.height_cm === '' ? null : Number(f.height_cm),
        fasting_solids_at: iso(f.fasting_solids_at), fasting_liquids_at: iso(f.fasting_liquids_at) } });
      if (sign) await api(`/or/cases/${c.id}/preop/sign`, { body: {} });
    },
    onSuccess: (_, sign) => { toast.show(sign ? 'ხელმოწერილია' : 'შენახულია'); invalOr(qc); },
  });
  const [voidDlg, setVoidDlg] = useState(false);
  const upd = (k: keyof typeof f, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  const num = (v: string | number | null) => (v === null ? '' : String(v));
  return (
    <section className="card">
      {toast.node}
      <div className="card-head"><h2 className="grow">ანესთეზიოლოგის გასინჯვა</h2>
        {signed ? <span className="chip ok">ხელმოწერილია · {cur!.signed_by_name} · {dt(cur!.signed_at)}</span> : cur ? <span className="chip warn">შავი ვერსია</span> : <span className="chip">არ არის</span>}</div>
      <div className="card-pad stack">
        {!c.can.preop && !cur && <span className="muted">გასინჯვას ავსებს ანესთეზიოლოგი.</span>}
        {(cur || c.can.preop) && <>
          <div className="row" style={{ flexWrap: 'wrap', gap: 14 }}>
            <div className="stack" style={{ gap: 4 }}><span className="label">ASA</span><div className="seg" role="group" aria-label="ASA">
              {[1, 2, 3, 4, 5, 6].map((n) => <button key={n} type="button" disabled={ro} aria-pressed={f.asa_class === n} onClick={() => upd('asa_class', n)}>{['I', 'II', 'III', 'IV', 'V', 'VI'][n - 1]}</button>)}
              <button type="button" disabled={ro} aria-pressed={f.asa_emergency} onClick={() => upd('asa_emergency', !f.asa_emergency)}>E</button></div></div>
            <div className="stack" style={{ gap: 4 }}><span className="label">Mallampati</span><div className="seg" role="group" aria-label="Mallampati">
              {[1, 2, 3, 4].map((n) => <button key={n} type="button" disabled={ro} aria-pressed={f.mallampati === n} onClick={() => upd('mallampati', n)}>{['I', 'II', 'III', 'IV'][n - 1]}</button>)}</div></div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
            <Field label="წონა (კგ)" htmlFor="pa-w"><input id="pa-w" className="input mono" type="number" disabled={ro} value={num(f.weight_kg)} onChange={(e) => upd('weight_kg', e.target.value)} /></Field>
            <Field label="სიმაღლე (სმ)" htmlFor="pa-h"><input id="pa-h" className="input mono" type="number" disabled={ro} value={num(f.height_cm)} onChange={(e) => upd('height_cm', e.target.value)} /></Field>
            <Field label="შიმშილი — ბოლო საკვები" htmlFor="pa-fs"><input id="pa-fs" className="input" type="datetime-local" disabled={ro} value={f.fasting_solids_at} onChange={(e) => upd('fasting_solids_at', e.target.value)} /></Field>
            <Field label="ბოლო გამჭვირვალე სითხე" htmlFor="pa-fl"><input id="pa-fl" className="input" type="datetime-local" disabled={ro} value={f.fasting_liquids_at} onChange={(e) => upd('fasting_liquids_at', e.target.value)} /></Field>
          </div>
          <div className="stack" style={{ gap: 4 }}><span className="label">ალერგიები (პაციენტის ბარათიდან)</span>
            <span>{(signed ? cur!.allergies : c.allergies).map((a) => a.substance).join(', ') || <span className="muted">არ არის ცნობილი</span>}</span></div>
          <div className="stack" style={{ gap: 4 }}><span className="label">რისკები</span><div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
            {Object.entries(RISK_KA).map(([k, l]) => <label key={k} className="row small"><input type="checkbox" disabled={ro} checked={f.risks.includes(k)}
              onChange={(e) => upd('risks', e.target.checked ? [...f.risks, k] : f.risks.filter((x) => x !== k))} /> {l}</label>)}</div></div>
          <Field label="თანმხლები დაავადებები" htmlFor="pa-c"><textarea id="pa-c" className="textarea" rows={2} disabled={ro} value={f.comorbidities} onChange={(e) => upd('comorbidities', e.target.value)} /></Field>
          <Field label="სასუნთქი გზები / რისკების შენიშვნა" htmlFor="pa-a"><textarea id="pa-a" className="textarea" rows={2} disabled={ro} value={f.airway_notes} onChange={(e) => upd('airway_notes', e.target.value)} /></Field>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 12 }}>
            <Field label="ანესთეზიის გეგმა" htmlFor="pa-p" required><select id="pa-p" className="select" disabled={ro} value={f.planned_anesthesia ?? ''} onChange={(e) => upd('planned_anesthesia', e.target.value)}>
              {Object.entries(ANESTHESIA_KA).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
            <Field label="გეგმის დეტალები" htmlFor="pa-pn"><input id="pa-pn" className="input" disabled={ro} value={f.plan_notes} onChange={(e) => upd('plan_notes', e.target.value)} /></Field>
          </div>
          {!ro && <div className="row"><span className="grow" /><button className="btn" type="button" disabled={save.isPending} onClick={() => save.mutate(false)}>შენახვა</button>
            <button className="btn primary" type="button" disabled={save.isPending || !f.asa_class || !f.mallampati || !f.planned_anesthesia} onClick={() => save.mutate(true)}>ხელმოწერა</button></div>}
          {signed && c.can.preop && !['in_progress', 'completed'].includes(c.status) && <div className="row"><span className="grow" /><button className="btn sm" type="button" onClick={() => setVoidDlg(true)}>გაუქმება და ხელახლა</button></div>}
        </>}
        <ErrorBox error={save.error} />
      </div>
      {voidDlg && cur && <ReasonPrompt title="გასინჯვის გაუქმება" label="მიზეზი" path={`/or/preop/${cur.id}/void`} danger onClose={() => setVoidDlg(false)} />}
    </section>
  );
}

// ================================================================= WHO ჩეკლისტი
function WhoTab({ c }: { c: CaseDetail }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 14, alignItems: 'start' }}>
      {(['sign_in', 'time_out', 'sign_out'] as const).map((p) => <WhoPhase key={p} c={c} phase={p} />)}
    </div>
  );
}
function WhoPhase({ c, phase }: { c: CaseDetail; phase: 'sign_in' | 'time_out' | 'sign_out' }) {
  const qc = useQueryClient();
  const done = c.who.find((w) => w.phase === phase && !w.voided_at);
  const items = c.who_items.filter((i) => i.phase === phase);
  const [ans, setAns] = useState<Record<string, string>>({});
  const [note, setNote] = useState(''); const [voidDlg, setVoidDlg] = useState(false);
  const m = useMutation({ mutationFn: () => api(`/or/cases/${c.id}/who`, { body: { phase, answers: ans, note: note.trim() || undefined } }), onSuccess: () => { invalOr(qc); setAns({}); } });
  const prev = phase === 'time_out' ? 'sign_in' : phase === 'sign_out' ? 'time_out' : null;
  const blocked = prev && !c.who.some((w) => w.phase === prev && !w.voided_at);
  const all = items.every((i) => ans[i.id] === 'yes' || ans[i.id] === 'na');
  const voided = c.who.filter((w) => w.phase === phase && w.voided_at);
  return (
    <section className="card" style={{ borderTop: `4px solid ${done ? 'var(--ok-line)' : phase === 'time_out' ? 'var(--danger-line)' : 'var(--line)'}` }}>
      <div className="card-head"><div className="grow"><h2>{WHO_KA[phase][0]}</h2><span className="small muted">{WHO_KA[phase][1]}</span></div>
        {done ? <span className="chip ok">✓ {hhmm(done.done_at)}</span> : <span className="chip">შესავსები</span>}</div>
      {done ? (
        <div className="card-pad stack" style={{ gap: 6 }}>
          {done.answers.map((a) => <div key={a.item_id} className="row small" style={{ alignItems: 'flex-start' }}><span className={`chip ${a.answer === 'yes' ? 'ok' : ''}`} style={{ height: 20 }}>{a.answer === 'yes' ? 'კი' : 'არ ეხება'}</span><span>{a.label}</span></div>)}
          {done.note && <span className="small">შენიშვნა: {done.note}</span>}
          <span className="small muted">{done.by_name} · {dt(done.done_at)}</span>
          {c.can.periop && <button className="btn sm" type="button" style={{ alignSelf: 'flex-start' }} onClick={() => setVoidDlg(true)}>გაუქმება</button>}
        </div>
      ) : (
        <div className="card-pad stack" style={{ gap: 8 }}>
          {phase === 'time_out' && <div className="alert danger small">Time out-ის გარეშე „განაკვეთი“ ვერ დაფიქსირდება.</div>}
          {phase === 'sign_out' && <div className="alert info small">Sign out-ის გარეშე ოპერაცია ვერ დასრულდება („საოპერაციოდან გავიდა“).</div>}
          {blocked && <span className="small muted">ჯერ — {WHO_KA[prev!][0]}</span>}
          {items.map((i) => (
            <div key={i.id} className="row" style={{ alignItems: 'flex-start' }}>
              <span className="grow small">{i.label}</span>
              <div className="seg" role="group" aria-label={i.label}>{[['yes', 'კი'], ['na', 'არ ეხება']].map(([k, l]) =>
                <button key={k} type="button" disabled={!c.can.periop || !!blocked} aria-pressed={ans[i.id] === k} onClick={() => setAns({ ...ans, [i.id]: k })}>{l}</button>)}</div>
            </div>))}
          <input className="input" aria-label="შენიშვნა" placeholder="შენიშვნა" disabled={!c.can.periop || !!blocked} value={note} onChange={(e) => setNote(e.target.value)} />
          {c.can.periop && <button className="btn primary" type="button" disabled={!all || !!blocked || m.isPending} onClick={() => m.mutate()}>დადასტურება — {WHO_KA[phase][0]}</button>}
          {c.can.periop && !blocked && <button className="btn sm" type="button" style={{ alignSelf: 'flex-start' }} onClick={() => setAns(Object.fromEntries(items.map((i) => [i.id, 'yes'])))}>ყველა — „კი“</button>}
          <ErrorBox error={m.error} />
        </div>)}
      {voided.length > 0 && <div className="card-pad small muted" style={{ borderTop: '1px solid var(--line-soft)' }}>{voided.map((w) => <div key={w.id}>გაუქმებული: {dt(w.done_at)} · {w.void_reason}</div>)}</div>}
      {voidDlg && done && <ReasonPrompt title={`${WHO_KA[phase][0]} — გაუქმება`} label="მიზეზი" path={`/or/who/${done.id}/void`} danger onClose={() => setVoidDlg(false)} />}
    </section>
  );
}

// ================================================================= დროის ნიშნულები
function TimesTab({ c, cur }: { c: CaseDetail; cur: CaseDetail['times'] }) {
  const [dlg, setDlg] = useState<{ kind: TimeKind; correct: boolean } | null>(null);
  const map = new Map(cur.map((t) => [t.kind, t]));
  const hist = c.times.filter((t) => t.superseded_by);
  const next = TIME_KINDS.find((k) => !map.has(k) && !(k === 'anesthesia_start' && ['local', 'none'].includes(c.anesthesia_type)) && !(k === 'anesthesia_end' && !map.has('anesthesia_start')));
  return (
    <div className="stack">
      <section className="card"><table className="table">
        <thead><tr><th>ნიშნული</th><th>დრო</th><th>ვინ</th><th /></tr></thead>
        <tbody>{TIME_KINDS.map((k) => {
          const t = map.get(k);
          return (
            <tr key={k}>
              <td><strong>{TIME_KA[k]}</strong>{t?.destination && <span className="chip" style={{ marginLeft: 6 }}>→ {DEST_KA[t.destination]}</span>}
                {k === 'incision' && !c.who.some((w) => w.phase === 'time_out' && !w.voided_at) && <div className="small" style={{ color: 'var(--danger)' }}>საჭიროა Time out</div>}
                {k === 'out_of_room' && !c.who.some((w) => w.phase === 'sign_out' && !w.voided_at) && <div className="small" style={{ color: 'var(--danger)' }}>საჭიროა Sign out</div>}
                {k === 'out_of_room' && !t && c.settings.note_required.length > 0 && c.progress.note?.status !== 'signed' && <div className="small muted">ოქმის სავალდებულო ველები — „ოქმი“</div>}
                {!t && c.settings.count_mode !== 'off' && ['incision', 'closure', 'out_of_room'].includes(k) && <div className="small muted">დათვლა — „მასალები / დათვლა“</div>}</td>
              <td className="mono">{t ? <>{dateGe(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tbilisi' }).format(new Date(t.at)))} <strong>{hhmm(t.at)}</strong></> : '—'}
                {t?.correction_reason && <div className="small muted" style={{ fontFamily: 'var(--font)' }}>შესწორდა: {t.correction_reason}</div>}</td>
              <td className="small">{t?.by_name ?? ''}</td>
              <td><div className="row" style={{ justifyContent: 'flex-end' }}>
                {c.can.periop && !t && <button className={`btn sm${k === next ? ' primary' : ''}`} type="button" onClick={() => setDlg({ kind: k, correct: false })}>დაფიქსირება</button>}
                {c.can.periop && t && <button className="btn sm" type="button" onClick={() => setDlg({ kind: k, correct: true })}>შესწორება</button>}</div></td>
            </tr>);
        })}</tbody>
      </table></section>
      {hist.length > 0 && <section className="card"><div className="card-head"><h2>შესწორებული ჩანაწერები</h2></div><table className="table"><tbody>
        {hist.map((t) => <tr key={t.id}><td>{TIME_KA[t.kind]}</td><td className="mono"><s>{dt(t.at)}</s></td><td className="small">{t.by_name} · {dt(t.created_at)}</td></tr>)}</tbody></table></section>}
      {!c.can.periop && <span className="hint">ნიშნულებს აფიქსირებს გუნდის წევრი, საოპერაციო ექთანი ან ანესთეზიოლოგი.</span>}
      {dlg && <TimeDialog c={c} kind={dlg.kind} correct={dlg.correct} onClose={() => setDlg(null)} />}
    </div>
  );
}

function TimeDialog({ c, kind, correct, onClose }: { c: CaseDetail; kind: TimeKind; correct: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ date: todayISO(), time: hhmm(new Date().toISOString()), destination: kind === 'out_of_room' ? (c.needs_icu ? 'icu' : 'pacu') : kind === 'pacu_out' ? 'ward' : '',
    correction_reason: '', readiness_override: '', count_override: '' });
  const [needOverride, setNeedOverride] = useState<string[] | null>(null);
  const [needCount, setNeedCount] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => api(`/or/cases/${c.id}/times`, { body: { kind, at: localISO(f.date, f.time), ...(f.destination && { destination: f.destination }),
      ...(correct && { correction_reason: f.correction_reason.trim() }), ...(f.readiness_override.trim() && { readiness_override: f.readiness_override.trim() }),
      ...(f.count_override.trim() && { count_override: f.count_override.trim() }) } }),
    onSuccess: () => { invalOr(qc); onClose(); },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'PREOP_OVERRIDE_REQUIRED') setNeedOverride((e.body?.missing as string[]) ?? []);
      if (e instanceof ApiError && e.code === 'COUNT_OVERRIDE_REQUIRED') setNeedCount(e.message);
    },
  });
  const ok = !!f.time && (!correct || f.correction_reason.trim().length >= 3) && (!needOverride || f.readiness_override.trim().length >= 3) && (!needCount || f.count_override.trim().length >= 3);
  return (
    <Modal title={`${correct ? 'შესწორება' : 'დაფიქსირება'} — ${TIME_KA[kind]}`} onClose={onClose}
      footer={<><button className="btn" type="button" onClick={onClose}>დახურვა</button><button className="btn primary" type="button" disabled={!ok || m.isPending} onClick={() => m.mutate()}>შენახვა</button></>}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="თარიღი" htmlFor="tk-d"><input id="tk-d" className="input" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label="დრო" htmlFor="tk-t"><input id="tk-t" className="input" type="time" value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} /></Field>
      </div>
      {(kind === 'out_of_room' || kind === 'pacu_out') && <Field label="სად" htmlFor="tk-ds"><select id="tk-ds" className="select" value={f.destination} onChange={(e) => setF({ ...f, destination: e.target.value })}>
        {Object.entries(DEST_KA).filter(([k]) => kind === 'out_of_room' || k !== 'pacu').map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>}
      {correct && <Field label="შესწორების მიზეზი" htmlFor="tk-cr" required><input id="tk-cr" className="input" value={f.correction_reason} onChange={(e) => setF({ ...f, correction_reason: e.target.value })} /></Field>}
      {needOverride && <div className="alert warn"><div className="stack" style={{ gap: 4 }}><strong>წინასაოპერაციო მზადყოფნა არასრულია:</strong>{needOverride.map((x) => <span key={x}>• {x}</span>)}</div></div>}
      {needOverride && <Field label="დასაბუთება (ოპერაცია მზადყოფნის გარეშე)" htmlFor="tk-ov" required><textarea id="tk-ov" className="textarea" rows={2} value={f.readiness_override} onChange={(e) => setF({ ...f, readiness_override: e.target.value })} /></Field>}
      {needCount && <div className="alert warn">{needCount}</div>}
      {needCount && <Field label="ახსნა (დათვლის გარეშე / შეუსაბამობით)" htmlFor="tk-co" required><textarea id="tk-co" className="textarea" rows={2} value={f.count_override} onChange={(e) => setF({ ...f, count_override: e.target.value })} /></Field>}
      {!(m.error instanceof ApiError && ['PREOP_OVERRIDE_REQUIRED', 'COUNT_OVERRIDE_REQUIRED'].includes(m.error.code ?? '')) && <ErrorBox error={m.error} />}
    </Modal>
  );
}

// ================================================================= ისტორია
function evText(k: string, d: Record<string, unknown>) {
  const x = (v: unknown) => (v == null ? '' : String(v));
  switch (k) {
    case 'scheduled': case 'tentative': case 'confirmed': case 'rescheduled': return `ოთახი ${x(d.room)} · ${d.start ? dt(x(d.start)) : ''}${d.reason ? ` · ${x(d.reason)}` : ''}${(d.warnings as string[] | undefined)?.length ? ` · გაფრთხილებით (${(d.warnings as string[]).length})` : ''}`;
    case 'unscheduled': case 'preop_voided': case 'readiness_override': return x(d.reason);
    case 'cancelled': return `${x(d.reason)}${d.note ? ` — ${x(d.note)}` : ''}`;
    case 'surgeon_changed': return `${x(d.to)} · ${x(d.reason)}`;
    case 'team_added': case 'team_removed': case 'team_out': return `${x(d.role)}: ${x(d.name)}${d.at ? ` · ${hhmm(x(d.at))}` : ''}${d.replaced ? ' (შეცვლა)' : ''}${d.reason ? ` · ${x(d.reason)}` : ''}`;
    case 'preop_signed': return `ASA ${x(d.asa)}, Mallampati ${x(d.mallampati)}`;
    case 'readiness': return `${x(d.item)}: ${d.answer === 'yes' ? 'კი' : d.answer === 'no' ? 'არა' : 'არ ეხება'}`;
    case 'who': case 'who_voided': return `${WHO_KA[x(d.phase)]?.[0] ?? x(d.phase)}${d.reason ? ` · ${x(d.reason)}` : ''}`;
    case 'time': return `${TIME_KA[x(d.kind) as TimeKind] ?? x(d.kind)} · ${hhmm(x(d.at))}${d.destination ? ` → ${DEST_KA[x(d.destination)]}` : ''}`;
    case 'time_corrected': return `${TIME_KA[x(d.kind) as TimeKind] ?? x(d.kind)}: ${hhmm(x(d.from))} → ${hhmm(x(d.at))} · ${x(d.reason)}`;
    case 'updated': return (d.fields as string[] | undefined)?.length ? `ველები: ${(d.fields as string[]).length}${d.reason ? ` · ${x(d.reason)}` : ''}` : '';
    case 'requested': return URGENCY[x(d.urgency)]?.[1] ?? '';
    default: return '';
  }
}
function History({ c }: { c: CaseDetail }) {
  return (
    <section className="card"><table className="table">
      <tbody>{c.events.map((e) => <tr key={e.id}><td className="mono small" style={{ width: 150 }}>{dt(e.at)}</td><td style={{ width: 220 }}><strong>{EVENT_KA[e.kind] ?? e.kind}</strong></td>
        <td className="small">{evText(e.kind, e.data)}</td><td className="small muted">{e.user_name ?? ''}</td></tr>)}</tbody>
    </table></section>
  );
}

// ================================================================= ჰოსპიტალიზაციის გვერდზე — პანელი
export function OrStayPanel({ encounterId, patientId, active }: { encounterId: string; patientId: string; active: boolean }) {
  const { user } = useAuth(); const mod = useOrModule(); const nav = useNavigate();
  const q = useQuery({ queryKey: ['or-cases', 'enc', encounterId], queryFn: () => api<CaseRow[]>('/or/cases', { query: { encounter_id: encounterId } }), enabled: mod.enabled });
  const [req, setReq] = useState(false);
  if (!mod.enabled || !can(user, 'admin', 'doctor', 'nurse', 'or_schedule', 'anesthesiologist', 'or_nurse', 'manager', 'viewer')) return null;
  return (
    <section className="card" id="or">
      <div className="card-head"><h2 className="grow">ოპერაციები</h2>
        {active && can(user, 'doctor', 'admin') && <button className="btn sm primary" type="button" onClick={() => setReq(true)}>+ ოპერაციის მოთხოვნა</button>}</div>
      {q.isLoading ? <Loading /> : <table className="table"><tbody>
        {(q.data ?? []).map((c) => (
          <tr key={c.id} className="clickable" onClick={() => nav(`/or/case/${c.id}`)}>
            <td className="mono small">{c.case_no}</td>
            <td>{c.procedures}<div className="small muted">{c.surgeon_name} · {ANESTHESIA_KA[c.anesthesia_type]}</div></td>
            <td className="small mono">{c.scheduled_start ? `${dateGe(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tbilisi' }).format(new Date(c.scheduled_start)))} ${hhmm(c.scheduled_start)} · ${c.room_code}` : '—'}</td>
            <td><div className="row" style={{ gap: 4 }}>{c.status === 'in_progress' && c.phase ? <span className="chip accent">{PHASE_KA[c.phase]}</span> : chip(CASE_ST, c.status)}{c.urgency !== 'elective' && chip(URGENCY, c.urgency)}</div></td>
          </tr>))}
        {!q.data?.length && <tr><td className="muted small">ოპერაცია არ არის</td></tr>}
      </tbody></table>}
      {req && <RequestDialog encounterId={encounterId} patient={{ id: patientId, name: '' }} onClose={() => setReq(false)} onDone={(id) => nav(`/or/case/${id}`)} />}
    </section>
  );
}
