import { useQuery } from '@tanstack/react-query';
import { type ComponentType } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, can, type Role } from '../../../api/client';
import { useAuth } from '../../../auth/AuthContext';
import Changes from './Changes';
import Codes from './Codes';
import Lists from './Lists';
import PayerRulesView from './PayerRules';
import Quote from './Quote';
import { type Change, TARIFF_READ } from './types';

const TABS: { key: string; label: string; roles: Role[]; el: ComponentType }[] = [
  { key: 'lists', label: 'ფასთა ნუსხები', roles: TARIFF_READ, el: Lists },
  { key: 'changes', label: 'ცვლილებები', roles: TARIFF_READ, el: Changes },
  { key: 'rules', label: 'გადამხდელის წესები', roles: TARIFF_READ, el: PayerRulesView },
  { key: 'quote', label: 'ფასის შემოწმება', roles: TARIFF_READ, el: Quote },
  { key: 'codes', label: 'ტარიფების ცნობარი', roles: ['admin', 'billing'], el: Codes },
];

/**
 * ადმინისტრირება → ტარიფები (0054): ფასთა ნუსხები (საბაზო / განყოფილება / გადამხდელი) ვადით, ცვლილების მოთხოვნა / დამტკიცება,
 * გადამხდელის წესების ვერსიები, ფასის შემოწმება; „ცნობარი“ — ტარიფის კოდები და მიმართვების ტარიფები (0054-მდე არსებული ეკრანი).
 */
export default function Tariffs() {
  const { user } = useAuth();
  const [sp, setSp] = useSearchParams();
  const tabs = TABS.filter((t) => can(user, ...t.roles));
  const cur = tabs.find((t) => t.key === sp.get('tab')) ?? tabs[0];
  const pend = useQuery({ queryKey: ['tariff-changes', 'pending'], queryFn: () => api<Change[]>('/tariff-changes', { query: { status: 'pending' } }), refetchInterval: 60_000 });
  const El = cur.el;
  return (
    <>
      <div style={{ flex: '0 0 auto', padding: '16px 28px 0' }}>
        <div className="seg" role="tablist" aria-label="ტარიფები">
          {tabs.map((t) => <button key={t.key} type="button" role="tab" aria-pressed={t.key === cur.key} onClick={() => setSp({ tab: t.key })}>
            {t.label}{t.key === 'changes' && (pend.data?.length ?? 0) > 0 && <span className="chip warn" style={{ marginLeft: 6, height: 18, fontSize: 11 }}>{pend.data!.length}</span>}</button>)}
        </div>
      </div>
      <El />
    </>
  );
}
