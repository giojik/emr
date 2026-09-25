import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import type { DxService, ReportTemplate } from '../../api/types';
import { ErrorBox, Field, Loading, Modal } from '../../components/ui';
import { MODALITY_KA, REPORT_FIELDS, type ReportField } from '../../lib/format';

type Section = 'radiology' | 'endoscopy';
const MODS = ['CT', 'MR', 'US', 'DX', 'RF', 'MG', 'DXA'];
const FIELD_KA = Object.fromEntries(REPORT_FIELDS) as Record<ReportField, string>;

/** შაბლონები და სწრაფი ფრაზები: საერთო (ხელმძღვანელი / admin) + პირადი */
export default function Templates({ section }: { section: Section }) {
  const [scope, setScope] = useState<'all' | 'shared' | 'mine'>('all');
  const [kind, setKind] = useState<'template' | 'phrase'>('template');
  const [mod, setMod] = useState('');
  const [edit, setEdit] = useState<{ t: ReportTemplate | null; copy?: boolean } | null>(null);
  const q = useQuery({ queryKey: ['report-templates', section, 'manage'], queryFn: () => api<{ can_manage_shared: boolean; items: ReportTemplate[] }>('/dx/report-templates', { query: { section, manage: true } }) });
  const canShared = !!q.data?.can_manage_shared;
  const list = (q.data?.items ?? []).filter((t) => t.kind === kind && (scope === 'all' || (scope === 'shared') === !t.owner_id) && (!mod || t.modality === mod || (mod === '*' && !t.modality)));
  return (
    <div className="content">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <div className="seg" role="group" aria-label="ტიპი">
          <button type="button" aria-pressed={kind === 'template'} onClick={() => setKind('template')}>შაბლონები</button>
          <button type="button" aria-pressed={kind === 'phrase'} onClick={() => setKind('phrase')}>სწრაფი ფრაზები</button>
        </div>
        <div className="seg" role="group" aria-label="მფლობელი">
          {([['all', 'ყველა'], ['shared', 'საერთო'], ['mine', 'ჩემი']] as const).map(([k, l]) => <button key={k} type="button" aria-pressed={scope === k} onClick={() => setScope(k)}>{l}</button>)}
        </div>
        {section === 'radiology' && <select aria-label="მოდალობა" className="select" style={{ width: 180, height: 38 }} value={mod} onChange={(e) => setMod(e.target.value)}>
          <option value="">ყველა მოდალობა</option><option value="*">ნებისმიერი (საერთო)</option>{MODS.map((m) => <option key={m} value={m}>{MODALITY_KA[m]}</option>)}
        </select>}
        <button className="btn primary" type="button" style={{ marginLeft: 'auto' }} onClick={() => setEdit({ t: null })}>+ {kind === 'template' ? 'შაბლონი' : 'ფრაზა'}</button>
      </div>
      <span className="hint">საერთოს ცვლის განყოფილების ხელმძღვანელი{canShared ? ' (თქვენ)' : ''}. ცვლადები: {'{პაციენტი} {ასაკი} {სქესი} {კვლევა} {თარიღი} {კონტრასტი}'} · ___ — შესავსები ადგილი (ხელმოწერამდე სავალდებულო).</span>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : !list.length ? <div className="card empty">ჩანაწერი არ არის.</div> : (
        <div className="card">
          <table className="table">
            <thead><tr><th>დასახელება</th>{section === 'radiology' && <th>მოდალობა</th>}<th>{kind === 'template' ? 'კვლევა' : 'ველი'}</th><th>მფლობელი</th><th>სტატუსი</th></tr></thead>
            <tbody>{list.map((t) => (
              <tr key={t.id} className="clickable" onClick={() => setEdit({ t })}>
                <td><strong>{t.name}</strong><div className="small muted" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 520 }}>{kind === 'template' ? t.impression ?? t.findings : t.body}</div></td>
                {section === 'radiology' && <td>{t.modality ? MODALITY_KA[t.modality] ?? t.modality : '—'}</td>}
                <td className="small">{kind === 'template' ? t.service_name ?? 'ყველა' : t.target ? FIELD_KA[t.target] : ''}</td>
                <td>{t.owner_id ? <span className="chip">ჩემი</span> : <span className="chip info">საერთო</span>}</td>
                <td>{t.is_active ? <span className="chip ok">აქტიური</span> : <span className="chip">გათიშული</span>}</td>
              </tr>))}</tbody>
          </table>
        </div>
      )}
      {edit && <TemplateDialog section={section} kind={edit.t?.kind ?? kind} t={edit.copy ? null : edit.t} base={edit.t} canShared={canShared}
        onCopy={() => setEdit({ t: edit.t, copy: true })} onClose={() => setEdit(null)} />}
    </div>
  );
}

function TemplateDialog({ section, kind, t, base, canShared, onCopy, onClose }: {
  section: Section; kind: 'template' | 'phrase'; t: ReportTemplate | null; base: ReportTemplate | null; canShared: boolean; onCopy: () => void; onClose: () => void;
}) {
  const qc = useQueryClient();
  const readOnly = !!t && !t.owner_id && !canShared;
  const [f, setF] = useState({
    name: t ? t.name : base ? `${base.name} (ასლი)` : '', modality: base?.modality ?? '', service_id: base?.service_id ?? '',
    technique: base?.technique ?? '', findings: base?.findings ?? '', impression: base?.impression ?? '', recommendation: base?.recommendation ?? '',
    target: base?.target ?? 'findings', body: base?.body ?? '', is_active: base?.is_active ?? true, sort_order: base?.sort_order ?? 0,
  });
  const [shared, setShared] = useState(false);
  const cat = useQuery({ queryKey: ['dx-catalog', section], queryFn: () => api<DxService[]>('/dx/catalog', { query: { section } }), staleTime: 60_000, enabled: kind === 'template' });
  const services = (cat.data ?? []).filter((s) => !f.modality || s.modality === f.modality);
  const m = useMutation({
    mutationFn: () => {
      const body = { section, kind, ...f, modality: f.modality || null, service_id: f.service_id || null, ...(t ? {} : { shared }) };
      return t ? api(`/dx/report-templates/${t.id}`, { method: 'PATCH', body }) : api('/dx/report-templates', { body });
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['report-templates'] }); onClose(); },
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const title = t ? t.name : kind === 'template' ? 'ახალი შაბლონი' : 'ახალი ფრაზა';
  return (
    <Modal title={title} onClose={onClose} width={860}
      footer={<>
        {t && <button className="btn" type="button" onClick={onCopy}>ასლი — ჩემს შაბლონებში</button>}
        <span className="grow" />
        <button className="btn" type="button" onClick={onClose}>დახურვა</button>
        {!readOnly && <button className="btn primary" type="submit" form="tplf" disabled={m.isPending || f.name.trim().length < 2}>შენახვა</button>}
      </>}>
      {readOnly && <div className="alert info small">საერთო შაბლონი — ცვლის განყოფილების ხელმძღვანელი. შეგიძლიათ შექმნათ პირადი ასლი.</div>}
      <form id="tplf" onSubmit={(e) => { e.preventDefault(); m.mutate(); }} style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
        <div style={{ gridColumn: 'span 2' }}><Field label="დასახელება" htmlFor="tn" required><input id="tn" className="input" value={f.name} onChange={set('name')} disabled={readOnly} /></Field></div>
        {section === 'radiology' ? <Field label="მოდალობა" htmlFor="tm"><select id="tm" className="select" value={f.modality} onChange={(e) => setF({ ...f, modality: e.target.value, service_id: '' })} disabled={readOnly}>
          <option value="">ნებისმიერი</option>{MODS.map((x) => <option key={x} value={x}>{MODALITY_KA[x]}</option>)}</select></Field> : <span />}
        {kind === 'template' ? <>
          <div style={{ gridColumn: '1 / -1' }}><Field label="კვლევა (არასავალდებულო)" htmlFor="ts" hint="თუ არჩეულია — შაბლონი მხოლოდ ამ კვლევაზე გამოჩნდება">
            <select id="ts" className="select" value={f.service_id} onChange={set('service_id')} disabled={readOnly}><option value="">ყველა {f.modality ? MODALITY_KA[f.modality] : ''} კვლევა</option>{services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
          </Field></div>
          {REPORT_FIELDS.map(([k, l]) => (
            <div key={k} style={{ gridColumn: '1 / -1' }}>
              <Field label={l} htmlFor={`t-${k}`}><textarea id={`t-${k}`} className="textarea" rows={k === 'findings' ? 8 : 2} value={f[k]} onChange={set(k)} readOnly={readOnly} style={{ fontSize: 14 }} /></Field>
            </div>))}
        </> : <>
          <Field label="ველი" htmlFor="tt"><select id="tt" className="select" value={f.target} onChange={set('target')} disabled={readOnly}>{REPORT_FIELDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          <div style={{ gridColumn: '1 / -1' }}><Field label="ტექსტი" htmlFor="tb" required><textarea id="tb" className="textarea" rows={4} value={f.body} onChange={set('body')} readOnly={readOnly} style={{ fontSize: 14 }} /></Field></div>
        </>}
        {!t && canShared && <label className="row" style={{ gridColumn: '1 / -1' }}><input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} /> საერთო — ხელმისაწვდომი ყველა {section === 'radiology' ? 'რადიოლოგისთვის' : 'ენდოსკოპისტისთვის'}</label>}
        {t && !readOnly && <label className="row" style={{ gridColumn: '1 / -1' }}><input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> აქტიური</label>}
        <div style={{ gridColumn: '1 / -1' }}><ErrorBox error={m.error} /></div>
      </form>
    </Modal>
  );
}
