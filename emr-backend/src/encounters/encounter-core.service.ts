import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { has, type AuthUser } from '../auth/roles';
import { InjectDb, type Database } from '../database/database.module';
import type { DB } from '../database/db';

export type Trx = Transaction<DB>;
type Executor = Database | Trx;

/** ვიზიტის გახსნა (check-in ან walk-in) და საერთო შემოწმებები — გამოიყენება რამდენიმე მოდულიდან */
@Injectable()
export class EncounterCoreService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService) {}

  /**
   * ქმნის ვიზიტს (status=planned) + ინვოისს ექიმის კონსულტაციის ტარიფით.
   * ექიმს ტარიფი თუ არ აქვს — შეცდომა ახლავე (რეგისტრატურაში), არა სალაროსთან.
   */
  async open(trx: Trx, p: { patientId: string; doctorId: string; departmentId?: string | null; chiefComplaint?: string | null }, ctx: AuditContext) {
    const doctor = await trx.selectFrom('users as u')
      .leftJoin('service_tariffs as t', (j) => j.onRef('t.id', '=', 'u.consultation_tariff_id').on('t.is_active', '=', true))
      .select(['u.id', 'u.is_active', 'u.department_id', 'u.first_name', 'u.last_name',
        sql<boolean>`EXISTS (SELECT 1 FROM user_capabilities c WHERE c.user_id = u.id AND 'doctor' = ANY(c.capabilities))`.as('is_doctor'),
        't.id as tariff_id', 't.title as tariff_title', 't.base_price'])
      .where('u.id', '=', p.doctorId).executeTakeFirst();
    if (!doctor || !doctor.is_doctor || !doctor.is_active) throw new BadRequestException('მითითებული ექიმი არ არსებობს ან აქტიური არ არის');
    if (!doctor.tariff_id) {
      throw new BadRequestException(`ექიმს (${doctor.first_name} ${doctor.last_name}) კონსულტაციის ტარიფი არ აქვს მინიჭებული — მიმართეთ ადმინისტრატორს`);
    }
    const departmentId = p.departmentId ?? doctor.department_id;
    if (!departmentId) throw new BadRequestException('ექიმს განყოფილება არ აქვს — მიუთითეთ department_id');

    const patient = await trx.selectFrom('patients').select(['id', 'is_deceased']).where('id', '=', p.patientId).executeTakeFirst();
    if (!patient) throw new NotFoundException('პაციენტი ვერ მოიძებნა');
    if (patient.is_deceased) throw new BadRequestException('პაციენტი გარდაცვლილად არის მონიშნული');

    const encounter = await trx.insertInto('encounters').values({
      patient_id: p.patientId, attending_doctor_id: p.doctorId, department_id: departmentId,
      type: 'outpatient', status: 'planned', chief_complaint: p.chiefComplaint ?? null,
    }).returningAll().executeTakeFirstOrThrow();

    const invoice = await trx.insertInto('invoices').values({
      encounter_id: encounter.id,
      invoice_number: sql<string>`'INV-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('invoice_number_seq')::text, 6, '0')`,
      total_amount: '0', patient_share: '0',
    }).returning(['id', 'invoice_number']).executeTakeFirstOrThrow();

    await trx.insertInto('invoice_line_items').values({
      invoice_id: invoice.id, tariff_id: doctor.tariff_id, description: doctor.tariff_title!,
      quantity: 1, unit_price: doctor.base_price!, original_price: doctor.base_price!,
    }).execute();

    await this.audit.log(ctx, { action: 'OPEN_ENCOUNTER', entityName: 'encounters', entityId: encounter.id,
      newData: { encounter, invoice_number: invoice.invoice_number } }, trx);
    return { encounter, invoice };
  }

  /** ვიზიტის დაბლოკვა ცვლილებისთვის + სტატუსის შემოწმება */
  async lock(trx: Trx, id: string, allowed: readonly string[]) {
    const e = await trx.selectFrom('encounters').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!e) throw new NotFoundException('ვიზიტი ვერ მოიძებნა');
    if (!allowed.includes(e.status)) {
      throw new ConflictException(`ოპერაცია დაუშვებელია ვიზიტის სტატუსზე "${e.status}" (საჭიროა: ${allowed.join(' / ')})`);
    }
    return e;
  }

  /** კლინიკური ჩანაწერი: მხოლოდ მკურნალი ექიმი (ან admin). ექთანს — მხოლოდ allowNurse-ზე (ვიტალები). */
  assertClinicalWriter(e: { attending_doctor_id: string | null }, user: AuthUser, allowNurse = false) {
    if (has(user, 'admin')) return;
    if (allowNurse && has(user, 'nurse')) return;
    if (has(user, 'doctor') && e.attending_doctor_id === user.id) return;
    throw new ForbiddenException('ამ ვიზიტში ჩაწერა შეუძლია მხოლოდ მკურნალ ექიმს');
  }

  invoiceOf(executor: Executor, encounterId: string) {
    return executor.selectFrom('invoices').selectAll().where('encounter_id', '=', encounterId).executeTakeFirst();
  }
}
