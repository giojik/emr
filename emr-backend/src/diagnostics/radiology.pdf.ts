import { d, dt, newDoc } from './diagnostics.pdf';

interface Clinic { name: string; address: string; phone: string | null }
interface Patient { name: string; birth_date: string; gender: string; id_number: string | null }
const sex = (g: string) => (g === 'male' ? 'მამრ.' : g === 'female' ? 'მდედრ.' : '—');

export interface ImagingReportData {
  clinic: Clinic; patient: Patient; section: 'radiology' | 'endoscopy';
  study: { name: string; accession: string | null; performed_at: string | null; device: string | null; contrast: string | null; dose: string | null; referrer: string | null; external_referral: string | null; clinical_note: string | null };
  report: { version: number; technique: string | null; findings: string | null; impression: string; recommendation: string | null; is_critical: boolean; critical_notified_to: string | null;
    amend_reason: string | null; signed_by_name: string; signed_at: string; superseded: boolean };
  /** ენდოსკოპია: პროცედურის მონაცემები (უკვე ქართულად დაფორმატებული) */
  endo?: { rows: [string, string | null][]; interventions: string[]; complications: string | null };
  specimens?: { jar_no: number; site: string; pieces: number; description: string | null }[];
  pathology?: { request_no: string; status: string; external_lab: string | null; result_text: string | null } | null;
  images?: { data: Buffer; caption: string | null }[];
}

/** რადიოლოგიური დასკვნა / ენდოსკოპიური ოქმი — A4 */
export async function renderImagingReport(p: ImagingReportData): Promise<Buffer> {
  const { doc, done } = newDoc('A4', 45);
  doc.addPage();
  const L = 45; const W = doc.page.width - 90;
  doc.font('B').fontSize(10).text(p.clinic.name, L, 38, { width: W });
  doc.font('R').fontSize(8).fillColor('#555').text([p.clinic.address, p.clinic.phone].filter(Boolean).join(' · ')).fillColor('black');
  doc.moveDown(0.8).font('B').fontSize(14).text(p.section === 'radiology' ? 'რადიოლოგიური კვლევის დასკვნა' : 'ენდოსკოპიური კვლევის ოქმი', { width: W, align: 'center' });
  if (p.report.version > 1) doc.font('B').fontSize(9).fillColor('#B54708').text(`შესწორებული დასკვნა — ვერსია ${p.report.version}`, { width: W, align: 'center' }).fillColor('black');
  if (p.report.superseded) doc.font('B').fontSize(9).fillColor('#B42318').text('ძველი ვერსია — ჩანაცვლებულია ახლით', { width: W, align: 'center' }).fillColor('black');
  doc.moveDown(0.6);

  const row = (label: string, value: string | null | undefined) => {
    if (!value) return;
    const y = doc.y;
    doc.font('R').fontSize(8.5).fillColor('#555').text(label, L, y, { width: 110 });
    doc.font('R').fontSize(9.5).fillColor('black').text(value, L + 115, y, { width: W - 115 });
    doc.y = Math.max(doc.y, y + 12); doc.moveDown(0.15);
  };
  row('პაციენტი', `${p.patient.name}   ·   დაბ. ${d(p.patient.birth_date)}   ·   ${sex(p.patient.gender)}   ·   პ/ნ ${p.patient.id_number ?? '—'}`);
  row('კვლევა', p.study.name);
  row('Accession №', p.study.accession);
  row('შესრულდა', [p.study.performed_at && dt(p.study.performed_at), p.study.device].filter(Boolean).join(' · ') || null);
  row('კონტრასტი', p.study.contrast);
  row('დოზა', p.study.dose);
  row('მიმართა', [p.study.referrer, p.study.external_referral].filter(Boolean).join(' · ') || null);
  row('კლინიკური მონაცემი', p.study.clinical_note);
  for (const [l, v] of p.endo?.rows ?? []) row(l, v);
  doc.moveTo(L, doc.y + 4).lineTo(L + W, doc.y + 4).strokeColor('#ccc').lineWidth(0.5).stroke();
  doc.moveDown(0.8);

  const block = (title: string, text: string | null, bold = false) => {
    if (!text) return;
    if (doc.y > doc.page.height - 120) doc.addPage();
    doc.font('B').fontSize(10).fillColor('black').text(title, L, doc.y, { width: W }).moveDown(0.2);
    doc.font(bold ? 'B' : 'R').fontSize(10).text(text, L, doc.y, { width: W, lineGap: 1.5 }).moveDown(0.7);
  };
  block('ტექნიკა', p.report.technique);
  block(p.section === 'radiology' ? 'აღწერა' : 'მიმდინარეობა / მიგნებები', p.report.findings);
  if (p.endo?.interventions.length) block('მანიპულაციები', p.endo.interventions.map((x) => `• ${x}`).join('\n'));
  if (p.specimens?.length) {
    block(`ბიოფსია — ${p.specimens.length} ქილა${p.pathology ? ` (მიმართვა ${p.pathology.request_no}${p.pathology.external_lab ? `, ${p.pathology.external_lab}` : ''})` : ''}`,
      p.specimens.map((x) => `№${x.jar_no}  ${x.site} — ${x.pieces} ფრაგმ.${x.description ? `; ${x.description}` : ''}`).join('\n'));
  }
  if (p.endo) block('გართულებები', p.endo.complications ?? 'არ აღინიშნა');
  block('დასკვნა', p.report.impression, true);
  block('რეკომენდაცია', p.report.recommendation);
  if (p.report.is_critical) {
    doc.font('B').fontSize(9).fillColor('#B42318').text(`კრიტიკული მიგნება — ეცნობა: ${p.report.critical_notified_to ?? '—'}`, L, doc.y, { width: W }).fillColor('black').moveDown(0.5);
  }
  if (p.pathology?.status === 'resulted' && p.pathology.result_text) block(`ჰისტოლოგიური პასუხი (${p.pathology.request_no})`, p.pathology.result_text);
  else if (p.specimens?.length) doc.font('R').fontSize(8.5).fillColor('#555').text('ჰისტოლოგიური პასუხი მოგვიანებით დაემატება.', L, doc.y, { width: W }).fillColor('black').moveDown(0.5);

  // სურათები: 3 სვეტი
  if (p.images?.length) {
    const cols = 3; const gap = 8; const cw = (W - gap * (cols - 1)) / cols; const ch = cw * 0.8;
    if (doc.y > doc.page.height - (ch + 60)) doc.addPage();
    let y0 = doc.y + 4;
    p.images.forEach((im, i) => {
      const c = i % cols;
      if (i > 0 && c === 0) { y0 += ch + 22; if (y0 > doc.page.height - (ch + 60)) { doc.addPage(); y0 = 50; } }
      const x = L + c * (cw + gap);
      try { doc.image(im.data, x, y0, { fit: [cw, ch], align: 'center', valign: 'center' }); } catch { /* დაზიანებული ფაილი — გამოტოვება */ }
      doc.rect(x, y0, cw, ch).strokeColor('#ddd').lineWidth(0.5).stroke();
      doc.font('R').fontSize(7.5).fillColor('#555').text(`${i + 1}. ${im.caption ?? ''}`, x, y0 + ch + 3, { width: cw, lineBreak: false }).fillColor('black');
    });
    doc.y = y0 + ch + 24; doc.x = L;
  }
  if (p.report.amend_reason) doc.font('R').fontSize(8.5).fillColor('#555').text(`შესწორების მიზეზი: ${p.report.amend_reason}`, L, doc.y, { width: W }).fillColor('black').moveDown(0.5);

  if (doc.y > doc.page.height - 110) doc.addPage();
  doc.moveDown(1.2);
  const sy = doc.y;
  doc.font('R').fontSize(9).text(p.section === 'radiology' ? 'რადიოლოგი:' : 'ექიმი:', L, sy);
  doc.font('B').text(p.report.signed_by_name, L + 70, sy);
  doc.font('R').fontSize(8.5).fillColor('#555').text(`ელექტრონულად ხელმოწერილია ${dt(p.report.signed_at)}`, L + 70, sy + 13).fillColor('black');
  doc.moveTo(L + W - 160, sy + 22).lineTo(L + W, sy + 22).strokeColor('#999').stroke();
  doc.font('R').fontSize(7.5).fillColor('#777').text('ხელმოწერა', L + W - 160, sy + 25, { width: 160, align: 'center' }).fillColor('black');

  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i); const b = doc.page.margins.bottom; doc.page.margins.bottom = 0;
    doc.font('R').fontSize(7).fillColor('#777').text([p.patient.name, p.study.accession, `გვერდი ${i + 1}/${range.count}`].filter(Boolean).join(' · '), L, doc.page.height - 30, { width: W, align: 'center' });
    doc.page.margins.bottom = b;
  }
  doc.end();
  return done;
}

export interface SlipData { clinic: Clinic; patient: Patient; items: { name: string; device: string; room: string | null; start: string; accession: string | null; prep: string | null }[] }

/** ჩაწერის ფურცელი პაციენტისთვის (A5): დრო, აპარატი/კაბინეტი, მომზადება */
export async function renderAppointmentSlip(p: SlipData): Promise<Buffer> {
  const { doc, done } = newDoc([419.53, 595.28], 36);
  doc.addPage();
  const L = 36; const W = doc.page.width - 72;
  doc.font('B').fontSize(10).text(p.clinic.name, L, 32, { width: W });
  doc.font('R').fontSize(8).fillColor('#555').text([p.clinic.address, p.clinic.phone].filter(Boolean).join(' · '), { width: W }).fillColor('black');
  doc.moveDown(0.8).font('B').fontSize(13).text('ჩაწერა კვლევაზე', { width: W, align: 'center' }).moveDown(0.5);
  doc.font('R').fontSize(9.5).text(`${p.patient.name} · დაბ. ${d(p.patient.birth_date)}`, { width: W }).moveDown(0.6);
  for (const it of p.items) {
    doc.font('B').fontSize(11).text(dt(it.start), L, doc.y, { width: W });
    doc.font('B').fontSize(10).text(it.name, { width: W });
    doc.font('R').fontSize(9).fillColor('#555').text([it.device, it.room && `კაბინეტი ${it.room}`, it.accession].filter(Boolean).join(' · '), { width: W }).fillColor('black');
    if (it.prep) doc.moveDown(0.2).font('R').fontSize(9.5).text(`მომზადება: ${it.prep}`, { width: W });
    doc.moveDown(0.8);
  }
  doc.font('R').fontSize(8).fillColor('#555').text('გთხოვთ, მობრძანდეთ 15 წუთით ადრე; თან იქონიეთ პირადობის დამადასტურებელი დოკუმენტი და წინა კვლევების შედეგები (ასეთის არსებობისას).', L, doc.y, { width: W });
  doc.end();
  return done;
}

export interface JarLabel { request_no: string; jar_no: number; site: string; patient: string; birth_date: string; date: string }
/** ქილის ეტიკეტი 50×25 მმ: მიმართვის № + ქილის № (Code128), პაციენტი, ლოკალიზაცია */
export async function renderJarLabels(labels: JarLabel[]): Promise<Buffer> {
  const bwipjs = (await import('bwip-js')).default;
  const mm = (v: number) => (v * 72) / 25.4;
  const { doc, done } = newDoc([mm(50), mm(25)], mm(1.5));
  for (const l of labels) {
    doc.addPage();
    const code = `${l.request_no}-${l.jar_no}`;
    const png = await bwipjs.toBuffer({ bcid: 'code128', text: code, scale: 3, height: 7, includetext: false });
    const Wd = mm(47);
    doc.font('B').fontSize(7).text(l.patient.slice(0, 34), mm(1.5), mm(1.2), { width: Wd, lineBreak: false });
    doc.font('R').fontSize(5.5).text(`${d(l.birth_date)} · ${l.date}`, mm(1.5), mm(4.2), { width: Wd, lineBreak: false });
    doc.image(png, mm(1.5), mm(6.6), { width: Wd, height: mm(8.5) });
    doc.font('B').fontSize(7).text(`${code}   ქილა №${l.jar_no}`, mm(1.5), mm(15.6), { width: Wd, align: 'center', lineBreak: false });
    doc.font('R').fontSize(6).text(l.site.slice(0, 48), mm(1.5), mm(19.2), { width: Wd, lineBreak: false });
  }
  doc.end();
  return done;
}

export interface RequisitionData {
  clinic: Clinic; patient: Patient; request_no: string; external_lab: string | null; clinical_info: string | null; procedure: string; performed_at: string | null;
  endoscopist: string | null; impression: string | null; specimens: { jar_no: number; site: string; pieces: number; description: string | null; fixative: string }[];
}
/** მიმართვა ჰისტოლოგიურ კვლევაზე (გარე ლაბორატორია) — A4 */
export async function renderRequisition(p: RequisitionData): Promise<Buffer> {
  const { doc, done } = newDoc('A4', 45);
  doc.addPage();
  const L = 45; const W = doc.page.width - 90;
  doc.font('B').fontSize(10).text(p.clinic.name, L, 38, { width: W });
  doc.font('R').fontSize(8).fillColor('#555').text([p.clinic.address, p.clinic.phone].filter(Boolean).join(' · ')).fillColor('black');
  doc.moveDown(0.8).font('B').fontSize(14).text('მიმართვა ჰისტოპათოლოგიურ კვლევაზე', { width: W, align: 'center' });
  doc.font('B').fontSize(10).text(`№ ${p.request_no}`, { width: W, align: 'center' }).moveDown(0.6);
  const row = (label: string, value: string | null | undefined) => {
    if (!value) return; const y = doc.y;
    doc.font('R').fontSize(8.5).fillColor('#555').text(label, L, y, { width: 120 });
    doc.font('R').fontSize(9.5).fillColor('black').text(value, L + 125, y, { width: W - 125 });
    doc.y = Math.max(doc.y, y + 12); doc.moveDown(0.15);
  };
  row('ლაბორატორია', p.external_lab);
  row('პაციენტი', `${p.patient.name} · დაბ. ${d(p.patient.birth_date)} · ${sex(p.patient.gender)} · პ/ნ ${p.patient.id_number ?? '—'}`);
  row('პროცედურა', [p.procedure, p.performed_at && dt(p.performed_at)].filter(Boolean).join(' · '));
  row('ენდოსკოპისტი', p.endoscopist);
  row('კლინიკური მონაცემი', p.clinical_info);
  row('ენდოსკოპიური დასკვნა', p.impression);
  doc.moveDown(0.6);
  const cols = [L, L + 40, L + 230, L + 290, L + W];
  const hy = doc.y;
  doc.font('B').fontSize(8.5).fillColor('#555');
  ['ქილა', 'ლოკალიზაცია', 'ფრაგმ.', 'აღწერა / ფიქსაცია'].forEach((h, i) => doc.text(h, cols[i], hy, { width: cols[i + 1] - cols[i] - 4 }));
  doc.fillColor('black').moveTo(L, hy + 12).lineTo(L + W, hy + 12).strokeColor('#ccc').lineWidth(0.5).stroke();
  let y = hy + 16;
  for (const s of p.specimens) {
    const h = Math.max(doc.font('R').fontSize(9.5).heightOfString(s.site, { width: cols[2] - cols[1] - 4 }), doc.heightOfString(`${s.description ?? ''} ${s.fixative}`, { width: cols[4] - cols[3] - 4 }));
    doc.font('B').text(String(s.jar_no), cols[0], y, { width: 36 });
    doc.font('R').text(s.site, cols[1], y, { width: cols[2] - cols[1] - 4 });
    doc.text(String(s.pieces), cols[2], y, { width: 50 });
    doc.text([s.description, s.fixative].filter(Boolean).join('; '), cols[3], y, { width: cols[4] - cols[3] - 4 });
    y += h + 8;
  }
  doc.y = y + 20; doc.x = L;
  doc.font('R').fontSize(9).text('გაგზავნა: ______________________   თარიღი/დრო: ______________     მიიღო (ლაბორატორია): ______________________', L, doc.y, { width: W });
  doc.end();
  return done;
}
