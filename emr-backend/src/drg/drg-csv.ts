/** CSV (0055): წაკითხვა — გამყოფი ; / TAB / , (პირველი სტრიქონით), ბრჭყალები, BOM; ჩაწერა — UTF-8 BOM, „;“ (Excel). */
export function parseCsv(text: string): string[][] {
  const t = text.replace(/^﻿/, '');
  const first = t.split(/\r?\n/).find((l) => l.trim()) ?? '';
  const sep = [';', '\t', ','].find((s) => first.includes(s)) ?? ';';
  const rows: string[][] = [];
  let row: string[] = []; let cur = ''; let q = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) {
      if (ch === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cur.trim()); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && t[i + 1] === '\n') i++;
      row.push(cur.trim()); cur = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else cur += ch;
  }
  row.push(cur.trim());
  if (row.some((c) => c !== '')) rows.push(row);
  return rows;
}
const cell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const buildCsv = (head: string[], rows: unknown[][]) => `﻿${[head, ...rows].map((r) => r.map(cell).join(';')).join('\r\n')}\r\n`;
export const num = (s: string | undefined) => (s === undefined || s.trim() === '' ? null : Number(s.trim().replace(',', '.')));
