import { useQuery } from '@tanstack/react-query';
import type { ComponentType } from 'react';
import { NavLink, Navigate, useParams } from 'react-router-dom';
import { api, can, type Role } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { useModuleEnabled, useModules } from '../../lib/modules';
import { Loading } from '../../components/ui';
import Invoices from './Invoices';
import Orders from './Orders';
import Payables from './Payables';
import Prices from './Prices';
import Requisitions from './Requisitions';
import { AP_READ, PROC_READ, type ApSummary, type ProcSummary } from './types';

export { PROC_READ };

const TABS: { key: string; label: string; roles: Role[]; el: ComponentType; badge?: (s: ProcSummary) => number; apBadge?: (s: ApSummary) => number }[] = [
  { key: 'requisitions', label: 'შესყიდვის მოთხოვნები (PR)', roles: PROC_READ, el: Requisitions, badge: (s) => s.pr_to_approve },
  { key: 'orders', label: 'შეკვეთები (PO)', roles: PROC_READ, el: Orders, badge: (s) => s.po_to_approve + s.po_overdue },
  { key: 'prices', label: 'მომწოდებლის ფასები', roles: PROC_READ, el: Prices },
  // 0052
  { key: 'invoices', label: 'ინვოისები', roles: AP_READ, el: Invoices, apBadge: (s) => s.mismatch + s.overdue },
  { key: 'payables', label: 'გადახდები / ხანდაზმულობა', roles: AP_READ, el: Payables },
];

/** შესყიდვები (0051): PR → დამტკიცება → PO → მიღება (საწყობი) */
export default function Procurement() {
  const { user } = useAuth();
  const { view } = useParams();
  const mods = useModules(); const enabled = useModuleEnabled('procurement');
  const sum = useQuery({ queryKey: ['proc-summary'], queryFn: () => api<ProcSummary>('/procurement/summary'), enabled, refetchInterval: 60_000 });
  const ap = useQuery({ queryKey: ['ap-summary'], queryFn: () => api<ApSummary>('/payables/summary'), enabled: enabled && can(user, ...AP_READ), refetchInterval: 60_000 });
  if (mods.isLoading) return <div className="content"><Loading /></div>;
  if (!enabled) return <div className="content"><div className="alert warn">მოდული „შესყიდვები“ გამორთულია (ადმინისტრირება → მოდულები).</div></div>;
  const tabs = TABS.filter((t) => can(user, ...t.roles));
  const cur = tabs.find((t) => t.key === view);
  if (!cur) return <Navigate to={`/procurement/${tabs[0]?.key ?? 'requisitions'}`} replace />;
  const El = cur.el;
  return (
    <>
      <header className="topbar" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8, paddingBottom: 0 }}>
        <h1>შესყიდვები და გადასახდელები</h1>
        <nav aria-label="შესყიდვები" className="row" style={{ gap: 2, flexWrap: 'wrap' }}>
          {tabs.map((t) => {
            const n = t.badge && sum.data ? t.badge(sum.data) : t.apBadge && ap.data ? t.apBadge(ap.data) : 0;
            return <NavLink key={t.key} to={`/procurement/${t.key}`} className="admin-tab">{t.label}{n > 0 && <span className="chip danger" style={{ marginLeft: 6, height: 20 }}>{n}</span>}</NavLink>;
          })}
        </nav>
      </header>
      <El />
    </>
  );
}
