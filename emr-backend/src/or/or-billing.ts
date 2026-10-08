import { BadRequestException, Body, Controller, ForbiddenException, Get, Injectable, Param, ParseUUIDPipe, Put, Req } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsString, IsUUID, Length, ValidateIf, ValidateNested } from 'class-validator';
import type { Request } from 'express';
import { sql } from 'kysely';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser } from '../auth/roles';
import { InjectDb, type Database } from '../database/database.module';
import { OR_READ } from './or-admin';
import { ANESTHESIA, OrService } from './or';
import { syncCaseBilling } from './or-shared';

export class AnesthesiaTariffItem {
  @IsIn(ANESTHESIA) anesthesia_type: string;
  @IsIn(['fixed', 'hourly']) mode: 'fixed' | 'hourly';
  @ValidateIf((_, v) => v !== null) @IsUUID() tariff_id: string | null;      // null — წაშლა
}
export class AnesthesiaTariffsDto {
  @IsArray() @ArrayMaxSize(16) @ValidateNested({ each: true }) @Type(() => AnesthesiaTariffItem) items: AnesthesiaTariffItem[];
  @IsString() @Length(3, 500) reason: string;
}

/**
 * საოპერაციოს ბილინგი (0050, #12): ოპერაციის ხაზები ინვოისში — or_sync_case_billing (SQL; ნახვისას / დასრულებისას / ოქმის ხელმოწერისას / ნიშნულის შესწორებისას);
 * ანესთეზიის ტარიფები — ტიპზე (fixed) / საათობრივი (hourly). თანხები ჩანს: admin / ბილინგი / მენეჯერი / რეგისტრატურა.
 */
@Injectable()
export class OrBillingService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService, private readonly or: OrService) {}

  async view(id: string, u: AuthUser) {
    const s = await this.or.settings();
    const c = await this.or.loadCase(id);
    const p = await this.or.perms(u, c, s);
    if (c.status === 'completed') await this.db.transaction().execute((trx) => syncCaseBilling(trx, id));
    const [inv, lines, st] = await Promise.all([
      c.encounter_id ? this.db.selectFrom('invoices').select(['id', 'invoice_number', 'finalized_at']).where('encounter_id', '=', c.encounter_id).executeTakeFirst() : null,
      this.db.selectFrom('invoice_line_items as l').leftJoin('service_tariffs as t', 't.id', 'l.tariff_id')
        .select(['l.id', 'l.category', 'l.description', 'l.quantity', 'l.unit_price', 'l.original_price', 'l.line_total', 'l.package_included', 'l.discount_reason', 'l.service_date',
          't.code as tariff_code'])
        .where('l.or_case_id', '=', id).orderBy(sql`CASE l.category WHEN 'surgery' THEN 0 ELSE 1 END`).orderBy('l.created_at').execute(),
      this.db.selectFrom('or_case_billing').selectAll().where('case_id', '=', id).executeTakeFirst(),
    ]);
    const amounts = p.billing;
    const strip = <T extends Record<string, unknown>>(l: T) => (amounts ? l : { ...l, unit_price: null, original_price: null, line_total: null, discount_reason: null });
    const total = lines.filter((l) => !l.package_included).reduce((a, l) => a + Number(l.line_total ?? 0), 0);
    return {
      case_id: id, case_no: c.case_no, status: c.status, encounter_id: c.encounter_id, invoice: inv ?? null, finalized: !!inv?.finalized_at,
      lines: lines.map(strip), total: amounts ? total.toFixed(2) : null, missing: st?.missing ?? [], synced_at: st?.synced_at ?? null,
      anesthesia: st ? { type: st.anesthesia_type, minutes: st.anesthesia_min, units: st.anesthesia_units } : null,
      settings: { multi_procedure_billing: s.multi_procedure_billing, multi_procedure_pct: s.multi_procedure_pct, anesthesia_billing: s.anesthesia_billing,
        anesthesia_round_min: s.anesthesia_round_min },
      can: { amounts },
    };
  }

  tariffs() {
    return this.db.selectFrom('or_anesthesia_tariffs as a').innerJoin('service_tariffs as t', 't.id', 'a.tariff_id')
      .select(['a.anesthesia_type', 'a.mode', 'a.tariff_id', 't.code as tariff_code', 't.title as tariff_title', 't.base_price', 't.is_active']).orderBy('a.anesthesia_type').orderBy('a.mode').execute();
  }

  async setTariffs(dto: AnesthesiaTariffsDto, u: AuthUser, ctx: AuditContext) {
    if (!has(u, 'admin')) throw new ForbiddenException('ანესთეზიის ტარიფები — admin');
    const keys = dto.items.map((i) => `${i.anesthesia_type}:${i.mode}`);
    if (new Set(keys).size !== keys.length) throw new BadRequestException('ტიპი / რეჟიმი მეორდება');
    const ids = [...new Set(dto.items.map((i) => i.tariff_id).filter((x): x is string => !!x))];
    if (ids.length) {
      const ok = await this.db.selectFrom('service_tariffs').select('id').where('id', 'in', ids).where('is_active', '=', true).execute();
      if (ok.length !== ids.length) throw new BadRequestException('ტარიფი ვერ მოიძებნა ან გათიშულია');
    }
    await this.db.transaction().execute(async (trx) => {
      const old = await trx.selectFrom('or_anesthesia_tariffs').selectAll().execute();
      for (const i of dto.items) {
        if (i.tariff_id) {
          await trx.insertInto('or_anesthesia_tariffs').values({ anesthesia_type: i.anesthesia_type, mode: i.mode, tariff_id: i.tariff_id, updated_by: u.id })
            .onConflict((oc) => oc.columns(['anesthesia_type', 'mode']).doUpdateSet({ tariff_id: i.tariff_id!, updated_by: u.id, updated_at: sql`now()` })).execute();
        } else {
          await trx.deleteFrom('or_anesthesia_tariffs').where('anesthesia_type', '=', i.anesthesia_type).where('mode', '=', i.mode).execute();
        }
      }
      await this.audit.log(ctx, { action: 'OR_ANESTHESIA_TARIFFS', entityName: 'or_anesthesia_tariffs', entityId: 'all', oldData: old, newData: dto }, trx);
    });
    return this.tariffs();
  }
}

@Controller('or')
export class OrBillingController {
  constructor(private readonly s: OrBillingService) {}
  @Get('cases/:id/billing') @Roles(...OR_READ, 'billing', 'receptionist') view(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser) { return this.s.view(id, u); }
  @Get('anesthesia-tariffs') @Roles(...OR_READ, 'billing') tariffs() { return this.s.tariffs(); }
  @Put('anesthesia-tariffs') @Roles('admin') setTariffs(@Body() d: AnesthesiaTariffsDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.s.setTariffs(d, u, auditCtx(r)); }
}
