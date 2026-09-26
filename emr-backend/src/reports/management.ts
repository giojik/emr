import { BadRequestException, Body, ConflictException, Controller, Get, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { IsBoolean, IsIn, IsNumber, IsOptional, IsString, IsUUID, Length, Matches, MaxLength, Min } from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/roles';
import { dayRange } from '../common/day-range';
import { loadEnv } from '../config/env';
import { InjectDb, type Database } from '../database/database.module';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const n = (v: unknown) => Number(v ?? 0);

class ExpenseDto {
  @Matches(DATE) expense_date: string;
  @IsString() @Length(2, 100) category: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string | null;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) amount: number;
  @IsOptional() @IsIn(['cash', 'card', 'bank_transfer']) payment_method?: 'cash' | 'card' | 'bank_transfer';
  @IsOptional() @IsString() @MaxLength(200) supplier?: string | null;
  @IsOptional() @IsString() @MaxLength(100) doc_number?: string | null;
  @IsOptional() @IsUUID() department_id?: string | null;
}
class ExpenseUpdateDto {
  @IsOptional() @Matches(DATE) expense_date?: string;
  @IsOptional() @IsString() @Length(2, 100) category?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string | null;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) amount?: number;
  @IsOptional() @IsIn(['cash', 'card', 'bank_transfer']) payment_method?: 'cash' | 'card' | 'bank_transfer';
  @IsOptional() @IsString() @MaxLength(200) supplier?: string | null;
  @IsOptional() @IsString() @MaxLength(100) doc_number?: string | null;
  @IsOptional() @IsUUID() department_id?: string | null;
  @IsOptional() @IsBoolean() void?: boolean;
  @IsOptional() @IsString() @Length(5, 500) void_reason?: string;
}

/** შემოსავლის კატეგორია ინვოისის ხაზიდან */
const CATEGORY = sql<string>`CASE
  WHEN l.dx_order_item_id IS NOT NULL THEN (SELECT d.section FROM dx_order_items d WHERE d.id = l.dx_order_item_id)
  WHEN l.referral_id IS NOT NULL THEN 'referral'
  ELSE 'consultation' END`;

@Injectable()
export class ManagementReportsService {
  private readonly tz = loadEnv().CLINIC_TZ;
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService) {}

  private range(from: string, to: string) {
    if (!DATE.test(from) || !DATE.test(to) || from > to) throw new BadRequestException('პერიოდი: from ≤ to (YYYY-MM-DD)');
    return [dayRange(from, this.tz)[0], dayRange(to, this.tz)[1]] as const;
  }

  /**
   * ფინანსური რეპორტი: გადახდები (კასა — მეთოდით/დღეებით), გაწეული მომსახურება (ინვოისები — კატეგორიით/ექიმით),
   * ფასდაკლებები, დაზღვევა/სახელმწიფოს წილი, დავალიანება, ხარჯები, სალდო.
   */
  async finance(from: string, to: string) {
    const [a, b] = this.range(from, to);
    const day = sql<string>`to_char(p.paid_at AT TIME ZONE ${this.tz}, 'YYYY-MM-DD')`;
    const [byMethod, byDay, byCategory, byDoctor, discounts, shares, outstanding, expenses] = await Promise.all([
      this.db.selectFrom('payments as p').select(['p.method', sql<string>`sum(p.amount)`.as('amount'), sql<number>`count(*)::int`.as('count')])
        .where('p.paid_at', '>=', a).where('p.paid_at', '<', b).groupBy('p.method').execute(),
      this.db.selectFrom('payments as p').select([day.as('day'), sql<string>`sum(p.amount)`.as('amount')])
        .where('p.paid_at', '>=', a).where('p.paid_at', '<', b).groupBy(sql`1`).orderBy(sql`1`).execute(),   // parameter-იანი გამოსახულება — პოზიციით
      this.db.selectFrom('invoice_line_items as l').innerJoin('invoices as i', 'i.id', 'l.invoice_id').innerJoin('encounters as e', 'e.id', 'i.encounter_id')
        .select([CATEGORY.as('category'), sql<string>`sum(l.line_total)`.as('amount'), sql<number>`sum(l.quantity)::int`.as('count')])
        .where('i.created_at', '>=', a).where('i.created_at', '<', b).where('e.status', '<>', 'cancelled').groupBy(CATEGORY).execute(),
      this.db.selectFrom('invoice_line_items as l').innerJoin('invoices as i', 'i.id', 'l.invoice_id').innerJoin('encounters as e', 'e.id', 'i.encounter_id')
        .leftJoin('users as u', 'u.id', 'e.attending_doctor_id')
        .select([sql<string>`coalesce(u.last_name || ' ' || u.first_name, 'ექიმის გარეშე')`.as('doctor'), sql<string>`sum(l.line_total)`.as('amount'),
          sql<number>`count(DISTINCT e.id)::int`.as('visits')])
        .where('i.created_at', '>=', a).where('i.created_at', '<', b).where('e.status', '<>', 'cancelled')
        .groupBy(sql`coalesce(u.last_name || ' ' || u.first_name, 'ექიმის გარეშე')`).orderBy(sql`sum(l.line_total)`, 'desc').execute(),
      this.db.selectFrom('invoice_line_items as l').innerJoin('invoices as i', 'i.id', 'l.invoice_id')
        .select([sql<string>`coalesce(sum((l.original_price - l.unit_price) * l.quantity), 0)`.as('amount'), sql<number>`count(*)::int`.as('count')])
        .where('i.created_at', '>=', a).where('i.created_at', '<', b).where('l.original_price', 'is not', null).whereRef('l.unit_price', '<', 'l.original_price')
        .executeTakeFirstOrThrow(),
      this.db.selectFrom('invoices as i').innerJoin('encounters as e', 'e.id', 'i.encounter_id')
        .select([sql<string>`coalesce(sum(i.total_amount), 0)`.as('total'), sql<string>`coalesce(sum(i.patient_share), 0)`.as('patient'),
          sql<string>`coalesce(sum(i.insurance_share), 0)`.as('insurance'), sql<string>`coalesce(sum(i.state_share), 0)`.as('state')])
        .where('i.created_at', '>=', a).where('i.created_at', '<', b).where('e.status', '<>', 'cancelled').executeTakeFirstOrThrow(),
      // დავალიანება: პერიოდის ინვოისები, სადაც გადახდილი < პაციენტის წილი
      this.db.selectFrom('invoices as i').innerJoin('encounters as e', 'e.id', 'i.encounter_id').innerJoin('patients as pt', 'pt.id', 'e.patient_id')
        .select(['i.id', 'i.invoice_number', 'i.created_at', 'i.patient_share', 'pt.first_name', 'pt.last_name', 'pt.personal_number',
          sql<string>`coalesce((SELECT sum(p.amount) FROM payments p WHERE p.invoice_id = i.id), 0)`.as('paid')])
        .where('i.created_at', '>=', a).where('i.created_at', '<', b).where('e.status', '<>', 'cancelled').where('i.paid_status', '<>', 'paid')
        .where('i.patient_share', '>', '0').orderBy('i.created_at').limit(500).execute(),
      this.db.selectFrom('expenses').select(['category', sql<string>`sum(amount)`.as('amount'), sql<number>`count(*)::int`.as('count')])
        .where('is_void', '=', false).where('expense_date', '>=', from).where('expense_date', '<=', to).groupBy('category').orderBy(sql`sum(amount)`, 'desc').execute(),
    ]);
    const paid = byMethod.reduce((s, r) => s + n(r.amount), 0);
    const spent = expenses.reduce((s, r) => s + n(r.amount), 0);
    return {
      from, to,
      totals: {
        payments: paid.toFixed(2), services: n(shares.total).toFixed(2), patient_share: n(shares.patient).toFixed(2), insurance_share: n(shares.insurance).toFixed(2),
        state_share: n(shares.state).toFixed(2), discounts: n(discounts.amount).toFixed(2), discount_lines: discounts.count,
        outstanding: outstanding.reduce((s, r) => s + n(r.patient_share) - n(r.paid), 0).toFixed(2), expenses: spent.toFixed(2), net: (paid - spent).toFixed(2),
      },
      by_method: byMethod, by_day: byDay, by_category: byCategory, by_doctor: byDoctor, outstanding, expenses_by_category: expenses,
    };
  }

  /** აქტივობა: ვიზიტები, ახალი პაციენტები, ჩაწერები (მოვიდა / არ გამოცხადდა), დიაგნოსტიკა, განყოფილებები/ექიმები */
  async activity(from: string, to: string, departmentId?: string) {
    const [a, b] = this.range(from, to);
    const enc = () => {
      let q = this.db.selectFrom('encounters as e').where('e.start_time', '>=', a).where('e.start_time', '<', b);
      if (departmentId) q = q.where('e.department_id', '=', departmentId);
      return q;
    };
    const [visits, byDept, byDoctor, newPatients, appts, dx] = await Promise.all([
      enc().select(['e.visit_kind', 'e.status', sql<number>`count(*)::int`.as('count')]).groupBy(['e.visit_kind', 'e.status']).execute(),
      enc().innerJoin('departments as d', 'd.id', 'e.department_id').select(['d.name', sql<number>`count(*)::int`.as('count')])
        .where('e.status', '<>', 'cancelled').groupBy('d.name').orderBy(sql`count(*)`, 'desc').execute(),
      enc().innerJoin('users as u', 'u.id', 'e.attending_doctor_id').select([sql<string>`u.last_name || ' ' || u.first_name`.as('doctor'), sql<number>`count(*)::int`.as('count')])
        .where('e.status', '<>', 'cancelled').groupBy(sql`u.last_name || ' ' || u.first_name`).orderBy(sql`count(*)`, 'desc').execute(),
      this.db.selectFrom('patients').select(sql<number>`count(*)::int`.as('count')).where('created_at', '>=', a).where('created_at', '<', b).executeTakeFirstOrThrow(),
      (() => {
        let q = this.db.selectFrom('appointments as ap').select(['ap.status', sql<number>`count(*)::int`.as('count')])
          .where('ap.scheduled_start', '>=', a).where('ap.scheduled_start', '<', b);
        if (departmentId) q = q.where('ap.department_id', '=', departmentId);
        return q.groupBy('ap.status').execute();
      })(),
      this.db.selectFrom('dx_order_items as i').select(['i.section', 'i.status', sql<number>`count(*)::int`.as('count')])
        .where('i.ordered_at', '>=', a).where('i.ordered_at', '<', b).groupBy(['i.section', 'i.status']).execute(),
    ]);
    return { from, to, department_id: departmentId ?? null, visits, by_department: byDept, by_doctor: byDoctor, new_patients: newPatients.count, appointments: appts, diagnostics: dx };
  }

  // =============================================================== ხარჯები
  expenses(from: string, to: string, includeVoid: boolean) {
    this.range(from, to);
    let q = this.db.selectFrom('expenses as x').leftJoin('users as u', 'u.id', 'x.created_by').leftJoin('departments as d', 'd.id', 'x.department_id')
      .selectAll('x').select([sql<string>`u.first_name || ' ' || u.last_name`.as('created_by_name'), 'd.name as department_name'])
      .where('x.expense_date', '>=', from).where('x.expense_date', '<=', to).orderBy('x.expense_date', 'desc').orderBy('x.created_at', 'desc');
    if (!includeVoid) q = q.where('x.is_void', '=', false);
    return q.limit(2000).execute();
  }

  async categories() {
    const rows = await this.db.selectFrom('expenses').select('category').distinct().orderBy('category').execute();
    const base = ['ხელფასი', 'კომუნალური', 'იჯარა', 'სახარჯი მასალა', 'მედიკამენტები', 'აპარატურის მომსახურება', 'გარე ლაბორატორია', 'გადასახადები', 'სხვა'];
    return [...new Set([...base, ...rows.map((r) => r.category)])];
  }

  async createExpense(dto: ExpenseDto, user: AuthUser, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx.insertInto('expenses').values({
        expense_date: dto.expense_date, category: dto.category.trim(), description: dto.description?.trim() || null, amount: dto.amount.toFixed(2),
        payment_method: dto.payment_method ?? 'bank_transfer', supplier: dto.supplier?.trim() || null, doc_number: dto.doc_number?.trim() || null,
        department_id: dto.department_id ?? null, created_by: user.id,
      }).returningAll().executeTakeFirstOrThrow();
      await this.audit.log(ctx, { action: 'CREATE_EXPENSE', entityName: 'expenses', entityId: row.id, newData: dto }, trx);
      return row;
    });
  }

  async updateExpense(id: string, dto: ExpenseUpdateDto, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const old = await trx.selectFrom('expenses').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!old) throw new NotFoundException('ჩანაწერი ვერ მოიძებნა');
      if (old.is_void) throw new ConflictException('გაუქმებული ჩანაწერი არ იცვლება');
      if (dto.void && !dto.void_reason) throw new BadRequestException('მიუთითეთ გაუქმების მიზეზი');
      const set = {
        ...(dto.expense_date !== undefined && { expense_date: dto.expense_date }), ...(dto.category !== undefined && { category: dto.category.trim() }),
        ...(dto.description !== undefined && { description: dto.description?.trim() || null }), ...(dto.amount !== undefined && { amount: dto.amount.toFixed(2) }),
        ...(dto.payment_method !== undefined && { payment_method: dto.payment_method }), ...(dto.supplier !== undefined && { supplier: dto.supplier?.trim() || null }),
        ...(dto.doc_number !== undefined && { doc_number: dto.doc_number?.trim() || null }), ...(dto.department_id !== undefined && { department_id: dto.department_id }),
        ...(dto.void && { is_void: true, void_reason: dto.void_reason }),
      };
      const row = await trx.updateTable('expenses').set(set).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await this.audit.log(ctx, { action: dto.void ? 'VOID_EXPENSE' : 'UPDATE_EXPENSE', entityName: 'expenses', entityId: id, oldData: old, newData: set }, trx);
      return row;
    });
  }
}

const q2 = (from?: string, to?: string) => {
  if (!from || !to) throw new BadRequestException('from და to სავალდებულოა');
  return [from, to] as const;
};

@Controller()
export class ManagementReportsController {
  constructor(private readonly svc: ManagementReportsService, @InjectDb() private readonly db: Database) {}

  @Get('reports/finance') @Roles('admin', 'accountant', 'viewer')
  finance(@Query('from') from?: string, @Query('to') to?: string) { return this.svc.finance(...q2(from, to)); }

  /** მენეჯერი ხედავს მხოლოდ საკუთარ განყოფილებას */
  @Get('reports/activity') @Roles('admin', 'accountant', 'viewer', 'manager')
  async activity(@Query('from') from: string | undefined, @Query('to') to: string | undefined, @Query('department_id') dep: string | undefined, @CurrentUser() u: AuthUser) {
    let department = dep && /^[0-9a-f-]{36}$/i.test(dep) ? dep : undefined;
    if (!u.caps.some((c) => c === 'admin' || c === 'accountant' || c === 'viewer')) {
      const me = await this.db.selectFrom('users').select('department_id').where('id', '=', u.id).executeTakeFirst();
      if (!me?.department_id) throw new BadRequestException('მენეჯერს განყოფილება არ აქვს მინიჭებული');
      department = me.department_id;
    }
    return this.svc.activity(...q2(from, to), department);
  }

  @Get('expenses') @Roles('admin', 'accountant', 'viewer')
  expenses(@Query('from') from?: string, @Query('to') to?: string, @Query('include_void') iv?: string) { return this.svc.expenses(...q2(from, to), iv === 'true'); }
  @Get('expenses/categories') @Roles('admin', 'accountant', 'viewer')
  categories() { return this.svc.categories(); }
  @Post('expenses') @Roles('admin', 'accountant')
  create(@Body() dto: ExpenseDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.svc.createExpense(dto, u, auditCtx(req)); }
  @Patch('expenses/:id') @Roles('admin', 'accountant')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ExpenseUpdateDto, @Req() req: Request) { return this.svc.updateExpense(id, dto, auditCtx(req)); }
}

@Module({ controllers: [ManagementReportsController], providers: [ManagementReportsService] })
export class ManagementReportsModule {}
