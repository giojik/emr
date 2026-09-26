import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import type { Request } from 'express';
import { auditCtx } from '../audit/audit-context';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/roles';
import { LabIngestService } from '../lab-gateway/lab-ingest.service';
import { LabInstrumentsService } from './lab-instruments.service';

class InstrumentDto {
  @IsIn(['astm', 'hl7']) protocol: 'astm' | 'hl7';
  @IsIn(['client', 'server']) conn_mode: 'client' | 'server';
  @IsOptional() @IsString() @MaxLength(255) host?: string | null;
  @IsInt() @Min(1) @Max(65535) port: number;
  @IsBoolean() is_enabled: boolean;
  @IsIn(['none', 'query', 'push']) order_mode: 'none' | 'query' | 'push';
  @IsOptional() @IsObject() settings?: Record<string, unknown>;
}
class CodeDto {
  @IsString() @Length(1, 40) code: string;
  @IsOptional() @IsUUID() analyte_id?: string | null;
  @IsOptional() @IsUUID() service_id?: string | null;
  @IsOptional() @IsNumber() factor?: number;
  @IsOptional() @IsBoolean() send_order?: boolean;
}
class CodesDto { @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => CodeDto) codes: CodeDto[] }
class DismissDto { @IsString() @Length(3, 500) reason: string }

const LAB_ALL = ['admin', 'lab_doctor', 'lab_manager', 'diagnostic'] as const;

@Controller('lab')
export class LabInstrumentsController {
  constructor(private readonly svc: LabInstrumentsService, private readonly ingest: LabIngestService) {}

  @Get('gateway') @Roles(...LAB_ALL)
  gateway() { return this.svc.gateway(); }

  @Get('instruments') @Roles(...LAB_ALL)
  list() { return this.svc.list(); }
  @Get('instruments/:methodId') @Roles(...LAB_ALL)
  detail(@Param('methodId', ParseUUIDPipe) id: string) { return this.svc.detail(id); }
  @Put('instruments/:methodId') @Roles('admin', 'lab_doctor', 'lab_manager')
  save(@Param('methodId', ParseUUIDPipe) id: string, @Body() dto: InstrumentDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.svc.save(id, dto, u, auditCtx(req)); }
  @Put('instruments/:methodId/codes') @Roles('admin', 'lab_doctor', 'lab_manager')
  codes(@Param('methodId', ParseUUIDPipe) id: string, @Body() dto: CodesDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.svc.setCodes(id, dto.codes, u, auditCtx(req)); }
  @Get('instruments/:methodId/messages') @Roles(...LAB_ALL)
  messages(@Param('methodId', ParseUUIDPipe) id: string, @Query('limit') limit?: string) { return this.svc.messages(id, Number(limit) || 100); }

  @Get('instrument-results') @Roles(...LAB_ALL)
  results(@Query('status') status?: string, @Query('method_id') methodId?: string) { return this.svc.results({ status, method_id: methodId }); }
  @Get('instrument-results/count') @Roles(...LAB_ALL)
  count() { return this.svc.unmatchedCount(); }
  @Post('instrument-results/:id/retry') @HttpCode(200) @Roles(...LAB_ALL)
  retry(@Param('id') id: string, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.ingest.retry(String(Number(id) || 0), u, auditCtx(req)); }
  @Post('instrument-results/:id/dismiss') @HttpCode(200) @Roles(...LAB_ALL)
  dismiss(@Param('id') id: string, @Body() dto: DismissDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.ingest.dismiss(String(Number(id) || 0), dto.reason, u, auditCtx(req)); }
}
