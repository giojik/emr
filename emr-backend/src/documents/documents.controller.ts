import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Post, Query, Req, Res, StreamableFile } from '@nestjs/common';
import type { Request, Response } from 'express';
import { auditCtx } from '../audit/audit-context';
import { CurrentUser, Public, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/roles';
import { IssueForm100Dto, RevokeDocumentDto } from './documents.dto';
import { DocumentsService } from './documents.service';

@Controller()
export class DocumentsController {
  constructor(private readonly docs: DocumentsService) {}

  @Get('encounters/:id/form100/draft') @Roles('admin', 'doctor')
  draft(@Param('id', ParseUUIDPipe) id: string) { return this.docs.draft(id); }

  @Post('encounters/:id/form100') @Roles('admin', 'doctor')
  issue(@Param('id', ParseUUIDPipe) id: string, @Body() dto: IssueForm100Dto, @CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.docs.issueForm100(id, dto, u, auditCtx(req));
  }

  @Get('documents') @Roles('admin', 'doctor', 'receptionist')
  list(@Query('type') type?: string, @Query('encounter_id') encounterId?: string, @Query('patient_id') patientId?: string,
       @Query('from') from?: string, @Query('to') to?: string) {
    return this.docs.list({ type, encounterId, patientId, from, to });
  }

  @Get('documents/:id') @Roles('admin', 'doctor', 'receptionist')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    const { payload: _p, ...meta } = await this.docs.get(id);
    return meta;
  }

  @Get('documents/:id/pdf') @Roles('admin', 'doctor', 'receptionist')
  async pdf(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const f = await this.docs.pdf(id, auditCtx(req));
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${f.filename}"`, 'Cache-Control': 'no-store' });
    return new StreamableFile(f.stream);
  }

  @Post('documents/:id/revoke') @Roles('admin', 'doctor')
  revoke(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RevokeDocumentDto, @CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.docs.revoke(id, dto.reason, u, auditCtx(req));
  }
}

/** QR-კოდის სამიზნე — საჯარო, ავტორიზაციის გარეშე. ბრაუზერს HTML-ს უბრუნებს, პროგრამას — JSON-ს. */
@Public()
@Controller('public/verify')
export class PublicVerifyController {
  constructor(private readonly docs: DocumentsService) {}

  @Get(':token') @Header('Cache-Control', 'no-store') @Header('X-Robots-Tag', 'noindex')
  async verify(@Param('token') token: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const r = /^[0-9a-f-]{36}$/i.test(token) ? await this.docs.verify(token) : { valid: false as const, reason: 'not_found' };
    if (!(req.headers.accept ?? '').includes('text/html')) return r;
    res.type('html');
    const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    const ok = r.valid;
    const body = 'document_number' in r
      ? `<p><b>${esc(r.document_type)}</b></p><table>
          <tr><td>ნომერი</td><td>${esc(r.document_number)}</td></tr>
          <tr><td>გაცემის თარიღი</td><td>${esc(r.issued_at ? new Date(r.issued_at).toLocaleDateString('ka-GE') : '')}</td></tr>
          <tr><td>დაწესებულება</td><td>${esc(r.institution)}</td></tr>
          <tr><td>პაციენტი</td><td>${esc(r.patient_initials)}</td></tr>
          ${r.revoked_at ? `<tr><td>გაუქმდა</td><td>${esc(new Date(r.revoked_at).toLocaleDateString('ka-GE'))}</td></tr>` : ''}
        </table>`
      : '<p>ამ კოდით დოკუმენტი არ მოიძებნა.</p>';
    return `<!doctype html><html lang="ka"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>დოკუმენტის ვერიფიკაცია</title><style>body{font-family:system-ui,sans-serif;max-width:560px;margin:40px auto;padding:0 16px;color:#222}
      .s{padding:14px 18px;border-radius:8px;font-weight:600;font-size:18px;margin-bottom:18px}
      .ok{background:#e7f6ec;color:#17693a;border:1px solid #9fd8b3}.bad{background:#fdecec;color:#9b1c1c;border:1px solid #f3b1b1}
      table{border-collapse:collapse;width:100%}td{padding:6px 4px;border-bottom:1px solid #eee}td:first-child{color:#666;width:40%}</style></head>
      <body><div class="s ${ok ? 'ok' : 'bad'}">${ok ? '✔ დოკუმენტი ნამდვილია და მოქმედია' : ('status' in r && r.status === 'revoked' ? '✘ დოკუმენტი გაუქმებულია' : '✘ დოკუმენტი ვერ დადასტურდა')}</div>
      ${body}<p style="color:#888;font-size:12px;margin-top:24px">შეადარეთ ნაბეჭდ დოკუმენტს: ნომერი, თარიღი და დაწესებულება უნდა ემთხვეოდეს.</p></body></html>`;
  }
}
