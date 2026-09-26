import { Body, Controller, Get, Header, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, Res, StreamableFile } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import type { Request, Response } from 'express';
import { auditCtx } from '../audit/audit-context';
import { CurrentUser, Public, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/roles';
import { AGE_MAX_DAYS } from './lab-norms';
import { LabConfigService } from './lab-config.service';

class MethodDto {
  @IsOptional() @IsString() @Length(2, 120) name?: string;
  @IsOptional() @IsIn(['analyzer', 'manual', 'method']) kind?: 'analyzer' | 'manual' | 'method';
  @IsOptional() @IsString() @MaxLength(120) manufacturer?: string | null;
  @IsOptional() @IsString() @MaxLength(60) serial_number?: string | null;
  @IsOptional() @IsString() @MaxLength(500) note?: string | null;
  @IsOptional() @IsBoolean() is_active?: boolean;
}
class NormRangeDto {
  @IsOptional() @IsIn(['male', 'female']) sex: 'male' | 'female' | null;
  @IsInt() @Min(0) @Max(AGE_MAX_DAYS) age_min_days: number;
  @IsInt() @Min(0) @Max(AGE_MAX_DAYS) age_max_days: number;
  @IsOptional() @IsIn(['P', 'T1', 'T2', 'T3']) pregnancy?: 'P' | 'T1' | 'T2' | 'T3' | null;
  @IsOptional() @IsUUID() method_id?: string | null;
  @IsOptional() @IsNumber() low?: number | null;
  @IsOptional() @IsNumber() high?: number | null;
  @IsOptional() @IsString() @MaxLength(200) normal_text?: string | null;
}
class NormsDto {
  @IsArray() @ArrayMaxSize(60) @ValidateNested({ each: true }) @Type(() => NormRangeDto) ranges: NormRangeDto[];
  @IsOptional() @IsNumber() critical_low?: number | null;
  @IsOptional() @IsNumber() critical_high?: number | null;
  @IsString() @Length(5, 1000) reason: string;
}
class ImageDto { @IsString() @MaxLength(1_000_000) data_url: string }
class BlankCreateDto { @IsString() @Length(2, 100) name: string; @IsOptional() @IsUUID() copy_from?: string }
class BlankSaveDto {
  @IsOptional() @IsString() @Length(2, 100) name?: string;
  @IsOptional() @IsObject() settings?: Record<string, unknown>;
  @IsOptional() @IsBoolean() is_active?: boolean;
}
class AssignDto {
  @IsArray() @IsString({ each: true }) @ArrayMaxSize(200) groups: string[];
  @IsArray() @IsUUID('4', { each: true }) @ArrayMaxSize(1000) service_ids: string[];
}
class PreviewDto { @IsObject() settings: Record<string, unknown> }

const LAB_ALL = ['admin', 'lab_doctor', 'lab_manager', 'diagnostic'] as const;
const pdf = (res: Response, buf: Buffer) => { res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline', 'Cache-Control': 'no-store' }); return new StreamableFile(buf); };

@Controller('lab')
export class LabConfigController {
  constructor(private readonly lab: LabConfigService) {}

  @Get('config/permissions') @Roles(...LAB_ALL)
  permissions(@CurrentUser() u: AuthUser) { return this.lab.permissions(u); }

  // ---- ანალიზატორები / მეთოდები
  @Get('methods') @Roles(...LAB_ALL)
  methods(@Query('include_inactive') inc?: string) { return this.lab.methods(inc === 'true'); }
  @Post('methods') @Roles('admin', 'lab_doctor', 'lab_manager')
  createMethod(@Body() dto: MethodDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.lab.saveMethod(null, dto, u, auditCtx(req)); }
  @Patch('methods/:id') @Roles('admin', 'lab_doctor', 'lab_manager')
  updateMethod(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MethodDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.lab.saveMethod(id, dto, u, auditCtx(req)); }

  // ---- ნორმები
  @Get('norms') @Roles(...LAB_ALL)
  norms(@Query('search') search?: string, @Query('group') group?: string) { return this.lab.normsList({ search, group }); }
  @Get('analytes/:id/norm-history') @Roles(...LAB_ALL)
  history(@Param('id', ParseUUIDPipe) id: string) { return this.lab.normHistory(id); }
  @Put('analytes/:id/norms') @Roles('admin', 'lab_doctor')
  changeNorms(@Param('id', ParseUUIDPipe) id: string, @Body() dto: NormsDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.lab.changeNorms(id, dto, u, auditCtx(req)); }

  // ---- ბლანკები
  @Get('blanks') @Roles(...LAB_ALL)
  blanks() { return this.lab.listBlanks(); }
  @Post('blanks') @Roles('admin', 'lab_doctor')
  createBlank(@Body() dto: BlankCreateDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.lab.createBlank(dto, u, auditCtx(req)); }
  @Post('blanks/images') @Roles('admin', 'lab_doctor')
  upload(@Body() dto: ImageDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.lab.uploadImage(dto.data_url, u, auditCtx(req)); }
  @Get('blanks/images/:id') @Roles(...LAB_ALL)
  async image(@Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response) {
    const r = await this.lab.image(id);
    res.set({ 'Content-Type': r.mime, 'Cache-Control': 'private, max-age=86400' });
    return new StreamableFile(r.data);
  }
  @Post('blanks/preview') @HttpCode(200) @Roles(...LAB_ALL)
  async preview(@Body() dto: PreviewDto, @Res({ passthrough: true }) res: Response) { return pdf(res, await this.lab.previewPdf(dto.settings)); }
  @Get('blanks/:id') @Roles(...LAB_ALL)
  blank(@Param('id', ParseUUIDPipe) id: string) { return this.lab.blankDetail(id); }
  @Get('blanks/:id/versions/:v') @Roles(...LAB_ALL)
  version(@Param('id', ParseUUIDPipe) id: string, @Param('v') v: string) { return this.lab.versionSettings(id, Number(v) || 0); }
  @Put('blanks/:id') @Roles('admin', 'lab_doctor')
  saveBlank(@Param('id', ParseUUIDPipe) id: string, @Body() dto: BlankSaveDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.lab.saveBlank(id, dto, u, auditCtx(req)); }
  @Post('blanks/:id/default') @HttpCode(200) @Roles('admin', 'lab_doctor')
  setDefault(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.lab.setDefault(id, u, auditCtx(req)); }
  @Put('blanks/:id/assignments') @Roles('admin', 'lab_doctor')
  assign(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.lab.setAssignments(id, dto, u, auditCtx(req)); }
}

/** QR-ის სამიზნე ლაბორატორიული პასუხისთვის — საჯარო. ბრაუზერს HTML-ს უბრუნებს, პროგრამას — JSON-ს. */
@Public()
@Controller('public/lab-verify')
export class PublicLabVerifyController {
  constructor(private readonly lab: LabConfigService) {}

  @Get(':token') @Header('Cache-Control', 'no-store') @Header('X-Robots-Tag', 'noindex')
  async verify(@Param('token') token: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const r = await this.lab.publicVerify(token);
    if (!(req.headers.accept ?? '').includes('text/html')) return r;
    res.type('html');
    const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    const fmt = (x: unknown) => (x ? new Date(String(x)).toLocaleString('ka-GE', { timeZone: 'Asia/Tbilisi' }) : '');
    const body = r.valid
      ? `<table><tr><td>დაწესებულება</td><td>${esc(r.institution)}</td></tr><tr><td>პაციენტი</td><td>${esc(r.patient_initials)} (${esc(r.birth_year)})</td></tr></table>
         <p style="margin-top:18px"><b>დადასტურებული კვლევები</b></p><table>${r.tests.map((t) => `<tr><td>${esc(t.name)}</td><td>${esc(fmt(t.validated_at))}</td></tr>`).join('')}</table>`
      : '<p>ამ კოდით მოქმედი პასუხი არ მოიძებნა. შესაძლოა შედეგი შესწორდა — მოითხოვეთ ახალი ბლანკი ლაბორატორიაში.</p>';
    return `<!doctype html><html lang="ka"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>ლაბორატორიული პასუხის ვერიფიკაცია</title><style>body{font-family:system-ui,sans-serif;max-width:560px;margin:40px auto;padding:0 16px;color:#222}
      .s{padding:14px 18px;border-radius:8px;font-weight:600;font-size:18px;margin-bottom:18px}
      .ok{background:#e7f6ec;color:#17693a;border:1px solid #9fd8b3}.bad{background:#fdecec;color:#9b1c1c;border:1px solid #f3b1b1}
      table{border-collapse:collapse;width:100%}td{padding:6px 4px;border-bottom:1px solid #eee}td:first-child{color:#666;width:55%}</style></head>
      <body><div class="s ${r.valid ? 'ok' : 'bad'}">${r.valid ? '✔ ლაბორატორიული პასუხი ნამდვილია' : '✘ პასუხი ვერ დადასტურდა'}</div>
      ${body}<p style="color:#888;font-size:12px;margin-top:24px">შეადარეთ ნაბეჭდ ბლანკს: დაწესებულება, კვლევები და თარიღები უნდა ემთხვეოდეს. შედეგების მნიშვნელობები აქ არ ჩანს (პერსონალური მონაცემები).</p></body></html>`;
  }
}
