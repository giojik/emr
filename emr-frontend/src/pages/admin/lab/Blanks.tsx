import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../../api/client';
import type { DxService } from '../../../api/types';
import { ErrorBox, Field, Loading, Modal, useDebounced, useToast } from '../../../components/ui';
import { tsDate } from '../../../lib/format';
import { useLabPermissions } from './common';

// ============================================================ ტიპები (ემთხვევა backend-ის lab-blank.settings.ts-ს)
type PatientField = 'personal_number' | 'birth_date' | 'age' | 'gender' | 'phone' | 'ordered_by' | 'referral' | 'pregnancy';
type Column = 'unit' | 'reference' | 'flag' | 'method' | 'previous';
interface BlankSettings {
  paper: 'A4' | 'A5'; margin_mm: number; font_size: number; accent_color: string;
  header: { logo_image_id: string | null; logo_position: 'left' | 'center' | 'right'; logo_height_mm: number; show_clinic: boolean; extra_lines: string[]; title: string; subtitle: string };
  patient_fields: PatientField[]; layout: 'table' | 'two_column' | 'text'; group_headers: boolean; columns: Column[];
  flag_style: 'words' | 'arrows' | 'letters'; highlight_abnormal: boolean; show_sample_info: boolean; show_service_comment: boolean;
  footer: { note: string; show_validator: boolean; signer_title: string; signature_image_id: string | null; stamp_image_id: string | null; show_qr: boolean; show_page_numbers: boolean; legend: boolean };
}
interface BlankRow { id: string; name: string; is_default: boolean; is_active: boolean; current_version: number; version_at: string; version_by: string | null; groups: string[]; services: number }
interface BlankDetail extends Omit<BlankRow, 'groups' | 'services' | 'version_at' | 'version_by'> {
  settings: BlankSettings; groups: string[]; service_ids: string[]; services: { id: string; code: string; name: string; group_name: string }[];
  versions: { version: number; created_at: string; created_by_name: string | null; used: number }[];
}

const PF: [PatientField, string][] = [['personal_number', 'პირადი №'], ['birth_date', 'დაბადების თარიღი'], ['age', 'ასაკი'], ['gender', 'სქესი'], ['phone', 'ტელეფონი'],
  ['ordered_by', 'დანიშნა (ექიმი)'], ['referral', 'მიმართვა'], ['pregnancy', 'ორსულობა']];
const COLS: [Column, string][] = [['unit', 'ერთეული'], ['reference', 'ნორმა'], ['flag', 'ნიშანი (სვეტი)'], ['method', 'ანალიზატორი'], ['previous', 'წინა შედეგი']];

/** ბლანკების შაბლონები: ლაბორატორიის ხელმძღვანელი ქმნის/არედაქტირებს, ანიჭებს ჯგუფს/ანალიზს; სხვები — ნახვა */
export default function Blanks() {
  const qc = useQueryClient(); const perm = useLabPermissions(); const canEdit = !!perm.data?.blanks;
  const list = useQuery({ queryKey: ['lab-blanks'], queryFn: () => api<BlankRow[]>('/lab/blanks') });
  const [sel, setSel] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  useEffect(() => { if (!sel && list.data?.length) setSel(list.data.find((b) => b.is_default)?.id ?? list.data[0].id); }, [sel, list.data]);
  const def = useMutation({ mutationFn: (id: string) => api(`/lab/blanks/${id}/default`, { method: 'POST' }), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['lab-blanks'] }); void qc.invalidateQueries({ queryKey: ['lab-blank'] }); } });
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 16, alignItems: 'start' }}>
      <aside className="card stack" style={{ padding: 10, gap: 6 }}>
        <div className="row"><strong className="grow">შაბლონები</strong>{canEdit && <button className="btn sm" type="button" onClick={() => setCreating(true)}>+ ახალი</button>}</div>
        <ErrorBox error={list.error ?? def.error} />
        {list.isLoading ? <Loading /> : list.data?.map((b) => (
          <button key={b.id} type="button" className="card" onClick={() => setSel(b.id)}
            style={{ textAlign: 'left', padding: '8px 10px', cursor: 'pointer', font: 'inherit', borderColor: sel === b.id ? 'var(--accent)' : undefined, background: sel === b.id ? 'var(--accent-weak)' : undefined, opacity: b.is_active ? 1 : 0.55 }}>
            <div className="row" style={{ gap: 6 }}><strong className="grow">{b.name}</strong>{b.is_default && <span className="chip accent">ნაგულისხმევი</span>}{!b.is_active && <span className="chip">გათიშული</span>}</div>
            <div className="small muted">v{b.current_version} · {tsDate(b.version_at)}</div>
            {(b.groups.length > 0 || Number(b.services) > 0) && <div className="small">{[b.groups.join(', '), Number(b.services) ? `${b.services} ანალიზი` : ''].filter(Boolean).join(' · ')}</div>}
          </button>
        ))}
        <span className="hint">რომელი შაბლონით დაიბეჭდება: ანალიზზე მინიჭებული → ჯგუფზე მინიჭებული → ნაგულისხმევი. ვალიდირებული პასუხი ყოველთვის იმ ვერსიით იბეჭდება, რომლითაც დადასტურდა.</span>
      </aside>
      {sel ? <Editor key={sel} id={sel} canEdit={canEdit} onDefault={(id) => def.mutate(id)} /> : <div className="card empty">აირჩიეთ შაბლონი</div>}
      {creating && <CreateDialog from={sel} list={list.data ?? []} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setSel(id); }} />}
    </div>
  );
}

function CreateDialog({ from, list, onClose, onCreated }: { from: string | null; list: BlankRow[]; onClose: () => void; onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(''); const [copy, setCopy] = useState(from ?? '');
  const m = useMutation({
    mutationFn: () => api<BlankDetail>('/lab/blanks', { body: { name: name.trim(), copy_from: copy || undefined } }),
    onSuccess: (b) => { void qc.invalidateQueries({ queryKey: ['lab-blanks'] }); onCreated(b.id); },
  });
  return (
    <Modal title="ახალი ბლანკის შაბლონი" onClose={onClose} width={520}
      footer={<><button className="btn" type="button" onClick={onClose}>გაუქმება</button><button className="btn primary" type="button" disabled={name.trim().length < 2 || m.isPending} onClick={() => m.mutate()}>შექმნა</button></>}>
      <Field label="დასახელება" htmlFor="bn" required hint="მაგ. „ჰემატოლოგია“, „შარდი — კომპაქტური“, „A5 სწრაფი“"><input id="bn" className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
      <Field label="საფუძველი" htmlFor="bc"><select id="bc" className="select" value={copy} onChange={(e) => setCopy(e.target.value)}>
        <option value="">სტანდარტული პარამეტრები</option>{list.map((b) => <option key={b.id} value={b.id}>ასლი: {b.name}</option>)}</select></Field>
      <ErrorBox error={m.error} />
    </Modal>
  );
}

// ============================================================ რედაქტორი: პარამეტრები | ცოცხალი PDF
function Editor({ id, canEdit, onDefault }: { id: string; canEdit: boolean; onDefault: (id: string) => void }) {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['lab-blank', id], queryFn: () => api<BlankDetail>(`/lab/blanks/${id}`) });
  const [s, setS] = useState<BlankSettings | null>(null);
  const [name, setName] = useState('');
  const [tab, setTab] = useState<'design' | 'assign' | 'versions'>('design');
  useEffect(() => { if (q.data && !s) { setS(q.data.settings); setName(q.data.name); } }, [q.data, s]);
  const dirty = !!q.data && !!s && (JSON.stringify(s) !== JSON.stringify(q.data.settings) || name.trim() !== q.data.name);
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<BlankDetail>(`/lab/blanks/${id}`, { method: 'PUT', body }),
    onSuccess: (b) => { qc.setQueryData(['lab-blank', id], b); setS(b.settings); setName(b.name); void qc.invalidateQueries({ queryKey: ['lab-blanks'] }); toast.show(`შენახულია — ვერსია ${b.current_version}`); },
  });
  // ცოცხალი ნიმუში (debounce) — ცვლილებიდან ~0.7 წმ-ში
  const ds = useDebounced(s, 700);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null); const [pdfErr, setPdfErr] = useState<unknown>(null);
  useEffect(() => {
    if (!ds) return; let url: string | null = null; let cancelled = false;
    api<Blob>('/lab/blanks/preview', { body: { settings: ds }, raw: true })
      .then((b) => { if (cancelled) return; url = URL.createObjectURL(b); setPdfUrl((old) => { if (old) URL.revokeObjectURL(old); return url; }); setPdfErr(null); })
      .catch((e) => { if (!cancelled) setPdfErr(e); });
    return () => { cancelled = true; };
  }, [ds]);
  useEffect(() => () => { if (pdfUrl) URL.revokeObjectURL(pdfUrl); }, [pdfUrl]);

  if (q.isLoading || !q.data || !s) return <Loading />;
  const b = q.data; const ro = !canEdit;
  const up = (patch: Partial<BlankSettings>) => setS({ ...s, ...patch });
  const upH = (patch: Partial<BlankSettings['header']>) => setS({ ...s, header: { ...s.header, ...patch } });
  const upF = (patch: Partial<BlankSettings['footer']>) => setS({ ...s, footer: { ...s.footer, ...patch } });
  const toggle = <T extends string>(arr: T[], v: T) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  return (
    <div className="stack" style={{ minWidth: 0 }}>
      <div className="card card-pad row" style={{ flexWrap: 'wrap', gap: 10 }}>
        <input aria-label="შაბლონის სახელი" className="input" style={{ maxWidth: 280, height: 38, fontWeight: 600 }} value={name} disabled={ro} onChange={(e) => setName(e.target.value)} />
        {b.is_default ? <span className="chip accent">ნაგულისხმევი</span> : canEdit && b.is_active && <button className="btn sm" type="button" onClick={() => onDefault(b.id)}>ნაგულისხმევად</button>}
        {canEdit && !b.is_default && <button className="btn sm" type="button" onClick={() => save.mutate({ is_active: !b.is_active })}>{b.is_active ? 'გათიშვა' : 'ჩართვა'}</button>}
        <div className="seg" role="group" aria-label="ხედი" style={{ marginLeft: 'auto' }}>
          <button type="button" aria-pressed={tab === 'design'} onClick={() => setTab('design')}>დიზაინი</button>
          <button type="button" aria-pressed={tab === 'assign'} onClick={() => setTab('assign')}>მინიჭება</button>
          <button type="button" aria-pressed={tab === 'versions'} onClick={() => setTab('versions')}>ვერსიები ({b.versions.length})</button>
        </div>
        {canEdit && tab === 'design' && <>
          <button className="btn" type="button" disabled={!dirty} onClick={() => { setS(b.settings); setName(b.name); }}>გაუქმება</button>
          <button className="btn primary" type="button" disabled={!dirty || name.trim().length < 2 || save.isPending} onClick={() => save.mutate({ name: name.trim(), settings: s })}>შენახვა → v{b.current_version + (JSON.stringify(s) !== JSON.stringify(b.settings) ? 1 : 0)}</button>
        </>}
      </div>
      <ErrorBox error={save.error} />
      {tab === 'assign' && <Assign b={b} canEdit={canEdit} />}
      {tab === 'versions' && <Versions b={b} canEdit={canEdit} onLoad={(st) => { setS(st); setTab('design'); }} />}
      {tab === 'design' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(340px, 420px) 1fr', gap: 16, alignItems: 'start' }}>
          <fieldset disabled={ro} className="stack" style={{ border: 0, padding: 0, margin: 0, maxHeight: 'calc(100vh - 240px)', overflowY: 'auto' }}>
            <Section title="გვერდი">
              <div className="row" style={{ flexWrap: 'wrap' }}>
                <Seg label="ფორმატი" value={s.paper} options={[['A4', 'A4'], ['A5', 'A5']]} onChange={(v) => up({ paper: v })} />
                <label className="row small">შრიფტი <input type="number" min={7} max={12} step={0.5} className="input mono" style={{ width: 64, height: 32 }} value={s.font_size} onChange={(e) => up({ font_size: Number(e.target.value) })} /></label>
                <label className="row small">ველი (მმ) <input type="number" min={8} max={30} className="input mono" style={{ width: 60, height: 32 }} value={s.margin_mm} onChange={(e) => up({ margin_mm: Number(e.target.value) })} /></label>
                <label className="row small">ფერი <input type="color" aria-label="ძირითადი ფერი" value={s.accent_color} onChange={(e) => up({ accent_color: e.target.value })} style={{ width: 40, height: 30, border: 0, background: 'none' }} /></label>
              </div>
            </Section>
            <Section title="თავი">
              <ImagePicker label="ლოგო" id={s.header.logo_image_id} onChange={(v) => upH({ logo_image_id: v })} disabled={ro} />
              {s.header.logo_image_id && <div className="row" style={{ flexWrap: 'wrap' }}>
                <Seg label="ლოგოს მდებარეობა" value={s.header.logo_position} options={[['left', 'მარცხნივ'], ['center', 'ცენტრში'], ['right', 'მარჯვნივ']]} onChange={(v) => upH({ logo_position: v })} />
                <label className="row small">სიმაღლე (მმ) <input type="number" min={8} max={40} className="input mono" style={{ width: 60, height: 32 }} value={s.header.logo_height_mm} onChange={(e) => upH({ logo_height_mm: Number(e.target.value) })} /></label>
              </div>}
              <Check label="კლინიკის რეკვიზიტები (დასახელება, მისამართი, ტელეფონი)" v={s.header.show_clinic} on={(v) => upH({ show_clinic: v })} />
              <Field label="დამატებითი სტრიქონები" htmlFor="bxl" hint="ლიცენზია, აკრედიტაცია, ვებგვერდი — თითო ხაზზე (მაქს. 5)">
                <textarea id="bxl" className="textarea" rows={2} value={s.header.extra_lines.join('\n')} onChange={(e) => upH({ extra_lines: e.target.value.split('\n').slice(0, 5) })} /></Field>
              <Field label="სათაური" htmlFor="btt"><input id="btt" className="input" value={s.header.title} onChange={(e) => upH({ title: e.target.value })} /></Field>
              <Field label="ქვესათაური" htmlFor="bst"><input id="bst" className="input" value={s.header.subtitle} onChange={(e) => upH({ subtitle: e.target.value })} /></Field>
            </Section>
            <Section title="პაციენტის ველები">
              <div className="row" style={{ flexWrap: 'wrap', gap: '4px 14px' }}>{PF.map(([k, l]) => <Check key={k} label={l} v={s.patient_fields.includes(k)} on={() => up({ patient_fields: toggle(s.patient_fields, k) })} />)}</div>
            </Section>
            <Section title="შედეგები">
              <Seg label="განლაგება" value={s.layout} options={[['table', 'ცხრილი'], ['two_column', 'ორსვეტიანი'], ['text', 'ტექსტური']]} onChange={(v) => up({ layout: v })} />
              <span className="hint">{s.layout === 'two_column' ? 'კომპაქტური (მაგ. შარდის საერთო): ერთეული, ნორმა, ნიშანი; ვიწრო გვერდზე ან გრძელ ტექსტზე ავტომატურად ცხრილი.' : s.layout === 'text' ? 'აღწერითი კვლევებისთვის — სახელი, ქვეშ მნიშვნელობა და ნორმა.' : 'სტანდარტული ცხრილი.'}</span>
              <div className="row" style={{ flexWrap: 'wrap', gap: '4px 14px' }}>{COLS.map(([k, l]) => <Check key={k} label={l} v={s.columns.includes(k)} on={() => up({ columns: toggle(s.columns, k) })} />)}</div>
              <Seg label="გადახრის ნიშანი" value={s.flag_style} options={[['words', 'სიტყვით'], ['arrows', 'ისრით'], ['letters', 'L / H']]} onChange={(v) => up({ flag_style: v })} />
              <Check label="გადახრილი მნიშვნელობის ფონით გამოყოფა" v={s.highlight_abnormal} on={(v) => up({ highlight_abnormal: v })} />
              <Check label="ჯგუფების სათაურები (ჰემატოლოგია, ბიოქიმია…)" v={s.group_headers} on={(v) => up({ group_headers: v })} />
              <Check label="ნიმუშის ინფორმაცია (შტრიხკოდი, აღება, მიღება)" v={s.show_sample_info} on={(v) => up({ show_sample_info: v })} />
              <Check label="ანალიზის კომენტარი (კატალოგიდან)" v={s.show_service_comment} on={(v) => up({ show_service_comment: v })} />
            </Section>
            <Section title="ძირი">
              <Field label="შენიშვნა" htmlFor="bfn" hint="მაგ. „შედეგი ინტერპრეტაციას საჭიროებს მკურნალი ექიმის მიერ“"><textarea id="bfn" className="textarea" rows={2} value={s.footer.note} onChange={(e) => upF({ note: e.target.value })} /></Field>
              <Check label="ვალიდატორის სახელი" v={s.footer.show_validator} on={(v) => upF({ show_validator: v })} />
              {s.footer.show_validator && <Field label="თანამდებობა" htmlFor="bsg"><input id="bsg" className="input" value={s.footer.signer_title} onChange={(e) => upF({ signer_title: e.target.value })} /></Field>}
              <ImagePicker label="ხელმოწერა (გამჭვირვალე PNG)" id={s.footer.signature_image_id} onChange={(v) => upF({ signature_image_id: v })} disabled={ro} />
              <ImagePicker label="ბეჭედი (გამჭვირვალე PNG)" id={s.footer.stamp_image_id} onChange={(v) => upF({ stamp_image_id: v })} disabled={ro} />
              <Check label="QR — ნამდვილობის შემოწმება" v={s.footer.show_qr} on={(v) => upF({ show_qr: v })} />
              <Check label="გვერდების ნუმერაცია" v={s.footer.show_page_numbers} on={(v) => upF({ show_page_numbers: v })} />
              <Check label="ნიშნების განმარტება" v={s.footer.legend} on={(v) => upF({ legend: v })} />
            </Section>
          </fieldset>
          <div className="card" style={{ position: 'sticky', top: 8, padding: 0, overflow: 'hidden' }}>
            <div className="row small muted" style={{ padding: '6px 10px', borderBottom: '1px solid var(--line)' }}>
              <span className="grow">ნიმუში — სატესტო პაციენტი{dirty ? ' · შეუნახავი ცვლილებები' : ''}</span>
              {pdfUrl && <a href={pdfUrl} target="_blank" rel="noreferrer">ახალ ჩანართში</a>}
            </div>
            <ErrorBox error={pdfErr} />
            {pdfUrl ? <iframe title="ბლანკის ნიმუში" src={`${pdfUrl}#toolbar=0&navpanes=0&view=FitH`} style={{ width: '100%', height: 'calc(100vh - 230px)', minHeight: 520, border: 0, display: 'block' }} /> : <Loading />}
          </div>
        </div>
      )}
      {toast.node}
    </div>
  );
}

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="card card-pad stack" style={{ gap: 8 }}><strong style={{ fontSize: 13 }}>{title}</strong>{children}</section>
);
const Check = ({ label, v, on }: { label: string; v: boolean; on: (v: boolean) => void }) => (
  <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={v} onChange={(e) => on(e.target.checked)} /> {label}</label>
);
function Seg<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return <div className="seg" role="group" aria-label={label}>{options.map(([k, l]) => <button key={k} type="button" aria-pressed={value === k} onClick={() => onChange(k)}>{l}</button>)}</div>;
}

/** სურათის ატვირთვა (PNG/JPG ≤ 700 KB) → id; მინიატურა ავტორიზებული მოთხოვნით */
function ImagePicker({ label, id, onChange, disabled }: { label: string; id: string | null; onChange: (id: string | null) => void; disabled?: boolean }) {
  const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const thumb = useQuery({ queryKey: ['lab-blank-image', id], queryFn: async () => URL.createObjectURL(await api<Blob>(`/lab/blanks/images/${id}`, { raw: true })), enabled: !!id, staleTime: Infinity });
  const pick = (f: File | undefined) => {
    if (!f) return;
    if (f.size > 700 * 1024) { setErr(new Error('სურათი მაქსიმუმ 700 KB — შეამცირეთ ზომა')); return; }
    const r = new FileReader();
    r.onload = async () => {
      setBusy(true); setErr(null);
      try { const res = await api<{ id: string }>('/lab/blanks/images', { body: { data_url: r.result } }); onChange(res.id); } catch (e) { setErr(e); } finally { setBusy(false); }
    };
    r.readAsDataURL(f);
  };
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div className="row" style={{ gap: 8 }}>
        <span className="small grow">{label}</span>
        {id && thumb.data && <img src={thumb.data} alt={label} style={{ maxHeight: 36, maxWidth: 120, border: '1px solid var(--line)', borderRadius: 4, background: '#fff' }} />}
        {!disabled && <label className="btn sm" style={{ cursor: 'pointer' }}>{busy ? '…' : id ? 'შეცვლა' : 'ატვირთვა'}
          <input type="file" accept="image/png,image/jpeg" hidden onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} /></label>}
        {!disabled && id && <button className="btn sm" type="button" onClick={() => onChange(null)}>მოხსნა</button>}
      </div>
      <ErrorBox error={err} />
    </div>
  );
}

// ============================================================ მინიჭება
function Assign({ b, canEdit }: { b: BlankDetail; canEdit: boolean }) {
  const qc = useQueryClient(); const toast = useToast();
  const groups = useQuery({ queryKey: ['dx-groups', 'lab'], queryFn: () => api<string[]>('/dx/catalog/groups', { query: { section: 'lab' } }) });
  const services = useQuery({ queryKey: ['dx-catalog', 'lab'], queryFn: () => api<DxService[]>('/dx/catalog', { query: { section: 'lab' } }) });
  const all = useQuery({ queryKey: ['lab-blanks'], queryFn: () => api<BlankRow[]>('/lab/blanks') });
  const [g, setG] = useState<string[]>(b.groups); const [sv, setSv] = useState<string[]>(b.service_ids); const [search, setSearch] = useState('');
  const save = useMutation({
    mutationFn: () => api<BlankDetail>(`/lab/blanks/${b.id}/assignments`, { method: 'PUT', body: { groups: g, service_ids: sv } }),
    onSuccess: (r) => { qc.setQueryData(['lab-blank', b.id], r); void qc.invalidateQueries({ queryKey: ['lab-blanks'] }); toast.show('მინიჭება შენახულია'); },
  });
  const otherGroup = useMemo(() => new Map((all.data ?? []).filter((x) => x.id !== b.id).flatMap((x) => x.groups.map((gr) => [gr, x.name] as const))), [all.data, b.id]);
  const filtered = (services.data ?? []).filter((s) => !search.trim() || s.name.toLowerCase().includes(search.trim().toLowerCase()) || s.code.toLowerCase().includes(search.trim().toLowerCase()));
  const dirty = JSON.stringify([...g].sort()) !== JSON.stringify([...b.groups].sort()) || JSON.stringify([...sv].sort()) !== JSON.stringify([...b.service_ids].sort());
  if (!b.is_active) return <div className="alert warn">გათიშულ შაბლონს ვერ მიანიჭებთ — ჯერ ჩართეთ.</div>;
  return (
    <div className="stack">
      {b.is_default && <div className="alert info">ეს ნაგულისხმევი შაბლონია — გამოიყენება ყველა ანალიზისთვის, რომელსაც (ან რომლის ჯგუფს) სხვა შაბლონი არ აქვს მინიჭებული.</div>}
      <fieldset disabled={!canEdit} style={{ border: 0, padding: 0, margin: 0 }} className="stack">
        <section className="card card-pad stack" style={{ gap: 6 }}>
          <strong style={{ fontSize: 13 }}>ჯგუფები</strong>
          <div className="row" style={{ flexWrap: 'wrap', gap: '4px 16px' }}>{groups.data?.map((gr) => (
            <label key={gr} className="row small" style={{ gap: 6 }}><input type="checkbox" checked={g.includes(gr)} onChange={() => setG(g.includes(gr) ? g.filter((x) => x !== gr) : [...g, gr])} />
              {gr}{otherGroup.has(gr) && !g.includes(gr) && <span className="muted">({otherGroup.get(gr)})</span>}</label>))}</div>
          <span className="hint">ჯგუფი ერთ შაბლონს ეკუთვნის — აქ მონიშვნა მას სხვა შაბლონიდან გადმოიტანს.</span>
        </section>
        <section className="card card-pad stack" style={{ gap: 6 }}>
          <div className="row"><strong className="grow" style={{ fontSize: 13 }}>ცალკეული ანალიზები ({sv.length})</strong>
            <input aria-label="ძებნა" className="input" style={{ maxWidth: 240, height: 32 }} placeholder="ძებნა" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
          <div style={{ maxHeight: 320, overflowY: 'auto', columns: 2 }}>{filtered.map((s) => (
            <label key={s.id} className="row small" style={{ gap: 6, breakInside: 'avoid' }}><input type="checkbox" checked={sv.includes(s.id)} onChange={() => setSv(sv.includes(s.id) ? sv.filter((x) => x !== s.id) : [...sv, s.id])} />
              {s.name} <span className="muted">· {s.group_name}</span></label>))}</div>
          <span className="hint">ანალიზზე მინიჭება ჯგუფზე მინიჭებას სჯობს.</span>
        </section>
      </fieldset>
      <ErrorBox error={save.error} />
      {canEdit && <div className="row"><button className="btn primary" type="button" style={{ marginLeft: 'auto' }} disabled={!dirty || save.isPending} onClick={() => save.mutate()}>მინიჭების შენახვა</button></div>}
      {toast.node}
    </div>
  );
}

// ============================================================ ვერსიები
function Versions({ b, canEdit, onLoad }: { b: BlankDetail; canEdit: boolean; onLoad: (s: BlankSettings) => void }) {
  const load = useMutation({ mutationFn: (v: number) => api<BlankSettings>(`/lab/blanks/${b.id}/versions/${v}`), onSuccess: onLoad });
  return (
    <div className="card">
      <table className="table">
        <thead><tr><th>ვერსია</th><th>შეიქმნა</th><th className="num">დადასტურებული პასუხები</th><th /></tr></thead>
        <tbody>{b.versions.map((v) => (
          <tr key={v.version}>
            <td><strong>v{v.version}</strong>{v.version === b.current_version && <span className="chip ok" style={{ marginLeft: 6 }}>მიმდინარე</span>}</td>
            <td className="small">{tsDate(v.created_at)} · {v.created_by_name ?? 'სისტემა'}</td>
            <td className="num">{v.used}</td>
            <td>{canEdit && v.version !== b.current_version && <button className="btn sm" type="button" onClick={() => load.mutate(v.version)}>რედაქტორში ჩატვირთვა</button>}</td>
          </tr>))}</tbody>
      </table>
      <div className="hint" style={{ padding: '8px 12px' }}>ვერსია არ იცვლება და არ იშლება — ძველი ვერსიით დადასტურებული პასუხი ხელახლა ბეჭდვისასაც იმავე სახით გამოვა. ძველი ვერსიის დასაბრუნებლად ჩატვირთეთ და შეინახეთ (შეიქმნება ახალი ვერსია).</div>
      <ErrorBox error={load.error} />
    </div>
  );
}
