/**
 * სატესტო წერილი პირდაპირ IMAP ყუთში (APPEND) — გარე ლაბორატორიის ელ-ფოსტის სრული ტესტისთვის (IMAP → worker → მიბმა).
 * SMTP-ს არ იყენებს და არავის უგზავნის: წერილი ჩნდება ყუთში (IMAP_MAILBOX), როგორც წაუკითხავი.
 * PDF-ს თავად ქმნის: text (ტექსტური, პ/ნ + დაბ. თარიღი), scan (იგივე, სურათად — OCR-ისთვის), name (მხოლოდ სახელი).
 *
 *   node dist/cli/lab-mail-inject.js --from lab@test.local --subject "EMR 1000123" --filename 1000123.pdf \
 *        --kind text --patient "ტესტი ტესტაძე" --pn 01099999901 --dob 01.01.1990
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImapFlow } from 'imapflow';
import MailComposer from 'nodemailer/lib/mail-composer';
import PDFDocument from 'pdfkit';
import { loadEnv } from '../config/env';

const arg = (k: string, d = '') => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] ?? d : d; };
const FONT = join(__dirname, '..', '..', 'assets', 'fonts');

function textPdf(o: { patient: string; pn: string; dob: string }): Promise<Buffer> {
  return new Promise((resolve) => {
    const d = new PDFDocument({ size: 'A4', margin: 50 }); const ch: Buffer[] = [];
    d.on('data', (c: Buffer) => ch.push(c)); d.on('end', () => resolve(Buffer.concat(ch)));
    d.registerFont('R', join(FONT, 'EmrSans-Regular.ttf')); d.registerFont('B', join(FONT, 'EmrSans-Bold.ttf'));
    d.font('B').fontSize(16).text('შპს „სატესტო ლაბორატორია“', { align: 'center' });
    d.font('R').fontSize(9).fillColor('#555').text('სატესტო დოკუმენტი — არ არის ნამდვილი', { align: 'center' }).moveDown(1.5);
    d.fillColor('black').font('B').fontSize(13).text('კვლევის შედეგი').moveDown(0.5);
    d.font('R').fontSize(11).text(`პაციენტი: ${o.patient}`);
    if (o.pn) d.text(`პირადი ნომერი: ${o.pn}`);
    if (o.dob) d.text(`დაბადების თარიღი: ${o.dob}`);
    d.moveDown(1).text('25-OH ვიტამინი D: 32.4 ng/mL (30 – 100)');
    d.end();
  });
}
const run = (cmd: string, args: string[]) => new Promise<void>((res, rej) => execFile(cmd, args, { timeout: 60_000 }, (e) => (e ? rej(e) : res())));
/** ტექსტური PDF → სურათი (pdftoppm) → PDF მხოლოდ სურათით (ტექსტის ფენის გარეშე) */
async function scanPdf(src: Buffer): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'inject-'));
  try {
    await writeFile(join(dir, 'in.pdf'), src);
    await run('pdftoppm', ['-r', '110', '-png', '-singlefile', join(dir, 'in.pdf'), join(dir, 'page')]);
    const png = await readFile(join(dir, 'page.png'));
    return await new Promise((resolve) => {
      const d = new PDFDocument({ size: 'A4', margin: 0 }); const ch: Buffer[] = [];
      d.on('data', (c: Buffer) => ch.push(c)); d.on('end', () => resolve(Buffer.concat(ch)));
      d.image(png, 0, 0, { width: 595.28 }); d.end();
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

async function main() {
  const env = loadEnv();
  if (!env.IMAP_HOST || !env.IMAP_USER) throw new Error('IMAP არ არის კონფიგურირებული (IMAP_HOST, IMAP_USER)');
  const kind = arg('kind', 'text');
  const patient = arg('patient', 'ტესტი ტესტაძე');
  let pdf = await textPdf({ patient, pn: kind === 'name' ? '' : arg('pn'), dob: kind === 'name' ? '' : arg('dob') });
  if (kind === 'scan') pdf = await scanPdf(pdf);
  const raw: Buffer = await new MailComposer({
    from: arg('from'), to: env.IMAP_USER, subject: arg('subject'), text: arg('body', 'სატესტო წერილი (EMR e2e).'),
    attachments: [{ filename: arg('filename', 'result.pdf'), content: pdf, contentType: 'application/pdf' }],
  }).compile().build();
  const c = new ImapFlow({ host: env.IMAP_HOST, port: env.IMAP_PORT, secure: env.IMAP_SECURE, logger: false,
    auth: { user: env.IMAP_USER, pass: env.IMAP_PASS ?? '' }, tls: { rejectUnauthorized: env.IMAP_TLS_VERIFY } });
  await c.connect();
  await c.append(env.IMAP_MAILBOX, raw);   // დროშების გარეშე — წაუკითხავი
  await c.logout();
  console.log(JSON.stringify({ ok: true, subject: arg('subject'), bytes: raw.length, kind }));
}
main().catch((e: Error) => { console.log(JSON.stringify({ ok: false, error: e.message })); process.exit(1); });
