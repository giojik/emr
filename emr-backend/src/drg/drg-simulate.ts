import { BadRequestException, Body, Controller, HttpCode, Injectable, Post } from '@nestjs/common';
import { IsBoolean, IsDateString, IsNumber, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { sql } from 'kysely';
import { Roles } from '../auth/decorators';
import { loadEnv } from '../config/env';
import { InjectDb, type Database } from '../database/database.module';
import { group } from './drg-engine';
import { DRG_READ, gatherInputs, loadVersion, stayInfo, versionMeta } from './drg-data';
import { price } from './drg-pricing';

const TZ = loadEnv().CLINIC_TZ;
const r2 = (x: number) => Math.round(x * 100) / 100;
const r4 = (x: number) => Math.round(x * 10_000) / 10_000;
const MAX_CASES = 3000;

interface Side { code: string | null; title: string | null; weight: number | null; amount: number | null; fallback?: boolean; issue?: string | null }
interface SimRow {
  encounter_id: string; adm_no: string; patient: string; dept: string | null; payer_name: string; finalized: string; los: number;
  base: Side; sim: Side; changed: boolean; diff: number | null;
}

/**
 * 0059: სიმულაცია — DRG ვერსიის (მათ შორის მონახაზის) გავლენა პერიოდის შემთხვევებზე. ბაზაში არაფერი იწერება.
 *   შემთხვევა: ფინანსურად დახურული სტაციონარი პერიოდში, ამ სქემის DRG გადამხდელით (როგორც CMI-ში).
 *   საწყისი (base): ფაქტობრივი (გადამხდელზე დაფიქსირებული ჯგუფი / წონა / თანხა) ან სხვა ვერსია (base_version_id).
 *   ახალი (sim): ვერსიის წესებით დაჯგუფება + ფორმულით თანხა; განაკვეთი — გადამხდელის (ან base_rate).
 */
@Injectable()
export class DrgSimulateService {
  constructor(@InjectDb() private readonly db: Database) {}

  async run(d: SimulateDto) {
    if (d.from > d.to) throw new BadRequestException('პერიოდი: from ≤ to');
    if (Date.parse(d.to) - Date.parse(d.from) > 3 * 366 * 86_400_000) throw new BadRequestException('პერიოდი — მაქსიმუმ 3 წელი');
    const tm = await versionMeta(this.db, d.version_id);
    if (!tm || tm.scheme_id !== d.scheme_id) throw new BadRequestException('ვერსია ამ სქემას არ ეკუთვნის');
    const bm = d.base_version_id ? await versionMeta(this.db, d.base_version_id) : null;
    if (d.base_version_id && (!bm || bm.scheme_id !== d.scheme_id)) throw new BadRequestException('საწყისი ვერსია ამ სქემას არ ეკუთვნის');
    const cases = (await sql<{ encounter_id: string; adm_no: string; patient: string; dept: string | null; payer_id: string; payer_name: string; finalized: string; invoice_id: string;
      drg_code: string; drg_weight: string; drg_base_rate: string | null; amount: string | null; title: string | null }>`
      SELECT DISTINCT ON (st.encounter_id) st.encounter_id, st.adm_no, p.last_name || ' ' || p.first_name AS patient, coalesce(bd.name, dp.name) AS dept,
             py.id AS payer_id, py.name AS payer_name, to_char(fin_local_date(i.finalized_at), 'YYYY-MM-DD') AS finalized, i.id AS invoice_id,
             sp.drg_code, sp.drg_weight::text, sp.drg_base_rate::text, coalesce(sp.drg_amount, round(sp.drg_weight * sp.drg_base_rate, 2))::text AS amount,
             coalesce(g.title, og.title) AS title
        FROM inpatient_stays st JOIN invoices i ON i.encounter_id = st.encounter_id JOIN encounters e ON e.id = st.encounter_id JOIN patients p ON p.id = st.patient_id
        JOIN stay_payers sp ON sp.encounter_id = st.encounter_id AND sp.status = 'active' AND sp.mode = 'drg' AND sp.drg_code IS NOT NULL
        JOIN payers py ON py.id = sp.payer_id
        LEFT JOIN drg_versions v ON v.id = sp.drg_version_id
        LEFT JOIN drg_version_groups g ON g.version_id = sp.drg_version_id AND g.code = sp.drg_code
        LEFT JOIN drg_groups og ON og.code = sp.drg_code
        LEFT JOIN departments dp ON dp.id = e.department_id
        LEFT JOIN LATERAL (SELECT dd.name FROM bed_assignments a JOIN departments dd ON dd.id = a.department_id WHERE a.encounter_id = st.encounter_id AND a.end_kind IS DISTINCT FROM 'cancel'
                            ORDER BY a.ended_at IS NULL DESC, a.started_at DESC, a.id DESC LIMIT 1) bd ON TRUE
       WHERE st.status <> 'cancelled' AND i.finalized_at IS NOT NULL AND fin_local_date(i.finalized_at) BETWEEN ${d.from}::date AND ${d.to}::date
         AND (v.scheme_id = ${d.scheme_id}::uuid OR (v.id IS NULL AND coalesce(py.drg_scheme_id, (SELECT id FROM drg_schemes WHERE is_default)) = ${d.scheme_id}::uuid))
         ${d.payer_id ? sql`AND sp.payer_id = ${d.payer_id}::uuid` : sql``}
       ORDER BY st.encounter_id, sp.seq`.execute(this.db)).rows;
    if (cases.length > MAX_CASES) throw new BadRequestException(`შემთხვევა ${cases.length} — მაქსიმუმ ${MAX_CASES}; შეამცირეთ პერიოდი`);

    // ზღვრები (los_low / los_high) — loadVersion-ში არ შედის
    const bounds = async (vid: string) => new Map((await this.db.selectFrom('drg_version_groups').select(['code', 'alos', 'los_low', 'los_high']).where('version_id', '=', vid).execute())
      .map((g) => [g.code, { alos: g.alos === null ? null : Number(g.alos), los_low: g.los_low, los_high: g.los_high }]));
    const vt = { ...(await loadVersion(this.db, d.version_id)), bounds: await bounds(d.version_id) };
    const vb = d.base_version_id ? { ...(await loadVersion(this.db, d.base_version_id)), bounds: await bounds(d.base_version_id) } : null;
    // ფაქტობრივი ხარჯი (ინვოისი, პაკეტში შემავალის გარდა) — cost_outlier-ისთვის
    const charges = new Map((await sql<{ invoice_id: string; s: string }>`
      SELECT invoice_id, sum(line_total)::text AS s FROM invoice_line_items WHERE invoice_id = ANY(${cases.map((c) => c.invoice_id)}::uuid[]) AND NOT package_included GROUP BY invoice_id`
      .execute(this.db)).rows.map((r) => [r.invoice_id, Number(r.s)]));

    const calc = async (v: typeof vt, eid: string, rate: number, chg: number | null): Promise<Side & { los: number }> => {
      const st = await stayInfo(this.db, eid);
      if (!st) return { code: null, title: null, weight: null, amount: null, issue: 'ჰოსპიტალიზაცია ვერ მოიძებნა', los: 0 };
      const { inputs } = await gatherInputs(this.db, st, v.settings);
      const g = group(inputs, v);
      if (!g.code || g.weight === null) return { code: null, title: null, weight: null, amount: null, issue: g.issues.map((x) => x.message).join('; ') || 'ვერ დაჯგუფდა', los: inputs.los };
      const b = v.bounds.get(g.code);
      const pr = price(v.components ?? [], v, { code: g.code, weight: g.weight, alos: b?.alos ?? null, los_low: b?.los_low ?? null, los_high: b?.los_high ?? null }, rate, inputs, g.cc_level, chg);
      return { code: g.code, title: g.title, weight: g.weight, amount: r2(pr.total), fallback: g.fallback, issue: g.fallback ? 'ნაგულისხმევი ჯგუფი' : null, los: inputs.los };
    };

    const rows: SimRow[] = [];
    for (const c of cases) {
      const rate = d.base_rate ?? Number(c.drg_base_rate ?? 0);
      const chg = charges.get(c.invoice_id) ?? null;
      const sim = await calc(vt, c.encounter_id, rate, chg);
      const base: Side = vb ? await calc(vb, c.encounter_id, rate, chg)
        : { code: c.drg_code, title: c.title, weight: Number(c.drg_weight), amount: c.amount === null ? null : Number(c.amount) };
      const diff = sim.amount !== null && base.amount !== null ? r2(sim.amount - base.amount) : null;
      rows.push({ encounter_id: c.encounter_id, adm_no: c.adm_no, patient: c.patient, dept: c.dept, payer_name: c.payer_name, finalized: c.finalized, los: sim.los,
        base: { code: base.code, title: base.title, weight: base.weight, amount: base.amount, issue: base.issue ?? null }, sim: { code: sim.code, title: sim.title, weight: sim.weight, amount: sim.amount, fallback: sim.fallback, issue: sim.issue },
        changed: base.code !== sim.code || (base.weight ?? 0) !== (sim.weight ?? 0) || diff !== 0, diff });
    }

    const sum = (f: (r: SimRow) => number | null) => r2(rows.reduce((s, r) => s + (f(r) ?? 0), 0));
    const okB = rows.filter((r) => r.base.weight !== null); const okS = rows.filter((r) => r.sim.weight !== null);
    const totals = {
      cases: rows.length, grouped: okS.length, ungrouped: rows.length - okS.length, fallback: rows.filter((r) => r.sim.fallback).length,
      changed_group: rows.filter((r) => r.base.code !== r.sim.code).length, changed_amount: rows.filter((r) => r.diff !== null && r.diff !== 0).length,
      cmi_base: okB.length ? r4(okB.reduce((s, r) => s + r.base.weight!, 0) / okB.length) : 0,
      cmi_sim: okS.length ? r4(okS.reduce((s, r) => s + r.sim.weight!, 0) / okS.length) : 0,
      amount_base: sum((r) => r.base.amount), amount_sim: sum((r) => r.sim.amount), diff: sum((r) => r.diff),
    };
    const pct = (a: number, b: number) => (a ? r2(((b - a) / a) * 100) : null);
    // გადასვლები: ძველი ჯგუფი → ახალი
    const tr = new Map<string, { from: string | null; from_title: string | null; to: string | null; to_title: string | null; cases: number; amount_base: number; amount_sim: number }>();
    for (const r of rows) {
      const k = `${r.base.code ?? '—'}→${r.sim.code ?? '—'}`;
      const t = tr.get(k) ?? { from: r.base.code, from_title: r.base.title, to: r.sim.code, to_title: r.sim.title, cases: 0, amount_base: 0, amount_sim: 0 };
      t.cases++; t.amount_base = r2(t.amount_base + (r.base.amount ?? 0)); t.amount_sim = r2(t.amount_sim + (r.sim.amount ?? 0)); tr.set(k, t);
    }
    const byDept = new Map<string, { dept: string; cases: number; w_base: number; w_sim: number; n_base: number; n_sim: number; amount_base: number; amount_sim: number; changed: number }>();
    for (const r of rows) {
      const k = r.dept ?? '—';
      const x = byDept.get(k) ?? { dept: k, cases: 0, w_base: 0, w_sim: 0, n_base: 0, n_sim: 0, amount_base: 0, amount_sim: 0, changed: 0 };
      x.cases++; if (r.base.weight !== null) { x.w_base += r.base.weight; x.n_base++; } if (r.sim.weight !== null) { x.w_sim += r.sim.weight; x.n_sim++; }
      x.amount_base = r2(x.amount_base + (r.base.amount ?? 0)); x.amount_sim = r2(x.amount_sim + (r.sim.amount ?? 0)); if (r.changed) x.changed++;
      byDept.set(k, x);
    }
    return {
      scheme_id: d.scheme_id, from: d.from, to: d.to,
      version: { id: tm.id, label: tm.label, version_no: tm.version_no, status: tm.status },
      base: bm ? { kind: 'version', id: bm.id, label: bm.label, version_no: bm.version_no, status: bm.status } : { kind: 'actual' },
      base_rate: d.base_rate ?? null,
      totals: { ...totals, diff_pct: pct(totals.amount_base, totals.amount_sim), cmi_diff: r4(totals.cmi_sim - totals.cmi_base) },
      transitions: [...tr.values()].filter((t) => t.from !== t.to).sort((a, b) => b.cases - a.cases || Math.abs(b.amount_sim - b.amount_base) - Math.abs(a.amount_sim - a.amount_base)),
      by_department: [...byDept.values()].map((x) => ({ dept: x.dept, cases: x.cases, changed: x.changed, cmi_base: x.n_base ? r4(x.w_base / x.n_base) : 0, cmi_sim: x.n_sim ? r4(x.w_sim / x.n_sim) : 0,
        amount_base: x.amount_base, amount_sim: x.amount_sim, diff: r2(x.amount_sim - x.amount_base) })).sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff)),
      rows: (d.only_changed ? rows.filter((r) => r.changed) : rows).sort((a, b) => Math.abs(b.diff ?? 0) - Math.abs(a.diff ?? 0)).slice(0, 2000),
      tz: TZ,
    };
  }
}

export class SimulateDto {
  @IsUUID() scheme_id: string;
  @IsUUID() version_id: string;
  @IsOptional() @IsUUID() base_version_id?: string;
  @IsDateString({ strict: true }) from: string;
  @IsDateString({ strict: true }) to: string;
  @IsOptional() @IsUUID() payer_id?: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(10_000_000) base_rate?: number;
  @IsOptional() @IsBoolean() only_changed?: boolean;
}

@Controller('drg')
export class DrgSimulateController {
  constructor(private readonly s: DrgSimulateService) {}
  /** სიმულაცია — მხოლოდ გამოთვლა (POST — პარამეტრები სხეულში) */
  @Post('simulate') @HttpCode(200) @Roles(...DRG_READ) run(@Body() d: SimulateDto) { return this.s.run(d); }
}
