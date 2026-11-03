/**
 * მინიმალური .xlsx წამკითხველი / ჩამწერი — დამატებითი პაკეტის გარეშე (zip: node:zlib).
 *  - readSheet: პირველი ფურცელი → სტრიქონების მასივი (უჯრები ტექსტად; რიცხვი — როგორც წერია; თარიღი — Excel-ის სერიული რიცხვი → YYYY-MM-DD)
 *  - writeSheet: ერთი ფურცელი, ტექსტური უჯრები, სათაურის სტრიქონი მუქად (შაბლონისთვის)
 *  - CSV (UTF-8, „,“ ან „;“) — readCsv
 */
import { crc32, inflateRawSync } from 'node:zlib';

// ------------------------------------------------------------------ zip
function unzip(buf: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('ფაილი არ არის .xlsx (zip)');
  const n = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16);
  for (let k = 0; k < n; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('დაზიანებული .xlsx');
    const method = buf.readUInt16LE(p + 10); const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28); const extraLen = buf.readUInt16LE(p + 30); const commLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42); const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const lName = buf.readUInt16LE(local + 26); const lExtra = buf.readUInt16LE(local + 28);
    const data = buf.subarray(local + 30 + lName + lExtra, local + 30 + lName + lExtra + csize);
    if (name.endsWith('.xml') || name.endsWith('.rels')) files.set(name, method === 0 ? Buffer.from(data) : method === 8 ? inflateRawSync(data) : Buffer.alloc(0));
    p += 46 + nameLen + extraLen + commLen;
  }
  return files;
}

function zip(entries: [string, string][]): Buffer {
  const parts: Buffer[] = []; const central: Buffer[] = []; let off = 0;
  for (const [name, text] of entries) {
    const data = Buffer.from(text, 'utf8'); const nm = Buffer.from(name, 'utf8'); const crc = crc32(data);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(0, 8);
    h.writeUInt32LE(crc >>> 0, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(nm.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8);
    c.writeUInt32LE(crc >>> 0, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nm.length, 28); c.writeUInt32LE(off, 42);
    parts.push(h, nm, data); central.push(c, nm); off += 30 + nm.length + data.length;
  }
  const cd = Buffer.concat(central); const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(entries.length, 8); e.writeUInt16LE(entries.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, e]);
}

// ------------------------------------------------------------------ xml
const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d))).replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, '&');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const textOf = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unesc(m[1])).join('');
const colIdx = (ref: string) => { const l = /^[A-Z]+/.exec(ref)?.[0] ?? 'A'; let n = 0; for (const ch of l) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
const colName = (i: number) => { let s = ''; i += 1; while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); } return s; };

export function readXlsx(buf: Buffer): string[][] {
  const f = unzip(buf);
  const shared = [...(f.get('xl/sharedStrings.xml')?.toString('utf8') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
  // თარიღის სტილები (numFmt 14–22 ან თარიღის საკუთარი ფორმატი)
  const styles = f.get('xl/styles.xml')?.toString('utf8') ?? '';
  const customDate = new Set([...styles.matchAll(/<numFmt numFmtId="(\d+)" formatCode="([^"]*)"/g)].filter((m) => /[yd]/i.test(m[2]) && !/[#0]/.test(m[2])).map((m) => Number(m[1])));
  const xfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? '';
  const dateStyle = [...xfs.matchAll(/<xf\b[^>]*?numFmtId="(\d+)"/g)].map((m) => { const id = Number(m[1]); return (id >= 14 && id <= 22) || customDate.has(id); });
  // პირველი ფურცელი workbook-ის რიგით
  const wb = f.get('xl/workbook.xml')?.toString('utf8') ?? '';
  const rid = /<sheet\b[^>]*r:id="([^"]+)"/.exec(wb)?.[1];
  const rels = f.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '';
  const target = rid ? new RegExp(`<Relationship[^>]*Id="${rid}"[^>]*Target="([^"]+)"`).exec(rels)?.[1] ?? new RegExp(`<Relationship[^>]*Target="([^"]+)"[^>]*Id="${rid}"`).exec(rels)?.[1] : undefined;
  const path = target ? (target.startsWith('/') ? target.slice(1) : `xl/${target}`) : 'xl/worksheets/sheet1.xml';
  const sheet = f.get(path)?.toString('utf8');
  if (!sheet) throw new Error('ფურცელი ვერ მოიძებნა');
  const body = sheet.replace(/<row\b[^>]*\/>/g, '');
  const rows: string[][] = [];
  for (const r of body.matchAll(/<row\b[^>]*?(?:r="(\d+)")?[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: string[] = [];
    for (const c of r[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1]; const body = c[2] ?? '';
      const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1]; const t = /t="(\w+)"/.exec(attrs)?.[1]; const s = Number(/s="(\d+)"/.exec(attrs)?.[1] ?? -1);
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let val = '';
      if (t === 's') val = shared[Number(v)] ?? '';
      else if (t === 'inlineStr') val = textOf(body);
      else if (t === 'str' || t === 'e') val = v ? unesc(v) : '';
      else if (t === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
      else if (v !== undefined) {
        val = v;
        if (dateStyle[s] && /^\d+(\.\d+)?$/.test(v)) val = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(v)) * 86_400_000).toISOString().slice(0, 10);
      }
      row[ref ? colIdx(ref) : row.length] = val;
    }
    rows.push(Array.from(row, (x) => (x ?? '').trim()));
  }
  return rows;
}

export function readCsv(text: string): string[][] {
  const t = text.replace(/^\uFEFF/, '');
  const first = t.split(/\r?\n/, 1)[0] ?? '';
  const sep = (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ';' : first.includes('\t') && !first.includes(',') ? '\t' : ',';
  const rows: string[][] = []; let row: string[] = []; let cur = ''; let q = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) { if (ch === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; continue; }
    if (ch === '"') q = true;
    else if (ch === sep) { row.push(cur.trim()); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && t[i + 1] === '\n') i++; row.push(cur.trim()); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur || row.length) { row.push(cur.trim()); rows.push(row); }
  return rows;
}

/** ერთფურცლიანი .xlsx: header — მუქად, სვეტის სიგანეებით */
export function writeXlsx(sheetName: string, rows: string[][], widths: number[] = []): Buffer {
  const cells = rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => `<c r="${colName(ci)}${ri + 1}" t="inlineStr"${ri === 0 ? ' s="1"' : ''}><is><t xml:space="preserve">${esc(v)}</t></is></c>`).join('')}</row>`).join('');
  const cols = widths.length ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
  return zip([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${esc(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
    ['xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'],
    ['xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${cols}<sheetData>${cells}</sheetData></worksheet>`],
  ]);
}
