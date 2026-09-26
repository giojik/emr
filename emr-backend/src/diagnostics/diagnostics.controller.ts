import { BadRequestException, Body, Controller, Get, HttpCode, Module, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, Res, StreamableFile } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import type { Request, Response } from 'express';
import { AllergiesModule } from '../allergies/allergies';
import { auditCtx } from '../audit/audit-context';
import { CurrentUser, Roles } from '../auth/decorators';
import { has, type AuthUser } from '../auth/roles';
import { loadEnv } from '../config/env';
import { EncountersModule } from '../encounters/encounters.module';
import { InjectDb, type Database } from '../database/database.module';
import { ClinicSettingsModule, ClinicSettingsService } from '../settings/clinic-settings';
import { renderLabels } from './diagnostics.pdf';
import { DiagnosticsService } from './diagnostics.service';
import { EndoscopyController } from './endoscopy.controller';
import { EndoscopyService } from './endoscopy.service';
import { LabConfigController, PublicLabVerifyController } from './lab-config.controller';
import { LabConfigService } from './lab-config.service';
import { RadiologyController } from './radiology.controller';
import { RadiologyService } from './radiology.service';

class OrderItemDto {
  @IsUUID() service_id: string;
  @IsOptional() @IsIn(['routine', 'urgent']) priority?: 'routine' | 'urgent';
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}
class OrderDto {
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => OrderItemDto) items: OrderItemDto[];
  @IsOptional() @IsString() @Length(10, 2000) allergy_override_reason?: string;
}
class ReasonDto { @IsString() @Length(5, 1000) reason: string }
class CollectDto {
  @IsOptional() @IsArray() @IsUUID('4', { each: true }) item_ids?: string[];
  @IsOptional() @IsBoolean() identity_confirmed?: boolean;
  @IsOptional() @IsBoolean() unpaid_ack?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(45) pregnancy_weeks?: number | null;
}
class LabVisitDto {
  @IsUUID() patient_id: string;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => OrderItemDto) items: OrderItemDto[];
  @IsOptional() @IsString() @MaxLength(500) external_referral?: string;
  @IsOptional() @IsUUID() department_id?: string;
  @IsOptional() @IsString() @Length(10, 2000) allergy_override_reason?: string;
}
class ReceiveDto { @IsString() @Length(3, 30) barcode: string }
class ResultValueDto { @IsUUID() analyte_id: string; @IsOptional() value: string | number | null }
class ResultsDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => ResultValueDto) values: ResultValueDto[];
  /** ნორმის შესარჩევად: ორსულობის კვირა და ანალიზატორი (null — გასუფთავება, გამოტოვება — უცვლელი) */
  @IsOptional() @IsInt() @Min(1) @Max(45) pregnancy_weeks?: number | null;
  @IsOptional() @IsUUID() lab_method_id?: string | null;
}
class ServiceCreateDto {
  @IsIn(['lab', 'radiology', 'endoscopy']) section: 'lab' | 'radiology' | 'endoscopy';
  @IsString() @Length(2, 50) @Matches(/^[A-Za-z0-9_]+$/, { message: 'კოდი: ლათინური ასოები, ციფრები, _' }) code: string;
  @IsString() @Length(2, 300) name: string;
  @IsString() @Length(2, 100) group_name: string;
  @IsOptional() @IsIn(['blood', 'serum', 'plasma', 'urine', 'stool', 'swab', 'other']) specimen_type?: string;
  @IsOptional() @IsString() @MaxLength(60) container?: string;
  @IsOptional() @IsString() @MaxLength(10) modality?: string;
  @IsOptional() @IsString() @MaxLength(100) body_part?: string;
  @IsOptional() @IsIn(['iodinated', 'gadolinium', 'barium']) contrast?: string;
  @IsOptional() @IsIn(['internal', 'external']) performed_by?: 'internal' | 'external';
  @IsOptional() @IsString() @MaxLength(200) external_lab?: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) base_price?: number;
}
class ServiceUpdateDto {
  @IsOptional() @IsString() @Length(2, 300) name?: string;
  @IsOptional() @IsString() @Length(2, 100) group_name?: string;
  @IsOptional() @IsIn(['blood', 'serum', 'plasma', 'urine', 'stool', 'swab', 'other']) specimen_type?: string;
  @IsOptional() @IsString() @MaxLength(60) container?: string | null;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) base_price?: number;
  @IsOptional() @IsIn(['internal', 'external']) performed_by?: 'internal' | 'external';
  @IsOptional() @IsString() @MaxLength(200) external_lab?: string | null;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsBoolean() approve?: boolean;
  @IsOptional() @IsInt() duration_minutes?: number | null;
  @IsOptional() @IsString() @MaxLength(1000) prep_instructions?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) report_comment?: string | null;
  @IsOptional() @IsUUID() default_method_id?: string | null;
}
class RangeDto {
  @IsOptional() @IsIn(['male', 'female']) sex: 'male' | 'female' | null;
  @IsOptional() @IsInt() age_min_days?: number; @IsOptional() @IsInt() age_max_days?: number;
  @IsOptional() @IsNumber() low?: number | null; @IsOptional() @IsNumber() high?: number | null;
  @IsOptional() @IsString() normal_text?: string | null;
  @IsOptional() @IsIn(['P', 'T1', 'T2', 'T3']) pregnancy?: 'P' | 'T1' | 'T2' | 'T3' | null;
  @IsOptional() @IsUUID() method_id?: string | null;
}
class AnalyteDto {
  @IsOptional() @IsUUID() id?: string;
  @IsString() @Length(1, 30) code: string; @IsString() @Length(1, 200) name: string; @IsString() @MaxLength(30) unit: string;
  @IsIn(['numeric', 'text', 'select']) result_type: 'numeric' | 'text' | 'select';
  @IsOptional() @IsInt() decimals?: number | null; @IsOptional() @IsString() options?: string | null;
  @IsOptional() @IsNumber() critical_low?: number | null; @IsOptional() @IsNumber() critical_high?: number | null;
  @IsOptional() @IsInt() sort_order?: number; @IsOptional() @IsBoolean() is_active?: boolean;
  /** მხოლოდ ახალ კომპონენტზე (საწყისი ნორმები); არსებულის ნორმები — PUT /lab/analytes/:id/norms */
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => RangeDto) ranges?: RangeDto[];
}

const LAB = ['admin', 'diagnostic', 'lab_doctor'] as const;
const LAB_READ = [...LAB, 'lab_manager'] as const;
const COLLECT = ['admin', 'nurse', 'phlebotomist', 'diagnostic', 'lab_doctor'] as const;
const pdf = (res: Response, buf: Buffer) => { res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline', 'Cache-Control': 'no-store' }); return new StreamableFile(buf); };

@Controller()
export class DiagnosticsController {
  private readonly tz = loadEnv().CLINIC_TZ;
  constructor(private readonly dx: DiagnosticsService, private readonly settings: ClinicSettingsService, @InjectDb() private readonly db: Database,
              private readonly lab: LabConfigService) {}

  // ---- კატალოგი
  @Get('dx/catalog') catalog(@Query('section') section?: string, @Query('search') search?: string, @Query('include_inactive') inc?: string) {
    return this.dx.catalog({ section, search, includeInactive: inc === 'true' });
  }
  @Get('dx/catalog/groups') groups(@Query('section') section = 'lab') { return this.dx.groups(section); }
  @Post('dx/catalog') @Roles('admin', 'lab_manager', 'lab_doctor')
  createService(@Body() dto: ServiceCreateDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.dx.createService(dto, u, auditCtx(req)); }
  @Get('dx/catalog/:id') service(@Param('id', ParseUUIDPipe) id: string) { return this.dx.serviceDetail(id); }
  @Patch('dx/catalog/:id') @Roles('admin', 'billing', 'lab_manager', 'lab_doctor')
  updateService(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ServiceUpdateDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.dx.updateService(id, dto, u, auditCtx(req)); }
  @Post('dx/catalog/:id/analytes') @Roles('admin', 'lab_manager', 'lab_doctor')
  saveAnalyte(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AnalyteDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.dx.saveAnalyte(id, dto, u, auditCtx(req)); }

  // ---- შეკვეთა
  @Post('encounters/:id/dx-orders') @Roles('admin', 'doctor')
  order(@Param('id', ParseUUIDPipe) id: string, @Body() dto: OrderDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.dx.order(id, dto, u, auditCtx(req)); }

  /** მკურნალი ექიმი ლაბორატორიულ შედეგს ხედავს მხოლოდ ვალიდაციის შემდეგ */
  @Get('encounters/:id/dx-orders') @Roles('admin', 'doctor', 'nurse', 'diagnostic', 'lab_doctor', 'receptionist', 'billing', 'radiographer', 'radiologist', 'endoscopist', 'endoscopy_nurse')
  async items(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser) {
    const rows = await this.dx.encounterItems(id);
    const labStaff = has(u, 'admin', 'diagnostic', 'lab_doctor');
    return rows.map((r) => (r.section === 'lab' && r.status !== 'validated' && !labStaff ? { ...r, results: [] } : r));
  }
  @Post('dx-orders/:id/cancel') @HttpCode(200) @Roles('admin', 'doctor')
  cancel(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.dx.cancel(id, dto.reason, u, auditCtx(req)); }

  // ---- ლაბორატორიული ვიზიტი (რეგისტრატურა, ექიმის გარეშე)
  @Post('lab-visits') @Roles('admin', 'receptionist')
  labVisit(@Body() dto: LabVisitDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.dx.labVisit(dto, u, auditCtx(req)); }

  // ---- ნიმუშის აღება (ფლებოტომისტი / ექთანი)
  @Get('dx/collection') @Roles(...COLLECT)
  pending(@Query('search') search?: string) { return this.dx.pendingCollection({ search }); }
  @Get('dx/collection/:encounterId') @Roles(...COLLECT)
  collectionDetail(@Param('encounterId', ParseUUIDPipe) id: string) { return this.dx.collectionDetail(id); }
  @Post('encounters/:id/dx-collect') @Roles(...COLLECT)
  collect(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CollectDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.dx.collect(id, dto, u, auditCtx(req)); }
  @Post('dx/collection/:encounterId/issue') @HttpCode(200) @Roles(...COLLECT)
  issue(@Param('encounterId', ParseUUIDPipe) id: string, @Body() dto: ReasonDto, @Req() req: Request) { return this.dx.collectionIssue(id, dto.reason, auditCtx(req)); }
  @Get('dx/labels') @Roles(...COLLECT)
  async labels(@Query('ids') ids = '', @Res({ passthrough: true }) res: Response) {
    const list = ids.split(',').filter((x) => /^[0-9a-f-]{36}$/i.test(x));
    if (!list.length) throw new BadRequestException('ids');
    return pdf(res, await renderLabels(await this.dx.labelsData(list)));
  }

  // ---- ლაბორატორია
  @Post('lab/receive') @HttpCode(200) @Roles(...LAB)
  receive(@Body() dto: ReceiveDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.dx.receive(dto.barcode, u, auditCtx(req)); }
  @Get('lab/worklist') @Roles(...LAB_READ)
  worklist(@Query('status') status = 'collected,in_progress,resulted', @Query('search') search?: string) { return this.dx.labWorklist(status.split(',').filter(Boolean), search); }
  @Get('lab/items/:id') @Roles(...LAB_READ)
  labItem(@Param('id', ParseUUIDPipe) id: string) { return this.dx.labItem(id); }
  @Put('lab/items/:id/results') @Roles(...LAB)
  results(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ResultsDto, @CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.dx.saveResults(id, dto.values, u, auditCtx(req), { pregnancy_weeks: dto.pregnancy_weeks, lab_method_id: dto.lab_method_id });
  }
  @Post('lab/items/:id/validate') @HttpCode(200) @Roles('admin', 'lab_doctor')
  validate(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.dx.validate(id, u, auditCtx(req)); }
  @Post('lab/items/:id/reopen') @HttpCode(200) @Roles('admin', 'lab_doctor')
  reopen(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto, @Req() req: Request) { return this.dx.reopen(id, dto.reason, auditCtx(req)); }

  /** ბლანკი: ვიზიტის ყველა ვალიდირებული ლაბორატორიული შედეგი (ან ერთი შეკვეთა ?item=) — ბლანკის შაბლონით (lab-config) */
  @Get('encounters/:id/lab-report') @Roles('admin', 'doctor', 'nurse', 'receptionist', 'diagnostic', 'lab_doctor', 'lab_manager')
  async report(@Param('id', ParseUUIDPipe) id: string, @Query('item') item: string | undefined, @Res({ passthrough: true }) res: Response) {
    return pdf(res, await this.lab.encounterReport(id, item));
  }
}

@Module({
  imports: [EncountersModule, AllergiesModule, ClinicSettingsModule],
  controllers: [DiagnosticsController, RadiologyController, EndoscopyController, LabConfigController, PublicLabVerifyController],
  providers: [DiagnosticsService, RadiologyService, EndoscopyService, LabConfigService], exports: [DiagnosticsService],
})
export class DiagnosticsModule {}
