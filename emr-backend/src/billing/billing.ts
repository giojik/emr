import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, Module, NotFoundException,
  Param, ParseUUIDPipe, Patch, Post, Put, Req } from '@nestjs/common';
import { ArrayMaxSize, IsArray, IsBoolean, IsNumber, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min } from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { jsonArrayFrom } from 'kysely/helpers/postgres';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser } from '../auth/roles';
import { applyOpdRules, computeOpd } from '../tariffs/payer-shares';
import { repriceLines, repriceOnPayerChange } from '../tariffs/reprice';
import { REPRICE, tariffRules } from '../tariffs/tariff-rules';
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
    // 0054a: ამბ. წილი წესებით — გადასათვლელია? (შეცდომა — მაგ. გადახდილზე ნაკლები წილი — ჩვენებას არ აჩერებს)
    const st = await this.db.selectFrom('invoices').select(['id', 'payer_shares_stale']).where('encounter_id', '=', encounterId).executeTakeFirst();
    if (st?.payer_shares_stale) { try { await this.db.transaction().execute((trx) => applyOpdRules(trx, st.id, { onlyStale: true })); } catch { /* რჩება stale */ } }
    const inv = await this.db.selectFrom('invoices as i').selectAll('i')
      .select((eb) => [
        jsonArrayFrom(eb.selectFrom('invoice_line_items as l').selectAll('l')
          .select([sql<string | null>`(SELECT tl.scope FROM tariff_list_items x JOIN tariff_lists tl ON tl.id = x.list_id WHERE x.id = l.price_item_id)`.as('price_scope'),
            sql<string | null>`(SELECT tl.name FROM tariff_list_items x JOIN tariff_lists tl ON tl.id = x.list_id WHERE x.id = l.price_item_id)`.as('price_list_name'),
            sql<unknown>`(SELECT coalesce(json_agg(json_build_object('kind', s.kind, 'payer_id', s.payer_id, 'amount', s.amount)), '[]'::json) FROM invoice_line_shares s WHERE s.line_id = l.id)`.as('shares')])
          .whereRef('l.invoice_id', '=', 'i.id').orderBy('l.created_at')).as('lines'),
        jsonArrayFrom(eb.selectFrom('payments as p').selectAll('p').whereRef('p.invoice_id', '=', 'i.id').orderBy('p.paid_at')).as('payments'),
        sql<boolean>`EXISTS (SELECT 1 FROM inpatient_stays s WHERE s.encounter_id = i.encounter_id)`.as('is_inpatient'),
        // 0053: ამბულატორიის გადამხდელი; ქლეიმში შემავალი — გადამხდელი აღარ იცვლება
        sql<string | null>`(SELECT p.name FROM payers p WHERE p.id = i.insurance_payer_id)`.as('insurance_payer_name'),
        sql<string | null>`(SELECT p.name FROM payers p WHERE p.id = i.state_payer_id)`.as('state_payer_name'),
        sql<string | null>`(SELECT string_agg(DISTINCT coalesce(c.claim_no, 'მონახაზი'), ', ') FROM fin_claim_items ci JOIN fin_claims c ON c.id = ci.claim_id WHERE ci.invoice_id = i.id)`.as('claim_nos'),
        sql<number>`(SELECT count(*)::int FROM invoice_line_reprices r WHERE r.invoice_id = i.id)`.as('reprice_count'),
      ])
      .where('i.encounter_id', '=', encounterId).executeTakeFirst();
    if (!inv) throw new NotFoundException('ინვოისი ვერ მოიძებნა');
    const paid = inv.payments.reduce((s, p) => s + Number(p.amount), 0);
    const tr = await tariffRules(this.db);
    return { ...inv, paid_amount: paid.toFixed(2), balance_due: (Number(inv.patient_share) - paid).toFixed(2), opd_payer_mode: tr.opd_payer_mode };
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
        .select(['i.id', 'i.total_amount', 'i.insurance_share', 'i.state_share', 'i.insurance_payer_id', 'i.state_payer_id', 'i.payer_shares_manual', 'e.status',
          sql<boolean>`EXISTS (SELECT 1 FROM inpatient_stays s WHERE s.encounter_id = i.encounter_id)`.as('ipd')])
        .where('i.id', '=', invoiceId).forUpdate(['i']).executeTakeFirst();
      if (!inv) throw new NotFoundException('ინვოისი ვერ მოიძებნა');
      if (inv.ipd) throw new ConflictException({ code: 'IPD_USE_STAY_PAYERS', message: 'სტაციონარი: გადამხდელები — ჰოსპიტალიზაცია → ბილინგი' });
      if (inv.status === 'cancelled') throw new ConflictException('ვიზიტი გაუქმებულია');
      const inClaim = await trx.selectFrom('fin_claim_items').select('id').where('invoice_id', '=', invoiceId).executeTakeFirst();
      if (inClaim) throw new ConflictException({ code: 'INVOICE_IN_CLAIM', message: 'ინვოისი შედის გადამხდელის ქლეიმში — გადამხდელი / წილი აღარ იცვლება' });
      const tr = await tariffRules(trx);
      const rulesMode = tr.opd_payer_mode === 'rules';
      const manualShares = dto.insurance_share !== undefined || dto.state_share !== undefined;
      // 0054a: წესების რეჟიმში წილის ხელით შეცვლა — მხოლოდ ბილინგი / admin, მიზეზით
      if (rulesMode && manualShares) {
        if (!has(user, 'admin', 'billing')) throw new ForbiddenException('წესების რეჟიმი: წილის ხელით შეცვლა — მხოლოდ ბილინგი');
        if ((dto.reason?.trim().length ?? 0) < 3) throw new BadRequestException('წესების რეჟიმი: წილის ხელით შეცვლას სჭირდება მიზეზი');
      }
      const next = {
        insurance_payer_id: dto.insurance_payer_id !== undefined ? dto.insurance_payer_id : inv.insurance_payer_id,
        state_payer_id: dto.state_payer_id !== undefined ? dto.state_payer_id : inv.state_payer_id,
        insurance_share: dto.insurance_share !== undefined ? dto.insurance_share : Number(inv.insurance_share),
        state_share: dto.state_share !== undefined ? dto.state_share : Number(inv.state_share),
      };
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
      // 0054: გადამხდელი შეიცვალა → ხელშეკრულების ფასები (reprice_on_payer_change)
      const payerChanged = next.insurance_payer_id !== inv.insurance_payer_id || next.state_payer_id !== inv.state_payer_id;
      let repriced: Awaited<ReturnType<typeof repriceOnPayerChange>> = null;
      if (payerChanged) {
        await trx.updateTable('invoices').set({ insurance_payer_id: next.insurance_payer_id, state_payer_id: next.state_payer_id }).where('id', '=', invoiceId).execute();
        repriced = await repriceOnPayerChange(trx, invoiceId, user.id, tr.reprice_on_payer_change);
      }
      const total = Number((await trx.selectFrom('invoices').select('total_amount').where('id', '=', invoiceId).executeTakeFirstOrThrow()).total_amount);
      let mode: 'manual' | 'rules' | 'rules_manual' = 'manual';
      if (rulesMode && !manualShares) {
        mode = 'rules';
        if (!inv.payer_shares_manual || payerChanged || dto.recalc) {
          await applyOpdRules(trx, invoiceId, { force: true });
        }
      } else {
        if (next.insurance_share + next.state_share > total + 0.001) throw new BadRequestException(`წილების ჯამი აღემატება ინვოისის თანხას (${total.toFixed(2)})`);
        const rules = await finRules(trx);
        if (rules.enabled && rules.opd_payer_required && ((next.insurance_share > 0 && !next.insurance_payer_id) || (next.state_share > 0 && !next.state_payer_id))) {
          throw new BadRequestException('მიუთითეთ გადამხდელი (პარამეტრი opd_payer_required)');
        }
        if (rulesMode) mode = 'rules_manual';
        await trx.updateTable('invoices').set({ insurance_payer_id: next.insurance_payer_id, state_payer_id: next.state_payer_id,
          insurance_share: next.insurance_share.toFixed(2), state_share: next.state_share.toFixed(2),
          ...(rulesMode && { payer_shares_manual: true, payer_shares_reason: dto.reason!.trim(), payer_shares_stale: false }) }).where('id', '=', invoiceId).execute();
        if (rulesMode) await trx.deleteFrom('invoice_line_shares').where('invoice_id', '=', invoiceId).execute();
      }
      const after = await trx.selectFrom('invoices').select(['insurance_share', 'state_share', 'patient_share', 'paid_status', 'insurance_payer_id', 'state_payer_id', 'total_amount',
        'payer_shares_manual']).where('id', '=', invoiceId).executeTakeFirstOrThrow();
      await this.audit.log(ctx, { action: 'INVOICE_PAYERS', entityName: 'invoices', entityId: invoiceId,
        oldData: { insurance_payer_id: inv.insurance_payer_id, insurance_share: inv.insurance_share, state_payer_id: inv.state_payer_id, state_share: inv.state_share, total: inv.total_amount },
        newData: { ...after, mode, reason: dto.reason ?? null, by: user.id, repriced: repriced?.changed.length ?? 0 } }, trx);
      return { ...after, mode, repriced: repriced?.changed ?? [] };
    }), { ...PAYMENT_ERRORS, chk_invoice_overpaid: 'პაციენტის წილი ნაკლები გახდება უკვე გადახდილზე — ჯერ საჭიროა დაბრუნება' });
  }

  /** 0054: ხაზების გადაფასება მიმდინარე ნუსხებით (ბილინგი, მიზეზით) */
  reprice(invoiceId: string, dto: RepriceDto, user: AuthUser, ctx: AuditContext) {
    return withPgErrors(() => this.db.transaction().execute(async (trx) => {
      const inv = await trx.selectFrom('invoices').select(['id', 'total_amount']).where('id', '=', invoiceId).executeTakeFirst();
      if (!inv) throw new NotFoundException('ინვოისი ვერ მოიძებნა');
      const r = await repriceLines(trx, invoiceId, { lineIds: dto.line_ids, reason: dto.reason.trim(), kind: 'manual', userId: user.id, includeAdjusted: dto.include_adjusted });
      await applyOpdRules(trx, invoiceId, { onlyStale: true });
      const after = await trx.selectFrom('invoices').select(['total_amount', 'patient_share', 'insurance_share', 'state_share']).where('id', '=', invoiceId).executeTakeFirstOrThrow();
      if (r.changed.length) {
        await this.audit.log(ctx, { action: 'INVOICE_REPRICE', entityName: 'invoices', entityId: invoiceId, oldData: { total: inv.total_amount },
          newData: { ...after, reason: dto.reason.trim(), lines: r.changed } }, trx);
      }
      return { ...r, invoice: after };
    }), { ...PAYMENT_ERRORS, chk_invoice_overpaid: 'ახალი ფასით პაციენტის წილი ნაკლები ხდება უკვე გადახდილზე — ჯერ საჭიროა დაბრუნება' });
  }

  /** გადაფასების ისტორია */
  reprices(invoiceId: string) {
    return this.db.selectFrom('invoice_line_reprices as r').innerJoin('invoice_line_items as l', 'l.id', 'r.line_id').leftJoin('users as u', 'u.id', 'r.created_by')
      .select(['r.id', 'r.kind', 'r.old_price', 'r.new_price', 'r.reason', 'r.created_at', 'l.description', sql<string | null>`u.first_name || ' ' || u.last_name`.as('by_name')])
      .where('r.invoice_id', '=', invoiceId).orderBy('r.created_at', 'desc').execute();
  }

  /** 0054a: წილის წინასწარი გაანგარიშება წესებით (ჩაწერის გარეშე) — სალაროს დიალოგისთვის */
  async preview(invoiceId: string) {
    const c = await computeOpd(this.db, invoiceId);
    if (!c) throw new NotFoundException('ინვოისი ვერ მოიძებნა');
    return c;
  }
}

export class InvoicePayersDto {
  @IsOptional() @IsUUID() insurance_payer_id?: string | null;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(10_000_000) insurance_share?: number;
  @IsOptional() @IsUUID() state_payer_id?: string | null;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(10_000_000) state_share?: number;
  @IsOptional() @IsString() @MaxLength(500) reason?: string | null;
  /** 0054a: წესების რეჟიმში — ხელით შესწორების მოხსნა და გადათვლა */
  @IsOptional() @IsBoolean() recalc?: boolean;
}
export class RepriceDto {
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsUUID('all', { each: true }) line_ids?: string[];
  @IsString() @Length(3, 500) reason: string;
  @IsOptional() @IsBoolean() include_adjusted?: boolean;
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

  @Post(':id/reprice') @HttpCode(200) @Roles(...REPRICE)
  reprice(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RepriceDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.billing.reprice(id, dto, user, auditCtx(req));
  }

  @Get(':id/reprices') @Roles('admin', 'billing', 'receptionist', 'accountant', 'viewer')
  reprices(@Param('id', ParseUUIDPipe) id: string) { return this.billing.reprices(id); }

  @Get(':id/payers/preview') @Roles(...OPD_PAYER_EDIT)
  preview(@Param('id', ParseUUIDPipe) id: string) { return this.billing.preview(id); }

  @Patch(':id/lines/:lineId') @Roles('admin', 'billing')
  adjustLine(@Param('id', ParseUUIDPipe) id: string, @Param('lineId', ParseUUIDPipe) lineId: string,
             @Body() dto: AdjustLineDto, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.billing.adjustLine(id, lineId, dto, user, auditCtx(req));
  }
}

@Module({ imports: [EncountersModule], controllers: [BillingController], providers: [BillingService] })
export class BillingModule {}
