import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import { jsonArrayFrom, jsonObjectFrom } from 'kysely/helpers/postgres';
import { AuditService, type AuditContext } from '../audit/audit.service';
import type { AuthUser } from '../auth/roles';
import { dayRange } from '../common/day-range';
import { withPgErrors } from '../common/pg-errors';
import { loadEnv } from '../config/env';
import { InjectDb, type Database } from '../database/database.module';
import type { PayInitialDto, PaymentDto, UpdateClinicalDto, WalkInDto } from './dto/encounters.dto';
import { EncounterCoreService, type Trx } from './encounter-core.service';

export const PAYMENT_ERRORS = { chk_invoice_overpaid: 'გადახდის თანხა აღემატება დარჩენილ დავალიანებას' };

@Injectable()
export class EncountersService {
  private readonly tz = loadEnv().CLINIC_TZ;
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService,
              private readonly core: EncounterCoreService) {}

  /** ღია ვიზიტების სია (რეცეფცია/სალარო/ექიმი) — ინვოისის ჯამებით */
  list(q: { status?: string[]; doctorId?: string; date?: string }) {
    let query = this.db.selectFrom('encounters as e')
      .innerJoin('patients as p', 'p.id', 'e.patient_id')
      .leftJoin('users as d', 'd.id', 'e.attending_doctor_id')
      .leftJoin('invoices as i', 'i.encounter_id', 'e.id')
      .select(['e.id', 'e.status', 'e.type', 'e.start_time', 'e.end_time', 'e.chief_complaint', 'e.department_id',
        'e.patient_id', 'p.first_name as patient_first_name', 'p.last_name as patient_last_name', 'p.personal_number',
        'e.attending_doctor_id', sql<string>`d.first_name || ' ' || d.last_name`.as('doctor_name'),
        'i.invoice_number', 'i.total_amount', 'i.patient_share', 'i.paid_status',
        sql<string>`coalesce((SELECT sum(amount) FROM payments WHERE invoice_id = i.id), 0)`.as('paid_amount')])
      .orderBy('e.start_time', 'desc').limit(200);
    if (q.status?.length) query = query.where('e.status', 'in', q.status as never[]);
    if (q.doctorId) query = query.where('e.attending_doctor_id', '=', q.doctorId);
    if (q.date) {
      const [from, to] = dayRange(q.date, this.tz);
      query = query.where('e.start_time', '>=', from).where('e.start_time', '<', to);
    }
    return query.execute();
  }

  /** ვიზიტის სრული ხედი (Patient 360 ამ ვიზიტისთვის) — ერთი SQL query */
  async detail(id: string, ctx: AuditContext) {
    const e = await this.db.selectFrom('encounters as e')
      .selectAll('e')
      .select((eb) => [
        jsonObjectFrom(eb.selectFrom('patients as p')
          .select(['p.id', 'p.first_name', 'p.last_name', 'p.personal_number', 'p.birth_date', 'p.gender', 'p.phone_number', 'p.blood_group',
            (eb2) => jsonArrayFrom(eb2.selectFrom('patient_allergies as a').select(['a.substance', 'a.reaction_type', 'a.severity'])
              .whereRef('a.patient_id', '=', 'p.id').where('a.is_active', '=', true)).as('allergies'),
            (eb2) => jsonArrayFrom(eb2.selectFrom('patient_chronic_conditions as c').select(['c.icd10_code', 'c.condition_name'])
              .whereRef('c.patient_id', '=', 'p.id').where('c.is_active', '=', true)).as('chronic_conditions')])
          .whereRef('p.id', '=', 'e.patient_id')).as('patient'),
        jsonObjectFrom(eb.selectFrom('users as d').select(['d.id', 'd.first_name', 'd.last_name', 'd.specialty'])
          .whereRef('d.id', '=', 'e.attending_doctor_id')).as('doctor'),
        jsonArrayFrom(eb.selectFrom('encounter_vitals as v').selectAll('v').whereRef('v.encounter_id', '=', 'e.id').orderBy('v.recorded_at')).as('vitals'),
        jsonArrayFrom(eb.selectFrom('encounter_diagnoses as dx').selectAll('dx').whereRef('dx.encounter_id', '=', 'e.id').orderBy('dx.created_at')).as('diagnoses'),
        jsonArrayFrom(eb.selectFrom('prescriptions as rx').selectAll('rx').whereRef('rx.encounter_id', '=', 'e.id').orderBy('rx.created_at')).as('prescriptions'),
        jsonArrayFrom(eb.selectFrom('referrals as r').selectAll('r').whereRef('r.encounter_id', '=', 'e.id').orderBy('r.created_at')).as('referrals'),
        jsonObjectFrom(eb.selectFrom('invoices as i').selectAll('i')
          .select((eb2) => [
            jsonArrayFrom(eb2.selectFrom('invoice_line_items as l').selectAll('l').whereRef('l.invoice_id', '=', 'i.id')).as('lines'),
            jsonArrayFrom(eb2.selectFrom('payments as pm').selectAll('pm').whereRef('pm.invoice_id', '=', 'i.id').orderBy('pm.paid_at')).as('payments'),
          ])
          .whereRef('i.encounter_id', '=', 'e.id')).as('invoice'),
        jsonObjectFrom(eb.selectFrom('encounter_payment_overrides as o').selectAll('o').whereRef('o.encounter_id', '=', 'e.id')).as('payment_override'),
      ])
      .where('e.id', '=', id).executeTakeFirst();
    if (!e) throw new NotFoundException('ვიზიტი ვერ მოიძებნა');
    await this.audit.log(ctx, { action: 'VIEW_ENCOUNTER', entityName: 'encounters', entityId: id });
    return e;
  }

  /** ჩაწერის გარეშე მოსული პაციენტი */
  walkIn(dto: WalkInDto, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const { encounter, invoice } = await this.core.open(trx, {
        patientId: dto.patient_id, doctorId: dto.doctor_id, departmentId: dto.department_id, chiefComplaint: dto.chief_complaint }, ctx);
      return { encounter_id: encounter.id, invoice_id: invoice.id, invoice_number: invoice.invoice_number };
    });
  }

  updateClinical(id: string, dto: UpdateClinicalDto, user: AuthUser, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const old = await this.core.lock(trx, id, ['active']);
      this.core.assertClinicalWriter(old, user);
      if (Object.keys(dto).length === 0) return old;
      const e = await trx.updateTable('encounters').set(dto).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await this.audit.log(ctx, { action: 'UPDATE_CLINICAL_NOTES', entityName: 'encounters', entityId: id,
        oldData: pick(old, Object.keys(dto)), newData: dto }, trx);
      return e;
    });
  }

  /**
   * საწყისი გადახდა: payment + (paid/partially_paid →) planned→active, ერთ ტრანზაქციაში.
   * ინვოისი იბლოკება (FOR UPDATE) — ორი სალაროდან ერთდროული გადახდა ზედმეტ თანხას ვერ ჩაწერს;
   * ზედმეტ გადახდას DB trigger-იც ბლოკავს.
   */
  payInitial(id: string, dto: PayInitialDto | undefined, user: AuthUser, ctx: AuditContext) {
    return withPgErrors(() => this.db.transaction().execute(async (trx) => {
      await this.core.lock(trx, id, ['planned']);
      const inv = await trx.selectFrom('invoices').selectAll().where('encounter_id', '=', id).forUpdate().executeTakeFirst();
      if (!inv) throw new ConflictException('ვიზიტს ინვოისი არ აქვს');

      if (Number(inv.patient_share) > 0) {
        if (!dto?.amount || !dto.method) throw new BadRequestException('მიუთითეთ გადახდის თანხა (amount) და მეთოდი (method)');
        if (dto.method === 'card_terminal' && !dto.terminal_ref) throw new BadRequestException('ბარათით გადახდას სჭირდება terminal_ref');
        await this.insertPayment(trx, inv.id, dto as PaymentDto, user, ctx);
      }
      const after = await trx.selectFrom('invoices').select(['paid_status', 'patient_share']).where('id', '=', inv.id).executeTakeFirstOrThrow();
      if (after.paid_status === 'unpaid') throw new ConflictException('გადახდა არ დაფიქსირდა');
      await this.activate(trx, id, 'payment', ctx);
      return { encounter_id: id, status: 'active', paid_status: after.paid_status };
    }), PAYMENT_ERRORS);
  }

  /** გადახდის გარეშე გააქტიურება — სავალდებულო დასაბუთებით, უფლებამოსილი პირის მიერ */
  paymentOverride(id: string, reason: string, user: AuthUser, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      await this.core.lock(trx, id, ['planned']);
      await trx.insertInto('encounter_payment_overrides').values({ encounter_id: id, reason, approved_by: user.id }).execute();
      await this.activate(trx, id, 'override', ctx);
      await this.audit.log(ctx, { action: 'PAYMENT_OVERRIDE', entityName: 'encounters', entityId: id, newData: { reason } }, trx);
      return { encounter_id: id, status: 'active' };
    });
  }

  cancel(id: string, reason: string, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      await this.core.lock(trx, id, ['planned']);
      const inv = await this.core.invoiceOf(trx, id);
      if (inv && inv.paid_status !== 'unpaid' && Number(inv.patient_share) > 0) throw new ConflictException('ვიზიტზე გადახდა უკვე მიღებულია');
      await trx.updateTable('encounters').set({ status: 'cancelled', end_time: sql`now()` }).where('id', '=', id).execute();
      await trx.updateTable('appointments').set({ status: 'cancelled' }).where('encounter_id', '=', id).execute();
      await this.audit.log(ctx, { action: 'CANCEL_ENCOUNTER', entityName: 'encounters', entityId: id, newData: { reason } }, trx);
      return { encounter_id: id, status: 'cancelled' };
    });
  }

  /**
   * ვიზიტის დახურვა: ძირითადი დიაგნოზი სავალდებულოა; ღია მიმართვები → 409 (admin-ს შეუძლია force).
   * გადაუხდელი ნაშთი დახურვას არ ბლოკავს (კლინიკური დასრულება ≠ ანგარიშსწორება), მაგრამ პასუხში ჩანს.
   */
  discharge(id: string, force: boolean, user: AuthUser, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const e = await this.core.lock(trx, id, ['active']);
      this.core.assertClinicalWriter(e, user);

      const primary = await trx.selectFrom('encounter_diagnoses').select('id')
        .where('encounter_id', '=', id).where('diagnosis_type', '=', 'primary').executeTakeFirst();
      if (!primary) throw new BadRequestException({ code: 'PRIMARY_DIAGNOSIS_REQUIRED', message: 'ძირითადი დიაგნოზი (ICD-10) სავალდებულოა' });

      const open = await trx.selectFrom('referrals').select(['id', 'type', 'status'])
        .where('encounter_id', '=', id).where('status', 'in', ['requested', 'in_progress']).execute();
      if (open.length && !(force && user.role === 'admin')) {
        if (force) throw new ForbiddenException('force დახურვა მხოლოდ ადმინისტრატორს შეუძლია');
        throw new ConflictException({ code: 'OPEN_REFERRALS_EXIST', message: 'ვიზიტს აქვს დაუსრულებელი მიმართვები', referrals: open });
      }

      await trx.updateTable('encounters').set({ status: 'discharged', end_time: sql`now()` }).where('id', '=', id).execute();
      await trx.updateTable('appointments').set({ status: 'completed' }).where('encounter_id', '=', id).execute();
      const inv = await trx.selectFrom('invoices as i')
        .select(['i.patient_share', 'i.paid_status', sql<string>`coalesce((SELECT sum(amount) FROM payments WHERE invoice_id = i.id), 0)`.as('paid')])
        .where('i.encounter_id', '=', id).executeTakeFirst();
      await this.audit.log(ctx, { action: 'DISCHARGE_ENCOUNTER', entityName: 'encounters', entityId: id,
        newData: { forced: open.length > 0, open_referrals: open.map((r) => r.id) } }, trx);
      // TODO(forms): ფორმა №IV-100/ა-ს გენერაცია — documents მოდულთან ერთად
      return {
        encounter_id: id, status: 'discharged',
        balance_due: inv ? (Number(inv.patient_share) - Number(inv.paid)).toFixed(2) : '0.00',
        paid_status: inv?.paid_status ?? null,
      };
    });
  }

  // ---------------------------------------------------------------- helpers
  async insertPayment(trx: Trx, invoiceId: string, dto: PaymentDto, user: AuthUser, ctx: AuditContext) {
    const p = await trx.insertInto('payments').values({
      invoice_id: invoiceId, amount: dto.amount.toFixed(2), method: dto.method,
      terminal_ref: dto.terminal_ref ?? null, received_by: user.id,
    }).returningAll().executeTakeFirstOrThrow();
    await this.audit.log(ctx, { action: 'PAYMENT_RECEIVED', entityName: 'payments', entityId: p.id, newData: p }, trx);
    return p;
  }

  private async activate(trx: Trx, id: string, via: 'payment' | 'override', ctx: AuditContext) {
    await trx.updateTable('encounters').set({ status: 'active' }).where('id', '=', id).execute();
    await this.audit.log(ctx, { action: 'ACTIVATE_ENCOUNTER', entityName: 'encounters', entityId: id, newData: { via } }, trx);
  }
}

function pick<T extends object>(o: T, keys: string[]) {
  return Object.fromEntries(keys.map((k) => [k, (o as Record<string, unknown>)[k]]));
}
