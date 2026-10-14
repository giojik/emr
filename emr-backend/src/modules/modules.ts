import { BadRequestException, Body, Controller, ForbiddenException, Get, Global, Injectable, Module, NotFoundException, Param, Put, Req } from '@nestjs/common';
import { IsBoolean, IsObject, IsOptional, IsString, Length } from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/roles';
import { InjectDb, type Database } from '../database/database.module';

/**
 * მოდულები და პარამეტრები (0037): კლინიკა რთავს / თიშავს მოდულს და ცვლის მის პარამეტრებს.
 * თითო მოდულს — ვალიდატორი: უცნობი გასაღები ან არასწორი მნიშვნელობა → 400; ნაგულისხმევები — migration-ის seed-ში.
 */
type Validator = (s: Record<string, unknown>, db: Database) => Promise<string | null>;
const bool = (v: unknown) => typeof v === 'boolean';
const int = (v: unknown, a: number, b: number) => Number.isInteger(v) && (v as number) >= a && (v as number) <= b;
const oneOf = (v: unknown, xs: string[]) => typeof v === 'string' && xs.includes(v);
const UUID = /^[0-9a-f-]{36}$/i;
const hhmm = (v: unknown) => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

const ICU_FEATURES = ['sheet', 'ventilation', 'infusions', 'sofa', 'apache', 'abg', 'bundles', 'icu_note', 'board'];
const LAB_KEYS = ['platelets', 'wbc', 'hct', 'bilirubin', 'creatinine', 'sodium', 'potassium', 'ph', 'pao2', 'paco2', 'hco3', 'be', 'lactate', 'sao2', 'fio2'];
const classes = (v: unknown) => Array.isArray(v) && v.length <= 4 && v.every((x) => ['narcotic', 'psychotropic', 'precursor', 'potent'].includes(x as string)) && new Set(v).size === v.length;
export const VALIDATORS: Record<string, { keys: Record<string, (v: unknown) => boolean>; extra?: Validator }> = {
  inpatient: {
    keys: {
      bed_assign_mode: (v) => oneOf(v, ['two_step', 'direct']), cleaning_required: bool, sex_rule: (v) => oneOf(v, ['block', 'warn', 'off']), overflow_beds: bool,
      planned_queue: bool, planned_sms: bool, cancel_hours: (v) => int(v, 0, 168),
      wristband: bool, wristband_print: (v) => oneOf(v, ['zpl', 'pdf']), wristband_width_mm: (v) => int(v, 15, 40), wristband_length_mm: (v) => int(v, 80, 400), wristband_offset_mm: (v) => int(v, 0, 200),
      // 0041: გადაყვანა / ეპიკრიზი / გაწერა / დროებითი გასვლა
      transfer_wait_hours: (v) => int(v, 1, 72), epicrisis_cosign: bool, discharge_cancel_hours: (v) => int(v, 0, 168), leave_counts_bed_day: bool,
      leave_max_hours: (v) => int(v, 1, 336), docs_pending_alert_hours: (v) => int(v, 1, 720),
      // 0042: დანიშნულებები
      med_verification: (v) => oneOf(v, ['all', 'high_risk', 'off']), dose_rule: (v) => oneOf(v, ['warn', 'block']), interaction_rule: (v) => oneOf(v, ['warn', 'block']),
      antibiotic_default_days: (v) => int(v, 1, 60), verbal_orders: bool, verbal_confirm_hours: (v) => int(v, 1, 168), weight_max_age_days: (v) => int(v, 1, 90),
      // 0043: MAR
      mar_window_min: (v) => int(v, 15, 240), mar_missed_hours: (v) => int(v, 1, 24), mar_horizon_hours: (v) => int(v, 12, 96), mar_stock_deduct: bool,
      mar_allow_no_stock: bool, mar_double_check: bool, mar_barcode: (v) => oneOf(v, ['off', 'optional', 'required']),
      med_verifier: (v) => oneOf(v, ['pharmacist', 'head_nurse', 'both']),
      // 0044: ექთნის დოკუმენტაცია
      news2_enabled: bool, news2_alert: (v) => int(v, 1, 20), news2_urgent: (v) => int(v, 1, 20),
      glucose_low: (v) => typeof v === 'number' && v >= 1 && v <= 10, glucose_high: (v) => typeof v === 'number' && v >= 5 && v <= 40,
      fluid_day_start: hhmm, shift_times: (v) => Array.isArray(v) && v.length >= 1 && v.length <= 4 && v.every(hhmm) && new Set(v).size === v.length,
      scale_reminders: bool,
      // 0045: ექიმის ჩანაწერები / კონსულტაციები / ფორმა 100
      admission_note_hours: (v) => int(v, 1, 72), progress_note_daily: bool, progress_reminder_time: hhmm, consult_billing: bool,
      form100_on_discharge: (v) => oneOf(v, ['off', 'warn']),
      // 0046: ბილინგი
      discharge_balance: (v) => oneOf(v, ['off', 'warn', 'block']), deposit_alert_amount: (v) => int(v, 0, 1_000_000),
      billing_amounts_visible: (v) => oneOf(v, ['all', 'heads', 'billing_only']), staff_add_services: bool,
      consult_due_hours: (v) => !!v && typeof v === 'object' && !Array.isArray(v) && ['routine', 'urgent', 'emergency'].every((k) => typeof (v as Record<string, unknown>)[k] === 'number'
        && ((v as Record<string, number>)[k]) > 0 && ((v as Record<string, number>)[k]) <= 168) && Object.keys(v as object).length === 3,
      line_alert_hours: (v) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.entries(v as Record<string, unknown>).every(([k, x]) =>
        ['pvc', 'cvc', 'picc', 'arterial', 'urinary', 'ng_tube', 'drain', 'trach', 'other'].includes(k) && typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= 8760),
    },
    extra: async (s) => ((s.wristband_length_mm as number) - (s.wristband_offset_mm as number) < 90 ? 'სამაჯურის ბეჭდვის ზონა (სიგრძე − საკეტის ზონა) მინიმუმ 90 მმ უნდა იყოს'
      : (s.news2_urgent as number) < (s.news2_alert as number) ? 'NEWS2: სასწრაფო ზღვარი შეტყობინების ზღვარზე ნაკლები ვერ იქნება'
      : (s.glucose_high as number) <= (s.glucose_low as number) ? 'გლუკოზა: ზედა ზღვარი ქვედაზე მეტი უნდა იყოს' : null),
  },
  // 0047: რეანიმაცია / ინტენსიური
  icu: {
    keys: {
      monitor_interval_min: (v) => [15, 30, 60].includes(v as number), fast_interval_max_hours: (v) => int(v, 1, 72), monitor_gap_hours: (v) => int(v, 1, 24),
      intensive_features: (v) => Array.isArray(v) && v.every((x) => ICU_FEATURES.includes(x as string)) && new Set(v).size === v.length,
      news2_alerts: bool, infusion_to_balance: bool, titration_reason: bool, bundle_reminder_time: hhmm, sofa_reminder_time: hhmm, readmit_hours: (v) => int(v, 1, 720),
      vent_billing: bool, vent_day_tariff_id: (v) => v === null || (typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v)),
      vasoactive: (v) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.entries(v as Record<string, unknown>).every(([k, x]) =>
        ['norepinephrine', 'epinephrine', 'dopamine', 'dobutamine', 'vasopressin'].includes(k) && Array.isArray(x) && x.length <= 20 && x.every((y) => typeof y === 'string' && y.trim().length >= 3)),
      lab_map: (v) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.entries(v as Record<string, unknown>).every(([k, x]) =>
        LAB_KEYS.includes(k) && typeof x === 'string' && (x === '' || /^[A-Za-z0-9_.-]{1,50}:[A-Za-z0-9_.-]{1,30}$/.test(x))),
    },
    extra: async (s, db) => {
      const id = s.vent_day_tariff_id as string | null;
      if (id) {
        const t = await db.selectFrom('service_tariffs').select('is_active').where('id', '=', id).executeTakeFirst();
        if (!t?.is_active) return 'ვენტილაციის დღის ტარიფი ვერ მოიძებნა ან გათიშულია';
      }
      return null;
    },
  },
  // 0048: საოპერაციო ბლოკი (დაგეგმვა)
  or: {
    keys: {
      or_scheduling: (v) => oneOf(v, ['coordinator', 'surgeon_self', 'both']), anesthesia_team_by: (v) => oneOf(v, ['anesthesia_head', 'surgeon']),
      preop_readiness: (v) => oneOf(v, ['warn', 'block']), turnover_min: (v) => int(v, 0, 180), default_duration_min: (v) => int(v, 5, 1440),
      self_booking_days: (v) => int(v, 1, 365), notify_requests: bool,
      // 0049: ოპერაციის მსვლელობა
      nursing_team_by: (v) => oneOf(v, ['surgeon', 'or_head_nurse', 'both']), room_teams: bool, anesthesia_meds: (v) => oneOf(v, ['direct', 'orders', 'both']),
      preference_cards: (v) => oneOf(v, ['off', 'procedure', 'procedure_surgeon']), count_mode: (v) => oneOf(v, ['off', 'warn', 'block']),
      note_required: (v) => Array.isArray(v) && v.length <= 7 && new Set(v).size === v.length
        && v.every((x) => ['preop_dx', 'postop_dx', 'procedures', 'description', 'findings', 'complications', 'blood_loss'].includes(x as string)),
      // 0050: PACU, ბილინგი, სტატისტიკა
      pacu_aldrete_min: (v) => int(v, 1, 10), multi_procedure_billing: (v) => oneOf(v, ['all', 'primary_plus_pct']), multi_procedure_pct: (v) => int(v, 0, 100),
      anesthesia_billing: (v) => oneOf(v, ['fixed', 'hourly', 'off']), anesthesia_round_min: (v) => [15, 30, 60].includes(v as number), first_case_tolerance_min: (v) => int(v, 0, 120),
    },
  },
  cssd: {
    keys: {
      instrument_tracking: bool, cycle_entry: (v) => oneOf(v, ['manual']), wash_record: bool, bd_required: bool, bi_frequency: (v) => oneOf(v, ['each', 'daily', 'weekly', 'off']),
      bi_hold: (v) => oneOf(v, ['all', 'implant', 'none']), shelf_life_mode: (v) => oneOf(v, ['time', 'event']), patient_trace: bool, auto_consume: bool,
      label_size: (v) => oneOf(v, ['50x25', '40x20', '70x35']), label_code: (v) => oneOf(v, ['qr', 'code128']),
    },
  },
  stock: {
    keys: {
      issue_mode: (v) => oneOf(v, ['two_step', 'one_step']), witness_classes: classes, empty_return_classes: classes, dose_required: bool, count_lock: bool, count_blind_default: bool,
      pharmacist_scope: (v) => oneOf(v, ['pharmacy', 'any']), lost_requires_approval: bool, alert_expiry: bool, alert_minmax: bool, alert_lab: bool,
    },
  },
  // 0051: შესყიდვები
  procurement: {
    keys: {
      po_mode: (v) => oneOf(v, ['off', 'optional', 'required']), pr_approval_levels: (v) => v === 1 || v === 2, pr_finance_threshold: (v) => int(v, 0, 100_000_000),
      controlled_pharmacist: bool, price_tolerance_pct: (v) => int(v, 0, 100), qty_over_delivery: (v) => oneOf(v, ['warn', 'block']), po_overdue_alert: bool,
      // 0052: ინვოისი / გადახდა / ხარჯი
      invoice_match: (v) => oneOf(v, ['off', 'rc', 'three_way']), match_tolerance: (v) => typeof v === 'number' && v >= 0 && v <= 10_000,
      expense_recognition: (v) => oneOf(v, ['on_invoice', 'on_payment']), ap_due_alert: bool, ap_due_days: (v) => int(v, 0, 60),
    },
  },
  // 0053: ფინანსები
  finance: {
    keys: {
      dept_consumption_basis: (v) => oneOf(v, ['consumption', 'issue']), revenue_basis: (v) => oneOf(v, ['service_date', 'finalized']),
      revenue_dept_basis: (v) => oneOf(v, ['performing', 'ordering']),
      dx_performing_dept: (v) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 3
        && ['lab', 'radiology', 'endoscopy'].every((k) => { const x = (v as Record<string, unknown>)[k]; return x === null || (typeof x === 'string' && UUID.test(x)); }),
      opd_payer_required: bool, claim_overdue_alert: bool,
      overhead_allocation: (v) => oneOf(v, ['none', 'revenue', 'bed_days', 'manual']),
      overhead_manual: (v) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length <= 200
        && Object.entries(v as Record<string, unknown>).every(([k, x]) => UUID.test(k) && typeof x === 'number' && x >= 0 && x <= 100),
      period_lock: (v) => oneOf(v, ['on', 'off']), dept_finance_visible: (v) => oneOf(v, ['heads', 'off']),
    },
    extra: async (s, db) => {
      const dx = Object.values((s.dx_performing_dept ?? {}) as Record<string, string | null>).filter((x): x is string => !!x);
      const man = (s.overhead_manual ?? {}) as Record<string, number>;
      const ids = [...new Set([...dx, ...Object.keys(man)])];
      const deps = ids.length ? await db.selectFrom('departments').select(['id', 'type', 'is_active']).where('id', 'in', ids).execute() : [];
      if (dx.some((id) => !deps.find((d) => d.id === id && d.is_active))) return 'დიაგნოსტიკის შემსრულებელი განყოფილება ვერ მოიძებნა ან გათიშულია';
      if (Object.keys(man).some((id) => !deps.find((d) => d.id === id))) return 'განაწილება (manual): განყოფილება ვერ მოიძებნა';
      if (Object.keys(man).some((id) => deps.find((d) => d.id === id)?.type === 'administrative')) return 'განაწილება (manual): ადმინისტრაციული განყოფილება საერთო ხარჯს არ იღებს';
      if (s.overhead_allocation === 'manual') {
        const sum = Object.values(man).reduce((a, x) => a + x, 0);
        if (Math.abs(sum - 100) > 0.01) return `განაწილება (manual): პროცენტების ჯამი უნდა იყოს 100 (ახლა ${Math.round(sum * 100) / 100})`;
      }
      return null;
    },
  },
  // 0054: სატარიფო ფენა
  tariffs: {
    keys: {
      tariff_change_approval: (v) => oneOf(v, ['off', 'required']), opd_payer_mode: (v) => oneOf(v, ['manual', 'rules']),
      payer_price_mode: (v) => oneOf(v, ['primary', 'off']), reprice_on_payer_change: (v) => oneOf(v, ['auto_unpaid', 'manual']),
    },
  },
  // 0055: DRG
  drg: {
    keys: {
      version_date_basis: (v) => oneOf(v, ['discharge', 'admission']), confirm_required: bool, recheck_on_finalize: (v) => oneOf(v, ['block', 'warn', 'off']),
      manual_payer_drg: (v) => oneOf(v, ['allowed', 'grouper_only']), version_approval: (v) => oneOf(v, ['off', 'required']),
    },
  },
  // 0057: ქლეიმის შემოწმება
  scrubber: { keys: { finalize_check: (v) => oneOf(v, ['off', 'warn', 'block']), claim_check: (v) => oneOf(v, ['off', 'warn', 'block']) } },
  // 0060: მენეჯერული რეპორტინგი
  reporting: {
    keys: {
      refresh_today_min: (v) => int(v, 5, 120), nightly_hour: (v) => int(v, 0, 23), recompute_days: (v) => int(v, 1, 120), freeze_closed_periods: bool,
      occupancy_basis: (v) => oneOf(v, ['hours', 'midnight']), stock_days_window: (v) => int(v, 7, 180), stock_days_alert: (v) => int(v, 1, 90),
      compare_default: (v) => oneOf(v, ['prev', 'yoy', 'none']), lab_tat_start: (v) => oneOf(v, ['collected', 'ordered']),
    },
  },
  asset_register: {
    keys: {
      inv_prefix: (v) => typeof v === 'string' && /^[A-Z0-9]{0,8}$/.test(v),
      inv_year: bool, inv_digits: (v) => int(v, 3, 9), require_room: bool, require_responsible: bool,
      move_mode: (v) => oneOf(v, ['direct', 'confirm']), writeoff_mode: (v) => oneOf(v, ['direct', 'single', 'committee']),
      writeoff_committee: (v) => Array.isArray(v) && v.length <= 15 && v.every((x) => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x)),
      committee_quorum: (v) => int(v, 1, 15), track_value: bool,
      label_size: (v) => oneOf(v, ['50x25', '40x20', '70x35']), label_code: (v) => oneOf(v, ['qr', 'code128']),
    },
    extra: async (s, db) => {
      if (s.writeoff_mode === 'committee') {
        const ids = (s.writeoff_committee as string[]) ?? [];
        if (ids.length < ((s.committee_quorum as number) ?? 1)) return 'კომისიის წევრების რაოდენობა კვორუმზე ნაკლებია';
        const n = ids.length ? (await db.selectFrom('users').select(sql<number>`count(*)::int`.as('n')).where('id', 'in', ids).where('is_active', '=', true).executeTakeFirstOrThrow()).n : 0;
        if (n !== ids.length) return 'კომისიის წევრი ვერ მოიძებნა ან გათიშულია';
      }
      return null;
    },
  },
};

@Injectable()
export class ModulesService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService) {}

  list() { return this.db.selectFrom('system_modules').selectAll().orderBy('sort_order').execute(); }

  async get(code: string) {
    const m = await this.db.selectFrom('system_modules').selectAll().where('code', '=', code).executeTakeFirst();
    if (!m) throw new NotFoundException('მოდული ვერ მოიძებნა');
    return m;
  }
  /** მოდულის პარამეტრები; გამორთულზე — 403 */
  async require<T = Record<string, unknown>>(code: string): Promise<T> {
    const m = await this.get(code);
    if (!m.enabled) throw new ForbiddenException({ code: 'MODULE_DISABLED', message: `მოდული „${m.name}“ გამორთულია (ადმინისტრირება → მოდულები)` });
    return m.settings as T;
  }

  async put(code: string, dto: { enabled?: boolean; settings?: Record<string, unknown>; reason: string }, u: AuthUser, req: Request) {
    const m = await this.get(code);
    if (dto.enabled === false && !m.can_disable) throw new BadRequestException(`მოდული „${m.name}“ არ ითიშება`);
    const v = VALIDATORS[code];
    let settings = m.settings as Record<string, unknown>;
    if (dto.settings) {
      if (!v) throw new BadRequestException('ამ მოდულს პარამეტრები არ აქვს');
      for (const [k, val] of Object.entries(dto.settings)) {
        if (!v.keys[k]) throw new BadRequestException(`უცნობი პარამეტრი: ${k}`);
        if (!v.keys[k](val)) throw new BadRequestException(`არასწორი მნიშვნელობა: ${k}`);
      }
      settings = { ...settings, ...dto.settings };
      const err = v.extra ? await v.extra(settings, this.db) : null;
      if (err) throw new BadRequestException(err);
    }
    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable('system_modules').set({ ...(dto.enabled !== undefined && { enabled: dto.enabled }), settings: JSON.stringify(settings), updated_by: u.id, updated_at: sql`now()` })
        .where('code', '=', code).execute();
      await this.audit.log(auditCtx(req), { action: 'UPDATE_MODULE', entityName: 'system_modules', entityId: code,
        oldData: { enabled: m.enabled, settings: m.settings }, newData: { enabled: dto.enabled ?? m.enabled, settings, reason: dto.reason } }, trx);
    });
    return this.get(code);
  }
}

class ModuleDto { @IsOptional() @IsBoolean() enabled?: boolean; @IsOptional() @IsObject() settings?: Record<string, unknown>; @IsString() @Length(3, 500) reason: string }

@Controller('modules')
export class ModulesController {
  constructor(private readonly s: ModulesService) {}
  /** ყველა შესულ მომხმარებელს — მენიუ / ჩანართები მოდულის მიხედვით */
  @Get() list() { return this.s.list(); }
  @Put(':code') @Roles('admin') put(@Param('code') code: string, @Body() d: ModuleDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.put(code, d, u, r); }
}

@Global()
@Module({ providers: [ModulesService], controllers: [ModulesController], exports: [ModulesService] })
export class ModulesModule {}
