import { BadRequestException, Body, ConflictException, Controller, Get, Injectable, Module, NotFoundException,
  Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { jsonArrayFrom } from 'kysely/helpers/postgres';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/roles';
import { withPgErrors } from '../common/pg-errors';
import { InjectDb, type Database } from '../database/database.module';
import { AdjustLineDto, PaymentDto } from '../encounters/dto/encounters.dto';
import { EncountersModule } from '../encounters/encounters.module';
import { EncountersService, PAYMENT_ERRORS } from '../encounters/encounters.service';

@Injectable()
export class BillingService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService,
              private readonly encounters: EncountersService) {}

  async byEncounter(encounterId: string) {
    const inv = await this.db.selectFrom('invoices as i').selectAll('i')
      .select((eb) => [
        jsonArrayFrom(eb.selectFrom('invoice_line_items as l').selectAll('l').whereRef('l.invoice_id', '=', 'i.id')).as('lines'),
        jsonArrayFrom(eb.selectFrom('payments as p').selectAll('p').whereRef('p.invoice_id', '=', 'i.id').orderBy('p.paid_at')).as('payments'),
      ])
      .where('i.encounter_id', '=', encounterId).executeTakeFirst();
    if (!inv) throw new NotFoundException('ინვოისი ვერ მოიძებნა');
    const paid = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
    return { ...inv, paid_amount: paid.toFixed(2), balance_due: (Number(inv.patient_share) - paid).toFixed(2) };
  }

  /** დამატებითი გადახდა (მაგ. მიმართვების შემდეგ) — ვიზიტი planned-ში ვერ იქნება: ამისთვის pay-initial */
  addPayment(invoiceId: string, dto: PaymentDto, user: AuthUser, ctx: AuditContext) {
    if (dto.method === 'card_terminal' && !dto.terminal_ref) throw new BadRequestException('ბარათით გადახდას სჭირდება terminal_ref');
    return withPgErrors(() => this.db.transaction().execute(async (trx) => {
      const inv = await trx.selectFrom('invoices as i').innerJoin('encounters as e', 'e.id', 'i.encounter_id')
        .select(['i.id', 'e.status']).where('i.id', '=', invoiceId).forUpdate(['i']).executeTakeFirst();
      if (!inv) throw new NotFoundException('ინვოისი ვერ მოიძებნა');
      if (inv.status === 'planned') throw new ConflictException('საწყისი გადახდისთვის გამოიყენეთ /encounters/:id/pay-initial');
      if (inv.status === 'cancelled') throw new ConflictException('ვიზიტი გაუქმებულია');
      const p = await this.encounters.insertPayment(trx, invoiceId, dto, user, ctx);
      const after = await trx.selectFrom('invoices').select(['paid_status', 'patient_share']).where('id', '=', invoiceId).executeTakeFirstOrThrow();
      return { payment: p, paid_status: after.paid_status };
    }), PAYMENT_ERRORS);
  }

  /** ფასის ხელით შესწორება: შემცირებისას დასაბუთება სავალდებულოა (DB CHECK-იც აძალებს) */
  adjustLine(invoiceId: string, lineId: string, dto: AdjustLineDto, user: AuthUser, ctx: AuditContext) {
    return withPgErrors(() => this.db.transaction().execute(async (trx) => {
      const line = await trx.selectFrom('invoice_line_items').selectAll()
        .where('id', '=', lineId).where('invoice_id', '=', invoiceId).forUpdate().executeTakeFirst();
      if (!line) throw new NotFoundException('ხაზი ვერ მოიძებნა');
      if (line.original_price !== null && dto.unit_price < Number(line.original_price) && !dto.discount_reason?.trim()) {
        throw new BadRequestException('ფასდაკლებას სჭირდება დასაბუთება (discount_reason)');
      }
      const updated = await trx.updateTable('invoice_line_items')
        .set({ unit_price: dto.unit_price.toFixed(2), discount_reason: dto.discount_reason ?? null, adjusted_by: user.id })
        .where('id', '=', lineId).returningAll().executeTakeFirstOrThrow();
      await this.audit.log(ctx, { action: 'ADJUST_PRICE', entityName: 'invoice_line_items', entityId: lineId,
        oldData: { unit_price: line.unit_price }, newData: { unit_price: updated.unit_price, discount_reason: updated.discount_reason } }, trx);
      return updated;
    }), { ...PAYMENT_ERRORS, chk_invoice_overpaid: 'ახალი ფასი ნაკლებია უკვე გადახდილ თანხაზე', chk_discount_reason: 'ფასდაკლებას სჭირდება დასაბუთება' });
  }
}

@Controller('invoices')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('encounter/:encounterId') @Roles('admin', 'billing', 'receptionist', 'doctor')
  byEncounter(@Param('encounterId', ParseUUIDPipe) id: string) { return this.billing.byEncounter(id); }

  @Post(':id/payments') @Roles('admin', 'billing', 'receptionist')
  addPayment(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PaymentDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.billing.addPayment(id, dto, user, auditCtx(req));
  }

  @Patch(':id/lines/:lineId') @Roles('admin', 'billing')
  adjustLine(@Param('id', ParseUUIDPipe) id: string, @Param('lineId', ParseUUIDPipe) lineId: string,
             @Body() dto: AdjustLineDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.billing.adjustLine(id, lineId, dto, user, auditCtx(req));
  }
}

@Module({ imports: [EncountersModule], controllers: [BillingController], providers: [BillingService] })
export class BillingModule {}
