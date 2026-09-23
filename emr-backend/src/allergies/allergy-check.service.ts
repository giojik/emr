import { Injectable } from '@nestjs/common';
import type { Kysely, Transaction } from 'kysely';
import { InjectDb, type Database } from '../database/database.module';
import type { DB } from '../database/db';

export type AlertLevel = 'none' | 'info' | 'warning' | 'warning_reason' | 'block';
const RANK: Record<AlertLevel, number> = { none: 0, info: 1, warning: 2, warning_reason: 3, block: 4 };

export interface AllergyMatch {
  allergy_id: string;
  substance: string;
  severity: string;
  allergy_type: string;
  match: 'direct' | 'cross';
  group: string | null;              // ალერგენული ჯგუფის სახელი (თუ ჯგუფით დაემთხვა)
  level: AlertLevel;
}
export interface AllergyCheckResult {
  level: AlertLevel;
  requires_ack: boolean;             // warning+: ექიმმა უნდა დაადასტუროს, რომ ნახა
  requires_reason: boolean;          // warning_reason / block
  requires_severe_confirmation: boolean;   // block
  matches: AllergyMatch[];
  unreviewed_groups: boolean;        // ჯგუფების სია ჯერ დამტკიცებული არ არის
}

/** ქართული ფუძე: ბოლო "ი"/"ის" მოკვეთა, რომ "პენიცილინი"/"პენიცილინის" ერთნაირად დაემთხვეს */
export function stem(s: string) {
  const t = s.trim().toLowerCase().replace(/\s+/g, ' ');
  if (/[ა-ჰ]$/.test(t) && t.length > 5) return t.replace(/(ის|ი)$/, '');
  return t;
}

/**
 * პოლიტიკა (შეთანხმებული):
 *                       მძიმე                 საშუალო/მსუბუქი        აუტანლობა
 *   პირდაპირი / ჯგუფი   block (მიზეზი+დადასტ.)  warning_reason         info
 *   ჯვარედინი ჯგუფი     warning_reason          warning (დადასტ.)       info
 */
function levelFor(match: 'direct' | 'cross', severity: string, type: string): AlertLevel {
  if (type === 'intolerance') return 'info';
  if (match === 'direct') return severity === 'severe' ? 'block' : 'warning_reason';
  return severity === 'severe' ? 'warning_reason' : 'warning';
}

@Injectable()
export class AllergyCheckService {
  constructor(@InjectDb() private readonly db: Database) {}

  async check(patientId: string, medicationName: string, executor: Kysely<DB> | Transaction<DB> = this.db): Promise<AllergyCheckResult> {
    const drug = medicationName.trim().toLowerCase();
    const [allergies, terms, cross] = await Promise.all([
      executor.selectFrom('patient_allergies').select(['id', 'substance', 'severity', 'allergy_type'])
        .where('patient_id', '=', patientId).where('is_active', '=', true).execute(),
      executor.selectFrom('allergen_group_terms as t').innerJoin('allergen_groups as g', 'g.code', 't.group_code')
        .select(['t.group_code', 't.term', 'g.name', 'g.needs_review']).execute(),
      executor.selectFrom('allergen_cross_reactivity').select(['group_a', 'group_b']).execute(),
    ]);
    const empty: AllergyCheckResult = { level: 'none', requires_ack: false, requires_reason: false, requires_severe_confirmation: false, matches: [], unreviewed_groups: false };
    if (!allergies.length || drug.length < 3) return empty;

    const groupName = new Map(terms.map((t) => [t.group_code, t.name]));
    const groupsOf = (text: string) => new Set(terms.filter((t) => text.includes(String(t.term).toLowerCase())).map((t) => t.group_code));
    const drugGroups = groupsOf(drug);
    const related = (g: string) => cross.filter((c) => c.group_a === g || c.group_b === g).map((c) => (c.group_a === g ? c.group_b : c.group_a));

    const matches: AllergyMatch[] = [];
    let usedUnreviewed = false;
    for (const a of allergies) {
      const sub = stem(a.substance);
      const allergyGroups = groupsOf(a.substance.toLowerCase());
      let match: 'direct' | 'cross' | null = null;
      let group: string | null = null;

      if (sub.length >= 4 && drug.includes(sub)) { match = 'direct'; }
      else {
        const same = [...drugGroups].find((g) => allergyGroups.has(g));
        if (same) { match = 'direct'; group = same; }
        else {
          for (const ag of allergyGroups) {
            const hit = related(ag).find((g) => drugGroups.has(g));
            if (hit) { match = 'cross'; group = hit; break; }
          }
        }
      }
      if (!match) continue;
      if (group && terms.some((t) => t.group_code === group && t.needs_review)) usedUnreviewed = true;
      matches.push({ allergy_id: a.id, substance: a.substance, severity: a.severity, allergy_type: a.allergy_type,
        match, group: group ? groupName.get(group) ?? group : null, level: levelFor(match, a.severity, a.allergy_type) });
    }
    if (!matches.length) return empty;
    const level = matches.reduce<AlertLevel>((m, x) => (RANK[x.level] > RANK[m] ? x.level : m), 'none');
    return {
      level, matches, unreviewed_groups: usedUnreviewed,
      requires_ack: RANK[level] >= RANK.warning,
      requires_reason: RANK[level] >= RANK.warning_reason,
      requires_severe_confirmation: level === 'block',
    };
  }
}
