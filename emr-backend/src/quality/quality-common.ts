import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { has, type AuthUser, type Role } from '../auth/roles';
import { InjectDb, type Database } from '../database/database.module';
import type { DB } from '../database/db';
import { ModulesService } from '../modules/modules';
import { NotificationsService } from '../notifications/notifications';
import { NotifyService } from '../notify/notify.service';

export type Trx = Transaction<DB>;
export type Ex = Database | Trx;

/** მოდულის პარამეტრები (0064) */
export interface QmRules {
  identity_modes: IdentityMode[]; identity_default: IdentityMode; ncc_merp: boolean;
  risk_low_max: number; risk_medium_max: number; risk_high_max: number;
  triage_hours: number; sentinel_triage_hours: number;
  alert_harm: 'moderate' | 'severe' | 'death' | 'off'; alert_user_ids: string[]; alert_sms: boolean; alert_email: boolean;
  event_prompts: boolean; author_feedback: boolean; anonymous_tracking: boolean;
}

export const IDENTITY_MODES = ['open', 'confidential', 'anonymous'] as const;
export type IdentityMode = (typeof IDENTITY_MODES)[number];
export const EVENT_TYPES = ['harm', 'no_harm', 'near_miss', 'hazard'] as const;
export const AFFECTED = ['patient', 'staff', 'visitor', 'none'] as const;
export const HARMS = ['none', 'mild', 'moderate', 'severe', 'death'] as const;
export type Harm = (typeof HARMS)[number];
export const MERP = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'] as const;
export const SOURCE_TYPES = ['encounter', 'stay', 'med_order', 'mar_entry', 'or_case', 'dx_order_item', 'lab_specimen', 'asset', 'dx_device'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];
export const REJECT_REASONS = ['duplicate', 'not_incident', 'insufficient', 'other'] as const;
export const STATUSES = ['submitted', 'rejected', 'investigation', 'analysis', 'capa', 'closed'] as const;

export const HARM_KA: Record<Harm, string> = { none: 'ზიანი არ არის', mild: 'მსუბუქი', moderate: 'საშუალო', severe: 'მძიმე', death: 'სიკვდილი' };
export const EVENT_KA: Record<string, string> = { harm: 'ინციდენტი ზიანით', no_harm: 'ინციდენტი ზიანის გარეშე', near_miss: 'near-miss (თავიდან აცილებული)', hazard: 'სახიფათო მდგომარეობა' };
export const STATUS_KA: Record<string, string> = { submitted: 'ტრიაჟს ელოდება', rejected: 'უარყოფილი', investigation: 'განიხილება', analysis: 'ანალიზი', capa: 'მაკორექტირებელი ქმედებები', closed: 'დახურული' };
export const REJECT_KA: Record<string, string> = { duplicate: 'დუბლიკატი', not_incident: 'არ არის ინციდენტი', insufficient: 'არასაკმარისი ინფორმაცია', other: 'სხვა' };
export const harmRank = (h: string | null | undefined) => Math.max(0, HARMS.indexOf((h ?? 'none') as Harm));

/** პაციენტის ძებნა / წყაროს არჩევა ფორმაში — იგივე წრე, ვინც პაციენტების სიას ხედავს (+ ხარისხის მენეჯერი) */
export const PATIENT_LOOKUP: Role[] = ['admin', 'receptionist', 'doctor', 'nurse', 'billing', 'diagnostic', 'manager', 'radiographer', 'radiologist',
  'endoscopist', 'endoscopy_nurse', 'phlebotomist', 'lab_doctor', 'anesthesiologist', 'or_nurse', 'or_schedule', 'pharmacist', 'quality'];
export const QM_FULL: Role[] = ['quality'];
export const QM_DEPT: Role[] = ['quality_dept'];

export const userName = (alias: string) => sql<string | null>`${sql.ref(`${alias}.first_name`)} || ' ' || ${sql.ref(`${alias}.last_name`)}`;

/** ვინ რა ხედვით უყურებს ინციდენტს */
export type Access = 'full' | 'dept' | 'own';

@Injectable()
export class QmCommon {
  private readonly log = new Logger('Quality');
  constructor(@InjectDb() readonly db: Database, private readonly modules: ModulesService, readonly notifications: NotificationsService,
    private readonly notify: NotifyService) {}

  /** მოდული ჩართულია → პარამეტრები; გამორთულზე — 403 MODULE_DISABLED */
  rules() { return this.modules.require<QmRules>('quality'); }

  riskLevel(r: QmRules, score: number): 'low' | 'medium' | 'high' | 'extreme' {
    return score <= r.risk_low_max ? 'low' : score <= r.risk_medium_max ? 'medium' : score <= r.risk_high_max ? 'high' : 'extreme';
  }

  /** quality_dept-ის ხედვის არე: rpt_user_scopes ∪ users.department_id (როგორც მენეჯერულ დაფაზე) */
  async userDepts(userId: string, ex: Ex = this.db) {
    const r = await sql<{ id: string }>`
      SELECT department_id AS id FROM rpt_user_scopes WHERE user_id = ${userId}
      UNION SELECT department_id FROM users WHERE id = ${userId} AND department_id IS NOT NULL`.execute(ex);
    return r.rows.map((x) => x.id);
  }

  /** სიის ხედვა: full — ყველა; dept — თავისი განყოფილებები (მიღებული ინციდენტები); სხვა — 403 */
  async listScope(u: AuthUser): Promise<{ full: true } | { full: false; depts: string[] }> {
    if (has(u, ...QM_FULL)) return { full: true };
    if (has(u, ...QM_DEPT)) {
      const depts = await this.userDepts(u.id);
      if (!depts.length) throw new ForbiddenException({ code: 'NO_SCOPE', message: 'განყოფილება არ გაქვთ მინიჭებული (მომხმარებლის განყოფილება ან რეპორტინგის ხედვის არე)' });
      return { full: false, depts };
    }
    throw new ForbiddenException('ინციდენტების რეესტრზე წვდომა არ გაქვთ');
  }

  /** კონკრეტულ ინციდენტზე წვდომა; null — წვდომა არ არის */
  async access(u: AuthUser, inc: { department_id: string; status: string; reporter_id: string | null }, ex: Ex = this.db): Promise<Access | null> {
    if (has(u, ...QM_FULL)) return 'full';
    if (has(u, ...QM_DEPT) && !['submitted', 'rejected'].includes(inc.status) && (await this.userDepts(u.id, ex)).includes(inc.department_id)) return 'dept';
    if (inc.reporter_id && inc.reporter_id === u.id) return 'own';
    return null;
  }

  /** აქტიური მომხმარებლები უფლებით */
  async usersWith(caps: Role[], ex: Ex = this.db) {
    const r = await sql<{ id: string; phone: string | null; email: string | null }>`
      SELECT u.id, u.phone, u.email FROM users u JOIN user_capabilities c ON c.user_id = u.id
      WHERE u.is_active AND c.capabilities && ${sql.val(caps)}::varchar[]`.execute(ex);
    return r.rows;
  }

  /** ზარის შეტყობინება (შეცდომა მოქმედებას არ აჩერებს) */
  async bell(userIds: string[], n: { kind: string; title: string; body?: string | null; link?: string | null; entityId?: string | null; urgent?: boolean }) {
    for (const id of [...new Set(userIds)]) await this.notifications.notify(id, n);
  }

  /** სასწრაფო გაფრთხილება SMS / ელფოსტით (მხოლოდ ნომერი, განყოფილება, სიმძიმე — პაციენტის მონაცემების გარეშე) */
  async alertExternal(r: QmRules, users: { phone: string | null; email: string | null }[], subject: string, text: string) {
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

  async nextNo(trx: Trx) {
    const year = Number((await sql<{ y: number }>`SELECT extract(year FROM now())::int AS y`.execute(trx)).rows[0].y);
    const { last_value } = await trx.insertInto('document_counters').values({ document_type: 'qm_INC', year, last_value: 1 })
      .onConflict((oc) => oc.columns(['document_type', 'year']).doUpdateSet({ last_value: sql`document_counters.last_value + 1` }))
      .returning('last_value').executeTakeFirstOrThrow();
    return `INC${String(year).slice(2)}-${String(last_value).padStart(6, '0')}`;
  }
}
