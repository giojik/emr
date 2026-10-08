import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import { ErrorBox, Field, Loading, Modal } from '../../components/ui';
import { dayTitle, shiftDay, todayISO } from '../../lib/format';
import { invalOr } from './Dialogs';
import { GRP_KA, useOrModule, useOrSetup, type DayMember } from './types';

export interface RosterView {
  day: string; enabled: boolean; can: { nursing: boolean; anesthesia: boolean };
  rooms: { id: string; code: string; name: string; block_name: string; department_id: string;
    staff: { id: string; room_id: string; user_id: string; role_code: string; role_name: string; grp: string; name: string; is_active: boolean }[]; team: DayMember[] }[];
  overrides: { id: string; day: string; user_id: string; room_id: string | null; role_code: string | null; note: string | null; room_code: string | null; role_name: string | null; name: string;
    created_by_name: string; home_room_code: string | null }[];
}
export const useRoster = (day: string, enabled = true) => useQuery({ queryKey: ['or-roster', day], queryFn: () => api<RosterView>('/or/roster', { query: { date: day } }), enabled });

/** ოთახის გუნდი (0049): მუდმივი გუნდი ოთახზე + დღის ცვლილებები (გადაყვანა / „დღეს არ არის“) */
export default function Roster() {
  const [sp, setSp] = useSearchParams(); const mod = useOrModule();
  const day = sp.get('date') ?? todayISO();
  const q = useRoster(day);
  const [add, setAdd] = useState<string | null>(null);
  const [move, setMove] = useState<{ user_id?: string; room_id?: string | null } | null>(null);
  const qc = useQueryClient();
  const rm = useMutation({ mutationFn: (id: string) => api(`/or/roster/${id}/remove`, { body: {} }), onSuccess: () => invalOr(qc) });
  const cancel = useMutation({ mutationFn: (id: string) => api(`/or/roster/day/${id}/cancel`, { body: {} }), onSuccess: () => invalOr(qc) });
  const upd = (v: string) => { if (v && v !== todayISO()) sp.set('date', v); else sp.delete('date'); setSp(sp, { replace: true }); };
  const r = q.data;
  const canG = (g: string) => !!r && (g === 'anesthesia' ? r.can.anesthesia : r.can.nursing);
  return (
    <div className="content">
      {!mod.settings.room_teams && <div className="alert warn">ოთახის გუნდის ავტომატური შევსება გამორთულია (პარამეტრი room_teams) — სია ინახება, ოპერაციებს არ ემატება.</div>}
      <span className="hint">მუდმივი გუნდი — ოთახის ექთნები და ანესთეზიოლოგი. დღის ცვლილება ცვლის მხოლოდ ერთ დღეს. დაგეგმვისას დღის გუნდი ოპერაციას ემატება ავტომატურად (დაწყებამდე განახლდება).
        მართავს: საექთნო — ბლოკის მთავარი ექთანი; ანესთეზია — {mod.settings.anesthesia_team_by === 'anesthesia_head' ? 'ანესთეზიოლოგიის ხელმძღვანელი' : 'ბლოკის მთავარი ექთანი'}; admin.</span>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button className="btn sm" type="button" aria-label="წინა დღე" onClick={() => upd(shiftDay(day, -1))}>←</button>
        <input className="input" type="date" aria-label="დღე" style={{ height: 38, maxWidth: 170 }} value={day} min={todayISO()} onChange={(e) => upd(e.target.value)} />
        <button className="btn sm" type="button" aria-label="შემდეგი დღე" onClick={() => upd(shiftDay(day, 1))}>→</button>
        <strong>{dayTitle(day)}</strong><span className="grow" />
        {r && (r.can.nursing || r.can.anesthesia) && <button className="btn primary" type="button" onClick={() => setMove({})}>დღის ცვლილება</button>}
      </div>
      <ErrorBox error={q.error ?? rm.error ?? cancel.error} />
      {q.isLoading || !r ? <Loading /> : <>
        {r.overrides.length > 0 && <section className="card"><div className="card-head"><h2 className="grow">ცვლილებები — {dayTitle(r.day)}</h2></div><table className="table"><tbody>
          {r.overrides.map((o) => <tr key={o.id}><td><strong>{o.name}</strong>{o.home_room_code && <span className="small muted"> · მუდმივად {o.home_room_code}</span>}</td>
            <td>{o.room_id ? <span className="chip info">→ {o.room_code} · {o.role_name}</span> : <span className="chip warn">დღეს არ არის</span>}{o.note && <span className="small muted"> · {o.note}</span>}</td>
            <td className="small muted">{o.created_by_name}</td>
            <td>{(r.can.nursing || r.can.anesthesia) && <button className="btn sm" type="button" onClick={() => cancel.mutate(o.id)}>გაუქმება</button>}</td></tr>)}</tbody></table></section>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 14 }}>
          {r.rooms.map((room) => (
            <section key={room.id} className="card">
              <div className="card-head"><h2 className="grow">{room.code} <span className="small muted">{room.name}</span></h2>
                {(r.can.nursing || r.can.anesthesia) && <button className="btn sm" type="button" onClick={() => setAdd(room.id)}>+ მუდმივი</button>}</div>
              <table className="table"><tbody>
                {room.staff.map((s) => <tr key={s.id}><td className="muted small" style={{ width: 150 }}>{s.role_name}</td><td>{s.name}</td>
                  <td><div className="row" style={{ justifyContent: 'flex-end', gap: 4 }}>
                    {canG(s.grp) && <button className="btn sm" type="button" title="დღის ცვლილება" onClick={() => setMove({ user_id: s.user_id })}>↔</button>}
                    {canG(s.grp) && <button className="btn sm" type="button" aria-label={`მოხსნა — ${s.name}`} onClick={() => rm.mutate(s.id)}>×</button>}</div></td></tr>)}
                {!room.staff.length && <tr><td className="muted small">მუდმივი გუნდი არ არის</td></tr>}
              </tbody></table>
              <div className="card-pad small" style={{ borderTop: '1px solid var(--line-soft)' }}><span className="muted">დღის გუნდი: </span>
                {room.team.length ? room.team.map((m) => <span key={`${m.user_id}${m.role_code}`} className={`chip ${m.source === 'day' ? 'info' : ''}`} style={{ margin: 2 }}>{m.name.split(' ')[0]} · {m.role_name}</span>) : '—'}</div>
            </section>))}
        </div>
      </>}
      {add && r && <AddDialog r={r} roomId={add} onClose={() => setAdd(null)} />}
      {move && r && <DayDialog r={r} init={move} onClose={() => setMove(null)} />}
    </div>
  );
}

function AddDialog({ r, roomId, onClose }: { r: RosterView; roomId: string; onClose: () => void }) {
  const qc = useQueryClient(); const setup = useOrSetup();
  const roles = (setup.data?.team_roles ?? []).filter((x) => x.grp !== 'surgical' && (x.grp === 'anesthesia' ? r.can.anesthesia : r.can.nursing));
  const [role, setRole] = useState(roles[0]?.code ?? ''); const [user, setUser] = useState('');
  const def = roles.find((x) => x.code === role) ?? roles[0];
  const staff = useQuery({ queryKey: ['or-staff', def?.capability], queryFn: () => api<{ id: string; name: string; department_name: string | null }[]>('/or/staff', { query: { cap: def!.capability } }), enabled: !!def });
  const taken = new Set(r.rooms.flatMap((x) => x.staff.map((s) => s.user_id)));
  const m = useMutation({ mutationFn: () => api('/or/roster', { body: { room_id: roomId, user_id: user, role_code: def!.code } }), onSuccess: () => { invalOr(qc); onClose(); } });
  return (
    <Modal title={`მუდმივი გუნდი — ${r.rooms.find((x) => x.id === roomId)?.code}`} onClose={onClose}
      footer={<><button className="btn" type="button" onClick={onClose}>დახურვა</button><button className="btn primary" type="button" disabled={!user || !def || m.isPending} onClick={() => m.mutate()}>დამატება</button></>}>
      <Field label="როლი" htmlFor="ra-r"><select id="ra-r" className="select" value={def?.code ?? ''} onChange={(e) => { setRole(e.target.value); setUser(''); }}>
        {roles.map((x) => <option key={x.code} value={x.code}>{x.name} ({GRP_KA[x.grp]})</option>)}</select></Field>
      <Field label="თანამშრომელი" htmlFor="ra-u"><select id="ra-u" className="select" value={user} onChange={(e) => setUser(e.target.value)}><option value="">—</option>
        {(staff.data ?? []).filter((s) => !taken.has(s.id)).map((s) => <option key={s.id} value={s.id}>{s.name}{s.department_name ? ` — ${s.department_name}` : ''}</option>)}</select></Field>
      <span className="hint">თანამშრომელი მუდმივად ერთ ოთახშია; სხვა ოთახში — დღის ცვლილებით.</span>
      <ErrorBox error={m.error} />
    </Modal>
  );
}

export function DayDialog({ r, init, onClose }: { r: RosterView; init: { user_id?: string; room_id?: string | null }; onClose: () => void }) {
  const qc = useQueryClient(); const setup = useOrSetup();
  const people = [...new Map([...r.rooms.flatMap((x) => x.staff.map((s) => [s.user_id, { id: s.user_id, name: s.name, home: x.code, grp: s.grp, role: s.role_code }] as const))]).values()];
  const extra = useQuery({ queryKey: ['or-staff', 'or_nurse'], queryFn: () => api<{ id: string; name: string }[]>('/or/staff', { query: { cap: 'or_nurse' } }) });
  const [user, setUser] = useState(init.user_id ?? ''); const [room, setRoom] = useState<string>(init.room_id === null ? 'absent' : init.room_id ?? '');
  const p = people.find((x) => x.id === user);
  const [role, setRole] = useState(''); const [note, setNote] = useState('');
  const roles = (setup.data?.team_roles ?? []).filter((x) => x.grp !== 'surgical' && (x.grp === 'anesthesia' ? r.can.anesthesia : r.can.nursing));
  const m = useMutation({ mutationFn: () => api('/or/roster/day', { body: { day: r.day, user_id: user, room_id: room === 'absent' ? null : room, ...(role && room !== 'absent' && { role_code: role }), note: note || undefined } }),
    onSuccess: () => { invalOr(qc); onClose(); } });
  return (
    <Modal title={`დღის ცვლილება — ${dayTitle(r.day)}`} onClose={onClose}
      footer={<><button className="btn" type="button" onClick={onClose}>დახურვა</button><button className="btn primary" type="button" disabled={!user || !room || (!p && room !== 'absent' && !role) || m.isPending} onClick={() => m.mutate()}>შენახვა</button></>}>
      <Field label="თანამშრომელი" htmlFor="rd-u"><select id="rd-u" className="select" value={user} onChange={(e) => setUser(e.target.value)}><option value="">—</option>
        <optgroup label="ოთახების გუნდიდან">{people.map((x) => <option key={x.id} value={x.id}>{x.name} — {x.home}</option>)}</optgroup>
        <optgroup label="სხვა საოპერაციო ექთანი">{(extra.data ?? []).filter((x) => !people.some((y) => y.id === x.id)).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</optgroup></select></Field>
      <Field label="დღეს" htmlFor="rd-r"><select id="rd-r" className="select" value={room} onChange={(e) => setRoom(e.target.value)}><option value="">—</option>
        {r.rooms.map((x) => <option key={x.id} value={x.id}>→ {x.code} {x.name}</option>)}{p && <option value="absent">დღეს არ არის</option>}</select></Field>
      {room && room !== 'absent' && <Field label={p ? 'როლი (ცარიელი — მუდმივი როლი)' : 'როლი'} htmlFor="rd-ro"><select id="rd-ro" className="select" value={role} onChange={(e) => setRole(e.target.value)}>
        <option value="">{p ? '—' : 'აირჩიეთ'}</option>{roles.map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}</select></Field>}
      <Field label="შენიშვნა" htmlFor="rd-n"><input id="rd-n" className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <span className="hint">დაწყებამდე ოპერაციებზე ავტომატური წევრები განახლდება.</span>
      <ErrorBox error={m.error} />
    </Modal>
  );
}
