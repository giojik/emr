import NotificationBell from './NotificationBell';
import WorklistBadge from './WorklistBadge';
import { IncidentReportHost } from './IncidentReport';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { can, type Role, type SessionUser } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { initials, ROLE_KA } from '../lib/format';
import { useLicenseStatus, useModules, type LicenseStatus } from '../lib/modules';
import { dateGe, tsDate } from '../lib/format';

/** roles — ვის ჩანს (ცარიელი — ყველა უფლებიანს); module — მხოლოდ ჩართული მოდულისას (0037) */
const NAV: { to: string; label: string; roles?: Role[]; module?: string; setting?: [string, string]; not?: Role[] }[] = [
  { to: '/tasks', label: 'ჩემი დავალებები', module: 'worklist' },
  { to: '/reception', label: 'რეგისტრატურა', roles: ['admin', 'receptionist', 'manager', 'viewer'] },
  { to: '/patients', label: 'პაციენტები', roles: ['admin', 'receptionist', 'doctor', 'nurse', 'billing', 'manager'] },
  { to: '/cashier', label: 'სალარო', roles: ['admin', 'receptionist', 'billing'] },
  { to: '/doctor', label: 'ჩემი ვიზიტები', roles: ['doctor'] },
  { to: '/visits', label: 'ვიზიტები', roles: ['admin', 'nurse'] },
  { to: '/inpatient', label: 'სტაციონარი', roles: ['admin', 'doctor', 'nurse', 'receptionist', 'manager', 'viewer', 'billing', 'drg'], module: 'inpatient' },
  { to: '/or', label: 'საოპერაციო', roles: ['admin', 'doctor', 'nurse', 'or_schedule', 'anesthesiologist', 'or_nurse', 'manager', 'viewer'], module: 'or' },
  { to: '/collection', label: 'ნიმუშის აღება', roles: ['admin', 'nurse', 'phlebotomist'] },
  { to: '/diagnostics', label: 'დიაგნოსტიკა', roles: ['admin', 'diagnostic', 'lab_doctor', 'lab_manager', 'radiographer', 'radiologist', 'endoscopist', 'endoscopy_nurse'] },
  { to: '/diagnostics/radiology?view=schedule', label: 'დიაგნოსტიკის განრიგი', roles: ['receptionist', 'manager', 'viewer'] },
  { to: '/stock', label: 'საწყობი და აფთიაქი', roles: ['admin', 'storekeeper', 'stock_manager', 'pharmacist', 'manager', 'viewer', 'accountant'] },
  { to: '/procurement', label: 'შესყიდვები / გადასახდელები', roles: ['admin', 'procurement', 'procurement_approve', 'stock_manager', 'storekeeper', 'pharmacist', 'accountant', 'manager', 'viewer'], module: 'procurement' },
  { to: '/finance', label: 'ფინანსები', roles: ['admin', 'accountant', 'viewer', 'manager', 'billing'], module: 'finance' },
  { to: '/stock/requests', label: 'მარაგი / მოთხოვნები', roles: ['nurse'] },
  { to: '/stock/lab', label: 'ლაბ. მარაგი', roles: ['lab_doctor', 'lab_manager', 'diagnostic'] },
  { to: '/assets', label: 'ინვენტარი', module: 'asset_register' },
  { to: '/bme', label: 'ბიომედ-აპარატურა', module: 'bme' },
  { to: '/cssd', label: 'სტერილიზაცია', module: 'cssd' },
  { to: '/roster', label: 'ცვლები და მორიგეობა', module: 'roster' },
  { to: '/dashboard', label: 'მენეჯერული დაფა', roles: ['admin', 'reports', 'reports_all', 'manager', 'viewer'], module: 'reporting' },
  { to: '/quality', label: 'ხარისხი და ინციდენტები', module: 'quality' },
  { to: '/ipc', label: 'ინფექციის კონტროლი', roles: ['infection', 'infection_dept', 'infection_view'], module: 'ipc' },
  { to: '/ipc?tab=audits', label: 'IPC ჩეკლისტები', roles: ['doctor', 'nurse'], module: 'ipc', setting: ['ipc', 'audit_by_dept_head'], not: ['infection', 'infection_dept', 'infection_view'] },
  { to: '/antibiogram', label: 'ანტიბიოგრამა', roles: ['doctor', 'pharmacist', 'anesthesiologist', 'lab_doctor', 'lab_manager'], module: 'ipc' },
  { to: '/reports', label: 'რეპორტები', roles: ['admin', 'accountant', 'viewer', 'manager'] },
  { to: '/diagnostics/endoscopy?view=scopes', label: 'ენდოსკოპები', roles: ['med_engineer'] },
  { to: '/admin', label: 'ადმინისტრირება', roles: ['admin', 'billing', 'hr', 'manager', 'med_engineer'] },
  { to: '/admin/tariffs', label: 'ტარიფები', roles: ['tariffs', 'tariffs_approve', 'accountant', 'viewer'] },
  { to: '/admin/drg', label: 'DRG', roles: ['drg', 'drg_admin'], module: 'drg' },
  { to: '/admin/allergens', label: 'ალერგენები', roles: ['pharmacist'] },
  { to: '/admin/catalog', label: 'ანალიზების კატალოგი', roles: ['lab_doctor', 'lab_manager'] },
  { to: '/admin/overrides', label: 'override-ები', roles: ['pharmacist'] },
];

const HOME: Record<Role, string> = {
  doctor: '/doctor', admin: '/reception', receptionist: '/reception', billing: '/cashier', nurse: '/visits', pharmacist: '/stock/verification',
  diagnostic: '/diagnostics/lab', lab_doctor: '/diagnostics/lab', lab_manager: '/admin/catalog', phlebotomist: '/collection',
  radiographer: '/diagnostics/radiology', radiologist: '/diagnostics/radiology', endoscopist: '/diagnostics/endoscopy', endoscopy_nurse: '/diagnostics/endoscopy',
  accountant: '/reports', viewer: '/dashboard', manager: '/reception', hr: '/admin/users', med_engineer: '/bme',
  storekeeper: '/stock/balances', stock_manager: '/stock/balances',
  or_schedule: '/or?tab=board', anesthesiologist: '/or?tab=my', or_nurse: '/or?tab=board',
  procurement: '/procurement/requisitions', procurement_approve: '/procurement/requisitions?to_approve=1',
  tariffs: '/admin/tariffs', tariffs_approve: '/admin/tariffs?tab=changes',
  drg: '/inpatient?tab=billing', drg_admin: '/admin/drg',
  reports: '/dashboard', reports_all: '/dashboard', reports_phi: '/dashboard',
  quality: '/quality', quality_dept: '/quality', quality_view: '/quality',
  infection: '/ipc', infection_dept: '/ipc', infection_view: '/dashboard',
  bme_dept: '/bme', bme_view: '/bme',
  roster: '/roster', roster_all: '/roster', roster_view: '/roster', absence_approve: '/roster?tab=approvals',
  worklist_manage: '/tasks?tab=team', worklist_all: '/tasks?tab=team',
};
/** საწყისი გვერდი: ძირითადი როლის პირველი უფლებით, შემდეგ — დანარჩენებით; override — მოდულის პარამეტრი (0081: „ჩემი დავალებები“ ყველასთვის) */
export function homeFor(user: Pick<SessionUser, 'caps' | 'roles'>, override?: string | null) {
  if (override && user.caps.length) return override;
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
  const set = (x?: [string, string]) => !x || !!(mods.data?.find((m) => m.code === x[0])?.settings as Record<string, unknown> | undefined)?.[x[1]];
  return (
    <div className="app">
      <aside className="side">
        <div className="brand">
          <div className="brand-mark">EMR</div>
          <div className="stack" style={{ gap: 0 }}><strong style={{ fontSize: 14 }}>ინოვა მედიკალი</strong><span className="small muted">ამბულატორია</span></div>
        </div>
        <nav className="nav" aria-label="მთავარი მენიუ">
          {NAV.filter((n) => (n.roles ? can(user, ...n.roles) : user.caps.length > 0) && on(n.module) && set(n.setting) && !(n.not && can(user, ...n.not))).map((n) => <NavLink key={n.to} to={n.to}>{n.label}</NavLink>)}
        </nav>
        <div className="stack" style={{ marginTop: 'auto', gap: 10 }}>
          <IncidentReportHost />
          <div className="me">
            <div className="avatar" aria-hidden="true">{initials(user.name)}</div>
            <div className="stack grow" style={{ gap: 0 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{user.name}</span>
              <span className="small muted" title={user.roles.map((r) => r.name).join(', ')}>{user.roles[0]?.name ?? ROLE_KA[user.role] ?? user.role}{user.roles.length > 1 ? ` +${user.roles.length - 1}` : ''}</span>
            </div>
            <WorklistBadge />
            <NotificationBell />
            <button type="button" className="icon-btn" aria-label="გასვლა" title="გასვლა" onClick={async () => { await logout(); nav('/login'); }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M15 4h4v16h-4" /><path d="M10 8l-4 4 4 4" /><path d="M6 12h10" /></svg>
            </button>
          </div>
        </div>
      </aside>
      <div className="main"><LicenseBanner admin={can(user, 'admin', 'manager')} /><Outlet /></div>
    </div>
  );
}

/** 0085: ლიცენზიის ბანერი — admin / manager: გაფრთხილების მთელი პერიოდი (+ dev / ლიცენზიის გარეშე); ყველა: ბოლო 7 დღე, შეღავათი, ვადაგასული */
function licenseText(st: LicenseStatus): [string, string] | null {
  if (st.mode === 'dev') return ['სატესტო რეჟიმი: ლიცენზია არ არის — ყველა მოდული ჩართულია.', 'info'];
  if (st.mode === 'none') return ['ლიცენზია არ არის — მუშაობს მხოლოდ ბირთვი (ადმინისტრირება → ლიცენზია).', 'danger'];
  if (st.phase === 'warning') return [`ლიცენზიის ვადა იწურება ${st.expires ? dateGe(st.expires) : ''}${st.days_left !== null ? ` (დარჩა ${st.days_left} დღე)` : ''} — განახლებისთვის დაუკავშირდით მომწოდებელს.`, 'warn'];
  if (st.phase === 'grace') return [`ლიცენზიის ვადა გავიდა ${st.expires ? dateGe(st.expires) : ''}. სისტემა სრულად მუშაობს ${st.grace_until ? tsDate(st.grace_until) : ''}-მდე, შემდეგ ოპციური მოდულები მხოლოდ წაკითხვაზე გადავა.`, 'warn'];
  if (st.phase === 'expired') return ['ლიცენზიის ვადა გავიდა — ოპციური მოდულები მხოლოდ წაკითხვის რეჟიმშია (ნახვა / ბეჭდვა — კი, ახალი ჩანაწერი — არა). ბირთვი მუშაობს.', 'danger'];
  return null;
}
function LicenseBanner({ admin }: { admin: boolean }) {
  const q = useLicenseStatus();
  const st = q.data;
  if (!st || st.banner === 'none' || (st.banner === 'admins' && !admin)) return null;
  const t = licenseText(st);
  if (!t) return null;
  return <div role="status" className={`license-banner ${t[1]}`}>{t[0]}{admin && <> <NavLink to="/admin/license">ლიცენზია →</NavLink></>}</div>;
}
