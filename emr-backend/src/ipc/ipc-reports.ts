import { BadRequestException, Controller, ForbiddenException, Get, Injectable, Query, Req, Res, StreamableFile } from '@nestjs/common';
import type { Request, Response } from 'express';
import { sql } from 'kysely';
import { join } from 'node:path';
import PDFDocument from 'pdfkit';
import { auditCtx } from '../audit/audit-context';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/roles';
import { writeXlsxBook, type Cell, type SheetSpec } from '../claims-export/xlsx';
import { loadEnv } from '../config/env';
import { toCsv } from '../finance/finance-common';
import { IpcAuditsService } from './ipc-audits';
import { IPC_AGG, IPC_FULL, IpcCommon } from './ipc-common';
import { ipcFactRows, type IpcFactRow } from './ipc-facts';

const TZ = loadEnv().CLINIC_TZ;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const FONT_DIR = join(__dirname, '..', '..', 'assets', 'fonts');
type Q = Record<string, string | undefined>;
const ONSET_KA: Record<string, string> = { community: 'საზოგადოებრივი', hospital: 'ჰოსპიტალური', unknown: 'უცნობი' };
const STATUS_KA: Record<string, string> = { active: 'აქტიური', cleared: 'მოხსნილი', confirmed: 'დადასტურებული' };
const ATTR_KA: Record<string, string> = { current: 'მიმდინარე განყოფილება', transfer: 'წინა განყოფილება (გადაყვანა)', readmission: 'წინა ჰოსპიტალიზაცია', manual: 'ხელით' };
const OUTCOME_KA: Record<string, string> = { ongoing: 'მიმდინარე', recovered: 'გამოჯანმრთელდა', transferred: 'გადაიყვანეს', died: 'გარდაიცვალა' };

type Sum = Omit<IpcFactRow, 'day' | 'department_id'> & { patient_days: number; cl: number; uc: number; vent: number };
const KPI_DEF: { code: string; name: string; unit: string; f: (s: Sum) => number | null }[] = [];
const rate = (a: number, b: number, per: number) => (b > 0 ? Math.round((a / b) * per * 100) / 100 : null);
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
KPI_DEF.push(
  { code: 'ipc_hai_rate', name: 'HAI / 1000 პაციენტ-დღე', unit: '', f: (s) => rate(s.hai, s.patient_days, 1000) },
  { code: 'ipc_clabsi_rate', name: 'CLABSI / 1000 ცენტრ. ხაზის დღე', unit: '', f: (s) => rate(s.clabsi, s.cl, 1000) },
  { code: 'ipc_cauti_rate', name: 'CAUTI / 1000 კათეტერ-დღე', unit: '', f: (s) => rate(s.cauti, s.uc, 1000) },
  { code: 'ipc_vap_rate', name: 'VAP / 1000 ვენტილაციის დღე', unit: '', f: (s) => rate(s.vap, s.vent, 1000) },
  { code: 'ipc_ssi_pct', name: 'SSI, %', unit: '%', f: (s) => pct(s.ssi, s.ssi_ops) },
  { code: 'ipc_mdro_rate', name: 'ჰოსპიტალური MDRO / 1000 პაციენტ-დღე', unit: '', f: (s) => rate(s.mdro_hosp, s.patient_days, 1000) },
  { code: 'ipc_ddd_100', name: 'DDD / 100 პაციენტ-დღე', unit: '', f: (s) => rate(s.ddd, s.patient_days, 100) },
  { code: 'ipc_access_pct', name: 'AWaRe Access, % DDD', unit: '%', f: (s) => pct(s.ddd_access, s.ddd) },
  { code: 'ipc_hh_pct', name: 'ხელის ჰიგიენა, %', unit: '%', f: (s) => pct(s.hh_done, s.hh_opps) },
  { code: 'ipc_handrub_l', name: 'ხელის ანტისეპტიკი, ლ / 1000 პაციენტ-დღე', unit: '', f: (s) => rate(s.handrub_l, s.patient_days, 1000) },
);
export const IPC_KPI_CODES = KPI_DEF.map((k) => k.code);

/**
 * IPC ანგარიში (0072): შეჯამება (KPI-ები იგივე ფორმულით, რაც მენეჯერულ დაფაზე — ipcFactRows), განყოფილებები, თვეები, HAI ტიპებით,
 * MDRO ტიპებით, ხელის ჰიგიენა / ჩეკლისტები; ექსპორტი xlsx / PDF; დეპერსონალიზებული რეესტრი (HAI / MDRO; xlsx / CSV) — მხოლოდ infection.
 * ხედვა: infection / infection_view — კლინიკა; infection_dept — თავისი განყოფილებები. პაციენტის მონაცემები ანგარიშში არ შედის.
 */
@Injectable()
export class IpcReportsService {
  constructor(private readonly c: IpcCommon, private readonly audits: IpcAuditsService, private readonly audit: AuditService) {}
  private get db() { return this.c.db; }

  private async range(u: AuthUser, q: Q) {
    await this.c.rules();
    if (!q.from || !q.to || !DATE.test(q.from) || !DATE.test(q.to) || q.from > q.to) throw new BadRequestException({ code: 'RANGE', message: 'from / to (YYYY-MM-DD)' });
    if ((Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 > 731) throw new BadRequestException({ code: 'RANGE', message: 'პერიოდი — მაქსიმუმ 2 წელი' });
    const sc = await this.c.aggScope(u);
    if (q.department_id && !sc.full && !sc.depts.includes(q.department_id)) throw new ForbiddenException({ code: 'OUT_OF_SCOPE', message: 'განყოფილება თქვენს არეში არ არის' });
    return { from: q.from, to: q.to, depts: q.department_id ? [q.department_id] : sc.full ? null : sc.depts, department_id: q.department_id ?? null };
  }

  async summary(u: AuthUser, q: Q) {
    const g = await this.range(u, q);
    const inScope = (d: string | null) => !g.depts || (!!d && g.depts.includes(d));
    const facts = ((await ipcFactRows(this.db, g.from, g.to)) ?? []).filter((x) => inScope(x.department_id));
    const dd = (await sql<{ department_id: string; department: string; ym: string; pd: number; cl: number; uc: number; vent: number }>`
      SELECT f.department_id, d.name AS department, to_char(f.day, 'YYYY-MM') AS ym, sum(f.patient_days)::int AS pd, sum(f.central_line_days)::int AS cl,
             sum(f.urinary_days)::int AS uc, sum(f.vent_days)::int AS vent
        FROM rpt_fact_ipc_daily f JOIN departments d ON d.id = f.department_id
       WHERE f.day BETWEEN ${g.from}::date AND ${g.to}::date ${g.depts ? sql`AND f.department_id = ANY(${sql.val(g.depts)}::uuid[])` : sql``}
       GROUP BY 1, 2, 3`.execute(this.db)).rows;
    const sum = (fs: IpcFactRow[], ds: typeof dd): Sum => {
      const s: Sum = { hai: 0, clabsi: 0, cauti: 0, vap: 0, ssi_ops: 0, ssi: 0, mdro_hosp: 0, mdro_all: 0, ddd: 0, ddd_access: 0, dot: 0, hh_opps: 0, hh_done: 0, handrub_l: 0,
        patient_days: 0, cl: 0, uc: 0, vent: 0 };
      for (const f of fs) for (const k of Object.keys(f) as (keyof IpcFactRow)[]) if (k !== 'day' && k !== 'department_id') (s as Record<string, number>)[k] += Number(f[k]);
      for (const d of ds) { s.patient_days += d.pd; s.cl += d.cl; s.uc += d.uc; s.vent += d.vent; }
      return s;
    };
    const kpis = (s: Sum) => Object.fromEntries(KPI_DEF.map((k) => [k.code, k.f(s)]));
    const round = (s: Sum) => ({ ...s, ddd: Math.round(s.ddd * 100) / 100, ddd_access: Math.round(s.ddd_access * 100) / 100, handrub_l: Math.round(s.handrub_l * 1000) / 1000 });
    const total = sum(facts, dd);
    const names = new Map<string, string>(dd.map((x) => [x.department_id, x.department]));
    const miss = [...new Set(facts.map((x) => x.department_id).filter((x): x is string => !!x && !names.has(x)))];
    if (miss.length) (await this.db.selectFrom('departments').select(['id', 'name']).where('id', 'in', miss).execute()).forEach((d) => names.set(d.id, d.name));
    const deptIds = [...new Set([...dd.map((x) => x.department_id), ...facts.map((x) => x.department_id).filter((x): x is string => !!x)])];
    const departments = deptIds.map((id) => { const s = sum(facts.filter((x) => x.department_id === id), dd.filter((x) => x.department_id === id));
      return { department_id: id, department: names.get(id) ?? '—', ...round(s), kpi: kpis(s) }; }).sort((a, b) => a.department.localeCompare(b.department));
    const months = [...new Set([...dd.map((x) => x.ym), ...facts.map((x) => x.day.slice(0, 7))])].sort().map((m) => {
      const s = sum(facts.filter((x) => x.day.startsWith(m)), dd.filter((x) => x.ym === m)); return { ym: m, ...round(s), kpi: kpis(s) }; });
    const dcond = (col: string) => (g.depts ? sql`AND ${sql.ref(col)} = ANY(${sql.val(g.depts)}::uuid[])` : sql``);
    const [hai, mdro] = await Promise.all([
      sql<{ hai_type: string; name: string; n: number; device: number; died: number }>`
        SELECT h.hai_type, t.name, count(*)::int AS n, count(*) FILTER (WHERE h.device_assoc)::int AS device, count(*) FILTER (WHERE h.outcome = 'died')::int AS died
          FROM ipc_hai_cases h JOIN ipc_hai_types t ON t.code = h.hai_type
         WHERE h.status = 'confirmed' AND h.onset_date BETWEEN ${g.from}::date AND ${g.to}::date ${dcond('h.department_id')}
         GROUP BY 1, 2, t.sort_order ORDER BY t.sort_order`.execute(this.db),
      sql<{ mdro_code: string; name: string; hospital: number; community: number; unknown: number }>`
        SELECT f.mdro_code, t.name, count(*) FILTER (WHERE f.onset = 'hospital')::int AS hospital, count(*) FILTER (WHERE f.onset = 'community')::int AS community,
               count(*) FILTER (WHERE f.onset IS NULL OR f.onset = 'unknown')::int AS unknown
          FROM ipc_patient_flags f JOIN ipc_mdro_types t ON t.code = f.mdro_code
         WHERE f.status IN ('active', 'cleared') AND (coalesce(f.specimen_at, f.detected_at) AT TIME ZONE ${TZ})::date BETWEEN ${g.from}::date AND ${g.to}::date
           ${g.depts ? sql`AND (SELECT a.department_id FROM bed_assignments a WHERE a.encounter_id = f.encounter_id AND a.end_kind IS DISTINCT FROM 'cancel'
                              AND a.started_at <= f.detected_at ORDER BY a.started_at DESC LIMIT 1) = ANY(${sql.val(g.depts)}::uuid[])` : sql``}
         GROUP BY 1, 2, t.sort_order ORDER BY t.sort_order`.execute(this.db),
    ]);
    const audits = await this.audits.stats(u, { from: g.from, to: g.to, department_id: g.department_id ?? undefined });
    const dname = g.department_id ? names.get(g.department_id) ?? (await this.db.selectFrom('departments').select('name').where('id', '=', g.department_id).executeTakeFirst())?.name ?? '—'
      : g.depts ? 'თქვენი განყოფილებები' : 'მთელი კლინიკა';
    return { from: g.from, to: g.to, scope_label: dname, kpi_defs: KPI_DEF.map(({ code, name, unit }) => ({ code, name, unit })),
      total: round(total), kpi: kpis(total), departments, months, hai: hai.rows, mdro: mdro.rows, audits };
  }

  // ------------------------------------------------------------------------------------ ექსპორტი
  async export(u: AuthUser, q: Q, req: Request) {
    const format = q.format ?? 'xlsx';
    if (!['xlsx', 'pdf'].includes(format)) throw new BadRequestException('format: xlsx / pdf');
    const d = await this.summary(u, q);
    const clinic = (await this.db.selectFrom('clinic_settings').select('name').where('id', '=', 1).executeTakeFirst())?.name ?? '';
    await this.audit.log(auditCtx(req), { action: 'IPC_REPORT_EXPORT', entityName: 'ipc_reports', entityId: 'summary', newData: { format, from: d.from, to: d.to, scope: d.scope_label } });
    const base = `ipc_report_${d.from}_${d.to}`;
    if (format === 'xlsx') return { name: `${base}.xlsx`, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: writeXlsxBook(this.sheets(d, clinic)) };
    return { name: `${base}.pdf`, type: 'application/pdf', body: await this.pdf(d, clinic) };
  }

  private sheets(d: Awaited<ReturnType<IpcReportsService['summary']>>, clinic: string): SheetSpec[] {
    const num = (v: number | null | undefined, f = '0.##'): Cell => (v === null || v === undefined ? null : { v, fmt: f });
    const head = [[clinic], [`ინფექციის კონტროლი — ანგარიში · ${d.from} — ${d.to} · ${d.scope_label}`], []];
    const kpiCols = d.kpi_defs.map((k) => k.name);
    return [
      { name: 'შეჯამება', rows: [...head, ['მაჩვენებელი', 'მნიშვნელობა'], ...d.kpi_defs.map((k) => [k.name, num(d.kpi[k.code])]), [],
        ['პაციენტ-დღე', num(d.total.patient_days, '0')], ['ცენტრ. ხაზის დღე', num(d.total.cl, '0')], ['კათეტერ-დღე', num(d.total.uc, '0')], ['ვენტილაციის დღე', num(d.total.vent, '0')],
        ['HAI (დადასტ.)', num(d.total.hai, '0')], ['SSI / ოპერაციები', `${d.total.ssi} / ${d.total.ssi_ops}`], ['MDRO ჰოსპ. / სულ', `${d.total.mdro_hosp} / ${d.total.mdro_all}`],
        ['DDD', num(d.total.ddd)], ['DOT', num(d.total.dot, '0')], ['ხელის ჰიგიენა (შესრ. / შესაძლ.)', `${d.total.hh_done} / ${d.total.hh_opps}`], ['ანტისეპტიკი, ლ', num(d.total.handrub_l)]],
        boldRows: [1, 3], widths: [44, 16] },
      { name: 'განყოფილებები', rows: [...head, ['განყოფილება', 'პაციენტ-დღე', 'HAI', ...kpiCols],
        ...d.departments.map((x) => [x.department, num(x.patient_days, '0'), num(x.hai, '0'), ...d.kpi_defs.map((k) => num(x.kpi[k.code]))])],
        boldRows: [1, 3], widths: [30, 12, 8, ...kpiCols.map(() => 14)] },
      { name: 'თვეები', rows: [...head, ['თვე', 'პაციენტ-დღე', 'HAI', ...kpiCols], ...d.months.map((x) => [x.ym, num(x.patient_days, '0'), num(x.hai, '0'), ...d.kpi_defs.map((k) => num(x.kpi[k.code]))])],
        boldRows: [1, 3], widths: [10, 12, 8, ...kpiCols.map(() => 14)] },
      { name: 'HAI და MDRO', rows: [...head, ['HAI ტიპი', 'დადასტურებული', 'მოწყობილობასთან', 'გარდაიცვალა'], ...d.hai.map((x) => [x.name, num(x.n, '0'), num(x.device, '0'), num(x.died, '0')]), [],
        ['MDRO', 'ჰოსპიტალური', 'საზოგადოებრივი', 'უცნობი'], ...d.mdro.map((x) => [x.name, num(x.hospital, '0'), num(x.community, '0'), num(x.unknown, '0')])],
        boldRows: [1, 3, 5 + d.hai.length], widths: [48, 16, 16, 14] },
      { name: 'ხელის ჰიგიენა', rows: [...head, ['ჭრილი', 'შესაძლებლობა', 'შესრულება', '%'],
        ['სულ', num(d.audits.hand_hygiene.opps, '0'), num(d.audits.hand_hygiene.done, '0'), num(d.audits.hand_hygiene.pct)],
        ...d.audits.hand_hygiene.moments.map((m) => [`მომენტი ${m.moment} — ${m.label}`, num(m.opps, '0'), num(m.done, '0'), num(m.pct)]),
        ...d.audits.hand_hygiene.professions.map((p) => [p.label, num(p.opps, '0'), num(p.done, '0'), num(p.pct)]),
        ...d.audits.hand_hygiene.departments.map((p) => [`${p.department}${p.insufficient ? ' *' : ''}`, num(p.opps, '0'), num(p.done, '0'), num(p.pct)]),
        [], [`* — ${d.audits.hand_hygiene.min_obs}-ზე ნაკლები შესაძლებლობა თვეში (WHO)`]], boldRows: [1, 3], widths: [44, 14, 12, 8] },
      { name: 'ჩეკლისტები', rows: [...head, ['შაბლონი / განყოფილება', 'აუდიტი', '%', 'სამიზნე'],
        ...d.audits.checklists.flatMap((t) => [[t.template, num(t.audits, '0'), num(t.pct), num(t.target)] as Cell[],
          ...t.departments.map((x) => [`  ${x.department}`, num(x.audits, '0'), num(x.pct), null] as Cell[]),
          ...t.top_no.map((x) => [`  ✗ ${x.text}`, num(x.no, '0'), num(x.pct_no), null] as Cell[])])], boldRows: [1, 3], widths: [70, 10, 8, 10] },
    ];
  }

  private async pdf(d: Awaited<ReturnType<IpcReportsService['summary']>>, clinic: string): Promise<Buffer> {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 36, bottom: 40, left: 40, right: 40 }, bufferPages: true, info: { Title: 'ინფექციის კონტროლი — ანგარიში', Author: clinic } });
    doc.registerFont('R', join(FONT_DIR, 'EmrSans-Regular.ttf')); doc.registerFont('B', join(FONT_DIR, 'EmrSans-Bold.ttf'));
    const chunks: Buffer[] = []; doc.on('data', (x: Buffer) => chunks.push(x));
    const done = new Promise<Buffer>((res) => doc.on('end', () => res(Buffer.concat(chunks))));
    const L = doc.page.margins.left; const W = doc.page.width - L - doc.page.margins.right;
    const bottom = () => doc.page.height - doc.page.margins.bottom;
    const fv = (v: number | null | undefined, sfx = '') => (v === null || v === undefined ? '—' : `${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}${sfx}`);
    doc.font('B').fontSize(9).fillColor('#555').text(clinic, L, doc.y, { width: W });
    doc.font('B').fontSize(15).fillColor('black').text('ინფექციის კონტროლი — ანგარიში', L, doc.y + 2, { width: W });
    doc.font('R').fontSize(9).fillColor('#444').text(`${d.scope_label} · ${d.from} — ${d.to} · შექმნილია ${new Date().toLocaleString('ka-GE', { timeZone: TZ })}`, { width: W });
    doc.fillColor('black').moveDown(0.6);
    const section = (t: string) => { if (doc.y + 60 > bottom()) doc.addPage(); else doc.moveDown(0.5); doc.font('B').fontSize(10.5).fillColor('black').text(t, L, doc.y, { width: W }); doc.moveDown(0.2); };
    const table = (cols: { h: string; w: number; r?: boolean }[], rows: string[][]) => {
      const xs: number[] = []; let acc = L; for (const c of cols) { xs.push(acc); acc += c.w * W; }
      const head = () => { const y = doc.y; doc.font('B').fontSize(7.5).fillColor('#555');
        cols.forEach((c, i) => doc.text(c.h, xs[i] + 2, y, { width: c.w * W - 4, align: c.r ? 'right' : 'left', lineBreak: false, ellipsis: true }));
        doc.moveTo(L, y + 10).lineTo(L + W, y + 10).strokeColor('#bbb').lineWidth(0.5).stroke(); doc.y = y + 12; };
      head();
      for (const r of rows) {
        if (doc.y + 26 > bottom()) { doc.addPage(); head(); }
        const y = doc.y; doc.font('R').fontSize(8).fillColor('black');
        r.forEach((v, i) => doc.text(v, xs[i] + 2, y, { width: cols[i].w * W - 4, align: cols[i].r ? 'right' : 'left', lineBreak: false, ellipsis: true }));
        doc.y = y + 12;
      }
      doc.x = L;
    };
    section('მაჩვენებლები');
    table([{ h: 'მაჩვენებელი', w: 0.7 }, { h: 'მნიშვნელობა', w: 0.3, r: true }], d.kpi_defs.map((k) => [k.name, fv(d.kpi[k.code], k.unit)]));
    section('მნიშვნელები და რაოდენობები');
    table([{ h: '', w: 0.7 }, { h: '', w: 0.3, r: true }], [['პაციენტ-დღე', fv(d.total.patient_days)], ['ცენტრ. ხაზი / კათეტერი / ვენტილაცია, დღე', `${d.total.cl} / ${d.total.uc} / ${d.total.vent}`],
      ['HAI (დადასტურებული)', fv(d.total.hai)], ['SSI / ოპერაციები (დაკვირვება დასრულდა)', `${d.total.ssi} / ${d.total.ssi_ops}`],
      ['MDRO: ჰოსპიტალური / სულ', `${d.total.mdro_hosp} / ${d.total.mdro_all}`], ['ხელის ჰიგიენა: შესრულება / შესაძლებლობა', `${d.total.hh_done} / ${d.total.hh_opps}`]]);
    if (d.departments.length) {
      section('განყოფილებები');
      table([{ h: 'განყოფილება', w: 0.28 }, { h: 'პ.-დღე', w: 0.09, r: true }, { h: 'HAI/1000', w: 0.1, r: true }, { h: 'MDRO/1000', w: 0.11, r: true },
        { h: 'DDD/100', w: 0.1, r: true }, { h: 'Access %', w: 0.1, r: true }, { h: 'ხ. ჰიგ. %', w: 0.11, r: true }, { h: 'ლ/1000', w: 0.11, r: true }],
      d.departments.map((x) => [x.department, fv(x.patient_days), fv(x.kpi.ipc_hai_rate), fv(x.kpi.ipc_mdro_rate), fv(x.kpi.ipc_ddd_100), fv(x.kpi.ipc_access_pct),
        fv(x.kpi.ipc_hh_pct), fv(x.kpi.ipc_handrub_l)]));
    }
    if (d.hai.length) { section('HAI ტიპებით (დადასტურებული)'); table([{ h: 'ტიპი', w: 0.55 }, { h: 'სულ', w: 0.15, r: true }, { h: 'მოწყობილობასთან', w: 0.15, r: true }, { h: 'გარდაიცვალა', w: 0.15, r: true }],
      d.hai.map((x) => [x.name, fv(x.n), fv(x.device), fv(x.died)])); }
    if (d.mdro.length) { section('MDRO (ახალი ფლაგები)'); table([{ h: 'MDRO', w: 0.55 }, { h: 'ჰოსპიტალური', w: 0.15, r: true }, { h: 'საზოგადოებრივი', w: 0.15, r: true }, { h: 'უცნობი', w: 0.15, r: true }],
      d.mdro.map((x) => [x.name.replace(/—/g, '-'), fv(x.hospital), fv(x.community), fv(x.unknown)])); }
    const hh = d.audits.hand_hygiene;
    if (hh.opps) { section(`ხელის ჰიგიენა (WHO 5 მომენტი) — ${fv(hh.pct, '%')}, სამიზნე ${hh.target}%`);
      table([{ h: 'ჭრილი', w: 0.55 }, { h: 'შესაძლებლობა', w: 0.15, r: true }, { h: 'შესრულება', w: 0.15, r: true }, { h: '%', w: 0.15, r: true }],
        [...hh.moments.map((m) => [`მომენტი ${m.moment} — ${m.label}`, fv(m.opps), fv(m.done), fv(m.pct)]), ...hh.professions.map((p) => [p.label, fv(p.opps), fv(p.done), fv(p.pct)])]); }
    if (d.audits.checklists.length) { section('ჩეკლისტები'); table([{ h: 'შაბლონი', w: 0.6 }, { h: 'აუდიტი', w: 0.13, r: true }, { h: '%', w: 0.13, r: true }, { h: 'სამიზნე', w: 0.14, r: true }],
      d.audits.checklists.map((t) => [t.template, fv(t.audits), fv(t.pct), fv(t.target)])); }
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i); doc.page.margins.bottom = 0;
      const y = doc.page.height - 28;
      doc.font('R').fontSize(7).fillColor('#888').text('ინფექციის კონტროლი · აგრეგირებული მონაცემები, პაციენტის მონაცემების გარეშე', L, y, { width: W - 60, lineBreak: false });
      doc.text(`${i - range.start + 1} / ${range.count}`, L + W - 50, y, { width: 50, align: 'right', lineBreak: false });
    }
    doc.end();
    return done;
  }

  // ------------------------------------------------------------------------------------ დეპერსონალიზებული რეესტრი
  async registry(u: AuthUser, q: Q, req: Request) {
    const g = await this.range(u, q);
    const kind = q.kind ?? 'hai'; const format = q.format ?? 'xlsx';
    if (!['hai', 'mdro'].includes(kind)) throw new BadRequestException('kind: hai / mdro');
    if (!['xlsx', 'csv'].includes(format)) throw new BadRequestException('format: xlsx / csv');
    const age = sql<number>`extract(year FROM age(coalesce(x.at, now()), p.birth_date))::int`;
    let head: string[]; let rows: (string | number | null)[][]; let title: string;
    if (kind === 'hai') {
      const r = (await sql<Record<string, string | number | boolean | null>>`
        SELECT x.case_no, x.onset_date::text AS onset, x.onset_day, d.name AS department, t.name AS hai_type, x.ssi_depth, x.device_assoc, x.device_kind, x.attribution,
               x.post_discharge, x.outcome, ${age} AS age, p.gender,
               (SELECT string_agg(o.name, ', ' ORDER BY o.name) FROM micro_organisms o WHERE o.id = ANY(x.organism_ids)) AS organisms
          FROM (SELECT h.*, h.onset_date::timestamptz AS at FROM ipc_hai_cases h) x JOIN patients p ON p.id = x.patient_id JOIN ipc_hai_types t ON t.code = x.hai_type
          LEFT JOIN departments d ON d.id = x.department_id
         WHERE x.status = 'confirmed' AND x.onset_date BETWEEN ${g.from}::date AND ${g.to}::date ${g.depts ? sql`AND x.department_id = ANY(${sql.val(g.depts)}::uuid[])` : sql``}
         ORDER BY x.onset_date, x.case_no LIMIT 20000`.execute(this.db)).rows;
      head = ['ნომერი', 'ინფექციის დღე', 'ჰოსპ. დღე', 'განყოფილება', 'ტიპი', 'SSI სიღრმე', 'მოწყობილობასთან', 'მოწყობილობა', 'მიკუთვნება', 'გაწერის შემდეგ', 'გამოსავალი', 'ასაკი', 'სქესი', 'მიკროორგანიზმი'];
      rows = r.map((x) => [x.case_no as string, x.onset as string, x.onset_day as number, x.department as string, x.hai_type as string, x.ssi_depth as string,
        x.device_assoc ? 'კი' : 'არა', x.device_kind as string, ATTR_KA[String(x.attribution)] ?? (x.attribution as string), x.post_discharge ? 'კი' : 'არა',
        OUTCOME_KA[String(x.outcome)] ?? (x.outcome as string), x.age as number, x.gender as string, x.organisms as string]);
      title = `HAI რეესტრი (დეპერსონალიზებული) ${g.from} — ${g.to}`;
    } else {
      const r = (await sql<Record<string, string | number | null>>`
        SELECT to_char(coalesce(x.specimen_at, x.detected_at) AT TIME ZONE ${TZ}, 'YYYY-MM-DD') AS day, x.mdro_code, t.name, x.onset, x.status, x.source,
               (SELECT dd.name FROM bed_assignments a JOIN departments dd ON dd.id = a.department_id WHERE a.encounter_id = x.encounter_id AND a.end_kind IS DISTINCT FROM 'cancel'
                 AND a.started_at <= x.detected_at ORDER BY a.started_at DESC LIMIT 1) AS department,
               o.name AS organism, ${age} AS age, p.gender
          FROM (SELECT f.*, f.detected_at AS at FROM ipc_patient_flags f) x JOIN patients p ON p.id = x.patient_id JOIN ipc_mdro_types t ON t.code = x.mdro_code
          LEFT JOIN micro_organisms o ON o.id = x.organism_id
         WHERE x.status IN ('active', 'cleared') AND (coalesce(x.specimen_at, x.detected_at) AT TIME ZONE ${TZ})::date BETWEEN ${g.from}::date AND ${g.to}::date
         ORDER BY 1 LIMIT 20000`.execute(this.db)).rows;
      const allow = g.depts;
      const rs = allow ? r.filter((x) => x.department !== null) : r;   // განყ. არე — მხოლოდ განყოფილებით მიბმული (სახელით ქვემოთ)
      const names = allow ? new Set((await this.db.selectFrom('departments').select('name').where('id', 'in', allow).execute()).map((x) => x.name)) : null;
      head = ['თარიღი', 'MDRO', 'დასახელება', 'შეძენა', 'სტატუსი', 'წყარო', 'განყოფილება', 'მიკროორგანიზმი', 'ასაკი', 'სქესი'];
      rows = rs.filter((x) => !names || names.has(String(x.department))).map((x) => [x.day, String(x.mdro_code).toUpperCase(), x.name, ONSET_KA[String(x.onset)] ?? x.onset,
        STATUS_KA[String(x.status)] ?? x.status, x.source, x.department, x.organism, x.age, x.gender]);
      title = `MDRO რეესტრი (დეპერსონალიზებული) ${g.from} — ${g.to}`;
    }
    await this.audit.log(auditCtx(req), { action: 'IPC_REGISTRY_EXPORT', entityName: 'ipc_reports', entityId: kind, newData: { format, from: g.from, to: g.to, rows: rows.length } });
    const base = `ipc_${kind}_registry_${g.from}_${g.to}`;
    if (format === 'csv') return { name: `${base}.csv`, type: 'text/csv; charset=utf-8', body: Buffer.from(toCsv(head, rows, title), 'utf8') };
    return { name: `${base}.xlsx`, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      body: writeXlsxBook([{ name: 'რეესტრი', rows: [[title], ['სახელის, პირადი ნომრის, ისტორიის ნომრის და თარიღ-დროის გარეშე (ასაკი — წლებში)'], [], head,
        ...rows.map((r) => r.map((x) => (typeof x === 'number' ? { v: x, fmt: '0' } : x)))], boldRows: [0, 3], widths: head.map((h) => Math.max(12, h.length + 2)) }]) };
  }
}

@Controller('ipc/reports')
export class IpcReportsController {
  constructor(private readonly s: IpcReportsService) {}
  @Get('summary') @Roles(...IPC_AGG) summary(@CurrentUser() u: AuthUser, @Query() q: Q) { return this.s.summary(u, q); }
  @Get('export') @Roles(...IPC_AGG)
  async export(@CurrentUser() u: AuthUser, @Query() q: Q, @Req() r: Request, @Res({ passthrough: true }) res: Response) {
    const out = await this.s.export(u, q, r);
    res.set({ 'Content-Type': out.type, 'Content-Disposition': `attachment; filename="${encodeURIComponent(out.name)}"` });
    return new StreamableFile(out.body);
  }
  @Get('registry') @Roles(...IPC_FULL)
  async registry(@CurrentUser() u: AuthUser, @Query() q: Q, @Req() r: Request, @Res({ passthrough: true }) res: Response) {
    const out = await this.s.registry(u, q, r);
    res.set({ 'Content-Type': out.type, 'Content-Disposition': `attachment; filename="${encodeURIComponent(out.name)}"` });
    return new StreamableFile(out.body);
  }
}
