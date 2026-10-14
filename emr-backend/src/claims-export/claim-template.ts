import { createHash } from 'node:crypto';
import { EXPORT_FIELDS, FIELD_MAP, LIST_SEP, type RowData } from './export-fields';
import { type Cell, readCsv, readXlsx, writeXlsx, xmlEsc, colIndex } from './xlsx';

/**
 * 0058: შაბლონის კონფიგურაცია (claim_templates.config) — ვალიდაცია და გამოყენება.
 *  export   — სვეტები → ფაილი (xlsx / csv / xml)
 *  response — ფაილი → ხაზები (საიდენტიფიკაციო ველი, სტატუსი, თანხა, მიზეზი …)
 */
export interface ExportColumn {
  header: string; field?: string; const?: string; format?: string; map?: Record<string, string>; default?: string;
  width?: number; tag?: string; pad?: number; max_len?: number;
}
export interface ExportConfig {
  kinds: ('ipd' | 'opd')[]; header_row: boolean; total_row: boolean; date_format: string; decimal_sep: '.' | ','; list_sep: string;
  sheet_name: string; file_name: string; csv_sep: string; csv_bom: boolean; xml_root: string; xml_row: string; columns: ExportColumn[];
}
export const RESP_STATUSES = ['accepted', 'partial', 'rejected', 'pending'] as const;
export type RespStatus = (typeof RESP_STATUSES)[number];
export const RESP_KEYS = ['invoice_number', 'adm_no', 'personal_number', 'guarantee_no', 'seq'] as const;
export type RespKey = (typeof RESP_KEYS)[number];
export interface ResponseConfig {
  header_row: boolean; csv_sep: string; decimal_sep: '.' | ','; key_field: RespKey; amount_kind: 'approved' | 'denied';
  columns: { key: string; status?: string; amount?: string; reason?: string; note?: string; ref?: string };
  status_map: Partial<Record<RespStatus, string[]>>;
}

const DATE_FORMATS = ['YYYY-MM-DD', 'DD.MM.YYYY', 'DD/MM/YYYY', 'MM/DD/YYYY', 'YYYYMMDD', 'DD-MM-YYYY', 'YYYY.MM.DD'];
const NUM_FMT_RE = /^0(\.0{1,6})?$/;
const TAG_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,59}$/;
export const FILE_TOKENS = ['claim_no', 'payer_code', 'period_from', 'period_to', 'date', 'template'];

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const str = (x: unknown, max = 200) => (typeof x === 'string' ? x.slice(0, max) : undefined);

/** export-ის კონფიგურაცია: ნაგულისხმევები + შემოწმება; აბრუნებს [config, შეცდომები] */
export function validateExport(raw: unknown, format: string): { cfg: ExportConfig; errors: string[] } {
  const c = isObj(raw) ? raw : {}; const errors: string[] = [];
  const kinds = Array.isArray(c.kinds) ? c.kinds.filter((k): k is 'ipd' | 'opd' => k === 'ipd' || k === 'opd') : ['ipd', 'opd'] as ('ipd' | 'opd')[];
  if (!kinds.length) errors.push('შემთხვევის ტიპი: მინიმუმ ერთი (სტაციონარი / ამბულატორია)');
  const date_format = str(c.date_format) ?? 'DD.MM.YYYY';
  if (!DATE_FORMATS.includes(date_format)) errors.push(`თარიღის ფორმატი: ${DATE_FORMATS.join(' | ')}`);
  const decimal_sep = c.decimal_sep === ',' ? ',' : '.';
  const csv_sep = str(c.csv_sep, 2) ?? ';';
  if (![';', ',', '\t', '|'].includes(csv_sep)) errors.push('CSV გამყოფი: ; , | ან tab');
  if (format === 'csv' && csv_sep === decimal_sep) errors.push('CSV გამყოფი და ათწილადის გამყოფი ერთი და იგივეა');
  const xml_root = str(c.xml_root, 60) ?? 'Cases'; const xml_row = str(c.xml_row, 60) ?? 'Case';
  if (format === 'xml' && (!TAG_RE.test(xml_root) || !TAG_RE.test(xml_row))) errors.push('XML: ძირის / ხაზის ელემენტის სახელი — ლათ. ასოები, ციფრები, _ . -');
  const file_name = str(c.file_name, 120) ?? '{payer_code}_{claim_no}';
  for (const m of file_name.matchAll(/\{([^}]*)\}/g)) if (!FILE_TOKENS.includes(m[1])) errors.push(`ფაილის სახელი: უცნობი ჩანაცვლება {${m[1]}} (${FILE_TOKENS.map((t) => `{${t}}`).join(' ')})`);
  const cols: ExportColumn[] = [];
  const rawCols = Array.isArray(c.columns) ? c.columns : [];
  if (!rawCols.length) errors.push('სვეტები: მინიმუმ ერთი');
  if (rawCols.length > 150) errors.push('სვეტები: მაქსიმუმ 150');
  const tags = new Set<string>();
  rawCols.slice(0, 150).forEach((x, i) => {
    const n = `სვეტი ${i + 1}`;
    if (!isObj(x)) { errors.push(`${n}: არასწორი`); return; }
    const col: ExportColumn = { header: str(x.header) ?? '' };
    if (!col.header.trim() && format !== 'xml') errors.push(`${n}: სათაური სავალდებულოა`);
    const field = str(x.field, 60); const cst = typeof x.const === 'string' ? x.const.slice(0, 500) : undefined;
    if (field && cst !== undefined) errors.push(`${n}: ველი ან მუდმივი — ერთ-ერთი`);
    if (!field && cst === undefined) errors.push(`${n}: აირჩიეთ ველი ან ჩაწერეთ მუდმივი მნიშვნელობა`);
    if (field) { if (!FIELD_MAP.has(field)) errors.push(`${n}: უცნობი ველი „${field}“`); col.field = field; }
    if (cst !== undefined) col.const = cst;
    const f = field ? FIELD_MAP.get(field) : undefined;
    const fmt = str(x.format, 20);
    if (fmt) {
      if (f?.type === 'date' && !DATE_FORMATS.includes(fmt)) errors.push(`${n}: თარიღის ფორმატი — ${DATE_FORMATS.join(' | ')}`);
      else if ((f?.type === 'number' || f?.type === 'int') && !NUM_FMT_RE.test(fmt)) errors.push(`${n}: რიცხვის ფორმატი — 0, 0.0, 0.00 …`);
      else if (!f || f.type === 'text') errors.push(`${n}: ფორმატი მხოლოდ თარიღს / რიცხვს`);
      col.format = fmt;
    }
    if (x.map !== undefined) {
      if (!isObj(x.map) || Object.values(x.map).some((v) => typeof v !== 'string') || Object.keys(x.map).length > 200) errors.push(`${n}: შესაბამისობა — {"მნიშვნელობა": "ჩანაცვლება"}`);
      else if (Object.keys(x.map).length) col.map = x.map as Record<string, string>;
    }
    if (typeof x.default === 'string' && x.default !== '') col.default = x.default.slice(0, 200);
    if (x.width !== undefined && x.width !== null) { const w = Number(x.width); if (!(w >= 2 && w <= 100)) errors.push(`${n}: სიგანე 2–100`); else col.width = w; }
    if (x.pad !== undefined && x.pad !== null) { const p = Number(x.pad); if (!(Number.isInteger(p) && p >= 1 && p <= 30)) errors.push(`${n}: ნულებით შევსება 1–30`); else col.pad = p; }
    if (x.max_len !== undefined && x.max_len !== null) { const p = Number(x.max_len); if (!(Number.isInteger(p) && p >= 1 && p <= 5000)) errors.push(`${n}: მაქს. სიგრძე 1–5000`); else col.max_len = p; }
    if (format === 'xml') {
      const tag = str(x.tag, 60) || field || '';
      if (!TAG_RE.test(tag)) errors.push(`${n}: XML ელემენტის სახელი (tag) — ლათ. ასოები, ციფრები, _ . -`);
      else if (tags.has(tag)) errors.push(`${n}: XML ელემენტი „${tag}“ მეორდება`);
      tags.add(tag); col.tag = tag;
    }
    cols.push(col);
  });
  const cfg: ExportConfig = {
    kinds, header_row: c.header_row !== false, total_row: c.total_row === true, date_format, decimal_sep, list_sep: typeof c.list_sep === 'string' ? c.list_sep.slice(0, 5) : ', ',
    sheet_name: str(c.sheet_name, 31) || 'Claim', file_name, csv_sep, csv_bom: c.csv_bom !== false, xml_root, xml_row, columns: cols,
  };
  return { cfg, errors };
}

export function validateResponse(raw: unknown): { cfg: ResponseConfig; errors: string[] } {
  const c = isObj(raw) ? raw : {}; const errors: string[] = [];
  const key_field = (RESP_KEYS as readonly string[]).includes(String(c.key_field)) ? c.key_field as RespKey : 'invoice_number';
  if (c.key_field !== undefined && key_field !== c.key_field) errors.push(`საიდენტიფიკაციო ველი: ${RESP_KEYS.join(' | ')}`);
  const cols = isObj(c.columns) ? c.columns : {};
  const col = (k: string) => (typeof cols[k] === 'string' && (cols[k] as string).trim() ? (cols[k] as string).trim().slice(0, 100) : undefined);
  const columns = { key: col('key') ?? '', status: col('status'), amount: col('amount'), reason: col('reason'), note: col('note'), ref: col('ref') };
  if (!columns.key) errors.push('სვეტი „საიდენტიფიკაციო“ სავალდებულოა');
  if (!columns.status && !columns.amount) errors.push('მიუთითეთ სტატუსის ან თანხის სვეტი (ან ორივე)');
  const csv_sep = str(c.csv_sep, 2) ?? ';';
  if (![';', ',', '\t', '|'].includes(csv_sep)) errors.push('CSV გამყოფი: ; , | ან tab');
  const sm: Partial<Record<RespStatus, string[]>> = {};
  if (isObj(c.status_map)) for (const s of RESP_STATUSES) {
    const v = c.status_map[s];
    if (v === undefined) continue;
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) { errors.push(`სტატუსები: ${s} — ტექსტების სია`); continue; }
    sm[s] = v.map((x) => x.trim()).filter(Boolean).slice(0, 30);
  }
  const seen = new Map<string, string>();
  for (const [s, vals] of Object.entries(sm)) for (const v of vals ?? []) {
    const k = v.toLowerCase();
    if (seen.has(k) && seen.get(k) !== s) errors.push(`სტატუსები: „${v}“ ორ სტატუსშია`);
    seen.set(k, s);
  }
  if (!c.header_row && c.header_row !== undefined) {
    for (const [k, v] of Object.entries(columns)) if (v && !/^[A-Z]{1,3}$/i.test(v)) errors.push(`სათაურის გარეშე სვეტი მიეთითება ასოთი (A, B …): ${k} = „${v}“`);
  }
  return { cfg: { header_row: c.header_row !== false, csv_sep, decimal_sep: c.decimal_sep === ',' ? ',' : '.', key_field, amount_kind: c.amount_kind === 'denied' ? 'denied' : 'approved', columns, status_map: sm }, errors };
}

// ---------------------------------------------------------------- ექსპორტი
const fmtDate = (iso: string, f: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso); if (!m) return iso;
  return f.replace('YYYY', m[1]).replace('MM', m[2]).replace('DD', m[3]);
};
const decimals = (fmt: string | undefined, dflt: number) => (fmt ? (fmt.split('.')[1]?.length ?? 0) : dflt);

/** ერთი უჯრა: { text — csv / xml; cell — xlsx } */
function cellValue(col: ExportColumn, data: RowData, cfg: ExportConfig): { text: string; cell: Cell } {
  if (col.const !== undefined) return { text: col.const, cell: col.const };
  const f = FIELD_MAP.get(col.field!)!;
  let v = data[col.field!];
  if (v === null || v === undefined || v === '') {
    const d = col.default ?? ''; return { text: d, cell: d };
  }
  let text: string; let cell: Cell;
  if (f.type === 'date') { text = fmtDate(String(v), col.format ?? cfg.date_format); cell = text; }
  else if (f.type === 'number' || f.type === 'int') {
    const dec = decimals(col.format, f.type === 'int' ? 0 : f.key === 'drg_weight' ? 4 : 2);
    const num = Number(v);
    text = num.toFixed(dec); if (cfg.decimal_sep === ',') text = text.replace('.', ',');
    cell = { v: Number(num.toFixed(dec)), fmt: dec ? `0.${'0'.repeat(dec)}` : '0' };
  } else {
    v = String(v);
    text = v.split(LIST_SEP).join(cfg.list_sep); cell = text;
  }
  if (col.map) {
    const key = f.type === 'text' ? String(data[col.field!]).split(LIST_SEP).join(cfg.list_sep) : text;
    if (Object.prototype.hasOwnProperty.call(col.map, key)) { text = col.map[key]; cell = text; }
  }
  if (col.pad && text.length < col.pad) { text = text.padStart(col.pad, '0'); cell = text; }
  if (col.max_len && text.length > col.max_len) { text = text.slice(0, col.max_len); cell = text; }
  return { text, cell };
}

export interface ExportMeta { claim_no: string | null; payer_code: string; period_from: string; period_to: string; today: string; template_code: string }
export interface Rendered { content: Buffer; file_name: string; content_type: string; rows: number; total: number; sha256: string; preview: { header: string[]; rows: string[][] } }

export function renderExport(format: string, cfg: ExportConfig, items: { kind: 'ipd' | 'opd'; data: RowData }[], meta: ExportMeta): Rendered {
  const rows = items.filter((x) => cfg.kinds.includes(x.kind));
  // რიგითი № — ფილტრის შემდეგ
  rows.forEach((r, i) => { r.data = { ...r.data, seq: i + 1 }; });
  const header = cfg.columns.map((c) => c.header);
  const cells = rows.map((r) => cfg.columns.map((c) => cellValue(c, r.data, cfg)));
  const total = Math.round(rows.reduce((s, r) => s + Number(r.data.claimed ?? 0), 0) * 100) / 100;
  // ჯამის ხაზი: შესაჯამებელი ველები (მოთხოვნილი, ჯამი, წილი, DRG თანხა)
  let totalCells: { text: string; cell: Cell }[] | null = null;
  if (cfg.total_row && format !== 'xml') {
    totalCells = cfg.columns.map((c, i) => {
      const f = c.field ? FIELD_MAP.get(c.field) : undefined;
      if (f?.sum) {
        const s = Math.round(rows.reduce((a, r) => a + Number(r.data[f.key] ?? 0), 0) * 100) / 100;
        const dec = decimals(c.format, 2); let t = s.toFixed(dec); if (cfg.decimal_sep === ',') t = t.replace('.', ',');
        return { text: t, cell: { v: s, fmt: dec ? `0.${'0'.repeat(dec)}` : '0' } };
      }
      return i === 0 ? { text: 'ჯამი', cell: 'ჯამი' } : { text: '', cell: null };
    });
  }
  const fileBase = cfg.file_name.replace(/\{(\w+)\}/g, (_, k: string) => ({ claim_no: meta.claim_no ?? 'draft', payer_code: meta.payer_code, period_from: meta.period_from,
    period_to: meta.period_to, date: meta.today, template: meta.template_code } as Record<string, string>)[k] ?? '').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 120) || 'claim';
  let content: Buffer; let content_type: string; let ext: string;
  if (format === 'xlsx') {
    content = writeXlsx({ name: cfg.sheet_name, header: cfg.header_row ? header : undefined, rows: [...cells.map((r) => r.map((x) => x.cell)), ...(totalCells ? [totalCells.map((x) => x.cell)] : [])],
      widths: cfg.columns.map((c) => c.width), boldRows: totalCells ? [cells.length] : [] });
    content_type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'; ext = 'xlsx';
  } else if (format === 'csv') {
    const sep = cfg.csv_sep;
    const esc = (t: string) => (t.includes(sep) || /["\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t);
    const lines = [...(cfg.header_row ? [header.map(esc).join(sep)] : []), ...cells.map((r) => r.map((x) => esc(x.text)).join(sep)), ...(totalCells ? [totalCells.map((x) => esc(x.text)).join(sep)] : [])];
    content = Buffer.from((cfg.csv_bom ? '﻿' : '') + lines.join('\r\n') + '\r\n', 'utf8');
    content_type = 'text/csv; charset=utf-8'; ext = 'csv';
  } else {
    const body = cells.map((r) => `  <${cfg.xml_row}>\n${r.map((x, i) => `    <${cfg.columns[i].tag}>${xmlEsc(x.text)}</${cfg.columns[i].tag}>`).join('\n')}\n  </${cfg.xml_row}>`).join('\n');
    content = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n<${cfg.xml_root} count="${rows.length}" total="${total.toFixed(2)}">\n${body}${body ? '\n' : ''}</${cfg.xml_root}>\n`, 'utf8');
    content_type = 'application/xml; charset=utf-8'; ext = 'xml';
  }
  return { content, file_name: `${fileBase}.${ext}`, content_type, rows: rows.length, total, sha256: createHash('sha256').update(content).digest('hex'),
    preview: { header, rows: cells.slice(0, 50).map((r) => r.map((x) => x.text)) } };
}

// ---------------------------------------------------------------- პასუხის წაკითხვა
export interface ParsedResp { row: number; key: string; status?: RespStatus; status_raw?: string; amount?: number; reason_raw?: string; note?: string; ref?: string; error?: string }

export function parseResponseFile(buf: Buffer, fileName: string, cfg: ResponseConfig): ParsedResp[] {
  const isX = /\.xlsx$/i.test(fileName) || buf.subarray(0, 2).toString('latin1') === 'PK';
  const grid = isX ? readXlsx(buf) : readCsv(buf.toString('utf8'), cfg.csv_sep);
  const head = cfg.header_row ? (grid[0] ?? []).map((h) => h.trim().toLowerCase()) : [];
  const idx = (spec: string | undefined) => {
    if (!spec) return -1;
    if (cfg.header_row) { const i = head.indexOf(spec.trim().toLowerCase()); if (i >= 0) return i; }
    return /^[A-Z]{1,3}$/i.test(spec) ? colIndex(spec) : -2;
  };
  const ci = { key: idx(cfg.columns.key), status: idx(cfg.columns.status), amount: idx(cfg.columns.amount), reason: idx(cfg.columns.reason), note: idx(cfg.columns.note), ref: idx(cfg.columns.ref) };
  // სავალდებულო: გასაღები + (სტატუსი ან თანხა); სხვა (მიზეზი, შენიშვნა, №) — ფაილში თუ არ არის, გამოიტოვება
  const miss = (k: keyof typeof ci) => `„${cfg.columns[k]}“`;
  if (ci.key === -2) throw new Error(`ფაილში საიდენტიფიკაციო სვეტი ${miss('key')} ვერ მოიძებნა`);
  if ((ci.status < 0) && (ci.amount < 0)) throw new Error(`ფაილში არც სტატუსის (${cfg.columns.status ? miss('status') : '—'}), არც თანხის (${cfg.columns.amount ? miss('amount') : '—'}) სვეტი არ არის`);
  for (const k of Object.keys(ci) as (keyof typeof ci)[]) if (ci[k] === -2) ci[k] = -1;
  const statusOf = new Map<string, RespStatus>();
  for (const [s, vals] of Object.entries(cfg.status_map)) for (const v of vals ?? []) statusOf.set(v.toLowerCase(), s as RespStatus);
  const out: ParsedResp[] = [];
  grid.forEach((r, i) => {
    if (cfg.header_row && i === 0) return;
    const g = (k: number) => (k >= 0 ? (r[k] ?? '').trim() : '');
    const key = g(ci.key);
    if (!key && r.every((x) => !String(x ?? '').trim())) return;                 // ცარიელი ხაზი
    const p: ParsedResp = { row: i + 1, key };
    if (!key) { p.error = 'საიდენტიფიკაციო ველი ცარიელია'; out.push(p); return; }
    const sr = g(ci.status);
    if (ci.status >= 0 && sr) {
      p.status_raw = sr; p.status = statusOf.get(sr.toLowerCase());
      if (!p.status) p.error = `უცნობი სტატუსი „${sr}“`;
    }
    const ar = g(ci.amount);
    if (ci.amount >= 0 && ar) {
      const t = ar.replace(/\s/g, '').replace(cfg.decimal_sep === ',' ? ',' : /,/g, cfg.decimal_sep === ',' ? '.' : '');
      const n = Number(t);
      if (!Number.isFinite(n) || n < 0) p.error = p.error ?? `თანხა არასწორია „${ar}“`; else p.amount = Math.round(n * 100) / 100;
    }
    const rr = g(ci.reason); if (rr) p.reason_raw = rr;
    const nt = g(ci.note); if (nt) p.note = nt.slice(0, 1000);
    const rf = g(ci.ref); if (rf) p.ref = rf.slice(0, 60);
    out.push(p);
  });
  return out;
}

export const FIELDS_FOR_UI = EXPORT_FIELDS;
export const DATE_FORMAT_LIST = DATE_FORMATS;
