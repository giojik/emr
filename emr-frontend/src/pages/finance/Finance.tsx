import { useQuery } from '@tanstack/react-query';
import { useState, type ComponentType } from 'react';
import { NavLink, Navigate, useParams } from 'react-router-dom';
import { api, can, type Role } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Loading } from '../../components/ui';
import { todayISO } from '../../lib/format';
import { useModuleEnabled, useModules } from '../../lib/modules';
import Claims from './Claims';
import DeptResultView from './DeptResult';
import Periods from './Periods';
import RevenueView from './Revenue';
import StockView from './Stock';
import { FIN_FULL, FIN_READ, type FinSummary, monthStart } from './types';

export { FIN_READ };

export interface TabProps { from: string; to: string; summary: FinSummary }
const TABS: { key: string; label: string; roles: Role[]; el: ComponentType<TabProps>; period?: boolean; badge?: (s: FinSummary) => number }[] = [
  { key: 'revenue', label: 'შემოსავალი', roles: FIN_READ, el: RevenueView, period: true },
  { key: 'stock', label: 'მარაგი / მოხმარება', roles: FIN_READ, el: StockView, period: true },
  { key: 'result', label: 'განყოფილების შედეგი', roles: FIN_READ, el: DeptResultView, period: true },
  { key: 'claims', label: 'დებიტორები / ქლეიმები', roles: [...FIN_FULL, 'billing'], el: Claims, badge: (s) => s.claims?.overdue ?? 0 },
  { key: 'periods', label: 'პერიოდები', roles: FIN_FULL, el: Periods },
];

/** ფინანსები (0053): შემოსავალი გადამხდელით / განყოფილებით, მარაგის ღირებულება და მოხმარება, განყოფილების შედეგი, დებიტორები, პერიოდის დახურვა */
export default function Finance() {
  const { user } = useAuth();
  const { view } = useParams();
  const mods = useModules(); const enabled = useModuleEnabled('finance');
  const sum = useQuery({ queryKey: ['fin-summary'], queryFn: () => api<FinSummary>('/finance/summary'), enabled, refetchInterval: 60_000 });
  const [from, setFrom] = useState(monthStart(todayISO())); const [to, setTo] = useState(todayISO());
  if (mods.isLoading) return <div className="content"><Loading /></div>;
  if (!enabled) return <div className="content"><div className="alert warn">მოდული „ფინანსები“ გამორთულია (ადმინისტრირება → მოდულები).</div></div>;
  const tabs = TABS.filter((t) => can(user, ...t.roles));
  const cur = tabs.find((t) => t.key === view);
  if (!cur) return <Navigate to={`/finance/${tabs[0]?.key ?? 'revenue'}`} replace />;
  const El = cur.el;
  const preset = (k: 'month' | 'prev' | 'year') => {
    const t = todayISO();
    if (k === 'month') { setFrom(monthStart(t)); setTo(t); }
    if (k === 'year') { setFrom(`${t.slice(0, 4)}-01-01`); setTo(t); }
    if (k === 'prev') { const d = new Date(`${monthStart(t)}T00:00:00Z`); d.setUTCDate(0); const e = d.toISOString().slice(0, 10); setFrom(monthStart(e)); setTo(e); }
  };
  return (
    <>
      <header className="topbar" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8, paddingBottom: 0 }}>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <h1 className="grow">ფინანსები{sum.data?.scope_department ? ` — ${sum.data.scope_department}` : ''}</h1>
          {sum.data && <span className={`chip ${sum.data.period_lock === 'on' ? 'ok' : ''}`} title="პერიოდის დახურვა (period_lock)">
            {sum.data.period_lock === 'on' ? `დახურვა ჩართულია${sum.data.last_closed ? ` · ბოლო დახურული: ${sum.data.last_closed}` : ''}` : 'პერიოდის დაცვა გამორთულია'}</span>}
          {cur.period && <>
            <div className="seg" role="group" aria-label="სწრაფი პერიოდი">
              <button type="button" onClick={() => preset('month')}>ეს თვე</button><button type="button" onClick={() => preset('prev')}>წინა თვე</button><button type="button" onClick={() => preset('year')}>წელი</button>
            </div>
            <input className="input mono" type="date" style={{ height: 34, width: 150 }} aria-label="დან" value={from} max={to} onChange={(e) => setFrom(e.target.value || from)} />
            <input className="input mono" type="date" style={{ height: 34, width: 150 }} aria-label="მდე" value={to} min={from} onChange={(e) => setTo(e.target.value || to)} />
          </>}
        </div>
        <nav aria-label="ფინანსები" className="row" style={{ gap: 2, flexWrap: 'wrap' }}>
          {tabs.map((t) => {
            const n = t.badge && sum.data ? t.badge(sum.data) : 0;
            return <NavLink key={t.key} to={`/finance/${t.key}`} className="admin-tab">{t.label}{n > 0 && <span className="chip danger" style={{ marginLeft: 6, height: 20 }}>{n}</span>}</NavLink>;
          })}
        </nav>
      </header>
      {sum.error ? <div className="content"><ErrorBox error={sum.error} /></div> : !sum.data ? <div className="content"><Loading /></div> : <El from={from} to={to} summary={sum.data} />}
    </>
  );
}
