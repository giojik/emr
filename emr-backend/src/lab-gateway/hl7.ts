/**
 * HL7 v2 (MLLP): <VT> შეტყობინება <FS><CR>. გამოიყენება gateway-შიც და სიმულატორშიც.
 *  შემომავალი: ORU^R01 (შედეგები), QRY^Q02 (ქვერი), ACK (ჩვენს ORM-ზე)
 *  გამავალი:   ACK (MSA|AA|AE), ORM^O01 (შეკვეთა — ქვერის პასუხად ან push)
 */
import { randomUUID } from 'node:crypto';

export const VT = 0x0b, FS = 0x1c, CR = 0x0d;

export class MllpDecoder {
  private buf = Buffer.alloc(0);
  constructor(private readonly onMessage: (msg: string) => void) {}
  feed(chunk: Buffer) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const s = this.buf.indexOf(VT); if (s < 0) { this.buf = Buffer.alloc(0); return; }
      const e = this.buf.indexOf(FS, s + 1); if (e < 0) { if (s > 0) this.buf = this.buf.subarray(s); return; }
      const msg = this.buf.subarray(s + 1, e).toString('utf8');
      this.buf = this.buf.subarray(this.buf[e + 1] === CR ? e + 2 : e + 1);
      if (msg.trim()) this.onMessage(msg);
    }
  }
}
export const mllp = (msg: string) => Buffer.concat([Buffer.from([VT]), Buffer.from(msg, 'utf8'), Buffer.from([FS, CR])]);

export interface Hl7 { segs: string[][]; fs: string; cs: string; rs: string; type: string; event: string; control: string; version: string; sendingApp: string; sendingFac: string }
export function parse(msg: string): Hl7 {
  const lines = msg.split(/\r\n?|\n/).filter((l) => l.trim());
  const msh = lines.find((l) => l.startsWith('MSH')) ?? 'MSH|^~\\&';
  const fs = msh[3] ?? '|'; const enc = msh.slice(4, 8); const cs = enc[0] ?? '^'; const rs = enc[1] ?? '~';
  const segs = lines.map((l) => l.split(fs));
  const m = segs.find((s) => s[0] === 'MSH') ?? [];
  // MSH-ში ველების ნუმერაცია +1-ით არის წანაცვლებული (MSH-1 თავად გამყოფია)
  const mf = (n: number) => m[n - 1] ?? '';
  const [type = '', event = ''] = mf(9).split(cs);
  return { segs, fs, cs, rs, type, event, control: mf(10), version: mf(12) || '2.5', sendingApp: mf(3), sendingFac: mf(4) };
}
/** სეგმენტის ველი HL7-ის ნომრით (PID-3 → f(seg, 3)) */
export const f = (seg: string[] | undefined, n: number) => (seg ? seg[n] ?? '' : '');
export const comp = (v: string, cs: string, n = 1) => v.split(cs)[n - 1] ?? '';

const ts = (d = new Date()) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
export function hl7Date(s: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?/.exec(s.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
  return Number.isNaN(d.getTime()) ? null : d;
}
const control = () => randomUUID().replace(/-/g, '').slice(0, 20);

export function ack(m: Hl7, code: 'AA' | 'AE' | 'AR' = 'AA', text = '') {
  const trig = m.event || '';
  return [`MSH|^~\\&|EMR|LIS|${m.sendingApp}|${m.sendingFac}|${ts()}||ACK^${trig}|${control()}|P|${m.version}`,
    `MSA|${code}|${m.control}${text ? `|${text.replace(/[|^~\\&\r\n]/g, ' ').slice(0, 80)}` : ''}`].join('\r') + '\r';
}

export interface Hl7Settings { barcode_field: 'OBR-3' | 'OBR-2' | 'SPM-2' | 'ORC-3'; code_component: number }
export const DEFAULT_HL7: Hl7Settings = { barcode_field: 'OBR-3', code_component: 1 };
export interface Hl7Result { barcode: string; code: string; value: string; unit: string; flags: string; status: string; measured_at: Date | null; qc: boolean }

/** ORU^R01 / OUL^R22 — OBR/SPM (შტრიხკოდი) → OBX-ები */
export function results(m: Hl7, s: Hl7Settings = DEFAULT_HL7): Hl7Result[] {
  const out: Hl7Result[] = []; let barcode = '';
  const pick = (seg: string[]) => {
    const [name, n] = s.barcode_field.split('-');
    if (seg[0] === name) { const v = comp(f(seg, Number(n)), m.cs); if (v.trim()) barcode = v.trim(); }
  };
  for (const seg of m.segs) {
    if (seg[0] === 'OBR' || seg[0] === 'SPM' || seg[0] === 'ORC') {
      pick(seg);
      if (seg[0] === 'OBR' && !barcode) barcode = (comp(f(seg, 3), m.cs) || comp(f(seg, 2), m.cs)).trim();
    }
    if (seg[0] === 'OBX') {
      if (f(seg, 2) && !['NM', 'ST', 'SN', 'TX', 'CE', 'CWE', 'FT'].includes(f(seg, 2))) continue;   // სურათები (ED) და სხვა — გამოტოვება
      out.push({ barcode, code: comp(f(seg, 3), m.cs, s.code_component).trim() || comp(f(seg, 3), m.cs, 1).trim(),
        value: f(seg, 5).split(m.rs)[0].split(m.cs).filter(Boolean).join('').trim(), unit: comp(f(seg, 6), m.cs).trim(), flags: f(seg, 8).trim(),
        status: f(seg, 11).trim(), measured_at: hl7Date(f(seg, 14)), qc: false });
    }
  }
  return out;
}
/** QRY^Q02 (QRD-8) ან QBP — შტრიხკოდი */
export function queryBarcode(m: Hl7): string | null {
  const qrd = m.segs.find((s) => s[0] === 'QRD');
  if (qrd) return comp(f(qrd, 8), m.cs).trim() || null;
  const qpd = m.segs.find((s) => s[0] === 'QPD');
  if (qpd) return comp(f(qpd, 3), m.cs).trim() || null;
  return null;
}

/** ORM^O01: PID + (ORC + OBR) თითო ტესტზე */
export function orm(o: { barcode: string; patient_id: string; codes: string[]; priority: 'R' | 'S'; name?: string | null; birth?: string | null; sex?: string | null; specimen?: string },
  to: { app: string; fac: string } = { app: '', fac: '' }, version = '2.3.1') {
  const sex = o.sex === 'male' ? 'M' : o.sex === 'female' ? 'F' : 'U';
  const now = ts();
  const lines = [`MSH|^~\\&|EMR|LIS|${to.app}|${to.fac}|${now}||ORM^O01|${control()}|P|${version}`,
    `PID|1||${o.patient_id}||${(o.name ?? '').replace(/[|^~\\&]/g, ' ')}||${o.birth?.replace(/-/g, '') ?? ''}|${sex}`];
  o.codes.forEach((c, i) => {
    lines.push(`ORC|NW|${o.barcode}|||||^^^^^${o.priority}`);
    lines.push(`OBR|${i + 1}|${o.barcode}|${o.barcode}|${c}|${o.priority}|${now}|||||||||${o.specimen ?? ''}`);
  });
  return lines.join('\r') + '\r';
}
export const oru = (barcode: string, items: { code: string; value: string; unit?: string; flag?: string }[], version = '2.3.1') => {
  const now = ts();
  return [`MSH|^~\\&|SIM|LAB|EMR|LIS|${now}||ORU^R01|${control()}|P|${version}`, 'PID|1', `OBR|1|${barcode}|${barcode}|PANEL`,
    ...items.map((x, i) => `OBX|${i + 1}|NM|${x.code}||${x.value}|${x.unit ?? ''}||${x.flag ?? ''}|||F|||${now}`)].join('\r') + '\r';
};
export const qry = (barcode: string) => {
  const now = ts();
  return [`MSH|^~\\&|SIM|LAB|EMR|LIS|${now}||QRY^Q02|${control()}|P|2.3.1`, `QRD|${now}|R|D|1|||RD|${barcode}|OTH|||T`, `QRF|SIM|${now}|${now}|||RCT|COR|ALL||`].join('\r') + '\r';
};
