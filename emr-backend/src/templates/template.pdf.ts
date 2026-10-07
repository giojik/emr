import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { join } from 'node:path';
import { fillText, type Block } from './template-blocks';

const FONT_DIR = join(__dirname, '..', '..', 'assets', 'fonts');

export interface DxItem { code: string; title: string }
export interface LabRow { date: string; test: string; value: string; unit?: string | null; ref?: string | null; flag?: string | null }
export interface DxResultRow { date: string; title: string; conclusion: string | null }
export interface Signer { name: string; role?: string | null; at?: string | null }

export interface TemplatePdfInput {
  clinic: { name: string; address: string; phone: string | null };
  title: string;
  number?: string | null;
  verifyUrl?: string | null;
  watermark?: string | null;                 // „პროექტი“ / „ნიმუში“ / „ტექსტი დასამტკიცებელია“
  vars: Record<string, string>;
  blocks: Block[];
  data: {
    patient: { full_name: string; birth_date: string | null; id_number: string | null; address: string | null; phone: string | null };
    diagnoses?: { final: { primary: DxItem[]; secondary: DxItem[]; complication: DxItem[] }; admission: DxItem[] };
    fields?: Record<string, string | null | undefined>;
    lab?: LabRow[];
    dx?: DxResultRow[];
    signatures?: Partial<Record<'attending' | 'department_head' | 'patient', Signer>>;
  };
  footer?: string | null;
}

const SIGNER_KA = { attending: 'მკურნალი ექიმი', department_head: 'განყოფილების ხელმძღვანელი', patient: 'პაციენტი / წარმომადგენელი' } as const;
const dxLine = (xs: DxItem[]) => xs.map((x) => `${x.code} — ${x.title}`).join('\n');

/** ბლოკური შაბლონი → PDF (A4). ეპიკრიზი, „სხვა“ დოკუმენტები, შაბლონის preview. */
export async function renderTemplatePdf(p: TemplatePdfInput): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 40, bottom: 55, left: 50, right: 50 }, bufferPages: true,
    info: { Title: [p.title, p.number].filter(Boolean).join(' — '), Author: p.clinic.name } });
  doc.registerFont('R', join(FONT_DIR, 'EmrSans-Regular.ttf')); doc.registerFont('B', join(FONT_DIR, 'EmrSans-Bold.ttf'));
  const chunks: Buffer[] = []; doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res) => doc.on('end', () => res(Buffer.concat(chunks))));
  const L = doc.page.margins.left; const W = doc.page.width - L - doc.page.margins.right;
  const room = (h: number) => { if (doc.y > doc.page.height - doc.page.margins.bottom - h) doc.addPage(); };
  const section = (label: string, value: string | null | undefined) => {
    room(60);
    doc.font('B').fontSize(9.5).fillColor('black').text(label, L, doc.y, { width: W });
    const v = value?.trim();
    doc.font('R').fontSize(10).fillColor(v ? 'black' : '#999').text(v || '—', L + 12, doc.y + 1, { width: W - 12, lineGap: 1.5 });
    doc.fillColor('black').moveDown(0.5); doc.x = L;
  };
  const qr = p.verifyUrl ? await QRCode.toBuffer(p.verifyUrl, { errorCorrectionLevel: 'M', margin: 1, width: 200 }) : null;
  const hasHeader = p.blocks.some((b) => b.type === 'header');
  if (!hasHeader) doc.y = 40;

  for (const b of p.blocks) {
    switch (b.type) {
      case 'header': {
        const top = doc.y;
        doc.font('B').fontSize(10.5).text(p.clinic.name, L, top, { width: W - 90 });
        doc.font('R').fontSize(8.5).fillColor('#555').text([p.clinic.address, p.clinic.phone].filter(Boolean).join(' · '), { width: W - 90 }).fillColor('black');
        if (p.number) doc.font('R').fontSize(9).text(`№ ${p.number}`, { width: W - 90 });
        if (qr) {
          doc.image(qr, L + W - 70, top - 5, { width: 70 });
          doc.font('R').fontSize(6.5).fillColor('#555').text('ნამდვილობის შემოწმება', L + W - 85, top + 66, { width: 100, align: 'center' }).fillColor('black');
        }
        doc.y = Math.max(doc.y, top + (qr ? 80 : 0)); doc.x = L; doc.moveDown(0.6);
        break;
      }
      case 'heading':
        room(40); doc.moveDown(0.3);
        doc.font('B').fontSize(13).text(fillText(b.text, p.vars), L, doc.y, { width: W, align: 'center' }); doc.moveDown(0.5);
        break;
      case 'text':
        room(30);
        doc.font('R').fontSize(10).text(fillText(b.text, p.vars), L, doc.y, { width: W, align: 'justify', lineGap: 2 }); doc.moveDown(0.6);
        break;
      case 'patient': {
        room(70);
        const pt = p.data.patient;
        const row = (k: string, v: string | null) => doc.font('B').fontSize(9.5).text(`${k}: `, L, doc.y, { continued: true, width: W }).font('R').text(v || '—');
        row('პაციენტი', pt.full_name); row('დაბადების თარიღი', pt.birth_date); row('პირადი № / დოკუმენტი', pt.id_number);
        row('მისამართი', [pt.address, pt.phone && `ტელ.: ${pt.phone}`].filter(Boolean).join(', ') || null);
        doc.moveDown(0.5);
        break;
      }
      case 'diagnoses': {
        const d = p.data.diagnoses;
        if (b.which === 'admission') { section(b.label, d ? dxLine(d.admission) : null); break; }
        const f = d?.final;
        section(b.label, f ? [
          f.primary.length ? `ძირითადი: ${dxLine(f.primary)}` : '',
          f.secondary.length ? `თანმხლები:\n${dxLine(f.secondary)}` : '',
          f.complication.length ? `გართულებები:\n${dxLine(f.complication)}` : '',
        ].filter(Boolean).join('\n') : null);
        break;
      }
      case 'field':
        section(b.label, p.data.fields?.[b.key] ?? (b.prefill ? fillText(b.prefill, p.vars) : null));
        break;
      case 'lab_results': {
        const rows = p.data.lab ?? [];
        room(50);
        doc.font('B').fontSize(9.5).text(b.label, L, doc.y, { width: W });
        if (!rows.length) { doc.font('R').fontSize(10).fillColor('#999').text('—', L + 12).fillColor('black'); doc.moveDown(0.5); break; }
        const cols = [{ w: 62, k: 'date' }, { w: W - 62 - 70 - 45 - 85 - 22, k: 'test' }, { w: 70, k: 'value' }, { w: 45, k: 'unit' }, { w: 85, k: 'ref' }, { w: 22, k: 'flag' }] as const;
        const head = { date: 'თარიღი', test: 'კვლევა', value: 'შედეგი', unit: 'ერთ.', ref: 'ნორმა', flag: '' };
        const line = (r: Record<string, string | null | undefined>, bold: boolean) => {
          room(16);
          const y = doc.y; let x = L; let h = 0;
          for (const c of cols) {
            doc.font(bold || (c.k === 'value' && r.flag) ? 'B' : 'R').fontSize(8.5).fillColor(!bold && c.k === 'flag' && r.flag ? '#B00020' : 'black');
            const t = r[c.k] ?? ''; doc.text(t, x + 2, y, { width: c.w - 4 }); h = Math.max(h, doc.heightOfString(t, { width: c.w - 4 })); x += c.w;
          }
          doc.fillColor('black'); doc.y = y + h + 3;
          doc.moveTo(L, doc.y - 1).lineTo(L + W, doc.y - 1).strokeColor('#DDD').lineWidth(0.4).stroke();
        };
        line(head, true);
        for (const r of rows) line({ ...r }, false);
        doc.x = L; doc.moveDown(0.6);
        break;
      }
      case 'dx_results': {
        const rows = p.data.dx ?? [];
        section(b.label, rows.length ? rows.map((r) => `${r.date} — ${r.title}${r.conclusion ? `: ${r.conclusion}` : ''}`).join('\n') : null);
        break;
      }
      case 'signatures': {
        room(40 + 45 * b.signers.length); doc.moveDown(0.6);
        for (const s of b.signers) {
          const who = p.data.signatures?.[s];
          doc.font('B').fontSize(9.5).text(SIGNER_KA[s], L, doc.y, { width: W });
          doc.font('R').fontSize(10).text(who ? [who.role, who.name].filter(Boolean).join(', ') : '', L + 12, doc.y + 1, { width: W / 2 });
          doc.font('R').fontSize(9).text(who?.at ? `ელექტრონულად ხელმოწერილი: ${who.at}` : 'ხელმოწერა ______________________   თარიღი ____/____/______',
            L + 12, doc.y + 3, { width: W - 12 });
          doc.moveDown(0.8);
        }
        break;
      }
    }
  }

  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    if (p.watermark) {
      doc.save().rotate(-35, { origin: [doc.page.width / 2, doc.page.height / 2] }).font('B').fontSize(40).fillColor('#E0E0E0', 0.55)
        .text(p.watermark, 0, doc.page.height / 2 - 20, { width: doc.page.width, align: 'center' }).restore();
    }
    const bm = doc.page.margins.bottom; doc.page.margins.bottom = 0;
    doc.font('R').fontSize(7).fillColor('#777').text([p.footer, p.number, `გვერდი ${i + 1}/${range.count}`].filter(Boolean).join(' · '),
      L, doc.page.height - 35, { width: W, align: 'center' });
    doc.page.margins.bottom = bm; doc.fillColor('black');
  }
  doc.end();
  return done;
}
