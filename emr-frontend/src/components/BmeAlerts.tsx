import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, can } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { tsDate } from '../lib/format';
import { useModuleEnabled } from '../lib/modules';

export type BmeArea = 'radiology' | 'endoscopy' | 'scopes' | 'cssd' | 'lab' | 'or';
export interface BmeAlert {
  id: string; inv_no: string; name: string; status: 'restricted' | 'down' | 'retired'; status_reason: string | null; status_since: string; criticality: string; blocking: boolean;
  dx_device_id: string | null; lab_method_id: string | null; cssd_machine_id: string | null; endo_scope_id: string | null; or_room_id: string | null; or_room_name: string | null;
  department_name: string | null; type_name: string;
}
export const BME_STATUS_SHORT: Record<string, string> = { operational: 'მუშა', restricted: 'შეზღუდულად', down: 'გაუმართავი', standby: 'რეზერვი', retired: 'გამოყვანილი' };
const AREA_KA: Record<BmeArea, string> = { radiology: 'რადიოლოგიის აპარატი', endoscopy: 'ენდოსკოპიის ოთახი / სისტემა', scopes: 'ენდოსკოპი', cssd: 'CSSD აპარატი', lab: 'ანალიზატორი', or: 'საოპერაციოს აპარატი' };

export const useBmeAlerts = (area: BmeArea) => {
  const on = useModuleEnabled('bme');
  return useQuery({ queryKey: ['bme-alerts', area], queryFn: () => api<{ area: BmeArea; mode: 'block' | 'warn' | 'off'; items: BmeAlert[] }>('/bme/alerts', { query: { area } }),
    enabled: on, refetchInterval: 60_000, staleTime: 30_000 });
};

/**
 * ბიომედ-აპარატურის გაფრთხილება (0073) — სამუშაო ეკრანის თავში: მიბმული აპარატი არ არის „მუშა“.
 * block რეჟიმში გაუმართავზე / გამოყვანილზე ჩაწერა / გამოყენება სერვერზე ჩერდება (409 BME_DOWN); warn — მხოლოდ ეს გაფრთხილება.
 */
export default function BmeAlerts({ area, pad }: { area: BmeArea; pad?: boolean }) {
  const { user } = useAuth();
  const q = useBmeAlerts(area);
  const items = q.data?.items ?? [];
  if (!items.length) return null;
  const eng = can(user, 'admin', 'med_engineer');
  const blocking = items.some((i) => i.blocking);
  return (
    <div style={pad ? { padding: '10px 28px 0' } : undefined}>
      <div className={`alert ${items.some((i) => i.status !== 'restricted') ? 'danger' : 'warn'}`} role="status" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
        <strong>ბიომედ-აპარატურა: {AREA_KA[area]} — {items.length === 1 ? 'არ არის სრულად მუშა' : `${items.length} აპარატი არ არის სრულად მუშა`}</strong>
        {items.map((i) => (
          <span key={i.id} className="small">
            <span className={`chip ${i.status === 'restricted' ? 'warn' : 'danger'}`} style={{ height: 20, fontSize: 11, background: '#fff' }}>{BME_STATUS_SHORT[i.status]}</span>{' '}
            {eng ? <Link to={`/bme?device=${i.id}`}><strong>{i.name}</strong></Link> : <strong>{i.name}</strong>} <span className="mono muted">{i.inv_no}</span>
            {i.or_room_name && <> · {i.or_room_name}</>}{i.status_reason && <> — {i.status_reason}</>}<span className="muted"> · {tsDate(i.status_since)}</span>
            {i.blocking && <strong> · ჩაწერა / გამოყენება დაბლოკილია</strong>}
          </span>))}
        {!blocking && q.data?.mode === 'warn' && <span className="small muted">გაფრთხილების რეჟიმი — ჩაწერა / გამოყენება არ ჩერდება (ადმინისტრირება → მოდულები → ბიომედ-აპარატურა).</span>}
      </div>
    </div>
  );
}
