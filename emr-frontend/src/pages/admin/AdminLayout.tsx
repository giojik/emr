import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';

const TABS: { to: string; label: string; roles: string[] }[] = [
  { to: '/admin/users', label: 'მომხმარებლები', roles: ['admin'] },
  { to: '/admin/departments', label: 'განყოფილებები', roles: ['admin'] },
  { to: '/admin/tariffs', label: 'ტარიფები', roles: ['admin', 'billing'] },
  { to: '/admin/catalog', label: 'კვლევების კატალოგი', roles: ['admin', 'lab_doctor', 'lab_manager', 'billing'] },
  { to: '/admin/clinic', label: 'კლინიკა', roles: ['admin'] },
  { to: '/admin/consents', label: 'თანხმობები', roles: ['admin'] },
  { to: '/admin/allergens', label: 'ალერგენები', roles: ['admin', 'pharmacist'] },
  { to: '/admin/overrides', label: 'ალერგიის override-ები', roles: ['admin', 'pharmacist'] },
  { to: '/admin/audit', label: 'აუდიტი', roles: ['admin'] },
];

export default function AdminLayout() {
  const { user } = useAuth();
  const tabs = TABS.filter((t) => user && t.roles.includes(user.role));
  return (
    <>
      <header className="topbar" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8, paddingBottom: 0 }}>
        <h1>ადმინისტრირება</h1>
        <nav aria-label="ადმინისტრირება" className="row" style={{ gap: 2, flexWrap: 'wrap' }}>
          {tabs.map((t) => (
            <NavLink key={t.to} to={t.to} className="admin-tab">{t.label}</NavLink>
          ))}
        </nav>
      </header>
      <Outlet />
    </>
  );
}
