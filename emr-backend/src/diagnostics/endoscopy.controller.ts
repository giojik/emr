import { BadRequestException, Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, Res, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsISO8601, IsNumber, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import type { Request, Response } from 'express';
import { memoryStorage } from 'multer';
import { auditCtx } from '../audit/audit-context';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/roles';
import { ClinicSettingsService } from '../settings/clinic-settings';
import { EndoscopyService, INTERVENTIONS, SCOPE_TYPES } from './endoscopy.service';
import { renderJarLabels, renderRequisition } from './radiology.pdf';
import { RadiologyService } from './radiology.service';

const MAX_IMG = 8 * 1024 * 1024;
const MAX_SCAN = 15 * 1024 * 1024;

class ScopeDto {
  @IsOptional() @IsString() @Length(2, 100) name?: string;
  @IsOptional() @IsIn(SCOPE_TYPES) scope_type?: string;
  @IsOptional() @IsString() @Length(2, 60) serial_number?: string;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsString() @MaxLength(500) note?: string | null;
}
class ReprocessDto {
  @IsIn(['aer', 'manual']) method: 'aer' | 'manual';
  @IsOptional() @IsString() @MaxLength(100) machine?: string | null;
  @IsOptional() @IsString() @MaxLength(200) disinfectant?: string | null;
  @IsBoolean() leak_test: boolean;
  @IsIn(['passed', 'failed']) result: 'passed' | 'failed';
  @IsOptional() @IsString() @MaxLength(500) note?: string | null;
}
class DrugDto { @IsString() @Length(1, 100) drug: string; @IsNumber() @Min(0) dose: number; @IsString() @MaxLength(10) unit: string; @IsOptional() @IsString() @MaxLength(5) time?: string }
class VitalDto {
  @IsString() @MaxLength(5) time: string;
  @IsOptional() @IsInt() @Min(20) @Max(250) hr?: number; @IsOptional() @IsInt() @Min(50) @Max(100) spo2?: number;
  @IsOptional() @IsInt() @Min(40) @Max(300) sys?: number; @IsOptional() @IsInt() @Min(20) @Max(200) dia?: number;
}
class InterventionDto { @IsIn(INTERVENTIONS) type: string; @IsOptional() @IsString() @MaxLength(200) site?: string; @IsOptional() @IsString() @MaxLength(500) details?: string }
class ProcedureDto {
  @IsOptional() @IsBoolean() consent_confirmed?: boolean;
  @IsOptional() @IsNumber() @Min(0) @Max(72) fasting_hours?: number | null;
  @IsOptional() @IsIn(['none', 'stopped', 'continued']) anticoagulants?: 'none' | 'stopped' | 'continued' | null;
  @IsOptional() @IsString() @MaxLength(300) anticoag_note?: string | null;
  @IsOptional() @IsBoolean() allergies_reviewed?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(5) asa_class?: number | null;
  @IsOptional() @IsIn(['excellent', 'good', 'fair', 'poor', 'na']) bowel_prep?: 'excellent' | 'good' | 'fair' | 'poor' | 'na' | null;
  @IsOptional() @IsString() @MaxLength(1000) checklist_note?: string | null;
  @IsOptional() @IsIn(['none', 'topical', 'moderate', 'deep', 'general']) sedation_type?: 'none' | 'topical' | 'moderate' | 'deep' | 'general' | null;
  @IsOptional() @IsString() @MaxLength(150) sedation_by?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => DrugDto) sedation_drugs?: DrugDto[];
  @IsOptional() @IsArray() @ArrayMaxSize(60) @ValidateNested({ each: true }) @Type(() => VitalDto) monitoring?: VitalDto[];
  @IsOptional() @IsUUID() scope_id?: string | null;
  @IsOptional() @IsISO8601() started_at?: string | null;
  @IsOptional() @IsISO8601() ended_at?: string | null;
  @IsOptional() @IsString() @MaxLength(200) extent_reached?: string | null;
  @IsOptional() @IsNumber() @Min(0) @Max(120) withdrawal_minutes?: number | null;
  @IsOptional() @IsInt() @Min(0) @Max(9) bbps_score?: number | null;
  @IsOptional() @IsArray() @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => InterventionDto) interventions?: InterventionDto[];
  @IsOptional() @IsIn(['none', 'minor', 'major']) complications?: 'none' | 'minor' | 'major';
  @IsOptional() @IsString() @MaxLength(1000) complication_note?: string | null;
  @IsOptional() @IsInt() @Min(0) @Max(10) recovery_score?: number | null;
  @IsOptional() @IsISO8601() discharged_at?: string | null;
}
class CompleteDto extends ProcedureDto { @IsOptional() @IsBoolean() identity_confirmed?: boolean; @IsOptional() @IsBoolean() unpaid_ack?: boolean }
class ImageMetaDto { @IsOptional() @IsIn(['upload', 'capture']) source?: 'upload' | 'capture'; @IsOptional() @IsString() @MaxLength(200) caption?: string }
class ImageUpdateDto {
  @IsOptional() @IsString() @MaxLength(200) caption?: string | null; @IsOptional() @IsBoolean() in_report?: boolean;
  @IsOptional() @IsInt() sort_order?: number; @IsOptional() @IsString() @Length(5, 300) deactivate_reason?: string;
}
class SpecimenDto {
  @IsInt() @Min(1) @Max(30) jar_no: number; @IsString() @Length(2, 200) site: string; @IsOptional() @IsInt() @Min(1) @Max(50) pieces?: number;
  @IsOptional() @IsString() @MaxLength(300) description?: string | null; @IsOptional() @IsString() @MaxLength(60) fixative?: string | null;
}
class PathDto {
  @IsOptional() @IsString() @MaxLength(200) external_lab?: string | null;
  @IsOptional() @IsString() @MaxLength(1000) clinical_info?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => SpecimenDto) specimens?: SpecimenDto[];
}
class SendDto { @IsOptional() @IsString() @MaxLength(200) external_lab?: string }
class ResultDto { @IsOptional() @IsString() @MaxLength(20_000) result_text?: string }
class ReasonDto { @IsString() @Length(5, 500) reason: string }

const STAFF = ['admin', 'endoscopist', 'endoscopy_nurse'] as const;
const IMG_WRITE = [...STAFF, 'radiologist', 'radiographer'] as const;
const IMG_READ = [...IMG_WRITE, 'doctor', 'nurse'] as const;
const stream = (res: Response, f: { stream: NodeJS.ReadableStream; mime: string }) => {
  res.set({ 'Content-Type': f.mime, 'Content-Disposition': 'inline', 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff' });
  return new StreamableFile(f.stream as never);
};
const pdf = (res: Response, buf: Buffer) => { res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline', 'Cache-Control': 'no-store' }); return new StreamableFile(buf); };

@Controller()
export class EndoscopyController {
  constructor(private readonly endo: EndoscopyService, private readonly rad: RadiologyService, private readonly settings: ClinicSettingsService) {}

  // ---- ენდოსკოპები + დეზინფექცია
  @Get('endo/scopes') @Roles(...STAFF, 'med_engineer')
  scopes(@Query('include_inactive') inc?: string) { return this.endo.scopes(inc === 'true'); }
  @Post('endo/scopes') @Roles('admin', 'endoscopy_nurse', 'med_engineer')
  createScope(@Body() dto: ScopeDto, @Req() req: Request) { return this.endo.saveScope(null, dto, auditCtx(req)); }
  @Patch('endo/scopes/:id') @Roles('admin', 'endoscopy_nurse', 'med_engineer')
  updateScope(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ScopeDto, @Req() req: Request) { return this.endo.saveScope(id, dto, auditCtx(req)); }
  @Post('endo/scopes/:id/reprocess') @Roles(...STAFF)
  reprocess(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReprocessDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.endo.reprocess(id, dto, u, auditCtx(req)); }
  @Get('endo/scopes/:id/history') @Roles(...STAFF, 'med_engineer')
  history(@Param('id', ParseUUIDPipe) id: string) { return this.endo.scopeHistory(id); }

  // ---- პროცედურა
  @Get('dx-orders/:id/endo') @Roles(...STAFF)
  procedure(@Param('id', ParseUUIDPipe) id: string) { return this.endo.procedure(id); }
  @Put('dx-orders/:id/endo') @Roles(...STAFF)
  saveProcedure(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ProcedureDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.endo.saveProcedure(id, dto, u, auditCtx(req)); }
  @Post('dx-orders/:id/endo/complete') @HttpCode(200) @Roles(...STAFF)
  complete(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CompleteDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.endo.complete(id, dto, u, auditCtx(req)); }

  // ---- სურათები (რადიოლოგია / ენდოსკოპია)
  @Post('dx-orders/:id/images') @Roles(...IMG_WRITE)
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_IMG, files: 1 } }))
  addImage(@Param('id', ParseUUIDPipe) id: string, @UploadedFile() file: Express.Multer.File | undefined, @Body() dto: ImageMetaDto, @CurrentUser() u: AuthUser, @Req() req: Request) {
    if (!file) throw new BadRequestException('ფაილი არ არის (ველი: file)');
    return this.endo.addImage(id, file.buffer, dto.source ?? 'upload', dto.caption, u, auditCtx(req));
  }
  @Patch('dx-images/:id') @Roles(...IMG_WRITE)
  updateImage(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ImageUpdateDto, @Req() req: Request) { return this.endo.updateImage(id, dto, auditCtx(req)); }
  @Get('dx-images/:id/file') @Roles(...IMG_READ)
  async image(@Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response) { return stream(res, await this.endo.imageStream(id)); }

  // ---- პათოლოგია
  @Get('pathology') @Roles(...STAFF, 'receptionist')
  pathList(@Query('tab') tab = 'sent', @Query('overdue_days') od?: string, @Query('unreviewed') unrev?: string, @Query('search') search?: string) {
    const t = (['draft', 'sent', 'resulted'] as const).find((x) => x === tab) ?? 'sent';
    return this.endo.pathList({ tab: t, overdueDays: od ? Number(od) || undefined : undefined, unreviewed: unrev === 'true', search });
  }
  @Get('pathology/:id') @Roles(...STAFF, 'receptionist', 'doctor')
  pathGet(@Param('id', ParseUUIDPipe) id: string) { return this.endo.pathRequest(id); }
  @Put('dx-orders/:id/pathology') @Roles(...STAFF)
  pathSave(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PathDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.endo.savePathology(id, dto, u, auditCtx(req)); }
  @Post('pathology/:id/send') @HttpCode(200) @Roles(...STAFF)
  pathSend(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SendDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.endo.sendPathology(id, dto, u, auditCtx(req)); }
  @Post('pathology/:id/cancel') @HttpCode(200) @Roles(...STAFF)
  pathCancel(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto, @Req() req: Request) { return this.endo.cancelPathology(id, dto.reason, auditCtx(req)); }
  @Post('pathology/:id/result') @HttpCode(200) @Roles(...STAFF, 'receptionist')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_SCAN, files: 1 } }))
  pathResult(@Param('id', ParseUUIDPipe) id: string, @UploadedFile() file: Express.Multer.File | undefined, @Body() dto: ResultDto, @CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.endo.resultPathology(id, { result_text: dto.result_text, file: file?.buffer }, u, auditCtx(req));
  }
  @Post('pathology/:id/review') @HttpCode(200) @Roles('admin', 'endoscopist')
  pathReview(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.endo.reviewPathology(id, u, auditCtx(req)); }
  @Get('pathology/:id/file') @Roles(...STAFF, 'receptionist', 'doctor')
  async pathFile(@Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response) { return stream(res, await this.endo.pathResultFile(id)); }

  @Get('pathology/:id/labels') @Roles(...STAFF)
  async labels(@Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response) {
    const r = await this.endo.pathRequest(id);
    if (!r.specimens.length) throw new BadRequestException('ქილები არ არის');
    const date = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tbilisi' }).format(new Date(r.performed_at ?? r.created_at));
    return pdf(res, await renderJarLabels(r.specimens.map((s) => ({ request_no: r.request_no, jar_no: s.jar_no, site: s.site, patient: `${r.last_name} ${r.first_name}`, birth_date: r.birth_date, date }))));
  }
  @Get('pathology/:id/requisition') @Roles(...STAFF)
  async requisition(@Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response) {
    const r = await this.endo.pathRequest(id);
    const d = await this.rad.reportDetail(r.order_item_id);
    return pdf(res, await renderRequisition({
      clinic: await this.settings.get(), patient: { name: `${r.first_name} ${r.last_name}`, birth_date: r.birth_date, gender: r.gender, id_number: r.personal_number },
      request_no: r.request_no, external_lab: r.external_lab, clinical_info: r.clinical_info ?? d.clinical_note, procedure: r.service_name,
      performed_at: r.performed_at ? String(r.performed_at) : null, endoscopist: d.report?.author_name ?? null, impression: d.report?.impression ?? null,
      specimens: r.specimens.map((s) => ({ jar_no: s.jar_no, site: s.site, pieces: s.pieces, description: s.description, fixative: s.fixative })),
    }));
  }
}
