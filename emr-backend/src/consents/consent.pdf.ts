import PDFDocument from 'pdfkit';
import { join } from 'node:path';

const FONT_DIR = join(__dirname, '..', '..', 'assets', 'fonts');

export interface ConsentPdfInput {
  clinic: { name: string; address: string; phone: string | null };
  title: string; version: number; body: string; textApproved: boolean;
  patient: { name: string; birthDate: string; idNumber: string | null; address: string | null };
  encounterDate?: string | null;
  mode: 'blank' | 'electronic';
  decision?: 'granted' | 'refused';
  signer?: { type: 'patient' | 'representative'; name?: string | null; relation?: string | null; idNumber?: string | null };
  signaturePng?: Buffer;
  signedAt?: Date;
  recordedBy?: string;
  documentId?: string;
}

const d = (iso: string) => { const [y, m, dd] = iso.slice(0, 10).split('-'); return `${dd}/${m}/${y}`; };
const dt = (x: Date) => new Intl.DateTimeFormat('ka-GE', { timeZone: 'Asia/Tbilisi', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(x);

/** თანხმობის ფორმა: ცარიელი (დასაბეჭდად და ხელის მოსაწერად) ან ელექტრონულად ხელმოწერილი */
export function renderConsent(p: ConsentPdfInput): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 45, bottom: 55, left: 55, right: 55 }, bufferPages: true,
    info: { Title: p.title, Author: p.clinic.name } });
  doc.registerFont('R', join(FONT_DIR, 'EmrSans-Regular.ttf')); doc.registerFont('B', join(FONT_DIR, 'EmrSans-Bold.ttf'));
  const chunks: Buffer[] = []; doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res) => doc.on('end', () => res(Buffer.concat(chunks))));
  const L = doc.page.margins.left; const W = doc.page.width - L - doc.page.margins.right;

  doc.font('B').fontSize(10).text(p.clinic.name, L, 40, { width: W });
  doc.font('R').fontSize(8.5).fillColor('#555').text([p.clinic.address, p.clinic.phone].filter(Boolean).join(' · '), { width: W }).fillColor('black');
  doc.moveDown(1.2);
  doc.font('B').fontSize(14).text(p.title, { width: W, align: 'center' });
  doc.font('R').fontSize(8.5).fillColor('#555').text(`ვერსია ${p.version}`, { width: W, align: 'center' }).fillColor('black');
  doc.moveDown(0.8);

  const row = (k: string, v: string) => { doc.font('B').fontSize(9.5).text(`${k}: `, { continued: true }).font('R').text(v || '—'); };
  row('პაციენტი', p.patient.name);
  row('დაბადების თარიღი', d(p.patient.birthDate));
  row('პირადი № / დოკუმენტი', p.patient.idNumber ?? '—');
  row('მისამართი', p.patient.address ?? '—');
  if (p.encounterDate) row('ვიზიტის თარიღი', d(p.encounterDate));
  doc.moveDown(0.8);

  doc.font('R').fontSize(10.5).text(p.body, { width: W, align: 'justify', lineGap: 2.5 });
  doc.moveDown(1.2);

  if (doc.y > doc.page.height - 230) doc.addPage();
  doc.font('B').fontSize(10).text('გადაწყვეტილება:');
  doc.moveDown(0.3);
  if (p.mode === 'blank') {
    doc.font('R').fontSize(10.5).text('[   ]  ვეთანხმები          [   ]  არ ვეთანხმები');
  } else {
    doc.font('B').fontSize(11).text(p.decision === 'granted' ? '[X]  ვეთანხმები' : '[X]  არ ვეთანხმები');
  }
  doc.moveDown(1);

  const s = p.signer;
  if (p.mode === 'blank') {
    doc.font('R').fontSize(10)
      .text('ხელმომწერი:  [   ] პაციენტი    [   ] კანონიერი წარმომადგენელი')
      .moveDown(0.6).text('წარმომადგენლის სახელი, გვარი: ____________________________   კავშირი: ______________')
      .moveDown(0.6).text('წარმომადგენლის პირადი №: ____________________')
      .moveDown(1.2).text('ხელმოწერა: ______________________          თარიღი: ____ / ____ / ________')
      .moveDown(1.2).text('თანამშრომელი (სახელი, გვარი, ხელმოწერა): ___________________________________');
  } else {
    doc.font('R').fontSize(10).text(s?.type === 'representative'
      ? `ხელმომწერი: კანონიერი წარმომადგენელი — ${s.name ?? ''} (${s.relation ?? ''})${s.idNumber ? `, პ/ნ ${s.idNumber}` : ''}`
      : `ხელმომწერი: პაციენტი — ${p.patient.name}`);
    doc.moveDown(0.5);
    const y = doc.y;
    doc.text('ხელმოწერა:', L, y + 20);
    if (p.signaturePng) doc.image(p.signaturePng, L + 80, y, { fit: [220, 70] });
    doc.moveTo(L + 80, y + 72).lineTo(L + 300, y + 72).strokeColor('#999').lineWidth(0.5).stroke();
    doc.y = y + 85; doc.x = L;
    doc.text(`თარიღი და დრო: ${p.signedAt ? dt(p.signedAt) : ''}`);
    if (p.recordedBy) doc.text(`თანამშრომელი: ${p.recordedBy}`);
  }

  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    if (!p.textApproved) {
      doc.save().rotate(-35, { origin: [doc.page.width / 2, doc.page.height / 2] })
        .font('B').fontSize(34).fillColor('#E0E0E0', 0.6)
        .text('ტექსტი დასამტკიცებელია', 0, doc.page.height / 2 - 20, { width: doc.page.width, align: 'center' }).restore();
    }
    const b = doc.page.margins.bottom; doc.page.margins.bottom = 0;
    doc.font('R').fontSize(7).fillColor('#777').text(
      [p.mode === 'electronic' ? 'ელექტრონულად ხელმოწერილი' : 'დასაბეჭდი ფორმა', p.documentId && `ID ${p.documentId}`, `გვერდი ${i + 1}/${range.count}`].filter(Boolean).join(' · '),
      L, doc.page.height - 35, { width: W, align: 'center' });
    doc.page.margins.bottom = b; doc.fillColor('black');
  }
  doc.end();
  return done;
}
