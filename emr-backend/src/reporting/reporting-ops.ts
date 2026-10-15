import { BadRequestException, Controller, ForbiddenException, Get, Injectable, Query, Req, Res, StreamableFile } from '@nestjs/common';
import type { Request, Response } from 'express';
import { sql } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/roles';
import { writeXlsx, type Cell } from '../claims-export/xlsx';
import { toCsv } from '../finance/finance-common';
import { DATE_RE, daysBetween, n, r1, r2, RPT_READ, RptCommon, type RptScope, type RptSettings, UUID_RE } from './reporting-common';
import { histPercentile } from './reporting-kpi';

/**
 * ოპერაციული დაფები (0062) — მხოლოდ rpt_* ფაქტებიდან:
 *  ნაკადი (დღიური ტიპებით + სითბური რუკა კვირის დღე × საათი), საწოლები განყოფილებებით, საოპერაციო (ოთახები / განყოფილებები),
 *  კვლევები (აპარატი / ანალიზატორი / ჯგუფი / მოდალობა), მარაგი (ლოკაციები, ყველაზე ხარჯვადი, მოძრაობის გარეშე), ექიმები (doctor_breakdown, min_cases).
 */
type Q = Record<string, string | undefined>;
const WD_KA = ['ორშ', 'სამ', 'ოთხ', 'ხუთ', 'პარ', 'შაბ', 'კვი'];
const SUB_KA: Record<string, string> = { outpatient: 'ამბულატორია', lab: 'ლაბორატორია', emergency: 'გადაუდებელი', inpatient: 'სტაციონარი' };
const ROLE_KA: Record<string, string> = { surgeon: 'ქირურგი', attending: 'მკურნალი ექიმი', validator: 'ვალიდატორი / რადიოლოგი' };
const DOC_COL_KA: Record<string, string> = { doctor_name: 'ექიმი', scheduled: 'დაგეგმილი', done: 'დასრულებული', cancelled: 'გაუქმებული', cancel_pct: 'გაუქმება %',
  first_on_time_pct: 'პირველი დროული %', surgery_min_avg: 'საშ. ხანგრძლივობა წთ', admissions: 'მიღება', discharges: 'გაწერა', deaths: 'გარდაცვალება', alos: 'ALOS',
  mortality_pct: 'ლეტალობა %', readmit30_pct: 'განმეორებითი 30 დღე %', resulted: 'შესრულებული', tat_median_min: 'TAT მედიანა წთ', tat_avg_min: 'TAT საშ. წთ' };
const pct = (a: number, b: number) => (b > 0 ? r1((a / b) * 100) : null);

/** ექიმის ჭრილის წვდომა (doctor_breakdown) — 0062; 0063-ში ექიმის შემოსავალიც */
export function doctorAccess(s: RptSettings, scope: RptScope) {
  if (s.doctor_breakdown === 'off') throw new ForbiddenException({ code: 'DOCTOR_BREAKDOWN_OFF', message: 'ექიმის ჭრილი გამორთულია (მოდულები → მენეჯერული რეპორტინგი → doctor_breakdown)' });
  if (s.doctor_breakdown === 'all_only' && !scope.all) throw new ForbiddenException({ code: 'DOCTOR_BREAKDOWN_ALL_ONLY', message: 'ექიმის ჭრილი ჩანს მხოლოდ კლინიკის ხედვით (reports_all / ხელმძღვანელობა)' });
}

@Injectable()
export class ReportingOpsService {
  constructor(private readonly c: RptCommon, private readonly audit: AuditService) {}
  private get rdb() { return this.c.rdb; }

  private period(q: Q) {
    if (!q.from || !q.to || !DATE_RE.test(q.from) || !DATE_RE.test(q.to) || q.from > q.to) throw new BadRequestException('პერიოდი: from ≤ to (YYYY-MM-DD)');
    if (daysBetween(q.from, q.to) > 3 * 366) throw new BadRequestException('პერიოდი — მაქსიმუმ 3 წელი');
    return { from: q.from, to: q.to };
  }
  private async ctx(u: AuthUser, q: Q) {
    const s = await this.c.settings();
    const scope = this.c.narrow(await this.c.scope(u), q.department_id);
    return { s, scope, ...this.period(q) };
  }
  private where(scope: RptScope, col: string) { return scope.all ? sql`TRUE` : sql`${sql.ref(col)} = ANY(${scope.depts}::uuid[])`; }
  private range(from: string, to: string, col = 'f.day') { return sql`${sql.ref(col)} BETWEEN ${from}::date AND ${to}::date`; }

  // ------------------------------------------------------------------------------------ ნაკადი
  async flow(u: AuthUser, q: Q) {
    const { scope, from, to } = await this.ctx(u, q);
    const rows = (await sql<{ day: string; sub: string; n: number }>`
      SELECT to_char(f.day, 'YYYY-MM-DD') AS day,
             CASE WHEN f.enc_type = 'emergency' THEN 'emergency' WHEN f.enc_type = 'inpatient' THEN 'inpatient' WHEN f.visit_kind = 'lab' THEN 'lab' ELSE 'outpatient' END AS sub,
             sum(f.encounters)::int AS n
        FROM rpt_fact_flow f WHERE ${this.range(from, to)} AND ${this.where(scope, 'f.department_id')} GROUP BY 1, 2 ORDER BY 1`.execute(this.rdb)).rows;
    const days: string[] = []; for (let d = from; d <= to; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) days.push(d);
    const subs = Object.keys(SUB_KA);
    const series = subs.map((s) => ({ sub: s, name: SUB_KA[s], values: days.map((d) => rows.find((r) => r.day === d && r.sub === s)?.n ?? 0) }));
    return { from, to, days, series, totals: Object.fromEntries(series.map((s) => [s.sub, s.values.reduce((a, b) => a + b, 0)])) };
  }

  async heatmap(u: AuthUser, q: Q) {
    const { scope, from, to } = await this.ctx(u, q);
    const layer = q.layer ?? 'visit';
    if (!['visit', 'admission', 'lab_collect'].includes(layer)) throw new BadRequestException('layer: visit / admission / lab_collect');
    if (q.sub && !SUB_KA[q.sub]) throw new BadRequestException('sub: outpatient / lab / emergency / inpatient');
    const rows = (await sql<{ dow: number; hour: number; n: number }>`
      SELECT extract(isodow FROM f.day)::int AS dow, f.hour::int AS hour, sum(f.n)::int AS n
        FROM rpt_fact_hourly f
       WHERE ${this.range(from, to)} AND f.layer = ${layer} AND (${q.sub ?? null}::text IS NULL OR f.sub = ${q.sub ?? null}) AND ${this.where(scope, 'f.department_id')}
       GROUP BY 1, 2`.execute(this.rdb)).rows;
    // რამდენჯერ გვხვდება თითო კვირის დღე პერიოდში (საშუალოსთვის)
    const occ = Array(7).fill(0);
    for (let d = from; d <= to; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) occ[(new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7] += 1;
    const total = Array.from({ length: 7 }, () => Array(24).fill(0));
    for (const r of rows) total[r.dow - 1][r.hour] += r.n;
    const avg = total.map((row, i) => row.map((v) => (occ[i] ? Math.round((v / occ[i]) * 100) / 100 : 0)));
    let peak = { dow: 0, hour: 0, value: 0 };
    avg.forEach((row, i) => row.forEach((v, h) => { if (v > peak.value) peak = { dow: i, hour: h, value: v }; }));
    return { from, to, layer, sub: q.sub ?? null, weekdays: WD_KA, occurrences: occ, avg, total, sum: rows.reduce((a, r) => a + r.n, 0),
      peak: peak.value ? { weekday: WD_KA[peak.dow], hour: peak.hour, value: peak.value } : null };
  }

  // ------------------------------------------------------------------------------------ საწოლები
  async beds(u: AuthUser, q: Q) {
    const { s, scope, from, to } = await this.ctx(u, q);
    const rows = (await sql<{ department_id: string; department_name: string; ah: string; oh: string; census: number; adm: number; dis: number; deaths: number; los: number; tin: number; tout: number; re: number }>`
      SELECT f.department_id, d.name AS department_name, sum(f.available_hours)::text AS ah, sum(f.occupied_hours)::text AS oh, sum(f.midnight_census)::int AS census,
             sum(f.admissions)::int AS adm, sum(f.discharges)::int AS dis, sum(f.deaths)::int AS deaths, sum(f.los_days_sum)::int AS los,
             sum(f.transfers_in)::int AS tin, sum(f.transfers_out)::int AS tout, sum(f.readmissions_30)::int AS re
        FROM rpt_fact_beds f JOIN departments d ON d.id = f.department_id
       WHERE ${this.range(from, to)} AND ${this.where(scope, 'f.department_id')} GROUP BY 1, 2 ORDER BY 2`.execute(this.rdb)).rows;
    const daily = (await sql<{ department_id: string; day: string; ah: string; oh: string; census: number }>`
      SELECT f.department_id, to_char(f.day, 'YYYY-MM-DD') AS day, f.available_hours::text AS ah, f.occupied_hours::text AS oh, f.midnight_census AS census
        FROM rpt_fact_beds f WHERE ${this.range(from, to)} AND ${this.where(scope, 'f.department_id')} ORDER BY f.day`.execute(this.rdb)).rows;
    const days = daysBetween(from, to);
    const occ = (ah: number, oh: number, census: number, nd: number) => (s.occupancy_basis === 'midnight' ? (ah > 0 ? r1((census / nd) / (ah / 24 / nd) * 100) : null) : pct(oh, ah));
    return { from, to, basis: s.occupancy_basis, rows: rows.filter((r) => n(r.ah) > 0 || n(r.oh) > 0 || r.adm || r.dis).map((r) => ({
      department_id: r.department_id, department_name: r.department_name, beds_avg: r1(n(r.ah) / 24 / days), occupancy_pct: occ(n(r.ah), n(r.oh), r.census, days),
      census_avg: r1(r.census / days), admissions: r.adm, discharges: r.dis, deaths: r.deaths, alos: r.dis ? r1(r.los / r.dis) : null, transfers_in: r.tin, transfers_out: r.tout,
      readmit30_pct: pct(r.re, r.adm),
      daily: daily.filter((x) => x.department_id === r.department_id).map((x) => ({ day: x.day, occupancy_pct: occ(n(x.ah), n(x.oh), x.census, 1) })) })) };
  }

  // ------------------------------------------------------------------------------------ საოპერაციო
  async or(u: AuthUser, q: Q) {
    const { scope, from, to } = await this.ctx(u, q);
    const rooms = (await sql<{ room_id: string; code: string; name: string; block: string; avail: number; used: number; cases: number }>`
      SELECT f.room_id, r.code, r.name, d.name AS block, sum(f.avail_min)::int AS avail, sum(f.used_min)::int AS used, sum(f.cases)::int AS cases
        FROM rpt_fact_or_room f JOIN or_rooms r ON r.id = f.room_id JOIN departments d ON d.id = f.department_id
       WHERE ${this.range(from, to)} AND ${this.where(scope, 'f.department_id')} GROUP BY 1, 2, 3, 4 ORDER BY 4, 2`.execute(this.rdb)).rows;
    const depts = (await sql<{ department_id: string; department_name: string; sch: number; done: number; emg: number; canc: number; sc: number; sm: number; fc: number; fo: number }>`
      SELECT f.department_id, d.name AS department_name, sum(f.scheduled)::int AS sch, sum(f.done)::int AS done, sum(f.emergency)::int AS emg, sum(f.cancelled)::int AS canc,
             sum(f.surgery_cases)::int AS sc, sum(f.surgery_min)::int AS sm, sum(f.first_cases)::int AS fc, sum(f.first_on_time)::int AS fo
        FROM rpt_fact_or f JOIN departments d ON d.id = f.department_id
       WHERE ${this.range(from, to)} AND ${this.where(scope, 'f.department_id')} GROUP BY 1, 2 ORDER BY sum(f.done) DESC`.execute(this.rdb)).rows;
    const daily = (await sql<{ day: string; done: number; canc: number }>`
      SELECT to_char(f.day, 'YYYY-MM-DD') AS day, sum(f.done)::int AS done, sum(f.cancelled)::int AS canc FROM rpt_fact_or f
       WHERE ${this.range(from, to)} AND ${this.where(scope, 'f.department_id')} GROUP BY 1 ORDER BY 1`.execute(this.rdb)).rows;
    return { from, to,
      rooms: rooms.map((r) => ({ ...r, utilization_pct: pct(r.used, r.avail) })),
      departments: depts.map((d) => ({ department_id: d.department_id, department_name: d.department_name, scheduled: d.sch, done: d.done, cancelled: d.canc,
        cancel_pct: pct(d.canc, d.sch), emergency_pct: pct(d.emg, d.done), first_on_time_pct: pct(d.fo, d.fc), surgery_min_avg: d.sc ? r1(d.sm / d.sc) : null })),
      daily };
  }

  // ------------------------------------------------------------------------------------ კვლევები
  async dx(u: AuthUser, q: Q) {
    const { scope, from, to } = await this.ctx(u, q);
    const section = q.section ?? 'lab';
    if (!['lab', 'imaging', 'radiology', 'endoscopy'].includes(section)) throw new BadRequestException('section: lab / imaging / radiology / endoscopy');
    const by = q.by ?? (section === 'lab' ? 'device' : 'device');
    if (!['device', 'group', 'modality'].includes(by)) throw new BadRequestException('by: device / group / modality');
    const sec = section === 'imaging' ? sql`f.section <> 'lab'` : sql`f.section = ${section}`;
    const key = by === 'device' ? sql`f.device_key` : by === 'group' ? sql`f.group_name` : sql`f.modality`;
    const rows = (await sql<{ key: string; ordered: number; cancelled: number; external: number; resulted: number; tat_sum: string; hist: number[] }>`
      SELECT ${key} AS key, sum(f.ordered)::int AS ordered, sum(f.cancelled)::int AS cancelled, sum(f.external)::int AS external, sum(f.resulted)::int AS resulted,
             sum(f.tat_sum_min)::text AS tat_sum,
             ARRAY[sum(f.tat_hist[1]), sum(f.tat_hist[2]), sum(f.tat_hist[3]), sum(f.tat_hist[4]), sum(f.tat_hist[5]), sum(f.tat_hist[6]),
                   sum(f.tat_hist[7]), sum(f.tat_hist[8]), sum(f.tat_hist[9]), sum(f.tat_hist[10]), sum(f.tat_hist[11]), sum(f.tat_hist[12])]::int[] AS hist
        FROM rpt_fact_dx_dim f WHERE ${this.range(from, to)} AND ${sec} AND ${this.where(scope, 'f.department_id')} GROUP BY 1`.execute(this.rdb)).rows;
    const ids = rows.map((r) => r.key).filter((k) => UUID_RE.test(k));
    const names = new Map<string, string>();
    if (ids.length && by === 'device') {
      for (const d of await this.rdb.selectFrom('dx_devices').select(['id', 'name']).where('id', 'in', ids).execute()) names.set(d.id, d.name);
      for (const d of await this.rdb.selectFrom('lab_instruments as i').innerJoin('lab_methods as m', 'm.id', 'i.method_id').select(['i.id', 'm.name']).where('i.id', 'in', ids).execute()) names.set(d.id, d.name);
    }
    const label = (k: string) => (k === 'manual' ? 'ხელით (ანალიზატორის გარეშე)' : k === '' ? (by === 'device' && section === 'lab' ? 'ანალიზატორი არ არის (გარე ლაბ. / შედეგი ჯერ არ არის)' : 'მიუთითებელი') : names.get(k) ?? k);
    const toMin = section === 'lab' ? 1 : 60;   // ლაბ. — წუთი, ინსტრუმენტული — საათი
    return { from, to, section, by, unit: section === 'lab' ? 'min' : 'hours',
      rows: rows.map((r) => {
        const h = (r.hist ?? []).map(Number);
        const p50 = histPercentile(h, 0.5); const p90 = histPercentile(h, 0.9);
        return { key: r.key, label: label(r.key), ordered: r.ordered, cancelled: r.cancelled, external: r.external, external_pct: pct(r.external, r.ordered), resulted: r.resulted,
          tat_median: p50 === null ? null : r1(p50 / toMin), tat_p90: p90 === null ? null : r1(p90 / toMin), tat_avg: r.resulted ? r1(n(r.tat_sum) / r.resulted / toMin) : null };
      }).sort((a, b) => b.ordered + b.resulted - (a.ordered + a.resulted)) };
  }

  // ------------------------------------------------------------------------------------ მარაგი
  async stock(u: AuthUser, q: Q) {
    const { s, scope, from, to } = await this.ctx(u, q);
    const locs = (await sql<{ location_id: string; location_name: string; department_name: string | null; consumption: string; loss: string; receipts: string }>`
      SELECT f.location_id, l.name AS location_name, d.name AS department_name, sum(f.consumption)::text AS consumption, sum(f.loss)::text AS loss, sum(f.receipts)::text AS receipts
        FROM rpt_fact_stock f JOIN stock_locations l ON l.id = f.location_id LEFT JOIN departments d ON d.id = f.department_id
       WHERE ${this.range(from, to)} AND ${this.where(scope, 'f.department_id')} GROUP BY 1, 2, 3 ORDER BY sum(f.consumption) DESC`.execute(this.rdb)).rows;
    const daily = (await sql<{ day: string; v: string }>`
      SELECT to_char(f.day, 'YYYY-MM-DD') AS day, sum(f.consumption)::text AS v FROM rpt_fact_stock f
       WHERE ${this.range(from, to)} AND ${this.where(scope, 'f.department_id')} GROUP BY 1 ORDER BY 1`.execute(this.rdb)).rows;
    const snapW = this.where(scope, 'f.department_id');
    const top = (await sql<{ item_name: string; item_code: string; unit: string; location_name: string; used: string; qty: string; days: string | null; value: string }>`
      SELECT i.name AS item_name, i.code AS item_code, i.base_unit AS unit, l.name AS location_name, f.used_qty_window::text AS used, f.qty::text AS qty, f.days_of_supply::text AS days,
             f.value::text AS value
        FROM rpt_stock_snapshot f JOIN stock_items i ON i.id = f.item_id JOIN stock_locations l ON l.id = f.location_id
       WHERE f.used_qty_window > 0 AND ${snapW} ORDER BY f.used_qty_window * (CASE WHEN f.qty > 0 THEN f.value / f.qty ELSE 0 END) DESC, f.used_qty_window DESC LIMIT 20`.execute(this.rdb)).rows;
    const dead = (await sql<{ item_name: string; item_code: string; location_name: string; qty: string; value: string; last_move_at: Date | null }>`
      SELECT i.name AS item_name, i.code AS item_code, l.name AS location_name, f.qty::text AS qty, f.value::text AS value, f.last_move_at
        FROM rpt_stock_snapshot f JOIN stock_items i ON i.id = f.item_id JOIN stock_locations l ON l.id = f.location_id
       WHERE f.qty > 0 AND (f.last_move_at IS NULL OR f.last_move_at < now() - make_interval(days => ${s.dead_stock_days})) AND ${snapW}
       ORDER BY f.value DESC LIMIT 20`.execute(this.rdb)).rows;
    return { from, to, window_days: s.stock_days_window, dead_stock_days: s.dead_stock_days,
      locations: locs.map((l) => ({ ...l, consumption: r2(n(l.consumption)), loss: r2(n(l.loss)), receipts: r2(n(l.receipts)) })),
      daily: daily.map((d) => ({ day: d.day, consumption: r2(n(d.v)) })),
      top_items: top.map((t) => ({ ...t, used: n(t.used), qty: n(t.qty), days: t.days === null ? null : n(t.days), value: r2(n(t.value)) })),
      dead_stock: dead.map((d) => ({ ...d, qty: n(d.qty), value: r2(n(d.value)) })) };
  }

  // ------------------------------------------------------------------------------------ ექიმები
  async doctors(u: AuthUser, q: Q, req: Request, audit = true) {
    const s = await this.c.settings();
    const base = await this.c.scope(u);
    doctorAccess(s, base);
    const scope = this.c.narrow(base, q.department_id);
    const { from, to } = this.period(q);
    const role = q.role ?? 'surgeon';
    if (!ROLE_KA[role]) throw new BadRequestException('role: surgeon / attending / validator');
    const rows = (await sql<{ doctor_id: string; doctor_name: string; sch: number; done: number; canc: number; sc: number; sm: number; fc: number; fo: number;
      adm: number; dis: number; deaths: number; los: number; re: number; res: number; tsum: string; hist: number[] }>`
      SELECT f.doctor_id, u.last_name || ' ' || u.first_name AS doctor_name,
             sum(f.or_scheduled)::int AS sch, sum(f.or_done)::int AS done, sum(f.or_cancelled)::int AS canc, sum(f.or_surgery_cases)::int AS sc, sum(f.or_surgery_min)::int AS sm,
             sum(f.or_first_cases)::int AS fc, sum(f.or_first_on_time)::int AS fo,
             sum(f.admissions)::int AS adm, sum(f.discharges)::int AS dis, sum(f.deaths)::int AS deaths, sum(f.los_days_sum)::int AS los, sum(f.readmissions_30)::int AS re,
             sum(f.dx_resulted)::int AS res, sum(f.dx_tat_sum_min)::text AS tsum,
             ARRAY[sum(f.dx_tat_hist[1]), sum(f.dx_tat_hist[2]), sum(f.dx_tat_hist[3]), sum(f.dx_tat_hist[4]), sum(f.dx_tat_hist[5]), sum(f.dx_tat_hist[6]),
                   sum(f.dx_tat_hist[7]), sum(f.dx_tat_hist[8]), sum(f.dx_tat_hist[9]), sum(f.dx_tat_hist[10]), sum(f.dx_tat_hist[11]), sum(f.dx_tat_hist[12])]::int[] AS hist
        FROM rpt_fact_doctor f JOIN users u ON u.id = f.doctor_id
       WHERE ${this.range(from, to)} AND f.role = ${role} AND ${this.where(scope, 'f.department_id')} GROUP BY 1, 2`.execute(this.rdb)).rows;
    const m = s.min_cases;
    // მცირე ნიმუში: მნიშვნელი < min_cases → % / საშუალო — null (small: true)
    const guard = (num: number | null, denom: number) => (denom < m ? null : num);
    const out = rows.map((r) => {
      if (role === 'surgeon') return { doctor_id: r.doctor_id, doctor_name: r.doctor_name, cases: r.done, small: r.done < m,
        scheduled: r.sch, done: r.done, cancelled: r.canc, cancel_pct: guard(pct(r.canc, r.sch), r.sch), first_on_time_pct: guard(pct(r.fo, r.fc), r.fc),
        surgery_min_avg: guard(r.sc ? r1(r.sm / r.sc) : null, r.sc) };
      if (role === 'attending') return { doctor_id: r.doctor_id, doctor_name: r.doctor_name, cases: r.adm + r.dis, small: r.dis < m,
        admissions: r.adm, discharges: r.dis, deaths: r.deaths, alos: guard(r.dis ? r1(r.los / r.dis) : null, r.dis), mortality_pct: guard(pct(r.deaths, r.dis), r.dis),
        readmit30_pct: guard(pct(r.re, r.adm), r.adm) };
      const h = (r.hist ?? []).map(Number); const p50 = histPercentile(h, 0.5);
      return { doctor_id: r.doctor_id, doctor_name: r.doctor_name, cases: r.res, small: r.res < m, resulted: r.res,
        tat_median_min: guard(p50, r.res), tat_avg_min: guard(r.res ? r1(n(r.tsum) / r.res) : null, r.res) };
    }).filter((r) => r.cases > 0).sort((a, b) => b.cases - a.cases);
    if (audit) await this.audit.log(auditCtx(req), { action: 'REPORT_DOCTORS', entityName: 'rpt_fact_doctor', entityId: role,
      newData: { from, to, department_id: q.department_id ?? null, rows: out.length } });
    return { from, to, role, role_ka: ROLE_KA[role], min_cases: m, mode: s.doctor_breakdown, rows: out };
  }

  // ------------------------------------------------------------------------------------ ექსპორტი
  async export(u: AuthUser, q: Q, req: Request) {
    const format = q.format ?? 'xlsx';
    if (!['xlsx', 'csv'].includes(format)) throw new BadRequestException('format: xlsx / csv');
    const ds = q.dataset ?? '';
    let header: string[] = []; let rows: Cell[][] = []; let title = '';
    if (ds === 'beds') {
      const o = await this.beds(u, q); title = `საწოლები ${o.from} — ${o.to}`;
      header = ['განყოფილება', 'საწოლი (საშ.)', 'დატვირთვა %', 'შუაღამე (საშ.)', 'მიღება', 'გაწერა', 'გარდაცვალება', 'ALOS', 'შემოსული', 'გასული', 'განმეორებითი 30 დღე %'];
      rows = o.rows.map((r) => [r.department_name, r.beds_avg, r.occupancy_pct, r.census_avg, r.admissions, r.discharges, r.deaths, r.alos, r.transfers_in, r.transfers_out, r.readmit30_pct]);
    } else if (ds === 'or_rooms') {
      const o = await this.or(u, q); title = `საოპერაციო ოთახები ${o.from} — ${o.to}`;
      header = ['ბლოკი', 'ოთახი', 'დასახელება', 'ოპერაციები', 'სამუშაო წთ', 'გამოყენებული წთ', 'დატვირთვა %'];
      rows = o.rooms.map((r) => [r.block, r.code, r.name, r.cases, r.avail, r.used, r.utilization_pct]);
    } else if (ds === 'or_departments') {
      const o = await this.or(u, q); title = `საოპერაციო განყოფილებებით ${o.from} — ${o.to}`;
      header = ['განყოფილება', 'დაგეგმილი', 'დასრულებული', 'გაუქმებული', 'გაუქმება %', 'გადაუდებელი %', 'პირველი დროული %', 'საშ. ხანგრძლივობა წთ'];
      rows = o.departments.map((r) => [r.department_name, r.scheduled, r.done, r.cancelled, r.cancel_pct, r.emergency_pct, r.first_on_time_pct, r.surgery_min_avg]);
    } else if (ds === 'dx') {
      const o = await this.dx(u, q); const un = o.unit === 'min' ? 'წთ' : 'სთ'; title = `კვლევები (${o.section}, ${o.by}) ${o.from} — ${o.to}`;
      header = ['ჭრილი', 'დანიშნული', 'გაუქმებული', 'გარე', 'გარე %', 'შესრულებული', `TAT მედიანა (${un})`, `TAT P90 (${un})`, `TAT საშ. (${un})`];
      rows = o.rows.map((r) => [r.label, r.ordered, r.cancelled, r.external, r.external_pct, r.resulted, r.tat_median, r.tat_p90, r.tat_avg]);
    } else if (ds === 'heatmap') {
      const o = await this.heatmap(u, q); title = `საათობრივი ნაკადი (${o.layer}, საშუალო) ${o.from} — ${o.to}`;
      header = ['დღე', ...Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'))];
      rows = o.avg.map((r, i) => [o.weekdays[i], ...r]);
    } else if (ds === 'doctors') {
      const o = await this.doctors(u, q, req, false); title = `${o.role_ka} ${o.from} — ${o.to} (მინ. ${o.min_cases} შემთხვევა)`;
      const cols = Object.keys(o.rows[0] ?? {}).filter((k) => !['doctor_id', 'small', 'cases'].includes(k));
      header = cols.map((c) => DOC_COL_KA[c] ?? c); rows = o.rows.map((r) => cols.map((c) => (r as unknown as Record<string, Cell>)[c]));
    } else throw new BadRequestException('dataset: beds / or_rooms / or_departments / dx / heatmap / doctors');
    await this.audit.log(auditCtx(req), { action: 'REPORT_EXPORT', entityName: 'rpt_reports', entityId: `ops_${ds}`,
      newData: { format, from: q.from ?? null, to: q.to ?? null, department_id: q.department_id ?? null, rows: rows.length, phi: false } });
    const base = `rpt_ops_${ds}_${q.from}_${q.to}`;
    if (format === 'csv') return { name: `${base}.csv`, type: 'text/csv; charset=utf-8', body: Buffer.from(toCsv(header, rows.map((r) => r.map((c) => (typeof c === 'object' && c !== null ? c.v : c))), title), 'utf8') };
    return { name: `${base}.xlsx`, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      body: writeXlsx({ name: ds.slice(0, 31), header, rows: rows.map((r) => r.map((c) => (typeof c === 'number' ? { v: c, fmt: Number.isInteger(c) ? '0' : '0.0' } : c))),
        widths: header.map((h, i) => Math.min(50, Math.max(8, h.length + 2, ...rows.slice(0, 100).map((r) => String((r[i] as string | number | null) ?? '').length + 2)))) }) };
  }
}

@Controller('reporting/ops')
export class ReportingOpsController {
  constructor(private readonly s: ReportingOpsService) {}
  @Get('flow') @Roles(...RPT_READ) flow(@Query() q: Q, @CurrentUser() u: AuthUser) { return this.s.flow(u, q); }
  @Get('heatmap') @Roles(...RPT_READ) heatmap(@Query() q: Q, @CurrentUser() u: AuthUser) { return this.s.heatmap(u, q); }
  @Get('beds') @Roles(...RPT_READ) beds(@Query() q: Q, @CurrentUser() u: AuthUser) { return this.s.beds(u, q); }
  @Get('or') @Roles(...RPT_READ) or(@Query() q: Q, @CurrentUser() u: AuthUser) { return this.s.or(u, q); }
  @Get('dx') @Roles(...RPT_READ) dx(@Query() q: Q, @CurrentUser() u: AuthUser) { return this.s.dx(u, q); }
  @Get('stock') @Roles(...RPT_READ) stock(@Query() q: Q, @CurrentUser() u: AuthUser) { return this.s.stock(u, q); }
  @Get('doctors') @Roles(...RPT_READ) doctors(@Query() q: Q, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.doctors(u, q, r); }
  @Get('export') @Roles(...RPT_READ)
  async export(@Query() q: Q, @CurrentUser() u: AuthUser, @Req() r: Request, @Res({ passthrough: true }) res: Response) {
    const out = await this.s.export(u, q, r);
    res.set({ 'Content-Type': out.type, 'Content-Disposition': `attachment; filename="${encodeURIComponent(out.name)}"` });
    return new StreamableFile(out.body);
  }
}
