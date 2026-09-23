import { Body, Controller, Get, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsNumber, IsOptional, IsString, IsUUID, Length, Matches, Max, Min } from 'class-validator';
import type { Request } from 'express';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { Roles } from '../auth/decorators';
import { withPgErrors } from '../common/pg-errors';
import { InjectDb, type Database } from '../database/database.module';

const REFERRAL_TYPES = ['lab', 'imaging', 'hospitalization', 'specialist_consult'] as const;
const money = ({ value }: { value: unknown }) => (typeof value === 'string' ? Number(value) : value);

export class CreateTariffDto {
  @Matches(/^[A-Z0-9_.-]{2,50}$/, { message: 'კოდი: დიდი ლათინური ასოები, ციფრები, _ . -' }) code: string;
  @IsString() @Length(2, 300) title: string;
  @Transform(money) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(99_999_999) base_price: number;
}
export class UpdateTariffDto {
  @IsOptional() @IsString() @Length(2, 300) title?: string;
  @IsOptional() @Transform(money) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(99_999_999) base_price?: number;
  @IsOptional() @IsBoolean() is_active?: boolean;
}
export class ReferralTypeTariffDto {
  @IsIn(REFERRAL_TYPES) type: (typeof REFERRAL_TYPES)[number];
  @IsUUID() tariff_id: string;
}

@Injectable()
export class TariffsService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService) {}

  list(includeInactive: boolean, search?: string) {
    let q = this.db.selectFrom('service_tariffs').selectAll().orderBy('code');
    if (!includeInactive) q = q.where('is_active', '=', true);
    if (search?.trim()) q = q.where((eb) => eb.or([eb('code', 'ilike', `%${search.trim()}%`), eb('title', 'ilike', `%${search.trim()}%`)]));
    return q.execute();
  }

  create(dto: CreateTariffDto, ctx: AuditContext) {
    return withPgErrors(() => this.db.transaction().execute(async (trx) => {
      const t = await trx.insertInto('service_tariffs').values({ ...dto, base_price: dto.base_price.toFixed(2) }).returningAll().executeTakeFirstOrThrow();
      await this.audit.log(ctx, { action: 'CREATE_TARIFF', entityName: 'service_tariffs', entityId: t.id, newData: t }, trx);
      return t;
    }), { service_tariffs_code_key: `ტარიფის კოდი ${dto.code} უკვე არსებობს` });
  }

  /** ფასის ცვლილება არ ეხება უკვე გამოწერილ ინვოისებს — ხაზებში ფასი შექმნის მომენტშია დაფიქსირებული */
  update(id: string, dto: UpdateTariffDto, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const old = await trx.selectFrom('service_tariffs').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!old) throw new NotFoundException('ტარიფი ვერ მოიძებნა');
      const t = await trx.updateTable('service_tariffs')
        .set({ ...dto, ...(dto.base_price !== undefined ? { base_price: dto.base_price.toFixed(2) } : {}) })
        .where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await this.audit.log(ctx, { action: 'UPDATE_TARIFF', entityName: 'service_tariffs', entityId: id, oldData: old, newData: t }, trx);
      return t;
    });
  }

  referralTypes() {
    return this.db.selectFrom('referral_type_tariffs as r').innerJoin('service_tariffs as t', 't.id', 'r.tariff_id')
      .select(['r.type', 'r.tariff_id', 't.code', 't.title', 't.base_price']).orderBy('r.type').execute();
  }

  setReferralType(dto: ReferralTypeTariffDto, ctx: AuditContext) {
    return withPgErrors(() => this.db.transaction().execute(async (trx) => {
      await trx.insertInto('referral_type_tariffs').values(dto)
        .onConflict((oc) => oc.column('type').doUpdateSet({ tariff_id: dto.tariff_id })).execute();
      await this.audit.log(ctx, { action: 'SET_REFERRAL_TARIFF', entityName: 'referral_type_tariffs', entityId: dto.type, newData: dto }, trx);
      return dto;
    }), { referral_type_tariffs_tariff_id_fkey: 'ტარიფი არ არსებობს' });
  }
}

@Controller('tariffs')
export class TariffsController {
  constructor(private readonly tariffs: TariffsService) {}

  @Get() @Roles('admin', 'billing', 'receptionist', 'doctor')
  list(@Query('include_inactive') inc?: string, @Query('search') search?: string) { return this.tariffs.list(inc === 'true', search); }

  @Post() @Roles('admin', 'billing')
  create(@Body() dto: CreateTariffDto, @Req() req: Request) { return this.tariffs.create(dto, auditCtx(req)); }

  @Patch(':id') @Roles('admin', 'billing')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTariffDto, @Req() req: Request) { return this.tariffs.update(id, dto, auditCtx(req)); }

  @Get('referral-types') @Roles('admin', 'billing', 'doctor')
  referralTypes() { return this.tariffs.referralTypes(); }

  @Put('referral-types') @Roles('admin', 'billing')
  setReferralType(@Body() dto: ReferralTypeTariffDto, @Req() req: Request) { return this.tariffs.setReferralType(dto, auditCtx(req)); }
}

@Module({ controllers: [TariffsController], providers: [TariffsService] })
export class TariffsModule {}
