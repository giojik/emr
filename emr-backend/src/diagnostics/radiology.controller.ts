import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, Res, StreamableFile } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsISO8601, IsNumber, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import type { Request, Response } from 'express';
import { auditCtx } from '../audit/audit-context';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/roles';
import { ClinicSettingsService } from '../settings/clinic-settings';
import { DiagnosticsService } from './diagnostics.service';
import { renderAppointmentSlip, renderImagingReport } from './radiology.pdf';
import { RadiologyService, type ImagingSection } from './radiology.service';
import { EndoscopyService } from './endoscopy.service';

const SEDATION_KA: Record<string, string> = { none: 'არ ჩატარებულა', topical: 'ადგილობრივი (სპრეი)', moderate: 'ზომიერი', deep: 'ღრმა', general: 'ზოგადი ანესთეზია' };
const PREP_KA: Record<string, string> = { excellent: 'შესანიშნავი', good: 'კარგი', fair: 'დამაკმაყოფილებელი', poor: 'ცუდი' };
export const INTERVENTION_KA: Record<string, string> = { biopsy: 'ბიოფსია', polypectomy: 'პოლიპექტომია', emr: 'ლორწოვანის რეზექცია (EMR)', hemostasis: 'ჰემოსტაზი', clip: 'კლიპირება',
  banding: 'ლიგირება', injection: 'ინექცია', dilation: 'დილატაცია', foreign_body: 'უცხო სხეულის ამოღება', stent: 'სტენტირება', apc: 'არგონ-პლაზმური კოაგულაცია', other: 'სხვა' };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const MODALITIES = ['CT', 'MR', 'US', 'DX', 'RF', 'MG', 'DXA', 'ES'];

class DeviceDto {
  @IsOptional() @IsIn(['radiology', 'endoscopy']) section?: ImagingSection;
  @IsOptional() @IsString() @Length(1, 100) name?: string;
  @IsOptional() @IsArray() @ArrayMinSize(1) @IsIn(MODALITIES, { each: true }) modalities?: string[];
  @IsOptional() @IsString() @MaxLength(50) room?: string | null;
  @IsOptional() @IsString() @Matches(/^[A-Za-z0-9_ -]{0,16}$/, { message: 'AE Title: ლათინური, მაქს. 16 სიმბოლო' }) ae_title?: string | null;
  @IsOptional() @IsInt() @Min(5) @Max(240) slot_minutes?: number;
  @IsOptional() @Matches(TIME) work_start?: string;
  @IsOptional() @Matches(TIME) work_end?: string;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsInt() sort_order?: number;
}
class ScheduleDto { @IsUUID() device_id: string; @IsISO8601() start: string; @IsOptional() @IsBoolean() outside_hours?: boolean }
class AckDto { @IsOptional() @IsBoolean() unpaid_ack?: boolean }
class SafetyDto {
  @IsOptional() @IsBoolean() mr_screening?: boolean;
  @IsOptional() @IsIn(['not_pregnant', 'pregnant_approved']) pregnancy?: 'not_pregnant' | 'pregnant_approved';
  @IsOptional() @IsIn(['ok', 'not_checked_approved']) renal?: 'ok' | 'not_checked_approved';
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}
class PerformDto {
  @IsOptional() @IsString() @MaxLength(200) contrast_agent?: string | null;
  @IsOptional() @IsNumber() @Min(0.1) @Max(1000) contrast_volume_ml?: number | null;
  @IsOptional() @IsString() @MaxLength(300) dose_text?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) tech_note?: string | null;
  @IsOptional() @ValidateNested() @Type(() => SafetyDto) safety?: SafetyDto;
  @IsOptional() @IsBoolean() identity_confirmed?: boolean;
  @IsOptional() @IsBoolean() unpaid_ack?: boolean;
}
class ReasonDto { @IsString() @Length(5, 1000) reason: string }
class ReportDto {
  @IsOptional() @IsString() @MaxLength(20_000) technique?: string | null;
  @IsOptional() @IsString() @MaxLength(50_000) findings?: string | null;
  @IsOptional() @IsString() @MaxLength(20_000) impression?: string | null;
  @IsOptional() @IsString() @MaxLength(10_000) recommendation?: string | null;
  @IsOptional() @IsBoolean() is_critical?: boolean;
  @IsOptional() @IsString() @MaxLength(500) critical_notified_to?: string | null;
  @IsOptional() @IsUUID() template_id?: string | null;
}
class TemplateDto {
  @IsIn(['radiology', 'endoscopy']) section: ImagingSection;
  @IsIn(['template', 'phrase']) kind: 'template' | 'phrase';
  @IsString() @Length(2, 200) name: string;
  @IsOptional() @IsIn([...MODALITIES, null]) modality?: string | null;
  @IsOptional() @IsUUID() service_id?: string | null;
  @IsOptional() @IsBoolean() shared?: boolean;
  @IsOptional() @IsString() @MaxLength(20_000) technique?: string | null;
  @IsOptional() @IsString() @MaxLength(50_000) findings?: string | null;
  @IsOptional() @IsString() @MaxLength(20_000) impression?: string | null;
  @IsOptional() @IsString() @MaxLength(10_000) recommendation?: string | null;
  @IsOptional() @IsIn(['technique', 'findings', 'impression', 'recommendation', null]) target?: 'technique' | 'findings' | 'impression' | 'recommendation' | null;
  @IsOptional() @IsString() @MaxLength(5000) body?: string | null;
  @IsOptional() @IsInt() sort_order?: number;
  @IsOptional() @IsBoolean() is_active?: boolean;
}

const SCHED = ['admin', 'receptionist', 'radiographer', 'radiologist', 'endoscopist', 'endoscopy_nurse', 'manager'] as const;
const REPORTERS = ['admin', 'radiologist', 'endoscopist'] as const;
const IMAGING_READ = ['admin', 'radiologist', 'radiographer', 'endoscopist', 'endoscopy_nurse'] as const;
const pdf = (res: Response, buf: Buffer) => { res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline', 'Cache-Control': 'no-store' }); return new StreamableFile(buf); };
const section = (s: string): ImagingSection => { if (s !== 'radiology' && s !== 'endoscopy') throw new BadRequestException('section: radiology | endoscopy'); return s; };
const date = (s?: string) => { if (!s || !DATE.test(s)) throw new BadRequestException('date: YYYY-MM-DD'); return s; };

@Controller()
export class RadiologyController {
  constructor(private readonly rad: RadiologyService, private readonly dx: DiagnosticsService, private readonly settings: ClinicSettingsService, private readonly endo: EndoscopyService) {}

  // ---- აპარატები
  @Get('dx/devices') @Roles(...SCHED, 'diagnostic', 'doctor', 'med_engineer', 'viewer')
  devices(@Query('section') s?: string, @Query('include_inactive') inc?: string) { return this.rad.devices({ section: s, includeInactive: inc === 'true' }); }
  @Post('dx/devices') @Roles('admin', 'med_engineer')
  createDevice(@Body() dto: DeviceDto, @Req() req: Request) { return this.rad.saveDevice(null, dto, auditCtx(req)); }
  @Patch('dx/devices/:id') @Roles('admin', 'med_engineer')
  updateDevice(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DeviceDto, @Req() req: Request) { return this.rad.saveDevice(id, dto, auditCtx(req)); }

  // ---- განრიგი
  @Get('radiology/board') @Roles(...SCHED, 'viewer')
  board(@Query('date') d?: string, @Query('section') s = 'radiology') { return this.rad.board(date(d), section(s)); }
  @Put('dx-orders/:id/schedule') @Roles(...SCHED)
  schedule(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ScheduleDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.rad.schedule(id, dto, u, auditCtx(req)); }
  @Delete('dx-orders/:id/schedule') @Roles(...SCHED)
  unschedule(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request) { return this.rad.unschedule(id, auditCtx(req)); }

  /** ჩაწერის ფურცელი: ვიზიტის ყველა ჩაწერილი რადიოლოგიური კვლევა */
  @Get('encounters/:id/imaging-slip') @Roles(...SCHED, 'doctor')
  async slip(@Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response) {
    const items = (await this.dx.encounterItems(id)).filter((i) => (i.section === 'radiology' || i.section === 'endoscopy') && i.status === 'scheduled' && i.scheduled_start);
    if (!items.length) throw new BadRequestException('ჩაწერილი კვლევა არ არის');
    const devices = await this.rad.devices({ includeInactive: true });
    const p = items[0];
    return pdf(res, await renderAppointmentSlip({
      clinic: await this.settings.get(), patient: { name: `${p.first_name} ${p.last_name}`, birth_date: p.birth_date, gender: p.gender, id_number: p.personal_number },
      items: items.map((i) => ({ name: i.service_name, device: i.device_name ?? '', room: devices.find((x) => x.id === i.device_id)?.room ?? null,
        start: String(i.scheduled_start), accession: i.accession_number, prep: i.prep_instructions })),
    }));
  }

  // ---- ტექნიკოსი
  @Get('radiology/queue') @Roles(...SCHED, 'viewer')
  queue(@Query('date') d?: string, @Query('device_id') dev?: string, @Query('section') s = 'radiology') { return this.rad.techQueue(date(d), dev && /^[0-9a-f-]{36}$/i.test(dev) ? dev : undefined, section(s)); }
  @Post('dx-orders/:id/arrive') @HttpCode(200) @Roles('admin', 'receptionist', 'radiographer', 'endoscopy_nurse', 'endoscopist')
  arrive(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AckDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.rad.arrive(id, dto, u, auditCtx(req)); }
  @Post('dx-orders/:id/perform') @HttpCode(200) @Roles('admin', 'radiographer')
  perform(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PerformDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.rad.perform(id, dto, u, auditCtx(req)); }
  @Post('dx-orders/:id/exam-issue') @HttpCode(200) @Roles('admin', 'radiographer', 'receptionist', 'endoscopy_nurse', 'endoscopist')
  issue(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto, @Req() req: Request) { return this.rad.issue(id, dto.reason, auditCtx(req)); }

  // ---- დასკვნა
  @Get('dx/report-worklist') @Roles(...IMAGING_READ)
  worklist(@Query('section') s: string, @Query('tab') tab = 'todo', @Query('date') d?: string, @Query('search') search?: string) {
    return this.rad.reportWorklist(section(s), tab === 'done' ? 'done' : 'todo', { date: d && DATE.test(d) ? d : undefined, search });
  }
  @Get('dx-orders/:id/report') @Roles(...IMAGING_READ)
  report(@Param('id', ParseUUIDPipe) id: string) { return this.rad.reportDetail(id); }
  @Put('dx-orders/:id/report') @Roles(...REPORTERS)
  draft(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReportDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.rad.saveDraft(id, dto, u, auditCtx(req)); }
  @Post('dx-orders/:id/report/sign') @HttpCode(200) @Roles(...REPORTERS)
  sign(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReportDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.rad.sign(id, dto, u, auditCtx(req)); }
  @Post('dx-orders/:id/report/reopen') @HttpCode(200) @Roles(...REPORTERS)
  reopen(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.rad.reopen(id, dto.reason, u, auditCtx(req)); }

  /** ხელმოწერილი დასკვნის ბლანკი (?version= — არქივიდან) */
  @Get('dx-orders/:id/report.pdf') @Roles(...IMAGING_READ, 'doctor', 'nurse', 'receptionist')
  async reportPdf(@Param('id', ParseUUIDPipe) id: string, @Query('version') version: string | undefined, @Res({ passthrough: true }) res: Response) {
    const { item: it, version: v, latest, referrer } = await this.rad.printData(id, version ? Number(version) : undefined);
    const e = it.endo;
    const endo = it.section === 'endoscopy' && e ? {
      rows: [
        ['სედაცია', [SEDATION_KA[e.sedation_type ?? ''] ?? null, (e.sedation_drugs as { drug: string; dose: number; unit: string }[]).map((x) => `${x.drug} ${x.dose} ${x.unit}`).join(', ') || null, e.sedation_by].filter(Boolean).join(' · ') || null],
        ['ASA', e.asa_class ? String(e.asa_class) : null],
        ['ენდოსკოპი', e.scope_name ? `${e.scope_name} (S/N ${e.scope_serial})` : null],
        ['მომზადება', e.bowel_prep && e.bowel_prep !== 'na' ? `${PREP_KA[e.bowel_prep]}${e.bbps_score != null ? `, BBPS ${e.bbps_score}/9` : ''}` : e.bbps_score != null ? `BBPS ${e.bbps_score}/9` : null],
        ['მიღწეული უბანი', [e.extent_reached, e.withdrawal_minutes ? `გამოყვანის დრო ${Number(e.withdrawal_minutes)} წთ` : null].filter(Boolean).join(' · ') || null],
      ] as [string, string | null][],
      interventions: (e.interventions as { type: string; site?: string; details?: string }[]).map((x) => [INTERVENTION_KA[x.type] ?? x.type, x.site, x.details].filter(Boolean).join(' — ')),
      complications: e.complications === 'none' ? null : `${e.complications === 'major' ? 'მძიმე' : 'მსუბუქი'}: ${e.complication_note ?? ''}`,
    } : undefined;
    const images = it.images.some((g) => g.in_report) ? await this.endo.imageBuffers(id) : [];
    return pdf(res, await renderImagingReport({
      endo, images, specimens: it.pathology?.status !== 'cancelled' ? it.pathology?.specimens : undefined,
      pathology: it.pathology && it.pathology.status !== 'cancelled' ? { request_no: it.pathology.request_no, status: it.pathology.status, external_lab: it.pathology.external_lab, result_text: it.pathology.result_text } : null,
      clinic: await this.settings.get(), section: it.section as ImagingSection,
      patient: { name: `${it.first_name} ${it.last_name}`, birth_date: it.birth_date, gender: it.gender, id_number: it.personal_number },
      study: {
        name: it.service_name, accession: it.accession_number, performed_at: it.performed_at ? String(it.performed_at) : null, device: it.device_name,
        contrast: it.contrast_agent ? `${it.contrast_agent}${it.contrast_volume_ml ? `, ${Number(it.contrast_volume_ml)} მლ` : ''}` : null, dose: it.dose_text,
        referrer: referrer.visit_kind === 'consultation' ? referrer.name : null, external_referral: referrer.external_referral, clinical_note: it.clinical_note,
      },
      report: { version: v.version, technique: v.technique, findings: v.findings, impression: v.impression, recommendation: v.recommendation, is_critical: v.is_critical,
        critical_notified_to: v.critical_notified_to, amend_reason: v.amend_reason, signed_by_name: v.signed_by_name, signed_at: String(v.signed_at), superseded: !latest },
    }));
  }

  // ---- შაბლონები
  @Get('dx/report-templates') @Roles(...REPORTERS)
  templates(@Query('section') s: string, @Query('modality') modality: string | undefined, @Query('service_id') serviceId: string | undefined,
            @Query('manage') manage: string | undefined, @CurrentUser() u: AuthUser) {
    return this.rad.templates(u, { section: section(s), modality: modality || undefined, service_id: serviceId && /^[0-9a-f-]{36}$/i.test(serviceId) ? serviceId : undefined, manage: manage === 'true' });
  }
  @Post('dx/report-templates') @Roles(...REPORTERS)
  createTemplate(@Body() dto: TemplateDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.rad.saveTemplate(null, dto, u, auditCtx(req)); }
  @Patch('dx/report-templates/:id') @Roles(...REPORTERS)
  updateTemplate(@Param('id', ParseUUIDPipe) id: string, @Body() dto: TemplateDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.rad.saveTemplate(id, dto, u, auditCtx(req)); }
}
