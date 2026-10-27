import { BadRequestException, Controller, ForbiddenException, Get, Injectable, Query, Req, Res, StreamableFile } from '@nestjs/common';
import type { Request, Response } from 'express';
import { join } from 'node:path';
import PDFDocument from 'pdfkit';
import { sql } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/roles';
import { writeXlsxBook, type Cell, type SheetSpec } from '../claims-export/xlsx';
import { ReportingService } from './reporting';
import { DATE_RE, daysBetween, RPT_READ, RptCommon } from './reporting-common';
import { ReportingFinService } from './reporting-fin';
import { RptKpiService } from './reporting-kpi';
import { ReportingOpsService } from './reporting-ops';
import { QmReportsService } from '../quality/quality-reports';
import { ipcRules } from '../ipc/ipc-common';
import { bmeRptRules } from '../bme/bme-reports-core';
import { rosterRptRules } from '../roster/roster-reports-core';

/**
 * მენეჯერული ანგარიში (0063): პერიოდი (ჩვეულებრივ — თვე) → xlsx (რამდენიმე ფურცელი) და PDF (1–2 გვერდი: KPI-ები + 13 თვე).
 *  • მხოლოდ აგრეგატები rpt_*-იდან; ხედვის არე — მომხმარებლის (განრიგით გაგზავნისას — მიმღების).
 *  • ექიმის ფურცლები — მხოლოდ xlsx-ში, მოთხოვნით (doctors = 1) და მხოლოდ წვდომის შემთხვევაში (doctor_breakdown / doctor_revenue / ფინანსები).
 *  • PDF-ში ექიმები არასოდეს.
 */
type Q = Record<string, string | undefined>;
const FONT_DIR = join(__dirname, '..', '..', 'assets', 'fonts');
const MONTH_KA = ['იანვარი', 'თებერვალი', 'მარტი', 'აპრილი', 'მაისი', 'ივნისი', 'ივლისი', 'აგვისტო', 'სექტემბერი', 'ოქტომბერი', 'ნოემბერი', 'დეკემბერი'];
const CAT_ORDER: Record<string, string> = { flow: 'პაციენტების ნაკადი', beds: 'საწოლები', or: 'საოპერაციო', dx: 'ინსტრუმენტული კვლევები', lab: 'ლაბორატორია', stock: 'მარაგი', finance: 'შემოსავალი / ხარჯი', quality: 'ხარისხი და ინციდენტები', ipc: 'ინფექციის კონტროლი', bme: 'ბიომედ-აპარატურა', roster: 'პერსონალი / ცვლები' };
const STATUS_KA: Record<string, string> = { green: 'შესრულებულია', yellow: 'გაფრთხილება', red: 'არ სრულდება' };
const UNIT_SFX: Record<string, string> = { count: '', pct: '%', days: ' დღე', hours: ' სთ', min: ' წთ', gel: ' ₾', ratio: '' };
const TREND_KPIS = ['enc_total', 'admissions', 'occupancy_pct', 'alos', 'or_cases', 'lab_orders', 'dx_orders', 'stock_consumption', 'rev_net', 'costs_total', 'result'];
const PDF_TRENDS = ['enc_total', 'admissions', 'rev_net'];

export interface ReportOpts { from: string; to: string; department_id?: string; doctors?: boolean }
export interface ReportFile { name: string; type: string; body: Buffer }

/** პერიოდის სათაური: მთელი თვე → „სექტემბერი 2026“, სხვა — „2026-10-05 — 2026-10-11“ */
export function periodLabel(from: string, to: string) {
  const end = new Date(Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)), 0)).toISOString().slice(0, 10);
  return from.slice(8) === '01' && to === end ? `${MONTH_KA[Number(from.slice(5, 7)) - 1]} ${from.slice(0, 4)}` : `${from} — ${to}`;
}
const fmt = (v: number | null | undefined, unit: string) => {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const d = unit === 'gel' ? 2 : unit === 'count' ? 0 : unit === 'ratio' ? 2 : 1;
  return `${v.toLocaleString('en-US', { minimumFractionDigits: unit === 'gel' ? 2 : 0, maximumFractionDigits: d })}${UNIT_SFX[unit] ?? ''}`;
};
const num = (c: Cell): Cell => (typeof c === 'number' ? { v: c, fmt: Number.isInteger(c) ? '#,##0' : '#,##0.0#' } : c);
const sheet = (name: string, header: string[], rows: Cell[][], pre: Cell[][] = []): SheetSpec => {
  const all = [...pre, ...(pre.length ? [[] as Cell[]] : []), header, ...rows];
  return { name, rows: all.map((r) => r.map(num)), boldRows: [...pre.map((_, i) => i).slice(0, 1), pre.length ? pre.length + 1 : 0],
    widths: header.map((h, i) => Math.min(60, Math.max(10, h.length + 2, ...rows.slice(0, 200).map((r) => String((r[i] as string | number | null) ?? '').length + 2)))) };
};

@Injectable()
export class RptReportService {
  constructor(private readonly c: RptCommon, private readonly k: RptKpiService, private readonly rep: ReportingService, private readonly ops: ReportingOpsService,
              private readonly fin: ReportingFinService, private readonly audit: AuditService, private readonly qm: QmReportsService) {}

  validate(o: ReportOpts) {
    if (!DATE_RE.test(o.from) || !DATE_RE.test(o.to) || o.from > o.to) throw new BadRequestException('პერიოდი: from ≤ to (YYYY-MM-DD)');
    if (daysBetween(o.from, o.to) > 366) throw new BadRequestException('ანგარიშის პერიოდი — მაქსიმუმ 1 წელი');
  }

  /** ანგარიშის მონაცემები (ერთხელ) — xlsx და PDF ამას იყენებს */
  async gather(u: AuthUser, o: ReportOpts) {
    this.validate(o);
    const s = await this.c.settings();
    const base = await this.c.scope(u);
    const scope = this.c.narrow(base, o.department_id);
    const q: Q = { from: o.from, to: o.to, department_id: o.department_id };
    const df = (await sql<{ d: string | null }>`SELECT to_char(min(date_from), 'YYYY-MM-DD') AS d FROM rpt_refresh_runs WHERE status = 'ok'`.execute(this.c.db)).rows[0].d;
    // შედარების პერიოდი აგრეგაციის დაწყებამდეა → „—“ (და არა 0)
    const noData = <T extends Awaited<ReturnType<ReportingService['overview']>>>(r: T): T =>
      (r.compare && (!df || r.compare.from < df) ? { ...r, kpis: r.kpis.map((k) => ({ ...k, compare_value: null, change_pct: null })) } : r);
    const [prev, yoy] = (await Promise.all([this.rep.overview(u, { ...q, compare: 'prev' }), this.rep.overview(u, { ...q, compare: 'yoy' })])).map(noData);
    const deptName = o.department_id ? (await this.c.db.selectFrom('departments').select('name').where('id', '=', o.department_id).executeTakeFirst())?.name ?? '—'
      : scope.all ? 'მთელი კლინიკა' : (await this.c.db.selectFrom('departments').select('name').where('id', 'in', scope.depts).orderBy('name').execute()).map((d) => d.name).join(', ');
    const clinic = await this.c.db.selectFrom('clinic_settings').select(['name']).where('id', '=', 1).executeTakeFirst();
    // 13 თვე, ანგარიშის ბოლო თვემდე
    const kp = (await this.k.kpis(scope, false)).filter((x) => TREND_KPIS.includes(x.code) && !x.snapshot);
    const [ty, tm] = o.to.split('-').map(Number);
    const months = Array.from({ length: 13 }, (_, i) => {
      const d = new Date(Date.UTC(ty, tm - 13 + i, 1)); const from = d.toISOString().slice(0, 10);
      const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
      return { label: from.slice(0, 7), from, to: end > o.to ? o.to : end };
    });
    const trend: { code: string; name: string; unit: string; values: (number | null)[] }[] = kp.map((x) => ({ code: x.code, name: x.name, unit: x.unit, values: [] }));
    for (const m of months) {
      const t = df && m.to >= df ? await this.k.totals(scope, m.from, m.to) : null;
      for (const tr of trend) tr.values.push(t ? this.k.value(tr.code, t, null, s) : null);
    }
    const flow = await this.ops.flow(u, q);
    const beds = await this.ops.beds(u, q);
    const or = await this.ops.or(u, q);
    const imaging = await this.ops.dx(u, { ...q, section: 'imaging', by: 'device' });
    const lab = await this.ops.dx(u, { ...q, section: 'lab', by: 'device' });
    const stock = await this.ops.stock(u, q);
    const finance = scope.finance ? await this.fin.summary(u, q) : null;
    const balances = scope.finance && base.all && !o.department_id ? await this.fin.balances(u, { as_of: o.to }) : null;
    // ექიმები — მხოლოდ მოთხოვნით და წვდომით (ForbiddenException → გამოტოვება)
    const soft = async <T>(f: () => Promise<T>) => { try { return await f(); } catch (e) { if (e instanceof ForbiddenException) return null; throw e; } };
    const doctors = o.doctors ? {
      surgeon: await soft(() => this.ops.doctors(u, { ...q, role: 'surgeon' }, undefined as unknown as Request, false)),
      attending: await soft(() => this.ops.doctors(u, { ...q, role: 'attending' }, undefined as unknown as Request, false)),
      validator: await soft(() => this.ops.doctors(u, { ...q, role: 'validator' }, undefined as unknown as Request, false)),
      revenue: await soft(() => this.fin.doctors(u, { ...q, basis: 'performer' }, null)),
    } : null;
    // 0066: ხარისხი — მიმღების ხედვის არით (dashboard_visibility / monthly_section); გამორთულზე ხარისხის KPI-ებიც არ შედის
    const quality = scope.quality ? await this.qm.monthlySection(u, o.from, o.to, scope.all, scope.depts) : null;
    if (!quality) for (const r of [prev, yoy]) r.kpis = r.kpis.filter((k) => k.category !== 'quality');
    // 0072: ინფექციის კონტროლი — KPI-ების სექცია (dashboard_visibility / monthly_section)
    if (!scope.ipc || (await ipcRules(this.c.db))?.monthly_section === false) for (const r of [prev, yoy]) r.kpis = r.kpis.filter((k) => k.category !== 'ipc');
    // 0076: ბიომედ-აპარატურა — KPI-ების სექცია (dashboard_visibility / monthly_section)
    if (!scope.bme || (await bmeRptRules(this.c.db))?.monthly_section === false) for (const r of [prev, yoy]) r.kpis = r.kpis.filter((k) => k.category !== 'bme');
    // 0080: ცვლები / მორიგეობა — KPI-ების სექცია (dashboard_visibility / monthly_section)
    if (!scope.roster || (await rosterRptRules(this.c.db))?.monthly_section === false) for (const r of [prev, yoy]) r.kpis = r.kpis.filter((k) => k.category !== 'roster');
    const closedOpen = finance?.open_months.length ? `ფინანსური პერიოდი ჯერ არ არის დახურული (${finance.open_months.join(', ')}) — ფინანსური ციფრები შეიძლება შეიცვალოს` : null;
    return { o, title: `მენეჯერული ანგარიში — ${periodLabel(o.from, o.to)}`, clinic: clinic?.name ?? '', scope_label: deptName, generated_at: new Date(),
      data_as_of: prev.data_as_of, prev, yoy, months, trend, flow, beds, or, imaging, lab, stock, finance, balances, doctors, quality, note: closedOpen, min_cases: s.min_cases };
  }

  // ------------------------------------------------------------------------------------ xlsx
  xlsx(d: Awaited<ReturnType<RptReportService['gather']>>): ReportFile {
    const ts = d.generated_at.toLocaleString('ka-GE', { timeZone: 'Asia/Tbilisi' });
    const pre: Cell[][] = [[d.title], [`${d.clinic} · ${d.scope_label}`], [`პერიოდი: ${d.o.from} — ${d.o.to} · შექმნილია: ${ts}`],
      ...(d.note ? [[d.note] as Cell[]] : []), ['მომენტალური მაჩვენებლები (მარაგი) — ანგარიშის შექმნის მომენტისთვის; პაციენტის მონაცემები ანგარიშში არ არის']];
    const sheets: SheetSpec[] = [];
    const yo = new Map(d.yoy.kpis.map((k) => [k.code, k]));
    sheets.push(sheet('შეჯამება', ['კატეგორია', 'მაჩვენებელი', 'ერთეული', 'მნიშვნელობა', 'წინა პერიოდი', 'ცვლილება %', 'შარშან', 'ცვლილება % (შარშან)', 'სამიზნე', 'სტატუსი'],
      d.prev.kpis.map((k) => { const y = yo.get(k.code);
        return [CAT_ORDER[k.category] ?? k.category, k.name, k.unit_ka || '', k.value, k.compare_value, k.change_pct, y?.compare_value ?? null, y?.change_pct ?? null, k.target,
          k.status ? STATUS_KA[k.status] : ''] as Cell[]; }), pre));
    sheets.push(sheet('ტრენდი 13 თვე', ['მაჩვენებელი', ...d.months.map((m) => m.label)], d.trend.map((t) => [t.name, ...t.values])));
    sheets.push(sheet('ნაკადი', ['დღე', ...d.flow.series.map((s) => s.name), 'სულ'],
      [...d.flow.days.map((day, i) => [day, ...d.flow.series.map((s) => s.values[i]), d.flow.series.reduce((a, s) => a + s.values[i], 0)] as Cell[]),
        ['სულ', ...d.flow.series.map((s) => d.flow.totals[s.sub]), d.flow.series.reduce((a, s) => a + d.flow.totals[s.sub], 0)]]));
    sheets.push(sheet('საწოლები', ['განყოფილება', 'საწოლი (საშ.)', 'დატვირთვა %', 'შუაღამე (საშ.)', 'მიღება', 'გაწერა', 'გარდაცვალება', 'ALOS', 'შემოსული', 'გასული', 'განმეორებითი 30 დღე %'],
      d.beds.rows.map((r) => [r.department_name, r.beds_avg, r.occupancy_pct, r.census_avg, r.admissions, r.discharges, r.deaths, r.alos, r.transfers_in, r.transfers_out, r.readmit30_pct])));
    sheets.push(sheet('საოპერაციო ოთახები', ['ბლოკი', 'ოთახი', 'დასახელება', 'ოპერაციები', 'სამუშაო წთ', 'გამოყენებული წთ', 'დატვირთვა %'],
      d.or.rooms.map((r) => [r.block, r.code, r.name, r.cases, r.avail, r.used, r.utilization_pct])));
    sheets.push(sheet('საოპერაციო განყოფილებები', ['განყოფილება', 'დაგეგმილი', 'დასრულებული', 'გაუქმებული', 'გაუქმება %', 'გადაუდებელი %', 'პირველი დროული %', 'საშ. ხანგრძლივობა წთ'],
      d.or.departments.map((r) => [r.department_name, r.scheduled, r.done, r.cancelled, r.cancel_pct, r.emergency_pct, r.first_on_time_pct, r.surgery_min_avg])));
    const dxRows = (x: typeof d.lab) => x.rows.map((r) => [r.label, r.ordered, r.cancelled, r.external, r.external_pct, r.resulted, r.tat_median, r.tat_p90, r.tat_avg] as Cell[]);
    sheets.push(sheet('კვლევები', ['აპარატი', 'დანიშნული', 'გაუქმებული', 'გარე', 'გარე %', 'შესრულებული', 'TAT მედიანა სთ', 'TAT P90 სთ', 'TAT საშ. სთ'], dxRows(d.imaging)));
    sheets.push(sheet('ლაბორატორია', ['ანალიზატორი', 'დანიშნული', 'გაუქმებული', 'გარე', 'გარე %', 'შესრულებული', 'TAT მედიანა წთ', 'TAT P90 წთ', 'TAT საშ. წთ'], dxRows(d.lab)));
    sheets.push(sheet('მარაგი', ['ლოკაცია', 'განყოფილება', 'ხარჯი ₾', 'დანაკარგი ₾', 'მიღება ₾'],
      d.stock.locations.map((l) => [l.location_name, l.department_name ?? '', l.consumption, l.loss, l.receipts])));
    if (d.finance) {
      const f = d.finance;
      sheets.push(sheet('ფინანსები', ['განყოფილება', 'შემოსავალი (წმინდა)', 'პაციენტი', 'დაზღვევა', 'სახელმწიფო', 'სხვა', 'დაუზუსტებელი', 'მარაგის ხარჯი', 'ხარჯები', 'შედეგი', 'მარჟა %', 'გადახდები'],
        [...f.departments.map((x) => [x.department_name, x.rev_net, x.patient, x.insurance, x.state, x.other, x.undetermined, x.stock_cost, x.expenses, x.result, x.margin_pct, x.payments] as Cell[]),
          ['სულ', f.totals.rev_net, f.totals.patient, f.totals.insurance, f.totals.state, f.totals.other, f.totals.undetermined, f.totals.stock_cost, f.totals.expenses, f.totals.result, f.totals.margin_pct, f.totals.payments]]));
      sheets.push(sheet('გადამხდელები', ['გადამხდელი', 'სახე', 'შემოსავალი ₾', 'წილი %'],
        [...f.kinds.filter((k) => k.amount && !['insurance', 'state', 'other'].includes(k.kind)).map((k) => [k.name, '', k.amount, k.share_pct] as Cell[]),
          ...f.payers.map((p) => [p.name, p.kind_ka, p.amount, p.share_pct] as Cell[])]));
    }
    if (d.balances) {
      const b = d.balances; const H = ['მხარე', 'სახე', 'შეუტანელი', 'მონახაზი', 'ვადამდე', '1–30', '31–60', '61–90', '90+', 'სულ'];
      const rows = (g: typeof b.ap) => g.rows.map((r) => [r.party_name, r.party_kind_ka ?? g.name, r.unclaimed, r.draft, r.not_due, r.d1_30, r.d31_60, r.d61_90, r.d90, r.total] as Cell[]);
      sheets.push(sheet('დებიტორები', H, [...rows(b.ar_payer), ...rows(b.ar_patient)], [[`მდგომარეობა: ${b.snapshot_day ?? '—'}`]]));
      sheets.push(sheet('კრედიტორები', H, rows(b.ap), [[`მდგომარეობა: ${b.snapshot_day ?? '—'}`]]));
    }
    if (d.quality) for (const q of this.qm.xlsxSheets(d.quality, false).filter((x) => ['შეჯამება', 'კატეგორია × ზიანი', 'ინდიკატორები', 'ვადები', 'CAPA'].includes(x.name)))
      sheets.push({ ...q, name: `ხარისხი — ${q.name}`.slice(0, 31) });
    if (d.doctors) {
      const D = d.doctors; const sm = (x: { small: boolean }) => (x.small ? `< ${d.min_cases}` : '');
      if (D.surgeon) sheets.push(sheet('ექიმები — ქირურგი', ['ექიმი', 'დაგეგმილი', 'დასრულებული', 'გაუქმებული', 'გაუქმება %', 'პირველი დროული %', 'საშ. ხანგრძლივობა წთ', 'მცირე ნიმუში'],
        D.surgeon.rows.map((r) => { const x = r as unknown as Record<string, Cell> & { small: boolean }; return [x.doctor_name, x.scheduled, x.done, x.cancelled, x.cancel_pct, x.first_on_time_pct, x.surgery_min_avg, sm(x)] as Cell[]; })));
      if (D.attending) sheets.push(sheet('ექიმები — მკურნალი', ['ექიმი', 'მიღება', 'გაწერა', 'გარდაცვალება', 'ALOS', 'ლეტალობა %', 'განმეორებითი 30 დღე %', 'მცირე ნიმუში'],
        D.attending.rows.map((r) => { const x = r as unknown as Record<string, Cell> & { small: boolean }; return [x.doctor_name, x.admissions, x.discharges, x.deaths, x.alos, x.mortality_pct, x.readmit30_pct, sm(x)] as Cell[]; })));
      if (D.validator) sheets.push(sheet('ექიმები — ვალიდატორი', ['ექიმი', 'შესრულებული', 'TAT მედიანა წთ', 'TAT საშ. წთ', 'მცირე ნიმუში'],
        D.validator.rows.map((r) => { const x = r as unknown as Record<string, Cell> & { small: boolean }; return [x.doctor_name, x.resulted, x.tat_median_min, x.tat_avg_min, sm(x)] as Cell[]; })));
      if (D.revenue) sheets.push(sheet('ექიმები — შემოსავალი', ['ექიმი (შემსრულებელი)', 'შემოსავალი (წმინდა)', 'წილი %', 'პაციენტი', 'დაზღვევა', 'სახელმწიფო', 'სხვა', 'დაუზუსტებელი', 'ჩამოწერა', 'უარი'],
        D.revenue.rows.map((r) => [r.doctor_name, r.net, r.share_pct, r.patient, r.insurance, r.state, r.other, r.undetermined, r.writeoff, r.denied] as Cell[])));
    }
    return { name: `rpt_report_${d.o.from}_${d.o.to}.xlsx`, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: writeXlsxBook(sheets) };
  }

  // ------------------------------------------------------------------------------------ PDF
  async pdf(d: Awaited<ReturnType<RptReportService['gather']>>): Promise<ReportFile> {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 36, bottom: 40, left: 40, right: 40 }, bufferPages: true, info: { Title: d.title, Author: d.clinic } });
    doc.registerFont('R', join(FONT_DIR, 'EmrSans-Regular.ttf')); doc.registerFont('B', join(FONT_DIR, 'EmrSans-Bold.ttf'));
    const chunks: Buffer[] = []; doc.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<Buffer>((res) => doc.on('end', () => res(Buffer.concat(chunks))));
    const L = doc.page.margins.left; const W = doc.page.width - L - doc.page.margins.right;
    const bottom = () => doc.page.height - doc.page.margins.bottom;
    const tone: Record<string, string> = { green: '#1f7a3d', yellow: '#a36a00', red: '#b42318' };
    // სათაური
    doc.font('B').fontSize(9).fillColor('#555').text(d.clinic, L, doc.y, { width: W });
    doc.font('B').fontSize(15).fillColor('black').text(d.title, L, doc.y + 2, { width: W });
    doc.font('R').fontSize(9).fillColor('#444')
      .text(`${d.scope_label} · ${d.o.from} — ${d.o.to} · შედარება: წინა პერიოდი / შარშან · შექმნილია ${d.generated_at.toLocaleString('ka-GE', { timeZone: 'Asia/Tbilisi' })}`, { width: W });
    if (d.note) doc.fillColor('#a36a00').text(d.note, { width: W });
    doc.fillColor('black').moveDown(0.6);
    // KPI ცხრილი
    const cols = [{ h: 'მაჩვენებელი', w: 0.34 }, { h: 'მნიშვნელობა', w: 0.14, r: true }, { h: 'წინა პერიოდი', w: 0.13, r: true }, { h: 'ცვლ.', w: 0.08, r: true },
      { h: 'შარშან', w: 0.12, r: true }, { h: 'სამიზნე', w: 0.11, r: true }, { h: '', w: 0.08 }];
    const xs: number[] = []; let acc = L; for (const c of cols) { xs.push(acc); acc += c.w * W; }
    const rowH = 13;
    const head = () => {
      doc.font('B').fontSize(7.5).fillColor('#555'); const y = doc.y;
      cols.forEach((c, i) => doc.text(c.h, xs[i] + 2, y, { width: c.w * W - 4, align: c.r ? 'right' : 'left', lineBreak: false }));
      doc.moveTo(L, y + 10).lineTo(L + W, y + 10).strokeColor('#bbb').lineWidth(0.5).stroke(); doc.y = y + 12;
    };
    head();
    const yo = new Map(d.yoy.kpis.map((k) => [k.code, k]));
    let cat = '';
    for (const k of d.prev.kpis) {
      if (doc.y + rowH * 2 > bottom()) { doc.addPage(); head(); }
      if (k.category !== cat) {
        cat = k.category; doc.font('B').fontSize(8.5).fillColor('black').text(CAT_ORDER[cat] ?? cat, L, doc.y + 3, { width: W, lineBreak: false }); doc.y += 13;
      }
      const y = doc.y; const y2 = yo.get(k.code)?.compare_value ?? null;
      const ch = k.change_pct === null ? '—' : `${k.change_pct > 0 ? '+' : ''}${k.change_pct}%`;
      const vals = [k.name, fmt(k.value, k.unit), fmt(k.compare_value, k.unit), ch, fmt(y2, k.unit), fmt(k.target, k.unit)];
      doc.font('R').fontSize(8).fillColor('black');
      vals.forEach((v, i) => doc.text(v, xs[i] + 2, y, { width: cols[i].w * W - 4, height: rowH - 2, align: cols[i].r ? 'right' : 'left', lineBreak: false, ellipsis: true }));
      if (k.status) { doc.circle(xs[6] + 8, y + 4.5, 3).fill(tone[k.status]); doc.font('R').fontSize(7).fillColor(tone[k.status]).text(STATUS_KA[k.status], xs[6] + 14, y + 0.5, { lineBreak: false }); }
      doc.fillColor('black'); doc.y = y + rowH;
    }
    // 13 თვე — მინი-დიაგრამები
    const charts = d.trend.filter((t) => PDF_TRENDS.includes(t.code));
    if (charts.length) {
      if (doc.y + 150 > bottom()) doc.addPage(); else doc.moveDown(0.8);
      doc.font('B').fontSize(10).fillColor('black').text('ბოლო 13 თვე', L, doc.y, { width: W }); doc.moveDown(0.3);
      const top = doc.y; const cw = (W - 16 * (charts.length - 1)) / charts.length; const ch = 95;
      charts.forEach((t, ci) => {
        const x0 = L + ci * (cw + 16);
        doc.font('B').fontSize(8).fillColor('#333').text(t.name, x0, top, { width: cw, lineBreak: false, ellipsis: true });
        const vals = t.values.map((v) => v ?? 0); const max = Math.max(1, ...vals);
        const bw = cw / vals.length; const base = top + 14 + ch;
        vals.forEach((v, i) => {
          const h = (v / max) * ch; const isLast = i === vals.length - 1;
          if (t.values[i] !== null) doc.rect(x0 + i * bw + 1, base - h, bw - 2, h).fill(isLast ? '#2563eb' : '#93b4f5');
          if (i % 3 === 0 || isLast) doc.font('R').fontSize(6).fillColor('#666').text(d.months[i].label.slice(2), x0 + i * bw - 4, base + 2, { width: bw + 8, align: 'center', lineBreak: false });
        });
        doc.font('R').fontSize(7).fillColor('#333').text(`ბოლო: ${fmt(t.values[t.values.length - 1], t.unit)} · მაქს.: ${fmt(Math.max(...vals), t.unit)}`, x0, base + 12, { width: cw, lineBreak: false });
      });
      doc.y = top + 14 + ch + 26; doc.x = L;
    }
    // ფინანსები — მოკლედ
    if (d.finance) {
      const f = d.finance.totals;
      if (doc.y + 70 > bottom()) doc.addPage(); else doc.moveDown(0.6);
      doc.font('B').fontSize(10).fillColor('black').text('ფინანსები', L, doc.y, { width: W });
      doc.font('R').fontSize(8.5).text([`შემოსავალი (წმინდა): ${fmt(f.rev_net, 'gel')}`, `ხარჯი: ${fmt(f.costs, 'gel')}`, `შედეგი: ${fmt(f.result, 'gel')}`,
        `მარჟა: ${fmt(f.margin_pct, 'pct')}`, `გადახდები: ${fmt(f.payments, 'gel')}`].join(' · '), L, doc.y + 2, { width: W });
      doc.text(`გადამხდელები: ${d.finance.kinds.filter((k) => k.share_pct).map((k) => `${k.name} ${k.share_pct}%`).join(' · ')}`, { width: W });
      if (d.balances) {
        const b = d.balances;
        doc.text(`დებიტორები (${b.snapshot_day ?? '—'}): გადამხდელები ${fmt(b.ar_payer.totals.total, 'gel')}, აქედან 90+ ${fmt(b.ar_payer.totals.d90, 'gel')} · პაციენტები ${fmt(b.ar_patient.totals.total, 'gel')} · `
          + `კრედიტორები: ${fmt(b.ap.totals.total, 'gel')}, ვადაგადაცილებული ${fmt(b.ap.totals.d1_30 + b.ap.totals.d31_60 + b.ap.totals.d61_90 + b.ap.totals.d90, 'gel')}`, { width: W });
      }
    }
    // 0066: ხარისხი — მოკლედ
    if (d.quality) {
      const q = d.quality; const T = q.summary.totals; const mc = q.scope.minCell;
      const v = (x: number | null | undefined, sfx = '') => (x === null || x === undefined ? (mc ? `< ${mc}` : '—') : `${x}${sfx}`);
      if (doc.y + 60 > bottom()) doc.addPage(); else doc.moveDown(0.6);
      doc.font('B').fontSize(10).fillColor('black').text('ხარისხი და ინციდენტები', L, doc.y, { width: W });
      doc.font('R').fontSize(8.5).text([`ინციდენტები: ${v(T.n)} (ზიანით ${v(T.harm)}, near-miss ${v(T.near_miss)}, სენტინელური ${v(T.sentinel)})`,
        `near-miss თანაფარდობა: ${v(T.near_miss_ratio)}`, `ტრიაჟი ვადაში: ${v(T.triage_on_time_pct, '%')}`].join(' · '), L, doc.y + 2, { width: W });
      doc.text(q.indicators.rows.map((r) => `${r.name}: ${v(r.value)}`).join(' · '), { width: W });
      doc.text(`CAPA: ღია ${v(q.capa.snapshot.open)}, ვადაგადაცილებული ${v(q.capa.snapshot.overdue)} · პერიოდში შესრულდა ${v(q.capa.period.done)} (ვადაში ${v(q.capa.period.on_time_pct, '%')})`, { width: W });
    }
    // ძირი: გვერდი / წყარო
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i); doc.page.margins.bottom = 0;   // ძირი ველის გარეთ — ახალი გვერდი არ უნდა დაემატოს
      const y = doc.page.height - 28;
      doc.font('R').fontSize(7).fillColor('#888').text(`მენეჯერული ანგარიში · აგრეგირებული მონაცემები (rpt_*), პაციენტის მონაცემების გარეშე · მონაცემები: ${d.data_as_of ? new Date(d.data_as_of).toLocaleString('ka-GE', { timeZone: 'Asia/Tbilisi' }) : '—'}`,
        L, y, { width: W - 60, lineBreak: false });
      doc.text(`${i - range.start + 1} / ${range.count}`, L + W - 50, y, { width: 50, align: 'right', lineBreak: false });
    }
    doc.end();
    return { name: `rpt_report_${d.o.from}_${d.o.to}.pdf`, type: 'application/pdf', body: await done };
  }

  async build(u: AuthUser, o: ReportOpts, formats: string[]) {
    const d = await this.gather(u, o);
    const files: ReportFile[] = [];
    if (formats.includes('xlsx')) files.push(this.xlsx(d));
    if (formats.includes('pdf')) files.push(await this.pdf(d));
    return { data: d, files };
  }

  async download(u: AuthUser, q: Q, req: Request) {
    const format = q.format ?? 'xlsx';
    if (!['xlsx', 'pdf'].includes(format)) throw new BadRequestException('format: xlsx / pdf');
    const o: ReportOpts = { from: q.from ?? '', to: q.to ?? '', department_id: q.department_id || undefined, doctors: q.doctors === '1' && format === 'xlsx' };
    const { files, data } = await this.build(u, o, [format]);
    await this.audit.log(auditCtx(req), { action: 'REPORT_EXPORT', entityName: 'rpt_reports', entityId: 'report',
      newData: { format, from: o.from, to: o.to, department_id: o.department_id ?? null, doctors: !!data.doctors, phi: false } });
    return files[0];
  }
}

@Controller('reporting')
export class RptReportController {
  constructor(private readonly s: RptReportService) {}
  /** მენეჯერული ანგარიში: GET /reporting/report?from&to&format=xlsx|pdf&department_id&doctors=1 */
  @Get('report') @Roles(...RPT_READ)
  async report(@Query() q: Q, @CurrentUser() u: AuthUser, @Req() r: Request, @Res({ passthrough: true }) res: Response) {
    const out = await this.s.download(u, q, r);
    res.set({ 'Content-Type': out.type, 'Content-Disposition': `attachment; filename="${encodeURIComponent(out.name)}"` });
    return new StreamableFile(out.body);
  }
}
