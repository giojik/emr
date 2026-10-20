import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, Logger, NotFoundException, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min } from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser } from '../auth/roles';
import { loadEnv } from '../config/env';
import { IPC_ANY, IPC_FULL, IPC_STATUS_READ, IpcCommon, ipcRules, isoEnd, type IpcRules, type Trx } from './ipc-common';

const TZ = loadEnv().CLINIC_TZ;
const ONSET_KA: Record<string, string> = { community: 'საზოგადოებრივი / შემოტანილი', hospital: 'ჰოსპიტალური', unknown: 'უცნობი' };

class FlagCreateDto {
  @IsUUID() patient_id: string;
  @IsString() @Length(2, 16) mdro_code: string;
  @IsIn(['manual', 'external']) source: 'manual' | 'external';
  @IsOptional() @IsDateString() specimen_at?: string | null;
  @IsOptional() @IsIn(['community', 'hospital', 'unknown']) onset?: string | null;
  @IsOptional() @IsString() @MaxLength(1000) note?: string | null;
}
class FlagReasonDto { @IsString() @Length(3, 500) reason: string }
class FlagClearDto {
  @IsString() @Length(3, 500) reason: string;
  @IsInt() @Min(0) @Max(20) negatives: number;
  @IsOptional() @IsBoolean() end_isolation?: boolean;
}
class FlagConfirmDto { @IsOptional() @IsString() @MaxLength(1000) note?: string | null }

type NewFlag = { id: string; patient_id: string; mdro_code: string; status: string; encounter_id: string | null };

/**
 * MDRO (0067): მიკრობიოლოგიის საბოლოო პასუხი → წესები → პაციენტის ფლაგი (auto: აქტიური / suggest: შეთავაზება ინფექციის კონტროლს).
 * ფლაგი პაციენტს ეკუთვნის; ღია ფლაგზე (იგივე MDRO) — მხოლოდ ახალი აღმოჩენა ემატება. ხელით / გარე პასუხით — ინფექციის კონტროლი.
 */
@Injectable()
export class IpcMdroService {
  private readonly log = new Logger('IPC-MDRO');
  constructor(private readonly c: IpcCommon, private readonly audit: AuditService) {}
  private get db() { return this.c.db; }

  /** ლაბორატორიის კონტროლერიდან (საბოლოო პასუხის შემდეგ) — შეცდომა არ ვრცელდება */
  async afterMicroFinal(itemId: string) {
    try {
      const rep = await this.db.selectFrom('micro_reports').select('id').where('order_item_id', '=', itemId).where('kind', '=', 'final').orderBy('issued_at', 'desc').executeTakeFirst();
      if (rep) await this.scanReport(rep.id);
    } catch (e) { this.log.error(`MDRO შემოწმება (${itemId}): ${(e as Error).message}`); }
  }

  /** ერთი საბოლოო პასუხის შემოწმება (იდემპოტენტური: ipc_micro_scans). მოდული გამორთულია — არ ინიშნება შემოწმებულად */
  async scanReport(reportId: string) {
    const created: NewFlag[] = [];
    const r = await this.db.transaction().execute(async (trx) => {
      const rules = await ipcRules(trx);
      if (!rules) return null;
      const ins = await trx.insertInto('ipc_micro_scans').values({ report_id: reportId }).onConflict((oc) => oc.column('report_id').doNothing()).returning('report_id').executeTakeFirst();
      if (!ins) return null;                                                                     // უკვე შემოწმებულია
      const rep = await trx.selectFrom('micro_reports').select(['order_item_id', 'kind']).where('id', '=', reportId).executeTakeFirstOrThrow();
      if (rep.kind !== 'final') return null;
      const n = await this.detect(trx, rep.order_item_id, rules, created);
      await trx.updateTable('ipc_micro_scans').set({ flags: n }).where('report_id', '=', reportId).execute();
      return rules;
    });
    if (r) for (const f of created) await this.notifyNew(f, r);
    return created.length;
  }

  private async detect(trx: Trx, itemId: string, r: IpcRules, created: NewFlag[]) {
    const it = await trx.selectFrom('dx_order_items as i').leftJoin('lab_specimens as sp', 'sp.id', 'i.specimen_id')
      .select(['i.id', 'i.patient_id', 'i.encounter_id', 'sp.collected_at']).where('i.id', '=', itemId).executeTakeFirstOrThrow();
    const isolates = await trx.selectFrom('micro_isolates as mi').innerJoin('micro_cultures as c', 'c.id', 'mi.culture_id').innerJoin('micro_organisms as o', 'o.id', 'mi.organism_id')
      .select(['mi.id', 'mi.organism_id', 'mi.markers', sql<string>`lower(o.code)`.as('org_code'), 'o.group_code',
        sql<string[]>`ARRAY(SELECT upper(ab.code) FROM micro_ast a JOIN micro_antibiotics ab ON ab.id = a.antibiotic_id WHERE a.isolate_id = mi.id AND a.interp = 'R')`.as('r_codes')])
      .where('c.order_item_id', '=', itemId).execute();
    if (!isolates.length) return 0;
    const rules = await trx.selectFrom('ipc_mdro_rules as ru').innerJoin('ipc_mdro_types as t', 't.code', 'ru.mdro_code')
      .select(['ru.id', 'ru.mdro_code', 'ru.organism_codes', 'ru.group_codes', 'ru.abx_codes', 'ru.marker']).where('ru.is_active', '=', true).where('t.is_active', '=', true).execute();
    // MDRO კოდი → პირველი შესაბამისი იზოლატი / წესი
    const hits = new Map<string, { isolate: (typeof isolates)[number]; rule: string }>();
    for (const iso of isolates) {
      for (const ru of rules) {
        const orgOk = ru.organism_codes.map((x) => x.toLowerCase()).includes(iso.org_code) || ru.group_codes.map((x) => x.toUpperCase()).includes(iso.group_code.toUpperCase());
        if (!orgOk) continue;
        if (ru.abx_codes.length && !ru.abx_codes.some((x) => iso.r_codes.includes(x.toUpperCase()))) continue;
        if (ru.marker && !(iso.markers ?? []).includes(ru.marker)) continue;
        if (!hits.has(ru.mdro_code)) hits.set(ru.mdro_code, { isolate: iso, rule: ru.id });
      }
    }
    if (!hits.size) return 0;
    // შეძენის ადგილი: სტაციონარში ნიმუში ≥ hospital_onset_day კალენდარულ დღეს (მიღების დღე = 1) → ჰოსპიტალური
    const stay = it.encounter_id ? await trx.selectFrom('inpatient_stays').select(['admitted_at']).where('encounter_id', '=', it.encounter_id).executeTakeFirst() : undefined;
    let onset: 'community' | 'hospital' | 'unknown' = 'unknown';
    if (it.collected_at) {
      if (stay) {
        const day = Number((await sql<{ d: number }>`SELECT ((${it.collected_at}::timestamptz AT TIME ZONE ${TZ})::date - (${stay.admitted_at}::timestamptz AT TIME ZONE ${TZ})::date + 1)::int AS d`.execute(trx)).rows[0].d);
        onset = day >= r.hospital_onset_day ? 'hospital' : 'community';
      } else onset = 'community';
    }
    let n = 0;
    for (const [code, h] of hits) {
      const open = await trx.selectFrom('ipc_patient_flags').select(['id', 'status']).where('patient_id', '=', it.patient_id).where('mdro_code', '=', code)
        .where('status', 'in', ['suggested', 'active']).forUpdate().executeTakeFirst();
      let flagId = open?.id;
      if (!flagId) {
        const t = await trx.selectFrom('ipc_mdro_types').select('expiry_days').where('code', '=', code).executeTakeFirstOrThrow();
        const f = await trx.insertInto('ipc_patient_flags').values({ patient_id: it.patient_id, mdro_code: code, status: r.mdro_flag_mode === 'auto' ? 'active' : 'suggested', source: 'micro',
          onset, encounter_id: it.encounter_id, order_item_id: it.id, organism_id: h.isolate.organism_id, specimen_at: it.collected_at,
          expires_at: t.expiry_days ? sql<Date>`now() + make_interval(days => ${t.expiry_days})` : null }).returning(['id', 'patient_id', 'mdro_code', 'status', 'encounter_id']).executeTakeFirstOrThrow();
        flagId = f.id; created.push(f);
        await this.audit.log({ userId: null, userAgent: 'emr: MDRO წესები (მიკრობიოლოგია)' }, { action: 'IPC_FLAG_AUTO', entityName: 'ipc_patient_flags', entityId: f.id,
          newData: { mdro_code: code, status: f.status, order_item_id: it.id, onset } }, trx);
      }
      const d = await trx.insertInto('ipc_flag_detections').values({ flag_id: flagId, order_item_id: it.id, isolate_id: h.isolate.id, organism_id: h.isolate.organism_id, rule_id: h.rule,
        specimen_at: it.collected_at }).onConflict((oc) => oc.columns(['flag_id', 'order_item_id', 'organism_id']).doNothing()).returning('id').executeTakeFirst();
      if (d) n++;
    }
    return n;
  }

  /** ახალი ფლაგი: ინფექციის კონტროლი (+ განყოფილების IPC, მკურნალი ექიმი — მხოლოდ აქტიურზე); სასწრაფო ტიპი — SMS / ელფოსტა (პაციენტის მონაცემების გარეშე) */
  private async notifyNew(f: NewFlag, r: IpcRules) {
    if (!r.alert_new_flag) return;
    const x = await this.db.selectFrom('ipc_patient_flags as f').innerJoin('ipc_mdro_types as t', 't.code', 'f.mdro_code').innerJoin('patients as p', 'p.id', 'f.patient_id')
      .leftJoin('inpatient_stays as st', (j) => j.onRef('st.patient_id', '=', 'f.patient_id').on('st.status', '=', 'active'))
      .leftJoin('encounters as e', 'e.id', 'st.encounter_id').leftJoin('departments as d', 'd.id', 'e.department_id')
      .select(['t.name', 't.urgent', 'p.first_name', 'p.last_name', 'st.encounter_id as stay_id', 'e.department_id', 'e.attending_doctor_id', 'd.name as department'])
      .where('f.id', '=', f.id).executeTakeFirstOrThrow();
    const ipc = await this.c.usersWith(IPC_FULL);
    const who = `${x.first_name} ${x.last_name}`;
    const title = f.status === 'suggested' ? `MDRO — დასადასტურებელი: ${x.name.split(' — ')[0]}` : `ახალი MDRO: ${x.name.split(' — ')[0]}`;
    await this.c.bell(ipc.map((u) => u.id), { kind: 'ipc_flag', title, body: `${who}${x.department ? ` · ${x.department}` : ''}`, link: `/ipc/flags/${f.id}`, entityId: f.id, urgent: x.urgent });
    if (f.status === 'active' && x.stay_id) {
      const dept = x.department_id ? await this.c.deptIpcUsers(x.department_id) : [];
      const clin = [...dept, ...(x.attending_doctor_id ? [x.attending_doctor_id] : [])].filter((id) => !ipc.some((u) => u.id === id));
      await this.c.bell(clin, { kind: 'ipc_flag', title, body: `${who} — იხ. იზოლაციის საჭიროება`, link: `/inpatient/stay/${x.stay_id}`, entityId: f.id, urgent: x.urgent });
    }
    if (x.urgent) await this.c.alertExternal(r, ipc, 'EMR: ახალი MDRO', `EMR: ახალი MDRO (${f.mdro_code.toUpperCase()})${x.department ? ` — ${x.department}` : ''}. დეტალები სისტემაში.`);
  }

  // =============================================================== პაციენტის სტატუსი (ბანერი)
  /** აქტიური ფლაგები (+ შეთავაზებული — მხოლოდ ინფექციის კონტროლს), აქტიური ჰოსპიტალიზაციის იზოლაციები, იზოლაციის შეთავაზება */
  async patientStatus(patientId: string, u: AuthUser) {
    const r = await this.c.rulesOrNull();
    const p = await this.db.selectFrom('patients').select('id').where('id', '=', patientId).executeTakeFirst();
    if (!p) throw new NotFoundException('პაციენტი ვერ მოიძებნა');
    const stay = await this.db.selectFrom('inpatient_stays').select(['encounter_id', 'adm_no']).where('patient_id', '=', patientId).where('status', '=', 'active').executeTakeFirst();
    const isolations = stay ? await this.db.selectFrom('ipc_isolations as i').innerJoin('ipc_isolation_types as t', 't.code', 'i.type')
      .select(['i.id', 'i.type', 't.name', 't.short_name', 't.color', 'i.reason', 'i.reason_text', 'i.flag_id', 'i.started_at'])
      .where('i.encounter_id', '=', stay.encounter_id).where('i.ended_at', 'is', null).orderBy('t.priority', 'desc').execute() : [];
    if (!r) return { enabled: false, flags: [], stay: stay ?? null, isolations, suggestions: [] };
    const statuses = has(u, ...IPC_ANY) ? ['active', 'suggested'] : ['active'];
    const flags = await this.db.selectFrom('ipc_patient_flags as f').innerJoin('ipc_mdro_types as t', 't.code', 'f.mdro_code')
      .select(['f.id', 'f.mdro_code', 't.name', 't.isolation_type', 't.urgent', 'f.status', 'f.onset', 'f.source', 'f.detected_at', 'f.specimen_at', 'f.reviewed_at'])
      .where('f.patient_id', '=', patientId).where('f.status', 'in', statuses).orderBy('t.sort_order').execute();
    const suggestions = stay && r.mdro_suggest_isolation
      ? flags.filter((f) => f.status === 'active' && !isolations.some((i) => i.type === f.isolation_type || (f.isolation_type === 'contact' && i.type === 'contact_plus')))
        .map((f) => ({ flag_id: f.id, mdro_code: f.mdro_code, isolation_type: f.isolation_type }))
      : [];
    return { enabled: true, flags, stay: stay ?? null, isolations, suggestions };
  }

  // =============================================================== ფლაგები (ინფექციის კონტროლი)
  async list(u: AuthUser, q: { status?: string; mdro_code?: string; review?: string; department_id?: string; q?: string }) {
    await this.c.rules();
    const sc = await this.c.scope(u);
    const statuses = q.status === 'all' ? ['suggested', 'active', 'cleared', 'dismissed'] : q.status ? q.status.split(',') : ['suggested', 'active'];
    let x = this.db.selectFrom('ipc_patient_flags as f').innerJoin('ipc_mdro_types as t', 't.code', 'f.mdro_code').innerJoin('patients as p', 'p.id', 'f.patient_id')
      .leftJoin('inpatient_stays as st', (j) => j.onRef('st.patient_id', '=', 'f.patient_id').on('st.status', '=', 'active'))
      .leftJoin('bed_assignments as a', (j) => j.onRef('a.encounter_id', '=', 'st.encounter_id').on('a.ended_at', 'is', null))
      .leftJoin('departments as d', 'd.id', 'a.department_id').leftJoin('beds as b', 'b.id', 'a.bed_id')
      .select(['f.id', 'f.patient_id', 'f.mdro_code', 't.name as mdro_name', 't.isolation_type', 'f.status', 'f.source', 'f.onset', 'f.detected_at', 'f.specimen_at', 'f.reviewed_at',
        'f.cleared_at', 'f.clear_reason', 'f.expires_at', 'p.first_name', 'p.last_name', 'p.personal_number', 'p.birth_date', 'st.encounter_id as stay_id', 'st.adm_no',
        'a.department_id', 'd.name as department', 'b.code as bed_code',
        sql<number>`(SELECT count(*)::int FROM ipc_flag_detections x WHERE x.flag_id = f.id)`.as('detections'),
        sql<boolean>`EXISTS (SELECT 1 FROM ipc_isolations i WHERE i.encounter_id = st.encounter_id AND i.ended_at IS NULL)`.as('isolated')])
      .where('f.status', 'in', statuses).orderBy('f.detected_at', 'desc').limit(500);
    if (q.mdro_code) x = x.where('f.mdro_code', '=', q.mdro_code);
    if (q.review === 'pending') x = x.where('f.reviewed_at', 'is', null).where('f.status', 'in', ['suggested', 'active']);
    if (q.department_id) x = x.where('a.department_id', '=', q.department_id);
    if (!sc.full) x = x.where('a.department_id', 'in', sc.depts);
    if (q.q?.trim()) {
      const s = `%${q.q.trim().toLowerCase()}%`;
      x = x.where((eb) => eb.or([eb(sql`lower(p.first_name || ' ' || p.last_name)`, 'like', s), eb(sql`lower(p.last_name || ' ' || p.first_name)`, 'like', s), eb('p.personal_number', 'like', s)]));
    }
    return x.execute();
  }

  private async flag(id: string, ex: Trx | IpcCommon['db'] = this.db) {
    const f = await ex.selectFrom('ipc_patient_flags').selectAll().where('id', '=', id).executeTakeFirst();
    if (!f) throw new NotFoundException('ფლაგი ვერ მოიძებნა');
    return f;
  }
  private async assertAccess(u: AuthUser, patientId: string) {
    const sc = await this.c.scope(u);
    if (sc.full) return;
    const a = await this.db.selectFrom('inpatient_stays as st').innerJoin('bed_assignments as a', (j) => j.onRef('a.encounter_id', '=', 'st.encounter_id').on('a.ended_at', 'is', null))
      .select('a.department_id').where('st.patient_id', '=', patientId).where('st.status', '=', 'active').executeTakeFirst();
    if (!a || !sc.depts.includes(a.department_id)) throw new ForbiddenException({ code: 'OUT_OF_SCOPE', message: 'პაციენტი თქვენს განყოფილებებში არ არის' });
  }

  async detail(id: string, u: AuthUser) {
    await this.c.rules();
    const f = await this.flag(id);
    await this.assertAccess(u, f.patient_id);
    const [head, detections, isolations, history] = await Promise.all([
      this.db.selectFrom('ipc_patient_flags as f').innerJoin('ipc_mdro_types as t', 't.code', 'f.mdro_code').innerJoin('patients as p', 'p.id', 'f.patient_id')
        .leftJoin('micro_organisms as o', 'o.id', 'f.organism_id').leftJoin('users as cu', 'cu.id', 'f.created_by').leftJoin('users as ru', 'ru.id', 'f.reviewed_by')
        .leftJoin('users as xu', 'xu.id', 'f.cleared_by')
        .selectAll('f').select(['t.name as mdro_name', 't.isolation_type', 't.urgent', 'p.first_name', 'p.last_name', 'p.personal_number', 'p.birth_date', 'p.gender', 'o.name as organism',
          sql<string | null>`cu.first_name || ' ' || cu.last_name`.as('created_by_name'), sql<string | null>`ru.first_name || ' ' || ru.last_name`.as('reviewed_by_name'),
          sql<string | null>`xu.first_name || ' ' || xu.last_name`.as('cleared_by_name'),
          sql<{ encounter_id: string; adm_no: string; department: string | null; bed_code: string | null } | null>`(SELECT json_build_object('encounter_id', st.encounter_id, 'adm_no', st.adm_no,
            'department', d.name, 'bed_code', b.code) FROM inpatient_stays st JOIN bed_assignments a ON a.encounter_id = st.encounter_id AND a.ended_at IS NULL
            LEFT JOIN departments d ON d.id = a.department_id LEFT JOIN beds b ON b.id = a.bed_id WHERE st.patient_id = f.patient_id AND st.status = 'active')`.as('stay')])
        .where('f.id', '=', id).executeTakeFirstOrThrow(),
      this.db.selectFrom('ipc_flag_detections as x').innerJoin('dx_order_items as i', 'i.id', 'x.order_item_id').innerJoin('dx_services as s', 's.id', 'i.service_id')
        .leftJoin('micro_organisms as o', 'o.id', 'x.organism_id').leftJoin('ipc_mdro_rules as ru', 'ru.id', 'x.rule_id')
        .select(['x.id', 'x.order_item_id', 'x.specimen_at', 'x.detected_at', 's.name as service', 's.specimen_type', 'o.name as organism', 'ru.note as rule'])
        .where('x.flag_id', '=', id).orderBy('x.detected_at').execute(),
      this.db.selectFrom('ipc_isolations as i').innerJoin('inpatient_stays as st', 'st.encounter_id', 'i.encounter_id')
        .select(['i.id', 'i.type', 'i.reason', 'i.started_at', 'i.ended_at', 'i.end_reason', 'st.adm_no', 'i.encounter_id']).where('i.flag_id', '=', id).orderBy('i.started_at').execute(),
      this.db.selectFrom('ipc_patient_flags as f').innerJoin('ipc_mdro_types as t', 't.code', 'f.mdro_code')
        .select(['f.id', 'f.mdro_code', 't.name as mdro_name', 'f.status', 'f.detected_at', 'f.cleared_at']).where('f.patient_id', '=', f.patient_id).where('f.id', '<>', id)
        .orderBy('f.detected_at', 'desc').execute(),
    ]);
    const r = await this.c.rules();
    return { ...head, onset_ka: head.onset ? ONSET_KA[head.onset] : null, detections, isolations, history, clear_negatives_required: r.mdro_clear_negatives,
      can: { manage: has(u, ...IPC_FULL) } };
  }

  async create(d: FlagCreateDto, u: AuthUser, req: Request) {
    const r = await this.c.rules();
    const t = await this.db.selectFrom('ipc_mdro_types').select(['code', 'is_active', 'expiry_days']).where('code', '=', d.mdro_code).executeTakeFirst();
    if (!t?.is_active) throw new BadRequestException({ code: 'MDRO_TYPE', message: 'MDRO ტიპი ვერ მოიძებნა ან გათიშულია' });
    const p = await this.db.selectFrom('patients').select('id').where('id', '=', d.patient_id).executeTakeFirst();
    if (!p) throw new NotFoundException('პაციენტი ვერ მოიძებნა');
    const f = await this.db.transaction().execute(async (trx) => {
      const open = await trx.selectFrom('ipc_patient_flags').select(['id', 'status']).where('patient_id', '=', d.patient_id).where('mdro_code', '=', d.mdro_code)
        .where('status', 'in', ['suggested', 'active']).forUpdate().executeTakeFirst();
      if (open) throw new ConflictException({ code: 'FLAG_EXISTS', message: open.status === 'suggested' ? 'ამ MDRO-ზე შეთავაზება უკვე არის — დაადასტურეთ' : 'ფლაგი უკვე აქტიურია', id: open.id });
      const stay = await trx.selectFrom('inpatient_stays').select('encounter_id').where('patient_id', '=', d.patient_id).where('status', '=', 'active').executeTakeFirst();
      const row = await trx.insertInto('ipc_patient_flags').values({ patient_id: d.patient_id, mdro_code: d.mdro_code, status: 'active', source: d.source, onset: d.onset ?? 'unknown',
        encounter_id: stay?.encounter_id ?? null, specimen_at: d.specimen_at ?? null, created_by: u.id, note: d.note?.trim() || null, reviewed_at: sql`now()`, reviewed_by: u.id,
        expires_at: t.expiry_days ? sql<Date>`now() + make_interval(days => ${t.expiry_days})` : null }).returning(['id', 'patient_id', 'mdro_code', 'status', 'encounter_id']).executeTakeFirstOrThrow();
      await this.audit.log(auditCtx(req), { action: 'IPC_FLAG_CREATE', entityName: 'ipc_patient_flags', entityId: row.id, newData: d }, trx);
      return row;
    });
    await this.notifyNew(f, r);
    return this.detail(f.id, u);
  }

  /** შეთავაზება → აქტიური, ან აქტიური (ავტომატური) → გადახედილი */
  async confirm(id: string, d: FlagConfirmDto, u: AuthUser, req: Request) {
    const r = await this.c.rules();
    const was = await this.db.transaction().execute(async (trx) => {
      const f = await trx.selectFrom('ipc_patient_flags').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!f) throw new NotFoundException('ფლაგი ვერ მოიძებნა');
      if (!['suggested', 'active'].includes(f.status)) throw new ConflictException({ code: 'FLAG_CLOSED', message: 'ფლაგი დახურულია' });
      if (f.status === 'active' && f.reviewed_at) throw new ConflictException({ code: 'NO_CHANGE', message: 'ფლაგი უკვე დადასტურებულია' });
      await trx.updateTable('ipc_patient_flags').set({ status: 'active', reviewed_at: sql`now()`, reviewed_by: u.id, ...(d.note?.trim() && { note: d.note.trim() }) }).where('id', '=', id).execute();
      await this.audit.log(auditCtx(req), { action: 'IPC_FLAG_CONFIRM', entityName: 'ipc_patient_flags', entityId: id, oldData: { status: f.status }, newData: { status: 'active', note: d.note } }, trx);
      return f;
    });
    if (was.status === 'suggested') await this.notifyNew({ id, patient_id: was.patient_id, mdro_code: was.mdro_code, status: 'active', encounter_id: was.encounter_id }, r);
    return this.detail(id, u);
  }

  /** dismiss — შეცდომა / არ არის MDRO; clear — მოხსნა (უარყოფითი სკრინინგები ≥ პარამეტრი). MDRO-ს გამო იზოლაციაც იხურება (dismiss — ყოველთვის, clear — end_isolation) */
  async close(id: string, kind: 'dismiss' | 'clear', d: { reason: string; negatives?: number; end_isolation?: boolean }, u: AuthUser, req: Request) {
    const r = await this.c.rules();
    if (kind === 'clear' && (d.negatives ?? 0) < r.mdro_clear_negatives) {
      throw new BadRequestException({ code: 'NEGATIVES', message: `მოხსნისთვის საჭიროა მინიმუმ ${r.mdro_clear_negatives} უარყოფითი სკრინინგი (პარამეტრი)` });
    }
    const ended = await this.db.transaction().execute(async (trx) => {
      const f = await trx.selectFrom('ipc_patient_flags').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!f) throw new NotFoundException('ფლაგი ვერ მოიძებნა');
      if (kind === 'clear' && f.status !== 'active') throw new ConflictException({ code: 'FLAG_STATE', message: 'მოიხსნება მხოლოდ აქტიური ფლაგი' });
      if (kind === 'dismiss' && !['suggested', 'active'].includes(f.status)) throw new ConflictException({ code: 'FLAG_STATE', message: 'ფლაგი უკვე დახურულია' });
      await trx.updateTable('ipc_patient_flags').set({ status: kind === 'clear' ? 'cleared' : 'dismissed', cleared_at: sql`now()`, cleared_by: u.id, clear_reason: d.reason.trim(),
        clear_negatives: kind === 'clear' ? d.negatives ?? 0 : null, ...(f.reviewed_at ? {} : { reviewed_at: sql`now()`, reviewed_by: u.id }) }).where('id', '=', id).execute();
      let n = 0;
      if (kind === 'dismiss' || d.end_isolation !== false) {
        const iso = await trx.selectFrom('ipc_isolations').select(['id', 'encounter_id', 'type']).where('flag_id', '=', id).where('ended_at', 'is', null).execute();
        for (const i of iso) {
          await isoEnd(trx, i.id, u.id, `MDRO ფლაგი ${kind === 'clear' ? 'მოიხსნა' : 'გაუქმდა'}: ${d.reason.trim()}`);
          await trx.insertInto('inpatient_events').values({ encounter_id: i.encounter_id, kind: 'isolation', user_id: u.id,
            data: JSON.stringify({ action: 'end', type: i.type, reason: `MDRO ფლაგი ${kind === 'clear' ? 'მოიხსნა' : 'გაუქმდა'}` }) }).execute();
          n++;
        }
      }
      await this.audit.log(auditCtx(req), { action: kind === 'clear' ? 'IPC_FLAG_CLEAR' : 'IPC_FLAG_DISMISS', entityName: 'ipc_patient_flags', entityId: id,
        oldData: { status: f.status }, newData: { ...d, isolations_ended: n } }, trx);
      return n;
    });
    return { ...(await this.detail(id, u)), isolations_ended: ended };
  }
}

@Controller('ipc')
export class IpcFlagsController {
  constructor(private readonly s: IpcMdroService) {}
  @Get('patients/:id/status') @Roles(...IPC_STATUS_READ) status(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser) { return this.s.patientStatus(id, u); }
  @Get('flags') @Roles(...IPC_ANY) list(@CurrentUser() u: AuthUser, @Query('status') status?: string, @Query('mdro_code') mdro_code?: string, @Query('review') review?: string,
    @Query('department_id') department_id?: string, @Query('q') q?: string) { return this.s.list(u, { status, mdro_code, review, department_id, q }); }
  @Get('flags/:id') @Roles(...IPC_ANY) detail(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser) { return this.s.detail(id, u); }
  @Post('flags') @Roles(...IPC_FULL) create(@Body() d: FlagCreateDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.create(d, u, r); }
  @Post('flags/:id/confirm') @HttpCode(200) @Roles(...IPC_FULL) confirm(@Param('id', ParseUUIDPipe) id: string, @Body() d: FlagConfirmDto, @CurrentUser() u: AuthUser, @Req() r: Request) {
    return this.s.confirm(id, d, u, r);
  }
  @Post('flags/:id/dismiss') @HttpCode(200) @Roles(...IPC_FULL) dismiss(@Param('id', ParseUUIDPipe) id: string, @Body() d: FlagReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) {
    return this.s.close(id, 'dismiss', d, u, r);
  }
  @Post('flags/:id/clear') @HttpCode(200) @Roles(...IPC_FULL) clear(@Param('id', ParseUUIDPipe) id: string, @Body() d: FlagClearDto, @CurrentUser() u: AuthUser, @Req() r: Request) {
    return this.s.close(id, 'clear', d, u, r);
  }
}
