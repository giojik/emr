import { BadRequestException, Controller, Get, Injectable, Query } from '@nestjs/common';
import { IsOptional, IsUUID, Matches } from 'class-validator';
import { sql } from 'kysely';
import { Roles } from '../auth/decorators';
import { InjectDb, type Database } from '../database/database.module';
import { OrService } from './or';
import { TZ } from './or-shared';

export class StatsQuery {
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) from?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) to?: string;
  @IsOptional() @IsUUID() block_id?: string;
}
const r1 = (n: number | null | undefined) => (n === null || n === undefined || Number.isNaN(n) ? null : Math.round(n * 10) / 10);
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/**
 * საოპერაციოს სტატისტიკა (0050, #13): პერიოდი (ნაგ. ბოლო 30 დღე, მაქს. 366), ბლოკის ფილტრი.
 *  • დატვირთვა — ოთახის სამუშაო საათები (სამუშაო დღეებში) ↔ ფაქტობრივი დრო ოთახში (შემოვიდა → გავიდა, სამუშაო საათებში);
 *  • პირველი ოპერაციის დროული დაწყება — ოთახი × დღე, დაგეგმილი პირველი (გადაუდებლის გარეშე): „შემოვიდა“ ≤ დაგეგმილი + first_case_tolerance_min;
 *  • მომზადების დრო (turnover) — იმავე ოთახში, იმავე დღეს: წინა „გავიდა“ → შემდეგი „შემოვიდა“ (≤ 180 წთ; დიდი შუალედი — არა turnover);
 *  • გაუქმებები — მიზეზებით (+ იმავე დღეს გაუქმებული), გადადებები;
 *  • გართულებები — ოქმი (ხელმოწერილი), ანესთეზიის რუკა, PACU; PACU — ხანგრძლივობა, მიმართულება, Aldrete, PONV; ქირურგების მიხედვით.
 */
@Injectable()
export class OrStatsService {
  constructor(@InjectDb() private readonly db: Database, private readonly or: OrService) {}

  async stats(q: StatsQuery) {
    const s = await this.or.settings();
    const today = (await sql<{ d: string }>`SELECT (now() AT TIME ZONE ${TZ})::date::text AS d`.execute(this.db)).rows[0].d;
    const to = q.to ?? today;
    const from = q.from ?? (await sql<{ d: string }>`SELECT (${to}::date - 29)::text AS d`.execute(this.db)).rows[0].d;
    if (from > to) throw new BadRequestException('პერიოდი: „დან“ > „მდე“');
    const days = (await sql<{ n: number }>`SELECT (${to}::date - ${from}::date + 1)::int AS n`.execute(this.db)).rows[0].n;
    if (days > 366) throw new BadRequestException('პერიოდი — მაქსიმუმ 366 დღე');
    const blk = q.block_id ?? null;
    const lo = sql`(${from}::date::timestamp AT TIME ZONE ${TZ})`;
    const hi = sql`((${to}::date + 1)::timestamp AT TIME ZONE ${TZ})`;

    // ოპერაციები ფაქტობრივი დროით (დასრულებული / მიმდინარე) — „შემოვიდა“ პერიოდში
    const cases = (await sql<{ id: string; case_no: string; status: string; urgency: string; room_id: string; room_code: string; block_id: string; surgeon_id: string; surgeon_name: string;
      scheduled_start: Date; in_room: Date; out_room: Date | null; incision: Date | null; closure: Date | null; an_start: Date | null; an_end: Date | null; pacu_in: Date | null; pacu_out: Date | null;
      pacu_dest: string | null; day: string; note_compl: string | null; anest_compl: string | null; pacu_compl: string | null; pacu_aldrete: number | null; ponv: boolean }>`
      WITH t AS (SELECT case_id, kind, at, destination FROM or_case_times WHERE superseded_by IS NULL)
      SELECT c.id, c.case_no, c.status, c.urgency, c.room_id, r.code AS room_code, c.block_id, c.surgeon_id, su.last_name || ' ' || su.first_name AS surgeon_name, c.scheduled_start,
             ti.at AS in_room, (SELECT at FROM t WHERE t.case_id = c.id AND t.kind = 'out_of_room') AS out_room,
             (SELECT at FROM t WHERE t.case_id = c.id AND t.kind = 'incision') AS incision, (SELECT at FROM t WHERE t.case_id = c.id AND t.kind = 'closure') AS closure,
             (SELECT at FROM t WHERE t.case_id = c.id AND t.kind = 'anesthesia_start') AS an_start, (SELECT at FROM t WHERE t.case_id = c.id AND t.kind = 'anesthesia_end') AS an_end,
             (SELECT at FROM t WHERE t.case_id = c.id AND t.kind = 'pacu_in') AS pacu_in, (SELECT at FROM t WHERE t.case_id = c.id AND t.kind = 'pacu_out') AS pacu_out,
             (SELECT destination FROM t WHERE t.case_id = c.id AND t.kind = 'pacu_out') AS pacu_dest,
             (ti.at AT TIME ZONE ${TZ})::date::text AS day,
             (SELECT n.complications FROM or_op_notes n WHERE n.case_id = c.id AND n.status = 'signed' AND n.superseded_at IS NULL AND NOT n.complications_none
                 AND length(btrim(coalesce(n.complications, ''))) > 0) AS note_compl,
             (SELECT nullif(btrim(a.complications), '') FROM or_anesthesia_records a WHERE a.case_id = c.id) AS anest_compl,
             (SELECT nullif(btrim(p.complications), '') FROM or_pacu p WHERE p.case_id = c.id) AS pacu_compl,
             (SELECT p.discharge_aldrete FROM or_pacu p WHERE p.case_id = c.id) AS pacu_aldrete,
             EXISTS (SELECT 1 FROM or_pacu_scores sc WHERE sc.case_id = c.id AND sc.voided_at IS NULL AND sc.ponv) AS ponv
        FROM or_cases c JOIN t ti ON ti.case_id = c.id AND ti.kind = 'in_room'
        JOIN users su ON su.id = c.surgeon_id LEFT JOIN or_rooms r ON r.id = c.room_id
       WHERE c.status IN ('in_progress', 'completed') AND ti.at >= ${lo} AND ti.at < ${hi} AND (${blk}::uuid IS NULL OR c.block_id = ${blk}::uuid)
       ORDER BY c.room_id, ti.at`.execute(this.db)).rows;
    const mins = (a: Date | null, b: Date | null) => (a && b ? (new Date(b).getTime() - new Date(a).getTime()) / 60000 : null);
    const done = cases.filter((c) => c.status === 'completed' && c.out_room);
    const avg = (xs: (number | null)[]) => { const v = xs.filter((x): x is number => x !== null && x >= 0); return v.length ? r1(v.reduce((a, b) => a + b, 0) / v.length) : null; };

    // ---- დატვირთვა ოთახებზე
    const rooms = (await sql<{ id: string; code: string; name: string; block_name: string; avail_min: number }>`
      SELECT r.id, r.code, r.name, d.name AS block_name,
             ((SELECT count(*) FROM generate_series(${from}::date, ${to}::date, interval '1 day') g(dd) WHERE extract(isodow FROM g.dd)::int = ANY(r.work_days))
               * extract(epoch FROM (r.work_end - r.work_start)) / 60)::int AS avail_min
        FROM or_rooms r JOIN departments d ON d.id = r.department_id
       WHERE (r.is_active OR EXISTS (SELECT 1 FROM or_cases c WHERE c.room_id = r.id)) AND (${blk}::uuid IS NULL OR r.department_id = ${blk}::uuid)
       ORDER BY d.name, r.sort_order, r.code`.execute(this.db)).rows;
    const used = (await sql<{ room_id: string; used_min: number; n: number }>`
      WITH t AS (SELECT case_id, kind, at FROM or_case_times WHERE superseded_by IS NULL),
           x AS (SELECT c.room_id, ti.at AS a, to2.at AS b, r.work_start, r.work_end, (ti.at AT TIME ZONE ${TZ})::date AS d
                   FROM or_cases c JOIN or_rooms r ON r.id = c.room_id JOIN t ti ON ti.case_id = c.id AND ti.kind = 'in_room' JOIN t to2 ON to2.case_id = c.id AND to2.kind = 'out_of_room'
                  WHERE c.status = 'completed' AND ti.at >= ${lo} AND ti.at < ${hi} AND (${blk}::uuid IS NULL OR c.block_id = ${blk}::uuid))
      SELECT room_id, count(*)::int AS n,
             coalesce(sum(greatest(0, extract(epoch FROM (least(b, (d + work_end) AT TIME ZONE ${TZ}) - greatest(a, (d + work_start) AT TIME ZONE ${TZ}))) / 60)), 0)::int AS used_min
        FROM x GROUP BY room_id`.execute(this.db)).rows;
    const um = new Map(used.map((u) => [u.room_id, u]));
    const util = rooms.map((r) => { const u = um.get(r.id); return { room_id: r.id, code: r.code, name: r.name, block_name: r.block_name, cases: u?.n ?? 0, available_min: r.avail_min,
      used_min: u?.used_min ?? 0, utilization_pct: pct(u?.used_min ?? 0, r.avail_min) }; });
    const totAvail = util.reduce((a, r) => a + r.available_min, 0); const totUsed = util.reduce((a, r) => a + r.used_min, 0);

    // ---- პირველი ოპერაციის დროული დაწყება (ოთახი × დღე; გადაუდებლის გარეშე)
    const firsts = new Map<string, (typeof cases)[number]>();
    for (const c of cases) {
      if (c.urgency === 'emergency' || !c.scheduled_start) continue;
      const k = `${c.room_id}|${c.day}`;
      const cur = firsts.get(k);
      if (!cur || new Date(c.scheduled_start) < new Date(cur.scheduled_start)) firsts.set(k, c);
    }
    const fc = [...firsts.values()].map((c) => ({ case_id: c.id, case_no: c.case_no, room_code: c.room_code, day: c.day, scheduled_start: c.scheduled_start, in_room: c.in_room,
      delay_min: Math.round(mins(c.scheduled_start, c.in_room)!) }));
    const onTime = fc.filter((x) => x.delay_min <= s.first_case_tolerance_min);
    const late = fc.filter((x) => x.delay_min > s.first_case_tolerance_min).sort((a, b) => b.delay_min - a.delay_min);

    // ---- მომზადების დრო (turnover)
    const turns: { room_code: string; day: string; from_case: string; to_case: string; minutes: number }[] = [];
    const byRoomDay = new Map<string, typeof cases>();
    for (const c of done) { const k = `${c.room_id}|${c.day}`; byRoomDay.set(k, [...(byRoomDay.get(k) ?? []), c]); }
    for (const list of byRoomDay.values()) {
      list.sort((a, b) => new Date(a.in_room).getTime() - new Date(b.in_room).getTime());
      for (let i = 1; i < list.length; i++) {
        const m = mins(list[i - 1].out_room, list[i].in_room);
        if (m !== null && m >= 0 && m <= 180) turns.push({ room_code: list[i].room_code, day: list[i].day, from_case: list[i - 1].case_no, to_case: list[i].case_no, minutes: Math.round(m) });
      }
    }
    const tm = turns.map((t) => t.minutes);

    // ---- გაუქმებები / გადადებები
    const canc = (await sql<{ code: string; name: string; n: number; same_day: number }>`
      SELECT cr.code, cr.name, count(*)::int AS n,
             count(*) FILTER (WHERE c.scheduled_start IS NOT NULL AND (c.scheduled_start AT TIME ZONE ${TZ})::date = (c.cancelled_at AT TIME ZONE ${TZ})::date)::int AS same_day
        FROM or_cases c JOIN or_cancel_reasons cr ON cr.code = c.cancel_reason_code
       WHERE c.status = 'cancelled' AND c.cancelled_at >= ${lo} AND c.cancelled_at < ${hi} AND (${blk}::uuid IS NULL OR c.block_id = ${blk}::uuid OR c.block_id IS NULL)
       GROUP BY cr.code, cr.name, cr.sort_order ORDER BY count(*) DESC, cr.sort_order`.execute(this.db)).rows;
    const postponed = (await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM or_case_events e JOIN or_cases c ON c.id = e.case_id
       WHERE e.kind = 'unscheduled' AND e.at >= ${lo} AND e.at < ${hi}`.execute(this.db)).rows[0].n;
    const scheduledN = (await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM or_cases c WHERE c.scheduled_start >= ${lo} AND c.scheduled_start < ${hi} AND c.status IN ('scheduled', 'in_progress', 'completed', 'cancelled')
         AND (${blk}::uuid IS NULL OR c.block_id = ${blk}::uuid)`.execute(this.db)).rows[0].n;
    const cancN = canc.reduce((a, c) => a + c.n, 0);

    // ---- გართულებები
    const compl = done.filter((c) => c.note_compl || c.anest_compl || c.pacu_compl).map((c) => ({ case_id: c.id, case_no: c.case_no, day: c.day, surgeon_name: c.surgeon_name,
      surgical: c.note_compl, anesthesia: c.anest_compl, pacu: c.pacu_compl }));

    // ---- PACU
    const pacu = done.filter((c) => c.pacu_in);
    const pacuOut = pacu.filter((c) => c.pacu_out);
    const dest = (k: string) => pacuOut.filter((c) => c.pacu_dest === k).length;

    // ---- ქირურგების მიხედვით
    const bySurgeon = new Map<string, { surgeon_id: string; surgeon_name: string; cases: number; dur: number[]; complications: number }>();
    for (const c of done) {
      const x = bySurgeon.get(c.surgeon_id) ?? { surgeon_id: c.surgeon_id, surgeon_name: c.surgeon_name, cases: 0, dur: [], complications: 0 };
      x.cases++; const d = mins(c.in_room, c.out_room); if (d !== null) x.dur.push(d);
      if (c.note_compl || c.anest_compl || c.pacu_compl) x.complications++;
      bySurgeon.set(c.surgeon_id, x);
    }

    return {
      from, to, days, block_id: blk, tolerance_min: s.first_case_tolerance_min, turnover_target_min: s.turnover_min,
      totals: {
        completed: done.length, in_progress: cases.length - done.length, emergency: done.filter((c) => c.urgency === 'emergency').length,
        avg_room_min: avg(done.map((c) => mins(c.in_room, c.out_room))), avg_surgery_min: avg(done.map((c) => mins(c.incision, c.closure))),
        avg_anesthesia_min: avg(done.map((c) => mins(c.an_start, c.an_end))),
      },
      utilization: { rooms: util, available_min: totAvail, used_min: totUsed, utilization_pct: pct(totUsed, totAvail) },
      first_case: { total: fc.length, on_time: onTime.length, on_time_pct: pct(onTime.length, fc.length), avg_delay_late_min: avg(late.map((x) => x.delay_min)), late: late.slice(0, 30) },
      turnover: { count: turns.length, avg_min: avg(tm), median_min: median(tm), over_target: tm.filter((m) => m > s.turnover_min).length,
        list: turns.sort((a, b) => b.minutes - a.minutes).slice(0, 30) },
      cancellations: { total: cancN, same_day: canc.reduce((a, c) => a + c.same_day, 0), postponed, scheduled: scheduledN, cancel_pct: pct(cancN, scheduledN), by_reason: canc },
      complications: { cases: compl.length, rate_pct: pct(compl.length, done.length), surgical: done.filter((c) => c.note_compl).length,
        anesthesia: done.filter((c) => c.anest_compl).length, pacu: done.filter((c) => c.pacu_compl).length, list: compl.slice(0, 50) },
      pacu: { admitted: pacu.length, discharged: pacuOut.length, avg_los_min: avg(pacuOut.map((c) => mins(c.pacu_in, c.pacu_out))),
        avg_discharge_aldrete: avg(pacuOut.map((c) => c.pacu_aldrete)), ponv: pacu.filter((c) => c.ponv).length,
        destinations: { ward: dest('ward'), icu: dest('icu'), other: dest('other') } },
      by_surgeon: [...bySurgeon.values()].map((x) => ({ surgeon_id: x.surgeon_id, surgeon_name: x.surgeon_name, cases: x.cases, avg_room_min: avg(x.dur), complications: x.complications }))
        .sort((a, b) => b.cases - a.cases),
    };
  }
}

@Controller('or')
export class OrStatsController {
  constructor(private readonly s: OrStatsService) {}
  @Get('stats') @Roles('admin', 'manager', 'or_schedule', 'viewer') stats(@Query() q: StatsQuery) { return this.s.stats(q); }
}
