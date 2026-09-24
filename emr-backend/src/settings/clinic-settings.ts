import { Body, Controller, Get, Injectable, Module, NotFoundException, Put, Req } from '@nestjs/common';
import { ArrayMinSize, IsArray, IsEmail, IsIn, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import type { Request } from 'express';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { Roles } from '../auth/decorators';
import { InjectDb, type Database } from '../database/database.module';

export class ClinicSettingsDto {
  @IsString() @Length(2, 300) name: string;
  @IsString() @Length(5, 500) address: string;
  @IsOptional() @IsString() @MaxLength(100) phone?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsString() @Length(3, 200) director_name: string;
  @IsOptional() @IsString() @MaxLength(200) director_title?: string;
  @IsOptional() @IsArray() @ArrayMinSize(1) @IsIn(['paper', 'electronic'], { each: true }) consent_methods?: ('paper' | 'electronic')[];
}

@Injectable()
export class ClinicSettingsService {
  constructor(@InjectDb() private readonly db: Database, private readonly audit: AuditService) {}

  async get() {
    const s = await this.db.selectFrom('clinic_settings').selectAll().where('id', '=', 1).executeTakeFirst();
    if (!s) throw new NotFoundException({ code: 'CLINIC_SETTINGS_MISSING', message: 'კლინიკის რეკვიზიტები შევსებული არ არის (PUT /settings/clinic)' });
    return s;
  }

  async put(dto: ClinicSettingsDto, ctx: AuditContext) {
    return this.db.transaction().execute(async (trx) => {
      const old = await trx.selectFrom('clinic_settings').selectAll().where('id', '=', 1).executeTakeFirst();
      const s = await trx.insertInto('clinic_settings').values({ id: 1, ...dto })
        .onConflict((oc) => oc.column('id').doUpdateSet({ ...dto })).returningAll().executeTakeFirstOrThrow();
      await this.audit.log(ctx, { action: 'UPDATE_CLINIC_SETTINGS', entityName: 'clinic_settings', entityId: '1', oldData: old, newData: s }, trx);
      return s;
    });
  }
}

@Controller('settings/clinic')
export class ClinicSettingsController {
  constructor(private readonly settings: ClinicSettingsService) {}
  @Get() get() { return this.settings.get(); }
  @Put() @Roles('admin') put(@Body() dto: ClinicSettingsDto, @Req() req: Request) { return this.settings.put(dto, auditCtx(req)); }
}

@Module({ controllers: [ClinicSettingsController], providers: [ClinicSettingsService], exports: [ClinicSettingsService] })
export class ClinicSettingsModule {}
