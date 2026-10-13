import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../../api/client';
import type { Department, Tariff } from '../../../api/types';
import { ErrorBox, Field, Loading, useDebounced } from '../../../components/ui';
import { todayISO } from '../../../lib/format';
import type { Payer } from '../BillingSetup';
import { dg, n2 } from './types';

interface QuoteRes {
  entity: { id: string; code: string; name: string }; date: string;
  chain: { list_id: string; list_name: string; scope: string; scope_ka: string; active: boolean; item_id: string | null; price: string | null; markup_pct?: string; valid_from: string | null; via: 'item' | 'category' | null }[];
  chosen: { list_name: string; scope_ka: string; price: string | null } | null;
  coverage: { version_no: number; mode: string; coverage_pct: string; deductible: string; copay_amount: string; covered: boolean; pct: number;
    clause: { seq: number; label: string | null; effect: string; coverage_pct: string | null; line_limit: string | null } | null } | null;
}

/** ფასის შემოწმება: რომელი ნუსხიდან მოვა ფასი და როგორ დაფარავს გადამხდელი (ჩანაწერის გარეშე) */
export default function Quote() {
  const [search, setSearch] = useState(''); const dq = useDebounced(search.trim(), 250);
  const [tariff, setTariff] = useState(''); const [date, setDate] = useState(todayISO()); const [dept, setDept] = useState(''); const [payer, setPayer] = useState('');
  const [age, setAge] = useState(''); const [sex, setSex] = useState(''); const [dx, setDx] = useState('');
  const ts = useQuery({ queryKey: ['tariffs', dq, false], queryFn: () => api<Tariff[]>('/tariffs', { query: { search: dq } }) });
  const deps = useQuery({ queryKey: ['departments'], queryFn: () => api<Department[]>('/departments') });
  const pays = useQuery({ queryKey: ['billing-payers'], queryFn: () => api<Payer[]>('/billing/payers') });
  const q = useQuery({ queryKey: ['tariff-quote', tariff, date, dept, payer, age, sex, dx], enabled: !!tariff,
    queryFn: () => api<QuoteRes>('/tariff-quote', { query: { tariff_id: tariff, date, department_id: dept, payer_id: payer, age, sex, dx } }) });
  return (
    <div className="content" style={{ display: 'grid', gridTemplateColumns: '360px minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
      <section className="card card-pad stack" style={{ gap: 10 }}>
        <Field label="მომსახურება" htmlFor="qs"><input id="qs" className="input" placeholder="კოდი ან დასახელება" value={search} onChange={(e) => setSearch(e.target.value)} /></Field>
        <select className="select" aria-label="ტარიფი" size={6} value={tariff} onChange={(e) => setTariff(e.target.value)} style={{ height: 'auto' }}>
          {ts.data?.slice(0, 100).map((t) => <option key={t.id} value={t.id}>{t.code} — {t.title}</option>)}</select>
        <Field label="თარიღი" htmlFor="qd"><input id="qd" className="input mono" type="date" value={date} onChange={(e) => setDate(e.target.value || todayISO())} /></Field>
        <Field label="განყოფილება" htmlFor="qdp"><select id="qdp" className="select" value={dept} onChange={(e) => setDept(e.target.value)}><option value="">—</option>{deps.data?.filter((d) => d.is_active).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
        <Field label="გადამხდელი" htmlFor="qp"><select id="qp" className="select" value={payer} onChange={(e) => setPayer(e.target.value)}><option value="">— პაციენტი —</option>{pays.data?.filter((p) => p.is_active).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
        {payer && <div className="row" style={{ gap: 8 }}>
          <input className="input mono" style={{ width: 80 }} aria-label="ასაკი" placeholder="ასაკი" value={age} onChange={(e) => setAge(e.target.value.replace(/\D/g, ''))} />
          <select className="select" style={{ width: 110 }} aria-label="სქესი" value={sex} onChange={(e) => setSex(e.target.value)}><option value="">სქესი</option><option value="male">მამრ.</option><option value="female">მდედრ.</option></select>
          <input className="input mono grow" aria-label="დიაგნოზი" placeholder="ICD-10, მაგ. J18.9" value={dx} onChange={(e) => setDx(e.target.value)} /></div>}
      </section>
      <section className="stack" style={{ gap: 12 }}>
        {!tariff ? <div className="empty">აირჩიეთ მომსახურება.</div> : q.isLoading ? <Loading /> : q.data && <>
          <div className="card card-pad row" style={{ gap: 16, flexWrap: 'wrap' }}>
            <div className="grow"><div className="small muted">{q.data.entity.code} · {dg(q.data.date)}</div><h2 style={{ margin: 0 }}>{q.data.entity.name}</h2></div>
            <div style={{ textAlign: 'right' }}><div className="small muted">ფასი</div><div style={{ fontSize: 28, fontWeight: 700 }} className="mono">{q.data.chosen ? n2(q.data.chosen.price) : '—'}</div>
              <div className="small muted">{q.data.chosen ? `${q.data.chosen.scope_ka}: ${q.data.chosen.list_name}` : 'ნუსხაში ვერ მოიძებნა'}</div></div>
          </div>
          <div className="card">
            <table className="table">
              <thead><tr><th>რიგი</th><th>ნუსხა</th><th className="num">ფასი</th><th>მოქმედებს</th><th /></tr></thead>
              <tbody>{q.data.chain.map((c, i) => (
                <tr key={c.list_id} style={{ opacity: c.item_id ? 1 : 0.5 }}><td>{i + 1}. {c.scope_ka}</td><td>{c.list_name}{!c.active && <span className="chip" style={{ marginLeft: 6 }}>გათიშული</span>}</td>
                  <td className="num mono">{c.item_id ? (c.via === 'category' ? `${Number(c.markup_pct)}%` : n2(c.price)) : '—'}</td><td className="small">{c.item_id ? (c.valid_from ? `${dg(c.valid_from)}-დან` : 'თავიდან') : 'არ არის'}</td>
                  <td>{q.data.chosen && c.list_name === q.data.chosen.list_name && c.item_id ? <span className="chip ok">გამოიყენება</span> : null}</td></tr>))}</tbody>
            </table>
          </div>
          {q.data.coverage && <div className={`alert ${q.data.coverage.covered ? 'ok' : 'warn'}`}>
            <strong>{q.data.coverage.covered ? `ფარავს ${q.data.coverage.pct}%` : 'არ ფარავს'}</strong> — ვერსია {q.data.coverage.version_no}
            {q.data.coverage.clause ? `, პუნქტი ${q.data.coverage.clause.seq}${q.data.coverage.clause.label ? ` („${q.data.coverage.clause.label}“)` : ''}${q.data.coverage.clause.line_limit ? `, ხაზზე ≤ ${n2(q.data.coverage.clause.line_limit)}` : ''}` : ', ნაგულისხმევი პირობა'}
            {Number(q.data.coverage.deductible) > 0 && ` · ფრანშიზა ${n2(q.data.coverage.deductible)}`}{Number(q.data.coverage.copay_amount) > 0 && ` · თანაგადახდა ${n2(q.data.coverage.copay_amount)} (შემთხვევაზე)`}
          </div>}
        </>}
        <ErrorBox error={q.error} />
      </section>
    </div>
  );
}
