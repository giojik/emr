import type { Transaction } from 'kysely';
import { BadRequestException } from '@nestjs/common';
import type { Database } from '../database/database.module';
import type { DB } from '../database/db';

export interface AddressInput {
  address?: string | null; address_unit_code?: string | null; address_district_code?: string | null;
  address_village?: string | null; address_line?: string | null; address_country?: string | null;
}

/**
 * სტრუქტურირებული მისამართის ვალიდაცია + სრული ტექსტის აწყობა (patients.address — ფორმა 100-სთვის).
 * რაიონი მხოლოდ თბილისისთვის; რაიონი უნდა ეკუთვნოდეს არჩეულ ქალაქს.
 */
export async function composeAddress(db: Database | Transaction<DB>, a: AddressInput): Promise<string | null> {
  if (!a.address_unit_code) {
    if (a.address_district_code) throw new BadRequestException('რაიონი მითითებულია ქალაქის გარეშე');
    return a.address?.trim() || [a.address_country, a.address_line].filter(Boolean).join(', ') || null;
  }
  const codes = [a.address_unit_code, a.address_district_code].filter(Boolean) as string[];
  const units = await db.selectFrom('address_units').select(['code', 'name', 'type', 'parent_code']).where('code', 'in', codes).execute();
  const unit = units.find((u) => u.code === a.address_unit_code);
  if (!unit || unit.type === 'district') throw new BadRequestException('ქალაქი / მუნიციპალიტეტი ვერ მოიძებნა');
  let district: string | null = null;
  if (a.address_district_code) {
    const d = units.find((u) => u.code === a.address_district_code);
    if (!d || d.parent_code !== unit.code) throw new BadRequestException('რაიონი არ ეკუთვნის არჩეულ ქალაქს');
    district = `${d.name} რ-ნი`;
  }
  const place = unit.type === 'municipality' ? `${unit.name}ს მუნიციპალიტეტი` : unit.name;
  const village = a.address_village?.trim() ? `სოფ. ${a.address_village.trim()}` : null;
  return [place, district, village, a.address_line?.trim() || null].filter(Boolean).join(', ');
}
