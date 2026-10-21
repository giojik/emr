import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, can } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Loading } from '../../components/ui';
import { downloadFile } from '../reporting/types';
import { IPC_FULL } from './types';

type Kpi = Record<string, number | null>;
interface Tot { patient_days: number; cl: number; uc: number; vent: number; hai: number; clabsi: number; cauti: number; vap: number; ssi_ops: number; ssi: number;
  mdro_hosp: number; mdro_all: number; ddd: number; ddd_access: number; dot: number; hh_opps: number; hh_done: number; handrub_l: number }
interface Report {
  from: string; to: string; scope_label: string; kpi_defs: { code: string; name: string; unit: string }[]; total: Tot; kpi: Kpi;
  departments: (Tot & { department_id: string; department: string; kpi: Kpi })[]; months: (Tot & { ym: string; kpi: Kpi })[];
  hai: { hai_type: string; name: string; n: number; device: number; died: number }[];
  mdro: { mdro_code: string; name: string; hospital: number; community: number; unknown: number }[];
  audits: { hand_hygiene: { target: number; opps: number; done: number; pct: number | null }; checklists: { template_id: string; template: string; audits: number; pct: number | null; target: number | null }[] };
}

const todayTb = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tbilisi' }).format(new Date());
const prevMonth = () => { const t = todayTb(); const d = new Date(Date.UTC(Number(t.slice(0, 4)), Number(t.slice(5, 7)) - 2, 1));
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)); return { from: d.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) }; };
const fv = (v: number | null | undefined, u = '') => (v === null || v === undefined ? '—' : `${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}${u}`);
const SHORT: Record<string, string> = { ipc_hai_rate: 'HAI', ipc_clabsi_rate: 'CLABSI', ipc_cauti_rate: 'CAUTI', ipc_vap_rate: 'VAP', ipc_ssi_pct: 'SSI %', ipc_mdro_rate: 'MDRO',
  ipc_ddd_100: 'DDD/100', ipc_access_pct: 'Access %', ipc_hh_pct: 'ხ. ჰიგ. %', ipc_handrub_l: 'ლ/1000' };

/** ანგარიშები (0072): მაჩვენებლები (იგივე ფორმულა, რაც მენეჯერულ დაფაზე), განყოფილებები, თვეები, HAI / MDRO, ხელის ჰიგიენა, ჩეკლისტები; xlsx / PDF; რეესტრი */
export default function ReportsTab() {
  const { user } = useAuth(); const full = can(user, ...IPC_FULL);
  const [p, setP] = useState(prevMonth()); const [dept, setDept] = useState('');
  const depts = useQuery({ queryKey: ['departments'], queryFn: () => api<{ id: string; name: string; type: string }[]>('/departments'), staleTime: 5 * 60_000 });
  const q = useQuery({ queryKey: ['ipc-report', p, dept], queryFn: () => api<Report>('/ipc/reports/summary', { query: { ...p, department_id: dept } }), enabled: !!p.from && !!p.to && p.from <= p.to });
  const [dl, setDl] = useState<unknown>(null);
  const get = (path: string, query: Record<string, string>, name: string) => { setDl(null); downloadFile(path, { ...p, department_id: dept, ...query }, name).catch(setDl); };
  const d = q.data;
  return (
    <div className="content">
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <input type="date" className="input" style={{ maxWidth: 160, height: 38 }} aria-label="დან" value={p.from} onChange={(e) => setP({ ...p, from: e.target.value })} />
        <input type="date" className="input" style={{ maxWidth: 160, height: 38 }} aria-label="მდე" value={p.to} onChange={(e) => setP({ ...p, to: e.target.value })} />
        <select className="select" style={{ maxWidth: 240, height: 38 }} aria-label="განყოფილება" value={dept} onChange={(e) => setDept(e.target.value)}>
          <option value="">ყველა განყოფილება</option>{depts.data?.filter((x) => x.type !== 'administrative').map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
        <span className="grow" />
        <button className="btn" type="button" onClick={() => get('/ipc/reports/export', { format: 'xlsx' }, `ipc_report_${p.from}_${p.to}.xlsx`)}>xlsx</button>
        <button className="btn" type="button" onClick={() => get('/ipc/reports/export', { format: 'pdf' }, `ipc_report_${p.from}_${p.to}.pdf`)}>PDF</button>
        {full && <>
          <button className="btn" type="button" title="დეპერსონალიზებული (სახელის / პ/ნ-ის გარეშე)" onClick={() => get('/ipc/reports/registry', { kind: 'hai', format: 'xlsx' }, `ipc_hai_registry_${p.from}_${p.to}.xlsx`)}>HAI რეესტრი</button>
          <button className="btn" type="button" title="დეპერსონალიზებული (სახელის / პ/ნ-ის გარეშე)" onClick={() => get('/ipc/reports/registry', { kind: 'mdro', format: 'xlsx' }, `ipc_mdro_registry_${p.from}_${p.to}.xlsx`)}>MDRO რეესტრი</button>
        </>}
      </div>
      <ErrorBox error={q.error ?? dl} />
      {p.from > p.to && <div className="alert warn">პერიოდის დასაწყისი დასასრულზე გვიანაა.</div>}
      {q.isLoading ? <Loading /> : d && <>
        <div className="small muted">{d.scope_label} · {d.from} — {d.to}. მაჩვენებლები — იგივე ფორმულით, რაც მენეჯერულ დაფაზე (ჯგუფი „ინფექციის კონტროლი“). პაციენტ-დღე / device-days — „მაჩვენებლები“ (გადათვლა).</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10, flexShrink: 0 }}>
          {d.kpi_defs.map((k) => (
            <div key={k.code} className="card card-pad stack" style={{ gap: 2 }}>
              <span className="small muted">{k.name}</span><strong style={{ fontSize: 22 }}>{fv(d.kpi[k.code], k.unit)}</strong>
            </div>))}
        </div>
        <div className="row small muted" style={{ gap: 16, flexWrap: 'wrap' }}>
          <span>პაციენტ-დღე <strong>{d.total.patient_days}</strong></span><span>ცენტრ. ხაზი / კათეტერი / ვენტ. <strong>{d.total.cl} / {d.total.uc} / {d.total.vent}</strong></span>
          <span>HAI <strong>{d.total.hai}</strong></span><span>SSI <strong>{d.total.ssi} / {d.total.ssi_ops}</strong></span>
          <span>MDRO ჰოსპ. / სულ <strong>{d.total.mdro_hosp} / {d.total.mdro_all}</strong></span><span>ხელის ჰიგიენა <strong>{d.total.hh_done} / {d.total.hh_opps}</strong></span>
        </div>
        <Grid title="განყოფილებები" first="განყოფილება" rows={d.departments.map((x) => ({ key: x.department_id, label: x.department, pd: x.patient_days, kpi: x.kpi }))} defs={d.kpi_defs} />
        {d.months.length > 1 && <Grid title="თვეები" first="თვე" rows={d.months.map((x) => ({ key: x.ym, label: x.ym, pd: x.patient_days, kpi: x.kpi }))} defs={d.kpi_defs} />}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: 14, flexShrink: 0 }}>
          <section className="card" style={{ overflowX: 'auto' }}>
            <div className="card-pad" style={{ paddingBottom: 6 }}><strong>HAI ტიპებით</strong> <span className="small muted">— დადასტურებული</span></div>
            <table className="table"><thead><tr><th>ტიპი</th><th className="num">სულ</th><th className="num">მოწყობ.</th><th className="num">გარდაიცვ.</th></tr></thead>
              <tbody>{d.hai.map((x) => <tr key={x.hai_type}><td>{x.name}</td><td className="num">{x.n}</td><td className="num">{x.device}</td><td className="num">{x.died}</td></tr>)}
                {!d.hai.length && <tr><td colSpan={4} className="muted">—</td></tr>}</tbody></table>
          </section>
          <section className="card" style={{ overflowX: 'auto' }}>
            <div className="card-pad" style={{ paddingBottom: 6 }}><strong>MDRO</strong> <span className="small muted">— ახალი ფლაგები, შეძენის ადგილით</span></div>
            <table className="table"><thead><tr><th>MDRO</th><th className="num">ჰოსპ.</th><th className="num">საზ.</th><th className="num">უცნ.</th></tr></thead>
              <tbody>{d.mdro.map((x) => <tr key={x.mdro_code}><td className="small">{x.name}</td><td className="num">{x.hospital}</td><td className="num">{x.community}</td><td className="num">{x.unknown}</td></tr>)}
                {!d.mdro.length && <tr><td colSpan={4} className="muted">—</td></tr>}</tbody></table>
          </section>
          <section className="card" style={{ overflowX: 'auto' }}>
            <div className="card-pad" style={{ paddingBottom: 6 }}><strong>ჩეკლისტები</strong></div>
            <table className="table"><thead><tr><th>ჩეკლისტი</th><th className="num">აუდიტი</th><th className="num">%</th></tr></thead>
              <tbody><tr><td>ხელის ჰიგიენა (WHO 5)</td><td className="num">{d.audits.hand_hygiene.opps} შესაძლ.</td><td className="num">{fv(d.audits.hand_hygiene.pct)}</td></tr>
                {d.audits.checklists.map((t) => <tr key={t.template_id}><td>{t.template}</td><td className="num">{t.audits}</td><td className="num">{fv(t.pct)}</td></tr>)}</tbody></table>
          </section>
        </div>
      </>}
    </div>
  );
}

function Grid({ title, first, rows, defs }: { title: string; first: string; rows: { key: string; label: string; pd: number; kpi: Kpi }[]; defs: Report['kpi_defs'] }) {
  return (
    <section className="card" style={{ overflowX: 'auto', flexShrink: 0 }}>
      <div className="card-pad" style={{ paddingBottom: 6 }}><strong>{title}</strong></div>
      <table className="table" style={{ fontSize: 13 }}>
        <thead><tr><th>{first}</th><th className="num">პაციენტ-დღე</th>{defs.map((k) => <th key={k.code} className="num" title={k.name}>{SHORT[k.code] ?? k.code}</th>)}</tr></thead>
        <tbody>{rows.map((r) => <tr key={r.key}><td>{r.label}</td><td className="num">{r.pd}</td>{defs.map((k) => <td key={k.code} className="num">{fv(r.kpi[k.code])}</td>)}</tr>)}
          {!rows.length && <tr><td colSpan={defs.length + 2} className="muted">მონაცემი არ არის</td></tr>}</tbody>
      </table>
    </section>
  );
}
