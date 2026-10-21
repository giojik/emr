import { sql, type Transaction } from 'kysely';
import { loadEnv } from '../config/env';
import type { Database } from '../database/database.module';
import type { DB } from '../database/db';
import { ipcRules } from './ipc-common';

const TZ = loadEnv().CLINIC_TZ;
const PARENTERAL = ['IV', 'IM', 'SC', 'IO'];

export interface IpcFactRow {
  day: string; department_id: string | null;
  hai: number; clabsi: number; cauti: number; vap: number; ssi_ops: number; ssi: number; mdro_hosp: number; mdro_all: number;
  ddd: number; ddd_access: number; dot: number; hh_opps: number; hh_done: number; handrub_l: number;
}
const ZERO = { hai: 0, clabsi: 0, cauti: 0, vap: 0, ssi_ops: 0, ssi: 0, mdro_hosp: 0, mdro_all: 0, ddd: 0, ddd_access: 0, dot: 0, hh_opps: 0, hh_done: 0, handrub_l: 0 };

/**
 * 0072: IPC ფაქტები დღე × განყოფილება — ერთი გამოთვლა KPI-სთვის (rpt_fact_ipc, რეპორტინგის გადათვლა) და IPC ანგარიშისთვის (წყაროდან, იგივე წესით).
 *  • HAI — დადასტურებული, ინფექციის დღით, მიკუთვნებული განყოფილება; CLABSI / CAUTI / VAP — მოწყობილობასთან ასოცირებული bsi / uti / pn;
 *  • SSI — ოპერაციის დღით: დაკვირვება დასრულებულია (completed) ან SSI; განყოფილება — ოპერაციის;
 *  • MDRO — ახალი ფლაგი (აქტიური / მოხსნილი; შეთავაზება / გაუქმებული — არა), ნიმუშის დღით; განყოფილება — საწოლი იმ მომენტში / ვიზიტის;
 *  • DDD / Access / DOT — MAR (მიცემული), როგორც 0070-ის მაჩვენებლებში;
 *  • ხელის ჰიგიენა — დასრულებული აუდიტები (შესაძლებლობა / rub + wash); ანტისეპტიკი — მასალების ჯგუფი hand_rub (material_source).
 * მოდული გამორთულია → null.
 */
export async function ipcFactRows(db: Database, from: string, to: string): Promise<IpcFactRow[] | null> {
  const r = await ipcRules(db);
  if (!r) return null;
  const pre = sql.val(r.abx_atc_prefixes.map((p) => `${p}%`));
  const types = r.material_source === 'issue' ? ['transfer', 'issue', 'return'] : ['consumption', 'writeoff'];
  const sign = r.material_source === 'issue' ? 1 : -1;
  const deptAt = (enc: string, at: string) => sql`coalesce((SELECT a.department_id FROM bed_assignments a WHERE a.encounter_id = ${sql.ref(enc)} AND a.end_kind IS DISTINCT FROM 'cancel'
      AND a.started_at <= ${sql.ref(at)} ORDER BY a.started_at DESC LIMIT 1), (SELECT e.department_id FROM encounters e WHERE e.id = ${sql.ref(enc)}))`;
  const [hai, ssi, mdro, abx, hh, rub] = await Promise.all([
    sql<{ day: string; department_id: string | null; hai: number; clabsi: number; cauti: number; vap: number }>`
      SELECT h.onset_date::text AS day, h.department_id, count(*)::int AS hai,
             count(*) FILTER (WHERE h.hai_type = 'bsi' AND h.device_assoc)::int AS clabsi,
             count(*) FILTER (WHERE h.hai_type = 'uti' AND h.device_assoc)::int AS cauti,
             count(*) FILTER (WHERE h.hai_type = 'pn' AND h.device_assoc)::int AS vap
        FROM ipc_hai_cases h WHERE h.status = 'confirmed' AND h.onset_date BETWEEN ${from}::date AND ${to}::date GROUP BY 1, 2`.execute(db),
    sql<{ day: string; department_id: string | null; ssi_ops: number; ssi: number }>`
      SELECT o.op_date::text AS day, o.department_id, count(*)::int AS ssi_ops, count(*) FILTER (WHERE o.status = 'ssi')::int AS ssi
        FROM ipc_ssi_ops o WHERE o.status IN ('completed', 'ssi') AND o.op_date BETWEEN ${from}::date AND ${to}::date GROUP BY 1, 2`.execute(db),
    sql<{ day: string; department_id: string | null; mdro_hosp: number; mdro_all: number }>`
      WITH f AS (SELECT (coalesce(f.specimen_at, f.detected_at) AT TIME ZONE ${TZ})::date AS day, f.onset,
                        CASE WHEN f.encounter_id IS NULL THEN NULL ELSE ${deptAt('f.encounter_id', 'f.detected_at')} END AS department_id
                   FROM ipc_patient_flags f WHERE f.status IN ('active', 'cleared')
                    AND (coalesce(f.specimen_at, f.detected_at) AT TIME ZONE ${TZ})::date BETWEEN ${from}::date AND ${to}::date)
      SELECT day::text AS day, department_id, count(*) FILTER (WHERE onset = 'hospital')::int AS mdro_hosp, count(*)::int AS mdro_all FROM f GROUP BY 1, 2`.execute(db),
    sql<{ day: string; department_id: string | null; ddd: string; ddd_access: string; dot: number }>`
      WITH d AS (
        SELECT me.patient_id, coalesce(g.atc_code, 'X:' || g.inn) AS key, g.aware, (me.documented_at AT TIME ZONE ${TZ})::date AS day,
               coalesce(me.dose_given, o.dose) AS dose, coalesce(me.dose_unit, o.dose_unit) AS unit, g.ddd_unit,
               CASE WHEN coalesce(me.route_code, o.route_code) = ANY(${sql.val(PARENTERAL)}::text[]) THEN g.ddd_parenteral ELSE g.ddd_oral END AS ddd_ref,
               (SELECT a.department_id FROM bed_assignments a WHERE a.encounter_id = me.encounter_id AND a.started_at <= me.documented_at AND a.end_kind IS DISTINCT FROM 'cancel'
                 ORDER BY a.started_at DESC LIMIT 1) AS department_id
          FROM mar_entries me JOIN med_orders o ON o.id = me.order_id JOIN med_generics g ON g.id = o.generic_id
         WHERE me.status IN ('given', 'partial') AND me.voided_at IS NULL AND g.atc_code LIKE ANY(${pre}::text[])
           AND (me.documented_at AT TIME ZONE ${TZ})::date BETWEEN ${from}::date AND ${to}::date),
      c AS (
        SELECT d.*, CASE
            WHEN ddd_ref IS NULL OR dose IS NULL THEN 0
            WHEN ddd_unit = 'g'  AND unit = 'g'   THEN dose / ddd_ref
            WHEN ddd_unit = 'g'  AND unit = 'mg'  THEN dose / 1000 / ddd_ref
            WHEN ddd_unit = 'g'  AND unit = 'mcg' THEN dose / 1000000 / ddd_ref
            WHEN ddd_unit = 'mg' AND unit = 'mg'  THEN dose / ddd_ref
            WHEN ddd_unit = 'mg' AND unit = 'g'   THEN dose * 1000 / ddd_ref
            WHEN ddd_unit = 'mg' AND unit = 'mcg' THEN dose / 1000 / ddd_ref
            WHEN ddd_unit = 'MU' AND unit = 'IU'  THEN dose / 1000000 / ddd_ref
            ELSE 0 END AS ddd
          FROM d)
      SELECT day::text AS day, department_id, sum(ddd)::text AS ddd, coalesce(sum(ddd) FILTER (WHERE aware = 'access'), 0)::text AS ddd_access,
             count(DISTINCT patient_id::text || '|' || key)::int AS dot
        FROM c GROUP BY 1, 2`.execute(db),
    sql<{ day: string; department_id: string; hh_opps: number; hh_done: number }>`
      SELECT (a.audited_at AT TIME ZONE ${TZ})::date::text AS day, a.department_id, count(o.id)::int AS hh_opps, count(o.id) FILTER (WHERE o.action <> 'missed')::int AS hh_done
        FROM ipc_audits a JOIN ipc_audit_templates t ON t.id = a.template_id JOIN ipc_hh_observations o ON o.audit_id = a.id
       WHERE a.status = 'completed' AND t.kind = 'hand_hygiene' AND (a.audited_at AT TIME ZONE ${TZ})::date BETWEEN ${from}::date AND ${to}::date GROUP BY 1, 2`.execute(db),
    sql<{ day: string; department_id: string; qty: string }>`
      SELECT (m.created_at AT TIME ZONE ${TZ})::date::text AS day, l.department_id, (${sign} * sum(m.qty * mi.factor))::text AS qty
        FROM stock_moves m JOIN stock_locations l ON l.id = m.location_id JOIN ipc_material_items mi ON mi.item_id = m.item_id
        JOIN ipc_material_groups g ON g.id = mi.group_id AND g.code = 'hand_rub' AND g.is_active
       WHERE l.department_id IS NOT NULL AND m.move_type = ANY(${sql.val(types)}::text[])
         AND (m.created_at AT TIME ZONE ${TZ})::date BETWEEN ${from}::date AND ${to}::date GROUP BY 1, 2`.execute(db),
  ]);
  const map = new Map<string, IpcFactRow>();
  const row = (day: string, dep: string | null) => {
    const k = `${day}|${dep ?? ''}`;
    let x = map.get(k);
    if (!x) { x = { day, department_id: dep, ...ZERO }; map.set(k, x); }
    return x;
  };
  for (const x of hai.rows) Object.assign(row(x.day, x.department_id), { hai: x.hai, clabsi: x.clabsi, cauti: x.cauti, vap: x.vap });
  for (const x of ssi.rows) Object.assign(row(x.day, x.department_id), { ssi_ops: x.ssi_ops, ssi: x.ssi });
  for (const x of mdro.rows) Object.assign(row(x.day, x.department_id), { mdro_hosp: x.mdro_hosp, mdro_all: x.mdro_all });
  for (const x of abx.rows) Object.assign(row(x.day, x.department_id), { ddd: Number(x.ddd), ddd_access: Number(x.ddd_access), dot: x.dot });
  for (const x of hh.rows) Object.assign(row(x.day, x.department_id), { hh_opps: x.hh_opps, hh_done: x.hh_done });
  for (const x of rub.rows) Object.assign(row(x.day, x.department_id), { handrub_l: Number(x.qty) });
  return [...map.values()];
}

/** რეპორტინგის გადათვლა (ფანჯარა) — rpt_fact_ipc */
export async function ipcFacts(rdb: Database, trx: Transaction<DB>, from: string, to: string): Promise<Record<string, number>> {
  const rows = await ipcFactRows(rdb, from, to);
  if (!rows) return {};
  await sql`DELETE FROM rpt_fact_ipc WHERE day BETWEEN ${from}::date AND ${to}::date`.execute(trx);
  const vals = rows.map((x) => ({ ...x, ddd: String(x.ddd), ddd_access: String(x.ddd_access), handrub_l: String(x.handrub_l) }));
  for (let i = 0; i < vals.length; i += 1000) await trx.insertInto('rpt_fact_ipc').values(vals.slice(i, i + 1000)).execute();
  return { ipc: vals.length };
}

/** 0072: „ყურადღება“ (მენეჯერული დაფა) — მხოლოდ რაოდენობები; depts = null — მთელი კლინიკა */
export async function ipcAttentionCounts(db: Database, depts: string[] | null) {
  const r = await ipcRules(db);
  if (!r) return null;
  const cur = (enc: string) => sql`(SELECT a.department_id FROM bed_assignments a WHERE a.encounter_id = ${sql.ref(enc)} AND a.end_kind IS DISTINCT FROM 'cancel'
      ORDER BY (a.ended_at IS NULL) DESC, a.started_at DESC LIMIT 1)`;
  const f = (expr: ReturnType<typeof sql>) => (depts ? sql`${expr} = ANY(${sql.val(depts)}::uuid[])` : sql`TRUE`);
  const [a, b, c, d] = await Promise.all([
    sql<{ n: number }>`
      SELECT count(*)::int AS n FROM inpatient_stays st
       WHERE st.status = 'active' AND EXISTS (SELECT 1 FROM ipc_patient_flags fl WHERE fl.patient_id = st.patient_id AND fl.status = 'active')
         AND NOT EXISTS (SELECT 1 FROM ipc_isolations i WHERE i.encounter_id = st.encounter_id AND i.ended_at IS NULL)
         AND ${f(cur('st.encounter_id'))}`.execute(db),
    sql<{ n: number }>`
      SELECT count(*)::int AS n FROM med_orders o JOIN inpatient_stays st ON st.encounter_id = o.encounter_id AND st.status = 'active'
       WHERE o.status IN ('active', 'on_hold') AND o.abx_review_due <= now() AND o.abx_reviewed_at IS NULL AND ${f(cur('o.encounter_id'))}`.execute(db),
    sql<{ n: number }>`
      SELECT count(*)::int AS n FROM ipc_signals s
       WHERE s.status = 'open' AND s.detected_at < now() - make_interval(days => ${r.signal_overdue_days}) AND ${f(sql`s.department_id`)}`.execute(db),
    sql<{ opps: number; done: number }>`
      SELECT count(o.id)::int AS opps, count(o.id) FILTER (WHERE o.action <> 'missed')::int AS done
        FROM ipc_audits a JOIN ipc_audit_templates t ON t.id = a.template_id AND t.kind = 'hand_hygiene' JOIN ipc_hh_observations o ON o.audit_id = a.id
       WHERE a.status = 'completed' AND a.audited_at >= (date_trunc('month', now() AT TIME ZONE ${TZ}))::timestamp AT TIME ZONE ${TZ} AND ${f(sql`a.department_id`)}`.execute(db),
  ]);
  const hh = d.rows[0];
  return { mdro_no_isolation: a.rows[0].n, abx_timeout: b.rows[0].n, signals_old: c.rows[0].n, signal_days: r.signal_overdue_days,
    hh_pct: hh.opps ? Math.round((hh.done / hh.opps) * 1000) / 10 : null, hh_opps: hh.opps, hh_target: r.hh_target };
}
