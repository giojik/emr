import { Body, Controller, Delete, Get, HttpCode, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, Res, StreamableFile } from '@nestjs/common';
import type { Request, Response } from 'express';
import { auditCtx } from '../audit/audit-context';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser, Role } from '../auth/roles';
import { ConsultDto, NoteCreateDto, NotesModule, NotesService, NoteTemplateDto, NoteUpdateDto, ReasonDto } from '../inpatient/notes';
import { ClinicalHistory, RequireModule } from '../modules/module-guard';
import { ER_READ } from './er';

/**
 * 0088 — ER-ის კლინიკური ნაწილი (I): ჩანაწერი (er_initial / er_progress), კონსულტაცია. ერთი მექანიზმი სტაციონართან (NotesService):
 * შავი ვერსია → ხელმოწერა → შესწორება (ვერსიები), შაბლონები, კონსულტაციის პასუხი (doctor_notes kind = consult).
 *  • /er/visits/:id/... — ER-ის შემთხვევის ჩანაწერები / კონსულტაციის მოთხოვნა (@RequireModule('er'); ნახვა — @ClinicalHistory);
 *  • /clinical/... — ჩანაწერის / კონსულტაციის ოპერაციები ორივე ტიპზე (ჰოსპიტალიზაცია / ER): guard — inpatient ∨ er,
 *    ჩაწერისას სერვისი ამოწმებს კონკრეტული შემთხვევის მოდულს (assertActive), ამიტომ ER-ის ჩანაწერი სტაციონარის გარეშეც იწერება და პირიქით.
 * ჩაწერის წესი ER-ზე — er-access (doctor_write: team / attending).
 */
const NOTE_READ: Role[] = [...ER_READ, 'doctor', 'nurse'];
const NOTE_WRITE: Role[] = ['admin', 'doctor', 'er_doctor'];

@Controller('er')
@RequireModule('er')
export class ErClinicalController {
  constructor(private readonly notes: NotesService) {}
  @Get('visits/:id/notes') @ClinicalHistory() @Roles(...NOTE_READ)
  list(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser) { return this.notes.list(id, u, 'emergency'); }
  @Get('visits/:id/notes/insert') @Roles('admin', 'er_doctor')
  insert(@Param('id', ParseUUIDPipe) id: string) { return this.notes.chart(id, undefined, 'emergency').then(() => this.notes.insertData(id)); }
  @Get('visits/:id/notes/pdf') @ClinicalHistory() @Roles(...NOTE_READ)
  async pdf(@Param('id', ParseUUIDPipe) id: string, @Req() r: Request, @Res({ passthrough: true }) res: Response) {
    const out = await this.notes.pdf(id, auditCtx(r), 'emergency');
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${out.name}"` });
    return new StreamableFile(out.pdf);
  }
  /** ჩანაწერი (er_initial / er_progress) ან კონსულტაციის პასუხი (kind = consult — კონსულტანტი, doctor) */
  @Post('visits/:id/notes') @Roles(...NOTE_WRITE)
  create(@Param('id', ParseUUIDPipe) id: string, @Body() d: NoteCreateDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.notes.create(id, d, u, auditCtx(r), 'emergency'); }
  @Post('visits/:id/consultations') @Roles('admin', 'er_doctor')
  consult(@Param('id', ParseUUIDPipe) id: string, @Body() d: ConsultDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.notes.requestConsult(id, d, u, auditCtx(r), 'emergency'); }
}

@Controller('clinical')
@RequireModule('inpatient', 'er')
export class ClinicalNotesController {
  constructor(private readonly notes: NotesService) {}
  @Get('notes/:id') @ClinicalHistory() @Roles(...NOTE_READ)
  async one(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser) {
    const n = await this.notes.get(id);
    if (!n || (n.status === 'draft' && n.author_id !== u.id)) throw new NotFoundException('ჩანაწერი ვერ მოიძებნა');
    return n;
  }
  @Get('notes/:id/history') @ClinicalHistory() @Roles(...NOTE_READ) history(@Param('id', ParseUUIDPipe) id: string) { return this.notes.history(id); }
  @Put('notes/:id') @Roles(...NOTE_WRITE)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() d: NoteUpdateDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.notes.update(id, d, u, auditCtx(r)); }
  @Delete('notes/:id') @Roles(...NOTE_WRITE) discard(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.notes.discard(id, u, auditCtx(r)); }
  @Post('notes/:id/sign') @HttpCode(200) @Roles(...NOTE_WRITE) sign(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.notes.sign(id, u, auditCtx(r)); }
  @Post('notes/:id/amend') @Roles(...NOTE_WRITE)
  amend(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.notes.amend(id, d.reason, u, auditCtx(r)); }
  /** კონსულტაციის პასუხი ნებისმიერ შემთხვევაზე (ჰოსპიტალიზაცია / ER) — „კონსულტაციები“ გვერდიდან */
  @Post('charts/:eid/notes') @Roles(...NOTE_WRITE)
  answer(@Param('eid', ParseUUIDPipe) eid: string, @Body() d: NoteCreateDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.notes.create(eid, d, u, auditCtx(r)); }

  @Post('consultations/:id/cancel') @HttpCode(200) @Roles(...NOTE_WRITE)
  cancel(@Param('id', ParseUUIDPipe) id: string, @Body() d: ReasonDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.notes.cancelConsult(id, d.reason, u, auditCtx(r)); }
  /** კონსულტანტის სია — ჰოსპიტალიზაციები (inpatient) + ER-ის შემთხვევები (er) */
  @Get('consultations/inbox') @ClinicalHistory() @Roles('admin', 'doctor') inbox(@CurrentUser() u: AuthUser) { return this.notes.inbox(u, 'all'); }

  @Get('note-templates') @Roles('admin', 'doctor', 'er_doctor', 'er_manage') templates(@CurrentUser() u: AuthUser, @Query('kind') kind?: string) { return this.notes.templates(u, kind); }
  @Post('note-templates') @Roles('admin', 'doctor', 'er_doctor', 'er_manage') addT(@Body() d: NoteTemplateDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.notes.saveTemplate(null, d, u, auditCtx(r)); }
  @Patch('note-templates/:id') @Roles('admin', 'doctor', 'er_doctor', 'er_manage')
  editT(@Param('id', ParseUUIDPipe) id: string, @Body() d: NoteTemplateDto, @CurrentUser() u: AuthUser, @Req() r: Request) { return this.notes.saveTemplate(id, d, u, auditCtx(r)); }
}

@Module({ imports: [NotesModule], controllers: [ErClinicalController, ClinicalNotesController] })
export class ErClinicalModule {}
