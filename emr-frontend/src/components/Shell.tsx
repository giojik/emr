import NotificationBell from './NotificationBell';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { can, type Role, type SessionUser } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { initials, ROLE_KA } from '../lib/format';
import { useModules } from '../lib/modules';

/** roles — ვის ჩანს (ცარიელი — ყველა უფლებიანს); module — მხოლოდ ჩართული მოდულისას (0037) */
const NAV: { to: string; label: string; roles?: Role[]; module?: string }[] = [
  { to: '/reception', label: 'რეგისტრატურა', roles: ['admin', 'receptionist', 'manager', 'viewer'] },
  { to: '/patients', label: 'პაციენტები', roles: ['admin', 'receptionist', 'doctor', 'nurse', 'billing', 'manager'] },
  { to: '/cashier', label: 'სალარო', roles: ['admin', 'receptionist', 'billing'] },
  { to: '/doctor', label: 'ჩემი ვიზიტები', roles: ['doctor'] },
  { to: '/visits', label: 'ვიზიტები', roles: ['admin', 'nurse'] },
  { to: '/inpatient', label: 'სტაციონარი', roles: ['admin', 'doctor', 'nurse', 'receptionist', 'manager', 'viewer', 'billing'], module: 'inpatient' },
  { to: '/or', label: 'საოპერაციო', roles: ['admin', 'doctor', 'nurse', 'or_schedule', 'anesthesiologist', 'or_nurse', 'manager', 'viewer'], module: 'or' },
  { to: '/collection', label: 'ნიმუშის აღება', roles: ['admin', 'nurse', 'phlebotomist'] },
  { to: '/diagnostics', label: 'დიაგნოსტიკა', roles: ['admin', 'diagnostic', 'lab_doctor', 'lab_manager', 'radiographer', 'radiologist', 'endoscopist', 'endoscopy_nurse'] },
  { to: '/diagnostics/radiology?view=schedule', label: 'დიაგნოსტიკის განრიგი', roles: ['receptionist', 'manager', 'viewer'] },
  { to: '/stock', label: 'საწყობი და აფთიაქი', roles: ['admin', 'storekeeper', 'stock_manager', 'pharmacist', 'manager', 'viewer', 'accountant'] },
  { to: '/stock/requests', label: 'მარაგი / მოთხოვნები', roles: ['nurse'] },
  { to: '/stock/lab', label: 'ლაბ. მარაგი', roles: ['lab_doctor', 'lab_manager', 'diagnostic'] },
  { to: '/assets', label: 'ინვენტარი', module: 'asset_register' },
  { to: '/cssd', label: 'სტერილიზაცია', module: 'cssd' },
  { to: '/reports', label: 'რეპორტები', roles: ['admin', 'accountant', 'viewer', 'manager'] },
  { to: '/diagnostics/endoscopy?view=scopes', label: 'ენდოსკოპები', roles: ['med_engineer'] },
  { to: '/admin', label: 'ადმინისტრირება', roles: ['admin', 'billing', 'hr', 'manager', 'med_engineer'] },
  { to: '/admin/allergens', label: 'ალერგენები', roles: ['pharmacist'] },
  { to: '/admin/catalog', label: 'ანალიზების კატალოგი', roles: ['lab_doctor', 'lab_manager'] },
  { to: '/admin/overrides', label: 'override-ები', roles: ['pharmacist'] },
];

const HOME: Record<Role, string> = {
  doctor: '/doctor', admin: '/reception', receptionist: '/reception', billing: '/cashier', nurse: '/visits', pharmacist: '/stock/verification',
  diagnostic: '/diagnostics/lab', lab_doctor: '/diagnostics/lab', lab_manager: '/admin/catalog', phlebotomist: '/collection',
  radiographer: '/diagnostics/radiology', radiologist: '/diagnostics/radiology', endoscopist: '/diagnostics/endoscopy', endoscopy_nurse: '/diagnostics/endoscopy',
  accountant: '/reports', viewer: '/reports', manager: '/reception', hr: '/admin/users', med_engineer: '/admin/devices',
  storekeeper: '/stock/balances', stock_manager: '/stock/balances',
  or_schedule: '/or?tab=board', anesthesiologist: '/or?tab=my', or_nurse: '/or?tab=board',
};
/** საწყისი გვერდი: ძირითადი როლის პირველი უფლებით, შემდეგ — დანარჩენებით */
export function homeFor(user: Pick<SessionUser, 'caps' | 'roles'>) {
  const order = [...(user.roles[0]?.capabilities ?? []), ...user.caps];
  for (const c of order) if (HOME[c]) return HOME[c];
  return user.caps.length ? '/patients' : '/no-access';
}

export default function Shell() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const mods = useModules();
  if (!user) return null;
  const on = (code?: string) => !code || !!mods.data?.find((m) => m.code === code)?.enabled;
  return (
    <div className="app">
      <aside className="side">
        <div className="brand">
          <div className="brand-mark">EMR</div>
          <div className="stack" style={{ gap: 0 }}><strong style={{ fontSize: 14 }}>ინოვა მედიკალი</strong><span className="small muted">ამბულატორია</span></div>
        </div>
        <nav className="nav" aria-label="მთავარი მენიუ">
          {NAV.filter((n) => (n.roles ? can(user, ...n.roles) : user.caps.length > 0) && on(n.module)).map((n) => <NavLink key={n.to} to={n.to}>{n.label}</NavLink>)}
        </nav>
        <div className="me">
          <div className="avatar" aria-hidden="true">{initials(user.name)}</div>
          <div className="stack grow" style={{ gap: 0 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{user.name}</span>
            <span className="small muted" title={user.roles.map((r) => r.name).join(', ')}>{user.roles[0]?.name ?? ROLE_KA[user.role] ?? user.role}{user.roles.length > 1 ? ` +${user.roles.length - 1}` : ''}</span>
          </div>
          <NotificationBell />
          <button type="button" className="icon-btn" aria-label="გასვლა" title="გასვლა" onClick={async () => { await logout(); nav('/login'); }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M15 4h4v16h-4" /><path d="M10 8l-4 4 4 4" /><path d="M6 12h10" /></svg>
          </button>
        </div>
      </aside>
      <div className="main"><Outlet /></div>
    </div>
  );
}
