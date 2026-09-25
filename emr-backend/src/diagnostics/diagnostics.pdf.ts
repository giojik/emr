import bwipjs from 'bwip-js';
import PDFDocument from 'pdfkit';
import { join } from 'node:path';

export const FONT_DIR = join(__dirname, '..', '..', 'assets', 'fonts');
const mm = (v: number) => (v * 72) / 25.4;
export const d = (iso: string) => { const [y, m, dd] = iso.slice(0, 10).split('-'); return `${dd}/${m}/${y}`; };
export const dt = (x: Date | string) => new Intl.DateTimeFormat('ka-GE', { timeZone: 'Asia/Tbilisi', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(x));

export function newDoc(size: [number, number] | 'A4', margins: number) {
  const doc = new PDFDocument({ size, margins: { top: margins, bottom: margins, left: margins, right: margins }, bufferPages: true, autoFirstPage: false });
  doc.registerFont('R', join(FONT_DIR, 'EmrSans-Regular.ttf')); doc.registerFont('B', join(FONT_DIR, 'EmrSans-Bold.ttf'));
  const chunks: Buffer[] = []; doc.on('data', (c: Buffer) => chunks.push(c));
  return { doc, done: new Promise<Buffer>((res) => doc.on('end', () => res(Buffer.concat(chunks)))) };
}

export interface LabelData { barcode: string; first_name: string; last_name: string; birth_date: string; container: string | null; specimen_type: string; collected_at: Date; tests: { code: string; name: string }[] }

/** სინჯარის ეტიკეტი 50×25 მმ (Code128) — ერთი გვერდი = ერთი ეტიკეტი (ეტიკეტების პრინტერისთვის) */
export async function renderLabels(labels: LabelData[]): Promise<Buffer> {
  const { doc, done } = newDoc([mm(50), mm(25)], mm(1.5));
  for (const l of labels) {
    doc.addPage();
    const png = await bwipjs.toBuffer({ bcid: 'code128', text: l.barcode, scale: 3, height: 8, includetext: false });
    const W = mm(47);
    doc.font('B').fontSize(7).text(`${l.last_name} ${l.first_name}`.slice(0, 34), mm(1.5), mm(1.2), { width: W, lineBreak: false });
    doc.font('R').fontSize(5.5).text(`${d(l.birth_date)} · ${l.container ?? l.specimen_type} · ${dt(l.collected_at)}`, mm(1.5), mm(4.4), { width: W, lineBreak: false });
    doc.image(png, mm(1.5), mm(7), { width: W, height: mm(10) });
    doc.font('B').fontSize(7).text(l.barcode, mm(1.5), mm(17.6), { width: W, align: 'center', lineBreak: false });
    doc.font('R').fontSize(5).text(l.tests.map((t) => t.code.replace(/^LAB_/, '')).join(' '), mm(1.5), mm(20.8), { width: W, lineBreak: false });
  }
  doc.end();
  return done;
}

export interface LabReportItem {
  service_name: string; barcode: string | null; collected_at: string | null; validated_at: string | null; validated_by_name: string | null;
  results: { name: string; value_num: string | null; value_text: string | null; unit: string; ref_low: string | null; ref_high: string | null; ref_text: string | null; flag: string | null }[];
}

const refText = (r: LabReportItem['results'][number]) =>
  r.ref_text ?? (r.ref_low !== null && r.ref_high !== null ? `${Number(r.ref_low)} – ${Number(r.ref_high)}` : r.ref_low !== null ? `> ${Number(r.ref_low)}` : r.ref_high !== null ? `< ${Number(r.ref_high)}` : '');
const FLAG: Record<string, string> = { L: 'დაბალი', H: 'მაღალი', LL: 'კრიტ. დაბალი', HH: 'კრიტ. მაღალი', A: 'გადახრა', N: '' };
const SUP: Record<string, string> = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };
/** 10^9/L → 10⁹/L */
const unitFmt = (u: string) => u.replace(/\^(\d+)/g, (_m, d: string) => d.split('').map((c) => SUP[c]).join(''));

/** ლაბორატორიული კვლევის ბლანკი — მხოლოდ ვალიდირებული შედეგები */
export async function renderLabReport(p: { clinic: { name: string; address: string; phone: string | null }; patient: { name: string; birth_date: string; gender: string; id_number: string | null }; items: LabReportItem[] }): Promise<Buffer> {
  const { doc, done } = newDoc('A4', 45);
  doc.addPage();
  const L = 45; const W = doc.page.width - 90;
  doc.font('B').fontSize(10).text(p.clinic.name, L, 38, { width: W });
  doc.font('R').fontSize(8).fillColor('#555').text([p.clinic.address, p.clinic.phone].filter(Boolean).join(' · ')).fillColor('black');
  doc.moveDown(0.8).font('B').fontSize(14).text('ლაბორატორიული კვლევის პასუხი', { width: W, align: 'center' }).moveDown(0.6);
  doc.font('R').fontSize(9.5).text(`პაციენტი: ${p.patient.name}    დაბ.: ${d(p.patient.birth_date)}    სქესი: ${p.patient.gender === 'male' ? 'მამრ.' : p.patient.gender === 'female' ? 'მდედრ.' : '—'}    პ/ნ: ${p.patient.id_number ?? '—'}`);
  doc.moveDown(0.6);
  const cols = [L, L + 190, L + 270, L + 335, L + 430];   // კომპონენტი | შედეგი | ერთეული | ნორმა | ნიშანი
  for (const it of p.items) {
    if (doc.y > doc.page.height - 140) doc.addPage();
    doc.moveDown(0.4).font('B').fontSize(10.5).text(it.service_name, L, doc.y, { width: W });
    doc.font('R').fontSize(7.5).fillColor('#555').text([it.barcode && `ნიმუში ${it.barcode}`, it.collected_at && `აღება ${dt(it.collected_at)}`, it.validated_at && `დადასტურდა ${dt(it.validated_at)}`, it.validated_by_name].filter(Boolean).join(' · '), L, doc.y, { width: W }).fillColor('black');
    doc.moveDown(0.3);
    const hy = doc.y;
    doc.font('B').fontSize(8).fillColor('#555');
    ['კომპონენტი', 'შედეგი', 'ერთეული', 'ნორმა', ''].forEach((h, i) => doc.text(h, cols[i], hy, { width: (cols[i + 1] ?? L + W) - cols[i] - 4, lineBreak: false }));
    doc.fillColor('black'); doc.moveTo(L, hy + 11).lineTo(L + W, hy + 11).strokeColor('#ccc').lineWidth(0.5).stroke();
    let y = hy + 14;
    for (const r of it.results) {
      if (y > doc.page.height - 60) { doc.addPage(); y = 50; }
      const abn = r.flag && r.flag !== 'N'; const crit = r.flag === 'LL' || r.flag === 'HH';
      const val = r.value_num !== null ? String(Number(r.value_num)) : r.value_text ?? '';
      doc.font('R').fontSize(9).fillColor('black').text(r.name, cols[0], y, { width: cols[1] - cols[0] - 4, lineBreak: false });
      doc.font(abn ? 'B' : 'R').fillColor(crit ? '#B42318' : 'black').text(val, cols[1], y, { width: cols[2] - cols[1] - 4, lineBreak: false });
      doc.font('R').fillColor('black').text(unitFmt(r.unit), cols[2], y, { width: cols[3] - cols[2] - 4, lineBreak: false });
      doc.fillColor('#555').text(refText(r), cols[3], y, { width: cols[4] - cols[3] - 4, lineBreak: false });
      doc.font('B').fillColor(crit ? '#B42318' : 'black').text(FLAG[r.flag ?? 'N'] ?? '', cols[4], y, { width: L + W - cols[4], lineBreak: false });
      y += 14;
    }
    doc.fillColor('black'); doc.y = y + 4; doc.x = L;
  }
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i); const b = doc.page.margins.bottom; doc.page.margins.bottom = 0;
    doc.font('R').fontSize(7).fillColor('#777').text(`„კრიტ.“ — კრიტიკული მნიშვნელობა, საჭიროებს ექიმის დაუყოვნებლივ ინფორმირებას · გვერდი ${i + 1}/${range.count}`, L, doc.page.height - 30, { width: W, align: 'center' });
    doc.page.margins.bottom = b;
  }
  doc.end();
  return done;
}
