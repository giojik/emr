import type { ComponentType } from 'react';
import { NavLink, Navigate, useParams } from 'react-router-dom';
import { can, type Role } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import Generics from './Generics';
import ImportPage from './Import';
import Interactions from './Interactions';
import Items from './Items';
import Locations from './Locations';
import Setup from './Setup';
import Suppliers from './Suppliers';

/** კატალოგის ნახვა (სერვერის STOCK_READ-ის შესაბამისი) */
export const STOCK_READ: Role[] = ['admin', 'storekeeper', 'stock_manager', 'pharmacist', 'nurse', 'doctor', 'lab_doctor', 'lab_manager', 'diagnostic', 'manager', 'viewer', 'accountant'];
export const CATALOG_EDIT: Role[] = ['admin', 'stock_manager', 'pharmacist'];
export const STOCK_ADMIN: Role[] = ['admin', 'stock_manager'];
export const CLINICAL_EDIT: Role[] = ['admin', 'pharmacist'];

const TABS: { key: string; label: string; roles: Role[]; el: ComponentType }[] = [
  { key: 'items', label: 'საქონელი', roles: STOCK_READ, el: Items },
  { key: 'generics', label: 'ჯენერიკები (INN)', roles: STOCK_READ, el: Generics },
  { key: 'interactions', label: 'ურთიერთქმედებები', roles: STOCK_READ, el: Interactions },
  { key: 'suppliers', label: 'მომწოდებლები', roles: STOCK_READ, el: Suppliers },
  { key: 'locations', label: 'ლოკაციები', roles: STOCK_READ, el: Locations },
  { key: 'import', label: 'იმპორტი (Excel)', roles: CATALOG_EDIT, el: ImportPage },
  { key: 'setup', label: 'კატეგორიები და პარამეტრები', roles: STOCK_ADMIN, el: Setup },
];

/** საწყობი + შიდა აფთიაქი — ნომენკლატურა (0030); ნაშთები და მოძრაობები — 0031-დან */
export default function Stock() {
  const { user } = useAuth();
  const { view } = useParams();
  const tabs = TABS.filter((t) => can(user, ...t.roles));
  const cur = tabs.find((t) => t.key === view);
  if (!cur) return <Navigate to={`/stock/${tabs[0]?.key ?? 'items'}`} replace />;
  const El = cur.el;
  return (
    <>
      <header className="topbar" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8, paddingBottom: 0 }}>
        <h1>საწყობი და აფთიაქი</h1>
        <nav aria-label="საწყობი" className="row" style={{ gap: 2, flexWrap: 'wrap' }}>
          {tabs.map((t) => <NavLink key={t.key} to={`/stock/${t.key}`} className="admin-tab">{t.label}</NavLink>)}
        </nav>
      </header>
      <El />
    </>
  );
}
