import { crc32, deflateRawSync } from 'node:zlib';

/**
 * მინიმალური XLSX (Office Open XML) — დამოკიდებულების გარეშე (0058).
 *  • ჩაწერა: ერთი ან რამდენიმე ფურცელი (writeXlsxBook, 0063), ტექსტი (inline) / რიცხვი (რიცხვის ფორმატით), სათაურის ხაზი (მუქი), სვეტის სიგანე.
 *  • წაკითხვა: stock/xlsx (readXlsx); CSV — მითითებული გამყოფით.
 * ZIP — deflate, ფიქსირებული თარიღით (ერთი და იგივე შიგთავსი → ერთი და იგივე ფაილი / sha256).
 */

// ---------------------------------------------------------------- ZIP
interface ZipEntry { name: string; data: Buffer }
export function zip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const comp = deflateRawSync(e.data);
    const crc = crc32(e.data) >>> 0;
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8);
    h.writeUInt16LE(0, 10); h.writeUInt16LE(0x21, 12);                         // 1980-01-01 00:00
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(e.data.length, 22);
    h.writeUInt16LE(name.length, 26); h.writeUInt16LE(0, 28);
    parts.push(h, name, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10);
    c.writeUInt16LE(0, 12); c.writeUInt16LE(0x21, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(e.data.length, 24);
    c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += h.length + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

// ---------------------------------------------------------------- XML
export const xmlEsc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
  // XML 1.0-ში დაუშვებელი სიმბოლოები
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
const colName = (i: number) => { let s = ''; i += 1; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
export const colIndex = (letters: string) => [...letters.toUpperCase()].reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1;

// ---------------------------------------------------------------- ჩაწერა
export type Cell = string | number | null | undefined | { v: number; fmt: string };
export interface SheetSpec { name: string; header?: string[]; rows: Cell[][]; widths?: (number | undefined)[]; boldRows?: number[] }

export function writeXlsx(s: SheetSpec): Buffer { return writeXlsxBook([s]); }

/** რამდენიმე ფურცელი ერთ წიგნში (0063 — მენეჯერული ანგარიში); სტილები საერთოა */
export function writeXlsxBook(sheets: SheetSpec[]): Buffer {
  if (!sheets.length) throw new Error('writeXlsxBook: ფურცელი არ არის');
  const fmts = new Map<string, number>();            // რიცხვის ფორმატი → style id (2..)
  const fmtId = (f: string) => { if (!fmts.has(f)) fmts.set(f, fmts.size + 2); return fmts.get(f)!; };
  const sheetXml = (s: SheetSpec) => {
    const rowsXml: string[] = []; let r = 0;
    const cell = (c: Cell, ci: number, rn: number, bold: boolean) => {
      const ref = `${colName(ci)}${rn}`;
      if (c === null || c === undefined || c === '') return '';
      if (typeof c === 'number') return Number.isFinite(c) ? `<c r="${ref}"${bold ? ' s="1"' : ''}><v>${c}</v></c>` : '';
      if (typeof c === 'object') return Number.isFinite(c.v) ? `<c r="${ref}" s="${fmtId(c.fmt)}"><v>${c.v}</v></c>` : '';
      return `<c r="${ref}" t="inlineStr"${bold ? ' s="1"' : ''}><is><t xml:space="preserve">${xmlEsc(c)}</t></is></c>`;
    };
    const all: Cell[][] = [...(s.header ? [s.header] : []), ...s.rows];
    const bold = new Set([...(s.header ? [0] : []), ...(s.boldRows ?? []).map((i) => i + (s.header ? 1 : 0))]);
    for (const row of all) { r++; rowsXml.push(`<row r="${r}">${row.map((c, i) => cell(c, i, r, bold.has(r - 1))).join('')}</row>`); }
    const cols = s.widths?.some((w) => w) ? `<cols>${s.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w || 12}" customWidth="1"/>`).join('')}</cols>` : '';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
      + `${s.header ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' : ''}`
      + `${cols}<sheetData>${rowsXml.join('')}</sheetData></worksheet>`;
  };
  const bodies = sheets.map(sheetXml);
  const numFmts = [...fmts.entries()].map(([f], i) => `<numFmt numFmtId="${164 + i}" formatCode="${xmlEsc(f)}"/>`).join('');
  const xfs = [...fmts.keys()].map((_, i) => `<xf numFmtId="${164 + i}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`).join('');
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + `${fmts.size ? `<numFmts count="${fmts.size}">${numFmts}</numFmts>` : ''}`
    + `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>`
    + `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>`
    + `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>`
    + `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>`
    + `<cellXfs count="${2 + fmts.size}"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>${xfs}</cellXfs>`
    + `</styleSheet>`;
  // ფურცლის სახელი: აკრძალული სიმბოლოების გარეშე, ≤ 31, უნიკალური
  const used = new Set<string>();
  const names = sheets.map((s, i) => {
    const base = s.name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31).trim() || `Sheet${i + 1}`; let nm = base; let k = 2;
    while (used.has(nm.toLowerCase())) { const suf = ` (${k++})`; nm = base.slice(0, 31 - suf.length) + suf; }
    used.add(nm.toLowerCase()); return nm;
  });
  const B = (x: string) => Buffer.from(x, 'utf8');
  return zip([
    { name: '[Content_Types].xml', data: B(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
      + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>`
      + `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
      + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
      + `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`) },
    { name: '_rels/.rels', data: B(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`) },
    { name: 'xl/workbook.xml', data: B(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" `
      + `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>`
      + names.map((nm, i) => `<sheet name="${xmlEsc(nm)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + `</sheets></workbook>`) },
    { name: 'xl/_rels/workbook.xml.rels', data: B(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
      + `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`) },
    ...bodies.map((b, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: B(b) })),
    { name: 'xl/styles.xml', data: B(styles) },
  ]);
}

// ---------------------------------------------------------------- წაკითხვა
/** XLSX — მარაგის მოდულის წამკითხველი (თარიღის უჯრები → YYYY-MM-DD) */
export { readXlsx } from '../stock/xlsx';

/** CSV → ხაზები (ბრჭყალები, გამყოფი, BOM) */
export function readCsv(text: string, sep: string): string[][] {
  const s = text.replace(/^﻿/, ''); const rows: string[][] = []; let row: string[] = []; let cur = ''; let q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; continue; }
    if (ch === '"') q = true;
    else if (ch === sep) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
