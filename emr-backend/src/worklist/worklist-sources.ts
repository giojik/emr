import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { has, type AuthUser } from '../auth/roles';
import { InjectDb, type Database } from '../database/database.module';
import { SIGNAL_KA } from '../ipc/ipc-signals';
import { LEVEL_KA } from '../quality/quality-common';
import { CONDITION_KA, type Condition } from '../bme/bme-repair-common';
import { viewScope } from '../bme/bme-common';
import { RosterFlowsService } from '../roster/roster-flows';
import { SOURCES, TZ, WL_DEFAULTS, dayEnd, iso, zonedMidnight, type Priority, type WlItem, type WlSettings } from './worklist-common';
import { AdminCtx, WorklistAdminSources, type Row, type SourceGroup } from './worklist-sources-admin';
import { WorklistClinicalSources } from './worklist-sources-clinical';

/**
 * სისტემური წყაროები (A1 — ვირტუალური): ღია საქმე პირდაპირ წყაროს ცხრილიდან, მოდულის არსებული წვდომის წესით (C1).
 * თითო ჯგუფი ერთი ან რამდენიმე წყაროს აბრუნებს; გამორთული მოდული / წყარო — გამოტოვება. თითო წყაროზე ≤ 200 ჩანაწერი.
 * admin უფლება პასუხისმგებლობას არ ქმნის: სისტემური წყაროები admin-ის გარეშე ფასდება (ხელმძღვანელის ხედი — ცალკე).
 */

const LIMIT = 200;
const pri = (p: number | null | undefined): Priority => (p === 1 ? 'urgent' : p === 2 ? 'high' : 'normal');

@Injectable()
export class WorklistSources {
  private readonly log = new Logger('Worklist');
  private readonly groups: SourceGroup[];
  constructor(@InjectDb() private readonly db: Database, private readonly rosterFlows: RosterFlowsService, admin: WorklistAdminSources, clinical: WorklistClinicalSources) {
    this.groups = [
      { module: 'quality', codes: ['qm_triage', 'qm_review', 'qm_capa_due', 'qm_effect'], fetch: (u, c) => this.qmManager(u, c) },
      { module: 'quality', codes: ['qm_analysis', 'qm_capa'], fetch: (u, c) => this.qmMine(u, c) },
      { module: 'ipc', codes: ['ipc_signal', 'ipc_hai', 'ipc_flag', 'ipc_ssi'], fetch: (u, c) => this.ipc(u, c) },
      { module: 'ipc', codes: ['ipc_abx'], fetch: (u) => this.ipcAbx(u) },
      { module: 'bme', codes: ['bme_triage', 'bme_repair', 'bme_confirm', 'bme_work', 'bme_work_free'], fetch: (u, c) => this.bme(u, c) },
      { module: 'roster', codes: ['roster_absence', 'roster_swap', 'roster_offer', 'roster_peer'], fetch: (u) => this.rosterInbox(u) },
      { module: 'roster', codes: ['roster_timesheet'], fetch: (u) => this.rosterTimesheet(u) },
      ...admin.groups(),   // 0082: ადმინისტრაცია / ლოჯისტიკა
      ...clinical.groups(),   // 0083: კლინიკური (ექიმი / ექთანი)
    ];
  }

  /** ყველა ჩართული წყარო; თითო ჯგუფის შეცდომა — ლოგი, სხვები გრძელდება */
  async items(user: AuthUser, enabled: { modules: Set<string>; sources: Record<string, boolean>; settings?: WlSettings }, onlySource?: string): Promise<WlItem[]> {
    const u: AuthUser = { ...user, caps: user.caps.filter((c) => c !== 'admin') };
    const ctx = new AdminCtx(this.db, u, { ...WL_DEFAULTS, ...(enabled.settings ?? {}) });
    const now = Date.now();
    const out: WlItem[] = [];
    await Promise.all(this.groups.map(async (g) => {
      if (!enabled.modules.has(g.module)) return;
      const codes = new Set(g.codes.filter((c) => enabled.sources[c] !== false && (!onlySource || onlySource === c)));
      if (!codes.size) return;
      try {
        const rows = await g.fetch(u, codes, ctx);
        for (const r of rows) {
          if (!codes.has(r.source)) continue;
          const due = iso(r.due_at);
          out.push({ ...r, key: `${r.source}:${r.id}`, kind: 'system', group: SOURCES[r.source].group, due_at: due, due_date_only: !!r.due_date_only,
            overdue: !!due && new Date(due).getTime() < now, created_at: iso(r.created_at ?? null) });
        }
      } catch (e) { this.log.warn(`წყარო ${g.codes.join('/')}: ${(e as Error).message}`); }
    }));
    return out;
  }

  // ------------------------------------------------------------------ ხარისხი
  private async qmManager(u: AuthUser, c: Set<string>): Promise<Row[]> {
    if (!has(u, 'quality')) return [];
    const out: Row[] = [];
    if (c.has('qm_triage')) {
      const r = await sql<{ id: string; inc_no: string; triage_due_at: Date; is_sentinel: boolean; urgent: boolean; reported_at: Date; cat: string; dep: string }>`
        SELECT i.id, i.inc_no, i.triage_due_at, i.is_sentinel, i.urgent, i.reported_at, c.name AS cat, d.name AS dep
          FROM qm_incidents i JOIN qm_classifiers c ON c.id = i.category_id JOIN departments d ON d.id = i.department_id
         WHERE i.status = 'submitted' ORDER BY i.triage_due_at LIMIT ${LIMIT}`.execute(this.db);
      for (const x of r.rows) out.push({ id: x.id, source: 'qm_triage', title: `ინციდენტის ტრიაჟი: ${x.inc_no}`, detail: `${x.cat}${x.is_sentinel ? ' · სენტინელური' : ''}`,
        patient: null, department: x.dep, due_at: x.triage_due_at, priority: x.is_sentinel || x.urgent ? 'urgent' : 'normal', link: `/quality/incidents/${x.id}`, created_at: x.reported_at });
    }
    if (c.has('qm_review')) {
      const r = await sql<{ id: string; inc_no: string; level: string; submitted_at: Date; dep: string; due: Date | null }>`
        SELECT i.id, i.inc_no, a.level, a.submitted_at, d.name AS dep, i.analysis_due_at AS due
          FROM qm_analyses a JOIN qm_incidents i ON i.id = a.incident_id JOIN departments d ON d.id = i.department_id
         WHERE a.status = 'submitted' ORDER BY a.submitted_at LIMIT ${LIMIT}`.execute(this.db);
      for (const x of r.rows) out.push({ id: x.id, source: 'qm_review', title: `ანალიზი დასამტკიცებელია: ${x.inc_no}`, detail: LEVEL_KA[x.level] ?? x.level,
        patient: null, department: x.dep, due_at: x.due, priority: 'normal', link: `/quality/incidents/${x.id}`, created_at: x.submitted_at });
    }
    if (c.has('qm_capa_due')) {
      const r = await sql<{ id: string; capa_id: string; capa_no: string; title: string; old_due: string; new_due: string; requested_at: Date; who: string | null }>`
        SELECT q.id, q.capa_id, c.capa_no, c.title, to_char(q.old_due, 'DD.MM.YYYY') AS old_due, to_char(q.new_due, 'DD.MM.YYYY') AS new_due, q.requested_at,
               u.last_name || ' ' || u.first_name AS who
          FROM qm_capa_due_requests q JOIN qm_capas c ON c.id = q.capa_id LEFT JOIN users u ON u.id = q.requested_by
         WHERE q.status = 'pending' ORDER BY q.requested_at LIMIT ${LIMIT}`.execute(this.db);
      for (const x of r.rows) out.push({ id: x.id, source: 'qm_capa_due', title: `CAPA ${x.capa_no} — ვადის ცვლილება: ${x.old_due} → ${x.new_due}`, detail: `${x.title}${x.who ? ` · ${x.who}` : ''}`,
        patient: null, department: null, due_at: null, priority: 'normal', link: `/quality/capas/${x.capa_id}`, created_at: x.requested_at });
    }
    if (c.has('qm_effect')) {
      const r = await sql<{ id: string; capa_no: string; title: string; eff: Date; dep: string | null; done_at: Date | null }>`
        SELECT c.id, c.capa_no, c.title, ${dayEnd('c.effectiveness_due')} AS eff, d.name AS dep, c.done_at
          FROM qm_capas c LEFT JOIN departments d ON d.id = c.department_id
         WHERE c.status = 'done' AND c.effectiveness_due IS NOT NULL AND c.effectiveness_result IS NULL
           AND c.effectiveness_due <= (now() AT TIME ZONE ${TZ})::date + 7 ORDER BY c.effectiveness_due LIMIT ${LIMIT}`.execute(this.db);
      for (const x of r.rows) out.push({ id: x.id, source: 'qm_effect', title: `CAPA ${x.capa_no} — ეფექტიანობის შემოწმება`, detail: x.title,
        patient: null, department: x.dep, due_at: x.eff, due_date_only: true, priority: 'normal', link: `/quality/capas/${x.id}`, created_at: x.done_at });
    }
    return out;
  }

  private async qmMine(u: AuthUser, c: Set<string>): Promise<Row[]> {
    const out: Row[] = [];
    if (c.has('qm_analysis')) {
      const r = await sql<{ id: string; inc_no: string; level: string | null; due: Date | null; cat: string; dep: string; ast: string | null; inv_at: Date | null; investigator: boolean }>`
        SELECT i.id, i.inc_no, i.analysis_level AS level, i.analysis_due_at AS due, c.name AS cat, d.name AS dep, a.status AS ast, i.investigator_at AS inv_at,
               i.investigator_id = ${u.id} AS investigator
          FROM qm_incidents i JOIN qm_classifiers c ON c.id = i.category_id JOIN departments d ON d.id = i.department_id
          LEFT JOIN qm_analyses a ON a.incident_id = i.id
         WHERE i.status IN ('investigation', 'analysis') AND coalesce(a.status, 'draft') IN ('draft', 'returned')
           AND (i.investigator_id = ${u.id} OR EXISTS (SELECT 1 FROM qm_analysis_team t WHERE t.incident_id = i.id AND t.user_id = ${u.id}))
         ORDER BY i.analysis_due_at NULLS LAST LIMIT ${LIMIT}`.execute(this.db);
      for (const x of r.rows) out.push({ id: x.id, source: 'qm_analysis', title: `ინციდენტის ანალიზი: ${x.inc_no}${x.ast === 'returned' ? ' (დაბრუნებულია)' : ''}`,
        detail: `${x.level ? LEVEL_KA[x.level] ?? x.level : 'ანალიზი'} · ${x.cat}${x.investigator ? '' : ' · გუნდის წევრი'}`,
        patient: null, department: x.dep, due_at: x.due, priority: x.ast === 'returned' ? 'high' : 'normal', link: `/quality/incidents/${x.id}`, created_at: x.inv_at });
    }
    if (c.has('qm_capa')) {
      const r = await sql<{ id: string; capa_no: string; title: string; due: Date; status: string; dep: string | null; created_at: Date; req: boolean }>`
        SELECT c.id, c.capa_no, c.title, ${dayEnd('c.due_date')} AS due, c.status, d.name AS dep, c.created_at,
               EXISTS (SELECT 1 FROM qm_capa_due_requests q WHERE q.capa_id = c.id AND q.status = 'pending') AS req
          FROM qm_capas c LEFT JOIN departments d ON d.id = c.department_id
         WHERE c.owner_id = ${u.id} AND c.status IN ('open', 'in_progress') ORDER BY c.due_date LIMIT ${LIMIT}`.execute(this.db);
      for (const x of r.rows) out.push({ id: x.id, source: 'qm_capa', title: `CAPA ${x.capa_no}: ${x.title}`,
        detail: `${x.status === 'in_progress' ? 'შესრულებაში' : 'ღია'}${x.req ? ' · ვადის ცვლილება მოთხოვნილია' : ''}`,
        patient: null, department: x.dep, due_at: x.due, due_date_only: true, priority: 'normal', link: `/quality/capas/${x.id}`, created_at: x.created_at });
    }
    return out;
  }

  // ------------------------------------------------------------------ ინფექციის კონტროლი
  /** infection — მთელი კლინიკა; infection_dept — rpt_user_scopes ∪ users.department_id (როგორც IpcCommon.scope) */
  private async ipcScope(u: AuthUser): Promise<{ full: boolean; depts: string[] } | null> {
    if (has(u, 'infection')) return { full: true, depts: [] };
    if (!has(u, 'infection_dept')) return null;
    const r = await sql<{ id: string }>`SELECT department_id AS id FROM rpt_user_scopes WHERE user_id = ${u.id}
      UNION SELECT department_id FROM users WHERE id = ${u.id} AND department_id IS NOT NULL`.execute(this.db);
    return r.rows.length ? { full: false, depts: r.rows.map((x) => x.id) } : null;
  }

  private async ipc(u: AuthUser, c: Set<string>): Promise<Row[]> {
    const sc = await this.ipcScope(u);
    if (!sc) return [];
    const dep = (col: string) => (sc.full ? sql`TRUE` : sql`${sql.ref(col)} = ANY (${sc.depts}::uuid[])`);
    const out: Row[] = [];
    if (c.has('ipc_signal')) {
      const r = await sql<{ id: string; kind: string; summary: string; status: string; detected_at: Date; watch_until: Date | null; pat: string | null; dep: string | null }>`
        SELECT s.id, s.kind, s.summary, s.status, s.detected_at, s.watch_until, p.last_name || ' ' || p.first_name AS pat, d.name AS dep
          FROM ipc_signals s LEFT JOIN patients p ON p.id = s.patient_id LEFT JOIN departments d ON d.id = s.department_id
         WHERE (s.status = 'open' OR (s.status = 'watch' AND s.watch_until < now())) AND ${dep('s.department_id')}
         ORDER BY s.detected_at LIMIT ${LIMIT}`.execute(this.db);
      for (const x of r.rows) out.push({ id: x.id, source: 'ipc_signal', title: `IPC სიგნალი: ${SIGNAL_KA[x.kind] ?? x.kind}${x.status === 'watch' ? ' (დაკვირვების ვადა გავიდა)' : ''}`,
        detail: x.summary, patient: x.pat, department: x.dep, due_at: null, priority: x.kind === 'cluster' || x.kind === 'blood_culture' ? 'high' : 'normal', link: '/ipc?tab=signals', created_at: x.detected_at });
    }
    if (c.has('ipc_hai')) {
      const r = await sql<{ id: string; case_no: string; type: string; status: string; created_at: Date; pat: string; dep: string | null }>`
        SELECT h.id, h.case_no, coalesce(t.short_name, t.name, h.hai_type) AS type, h.status, h.created_at, p.last_name || ' ' || p.first_name AS pat, d.name AS dep
          FROM ipc_hai_cases h JOIN patients p ON p.id = h.patient_id LEFT JOIN ipc_hai_types t ON t.code = h.hai_type LEFT JOIN departments d ON d.id = h.department_id
         WHERE h.status IN ('suspected', 'review') AND ${dep('h.department_id')} ORDER BY h.created_at LIMIT ${LIMIT}`.execute(this.db);
      for (const x of r.rows) out.push({ id: x.id, source: 'ipc_hai', title: `HAI შემთხვევა ${x.case_no}: ${x.type}`, detail: x.status === 'review' ? 'განხილვაში' : 'ეჭვი — დასადასტურებელი / უარსაყოფი',
        patient: x.pat, department: x.dep, due_at: null, priority: 'normal', link: `/ipc/hai/${x.id}`, created_at: x.created_at });
    }
    if (c.has('ipc_flag') && sc.full) {
      const r = await sql<{ id: string; mdro: string; urgent: boolean; detected_at: Date; pat: string }>`
        SELECT f.id, coalesce(m.name, f.mdro_code) AS mdro, coalesce(m.urgent, FALSE) AS urgent, f.detected_at, p.last_name || ' ' || p.first_name AS pat
          FROM ipc_patient_flags f JOIN patients p ON p.id = f.patient_id LEFT JOIN ipc_mdro_types m ON m.code = f.mdro_code
         WHERE f.status = 'suggested' ORDER BY f.detected_at LIMIT ${LIMIT}`.execute(this.db);
      for (const x of r.rows) out.push({ id: x.id, source: 'ipc_flag', title: `MDRO ფლაგი დასადასტურებელია: ${x.mdro}`, detail: 'შემოთავაზებული (მიკრობიოლოგია)',
        patient: x.pat, department: null, due_at: null, priority: x.urgent ? 'high' : 'normal', link: `/ipc/flags/${x.id}`, created_at: x.detected_at });
    }
    if (c.has('ipc_ssi')) {
      const r = await sql<{ id: string; case_no: string; due: Date; attempts: number; pat: string; dep: string; cat: string }>`
        SELECT f.id, oc.case_no, ${dayEnd('f.due_date')} AS due, f.attempts, p.last_name || ' ' || p.first_name AS pat, d.name AS dep, k.name AS cat
          FROM ipc_ssi_followups f JOIN ipc_ssi_ops o ON o.case_id = f.case_id JOIN or_cases oc ON oc.id = o.case_id JOIN patients p ON p.id = o.patient_id
          JOIN departments d ON d.id = o.department_id JOIN ipc_ssi_categories k ON k.code = o.category
         WHERE f.status = 'pending' AND f.due_date <= (now() AT TIME ZONE ${TZ})::date + 3 AND ${dep('o.department_id')}
         ORDER BY f.due_date LIMIT ${LIMIT}`.execute(this.db);
      for (const x of r.rows) out.push({ id: x.id, source: 'ipc_ssi', title: `SSI — პაციენტთან კონტაქტი: ${x.case_no}`, detail: `${x.cat}${x.attempts ? ` · მცდელობა ${x.attempts}` : ''}`,
        patient: x.pat, department: x.dep, due_at: x.due, due_date_only: true, priority: 'normal', link: '/ipc?tab=ssi', created_at: null });
    }
    return out;
  }

  /** ანტიბიოტიკის time-out: დამნიშნავი / მკურნალი ექიმი (როგორც 0070-ის შეხსენება); ვადა ≤ 12 სთ-ში ან გასულია */
  private async ipcAbx(u: AuthUser): Promise<Row[]> {
    if (!has(u, 'doctor')) return [];
    const r = await sql<{ id: string; encounter_id: string; inn: string; due: Date; adm_no: string; pat: string; dep: string | null; created_at: Date }>`
      SELECT o.id, o.encounter_id, g.inn, o.abx_review_due AS due, st.adm_no, p.last_name || ' ' || p.first_name AS pat, d.name AS dep, o.created_at
        FROM med_orders o JOIN med_generics g ON g.id = o.generic_id JOIN inpatient_stays st ON st.encounter_id = o.encounter_id
        JOIN encounters e ON e.id = o.encounter_id JOIN patients p ON p.id = o.patient_id LEFT JOIN departments d ON d.id = e.department_id
       WHERE o.status IN ('active', 'on_hold') AND o.abx_review_due IS NOT NULL AND o.abx_reviewed_at IS NULL AND o.abx_review_due <= now() + interval '12 hours'
         AND (o.ordered_by = ${u.id} OR e.attending_doctor_id = ${u.id})
       ORDER BY o.abx_review_due LIMIT ${LIMIT}`.execute(this.db);
    return r.rows.map((x) => ({ id: x.id, source: 'ipc_abx', title: `ანტიბიოტიკის გადახედვა: ${x.inn}`, detail: `${x.adm_no} — გაგრძელება / დე-ესკალაცია / IV → per os / შეწყვეტა`,
      patient: x.pat, department: x.dep, due_at: x.due, priority: 'high' as Priority, link: `/inpatient/stay/${x.encounter_id}?tab=orders`, created_at: x.created_at }));
  }

  // ------------------------------------------------------------------ ბიომედ-აპარატურა
  private async bme(u: AuthUser, c: Set<string>): Promise<Row[]> {
    const eng = has(u, 'med_engineer');
    const out: Row[] = [];
    const dev = (x: { inv_no: string; name: string }) => `${x.inv_no} ${x.name}`;
    type Rep = { id: string; repair_no: string; inv_no: string; name: string; status: string; condition: string; p: number | null; resp: Date | null; rest: Date | null; reported_at: Date; dep: string | null };
    const repQ = (where: ReturnType<typeof sql>) => sql<Rep>`
      SELECT r.id, r.repair_no, b.inv_no, b.name, r.status, r.condition, coalesce(r.priority, r.suggested_priority) AS p, r.sla_response_due AS resp, r.sla_restore_due AS rest,
             r.reported_at, d.name AS dep
        FROM bme_repairs r JOIN bme_devices b ON b.id = r.device_id LEFT JOIN departments d ON d.id = coalesce(b.department_id, r.reporter_department_id)
       WHERE ${where} ORDER BY coalesce(r.priority, r.suggested_priority), r.reported_at LIMIT ${LIMIT}`.execute(this.db);
    if (c.has('bme_triage') && eng) {
      for (const x of (await repQ(sql`r.status = 'requested'`)).rows) out.push({ id: x.id, source: 'bme_triage', title: `შეკეთების მოთხოვნა: ${x.repair_no} · ${dev(x)}`,
        detail: `${CONDITION_KA[x.condition as Condition] ?? x.condition}${x.p ? ` · P${x.p} (შეთავაზებული)` : ''}`, patient: null, department: x.dep, due_at: x.resp, priority: pri(x.p),
        link: `/bme?tab=repairs&repair=${x.id}`, created_at: x.reported_at });
    }
    if (c.has('bme_repair')) {
      const ST: Record<string, string> = { triaged: 'ტრიაჟი გავლილია', in_progress: 'მიმდინარეობს', waiting_parts: 'ელოდება ნაწილებს', waiting_vendor: 'ელოდება მომწოდებელს' };
      for (const x of (await repQ(sql`r.assignee_id = ${u.id} AND r.status IN ('triaged', 'in_progress', 'waiting_parts', 'waiting_vendor')`)).rows)
        out.push({ id: x.id, source: 'bme_repair', title: `შეკეთება: ${x.repair_no} · ${dev(x)}`, detail: `${ST[x.status] ?? x.status}${x.p ? ` · P${x.p}` : ''}`,
          patient: null, department: x.dep, due_at: x.rest, priority: pri(x.p), link: `/bme?tab=repairs&repair=${x.id}`, created_at: x.reported_at });
    }
    if (c.has('bme_confirm')) {
      // isDeptSide: განმცხადებელი, ან bme_dept აპარატის განყოფილებით (viewScope)
      const sc = has(u, 'bme_dept') ? await viewScope(this.db, u) : null;
      const deptCond = !sc ? sql`FALSE` : sc.all ? sql`b.department_id IS NOT NULL` : sc.depts.length ? sql`b.department_id = ANY (${sc.depts}::uuid[])` : sql`FALSE`;
      const r = await sql<Rep & { done_at: Date }>`
        SELECT r.id, r.repair_no, b.inv_no, b.name, r.status, r.condition, coalesce(r.priority, r.suggested_priority) AS p, r.sla_response_due AS resp, r.sla_restore_due AS rest,
               r.reported_at, d.name AS dep, r.done_at
          FROM bme_repairs r JOIN bme_devices b ON b.id = r.device_id LEFT JOIN departments d ON d.id = b.department_id
         WHERE r.status = 'done' AND (r.reported_by = ${u.id} OR ${deptCond}) ORDER BY r.done_at LIMIT ${LIMIT}`.execute(this.db);
      for (const x of r.rows) out.push({ id: x.id, source: 'bme_confirm', title: `შეკეთება დასადასტურებელია: ${x.repair_no} · ${dev(x)}`, detail: 'ინჟინერმა შეასრულა — განყოფილების დადასტურება',
        patient: null, department: x.dep, due_at: null, priority: 'normal', link: `/bme?tab=repairs&repair=${x.id}`, created_at: x.done_at });
    }
    type Wk = { id: string; work_no: string; inv_no: string; name: string; kind: string; status: string; due: Date | null; created_at: Date; dep: string | null; crit: string };
    const workQ = (where: ReturnType<typeof sql>) => sql<Wk>`
      SELECT w.id, w.work_no, b.inv_no, b.name, coalesce(k.short_name, k.name) AS kind, w.status, ${dayEnd('w.due_date')} AS due, w.created_at, d.name AS dep, b.criticality AS crit
        FROM bme_works w JOIN bme_devices b ON b.id = w.device_id JOIN bme_work_kinds k ON k.id = w.kind_id LEFT JOIN departments d ON d.id = b.department_id
       WHERE w.status IN ('planned', 'in_progress') AND ${where} ORDER BY w.due_date NULLS LAST LIMIT ${LIMIT}`.execute(this.db);
    const wPri = (x: Wk): Priority => (x.crit === 'life_support' ? 'high' : 'normal');
    if (c.has('bme_work')) {
      for (const x of (await workQ(sql`w.assignee_id = ${u.id}`)).rows) out.push({ id: x.id, source: 'bme_work', title: `${x.kind}: ${x.work_no} · ${dev(x)}`,
        detail: x.status === 'in_progress' ? 'მიმდინარეობს' : 'დაგეგმილი', patient: null, department: x.dep, due_at: x.due, due_date_only: true, priority: wPri(x),
        link: `/bme?tab=works&work=${x.id}`, created_at: x.created_at });
    }
    if (c.has('bme_work_free') && eng) {
      for (const x of (await workQ(sql`w.assignee_id IS NULL AND w.performer_kind <> 'external' AND (w.due_date IS NULL OR w.due_date <= (now() AT TIME ZONE ${TZ})::date + 7)`)).rows)
        out.push({ id: x.id, source: 'bme_work_free', title: `${x.kind} — შემსრულებლის გარეშე: ${x.work_no} · ${dev(x)}`, detail: x.status === 'in_progress' ? 'მიმდინარეობს' : 'დაგეგმილი',
          patient: null, department: x.dep, due_at: x.due, due_date_only: true, priority: wPri(x), link: `/bme?tab=works&work=${x.id}`, created_at: x.created_at });
    }
    return out;
  }

  // ------------------------------------------------------------------ ცვლები და მორიგეობა
  /** „დასადასტურებელი“ (0078) — იგივე სერვისი, იგივე არე */
  private async rosterInbox(u: AuthUser): Promise<Row[]> {
    const ib = await this.rosterFlows.inbox(u);
    const out: Row[] = [];
    for (const a of ib.absences) {
      const st = a.cancel_requested_at && a.status === 'approved' ? 'გაუქმების მოთხოვნა' : a.status === 'hr' ? 'HR-ის ნაბიჯი' : 'ხელმძღვანელის ნაბიჯი';
      const due = zonedMidnight(a.date_from);
      const soon = due.getTime() - Date.now() < 3 * 864e5;
      out.push({ id: a.id, source: 'roster_absence', title: `არყოფნა: ${a.staff_name} — ${a.type_name} (${a.date_from} – ${a.date_to})`, detail: `№${a.no} · ${st}`,
        patient: null, department: a.department_name, due_at: due, priority: soon ? 'high' : 'normal', link: '/roster?tab=approvals', created_at: a.created_at });
    }
    for (const w of ib.swaps) out.push({ id: w.id, source: 'roster_swap', title: `${w.kind === 'give' ? 'გადაცემა' : 'გაცვლა'}: ${w.a_staff_name} → ${w.b_staff_name} (${w.a_day} ${w.a_code})`,
      detail: `№${w.no} · კოლეგამ დაეთანხმა — შემდგენის დადასტურება`, patient: null, department: w.a_department, due_at: w.expires_at, priority: 'normal', link: '/roster?tab=approvals', created_at: w.created_at });
    for (const o of ib.offers) out.push({ id: o.id, source: 'roster_offer', title: `დასაფარი ცვლა — მოხალისე: ${o.day} ${o.code}${o.duty_name ? ` (${o.duty_name})` : ''}`,
      detail: (o.offers ?? []).map((f) => f.name).join(', ') || null, patient: null, department: o.department_name, due_at: o.starts_at, priority: 'high', link: '/roster?tab=approvals', created_at: o.created_at });
    for (const w of ib.peer) out.push({ id: w.id, source: 'roster_peer', title: `${w.kind === 'give' ? 'ცვლის გადაცემის' : 'გაცვლის'} თხოვნა: ${w.a_staff_name} (${w.a_day} ${w.a_code})`,
      detail: `№${w.no}`, patient: null, department: w.a_department, due_at: w.expires_at, priority: 'normal', link: '/roster?tab=approvals', created_at: w.created_at });
    return out;
  }

  /** ტაბელის დახურვა (HR): გამოქვეყნებული განრიგი, თვე დასრულდა, (close_requires_submit → წარდგენილი); ვადა — თვის ბოლო + rpt_close_late_days */
  private async rosterTimesheet(u: AuthUser): Promise<Row[]> {
    if (!has(u, 'hr')) return [];
    const r = await sql<{ id: string; department_id: string; month: string; dep: string; submitted: Date | null; due: Date }>`
      SELECT r.id, r.department_id, to_char(r.month, 'YYYY-MM') AS month, d.name AS dep, r.timesheet_submitted_at AS submitted,
             (((r.month + interval '1 month')::date + coalesce((m.settings->>'rpt_close_late_days')::int, 5))::timestamp AT TIME ZONE ${TZ}) AS due
        FROM rosters r JOIN departments d ON d.id = r.department_id CROSS JOIN system_modules m
       WHERE m.code = 'roster' AND r.status = 'published' AND (r.month + interval '1 month')::date <= (now() AT TIME ZONE ${TZ})::date
         AND (coalesce((m.settings->>'close_requires_submit')::boolean, FALSE) = FALSE OR r.timesheet_submitted_at IS NOT NULL)
       ORDER BY r.month, d.name LIMIT ${LIMIT}`.execute(this.db);
    return r.rows.map((x) => ({ id: x.id, source: 'roster_timesheet', title: `ტაბელის დახურვა: ${x.dep} · ${x.month}`, detail: x.submitted ? 'წარდგენილია' : 'თვე დასრულდა',
      patient: null, department: x.dep, due_at: x.due, priority: 'normal' as Priority, link: `/roster?tab=hours&month=${x.month}&dept=${x.department_id}`, created_at: x.submitted }));
  }
}
