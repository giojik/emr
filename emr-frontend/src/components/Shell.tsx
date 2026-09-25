import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { can, type Role, type SessionUser } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { initials, ROLE_KA } from '../lib/format';

const NAV: { to: string; label: string; roles: Role[] }[] = [
  { to: '/reception', label: 'რეგისტრატურა', roles: ['admin', 'receptionist'] },
  { to: '/patients', label: 'პაციენტები', roles: ['admin', 'receptionist', 'doctor', 'nurse', 'billing'] },
  { to: '/cashier', label: 'სალარო', roles: ['admin', 'receptionist', 'billing'] },
  { to: '/doctor', label: 'ჩემი ვიზიტები', roles: ['doctor'] },
  { to: '/visits', label: 'ვიზიტები', roles: ['admin', 'nurse'] },
  { to: '/collection', label: 'ნიმუშის აღება', roles: ['admin', 'nurse', 'phlebotomist'] },
  { to: '/diagnostics', label: 'დიაგნოსტიკა', roles: ['admin', 'diagnostic', 'lab_doctor', 'lab_manager', 'radiographer', 'radiologist', 'endoscopist', 'endoscopy_nurse'] },
  { to: '/diagnostics/radiology', label: 'დიაგნოსტიკის განრიგი', roles: ['receptionist'] },
  { to: '/admin', label: 'ადმინისტრირება', roles: ['admin', 'billing'] },
  { to: '/admin/allergens', label: 'ალერგენები', roles: ['pharmacist'] },
  { to: '/admin/catalog', label: 'ანალიზების კატალოგი', roles: ['lab_doctor', 'lab_manager'] },
  { to: '/admin/overrides', label: 'override-ები', roles: ['pharmacist'] },
];

const HOME: Record<Role, string> = {
  doctor: '/doctor', admin: '/reception', receptionist: '/reception', billing: '/cashier', nurse: '/visits', pharmacist: '/admin/allergens',
  diagnostic: '/diagnostics/lab', lab_doctor: '/diagnostics/lab', lab_manager: '/admin/catalog', phlebotomist: '/collection',
  radiographer: '/diagnostics/radiology', radiologist: '/diagnostics/radiology', endoscopist: '/diagnostics/endoscopy', endoscopy_nurse: '/diagnostics/endoscopy',
};
/** საწყისი გვერდი: ძირითადი როლის პირველი უფლებით, შემდეგ — დანარჩენებით */
export function homeFor(user: Pick<SessionUser, 'caps' | 'roles'>) {
  const order = [...(user.roles[0]?.capabilities ?? []), ...user.caps];
  for (const c of order) if (HOME[c]) return HOME[c];
  return '/patients';
}

export default function Shell() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  if (!user) return null;
  return (
    <div className="app">
      <aside className="side">
        <div className="brand">
          <div className="brand-mark">EMR</div>
          <div className="stack" style={{ gap: 0 }}><strong style={{ fontSize: 14 }}>ინოვა მედიკალი</strong><span className="small muted">ამბულატორია</span></div>
        </div>
        <nav className="nav" aria-label="მთავარი მენიუ">
          {NAV.filter((n) => can(user, ...n.roles)).map((n) => <NavLink key={n.to} to={n.to}>{n.label}</NavLink>)}
        </nav>
        <div className="me">
          <div className="avatar" aria-hidden="true">{initials(user.name)}</div>
          <div className="stack grow" style={{ gap: 0 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{user.name}</span>
            <span className="small muted" title={user.roles.map((r) => r.name).join(', ')}>{user.roles[0]?.name ?? ROLE_KA[user.role] ?? user.role}{user.roles.length > 1 ? ` +${user.roles.length - 1}` : ''}</span>
          </div>
          <button type="button" className="icon-btn" aria-label="გასვლა" title="გასვლა" onClick={async () => { await logout(); nav('/login'); }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M15 4h4v16h-4" /><path d="M10 8l-4 4 4 4" /><path d="M6 12h10" /></svg>
          </button>
        </div>
      </aside>
      <div className="main"><Outlet /></div>
    </div>
  );
}
