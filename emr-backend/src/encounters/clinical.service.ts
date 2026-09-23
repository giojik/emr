import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import { AuditService, type AuditContext } from '../audit/audit.service';
import type { AuthUser } from '../auth/roles';
import { withPgErrors } from '../common/pg-errors';
import { InjectDb, type Database } from '../database/database.module';
import type { DiagnosisDto, PrescriptionDto, ReferralDto, UpdateReferralDto, VitalsDto } from './dto/encounters.dto';
import { EncounterCoreService } from './encounter-core.service';
import { PAYMENT_ERRORS } from './encounters.service';

const DX_ERRORS = {
  uq_encounter_primary_diagnosis: 'ვიზიტს ძირითადი დიაგნოზი უკვე აქვს — ჯერ წაშალეთ არსებული',
  chk_primary_not_asterisk: '"*" (მანიფესტაციის) კოდი ძირითად დიაგნოზად ვერ გამოიყენება',
  fk_encounter_diagnoses_icd10: 'ICD-10 კოდი კლასიფიკატორში არ არსებობს',
};

/** კლინიკური ჩანაწერები ვიზიტში: ვიტალები, დიაგნოზები, დანიშნულებები, მიმართვები */
@Injectable()
export class ClinicalService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService,
              private readonly core: EncounterCoreService) {}

  addVitals(encounterId: string, dto: VitalsDto, user: AuthUser, ctx: AuditContext) {
    if (Object.values(dto).every((v) => v === undefined)) throw new BadRequestException('მინიმუმ ერთი პარამეტრი');
    if (dto.systolic_bp && dto.diastolic_bp && dto.diastolic_bp >= dto.systolic_bp) {
      throw new BadRequestException('დიასტოლური წნევა სისტოლურზე ნაკლები უნდა იყოს');
    }
    return withPgErrors(() => this.db.transaction().execute(async (trx) => {
      const e = await this.core.lock(trx, encounterId, ['active']);
      this.core.assertClinicalWriter(e, user, true);
      const v = await trx.insertInto('encounter_vitals').values({
        encounter_id: encounterId, taken_by: user.id, ...dto,
        temperature: dto.temperature?.toFixed(1), weight_kg: dto.weight_kg?.toFixed(2), height_cm: dto.height_cm?.toFixed(1),
      }).returningAll().executeTakeFirstOrThrow();
      await this.audit.log(ctx, { action: 'ADD_VITALS', entityName: 'encounter_vitals', entityId: v.id, newData: v }, trx);
      return v;
    }), { chk_vitals_ranges: 'მნიშვნელობა ფიზიოლოგიურ საზღვრებს სცდება — გადაამოწმეთ (მაგ. 1200 ნაცვლად 120?)' });
  }

  addDiagnosis(encounterId: string, dto: DiagnosisDto, user: AuthUser, ctx: AuditContext) {
    return withPgErrors(() => this.db.transaction().execute(async (trx) => {
      const e = await this.core.lock(trx, encounterId, ['active']);
      this.core.assertClinicalWriter(e, user);
      const icd = await trx.selectFrom('icd10_codes').select(['code', 'title', 'is_asterisk', 'is_active'])
        .where('code', '=', dto.icd10_code).executeTakeFirst();
      if (!icd || !icd.is_active) throw new BadRequestException(`ICD-10 კოდი ${dto.icd10_code} კლასიფიკატორში არ არსებობს`);
      const dx = await trx.insertInto('encounter_diagnoses').values({
        encounter_id: encounterId, icd10_code: icd.code, icd10_title: icd.title,   // სათაურის ასლი — ისტორიისთვის
        diagnosis_type: dto.diagnosis_type, comment: dto.comment ?? null, diagnosed_by: user.id,
      }).returningAll().executeTakeFirstOrThrow();
      await this.audit.log(ctx, { action: 'ADD_DIAGNOSIS', entityName: 'encounter_diagnoses', entityId: dx.id, newData: dx }, trx);
      return dx;
    }), DX_ERRORS);
  }

  removeDiagnosis(encounterId: string, dxId: string, user: AuthUser, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const e = await this.core.lock(trx, encounterId, ['active']);
      this.core.assertClinicalWriter(e, user);
      const dx = await trx.deleteFrom('encounter_diagnoses').where('id', '=', dxId).where('encounter_id', '=', encounterId)
        .returningAll().executeTakeFirst();
      if (!dx) throw new NotFoundException('დიაგნოზი ვერ მოიძებნა');
      await this.audit.log(ctx, { action: 'DELETE_DIAGNOSIS', entityName: 'encounter_diagnoses', entityId: dxId, oldData: dx }, trx);
    });
  }

  addPrescription(encounterId: string, dto: PrescriptionDto, user: AuthUser, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const e = await this.core.lock(trx, encounterId, ['active']);
      this.core.assertClinicalWriter(e, user);
      const rx = await trx.insertInto('prescriptions').values({ encounter_id: encounterId, prescribed_by: user.id, ...dto })
        .returningAll().executeTakeFirstOrThrow();
      await this.audit.log(ctx, { action: 'ADD_PRESCRIPTION', entityName: 'prescriptions', entityId: rx.id, newData: rx }, trx);
      return rx;
    });
  }

  removePrescription(encounterId: string, rxId: string, user: AuthUser, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const e = await this.core.lock(trx, encounterId, ['active']);
      this.core.assertClinicalWriter(e, user);
      const rx = await trx.deleteFrom('prescriptions').where('id', '=', rxId).where('encounter_id', '=', encounterId)
        .returningAll().executeTakeFirst();
      if (!rx) throw new NotFoundException('დანიშნულება ვერ მოიძებნა');
      await this.audit.log(ctx, { action: 'DELETE_PRESCRIPTION', entityName: 'prescriptions', entityId: rxId, oldData: rx }, trx);
    });
  }

  // ---------------------------------------------------------------- referrals
  /** მიმართვა + ავტომატური ინვოისის ხაზი referral_type_tariffs-ით (ფასი ფიქსირდება ამ მომენტში) */
  addReferral(encounterId: string, dto: ReferralDto, user: AuthUser, ctx: AuditContext) {
    return withPgErrors(() => this.db.transaction().execute(async (trx) => {
      const e = await this.core.lock(trx, encounterId, ['active']);
      this.core.assertClinicalWriter(e, user);
      const tariff = await trx.selectFrom('referral_type_tariffs as r').innerJoin('service_tariffs as t', 't.id', 'r.tariff_id')
        .select(['t.id', 't.title', 't.base_price', 't.is_active']).where('r.type', '=', dto.type).executeTakeFirst();
      if (!tariff || !tariff.is_active) throw new BadRequestException(`მიმართვის ტიპს "${dto.type}" ტარიფი არ აქვს მინიჭებული — მიმართეთ ადმინისტრატორს`);
      const inv = await trx.selectFrom('invoices').select('id').where('encounter_id', '=', encounterId).forUpdate().executeTakeFirstOrThrow();

      const r = await trx.insertInto('referrals').values({
        encounter_id: encounterId, type: dto.type, target_department_id: dto.target_department_id ?? null,
        reason: dto.reason, requested_by: user.id,
      }).returningAll().executeTakeFirstOrThrow();
      await trx.insertInto('invoice_line_items').values({
        invoice_id: inv.id, tariff_id: tariff.id, referral_id: r.id, description: tariff.title,
        quantity: 1, unit_price: tariff.base_price, original_price: tariff.base_price,
      }).execute();
      await this.audit.log(ctx, { action: 'ADD_REFERRAL', entityName: 'referrals', entityId: r.id, newData: r }, trx);
      return r;
    }), { referrals_target_department_id_fkey: 'განყოფილება არ არსებობს' });
  }

  /** დიაგნოსტიკის სამუშაო სია */
  worklist(statuses: string[], departmentId?: string) {
    let q = this.db.selectFrom('referrals as r')
      .innerJoin('encounters as e', 'e.id', 'r.encounter_id')
      .innerJoin('patients as p', 'p.id', 'e.patient_id')
      .leftJoin('users as u', 'u.id', 'r.requested_by')
      .select(['r.id', 'r.type', 'r.status', 'r.reason', 'r.created_at', 'r.target_department_id', 'r.encounter_id',
        'p.first_name as patient_first_name', 'p.last_name as patient_last_name', 'p.personal_number', 'p.birth_date',
        sql<string>`u.first_name || ' ' || u.last_name`.as('requested_by_name')])
      .where('r.status', 'in', statuses as never[])
      .orderBy('r.created_at').limit(500);
    if (departmentId) q = q.where('r.target_department_id', '=', departmentId);
    return q.execute();
  }

  /**
   * სტატუსის ცვლა: in_progress/completed — დიაგნოსტიკა/admin (შედეგი სავალდებულოა);
   * cancelled — მკურნალი ექიმი/admin, მხოლოდ 'requested'-დან; ინვოისის ხაზი იშლება.
   */
  updateReferral(id: string, dto: UpdateReferralDto, user: AuthUser, ctx: AuditContext) {
    return withPgErrors(() => this.db.transaction().execute(async (trx) => {
      const r = await trx.selectFrom('referrals').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!r) throw new NotFoundException('მიმართვა ვერ მოიძებნა');
      const e = await trx.selectFrom('encounters').select(['status', 'attending_doctor_id']).where('id', '=', r.encounter_id).executeTakeFirstOrThrow();
      if (e.status === 'cancelled') throw new ConflictException('ვიზიტი გაუქმებულია');

      const allowed: Record<string, string[]> = { requested: ['in_progress', 'completed', 'cancelled'], in_progress: ['completed'] };
      if (!allowed[r.status]?.includes(dto.status)) throw new ConflictException(`გადასვლა "${r.status}" → "${dto.status}" დაუშვებელია`);

      if (dto.status === 'cancelled') {
        if (e.status !== 'active') throw new ConflictException('გაუქმება შესაძლებელია მხოლოდ აქტიურ ვიზიტზე');
        if (!(user.role === 'admin' || (user.role === 'doctor' && e.attending_doctor_id === user.id))) {
          throw new ForbiddenException('მიმართვის გაუქმება შეუძლია მკურნალ ექიმს');
        }
        await trx.deleteFrom('invoice_line_items').where('referral_id', '=', id).execute();   // trigger: ინვოისის გადათვლა
      } else {
        if (!['diagnostic', 'admin'].includes(user.role)) throw new ForbiddenException('შედეგის შეტანა შეუძლია დიაგნოსტიკის პერსონალს');
        if (dto.status === 'completed' && !dto.result_text?.trim()) throw new BadRequestException('დასრულებას სჭირდება შედეგი (result_text)');
      }

      const updated = await trx.updateTable('referrals').set({
        status: dto.status,
        ...(dto.result_text !== undefined ? { result_text: dto.result_text } : {}),
        ...(dto.status === 'completed' ? { completed_at: sql`now()` } : {}),
      }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await this.audit.log(ctx, { action: `REFERRAL_${dto.status.toUpperCase()}`, entityName: 'referrals', entityId: id,
        oldData: { status: r.status }, newData: { status: dto.status } }, trx);
      return updated;
    }), { ...PAYMENT_ERRORS, chk_invoice_overpaid: 'მიმართვა უკვე გადახდილია — გაუქმებამდე საჭიროა თანხის დაბრუნება' });
  }
}
