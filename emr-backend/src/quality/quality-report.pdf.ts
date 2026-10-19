import PDFDocument from 'pdfkit';
import { join } from 'node:path';
import { EVENT_KA, HARM_KA, LEVEL_KA, STATUS_KA, CAPA_STATUS_KA, type Harm } from './quality-common';

const FONT_DIR = join(__dirname, '..', '..', 'assets', 'fonts');
const TZ = 'Asia/Tbilisi';
const dt = (v: unknown) => (v ? new Intl.DateTimeFormat('ka-GE', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(String(v))) : '—');
const dd = (v: unknown) => (v ? new Intl.DateTimeFormat('ka-GE', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(String(v))) : '—');
/** შრიფტში არ არის „→“ — ტექსტში ჩანაცვლება */
const fx = (v: string | null | undefined) => (v ?? '').replace(/→/g, '->');
const RISK_KA: Record<string, string> = { low: 'დაბალი', medium: 'საშუალო', high: 'მაღალი', extreme: 'ექსტრემალური' };
const METHOD_KA: Record<string, string> = { in_person: 'პირისპირ', phone: 'ტელეფონით', letter: 'წერილით', other: 'სხვა' };
const KIND_KA: Record<string, string> = { corrective: 'მაკორექტირებელი', preventive: 'პრევენციული' };

/* eslint-disable @typescript-eslint/no-explicit-any */
/** ინციდენტის ანალიზის ანგარიში (მიმოხილვა / RCA) — კომისიისთვის / აუდიტისთვის; mask — პაციენტის სახელი ინიციალებით, პირადი № დამალული */
export async function renderRcaReport(d: any, o: { mask: boolean; clinic: string }): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 40, bottom: 44, left: 44, right: 44 }, bufferPages: true, info: { Title: `${d.inc_no} — ანალიზი`, Author: o.clinic } });
  doc.registerFont('R', join(FONT_DIR, 'EmrSans-Regular.ttf')); doc.registerFont('B', join(FONT_DIR, 'EmrSans-Bold.ttf'));
  const chunks: Buffer[] = []; doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res) => doc.on('end', () => res(Buffer.concat(chunks))));
  const L = doc.page.margins.left; const W = doc.page.width - L - doc.page.margins.right;
  const ensure = (h: number) => { if (doc.y + h > doc.page.height - doc.page.margins.bottom) doc.addPage(); };
  const h2 = (t: string) => { ensure(40); doc.moveDown(0.6); doc.font('B').fontSize(11).fillColor('black').text(t, L, doc.y, { width: W }); doc.moveTo(L, doc.y + 1).lineTo(L + W, doc.y + 1).lineWidth(0.5).strokeColor('#999').stroke(); doc.moveDown(0.35); };
  const kv = (k: string, v: string | null | undefined) => {
    ensure(16); const y = doc.y;
    doc.font('B').fontSize(8.5).fillColor('#555').text(k, L, y, { width: 150 }); const y1 = doc.y;
    doc.font('R').fontSize(9).fillColor('black').text(fx(v) || '—', L + 155, y, { width: W - 155 }); const y2 = doc.y;
    doc.y = Math.max(y1, y2); doc.moveDown(0.15);
  };
  const para = (t: string | null | undefined) => { ensure(18); doc.font('R').fontSize(9).fillColor('black').text(fx(t).trim() || '—', L, doc.y, { width: W }); doc.moveDown(0.3); };
  const label = (t: string) => { ensure(18); doc.font('B').fontSize(8.5).fillColor('#555').text(t, L, doc.y, { width: W }); };

  const patient = d.patient_id
    ? (o.mask ? `${String(d.patient_first_name ?? '').slice(0, 1)}. ${String(d.patient_last_name ?? '').slice(0, 1)}. (დაფარულია)` : `${d.patient_first_name} ${d.patient_last_name} · ${d.patient_personal_number ?? ''}`)
    : d.patient_text ? (o.mask ? '(დაფარულია)' : d.patient_text) : '—';
  const a = d.analysis;

  doc.font('B').fontSize(9).fillColor('#555').text(o.clinic, L, doc.y, { width: W });
  doc.font('B').fontSize(15).fillColor('black').text(`ინციდენტის ანალიზი — ${d.inc_no}`, L, doc.y + 2, { width: W });
  doc.font('R').fontSize(9).fillColor('#444').text(`${a ? LEVEL_KA[a.level] : '—'} · სტატუსი: ${STATUS_KA[d.status] ?? d.status} · შედგენილია: ${dt(new Date())}`, L, doc.y + 2, { width: W });
  doc.font('R').fontSize(7.5).fillColor('#a00').text('კონფიდენციალური — ხარისხის გაუმჯობესების დოკუმენტი; არ არის სამედიცინო ჩანაწერის ნაწილი და დისციპლინური საფუძველი', L, doc.y + 4, { width: W });

  h2('1. ინციდენტი');
  kv('ტიპი', EVENT_KA[d.event_type]);
  kv('მოხდა', dt(d.occurred_at));
  kv('განყოფილება / ადგილი', `${d.department_name}${d.location_text ? ` · ${d.location_text}` : ''}`);
  kv('კატეგორია', d.category_parent_name ? `${d.category_parent_name}: ${d.category_name}` : d.category_name);
  kv('ზიანი (საბოლოო)', d.harm ? HARM_KA[d.harm as Harm] : HARM_KA[d.harm_reported as Harm]);
  kv('რისკი', d.risk_level ? `${d.likelihood} × ${d.consequence} = ${d.risk_score} · ${RISK_KA[d.risk_level]}` : '—');
  if (d.is_sentinel) kv('სენტინელური', 'კი');
  kv('პაციენტი', patient);
  kv('მიბმული მოვლენა', d.source_label);
  kv('გამომძიებელი', d.investigator_name);
  label('აღწერა'); para(d.description);
  if (d.immediate_actions) { label('დაუყოვნებლივ მიღებული ზომები'); para(d.immediate_actions); }

  h2(`2. ანალიზი — ${a ? LEVEL_KA[a.level] : '—'}`);
  if (!a) para('ანალიზი შევსებული არ არის');
  else if (a.level === 'review') {
    label('რა მოხდა'); para(a.what_happened);
    label('ძირეული მიზეზი'); para(a.root_cause);
    label('მიღებული ზომა'); para(a.action_taken);
  } else {
    label('მოვლენების ქრონოლოგია');
    for (const t of a.timeline ?? []) {
      ensure(14); const y = doc.y; doc.font('B').fontSize(8.5).fillColor('black').text(t.at ? dt(t.at) : '—', L, y, { width: 110 }); const y1 = doc.y;
      doc.font('R').fontSize(9).text(fx(t.text), L + 115, y, { width: W - 115 }); doc.y = Math.max(y1, doc.y); doc.moveDown(0.15);
    }
    if (!(a.timeline ?? []).length) para('—');
    doc.moveDown(0.3); label('ხელშემწყობი ფაქტორები');
    for (const f of a.factors ?? []) { ensure(14); doc.font('R').fontSize(9).fillColor('black').text(fx(`• ${f.group_name ? `${f.group_name} — ` : ''}${f.name}${f.comment ? `: ${f.comment}` : ''}`), L, doc.y, { width: W }); }
    doc.moveDown(0.3); label('„5 რატომ“');
    (a.whys as string[] ?? []).forEach((w, k) => { ensure(14); doc.font('R').fontSize(9).fillColor('black').text(fx(`${k + 1}. რატომ? — ${w}`), L, doc.y, { width: W }); });
    doc.moveDown(0.3); label('ძირეული მიზეზები'); para(a.root_causes);
    label('დასკვნა'); para(a.conclusion);
    if ((a.team ?? []).length) { label('RCA გუნდი'); para((a.team as any[]).map((m) => `${m.name}${m.role_text ? ` (${m.role_text})` : ''}`).join('; ')); }
  }
  if (a?.approved_at) kv('დამტკიცდა', `${dt(a.approved_at)} · ${a.approved_by_name ?? ''}`);

  h2('3. მაკორექტირებელი / პრევენციული ქმედებები');
  if (!(d.capas ?? []).length) para('ქმედება არ არის');
  for (const c of d.capas ?? []) {
    ensure(30);
    doc.font('B').fontSize(9).fillColor('black').text(fx(`${c.capa_no} · ${c.title}`), L, doc.y, { width: W });
    doc.font('R').fontSize(8.5).fillColor('#333').text(`${KIND_KA[c.kind]} · პასუხისმგებელი: ${c.owner_name} · ვადა: ${dd(c.due_date)} · ${CAPA_STATUS_KA[c.status]}${c.done_at ? ` (${dd(c.done_at)})` : ''}${c.effectiveness_result ? ` · ეფექტიანობა: ${c.effectiveness_result === 'effective' ? 'ეფექტიანი' : 'არაეფექტიანი'}` : ''}`, L, doc.y, { width: W });
    doc.moveDown(0.25);
  }

  h2('4. ინფორმირება და დახურვა');
  kv('პაციენტის / ოჯახის ინფორმირება', d.disclosure_status === 'done' ? `${dt(d.disclosed_at)} · ${METHOD_KA[d.disclosure_method] ?? ''}${d.disclosure_by_name ? ` · ${d.disclosure_by_name}` : ''}${d.disclosure_to && !o.mask ? ` · ${d.disclosure_to}` : ''}`
    : d.disclosure_status === 'not_disclosed' ? `არ ეცნობა: ${d.disclosure_note ?? ''}` : '—');
  kv('დაიხურა', d.closed_at ? `${dt(d.closed_at)} · ${d.closed_by_name ?? ''}` : '—');
  if (d.closure_summary) { label('დასკვნა (დახურვა)'); para(d.closure_summary); }

  const n = doc.bufferedPageRange().count;
  for (let k = 0; k < n; k++) {
    doc.switchToPage(k); const b = doc.page.margins.bottom; doc.page.margins.bottom = 0;
    doc.font('R').fontSize(7).fillColor('#777').text(`${d.inc_no} · კონფიდენციალური · გვ. ${k + 1} / ${n}`, L, doc.page.height - 28, { width: W, align: 'right', lineBreak: false });
    doc.page.margins.bottom = b;
  }
  doc.end();
  return done;
}
