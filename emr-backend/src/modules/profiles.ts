import { MODULE_MAP, OPTIONAL_CODES } from './registry';

/**
 * მოდულების პროფილები (0086, I / J) — მზა ნაკრები კლინიკის ტიპისთვის; ერთი დაჭერით ირთვება, მერე ცალ-ცალკე ზუსტდება.
 * ინახება კოდში (git), არა ბაზაში. იგივე სიას იყენებს CLI (`license sign --modules profile:…`) და ლიცენზიების მენეჯერი
 * (catalog.ts აკოპირებს; compat-check ამოწმებს თანხვედრას). ყველა პროფილი აკმაყოფილებს რეესტრის მკაცრ წინაპირობებს (validateProfiles).
 */
export interface ModuleProfile { code: string; name: string; description: string; modules: string[] }

/** 0087-დან — `er` (გადაუდებელი); გეგმიურ სტაციონარში არ შედის */
const NOT_ELECTIVE = ['er'];

export const PROFILES: ModuleProfile[] = [
  {
    code: 'outpatient_lab', name: 'ამბულატორია + ლაბორატორია',
    description: 'მინიმალური სამუშაო ნაკრები: ამბულატორია, ლაბორატორია (ანალიზატორები, QC, გარე ლაბ., ლაბ. მარაგი), საწყობი, ტარიფები, ფინანსები, რეპორტინგი, სამუშაო სიები, ხარისხი. '
      + 'რადიოლოგია / ენდოსკოპია / აფთიაქი / შესყიდვები — ადმინი ამატებს ცალ-ცალკე.',
    modules: ['outpatient', 'lab', 'lab_gateway', 'lab_qc', 'lab_external', 'lab_stock', 'stock', 'tariffs', 'finance', 'reporting', 'worklist', 'quality'],
  },
  {
    code: 'elective_inpatient', name: 'გეგმიური სტაციონარი',
    description: 'ყველა მოდული, გადაუდებელი დახმარების (ER) გარდა — გეგმიური სტაციონარი ამბულატორიით, დიაგნოსტიკით, საოპერაციოთი, რეანიმაციით.',
    modules: OPTIONAL_CODES.filter((c) => !NOT_ELECTIVE.includes(c)),
  },
  {
    code: 'multi', name: 'მრავალპროფილიანი',
    description: 'ყველა მოდული (0087-დან — ER-ის ჩათვლით).',
    modules: [...OPTIONAL_CODES],
  },
];
export const PROFILE_MAP: Record<string, ModuleProfile> = Object.fromEntries(PROFILES.map((p) => [p.code, p]));

/** პროფილის თვითშემოწმება: ცნობილი კოდები, მკაცრი წინაპირობები შიგნითაა (ბირთვის გარდა) */
export function validateProfiles(): string[] {
  const errs: string[] = [];
  for (const p of PROFILES) {
    for (const c of p.modules) {
      const d = MODULE_MAP[c];
      if (!d) { errs.push(`პროფილი ${p.code}: უცნობი მოდული ${c}`); continue; }
      if (d.core) errs.push(`პროფილი ${p.code}: ბირთვი (${c}) პროფილში ზედმეტია`);
      for (const h of d.hard) if (!MODULE_MAP[h]?.core && !p.modules.includes(h)) errs.push(`პროფილი ${p.code}: ${c} საჭიროებს ${h}`);
    }
  }
  return errs;
}

/**
 * CLI / მენეჯერი: `all` | `a,b` | `profile:outpatient_lab[,radiology,…]` → კოდების სია (უნიკალური, რეესტრის რიგით; უცნობი — ბოლოში).
 * პროფილი + დამატებითი კოდები; დამატებითის მკაცრი წინაპირობები ავტომატურად არ ემატება — გამომძახებელი აფრთხილებს (missingPrereqs).
 */
export function expandModules(spec: string): string[] {
  const s = spec.trim();
  if (s === 'all') return [...OPTIONAL_CODES];
  const parts = s.split(',').map((x) => x.trim()).filter(Boolean);
  const out: string[] = [];
  for (const x of parts) {
    if (x.startsWith('profile:')) {
      const p = PROFILE_MAP[x.slice(8)];
      if (!p) throw new Error(`უცნობი პროფილი: ${x.slice(8)} (${PROFILES.map((q) => q.code).join(' / ')})`);
      out.push(...p.modules);
    } else out.push(x);
  }
  const uniq = [...new Set(out)];
  return [...OPTIONAL_CODES.filter((c) => uniq.includes(c)), ...uniq.filter((c) => !OPTIONAL_CODES.includes(c))];
}
/** ნაკრებში აკლია მკაცრი წინაპირობა → [მოდული, წინაპირობა][] */
export function missingPrereqs(codes: string[]): [string, string][] {
  const out: [string, string][] = [];
  for (const c of codes) for (const h of MODULE_MAP[c]?.hard ?? []) if (!MODULE_MAP[h]?.core && !codes.includes(h)) out.push([c, h]);
  return out;
}
