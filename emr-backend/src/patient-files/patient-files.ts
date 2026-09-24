import { BadRequestException, Body, Controller, Get, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Req, Res,
  StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { IsIn, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import type { Request, Response } from 'express';
import type { Transaction } from 'kysely';
import { memoryStorage } from 'multer';
import { createHash, randomUUID } from 'node:crypto';
import { auditCtx } from '../audit/audit-context';
import { AuditService, type AuditContext } from '../audit/audit.service';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/roles';
import { InjectDb, type Database } from '../database/database.module';
import type { DB } from '../database/db';
import { StorageService } from '../storage/storage.service';

export const DOC_TYPES = ['id_card', 'passport', 'birth_certificate', 'residence_permit', 'consent_scan', 'consent_signed', 'other'] as const;
export type DocType = (typeof DOC_TYPES)[number];
const MAX_BYTES = 10 * 1024 * 1024;

/** ფაილის რეალური ტიპი "მაგიური ბაიტებით" — გაფართოებას და ბრაუზერის Content-Type-ს არ ვენდობით */
export function sniffMime(b: Buffer): 'image/jpeg' | 'image/png' | 'application/pdf' | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length > 4 && b.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}

export class UploadDto {
  @IsIn(DOC_TYPES.filter((t) => t !== 'consent_signed')) doc_type: DocType;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}
export class DeactivateFileDto { @IsString() @Length(5, 500) reason: string }

@Injectable()
export class PatientFilesService {
  constructor(@InjectDb() private readonly db: Database, private readonly storage: StorageService, private readonly audit: AuditService) {}

  /** შენახვა (სხვა მოდულებიდანაც — მაგ. ელექტრონულად ხელმოწერილი თანხმობის PDF) */
  async store(p: { patientId: string; docType: DocType; data: Buffer; originalName?: string; note?: string; userId: string }, ctx: AuditContext, trx: Transaction<DB> | Database = this.db) {
    const mime = sniffMime(p.data);
    if (!mime) throw new BadRequestException('დაშვებულია მხოლოდ JPG, PNG ან PDF');
    const exists = await trx.selectFrom('patients').select('id').where('id', '=', p.patientId).executeTakeFirst();
    if (!exists) throw new NotFoundException('პაციენტი ვერ მოიძებნა');
    const id = randomUUID();
    const ext = mime === 'application/pdf' ? 'pdf' : mime === 'image/png' ? 'png' : 'jpg';
    const key = `patients/${p.patientId}/${p.docType}/${id}.${ext}`;
    await this.storage.put(key, p.data, mime);
    const f = await trx.insertInto('patient_files').values({
      id, patient_id: p.patientId, doc_type: p.docType, file_path: key, mime_type: mime, size_bytes: p.data.length,
      sha256: createHash('sha256').update(p.data).digest('hex'), original_name: p.originalName?.slice(0, 200) ?? null,
      note: p.note ?? null, uploaded_by: p.userId,
    }).returning(['id', 'doc_type', 'mime_type', 'size_bytes', 'created_at']).executeTakeFirstOrThrow();
    await this.audit.log(ctx, { action: 'UPLOAD_PATIENT_FILE', entityName: 'patient_files', entityId: id, newData: { patient_id: p.patientId, doc_type: p.docType, size: p.data.length } }, trx);
    return f;
  }

  list(patientId: string, includeInactive: boolean) {
    let q = this.db.selectFrom('patient_files as f').leftJoin('users as u', 'u.id', 'f.uploaded_by')
      .select(['f.id', 'f.doc_type', 'f.mime_type', 'f.size_bytes', 'f.original_name', 'f.note', 'f.is_active', 'f.deactivated_reason', 'f.created_at',
        'u.first_name as uploaded_by_first', 'u.last_name as uploaded_by_last'])
      .where('f.patient_id', '=', patientId).orderBy('f.created_at', 'desc');
    if (!includeInactive) q = q.where('f.is_active', '=', true);
    return q.execute();
  }

  async content(fileId: string, ctx: AuditContext) {
    const f = await this.db.selectFrom('patient_files').select(['id', 'file_path', 'mime_type', 'doc_type', 'patient_id']).where('id', '=', fileId).executeTakeFirst();
    if (!f) throw new NotFoundException('ფაილი ვერ მოიძებნა');
    await this.audit.log(ctx, { action: 'VIEW_PATIENT_FILE', entityName: 'patient_files', entityId: fileId, newData: { patient_id: f.patient_id, doc_type: f.doc_type } });
    return { stream: await this.storage.get(f.file_path), mime: f.mime_type };
  }

  async deactivate(fileId: string, reason: string, ctx: AuditContext) {
    const used = await this.db.selectFrom('patient_consents').select('id').where('file_id', '=', fileId).executeTakeFirst();
    if (used) throw new BadRequestException('ფაილი თანხმობის დოკუმენტია — გამოიყენეთ თანხმობის გაუქმება');
    const f = await this.db.updateTable('patient_files').set({ is_active: false, deactivated_reason: reason })
      .where('id', '=', fileId).returning(['id']).executeTakeFirst();
    if (!f) throw new NotFoundException('ფაილი ვერ მოიძებნა');
    await this.audit.log(ctx, { action: 'DEACTIVATE_PATIENT_FILE', entityName: 'patient_files', entityId: fileId, newData: { reason } });
    return { id: fileId, is_active: false };
  }
}

const FRONT = ['admin', 'receptionist'] as const;
const READ = ['admin', 'receptionist', 'doctor', 'nurse', 'billing'] as const;

@Controller()
export class PatientFilesController {
  constructor(private readonly files: PatientFilesService) {}

  @Post('patients/:id/files') @Roles(...FRONT, 'doctor', 'nurse')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1 } }))
  upload(@Param('id', ParseUUIDPipe) id: string, @UploadedFile() file: Express.Multer.File | undefined, @Body() dto: UploadDto,
         @CurrentUser() u: AuthUser, @Req() req: Request) {
    if (!file) throw new BadRequestException('ფაილი არ არის (ველი "file")');
    return this.files.store({ patientId: id, docType: dto.doc_type, data: file.buffer, originalName: file.originalname, note: dto.note, userId: u.id }, auditCtx(req));
  }

  @Get('patients/:id/files') @Roles(...READ)
  list(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request) { return this.files.list(id, req.query.include_inactive === 'true'); }

  @Get('patient-files/:fid/content') @Roles(...READ)
  async content(@Param('fid', ParseUUIDPipe) fid: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const f = await this.files.content(fid, auditCtx(req));
    res.set({ 'Content-Type': f.mime, 'Content-Disposition': 'inline', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    return new StreamableFile(f.stream);
  }

  @Patch('patient-files/:fid') @Roles(...FRONT)
  deactivate(@Param('fid', ParseUUIDPipe) fid: string, @Body() dto: DeactivateFileDto, @Req() req: Request) { return this.files.deactivate(fid, dto.reason, auditCtx(req)); }
}

@Module({ controllers: [PatientFilesController], providers: [PatientFilesService], exports: [PatientFilesService] })
export class PatientFilesModule {}
