import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../../api/client';
import type { AdminUser, Department, Tariff } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Field, Loading, Modal, useDebounced, useToast } from '../../components/ui';
import { money, ROLE_KA, tsDate } from '../../lib/format';

const ROLES = Object.keys(ROLE_KA);

export default function Users() {
  const [search, setSearch] = useState(''); const [role, setRole] = useState(''); const [dept, setDept] = useState(''); const [active, setActive] = useState('true');
  const [edit, setEdit] = useState<AdminUser | null>(null); const [creating, setCreating] = useState(false);
  const dq = useDebounced(search.trim(), 250);
  const users = useQuery({ queryKey: ['admin-users', dq, role, dept, active], queryFn: () => api<AdminUser[]>('/users', { query: { search: dq, role, department_id: dept, active, limit: 100 } }) });
  const depts = useQuery({ queryKey: ['departments', 'all'], queryFn: () => api<Department[]>('/departments', { query: { include_inactive: true } }) });

  return (
    <div className="content">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <input aria-label="ძებნა" className="input" style={{ maxWidth: 320 }} placeholder="სახელი, ელ-ფოსტა, პირადი №" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select aria-label="როლი" className="select" style={{ width: 180 }} value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="">ყველა როლი</option>{ROLES.map((r) => <option key={r} value={r}>{ROLE_KA[r]}</option>)}
        </select>
        <select aria-label="განყოფილება" className="select" style={{ width: 220 }} value={dept} onChange={(e) => setDept(e.target.value)}>
          <option value="">ყველა განყოფილება</option>{depts.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <select aria-label="სტატუსი" className="select" style={{ width: 150 }} value={active} onChange={(e) => setActive(e.target.value)}>
          <option value="true">აქტიური</option><option value="false">გათიშული</option><option value="">ყველა</option>
        </select>
        <button className="btn primary" type="button" style={{ marginLeft: 'auto' }} onClick={() => setCreating(true)}>+ მომხმარებელი</button>
      </div>
      <ErrorBox error={users.error} />
      {users.isLoading ? <Loading /> : (
        <div className="card">
          {users.data?.length === 0 ? <div className="empty">ვერ მოიძებნა.</div> : (
            <table className="table">
              <thead><tr><th>სახელი</th><th>შესვლა</th><th>როლი</th><th>განყოფილება</th><th className="num">კონსულტაცია</th><th>სტატუსი</th><th>ბოლო შესვლა</th></tr></thead>
              <tbody>
                {users.data?.map((u) => (
                  <tr key={u.id} className="clickable" onClick={() => setEdit(u)}>
                    <td><strong>{u.last_name} {u.first_name}</strong>{u.specialty && <div className="small muted">{u.specialty}</div>}</td>
                    <td className="small">{u.auth_provider === 'ldap' ? <><span className="chip info">AD</span> {u.ldap_username}</> : u.email}</td>
                    <td>{ROLE_KA[u.role] ?? u.role}</td>
                    <td className="muted">{u.department_name ?? '—'}</td>
                    <td className="num">{u.role === 'doctor' ? (u.consultation_price ? money(u.consultation_price) : <span className="chip warn">ტარიფი არ აქვს</span>) : ''}</td>
                    <td><UserStatus u={u} /></td>
                    <td className="small muted">{u.last_login_at ? tsDate(u.last_login_at) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      {creating && <CreateUser depts={depts.data ?? []} onClose={() => setCreating(false)} />}
      {edit && <EditUser key={edit.id} u={edit} depts={depts.data ?? []} onClose={() => setEdit(null)} />}
    </div>
  );
}

function UserStatus({ u }: { u: AdminUser }) {
  if (!u.is_active) return <span className="chip">გათიშული</span>;
  if (u.is_locked) return <span className="chip danger">დაბლოკილი</span>;
  if (u.must_change_password) return <span className="chip warn">დროებითი პაროლი</span>;
  return <span className="chip ok">აქტიური</span>;
}

function TempPassword({ value, who }: { value: string; who: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="alert ok" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
      <strong>დროებითი პაროლი — {who}</strong>
      <div className="row"><div className="secret grow">{value}</div>
        <button className="btn" type="button" onClick={() => { void navigator.clipboard?.writeText(value); setCopied(true); }}>{copied ? 'დაკოპირდა' : 'კოპირება'}</button></div>
      <span className="small">ნაჩვენებია მხოლოდ ერთხელ — სისტემაში არ ინახება. პირველი შესვლისას მომხმარებელი მას შეცვლის.</span>
    </div>
  );
}

function useTariffs() {
  return useQuery({ queryKey: ['tariffs'], queryFn: () => api<Tariff[]>('/tariffs') });
}

function CreateUser({ depts, onClose }: { depts: Department[]; onClose: () => void }) {
  const qc = useQueryClient(); const tariffs = useTariffs();
  const [f, setF] = useState({ first_name: '', last_name: '', personal_number: '', email: '', phone: '', role: 'doctor', department_id: '', specialty: '', license_number: '', consultation_tariff_id: '', auth_provider: 'local', ldap_username: '' });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const m = useMutation({
    mutationFn: () => {
      const body: Record<string, string> = {};
      for (const [k, v] of Object.entries(f)) if (v.trim()) body[k] = v.trim();
      if (f.auth_provider === 'local') delete body.ldap_username;
      if (f.role !== 'doctor') delete body.consultation_tariff_id;
      return api<{ user: AdminUser; temporaryPassword: string | null }>('/users', { body });
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-users'] }),
  });
  const done = m.data;
  const submit = (e: FormEvent) => { e.preventDefault(); m.mutate(); };
  return (
    <Modal title="ახალი მომხმარებელი" onClose={onClose} width={720}
      footer={done ? <button className="btn primary" type="button" onClick={onClose}>დახურვა</button>
        : <><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="submit" form="cu" disabled={m.isPending}>შექმნა</button></>}>
      {done ? (
        done.temporaryPassword ? <TempPassword value={done.temporaryPassword} who={done.user.email} />
          : <div className="alert ok">შეიქმნა. შესვლა: დომენის სახელით „{done.user.ldap_username}“ და Windows პაროლით.</div>
      ) : (
        <form id="cu" onSubmit={submit} style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 14 }}>
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <span className="label">შესვლის ტიპი</span>
            <div className="seg" role="group" aria-label="შესვლის ტიპი" style={{ width: 'max-content' }}>
              <button type="button" aria-pressed={f.auth_provider === 'local'} onClick={() => setF({ ...f, auth_provider: 'local' })}>EMR-ის ანგარიში</button>
              <button type="button" aria-pressed={f.auth_provider === 'ldap'} onClick={() => setF({ ...f, auth_provider: 'ldap' })}>დომენი (AD)</button>
            </div>
          </div>
          <Field label="სახელი" htmlFor="fn" required><input id="fn" className="input" value={f.first_name} onChange={set('first_name')} required /></Field>
          <Field label="გვარი" htmlFor="ln" required><input id="ln" className="input" value={f.last_name} onChange={set('last_name')} required /></Field>
          <Field label="პირადი ნომერი" htmlFor="pn" required><input id="pn" className="input mono" maxLength={11} value={f.personal_number} onChange={set('personal_number')} required /></Field>
          <Field label="ელ-ფოსტა" htmlFor="em" required><input id="em" className="input" type="email" value={f.email} onChange={set('email')} required /></Field>
          {f.auth_provider === 'ldap' && <Field label="დომენის სახელი" htmlFor="lu" required hint="Windows-ში შესვლის სახელი, მაგ. giojik"><input id="lu" className="input mono" value={f.ldap_username} onChange={set('ldap_username')} required /></Field>}
          <Field label="ტელეფონი" htmlFor="ph"><input id="ph" className="input mono" value={f.phone} onChange={set('phone')} /></Field>
          <Field label="როლი" htmlFor="rl" required>
            <select id="rl" className="select" value={f.role} onChange={set('role')}>{ROLES.map((r) => <option key={r} value={r}>{ROLE_KA[r]}</option>)}</select>
          </Field>
          <Field label="განყოფილება" htmlFor="dp">
            <select id="dp" className="select" value={f.department_id} onChange={set('department_id')}><option value="">—</option>{depts.filter((d) => d.is_active).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
          </Field>
          {f.role === 'doctor' && <>
            <Field label="სპეციალობა" htmlFor="sp"><input id="sp" className="input" value={f.specialty} onChange={set('specialty')} placeholder="მაგ. კარდიოლოგი" /></Field>
            <Field label="სერტიფიკატის №" htmlFor="lc"><input id="lc" className="input mono" value={f.license_number} onChange={set('license_number')} /></Field>
            <div style={{ gridColumn: '1 / -1' }}>
              <Field label="კონსულტაციის ტარიფი" htmlFor="tf" hint="ტარიფის გარეშე ექიმზე check-in ვერ მოხდება">
                <select id="tf" className="select" value={f.consultation_tariff_id} onChange={set('consultation_tariff_id')}><option value="">—</option>{tariffs.data?.map((t) => <option key={t.id} value={t.id}>{t.title} — {money(t.base_price)}</option>)}</select>
              </Field>
            </div>
          </>}
          <div style={{ gridColumn: '1 / -1' }}><ErrorBox error={m.error} /></div>
        </form>
      )}
    </Modal>
  );
}

function EditUser({ u, depts, onClose }: { u: AdminUser; depts: Department[]; onClose: () => void }) {
  const qc = useQueryClient(); const tariffs = useTariffs(); const { user: me } = useAuth(); const toast = useToast();
  const [f, setF] = useState({ first_name: u.first_name, last_name: u.last_name, email: u.email, phone: u.phone ?? '', role: u.role, department_id: u.department_id ?? '', specialty: u.specialty ?? '', license_number: u.license_number ?? '', consultation_tariff_id: u.consultation_tariff_id ?? '' });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const [temp, setTemp] = useState<string | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['admin-users'] });
  const save = useMutation({
    mutationFn: () => api(`/users/${u.id}`, { method: 'PATCH', body: {
      first_name: f.first_name, last_name: f.last_name, email: f.email, phone: f.phone || null, role: f.role,
      department_id: f.department_id || null, specialty: f.specialty || null, license_number: f.license_number || null,
      consultation_tariff_id: f.consultation_tariff_id || null,
    } }),
    onSuccess: () => { refresh(); onClose(); },
  });
  const act = useMutation({
    mutationFn: async (a: 'reset' | 'unlock' | 'disable' | 'enable' | 'sessions') => {
      if (a === 'reset') { const r = await api<{ temporaryPassword: string }>(`/users/${u.id}/reset-password`, { method: 'POST' }); setTemp(r.temporaryPassword); return 'პაროლი აღდგა'; }
      if (a === 'sessions') { const r = await api<{ revoked: number }>(`/users/${u.id}/sessions`, { method: 'DELETE' }); return `დაიხურა ${r.revoked} სესია`; }
      await api(`/users/${u.id}/${a}`, { method: 'POST' });
      return { unlock: 'განბლოკილია', disable: 'გათიშულია — ყველა სესია დაიხურა', enable: 'ჩართულია' }[a];
    },
    onSuccess: (msg) => { toast.show(msg); refresh(); },
  });
  const self = me?.id === u.id;
  return (
    <Modal title={`${u.last_name} ${u.first_name}`} onClose={onClose} width={760}
      footer={<><button className="btn" type="button" onClick={onClose}>დახურვა</button><button className="btn primary" type="submit" form="eu" disabled={save.isPending}>შენახვა</button></>}>
      {temp && <TempPassword value={temp} who={u.email} />}
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <UserStatus u={u} />
        <span className="small muted">{u.auth_provider === 'ldap' ? `დომენი: ${u.ldap_username}` : 'EMR-ის ანგარიში'}</span>
        <div className="row" style={{ marginLeft: 'auto', flexWrap: 'wrap', gap: 6 }}>
          {u.auth_provider === 'local' && u.is_active && <button className="btn sm" type="button" onClick={() => act.mutate('reset')}>პაროლის აღდგენა</button>}
          {u.is_locked && <button className="btn sm" type="button" onClick={() => act.mutate('unlock')}>განბლოკვა</button>}
          <button className="btn sm" type="button" onClick={() => act.mutate('sessions')}>სესიების დახურვა</button>
          {!self && (u.is_active
            ? <button className="btn sm" type="button" style={{ color: 'var(--danger)' }} onClick={() => { if (confirm(`გავთიშოთ ${u.email}?`)) act.mutate('disable'); }}>გათიშვა</button>
            : <button className="btn sm" type="button" onClick={() => act.mutate('enable')}>ჩართვა</button>)}
        </div>
      </div>
      <ErrorBox error={act.error} />
      <form id="eu" onSubmit={(e) => { e.preventDefault(); save.mutate(); }} style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 14 }}>
        <Field label="სახელი" htmlFor="efn"><input id="efn" className="input" value={f.first_name} onChange={set('first_name')} /></Field>
        <Field label="გვარი" htmlFor="eln"><input id="eln" className="input" value={f.last_name} onChange={set('last_name')} /></Field>
        <Field label="ელ-ფოსტა" htmlFor="eem"><input id="eem" className="input" type="email" value={f.email} onChange={set('email')} /></Field>
        <Field label="ტელეფონი" htmlFor="eph"><input id="eph" className="input mono" value={f.phone} onChange={set('phone')} /></Field>
        <Field label="როლი" htmlFor="erl" hint={f.role !== u.role ? 'როლის შეცვლა მომხმარებლის ყველა სესიას დახურავს' : undefined}>
          <select id="erl" className="select" value={f.role} onChange={set('role')} disabled={self}>{ROLES.map((r) => <option key={r} value={r}>{ROLE_KA[r]}</option>)}</select>
        </Field>
        <Field label="განყოფილება" htmlFor="edp">
          <select id="edp" className="select" value={f.department_id} onChange={set('department_id')}><option value="">—</option>{depts.map((d) => <option key={d.id} value={d.id}>{d.name}{d.is_active ? '' : ' (გათიშული)'}</option>)}</select>
        </Field>
        {f.role === 'doctor' && <>
          <Field label="სპეციალობა" htmlFor="esp"><input id="esp" className="input" value={f.specialty} onChange={set('specialty')} /></Field>
          <Field label="სერტიფიკატის №" htmlFor="elc"><input id="elc" className="input mono" value={f.license_number} onChange={set('license_number')} /></Field>
          <div style={{ gridColumn: '1 / -1' }}>
            <Field label="კონსულტაციის ტარიფი" htmlFor="etf">
              <select id="etf" className="select" value={f.consultation_tariff_id} onChange={set('consultation_tariff_id')}><option value="">—</option>{tariffs.data?.map((t) => <option key={t.id} value={t.id}>{t.title} — {money(t.base_price)}</option>)}</select>
            </Field>
          </div>
        </>}
        <div style={{ gridColumn: '1 / -1' }}><ErrorBox error={save.error} /></div>
      </form>
      {toast.node}
    </Modal>
  );
}
