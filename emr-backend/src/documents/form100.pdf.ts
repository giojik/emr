import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { join } from 'node:path';
import { COURSE_KA, CONCLUSION_KA, type DxItem, type Form100Payload } from './form100.types';

const FONT_DIR = join(__dirname, '..', '..', 'assets', 'fonts');
const REG = join(FONT_DIR, 'EmrSans-Regular.ttf');
const BOLD = join(FONT_DIR, 'EmrSans-Bold.ttf');

const fmtDate = (iso: string | null) => {
  if (!iso) return null;
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
};
const dx = (items: DxItem[]) => items.map((i) => `${i.title} (${i.code})`).join('; ');

/** ფორმა №IV-100/ა → PDF (A4). სტრუქტურა და პუნქტების ნუმერაცია — მინისტრის ბრძანება №338/ნ, დანართი №2. */
export async function renderForm100(p: Form100Payload): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 40, bottom: 50, left: 50, right: 50 }, bufferPages: true,
    info: { Title: `ფორმა №IV-100/ა — ${p.number}`, Author: p.institution.name, Subject: 'ცნობა ჯანმრთელობის მდგომარეობის შესახებ' } });
  doc.registerFont('R', REG); doc.registerFont('B', BOLD);
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res) => doc.on('end', () => res(Buffer.concat(chunks))));
  const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const L = doc.page.margins.left;

  // --- სათაური
  doc.font('R').fontSize(8).fillColor('#444').text('სამედიცინო დოკუმენტაცია ფორმა №IV-100/ა', L, 40, { width: W, align: 'right' });
  doc.fillColor('black').moveDown(0.6);
  doc.font('B').fontSize(15).text('ც ნ ო ბ ა', { width: W, align: 'center' });
  doc.font('B').fontSize(12).text('ჯანმრთელობის მდგომარეობის შესახებ', { width: W, align: 'center' });
  doc.font('R').fontSize(9).fillColor('#333').text(`№ ${p.number}`, { width: W, align: 'center' }).fillColor('black');
  doc.moveDown(0.5);

  const item = (n: number | string, label: string, value: string | null | undefined, opts: { lines?: number } = {}) => {
    if (doc.y > doc.page.height - 120) doc.addPage();
    doc.font('B').fontSize(9).text(`${n}. ${label}`, { width: W });
    const v = value?.trim();
    doc.font('R').fontSize(9.5).fillColor(v ? 'black' : '#999')
      .text(v || '—', L + 14, doc.y + 1, { width: W - 14, lineGap: 1 });
    doc.fillColor('black').moveDown(opts.lines ?? 0.3);
    doc.x = L;
  };
  // მოკლე ველები ერთ ხაზზე: "3. პაციენტის სახელი და გვარი: ნიკა მელაძე"
  const inline = (n: number | string, label: string, value: string | null | undefined) => {
    if (doc.y > doc.page.height - 120) doc.addPage();
    const v = value?.trim();
    doc.font('B').fontSize(9).text(`${n}. ${label}: `, L, doc.y, { width: W, continued: true })
      .font('R').fontSize(9.5).fillColor(v ? 'black' : '#999').text(v || '—');
    doc.fillColor('black').moveDown(0.3);
    doc.x = L;
  };

  const inst = [p.institution.name, p.institution.address, p.institution.phone && `ტელ.: ${p.institution.phone}`, p.institution.email]
    .filter(Boolean).join(', ');
  item(1, 'ცნობის გამცემი დაწესებულების დასახელება და მისამართი', inst);
  item(2, 'დაწესებულების დასახელება, მისამართი, სადაც იგზავნება ცნობა', p.recipient);
  inline(3, 'პაციენტის სახელი და გვარი', p.patient.full_name);
  inline(4, 'დაბადების თარიღი (რიცხვი/თვე/წელი)', fmtDate(p.patient.birth_date));
  inline(5, 'პირადი ნომერი (ივსება 16 წელს მიღწეული პირის შემთხვევაში)',
    p.patient.personal_number ?? (p.patient.passport_number ? `პასპორტი: ${p.patient.passport_number}` : null));
  inline(6, 'მისამართი', [p.patient.address, p.patient.phone && `ტელ.: ${p.patient.phone}`].filter(Boolean).join(', '));
  item(7, 'სამუშაო ადგილი და თანამდებობა (მოსწავლის/სტუდენტის შემთხვევაში — სასწავლო დაწესებულება და კლასი/კურსი)', p.workplace);
  item(8, 'თარიღები', [
    `ა) ამბულატორიაში მიმართვის: ${fmtDate(p.dates.outpatient_visit) ?? '—'}      ბ) სტაციონარში გაგზავნის: ${fmtDate(p.dates.sent_to_hospital) ?? '—'}`,
    `გ) სტაციონარში მოთავსების: ${fmtDate(p.dates.admitted) ?? '—'}      დ) გაწერის: ${fmtDate(p.dates.discharged) ?? '—'}`,
  ].join('\n'));

  const dxLines: string[] = [];
  if (p.conclusion) dxLines.push(`დასკვნა: ${CONCLUSION_KA[p.conclusion]}`);
  if (p.diagnosis.primary.length) dxLines.push(`ძირითადი დაავადება: ${dx(p.diagnosis.primary)}`);
  if (p.diagnosis.secondary.length) dxLines.push(`თანმხლები დაავადებები: ${dx(p.diagnosis.secondary)}`);
  if (p.diagnosis.complications.length) dxLines.push(`გართულებები: ${dx(p.diagnosis.complications)}`);
  if (p.diagnosis.note) dxLines.push(p.diagnosis.note);
  item(9, 'დასკვნა ჯანმრთელობის მდგომარეობის შესახებ ან სრული დიაგნოზი (ძირითადი დაავადება, თანმხლები დაავადებები, გართულებები) — ICD-10', dxLines.join('\n'));
  item(10, 'გადატანილი დაავადებები', p.past_diseases);
  item(11, 'მოკლე ანამნეზი', p.anamnesis);
  item(12, 'ჩატარებული დიაგნოსტიკური გამოკვლევები და კონსულტაციები', p.investigations);
  inline(13, 'ავადმყოფობის მიმდინარეობა', p.course ? COURSE_KA[p.course] : null);
  item(14, 'ჩატარებული მკურნალობა', p.treatment);
  (p.state_on_referral ? item : inline)(15, 'მდგომარეობა სტაციონარში გაგზავნისას', p.state_on_referral);
  (p.state_on_discharge ? item : inline)(16, 'მდგომარეობა სტაციონარიდან გაწერისას', p.state_on_discharge);
  item(17, 'სამკურნალო და შრომითი რეკომენდაციები', p.recommendations);

  // --- ხელმოწერები + QR (ერთ ბლოკში, გვერდზე არ უნდა გაიყოს)
  if (doc.y > doc.page.height - 175) doc.addPage();
  doc.moveDown(0.4);
  const blockTop = doc.y;
  const leftW = W - 140;
  doc.font('B').fontSize(9.5).text('18. მკურნალი ექიმი', L, blockTop, { width: leftW });
  doc.font('R').fontSize(10).text(
    [p.doctor.specialty, p.doctor.name, p.doctor.license_number && `სერტ. №${p.doctor.license_number}`].filter(Boolean).join(', '),
    L + 14, doc.y + 1, { width: leftW - 14 });
  doc.font('R').fontSize(9).text('ხელმოწერა ______________________', L + 14, doc.y + 5);
  doc.moveDown(0.5);
  doc.font('B').fontSize(9.5).text(`19. ${p.director.title}`, L, doc.y, { width: leftW });
  doc.font('R').fontSize(10).text(p.director.name, L + 14, doc.y + 1, { width: leftW - 14 });
  doc.font('R').fontSize(9).text('ხელმოწერა ______________________', L + 14, doc.y + 5);
  doc.moveDown(0.5);
  doc.font('B').fontSize(9.5).text('20. ცნობის გაცემის თარიღი', L, doc.y);
  doc.font('R').fontSize(10).text(fmtDate(p.issued_at) ?? '', L + 14, doc.y + 1);
  doc.moveDown(0.6);
  doc.font('R').fontSize(9).fillColor('#555').text('ბ.ა. (ბეჭდის ადგილი)', L + 14, doc.y).fillColor('black');

  const qr = await QRCode.toBuffer(p.verify_url, { errorCorrectionLevel: 'M', margin: 1, width: 240 });
  const qx = L + W - 100;
  doc.image(qr, qx, blockTop, { width: 100 });
  doc.font('R').fontSize(7).fillColor('#444')
    .text('დოკუმენტის ნამდვილობის შემოწმება', qx - 15, blockTop + 102, { width: 130, align: 'center' })
    .text(p.number, qx - 15, doc.y + 1, { width: 130, align: 'center' }).fillColor('black');

  // --- ქვედა კოლონტიტული ყველა გვერდზე
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font('R').fontSize(7).fillColor('#777')
      .text(`${p.number} · გვერდი ${i + 1}/${range.count} · ელექტრონულად გენერირებული; ნამდვილობა მოწმდება QR-კოდით`,
        L, doc.page.height - 35, { width: W, align: 'center' });
    doc.page.margins.bottom = bottom;
  }
  doc.end();
  return done;
}
