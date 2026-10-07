import { z } from 'zod';

/**
 * დოკუმენტის შაბლონი (0041) = ბლოკების სია. ტექსტში ცვლადი — {{group.key}} (მხოლოდ კატალოგიდან).
 * ბლოკების ნაკრები დამოკიდებულია შაბლონის სახეობაზე (kind); ვალიდაცია — გამოქვეყნებისას (და draft-ის შენახვისას — გაფრთხილებად).
 */
export const KINDS = ['consent', 'refusal', 'epicrisis', 'other'] as const;
export type Kind = (typeof KINDS)[number];

const text = z.string().max(20_000);
const label = z.string().trim().min(2).max(200);

export const BlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('header') }),                                                     // დაწესებულება + № + QR
  z.object({ type: z.literal('heading'), text: z.string().trim().min(1).max(300) }),
  z.object({ type: z.literal('text'), text }),
  z.object({ type: z.literal('patient') }),                                                    // პაციენტის რეკვიზიტები
  z.object({ type: z.literal('diagnoses'), which: z.enum(['final', 'admission']), label }),
  z.object({ type: z.literal('field'), key: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/), label, required: z.boolean().default(false),
    prefill: z.string().max(2000).optional() }),                                               // ექიმის მიერ შესავსები სექცია
  z.object({ type: z.literal('lab_results'), label }),
  z.object({ type: z.literal('dx_results'), label }),
  z.object({ type: z.literal('signatures'), signers: z.array(z.enum(['attending', 'department_head', 'patient'])).min(1).max(3) }),
]);
export type Block = z.infer<typeof BlockSchema>;
export const BodySchema = z.object({ blocks: z.array(BlockSchema).min(1).max(80) });
export type Body = z.infer<typeof BodySchema>;

const ALLOWED: Record<Kind, Block['type'][]> = {
  consent:   ['heading', 'text'],
  refusal:   ['heading', 'text'],
  other:     ['header', 'heading', 'text', 'patient', 'signatures'],
  epicrisis: ['header', 'heading', 'text', 'patient', 'diagnoses', 'field', 'lab_results', 'dx_results', 'signatures'],
};

/** ცვლადების კატალოგი: გასაღები → აღწერა + ნიმუში (preview). მნიშვნელობებს ავსებს TemplateContextService. */
export const VARIABLES: Record<string, { label: string; sample: string }> = {
  'patient.full_name':       { label: 'პაციენტი — სახელი, გვარი', sample: 'ნინო ბერიძე' },
  'patient.first_name':      { label: 'პაციენტი — სახელი', sample: 'ნინო' },
  'patient.last_name':       { label: 'პაციენტი — გვარი', sample: 'ბერიძე' },
  'patient.birth_date':      { label: 'პაციენტი — დაბადების თარიღი', sample: '14/03/1978' },
  'patient.age':             { label: 'პაციენტი — ასაკი', sample: '48' },
  'patient.gender':          { label: 'პაციენტი — სქესი', sample: 'მდედრობითი' },
  'patient.personal_number': { label: 'პაციენტი — პირადი №', sample: '01001012345' },
  'patient.id_number':       { label: 'პაციენტი — პირადი № ან პასპორტი', sample: '01001012345' },
  'patient.address':         { label: 'პაციენტი — მისამართი', sample: 'თბილისი, ვაკე, ჭავჭავაძის გამზ. 10' },
  'patient.phone':           { label: 'პაციენტი — ტელეფონი', sample: '555 12 34 56' },
  'clinic.name':             { label: 'კლინიკა — დასახელება', sample: 'ინოვა მედიკალი' },
  'clinic.address':          { label: 'კლინიკა — მისამართი', sample: 'თბილისი' },
  'clinic.phone':            { label: 'კლინიკა — ტელეფონი', sample: '032 2 00 00 00' },
  'clinic.director':         { label: 'კლინიკა — დირექტორი', sample: 'გ. გიორგაძე' },
  'encounter.date':          { label: 'ვიზიტის თარიღი', sample: '06/10/2026' },
  'stay.adm_no':             { label: 'ჰოსპიტალიზაციის №', sample: 'IP26-000123' },
  'stay.department':         { label: 'განყოფილება (მიმდინარე / ბოლო)', sample: 'თერაპიის განყოფილება' },
  'stay.ward':               { label: 'პალატა', sample: '301' },
  'stay.bed':                { label: 'საწოლი', sample: '301-2' },
  'stay.attending_doctor':   { label: 'მკურნალი ექიმი', sample: 'ლ. კაპანაძე' },
  'stay.admitted_at':        { label: 'ჰოსპიტალიზაციის თარიღი და დრო', sample: '01/10/2026 14:20' },
  'stay.discharged_at':      { label: 'გაწერის თარიღი და დრო', sample: '06/10/2026 12:00' },
  'stay.discharge_type':     { label: 'გაწერის ტიპი', sample: 'ბინაზე' },
  'stay.bed_days':           { label: 'საწოლდღეები', sample: '5' },
  'doc.date':                { label: 'დოკუმენტის თარიღი (დღეს)', sample: '06/10/2026' },
  'user.name':               { label: 'თანამშრომელი (ვინც ბეჭდავს)', sample: 'მ. ნოზაძე' },
};
export const VARIABLE_KEYS = new Set(Object.keys(VARIABLES));

const VAR_RE = /\{\{\s*([a-z_]+\.[a-z_]+)\s*\}\}/g;

/** ტექსტში ნახსენები ცვლადები + სინტაქსის შეცდომები ({{ დახურვის გარეშე და ა.შ.) */
export function scanText(s: string): { vars: string[]; broken: boolean } {
  const vars = [...s.matchAll(VAR_RE)].map((m) => m[1]);
  const rest = s.replace(VAR_RE, '');
  return { vars, broken: rest.includes('{{') || rest.includes('}}') };
}

export function fillText(s: string, vals: Record<string, string | null | undefined>): string {
  return s.replace(VAR_RE, (_, k: string) => vals[k]?.trim() || '—');
}

/** სრული ვალიდაცია; ცარიელი მასივი = OK */
/** structural = ბლოკის სქემა ან სახეობისთვის დაუშვებელი ბლოკი (draft-იც არ ინახება); errors — ყველა (გამოქვეყნებას ბლოკავს) */
export function validateBody(kind: Kind, raw: unknown): { body: Body | null; errors: string[]; structural: string[] } {
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    const e = parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.') || 'body'}: ${i.message}`);
    return { body: null, errors: e, structural: e };
  }
  const body = parsed.data;
  const errors: string[] = [];
  const structural: string[] = [];
  const keys = new Set<string>();
  body.blocks.forEach((b, i) => {
    const n = `ბლოკი ${i + 1}`;
    if (!ALLOWED[kind].includes(b.type)) structural.push(`${n}: ბლოკის ტიპი „${b.type}“ ამ დოკუმენტში დაუშვებელია`);
    const texts = b.type === 'text' || b.type === 'heading' ? [b.text] : b.type === 'field' && b.prefill ? [b.prefill] : [];
    for (const t of texts) {
      const s = scanText(t);
      if (s.broken) errors.push(`${n}: ცვლადის სინტაქსი — {{group.key}}`);
      for (const v of s.vars) if (!VARIABLE_KEYS.has(v)) errors.push(`${n}: უცნობი ცვლადი {{${v}}}`);
    }
    if (b.type === 'field') {
      if (keys.has(b.key)) errors.push(`${n}: ველის გასაღები „${b.key}“ მეორდება`);
      keys.add(b.key);
    }
  });
  if (kind === 'epicrisis') {
    if (!body.blocks.some((b) => b.type === 'diagnoses' && b.which === 'final')) errors.push('ეპიკრიზს სჭირდება საბოლოო დიაგნოზის ბლოკი');
    if (!body.blocks.some((b) => b.type === 'field')) errors.push('ეპიკრიზს სჭირდება მინიმუმ ერთი შესავსები სექცია (field)');
    if (!body.blocks.some((b) => b.type === 'signatures' && b.signers.includes('attending'))) errors.push('ეპიკრიზს სჭირდება მკურნალი ექიმის ხელმოწერა');
  }
  if ((kind === 'consent' || kind === 'refusal') && !body.blocks.some((b) => b.type === 'text' && b.text.trim().length >= 20)) {
    errors.push('ტექსტი მინიმუმ 20 სიმბოლო');
  }
  return { body, errors: [...structural, ...errors], structural };
}

/** თანხმობის / ხელწერილის სხეული → ერთიანი ტექსტი (PDF რენდერი, ძველი API-ის body_text) */
export function plainText(body: Body, vals?: Record<string, string | null | undefined>): string {
  return body.blocks.map((b) => (b.type === 'heading' || b.type === 'text' ? (vals ? fillText(b.text, vals) : b.text) : '')).filter((s) => s.trim()).join('\n\n');
}

export const SAMPLE_VARS: Record<string, string> = Object.fromEntries(Object.entries(VARIABLES).map(([k, v]) => [k, v.sample]));
