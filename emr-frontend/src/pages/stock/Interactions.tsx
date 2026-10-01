import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, can } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Field, Loading, Modal } from '../../components/ui';
import { GenericPicker } from './Generics';
import { CLINICAL_EDIT } from './Stock';
import { nul, SEVERITY_KA, type MedInteraction, type Severity } from './types';

interface CheckHit { a: string; b: string; severity: Severity | 'duplicate'; effect: string; recommendation: string | null; source: string }

/** ურთიერთქმედებები: ჯენერიკი ან ATC-ჯგუფი × ჯენერიკი ან ATC-ჯგუფი; ფარმაცევტის ცხრილი (მოგვიანებით — გარე ბაზის იმპორტიც) */
export default function Interactions() {
  const { user } = useAuth();
  const [filter, setFilter] = useState<{ id: string; label: string } | null>(null); const [all, setAll] = useState(false);
  const q = useQuery({ queryKey: ['med-interactions', filter?.id, all], queryFn: () => api<MedInteraction[]>('/pharmacy/interactions', { query: { generic_id: filter?.id, all } }) });
  const [edit, setEdit] = useState<MedInteraction | 'new' | null>(null);
  const editable = can(user, ...CLINICAL_EDIT);
  return (
    <div className="content">
      <Checker />
      <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div style={{ minWidth: 340 }}><GenericPicker value={filter?.id ?? null} label={filter ? `ფილტრი: ${filter.label}` : null} onChange={setFilter} allowCreate={false} placeholder="ფილტრი: ჯენერიკი (INN ან ATC)" /></div>
        <label className="row small" style={{ marginTop: 10 }}><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> გათიშულიც</label>
        <span className="grow" />
        {editable && <button className="btn primary" type="button" onClick={() => setEdit('new')}>+ ურთიერთქმედება</button>}
      </div>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : (
        <div className="card">
          <table className="table">
            <thead><tr><th>სიმძიმე</th><th>A</th><th>B</th><th>ეფექტი</th><th>რეკომენდაცია</th><th>წყარო</th></tr></thead>
            <tbody>{q.data?.map((x) => (
              <tr key={x.id} className="clickable" onClick={() => setEdit(x)} style={x.is_active ? undefined : { opacity: 0.55 }}>
                <td><span className={`chip ${SEVERITY_KA[x.severity][0]}`}>{SEVERITY_KA[x.severity][1]}</span></td>
                <td>{x.a_label}</td><td>{x.b_label}</td><td className="small">{x.effect}</td><td className="small">{x.recommendation ?? '—'}</td>
                <td className="small">{x.source === 'local' ? 'საკუთარი' : `გარე${x.source_ref ? ` · ${x.source_ref}` : ''}`}</td>
              </tr>))}
              {!q.data?.length && <tr><td colSpan={6} className="muted">ჩანაწერი არ არის</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {edit && <InteractionDialog x={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

/** შემოწმება: რამდენიმე ჯენერიკი → ურთიერთქმედებები + თერაპიის დუბლირება */
function Checker() {
  const [list, setList] = useState<{ id: string; label: string }[]>([]);
  const m = useMutation({ mutationFn: () => api<CheckHit[]>('/pharmacy/interactions/check', { body: { generic_ids: list.map((x) => x.id) } }) });
  return (
    <section className="card card-pad stack" style={{ gap: 8 }}>
      <strong>შემოწმება</strong>
      <span className="hint">აირჩიეთ 2 ან მეტი ჯენერიკი — სისტემა აჩვენებს ცნობილ ურთიერთქმედებებს (ATC-ჯგუფების ჩათვლით) და ერთი აქტიური ნივთიერების დუბლირებას. იგივე შემოწმება ჩაერთვება დანიშნულებაში (სტაციონარის ეტაპი).</span>
      <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
        {list.map((g) => <span key={g.id} className="term">{g.label}<button type="button" aria-label={`მოხსნა: ${g.label}`} onClick={() => { setList(list.filter((x) => x.id !== g.id)); m.reset(); }}>×</button></span>)}
      </div>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div style={{ minWidth: 340 }} className="grow"><GenericPicker key={list.length} value={null} label={null} onChange={(g) => { if (g && !list.some((x) => x.id === g.id)) { setList([...list, g]); m.reset(); } }} allowCreate={false} placeholder="დაამატეთ ჯენერიკი შესამოწმებლად" /></div>
        <button className="btn" type="button" disabled={list.length < 2 || m.isPending} onClick={() => m.mutate()}>შემოწმება</button>
      </div>
      <ErrorBox error={m.error} />
      {m.data && (m.data.length ? m.data.map((h, i) => (
        <div key={i} className={`alert ${SEVERITY_KA[h.severity][0] || 'info'}`}>
          <strong>{SEVERITY_KA[h.severity][1]}:</strong> {h.a} + {h.b} — {h.effect}{h.recommendation ? `. ${h.recommendation}` : ''}
        </div>)) : <div className="alert ok">ცნობილი ურთიერთქმედება არ მოიძებნა</div>)}
    </section>
  );
}

type SideKind = 'generic' | 'atc';
function Side({ title, kind, setKind, gen, setGen, atc, setAtc }: { title: string; kind: SideKind; setKind: (k: SideKind) => void; gen: { id: string; label: string } | null;
  setGen: (g: { id: string; label: string } | null) => void; atc: string; setAtc: (s: string) => void }) {
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row"><span className="label grow">{title}</span>
        <div className="seg" role="group" aria-label={title}>
          <button type="button" aria-pressed={kind === 'generic'} onClick={() => setKind('generic')}>ჯენერიკი</button>
          <button type="button" aria-pressed={kind === 'atc'} onClick={() => setKind('atc')}>ATC ჯგუფი</button>
        </div></div>
      {kind === 'generic' ? <GenericPicker value={gen?.id ?? null} label={gen?.label ?? null} onChange={setGen} />
        : <input className="input mono" aria-label={`${title} — ATC`} placeholder="მაგ. B01A (ანტითრომბოზული)" maxLength={7} value={atc} onChange={(e) => setAtc(e.target.value.toUpperCase())} />}
    </div>
  );
}

function InteractionDialog({ x, onClose }: { x: MedInteraction | null; onClose: () => void }) {
  const { user } = useAuth(); const qc = useQueryClient(); const editable = can(user, ...CLINICAL_EDIT);
  const [ak, setAk] = useState<SideKind>(x?.a_atc ? 'atc' : 'generic'); const [bk, setBk] = useState<SideKind>(x?.b_atc ? 'atc' : 'generic');
  const [ag, setAg] = useState(x?.a_generic_id ? { id: x.a_generic_id, label: x.a_label } : null); const [bg, setBg] = useState(x?.b_generic_id ? { id: x.b_generic_id, label: x.b_label } : null);
  const [aa, setAa] = useState(x?.a_atc ?? ''); const [ba, setBa] = useState(x?.b_atc ?? '');
  const [f, setF] = useState({ severity: (x?.severity ?? 'moderate') as Severity, effect: x?.effect ?? '', recommendation: x?.recommendation ?? '', source: x?.source ?? 'local', source_ref: x?.source_ref ?? '', is_active: x?.is_active ?? true });
  const m = useMutation({
    mutationFn: () => {
      const body = {
        a_generic_id: ak === 'generic' ? ag?.id ?? null : null, a_atc: ak === 'atc' ? nul(aa) : null, b_generic_id: bk === 'generic' ? bg?.id ?? null : null, b_atc: bk === 'atc' ? nul(ba) : null,
        severity: f.severity, effect: f.effect.trim(), recommendation: nul(f.recommendation), source: f.source, source_ref: nul(f.source_ref), ...(x && { is_active: f.is_active }),
      };
      return x ? api(`/pharmacy/interactions/${x.id}`, { method: 'PATCH', body }) : api('/pharmacy/interactions', { body });
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['med-interactions'] }); onClose(); },
  });
  const okA = ak === 'generic' ? !!ag : aa.length >= 1; const okB = bk === 'generic' ? !!bg : ba.length >= 1;
  return (
    <Modal title={x ? 'ურთიერთქმედება' : 'ახალი ურთიერთქმედება'} onClose={onClose} width={760}
      footer={<><button className="btn" type="button" onClick={onClose}>{editable ? 'გაუქმება' : 'დახურვა'}</button>
        {editable && <button className="btn primary" type="submit" form="ixf" disabled={m.isPending || !okA || !okB || f.effect.trim().length < 3}>შენახვა</button>}</>}>
      <form id="ixf" className="stack" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <fieldset disabled={!editable} style={{ border: 0, padding: 0, margin: 0 }} className="stack">
          <Side title="A" kind={ak} setKind={setAk} gen={ag} setGen={setAg} atc={aa} setAtc={setAa} />
          <Side title="B" kind={bk} setKind={setBk} gen={bg} setGen={setBg} atc={ba} setAtc={setBa} />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
            <Field label="სიმძიმე" htmlFor="xs" required>
              <select id="xs" className="select" value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value as Severity })}>
                {(['contraindicated', 'major', 'moderate', 'minor'] as Severity[]).map((s) => <option key={s} value={s}>{SEVERITY_KA[s][1]}</option>)}
              </select></Field>
            <Field label="წყარო" htmlFor="xso">
              <select id="xso" className="select" value={f.source} onChange={(e) => setF({ ...f, source: e.target.value as 'local' | 'external' })}>
                <option value="local">საკუთარი (ფარმაცევტი)</option><option value="external">გარე ბაზა</option>
              </select></Field>
          </div>
          <Field label="ეფექტი" htmlFor="xe" required><textarea id="xe" className="textarea" rows={2} value={f.effect} onChange={(e) => setF({ ...f, effect: e.target.value })} placeholder="მაგ. სისხლდენის რისკის მატება" /></Field>
          <Field label="რეკომენდაცია" htmlFor="xr"><textarea id="xr" className="textarea" rows={2} value={f.recommendation} onChange={(e) => setF({ ...f, recommendation: e.target.value })} placeholder="მაგ. INR-ის კონტროლი, დოზის კორექცია" /></Field>
          <Field label="წყაროს მითითება" htmlFor="xsr"><input id="xsr" className="input" value={f.source_ref} onChange={(e) => setF({ ...f, source_ref: e.target.value })} /></Field>
          {x && <label className="row"><input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> აქტიური</label>}
        </fieldset>
        <ErrorBox error={m.error} />
      </form>
    </Modal>
  );
}
