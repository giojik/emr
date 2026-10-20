import { ConflictException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { has, type AuthUser, type Role } from '../auth/roles';
import { InjectDb, type Database } from '../database/database.module';
import type { DB } from '../database/db';
import { NotificationsService } from '../notifications/notifications';
import { NotifyService } from '../notify/notify.service';

export type Trx = Transaction<DB>;
export type Ex = Database | Trx;

/** მოდულის პარამეტრები (0067) */
export interface IpcRules {
  isolation_remove_mdro: 'ipc' | 'staff'; ward_conflict: 'warn' | 'block'; wristband_symbol: boolean; door_sign: boolean;
  mdro_flag_mode: 'auto' | 'suggest'; mdro_clear_negatives: number; mdro_suggest_isolation: boolean; hospital_onset_day: number;
  alert_new_flag: boolean; alert_sms: boolean; alert_email: boolean;
}
export const IPC_DEFAULTS: IpcRules = {
  isolation_remove_mdro: 'ipc', ward_conflict: 'warn', wristband_symbol: false, door_sign: true, mdro_flag_mode: 'auto', mdro_clear_negatives: 3,
  mdro_suggest_isolation: true, hospital_onset_day: 3, alert_new_flag: true, alert_sms: false, alert_email: false,
};

export const ISO_TYPES = ['contact', 'contact_plus', 'droplet', 'airborne', 'protective'] as const;
export type IsoType = (typeof ISO_TYPES)[number];
/** გადამდები (დამცავი — არა) */
export const INFECTIOUS: string[] = ['contact', 'contact_plus', 'droplet', 'airborne'];
export const ISO_REASONS = ['mdro', 'suspected', 'confirmed', 'screening', 'immunosuppressed', 'other'] as const;
export const MARKERS = ['esbl', 'carbapenemase', 'ampc', 'mlsb', 'pbp2a', 'van'] as const;
export const ISO_KA: Record<string, string> = { contact: 'კონტაქტური', contact_plus: 'გაძლიერებული კონტაქტური', droplet: 'წვეთოვანი', airborne: 'საჰაერო', protective: 'დამცავი' };
export const REASON_KA: Record<string, string> = { mdro: 'MDRO', suspected: 'ინფექციაზე ეჭვი', confirmed: 'დადასტურებული ინფექცია', screening: 'სკრინინგის პასუხის მოლოდინი',
  immunosuppressed: 'იმუნოსუპრესია', other: 'სხვა' };

export const IPC_FULL: Role[] = ['infection'];
export const IPC_DEPT: Role[] = ['infection_dept'];
export const IPC_ANY: Role[] = ['infection', 'infection_dept'];
/** პაციენტის სტატუსი (ფლაგი / იზოლაცია) — ყველა, ვინც პაციენტთან მუშაობს */
export const IPC_STATUS_READ: Role[] = ['admin', 'receptionist', 'doctor', 'nurse', 'billing', 'diagnostic', 'manager', 'viewer', 'radiographer', 'radiologist',
  'endoscopist', 'endoscopy_nurse', 'phlebotomist', 'lab_doctor', 'lab_manager', 'anesthesiologist', 'or_nurse', 'or_schedule', 'pharmacist', 'drg',
  'infection', 'infection_dept'];

export const userName = (alias: string) => sql<string | null>`${sql.ref(`${alias}.first_name`)} || ' ' || ${sql.ref(`${alias}.last_name`)}`;

/** პარამეტრები ბაზიდან (trx-შიც) — გამორთულ მოდულზე null */
export async function ipcRules(ex: Ex): Promise<IpcRules | null> {
  const m = await ex.selectFrom('system_modules').select(['enabled', 'settings']).where('code', '=', 'ipc').executeTakeFirst();
  return m?.enabled ? { ...IPC_DEFAULTS, ...(m.settings as Partial<IpcRules>) } : null;
}

/** პაციენტის აქტიური MDRO ფლაგები (კოდები) */
export async function activeFlagCodes(ex: Ex, patientId: string) {
  const r = await ex.selectFrom('ipc_patient_flags').select('mdro_code').where('patient_id', '=', patientId).where('status', '=', 'active').execute();
  return r.map((x) => x.mdro_code).sort();
}

/**
 * საწოლის შემოწმება იზოლაციის მიხედვით (InpatientService.lockBed-იდან): პალატაში სხვა პაციენტებთან კონფლიქტი.
 *  • ჩემი იზოლაცია / MDRO + პალატაში სხვაც არის → კონფლიქტი;
 *  • პალატაში ვინმეს აქვს გადამდები იზოლაცია / MDRO → კონფლიქტი;
 *  • დამცავი იზოლაცია ↔ გადამდები / MDRO → კონფლიქტი;
 *  • კოჰორტა: ორივეს აქვს ერთი და იგივე MDRO ნაკრები, საჰაერო / წვეთოვანის გარეშე → მხოლოდ გაფრთხილება.
 * ward_conflict = block: კონფლიქტი → 409 ISOLATION_WARD (ინფექციის კონტროლს — გაფრთხილება); warn → გაფრთხილება (confirm).
 */
export async function ipcBedCheck(trx: Trx, p: { wardId: string; wardCode: string; patientId?: string | null; encounterId?: string | null; isolation?: string | null; user: AuthUser | null }) {
  const r = await ipcRules(trx);
  if (!r || !p.patientId) return [] as string[];
  const mine = new Set<string>();
  if (p.isolation) mine.add(p.isolation);
  if (p.encounterId) {
    const iso = await trx.selectFrom('ipc_isolations').select('type').where('encounter_id', '=', p.encounterId).where('ended_at', 'is', null).execute();
    iso.forEach((x) => mine.add(x.type));
  }
  const myFlags = await activeFlagCodes(trx, p.patientId);
  const others = await trx.selectFrom('bed_assignments as a').innerJoin('beds as b', 'b.id', 'a.bed_id').innerJoin('inpatient_stays as st', 'st.encounter_id', 'a.encounter_id')
    .select(['a.encounter_id', 'st.patient_id', 'b.code as bed_code',
      sql<string[]>`ARRAY(SELECT i.type FROM ipc_isolations i WHERE i.encounter_id = a.encounter_id AND i.ended_at IS NULL)`.as('iso'),
      sql<string[]>`ARRAY(SELECT f.mdro_code FROM ipc_patient_flags f WHERE f.patient_id = st.patient_id AND f.status = 'active' ORDER BY f.mdro_code)`.as('flags')])
    .where('b.ward_id', '=', p.wardId).where('a.ended_at', 'is', null).where('st.status', '=', 'active').where('st.patient_id', '<>', p.patientId).execute();
  if (!others.length) return [];
  const myInf = [...mine].some((t) => INFECTIOUS.includes(t)) || myFlags.length > 0;
  const myProt = mine.has('protective');
  const conflicts: string[] = []; const cohort: string[] = [];
  for (const o of others) {
    const oInf = o.iso.some((t) => INFECTIOUS.includes(t)) || o.flags.length > 0;
    const oProt = o.iso.includes('protective');
    const resp = [...mine, ...o.iso].some((t) => t === 'airborne' || t === 'droplet');
    const same = myFlags.length > 0 && o.flags.length > 0 && myFlags.join(',') === o.flags.join(',') && !resp;
    const what = [...o.iso.map((t) => ISO_KA[t] ?? t), ...o.flags.map((f) => f.toUpperCase())].join(', ');
    if (same) cohort.push(`საწოლი ${o.bed_code}: ${o.flags.map((f) => f.toUpperCase()).join(', ')}`);
    else if (oInf && !myProt) conflicts.push(`პალატაში ${p.wardCode} (საწოლი ${o.bed_code}) — იზოლაცია / MDRO: ${what}`);
    else if (myInf && !oProt) conflicts.push(`პაციენტს აქვს იზოლაცია / MDRO (${[...[...mine].map((t) => ISO_KA[t] ?? t), ...myFlags.map((f) => f.toUpperCase())].join(', ')}); პალატა ${p.wardCode} — მრავალსაწოლიანი (საწოლი ${o.bed_code} დაკავებულია)`);
    else if ((myProt && oInf) || (oProt && myInf)) conflicts.push(`დამცავი იზოლაცია და გადამდები პაციენტი ერთ პალატაში (${p.wardCode}, საწოლი ${o.bed_code})`);
  }
  if (conflicts.length && r.ward_conflict === 'block' && !(p.user && has(p.user, ...IPC_FULL))) {
    throw new ConflictException({ code: 'ISOLATION_WARD', message: `${conflicts.join('; ')} (წესი: აკრძალულია — კოჰორტირებას წყვეტს ინფექციის კონტროლი)` });
  }
  return [...conflicts, ...cohort.map((c) => `კოჰორტა (იგივე MDRO) — ${c}`)];
}

/** იზოლაციის დაწყება trx-ში (ჰოსპიტალიზაციის ფორმიდან / ძველი PATCH-იდან / IPC API-დან). ერთი და იგივე ტიპი ორჯერ — 409 */
export async function isoStart(trx: Trx, x: { encounterId: string; patientId: string; type: string; reason: string; reasonText?: string | null; flagId?: string | null; userId: string }) {
  const dup = await trx.selectFrom('ipc_isolations').select('id').where('encounter_id', '=', x.encounterId).where('type', '=', x.type).where('ended_at', 'is', null).executeTakeFirst();
  if (dup) throw new ConflictException({ code: 'ISOLATION_ACTIVE', message: `${ISO_KA[x.type] ?? x.type} იზოლაცია უკვე აქტიურია` });
  return trx.insertInto('ipc_isolations').values({ encounter_id: x.encounterId, patient_id: x.patientId, type: x.type, reason: x.reason, reason_text: x.reasonText?.trim() || null,
    flag_id: x.flagId ?? null, started_by: x.userId }).returningAll().executeTakeFirstOrThrow();
}

/** შეუძლია თუ არა მოხსნას: MDRO-ს გამო დადებული (isolation_remove_mdro = ipc) — მხოლოდ ინფექციის კონტროლი */
export function canEndIsolation(u: AuthUser, iso: { reason: string }, r: IpcRules | null) {
  if (iso.reason !== 'mdro' || !r || r.isolation_remove_mdro === 'staff') return true;
  return has(u, ...IPC_ANY);
}

export async function isoEnd(trx: Trx, id: string, userId: string, reason: string) {
  return trx.updateTable('ipc_isolations').set({ ended_at: sql`greatest(started_at, now())`, ended_by: userId, end_reason: reason.trim() })
    .where('id', '=', id).where('ended_at', 'is', null).returningAll().executeTakeFirst();
}

/**
 * ძველი API (PATCH /inpatient/stays/:id {isolation}) — ერთი მნიშვნელობა: აქტიური ეპიზოდები იხურება, ახალი იწყება („სხვა“).
 * MDRO-ს გამო დადებულს ხურავს მხოლოდ ინფექციის კონტროლი (isolation_remove_mdro = ipc).
 */
export async function isoReplaceLegacy(trx: Trx, x: { encounterId: string; patientId: string; type: string | null; reason?: string | null; user: AuthUser }) {
  const r = await ipcRules(trx);
  const act = await trx.selectFrom('ipc_isolations').selectAll().where('encounter_id', '=', x.encounterId).where('ended_at', 'is', null).execute();
  const keep = x.type ? act.find((a) => a.type === x.type) : undefined;
  for (const a of act) {
    if (a === keep) continue;
    if (!canEndIsolation(x.user, a, r)) throw new ForbiddenException({ code: 'IPC_ONLY', message: `${ISO_KA[a.type]} იზოლაცია MDRO-ს გამოა — მოხსნის ინფექციის კონტროლი` });
    await isoEnd(trx, a.id, x.user.id, x.reason?.trim() || 'შეცვლა (სტაციონარის ფორმა)');
  }
  if (x.type && !keep) await isoStart(trx, { encounterId: x.encounterId, patientId: x.patientId, type: x.type, reason: 'other', reasonText: x.reason?.trim() || 'სტაციონარის ფორმიდან', userId: x.user.id });
}

@Injectable()
export class IpcCommon {
  private readonly log = new Logger('IPC');
  constructor(@InjectDb() readonly db: Database, readonly notifications: NotificationsService, private readonly notify: NotifyService) {}

  /** მოდული ჩართულია → პარამეტრები; გამორთულზე — 403 MODULE_DISABLED */
  async rules(): Promise<IpcRules> {
    const m = await this.db.selectFrom('system_modules').select(['enabled', 'settings', 'name']).where('code', '=', 'ipc').executeTakeFirst();
    if (!m?.enabled) throw new ForbiddenException({ code: 'MODULE_DISABLED', message: 'მოდული „ინფექციის კონტროლი“ გამორთულია (ადმინისტრირება → მოდულები)' });
    return { ...IPC_DEFAULTS, ...(m.settings as Partial<IpcRules>) };
  }
  /** პარამეტრები ან null (გამორთული) — იზოლაცია მოდულის გარეშეც მუშაობს */
  rulesOrNull() { return ipcRules(this.db); }

  /** infection_dept-ის ხედვის არე: rpt_user_scopes ∪ users.department_id */
  async userDepts(userId: string, ex: Ex = this.db) {
    const r = await sql<{ id: string }>`
      SELECT department_id AS id FROM rpt_user_scopes WHERE user_id = ${userId}
      UNION SELECT department_id FROM users WHERE id = ${userId} AND department_id IS NOT NULL`.execute(ex);
    return r.rows.map((x) => x.id);
  }
  /** სიის ხედვა: infection — ყველა; infection_dept — თავისი განყოფილებები; სხვა — 403 */
  async scope(u: AuthUser): Promise<{ full: true } | { full: false; depts: string[] }> {
    if (has(u, ...IPC_FULL)) return { full: true };
    if (has(u, ...IPC_DEPT)) {
      const depts = await this.userDepts(u.id);
      if (!depts.length) throw new ForbiddenException({ code: 'NO_SCOPE', message: 'განყოფილება არ გაქვთ მინიჭებული (მომხმარებლის განყოფილება ან რეპორტინგის ხედვის არე)' });
      return { full: false, depts };
    }
    throw new ForbiddenException('ინფექციის კონტროლის სიაზე წვდომა არ გაქვთ');
  }

  async usersWith(caps: Role[], ex: Ex = this.db) {
    const r = await sql<{ id: string; phone: string | null; email: string | null }>`
      SELECT u.id, u.phone, u.email FROM users u JOIN user_capabilities c ON c.user_id = u.id
      WHERE u.is_active AND c.capabilities && ${sql.val(caps)}::varchar[]`.execute(ex);
    return r.rows;
  }
  /** infection_dept მომხმარებლები, რომელთა არეშია განყოფილება */
  async deptIpcUsers(departmentId: string) {
    const r = await sql<{ id: string }>`
      SELECT u.id FROM users u JOIN user_capabilities c ON c.user_id = u.id
      WHERE u.is_active AND c.capabilities && ARRAY['infection_dept']::varchar[]
        AND (u.department_id = ${departmentId} OR EXISTS (SELECT 1 FROM rpt_user_scopes s WHERE s.user_id = u.id AND s.department_id = ${departmentId}))`.execute(this.db);
    return r.rows.map((x) => x.id);
  }

  async bell(userIds: string[], n: { kind: string; title: string; body?: string | null; link?: string | null; entityId?: string | null; urgent?: boolean }) {
    for (const id of [...new Set(userIds)]) {
      try { await this.notifications.notify(id, n); } catch (e) { this.log.warn(`შეტყობინება: ${(e as Error).message}`); }
    }
  }
  /** SMS / ელფოსტა — პაციენტის მონაცემების გარეშე */
  async alertExternal(r: IpcRules, users: { phone: string | null; email: string | null }[], subject: string, text: string) {
    try {
      if (r.alert_sms) {
        const phones = [...new Set(users.map((x) => x.phone).filter((p): p is string => !!p))];
        if (phones.length) { const s = await this.notify.sms(phones, text); if (s.errors.length) this.log.warn(`SMS: ${s.errors.join('; ')}`); }
      }
      if (r.alert_email) {
        const mails = [...new Set(users.map((x) => x.email).filter((p): p is string => !!p))];
        if (mails.length) { const s = await this.notify.email(mails, subject, text); if (s.errors.length) this.log.warn(`ელფოსტა: ${s.errors.join('; ')}`); }
      }
    } catch (e) { this.log.error(`გაფრთხილება: ${(e as Error).message}`); }
  }
}
