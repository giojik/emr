import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api/client';
import { openIncidentReport } from '../../components/IncidentReport';
import { ErrorBox, Field, Loading, Modal } from '../../components/ui';
import { age, genderShort, tsDate } from '../../lib/format';
import { useModuleEnabled } from '../../lib/modules';
import { ContextBox } from './Surveillance';
import { BSI_SRC_KA, CONTRIB_KA, HAI_ST, OUTCOME_KA, SIGNAL_KA, SSI_KA, useHaiCatalog, type HaiDetail, type PatientOp } from './types';

const t = (v: string | null | undefined) => (v ? `${tsDate(v)} ${new Date(v).toLocaleTimeString('ka-GE', { timeZone: 'Asia/Tbilisi', hour: '2-digit', minute: '2-digit', hour12: false })}` : '—');
const EV_KA: Record<string, string> = { created: 'შეიქმნა', updated: 'შეიცვალა', review: 'განხილვა', confirm: 'დადასტურდა', reject: 'უარყოფილია', reopen: 'ხელახლა გაიხსნა' };
const QM_ST: Record<string, string> = { submitted: 'ტრიაჟს ელოდება', rejected: 'უარყოფილი', investigation: 'განიხილება', analysis: 'ანალიზი', capa: 'ქმედებები', closed: 'დახურული' };
const QM_CAT: Record<string, string> = { bsi: 'inf_line', uti: 'inf_line', pn: 'inf_vap', ssi: 'inf_ssi' };

/** HAI შემთხვევის ბარათი (0068): კონტექსტი, ჩეკლისტი, მიკროორგანიზმები / კულტურები, მოწყობილობა / მიკუთვნება (ხელით), სტატუსი, ხარისხის ინციდენტი */
export default function HaiCard() {
  const { id = '' } = useParams(); const nav = useNavigate(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['ipc-hai-card', id], queryFn: () => api<HaiDetail>(`/ipc/hai/${id}`) });
  const cat = useHaiCatalog(); const qmOn = useModuleEnabled('quality');
  const ops = useQuery({ queryKey: ['ipc-patient-ops', q.data?.patient_id], queryFn: () => api<PatientOp[]>(`/ipc/ssi/patients/${q.data!.patient_id}/ops`),
    enabled: q.data?.hai_type === 'ssi' });
  const [dlg, setDlg] = useState<null | 'reject' | 'reopen' | 'device' | 'attribution'>(null);
  const inval = () => { void qc.invalidateQueries({ queryKey: ['ipc-hai-card', id] }); void qc.invalidateQueries({ queryKey: ['ipc-hai'] }); };
  const patch = useMutation({ mutationFn: (body: Record<string, unknown>) => api(`/ipc/hai/${id}`, { method: 'PATCH', body }), onSuccess: inval });
  const go = useMutation({ mutationFn: (to: 'review' | 'confirm') => api(`/ipc/hai/${id}/${to}`, { body: {} }), onSuccess: inval });
  const [desc, setDesc] = useState<string | null>(null);
  useEffect(() => { setDesc(null); }, [q.data?.description]);
  if (q.isLoading) return <div className="content"><Loading /></div>;
  const h = q.data;
  if (!h) return <div className="content"><ErrorBox error={q.error} /></div>;
  const ed = h.can.edit;
  const met = new Set(h.criteria_met);
  const allOrgs = [...new Map([...h.organisms.map((o) => [o.id, o.name] as const), ...h.cultures.flatMap((c) => (c.organisms ?? []).map((o) => [o.id, o.name] as const))]).entries()];
  const toQuality = async () => {
    const cats = await api<{ id: string; code: string }[]>('/quality/classifiers', { query: { kind: 'category' } }).catch(() => []);
    openIncidentReport({ patient: { id: h.patient_id, name: `${h.first_name} ${h.last_name}` }, source: { type: 'hai_case', id: h.id, label: `HAI ${h.case_no} · ${h.short_name}` },
      department_id: h.department_id, category_id: cats.find((c) => c.code === (QM_CAT[h.hai_type] ?? 'infection'))?.id ?? cats.find((c) => c.code === 'infection')?.id ?? null });
  };
  return (
    <>
      <header className="topbar" style={{ flexWrap: 'wrap', gap: 10 }}>
        <button className="btn sm" type="button" onClick={() => nav(-1)}>←</button>
        <h1 style={{ margin: 0 }}>{h.case_no}</h1>
        {h.device_assoc && h.device_name ? <span className="chip danger">{h.device_name}</span> : <span className="chip">{h.short_name}</span>}
        <span className={`chip ${HAI_ST[h.status][0]}`}>{HAI_ST[h.status][1]}</span>
        <span className="grow" />
        {h.status === 'suspected' && <button className="btn" type="button" disabled={go.isPending} onClick={() => go.mutate('review')}>განხილვის დაწყება</button>}
        {h.can.decide && ['suspected', 'review'].includes(h.status) && <button className="btn primary" type="button" disabled={go.isPending} onClick={() => go.mutate('confirm')}>დადასტურება</button>}
        {h.can.decide && ['suspected', 'review'].includes(h.status) && <button className="btn" type="button" onClick={() => setDlg('reject')}>უარყოფა</button>}
        {h.can.decide && ['confirmed', 'rejected'].includes(h.status) && <button className="btn" type="button" onClick={() => setDlg('reopen')}>ხელახლა გახსნა</button>}
        {h.can.quality && qmOn && <button className="btn" type="button" onClick={() => void toQuality()} title="ინციდენტის შეტყობინება — ხარისხის მენეჯერს (RCA / CAPA)">⚠ ხარისხს გადაცემა</button>}
      </header>
      <div className="content">
        <ErrorBox error={go.error ?? patch.error} />
        {h.status === 'rejected' && <div className="alert warn">უარყოფილია: {h.rejected_reason}</div>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 14 }}>
          <section className="card card-pad stack" style={{ gap: 8 }}>
            <h2 style={{ margin: 0 }}>პაციენტი და კონტექსტი</h2>
            <div><Link to={`/patients/${h.patient_id}`}><strong>{h.last_name} {h.first_name}</strong></Link> <span className="small muted">{genderShort(h.gender)} · {age(h.birth_date)} · {h.personal_number}</span></div>
            {h.encounter_id && <div className="small">ჰოსპიტალიზაცია: <Link to={`/inpatient/stay/${h.encounter_id}`} className="mono">{h.adm_no}</Link>{h.stay_status === 'active' ? '' : ' (დასრულებული)'}</div>}
            <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
              <Field label="ტიპი" htmlFor="hd-t"><select id="hd-t" className="select" disabled={!ed} value={h.hai_type} onChange={(e) => patch.mutate({ hai_type: e.target.value })}>
                {cat.data?.types.map((x) => <option key={x.code} value={x.code}>{x.short_name} — {x.name}</option>)}</select></Field>
              <Field label="ინფექციის დღე" htmlFor="hd-d"><input id="hd-d" type="date" className="input" disabled={!ed} defaultValue={h.onset_date}
                onBlur={(e) => { if (e.target.value && e.target.value !== h.onset_date) patch.mutate({ onset_date: e.target.value }); }} /></Field>
              {h.hai_type === 'ssi' && <Field label="სიღრმე" htmlFor="hd-s"><select id="hd-s" className="select" disabled={!ed} value={h.ssi_depth ?? ''} onChange={(e) => patch.mutate({ ssi_depth: e.target.value || null })}>
                <option value="">—</option>{Object.entries(SSI_KA).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>}
              {h.hai_type === 'bsi' && <Field label="წყარო" htmlFor="hd-b"><select id="hd-b" className="select" disabled={!ed} value={h.bsi_source ?? ''} onChange={(e) => patch.mutate({ bsi_source: e.target.value || null })}>
                <option value="">—</option>{Object.entries(BSI_SRC_KA).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>}
              {h.hai_type === 'ssi' && <Field label="ოპერაცია" htmlFor="hd-o"><select id="hd-o" className="select" disabled={!ed} value={h.or_case_id ?? ''}
                onChange={(e) => patch.mutate({ or_case_id: e.target.value || null })}>
                <option value="">ავტომატურად</option>{ops.data?.map((o) => <option key={o.id} value={o.id}>{o.case_no} · {o.op_at ? tsDate(o.op_at) : '—'} · {o.procedures ?? ''}</option>)}</select></Field>}
            </div>
            {h.context && <ContextBox c={{ ...h.context, department: h.department, department_id: h.department_id, attribution: h.attribution, device_assoc: h.device_assoc }}
              override={{ device: h.device_override, attribution: h.attribution === 'manual' }} />}
            {h.attribution === 'manual' && <span className="small muted">მიკუთვნება ხელით: {h.attribution_note}</span>}
            {h.device_override && <span className="small muted">მოწყობილობა ხელით: {h.device_note}</span>}
            {ed && <div className="row" style={{ gap: 8 }}>
              <button className="btn sm" type="button" onClick={() => setDlg('attribution')}>მიკუთვნების შეცვლა</button>
              {h.device_kind && <button className="btn sm" type="button" onClick={() => setDlg('device')}>მოწყობილობასთან კავშირი</button>}</div>}
          </section>
          <section className="card card-pad stack" style={{ gap: 8 }}>
            <h2 style={{ margin: 0 }}>კრიტერიუმები <span className="small muted">{h.criteria_set} {h.criteria_version}</span></h2>
            {!h.criteria.length ? <span className="muted">ამ ტიპზე ჩეკლისტი არ არის</span> : h.criteria.map((c) => (
              <label key={c.id} className="row small" style={{ alignItems: 'flex-start', gap: 8 }}>
                <input type="checkbox" disabled={!ed || patch.isPending} checked={met.has(c.id)} style={{ marginTop: 3 }}
                  onChange={(e) => patch.mutate({ criteria_met: e.target.checked ? [...met, c.id] : [...met].filter((x) => x !== c.id) })} />
                <span>{c.grp && <strong>{c.grp}: </strong>}{c.text}{c.required && <span className="chip warn" style={{ marginLeft: 6, height: 18 }}>სავალდ.</span>}</span></label>))}
            <span className="hint">ჩეკლისტი დამხმარეა — საბოლოო გადაწყვეტილებას იღებს ინფექციის კონტროლის ექიმი.</span>
          </section>
          <section className="card card-pad stack" style={{ gap: 8 }}>
            <h2 style={{ margin: 0 }}>მიკრობიოლოგია</h2>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>{allOrgs.map(([oid, name]) => {
              const on = h.organism_ids.includes(oid);
              return <button key={oid} type="button" className={`chip${on ? ' danger' : ''}`} disabled={!ed} aria-pressed={on}
                onClick={() => patch.mutate({ organism_ids: on ? h.organism_ids.filter((x) => x !== oid) : [...h.organism_ids, oid] })}><i>{name}</i></button>; })}
              {!allOrgs.length && <span className="muted small">დადებითი კულტურა ±14 დღეში არ არის</span>}</div>
            {h.cultures.length > 0 && <table className="table small"><thead><tr><th /><th>ნიმუში</th><th>ანალიზი</th><th>მიკროორგანიზმი</th></tr></thead>
              <tbody>{h.cultures.map((c) => { const on = h.order_item_ids.includes(c.id);
                return <tr key={c.id}><td><input type="checkbox" disabled={!ed} checked={on} aria-label="მიბმა" onChange={() => patch.mutate({ order_item_ids: on ? h.order_item_ids.filter((x) => x !== c.id) : [...h.order_item_ids, c.id] })} /></td>
                  <td className="mono">{t(c.collected_at)}</td><td>{c.service}{c.specimen_type ? ` · ${c.specimen_type}` : ''}</td><td><i>{(c.organisms ?? []).map((o) => o.name).join(', ')}</i></td></tr>; })}</tbody></table>}
          </section>
          <section className="card card-pad stack" style={{ gap: 8 }}>
            <h2 style={{ margin: 0 }}>აღწერა და გამოსავალი</h2>
            <textarea className="textarea" rows={3} aria-label="აღწერა" value={desc ?? h.description ?? ''} onChange={(e) => setDesc(e.target.value)} />
            {desc !== null && desc !== (h.description ?? '') && <button className="btn sm primary" style={{ alignSelf: 'flex-start' }} type="button" onClick={() => patch.mutate({ description: desc })}>შენახვა</button>}
            <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
              <Field label="გამოსავალი" htmlFor="hd-o"><select id="hd-o" className="select" value={h.outcome ?? ''} onChange={(e) => patch.mutate({ outcome: e.target.value || null })}>
                <option value="">—</option>{Object.entries(OUTCOME_KA).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
              <Field label="HAI-მ ხელი შეუწყო (გარდაცვალება)" htmlFor="hd-c"><select id="hd-c" className="select" value={h.hai_contributed ?? ''} onChange={(e) => patch.mutate({ hai_contributed: e.target.value || null })}>
                <option value="">—</option>{Object.entries(CONTRIB_KA).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
            </div>
          </section>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 14 }}>
          <section className="card card-pad stack" style={{ gap: 6 }}>
            <h2 style={{ margin: 0 }}>სიგნალები და ხარისხი</h2>
            {h.signals.map((s) => <div key={s.id} className="small"><span className="chip warn">{SIGNAL_KA[s.kind]}</span> {s.summary} <span className="muted mono">{t(s.event_at)}</span></div>)}
            {!h.signals.length && <span className="small muted">სიგნალი მიბმული არ არის (ხელით შექმნილი)</span>}
            {h.incidents.map((i) => <div key={i.inc_no} className="small">ინციდენტი <span className="mono">{i.inc_no}</span> — {QM_ST[i.status] ?? i.status}</div>)}
          </section>
          <section className="card card-pad stack" style={{ gap: 4 }}>
            <h2 style={{ margin: 0 }}>ქრონოლოგია</h2>
            {h.events.map((e) => <div key={e.id} className="small"><span className="mono muted">{t(e.at)}</span> · {EV_KA[e.kind] ?? e.kind}{e.user_name ? ` · ${e.user_name}` : ''}{e.text ? ` — ${e.text}` : ''}</div>)}
          </section>
        </div>
      </div>
      {(dlg === 'reject' || dlg === 'reopen') && <ReasonDialog title={dlg === 'reject' ? 'შემთხვევის უარყოფა' : 'ხელახლა გახსნა'} path={`/ipc/hai/${id}/${dlg}`} onClose={() => setDlg(null)} onDone={() => { setDlg(null); inval(); }} />}
      {dlg === 'device' && <DeviceDialog h={h} onClose={() => setDlg(null)} onDone={() => { setDlg(null); inval(); }} />}
      {dlg === 'attribution' && <AttributionDialog h={h} onClose={() => setDlg(null)} onDone={() => { setDlg(null); inval(); }} />}
    </>
  );
}

function ReasonDialog({ title, path, onClose, onDone }: { title: string; path: string; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const m = useMutation({ mutationFn: () => api(path, { body: { reason: reason.trim() } }), onSuccess: onDone });
  return (
    <Modal title={title} onClose={onClose} footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button>
      <button className="btn primary" type="button" disabled={m.isPending || reason.trim().length < 3} onClick={() => m.mutate()}>დადასტურება</button></>}>
      <div className="stack" style={{ gap: 12 }}><ErrorBox error={m.error} />
        <Field label="მიზეზი" htmlFor="rd-r" required><input id="rd-r" className="input" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} /></Field></div>
    </Modal>
  );
}

function DeviceDialog({ h, onClose, onDone }: { h: HaiDetail; onClose: () => void; onDone: () => void }) {
  const [assoc, setAssoc] = useState(h.device_assoc); const [note, setNote] = useState(h.device_note ?? '');
  const m = useMutation({ mutationFn: (body: Record<string, unknown>) => api(`/ipc/hai/${h.id}`, { method: 'PATCH', body }), onSuccess: onDone });
  return (
    <Modal title={`მოწყობილობასთან კავშირი (${h.device_name})`} onClose={onClose} footer={<>
      {h.device_override && <button className="btn" type="button" disabled={m.isPending} onClick={() => m.mutate({ device_override: false })}>ავტომატურზე დაბრუნება</button>}
      <span className="grow" /><button className="btn" type="button" onClick={onClose}>გაუქმება</button>
      <button className="btn primary" type="button" disabled={m.isPending || note.trim().length < 3} onClick={() => m.mutate({ device_override: true, device_assoc: assoc, device_note: note.trim() })}>შენახვა</button></>}>
      <div className="stack" style={{ gap: 12 }}><ErrorBox error={m.error} />
        <span className="small">ავტომატურად: {h.context?.device_detail ?? '—'}</span>
        <label className="row"><input type="checkbox" checked={assoc} onChange={(e) => setAssoc(e.target.checked)} /> ასოცირებულია ({h.device_name})</label>
        <Field label="მიზეზი" htmlFor="dv-n" required><input id="dv-n" className="input" value={note} maxLength={500} placeholder="მაგ. სხვა კლინიკაში ჩადგმული, ჩანაწერი აკლია" onChange={(e) => setNote(e.target.value)} /></Field></div>
    </Modal>
  );
}

function AttributionDialog({ h, onClose, onDone }: { h: HaiDetail; onClose: () => void; onDone: () => void }) {
  const depts = useQuery({ queryKey: ['departments'], queryFn: () => api<{ id: string; name: string; type: string }[]>('/departments'), staleTime: 5 * 60_000 });
  const [dep, setDep] = useState(h.department_id ?? ''); const [note, setNote] = useState(h.attribution_note ?? '');
  const m = useMutation({ mutationFn: (body: Record<string, unknown>) => api(`/ipc/hai/${h.id}`, { method: 'PATCH', body }), onSuccess: onDone });
  return (
    <Modal title="მიკუთვნებული განყოფილება" onClose={onClose} footer={<>
      {h.attribution === 'manual' && <button className="btn" type="button" disabled={m.isPending} onClick={() => m.mutate({ department_id: null })}>ავტომატურზე დაბრუნება</button>}
      <span className="grow" /><button className="btn" type="button" onClick={onClose}>გაუქმება</button>
      <button className="btn primary" type="button" disabled={m.isPending || !dep || note.trim().length < 3} onClick={() => m.mutate({ department_id: dep, attribution_note: note.trim() })}>შენახვა</button></>}>
      <div className="stack" style={{ gap: 12 }}><ErrorBox error={m.error} />
        <Field label="განყოფილება" htmlFor="at-d"><select id="at-d" className="select" value={dep} onChange={(e) => setDep(e.target.value)}>
          <option value="">—</option>{depts.data?.filter((d) => d.type === 'inpatient').map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
        <Field label="მიზეზი" htmlFor="at-n" required><input id="at-n" className="input" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} /></Field></div>
    </Modal>
  );
}
