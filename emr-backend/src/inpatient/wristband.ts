import bwipjs from 'bwip-js';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type PDFKit from 'pdfkit';
import { d, dt, newDoc } from '../diagnostics/diagnostics.pdf';

/**
 * პაციენტის სამაჯური (0040).
 *  PDF — ნებისმიერი პრინტერისთვის (დრაივერით); ZPL — Zebra-ს ქსელური პრინტერი (RAW TCP 9100), დრაივერის / ბრაუზერის გარეშე.
 *  ZPL: ქართული ტექსტი პრინტერის შრიფტებში არ არის — ტექსტი იხატება PDF-ად და გარდაიქმნება 1-ბიტიან სურათად (pdftoppm -mono → ^GFA);
 *  შტრიხკოდი — პრინტერის საკუთარი Code128 (^BCR), რომ სკანერმა ზუსტად წაიკითხოს.
 *  განლაგება — „ლანდშაფტი“ (სიგრძე × სიგანე, მმ); სამაჯურის დასაწყისი (offset) — საკეტის ზონა, არ იბეჭდება.
 */
export interface WristbandData {
  adm_no: string; last_name: string; first_name: string; birth_date: string; age: string; sex: string; personal_number: string | null;
  department: string; bed: string | null; admitted_at: Date | string; allergies: string[]; clinic: string;
}
export interface BandSize { width_mm: number; length_mm: number; offset_mm: number }

const pt = (mm: number) => (mm * 72) / 25.4;
const BAR_MM = 42;                                           // შტრიხკოდის ზონის სიგრძე (მმ)

function fit(doc: PDFKit.PDFDocument, text: string, maxW: number) {
  if (doc.widthOfString(text) <= maxW) return text;
  let t = text;
  while (t.length > 1 && doc.widthOfString(`${t}…`) > maxW) t = t.slice(0, -1);
  return `${t}…`;
}

/** ტექსტის ზონის განლაგება (მმ) — PDF-იც და ZPL-იც ერთს იყენებს */
function layout(b: BandSize) {
  const s = Math.min(1.3, Math.max(0.7, b.width_mm / 25));
  const x0 = b.offset_mm + 2;
  // ტექსტი — საკეტის შემდეგ, შტრიხკოდი — უშუალოდ ტექსტის მერე (სამაჯურის ბოლო ნაწილი ხშირად იჭრება / იკეცება)
  const textW = Math.max(30, Math.min(85, b.length_mm - x0 - BAR_MM - 8));
  const barX = x0 + textW + 4;
  return { s, x0, textW, barX, barY: 3 * s, barH: b.width_mm - 6 * s };
}

function drawText(doc: PDFKit.PDFDocument, w: WristbandData, b: BandSize) {
  const L = layout(b); const W = pt(L.textW); const X = pt(L.x0);
  const line = (font: 'R' | 'B', size: number, text: string, yMm: number) => {
    doc.font(font).fontSize(size * L.s);
    doc.text(fit(doc, text, W), X, pt(yMm * L.s), { lineBreak: false });
  };
  line('B', 10, `${w.last_name} ${w.first_name}`, 1.6);
  line('R', 6.6, `დაბ. ${d(w.birth_date)} (${w.age}) · ${w.sex}${w.personal_number ? ` · პ/ნ ${w.personal_number}` : ''}`, 6.8);
  line('B', 6.6, `${w.adm_no} · ${dt(w.admitted_at).slice(0, 10)}`, 10.3);
  line('R', 6.2, `${w.department}${w.bed ? ` · საწოლი ${w.bed}` : ''}`, 13.6);
  line(w.allergies.length ? 'B' : 'R', 6.6, w.allergies.length ? `! ალერგია: ${w.allergies.join(', ')}` : 'ალერგია: არ არის აღრიცხული', 16.9);
  line('R', 5, w.clinic, 20.6);
  return L;
}

/** PDF: ერთი გვერდი = ერთი სამაჯური (გვერდის ზომა = სამაჯურის სიგრძე × სიგანე) */
export async function wristbandPdf(w: WristbandData, b: BandSize, withBarcode = true): Promise<Buffer> {
  const { doc, done } = newDoc([pt(b.length_mm), pt(b.width_mm)], 0);
  doc.addPage();
  const L = drawText(doc, w, b);
  if (withBarcode) {
    const png = await bwipjs.toBuffer({ bcid: 'code128', text: w.adm_no, scale: 4, height: 10, includetext: false });
    doc.image(png, pt(L.barX), pt(L.barY), { width: pt(BAR_MM - 4), height: pt(L.barH) });
  }
  doc.end();
  return done;
}

const run = promisify(execFile);

/** PBM (P4) → { w, h, rowBytes, bits } */
function parsePbm(buf: Buffer) {
  let pos = 0; const tokens: string[] = [];
  while (tokens.length < 3) {
    while (pos < buf.length && /\s/.test(String.fromCharCode(buf[pos]))) pos++;
    if (buf[pos] === 0x23) { while (pos < buf.length && buf[pos] !== 0x0a) pos++; continue; }  // # კომენტარი
    let t = ''; while (pos < buf.length && !/\s/.test(String.fromCharCode(buf[pos]))) t += String.fromCharCode(buf[pos++]);
    tokens.push(t);
  }
  pos++;
  if (tokens[0] !== 'P4') throw new Error('pdftoppm: მოსალოდნელი იყო PBM (P4)');
  const w = Number(tokens[1]); const h = Number(tokens[2]); const rowBytes = Math.ceil(w / 8);
  return { w, h, rowBytes, bits: buf.subarray(pos, pos + rowBytes * h) };
}

/** 90° საათის ისრის მიმართულებით: (x, y) → (H-1-y, x) */
function rotateCW(src: { w: number; h: number; rowBytes: number; bits: Buffer }) {
  const W = src.h; const H = src.w; const rb = Math.ceil(W / 8); const out = Buffer.alloc(rb * H);
  for (let y = 0; y < src.h; y++) {
    for (let x = 0; x < src.w; x++) {
      if (!(src.bits[y * src.rowBytes + (x >> 3)] & (0x80 >> (x & 7)))) continue;
      const nx = W - 1 - y; const ny = x;
      out[ny * rb + (nx >> 3)] |= 0x80 >> (nx & 7);
    }
  }
  return { w: W, h: H, rowBytes: rb, bits: out };
}

/** ZPL: ტექსტი — ^GFA სურათი, შტრიხკოდი — ^BCR; ბეჭდვის მიმართულება — სამაჯურის გასწვრივ */
export async function wristbandZpl(w: WristbandData, b: BandSize, dpi: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'emr-wb-'));
  try {
    await writeFile(join(dir, 'in.pdf'), await wristbandPdf(w, b, false));
    await run('pdftoppm', ['-mono', '-r', String(dpi), '-singlefile', join(dir, 'in.pdf'), join(dir, 'out')], { timeout: 15_000 });
    const img = rotateCW(parsePbm(await readFile(join(dir, 'out.pbm'))));
    const dots = (mm: number) => Math.round((mm * dpi) / 25.4);
    const L = layout(b);
    const module = Math.max(2, Math.round((0.25 * dpi) / 25.4));
    const total = img.rowBytes * img.h;
    // ^BCR: ველის ზედა-მარცხენა კუთხე პორტრეტში — x = სიგანე − (y + სიმაღლე), y = სიგრძის მიმართულებით
    const bx = img.w - dots(L.barY) - dots(L.barH); const by = dots(L.barX);
    return ['^XA', '^CI28', `^PW${img.w}`, `^LL${img.h}`, '^LH0,0', '^PON',
      `^FO0,0^GFA,${total},${total},${img.rowBytes},${img.bits.toString('hex').toUpperCase()}^FS`,
      `^BY${module},3`, `^FO${Math.max(0, bx)},${by}^BCR,${dots(L.barH)},N,N,N^FD${w.adm_no}^FS`,
      '^PQ1', '^XZ'].join('\n');
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/** RAW TCP (Zebra: 9100) — მონაცემის გაგზავნა და კავშირის დახურვა */
export function sendRaw(host: string, port: number, data: string | Buffer, timeoutMs = 7000): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = connect({ host, port });
    const fail = (e: Error) => { sock.destroy(); reject(e); };
    sock.setTimeout(timeoutMs, () => fail(new Error(`პრინტერი არ პასუხობს (${host}:${port}, ${timeoutMs / 1000} წმ)`)));
    sock.once('error', (e) => fail(new Error(`პრინტერთან კავშირი ვერ დამყარდა (${host}:${port}): ${e.message}`)));
    sock.once('connect', () => sock.end(data, () => { sock.destroy(); resolve(); }));
  });
}

/** კავშირის შემოწმება (ბეჭდვის გარეშე) */
export function probe(host: string, port: number, timeoutMs = 4000): Promise<number> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const sock = connect({ host, port });
    sock.setTimeout(timeoutMs, () => { sock.destroy(); reject(new Error(`პრინტერი არ პასუხობს (${host}:${port})`)); });
    sock.once('error', (e) => { sock.destroy(); reject(new Error(`კავშირი ვერ დამყარდა (${host}:${port}): ${e.message}`)); });
    sock.once('connect', () => { sock.destroy(); resolve(Date.now() - t0); });
  });
}
