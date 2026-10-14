import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import { ErrorBox, Loading } from '../../components/ui';
import { AttentionPanel, type Headline, HeadlineTiles, LivePanel } from './Panels';
import { fmtTime, type RptMeta } from './types';

/**
 * ეკრანის (TV) რეჟიმი (0061): კედლის ეკრანისთვის — მენიუს გარეშე, დიდი შრიფტი, ავტომატური განახლება (tv_refresh_min),
 * მხოლოდ აგრეგატები (ჩაღრმავება / პაციენტის მონაცემი არ არის). მომხმარებლის სესიით — ანონიმური ბმული არ არსებობს.
 */
export default function Tv() {
  const [sp] = useSearchParams();
  const view = sp.get('view') === 'executive' ? 'executive' : 'department';
  const dept = sp.get('department_id') ?? '';
  const meta = useQuery({ queryKey: ['rpt-meta'], queryFn: () => api<RptMeta>('/reporting/meta') });
  const every = (meta.data?.settings.tv_refresh_min ?? 5) * 60_000;
  const today = meta.data?.today ?? new Date().toISOString().slice(0, 10);
  const from = `${today.slice(0, 8)}01`;
  const h = useQuery({ queryKey: ['rpt-tv-headline', view, dept, today], enabled: !!meta.data, refetchInterval: every,
    queryFn: () => api<Headline>('/reporting/headline', { query: { dashboard: view, from, to: today, department_id: dept, compare: 'prev' } }) });
  const [now, setNow] = useState(new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 30_000); return () => clearInterval(t); }, []);
  const deptName = dept ? meta.data?.scope.departments.find((d) => d.id === dept)?.name : meta.data?.scope.all ? 'მთელი კლინიკა' : meta.data?.scope.departments.map((d) => d.name).join(', ');
  const full = () => { void document.documentElement.requestFullscreen?.().catch(() => undefined); };
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <header className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
        <h1 className="grow" style={{ margin: 0, fontSize: 30 }}>{view === 'executive' ? 'ხელმძღვანელობა' : 'განყოფილება'}{deptName ? ` — ${deptName}` : ''}</h1>
        <span className="mono" style={{ fontSize: 26 }}>{now.toLocaleTimeString('ka-GE', { hour: '2-digit', minute: '2-digit' })}</span>
        <span className="small muted">KPI: {from} — {today} · მონაცემები: {fmtTime(meta.data?.data_as_of ?? null)} · განახლება ყოველ {meta.data?.settings.tv_refresh_min ?? 5} წთ</span>
        {!document.fullscreenElement && <button className="btn sm" type="button" onClick={full}>სრული ეკრანი</button>}
      </header>
      <ErrorBox error={meta.error ?? h.error} />
      {!h.data ? <Loading /> : <HeadlineTiles h={h.data} big />}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 3fr) minmax(0, 2fr)', gap: 16, alignItems: 'start' }}>
        {meta.data && <LivePanel dept={dept} refetchMs={every} big showDepartments={view === 'executive' && !dept} />}
        {meta.data && <AttentionPanel dept={dept} refetchMs={every} big />}
      </div>
    </div>
  );
}
