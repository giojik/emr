import { BadRequestException, Controller, Get, Injectable, Query } from '@nestjs/common';
import { sql } from 'kysely';
import { Roles } from '../auth/decorators';
import { loadEnv } from '../config/env';
import { InjectDb, type Database } from '../database/database.module';
import { DRG_READ } from './drg-data';

const TZ = loadEnv().CLINIC_TZ;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const r2 = (x: number) => Math.round(x * 100) / 100;
const r4 = (x: number) => Math.round(x * 10_000) / 10_000;
export const CMI_BY = ['department', 'doctor', 'month', 'payer'] as const;
type By = (typeof CMI_BY)[number];

interface CaseRow {
  encounter_id: string; adm_no: string; patient: string; finalized: string; month: string; payer_id: string; payer_name: string; dept: string | null; doctor: string | null;
  drg_code: string; title: string | null; kind: string | null; mdc: string | null; weight: string; amount: string | null; los: number; alos: string | null; los_low: number | null; los_high: number | null;
  scheme: string | null; version: string | null;
}
interface Agg { key: string; title: string; cases: number; weight: number; cmi: number; los: number; avg_los: number; alos_cases: number; alos_sum: number; los_alos_sum: number;
  los_index: number | null; high: number; low: number; surgical: number; amount: number }

/**
 * 0058: DRG ანგარიში — CMI (Case Mix Index = შემთხვევების საშუალო წონა), ჯგუფების განაწილება, ხანგრძლივობა ALOS-თან (los_index), outlier-ები.
 * შემთხვევა: ფინალიზებული სტაციონარი პერიოდში (ფინალიზაციის დღე), DRG გადამხდელით (stay_payers.mode = drg; რამდენიმესგან — პირველი რიგით).
 */
@Injectable()
export class DrgReportsService {
  constructor(@InjectDb() private readonly db: Database) {}

  async cmi(q: { from: string; to: string; by: By; scheme_id?: string; payer_id?: string; dept?: string }) {
    const cases = (await sql<CaseRow>`
      SELECT DISTINCT ON (st.encounter_id) st.encounter_id, st.adm_no, p.last_name || ' ' || p.first_name AS patient,
             to_char(fin_local_date(i.finalized_at), 'YYYY-MM-DD') AS finalized, to_char(fin_local_date(i.finalized_at), 'YYYY-MM') AS month,
             py.id AS payer_id, py.name AS payer_name, coalesce(bd.name, d.name) AS dept,
             CASE WHEN u.id IS NOT NULL THEN u.last_name || ' ' || u.first_name END AS doctor,
             sp.drg_code, coalesce(g.title, og.title) AS title, g.kind, coalesce(g.mdc, og.mdc) AS mdc, sp.drg_weight::text AS weight,
             coalesce(sp.drg_amount, round(sp.drg_weight * sp.drg_base_rate, 2))::text AS amount,
             greatest(1, ((coalesce(st.ended_at, i.finalized_at) AT TIME ZONE ${TZ})::date - (st.admitted_at AT TIME ZONE ${TZ})::date))::int AS los,
             coalesce(g.alos, og.alos)::text AS alos, g.los_low, g.los_high, s.code AS scheme,
             CASE WHEN v.id IS NOT NULL THEN s.code || ' v' || v.version_no END AS version
        FROM inpatient_stays st JOIN invoices i ON i.encounter_id = st.encounter_id JOIN encounters e ON e.id = st.encounter_id JOIN patients p ON p.id = st.patient_id
        JOIN stay_payers sp ON sp.encounter_id = st.encounter_id AND sp.status = 'active' AND sp.mode = 'drg' AND sp.drg_code IS NOT NULL
        JOIN payers py ON py.id = sp.payer_id
        LEFT JOIN drg_version_groups g ON g.version_id = sp.drg_version_id AND g.code = sp.drg_code
        LEFT JOIN drg_groups og ON og.code = sp.drg_code
        LEFT JOIN drg_versions v ON v.id = sp.drg_version_id LEFT JOIN drg_schemes s ON s.id = v.scheme_id
        LEFT JOIN departments d ON d.id = e.department_id
        LEFT JOIN users u ON u.id = e.attending_doctor_id
        LEFT JOIN LATERAL (SELECT dd.name FROM bed_assignments a JOIN departments dd ON dd.id = a.department_id WHERE a.encounter_id = st.encounter_id AND a.end_kind IS DISTINCT FROM 'cancel'
                            ORDER BY a.ended_at IS NULL DESC, a.started_at DESC, a.id DESC LIMIT 1) bd ON TRUE
       WHERE st.status <> 'cancelled' AND i.finalized_at IS NOT NULL AND fin_local_date(i.finalized_at) BETWEEN ${q.from}::date AND ${q.to}::date
         ${q.scheme_id ? sql`AND (v.scheme_id = ${q.scheme_id}::uuid OR (v.id IS NULL AND py.drg_scheme_id = ${q.scheme_id}::uuid))` : sql``}
         ${q.payer_id ? sql`AND sp.payer_id = ${q.payer_id}::uuid` : sql``}
       ORDER BY st.encounter_id, sp.seq`.execute(this.db)).rows;
    const list = q.dept ? cases.filter((c) => (c.dept ?? '—') === q.dept) : cases;

    const empty = (key: string, title: string): Agg => ({ key, title, cases: 0, weight: 0, cmi: 0, los: 0, avg_los: 0, alos_cases: 0, alos_sum: 0, los_alos_sum: 0, los_index: null,
      high: 0, low: 0, surgical: 0, amount: 0 });
    const add = (a: Agg, c: CaseRow) => {
      a.cases++; a.weight += Number(c.weight); a.los += c.los; a.amount += Number(c.amount ?? 0);
      if (c.alos !== null) { a.alos_cases++; a.alos_sum += Number(c.alos); a.los_alos_sum += c.los; }
      if (c.los_high !== null && c.los > c.los_high) a.high++;
      if (c.los_low !== null && c.los < c.los_low) a.low++;
      if (c.kind === 'surgical') a.surgical++;
    };
    const fin = (a: Agg) => ({ ...a, weight: r4(a.weight), cmi: a.cases ? r4(a.weight / a.cases) : 0, avg_los: a.cases ? Math.round((a.los / a.cases) * 10) / 10 : 0,
      alos: a.alos_cases ? Math.round((a.alos_sum / a.alos_cases) * 10) / 10 : null, los_index: a.alos_sum ? r2(a.los_alos_sum / a.alos_sum) : null, amount: r2(a.amount),
      surgical_pct: a.cases ? r2((a.surgical / a.cases) * 100) : 0 });

    const total = empty('total', 'სულ');
    const dim = new Map<string, Agg>(); const groups = new Map<string, Agg & { kind: string | null; mdc: string | null; alos_group: string | null }>();
    const keyOf = (c: CaseRow): [string, string] => q.by === 'doctor' ? [c.doctor ?? '—', c.doctor ?? '— (მკურნალი ექიმი არ არის)'] : q.by === 'month' ? [c.month, c.month]
      : q.by === 'payer' ? [c.payer_id, c.payer_name] : [c.dept ?? '—', c.dept ?? '—'];
    for (const c of list) {
      add(total, c);
      const [k, t] = keyOf(c); const a = dim.get(k) ?? empty(k, t); add(a, c); dim.set(k, a);
      const g = groups.get(c.drg_code) ?? { ...empty(c.drg_code, c.title ?? c.drg_code), kind: c.kind, mdc: c.mdc, alos_group: c.alos };
      add(g, c); groups.set(c.drg_code, g);
    }
    const t = fin(total);
    return {
      from: q.from, to: q.to, by: q.by, totals: t,
      rows: [...dim.values()].map(fin).sort((a, b) => (q.by === 'month' ? a.key.localeCompare(b.key) : b.weight - a.weight)),
      groups: [...groups.values()].map((g) => ({ ...fin(g), kind: g.kind, mdc: g.mdc, share_pct: t.cases ? r2((g.cases / t.cases) * 100) : 0,
        weight_share_pct: t.weight ? r2((g.weight / t.weight) * 100) : 0 })).sort((a, b) => b.weight - a.weight),
      // outlier-ები (ხანგრძლივობა ზღვრებს გარეთ)
      outliers: list.filter((c) => (c.los_high !== null && c.los > c.los_high) || (c.los_low !== null && c.los < c.los_low)).slice(0, 300)
        .map((c) => ({ encounter_id: c.encounter_id, adm_no: c.adm_no, patient: c.patient, drg_code: c.drg_code, title: c.title, los: c.los, los_low: c.los_low, los_high: c.los_high,
          alos: c.alos === null ? null : Number(c.alos), kind: c.los_high !== null && c.los > c.los_high ? 'high' : 'low', dept: c.dept, finalized: c.finalized })),
      unmapped: list.filter((c) => c.title === null).length,
    };
  }
}

@Controller('drg/reports')
export class DrgReportsController {
  constructor(private readonly s: DrgReportsService) {}
  @Get('cmi') @Roles(...DRG_READ)
  cmi(@Query('from') from: string, @Query('to') to: string, @Query('by') by?: string, @Query('scheme_id') scheme?: string, @Query('payer_id') payer?: string, @Query('dept') dept?: string) {
    if (!from || !to || !DATE_RE.test(from) || !DATE_RE.test(to) || from > to) throw new BadRequestException('პერიოდი: from ≤ to (YYYY-MM-DD)');
    if (Date.parse(to) - Date.parse(from) > 3 * 366 * 86_400_000) throw new BadRequestException('პერიოდი — მაქსიმუმ 3 წელი');
    const b = (by ?? 'department') as By;
    if (!CMI_BY.includes(b)) throw new BadRequestException(`by: ${CMI_BY.join(' | ')}`);
    for (const x of [scheme, payer]) if (x && !/^[0-9a-f-]{36}$/i.test(x)) throw new BadRequestException('არასწორი id');
    return this.s.cmi({ from, to, by: b, scheme_id: scheme, payer_id: payer, dept: dept?.slice(0, 200) });
  }
}
