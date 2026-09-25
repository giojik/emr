import { useQuery } from '@tanstack/react-query';
import { api, type Role } from '../api/client';

export interface RoleRow {
  id: string; code: string; name: string; description: string | null; is_system: boolean; capabilities: Role[]; is_active: boolean; sort_order: number;
  active_users: number; primary_users: number;
}
export const useRoles = (all = false) => useQuery({ queryKey: ['roles', all], queryFn: () => api<RoleRow[]>('/roles', { query: all ? {} : { active: true } }), staleTime: 60_000 });

/** როლების არჩევა (რამდენიმე) + ძირითადი როლი. value: კოდები, პირველი = ძირითადი */
export default function RolePicker({ value, onChange, disabled }: { value: string[]; onChange: (codes: string[]) => void; disabled?: boolean }) {
  const roles = useRoles();
  const list = roles.data ?? [];
  const primary = value[0];
  const toggle = (code: string, on: boolean) => {
    const next = on ? [...value, code] : value.filter((c) => c !== code);
    onChange(next);
  };
  return (
    <div className="stack" style={{ gap: 4, maxHeight: 280, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 10, padding: '6px 10px' }}>
      {list.map((r) => {
        const on = value.includes(r.code);
        return (
          <div key={r.code} className="row" style={{ gap: 8, padding: '3px 0' }}>
            <label className="row grow" style={{ gap: 8 }}>
              <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => toggle(r.code, e.target.checked)} />
              <span>{r.name}{!r.is_system && <span className="chip info" style={{ marginLeft: 6, height: 18, fontSize: 10 }}>კლინიკის</span>}</span>
            </label>
            {on && (primary === r.code
              ? <span className="chip ok" style={{ height: 20, fontSize: 11 }}>ძირითადი</span>
              : <button type="button" className="btn sm" style={{ height: 22, fontSize: 11 }} disabled={disabled} onClick={() => onChange([r.code, ...value.filter((c) => c !== r.code)])}>ძირითადად</button>)}
          </div>
        );
      })}
      {!list.length && <span className="small muted">იტვირთება…</span>}
    </div>
  );
}

/** არჩეული როლების ეფექტური უფლებები */
export function capsOf(codes: string[], roles: RoleRow[] | undefined): Role[] {
  return [...new Set((roles ?? []).filter((r) => codes.includes(r.code)).flatMap((r) => r.capabilities))];
}
