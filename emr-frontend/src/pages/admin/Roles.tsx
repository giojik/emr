import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type Role } from '../../api/client';
import { useRoles, type RoleRow } from '../../components/RolePicker';
import { ErrorBox, Field, Loading, Modal } from '../../components/ui';

interface CapInfo { code: Role; group: string; name: string; grants: string }
const useCaps = () => useQuery({ queryKey: ['capabilities'], queryFn: () => api<CapInfo[]>('/roles/capabilities'), staleTime: Infinity });

/** როლები = უფლებების ნაკრები. სისტემური როლების უფლებები ფიქსირებულია; კლინიკის როლები — თავისუფლად */
export default function RolesPage() {
  const roles = useRoles(true);
  const caps = useCaps();
  const [edit, setEdit] = useState<RoleRow | 'new' | null>(null);
  const [all, setAll] = useState(false);
  const capName = (c: string) => caps.data?.find((x) => x.code === c)?.name ?? c;
  return (
    <div className="content">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <span className="muted grow small">როლი = უფლებების ნაკრები. მომხმარებელს შეიძლება ჰქონდეს რამდენიმე როლი — უფლებები ჯამდება. სისტემური როლების უფლებები ფიქსირებულია; საჭიროების შემთხვევაში შექმენით კლინიკის როლი (მაგ. „რეგისტრატორი-მოლარე“).</span>
        <label className="row small"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> გათიშულებიც</label>
        <button className="btn primary" type="button" onClick={() => setEdit('new')}>+ როლი</button>
      </div>
      <ErrorBox error={roles.error} />
      {roles.isLoading ? <Loading /> : (
        <div className="card">
          <table className="table">
            <thead><tr><th>როლი</th><th>უფლებები</th><th className="num">მომხმარებელი</th><th>ტიპი</th><th>სტატუსი</th></tr></thead>
            <tbody>{roles.data?.filter((r) => all || r.is_active).map((r) => (
              <tr key={r.id} className="clickable" onClick={() => setEdit(r)} style={r.is_active ? undefined : { opacity: 0.55 }}>
                <td><strong>{r.name}</strong> <span className="mono small muted">{r.code}</span>{r.description && <div className="small muted">{r.description}</div>}</td>
                <td><div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>{r.capabilities.map((c) => <span key={c} className={`chip${c === 'admin' ? ' danger' : ''}`} style={{ height: 20, fontSize: 11 }}>{capName(c)}</span>)}</div></td>
                <td className="num">{r.active_users}</td>
                <td>{r.is_system ? <span className="chip">სისტემური</span> : <span className="chip info">კლინიკის</span>}</td>
                <td>{r.is_active ? <span className="chip ok">აქტიური</span> : <span className="chip">გათიშული</span>}</td>
              </tr>))}</tbody>
          </table>
        </div>
      )}
      {edit && <RoleDialog r={edit === 'new' ? null : edit} caps={caps.data ?? []} onClose={() => setEdit(null)} />}
    </div>
  );
}

function RoleDialog({ r, caps, onClose }: { r: RoleRow | null; caps: CapInfo[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ code: r?.code ?? '', name: r?.name ?? '', description: r?.description ?? '', is_active: r?.is_active ?? true });
  const [sel, setSel] = useState<Role[]>(r?.capabilities ?? []);
  const locked = !!r?.is_system;
  const m = useMutation({
    mutationFn: () => r
      ? api(`/roles/${r.id}`, { method: 'PATCH', body: { name: f.name, description: f.description || null, is_active: f.is_active, ...(locked ? {} : { capabilities: sel }) } })
      : api('/roles', { body: { code: f.code, name: f.name, description: f.description || null, capabilities: sel } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['roles'] }); void qc.invalidateQueries({ queryKey: ['admin-users'] }); onClose(); },
  });
  const del = useMutation({ mutationFn: () => api(`/roles/${r!.id}`, { method: 'DELETE' }), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['roles'] }); onClose(); } });
  const groups = [...new Set(caps.map((c) => c.group))];
  const capsChanged = !!r && !locked && (sel.length !== r.capabilities.length || sel.some((c) => !r.capabilities.includes(c)));
  const deactivating = !!r && r.is_active && !f.is_active;
  const valid = f.name.trim().length >= 2 && sel.length > 0 && (r || /^[a-z][a-z0-9_]{1,39}$/.test(f.code));
  return (
    <Modal title={r ? r.name : 'ახალი როლი'} onClose={onClose} width={820}
      footer={<>{r && !r.is_system && <button className="btn" type="button" style={{ color: 'var(--danger)', marginRight: 'auto' }} disabled={del.isPending}
          onClick={() => { if (confirm(`წავშალოთ როლი „${r.name}“? (მხოლოდ თუ არავის აქვს მინიჭებული)`)) del.mutate(); }}>წაშლა</button>}
        <button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={!valid || m.isPending} onClick={() => m.mutate()}>შენახვა</button></>}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="დასახელება" htmlFor="rn" required><input id="rn" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="მაგ. რეგისტრატორი-მოლარე" /></Field>
        <Field label="კოდი" htmlFor="rc" required hint={r ? 'კოდი არ იცვლება' : 'ლათინური პატარა ასოები, ციფრები, _ — მაგ. reg_cashier'}>
          <input id="rc" className="input mono" value={f.code} disabled={!!r} onChange={(e) => setF({ ...f, code: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') })} />
        </Field>
        <div style={{ gridColumn: '1 / -1' }}><Field label="აღწერა" htmlFor="rd"><input id="rd" className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field></div>
      </div>
      <div className="stack" style={{ gap: 6 }}>
        <span className="label">უფლებები {locked && <span className="small muted">— სისტემური როლის უფლებები ფიქსირებულია</span>}</span>
        {groups.map((g) => (
          <div key={g} className="stack" style={{ gap: 2 }}>
            <span className="small muted" style={{ fontWeight: 600 }}>{g}</span>
            {caps.filter((c) => c.group === g).map((c) => (
              <label key={c.code} className="row" style={{ alignItems: 'flex-start', gap: 8, padding: '3px 0', opacity: locked && !sel.includes(c.code) ? 0.5 : 1 }}>
                <input type="checkbox" disabled={locked} checked={sel.includes(c.code)} style={{ marginTop: 3 }}
                  onChange={(e) => setSel(e.target.checked ? [...sel, c.code] : sel.filter((x) => x !== c.code))} />
                <span><strong style={{ color: c.code === 'admin' ? 'var(--danger)' : undefined }}>{c.name}</strong> <span className="small muted">— {c.grants}</span></span>
              </label>))}
          </div>))}
      </div>
      {r && r.code !== 'admin' && <label className="row"><input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> აქტიური</label>}
      {(capsChanged || deactivating) && r!.active_users > 0 && <div className="alert warn small">ცვლილება შეეხება {r!.active_users} მომხმარებელს — მათ სისტემაში თავიდან შესვლა მოუწევთ.</div>}
      {sel.includes('admin') && !locked && <div className="alert danger small">„ადმინისტრატორი“ სრულ წვდომას იძლევა — მიანიჭეთ მხოლოდ IT-ს.</div>}
      <ErrorBox error={m.error ?? del.error} />
    </Modal>
  );
}
