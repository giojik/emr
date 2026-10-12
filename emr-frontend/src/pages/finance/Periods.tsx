import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, can } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Loading, Modal, useToast } from '../../components/ui';
import { tsDate } from '../../lib/format';
import type { TabProps } from './Finance';
import { type Checklist, FIN_EDIT, fmt, type Period, type Periods as PeriodsData } from './types';

const MONTHS = ['იანვარი', 'თებერვალი', 'მარტი', 'აპრილი', 'მაისი', 'ივნისი', 'ივლისი', 'აგვისტო', 'სექტემბერი', 'ოქტომბერი', 'ნოემბერი', 'დეკემბერი'];
const monthKa = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;

/** ფინანსური პერიოდები: თვის დახურვა (შემოწმების სია, სნეპშოტი) / გახსნა (მიზეზით) */
export default function Periods(_: TabProps) {
  const { user } = useAuth();
  const q = useQuery({ queryKey: ['fin-periods'], queryFn: () => api<PeriodsData>('/finance/periods') });
  const [sel, setSel] = useState<Period | null>(null);
  const d = q.data;
  return (
    <div className="content">
      <ErrorBox error={q.error} />
      {d && d.period_lock !== 'on' && <div className="alert warn">პერიოდის დაცვა (period_lock) გამორთულია — თვის დახურვა ინახავს სნეპშოტს, მაგრამ დახურულ თვეში ცვლილებას არ ბლოკავს. ჩართვა: <Link to="/admin/modules">ადმინისტრირება → მოდულები → ფინანსები</Link>.</div>}
      {q.isLoading || !d ? <Loading /> : <>
        <section className="card" style={{ overflowX: 'auto', flexShrink: 0 }}>
          <table className="table">
            <thead><tr><th>თვე</th><th>სტატუსი</th><th className="num">შემოსავალი</th><th className="num">ხარჯი</th><th className="num">მარაგი (ხარჯი)</th><th className="num">მარაგის ნაშთი</th><th>დახურა</th><th /></tr></thead>
            <tbody>{d.periods.map((p) => (
              <tr key={p.month}>
                <td><strong>{monthKa(p.month)}</strong></td>
                <td>{p.status === 'closed' ? <span className={`chip ${p.locked ? 'ok' : 'warn'}`}>{p.locked ? 'დახურულია' : 'დახურულია (დაცვა გამორთ.)'}</span>
                  : p.reopened_at ? <span className="chip warn" title={p.reopen_reason ?? ''}>გაიხსნა</span> : <span className="chip">ღია</span>}</td>
                <td className="num mono">{p.snapshot?.revenue ? fmt(p.snapshot.revenue.total) : '—'}</td><td className="num mono">{p.snapshot?.expenses !== undefined ? fmt(p.snapshot.expenses) : '—'}</td>
                <td className="num mono">{p.snapshot?.stock_cost !== undefined ? fmt(p.snapshot.stock_cost) : '—'}</td><td className="num mono">{p.snapshot?.stock_value_end !== undefined ? fmt(p.snapshot.stock_value_end) : '—'}</td>
                <td className="small">{p.status === 'closed' ? `${p.closed_by_name} · ${tsDate(p.closed_at!)}` : p.reopened_at ? `გახსნა: ${p.reopened_by_name} · ${tsDate(p.reopened_at)}` : '—'}</td>
                <td style={{ textAlign: 'right' }}>{can(user, ...FIN_EDIT) && (p.status === 'closed' || p.closable) && <button className={`btn sm${p.status === 'closed' ? '' : ' primary'}`} type="button" onClick={() => setSel(p)}>
                  {p.status === 'closed' ? 'გახსნა' : 'დახურვა'}</button>}{!p.closable && p.status !== 'closed' && <span className="small muted">მიმდინარე</span>}</td>
              </tr>))}</tbody>
          </table>
        </section>
        {d.log.length > 0 && (
          <section className="card card-pad stack" style={{ gap: 4 }}>
            <strong>ისტორია</strong>
            {d.log.map((l) => <span key={l.id} className="small"><span className="mono">{tsDate(l.created_at)}</span> · {monthKa(l.month)} — <strong>{l.action === 'close' ? 'დახურვა' : 'გახსნა'}</strong> · {l.user_name}{l.reason ? `: ${l.reason}` : ''}</span>)}
          </section>)}
        <span className="hint">დახურულ თვეში (თარიღით) ვერ დაემატება / შეიცვლება: ინვოისის ხაზი, პაციენტის გადახდა, ფინალიზაცია / გახსნა, ამბულატორიის გადამხდელის წილი, მომწოდებლის ინვოისი / გადახდა, ხარჯი, მარაგის მოძრაობა, ქლეიმის ანაზღაურება. ავტომატური საწოლდღე / ვენტილაცია / ოპერაციის ხაზები — გარდა.</span>
      </>}
      {sel && <PeriodDialog p={sel} onClose={() => setSel(null)} />}
    </div>
  );
}

function PeriodDialog({ p, onClose }: { p: Period; onClose: () => void }) {
  const qc = useQueryClient(); const toast = useToast();
  const closing = p.status !== 'closed';
  const chk = useQuery({ queryKey: ['fin-check', p.month], queryFn: () => api<Checklist>(`/finance/periods/${p.month}/checklist`), enabled: closing });
  const [text, setText] = useState('');
  const m = useMutation({
    mutationFn: () => api(`/finance/periods/${p.month}/${closing ? 'close' : 'reopen'}`, { body: closing ? { note: text.trim() || undefined } : { reason: text.trim() } }),
    onSuccess: () => { toast.show('შესრულდა'); ['fin-periods', 'fin-summary'].forEach((k) => void qc.invalidateQueries({ queryKey: [k] })); onClose(); },
  });
  return (
    <Modal title={`${closing ? 'დახურვა' : 'გახსნა'}: ${monthKa(p.month)}`} onClose={onClose} width={720}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button>
        <button className={`btn ${closing ? 'primary' : 'danger'}`} type="button" disabled={m.isPending || (!closing && text.trim().length < 3)} onClick={() => m.mutate()}>{closing ? 'თვის დახურვა' : 'პერიოდის გახსნა'}</button></>}>
      {toast.node}
      <div className="stack">
        {closing ? <>
          <strong>შემოწმება დახურვამდე</strong>
          {chk.isLoading ? <Loading /> : chk.data && (
            <table className="table"><tbody>{chk.data.items.map((x) => (
              <tr key={x.code}><td>{x.n > 0 ? <span className="chip warn">!</span> : <span className="chip ok">✓</span>}</td><td>{x.label}</td><td className="num">{x.n || '—'}</td><td className="num mono">{x.amount !== null ? fmt(x.amount) : ''}</td></tr>))}</tbody></table>)}
          {chk.data && chk.data.warnings > 0 && <span className="hint">გაფრთხილებები დახურვას არ ბლოკავს — სნეპშოტში ფიქსირდება.</span>}
          <input className="input" placeholder="შენიშვნა (არასავალდებულო)" value={text} onChange={(e) => setText(e.target.value)} />
        </> : <>
          <div className="alert warn">გახსნის შემდეგ თვის მონაცემები ისევ შეიცვლება. ბუღალტერია მიიღებს შეტყობინებას; ჩანაწერი აუდიტში.</div>
          <input className="input" placeholder="გახსნის მიზეზი (სავალდებულო)" value={text} onChange={(e) => setText(e.target.value)} />
        </>}
        <ErrorBox error={chk.error ?? m.error} />
      </div>
    </Modal>
  );
}
