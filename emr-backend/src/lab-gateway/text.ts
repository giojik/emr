/**
 * ცალმხრივი ტექსტური პროტოკოლი („პრინტერის“ გამოტანა: Urisys 1100, Roller 20 და მსგავსი) + ჰისტოგრამების/სურათების ამოცნობა.
 * ტექსტი → შეტყობინებები (დასრულება: სიჩუმე / ETX / FF / EOT) → შტრიხკოდი + შედეგები რეგულარული გამოსახულებებით (ანალიზატორის პარამეტრებში).
 */
import type { IncomingResult } from './lab-ingest.service';

export interface TextSettings {
  end: 'idle' | 'etx' | 'ff' | 'eot';
  idle_ms: number;
  encoding: 'latin1' | 'utf8';
  barcode_regex: string;
  result_regex: string;
  ack: boolean;
}
/** ნაგულისხმევი — ხაზობრივი გამოტანა: „ID: 1000123“ და „GLU  norm“ / „ESR: 12 mm/h“ / „PRO + 30 mg/dL“ */
export const DEFAULT_TEXT: TextSettings = {
  end: 'idle', idle_ms: 1500, encoding: 'latin1',
  barcode_regex: '(?:ID|SID|No\\.?|Sample|Seq)[\\s.:#№-]*([A-Za-z0-9-]{3,24})',
  result_regex: '^\\s*(?<code>[A-Za-z][A-Za-z0-9.#%/_-]{0,15})\\s*[:=]?\\s+(?<value>[<>]?[-+]?[0-9A-Za-z.,+/]+(?:\\s[+]{1,4})?)(?:\\s+(?<unit>[A-Za-zµ%/^0-9.*]+(?:/[A-Za-z]+)?))?\\s*$',
  ack: false,
};
export const TEXT_PRESETS: Record<string, { label: string; settings: Partial<TextSettings> }> = {
  lines: { label: 'ხაზობრივი: „კოდი მნიშვნელობა [ერთეული]“ (ნაგულისხმევი)', settings: {} },
  semicolon: { label: 'გამყოფით: „კოდი;მნიშვნელობა;ერთეული“', settings: { result_regex: '^\\s*(?<code>[^;\\r\\n]{1,20});\\s*(?<value>[^;\\r\\n]+?)\\s*(?:;\\s*(?<unit>[^;\\r\\n]*))?\\s*$' } },
  esr: { label: 'ედს: „ID … ESR 12 mm/h“ (Roller-ის ტიპის)', settings: { result_regex: '(?<code>ESR|VES|SR)\\s*[:=]?\\s*(?<value>[<>]?\\d+(?:[.,]\\d+)?)\\s*(?<unit>mm/h)?' } },
};

/** ბაიტები → შეტყობინებები */
export class TextFramer {
  private buf = Buffer.alloc(0);
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly s: TextSettings, private readonly onMessage: (text: string) => void) {}
  feed(chunk: Buffer) {
    this.buf = Buffer.concat([this.buf, chunk]);
    const sep = this.s.end === 'etx' ? 0x03 : this.s.end === 'ff' ? 0x0c : this.s.end === 'eot' ? 0x04 : -1;
    if (sep >= 0) {
      for (let i = this.buf.indexOf(sep); i >= 0; i = this.buf.indexOf(sep)) { this.emit(this.buf.subarray(0, i)); this.buf = this.buf.subarray(i + 1); }
    }
    // სიჩუმე — ყოველთვის (end=idle-ზე ერთადერთი, სხვაზე — დაკარგული დამასრულებლის დაზღვევა)
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { if (this.buf.length) { this.emit(this.buf); this.buf = Buffer.alloc(0); } }, sep >= 0 ? Math.max(this.s.idle_ms, 5000) : this.s.idle_ms);
  }
  private emit(b: Buffer) {
    const text = b.toString(this.s.encoding).replace(/[\x02\x03\x04\x0c]/g, '').replace(/\r\n?/g, '\n');
    if (text.trim()) this.onMessage(text);
  }
  close() { if (this.timer) clearTimeout(this.timer); }
}

const re = (src: string, flags: string) => { try { return new RegExp(src, flags); } catch { return null; } };
/** ტექსტი → შტრიხკოდი + შედეგები (შტრიხკოდის ხაზი შედეგებში არ ითვლება) */
export function parseText(text: string, s: TextSettings): { barcode: string; results: IncomingResult[]; error: string | null } {
  const bre = re(s.barcode_regex, 'im'); const rre = re(s.result_regex, 'gim');
  if (!bre || !rre) return { barcode: '', results: [], error: 'რეგულარული გამოსახულება არასწორია' };
  const bm = bre.exec(text);
  const barcode = (bm?.groups?.barcode ?? bm?.[1] ?? '').trim();
  const body = bm ? text.replace(bm[0], ' ') : text;
  const results: IncomingResult[] = [];
  for (const m of body.slice(0, 100_000).matchAll(rre)) {
    const code = (m.groups?.code ?? m[1] ?? '').trim(); const value = (m.groups?.value ?? m[2] ?? '').trim();
    if (!code || !value) continue;
    results.push({ barcode, code, value, unit: (m.groups?.unit ?? m[3] ?? '').trim(), flags: (m.groups?.flag ?? '').trim(), status: 'F', measured_at: null, qc: false });
  }
  return { barcode, results, error: barcode ? null : 'შტრიხკოდი ვერ ამოვიცანი' };
}

// ======================================================================= ჰისტოგრამები / სურათები
export interface Graphic { barcode: string; code: string; kind: 'image' | 'histogram'; mime?: string; data?: Buffer; points?: number[] }
const MAGIC: [string, number[]][] = [['image/png', [0x89, 0x50, 0x4e, 0x47]], ['image/jpeg', [0xff, 0xd8, 0xff]], ['image/bmp', [0x42, 0x4d]]];
/**
 * შედეგის მნიშვნელობა გრაფიკაა? base64/hex სურათი (PNG/JPEG/BMP) ან ≥ 16 რიცხვის სია (ჰისტოგრამა).
 * HL7 ED: „src^Image^PNG^Base64^<data>“ — გადაეცით მხოლოდ data (ან მთლიანი — ბოლო კომპონენტი აიღება).
 */
export function detectGraphic(value: string): Omit<Graphic, 'barcode' | 'code'> | null {
  const v = value.trim();
  if (v.length >= 64) {
    const last = v.includes('^') ? v.split('^').pop()!.trim() : v;
    const b64 = /^[A-Za-z0-9+/=\s]+$/.test(last) ? Buffer.from(last.replace(/\s+/g, ''), 'base64') : null;
    const hex = /^([0-9A-Fa-f]{2})+$/.test(last) ? Buffer.from(last, 'hex') : null;
    for (const buf of [b64, hex]) {
      if (!buf || buf.length < 32) continue;
      const m = MAGIC.find(([, sig]) => sig.every((x, i) => buf[i] === x));
      if (m) return { kind: 'image', mime: m[0], data: buf };
    }
  }
  const parts = v.split(/[,;\s^|]+/).filter(Boolean);
  if (parts.length >= 16 && parts.every((p) => /^-?\d+(?:\.\d+)?$/.test(p))) return { kind: 'histogram', points: parts.slice(0, 1024).map(Number) };
  return null;
}
