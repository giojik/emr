import { d as dGe, dt, newDoc } from '../diagnostics/diagnostics.pdf';
import { RESULT_KA, normText, type PmResult } from './bme-pm-common';

/**
 * გეგმიური სამუშაოს აქტი (0074): აპარატი, სამუშაო, შემსრულებელი, ჩეკლისტი + გაზომვები (ნორმა / შედეგი), საერთო შედეგი, სერტიფიკატი, ხელმოწერები.
 *  ღია სამუშაოზე — ცარიელი ფორმა (ადგილზე შესავსებად); დასრულებულზე — შევსებული (დასრულებისას ასლი ინახება დოკუმენტებში).
 */
interface ActW {
  work_no: string; status: string; inv_no: string; device_name: string; manufacturer: string | null; model: string | null; serial_no: string | null; department_name: string | null; room: string | null;
  kind_name: string; due_date: string | null; scheduled_date: string | null; performed_on: string | null; performer_kind: string; assignee_name: string | null; supplier_name: string | null;
  external_person: string | null; result: string | null; result_note: string | null; cert_no: string | null; cert_valid_until: string | null; next_due: string | null;
  completed_by_name: string | null; completed_at: Date | string | null; suggested_status: string | null;
}
interface ActItem { sort_order: number; text: string; item_type: string; unit: string | null; nominal: string | null; tolerance: string | null; limit_low: string | null; limit_high: string | null;
  critical: boolean; value_num: string | null; outcome: string | null; note: string | null }
/** შრიფტს აკლია ზოგი სიმბოლო — PDF-ში ჩანაცვლება */
const SAFE: [RegExp, string][] = [[/≤/g, '<='], [/≥/g, '>='], [/Ω/g, 'Ohm'], [/☐/g, '[ ]'], [/⁻¹/g, '-1'], [/₂/g, '2'], [/✓/g, 'v'], [/→/g, '->']];
const t = (x: string) => SAFE.reduce((a, [r, v]) => a.replace(r, v), x);
const OUT: Record<string, string> = { pass: 'შეესაბამება', fail: 'არ შეესაბამება', na: 'არ ეხება' };
const STATUS_SUG: Record<string, string> = { restricted: 'შეზღუდულად მუშა', down: 'გაუმართავი / შეკეთებაში' };

export async function renderAct(p: { w: ActW; items: ActItem[]; clinic: { name: string; address: string; phone: string | null } | undefined; standard: string | null; deptSign: boolean }): Promise<Buffer> {
  const { w, items } = p;
  const { doc, done } = newDoc('A4', 40);
  doc.addPage();
  const L = 40; const W = doc.page.width - 80; const bottom = () => doc.page.height - 60;
  const ensure = (h: number) => { if (doc.y + h > bottom()) doc.addPage(); };
  const blank = w.status !== 'done';

  doc.font('B').fontSize(10).text(p.clinic?.name ?? '', L, 36, { width: W });
  doc.font('R').fontSize(8).fillColor('#555').text([p.clinic?.address, p.clinic?.phone].filter(Boolean).join(' · '), { width: W }).fillColor('black');
  doc.moveDown(0.6).font('B').fontSize(13).text(`აქტი № ${w.work_no}`, { width: W, align: 'center' });
  doc.font('R').fontSize(10).text(w.kind_name + (p.standard ? ` (${p.standard})` : ''), { width: W, align: 'center' });
  if (blank) doc.fontSize(8).fillColor('#a00').text('შესავსები ფორმა — სამუშაო დასრულებული არ არის', { width: W, align: 'center' }).fillColor('black');
  doc.moveDown(0.6);

  const kv = (rows: [string, string][]) => {
    const colW = W / 2;
    for (let i = 0; i < rows.length; i += 2) {
      ensure(36); const y = doc.y;
      // მნიშვნელობა — მაქს. 2 სტრიქონი
      const hs = rows.slice(i, i + 2).map(([, v]) => Math.min(doc.font('B').fontSize(9).heightOfString(t(v || '—'), { width: colW - 8 }), 28));
      for (let j = 0; j < 2 && i + j < rows.length; j++) {
        const [k, v] = rows[i + j];
        doc.font('R').fontSize(8).fillColor('#555').text(k, L + j * colW, y, { width: colW - 8, lineBreak: false });
        doc.font('B').fontSize(9).fillColor('black').text(t(v || '—'), L + j * colW, y + 9, { width: colW - 8, height: 28, ellipsis: true });
      }
      doc.y = y + 13 + Math.max(...hs);
    }
  };
  kv([
    ['აპარატი', `${w.inv_no} — ${w.device_name}`], ['მწარმოებელი / მოდელი', [w.manufacturer, w.model].filter(Boolean).join(' ')],
    ['სერიული №', w.serial_no ?? ''], ['ადგილი', [w.department_name, w.room && `ოთახი ${w.room}`].filter(Boolean).join(' · ')],
    ['ვადა (გეგმით)', w.due_date ? dGe(w.due_date) : ''], ['შესრულების დღე', w.performed_on ? dGe(w.performed_on) : blank ? '____ / ____ / ________' : ''],
    ['შემსრულებელი', w.performer_kind === 'external' ? [w.supplier_name, w.external_person].filter(Boolean).join(' · ') + ' (გარე)' : (w.assignee_name ?? w.completed_by_name ?? '') + ' (შიდა)'],
    ['სერტიფიკატი', w.cert_no ? `№ ${w.cert_no}${w.cert_valid_until ? ` · ${dGe(w.cert_valid_until)}-მდე` : ''}` : ''],
  ]);

  // ჩეკლისტი
  doc.moveDown(0.4);
  const cols = [L, L + 22, L + 250, L + 340, L + 420];   // # | პუნქტი | ნორმა | მნიშვნელობა | შედეგი
  const head = () => {
    ensure(20); const y = doc.y;
    doc.rect(L, y - 2, W, 16).fill('#eef2f6').fillColor('black');
    doc.font('B').fontSize(8);
    ['#', 'შემოწმება / გაზომვა', 'ნორმა', 'მნიშვნელობა', 'შედეგი'].forEach((h, i) => doc.text(h, cols[i] + 2, y + 2, { width: (cols[i + 1] ?? L + W) - cols[i] - 4, lineBreak: false }));
    doc.y = y + 18;
  };
  if (!items.length) doc.font('R').fontSize(9).text('ჩეკლისტი არ არის (სახეზე / ტიპზე შაბლონი არ არის განსაზღვრული).', L, doc.y, { width: W });
  else {
    head();
    items.forEach((i, n) => {
      const textH = doc.font('R').fontSize(8.5).heightOfString(t(i.text) + (i.critical ? '' : ' (არაკრიტ.)'), { width: cols[2] - cols[1] - 4 });
      const noteH = i.note ? doc.fontSize(7.5).heightOfString(t(i.note), { width: cols[2] - cols[1] - 4 }) + 2 : 0;
      const h = Math.max(14, textH + noteH + 4);
      if (doc.y + h > bottom()) { doc.addPage(); head(); }
      const y = doc.y;
      doc.font('R').fontSize(8.5).text(String(n + 1), cols[0] + 2, y, { width: 18 });
      doc.text(t(i.text) + (i.critical ? '' : ' (არაკრიტ.)'), cols[1] + 2, y, { width: cols[2] - cols[1] - 4 });
      if (i.note) doc.fontSize(7.5).fillColor('#555').text(t(i.note), cols[1] + 2, y + textH + 1, { width: cols[2] - cols[1] - 4 }).fillColor('black');
      doc.fontSize(8.5).text(i.item_type === 'measure' ? t(normText(i)) : '—', cols[2] + 2, y, { width: cols[3] - cols[2] - 4 });
      const val = i.item_type === 'measure' ? (i.value_num !== null ? t(`${Number(i.value_num)}${i.unit ? ` ${i.unit}` : ''}`) : blank ? '________' : '') : '';
      doc.text(val, cols[3] + 2, y, { width: cols[4] - cols[3] - 4 });
      const out = i.outcome ? OUT[i.outcome] : blank ? '[ ] კი   [ ] არა' : '';
      doc.font(i.outcome === 'fail' ? 'B' : 'R').fillColor(i.outcome === 'fail' ? '#b00' : 'black').text(out, cols[4] + 2, y, { width: L + W - cols[4] - 4 }).fillColor('black');
      doc.moveTo(L, y + h - 1).lineTo(L + W, y + h - 1).lineWidth(0.3).strokeColor('#ccc').stroke().strokeColor('black');
      doc.y = y + h;
    });
  }

  // შედეგი
  doc.moveDown(0.8); ensure(70);
  if (w.result) {
    const res = w.result as PmResult;
    doc.font('B').fontSize(11).fillColor(res === 'fail' ? '#b00' : res === 'conditional' ? '#a60' : '#060').text(`დასკვნა: ${RESULT_KA[res]}`, L, doc.y, { width: W }).fillColor('black');
    if (w.result_note) doc.font('R').fontSize(9).text(t(w.result_note), { width: W });
    if (w.suggested_status) doc.font('R').fontSize(9).text(`შეთავაზებული სტატუსი: ${STATUS_SUG[w.suggested_status] ?? w.suggested_status} (გადაწყვეტს სამედიცინო ინჟინერი)`, { width: W });
    if (w.next_due) doc.font('R').fontSize(9).text(`შემდეგი ვადა: ${dGe(w.next_due)}`, { width: W });
  } else {
    doc.font('B').fontSize(10).text('დასკვნა:   [ ] გავლილი     [ ] პირობითად გავლილი     [ ] ვერ გაიარა', L, doc.y, { width: W });
    doc.font('R').fontSize(9).text('შენიშვნა: ' + '_'.repeat(90), { width: W });
  }

  // ხელმოწერები
  doc.moveDown(1.5); ensure(80);
  const y = doc.y; const sw = p.deptSign ? W / 2 - 10 : W;
  const sign = (x: number, title: string, name: string, sub: string) => {
    doc.font('R').fontSize(8).fillColor('#555').text(title, x, y, { width: sw }).fillColor('black');
    doc.font('B').fontSize(9).text(name || ' ', x, y + 11, { width: sw });
    doc.moveTo(x, y + 44).lineTo(x + sw - 20, y + 44).lineWidth(0.5).stroke();
    doc.font('R').fontSize(7.5).fillColor('#555').text(sub, x, y + 47, { width: sw }).fillColor('black');
  };
  const perfName = w.performer_kind === 'external' ? [w.external_person, w.supplier_name].filter(Boolean).join(', ') : (w.assignee_name ?? w.completed_by_name ?? '');
  sign(L, 'შემსრულებელი', perfName, 'ხელმოწერა / თარიღი');
  if (p.deptSign) sign(L + W / 2 + 10, 'განყოფილების წარმომადგენელი (ჩაბარება)', w.department_name ?? '', 'სახელი, გვარი, ხელმოწერა');
  doc.y = y + 64;
  if (w.completed_at) doc.font('R').fontSize(7.5).fillColor('#555').text(`ელექტრონულად დაასრულა: ${w.completed_by_name ?? ''} · ${dt(w.completed_at)}`, L, doc.y, { width: W }).fillColor('black');

  // გვერდის ნომრები
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0;   // ქვედა ველში წერა ახალ გვერდს არ ქმნის
    doc.font('R').fontSize(7).fillColor('#777').text(`${w.work_no} · გვ. ${i + 1} / ${range.count}`, L, doc.page.height - 30, { width: W, align: 'right', lineBreak: false }).fillColor('black');
  }
  doc.end();
  return done;
}
