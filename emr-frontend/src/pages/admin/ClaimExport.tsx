import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, can } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Field, Loading, Modal, useToast } from '../../components/ui';
import { tsDate } from '../../lib/format';
import { ACTION_KA, type DenialReason, type ExportColumn, type ExportConfig, type ExportMeta, FORMAT_KA, type PayerTpl, RESP_KA, RESP_KEY_KA, type ResponseConfig,
  type RespStatus, type Template, type TemplateRow, TPL_EDIT } from '../finance/claimExport';

/**
 * ადმინისტრირება → ქლეიმის ფაილები (0058): გადამხდელის (SSA / მზღვეველი) ფაილის შაბლონები — კოდის შეცვლის გარეშე.
 *  ექსპორტი: სვეტები (ველი / მუდმივი), ფორმატები; პასუხი: ფაილის სვეტები და სტატუსები; გადამხდელის ნაგულისხმევი; უარის მიზეზები.
 */
type Tab = 'export' | 'response' | 'payers' | 'reasons';
const TABS: [Tab, string][] = [['export', 'ექსპორტის შაბლონები'], ['response', 'პასუხის შაბლონები'], ['payers', 'გადამხდელები'], ['reasons', 'უარის მიზეზები']];

export default function ClaimExport() {
  const { user } = useAuth(); const edit = can(user, ...TPL_EDIT);
  const [tab, setTab] = useState<Tab>('export');
  const meta = useQuery({ queryKey: ['ctpl-meta'], queryFn: () => api<ExportMeta>('/claim-templates/meta'), staleTime: Infinity });
  return (
    <div className="content stack" style={{ gap: 14 }}>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div className="seg" role="group" aria-label="განყოფილება">{TABS.map(([k, l]) => <button key={k} type="button" aria-pressed={tab === k} onClick={() => setTab(k)}>{l}</button>)}</div>
        <span className="hint grow">ფაილის ფორმატი გადამხდელის (მაგ. საყოველთაო ჯანდაცვა) მოთხოვნით იწყობა აქ — სვეტები, თანმიმდევრობა, სახელები, თარიღის / ათწილადის ფორმატი. ცვლილება ზრდის ვერსიას;
          უკვე გაგზავნილი ფაილი ინახება ზუსტად ისე, როგორც ჩამოიტვირთა.</span>
      </div>
      {meta.isLoading ? <Loading /> : !meta.data ? <ErrorBox error={meta.error} /> : <>
        {(tab === 'export' || tab === 'response') && <Templates key={tab} kind={tab} meta={meta.data} edit={edit} />}
        {tab === 'payers' && <Payers edit={edit} />}
        {tab === 'reasons' && <Reasons meta={meta.data} edit={edit} />}
      </>}
    </div>
  );
}

// ---------------------------------------------------------------- შაბლონები
function Templates({ kind, meta, edit }: { kind: 'export' | 'response'; meta: ExportMeta; edit: boolean }) {
  const list = useQuery({ queryKey: ['ctpl', kind], queryFn: () => api<TemplateRow[]>('/claim-templates', { query: { kind } }) });
  const [open, setOpen] = useState<string | 'new' | null>(null);
  return (
    <section className="card">
      <div className="card-head row"><strong className="grow">{kind === 'export' ? 'ექსპორტის შაბლონები (ქლეიმის ფაილი)' : 'პასუხის შაბლონები (გადამხდელის ფაილის წაკითხვა)'}</strong>
        {edit && <button className="btn primary sm" type="button" onClick={() => setOpen('new')}>+ შაბლონი</button>}</div>
      <ErrorBox error={list.error} />
      {list.isLoading ? <Loading /> : (
        <table className="table">
          <thead><tr><th>დასახელება</th><th>კოდი</th><th>ფორმატი</th><th className="num">ვერსია</th><th>გადამხდელები</th>{kind === 'export' && <th className="num">ექსპორტი</th>}<th>ბოლო ცვლილება</th></tr></thead>
          <tbody>{list.data?.map((t) => (
            <tr key={t.id} className="clickable" onClick={() => setOpen(t.id)} style={t.is_active ? undefined : { opacity: 0.55 }}>
              <td><strong>{t.name}</strong>{!t.is_active && <span className="chip" style={{ marginLeft: 6 }}>გამორთული</span>}{t.notes && <div className="small muted">{t.notes}</div>}</td>
              <td className="mono small">{t.code}</td><td>{FORMAT_KA[t.format]}</td><td className="num mono">{t.revision}</td>
              <td className="small">{t.payers.join(', ') || <span className="muted">—</span>}</td>{kind === 'export' && <td className="num">{t.exports || '—'}</td>}
              <td className="small muted">{tsDate(t.updated_at)}{t.updated_by_name ? ` · ${t.updated_by_name}` : ''}</td></tr>))}
            {!list.data?.length && <tr><td colSpan={7} className="muted">შაბლონი არ არის</td></tr>}</tbody>
        </table>)}
      {open && <TemplateDialog id={open === 'new' ? null : open} kind={kind} meta={meta} edit={edit} onClose={() => setOpen(null)} onSaved={(id) => setOpen(id)} />}
    </section>
  );
}

const EXPORT_DEFAULT: ExportConfig = { kinds: ['ipd', 'opd'], header_row: true, total_row: false, date_format: 'DD.MM.YYYY', decimal_sep: '.', list_sep: ', ', sheet_name: 'Claim',
  file_name: '{payer_code}_{claim_no}', csv_sep: ';', csv_bom: true, xml_root: 'Cases', xml_row: 'Case', columns: [{ header: '№', field: 'seq' }] };
const RESPONSE_DEFAULT: ResponseConfig = { header_row: true, csv_sep: ';', decimal_sep: '.', key_field: 'invoice_number', amount_kind: 'approved',
  columns: { key: '', status: '', amount: '' }, status_map: { accepted: [], partial: [], rejected: [], pending: [] } };

function TemplateDialog({ id, kind, meta, edit, onClose, onSaved }: { id: string | null; kind: 'export' | 'response'; meta: ExportMeta; edit: boolean; onClose: () => void; onSaved: (id: string) => void }) {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['ctpl-one', id], queryFn: () => api<Template>(`/claim-templates/${id}`), enabled: !!id });
  if (id && !q.data) return <Modal title="შაბლონი" onClose={onClose}>{q.error ? <ErrorBox error={q.error} /> : <Loading />}</Modal>;
  return <TemplateForm key={`${id}-${q.data?.revision}-${q.data?.updated_at}`} t={q.data ?? null} kind={kind} meta={meta} edit={edit} onClose={onClose} toast={toast}
    onSaved={(t) => { toast.show('შენახულია'); void qc.invalidateQueries({ queryKey: ['ctpl'] }); void qc.invalidateQueries({ queryKey: ['ctpl-one', t.id] }); void qc.invalidateQueries({ queryKey: ['ctpl-payers'] }); onSaved(t.id); }} />;
}

function TemplateForm({ t, kind, meta, edit, onClose, onSaved, toast }: { t: Template | null; kind: 'export' | 'response'; meta: ExportMeta; edit: boolean; onClose: () => void;
  onSaved: (t: Template) => void; toast: ReturnType<typeof useToast> }) {
  const [head, setHead] = useState({ code: t?.code ?? '', name: t?.name ?? '', format: t?.format ?? (kind === 'export' ? 'xlsx' : 'csv'), notes: t?.notes ?? '', is_active: t?.is_active ?? true });
  const [cfg, setCfg] = useState<ExportConfig | ResponseConfig>(() => (t?.config ? structuredClone(t.config) : structuredClone(kind === 'export' ? EXPORT_DEFAULT : RESPONSE_DEFAULT)));
  const [json, setJson] = useState<string | null>(null);
  const [copy, setCopy] = useState<{ code: string; name: string } | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const body = { name: head.name.trim(), format: head.format, notes: head.notes.trim() || null, is_active: head.is_active, config: cfg };
      return t ? api<Template>(`/claim-templates/${t.id}`, { method: 'PATCH', body }) : api<Template>('/claim-templates', { body: { ...body, code: head.code.trim().toUpperCase(), kind } });
    },
    onSuccess: onSaved,
  });
  const cp = useMutation({ mutationFn: () => api<Template>(`/claim-templates/${t!.id}/copy`, { body: { code: copy!.code.trim().toUpperCase(), name: copy!.name.trim() } }), onSuccess: (x) => { setCopy(null); onSaved(x); } });
  const errs = (save.error as { body?: { errors?: string[] } } | null)?.body?.errors;
  const applyJson = () => { try { setCfg(JSON.parse(json!)); setJson(null); } catch (e) { toast.show(`JSON: ${(e as Error).message}`); } };
  return (
    <Modal title={t ? `${t.name} — v${t.revision}` : kind === 'export' ? 'ახალი ექსპორტის შაბლონი' : 'ახალი პასუხის შაბლონი'} onClose={onClose} width={1240}
      footer={<>{edit && t && <button className="btn" type="button" onClick={() => setCopy({ code: `${t.code}_2`.slice(0, 40), name: `${t.name} (ასლი)` })}>ასლი</button>}
        <button className="btn" type="button" onClick={() => setJson(json === null ? JSON.stringify(cfg, null, 2) : null)}>{json === null ? 'JSON' : 'ფორმა'}</button>
        <span className="grow" /><button className="btn" type="button" onClick={onClose}>დახურვა</button>
        {edit && <button className="btn primary" type="button" disabled={save.isPending || json !== null || head.name.trim().length < 2 || (!t && !head.code)} onClick={() => save.mutate()}>შენახვა</button>}</>}>
      {toast.node}
      <div className="stack" style={{ gap: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '200px minmax(0, 2fr) 170px minmax(0, 2fr) auto', gap: 10, alignItems: 'end' }}>
          <Field label="კოდი" htmlFor="ct-c" required><input id="ct-c" className="input mono" disabled={!!t || !edit} value={head.code} placeholder="SSA_2026" onChange={(e) => setHead({ ...head, code: e.target.value.toUpperCase() })} /></Field>
          <Field label="დასახელება" htmlFor="ct-n" required><input id="ct-n" className="input" disabled={!edit} value={head.name} onChange={(e) => setHead({ ...head, name: e.target.value })} /></Field>
          <Field label="ფორმატი" htmlFor="ct-f"><select id="ct-f" className="select" disabled={!edit} value={head.format} onChange={(e) => setHead({ ...head, format: e.target.value as 'csv' })}>
            {(kind === 'export' ? ['xlsx', 'csv', 'xml'] : ['csv', 'xlsx']).map((f) => <option key={f} value={f}>{FORMAT_KA[f]}</option>)}</select></Field>
          <Field label="შენიშვნა" htmlFor="ct-no"><input id="ct-no" className="input" disabled={!edit} value={head.notes} onChange={(e) => setHead({ ...head, notes: e.target.value })} placeholder="მაგ. SSA ბრძანება №…" /></Field>
          <label className="row small" style={{ height: 38 }}><input type="checkbox" disabled={!edit} checked={head.is_active} onChange={(e) => setHead({ ...head, is_active: e.target.checked })} /> ჩართული</label>
        </div>
        {kind === 'response' && head.format === 'xlsx' && <span className="hint">xlsx: იკითხება პირველი ფურცელი.</span>}
        {json !== null ? (
          <div className="stack" style={{ gap: 6 }}>
            <textarea className="textarea mono" rows={22} value={json} onChange={(e) => setJson(e.target.value)} aria-label="კონფიგურაცია (JSON)" />
            <div className="row"><span className="hint grow">კონფიგურაცია JSON-ად — კოპირება / ჩასმა სხვა სისტემიდან ან შაბლონიდან. შენახვამდე მოწმდება.</span>
              <button className="btn sm" type="button" onClick={applyJson}>ფორმაში გადატანა</button></div>
          </div>
        ) : kind === 'export' ? <ExportEditor cfg={cfg as ExportConfig} set={setCfg} meta={meta} format={head.format} edit={edit} />
          : <ResponseEditor cfg={cfg as ResponseConfig} set={setCfg} edit={edit} />}
        {copy && (
          <div className="row card-pad" style={{ background: 'var(--surface-2)', flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <Field label="ასლის კოდი" htmlFor="cp-c"><input id="cp-c" className="input mono" value={copy.code} onChange={(e) => setCopy({ ...copy, code: e.target.value.toUpperCase() })} /></Field>
            <Field label="დასახელება" htmlFor="cp-n"><input id="cp-n" className="input" style={{ minWidth: 300 }} value={copy.name} onChange={(e) => setCopy({ ...copy, name: e.target.value })} /></Field>
            <button className="btn" type="button" onClick={() => setCopy(null)}>გაუქმება</button>
            <button className="btn primary" type="button" disabled={cp.isPending} onClick={() => cp.mutate()}>ასლის შექმნა</button>
          </div>)}
        <ErrorBox error={save.error ?? cp.error} />
        {errs && errs.length > 1 && <ul className="small" style={{ color: 'var(--danger-ink)', margin: 0 }}>{errs.map((e) => <li key={e}>{e}</li>)}</ul>}
        {t && t.payers.length > 0 && <span className="small muted">ნაგულისხმევია: {t.payers.map((p) => p.name).join(', ')}</span>}
      </div>
    </Modal>
  );
}

const mapToText = (m?: Record<string, string>) => Object.entries(m ?? {}).map(([k, v]) => `${k}=${v}`).join('; ');
const textToMap = (s: string) => {
  const out: Record<string, string> = {};
  for (const part of s.split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
  return Object.keys(out).length ? out : undefined;
};

function ExportEditor({ cfg, set, meta, format, edit }: { cfg: ExportConfig; set: (c: ExportConfig) => void; meta: ExportMeta; format: string; edit: boolean }) {
  const up = (p: Partial<ExportConfig>) => set({ ...cfg, ...p });
  const col = (i: number, p: Partial<ExportColumn>) => up({ columns: cfg.columns.map((c, j) => (j === i ? Object.fromEntries(Object.entries({ ...c, ...p }).filter(([, v]) => v !== undefined && v !== '')) as unknown as ExportColumn : c)) });
  const move = (i: number, d: number) => { const a = [...cfg.columns]; const [x] = a.splice(i, 1); a.splice(i + d, 0, x); up({ columns: a }); };
  const groups = [...new Set(meta.fields.map((f) => f.group))];
  const ftype = (k?: string) => meta.fields.find((f) => f.key === k)?.type;
  const [mapText, setMapText] = useState<Record<number, string>>({});
  const tog = (k: 'ipd' | 'opd') => up({ kinds: cfg.kinds.includes(k) ? cfg.kinds.filter((x) => x !== k) : [...cfg.kinds, k] });
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="row" style={{ flexWrap: 'wrap', gap: 14, alignItems: 'flex-end' }}>
        <div className="stack" style={{ gap: 4 }}><span className="small muted">შემთხვევები</span>
          <div className="row" style={{ gap: 10 }}><label className="row small"><input type="checkbox" disabled={!edit} checked={cfg.kinds.includes('ipd')} onChange={() => tog('ipd')} /> სტაციონარი</label>
            <label className="row small"><input type="checkbox" disabled={!edit} checked={cfg.kinds.includes('opd')} onChange={() => tog('opd')} /> ამბულატორია</label></div></div>
        <Field label="თარიღის ფორმატი" htmlFor="ce-df"><select id="ce-df" className="select" disabled={!edit} value={cfg.date_format} onChange={(e) => up({ date_format: e.target.value })}>
          {meta.date_formats.map((f) => <option key={f}>{f}</option>)}</select></Field>
        <Field label="ათწილადი" htmlFor="ce-ds"><select id="ce-ds" className="select" disabled={!edit} value={cfg.decimal_sep} onChange={(e) => up({ decimal_sep: e.target.value as '.' })}>
          <option value=".">წერტილი (1234.50)</option><option value=",">მძიმე (1234,50)</option></select></Field>
        <Field label="სიის გამყოფი" htmlFor="ce-ls" hint="დიაგნოზები / ოპერაციები"><input id="ce-ls" className="input mono" style={{ width: 80 }} disabled={!edit} value={cfg.list_sep} onChange={(e) => up({ list_sep: e.target.value })} /></Field>
        <Field label="ფაილის სახელი" htmlFor="ce-fn" hint={meta.file_tokens.map((x) => `{${x}}`).join(' ')}><input id="ce-fn" className="input mono" style={{ minWidth: 240 }} disabled={!edit} value={cfg.file_name} onChange={(e) => up({ file_name: e.target.value })} /></Field>
        {format === 'xlsx' && <Field label="ფურცელი" htmlFor="ce-sh"><input id="ce-sh" className="input" style={{ width: 140 }} disabled={!edit} value={cfg.sheet_name} onChange={(e) => up({ sheet_name: e.target.value })} /></Field>}
        {format === 'csv' && <>
          <Field label="CSV გამყოფი" htmlFor="ce-cs"><select id="ce-cs" className="select" disabled={!edit} value={cfg.csv_sep} onChange={(e) => up({ csv_sep: e.target.value })}>
            <option value=";">;</option><option value=",">,</option><option value={'\t'}>tab</option><option value="|">|</option></select></Field>
          <label className="row small" style={{ height: 38 }}><input type="checkbox" disabled={!edit} checked={cfg.csv_bom} onChange={(e) => up({ csv_bom: e.target.checked })} /> UTF-8 BOM (Excel)</label></>}
        {format === 'xml' && <>
          <Field label="ძირი" htmlFor="ce-xr"><input id="ce-xr" className="input mono" style={{ width: 120 }} disabled={!edit} value={cfg.xml_root} onChange={(e) => up({ xml_root: e.target.value })} /></Field>
          <Field label="ხაზი" htmlFor="ce-xw"><input id="ce-xw" className="input mono" style={{ width: 120 }} disabled={!edit} value={cfg.xml_row} onChange={(e) => up({ xml_row: e.target.value })} /></Field></>}
        {format !== 'xml' && <>
          <label className="row small" style={{ height: 38 }}><input type="checkbox" disabled={!edit} checked={cfg.header_row} onChange={(e) => up({ header_row: e.target.checked })} /> სათაურის ხაზი</label>
          <label className="row small" style={{ height: 38 }}><input type="checkbox" disabled={!edit} checked={cfg.total_row} onChange={(e) => up({ total_row: e.target.checked })} /> ჯამის ხაზი</label></>}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="table">
          <thead><tr><th style={{ width: 34 }}>#</th><th>სათაური</th><th>მნიშვნელობა</th><th style={{ width: 130 }}>ფორმატი</th><th>შესაბამისობა</th><th style={{ width: 110 }}>ცარიელზე</th>
            <th style={{ width: 70 }}>{format === 'xlsx' ? 'სიგანე' : 'ნულები'}</th>{format === 'xml' && <th style={{ width: 130 }}>XML ელემენტი</th>}<th style={{ width: 110 }} /></tr></thead>
          <tbody>{cfg.columns.map((c, i) => {
            const isConst = c.const !== undefined && c.field === undefined; const ty = ftype(c.field);
            return (
              <tr key={i}>
                <td className="mono small">{i + 1}</td>
                <td><input className="input" aria-label={`სათაური ${i + 1}`} disabled={!edit} value={c.header} onChange={(e) => col(i, { header: e.target.value })} /></td>
                <td><div className="row" style={{ gap: 4 }}>
                  <select className="select" aria-label={`ველი ${i + 1}`} style={{ minWidth: 220 }} disabled={!edit} value={isConst ? '__const' : c.field ?? ''}
                    onChange={(e) => (e.target.value === '__const' ? col(i, { field: undefined, const: c.const ?? '', format: undefined }) : col(i, { field: e.target.value, const: undefined, format: undefined }))}>
                    <option value="">— აირჩიეთ —</option><option value="__const">მუდმივი მნიშვნელობა…</option>
                    {groups.map((g) => <optgroup key={g} label={g}>{meta.fields.filter((f) => f.group === g).map((f) => <option key={f.key} value={f.key}>{f.label}{f.ipd_only ? ' (სტაც.)' : ''}</option>)}</optgroup>)}
                  </select>
                  {isConst && <input className="input" aria-label={`მუდმივი ${i + 1}`} disabled={!edit} value={c.const ?? ''} onChange={(e) => up({ columns: cfg.columns.map((x, j) => (j === i ? { ...x, const: e.target.value } : x)) })} />}
                </div></td>
                <td>{ty === 'date' ? <select className="select" aria-label={`ფორმატი ${i + 1}`} disabled={!edit} value={c.format ?? ''} onChange={(e) => col(i, { format: e.target.value || undefined })}>
                  <option value="">ზოგადი ({cfg.date_format})</option>{meta.date_formats.map((f) => <option key={f}>{f}</option>)}</select>
                  : ty === 'number' || ty === 'int' ? <select className="select" aria-label={`ფორმატი ${i + 1}`} disabled={!edit} value={c.format ?? ''} onChange={(e) => col(i, { format: e.target.value || undefined })}>
                    <option value="">ნაგულისხმევი</option>{['0', '0.0', '0.00', '0.0000'].map((f) => <option key={f}>{f}</option>)}</select> : <span className="muted small">—</span>}</td>
                <td><input className="input mono" aria-label={`შესაბამისობა ${i + 1}`} disabled={!edit || isConst} placeholder="M=1; F=2" value={mapText[i] ?? mapToText(c.map)}
                  onChange={(e) => setMapText({ ...mapText, [i]: e.target.value })} onBlur={(e) => { col(i, { map: textToMap(e.target.value) }); setMapText((m) => { const n = { ...m }; delete n[i]; return n; }); }} /></td>
                <td><input className="input" aria-label={`ცარიელზე ${i + 1}`} disabled={!edit || isConst} value={c.default ?? ''} onChange={(e) => col(i, { default: e.target.value || undefined })} /></td>
                <td>{format === 'xlsx' ? <input className="input mono" aria-label={`სიგანე ${i + 1}`} disabled={!edit} inputMode="numeric" value={c.width ?? ''} onChange={(e) => col(i, { width: e.target.value ? Number(e.target.value) : undefined })} />
                  : <input className="input mono" aria-label={`ნულებით შევსება ${i + 1}`} title="ნულებით შევსება მარცხნიდან (სიგრძე)" disabled={!edit} inputMode="numeric" value={c.pad ?? ''} onChange={(e) => col(i, { pad: e.target.value ? Number(e.target.value) : undefined })} />}</td>
                {format === 'xml' && <td><input className="input mono" aria-label={`XML ${i + 1}`} disabled={!edit} placeholder={c.field ?? ''} value={c.tag ?? ''} onChange={(e) => col(i, { tag: e.target.value || undefined })} /></td>}
                <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>{edit && <>
                  <button className="btn sm" type="button" aria-label="ზემოთ" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                  <button className="btn sm" type="button" aria-label="ქვემოთ" disabled={i === cfg.columns.length - 1} onClick={() => move(i, 1)}>↓</button>
                  <button className="btn sm" type="button" aria-label="წაშლა" onClick={() => up({ columns: cfg.columns.filter((_, j) => j !== i) })}>✕</button></>}</td>
              </tr>);
          })}</tbody>
        </table>
      </div>
      {edit && <div className="row"><button className="btn sm" type="button" onClick={() => up({ columns: [...cfg.columns, { header: '', field: '' }] })}>+ სვეტი</button>
        <span className="hint grow">შესაბამისობა: მნიშვნელობის ჩანაცვლება (მაგ. სქესი M=1; F=2, ტიპი ipd=1; opd=2). „ცარიელზე“ — რა ჩაიწეროს, თუ მნიშვნელობა არ არის.</span></div>}
    </div>
  );
}

function ResponseEditor({ cfg, set, edit }: { cfg: ResponseConfig; set: (c: ResponseConfig) => void; edit: boolean }) {
  const up = (p: Partial<ResponseConfig>) => set({ ...cfg, ...p });
  const col = (k: keyof ResponseConfig['columns'], v: string) => up({ columns: { ...cfg.columns, [k]: v } });
  const COLS: [keyof ResponseConfig['columns'], string, boolean][] = [['key', 'საიდენტიფიკაციო', true], ['status', 'სტატუსი', false], ['amount', 'თანხა', false], ['reason', 'უარის მიზეზი', false], ['note', 'შენიშვნა', false], ['ref', 'გადამხდელის №', false]];
  const [sm, setSm] = useState<Record<string, string>>(Object.fromEntries((['accepted', 'partial', 'rejected', 'pending'] as RespStatus[]).map((s) => [s, (cfg.status_map[s] ?? []).join('; ')])));
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="row" style={{ flexWrap: 'wrap', gap: 14, alignItems: 'flex-end' }}>
        <Field label="შემთხვევის ამოცნობა" htmlFor="cr-k"><select id="cr-k" className="select" disabled={!edit} value={cfg.key_field} onChange={(e) => up({ key_field: e.target.value })}>
          {Object.entries(RESP_KEY_KA).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="თანხის სვეტი" htmlFor="cr-a"><select id="cr-a" className="select" disabled={!edit} value={cfg.amount_kind} onChange={(e) => up({ amount_kind: e.target.value as 'approved' })}>
          <option value="approved">დამტკიცებული თანხა</option><option value="denied">უარყოფილი (მოკლებული) თანხა</option></select></Field>
        <Field label="CSV გამყოფი" htmlFor="cr-s"><select id="cr-s" className="select" disabled={!edit} value={cfg.csv_sep} onChange={(e) => up({ csv_sep: e.target.value })}>
          <option value=";">;</option><option value=",">,</option><option value={'\t'}>tab</option><option value="|">|</option></select></Field>
        <Field label="ათწილადი" htmlFor="cr-d"><select id="cr-d" className="select" disabled={!edit} value={cfg.decimal_sep} onChange={(e) => up({ decimal_sep: e.target.value as '.' })}>
          <option value=".">წერტილი</option><option value=",">მძიმე</option></select></Field>
        <label className="row small" style={{ height: 38 }}><input type="checkbox" disabled={!edit} checked={cfg.header_row} onChange={(e) => up({ header_row: e.target.checked })} /> პირველი ხაზი — სათაური</label>
      </div>
      <section className="card card-pad stack" style={{ gap: 8 }}>
        <strong className="small">ფაილის სვეტები — {cfg.header_row ? 'სათაურით (ან ასოთი: A, B …)' : 'ასოთი: A, B, C …'}</strong>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
          {COLS.map(([k, l, req]) => <Field key={k} label={l} htmlFor={`cr-c-${k}`} required={req}><input id={`cr-c-${k}`} className="input" disabled={!edit} value={cfg.columns[k] ?? ''} onChange={(e) => col(k, e.target.value)} /></Field>)}
        </div>
        <span className="hint">სტატუსი ან თანხა — მინიმუმ ერთი. სტატუსის გარეშე: თანხა = მოთხოვნილი → მიღებულია, 0 → უარყოფილია, სხვა → ნაწილობრივ. ფაილში არარსებული არასავალდებულო სვეტი გამოიტოვება.</span>
      </section>
      <section className="card card-pad stack" style={{ gap: 8 }}>
        <strong className="small">სტატუსის მნიშვნელობები ფაილში („;“-ით)</strong>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
          {(['accepted', 'partial', 'rejected', 'pending'] as RespStatus[]).map((s) => <Field key={s} label={RESP_KA[s]} htmlFor={`cr-s-${s}`}>
            <input id={`cr-s-${s}`} className="input" disabled={!edit} value={sm[s]} onChange={(e) => { setSm({ ...sm, [s]: e.target.value }); up({ status_map: { ...cfg.status_map, [s]: e.target.value.split(';').map((x) => x.trim()).filter(Boolean) } }); }} /></Field>)}
        </div>
        <span className="hint">უარის მიზეზი ემთხვევა ცნობარს: კოდით, „გადამხდელის კოდით“ ან დასახელებით; უცნობი → „სხვა“ (OTHER) — ტექსტი შენიშვნაში.</span>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- გადამხდელები
function Payers({ edit }: { edit: boolean }) {
  const qc = useQueryClient(); const toast = useToast();
  const p = useQuery({ queryKey: ['ctpl-payers'], queryFn: () => api<PayerTpl[]>('/claim-templates/payers') });
  const t = useQuery({ queryKey: ['ctpl', 'all'], queryFn: () => api<TemplateRow[]>('/claim-templates') });
  const m = useMutation({ mutationFn: (x: { id: string; body: Record<string, string | null> }) => api(`/claim-templates/payers/${x.id}`, { method: 'PUT', body: x.body }),
    onSuccess: () => { toast.show('შენახულია'); void qc.invalidateQueries({ queryKey: ['ctpl-payers'] }); void qc.invalidateQueries({ queryKey: ['ctpl'] }); } });
  const opts = (k: 'export' | 'response') => (t.data ?? []).filter((x) => x.kind === k && x.is_active);
  return (
    <section className="card">
      {toast.node}
      <div className="card-head"><strong>გადამხდელის ნაგულისხმევი შაბლონები</strong></div>
      <ErrorBox error={p.error ?? m.error} />
      {p.isLoading ? <Loading /> : (
        <table className="table">
          <thead><tr><th>გადამხდელი</th><th>ექსპორტი</th><th>პასუხი</th></tr></thead>
          <tbody>{p.data?.map((x) => (
            <tr key={x.id} style={x.is_active ? undefined : { opacity: 0.55 }}>
              <td><strong>{x.name}</strong> <span className="small muted mono">{x.code}</span></td>
              {(['export', 'response'] as const).map((k) => (
                <td key={k}><select className="select" aria-label={`${k} — ${x.name}`} disabled={!edit} value={x[`${k}_template_id`] ?? ''}
                  onChange={(e) => m.mutate({ id: x.id, body: { [`${k}_template_id`]: e.target.value || null } })}>
                  <option value="">— არ არის —</option>{opts(k).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                  {x[`${k}_template_id`] && !opts(k).some((o) => o.id === x[`${k}_template_id`]) && <option value={x[`${k}_template_id`]!}>{x[`${k}_template_name`]} (გამორთული)</option>}
                </select></td>))}
            </tr>))}</tbody>
        </table>)}
    </section>
  );
}

// ---------------------------------------------------------------- უარის მიზეზები
function Reasons({ meta, edit }: { meta: ExportMeta; edit: boolean }) {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['denial-reasons'], queryFn: () => api<DenialReason[]>('/denial-reasons') });
  const [dlg, setDlg] = useState<DenialReason | 'new' | null>(null);
  return (
    <section className="card">
      {toast.node}
      <div className="card-head row"><strong className="grow">უარის მიზეზები</strong>{edit && <button className="btn primary sm" type="button" onClick={() => setDlg('new')}>+ მიზეზი</button>}</div>
      <span className="hint card-pad" style={{ display: 'block', paddingTop: 0 }}>„ნაგულისხმევი გადაწყვეტა“ — ქლეიმზე „უარების გადაწყვეტა“ ამ ქმედებას იყენებს (პაციენტზე გადატანა / ჩამოწერა); ცარიელი — ხელით.</span>
      <ErrorBox error={q.error} />
      {q.isLoading ? <Loading /> : (
        <table className="table">
          <thead><tr><th>კოდი</th><th>დასახელება</th><th>კატეგორია</th><th>გადამხდელის კოდები</th><th>შემოწმების წესები</th><th>ნაგულისხმევი გადაწყვეტა</th><th className="num">გამოყენება</th></tr></thead>
          <tbody>{q.data?.map((r) => (
            <tr key={r.code} className="clickable" onClick={() => setDlg(r)} style={r.is_active ? undefined : { opacity: 0.55 }}>
              <td className="mono">{r.code}</td><td><strong>{r.title}</strong></td><td className="small">{r.category_ka}</td>
              <td className="mono small">{r.external_codes.join(', ') || '—'}</td><td className="mono small">{r.scrub_rules.join(', ') || <span className="muted">—</span>}</td><td className="small">{r.default_action ? ACTION_KA[r.default_action] : <span className="muted">ხელით</span>}</td>
              <td className="num">{r.used || '—'}</td></tr>))}</tbody>
        </table>)}
      {dlg && <ReasonDialog r={dlg === 'new' ? null : dlg} meta={meta} edit={edit} onClose={() => setDlg(null)}
        onDone={() => { setDlg(null); toast.show('შენახულია'); void qc.invalidateQueries({ queryKey: ['denial-reasons'] }); }} />}
    </section>
  );
}

function ReasonDialog({ r, meta, edit, onClose, onDone }: { r: DenialReason | null; meta: ExportMeta; edit: boolean; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ code: r?.code ?? '', title: r?.title ?? '', category: r?.category ?? 'other', ext: r?.external_codes.join('; ') ?? '', action: r?.default_action ?? '',
    is_active: r?.is_active ?? true, sort: String(r?.sort_order ?? 100), rules: r?.scrub_rules ?? [] });
  const rules = useQuery({ queryKey: ['scrub-rules'], queryFn: () => api<{ code: string; title: string; is_active: boolean; group_ka: string }[]>('/scrub/rules') });
  const m = useMutation({
    mutationFn: () => {
      const body = { title: f.title.trim(), category: f.category, external_codes: f.ext.split(';').map((x) => x.trim()).filter(Boolean), default_action: f.action || null,
        is_active: f.is_active, sort_order: Number(f.sort) || 0, scrub_rules: f.rules };
      return r ? api(`/denial-reasons/${r.code}`, { method: 'PATCH', body }) : api('/denial-reasons', { body: { ...body, code: f.code.trim().toUpperCase() } });
    },
    onSuccess: onDone,
  });
  return (
    <Modal title={r ? `${r.code} — ${r.title}` : 'ახალი უარის მიზეზი'} onClose={onClose} width={860}
      footer={<><button className="btn" type="button" onClick={onClose}>დახურვა</button>{edit && <button className="btn primary" type="button" disabled={m.isPending || f.title.trim().length < 2 || !f.code} onClick={() => m.mutate()}>შენახვა</button>}</>}>
      <div className="stack" style={{ gap: 10 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '180px minmax(0, 1fr)', gap: 10 }}>
          <Field label="კოდი" htmlFor="dr-c" required><input id="dr-c" className="input mono" disabled={!!r || !edit} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
          <Field label="დასახელება" htmlFor="dr-t" required><input id="dr-t" className="input" disabled={!edit} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
          <Field label="კატეგორია" htmlFor="dr-k"><select id="dr-k" className="select" disabled={!edit} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
            {meta.categories.map((c) => <option key={c.code} value={c.code}>{c.title}</option>)}</select></Field>
          <Field label="ნაგულისხმევი გადაწყვეტა" htmlFor="dr-a"><select id="dr-a" className="select" disabled={!edit} value={f.action} onChange={(e) => setF({ ...f, action: e.target.value as '' })}>
            <option value="">ხელით</option><option value="patient">პაციენტზე გადატანა</option><option value="writeoff">ჩამოწერა</option></select></Field>
          <Field label="რიგი" htmlFor="dr-s"><input id="dr-s" className="input mono" disabled={!edit} inputMode="numeric" value={f.sort} onChange={(e) => setF({ ...f, sort: e.target.value })} /></Field>
        </div>
        <Field label="გადამხდელის კოდები / ტექსტები („;“-ით)" htmlFor="dr-e" hint="პასუხის ფაილში ასე წერია — იმპორტისას ემთხვევა ამ მიზეზს"><input id="dr-e" className="input mono" disabled={!edit} value={f.ext} onChange={(e) => setF({ ...f, ext: e.target.value })} /></Field>
        <div className="stack" style={{ gap: 4 }}>
          <span className="small muted">შემოწმების წესები, რომლებმაც ეს უარი გაგზავნამდე უნდა დაიჭიროს (უარის ანგარიში აჩვენებს — იჭერს თუ არა)</span>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '4px 14px', maxHeight: 230, overflow: 'auto', padding: 4, border: '1px solid var(--line, #e5e5e5)', borderRadius: 8 }}>
            {[...(rules.data ?? [])].sort((a, b) => Number((r?.scrub_rules ?? []).includes(b.code)) - Number((r?.scrub_rules ?? []).includes(a.code))).map((x) => (
            <label key={x.code} className="row small" title={x.code} style={x.is_active ? undefined : { opacity: 0.6 }}><input type="checkbox" disabled={!edit} checked={f.rules.includes(x.code)}
              onChange={() => setF({ ...f, rules: f.rules.includes(x.code) ? f.rules.filter((c) => c !== x.code) : [...f.rules, x.code] })} /> {x.title}</label>))}</div>
        </div>
        <label className="row small"><input type="checkbox" disabled={!edit} checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> ჩართული</label>
        <ErrorBox error={m.error} />
      </div>
    </Modal>
  );
}
