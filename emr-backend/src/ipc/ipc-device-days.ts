import { BadRequestException, Body, Controller, Get, HttpCode, Injectable, Logger, Post, Query, Req } from '@nestjs/common';
import { Matches } from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/roles';
import { loadEnv } from '../config/env';
import { IPC_ANY, IPC_FULL, IpcCommon, ipcRules, type IpcRules } from './ipc-common';

const TZ = loadEnv().CLINIC_TZ;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
class RangeDto { @Matches(DATE) from: string; @Matches(DATE) to: string }

/**
 * device-days (0068): rpt_fact_ipc_daily — დღე × განყოფილება: პაციენტ-დღე, ცენტრალური ხაზი (central_line_kinds), შარდის კათეტერი, ინვაზიური ვენტილაცია.
 *  • calendar_day — ითვლება, თუ დღის განმავლობაში ერთხელ მაინც იყო (პაციენტი / მოწყობილობა); განყოფილება — ამ დღის ბოლო ეპიზოდი;
 *  • census — ფიქსირებულ საათზე (census_hour) იმ წუთას.
 * worker: ბოლო 7 დღე — ყოველ საათში; ცარიელ ცხრილზე — მთელი ისტორია (პირველი ჰოსპიტალიზაციიდან). ხელით — „გადათვლა“ (infection).
 */
@Injectable()
export class IpcDeviceDaysService {
  private readonly log = new Logger('IPC-device-days');
  constructor(private readonly c: IpcCommon, private readonly audit: AuditService) {}
  private get db() { return this.c.db; }

  async refresh(from: string, to: string, r?: IpcRules | null) {
    const rules = r ?? await ipcRules(this.db);
    if (!rules) return { days: 0, rows: 0 };
    const census = rules.device_days_basis === 'census';
    const cl = rules.central_line_kinds;
    // [s, e) — დღის ფანჯარა (calendar_day) ან წერტილი (census: s = e = დღე + census_hour)
    const win = census
      ? sql`(dd.day::timestamp + make_interval(hours => ${rules.census_hour})) AT TIME ZONE ${TZ}`
      : sql`(dd.day::timestamp) AT TIME ZONE ${TZ}`;
    const winEnd = census ? win : sql`((dd.day + 1)::timestamp) AT TIME ZONE ${TZ}`;
    const overlap = (start: ReturnType<typeof sql.ref>, end: ReturnType<typeof sql.ref>) => census
      ? sql`${start} <= w.s AND (${end} IS NULL OR ${end} > w.s)`
      : sql`${start} < w.e AND coalesce(${end}, now()) >= w.s`;
    const res = await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('rpt_fact_ipc_daily').where('day', '>=', from).where('day', '<=', to).execute();
      const ins = await sql<{ n: number }>`
        WITH dd AS (SELECT d::date AS day FROM generate_series(${from}::date, least(${to}::date, (now() AT TIME ZONE ${TZ})::date), interval '1 day') d),
        w AS (SELECT dd.day, ${win} AS s, ${winEnd} AS e FROM dd),
        pts AS (
          SELECT DISTINCT ON (a.encounter_id, w.day) a.encounter_id, w.day, w.s, w.e, a.department_id
            FROM w JOIN bed_assignments a ON ${overlap(sql.ref('a.started_at'), sql.ref('a.ended_at'))}
            JOIN inpatient_stays st ON st.encounter_id = a.encounter_id AND st.status <> 'cancelled'
           WHERE w.s <= now()
           ORDER BY a.encounter_id, w.day, a.started_at DESC),
        dev AS (
          SELECT p.day, p.department_id,
                 EXISTS (SELECT 1 FROM lines_drains ld, LATERAL (SELECT p.s, p.e) w WHERE ld.encounter_id = p.encounter_id AND ld.voided_at IS NULL
                          AND ld.kind = ANY(${sql.val(cl)}::text[]) AND ${overlap(sql.ref('ld.inserted_at'), sql.ref('ld.removed_at'))}) AS cl,
                 EXISTS (SELECT 1 FROM lines_drains ld, LATERAL (SELECT p.s, p.e) w WHERE ld.encounter_id = p.encounter_id AND ld.voided_at IS NULL
                          AND ld.kind = 'urinary' AND ${overlap(sql.ref('ld.inserted_at'), sql.ref('ld.removed_at'))}) AS uc,
                 EXISTS (SELECT 1 FROM icu_ventilation iv, LATERAL (SELECT p.s, p.e) w WHERE iv.encounter_id = p.encounter_id AND iv.voided_at IS NULL
                          AND iv.kind = 'invasive' AND ${overlap(sql.ref('iv.started_at'), sql.ref('iv.ended_at'))}) AS vent
            FROM pts p)
        INSERT INTO rpt_fact_ipc_daily (day, department_id, patient_days, central_line_days, urinary_days, vent_days)
        SELECT day, department_id, count(*)::int, count(*) FILTER (WHERE cl)::int, count(*) FILTER (WHERE uc)::int, count(*) FILTER (WHERE vent)::int
          FROM dev GROUP BY day, department_id
        RETURNING 1 AS n`.execute(trx);
      return ins.rows.length;
    });
    return { days: Number((await sql<{ n: number }>`SELECT (${to}::date - ${from}::date + 1)::int AS n`.execute(this.db)).rows[0].n), rows: res };
  }

  /** worker: ცარიელზე — მთელი ისტორია; შემდეგ — ბოლო 7 დღე */
  async tick() {
    const r = await ipcRules(this.db);
    if (!r) return { days: 0, rows: 0 };
    const any = await this.db.selectFrom('rpt_fact_ipc_daily').select('day').limit(1).executeTakeFirst();
    const today = (await sql<{ d: string }>`SELECT to_char((now() AT TIME ZONE ${TZ})::date, 'YYYY-MM-DD') AS d`.execute(this.db)).rows[0].d;
    let from = (await sql<{ d: string }>`SELECT to_char((now() AT TIME ZONE ${TZ})::date - 7, 'YYYY-MM-DD') AS d`.execute(this.db)).rows[0].d;
    if (!any) {
      const first = await sql<{ d: string | null }>`SELECT to_char(min((admitted_at AT TIME ZONE ${TZ})::date), 'YYYY-MM-DD') AS d FROM inpatient_stays`.execute(this.db);
      if (first.rows[0].d) from = first.rows[0].d;
    }
    return this.refresh(from, today, r);
  }

  async manual(d: RangeDto, req: Request) {
    const r = await this.c.rules();
    if (d.from > d.to) throw new BadRequestException({ code: 'RANGE', message: 'from > to' });
    const span = Number((await sql<{ n: number }>`SELECT (${d.to}::date - ${d.from}::date)::int AS n`.execute(this.db)).rows[0].n);
    if (span > 800) throw new BadRequestException({ code: 'RANGE', message: 'მაქსიმუმ 800 დღე ერთად' });
    const res = await this.refresh(d.from, d.to, r);
    await this.audit.log(auditCtx(req), { action: 'IPC_DEVICE_DAYS_REFRESH', entityName: 'rpt_fact_ipc_daily', entityId: `${d.from}..${d.to}`, newData: res });
    return res;
  }

  /**
   * მაჩვენებლები პერიოდში (განყოფილებებით + ჯამი): პაციენტ-დღე, device-days, გამოყენების კოეფიციენტი (DUR = device-days / პაციენტ-დღე),
   * დადასტურებული CLABSI / CAUTI / VAP და მაჩვენებელი 1000 device-day-ზე, სულ HAI 1000 პაციენტ-დღეზე (ინფექციის დღით, მიკუთვნებული განყოფილებით).
   */
  async rates(u: AuthUser, q: { from?: string; to?: string; department_id?: string }) {
    const r = await this.c.rules();
    if (!q.from || !q.to || !DATE.test(q.from) || !DATE.test(q.to) || q.from > q.to) throw new BadRequestException({ code: 'RANGE', message: 'from / to (YYYY-MM-DD)' });
    const sc = await this.c.scope(u);
    const depts = q.department_id ? [q.department_id] : sc.full ? null : sc.depts;
    if (q.department_id && !sc.full && !sc.depts.includes(q.department_id)) throw new BadRequestException({ code: 'OUT_OF_SCOPE', message: 'განყოფილება თქვენს არეში არ არის' });
    const f = await sql<{ department_id: string; department: string; patient_days: number; cl: number; uc: number; vent: number }>`
      SELECT f.department_id, d.name AS department, sum(f.patient_days)::int AS patient_days, sum(f.central_line_days)::int AS cl, sum(f.urinary_days)::int AS uc, sum(f.vent_days)::int AS vent
        FROM rpt_fact_ipc_daily f JOIN departments d ON d.id = f.department_id
       WHERE f.day BETWEEN ${q.from}::date AND ${q.to}::date ${depts ? sql`AND f.department_id = ANY(${sql.val(depts)}::uuid[])` : sql``}
       GROUP BY f.department_id, d.name ORDER BY d.name`.execute(this.db);
    const h = await sql<{ department_id: string; hai: number; clabsi: number; cauti: number; vap: number }>`
      SELECT h.department_id, count(*)::int AS hai,
             count(*) FILTER (WHERE h.hai_type = 'bsi' AND h.device_assoc)::int AS clabsi,
             count(*) FILTER (WHERE h.hai_type = 'uti' AND h.device_assoc)::int AS cauti,
             count(*) FILTER (WHERE h.hai_type = 'pn' AND h.device_assoc)::int AS vap
        FROM ipc_hai_cases h WHERE h.status = 'confirmed' AND h.onset_date BETWEEN ${q.from}::date AND ${q.to}::date AND h.department_id IS NOT NULL
        ${depts ? sql`AND h.department_id = ANY(${sql.val(depts)}::uuid[])` : sql``}
       GROUP BY h.department_id`.execute(this.db);
    const per = (n: number, d: number, k = 1000) => (d > 0 ? Math.round((n / d) * k * 100) / 100 : null);
    const ratio = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 1000 : null);
    const rows = f.rows.map((x) => {
      const y = h.rows.find((z) => z.department_id === x.department_id) ?? { hai: 0, clabsi: 0, cauti: 0, vap: 0 };
      return { ...x, ...y, dur_cl: ratio(x.cl, x.patient_days), dur_uc: ratio(x.uc, x.patient_days), dur_vent: ratio(x.vent, x.patient_days),
        clabsi_rate: per(y.clabsi, x.cl), cauti_rate: per(y.cauti, x.uc), vap_rate: per(y.vap, x.vent), hai_rate: per(y.hai, x.patient_days) };
    });
    // HAI განყოფილებაში, სადაც device-days არ არის (მაგ. ფაქტი ჯერ არ შევსებულა) — ჯამში მაინც
    for (const y of h.rows) if (!rows.some((x) => x.department_id === y.department_id)) {
      const d = await this.db.selectFrom('departments').select('name').where('id', '=', y.department_id).executeTakeFirst();
      rows.push({ department: d?.name ?? '—', patient_days: 0, cl: 0, uc: 0, vent: 0, ...y, dur_cl: null, dur_uc: null, dur_vent: null,
        clabsi_rate: null, cauti_rate: null, vap_rate: null, hai_rate: null });
    }
    const t = rows.reduce((a, x) => ({ patient_days: a.patient_days + x.patient_days, cl: a.cl + x.cl, uc: a.uc + x.uc, vent: a.vent + x.vent, hai: a.hai + x.hai,
      clabsi: a.clabsi + x.clabsi, cauti: a.cauti + x.cauti, vap: a.vap + x.vap }), { patient_days: 0, cl: 0, uc: 0, vent: 0, hai: 0, clabsi: 0, cauti: 0, vap: 0 });
    const computed = await this.db.selectFrom('rpt_fact_ipc_daily').select(sql<string | null>`max(computed_at)`.as('at')).executeTakeFirst();
    return { from: q.from, to: q.to, basis: r.device_days_basis, central_line_kinds: r.central_line_kinds, computed_at: computed?.at ?? null, rows,
      total: { ...t, dur_cl: ratio(t.cl, t.patient_days), dur_uc: ratio(t.uc, t.patient_days), dur_vent: ratio(t.vent, t.patient_days),
        clabsi_rate: per(t.clabsi, t.cl), cauti_rate: per(t.cauti, t.uc), vap_rate: per(t.vap, t.vent), hai_rate: per(t.hai, t.patient_days) } };
  }
}

@Controller('ipc/device-days')
export class IpcDeviceDaysController {
  constructor(private readonly s: IpcDeviceDaysService) {}
  @Get() @Roles(...IPC_ANY) rates(@CurrentUser() u: AuthUser, @Query('from') from?: string, @Query('to') to?: string, @Query('department_id') department_id?: string) {
    return this.s.rates(u, { from, to, department_id });
  }
  @Post('refresh') @HttpCode(200) @Roles(...IPC_FULL) refresh(@Body() d: RangeDto, @Req() r: Request) { return this.s.manual(d, r); }
}
