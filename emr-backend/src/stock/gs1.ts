/**
 * შტრიხკოდები: GTIN/EAN-ის ნორმალიზება და GS1 (DataMatrix / GS1-128) გაშიფვრა.
 *
 *  - EAN-8 / UPC-A (12) / EAN-13 / GTIN-14 → GTIN-14 (წინ ნულებით); საკონტროლო ციფრი მოწმდება
 *  - GS1 ელემენტები: (01) GTIN, (17) ვადა YYMMDD (DD=00 → თვის ბოლო დღე), (10) ლოტი, (21) სერიული, (11) წარმოების თარიღი
 *    ფორმატები: ფრჩხილებით „(01)…(17)…(10)…“, ან სკანერის ნედლი — FNC1 = ASCII 29 (GS), სიმბოლოების იდენტიფიკატორი ]d2 / ]C1 / ]Q3
 *  - სხვა (შიდა) კოდი — დიდი ასოებით, უცვლელად
 */

export interface Gs1Parsed {
  format: 'gs1' | 'gtin' | 'other';
  gtin: string | null;
  lot: string | null;
  serial: string | null;
  expiry: string | null;        // YYYY-MM-DD
  produced: string | null;
  normalized: string;           // ძიების გასაღები: GTIN-14 ან შიდა კოდი
  warnings: string[];
}

const GS = '\u001d';
// AI → ფიქსირებული სიგრძე (null = ცვლადი, max 20 / GS-მდე)
const AI: Record<string, number | null> = { '00': 18, '01': 14, '02': 14, '10': null, '11': 6, '13': 6, '15': 6, '17': 6, '21': null, '30': null, '240': null, '241': null };

/** GS1 საკონტროლო ციფრი (mod 10) */
export function gtinCheckOk(digits: string) {
  const d = digits.split('').map(Number);
  const check = d.pop()!;
  const sum = d.reverse().reduce((s, x, i) => s + x * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

/** შტრიხკოდის შენახვის / ძიების ფორმა */
export function normalizeBarcode(raw: string): string {
  const s = raw.trim().replace(/\s+/g, '');
  if (/^\d{8}$|^\d{12,14}$/.test(s)) return s.padStart(14, '0');
  return s.toUpperCase();
}

function yymmdd(v: string): string | null {
  if (!/^\d{6}$/.test(v)) return null;
  const y = 2000 + Number(v.slice(0, 2)); const m = Number(v.slice(2, 4)); let d = Number(v.slice(4, 6));
  if (m < 1 || m > 12) return null;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d === 0) d = last;                       // GS1: DD=00 — თვის ბოლო დღე
  if (d > last) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function parseBarcode(raw: string): Gs1Parsed {
  const warnings: string[] = [];
  let s = raw.replace(/\r|\n/g, '').trim();
  s = s.replace(/^\][A-Za-z]\d/, '');            // ]d2, ]C1, ]Q3 — სიმბოლოების იდენტიფიკატორი
  s = s.replace(/<GS>|\\x1d|\{GS\}|~1/gi, GS);    // სკანერის / ტესტის ჩანაცვლებები
  const out: Gs1Parsed = { format: 'other', gtin: null, lot: null, serial: null, expiry: null, produced: null, normalized: '', warnings };
  const fields: Record<string, string> = {};

  if (/^\(\d{2,4}\)/.test(s)) {                   // ფრჩხილებიანი ფორმა
    const re = /\((\d{2,4})\)([^(]*)/g; let m: RegExpExecArray | null;
    while ((m = re.exec(s))) fields[m[1]] = m[2].replace(new RegExp(GS, 'g'), '');
  } else if (/^\d{2}/.test(s) && (s.includes(GS) || /^01\d{14}(1[017]|21|11)/.test(s))) {   // ნედლი GS1 ელემენტები
    let i = 0;
    while (i < s.length) {
      if (s[i] === GS) { i++; continue; }
      const ai = ['240', '241'].find((a) => s.startsWith(a, i)) ?? s.slice(i, i + 2);
      if (!(ai in AI)) { warnings.push(`უცნობი GS1 ელემენტი (${ai}) — დანარჩენი გამოტოვებულია`); break; }
      i += ai.length;
      const len = AI[ai];
      if (len) { fields[ai] = s.slice(i, i + len); i += len; }
      else {
        const end = s.indexOf(GS, i); const stop = end === -1 ? s.length : end;
        let v = s.slice(i, stop);
        if (end === -1 && v.length > 20) warnings.push(`ელემენტი (${ai}) 20 სიმბოლოზე გრძელია — სკანერი FNC1-ს არ გადმოსცემს? შეამოწმეთ ხელით`);
        if (v.length > 20) v = v.slice(0, 20);
        fields[ai] = v; i = stop;
      }
    }
  }

  if (Object.keys(fields).length) {
    out.format = 'gs1';
    const g = fields['01'] ?? fields['02'];
    if (g) { out.gtin = g; if (!/^\d{14}$/.test(g) || !gtinCheckOk(g)) warnings.push('GTIN-ის საკონტროლო ციფრი არასწორია'); }
    if (fields['10']) out.lot = fields['10'].trim();
    if (fields['21']) out.serial = fields['21'].trim();
    if (fields['17']) { out.expiry = yymmdd(fields['17']); if (!out.expiry) warnings.push(`ვადის ფორმატი არასწორია (17: ${fields['17']})`); }
    if (fields['11']) out.produced = yymmdd(fields['11']);
    out.normalized = out.gtin ?? normalizeBarcode(s);
    return out;
  }
  const n = normalizeBarcode(s);
  if (/^\d{14}$/.test(n)) {
    out.format = 'gtin'; out.gtin = n;
    if (!gtinCheckOk(n)) warnings.push('შტრიხკოდის საკონტროლო ციფრი არასწორია');
  }
  out.normalized = n;
  return out;
}
