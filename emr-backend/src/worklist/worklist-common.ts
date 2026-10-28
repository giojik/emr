import { sql, type Transaction } from 'kysely';
import { loadEnv } from '../config/env';
import { has, type AuthUser, type Role } from '../auth/roles';
import type { Database } from '../database/database.module';
import type { DB } from '../database/db';

export type Trx = Transaction<DB>;
export type Ex = Database | Trx;
export const TZ = loadEnv().CLINIC_TZ;

/**
 * სამუშაო სიები (D5, 0081) — საერთო: პარამეტრები, წყაროების კატალოგი, ერთიანი ჩანაწერი, არეები.
 */
export interface WlSettings {
  /** ვის შეუძლია სხვისთვის მინიჭება: any — ნებისმიერს; department — თავის განყოფილებ(ებ)ში + სხვა განყოფილების რიგში; managers — სხვისთვის მხოლოდ ხელმძღვანელს */
  assign_scope: 'any' | 'department' | 'managers';
  /** შესრულების კომენტარი სავალდებულოა: off / urgent (მხოლოდ სასწრაფოზე) / all */
  done_comment: 'off' | 'urgent' | 'all';
  reopen_days: number;
  remind_at_due: boolean;
  /** ვადის გასვლიდან N საათში — ესკალაცია ხელმძღვანელზე; 0 — გამორთული */
  escalate_hours: number;
  /** ვადა პრიორიტეტით (ჩვეულებრივი / მაღალი / სასწრაფო), საათი; 0 — ვადის გარეშე. კატეგორიის SLA — უპირატესი */
  due_default_hours: [number, number, number];
  notify_assign: boolean;
  notify_done: boolean;
  patient_tasks: boolean;
  /** წყარო → false (გამორთული); არ არის — ჩართული */
  sources: Record<string, boolean>;
  /** მთვლელი: all — ყველა / overdue — მხოლოდ ვადაგადაცილებული / off */
  badge: 'all' | 'overdue' | 'off';
  refresh_seconds: number;
  /** „ჩემი დავალებები“ — საწყისი გვერდი ყველასთვის */
  home_tasks: boolean;
  // ---- 0082: ადმინისტრაცია / ლოჯისტიკის წყაროები
  /** განყოფილების მხარე (მიღება, CSSD-ის გაწვევა / ვადა, გეგმიური ჰოსპიტალიზაცია): heads — ხელმძღვანელი (უხელმძღვანელოზე — ყველა წევრი) / all — ყველა წევრი */
  dept_side: 'heads' | 'all';
  /** მარაგის ვადა: „იწურება“ — N დღეში (0 — მხოლოდ ვადაგასული) */
  stk_expiry_days: number;
  /** ვადა (სთ) წყაროებზე, რომლებსაც თავისი ვადა არ აქვს — გაგზავნიდან; 0 — ვადის გარეშე */
  sla_hours: Record<SlaKey, number>;
  /** წინა თვის დახურვის ვადა — მიმდინარე თვის N რიცხვი */
  period_close_day: number;
  /** „ქლეიმის გარეშე“ (წინა თვე) — ჩნდება მიმდინარე თვის N რიცხვიდან */
  claim_build_day: number;
  /** გაწერილის ფინალიზაციის ვადა — გაწერიდან N დღე */
  ipd_finalize_days: number;
  /** დაუხურავი ჩაწერა — ბოლო N დღე (0 — მხოლოდ დღეს) */
  appt_open_days: number;
  /** გადახდის ნებართვით გახსნილი ვიზიტის ვალი — ბოლო N დღე */
  debt_days: number;
  /** რეგისტრატურა: all — მთელი კლინიკა / department — საკუთარი განყოფილება(ები) */
  reg_scope: 'all' | 'department';
  /** BI-ს პასუხის ვადა — ციკლიდან N საათი */
  bi_due_hours: number;
  // ---- 0083: კლინიკური წყაროები
  /** ექთნის შესასრულებელი საქმე: department — განყოფილების ექთნები; on_shift — ახლა ცვლაში მყოფი (D4; ცვლაში არავინ / roster გამორთული → department) */
  nurse_scope: 'department' | 'on_shift';
  /** MAR: „ახლა შესასრულებელი“ — ფანჯარა წინ, წუთი */
  mar_due_ahead_min: number;
  /** ვიტალური ნიშნების გაზომვის სიხშირე NEWS2-ის დონით, წუთი (RCP 2017): ქულა 0 / 1–4 / ერთ პარამეტრზე 3 / 5–6 / ≥ 7 */
  obs_minutes: Record<ObsKey, number>;
  /** NEWS2 — ექიმის შეფასების ვადა, წუთი: alert (≥ news2_alert) / urgent (≥ news2_urgent) */
  news2_review_min: { alert: number; urgent: number };
  /** ხაზის / კათეტერის საჭიროების გადახედვა — ყოველ N საათში (line_alert_hours-ის შემდეგ) */
  line_review_hours: number;
  /** ხელმოუწერელი ჩანაწერი — N საათის შემდეგ */
  draft_hours: number;
  /** დაუხურავი ამბულატორიული ვიზიტი — ბოლო N დღე */
  amb_open_days: number;
  /** საოპერაციო: წინასაოპერაციო შეფასება / მზადყოფნა — ოპერაციამდე N საათი */
  or_ahead_hours: number;
  /** PACU — N საათზე მეტი → მაღალი */
  pacu_long_hours: number;
}
export const OBS_KEYS = ['zero', 'low', 'low_red', 'medium', 'high'] as const;
export type ObsKey = (typeof OBS_KEYS)[number];
export const SLA_KEYS = ['stk_approve', 'stk_issue', 'stk_receive', 'stk_urgent', 'proc_approve', 'asset_move', 'med_verify', 'med_approve', 'doc_cosign', 'or_docs'] as const;
export type SlaKey = (typeof SLA_KEYS)[number];
export const WL_DEFAULTS: WlSettings = {
  assign_scope: 'any', done_comment: 'urgent', reopen_days: 7, remind_at_due: true, escalate_hours: 0, due_default_hours: [0, 24, 4],
  notify_assign: true, notify_done: true, patient_tasks: true, sources: {}, badge: 'all', refresh_seconds: 60, home_tasks: false,
  dept_side: 'heads', stk_expiry_days: 30,
  sla_hours: { stk_approve: 24, stk_issue: 24, stk_receive: 24, stk_urgent: 4, proc_approve: 48, asset_move: 72, med_verify: 2, med_approve: 4, doc_cosign: 24, or_docs: 24 },
  period_close_day: 10, claim_build_day: 5, ipd_finalize_days: 3, appt_open_days: 2, debt_days: 30, reg_scope: 'all', bi_due_hours: 48,
  nurse_scope: 'department', mar_due_ahead_min: 60, obs_minutes: { zero: 720, low: 240, low_red: 60, medium: 60, high: 30 }, news2_review_min: { alert: 60, urgent: 30 },
  line_review_hours: 24, draft_hours: 12, amb_open_days: 7, or_ahead_hours: 24, pacu_long_hours: 4,
};

/** სისტემური წყაროების კატალოგი (კოდი → ჯგუფი / დასახელება / მოდული). 0082 — ადმინისტრაცია / ლოჯისტიკა; 0083 — კლინიკური; 0084 — დაემატება. module = 'core' — ყოველთვის ჩართული */
export const SOURCES: Record<string, { group: string; name: string; module: string; who: string }> = {
  qm_triage: { group: 'ხარისხი', name: 'ინციდენტის ტრიაჟი', module: 'quality', who: 'ხარისხის მენეჯერი (quality)' },
  qm_analysis: { group: 'ხარისხი', name: 'ინციდენტის ანალიზი (გამომძიებელი / გუნდი)', module: 'quality', who: 'გამომძიებელი, RCA გუნდის წევრი' },
  qm_review: { group: 'ხარისხი', name: 'წარდგენილი ანალიზის დამტკიცება', module: 'quality', who: 'ხარისხის მენეჯერი' },
  qm_capa: { group: 'ხარისხი', name: 'მაკორექტირებელი ქმედება (CAPA)', module: 'quality', who: 'CAPA-ს პასუხისმგებელი' },
  qm_capa_due: { group: 'ხარისხი', name: 'CAPA — ვადის ცვლილების მოთხოვნა', module: 'quality', who: 'ხარისხის მენეჯერი' },
  qm_effect: { group: 'ხარისხი', name: 'CAPA — ეფექტიანობის შემოწმება', module: 'quality', who: 'ხარისხის მენეჯერი' },
  ipc_signal: { group: 'ინფექციის კონტროლი', name: 'IPC სიგნალი', module: 'ipc', who: 'infection (ყველა) / infection_dept (განყოფილება)' },
  ipc_hai: { group: 'ინფექციის კონტროლი', name: 'HAI შემთხვევა — განსახილველი', module: 'ipc', who: 'infection / infection_dept' },
  ipc_flag: { group: 'ინფექციის კონტროლი', name: 'MDRO ფლაგი — დასადასტურებელი', module: 'ipc', who: 'infection' },
  ipc_ssi: { group: 'ინფექციის კონტროლი', name: 'SSI — პაციენტთან კონტაქტი', module: 'ipc', who: 'infection / infection_dept' },
  ipc_abx: { group: 'ინფექციის კონტროლი', name: 'ანტიბიოტიკის გადახედვა (time-out)', module: 'ipc', who: 'დამნიშნავი / მკურნალი ექიმი' },
  bme_triage: { group: 'ბიომედ-აპარატურა', name: 'შეკეთების მოთხოვნა — ტრიაჟი', module: 'bme', who: 'სამედიცინო ინჟინერი' },
  bme_repair: { group: 'ბიომედ-აპარატურა', name: 'შეკეთების ორდერი (ჩემზე)', module: 'bme', who: 'შემსრულებელი' },
  bme_confirm: { group: 'ბიომედ-აპარატურა', name: 'შეკეთება — დასადასტურებელი', module: 'bme', who: 'განმცხადებელი, განყოფილება (bme_dept)' },
  bme_work: { group: 'ბიომედ-აპარატურა', name: 'PM / კალიბრაცია (ჩემზე)', module: 'bme', who: 'შემსრულებელი' },
  bme_work_free: { group: 'ბიომედ-აპარატურა', name: 'PM / კალიბრაცია — შემსრულებლის გარეშე', module: 'bme', who: 'სამედიცინო ინჟინერი' },
  roster_absence: { group: 'ცვლები და მორიგეობა', name: 'არყოფნის მოთხოვნა — გადაწყვეტილება', module: 'roster', who: 'ხელმძღვანელი / HR' },
  roster_swap: { group: 'ცვლები და მორიგეობა', name: 'გაცვლა — შემდგენის დადასტურება', module: 'roster', who: 'განრიგის შემდგენი' },
  roster_offer: { group: 'ცვლები და მორიგეობა', name: 'დასაფარი ცვლა — მოხალისის მინიჭება', module: 'roster', who: 'განრიგის შემდგენი' },
  roster_peer: { group: 'ცვლები და მორიგეობა', name: 'გაცვლის თხოვნა კოლეგისგან', module: 'roster', who: 'კოლეგა' },
  roster_timesheet: { group: 'ცვლები და მორიგეობა', name: 'თვის ტაბელის დახურვა', module: 'roster', who: 'HR' },
  // ---- 0082: მარაგი
  stk_approve: { group: 'მარაგი', name: 'განყოფილების მოთხოვნა (RQ) — დამტკიცება', module: 'stock', who: 'განყოფილების ხელმძღვანელი / მენეჯერი; ლაბ. — lab_manager; განყოფილების გარეშე — stock_manager' },
  stk_issue: { group: 'მარაგი', name: 'მოთხოვნა — გასაცემი', module: 'stock', who: 'გამცემი ლოკაციის მფლობელი (საწყობი — მესაწყობე, აფთიაქი — ფარმაცევტი)' },
  stk_receive: { group: 'მარაგი', name: 'გადაცემა / დაბრუნება — მისაღები', module: 'stock', who: 'მიმღები ლოკაციის მფლობელი (განყოფილება — dept_side)' },
  stk_writeoff: { group: 'მარაგი', name: 'ჩამოწერა — დამტკიცება', module: 'stock', who: 'საწყობის მენეჯერი (ავტორის გარდა)' },
  stk_count: { group: 'მარაგი', name: 'ინვენტარიზაცია — დასრულება / დამტკიცება', module: 'stock', who: 'დამწყები (ღია); საწყობის მენეჯერი (დათვლილი)' },
  stk_expiry: { group: 'მარაგი', name: 'ვადაგასული / ვადა იწურება (ლოკაციაზე)', module: 'stock', who: 'როგორც დილის შეტყობინებაში' },
  stk_min: { group: 'მარაგი', name: 'მინიმუმზე ქვემოთ (ლოკაციაზე)', module: 'stock', who: 'როგორც დილის შეტყობინებაში' },
  stk_empties: { group: 'მარაგი', name: 'ცარიელი ამპულის დაბრუნება — დადასტურება', module: 'stock', who: 'ფარმაცევტი (არ არის — მესაწყობე / საწყობის მენეჯერი)' },
  stk_quarantine: { group: 'მარაგი', name: 'ლოტი კარანტინშია — გადაწყვეტილება', module: 'stock', who: 'საწყობის მენეჯერი / ფარმაცევტი' },
  // ---- 0082: შესყიდვები
  proc_pr_approve: { group: 'შესყიდვები', name: 'შესყიდვის მოთხოვნა (PR) — ჩემი დამტკიცების ნაბიჯი', module: 'procurement', who: 'L1 — საწყობის მენეჯერი; ფინანსური — procurement_approve; ნარკოტიკული — ფარმაცევტი' },
  proc_pr_order: { group: 'შესყიდვები', name: 'დამტკიცებული PR — შეკვეთის (PO) გარეშე', module: 'procurement', who: 'შესყიდვები (არ არის — საწყობის მენეჯერი)' },
  proc_po_approve: { group: 'შესყიდვები', name: 'შეკვეთა (PO) — დამტკიცება', module: 'procurement', who: 'procurement_approve (ავტორის გარდა)' },
  proc_po_overdue: { group: 'შესყიდვები', name: 'შეკვეთის მიწოდება ვადაგადაცილებულია', module: 'procurement', who: 'ავტორი + შესყიდვები' },
  // ---- 0082: ფინანსები / ბილინგი / ტარიფები
  ap_match: { group: 'ფინანსები', name: 'მომწოდებლის ინვოისი — შეჯერება არ ემთხვევა', module: 'procurement', who: 'ბუღალტერი' },
  ap_due: { group: 'ფინანსები', name: 'მომწოდებლის ინვოისი — გადასახდელი / ვადაგადაცილებული', module: 'procurement', who: 'ბუღალტერი' },
  fin_claim_due: { group: 'ფინანსები', name: 'ქლეიმის ანაზღაურება ვადაგადაცილებულია', module: 'finance', who: 'ბუღალტერი' },
  fin_claim_resolve: { group: 'ფინანსები', name: 'ქლეიმი — დანაკლისი / უარი გადასაწყვეტია', module: 'finance', who: 'ბილინგი / ბუღალტერი' },
  fin_claim_build: { group: 'ფინანსები', name: 'წინა თვის შემთხვევები ქლეიმის გარეშე (გადამხდელზე)', module: 'finance', who: 'ბუღალტერი' },
  fin_period: { group: 'ფინანსები', name: 'წინა თვის დახურვა', module: 'finance', who: 'ბუღალტერი (period_lock = on)' },
  bill_finalize: { group: 'ფინანსები', name: 'გაწერილი ჰოსპიტალიზაცია — ფინალიზაცია', module: 'inpatient', who: 'ბილინგი' },
  tariff_approve: { group: 'ფინანსები', name: 'ტარიფის / გადამხდელის წესის ცვლილება — დამტკიცება', module: 'tariffs', who: 'tariffs_approve (ავტორის გარდა)' },
  // ---- 0082: CSSD
  cssd_recall: { group: 'CSSD', name: 'გაწვეული შეფუთვა განყოფილებაში — დასაბრუნებელი', module: 'cssd', who: 'გამცემი განყოფილება (dept_side) + CSSD ერთეული' },
  cssd_expiry: { group: 'CSSD', name: 'განყოფილებაში შეფუთვის ვადა (გასული / ≤ 7 დღე)', module: 'cssd', who: 'განყოფილება (dept_side)' },
  cssd_bi: { group: 'CSSD', name: 'BI-ს პასუხი მოლოდინშია (კარანტინი)', module: 'cssd', who: 'CSSD ერთეულის თანამშრომლები' },
  cssd_bd: { group: 'CSSD', name: 'Bowie-Dick — დღეს არ ჩატარებულა', module: 'cssd', who: 'CSSD ერთეულის თანამშრომლები' },
  // ---- 0082: ინვენტარი
  asset_move: { group: 'ინვენტარი', name: 'გადაადგილება — დადასტურება', module: 'asset_register', who: 'მიმღები პასუხისმგებელი → განყოფილების ხელმძღვანელი → საწყობის მენეჯერი' },
  asset_writeoff: { group: 'ინვენტარი', name: 'ჩამოწერის აქტი — დამტკიცება / ხმა', module: 'asset_register', who: 'საწყობის მენეჯერი (single) / კომისიის წევრი (committee)' },
  // ---- 0082: რეგისტრატურა / სალარო
  reg_appt: { group: 'რეგისტრატურა / სალარო', name: 'ჩაწერის დრო გავიდა — „მოვიდა“ / „არ გამოცხადდა“', module: 'core', who: 'რეგისტრატორი' },
  reg_planned: { group: 'რეგისტრატურა / სალარო', name: 'გეგმიური ჰოსპიტალიზაცია — დღეს / გადაცილებული', module: 'inpatient', who: 'რეგისტრატორი + განყოფილება (dept_side)' },
  cash_debt: { group: 'რეგისტრატურა / სალარო', name: 'გადახდის ნებართვით გახსნილი ვიზიტი — ვალი', module: 'core', who: 'რეგისტრატორი / ბილინგი' },
  // ---- 0083: კლინიკური დოკუმენტაცია (ექიმი)
  doc_admission: { group: 'კლინიკური დოკუმენტაცია', name: 'მიმღები გასინჯვა — ხელმოსაწერი', module: 'inpatient', who: 'მკურნალი ექიმი (არ არის — ხელმძღვანელი / განყოფილების ექიმები)' },
  doc_progress: { group: 'კლინიკური დოკუმენტაცია', name: 'დღიური აკლია (გუშინ)', module: 'inpatient', who: 'მკურნალი ექიმი' },
  doc_draft: { group: 'კლინიკური დოკუმენტაცია', name: 'ხელმოუწერელი ჩანაწერი (ჩემი)', module: 'inpatient', who: 'ავტორი' },
  doc_discharge: { group: 'კლინიკური დოკუმენტაცია', name: 'გაწერილი — დოკუმენტაცია დაუხურავია (ეპიკრიზი)', module: 'inpatient', who: 'მკურნალი ექიმი' },
  doc_cosign: { group: 'კლინიკური დოკუმენტაცია', name: 'ეპიკრიზი — თანახელმოწერა', module: 'inpatient', who: 'განყოფილების ხელმძღვანელი (ხელმომწერის გარდა)' },
  doc_consent: { group: 'კლინიკური დოკუმენტაცია', name: 'სავალდებულო თანხმობა აკლია', module: 'inpatient', who: 'მკურნალი ექიმი' },
  amb_open: { group: 'კლინიკური დოკუმენტაცია', name: 'ამბულატორიული ვიზიტი დაუხურავია', module: 'core', who: 'ვიზიტის ექიმი' },
  // ---- 0083: დანიშნულებები / MAR
  med_verify: { group: 'დანიშნულებები / MAR', name: 'დანიშნულების ვერიფიკაცია', module: 'inpatient', who: 'med_verifier: ფარმაცევტი / განყოფილების მთავარი ექთანი / ორივე' },
  med_rejected: { group: 'დანიშნულებები / MAR', name: 'ვერიფიკაციაზე უარი — დანიშნულება გადასახედია', module: 'inpatient', who: 'დამნიშნავი' },
  med_approve: { group: 'დანიშნულებები / MAR', name: 'შეზღუდული ანტიბიოტიკი — დამტკიცება', module: 'inpatient', who: 'abx_approver: განყოფილების ხელმძღვანელი / ფარმაცევტი / ინფექციის კონტროლი' },
  med_verbal: { group: 'დანიშნულებები / MAR', name: 'ზეპირი დანიშნულება — დადასტურება', module: 'inpatient', who: 'დამნიშნავი ექიმი' },
  med_abx_end: { group: 'დანიშნულებები / MAR', name: 'ანტიბიოტიკი სრულდება 24 სთ-ში', module: 'inpatient', who: 'დამნიშნავი + მკურნალი ექიმი' },
  mar_due: { group: 'დანიშნულებები / MAR', name: 'MAR — ახლა შესასრულებელი დოზები (პაციენტზე)', module: 'inpatient', who: 'განყოფილების ექთნები (nurse_scope)' },
  mar_missed: { group: 'დანიშნულებები / MAR', name: 'MAR — ვადაგადაცილებული / გამოტოვებული (პაციენტზე)', module: 'inpatient', who: 'განყოფილების ექთნები (nurse_scope)' },
  // ---- 0083: კონსულტაცია / გადაყვანა
  consult_todo: { group: 'კონსულტაცია / გადაყვანა', name: 'კონსულტაცია — მოთხოვნილი', module: 'inpatient', who: 'სამიზნე ექიმი / განყოფილების ექიმები (სასწრაფო + duty — მორიგე)' },
  transfer_in: { group: 'კონსულტაცია / გადაყვანა', name: 'გადმოყვანის მოთხოვნა', module: 'inpatient', who: 'მიმღები განყოფილება (dept_side)' },
  // ---- 0083: საექთნო / NEWS2
  nur_scale: { group: 'საექთნო / NEWS2', name: 'სავალდებულო შკალები — ვადა (პაციენტზე)', module: 'inpatient', who: 'განყოფილების ექთნები (nurse_scope)' },
  nur_line: { group: 'საექთნო / NEWS2', name: 'ხაზი / კათეტერი — საჭიროების შეფასება', module: 'inpatient', who: 'მკურნალი ექიმი + განყოფილების ექთნები' },
  nur_handover: { group: 'საექთნო / NEWS2', name: 'ცვლის გადაბარება — მისაღები', module: 'inpatient', who: 'განყოფილების ექთნები (ავტორის გარდა)' },
  nur_obs: { group: 'საექთნო / NEWS2', name: 'ვიტალური ნიშნები — გაზომვის ვადა (NEWS2)', module: 'inpatient', who: 'განყოფილების ექთნები (nurse_scope)' },
  news2_review: { group: 'საექთნო / NEWS2', name: 'NEWS2 — ექიმის შეფასება', module: 'inpatient', who: 'მკურნალი ექიმი (სასწრაფოზე + ხელმძღვანელი)' },
  // ---- 0083: ICU
  icu_sheet: { group: 'ICU', name: 'მონიტორინგის ფურცელი — შეუვსებელი', module: 'icu', who: 'ICU-ს ექთნები' },
  icu_bundle: { group: 'ICU', name: 'VAP / CLABSI bundle — დღეს', module: 'icu', who: 'ICU-ს ექთნები' },
  icu_sofa: { group: 'ICU', name: 'SOFA — დღეს', module: 'icu', who: 'მკურნალი + ICU-ს ექიმები' },
  // ---- 0083: საოპერაციო / PACU
  or_request: { group: 'საოპერაციო / PACU', name: 'ოპერაციის მოთხოვნა — დაგეგმვა / დადასტურება', module: 'or', who: 'or_scheduling: კოორდინატორი / ქირურგი + ხელმძღვანელი' },
  or_preop: { group: 'საოპერაციო / PACU', name: 'წინასაოპერაციო შეფასება (ანესთეზიოლოგი)', module: 'or', who: 'გუნდის ანესთეზიოლოგი → ხელმძღვანელი → ანესთეზიოლოგები' },
  or_ready: { group: 'საოპერაციო / PACU', name: 'მზადყოფნის ჩეკლისტი — არასრული', module: 'or', who: 'ქირურგიული განყოფილება (dept_side)' },
  or_docs: { group: 'საოპერაციო / PACU', name: 'ოქმი / ანესთეზიის რუკა — ხელმოსაწერი', module: 'or', who: 'ოქმი — ოპერატორი; რუკა — გუნდის ანესთეზიოლოგი' },
  or_pacu: { group: 'საოპერაციო / PACU', name: 'PACU — პაციენტი (გაწერა / დიდხანს)', module: 'or', who: 'PACU-ს ექთანი + გუნდის ანესთეზიოლოგი' },
};
export const SOURCE_CODES = Object.keys(SOURCES);

export type Priority = 'normal' | 'high' | 'urgent';
export const PRIORITY_KA: Record<Priority, string> = { normal: 'ჩვეულებრივი', high: 'მაღალი', urgent: 'სასწრაფო' };
export const PRI_RANK: Record<Priority, number> = { urgent: 0, high: 1, normal: 2 };
export const STATUS_KA: Record<string, string> = { open: 'ღია', in_progress: 'შესრულებაში', done: 'შესრულებული', cancelled: 'გაუქმებული' };
export const TARGET_KA: Record<string, string> = { user: 'პირი', role: 'როლი', department: 'განყოფილება', role_department: 'როლი + განყოფილება', duty: 'მორიგე' };
export const ACTIVE = ['open', 'in_progress'] as const;

/** ერთიანი ჩანაწერი „ჩემს დავალებებში“ (სისტემური / ხელით) */
export interface WlItem {
  key: string;
  kind: 'system' | 'task';
  source: string;
  group: string;
  title: string;
  detail: string | null;
  patient: string | null;
  department: string | null;
  due_at: string | null;
  /** due_at — დღის ბოლო (ვადა თარიღია, საათის გარეშე) */
  due_date_only: boolean;
  overdue: boolean;
  priority: Priority;
  link: string;
  created_at: string | null;
  /** ხელით: დავალების დამატებითი ველები */
  task?: { id: string; task_no: string; status: string; target_kind: string; target_label: string; claimed_by_name: string | null; group: boolean; created_by_name: string | null };
}

export const userName = (alias: string) => sql<string | null>`${sql.ref(`${alias}.last_name`)} || ' ' || ${sql.ref(`${alias}.first_name`)}`;
export const iso = (d: Date | string | null | undefined) => (d == null ? null : d instanceof Date ? d.toISOString() : new Date(d).toISOString());
/** YYYY-MM-DD → ამ დღის 00:00 კლინიკის დროით */
export function zonedMidnight(day: string, tz = TZ): Date {
  const probe = new Date(`${day}T12:00:00Z`);
  const off = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(probe).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(off);
  const mins = m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0;
  return new Date(Date.parse(`${day}T00:00:00Z`) - mins * 60_000);
}
/** თარიღის ვადა → დღის ბოლო კლინიკის დროით (ISO) */
export const dayEnd = (col: string) => sql<Date | null>`((${sql.ref(col)}::date + 1)::timestamp AT TIME ZONE ${TZ}) - interval '1 second'`;

/** ხელმძღვანელის უფლებები */
export const WL_ALL: Role[] = ['admin', 'worklist_all'];
export const WL_MANAGE: Role[] = ['worklist_manage'];
export const isAll = (u: AuthUser) => has(u, ...WL_ALL);

/** worklist_manage-ის არე: users.department_id ∪ rpt_user_scopes (როგორც სხვა მოდულებში) */
export async function manageDepts(ex: Ex, u: AuthUser): Promise<string[]> {
  if (!has(u, ...WL_MANAGE)) return [];
  const r = await sql<{ id: string }>`SELECT department_id AS id FROM rpt_user_scopes WHERE user_id = ${u.id}
    UNION SELECT department_id FROM users WHERE id = ${u.id} AND department_id IS NOT NULL`.execute(ex);
  return r.rows.map((x) => x.id);
}
/**
 * განყოფილების რიგის წევრობა (ვინ არის „განყოფილება X“-ის წევრი): users.department_id ∪ D4 თანამშრომლის ძირითადი / დამატებითი განყოფილებები.
 * რეპორტინგის ხედვის არე (rpt_user_scopes) აქ არ ითვლება — ის ხედვაა და არა წევრობა.
 */
export async function memberDepts(ex: Ex, userId: string): Promise<string[]> {
  const r = await sql<{ id: string }>`
    SELECT department_id AS id FROM users WHERE id = ${userId} AND department_id IS NOT NULL
    UNION SELECT s.department_id FROM staff_members s WHERE s.user_id = ${userId} AND s.is_active AND s.department_id IS NOT NULL
    UNION SELECT x.department_id FROM staff_member_departments x JOIN staff_members s ON s.id = x.staff_id WHERE s.user_id = ${userId} AND s.is_active`.execute(ex);
  return r.rows.map((x) => x.id);
}
export async function myRoleIds(ex: Ex, userId: string): Promise<string[]> {
  const r = await sql<{ id: string }>`SELECT ur.role_id AS id FROM user_roles ur JOIN roles r ON r.id = ur.role_id AND r.is_active WHERE ur.user_id = ${userId}`.execute(ex);
  return r.rows.map((x) => x.id);
}
/** ამ მომენტში მორიგე ვარ თუ არა (გამოქვეყნებული განრიგი) — SQL-ის პირობა t.target_duty_role_id-ზე */
export const onDutyCond = (userId: string, at: Date | null = null) => sql<boolean>`EXISTS (
  SELECT 1 FROM roster_entries e JOIN rosters r ON r.id = e.roster_id JOIN staff_members s ON s.id = e.staff_id
   WHERE s.user_id = ${userId} AND e.duty_role_id = t.target_duty_role_id AND e.status = 'active' AND r.status IN ('published', 'closed')
     AND e.starts_at <= coalesce(${at}::timestamptz, now()) AND e.ends_at > coalesce(${at}::timestamptz, now())
     AND EXISTS (SELECT 1 FROM system_modules m WHERE m.code = 'roster' AND m.enabled))`;

export async function wlSettings(ex: Ex): Promise<{ enabled: boolean; s: WlSettings }> {
  const m = await ex.selectFrom('system_modules').select(['enabled', 'settings']).where('code', '=', 'worklist').executeTakeFirst();
  return { enabled: !!m?.enabled, s: { ...WL_DEFAULTS, ...((m?.settings ?? {}) as Partial<WlSettings>) } };
}
export async function enabledModules(ex: Ex): Promise<Set<string>> {
  const r = await ex.selectFrom('system_modules').select('code').where('enabled', '=', true).execute();
  return new Set(['core', ...r.map((x) => x.code)]);   // core — ბირთვი (რეგისტრატურა / სალარო), ყოველთვის ჩართული
}
