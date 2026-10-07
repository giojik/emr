import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../api/client';
import { ErrorBox, Field, Loading, Modal, useToast } from '../../components/ui';
import { tsDate } from '../../lib/format';

type Kind = 'consent' | 'refusal' | 'epicrisis' | 'other';
type Block =
  | { type: 'header' } | { type: 'patient' } | { type: 'heading'; text: string } | { type: 'text'; text: string }
  | { type: 'diagnoses'; which: 'final' | 'admission'; label: string } | { type: 'field'; key: string; label: string; required?: boolean; prefill?: string }
  | { type: 'lab_results'; label: string } | { type: 'dx_results'; label: string } | { type: 'signatures'; signers: ('attending' | 'department_head' | 'patient')[] };
interface ListItem { code: string; kind: Kind; name: string; scope: string; required_on_admission: boolean; is_system: boolean; is_active: boolean; sort_order: number;
  published_version: number | null; text_approved: boolean | null; published_at: string | null; draft_version: number | null }
interface Version { id: string; version: number; status: 'draft' | 'published' | 'archived'; body: { blocks: Block[] }; text_approved: boolean; change_note: string | null;
  created_at: string; published_at: string | null; created_by_name: string | null; published_by_name: string | null }
interface Detail extends Omit<ListItem, 'published_version' | 'text_approved' | 'published_at' | 'draft_version'> { versions: Version[]; draft_errors: string[] }
interface Variable { key: string; label: string; sample: string }

const KIND_KA: Record<Kind, string> = { consent: 'თანხმობა', refusal: 'ხელწერილი / უარი', epicrisis: 'ეპიკრიზი', other: 'სხვა დოკუმენტი' };
const ALLOWED: Record<Kind, Block['type'][]> = {
  consent: ['heading', 'text'], refusal: ['heading', 'text'], other: ['header', 'heading', 'text', 'patient', 'signatures'],
  epicrisis: ['header', 'heading', 'text', 'patient', 'diagnoses', 'field', 'lab_results', 'dx_results', 'signatures'],
};
const BLOCK_KA: Record<Block['type'], string> = { header: 'სათაური: დაწესებულება + № + QR', heading: 'სათაური', text: 'ტექსტი', patient: 'პაციენტის რეკვიზიტები', diagnoses: 'დიაგნოზები',
  field: 'შესავსები სექცია (ექიმი)', lab_results: 'ლაბ. შედეგები (ცხრილი)', dx_results: 'რადიოლოგია / ენდოსკოპია', signatures: 'ხელმოწერები' };
const SIGNER_KA = { attending: 'მკურნალი ექიმი', department_head: 'განყოფილების ხელმძღვანელი', patient: 'პაციენტი' } as const;
const newBlock = (t: Block['type']): Block => ({
  header: { type: 'header' }, patient: { type: 'patient' }, heading: { type: 'heading', text: '' }, text: { type: 'text', text: '' },
  diagnoses: { type: 'diagnoses', which: 'final', label: 'საბოლოო კლინიკური დიაგნოზი' }, field: { type: 'field', key: '', label: '', required: false },
  lab_results: { type: 'lab_results', label: 'ჩატარებული გამოკვლევები — ლაბორატორია' }, dx_results: { type: 'dx_results', label: 'ჩატარებული გამოკვლევები — რადიოლოგია / ენდოსკოპია' },
  signatures: { type: 'signatures', signers: ['attending'] },
} as Record<Block['type'], Block>)[t];

/** ადმინისტრირება → დოკუმენტების შაბლონები (0041): ეპიკრიზი, თანხმობები, ხელწერილი; ვერსიები, ცვლადები, PDF preview */
export default function DocumentTemplates() {
  const list = useQuery({ queryKey: ['doc-templates'], queryFn: () => api<ListItem[]>('/document-templates', { query: { all: true } }) });
  const [sel, setSel] = useState<string | null>(null); const [creating, setCreating] = useState(false);
  useEffect(() => { if (!sel && list.data?.length) setSel(list.data.find((t) => t.kind === 'epicrisis')?.code ?? list.data[0].code); }, [list.data, sel]);
  return (
    <div className="content">
      <div className="row"><h2 style={{ margin: 0 }} className="grow">დოკუმენტების შაბლონები</h2><button className="btn primary" type="button" onClick={() => setCreating(true)}>+ ახალი შაბლონი</button></div>
      <ErrorBox error={list.error} />
      <div style={{ display: 'grid', gridTemplateColumns: '280px minmax(0, 1fr)', gap: 14, alignItems: 'start' }}>
        <div className="card">{list.isLoading ? <Loading /> : (['epicrisis', 'consent', 'refusal', 'other'] as Kind[]).map((k) => {
          const xs = (list.data ?? []).filter((t) => t.kind === k); if (!xs.length) return null;
          return <div key={k}><div className="small muted" style={{ padding: '10px 12px 4px' }}>{KIND_KA[k]}</div>
            {xs.map((t) => <button key={t.code} type="button" className="row" onClick={() => setSel(t.code)}
              style={{ width: '100%', textAlign: 'left', padding: '8px 12px', border: 0, background: sel === t.code ? 'var(--surface-2)' : 'transparent', cursor: 'pointer', gap: 6, opacity: t.is_active ? 1 : 0.55 }}>
              <span className="grow">{t.name}</span>
              {t.draft_version && <span className="chip warn" title="გამოუქვეყნებელი draft">v{t.draft_version}*</span>}
              {t.published_version ? <span className="chip">v{t.published_version}</span> : <span className="chip danger">—</span>}
            </button>)}</div>;
        })}</div>
        {sel ? <Editor key={sel} code={sel} /> : <div className="card empty">აირჩიეთ შაბლონი</div>}
      </div>
      {creating && <CreateDialog onClose={() => setCreating(false)} onCreated={(c) => { setSel(c); setCreating(false); }} />}
    </div>
  );
}

function Editor({ code }: { code: string }) {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['doc-template', code], queryFn: () => api<Detail>(`/document-templates/${code}`) });
  const vars = useQuery({ queryKey: ['doc-template-vars'], queryFn: () => api<Variable[]>('/document-templates/variables'), staleTime: Infinity });
  const t = q.data;
  const draft = t?.versions.find((v) => v.status === 'draft'); const pub = t?.versions.find((v) => v.status === 'published');
  const [blocks, setBlocks] = useState<Block[]>([]); const [approved, setApproved] = useState(false); const [note, setNote] = useState(''); const [dirty, setDirty] = useState(false);
  const focus = useRef<{ i: number; el: HTMLTextAreaElement | HTMLInputElement } | null>(null);
  useEffect(() => {
    const v = draft ?? pub; if (!v) return;
    setBlocks(v.body.blocks); setApproved(v.text_approved); setNote(draft?.change_note ?? ''); setDirty(false);
  }, [draft?.id, pub?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const inval = () => { void qc.invalidateQueries({ queryKey: ['doc-template', code] }); void qc.invalidateQueries({ queryKey: ['doc-templates'] }); void qc.invalidateQueries({ queryKey: ['consent-types'] }); };
  const save = useMutation({ mutationFn: () => api(`/document-templates/${code}/draft`, { method: 'PUT', body: { body: { blocks }, text_approved: approved, change_note: note || undefined } }),
    onSuccess: () => { setDirty(false); toast.show('draft შენახულია'); inval(); } });
  const publish = useMutation({ mutationFn: async () => { if (dirty) await api(`/document-templates/${code}/draft`, { method: 'PUT', body: { body: { blocks }, text_approved: approved, change_note: note || undefined } });
    return api(`/document-templates/${code}/publish`, { body: { change_note: note || undefined } }); }, onSuccess: () => { toast.show('გამოქვეყნდა'); inval(); } });
  const discard = useMutation({ mutationFn: () => api(`/document-templates/${code}/draft`, { method: 'DELETE' }), onSuccess: () => { toast.show('draft წაიშალა'); inval(); } });
  const patch = useMutation({ mutationFn: (b: Record<string, unknown>) => api(`/document-templates/${code}`, { method: 'PATCH', body: b }), onSuccess: inval });
  const preview = useMutation({ mutationFn: async () => {
    const blob = await api<Blob>(`/document-templates/${code}/preview`, { body: { body: { blocks } }, raw: true });
    const url = URL.createObjectURL(blob); window.open(url, '_blank'); setTimeout(() => URL.revokeObjectURL(url), 60_000); } });

  if (q.isLoading) return <div className="card card-pad"><Loading /></div>;
  if (!t) return <div className="card card-pad"><ErrorBox error={q.error} /></div>;
  const upd = (i: number, b: Partial<Block>) => { setBlocks(blocks.map((x, j) => (j === i ? ({ ...x, ...b } as Block) : x))); setDirty(true); };
  const move = (i: number, d: number) => { const n = [...blocks]; const [x] = n.splice(i, 1); n.splice(i + d, 0, x); setBlocks(n); setDirty(true); };
  const insertVar = (k: string) => {
    const f = focus.current; const tok = `{{${k}}}`;
    if (!f) { void navigator.clipboard?.writeText(tok); toast.show(`${tok} — დაკოპირდა`); return; }
    const b = blocks[f.i] as { text?: string; prefill?: string }; const prop = 'text' in b ? 'text' : 'prefill';
    const cur = (b[prop as 'text'] ?? '') as string; const p = f.el.selectionStart ?? cur.length;
    upd(f.i, { [prop]: cur.slice(0, p) + tok + cur.slice(p) } as Partial<Block>);
  };
  const err = save.error ?? publish.error ?? discard.error ?? patch.error ?? preview.error;
  const apiErrors = err instanceof ApiError ? (err.body?.errors as string[] | undefined) : undefined;
  const bodyChanged = dirty || !!draft;

  return (
    <div className="stack">
      {toast.node}
      <section className="card card-pad stack" style={{ gap: 10 }}>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0 }} className="grow">{t.name} <span className="small muted mono">{t.code}</span></h3>
          <span className="chip">{KIND_KA[t.kind]}</span>{t.is_system && <span className="chip info">სისტემური</span>}
          {pub ? <span className="chip ok">გამოქვეყნებული v{pub.version}</span> : <span className="chip danger">არ არის გამოქვეყნებული</span>}
          {draft && <span className="chip warn">draft v{draft.version}</span>}
        </div>
        <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
          <label className="row"><input type="checkbox" checked={t.is_active} disabled={t.is_system} onChange={(e) => patch.mutate({ is_active: e.target.checked })} /> აქტიური</label>
          {t.kind === 'consent' && <label className="row"><input type="checkbox" checked={t.required_on_admission} onChange={(e) => patch.mutate({ required_on_admission: e.target.checked })} /> სავალდებულო ჰოსპიტალიზაციისას <span className="small muted">(გაფრთხილება დაფაზე)</span></label>}
          <button className="btn sm" type="button" onClick={() => { const n = window.prompt('დასახელება', t.name); if (n && n.trim().length >= 3) patch.mutate({ name: n.trim() }); }}>გადარქმევა</button>
        </div>
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 260px', gap: 14, alignItems: 'start' }}>
        <section className="card">
          <div className="card-head" style={{ flexWrap: 'wrap', gap: 8 }}>
            <h3 style={{ margin: 0 }} className="grow">{draft ? `draft v${draft.version}` : `v${pub?.version ?? '—'} (გამოქვეყნებული — ცვლილება ქმნის ახალ ვერსიას)`}</h3>
            <button className="btn sm" type="button" disabled={preview.isPending} onClick={() => preview.mutate()}>PDF ნიმუში</button>
            {bodyChanged && <button className="btn sm" type="button" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>draft-ის შენახვა</button>}
            {bodyChanged && <button className="btn sm primary" type="button" disabled={publish.isPending}
              onClick={() => window.confirm('გამოქვეყნება? ახალი დოკუმენტები ამ ვერსიით შეიქმნება; უკვე გაცემული — ძველ ვერსიაზე რჩება.') && publish.mutate()}>გამოქვეყნება</button>}
            {draft && pub && <button className="btn sm" type="button" onClick={() => window.confirm('draft წაიშალოს?') && discard.mutate()}>draft-ის წაშლა</button>}
          </div>
          <div className="card-pad stack" style={{ gap: 10 }}>
            {(t.draft_errors.length > 0 || apiErrors) && <div className="alert warn">{(apiErrors ?? t.draft_errors).map((e) => <div key={e}>{e}</div>)}</div>}
            {!apiErrors && <ErrorBox error={err} />}
            {blocks.map((b, i) => (
              <div key={i} className="card" style={{ padding: 10, background: 'var(--surface-2)' }}>
                <div className="row" style={{ gap: 6 }}><strong className="grow small">{i + 1}. {BLOCK_KA[b.type]}</strong>
                  <button className="btn sm" type="button" disabled={i === 0} onClick={() => move(i, -1)} aria-label="ზემოთ">↑</button>
                  <button className="btn sm" type="button" disabled={i === blocks.length - 1} onClick={() => move(i, 1)} aria-label="ქვემოთ">↓</button>
                  <button className="btn sm" type="button" onClick={() => { setBlocks(blocks.filter((_, j) => j !== i)); setDirty(true); }} aria-label="წაშლა">×</button></div>
                {(b.type === 'heading' || b.type === 'text') && <textarea className="textarea" rows={b.type === 'text' ? 5 : 1} value={b.text} style={{ marginTop: 6 }}
                  onFocus={(e) => { focus.current = { i, el: e.currentTarget }; }} onSelect={(e) => { focus.current = { i, el: e.currentTarget }; }} onChange={(e) => upd(i, { text: e.target.value })} />}
                {b.type === 'field' && <div className="stack" style={{ gap: 6, marginTop: 6 }}>
                  <div className="row" style={{ gap: 8 }}>
                    <input className="input mono" style={{ maxWidth: 180 }} placeholder="გასაღები (latin)" value={b.key} onChange={(e) => upd(i, { key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') })} />
                    <input className="input grow" placeholder="სექციის სათაური" value={b.label} onChange={(e) => upd(i, { label: e.target.value })} />
                    <label className="row small"><input type="checkbox" checked={!!b.required} onChange={(e) => upd(i, { required: e.target.checked })} /> სავალდებულო</label></div>
                  <input className="input" placeholder="წინასწარ შევსება (არასავალდებულო, ცვლადებით)" value={b.prefill ?? ''}
                    onFocus={(e) => { focus.current = { i, el: e.currentTarget }; }} onChange={(e) => upd(i, { prefill: e.target.value || undefined })} />
                </div>}
                {b.type === 'diagnoses' && <div className="row" style={{ gap: 8, marginTop: 6 }}>
                  <select className="select" style={{ maxWidth: 200 }} value={b.which} onChange={(e) => upd(i, { which: e.target.value as 'final' | 'admission' })}>
                    <option value="final">საბოლოო</option><option value="admission">შემოსვლისას</option></select>
                  <input className="input grow" value={b.label} onChange={(e) => upd(i, { label: e.target.value })} /></div>}
                {(b.type === 'lab_results' || b.type === 'dx_results') && <input className="input" style={{ marginTop: 6 }} value={b.label} onChange={(e) => upd(i, { label: e.target.value })} />}
                {b.type === 'signatures' && <div className="row" style={{ gap: 14, marginTop: 6 }}>{(Object.keys(SIGNER_KA) as (keyof typeof SIGNER_KA)[]).map((k) => (
                  <label key={k} className="row small"><input type="checkbox" checked={b.signers.includes(k)}
                    onChange={(e) => upd(i, { signers: e.target.checked ? [...b.signers, k] : b.signers.filter((x) => x !== k) })} /> {SIGNER_KA[k]}</label>))}</div>}
              </div>))}
            <div className="row" style={{ gap: 8 }}>
              <select className="select" style={{ maxWidth: 320 }} aria-label="ბლოკის დამატება" value="" onChange={(e) => { if (e.target.value) { setBlocks([...blocks, newBlock(e.target.value as Block['type'])]); setDirty(true); } }}>
                <option value="">+ ბლოკის დამატება…</option>{ALLOWED[t.kind].map((k) => <option key={k} value={k}>{BLOCK_KA[k]}</option>)}</select>
            </div>
            {(t.kind === 'consent' || t.kind === 'refusal') && <label className="row"><input type="checkbox" checked={approved} onChange={(e) => { setApproved(e.target.checked); setDirty(true); }} /> ტექსტი დამტკიცებულია (იურისტი) <span className="small muted">— სხვაგვარად PDF-ზე ჭვირნიშანი</span></label>}
            <Field label="ცვლილების აღწერა" htmlFor="tpl-note"><input id="tpl-note" className="input" value={note} onChange={(e) => { setNote(e.target.value); setDirty(true); }} /></Field>
          </div>
        </section>
        <section className="card" style={{ position: 'sticky', top: 10 }}>
          <div className="card-head"><h3 style={{ margin: 0 }}>ცვლადები</h3></div>
          <div className="card-pad stack" style={{ gap: 4, maxHeight: 520, overflow: 'auto' }}>
            <span className="small muted">დააჭირეთ — ჩაისმება ბოლოს არჩეულ ტექსტში (კურსორთან).</span>
            {vars.data?.map((v) => <button key={v.key} type="button" className="btn sm" style={{ justifyContent: 'flex-start', textAlign: 'left', height: 'auto', padding: '4px 8px', whiteSpace: 'normal', overflowWrap: 'anywhere', width: '100%' }} title={`ნიმუში: ${v.sample}`} onClick={() => insertVar(v.key)}>
              <span className="stack" style={{ gap: 0 }}><span className="mono small">{`{{${v.key}}}`}</span><span className="small muted">{v.label}</span></span></button>)}
          </div>
        </section>
      </div>

      <section className="card">
        <div className="card-head"><h3 style={{ margin: 0 }}>ვერსიები</h3></div>
        <table className="table"><thead><tr><th>ვერსია</th><th>სტატუსი</th><th>შეიქმნა</th><th>გამოქვეყნდა</th><th>აღწერა</th></tr></thead>
          <tbody>{t.versions.map((v) => <tr key={v.id}><td className="mono">v{v.version}</td>
            <td><span className={`chip ${v.status === 'published' ? 'ok' : v.status === 'draft' ? 'warn' : ''}`}>{{ draft: 'draft', published: 'გამოქვეყნებული', archived: 'არქივი' }[v.status]}</span>{v.text_approved && (t.kind === 'consent' || t.kind === 'refusal') && <span className="chip info">დამტკიცებული</span>}</td>
            <td className="small">{tsDate(v.created_at)} {v.created_by_name}</td><td className="small">{v.published_at ? `${tsDate(v.published_at)} ${v.published_by_name ?? ''}` : '—'}</td><td className="small">{v.change_note ?? ''}</td></tr>)}</tbody></table>
      </section>
    </div>
  );
}

function CreateDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (code: string) => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ code: '', kind: 'consent' as Kind, name: '', scope: 'encounter', required_on_admission: false });
  const m = useMutation({ mutationFn: () => api<{ code: string }>('/document-templates', { body: f }), onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ['doc-templates'] }); onCreated(r.code); } });
  return (
    <Modal title="ახალი შაბლონი" onClose={onClose} width={520}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={m.isPending || f.code.length < 2 || f.name.trim().length < 3} onClick={() => m.mutate()}>შექმნა</button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <Field label="კოდი" htmlFor="nt-c" required hint="ლათინური დიდი ასოები, ციფრები, _ (მაგ. BLOOD_TRANSFUSION)"><input id="nt-c" className="input mono" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '') })} /></Field>
        <Field label="სახეობა" htmlFor="nt-k"><select id="nt-k" className="select" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as Kind })}>
          {(['consent', 'refusal', 'other'] as Kind[]).map((k) => <option key={k} value={k}>{KIND_KA[k]}</option>)}</select></Field>
        <Field label="დასახელება" htmlFor="nt-n" required><input id="nt-n" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="მოქმედება" htmlFor="nt-s"><select id="nt-s" className="select" value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value })}>
          <option value="encounter">ვიზიტზე / ჰოსპიტალიზაციაზე</option><option value="patient">პაციენტზე (ერთხელ)</option></select></Field>
        {f.kind === 'consent' && <label className="row"><input type="checkbox" checked={f.required_on_admission} onChange={(e) => setF({ ...f, required_on_admission: e.target.checked })} /> სავალდებულო ჰოსპიტალიზაციისას</label>}
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}
