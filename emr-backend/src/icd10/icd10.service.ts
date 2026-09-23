import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import { InjectDb, type Database } from '../database/database.module';

const COLS = ['c.code', 'c.title', 'c.category', 'c.chapter_id', 'c.is_asterisk', 'c.is_dagger', 'c.needs_review'] as const;
const CODE_LIKE = /^[A-Za-z]\d{0,2}(\.\d{0,2})?$/;

@Injectable()
export class Icd10Service {
  constructor(@InjectDb() private readonly db: Database) {}

  /**
   * ძებნა: "I21" / "i21.0" → კოდის პრეფიქსით; "ინფარქტ მიოკარდ" → ყველა სიტყვა სათაურში (ნებისმიერი თანმიმდევრობით),
   * დალაგება — მსგავსებით. excludeAsterisk: ძირითადი დიაგნოზის ველისთვის.
   */
  async search(raw: string, limit = 20, excludeAsterisk = false) {
    const term = raw.trim().replace(/,/g, '.');
    if (term.length < 2) throw new BadRequestException('მინიმუმ 2 სიმბოლო');

    let q = this.db.selectFrom('icd10_codes as c').select(COLS).where('c.is_active', '=', true);
    if (excludeAsterisk) q = q.where('c.is_asterisk', '=', false);

    if (CODE_LIKE.test(term)) {
      return q.where('c.code', 'like', `${term.toUpperCase()}%`).orderBy('c.code').limit(limit).execute();
    }
    const words = term.split(/\s+/).filter((w) => w.length >= 2).slice(0, 6);
    if (words.length === 0) throw new BadRequestException('მინიმუმ 2 სიმბოლო');
    for (const w of words) q = q.where('c.title', 'ilike', `%${w.replace(/[%_\\]/g, '\\$&')}%`);
    // 1) სათაური იწყება ძიების სიტყვით  2) მოკლე (ზოგადი) სათაურები  3) მსგავსება  4) კოდი
    return q.orderBy(sql`c.title ilike ${words[0] + '%'}`, 'desc')
      .orderBy(sql`length(c.title)`)
      .orderBy(sql`word_similarity(${term}, c.title)`, 'desc')
      .orderBy('c.code').limit(limit).execute();
  }

  async get(code: string) {
    const row = await this.db.selectFrom('icd10_codes as c')
      .leftJoin('icd10_chapters as h', 'h.id', 'c.chapter_id')
      .select([...COLS, 'c.is_active', 'h.title as chapter_title'])
      .where('c.code', '=', code.trim().toUpperCase().replace(',', '.'))
      .executeTakeFirst();
    if (!row) throw new NotFoundException('კოდი კლასიფიკატორში არ არსებობს');
    return row;
  }

  chapters() {
    return this.db.selectFrom('icd10_chapters').selectAll().orderBy('id').execute();
  }
}
