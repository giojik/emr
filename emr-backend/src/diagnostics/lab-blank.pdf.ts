import QRCode from 'qrcode';
import { d, dt, newDoc } from './diagnostics.pdf';
import type { BlankSettings, Column } from './lab-blank.settings';

/** ლაბორატორიული პასუხის ბლანკი — შაბლონის პარამეტრებით (ლოგო, ველები, სვეტები, განლაგება, ხელმოწერა, ბეჭედი, QR) */

export interface BlankResult {
  name: string; value_num: string | null; value_text: string | null; unit: string;
  ref_low: string | null; ref_high: string | null; ref_text: string | null; flag: string | null;
  previous?: { value: string; at: string } | null;
}
export interface BlankItem {
  service_name: string; group_name: string; comment: string | null; barcode: string | null;
  collected_at: string | null; received_at: string | null; validated_at: string | null; validated_by_name: string | null;
  method_name: string | null; results: BlankResult[];
}
export interface BlankSection { settings: BlankSettings; images: Map<string, Buffer>; items: BlankItem[]; verify_url?: string | null }
export interface BlankInput {
  clinic: { name: string; address: string; phone: string | null; email?: string | null };
  patient: { name: string; birth_date: string; gender: string; id_number: string | null; phone: string | null };
  ordered_by: string | null; referral: string | null; pregnancy_weeks: number | null; printed_at?: Date;
  sections: BlankSection[]; preview?: boolean;
}

const mm = (v: number) => (v * 72) / 25.4;
const PAPER: Record<string, [number, number]> = { A4: [595.28, 841.89], A5: [419.53, 595.28] };
const RED = '#B42318'; const GRAY = '#666666'; const LINE = '#D0D5DD';
const WORD: Record<string, string> = { L: 'დაბალი', H: 'მაღალი', LL: 'კრიტ. დაბ.', HH: 'კრიტ. მაღ.', A: 'გადახრა' };
const SUP: Record<string, string> = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
export const unitFmt = (u: string) => u.replace(/\^(\d+)/g, (_m, g: string) => g.split('').map((c) => SUP[c]).join(''));
const numFmt = (v: string) => String(Number(v));
export const refText = (r: Pick<BlankResult, 'ref_low' | 'ref_high' | 'ref_text'>) =>
  r.ref_text ?? (r.ref_low !== null && r.ref_high !== null ? `${numFmt(r.ref_low)} – ${numFmt(r.ref_high)}` : r.ref_low !== null ? `> ${numFmt(r.ref_low)}` : r.ref_high !== null ? `< ${numFmt(r.ref_high)}` : '');
const valueText = (r: BlankResult) => (r.value_num !== null ? numFmt(r.value_num) : r.value_text ?? '');
const abnormal = (f: string | null) => !!f && f !== 'N';
const critical = (f: string | null) => f === 'LL' || f === 'HH';

/** ასაკი ბლანკისთვის: წლები; 2 წლამდე — თვეები; 1 თვემდე — დღეები */
export function ageText(birth: string, at: Date) {
  const b = new Date(`${birth}T00:00:00Z`);
  const days = Math.floor((at.getTime() - b.getTime()) / 86_400_000);
  if (days < 31) return `${Math.max(days, 0)} დღ.`;
  let months = (at.getUTCFullYear() - b.getUTCFullYear()) * 12 + (at.getUTCMonth() - b.getUTCMonth());
  if (at.getUTCDate() < b.getUTCDate()) months -= 1;
  return months < 24 ? `${months} თვ.` : `${Math.floor(months / 12)} წ.`;
}

type Doc = PDFKit.PDFDocument;

interface Cur { y: number; ensure: (h: number, onBreak?: () => void) => void }

export async function renderLabBlank(p: BlankInput): Promise<Buffer> {
  const { doc, done } = newDoc('A4', 0);
  const now = p.printed_at ?? new Date();
  const pageSection: BlankSettings[] = [];               // გვერდი → სექციის პარამეტრები (ქვედა კოლონტიტულისთვის)
  let current: BlankSettings = p.sections[0]?.settings;
  doc.on('pageAdded', () => pageSection.push(current));   // PDFKit-ის ავტომატური გვერდიც აღირიცხება

  for (const sec of p.sections) {
    const S = sec.settings; const fs = S.font_size; const M = mm(S.margin_mm);
    current = S;
    const [PW, PH] = PAPER[S.paper];
    const L = M; const W = PW - 2 * M;
    const bottom = PH - M - 14;
    const addPage = () => {
      doc.addPage({ size: [PW, PH], margins: { top: M, bottom: 0, left: M, right: M } });
      if (p.preview) {
        doc.save().rotate(-35, { origin: [PW / 2, PH / 2] }).font('B').fontSize(PW / 6).fillColor('#000').opacity(0.05)
          .text('ნიმუში', 0, PH / 2 - PW / 12, { width: PW, align: 'center', lineBreak: false }).restore();
        doc.opacity(1).font('R').fontSize(fs).fillColor('black');
      }
    };
    addPage();
    const cur: Cur = { y: M, ensure: (h, onBreak) => { if (cur.y + h > bottom) { addPage(); cur.y = M; onBreak?.(); } } };
    cur.y = drawHeader(doc, p, sec, L, W, cur.y);
    cur.y = drawPatient(doc, p, S, L, W, cur.y, now);

    let lastGroup: string | null = null;
    for (const it of sec.items) {
      cur.ensure(fs * 7);
      if (S.group_headers && it.group_name !== lastGroup) {
        cur.y += fs * 0.4;
        doc.font('B').fontSize(fs - 0.5).fillColor(GRAY).text(it.group_name.toUpperCase(), L, cur.y, { width: W, characterSpacing: 0.6 });
        cur.y = doc.y + 2; lastGroup = it.group_name;
      }
      cur.y += fs * 0.5;
      doc.font('B').fontSize(fs + 2).fillColor(S.accent_color).text(it.service_name, L, cur.y, { width: W });
      cur.y = doc.y + 1;
      if (S.show_sample_info) {
        const info = [it.barcode && `ნიმუში ${it.barcode}`, it.collected_at && `აღება ${dt(it.collected_at)}`, it.received_at && `მიღება ${dt(it.received_at)}`,
          !S.columns.includes('method') && it.method_name ? `ანალიზატორი: ${it.method_name}` : null].filter(Boolean).join(' · ');
        if (info) { doc.font('R').fontSize(fs - 1.5).fillColor(GRAY).text(info, L, cur.y, { width: W }); cur.y = doc.y + 2; }
      }
      doc.fillColor('black');
      if (S.layout === 'text') drawText(doc, S, it, L, W, cur);
      else if (S.layout === 'two_column') drawTwoCol(doc, S, it, L, W, cur);
      else drawTable(doc, S, it, L, W, cur);
      if (S.show_service_comment && it.comment?.trim()) {
        doc.font('R').fontSize(fs - 1);
        const h = doc.heightOfString(it.comment, { width: W - 12 }) + 8;
        cur.ensure(Math.min(h, bottom - M));
        doc.rect(L, cur.y + 2, 2, h - 4).fill(S.accent_color);
        doc.fillColor('#333').text(it.comment, L + 10, cur.y + 4, { width: W - 12 });
        cur.y = doc.y + 4; doc.fillColor('black');
      }
    }

    // ---- ძირი: შენიშვნა, ვალიდატორი, ხელმოწერა, ბეჭედი, QR (ერთ ბლოკად — გვერდზე არ იყოფა)
    const F = S.footer;
    const sig = F.signature_image_id ? sec.images.get(F.signature_image_id) : undefined;
    const stamp = F.stamp_image_id ? sec.images.get(F.stamp_image_id) : undefined;
    const qr = F.show_qr && sec.verify_url ? await QRCode.toBuffer(sec.verify_url, { errorCorrectionLevel: 'M', margin: 1, width: 200 }) : undefined;
    const validators = [...new Set(sec.items.map((i) => i.validated_by_name).filter((x): x is string => !!x))];
    doc.font('R').fontSize(fs - 1);
    const noteH = F.note.trim() ? doc.heightOfString(F.note, { width: W }) + 6 : 0;
    const blockH = Math.max(stamp ? mm(28) : 0, qr ? mm(22) : 0, (F.show_validator ? fs * 2.8 : 0) + (sig ? mm(14) : 0)) + 6;
    cur.ensure(noteH + blockH + fs);
    cur.y += fs;
    if (noteH) { doc.font('R').fontSize(fs - 1).fillColor('#333').text(F.note, L, cur.y, { width: W }); cur.y = doc.y + 6; }
    const top = cur.y;
    if (qr) {
      doc.image(qr, L, top, { width: mm(22), height: mm(22) });
      doc.font('R').fontSize(fs - 2.5).fillColor(GRAY).text('ნამდვილობის შემოწმება — დაასკანერეთ', L + mm(24), top + mm(8), { width: mm(30) });
    }
    // მარჯვენა ბლოკი: ხელმომწერი + ხელმოწერა (QR-ს და ბეჭედს შორის; A5-ზე ვიწროვდება)
    const rx = Math.max(L + W - mm(72), L + (qr ? mm(57) : 0));
    const sw = Math.max(mm(26), Math.min(mm(42), L + W - (stamp ? mm(31) : 0) - rx));
    if (stamp) doc.image(stamp, L + W - mm(30), top, { fit: [mm(28), mm(28)], align: 'center', valign: 'center' });
    let sy = top;
    if (F.show_validator) {
      doc.font('R').fontSize(fs - 1).fillColor(GRAY).text(F.signer_title, rx, sy, { width: sw });
      doc.font('B').fontSize(fs).fillColor('black').text(validators.join(', ') || '—', rx, doc.y + 1, { width: sw });
      sy = doc.y + 2;
    }
    if (sig) doc.image(sig, rx, sy, { fit: [Math.min(mm(40), sw), mm(14)] });
    cur.y = top + blockH;
    doc.fillColor('black');
  }

  // ---- ქვედა კოლონტიტული ყველა გვერდზე
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const S = pageSection[i - range.start]; const [PW, PH] = PAPER[S.paper]; const M = mm(S.margin_mm);
    const parts: string[] = [];
    if (S.footer.legend) parts.push(LEGEND[S.flag_style]);
    if (S.footer.show_page_numbers) parts.push(`გვერდი ${i - range.start + 1}/${range.count}`);
    parts.push(`დაიბეჭდა ${dt(now)}`);
    doc.font('R').fontSize(6.5).fillColor('#888').text(parts.join(' · '), M, PH - M - 6, { width: PW - 2 * M, align: 'center', lineBreak: false });
  }
  doc.end();
  return done;
}

const LEGEND: Record<BlankSettings['flag_style'], string> = {
  words: '„კრიტ.“ — კრიტიკული მნიშვნელობა, საჭიროებს ექიმის დაუყოვნებლივ ინფორმირებას',
  letters: 'L/H — ნორმის გარეთ; LL/HH — კრიტიკული, საჭიროებს ექიმის დაუყოვნებლივ ინფორმირებას',
  arrows: 'სამკუთხედი — ნორმის გარეთ (ზემოთ/ქვემოთ); ორმაგი წითელი — კრიტიკული; * — გადახრა',
};

// ======================================================================= თავი
function drawHeader(doc: Doc, p: BlankInput, sec: BlankSection, L: number, W: number, y0: number) {
  const S = sec.settings; const H = S.header; const fs = S.font_size;
  const logo = H.logo_image_id ? sec.images.get(H.logo_image_id) : undefined;
  const lh = mm(H.logo_height_mm);
  const lines: { text: string; bold?: boolean; size: number; color: string }[] = [];
  if (H.show_clinic) {
    lines.push({ text: p.clinic.name, bold: true, size: fs + 2, color: 'black' });
    lines.push({ text: [p.clinic.address, p.clinic.phone, p.clinic.email].filter(Boolean).join(' · '), size: fs - 1, color: GRAY });
  }
  for (const l of H.extra_lines) if (l.trim()) lines.push({ text: l, size: fs - 1, color: GRAY });
  let y = y0; let blockBottom = y0;
  if (logo && H.logo_position === 'center') {
    const lw = logoWidth(doc, logo, lh);
    doc.image(logo, L + (W - lw) / 2, y, { height: lh });
    y += lh + 4;
    for (const l of lines) { doc.font(l.bold ? 'B' : 'R').fontSize(l.size).fillColor(l.color).text(l.text, L, y, { width: W, align: 'center' }); y = doc.y; }
    blockBottom = y;
  } else {
    const lw = logo ? logoWidth(doc, logo, lh) : 0;
    const tx = logo && H.logo_position === 'left' ? L + lw + 10 : L;
    const tw = W - (logo ? lw + 10 : 0);
    if (logo) doc.image(logo, H.logo_position === 'left' ? L : L + W - lw, y, { height: lh });
    for (const l of lines) {
      doc.font(l.bold ? 'B' : 'R').fontSize(l.size).fillColor(l.color).text(l.text, tx, y, { width: tw });
      y = doc.y;
    }
    blockBottom = Math.max(y, y0 + (logo ? lh : 0));
  }
  y = blockBottom + 5;
  doc.moveTo(L, y).lineTo(L + W, y).lineWidth(1.2).strokeColor(S.accent_color).stroke();
  y += 8;
  if (H.title.trim()) { doc.font('B').fontSize(fs + 5).fillColor(S.accent_color).text(H.title, L, y, { width: W, align: 'center' }); y = doc.y + 1; }
  if (H.subtitle.trim()) { doc.font('R').fontSize(fs - 1).fillColor(GRAY).text(H.subtitle, L, y, { width: W, align: 'center' }); y = doc.y; }
  doc.fillColor('black');
  return y + 6;
}
function logoWidth(doc: Doc, img: Buffer, h: number) {
  const i = (doc as unknown as { openImage: (b: Buffer) => { width: number; height: number } }).openImage(img);
  return Math.min((i.width / i.height) * h, mm(80));
}

// ======================================================================= პაციენტი
function drawPatient(doc: Doc, p: BlankInput, S: BlankSettings, L: number, W: number, y0: number, now: Date) {
  const fs = S.font_size; const P = p.patient;
  const G: Record<string, string> = { male: 'მამრობითი', female: 'მდედრობითი' };
  const fields: [string, string][] = [];
  for (const f of S.patient_fields) {
    if (f === 'personal_number' && P.id_number) fields.push(['პირადი №', P.id_number]);
    if (f === 'birth_date') fields.push(['დაბადების თარიღი', d(P.birth_date)]);
    if (f === 'age') fields.push(['ასაკი', ageText(P.birth_date, now)]);
    if (f === 'gender') fields.push(['სქესი', G[P.gender] ?? '—']);
    if (f === 'phone' && P.phone) fields.push(['ტელეფონი', P.phone]);
    if (f === 'ordered_by' && p.ordered_by) fields.push(['დანიშნა', p.ordered_by]);
    if (f === 'referral' && p.referral) fields.push(['მიმართვა', p.referral]);
    if (f === 'pregnancy' && p.pregnancy_weeks) fields.push(['ორსულობა', `${p.pregnancy_weeks} კვირა`]);
  }
  const cols = S.paper === 'A5' ? 2 : 3; const cw = (W - 16) / cols;
  doc.font('R').fontSize(fs);
  const rowH = fs * 2.4;
  const h = 10 + fs * 1.8 + Math.ceil(fields.length / cols) * rowH + 4;
  doc.roundedRect(L, y0, W, h, 3).fillColor('#F4F6F8').fill();
  doc.font('B').fontSize(fs + 2).fillColor('black').text(P.name, L + 8, y0 + 7, { width: W - 16, lineBreak: false });
  fields.forEach(([k, v], i) => {
    const x = L + 8 + (i % cols) * cw; const yy = y0 + 10 + fs * 1.8 + Math.floor(i / cols) * rowH;
    doc.font('R').fontSize(fs - 2).fillColor(GRAY).text(k, x, yy, { width: cw - 6, lineBreak: false });
    doc.font('R').fontSize(fs).fillColor('black').text(v, x, yy + fs * 0.95, { width: cw - 6, lineBreak: false, ellipsis: true });
  });
  return y0 + h + 6;
}

// ======================================================================= ნიშნები
function flagLabel(style: BlankSettings['flag_style'], f: string | null) {
  if (!abnormal(f)) return '';
  return style === 'letters' ? f! : style === 'words' ? WORD[f!] ?? '' : '';
}
/** ვექტორული ისრები (შრიფტში ↑↓ არ არის): L/H — ერთი, LL/HH — ორი */
function arrows(doc: Doc, f: string | null, x: number, yMid: number, size: number) {
  if (!abnormal(f) || f === 'A') {
    if (f === 'A') doc.font('B').fontSize(size * 1.6).fillColor('black').text('*', x, yMid - size, { lineBreak: false });
    return 0;
  }
  const up = f === 'H' || f === 'HH'; const n = critical(f) ? 2 : 1; const c = critical(f) ? RED : 'black';
  for (let k = 0; k < n; k++) {
    const cx = x + k * (size + 1.5) + size / 2;
    if (up) doc.polygon([cx - size / 2, yMid + size / 2], [cx + size / 2, yMid + size / 2], [cx, yMid - size / 2]);
    else doc.polygon([cx - size / 2, yMid - size / 2], [cx + size / 2, yMid - size / 2], [cx, yMid + size / 2]);
    doc.fill(c);
  }
  return n * (size + 1.5);
}

// ======================================================================= ცხრილი
const COL_W: Record<Column | 'result', number> = { result: 62, unit: 52, reference: 80, flag: 64, method: 78, previous: 72 };
const COL_H: Record<Column | 'result', string> = { result: 'შედეგი', unit: 'ერთეული', reference: 'ნორმა', flag: '', method: 'ანალიზატორი', previous: 'წინა შედეგი' };
const SHORT: Record<string, string> = { L: 'დაბ.', H: 'მაღ.', LL: 'კრიტ.', HH: 'კრიტ.', A: 'გადახ.' };

function drawTable(doc: Doc, S: BlankSettings, it: BlankItem, L: number, W: number, cur: Cur) {
  const fs = S.font_size;
  // ისრების სტილში ცალკე სვეტი არ გვჭირდება — ისარი შედეგის გვერდითაა
  const cols: (Column | 'result')[] = ['result', ...S.columns.filter((c) => !(c === 'flag' && S.flag_style === 'arrows'))];
  // ტექსტური შედეგი (მაგ. „2–3 მხედველობის არეში“) — ფართო სვეტი
  const hasText = it.results.some((r) => r.value_num === null && (r.value_text ?? '').length > 8);
  const widths = cols.map((c) => (c === 'flag' && S.flag_style === 'letters' ? 26 : c === 'result' && hasText ? 120 : COL_W[c]));
  const nameW = Math.max(W - widths.reduce((a, b) => a + b, 0), 90);
  const xs: number[] = []; let x = L + nameW; for (const w of widths) { xs.push(x); x += w; }
  const header = () => {
    doc.font('B').fontSize(fs - 1.5).fillColor(GRAY).text('კომპონენტი', L, cur.y, { width: nameW - 4, lineBreak: false });
    cols.forEach((c, i) => doc.text(COL_H[c], xs[i], cur.y, { width: widths[i] - 4, lineBreak: false }));
    cur.y += fs + 2; doc.moveTo(L, cur.y).lineTo(L + W, cur.y).lineWidth(0.5).strokeColor(LINE).stroke(); cur.y += 3;
  };
  header();
  const inlineFlag = !S.columns.includes('flag') && S.flag_style !== 'arrows';
  for (const r of it.results) {
    const val = valueText(r); const abn = abnormal(r.flag); const crit = critical(r.flag);
    const vw = widths[0] - 4 - (S.flag_style === 'arrows' || inlineFlag ? 16 : 0);
    doc.font('R').fontSize(fs);
    const hn = doc.heightOfString(r.name, { width: nameW - 6 });
    const hv = doc.font(abn ? 'B' : 'R').heightOfString(val || ' ', { width: vw });
    const hr = S.columns.includes('reference') ? doc.font('R').heightOfString(refText(r) || ' ', { width: COL_W.reference - 4 }) : 0;
    const h = Math.max(hn, hv, hr) + 4;
    cur.ensure(h, () => { doc.font('B').fontSize(fs - 1).fillColor(GRAY).text(`${it.service_name} (გაგრძელება)`, L, cur.y, { width: W }); cur.y = doc.y + 2; header(); });
    const y = cur.y;
    if (S.highlight_abnormal && abn) doc.rect(L - 3, y - 1.5, W + 6, h).fill(crit ? '#FDECEC' : '#FFF6E5');
    doc.font('R').fontSize(fs).fillColor('black').text(r.name, L, y, { width: nameW - 6 });
    cols.forEach((c, i) => {
      const cx = xs[i]; const w = widths[i] - 4;
      if (c === 'result') {
        doc.font(abn ? 'B' : 'R').fontSize(fs).fillColor(crit ? RED : 'black').text(val, cx, y, { width: vw });
        const after = cx + Math.min(doc.font(abn ? 'B' : 'R').fontSize(fs).widthOfString(val), vw) + 3;
        if (S.flag_style === 'arrows') arrows(doc, r.flag, after, y + fs * 0.55, fs * 0.6);
        else if (inlineFlag && abn) doc.font('B').fontSize(fs - 2).fillColor(crit ? RED : 'black').text(S.flag_style === 'letters' ? r.flag! : SHORT[r.flag!] ?? '', after, y + 1, { lineBreak: false });
      } else if (c === 'unit') doc.font('R').fontSize(fs).fillColor('black').text(unitFmt(r.unit), cx, y, { width: w });
      else if (c === 'reference') doc.font('R').fontSize(fs).fillColor(GRAY).text(refText(r), cx, y, { width: w });
      else if (c === 'flag') doc.font('B').fontSize(fs - 0.5).fillColor(crit ? RED : 'black').text(flagLabel(S.flag_style, r.flag), cx, y, { width: w });
      else if (c === 'method') doc.font('R').fontSize(fs - 1).fillColor(GRAY).text(it.method_name ?? '', cx, y, { width: w });
      else if (c === 'previous') doc.font('R').fontSize(fs - 1).fillColor(GRAY).text(r.previous ? `${r.previous.value}  (${d(r.previous.at)})` : '—', cx, y, { width: w });
    });
    cur.y = y + h;
    doc.moveTo(L, cur.y - 1.5).lineTo(L + W, cur.y - 1.5).lineWidth(0.3).strokeColor('#EAECF0').stroke();
  }
  doc.fillColor('black');
  cur.y += 2;
}

// ======================================================================= ორსვეტიანი (კომპაქტური, მაგ. შარდის საერთო)
function drawTwoCol(doc: Doc, S: BlankSettings, it: BlankItem, L: number, W: number, cur: Cur) {
  const fs = S.font_size; const gap = 14; const cw = (W - gap) / 2;
  // ვიწრო გვერდზე (A5) ან გრძელ ტექსტურ შედეგებზე ორი სვეტი არ ეტევა — ჩვეულებრივი ცხრილი
  if (cw < 230 || it.results.some((r) => (r.value_text ?? '').length > 14)) return drawTable(doc, S, it, L, W, cur);
  const showRef = S.columns.includes('reference');
  const nameW = cw * (showRef ? 0.44 : 0.6); const valW = cw * (showRef ? 0.3 : 0.4); const refW = cw - nameW - valW;
  const half = Math.ceil(it.results.length / 2);
  const cell = (r: BlankResult | undefined, x: number, y: number) => {
    if (!r) return;
    const abn = abnormal(r.flag); const crit = critical(r.flag);
    const clip = { height: fs * 1.25, ellipsis: true } as const;
    doc.font('R').fontSize(fs).fillColor('black').text(r.name, x, y, { width: nameW - 4, ...clip });
    const v = `${valueText(r)}${S.columns.includes('unit') && r.unit ? ` ${unitFmt(r.unit)}` : ''}`;
    doc.font(abn ? 'B' : 'R').fontSize(fs).fillColor(crit ? RED : 'black').text(v, x + nameW, y, { width: valW - 16, ...clip });
    const after = x + nameW + Math.min(doc.widthOfString(v), valW - 16) + 2;
    if (S.flag_style === 'arrows') arrows(doc, r.flag, after, y + fs * 0.55, fs * 0.55);
    else if (abn) doc.font('B').fontSize(fs - 2).fillColor(crit ? RED : 'black').text(S.flag_style === 'letters' ? r.flag! : SHORT[r.flag!] ?? '', after, y + 1, { lineBreak: false });
    if (showRef) doc.font('R').fontSize(fs - 1).fillColor(GRAY).text(refText(r), x + nameW + valW, y + 0.5, { width: refW, ...clip });
  };
  const rowH = fs * 1.7;
  for (let i = 0; i < half; i++) {
    cur.ensure(rowH);
    const y = cur.y; const a = it.results[i]; const b = it.results[half + i];
    if (S.highlight_abnormal) {
      if (a && abnormal(a.flag)) doc.rect(L - 2, y - 1.5, cw + 4, rowH).fill(critical(a.flag) ? '#FDECEC' : '#FFF6E5');
      if (b && abnormal(b.flag)) doc.rect(L + cw + gap - 2, y - 1.5, cw + 4, rowH).fill(critical(b.flag) ? '#FDECEC' : '#FFF6E5');
    }
    cell(a, L, y); cell(b, L + cw + gap, y);
    cur.y = y + rowH;
    doc.moveTo(L, cur.y - 2).lineTo(L + cw, cur.y - 2).moveTo(L + cw + gap, cur.y - 2).lineTo(L + W, cur.y - 2).lineWidth(0.3).strokeColor('#EAECF0').stroke();
  }
  doc.fillColor('black');
  cur.y += 2;
}

// ======================================================================= ტექსტური (აღწერითი კვლევები, მიკროსკოპია)
function drawText(doc: Doc, S: BlankSettings, it: BlankItem, L: number, W: number, cur: Cur) {
  const fs = S.font_size;
  for (const r of it.results) {
    const val = valueText(r) || '—'; const abn = abnormal(r.flag); const crit = critical(r.flag);
    const ref = S.columns.includes('reference') ? refText(r) : '';
    const unit = S.columns.includes('unit') && r.unit ? ` ${unitFmt(r.unit)}` : '';
    doc.font('R').fontSize(fs);
    const h = fs * 1.4 + doc.heightOfString(`${val}${unit}`, { width: W - 10 }) + (ref ? fs * 1.3 : 0) + 4;
    cur.ensure(Math.min(h, fs * 8));
    doc.font('B').fontSize(fs - 0.5).fillColor(GRAY).text(r.name, L, cur.y, { width: W });
    doc.font(abn ? 'B' : 'R').fontSize(fs).fillColor(crit ? RED : 'black').text(`${val}${unit}`, L + 10, doc.y + 1, { width: W - 10 });
    if (abn && S.flag_style !== 'arrows') doc.font('B').fontSize(fs - 1).text(flagLabel(S.flag_style === 'words' ? 'words' : 'letters', r.flag), L + 10, doc.y);
    else if (abn) arrows(doc, r.flag, L, doc.y - fs * 0.6, fs * 0.55);
    if (ref) doc.font('R').fontSize(fs - 1.5).fillColor(GRAY).text(`ნორმა: ${ref}`, L + 10, doc.y, { width: W - 10 });
    cur.y = doc.y + 4;
  }
  doc.fillColor('black');
}
