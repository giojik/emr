import { BadRequestException, Body, Controller, Get, HttpCode, Injectable, Logger, NotFoundException, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { IsIn, IsNumber, IsOptional, IsString, Length, Min, ValidateIf } from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/roles';
import { loadEnv } from '../config/env';
import { IPC_ANY, IPC_FULL, IpcCommon, ipcRules } from './ipc-common';

const TZ = loadEnv().CLINIC_TZ;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PARENTERAL = ['IV', 'IM', 'SC', 'IO'];
export const AWARE_KA: Record<string, string> = { access: 'Access', watch: 'Watch', reserve: 'Reserve', not_recommended: 'არარეკომენდებული' };

class RefDto {
  @IsOptional() @IsString() @Length(2, 200) name?: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber() @Min(0.0001) ddd_oral?: number | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber() @Min(0.0001) ddd_parenteral?: number | null;
  @IsOptional() @IsIn(['g', 'mg', 'MU']) ddd_unit?: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsIn(['access', 'watch', 'reserve', 'not_recommended']) aware_oral?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsIn(['access', 'watch', 'reserve', 'not_recommended']) aware_parenteral?: string | null;
}

/**
 * ანტიბიოტიკების მართვა (0070):
 *  • worker (საათში): time-out — abx_review_due გავიდა, გადახედვა არ ყოფილა → ექიმს (დამნიშნავი + მკურნალი) შეტყობინება, ერთხელ;
 *  • სამუშაო სია (IPC): აქტიური ანტიმიკრობული დანიშნულებები — შეზღუდული / დასამტკიცებელი / time-out ვადაგასული;
 *  • მაჩვენებლები: MAR-იდან — DDD / 100 პაციენტ-დღე, DOT / 1000 პაციენტ-დღე, AWaRe წილი (DDD და DOT), აგენტებით / განყოფილებებით;
 *    ჩვენება, შეზღუდულის დამტკიცება, time-out-ის შესრულება; DDD-ის გარეშე დოზები ცალკე;
 *  • საცნობარო ცხრილი (DDD / AWaRe) — რედაქტირება და ჯენერიკებზე გადატანა (ცარიელ ველებზე).
 */
@Injectable()
export class IpcAbxService {
  private readonly log = new Logger('IPC-abx');
  constructor(private readonly c: IpcCommon, private readonly audit: AuditService) {}
  private get db() { return this.c.db; }

  /** time-out შეხსენება */
  async tick() {
    const r = await ipcRules(this.db);
    if (!r || !r.abx_timeout_hours) return { timeouts: 0 };
    const due = await this.db.selectFrom('med_orders as o').innerJoin('med_generics as g', 'g.id', 'o.generic_id').innerJoin('inpatient_stays as st', 'st.encounter_id', 'o.encounter_id')
      .innerJoin('encounters as e', 'e.id', 'o.encounter_id').innerJoin('patients as p', 'p.id', 'o.patient_id')
      .select(['o.id', 'o.encounter_id', 'o.ordered_by', 'e.attending_doctor_id', 'g.inn', 'st.adm_no', 'p.first_name', 'p.last_name'])
      .where('o.status', 'in', ['active', 'on_hold']).where('o.abx_review_due', '<=', sql<Date>`now()`).where('o.abx_reviewed_at', 'is', null)
      .where('o.abx_timeout_notified_at', 'is', null).limit(500).execute();
    for (const o of due) {
      await this.db.updateTable('med_orders').set({ abx_timeout_notified_at: sql`now()` }).where('id', '=', o.id).execute();
      await this.db.insertInto('med_order_events').values({ order_id: o.id, kind: 'abx_timeout', data: JSON.stringify({ hours: r.abx_timeout_hours }) }).execute();
      await this.c.bell([o.ordered_by, ...(o.attending_doctor_id ? [o.attending_doctor_id] : [])], { kind: 'ipd_abx_timeout',
        title: `ანტიბიოტიკის გადახედვა (${r.abx_timeout_hours} სთ): ${o.inn}`, body: `${o.last_name} ${o.first_name} (${o.adm_no}) — გაგრძელება / დე-ესკალაცია / IV → per os / შეწყვეტა`,
        link: `/inpatient/stay/${o.encounter_id}?tab=orders`, entityId: o.id });
    }
    return { timeouts: due.length };
  }

  async scanNow(req: Request) {
    await this.c.rules();
    const r = await this.tick();
    await this.audit.log(auditCtx(req), { action: 'IPC_ABX_TIMEOUT_SCAN', entityName: 'med_orders', entityId: 'scan', newData: r });
    return r;
  }

  private prefixCond(prefixes: string[]) {
    return sql<boolean>`g.atc_code LIKE ANY(${sql.val(prefixes.map((p) => `${p}%`))}::text[])`;
  }

  // =============================================================== სამუშაო სია
  async orders(u: AuthUser, q: { view?: string; department_id?: string; q?: string }) {
    const r = await this.c.rules();
    const sc = await this.c.scope(u);
    let x = this.db.selectFrom('med_orders as o').innerJoin('med_generics as g', 'g.id', 'o.generic_id').innerJoin('inpatient_stays as st', 'st.encounter_id', 'o.encounter_id')
      .innerJoin('patients as p', 'p.id', 'o.patient_id').innerJoin('users as ob', 'ob.id', 'o.ordered_by').leftJoin('med_routes as rt', 'rt.code', 'o.route_code')
      .leftJoin('med_frequencies as fq', 'fq.code', 'o.frequency_code').leftJoin('users as rb', 'rb.id', 'o.abx_reviewed_by').leftJoin('icd10_codes as ic', 'ic.code', 'o.abx_icd10')
      .select(['o.id', 'o.encounter_id', 'o.patient_id', 'p.first_name', 'p.last_name', 'st.adm_no', 'g.inn', 'g.strength', 'g.atc_code', 'g.aware', 'g.reserve_antibiotic',
        'o.dose', 'o.dose_unit', 'o.route_code', 'rt.name as route_name', 'fq.name as frequency_name', 'o.order_type', 'o.start_at', 'o.end_at', 'o.duration_days', 'o.status',
        'o.verify_status', 'o.approval_status', 'o.abx_indication', 'o.abx_icd10', 'ic.title as abx_icd10_title', 'o.abx_review_due', 'o.abx_reviewed_at', 'o.abx_review_decision',
        'o.abx_review_note', sql<string>`ob.last_name || ' ' || ob.first_name`.as('ordered_by_name'), sql<string | null>`rb.last_name || ' ' || rb.first_name`.as('reviewed_by_name'),
        sql<number>`((now() AT TIME ZONE ${TZ})::date - (o.start_at AT TIME ZONE ${TZ})::date + 1)::int`.as('dot_day'),
        sql<string | null>`(SELECT a.department_id FROM bed_assignments a WHERE a.encounter_id = o.encounter_id AND a.end_kind IS DISTINCT FROM 'cancel'
          ORDER BY (a.ended_at IS NULL) DESC, a.started_at DESC LIMIT 1)`.as('department_id'),
        sql<string | null>`(SELECT d.name FROM bed_assignments a JOIN departments d ON d.id = a.department_id WHERE a.encounter_id = o.encounter_id AND a.end_kind IS DISTINCT FROM 'cancel'
          ORDER BY (a.ended_at IS NULL) DESC, a.started_at DESC LIMIT 1)`.as('department')])
      .where('o.category', '=', 'medication').where(this.prefixCond(r.abx_atc_prefixes)).where('st.status', '=', 'active')
      .orderBy('o.start_at', 'desc').limit(500);
    x = q.view === 'all' ? x : x.where('o.status', 'in', ['active', 'on_hold']);
    if (q.view === 'restricted') x = x.where('o.approval_status', '<>', 'not_required');
    if (q.view === 'pending') x = x.where('o.approval_status', '=', 'pending');
    if (q.view === 'timeout') x = x.where('o.abx_review_due', '<=', sql<Date>`now()`).where('o.abx_reviewed_at', 'is', null);
    if (q.q?.trim()) { const s = `%${q.q.trim().toLowerCase()}%`; x = x.where((eb) => eb.or([eb(sql`lower(p.first_name || ' ' || p.last_name)`, 'like', s), eb(sql`lower(g.inn)`, 'like', s), eb(sql`lower(st.adm_no)`, 'like', s)])); }
    let rows = await x.execute();
    if (q.department_id) rows = rows.filter((o) => o.department_id === q.department_id);
    if (!sc.full) rows = rows.filter((o) => !!o.department_id && sc.depts.includes(o.department_id));
    return rows.map((o) => ({ ...o, restricted: o.approval_status !== 'not_required', timeout_overdue: !!o.abx_review_due && !o.abx_reviewed_at && new Date(o.abx_review_due) <= new Date() }));
  }

  // =============================================================== მაჩვენებლები
  async rates(u: AuthUser, q: { from?: string; to?: string; department_id?: string }) {
    const r = await this.c.rules();
    if (!q.from || !q.to || !DATE.test(q.from) || !DATE.test(q.to) || q.from > q.to) throw new BadRequestException({ code: 'RANGE', message: 'from / to (YYYY-MM-DD)' });
    const sc = await this.c.scope(u);
    if (q.department_id && !sc.full && !sc.depts.includes(q.department_id)) throw new BadRequestException({ code: 'OUT_OF_SCOPE', message: 'განყოფილება თქვენს არეში არ არის' });
    const depts = q.department_id ? [q.department_id] : sc.full ? null : sc.depts;
    const dcond = (col: string) => depts ? sql`AND ${sql.ref(col)} = ANY(${sql.val(depts)}::uuid[])` : sql``;
    const pre = sql.val(r.abx_atc_prefixes.map((p) => `${p}%`));
    // მიცემული დოზები → DDD (გზის მიხედვით), განყოფილება — დოზის მომენტში
    const doses = (await sql<{ department_id: string | null; department: string | null; key: string; inn: string; atc_code: string | null; aware: string | null; patient_id: string;
      day: string; parenteral: boolean; ddd: string | null; missing: boolean }>`
      WITH d AS (
        SELECT me.patient_id, g.inn, g.atc_code, g.aware, coalesce(g.atc_code, 'X:' || g.inn) AS key, (me.documented_at AT TIME ZONE ${TZ})::date AS day,
               coalesce(me.route_code, o.route_code) = ANY(${sql.val(PARENTERAL)}::text[]) AS parenteral,
               coalesce(me.dose_given, o.dose) AS dose, coalesce(me.dose_unit, o.dose_unit) AS unit, g.ddd_unit,
               CASE WHEN coalesce(me.route_code, o.route_code) = ANY(${sql.val(PARENTERAL)}::text[]) THEN g.ddd_parenteral ELSE g.ddd_oral END AS ddd_ref,
               (SELECT a.department_id FROM bed_assignments a WHERE a.encounter_id = me.encounter_id AND a.started_at <= me.documented_at AND a.end_kind IS DISTINCT FROM 'cancel'
                 ORDER BY a.started_at DESC LIMIT 1) AS department_id
          FROM mar_entries me JOIN med_orders o ON o.id = me.order_id JOIN med_generics g ON g.id = o.generic_id
         WHERE me.status IN ('given', 'partial') AND me.voided_at IS NULL AND g.atc_code LIKE ANY(${pre}::text[])
           AND (me.documented_at AT TIME ZONE ${TZ})::date BETWEEN ${q.from}::date AND ${q.to}::date),
      c AS (
        SELECT d.*, CASE
            WHEN ddd_ref IS NULL OR dose IS NULL THEN NULL
            WHEN ddd_unit = 'g'  AND unit = 'g'   THEN dose / ddd_ref
            WHEN ddd_unit = 'g'  AND unit = 'mg'  THEN dose / 1000 / ddd_ref
            WHEN ddd_unit = 'g'  AND unit = 'mcg' THEN dose / 1000000 / ddd_ref
            WHEN ddd_unit = 'mg' AND unit = 'mg'  THEN dose / ddd_ref
            WHEN ddd_unit = 'mg' AND unit = 'g'   THEN dose * 1000 / ddd_ref
            WHEN ddd_unit = 'mg' AND unit = 'mcg' THEN dose / 1000 / ddd_ref
            WHEN ddd_unit = 'MU' AND unit = 'IU'  THEN dose / 1000000 / ddd_ref
            ELSE NULL END AS ddd
          FROM d)
      SELECT c.department_id, dp.name AS department, c.key, c.inn, c.atc_code, c.aware, c.patient_id, c.day::text AS day, c.parenteral, c.ddd::text AS ddd, c.ddd IS NULL AS missing
        FROM c LEFT JOIN departments dp ON dp.id = c.department_id
       WHERE true ${dcond('c.department_id')}`.execute(this.db)).rows;
    const pd = (await sql<{ department_id: string; department: string; patient_days: number }>`
      SELECT f.department_id, d.name AS department, sum(f.patient_days)::int AS patient_days FROM rpt_fact_ipc_daily f JOIN departments d ON d.id = f.department_id
       WHERE f.day BETWEEN ${q.from}::date AND ${q.to}::date ${dcond('f.department_id')} GROUP BY f.department_id, d.name`.execute(this.db)).rows;
    const r2 = (n: number, k = 100) => Math.round(n * k) / k;
    const per = (n: number, d: number, k: number) => (d > 0 ? r2((n / d) * k) : null);
    const agg = (rows: typeof doses) => {
      const ddd = rows.reduce((a, x) => a + (x.ddd ? Number(x.ddd) : 0), 0);
      const dot = new Set(rows.map((x) => `${x.patient_id}|${x.key}|${x.day}`)).size;
      return { doses: rows.length, ddd: r2(ddd), raw: ddd, dot, missing_ddd: rows.filter((x) => x.missing).length };
    };
    const totalPd = pd.reduce((a, x) => a + x.patient_days, 0);
    const total = agg(doses);
    const aware = ['access', 'watch', 'reserve', 'not_recommended', 'unclassified'].map((k) => {
      const a = agg(doses.filter((x) => (x.aware ?? 'unclassified') === k));
      return { aware: k, ...a, ddd_pct: total.raw > 0 ? r2((a.raw / total.raw) * 100) : null, dot_pct: total.dot > 0 ? r2((a.dot / total.dot) * 100) : null };
    });
    const agents = [...new Set(doses.map((x) => x.key))].map((k) => {
      const rs = doses.filter((x) => x.key === k);
      const a = agg(rs);
      return { key: k, inn: rs[0].inn, atc_code: rs[0].atc_code, aware: rs[0].aware, ...a, parenteral_pct: r2((rs.filter((x) => x.parenteral).length / rs.length) * 100),
        ddd_per_100: per(a.raw, totalPd, 100), dot_per_1000: per(a.dot, totalPd, 1000) };
    }).sort((a, b) => b.raw - a.raw || b.dot - a.dot);
    const deptIds = [...new Set([...pd.map((x) => x.department_id), ...doses.map((x) => x.department_id).filter((x): x is string => !!x)])];
    const departments = deptIds.map((id) => {
      const rs = doses.filter((x) => x.department_id === id);
      const p = pd.find((x) => x.department_id === id);
      const a = agg(rs); const acc = agg(rs.filter((x) => x.aware === 'access'));
      return { department_id: id, department: p?.department ?? rs[0]?.department ?? '—', patient_days: p?.patient_days ?? 0, ...a,
        ddd_per_100: per(a.raw, p?.patient_days ?? 0, 100), dot_per_1000: per(a.dot, p?.patient_days ?? 0, 1000), access_pct: a.raw > 0 ? r2((acc.raw / a.raw) * 100) : null };
    }).sort((a, b) => a.department.localeCompare(b.department));
    // დანიშნულებები პერიოდში: ჩვენება, შეზღუდული, time-out
    const ord = (await sql<{ indication: string | null; approval_status: string; approval_hours: string | null; review_due: string | null; reviewed_at: string | null;
      decision: string | null; overdue: boolean }>`
      SELECT o.abx_indication AS indication, o.approval_status, extract(epoch FROM (o.approved_at - o.created_at)) / 3600 AS approval_hours,
             o.abx_review_due AS review_due, o.abx_reviewed_at AS reviewed_at, o.abx_review_decision AS decision,
             (o.abx_review_due <= now() AND o.abx_reviewed_at IS NULL AND o.status IN ('active', 'on_hold')) AS overdue
        FROM med_orders o JOIN med_generics g ON g.id = o.generic_id
       WHERE o.category = 'medication' AND g.atc_code LIKE ANY(${pre}::text[]) AND (o.created_at AT TIME ZONE ${TZ})::date BETWEEN ${q.from}::date AND ${q.to}::date
         ${depts ? sql`AND (SELECT a.department_id FROM bed_assignments a WHERE a.encounter_id = o.encounter_id AND a.started_at <= o.created_at AND a.end_kind IS DISTINCT FROM 'cancel'
                          ORDER BY a.started_at DESC LIMIT 1) = ANY(${sql.val(depts)}::uuid[])` : sql``}`.execute(this.db)).rows;
    const cnt = (f: (x: (typeof ord)[number]) => boolean) => ord.filter(f).length;
    const appr = ord.filter((x) => x.approval_hours !== null).map((x) => Number(x.approval_hours)).sort((a, b) => a - b);
    const due = ord.filter((x) => x.review_due && new Date(x.review_due) <= new Date());
    const onTime = due.filter((x) => x.reviewed_at && new Date(x.reviewed_at).getTime() <= new Date(x.review_due!).getTime() + 24 * 3_600_000).length;
    return {
      from: q.from, to: q.to, prefixes: r.abx_atc_prefixes, access_target: r.aware_access_target, patient_days: totalPd,
      total: { ...total, ddd_per_100: per(total.raw, totalPd, 100), dot_per_1000: per(total.dot, totalPd, 1000) },
      aware, agents, departments,
      orders: {
        total: ord.length,
        indication: { empiric: cnt((x) => x.indication === 'empiric'), targeted: cnt((x) => x.indication === 'targeted'), prophylaxis: cnt((x) => x.indication === 'prophylaxis'),
          none: cnt((x) => !x.indication) },
        restricted: { total: cnt((x) => x.approval_status !== 'not_required'), pending: cnt((x) => x.approval_status === 'pending'), approved: cnt((x) => x.approval_status === 'approved'),
          rejected: cnt((x) => x.approval_status === 'rejected'), median_hours: appr.length ? r2(appr[Math.floor(appr.length / 2)], 10) : null },
        timeout: { due: due.length, reviewed: due.filter((x) => x.reviewed_at).length, on_time: onTime, overdue: cnt((x) => x.overdue),
          on_time_pct: due.length ? r2((onTime / due.length) * 100) : null,
          decisions: { continue: cnt((x) => x.decision === 'continue'), deescalate: cnt((x) => x.decision === 'deescalate'), iv_to_po: cnt((x) => x.decision === 'iv_to_po'),
            stop: cnt((x) => x.decision === 'stop') } },
      },
    };
  }

  // =============================================================== საცნობარო ცხრილი
  async reference() {
    await this.c.rules();
    const [rows, gens] = await Promise.all([
      this.db.selectFrom('ipc_abx_reference').selectAll().orderBy('atc_code').execute(),
      this.db.selectFrom('med_generics').select(['id', 'inn', 'strength', 'atc_code', 'form_code', 'ddd_oral', 'ddd_parenteral', 'ddd_unit', 'aware', 'reserve_antibiotic'])
        .where('is_active', '=', true).where('atc_code', 'is not', null).orderBy('inn').execute(),
    ]);
    const r = await this.c.rules();
    const abx = gens.filter((g) => r.abx_atc_prefixes.some((p) => g.atc_code!.startsWith(p)));
    return { reference: rows, generics: abx.map((g) => ({ ...g, in_reference: rows.some((x) => x.atc_code === g.atc_code),
      missing: !g.aware || (!g.ddd_oral && !g.ddd_parenteral) })) };
  }

  async saveRef(atc: string, d: RefDto, req: Request) {
    await this.c.rules();
    const ex = await this.db.selectFrom('ipc_abx_reference').selectAll().where('atc_code', '=', atc).executeTakeFirst();
    if (!ex) throw new NotFoundException('ATC კოდი საცნობაროში ვერ მოიძებნა');
    const vals = Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined));
    if (!Object.keys(vals).length) throw new BadRequestException({ code: 'NO_CHANGE', message: 'ცვლილება არ არის' });
    const next = { ...ex, ...vals };
    if (!next.ddd_oral && !next.ddd_parenteral) throw new BadRequestException({ code: 'DDD_REQUIRED', message: 'მიუთითეთ DDD (per os ან პარენტერალური)' });
    await this.db.updateTable('ipc_abx_reference').set(vals).where('atc_code', '=', atc).execute();
    await this.audit.log(auditCtx(req), { action: 'IPC_ABX_REF_UPDATE', entityName: 'ipc_abx_reference', entityId: atc,
      oldData: Object.fromEntries(Object.keys(vals).map((k) => [k, (ex as Record<string, unknown>)[k]])), newData: vals });
    return this.reference();
  }

  /** საცნობაროდან ჯენერიკებზე — მხოლოდ ცარიელ ველებზე (DDD / AWaRe) */
  async applyRef(req: Request) {
    await this.c.rules();
    const res = await sql<{ id: string }>`
      UPDATE med_generics g
         SET ddd_oral = coalesce(g.ddd_oral, r.ddd_oral), ddd_parenteral = coalesce(g.ddd_parenteral, r.ddd_parenteral),
             ddd_unit = coalesce(g.ddd_unit, r.ddd_unit),
             aware = coalesce(g.aware, CASE WHEN g.form_code IN ('INJ_SOL', 'INJ_PWD', 'INF_SOL', 'INF_CONC') THEN coalesce(r.aware_parenteral, r.aware_oral)
                                            ELSE coalesce(r.aware_oral, r.aware_parenteral) END)
        FROM ipc_abx_reference r
       WHERE r.atc_code = g.atc_code AND g.is_active
         AND (g.aware IS NULL OR (g.ddd_oral IS NULL AND g.ddd_parenteral IS NULL))
         AND (g.ddd_unit IS NULL OR g.ddd_unit = r.ddd_unit)
      RETURNING g.id`.execute(this.db);
    await this.audit.log(auditCtx(req), { action: 'IPC_ABX_REF_APPLY', entityName: 'med_generics', entityId: 'bulk', newData: { updated: res.rows.length } });
    return { updated: res.rows.length, ...(await this.reference()) };
  }
}

@Controller('ipc/abx')
export class IpcAbxController {
  constructor(private readonly s: IpcAbxService) {}
  @Get('orders') @Roles(...IPC_ANY) orders(@CurrentUser() u: AuthUser, @Query('view') view?: string, @Query('department_id') department_id?: string, @Query('q') q?: string) {
    return this.s.orders(u, { view, department_id, q });
  }
  @Get('rates') @Roles(...IPC_ANY) rates(@CurrentUser() u: AuthUser, @Query('from') from?: string, @Query('to') to?: string, @Query('department_id') department_id?: string) {
    return this.s.rates(u, { from, to, department_id });
  }
  @Post('timeout-scan') @HttpCode(200) @Roles(...IPC_FULL) scan(@Req() r: Request) { return this.s.scanNow(r); }
  @Get('reference') @Roles(...IPC_ANY, 'pharmacist', 'admin') reference() { return this.s.reference(); }
  @Patch('reference/:atc') @Roles(...IPC_FULL) saveRef(@Param('atc') atc: string, @Body() d: RefDto, @Req() r: Request) { return this.s.saveRef(atc.toUpperCase(), d, r); }
  @Post('reference/apply') @HttpCode(200) @Roles(...IPC_FULL, 'pharmacist', 'admin') apply(@Req() r: Request) { return this.s.applyRef(r); }
}
