import { ConflictException, Global, Injectable, Module } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { has, type AuthUser, type Role } from '../auth/roles';
import { InjectDb, type Database } from '../database/database.module';
import type { DB } from '../database/db';

export type Trx = Transaction<DB>;
export type Ex = Database | Trx;

/** ბიომედ-აპარატურა (0073) — მოდულის პარამეტრები */
export type AreaMode = 'block' | 'warn' | 'off';
export interface BmeSettings {
  inv_prefix: string; inv_year: boolean; inv_digits: number; require_department: boolean; move_mode: 'direct' | 'confirm';
  area_radiology: AreaMode; area_endoscopy: AreaMode; area_scopes: AreaMode; area_cssd: AreaMode; area_lab: 'warn' | 'off'; area_or: 'warn' | 'off';
  or_alert_criticality: Criticality; label_size: '50x25' | '40x20' | '70x35'; label_code: 'qr' | 'code128';
  // 0074: PM / კალიბრაცია / ელ. უსაფრთხოება
  pm_due_basis: 'last_done' | 'calendar'; pm_cert_sets_due: boolean; pm_auto_plans: boolean; pm_remind_days: number[]; pm_remind_hour: number;
  pm_remind_email: boolean; pm_remind_sms: boolean; pm_overdue_action: 'warn' | 'restrict'; pm_fail_notify_dept: boolean; pm_act_dept_sign: boolean; pm_work_prefix: string;
  // 0075: შეკეთება / კონტრაქტები / SLA
  rep_who: 'all_staff' | 'bme_dept'; rep_sets_down: boolean; rep_notify_email: boolean; rep_notify_sms: boolean; rep_close_mode: 'confirm' | 'engineer'; rep_close_auto_days: number;
  rep_post_check: 'suggest' | 'required_life_support' | 'off'; rep_pm_fail: 'auto' | 'button'; rep_sla_response: number[]; rep_sla_restore: number[]; rep_sla_warn_pct: number;
  rep_labor_rate: number; rep_parts_location_id: string | null; rep_prefix: string; ct_remind_days: number[]; wr_remind_days: number[];
}

export const STATUSES = ['operational', 'restricted', 'down', 'standby', 'retired'] as const;
export type BmeStatus = (typeof STATUSES)[number];
export const STATUS_KA: Record<BmeStatus, string> = { operational: 'მუშა', restricted: 'შეზღუდულად მუშა', down: 'გაუმართავი / შეკეთებაში', standby: 'რეზერვი / სესხად', retired: 'გამოყვანილი' };
/** მიზეზი სავალდებულოა ამ სტატუსებზე გადასვლისას */
export const REASON_REQUIRED: BmeStatus[] = ['restricted', 'down', 'retired'];
/** „არ მუშაობს“ — block რეჟიმში აჩერებს ჩაწერას / გამოყენებას */
export const UNAVAILABLE: BmeStatus[] = ['down', 'retired'];

export const CRITICALITY = ['life_support', 'high', 'medium', 'low'] as const;
export type Criticality = (typeof CRITICALITY)[number];
export const CRIT_KA: Record<Criticality, string> = { life_support: 'სიცოცხლის შემანარჩუნებელი', high: 'მაღალი', medium: 'საშუალო', low: 'დაბალი' };
export const critRank = (c: string) => CRITICALITY.length - CRITICALITY.indexOf(c as Criticality);   // life_support = 4 … low = 1
export const RISK_CLASSES = ['I', 'IIa', 'IIb', 'III'] as const;
export const GROUPS = ['imaging', 'life_support', 'monitoring', 'therapy', 'surgical', 'lab', 'sterilization', 'endoscopy', 'measuring', 'other'] as const;
export const DOC_KINDS = ['manual', 'service_manual', 'certificate', 'license', 'act', 'warranty', 'photo', 'other'] as const;

/** ოპერაციული ჩანაწერის ბმა: სახეობა → პასპორტის სვეტი */
export const LINKS = { dx_device: 'dx_device_id', lab_method: 'lab_method_id', cssd_machine: 'cssd_machine_id', endo_scope: 'endo_scope_id' } as const;
export type LinkKind = keyof typeof LINKS;
export const LINK_KA: Record<LinkKind, string> = { dx_device: 'რადიოლოგიის / ენდოსკოპიის აპარატი', lab_method: 'ლაბ. ანალიზატორი', cssd_machine: 'CSSD აპარატი', endo_scope: 'ენდოსკოპი' };

/** ასახვის არეები: radiology / endoscopy — dx_devices (section), scopes — ენდოსკოპი, cssd — CSSD აპარატი, lab — ანალიზატორი, or — საოპერაციო ოთახი */
export const AREAS = ['radiology', 'endoscopy', 'scopes', 'cssd', 'lab', 'or'] as const;
export type Area = (typeof AREAS)[number];

/** სრული: რეესტრი, სტატუსი, გადაადგილება, ბმები, დოკუმენტები, ეტიკეტები, ცნობარები */
export const BME_FULL: Role[] = ['admin', 'med_engineer'];
/** მთელი რეესტრის ნახვა */
export const BME_VIEW_ALL: Role[] = ['admin', 'med_engineer', 'bme_view', 'manager', 'viewer'];
export const BME_DEPT: Role[] = ['bme_dept'];

export const userName = (alias: string) => sql<string | null>`${sql.ref(`${alias}.first_name`)} || ' ' || ${sql.ref(`${alias}.last_name`)}`;

/** სხვა მოდულებისთვის (რადიოლოგია, ენდოსკოპია, CSSD): აპარატის სტატუსის შემოწმება და გაფრთხილებები. გამორთული მოდული — არაფერს აჩერებს */
@Injectable()
export class BmeGuard {
  constructor(@InjectDb() private readonly db: Database) {}

  /** მოდული ჩართულია → პარამეტრები; გამორთული → null */
  async settings(ex: Ex = this.db): Promise<BmeSettings | null> {
    const m = await ex.selectFrom('system_modules').select(['enabled', 'settings']).where('code', '=', 'bme').executeTakeFirst();
    return m?.enabled ? (m.settings as unknown as BmeSettings) : null;
  }

  /**
   * ოპერაციული ჩანაწერის გამოყენების წინ (ჩაწერა, ენდოსკოპის არჩევა, CSSD ციკლი):
   *  block + გაუმართავი / გამოყვანილი → 409 BME_DOWN; warn / შეზღუდული → გაგრძელება (ეკრანზე — გაფრთხილება /bme/alerts-დან).
   */
  async check(ex: Ex, area: 'radiology' | 'endoscopy' | 'scopes' | 'cssd', targetId: string | null | undefined) {
    if (!targetId) return null;
    const s = await this.settings(ex);
    if (!s) return null;
    const col = area === 'scopes' ? 'endo_scope_id' : area === 'cssd' ? 'cssd_machine_id' : 'dx_device_id';
    const d = await ex.selectFrom('bme_devices').select(['id', 'inv_no', 'name', 'status', 'status_reason']).where(col, '=', targetId).executeTakeFirst();
    if (!d || d.status === 'operational' || d.status === 'standby') return null;
    const mode = s[`area_${area}`];
    if (mode === 'off') return null;
    if (mode === 'block' && UNAVAILABLE.includes(d.status as BmeStatus)) {
      throw new ConflictException({ code: 'BME_DOWN', message: `აპარატი „${d.name}“ (${d.inv_no}) — ${STATUS_KA[d.status as BmeStatus]}${d.status_reason ? `: ${d.status_reason}` : ''}. გამოყენება დაბლოკილია (ბიომედ-აპარატურა)`,
        device: { id: d.id, inv_no: d.inv_no, status: d.status } });
    }
    return { id: d.id, inv_no: d.inv_no, status: d.status, warn: true };
  }

  /** გაფრთხილებები ეკრანისთვის: მიბმული აპარატები, რომლებიც არ არის „მუშა“ (შეზღუდული / გაუმართავი / გამოყვანილი) */
  async alerts(area: Area) {
    const s = await this.settings();
    if (!s) return { area, mode: 'off' as const, items: [] };
    const mode = s[`area_${area}`] as AreaMode;
    if (mode === 'off') return { area, mode, items: [] };
    let q = this.db.selectFrom('bme_devices as b').innerJoin('bme_device_types as t', 't.id', 'b.type_id').leftJoin('departments as d', 'd.id', 'b.department_id')
      .leftJoin('dx_devices as x', 'x.id', 'b.dx_device_id').leftJoin('or_rooms as o', 'o.id', 'b.or_room_id')
      .leftJoin('lab_methods as lm', 'lm.id', 'b.lab_method_id').leftJoin('cssd_machines as cm', 'cm.id', 'b.cssd_machine_id').leftJoin('endo_scopes as es', 'es.id', 'b.endo_scope_id')
      .select(['b.id', 'b.inv_no', 'b.name', 'b.status', 'b.status_reason', 'b.status_since', 'b.criticality', 'b.dx_device_id', 'b.lab_method_id', 'b.cssd_machine_id', 'b.endo_scope_id',
        'b.or_room_id', 'o.name as or_room_name', 'd.name as department_name', 't.name as type_name'])
      .where('b.status', 'in', ['restricted', 'down', 'retired'])
      // გათიშული ოპერაციული ჩანაწერი (ოთახი / ანალიზატორი / ენდოსკოპი / CSSD აპარატი) დაგეგმვაში აღარ ჩანს — გაფრთხილებაც არ სჭირდება
      .where(sql<boolean>`coalesce(x.is_active, lm.is_active, cm.is_active, es.is_active, TRUE)`)
      .orderBy('b.status_since', 'desc').limit(200);
    if (area === 'radiology' || area === 'endoscopy') q = q.where('x.section', '=', area);
    else if (area === 'scopes') q = q.where('b.endo_scope_id', 'is not', null);
    else if (area === 'cssd') q = q.where('b.cssd_machine_id', 'is not', null);
    else if (area === 'lab') q = q.where('b.lab_method_id', 'is not', null);
    else q = q.where('b.or_room_id', 'is not', null).where('b.status', '<>', 'retired')
      .where(sql<boolean>`array_position(ARRAY['low','medium','high','life_support']::text[], b.criticality) >= array_position(ARRAY['low','medium','high','life_support']::text[], ${s.or_alert_criticality}::text)`);
    const items = await q.execute();
    return { area, mode, items: items.map((i) => ({ ...i, blocking: mode === 'block' && UNAVAILABLE.includes(i.status as BmeStatus) })) };
  }
}

/** ხედვის არე: სრული / განყოფილებები (bme_dept — რეპორტინგის ხედვის არეც; სხვა — მხოლოდ საკუთარი განყოფილება) */
export async function viewScope(db: Ex, u: AuthUser): Promise<{ all: true } | { all: false; depts: string[] }> {
  if (has(u, ...BME_VIEW_ALL)) return { all: true };
  const r = has(u, ...BME_DEPT)
    ? await sql<{ id: string }>`SELECT department_id AS id FROM rpt_user_scopes WHERE user_id = ${u.id} UNION SELECT department_id FROM users WHERE id = ${u.id} AND department_id IS NOT NULL`.execute(db)
    : await sql<{ id: string }>`SELECT department_id AS id FROM users WHERE id = ${u.id} AND department_id IS NOT NULL`.execute(db);
  return { all: false, depts: r.rows.map((x) => x.id) };
}

@Global()
@Module({ providers: [BmeGuard], exports: [BmeGuard] })
export class BmeCoreModule {}
