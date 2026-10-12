import { BadRequestException, Body, ConflictException, Controller, Get, Injectable, Module, NotFoundException,
  Param, ParseUUIDPipe, Patch, Post, Put, Req } from '@nestjs/common';
import { IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { jsonArrayFrom } from 'kysely/helpers/postgres';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/roles';
import { finRules, OPD_PAYER_EDIT } from '../finance/finance-rules';
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
        sql<boolean>`EXISTS (SELECT 1 FROM inpatient_stays s WHERE s.encounter_id = i.encounter_id)`.as('is_inpatient'),
        // 0053: ამბულატორიის გადამხდელი; ქლეიმში შემავალი — გადამხდელი აღარ იცვლება
        sql<string | null>`(SELECT p.name FROM payers p WHERE p.id = i.insurance_payer_id)`.as('insurance_payer_name'),
        sql<string | null>`(SELECT p.name FROM payers p WHERE p.id = i.state_payer_id)`.as('state_payer_name'),
        sql<string | null>`(SELECT string_agg(DISTINCT coalesce(c.claim_no, 'მონახაზი'), ', ') FROM fin_claim_items ci JOIN fin_claims c ON c.id = ci.claim_id WHERE ci.invoice_id = i.id)`.as('claim_nos'),
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
        .select(['i.id', 'e.status', 'e.type', 'i.finalized_at']).where('i.id', '=', invoiceId).forUpdate(['i']).executeTakeFirst();
      if (!inv) throw new NotFoundException('ინვოისი ვერ მოიძებნა');
      // 0046: სტაციონარი — ფინანსურ დახურვამდე თანხა მიიღება ავანსად (ჰოსპიტალიზაციის გვერდი → ბილინგი)
      if (inv.type === 'inpatient' && !inv.finalized_at) throw new ConflictException({ code: 'IPD_USE_DEPOSIT', message: 'სტაციონარი: ფინანსურ დახურვამდე თანხა მიიღება ავანსის სახით (ჰოსპიტალიზაცია → ბილინგი)' });
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
  /**
   * 0053: ამბულატორიის ინვოისის გადამხდელი (დაზღვევა / სახელმწიფო) და წილი — ხელით (opd_payer_mode = manual, 0054-მდე).
   * სტაციონარი — stay_payers (ჰოსპიტალიზაცია → ბილინგი); ქლეიმში შემავალი ინვოისი — 409.
   */
  async setPayers(invoiceId: string, dto: InvoicePayersDto, user: AuthUser, ctx: AuditContext) {
    return withPgErrors(() => this.db.transaction().execute(async (trx) => {
      const inv = await trx.selectFrom('invoices as i').innerJoin('encounters as e', 'e.id', 'i.encounter_id')
        .select(['i.id', 'i.total_amount', 'i.insurance_share', 'i.state_share', 'i.insurance_payer_id', 'i.state_payer_id', 'e.status',
          sql<boolean>`EXISTS (SELECT 1 FROM inpatient_stays s WHERE s.encounter_id = i.encounter_id)`.as('ipd')])
        .where('i.id', '=', invoiceId).forUpdate(['i']).executeTakeFirst();
      if (!inv) throw new NotFoundException('ინვოისი ვერ მოიძებნა');
      if (inv.ipd) throw new ConflictException({ code: 'IPD_USE_STAY_PAYERS', message: 'სტაციონარი: გადამხდელები — ჰოსპიტალიზაცია → ბილინგი' });
      if (inv.status === 'cancelled') throw new ConflictException('ვიზიტი გაუქმებულია');
      const inClaim = await trx.selectFrom('fin_claim_items').select('id').where('invoice_id', '=', invoiceId).executeTakeFirst();
      if (inClaim) throw new ConflictException({ code: 'INVOICE_IN_CLAIM', message: 'ინვოისი შედის გადამხდელის ქლეიმში — გადამხდელი / წილი აღარ იცვლება' });
      const next = {
        insurance_payer_id: dto.insurance_payer_id !== undefined ? dto.insurance_payer_id : inv.insurance_payer_id,
        state_payer_id: dto.state_payer_id !== undefined ? dto.state_payer_id : inv.state_payer_id,
        insurance_share: dto.insurance_share !== undefined ? dto.insurance_share : Number(inv.insurance_share),
        state_share: dto.state_share !== undefined ? dto.state_share : Number(inv.state_share),
      };
      if (next.insurance_share + next.state_share > Number(inv.total_amount) + 0.001) throw new BadRequestException(`წილების ჯამი აღემატება ინვოისის თანხას (${inv.total_amount})`);
      const ids = [next.insurance_payer_id, next.state_payer_id].filter((x): x is string => !!x);
      const ps = ids.length ? await trx.selectFrom('payers').select(['id', 'name', 'kind', 'is_active']).where('id', 'in', ids).execute() : [];
      const chk = (id: string | null, slot: 'insurance' | 'state') => {
        if (!id) return;
        const p = ps.find((x) => x.id === id);
        if (!p) throw new BadRequestException('გადამხდელი ვერ მოიძებნა');
        if (!p.is_active && id !== (slot === 'state' ? inv.state_payer_id : inv.insurance_payer_id)) throw new BadRequestException(`გადამხდელი „${p.name}“ გათიშულია`);
        if (slot === 'state' ? p.kind !== 'state' : p.kind === 'state') throw new BadRequestException(slot === 'state' ? `„${p.name}“ სახელმწიფო პროგრამა არ არის` : `„${p.name}“ სახელმწიფო პროგრამაა — მიუთითეთ სახელმწიფოს წილში`);
      };
      chk(next.insurance_payer_id, 'insurance'); chk(next.state_payer_id, 'state');
      const rules = await finRules(trx);
      if (rules.enabled && rules.opd_payer_required && ((next.insurance_share > 0 && !next.insurance_payer_id) || (next.state_share > 0 && !next.state_payer_id))) {
        throw new BadRequestException('მიუთითეთ გადამხდელი (პარამეტრი opd_payer_required)');
      }
      await trx.updateTable('invoices').set({ insurance_payer_id: next.insurance_payer_id, state_payer_id: next.state_payer_id,
        insurance_share: next.insurance_share.toFixed(2), state_share: next.state_share.toFixed(2) }).where('id', '=', invoiceId).execute();
      const after = await trx.selectFrom('invoices').select(['insurance_share', 'state_share', 'patient_share', 'paid_status', 'insurance_payer_id', 'state_payer_id']).where('id', '=', invoiceId).executeTakeFirstOrThrow();
      await this.audit.log(ctx, { action: 'INVOICE_PAYERS', entityName: 'invoices', entityId: invoiceId,
        oldData: { insurance_payer_id: inv.insurance_payer_id, insurance_share: inv.insurance_share, state_payer_id: inv.state_payer_id, state_share: inv.state_share },
        newData: { ...after, reason: dto.reason ?? null, by: user.id } }, trx);
      return after;
    }), { ...PAYMENT_ERRORS, chk_invoice_overpaid: 'პაციენტის წილი ნაკლები გახდება უკვე გადახდილზე — ჯერ საჭიროა დაბრუნება' });
  }
}

export class InvoicePayersDto {
  @IsOptional() @IsUUID() insurance_payer_id?: string | null;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(10_000_000) insurance_share?: number;
  @IsOptional() @IsUUID() state_payer_id?: string | null;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(10_000_000) state_share?: number;
  @IsOptional() @IsString() @MaxLength(500) reason?: string | null;
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

  @Put(':id/payers') @Roles(...OPD_PAYER_EDIT)
  setPayers(@Param('id', ParseUUIDPipe) id: string, @Body() dto: InvoicePayersDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.billing.setPayers(id, dto, user, auditCtx(req));
  }

  @Patch(':id/lines/:lineId') @Roles('admin', 'billing')
  adjustLine(@Param('id', ParseUUIDPipe) id: string, @Param('lineId', ParseUUIDPipe) lineId: string,
             @Body() dto: AdjustLineDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.billing.adjustLine(id, lineId, dto, user, auditCtx(req));
  }
}

@Module({ imports: [EncountersModule], controllers: [BillingController], providers: [BillingService] })
export class BillingModule {}
