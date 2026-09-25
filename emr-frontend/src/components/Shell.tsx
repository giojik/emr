import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import type { Role } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { initials, ROLE_KA } from '../lib/format';

const NAV: { to: string; label: string; roles: Role[] }[] = [
  { to: '/reception', label: 'რეგისტრატურა', roles: ['admin', 'receptionist'] },
  { to: '/patients', label: 'პაციენტები', roles: ['admin', 'receptionist', 'doctor', 'nurse', 'billing'] },
  { to: '/cashier', label: 'სალარო', roles: ['admin', 'receptionist', 'billing'] },
  { to: '/doctor', label: 'ჩემი ვიზიტები', roles: ['doctor'] },
  { to: '/visits', label: 'ვიზიტები', roles: ['admin', 'nurse'] },
  { to: '/collection', label: 'ნიმუშის აღება', roles: ['admin', 'nurse', 'phlebotomist'] },
  { to: '/diagnostics', label: 'დიაგნოსტიკა', roles: ['admin', 'diagnostic', 'lab_doctor', 'lab_manager', 'radiographer', 'radiologist'] },
  { to: '/diagnostics/radiology', label: 'რადიოლოგიის განრიგი', roles: ['receptionist'] },
  { to: '/admin', label: 'ადმინისტრირება', roles: ['admin', 'billing'] },
  { to: '/admin/allergens', label: 'ალერგენები', roles: ['pharmacist'] },
  { to: '/admin/catalog', label: 'ანალიზების კატალოგი', roles: ['lab_doctor', 'lab_manager'] },
  { to: '/admin/overrides', label: 'override-ები', roles: ['pharmacist'] },
];

export function homeFor(role: Role) {
  return role === 'doctor' ? '/doctor' : role === 'billing' ? '/cashier' : role === 'nurse' ? '/visits' : role === 'receptionist' || role === 'admin' ? '/reception' : role === 'pharmacist' ? '/admin/allergens' : role === 'diagnostic' || role === 'lab_doctor' ? '/diagnostics/lab' : role === 'lab_manager' ? '/admin/catalog' : role === 'phlebotomist' ? '/collection' : role === 'radiographer' || role === 'radiologist' ? '/diagnostics/radiology' : '/patients';
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
          {NAV.filter((n) => n.roles.includes(user.role)).map((n) => <NavLink key={n.to} to={n.to}>{n.label}</NavLink>)}
        </nav>
        <div className="me">
          <div className="avatar" aria-hidden="true">{initials(user.name)}</div>
          <div className="stack grow" style={{ gap: 0 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{user.name}</span>
            <span className="small muted">{ROLE_KA[user.role]}</span>
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
