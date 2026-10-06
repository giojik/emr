import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { ErrorBox, Field, Loading, Modal, useToast } from '../../components/ui';
import { useModuleEnabled } from '../../lib/modules';
import { BED_ST, chipOf, SEX_KA, useStructure, type Bed, type Ward } from '../inpatient/types';

/** საწოლფონდი (0040): განყოფილება (ტიპი „სტაციონარული“) → პალატა → საწოლი. ისტორიის მქონე არ იშლება — ითიშება. */
export default function Beds() {
  const on = useModuleEnabled('inpatient');
  const q = useStructure(true);
  const [dep, setDep] = useState('');
  const [ward, setWard] = useState<Ward | 'new' | null>(null);
  const [beds, setBeds] = useState<Ward | null>(null);
  const [bed, setBed] = useState<Bed | null>(null);
  const [types, setTypes] = useState(false);
  const [showOff, setShowOff] = useState(false);
  if (q.isLoading) return <div className="content"><Loading /></div>;
  if (!on) return <div className="content"><div className="card empty">მოდული „სტაციონარი“ გამორთულია — <Link to="/admin/modules">მოდულები</Link>.</div></div>;
  const deps = q.data?.departments ?? [];
  const cur = deps.find((d) => d.id === dep) ?? deps[0];
  const wards = (cur?.wards ?? []).filter((w) => showOff || w.is_active);
  const total = (cur?.wards ?? []).filter((w) => w.is_active).flatMap((w) => w.beds).filter((b) => b.is_active);
  return (
    <div className="content">
      <ErrorBox error={q.error} />
      {!deps.length ? <div className="card empty">სტაციონარული განყოფილება არ არის — დაამატეთ <Link to="/admin/departments">განყოფილებებში</Link> ტიპით „სტაციონარული“.</div> : <>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <select className="select" style={{ maxWidth: 320, height: 40 }} aria-label="განყოფილება" value={cur?.id ?? ''} onChange={(e) => setDep(e.target.value)}>
            {deps.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
          <span className="muted grow">{total.filter((b) => !b.is_overflow).length} საწოლი{total.some((b) => b.is_overflow) ? ` + ${total.filter((b) => b.is_overflow).length} დამატებითი` : ''}</span>
          <label className="row small"><input type="checkbox" checked={showOff} onChange={(e) => setShowOff(e.target.checked)} /> გათიშულებიც</label>
          <button className="btn" type="button" onClick={() => setTypes(true)}>საწოლის ტიპები</button>
          <button className="btn primary" type="button" onClick={() => setWard('new')}>+ პალატა</button>
        </div>
        {!wards.length && <div className="card empty">ამ განყოფილებაში პალატა ჯერ არ არის.</div>}
        {wards.map((w) => (
          <section key={w.id} className="card" style={{ opacity: w.is_active ? 1 : 0.6 }}>
            <div className="card-head">
              <h2 style={{ margin: 0 }}>პალატა {w.code}</h2>
              {w.name && <span className="muted">{w.name}</span>}
              {w.floor && <span className="small muted">სართ. {w.floor}</span>}
              <span className={`chip ${w.sex === 'mixed' ? '' : 'info'}`}>{SEX_KA[w.sex]}</span>
              {w.isolation_capable && <span className="chip warn">იზოლაცია</span>}
              {!w.is_active && <span className="chip">გათიშული</span>}
              <span className="grow" />
              <button className="btn sm" type="button" onClick={() => setWard(w)}>რედაქტირება</button>
              {w.is_active && <button className="btn sm" type="button" onClick={() => setBeds(w)}>+ საწოლები</button>}
            </div>
            <div className="row" style={{ flexWrap: 'wrap', gap: 8, padding: 12 }}>
              {w.beds.filter((b) => showOff || b.is_active).map((b) => (
                <button key={b.id} type="button" className="btn" style={{ height: 'auto', padding: '8px 12px', flexDirection: 'column', alignItems: 'flex-start', gap: 4, opacity: b.is_active ? 1 : 0.5 }} onClick={() => setBed(b)}>
                  <span><strong>{b.code}</strong>{b.is_overflow && <span className="small muted"> · დამატ.</span>}</span>
                  <span className="small muted" style={{ fontWeight: 400 }}>{b.type_name}</span>
                  {b.is_active ? chipOf(BED_ST, b.status) : <span className="chip">გათიშული</span>}
                </button>))}
              {!w.beds.length && <span className="small muted">საწოლი არ არის</span>}
            </div>
          </section>))}
      </>}
      {ward && cur && <WardDialog w={ward === 'new' ? null : ward} departmentId={cur.id} onClose={() => setWard(null)} />}
      {beds && <BedsDialog w={beds} overflow={!!q.data?.settings.overflow_beds} onClose={() => setBeds(null)} />}
      {bed && <BedDialog b={bed} overflow={!!q.data?.settings.overflow_beds} onClose={() => setBed(null)} />}
      {types && <TypesDialog onClose={() => setTypes(false)} />}
    </div>
  );
}

const inval = (qc: ReturnType<typeof useQueryClient>) => { for (const k of ['ipd-structure', 'ipd-census', 'ipd-board']) void qc.invalidateQueries({ queryKey: [k] }); };

function WardDialog({ w, departmentId, onClose }: { w: Ward | null; departmentId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ code: w?.code ?? '', name: w?.name ?? '', floor: w?.floor ?? '', sex: w?.sex ?? 'mixed', isolation_capable: w?.isolation_capable ?? false, is_active: w?.is_active ?? true });
  const m = useMutation({
    mutationFn: () => w ? api(`/inpatient/wards/${w.id}`, { method: 'PATCH', body: f }) : api('/inpatient/wards', { body: { ...f, department_id: departmentId } }),
    onSuccess: () => { inval(qc); onClose(); },
  });
  return (
    <Modal title={w ? `პალატა ${w.code}` : 'ახალი პალატა'} onClose={onClose} width={520}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="submit" form="wf" disabled={m.isPending || !f.code.trim()}>შენახვა</button></>}>
      <form id="wf" className="stack" style={{ gap: 14 }} onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <div className="row" style={{ gap: 12 }}>
          <Field label="ნომერი" htmlFor="wc" required><input id="wc" className="input mono" maxLength={20} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
          <Field label="სართული" htmlFor="wfl"><input id="wfl" className="input" maxLength={20} value={f.floor} onChange={(e) => setF({ ...f, floor: e.target.value })} /></Field>
        </div>
        <Field label="დასახელება" htmlFor="wn" hint="არასავალდებულო, მაგ. „ინტენსიური“"><input id="wn" className="input" maxLength={120} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="პალატის სქესი" htmlFor="ws" hint="შერეულ პალატაზე სქესის წესი არ მოქმედებს"><select id="ws" className="select" value={f.sex} onChange={(e) => setF({ ...f, sex: e.target.value as Ward['sex'] })}>
          <option value="mixed">შერეული</option><option value="male">მამაკაცის</option><option value="female">ქალის</option></select></Field>
        <label className="row"><input type="checkbox" checked={f.isolation_capable} onChange={(e) => setF({ ...f, isolation_capable: e.target.checked })} /> იზოლაციისთვის განკუთვნილი</label>
        {w && <label className="row"><input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> აქტიური <span className="small muted">(გათიშვისას ითიშება პალატის ყველა საწოლი; დაკავებულზე — შეუძლებელია)</span></label>}
        <ErrorBox error={m.error} />
      </form>
    </Modal>
  );
}

function BedsDialog({ w, overflow, onClose }: { w: Ward; overflow: boolean; onClose: () => void }) {
  const qc = useQueryClient(); const s = useStructure(); const toast = useToast();
  const [f, setF] = useState({ count: 2, type_code: 'standard', prefix: `${w.code}-`, is_overflow: false });
  const m = useMutation({
    mutationFn: () => api<Bed[]>(`/inpatient/wards/${w.id}/beds`, { body: f }),
    onSuccess: (r) => { toast.show(`დაემატა: ${r.map((b) => b.code).join(', ')}`); inval(qc); onClose(); },
  });
  const ex = Array.from({ length: Math.min(f.count, 3) }, (_, i) => `${f.prefix}${i + 1}`).join(', ');
  return (
    <Modal title={`საწოლების დამატება — პალატა ${w.code}`} onClose={onClose} width={520}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={m.isPending} onClick={() => m.mutate()}>დამატება</button></>}>
      {toast.node}
      <div className="stack" style={{ gap: 14 }}>
        <div className="row" style={{ gap: 12 }}>
          <Field label="რაოდენობა" htmlFor="bc"><input id="bc" className="input mono" type="number" min={1} max={40} value={f.count} onChange={(e) => setF({ ...f, count: Number(e.target.value) })} /></Field>
          <Field label="აღნიშვნის დასაწყისი" htmlFor="bp" hint={`მაგ.: ${ex}${f.count > 3 ? '…' : ''}`}><input id="bp" className="input mono" maxLength={15} value={f.prefix} onChange={(e) => setF({ ...f, prefix: e.target.value })} /></Field>
        </div>
        <Field label="ტიპი" htmlFor="bt"><select id="bt" className="select" value={f.type_code} onChange={(e) => setF({ ...f, type_code: e.target.value })}>
          {s.data?.types.filter((t) => t.is_active).map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}</select></Field>
        {overflow && <label className="row"><input type="checkbox" checked={f.is_overflow} onChange={(e) => setF({ ...f, is_overflow: e.target.checked, prefix: e.target.checked ? `${w.code}-D` : `${w.code}-` })} /> დამატებითი (დერეფანი და სხვ.) — სტატისტიკაში ცალკე</label>}
        <span className="small muted">არსებული აღნიშვნები გამოიტოვება — ნუმერაცია გაგრძელდება.</span>
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}

function BedDialog({ b, overflow, onClose }: { b: Bed; overflow: boolean; onClose: () => void }) {
  const qc = useQueryClient(); const s = useStructure();
  const [f, setF] = useState({ code: b.code, type_code: b.type_code, is_overflow: b.is_overflow, is_active: b.is_active });
  const m = useMutation({ mutationFn: () => api(`/inpatient/beds/${b.id}`, { method: 'PATCH', body: f }), onSuccess: () => { inval(qc); onClose(); } });
  const busy = ['occupied', 'reserved'].includes(b.status);
  return (
    <Modal title={`საწოლი ${b.code}`} onClose={onClose} width={480}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={m.isPending || !f.code.trim()} onClick={() => m.mutate()}>შენახვა</button></>}>
      <div className="stack" style={{ gap: 14 }}>
        <div className="row">სტატუსი: {chipOf(BED_ST, b.status)}{b.status_reason && <span className="small muted">{b.status_reason}</span>}</div>
        <Field label="აღნიშვნა" htmlFor="bcd"><input id="bcd" className="input mono" maxLength={20} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
        <Field label="ტიპი" htmlFor="btp"><select id="btp" className="select" value={f.type_code} onChange={(e) => setF({ ...f, type_code: e.target.value })}>
          {s.data?.types.filter((t) => t.is_active || t.code === b.type_code).map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}</select></Field>
        {(overflow || b.is_overflow) && <label className="row"><input type="checkbox" checked={f.is_overflow} onChange={(e) => setF({ ...f, is_overflow: e.target.checked })} /> დამატებითი</label>}
        <label className="row"><input type="checkbox" checked={f.is_active} disabled={busy && f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> აქტიური
          {busy && <span className="small muted">(დაკავებული / დაჯავშნილი — ვერ გაითიშება)</span>}</label>
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}

function TypesDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient(); const s = useStructure();
  const [n, setN] = useState({ code: '', name: '' });
  const add = useMutation({ mutationFn: () => api('/inpatient/bed-types', { body: n }), onSuccess: () => { setN({ code: '', name: '' }); inval(qc); } });
  const upd = useMutation({ mutationFn: (a: { code: string; is_active: boolean }) => api(`/inpatient/bed-types/${a.code}`, { method: 'PATCH', body: { is_active: a.is_active } }), onSuccess: () => inval(qc) });
  return (
    <Modal title="საწოლის ტიპები" onClose={onClose} width={560}>
      <div className="stack" style={{ gap: 12 }}>
        <table className="table"><tbody>{s.data?.types.map((t) => (
          <tr key={t.code}><td className="mono small">{t.code}</td><td>{t.name}</td>
            <td><label className="row small"><input type="checkbox" checked={t.is_active} onChange={(e) => upd.mutate({ code: t.code, is_active: e.target.checked })} /> აქტიური</label></td></tr>))}</tbody></table>
        <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
          <Field label="კოდი" htmlFor="tc" hint="ლათ. პატარა ასოები, მაგ. stretcher"><input id="tc" className="input mono" value={n.code} onChange={(e) => setN({ ...n, code: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') })} /></Field>
          <Field label="დასახელება" htmlFor="tn"><input id="tn" className="input" value={n.name} onChange={(e) => setN({ ...n, name: e.target.value })} /></Field>
          <button className="btn primary" type="button" disabled={add.isPending || n.code.length < 2 || n.name.trim().length < 2} onClick={() => add.mutate()}>დამატება</button>
        </div>
        <ErrorBox error={add.error ?? upd.error} />
      </div>
    </Modal>
  );
}
