import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Global, HttpCode, Injectable, Logger, Module, NotFoundException, Param, Post, Put, Req, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { APP_GUARD, DiscoveryModule, DiscoveryService } from '@nestjs/core';
import { Client } from 'pg';
import { IsBoolean, IsObject, IsOptional, IsString, Length } from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/roles';
import { InjectDb, type Database } from '../database/database.module';
import { NotificationsService } from '../notifications/notifications';
import { OBS_KEYS, SLA_KEYS, SOURCE_CODES } from '../worklist/worklist-common';
import { loadEnv } from '../config/env';
import { LicenseService, type LicenseStatus } from '../license/license.service';
import { LicenseController } from '../license/license.controller';
import { MODULE_MAP, MODULES, OPTIONAL_CODES, dependentsOf, validateRegistry, type ModuleDef } from './registry';
import { PROFILES, PROFILE_MAP, validateProfiles } from './profiles';
import { modulesRef } from './modules-ref';
import { ModuleGuard, MODULE_KEY, RequireModule } from './module-guard';

/**
 * მოდულები და პარამეტრები (0037): კლინიკა რთავს / თიშავს მოდულს და ცვლის მის პარამეტრებს.
 * თითო მოდულს — ვალიდატორი: უცნობი გასაღები ან არასწორი მნიშვნელობა → 400; ნაგულისხმევები — migration-ის seed-ში.
 */
type Validator = (s: Record<string, unknown>, db: Database) => Promise<string | null>;
const bool = (v: unknown) => typeof v === 'boolean';
const int = (v: unknown, a: number, b: number) => Number.isInteger(v) && (v as number) >= a && (v as number) <= b;
const oneOf = (v: unknown, xs: string[]) => typeof v === 'string' && xs.includes(v);
const UUID = /^[0-9a-f-]{36}$/i;
/** 0075: P1–P4 საათები (ზრდადი) / შეხსენების დღეები */
const hours4 = (v: unknown) => Array.isArray(v) && v.length === 4 && v.every((x) => int(x, 1, 2000)) && v.every((x, i) => i === 0 || x >= v[i - 1]);
const days4 = (v: unknown) => Array.isArray(v) && v.length <= 4 && v.every((x) => int(x, 1, 365)) && new Set(v).size === v.length;
/** 0084: { გასაღები: მთელი რიცხვი } — ყველა გასაღები ცნობილია */
const obj = (v: unknown, keys: string[], a: number, b: number) => !!v && typeof v === 'object' && !Array.isArray(v)
  && Object.entries(v as Record<string, unknown>).every(([k, x]) => keys.includes(k) && int(x, a, b));
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
        ['pvc', 'cvc', 'picc', 'dialysis', 'arterial', 'urinary', 'ng_tube', 'drain', 'trach', 'other'].includes(k) && typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= 8760),
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
      // 0061
      lab_overdue_min: (v) => int(v, 15, 2880), dx_overdue_hours: (v) => int(v, 1, 336), dead_stock_days: (v) => int(v, 30, 730), tv_refresh_min: (v) => int(v, 1, 60),
      // 0062
      doctor_breakdown: (v) => oneOf(v, ['off', 'all_only', 'scoped']), min_cases: (v) => int(v, 1, 50),
      doctor_revenue: (v) => oneOf(v, ['on', 'off']), attention_notify: (v) => oneOf(v, ['off', 'in_app', 'in_app_email']),
      attention_notify_hour: (v) => int(v, 0, 23), attention_notify_level: (v) => oneOf(v, ['red', 'all']),
    },
  },
  // 0064: ხარისხი და ინციდენტები
  quality: {
    keys: {
      identity_modes: (v) => Array.isArray(v) && v.length >= 1 && v.every((x) => ['open', 'confidential', 'anonymous'].includes(x as string)) && new Set(v).size === v.length,
      identity_default: (v) => oneOf(v, ['open', 'confidential', 'anonymous']), ncc_merp: bool,
      risk_low_max: (v) => int(v, 1, 23), risk_medium_max: (v) => int(v, 2, 24), risk_high_max: (v) => int(v, 3, 24),
      triage_hours: (v) => int(v, 1, 720), sentinel_triage_hours: (v) => int(v, 1, 168),
      alert_harm: (v) => oneOf(v, ['moderate', 'severe', 'death', 'off']),
      alert_user_ids: (v) => Array.isArray(v) && v.length <= 20 && v.every((x) => typeof x === 'string' && UUID.test(x)) && new Set(v).size === v.length,
      alert_sms: bool, alert_email: bool, event_prompts: bool, author_feedback: bool, anonymous_tracking: bool,
      // 0065: გამოძიება / ანალიზი / CAPA / დახურვა
      investigator_at_triage: bool, rca_required_risk: (v) => oneOf(v, ['medium', 'high', 'extreme', 'off']), rca_required_harm: (v) => oneOf(v, ['moderate', 'severe', 'death', 'off']),
      review_days: (v) => int(v, 1, 180), rca_days: (v) => int(v, 1, 365), due_warn_days: (v) => int(v, 0, 30), analysis_approval: bool,
      capa_effectiveness: bool, effectiveness_days: (v) => int(v, 7, 730), disclosure_required_harm: (v) => oneOf(v, ['mild', 'moderate', 'severe', 'death', 'off']),
      closure_feedback: bool, report_mask_patient: bool,
      // 0066: ანგარიშები / დაფა
      report_date_basis: (v) => oneOf(v, ['occurred', 'reported']), view_min_cell: (v) => int(v, 0, 20),
      dashboard_visibility: (v) => oneOf(v, ['report_users', 'quality_only']), monthly_section: bool,
    },
    extra: async (s, db) => {
      if (!(s.identity_modes as string[]).includes(s.identity_default as string)) return 'ნაგულისხმევი რეჟიმი დაშვებულთა შორის უნდა იყოს';
      if (!((s.risk_low_max as number) < (s.risk_medium_max as number) && (s.risk_medium_max as number) < (s.risk_high_max as number))) return 'რისკის ზღვრები: დაბალი < საშუალო < მაღალი';
      if ((s.sentinel_triage_hours as number) > (s.triage_hours as number)) return 'სენტინელური ტრიაჟის ვადა ჩვეულებრივზე მეტი ვერ იქნება';
      if ((s.review_days as number) > (s.rca_days as number)) return 'მიმოხილვის ვადა RCA-ს ვადაზე მეტი ვერ იქნება';
      const ids = (s.alert_user_ids as string[]) ?? [];
      if (ids.length) {
        const n = (await db.selectFrom('users').select(sql<number>`count(*)::int`.as('n')).where('id', 'in', ids).where('is_active', '=', true).executeTakeFirstOrThrow()).n;
        if (n !== ids.length) return 'გაფრთხილების მიმღები ვერ მოიძებნა ან გათიშულია';
      }
      return null;
    },
  },
  // 0067: ინფექციის კონტროლი
  ipc: {
    keys: {
      isolation_remove_mdro: (v) => oneOf(v, ['ipc', 'staff']), ward_conflict: (v) => oneOf(v, ['warn', 'block']),
      wristband_symbol: bool, door_sign: bool, mdro_flag_mode: (v) => oneOf(v, ['auto', 'suggest']), mdro_clear_negatives: (v) => int(v, 0, 10),
      mdro_suggest_isolation: bool, hospital_onset_day: (v) => int(v, 1, 7), alert_new_flag: bool, alert_sms: bool, alert_email: bool,
      // 0068: სიგნალები, HAI, device-days
      sig_blood_culture: bool, sig_hospital_culture: bool, sig_fever_device: bool, sig_antibiotic_start: bool, sig_cluster: bool,
      fever_threshold: (v) => typeof v === 'number' && v >= 37.5 && v <= 39.5, commensal_window_hours: (v) => int(v, 12, 96),
      cluster_count: (v) => int(v, 2, 20), cluster_days: (v) => int(v, 3, 60), signal_dedupe_days: (v) => int(v, 1, 30), postop_fever_days: (v) => int(v, 0, 90),
      hai_criteria_set: (v) => typeof v === 'string' && /^[a-z][a-z0-9_]{1,15}$/.test(v), hai_transfer_days: (v) => int(v, 0, 3), hai_readmit_days: (v) => int(v, 0, 90),
      device_min_days: (v) => int(v, 1, 3), device_days_basis: (v) => oneOf(v, ['calendar_day', 'census']), census_hour: (v) => int(v, 0, 23),
      central_line_kinds: (v) => Array.isArray(v) && v.length >= 1 && v.every((x) => ['cvc', 'picc', 'dialysis', 'arterial'].includes(x as string)) && new Set(v).size === v.length,
      // 0069: SSI
      wound_class_mode: (v) => oneOf(v, ['optional', 'required', 'off']), ssi_surveillance: bool, ssi_pd_calls: bool, ssi_pd_attempts: (v) => int(v, 1, 5), ssi_pd_sms: bool,
      sig_ssi_postop: bool, prophylaxis_window_min: (v) => int(v, 30, 180),
      // 0070: ანტიბიოტიკები
      abx_atc_prefixes: (v) => Array.isArray(v) && v.length >= 1 && v.length <= 10 && v.every((x) => typeof x === 'string' && /^[A-Z][0-9]{2}([A-Z]{1,2})?$/.test(x)) && new Set(v).size === v.length,
      abx_indication_required: bool, abx_restrict_mode: (v) => oneOf(v, ['approve', 'notify', 'off']), abx_restrict_reserve: bool,
      abx_approver: (v) => oneOf(v, ['department', 'ipc', 'any']), abx_timeout_hours: (v) => v === 0 || int(v, 24, 168), aware_access_target: (v) => int(v, 0, 100),
      // 0071: ანტიბიოგრამა, მასალები
      abg_dedup: (v) => oneOf(v, ['first_patient', 'all']), abg_min_n: (v) => int(v, 1, 100),
      abg_exclude_services: (v) => Array.isArray(v) && v.length <= 50 && v.every((x) => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x)) && new Set(v).size === v.length,
      material_source: (v) => oneOf(v, ['issue', 'consumption']),
      // 0072: აუდიტები, ანგარიშები
      audit_by_dept_head: bool, hh_target: (v) => int(v, 0, 100), hh_min_obs: (v) => int(v, 0, 1000), signal_overdue_days: (v) => int(v, 1, 30),
      dashboard_visibility: (v) => oneOf(v, ['report_users', 'ipc_only']), monthly_section: bool,
    },
    extra: async (s, db) => {
      const c = s.hai_criteria_set as string | undefined;
      if (c && !(await db.selectFrom('ipc_criteria_sets').select('id').where('code', '=', c).where('is_active', '=', true).executeTakeFirst())) return 'კრიტერიუმების ნაკრები ვერ მოიძებნა ან გათიშულია';
      const ex = s.abg_exclude_services as string[] | undefined;
      if (ex?.length) {
        const n = (await db.selectFrom('dx_services').select(sql<number>`count(*)::int`.as('n')).where('id', 'in', ex).where('section', '=', 'lab').executeTakeFirstOrThrow()).n;
        if (n !== ex.length) return 'გამოსარიცხი ანალიზი ვერ მოიძებნა (ლაბორატორიის კატალოგი)';
      }
      return null;
    },
  },
  // 0073: ბიომედ-აპარატურა — რეესტრი, სტატუსის ასახვა დაგეგმვაზე
  bme: {
    keys: {
      inv_prefix: (v) => typeof v === 'string' && /^[A-Z0-9]{0,8}$/.test(v), inv_year: bool, inv_digits: (v) => int(v, 3, 9), require_department: bool,
      move_mode: (v) => oneOf(v, ['direct', 'confirm']),
      area_radiology: (v) => oneOf(v, ['block', 'warn', 'off']), area_endoscopy: (v) => oneOf(v, ['block', 'warn', 'off']), area_scopes: (v) => oneOf(v, ['block', 'warn', 'off']),
      area_cssd: (v) => oneOf(v, ['block', 'warn', 'off']), area_lab: (v) => oneOf(v, ['warn', 'off']), area_or: (v) => oneOf(v, ['warn', 'off']),
      or_alert_criticality: (v) => oneOf(v, ['life_support', 'high', 'medium', 'low']),
      label_size: (v) => oneOf(v, ['50x25', '40x20', '70x35']), label_code: (v) => oneOf(v, ['qr', 'code128']),
      // 0074: PM / კალიბრაცია / ელ. უსაფრთხოება
      pm_due_basis: (v) => oneOf(v, ['last_done', 'calendar']), pm_cert_sets_due: bool, pm_auto_plans: bool,
      pm_remind_days: (v) => Array.isArray(v) && v.length <= 4 && v.every((x) => int(x, 1, 180)) && new Set(v).size === v.length,
      pm_remind_hour: (v) => int(v, 0, 23), pm_remind_email: bool, pm_remind_sms: bool, pm_overdue_action: (v) => oneOf(v, ['warn', 'restrict']),
      pm_fail_notify_dept: bool, pm_act_dept_sign: bool, pm_work_prefix: (v) => typeof v === 'string' && /^[A-Z0-9]{1,8}$/.test(v),
      // 0075: შეკეთება / კონტრაქტები / SLA
      rep_who: (v) => oneOf(v, ['all_staff', 'bme_dept']), rep_sets_down: bool, rep_notify_email: bool, rep_notify_sms: bool,
      rep_close_mode: (v) => oneOf(v, ['confirm', 'engineer']), rep_close_auto_days: (v) => int(v, 0, 30),
      rep_post_check: (v) => oneOf(v, ['suggest', 'required_life_support', 'off']), rep_pm_fail: (v) => oneOf(v, ['auto', 'button']),
      rep_sla_response: (v) => hours4(v), rep_sla_restore: (v) => hours4(v), rep_sla_warn_pct: (v) => int(v, 50, 95),
      rep_labor_rate: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 10000,
      rep_parts_location_id: (v) => v === null || (typeof v === 'string' && UUID.test(v)), rep_prefix: (v) => typeof v === 'string' && /^[A-Z0-9]{1,8}$/.test(v),
      ct_remind_days: (v) => days4(v), wr_remind_days: (v) => days4(v),
      // 0076: ანგარიშები / KPI
      rpt_restricted_weight: (v) => v === 0 || v === 0.5 || v === 1, rpt_mtbf_exclude_user_error: bool, rpt_contract_alloc: (v) => oneOf(v, ['equal', 'value']),
      rpt_cosr_warn_pct: (v) => int(v, 1, 100), rpt_pm_grace_days: (v) => int(v, 0, 60),
      dashboard_visibility: (v) => oneOf(v, ['report_users', 'bme_only']), monthly_section: bool,
    },
    extra: async (s, db) => {
      const r = s.rep_sla_response as number[] | undefined; const t = s.rep_sla_restore as number[] | undefined;
      if (r && t && r.some((x, i) => x > t[i])) return 'SLA: რეაგირების დრო აღდგენის დროზე მეტი ვერ იქნება';
      const loc = s.rep_parts_location_id as string | null | undefined;
      if (loc && !(await db.selectFrom('stock_locations').select('id').where('id', '=', loc).where('is_active', '=', true).executeTakeFirst())) return 'ნაწილების ლოკაცია ვერ მოიძებნა ან გათიშულია';
      return null;
    },
  },
  // 0077: ცვლები / მორიგეობა
  roster: {
    keys: {
      rest_min_hours: (v) => int(v, 0, 48), rest_mode: (v) => oneOf(v, ['block', 'warn', 'off']),
      max_continuous_hours: (v) => int(v, 8, 48), continuous_mode: (v) => oneOf(v, ['block', 'warn', 'off']),
      max_week_hours: (v) => int(v, 20, 120), week_mode: (v) => oneOf(v, ['block', 'warn', 'off']),
      max_consecutive_nights: (v) => int(v, 1, 14), nights_mode: (v) => oneOf(v, ['block', 'warn', 'off']),
      norm_mode: (v) => oneOf(v, ['warn', 'off']), cross_department: (v) => oneOf(v, ['allow', 'warn', 'block']),
      publish_notify: bool, change_notify: bool, duty_phone: (v) => oneOf(v, ['all', 'staff', 'off']), copy_mode: (v) => oneOf(v, ['weekday', 'date']),
      // 0078: არყოფნა, გაცვლა, დასაფარი, სურვილები
      absence_unit_mode: (v) => oneOf(v, ['weekdays', 'roster']), accrual: (v) => oneOf(v, ['annual', 'monthly']), balance_overdraw: (v) => oneOf(v, ['block', 'warn']),
      swap_approval: (v) => oneOf(v, ['head', 'none']), swap_min_notice_hours: (v) => int(v, 0, 168), open_shift_volunteer: bool, open_shift_notify: bool,
      prefs_mode: (v) => oneOf(v, ['warn', 'off']), prefs_deadline_day: (v) => int(v, 0, 28), unavailable_max_per_month: (v) => int(v, 0, 31),
      // 0079: საათები / ტაბელი, დახურვა, კავშირები
      week_norm_hours: (v) => int(v, 20, 60), overtime_basis: (v) => oneOf(v, ['month', 'off']), overtime_default: (v) => oneOf(v, ['pay', 'comp']),
      comp_absence_type: (v) => typeof v === 'string' && /^[A-Z][A-Z0-9_]{1,19}$/.test(v), night_from: hhmm, night_to: hhmm, close_requires_submit: bool,
      link_consult: (v) => oneOf(v, ['off', 'hint', 'duty']), link_bme: (v) => oneOf(v, ['off', 'hint', 'duty']), link_or: (v) => oneOf(v, ['off', 'absence', 'absence_shift']),
      nurse_ratio: (v) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every((k) => ['ward', 'intensive', 'icu'].includes(k))
        && ['ward', 'intensive', 'icu'].every((k) => int((v as Record<string, unknown>)[k], 1, 50)),
      // 0080: ანგარიშები / KPI
      rpt_norm_low_pct: (v) => int(v, 50, 100), rpt_chronic_ot_months: (v) => int(v, 1, 6), rpt_open_urgent_hours: (v) => int(v, 1, 168),
      rpt_close_late_days: (v) => int(v, 0, 60), rpt_min_group: (v) => int(v, 1, 20), rpt_bradford: bool,
      rpt_sick_types: (v) => Array.isArray(v) && v.length <= 10 && v.every((x) => typeof x === 'string' && /^[A-Z][A-Z0-9_]{1,19}$/.test(x)),
      dashboard_visibility: (v) => oneOf(v, ['report_users', 'roster_only']), monthly_section: bool,
    },
    extra: async (s) => (s.night_from === s.night_to ? 'ღამის საათები: დასაწყისი და დასასრული ერთმანეთს არ უნდა ემთხვეოდეს' : null),
  },
  // 0087: გადაუდებელი (ER)
  er: {
    keys: {
      triage_scale: (v) => typeof v === 'string' && /^[A-Z][A-Z0-9_]{1,19}$/.test(v), triage_target_min: (v) => int(v, 1, 120),
      doctor_before_triage: (v) => oneOf(v, ['allow', 'block']), ambulance_fields: (v) => oneOf(v, ['optional', 'required']),
      retriage_alert: bool, news2_hint: bool, show_on_duty: bool, board_refresh_sec: (v) => int(v, 10, 300), tv_patient_names: (v) => oneOf(v, ['initials', 'full']),
      // 0088: კლინიკური ნაწილი
      initial_note_min: (v) => int(v, 10, 720), doctor_write: (v) => oneOf(v, ['team', 'attending']), dx_unpaid_check: (v) => oneOf(v, ['skip', 'ack']),
      dx_default_priority: (v) => oneOf(v, ['urgent', 'routine']), consult_billing: bool,
      consult_due_min: (v) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 3
        && (['routine', 'urgent', 'emergency'] as const).every((k) => int((v as Record<string, unknown>)[k], 5, 2880)),
    },
    extra: async (s, db) => {
      const c = s.triage_scale as string | undefined;
      if (c && !(await db.selectFrom('er_triage_scales').select('code').where('code', '=', c).where('is_active', '=', true).executeTakeFirst())) return 'ტრიაჟის შკალა ვერ მოიძებნა ან გათიშულია';
      return null;
    },
  },
  // 0081: სამუშაო სიები
  worklist: {
    keys: {
      assign_scope: (v) => oneOf(v, ['any', 'department', 'managers']), done_comment: (v) => oneOf(v, ['off', 'urgent', 'all']), reopen_days: (v) => int(v, 0, 90),
      remind_at_due: bool, escalate_hours: (v) => int(v, 0, 720),
      due_default_hours: (v) => Array.isArray(v) && v.length === 3 && v.every((x) => int(x, 0, 2160)),
      notify_assign: bool, notify_done: bool, patient_tasks: bool,
      sources: (v) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.entries(v as Record<string, unknown>).every(([k, x]) => SOURCE_CODES.includes(k) && typeof x === 'boolean'),
      badge: (v) => oneOf(v, ['all', 'overdue', 'off']), refresh_seconds: (v) => int(v, 30, 600), home_tasks: bool,
      // 0082: ადმინისტრაცია / ლოჯისტიკის წყაროები
      dept_side: (v) => oneOf(v, ['heads', 'all']), stk_expiry_days: (v) => int(v, 0, 365),
      sla_hours: (v) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.entries(v as Record<string, unknown>).every(([k, x]) => (SLA_KEYS as readonly string[]).includes(k) && int(x, 0, 720)),
      period_close_day: (v) => int(v, 1, 28), claim_build_day: (v) => int(v, 1, 28), ipd_finalize_days: (v) => int(v, 0, 30), appt_open_days: (v) => int(v, 0, 14),
      debt_days: (v) => int(v, 1, 365), reg_scope: (v) => oneOf(v, ['all', 'department']), bi_due_hours: (v) => int(v, 1, 168),
      // 0083: კლინიკური წყაროები
      nurse_scope: (v) => oneOf(v, ['department', 'on_shift']), mar_due_ahead_min: (v) => int(v, 0, 720),
      obs_minutes: (v) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.entries(v as Record<string, unknown>).every(([k, x]) => (OBS_KEYS as readonly string[]).includes(k) && int(x, 15, 1440)),
      news2_review_min: (v) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.entries(v as Record<string, unknown>).every(([k, x]) => ['alert', 'urgent'].includes(k) && int(x, 5, 720)),
      line_review_hours: (v) => int(v, 1, 168), draft_hours: (v) => int(v, 0, 168), amb_open_days: (v) => int(v, 1, 90), or_ahead_hours: (v) => int(v, 1, 168),
      pacu_long_hours: (v) => int(v, 1, 48),
      // 0084: დიაგნოსტიკა, ზარის ჩახშობა, KPI
      dx_list_mode: (v) => oneOf(v, ['attention', 'all']),
      lab_collect_min: (v) => obj(v, ['routine', 'urgent'], 5, 1440), lab_transit_min: (v) => int(v, 10, 1440),
      lab_tat_hours: (v) => obj(v, ['routine', 'urgent', 'micro'], 1, 720), rad_tat_hours: (v) => obj(v, ['routine', 'urgent'], 1, 720),
      ack_scope: (v) => oneOf(v, ['all', 'abnormal', 'critical']), ack_hours: (v) => int(v, 1, 720), ack_days: (v) => int(v, 1, 180), critical_ack_min: (v) => int(v, 5, 720),
      lab_crit_call: (v) => oneOf(v, ['off', 'task', 'required']), rad_scheduler: (v) => oneOf(v, ['radiographer', 'receptionist', 'both']),
      ref_due_days: (v) => int(v, 1, 90), amb_dx_days: (v) => int(v, 1, 90), path_due_days: (v) => int(v, 1, 60),
      dx_max_age_days: (v) => int(v, 1, 365), lab_collect_days: (v) => int(v, 1, 90),
      bell_suppress: (v) => oneOf(v, ['off', 'non_urgent']), kpi_tracker: bool, kpi_interval_min: (v) => [15, 30, 60].includes(v as number),
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

/** მოდულის ეფექტური მდგომარეობა (0085) */
export type ModuleStateCode = 'active' | 'read_only' | 'disabled' | 'not_licensed' | 'missing_prereq';
export interface ModuleState { code: string; state: ModuleStateCode; active: boolean; licensed: boolean; enabled: boolean; missing: string[] }
interface Snapshot { rows: Map<string, { name: string; enabled: boolean; settings: unknown }>; states: Map<string, ModuleState>; license: LicenseStatus }

const SNAP_TTL_MS = 30_000;
const USABLE: ModuleStateCode[] = ['active', 'read_only'];

@Injectable()
export class ModulesService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('Modules');
  private snap?: Promise<Snapshot>;
  private snapAt = 0;
  private listener?: Client;
  private closing = false;
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService, private readonly notifications: NotificationsService,
    readonly license: LicenseService, private readonly discovery: DiscoveryService) { license.onChange = () => this.invalidate(); modulesRef.svc = this; }

  // ------------------------------------------------------------------ მდგომარეობა (ქეში + LISTEN emr_modules)
  invalidate() { this.snap = undefined; }

  private async build(): Promise<Snapshot> {
    const [rows, license] = await Promise.all([this.db.selectFrom('system_modules').select(['code', 'name', 'enabled', 'settings']).execute(), this.license.status()]);
    const rowMap = new Map(rows.map((r) => [r.code, { name: r.name, enabled: r.enabled, settings: r.settings }]));
    const states = new Map<string, ModuleState>();
    const expired = license.mode === 'licensed' && license.phase === 'expired';
    const calc = (d: ModuleDef): ModuleState => {
      const done = states.get(d.code); if (done) return done;
      const enabled = !!d.core || !!rowMap.get(d.code)?.enabled;
      const licensed = !!d.core || license.modules === 'all' || license.modules.includes(d.code);
      const missing = d.hard.filter((h) => !USABLE.includes(calc(MODULE_MAP[h]).state));
      const state: ModuleStateCode = !licensed ? 'not_licensed' : !enabled ? 'disabled' : missing.length ? 'missing_prereq'
        : (expired && !d.core) || d.hard.some((h) => states.get(h)?.state === 'read_only') ? 'read_only' : 'active';
      const st = { code: d.code, state, active: state === 'active', licensed, enabled, missing };
      states.set(d.code, st);
      return st;
    };
    for (const d of MODULES) calc(d);
    return { rows: rowMap, states, license };
  }

  snapshot(): Promise<Snapshot> {
    if (!this.snap || Date.now() - this.snapAt > SNAP_TTL_MS) {
      this.snapAt = Date.now();
      this.snap = this.build().catch((e) => { this.snap = undefined; throw e; });
    }
    return this.snap;
  }

  async state(code: string): Promise<ModuleState> {
    const st = (await this.snapshot()).states.get(code);
    if (!st) throw new NotFoundException(`მოდული ვერ მოიძებნა: ${code}`);
    return st;
  }
  /** რბილი კავშირის „პორტი“: true — მოდული სრულად მუშაობს */
  async isActive(code: string) { return (await this.state(code)).active; }
  /** მონაცემი იკითხება (active ან read_only) — worker-ის ETL, ანგარიშები */
  async isUsable(code: string) { return USABLE.includes((await this.state(code)).state); }

  /** 403 შეცდომა მდგომარეობის მიხედვით (guard / assertActive) */
  async denial(code: string, write: boolean): Promise<ForbiddenException | null> {
    const snap = await this.snapshot();
    const st = snap.states.get(code);
    if (!st) return new ForbiddenException({ code: 'MODULE_DISABLED', message: `მოდული ვერ მოიძებნა: ${code}`, module: code });
    if (st.state === 'active' || (st.state === 'read_only' && !write)) return null;
    const name = snap.rows.get(code)?.name ?? code;
    if (st.state === 'read_only') return new ForbiddenException({ code: 'LICENSE_EXPIRED', message: `ლიცენზიის ვადა გავიდა — „${name}“ მხოლოდ წაკითხვის რეჟიმშია`, module: code });
    if (st.state === 'not_licensed') return new ForbiddenException({ code: 'MODULE_NOT_LICENSED', message: `მოდული „${name}“ ლიცენზიაში არ შედის`, module: code });
    if (st.state === 'missing_prereq') {
      const names = st.missing.map((x) => snap.rows.get(x)?.name ?? x);
      return new ForbiddenException({ code: 'MODULE_DISABLED', message: `მოდული „${name}“ არააქტიურია — საჭიროა: ${names.join(', ')}`, module: code, missing: st.missing });
    }
    return new ForbiddenException({ code: 'MODULE_DISABLED', message: `მოდული „${name}“ გამორთულია (ადმინისტრირება → მოდულები)`, module: code });
  }
  /** დინამიკური შემოწმება service-ში (მაგ. დიაგნოსტიკის სექცია); write = false — წაკითხვა read_only-ზეც დაშვებულია */
  async assertActive(code: string, write = true) { const e = await this.denial(code, write); if (e) throw e; }

  async onApplicationBootstrap() {
    // 0086: რეესტრი (კავშირები / ციკლი) + პროფილები (მკაცრი წინაპირობები) — შეცდომაზე გაშვება ჩერდება
    const regErr = [...validateRegistry(), ...validateProfiles()];
    if (regErr.length) throw new Error(`მოდულების რეესტრი / პროფილები:\n  ${regErr.join('\n  ')}`);
    // რეესტრი ⇄ ბაზა: ყველა კოდს ჩანაწერი უნდა ჰქონდეს (მიგრაცია / რეესტრი ერთად იცვლება)
    const codes = new Set((await this.db.selectFrom('system_modules').select('code').execute()).map((r) => r.code));
    const missing = MODULES.filter((d) => !codes.has(d.code)).map((d) => d.code);
    if (missing.length) throw new Error(`system_modules: რეესტრის კოდებს ჩანაწერი არ აქვთ: ${missing.join(', ')}`);
    // ყოველ controller-ს — @RequireModule (კლასზე ან ყველა მეთოდზე); სხვაგვარად გაშვება ჩერდება
    const bad: string[] = [];
    for (const w of this.discovery.getControllers()) {
      const cls = w.metatype as (new (...a: unknown[]) => unknown) | undefined;
      if (!cls) continue;
      const own = Reflect.getMetadata(MODULE_KEY, cls) as string[] | undefined;
      for (const c of own ?? []) if (!MODULE_MAP[c]) bad.push(`${cls.name}: უცნობი მოდული ${c}`);
      const proto = cls.prototype as Record<string, unknown>;
      for (const k of Object.getOwnPropertyNames(proto)) {
        if (k === 'constructor' || typeof proto[k] !== 'function' || !Reflect.getMetadata('path', proto[k] as object)) continue;
        const mm = Reflect.getMetadata(MODULE_KEY, proto[k] as object) as string[] | undefined;
        if (!own && !mm) bad.push(`${cls.name}.${k}: @RequireModule არ არის`);
        for (const c of mm ?? []) if (!MODULE_MAP[c]) bad.push(`${cls.name}.${k}: უცნობი მოდული ${c}`);
      }
    }
    if (bad.length) throw new Error(`მოდულების რეესტრი:\n  ${bad.join('\n  ')}`);
    await this.listen();
  }

  private async listen() {
    if (this.closing) return;
    try {
      const c = new Client({ connectionString: loadEnv().DATABASE_URL, application_name: 'emr-modules-listen' });
      c.on('notification', () => this.invalidate());
      c.on('error', (e) => { this.log.warn(`LISTEN emr_modules: ${e.message} — ხელახლა 10 წმ-ში`); this.listener = undefined; void c.end().catch(() => undefined); setTimeout(() => void this.listen(), 10_000); });
      await c.connect();
      await c.query('LISTEN emr_modules');
      this.listener = c;
    } catch (e) {
      this.log.warn(`LISTEN emr_modules: ${(e as Error).message} — ხელახლა 10 წმ-ში (ქეში ${SNAP_TTL_MS / 1000} წმ)`);
      setTimeout(() => void this.listen(), 10_000);
    }
  }
  async onModuleDestroy() { this.closing = true; await this.listener?.end().catch(() => undefined); }

  /**
   * 0086: ადმინის ჩამრთველების ერთობლივი ცვლილების შემოწმება (კონფიგურაციის პაკეტი, პროფილი) — საბოლოო მდგომარეობა მთლიანად, არა თითო ჩანაწერზე.
   * next — მხოლოდ ცვლილებები (code → enabled); დანარჩენი — მიმდინარე. ბრუნდება: ჩართული წინაპირობის გარეშე / გამორთული ჩართული დამოკიდებულით / ლიცენზიის გარეშე.
   */
  async checkTransition(next: Record<string, boolean>, ex: Database = this.db) {
    const rows = await ex.selectFrom('system_modules').select(['code', 'name', 'enabled']).execute();
    const cur = new Map(rows.map((r) => [r.code, r.enabled]));
    const names = new Map(rows.map((r) => [r.code, r.name]));
    const final = (c: string) => !!MODULE_MAP[c]?.core || (c in next ? next[c] : !!cur.get(c));
    const lic = (await this.snapshot()).license;
    const prereq: { code: string; missing: string[] }[] = [];
    const dependents: { code: string; dependents: string[] }[] = [];
    const notLicensed: string[] = [];
    for (const [c, on] of Object.entries(next)) {
      const d = MODULE_MAP[c]; if (!d || d.core) continue;
      if (on) {
        const miss = d.hard.filter((h) => !final(h));
        if (miss.length) prereq.push({ code: c, missing: miss });
        if (!(lic.modules === 'all' || lic.modules.includes(c))) notLicensed.push(c);
      } else {
        const deps = dependentsOf(c).filter((x) => final(x));
        if (deps.length) dependents.push({ code: c, dependents: deps });
      }
    }
    return { prereq, dependents, notLicensed, name: (c: string) => names.get(c) ?? c };
  }
  /** იმავე პროცესის ქეში + სხვა პროცესები (worker, lab-gateway) — ტრანზაქციის შემდეგ */
  async notifyChanged(ex: Database, code: string) {
    await sql`SELECT pg_notify('emr_modules', ${code})`.execute(ex);
    this.invalidate();
  }

  // ------------------------------------------------------------------ პროფილები (0086, K)
  profiles() {
    return PROFILES.map((p) => ({ code: p.code, name: p.name, description: p.description, modules: p.modules }));
  }
  /**
   * გეგმა: ჩაირთვება (ლიცენზირებული, ჯერ გამორთული) / გამოირთვება (disable_others: პროფილის გარეთ ჩართული) / რჩება ჩართული (ჩართული დამოკიდებული ჰყავს) /
   * ლიცენზიაში არ არის (გამოტოვდება) / უკვე ჩართულია. რიგი: ჩართვა — წინაპირობები ჯერ; გამორთვა — დამოკიდებულები ჯერ.
   */
  async profilePlan(code: string, disableOthers: boolean) {
    const p = PROFILE_MAP[code];
    if (!p) throw new NotFoundException(`პროფილი ვერ მოიძებნა: ${code}`);
    const snap = await this.snapshot();
    const rows = await this.db.selectFrom('system_modules').select(['code', 'name', 'enabled', 'can_disable']).execute();
    const cur = new Map(rows.map((r) => [r.code, r]));
    const licensed = (c: string) => snap.license.modules === 'all' || snap.license.modules.includes(c);
    const enable = p.modules.filter((c) => !cur.get(c)?.enabled && licensed(c));
    const notLicensed = p.modules.filter((c) => !licensed(c));
    const already = p.modules.filter((c) => cur.get(c)?.enabled);
    let disable = disableOthers ? OPTIONAL_CODES.filter((c) => !p.modules.includes(c) && cur.get(c)?.enabled && cur.get(c)?.can_disable !== false) : [];
    // გამოსართავს ჩართული დამოკიდებული ჰყავს (რომელიც რჩება) → რჩება ჩართული (fixed point)
    const kept: { code: string; dependents: string[] }[] = [];
    for (let changed = true; changed;) {
      changed = false;
      for (const c of disable) {
        const deps = dependentsOf(c).filter((x) => (cur.get(x)?.enabled || enable.includes(x)) && !disable.includes(x));
        if (deps.length) { kept.push({ code: c, dependents: deps }); disable = disable.filter((x) => x !== c); changed = true; break; }
      }
    }
    // რიგი: წინაპირობები ჯერ (რეესტრის რიგი ტოპოლოგიურია — hard წინ წერია) / დამოკიდებულები ჯერ (უკუ რიგი)
    const order = MODULES.map((d) => d.code);
    enable.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    disable.sort((a, b) => order.indexOf(b) - order.indexOf(a));
    const name = (c: string) => cur.get(c)?.name ?? c;
    const item = (c: string) => ({ code: c, name: name(c) });
    return { profile: { code: p.code, name: p.name }, disable_others: disableOthers,
      enable: enable.map(item), disable: disable.map(item), kept: kept.map((k) => ({ ...item(k.code), dependents: k.dependents.map(item) })),
      not_licensed: notLicensed.map(item), already: already.map(item) };
  }
  async profileApply(code: string, disableOthers: boolean, reason: string, u: AuthUser, req: Request) {
    const plan = await this.profilePlan(code, disableOthers);
    const next = Object.fromEntries([...plan.enable.map((x) => [x.code, true]), ...plan.disable.map((x) => [x.code, false])]);
    const t = await this.checkTransition(next);
    if (t.prereq.length) throw new ConflictException({ code: 'MODULE_PREREQ_MISSING', message: `ჯერ ჩართეთ: ${t.prereq.flatMap((x) => x.missing).map(t.name).join(', ')}`, missing: t.prereq.flatMap((x) => x.missing) });
    if (t.dependents.length) throw new ConflictException({ code: 'MODULE_HAS_DEPENDENTS', message: `ჩართულია დამოკიდებული: ${t.dependents.flatMap((x) => x.dependents).map(t.name).join(', ')}`, dependents: t.dependents.flatMap((x) => x.dependents) });
    if (!plan.enable.length && !plan.disable.length) return { ...plan, applied: false };
    await this.db.transaction().execute(async (trx) => {
      for (const x of [...plan.enable.map((e) => ({ ...e, on: true })), ...plan.disable.map((d) => ({ ...d, on: false }))]) {
        await trx.updateTable('system_modules').set({ enabled: x.on, updated_by: u.id, updated_at: sql`now()` }).where('code', '=', x.code).execute();
      }
      await this.audit.log(auditCtx(req), { action: 'MODULE_PROFILE_APPLY', entityName: 'system_modules', entityId: code,
        newData: { profile: code, disable_others: disableOthers, enabled: plan.enable.map((x) => x.code), disabled: plan.disable.map((x) => x.code),
          kept: plan.kept.map((x) => x.code), not_licensed: plan.not_licensed.map((x) => x.code), reason } }, trx);
      await sql`SELECT pg_notify('emr_modules', ${`profile:${code}`})`.execute(trx);
    });
    this.invalidate();
    this.notifications.clearSuppressionCache();
    return { ...plan, applied: true };
  }

  // ------------------------------------------------------------------ API
  async list() {
    const [rows, snap] = await Promise.all([this.db.selectFrom('system_modules').selectAll().orderBy('sort_order').execute(), this.snapshot()]);
    return rows.map((r) => {
      const d = MODULE_MAP[r.code]; const st = snap.states.get(r.code);
      return { ...r, group: d?.group ?? null, core: !!d?.core, hard: d?.hard ?? [], soft: d?.soft ?? [], settings_of: d?.settingsOf ?? null,
        dependents: d ? dependentsOf(r.code) : [], state: st?.state ?? 'disabled', active: st?.active ?? false, licensed: st?.licensed ?? false, missing: st?.missing ?? [] };
    });
  }

  async get(code: string) {
    const m = await this.db.selectFrom('system_modules').selectAll().where('code', '=', code).executeTakeFirst();
    if (!m) throw new NotFoundException('მოდული ვერ მოიძებნა');
    return m;
  }
  /**
   * მოდულის პარამეტრები (settingsOf — სხვა მოდულის ჩანაწერიდან). 0085: წვდომას guard წყვეტს (@RequireModule / @ClinicalHistory),
   * ამიტომ აქ აღარ ისვრის 403-ს — გამორთულ მოდულზე კლინიკური ისტორიის წაკითხვასაც პარამეტრები სჭირდება. ჩაწერის დინამიკური შემოწმება — assertActive.
   */
  async require<T = Record<string, unknown>>(code: string): Promise<T> {
    if (!MODULE_MAP[code]) throw new NotFoundException(`მოდული ვერ მოიძებნა: ${code}`);
    const snap = await this.snapshot();
    return (snap.rows.get(MODULE_MAP[code]?.settingsOf ?? code)?.settings ?? {}) as T;
  }

  async put(code: string, dto: { enabled?: boolean; settings?: Record<string, unknown>; reason: string }, u: AuthUser, req: Request) {
    const m = await this.get(code);
    const d = MODULE_MAP[code];
    if (dto.enabled === false && (!m.can_disable || d?.core)) throw new BadRequestException(`მოდული „${m.name}“ არ ითიშება`);
    if (dto.enabled !== undefined && dto.enabled !== m.enabled && d) {
      const rows = await this.db.selectFrom('system_modules').select(['code', 'name', 'enabled']).execute();
      const byCode = new Map(rows.map((r) => [r.code, r]));
      if (dto.enabled === false) {
        const deps = dependentsOf(code).filter((x) => byCode.get(x)?.enabled);
        if (deps.length) throw new ConflictException({ code: 'MODULE_HAS_DEPENDENTS', message: `ჯერ გამორთეთ დამოკიდებული მოდულები: ${deps.map((x) => byCode.get(x)?.name ?? x).join(', ')}`, dependents: deps });
      } else {
        const st = await this.state(code);
        if (!st.licensed) throw new ConflictException({ code: 'MODULE_NOT_LICENSED', message: `მოდული „${m.name}“ ლიცენზიაში არ შედის` });
        const miss = d.hard.filter((x) => !MODULE_MAP[x]?.core && !byCode.get(x)?.enabled);
        if (miss.length) throw new ConflictException({ code: 'MODULE_PREREQ_MISSING', message: `ჯერ ჩართეთ: ${miss.map((x) => byCode.get(x)?.name ?? x).join(', ')}`, missing: miss });
      }
    }
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
      await sql`SELECT pg_notify('emr_modules', ${code})`.execute(trx);
    });
    this.invalidate();
    if (code === 'worklist') this.notifications.clearSuppressionCache();   // 0084: ზარის ჩახშობა — მაშინვე
    return (await this.list()).find((x) => x.code === code);
  }
}

class ModuleDto { @IsOptional() @IsBoolean() enabled?: boolean; @IsOptional() @IsObject() settings?: Record<string, unknown>; @IsString() @Length(3, 500) reason: string }
class ProfilePreviewDto { @IsOptional() @IsBoolean() disable_others?: boolean }
class ProfileApplyDto { @IsOptional() @IsBoolean() disable_others?: boolean; @IsString() @Length(3, 500) reason: string }

@Controller('modules')
@RequireModule('core')
export class ModulesController {
  constructor(private readonly s: ModulesService) {}
  /** ყველა შესულ მომხმარებელს — მენიუ / ჩანართები მოდულის მიხედვით (state / active) */
  @Get() list() { return this.s.list(); }
  /** 0086 (K): პროფილები — სია / გეგმა / გამოყენება (admin) */
  @Get('profiles') @Roles('admin') profiles() { return this.s.profiles(); }
  @Post('profiles/:code/preview') @HttpCode(200) @Roles('admin') preview(@Param('code') code: string, @Body() d: ProfilePreviewDto) { return this.s.profilePlan(code, !!d?.disable_others); }
  @Post('profiles/:code/apply') @HttpCode(200) @Roles('admin') apply(@Param('code') code: string, @Body() d: ProfileApplyDto, @CurrentUser() u: AuthUser, @Req() r: Request) {
    return this.s.profileApply(code, !!d.disable_others, d.reason, u, r);
  }
  @Put(':code') @Roles('admin') put(@Param('code') code: string, @Body() d: ModuleDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.put(code, d, u, r); }
}

@Global()
@Module({ imports: [DiscoveryModule], providers: [ModulesService, LicenseService, { provide: APP_GUARD, useClass: ModuleGuard }],
  controllers: [ModulesController, LicenseController], exports: [ModulesService, LicenseService] })
export class ModulesModule {}

/** worker: იგივე სერვისები, controller-ებისა და guard-ის გარეშე */
@Global()
@Module({ imports: [DiscoveryModule], providers: [ModulesService, LicenseService], exports: [ModulesService, LicenseService] })
export class ModulesCoreModule {}
