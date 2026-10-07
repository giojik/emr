import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { api, openBlob } from '../../api/client';
import type { IcdCode } from '../../api/types';
import { ErrorBox, Field, Loading, useToast } from '../../components/ui';
import { tsDate } from '../../lib/format';
import IcdPicker from '../encounter/IcdPicker';
import { invalIpd, ReasonDialog } from './Inpatient';

type Block = { type: string; key?: string; label?: string; required?: boolean; text?: string; which?: string };
interface DxItem { code: string; title: string }
interface LabSrc { id: string; date: string; test: string; value: string; unit: string | null; ref: string | null; flag: string | null; default: boolean }
interface DxSrc { id: string; section: string; date: string; title: string; conclusion: string | null; default: boolean }
interface EpicrisisResp {
  epicrisis: null | {
    id: string; status: 'draft' | 'awaiting_cosign' | 'signed'; revision: number; content: Record<string, string>; selected_lab_ids: string[]; selected_dx_ids: string[];
    signed_at: string | null; cosigned_at: string | null; signed_by_name: string | null; cosigned_by_name: string | null; created_by_name: string | null;
    document_number: string | null; document_has_discharge_date: boolean | null;
  };
  template: { version: number; blocks: Block[] } | null;
  sources: { lab: LabSrc[]; dx: DxSrc[] };
  diagnoses: { admission: DxItem[]; final: { primary: DxItem[]; secondary: DxItem[]; complication: DxItem[] } };
  revisions: { revision: number; signed_at: string; reopened_at: string; reopen_reason: string; document_number: string | null; reopened_by_name: string | null }[];
  cosign_required?: boolean; missing?: string[];
  can: { create: boolean; edit: boolean; sign: boolean; cosign: boolean; reopen: boolean };
}
export interface StayDx { id: string; icd10_code: string; icd10_title: string; diagnosis_type: string }

const ST: Record<string, [string, string]> = { draft: ['warn', 'პროექტი'], awaiting_cosign: ['info', 'თანახელმოწერის მოლოდინში'], signed: ['ok', 'ხელმოწერილი'] };
const DX_TYPES: [string, string][] = [['primary', 'ძირითადი'], ['secondary', 'თანმხლები'], ['complication', 'გართულება']];

/**
 * ეპიკრიზი (0041): საბოლოო დიაგნოზი (ჰოსპიტალიზაციის primary / secondary / complication), შაბლონის სექციები,
 * შედეგების არჩევა, preview, ხელმოწერა / თანახელმოწერა, ხელახლა გახსნა (მიზეზით), ხელმოწერილი PDF (№ + QR).
 */
export default function EpicrisisPanel({ encounterId, diagnoses, encounterActive }: { encounterId: string; diagnoses: StayDx[]; encounterActive: boolean }) {
  const qc = useQueryClient(); const toast = useToast();
  const key = ['ipd-epicrisis', encounterId];
  const q = useQuery({ queryKey: key, queryFn: () => api<EpicrisisResp>(`/inpatient/stays/${encounterId}/epicrisis`) });
  const d = q.data; const e = d?.epicrisis;
  const [content, setContent] = useState<Record<string, string>>({});
  const [lab, setLab] = useState<Set<string>>(new Set());
  const [dx, setDx] = useState<Set<string>>(new Set());
  const [dirty, setDirty] = useState(false);
  const [reopen, setReopen] = useState(false);
  const [dxType, setDxType] = useState('primary');
  useEffect(() => {
    if (!e) return;
    setContent(e.content ?? {}); setLab(new Set(e.selected_lab_ids)); setDx(new Set(e.selected_dx_ids)); setDirty(false);
  }, [e?.id, e?.revision, e?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  const refresh = () => { void qc.invalidateQueries({ queryKey: key }); invalIpd(qc); };
  const create = useMutation({ mutationFn: () => api(`/inpatient/stays/${encounterId}/epicrisis`, { body: {} }), onSuccess: refresh });
  const save = useMutation({
    mutationFn: () => api(`/inpatient/stays/${encounterId}/epicrisis`, { method: 'PUT', body: { content, selected_lab_ids: [...lab], selected_dx_ids: [...dx] } }),
    onSuccess: () => { setDirty(false); toast.show('შენახულია'); refresh(); },
  });
  const act = useMutation({
    mutationFn: async (a: 'sign' | 'cosign') => { if (dirty && a === 'sign') await api(`/inpatient/stays/${encounterId}/epicrisis`, { method: 'PUT', body: { content, selected_lab_ids: [...lab], selected_dx_ids: [...dx] } });
      return api(`/inpatient/stays/${encounterId}/epicrisis/${a}`, { body: {} }); },
    onSuccess: () => { toast.show('ხელმოწერილია'); refresh(); },
  });
  const addDx = useMutation({ mutationFn: (c: IcdCode) => api(`/encounters/${encounterId}/diagnoses`, { body: { icd10_code: c.code, diagnosis_type: dxType } }), onSuccess: refresh });
  const delDx = useMutation({ mutationFn: (id: string) => api(`/encounters/${encounterId}/diagnoses/${id}`, { method: 'DELETE' }), onSuccess: refresh });
  const fields = useMemo(() => (d?.template?.blocks ?? []).filter((b) => b.type === 'field'), [d?.template]);
  const finalDx = diagnoses.filter((x) => x.diagnosis_type !== 'admission');
  const hasPrimary = finalDx.some((x) => x.diagnosis_type === 'primary');

  if (q.isLoading) return <section className="card card-pad"><Loading /></section>;
  if (!d) return <section className="card card-pad"><ErrorBox error={q.error} /></section>;
  const edit = !!e && d.can.edit;
  const err = save.error ?? act.error ?? create.error ?? addDx.error ?? delDx.error;

  return (
    <section className="card">
      {toast.node}
      <div className="card-head" style={{ flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0 }}>ეპიკრიზი</h2>
        {e && <span className={`chip ${ST[e.status][0]}`}>{ST[e.status][1]}</span>}
        {e?.document_number && <span className="mono small">№ {e.document_number}</span>}
        {e && e.revision > 1 && <span className="small muted">რედაქცია {e.revision}</span>}
        <span className="grow" />
        {e && <button className="btn sm" type="button" onClick={() => openBlob(`/inpatient/stays/${encounterId}/epicrisis/preview`).catch(() => undefined)}>გადახედვა</button>}
        {e?.document_number && <button className="btn sm" type="button" onClick={() => openBlob(`/inpatient/stays/${encounterId}/epicrisis/pdf`).catch(() => undefined)}>PDF</button>}
        {edit && <button className="btn sm" type="button" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>შენახვა</button>}
        {d.can.sign && <button className="btn sm primary" type="button" disabled={act.isPending}
          onClick={() => window.confirm(d.cosign_required ? 'ხელს აწერთ ეპიკრიზს? შემდეგ — განყოფილების ხელმძღვანელის თანახელმოწერა.' : 'ხელს აწერთ ეპიკრიზს? გაიცემა № და PDF; შესწორება — მხოლოდ ხელახლა გახსნით.') && act.mutate('sign')}>ხელმოწერა</button>}
        {d.can.cosign && <button className="btn sm primary" type="button" disabled={act.isPending} onClick={() => act.mutate('cosign')}>თანახელმოწერა</button>}
        {d.can.reopen && <button className="btn sm" type="button" onClick={() => setReopen(true)}>ხელახლა გახსნა</button>}
      </div>
      <div className="card-pad stack" style={{ gap: 14 }}>
        <ErrorBox error={err} />
        {!e ? (
          <div className="row">{d.can.create
            ? <button className="btn primary" type="button" disabled={create.isPending} onClick={() => create.mutate()}>ეპიკრიზის შექმნა</button>
            : <span className="muted">ეპიკრიზი ჯერ არ არის შექმნილი.</span>}
            <span className="small muted">სექციები — „ეპიკრიზის“ შაბლონიდან (ადმინისტრირება → დოკუმენტების შაბლონები).</span></div>
        ) : <>
          {(d.missing?.length ?? 0) > 0 && e.status === 'draft' && <div className="alert warn">ხელმოწერამდე: {d.missing!.join('; ')}</div>}
          {e.status !== 'draft' && e.document_has_discharge_date === false && <div className="alert info">ეპიკრიზი ხელმოწერილია გაწერამდე — PDF-ში გაწერის თარიღი არ არის. საჭიროებისას გახსენით ხელახლა და გაწერისას გამოიყენეთ „ხელმოწერა და გაწერა“.</div>}
          {e.signed_by_name && <div className="small">ხელმოწერა: <strong>{e.signed_by_name}</strong> {e.signed_at && tsDate(e.signed_at)}{e.cosigned_by_name && <> · თანახელმოწერა: <strong>{e.cosigned_by_name}</strong> {e.cosigned_at && tsDate(e.cosigned_at)}</>}</div>}

          <div className="stack" style={{ gap: 6 }}>
            <span className="label">საბოლოო კლინიკური დიაგნოზი</span>
            {finalDx.length === 0 && <span className="small muted">— (საჭიროა ზუსტად ერთი ძირითადი)</span>}
            {finalDx.map((x) => <div key={x.id} className="row small" style={{ gap: 8 }}>
              <span className={`chip ${x.diagnosis_type === 'primary' ? 'info' : ''}`}>{DX_TYPES.find(([k]) => k === x.diagnosis_type)?.[1]}</span><span className="mono">{x.icd10_code}</span> {x.icd10_title}
              {edit && encounterActive && <button className="btn sm" type="button" aria-label="წაშლა" onClick={() => delDx.mutate(x.id)}>×</button>}</div>)}
            {edit && encounterActive && <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
              <select className="select" style={{ maxWidth: 160, height: 40 }} aria-label="დიაგნოზის ტიპი" value={dxType} onChange={(ev) => setDxType(ev.target.value)}>
                {DX_TYPES.filter(([k]) => k !== 'primary' || !hasPrimary).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
              <IcdPicker primary={dxType === 'primary'} onPick={(c) => addDx.mutate(c)} disabled={addDx.isPending} />
            </div>}
          </div>

          {fields.map((f) => (
            <Field key={f.key} label={f.label ?? f.key!} htmlFor={`ep-${f.key}`} required={f.required}>
              <textarea id={`ep-${f.key}`} className="textarea" rows={f.key === 'course' || f.key === 'treatment' ? 5 : 3} readOnly={!edit} value={content[f.key!] ?? ''}
                onChange={(ev) => { setContent({ ...content, [f.key!]: ev.target.value }); setDirty(true); }} />
            </Field>))}

          <details open={edit && d.sources.lab.length > 0}>
            <summary className="label" style={{ cursor: 'pointer' }}>ლაბორატორიული შედეგები ({lab.size} / {d.sources.lab.length})</summary>
            {d.sources.lab.length === 0 ? <span className="small muted">ვალიდირებული შედეგი არ არის.</span> : (
              <table className="table"><thead><tr><th /><th>თარიღი</th><th>კვლევა</th><th>შედეგი</th><th>ნორმა</th></tr></thead>
                <tbody>{d.sources.lab.map((r) => (
                  <tr key={r.id}><td><input type="checkbox" aria-label={r.test} disabled={!edit} checked={lab.has(r.id)} onChange={(ev) => { const n = new Set(lab); if (ev.target.checked) n.add(r.id); else n.delete(r.id); setLab(n); setDirty(true); }} /></td>
                    <td className="small">{r.date}</td><td>{r.test}</td>
                    <td className="mono" style={r.flag ? { color: 'var(--danger)', fontWeight: 600 } : undefined}>{r.value} {r.unit ?? ''} {r.flag ?? ''}</td><td className="small muted">{r.ref ?? ''}</td></tr>))}</tbody></table>)}
            {edit && d.sources.lab.length > 0 && <div className="row" style={{ gap: 8 }}>
              <button className="btn sm" type="button" onClick={() => { setLab(new Set(d.sources.lab.filter((r) => r.default).map((r) => r.id))); setDirty(true); }}>ნაგულისხმევი (ბოლო + გადახრილი)</button>
              <button className="btn sm" type="button" onClick={() => { setLab(new Set()); setDirty(true); }}>არცერთი</button></div>}
          </details>
          <details open={edit && d.sources.dx.length > 0}>
            <summary className="label" style={{ cursor: 'pointer' }}>რადიოლოგია / ენდოსკოპია ({dx.size} / {d.sources.dx.length})</summary>
            {d.sources.dx.length === 0 ? <span className="small muted">ხელმოწერილი დასკვნა არ არის.</span> : d.sources.dx.map((r) => (
              <label key={r.id} className="row small" style={{ alignItems: 'flex-start' }}>
                <input type="checkbox" disabled={!edit} checked={dx.has(r.id)} onChange={(ev) => { const n = new Set(dx); if (ev.target.checked) n.add(r.id); else n.delete(r.id); setDx(n); setDirty(true); }} />
                <span><strong>{r.date} · {r.title}</strong>{r.conclusion && <div className="muted">{r.conclusion}</div>}</span></label>))}
          </details>

          {d.revisions.length > 0 && <details>
            <summary className="label" style={{ cursor: 'pointer' }}>წინა რედაქციები ({d.revisions.length})</summary>
            <table className="table"><tbody>{d.revisions.map((r) => (
              <tr key={r.revision}><td>რედ. {r.revision}</td><td className="mono small">{r.document_number ?? '—'} <span className="chip">გაუქმებული</span></td>
                <td className="small">გაიხსნა {tsDate(r.reopened_at)} · {r.reopened_by_name}</td><td className="small">{r.reopen_reason}</td></tr>))}</tbody></table>
          </details>}
        </>}
      </div>
      {reopen && <ReasonDialog title="ეპიკრიზის ხელახლა გახსნა" danger={false} path={`/inpatient/stays/${encounterId}/epicrisis/reopen`}
        onClose={() => setReopen(false)} onDone={refresh} />}
    </section>
  );
}
