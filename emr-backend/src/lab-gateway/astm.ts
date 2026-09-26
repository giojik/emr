/**
 * ASTM E1381 (ბმის დონე) + E1394 (ჩანაწერები). გამოიყენება gateway-შიც და სიმულატორშიც.
 *  ბმა:  ENQ → ACK → [STX FN ტექსტი ETB|ETX C1 C2 CR LF → ACK]… → EOT
 *  ჩარჩო ≤ 240 სიმბოლო ტექსტი; FN = 1..7,0,1…; checksum = ჯამი FN-დან ETX/ETB-ის ჩათვლით mod 256 (2 hex)
 */
import { EventEmitter } from 'node:events';

export const ENQ = 0x05, ACK = 0x06, NAK = 0x15, EOT = 0x04, STX = 0x02, ETX = 0x03, ETB = 0x17, LF = 0x0a, CR = 0x0d;
const MAX_TEXT = 240;
const TIMEOUT_ACK_MS = 15_000;
const TIMEOUT_RECV_MS = 30_000;
const MAX_RETRY = 6;

export const checksum = (b: Buffer) => { let s = 0; for (const x of b) s = (s + x) % 256; return s.toString(16).toUpperCase().padStart(2, '0'); };

/** ჩანაწერები → ჩარჩოები (თითო ჩანაწერი ცალკე; გრძელი — ETB-ით იყოფა) */
export function buildFrames(records: string[]): Buffer[] {
  const frames: Buffer[] = []; let fn = 1;
  for (const rec of records) {
    const text = Buffer.from(`${rec}\r`, 'latin1');
    for (let i = 0; i < text.length; i += MAX_TEXT) {
      const part = text.subarray(i, i + MAX_TEXT); const last = i + MAX_TEXT >= text.length;
      const body = Buffer.concat([Buffer.from(String(fn % 8), 'latin1'), part, Buffer.from([last ? ETX : ETB])]);
      frames.push(Buffer.concat([Buffer.from([STX]), body, Buffer.from(checksum(body) + '\r\n', 'latin1')]));
      fn++;
    }
  }
  return frames;
}

export type LinkEvent = 'message' | 'send' | 'log' | 'error';
/**
 * ბმის დონის მდგომარეობის მანქანა ერთი კავშირისთვის.
 *  • შემომავალი: ENQ → ACK, ჩარჩოები (checksum/FN შემოწმებით) → ACK/NAK, EOT → 'message' (ჩანაწერების სია)
 *  • გამავალი: send(records) — რიგი; ENQ → ACK-ის მოლოდინი → ჩარჩოები → EOT
 *  • შეჯახება (ორივემ ENQ): ANSI/ASTM-ის მიხედვით კომპიუტერი (host) უთმობს ანალიზატორს; instrument=true მხარე არ უთმობს
 */
export class AstmLink extends EventEmitter {
  private buf = Buffer.alloc(0);
  private state: 'idle' | 'receiving' | 'enq_sent' | 'sending' = 'idle';
  private expectedFn = 1; private text = ''; private records: string[] = [];
  private queue: { records: string[]; resolve: () => void; reject: (e: Error) => void }[] = [];
  private frames: Buffer[] = []; private frameIdx = 0; private retries = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly write: (b: Buffer) => void, private readonly opts: { instrument?: boolean } = {}) { super(); }

  /** მოდის ბაიტები სოკეტიდან */
  feed(chunk: Buffer) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length) {
      const c = this.buf[0];
      if (c === STX) {
        const lf = this.buf.indexOf(LF);
        if (lf < 0) return;               // ჩარჩო ჯერ არ დასრულებულა
        const frame = this.buf.subarray(0, lf + 1); this.buf = this.buf.subarray(lf + 1);
        this.onFrame(frame); continue;
      }
      this.buf = this.buf.subarray(1);
      if (c === ENQ) this.onEnq();
      else if (c === EOT) this.onEot();
      else if (c === ACK) this.onAck();
      else if (c === NAK) this.onNak();
      // სხვა ბაიტები ჩარჩოს გარეთ — იგნორირება
    }
  }

  send(records: string[]): Promise<void> {
    return new Promise((resolve, reject) => { this.queue.push({ records, resolve, reject }); this.pump(); });
  }
  get busy() { return this.state !== 'idle' || this.queue.length > 0; }
  close() { this.clear(); for (const q of this.queue) q.reject(new Error('კავშირი დაიხურა')); this.queue = []; this.state = 'idle'; }

  // ---------------------------------------------------------------- მიღება
  private onEnq() {
    if (this.state === 'enq_sent' && this.opts.instrument) return;          // ანალიზატორი არ უთმობს — ელოდება ACK-ს
    if (this.state === 'enq_sent') this.emit('log', 'ENQ შეჯახება — ვუთმობთ ანალიზატორს');
    if (this.state === 'sending') { this.write(Buffer.from([NAK])); return; }
    this.clear(); this.state = 'receiving'; this.expectedFn = 1; this.text = ''; this.records = [];
    this.write(Buffer.from([ACK])); this.arm(TIMEOUT_RECV_MS, () => { this.emit('log', 'მიღების timeout'); this.reset(); });
  }
  private onFrame(frame: Buffer) {
    if (this.state !== 'receiving') return;
    const end = Math.max(frame.lastIndexOf(ETX), frame.lastIndexOf(ETB));
    const body = end > 1 ? frame.subarray(1, end + 1) : Buffer.alloc(0);
    const cs = end > 1 ? frame.subarray(end + 1, end + 3).toString('latin1').toUpperCase() : '';
    const fn = Number(String.fromCharCode(frame[1]));
    if (!body.length || cs !== checksum(body) || !Number.isInteger(fn)) { this.write(Buffer.from([NAK])); this.emit('log', 'ჩარჩოს checksum არასწორია — NAK'); return; }
    if (fn === (this.expectedFn + 7) % 8) { this.write(Buffer.from([ACK])); return; }   // განმეორებითი ჩარჩო — უკვე მიღებულია
    if (fn !== this.expectedFn % 8) { this.write(Buffer.from([NAK])); this.emit('log', `ჩარჩოს ნომერი ${fn} ≠ ${this.expectedFn % 8}`); return; }
    this.text += body.subarray(1, body.length - 1).toString('latin1');
    if (frame[end] === ETX) { for (const r of this.text.split(/\r\n?|\n/)) if (r) this.records.push(r); this.text = ''; }
    this.expectedFn = (this.expectedFn + 1) % 8;
    this.write(Buffer.from([ACK]));
    this.arm(TIMEOUT_RECV_MS, () => { this.emit('log', 'მიღების timeout'); this.reset(); });
  }
  private onEot() {
    if (this.state !== 'receiving') return;
    if (this.text) { for (const r of this.text.split(/\r\n?|\n/)) if (r) this.records.push(r); }
    const recs = this.records; this.reset();
    if (recs.length) this.emit('message', recs);
    this.pump();
  }

  // ---------------------------------------------------------------- გაგზავნა
  private pump() {
    if (this.state !== 'idle' || !this.queue.length) return;
    this.frames = buildFrames(this.queue[0].records); this.frameIdx = 0; this.retries = 0;
    this.state = 'enq_sent'; this.write(Buffer.from([ENQ]));
    this.arm(TIMEOUT_ACK_MS, () => this.fail('ENQ-ზე პასუხი არ მოვიდა'));
  }
  private onAck() {
    if (this.state === 'enq_sent') { this.state = 'sending'; this.sendFrame(); return; }
    if (this.state === 'sending') {
      this.frameIdx++; this.retries = 0;
      if (this.frameIdx < this.frames.length) { this.sendFrame(); return; }
      this.write(Buffer.from([EOT])); const q = this.queue.shift(); this.reset(); q?.resolve();
      setTimeout(() => this.pump(), 50);   // ანალიზატორს EOT-ის შემდეგ ცოტა დრო
    }
  }
  private onNak() {
    if (this.state === 'enq_sent') { this.clear(); this.state = 'idle'; setTimeout(() => this.pump(), 10_000); this.emit('log', 'ENQ-ზე NAK — 10 წმ-ში ხელახლა'); return; }
    if (this.state === 'sending') {
      if (++this.retries > MAX_RETRY) { this.write(Buffer.from([EOT])); this.fail('ჩარჩო 6-ჯერ უარყო (NAK)'); return; }
      this.sendFrame();
    }
  }
  private sendFrame() { this.emit('send', this.frames[this.frameIdx]); this.write(this.frames[this.frameIdx]); this.arm(TIMEOUT_ACK_MS, () => { this.write(Buffer.from([EOT])); this.fail('ჩარჩოზე ACK არ მოვიდა'); }); }
  private fail(msg: string) { const q = this.queue.shift(); this.reset(); q?.reject(new Error(msg)); this.emit('error', new Error(msg)); setTimeout(() => this.pump(), 1000); }

  private arm(ms: number, fn: () => void) { this.clear(); this.timer = setTimeout(fn, ms); }
  private clear() { if (this.timer) clearTimeout(this.timer); this.timer = null; }
  private reset() { this.clear(); this.state = 'idle'; this.text = ''; this.records = []; this.expectedFn = 1; }
}

// ======================================================================= E1394 ჩანაწერები
export interface Delims { field: string; repeat: string; component: string; escape: string }
export const DEFAULT_DELIMS: Delims = { field: '|', repeat: '\\', component: '^', escape: '&' };
export function delimsFrom(header: string | undefined): Delims {
  if (!header?.startsWith('H') || header.length < 5) return DEFAULT_DELIMS;
  return { field: header[1], repeat: header[2], component: header[3], escape: header[4] };
}
/** ველი (1-დან, ტიპის ასოს ჩათვლით: R|1|… → f(1)='R', f(2)='1') */
export const field = (rec: string, d: Delims, n: number) => rec.split(d.field)[n - 1] ?? '';
export const comps = (v: string, d: Delims) => v.split(d.component);

export interface AstmResult { barcode: string; code: string; value: string; unit: string; flags: string; status: string; measured_at: Date | null; qc: boolean }
export interface AstmQuery { barcode: string }
export interface AstmSettings { specimen_field: number; code_component: number; query_component: number | null }
export const DEFAULT_ASTM: AstmSettings = { specimen_field: 3, code_component: 4, query_component: null };

/** YYYYMMDD[HHMMSS] → Date (ადგილობრივი დრო) */
export function astmDate(s: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?/.exec(s.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
  return Number.isNaN(d.getTime()) ? null : d;
}
export const astmNow = (d = new Date()) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;

/** ტესტის კოდი: ^^^CODE[^…] → CODE (კომპონენტის ნომერი — პარამეტრით; ცარიელზე — პირველი არაცარიელი) */
export function testCode(v: string, d: Delims, component: number) {
  const c = comps(v, d);
  return (c[component - 1] || c.find((x) => x.trim()) || '').trim();
}

/** შეტყობინების დაშლა: შედეგები (O → R) და მოთხოვნები (Q) */
export function parseMessage(records: string[], s: AstmSettings = DEFAULT_ASTM) {
  const d = delimsFrom(records.find((r) => r.startsWith('H')));
  const results: AstmResult[] = []; const queries: AstmQuery[] = [];
  let barcode = ''; let qc = false;
  for (const rec of records) {
    const t = rec[0];
    if (t === 'O') {
      const f = field(rec, d, s.specimen_field) || field(rec, d, s.specimen_field === 3 ? 4 : 3);
      barcode = comps(f, d).find((x) => x.trim())?.trim() ?? '';
      qc = field(rec, d, 12).toUpperCase() === 'Q';
    } else if (t === 'R') {
      results.push({ barcode, code: testCode(field(rec, d, 3), d, s.code_component), value: field(rec, d, 4).trim(), unit: comps(field(rec, d, 5), d)[0]?.trim() ?? '',
        flags: field(rec, d, 7).trim(), status: field(rec, d, 9).trim(), measured_at: astmDate(field(rec, d, 13)), qc });
    } else if (t === 'Q') {
      const c = comps(field(rec, d, 3), d);
      const b = s.query_component ? c[s.query_component - 1] : (c[2] || c[1] || c[0]);
      if (b?.trim()) queries.push({ barcode: b.trim() });
    }
  }
  return { results, queries, sender: comps(field(records[0] ?? '', d, 5), d)[0] ?? '' };
}

/** შეკვეთა (ქვერის პასუხი ან push): H, P, O (ტესტები — repeat-ით), L */
export function buildOrder(o: { barcode: string; patient_id: string; codes: string[]; priority: 'R' | 'S'; specimen?: string; name?: string | null; birth?: string | null; sex?: string | null;
  reportType?: 'O' | 'Q' }, d: Delims = DEFAULT_DELIMS) {
  const tests = o.codes.map((c) => `${d.component}${d.component}${d.component}${c}`).join(d.repeat);
  const sex = o.sex === 'male' ? 'M' : o.sex === 'female' ? 'F' : 'U';
  return [
    `H${d.field}${d.repeat}${d.component}${d.escape}${d.field}${d.field}${d.field}EMR${d.field}${d.field}${d.field}${d.field}${d.field}${d.field}${d.field}P${d.field}1${d.field}${astmNow()}`,
    ['P', '1', '', o.patient_id, '', o.name ?? '', '', o.birth?.replace(/-/g, '') ?? '', sex].join(d.field),
    ['O', '1', o.barcode, '', tests, o.priority, astmNow(), '', '', '', '', 'N', '', '', '', o.specimen ?? '', '', '', '', '', '', '', '', '', '', o.reportType ?? 'O'].join(d.field),
    `L${d.field}1${d.field}N`,
  ];
}
/** ქვერის პასუხი, როცა შეკვეთა არ არის: O … Y („შეკვეთა არ არის“) */
export function buildNoOrder(barcode: string, d: Delims = DEFAULT_DELIMS) {
  return [
    `H${d.field}${d.repeat}${d.component}${d.escape}${d.field}${d.field}${d.field}EMR${d.field}${d.field}${d.field}${d.field}${d.field}${d.field}${d.field}P${d.field}1${d.field}${astmNow()}`,
    ['P', '1'].join(d.field),
    ['O', '1', barcode, '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', 'Y'].join(d.field),
    `L${d.field}1${d.field}N`,
  ];
}
