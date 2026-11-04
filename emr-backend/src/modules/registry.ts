import type { Role } from '../auth/roles';

/**
 * მოდულების რეესტრი (0085) — ერთადერთი წყარო: ჯგუფი, მკაცრი წინაპირობა, რბილი კავშირი.
 * ბაზაში (system_modules) — მხოლოდ enabled / settings; ახალი კოდი → მიგრაციის seed-იც.
 *
 * აქტიური = ბირთვია ∨ (ლიცენზიაშია ∧ ადმინმა ჩართო ∧ ყველა მკაცრი წინაპირობა აქტიურია).
 * რბილი კავშირი — „პორტი“ (`modules.isActive(code)`): გამორთულზე ნაბიჯი გამოიტოვება, მომიჯნავე მოდული არ ვარდება.
 */
export type ModuleGroup = 'core' | 'clinical' | 'diagnostics' | 'logistics' | 'finance' | 'management';
export interface ModuleDef {
  code: string;
  group: ModuleGroup;
  core?: boolean;
  /** მკაცრი წინაპირობები: გარეშე მოდული არააქტიურია; წინაპირობის გამორთვა იბლოკება, სანამ ეს ჩართულია */
  hard: string[];
  /** რბილი კავშირები (დოკუმენტაცია + 0086-ის e2e მატრიცა) */
  soft: string[];
  /** სად ინახება პარამეტრები, თუ სხვა მოდულის ჩანაწერშია (B: 0042 / 0043 — inpatient) */
  settingsOf?: string;
}

const m = (code: string, group: ModuleGroup, hard: string[] = [], soft: string[] = [], extra: Partial<ModuleDef> = {}): ModuleDef => ({ code, group, hard, soft, ...extra });

export const MODULES: ModuleDef[] = [
  // ბირთვი — არ ითიშება, ლიცენზია არ სჭირდება
  m('core', 'core', [], [], { core: true }),
  m('mpi', 'core', [], [], { core: true }),
  m('encounters', 'core', [], [], { core: true }),
  m('billing', 'core', [], [], { core: true }),
  // კლინიკა
  m('outpatient', 'clinical', [], ['lab', 'radiology', 'endoscopy']),
  m('inpatient', 'clinical', [], ['icu', 'or', 'ipc', 'drg', 'roster']),
  m('ipd_orders', 'clinical', ['inpatient', 'pharmacy'], ['lab', 'radiology'], { settingsOf: 'inpatient' }),
  m('mar', 'clinical', ['ipd_orders'], ['stock'], { settingsOf: 'inpatient' }),
  m('icu', 'clinical', ['inpatient'], ['mar']),
  m('or', 'clinical', ['inpatient'], ['stock', 'cssd', 'roster', 'bme', 'ipc']),   // 0086: + ipc (SSI / პროფილაქტიკის ფანჯარა)
  // 0087: გადაუდებელი (ER) — მკაცრი წინაპირობა არ აქვს; რბილი კავშირები ემატება ეტაპობრივად, როცა ქცევა კოდშია (0087: roster — „მორიგე ახლა“ დაფაზე)
  m('er', 'clinical', [], ['roster', 'lab', 'radiology', 'endoscopy', 'stock', 'pharmacy']),   // 0088: + lab / radiology / endoscopy (დიაგნოსტიკა ER-ის შემთხვევაზე); 0089: + stock (ჩამოწერა), pharmacy (დოზა / ურთიერთქმედება)
  // დიაგნოსტიკა
  m('lab', 'diagnostics', [], ['outpatient', 'inpatient', 'worklist']),   // 0086: + worklist (კრიტიკული ზარი / პასუხის გაცნობა)
  m('lab_gateway', 'diagnostics', ['lab'], ['lab_qc']),
  m('lab_external', 'diagnostics', ['lab'], ['finance']),
  m('lab_qc', 'diagnostics', ['lab'], ['lab_gateway']),
  m('lab_micro', 'diagnostics', ['lab'], ['ipc']),
  m('radiology', 'diagnostics', [], ['bme']),
  m('endoscopy', 'diagnostics', [], ['bme', 'cssd']),
  // ლოჯისტიკა
  m('stock', 'logistics', [], ['procurement', 'finance', 'cssd']),   // 0086: + cssd (შეფუთვის ვადის ჯობი)
  m('pharmacy', 'logistics', ['stock'], ['ipd_orders']),
  m('lab_stock', 'logistics', ['stock', 'lab'], ['lab_qc']),
  m('procurement', 'logistics', ['stock'], ['finance']),
  m('cssd', 'logistics', [], ['or', 'endoscopy', 'stock']),
  m('asset_register', 'logistics', [], []),
  m('bme', 'logistics', [], ['or', 'radiology', 'endoscopy', 'roster', 'procurement']),   // 0086: + procurement (შეკეთების ნაწილები → PR)
  // ფინანსები
  m('tariffs', 'finance', [], []),
  m('finance', 'finance', [], ['procurement', 'stock']),
  m('drg', 'finance', ['inpatient', 'tariffs'], ['finance']),
  m('scrubber', 'finance', ['drg'], []),
  // მართვა
  m('reporting', 'management', [], []),
  m('quality', 'management', [], []),
  m('ipc', 'management', ['inpatient'], ['lab_micro']),
  m('roster', 'management', [], []),
  m('worklist', 'management', [], []),
];

export const MODULE_MAP: Record<string, ModuleDef> = Object.fromEntries(MODULES.map((d) => [d.code, d]));
export const CORE_CODES = MODULES.filter((d) => d.core).map((d) => d.code);
export const OPTIONAL_CODES = MODULES.filter((d) => !d.core).map((d) => d.code);
/** ვინ არის დამოკიდებული (მკაცრად) მოცემულ მოდულზე */
export const dependentsOf = (code: string) => MODULES.filter((d) => d.hard.includes(code)).map((d) => d.code);

/**
 * უფლება → მოდული (როლის რედაქტორი მალავს არააქტიური მოდულის უფლებებს; როლიდან არ შლის).
 * მასივი — „რომელიმე“ აქტიურია. არ არის — ბირთვი.
 */
export const CAP_MODULE: Partial<Record<Role, string | string[]>> = {
  pharmacist: 'pharmacy',
  diagnostic: ['lab', 'radiology', 'endoscopy'], lab_doctor: 'lab', lab_manager: 'lab', phlebotomist: 'lab',
  radiographer: 'radiology', radiologist: 'radiology', endoscopist: 'endoscopy', endoscopy_nurse: 'endoscopy',
  storekeeper: 'stock', stock_manager: 'stock',
  or_schedule: 'or', anesthesiologist: 'or', or_nurse: 'or',
  procurement: 'procurement', procurement_approve: 'procurement',
  tariffs: 'tariffs', tariffs_approve: 'tariffs',
  drg: 'drg', drg_admin: 'drg',
  reports: 'reporting', reports_all: 'reporting', reports_phi: 'reporting',
  quality: 'quality', quality_dept: 'quality', quality_view: 'quality',
  infection: 'ipc', infection_dept: 'ipc', infection_view: 'ipc',
  bme_dept: 'bme', bme_view: 'bme',
  roster: 'roster', roster_all: 'roster', roster_view: 'roster', absence_approve: 'roster',
  worklist_manage: 'worklist', worklist_all: 'worklist',
  er_triage: 'er', er_doctor: 'er', er_manage: 'er',
};

/** დიაგნოსტიკის სექცია → მოდული (საერთო controller-ებში დინამიკური შემოწმებისთვის) */
export const SECTION_MODULE: Record<string, string> = { lab: 'lab', radiology: 'radiology', endoscopy: 'endoscopy' };
export const DX_ANY = ['lab', 'radiology', 'endoscopy'];

/** რეესტრის თვითშემოწმება (ტესტი / გაშვება): კავშირები ცნობილ კოდებზე, ციკლი არ არის */
export function validateRegistry(): string[] {
  const errs: string[] = [];
  for (const d of MODULES) {
    for (const x of [...d.hard, ...d.soft, ...(d.settingsOf ? [d.settingsOf] : [])]) if (!MODULE_MAP[x]) errs.push(`${d.code}: უცნობი კავშირი ${x}`);
    if (d.core && d.hard.length) errs.push(`${d.code}: ბირთვს წინაპირობა არ უნდა ჰქონდეს`);
    for (const x of d.hard) if (MODULE_MAP[x]?.core) errs.push(`${d.code}: ბირთვი წინაპირობად ზედმეტია (${x})`);
  }
  const visit = (c: string, path: string[]): void => {
    if (path.includes(c)) { errs.push(`ციკლი: ${[...path, c].join(' → ')}`); return; }
    for (const x of MODULE_MAP[c]?.hard ?? []) visit(x, [...path, c]);
  };
  for (const d of MODULES) visit(d.code, []);
  return errs;
}
