import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import { jsonArrayFrom } from 'kysely/helpers/postgres';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { InjectDb, type Database } from '../database/database.module';
import type { CreatePatientDto, UpdatePatientDto } from './dto/create-patient.dto';
import { composeAddress } from './address';

const LIST_COLUMNS = ['id', 'personal_number', 'passport_number', 'first_name', 'last_name',
  'birth_date', 'gender', 'phone_number', 'is_unknown', 'unknown_no', 'birth_date_estimated'] as const;
const MERGE_ERR: Record<string, string> = {
  MERGE_SAME: 'პაციენტს საკუთარ თავთან ვერ გააერთიანებთ', MERGE_NOT_FOUND: 'პაციენტი ვერ მოიძებნა',
  MERGE_SRC_NOT_UNKNOWN: 'გაერთიანება შესაძლებელია მხოლოდ უცნობი (დაუდასტურებელი) ჩანაწერიდან ნამდვილში',
  MERGE_ALREADY: 'ერთ-ერთი ჩანაწერი უკვე გაერთიანებულია', MERGE_DST_UNKNOWN: 'სამიზნე ჩანაწერიც უცნობია — ჯერ მისი იდენტიფიკაცია',
};
export interface IdentifyInput {
  first_name: string; last_name: string; personal_number?: string | null; passport_number?: string | null; citizenship?: string;
  birth_date: string; gender: 'male' | 'female' | 'other'; phone_number?: string | null;
}

@Injectable()
export class PatientsService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService) {}

  /** ძებნა: პირადი № / პასპორტი / ტელეფონი (ზუსტი), გვარი/სახელი (პრეფიქსი + მიახლოებითი, pg_trgm). */
  async search(q: string) {
    const term = q.trim();
    if (term.length < 2) throw new BadRequestException('ძებნის ტექსტი მინიმუმ 2 სიმბოლო');

    const unk = /^(?:#|უცნობი\s*#?)\s*(\d{1,9})$/i.exec(term);   // 0087: „#17“ / „უცნობი 17“
    return this.db.selectFrom('patients')
      .select(LIST_COLUMNS)
      .where('merged_into_id', 'is', null)   // 0087: გაერთიანებული (უცნობი) ჩანაწერი ძებნაში აღარ ჩანს
      .where((eb) => eb.or([
        ...(unk ? [eb('unknown_no', '=', Number(unk[1]))] : []),
        eb('personal_number', '=', term),
        eb('passport_number', '=', term),
        eb('phone_number', '=', term),
        eb('last_name', 'ilike', `${term}%`),
        eb('first_name', 'ilike', `${term}%`),
        sql<boolean>`last_name % ${term}`,          // fuzzy: "ბერიძე" ≈ "ბერიზე"
      ]))
      .orderBy(sql`similarity(last_name, ${term})`, 'desc')
      .orderBy('last_name').orderBy('first_name')
      .limit(50)
      .execute();
  }

  async create(dto: CreatePatientDto, ctx: AuditContext) {
    if (!dto.personal_number && !dto.passport_number) {
      throw new BadRequestException('საჭიროა პირადი ნომერი ან პასპორტის ნომერი');
    }
    try {
      // პაციენტი და აუდიტ-ჩანაწერი ერთ ტრანზაქციაში
      return await this.db.transaction().execute(async (trx) => {
        const address = await composeAddress(trx, dto);
        const patient = await trx.insertInto('patients').values({ ...dto, address }).returningAll().executeTakeFirstOrThrow();
        await this.audit.log(ctx, { action: 'CREATE_PATIENT', entityName: 'patients', entityId: patient.id, newData: patient }, trx);
        return patient;
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new ConflictException('პაციენტი ამ პირადი ნომრით უკვე არსებობს');
      throw e;
    }
  }

  /** დემოგრაფიის განახლება (აუდიტი ძველი/ახალი მნიშვნელობით) */
  async update(id: string, dto: UpdatePatientDto, ctx: AuditContext) {
    try {
      return await this.db.transaction().execute(async (trx) => {
        const old = await trx.selectFrom('patients').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
        if (!old) throw new NotFoundException('პაციენტი ვერ მოიძებნა');
        const merged = { ...old, ...dto };
        if (!merged.is_unknown && !merged.personal_number && !merged.passport_number) throw new BadRequestException('საჭიროა პირადი ნომერი ან პასპორტის ნომერი');
        if (old.merged_into_id) throw new ConflictException('ჩანაწერი გაერთიანებულია სხვა პაციენტთან — შეცვალეთ ნამდვილი ჩანაწერი');
        const addrTouched = ['address', 'address_unit_code', 'address_district_code', 'address_village', 'address_line', 'address_country'].some((k) => k in dto);
        const address = addrTouched ? await composeAddress(trx, merged) : old.address;
        const p = await trx.updateTable('patients').set({ ...dto, address }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
        const changed = Object.fromEntries(Object.keys({ ...dto, address }).filter((k) => JSON.stringify((old as Record<string, unknown>)[k]) !== JSON.stringify((p as Record<string, unknown>)[k])).map((k) => [k, (p as Record<string, unknown>)[k]]));
        await this.audit.log(ctx, { action: 'UPDATE_PATIENT', entityName: 'patients', entityId: id,
          oldData: Object.fromEntries(Object.keys(changed).map((k) => [k, (old as Record<string, unknown>)[k]])), newData: changed }, trx);
        return p;
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new ConflictException('ამ პირადი ნომრით სხვა პაციენტი უკვე არსებობს');
      throw e;
    }
  }

  addressUnits() {
    return this.db.selectFrom('address_units').select(['code', 'name', 'type', 'parent_code', 'region'])
      .where('is_active', '=', true).orderBy('region').orderBy('name').execute();
  }

  /** სოფლების ავტოშევსება — უკვე რეგისტრირებული პაციენტების მონაცემებიდან ამ მუნიციპალიტეტში */
  async villages(unitCode: string, q: string) {
    const rows = await this.db.selectFrom('patients').select('address_village').distinct()
      .where('address_unit_code', '=', unitCode).where('address_village', 'is not', null)
      .where('address_village', 'ilike', `${q.trim()}%`).orderBy('address_village').limit(15).execute();
    return rows.map((r) => r.address_village);
  }

  /** პაციენტის ბარათი: დემოგრაფია + აქტიური ალერგიები + ქრონიკული დაავადებები — ერთი SQL query. */
  async findOne(id: string, ctx: AuditContext) {
    const patient = await this.db.selectFrom('patients as p')
      .selectAll('p')
      .select((eb) => [
        jsonArrayFrom(eb.selectFrom('patient_allergies as a')
          .select(['a.id', 'a.substance', 'a.reaction_type', 'a.severity', 'a.allergy_type', 'a.created_at'])
          .whereRef('a.patient_id', '=', 'p.id').where('a.is_active', '=', true)
          .orderBy('a.created_at', 'desc')).as('allergies'),
        jsonArrayFrom(eb.selectFrom('patient_chronic_conditions as c')
          .select(['c.id', 'c.icd10_code', 'c.condition_name', 'c.created_at'])
          .whereRef('c.patient_id', '=', 'p.id').where('c.is_active', '=', true)
          .orderBy('c.created_at', 'desc')).as('chronic_conditions'),
      ])
      .where('p.id', '=', id)
      .executeTakeFirst();

    if (!patient) throw new NotFoundException('პაციენტი ვერ მოიძებნა');
    await this.audit.log(ctx, { action: 'VIEW_PATIENT', entityName: 'patients', entityId: id });
    return patient;
  }

  // ---------------------------------------------------------------- 0087: უცნობი პაციენტი — იდენტიფიკაცია / გაერთიანება
  /** იდენტიფიკაცია: უცნობის ჩანაწერი ივსება ნამდვილი მონაცემით (თუ ეს ადამიანი MPI-ში ჯერ არ არის) */
  async identify(id: string, dto: IdentifyInput, userId: string, ctx: AuditContext) {
    if (!dto.personal_number && !dto.passport_number) throw new BadRequestException('საჭიროა პირადი ნომერი ან პასპორტის ნომერი');
    return this.db.transaction().execute(async (trx) => {
      const old = await trx.selectFrom('patients').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!old) throw new NotFoundException('პაციენტი ვერ მოიძებნა');
      if (old.merged_into_id) throw new ConflictException('ჩანაწერი უკვე გაერთიანებულია');
      if (!old.is_unknown) throw new ConflictException('პაციენტი უკვე იდენტიფიცირებულია');
      const dup = await trx.selectFrom('patients').select(['id', 'first_name', 'last_name', 'personal_number', 'passport_number', 'birth_date'])
        .where('id', '<>', id).where('merged_into_id', 'is', null)
        .where((eb) => eb.or([...(dto.personal_number ? [eb('personal_number', '=', dto.personal_number)] : []), ...(dto.passport_number ? [eb('passport_number', '=', dto.passport_number)] : [])]))
        .executeTakeFirst();
      if (dup) throw new ConflictException({ code: 'PATIENT_EXISTS', message: `ეს პაციენტი MPI-ში უკვე არის (${dup.first_name} ${dup.last_name}) — გამოიყენეთ „გაერთიანება“`, patient: dup });
      const set = {
        first_name: dto.first_name.trim(), last_name: dto.last_name.trim(), personal_number: dto.personal_number || null, passport_number: dto.passport_number || null,
        citizenship: dto.citizenship ?? old.citizenship, birth_date: dto.birth_date, gender: dto.gender, phone_number: dto.phone_number?.trim() || old.phone_number,
        is_unknown: false, birth_date_estimated: false, identified_at: sql<string>`now()`, identified_by: userId,
      };
      const p = await trx.updateTable('patients').set(set).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await this.audit.log(ctx, { action: 'PATIENT_IDENTIFY', entityName: 'patients', entityId: id,
        oldData: { first_name: old.first_name, last_name: old.last_name, unknown_no: old.unknown_no, birth_date: old.birth_date, gender: old.gender },
        newData: { first_name: p.first_name, last_name: p.last_name, personal_number: p.personal_number, passport_number: p.passport_number, birth_date: p.birth_date, gender: p.gender } }, trx);
      return p;
    });
  }

  /** რა გადავა გაერთიანებისას: ცხრილი → ჩანაწერების რაოდენობა (patients(id)-ზე მიმავალი ყველა FK) */
  async mergePreview(id: string, targetId: string) {
    const [src, dst] = await Promise.all([this.brief(id), this.brief(targetId)]);
    const fks = await sql<{ tbl: string; col: string }>`
      SELECT c.conrelid::regclass::text AS tbl, a.attname AS col FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
       WHERE c.contype = 'f' AND c.confrelid = 'patients'::regclass AND array_length(c.conkey, 1) = 1 AND c.conrelid <> 'patients'::regclass ORDER BY 1, 2`.execute(this.db);
    const counts: Record<string, number> = {};
    for (const f of fks.rows) {
      const n = (await sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.table(f.tbl)} WHERE ${sql.ref(f.col)} = ${id}::uuid`.execute(this.db)).rows[0].n;
      if (n) counts[f.tbl] = (counts[f.tbl] ?? 0) + n;
    }
    return { source: src, target: dst, counts, problems: this.mergeProblems(src, dst) };
  }
  private brief(id: string) {
    return this.db.selectFrom('patients').select(['id', 'first_name', 'last_name', 'personal_number', 'passport_number', 'birth_date', 'gender', 'is_unknown', 'unknown_no', 'merged_into_id'])
      .where('id', '=', id).executeTakeFirst().then((p) => { if (!p) throw new NotFoundException('პაციენტი ვერ მოიძებნა'); return p; });
  }
  private mergeProblems(src: { id: string; is_unknown: boolean; merged_into_id: string | null }, dst: { id: string; is_unknown: boolean; merged_into_id: string | null }) {
    return [src.id === dst.id && MERGE_ERR.MERGE_SAME, !src.is_unknown && MERGE_ERR.MERGE_SRC_NOT_UNKNOWN, (src.merged_into_id || dst.merged_into_id) && MERGE_ERR.MERGE_ALREADY,
      dst.is_unknown && MERGE_ERR.MERGE_DST_UNKNOWN].filter((x): x is string => !!x);
  }

  /** გაერთიანება: უცნობი (id) → ნამდვილი (targetId), ერთ ტრანზაქციაში (patient_merge); კონფლიქტზე — ყველაფერი ბრუნდება, 409 */
  async merge(id: string, targetId: string, reason: string, userId: string, ctx: AuditContext) {
    try {
      return await this.db.transaction().execute(async (trx) => {
        const r = await sql<{ moved: Record<string, number> }>`SELECT patient_merge(${id}::uuid, ${targetId}::uuid, ${userId}::uuid) AS moved`.execute(trx);
        const moved = r.rows[0].moved ?? {};
        await this.audit.log(ctx, { action: 'PATIENT_MERGE', entityName: 'patients', entityId: id, newData: { merged_into_id: targetId, reason, moved } }, trx);
        await this.audit.log(ctx, { action: 'PATIENT_MERGE_TARGET', entityName: 'patients', entityId: targetId, newData: { merged_from_id: id, reason, moved } }, trx);
        return { merged_into_id: targetId, moved };
      });
    } catch (e) {
      const m = (e as { message?: string }).message ?? '';
      if (m.startsWith('MERGE_CONFLICT:')) {
        const tbl = m.slice('MERGE_CONFLICT:'.length);
        throw new ConflictException({ code: 'MERGE_CONFLICT', message: `გაერთიანება ვერ მოხერხდა — ორივე ჩანაწერს აქვს ერთდროულად შეუთავსებელი მონაცემი (${tbl}). არაფერი შეცვლილა.`, table: tbl });
      }
      if (MERGE_ERR[m]) throw new ConflictException({ code: m, message: MERGE_ERR[m] });
      throw e;
    }
  }
}
