import { sql, type RawBuilder } from 'kysely';
import { STATUS_KA, type BmeSettings, type BmeStatus, type Criticality, type Ex } from './bme-common';
import { TZ } from './bme-pm-common';

/**
 * ბიომედ-აპარატურა, ეტაპი 3 (0075) — შეკეთების ორდერის საერთო ლოგიკა (API + PM-ის „ვერ გაიარა“ + worker):
 *  პრიორიტეტის შეთავაზება, დაფარვა (გარანტია / კონტრაქტი), SLA-ს საათები, ნომერი, სტატუსის ცვლილება ორდერის ბმით, ორდერის შექმნა.
 */
export const REP_STATUSES = ['requested', 'triaged', 'in_progress', 'waiting_parts', 'waiting_vendor', 'done', 'closed', 'rejected', 'duplicate'] as const;
export type RepStatus = (typeof REP_STATUSES)[number];
/** ღია (სამუშაო მიმდინარეობს / ელოდება) */
export const REP_OPEN: RepStatus[] = ['requested', 'triaged', 'in_progress', 'waiting_parts', 'waiting_vendor'];
/** აქტიური (დაუხურავი): ღია + შესრულებული (დადასტურებას ელოდება) */
export const REP_ACTIVE: RepStatus[] = [...REP_OPEN, 'done'];
export const REP_STATUS_KA: Record<RepStatus, string> = {
  requested: 'მოთხოვნა (ტრიაჟს ელოდება)', triaged: 'ტრიაჟი გავლილია', in_progress: 'მიმდინარეობს', waiting_parts: 'ელოდება ნაწილებს', waiting_vendor: 'ელოდება მომწოდებელს',
  done: 'შესრულდა (დადასტურებას ელოდება)', closed: 'დახურულია', rejected: 'უარყოფილია', duplicate: 'დუბლიკატი',
};
export const CONDITIONS = ['not_working', 'limited', 'issue'] as const;
export type Condition = (typeof CONDITIONS)[number];
export const CONDITION_KA: Record<Condition, string> = { not_working: 'არ მუშაობს', limited: 'შეზღუდულად მუშაობს', issue: 'მუშაობს, მაგრამ პრობლემაა' };
export const URGENCIES = ['safety', 'urgent', 'normal'] as const;
export type Urgency = (typeof URGENCIES)[number];
export const URGENCY_KA: Record<Urgency, string> = { safety: 'პაციენტის უსაფრთხოება', urgent: 'სასწრაფო', normal: 'ჩვეულებრივი' };
export const OUTCOMES = ['repaired', 'not_repairable', 'no_fault'] as const;
export type Outcome = (typeof OUTCOMES)[number];
export const OUTCOME_KA: Record<Outcome, string> = { repaired: 'შეკეთებულია', not_repairable: 'შეუკეთებელია / ჩამოსაწერი', no_fault: 'დაზიანება არ დადასტურდა' };
export const REJECT_REASONS = ['no_fault', 'user_error', 'duplicate', 'other'] as const;
export const REJECT_KA: Record<(typeof REJECT_REASONS)[number], string> = { no_fault: 'გაუმართაობა არ არის', user_error: 'მომხმარებლის შეცდომა (ინსტრუქტაჟი)', duplicate: 'დუბლიკატი', other: 'სხვა' };
export const CONTRACT_KINDS = ['full_service', 'pm_only', 'parts', 'on_call', 'ext_warranty'] as const;
export type ContractKind = (typeof CONTRACT_KINDS)[number];
export const CONTRACT_KA: Record<ContractKind, string> = { full_service: 'სრული სერვისი', pm_only: 'მხოლოდ გეგმიური (PM)', parts: 'ნაწილები', on_call: 'გამოძახებით', ext_warranty: 'გაგრძელებული გარანტია' };
/** შეკეთებას ფარავს (pm_only — არა) */
export const REPAIR_COVER: ContractKind[] = ['full_service', 'parts', 'on_call', 'ext_warranty'];

/**
 * პრიორიტეტის შეთავაზება (ინჟინერი ტრიაჟზე ადგენს საბოლოოს):
 *  P1 — პაციენტის უსაფრთხოება, ან სიცოცხლის შემანარჩუნებელი „არ მუშაობს“;  P2 — მაღალი კრიტიკულობის „არ მუშაობს“, სასწრაფო, ან სიცოცხლის შემანარჩუნებელი „შეზღუდულად“;
 *  P3 — „არ მუშაობს“ (საშუალო / დაბალი) ან მაღალი „შეზღუდულად“;  P4 — დანარჩენი.
 */
export function suggestPriority(c: Condition, urg: Urgency, crit: Criticality): number {
  if (urg === 'safety' || (c === 'not_working' && crit === 'life_support')) return 1;
  if ((c === 'not_working' && crit === 'high') || urg === 'urgent' || (c === 'limited' && crit === 'life_support')) return 2;
  if (c === 'not_working' || (c === 'limited' && crit === 'high')) return 3;
  return 4;
}

export interface Coverage { coverage: 'warranty' | 'contract' | null; contract_id: string | null; contract_no: string | null; contract_kind: string | null; supplier_id: string | null; supplier_name: string | null;
  until: string | null; response_hours: number[] | null; restore_hours: number[] | null }
/** დაფარვა: ქარხნული გარანტია (პასპორტი) → აქტიური კონტრაქტი, რომელიც შეკეთებას ფარავს (უახლოესი ვადით — ბოლოს მთავრდება) */
export async function coverage(ex: Ex, deviceId: string, at: RawBuilder<string> = sql<string>`(now() AT TIME ZONE ${TZ})::date`): Promise<Coverage> {
  const d = await ex.selectFrom('bme_devices as b').leftJoin('stock_suppliers as s', 's.id', 'b.supplier_id')
    .select(['b.warranty_until', 'b.supplier_id', 's.name as supplier_name', sql<boolean>`b.warranty_until IS NOT NULL AND b.warranty_until >= ${at}`.as('wr')])
    .where('b.id', '=', deviceId).executeTakeFirst();
  const c = await ex.selectFrom('bme_contracts as c').innerJoin('bme_contract_devices as cd', 'cd.contract_id', 'c.id').innerJoin('stock_suppliers as s', 's.id', 'c.supplier_id')
    .select(['c.id', 'c.contract_no', 'c.kind', 'c.supplier_id', 's.name as supplier_name', sql<string>`to_char(c.end_date, 'YYYY-MM-DD')`.as('until'), 'c.response_hours', 'c.restore_hours'])
    .where('cd.device_id', '=', deviceId).where('c.status', '=', 'active').where('c.kind', 'in', REPAIR_COVER)
    .where(sql<boolean>`${at} BETWEEN c.start_date AND c.end_date`).orderBy('c.end_date', 'desc').limit(1).executeTakeFirst();
  // ქარხნული გარანტია; თუ ამავე დროს კონტრაქტიც არის — SLA-ს საათები კონტრაქტიდან
  if (d?.wr) return { coverage: 'warranty', contract_id: null, contract_no: null, contract_kind: null, supplier_id: d.supplier_id, supplier_name: d.supplier_name,
    until: d.warranty_until, response_hours: c?.response_hours ?? null, restore_hours: c?.restore_hours ?? null };
  if (c) return { coverage: 'contract', contract_id: c.id, contract_no: c.contract_no, contract_kind: c.kind, supplier_id: c.supplier_id, supplier_name: c.supplier_name,
    until: c.until, response_hours: c.response_hours, restore_hours: c.restore_hours };
  return { coverage: null, contract_id: null, contract_no: null, contract_kind: null, supplier_id: null, supplier_name: null, until: null, response_hours: null, restore_hours: null };
}

/** SLA-ს საათები: გარე შემსრულებელი + კონტრაქტის საათები → კონტრაქტიდან; სხვა შემთხვევაში — პარამეტრებიდან (P1–P4) */
export function slaHours(s: BmeSettings, priority: number, external: boolean, contract?: { response_hours: number[] | null; restore_hours: number[] | null } | null) {
  const i = Math.min(Math.max(priority, 1), 4) - 1;
  const resp = (external && contract?.response_hours?.[i]) || s.rep_sla_response?.[i] || [1, 4, 24, 72][i];
  const rest = (external && contract?.restore_hours?.[i]) || s.rep_sla_restore?.[i] || [24, 72, 168, 336][i];
  return { response: resp, restore: Math.max(rest, resp) };
}

/** ორდერის № — RO26-00001 (პრეფიქსი პარამეტრით, წლიური მთვლელი) */
export async function repairNo(ex: Ex, s: BmeSettings) {
  const yr = Number(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric' }).format(new Date()));
  const prefix = s.rep_prefix || 'RO';
  const { last_value } = await ex.insertInto('document_counters').values({ document_type: `bme_repair_${prefix}`, year: yr, last_value: 1 })
    .onConflict((oc) => oc.columns(['document_type', 'year']).doUpdateSet({ last_value: sql`document_counters.last_value + 1` })).returning('last_value').executeTakeFirstOrThrow();
  return `${prefix}${String(yr).slice(2)}-${String(last_value).padStart(5, '0')}`;
}

export function repEvent(ex: Ex, repairId: string, kind: string, data: Record<string, unknown>, userId: string | null) {
  return ex.insertInto('bme_repair_events').values({ repair_id: repairId, kind, data: JSON.stringify(data), user_id: userId }).execute();
}
export function devEvent(ex: Ex, deviceId: string, kind: string, data: Record<string, unknown>, userId: string | null) {
  return ex.insertInto('bme_events').values({ device_id: deviceId, kind, data: JSON.stringify(data), user_id: userId }).execute();
}

/**
 * აპარატის სტატუსის ცვლილება ორდერის ფარგლებში (იმავე ტრანზაქციაში): ღია პერიოდი იხურება, ახალი — ორდერზე მიბმული (downtime / MTTR).
 * ბრუნდება წინა სტატუსი; უცვლელი → null. გამოყვანა (retired) — აქ არა (BmeService.setStatus — გეგმები / სამუშაოები).
 */
export async function setDeviceStatus(ex: Ex, deviceId: string, to: Exclude<BmeStatus, 'retired'>, reason: string | null, userId: string | null, repairId: string | null): Promise<BmeStatus | null> {
  const d = await ex.selectFrom('bme_devices').select(['status', 'status_reason']).where('id', '=', deviceId).forUpdate().executeTakeFirstOrThrow();
  if (d.status === 'retired') return null;
  if (d.status === to && (d.status_reason ?? '') === (reason ?? '')) return null;
  await ex.updateTable('bme_status_periods').set({ ended_at: sql`now()`, ended_by: userId }).where('device_id', '=', deviceId).where('ended_at', 'is', null).execute();
  await ex.insertInto('bme_status_periods').values({ device_id: deviceId, status: to, reason, started_by: userId, repair_id: repairId }).execute();
  await ex.updateTable('bme_devices').set({ status: to, status_reason: reason, status_since: sql`now()`, updated_at: sql`now()` }).where('id', '=', deviceId).execute();
  await devEvent(ex, deviceId, 'status', { from: d.status, to, reason, ...(repairId && { repair_id: repairId }) }, userId);
  return d.status as BmeStatus;
}

/** მიმღებები */
export async function usersWithCaps(ex: Ex, caps: string[]) {
  return (await sql<{ id: string }>`SELECT u.id FROM users u JOIN user_capabilities c ON c.user_id = u.id WHERE u.is_active AND c.capabilities && ${sql.val(caps)}::varchar[]`.execute(ex)).rows.map((r) => r.id);
}
export async function deptBmeUsers(ex: Ex, dep: string | null) {
  if (!dep) return [];
  return (await sql<{ id: string }>`SELECT u.id FROM users u JOIN user_capabilities c ON c.user_id = u.id WHERE u.is_active AND c.capabilities && ARRAY['bme_dept']::varchar[]
    AND (u.department_id = ${dep} OR EXISTS (SELECT 1 FROM rpt_user_scopes s WHERE s.user_id = u.id AND s.department_id = ${dep}))`.execute(ex)).rows.map((r) => r.id);
}

export interface NewRepair {
  device_id: string; source: 'request' | 'pm_work' | 'engineer'; pm_work_id?: string | null; condition: Condition; urgency: Urgency; description: string;
  patient_involved?: boolean; contact_phone?: string | null; reporter_department_id?: string | null;
  /** ტრიაჟის გარეშე (PM / ინჟინერი): პრიორიტეტი = შეთავაზებული, შემსრულებელი — თავად */
  triaged?: boolean;
}
/**
 * ორდერის შექმნა (იმავე ტრანზაქციაში): №, პრიორიტეტის შეთავაზება, „არ მუშაობს“ → „გაუმართავი“ (rep_sets_down), ისტორია.
 * triaged — SLA-ც ითვლება (შიდა შემსრულებელი = ავტორი).
 */
export async function createRepair(ex: Ex, s: BmeSettings, r: NewRepair, userId: string) {
  const d = await ex.selectFrom('bme_devices').select(['id', 'inv_no', 'name', 'status', 'criticality', 'department_id']).where('id', '=', r.device_id).forUpdate().executeTakeFirst();
  if (!d) throw Object.assign(new Error('device'), { status: 404 });
  const no = await repairNo(ex, s);
  const sp = suggestPriority(r.condition, r.urgency, d.criticality as Criticality);
  const sla = r.triaged ? slaHours(s, sp, false) : null;
  const rep = await ex.insertInto('bme_repairs').values({
    repair_no: no, device_id: d.id, source: r.source, pm_work_id: r.pm_work_id ?? null, condition: r.condition, urgency: r.urgency, description: r.description.trim(),
    patient_involved: !!r.patient_involved, contact_phone: r.contact_phone?.trim() || null, reported_by: userId, reporter_department_id: r.reporter_department_id ?? null,
    device_status_before: d.status, suggested_priority: sp,
    ...(r.triaged && { status: 'triaged', priority: sp, triaged_by: userId, triaged_at: sql`now()`, performer_kind: 'internal', assignee_id: userId,
      sla_response_hours: sla!.response, sla_restore_hours: sla!.restore,
      sla_response_due: sql`now() + make_interval(hours => ${sla!.response})`, sla_restore_due: sql`now() + make_interval(hours => ${sla!.restore})` }),
  }).returning(['id', 'repair_no']).executeTakeFirstOrThrow();
  let statusChanged = false;
  if (r.condition === 'not_working' && s.rep_sets_down && ['operational', 'restricted', 'standby'].includes(d.status)) {
    statusChanged = !!(await setDeviceStatus(ex, d.id, 'down', `${no}: ${r.description.trim().slice(0, 160)}`, userId, rep.id));
  }
  await repEvent(ex, rep.id, 'requested', { source: r.source, condition: r.condition, urgency: r.urgency, suggested_priority: sp, status_down: statusChanged, ...(r.pm_work_id && { pm_work_id: r.pm_work_id }) }, userId);
  if (r.triaged) await repEvent(ex, rep.id, 'triaged', { priority: sp, auto: true }, userId);
  await devEvent(ex, d.id, 'repair_requested', { repair_id: rep.id, repair_no: no, condition: r.condition, urgency: r.urgency }, userId);
  return { id: rep.id, repair_no: no, priority: sp, device: d, status_down: statusChanged };
}

/** SLA-ს მდგომარეობა (SQL, ალიასი r — bme_repairs): met / breached / warn / ok / null */
export function slaState(kind: 'response' | 'restore', pct: number, now: RawBuilder<unknown> = sql`now()`) {
  const due = sql.ref(kind === 'response' ? 'r.sla_response_due' : 'r.sla_restore_due');
  const hrs = sql.ref(kind === 'response' ? 'r.sla_response_hours' : 'r.sla_restore_hours');
  const at = kind === 'response' ? sql`CASE WHEN r.performer_kind = 'external' THEN r.vendor_arrived_at ELSE r.started_at END` : sql`r.done_at`;
  return sql<'met' | 'breached' | 'warn' | 'ok' | null>`CASE WHEN ${due} IS NULL OR r.status IN ('rejected', 'duplicate') THEN NULL
    WHEN ${at} IS NOT NULL THEN CASE WHEN ${at} <= ${due} THEN 'met' ELSE 'breached' END
    WHEN ${now} > ${due} THEN 'breached'
    WHEN ${now} > ${due} - make_interval(secs => ${hrs} * 3600 * (100 - ${pct}) / 100.0) THEN 'warn' ELSE 'ok' END`;
}

export const statusKa = (st: string) => STATUS_KA[st as BmeStatus] ?? st;
