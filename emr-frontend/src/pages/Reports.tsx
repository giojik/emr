import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, can, type Role } from '../api/client';
import type { Department } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { ErrorBox, Field, Loading, Modal } from '../components/ui';
import { money, SECTION_KA, todayISO } from '../lib/format';

const METHOD_KA: Record<string, string> = { cash: 'ნაღდი', card_terminal: 'ბარათი', card: 'ბარათი', bank_transfer: 'გადარიცხვა' };
const CAT_KA: Record<string, string> = { ...SECTION_KA, referral: 'მიმართვა', consultation: 'კონსულტაცია' };
const STATUS_KA: Record<string, string> = {
  scheduled: 'დაგეგმილი', confirmed: 'დადასტურებული', arrived: 'მოვიდა', checked_in: 'მოვიდა', completed: 'დასრულებული', cancelled: 'გაუქმებული', no_show: 'არ გამოცხადდა',
  planned: 'დაგეგმილი', active: 'აქტიური', discharged: 'დასრულებული',
};
const KIND_KA: Record<string, string> = { consultation: 'კონსულტაცია', lab: 'ლაბორატორია' };
const ka = (m: Record<string, string>, k: string) => m[k] ?? k;

interface Finance {
  totals: Record<string, string | number>;
  by_method: { method: string; amount: string; count: number }[]; by_day: { day: string; amount: string }[];
  by_category: { category: string; amount: string; count: number }[]; by_doctor: { doctor: string; amount: string; visits: number }[];
  outstanding: { id: string; invoice_number: string; created_at: string; patient_share: string; paid: string; first_name: string; last_name: string; personal_number: string }[];
  expenses_by_category: { category: string; amount: string; count: number }[];
}
interface Activity {
  visits: { visit_kind: string; status: string; count: number }[]; by_department: { name: string; count: number }[]; by_doctor: { doctor: string; count: number }[];
  new_patients: number; appointments: { status: string; count: number }[]; diagnostics: { section: string; status: string; count: number }[];
}
interface Expense {
  id: string; expense_date: string; category: string; description: string | null; amount: string; payment_method: string; supplier: string | null;
  doc_number: string | null; department_id: string | null; department_name: string | null; is_void: boolean; void_reason: string | null; created_by_name: string | null;
}

const monthStart = () => todayISO().slice(0, 8) + '01';

/** CSV (Excel-თან თავსებადი: BOM + ;) */
function downloadCsv(name: string, head: string[], rows: (string | number | null)[][]) {
  const esc = (v: string | number | null) => { const s = v == null ? '' : String(v); return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const blob = new Blob(['﻿' + [head, ...rows].map((r) => r.map(esc).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const TABS: { key: string; label: string; roles: Role[] }[] = [
  { key: 'finance', label: 'ფინანსები', roles: ['admin', 'accountant', 'viewer'] },
  { key: 'expenses', label: 'ხარჯები', roles: ['admin', 'accountant', 'viewer'] },
  { key: 'activity', label: 'აქტივობა / ნაკადები', roles: ['admin', 'accountant', 'viewer', 'manager'] },
];

export default function Reports() {
  const { user } = useAuth();
  const tabs = TABS.filter((t) => can(user, ...t.roles));
  const [tab, setTab] = useState(tabs[0]?.key ?? 'activity');
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(todayISO());
  const readOnly = !can(user, 'admin', 'accountant');
  return (
    <>
      <header className="topbar" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8, paddingBottom: 0 }}>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <h1 className="grow">რეპორტები {readOnly && <span className="chip" style={{ marginLeft: 8 }}>მხოლოდ ნახვა</span>}</h1>
          <label className="row small">დან <input type="date" className="input" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="row small">მდე <input type="date" className="input" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>
          <button className="btn sm" type="button" onClick={() => { setFrom(todayISO()); setTo(todayISO()); }}>დღეს</button>
          <button className="btn sm" type="button" onClick={() => { setFrom(monthStart()); setTo(todayISO()); }}>ეს თვე</button>
        </div>
        <nav className="row" style={{ gap: 2 }} aria-label="რეპორტები">
          {tabs.map((t) => <button key={t.key} type="button" className={`admin-tab${tab === t.key ? ' active' : ''}`} style={{ background: 'none', border: 0, cursor: 'pointer' }} onClick={() => setTab(t.key)}>{t.label}</button>)}
        </nav>
      </header>
      <div className="content">
        {tab === 'finance' && <FinanceTab from={from} to={to} />}
        {tab === 'expenses' && <ExpensesTab from={from} to={to} canEdit={!readOnly} />}
        {tab === 'activity' && <ActivityTab from={from} to={to} scoped={!can(user, 'admin', 'accountant', 'viewer')} />}
      </div>
    </>
  );
}

const Kpi = ({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'danger' }) => (
  <div className="card" style={{ padding: '10px 14px', minWidth: 150, flex: '1 1 150px' }}>
    <div className="small muted">{label}</div>
    <div style={{ fontSize: 20, fontWeight: 600, color: tone === 'danger' ? 'var(--danger)' : tone === 'ok' ? 'var(--ok, inherit)' : undefined }}>{value}</div>
  </div>
);

function Table({ title, head, rows, csv }: { title: string; head: string[]; rows: (string | number)[][]; csv?: string }) {
  return (
    <div className="card" style={{ flex: '1 1 380px', minWidth: 0 }}>
      <div className="row" style={{ padding: '10px 12px 4px' }}><strong className="grow">{title}</strong>{csv && rows.length > 0 && <button className="btn sm" type="button" onClick={() => downloadCsv(csv, head, rows)}>CSV</button>}</div>
      {rows.length === 0 ? <div className="small muted" style={{ padding: '4px 12px 12px' }}>მონაცემი არ არის</div> : (
        <table className="table"><thead><tr>{head.map((h, i) => <th key={h} className={i ? 'num' : undefined}>{h}</th>)}</tr></thead>
          <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={j ? 'num' : undefined}>{c}</td>)}</tr>)}</tbody></table>
      )}
    </div>
  );
}

function FinanceTab({ from, to }: { from: string; to: string }) {
  const q = useQuery({ queryKey: ['rep-finance', from, to], queryFn: () => api<Finance>('/reports/finance', { query: { from, to } }) });
  if (q.isLoading) return <Loading />;
  if (!q.data) return <ErrorBox error={q.error} />;
  const d = q.data; const t = d.totals;
  return (
    <div className="stack">
      <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
        <Kpi label="შემოსავალი (გადახდები)" value={money(t.payments)} />
        <Kpi label="გაწეული მომსახურება" value={money(t.services)} />
        <Kpi label="ხარჯები" value={money(t.expenses)} />
        <Kpi label="სალდო (შემოსავალი − ხარჯი)" value={money(t.net)} tone={Number(t.net) < 0 ? 'danger' : 'ok'} />
        <Kpi label="დავალიანება" value={money(t.outstanding)} tone={Number(t.outstanding) > 0 ? 'danger' : undefined} />
      </div>
      <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
        <Kpi label="პაციენტის წილი" value={money(t.patient_share)} />
        <Kpi label="დაზღვევის წილი" value={money(t.insurance_share)} />
        <Kpi label="სახელმწიფოს წილი" value={money(t.state_share)} />
        <Kpi label={`ფასდაკლებები (${t.discount_lines} ხაზი)`} value={money(t.discounts)} />
      </div>
      <div className="row" style={{ flexWrap: 'wrap', gap: 10, alignItems: 'flex-start' }}>
        <Table title="გადახდები მეთოდით" head={['მეთოდი', 'რაოდენობა', 'თანხა']} csv={`payments-by-method_${from}_${to}.csv`}
          rows={d.by_method.map((r) => [ka(METHOD_KA, r.method), r.count, money(r.amount)])} />
        <Table title="მომსახურება კატეგორიით" head={['კატეგორია', 'რაოდენობა', 'თანხა']} csv={`services-by-category_${from}_${to}.csv`}
          rows={d.by_category.map((r) => [ka(CAT_KA, r.category), r.count, money(r.amount)])} />
        <Table title="ხარჯები კატეგორიით" head={['კატეგორია', 'ჩანაწერი', 'თანხა']} csv={`expenses-by-category_${from}_${to}.csv`}
          rows={d.expenses_by_category.map((r) => [r.category, r.count, money(r.amount)])} />
      </div>
      <div className="row" style={{ flexWrap: 'wrap', gap: 10, alignItems: 'flex-start' }}>
        <Table title="შემოსავალი დღეების მიხედვით" head={['დღე', 'თანხა']} csv={`payments-by-day_${from}_${to}.csv`} rows={d.by_day.map((r) => [r.day, money(r.amount)])} />
        <Table title="მომსახურება ექიმების მიხედვით" head={['ექიმი', 'ვიზიტი', 'თანხა']} csv={`services-by-doctor_${from}_${to}.csv`}
          rows={d.by_doctor.map((r) => [r.doctor, r.visits, money(r.amount)])} />
      </div>
      <div className="row"><Table title={`დავალიანებები (${d.outstanding.length})`} head={['პაციენტი', 'პ/ნ', 'ინვოისი', 'თარიღი', 'პაციენტის წილი', 'გადახდილი', 'ნაშთი']} csv={`outstanding_${from}_${to}.csv`}
        rows={d.outstanding.map((r) => [`${r.last_name} ${r.first_name}`, r.personal_number, r.invoice_number, r.created_at.slice(0, 10), money(r.patient_share), money(r.paid),
          money(Number(r.patient_share) - Number(r.paid))])} /></div>
    </div>
  );
}

function ExpensesTab({ from, to, canEdit }: { from: string; to: string; canEdit: boolean }) {
  const [showVoid, setShowVoid] = useState(false);
  const [edit, setEdit] = useState<Expense | 'new' | null>(null);
  const q = useQuery({ queryKey: ['expenses', from, to, showVoid], queryFn: () => api<Expense[]>('/expenses', { query: { from, to, include_void: showVoid } }) });
  const total = (q.data ?? []).filter((x) => !x.is_void).reduce((s, x) => s + Number(x.amount), 0);
  const head = ['თარიღი', 'კატეგორია', 'აღწერა', 'მომწოდებელი', 'დოკ. №', 'განყოფილება', 'მეთოდი', 'თანხა'];
  const rows = (q.data ?? []).filter((x) => !x.is_void).map((x) => [x.expense_date, x.category, x.description ?? '', x.supplier ?? '', x.doc_number ?? '', x.department_name ?? '', ka(METHOD_KA, x.payment_method), x.amount]);
  return (
    <div className="stack">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <span className="grow">სულ: <strong>{money(total)}</strong> <span className="small muted">({rows.length} ჩანაწერი)</span></span>
        <label className="row small"><input type="checkbox" checked={showVoid} onChange={(e) => setShowVoid(e.target.checked)} /> გაუქმებულებიც</label>
        <button className="btn" type="button" disabled={!rows.length} onClick={() => downloadCsv(`expenses_${from}_${to}.csv`, head, rows)}>CSV</button>
        {canEdit && <button className="btn primary" type="button" onClick={() => setEdit('new')}>+ ხარჯი</button>}
      </div>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : (
        <div className="card">
          <table className="table">
            <thead><tr><th>თარიღი</th><th>კატეგორია</th><th>აღწერა / მომწოდებელი</th><th>განყოფილება</th><th>მეთოდი</th><th className="num">თანხა</th><th>შეიყვანა</th></tr></thead>
            <tbody>{q.data?.length === 0 && <tr><td colSpan={7} className="muted small">ჩანაწერი არ არის</td></tr>}
              {q.data?.map((x) => (
                <tr key={x.id} className={canEdit && !x.is_void ? 'clickable' : undefined} onClick={canEdit && !x.is_void ? () => setEdit(x) : undefined}
                  style={x.is_void ? { opacity: 0.5, textDecoration: 'line-through' } : undefined} title={x.is_void ? `გაუქმებულია: ${x.void_reason}` : undefined}>
                  <td className="mono">{x.expense_date}</td><td>{x.category}</td>
                  <td>{x.description}{x.supplier && <div className="small muted">{x.supplier}{x.doc_number ? ` · № ${x.doc_number}` : ''}</div>}</td>
                  <td>{x.department_name ?? '—'}</td><td>{ka(METHOD_KA, x.payment_method)}</td><td className="num">{money(x.amount)}</td>
                  <td className="small muted">{x.created_by_name}</td>
                </tr>))}</tbody>
          </table>
        </div>
      )}
      {edit && <ExpenseDialog x={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function ExpenseDialog({ x, onClose }: { x: Expense | null; onClose: () => void }) {
  const qc = useQueryClient();
  const cats = useQuery({ queryKey: ['expense-cats'], queryFn: () => api<string[]>('/expenses/categories') });
  const depts = useQuery({ queryKey: ['departments'], queryFn: () => api<Department[]>('/departments') });
  const [f, setF] = useState({
    expense_date: x?.expense_date ?? todayISO(), category: x?.category ?? '', description: x?.description ?? '', amount: x?.amount ?? '',
    payment_method: x?.payment_method ?? 'bank_transfer', supplier: x?.supplier ?? '', doc_number: x?.doc_number ?? '', department_id: x?.department_id ?? '',
  });
  const [voidReason, setVoidReason] = useState<string | null>(null);
  const done = () => { void qc.invalidateQueries({ queryKey: ['expenses'] }); void qc.invalidateQueries({ queryKey: ['rep-finance'] }); void qc.invalidateQueries({ queryKey: ['expense-cats'] }); onClose(); };
  const body = { ...f, amount: Number(f.amount), description: f.description || null, supplier: f.supplier || null, doc_number: f.doc_number || null, department_id: f.department_id || null };
  const m = useMutation({ mutationFn: () => x ? api(`/expenses/${x.id}`, { method: 'PATCH', body }) : api('/expenses', { body }), onSuccess: done });
  const v = useMutation({ mutationFn: () => api(`/expenses/${x!.id}`, { method: 'PATCH', body: { void: true, void_reason: voidReason } }), onSuccess: done });
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(f.expense_date) && f.category.trim().length >= 2 && Number(f.amount) > 0;
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title={x ? 'ხარჯის რედაქტირება' : 'ახალი ხარჯი'} onClose={onClose} width={640}
      footer={<>{x && voidReason === null && <button className="btn" type="button" style={{ color: 'var(--danger)', marginRight: 'auto' }} onClick={() => setVoidReason('')}>გაუქმება (void)</button>}
        <button className="btn" type="button" onClick={onClose}>დახურვა</button>
        {voidReason !== null ? <button className="btn danger" type="button" disabled={voidReason.trim().length < 5 || v.isPending} onClick={() => v.mutate()}>ჩანაწერის გაუქმება</button>
          : <button className="btn primary" type="button" disabled={!valid || m.isPending} onClick={() => m.mutate()}>შენახვა</button>}</>}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="თარიღი" htmlFor="xd" required><input id="xd" type="date" className="input" value={f.expense_date} onChange={set('expense_date')} /></Field>
        <Field label="თანხა (₾)" htmlFor="xa" required><input id="xa" className="input" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value.replace(',', '.').replace(/[^0-9.]/g, '') })} /></Field>
        <Field label="კატეგორია" htmlFor="xc" required><input id="xc" className="input" list="xcats" value={f.category} onChange={set('category')} />
          <datalist id="xcats">{cats.data?.map((c) => <option key={c} value={c} />)}</datalist></Field>
        <Field label="გადახდის მეთოდი" htmlFor="xm"><select id="xm" className="input" value={f.payment_method} onChange={set('payment_method')}>
          <option value="bank_transfer">გადარიცხვა</option><option value="cash">ნაღდი</option><option value="card">ბარათი</option></select></Field>
        <Field label="მომწოდებელი" htmlFor="xs"><input id="xs" className="input" value={f.supplier} onChange={set('supplier')} /></Field>
        <Field label="დოკუმენტის №" htmlFor="xn" hint="ზედნადები / ინვოისი"><input id="xn" className="input" value={f.doc_number} onChange={set('doc_number')} /></Field>
        <Field label="განყოფილება" htmlFor="xdp"><select id="xdp" className="input" value={f.department_id} onChange={set('department_id')}>
          <option value="">— საერთო —</option>{depts.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
        <Field label="აღწერა" htmlFor="xds"><input id="xds" className="input" value={f.description} onChange={set('description')} /></Field>
      </div>
      {voidReason !== null && <Field label="გაუქმების მიზეზი" htmlFor="xv" required hint="მინ. 5 სიმბოლო; ჩანაწერი არ იშლება — აღინიშნება გაუქმებულად">
        <input id="xv" className="input" autoFocus value={voidReason} onChange={(e) => setVoidReason(e.target.value)} /></Field>}
      <ErrorBox error={m.error ?? v.error} />
    </Modal>
  );
}

function ActivityTab({ from, to, scoped }: { from: string; to: string; scoped: boolean }) {
  const [dep, setDep] = useState('');
  const depts = useQuery({ queryKey: ['departments'], queryFn: () => api<Department[]>('/departments'), enabled: !scoped });
  const q = useQuery({ queryKey: ['rep-activity', from, to, dep], queryFn: () => api<Activity>('/reports/activity', { query: { from, to, ...(dep ? { department_id: dep } : {}) } }) });
  const d = q.data;
  const sum = (a: { count: number }[]) => a.reduce((s, r) => s + r.count, 0);
  const kinds = d ? [...new Set(d.visits.map((v) => v.visit_kind))] : [];
  const statuses = d ? [...new Set(d.visits.map((v) => v.status))] : [];
  const sections = d ? [...new Set(d.diagnostics.map((v) => v.section))] : [];
  const apptBy = (s: string[]) => d ? sum(d.appointments.filter((a) => s.includes(a.status))) : 0;
  return (
    <div className="stack">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        {scoped ? <span className="small muted grow">ნაჩვენებია მხოლოდ თქვენი განყოფილება</span> : (
          <label className="row small grow">განყოფილება <select className="input" style={{ maxWidth: 280 }} value={dep} onChange={(e) => setDep(e.target.value)}>
            <option value="">ყველა</option>{depts.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>)}
      </div>
      <ErrorBox error={q.error} />
      {q.isLoading || !d ? (q.isLoading ? <Loading /> : null) : (<>
        <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
          <Kpi label="ვიზიტები (გაუქმებულის გარეშე)" value={String(sum(d.visits.filter((v) => v.status !== 'cancelled')))} />
          <Kpi label="ახალი პაციენტები" value={String(d.new_patients)} />
          <Kpi label="ჩაწერები" value={String(sum(d.appointments))} />
          <Kpi label="გამოცხადდა" value={String(apptBy(['checked_in', 'completed']))} tone="ok" />
          <Kpi label="არ გამოცხადდა" value={String(apptBy(['no_show']))} tone={apptBy(['no_show']) ? 'danger' : undefined} />
          <Kpi label="გაუქმებული ჩაწერა" value={String(apptBy(['cancelled']))} />
        </div>
        <div className="row" style={{ flexWrap: 'wrap', gap: 10, alignItems: 'flex-start' }}>
          <Table title="ვიზიტები ტიპის/სტატუსის მიხედვით" head={['ტიპი', ...statuses.map((s) => ka(STATUS_KA, s)), 'სულ']} csv={`visits_${from}_${to}.csv`}
            rows={kinds.map((k) => { const c = statuses.map((s) => d.visits.find((v) => v.visit_kind === k && v.status === s)?.count ?? 0); return [ka(KIND_KA, k), ...c, c.reduce((a, b) => a + b, 0)]; })} />
          <Table title="ჩაწერები სტატუსით" head={['სტატუსი', 'რაოდენობა']} rows={d.appointments.map((a) => [ka(STATUS_KA, a.status), a.count])} />
        </div>
        <div className="row" style={{ flexWrap: 'wrap', gap: 10, alignItems: 'flex-start' }}>
          {!scoped && <Table title="განყოფილებების მიხედვით" head={['განყოფილება', 'ვიზიტი']} csv={`by-department_${from}_${to}.csv`} rows={d.by_department.map((r) => [r.name, r.count])} />}
          <Table title="ექიმების მიხედვით" head={['ექიმი', 'ვიზიტი']} csv={`by-doctor_${from}_${to}.csv`} rows={d.by_doctor.map((r) => [r.doctor, r.count])} />
          {!scoped && <Table title="დიაგნოსტიკა" head={['განყოფილება', 'სულ', 'დასრულებული']}
            rows={sections.map((s) => { const r = d.diagnostics.filter((x) => x.section === s); return [ka(SECTION_KA, s), sum(r), sum(r.filter((x) => ['performed', 'resulted', 'validated'].includes(x.status)))]; })} />}
        </div>
      </>)}
    </div>
  );
}

