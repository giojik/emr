import type { ComponentType } from 'react';
import { NavLink, Navigate, useParams } from 'react-router-dom';
import { can, type Role } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import Balances from './Balances';
import Consumption from './Consumption';
import Counts from './Counts';
import Generics from './Generics';
import ImportPage from './Import';
import Interactions from './Interactions';
import Items from './Items';
import Locations from './Locations';
import Lots from './Lots';
import Minmax from './Minmax';
import Receipts from './Receipts';
import Reports from './Reports';
import Requests from './Requests';
import Transfer from './Transfer';
import Transit from './Transit';
import Writeoffs from './Writeoffs';
import Setup from './Setup';
import Suppliers from './Suppliers';

/** კატალოგის ნახვა (სერვერის STOCK_READ-ის შესაბამისი) */
export const STOCK_READ: Role[] = ['admin', 'storekeeper', 'stock_manager', 'pharmacist', 'nurse', 'doctor', 'lab_doctor', 'lab_manager', 'diagnostic', 'manager', 'viewer', 'accountant'];
/** ნომენკლატურის ჩანართები — საწყობის / აფთიაქის / მართვის როლებს (განყოფილებას — მხოლოდ ნაშთი, მოთხოვნა, მიღება, დაბრუნება) */
export const CATALOG_VIEW: Role[] = ['admin', 'storekeeper', 'stock_manager', 'pharmacist', 'manager', 'viewer', 'accountant'];
export const CATALOG_EDIT: Role[] = ['admin', 'stock_manager', 'pharmacist'];
export const STOCK_ADMIN: Role[] = ['admin', 'stock_manager'];
export const CLINICAL_EDIT: Role[] = ['admin', 'pharmacist'];

const TABS: { key: string; label: string; roles: Role[]; el: ComponentType }[] = [
  { key: 'balances', label: 'ნაშთები', roles: STOCK_READ, el: Balances },
  { key: 'requests', label: 'მოთხოვნები', roles: STOCK_READ, el: Requests },
  { key: 'transit', label: 'მისაღები', roles: STOCK_READ, el: Transit },
  { key: 'transfer', label: 'გადაცემა / დაბრუნება', roles: STOCK_READ, el: Transfer },
  { key: 'consumption', label: 'ხარჯი პაციენტზე', roles: STOCK_READ, el: Consumption },
  { key: 'writeoffs', label: 'ჩამოწერა', roles: STOCK_READ, el: Writeoffs },
  { key: 'counts', label: 'ინვენტარიზაცია', roles: STOCK_READ, el: Counts },
  { key: 'minmax', label: 'მინ/მაქს', roles: STOCK_READ, el: Minmax },
  { key: 'lots', label: 'ლოტები / გაწვევა', roles: STOCK_READ, el: Lots },
  { key: 'reports', label: 'რეპორტები', roles: CATALOG_VIEW, el: Reports },
  { key: 'receipts', label: 'მიღება (მომწოდებელი)', roles: CATALOG_VIEW, el: Receipts },
  { key: 'items', label: 'საქონელი', roles: CATALOG_VIEW, el: Items },
  { key: 'generics', label: 'ჯენერიკები', roles: CATALOG_VIEW, el: Generics },
  { key: 'interactions', label: 'ურთიერთქმედებები', roles: CATALOG_VIEW, el: Interactions },
  { key: 'suppliers', label: 'მომწოდებლები', roles: CATALOG_VIEW, el: Suppliers },
  { key: 'locations', label: 'ლოკაციები', roles: CATALOG_VIEW, el: Locations },
  { key: 'import', label: 'იმპორტი', roles: CATALOG_EDIT, el: ImportPage },
  { key: 'setup', label: 'პარამეტრები', roles: STOCK_ADMIN, el: Setup },
];

/** საწყობი + შიდა აფთიაქი: ნაშთები და მიღება (0031), ნომენკლატურა (0030) */
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
