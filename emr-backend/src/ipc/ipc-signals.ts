import { Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, Logger, NotFoundException, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { IsInt, IsOptional, IsString, Length, Max, MaxLength, Min } from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser } from '../auth/roles';
import { loadEnv } from '../config/env';
import { IPC_ANY, IPC_FULL, IpcCommon, ipcRules, type IpcRules } from './ipc-common';

const TZ = loadEnv().CLINIC_TZ;
export const SIGNAL_KA: Record<string, string> = {
  blood_culture: 'დადებითი ჰემოკულტურა', hospital_culture: 'ჰოსპიტალური დადებითი კულტურა', fever_device: 'ცხელება (მოწყობილობა / ოპერაცია)',
  antibiotic_start: 'ანტიბიოტიკის დაწყება', cluster: 'შესაძლო კლასტერი',
};

class WatchDto { @IsInt() @Min(1) @Max(30) days: number; @IsOptional() @IsString() @MaxLength(500) note?: string }
class DismissDto { @IsString() @Length(3, 500) reason: string }

type NewSignal = { kind: string; ref_key: string; patient_id: string | null; encounter_id: string | null; department_id: string | null; organism_id?: string | null;
  order_item_id?: string | null; summary: string; data: Record<string, unknown>; event_at: string | Date };

/**
 * სიგნალები (0068) — worker (15 წთ) ან „შემოწმება“ (IPC): მხოლოდ შეთავაზება ინფექციის კონტროლს, შემთხვევა ავტომატურად არ იქმნება.
 *  • blood_culture — სტაციონარში დადებითი ჰემოკულტურა (წინასწარი / საბოლოო); მხოლოდ კომენსალი → საჭიროა იგივე მიკროორგანიზმი მეორე ჰემოკულტურაში commensal_window_hours-ში;
 *  • hospital_culture — სხვა ნიმუში, ჰოსპიტალიზაციის ≥ hospital_onset_day დღეს, არა-კომენსალი;
 *  • fever_device — ტემპერატურა ≥ fever_threshold, თუ იმ წუთას დგას ცენტრალური ხაზი / შარდის კათეტერი / ინვაზიური ვენტილაცია ან postop_fever_days-ში ოპერაცია;
 *  • antibiotic_start — ახალი J01 დანიშნულება ≥ hospital_onset_day დღეს (წინა 2 დღეში სხვა J01 არ ყოფილა);
 *  • cluster — განყოფილება × მიკროორგანიზმი: ≥ cluster_count პაციენტი cluster_days-ში (ჰოსპიტალური, არა-კომენსალი).
 * დუბლირება: იგივე სახე + იგივე წყარო (ref_key) — არასდროს; იგივე პაციენტი + სახე — signal_dedupe_days-ში არა.
 */
@Injectable()
export class IpcSignalsService {
  private readonly log = new Logger('IPC-signals');
  constructor(private readonly c: IpcCommon, private readonly audit: AuditService) {}
  private get db() { return this.c.db; }

  /** ყველა სახის შემოწმება; აბრუნებს ახლის რაოდენობას. მოდული გამორთულია → 0 */
  async scan(): Promise<{ created: number; reopened: number }> {
    const r = await ipcRules(this.db);
    if (!r) return { created: 0, reopened: 0 };
    const reopened = (await this.db.updateTable('ipc_signals').set({ status: 'open', watch_until: null }).where('status', '=', 'watch')
      .where('watch_until', '<', sql<Date>`now()`).returning('id').execute()).length;
    const look = Math.max(r.signal_dedupe_days, 3);
    const cand: NewSignal[] = [];
    if (r.sig_blood_culture || r.sig_hospital_culture || r.sig_cluster) cand.push(...await this.cultures(r, look));
    if (r.sig_fever_device) cand.push(...await this.fever(r, look));
    if (r.sig_antibiotic_start) cand.push(...await this.antibiotics(r, look));
    const created: NewSignal[] = [];
    for (const s of cand) {
      if (s.patient_id) {
        const dup = await this.db.selectFrom('ipc_signals').select('id').where('kind', '=', s.kind).where('patient_id', '=', s.patient_id)
          .where('detected_at', '>', sql<Date>`now() - make_interval(days => ${r.signal_dedupe_days})`).executeTakeFirst();
        if (dup) continue;
      }
      const ins = await this.db.insertInto('ipc_signals').values({ kind: s.kind, ref_key: s.ref_key, patient_id: s.patient_id, encounter_id: s.encounter_id, department_id: s.department_id,
        organism_id: s.organism_id ?? null, order_item_id: s.order_item_id ?? null, summary: s.summary, data: JSON.stringify(s.data), event_at: s.event_at as Date })
        .onConflict((oc) => oc.columns(['kind', 'ref_key']).doNothing()).returning('id').executeTakeFirst();
      if (ins) created.push(s);
    }
    if (created.length) {
      const ipc = (await this.c.usersWith(IPC_FULL)).map((x) => x.id);
      const depts = [...new Set(created.map((x) => x.department_id).filter((x): x is string => !!x))];
      const deptUsers = (await Promise.all(depts.map((d) => this.c.deptIpcUsers(d)))).flat();
      const kinds = [...new Set(created.map((x) => SIGNAL_KA[x.kind]))].join(', ');
      await this.c.bell([...ipc, ...deptUsers], { kind: 'ipc_signal', title: `ინფექციის კონტროლი: ${created.length} ახალი სიგნალი`, body: kinds, link: '/ipc?tab=signals',
        urgent: created.some((x) => x.kind === 'cluster') });
    }
    return { created: created.length, reopened };
  }

  private async cultures(r: IpcRules, look: number): Promise<NewSignal[]> {
    const out: NewSignal[] = [];
    // დადებითი კულტურები (წინასწარი / საბოლოო პასუხი) სტაციონარში, ბოლო look დღე — იზოლატები მიკროორგანიზმით
    const rows = (await sql<{ item_id: string; patient_id: string; encounter_id: string; specimen_type: string | null; collected_at: string; day: number; department_id: string | null;
      organisms: { id: string; name: string; commensal: boolean }[] }>`
      SELECT i.id AS item_id, i.patient_id, i.encounter_id, s.specimen_type, coalesce(sp.collected_at, i.ordered_at) AS collected_at,
             ((coalesce(sp.collected_at, i.ordered_at) AT TIME ZONE ${TZ})::date - (st.admitted_at AT TIME ZONE ${TZ})::date + 1)::int AS day,
             (SELECT a.department_id FROM bed_assignments a WHERE a.encounter_id = st.encounter_id AND a.started_at <= coalesce(sp.collected_at, i.ordered_at)
               ORDER BY a.started_at DESC LIMIT 1) AS department_id,
             (SELECT json_agg(DISTINCT jsonb_build_object('id', o.id, 'name', o.name, 'commensal', o.is_commensal)) FROM micro_cultures c JOIN micro_isolates mi ON mi.culture_id = c.id
               JOIN micro_organisms o ON o.id = mi.organism_id WHERE c.order_item_id = i.id) AS organisms
        FROM dx_order_items i JOIN dx_services s ON s.id = i.service_id AND s.is_micro
        JOIN inpatient_stays st ON st.encounter_id = i.encounter_id
        LEFT JOIN lab_specimens sp ON sp.id = i.specimen_id
       WHERE EXISTS (SELECT 1 FROM micro_reports mr WHERE mr.order_item_id = i.id AND mr.issued_at > now() - make_interval(days => ${look}))
         AND EXISTS (SELECT 1 FROM micro_cultures c JOIN micro_isolates mi ON mi.culture_id = c.id WHERE c.order_item_id = i.id AND mi.organism_id IS NOT NULL)`.execute(this.db)).rows;
    for (const x of rows) {
      const orgs = x.organisms ?? [];
      const path = orgs.filter((o) => !o.commensal);
      if (x.specimen_type === 'blood') {
        if (!r.sig_blood_culture) continue;
        let use = path;
        if (!path.length) {
          // მხოლოდ კომენსალი: იგივე მიკროორგანიზმი სხვა ჰემოკულტურაში commensal_window_hours-ში
          const pair = (await sql<{ id: string }>`
            SELECT DISTINCT mi.organism_id AS id FROM dx_order_items i2 JOIN dx_services s2 ON s2.id = i2.service_id AND s2.specimen_type = 'blood'
              LEFT JOIN lab_specimens sp2 ON sp2.id = i2.specimen_id
              JOIN micro_cultures c ON c.order_item_id = i2.id JOIN micro_isolates mi ON mi.culture_id = c.id
             WHERE i2.patient_id = ${x.patient_id} AND i2.id <> ${x.item_id} AND mi.organism_id = ANY(${sql.val(orgs.map((o) => o.id))}::uuid[])
               AND abs(extract(epoch FROM coalesce(sp2.collected_at, i2.ordered_at) - ${x.collected_at}::timestamptz)) <= ${r.commensal_window_hours} * 3600`.execute(this.db)).rows;
          use = orgs.filter((o) => pair.some((p) => p.id === o.id));
          if (!use.length) continue;
        }
        out.push({ kind: 'blood_culture', ref_key: `dx:${x.item_id}`, patient_id: x.patient_id, encounter_id: x.encounter_id, department_id: x.department_id, organism_id: use[0].id,
          order_item_id: x.item_id, summary: `ჰემოკულტურა: ${use.map((o) => o.name).join(', ')}${!path.length ? ' (კომენსალი — 2 ნიმუში)' : ''} · დღე ${x.day}`,
          data: { organisms: use, day: x.day, specimen: 'blood', commensal_pair: !path.length }, event_at: x.collected_at });
      } else if (r.sig_hospital_culture && x.day >= r.hospital_onset_day && path.length) {
        out.push({ kind: 'hospital_culture', ref_key: `dx:${x.item_id}`, patient_id: x.patient_id, encounter_id: x.encounter_id, department_id: x.department_id, organism_id: path[0].id,
          order_item_id: x.item_id, summary: `${x.specimen_type ?? 'ნიმუში'}: ${path.map((o) => o.name).join(', ')} · დღე ${x.day}`,
          data: { organisms: path, day: x.day, specimen: x.specimen_type }, event_at: x.collected_at });
      }
    }
    if (r.sig_cluster) {
      // კლასტერი: ჰოსპიტალური (≥ onset_day), არა-კომენსალი, cluster_days-ში, განყოფილება × მიკროორგანიზმი ≥ cluster_count პაციენტი
      const cl = (await sql<{ department_id: string; organism_id: string; organism: string; department: string; n: number; patients: string[]; first_at: string; last_at: string }>`
        WITH pos AS (
          SELECT DISTINCT i.patient_id, mi.organism_id, coalesce(sp.collected_at, i.ordered_at) AS at,
                 (SELECT a.department_id FROM bed_assignments a WHERE a.encounter_id = st.encounter_id AND a.started_at <= coalesce(sp.collected_at, i.ordered_at) ORDER BY a.started_at DESC LIMIT 1) AS department_id
            FROM dx_order_items i JOIN dx_services s ON s.id = i.service_id AND s.is_micro
            JOIN inpatient_stays st ON st.encounter_id = i.encounter_id
            LEFT JOIN lab_specimens sp ON sp.id = i.specimen_id
            JOIN micro_cultures c ON c.order_item_id = i.id JOIN micro_isolates mi ON mi.culture_id = c.id
            JOIN micro_organisms o ON o.id = mi.organism_id AND NOT o.is_commensal
           WHERE coalesce(sp.collected_at, i.ordered_at) > now() - make_interval(days => ${r.cluster_days})
             AND ((coalesce(sp.collected_at, i.ordered_at) AT TIME ZONE ${TZ})::date - (st.admitted_at AT TIME ZONE ${TZ})::date + 1) >= ${r.hospital_onset_day}
             AND EXISTS (SELECT 1 FROM micro_reports mr WHERE mr.order_item_id = i.id))
        SELECT p.department_id, p.organism_id, o.name AS organism, d.name AS department, count(DISTINCT p.patient_id)::int AS n,
               array_agg(DISTINCT p.patient_id) AS patients, min(p.at) AS first_at, max(p.at) AS last_at
          FROM pos p JOIN micro_organisms o ON o.id = p.organism_id JOIN departments d ON d.id = p.department_id
         WHERE p.department_id IS NOT NULL
         GROUP BY p.department_id, p.organism_id, o.name, d.name HAVING count(DISTINCT p.patient_id) >= ${r.cluster_count}`.execute(this.db)).rows;
      for (const x of cl) {
        const recent = await this.db.selectFrom('ipc_signals').select('id').where('kind', '=', 'cluster').where('department_id', '=', x.department_id).where('organism_id', '=', x.organism_id)
          .where('detected_at', '>', sql<Date>`now() - make_interval(days => ${r.cluster_days})`).executeTakeFirst();
        if (recent) continue;
        out.push({ kind: 'cluster', ref_key: `cluster:${x.department_id}:${x.organism_id}:${new Date().toISOString().slice(0, 10)}`, patient_id: null, encounter_id: null,
          department_id: x.department_id, organism_id: x.organism_id, summary: `${x.department}: ${x.organism} — ${x.n} პაციენტი ${r.cluster_days} დღეში`,
          data: { patients: x.patients, n: x.n, days: r.cluster_days, first_at: x.first_at, last_at: x.last_at }, event_at: x.last_at });
      }
    }
    return out;
  }

  private async fever(r: IpcRules, look: number): Promise<NewSignal[]> {
    const rows = (await sql<{ id: string; patient_id: string; encounter_id: string; t: string; at: string; day: number; department_id: string | null; devices: string[]; postop: string | null }>`
      SELECT v.id, st.patient_id, st.encounter_id, v.temperature::text AS t, v.recorded_at AS at,
             ((v.recorded_at AT TIME ZONE ${TZ})::date - (st.admitted_at AT TIME ZONE ${TZ})::date + 1)::int AS day,
             (SELECT a.department_id FROM bed_assignments a WHERE a.encounter_id = st.encounter_id AND a.started_at <= v.recorded_at ORDER BY a.started_at DESC LIMIT 1) AS department_id,
             ARRAY(SELECT DISTINCT CASE WHEN ld.kind = ANY(${sql.val(r.central_line_kinds)}::text[]) THEN 'central_line' ELSE 'urinary' END FROM lines_drains ld
                    WHERE ld.encounter_id = st.encounter_id AND ld.voided_at IS NULL AND ld.inserted_at <= v.recorded_at AND (ld.removed_at IS NULL OR ld.removed_at >= v.recorded_at)
                      AND (ld.kind = ANY(${sql.val(r.central_line_kinds)}::text[]) OR ld.kind = 'urinary')
                   UNION SELECT 'ventilator' FROM icu_ventilation iv WHERE iv.encounter_id = st.encounter_id AND iv.kind = 'invasive' AND iv.voided_at IS NULL
                      AND iv.started_at <= v.recorded_at AND (iv.ended_at IS NULL OR iv.ended_at >= v.recorded_at)) AS devices,
             (SELECT oc.case_no FROM or_cases oc JOIN or_case_times ot ON ot.case_id = oc.id AND ot.kind = 'closure' AND ot.superseded_by IS NULL
               WHERE oc.patient_id = st.patient_id AND ot.at <= v.recorded_at AND ot.at > v.recorded_at - make_interval(days => ${r.postop_fever_days}) ORDER BY ot.at DESC LIMIT 1) AS postop
        FROM encounter_vitals v JOIN inpatient_stays st ON st.encounter_id = v.encounter_id
       WHERE v.voided_at IS NULL AND v.temperature >= ${r.fever_threshold} AND v.recorded_at > now() - make_interval(days => ${look})`.execute(this.db)).rows;
    const DEV: Record<string, string> = { central_line: 'ცენტრ. ხაზი', urinary: 'შარდის კათეტერი', ventilator: 'ვენტილაცია' };
    return rows.filter((x) => x.devices.length || x.postop).map((x) => ({
      kind: 'fever_device', ref_key: `vital:${x.id}`, patient_id: x.patient_id, encounter_id: x.encounter_id, department_id: x.department_id,
      summary: `${x.t} °C · ${[...x.devices.map((d) => DEV[d]), ...(x.postop ? [`ოპერაცია ${x.postop}`] : [])].join(', ')} · დღე ${x.day}`,
      data: { temperature: Number(x.t), devices: x.devices, postop_case: x.postop, day: x.day }, event_at: x.at }));
  }

  private async antibiotics(r: IpcRules, look: number): Promise<NewSignal[]> {
    const rows = (await sql<{ id: string; patient_id: string; encounter_id: string; inn: string; atc: string; at: string; day: number; department_id: string | null }>`
      SELECT o.id, o.patient_id, o.encounter_id, g.inn, g.atc_code AS atc, o.start_at AS at,
             ((o.start_at AT TIME ZONE ${TZ})::date - (st.admitted_at AT TIME ZONE ${TZ})::date + 1)::int AS day,
             (SELECT a.department_id FROM bed_assignments a WHERE a.encounter_id = st.encounter_id AND a.started_at <= o.start_at ORDER BY a.started_at DESC LIMIT 1) AS department_id
        FROM med_orders o JOIN med_generics g ON g.id = o.generic_id AND g.atc_code LIKE 'J01%'
        JOIN inpatient_stays st ON st.encounter_id = o.encounter_id
       WHERE o.category = 'medication' AND o.status <> 'cancelled' AND o.created_at > now() - make_interval(days => ${look})
         AND ((o.start_at AT TIME ZONE ${TZ})::date - (st.admitted_at AT TIME ZONE ${TZ})::date + 1) >= ${r.hospital_onset_day}
         AND NOT EXISTS (SELECT 1 FROM med_orders p JOIN med_generics pg ON pg.id = p.generic_id AND pg.atc_code LIKE 'J01%'
                          WHERE p.encounter_id = o.encounter_id AND p.id <> o.id AND p.id IS DISTINCT FROM o.replaces_id AND o.id IS DISTINCT FROM p.replaces_id
                            AND p.start_at < o.start_at AND p.start_at >= o.start_at - interval '2 days')`.execute(this.db)).rows;
    return rows.map((x) => ({ kind: 'antibiotic_start', ref_key: `order:${x.id}`, patient_id: x.patient_id, encounter_id: x.encounter_id, department_id: x.department_id,
      summary: `${x.inn} (${x.atc}) · დღე ${x.day}`, data: { inn: x.inn, atc: x.atc, day: x.day, order_id: x.id }, event_at: x.at }));
  }

  // =============================================================== სია / მოქმედებები
  async list(u: AuthUser, q: { status?: string; kind?: string; department_id?: string }) {
    await this.c.rules();
    const sc = await this.c.scope(u);
    const st = q.status === 'all' ? ['open', 'watch', 'dismissed', 'case'] : q.status ? q.status.split(',') : ['open', 'watch'];
    let x = this.db.selectFrom('ipc_signals as s').leftJoin('patients as p', 'p.id', 's.patient_id').leftJoin('departments as d', 'd.id', 's.department_id')
      .leftJoin('inpatient_stays as stx', 'stx.encounter_id', 's.encounter_id').leftJoin('ipc_hai_cases as hc', 'hc.id', 's.case_id')
      .leftJoin('users as hu', 'hu.id', 's.handled_by')
      .select(['s.id', 's.kind', 's.patient_id', 's.encounter_id', 's.department_id', 'd.name as department', 's.summary', 's.data', 's.event_at', 's.detected_at', 's.status',
        's.watch_until', 's.dismiss_reason', 's.case_id', 'hc.case_no', 's.order_item_id', 'p.first_name', 'p.last_name', 'p.personal_number', 'stx.adm_no', 'stx.status as stay_status',
        sql<string | null>`hu.first_name || ' ' || hu.last_name`.as('handled_by_name'), 's.handled_at'])
      .where('s.status', 'in', st).orderBy('s.detected_at', 'desc').limit(500);
    if (q.kind) x = x.where('s.kind', '=', q.kind);
    if (q.department_id) x = x.where('s.department_id', '=', q.department_id);
    if (!sc.full) x = x.where('s.department_id', 'in', sc.depts);
    return (await x.execute()).map((s) => ({ ...s, kind_ka: SIGNAL_KA[s.kind] }));
  }

  private async one(id: string, u: AuthUser) {
    const s = await this.db.selectFrom('ipc_signals').selectAll().where('id', '=', id).executeTakeFirst();
    if (!s) throw new NotFoundException('სიგნალი ვერ მოიძებნა');
    const sc = await this.c.scope(u);
    if (!sc.full && (!s.department_id || !sc.depts.includes(s.department_id))) throw new ForbiddenException({ code: 'OUT_OF_SCOPE', message: 'სიგნალი თქვენი განყოფილების არ არის' });
    return s;
  }

  async act(id: string, kind: 'watch' | 'dismiss' | 'reopen', d: { days?: number; reason?: string; note?: string }, u: AuthUser, req: Request) {
    await this.c.rules();
    const s = await this.one(id, u);
    if (s.status === 'case') throw new ConflictException({ code: 'SIGNAL_CASE', message: 'სიგნალი უკვე მიბმულია HAI შემთხვევაზე' });
    if (kind === 'reopen' && s.status === 'open') throw new ConflictException({ code: 'NO_CHANGE', message: 'სიგნალი უკვე ღიაა' });
    if (kind !== 'reopen' && s.status === (kind === 'watch' ? 'watch' : 'dismissed')) throw new ConflictException({ code: 'NO_CHANGE', message: 'სტატუსი უკვე ასეა' });
    const vals = kind === 'watch' ? { status: 'watch', watch_until: sql<Date>`now() + make_interval(days => ${d.days ?? 2})`, dismiss_reason: null }
      : kind === 'dismiss' ? { status: 'dismissed', watch_until: null, dismiss_reason: d.reason!.trim() } : { status: 'open', watch_until: null, dismiss_reason: null };
    await this.db.updateTable('ipc_signals').set({ ...vals, handled_by: u.id, handled_at: sql`now()` }).where('id', '=', id).execute();
    await this.audit.log(auditCtx(req), { action: `IPC_SIGNAL_${kind.toUpperCase()}`, entityName: 'ipc_signals', entityId: id, oldData: { status: s.status }, newData: d });
    return (await this.list(u, { status: 'all' })).find((x) => x.id === id);
  }

  async scanNow(u: AuthUser, req: Request) {
    await this.c.rules();
    if (!has(u, ...IPC_FULL)) throw new ForbiddenException('შემოწმებას იწყებს ინფექციის კონტროლი');
    const r = await this.scan();
    await this.audit.log(auditCtx(req), { action: 'IPC_SIGNAL_SCAN', entityName: 'ipc_signals', entityId: 'scan', newData: r });
    return r;
  }
}

@Controller('ipc/signals')
export class IpcSignalsController {
  constructor(private readonly s: IpcSignalsService) {}
  @Get() @Roles(...IPC_ANY) list(@CurrentUser() u: AuthUser, @Query('status') status?: string, @Query('kind') kind?: string, @Query('department_id') department_id?: string) {
    return this.s.list(u, { status, kind, department_id });
  }
  @Post('scan') @HttpCode(200) @Roles(...IPC_FULL) scan(@CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.scanNow(u, r); }
  @Post(':id/watch') @HttpCode(200) @Roles(...IPC_ANY) watch(@Param('id', ParseUUIDPipe) id: string, @Body() d: WatchDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.act(id, 'watch', d, u, r); }
  @Post(':id/dismiss') @HttpCode(200) @Roles(...IPC_ANY) dismiss(@Param('id', ParseUUIDPipe) id: string, @Body() d: DismissDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.act(id, 'dismiss', d, u, r); }
  @Post(':id/reopen') @HttpCode(200) @Roles(...IPC_ANY) reopen(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.act(id, 'reopen', {}, u, r); }
}
